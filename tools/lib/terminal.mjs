// 终端配色解析（纯函数，环境变量可注入，便于测试）。
//
// mode 语义：
//   dark  —— 适配深色终端：白码黑底（二维码反色，qrcode 的 inverse）
//   light —— 适配浅色终端：黑码白底（标准二维码，兼容性最好）
//   auto  —— 按环境变量猜测，猜不到时用 light（标准二维码，最稳）

/**
 * @param {string} mode
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {'dark' | 'light'}
 */
export function resolveQrMode(mode = 'auto', env = process.env) {
  if (mode === 'dark' || mode === 'light') return mode;

  const colorFgBg = String(env.COLORFGBG ?? '').trim();
  if (colorFgBg) {
    const parts = colorFgBg.split(';');
    const background = Number.parseInt(parts[parts.length - 1], 10);
    if (Number.isInteger(background)) {
      const isDark = (background >= 0 && background <= 6) || background === 8;
      return isDark ? 'dark' : 'light';
    }
  }

  const explicit = String(env.TERM_BACKGROUND ?? env.COLORSCHEME_BACKGROUND ?? env.COLORTERM_BG ?? '')
    .trim()
    .toLowerCase();
  if (explicit === 'dark') return 'dark';
  if (explicit === 'light') return 'light';

  return 'light';
}

/**
 * 给用户看的配色说明。
 * @param {'dark' | 'light'} mode
 * @returns {string}
 */
export function describeQrMode(mode) {
  return mode === 'dark' ? '深色终端（白码黑底）' : '浅色终端（黑码白底）';
}
