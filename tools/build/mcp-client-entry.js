// 仅用于构建 AIUI 端内置的 MCP 客户端 bundle（见 tools/build-libs.mjs）。
// AIUI 不支持从 node_modules 导入，因此 SDK 需预打包为单文件 ESM 放入 app/libs/。
export {
  Client,
  StreamableHTTPClientTransport,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  SdkError,
  SdkHttpError,
  SdkErrorCode,
  UnauthorizedError,
  ProtocolError,
} from '@modelcontextprotocol/client';
