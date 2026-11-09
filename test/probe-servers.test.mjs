// 扫码授权使用真实 MCP SDK 与本地模拟服务；wx 仅替代未参与探测的宿主模块。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { build } from 'esbuild';
import { startMockWecomMcp } from './mock-mcp-server.mjs';

const bundle = await build({
  entryPoints: ['app/libs/session.js'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  write: false,
  plugins: [{
    name: 'wx-host',
    setup(builder) {
      builder.onResolve({ filter: /^wx$/ }, () => ({ path: 'wx', namespace: 'wx-host' }));
      builder.onLoad({ filter: /.*/, namespace: 'wx-host' }, () => ({ contents: 'export default {}' }));
    },
  }],
});
const source = Buffer.from(bundle.outputFiles[0].contents).toString('base64');
const { probeServers } = await import(`data:text/javascript;base64,${source}`);

test('扫码总预算到期后只重试失败 MCP，迟到结果和不同配置不能复用', async () => {
  const fast = await startMockWecomMcp({ apikey: 'probe-fast' });
  const slowOptions = { apikey: 'probe-slow', latencyMs: 5000 };
  const slow = await startMockWecomMcp(slowOptions);
  const configs = [{ name: '快', url: fast.url }, { name: '慢', url: slow.url }];
  try {
    const start = Date.now();
    const first = await probeServers(configs, { timeoutMs: 3000 });
    assert.equal(first.ok, false);
    assert.equal(first.completedCount, 1, '应保留先完成授权验证的 MCP');
    assert.ok(Date.now() - start < 4500, '总超时不应等待慢请求或清理');
    const fastCalls = Object.values(fast.calls).reduce((a, b) => a + b, 0);
    const fastRequests = fast.requests.length;
    assert.ok(fastCalls > 0, '成功项必须真实调用只读工具验证授权');
    slowOptions.latencyMs = 0;
    const second = await probeServers(configs, { timeoutMs: 10000, cache: first.cache });
    assert.equal(second.ok, true);
    assert.equal(second.completedCount, 2);
    assert.equal(Object.values(fast.calls).reduce((a, b) => a + b, 0), fastCalls, '重试不得再次调用成功项');
    assert.equal(fast.requests.length, fastRequests, '重试不得重新连接成功项');
    assert.ok(Object.values(slow.calls).reduce((a, b) => a + b, 0) > 0, '失败项必须真实执行授权验证');
    const slowCalls = Object.values(slow.calls).reduce((a, b) => a + b, 0);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const lateRetry = await probeServers(configs, { timeoutMs: 10000, cache: first.cache });
    assert.equal(lateRetry.ok, true);
    assert.ok(Object.values(slow.calls).reduce((a, b) => a + b, 0) > slowCalls, '迟到结果不得阻止失败项重新验证');
    assert.equal(Object.values(fast.calls).reduce((a, b) => a + b, 0), fastCalls, '迟到后重试仍应复用成功项');
    const changed = [{ ...configs[0], name: '更名' }, configs[1]];
    const third = await probeServers(changed, { timeoutMs: 10000, cache: second.cache });
    assert.equal(third.ok, true);
    assert.ok(Object.values(fast.calls).reduce((a, b) => a + b, 0) > fastCalls, '配置变化必须重新验证');
  } finally {
    await fast.close();
    await slow.close();
  }
});


test('取消扫码探测会及时关闭在途 HTTP 请求且不能返回授权成功', async () => {
  let markRequest;
  let markClosed;
  const requestStarted = new Promise((resolve) => { markRequest = resolve; });
  const requestClosed = new Promise((resolve) => { markClosed = resolve; });
  const server = http.createServer((req, res) => {
    req.resume();
    res.on('close', markClosed);
    markRequest();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  try {
    const url = `http://127.0.0.1:${server.address().port}/mcp?apikey=local`;
    const pending = probeServers([{ name: '等待', url }], { timeoutMs: 10000, signal: controller.signal });
    await requestStarted;
    controller.abort();
    const result = await Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('取消后仍未返回')), 1500)),
    ]);
    assert.equal(result.ok, false);
    await Promise.race([
      requestClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('HTTP 请求未关闭')), 1500)),
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


test('扫码探测区分无效凭据与未授权能力，不能把未验证当成通过', async () => {
  const server = await startMockWecomMcp({
    apikey: 'probe-valid',
    unauthorizedTools: ['message_aibot_sessions_list', 'calendar_schedules_list', 'todo_list', 'contact_users_search'],
  });
  try {
    const blocked = await probeServers([{ name: '受限', url: server.url }], { timeoutMs: 10000 });
    assert.equal(blocked.ok, true, '能力未授权允许带明确警告保存');
    assert.match(blocked.warnings.join(' '), /未授权/);
    const invalidUrl = new URL(server.url);
    invalidUrl.searchParams.set('apikey', 'invalid');
    const invalid = await probeServers([{ name: '无效', url: invalidUrl.toString() }], { timeoutMs: 10000 });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.authFailed, true, '无效凭据必须阻止保存');
  } finally {
    await server.close();
  }
});
