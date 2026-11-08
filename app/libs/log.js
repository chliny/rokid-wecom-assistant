// 统一日志：所有输出都经过脱敏，避免 MCP URL / API Key 落进眼镜日志。
import { redactText } from './qr-payload.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * 创建脱敏日志器。
 * @param {{level?: 'debug'|'info'|'warn'|'error', sink?: (line: string) => void, scope?: string}} [options]
 */
export function createLogger(options = {}) {
  const threshold = LEVELS[options.level ?? 'info'] ?? LEVELS.info;
  const sink = options.sink ?? ((line) => console.log(line));
  const scope = options.scope ? `[${options.scope}] ` : '';
  /** @type {string[]} */
  const history = [];

  const write = (level, args) => {
    if (LEVELS[level] < threshold) return;
    const message = args
      .map((arg) => {
        if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
        if (typeof arg === 'string') return arg;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(' ');
    const line = redactText(`${scope}${message}`);
    history.push(line);
    sink(line);
  };

  return {
    debug: (...args) => write('debug', args),
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
    /** 读取已写入的日志（用于错误页展示 / 测试断言） */
    get history() {
      return history.slice();
    },
    /** 只保留最近 N 条，避免长会话无限增长 */
    trim(keep = 200) {
      if (history.length > keep) history.splice(0, history.length - keep);
    },
  };
}

/** 默认安静的日志器：眼镜端默认只记录警告以上。 */
export const silentLogger = createLogger({ level: 'warn', sink: () => {} });
