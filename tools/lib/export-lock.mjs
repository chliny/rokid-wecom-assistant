// 导出并发锁：同一输出前缀同一时间只允许一个导出进程写入。
//
// 为什么需要：导出前会清理同前缀的旧分片，若两个进程并发导出同一前缀，可能互删对方
// 刚写好的分片，甚至留下混合分片集。这里按「输出命名空间」加锁：基名 `qr.png` 的导出
// 会写/清理 `qr.png` 与 `qr-<数字>.png`，因此锁键同时包含它自己及所有去掉末尾 `-<数字>`
// 的祖先路径（`qr-1.png` 会锁 `qr-1.png` 和 `qr.png`）。这样 `qr.png` 多片与并发
// `qr-1.png` 单张会命中同一把 `qr.png` 锁，重叠输出被保守串行；不同前缀不受影响。
// 锁键前会先对目标目录做 realpath 规范化：`/tmp/link/qr.png`（link→real）与
// `/tmp/real/qr.png` 是同一物理输出，必须命中同一把锁，否则符号链接别名会绕过锁。
// 锁覆盖旧文件清理与本次全部分片写入；冲突时明确失败，绝不删除对方的任何文件。
//
// 约定：
//   - 锁文件放在目标目录（realpath 后的真实目录）下，文件名是锁键绝对路径的哈希
//     （不包含 URL / API Key / 完整路径）；
//   - 锁内容只有 pid、开始时间与工具名，同样不含凭据；
//   - 锁用同步独占 open 创建后立即登记，再写内容；创建与登记之间没有 await，SIGTERM
//     不会落在“文件已创建但尚未登记”的异步窗口；写失败只清理本进程刚创建的那把锁；
//   - 只清理本进程持有的锁；进程异常退出时由 exit 钩子尽力同步释放；CLI 会捕获
//     SIGTERM 释放本进程锁并以 128+15 退出；SIGKILL（kill -9）无法捕获，锁可能残留，
//     需按错误提示确认进程已不在后手动删除；
//   - 不自动删除无法判断归属的陈旧锁：报错并提示用户确认后手动删除。

import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ConfigError } from '../../app/libs/qr-payload.js';

const LOCK_FILE_PREFIX = '.qr-export-';
const LOCK_FILE_SUFFIX = '.lock';
/** 本进程当前持有的锁文件路径（供退出钩子兜底释放）。 */
const ACTIVE_LOCK_PATHS = new Set();

/**
 * 计算一个目标路径的「输出命名空间」锁键：
 * 目标自身 + 反复去掉末尾 `-<数字>` 得到的祖先路径（目录与扩展名不变）。
 * 例如 `/d/qr-2.png` → [`/d/qr-2.png`, `/d/qr.png`]；`/d/qr.png` → [`/d/qr.png`]。
 * 这样任一祖先的导出与后代导出会争用同一把祖先键锁，覆盖 `qr.png` ↔ `qr-1.png`
 * 这类「按输入 basePath 上锁会漏掉」的重叠输出。
 * @param {string} resolvedTarget
 * @returns {string[]}
 */
function namespaceLockKeys(resolvedTarget) {
  const directory = path.dirname(resolvedTarget);
  const extension = path.extname(resolvedTarget);
  const stem = path.basename(resolvedTarget, extension);
  const keys = [];
  let current = stem;
  for (;;) {
    keys.push(path.join(directory, `${current}${extension}`));
    const stripped = current.match(/^(.*)-\d+$/);
    if (!stripped || stripped[1] === '') break;
    current = stripped[1];
  }
  return keys;
}

/**
 * 锁键 → 锁文件路径：用绝对路径的哈希做文件名，避免把用户路径写进锁名。
 * @param {string} key
 * @returns {string}
 */
function lockPathFor(key) {
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return path.join(path.dirname(key), `${LOCK_FILE_PREFIX}${digest}${LOCK_FILE_SUFFIX}`);
}

/**
 * 目录做 realpath 规范化；目录不存在时退回原路径。
 * @param {string} directory
 * @returns {Promise<string>}
 */
async function canonicalDirectory(directory) {
  try {
    return await realpath(directory);
  } catch {
    return directory;
  }
}

/**
 * 判断 child 是否是 parent 的 `-<数字>` 直接子命名空间（如 `qr-2` 是 `qr` 的子空间）。
 * 只认单段数字后缀：`qr-1-2` 不是 `qr` 的子空间（清理正则只匹配 `qr-<数字>`）。
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
function isNumberedChildStem(child, parent) {
  if (!child.startsWith(`${parent}-`)) return false;
  return /^\d+$/.test(child.slice(parent.length + 1));
}

/**
 * 计算导出目标的输出命名空间信息（目录按 realpath 规范化，消除符号链接别名）。
 * @param {string} target
 * @returns {Promise<{directory: string, extension: string, stem: string}>}
 */
async function describeExportTarget(target) {
  const resolved = path.resolve(target);
  return {
    directory: await canonicalDirectory(path.dirname(resolved)),
    extension: path.extname(resolved),
    stem: path.basename(resolved, path.extname(resolved)),
  };
}

/**
 * 两个目标的「写入 + 清理」命名空间是否重叠。
 * 同目录、同扩展名，且 stem 相同或一个是另一个的 `-<数字>` 直接子空间时重叠：
 * `qr.png` 会写/清理 `qr-1.png`，因此 `--png qr.png --svg qr-1.png` 冲突；
 * 而 `qr-1.png` 与 `qr-2.png` 的命名空间互不相交，不冲突。
 * @param {{directory: string, extension: string, stem: string}} a
 * @param {{directory: string, extension: string, stem: string}} b
 * @returns {boolean}
 */
function exportNamespacesOverlap(a, b) {
  if (a.directory !== b.directory || a.extension !== b.extension) return false;
  if (a.stem === b.stem) return true;
  return isNumberedChildStem(a.stem, b.stem) || isNumberedChildStem(b.stem, a.stem);
}

/**
 * 在任何写入/删除发生前，校验本次多个导出目标不会互相覆盖或清理。
 *
 * 典型问题：`--png qr.png --svg qr-1.png` 多片时，PNG 阶段先写 `qr-1.png`，SVG 阶段
 * 的旧文件清理会把它当“上次单张残留”删掉，命令却仍 exit 0。这里在加锁、渲染、清理之前
 * 直接拒绝，避免任何输出被误删。目录做 realpath，符号链接别名同样会被识别。
 *
 * @param {Array<string | null | undefined>} targets `--png` / `--svg` 目标
 * @returns {Promise<void>}
 */
export async function assertNoExportTargetOverlap(targets) {
  const list = (targets ?? []).filter((target) => typeof target === 'string' && target.length > 0);
  const described = [];
  for (const target of list) described.push(await describeExportTarget(target));
  for (let i = 0; i < described.length; i += 1) {
    for (let j = i + 1; j < described.length; j += 1) {
      if (!exportNamespacesOverlap(described[i], described[j])) continue;
      // 不回显目标路径：用户可能把含 API Key 的文本误粘贴为 --png/--svg 路径，
      // 直接打印会把凭据带进日志；这里只说明两个目标的范围重叠。
      throw new ConfigError(
        'EXPORT_CONFLICT',
        `本次 --png 与 --svg 的输出/清理范围重叠（同名、-<数字> 后缀或软链指向同一物理目录）。` +
          `为避免误删，本次未写入或删除任何文件；请为 --png / --svg 使用不同的目录或前缀。`,
      );
    }
  }
}

/**
 * 读取锁内容生成安全的占用者描述（不含路径/凭据，只用于提示）。
 * @param {string} lockPath
 * @returns {Promise<string>}
 */
async function describeLock(lockPath) {
  try {
    const info = JSON.parse(await readFile(lockPath, 'utf8'));
    const pid = Number.isInteger(info?.pid) ? `PID ${info.pid}` : '未知进程';
    const startedAt = Number(info?.startedAt);
    const when = Number.isFinite(startedAt)
      ? new Date(startedAt).toLocaleString('zh-CN', { hour12: false })
      : '未知时间';
    return `${pid}，开始于 ${when}`;
  } catch {
    return '另一个进程';
  }
}

/**
 * 尽力释放本进程持有的某把锁；不是本进程的锁绝不删除。
 * @param {string} lockPath
 * @returns {Promise<void>}
 */
async function releaseOne(lockPath) {
  let pid;
  try {
    pid = JSON.parse(await readFile(lockPath, 'utf8'))?.pid;
  } catch {
    ACTIVE_LOCK_PATHS.delete(lockPath);
    return;
  }
  if (pid !== process.pid) {
    ACTIVE_LOCK_PATHS.delete(lockPath);
    return;
  }
  try {
    await unlink(lockPath);
    ACTIVE_LOCK_PATHS.delete(lockPath);
  } catch (error) {
    // 已被手动删除/并发释放视为已释放；其他错误保留在集合里交给 exit 钩子再试一次
    if (error?.code === 'ENOENT') ACTIVE_LOCK_PATHS.delete(lockPath);
  }
}

/**
 * 获取一组导出目标的排他锁。
 *
 * 先展开成所有输出命名空间键（目标自身 + 去掉末尾 `-<数字>` 的祖先），去重、按锁文件
 * 路径字典序依次获取：两个进程即使 `--png` / `--svg` 传入顺序不同、或一个导出 `qr.png`
 * 多片另一个导出 `qr-1.png` 单张，也会按同一全局顺序争用同一把祖先键锁，因此不会死锁。
 * 目标目录会先做 realpath 规范化，符号链接别名与真实路径会命中同一把锁。
 * 任一锁已被占用则释放本次已获取的锁并抛出 `EXPORT_LOCKED`，不做任何文件删除。
 *
 * @param {string[]} targets `--png` / `--svg` 目标路径（可包含 null 已过滤）
 * @returns {Promise<Array<{lockPath: string, key: string}>>}
 */
export async function acquireExportLocks(targets) {
  const unresolved = targets.filter((target) => typeof target === 'string' && target.length > 0);
  const keys = new Set();
  for (const target of unresolved) {
    const resolved = path.resolve(target);
    // 目录符号链接会让同一物理输出出现两个路径：锁键必须对目录做 realpath，
    // 否则 /tmp/link/qr.png 与 /tmp/real/qr.png 会各拿一把锁并互相覆盖/清理。
    const canonical = path.join(await canonicalDirectory(path.dirname(resolved)), path.basename(resolved));
    for (const key of namespaceLockKeys(canonical)) keys.add(key);
  }
  const plan = [...keys]
    .map((key) => ({ key, lockPath: lockPathFor(key) }))
    .sort((a, b) => (a.lockPath < b.lockPath ? -1 : a.lockPath > b.lockPath ? 1 : 0));

  const lockBody = JSON.stringify({ pid: process.pid, startedAt: Date.now(), tool: 'wecom-mcp-qr' });
  const acquired = [];
  for (const item of plan) {
    let fd;
    let created = false;
    try {
      // 同步独占创建 + 立即登记 + 再写内容：open 与 add 之间没有 await，SIGTERM
      // 处理器不可能命中“锁文件已创建但不在 ACTIVE 集合”的异步窗口；登记后写内容，
      // 即使写失败也能按本进程自己的锁清理，不会误删别人的锁。
      fd = openSync(item.lockPath, 'wx', 0o600);
      created = true;
      ACTIVE_LOCK_PATHS.add(item.lockPath);
      writeFileSync(fd, lockBody);
      closeSync(fd);
      fd = undefined;
      acquired.push(item);
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // 已关闭/关闭失败都不影响后续清理
        }
      }
      if (created) {
        // open 成功后文件只可能属于本进程；失败时只清这一把自己的锁。
        // EEXIST 时 created=false，绝不动对方已存在的锁。
        try {
          unlinkSync(item.lockPath);
          ACTIVE_LOCK_PATHS.delete(item.lockPath);
        } catch (unlinkError) {
          if (unlinkError?.code === 'ENOENT') ACTIVE_LOCK_PATHS.delete(item.lockPath);
          // 其他错误保留在 ACTIVE，交给 exit/SIGTERM 钩子再试一次
        }
      }
      for (const lock of acquired.reverse()) await releaseOne(lock.lockPath);
      if (error?.code === 'EEXIST') {
        const occupant = await describeLock(item.lockPath);
        // 锁文件放在目标目录里；只回显哈希文件名、不回显目录，避免用户把含 Key 的文本
        // 误粘贴为输出目录时把凭据带进错误日志。用户从自己的 --png/--svg 即可知道目录。
        throw new ConfigError(
          'EXPORT_LOCKED',
          `另一个导出进程正在写入重叠的输出前缀/目标（${occupant}），本次已中止，未删除对方文件；请等它结束后重试。` +
            `若确认该进程已不存在，请手动删除目标目录下的锁文件后重试：${path.basename(item.lockPath)}`,
        );
      }
      throw new ConfigError(
        'EXPORT_FAILED',
        `无法创建导出锁：${path.basename(item.lockPath)}（目标目录内；${error?.code ?? '未知错误'}）`,
      );
    }
  }
  return acquired;
}

/**
 * 释放本次获取的锁（按获取顺序逆序），只删除本进程自己的锁。
 * @param {Array<{lockPath: string}>} locks
 * @returns {Promise<void>}
 */
export async function releaseExportLocks(locks) {
  for (const lock of [...locks].reverse()) await releaseOne(lock.lockPath);
}

/**
 * 同步释放本进程持有的全部锁，供 exit 钩子与 CLI 的 SIGTERM 处理器兜底。
 * 只处理内容里的 pid 与本进程一致的锁文件；其他进程的锁一律不动。
 * 注意：SIGKILL（kill -9）无法被捕获，锁文件可能残留，需要按错误提示手动删除。
 */
export function releaseExportLocksSync() {
  for (const lockPath of ACTIVE_LOCK_PATHS) {
    try {
      const info = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (info?.pid === process.pid) unlinkSync(lockPath);
    } catch {
      // 读不到/已删除/无权限：保持原样，交给用户按提示处理
    }
  }
  ACTIVE_LOCK_PATHS.clear();
}

process.once('exit', releaseExportLocksSync);
