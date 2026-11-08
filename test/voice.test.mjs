// 语音录音的生命周期与隐私边界（无需真实麦克风：VoiceController 通过注入的
// globalObject/resolveCapability 解析 AIUI 运行时能力，这里用假的 SpeechRecognition
// 复刻宿主的 start/stop/abort 与事件回调，验证用户离开页面后绝不后台录音）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceController } from '../app/libs/voice.js';

/** 假语音能力：记录创建/开始/取消次数，支持宿主事件回调。 */
function createFakeSpeech() {
  const instances = [];
  class FakeRecognition {
    constructor() {
      this.startCalls = 0;
      this.abortCalls = 0;
      instances.push(this);
    }
    start() {
      this.startCalls += 1;
      this.started = true;
    }
    stop() {}
    abort() {
      this.abortCalls += 1;
    }
  }
  return { FakeRecognition, instances };
}

function createController(FakeRecognition, resolveCapability) {
  return new VoiceController({
    resolveCapability:
      resolveCapability ??
      (async (name) => {
        if (name === 'SpeechRecognition') return FakeRecognition;
        if (name === 'SpeechSynthesisUtterance') return class Utterance {};
        if (name === 'speechSynthesis') return { speak() {}, cancel() {} };
        return null;
      }),
  });
}

test('语音初始化期间取消后不得开始录音；旧会话的迟到事件不得污染新录音', async () => {
  // 场景 1（隐私）：用户按下说话后立刻离开页面，此时语音能力还在初始化。
  // abort 必须让这次 start 作废，初始化完成后绝不能创建识别实例/开始录音。
  const gated = createFakeSpeech();
  let releaseInit;
  const initGate = new Promise((resolve) => {
    releaseInit = resolve;
  });
  const pendingController = createController(
    gated.FakeRecognition,
    async (name) => {
      if (name === 'SpeechRecognition') {
        await initGate;
        return gated.FakeRecognition;
      }
      if (name === 'SpeechSynthesisUtterance') return class Utterance {};
      if (name === 'speechSynthesis') return { speak() {}, cancel() {} };
      return null;
    },
  );
  const pendingFinals = [];
  const started = pendingController.start({ onFinal: (text) => pendingFinals.push(text) });
  pendingController.abort();
  releaseInit();
  const result = await started;
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'cancelled');
  assert.equal(gated.instances.length, 0, '初始化期间取消后不得创建识别实例（后台录音）');
  assert.equal(pendingController.listening, false);
  assert.deepEqual(pendingFinals, []);

  // 场景 2：用户连续两次开始录音，旧识别实例的迟到结果/错误/结束事件
  // 不能进入新会话的回调，否则会把上一句内容当成本次输入或提前结束录音。
  const fake = createFakeSpeech();
  const controller = createController(fake.FakeRecognition);
  const firstFinals = [];
  const firstEnds = [];
  const first = await controller.start({
    onFinal: (text) => firstFinals.push(text),
    onEnd: () => firstEnds.push(true),
  });
  assert.equal(first.ok, true);
  assert.equal(fake.instances.length, 1);

  const secondFinals = [];
  const secondEnds = [];
  const second = await controller.start({
    onFinal: (text) => secondFinals.push(text),
    onEnd: () => secondEnds.push(true),
  });
  assert.equal(second.ok, true, '再次开始录音应成功');
  assert.equal(fake.instances.length, 2);
  assert.ok(fake.instances[0].abortCalls >= 1, '开始新录音必须先取消旧识别');

  /** @param {string} text */
  function finalEvent(text) {
    const result = [{ transcript: text }];
    result.isFinal = true;
    return { results: [result] };
  }
  const [oldRecognition] = fake.instances;
  oldRecognition.onresult?.(finalEvent('旧会话结果'));
  oldRecognition.onerror?.({ error: 'not-allowed' });
  oldRecognition.onend?.();
  assert.deepEqual(firstFinals, [], '旧会话结果不得进入上一轮回调');
  assert.deepEqual(firstEnds, [], '旧会话结束事件不得提前结束新录音');
  assert.equal(controller.listening, true, '旧会话 onend 不得把新录音标记为已停止');

  const newRecognition = fake.instances[1];
  newRecognition.onresult?.(finalEvent('新会话结果'));
  newRecognition.onend?.();
  assert.deepEqual(secondFinals, ['新会话结果']);
  assert.equal(secondEnds.length, 1);
  assert.equal(controller.listening, false);

  // 场景 3（隐私）：播报初始化还在 await 时用户离开页面调 stopSpeaking，
  // 初始化完成后绝不能把敏感内容在后台播出来；正常播报仍应入队。
  const spoken = [];
  let releaseSpeechInit;
  const speechGate = new Promise((resolve) => {
    releaseSpeechInit = resolve;
  });
  const speakController = new VoiceController({
    resolveCapability: async (name) => {
      if (name === 'SpeechRecognition') return null; // 播报不依赖识别
      if (name === 'speechSynthesis') {
        await speechGate;
        return { speak: (utterance) => spoken.push(utterance.text), cancel() {} };
      }
      if (name === 'SpeechSynthesisUtterance') {
        return class Utterance {
          constructor(text) {
            this.text = text;
          }
        };
      }
      return null;
    },
  });
  const speaking = speakController.speak('这是敏感内容，不应该在后台播报');
  speakController.stopSpeaking();
  releaseSpeechInit();
  assert.equal(await speaking, false, '初始化期间停止播报后 speak 必须返回 false');
  assert.deepEqual(spoken, [], '初始化期间停止播报后不得后台播报');

  assert.equal(await speakController.speak('正常播报'), true, '初始化完成后的正常播报应成功');
  assert.deepEqual(spoken, ['正常播报']);
});
