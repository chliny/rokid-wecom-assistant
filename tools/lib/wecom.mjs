// 企业微信官方远程 MCP：URL 组装、API Key 校验与输入分类。
//
// 本模块是纯函数（不读写终端、不读写文件），既供交互式 CLI 使用，也可被脚本复用。
// 能力位清单、官方 URL 形态与 API Key 规则放在共享模块 app/libs/wecom-mcp.js：
// 眼镜端还原紧凑配置二维码时要用同一份定义，这里只做 re-export，避免两端漂移。
// 官方 URL 形态（实测；取证记录为本地未入库的 `.refs/NOTES-wecom-mcp.md`，clone 后不存在，
// 仅作来源说明，本模块不依赖该路径）：
//   https://qyapi.weixin.qq.com/mcp/v2/bot/<capability>?apikey=<KEY>
// 鉴权只支持 query 参数 apikey（没有 Bearer / OAuth），每个能力位分别配置凭据。授权有效期以官方对具体能力的说明和服务端实际校验为准。

import { ConfigError } from '../../app/libs/qr-payload.js';
import {
  CAPABILITIES,
  WECOM_APIKEY_INVALID_CHARS,
  WECOM_APIKEY_MAX_LENGTH,
  WECOM_APIKEY_PARAM,
  WECOM_MCP_ORIGIN,
  WECOM_MCP_PATH_PREFIX,
  displayNameForCapability,
  findCapability,
} from '../../app/libs/wecom-mcp.js';

export { CAPABILITIES, displayNameForCapability, findCapability };

export const MCP_ORIGIN = WECOM_MCP_ORIGIN;
export const MCP_PATH_PREFIX = WECOM_MCP_PATH_PREFIX;
export const APIKEY_PARAM = WECOM_APIKEY_PARAM;
export const APIKEY_MAX_LENGTH = WECOM_APIKEY_MAX_LENGTH;

/** 官方能力路径：/mcp/v2/bot/<capability> */
const OFFICIAL_PATH_PATTERN = /^\/mcp\/v(\d+)\/bot\/([A-Za-z0-9_-]+)\/?$/;
/** 带协议头的输入才当作 URL，否则当作 API Key 尝试。 */
const URL_LIKE_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
/** API Key 中不允许出现的字符（与共享模块同一份定义）。 */
const INVALID_APIKEY_CHARS = WECOM_APIKEY_INVALID_CHARS;

/**
 * 能力菜单文本（编号 1-8），给交互式 CLI 打印用。
 * @returns {string[]}
 */
export function capabilityMenuLines() {
  return CAPABILITIES.map(
    (capability, index) =>
      `  ${index + 1}) ${capability.label}（${capability.id}）—— ${capability.summary}（约 ${capability.toolCount} 个工具）`,
  );
}

/**
 * 解析用户选择的能力：既接受菜单编号，也接受能力代号（如 msg）。
 * @param {string} text
 * @returns {(typeof CAPABILITIES)[number] | null}
 */
export function parseCapabilityChoice(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const index = Number.parseInt(raw, 10) - 1;
    return CAPABILITIES[index] ?? null;
  }
  return findCapability(raw);
}

/**
 * 判断输入是否带协议头（形如 https://...）。
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeUrl(text) {
  return URL_LIKE_PATTERN.test(String(text ?? '').trim());
}

/**
 * 校验并返回规范化后的 API Key。
 * @param {string} raw
 * @param {string} [label] 用于错误提示的字段名
 * @returns {string}
 */
export function validateApiKey(raw, label = 'API Key') {
  const value = String(raw ?? '').trim();
  if (!value) throw new ConfigError('MISSING_API_KEY', `${label}不能为空`);
  if (value.length > APIKEY_MAX_LENGTH) {
    throw new ConfigError('INVALID_API_KEY', `${label}过长（最多 ${APIKEY_MAX_LENGTH} 个字符）`);
  }
  if (INVALID_APIKEY_CHARS.test(value)) {
    throw new ConfigError('INVALID_API_KEY', `${label} 格式不正确：仅支持英文字母、数字、- 和 _（base64url）`);
  }
  return value;
}

/**
 * 把用户输入分类为「URL」「API Key」或「空」。
 * 既不是 https URL 也不是合法 API Key 的输入会抛 ConfigError，避免误把打错的 URL 当 Key。
 * @param {string} raw
 * @returns {{kind: 'empty'} | {kind: 'url', text: string} | {kind: 'apikey', value: string}}
 */
export function classifyInput(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { kind: 'empty' };
  if (looksLikeUrl(text)) return { kind: 'url', text };
  if (/[\s/?#]/.test(text)) {
    throw new ConfigError(
      'INVALID_INPUT',
      '输入既不是 https URL（缺少 https:// 协议头），也不是合法的 API Key，请重新输入',
    );
  }
  return { kind: 'apikey', value: validateApiKey(text, 'API Key') };
}

/**
 * 解析官方 MCP URL，识别能力位、是否带 apikey。
 * 只做识别，不做 https / 域名白名单校验（交给共享协议模块的 validateServer）。
 * @param {string} rawUrl
 * @returns {{
 *   url: URL,
 *   officialPath: boolean,
 *   protocolVersion: number | null,
 *   capabilityId: string | null,
 *   capability: (typeof CAPABILITIES)[number] | null,
 *   hasApiKey: boolean,
 * }}
 */
export function inspectMcpUrl(rawUrl) {
  const text = String(rawUrl ?? '').trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigError('INVALID_SERVER_URL', 'MCP URL 格式不正确，请粘贴完整的 https 地址');
  }
  const match = OFFICIAL_PATH_PATTERN.exec(url.pathname);
  const apiKey = url.searchParams.get(APIKEY_PARAM) ?? '';
  return {
    url,
    officialPath: Boolean(match),
    protocolVersion: match ? Number.parseInt(match[1], 10) : null,
    capabilityId: match ? match[2].toLowerCase() : null,
    capability: match ? findCapability(match[2]) : null,
    hasApiKey: Boolean(apiKey),
  };
}

/**
 * 按官方格式组装 MCP URL。
 * @param {string} capabilityId
 * @param {string} apiKey
 * @returns {string}
 */
export function buildMcpUrl(capabilityId, apiKey) {
  const capability = findCapability(capabilityId);
  if (!capability) {
    // 不回显原始输入：用户可能误把 API Key 传给了 --capability
    throw new ConfigError(
      'INVALID_CAPABILITY',
      `未知的能力位（可选：${CAPABILITIES.map((item) => item.id).join(' / ')}），请检查 --capability 取值`,
    );
  }
  const key = validateApiKey(apiKey);
  const url = new URL(`${MCP_PATH_PREFIX}${capability.id}`, MCP_ORIGIN);
  url.searchParams.set(APIKEY_PARAM, key);
  return url.toString();
}

/**
 * 给已有 URL 补上 apikey（仅在 URL 本身缺 apikey 时使用；覆盖已有 apikey 可能会让用户误以为换了 key）。
 * @param {string} rawUrl
 * @param {string} apiKey
 * @returns {string}
 */
export function withApiKey(rawUrl, apiKey) {
  const key = validateApiKey(apiKey);
  const info = inspectMcpUrl(rawUrl);
  info.url.searchParams.set(APIKEY_PARAM, key);
  return info.url.toString();
}

/**
 * 非交互模式：把 CLI 传入的 Server 参数解析成 {name, url} 列表（尚未做协议校验）。
 * @param {Array<{name: string | null, url: string | null, apikey: string | null, capabilityId: string | null}>} specs
 * @returns {Array<{name: string, url: string}>}
 */
export function resolveServerSpecs(specs) {
  return specs.map((spec, index) => {
    const label = `第 ${index + 1} 个 MCP`;
    if (spec.url) {
      let url = spec.url;
      if (spec.apikey) {
        const existing = inspectMcpUrl(url);
        if (existing.hasApiKey) {
          // 静默覆盖会让用户误以为凭据已更换，直接拒绝并给出修法
          throw new ConfigError(
            'INVALID_ARGS',
            `${label}的 URL 已包含 apikey，不要再使用 --apikey 重复提供（如需更换请直接修改 URL 中的 apikey）`,
          );
        }
        url = withApiKey(url, spec.apikey);
      } else {
        const info = inspectMcpUrl(url);
        if (info.officialPath && !info.hasApiKey) {
          throw new ConfigError('MISSING_API_KEY', `${label}的 URL 缺少 apikey，请用 --apikey 提供`);
        }
      }
      const info = inspectMcpUrl(url);
      const name = spec.name || displayNameForCapability(info.capabilityId ?? spec.capabilityId, index);
      return { name, url };
    }
    if (!spec.capabilityId) {
      throw new ConfigError('MISSING_SERVER_URL', `${label}缺少 --url 或 --capability`);
    }
    if (!spec.apikey) {
      // 不回显 capabilityId：它可能来自误传的敏感值
      throw new ConfigError('MISSING_API_KEY', `${label}缺少 --apikey（选择了能力位时必填）`);
    }
    const url = buildMcpUrl(spec.capabilityId, spec.apikey);
    const name = spec.name || displayNameForCapability(spec.capabilityId, index);
    return { name, url };
  });
}
