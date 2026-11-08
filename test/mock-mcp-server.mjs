// 本地模拟「企业微信官方远程 MCP」，用于端到端验证 AIUI 端 MCP 客户端。
//
// 行为按真实探测结果复刻（取证记录只保留在本地，未随仓库提供）：
//   - URL 形态 /mcp/v2/bot/<cap>?apikey=...
//   - 缺 apikey → HTTP 401 {"error":"Missing apikey, pass via ?apikey=xxx"}
//   - apikey 错误 → initialize / tools/list 正常（能拿到 schema），
//     只有 tools/call 返回业务错误 {"errcode":850001} 且 isError=false
//   - 未授权能力 → tools/call 返回 {"errcode":851008}
//   - 无 Mcp-Session-Id（服务端无状态），SSE 关闭（GET → 405）
//
// 工具名与 inputSchema 取自本地实测的官方 tools/list 响应（取证数据未随仓库提供），
// 保证「名称/参数形态」与真机一致；包括官方真实存在的 message_aibot_send（写入类，参数枚举
// 与 message_send 不同），用于验证「一句话选对工具」以及写操作超时不得重放。
// 另按官方 schema 注册少量写工具（todo_create / doc_create / meeting_cancel / meeting_create），
// 用于验证无模型兜底时按领域选对工具；官方 doc 能力位没有删除工具，因此没有 doc_delete。
//
// 可选行为：
//   - latencyMs：所有 HTTP 请求延迟（用于连接/调用超时）；
//   - toolLatencyMs：仅工具 handler 内、**副作用执行之后**延迟返回（用于「超时不重放」测试：
//     客户端超时时服务端其实已经执行成功，写操作一旦重试就会重复发消息）；
//   - unauthorizedTools：指定工具返回 851008（能力位未授权）。
//
// 用法：
//   node test/mock-mcp-server.mjs --port 8765 --apikey dev-key
//
// 作为模块：
//   const server = await startMockWecomMcp({ apikey: 'dev-key' });
//   server.url; server.close();

import http from 'node:http';
import { McpServer, WebStandardStreamableHTTPServerTransport, fromJsonSchema } from '@modelcontextprotocol/server';
import { z } from 'zod';

const DEFAULT_APIKEY = 'dev-key';

/** 企业微信业务错误的统一返回壳（与真机一致：content 文本内是 JSON，isError=false）。 */
function wecomResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function ok(payload) {
  return wecomResult({ errcode: 0, errmsg: 'ok', ...payload });
}

function businessError(errcode, errmsg) {
  return wecomResult({ errcode, errmsg });
}

/**
 * 注册与真实企业微信能力位一致的工具（名字/参数来自官方 tools/list）。
 * @param {McpServer} server
 * @param {{sent: Array<object>, calls: Record<string, number>, calledArgs: Array<{name: string, args: object}>, invalidKey: () => boolean, unauthorizedTools: Set<string>, toolLatencyMs: number}} state
 */
function registerWecomMockTools(server, state) {
  /** @param {string} name */
  const blocked = (name) => state.unauthorizedTools.has(name);

  /** 记录每个工具的真实执行次数与入参（用于验证「写不重放、读可重试」和选中的工具/参数）。 */
  const register = (name, meta, handler) => {
    server.registerTool(name, meta, async (args, extra) => {
      state.calls[name] = (state.calls[name] ?? 0) + 1;
      state.calledArgs.push({ name, args });
      return handler(args, extra);
    });
  };

  /** 副作用执行之后的响应延迟：模拟「服务端其实已经执行成功，只是响应慢」。 */
  const waitToolLatency = () =>
    state.toolLatencyMs > 0 ? new Promise((resolve) => setTimeout(resolve, state.toolLatencyMs)) : Promise.resolve();

  // 变体用于模拟服务端在同一会话期间替换同名工具/改变读写属性（权限或版本变化）。
  const sessionsListName =
    state.toolVariant === 'rename-session-list' ? 'message.aibot.sessions_list' : 'message_aibot_sessions_list';
  const sessionsListMeta = {
    description: '获取智能机器人最近的会话列表，按最后一条消息时间倒序返回最多 20 个会话',
    inputSchema: {},
  };
  if (state.toolVariant === 'sessions-read-as-write') sessionsListMeta.annotations = { readOnlyHint: false };
  register(
    sessionsListName,
    sessionsListMeta,
    async () => {
      if (state.invalidKey()) return businessError(850001, 'invalid apikey');
      if (blocked('message_aibot_sessions_list')) {
        // 慢响应后再拒绝：用于构造「探针挑选后、下一探针调用前 tools 被刷新」的真实竞态。
        await waitToolLatency();
        return businessError(851008, 'capability not authorized');
      }
      await waitToolLatency();
      return ok({
        sessions: [
          { chat_id: 'wr_zhangsan', name: '张三', last_message: '明天开会' },
          { chat_id: 'wr_lisi', name: '李四', last_message: '文档已更新' },
        ],
      });
    },
  );

  register(
    'message_aibot_send',
    {
      description: '以智能机器人身份向指定单聊/群聊会话发送消息，支持 markdown/图片/文件/语音/视频',
      inputSchema: {
        chat_id: z.string().min(1),
        msg_type: z.enum(['markdown', 'image', 'file', 'voice', 'video']),
        markdown: z.object({ content: z.string() }).optional(),
        image: z.object({ media_id: z.string() }).optional(),
        file: z.object({ media_id: z.string() }).optional(),
        voice: z.object({ media_id: z.string() }).optional(),
        video: z.object({ media_id: z.string() }).optional(),
      },
    },
    async ({ chat_id, msg_type }) => {
      if (state.invalidKey()) return businessError(850001, 'invalid apikey');
      if (blocked('message_aibot_send')) return businessError(851008, 'capability not authorized');
      // 写入类：以独立标记记入 sent，测试里若误选了它，message_send 的断言会自然失败
      state.sent.push({ chat_id, msg_type, aibot: true });
      await waitToolLatency();
      return ok({ chat_id });
    },
  );

  // 与官方 tools/list 一致：对象字段用 `$ref` 指向 $defs（没有内联 type）。
  // 这是真实 schema 形态，客户端必须解析引用后才能推断出 text={content:'...'}。
  // toolVariant 模拟「同一服务端两次 tools/list 之间工具声明变化」（权限/版本变化），
  // 验证用户确认后按最新声明执行并 fail-closed。
  const messageSchema = {
    type: 'object',
    required: ['chat_id', 'msg_type'],
    properties: {
      chat_id: { type: 'string', description: '会话 ID：单聊传接收成员的 userid，群聊传群会话 ID' },
      msg_type: { type: 'string', enum: ['text'], description: '消息类型，目前仅支持 text' },
      text: { type: 'object', $ref: '#/$defs/TextContent', description: '文本消息内容，msg_type=text 时必填' },
    },
    $defs: {
      TextContent: {
        type: 'object',
        required: ['content'],
        properties: { content: { type: 'string', description: '文本内容（长度限制由服务端业务错误模拟）' } },
      },
    },
  };
  if (state.toolVariant === 'schema') messageSchema.required = ['chat_id', 'msg_type', 'text'];
  const messageMeta = {
    description: '向指定单聊/群聊会话发送文本消息',
    inputSchema: fromJsonSchema(messageSchema),
  };
  if (state.toolVariant === 'readonly') messageMeta.annotations = { readOnlyHint: true };
  register(
    'message_send',
    messageMeta,
    async ({ chat_id, msg_type, text }) => {
      if (state.invalidKey()) return businessError(850001, 'invalid apikey');
      if (blocked('message_send')) return businessError(851008, 'capability not authorized');
      // 真实业务限制：正文超过 2048 字符时服务端返回 40058（HTTP 成功、content 里是业务错误）
      if ((text?.content ?? '').length > 2048) {
        return businessError(40058, 'text content exceeds 2048 characters');
      }
      state.sent.push({ chat_id, msg_type, content: text?.content ?? '' });
      await waitToolLatency();
      return ok({ chat_id });
    },
  );

  register(
    'chat_groups_list',
    {
      description: '按时间范围分页获取有消息的会话列表（目前仅群聊）',
      inputSchema: { begin_time: z.string(), end_time: z.string() },
    },
    async ({ begin_time, end_time }) => {
      if (state.invalidKey()) return businessError(850001, 'invalid apikey');
      if (blocked('chat_groups_list')) return businessError(851008, 'capability not authorized');
      await waitToolLatency();
      return ok({ begin_time, end_time, chat_groups: [{ chat_id: 'wr_group_1', name: '项目群' }] });
    },
  );

  const calendarSchedulesListMeta = {
    description: '查询指定时间范围内的日程列表，返回日程的基本信息：标题、开始时间、结束时间、参与人、会议室、地点、备注',
    inputSchema: { begin_time: z.string().optional(), end_time: z.string().optional() },
  };
  if (state.toolVariant === 'calendar-list-read-as-write') {
    calendarSchedulesListMeta.annotations = { readOnlyHint: false };
  }
  register('calendar_schedules_list', calendarSchedulesListMeta,
    async () => {
      if (state.invalidKey()) return businessError(850001, 'invalid apikey');
      if (blocked('calendar_schedules_list')) return businessError(851008, 'capability not authorized');
      await waitToolLatency();
      return ok({
        schedules: [
          { schedule_id: 'sc_1', summary: '产品评审', start_time: '2026-11-01 10:00:00', end_time: '2026-11-01 11:00:00' },
          { schedule_id: 'sc_2', summary: '客户沟通', start_time: '2026-11-01 15:30:00', end_time: '2026-11-01 16:00:00' },
        ],
      });
    },
  );

  register(
    'calendar_schedules_cancel',
    {
      description: '取消（删除）日程，周期日程需指定编辑规则（仅本次、本次及以后、全部）',
      inputSchema: { schedule_id: z.string().min(1) },
    },
    async ({ schedule_id }) => {
      if (state.invalidKey()) return businessError(850001, 'invalid apikey');
      if (blocked('calendar_schedules_cancel')) return businessError(851008, 'capability not authorized');
      state.sent.push({ cancelled: schedule_id });
      await waitToolLatency();
      return ok({ schedule_id });
    },
  );

  register(
    'todo_list',
    {
      description: '读取机器人为创建人、对话人为参与人选的待办列表（按 update_time 降序），返回标题/描述/人名',
      inputSchema: { limit: z.number().int().min(1).max(20).optional() },
    },
    async () => {
      if (state.invalidKey()) return businessError(850001, 'invalid apikey');
      if (blocked('todo_list')) return businessError(851008, 'capability not authorized');
      await waitToolLatency();
      return ok({
        todos: [
          { todo_id: 'td_1', title: '提交季度报告', status: 'proceed' },
          { todo_id: 'td_2', title: '确认发布计划', status: 'proceed' },
        ],
      });
    },
  );

  register(
    'doc_search',
    {
      description: '按关键词搜索文档，支持按文档类型、创建者、浏览者、时间范围等多维度过滤，支持排序和分页',
      inputSchema: { keywords: z.array(z.string()).min(1).max(20) },
    },
    async ({ keywords }) => {
      if (state.invalidKey()) return businessError(850001, 'invalid apikey');
      if (blocked('doc_search')) return businessError(851008, 'capability not authorized');
      await waitToolLatency();
      return ok({ docs: keywords.map((keyword, index) => ({ docid: `doc_${index + 1}`, title: `${keyword} 项目方案` })) });
    },
  );

  // 可选：注册官方「微盘」真实工具（用于验证「下载微盘里的文件」这类意图选择）。
  // schema 取自官方 tools/list 实测（file_id/url 二选一，required 为空）。
  if (state.diskTools) {
    register(
      'disk_files_list',
      {
        description: '获取微盘文件列表，支持游标分页',
        inputSchema: fromJsonSchema({
          type: 'object',
          properties: {
            cursor: { type: 'string', description: '分页游标；不传或传空串则获取首页数据' },
            limit: { type: 'integer', description: '每页返回的最大条数' },
          },
        }),
      },
      async ({ cursor, limit }) => {
        if (state.invalidKey()) return businessError(850001, 'invalid apikey');
        await waitToolLatency();
        return ok({ cursor, limit, files: [{ file_id: 'file_1', name: '周报.docx' }] });
      },
    );
    register(
      'disk_files_download_submit',
      {
        description: '提交微盘文件下载任务，file_id 与 url 二选一',
        inputSchema: fromJsonSchema({
          type: 'object',
          properties: {
            file_id: { type: 'string', description: '要下载的文件 ID，与 url 二选一；不传则必须传 url' },
            url: { type: 'string', description: '文件 URL，与 file_id 二选一；不传则必须传 file_id' },
          },
        }),
      },
      async ({ file_id, url }) => {
        if (state.invalidKey()) return businessError(850001, 'invalid apikey');
        await waitToolLatency();
        return ok({ taskid: `task_${file_id ?? (url ? 'url' : 'none')}` });
      },
    );
  }

  register(
    'contact_users_search',
    {
      description: '通过 keywords 搜索成员信息（open cli场景）',
      inputSchema: { keywords: z.array(z.string()).min(1).max(10).optional() },
    },
    async () => {
      if (state.invalidKey()) return businessError(850001, 'invalid apikey');
      if (blocked('contact_users_search')) return businessError(851008, 'capability not authorized');
      await waitToolLatency();
      return ok({ users: [{ userid: 'zhangsan', name: '张三' }] });
    },
  );

  // 以下四个官方写工具的 schema 从本地实测 tools/list 响应精简而来（保留领域关键词、
  // 必填参数与枚举），用于兜底选工具；不引入任何测试专用参数。
  register(
    'todo_create',
    {
      description: '机器人视角批量创建待办',
      // 官方 schema 的数组元素同样是 `$ref`（items:[{$ref:TodoCreateItem}]）。
      inputSchema: fromJsonSchema({
        type: 'object',
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            description: '批量创建待办列表，最多20条',
            items: { type: 'object', $ref: '#/$defs/TodoCreateItem' },
          },
        },
        $defs: {
          TodoCreateItem: {
            type: 'object',
            required: ['title'],
            properties: {
              title: { type: 'string', minLength: 1, maxLength: 4000, description: '待办标题' },
              description: { type: 'string', maxLength: 4000, description: '待办描述' },
            },
          },
        },
      }),
    },
    async ({ items }) => {
      if (state.invalidKey()) return businessError(850001, 'invalid apikey');
      if (blocked('todo_create')) return businessError(851008, 'capability not authorized');
      await waitToolLatency();
      return ok({ items: items.map((item, index) => ({ todo_id: `td_new_${index + 1}`, title: item.title })) });
    },
  );

  register(
    'doc_create',
    {
      description: '新建文档，支持 doc/sheet/smartsheet/ppt 文档类型，可设置初始内容和字段',
      inputSchema: {
        doc_name: z.string().min(1).max(255),
        content: z.string(),
        doc_type: z.enum(['doc', 'sheet', 'smartsheet', 'smartpage', 'ppt', 'mind', 'flowchart']).optional(),
      },
    },
    async ({ doc_name }) => {
      if (state.invalidKey()) return businessError(850001, 'invalid apikey');
      if (blocked('doc_create')) return businessError(851008, 'capability not authorized');
      await waitToolLatency();
      return ok({ docid: 'doc_new_1', doc_name });
    },
  );

  register(
    'meeting_cancel',
    {
      description: '取消预定会议：周期会议取消单次需指定子会议 ID',
      inputSchema: { meeting_id: z.string().min(1), sub_meeting_id: z.string().optional() },
    },
    async ({ meeting_id }) => {
      if (state.invalidKey()) return businessError(850001, 'invalid apikey');
      if (blocked('meeting_cancel')) return businessError(851008, 'capability not authorized');
      await waitToolLatency();
      return ok({ meeting_id });
    },
  );

  register(
    'meeting_create',
    {
      description: '创建会议，支持设置主题、开始/结束时间、参与人、会议室、重复规则',
      inputSchema: {
        subject: z.string().min(1),
        begin_time: z.string(),
        end_time: z.string(),
        location: z.string().optional(),
        description: z.string().optional(),
        timezone: z.string().optional(),
      },
    },
    async ({ subject, begin_time, end_time }) => {
      if (state.invalidKey()) return businessError(850001, 'invalid apikey');
      if (blocked('meeting_create')) return businessError(851008, 'capability not authorized');
      await waitToolLatency();
      return ok({ meeting_id: 'mt_new_1', subject, begin_time, end_time });
    },
  );
}

/**
 * 启动模拟 MCP Server。
 * @param {{apikey?: string, port?: number, sse?: boolean, latencyMs?: number, toolLatencyMs?: number, unauthorizedTools?: string[]}} [options]
 * @returns {Promise<{url: string, port: number, sent: Array<object>, requests: Array<{method: string, path: string, hasApikey: boolean}>, calls: Record<string, number>, calledArgs: Array<{name: string, args: object}>, close: () => Promise<void>}>}
 */
export async function startMockWecomMcp(options = {}) {
  const apikey = options.apikey ?? DEFAULT_APIKEY;
  const state = {
    sent: [],
    requests: [],
    calls: {},
    calledArgs: [],
    unauthorizedTools: new Set(options.unauthorizedTools ?? []),
    toolLatencyMs: options.toolLatencyMs ?? 0,
    invalidKey: () => false,
    toolVariant: options.toolVariant ?? 'official',
    dropToolCalls: options.dropToolCalls ?? 0,
    diskTools: options.diskTools === true,
    switchVariantAfterDrop: options.switchVariantAfterDrop ?? null,
  };

  // 真实企业微信远程 MCP 是无状态的（不发 Mcp-Session-Id），
  // 因此每个请求用一个独立的 stateless transport，与官方行为一致。
  const createTransport = async () => {
    const server = new McpServer({ name: 'wecom-mock', version: '1.0.5' }, { capabilities: { tools: {} } });
    registerWecomMockTools(server, state);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: options.sse !== true,
      keepAliveMs: 0,
    });
    await server.connect(transport);
    return transport;
  };

  const httpServer = http.createServer(async (req, res) => {
    // 客户端超时后会断开连接，而服务端工具 handler 可能仍在执行（toolLatencyMs）：
    // 响应写回已关闭的 socket 会产生 EPIPE，这里吞掉，避免测试进程因未捕获错误退出。
    res.on('error', () => {});
    const url = new URL(req.url, 'http://127.0.0.1');
    state.requests.push({ method: req.method, path: url.pathname, hasApikey: !!url.searchParams.get('apikey') });

    // 供浏览器/预览环境跨源联调使用；Node 客户端不受影响
    const corsHeaders = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, accept, mcp-session-id, mcp-protocol-version, authorization',
      'access-control-allow-methods': 'POST, GET, OPTIONS, DELETE',
      'access-control-expose-headers': 'mcp-session-id, mcp-protocol-version',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    // 真实行为：缺 apikey → 401；apikey 错误不在这里拦（交给 tools/call 的业务错误）
    if (!url.searchParams.get('apikey')) {
      res.writeHead(401, { 'content-type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ error: 'Missing apikey, pass via ?apikey=xxx' }));
      return;
    }
    if (options.sse !== true && req.method === 'GET') {
      res.writeHead(405, { 'content-type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ error: 'Method Not Allowed', message: 'SSE is disabled. Please use POST' }));
      return;
    }

    state.invalidKey = () => url.searchParams.get('apikey') !== apikey;

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    // 模拟传输层瞬时失败：直接断开该次 tools/call 的 socket（客户端看到网络错误、可重试）。
    if (state.dropToolCalls > 0) {
      let rpc;
      try {
        rpc = JSON.parse(body.toString('utf8'));
      } catch {
        rpc = null;
      }
      if (rpc?.method === 'tools/call') {
        state.dropToolCalls -= 1;
        if (state.switchVariantAfterDrop) state.toolVariant = state.switchVariantAfterDrop;
        res.destroy();
        return;
      }
    }

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(key, value);
    }

    const request = new Request(url, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });

    try {
      if (options.latencyMs) await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
      const transport = await createTransport();
      const response = await transport.handleRequest(request);
      if (res.destroyed) {
        await transport.close?.();
        return;
      }
      res.writeHead(response.status, {
        ...Object.fromEntries(response.headers.entries()),
        ...corsHeaders,
      });
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
      await transport.close?.();
    } catch (error) {
      if (!res.destroyed) {
        res.writeHead(500, { 'content-type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ error: String(error?.message || error) }));
      }
    }
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const port = httpServer.address().port;

  return {
    url: `http://127.0.0.1:${port}/mcp/v2/bot/msg?apikey=${encodeURIComponent(apikey)}`,
    port,
    apikey,
    sent: state.sent,
    requests: state.requests,
    calls: state.calls,
    calledArgs: state.calledArgs,
    /** 切换后续 tools/list 返回的工具声明（official / readonly / schema）。 */
    setToolVariant: (variant) => {
      state.toolVariant = variant;
    },
    async close() {
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

// 直接运行时作为独立 mock 服务
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const get = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const port = Number(get('port', '8765'));
  const apikey = get('apikey', DEFAULT_APIKEY);
  const mock = await startMockWecomMcp({ port, apikey, sse: args.includes('--sse') });
  console.log(`mock wecom mcp listening: ${mock.url}`);
  console.log('tools: message_aibot_sessions_list, message_aibot_send, message_send, chat_groups_list,');
  console.log('       calendar_schedules_list, calendar_schedules_cancel, todo_list, doc_search, contact_users_search,');
  console.log('       todo_create, doc_create, meeting_cancel, meeting_create');
}
