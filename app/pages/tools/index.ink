<script type="application/json" def>
{
  "navigationBarTitleText": "可用工具",
  "description": "显示当前企业微信 MCP 提供的全部工具，并标注哪些是写操作。"
}
</script>

<script setup>
import wx from 'wx';
import { getServers, describeConfig } from '../../libs/session.js';

export default {
  data: {
    groups: [],
    total: 0,
    scrollTop: 0,
    statusText: '',
    empty: true,
  },

  onLoad() {
    this.refresh();
  },

  onShow() {
    // 连接可能在页面打开后才完成（首屏先到了 connecting 状态），回到前台时刷新一次
    this.refresh();
    this.bindServers();
  },

  onHide() {
    this.unbindServers();
  },

  onUnload() {
    this.unbindServers();
  },

  /** 订阅连接状态：工具清单在页面打开期间变化（tools-changed）时自动刷新。 */
  bindServers() {
    this.unbindServers();
    const servers = getServers();
    if (!servers?.onStateChange) return;
    this.unsubscribeServers = servers.onStateChange((event) => {
      const type = event?.type;
      if (
        type === 'tools-changed' ||
        type === 'ready' ||
        type === 'error' ||
        type === 'disconnected' ||
        type === 'closed' ||
        type === 'transport-error'
      ) {
        this.refresh();
      }
    });
  },

  unbindServers() {
    this.unsubscribeServers?.();
    this.unsubscribeServers = null;
  },

  onKeyDown(event) {
    const code = event?.code;
    if (code === 'Backspace') {
      wx.navigateBack({ delta: 1 });
      return;
    }
    if (code === 'ArrowUp') this.setData({ scrollTop: Math.max(0, this.data.scrollTop - 56) });
    if (code === 'ArrowDown') this.setData({ scrollTop: this.data.scrollTop + 56 });
  },

  onKeyUp(event) {
    if (['Backspace', 'ArrowUp', 'ArrowDown'].includes(event?.code)) event.preventDefault?.();
  },

  /** 手指/滚轮滚动后同步 scrollTop，避免方向键从旧位置起算。 */
  onBodyScroll(event) {
    const top = Number(event?.detail?.scrollTop);
    if (Number.isFinite(top)) this.setData({ scrollTop: Math.max(0, top) });
  },

  refresh() {
    const servers = getServers();
    const config = describeConfig();
    if (!servers || servers.connections.length === 0) {
      this.setData({ groups: [], total: 0, empty: true, statusText: '尚未配置企业微信 MCP' });
      return;
    }
    const allTools = servers.tools;
    const groups = servers.connections.map((connection, index) => ({
      name: connection.name,
      tools: allTools
        .filter((tool) => tool.serverIndex === index)
        .map((tool) => ({
          name: tool.name,
          label: tool.title || tool.description || tool.name,
          write: tool.write,
        })),
    }));
    const total = groups.reduce((sum, group) => sum + group.tools.length, 0);
    this.setData({
      groups,
      total,
      empty: total === 0,
      statusText: `${config.servers.length} 个 MCP · ${total} 个工具`,
    });
  },
};
</script>

<page>
  <view class="page">
    <view class="topbar">
      <text class="title">可用工具</text>
      <text class="status">{{statusText}}</text>
    </view>

    <scroll-view class="body" scroll-y="true" scroll-top="{{scrollTop}}" bindscroll="onBodyScroll">
      <view class="group" ink:for="{{groups}}" ink:for-item="group">
        <text class="group-name">{{group.name}}</text>
        <view class="tool" ink:for="{{group.tools}}" ink:for-item="tool">
          <text class="tool-badge">{{tool.write ? '写' : '读'}}</text>
          <text class="tool-name">{{tool.name}}</text>
          <text class="tool-label">{{tool.label}}</text>
        </view>
        <text class="empty-group" ink:if="{{group.tools.length === 0}}">未获取到工具（连接可能失败）</text>
      </view>
      <text class="hint-block" ink:if="{{empty}}">暂无可用工具。请返回后重新扫码授权，或稍后重试连接。</text>
    </scroll-view>

    <view class="footer">
      <text class="hint">返回键回到助手 · 方向键滚动</text>
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
    justify-content: space-between;
    align-items: baseline;
    border-bottom: 1px solid rgba(64, 255, 94, 0.24);
    padding-bottom: 6px;
  }

  .title {
    font-size: 15px;
    color: #40ff5e;
  }

  .status {
    font-size: 11px;
    color: rgba(64, 255, 94, 0.48);
  }

  .body {
    flex: 1;
    min-height: 0;
    margin-top: 6px;
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-bottom: 8px;
  }

  .group-name {
    font-size: 12px;
    color: rgba(64, 255, 94, 0.72);
    border-left: 2px solid rgba(64, 255, 94, 0.48);
    padding-left: 6px;
  }

  .tool {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 2px 0 2px 8px;
  }

  .tool-badge {
    font-size: 10px;
    color: rgba(64, 255, 94, 0.48);
  }

  .tool-name {
    font-size: 12px;
    color: #40ff5e;
  }

  .tool-label {
    font-size: 11px;
    color: rgba(64, 255, 94, 0.48);
    line-height: 15px;
  }

  .empty-group,
  .hint-block {
    font-size: 12px;
    color: rgba(64, 255, 94, 0.48);
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
