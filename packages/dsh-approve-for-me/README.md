# dsh-approve-for-me

Automated approval review for DeepSeek Harness. Inspired by Codex 0.147's
`--approve-for-me` (Guardian auto-review).

English | [中文](README.zh.md)

## What it does

- **`approval/request` hook**: in `review` mode, read-only tools
  (`read`, `grep`, `glob`, `ssh_list`, inspection tools, ...) are
  auto-approved; in `auto` mode every request is approved — except dangerous
  commands, which are always denied (fail-closed security floor).
- **`tools/pre-execute` hook**: dangerous shell commands (`rm -rf /`,
  `mkfs`, `dd of=/dev/sdX`, fork bombs, `chmod -R 777 /`, `curl|sh`,
  `shutdown`, ...) are hard-blocked before dispatch, so they never reach the
  approval prompt.
- **`approval_policy_status` tool**: report the current mode and activity.
- **RPC** (`approve-for-me/status`, `approve-for-me/set-mode`) for client
  halves and other plugins.

## Modes

| Mode | Read-only tools | Other tools | Dangerous commands |
| --- | --- | --- | --- |
| `off` | ask human | ask human | ask human |
| `review` (default) | auto-approve | ask human | auto-deny |
| `auto` | auto-approve | auto-approve | auto-deny |

## Install

```sh
dsh plugin --profile web add link:~/dsh-plugins/packages/dsh-approve-for-me
```

Restart `dsh web`. Default mode is `review`.

## Config

`~/.dsh/dsh-approve-for-me.json`:

```json
{ "mode": "auto" }
```

Valid modes: `off` | `review` | `auto`. You can also switch at runtime via the
`approve-for-me/set-mode` RPC (memory-only, resets on restart).

## Security notes

- Auto-approval never bypasses the dangerous-command denylist.
- Denials are fail-closed: a throwing listener falls through to the human
  answerer, never to silent approval.
- The policy engine (`lib/policy.js`) is unit-tested; run
  `node --test test/` to verify.

## License

MIT
