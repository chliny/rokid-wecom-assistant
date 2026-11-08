// 交互式终端读取：普通输入、隐藏回显的敏感输入（API Key）、退格 / Ctrl+C / Ctrl+D 处理。
//
// 设计要点：
//   · TTY 环境：自己开 raw 模式逐字符读取，API Key 显示 *；URL 输入只遮盖 ?apikey= 之后的值；
//     退格按显示宽度擦除（中文、emoji 宽度为 2）；Ctrl+C 抛 CancelError（退出码 130）；
//   · 非 TTY（管道 / 重定向）：降级为按行读取，不做逐字符隐藏，并在提示里说明；
//   · 粘贴多行时余下字符留在队列里，交给下一次提问消费。

import { StringDecoder } from 'node:string_decoder';

/** 用户取消（Ctrl+C / EOF / Ctrl+D），对应退出码 130。 */
export class CancelError extends Error {
  /**
   * @param {string} [message]
   */
  constructor(message = '操作已取消') {
    super(message);
    this.name = 'CancelError';
    this.code = 'CANCELLED';
  }
}

/**
 * 估算单个字符在终端里占的列数（粗略的 East Asian Width，够用即可）。
 * @param {string} ch
 * @returns {number}
 */
function charDisplayWidth(ch) {
  const codePoint = ch.codePointAt(0) ?? 0;
  if (codePoint === 0) return 0;
  if ((codePoint >= 0x0300 && codePoint <= 0x036f) || (codePoint >= 0x200b && codePoint <= 0x200f)) return 0;
  const wide =
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd);
  return wide ? 2 : 1;
}

/** 当前已输入内容是否正处于敏感参数值里（?apikey=... 之后、& 之前）。 */
const SENSITIVE_TAIL = /[?&](?:apikey|api_key|key|token|access_token|secret|password|sign)=[^&#\s]*$/i;

/**
 * 创建一个提示器。
 * @param {{input?: NodeJS.ReadStream, output?: NodeJS.WriteStream, tty?: boolean, onInterrupt?: () => void}} [options]
 *   onInterrupt：没有待回答问题时的 Ctrl+C（例如正在打印二维码）回调，通常用于清理终端后退出。
 */
export function createPrompter({ input = process.stdin, output = process.stdout, tty, onInterrupt } = {}) {
  const isTty = tty ?? Boolean(input.isTTY && output.isTTY);
  let closed = false;

  // ------------------------------------------------------------ TTY 逐字符读取
  const ttyState = {
    attached: false,
    rawEnabled: false,
    chars: /** @type {string[]} */ ([]),
    widths: /** @type {number[]} */ ([]),
    queue: /** @type {string[]} */ ([]),
    current: /** @type {{mask: 'none' | 'secret' | 'url', resolve: (value: string | null) => void, reject: (error: Error) => void} | null} */ (null),
    escapeBuffer: '',
    skipNewline: false,
    decoder: new StringDecoder('utf8'),
  };

  const ttyEcho = {
    /** 擦除 n 列（退格 / 空格 / 退格）。 */
    erase(columns) {
      if (columns <= 0) return;
      output.write(`${'\b'.repeat(columns)}${' '.repeat(columns)}${'\b'.repeat(columns)}`);
    },
  };

  const finishTtyLine = (value) => {
    const context = ttyState.current;
    if (!context) return;
    ttyState.current = null;
    ttyState.escapeBuffer = '';
    output.write('\n');
    context.resolve(value);
  };

  const cancelTtyLine = () => {
    const context = ttyState.current;
    if (!context) return;
    ttyState.current = null;
    ttyState.escapeBuffer = '';
    output.write('\n');
    context.reject(new CancelError('已取消（Ctrl+C）'));
  };

  const eraseLastTtyChar = () => {
    const width = ttyState.widths.pop();
    if (width === undefined) return;
    ttyState.chars.pop();
    ttyEcho.erase(width);
  };

  const eraseAllTtyChars = () => {
    const columns = ttyState.widths.reduce((sum, width) => sum + width, 0);
    ttyState.chars = [];
    ttyState.widths = [];
    ttyEcho.erase(columns);
  };

  /**
   * @param {string} ch 单个码点
   */
  const handleTtyChar = (ch) => {
    if (ttyState.escapeBuffer) {
      if (ttyState.escapeBuffer.length === 1 && (ch === '[' || ch === 'O')) {
        ttyState.escapeBuffer += ch;
        return;
      }
      if (/^[A-Za-z~]$/.test(ch)) {
        ttyState.escapeBuffer = '';
        return;
      }
      ttyState.escapeBuffer += ch;
      return;
    }
    if (ch === '\x1b') {
      ttyState.escapeBuffer = '\x1b';
      return;
    }
    if (ch === '\u0003') {
      if (ttyState.current) cancelTtyLine();
      else if (typeof onInterrupt === 'function') onInterrupt();
      return;
    }
    if (ch === '\u0004') {
      if (ttyState.chars.length === 0) finishTtyLine(null);
      return;
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\n' && ttyState.skipNewline) {
        ttyState.skipNewline = false;
        return;
      }
      ttyState.skipNewline = ch === '\r';
      finishTtyLine(ttyState.chars.join(''));
      ttyState.chars = [];
      ttyState.widths = [];
      return;
    }
    ttyState.skipNewline = false;
    if (ch === '\u007f' || ch === '\b') {
      eraseLastTtyChar();
      return;
    }
    if (ch === '\u0015') {
      eraseAllTtyChars();
      return;
    }
    if (ch < ' ') return;

    const context = ttyState.current;
    if (!context) return;
    const masked =
      context.mask === 'secret' ||
      (context.mask === 'url' && ch !== '&' && SENSITIVE_TAIL.test(ttyState.chars.join('')));
    ttyState.chars.push(ch);
    ttyState.widths.push(masked ? 1 : charDisplayWidth(ch));
    output.write(masked ? '*' : ch);
  };

  const drainTtyQueue = () => {
    while (ttyState.current && ttyState.queue.length > 0) {
      const ch = ttyState.queue.shift();
      if (ch === undefined) break;
      handleTtyChar(ch);
    }
  };

  const handleTtyData = (chunk) => {
    let text = ttyState.decoder.write(chunk);
    if (ttyState.skipNewline && text.startsWith('\n')) text = text.slice(1);
    ttyState.skipNewline = false;
    ttyState.queue.push(...Array.from(text));
    drainTtyQueue();
  };

  const attachTty = () => {
    if (ttyState.attached) return;
    ttyState.attached = true;
    input.on('data', handleTtyData);
    input.resume();
    if (typeof input.setRawMode === 'function') {
      input.setRawMode(true);
      ttyState.rawEnabled = true;
    }
  };

  const askTty = (prompt, mask) =>
    new Promise((resolve, reject) => {
      ttyState.chars = [];
      ttyState.widths = [];
      ttyState.escapeBuffer = '';
      output.write(prompt);
      attachTty();
      ttyState.current = { mask, resolve, reject };
      drainTtyQueue();
    });

  // ------------------------------------------------------------ 非 TTY 按行读取
  const plainState = {
    attached: false,
    buffer: '',
    lines: /** @type {string[]} */ ([]),
    waiters: /** @type {Array<(value: string | null) => void>} */ ([]),
    ended: false,
  };

  const deliverPlainLine = (line) => {
    const waiter = plainState.waiters.shift();
    if (waiter) waiter(line);
    else plainState.lines.push(line);
  };

  const handlePlainData = (chunk) => {
    plainState.buffer += chunk;
    let index = plainState.buffer.indexOf('\n');
    while (index >= 0) {
      let line = plainState.buffer.slice(0, index);
      plainState.buffer = plainState.buffer.slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      deliverPlainLine(line);
      index = plainState.buffer.indexOf('\n');
    }
  };

  const handlePlainEnd = () => {
    plainState.ended = true;
    if (plainState.buffer.length > 0) {
      deliverPlainLine(plainState.buffer);
      plainState.buffer = '';
    }
    while (plainState.waiters.length > 0) {
      const waiter = plainState.waiters.shift();
      waiter?.(null);
    }
  };

  const attachPlain = () => {
    if (plainState.attached) return;
    plainState.attached = true;
    if (typeof input.setEncoding === 'function') input.setEncoding('utf8');
    input.on('data', handlePlainData);
    input.on('end', handlePlainEnd);
    input.on('error', handlePlainEnd);
    input.resume();
  };

  const askPlain = async (prompt) => {
    attachPlain();
    output.write(prompt);
    if (plainState.ended && plainState.lines.length === 0) {
      output.write('\n');
      return null;
    }
    if (plainState.lines.length > 0) {
      const value = plainState.lines.shift() ?? null;
      output.write('\n');
      return value;
    }
    const value = await new Promise((resolve) => {
      plainState.waiters.push(resolve);
    });
    output.write('\n');
    return value;
  };

  // ------------------------------------------------------------ 对外接口
  return {
    /** @returns {boolean} 是否为真正的交互式终端 */
    get isTTY() {
      return isTty;
    },

    /**
     * 读取一行输入。
     * @param {string} prompt 提示语（已包含冒号 / 空格）
     * @param {{mask?: 'none' | 'secret' | 'url'}} [options]
     *   mask='secret' 全部显示 *；mask='url' 只遮盖 ?apikey= 之后的值。
     * @returns {Promise<string | null>} EOF 时返回 null
     */
    async askLine(prompt, { mask = 'none' } = {}) {
      if (closed) throw new Error('prompter 已关闭');
      if (isTty) return askTty(prompt, mask);
      const hint = mask === 'secret' ? '（当前为非终端环境，API Key 不做逐字符隐藏）' : '';
      return askPlain(prompt + hint);
    },

    /**
     * 读取隐藏回显的敏感输入（API Key）。
     * @param {string} prompt
     * @returns {Promise<string | null>}
     */
    async askSecret(prompt) {
      return this.askLine(prompt, { mask: 'secret' });
    },

    /** 恢复终端状态、清理监听，保证进程能正常退出。 */
    close() {
      if (closed) return;
      closed = true;
      if (isTty) {
        if (ttyState.attached) {
          input.removeListener('data', handleTtyData);
          ttyState.attached = false;
        }
        if (ttyState.rawEnabled && typeof input.setRawMode === 'function') {
          try {
            input.setRawMode(false);
          } catch {
            /* 终端已关闭时忽略 */
          }
          ttyState.rawEnabled = false;
        }
        input.pause();
        return;
      }
      if (plainState.attached) {
        input.removeListener('data', handlePlainData);
        input.removeListener('end', handlePlainEnd);
        input.removeListener('error', handlePlainEnd);
        plainState.attached = false;
      }
      input.pause();
    },
  };
}
