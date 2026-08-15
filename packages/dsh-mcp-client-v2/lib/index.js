/**
 * dsh-mcp-client-v2
 * Enhanced MCP client for DeepSeek Harness (Codex 0.147-style MCP
 * 2026-07-28 protocol support): paginated tool discovery, non-blocking
 * startup, a `mcp_tool_search` model tool, hand-rolled stdio /
 * streamable-http transports, and bounded exponential reconnect.
 *
 * Config file: ~/.dsh/dsh-mcp-client-v2.json  (optional)
 *   {
 *     "servers": [
 *       {
 *         "serverName": "github",
 *         "transport": "stdio",
 *         "command": "npx",
 *         "args": ["-y", "@modelcontextprotocol/server-github"],
 *         "env": { "GITHUB_TOKEN": "" },
 *         "cwd": "",
 *         "toolCallTimeoutMs": 60000,
 *         "reconnect": { "enabled": true, "initialDelayMs": 500, "maxDelayMs": 30000, "maxAttempts": 10 }
 *       },
 *       {
 *         "serverName": "web",
 *         "transport": "streamable-http",
 *         "url": "http://localhost:3000/mcp",
 *         "headers": { "Authorization": "Bearer xxx" },
 *         "toolCallTimeoutMs": 60000
 *       }
 *     ],
 *     "searchEnabled": true
 *   }
 *
 * No environment-variable expansion is performed in this file (values are
 * used verbatim; put literal values in the config or see the README).
 *
 * Tool registration is defensive: it prefers the harness.defineTool /
 * harness.registerTool pair (sandbox/link-package API), falls back to
 * ctx.tools.register (host-realm API), and never throws from apply — a
 * failed registration is logged and the server stays connected.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  McpClient,
  extractText,
  publicToolName,
} from './mcp.js'

export const name = 'mcp-client-v2'
export const inject = ['tools']

const CONFIG_PATH = join(homedir(), '.dsh', 'dsh-mcp-client-v2.json')

const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000
const MAX_DISCOVERY_PAGES = 20
const MAX_TOOL_SEARCH_PER_SERVER = 500
const SEARCH_DESCRIPTION_LIMIT = 120
const STATUS_TOOL_NAMES_LIMIT = 50

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

const RECONNECT_DEFAULTS = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30000,
  maxAttempts: 10,
})

/* ------------------------------------------------------------------ *
 * Config loading and normalization
 * ------------------------------------------------------------------ */

function loadConfig() {
  try {
    if (existsSync(CONFIG_PATH)) {
      const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : {}
    }
  } catch {
    // malformed or unreadable config: fall through to defaults
  }
  return {}
}

function normalizeReconnect(raw) {
  if (!raw || typeof raw !== 'object') return RECONNECT_DEFAULTS
  const initialDelayMs = typeof raw.initialDelayMs === 'number' && raw.initialDelayMs > 0
    ? raw.initialDelayMs
    : RECONNECT_DEFAULTS.initialDelayMs
  const maxDelayMs = typeof raw.maxDelayMs === 'number' && raw.maxDelayMs > 0
    ? raw.maxDelayMs
    : RECONNECT_DEFAULTS.maxDelayMs
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : RECONNECT_DEFAULTS.enabled,
    initialDelayMs: Math.min(initialDelayMs, maxDelayMs),
    maxDelayMs,
    maxAttempts: Number.isInteger(raw.maxAttempts) && raw.maxAttempts >= 1
      ? raw.maxAttempts
      : RECONNECT_DEFAULTS.maxAttempts,
  }
}

/** Validate one server entry; returns a normalized config or null (logged). */
function normalizeServer(raw) {
  if (!raw || typeof raw !== 'object') return null
  const serverName = typeof raw.serverName === 'string' ? raw.serverName : ''
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    console.warn(`[dsh-mcp-client-v2] skipping server: serverName must match ${SERVER_NAME_PATTERN} (got ${JSON.stringify(serverName)})`)
    return null
  }
  const transport = raw.transport === 'stdio' ? 'stdio' : raw.transport === 'streamable-http' ? 'streamable-http' : ''
  if (!transport) {
    console.warn(`[dsh-mcp-client-v2] skipping server "${serverName}": transport must be "stdio" or "streamable-http"`)
    return null
  }
  const server = { serverName, transport }
  if (transport === 'stdio') {
    if (typeof raw.command !== 'string' || raw.command.length === 0) {
      console.warn(`[dsh-mcp-client-v2] skipping server "${serverName}": stdio requires a command`)
      return null
    }
    server.command = raw.command
    server.args = Array.isArray(raw.args) ? raw.args.filter((a) => typeof a === 'string') : []
    server.env = raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env) ? { ...raw.env } : {}
    server.cwd = typeof raw.cwd === 'string' ? raw.cwd : ''
  } else {
    if (typeof raw.url !== 'string' || raw.url.length === 0) {
      console.warn(`[dsh-mcp-client-v2] skipping server "${serverName}": streamable-http requires a url`)
      return null
    }
    server.url = raw.url
    server.headers = raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers) ? { ...raw.headers } : {}
  }
  server.toolCallTimeoutMs = typeof raw.toolCallTimeoutMs === 'number' && raw.toolCallTimeoutMs > 0
    ? raw.toolCallTimeoutMs
    : DEFAULT_TOOL_CALL_TIMEOUT_MS
  server.reconnect = normalizeReconnect(raw.reconnect)
  return server
}

function resolveServers(fileConfig, pluginConfig) {
  const candidates = pluginConfig && Array.isArray(pluginConfig.servers)
    ? pluginConfig.servers
    : fileConfig && Array.isArray(fileConfig.servers)
      ? fileConfig.servers
      : []
  const servers = []
  for (const raw of candidates) {
    const server = normalizeServer(raw)
    if (server) servers.push(server)
  }
  return servers
}

/* ------------------------------------------------------------------ *
 * Parameter-schema sanitizer: keep only the harness-supported subset
 * ------------------------------------------------------------------ */

const SCHEMA_CONSTRAINT_KEYS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const SCHEMA_ANNOTATION_KEYS = new Set(['description', 'title', 'default', 'examples'])
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const SCHEMA_SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null'])

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonValue(value) {
  if (value === null) return true
  const type = typeof value
  if (type === 'string' || type === 'boolean') return true
  if (type === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (type === 'object') {
    for (const key of Object.keys(value)) if (!isJsonValue(value[key])) return false
    return true
  }
  return false
}

function scalarMatches(type, value) {
  if (type === 'string') return typeof value === 'string'
  if (type === 'number' || type === 'integer') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'null') return value === null
  return false
}

/**
 * Recursively reduce an untrusted MCP JSON-Schema into the harness-supported
 * subset (type / oneOf / properties / required / additionalProperties /
 * items / enum / const + description/title/default/examples annotations).
 * Anything else (anyOf, $ref, $schema, format, pattern, ...) is dropped;
 * unsupported nodes degrade to annotation-only (unconstrained JSON) so a rich
 * server schema never aborts the whole tool registration.
 */
function sanitizeNode(schema) {
  if (!isPlainObject(schema)) return {}
  const out = {}
  for (const key of Object.keys(schema)) {
    if (SCHEMA_CONSTRAINT_KEYS.has(key) || SCHEMA_ANNOTATION_KEYS.has(key)) out[key] = schema[key]
  }
  for (const key of ['description', 'title']) {
    if (out[key] !== undefined && typeof out[key] !== 'string') delete out[key]
  }
  for (const key of ['default', 'examples']) {
    if (out[key] !== undefined && !isJsonValue(out[key])) delete out[key]
  }

  const hasType = typeof out.type === 'string' && SCHEMA_TYPES.has(out.type)
  if (!hasType) {
    if (Array.isArray(out.oneOf) && out.oneOf.length >= 2) {
      for (const key of ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']) delete out[key]
      out.oneOf = out.oneOf.map((branch) => sanitizeNode(branch))
      return out
    }
    for (const key of SCHEMA_CONSTRAINT_KEYS) delete out[key]
    return out
  }

  const type = out.type
  delete out.oneOf // type and oneOf cannot coexist in the subset

  if (type === 'object') {
    if (out.properties !== undefined && isPlainObject(out.properties)) {
      const properties = {}
      for (const [key, sub] of Object.entries(out.properties)) properties[key] = sanitizeNode(sub)
      out.properties = properties
    } else {
      out.properties = {}
    }
    if (out.required !== undefined) {
      if (!Array.isArray(out.required) || !out.required.every((r) => typeof r === 'string') || out.required.length === 0) {
        delete out.required
      } else {
        out.required = out.required.filter((r) => Object.hasOwn(out.properties, r))
        if (out.required.length === 0) delete out.required
      }
    }
    if (out.additionalProperties !== undefined && typeof out.additionalProperties !== 'boolean') delete out.additionalProperties
    delete out.items
    delete out.enum
    delete out.const
  } else if (type === 'array') {
    if (out.items !== undefined) out.items = sanitizeNode(out.items)
    delete out.enum
    delete out.const
    delete out.properties
    delete out.required
    delete out.additionalProperties
  } else {
    delete out.properties
    delete out.required
    delete out.additionalProperties
    delete out.items
    if (out.enum !== undefined) {
      if (!Array.isArray(out.enum) || out.enum.length === 0 || !out.enum.every((v) => scalarMatches(type, v))) {
        delete out.enum
      }
    }
    if (out.const !== undefined && !scalarMatches(type, out.const)) delete out.const
  }
  return out
}

/**
 * Sanitize an MCP tool inputSchema for use as `parameters` in the harness
 * tool DSL. The root must be an object schema (the DSL root is an open
 * parameter map); any other root degrades to unconstrained `{}`.
 */
export function sanitizeParameterSchema(schema) {
  if (!isPlainObject(schema)) return { type: 'object', properties: {} }
  const node = sanitizeNode(schema)
  if (node.type !== 'object') return { type: 'object', properties: {} }
  // The DSL parameter root is implicitly open: additionalProperties must be
  // true or omitted (false would be rejected by normalizeParameterSchemaSpec).
  if (Object.hasOwn(node, 'additionalProperties') && node.additionalProperties !== true) delete node.additionalProperties
  return node
}

/* ------------------------------------------------------------------ *
 * Tool registration (defensive: never throws from apply)
 * ------------------------------------------------------------------ */

/**
 * Register one model tool, preferring the harness.defineTool /
 * harness.registerTool pair (sandbox / link-package API, the marker-verified
 * path dsh-secret-redactor uses) and falling back to the plain
 * ctx.tools.register(definition) host-realm API used by the official
 * dsh-mcp-client (lib/index.js:160).
 *
 * @returns a disposer function (may be a no-op on failure).
 */
function registerModelTool(ctx, definition) {
  try {
    if (typeof harness !== 'undefined' && harness && typeof harness.defineTool === 'function' && typeof harness.registerTool === 'function') {
      try {
        return harness.registerTool(ctx, harness.defineTool(definition))
      } catch (error) {
        // Retry once with an unconstrained schema: a schema keyword the
        // sanitizer missed must not cost the tool its registration.
        console.warn(`[dsh-mcp-client-v2] defineTool failed for "${definition.name}": ${error.message || String(error)}; retrying with unconstrained parameters`)
        const fallback = { ...definition, parameters: { type: 'object', properties: {} } }
        return harness.registerTool(ctx, harness.defineTool(fallback))
      }
    }
    if (ctx && ctx.tools && typeof ctx.tools.register === 'function') {
      return ctx.tools.register(definition)
    }
    console.warn(`[dsh-mcp-client-v2] no tool registration API available (neither harness.defineTool nor ctx.tools.register); tool "${definition.name}" not registered`)
  } catch (error) {
    console.warn(`[dsh-mcp-client-v2] tool registration failed for "${definition.name}": ${error.message || String(error)}`)
  }
  return () => {}
}

function createOutput(rawName) {
  return {
    schema: {
      type: 'object',
      properties: {
        content: { type: 'array', items: {} },
        structuredContent: {},
      },
      required: ['content'],
      additionalProperties: false,
    },
    render(args, value) {
      return [{ type: 'text', text: extractText(value && value.content, rawName) }]
    },
  }
}

function buildToolDefinition(mcp, serverConfig, tool) {
  const rawName = tool.name
  return {
    name: publicToolName(serverConfig.serverName, rawName),
    description: typeof tool.description === 'string' ? tool.description : '',
    parameters: tool.inputSchema === undefined ? { type: 'object', properties: {} } : sanitizeParameterSchema(tool.inputSchema),
    output: createOutput(rawName),
    async execute(args, exec) {
      return mcp.callTool(rawName, args && typeof args === 'object' ? args : {}, {
        timeoutMs: serverConfig.toolCallTimeoutMs,
        signal: exec && exec.signal,
      })
    },
  }
}

/* ------------------------------------------------------------------ *
 * Per-server connection supervisor (non-blocking, bounded reconnect)
 * ------------------------------------------------------------------ */

/**
 * Start one MCP server connection in the background. `apply` never awaits
 * this; state transitions (connecting -> ready / failed) are observable
 * through the `mcp-client-v2/status` RPC and the model tool.
 */
function startServer(ctx, serverConfig) {
  const label = `mcp-client-v2(${serverConfig.serverName})`
  const state = {
    serverName: serverConfig.serverName,
    state: 'connecting', // connecting | ready | failed | stopped
    error: null,
    toolCount: 0,
    toolNames: [],
    toolMeta: [], // { name (public), rawName, description } for the search tool
    connectedAt: null,
    attempts: 0,
  }
  let client = null
  let disposers = new Map()
  let reconnectTimer = null
  let disposed = false
  let generation = 0
  let syncChain = Promise.resolve()

  function enqueueSync(mcp) {
    const run = syncChain.then(async () => {
      if (disposed) return
      await syncTools(mcp)
    })
    syncChain = run.catch(() => {})
    return run
  }

  async function syncTools(mcp) {
    const { tools, pages } = await mcp.listAllTools({ maxPages: MAX_DISCOVERY_PAGES })
    if (disposed) return
    const definitions = []
    const meta = []
    for (const tool of tools) {
      const rawName = tool.name
      try {
        definitions.push(buildToolDefinition(mcp, serverConfig, tool))
      } catch (error) {
        console.warn(`${label}: skipping tool "${rawName}": ${error.message || String(error)}`)
        continue
      }
      meta.push({
        name: publicToolName(serverConfig.serverName, rawName),
        rawName,
        description: typeof tool.description === 'string' ? tool.description : '',
      })
    }
    // Swap: dispose the previous generation, register the new one.
    for (const dispose of disposers.values()) {
      try {
        dispose()
      } catch {
        // best effort
      }
    }
    disposers = new Map()
    let registered = 0
    for (const definition of definitions) {
      const dispose = registerModelTool(ctx, definition)
      disposers.set(definition.name, dispose)
      registered += 1
    }
    state.toolCount = registered
    state.toolNames = definitions.map((d) => d.name)
    state.toolMeta = meta
    console.log(`${label}: registered ${registered} tool(s) from ${pages} page(s)`)
  }

  async function connect() {
    const myGeneration = ++generation
    // Guards against double reconnect scheduling: the transport close hook
    // and this attempt's catch may both observe the same failure.
    let downHandled = false
    const mcp = new McpClient(serverConfig, {
      onClose: (error) => {
        if (myGeneration === generation && !disposed) {
          downHandled = true
          scheduleReconnect(error)
        }
      },
      onToolsChanged: () => {
        if (myGeneration === generation && !disposed) {
          console.log(`${label}: tool list changed, re-syncing`)
          enqueueSync(mcp).catch((error) => {
            if (!disposed) console.warn(`${label}: tool re-sync failed: ${error.message || String(error)}`)
          })
        }
      },
      onStderr: (line) => console.warn(`${label} [stderr]: ${line}`),
    })
    client = mcp
    state.state = 'connecting'
    state.error = null
    try {
      await mcp.connect()
      if (disposed || myGeneration !== generation) {
        await mcp.close().catch(() => {})
        return
      }
      await enqueueSync(mcp)
      if (disposed || myGeneration !== generation) return
      state.state = 'ready'
      state.connectedAt = Date.now()
      state.attempts = 0
      console.log(`${label}: connected (protocol ${mcp.negotiatedProtocolVersion}), ${state.toolCount} tool(s)`)
    } catch (error) {
      if (disposed || myGeneration !== generation) return
      state.error = error && error.message ? error.message : String(error)
      console.warn(`${label}: connection attempt failed: ${state.error}`)
      await mcp.close().catch(() => {})
      if (!downHandled) scheduleReconnect(error)
    }
  }

  function scheduleReconnect(error) {
    if (disposed) return
    if (!serverConfig.reconnect.enabled) {
      state.state = 'failed'
      state.error = `reconnect disabled${error ? `: ${error.message || String(error)}` : ''}`
      console.error(`${label}: reconnect disabled; ${state.toolCount > 0 ? 'registered tools will fail until a reload' : 'no tools were registered'}`)
      return
    }
    // A connection that stayed up past maxDelayMs closes the outage: reset
    // the attempt budget so a briefly-crashing server recovers indefinitely
    // while a crash-looping one still exhausts the cap.
    if (state.connectedAt !== null && Date.now() - state.connectedAt >= serverConfig.reconnect.maxDelayMs) {
      state.attempts = 0
    }
    state.connectedAt = null
    state.attempts += 1
    if (state.attempts > serverConfig.reconnect.maxAttempts) {
      state.state = 'failed'
      state.error = `gave up after ${serverConfig.reconnect.maxAttempts} consecutive failed attempts`
      for (const dispose of disposers.values()) {
        try {
          dispose()
        } catch {
          // best effort
        }
      }
      disposers = new Map()
      state.toolCount = 0
      state.toolNames = []
      state.toolMeta = []
      console.error(`${label}: ${state.error} — tools unregistered; reload the plugin or restart the Host to reconnect`)
      return
    }
    const delayMs = Math.min(serverConfig.reconnect.maxDelayMs, serverConfig.reconnect.initialDelayMs * 2 ** (state.attempts - 1))
    state.state = 'connecting'
    state.error = `reconnecting in ${delayMs}ms (attempt ${state.attempts}/${serverConfig.reconnect.maxAttempts})`
    console.warn(`${label}: ${state.error}`)
    if (reconnectTimer !== null) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delayMs)
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref()
  }

  function dispose() {
    if (disposed) return
    disposed = true
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    state.state = 'stopped'
    const current = client
    client = null
    if (current) current.close().catch(() => {})
    for (const disposeFn of disposers.values()) {
      try {
        disposeFn()
      } catch {
        // best effort
      }
    }
    disposers = new Map()
    state.toolCount = 0
    state.toolNames = []
    state.toolMeta = []
  }

  function snapshot() {
    return {
      serverName: state.serverName,
      state: state.state,
      toolCount: state.toolCount,
      toolNames: state.toolNames.slice(0, STATUS_TOOL_NAMES_LIMIT),
      error: state.error,
      connectedAt: state.connectedAt,
    }
  }

  connect()
  return { state, dispose, snapshot }
}

/* ------------------------------------------------------------------ *
 * Status / search shared by the RPC handlers and the model tool
 * ------------------------------------------------------------------ */

function getStatus(controllers) {
  const servers = []
  for (const controller of controllers.values()) servers.push(controller.snapshot())
  return { servers }
}

function searchTools(controllers, query) {
  const needle = typeof query === 'string' && query.trim().length > 0 ? query.trim().toLowerCase() : ''
  const servers = []
  let total = 0
  for (const controller of controllers.values()) {
    const state = controller.state
    const all = state.toolMeta
    const filtered = needle.length === 0
      ? all
      : all.filter((t) =>
          t.name.toLowerCase().includes(needle) ||
          (typeof t.description === 'string' && t.description.toLowerCase().includes(needle)),
        )
    const truncated = filtered.length > MAX_TOOL_SEARCH_PER_SERVER
    const shown = truncated ? filtered.slice(0, MAX_TOOL_SEARCH_PER_SERVER) : filtered
    total += shown.length
    servers.push({
      serverName: state.serverName,
      state: state.state,
      count: shown.length,
      truncated,
      tools: shown.map((t) => ({
        name: t.name,
        rawName: t.rawName,
        description: t.description.length > SEARCH_DESCRIPTION_LIMIT
          ? `${t.description.slice(0, SEARCH_DESCRIPTION_LIMIT)}...`
          : t.description,
      })),
    })
  }
  return { total, query: needle.length === 0 ? null : needle, servers }
}

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

export function apply(ctx, pluginConfig) {
  const fileConfig = loadConfig()
  const servers = resolveServers(fileConfig, pluginConfig)
  const searchEnabled = (pluginConfig && typeof pluginConfig.searchEnabled === 'boolean'
    ? pluginConfig.searchEnabled
    : fileConfig.searchEnabled) !== false
  const controllers = new Map()

  if (searchEnabled) {
    const searchDefinition = {
      name: 'mcp_tool_search',
      description:
        'Search the tools exposed by connected MCP servers (dsh-mcp-client-v2). Lists each connected server with its tools (public name, raw name, first 120 chars of description); pass a keyword to filter by name or description (case-insensitive substring). Use it to discover what MCP servers can do before calling an mcp__ tool.',
      parameters: {
        query: {
          type: 'string',
          description: 'Optional keyword. Filters tools whose public name or description contains it; omit to list all tools of all connected servers.',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute(args) {
        return searchTools(controllers, args && args.query)
      },
    }
    registerModelTool(ctx, searchDefinition)
  }

  for (const serverConfig of servers) {
    try {
      const controller = startServer(ctx, serverConfig)
      controllers.set(serverConfig.serverName, controller)
    } catch (error) {
      console.warn(`[dsh-mcp-client-v2] failed to start server "${serverConfig.serverName}": ${error.message || String(error)}`)
    }
  }

  // Package-private RPC: connection state and tool discovery for client
  // halves and other plugins. Defensive: RPC is optional in this package.
  if (typeof harness !== 'undefined' && harness && typeof harness.handle === 'function') {
    try {
      harness.handle('mcp-client-v2/status', () => getStatus(controllers))
      harness.handle('mcp-client-v2/tools', (args) => searchTools(controllers, args && args.query))
    } catch (error) {
      console.warn(`[dsh-mcp-client-v2] RPC registration failed: ${error.message || String(error)}`)
    }
  }

  // Teardown on plugin stop / HMR: kill child processes, cancel reconnects,
  // and unregister every tool. Fiber unwinding also disposes registrations;
  // this effect guarantees the transport-level cleanup.
  try {
    ctx.effect(() => {
      return () => {
        for (const controller of controllers.values()) controller.dispose()
        controllers.clear()
      }
    }, 'mcp-client-v2.connections')
  } catch (error) {
    console.warn(`[dsh-mcp-client-v2] effect registration failed: ${error.message || String(error)}`)
  }

  // Non-blocking by design: apply returns immediately; connections and tool
  // synchronization proceed in the background.
}

export default { name, inject, apply }
