<script type="application/json" def>
{
  "navigationBarTitleText": "企业微信助手",
  "description": "通过企业微信官方远程 MCP 用语音查询和操作消息、日程、待办、文档等企业微信能力。",
  "disableScroll": true
}
</script>

<script setup>
import wx from 'wx';
import {
  getAssistant,
  getVoice,
  getConfigInfo,
  getServers,
  describeServers,
  describeConfig,
  connectAndVerify,
  saveConfigFromScan,
  deleteConfig,
  disposeSession,
  takeScanResult,
} from '../../libs/session.js';
import { formatError } from '../../libs/format.js';

const MENU_ITEMS = [
  { id: 'ask', label: '语音提问' },
  { id: 'tools', label: '查看可用工具' },
  { id: 'rescan', label: '重新扫码授权' },
  { id: 'delete', label: '删除已保存配置' },
  { id: 'exit', label: '退出助手' },
];

const KEY_HANDLED = ['Enter', 'Backspace', 'ArrowUp', 'ArrowDown'];

export default {
  data: {
    view: 'boot',
    statusText: '正在启动…',
    hint: '',
    transcript: '',
    answer: '',
    errorText: '',
    /** 错误页确认键的动作：scan（重新扫码）/ connect（重连）/ forbidden（后台补授权）/ ready（回到提问） */
    errorAction: 'ready',
    warning: '',
    menuItems: MENU_ITEMS,
    menuIndex: 0,
    pendingTitle: '',
    pendingDetail: '',
    servers: [],
    scrollTop: 0,
    modeNote: '',
  },

  async onLoad() {
    // 记录「屏幕实际已展示」的 pending；只有它与 assistant.pending 同一对象时，语音/按键确认才有效
    this._displayedPending = null;
    // 生命周期可见性：onHide/onUnload 后所有在途异步结果必须作废（不得 setData、不得播报）
    this._visible = true;
    this._generation = 0;
    this._wasHidden = false;
    const generation = this._generation;
    try {
      await this.refreshSessionRefs();
      if (!this._isAsyncCurrent(generation)) return;
      const info = getConfigInfo();
      if (!info) {
        this.showNoConfig();
        return;
      }
      this.applyConfigInfo();
      await this.connectAndVerify();
    } catch (error) {
      if (!this._isAsyncCurrent(generation)) return;
      this.showError(error, '启动失败');
    }
  },

  async onShow() {
    this._visible = true;
    const generation = this._generation;
    const wasHidden = this._wasHidden;
    this._wasHidden = false;
    const scanned = takeScanResult();
    if (scanned) {
      await this.handleScanResult(scanned);
      return;
    }
    // 从扫码页/工具页返回时刷新会话引用：保存新配置会重建 Assistant 与 McpServers，
    // 继续用旧的 this.assistant 会导致之后所有提问都回「没有可用的企业微信 MCP」。
    const previousServers = this.serversRef;
    try {
      await this.refreshSessionRefs();
    } catch (error) {
      if (!this._isAsyncCurrent(generation)) return;
      this.showError(error, '启动失败');
      return;
    }
    if (!this._isAsyncCurrent(generation)) return;
    if (wasHidden) {
      // 离开期间完成的写请求可能生成了没人看过的 pending：回到前台先作废，避免再次「确认」到旧操作
      if (this.assistant?.pending && this.data.view !== 'confirm') {
        try {
          this.assistant.cancel();
        } catch {
          // 清理失败不阻塞恢复
        }
      }
      if (this.data.view === 'thinking' || this.data.view === 'listening') {
        // onHide 已 abort 录音/作废在途请求；返回时若还停在 listening/thinking，
        // 页面会假装仍在录音或处理，必须恢复到可再次唤醒的 ready。
        this._displayedPending = null;
        this.setData({
          view: 'ready',
          statusText: '已就绪',
          transcript: '',
          hint: this.hintFor('ready'),
        });
      }
      if (this.data.view === 'boot' || this.data.view === 'connecting') {
        await this.connectAndVerify({ announce: false });
        return;
      }
    }
    if (this.data.view === 'boot') return;
    if (previousServers !== this.serversRef) {
      // MCP 实例被重建（新扫码 / 删除配置）：按最新配置重新连接
      const info = getConfigInfo();
      if (!info) {
        this.showNoConfig();
        return;
      }
      this.applyConfigInfo();
      await this.connectAndVerify({ announce: false });
    }
  },

  async handleScanResult(scanned) {
    const generation = this._generation;
    if (!this._isAsyncCurrent(generation)) return;
    this.setView('connecting', '正在保存配置…');
    try {
      const saved = await saveConfigFromScan(scanned);
      if (!this._isAsyncCurrent(generation)) return;
      this.setData({
        modeNote: saved.mode === 'session' ? '仅本次会话保存：退出应用后需重新扫码授权' : '',
      });
      // saveConfigFromScan 会重建 servers/assistant，必须刷新本页持有的引用
      await this.refreshSessionRefs();
      if (!this._isAsyncCurrent(generation)) return;
      this.applyConfigInfo();
      await this.connectAndVerify({ announce: true });
    } catch (error) {
      if (!this._isAsyncCurrent(generation)) return;
      this.showError(error, '保存配置失败');
    }
  },

  onHide() {
    // 立刻作废所有在途异步结果：即使 MCP 稍后返回，也不得再改 UI、不得后台播报敏感回答
    this._visible = false;
    this._wasHidden = true;
    this._generation += 1;
    this.voice?.abort?.();
    this.voice?.stopSpeaking?.();
  },

  onUnload() {
    this._visible = false;
    this._generation += 1;
    this.unsubscribeServers?.();
    this.unsubscribeServers = null;
    this._uiActionChain = null;
    this.voice?.abort?.();
    this.voice?.stopSpeaking?.();
  },

  /** 重新取一次会话单例里的 Assistant / VoiceController / McpServers 引用，并订阅连接状态。 */
  async refreshSessionRefs() {
    this.assistant = await getAssistant();
    this.voice = await getVoice();
    const nextServers = getServers();
    if (nextServers !== this.serversRef) {
      this.unsubscribeServers?.();
      this.serversRef = nextServers;
      this.unsubscribeServers = nextServers?.onStateChange?.((event) => this.onServersStateChange(event));
    }
  },

  onServersStateChange(event) {
    // 页面不可见时后台事件不得改写屏幕状态（返回时会有 onShow 重新同步），避免旧事件覆盖新会话
    if (!this._visible) return;
    const type = event?.type;
    const name = event?.server?.name ?? '企业微信 MCP';
    if (type === 'ready') {
      const patch = { warning: '' };
      if (this.data.view === 'ready') {
        const ready = this.serversRef?.readyCount ?? 0;
        const tools = this.serversRef?.tools.length ?? 0;
        patch.statusText = `已连接 ${ready} 个 MCP · ${tools} 个工具`;
      }
      this.setData(patch);
      return;
    }
    if (type === 'error' || type === 'disconnected' || type === 'transport-error') {
      // 851008 能力位未授权即便发生在连接事件里，也引导后台补授权而不是重新扫码
      const code = event?.server?.lastError?.code;
      const warning = code === 'FORBIDDEN'
        ? `${name}：该能力尚未授权，请在智能机器人「可使用权限」中补授权`
        : `${name} 连接已断开，将自动重连；仍失败请重新扫码授权`;
      if (warning !== this.data.warning) this.setData({ warning });
    }
  },

  // ---------------------------------------------------------------- 按键

  onKeyDown(event) {
    const code = event?.code;
    if (!KEY_HANDLED.includes(code)) return;
    if (code === 'Enter') this.handleEnter();
    else if (code === 'Backspace') this.handleBack();
    else if (code === 'ArrowUp') this.moveCursor(-1);
    else if (code === 'ArrowDown') this.moveCursor(1);
  },

  onKeyUp(event) {
    const code = event?.code;
    if (!KEY_HANDLED.includes(code)) return;
    // 页面自己接管默认行为（返回/确认/方向），避免叠加宿主默认动作
    event.preventDefault?.();
  },

  onVoiceWakeup(event) {
    const view = this.data.view;
    if (view === 'listening' || view === 'thinking' || view === 'confirm' || view === 'delete-confirm') return;
    // 自己接管唤醒后的动作，避免宿主再执行一次默认行为
    event?.preventDefault?.();
    if (view === 'no-config') {
      this.openMenu();
      return;
    }
    this.startListening();
  },

  handleEnter() {
    const view = this.data.view;
    if (view === 'no-config') return this.goScan();
    if (view === 'ready' || view === 'answer') return this.startListening();
    if (view === 'listening') {
      this.voice?.stop();
      this.setData({ hint: '正在识别…' });
      return;
    }
    if (view === 'confirm') return this.confirmPending();
    if (view === 'delete-confirm') return this.confirmDeleteConfig();
    if (view === 'menu') return this.executeMenu();
    if (view === 'error') {
      // 文案里的按键动作必须与实际行为一致：需要重新扫码的才去扫码
      if (this.data.errorAction === 'scan') return this.goScan();
      if (this.data.errorAction === 'connect') return this.connectAndVerify();
      this.setData({ view: 'ready', statusText: '已就绪', hint: this.hintFor('ready') });
      return;
    }
  },

  handleBack() {
    if (this.exiting) return;
    const view = this.data.view;
    if (view === 'listening') {
      this.voice?.abort?.();
      this.setData({ view: this.data.servers.length > 0 ? 'ready' : 'no-config', transcript: '' });
      return;
    }
    if (view === 'confirm') return this.cancelPending();
    if (view === 'delete-confirm') {
      this.openMenu();
      return;
    }
    if (view === 'menu') {
      this.setData({ view: this.data.servers.length > 0 ? 'ready' : 'no-config' });
      return;
    }
    if (view === 'no-config') {
      wx.exitMiniProgram();
      return;
    }
    this.openMenu();
  },

  moveCursor(delta) {
    if (this.data.view === 'menu') {
      const count = this.data.menuItems.length;
      this.setData({ menuIndex: (this.data.menuIndex + delta + count) % count });
      return;
    }
    const next = Math.max(0, this.data.scrollTop + delta * 48);
    this.setData({ scrollTop: next });
  },

  /** 手势滚动后把真实位置同步回 data，避免下一次方向键从旧位置跳变。 */
  onBodyScroll(event) {
    const top = Number(event?.detail?.scrollTop);
    if (Number.isFinite(top)) this.setData({ scrollTop: Math.max(0, top) });
  },

  // ---------------------------------------------------------------- 状态

  setView(view, statusText) {
    const patch = { view };
    if (statusText !== undefined) patch.statusText = statusText;
    if (view !== 'listening') patch.hint = this.hintFor(view);
    this.setData(patch);
  },

  hintFor(view, action) {
    switch (view) {
      case 'no-config':
        return '确认键扫码授权 · 返回键菜单';
      case 'ready':
        return '确认键说话 · 返回键菜单';
      case 'answer':
        return '确认键继续提问 · 返回键菜单';
      case 'listening':
        return '正在听…确认键结束 · 返回键取消';
      case 'thinking':
        return '正在处理…';
      case 'confirm':
        return '方向键翻看内容 · 确认键执行 · 返回键取消';
      case 'delete-confirm':
        return '确认键删除 · 返回键取消';
      case 'error':
        if (action === 'scan') return '确认键重新扫码 · 返回键菜单';
        if (action === 'connect') return '确认键重试连接 · 返回键菜单';
        if (action === 'forbidden') return '该能力需后台补授权 · 确认键返回';
        return '确认键重新提问 · 返回键菜单';
      case 'menu':
        return '方向键选择 · 确认键执行 · 返回键关闭';
      case 'connecting':
        return '请稍候…';
      default:
        return '';
    }
  },

  /** 统一错误展示：把「要不要重新扫码」交给 errorAction 决定，避免文案与按键行为不一致。 */
  showError(error, statusText = '出错了') {
    const needRescan = Boolean(error?.needRescan);
    // FORBIDDEN（851008 能力位未授权）不是凭据失效：不要引导重新扫码，提示去后台补授权。
    const action = needRescan
      ? 'scan'
      : error?.code === 'FORBIDDEN'
        ? 'forbidden'
        : this.data.servers.length > 0
          ? 'connect'
          : 'scan';
    this.setData({
      view: 'error',
      statusText,
      errorText: formatError(error),
      errorAction: action,
      hint: this.hintFor('error', action),
    });
  },

  showNoConfig() {
    this.setData({
      view: 'no-config',
      statusText: '尚未授权企业微信',
      hint: this.hintFor('no-config'),
      servers: [],
      answer: '请先用终端工具生成二维码，再按确认键扫码授权。\n生成命令：node tools/wecom-mcp-qr.mjs',
      warning: '',
      errorAction: 'ready',
    });
  },

  applyConfigInfo() {
    const summary = describeConfig();
    this.setData({
      servers: summary.servers.map((server) => ({ ...server, tools: 0 })),
      warning: '',
    });
  },

  async connectAndVerify(options = {}) {
    const generation = this._generation;
    if (!this._isAsyncCurrent(generation)) return null;
    this.setView('connecting', '正在连接企业微信 MCP…');
    try {
      const result = await connectAndVerify();
      // 连接/验证期间离页：旧结果不得覆盖新 UI，也不得后台播报「已连接/连接失败」
      if (!this._isAsyncCurrent(generation)) return null;
      if (!result) throw new Error('连接企业微信 MCP 失败');
      const failed = result.results.filter((item) => !item.ok);
      if (result.ready === 0) {
        const first = failed[0];
        const error = first?.error ?? new Error('没有可用的企业微信 MCP，请重新扫码授权');
        const message = formatError(error);
        // 连接就报 FORBIDDEN（851008 能力位未授权）时同样不能引导重新扫码，而是去后台补授权。
        const action = error?.needRescan ? 'scan' : error?.code === 'FORBIDDEN' ? 'forbidden' : 'connect';
        this.setData({
          view: 'error',
          statusText: '连接失败',
          errorText: first && !message.startsWith(`${first.name}：`) ? `${first.name}：${message}` : message,
          errorAction: action,
          hint: this.hintFor('error', action),
        });
        this._speak(action === 'forbidden' ? '该能力尚未授权，请在后台补授权后重试' : '企业微信连接失败，请检查网络或重新扫码授权', generation);
        return result;
      }
      const warnings = [];
      // 同一段提示可能同时来自 verify 项与连接失败项，这里统一去重，避免首页重复刷屏。
      const seenWarnings = new Set();
      const pushWarning = (message) => {
        const text = String(message ?? '').trim();
        if (!text || seenWarnings.has(text)) return;
        seenWarnings.add(text);
        warnings.push(text);
      };
      // 只有授权失效（UNAUTHORIZED）才提示重新扫码；能力位未授权只提示，不阻断使用
      const authFailed = result.verifies.filter((item) => !item.verified && item.error?.code === 'UNAUTHORIZED');
      for (const item of authFailed) {
        pushWarning(`${item.name}：${formatError(item.error)}`);
      }
      const unverified = result.verifies.filter((item) => !item.verified && item.error?.code !== 'UNAUTHORIZED');
      for (const item of unverified) {
        const message = String(item.error?.message ?? '');
        const prefixed = message.startsWith(`${item.name}：`) ? message : `${item.name}：${message || '授权状态未确认'}`;
        // 851008 类错误要明确指向后台补授权，而不是让用户反复重新扫码
        pushWarning(
          item.error?.code === 'FORBIDDEN' && !/授权|权限/.test(prefixed)
            ? `${item.name}：该能力尚未授权，请在智能机器人「可使用权限」中补授权`
            : prefixed,
        );
      }
      if (failed.length > 0) pushWarning(`${failed.length} 个 MCP 连接失败`);
      this.setData({
        view: 'ready',
        statusText: `已连接 ${result.ready} 个 MCP · ${result.tools} 个工具`,
        servers: describeServers().map(({ name, tools }) => ({ name, tools })),
        warning: warnings.join('；'),
        hint: this.hintFor('ready'),
      });
      if (options.announce !== false) this._speak('企业微信已连接', generation);
      return result;
    } catch (error) {
      if (!this._isAsyncCurrent(generation)) return null;
      this.showError(error, '连接失败');
      this._speak('企业微信连接失败', generation);
      return null;
    }
  },

  // ---------------------------------------------------------------- 语音 / 对话

  async startListening() {
    if (!this.voice) return;
    const generation = this._generation;
    this.voice.stopSpeaking();
    this.setData({ transcript: '', hint: '正在听…确认键结束 · 返回键取消' });
    const started = await this.voice.start({
      onInterim: (text) => {
        if (this._isAsyncCurrent(generation)) this.setData({ transcript: text });
      },
      onFinal: (text) => {
        if (this._isAsyncCurrent(generation)) this.handleUtterance(text);
      },
      onError: (error) => {
        if (!this._isAsyncCurrent(generation)) return;
        this.setData({
          view: 'error',
          statusText: '语音输入失败',
          errorText: error.message,
          errorAction: 'ready',
          hint: this.hintFor('error', 'ready'),
        });
      },
      onEnd: () => {
        if (!this._isAsyncCurrent(generation)) return;
        if (this.data.view === 'listening') {
          this.setData({ view: 'ready', hint: this.hintFor('ready') });
        }
      },
    });
    if (!this._isAsyncCurrent(generation)) return;
    if (!started.ok) {
      this.setData({
        view: 'error',
        statusText: '语音输入失败',
        errorText: started.error.message,
        errorAction: 'ready',
        hint: this.hintFor('error', 'ready'),
      });
      return;
    }
    this.setView('listening', '正在听…');
  },

  /** 异步结果/播报是否仍属于当前可见页面生命周期（onHide/onUnload 后一律作废）。 */
  _isAsyncCurrent(generation) {
    return this._visible && generation === this._generation;
  },

  /** 仅在页面可见且属于当前生命周期时播报，避免 onHide 后迟到的敏感回答被读出来。 */
  _speak(text, generation = this._generation) {
    if (!text || !this._isAsyncCurrent(generation)) return;
    this.voice?.speak?.(text);
  },

  /**
   * 迟到的 ask 在用户离页后又新建了 pending：页面不会再展示它，必须静默作废，
   * 否则用户回到前台后新的提问会被 Assistant 的 CONFIRMING 状态卡住（误以为有新操作待确认）。
   */
  _discardStalePending(previousPending) {
    const pending = this.assistant?.pending;
    if (!pending || pending === previousPending) return;
    try {
      this.assistant.cancel();
    } catch {
      // 清理失败不阻塞后续新会话
    }
  },

  /** 记录当前确认视图展示的 pending 身份（只有 setData(view=confirm) 后才算用户可见）。 */
  _recordDisplayedPending(pending) {
    this._displayedPending = pending ?? null;
  },

  /**
   * 仅在「确认视图已经展示、且展示的正是当前 pending」时返回有效绑定；
   * 后台 pending 提前创建但 UI 尚未 setData(view=confirm) 的窗口、或屏幕还是旧 pending 时返回 null（明确无效）。
   * @returns {{version: number, pending: object} | null}
   */
  _visibleConfirmBinding() {
    const displayed = this._displayedPending;
    if (!displayed || this.data.view !== 'confirm') return null;
    if (!this.assistant || this.assistant.pending !== displayed) return null;
    const binding = this.assistant.captureConfirmBinding?.();
    return binding && binding.pending === displayed ? binding : null;
  },

  /**
   * 把会影响确认状态与屏幕显示的用户动作（提问 / 确认 / 取消）串行化。
   *
   * 页面允许从 thinking 退回菜单再发起新请求；若两个请求并发执行，
   * 先发但较慢的请求晚到时会把后发请求刚显示的确认/结果覆盖掉。
   * 这里按调用顺序排队，保证「assistant 状态变更」与「屏幕显示」顺序一致。
   * @param {() => Promise<void>|void} action
   * @returns {Promise<void>}
   */
  _enqueueUiAction(action) {
    // 统一包成 Promise：action 可能是同步的（如 cancelPending），链上必须始终是 thenable
    const run = () => Promise.resolve().then(action);
    const result = this._uiActionChain ? this._uiActionChain.then(run, run) : run();
    this._uiActionChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  },

  /**
   * 处理一句话（严格串行）。
   * @param {string} text
   * @returns {Promise<void>}
   */
  handleUtterance(text) {
    // 绑定「语音识别完成时屏幕上已经展示」的 pending（不是后台刚创建但未渲染的 pending）；
    // 排队执行时若 pending 已变化，这句「确认」必须失效，不能批准用户还没看到的新写操作。
    const binding = this._visibleConfirmBinding();
    const generation = this._generation;
    return this._enqueueUiAction(() => {
      // 排队期间用户已离开页面（或已进入新一轮生命周期）：整句话作废，不得改 UI/播报
      if (!this._isAsyncCurrent(generation)) return;
      return this._handleUtterance(text, binding, generation);
    });
  },

  async _handleUtterance(text, binding, generation) {
    if (!this._isAsyncCurrent(generation)) return;
    const utterance = String(text ?? '').trim();
    if (!utterance) {
      this.setData({ view: 'ready', transcript: '', hint: this.hintFor('ready') });
      return;
    }
    this.setData({
      view: 'thinking',
      statusText: '正在处理…',
      transcript: utterance,
      hint: this.hintFor('thinking'),
    });
    try {
      const pendingBefore = this.assistant.pending;
      // 显式传 binding（可为 null=无效）：不能让 Assistant 在执行时重新采集，否则会批准未展示的 pending
      const result = await this.assistant.ask(utterance, { confirmBinding: binding });
      // 等待 MCP 期间用户可能已 onHide：迟到的回答不得覆盖新 UI，也不得后台播报
      if (!this._isAsyncCurrent(generation)) {
        this._discardStalePending(pendingBefore);
        return;
      }
      const pending = this.assistant.pending;
      // 确认态下说了别的话：Assistant 会保持 CONFIRMING 并回调提示，
      // 此时页面也必须留在确认视图，否则「确认/取消」这两个物理按键就没了落点。
      if (result.kind === 'confirm' || (pending && this.assistant.state === 'confirming')) {
        this._recordDisplayedPending(pending);
        this.setData({
          view: 'confirm',
          // 预先说出的「确认」被判定失效时，明确提示操作已更新，让用户重新看内容再确认
          statusText: result.stale ? '待确认操作已更新' : '等待确认',
          pendingTitle: pending?.title ?? '',
          pendingDetail: pending?.detail ?? '',
          answer: '',
          hint: this.hintFor('confirm'),
        });
        this._speak(result.speech, generation);
        return;
      }
      if (result.expired) {
        // 确认态停留超过 TTL 后用户又说了别的话：Assistant 会作废 pending 并提示超时，
        // 这里必须显示「确认已超时」，不能复用下面的「已完成」结果视图。
        this.setData({
          view: 'error',
          statusText: '确认已超时',
          errorText: result.text,
          errorAction: 'ready',
          scrollTop: 0,
          hint: this.hintFor('error', 'ready'),
        });
        this._speak(result.speech, generation);
        return;
      }
      if (result.kind === 'error') {
        // 与 confirmPending 一样：失败必须显示「出错了」，不能落到「已完成」
        const action = this.actionForError(result);
        this.setData({
          view: 'error',
          statusText: result.failClosed ? '操作已失效' : '出错了',
          errorText: result.text,
          errorAction: action,
          hint: this.hintFor('error', action),
          scrollTop: 0,
        });
        this._speak(result.speech, generation);
        return;
      }
      this.setData({
        view: 'answer',
        statusText: '已完成',
        answer: result.text,
        errorText: '',
        scrollTop: 0,
        hint: this.hintFor('answer'),
      });
      this._speak(result.speech, generation);
    } catch (error) {
      this.showError(error, '出错了');
    }
  },

  /** 根据错误类型决定错误页确认键的行为：重新扫码 / 后台补授权 / 重连 / 重新提问。 */
  actionForError(result) {
    // 工具身份/权限在确认后变化：底层 fail-closed 未执行，只能让用户重新发起，不能重试/换工具
    if (result?.failClosed) return 'ready';
    if (result?.needRescan) return 'scan';
    // 851008 能力位未授权：去后台补权限，重扫/重连都不会恢复
    if (result?.code === 'FORBIDDEN') return 'forbidden';
    if (this.data.servers.length === 0) return 'scan';
    // 工具级失败（参数、业务错误）重连也没用，直接回到提问
    if (result?.code === 'TOOL') return 'ready';
    return 'connect';
  },

  /** 确认执行（与提问同队列串行，避免确认进行中又被迟到的提问覆盖）。 */
  confirmPending() {
    // 按键发生时只绑定「屏幕上已经展示」的 pending；排队期间 pending 变化则确认失效
    const binding = this._visibleConfirmBinding();
    const generation = this._generation;
    return this._enqueueUiAction(() => {
      if (!this._isAsyncCurrent(generation)) return;
      return this._confirmPending(binding, generation);
    });
  },

  async _confirmPending(binding, generation) {
    if (!this._isAsyncCurrent(generation)) return;
    this.setData({ view: 'thinking', statusText: '正在执行…', hint: this.hintFor('thinking') });
    try {
      const result = await this.assistant.confirm(binding);
      // 执行期间离页：结果可能已发到服务端，但绝不能再改 UI/播报（用户看不到确认结果）
      if (!this._isAsyncCurrent(generation)) return;
      // 超时 / 已经没有 pending 时 confirm() 会返回普通 answer 文案，必须分流成「未执行」，
      // 否则页面会显示「已执行」，让用户以为写操作真的发生了。
      if (result.expired || result.noPending) {
        this.setData({
          view: 'error',
          statusText: result.expired ? '确认已超时' : '没有待确认的操作',
          errorText: result.text,
          errorAction: 'ready',
          pendingTitle: '',
          pendingDetail: '',
          scrollTop: 0,
          hint: this.hintFor('error', 'ready'),
        });
        this._speak(result.speech, generation);
        return;
      }
      if (result.stale) {
        // 按键发生在当前 pending 生成之前：不执行，回到确认页展示实际待确认内容
        const current = this.assistant.pending;
        this._recordDisplayedPending(current);
        this.setData({
          view: 'confirm',
          statusText: '待确认操作已更新',
          pendingTitle: current?.title ?? '',
          pendingDetail: current?.detail ?? '',
          scrollTop: 0,
          hint: this.hintFor('confirm'),
        });
        this._speak(result.speech, generation);
        return;
      }
      if (result.kind === 'error') {
        const action = this.actionForError(result);
        this.setData({
          view: 'error',
          statusText: result.failClosed ? '操作已失效' : '执行失败',
          errorText: result.text,
          errorAction: action,
          pendingTitle: '',
          pendingDetail: '',
          scrollTop: 0,
          hint: this.hintFor('error', action),
        });
        this._speak(result.speech, generation);
        return;
      }
      this.setData({
        view: 'answer',
        statusText: '已执行',
        answer: result.text,
        errorText: '',
        pendingTitle: '',
        pendingDetail: '',
        scrollTop: 0,
        hint: this.hintFor('answer'),
      });
      this._speak(result.speech, generation);
    } catch (error) {
      if (!this._isAsyncCurrent(generation)) return;
      this.showError(error, '执行失败');
    }
  },

  /** 取消待确认操作（与提问/确认同队列串行）。 */
  cancelPending() {
    const binding = this._visibleConfirmBinding();
    const generation = this._generation;
    return this._enqueueUiAction(() => {
      if (!this._isAsyncCurrent(generation)) return;
      this._cancelPending(binding, generation);
    });
  },

  _cancelPending(binding, generation) {
    if (!this._isAsyncCurrent(generation)) return;
    const result = this.assistant.cancel(binding);
    if (result.stale) {
      // 预先说出的「取消」同样不能作用到后来生成的 pending
      const current = this.assistant.pending;
      if (current) {
        this._recordDisplayedPending(current);
        this.setData({
          view: 'confirm',
          statusText: '待确认操作已更新',
          pendingTitle: current.title ?? '',
          pendingDetail: current.detail ?? '',
          scrollTop: 0,
          hint: this.hintFor('confirm'),
        });
      } else {
        this.setData({
          view: 'error',
          statusText: '没有待确认的操作',
          errorText: result.text,
          errorAction: 'ready',
          pendingTitle: '',
          pendingDetail: '',
          scrollTop: 0,
          hint: this.hintFor('error', 'ready'),
        });
      }
      this._speak(result.speech, generation);
      return;
    }
    if (result.expired) {
      // 已经超时：pending 已作废，显示「已取消」会误导用户以为主动取消了有效操作
      this.setData({
        view: 'error',
        statusText: '确认已超时',
        errorText: result.text,
        errorAction: 'ready',
        pendingTitle: '',
        pendingDetail: '',
        scrollTop: 0,
        hint: this.hintFor('error', 'ready'),
      });
      this._speak(result.speech, generation);
      return;
    }
    this.setData({
      view: 'ready',
      statusText: '已取消',
      answer: '',
      pendingTitle: '',
      pendingDetail: '',
      hint: this.hintFor('ready'),
    });
    this._speak(result.speech, generation);
  },

  // ---------------------------------------------------------------- 菜单

  openMenu() {
    this.setData({ view: 'menu', menuIndex: 0, hint: this.hintFor('menu') });
  },

  executeMenu() {
    const item = this.data.menuItems[this.data.menuIndex];
    switch (item?.id) {
      case 'ask':
        return this.startListening();
      case 'tools':
        wx.navigateTo({ url: '/pages/tools/index' });
        return undefined;
      case 'rescan':
        return this.goScan();
      case 'delete':
        return this.requestDeleteConfig();
      case 'exit':
        return this.exitAssistant();
      default:
        return undefined;
    }
  },

  goScan() {
    // navigateTo 的 url 是「绝对项目路径」：必须以 / 开头，否则会被当成相对当前页面目录
    wx.navigateTo({ url: '/pages/scan/index' });
  },

  /** 删除配置前必须二次确认：误触会直接丢掉 API Key。 */
  requestDeleteConfig() {
    this.setData({
      view: 'delete-confirm',
      statusText: '删除配置',
      hint: this.hintFor('delete-confirm'),
    });
  },

  async confirmDeleteConfig() {
    const generation = this._generation;
    if (!this._isAsyncCurrent(generation)) return;
    this.setView('thinking', '正在删除配置…');
    try {
      await deleteConfig();
      // 删除后 servers/assistant 也被重建，刷新引用再回到「未配置」
      await this.refreshSessionRefs();
      if (!this._isAsyncCurrent(generation)) return;
      this.showNoConfig();
      this._speak('已删除企业微信配置', generation);
    } catch (error) {
      if (!this._isAsyncCurrent(generation)) return;
      // 删除失败时旧配置仍在本机：绝不能落到 showNoConfig 或提示「已删除」，
      // 也不引导重连（连的仍是旧配置），只提示重试删除。
      this.setData({
        view: 'error',
        statusText: '删除失败',
        errorText: `${formatError(error)}（配置仍保留在本机，可稍后重试删除）`,
        errorAction: 'ready',
        scrollTop: 0,
        hint: this.hintFor('error', 'ready'),
      });
    }
  },

  /** 退出助手：先释放 MCP 连接与语音资源，再退出小程序。 */
  async exitAssistant() {
    if (this.exiting) return;
    this.exiting = true;
    this.setView('thinking', '正在退出…');
    try {
      // 清理最多等 1.5s：设备上关闭 MCP 连接偶尔会拖住，不能因此卡在「正在退出…」
      await Promise.race([disposeSession(), new Promise((resolve) => setTimeout(resolve, 1500))]);
    } catch {
      // 退出前的清理失败不阻塞退出
    }
    wx.exitMiniProgram();
  },

};
</script>

<page>
  <view class="page">
    <view class="topbar">
      <text class="brand">企业微信助手</text>
      <text class="status">{{statusText}}</text>
    </view>

    <scroll-view class="body" scroll-y="true" scroll-top="{{scrollTop}}" bindscroll="onBodyScroll">
      <!-- 未配置 -->
      <view class="panel" ink:if="{{view === 'no-config'}}">
        <text class="hint-block">{{answer}}</text>
      </view>

      <!-- 连接/验证 -->
      <view class="panel" ink:if="{{view === 'connecting'}}">
        <text class="hint-block">正在连接企业微信官方 MCP…</text>
        <text class="meta" ink:for="{{servers}}" ink:for-item="server">{{server.name}}</text>
      </view>

      <!-- 就绪 -->
      <view class="panel" ink:if="{{view === 'ready'}}">
        <text class="meta" ink:for="{{servers}}" ink:for-item="server">{{server.name}} · {{server.tools}} 个工具</text>
        <text class="warn" ink:if="{{modeNote}}">{{modeNote}}</text>
        <text class="warn" ink:if="{{warning}}">{{warning}}</text>
      </view>

      <!-- 语音中 -->
      <view class="panel" ink:if="{{view === 'listening'}}">
        <text class="listening">正在聆听…</text>
        <text class="transcript">{{transcript || '请说出你的需求'}}</text>
      </view>

      <!-- 思考 -->
      <view class="panel" ink:if="{{view === 'thinking'}}">
        <text class="transcript" ink:if="{{transcript}}">{{transcript}}</text>
        <text class="hint-block">正在调用企业微信能力…</text>
      </view>

      <!-- 回答 -->
      <view class="panel" ink:if="{{view === 'answer'}}">
        <text class="answer">{{answer}}</text>
      </view>

      <!-- 确认 -->
      <view class="panel confirm" ink:if="{{view === 'confirm'}}">
        <text class="confirm-title">需要确认</text>
        <text class="confirm-title2">{{pendingTitle}}</text>
        <text class="confirm-detail">{{pendingDetail}}</text>
      </view>

      <!-- 删除配置二次确认 -->
      <view class="panel confirm" ink:if="{{view === 'delete-confirm'}}">
        <text class="confirm-title">删除已保存配置</text>
        <text class="confirm-title2">确认删除企业微信授权？</text>
        <text class="confirm-detail">删除后需重新扫码授权才能继续使用。</text>
      </view>

      <!-- 错误 -->
      <view class="panel" ink:if="{{view === 'error'}}">
        <text class="error">{{errorText}}</text>
      </view>

      <!-- 菜单 -->
      <view class="panel menu" ink:if="{{view === 'menu'}}">
        <view
          class="menu-item {{index === menuIndex ? 'menu-item-active' : ''}}"
          ink:for="{{menuItems}}"
          ink:for-item="item"
          ink:for-index="index"
        >
          <text class="menu-index">{{index + 1}}</text>
          <text class="menu-label">{{item.label}}</text>
        </view>
      </view>
    </scroll-view>

    <view class="footer">
      <text class="hint">{{hint}}</text>
    </view>
  </view>
</page>

<style>
  .page {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: #000000;
    color: #40ff5e;
    padding: 10px 14px 6px;
    box-sizing: border-box;
  }

  .topbar {
    display: flex;
    flex-direction: row;
    align-items: baseline;
    justify-content: space-between;
    border-bottom: 1px solid rgba(64, 255, 94, 0.24);
    padding-bottom: 6px;
  }

  .brand {
    font-size: 15px;
    font-weight: 500;
    color: #40ff5e;
    letter-spacing: 0.01em;
  }

  .status {
    font-size: 11px;
    color: rgba(64, 255, 94, 0.48);
  }

  .body {
    flex: 1;
    min-height: 0;
    margin-top: 8px;
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .hint-block {
    font-size: 14px;
    line-height: 20px;
    color: rgba(64, 255, 94, 0.72);
  }

  .meta {
    font-size: 12px;
    line-height: 18px;
    color: rgba(64, 255, 94, 0.48);
  }

  .warn {
    font-size: 11px;
    line-height: 16px;
    color: rgba(64, 255, 94, 0.48);
    border-left: 2px solid rgba(64, 255, 94, 0.48);
    padding-left: 6px;
  }

  .listening {
    font-size: 13px;
    color: #40ff5e;
  }

  .transcript {
    font-size: 15px;
    line-height: 21px;
    color: #40ff5e;
  }

  .answer {
    font-size: 14px;
    line-height: 20px;
    color: rgba(64, 255, 94, 0.72);
    white-space: pre-wrap;
  }

  .confirm {
    border: 1px solid rgba(64, 255, 94, 0.72);
    border-radius: 6px;
    padding: 8px 10px;
    background: rgba(64, 255, 94, 0.12);
  }

  .confirm-title {
    font-size: 11px;
    letter-spacing: 0.08em;
    color: rgba(64, 255, 94, 0.48);
  }

  .confirm-title2 {
    font-size: 15px;
    color: #40ff5e;
  }

  .confirm-detail {
    font-size: 12px;
    line-height: 17px;
    color: rgba(64, 255, 94, 0.72);
  }

  .error {
    font-size: 13px;
    line-height: 19px;
    color: rgba(64, 255, 94, 0.72);
    border-left: 2px solid #40ff5e;
    padding-left: 6px;
    white-space: pre-wrap;
  }

  .menu {
    gap: 4px;
  }

  .menu-item {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    border-left: 2px solid transparent;
  }

  .menu-item-active {
    background: rgba(64, 255, 94, 0.12);
    border-left-color: #40ff5e;
  }

  .menu-index {
    font-size: 11px;
    color: rgba(64, 255, 94, 0.48);
    width: 12px;
  }

  .menu-label {
    font-size: 14px;
    color: rgba(64, 255, 94, 0.72);
  }

  .footer {
    border-top: 1px solid rgba(64, 255, 94, 0.24);
    padding-top: 4px;
  }

  .hint {
    font-size: 10px;
    color: rgba(64, 255, 94, 0.48);
  }
</style>
