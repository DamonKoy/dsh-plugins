/**
 * dsh-mcp-client-v2: MCP protocol client core.
 *
 * A hand-rolled Model Context Protocol client (no SDK dependency):
 *
 *   initialize handshake  ->  notifications/initialized  ->  tools/list
 *   (paginated, see lib/paginate.js)  ->  tools/call
 *
 * Transports:
 *   - stdio:            spawn a child process, newline-delimited JSON-RPC
 *                       over stdin/stdout (line framing, MCP stdio spec)
 *   - streamable-http:  global fetch, POST JSON, JSON or SSE response bodies
 *                       (simplified request/response model)
 *
 * The class is transport-agnostic: request/response correlation lives in the
 * JSON-RPC layer, transports only deliver framed messages in both directions.
 * No emoji, no dependency on the harness runtime, plain Node 23 ESM.
 */
import { spawn } from 'node:child_process'
import process from 'node:process'
import { createHash } from 'node:crypto'

/** Protocol version requested in `initialize` (MCP 2026-07-28). */
export const PROTOCOL_VERSION = '2026-07-28'

/** Default per-request timeout (ms). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60000

/** Handshake timeout (ms): initialize must not hang plugin startup forever. */
export const INIT_TIMEOUT_MS = 15000

/** DeepSeek function-name contract: at most 64 chars. */
const MAX_PUBLIC_NAME_LENGTH = 64
/** DeepSeek function-name contract: only [A-Za-z0-9_-] is allowed. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
const HASH_LENGTH = 12

/** MCP protocol error (JSON-RPC error object or transport-level failure). */
export class MCPError extends Error {
  constructor(message, { code, data } = {}) {
    super(message)
    this.name = 'MCPError'
    this.code = code
    this.data = data
  }
}

/**
 * Derive the model-facing public name for one MCP tool, identical in spirit
 * to the official dsh-mcp-client naming contract: `mcp__<serverName>__<rawName>`
 * normalized to the DeepSeek function-name constraints. When replacement or
 * truncation changes the name, a deterministic 12-hex-char SHA-256 hash of
 * `(serverName, rawName)` is appended so distinct identities never collapse.
 *
 * @param serverName - stable local namespace from plugin config.
 * @param rawName - the MCP server's own tool name.
 * @returns the deterministic public ToolRuntime name.
 */
export function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/**
 * Extract a single text string from an MCP content block array.
 * - text blocks join with '\n'
 * - image / audio / resource / unknown blocks become placeholders
 * Defensive: required fields are guarded because the server is a trust boundary.
 */
export function extractText(mcpContent, toolName) {
  if (!Array.isArray(mcpContent)) return `(${toolName} returned no text content)`
  const parts = []
  for (const value of mcpContent) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      parts.push('[unsupported content type: unknown]')
      continue
    }
    switch (value.type) {
      case 'text':
        if (value.text !== undefined) parts.push(String(value.text))
        break
      case 'image':
        parts.push(`[image: ${value.mimeType ?? 'unknown'}, content discarded]`)
        break
      case 'audio':
        parts.push(`[audio: ${value.mimeType ?? 'unknown'}, content discarded]`)
        break
      case 'resource':
      case 'resource_link':
        parts.push('[resource: content discarded]')
        break
      default:
        parts.push(`[unsupported content type: ${value.type}]`)
    }
  }
  return parts.join('\n') || `(${toolName} returned no text content)`
}

/**
 * Normalize a raw `tools/call` result into the harness canonical shape:
 *   { content: JsonValue[], structuredContent?: JsonValue }
 * When the server returns `isError: true` the call is rejected so the
 * ToolRuntime's error path produces an `isError` result for the model.
 * A result without a content array (e.g. only `toolResult`) is projected to
 * a single text block.
 *
 * @throws {MCPError} when the server marks the result as an error.
 */
export function normalizeCallResult(result, toolName) {
  if (!result || typeof result !== 'object') {
    return { content: [{ type: 'text', text: `(${toolName} returned no output)` }] }
  }
  const content = Array.isArray(result.content) ? result.content : null
  if (content) {
    const text = extractText(content, toolName)
    if (result.isError === true) throw new MCPError(text)
    const out = { content }
    if (result.structuredContent !== undefined) out.structuredContent = result.structuredContent
    return out
  }
  const rendered = 'toolResult' in result ? JSON.stringify(result.toolResult) : JSON.stringify(result)
  if (result.isError === true) throw new MCPError(rendered)
  const out = { content: [{ type: 'text', text: rendered }] }
  if (result.structuredContent !== undefined) out.structuredContent = result.structuredContent
  return out
}

/**
 * MCP client for one server. Transport-agnostic JSON-RPC with per-request
 * timeout, abort support, pending-request correlation, and hooks for server
 * notifications and transport close.
 *
 * hooks:
 *   onClose(error?)      transport closed / failed (fires once per transport)
 *   onStderr(line)       stdio child stderr line (best-effort diagnostics)
 *   onToolsChanged()     `notifications/tools/list_changed` received
 */
export class McpClient {
  constructor(config, hooks = {}) {
    this.config = config
    this.hooks = hooks
    this.transport = null
    this.closed = false
    this.serverInfo = null
    this.negotiatedProtocolVersion = PROTOCOL_VERSION
    this._nextId = 1
    this._pending = new Map()
  }

  /**
   * Start the transport and run the initialize handshake. Rejects (and closes
   * the transport) on any failure so the supervisor can schedule a reconnect.
   */
  async connect() {
    if (this.transport) throw new MCPError('mcp-client-v2: already connected')
    const transport = createTransport(this.config, {
      onMessage: (message) => this._onMessage(message),
      onClose: (error) => this._onTransportClose(error),
      onStderr: (line) => {
        if (typeof this.hooks.onStderr === 'function') this.hooks.onStderr(line)
      },
    })
    this.transport = transport
    try {
      await transport.start()
      const init = await this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'dsh-mcp-client-v2', version: '0.2.0' },
      }, { timeoutMs: INIT_TIMEOUT_MS })
      this.serverInfo = (init && init.serverInfo) || null
      if (init && typeof init.protocolVersion === 'string') this.negotiatedProtocolVersion = init.protocolVersion
      await this.notify('notifications/initialized')
    } catch (error) {
      await this.close()
      throw error
    }
  }

  /** Fetch one raw `tools/list` page: { tools, nextCursor? }. */
  async listTools(cursor) {
    const params = cursor === undefined ? {} : { cursor }
    return this.request('tools/list', params)
  }

  /** Drain the full paginated tool list via lib/paginate.js. */
  async listAllTools({ maxPages = 20 } = {}) {
    const { collectTools } = await import('./paginate.js')
    return collectTools(
      () => this.listTools(),
      (cursor) => this.listTools(cursor),
      { maxPages },
    )
  }

  /**
   * Call one tool by its RAW MCP name (the public name is never sent on the
   * wire). Returns the normalized canonical result; rejects with MCPError on
   * timeout, abort, transport failure, or server-side isError.
   */
  async callTool(name, args, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal } = {}) {
    const result = await this.request('tools/call', {
      name,
      arguments: args && typeof args === 'object' ? args : {},
    }, { timeoutMs, signal })
    return normalizeCallResult(result, name)
  }

  /** Send a JSON-RPC request and await its correlated response. */
  request(method, params, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal } = {}) {
    if (this.closed) {
      return Promise.reject(new MCPError(`mcp-client-v2: connection closed; cannot send "${method}"`))
    }
    const id = this._nextId++
    return new Promise((resolve, reject) => {
      let timer = null
      let onAbort = null
      const entry = {
        resolve,
        reject,
      }
      const finish = (error) => {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        if (onAbort && signal) {
          signal.removeEventListener('abort', onAbort)
          onAbort = null
        }
        if (this._pending.delete(id)) reject(error)
      }
      this._pending.set(id, entry)
      timer = setTimeout(() => {
        finish(new MCPError(`mcp-client-v2: request "${method}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      if (signal) {
        if (signal.aborted) {
          finish(new MCPError(`mcp-client-v2: request "${method}" aborted`))
          return
        }
        onAbort = () => finish(new MCPError(`mcp-client-v2: request "${method}" aborted`))
        signal.addEventListener('abort', onAbort, { once: true })
      }
      try {
        const sent = this.transport.send({ jsonrpc: '2.0', id, method, params })
        if (sent && typeof sent.then === 'function') {
          sent.catch((error) => finish(error))
        }
      } catch (error) {
        finish(error)
      }
    })
  }

  /** Send a JSON-RPC notification (no id, no response). */
  notify(method, params) {
    if (this.closed) return
    try {
      const sent = this.transport.send({ jsonrpc: '2.0', method, params })
      if (sent && typeof sent.then === 'function') sent.catch(() => {})
    } catch {
      // transport-level failure surfaces through onClose / pending requests
    }
  }

  /** Route an inbound message: resolve a pending request or fire a notification hook. */
  _onMessage(message) {
    if (!message || typeof message !== 'object') return
    if (message.id !== undefined && message.id !== null) {
      const entry = this._pending.get(message.id)
      if (!entry) return
      this._pending.delete(message.id)
      if (message.error) {
        const err = message.error
        entry.reject(new MCPError(err.message || 'MCP request failed', {
          code: err.code,
          data: err.data,
        }))
      } else {
        entry.resolve(message.result)
      }
      return
    }
    if (message.method === 'notifications/tools/list_changed') {
      if (typeof this.hooks.onToolsChanged === 'function') this.hooks.onToolsChanged()
    }
  }

  /** Transport closed or failed: reject every pending request and notify. */
  _onTransportClose(error) {
    const pending = [...this._pending.values()]
    this._pending.clear()
    const message = error
      ? `mcp-client-v2: transport closed: ${error.message || String(error)}`
      : 'mcp-client-v2: transport closed'
    const err = error instanceof MCPError ? error : new MCPError(message)
    for (const entry of pending) entry.reject(err)
    if (typeof this.hooks.onClose === 'function') this.hooks.onClose(err)
  }

  /** Stop the transport and reject any straggler requests. */
  async close() {
    if (this.closed) return
    this.closed = true
    const transport = this.transport
    this.transport = null
    if (transport) {
      try {
        await transport.stop()
      } catch {
        // best effort
      }
    }
    const pending = [...this._pending.values()]
    this._pending.clear()
    const err = new MCPError('mcp-client-v2: client closed')
    for (const entry of pending) entry.reject(err)
  }
}

/** Transport factory: stdio or streamable-http by config.transport. */
export function createTransport(config, hooks) {
  if (config.transport === 'stdio') return createStdioTransport(config, hooks)
  if (config.transport === 'streamable-http') return createHttpTransport(config, hooks)
  throw new MCPError(`mcp-client-v2: unsupported transport "${config.transport}" (expected "stdio" or "streamable-http")`)
}

/**
 * stdio transport: spawn the configured command and speak newline-delimited
 * JSON-RPC over its stdin/stdout (MCP stdio framing). Stderr lines are
 * surfaced through hooks.onStderr. A child 'exit' or stdout 'end' closes the
 * transport; a spawn failure (ENOENT etc.) also closes it.
 */
function createStdioTransport(config, hooks) {
  let child = null
  let closed = false
  let startPromise = null
  let closeReported = false

  function reportClose(error) {
    if (closeReported) return
    closeReported = true
    if (typeof hooks.onClose === 'function') hooks.onClose(error)
  }

  async function start() {
    if (startPromise) return startPromise
    startPromise = new Promise((resolve, reject) => {
      const { command, args = [], env = {}, cwd = '' } = config
      const spawnOpts = {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
      if (typeof cwd === 'string' && cwd.length > 0) spawnOpts.cwd = cwd
      let spawned = false
      let settled = false
      const settle = (fn) => {
        if (settled) return
        settled = true
        fn()
      }

      let childProcess
      try {
        childProcess = spawn(command, args, spawnOpts)
      } catch (error) {
        settle(() => reject(error))
        return
      }
      child = childProcess

      childProcess.on('error', (error) => {
        settle(() => reject(error))
        reportClose(error)
      })
      childProcess.once('spawn', () => {
        spawned = true
        settle(() => resolve())
      })
      childProcess.on('exit', (code, signal) => {
        const detail = signal ? `signal ${signal}` : `code ${code}`
        if (spawned) settle(() => resolve())
        reportClose(new Error(`stdio process exited (${detail})`))
      })
      childProcess.stdout.on('end', () => {
        reportClose(new Error('stdio stdout ended'))
      })
      childProcess.stderr.on('data', (chunk) => {
        const text = String(chunk)
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim()
          if (trimmed && typeof hooks.onStderr === 'function') hooks.onStderr(trimmed)
        }
      })
      // Newline-delimited JSON framing with a manual line buffer
      // (node:stream only; no readline dependency).
      let buffer = ''
      childProcess.stdout.on('data', (chunk) => {
        buffer += String(chunk)
        let index
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (!line) continue
          let message
          try {
            message = JSON.parse(line)
          } catch {
            if (typeof hooks.onStderr === 'function') {
              hooks.onStderr(`non-JSON line from server: ${line.slice(0, 200)}`)
            }
            continue
          }
          if (typeof hooks.onMessage === 'function') hooks.onMessage(message)
        }
      })
    })
    return startPromise
  }

  function send(message) {
    if (closed || !child || child.stdin.destroyed) {
      throw new MCPError('mcp-client-v2: stdio transport is not running')
    }
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  async function stop() {
    if (closed) return
    closed = true
    const childProcess = child
    child = null
    if (!childProcess) return
    try {
      childProcess.stdin.end()
    } catch {
      // stdin already closed
    }
    try {
      childProcess.kill('SIGTERM')
    } catch {
      // already exited
    }
    const guard = setTimeout(() => {
      try {
        childProcess.kill('SIGKILL')
      } catch {
        // already gone
      }
    }, 2000)
    if (typeof guard.unref === 'function') guard.unref()
  }

  return { start, send, stop }
}

/**
 * streamable-http transport: POST JSON-RPC messages to the configured URL via
 * global fetch. Accepts application/json responses and text/event-stream
 * bodies (parsed minimally). Simplified request/response model: the server's
 * synchronous response body carries the reply; 202 Accepted (deferred/SSE
 * streaming sessions) is not supported and fails the request loudly.
 */
function createHttpTransport(config, hooks) {
  let url
  try {
    url = new URL(config.url)
  } catch (error) {
    throw new MCPError(`mcp-client-v2: invalid streamable-http url: ${config.url}`)
  }
  const baseHeaders = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': PROTOCOL_VERSION,
    ...(config.headers || {}),
  }
  let closed = false
  let sessionId = null

  async function start() {
    // The initialize request itself establishes the session; nothing to do.
  }

  async function send(message) {
    if (closed) throw new MCPError('mcp-client-v2: http transport closed')
    const headers = { ...baseHeaders }
    if (sessionId) headers['Mcp-Session-Id'] = sessionId
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
      })
    } catch (error) {
      if (!closed && typeof hooks.onClose === 'function') hooks.onClose(error)
      throw new MCPError(`mcp-client-v2: http request failed: ${error.message || String(error)}`)
    }
    const sessionHeader = response.headers.get('mcp-session-id')
    if (sessionHeader) sessionId = sessionHeader
    const contentType = (response.headers.get('content-type') || '').toLowerCase()
    if (response.status === 202) {
      throw new MCPError(
        `mcp-client-v2: server returned 202 Accepted for "${message.method}"; deferred/streaming sessions are not supported by this simplified HTTP transport`,
      )
    }
    const text = await response.text()
    if (!response.ok) {
      throw new MCPError(`mcp-client-v2: http ${response.status} ${response.statusText}: ${text.slice(0, 300)}`)
    }
    if (contentType.includes('text/event-stream')) {
      const messages = parseSse(text)
      for (const parsed of messages) {
        if (typeof hooks.onMessage === 'function') hooks.onMessage(parsed)
      }
      return
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new MCPError(`mcp-client-v2: non-JSON http response: ${text.slice(0, 200)}`)
    }
    if (typeof hooks.onMessage === 'function') hooks.onMessage(parsed)
  }

  async function stop() {
    closed = true
  }

  return { start, send, stop }
}

/**
 * Minimal SSE parser: split an event-stream body into `data:` lines and parse
 * each JSON-RPC payload. Non-JSON data lines (e.g. '[DONE]') are skipped.
 */
export function parseSse(body) {
  const messages = []
  const events = String(body).split(/\r?\n\r?\n/)
  for (const event of events) {
    for (const line of event.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        messages.push(JSON.parse(payload))
      } catch {
        // skip malformed event data
      }
    }
  }
  return messages
}
