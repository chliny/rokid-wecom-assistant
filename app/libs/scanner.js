// 摄像头拍照 + 二维码识别（识别输入优先走 Blob，纯 JS 解码只作兜底）。
//
// 运行时差异（见 references/apis/canvas.md、media.md）：
//   - `BarcodeDetector.detect()` 接受 ImageData / Blob / ImageBitmap，或
//     「{data, width, height}」这种 legacy raw 对象；
//   - 现行 AIUI 运行时都有 `Blob`，官方推荐把拍照结果包成 Blob 直接交给 BarcodeDetector
//     （由平台原生解码）。纯 JS 解码一整帧非常慢（实测 4.06MP 约 38 秒），因此只在
//     没有 Blob 的老运行时上才用它兜底；
//   - 兜底用的 vendored webpjs 只支持有损 VP8 帧：带透明通道的 VP8X+ALPH 与无损 VP8L
//     会解码失败（继承官方 sample 的限制；拍照得到的照片是无损/透明格式时会报
//     「二维码图片解码失败」，此时应提示更换设备或改用终端配置）。
import { decodeWebP } from './webp.js';

/**
 * 创建 BarcodeDetector（优先限定 qr_code 格式）。
 * @returns {Promise<any>}
 */
export async function createQrDetector() {
  let DetectorCtor = globalThis.BarcodeDetector;
  if (!DetectorCtor) {
    try {
      const module = await import('barcode');
      DetectorCtor = module?.default ?? module?.BarcodeDetector;
    } catch {
      DetectorCtor = undefined;
    }
  }
  if (typeof DetectorCtor !== 'function') {
    throw new Error('当前设备不支持二维码识别（BarcodeDetector 不可用）');
  }

  let formats;
  try {
    const supported = await DetectorCtor.getSupportedFormats?.();
    if (Array.isArray(supported) && supported.length > 0) {
      if (!supported.includes('qr_code')) {
        throw new Error('当前设备的二维码识别能力不可用');
      }
      formats = ['qr_code'];
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('二维码识别能力')) throw error;
    // getSupportedFormats 不可用：用运行时默认格式集
  }
  return formats ? new DetectorCtor({ formats }) : new DetectorCtor();
}

/**
 * 把 wx 拍照结果转成 BarcodeDetector.detect 可接受的输入。
 *
 * 优先 Blob 直传（官方推荐路径，由平台解码）；只有运行时没有 Blob 时才用纯 JS 解码兜底。
 * @param {{data: ArrayBuffer|Uint8Array, mimeType?: string}} photo
 * @returns {Promise<Blob | {data: Uint8Array, width: number, height: number}>}
 */
export async function photoToBarcodeInput(photo) {
  if (!photo || !photo.data) throw new Error('摄像头没有返回图像数据');
  const mimeType = String(photo.mimeType || '').toLowerCase();

  if (typeof Blob === 'function') {
    // 现行 AIUI 契约支持把 Blob 直接交给 BarcodeDetector.detect；
    // 不要在这里先解码：纯 JS 解码一帧 4MP WebP 需要数十秒。
    return new Blob([photo.data], { type: photo.mimeType || 'image/jpeg' });
  }

  if (mimeType.includes('webp')) {
    // 兜底：无 Blob / ImageData 的运行时，用纯 JS 解码成灰度像素。
    // 限制：webpjs 只支持有损 VP8（VP8X+ALPH、VP8L 会抛 bitstream-error）。
    const decoded = await decodeWebP(photo.data, { output: 'gray' });
    if (!decoded || !decoded.width || !decoded.height) throw new Error('二维码图片解码失败');
    return { data: decoded.gray, width: decoded.width, height: decoded.height };
  }

  throw new Error(`当前运行时无法处理 ${mimeType || '未知'} 格式的拍摄结果`);
}

/**
 * 给可能永不返回的异步操作加超时，避免页面一直停在「正在识别…」。
 * 注意：同步的纯 JS 解码会阻塞事件循环，定时器只在解码结束后才可能触发，
 * 因此这里只兜「摄像头 / 识别器卡住」，不会误杀慢但正常的解码。
 * @param {Promise<any> | any} promise
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<any>}
 */
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

/**
 * @type {Promise<void> | null}
 * 摄像头门禁：AIUI 的 `CameraContext.takePhoto()` 与 `BarcodeDetector.detect()` 都没有
 * AbortSignal / cancel 入参，超时只能让调用方先返回，底层操作仍在跑。若马上重试就会
 * 出现「两次拍照/识别并发占用摄像头」——硬件资源可能泄漏或互相干扰。
 * 因此这里记录「底层操作真正 settle」的 promise：只要它还挂着，新的 scanOnce 要么等它
 * 归还（busyWaitMs 内），要么明确告诉用户摄像头仍被占用，绝不硬闯。
 *
 * 门禁是模块级的，**跨页面会话保持**：扫码页 onHide/onUnload 只是丢弃 cameraContext，
 * 并没有取消旧的硬件操作，所以新 context 不等于安全；只有旧操作真正 settle 才释放。
 * 若底层永不返回，只能由用户退出应用 / 重启设备来释放摄像头——页面会明确这样提示，
 * 不能声称「重新进入扫码页就能恢复」。
 */
let activeCapture = null;

/**
 * 拍照并识别二维码。
 *
 * 超时语义：超时只让本次调用（页面）尽快恢复，底层 takePhoto/detect 无法取消；
 * 门禁会一直等到它们真正 settle，保证不会出现新的拍照与旧操作并发。
 *
 * @param {{cameraContext: any, detector: any, photoTimeoutMs?: number, detectTimeoutMs?: number, busyWaitMs?: number}} deps
 * @returns {Promise<{rawValue: string, format: string} | null>} 未识别到时返回 null
 */
export async function scanOnce(deps) {
  if (activeCapture) {
    // 等上一次底层操作归还（例如超时后它其实几百毫秒就结束了）；超时则明确报占用，
    // 页面仍是可操作的 ERROR 状态（可重试/按返回键退出），不会永久卡在「正在识别」。
    try {
      await withTimeout(activeCapture, deps.busyWaitMs ?? 5000, 'capture-busy');
    } catch {
      // 仍在占用，走下面的明确报错
    }
    if (activeCapture) {
      /** @type {Error & {busy?: boolean}} */
      const error = new Error(
        '上一次拍照/识别仍未结束（摄像头被占用），请稍后按确认键重试；若长时间无响应，请退出应用或重启设备后再试',
      );
      error.busy = true;
      throw error;
    }
  }

  /** @type {Promise<any>[]} 底层真实操作：门禁要等它们真正结束，而不是本次调用超时返回 */
  const underlying = [];
  /** @param {Promise<any>} promise */
  const track = (promise) => {
    underlying.push(promise);
    return promise;
  };

  const run = async () => {
    // wide 模式是 BarcodeDetector 文档推荐的扫码尺寸（2016×2688），
    // 默认模式 3024×4032 像素更多、识别更慢。
    const photoPromise = track(
      Promise.resolve().then(() => deps.cameraContext.takePhoto({ quality: 'high', mode: 'wide' })),
    );
    const photo = await withTimeout(
      photoPromise,
      deps.photoTimeoutMs ?? 15000,
      '拍照超时（摄像头可能被占用或响应过慢），请重试',
    );
    const input = await photoToBarcodeInput(photo);
    const detectPromise = track(Promise.resolve().then(() => deps.detector.detect(input)));
    const results = await withTimeout(detectPromise, deps.detectTimeoutMs ?? 20000, '二维码识别超时，请重试');
    if (!Array.isArray(results) || results.length === 0) return null;
    const qr = results.find((item) => item?.format === 'qr_code' && item?.rawValue) ?? results[0];
    const rawValue = String(qr?.rawValue ?? '').trim();
    if (!rawValue) return null;
    return { rawValue, format: String(qr?.format ?? '') };
  };

  const work = run();
  const gate = work
    .catch(() => {
      // 超时/失败已经交给调用方，这里只为接住 rejection，避免未处理拒绝
    })
    .then(() => Promise.allSettled(underlying))
    .then(() => {
      if (activeCapture === gate) activeCapture = null;
    });
  activeCapture = gate;
  return work;
}
