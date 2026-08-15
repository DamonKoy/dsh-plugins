/**
 * dsh-memories — project-scoped memory system.
 *
 * Model tools:
 *   memory_set(scope, key, value)     — upsert one memory
 *   memory_get(scope, key)            — read one memory
 *   memory_list(scope)                — list memories (newest first)
 *   memory_delete(scope, key)         — remove one memory
 *   memory_search(scope, query)       — substring search over keys and values
 *
 * Storage: ~/.dsh/dsh-memories/<scope>.json (scope defaults to 'global';
 * scopes are sanitized to [A-Za-z0-9._-]).
 *
 * Client RPC:
 *   memories/list, memories/get, memories/upsert, memories/remove, memories/scopes
 */
import * as store from './store.js'

// Register a model tool: prefer the harness.defineTool / harness.registerTool
// pair (sandbox / link-package realm) and fall back to the host-realm
// ctx.tools.register API used by official plugins. Never throws from apply.
function registerTool(ctx, definition) {
  try {
    if (typeof harness !== 'undefined' && harness && typeof harness.defineTool === 'function' && typeof harness.registerTool === 'function') {
      try {
        return harness.registerTool(ctx, harness.defineTool(definition))
      } catch (error) {
        console.warn(`[dsh-memories] defineTool failed for "${definition.name}": ${error.message || String(error)}; retrying with unconstrained parameters`)
        return harness.registerTool(ctx, harness.defineTool({ ...definition, parameters: { type: 'object', properties: {} } }))
      }
    }
    if (ctx && ctx.tools && typeof ctx.tools.register === 'function') {
      return ctx.tools.register(definition)
    }
    console.warn(`[dsh-memories] no tool registration API available; tool "${definition.name}" not registered`)
  } catch (error) {
    console.warn(`[dsh-memories] tool registration failed for "${definition.name}": ${error.message || String(error)}`)
  }
  return () => {}
}

// Package-private RPC is only available in the sandbox / link-package realm;
// in the host realm there is no harness, so registration is skipped.
function registerRpc(path, handler) {
  if (typeof harness !== 'undefined' && harness && typeof harness.handle === 'function') {
    try {
      return harness.handle(path, handler)
    } catch (error) {
      console.warn(`[dsh-memories] RPC registration failed for "${path}": ${error.message || String(error)}`)
    }
  }
  return undefined
}

function tool(name, description, parameters, execute) {
  return {
    name,
    description,
    // Function-calling APIs require an object-rooted parameters schema; the
    // call sites pass a DSL-style open property map, so wrap it here.
    parameters: { type: 'object', properties: parameters },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    execute,
  }
}

export default {
  name: 'memories',
  inject: ['tools'],
  apply(ctx) {
    registerTool(ctx, tool(
      'memory_set',
      'Persist one project-scoped memory (a durable key-value fact that should survive across sessions, e.g. conventions, decisions, credentials-free context). Value is stored as text. Use memory_list or memory_search before writing to avoid duplicates.',
      {
        scope: { type: 'string', description: 'Memory scope, usually the project name (default "global")' },
        key: { type: 'string', description: 'Memory key, e.g. "deploy-command"' },
        value: { type: 'string', description: 'Memory value (free text)' },
      },
      async (args) => store.set(args.scope, args.key, args.value),
    ))

    registerTool(ctx, tool(
      'memory_get',
      'Read one project-scoped memory by key.',
      {
        scope: { type: 'string', description: 'Memory scope (default "global")' },
        key: { type: 'string', description: 'Memory key' },
      },
      async (args) => {
        const e = store.get(args.scope, args.key)
        return e ? e : { key: args.key, value: null }
      },
    ))

    registerTool(ctx, tool(
      'memory_list',
      'List all memories in a scope, newest first. Values are truncated to a preview.',
      {
        scope: { type: 'string', description: 'Memory scope (default "global")' },
      },
      async (args) => {
        const entries = store.list(args.scope).map((e) => ({
          key: e.key,
          preview: e.value.slice(0, 200),
          updatedAt: e.updatedAt,
        }))
        return { scope: store.normalizeScope(args.scope), count: entries.length, entries }
      },
    ))

    registerTool(ctx, tool(
      'memory_delete',
      'Delete one project-scoped memory.',
      {
        scope: { type: 'string', description: 'Memory scope (default "global")' },
        key: { type: 'string', description: 'Memory key to delete' },
      },
      async (args) => store.remove(args.scope, args.key),
    ))

    registerTool(ctx, tool(
      'memory_search',
      'Search memories in a scope by substring over keys and values.',
      {
        scope: { type: 'string', description: 'Memory scope (default "global")' },
        query: { type: 'string', description: 'Search text' },
      },
      async (args) => {
        const hits = store.search(args.scope, args.query)
        return { scope: store.normalizeScope(args.scope), count: hits.length, hits: hits.map((e) => ({ key: e.key, preview: e.value.slice(0, 200), updatedAt: e.updatedAt })) }
      },
    ))

    // RPC for client halves / settings UIs.
    registerRpc('memories/scopes', () => ({ scopes: store.listScopes() }))
    registerRpc('memories/list', (args) => ({ scope: store.normalizeScope(args && args.scope), entries: store.list(args && args.scope) }))
    registerRpc('memories/get', (args) => store.get(args && args.scope, args && args.key))
    registerRpc('memories/upsert', (args) => store.set(args && args.scope, args && args.key, args && args.value))
    registerRpc('memories/remove', (args) => store.remove(args && args.scope, args && args.key))
  },
}
