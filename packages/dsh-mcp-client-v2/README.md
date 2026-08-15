# dsh-mcp-client-v2

Enhanced MCP client for DeepSeek Harness, following the Codex 0.147 MCP
2026-07-28 protocol enhancements: paginated tool discovery, non-blocking
startup, and a `mcp_tool_search` model tool.

English | [中文](README.zh.md)

## What it does

- **Paginated tool discovery**: `tools/list` cursor chains are drained page by
  page (`nextCursor`) with dedupe and a 20-page safety cap
  (`lib/paginate.js`, pure and unit-tested). A server advertising more tools
  than fit in one page is fully discovered, never truncated.
- **Non-blocking startup**: `apply()` returns immediately. Server connections
  and tool synchronization run in the background, so an unreachable or slow
  MCP server never blocks Host startup or the first turn. Connection state
  (`connecting` / `ready` / `failed`) is observable through the
  `mcp-client-v2/status` RPC, and registered tools appear in the model toolset
  as soon as discovery completes.
- **`mcp_tool_search` model tool**: lists every connected server's tools
  (public name, raw name, first 120 chars of description), filterable by a
  case-insensitive keyword over name or description. Useful to discover what
  an MCP server can do before calling an `mcp__` tool.
- **Hand-rolled transports** (no MCP SDK dependency):
  - `stdio` — spawns the configured command via `node:child_process` and
    speaks newline-delimited JSON-RPC over stdin/stdout; stderr lines are
    surfaced as diagnostics.
  - `streamable-http` — Node 23 global `fetch`, POST JSON with
    `MCP-Protocol-Version` / `Mcp-Session-Id` headers; accepts
    `application/json` and `text/event-stream` response bodies (minimal SSE
    parsing).
- **Bounded reconnect**: exponential backoff (500 ms doubling, 30 s cap, 10
  attempts), matching the official client's policy. On reconnect the server
  is re-synced, replacing the previous tool generation; `notifications/tools/
  list_changed` re-syncs without reconnect.
- **Official-compatible naming**: tools register as
  `mcp__<serverName>__<rawName>` (normalized to the DeepSeek function-name
  contract with a deterministic hash suffix when needed), identical to the
  official `@deepseek-ai/dsh-mcp-client`.

## Install

```sh
dsh plugin --profile web add github:DamonKoy/dsh-plugins#path:/packages/dsh-mcp-client-v2
```

Restart `dsh web`. Unlike the official v1 client (one Cordis row per server),
v2 reads all servers from a single config file.

## Config

File `~/.dsh/dsh-mcp-client-v2.json`:

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

| Field | Transport | Required | Meaning |
|---|---|---|---|
| `serverName` | both | yes | Namespace for public tool names; `[A-Za-z0-9_-]{1,32}` |
| `transport` | both | yes | `"stdio"` or `"streamable-http"` |
| `command` | stdio | yes | Executable to spawn |
| `args` | stdio | no | Arguments passed to the command |
| `env` | stdio | no | Extra env vars merged over the ambient process env |
| `cwd` | stdio | no | Working directory for the child process |
| `url` | http | yes | MCP server URL |
| `headers` | http | no | Extra headers, e.g. `Authorization` |
| `toolCallTimeoutMs` | both | no | Per `tools/call` timeout (default 60000) |
| `reconnect.enabled` | both | no | Auto-reconnect (default `true`) |
| `reconnect.initialDelayMs` | both | no | First retry delay, doubles per attempt (default 500) |
| `reconnect.maxDelayMs` | both | no | Backoff ceiling (default 30000) |
| `reconnect.maxAttempts` | both | no | Consecutive attempts per outage (default 10) |
| `searchEnabled` | top-level | no | Register the `mcp_tool_search` tool (default `true`) |

Invalid entries are skipped with a warning; the plugin never fails to load
because of one bad server. There is **no environment-variable expansion** in
this config file — values are used verbatim (put literal secrets in the file,
or generate the file from your environment before starting `dsh web`).
Config is read once at plugin activation; edit + restart to apply changes.

An equivalent config can also be supplied through the plugin row's Cordis
`config.servers` / `config.searchEnabled` if you prefer.

## Tool naming

Every MCP tool has two names: the raw MCP name (sent on the wire in
`tools/call`) and the public name `mcp__<serverName>__<rawName>` registered
on the toolset. Public names are normalized to the DeepSeek function-name
contract (64 chars, `[A-Za-z0-9_-]`); when replacement or truncation changes
the name, a deterministic 12-hex-char SHA-256 hash of `(serverName, rawName)`
is appended so distinct tools never collapse into one name. Names are pure
functions of `(serverName, rawName)`.

MCP input schemas are sanitized to the harness-supported JSON-Schema subset
(`type` / `oneOf` / `properties` / `required` / `additionalProperties` /
`items` / `enum` / `const` + annotations). Unsupported vocabulary such as
`anyOf`, `$ref`, `format`, or `pattern` is dropped so the tool still
registers with its useful structure; a registration that still fails falls
back to an unconstrained `{}` schema.

## Tool registration

Registration is defensive and prefers the sandbox/link-package API used by
`dsh-secret-redactor`: `harness.defineTool(definition)` +
`harness.registerTool(ctx, tool)`. When the global `harness` is unavailable
(host-realm load), it falls back to the official v1 mechanism
`ctx.tools.register(definition)` (`@deepseek-ai/dsh-mcp-client/lib/index.js`,
line 160). Every registration is wrapped so a failure logs a warning and
never throws from `apply`.

## RPC (package-private)

`harness.handle` methods for client halves and other plugins:

- `mcp-client-v2/status` — `{ servers: [{ serverName, state, toolCount,
  toolNames, error, connectedAt }] }`; `state` is `connecting | ready |
  failed | stopped`.
- `mcp-client-v2/tools` — same payload as the `mcp_tool_search` tool
  (optional `query` keyword).

## Behavior

- `apply()` returns synchronously; each server connects in the background and
  registers its tools when discovery completes (paginated, deduped, 20-page
  cap). Model tools appear automatically without a restart.
- On disconnect or connection failure the supervisor retries with exponential
  backoff. Success re-syncs and replaces the previous generation (no
  duplicates, no leaks). After `maxAttempts` consecutive failures the
  server's tools are unregistered and reconnection stops until a plugin reload
  or Host restart; a connection that stayed up past `maxDelayMs` resets the
  budget.
- `notifications/tools/list_changed` triggers a re-sync of that server.
- `tools/call` sends the raw MCP name (never the public name) with timeout
  and abort support. Results are normalized to `{ content, structuredContent?
  }`; text blocks join with newlines, image/audio/resource blocks become
  placeholders, and a server-side `isError` rejects the call.

## Differences from the official v1 (`@deepseek-ai/dsh-mcp-client`)

| Aspect | v1 (official) | v2 (this package) |
|---|---|---|
| MCP SDK | `@modelcontextprotocol/sdk` | none, hand-rolled JSON-RPC |
| Startup | awaits connect + discovery before activation | non-blocking, background supervisor |
| Config | one Cordis row per server | one file, many servers |
| Pagination | cursor loop in `syncTools` (inline) | pure `collectTools` in `lib/paginate.js`, unit-tested, 20-page cap, dedupe |
| Duplicate tool names | rejects the whole list | dedupes (first wins), logged |
| Status | logs only | `mcp-client-v2/status` RPC |
| Tool search | no | `mcp_tool_search` model tool |
| Protocol version | SDK default | requests `2026-07-28` in `initialize` |
| Streamable HTTP | full SDK session handling | simplified request/response (JSON or SSE body); 202 Accepted streaming unsupported |

## Known limitations

- **Tools are the only bridged MCP capability** — Resources and Prompts are
  not exposed to the harness.
- **Streamable HTTP is a simplified request/response model** — a server that
  answers `202 Accepted` and streams the result later (deferred/SSE sessions)
  fails the request with a clear error instead of subscribing.
- **Reconnect triggers on transport close** — for stdio this is the child
  exit; for HTTP it is a fetch failure. A reachable-but-silent HTTP server
  surfaces per-request timeouts rather than a transport close.
- **Schema vocabulary outside the harness subset is dropped** (see "Tool
  naming"); validation fidelity is best-effort.
- **No env expansion** in the config file; values are literal.
- **Config is read once** at activation; changes require a plugin reload or
  Host restart.

## License

MIT
