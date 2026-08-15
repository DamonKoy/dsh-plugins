/**
 * dsh-secret-redactor
 * Sensitive-information redaction for DeepSeek Harness.
 *
 * Masks API keys, bearer tokens, JWTs, private keys and user-configured
 * secrets inside every tool result shown to the model (tools/post-execute
 * waterfall), registers `redact_text` / `redact_secret_status` model tools,
 * and exposes Package-private RPC (`secret-redactor/redact`,
 * `secret-redactor/status`).
 *
 * Rule engine lives in ./redact.js (pure, unit-tested).
 *
 * Config file: ~/.dsh/dsh-secret-redactor.json  (optional)
 *   {
 *     "enabled": true,
 *     "mask": "***",
 *     "disablePatterns": ["generic-mixed"],   // disable built-in rules by name
 *     "patterns": ["^custom-\\d{8}$"],        // extra regexes
 *     "extraSecrets": ["literal-secret-1"],
 *     "collectEnv": true,
 *     "collectSshPasswords": true
 *   }
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  BUILTIN_PATTERNS,
  buildRules,
  redactTextWithRules,
  collectEnvSecrets,
  collectSshPasswords,
  PATTERN_NAMES,
} from './redact.js'

const HOME = homedir()
const CONFIG_PATH = join(HOME, '.dsh', 'dsh-secret-redactor.json')
const SSH_CONFIG_PATH = join(HOME, '.dsh', 'dsh-ssh.json')

function loadConfig() {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) || {}
    }
  } catch {
    /* malformed or unreadable config: fall through to defaults */
  }
  return {}
}

function redactText(text) {
  return redactTextWithRules(text, buildRules(loadConfig(), { sshConfigPath: SSH_CONFIG_PATH }))
}

function redactValue(value, depth = 0) {
  if (value === null || value === undefined || depth > 8) return value
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value)) out[k] = redactValue(value[k], depth + 1)
    return out
  }
  return value
}

function status() {
  const cfg = loadConfig()
  const rules = buildRules(cfg, { sshConfigPath: SSH_CONFIG_PATH })
  const disabled = Array.isArray(cfg.disablePatterns) ? cfg.disablePatterns : []
  return {
    enabled: cfg.enabled !== false,
    configPath: CONFIG_PATH,
    builtinRuleCount: BUILTIN_PATTERNS.length,
    activeRuleCount: rules.length,
    activeBuiltinRules: PATTERN_NAMES.filter((n) => !disabled.includes(n)),
    disabledBuiltinRules: disabled.filter((n) => PATTERN_NAMES.includes(n)),
    collectedEnvSecrets: collectEnvSecrets().size,
    collectedSshPasswords: collectSshPasswords(SSH_CONFIG_PATH).size,
    mask: typeof cfg.mask === 'string' ? cfg.mask : '***',
  }
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
        console.warn(`[dsh-secret-redactor] defineTool failed for "${definition.name}": ${error.message || String(error)}; retrying with unconstrained parameters`)
        return harness.registerTool(ctx, harness.defineTool({ ...definition, parameters: { type: 'object', properties: {} } }))
      }
    }
    if (ctx && ctx.tools && typeof ctx.tools.register === 'function') {
      return ctx.tools.register(definition)
    }
    console.warn(`[dsh-secret-redactor] no tool registration API available; tool "${definition.name}" not registered`)
  } catch (error) {
    console.warn(`[dsh-secret-redactor] tool registration failed for "${definition.name}": ${error.message || String(error)}`)
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
      console.warn(`[dsh-secret-redactor] RPC registration failed for "${path}": ${error.message || String(error)}`)
    }
  }
  return undefined
}

export default {
  name: 'secret-redactor',
  inject: ['tools'],
  apply(ctx) {
    // Redact model-facing content of every tool result.
    ctx.on('tools/post-execute', async (exec, result, next) => {
      try {
        const cfg = loadConfig()
        if (cfg.enabled === false) return next()
        const content = result && Array.isArray(result.content) ? result.content : null
        if (content && content.length) {
          const replaced = content.map((block) => {
            if (block && block.type === 'text' && typeof block.text === 'string') {
              const t = redactText(block.text)
              return t === block.text ? block : { type: 'text', text: t }
            }
            return block
          })
          return { kind: 'accept', content: replaced }
        }
      } catch (err) {
        console.error('[dsh-secret-redactor] post-execute hook error:', err)
      }
      return next()
    })

    // Model tool: mask arbitrary text/JSON before it is logged or shown.
    registerTool(ctx, {
      name: 'redact_text',
      description:
        'Mask sensitive strings (API keys, bearer tokens, JWTs, private keys, connection-string passwords, configured secrets) in text or any JSON value before it is logged or shown. Use it before persisting, sharing, or echoing data that may contain credentials.',
      parameters: {
        value: { type: 'json', description: 'Text or JSON value to redact' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute(args) {
        return { value: redactValue(args.value) }
      },
    })

    // Model tool: report redactor state without leaking the secrets themselves.
    registerTool(ctx, {
      name: 'redact_secret_status',
      description:
        'Report dsh-secret-redactor state: enabled flag, built-in rule count, active/disabled rule names, how many environment secrets and SSH passwords are collected (counts only, never values), and the config path. Use it to verify the redactor is active.',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute() {
        return status()
      },
    })

    // Package-private RPC for client halves and other plugins.
    registerRpc('secret-redactor/redact', (args) => ({ value: redactValue(args && args.value) }))
    registerRpc('secret-redactor/status', () => status())
  },
}
