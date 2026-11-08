// MCP SDK v2 客户端封装：直接连接企业微信官方远程 MCP（Streamable HTTP），
// 负责多 Server 管理、工具发现、工具调用、超时、会话失效重连与错误归类。
//
// 运行环境：AIUI 页面（有 fetch / ReadableStream / TextDecoder / AbortController）。
// 不依赖 Node.js，也不使用自建 MCP Server / Bridge。
import {
  Client,
  StreamableHTTPClientTransport,
  SdkError,
  SdkHttpError,
  UnauthorizedError,
} from './mcp-client.js';
import { maskUrl } from './qr-payload.js';
import { silentLogger } from './log.js';

export const CLIENT_INFO = { name: 'rokid-wecom-assistant', version: '1.0.0' };
export const DEFAULT_CONNECT_TIMEOUT_MS = 20000;
export const DEFAULT_CALL_TIMEOUT_MS = 30000;

/** 面向用户的 MCP 错误类别。 */
export const McpErrorCode = {
  NETWORK: 'NETWORK',
  TIMEOUT: 'TIMEOUT',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SERVER: 'SERVER',
  TOOL: 'TOOL',
  PROTOCOL: 'PROTOCOL',
  UNKNOWN: 'UNKNOWN',
};

export class McpError extends Error {
  /**
   * @param {string} code
   * @param {string} message 面向用户的中文提示（已脱敏）
   * @param {{serverName?: string, retryable?: boolean, needRescan?: boolean, cause?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.serverName = options.serverName ?? '';
    this.retryable = options.retryable === true;
    this.needRescan = options.needRescan === true;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * 把 SDK / 网络异常归类成产品可处理的错误。
 * @param {unknown} error
 * @param {{serverName?: string}} [context]
 * @returns {McpError}
 */
export function classifyError(error, context = {}) {
  const serverName = context.serverName ?? '';
  if (error instanceof McpError) {
    if (!error.serverName && serverName) error.serverName = serverName;
    return error;
  }

  const base = { serverName };

  if (error instanceof UnauthorizedError) {
    return new McpError(McpErrorCode.UNAUTHORIZED, `${serverName}授权已失效，请重新扫码授权`, {
      ...base,
      needRescan: true,
    });
  }

  const status = getHttpStatus(error);
  if (status === 401) {
    return new McpError(McpErrorCode.UNAUTHORIZED, `${serverName}授权已失效（401），请重新扫码授权`, {
      ...base,
      needRescan: true,
    });
  }
  if (status === 403) {
    // 403 是能力位/子能力未授权：去企业微信后台补授权即可，重新扫码不会改变结果
    return new McpError(
      McpErrorCode.FORBIDDEN,
      `${serverName}没有权限访问该能力（403），请在智能机器人「可使用权限」中补授权后重试`,
      { ...base },
    );
  }
  if (status === 404) {
    return new McpError(McpErrorCode.SESSION_EXPIRED, `${serverName}的 MCP 地址或会话已失效（404）`, {
      ...base,
      retryable: true,
      needRescan: true,
    });
  }
  if (status === 429) {
    return new McpError(McpErrorCode.SERVER, `${serverName}请求过于频繁（429），请稍后再试`, {
      ...base,
      retryable: true,
    });
  }
  if (typeof status === 'number' && status >= 500) {
    return new McpError(McpErrorCode.SERVER, `${serverName}服务暂时不可用（${status}）`, {
      ...base,
      retryable: true,
    });
  }

  if (error instanceof SdkError) {
    if (error.code === 'REQUEST_TIMEOUT') {
      return new McpError(McpErrorCode.TIMEOUT, `${serverName || 'MCP'}响应超时，请重试`, {
        ...base,
        retryable: true,
        cause: error,
      });
    }
    if (error.code === 'NOT_CONNECTED' || error.code === 'CONNECTION_CLOSED') {
      return new McpError(McpErrorCode.NETWORK, `${serverName}连接已断开，正在尝试重连`, {
        ...base,
        retryable: true,
        cause: error,
      });
    }
    return new McpError(McpErrorCode.PROTOCOL, `${serverName}协议错误：${error.message}`, {
      ...base,
      cause: error,
    });
  }

  const name = error && typeof error === 'object' ? String(error.name || '') : '';
  const message = error && typeof error === 'object' ? String(error.message || '') : String(error ?? '');
  if (name === 'AbortError') {
    return new McpError(McpErrorCode.TIMEOUT, `${serverName}操作已取消`, { ...base, retryable: true, cause: error });
  }
  if (name === 'TypeError' || /network|fetch|failed to fetch|load failed/i.test(message)) {
    return new McpError(McpErrorCode.NETWORK, `${serverName}网络请求失败，请检查网络后重试`, {
      ...base,
      retryable: true,
      cause: error,
    });
  }
  return new McpError(McpErrorCode.UNKNOWN, `${serverName}${message || 'MCP 调用失败'}`, { ...base, cause: error });
}

/**
 * 从 SDK 错误里取出 HTTP 状态码（SdkHttpError 在不同版本上字段位置不同）。
 * @param {unknown} error
 * @returns {number | undefined}
 */
function getHttpStatus(error) {
  if (!error || typeof error !== 'object') return undefined;
  const record = /** @type {Record<string, any>} */ (error);
  if (typeof record.status === 'number') return record.status;
  if (typeof record.statusCode === 'number') return record.statusCode;
  if (record.data && typeof record.data.status === 'number') return record.data.status;
  return undefined;
}

/**
 * 把 MCP Tool 名称转成语言模型可用的函数名（`[a-zA-Z0-9_-]`，长度 ≤ 64）。
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeToolName(raw) {
  const cleaned = String(raw ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
  return (cleaned || 'tool').slice(0, 48);
}

/**
 * 规范化 JSON：对象键排序、丢弃 undefined。schema/annotations 用**完整字符串精确相等**
 * 比较，不做短哈希（32 位非加密哈希可被构造碰撞，不能用于安全校验）。
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = /** @type {Record<string, unknown>} */ (value);
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/** 工具 inputSchema 的规范化完整字符串（用于精确比较，不是指纹/哈希）。 */
function canonicalSchemaOf(tool) {
  return canonicalJson(tool?.inputSchema ?? { type: 'object', properties: {} });
}

/** 工具 annotations（含 readOnlyHint/destructiveHint）的规范化完整字符串。 */
function canonicalAnnotationsOf(tool) {
  return canonicalJson(tool?.annotations ?? {});
}

/** 写操作动词（按工具名分词匹配，如 message_send / todo_create）。 */
const WRITE_VERBS = new Set([
  'send', 'create', 'delete', 'update', 'cancel', 'remove', 'add', 'edit', 'modify',
  'set', 'upload', 'post', 'reply', 'forward', 'share', 'append', 'overwrite',
  'finish', 'rename', 'move', 'copy', 'import', 'insert', 'submit', 'approve',
  'reject', 'grant', 'invite', 'mark', 'clear', 'transfer', 'pay', 'apply',
]);

/** 只读动词。 */
const READ_VERBS = new Set(['list', 'get', 'search', 'query', 'read', 'fetch', 'describe', 'find', 'download']);

/**
 * 判断工具是否为「写操作」，写操作必须经过用户确认。
 *
 * 优先级：MCP annotations（readOnlyHint / destructiveHint）> 工具名动词 > 保守确认。
 * 企业微信官方 MCP 目前不返回 annotations，因此主要依赖工具名词表。
 * @param {{name?: string, annotations?: {readOnlyHint?: boolean, destructiveHint?: boolean}}} tool
 * @returns {boolean}
 */
export function isWriteTool(tool) {
  const annotations = tool?.annotations ?? {};
  if (annotations.destructiveHint === true) return true;
  if (annotations.readOnlyHint === true) return false;
  if (annotations.readOnlyHint === false) return true;

  const segments = String(tool?.name ?? '')
    .toLowerCase()
    .split(/[_.\-]/)
    .filter(Boolean);
  if (segments.some((segment) => WRITE_VERBS.has(segment))) return true;
  if (segments.some((segment) => READ_VERBS.has(segment))) return false;
  // 无法判断时按写操作处理：宁可多确认一次，也不要误发消息/误删数据
  return true;
}

/**
 * 企业微信 MCP 的业务错误码 → 需要重新授权的错误。
 * 官方远程 MCP 把业务错误包在 `result.content[0].text` 的 JSON 里（isError 仍为 false），
 * 因此必须解析内层 errcode，否则「授权失效」会被当成调用成功。
 */
export const WECOM_AUTH_ERRCODES = {
  850001: { code: McpErrorCode.UNAUTHORIZED, message: 'MCP 授权已失效（apikey 无效），请重新扫码授权' },
  851008: { code: McpErrorCode.FORBIDDEN, message: '该能力尚未授权，请在智能机器人「可使用权限」中补授权后重试' },
  40001: { code: McpErrorCode.UNAUTHORIZED, message: 'MCP 授权已失效，请重新扫码授权' },
  40014: { code: McpErrorCode.UNAUTHORIZED, message: 'MCP 授权已失效，请重新扫码授权' },
  41001: { code: McpErrorCode.UNAUTHORIZED, message: 'MCP 授权已失效，请重新扫码授权' },
  42001: { code: McpErrorCode.UNAUTHORIZED, message: 'MCP 授权已过期，请重新扫码授权' },
};

/**
 * 解析企业微信工具返回内容里的业务错误（内层 JSON 的 errcode）。
 * @param {string} text
 * @returns {{errcode: number, errmsg: string, auth?: {code: string, message: string}} | null}
 */
export function parseBusinessError(text) {
  const raw = String(text ?? '').trim();
  if (!raw.startsWith('{')) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rawCode = parsed.errcode ?? parsed.errCode;
  const errcode = typeof rawCode === 'number' ? rawCode : Number.parseInt(String(rawCode ?? ''), 10);
  if (!Number.isInteger(errcode) || errcode === 0) return null;
  const errmsg = String(parsed.errmsg ?? parsed.errmsg_localized ?? parsed.error ?? '').trim();
  return { errcode, errmsg, auth: WECOM_AUTH_ERRCODES[errcode] };
}

/**
 * 给探测工具打分；负数表示不适合做探针。
 *
 * 约束：必须是只读、且没有必填参数的工具（否则无法在不打扰用户的情况下调用）。
 * @param {{name?: string, inputSchema?: object, annotations?: object}} tool
 * @returns {number}
 */
function scoreProbeTool(tool) {
  if (!tool || typeof tool.name !== 'string') return -1;
  if (isWriteTool(tool)) return -1;
  const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : [];
  if (required.length > 0) return -1;
  const segments = tool.name.toLowerCase().split(/[_.\-]/);
  let value = 1;
  if (segments.includes('list')) value += 5;
  if (segments.includes('sessions')) value += 3;
  if (segments.includes('search')) value += 2;
  if (segments.includes('get')) value += 2;
  return value;
}

/**
 * 按得分挑选一组用于「验证授权」的候选探测工具（最多 limit 个）。
 *
 * 需要候选列表而不只一个的原因：企业微信同一个能力位内部还按子能力分档
 * （例如「文档」权限位下 doc_* / sheet_* / smartpage_* 各自授权），
 * 命中一个未授权子能力的工具会返回 851008，此时换下一个候选仍可能探测成功。
 * @param {Array<{name: string, inputSchema?: object, annotations?: object}>} tools
 * @param {number} [limit]
 * @returns {Array<{name: string, inputSchema?: object}>}
 */
export function pickProbeTools(tools, limit = 5) {
  /** @type {Array<{tool: any, value: number}>} */
  const scored = [];
  for (const tool of tools) {
    const value = scoreProbeTool(tool);
    if (value < 0) continue;
    scored.push({ tool, value });
  }
  scored.sort((left, right) => right.value - left.value);
  return scored.slice(0, Math.max(1, limit)).map((entry) => entry.tool);
}

/**
 * 挑选一个用于「验证授权」的探测工具。
 * @param {Array<{name: string, inputSchema?: object, annotations?: object}>} tools
 * @returns {{name: string, inputSchema?: object} | null}
 */
export function pickProbeTool(tools) {
  const candidates = pickProbeTools(tools, 1);
  return candidates[0] ?? null;
}

/**
 * 把 MCP 工具结果整理成眼镜端可展示的纯文本（保留完整文本供语言模型使用）。
 * @param {unknown} result callTool 的返回值
 * @returns {{ok: boolean, text: string, dataText: string, structuredContent?: unknown}}
 */
export function formatToolResult(result) {
  const record = result && typeof result === 'object' ? /** @type {Record<string, any>} */ (result) : {};
  const ok = record.isError !== true;
  const blocks = Array.isArray(record.content) ? record.content : [];
  /** @type {string[]} */
  const texts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
    } else if (block.type === 'image') {
      texts.push('[图片]');
    } else if (block.type === 'audio') {
      texts.push('[音频]');
    } else if (block.type === 'resource') {
      const text = block.resource?.text;
      texts.push(typeof text === 'string' ? text : `[资源 ${block.resource?.uri ?? ''}]`);
    } else if (block.type === 'resource_link') {
      texts.push(`[资源 ${block.name ?? block.uri ?? ''}]`);
    }
  }
  if (texts.length === 0 && record.structuredContent !== undefined) {
    texts.push(JSON.stringify(record.structuredContent));
  }
  const dataText = texts.join('\n').trim();
  const businessError = ok ? parseBusinessError(dataText) : null;
  const businessMessage = businessError
    ? `企业微信返回错误 ${businessError.errcode}${businessError.errmsg ? `：${businessError.errmsg}` : ''}`
    : '';
  const finalOk = ok && businessError === null;
  const text = finalOk
    ? dataText || '（工具没有返回内容）'
    : ok
      ? businessMessage
      : dataText || '工具执行失败';
  return {
    ok: finalOk,
    text,
    dataText,
    businessError,
    structuredContent: record.structuredContent,
  };
}

/**
 * 单个企业微信 MCP Server 的连接。
 */
export class McpServerConnection {
  /**
   * @param {{name: string, url: string}} config
   * @param {{sdk?: any, fetchImpl?: typeof fetch, timeoutMs?: number, callTimeoutMs?: number, logger?: any, reconnectionOptions?: object}} [deps]
   */
  constructor(config, deps = {}) {
    this.name = config.name;
    this.url = config.url;
    this.maskedUrl = maskUrl(config.url);
    /** @type {Array<{name: string, description?: string, inputSchema?: object, annotations?: object}>} */
    this.tools = [];
    /** @type {'idle'|'connecting'|'ready'|'error'|'closed'} */
    this.status = 'idle';
    /** @type {McpError | null} */
    this.lastError = null;

    const sdk = deps.sdk ?? { Client, StreamableHTTPClientTransport };
    this._sdk = sdk;
    this._fetch = deps.fetchImpl;
    this._timeoutMs = deps.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this._callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this._logger = deps.logger ?? silentLogger;
    this._reconnectionOptions = deps.reconnectionOptions ?? {
      maxReconnectionDelay: 10000,
      initialReconnectionDelay: 500,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 1,
    };
    this._client = null;
    this._transport = null;
    /** @type {Promise<McpServerConnection> | null} */
    this._connectPromise = null;
    /** @type {number | null} 这个 promise 所属的生命周期（与 _generation 比较，旧连接不能复用） */
    this._connectGeneration = null;
    /** @type {number} 连接生命周期计数：close()/重连递增，用于作废在途 connect 的迟到回调 */
    this._generation = 0;
    /** @type {AbortController | null} close() 用它取消在途 initialize */
    this._abortController = null;
    /** @type {Set<(event: {type: string, server: McpServerConnection}) => void>} */
    this._listeners = new Set();
  }

  /** @param {(event: {type: string, server: McpServerConnection}) => void} listener */
  onStateChange(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** @param {string} type */
  _emit(type) {
    for (const listener of this._listeners) {
      try {
        listener({ type, server: this });
      } catch (error) {
        this._logger.warn('state listener failed', error);
      }
    }
  }

  get connected() {
    return this.status === 'ready' && this._client !== null;
  }

  /**
   * 建立连接（MCP initialize）并拉取工具列表。
   * 并发调用复用同一个 in-flight promise，避免重复 initialize 与 transport 泄漏。
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
   * @returns {Promise<McpServerConnection>}
   */
  async connect(options = {}) {
    if (this.connected) return this;
    const generation = this._generation;
    // 只复用「当前生命周期」的在途连接：close() 之后旧 promise 已作废，
    // 不能让新的调用方 join 进去（否则会拿到一个「已取消」的拒绝）。
    if (this._connectPromise && this._connectGeneration === generation) {
      return this._connectPromise;
    }
    this._connectGeneration = generation;
    const promise = this._connect(options).finally(() => {
      if (this._connectGeneration === generation && this._connectPromise === promise) {
        this._connectPromise = null;
        this._connectGeneration = null;
      }
    });
    this._connectPromise = promise;
    return promise;
  }

  /**
   * @param {{timeoutMs?: number, signal?: AbortSignal}} options
   * @returns {Promise<McpServerConnection>}
   */
  async _connect(options) {
    // 本次连接所属的生命周期：close()/重连会递增 _generation，本次连接的所有 await
    // 回来都要先确认 token 没变，否则旧连接会在 close 之后把状态改回 ready。
    const generation = this._generation;
    // 先彻底关闭旧会话：401/断线后重连时，旧 transport 的 onclose/onerror 仍指向本
    // connection，若不关闭不摘回调，会把新连接的状态改回 error。
    await this._disposeCurrent();
    if (generation !== this._generation) {
      // close() 发生在等待 _disposeCurrent 期间：不再创建任何资源
      throw new McpError(McpErrorCode.NETWORK, `${this.name}连接已取消`, { serverName: this.name });
    }
    this.status = 'connecting';
    this.lastError = null;
    this._emit('connecting');

    const client = new this._sdk.Client(CLIENT_INFO, { capabilities: {} });
    /** @type {any} */
    const transportOptions = {
      reconnectionOptions: this._reconnectionOptions,
      // AIUI 运行时的 Headers 比浏览器更严格：`new Headers(undefined)` 会抛
      // "Headers constructor requires another Headers object, a sequence, or a record object"。
      // SDK 内部会执行 `new Headers(requestInit?.headers || undefined)`，因此这里显式给空对象。
      requestInit: { headers: {} },
    };
    if (this._fetch) transportOptions.fetch = this._fetch;
    const transport = new this._sdk.StreamableHTTPClientTransport(new URL(this.url), transportOptions);

    transport.onerror = (error) => {
      if (this._transport !== transport) return;
      this._logger.warn('transport error', error);
      this.lastError = classifyError(error, { serverName: this.name });
      this._emit('transport-error');
    };
    transport.onclose = () => {
      if (this._transport !== transport) return;
      if (this.status === 'ready') {
        this.status = 'error';
        this.lastError = new McpError(McpErrorCode.NETWORK, `${this.name}连接已断开`, {
          serverName: this.name,
          retryable: true,
        });
        this._emit('disconnected');
      }
    };

    // close() 通过 abort 取消在途 initialize，配合 generation 做双层保证
    const controller = new AbortController();
    if (this._abortController) {
      // 极少数情况下有更早的 connect 还挂着（它的 generation 已作废），让它自己超时即可
      this._logger.warn(`MCP 连接重复发起：${this.name}`);
    }
    this._abortController = controller;
    if (options.signal) {
      try {
        if (options.signal.aborted) controller.abort();
        else options.signal.addEventListener?.('abort', () => controller.abort(), { once: true });
      } catch {
        // 个别运行时 AbortSignal 没有 addEventListener；generation 兜底仍有效
      }
    }

    try {
      await client.connect(transport, {
        timeout: options.timeoutMs ?? this._timeoutMs,
        signal: controller.signal,
      });
      if (generation !== this._generation) {
        throw new McpError(McpErrorCode.NETWORK, `${this.name}连接已取消`, { serverName: this.name });
      }
      // tools 先放局部变量：旧 listTools 迟到完成时不能覆盖新连接的 tools/状态，
      // 只有 generation 核验通过后才一次性提交共享状态。
      const tools = await this._listTools({ timeoutMs: options.timeoutMs, signal: controller.signal }, client);
      if (generation !== this._generation) {
        throw new McpError(McpErrorCode.NETWORK, `${this.name}连接已取消`, { serverName: this.name });
      }
      this._client = client;
      this._transport = transport;
      this.tools = tools;
      this.status = 'ready';
      this._emit('ready');
      this._logger.info(`MCP 已连接：${this.name}`);
      return this;
    } catch (error) {
      // 只清理本次连接创建的资源，并摘掉可能已挂到共享状态上的引用；
      // 若本次连接已被 close()/新一次 connect 顶掉，不覆盖状态、不 emit ready/error，
      // 否则 close 返回后连接会「复活」。
      if (this._transport === transport) this._transport = null;
      if (this._client === client) this._client = null;
      await this._closeResource(client, transport);
      if (generation !== this._generation) {
        this._logger.warn(`MCP 连接已取消：${this.name}`);
        throw new McpError(McpErrorCode.NETWORK, `${this.name}连接已取消`, {
          serverName: this.name,
          cause: error,
        });
      }
      this.status = 'error';
      this.lastError = classifyError(error, { serverName: this.name });
      this._logger.error(`MCP 连接失败：${this.name}`, this.lastError.message);
      this._emit('error');
      throw this.lastError;
    } finally {
      if (this._abortController === controller) this._abortController = null;
    }
  }

  /**
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
   * @returns {Promise<Array<{name: string, description?: string, inputSchema?: object, annotations?: object}>>}
   */
  async _listTools(options = {}, client = this._client) {
    if (!client) {
      throw new McpError(McpErrorCode.NETWORK, `${this.name}连接已关闭，工具列表不可用`, {
        serverName: this.name,
        retryable: false,
      });
    }
    const response = await client.listTools({
      timeout: options.timeoutMs ?? this._timeoutMs,
      signal: options.signal,
    });
    const tools = Array.isArray(response?.tools) ? response.tools : [];
    return tools.map((tool) => ({
      name: String(tool.name || ''),
      description: typeof tool.description === 'string' ? tool.description : '',
      inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
      annotations: tool.annotations ?? {},
      title: tool.title,
    }));
  }

  /**
   * 重新拉取工具列表（工具可能随授权变化）。
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
   */
  async refreshTools(options = {}) {
    await this._ensureConnected(options);
    const generation = this._generation;
    try {
      const tools = await this._listTools(options);
      if (generation !== this._generation) throw this._closedError();
      this.tools = tools;
      this._emit('tools-changed');
      return this.tools;
    } catch (error) {
      if (generation !== this._generation) throw this._closedError();
      throw this._handleCallError(error);
    }
  }

  /**
   * 调用工具。工具级失败（isError）不会抛异常，而是以 `{ok:false}` 返回。
   *
   * `options.retry` 默认为 true（只读工具出错时重连重放一次）；写操作必须由调用方
   * 传 `retry:false`，因为超时/5xx 时服务端可能已经执行成功，重放会重复发消息/建文档。
   * @param {string} toolName
   * @param {object} args
   * @param {{timeoutMs?: number, signal?: AbortSignal, retry?: boolean}} [options]
   * @returns {Promise<{ok: boolean, text: string, dataText: string, structuredContent?: unknown}>}
   */
  async callTool(toolName, args, options = {}) {
    await this._ensureConnected(options);
    // 请求级 generation：close() 后迟到的调用失败不能被当成「连接断了」去重连，
    // 否则会把用户/页面已经关闭的旧连接重新拉起来（复活 + 状态污染）。
    const generation = this._generation;
    // 调用方未提供确认快照时（例如 verifyAuthorization 直接调 connection.callTool），
    // 用请求开始时的完整工具定义作为基线：重连后同名工具 read→write/schema 变化
    // 同样必须 fail-closed，绝不自动重试成新写工具。
    const expectedTool = options.expectedTool ?? this._snapshotTool(toolName);
    // 先按当前 tools 核验身份/读写语义；写工具（含无法判定）永远不重试。
    const first = this._verifyToolForExecution(toolName, expectedTool);
    const retryAllowed = options.retry !== false && !first.write;
    if (options.retry === true && !retryAllowed) {
      this._logger.warn(`忽略对写工具的重试请求：${toolName}`);
    }
    const invoke = () =>
      this._client.callTool(
        { name: toolName, arguments: args ?? {} },
        { timeout: options.timeoutMs ?? this._callTimeoutMs, signal: options.signal },
      );
    const run = (expectedGeneration) => {
      if (expectedGeneration !== this._generation) return Promise.reject(this._closedError());
      // 重连后工具清单可能已刷新：每次尝试前重新核验，绝不把旧只读重放成新写
      this._verifyToolForExecution(toolName, expectedTool);
      return invoke();
    };

    let result;
    try {
      result = await run(generation);
    } catch (error) {
      if (error?.failClosed) throw error;
      if (generation !== this._generation) throw this._closedError();
      const classified = classifyError(error, { serverName: this.name });
      // 会话失效 / 连接断开：重连一次后重试，避免用户重新扫码。
      // 仅只读工具可重放（retry !== false）；写操作重放会导致重复执行。
      if (retryAllowed && classified.retryable && classified.code !== McpErrorCode.UNAUTHORIZED) {
        this._logger.warn(`工具调用失败，尝试重连：${toolName}`);
        await this._reconnect(options);
        const retryGeneration = this._generation;
        try {
          result = await run(retryGeneration);
        } catch (retryError) {
          if (retryError?.failClosed) throw retryError;
          if (retryGeneration !== this._generation) throw this._closedError();
          throw this._handleCallError(retryError);
        }
      } else {
        throw this._handleCallError(error);
      }
    }
    const formatted = formatToolResult(result);
    if (formatted.businessError?.auth) {
      const { code, message } = formatted.businessError.auth;
      // 只有 apikey 失效（UNAUTHORIZED）才需要重新扫码；能力位未授权（FORBIDDEN）
      // 去智能机器人「可使用权限」补授权即可，反复扫码不会改变结果。
      const needRescan = code === McpErrorCode.UNAUTHORIZED;
      const error = new McpError(code, `${this.name}：${message}`, {
        serverName: this.name,
        needRescan,
      });
      this.lastError = error;
      // FORBIDDEN 不代表连接断开，不上报 error 状态，避免首页误提示「连接已断开」
      if (needRescan) this._emit('error');
      throw error;
    }
    return formatted;
  }

  /**
   * 验证授权是否真正生效。
   *
   * 企业微信的 `initialize` / `tools/list` 不校验 apikey（无效 key 也能拿到 schema），
   * 只有 `tools/call` 才校验，因此必须挑「无必填参数的只读工具」实际调用一次。
   * 同一个能力位内部还按子能力分档授权，命中的探针可能恰好在未授权子能力上（851008），
   * 所以按得分依次尝试多个候选：任一成功即视为授权有效。
   * @param {{timeoutMs?: number}} [options]
   * @returns {Promise<{verified: boolean, reason?: 'no-probe-tool'|'capability-unauthorized'|'probe-failed', toolName?: string, error?: McpError}>}
   */
  async verifyAuthorization(options = {}) {
    await this._ensureConnected(options);
    // 授权探针只允许只读工具；并在 pick 时刻就固化每个候选的完整只读快照。
    // 之后即使 tools 在探针执行期间被 refresh 换成写工具（或 schema/annotations 变化），
    // callTool 也会把快照作为 expectedTool 校验并 fail-closed，绝不执行写工具。
    const probes = pickProbeTools(this.tools, 5)
      .filter((tool) => !isWriteTool(tool))
      .map((tool) => ({ tool, snapshot: this._buildToolSnapshot(tool) }));
    if (probes.length === 0) {
      return { verified: false, reason: 'no-probe-tool' };
    }
    /** @type {McpError[]} */
    const failures = [];
    let lastToolName = '';
    for (const { tool: probe, snapshot } of probes) {
      lastToolName = probe.name;
      try {
        const result = await this.callTool(probe.name, {}, {
          timeoutMs: options.timeoutMs ?? 15000,
          expectedTool: snapshot,
        });
        if (result.ok) return { verified: true, toolName: probe.name };
        // 工具级失败但不是鉴权错误（isError）：换下一个候选再试
        failures.push(new McpError(McpErrorCode.TOOL, result.text, { serverName: this.name }));
      } catch (error) {
        const classified = classifyError(error, { serverName: this.name });
        failures.push(classified);
        // 只有 FORBIDDEN（子能力未授权）值得换候选；UNAUTHORIZED/网络错误换探针也不会成功
        if (classified.code !== McpErrorCode.FORBIDDEN) break;
      }
    }
    const allForbidden = failures.length > 0 && failures.every((error) => error.code === McpErrorCode.FORBIDDEN);
    return {
      verified: false,
      reason: allForbidden ? 'capability-unauthorized' : 'probe-failed',
      toolName: lastToolName,
      error: failures[failures.length - 1],
    };
  }

  /**
   * 工具身份/权限在连接重建后发生变化时的 fail-closed 错误（不执行、不重试）。
   * @param {string} reason
   */
  _toolChangedError(reason) {
    const error = new McpError(McpErrorCode.TOOL, `${this.name}：${reason}，请重新发起请求`, {
      serverName: this.name,
    });
    error.failClosed = true;
    return error;
  }

  /**
   * 把工具定义固化成完整身份快照（name/write/inputSchema/annotations）。
   * @param {any} tool
   * @returns {{name: string, write: boolean, inputSchema: object, annotations: object} | null}
   */
  _buildToolSnapshot(tool) {
    if (!tool || typeof tool.name !== 'string') return null;
    return {
      name: tool.name,
      write: isWriteTool(tool),
      inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
      annotations: tool.annotations ?? {},
    };
  }

  /**
   * 请求开始时的完整工具快照（name/write/inputSchema/annotations），用于直接调用
   * `connection.callTool` 且未显式传 expectedTool 的路径在重连后重验。
   * @param {string} toolName
   * @returns {{name: string, write: boolean, inputSchema: object, annotations: object} | null}
   */
  _snapshotTool(toolName) {
    return this._buildToolSnapshot(this.tools.find((item) => item.name === toolName) ?? null);
  }

  /**
   * 按服务端**当前** tools 重新核验要执行的工具：必须仍存在，且（若调用方给了身份快照）
   * 原始工具名 / schema / annotations / 读写语义与快照一致。变化一律 fail-closed。
   * @param {string} toolName
   * @param {{name?: string, write?: boolean, inputSchema?: object, annotations?: object} | null | undefined} expectedTool
   * @returns {{tool: any, write: boolean}}
   */
  _verifyToolForExecution(toolName, expectedTool) {
    const current = this.tools.find((tool) => tool.name === toolName);
    if (!current) throw this._toolChangedError(`工具 ${toolName} 已被移除`);
    const currentWrite = isWriteTool(current);
    if (expectedTool) {
      const expectedWrite = expectedTool.write !== undefined ? expectedTool.write === true : isWriteTool(expectedTool);
      if (expectedWrite !== currentWrite) throw this._toolChangedError('工具的只读/写语义已变化');
      if (expectedTool.name !== undefined && String(expectedTool.name) !== String(current.name)) {
        throw this._toolChangedError('原始工具名已变化');
      }
      // schema/annotations 用规范化完整 JSON 精确比较（不做短哈希，避免可构造碰撞）。
      if (expectedTool.inputSchema !== undefined && canonicalSchemaOf(expectedTool) !== canonicalSchemaOf(current)) {
        throw this._toolChangedError('工具的 inputSchema 已变化');
      }
      if (
        expectedTool.annotations !== undefined &&
        canonicalAnnotationsOf(expectedTool) !== canonicalAnnotationsOf(current)
      ) {
        throw this._toolChangedError('工具的 annotations 已变化');
      }
    }
    return { tool: current, write: currentWrite };
  }

  /** 连接在本次请求期间被显式关闭/替换时使用的取消错误（不改状态、不触发重连）。 */
  _closedError() {
    return new McpError(McpErrorCode.NETWORK, `${this.name}连接已关闭，本次调用已取消`, {
      serverName: this.name,
      retryable: false,
    });
  }

  /**
   * @param {unknown} error
   * @returns {McpError}
   */
  _handleCallError(error) {
    const classified = classifyError(error, { serverName: this.name });
    if (classified.needRescan) {
      this.status = 'error';
      this._emit('error');
    }
    this.lastError = classified;
    this._logger.warn(`工具调用失败：${classified.message}`);
    return classified;
  }

  /**
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
   */
  async _ensureConnected(options = {}) {
    if (this.connected) return;
    // 正在连接时等待同一个 in-flight promise，而不是直接报错（并发调用共享一次 initialize）；
    // close() 之后旧 promise 属于上一个生命周期，必须重新发起连接。
    if (this._connectPromise && this._connectGeneration === this._generation) {
      await this._connectPromise;
      return;
    }
    await this.connect(options);
  }

  /**
   * 断线重连：先彻底关闭旧会话，再重新 initialize。
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
   */
  async _reconnect(options = {}) {
    const generation = this._generation;
    await this.close();
    // close() 的 transport.close() 可能很慢：期间外部 close() 会再次递增 generation。
    // 这时外部关闭优先，旧重连必须放弃，绝不能再起一次 initialize 把已删除的连接复活。
    if (this._generation !== generation + 1) {
      throw this._closedError();
    }
    if (this.status === 'closed') this.status = 'idle';
    await this.connect(options);
  }

  /** 主动重连（供 UI「重试」按钮使用） */
  async reconnect(options = {}) {
    return this._reconnect(options);
  }

  /** 关闭一组 client/transport，并摘掉 transport 回调（避免旧连接回调改写新状态）。 */
  async _closeResource(client, transport) {
    if (transport) {
      // 摘掉回调，避免旧 transport 的 onclose/onerror 把新连接状态改回 error
      try {
        transport.onerror = undefined;
        transport.onclose = undefined;
      } catch {
        // 回调是普通属性，个别实现可能只读；_connect 里的 _transport 守卫仍能兜底
      }
    }
    try {
      await transport?.close?.();
    } catch (error) {
      this._logger.warn('transport close failed', error);
    }
    try {
      await client?.close?.();
    } catch (error) {
      this._logger.warn('client close failed', error);
    }
  }

  /** 关闭当前 client/transport（不广播状态），供重连前清理。 */
  async _disposeCurrent() {
    const client = this._client;
    const transport = this._transport;
    this._client = null;
    this._transport = null;
    await this._closeResource(client, transport);
  }

  /**
   * 关闭连接，释放会话与 SSE 流。
   * 先递增 generation 并 abort 在途 initialize：close() 返回后，旧 connect 的迟到回调
   * 不会再把这个连接重新置为 ready，也不会留下未关闭的旧 client/transport。
   */
  async close() {
    this._generation += 1;
    this.status = 'closed';
    this._emit('closed');
    const controller = this._abortController;
    this._abortController = null;
    try {
      controller?.abort?.();
    } catch (error) {
      this._logger.warn('abort connect failed', error);
    }
    await this._disposeCurrent();
  }
}

/**
 * 多个企业微信 MCP Server 的聚合管理。
 * 工具名对所有 Server 做命名空间隔离，返回的语言模型函数名与 MCP 工具名一一映射。
 */
export class McpServers {
  /**
   * @param {Array<{name: string, url: string}>} configs
   * @param {{sdk?: any, fetchImpl?: typeof fetch, timeoutMs?: number, callTimeoutMs?: number, logger?: any}} [deps]
   */
  constructor(configs, deps = {}) {
    this._deps = deps;
    this._logger = deps.logger ?? silentLogger;
    /** @type {McpServerConnection[]} */
    this.connections = configs.map((config) => new McpServerConnection(config, deps));
    /** @type {Map<string, {connection: McpServerConnection, tool: any, namespacedName: string}>} */
    this._toolIndex = new Map();
    /** @type {Set<(event: {type: string, servers: McpServers}) => void>} */
    this._listeners = new Set();
    for (const connection of this.connections) {
      connection.onStateChange((event) => this._emit(event));
    }
  }

  /** @param {(event: {type: string, servers: McpServers}) => void} listener */
  onStateChange(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** @param {{type: string}} event */
  _emit(event) {
    this.rebuildToolIndex();
    for (const listener of this._listeners) {
      try {
        listener({ ...event, servers: this });
      } catch {
        // 监听器异常不影响主流程
      }
    }
  }

  /**
   * 并发连接所有 Server；单个失败不阻塞其他 Server，返回顺序与 connections 一致。
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
   * @returns {Promise<Array<{name: string, ok: boolean, error?: McpError, tools: number}>>}
   */
  async connectAll(options = {}) {
    const settled = await Promise.allSettled(this.connections.map((connection) => connection.connect(options)));
    const results = settled.map((entry, index) => {
      const connection = this.connections[index];
      if (entry.status === 'fulfilled') {
        return { name: connection.name, ok: true, tools: connection.tools.length };
      }
      return {
        name: connection.name,
        ok: false,
        error: classifyError(entry.reason, { serverName: connection.name }),
        tools: 0,
      };
    });
    this.rebuildToolIndex();
    return results;
  }

  /** 重新拉取所有已连接 Server 的工具。 */
  async refreshAllTools(options = {}) {
    for (const connection of this.connections) {
      if (!connection.connected) continue;
      try {
        await connection.refreshTools(options);
      } catch {
        // 单个 Server 刷新失败时保留旧工具列表
      }
    }
    this.rebuildToolIndex();
    return this.tools;
  }

  /**
   * 验证所有 Server 的授权是否真正生效（用无参只读工具探测）。
   *
   * reason 原样透传：'not-connected' | 'no-probe-tool' | 'capability-unauthorized' | 'probe-failed'。
   * 只有 UNAUTHORIZED 表示 apikey 失效需要重新扫码；'capability-unauthorized'（851008 等
   * 子能力未授权）不应阻止保存配置。
   *
   * 探测按 options.concurrency（默认 4）并发，避免 32 个 Server 串行时总耗时叠加到 32*15s；
   * 返回顺序与 connections 一致，单个 Server 的异常只影响它自己。
   * @param {{timeoutMs?: number, concurrency?: number}} [options]
   * @returns {Promise<Array<{name: string, verified: boolean, reason?: string, error?: McpError}>>}
   */
  async verifyAuthorizationAll(options = {}) {
    const requested = Number(options.concurrency ?? 4);
    const concurrency = Number.isInteger(requested) && requested > 0 ? Math.min(requested, this.connections.length || 1) : 4;
    /** @type {Array<{name: string, verified: boolean, reason?: string, error?: McpError}>} */
    const results = new Array(this.connections.length);
    let nextIndex = 0;

    /** 取下一个待探测的 Server 下标（单线程执行，读取后立即自增，不会重复取）。 */
    const takeIndex = () => {
      const index = nextIndex;
      nextIndex += 1;
      return index;
    };

    const verifyOne = async (index) => {
      const connection = this.connections[index];
      if (!connection.connected) {
        results[index] = {
          name: connection.name,
          verified: false,
          reason: 'not-connected',
          error: connection.lastError ?? undefined,
        };
        return;
      }
      try {
        const result = await connection.verifyAuthorization(options);
        results[index] = { name: connection.name, ...result };
      } catch (error) {
        results[index] = {
          name: connection.name,
          verified: false,
          reason: 'probe-failed',
          error: classifyError(error, { serverName: connection.name }),
        };
      }
    };

    const worker = async () => {
      for (let index = takeIndex(); index < this.connections.length; index = takeIndex()) {
        await verifyOne(index);
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, this.connections.length) }, () => worker()));
    return results;
  }

  /**
   * 重建命名空间索引。
   *
   * 身份不依赖短哈希：toolId = `${serverIndex}:${原始工具名}`，与 connection 对象/原始名
   * 一一对应；schema/annotations 在比较时用规范化完整字符串精确相等。
   * sanitize 后同名（含截断同名）或同一 Server 内原始工具名重复时无法唯一标识，直接拒绝
   * 暴露这些工具（fail-closed），避免 namespacedName 重排指向另一个工具。
   */
  rebuildToolIndex() {
    this._toolIndex.clear();
    /** @type {Array<{connection: McpServerConnection, tool: any, serverIndex: number, base: string, identityKey: string}>} */
    const candidates = [];
    this.connections.forEach((connection, serverIndex) => {
      for (const tool of connection.tools) {
        candidates.push({
          connection,
          tool,
          serverIndex,
          base: `s${serverIndex}_${sanitizeToolName(tool.name)}`,
          identityKey: `${serverIndex}\u0000${tool.name}`,
        });
      }
    });
    const baseCounts = new Map();
    const identityCounts = new Map();
    for (const candidate of candidates) {
      baseCounts.set(candidate.base, (baseCounts.get(candidate.base) ?? 0) + 1);
      identityCounts.set(candidate.identityKey, (identityCounts.get(candidate.identityKey) ?? 0) + 1);
    }
    for (const candidate of candidates) {
      const baseConflict = (baseCounts.get(candidate.base) ?? 0) > 1;
      const identityConflict = (identityCounts.get(candidate.identityKey) ?? 0) > 1;
      if (baseConflict || identityConflict) {
        this._logger.warn(
          `工具名冲突，已拒绝暴露：${candidate.connection.name}/${candidate.tool.name}` +
            (baseConflict ? '（命名空间同名）' : '（原始工具名重复）'),
        );
        continue;
      }
      const identity = {
        toolId: `${candidate.serverIndex}:${candidate.tool.name}`,
        connectionId: `${candidate.serverIndex}`,
        name: String(candidate.tool.name ?? ''),
        serverName: candidate.connection.name,
        serverIndex: candidate.serverIndex,
        write: isWriteTool(candidate.tool),
      };
      this._toolIndex.set(candidate.base, {
        connection: candidate.connection,
        tool: candidate.tool,
        namespacedName: candidate.base,
        identity,
      });
    }
  }

  /**
   * 所有可用工具（含命名空间名、所属 Server、是否写操作）。
   * @returns {Array<{namespacedName: string, name: string, description: string, inputSchema: object, annotations: object, serverIndex: number, serverName: string, write: boolean, title?: string}>}
   */
  get tools() {
    this.rebuildToolIndex();
    const result = [];
    for (const entry of this._toolIndex.values()) {
      const serverIndex = this.connections.indexOf(entry.connection);
      result.push({
        namespacedName: entry.namespacedName,
        name: entry.tool.name,
        description: entry.tool.description || '',
        inputSchema: entry.tool.inputSchema ?? { type: 'object', properties: {} },
        annotations: entry.tool.annotations ?? {},
        serverIndex,
        serverName: entry.connection.name,
        write: isWriteTool(entry.tool),
        title: entry.tool.title,
        ...entry.identity,
      });
    }
    return result;
  }

  /**
   * 按语言模型的函数名反查 MCP 工具。
   * @param {string} namespacedName
   * @returns {{namespacedName: string, name: string, description: string, inputSchema: object, write: boolean, serverName: string, serverIndex: number} | null}
   */
  findTool(namespacedName) {
    const entry = this._toolIndex.get(namespacedName);
    if (!entry) return null;
    return {
      namespacedName,
      name: entry.tool.name,
      description: entry.tool.description || '',
      title: entry.tool.title,
      inputSchema: entry.tool.inputSchema ?? { type: 'object', properties: {} },
      annotations: entry.tool.annotations ?? {},
      write: isWriteTool(entry.tool),
      serverName: entry.connection.name,
      serverIndex: this.connections.indexOf(entry.connection),
      ...entry.identity,
    };
  }

  /**
   * 按命名空间名调用工具。
   *
   * 写操作绝不自动重放：超时/5xx 时服务端可能已经执行成功，重试会导致重复发消息。
   * @param {string} namespacedName
   * @param {object} args
   * @param {{timeoutMs?: number, signal?: AbortSignal, retry?: boolean}} [options]
   */
  async callTool(namespacedName, args, options = {}) {
    const entry = this._toolIndex.get(namespacedName);
    if (!entry) {
      const error = new McpError(McpErrorCode.TOOL, `工具已不存在：${namespacedName}，请重新发起请求`);
      error.failClosed = true;
      throw error;
    }
    this._verifyExpectedTool(entry, options.expectedTool);
    // 调用方没给确认快照时，至少把「本次调用开始时的工具定义」当基线传给连接：
    // 重连后工具变写/改 schema 仍然 fail-closed，绝不把旧只读重试成新写。
    const expectedForExecution = options.expectedTool ?? entry.tool;
    const write = entry.identity.write;
    // 写操作绝不重试：即使调用端（如模型）传 retry:true 也强制降级，避免超时后重放发消息。
    let retry = options.retry !== false && !write;
    if (options.retry === true && !retry) {
      this._logger.warn(`忽略对写工具的重试请求：${namespacedName}`);
    }
    return entry.connection.callTool(entry.tool.name, args, {
      ...options,
      retry,
      expectedTool: expectedForExecution,
    });
  }

  /**
   * 核对调用方保存的身份快照（findTool/tools 返回值）与当前索引是否一致。
   * 确认 A 之后工具被重排/重建/改写，一律 fail-closed，绝不执行另一个工具。
   * @param {{connection: McpServerConnection, tool: any, namespacedName: string, identity: any}} entry
   * @param {any} expectedTool
   */
  _verifyExpectedTool(entry, expectedTool) {
    if (!expectedTool || typeof expectedTool !== 'object') return;
    const current = entry.identity;
    const reasons = [];
    if (expectedTool.toolId !== undefined && String(expectedTool.toolId) !== current.toolId) reasons.push('工具身份');
    if (expectedTool.name !== undefined && String(expectedTool.name) !== current.name) reasons.push('原始工具名');
    if (expectedTool.connectionId !== undefined && String(expectedTool.connectionId) !== current.connectionId) {
      reasons.push('服务端连接');
    }
    if (expectedTool.serverName !== undefined && String(expectedTool.serverName) !== current.serverName) {
      reasons.push('服务端名称');
    }
    const expectedWrite = expectedTool.write !== undefined ? expectedTool.write === true : isWriteTool(expectedTool);
    if (expectedWrite !== current.write) reasons.push('只读/写语义');
    // schema/annotations 用规范化完整 JSON 精确比较（不做短哈希，避免可构造碰撞）。
    if (
      expectedTool.inputSchema !== undefined &&
      canonicalSchemaOf(expectedTool) !== canonicalSchemaOf(entry.tool)
    ) {
      reasons.push('inputSchema');
    }
    if (
      expectedTool.annotations !== undefined &&
      canonicalAnnotationsOf(expectedTool) !== canonicalAnnotationsOf(entry.tool)
    ) {
      reasons.push('annotations');
    }
    if (reasons.length > 0) {
      const error = new McpError(
        McpErrorCode.TOOL,
        `工具身份或权限已变化（${reasons.join('、')}），请重新发起请求`,
        { serverName: entry.connection.name },
      );
      error.failClosed = true;
      throw error;
    }
  }

  /** 关闭所有连接。 */
  async closeAll() {
    await Promise.all(this.connections.map((connection) => connection.close()));
  }

  /** 已就绪的 Server 数量。 */
  get readyCount() {
    return this.connections.filter((connection) => connection.connected).length;
  }
}
