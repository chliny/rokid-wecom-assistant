// 助手编排的对外行为：读操作直接执行，写操作必须用户确认后才真正发出。
//
// 这是本应用最高风险的产品约束（「删除/发送类操作必须用户确认」），
// 用真实 MCP SDK + 模拟企业微信服务端验证，而不是断言内部状态。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockWecomMcp } from './mock-mcp-server.mjs';
import { McpServers } from '../app/libs/mcp-servers.js';
import { Assistant } from '../app/libs/assistant.js';

/** @type {Awaited<ReturnType<typeof startMockWecomMcp>>} */
let mock;
const APIKEY = 'secret-key-123';

before(async () => {
  mock = await startMockWecomMcp({ apikey: APIKEY });
});

after(async () => {
  await mock?.close();
});

/** 关闭 LanguageModel，验证无 AI 能力时的规则兜底链路。 */
function createAssistant(url, deps = {}) {
  const servers = new McpServers([{ name: '企业微信消息', url }], { timeoutMs: 8000, callTimeoutMs: 8000 });
  return { servers, assistant: new Assistant({ servers, languageModel: null, ...deps }) };
}

test('查询类请求直接执行并返回可读结果', async () => {
  const { servers, assistant } = createAssistant(mock.url);
  try {
    const result = await assistant.ask('查询我今天的日程');
    assert.equal(result.kind, 'answer');
    assert.match(result.text, /产品评审/);
    assert.ok(result.speech.length > 0, '需要给眼镜语音播报一段话');
  } finally {
    await servers.closeAll();
  }
});

test('发送消息必须先确认，确认页完整展示参数，未确认时绝不能真正发出', async () => {
  const { servers, assistant } = createAssistant(mock.url);
  try {
    const before = mock.sent.length;
    const asked = await assistant.ask('给张三发送消息，内容是明天下午三点开会');
    assert.equal(asked.kind, 'confirm');
    assert.match(asked.text, /确认/);
    assert.equal(mock.sent.length, before, '等待确认期间不得发送');

    // mock 里同时注册了官方写入工具 message_aibot_send（msg_type 枚举 5 种）作为干扰项：
    // 这句话必须选中 message_send —— 下面的 sent 形状只有 message_send 会写出来，
    // 选错工具时会变成 kind:'error' 或参数不匹配而自然失败。
    const done = await assistant.confirm();
    assert.equal(done.kind, 'answer');
    assert.equal(mock.sent.length, before + 1, '一次确认只能发送一条');
    assert.deepEqual(mock.sent.at(-1), {
      chat_id: '张三',
      msg_type: 'text',
      content: '明天下午三点开会',
    });

    // 正文较长时确认页必须完整展示（不隐形截断），否则用户看不到将要发出的真实内容；
    // 确认后也必须逐字发出同样内容。
    const longContent = `项目进度同步：${'明天下午三点开会讨论发布计划与回滚方案。'.repeat(10)}`;
    assert.ok(longContent.length > 200, '长正文用例应超过 200 字');
    const askedLong = await assistant.ask(`给李四发送消息，内容是${longContent}`);
    assert.equal(askedLong.kind, 'confirm');
    assert.ok(askedLong.text.includes(longContent), '确认页必须完整展示全部正文');
    assert.equal(mock.sent.length, before + 1, '等待确认期间不得发送');

    await assistant.confirm();
    assert.equal(mock.sent.length, before + 2);
    assert.deepEqual(mock.sent.at(-1), {
      chat_id: '李四',
      msg_type: 'text',
      content: longContent,
    });
  } finally {
    await servers.closeAll();
  }
});

test('工具业务失败必须上报为错误，而不是当成执行成功', async () => {
  // 企业微信把业务错误包在 isError=false 的 content JSON 里（40058=文本超过 2048 字符）。
  // 若客户端只看 isError，就会把「发送失败」当成功播报给用户 —— 写操作尤其危险。
  const { servers, assistant } = createAssistant(mock.url);
  try {
    const before = mock.sent.length;
    const asked = await assistant.ask(`给张三发送消息，内容是${'很长的消息'.repeat(500)}`);
    assert.equal(asked.kind, 'confirm');

    const done = await assistant.confirm();
    assert.equal(done.kind, 'error', '业务错误不得上报为 answered');
    assert.match(done.text, /40058/, '错误信息需带上企业微信业务错误码');
    assert.equal(mock.sent.length, before, '失败的写操作不得产生发送记录');
  } finally {
    await servers.closeAll();
  }
});

test('取消确认后不执行写操作', async () => {
  const { servers, assistant } = createAssistant(mock.url);
  try {
    const before = mock.sent.length;
    await assistant.ask('给李四发送消息，内容是这条不要发出去');
    const cancelled = assistant.cancel();
    assert.match(cancelled.text, /取消/);
    // 等待一次宏任务：若取消后仍异步发出请求，这里才可能观察到，避免同步断言恒真
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(mock.sent.length, before, '取消后不得发送');
  } finally {
    await servers.closeAll();
  }
});

test('授权失效时给出重新扫码提示，而不是假装成功', async () => {
  const { servers, assistant } = createAssistant(mock.url.replace(APIKEY, 'expired-key'));
  try {
    const result = await assistant.ask('查询我今天的日程');
    assert.equal(result.kind, 'error');
    assert.equal(result.needRescan, true, 'apikey 失效只能靠重新扫码解决');
    assert.match(result.text, /扫码|授权/);
  } finally {
    await servers.closeAll();
  }
});

/**
 * 真机上 LanguageModel 可用时走的是「模型选工具」路径，规则兜底只是降级。
 * 这里用一个假模型验证：模型给的参数被原样采用，写操作仍然必须确认。
 */
test('模型选择的工具参数被采用，写操作仍需确认', async () => {
  const { servers, assistant } = createAssistant(mock.url);
  class FakeSession {
    constructor(tools) {
      this.tools = tools;
      this.listeners = {};
    }
    addEventListener(type, listener) {
      (this.listeners[type] ??= []).push(listener);
    }
    async prompt(text) {
      const tool =
        /发送|发消息/.test(text)
          ? this.tools.find((item) => /message_send/.test(item.function.name))
          : this.tools.find((item) => /sessions_list/.test(item.function.name));
      const event = /发送|发消息/.test(text)
        ? {
            functionName: tool.function.name,
            arguments: { chat_id: 'wr_zhangsan', msg_type: 'text', text: { content: '模型给的内容' } },
          }
        : { functionName: tool.function.name, arguments: null };
      for (const listener of this.listeners.toolcall ?? []) listener(event);
      return '好的';
    }
    destroy() {}
  }
  assistant.languageModel = {
    availability: async () => 'available',
    create: async ({ tools }) => new FakeSession(tools),
  };

  try {
    const before = mock.sent.length;
    const asked = await assistant.ask('给张三发消息');
    assert.equal(asked.kind, 'confirm');
    assert.match(asked.text, /模型给的内容/, '确认页必须展示模型推断出的参数');
    assert.equal(mock.sent.length, before, '等待确认期间不得发送');

    await assistant.confirm();
    assert.deepEqual(mock.sent.at(-1), {
      chat_id: 'wr_zhangsan',
      msg_type: 'text',
      content: '模型给的内容',
    });
  } finally {
    await servers.closeAll();
  }
});

test('待确认时模糊语句不会执行写操作；超时后确认必须作废', async () => {
  // 确认态下用户补充说明（「好的，改成明天」）不能被当成确认，否则会用旧参数误发。
  const current = createAssistant(mock.url);
  try {
    const before = mock.sent.length;
    await current.assistant.ask('给张三发送消息，内容是原计划');
    const vague = await current.assistant.ask('好的，改成明天');
    assert.equal(vague.kind, 'answer');
    assert.match(vague.text, /等待确认/);
    assert.equal(mock.sent.length, before, '模糊语句不得触发发送');

    const done = await current.assistant.confirm();
    assert.equal(done.kind, 'answer');
    assert.equal(mock.sent.length, before + 1, '明确确认后应执行原待确认操作');
    assert.equal(mock.sent.at(-1).content, '原计划');
  } finally {
    await current.servers.closeAll();
  }

  // 确认有 120s 有效期：过期后按「确认」必须提示重说，不能执行陈旧参数。
  let nowMs = Date.parse('2026-11-08T12:00:00+08:00');
  const expired = createAssistant(mock.url, { now: () => new Date(nowMs) });
  try {
    const before = mock.sent.length;
    await expired.assistant.ask('给李四发送消息，内容是过期后不能发');
    nowMs += 121000;
    const result = await expired.assistant.confirm();
    assert.equal(result.kind, 'answer');
    assert.equal(result.expired, true);
    assert.match(result.text, /超时/);
    assert.equal(mock.sent.length, before, '过期确认不得发送');
  } finally {
    await expired.servers.closeAll();
  }
});

test('没有模型时按领域选对写工具；缺参数或缺对应能力时必须安全提示', async () => {
  const { servers, assistant } = createAssistant(mock.url);
  try {
    // 待办：冒号后的内容进入 items[].title，确认后只调用 todo_create
    let asked = await assistant.ask('新建一个待办：买牛奶');
    assert.equal(asked.kind, 'confirm');
    assert.match(asked.text, /待办/);
    assert.match(asked.text, /买牛奶/);
    await assistant.confirm();
    assert.equal(mock.calls.todo_create, 1);
    assert.deepEqual(mock.calledArgs.at(-1), { name: 'todo_create', args: { items: [{ title: '买牛奶' }] } });

    // 文档：选 doc_create，有名称/内容时进入确认而不是改选别的写工具
    asked = await assistant.ask('新建一个文档：项目周报');
    assert.equal(asked.kind, 'confirm');
    assert.match(asked.text, /新建文档/);
    assert.match(asked.text, /项目周报/);
    await assistant.confirm();
    assert.equal(mock.calls.doc_create, 1);
    assert.equal(mock.calledArgs.at(-1).args.doc_name, '项目周报');

    // 会议创建：安排会议 → meeting_create
    asked = await assistant.ask('安排明天下午三点会议');
    assert.equal(asked.kind, 'confirm');
    assert.match(asked.text, /创建会议/);
    await assistant.confirm();
    assert.equal(mock.calls.meeting_create, 1);
    assert.match(mock.calledArgs.at(-1).args.subject, /会议/);

    // 会议取消：缺 meeting_id 时安全提示补充参数，不得改选日程取消/会议创建
    const beforeCancel = structuredClone(mock.calls);
    asked = await assistant.ask('取消明天的会议');
    assert.equal(asked.kind, 'answer', '缺必填参数时应提示补充而不是执行');
    assert.match(asked.text, /取消预定会议/);
    assert.match(asked.text, /补充/);
    assert.deepEqual(mock.calls, beforeCancel, '缺参数提示不得调用任何工具');

    // 官方文档能力位没有删除工具：必须拒绝，不得跨领域选别的删除/写工具
    const beforeDelete = structuredClone(mock.calls);
    asked = await assistant.ask('删除这个文档');
    assert.equal(asked.kind, 'answer');
    assert.match(asked.text, /没有找到/);
    assert.deepEqual(mock.calls, beforeDelete, '没有对应能力时不得调用任何工具');

    // 正文里的英文不能污染中文收件人：chat_id 必须来自「给/对/和/向 + 名字」，
    // 不能拿整句第一个英文 token（hello）当收件人，否则消息会发给不存在的会话。
    asked = await assistant.ask('给张三发送消息，内容是hello');
    assert.equal(asked.kind, 'confirm');
    assert.match(asked.text, /chat_id=张三/);
    await assistant.confirm();
    assert.deepEqual(mock.sent.at(-1), { chat_id: '张三', msg_type: 'text', content: 'hello' });
  } finally {
    await servers.closeAll();
  }
});

test('能力位未授权时提示去后台补授权，不要求重新扫码', async () => {
  // 851008 是能力位/子能力未授权，重新扫码不会改变结果；页面需要据此只引导「可使用权限」。
  const blocked = await startMockWecomMcp({ apikey: APIKEY, unauthorizedTools: ['doc_search'] });
  const servers = new McpServers([{ name: '企业微信文档', url: blocked.url }], { timeoutMs: 8000, callTimeoutMs: 8000 });
  const assistant = new Assistant({ servers, languageModel: null });
  try {
    const result = await assistant.ask('搜索项目文档');
    assert.equal(result.kind, 'error');
    assert.equal(result.code, 'FORBIDDEN');
    assert.equal(result.needRescan, false);
    assert.match(result.text, /补授权|可使用权限/);
    assert.doesNotMatch(result.text, /重新扫码/);
  } finally {
    await servers.closeAll();
    await blocked.close();
  }
});

test('模型选中的工具执行失败时必须上报错误，不得静默改选其他写工具', async () => {
  // 场景：模型选中 doc_search（能力位未授权，851008）。若执行失败后回退规则，
  // 这句话会被规则匹配到写工具 message_send 并弹出确认页 —— 用户可能误确认，
  // 发出模型从未打算发送的消息，属于明确的用户可见高风险。
  const blocked = await startMockWecomMcp({ apikey: APIKEY, unauthorizedTools: ['doc_search'] });
  const servers = new McpServers([{ name: '企业微信', url: blocked.url }], { timeoutMs: 8000, callTimeoutMs: 8000 });
  const assistant = new Assistant({ servers, languageModel: null });
  class FakeSession {
    constructor(tools) {
      this.tools = tools;
      this.listeners = {};
    }
    addEventListener(type, listener) {
      (this.listeners[type] ??= []).push(listener);
    }
    async prompt() {
      const tool = this.tools.find((item) => /doc_search/.test(item.function.name));
      const event = { functionName: tool.function.name, arguments: { keywords: ['项目'] } };
      for (const listener of this.listeners.toolcall ?? []) listener(event);
      return '好的';
    }
    destroy() {}
  }
  assistant.languageModel = {
    availability: async () => 'available',
    create: async ({ tools }) => new FakeSession(tools),
  };

  try {
    const sentBefore = blocked.sent.length;
    const result = await assistant.ask('给张三发送消息，内容是明天开会');
    assert.equal(result.kind, 'error');
    assert.equal(result.code, 'FORBIDDEN');
    assert.equal(result.needRescan, false);
    assert.equal(blocked.sent.length, sentBefore, '不得发送任何消息');
    assert.equal(blocked.calls.message_send ?? 0, 0, '执行失败后不得静默改选写工具');
  } finally {
    await servers.closeAll();
    await blocked.close();
  }
});

test('并发 ask 严格按调用顺序执行，后发的写操作确认不会被先前的慢请求覆盖', async () => {
  // 用户可能连说两句话：若并发执行，先发但较慢的只读请求晚到的回答会把
  // 后发写请求刚创建的确认状态清掉（页面与 pending 错配，确认可能发错内容）。
  const slow = await startMockWecomMcp({ apikey: APIKEY, toolLatencyMs: 300 });
  const servers = new McpServers([{ name: '企业微信消息', url: slow.url }], { timeoutMs: 8000, callTimeoutMs: 8000 });
  const assistant = new Assistant({ servers, languageModel: null });
  try {
    const first = assistant.ask('查询我今天的日程');
    const second = assistant.ask('给张三发送消息，内容是并发消息A');
    const [read, write] = await Promise.all([first, second]);

    assert.equal(read.kind, 'answer');
    assert.match(read.text, /产品评审/);
    assert.equal(write.kind, 'confirm');
    assert.equal(assistant.state, 'confirming', '后发的写请求必须仍处于待确认状态');

    const done = await assistant.confirm();
    assert.equal(done.kind, 'answer');
    assert.deepEqual(slow.sent.at(-1), { chat_id: '张三', msg_type: 'text', content: '并发消息A' });
    assert.equal(assistant.state, 'idle');
  } finally {
    await servers.closeAll();
    await slow.close();
  }
});

test('写操作确认页出现前预先说出的「确认」不得执行；页面未渲染确认页时传 null 绑定也不得执行', async () => {
  // 真实竞态：用户说完写操作后立刻说「确认」，而确认页是在写请求返回后才出现的。
  // 这句「确认」采集时没有任何 pending，绝不能等写请求返回后把新操作发出去。
  const slow = await startMockWecomMcp({ apikey: APIKEY, latencyMs: 120 });
  const { servers, assistant } = createAssistant(slow.url);
  try {
    const wrote = assistant.ask('给张三发送消息，内容是预确认测试');
    const preConfirm = assistant.ask('确认'); // 采集时还没有确认页
    const asked = await wrote;
    assert.equal(asked.kind, 'confirm');
    const staleQueued = await preConfirm;
    assert.equal(staleQueued.kind, 'answer');
    assert.equal(staleQueued.stale, true);
    assert.match(staleQueued.text, /待确认的操作已更新/);
    assert.equal(assistant.state, 'confirming');
    assert.ok(assistant.pending, 'pending 必须保留，等用户重新确认');
    assert.equal(slow.sent.length, 0, '预先说出的确认不得执行写操作');

    // 页面在 pending 已创建但确认页尚未真正渲染时，会显式传 null 绑定：
    // 这同样不能执行，不能退化成「运行时再采集一次绑定」。
    const staleNull = await assistant.ask('确认', { confirmBinding: null });
    assert.equal(staleNull.stale, true);
    assert.equal(slow.sent.length, 0, '确认页未渲染时的确认不得执行');
    assert.ok(assistant.pending);

    const done = await assistant.confirm();
    assert.equal(done.kind, 'answer');
    assert.equal(slow.sent.length, 1, '确认页展示后再次确认才执行，且只执行一次');
    assert.deepEqual(slow.sent.at(-1), { chat_id: '张三', msg_type: 'text', content: '预确认测试' });
  } finally {
    await servers.closeAll();
    await slow.close();
  }
});

test('确认页被新操作替换后，旧确认/取消绑定必须作废，不能执行或取消新 pending', async () => {
  const { servers, assistant } = createAssistant(mock.url);
  try {
    const before = mock.sent.length;
    const askedFirst = await assistant.ask('给张三发送消息，内容是第一条');
    assert.equal(askedFirst.kind, 'confirm');
    const oldBinding = assistant.captureConfirmBinding(); // 页面展示第一条时的绑定

    assistant.cancel(); // 用户返回取消，重新发起另一个操作
    const askedSecond = await assistant.ask('给李四发送消息，内容是第二条');
    assert.equal(askedSecond.kind, 'confirm');

    const staleAsk = await assistant.ask('确认', { confirmBinding: oldBinding });
    assert.equal(staleAsk.stale, true);
    assert.equal(mock.sent.length, before, '旧确认不得执行新 pending');
    const staleConfirm = await assistant.confirm(oldBinding);
    assert.equal(staleConfirm.stale, true);
    assert.equal(mock.sent.length, before);
    assert.ok(assistant.pending, '新 pending 必须保留');
    const staleCancel = assistant.cancel(oldBinding);
    assert.equal(staleCancel.stale, true);
    assert.ok(assistant.pending, '旧取消不得取消新 pending');

    const done = await assistant.confirm();
    assert.equal(done.kind, 'answer');
    assert.deepEqual(mock.sent.slice(before), [{ chat_id: '李四', msg_type: 'text', content: '第二条' }]);
  } finally {
    await servers.closeAll();
  }
});

test('官方 JSON Schema 的 $ref 对象/数组字段必须正确推断（消息/待办）', async () => {
  // 官方 tools/list 的对象/数组字段常只有 $ref（没有内联 type），推断错会把
  // text 发成字符串、items 发成空数组，用户确认页看到的和真正发出去的会不一致。
  const { servers, assistant } = createAssistant(mock.url);
  try {
    const sentBefore = mock.sent.length;
    const askedTodo = await assistant.ask('新建待办：买牛奶');
    assert.equal(askedTodo.kind, 'confirm');
    assert.match(askedTodo.text, /买牛奶/, '确认页必须展示推断出的待办内容');
    const todoDone = await assistant.confirm();
    assert.equal(todoDone.kind, 'answer');
    const todoArgs = mock.calledArgs.filter((call) => call.name === 'todo_create').at(-1)?.args;
    assert.deepEqual(todoArgs, { items: [{ title: '买牛奶' }] }, '$ref 数组元素必须推断成对象');

    const askedMsg = await assistant.ask('给张三发送消息，内容是hello ref');
    assert.equal(askedMsg.kind, 'confirm');
    assert.match(askedMsg.text, /hello ref/);
    const msgDone = await assistant.confirm();
    assert.equal(msgDone.kind, 'answer');
    assert.equal(mock.sent.length, sentBefore + 1);
    assert.deepEqual(
      mock.sent.at(-1),
      { chat_id: '张三', msg_type: 'text', content: 'hello ref' },
      '$ref 对象字段必须推断成 {content}',
    );
  } finally {
    await servers.closeAll();
  }
});

test('确认后服务端同名工具的读写属性或参数声明变化必须 fail-closed，不得按旧确认执行', async () => {
  // 真实场景：用户确认期间，服务端（企业微信后台权限/版本变化）重新下发了同名工具，
  // 但读写语义或参数 schema 已变。绝不能拿旧确认去执行新语义的工具（可能绕过确认/发错内容）。
  const mutable = await startMockWecomMcp({ apikey: APIKEY });
  const { servers, assistant } = createAssistant(mutable.url);
  try {
    const askedReadonly = await assistant.ask('给张三发送消息，内容是身份变化测试');
    assert.equal(askedReadonly.kind, 'confirm');
    mutable.setToolVariant('readonly'); // 同名工具变成只读
    await servers.refreshAllTools();
    const readonlyChanged = await assistant.confirm();
    assert.equal(readonlyChanged.kind, 'error', '读写语义变化必须报错而不是执行');
    assert.equal(readonlyChanged.failClosed, true);
    assert.match(readonlyChanged.text, /已变化|重新发起/);
    assert.equal(mutable.sent.length, 0, '不得按旧确认发送');
    assert.equal(mutable.calls.message_send ?? 0, 0, '工具执行次数必须为 0');
    assert.equal(assistant.pending, null, '失效的 pending 必须清空');

    mutable.setToolVariant('official');
    await servers.refreshAllTools();
    const askedSchema = await assistant.ask('给李四发送消息，内容是第二次');
    assert.equal(askedSchema.kind, 'confirm');
    mutable.setToolVariant('schema'); // 读写语义不变，仅 inputSchema 变化
    await servers.refreshAllTools();
    const schemaChanged = await assistant.confirm();
    assert.equal(schemaChanged.kind, 'error', '参数声明变化同样必须 fail-closed');
    assert.equal(schemaChanged.failClosed, true);
    assert.equal(mutable.sent.length, 0);
    assert.equal(mutable.calls.message_send ?? 0, 0);
    assert.equal(assistant.pending, null);
  } finally {
    await servers.closeAll();
    await mutable.close();
  }
});

test('模型 prompt 期间工具名映射变化必须 fail-closed，不得执行非模型选择的同名工具', async () => {
  // 真实场景：模型拿到工具清单后、返回 toolcall 前，服务端刷新了工具清单并把同名
  // namespacedName 映射到另一个原始工具。绝不能把模型选中的 A 执行成 B。
  const mutable = await startMockWecomMcp({ apikey: APIKEY });
  const servers = new McpServers([{ name: '企业微信消息', url: mutable.url }], {
    timeoutMs: 8000,
    callTimeoutMs: 8000,
  });
  const assistant = new Assistant({ servers, languageModel: null });
  try {
    let chosenFunctionName = '';
    class FakeSession {
      constructor(tools) {
        this.tools = tools;
        this.listeners = {};
      }
      addEventListener(type, listener) {
        (this.listeners[type] ??= []).push(listener);
      }
      async prompt() {
        // 模型还在生成回复时，服务端把 message_aibot_sessions_list 换成
        // message.aibot.sessions_list（sanitize 后 namespacedName 相同）
        mutable.setToolVariant('rename-session-list');
        await servers.refreshAllTools();
        const event = { functionName: chosenFunctionName, arguments: {} };
        for (const listener of this.listeners.toolcall ?? []) listener(event);
        return '';
      }
      destroy() {}
    }
    assistant.languageModel = {
      availability: async () => 'available',
      create: async ({ tools }) => {
        const chosen = tools.find((tool) => tool.function.name.endsWith('message_aibot_sessions_list'));
        chosenFunctionName = chosen.function.name;
        return new FakeSession(tools);
      },
    };

    const result = await assistant.ask('看看最近的会话列表');
    assert.equal(result.kind, 'error', '工具映射变化必须报错而不是执行');
    assert.equal(result.failClosed, true);
    assert.match(result.text, /已变化|重新发起/);
    assert.equal(mutable.calls['message.aibot.sessions_list'], undefined, '不得执行被替换后的工具');
    assert.equal(mutable.calls.message_aibot_sessions_list, undefined, '也不得执行旧同名工具');
  } finally {
    await servers.closeAll();
    await mutable.close();
  }
});

test('「下载微盘里的文件」必须提示补文件 ID/URL，不得用列表工具代替下载', async () => {
  // 真实场景：官方 disk 工具里 disk_files_download_submit 的 file_id/url 是二选一可选字段，
  // 兜底匹配若退化成 disk_files_list，用户会拿到一份列表却以为在下载；缺定位信息时
  // 正确行为是明确要求补充，而不是执行列表/带空参数提交下载任务。
  const diskMock = await startMockWecomMcp({ apikey: APIKEY, diskTools: true });
  const { servers, assistant } = createAssistant(diskMock.url);
  try {
    const result = await assistant.ask('下载微盘里的文件');
    assert.equal(result.kind, 'answer');
    assert.match(result.text, /文件 ID|文件ID|URL/);
    assert.equal(diskMock.calls.disk_files_list, undefined, '不得用列表工具代替下载');
    assert.equal(diskMock.calls.disk_files_download_submit, undefined, '缺参数时不得执行下载任务');
    assert.equal(assistant.pending, null, '缺参数时不应进入确认页');
  } finally {
    await servers.closeAll();
    await diskMock.close();
  }
});
