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

export default {
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
    harness.registerTool(ctx, harness.defineTool({
      name: 'approval_policy_status',
      description:
        'Report the dsh-approve-for-me policy: current mode (off/review/auto), and whether the policy engine is active. Use it before running batches of commands to verify expected auto-approval behavior.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute() {
        return { mode: loadMode(), active: loadMode() !== 'off' }
      },
    }))

    // ---- RPC ----
    harness.handle('approve-for-me/status', () => ({ mode: loadMode(), active: loadMode() !== 'off' }))
    harness.handle('approve-for-me/set-mode', (args) => {
      const next = args && args.mode
      if (next === 'off' || next === 'review' || next === 'auto') {
        runtimeMode = next
        return { ok: true, mode: next }
      }
      return { ok: false, error: 'mode must be off | review | auto' }
    })
  },
}
