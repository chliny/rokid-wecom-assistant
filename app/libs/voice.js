// 语音能力封装：语音识别（ASR）+ 语音播报（TTS）。
//
// AIUI 契约要点：
//   - `SpeechRecognition` / `speechSynthesis` 是全局能力，也可从虚拟模块 'speech' 导入；
//   - `start()` 需要交互态（按键/唤醒后），否则抛 InvalidStateError；
//   - 播报用 `new SpeechSynthesisUtterance(text)` + `speechSynthesis.speak()`。
// 因此这里做「能力探测 + 友好降级」：没有语音能力时应用仍可按键+看屏使用。
import { toSpeechText } from './format.js';

/**
 * 动态解析运行时能力：先查全局对象，再尝试虚拟模块。
 * @param {string} name 能力名（如 SpeechRecognition）
 * @param {string} moduleName 虚拟模块名（如 speech）
 * @param {object} globalObject
 * @returns {Promise<any | null>}
 */
async function resolveCapability(name, moduleName, globalObject) {
  const fromGlobal = globalObject?.[name];
  if (fromGlobal) return fromGlobal;
  try {
    const module = await import(/* @vite-ignore */ moduleName);
    return module?.[name] ?? module?.default ?? null;
  } catch {
    return null;
  }
}

export class VoiceController {
  /**
   * @param {{
   *   logger?: any,
   *   globalObject?: object,
   *   resolveCapability?: (name: string, moduleName: string) => Promise<any | null>,
   * }} [deps]
   */
  constructor(deps = {}) {
    this._logger = deps.logger ?? null;
    this._globalObject = deps.globalObject ?? globalThis;
    this._resolve = deps.resolveCapability ?? ((name, moduleName) => resolveCapability(name, moduleName, this._globalObject));
    /** @type {any} */
    this._recognitionCtor = null;
    /** @type {any} */
    this._synthesis = null;
    /** @type {any} */
    this._utteranceCtor = null;
    this._resolved = false;
    /** @type {Promise<VoiceController> | null} 共享的初始化 promise，并发调用等待同一次解析 */
    this._initPromise = null;
    /** @type {number} 生命周期 token：init 期间的 abort/stop 会让在途 start 作废 */
    this._session = 0;
    /** @type {number} 播报 token：stopSpeaking 后，await init 中的旧 speak 不得再出声 */
    this._speechSession = 0;
    /** @type {any} */
    this._recognition = null;
    this.listening = false;
    this._stopRequested = false;
  }

  /**
   * 懒加载语音能力（首次调用时解析并缓存）。
   * 并发调用共享同一个初始化 promise：否则第二个调用会在第一个还没解析完时
   * 读到空的 _recognitionCtor，误报「当前设备不支持语音识别」。
   */
  async init() {
    if (!this._initPromise) {
      this._initPromise = this._resolveCapabilities().catch((error) => {
        // 初始化失败清掉 promise，允许后续重试（否则会永久 reject）
        this._initPromise = null;
        throw error;
      });
    }
    return this._initPromise;
  }

  /** @returns {Promise<VoiceController>} */
  async _resolveCapabilities() {
    this._recognitionCtor = await this._resolve('SpeechRecognition', 'speech');
    this._synthesis = this._globalObject?.speechSynthesis ?? (await this._resolve('speechSynthesis', 'speech'));
    this._utteranceCtor = await this._resolve('SpeechSynthesisUtterance', 'speech');
    this._resolved = true;
    if (!this._recognitionCtor) this._logger?.warn?.('当前运行时不支持 SpeechRecognition，语音输入将不可用');
    if (!this._synthesis || !this._utteranceCtor) this._logger?.warn?.('当前运行时不支持语音播报');
    return this;
  }

  get speechAvailable() {
    return typeof this._recognitionCtor === 'function';
  }

  get ttsAvailable() {
    return Boolean(this._synthesis && typeof this._synthesis.speak === 'function' && this._utteranceCtor);
  }

  /**
   * 开始一次语音识别。
   * @param {{lang?: string, onInterim?: (text: string) => void, onFinal: (text: string) => void, onError?: (error: {code: string, message: string}) => void, onEnd?: () => void}} handlers
   * @returns {Promise<{ok: boolean, error?: {code: string, message: string}}>}
   */
  async start(handlers) {
    // 生命周期 token：init 期间页面 onHide/abort 会递增 _session，初始化完成后本次 start
    // 直接作废——不能等 init 回来再启动录音，否则隐藏后仍会录。
    let session = (this._session += 1);
    try {
      await this.init();
    } catch (error) {
      return {
        ok: false,
        error: { code: 'unavailable', message: `语音能力初始化失败：${error?.message ?? error}` },
      };
    }
    if (session !== this._session) {
      return { ok: false, error: { code: 'cancelled', message: '语音识别已取消' } };
    }
    if (!this.speechAvailable) {
      return { ok: false, error: { code: 'unavailable', message: '当前设备不支持语音识别，请用按键操作' } };
    }
    if (this.listening) {
      // 结束上一次录音（旧会话的迟到事件由 _recognition 身份守卫丢弃），
      // abort() 会递增 token，这里重新取一次，避免把自己的新会话也取消掉。
      this.abort();
      session = this._session;
    }

    let recognition;
    try {
      recognition = new this._recognitionCtor();
    } catch (error) {
      return { ok: false, error: { code: 'init-failed', message: `语音识别初始化失败：${error?.message ?? error}` } };
    }

    recognition.lang = handlers.lang ?? 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    this._recognition = recognition;
    this.listening = true;
    this._stopRequested = false;
    let delivered = false;
    // 本次识别是否已经上报过真实错误（权限/网络等）。上报过后，onend 不能再补
    // 「没有听到内容」，否则会把「麦克风权限未开启」覆盖成「请再说一次」。
    let errorReported = false;
    // 宿主明确告知「已取消」（aborted）：不算错误，也不必再补 no-speech 提示。
    let cancelled = false;

    const finishOnce = (text) => {
      if (delivered) return;
      delivered = true;
      handlers.onFinal(String(text ?? '').trim());
    };

    recognition.onresult = (event) => {
      // 旧会话（被 abort 或被新的 start 顶掉）的迟到事件不得回调新会话的处理器
      if (this._recognition !== recognition) return;
      const results = event?.results ?? [];
      let finalText = '';
      let interimText = '';
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        const alternative = result?.[0];
        const transcript = alternative?.transcript ?? '';
        if (result?.isFinal) finalText += transcript;
        else interimText += transcript;
      }
      if (finalText && !interimText) {
        finishOnce(finalText);
        return;
      }
      const preview = `${finalText}${interimText}`.trim();
      if (preview) handlers.onInterim?.(preview);
    };
    recognition.onerror = (event) => {
      // 旧会话的迟到错误（如 abort 后宿主补发的 not-allowed）不能污染新会话
      if (this._recognition !== recognition) return;
      this.listening = false;
      const code = String(event?.error ?? 'unknown');
      this._logger?.warn?.(`语音识别错误：${code}`);
      // aborted / no-speech 属于「用户取消 / 没说话」，不算错误，统一交给 onend 收尾
      if (code === 'aborted' || code === 'no-speech') {
        if (code === 'aborted') cancelled = true;
        return;
      }
      errorReported = true;
      handlers.onError?.({ code, message: describeSpeechError(code) });
    };
    recognition.onend = () => {
      // 旧会话的 onend 迟到时直接丢弃：否则会把新录音的 listening 置为 false，
      // 并回调上一页的 onEnd/onError。
      if (this._recognition !== recognition) return;
      this.listening = false;
      this._recognition = null;
      if (!delivered && !this._stopRequested && !errorReported && !cancelled) {
        // 用户没说话就结束了：交给 UI 提示重试
        handlers.onError?.({ code: 'no-speech', message: '没有听到内容，请再说一次' });
      }
      handlers.onEnd?.();
    };

    try {
      recognition.start();
    } catch (error) {
      this.listening = false;
      // start 失败时不会有后续事件；清掉引用，避免拦住下一次 start
      if (this._recognition === recognition) this._recognition = null;
      const name = String(error?.name ?? '');
      if (name === 'InvalidStateError') {
        return { ok: false, error: { code: 'invalid-state', message: '请先用按键或唤醒词唤醒，再开始说话' } };
      }
      return { ok: false, error: { code: 'start-failed', message: `无法开始录音：${error?.message ?? error}` } };
    }
    return { ok: true };
  }

  /** 结束识别并等待最终结果（用户主动说完）。 */
  stop() {
    // 若仍在 await init，也视为取消本次 start（否则初始化完成后会继续启动录音）
    this._session += 1;
    this._stopRequested = true;
    try {
      this._recognition?.stop?.();
    } catch (error) {
      this._logger?.warn?.('停止语音识别失败', error);
    }
  }

  /** 取消识别，丢弃结果。 */
  abort() {
    // init 期间调用也要让在途 start 作废，避免初始化完成后又启动录音
    this._session += 1;
    this._stopRequested = true;
    this.listening = false;
    try {
      this._recognition?.abort?.();
    } catch (error) {
      this._logger?.warn?.('取消语音识别失败', error);
    }
    this._recognition = null;
  }

  /**
   * 播报一段文本。
   * @param {string} text
   * @param {{maxChars?: number}} [options]
   * @returns {Promise<boolean>} 是否真的开始播报
   */
  async speak(text, options = {}) {
    // 播报 generation：await init 期间页面 onHide 调 stopSpeaking 后，这次 speak 直接作废，
    // 否则初始化完成会在后台把敏感内容播报出来（stopSpeaking 只 cancel 已入队的播报）。
    const session = this._speechSession;
    await this.init();
    if (session !== this._speechSession) return false;
    if (!this.ttsAvailable) return false;
    const content = toSpeechText(text, { maxChars: options.maxChars ?? 120 });
    if (!content) return false;
    // 兜底：init 返回后到这里没有 await，但保持与 token 一致，防未来加 await 后回归
    if (session !== this._speechSession) return false;
    try {
      this._synthesis.cancel?.();
    } catch {
      // cancel 不是所有实现都有
    }
    try {
      const utterance = new this._utteranceCtor(content);
      utterance.lang = options.lang ?? 'zh-CN';
      this._synthesis.speak(utterance, 'enqueue');
      return true;
    } catch (error) {
      this._logger?.warn?.('语音播报失败', error);
      return false;
    }
  }

  /** 停止当前播报（同时作废还在 await init 的 speak，避免初始化完成后又播报）。 */
  stopSpeaking() {
    this._speechSession += 1;
    try {
      this._synthesis?.cancel?.();
    } catch {
      // 忽略
    }
  }
}

/**
 * @param {string} code
 * @returns {string}
 */
function describeSpeechError(code) {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return '麦克风权限未开启，请在系统设置中允许录音';
    case 'audio-capture':
      return '没有可用的麦克风';
    case 'network':
      return '语音识别服务网络异常';
    case 'language-not-supported':
      return '当前语言不支持语音识别';
    default:
      return `语音识别失败（${code}）`;
  }
}
