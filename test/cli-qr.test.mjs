// 终端二维码工具是用户侧唯一的配置入口：它的输出会直接进入眼镜摄像头。
// 这里验证两条硬约束：生成的终端输出绝不能把完整 API Key 打出来（否则被人/日志看到），
// 配置过长时必须自动分片（否则二维码扫不出来 = 用户无法完成授权）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CAPABILITIES } from '../app/libs/wecom-mcp.js';

const CLI = fileURLToPath(new URL('../tools/wecom-mcp-qr.mjs', import.meta.url));
const APIKEY = 'cli-secret-key-9f8e7d';

/**
 * 生成互不共享前缀的长 key：紧凑格式会提取所有 key 的公共前缀，key 前缀相同会让
 * 「大配置」凭空压缩成一张二维码，分片用例就测不到真实的多张路径了。
 */
function uniqueKey(index, length = 400) {
  return `${index}${'k'.repeat(length)}`;
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 30000 });
}

/** 异步启动 CLI（并发测试需要观察另一个进程持锁期间的行为）。 */
function spawnCli(args) {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const done = new Promise((resolve) => {
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  return { child, done };
}

/** 等导出进程拿到锁（锁文件是该进程对外可见的产物，用它可以确定性地制造并发重叠）。 */
async function waitForLockFile(dir, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const name = readdirSync(dir).find((entry) => entry.startsWith('.qr-export-') && entry.endsWith('.lock'));
    if (name) return name;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('等待导出锁文件超时（并发导出行为发生变化）');
}

test('终端输出包含可扫描二维码，但绝不打印完整 API Key', () => {
  const result = runCli([
    '--no-interactive',
    '--name',
    '企业微信消息',
    '--url',
    `https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=${APIKEY}`,
    '--mode',
    'light',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[终端二维码\]/);
  assert.ok(!result.stdout.includes(APIKEY), '终端输出泄露了完整 API Key');
  assert.ok(!result.stderr.includes(APIKEY), '错误输出泄露了完整 API Key');
  assert.match(result.stdout, /apikey=\*{4}/, '预览应为脱敏 URL');
});

test('URL 中的超长 API Key 不得生成眼镜无法解析的二维码', () => {
  const key = 'k'.repeat(513);
  const result = runCli([
    '--no-interactive', '--name', '企业微信消息',
    '--url', `https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=${key}`,
    '--mode', 'light',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /API Key 过长/);
  assert.doesNotMatch(result.stdout, /\[终端二维码\]/);
  assert.ok(!result.stderr.includes(key), '错误信息不得泄露密钥');
});

test('含不支持字符的 Key 在交互录入时提示并允许更正', () => {
  const result = spawnSync(process.execPath, [CLI, '--mode', 'light'], {
    encoding: 'utf8', timeout: 30000,
    input: '\n\nsecret.with.dot\nvalid_key-123\nmsg\nn\n',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /API Key 格式不正确：仅支持英文字母、数字、- 和 _/);
  assert.match(result.stdout, /\[终端二维码\]/);
  assert.ok(!result.stdout.includes('secret.with.dot'));
});

test('含不支持字符的 URL 在交互录入时提示并允许更正', () => {
  const result = spawnSync(process.execPath, [CLI, '--mode', 'light'], {
    encoding: 'utf8', timeout: 30000,
    input: '\nhttps://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=secret%2Ewith%2Edot\n\nhttps://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=valid_key-123\nn\n',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /API Key 格式不正确：仅支持英文字母、数字、- 和 _/);
  assert.match(result.stdout, /\[终端二维码\]/);
  assert.ok(!result.stdout.includes('secret.with.dot'));
});

test('配置超出单张二维码容量时自动分片，并提示逐张扫描', () => {
  const result = runCli([
    '--no-interactive',
    '--name',
    '企业微信消息',
    '--url',
    `https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=${uniqueKey(0)}`,
    '--name',
    '企业微信文档',
    '--url',
    `https://qyapi.weixin.qq.com/mcp/v2/bot/doc?apikey=${uniqueKey(1)}`,
    '--name',
    '企业微信日程',
    '--url',
    `https://qyapi.weixin.qq.com/mcp/v2/bot/schedule?apikey=${uniqueKey(2)}`,
    '--mode',
    'light',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /请依次扫描\s*第\s*1\/\d+\s*张/);
  assert.match(result.stdout, /二维码分片：[2-9] 张/);
  assert.ok(!result.stdout.includes('k'.repeat(400)), '分片输出泄露了完整 API Key');
});

test('从 JSON/TXT 配置文件导入多个独立 Token（每个能力位一把 key）且不泄露凭据', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wecom-mcp-file-'));
  const capabilities = CAPABILITIES.map((capability) => capability.id);
  try {
    const jsonPath = path.join(dir, 'servers.json');
    const jsonServers = capabilities.map((capability, index) => ({
      name: `测试连接${index + 1}`,
      url: `https://qyapi.weixin.qq.com/mcp/v2/bot/${capability}?apikey=${uniqueKey(index)}`,
    }));
    writeFileSync(jsonPath, JSON.stringify({ servers: jsonServers }), { mode: 0o600 });

    const jsonResult = runCli(['--no-interactive', '--file', jsonPath, '--mode', 'light']);
    assert.equal(jsonResult.status, 0, jsonResult.stderr);
    assert.match(jsonResult.stdout, /MCP Server 8 个/);
    assert.match(jsonResult.stdout, /请依次扫描\s*第\s*1\/\d+\s*张/, '长 key 配置应分成多张');
    assert.ok(!jsonResult.stdout.includes(uniqueKey(0)), 'JSON 文件里的完整 Token 不得出现在控制台输出');

    // 能力位固定 8 个：同一能力位重复配置必须明确报错，而不是静默丢一把 key
    const duplicatePath = path.join(dir, 'duplicate.json');
    writeFileSync(
      duplicatePath,
      JSON.stringify({
        servers: [
          { name: '消息A', url: 'https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=aaa' },
          { name: '消息B', url: 'https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=bbb' },
        ],
      }),
      { mode: 0o600 },
    );
    const duplicateResult = runCli(['--no-interactive', '--file', duplicatePath, '--mode', 'light']);
    assert.equal(duplicateResult.status, 1);
    assert.match(duplicateResult.stderr, /DUPLICATE_CAPABILITY/);
    assert.ok(!duplicateResult.stdout.includes('[终端二维码]'), '重复能力位不应生成二维码');

    const txtPath = path.join(dir, 'servers.txt');
    writeFileSync(
      txtPath,
      [
        '# 每行一个 URL，Token 可各不相同',
        'https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=txt-msg-token-secret',
        '',
        'https://qyapi.weixin.qq.com/mcp/v2/bot/doc?apikey=txt-doc-token-secret',
      ].join('\n'),
      { mode: 0o600 },
    );
    const txtResult = runCli(['--no-interactive', '--file', txtPath, '--mode', 'light']);
    assert.equal(txtResult.status, 0, txtResult.stderr);
    assert.match(txtResult.stdout, /MCP Server 2 个/);
    assert.ok(!txtResult.stdout.includes('txt-msg-token-secret'));
    assert.ok(!txtResult.stdout.includes('txt-doc-token-secret'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('非官方地址被拒绝：http 地址不会生成二维码', () => {
  const result = runCli([
    '--no-interactive',
    '--name',
    '伪造配置',
    '--url',
    'http://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=abc',
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /INSECURE_URL/);
  assert.ok(!result.stdout.includes('[终端二维码]'), '非法配置不应生成二维码');
});

test('8 个能力位配置生成单张 v4 紧凑二维码，且不泄露完整 Key', () => {
  // 用户最常遇到的场景：8 个能力位 + 同源 API Key（共享长前缀）。紧凑格式应能一张扫完。
  const shared = `FAKE-shared-prefix-${'X'.repeat(50)}`;
  const capabilities = CAPABILITIES.map((capability) => capability.id);
  const serverArgs = [];
  capabilities.forEach((capability, index) => {
    serverArgs.push('--name', `企业微信${capability}`);
    serverArgs.push('--url', `https://qyapi.weixin.qq.com/mcp/v2/bot/${capability}?apikey=${shared}${'ta'.repeat(12)}${index}`);
  });

  const result = runCli(['--no-interactive', ...serverArgs, '--mode', 'light']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /内容编码：紧凑载荷 v4/);
  assert.match(result.stdout, /二维码分片：1 张/);
  assert.ok(!result.stdout.includes(shared), '紧凑载荷同样不得把完整 Key 打到终端');
});

test('--png 覆盖已存在的 0644 文件后权限也必须收紧为 600（含真实 API Key 的落盘边界）', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wecom-mcp-png-'));
  try {
    const pngPath = path.join(dir, 'config-qr.png');
    // 用户很可能导出过旧二维码（默认 0644）；本次覆盖时不能沿用旧权限把新 Key 留在可读文件里。
    writeFileSync(pngPath, 'old-qr', { mode: 0o644 });
    chmodSync(pngPath, 0o644);
    assert.equal(statSync(pngPath).mode & 0o777, 0o644, '前置条件：已存在文件必须是 0644');

    const result = runCli([
      '--no-interactive',
      '--name',
      '企业微信消息',
      '--url',
      `https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=${APIKEY}`,
      '--png',
      pngPath,
      '--mode',
      'light',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /已导出 PNG/);
    const mode = statSync(pngPath).mode & 0o777;
    assert.equal(mode, 0o600, `覆盖导出含真实凭据，权限应为 600，实际 ${mode.toString(8)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('长 key 配置配合 --max-chars 2000 能成功分片（P1 回归）', () => {
  // 回归点：分片要同时满足「每片字符数」与二维码 2331 字节上限；参数变化时不能生成超容量二维码。
  const longName = '企业微信消息能力位配置名称说明文字补充内容占位扩展字段'.repeat(2);
  const capabilities = CAPABILITIES.map((capability) => capability.id);
  const args = ['--no-interactive', '--mode', 'light', '--max-chars', '2000'];
  capabilities.forEach((capability, index) => {
    args.push('--name', `${longName.slice(0, 38)}${String(index).padStart(2, '0')}`);
    args.push('--url', `https://qyapi.weixin.qq.com/mcp/v2/bot/${capability}?apikey=${uniqueKey(index)}`);
  });

  const result = runCli(args);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /QR_TOO_LARGE/);
  assert.match(result.stdout, /请依次扫描\s*第\s*1\/\d+\s*张/);
});

test('--help 与其他非法参数同时出现时仍然成功输出帮助（P2 回归）', () => {
  const result = runCli(['--help', '--url', 'http://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=x', '--bogus']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Rokid 企业微信助手 终端二维码生成工具/);
  assert.match(result.stdout, /--max-chars/);
});

test('重复导出同前缀：先单张后多张时清理旧无序号单张，且不误删其他文件', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wecom-mcp-clean-'));
  try {
    const pngPath = path.join(dir, 'qr.png');
    const single = runCli([
      '--no-interactive',
      '--name',
      '企业微信消息',
      '--url',
      `https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=${APIKEY}`,
      '--png',
      pngPath,
      '--mode',
      'light',
    ]);
    assert.equal(single.status, 0, single.stderr);
    assert.ok(existsSync(pngPath), '前置条件：单张导出应生成 qr.png');

    // 目录里同时存在无关文件与上次遗留的旧序号分片：清理必须只针对本次前缀 + 纯数字序号
    writeFileSync(path.join(dir, 'other.png'), 'keep');
    writeFileSync(path.join(dir, 'qr-abc.png'), 'keep');
    writeFileSync(path.join(dir, 'qr-99.png'), 'stale');

    const multi = runCli([
      '--no-interactive',
      '--name',
      '企业微信消息',
      '--url',
      `https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=${'k'.repeat(400)}`,
      '--name',
      '企业微信文档',
      '--url',
      `https://qyapi.weixin.qq.com/mcp/v2/bot/doc?apikey=${'d'.repeat(400)}`,
      '--name',
      '企业微信日程',
      '--url',
      `https://qyapi.weixin.qq.com/mcp/v2/bot/schedule?apikey=${'s'.repeat(400)}`,
      '--png',
      pngPath,
      '--mode',
      'light',
    ]);
    assert.equal(multi.status, 0, multi.stderr);
    const total = Number(multi.stdout.match(/二维码分片：(\d+) 张/)?.[1] ?? 0);
    assert.ok(total > 1, '本次应生成多张二维码');

    assert.ok(!existsSync(pngPath), '上次单张导出的无序号文件必须清理，避免新旧二维码混扫');
    assert.ok(!existsSync(path.join(dir, 'qr-99.png')), '不属于本次范围的旧序号分片必须清理');
    assert.ok(existsSync(path.join(dir, 'qr-1.png')), '本次分片应从 qr-1.png 开始');
    assert.ok(existsSync(path.join(dir, `qr-${total}.png`)), '本次最后一张分片应存在');
    assert.ok(existsSync(path.join(dir, 'other.png')), '无关文件不得删除');
    assert.ok(existsSync(path.join(dir, 'qr-abc.png')), '同前缀但非纯数字的无关文件不得删除');
    assert.match(multi.stdout, /将删除：.*qr\.png/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('未知参数（可能误贴 API Key）只报错不回显内容', () => {
  const result = runCli(['--no-interactive', `--bogus-${APIKEY}`]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /无法识别/);
  assert.ok(!result.stdout.includes(APIKEY), 'stdout 不得回显未知参数中的 key');
  assert.ok(!result.stderr.includes(APIKEY), 'stderr 不得回显未知参数中的 key');
});

test('同一物理目标经软链别名并发导出：后发进程明确失败，锁文件不含路径/凭据', async () => {
  // 真实风险：两个终端同时导出到同一物理目录（例如一个用软链路径）会互删分片/混扫。
  // 导出锁必须按 realpath 归一化并把冲突明确报给后发进程，而不是静默覆盖。
  const realDir = mkdtempSync(path.join(os.tmpdir(), 'wecom-mcp-lock-real-'));
  const aliasRoot = mkdtempSync(path.join(os.tmpdir(), 'wecom-mcp-lock-link-'));
  const aliasDir = path.join(aliasRoot, 'alias');
  symlinkSync(realDir, aliasDir, 'dir');
  try {
    writeFileSync(path.join(realDir, 'other.png'), 'keep');
    const args = ['--no-interactive', '--mode', 'light', '--max-chars', '250'];
    ['msg', 'doc', 'schedule', 'todo'].forEach((capability, index) => {
      args.push('--name', `企业微信消息能力位配置名称说明${index}`);
      args.push('--url', `https://qyapi.weixin.qq.com/mcp/v2/bot/${capability}?apikey=${uniqueKey(index)}`);
    });
    const first = spawnCli([...args, '--png', path.join(realDir, 'qr.png')]);
    const lockName = await waitForLockFile(realDir);
    const lockText = readFileSync(path.join(realDir, lockName), 'utf8');
    assert.ok(!lockText.includes(APIKEY), '锁文件不得包含 API Key');
    assert.ok(!lockText.includes(realDir), '锁文件不得包含用户路径');
    assert.ok(!lockText.includes('apikey'), '锁文件不得包含 URL/查询参数');

    const second = spawnCli([
      '--no-interactive',
      '--mode',
      'light',
      '--name',
      '企业微信消息',
      '--url',
      'https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=another-secret',
      '--png',
      path.join(aliasDir, 'qr.png'),
    ]);
    const secondResult = await second.done;
    assert.equal(secondResult.status, 1, '软链别名的并发导出必须失败而不是互相覆盖');
    assert.match(secondResult.stderr, /EXPORT_LOCKED/);

    const firstResult = await first.done;
    assert.equal(firstResult.status, 0, firstResult.stderr);
    const total = Number(firstResult.stdout.match(/二维码分片：(\d+) 张/)?.[1] ?? 0);
    assert.ok(total > 1, '第一方应成功生成多张二维码');
    assert.ok(existsSync(path.join(realDir, 'qr-1.png')));
    assert.ok(existsSync(path.join(realDir, `qr-${total}.png`)));
    assert.ok(existsSync(path.join(realDir, 'other.png')), '无关文件不得被删除');
    const leftoverLocks = readdirSync(realDir).filter((name) => name.startsWith('.qr-export-') && name.endsWith('.lock'));
    assert.deepEqual(leftoverLocks, [], '导出完成后不得残留锁文件');
  } finally {
    rmSync(realDir, { recursive: true, force: true });
    rmSync(aliasRoot, { recursive: true, force: true });
  }
});

test('同次 --png 与 --svg 输出范围重叠时在写入前明确拒绝，不删改任何文件', () => {
  // 真实误操作：两个参数指向同一路径（或同目录同前缀）。若放行，PNG 与 SVG 阶段
  // 会互相清理/覆盖对方输出，用户最后只看到「成功」却拿到混扫的二维码。
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wecom-mcp-overlap-'));
  try {
    const target = path.join(dir, 'qr.png');
    writeFileSync(target, 'kept', { mode: 0o644 });
    chmodSync(target, 0o644);
    writeFileSync(path.join(dir, 'qr-9.png'), 'stale');
    writeFileSync(path.join(dir, 'other.png'), 'keep');

    const result = runCli([
      '--no-interactive',
      '--name',
      '企业微信消息',
      '--url',
      `https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=${APIKEY}`,
      '--png',
      target,
      '--svg',
      target,
      '--mode',
      'light',
    ]);

    assert.equal(result.status, 1, '重叠输出必须明确失败');
    assert.match(result.stderr, /EXPORT_CONFLICT/);
    assert.equal(readFileSync(target, 'utf8'), 'kept', '拒绝时必须发生在写入前，不得覆盖已有文件');
    assert.equal(readFileSync(path.join(dir, 'qr-9.png'), 'utf8'), 'stale', '不得提前清理旧分片');
    assert.equal(readFileSync(path.join(dir, 'other.png'), 'utf8'), 'keep');
    const locks = readdirSync(dir).filter((name) => name.startsWith('.qr-export-') && name.endsWith('.lock'));
    assert.deepEqual(locks, [], '拒绝时不得残留锁文件');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SIGTERM 终止导出时同步释放导出锁，不阻塞后续同目标导出', async () => {
  // 真实场景：用户 Ctrl-C/关闭终端（SIGTERM）终止正在导出的进程；若锁不释放，
  // 用户重试时会一直看到「另一个导出进程正在写入」而无法继续。
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wecom-mcp-sigterm-'));
  try {
    const args = ['--no-interactive', '--mode', 'light', '--max-chars', '250'];
    ['msg', 'doc', 'schedule', 'todo', 'meeting', 'contact'].forEach((capability, index) => {
      args.push('--name', `企业微信消息能力位配置名称说明${index}`);
      args.push('--url', `https://qyapi.weixin.qq.com/mcp/v2/bot/${capability}?apikey=${uniqueKey(index)}`);
    });
    const first = spawnCli([...args, '--png', path.join(dir, 'qr.png')]);
    await waitForLockFile(dir);
    first.child.kill('SIGTERM');
    const firstResult = await first.done;
    assert.equal(firstResult.status, 143, `SIGTERM 应按 128+15 退出，实际 ${firstResult.status}`);
    assert.match(firstResult.stderr, /SIGTERM/);
    const leftoverLocks = readdirSync(dir).filter((name) => name.startsWith('.qr-export-') && name.endsWith('.lock'));
    assert.deepEqual(leftoverLocks, [], 'SIGTERM 后不得残留锁文件');

    // 锁已释放：同一目标再次导出必须成功，而不是被残留锁以 EXPORT_LOCKED 挡住
    const again = runCli([
      '--no-interactive',
      '--name',
      '企业微信消息',
      '--url',
      `https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=${APIKEY}`,
      '--png',
      path.join(dir, 'qr.png'),
      '--mode',
      'light',
    ]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /已导出 PNG/);
    assert.ok(existsSync(path.join(dir, 'qr.png')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
