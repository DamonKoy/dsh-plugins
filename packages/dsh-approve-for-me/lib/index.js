/**
 * dsh-approve-for-me
 * Automated approval review for DeepSeek Harness.
 *
 * Hooks:
 *  - `approval/request` (waterfall): auto-approves read-only tools in
 *    'review' mode, auto-approves everything in 'auto' mode, and auto-denies
 *    dangerous shell commands in both modes. Anything else falls through to
 *    the human answerer via `next()`.
 *  - `tools/pre-execute` (waterfall): hard-blocks dangerous shell commands
 *    before dispatch, so they never even reach the approval prompt.
 *
 * Config file: ~/.dsh/dsh-approve-for-me.json
 *   { "mode": "review" }   // 'off' | 'review' | 'auto'
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { decide, classifyCommand } from './policy.js'

const CONFIG_PATH = join(homedir(), '.dsh', 'dsh-approve-for-me.json')

let runtimeMode = null // null → resolve from config each decision

function loadMode() {
  if (runtimeMode) return runtimeMode
  try {
    if (existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
      if (cfg.mode === 'off' || cfg.mode === 'review' || cfg.mode === 'auto') return cfg.mode
    }
  } catch {
    /* fall through */
  }
  return 'review'
}

function commandOf(exec) {
  const args = exec && exec.args
  if (!args) return undefined
  if (typeof args.command === 'string') return args.command
  if (typeof args.code === 'string') return args.code
  return undefined
}

// Register a model tool: prefer the harness.defineTool / harness.registerTool
// pair (sandbox / link-package realm) and fall back to the host-realm
// ctx.tools.register API used by official plugins. Never throws from apply.
function registerTool(ctx, definition) {
  try {
    if (typeof harness !== 'undefined' && harness && typeof harness.defineTool === 'function' && typeof harness.registerTool === 'function') {
      try {
        return harness.registerTool(ctx, harness.defineTool(definition))
      } catch (error) {
        console.warn(`[dsh-approve-for-me] defineTool failed for "${definition.name}": ${error.message || String(error)}; retrying with unconstrained parameters`)
        return harness.registerTool(ctx, harness.defineTool({ ...definition, parameters: { type: 'object', properties: {} } }))
      }
    }
    if (ctx && ctx.tools && typeof ctx.tools.register === 'function') {
      return ctx.tools.register(definition)
    }
    console.warn(`[dsh-approve-for-me] no tool registration API available; tool "${definition.name}" not registered`)
  } catch (error) {
    console.warn(`[dsh-approve-for-me] tool registration failed for "${definition.name}": ${error.message || String(error)}`)
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
      console.warn(`[dsh-approve-for-me] RPC registration failed for "${path}": ${error.message || String(error)}`)
    }
  }
  return undefined
}

export default {
  name: 'approve-for-me',
  inject: ['tools'],
  apply(ctx) {
    // ---- approval/request: claim decisions the policy can make ----
    ctx.on('approval/request', async (req, next) => {
      const mode = loadMode()
      if (mode === 'off') return next()
      // Command-level danger checks happen in tools/pre-execute before any
      // approval is asked; here we decide on the tool identity alone.
      const decision = decide({ mode, toolName: req.toolName })
      if (decision === 'allow') return 'allowed-once'
      if (decision === 'deny') return 'rejected'
      return next()
    })

    // ---- tools/pre-execute: hard-block dangerous commands pre-dispatch ----
    ctx.on('tools/pre-execute', async (exec, next) => {
      const mode = loadMode()
      if (mode === 'off') return next()
      if (exec.name === 'bash' || exec.name === 'pwsh' || exec.name === 'ssh_exec' || exec.name === 'ssh_cluster') {
        const command = commandOf(exec)
        if (classifyCommand(command) === 'dangerous') {
          return { kind: 'deny', reason: `dsh-approve-for-me: command matches a dangerous pattern and was auto-denied (mode=${mode})` }
        }
      }
      return next()
    })

    // ---- status tool ----
    registerTool(ctx, {
      name: 'approval_policy_status',
      description:
        'Report the dsh-approve-for-me policy: current mode (off/review/auto), and whether the policy engine is active. Use it before running batches of commands to verify expected auto-approval behavior.',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute() {
        return { mode: loadMode(), active: loadMode() !== 'off' }
      },
    })

    // ---- RPC ----
    registerRpc('approve-for-me/status', () => ({ mode: loadMode(), active: loadMode() !== 'off' }))
    registerRpc('approve-for-me/set-mode', (args) => {
      const next = args && args.mode
      if (next === 'off' || next === 'review' || next === 'auto') {
        runtimeMode = next
        return { ok: true, mode: next }
      }
      return { ok: false, error: 'mode must be off | review | auto' }
    })
  },
}
