// Rokid 企业微信助手 —— 二维码配置协议（AIUI 端与终端工具共用）
//
// 该模块是纯 JavaScript（不依赖 wx / Node / npm 包），同时被：
//   - AIUI 应用：pages/scan（扫码解析、分片重组）
//   - 终端工具：tools/wecom-mcp-qr.mjs（生成二维码 JSON、分片）
//   - 单元测试：test/qr-payload.test.mjs
// 使用，保证「生成」与「解析」永远是同一份协议定义。
//
// 完整配置（单个二维码装得下时）：
//   {
//     "type": "rokid-wecom-assistant",
//     "version": 1,
//     "servers": [{ "name": "企业微信消息", "url": "https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=..." }]
//   }
//
// 分片配置（内容超出一个二维码容量时，连续扫描多张）：
//   {
//     "type": "rokid-wecom-assistant",
//     "version": 1,
//     "chunk": { "id": "3f2a91c0", "index": 0, "total": 3 },
//     "checksum": "8f14e45f",          // 完整 payload 文本的 CRC32，用于重组校验
//     "data": "{\"type\":\"rokid-we..." // 完整 payload 文本按码点切分的一段
//   }

export const QR_TYPE = 'rokid-wecom-assistant';
export const QR_VERSION = 1;

/** 协议限制：超出即拒绝，避免眼镜端被超长配置拖垮。 */
export const LIMITS = {
  maxServers: 32,
  maxNameLength: 40,
  maxUrlLength: 2048,
  maxPayloadChars: 81920,
  maxChunks: 128,
  // 单张二维码的最小可用容量：分片信封本身约有 120 字符的固定开销，
  // 低于此值任何配置都无法完成分片（旧值 60 会让 --max-chars 60/100 恒失败）。
  minChunkChars: 200,
};

/** 二维码（EC M / version 40 / byte 模式）的 UTF-8 字节容量上限，终端工具按此自动分片。 */
export const QR_BYTE_CAPACITY = 2331;

/** 默认允许的企业微信域名后缀（官方远程 MCP 均位于 qyapi.weixin.qq.com）。 */
export const DEFAULT_ALLOWED_HOST_SUFFIXES = ['qyapi.weixin.qq.com', 'weixin.qq.com'];

export class ConfigError extends Error {
  /**
   * @param {string} code 机器可读错误码，用于 UI 决定下一步（重新扫码 / 放弃）
   * @param {string} message 面向用户的中文提示
   */
  constructor(code, message) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

// ---------------------------------------------------------------- CRC32

const UTF8_ENCODER = new TextEncoder();

/**
 * 计算字符串的 UTF-8 字节数：这才是二维码实际占用的容量单位（中文 3 字节/字）。
 * @param {string} text
 * @returns {number}
 */
function utf8ByteLength(text) {
  return UTF8_ENCODER.encode(String(text)).length;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

/**
 * 计算字符串 UTF-8 字节的 CRC32，返回 8 位小写十六进制。
 * 用于二维码分片重组后的完整性校验（防止扫漏/扫错片）。
 * @param {string} text
 * @returns {string}
 */
export function crc32(text) {
  let crc = 0xffffffff;
  const bytes = UTF8_ENCODER.encode(String(text));
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  return crc.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------- 脱敏

const SECRET_QUERY_KEYS = ['apikey', 'api_key', 'key', 'token', 'access_token', 'secret', 'password', 'sign'];
/** redactText 的键名集合：在 URL 查询参数之外，再覆盖 JSON 里常见的 camelCase accessToken。 */
const REDACT_KEY_NAMES = [...SECRET_QUERY_KEYS, 'accesstoken'];

/**
 * 匹配 `key=value` / `key: value` / `"key":"value"` / `;key=value` / `?key=...` 等形态，只替换值部分。
 * 前缀要求`[^\w]`：既覆盖中文标点/紧邻中文字符/`/`/`-` 等场景，又不会命中 `monkey=` 这类更长单词。
 * 分隔符兼容全角 `：`/`＝`；值支持 JSON 反斜杠转义（`\"`、`\\`），避免只遮盖一半导致尾部泄漏。
 */
const REDACT_PATTERN = new RegExp(
  String.raw`(^|[^\w])(["']?)(${REDACT_KEY_NAMES.join('|')})(["'])?(\s*[:=：＝]\s*)(["']?)((?:[^\\\s"',;&#]|\\.)+)`,
  'gi',
);

/**
 * 遮盖单个密钥：保留末尾 4 位便于核对，其余隐藏。
 * @param {string} value
 * @returns {string}
 */
export function maskSecret(value) {
  const text = String(value ?? '');
  if (text.length === 0) return '';
  if (text.length <= 8) return '****';
  return `****${text.slice(-4)}`;
}

/**
 * 生成可安全显示 / 写入日志的 URL：保留协议、域名、路径，查询参数中的密钥脱敏。
 * 注意：该函数返回的仍然是配置标识，不要把它当作「可公开」信息随意外发。
 * @param {string} rawUrl
 * @returns {string}
 */
export function maskUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return String(rawUrl ?? '').replace(/([?&](?:apikey|api_key|key|token|secret|password|sign)=)[^&#]*/gi, '$1••••');
  }
  const masked = new URLSearchParams();
  for (const [key, value] of url.searchParams.entries()) {
    masked.set(key, SECRET_QUERY_KEYS.includes(key.toLowerCase()) ? maskSecret(value) : value);
  }
  const query = masked.toString();
  return `${url.origin}${url.pathname}${query ? `?${query}` : ''}`;
}

/**
 * 从任意文本中抹除 API Key 等敏感片段，用于写日志 / 展示错误信息。
 * 覆盖 URL 查询串、`key=value`、`key: value`、JSON `"key":"value"`、`;` 分隔等常见形态，
 * 命中后只保留值的末 4 位（maskSecret），其余以 **** 遮盖。
 * @param {string} text
 * @returns {string}
 */
export function redactText(text) {
  return String(text ?? '').replace(
    REDACT_PATTERN,
    (_match, lead, quote1, key, quote2, separator, openQuote, value) =>
      `${lead ?? ''}${quote1 ?? ''}${key}${quote2 ?? ''}${separator}${openQuote ?? ''}${maskSecret(value)}`,
  );
}

// ---------------------------------------------------------------- 校验

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function toPositiveInt(value, fallback) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    if (parsed > 0) return parsed;
  }
  return fallback;
}

/**
 * 校验并规范化单个 MCP Server 配置。
 * @param {unknown} raw
 * @param {number} index
 * @param {{allowedHostSuffixes?: string[], requireApiKey?: boolean, allowInsecure?: boolean}} [options]
 *   `allowInsecure` 仅供本地 mock 调试时放开 http，生产扫码流程始终传 false。
 * @returns {{name: string, url: string}}
 */
export function validateServer(raw, index, options = {}) {
  const label = `第 ${index + 1} 个 MCP`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('INVALID_SERVER', `${label}配置格式不正确`);
  }
  const record = /** @type {Record<string, unknown>} */ (raw);

  const rawName = typeof record.name === 'string' ? record.name.trim() : '';
  if (!rawName) throw new ConfigError('INVALID_SERVER_NAME', `${label}缺少名称`);
  if (rawName.length > LIMITS.maxNameLength) {
    throw new ConfigError('INVALID_SERVER_NAME', `${label}名称过长（最多 ${LIMITS.maxNameLength} 个字符）`);
  }

  const rawUrl = typeof record.url === 'string' ? record.url.trim() : '';
  if (!rawUrl) throw new ConfigError('INVALID_SERVER_URL', `${label}缺少 MCP URL`);
  if (rawUrl.length > LIMITS.maxUrlLength) {
    throw new ConfigError('INVALID_SERVER_URL', `${label}的 MCP URL 过长`);
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConfigError('INVALID_SERVER_URL', `${label}的 MCP URL 格式不正确`);
  }
  if (url.protocol !== 'https:' && options.allowInsecure !== true) {
    throw new ConfigError('INSECURE_URL', `${label}必须使用 https（当前为 ${url.protocol}）`);
  }
  if (url.username || url.password) {
    throw new ConfigError('INVALID_SERVER_URL', `${label}的 URL 不应包含用户名或密码`);
  }
  if (url.port && url.port !== '443') {
    throw new ConfigError('INVALID_SERVER_URL', `${label}只允许使用 443 端口`);
  }
  if (url.hash) {
    throw new ConfigError('INVALID_SERVER_URL', `${label}的 URL 不应包含 # 片段`);
  }

  const allowedHostSuffixes = options.allowedHostSuffixes ?? DEFAULT_ALLOWED_HOST_SUFFIXES;
  const hostname = url.hostname.toLowerCase();
  const hostAllowed = allowedHostSuffixes.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
  if (!hostAllowed) {
    throw new ConfigError(
      'UNTRUSTED_HOST',
      `${label}的域名 ${hostname} 不在允许列表（${allowedHostSuffixes.join(' / ')}）`,
    );
  }

  // 官方 `/mcp/v<版本>/bot/<能力位>` 路径（msg/doc/schedule/… 任何能力位，不只 msg）
  // 缺少 apikey 时一律拒绝；非官方路径保持宽松（终端工具会 warning，眼镜端靠真实调用验证）。
  if (options.requireApiKey !== false && /^\/mcp\/v\d+\/bot\/[A-Za-z0-9_-]+\/?$/i.test(url.pathname)) {
    if (!url.searchParams.get('apikey')) {
      throw new ConfigError('MISSING_API_KEY', `${label}缺少 apikey 参数`);
    }
  }

  // 去掉无意义的默认端口与空查询串，保证同一配置序列化结果稳定
  url.port = '';
  const normalized = url.toString();

  return { name: rawName, url: normalized };
}

/**
 * 校验完整配置对象，返回规范化后的配置。
 * @param {unknown} raw
 * @param {{allowedHostSuffixes?: string[], allowInsecure?: boolean}} [options]
 * @returns {{type: string, version: number, servers: Array<{name: string, url: string}>}}
 */
export function validatePayload(raw, options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('INVALID_PAYLOAD', '二维码内容不是有效的 JSON 对象');
  }
  const record = /** @type {Record<string, unknown>} */ (raw);

  if (record.type !== QR_TYPE) {
    throw new ConfigError('INVALID_TYPE', '这不是 Rokid 企业微信助手配置二维码');
  }
  const version = toPositiveInt(record.version, 0);
  if (version !== QR_VERSION) {
    if (version > QR_VERSION) {
      throw new ConfigError('UNSUPPORTED_VERSION', `配置文件版本 ${version} 高于本应用支持的 ${QR_VERSION}，请升级应用`);
    }
    throw new ConfigError('INVALID_VERSION', '配置缺少合法的 version 字段');
  }
  if (!Array.isArray(record.servers)) {
    throw new ConfigError('INVALID_SERVERS', '配置缺少 servers 列表');
  }
  if (record.servers.length === 0) {
    throw new ConfigError('INVALID_SERVERS', 'servers 列表为空');
  }
  if (record.servers.length > LIMITS.maxServers) {
    throw new ConfigError('INVALID_SERVERS', `servers 数量超过上限 ${LIMITS.maxServers}`);
  }

  const servers = record.servers.map((server, index) => validateServer(server, index, options));
  const seen = new Set();
  for (const server of servers) {
    if (seen.has(server.url)) {
      throw new ConfigError('DUPLICATE_SERVER', `存在重复的 MCP：${server.name}`);
    }
    seen.add(server.url);
  }
  return { type: QR_TYPE, version: QR_VERSION, servers };
}

/**
 * 由服务器列表构造标准配置对象（不校验，供生成端使用）。
 * @param {Array<{name: string, url: string}>} servers
 * @returns {{type: string, version: number, servers: Array<{name: string, url: string}>}}
 */
export function buildPayload(servers) {
  return {
    type: QR_TYPE,
    version: QR_VERSION,
    servers: servers.map((server) => ({ name: server.name.trim(), url: server.url.trim() })),
  };
}

/**
 * 序列化为二维码承载的文本（字段顺序固定，便于人工比对与测试）。
 * @param {{type?: string, version?: number, servers: Array<{name: string, url: string}>}} payload
 * @returns {string}
 */
export function serializePayload(payload) {
  return JSON.stringify({
    type: payload.type ?? QR_TYPE,
    version: payload.version ?? QR_VERSION,
    servers: payload.servers,
  });
}

// ---------------------------------------------------------------- 分片

/**
 * 按 Unicode 码点切分，避免把代理对（emoji 等）切成两半导致乱码。
 * @param {string} text
 * @param {number} parts
 * @returns {string[]}
 */
export function sliceByCodePoints(text, parts) {
  const codePoints = Array.from(text);
  const result = [];
  const base = Math.ceil(codePoints.length / parts);
  for (let index = 0; index < parts; index += 1) {
    const start = index * base;
    if (start >= codePoints.length) break;
    result.push(codePoints.slice(start, start + base).join(''));
  }
  return result;
}

/**
 * 生成固定长度的分片 ID（非安全随机，仅用于区分同一次生成的各片）。
 * @param {() => number} [random]
 * @returns {string}
 */
export function createChunkId(random = Math.random) {
  let id = '';
  for (let i = 0; i < 8; i += 1) {
    id += Math.floor(random() * 16).toString(16);
  }
  return id;
}

/**
 * 构造一片分片二维码的 JSON 文本（生成与开销估算共用同一份逻辑）。
 * @param {{chunkId: string, index: number, total: number, checksum: string, data: string}} parts
 * @returns {string}
 */
function buildChunkEnvelope({ chunkId, index, total, checksum, data }) {
  return JSON.stringify({
    type: QR_TYPE,
    version: QR_VERSION,
    chunk: { id: chunkId, index, total },
    checksum,
    data,
  });
}

/**
 * 把完整 payload 文本切分为若干二维码片段，尽量用最少片段。
 * 每片序列化后必须**同时**满足：
 *   - 字符数 ≤ maxChars（近似值，兼顾终端显示宽度与分片可读性）；
 *   - UTF-8 字节数 ≤ maxBytes（二维码的真实容量；EC M / version 40 为 2331 字节）。
 * maxBytes 默认 Infinity，仅按字符数切分（兼容旧调用/单元测试）。
 * @param {string} payloadText
 * @param {{maxChars?: number, maxBytes?: number, chunkId?: string, random?: () => number}} [options]
 * @returns {string[]} 每个元素是一段可直接编码为二维码的 JSON 文本
 */
export function splitIntoChunks(payloadText, options = {}) {
  const text = String(payloadText ?? '');
  if (text.length > LIMITS.maxPayloadChars) {
    throw new ConfigError('PAYLOAD_TOO_LARGE', `配置内容超过 ${LIMITS.maxPayloadChars} 字符，请减少 MCP 数量`);
  }
  const maxChars = toPositiveInt(options.maxChars, 900);
  const maxBytes = options.maxBytes === undefined ? Infinity : toPositiveInt(options.maxBytes, 0);
  if (maxBytes <= 0) {
    throw new ConfigError('CHUNK_TOO_SMALL', '单个二维码的字节容量设置不合法');
  }
  const checksum = crc32(text);
  const chunkId = options.chunkId ?? createChunkId(options.random);

  // 分片信封的固定开销（按最大位数估算：index/total 最多 3 位），最小可用容量据此动态计算
  const emptyEnvelope = buildChunkEnvelope({
    chunkId,
    index: LIMITS.maxChunks - 1,
    total: LIMITS.maxChunks,
    checksum,
    data: '',
  });
  const minChars = emptyEnvelope.length + 1;
  const minBytes = utf8ByteLength(emptyEnvelope) + 1;
  if (maxChars < LIMITS.minChunkChars || maxChars < minChars) {
    const required = Math.max(LIMITS.minChunkChars, minChars);
    throw new ConfigError(
      'CHUNK_TOO_SMALL',
      `单个二维码容量至少需要 ${required} 字符（分片信封固定开销约 ${emptyEnvelope.length} 字符），请增大 --max-chars`,
    );
  }
  if (maxBytes < minBytes) {
    throw new ConfigError(
      'CHUNK_TOO_SMALL',
      `单个二维码最多 ${maxBytes} 字节，但分片信封固定开销约 ${minBytes} 字节，请增大容量上限`,
    );
  }

  const fits = (value) => value.length <= maxChars && utf8ByteLength(value) <= maxBytes;

  // 一片装得下时直接输出完整 payload，不额外套分片信封（更短、更容易扫）
  if (fits(text)) return [text];

  for (let parts = 2; parts <= LIMITS.maxChunks; parts += 1) {
    const slices = sliceByCodePoints(text, parts);
    const envelopes = slices.map((data, index) =>
      buildChunkEnvelope({ chunkId, index, total: slices.length, checksum, data }),
    );
    if (envelopes.every(fits)) return envelopes;
  }

  // 区分是「字符上限」还是「字节上限」导致无法分片，给出可执行的提示
  const probe = buildChunkEnvelope({
    chunkId,
    index: 0,
    total: LIMITS.maxChunks,
    checksum,
    data: 'x',
  });
  const byteBound = utf8ByteLength(probe) > maxBytes;
  const charBound = probe.length > maxChars;
  if (byteBound) {
    throw new ConfigError(
      'PAYLOAD_TOO_LARGE',
      `配置内容无法拆分到 ${LIMITS.maxChunks} 个二维码以内：单个二维码最多 ${maxBytes} 字节，最小分片已需 ${utf8ByteLength(probe)} 字节，请减少 MCP 数量`,
    );
  }
  if (charBound) {
    throw new ConfigError(
      'PAYLOAD_TOO_LARGE',
      `配置内容无法拆分到 ${LIMITS.maxChunks} 个二维码以内：每片需 ≤ ${maxChars} 字符，最小分片已需 ${probe.length} 字符，请增大 --max-chars`,
    );
  }
  throw new ConfigError(
    'PAYLOAD_TOO_LARGE',
    `配置内容无法拆分到 ${LIMITS.maxChunks} 个二维码以内（每片最多约 ${maxChars} 字符），请增大 --max-chars 或减少 MCP 数量`,
  );
}

/**
 * 解析扫码文本：返回「完整配置」或「一片分片」。
 * @param {string} scannedText
 * @returns {{kind: 'payload', payload: object} | {kind: 'chunk', chunk: {id: string, index: number, total: number}, data: string, checksum: string}}
 */
export function parseScannedText(scannedText) {
  const text = String(scannedText ?? '').trim();
  if (!text) throw new ConfigError('EMPTY_SCAN', '没有扫描到内容');
  if (text.length > LIMITS.maxPayloadChars * 2) {
    throw new ConfigError('SCAN_TOO_LARGE', '二维码内容过大，可能不是企业微信 MCP 配置');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError('NOT_JSON', '二维码内容不是 JSON，请扫描本工具生成的二维码');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError('INVALID_PAYLOAD', '二维码内容不是有效的配置对象');
  }
  if (parsed.type !== QR_TYPE) {
    throw new ConfigError('INVALID_TYPE', '这不是 Rokid 企业微信助手配置二维码');
  }

  if (parsed.chunk === undefined) {
    return { kind: 'payload', payload: parsed };
  }

  const chunk = parsed.chunk;
  if (!chunk || typeof chunk !== 'object') {
    throw new ConfigError('INVALID_CHUNK', '分片信息格式不正确');
  }
  const id = typeof chunk.id === 'string' ? chunk.id.trim() : '';
  const total = toPositiveInt(chunk.total, 0);
  // index 必须本来就是整数：不接受 "1x"/"1.5" 这类会被 parseInt 截断的输入
  if (!id || total <= 0 || !Number.isInteger(chunk.index) || chunk.index < 0 || chunk.index >= total) {
    throw new ConfigError('INVALID_CHUNK', '分片序号不合法');
  }
  if (total > LIMITS.maxChunks) {
    throw new ConfigError('INVALID_CHUNK', `分片数量超过上限 ${LIMITS.maxChunks}`);
  }
  // 内容缺失/非字符串时立即报错，不要拖到重组后才发现 CRC 对不上
  if (typeof parsed.data !== 'string') {
    throw new ConfigError('INVALID_CHUNK', '分片缺少内容');
  }
  const data = parsed.data;
  const checksum = typeof parsed.checksum === 'string' ? parsed.checksum.toLowerCase() : '';
  if (!checksum || !/^[0-9a-f]{8}$/.test(checksum)) {
    throw new ConfigError('INVALID_CHUNK', '分片缺少校验码');
  }
  return { kind: 'chunk', chunk: { id, index: chunk.index, total }, data, checksum };
}

/**
 * 创建一个分片重组器。连续扫码时把每片交给 add()，收齐后返回完整配置文本。
 * @param {{maxChunks?: number}} [options]
 */
export function createChunkAssembler(options = {}) {
  const maxChunks = options.maxChunks ?? LIMITS.maxChunks;
  /** @type {Map<string, {total: number, checksum: string, parts: Array<string | undefined>, filled: number}>} */
  const sessions = new Map();
  let activeId = null;

  return {
    /** @returns {string | null} 当前正在收集的会话 ID */
    get activeChunkId() {
      return activeId;
    },
    /** 清空当前会话（用户取消 / 重新扫码） */
    reset() {
      sessions.clear();
      activeId = null;
    },
    /**
     * 加入一片分片。
     * @param {{id: string, index: number, total: number}} chunk
     * @param {string} data
     * @param {string} checksum
     * @returns {{status: 'pending', received: number, total: number} | {status: 'complete', text: string, duplicates: number}}
     */
    add(chunk, data, checksum) {
      if (chunk.total > maxChunks) {
        throw new ConfigError('INVALID_CHUNK', `分片数量超过上限 ${maxChunks}`);
      }
      let session = sessions.get(chunk.id);
      if (!session) {
        session = {
          total: chunk.total,
          checksum,
          parts: new Array(chunk.total).fill(undefined),
          filled: 0,
          duplicates: 0,
        };
        sessions.set(chunk.id, session);
      } else if (session.total !== chunk.total) {
        throw new ConfigError('INVALID_CHUNK', '分片数量与之前不一致，请重新扫描');
      } else if (session.checksum !== checksum) {
        throw new ConfigError('CHECKSUM_MISMATCH', '分片校验码不一致，请重新扫描');
      }
      activeId = chunk.id;

      if (session.parts[chunk.index] === undefined) {
        session.parts[chunk.index] = data;
        session.filled += 1;
      } else {
        session.duplicates += 1;
      }
      if (session.filled < session.total) {
        return { status: 'pending', received: session.filled, total: session.total };
      }

      const text = session.parts.join('');
      sessions.delete(chunk.id);
      activeId = null;
      if (crc32(text) !== session.checksum) {
        throw new ConfigError('CHECKSUM_MISMATCH', '分片内容校验失败，请重新扫描');
      }
      return { status: 'complete', text, duplicates: session.duplicates };
    },
  };
}
