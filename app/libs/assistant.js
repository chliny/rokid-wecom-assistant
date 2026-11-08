// 语音助手编排：一句话 → 选择 MCP 工具 → （写操作先确认）→ 调用 → 上屏/播报。
//
// 依赖通过构造函数注入（MCP 连接管理、LanguageModel、日志），因此：
//   - AIUI 页面里注入真实的 McpServers + LanguageModel；
//   - Node 测试里注入 mock server 与假的 LanguageModel，直接验证业务流程。
// 本模块不 import wx / 不直接操作 UI，保持可测试。
import {
  coerceArguments,
  describeToolAction,
  inferArguments,
  matchToolByText,
  toLanguageModelTools,
  ToolArgumentError,
} from './intent.js';
import { formatError, formatForGlasses, toSpeechText, truncate } from './format.js';
import { silentLogger } from './log.js';
import { McpError, McpErrorCode } from './mcp-servers.js';

/** 稳定序列化工具身份字段：用于把「模型看到/用户确认时的工具」与当前索引精确比对。 */
function canonicalToolJson(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalToolJson).join(',')}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalToolJson(value[key])}`)
    .join(',')}}`;
}

/** 助手状态机。 */
export const AssistantState = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  THINKING: 'thinking',
  CONFIRMING: 'confirming',
  ERROR: 'error',
};

/** 确认类口语表达：整句规范化后精确匹配，只保留明确肯定，宁可不识别也不要误发。 */
const CONFIRM_WORDS = ['确认', '确定', '是的', '对', 'ok', 'yes', 'yep'];

/**
 * 取消类口语表达：先于确认判定，但只匹配真正的否定/放弃语义。
 *
 * 为什么不用「包含匹配整段文本」：`'no'` 会命中 `now/nothing`、`'别'` 会命中「特别是」，
 * 导致用户只是补充说明就把待确认操作取消掉。因此：
 *   - 英文词按整词边界匹配（对去掉非字母字符后的文本做 `\b` 判断）；
 *   - 中文单字「别/停」只接受整句（允许后面跟语气词），不接受出现在别的词里；
 *   - 中文多字短语仍用包含匹配（取消/算了/不要…语义足够明确）。
 */
const CANCEL_PHRASES = ['取消', '算了', '不要', '不改了', '不用了', '不发送', '不发', '别发', '不做了', '停止', '停下来'];
const CANCEL_SINGLE_WORDS = ['别', '停'];
const CANCEL_LATIN_WORDS = ['no', 'cancel', 'stop', 'nope'];

/** 语音确认等待超时（毫秒）：超时后旧待确认操作必须作废，避免陈旧参数被误确认。 */
const CONFIRM_TIMEOUT_MS = 120000;

/** 连接失败后的重试冷却（毫秒）：冷却期内直接复用上次失败结果，避免每次问话都等满超时。 */
const CONNECT_RETRY_COOLDOWN_MS = 10000;

/** 「查看工具」这类元指令。 */
const LIST_INTENT_PATTERN = /(有哪些|有什么|查看|看看|列出|显示).{0,6}(工具|功能|能力)|能做什么|可以做什么/;

/**
 * 语音助手。
 */
export class Assistant {
  /**
   * @param {{
   *   servers: import('./mcp-servers.js').McpServers,
   *   languageModel?: {availability: () => Promise<string>, create: (options: object) => Promise<any>} | null,
   *   logger?: ReturnType<typeof import('./log.js').createLogger>,
   *   now?: () => Date,
   *   connectTimeoutMs?: number,
   *   callTimeoutMs?: number,
   *   maxDisplays?: number,
   *   confirmTimeoutMs?: number,
   * }} deps
   */
  constructor(deps) {
    if (!deps || !deps.servers) throw new Error('Assistant 需要 servers 依赖');
    this.servers = deps.servers;
    this.languageModel = deps.languageModel ?? null;
    this.logger = deps.logger ?? silentLogger;
    this.now = deps.now ?? (() => new Date());
    this.connectTimeoutMs = deps.connectTimeoutMs ?? 20000;
    this.callTimeoutMs = deps.callTimeoutMs ?? 30000;
    this.maxDisplays = deps.maxDisplays ?? 320;
    this.confirmTimeoutMs = deps.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS;

    this.state = AssistantState.IDLE;
    /** @type {{namespacedName: string, tool: any, args: Record<string, unknown>, title: string, detail: string, createdAt: number} | null} */
    this.pending = null;
    this.lastAnswer = '';
    this._connectPromise = null;
    /** 上次连接尝试的时间与结果（失败退避用） @type {number} */
    this._lastConnectAttemptAt = 0;
    /** @type {Array<{name: string, ok: boolean, tools: number, error?: Error}> | null} */
    this._lastConnectResults = null;
    /** ask 串行队列：并发 ask 必须按调用顺序执行，避免迟到回答覆盖后发请求的 pending。 @type {Promise<void> | null} */
    this._askChain = null;
    /** 每次生成新 pending 自增；用于把「确认」绑定到用户看到的那一个 pending，防止预先说出的确认批准后来生成的写操作。 */
    this._pendingVersion = 0;
    /** @type {Set<(event: {type: string, assistant: Assistant, info?: object}) => void>} */
    this._listeners = new Set();
  }

  /** @param {(event: {type: string, assistant: Assistant, info?: object}) => void} listener */
  onEvent(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /**
   * @param {string} type
   * @param {object} [info]
   */
  _emit(type, info = {}) {
    for (const listener of this._listeners) {
      try {
        listener({ type, assistant: this, info });
      } catch (error) {
        this.logger.warn('assistant listener failed', error);
      }
    }
  }

  /** @param {string} next */
  _setState(next) {
    if (this.state === next) return;
    this.state = next;
    this._emit('state', { state: next });
  }

  /**
   * 连接所有 MCP Server（幂等，并发调用共享同一个 Promise）。
   * @returns {Promise<Array<{name: string, ok: boolean, tools: number, error?: McpError}>>}
   */
  async ensureConnected() {
    const snapshot = () =>
      this.servers.connections.map((connection) => ({
        name: connection.name,
        ok: connection.connected,
        tools: connection.tools.length,
        error: connection.connected ? undefined : connection.lastError ?? undefined,
      }));

    const failed = this.servers.connections.filter((connection) => !connection.connected);
    // 全部已连接：直接返回快照，不触发任何重连。
    if (this.servers.readyCount > 0 && failed.length === 0 && this._connectPromise === null) {
      return snapshot();
    }
    if (this._connectPromise) return this._connectPromise;

    // 失败退避：冷却期内直接复用上次失败结果，避免断网时每次唤醒都等满 connectTimeoutMs。
    // 注意按「当前连接状态」重建结果：期间若有 Server 自动重连成功，不能再报旧失败。
    const now = this.now().getTime();
    const inCooldown = now - this._lastConnectAttemptAt < CONNECT_RETRY_COOLDOWN_MS;
    if (inCooldown && this._lastConnectResults) {
      return this.servers.connections.map((connection) => {
        if (connection.connected) return { name: connection.name, ok: true, tools: connection.tools.length };
        const cached = this._lastConnectResults.find((result) => result.name === connection.name);
        return cached ?? { name: connection.name, ok: false, tools: 0, error: connection.lastError ?? undefined };
      });
    }

    this._setState(AssistantState.CONNECTING);
    this._lastConnectAttemptAt = now;
    this._connectPromise = (async () => {
      let results;
      try {
        if (this.servers.readyCount === 0) {
          // 一个都没连上：全量连接（单次尝试，失败后靠冷却避免连续超时）。
          results = await this.servers.connectAll({ timeoutMs: this.connectTimeoutMs });
        } else {
          // 部分连接可用：只重试失败项，已连好的 Server 不重新 initialize。
          const retried = await Promise.allSettled(
            failed.map((connection) => connection.connect({ timeoutMs: this.connectTimeoutMs })),
          );
          const retriedByName = new Map(
            retried.map((entry, index) => {
              const connection = failed[index];
              if (entry.status === 'fulfilled' && connection.connected) {
                return [connection.name, { name: connection.name, ok: true, tools: connection.tools.length }];
              }
              const error = connection.lastError ?? new McpError(McpErrorCode.NETWORK, `${connection.name}连接失败`);
              return [connection.name, { name: connection.name, ok: false, tools: 0, error }];
            }),
          );
          // 结果必须覆盖全部 Server：只返回失败项会让 ask() 误判「没有可用连接」。
          results = this.servers.connections.map((connection) => {
            if (connection.connected) return { name: connection.name, ok: true, tools: connection.tools.length };
            return (
              retriedByName.get(connection.name) ?? {
                name: connection.name,
                ok: false,
                tools: 0,
                error: connection.lastError ?? undefined,
              }
            );
          });
        }
      } catch (error) {
        results = this.servers.connections.map((connection) => ({
          name: connection.name,
          ok: connection.connected,
          tools: connection.tools.length,
          error: connection.connected ? undefined : (connection.lastError ?? error),
        }));
      }
      for (const result of results) {
        if (!result.ok) this.logger.warn(`MCP 未连接：${result.name} ${result.error?.message ?? ''}`);
      }
      this._lastConnectResults = results.some((result) => !result.ok) ? results : null;
      return results;
    })().finally(() => {
      this._connectPromise = null;
    });
    return this._connectPromise;
  }

  /**
   * 处理一句话（严格串行）。
   *
   * 并发调用会按调用顺序排队执行：否则「先发但较慢的只读请求」晚到的回答会把
   * 「后发请求刚创建的确认」状态置回 IDLE，或者让页面显示的确认与 pending 错配。
   * @param {string} text 用户说/输入的内容
   * @returns {Promise<{kind: 'answer'|'confirm'|'error', text: string, speech: string, tool?: object}>}
   */
  ask(text, options = {}) {
    // 关键：绑定身份必须在「调用 ask 的这一刻」采集，而不是在队列里真正执行时。
    // 这样预先说出的「确认」只能批准调用时就已存在的 pending，绝不能批准之后才生成的写操作。
    // 注意 null 是「明确无效」（如页面尚未显示确认视图），不能回退成执行时再采集。
    const hasBinding = Boolean(options) && Object.prototype.hasOwnProperty.call(options, 'confirmBinding');
    const binding = hasBinding ? options.confirmBinding : this.captureConfirmBinding();
    const run = () => this._askOnce(text, binding);
    const result = this._askChain ? this._askChain.then(run, run) : run();
    this._askChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * 采集当前待确认操作的绑定身份。页面在语音识别/按键发生的瞬间调用，
   * 稍后排队执行时把该身份传给 ask/confirm/cancel 校验。
   * @returns {{version: number, pending: Assistant['pending']}}
   */
  captureConfirmBinding() {
    return { version: this._pendingVersion, pending: this.pending };
  }

  /**
   * 判断绑定身份是否仍是当前显示给用户的 pending。
   * @param {{version?: number, pending?: Assistant['pending']} | null | undefined} binding
   * @returns {boolean}
   */
  _isConfirmBindingCurrent(binding) {
    return Boolean(binding)
      && binding.version === this._pendingVersion
      && binding.pending === this.pending;
  }

  /**
   * 确认态下收到「确认/取消」，但该语句是在当前 pending 生成之前采集的：
   * 绝不能执行，保持确认态并提示用户重新查看后再说。
   * @param {'确认'|'取消'} action
   * @returns {{kind: 'answer', text: string, speech: string, stale: boolean}}
   */
  _staleConfirmAnswer(action) {
    const text = `你刚才说的「${action}」是在当前操作出现前发出的；待确认的操作已更新，请重新查看后再${action}。`;
    return { ...this._answer(text, { keepState: true }), stale: true };
  }

  /**
   * ask 的实际实现，只能由 ask() 串行调用。
   * @param {string} text
   * @param {{version: number, pending: Assistant['pending']}} binding 调用 ask 时采集的确认绑定
   * @returns {Promise<{kind: 'answer'|'confirm'|'error', text: string, speech: string, tool?: object}>}
   */
  async _askOnce(text, binding = this.captureConfirmBinding()) {
    const utterance = String(text ?? '').trim();

    // 确认态下，用户可以直接说「确认 / 取消」。
    // 判定顺序：先取消后确认。取消词按「整词/整句」判定（见 _isCancelUtterance），
    // 确认用整句精确匹配（「好的，改成明天」这类句子不构成确认，旧参数不能被发出去）。
    if (this.state === AssistantState.CONFIRMING) {
      if (this._pendingExpired()) return this._expireConfirm();
      const normalized = this._normalize(utterance);
      // 只有「采集这句话时就已经显示」的 pending 才能被这句话确认/取消；
      // 排队期间 pending 被替换（或从无到有）时，这句话必须失效，保持确认态让用户重新看。
      const bindingCurrent = this._isConfirmBindingCurrent(binding);
      // 取消判定：latin 整词、中文单字整句、多字短语才用包含——避免「特别/now」误取消
      if (this._isCancelUtterance(utterance)) {
        if (!bindingCurrent) return this._staleConfirmAnswer('取消');
        return this.cancel();
      }
      // 确认判定必须整句精确：只说「确认/确定/是的」这类明确肯定
      if (CONFIRM_WORDS.includes(normalized)) {
        if (!bindingCurrent) return this._staleConfirmAnswer('确认');
        return this.confirm();
      }
      // 保持 CONFIRMING：这里不能走会把 state 置回 IDLE 的普通回答，
      // 否则 pending 会永久残留且「确认/取消」之后全部失效。
      return this._answer(
        '当前正在等待确认，请按确认键发送，或按返回键取消；也可以说「确认」或「取消」。',
        { keepState: true },
      );
    }

    if (!utterance) return this._answer('没有听清，请再说一次。');

    try {
      const connectionResults = await this.ensureConnected();
      if (!connectionResults.some((result) => result.ok)) {
        const firstError = connectionResults.find((result) => result.error)?.error;
        return this._error(
          firstError ?? new McpError(McpErrorCode.NETWORK, '没有可用的企业微信 MCP，请重新扫码授权'),
        );
      }
      this._setState(AssistantState.THINKING);
      this._emit('thinking', { utterance });

      if (LIST_INTENT_PATTERN.test(utterance)) {
        return this._answer(this.describeTools());
      }

      const viaModel = await this._askWithLanguageModel(utterance);
      if (viaModel) return viaModel;

      return await this._askWithRules(utterance);
    } catch (error) {
      return this._error(error);
    }
  }

  /**
   * 列出当前可用工具（供用户了解能做什么）。
   * @returns {string}
   */
  describeTools() {
    const tools = this.servers.tools;
    if (tools.length === 0) return '当前没有可用的企业微信工具，请重新扫码授权。';
    const lines = tools.map((tool) => {
      const label = tool.title || tool.description || tool.name;
      return `· ${truncate(label, 28)}`;
    });
    return `可用工具 ${tools.length} 个：\n${lines.join('\n')}`;
  }

  /**
   * 用户确认执行写操作。
   * @returns {Promise<{kind: 'answer'|'error', text: string, speech: string}>}
   */
  async confirm(binding = this.captureConfirmBinding()) {
    if (!this._isConfirmBindingCurrent(binding)) {
      if (!this.pending) {
        this._setState(AssistantState.IDLE);
        return { ...this._answer('没有待确认的操作。'), noPending: true, stale: true };
      }
      const text = '待确认的操作已更新，请重新查看后再按确认键。';
      return { ...this._answer(text, { keepState: true }), stale: true };
    }
    const pending = this.pending;
    if (!pending) {
      this._setState(AssistantState.IDLE);
      return { ...this._answer('没有待确认的操作。'), noPending: true };
    }
    if (this._pendingExpired()) return this._expireConfirm();
    this.pending = null;
    this._setState(AssistantState.THINKING);
    try {
      const result = await this._execute(pending.tool, pending.args);
      return this._answer(result, { kind: 'answer' });
    } catch (error) {
      return this._error(error);
    }
  }

  /**
   * 用户取消写操作。
   * @returns {{kind: 'answer', text: string, speech: string}}
   */
  cancel(binding = this.captureConfirmBinding()) {
    if (!this._isConfirmBindingCurrent(binding)) {
      if (!this.pending) {
        this._setState(AssistantState.IDLE);
        return { ...this._answer('没有待确认的操作。'), noPending: true, stale: true };
      }
      const text = '待确认的操作已更新，请重新查看后再取消。';
      return { ...this._answer(text, { keepState: true }), stale: true };
    }
    if (this._pendingExpired()) return this._expireConfirm();
    this.pending = null;
    this._setState(AssistantState.IDLE);
    return this._answer('已取消。', { speech: '已取消' });
  }

  /**
   * 清掉超时的待确认操作并提示用户重新发起。
   * @returns {{kind: 'answer', text: string, speech: string}}
   */
  _expireConfirm() {
    this.pending = null;
    this._setState(AssistantState.IDLE);
    // expired 标记：页面据此显示「确认已超时」，绝不能因为 kind==='answer' 而显示「已执行」
    return { ...this._answer('确认已超时，请重新说一次。', { speech: '确认已超时，请重新说一次' }), expired: true };
  }

  /**
   * 走 AIUI LanguageModel（把 MCP tools 作为 function tools）。
   * @param {string} utterance
   * @returns {Promise<{kind: 'answer'|'confirm', text: string, speech: string} | null>}
   */
  async _askWithLanguageModel(utterance) {
    const languageModel = this.languageModel;
    if (!languageModel || typeof languageModel.availability !== 'function') return null;

    let availability;
    try {
      availability = await languageModel.availability();
    } catch (error) {
      this.logger.warn('LanguageModel.availability 失败，改用规则匹配', error);
      return null;
    }
    if (availability !== 'available') {
      this.logger.info('LanguageModel 不可用，改用规则匹配');
      return null;
    }

    const tools = this.servers.tools;
    if (tools.length === 0) return null;

    // 模型本轮看到的工具快照必须按「实际发给模型的 function name」绑定：
    // prompt 在途时 refreshTools 可能重排/替换 namespacedName，模型返回后绝不能
    // 再用当前索引重新解析成另一个工具。截断后重名的工具标记为不可用（null），
    // 模型若选中它们就 fail-closed。
    const modelTools = toLanguageModelTools(tools);
    /** @type {Map<string, any>} */
    const toolSnapshot = new Map();
    for (let index = 0; index < tools.length; index += 1) {
      const functionName = modelTools[index].function.name;
      toolSnapshot.set(functionName, toolSnapshot.has(functionName) ? null : tools[index]);
    }
    // function name 在 64 字符处截断：不同工具可能截断成同一个名字。
    // 这类名字不能交给模型（它无法区分），也不能用 map 里后写入的一个去猜；
    // 直接从本轮 tools 中排除，模型若仍返回该名字则由 _handleToolCalls fail-closed。
    const modelToolsSafe = modelTools.filter((tool, index) => toolSnapshot.get(tool.function.name) !== null);
    if (modelToolsSafe.length === 0) {
      this.logger.warn('模型工具名全部截断冲突，本轮不使用模型选工具');
      return null;
    }

    let session;
    try {
      session = await languageModel.create({
        initialPrompts: [{ role: 'system', content: this._systemPrompt() }],
        tools: modelToolsSafe,
      });
    } catch (error) {
      this.logger.warn('LanguageModel.create 失败，改用规则匹配', error);
      return null;
    }

    /** @type {Array<{functionName: string, arguments: any}>} */
    const toolCalls = [];
    const onToolCall = (event) => {
      if (!event || typeof event.functionName !== 'string') return;
      // 契约：arguments 是已解析对象；JSON 非法时为原始字符串，空时为 null
      let args = event.arguments ?? {};
      if (typeof args === 'string') {
        try {
          args = args.trim() ? JSON.parse(args) : {};
        } catch {
          this.logger.warn(`模型工具参数不是合法 JSON：${truncate(args, 40)}`);
          args = {};
        }
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
      toolCalls.push({ functionName: event.functionName, arguments: args });
    };
    let reply;
    try {
      session.addEventListener?.('toolcall', onToolCall);
      reply = await session.prompt(utterance);
    } catch (error) {
      // 只有「模型调用失败」才回退到规则匹配；工具执行失败必须向上抛（见下面单独调用）。
      this.logger.warn('LanguageModel 调用失败，改用规则匹配', error);
      return null;
    } finally {
      try {
        session.removeEventListener?.('toolcall', onToolCall);
        session.destroy?.();
      } catch {
        // 忽略 session 清理失败
      }
    }
    if (toolCalls.length === 0) {
      const text = typeof reply === 'string' && reply.trim() ? reply.trim() : '我没有找到对应的工具。';
      return this._answer(text, { kind: 'answer' });
    }
    // 模型选中的工具交给 _handleToolCalls 执行；执行异常（UNAUTHORIZED/TOOL/网络）不吞，
    // 直接抛给 ask() 的 catch → _error，否则会被规则兜底替换成另一个工具的操作。
    return await this._handleToolCalls(toolCalls, toolSnapshot);
  }

  /**
   * 校验「模型本轮看到的工具快照」仍是当前索引里的同一工具。
   * 任一身份/服务端/schema/annotations/读写语义变化都 fail-closed，绝不换用当前索引里的另一个工具。
   * @param {any} expected 模型工具清单里的快照
   * @param {string} namespacedName 该快照在清单里的查找名
   * @returns {any} 仍有效的快照（供后续执行携带 expectedTool）
   */
  _assertToolSnapshotCurrent(expected, namespacedName) {
    const current = this.servers.findTool(namespacedName);
    if (!current) {
      const error = new McpError(McpErrorCode.TOOL, `工具已不存在：${namespacedName}，请重新发起请求`);
      error.failClosed = true;
      throw error;
    }
    const reasons = [];
    const compare = (key, label) => {
      if (expected[key] === undefined || current[key] === undefined) return;
      if (canonicalToolJson(expected[key]) !== canonicalToolJson(current[key])) reasons.push(label);
    };
    compare('toolId', '工具身份');
    compare('connectionId', '服务端连接');
    compare('name', '原始工具名');
    compare('serverName', '服务端名称');
    compare('write', '只读/写语义');
    compare('inputSchema', 'inputSchema');
    compare('annotations', 'annotations');
    if (reasons.length > 0) {
      const error = new McpError(
        McpErrorCode.TOOL,
        `工具身份或权限已变化（${reasons.join('、')}），请重新发起请求`,
        { serverName: expected.serverName },
      );
      error.failClosed = true;
      throw error;
    }
    return expected;
  }

  /**
   * 下载类工具缺少文件定位信息时只提示用户补充，绝不退化成列表/搜索等「看起来相关」的只读工具。
   * disk_files_download_submit 的 file_id/url 在 schema 里是二选一的可选字段，
   * 不能因为都不是 required 就带着空参数提交下载任务。
   * @param {any} tool
   * @param {Record<string, unknown>} args
   * @returns {string | null} 需要用户补充时的提示
   */
  _missingDownloadInput(tool, args) {
    if (!/download/i.test(String(tool?.name ?? ''))) return null;
    const properties = tool?.inputSchema?.properties ?? {};
    const choices = ['file_id', 'url'].filter((key) => Object.prototype.hasOwnProperty.call(properties, key));
    if (choices.length === 0) return null;
    const provided = choices.some((key) => {
      const value = args?.[key];
      return value !== undefined && value !== null && String(value).trim() !== '';
    });
    if (provided) return null;
    return '请提供要下载的文件 ID 或 URL，我再帮你提交下载；不会用列表或搜索工具代替下载。';
  }

  /**
   * @param {Array<{functionName: string, arguments: any}>} toolCalls
   * @param {Map<string, any> | null} [toolSnapshot] 模型本轮看到的工具快照（function name → tool）
   * @returns {Promise<{kind: 'answer'|'confirm', text: string, speech: string, tool?: object}>}
   */
  async _handleToolCalls(toolCalls, toolSnapshot = null) {
    /** @type {string[]} */
    const outputs = [];
    for (const call of toolCalls.slice(0, 3)) {
      // 有快照时必须命中本轮清单；命中 null 表示函数名截断后冲突，不能猜测是哪一个工具
      const bound = toolSnapshot ? toolSnapshot.get(call.functionName) : undefined;
      if (toolSnapshot && !bound) {
        const error = new McpError(
          McpErrorCode.TOOL,
          `模型调用的工具「${call.functionName}」不在本轮工具清单中或名称冲突，请重新发起请求`,
        );
        error.failClosed = true;
        throw error;
      }
      const expected = bound ?? null;
      const tool = expected
        ? this._assertToolSnapshotCurrent(expected, expected.namespacedName)
        : this.servers.findTool(call.functionName);
      if (!tool) {
        const error = new McpError(McpErrorCode.TOOL, `工具已不存在：${call.functionName}，请重新发起请求`);
        error.failClosed = true;
        throw error;
      }
      let args;
      try {
        args = coerceArguments(tool.inputSchema, call.arguments).args;
      } catch (error) {
        if (error instanceof ToolArgumentError) {
          return this._answer(`还缺少信息：${error.message}。请补充后再说一次。`);
        }
        throw error;
      }
      const missingDownloadInput = this._missingDownloadInput(tool, args);
      if (missingDownloadInput) return this._answer(missingDownloadInput);
      if (tool.write) {
        return this._requestConfirm(tool, args, outputs.length > 0 ? outputs.join('\n') : '');
      }
      outputs.push(await this._execute(tool, args));
    }
    if (outputs.length === 0) {
      return this._answer('没有找到可以处理这句话的工具，可以说「有哪些工具」查看能力。');
    }
    return this._answer(outputs.join('\n'));
  }

  /**
   * 语言模型不可用时的确定性兜底。
   * @param {string} utterance
   * @returns {Promise<{kind: 'answer'|'confirm', text: string, speech: string}>}
   */
  async _askWithRules(utterance) {
    const tools = this.servers.tools;
    const matched = matchToolByText(utterance, tools);
    if (!matched) {
      return this._answer(
        `没有找到能处理「${truncate(utterance, 20)}」的工具。可以说「有哪些工具」看看能做什么。`,
      );
    }
    // 规则匹配用的也是本次 tools 快照；执行前必须确认它仍映射到同一工具，
    // 不能因为 namespacedName 在匹配后被重排/替换就去调用另一个工具。
    const tool = this._assertToolSnapshotCurrent(matched.tool, matched.tool.namespacedName);
    const inferred = inferArguments(tool.inputSchema, utterance);
    let args;
    try {
      args = coerceArguments(tool.inputSchema, inferred).args;
    } catch (error) {
      if (error instanceof ToolArgumentError) {
        return this._answer(`${tool.title || tool.description || tool.name}：${error.message}。请补充后再试。`);
      }
      throw error;
    }
    const missingDownloadInput = this._missingDownloadInput(tool, args);
    if (missingDownloadInput) return this._answer(missingDownloadInput);
    if (tool.write) {
      return this._requestConfirm(tool, args);
    }
    return this._answer(await this._execute(tool, args));
  }

  /**
   * 生成确认请求，等待用户确认后再执行。
   * @param {object} tool
   * @param {Record<string, unknown>} args
   * @param {string} [preface] 同一轮里已执行的只读结果，作为确认文案的补充展示
   * @returns {{kind: 'confirm', text: string, speech: string, tool: object}}
   */
  _requestConfirm(tool, args, preface = '') {
    const { title, detail } = describeToolAction(tool, args);
    // 已执行的只读结果不能丢：拼进确认详情，用户在确认页能同时看到上下文与待确认操作
    const fullDetail = preface ? `${preface}\n${detail}` : detail;
    this._pendingVersion += 1;
    this.pending = {
      namespacedName: tool.namespacedName,
      tool,
      args,
      title,
      detail: fullDetail,
      createdAt: this.now().getTime(),
    };
    this._setState(AssistantState.CONFIRMING);
    this._emit('confirm', { tool, args, title, detail: fullDetail });
    const text = preface
      ? `已执行：\n${preface}\n需要确认：${title}\n${detail}\n按确认键发送，按返回键取消`
      : `需要确认：${title}\n${detail}\n按确认键发送，按返回键取消`;
    return { kind: 'confirm', text, speech: `确认${truncate(title, 24)}吗？`, tool };
  }

  /**
   * 真正调用 MCP 工具并格式化结果。
   * @param {object} tool
   * @param {Record<string, unknown>} args
   * @returns {Promise<string>}
   */
  async _execute(tool, args) {
    try {
      const result = await this.servers.callTool(tool.namespacedName, args, {
        timeoutMs: this.callTimeoutMs,
        // 身份快照：callTool 会按当前索引逐项核对 toolId/connectionId/原始工具名/服务端/
        // 读写语义/inputSchema/annotations（完整 JSON 精确比较）；工具被拒绝暴露、替换或
        // 重连后变化时 fail-closed，不执行被替换的工具。
        expectedTool: tool,
      });
      // 工具级失败（isError / 企业微信业务错误）必须当失败向上抛：
      // 否则页面会把「失败：…」当成已执行的成功回答，写操作尤其危险。
      if (result && result.ok === false) {
        throw new McpError(McpErrorCode.TOOL, result.text, { serverName: tool.serverName });
      }
      const text = formatForGlasses(result, {
        maxChars: this.maxDisplays,
        serverName: tool.serverName,
        toolLabel: tool.title || tool.name,
      });
      this.logger.debug(`工具 ${tool.namespacedName} 调用完成`);
      return text;
    } catch (error) {
      throw error instanceof McpError ? error : new McpError(McpErrorCode.UNKNOWN, String(error?.message ?? error));
    }
  }

  /**
   * 系统提示词：约束模型只做工具选择。
   * @returns {string}
   */
  _systemPrompt() {
    const now = this.now();
    const servers = this.servers.connections.map((connection) => connection.name).join('、');
    return [
      '你是运行在乐奇 Rokid AI 眼镜上的企业微信助手。',
      '根据用户的中文口语，选择合适的工具并填好参数；如果不需要调用工具，用一句简短中文回答。',
      '规则：',
      '1. 只使用已提供的工具，不要编造工具名或参数。',
      `2. 当前时间：${this._formatTime(now)}；提到「今天/明天」时按这个时间换算。`,
      `3. 可用 MCP：${servers || '无'}。`,
      '4. 参数尽量使用中文原文，不要臆造会话 ID、文档 ID 等标识。',
      '5. 回答不超过 40 个汉字，适合语音播报。',
    ].join('\n');
  }

  /**
   * @param {Date} date
   * @returns {string}
   */
  _formatTime(date) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} 星期${'日一二三四五六'[date.getDay()]}`;
  }

  /**
   * 是否为「取消」语句。确认态下先于确认词判定，但必须避免误取消：
   *   - 中文多字短语：包含即取消（取消/算了/不要…）；
   *   - 中文单字「别/停」：仅整句（可带语气词），避免「特别是」「停车场」误取消；
   *   - 英文词：去掉非字母字符后按整词边界匹配，避免 now/nothing/north 命中 no。
   * @param {string} text
   * @returns {boolean}
   */
  _isCancelUtterance(text) {
    const normalized = this._normalize(text);
    if (!normalized) return false;
    if (CANCEL_PHRASES.some((word) => normalized.includes(word))) return true;
    if (CANCEL_SINGLE_WORDS.some((word) => new RegExp(`^${word}[了罢吧啊呀哦了呢]?$`).test(normalized))) return true;
    const latinOnly = String(text ?? '')
      .toLowerCase()
      .replace(/[^a-z]+/g, ' ')
      .trim();
    if (!latinOnly) return false;
    const words = latinOnly.split(/\s+/);
    return words.some((word) => CANCEL_LATIN_WORDS.includes(word));
  }

  /**
   * 把一句口语规范化成用于精确匹配的整句：小写、去空白、去标点。
   * @param {string} text
   * @returns {string}
   */
  _normalize(text) {
    return String(text ?? '')
      .toLowerCase()
      .replace(/[\s\u3000]+/g, '')
      .replace(/[，。！？、；：,.!?;:"'“”‘’（）()【】\[\]《》<>~—\-_/\\·…]/g, '');
  }

  /** 当前待确认操作是否已超时。 */
  _pendingExpired() {
    const pending = this.pending;
    if (!pending || typeof pending.createdAt !== 'number') return false;
    return this.now().getTime() - pending.createdAt > this.confirmTimeoutMs;
  }

  /**
   * @param {string} text
   * @param {{kind?: 'answer'|'error', speech?: string, keepState?: boolean}} [options]
   *   keepState=true 时保留当前状态机状态（用于确认态下重复提示，不能让 pending 失联）
   * @returns {{kind: 'answer', text: string, speech: string}}
   */
  _answer(text, options = {}) {
    const value = String(text ?? '').trim() || '（无内容）';
    if (!options.keepState) this._setState(AssistantState.IDLE);
    this.lastAnswer = value;
    this._emit('answer', { text: value });
    return {
      kind: options.kind ?? 'answer',
      text: value,
      speech: options.speech ?? toSpeechText(value),
    };
  }

  /**
   * @param {unknown} error
   * @returns {{kind: 'error', text: string, speech: string}}
   */
  _error(error) {
    const classified =
      error instanceof McpError
        ? error
        : new McpError(McpErrorCode.UNKNOWN, String(error?.message ?? error ?? '未知错误'));
    const text = formatError(classified);
    this._setState(AssistantState.ERROR);
    this.lastAnswer = text;
    this.logger.warn(`助手错误：${classified.code} ${classified.message}`);
    this._emit('error', { error: classified, text });
    // 带上错误码/是否需重新扫码：页面据此决定「重连」「重新扫码」还是「重新提问」
    return {
      kind: 'error',
      text,
      speech: toSpeechText(text),
      code: classified.code,
      needRescan: Boolean(classified.needRescan),
      // 工具身份/权限在确认后变化：底层已 fail-closed，页面必须引导重新发起，不能重试/换工具
      failClosed: Boolean(classified.failClosed),
    };
  }
}
