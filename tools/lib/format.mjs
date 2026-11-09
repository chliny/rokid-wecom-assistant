// 安全输出格式化（纯函数）：配置预览、配置摘要、导出文件命名。
// 所有展示函数都只接收脱敏后的内容，绝不输出完整 URL 或 API Key。

import path from 'node:path';
import { QR_BYTE_CAPACITY, maskUrl } from '../../app/libs/qr-payload.js';
import { findCapability, inspectMcpUrl } from './wecom.mjs';
import { describeQrMode } from './terminal.mjs';

/**
 * 生成可安全显示的 URL（查询串里的 apikey 会被遮盖）。
 * @param {string} rawUrl
 * @returns {string}
 */
export function maskedUrl(rawUrl) {
  return maskUrl(String(rawUrl ?? ''));
}

/**
 * 解析 URL 信息，失败时返回 null（展示路径不应因 URL 非法而崩溃）。
 * @param {string} rawUrl
 */
function safeInspect(rawUrl) {
  try {
    return inspectMcpUrl(rawUrl);
  } catch {
    return null;
  }
}

/**
 * 单个 Server 的安全预览（与用户提供的样例输出一致）。
 * @param {{name: string, url: string}} server
 * @returns {string}
 */
export function formatPreview(server) {
  const info = safeInspect(server.url);
  const lines = [
    `MCP 名称: ${server.name}`,
    '',
    'MCP URL:',
    `> ${maskedUrl(server.url)}`,
    '',
    'API Key:',
    info?.hasApiKey ? '> ********' : '> （未包含）',
  ];
  return lines.join('\n');
}

/**
 * 每个 Server 的告警（都不含敏感信息）。
 * @param {{name: string, url: string}} server
 * @returns {string[]}
 */
export function serverWarnings(server) {
  const info = safeInspect(server.url);
  if (!info) return ['⚠ 该 URL 无法解析，请检查后重新输入。'];
  const warnings = [];
  if (!info.hasApiKey) warnings.push('⚠ 该 URL 未包含 apikey，眼镜端可能无法通过鉴权。');
  if (!info.officialPath) {
    warnings.push('⚠ 该 URL 不在官方 /mcp/v2/bot/<能力> 路径下，二维码只支持内置的 8 个能力位地址。');
  } else if (!info.capability) {
    warnings.push('⚠ 该能力位不在内置的 8 个能力位中，二维码无法保存它（请升级工具）。');
  }
  const defaultName = info.capability?.name;
  if (defaultName && server.name !== defaultName) {
    warnings.push(`⚠ 自定义名称不会写入二维码，扫码后按能力位显示默认名称「${defaultName}」。`);
  }
  return warnings;
}

/**
 * 生成后的安全摘要：名称 + 脱敏 URL + 能力 + 编码 + 分片数；授权有效性由眼镜端实际调用验证。
 * @param {{
 *   servers: Array<{name: string, url: string}>,
 *   chunkCount: number,
 *   mode: 'dark' | 'light',
 *   maxChars: number,
 *   payloadChars: number,
 * }} options
 * @returns {string}
 */
export function formatSummary({ servers, chunkCount, mode, maxChars, payloadChars }) {
  const lines = [`配置摘要（MCP Server ${servers.length} 个 / 二维码 ${chunkCount} 张）：`];
  servers.forEach((server, index) => {
    const info = safeInspect(server.url);
    const capability = info?.capability ?? (info?.capabilityId ? findCapability(info.capabilityId) : null);
    const capabilityText = capability
      ? `${capability.id}（${capability.label}）`
      : info?.capabilityId
        ? `${info.capabilityId}（自定义）`
        : '自定义 URL';
    lines.push(`  ${index + 1}. ${server.name} ｜ 能力：${capabilityText}`);
    lines.push(`     URL：${maskedUrl(server.url)}`);
  });
  lines.push('');
  lines.push(
    `二维码分片：${chunkCount} 张${
      chunkCount > 1
        ? `（每张约 ≤ ${maxChars} 字符，且不超过 ${QR_BYTE_CAPACITY} 字节；请按顺序依次扫描）`
        : '（一张即可）'
    }`,
  );
  if (payloadChars) {
    lines.push(
      `内容编码：紧凑载荷 v4（${payloadChars} 字符，QR 字母数字模式；名称与地址由内置的 8 个能力位还原）`,
    );
  }
  lines.push(`终端配色：${describeQrMode(mode)}`);
  lines.push('首次扫码时会验证授权；后续如连接或工具调用报告授权失效，请在企业微信重新授权并重新扫码。');
  lines.push('安全提示：二维码内容包含真实凭据（可还原出完整 URL 与 API Key），请勿截图或转存外传。');
  if (mode === 'dark') {
    lines.push('提示：反色二维码（白码黑底）个别扫描器可能不识别，若眼镜扫不出，请加 --mode light 重新生成。');
  }
  return lines.join('\n');
}

/**
 * 多个分片导出时的文件命名：单张用原路径，多张追加 -1、-2 后缀。
 * @param {string} basePath
 * @param {number} index 从 0 开始
 * @param {number} total
 * @returns {string}
 */
export function numberedPath(basePath, index, total) {
  if (total <= 1) return basePath;
  const dir = path.dirname(basePath);
  const ext = path.extname(basePath);
  const stem = path.basename(basePath, ext);
  return path.join(dir, `${stem}-${index + 1}${ext}`);
}

/**
 * 重名 MCP 提示：协议允许重名（URL 不同即可），但界面上难以区分。
 * @param {Array<{name: string}>} servers
 * @returns {string[]}
 */
export function duplicateNameWarnings(servers) {
  const counts = new Map();
  for (const server of servers) counts.set(server.name, (counts.get(server.name) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name, count]) => `⚠ MCP 名称“${name}”重复 ${count} 次（允许保存，但界面上难以区分）。`);
}

/**
 * 计算需要清理的旧导出文件：只匹配本次 `--png/--svg` 路径对应的前缀，
 * 不碰目录里的其他文件，也不碰任何进程的临时文件（并发写入的临时文件由
 * export-lock 的排他锁保护，清理只处理已完成的旧导出）。包括两类：
 *   - 带序号的旧分片 `stem-<数字><扩展名>`（不属于本次 1..total 的）；
 *   - 上次单张导出遗留的无序号 `basePath`（本次改成分片后它已过期）。
 * @param {string[]} entryNames 目录内的文件名列表
 * @param {string} basePath 本次 --png/--svg 传入的路径
 * @param {number} total 本次生成的分片数
 * @returns {string[]} 需要删除的文件路径（与 basePath 相同的目录风格）
 */
export function staleChunkPaths(entryNames, basePath, total) {
  const directory = path.dirname(basePath);
  const extension = path.extname(basePath);
  const stem = path.basename(basePath, extension);
  const keep = new Set();
  // 单张时写的是原路径（不带序号），因此带序号的旧文件全部属于上次的旧分片
  if (total > 1) {
    for (let index = 1; index <= total; index += 1) keep.add(`${stem}-${index}${extension}`);
  }
  const numbered = new RegExp(`^${escapeRegExp(stem)}-(\\d+)${escapeRegExp(extension)}$`);
  const stale = [];
  for (const name of entryNames) {
    if (numbered.test(name) && !keep.has(name)) stale.push(path.join(directory, name));
  }
  // 本次改成多张时，上次单张导出的无序号文件不会被本次覆盖，必须一并清理，避免新旧二维码混扫
  const baseName = path.basename(basePath);
  if (total > 1 && entryNames.includes(baseName)) stale.push(path.join(directory, baseName));
  return stale;
}

/**
 * 转义正则元字符（用于把文件名 stem 当字面量匹配）。
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
