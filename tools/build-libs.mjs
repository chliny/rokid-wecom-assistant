#!/usr/bin/env node
// 构建 AIUI 端内置的 MCP 客户端单文件 bundle。
//
// 为什么需要预打包：AIUI 运行时无法从 node_modules 解析裸模块（原因见本地未入库的
// `.refs/NOTES-aiui.md` §2；该目录不随仓库分发，构建不依赖它），第三方库必须以 ESM
// 文件形式 vendored 进 `app/libs/`。
//
// 用法：npm run build:libs
//
// 产物：app/libs/mcp-client.js（浏览器目标、零 Node 内建依赖）
import { build } from 'esbuild';
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// 不用 import.meta.dirname（Node ≥20.11 才有），保持 engines 声明的 Node ≥20 可用
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'tools/build/mcp-client-entry.js');
const outfile = path.join(root, 'app/libs/mcp-client.js');
// 先写临时文件，全部校验通过后再原子替换，避免校验失败留下「新 bundle + 旧 version.json」
const tempOutfile = `${outfile}.build-${process.pid}.tmp`;

/** 从已安装的 client 包读取版本，写进产物头部便于追溯。 */
async function resolveSdkVersion() {
  // 包的 exports 未暴露 package.json，直接按 node_modules 路径读取
  const candidates = [
    path.join(root, 'node_modules/@modelcontextprotocol/client/package.json'),
    path.join(root, 'node_modules/@modelcontextprotocol/client/dist/package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(await readFile(candidate, 'utf8'));
      if (pkg.version) return pkg.version;
    } catch {
      // 继续尝试下一个位置
    }
  }
  return 'unknown';
}

const sdkVersion = await resolveSdkVersion();

let result;
try {
  result = await build({
    entryPoints: [entry],
    outfile: tempOutfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    legalComments: 'none',
    conditions: ['browser', 'import', 'default'],
    metafile: true,
    banner: {
      js: `/* 自动生成，请勿手改：tools/build-libs.mjs\n * 内容：@modelcontextprotocol/client v${sdkVersion} 浏览器 ESM bundle\n * 重新生成：npm run build:libs */`,
    },
  });
} catch (error) {
  await unlink(tempOutfile).catch(() => {});
  console.error(`构建失败：${error?.message ?? error}`);
  process.exit(1);
}

let source;
let size;
try {
  source = await readFile(tempOutfile, 'utf8');
  size = (await stat(tempOutfile)).size;
  const forbidden = ['node:', 'require("fs")', 'process.env'];
  const found = forbidden.filter((token) => source.includes(token));
  if (found.length > 0) {
    throw new Error(`产物中出现 Node 专有引用（AIUI 无法运行）：${found.join(', ')}`);
  }
  // 保证产物可被 AIUI 以 ESM 方式导入
  if (!source.includes('export')) {
    throw new Error('产物不是 ESM（缺少 export），请检查 esbuild 配置');
  }
  await rename(tempOutfile, outfile);
} catch (error) {
  await unlink(tempOutfile).catch(() => {});
  console.error(error?.message ?? error);
  process.exit(1);
}

const inputs = Object.keys(result.metafile.inputs);
console.log(`已生成 ${path.relative(root, outfile)}`);
console.log(`  SDK 版本：@modelcontextprotocol/client v${sdkVersion}`);
console.log(`  体积：${(size / 1024).toFixed(1)} KB`);
console.log(`  打包模块数：${inputs.length}`);
console.log('  Node 专有引用检查：通过（无 node: / process.env）');

// 记录产物指纹，便于确认仓库中的 bundle 与构建脚本同步
const fingerprint = (await import('node:crypto')).createHash('sha256').update(source).digest('hex').slice(0, 16);
await writeFile(
  path.join(root, 'app/libs/mcp-client.version.json'),
  `${JSON.stringify({ sdk: '@modelcontextprotocol/client', version: sdkVersion, sha256: fingerprint, bytes: size }, null, 2)}\n`,
);
console.log(`  指纹：sha256:${fingerprint}`);
