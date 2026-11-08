// 配置存储的关键业务承诺：持久化配置必须真的写进 AIUI Storage 并能跨进程读回；
// 「仅本次会话」模式绝不能落盘、且必须清除此前持久化的旧凭据（否则重启后旧 Key 复活）；
// Storage 里的数据可能因升级或写坏而非法，读取时必须安全降级而不是把启动流程抛崩。
//
// AIUI 运行时才提供 wx，这里用假的 wx Storage（只实现契约里的三个同步接口）
// + 真实的 createWxStorage 适配器，走与真机一致的存取路径。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigStore, STORAGE_KEY, createWxStorage } from '../app/libs/config-store.js';

const CONFIG = {
  servers: [{ name: '企业微信消息', url: 'https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=apikey-12345678' }],
};
const SESSION_CONFIG = {
  servers: [{ name: '企业微信文档', url: 'https://qyapi.weixin.qq.com/mcp/v2/bot/doc?apikey=session-key-1234' }],
};

/**
 * 假 wx Storage：与 AIUI 一致，存进去的值会被序列化，读不到时返回 ''。
 * remove 可模拟真机存储失败：抛错（removeThrows）或静默不删（removeNoop）。
 * @param {{removeThrows?: boolean, removeNoop?: boolean}} [options]
 * @returns {{ wx: {getStorageSync: Function, setStorageSync: Function, removeStorageSync: Function}, dump: () => Record<string, unknown> }}
 */
function createFakeWx(options = {}) {
  const data = new Map();
  return {
    wx: {
      getStorageSync: (key) => (data.has(key) ? JSON.parse(data.get(key)) : ''),
      setStorageSync: (key, value) => {
        data.set(key, JSON.stringify(value));
      },
      removeStorageSync: (key) => {
        if (options.removeThrows) throw new Error('storage remove failed');
        if (options.removeNoop) return;
        data.delete(key);
      },
    },
    dump: () => Object.fromEntries([...data].map(([key, value]) => [key, JSON.parse(value)])),
  };
}

test('持久化保存后，新实例（模拟重启）能从 Storage 读回配置', () => {
  const fake = createFakeWx();
  const saved = new ConfigStore({ storage: createWxStorage(fake.wx) }).save(CONFIG);
  assert.equal(saved.mode, 'persistent');
  assert.deepEqual(fake.dump()[STORAGE_KEY]?.servers, CONFIG.servers, '必须真正写入 AIUI Storage');

  const restarted = new ConfigStore({ storage: createWxStorage(fake.wx) });
  const loaded = restarted.load();
  assert.equal(loaded?.mode, 'persistent');
  assert.equal(loaded?.servers.length, 1);
  assert.equal(loaded?.servers[0].url, CONFIG.servers[0].url);
});

test('仅本次会话模式不落盘，并清除此前持久化的旧凭据', () => {
  const fake = createFakeWx();
  const store = new ConfigStore({ storage: createWxStorage(fake.wx) });
  store.save(CONFIG);

  const saved = store.save(SESSION_CONFIG, { persist: false });
  assert.equal(saved.mode, 'session');
  assert.deepEqual(fake.dump(), {}, '会话模式不得落盘，且必须清掉之前的持久化配置');
  assert.equal(store.load()?.servers[0].name, '企业微信文档', '当前会话内仍然可用');

  const restarted = new ConfigStore({ storage: createWxStorage(fake.wx) });
  assert.equal(restarted.load(), null, '重启后不得复活旧凭据');
});

test('Storage 里是损坏/非法配置时，load 返回 null 而不是抛异常', () => {
  // 三类损坏来源：整体不是对象、servers 结构不对、单个配置项过不了 validateServer。
  const corrupted = [
    ['整体不是配置对象', 'not-a-config'],
    ['servers 不是数组', { version: 1, savedAt: 1, servers: 'broken' }],
    ['配置项缺少 URL', { version: 1, savedAt: 1, servers: [{ name: '坏配置' }] }],
  ];

  for (const [label, raw] of corrupted) {
    const fake = createFakeWx();
    fake.wx.setStorageSync(STORAGE_KEY, raw);
    const store = new ConfigStore({ storage: createWxStorage(fake.wx) });
    assert.equal(store.load(), null, label);
  }
});

test('删除配置后，新实例读不到（凭据真正清除）', () => {
  const fake = createFakeWx();
  const store = new ConfigStore({ storage: createWxStorage(fake.wx) });
  store.save(CONFIG);
  store.clear();
  assert.deepEqual(fake.dump(), {}, 'Storage 中不得残留配置');
  assert.equal(new ConfigStore({ storage: createWxStorage(fake.wx) }).load(), null);
});

test('存储删除失败时必须 fail-closed：不返回成功、也不谎报旧凭据已清除', () => {
  for (const [label, options] of [
    ['remove 抛错', { removeThrows: true }],
    ['remove 静默失败', { removeNoop: true }],
  ]) {
    const fake = createFakeWx(options);
    const store = new ConfigStore({ storage: createWxStorage(fake.wx) });
    store.save(CONFIG);

    // 切到「仅本次会话」时删不掉旧持久化配置：必须抛错，不能改用会话模式让旧 Key 留在本机。
    assert.throws(
      () => store.save(SESSION_CONFIG, { persist: false }),
      (error) => error.code === 'SESSION_CLEANUP_FAILED',
      `${label}：会话模式保存必须失败`,
    );
    assert.equal(
      new ConfigStore({ storage: createWxStorage(fake.wx) }).load()?.servers[0].name,
      '企业微信消息',
      `${label}：旧持久化配置仍在（未谎报已切换）`,
    );

    // 删除配置失败：必须抛错，页面才能显示「删除失败」而不是「已删除」。
    assert.throws(
      () => store.clear(),
      (error) => error.code === 'CLEANUP_FAILED',
      `${label}：删除必须失败`,
    );
    assert.equal(
      new ConfigStore({ storage: createWxStorage(fake.wx) }).load()?.servers[0].name,
      '企业微信消息',
      `${label}：旧凭据不得被假装清除`,
    );
  }
});
