// 从本地 JSON 或纯文本文件读取多个 MCP URL。文件可能含真实 API Key，错误信息绝不回显文件内容。
import { readFile, stat } from 'node:fs/promises';
import { ConfigError, LIMITS } from '../../app/libs/qr-payload.js';
import { displayNameForCapability, inspectMcpUrl } from './wecom.mjs';

export const MAX_SERVER_FILE_BYTES = 256 * 1024;

/**
 * 解析 JSON {servers:[{name?,url}]} / [{name?,url}]，或每行一个完整 URL 的文本文件。
 * @param {string} filePath
 * @returns {Promise<Array<{name: string, url: string, apikey: null, capabilityId: null}>>}
 */
export async function readServerFile(filePath) {
  let content;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new ConfigError('INVALID_SERVER_FILE', '配置路径不是普通文件');
    if (info.size > MAX_SERVER_FILE_BYTES) {
      throw new ConfigError('SERVER_FILE_TOO_LARGE', `配置文件不能超过 ${MAX_SERVER_FILE_BYTES} 字节`);
    }
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('SERVER_FILE_READ_FAILED', `无法读取配置文件（${error?.code || 'IO_ERROR'}）`);
  }

  const trimmed = content.trim();
  if (!trimmed) throw new ConfigError('EMPTY_SERVER_FILE', '配置文件为空');

  let entries;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new ConfigError('INVALID_SERVER_FILE_JSON', 'JSON 配置文件格式错误；文件内容未显示');
    }
    entries = Array.isArray(parsed) ? parsed : parsed?.servers;
    if (!Array.isArray(entries)) {
      throw new ConfigError('INVALID_SERVER_FILE', 'JSON 顶层须为服务器数组，或包含 servers 数组');
    }
    entries = entries.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.url !== 'string') {
        throw new ConfigError('INVALID_SERVER_FILE', 'JSON 每项须为包含 url 字符串的对象');
      }
      if (item.name !== undefined && typeof item.name !== 'string') {
        throw new ConfigError('INVALID_SERVER_FILE', 'JSON 中 name 必须是字符串');
      }
      return { name: item.name?.trim() || '', url: item.url.trim() };
    });
  } else {
    entries = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((url) => ({ name: '', url }));
  }

  if (!entries.length) throw new ConfigError('EMPTY_SERVER_FILE', '配置文件中没有 MCP URL');
  if (entries.length > LIMITS.maxServers) {
    throw new ConfigError('INVALID_SERVERS', `配置文件中的连接数超过上限 ${LIMITS.maxServers}`);
  }

  const nameCounts = new Map();
  return entries.map(({ name, url }, index) => {
    if (!url) throw new ConfigError('INVALID_SERVER_FILE', `第 ${index + 1} 项缺少 URL`);
    let resolvedName = name;
    if (!resolvedName) {
      let capabilityId = null;
      try {
        capabilityId = inspectMcpUrl(url).capabilityId;
      } catch {
        // 最终 URL 合法性由共享的 validatePayload 给出安全错误。
      }
      resolvedName = displayNameForCapability(capabilityId, index);
    }
    const count = (nameCounts.get(resolvedName) ?? 0) + 1;
    nameCounts.set(resolvedName, count);
    if (count > 1) {
      // 仅在后缀放得下时才自动改名；否则保留原名（重名由 CLI 统一提示），避免顶破 40 字符上限
      const suffixed = `${resolvedName} (${count})`;
      if (suffixed.length <= LIMITS.maxNameLength) resolvedName = suffixed;
    }
    return { name: resolvedName, url, apikey: null, capabilityId: null };
  });
}

/** @param {string[]} paths */
export async function readServerFiles(paths) {
  const groups = await Promise.all(paths.map((path) => readServerFile(path)));
  const servers = groups.flat();
  if (servers.length > LIMITS.maxServers) {
    throw new ConfigError('INVALID_SERVERS', `连接数 ${servers.length} 超过上限 ${LIMITS.maxServers}`);
  }
  return servers;
}
