// 应用级会话单例：把「配置 → MCP 连接 → 助手 → 语音」串起来，供各页面共享。
//
// AIUI 运行时是单实例的（页面切换不重建 JS 引擎），因此 MCP 连接放在模块级单例里，
// 避免每次进入页面都重新 initialize 企业微信 MCP。
import wx from 'wx';
import { ConfigStore, createWxStorage, summarizeConfig } from './config-store.js';
import { McpErrorCode, McpServers, isWriteTool } from './mcp-servers.js';
import { Assistant } from './assistant.js';
import { VoiceController } from './voice.js';
import { createLogger } from './log.js';
import { validatePayload } from './qr-payload.js';

const CONNECT_TIMEOUT_MS = 20000;
const CALL_TIMEOUT_MS = 30000;

let logger = null;
/** @type {ConfigStore | null} */
let store = null;
/** @type {ReturnType<ConfigStore['load']>} */
let configInfo = null;
/** @type {McpServers | null} */
let servers = null;
/** @type {Assistant | null} */
let assistant = null;
/** @type {VoiceController | null} */
let voice = null;
/** @type {any} */
let languageModel = null;
let languageModelResolved = false;
let initPromise = null;
/** 扫码页写回的结果 @type {{payload: object} | null} */
let scanResult = null;

/** @returns {ReturnType<typeof createLogger>} */
export function getLogger() {
  if (!logger) logger = createLogger({ level: 'info', scope: 'wecom' });
  return logger;
}

/**
 * 解析 AIUI 内置 LanguageModel（不可用时为 null，助手会自动降级为规则匹配）。
 * @returns {Promise<any>}
 */
async function resolveLanguageModel() {
  if (languageModelResolved) return languageModel;
  languageModelResolved = true;
  if (globalThis.LanguageModel) {
    languageModel = globalThis.LanguageModel;
    return languageModel;
  }
  try {
    const module = await import('language-model');
    languageModel = module?.LanguageModel ?? module?.default ?? null;
  } catch {
    languageModel = null;
  }
  return languageModel;
}

/** 初始化会话（幂等；初始化失败不缓存 rejected，避免之后永久拿不到 session）。 */
export async function initSession() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    getLogger().info('Rokid 企业微信助手启动');
    store = new ConfigStore({ storage: createWxStorage(wx), logger: getLogger() });
    configInfo = store.load();
    voice = new VoiceController({ logger: getLogger() });
    await resolveLanguageModel();
    if (!languageModel) getLogger().warn('LanguageModel 不可用，将使用关键词规则选择工具');
    buildServers();
    return configInfo;
  })();
  try {
    return await initPromise;
  } catch (error) {
    initPromise = null;
    throw error;
  }
}

/** 依据当前配置创建 MCP 连接集合与助手。 */
function buildServers() {
  const configs = configInfo?.servers ?? [];
  servers = new McpServers(configs, {
    logger: getLogger(),
    timeoutMs: CONNECT_TIMEOUT_MS,
    callTimeoutMs: CALL_TIMEOUT_MS,
  });
  assistant = new Assistant({
    servers,
    languageModel,
    logger: getLogger(),
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    callTimeoutMs: CALL_TIMEOUT_MS,
  });
}

/** @returns {Promise<Assistant>} */
export async function getAssistant() {
  await initSession();
  return assistant;
}

/** @returns {Promise<VoiceController>} */
export async function getVoice() {
  await initSession();
  return voice;
}

/** @returns {ReturnType<ConfigStore['load']>} */
export function getConfigInfo() {
  return configInfo;
}

/** @returns {McpServers | null} */
export function getServers() {
  return servers;
}

/**
 * 保存扫码得到的配置并重建连接。
 * @param {{payload: object, persist?: boolean}} input payload 已通过 validatePayload 校验
 * @returns {Promise<{servers: Array<{name: string, url: string}>, mode: 'persistent'|'session'}>}
 */
export async function saveConfigFromScan(input) {
  await initSession();
  const payload = validatePayload(input.payload);
  const previous = servers;
  configInfo = store.save({ servers: payload.servers }, { persist: input.persist !== false });
  buildServers();
  if (previous) {
    try {
      await previous.closeAll();
    } catch (error) {
      getLogger().warn('关闭旧 MCP 连接失败', error);
    }
  }
  return { servers: configInfo.servers, mode: configInfo.mode };
}

/** 删除配置并断开所有连接。 */
export async function deleteConfig() {
  await initSession();
  const previous = servers;
  store.clear();
  configInfo = null;
  buildServers();
  if (previous) {
    try {
      await previous.closeAll();
    } catch (error) {
      getLogger().warn('关闭 MCP 连接失败', error);
    }
  }
  getLogger().info('已删除 MCP 配置');
}

/**
 * 把一次授权探测的失败项转成面向用户的提示（不阻止保存）。
 * @param {{name?: string, reason?: string, error?: any}} item
 * @returns {string}
 */
function describeVerifyWarning(item) {
  const name = item.name ?? '';
  const message = String(item.error?.message ?? '');
  if (item.reason === 'capability-unauthorized') {
    return `${name}：部分能力未授权，保存后仍可使用已授权的工具（可在智能机器人「可使用权限」中补充授权）`;
  }
  if (item.reason === 'no-probe-tool') {
    return `${name}：没有可验证授权的只读工具，授权状态未确认`;
  }
  if (item.reason === 'not-connected') {
    return `${name}：未连接${message ? `（${message}）` : ''}`;
  }
  // 非授权错误不能证明授权有效，必须明确提示状态未确认。
  const detail = message.startsWith(`${name}：`) ? message.slice(name.length + 1) : message;
  return `${name}：授权状态未确认${detail ? `（${detail}）` : ''}`;
}

/**
 * 扫码探测：整轮共享绝对截止时间，并仅复用同一完整配置中已完成的结果。
 * verified 与 warning 都是终态，但 warning 绝不表示授权已验证。网络失败留待重试；
 * apikey 无效阻止保存；无探针/能力不足维持原有带警告保存语义。
 * cache 含凭据，只能留在页面内存，不能传给 setData/日志/持久化。
 * @param {Array<{name: string, url: string}>} serverConfigs
 * @param {{timeoutMs?: number, signal?: AbortSignal, cache?: any}} [options]
 */
export async function probeServers(serverConfigs, options = {}) {
  const timeoutMs = options.timeoutMs ?? 150000;
  const signature = JSON.stringify(serverConfigs.map(({ name, url }) => [name, url]));
  const previous = options.cache?.signature === signature && Array.isArray(options.cache.entries)
    ? options.cache.entries : [];
  const entries = serverConfigs.map((_, index) => {
    const entry = previous[index];
    return entry && (entry.status === 'verified' || entry.status === 'warning') ? entry : null;
  });
  const probe = new McpServers(serverConfigs, { logger: getLogger() });
  const controller = new AbortController();
  let timedOut = false;
  let externallyCancelled = false;
  let timer;
  let stopped;
  let closing = false;
  const deadline = Date.now() + timeoutMs;
  const stop = new Promise((resolve) => { stopped = resolve; });
  const cancel = () => {
    if (!controller.signal.aborted) controller.abort();
    // closeAll 也负责关闭已连接的 transport；不可等待不遵守取消的宿主。
    if (!closing) {
      closing = true;
      Promise.resolve(probe.closeAll()).catch((error) => getLogger().warn('关闭探测连接失败', error));
    }
    stopped();
  };
  const onExternalAbort = () => { externallyCancelled = true; cancel(); };
  if (options.signal?.aborted) onExternalAbort();
  else options.signal?.addEventListener?.('abort', onExternalAbort, { once: true });
  if (!controller.signal.aborted) {
    timer = setTimeout(() => { timedOut = true; cancel(); }, Math.max(0, timeoutMs));
  }
  const expired = () => {
    if (!controller.signal.aborted && Date.now() >= deadline) {
      timedOut = true;
      cancel();
    }
    return controller.signal.aborted;
  };
  let nextIndex = 0;
  const worker = async () => {
    while (!expired()) {
      const index = nextIndex++;
      if (index >= serverConfigs.length) return;
      if (entries[index]) continue;
      const connection = probe.connections[index];
      const remaining = () => Math.max(1, deadline - Date.now());
      try {
        await connection.connect({ timeoutMs: Math.min(30000, remaining()), signal: controller.signal });
        if (expired()) return;
        const result = await connection.verifyAuthorization({
          timeoutMs: Math.min(30000, remaining()), signal: controller.signal, retry: false,
        });
        if (expired()) return;
        const tools = connection.tools.map((tool) => ({
          name: tool.name, serverName: connection.name, write: isWriteTool(tool),
        }));
        if (result.verified) {
          entries[index] = { status: 'verified', tools };
        } else if (result.error?.code === McpErrorCode.UNAUTHORIZED) {
          entries[index] = { status: 'unauthorized', error: result.error };
        } else if (result.error?.retryable || result.error?.code === McpErrorCode.TIMEOUT || result.error?.code === McpErrorCode.NETWORK) {
          entries[index] = { status: 'retry', error: result.error };
        } else {
          entries[index] = { status: 'warning', tools, warning: describeVerifyWarning({ name: connection.name, ...result }) };
        }
      } catch (error) {
        if (expired()) return;
        entries[index] = { status: error?.code === McpErrorCode.UNAUTHORIZED ? 'unauthorized' : 'retry', error };
      }
    }
  };
  try {
    if (!expired()) {
      const work = Promise.all(Array.from({ length: Math.min(4, serverConfigs.length) }, () => worker()));
      await Promise.race([work, stop]);
      expired();
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener?.('abort', onExternalAbort);
    cancel();
  }
  const auth = entries.find((entry) => entry?.status === 'unauthorized');
  const hasFailed = entries.some((entry) => !entry || entry.status === 'retry');
  const failed = entries.find((entry) => entry?.status === 'retry');
  const completed = entries.filter((entry) => entry?.status === 'verified' || entry?.status === 'warning');
  const tools = completed.flatMap((entry) => entry.tools ?? []);
  const warnings = completed.filter((entry) => entry.status === 'warning').map((entry) => entry.warning);
  const error = auth?.error ?? failed?.error ?? (timedOut ? new Error('验证授权超时，请重试失败项') : undefined);
  return {
    ok: !timedOut && !externallyCancelled && !auth && !hasFailed && completed.length > 0,
    authFailed: Boolean(auth), error, tools, toolCount: tools.length, warnings,
    completedCount: completed.length, totalCount: serverConfigs.length,
    cache: { signature, entries: entries.map((entry) =>
      entry?.status === 'verified' || entry?.status === 'warning' ? entry : null) },
  };
}

/**
 * 连接并验证授权。
 * @param {{onProgress?: (stage: string, info?: object) => void}} [options]
 * @returns {Promise<{results: Array<{name: string, ok: boolean, tools: number, error?: any}>, verifies: Array<{name: string, verified: boolean, reason?: string, error?: any}>, ready: number, tools: number}>}
 */
export async function connectAndVerify(options = {}) {
  const current = await getAssistant();
  // 用 Assistant 自己持有的 servers，避免并发重建配置时读到模块级旧/新实例不一致
  const currentServers = current?.servers ?? servers;
  options.onProgress?.('connecting');
  const results = await current.ensureConnected();
  options.onProgress?.('verifying');
  const verifies = await currentServers.verifyAuthorizationAll({ timeoutMs: 15000 });
  const ready = currentServers.readyCount;
  const tools = currentServers.tools.length;
  return { results, verifies, ready, tools };
}

/**
 * 供 UI 展示的 Server 摘要（含脱敏 URL、工具数、状态）。
 * @returns {Array<{name: string, maskedUrl: string, tools: number, status: string, error: string}>}
 */
export function describeServers() {
  if (!servers) return [];
  return servers.connections.map((connection) => ({
    name: connection.name,
    maskedUrl: connection.maskedUrl,
    tools: connection.tools.length,
    status: connection.connected ? 'ready' : connection.status,
    error: connection.lastError?.message ?? '',
  }));
}

/** @returns {{servers: Array<{name: string, maskedUrl: string}>, mode: string}} */
export function describeConfig() {
  const info = configInfo;
  return {
    servers: summarizeConfig(info),
    mode: info?.mode ?? 'none',
  };
}

/**
 * 扫码页把结果写回（页面间用模块级状态传递，避免长 URL 走 query）。
 * @param {{payload: object} | null} result
 */
export function setScanResult(result) {
  scanResult = result;
}

/** @returns {{payload: object} | null} */
export function takeScanResult() {
  const result = scanResult;
  scanResult = null;
  return result;
}

/** 释放全部资源并复位模块状态（退出助手 / 重新初始化时调用）。 */
export async function disposeSession() {
  voice?.abort?.();
  voice?.stopSpeaking?.();
  try {
    await servers?.closeAll();
  } catch (error) {
    getLogger().warn('关闭 MCP 连接失败', error);
  }
  servers = null;
  assistant = null;
  store = null;
  configInfo = null;
  voice = null;
  scanResult = null;
  // initPromise 必须一起复位：否则 disposeSession 之后 getAssistant() 会拿到 null
  initPromise = null;
}
