# dsh-secret-redactor

Sensitive-information redaction plugin for DeepSeek Harness. Inspired by
Codex 0.147's "redact secrets from displayed commands and replayed
conversation history".

English | [中文](README.zh.md)

## What it does

- **Auto-redaction of tool results**: hooks the `tools/post-execute` waterfall
  and masks secrets in every text block the model sees — verified live in a
  real harness session (`sk-abc123...` becomes `sk-***`).
- **25 built-in rules** (see [Rule catalog](#rule-catalog)) covering vendor
  API keys, PEM private keys, bearer tokens, JWTs, connection-string and URL
  passwords, `key = value` pairs, data URIs, and generic high-entropy tokens —
  engineered to avoid false positives (tool names, file names, git hashes,
  UUIDs, credential-free URLs and plain long words are never masked).
- **Environment secret collection**: any env var whose name matches
  `TOKEN / KEY / SECRET / PASSWORD / PASSWD / CREDENTIAL / AUTH / SIGNING`
  (value length >= 8) is collected and masked when it appears in output.
- **SSH password collection**: passwords stored in `~/.dsh/dsh-ssh.json`
  are masked (opt-out via config).
- **`redact_text` model tool**: mask arbitrary text or JSON before it is
  logged, persisted, or echoed.
- **`redact_secret_status` model tool**: report active rule names and
  collected secret counts (never the values) to verify the redactor.
- **Package-private RPC** (`harness.handle`, sandbox realm only; skipped when
  loaded via CLI): `secret-redactor/redact` and `secret-redactor/status` for
  client halves and other plugins.

## Install

```sh
dsh plugin --profile web add github:DamonKoy/dsh-plugins#path:/packages/dsh-secret-redactor
```

Restart `dsh web`. The redactor is active by default.

## Config

Optional file `~/.dsh/dsh-secret-redactor.json`:

```json
{
  "enabled": true,
  "mask": "***",
  "disablePatterns": ["generic-mixed"],
  "patterns": ["CUSTOM-\\d{8}"],
  "extraSecrets": ["literal-secret-1"],
  "collectEnv": true,
  "collectSshPasswords": true
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `mask` | `"***"` | Replacement text for user-supplied secrets/patterns |
| `disablePatterns` | `[]` | Disable built-in rules by name (see catalog) |
| `patterns` | `[]` | Extra regexes applied with `g` flag |
| `extraSecrets` | `[]` | Literal strings to mask (length >= 4) |
| `collectEnv` | `true` | Collect matching env var values |
| `collectSshPasswords` | `true` | Collect `~/.dsh/dsh-ssh.json` passwords |

Config is re-read on every hook, so edits apply without a restart.

## Rule catalog

| Rule name | What it masks | Example |
| --- | --- | --- |
| `sk-openai` | `sk-` prefixed keys (OpenAI/DeepSeek) | `sk-abc…` → `sk-***` |
| `gh-tokens` | GitHub tokens | `ghp_…` → `gh***` |
| `aws-akid` | AWS access key ids | `AKIA…` → `AKIA***` |
| `slack` | Slack tokens | `xoxb-…` → `xox***` |
| `google-api` | Google API keys | `AIza…` → `AIza***` |
| `huggingface` | HF tokens | `hf_…` → `hf***` |
| `gitlab` | GitLab PATs | `glpat-…` → `glpat-***` |
| `bitbucket` | Bitbucket tokens | `ATBB…` → `ATBB***` |
| `aliyun` | Alibaba Cloud AK | `LTAI…` → `LTAI***` |
| `tencent` | Tencent Cloud AK | `AKID…` → `AKID***` |
| `stripe` | Stripe keys | `sk_live_…` → `sk_***` |
| `npm` | npm tokens | `npm_…` → `npm***` |
| `telegram` | Telegram bot tokens | `123456:AA…` → `1234567890***` |
| `sendgrid` | SendGrid API keys | `SG.…` → `SG.***` |
| `digitalocean` | DO PATs | `dop_v1_…` → `dop_v1***` |
| `shopify` | Shopify tokens | `shpat_…` → `shpat_***` |
| `pem-private-key` | PEM private key blocks (RSA/EC/OpenSSH/PGP/encrypted) | whole block |
| `bearer` | `Bearer <token>` headers | `Bearer ***` |
| `jwt` | JWTs | `***JWT***` |
| `data-uri` | base64 payloads of `data:…;base64,…` URIs | `data:image/png;base64,***` |
| `url-credentials` | `scheme://user:password@` credentials | `mongodb://***@host` |
| `key-value` | `apiKey`/`password`/`secret`/`token`-style pairs (quoted or not) | `"password": "***"` |
| `hex-mixed` | 32+ hex with mixed case + digits | `***` |
| `base64-mixed` | 64+ base64-looking text, mixed case + digits | `***` |
| `generic-mixed` | 40+ identifier-shaped text, mixed case + digits | `***` |

False-positive protection is baked into the generic rules: plain tool names
(`hindsight_search_knowledge_pages`), lowercase-only words (even 45 chars),
git commit hashes, UUIDs, `https://user@host` URLs, git SSH URLs and `git@…`
forms are never masked. Run `node --test test/` for the 13-case bidirectional
suite (positives and negatives).

## Security notes

- Redaction applies to the model-facing content of tool results (the main
  leak surface). The durable log still stores the raw canonical result value;
  full log-level redaction is on the roadmap.
- Collected secrets live only in memory; nothing is persisted or uploaded.
- Counts reported by `redact_secret_status` never include the values.

## License

MIT
