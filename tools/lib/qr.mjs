// 二维码渲染与导出：终端可扫描二维码、SVG、PNG。
//
// 只依赖 qrcode 库；终端二维码用 qrcode 的 terminal 渲染器（small 模式，纵向两个模块一个字符），
// 终端输出本身不含明文 URL / API Key（二维码图像里才是真实的配置）。

import { closeSync, fchmodSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { rename, stat } from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import { ConfigError, LIMITS, QR_BYTE_CAPACITY, splitIntoChunks } from '../../app/libs/qr-payload.js';
import { resolveQrMode } from './terminal.mjs';

export { QR_BYTE_CAPACITY };

const ERROR_CORRECTION_LEVEL = 'M';
const PNG_WIDTH = 720;
const MARGIN = 2;

/** 本进程正在写入的含凭据临时文件（只登记本进程路径，供 SIGTERM/exit 同步清理）。 */
const ACTIVE_TEMP_PATHS = new Set();

/**
 * 同步清理本进程已登记、可能含凭据的临时文件。
 * 只遍历本进程登记过的路径，不扫描目录，不会碰其他进程的 `.tmp-*` 文件。
 * SIGTERM 处理器与 exit 钩子都会调用；SIGKILL 无法捕获，残留需手动清理。
 */
export function cleanupOwnTempFilesSync() {
  for (const tempPath of ACTIVE_TEMP_PATHS) {
    try {
      unlinkSync(tempPath);
    } catch {
      // 已 rename/已删除/无权限：尽力而为，其他进程的文件不在这个集合里
    }
  }
  ACTIVE_TEMP_PATHS.clear();
}

process.once('exit', cleanupOwnTempFilesSync);

/**
 * 写入含真实凭据的导出文件：
 *   - 先登记本进程临时文件路径，再同步独占创建（创建即 0600）并写入，最后原子 rename
 *     覆盖目标：创建/写入期间没有 await，SIGTERM 不会落在“文件已存在但尚未登记”的窗口；
 *     rename 等待期间若收到 SIGTERM，由 cleanupOwnTempFilesSync 按登记路径清理，不碰其他进程；
 *   - chmod/fchmod 0600 后 rename，避免「先以默认权限创建、再改权限」之间被其他用户读到，
 *     也避免失败时留下半成品；rename 保留 0600 权限，旧文件同样被替换成 0600。
 * @param {string} filePath
 * @param {string | Uint8Array} data
 * @param {string} label 用于错误信息（PNG / SVG）
 */
async function writeSecretFile(filePath, data, label) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  ACTIVE_TEMP_PATHS.add(tempPath);
  let created = false;
  let cleanupRetry = false;
  let fd;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    created = true;
    fchmodSync(fd, 0o600);
    writeFileSync(fd, data);
    closeSync(fd);
    fd = undefined;
    await rename(tempPath, filePath);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 已关闭/关闭失败都不影响后续清理
      }
    }
    if (created) {
      try {
        unlinkSync(tempPath);
      } catch (unlinkError) {
        // 已 rename/已删除：无需再处理；其他失败保留登记，交给 exit/SIGTERM 钩子再试一次
        if (unlinkError?.code !== 'ENOENT') cleanupRetry = true;
      }
    }
    throw new ConfigError('EXPORT_FAILED', `写入 ${label} 失败：${filePath}（${error?.code ?? '未知错误'}）`);
  } finally {
    if (!cleanupRetry) ACTIVE_TEMP_PATHS.delete(tempPath);
  }
}

/**
 * 把 qrcode 的异常翻译成中文 ConfigError（容量不足是最常见的失败）。
 * @param {unknown} error
 * @param {string} text
 * @returns {ConfigError}
 */
function wrapQrError(error, text) {
  if (error instanceof ConfigError) return error;
  const bytes = Buffer.byteLength(String(text ?? ''), 'utf8');
  const message = String(error?.message ?? '');
  if (/too (big|long|large)|code length overflow|amount of data/i.test(message)) {
    return new ConfigError(
      'QR_TOO_LARGE',
      `内容超出单个二维码容量（${bytes} 字节，EC M 上限 ${QR_BYTE_CAPACITY} 字节），请减小 --max-chars 让配置按字节自动分片生成`,
    );
  }
  return new ConfigError('QR_RENDER_FAILED', `二维码生成失败：${message || '未知错误'}`);
}

/**
 * 渲染终端可扫描二维码（带 ANSI 颜色块）。
 * @param {string} text
 * @param {{mode?: 'dark' | 'light' | 'auto'}} [options]
 * @returns {Promise<string>}
 */
export async function renderTerminalQr(text, { mode = 'auto' } = {}) {
  const resolved = resolveQrMode(mode);
  try {
    return await QRCode.toString(text, {
      type: 'terminal',
      small: true,
      inverse: resolved === 'dark',
      errorCorrectionLevel: ERROR_CORRECTION_LEVEL,
    });
  } catch (error) {
    throw wrapQrError(error, text);
  }
}

/**
 * 估算终端二维码占用的字符行列数（用于提示终端窗口是否装得下）。
 * @param {string} text
 * @returns {{columns: number, rows: number, version: number} | null}
 */
export function estimateQrCells(text) {
  try {
    const qr = QRCode.create(text, { errorCorrectionLevel: ERROR_CORRECTION_LEVEL });
    const modules = qr.modules.size;
    return {
      columns: modules + 2,
      rows: Math.ceil((modules + 2) / 2),
      version: qr.version,
    };
  } catch {
    return null;
  }
}

/**
 * 按终端窗口尺寸自动缩小每张二维码的容量，返回「装得下」的最大 maxChars 与对应分片。
 *
 * 只在未显式指定 --max-chars 时使用：用户显式给了值就以用户为准（并保留原有超窗提示）。
 * 二分查找最大的可用容量：容量越小 → 分片越多、每张越小，直到所有分片都能整屏显示。
 * @param {string} text 完整载荷文本（紧凑配置）
 * @param {{maxChars: number, maxBytes: number}} options 当前容量上限
 * @returns {{maxChars: number, chunks: string[]} | null} 已经装得下或无法适配时返回 null
 */
export function fitChunksToTerminal(text, { maxChars, maxBytes }) {
  const columns = process.stdout.columns;
  const rows = process.stdout.rows;
  if (!columns || !rows) return null;

  const tryFit = (chars) => {
    let chunks;
    try {
      chunks = splitIntoChunks(text, { maxChars: chars, maxBytes });
    } catch {
      return null; // 分片数超过上限等：这个容量不可用
    }
    const fits = chunks.every((chunk) => {
      const size = estimateQrCells(chunk);
      return size && size.columns <= columns && size.rows <= rows;
    });
    return fits ? chunks : null;
  };

  if (tryFit(maxChars)) return null; // 当前容量已经装得下，无需调整

  let low = LIMITS.minChunkChars;
  let high = maxChars;
  let best = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const chunks = tryFit(middle);
    if (chunks) {
      best = { maxChars: middle, chunks };
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

/**
 * 渲染 SVG 文本。
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function renderSvg(text) {
  try {
    return await QRCode.toString(text, {
      type: 'svg',
      margin: MARGIN,
      errorCorrectionLevel: ERROR_CORRECTION_LEVEL,
    });
  } catch (error) {
    throw wrapQrError(error, text);
  }
}

/**
 * 检查导出目录是否存在，给出中文错误（生成二维码之前先调用，避免先打印再失败）。
 * @param {string} filePath
 */
export async function assertExportDirectory(filePath) {
  const directory = path.dirname(path.resolve(filePath));
  try {
    const info = await stat(directory);
    if (!info.isDirectory()) throw new Error('not a directory');
  } catch {
    throw new ConfigError('EXPORT_FAILED', `导出目录不存在：${directory}`);
  }
}

/**
 * 导出 PNG，返回文件字节数。
 * @param {string} filePath
 * @param {string} text
 * @returns {Promise<number>}
 */
export async function writePngFile(filePath, text) {
  await assertExportDirectory(filePath);
  let buffer;
  try {
    buffer = await QRCode.toBuffer(text, {
      type: 'png',
      width: PNG_WIDTH,
      margin: MARGIN,
      errorCorrectionLevel: ERROR_CORRECTION_LEVEL,
    });
  } catch (error) {
    throw wrapQrError(error, text);
  }
  await writeSecretFile(filePath, buffer, 'PNG');
  return buffer.length;
}

/**
 * 导出 SVG，返回文件字节数。
 * @param {string} filePath
 * @param {string} text
 * @returns {Promise<number>}
 */
export async function writeSvgFile(filePath, text) {
  await assertExportDirectory(filePath);
  const svg = await renderSvg(text);
  await writeSecretFile(filePath, svg, 'SVG');
  return Buffer.byteLength(svg, 'utf8');
}
