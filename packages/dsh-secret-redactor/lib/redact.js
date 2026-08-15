/**
 * dsh-secret-redactor rule engine — pure, unit-testable.
 *
 * A rule is { name, re, mask, keep? }:
 *   - `mask` is the replacement string; `$1`… capture-group references are
 *     honored (native String.replace semantics).
 *   - `keep` (optional) keeps the first N characters of the match and appends
 *     `mask` — used to preserve recognizable type prefixes (sk-***).
 *
 * Built-in rules are ordered: specific shapes first (data URIs before the
 * generic base64 rule, credential-bearing URLs before the generic token
 * rule), so earlier matches win and generic rules never see already-masked
 * material.
 */
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'

/** All built-in patterns, in application order. */
export const BUILTIN_PATTERNS = [
  // --- Vendor API key shapes (prefixed, unambiguous) ---
  { name: 'sk-openai', re: /sk-[A-Za-z0-9_-]{12,}/g, keep: 3 },
  { name: 'gh-tokens', re: /gh[pousr]_[A-Za-z0-9]{20,}/g, keep: 3 },
  { name: 'aws-akid', re: /\bAKIA[0-9A-Z]{16}\b/g, keep: 4 },
  { name: 'slack', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, keep: 3 },
  { name: 'google-api', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, keep: 4 },
  { name: 'huggingface', re: /\bhf_[A-Za-z0-9]{30,}\b/g, keep: 3 },
  { name: 'gitlab', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, keep: 6 },
  { name: 'bitbucket', re: /\bATBB[A-Za-z0-9]{24}\b/g, keep: 4 },
  { name: 'aliyun', re: /\bLTAI[0-9A-Za-z]{12,}\b/g, keep: 4 },
  { name: 'tencent', re: /\bAKID[0-9A-Za-z]{13,}\b/g, keep: 4 },
  { name: 'stripe', re: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/g, keep: 3 },
  { name: 'npm', re: /\bnpm_[A-Za-z0-9]{30,}\b/g, keep: 4 },
  { name: 'telegram', re: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/g, keep: 10 },
  { name: 'sendgrid', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{40,}\b/g, keep: 3 },
  { name: 'digitalocean', re: /\bdop_v1_[A-Za-z0-9_-]{50,}\b/g, keep: 7 },
  { name: 'shopify', re: /\bshpat_[A-Za-z0-9]{32}\b/g, keep: 6 },

  // --- Structured credential blocks ---
  {
    name: 'pem-private-key',
    re: /-----BEGIN(?:[A-Z0-9 ]*)PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END(?:[A-Z0-9 ]*)PRIVATE KEY(?: BLOCK)?-----/g,
    mask: '***PRIVATE KEY BLOCK***',
  },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, keep: 7 },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, mask: '***JWT***' },

  // --- Contextual credentials ---
  // data: URIs carry base64 payloads; mask the payload, keep the mime label.
  // Must run before the generic base64 rule. No whitespace in the class so a
  // trailing newline after the payload is never swallowed.
  {
    name: 'data-uri',
    re: /\b(data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,)[A-Za-z0-9+/=]{16,}/gi,
    mask: '$1***',
  },
  // scheme://user:password@ — mask the credential part, keep the scheme.
  // Only URLs that carry a password are masked (https://user@host stays).
  {
    name: 'url-credentials',
    re: /([a-z][a-z0-9+.-]*:\/\/)[^/@\s:]+:[^/@\s]+@/gi,
    mask: '$1***@',
  },
  // key = value pairs with a sensitive key name and a value >= 8 chars.
  // Supports quoted keys (JSON style) and preserves the original format:
  //   "password": "correct-horse-battery" -> "password": "***"
  //   apiKey=abcd1234efgh5678            -> apiKey=***
  {
    name: 'key-value',
    re: /(['"]?)\b(api[_-]?key|secret|passwd|password|access[_-]?token|auth[_-]?token|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key)\1(\s*[=:]\s*['"]?)([^'"\s,;{}[\]().]{8,64})/gi,
    mask: '$1$2$1$3***',
  },

  // --- Generic high-entropy fallbacks (strict, to avoid false positives) ---
  // 32+ hex with mixed case and digits (git commit hashes are lowercase-only
  // and UUIDs contain dashes, so neither matches).
  {
    name: 'hex-mixed',
    re: /\b(?=[0-9a-fA-F]{32,})(?=.*[a-f])(?=.*[A-F])(?=.*[0-9])[0-9a-fA-F]{32,}\b/g,
    mask: '***',
  },
  // 64+ base64-looking text with mixed case and digits.
  {
    name: 'base64-mixed',
    re: /\b(?=[A-Za-z0-9+/]{64,})(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])[A-Za-z0-9+/]{64,}={0,2}\b/g,
    mask: '***',
  },
  // 40+ identifier-shaped text with mixed case and digits. Plain tool names,
  // file names and long lowercase words never match (no uppercase/digits).
  {
    name: 'generic-mixed',
    re: /\b(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{40,}\b/g,
    mask: '***',
  },
]

export const PATTERN_NAMES = BUILTIN_PATTERNS.map((p) => p.name)

/** Names that match env vars likely to hold secrets. */
export const ENV_NAME_RE = /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|SIGNING)/i

export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Collect values of env vars whose NAME looks secret (never returns names). */
export function collectEnvSecrets(env = process.env) {
  const out = new Set()
  for (const [name, val] of Object.entries(env)) {
    if (!val || val.length < 8) continue
    if (ENV_NAME_RE.test(name)) out.add(val)
  }
  return out
}

/** Collect passwords from a dsh-ssh-style JSON file, if present. */
export function collectSshPasswords(sshConfigPath) {
  const out = new Set()
  try {
    if (existsSync(sshConfigPath)) {
      const data = JSON.parse(readFileSync(sshConfigPath, 'utf8'))
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

/**
 * Compose the effective rule list from the config.
 * @param {object} cfg plugin config (see README)
 * @param {object} [io] injectable environment for tests
 *   ({ env, sshConfigPath })
 * @returns {Array<{name?: string, re: RegExp, mask: string, keep?: number}>}
 */
export function buildRules(cfg = {}, io = {}) {
  const env = io.env || process.env
  const sshConfigPath = io.sshConfigPath
  const mask = typeof cfg.mask === 'string' ? cfg.mask : '***'
  const disabled = new Set(Array.isArray(cfg.disablePatterns) ? cfg.disablePatterns : [])

  const rules = []
  for (const p of BUILTIN_PATTERNS) {
    if (disabled.has(p.name)) continue
    rules.push({ name: p.name, re: p.re, mask: p.mask, keep: p.keep })
  }
  if (cfg.collectEnv !== false) {
    for (const s of collectEnvSecrets(env)) {
      rules.push({ name: 'env', re: new RegExp(escapeRegExp(s), 'g'), mask })
    }
  }
  if (cfg.collectSshPasswords !== false && sshConfigPath) {
    for (const s of collectSshPasswords(sshConfigPath)) {
      rules.push({ name: 'ssh-password', re: new RegExp(escapeRegExp(s), 'g'), mask })
    }
  }
  if (Array.isArray(cfg.patterns)) {
    for (const p of cfg.patterns) {
      try {
        rules.push({ name: 'custom', re: new RegExp(p, 'g'), mask })
      } catch {
        /* skip invalid user regex */
      }
    }
  }
  if (Array.isArray(cfg.extraSecrets)) {
    for (const s of cfg.extraSecrets) {
      if (typeof s === 'string' && s.length >= 4) rules.push({ name: 'extra', re: new RegExp(escapeRegExp(s), 'g'), mask })
    }
  }
  return rules
}

/** Apply one rule to one string. `keep` preserves a type prefix. */
export function applyRule(text, rule) {
  const mask = rule.mask || '***'
  if (rule.keep != null) {
    return text.replace(rule.re, (m) => m.slice(0, rule.keep) + mask)
  }
  return text.replace(rule.re, mask)
}

/** Redact one string with an explicit rule list. */
export function redactTextWithRules(text, rules) {
  let out = String(text)
  for (const rule of rules) out = applyRule(out, rule)
  return out
}

/** Redact one string using the plugin config (convenience for the plugin). */
export function redactText(text, cfg = {}) {
  return redactTextWithRules(text, buildRules(cfg))
}
