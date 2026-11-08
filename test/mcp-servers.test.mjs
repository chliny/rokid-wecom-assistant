// 企业微信官方 MCP 的客户端行为验证（真实 MCP SDK + 本地模拟服务端）。
//
// 模拟服务端复刻了实测到的真实语义（取证记录只保留在本地，未随仓库提供）：
// initialize / tools/list 不校验 apikey，只有 tools/call 才返回业务错误。
// 这正是本项目最关键的业务风险：**连接成功 ≠ 授权可用**，必须用只读工具实调探测。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockWecomMcp } from './mock-mcp-server.mjs';
import { McpServers } from '../app/libs/mcp-servers.js';

/** @type {Awaited<ReturnType<typeof startMockWecomMcp>>} */
let mock;
const APIKEY = 'secret-key-123';

before(async () => {
  mock = await startMockWecomMcp({ apikey: APIKEY, unauthorizedTools: ['doc_search'] });
});

after(async () => {
  await mock?.close();
});

function createServers(url, deps = {}) {
  return new McpServers([{ name: '企业微信消息', url }], { timeoutMs: 8000, callTimeoutMs: 8000, ...deps });
}

/**
 * 轮询等待异步副作用发生，避免固定 sleep 在慢机器上误判（如请求还没到达服务端就断言）。
 * @param {() => boolean} check
 * @param {string} message
 * @param {{timeoutMs?: number, intervalMs?: number}} [options]
 */
async function waitFor(check, message, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail(message);
}

test('连接后能发现真实工具清单，区分读写，并能实际发送消息', async () => {
  const servers = createServers(mock.url);
  try {
    const results = await servers.connectAll();
    assert.equal(results[0].ok, true, results[0].error?.message);

    const tools = servers.tools;
    assert.ok(tools.length >= 6, `应发现企业微信工具，实际 ${tools.length} 个`);
    const sendTool = tools.find((tool) => tool.name === 'message_send');
    const aibotSendTool = tools.find((tool) => tool.name === 'message_aibot_send');
    const listTool = tools.find((tool) => tool.name === 'message_aibot_sessions_list');
    assert.equal(sendTool?.write, true, 'message_send 必须被判定为写操作');
    assert.equal(aibotSendTool?.write, true, 'message_aibot_send 同样是写操作，必须要求用户确认');
    assert.equal(listTool?.write, false, '会话列表查询必须被判定为读操作');

    const result = await servers.callTool(sendTool.namespacedName, {
      chat_id: 'wr_zhangsan',
      msg_type: 'text',
      text: { content: '你好' },
    });
    assert.equal(result.ok, true, result.text);
    assert.deepEqual(mock.sent.at(-1), { chat_id: 'wr_zhangsan', msg_type: 'text', content: '你好' });
  } finally {
    await servers.closeAll();
  }
});

test('授权有效时，探测成功并返回实际调用的探测工具', async () => {
  const servers = createServers(mock.url);
  try {
    await servers.connectAll();
    const [verify] = await servers.verifyAuthorizationAll();
    assert.equal(verify.verified, true);
    assert.ok(verify.toolName, '成功时需带本次实际调用的探测工具名');
    assert.equal(verify.reason, undefined);
    assert.equal(verify.error, undefined);
  } finally {
    await servers.closeAll();
  }
});

test('tools/list 成功但 apikey 已失效时，探测必须判定为未授权并要求重新扫码', async () => {
  // 真实端点行为：key 错误时 initialize / tools/list 依然成功，只有 tools/call 返回 850001
  const expiredUrl = mock.url.replace(APIKEY, 'expired-key');
  const servers = createServers(expiredUrl);
  try {
    const results = await servers.connectAll();
    assert.equal(results[0].ok, true, '连接与工具清单本身会成功（与真实端点一致）');
    assert.ok(results[0].tools > 0);

    const [verify] = await servers.verifyAuthorizationAll();
    assert.equal(verify.verified, false, '必须通过实调探测出授权失效');
    assert.equal(verify.reason, 'probe-failed', 'apikey 失效属于探测失败，不是能力位未授权');
    assert.equal(verify.error?.code, 'UNAUTHORIZED');
    assert.equal(verify.error?.needRescan, true);

    const tool = servers.tools.find((item) => item.name === 'calendar_schedules_list');
    await assert.rejects(
      servers.callTool(tool.namespacedName, {}),
      (error) => error.code === 'UNAUTHORIZED' && error.needRescan === true,
    );
  } finally {
    await servers.closeAll();
  }
});

test('能力位未授权时，调用返回需去后台补授权的明确错误（不要求重新扫码）', async () => {
  const servers = createServers(mock.url);
  try {
    await servers.connectAll();
    const docTool = servers.tools.find((tool) => tool.name === 'doc_search');
    await assert.rejects(
      servers.callTool(docTool.namespacedName, { keywords: ['项目'] }),
      (error) => error.code === 'FORBIDDEN' && error.needRescan === false,
    );
  } finally {
    await servers.closeAll();
  }
});

test('能力位全部未授权时，探测上报 capability-unauthorized 而不是 apikey 失效', async () => {
  // 851008 与 850001 对用户意味着完全不同的下一步：前者去「可使用权限」授权，后者重新扫码。
  // 探测会依次试多个无参只读工具，只有全部命中 851008 才是「能力位未授权」。
  const blocked = await startMockWecomMcp({
    apikey: APIKEY,
    unauthorizedTools: [
      'message_aibot_sessions_list',
      'calendar_schedules_list',
      'todo_list',
      'contact_users_search',
    ],
  });
  const servers = createServers(blocked.url);
  try {
    await servers.connectAll();
    const [verify] = await servers.verifyAuthorizationAll();
    assert.equal(verify.verified, false);
    assert.equal(verify.reason, 'capability-unauthorized');
    assert.equal(verify.error?.code, 'FORBIDDEN');
    assert.equal(verify.error?.needRescan, false, '851008 只需后台补授权，不应引导重新扫码');
  } finally {
    await servers.closeAll();
    await blocked.close();
  }
});

test('写操作超时后绝不重连重放：服务端只执行一次', async () => {
  // 真实事故场景：请求超时但服务端其实已经执行成功，若自动重试，用户会收到两条相同的消息。
  const slowWrite = await startMockWecomMcp({ apikey: APIKEY, toolLatencyMs: 800 });
  const servers = createServers(slowWrite.url, { callTimeoutMs: 200 });
  try {
    await servers.connectAll();
    const sendTool = servers.tools.find((tool) => tool.name === 'message_send');
    await assert.rejects(
      servers.callTool(sendTool.namespacedName, {
        chat_id: 'wr_zhangsan',
        msg_type: 'text',
        text: { content: '这条消息在超时后已经被服务端发出' },
      }),
      (error) => error.code === 'TIMEOUT',
    );

    // 先确认请求确实到达服务端（避免在慢机器上请求还没发出就断言），
    // 再等慢响应与任何潜在重放都结束：若发生过重放，会在这里看到第二次执行。
    await waitFor(() => (slowWrite.calls.message_send ?? 0) >= 1, '写请求应已到达服务端');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(slowWrite.calls.message_send, 1, '写操作超时后不得重放');
    assert.equal(slowWrite.sent.length, 1, '用户只应收到一条消息');
  } finally {
    await servers.closeAll();
    await slowWrite.close();
  }
});

test('只读工具超时仍然重连重试一次（不受写操作修复影响）', async () => {
  const slowRead = await startMockWecomMcp({ apikey: APIKEY, toolLatencyMs: 800 });
  const servers = createServers(slowRead.url, { callTimeoutMs: 200 });
  try {
    await servers.connectAll();
    const listTool = servers.tools.find((tool) => tool.name === 'calendar_schedules_list');
    await assert.rejects(servers.callTool(listTool.namespacedName, {}), (error) => error.code === 'TIMEOUT');
    await waitFor(
      () => (slowRead.calls.calendar_schedules_list ?? 0) >= 2,
      '只读工具应按约定重试一次（未观察到第二次调用）',
    );
    assert.equal(slowRead.calls.calendar_schedules_list, 2);
  } finally {
    await servers.closeAll();
    await slowRead.close();
  }
});

test('网络响应过慢时按超时上报，不误报成授权失败', async () => {
  const slow = await startMockWecomMcp({ apikey: APIKEY, latencyMs: 700 });
  const servers = createServers(slow.url, { timeoutMs: 250, callTimeoutMs: 250 });
  try {
    const results = await servers.connectAll();
    assert.equal(results[0].ok, false);
    assert.equal(results[0].error?.code, 'TIMEOUT');
    assert.notEqual(results[0].error?.needRescan, true, '超时不应诱导用户重新授权');
  } finally {
    await servers.closeAll();
    await slow.close();
  }
});

test('关闭连接后在途 connect 不得在关闭后复活', async () => {
  // 真实场景：用户在连接过程中删除配置/退出页面，closeAll() 返回后旧 initialize 才完成。
  // 若旧连接仍把状态改回 ready，就会出现「已删除的配置又连着、工具又出现」的幽灵连接。
  const slow = await startMockWecomMcp({ apikey: APIKEY, latencyMs: 300 });
  const servers = createServers(slow.url);
  try {
    const pending = servers.connectAll();
    const settled = pending.then(
      () => 'resolved',
      (error) => error,
    );
    await servers.closeAll();
    await settled;

    // 等旧 initialize/listTools 的迟到回调都跑完，再确认状态没有被改回 ready
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(servers.connections[0].status, 'closed', '关闭后状态必须保持 closed');
    assert.equal(servers.readyCount, 0, '关闭后不得有任何就绪连接');
    assert.equal(servers.tools.length, 0, '关闭后不得复活出可用工具');
  } finally {
    await servers.closeAll();
    await slow.close();
  }
});

test('只读工具调用在途时关闭连接：调用被取消且不得重连复活', async () => {
  // 真实场景：用户删除配置/退出页面时，页面上一次只读查询还在等响应。
  // closeAll() 之后这次调用必须直接结束，不能把已关闭的连接重连回来（幽灵连接）。
  const slow = await startMockWecomMcp({ apikey: APIKEY, toolLatencyMs: 400 });
  const servers = createServers(slow.url);
  try {
    await servers.connectAll();
    const listTool = servers.tools.find((tool) => tool.name === 'message_aibot_sessions_list');
    assert.ok(listTool, '应发现会话列表只读工具');
    const callsBefore = slow.calls.message_aibot_sessions_list ?? 0;
    const pending = servers.callTool(listTool.namespacedName, {});
    await waitFor(
      () => (slow.calls.message_aibot_sessions_list ?? 0) === callsBefore + 1,
      '只读调用应已到达服务端',
    );

    const requestsAtClose = slow.requests.length;
    await servers.closeAll();
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, 'NETWORK');
      assert.equal(error.retryable, false, '关闭导致的取消不能标记为可重试');
      assert.match(error.message, /已关闭/);
      return true;
    });

    // 等迟到响应落定：关闭后不能出现新一轮 initialize/重试请求，也不能重放只读调用
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(slow.requests.length, requestsAtClose, '关闭后不得发起重连/initialize');
    assert.equal(slow.calls.message_aibot_sessions_list, callsBefore + 1, '关闭后不得重放只读调用');
    assert.equal(servers.connections[0].status, 'closed');
    assert.equal(servers.readyCount, 0);
  } finally {
    await servers.closeAll();
    await slow.close();
  }
});

test('断线重连过程中用户关闭连接：旧重连不得把已关闭连接复活', async () => {
  // 真实场景：请求遇到瞬时网络错误触发自动重连；重连内部 close 期间用户删除配置
  // （外部 close 再次递增 generation）——外部关闭必须优先，旧重连不得再 initialize。
  const flaky = await startMockWecomMcp({ apikey: APIKEY, dropToolCalls: 1 });
  const servers = createServers(flaky.url);
  const events = [];
  try {
    servers.onStateChange((event) => events.push(event.type));
    await servers.connectAll();
    const listTool = servers.tools.find((tool) => tool.name === 'message_aibot_sessions_list');
    assert.ok(listTool);
    let externallyClosed = false;
    servers.onStateChange((event) => {
      if (event.type === 'closed' && !externallyClosed) {
        externallyClosed = true;
        // 在重连内部 close 还没结束时用户再次关闭（异步，不等待）
        servers.closeAll();
      }
    });

    await assert.rejects(servers.callTool(listTool.namespacedName, {}), (error) => {
      assert.equal(error.code, 'NETWORK');
      assert.equal(error.retryable, false);
      assert.match(error.message, /已关闭/);
      return true;
    });
    assert.equal(externallyClosed, true, '应发生外部关闭');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(servers.connections[0].status, 'closed', '外部关闭后连接必须保持 closed');
    assert.equal(servers.readyCount, 0, '旧重连不得复活连接');
    assert.equal(events.filter((type) => type === 'ready').length, 1, '只允许首次连接的 ready');
  } finally {
    await servers.closeAll();
    await flaky.close();
  }
});

test('授权探针：只读调用断线重连后同名工具变为写操作必须 fail-closed，不得重试执行', async () => {
  // 真实场景：扫页做授权探测时网络瞬断，重连后服务端把同名工具改成写操作。
  // 探针是自动重试的只读调用，绝不能拿旧的「只读」认知去重放成写操作（未确认就执行）。
  const flaky = await startMockWecomMcp({
    apikey: APIKEY,
    dropToolCalls: 1,
    switchVariantAfterDrop: 'sessions-read-as-write',
  });
  const servers = createServers(flaky.url);
  try {
    await servers.connectAll();
    const [result] = await servers.verifyAuthorizationAll();
    assert.equal(result.verified, false, '工具变为写操作后探针必须失败，不得执行');
    assert.equal(result.reason, 'probe-failed');
    assert.equal(flaky.calls.message_aibot_sessions_list, undefined, '变写后的同名工具执行次数必须为 0');
  } finally {
    await servers.closeAll();
    await flaky.close();
  }
});

test('授权探针挑选后、调用前工具变为写操作必须 fail-closed，不得执行写探针', async () => {
  // 真实竞态：pickProbeTools 按「只读」挑出候选后，服务端在下一探针调用前刷新了 tools
  // 并把同名工具标成写操作。探针绝不能拿当前写法去执行（未确认的写）。
  const mock = await startMockWecomMcp({
    apikey: APIKEY,
    toolLatencyMs: 300,
    unauthorizedTools: ['message_aibot_sessions_list'],
  });
  const servers = createServers(mock.url);
  try {
    await servers.connectAll();
    const verify = servers.verifyAuthorizationAll();
    await waitFor(
      () => (mock.calls.message_aibot_sessions_list ?? 0) >= 1,
      '第一探针应已到达服务端（慢响应中）',
    );
    // 第一探针还在途时服务端刷新：下一个候选 calendar_schedules_list 变成写操作
    mock.setToolVariant('calendar-list-read-as-write');
    await servers.refreshAllTools();
    const [result] = await verify;
    assert.equal(result.verified, false);
    assert.equal(result.reason, 'probe-failed');
    assert.equal(mock.calls.calendar_schedules_list, undefined, '变为写操作的探针不得执行');
  } finally {
    await servers.closeAll();
    await mock.close();
  }
});
