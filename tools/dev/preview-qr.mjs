// 本机专用模拟宿主：官方预览 HTML + 文件选择器注入 media.takePhoto。
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const inkDir = await realpath(path.dirname(require.resolve('@yodaos-pkg/ink/package.json')));
const token = randomBytes(24).toString('hex');
const prefix = `/${token}/`;
const temp = await mkdtemp(path.join(tmpdir(), 'rokid-preview-'));
let html;
try {
  const generated = path.join(temp, 'preview.html');
  execFileSync(process.execPath, [require.resolve('@yodaos-pkg/aix-cli'), 'preview', path.join(root, 'app'), '--html-out', generated], { cwd: root, stdio: 'inherit' });
  html = await readFile(generated, 'utf8');
} finally {
  await rm(temp, { recursive: true, force: true });
}
const mapping = /"@yodaos-pkg\/ink"\s*:\s*"[^"]+"/;
const marker = '          canvas: currentCanvas,';
if (!mapping.test(html) || !html.includes(marker) || !html.includes('</body>')) {
  throw new Error('aix 预览 HTML 格式已变化，无法安全注入宿主能力');
}
html = html.replace(mapping, `"@yodaos-pkg/ink":"${prefix}ink/index.js"`)
  .replace(marker, `${marker}\n          hostCapabilities: { media: { takePhoto: () => window.__localQrTakePhoto() } },`)
  .replace('</body>', `<script src="${prefix}qr-host.js"></script></body>`);
const hostScript = await readFile(new URL('./preview-qr-host.js', import.meta.url));
const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  // 拒绝 DNS rebinding 和跨站读取；文件及二维码绝不由服务端接收。
  const host = req.headers.host;
  if (host !== `127.0.0.1:${server.address().port}` || !['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(403).end(); return;
  }
  let pathname;
  try {
    pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  } catch {
    res.writeHead(400).end();
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  let body, type;
  if (pathname === prefix) { body = html; type = 'text/html; charset=utf-8'; }
  else if (pathname === `${prefix}qr-host.js`) { body = hostScript; type = 'text/javascript; charset=utf-8'; }
  else if (pathname.startsWith(`${prefix}ink/`)) {
    try {
      const file = await realpath(path.resolve(inkDir, decodeURIComponent(pathname.slice(`${prefix}ink/`.length))));
      if (!file.startsWith(`${inkDir}${path.sep}`)) throw new Error('invalid path');
      body = await readFile(file); type = mime[path.extname(file)] || 'application/octet-stream';
    } catch { res.writeHead(404).end(); return; }
  } else { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': type });
  res.end(req.method === 'HEAD' ? undefined : body);
});
server.listen(0, '127.0.0.1', () => {
  console.log(`本地扫码预览（请勿分享此地址）：http://127.0.0.1:${server.address().port}${prefix}`);
  console.log('选择图片后，在应用中进入扫码页并按确认；按选择顺序每次扫描一张。Ctrl+C 退出。');
  console.log('注意：扫码后的真实 MCP 探测会访问二维码中的服务；不要使用不可信二维码。');
});
