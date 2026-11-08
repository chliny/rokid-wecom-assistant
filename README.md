# Rokid 企业微信助手

在乐奇 Rokid AI 眼镜上用**语音**查询与操作企业微信 —— 不用掏手机，看一眼、说一句话就行。

- 眼镜端：AIUI 应用（JavaScript / `.ink`），**直接**通过 MCP SDK v2（`@modelcontextprotocol/client`）以 Streamable HTTP 连接企业微信官方远程 MCP。
- 电脑端：一个终端脚本 `tools/wecom-mcp-qr.mjs`，交互输入 MCP URL / API Key，在终端生成可被眼镜扫描的二维码。

支持的能力位（以企业微信实际授权为准）：消息、文档 / 表格 / 智能表格 / 智能文档、日程、待办、会议、通讯录、邮件、微盘。

> 界面在 AIUI 官方预览运行时（`aix preview` + ink-web，480×352 参考画布）验证；截图与验证记录只在本地留存，不随仓库提交。

## 架构

```text
┌──────────────────────── 乐奇 Rokid AI 眼镜 ────────────────────────┐
│  AIUI 应用 (app/)                                                 │
│                                                                   │
│  pages/index  ──助手状态机──▶ libs/assistant.js                   │
│        │                        │  ┌─ LanguageModel 选工具         │
│        │                        │  └─ 关键词规则兜底（无 AI 时）   │
│        │                        ▼                                  │
│        │                 libs/mcp-servers.js                      │
│        │                        │                                 │
│        │                 libs/mcp-client.js  ← esbuild 预打包的    │
│        │                        │             MCP SDK v2          │
│        ▼                        ▼                                 │
│  pages/scan ── BarcodeDetector ── 配置校验 / 分片重组              │
│        │                                                          │
│  libs/voice.js  SpeechRecognition + SpeechSynthesis               │
└────────────────────────────────┬──────────────────────────────────┘
                                 │ HTTPS（Streamable HTTP, POST）
                                 ▼
                  企业微信官方远程 MCP（无状态）
          https://qyapi.weixin.qq.com/mcp/v2/bot/<能力位>?apikey=***

   电脑端：tools/wecom-mcp-qr.mjs ── 终端二维码 ──▶ 眼镜摄像头扫码
```

## 目录

```text
app/                       AIUI 应用（aix pack 的输入目录）
  app.json                页面、权限（CAMERA / RECORD_AUDIO）
  app.js                  启动时初始化会话
  AGENTS.md               AIUI 智能体描述：身份、能力与行为边界
  pages/index/index.ink   主界面：状态、语音、结果、写操作确认、菜单
  pages/scan/index.ink    扫码授权：拍照、识别、分片重组、校验、连接验证
  pages/tools/index.ink   工具列表（读/写标记、所属 MCP）
  libs/mcp-client.js      预打包的 MCP SDK v2（自动生成，勿手改）
  libs/mcp-servers.js     MCP 连接管理、错误分类、授权探测、写操作判定
  libs/assistant.js       语音指令 → 工具选择 → 执行/确认 → 结果播报
  libs/qr-payload.js      二维码配置协议：校验、分片、重组、脱敏
  libs/config-store.js    配置存储（持久化 / 仅本次会话）
  libs/voice.js           SpeechRecognition / SpeechSynthesis 封装
  libs/scanner.js         拍照 + BarcodeDetector（WebP 兼容）
  libs/format.js          结果 → 小屏文本 / 语音播报文本
  libs/intent.js          工具选择与参数推断（纯函数）
  libs/log.js             脱敏日志
tools/
  wecom-mcp-qr.mjs        终端二维码配置工具
  build-libs.mjs          重新生成 libs/mcp-client.js
  dev/                    无真机时的 UI 渲染验证脚本
test/                     端到端测试
```

## 快速开始

### 0. 前置条件

- Node.js ≥ 20（终端工具与构建脚本）
- 乐奇 Rokid AI 眼镜（真机），或先在本机用 `aix preview` 预览界面
- 企业微信智能机器人后台已开启 MCP，并拿到 MCP URL 与 API Key
  （URL 形态：`https://qyapi.weixin.qq.com/mcp/v2/bot/<msg|doc|schedule|todo|meeting|contact|mail|disk>?apikey=...`）

### 1. 安装

```bash
npm install
cp node_modules/@esbuild/linux-x64/bin/esbuild ./node_modules/.bin/esbuild 2>/dev/null || true  # 若 esbuild postinstall 被拦截
```

### 2. 生成配置二维码（电脑端）

```bash
npm run qr
```

按提示操作：

```text
Rokid 企业微信助手 配置工具

MCP 名称:
> 企业微信消息

MCP URL:
> https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=****3456

继续添加 MCP Server? [y/N]: n

配置已生成，请使用 Rokid 眼镜扫描：

[终端二维码]
```

- 可直接粘贴官方完整 URL，也可以只粘贴 API Key 后从 8 个能力位菜单里选。
- API Key 输入时**不回显**（逐字符 `*`）。
- 支持一次配置最多 32 个 Server（每条 URL 可有独立 API Key）；内容超出单张二维码容量（2331 字节）时自动分片，眼镜按提示依次扫描。`--max-chars`（默认 900，最小 200）是每张的近似字符数，实际会按二维码 2331 字节上限自动增加分片数。
- 支持从 JSON 或 TXT 文件批量导入 URL：

  ```bash
  node tools/wecom-mcp-qr.mjs --no-interactive --file ./wecom-mcps.json --mode light
  ```

  JSON 格式为 `{"servers":[{"name":"企业微信消息","url":"https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=KEY"}]}`；TXT 每行一个完整 URL，空行与 `#` 注释行忽略。`--file` 不能和直接 URL 参数混用。文件可能含真实 Token，请限制文件权限（如 `chmod 600`），脚本不会打印文件原文。
- 默认不写任何文件；需要图片可加 `--png out.png` / `--svg out.svg`：导出文件权限自动设为 `600`，且含真实 API Key，请勿提交 Git 或外传。`.gitignore` 已忽略 `qr*.png` / `qr*.svg` / `out.png` / `out-*.png` 等常见导出名，以及 `qr-export/` 目录和中断残留的 `*.png.tmp-*` / `*.svg.tmp-*` 临时文件。同一输出前缀（包括 `qr.png` 与 `qr-1.png` 这类重叠输出，以及指向同一物理目录的符号链接别名）的并发导出会加排他锁并明确报错（不会互删旧分片或混扫；不相关前缀可并行）；同一次 `--png` / `--svg` 若输出/清理范围重叠（含软链别名）也会在写入前直接拒绝，不写不删。若进程被强杀留下 `.qr-export-*.lock`，按错误提示确认进程已不在后手动删除再重试（工具不会自动删除不明锁；Ctrl-C / SIGTERM 会自动释放本进程锁并清理本进程含凭据的临时文件，SIGTERM 以 143 退出；SIGKILL（kill -9）无法捕获，锁/临时文件可能残留，需手动处理）。二维码载荷上限 81920 字符 / 128 片，仍受 URL 白名单、每条 URL 长度等校验限制。
- 终端配色：`--mode dark|light|auto`（默认自动检测，扫不出时换另一种）。

非交互模式（脚本化 / CI）：

```bash
node tools/wecom-mcp-qr.mjs --no-interactive \
  --name 企业微信消息 --url 'https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=KEY' \
  --mode light
```

完整参数：`node tools/wecom-mcp-qr.mjs --help`。

### 3. 安装到眼镜

```bash
npm run pack                       # 产出 dist/wecom-mcp-assistant.aix
npx aix preview ./app              # 本机浏览器预览（无需真机）
npx aix install dist/wecom-mcp-assistant.aix   # 通过 ADB 安装到眼镜
npx aix launch-page dist/wecom-mcp-assistant.aix /pages/index/index
```

### 4. 首次授权

1. 打开应用，主界面提示「尚未授权企业微信」。
2. 按确认键进入扫码页，对准备好的二维码按确认键拍摄（分片时依次扫完全部）。
3. 应用会校验内容，然后用一次性连接**真实验证授权**（企业微信的 `initialize` / `tools/list` 不校验 apikey，必须实调 `tools/call`），并显示可用工具数量与名称。
4. 验证通过后显示「保存方式」确认页：方向键切换「保存到本机 / 仅本次会话」，确认键保存、返回键取消；验证失败则直接报错，不会保存坏配置。
5. 保存后立即重连并回到主界面，显示工具数量；菜单里可查看完整工具清单。

## 使用

主界面按键：

| 操作 | 按键 |
| --- | --- |
| 说话提问 | 确认键（Enter） |
| 结束说话 / 取消录音 | 确认键 / 返回键 |
| 上下滚动结果 | 方向键 |
| 打开菜单 | 返回键 |
| 确认执行写操作 | 确认键 |
| 取消写操作 | 返回键 |

菜单项：语音提问 / 查看可用工具 / 重新扫码授权 / 删除已保存配置 / 退出助手。

可直接这样说（示例）：

- 「查询我今天的日程」
- 「看看未完成的待办」
- 「搜索项目文档」
- 「给张三发送消息，内容是明天下午三点开会」→ 会先复述确认，确认后才真正发送
- 「删除日程 sc_1」→ 先确认再执行
- 「有哪些工具」

读操作直接执行并在屏幕上显示结果、必要时语音播报；**发送消息、取消/删除、创建等写操作一定先确认**。

## 安全与限制

- 二维码内容包含真实 URL 与 API Key（扫码授权的必要设计），终端其余输出一律脱敏；请勿截图外传。
- `--png` / `--svg` 导出的图片同样含真实凭据：文件权限固定为 `600`，请勿提交 Git（仓库 `.gitignore` 已覆盖常见导出名）或上传网盘，用完建议删除。
- 授权可用性以企业微信 MCP 服务端实际调用结果为准；应用不根据本地保存时间推算授权期限。
- 本机存储：AIUI 没有系统级安全存储，配置只写入应用隔离存储；选择「仅本次会话」不落盘，并会清除此前保存的旧凭据。能力位部分未授权（851008）时仍允许保存，应用会提示到后台补权限，而不是反复重扫。

## 开发与验证

```bash
npm test          # 端到端测试：MCP SDK e2e、助手确认流、32连接二维码往返、配置存储、CLI文件批量导入（用例数量以实际运行为准）
npm run build:libs # 重新生成 app/libs/mcp-client.js（升级 SDK 后必做）
npm run mock:server # 手动起模拟企业微信 MCP（随机端口，启动时打印实际 URL；也可 --port 8765 --apikey dev-key）

# 无真机时验证 .ink 界面能真正渲染（headless Chrome + 官方 ink 运行时）
npx aix preview ./app --html-out /tmp/preview.html
CHROME_PATH=/path/to/chrome-headless-shell \
  node tools/dev/render-preview.mjs /tmp/preview.html /tmp/preview --keys Enter,Backspace
```

验证记录（实际渲染截图、打包产物、变异测试）保存在本地，不随仓库提交。
`tools/dev/render-preview.mjs` 需要 headless Chrome；未设置 `CHROME_PATH` 时会用脚本里写死的本机缓存路径。截图里的中文需要系统中文字体（如 Noto Sans CJK），否则 canvas 上的中文会渲染成方块。

## License

MIT
