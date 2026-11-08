// 二维码内容是「外部输入」（摄像头扫到的任意字符串），终端工具和眼镜端必须对同一格式
// 有一致的安全边界；内容过长时还要能分片重组。这些是用户真会遇到、且出错代价很高的路径。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPayload,
  serializePayload,
  splitIntoChunks,
  parseScannedText,
  createChunkAssembler,
  validatePayload,
  maskUrl,
  redactText,
  QR_BYTE_CAPACITY,
} from '../app/libs/qr-payload.js';

const APIKEY = 'apikey-secret-123456';
const OFFICIAL_URL = `https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=${APIKEY}`;

function officialServers(count = 1, keyLength = 24) {
  const capabilities = ['msg', 'doc', 'schedule', 'todo', 'meeting', 'contact', 'mail', 'disk'];
  return Array.from({ length: count }, (_, index) => {
    const capability = capabilities[index % capabilities.length];
    const key = 'k'.repeat(keyLength) + String(index);
    return {
      name: `企业微信-${capability}-${index}`,
      url: `https://qyapi.weixin.qq.com/mcp/v2/bot/${capability}?apikey=${key}`,
    };
  });
}

test('非官方地址一律拒绝：http、非企微域名、缺少 apikey', () => {
  const base = buildPayload(officialServers(1));

  assert.throws(
    () => validatePayload({ ...base, servers: [{ name: '消息', url: OFFICIAL_URL.replace('https:', 'http:') }] }),
    (error) => error.code === 'INSECURE_URL',
  );
  assert.throws(
    () => validatePayload({ ...base, servers: [{ name: '消息', url: 'https://evil.example.com/mcp/v2/bot/msg?apikey=x' }] }),
    (error) => error.code === 'UNTRUSTED_HOST',
  );
  // 缺 apikey 的拒绝必须覆盖所有官方能力位（不只是 msg），否则文档/日程等连接会带着空 key 保存。
  for (const capability of ['msg', 'doc', 'schedule', 'todo']) {
    assert.throws(
      () =>
        validatePayload({
          ...base,
          servers: [{ name: capability, url: `https://qyapi.weixin.qq.com/mcp/v2/bot/${capability}` }],
        }),
      (error) => error.code === 'MISSING_API_KEY',
      `${capability} 能力位缺少 apikey 必须拒绝`,
    );
  }
});

test('单张二维码即可承载的配置，扫码后直接解析为配置对象', () => {
  // 最常见路径：1~2 个连接时生成单张二维码，扫一次就要能用（分片分支不能取代它）。
  const servers = officialServers(2);
  const payloadText = serializePayload(buildPayload(servers));
  const parsed = parseScannedText(payloadText);
  assert.equal(parsed.kind, 'payload');
  const validated = validatePayload(parsed.payload);
  assert.equal(validated.servers.length, 2);
  assert.deepEqual(
    validated.servers.map((server) => server.name),
    servers.map((server) => server.name),
  );
  assert.equal(validated.servers[0].url, servers[0].url);
});

test('32 个 MCP 连接的大型配置可分片乱序重组并通过眼镜端校验', () => {
  const servers = officialServers(32, 1300);
  const payloadText = serializePayload(buildPayload(servers));
  assert.ok(payloadText.length > 900, '样本必须真的超过单张二维码容量');

  const chunks = splitIntoChunks(payloadText, { maxChars: 900 });
  assert.ok(chunks.length > 1, '应当被切成多张二维码');

  // 真实扫描顺序不可控：用户可能先扫错顺序、甚至重复扫同一张
  const assembler = createChunkAssembler();
  const order = [...chunks.keys()].reverse();
  let outcome;
  for (const index of order) {
    const parsed = parseScannedText(chunks[index]);
    assert.equal(parsed.kind, 'chunk');
    outcome = assembler.add(parsed.chunk, parsed.data, parsed.checksum);
    // 用户可能对同一张二维码重复拍照：重复分片不能打断收集
    if (index === order[0]) {
      const duplicate = assembler.add(parsed.chunk, parsed.data, parsed.checksum);
      assert.equal(duplicate.status, 'pending');
    }
  }

  assert.equal(outcome.status, 'complete');
  assert.equal(outcome.text, payloadText, '重组结果必须与原始配置逐字一致');
  const validated = validatePayload(JSON.parse(outcome.text));
  assert.equal(validated.servers.length, 32);
});

test('按字节上限分片：32 个长中文名配置的每一张二维码都不超出真实容量', () => {
  // 二维码真实容量按 UTF-8 字节算（中文 3 字节/字），只按字符数分片会让
  // 「字符数没超、字节超标」的配置生成失败，用户无法完成授权。
  const longName = '企业微信消息能力位配置名称说明文字补充内容占位扩展字段'.repeat(2);
  const servers = Array.from({ length: 32 }, (_, index) => ({
    name: `${longName.slice(0, 38)}${String(index).padStart(2, '0')}`,
    url: `https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=${'k'.repeat(12)}${String(index).padStart(2, '0')}`,
  }));
  const payloadText = serializePayload(buildPayload(servers));
  const encoder = new TextEncoder();
  assert.ok(encoder.encode(payloadText).length > QR_BYTE_CAPACITY, '样本必须真的超过单张二维码的字节容量');

  const chunks = splitIntoChunks(payloadText, { maxChars: 2000, maxBytes: QR_BYTE_CAPACITY });
  assert.ok(chunks.length > 1, '应当被切成多张二维码');
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 2000, `分片字符数超限：${chunk.length}`);
    const bytes = encoder.encode(chunk).length;
    assert.ok(bytes <= QR_BYTE_CAPACITY, `分片 ${bytes} 字节，超过二维码容量 ${QR_BYTE_CAPACITY} 字节`);
  }

  // 真实扫描顺序不可控：乱序扫完必须能重组并通过眼镜端校验
  const assembler = createChunkAssembler();
  let outcome;
  for (const index of [...chunks.keys()].reverse()) {
    const parsed = parseScannedText(chunks[index]);
    assert.equal(parsed.kind, 'chunk');
    outcome = assembler.add(parsed.chunk, parsed.data, parsed.checksum);
  }
  assert.equal(outcome.status, 'complete');
  assert.equal(outcome.text, payloadText, '重组结果必须与原始配置逐字一致');
  assert.equal(validatePayload(JSON.parse(outcome.text)).servers.length, 32);
});

test('扫码分片字段严格校验：非法序号与非字符串内容必须拒绝', () => {
  // 摄像头扫到的内容是外部入口：非整数序号（"1x"/1.5）若被 parseInt 截断，
  // 会悄悄覆盖别的分片，最终 CRC 校验失败时才报错，用户只能重扫全部。
  const makeScanned = (chunk, data = '{"type":"rokid-wecom-mcp","version":1,"servers":[]}') =>
    JSON.stringify({ type: 'rokid-wecom-mcp', version: 1, chunk, checksum: 'deadbeef', data });

  const invalidChunks = [
    ['序号不是整数："1x"', { id: 'abcdef12', index: '1x', total: 3 }],
    ['序号是小数：1.5', { id: 'abcdef12', index: 1.5, total: 3 }],
  ];
  for (const [label, chunk] of invalidChunks) {
    assert.throws(() => parseScannedText(makeScanned(chunk)), (error) => error.code === 'INVALID_CHUNK', label);
  }
  assert.throws(
    () => parseScannedText(makeScanned({ id: 'abcdef12', index: 0, total: 2 }, 123)),
    (error) => error.code === 'INVALID_CHUNK',
    'data 非字符串时必须在解析阶段拒绝',
  );
});

test('展示与日志中不得出现完整 API Key', () => {
  const masked = maskUrl(OFFICIAL_URL);
  assert.ok(!masked.includes(APIKEY), `界面展示泄露了 key：${masked}`);
  assert.ok(masked.includes('qyapi.weixin.qq.com'));

  const logLine = redactText(`connect failed url=${OFFICIAL_URL}`);
  assert.ok(!logLine.includes(APIKEY), `日志泄露了 key：${logLine}`);
});

test('日志脱敏覆盖 JSON、全角标点、斜线/连字符与转义形态，且不误擦普通单词', () => {
  // 错误对象常被 JSON.stringify 后写日志；中文输入法还会产生全角冒号。
  // 任何形态只要漏一个，key 就会完整落进日志。
  const json = redactText(JSON.stringify({ apikey: 'json-secret-abcdef', user: '张三' }));
  assert.ok(!json.includes('json-secret-abcdef'), `JSON 形态泄露：${json}`);
  assert.ok(json.includes('****cdef'), `JSON 形态应保留末 4 位：${json}`);

  const fullWidth = redactText('失败：apikey：fullwidth-key-abcdef');
  assert.ok(!fullWidth.includes('fullwidth-key-abcdef'), `全角冒号形态泄露：${fullWidth}`);

  const punctuation = redactText('错误，apikey=punctuation-key-123456，请检查');
  assert.ok(!punctuation.includes('punctuation-key-123456'), `中文标点边界泄露：${punctuation}`);

  const slashed = redactText('请求 https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=abc/def-ghi-jkl 失败');
  assert.ok(!slashed.includes('abc/def-ghi-jkl'), `含斜线/连字符的值泄露：${slashed}`);

  const escapedInput = JSON.stringify({ apikey: 'esc/secret-\\value' });
  const escaped = redactText(escapedInput);
  assert.ok(!escaped.includes('esc/secret'), `JSON 反斜杠转义形态泄露：${escaped}`);

  // 前缀必须按单词边界判断，不能把普通单词里的 key 当密钥
  assert.equal(redactText('monkey=banana'), 'monkey=banana');
});
