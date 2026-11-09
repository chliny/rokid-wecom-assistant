// 工具结果 → 眼镜小屏可读文本 / 语音可播报文本。
//
// 企业微信 MCP 多数工具返回 JSON（会话列表、日程、文档…），直接打印 JSON 在
// 448×352 的屏幕上几乎不可读，因此这里做一层稳定的结构化摘要：
//   - 识别数组 / 含数组字段的对象，抽取每项最像「标题」的字段；
//   - 识别纯标量对象，输出 k=v；
//   - 任何无法识别的结构都退回原始文本截断。
// 纯函数，无运行时依赖。

/** 摘要中优先展示的字段名（按优先级），覆盖企业微信常见返回。 */
const TITLE_KEYS = [
  'title',
  'summary',
  'name',
  'subject',
  'text',
  'content',
  'display_name',
  'nickname',
  'user_name',
  'chat_name',
  'doc_name',
  'keyword',
  'id',
  'chat_id',
  'docid',
  'event_id',
];

const TIME_KEYS = ['start', 'start_time', 'begin_time', 'time', 'date', 'create_time', 'update_time', 'end', 'end_time'];

/** 最多展示的条目数（小屏 + 语音都受长度限制）。 */
export const MAX_LIST_ITEMS = 5;

/**
 * 尝试解析可能为 JSON 的文本。
 * @param {string} text
 * @returns {unknown}
 */
export function tryParseJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return undefined;
  if (!(raw.startsWith('{') || raw.startsWith('['))) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * @param {Record<string, unknown>} item
 * @returns {string}
 */
function itemTitle(item) {
  if (item === null || typeof item !== 'object') return String(item);
  const record = /** @type {Record<string, unknown>} */ (item);
  const parts = [];
  for (const key of TITLE_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      parts.push(value.trim());
      break;
    }
    if (typeof value === 'number') {
      parts.push(String(value));
      break;
    }
  }
  for (const key of TIME_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      parts.push(value.trim());
      break;
    }
  }
  if (parts.length === 0) {
    const keys = Object.keys(record).slice(0, 3);
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' || typeof value === 'number') parts.push(String(value));
    }
  }
  return parts.join(' ');
}

/**
 * 在对象里找「最像列表」的数组字段。
 * @param {Record<string, unknown>} record
 * @returns {{key: string, items: unknown[]} | null}
 */
function findListField(record) {
  const preferred = ['items', 'list', 'data', 'events', 'chats', 'docs', 'todos', 'results', 'records'];
  for (const key of preferred) {
    if (Array.isArray(record[key])) return { key, items: /** @type {unknown[]} */ (record[key]) };
  }
  for (const [key, value] of Object.entries(record)) {
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
      return { key, items: /** @type {unknown[]} */ (value) };
    }
  }
  return null;
}

/**
 * 结构化摘要：把工具返回的 JSON 变成「3 条 → 摘要」这种可读文本。
 * @param {unknown} data 已解析的 JSON
 * @param {{maxItems?: number}} [options]
 * @returns {string}
 */
export function summarizeStructured(data, options = {}) {
  const maxItems = options.maxItems ?? MAX_LIST_ITEMS;
  if (data === null || data === undefined) return '';
  if (Array.isArray(data)) return summarizeList(data, maxItems);
  if (typeof data !== 'object') return String(data);

  const record = /** @type {Record<string, unknown>} */ (data);
  const list = findListField(record);
  if (list) {
    const head = summarizeList(list.items, maxItems);
    const hasError = typeof record.errcode === 'number' && record.errcode !== 0;
    const prefix = hasError ? `错误 ${record.errcode}：` : '';
    return `${prefix}${head}`;
  }

  if (typeof record.errcode === 'number' && record.errcode !== 0) {
    return `错误 ${record.errcode}：${String(record.errmsg ?? '')}`.trim();
  }
  const scalars = Object.entries(record)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 6)
    .map(([key, value]) => `${key}=${value}`);
  if (scalars.length > 0) return scalars.join('，');
  return '';
}

/**
 * @param {unknown[]} items
 * @param {number} maxItems
 * @returns {string}
 */
function summarizeList(items, maxItems) {
  if (items.length === 0) return '没有结果';
  const shown = items.slice(0, maxItems).map((item, index) => `${index + 1}. ${itemTitle(item)}`);
  const rest = items.length - shown.length;
  return `${shown.join('；')}${rest > 0 ? `；等共 ${items.length} 条` : ''}`;
}

/**
 * 把工具结果格式化为眼镜端展示文本。
 * @param {{ok: boolean, text: string, dataText?: string}} result
 * @param {{maxChars?: number, serverName?: string, toolLabel?: string}} [options]
 * @returns {string}
 */
export function formatForGlasses(result, options = {}) {
  const maxChars = options.maxChars ?? 320;
  const header = [options.serverName, options.toolLabel].filter(Boolean).join(' · ');
  const body = result.ok === false ? `失败：${result.text}` : result.text;
  let summary = '';
  if (result.ok !== false) {
    const parsed = tryParseJson(result.dataText ?? result.text);
    if (parsed !== undefined) summary = summarizeStructured(parsed);
  }
  const content = summary || body || '（无返回内容）';
  const text = header ? `${header}\n${content}` : content;
  return truncate(text, maxChars);
}

/**
 * 按字符截断并补省略号（不切断代理对）。
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
export function truncate(text, maxChars) {
  const chars = Array.from(String(text ?? ''));
  if (chars.length <= maxChars) return chars.join('');
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}…`;
}

/**
 * 语音播报文本：去掉换行与多余空白，控制长度，避免眼镜播报过长。
 * @param {string} text
 * @param {{maxChars?: number}} [options]
 * @returns {string}
 */
export function toSpeechText(text, options = {}) {
  const maxChars = options.maxChars ?? 120;
  const cleaned = String(text ?? '')
    .replace(/\n+/g, '，')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[，。\s]+/, '')
    .trim();
  return truncate(cleaned, maxChars);
}

/**
 * 生成错误提示（统一「发生了什么 + 下一步做什么」）。
 * @param {{code?: string, message?: string, needRescan?: boolean}} error
 * @returns {string}
 */
export function formatError(error) {
  const message = error?.message || '操作失败';
  if (error?.needRescan) return `${message}\n请按确认键重新扫码授权`;
  if (error?.code === 'TIMEOUT') return `${message}\n请稍后重试（弱网可先连接 Wi-Fi）`;
  return message;
}
