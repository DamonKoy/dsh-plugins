/**
 * dsh-secret-redactor
 * Sensitive-information redaction for DeepSeek Harness.
 *
 * Masks API keys, bearer tokens, JWTs, private keys and user-configured
 * secrets inside every tool result shown to the model (tools/post-execute
 * waterfall), registers a `redact_text` model tool, and exposes
 * Package-private RPC (`secret-redactor/redact`, `secret-redactor/status`)
 * for client halves and other plugins.
 *
 * Config file: ~/.dsh/dsh-secret-redactor.json  (optional)
 *   {
 *     "enabled": true,
 *     "mask": "***",
 *     "patterns": ["^custom-\\\\d{8}$"],   // extra regexes (full match)
 *     "extraSecrets": ["literal-secret-1"],
 *     "collectEnv": true,
 *     "collectSshPasswords": true
 *   }
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const HOME = homedir()
const CONFIG_PATH = join(HOME, '.dsh', 'dsh-secret-redactor.json')
const SSH_CONFIG_PATH = join(HOME, '.dsh', 'dsh-ssh.json')

// Default shapes — every built-in pattern is applied as a global regex.
const BUILTIN_PATTERNS = [
  // OpenAI / DeepSeek style API keys
  { re: /sk-[A-Za-z0-9_-]{12,}/g, mask: 'sk-***' },
  // GitHub tokens (pat/oauth/user/server/refresh)
  { re: /gh[pousr]_[A-Za-z0-9]{20,}/g, mask: 'gh***' },
  // AWS access key id
  { re: /AKIA[0-9A-Z]{16}/g, mask: 'AKIA***' },
  // Slack tokens
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, mask: 'xox***' },
  // PEM private key blocks
  {
    re: /-----BEGIN(?:[A-Z ]*)PRIVATE KEY-----\n[\s\S]*?-----END(?:[A-Z ]*)PRIVATE KEY-----/g,
    mask: '***PRIVATE KEY BLOCK***',
  },
  // Authorization bearer headers
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, mask: 'Bearer ***' },
  // JWTs (header.payload.signature)
  {
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    mask: '***JWT***',
  },
  // Generic long high-entropy tokens (>= 32 chars of mixed alnum)
  { re: /\b[A-Za-z0-9_-]{32,}\b/g, mask: '***' },
]

const ENV_NAME_RE = /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|SIGNING)/i

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

function collectEnvSecrets() {
  const out = new Set()
  for (const [name, val] of Object.entries(process.env)) {
    if (!val || val.length < 8) continue
    if (ENV_NAME_RE.test(name)) out.add(val)
  }
  return out
}

function collectSshPasswords() {
  const out = new Set()
  try {
    if (existsSync(SSH_CONFIG_PATH)) {
      const data = JSON.parse(readFileSync(SSH_CONFIG_PATH, 'utf8'))
      const hosts = Array.isArray(data) ? data : data.hosts
      if (Array.isArray(hosts)) {
        for (const h of hosts) {
          if (h && typeof h.password === 'string' && h.password.length >= 6) out.add(h.password)
        }
      }
    }
  } catch {
    /* config not present or unreadable: nothing to collect */
  }
  return out
}

function buildRules() {
  const cfg = loadConfig()
  const rules = []
  const mask = typeof cfg.mask === 'string' ? cfg.mask : '***'
  for (const p of BUILTIN_PATTERNS) rules.push({ re: p.re, mask: p.mask })
  if (cfg.collectEnv !== false) {
    for (const s of collectEnvSecrets()) {
      rules.push({ re: new RegExp(escapeRegExp(s), 'g'), mask })
    }
  }
  if (cfg.collectSshPasswords !== false) {
    for (const s of collectSshPasswords()) {
      rules.push({ re: new RegExp(escapeRegExp(s), 'g'), mask })
    }
  }
  if (Array.isArray(cfg.patterns)) {
    for (const p of cfg.patterns) {
      try {
        rules.push({ re: new RegExp(p, 'g'), mask })
      } catch {
        /* skip invalid user regex */
      }
    }
  }
  if (Array.isArray(cfg.extraSecrets)) {
    for (const s of cfg.extraSecrets) {
      if (typeof s === 'string' && s.length >= 4) rules.push({ re: new RegExp(escapeRegExp(s), 'g'), mask })
    }
  }
  return rules
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function redactText(text) {
  let out = String(text)
  for (const rule of buildRules()) out = out.replace(rule.re, rule.mask)
  return out
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
  return {
    enabled: cfg.enabled !== false,
    configPath: CONFIG_PATH,
    ruleCount: buildRules().length,
    collectedEnvSecrets: collectEnvSecrets().size,
    collectedSshPasswords: collectSshPasswords().size,
    mask: typeof cfg.mask === 'string' ? cfg.mask : '***',
  }
}

export default {
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
    harness.registerTool(ctx, harness.defineTool({
      name: 'redact_text',
      description:
        'Mask sensitive strings (API keys, bearer tokens, JWTs, private keys, configured secrets) in text or any JSON value before it is logged or shown. Use it before persisting, sharing, or echoing data that may contain credentials.',
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
    }))

    // Model tool: report redactor state without leaking the secrets themselves.
    harness.registerTool(ctx, harness.defineTool({
      name: 'redact_secret_status',
      description:
        'Report dsh-secret-redactor state: enabled flag, rule count, how many environment secrets and SSH passwords are collected (counts only, never values), and the config path. Use it to verify the redactor is active.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute() {
        return status()
      },
    }))

    // Package-private RPC for client halves and other plugins.
    harness.handle('secret-redactor/redact', (args) => ({ value: redactValue(args && args.value) }))
    harness.handle('secret-redactor/status', () => status())
  },
}
