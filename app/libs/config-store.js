// MCP 配置的持久化与安全边界。
//
// 安全事实（见 AIUI 官方契约）：AIUI 只提供 wx.*Storage / localStorage，
// **没有 secure storage / keychain / 加密存储**，且按 Agent 隔离。
// 因此这里：
//   - 默认「持久化」模式：把配置明文写进 Agent 隔离的 Storage，并在 UI 中明确告知限制；
//   - 提供「仅本次会话」模式：只放内存，进程退出即失效（敏感场景推荐）；
//   - 任何情况下都不把 URL / API Key 写进日志（由 log.js 统一脱敏）。
//
// 不根据本地保存时间推算凭据是否过期；授权可用性以 MCP 服务端实际调用结果为准。
import { ConfigError, maskUrl, validateServer } from './qr-payload.js';

export const STORAGE_KEY = 'rokid-wecom-assistant:config:v1';
/**
 * @typedef {{name: string, url: string}} ServerConfig
 * @typedef {{servers: ServerConfig[], savedAt: number, mode: 'persistent'|'session'}} StoredConfig
 */

export class ConfigStore {
  /**
   * @param {{storage: {get: (key: string) => unknown, set: (key: string, value: unknown) => void, remove: (key: string) => void}, logger?: any}} deps
   */
  constructor(deps) {
    if (!deps || !deps.storage) throw new Error('ConfigStore 需要 storage 适配器');
    this._storage = deps.storage;
    this._logger = deps.logger ?? null;
    /** 仅本次会话使用的配置（不落盘） @type {StoredConfig | null} */
    this._session = null;
  }

  /**
   * 读取已保存的配置。
   * @returns {{servers: ServerConfig[], savedAt: number, mode: 'persistent'|'session'} | null}
   */
  load() {
    if (this._session) return this._describe(this._session);
    let raw;
    try {
      raw = this._storage.get(STORAGE_KEY);
    } catch (error) {
      this._logger?.warn?.('读取配置失败', error);
      return null;
    }
    if (!raw || typeof raw !== 'object') return null;
    const record = /** @type {Record<string, any>} */ (raw);
    if (!Array.isArray(record.servers) || record.servers.length === 0) return null;
    try {
      const servers = record.servers.map((server, index) => validateServer(server, index));
      return this._describe({ servers, savedAt: Number(record.savedAt) || 0, mode: 'persistent' });
    } catch (error) {
      this._logger?.warn?.('已保存的配置无效，需要重新扫码', error instanceof ConfigError ? error.message : error);
      return null;
    }
  }

  /**
   * 保存配置。
   * @param {{servers: ServerConfig[]}} config
   * @param {{persist?: boolean}} [options]
   * @returns {{servers: ServerConfig[], savedAt: number, mode: 'persistent'|'session'}}
   */
  save(config, options = {}) {
    const servers = (config?.servers ?? []).map((server, index) => validateServer(server, index));
    if (servers.length === 0) throw new ConfigError('INVALID_SERVERS', '没有可保存的 MCP 配置');
    /** @type {StoredConfig} */
    const stored = {
      servers,
      savedAt: Date.now(),
      mode: options.persist === false ? 'session' : 'persistent',
    };
    if (stored.mode === 'persistent') {
      // 仅保存 version/savedAt/servers 三个字段，避免未来字段被误当配置持久化
      this._storage.set(STORAGE_KEY, {
        version: 1,
        savedAt: stored.savedAt,
        servers: stored.servers,
      });
      this._session = null;
    } else {
      // 仅本次会话：除了不落盘，还要清掉此前可能保存的持久化配置，
      // 否则用户选了「退出即失效」后，旧 URL/API Key 仍会在下次启动被读回来。
      // 这一步失败必须 fail-closed：不能返回「仅本次会话保存成功」而让旧凭据继续留在本机。
      this._session = stored;
      try {
        this._storage.remove(STORAGE_KEY);
        // 删除后再读一次做二次确认：存储层可能静默失败，旧配置还在就按失败处理。
        if (this._storage.get(STORAGE_KEY)) {
          throw new ConfigError('SESSION_CLEANUP_FAILED', '本机旧配置未能清除');
        }
      } catch (error) {
        this._session = null;
        this._logger?.warn?.('清理旧配置失败，已取消本次保存', error);
        if (error instanceof ConfigError) throw error;
        throw new ConfigError(
          'SESSION_CLEANUP_FAILED',
          '无法清除本机已保存的配置：为避免旧 API Key 残留，已取消本次保存。请重试，或改用「保存到本机」覆盖旧配置',
        );
      }
    }
    this._logger?.info?.(`MCP 配置已保存（${stored.mode === 'persistent' ? '持久化' : '仅本次会话'}），共 ${stored.servers.length} 个`);
    return this._describe(stored);
  }

  /**
   * 删除已保存的配置（含仅会话模式）。
   *
   * 删除失败必须抛错（fail-closed）：调用方（session.deleteConfig → 首页）只有拿到成功
   * 才能提示「已删除」，否则用户会以为凭据已清除，重启后旧 URL/API Key 又会被读回来。
   */
  clear() {
    this._session = null;
    try {
      this._storage.remove(STORAGE_KEY);
      if (this._storage.get(STORAGE_KEY)) {
        throw new ConfigError('CLEANUP_FAILED', '本机配置未能删除');
      }
    } catch (error) {
      this._logger?.warn?.('删除配置失败', error);
      if (error instanceof ConfigError) throw error;
      throw new ConfigError('CLEANUP_FAILED', '无法删除本机保存的配置，请重试；若反复失败请清理应用存储后再试');
    }
  }

  /**
   * @param {StoredConfig} stored
   */
  _describe(stored) {
    return {
      servers: stored.servers,
      savedAt: stored.savedAt,
      mode: stored.mode,
    };
  }
}

/**
 * 基于 `wx.setStorageSync` 的适配器（AIUI 运行时的标准存储）。
 * @param {{setStorageSync: Function, getStorageSync: Function, removeStorageSync: Function}} wx
 */
export function createWxStorage(wx) {
  return {
    /** @param {string} key */
    get(key) {
      return wx.getStorageSync(key);
    },
    /**
     * @param {string} key
     * @param {unknown} value
     */
    set(key, value) {
      wx.setStorageSync(key, value);
    },
    /** @param {string} key */
    remove(key) {
      wx.removeStorageSync(key);
    },
  };
}

/**
 * 生成配置摘要（脱敏），用于启动页/设置页展示。
 * @param {{servers: ServerConfig[]}} config
 * @returns {Array<{name: string, maskedUrl: string}>}
 */
export function summarizeConfig(config) {
  return (config?.servers ?? []).map((server) => ({
    name: server.name,
    maskedUrl: maskUrl(server.url),
  }));
}
