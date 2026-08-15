# dsh-mcp-client-v2

DeepSeek Harness 的增强版 MCP 客户端，对标 Codex 0.147 的 MCP 2026-07-28 协议
增强：分页工具发现、非阻塞启动、`mcp_tool_search` 工具搜索模型工具。

[English](README.md) | 中文

## 功能

- **分页工具发现**：`tools/list` 的 `nextCursor` 游标链逐页拉全（`lib/paginate.js`
  为纯函数、可单测），带去重与 20 页上限防死循环。单页放不下的工具不会丢失。
- **非阻塞启动**：`apply()` 立即返回，服务器连接与工具同步在后台进行；某个 MCP
  服务器不可达或慢不会阻塞宿主启动与首轮对话。连接状态（`connecting` / `ready` /
  `failed`）通过 `mcp-client-v2/status` RPC 暴露，工具注册完成后自动出现在模型工具集。
- **`mcp_tool_search` 模型工具**：列出所有已连接服务器的工具（公开名、原始名、
  description 前 120 字符），可按关键词（名称或描述子串、不区分大小写）过滤。
  调用 `mcp__` 工具前用它了解服务器能力。
- **自带传输实现**（不依赖 MCP SDK）：
  - `stdio`：`node:child_process` spawn 子进程，stdin/stdout 逐行 JSON-RPC；
    stderr 作为诊断日志输出。
  - `streamable-http`：Node 23 全局 fetch，POST JSON，带
    `MCP-Protocol-Version` / `Mcp-Session-Id` 头；`application/json` 与
    `text/event-stream`（最小 SSE 解析）响应都处理。
- **有限重连**：指数退避（500ms 起步翻倍、上限 30s、最多 10 次），与官方 v1 策略
  一致；重连成功后重新分页同步工具并整代替换；`notifications/tools/list_changed`
  通知触发免重连的再同步。
- **官方同款命名**：工具注册为 `mcp__<serverName>__<rawName>`（按 DeepSeek
  函数名约束归一化，需要时追加确定性哈希后缀），与官方 `@deepseek-ai/dsh-mcp-client`
  一致。

## 安装

```sh
dsh plugin --profile web add github:DamonKoy/dsh-plugins#path:/packages/dsh-mcp-client-v2
```

重启 `dsh web`。与官方 v1（每个服务器一个 Cordis 行）不同，v2 从一个配置文件读取
所有服务器。

## 配置

文件 `~/.dsh/dsh-mcp-client-v2.json`：

```json
{
  "servers": [
    {
      "serverName": "github",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "" },
      "cwd": "",
      "toolCallTimeoutMs": 60000,
      "reconnect": { "enabled": true, "initialDelayMs": 500, "maxDelayMs": 30000, "maxAttempts": 10 }
    },
    {
      "serverName": "web",
      "transport": "streamable-http",
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer xxx" },
      "toolCallTimeoutMs": 60000
    }
  ],
  "searchEnabled": true
}
```

| 字段 | 传输 | 必填 | 说明 |
|---|---|---|---|
| `serverName` | 两者 | 是 | 公开工具名的命名空间；`[A-Za-z0-9_-]{1,32}` |
| `transport` | 两者 | 是 | `"stdio"` 或 `"streamable-http"` |
| `command` | stdio | 是 | 要 spawn 的可执行文件 |
| `args` | stdio | 否 | 传给命令的参数 |
| `env` | stdio | 否 | 叠加到当前进程环境上的额外环境变量 |
| `cwd` | stdio | 否 | 子进程工作目录 |
| `url` | http | 是 | MCP 服务器 URL |
| `headers` | http | 否 | 额外请求头，如 `Authorization` |
| `toolCallTimeoutMs` | 两者 | 否 | 单次 `tools/call` 超时（默认 60000） |
| `reconnect.enabled` | 两者 | 否 | 是否自动重连（默认 `true`） |
| `reconnect.initialDelayMs` | 两者 | 否 | 首次重试延迟，之后逐次翻倍（默认 500） |
| `reconnect.maxDelayMs` | 两者 | 否 | 退避上限（默认 30000） |
| `reconnect.maxAttempts` | 两者 | 否 | 每次断连周期的连续尝试次数（默认 10） |
| `searchEnabled` | 顶层 | 否 | 是否注册 `mcp_tool_search` 工具（默认 `true`） |

无效条目会被跳过并告警，单个服务器配置错误不会导致插件加载失败。
配置文件中**不做环境变量展开**——值原样使用（把字面量密钥写进文件，或在启动
`dsh web` 前用你的环境生成该文件）。配置在插件激活时读取一次，改后需重启生效。

也可以把同样的配置写在插件行的 Cordis `config.servers` / `config.searchEnabled`
里。

## 工具命名

每个 MCP 工具有两个名字：原始 MCP 名（`tools/call` 时在线路上发送）与注册到
工具集的公开名 `mcp__<serverName>__<rawName>`。公开名按 DeepSeek 函数名约束
（64 字符、`[A-Za-z0-9_-]`）归一化；当替换或截断改变名字时，追加 `(serverName,
rawName)` 的确定性 12 位十六进制 SHA-256 哈希，保证不同工具不会坍缩成同一个名字。
名字是 `(serverName, rawName)` 的纯函数。

MCP 输入 schema 会被清洗到 Harness 支持的 JSON-Schema 子集（`type` / `oneOf` /
`properties` / `required` / `additionalProperties` / `items` / `enum` / `const`
+ 注解）。`anyOf`、`$ref`、`format`、`pattern` 等不支持的词汇会被丢弃，工具仍带
有用结构注册；若注册仍失败，则回退为不设限的 `{}` schema。

## 工具注册方式

注册采用防御式写法，优先使用沙箱 / link 包 API（`dsh-secret-redactor` 同款）：
`harness.defineTool(definition)` + `harness.registerTool(ctx, tool)`。当全局
`harness` 不可用（宿主域加载）时，回退到官方 v1 的 `ctx.tools.register(definition)`
（`@deepseek-ai/dsh-mcp-client/lib/index.js` 第 160 行）。所有注册都包裹在
try/catch 中，失败只告警，`apply` 绝不抛错。

## RPC（包私有）

供客户端半区与其他插件调用的 `harness.handle` 方法：

- `mcp-client-v2/status` — `{ servers: [{ serverName, state, toolCount,
  toolNames, error, connectedAt }] }`；`state` 取值 `connecting | ready |
  failed | stopped`。
- `mcp-client-v2/tools` — 与 `mcp_tool_search` 工具同构的返回（可选 `query` 关键词）。

## 行为

- `apply()` 同步返回；每个服务器后台连接，发现完成后自动注册工具（分页、去重、
  20 页上限），无需重启即出现在模型工具集。
- 断连或连接失败时按指数退避重试；成功后重新同步并整代替换（不重复、不泄漏）。
  连续失败超过 `maxAttempts` 后注销该服务器工具并停止重连，直到插件重载或宿主
  重启；连接稳定超过 `maxDelayMs` 会重置尝试预算。
- `notifications/tools/list_changed` 触发该服务器再同步。
- `tools/call` 发送原始 MCP 名（绝不发送公开名），支持超时与中止。结果归一化为
  `{ content, structuredContent? }`；文本块以换行拼接，image/audio/resource 块
  变为占位符，服务器 `isError` 会拒绝该次调用。

## 与官方 v1（`@deepseek-ai/dsh-mcp-client`）的差异

| 方面 | v1（官方） | v2（本包） |
|---|---|---|
| MCP SDK | `@modelcontextprotocol/sdk` | 无，自带 JSON-RPC |
| 启动 | 激活前等待连接与发现 | 非阻塞，后台监督 |
| 配置 | 每服务器一个 Cordis 行 | 一个文件、多个服务器 |
| 分页 | `syncTools` 内联游标循环 | `lib/paginate.js` 纯函数 `collectTools`，可单测，20 页上限，去重 |
| 重名工具 | 整表拒绝 | 去重（保留首个）并记录 |
| 状态 | 仅日志 | `mcp-client-v2/status` RPC |
| 工具搜索 | 无 | `mcp_tool_search` 模型工具 |
| 协议版本 | SDK 默认 | `initialize` 请求 `2026-07-28` |
| Streamable HTTP | SDK 完整会话处理 | 简化请求/响应（JSON 或 SSE body）；202 Accepted 流式会话不支持 |

## 已知限制

- **只桥接工具能力**——Resources 与 Prompts 未对 Harness 暴露。
- **Streamable HTTP 为简化请求/响应模型**——服务器返回 `202 Accepted` 后延迟
  推送结果（deferred/SSE 会话）时，会以明确错误拒绝而非订阅。
- **重连触发基于传输关闭**——stdio 是子进程退出，HTTP 是 fetch 失败；可达但沉默
  的 HTTP 服务器表现为单请求超时而非传输关闭。
- **子集外的 schema 词汇被丢弃**（见「工具命名」），校验保真度为尽力而为。
- **配置文件不做环境变量展开**，值为字面量。
- **配置只在激活时读取一次**，变更需插件重载或宿主重启。

## License

MIT
