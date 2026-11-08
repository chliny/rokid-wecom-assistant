import { getLogger, initSession } from './libs/session.js';

export default {
  async onLaunch() {
    try {
      await initSession();
    } catch (error) {
      getLogger().error('Rokid 企业微信助手初始化失败', error?.message || error);
    }
  },

  onShow() {
    // 页面 onShow 会自行检查扫码结果，这里不需要额外逻辑
  },

  onHide() {
    // 保持 MCP 连接，避免回到前台重复 initialize（企业微信 MCP 无会话，重连成本较高）
  },

  onError(message) {
    // 走统一日志器输出，确保错误里的 URL / API Key 被脱敏
    getLogger().error('运行出错', String(message ?? ''));
  },
};
