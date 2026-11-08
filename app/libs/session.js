// 应用级会话单例：把「配置 → MCP 连接 → 助手 → 语音」串起来，供各页面共享。
//
// AIUI 运行时是单实例的（页面切换不重建 JS 引擎），因此 MCP 连接放在模块级单例里，
// 避免每次进入页面都重新 initialize 企业微信 MCP。
import wx from 'wx';
import { ConfigStore, createWxStorage, summarizeConfig } from './config-store.js';
import { McpErrorCode, McpServers } from './mcp-servers.js';
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
  // 业务错误信息通常已带「Server 名：」前缀，避免重复拼接
  if (message.startsWith(`${name}：`)) return message;
  return message || `${name}：授权状态未确认`;
}

/**
 * 在保存前用一次性连接探测配置：连接、拉工具清单、实调只读工具验证授权，
 * 让用户先看到「能用哪些工具」再决定是否保存。
 *
 * 授权判定约定（scan 页依赖）：
 *   - 只有 UNAUTHORIZED（apikey 失效 / HTTP 401）才 authFailed 并阻止保存；
 *   - FORBIDDEN（851008 等能力位/子能力未授权）、连接失败、没有可探测的只读工具
 *     都只进 warnings，不阻止保存；
 *   - 返回 `{ok, tools, toolCount, authFailed, warnings}`。
 * @param {Array<{name: string, url: string}>} serverConfigs
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{ok: boolean, error?: any, tools: Array<{name: string, serverName: string, write: boolean}>, toolCount: number, authFailed: boolean, warnings: string[]}>}
 */
export async function probeServers(serverConfigs, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const probe = new McpServers(serverConfigs, {
    logger: getLogger(),
    timeoutMs,
    callTimeoutMs: timeoutMs,
  });
  /** @type {string[]} */
  const warnings = [];
  // 同一个 Server 的失败可能同时来自「连接失败」和后面的 verify 探测，
  // 这里按 name 去重并统一补一次「name：」前缀，避免扫码页出现两条语义相同的警告。
  const pushProbeWarning = (name, message) => {
    const raw = String(message ?? '').trim();
    if (!raw) return;
    if (warnings.some((warning) => warning.startsWith(`${name}：`))) return;
    // 错误信息本身可能已带 Server 名（如「坏 MCP网络请求失败」），先剥掉再统一拼一次前缀
    const bare = raw.startsWith(name) ? raw.slice(name.length).replace(/^[：:]/, '').trim() : raw;
    const text = raw.startsWith(`${name}：`) ? raw : `${name}：${bare || '连接失败'}`;
    if (!warnings.includes(text)) warnings.push(text);
  };
  try {
    const results = await probe.connectAll({ timeoutMs });
    for (const result of results) {
      if (result.ok) continue;
      pushProbeWarning(result.name, result.error?.message ?? '连接失败');
    }
    const ready = results.filter((result) => result.ok).length;
    if (ready === 0) {
      const unauthorized = results.find((result) => result.error?.code === McpErrorCode.UNAUTHORIZED);
      return {
        ok: false,
        error: unauthorized?.error ?? results[0]?.error ?? new Error('无法连接该 MCP'),
        tools: [],
        toolCount: 0,
        authFailed: Boolean(unauthorized),
        warnings,
      };
    }
    const verifies = await probe.verifyAuthorizationAll({ timeoutMs: 12000 });
    let authError = null;
    for (const item of verifies) {
      if (item.verified) continue;
      if (item.error?.code === McpErrorCode.UNAUTHORIZED) {
        authError ??= item;
        continue;
      }
      pushProbeWarning(item.name, describeVerifyWarning(item));
    }
    if (authError) {
      return {
        ok: false,
        error: authError.error,
        tools: [],
        toolCount: 0,
        authFailed: true,
        warnings,
      };
    }
    const tools = probe.tools.map((tool) => ({
      name: tool.name,
      serverName: tool.serverName,
      write: tool.write,
    }));
    return { ok: true, tools, toolCount: tools.length, authFailed: false, warnings };
  } finally {
    try {
      await probe.closeAll();
    } catch (error) {
      getLogger().warn('关闭探测连接失败', error);
    }
  }
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
