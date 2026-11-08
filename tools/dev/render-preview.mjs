// 用 headless Chrome 渲染 `aix preview --html-out` 产出的静态预览页，用于在无真机时
// 验证 .ink 模板可编译、页面可渲染、按键可交互，并截图存档。
//
// 预览 HTML 的 importmap 默认指向 CDN（ga.jspm.io）。本脚本用本地 @yodaos-pkg/ink
// 覆盖该映射并起一个临时静态服务器，因此离线可用。
//
// 用法：
//   node tools/dev/render-preview.mjs <preview.html> <输出前缀> [--keys Enter,Backspace] [--settle 1200]
import http from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import puppeteer from 'puppeteer-core';
import { analyzePng } from './png-stats.mjs';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const htmlPath = args[0];
const outPrefix = args[1] ?? '/tmp/aix-preview';
const keyArgIndex = args.indexOf('--keys');
const keys = keyArgIndex >= 0 ? String(args[keyArgIndex + 1] ?? '').split(',').filter(Boolean) : [];
const settleIndex = args.indexOf('--settle');
const settleMs = settleIndex >= 0 ? Number(args[settleIndex + 1]) || 1200 : 1200;
const patternIndex = args.indexOf('--log-pattern');
const extraPattern = patternIndex >= 0 ? args[patternIndex + 1] : '';
if (!htmlPath) {
  console.error('用法：node tools/dev/render-preview.mjs <preview.html> [输出前缀] [--keys Enter,Backspace]');
  process.exit(1);
}

const chromePath =
  process.env.CHROME_PATH ??
  '/tmp/chrome/chrome-headless-shell/linux-156.0.8078.80/chrome-headless-shell-linux64/chrome-headless-shell';
if (!existsSync(chromePath)) {
  console.error(`找不到 Chrome：${chromePath}\n请用 CHROME_PATH=/path/to/chrome-headless-shell 指定。`);
  process.exit(1);
}
const inkDir = path.dirname(require.resolve('@yodaos-pkg/ink/package.json'));

const MIME = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
};

/** 把 CDN importmap 换成本地路径。 */
function rewriteImportMap(html) {
  return html.replace(/"@yodaos-pkg\/ink"\s*:\s*"[^"]+"/, '"@yodaos-pkg/ink": "/ink/index.js"');
}

function startServer(html) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/' || url.pathname === '/index.html') {
      response.writeHead(200, { 'content-type': MIME['.html'] });
      response.end(html);
      return;
    }
    if (url.pathname.startsWith('/ink/')) {
      const filePath = path.join(inkDir, url.pathname.slice('/ink/'.length));
      try {
        const body = await readFile(filePath);
        response.writeHead(200, {
          'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
          'access-control-allow-origin': '*',
        });
        response.end(body);
      } catch {
        response.writeHead(404);
        response.end('not found');
      }
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const html = rewriteImportMap(await readFile(htmlPath, 'utf8'));
const { server, port } = await startServer(html);

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1180, height: 900, deviceScaleFactor: 1 });

/** @type {string[]} */
const logs = [];
page.on('console', (message) => logs.push(`[${message.type()}] ${message.text()}`));
page.on('pageerror', (error) => logs.push(`[pageerror] ${error.message}`));
page.on('requestfailed', (request) => logs.push(`[requestfailed] ${request.url()} ${request.failure()?.errorText}`));

/** 只保留与业务相关的日志（错误 + 我们的 [wecom] 日志 + 页面加载） */
function relevantLogs(fromIndex) {
  const base = /pageerror|\[error\]|\[wecom\]|\[verify\]|Loading initial page|method "onLoad"|method "onShow"|navigate|Navigat/i;
  return logs.slice(fromIndex).filter((line) => (extraPattern ? new RegExp(extraPattern, 'i') : base).test(line));
}

const steps = [];
let logCursor = 0;

/** 截图 + 像素统计 */
async function capture(name) {
  const file = `${outPrefix}${name ? `-${name}` : ''}.png`;
  await page.screenshot({ path: file });
  const canvasHandle = await page.$('#canvas-host');
  const canvasFile = `${outPrefix}${name ? `-${name}` : ''}-canvas.png`;
  let stats = null;
  if (canvasHandle) {
    const buffer = Buffer.from(await canvasHandle.screenshot());
    const { writeFile } = await import('node:fs/promises');
    await writeFile(canvasFile, buffer);
    stats = analyzePng(buffer);
  }
  steps.push({
    name: name || 'initial',
    screenshot: file,
    canvasScreenshot: canvasFile,
    canvas: stats ? { width: stats.width, height: stats.height, litPixels: stats.lit, greenPixels: stats.greenish } : null,
    grid: stats?.grid,
    logs: relevantLogs(logCursor),
  });
  logCursor = logs.length;
}

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const deadline = Date.now() + 40000;
  let statusText = '';
  while (Date.now() < deadline) {
    statusText = await page.evaluate(() => document.getElementById('preview-status')?.textContent?.trim() ?? '');
    if (statusText && !/initializing/i.test(statusText)) break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  await capture('');

  for (const key of keys) {
    const clicked = await page.evaluate((keyName) => {
      const button = document.querySelector(`.control-button[data-key="${keyName}"]`);
      if (!button) return false;
      button.click();
      return true;
    }, key);
    if (!clicked) {
      steps.push({ name: `key-${key}`, error: '预览页没有该按键控件' });
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    await capture(`key-${key}`);
  }

  const errors = logs.filter((line) => /pageerror|\[error\]/.test(line));
  console.log(JSON.stringify({ status: statusText, errors, steps }, null, 2));
} finally {
  await browser.close();
  server.close();
}
