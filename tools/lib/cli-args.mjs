// 命令行参数解析（纯函数，不读终端、不写文件）。
//
// 非交互模式示例：
//   node tools/wecom-mcp-qr.mjs --no-interactive \
//     --name 测试 --url 'https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=KEY' --mode dark
// 多个 Server：重复 --url（按出现顺序对应第 1、2… 个 Server）。

import { ConfigError, LIMITS } from '../../app/libs/qr-payload.js';

/** 单个二维码默认承载的字符数：保守值，终端里显示得下、也更容易被扫到。 */
export const DEFAULT_MAX_CHARS = 900;
/** 允许的最大 --max-chars：只是参数上限保护，实际每片还受二维码 2331 字节容量约束。 */
export const MAX_MAX_CHARS = 4000;

export const USAGE = `Rokid 企业微信助手 终端二维码生成工具

用法：
  node tools/wecom-mcp-qr.mjs                  # 交互式，逐个添加 MCP Server
  node tools/wecom-mcp-qr.mjs --no-interactive --url <URL> --apikey <KEY> --name <名称>

交互式输入：
  · MCP URL 可直接粘贴官方完整地址（含 ?apikey=...）；
  · 也可只输入 API Key，再按提示选择 8 个能力之一
    （msg 消息 / doc 文档 / schedule 日程 / todo 待办 / meeting 会议 / contact 通讯录 / mail 邮件 / disk 微盘）；
  · 粘贴的 URL 已到 /mcp/v2/bot/<能力> 但缺少 apikey 时，会再提示输入 API Key 并自动组合；
  · 最多配置 ${LIMITS.maxServers} 个连接；不同连接可使用各自独立的 URL / API Key。
  · API Key 仅支持英文字母、数字、- 和 _（base64url）；输入隐藏回显，非终端（管道）环境降级为普通读取并提示。

选项：
  --name <名称>            MCP 名称，可重复（按出现顺序对应第 1、2… 个 Server）
  --url <URL>              MCP URL，可重复；URL 已包含 apikey 时不要再额外传 --apikey
  --apikey <KEY>           API Key，可重复（与 --url / --capability 按顺序配对；URL 已含 apikey 时请勿重复提供）
  --capability <id>        能力代号，可重复；与 --apikey 配对后按官方格式组装 URL（不支持与 --url 混用）
  --no-interactive         非交互模式（缺少必需参数时直接报错，不再提问）
  --mode <dark|light|auto> 终端配色，默认 auto（按终端背景自动判断）
  --dark / --light         等价于 --mode dark / --mode light
  --max-chars <n>          单个二维码承载的近似字符数，默认 ${DEFAULT_MAX_CHARS}（值越小越容易扫）；
                           未显式指定时，终端里会自动按窗口尺寸缩小，保证每张二维码整屏可见；
                           实际每片还受二维码 2331 字节上限约束，超出时自动增加分片数
  --png <路径>             额外导出 PNG（多张时自动追加 -1、-2 后缀）；文件权限自动设为 600
  --svg <路径>             额外导出 SVG（多张时自动追加 -1、-2 后缀）；文件权限自动设为 600
  --file <路径>            从文件批量导入 MCP：JSON（{servers:[{name,url}]}）或每行一个 URL 的 TXT；
                           文件含真实凭据，建议先 chmod 600
  --help, -h               显示本帮助（即使同时存在其他非法参数也优先输出帮助）

二维码内容是 v4 紧凑载荷（只存「哪些能力位在用 + 每把 API Key」，name/url 固化在代码里；
key 的 6 bit 字符打包 + base44 编码，QR 走字母数字模式），8 个能力位约 282 字符，单张即可。

退出码：0 成功；130 用户取消；1 参数或校验错误。
安全：终端输出只显示脱敏后的 URL / API Key；二维码与导出文件均含真实凭据，请勿截图、提交 Git 或外传。`;

const VALUE_FLAGS = new Map([
  ['--name', 'names'],
  ['--url', 'urls'],
  ['--server', 'urls'],
  ['--apikey', 'apikeys'],
  ['--api-key', 'apikeys'],
  ['--capability', 'capabilities'],
  ['--mode', 'mode'],
  ['--max-chars', 'maxChars'],
  ['--png', 'png'],
  ['--svg', 'svg'],
  ['--file', 'files'],
]);

/**
 * @param {string[]} argv
 * @returns {{
 *   help: boolean,
 *   noInteractive: boolean,
 *   maxCharsExplicit: boolean,
 *   mode: 'dark' | 'light' | 'auto',
 *   maxChars: number,
 *   png: string | null,
 *   svg: string | null,
 *   files: string[],
  *   servers: Array<{name: string | null, url: string | null, apikey: string | null, capabilityId: string | null}>,
 * }}
 */
export function parseArgs(argv) {
  const names = [];
  const urls = [];
  const apikeys = [];
  const capabilities = [];
  let help = false;
  let noInteractive = false;
  let darkFlag = false;
  let lightFlag = false;
  let modeValue = null;
  let maxCharsValue = null;
  let png = null;
  let svg = null;
  const files = [];

  // --help 优先于其他参数校验：即使同伴参数非法（如 `--url --help`）也直接成功输出帮助
  if (argv.includes('-h') || argv.includes('--help')) {
    return {
      help: true,
      noInteractive: false,
      maxCharsExplicit: false,
      mode: 'auto',
      maxChars: DEFAULT_MAX_CHARS,
      png: null,
      svg: null,
      files: [],
      servers: [],
    };
  }

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const eqIndex = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = eqIndex > 2 ? raw.slice(0, eqIndex) : raw;
    const inlineValue = eqIndex > 2 ? raw.slice(eqIndex + 1) : undefined;

    if (flag === '--help' || flag === '-h') {
      help = true;
      continue;
    }
    if (flag === '--no-interactive' || flag === '--non-interactive') {
      noInteractive = true;
      continue;
    }
    if (flag === '--dark') {
      darkFlag = true;
      continue;
    }
    if (flag === '--light') {
      lightFlag = true;
      continue;
    }

    const field = VALUE_FLAGS.get(flag);
    if (field) {
      let value = inlineValue;
      if (value === undefined) {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith('--')) {
          throw new ConfigError('INVALID_ARGS', `参数 ${flag} 缺少取值`);
        }
        value = next;
        index += 1;
      }
      if (field === 'names') names.push(value.trim());
      else if (field === 'urls') urls.push(value.trim());
      else if (field === 'apikeys') apikeys.push(value.trim());
      else if (field === 'capabilities') capabilities.push(value.trim());
      else if (field === 'mode') modeValue = value.trim();
      else if (field === 'maxChars') maxCharsValue = value.trim();
      else if (field === 'png') png = value.trim();
      else if (field === 'svg') svg = value.trim();
      else if (field === 'files') files.push(value.trim());
      continue;
    }

    // 未知参数一律不回显：`-` 开头的参数可能拼进了 API Key（如 --bogus<KEY>），
    // 位置参数同样可能误贴 URL/Key，统一给出隐藏内容的提示。
    throw new ConfigError(
      'INVALID_ARGS',
      '存在无法识别的参数（内容已隐藏）。请检查参数拼写与引号；URL 请用 --url 传入，使用 --help 查看用法',
    );
  }

  if (darkFlag && lightFlag) {
    throw new ConfigError('INVALID_ARGS', '不能同时使用 --dark 和 --light');
  }
  if ((darkFlag || lightFlag) && modeValue !== null) {
    throw new ConfigError('INVALID_ARGS', '不能同时使用 --mode 与 --dark / --light');
  }

  let mode = 'auto';
  if (darkFlag) mode = 'dark';
  else if (lightFlag) mode = 'light';
  else if (modeValue !== null) {
    if (!['dark', 'light', 'auto'].includes(modeValue)) {
      throw new ConfigError('INVALID_ARGS', '--mode 只支持 dark / light / auto，请检查取值');
    }
    mode = modeValue;
  }

  let maxChars = DEFAULT_MAX_CHARS;
  if (maxCharsValue !== null) {
    if (!/^\d+$/.test(maxCharsValue)) {
      throw new ConfigError('INVALID_ARGS', '--max-chars 必须是正整数');
    }
    maxChars = Number.parseInt(maxCharsValue, 10);
    if (maxChars < LIMITS.minChunkChars) {
      throw new ConfigError(
        'INVALID_ARGS',
        `单个二维码容量至少需要 ${LIMITS.minChunkChars} 字符（--max-chars 太小，分片信封本身约有 120 字符固定开销）`,
      );
    }
    if (maxChars > MAX_MAX_CHARS) {
      throw new ConfigError('INVALID_ARGS', `--max-chars 不能大于 ${MAX_MAX_CHARS}`);
    }
  }

  if (files.some((file) => !file)) throw new ConfigError('INVALID_ARGS', '--file 不能为空路径');
  if (png !== null && !png) throw new ConfigError('INVALID_ARGS', '--png 不能为空路径');
  if (svg !== null && !svg) throw new ConfigError('INVALID_ARGS', '--svg 不能为空路径');

  if (files.length && (urls.length || capabilities.length || names.length || apikeys.length)) {
    throw new ConfigError('INVALID_ARGS', '--file 不能与 --url / --capability / --apikey / --name 混用');
  }
  if (urls.length && capabilities.length) {
    throw new ConfigError(
      'INVALID_ARGS',
      '不支持在同一命令中混用 --url 与 --capability：请统一用 --url 重复传入，或统一用 --capability + --apikey',
    );
  }

  const serverCount = Math.max(urls.length, capabilities.length);
  if (names.length > serverCount) {
    throw new ConfigError('INVALID_ARGS', '--name 的数量多于 MCP Server 数量');
  }
  if (apikeys.length > serverCount) {
    throw new ConfigError('INVALID_ARGS', '--apikey 的数量多于 MCP Server 数量（缺少 --url 或 --capability）');
  }

  const servers = [];
  for (let index = 0; index < serverCount; index += 1) {
    const url = urls[index] ?? null;
    const capabilityId = capabilities[index] ?? null;
    if (!url && !capabilityId) {
      throw new ConfigError('MISSING_SERVER_URL', `第 ${index + 1} 个 MCP 缺少 --url 或 --capability`);
    }
    if (!url && !apikeys[index]) {
      throw new ConfigError('MISSING_API_KEY', `第 ${index + 1} 个 MCP 选择了能力位但缺少 --apikey`);
    }
    servers.push({
      name: names[index] ? names[index] : null,
      url,
      apikey: apikeys[index] ?? null,
      capabilityId,
    });
  }

  return {
    help,
    noInteractive,
    maxCharsExplicit: maxCharsValue !== null,
    mode,
    maxChars,
    png,
    svg,
    files,
    servers,
  };
}
