# dsh-memories

Project-scoped memory system for DeepSeek Harness. Inspired by Codex 0.145/0.146
memories (persisted names, project-scoped memories, efficient resume).

English | [中文](README.zh.md)

## What it does

- Persistent key-value memories stored per scope in
  `~/.dsh/dsh-memories/<scope>.json` — survive across sessions and restarts.
- Model tools:
  - `memory_set(scope, key, value)` — upsert one memory
  - `memory_get(scope, key)` — read one memory
  - `memory_list(scope)` — list memories (newest first)
  - `memory_delete(scope, key)` — remove one memory
  - `memory_search(scope, query)` — substring search over keys and values
- Client RPC: `memories/scopes`, `memories/list`, `memories/get`,
  `memories/upsert`, `memories/remove` — ready for a settings/memory panel UI.

Use scopes = project names (e.g. `my-project`) to keep per-project context
separate; omit scope for `global` memories.

## Install

```sh
dsh plugin --profile web add link:~/dsh-plugins/packages/dsh-memories
```

Restart `dsh web`.

## Storage

Plain JSON files, one per scope:

```json
{
  "entries": {
    "deploy-command": {
      "value": "pnpm run deploy:prod",
      "createdAt": 1786000000000,
      "updatedAt": 1786000000000
    }
  }
}
```

Scopes are sanitized to `[A-Za-z0-9._-]` and capped at 80 chars; `global` is
the fallback scope. Corrupted files fall back to an empty store instead of
crashing the plugin.

## Security notes

- Memories are plaintext local files in your home directory (mode honors
  your umask). Do not store credentials — use the credential service or
  `dsh-secret-redactor` for sensitive material.
- No data ever leaves the machine.

## Roadmap

- Prompt-section injection of the current scope's summary at session start.
- Memory panel UI (list / edit / delete) via the client RPC.
- Automatic scope from the session workspace instead of explicit arguments.

## License

MIT
