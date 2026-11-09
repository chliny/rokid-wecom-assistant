// 企业微信官方远程 MCP 的共享约定：能力位、官方 URL 形态、API Key 规则。
//
// 这个模块被两端同时使用：
//   - 终端工具（tools/lib/wecom.mjs）：能力位菜单、默认名称、URL 组装；
//   - 眼镜端（app/libs/qr-payload.js）：紧凑配置二维码里只有能力位 + key 片段，
//     还原完整 URL 与默认名称时必须用同一份定义。
// 名称/能力位只在这里维护一份，避免两端漂移导致扫码后名字或地址对不上。
//
// 纯 JavaScript：不依赖 Node、wx 或 npm 包。
//
// 官方 URL 形态（实测）：
//   https://qyapi.weixin.qq.com/mcp/v2/bot/<capability>?apikey=<KEY>
// 鉴权只支持 query 参数 apikey（没有 Bearer / OAuth），每个能力位分别配置凭据。

export const WECOM_MCP_ORIGIN = 'https://qyapi.weixin.qq.com';
export const WECOM_MCP_PATH_PREFIX = '/mcp/v2/bot/';
export const WECOM_APIKEY_PARAM = 'apikey';
export const WECOM_APIKEY_MAX_LENGTH = 512;
/** v4 二维码只支持 base64url 字符，CLI 与编码器使用相同规则。 */
export const WECOM_APIKEY_INVALID_CHARS = /[^A-Za-z0-9_-]/;

/**
 * 官方实测存在的 8 个能力位（一个能力位 = 一条独立授权的 URL）。
 * toolCount 来自 tools/list 实测，仅用于终端菜单提示。
 */
export const CAPABILITIES = Object.freeze([
  { id: 'msg', label: '消息', name: '企业微信消息', toolCount: 6, summary: '会话列表、收发消息' },
  { id: 'doc', label: '文档', name: '企业微信文档', toolCount: 63, summary: '文档 / 表格 / 智能表格 / 智能文档' },
  { id: 'schedule', label: '日程', name: '企业微信日程', toolCount: 9, summary: '日程与会议室查询' },
  { id: 'todo', label: '待办', name: '企业微信待办', toolCount: 6, summary: '待办事项读写' },
  { id: 'meeting', label: '会议', name: '企业微信会议', toolCount: 10, summary: '会议、会议室与转写原文' },
  { id: 'contact', label: '通讯录', name: '企业微信通讯录', toolCount: 1, summary: '成员搜索' },
  { id: 'mail', label: '邮件', name: '企业微信邮件', toolCount: 5, summary: '邮件读写' },
  { id: 'disk', label: '微盘', name: '企业微信微盘', toolCount: 10, summary: '微盘文件与文件夹' },
]);

/**
 * 按能力代号查找能力定义。
 * @param {string} capabilityId
 * @returns {(typeof CAPABILITIES)[number] | null}
 */
export function findCapability(capabilityId) {
  const id = String(capabilityId ?? '').trim().toLowerCase();
  return CAPABILITIES.find((capability) => capability.id === id) ?? null;
}

/**
 * 按能力位给出默认 MCP 名称（与官方 JSON Config 的命名习惯一致）。
 * @param {string | null} capabilityId
 * @param {number} [index] 未知能力位时的兜底序号（从 0 开始）
 * @returns {string}
 */
export function displayNameForCapability(capabilityId, index = 0) {
  const capability = findCapability(capabilityId);
  if (capability) return capability.name;
  return index > 0 ? `企业微信 MCP ${index + 1}` : '企业微信 MCP';
}
