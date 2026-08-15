/**
 * dsh-system-proxy - detection logic (pure, unit-testable).
 *
 * Detection sources:
 *   - macOS: `scutil --proxy` (HTTPEnable/HTTPProxy/HTTPPort,
 *     HTTPSEnable/HTTPSProxy/HTTPSPort, ProxyAutoConfigEnable/
 *     ProxyAutoConfigURLString). Falls back to environment variables when
 *     scutil is unavailable (spawn error, timeout, non-zero exit).
 *   - Linux / other: environment variables HTTP_PROXY / HTTPS_PROXY /
 *     ALL_PROXY / NO_PROXY (case-insensitive, both cases checked).
 *
 * Exported pure functions (no environment dependency):
 *   - parseScutilOutput(text) -> { httpProxy, httpsProxy, pacUrl, enabled }
 *   - detectFromEnv(env?)      -> { httpProxy, httpsProxy, pacUrl, noProxy,
 *                                   enabled }
 *
 * Exported orchestrator:
 *   - detectSystemProxy()      -> full result including platform / source /
 *                                 viaEnv. Never throws.
 */
import { execFile } from 'node:child_process'
import process from 'node:process'

const SCUTIL_PATH = '/usr/sbin/scutil'
const SCUTIL_TIMEOUT_MS = 5000

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//
const TRUTHY = new Set(['1', 'true', 'yes', 'on'])

/**
 * Build a proxy URL from a host and port. A host that already carries a
 * scheme is returned verbatim (handles overrides like
 * "http://user:pass@proxy:8080"). A port is appended only when it is a
 * plain number. The scheme is always http:// - HTTPS traffic also travels
 * through an HTTP proxy via CONNECT, which is what https_proxy means.
 */
export function formatProxyUrl(host, port) {
  const h = typeof host === 'string' ? host.trim() : ''
  if (!h) return null
  if (SCHEME_RE.test(h)) return h
  const p = typeof port === 'string' ? port.trim() : ''
  if (/^\d+$/.test(p)) return `http://${h}:${p}`
  return `http://${h}`
}

/**
 * Parse the raw stdout of `scutil --proxy` (a plist-style dictionary dump)
 * into a normalized proxy config. Never throws.
 *
 * Sample input:
 *   <dictionary> {
 *     HTTPEnable : 1
 *     HTTPProxy : 192.168.1.1
 *     HTTPPort : 8080
 *     HTTPSEnable : 1
 *     HTTPSProxy : 192.168.1.1
 *     HTTPSPort : 8443
 *     ProxyAutoConfigEnable : 0
 *     ProxyAutoConfigURLString : <empty>
 *     SOCKSEnable : 0
 *   }
 */
export function parseScutilOutput(text) {
  const out = {
    httpProxy: null,
    httpsProxy: null,
    pacUrl: null,
    enabled: false,
  }
  if (typeof text !== 'string') return out

  const values = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z]\w*)\s*:\s*(.*?)\s*$/)
    if (!m) continue
    // scutil prints "<empty>" for unset string keys.
    values[m[1]] = m[2] === '<empty>' ? '' : m[2]
  }

  const enabledFlag = (key) => TRUTHY.has(String(values[key] || '').trim().toLowerCase())
  const httpHost = enabledFlag('HTTPEnable') ? values.HTTPProxy : ''
  const httpsHost = enabledFlag('HTTPSEnable') ? values.HTTPSProxy : ''
  const pacActive = enabledFlag('ProxyAutoConfigEnable') && values.ProxyAutoConfigURLString

  out.httpProxy = formatProxyUrl(httpHost, values.HTTPPort)
  out.httpsProxy = formatProxyUrl(httpsHost, values.HTTPSPort)
  out.pacUrl = pacActive ? values.ProxyAutoConfigURLString : null
  out.enabled = Boolean(out.httpProxy || out.httpsProxy || out.pacUrl)
  return out
}

/** Normalize an env proxy value: prepend http:// when no scheme is present. */
function normalizeEnvProxy(value) {
  const v = typeof value === 'string' ? value.trim() : ''
  if (!v) return null
  if (SCHEME_RE.test(v)) return v
  return `http://${v}`
}

/**
 * Detect a proxy from an environment-like object (defaults to process.env).
 * Case-insensitive: checks both HTTP_PROXY and http_proxy, and so on.
 * ALL_PROXY acts as a fallback for http/https when the specific var is unset.
 */
export function detectFromEnv(env = process.env) {
  const get = (name) => {
    const lower = name.toLowerCase()
    const raw = env[name] || env[lower]
    return typeof raw === 'string' ? raw.trim() : ''
  }
  const httpRaw = get('HTTP_PROXY')
  const httpsRaw = get('HTTPS_PROXY')
  const allRaw = get('ALL_PROXY')
  const noProxyRaw = get('NO_PROXY')

  const httpProxy = normalizeEnvProxy(httpRaw || allRaw)
  const httpsProxy = normalizeEnvProxy(httpsRaw || allRaw)

  return {
    httpProxy,
    httpsProxy,
    pacUrl: null,
    noProxy: noProxyRaw || null,
    enabled: Boolean(httpProxy || httpsProxy),
  }
}

/** Run `scutil --proxy`; resolves stdout on success, rejects otherwise. */
function runScutil() {
  return new Promise((resolve, reject) => {
    execFile(SCUTIL_PATH, ['--proxy'], { timeout: SCUTIL_TIMEOUT_MS }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

/**
 * Full detection orchestration. Never throws.
 *
 * macOS: prefer scutil. When scutil is unavailable (missing binary, spawn
 * error, timeout, empty output) fall back to environment variables.
 * Other platforms: environment variables only.
 *
 * Result: { platform, source, viaEnv, httpProxy, httpsProxy, pacUrl,
 *           noProxy, enabled }
 *   source: 'scutil' | 'env' | 'none'
 *   viaEnv: true when the reported values came from environment variables.
 */
export async function detectSystemProxy() {
  const platform = process.platform

  if (platform === 'darwin') {
    try {
      const text = await runScutil()
      if (text) {
        const parsed = parseScutilOutput(text)
        return {
          platform,
          source: 'scutil',
          viaEnv: false,
          httpProxy: parsed.httpProxy,
          httpsProxy: parsed.httpsProxy,
          pacUrl: parsed.pacUrl,
          noProxy: null,
          enabled: parsed.enabled,
        }
      }
    } catch {
      /* scutil unavailable: degrade to environment variables below */
    }
  }

  const env = detectFromEnv()
  if (env.enabled) {
    return { platform, source: 'env', viaEnv: true, ...env }
  }
  return {
    platform,
    source: 'none',
    viaEnv: false,
    httpProxy: null,
    httpsProxy: null,
    pacUrl: null,
    noProxy: env.noProxy,
    enabled: false,
  }
}
