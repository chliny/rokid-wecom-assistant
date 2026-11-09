#!/usr/bin/env node
// Rokid 企业微信助手 终端二维码生成工具
//
// 交互式：
//   node tools/wecom-mcp-qr.mjs
// 非交互式：
//   node tools/wecom-mcp-qr.mjs --no-interactive \
//     --name 企业微信消息 --url 'https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=KEY'
//
// 二维码内容 = 共享协议模块（app/libs/qr-payload.js）定义的紧凑配置（version 2）：
//   {"type":"rokid-wecom-assistant","version":2,"p":"<key 公共前缀>","s":[["msg","<key 后缀>"],...]}
// 只存能力位 + key 片段，默认名称与完整 URL 由眼镜端还原，二维码更小、更少。
// 内容超出一个二维码容量时自动分片，逐张显示「请依次扫描 第 i/N 张」。
// 终端输出只展示脱敏后的 URL / API Key；二维码图像里才是真实的配置。

import process from 'node:process';
import { readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  ConfigError,
  LIMITS,
  buildPayload,
  redactText,
  serializePayload,
  splitIntoChunks,
  validatePayload,
} from '../app/libs/qr-payload.js';
import { USAGE, parseArgs } from './lib/cli-args.mjs';
import { readServerFiles } from './lib/server-file.mjs';
import {
  CAPABILITIES,
  buildMcpUrl,
  capabilityMenuLines,
  classifyInput,
  displayNameForCapability,
  inspectMcpUrl,
  parseCapabilityChoice,
  resolveServerSpecs,
  validateApiKey,
  withApiKey,
} from './lib/wecom.mjs';
import { CancelError, createPrompter } from './lib/prompter.mjs';
import {
  duplicateNameWarnings,
  formatPreview,
  formatSummary,
  maskedUrl,
  numberedPath,
  serverWarnings,
  staleChunkPaths,
} from './lib/format.mjs';
import {
  acquireExportLocks,
  assertNoExportTargetOverlap,
  releaseExportLocks,
  releaseExportLocksSync,
} from './lib/export-lock.mjs';
import {
  QR_BYTE_CAPACITY,
  assertExportDirectory,
  cleanupOwnTempFilesSync,
  estimateQrCells,
  fitChunksToTerminal,
  renderTerminalQr,
  writePngFile,
  writeSvgFile,
} from './lib/qr.mjs';
import { resolveQrMode } from './lib/terminal.mjs';

/** 当前活动的提示器，供 SIGINT 恢复终端状态。 */
let activePrompter = null;

/** @param {string} [line] */
function write(line = '') {
  process.stdout.write(`${line}\n`);
}

/** @param {string} [line] */
function writeError(line = '') {
  process.stderr.write(`${line}\n`);
}

// ---------------------------------------------------------------- 交互式录入

/**
 * 读取必须的一行；EOF 视为用户取消。
 * @param {ReturnType<typeof createPrompter>} prompter
 * @param {string} prompt
 * @param {'none' | 'secret' | 'url'} [mask] url 模式只遮住 ?apikey= 之后的值
 * @returns {Promise<string>}
 */
async function askLine(prompter, prompt, mask = 'none') {
  const value = await prompter.askLine(prompt, { mask });
  if (value === null) throw new CancelError('输入已结束（EOF），已取消生成');
  return value;
}

/**
 * 读取并校验 API Key（隐藏回显），非法时重试。
 * @param {ReturnType<typeof createPrompter>} prompter
 * @returns {Promise<string>}
 */
async function askApiKey(prompter) {
  for (;;) {
    const value = await prompter.askSecret('API Key（输入不回显）: ');
    if (value === null) throw new CancelError('输入已结束（EOF），已取消生成');
    try {
      return validateApiKey(value);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      write(`✗ ${error.message}，请重新输入。`);
    }
  }
}

/**
 * 打印能力位菜单并读取选择。
 * @param {ReturnType<typeof createPrompter>} prompter
 * @returns {Promise<string>} 能力代号
 */
async function askCapability(prompter) {
  write('请选择该 API Key 对应的企业微信能力位：');
  for (const line of capabilityMenuLines()) write(line);
  for (;;) {
    const choice = await askLine(prompter, `请输入编号 1-${CAPABILITIES.length}（或直接输入能力代号）: `);
    const capability = parseCapabilityChoice(choice);
    if (capability) return capability.id;
    write('✗ 无效的选择，请重新输入编号或能力代号（如 msg）。');
  }
}

/**
 * 询问是否继续添加 MCP Server。
 * @param {ReturnType<typeof createPrompter>} prompter
 * @returns {Promise<boolean>}
 */
async function askContinue(prompter) {
  for (;;) {
    const answer = await prompter.askLine('继续添加 MCP Server? [y/N]: ');
    if (answer === null) return false;
    const text = answer.trim().toLowerCase();
    if (text === '' || text === 'n' || text === 'no' || text === '否') return false;
    if (text === 'y' || text === 'yes' || text === '是') return true;
    write('请输入 y 或 n。');
  }
}

/**
 * 录入一个 MCP Server（名称 → URL / API Key → 能力位），校验通过才返回。
 * @param {ReturnType<typeof createPrompter>} prompter
 * @param {Array<{name: string, url: string}>} existingServers
 * @returns {Promise<{name: string, url: string}>}
 */
async function promptServer(prompter, existingServers) {
  const index = existingServers.length;
  for (;;) {
    try {
      let name = (await askLine(prompter, 'MCP 名称（回车使用默认值）: ')).trim();
      const input = (await askLine(prompter, 'MCP URL（可直接粘贴完整 URL；只输入 API Key 时请直接回车）: ', 'url')).trim();
      const classified = classifyInput(input);

      let url;
      let capabilityId = null;
      if (classified.kind === 'url') {
        const info = inspectMcpUrl(classified.text);
        url = classified.text;
        capabilityId = info.capabilityId;
        if (info.officialPath && !info.hasApiKey) {
          const apiKey = await askApiKey(prompter);
          url = withApiKey(url, apiKey);
          write(`已按官方格式补全 API Key：${maskedUrl(url)}`);
        }
      } else {
        const apiKey = classified.kind === 'apikey' ? classified.value : await askApiKey(prompter);
        capabilityId = await askCapability(prompter);
        url = buildMcpUrl(capabilityId, apiKey);
        write(`已按官方格式生成 URL：${maskedUrl(url)}`);
      }

      if (!name) name = displayNameForCapability(capabilityId, index);
      // 复用协议模块的完整校验（https / 域名白名单 / 重复 URL / 数量上限等）
      const payload = validatePayload(buildPayload([...existingServers, { name, url }]));
      // 提交连接前检查二维码编码限制，让交互式用户能立即更正 URL 或 Key。
      serializePayload(payload);
      const server = payload.servers[payload.servers.length - 1];
      if (existingServers.some((existing) => existing.name === server.name)) {
        write(`⚠ 名称“${server.name}”已存在，允许继续（URL 不同）。`);
      }
      return server;
    } catch (error) {
      if (error instanceof CancelError) throw error;
      if (!(error instanceof ConfigError)) throw error;
      write(`✗ ${redactText(error.message)}，请重新输入。`);
      write('');
    }
  }
}

/**
 * 交互式收集所有 MCP Server。
 * @param {ReturnType<typeof createPrompter>} prompter
 * @returns {Promise<Array<{name: string, url: string}>>}
 */
async function collectInteractiveServers(prompter) {
  write('Rokid 企业微信助手 配置工具');
  write('');
  write(`可添加多个 MCP Server（每个能力位对应一条独立授权的 URL），最多 ${LIMITS.maxServers} 个。`);
  write('');

  /** @type {Array<{name: string, url: string}>} */
  const servers = [];
  for (;;) {
    if (servers.length >= LIMITS.maxServers) {
      write(`已达到上限 ${LIMITS.maxServers} 个 MCP Server。`);
      break;
    }
    if (servers.length > 0) write(`—— 第 ${servers.length + 1} 个 MCP Server ——`);
    const server = await promptServer(prompter, servers);
    servers.push(server);

    write('');
    write(formatPreview(server));
    for (const warning of serverWarnings(server)) write(warning);
    write('');

    if (servers.length >= LIMITS.maxServers) {
      write(`已达到上限 ${LIMITS.maxServers} 个 MCP Server，停止添加。`);
      break;
    }
    const keepGoing = await askContinue(prompter);
    if (!keepGoing) break;
    write('');
  }
  return servers;
}

// ---------------------------------------------------------------- 二维码输出

/**
 * 删除同前缀的旧导出文件（严格匹配本次 `--png/--svg` 前缀：旧序号分片、上次单张导出的
 * 无序号文件），不碰目录里的其他文件，也不碰任何进程的临时文件；避免用户把旧二维码与
 * 本次混着扫（chunk id 不同，永远收不齐）。
 * 路径回显统一走 redactText：用户可能把含 API Key 的文本误粘贴为输出路径。
 * @param {string} basePath
 * @param {number} total 本次生成的分片数
 */
async function cleanupStaleExports(basePath, total) {
  let entries;
  try {
    entries = await readdir(path.dirname(path.resolve(basePath)));
  } catch {
    return;
  }
  const stale = staleChunkPaths(entries, basePath, total);
  if (!stale.length) return;
  write('发现上次生成遗留的旧分片/单张导出，先清理以免新旧二维码混扫：');
  for (const filePath of stale) write(`  将删除：${redactText(filePath)}`);
  for (const filePath of stale) {
    try {
      await unlink(filePath);
    } catch (error) {
      write(`  ⚠ 删除失败：${redactText(filePath)}（${error?.code ?? '未知错误'}）`);
    }
  }
  write('');
}

/**
 * 导出 PNG / SVG（多张分片时自动追加序号，导出前清理同前缀旧分片）。
 * @param {string[]} chunks
 * @param {{png: string | null, svg: string | null}} options
 */
async function exportFiles(chunks, options) {
  if (options.png) {
    await cleanupStaleExports(options.png, chunks.length);
    for (let index = 0; index < chunks.length; index += 1) {
      const filePath = numberedPath(options.png, index, chunks.length);
      const bytes = await writePngFile(filePath, chunks[index]);
      write(`已导出 PNG：${redactText(filePath)}（${bytes} 字节）`);
    }
  }
  if (options.svg) {
    await cleanupStaleExports(options.svg, chunks.length);
    for (let index = 0; index < chunks.length; index += 1) {
      const filePath = numberedPath(options.svg, index, chunks.length);
      const bytes = await writeSvgFile(filePath, chunks[index]);
      write(`已导出 SVG：${redactText(filePath)}（${bytes} 字节）`);
    }
  }
  if (options.png || options.svg) {
    write('⚠ 导出文件含真实 API Key（权限已设为 600）：请勿提交 Git、上传网盘或外传，用完建议删除。');
    write('');
  }
}

/**
 * 打印配置预览（非交互模式），逐行脱敏。
 * @param {Array<{name: string, url: string}>} servers
 */
function printPreview(servers) {
  servers.forEach((server, index) => {
    if (index > 0) write('');
    write(formatPreview(server));
    for (const warning of serverWarnings(server)) write(warning);
  });
  for (const warning of duplicateNameWarnings(servers)) write(warning);
  write('');
}

/**
 * 生成并输出二维码、导出文件、打印摘要。
 * 所有二维码先渲染成字符串（同时校验容量），成功后才打印表头，避免渲染失败时已输出
 * 「配置已生成」之类的误导信息。
 * @param {{type: string, version: number, servers: Array<{name: string, url: string}>}} payload
 * @param {string} payloadText 二维码承载的紧凑配置文本
 * @param {ReturnType<typeof parseArgs>} options
 * @param {boolean} showPreview 非交互模式下先打印配置预览
 */
async function emitQr(payload, payloadText, options, showPreview) {
  const chunks = splitIntoChunks(payloadText, {
    maxChars: options.maxChars,
    maxBytes: QR_BYTE_CAPACITY,
  });
  // 未显式指定 --max-chars 时，按终端窗口自动缩小每张容量，保证整屏可见（显式指定则以用户为准）。
  // 导出 PNG/SVG 时二维码不靠终端显示，跳过自动适配，避免把文件拆成一堆碎片。
  let effectiveMaxChars = options.maxChars;
  let fittedChunks = null;
  if (process.stdout.isTTY && !options.maxCharsExplicit && !options.png && !options.svg) {
    fittedChunks = fitChunksToTerminal(payloadText, {
      maxChars: options.maxChars,
      maxBytes: QR_BYTE_CAPACITY,
    });
    if (fittedChunks) {
      effectiveMaxChars = fittedChunks.maxChars;
      chunks.splice(0, chunks.length, ...fittedChunks.chunks);
    }
  }
  const mode = resolveQrMode(options.mode);

  // 先确认导出目录可用，避免整张二维码打印完才报错
  if (options.png) await assertExportDirectory(options.png);
  if (options.svg) await assertExportDirectory(options.svg);

  // 在任何写入/删除之前，检查本次 PNG/SVG 输出与清理范围是否重叠（同名、-<数字>
  // 后缀、软链指向同一目录）。例如 --png qr.png --svg qr-1.png 多片时，SVG 阶段的
  // 清理会删掉 PNG 阶段刚写的 qr-1.png，必须直接拒绝而不是 exit 0。
  await assertNoExportTargetOverlap([options.png, options.svg]);

  // 同一/重叠输出前缀的并发导出用排他锁串行化：锁覆盖旧文件清理与本次全部分片写入，
  // 冲突时明确失败，避免两个进程互删旧分片或留下混合分片集。
  // PNG/SVG 双目标按锁路径字典序获取（export-lock 内排序），不会交叉等待死锁。
  const exportLocks = await acquireExportLocks([options.png, options.svg]);
  try {
    const renderedChunks = [];
    for (const chunk of chunks) renderedChunks.push(await renderTerminalQr(chunk, { mode }));

    if (showPreview) {
      write('Rokid 企业微信助手 配置工具');
      write('');
      printPreview(payload.servers);
    }

    write('配置已生成，请使用 Rokid 眼镜扫描：');
    write('');
    if (fittedChunks) {
      write(
        `已按终端窗口 ${process.stdout.columns}×${process.stdout.rows} 自动调整为每张 ≤ ${effectiveMaxChars} 字符（共 ${chunks.length} 张），避免二维码超出可见范围。`,
      );
      const single = estimateQrCells(payloadText);
      if (chunks.length > 1 && single) {
        write(
          `若想减少扫描张数：把终端放大到 ≥ ${single.columns} 列 × ${single.rows} 行（一张扫完），或用 --png 导出后用图片查看器扫描。`,
        );
      } else if (chunks.length > 1) {
        write('若想减少扫描张数：分别拉宽、拉高终端窗口，或用 --png 导出后用图片查看器扫描。');
      }
      write('');
    }

    for (let index = 0; index < chunks.length; index += 1) {
      if (chunks.length > 1) write(`请依次扫描 第 ${index + 1}/${chunks.length} 张`);
      else write('[终端二维码]');

      const rendered = renderedChunks[index];
      process.stdout.write(rendered.endsWith('\n') ? rendered : `${rendered}\n`);
      if (chunks.length > 1) write('');

      if (process.stdout.isTTY) {
        const size = estimateQrCells(chunks[index]);
        const columns = process.stdout.columns || 80;
        const rows = process.stdout.rows || 24;
        if (size && (size.columns > columns || size.rows > rows)) {
          write(
            `⚠ 第 ${index + 1} 张二维码约 ${size.columns} 列 × ${size.rows} 行，可能超出现有终端窗口（${columns}×${rows}）：建议放大窗口或调小 --max-chars。`,
          );
        }
      }
    }
    write('');

    await exportFiles(chunks, options);

    write(
      formatSummary({
        servers: payload.servers,
        chunkCount: chunks.length,
        mode,
        maxChars: effectiveMaxChars,
        payloadChars: payloadText.length,
      }),
    );
  } finally {
    await releaseExportLocks(exportLocks);
  }
}

// ---------------------------------------------------------------- 入口

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const interactive = !options.noInteractive && options.servers.length === 0 && options.files.length === 0;
  if (!interactive && options.servers.length === 0 && options.files.length === 0) {
    throw new ConfigError('MISSING_ARGS', '非交互模式请至少提供一个 --url / --file（或 --capability 与 --apikey）');
  }

  let prompter = null;
  try {
    let servers;
    if (interactive) {
      prompter = createPrompter({ onInterrupt: () => process.kill(process.pid, 'SIGINT') });
      activePrompter = prompter;
      servers = await collectInteractiveServers(prompter);
    } else {
      const fileServers = options.files.length ? await readServerFiles(options.files) : [];
      servers = resolveServerSpecs([...options.servers, ...fileServers]);
    }
    const payload = validatePayload(buildPayload(servers));
    const payloadText = serializePayload(payload);
    await emitQr(payload, payloadText, options, !interactive);
    return 0;
  } finally {
    prompter?.close();
    activePrompter = null;
  }
}

process.on('SIGINT', () => {
  activePrompter?.close();
  writeError('\n已取消。');
  process.exit(130);
});

process.once('SIGTERM', () => {
  // SIGTERM 默认终止不会触发 exit 钩子；先同步清理本进程含凭据的临时文件，再释放本进程锁
  // （只删 pid 匹配本进程的锁、只删本进程登记的临时文件，不动其他进程），最后按 128+15
  // 退出，保持与未捕获 SIGTERM 相同的退出语义。SIGKILL（kill -9）无法捕获，残留需手动处理。
  try {
    activePrompter?.close();
  } catch {
    // 终端恢复失败不应阻塞清理
  }
  cleanupOwnTempFilesSync();
  releaseExportLocksSync();
  writeError('\n已终止（SIGTERM）。');
  process.exit(143);
});

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (error instanceof CancelError) {
      writeError(`\n${error.message}`);
      process.exitCode = 130;
      return;
    }
    if (error instanceof ConfigError) {
      writeError(`错误：${redactText(error.message)}（${error.code}）`);
      if (['INVALID_ARGS', 'MISSING_ARGS', 'MISSING_SERVER_URL', 'MISSING_API_KEY'].includes(error.code)) {
        writeError('使用 --help 查看用法。');
      }
      process.exitCode = 1;
      return;
    }
    writeError(`错误：${redactText(error?.message ?? String(error))}`);
    process.exitCode = 1;
  });
