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

import { CAPABILITIES } from '../app/libs/wecom-mcp.js';

const CAPABILITY_IDS = CAPABILITIES.map((capability) => capability.id);
const DEFAULT_NAMES = CAPABILITIES.map((capability) => capability.name);

/** 生成最多 8 个连接（每个能力位一把 key；二维码里不保存名称，扫码后按能力位还原默认名称）。 */
function officialServers(count = 1, keyLength = 24) {
  if (count > CAPABILITY_IDS.length) throw new Error('能力位固定 8 个，最多 8 个连接');
  return Array.from({ length: count }, (_, index) => {
    const capability = CAPABILITY_IDS[index];
    // key 首字符按序号区分：避免所有 key 共享前缀，分片用例才测得到「大配置」
    const key = String(index).padStart(2, '0') + 'k'.repeat(keyLength);
    return {
      name: DEFAULT_NAMES[index],
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
  // 最常见路径：少量连接时生成单张二维码，扫一次就要能用（分片分支不能取代它）。
  const servers = officialServers(2);
  const payloadText = serializePayload(buildPayload(servers));
  const parsed = parseScannedText(payloadText);
  assert.equal(parsed.kind, 'payload');
  const validated = validatePayload(parsed.payload);
  assert.equal(validated.servers.length, 2);
  // 名称与 URL 由内置能力位表还原
  assert.deepEqual(
    validated.servers.map((server) => server.name),
    ['企业微信消息', '企业微信文档'],
  );
  assert.deepEqual(
    validated.servers.map((server) => server.url),
    servers.map((server) => server.url),
  );
});

test('8 个能力位的长 key 配置可分片乱序重组并通过眼镜端校验', () => {
  const servers = officialServers(8, 300);
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
  const validated = validatePayload(parseScannedText(outcome.text).payload);
  assert.equal(validated.servers.length, 8);
  assert.deepEqual(
    validated.servers.map((server) => server.url),
    servers.map((server) => server.url),
  );
});

test('v4 紧凑载荷只存能力位与 key，扫码后按内置映射还原名称与地址', () => {
  // 8 个能力位的 name/url 映射固化在 app/libs/wecom-mcp.js，二维码只保存「哪些能力位在用 +
  // 每把 API Key」；两端必须用同一份映射，名字/地址才不会对不上。
  const shared = `FAKE-shared-prefix-${'X'.repeat(50)}`;
  const servers = CAPABILITY_IDS.map((capability, index) => ({
    // 自定义名称（mail 改个名）不会写入二维码，扫码后按能力位显示默认名称
    name: index === 6 ? '企业微信邮箱' : DEFAULT_NAMES[index],
    url: `https://qyapi.weixin.qq.com/mcp/v2/bot/${capability}?apikey=${shared}${String(index).padStart(2, '0')}${'ta'.repeat(10)}`,
  }));

  const payload = validatePayload(buildPayload(servers));
  const text = serializePayload(payload);
  // 分片往返：故意用较小的每张容量
  const chunks = splitIntoChunks(text, { maxChars: 200, maxBytes: QR_BYTE_CAPACITY });
  assert.ok(chunks.length > 1, '样本应被切成多张，覆盖分片重组');
  const assembler = createChunkAssembler();
  let outcome;
  for (const chunk of chunks) {
    const parsed = parseScannedText(chunk);
    assert.equal(parsed.kind, 'chunk');
    outcome = assembler.add(parsed.chunk, parsed.data, parsed.checksum);
  }
  assert.equal(outcome.status, 'complete');

  const scanned = parseScannedText(outcome.text);
  assert.equal(scanned.kind, 'payload');
  const decoded = validatePayload(scanned.payload);
  assert.deepEqual(decoded.servers.map((server) => server.url), servers.map((server) => server.url));
  // 自定义名称不写入二维码，扫码后显示对应的默认名称。
  assert.equal(decoded.servers.find((server) => server.url.includes('/bot/mail?'))?.name, '企业微信邮件');

  // 只支持内置的 8 个官方能力位：自定义路径/未知能力位无法编码
  assert.throws(
    () => serializePayload(validatePayload(buildPayload([{ name: '自建', url: 'https://qyapi.weixin.qq.com/custom/path?apikey=k' }]))),
    (error) => error.code === 'UNSUPPORTED_SERVER_URL',
  );
  assert.throws(
    () => serializePayload(validatePayload(buildPayload([{ name: '未知', url: 'https://qyapi.weixin.qq.com/mcp/v2/bot/ticket?apikey=k' }]))),
    (error) => error.code === 'UNSUPPORTED_SERVER_URL',
  );

  // 同一能力位只能配一把 key（二维码按能力位存储）
  assert.throws(
    () =>
      validatePayload(
        buildPayload([
          { name: '消息A', url: 'https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=aaa' },
          { name: '消息B', url: 'https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=bbb' },
        ]),
      ),
    (error) => error.code === 'DUPLICATE_CAPABILITY',
  );

  // 残缺/非法载荷必须报配置错误，不能拿半份配置去连接（也不能抛原生 TypeError）
  assert.throws(() => parseScannedText('RWA4'), (error) => error.code === 'INVALID_PAYLOAD');
  assert.throws(
    () => parseScannedText(`${text.slice(0, 20)}_`),
    (error) => error.code === 'INVALID_PAYLOAD',
    '含 base44 字符集外的字符必须被拒绝',
  );
  assert.throws(
    () => parseScannedText(JSON.stringify({ type: 'rokid-wecom-assistant', version: 4 })),
    (error) => error.code === 'INVALID_PAYLOAD',
    'JSON 但缺少分片信息必须拒绝',
  );
});

test('扫码分片字段严格校验：非法序号与非字符串内容必须拒绝', () => {
  // 摄像头扫到的内容是外部入口：非整数序号（"1x"/1.5）若被 parseInt 截断，
  // 会悄悄覆盖别的分片，最终 CRC 校验失败时才报错，用户只能重扫全部。
  const makeScanned = (chunk, data = '{"type":"rokid-wecom-assistant","version":4}') =>
    JSON.stringify({ type: 'rokid-wecom-assistant', version: 4, chunk, checksum: 'deadbeef', data });

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
