# Rokid 企业微信助手

## Identity
- **Name**: Rokid 企业微信助手
- **Version**: 1.0.0
- **Description**: 运行在乐奇 Rokid AI 眼镜上的 AIUI 应用，通过 MCP SDK v2 直接连接企业微信官方远程 MCP（Streamable HTTP），支持语音查询与写操作确认。

## Capabilities
- **Permissions**:
  - `CAMERA`：首次启动扫描终端生成的配置二维码
  - `RECORD_AUDIO`：语音识别
- **Skills**:
  - 企业微信消息 / 日程 / 待办 / 文档 / 会议 / 通讯录 / 邮件 / 微盘（以 `tools/list` 返回为准）
  - 语音识别（SpeechRecognition）与语音播报（SpeechSynthesis）
  - LanguageModel 工具选择（不可用时降级为关键词规则）

## Pages
- `pages/index/index`：主界面（状态、语音提问、结果展示、写操作确认、菜单）
- `pages/scan/index`：扫码授权（支持分片二维码连续扫描）
- `pages/tools/index`：查看当前可用的 MCP 工具

## Privacy
- MCP URL 与 API Key 仅保存在本机 Agent 隔离存储中；该存储不是系统级安全存储。
- 日志与界面展示均对 URL/API Key 脱敏，不上报任何第三方服务。
- 授权是否仍有效以企业微信 MCP 服务端实际调用结果为准，不按本地保存时间估算期限。
