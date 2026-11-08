<script type="application/json" def>
{
  "navigationBarTitleText": "扫码授权",
  "description": "扫描终端工具生成的二维码，获取企业微信 MCP 配置。",
  "disableScroll": true
}
</script>

<script setup>
import wx from 'wx';
import { createQrDetector, scanOnce } from '../../libs/scanner.js';
import { createChunkAssembler, parseScannedText, validatePayload, ConfigError } from '../../libs/qr-payload.js';
import { setScanResult, probeServers } from '../../libs/session.js';
import { formatError } from '../../libs/format.js';

// 探测最多 32 个 MCP 配置：连接并发 15s + 验证按 4 并发分批，给一个上界兜底，
// 避免页面永远停在 PROBING（超过该上限提示重试，用户也可按返回键退出）。
const PROBE_TIMEOUT_MS = 150000;

/** 给可能永不返回的异步操作加超时（用于连接验证这类不可取消的长流程）。 */
function withTimeout(promise, ms, message) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export default {
  data: {
    status: 'READY',
    message: '将二维码对准镜头，按确认键扫描',
    detail: '',
    progress: '',
    isScanning: false,
    // 扫码成功后先连接验证授权、展示可用工具，再让用户确认保存方式
    persist: true,
    saving: false,
    serverNames: '',
    serverCount: 0,
    toolCount: 0,
    warning: '',
    pendingPayload: null,
  },

  async onLoad() {
    // 页面销毁后仍可能有在途的拍照/探测回调，统一用 updateData 丢弃
    this.destroyed = false;
    // 每次开始一次新流程 / 页面隐藏时递增；在途 await 回来后与当前值不一致即丢弃
    this.generation = 0;
    this.assembler = createChunkAssembler();
    try {
      this.detector = await createQrDetector();
    } catch (error) {
      this.updateData({
        status: 'ERROR',
        message: '无法启用二维码识别',
        detail: error?.message || '当前设备不支持 BarcodeDetector',
      });
    }
  },

  onShow() {
    this.destroyed = false;
    this.cameraContext = wx.media.createCameraContext();
    // 页面从后台回来：在途的拍照/探测回调已不可信，换一代 token 丢弃旧结果，
    // 并把 SCANNING/PROBING 等临时状态复位，避免页面永久卡在「正在识别…」。
    this.nextGeneration();
    this.resetTransientState();
  },

  onHide() {
    this.destroyed = true;
    this.nextGeneration();
    this.cameraContext = null;
    // 只丢弃页面引用，不释放 scanner 的摄像头门禁：旧的 takePhoto/detect 并没有被取消，
    // 新 cameraContext 也不代表旧硬件操作已结束，释放门禁会造成并发拍照。
  },

  onUnload() {
    this.destroyed = true;
    this.nextGeneration();
    this.cameraContext = null;
    // 同上：门禁由 scanner 模块跨页面持有，旧操作 settle 后才释放。
  },

  /** 页面已销毁时丢弃在途回调的 setData。 */
  updateData(patch) {
    if (this.destroyed) return false;
    this.setData(patch);
    return true;
  },

  /** 进入下一代：页面上所有在途异步流程的旧 generation 立即失效。 */
  nextGeneration() {
    this.generation = (this.generation ?? 0) + 1;
    return this.generation;
  },

  /** 本次异步流程是否仍然有效（页面未隐藏/销毁，且 generation 未被新流程顶掉）。 */
  isGenerationCurrent(generation) {
    return !this.destroyed && generation === this.generation;
  },

  /** 从后台回来或取消后复位临时状态：只动 SCANNING/PROBING 与被打断的保存，不动 READY/CONFIRM。 */
  resetTransientState() {
    const status = this.data.status;
    if (status === 'SCANNING' || status === 'PROBING') {
      this.setData({
        status: 'READY',
        message: '上一次操作已取消，请重新扫描',
        detail: '将二维码对准镜头，按确认键扫描',
        progress: '',
        isScanning: false,
        pendingPayload: null,
        warning: '',
      });
      return;
    }
    // 保存过程中被系统打断（页面回到前台但配置没有回传）：回到可重扫状态，避免按键全部失效
    if (status === 'CONFIRM' && (this.data.saving || !this.data.pendingPayload)) {
      this.setData({
        status: 'READY',
        message: '保存未完成，请重新扫描',
        detail: '将二维码对准镜头，按确认键扫描',
        isScanning: false,
        saving: false,
        pendingPayload: null,
        warning: '',
      });
    }
  },

  onKeyDown(event) {
    const code = event?.code;
    const status = this.data.status;
    if (status === 'CONFIRM') {
      // 保存已触发（已回传配置并 navigateBack）：忽略所有按键，避免取消/切换撤销已发生的保存
      if (this.data.saving) return;
      if (code === 'Enter' || code === 'GlobalHook') {
        this.saveAndReturn();
        return;
      }
      if (code === 'Backspace') {
        this.cancelConfirm();
        return;
      }
      if (code === 'ArrowUp' || code === 'ArrowDown') {
        this.setData({ persist: !this.data.persist });
        return;
      }
      return;
    }
    // SCANNING / PROBING 期间不响应确认键：避免重复触发扫码或与在途探测竞争；
    // 但必须允许返回键退出，否则在途回调丢失（页面隐藏/卡住）时页面会永久无响应。
    if (status !== 'READY' && status !== 'ERROR') {
      if (code === 'Backspace') {
        this.nextGeneration();
        wx.navigateBack({ delta: 1 });
      }
      return;
    }
    if (code === 'Backspace') {
      wx.navigateBack({ delta: 1 });
      return;
    }
    if (code === 'Enter' || code === 'GlobalHook') {
      this.captureAndScan();
    }
  },

  onKeyUp(event) {
    if (['Enter', 'Backspace', 'GlobalHook', 'ArrowUp', 'ArrowDown'].includes(event?.code)) {
      event.preventDefault?.();
    }
  },

  async captureAndScan() {
    if (this.data.isScanning || this.data.saving) return;
    if (!this.detector) {
      this.updateData({ status: 'ERROR', message: '二维码识别不可用', detail: '请改用终端配置或更换设备' });
      return;
    }
    if (!this.cameraContext) this.cameraContext = wx.media.createCameraContext();
    const generation = this.generation ?? 0;
    this.updateData({ status: 'SCANNING', isScanning: true, message: '正在识别…' });
    try {
      const result = await scanOnce({ cameraContext: this.cameraContext, detector: this.detector });
      // 页面隐藏/被新流程顶掉后，旧回调只丢弃，不能改写当前状态
      if (!this.isGenerationCurrent(generation)) return;
      if (!result) {
        this.updateData({
          status: 'READY',
          message: '未识别到二维码',
          detail: '调整距离与角度后，再按确认键重试',
        });
        return;
      }
      this.handleScannedText(result.rawValue);
    } catch (error) {
      if (!this.isGenerationCurrent(generation)) return;
      if (error?.busy) {
        // 上一次底层拍照/识别还没归还：明确提示占用，用户可再按确认键重试或按返回键退出
        this.updateData({
          status: 'ERROR',
          message: '摄像头仍被占用',
          detail: error.message,
        });
        return;
      }
      this.updateData({
        status: 'ERROR',
        message: '扫码失败',
        detail: error?.message || '请重试',
      });
    } finally {
      if (this.isGenerationCurrent(generation)) this.updateData({ isScanning: false });
    }
  },

  handleScannedText(rawValue) {
    let parsed;
    try {
      parsed = parseScannedText(rawValue);
    } catch (error) {
      this.showConfigError(error);
      return;
    }

    if (parsed.kind === 'payload') {
      this.finishWithPayload(parsed.payload);
      return;
    }

    let outcome;
    try {
      outcome = this.assembler.add(parsed.chunk, parsed.data, parsed.checksum);
    } catch (error) {
      this.assembler.reset();
      this.showConfigError(error);
      return;
    }

    if (outcome.status === 'pending') {
      this.updateData({
        status: 'READY',
        message: `已扫描第 ${outcome.received}/${outcome.total} 张`,
        detail: '请继续扫描下一张二维码',
        progress: `${outcome.received}/${outcome.total}`,
      });
      return;
    }

    let payload;
    try {
      const reassembled = parseScannedText(outcome.text);
      if (reassembled.kind !== 'payload') throw new ConfigError('INVALID_PAYLOAD', '分片重组结果不是完整配置');
      payload = reassembled.payload;
    } catch (error) {
      this.showConfigError(error);
      return;
    }
    this.finishWithPayload(payload);
  },

  finishWithPayload(payload) {
    let validated;
    try {
      validated = validatePayload(payload);
    } catch (error) {
      this.showConfigError(error);
      return;
    }
    this.probeAndConfirm(validated);
  },

  /** 最多展示 3 个 server 名，避免 352px 屏幕被 32 个长名称撑破。 */
  formatServerNames(servers) {
    const names = servers.map((server) => server.name);
    const shown = names.slice(0, 3).join('、');
    return names.length > 3 ? `${shown}…` : shown;
  },

  /**
   * 保存前的一次性探测：连接 MCP → 拉工具清单 → 实调只读工具验证授权。
   * 企业微信的 initialize/tools/list 不校验 apikey，所以必须走到 tools/call 才能确定授权有效。
   */
  async probeAndConfirm(validated) {
    const generation = this.generation ?? 0;
    const serverSummary = this.formatServerNames(validated.servers);
    this.updateData({
      status: 'PROBING',
      message: '正在连接企业微信并验证授权…',
      detail: serverSummary,
      progress: '',
      warning: '',
      pendingPayload: validated,
    });
    let probe;
    try {
      probe = await withTimeout(
        probeServers(validated.servers),
        PROBE_TIMEOUT_MS,
        '验证授权超时（网络较慢或 MCP 无响应），请按确认键重试',
      );
    } catch (error) {
      if (!this.isGenerationCurrent(generation)) return;
      this.updateData({
        status: 'ERROR',
        message: '验证授权失败',
        detail: formatError(error),
        pendingPayload: null,
      });
      return;
    }
    // 页面隐藏/被新流程顶掉（例如返回键退出）后，探测结果直接丢弃
    if (!this.isGenerationCurrent(generation)) return;
    if (!probe.ok) {
      this.updateData({
        status: 'ERROR',
        message: probe.authFailed ? '授权无效或已过期' : '无法连接该 MCP',
        detail: formatError(probe.error ?? { message: '请检查网络后重试' }),
        pendingPayload: null,
      });
      return;
    }
    const names = probe.tools.map((tool) => tool.name);
    const shown = names.slice(0, 3).join('、');
    const warnings = Array.isArray(probe.warnings) ? probe.warnings.filter(Boolean) : [];
    this.updateData({
      status: 'CONFIRM',
      message: `已读取 ${validated.servers.length} 个 MCP 配置`,
      detail: `工具：${shown}${names.length > 3 ? ' …' : ''}`,
      toolCount: probe.toolCount,
      serverNames: serverSummary,
      serverCount: validated.servers.length,
      warning: warnings.join('；'),
      pendingPayload: validated,
      persist: true,
    });
  },

  saveAndReturn() {
    if (this.data.saving) return;
    const payload = this.data.pendingPayload;
    if (!payload) return;
    // 配置已回传并即将返回：递增 generation 让任何在途回调失效，避免返回过程里改写状态
    this.nextGeneration();
    // 首帧同步清空 pendingPayload 并置 saving，防止连按确认键重复保存
    this.setData({ saving: true, pendingPayload: null, message: '正在保存配置…' });
    // 配置通过页面间模块状态回传，避免把含 apikey 的 URL 放进页面 query
    setScanResult({ payload, persist: this.data.persist });
    wx.navigateBack({ delta: 1 });
  },

  cancelConfirm() {
    // 保存已经触发（配置已回传、页面正在返回）时不允许再撤销页面状态
    if (this.data.saving) return;
    this.nextGeneration();
    this.updateData({
      status: 'READY',
      message: '已取消保存',
      detail: '可重新扫描二维码，或按返回键退出',
      pendingPayload: null,
      persist: true,
      saving: false,
      warning: '',
    });
    this.assembler.reset();
  },

  showConfigError(error) {
    const message = error instanceof ConfigError ? error.message : error?.message || '无法解析二维码';
    this.assembler.reset();
    this.updateData({
      status: 'ERROR',
      message,
      detail: '请确认扫描的是本工具生成的二维码，按确认键重试',
      progress: '',
      isScanning: false,
      pendingPayload: null,
      warning: '',
    });
  },
};
</script>

<page>
  <view class="page">
    <view class="header">
      <text class="title">扫码授权企业微信 MCP</text>
      <text class="subtitle">{{message}}</text>
    </view>

    <camera class="camera-preview"></camera>

    <view class="confirm" ink:if="{{status === 'CONFIRM'}}">
      <text class="confirm-title">保存方式（方向键切换）</text>
      <text class="confirm-tools">可用工具 {{toolCount}} 个 · {{serverNames}}</text>
      <text class="confirm-warn" ink:if="{{warning}}">{{warning}}</text>
      <view class="option {{persist ? 'option-active' : ''}}">
        <text class="option-text">{{persist ? '●' : '○'}} 保存到本机（重启后仍可用）</text>
      </view>
      <view class="option {{persist ? '' : 'option-active'}}">
        <text class="option-text">{{persist ? '○' : '●'}} 仅本次会话（退出即失效）</text>
      </view>
      <text class="confirm-hint">确认键保存 · 返回键取消</text>
    </view>

    <view class="feedback">
      <text class="progress" ink:if="{{progress}}">进度 {{progress}}</text>
      <text class="detail" ink:if="{{detail}}">{{detail}}</text>
      <text class="detail" ink:if="{{status === 'CONFIRM'}}">保存后即用该配置连接企业微信</text>
      <text class="badge" ink:if="{{status === 'ERROR'}}">扫码失败</text>
    </view>
  </view>
</page>

<style>
  .page {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    box-sizing: border-box;
    background: #000000;
    color: #40ff5e;
  }

  .header {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }

  .title {
    font-size: 15px;
    font-weight: 500;
    color: #40ff5e;
  }

  .subtitle {
    font-size: 12px;
    color: rgba(64, 255, 94, 0.72);
    text-align: center;
  }

  .camera-preview {
    width: 100%;
    flex: 1;
    min-height: 140px;
    border: 1px solid rgba(64, 255, 94, 0.48);
    background: #000000;
  }

  .confirm {
    display: flex;
    flex-direction: column;
    gap: 3px;
    width: 100%;
    border: 1px solid rgba(64, 255, 94, 0.48);
    padding: 6px 8px;
    box-sizing: border-box;
  }

  .confirm-title {
    font-size: 11px;
    color: rgba(64, 255, 94, 0.48);
    letter-spacing: 0.06em;
  }

  .confirm-tools {
    font-size: 10px;
    color: rgba(64, 255, 94, 0.72);
    overflow: hidden;
  }

  .confirm-warn {
    font-size: 11px;
    line-height: 15px;
    color: rgba(64, 255, 94, 0.48);
    border-left: 2px solid rgba(64, 255, 94, 0.48);
    padding-left: 6px;
  }

  .option {
    padding: 1px 4px;
  }

  .option-active {
    background: rgba(64, 255, 94, 0.12);
    border-left: 2px solid #40ff5e;
  }

  .option-text {
    font-size: 12px;
    color: rgba(64, 255, 94, 0.72);
  }

  .confirm-hint {
    font-size: 10px;
    color: rgba(64, 255, 94, 0.48);
  }

  .feedback {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    min-height: 34px;
  }

  .progress {
    font-size: 12px;
    color: #40ff5e;
  }

  .detail {
    font-size: 11px;
    color: rgba(64, 255, 94, 0.48);
    text-align: center;
  }

  .badge {
    font-size: 11px;
    padding: 1px 6px;
    border: 1px solid rgba(64, 255, 94, 0.72);
    color: #40ff5e;
  }
</style>
