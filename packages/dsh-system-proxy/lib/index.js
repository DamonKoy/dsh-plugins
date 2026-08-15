/**
 * dsh-system-proxy
 * System proxy support for DeepSeek Harness (user-space counterpart of the
 * Codex 0.143 PAC/WPAD system-proxy routing).
 *
 * What it does:
 *   - Detects the system proxy on macOS via `scutil --proxy` (HTTP/HTTPS
 *     proxies and PAC/WPAD URL) and on Linux/other via HTTP_PROXY /
 *     HTTPS_PROXY / ALL_PROXY / NO_PROXY environment variables.
 *   - `system_proxy_status` model tool: read-only report of the detected
 *     proxy plus plugin-config overrides.
 *   - `proxy_export` model tool: returns a bash export snippet
 *     (http_proxy / https_proxy / no_proxy) the model can paste into a
 *     terminal command so child processes use the proxy. Disabled unless
 *     allowExportEnv is true, because writing a proxy into child-process
 *     environment changes their network egress.
 *   - Package-private RPC `system-proxy/status` for client halves and other
 *     plugins (same payload as system_proxy_status).
 *
 * Explicit limitation: this plugin does NOT touch the DSH host process's own
 * LLM request network stack (that belongs to the core llm layer and is not
 * reachable from a plugin). It only detects, reports, and lets the model or
 * user explicitly enable the proxy for child processes / terminal commands.
 *
 * Config file: ~/.dsh/dsh-system-proxy.json  (optional)
 *   {
 *     "overrideHttp": "",                 // overrides detected http proxy
 *     "overrideHttps": "",                // overrides detected https proxy
 *     "overridePac": "",                  // overrides detected PAC URL
 *     "noProxy": "localhost,127.0.0.1,.local",
 *     "allowExportEnv": true              // false disables proxy_export
 *   }
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { detectSystemProxy } from './detect.js'

const CONFIG_PATH = join(homedir(), '.dsh', 'dsh-system-proxy.json')

const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,.local'
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//

function loadConfig() {
  try {
    if (existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
      if (cfg && typeof cfg === 'object') return cfg
    }
  } catch {
    /* malformed or unreadable config: fall through to defaults */
  }
  return {}
}

function str(val) {
  return typeof val === 'string' ? val.trim() : ''
}

/**
 * Effective status = plugin config overrides take precedence over the
 * system detection; the raw system values stay visible read-only in
 * `detected`.
 */
async function buildStatus() {
  const cfg = loadConfig()
  const detected = await detectSystemProxy()

  const overrideHttp = str(cfg.overrideHttp)
  const overrideHttps = str(cfg.overrideHttps)
  const overridePac = str(cfg.overridePac)
  const noProxy = str(cfg.noProxy) || DEFAULT_NO_PROXY

  return {
    platform: detected.platform,
    source: detected.source,
    viaEnv: detected.viaEnv,
    // Effective values (override first, then detection).
    httpProxy: overrideHttp || detected.httpProxy,
    httpsProxy: overrideHttps || detected.httpsProxy,
    pacUrl: overridePac || detected.pacUrl,
    noProxy,
    // Read-only view of what the system reported.
    detected: {
      httpProxy: detected.httpProxy,
      httpsProxy: detected.httpsProxy,
      pacUrl: detected.pacUrl,
    },
    // Plugin config overrides in effect.
    override: {
      httpProxy: overrideHttp,
      httpsProxy: overrideHttps,
      pacUrl: overridePac,
    },
    allowExportEnv: cfg.allowExportEnv !== false,
    configPath: CONFIG_PATH,
  }
}

function exportValue(value) {
  const v = str(value)
  if (!v) return ''
  return SCHEME_RE.test(v) ? v : `http://${v}`
}

/**
 * Build a bash export snippet from the effective status. PAC/WPAD URLs
 * cannot be expressed as environment variables, so a PAC-only config cannot
 * be exported.
 */
async function proxyExport() {
  const status = await buildStatus()

  if (status.allowExportEnv === false) {
    return {
      exported: false,
      reason:
        'proxy_export is disabled: allowExportEnv is false in ' +
        '~/.dsh/dsh-system-proxy.json. Enabling it would write the proxy ' +
        'into child-process environment variables and change their network ' +
        'egress, so it requires explicit user opt-in.',
    }
  }

  const httpProxy = exportValue(status.httpProxy)
  const httpsProxy = exportValue(status.httpsProxy)

  if (!httpProxy && !httpsProxy) {
    if (status.pacUrl) {
      return {
        exported: false,
        reason:
          `Detected proxy is a PAC/WPAD URL (${status.pacUrl}); a PAC ` +
          'cannot be expressed as environment variables. Fetch the PAC to ' +
          'resolve the proxy, or set overrideHttp / overrideHttps in ' +
          '~/.dsh/dsh-system-proxy.json.',
      }
    }
    return {
      exported: false,
      reason:
        'No proxy detected (source: ' + status.source + '). Nothing to export.',
    }
  }

  const lines = []
  const exportedVars = []
  if (httpProxy) {
    lines.push(`export http_proxy='${httpProxy.replace(/'/g, `'\\''`)}'`)
    exportedVars.push('http_proxy')
  }
  if (httpsProxy) {
    lines.push(`export https_proxy='${httpsProxy.replace(/'/g, `'\\''`)}'`)
    exportedVars.push('https_proxy')
  }
  if (status.noProxy) {
    lines.push(`export no_proxy='${status.noProxy.replace(/'/g, `'\\''`)}'`)
    exportedVars.push('no_proxy')
  }

  return {
    exported: true,
    shell: 'bash',
    command: lines.join('\n'),
    exportedVars,
  }
}

export default {
  apply(ctx) {
    // Model tool: read-only system proxy status (detection + overrides).
    harness.registerTool(ctx, harness.defineTool({
      name: 'system_proxy_status',
      description:
        'Report the system proxy configuration: detected HTTP/HTTPS proxy, ' +
        'PAC/WPAD URL, no_proxy list, detection source (scutil/env/none), ' +
        'and the plugin config overrides in effect. Pure read-only; use it ' +
        'before deciding whether child processes need a proxy.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute() {
        return buildStatus()
      },
    }))

    // Model tool: bash export snippet so child processes use the proxy.
    harness.registerTool(ctx, harness.defineTool({
      name: 'proxy_export',
      description:
        'Return a bash export snippet (http_proxy / https_proxy / no_proxy) ' +
        'that can be pasted into a terminal command so child processes use ' +
        'the detected or overridden system proxy. Sensitive: writing a proxy ' +
        'into child-process environment changes their network egress, so this ' +
        'tool is disabled when allowExportEnv is false in ' +
        '~/.dsh/dsh-system-proxy.json.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute() {
        return proxyExport()
      },
    }))

    // Package-private RPC for client halves and other plugins.
    harness.handle('system-proxy/status', async () => buildStatus())
  },
}
