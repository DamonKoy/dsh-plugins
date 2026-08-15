# dsh-secret-redactor

Sensitive-information redaction plugin for DeepSeek Harness. Inspired by
Codex 0.147's "redact secrets from displayed commands and replayed
conversation history".

English | [中文](README.zh.md)

## What it does

- **Auto-redaction of tool results**: hooks the `tools/post-execute` waterfall
  and masks API keys, bearer tokens, JWTs, PEM private keys, and generic
  high-entropy tokens in every text block the model sees — verified live in a
  real harness session (`sk-abc123...` becomes `sk-***`).
- **Environment secret collection**: any env var whose name matches
  `TOKEN / KEY / SECRET / PASSWORD / PASSWD / CREDENTIAL / AUTH / SIGNING`
  (value length >= 8) is collected and masked when it appears in output.
- **SSH password collection**: passwords stored in `~/.dsh/dsh-ssh.json`
  are masked (opt-out via config).
- **`redact_text` model tool**: mask arbitrary text or JSON before it is
  logged, persisted, or echoed.
- **`redact_secret_status` model tool**: report rule count and collected
  secret counts (never the values) to verify the redactor is active.
- **Package-private RPC** (`harness.handle`): `secret-redactor/redact` and
  `secret-redactor/status` for client halves and other plugins.

## Install

```sh
dsh plugin --profile web add link:~/dsh-plugins/packages/dsh-secret-redactor
```

Restart `dsh web`. The redactor is active by default.

## Config

Optional file `~/.dsh/dsh-secret-redactor.json`:

```json
{
  "enabled": true,
  "mask": "***",
  "patterns": ["^custom-\\d{8}$"],
  "extraSecrets": ["literal-secret-1"],
  "collectEnv": true,
  "collectSshPasswords": true
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `mask` | `"***"` | Replacement text for user-supplied secrets/patterns |
| `patterns` | `[]` | Extra regexes applied with `g` flag |
| `extraSecrets` | `[]` | Literal strings to mask (length >= 4) |
| `collectEnv` | `true` | Collect matching env var values |
| `collectSshPasswords` | `true` | Collect `~/.dsh/dsh-ssh.json` passwords |

Config is re-read on every hook, so edits apply without a restart.

## Security notes

- Redaction applies to the model-facing content of tool results (the main
  leak surface). The durable log still stores the raw canonical result value;
  full log-level redaction is on the roadmap.
- Collected secrets live only in memory; nothing is persisted or uploaded.
- Counts reported by `redact_secret_status` never include the values.

## License

MIT
