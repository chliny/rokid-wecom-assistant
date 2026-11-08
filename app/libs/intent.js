// 自然语言 → MCP 工具选择：把 MCP tools 转成 AIUI LanguageModel 的 function tools，
// 并在语言模型不可用时提供确定性的兜底匹配（不依赖任何云端 LLM）。
//
// 纯函数模块：不访问网络、wx、Storage，可在 Node 中直接测试。
import { redactText } from './qr-payload.js';

/** 语言模型函数名长度上限（OpenAI 兼容接口约定 64）。 */
export const MAX_FUNCTION_NAME_LENGTH = 64;

/**
 * 把 MCP 工具转成 `LanguageModel.create({ tools })` 需要的 function tools。
 * @param {Array<{namespacedName: string, name: string, description: string, inputSchema: object, serverName: string}>} tools
 * @returns {Array<{type: 'function', function: {name: string, description: string, parameters: object}}>}
 */
export function toLanguageModelTools(tools) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.namespacedName.slice(0, MAX_FUNCTION_NAME_LENGTH),
      description: buildToolDescription(tool),
      parameters: normalizeInputSchema(tool.inputSchema),
    },
  }));
}

/**
 * 组合出对语言模型友好的工具描述（带 Server 归属，便于模型区分邮件/日程等能力）。
 * @param {{name: string, description: string, serverName: string, title?: string}} tool
 * @returns {string}
 */
export function buildToolDescription(tool) {
  const head = tool.description || tool.title || tool.name;
  const server = tool.serverName ? `（来自「${tool.serverName}」MCP）` : '';
  return `${head}${server}`.slice(0, 512);
}

/**
 * 确保传给模型的 parameters 是合法 JSON Schema object。
 * @param {unknown} schema
 * @returns {object}
 */
export function normalizeInputSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  const record = /** @type {Record<string, any>} */ (schema);
  // 顶层也可能只有 $ref（如 {$ref:'#/$defs/Input'}）：递归解析并合并链上各节点的约束。
  // 引用缺失/循环/约束无法安全合并时必须 fail-closed，绝不能退化成空 schema 放行参数。
  const resolved = resolveLocalRef(record, record);
  if (record.$ref && !resolved) {
    throw new ToolArgumentError('工具 schema 的 $ref 缺失或循环，无法确认参数约束，已拒绝执行');
  }
  const source = resolved && !Array.isArray(resolved) ? { ...record, ...resolved } : record;
  if (source.type !== 'object') return { type: 'object', properties: {} };
  return {
    ...source,
    properties: source.properties && typeof source.properties === 'object' ? source.properties : {},
  };
}

/**
 * 校验并规范化工具参数：
 *   - 必填缺失时抛出可读错误（在真正调用 MCP 之前拦下，避免浪费一次请求）；
 *   - 按 JSON Schema 的 type 做宽松转换（模型常把数字/布尔写成字符串）；
 *   - 丢弃 schema 未声明的字段，避免企业微信侧因额外参数拒绝。
 * @param {object} schema JSON Schema（inputSchema）
 * @param {unknown} rawArgs 模型或兜底逻辑给出的参数
 * @returns {{args: Record<string, unknown>, warnings: string[]}}
 */
export function coerceArguments(schema, rawArgs) {
  const normalized = normalizeInputSchema(schema);
  const properties = /** @type {Record<string, any>} */ (normalized.properties ?? {});
  const required = Array.isArray(normalized.required) ? normalized.required : [];
  const source = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
  /** @type {Record<string, unknown>} */
  const args = {};
  /** @type {string[]} */
  const warnings = [];

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!(key in source)) continue;
    const value = source[key];
    if (value === undefined || value === null || value === '') continue;
    // `$ref` 可能藏在属性/items 内：带值时必须能完整解析，否则不能把未校验的值直接下发。
    assertRefsResolvable(propertySchema, normalized);
    const resolvedProperty = propertySchema?.$ref ? resolveLocalRef(propertySchema, normalized) : propertySchema;
    const coerced = coerceValue(resolvedProperty ?? propertySchema, value);
    if (coerced.ok) {
      args[key] = coerced.value;
    } else {
      warnings.push(`参数 ${key} 无法转换为 ${propertySchema?.type ?? '目标类型'}`);
      args[key] = value;
    }
  }

  for (const key of required) {
    if (args[key] === undefined && source[key] !== undefined && source[key] !== null && source[key] !== '') {
      args[key] = source[key];
    }
    if (args[key] === undefined) {
      const label = properties[key]?.description || key;
      throw new ToolArgumentError(`缺少必填参数：${label}`, { missing: key });
    }
  }

  // schema 未声明属性时（例如空 schema 或 additionalProperties），保留模型给的参数
  if (Object.keys(properties).length === 0) {
    return { args: /** @type {Record<string, unknown>} */ (source), warnings };
  }
  for (const key of Object.keys(source)) {
    if (key in properties) continue;
    if (normalized.additionalProperties === true) args[key] = source[key];
  }
  return { args, warnings };
}

export class ToolArgumentError extends Error {
  /**
   * @param {string} message
   * @param {{missing?: string}} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'ToolArgumentError';
    this.missing = details.missing;
  }
}

/**
 * @param {any} propertySchema
 * @param {unknown} value
 * @returns {{ok: true, value: unknown} | {ok: false}}
 */
function coerceValue(propertySchema, value) {
  const type = propertySchema?.type;
  const enumValues = Array.isArray(propertySchema?.enum) ? propertySchema.enum : null;
  if (enumValues && enumValues.length > 0) {
    const text = typeof value === 'string' ? value : String(value);
    if (enumValues.includes(value)) return { ok: true, value };
    const matched = enumValues.find((candidate) => typeof candidate === 'string' && text.includes(candidate));
    if (matched !== undefined) return { ok: true, value: matched };
    // 单一枚举值（如 msg_type 只有 text）直接取该值，避免把用户整句话当枚举提交
    if (enumValues.length === 1) return { ok: true, value: enumValues[0] };
    return { ok: false };
  }
  switch (type) {
    case 'string':
      return { ok: true, value: typeof value === 'string' ? value : String(value) };
    case 'integer': {
      const parsed = parseNumber(value);
      return Number.isInteger(parsed) ? { ok: true, value: parsed } : { ok: false };
    }
    case 'number': {
      const parsed = parseNumber(value);
      return Number.isFinite(parsed) ? { ok: true, value: parsed } : { ok: false };
    }
    case 'boolean':
      return { ok: true, value: parseBoolean(value) };
    case 'array': {
      if (Array.isArray(value)) return { ok: true, value };
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) return { ok: true, value: parsed };
        } catch {
          return { ok: true, value: value.split(',').map((item) => item.trim()).filter(Boolean) };
        }
      }
      return { ok: false };
    }
    case 'object': {
      if (value && typeof value === 'object' && !Array.isArray(value)) return { ok: true, value };
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          if (parsed && typeof parsed === 'object') return { ok: true, value: parsed };
        } catch {
          return { ok: false };
        }
      }
      return { ok: false };
    }
    default:
      return { ok: true, value };
  }
}

/** @param {unknown} value */
function parseNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value.trim());
  return Number.NaN;
}

/** @param {unknown} value */
function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  return text === 'true' || text === '1' || text === '是' || text === 'yes';
}

// ---------------------------------------------------------------- 兜底匹配

/**
 * 意图词表：中文口语说法 → 工具名里可能出现的英文动词。
 *
 * 中文词用于识别「用户想干什么」，英文动词用于和工具名分段（list / send / delete…）比对。
 * 把中文词与英文动词显式映射，才能让「删除日程」命中 calendar_schedules_cancel 这类
 * 名字里只有 cancel、没有中文的工具。
 */
const INTENT_DEFINITIONS = {
  download: {
    synonyms: ['下载', '下載', '保存到本地'],
    verbs: ['download'],
  },
  list: {
    synonyms: ['查看', '查询', '列出', '有哪些', '看看', '显示', '列表', '看一下'],
    verbs: ['list', 'get', 'search', 'query', 'read', 'fetch', 'find', 'describe'],
  },
  search: {
    synonyms: ['搜索', '查找', '检索', '找一下', '搜一下'],
    verbs: ['search', 'query', 'find', 'get', 'list'],
  },
  send: {
    synonyms: ['发送', '发给', '发消息', '告诉', '转告', '通知', '回复', '转发'],
    verbs: ['send', 'post', 'reply', 'forward'],
  },
  create: {
    synonyms: ['创建', '新建', '添加', '新增', '增加', '安排', '约'],
    verbs: ['create', 'add', 'new', 'insert', 'append', 'submit'],
  },
  delete: {
    synonyms: ['删除', '删掉', '取消', '移除', '去掉'],
    verbs: ['delete', 'remove', 'cancel', 'clear'],
  },
  update: {
    synonyms: ['修改', '更新', '改成', '调整', '编辑'],
    verbs: ['update', 'edit', 'modify', 'set', 'rename'],
  },
};

/**
 * 领域名词 → 工具名英文分段：把「会议/文档/待办/日程…」映射到工具名里的 meeting/doc/todo/calendar，
 * 用于在兜底匹配里区分「说话的对象」属于哪个领域（避免「会议」被匹配成表格导入）。
 */
const ENTITY_DEFINITIONS = {
  doc: { synonyms: ['文档'], segments: ['doc', 'docs'] },
  sheet: { synonyms: ['表格', '工作表'], segments: ['sheet', 'sheets'] },
  smartsheet: { synonyms: ['智能表格'], segments: ['smartsheet', 'smartsheets'] },
  smartpage: { synonyms: ['智能文档', '智能页面', '智能主页'], segments: ['smartpage', 'smartpages'] },
  calendar: { synonyms: ['日程', '日历'], segments: ['calendar', 'schedule', 'schedules'] },
  meeting: { synonyms: ['会议', '开会', '评审'], segments: ['meeting', 'meetings'] },
  todo: { synonyms: ['待办', '任务'], segments: ['todo', 'todos', 'task', 'tasks'] },
  message: { synonyms: ['消息', '会话', '聊天', '群聊', '单聊'], segments: ['message', 'messages', 'msg', 'chat', 'sessions', 'session'] },
  contact: { synonyms: ['联系人', '通讯录', '成员'], segments: ['contact', 'contacts', 'user', 'users', 'member', 'members'] },
  mail: { synonyms: ['邮件', '邮箱'], segments: ['mail', 'mails', 'email', 'emails'] },
  disk: { synonyms: ['微盘', '网盘', '云盘'], segments: ['disk', 'drive', 'file', 'files'] },
};

/** 破坏性动作的英文分段：删除类意图只能落到这些工具上，防止「删除文档」被匹配成别的写操作。 */
const DESTRUCTIVE_SEGMENTS = ['delete', 'remove', 'cancel', 'del', 'clear', 'destroy'];

/** 需要写操作的意图；命中时对只读候选降权（避免「取消会议」选中会议列表）。 */
const WRITE_INTENTS = ['send', 'create', 'delete', 'update'];

/**
 * 识别一句话里的意图（list/search/send/create/delete/update）。
 * @param {string} text
 * @returns {string[]} 命中的意图名
 */
export function detectIntents(text) {
  const normalized = String(text ?? '').toLowerCase();
  return Object.entries(INTENT_DEFINITIONS)
    .filter(([, definition]) => definition.synonyms.some((synonym) => normalized.includes(synonym)))
    .map(([intent]) => intent);
}

/**
 * 识别一句话里出现的领域（doc/sheet/calendar/meeting/todo/message/contact/mail/disk…）。
 * @param {string} text
 * @returns {string[]}
 */
export function detectEntities(text) {
  const normalized = String(text ?? '').toLowerCase();
  return Object.entries(ENTITY_DEFINITIONS)
    .filter(([, definition]) => definition.synonyms.some((synonym) => normalized.includes(synonym)))
    .map(([entity]) => entity);
}

/**
 * 领域命中分：工具名分段命中 +4；仅 title/description 命中 +1。
 * 返回 nameMatched 供破坏性意图做硬过滤（名字对不上领域就不允许执行删除类操作）。
 * @param {string[]} entities
 * @param {{title?: string, description?: string}} tool
 * @param {string[]} nameSegments
 * @returns {{score: number, nameMatched: boolean}}
 */
function scoreEntity(entities, tool, nameSegments) {
  if (entities.length === 0) return { score: 0, nameMatched: false };
  const title = String(tool.title ?? '').toLowerCase();
  const description = String(tool.description ?? '').toLowerCase();
  let score = 0;
  let nameMatched = false;
  for (const entity of entities) {
    const definition = ENTITY_DEFINITIONS[entity];
    if (!definition) continue;
    if (nameSegments.some((segment) => definition.segments.includes(segment))) {
      score += 4;
      nameMatched = true;
    } else if (definition.synonyms.some((synonym) => title.includes(synonym) || description.includes(synonym))) {
      score += 1;
    }
  }
  return { score, nameMatched };
}

/**
 * 提取用于打分的词：英文/数字按词，中文按二元组。
 * @param {string} text
 * @returns {string[]}
 */
export function extractTerms(text) {
  const normalized = String(text ?? '').toLowerCase();
  const terms = new Set();
  for (const word of normalized.match(/[a-z][a-z0-9_]{1,}/g) ?? []) {
    if (word.length >= 2) terms.add(word);
  }
  const cjk = normalized.replace(/[^\u4e00-\u9fa5]/g, ' ');
  for (const segment of cjk.split(/\s+/)) {
    for (let i = 0; i + 1 < segment.length; i += 1) {
      terms.add(segment.slice(i, i + 2));
    }
    if (segment.length >= 2) terms.add(segment);
  }
  return Array.from(terms);
}

/**
 * 工具名分段（message_send → ['message', 'send']）。
 * @param {{name?: string}} tool
 * @returns {string[]}
 */
function toolNameSegments(tool) {
  return String(tool?.name ?? '')
    .toLowerCase()
    .split(/[_.\-]/)
    .filter(Boolean);
}

/**
 * 内容命中分档：命中工具名分词 +3、命中 title +2、仅命中 description +1。
 * @param {string[]} contentTerms
 * @param {{name?: string, title?: string, description?: string}} tool
 * @param {string[]} nameSegments
 * @returns {number}
 */
function scoreContent(contentTerms, tool, nameSegments) {
  const title = String(tool.title ?? '').toLowerCase();
  const description = String(tool.description ?? '').toLowerCase();
  let score = 0;
  for (const term of contentTerms) {
    if (nameSegments.includes(term)) score += 3;
    else if (title.includes(term)) score += 2;
    else if (description.includes(term)) score += 1;
  }
  return score;
}

/**
 * 意图命中：工具名分段命中 +3；仅 title/description 命中中文意图词或英文动词 +1。
 * @param {string[]} intents
 * @param {{name?: string, title?: string, description?: string}} tool
 * @param {string[]} nameSegments
 * @returns {number}
 */
function scoreIntent(intents, tool, nameSegments) {
  const title = String(tool.title ?? '').toLowerCase();
  const description = String(tool.description ?? '').toLowerCase();
  let score = 0;
  for (const intent of intents) {
    const definition = INTENT_DEFINITIONS[intent];
    if (!definition) continue;
    if (nameSegments.some((segment) => definition.verbs.includes(segment))) {
      score += 3;
    } else if (
      definition.verbs.some((verb) => description.includes(verb)) ||
      definition.synonyms.some((synonym) => description.includes(synonym) || title.includes(synonym))
    ) {
      score += 1;
    }
  }
  return score;
}

/**
 * 动作词细化分：用户实际说的动作词（「新建」而不是泛化的「创建」）出现在工具标题/描述里时加分。
 * 用来区分同领域下语义接近的工具，例如「新建文档」应命中 doc_create，而不是 doc_import_submit。
 * @param {string} raw
 * @param {string[]} intents
 * @param {{title?: string, description?: string}} tool
 * @returns {number}
 */
function scoreActionWords(raw, intents, tool) {
  const text = String(raw ?? '');
  const title = String(tool.title ?? '').toLowerCase();
  const description = String(tool.description ?? '').toLowerCase();
  let score = 0;
  for (const intent of intents) {
    const definition = INTENT_DEFINITIONS[intent];
    if (!definition) continue;
    const used = definition.synonyms.filter((synonym) => text.includes(synonym));
    if (used.length === 0) continue;
    if (used.some((synonym) => title.includes(synonym))) score += 2;
    else if (used.some((synonym) => description.includes(synonym))) score += 1;
  }
  return score;
}

/**
 * 可行性试算：仅凭这句话能否推断出工具的全部必填参数。
 *
 * - 全部必填参数可推断：+2（无必填参数也算可直接执行）；
 * - 缺必填参数（ToolArgumentError）：-1，但不淘汰候选——像「删除日程」这种
 *   当场拿不到 ID 的写操作仍应选中正确工具，再由上层提示用户补充；
 * - 必填枚举参数的推断值不在 enum 内且 enum 多于一个：再 -2。这条用于把
 *   message_send（msg_type 只有 text）排到 message_aibot_send（msg_type 枚举不匹配）之前。
 * @param {{inputSchema?: object}} tool
 * @param {string} utterance
 * @returns {{score: number, missingRequired: boolean}}
 */
function scoreFeasibility(tool, utterance, intents = [], nameSegments = []) {
  const schema = normalizeInputSchema(tool.inputSchema);
  const required = Array.isArray(schema.required) ? schema.required : [];
  let score = 0;
  /** @type {Record<string, unknown> | null} */
  let args = null;
  try {
    args = coerceArguments(schema, inferArguments(schema, utterance)).args;
    score += 2;
  } catch (error) {
    if (!(error instanceof ToolArgumentError)) throw error;
    // 正确动作的工具缺 ID 时只说明需要用户补参数，不应因此被「动作不匹配的别的工具」压下去；
    // 动作名命中用户意图时取消负分（仍需上层提示缺参）。这是「删除日程缺 ID」既有规则的细化。
    const actionMatched = intents.some((intent) => {
      const definition = INTENT_DEFINITIONS[intent];
      return definition && definition.verbs.some((verb) => nameSegments.includes(verb));
    });
    if (!actionMatched) score -= 1;
  }
  if (args) {
    for (const key of required) {
      const property = /** @type {Record<string, any>} */ (schema.properties ?? {})[key];
      const enumValues = Array.isArray(property?.enum) ? property.enum : null;
      if (enumValues && enumValues.length > 1 && !enumValues.includes(args[key])) {
        score -= 2;
        break;
      }
    }
  }
  return { score, missingRequired: args === null };
}

/**
 * 候选排序：总分 → 意图分 → 必填参数少 → 工具名分段少 → 名称字典序（保证确定性）。
 * @param {any} candidate
 * @param {any} current
 * @returns {boolean}
 */
function isBetterCandidate(candidate, current) {
  if (!current) return true;
  if (candidate.score !== current.score) return candidate.score > current.score;
  if (candidate.intentScore !== current.intentScore) return candidate.intentScore > current.intentScore;
  if ((candidate.entityScore ?? 0) !== (current.entityScore ?? 0)) {
    return (candidate.entityScore ?? 0) > (current.entityScore ?? 0);
  }
  // 用户说的具体动作词（新建/取消…）比「必填参数更少」更能代表意图
  if ((candidate.actionScore ?? 0) !== (current.actionScore ?? 0)) {
    return (candidate.actionScore ?? 0) > (current.actionScore ?? 0);
  }
  if (candidate.requiredCount !== current.requiredCount) return candidate.requiredCount < current.requiredCount;
  if (candidate.nameSegmentCount !== current.nameSegmentCount) {
    return candidate.nameSegmentCount < current.nameSegmentCount;
  }
  return String(candidate.tool.name) < String(current.tool.name);
}

/**
 * 无语言模型时的确定性工具匹配。
 *
 * 三个独立信号：
 *   - 内容命中（工具名/title/描述与用户说的对象吻合，分档计分）；
 *   - 意图命中（「删除」映射到 delete/cancel 等英文动词，按工具名分段计分）；
 *   - 可行性（必填参数能否凭这句话推断，枚举能否落地）。
 * 必须有内容命中，避免「查看未完成的待办」误命中会话列表这类只看动词的匹配。
 * @param {string} utterance
 * @param {Array<{namespacedName: string, name: string, description?: string, title?: string, serverName?: string, inputSchema?: object}>} tools
 * @param {{threshold?: number}} [options]
 * @returns {{tool: object, score: number, contentScore: number, intentScore: number, requiredCount: number} | null}
 */
export function matchToolByText(utterance, tools, options = {}) {
  const threshold = options.threshold ?? 2;
  const raw = String(utterance ?? '');
  const intents = detectIntents(raw);
  const entities = detectEntities(raw);
  const writeIntent = intents.some((intent) => WRITE_INTENTS.includes(intent));
  const destructiveIntent = intents.includes('delete');
  // 内容词先去掉「帮我查一下」「删除」这类指令词：意图已经单独计分，
  // 否则「删除刚才那个日程」会因为命中「删除」二字而偏向所有含删除的工具。
  const stripped = stripCommandWords(raw);
  let contentTerms = extractTerms(stripped);
  if (contentTerms.length === 0) contentTerms = extractTerms(raw);
  if ((contentTerms.length === 0 && intents.length === 0) || tools.length === 0) return null;

  let best = null;
  for (const tool of tools) {
    const nameSegments = toolNameSegments(tool);
    const contentScore = scoreContent(contentTerms, tool, nameSegments);
    // 必须有内容命中：只靠动词（「查看」「删除」）不足以确定要操作的对象。
    // 例外：用户明确说「下载」且工具名本身就是下载动作（URL 不是内容词，不能因此丢候选）。
    const downloadActionName = intents.includes('download')
      && nameSegments.includes('download');
    if (contentScore < 1 && !downloadActionName) continue;

    const entity = scoreEntity(entities, tool, nameSegments);

    // 破坏性意图的安全约束：
    //   1) 用户已经说清领域（文档/表格/日程…）时，工具名必须落在该领域，绝不跨领域删除；
    //   2) 只允许落到名字里带 delete/remove/cancel 的工具，避免「删除文档」被匹配成覆盖/导入。
    // 两道都过不了就返回 null，让上层提示「没有对应能力」，而不是转去别的写工具。
    if (destructiveIntent && entities.length > 0 && !entity.nameMatched) continue;
    if (destructiveIntent && !nameSegments.some((segment) => DESTRUCTIVE_SEGMENTS.includes(segment))) continue;

    // 写意图对只读工具降权、对写工具略微加权：避免「取消明天的会议」选中 meeting_list。
    let writeAlignment = 0;
    if (writeIntent) {
      if (tool.write === false) writeAlignment = -3;
      else if (tool.write === true) writeAlignment = 1;
    }

    const intentScore = scoreIntent(intents, tool, nameSegments);
    // 一句话里出现多个动作时（如「查询下载任务」= list + download），
    // 工具名同时命中多个动作的候选更具体，优先于只命中一个动作的候选。
    const matchedIntentCount = intents.filter((intent) => {
      const definition = INTENT_DEFINITIONS[intent];
      return definition && definition.verbs.some((verb) => nameSegments.includes(verb));
    }).length;
    const multiIntentScore = Math.max(0, matchedIntentCount - 1) * 2;
    const actionScore = scoreActionWords(raw, intents, tool);
    const feasibility = scoreFeasibility(tool, raw, intents, nameSegments);
    const candidate = {
      tool,
      score: contentScore + intentScore + entity.score + actionScore + feasibility.score + writeAlignment + multiIntentScore,
      contentScore,
      intentScore,
      multiIntentScore,
      entityScore: entity.score,
      actionScore,
      requiredCount: Array.isArray(normalizeInputSchema(tool.inputSchema).required)
        ? normalizeInputSchema(tool.inputSchema).required.length
        : 0,
      nameSegmentCount: nameSegments.length,
    };
    if (isBetterCandidate(candidate, best)) best = candidate;
  }
  if (!best || best.score < threshold) return null;
  return best;
}

/** 解码 RFC 6901 JSON Pointer 分段（含百分号编码与 ~0/~1 转义）。 */
function decodePointerSegment(segment) {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // 非法百分号编码按原文处理
  }
  // RFC 6901：先 ~1 -> /，再 ~0 -> ~
  return decoded.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolveJsonPointer(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  let node = root;
  for (const rawPart of ref.slice(2).split('/')) {
    const part = decodePointerSegment(rawPart);
    if (!node || typeof node !== 'object' || !(part in node)) return null;
    node = node[part];
  }
  return node && typeof node === 'object' ? node : null;
}

function isPlainSchemaObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 稳定序列化：用于判断两个 schema 片段是否完全相同（属性顺序不影响）。 */
function stableSchemaJson(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSchemaJson).join(',')}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSchemaJson(value[key])}`)
    .join(',')}}`;
}

/**
 * 合并 `$ref` 链上相邻节点的约束。
 *
 * 只做可证明等价的合并：required 取并集；properties/$defs 等同名子 schema 递归合并；
 * 其它字段相同或仅一侧存在才保留。任何可能丢失/改变约束的冲突一律返回 null，
 * 由调用方 fail-closed，而不是悄悄丢掉中间节点的 required/限制。
 * @param {Record<string, any>} left
 * @param {Record<string, any>} right
 * @returns {Record<string, any> | null}
 */
function mergeSchemaObjects(left, right) {
  const merged = { ...left };
  for (const key of Object.keys(right)) {
    const next = right[key];
    if (!(key in merged)) {
      merged[key] = next;
      continue;
    }
    const current = merged[key];
    if (stableSchemaJson(current) === stableSchemaJson(next)) continue;
    if (key === 'required') {
      if (!Array.isArray(current) || !Array.isArray(next)) return null;
      merged[key] = [...new Set([...current, ...next])];
      continue;
    }
    if (key === 'properties' || key === 'patternProperties' || key === '$defs' || key === 'definitions') {
      if (!isPlainSchemaObject(current) || !isPlainSchemaObject(next)) return null;
      const map = { ...current };
      for (const name of Object.keys(next)) {
        if (!(name in map)) {
          map[name] = next[name];
          continue;
        }
        if (!isPlainSchemaObject(map[name]) || !isPlainSchemaObject(next[name])) return null;
        const child = mergeSchemaObjects(map[name], next[name]);
        if (!child) return null;
        map[name] = child;
      }
      merged[key] = map;
      continue;
    }
    if (key === 'items' || key === 'additionalProperties') {
      if (isPlainSchemaObject(current) && isPlainSchemaObject(next)) {
        const child = mergeSchemaObjects(current, next);
        if (!child) return null;
        merged[key] = child;
        continue;
      }
      return null;
    }
    // 标题/描述等纯展示信息可以任选一侧，不影响参数约束。
    if (key === 'description' || key === 'title' || key === '$comment' || key === 'default' || key === 'examples') {
      continue;
    }
    return null;
  }
  return merged;
}

/**
 * 递归解析本地 `$ref`（支持多跳、JSON Pointer ~0/~1 转义），并合并链上各节点的约束。
 * 例如 A={$ref:B,required:['recipient']}、B={$ref:C,...} 时 A/B/C 的 required 取并集。
 * 循环、引用缺失或约束冲突返回 null，调用方必须 fail-closed（不猜类型、不丢必填约束）。
 * @param {any} schema
 * @param {any} root
 * @returns {any | null}
 */
function resolveLocalRef(schema, root) {
  if (!isPlainSchemaObject(schema)) return null;
  const seen = new Set();
  /** @type {Array<Record<string, any>>} */
  const siblingLayers = [];
  let current = schema;
  while (isPlainSchemaObject(current) && typeof current.$ref === 'string') {
    const ref = current.$ref;
    if (seen.has(ref)) return null;
    seen.add(ref);
    const target = resolveJsonPointer(root, ref);
    if (!target) return null;
    const { $ref, ...siblings } = current;
    siblingLayers.push(siblings);
    current = target;
  }
  if (!isPlainSchemaObject(current)) return null;
  let merged = { ...current };
  for (const layer of siblingLayers) {
    const next = mergeSchemaObjects(merged, layer);
    if (!next) return null;
    merged = next;
  }
  return merged;
}

/**
 * 递归确认 schema 中所有 `$ref` 都能解析（缺失/循环/冲突一律拒绝）。
 * 用于参数真正带值时：即使引用藏在 properties/items 内部，也不允许把它当无类型值放行。
 * @param {any} node
 * @param {any} root
 * @param {Set<any>} [seen]
 */
function assertRefsResolvable(node, root, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (typeof node.$ref === 'string' && !resolveLocalRef(node, root)) {
    throw new ToolArgumentError('工具 schema 的 $ref 缺失、循环或约束冲突，无法确认参数约束，已拒绝执行');
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) assertRefsResolvable(item, root, seen);
    } else if (value && typeof value === 'object') {
      assertRefsResolvable(value, root, seen);
    }
  }
}

/**
 * 「新建一个待办：买牛奶」这类带冒号的句子，冒号后才是用户真正要创建的内容。
 * @param {string} text
 * @returns {string}
 */
function extractTitleText(text) {
  const stripped = stripCommandWords(text);
  const colon = stripped.match(/[:：]\s*(.+)$/);
  return (colon ? colon[1] : stripped).trim();
}

export function inferArguments(schema, utterance) {
  const normalized = normalizeInputSchema(schema);
  const properties = /** @type {Record<string, any>} */ (normalized.properties ?? {});
  const required = Array.isArray(normalized.required) ? normalized.required : Object.keys(properties);
  // 必填参数必须推断；消息正文这类可选但关键的参数也一并推断，否则会发出空消息
  const keys = new Set(required);
  for (const key of Object.keys(properties)) {
    if (/^(text|content|message|body|msg)$/i.test(key)) keys.add(key);
    // 下载/查询类工具的 file_id/url/media_id 往往是可选 schema，但用户明确说出时也要能带进参数
    if (/^(file_id|url|download_url|media_id|taskid)$/i.test(key)) keys.add(key);
  }
  /** @type {Record<string, unknown>} */
  const args = {};
  const text = String(utterance ?? '').trim();
  const numberMatch = text.match(/-?\d+(?:\.\d+)?/);
  const urlMatch = text.match(/https?:\/\/[^\s，,。；;]+/i);
  // 文件 ID 必须有明确标识，不能把 URL 里的 https / 正文里的英文 token 当文件 ID
  const explicitFileIdMatch = text.match(/(?:file_id|fileid|文件\s*id)\s*[:：=]?\s*([A-Za-z0-9_-]{2,})/i);
  const explicitTaskIdMatch = text.match(/(?:taskid|task_id|任务\s*id)\s*[:：=]?\s*([A-Za-z0-9_-]{2,})/i);
  // 收件人只从「给/对/和/向 + 名字 + 发/说…」的上下文中提取；
  // 不能拿整句第一个英文 token 当 chat_id，否则「给张三发送消息，内容是 hello」会变成 chat_id=hello。
  const chatMatch = text.match(/(?:给|对|和|向)([^\s，,。；;]{1,20}?)(?:发|说|通知|留言)/);
  const recipientIdMatch = text.match(
    /(?:chat_id|userid|user_id|会话\s*ID|群\s*ID|用户\s*ID|成员\s*ID|会话|群聊|群|用户|成员)\s*[:：=]?\s*([A-Za-z][A-Za-z0-9_-]{2,})/i,
  );
  // 企业微信的 chat_id / event_id / docid 都是长标识串，只在用户明确念出时才使用，
  // 避免把「日程」这种中文词当成 ID 提交给服务端。
  const idTokenMatch = text.match(/[A-Za-z][A-Za-z0-9_-]{2,}/);

  for (const key of keys) {
    const property = properties[key] ?? {};
    // 标准 JSON Schema 常把对象/数组写成只有 $ref（没有 type）：
    // 必须先递归解析引用再决定类型；引用缺失/循环时直接跳过该参数（required 会在 coerce 阶段安全拒绝）。
    const resolvedProperty = resolveLocalRef(property, normalized);
    if (property.$ref && !resolvedProperty) continue;
    const propertySchema = resolvedProperty ?? property;
    const type = propertySchema.type
      ?? (propertySchema.properties ? 'object' : propertySchema.items ? 'array' : 'string');
    if (type === 'integer' || type === 'number') {
      if (numberMatch) args[key] = Number(numberMatch[0]);
      continue;
    }
    if (type === 'boolean') {
      continue;
    }
    if (type === 'array') {
      // items 也可能是 $ref；先递归解析再判断数组元素是字符串还是对象。
      const resolvedItems = resolveLocalRef(propertySchema.items, normalized);
      if (propertySchema.items?.$ref && !resolvedItems) continue;
      const itemsSchema = resolvedItems ?? propertySchema.items ?? {};
      if (Array.isArray(itemsSchema)) continue; // 元组 schema 不猜，保持 safe
      const itemType = itemsSchema.type ?? (itemsSchema.properties ? 'object' : undefined);
      if (itemType === 'string' || itemType === undefined) {
        const content = stripCommandWords(text);
        args[key] = content
          .split(/[\s，,、]+/)
          .map((item) => item.trim())
          .filter(Boolean);
      } else if (itemType === 'object') {
        // 企业微信批量写接口是「数组套对象」（如 todo_create 的 items:[{title}]）：
        // 至少按内部 required 生成一条，否则确认页会显示「无参数」并把空 items 发出去。
        const itemSchema = itemsSchema;
        const itemProperties = itemSchema.properties ?? {};
        const itemRequired = Array.isArray(itemSchema.required) ? itemSchema.required : Object.keys(itemProperties);
        /** @type {Record<string, unknown>} */
        const item = {};
        for (const itemKey of itemRequired) {
          if (/title|name|subject|标题|名称/i.test(itemKey)) item[itemKey] = extractTitleText(text);
          else if (/content|text|message|body|描述|正文/i.test(itemKey)) item[itemKey] = extractMessageBody(text);
          else if (/time|date|deadline|时间|日期/i.test(itemKey)) item[itemKey] = stripCommandWords(text);
        }
        if (Object.keys(item).length > 0) args[key] = [item];
      }
      continue;
    }
    if (type === 'object') {
      // 消息正文等对象参数常写成 {$ref: '#/$defs/TextContent'}：必须解析 $ref 后
      // 按内部 required 推断（否则 text 会整个丢失，消息发出去是空的）。
      const objectSchema = propertySchema;
      const nested = objectSchema.properties ?? {};
      const nestedRequired = Array.isArray(objectSchema.required) ? objectSchema.required : Object.keys(nested);
      /** @type {Record<string, unknown>} */
      const value = {};
      for (const nestedKey of nestedRequired) {
        if (/content|text|message|body|正文|内容/i.test(nestedKey)) {
          value[nestedKey] = extractMessageBody(text);
        }
      }
      if (Object.keys(value).length > 0) args[key] = value;
      continue;
    }
    if (/chat|user|recipient|receiver|联系人|收件人/i.test(key)) {
      // 只从收件人上下文取，绝不用正文里的英文 token 污染 chat_id
      if (chatMatch) args[key] = chatMatch[1];
      else if (recipientIdMatch) args[key] = recipientIdMatch[1];
      continue;
    }
    if (/url$/i.test(key)) {
      if (urlMatch) args[key] = urlMatch[0];
      continue;
    }
    if (/^file_id$/i.test(key)) {
      if (explicitFileIdMatch) args[key] = explicitFileIdMatch[1];
      continue;
    }
    if (/^taskid$/i.test(key)) {
      if (explicitTaskIdMatch) args[key] = explicitTaskIdMatch[1];
      continue;
    }
    if (/(?:_id|Id|ID)$/.test(key)) {
      if (idTokenMatch) args[key] = idTokenMatch[0];
      continue;
    }
    if (/keyword|query|q$|search|内容|关键词/i.test(key)) {
      args[key] = stripCommandWords(text);
      continue;
    }
    if (/text|content|message|body|msg|消息|正文/i.test(key)) {
      args[key] = extractMessageBody(text);
      continue;
    }
    if (/title|name|subject|标题|名称/i.test(key)) {
      args[key] = extractTitleText(text);
      continue;
    }
    args[key] = stripCommandWords(text);
  }
  return args;
}

/**
 * 从「给张三发送消息，内容是明天下午三点开会」里抽出消息正文。
 * @param {string} text
 * @returns {string}
 */
export function extractMessageBody(text) {
  const raw = String(text ?? '').trim();
  const explicit = raw.match(/(?:内容|正文|说一句|告诉他|告诉她)\s*(?:是|为)?\s*[:：]?\s*(.+)$/);
  if (explicit) return explicit[1].trim();
  // 「发送消息说会议取消了」：动词后可能还跟着「消息」，并且再跟一个「说/告诉」，
  // 都要跳过，否则正文会变成「消息说会议取消了」。
  const afterVerb = raw.match(/(?:发送|发给|通知|告诉|说)(?:消息)?\s*[:：]?\s*(.+)$/);
  if (afterVerb) {
    const body = afterVerb[1]
      .replace(/^(?:一下|下|消息|说|告诉|通知|发送|发给)\s*[:：]?\s*/, '')
      .trim();
    return body || afterVerb[1].trim();
  }
  return stripCommandWords(raw);
}

const COMMAND_PREFIX = /^(请|帮我|麻烦|给我|帮忙|我想|我要|能不能|可以|再)?\s*(查询|查看|列出|看看|搜索|查找|下载|发送|发给|删除|删掉|取消|创建|新建|添加|修改|更新|安排|通知|告诉)?\s*(一下)?\s*/;

/**
 * 去掉「帮我查一下」这类指令词，让兜底参数更接近真实内容。
 * @param {string} text
 * @returns {string}
 */
export function stripCommandWords(text) {
  let result = String(text ?? '').trim();
  for (let i = 0; i < 2; i += 1) {
    const next = result.replace(COMMAND_PREFIX, '').trim();
    if (next === result) break;
    result = next;
  }
  return result || String(text ?? '').trim();
}

/**
 * 生成写操作的用户确认文案：让人一眼看懂「要做什么」，避免误发消息。
 * @param {{serverName: string, name: string, title?: string, description?: string}} tool
 * @param {Record<string, unknown>} args
 * @param {{maskText?: (value: string) => string}} [options]
 * @returns {{title: string, detail: string}}
 */
export function describeToolAction(tool, args, options = {}) {
  // 默认对参数值做密钥脱敏（apikey/token…），再由调用方按需覆盖。
  const mask = options.maskText ?? redactText;
  const label = tool.title || tool.description || tool.name;
  const fullTitle = `${tool.serverName}：${label}`;
  // 标题过长时显式加「…」，不做隐形截断；参数详情一律完整展示（写操作确认页可滚动）。
  const title = fullTitle.length > 40 ? `${fullTitle.slice(0, 39)}…` : fullTitle;
  const parts = [];
  for (const [key, value] of Object.entries(args ?? {})) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    parts.push(`${key}=${mask(String(text))}`);
  }
  return { title, detail: parts.join('\n') || '无参数' };
}
