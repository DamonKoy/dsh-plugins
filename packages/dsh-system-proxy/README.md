# dsh-system-proxy

System proxy support for DeepSeek Harness. Inspired by the PAC/WPAD system
proxy routing in Codex 0.143 — implemented as a user-space plugin.

English | [中文](README.zh.md)

## What it does

- **System proxy detection**:
  - macOS: reads `scutil --proxy` and extracts the HTTP/HTTPS proxies and the
    PAC/WPAD URL (`HTTPEnable` / `HTTPProxy` / `HTTPPort`, `HTTPSEnable` /
    `HTTPSProxy` / `HTTPSPort`, `ProxyAutoConfigEnable` /
    `ProxyAutoConfigURLString`). Degrades gracefully to environment variables
    when `scutil` is unavailable.
  - Linux / other: reads `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` /
    `NO_PROXY` from the environment (both cases, `ALL_PROXY` as fallback).
- **`system_proxy_status` model tool**: read-only report of the detected
  proxy, the plugin-config overrides in effect, detection source
  (`scutil` / `env` / `none`) and the `no_proxy` list.
- **`proxy_export` model tool**: returns a bash snippet
  (`export http_proxy=... https_proxy=... no_proxy=...`) the model can paste
  into a terminal command so child processes use the proxy.
- **Package-private RPC** (`harness.handle`, sandbox realm only; skipped when
  loaded via CLI): `system-proxy/status` for client halves and other plugins —
  same payload as `system_proxy_status`.

## Install

```sh
dsh plugin --profile web add github:DamonKoy/dsh-plugins#path:/packages/dsh-system-proxy
```

Restart `dsh web`.

## Config

Optional file `~/.dsh/dsh-system-proxy.json`:

```json
{
  "overrideHttp": "",
  "overrideHttps": "",
  "overridePac": "",
  "noProxy": "localhost,127.0.0.1,.local",
  "allowExportEnv": true
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `overrideHttp` | `""` | Overrides the detected HTTP proxy (empty = use detection) |
| `overrideHttps` | `""` | Overrides the detected HTTPS proxy |
| `overridePac` | `""` | Overrides the detected PAC/WPAD URL |
| `noProxy` | `"localhost,127.0.0.1,.local"` | `no_proxy` list used by `proxy_export` |
| `allowExportEnv` | `true` | `false` disables `proxy_export` (see Security notes) |

Config is re-read on every call, so edits apply without a restart. The
detected system values stay visible read-only in the `detected` field; the
`override*` fields only win when non-empty.

## Example outputs

`system_proxy_status` (macOS with `scutil`):

```json
{
  "platform": "darwin",
  "source": "scutil",
  "viaEnv": false,
  "httpProxy": "http://192.168.1.1:8080",
  "httpsProxy": "http://192.168.1.1:8443",
  "pacUrl": null,
  "noProxy": "localhost,127.0.0.1,.local",
  "detected": {
    "httpProxy": "http://192.168.1.1:8080",
    "httpsProxy": "http://192.168.1.1:8443",
    "pacUrl": null
  },
  "override": { "httpProxy": "", "httpsProxy": "", "pacUrl": "" },
  "allowExportEnv": true,
  "configPath": "/Users/you/.dsh/dsh-system-proxy.json"
}
```

`proxy_export` (success):

```json
{
  "exported": true,
  "shell": "bash",
  "command": "export http_proxy='http://192.168.1.1:8080'\nexport https_proxy='http://192.168.1.1:8443'\nexport no_proxy='localhost,127.0.0.1,.local'",
  "exportedVars": ["http_proxy", "https_proxy", "no_proxy"]
}
```

`proxy_export` returns `{ "exported": false, "reason": "..." }` when no proxy
is detected, when only a PAC URL is present (PAC cannot be expressed as
environment variables), or when `allowExportEnv` is `false`.

## Platform differences

| Platform | Detection | Notes |
| --- | --- | --- |
| macOS | `scutil --proxy` | Falls back to env vars when `scutil` fails or is absent |
| Linux | env vars only | `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` |
| Windows | env vars only | Same as Linux (no registry/WinINET probing) |

HTTPS proxies are reported as `http://` URLs — HTTPS traffic goes through an
HTTP proxy via CONNECT, which is what `https_proxy` means everywhere.

## Security notes

- `proxy_export` writes the proxy into child-process environment variables,
  which changes their network egress — that is a security-sensitive
  operation. Set `"allowExportEnv": false` in the config to disable it
  entirely; the tool then returns a denial reason.
- Proxy values may contain credentials (`user:pass@host`) if you put them in
  `override*` fields or the environment; they are stored in your home-dir
  config file and appear in tool output.
- This plugin does **not** modify the DSH host process's own LLM request
  network stack — that belongs to the core `llm` layer and is not reachable
  from a plugin. It is the *user-space* version of Codex system proxy
  support: detection, status queries, and explicit opt-in for child
  processes / terminal commands.
- Detection is read-only; nothing is persisted or uploaded.

## License

MIT
