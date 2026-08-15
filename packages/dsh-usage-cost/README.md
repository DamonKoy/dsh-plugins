# dsh-usage-cost

Usage and cost tracking plugin for DeepSeek Harness, inspired by Codex
0.144's "usage limit" credits reminder: watch every model call and keep a
running token/cost tally, with warnings before the budget runs out.

English | [中文](README.zh.md)

## What it does

- **Stream-level usage accounting**: hooks the `llm/stream` waterfall and
  accumulates `inputTokens`, `outputTokens`, `cacheReadTokens`,
  `cacheWriteTokens`, `reasoningTokens` from every `usage` chunk without
  buffering or altering the stream; one call counts once.
- **Per-model cost estimation**: prices each call in USD from a built-in
  table (DeepSeek: $0.28/M in, $0.42/M out, $0.028/M cache read, $0.42/M
  cache write; others: $2/M in, $8/M out), overridable per
  `provider/model` key in the config.
- **Per-turn settlement**: on `agent/turn-stopping`, usage accumulated
  since the last settlement is appended (deltas only) to
  `~/.dsh/dsh-usage-cost/stats.json`, bucketed by date and by model.
- **Budget warnings**: with `dailyBudgetUsd` / `sessionBudgetUsd` set,
  crossing the threshold logs once per date and once per session:
  `[dsh-usage-cost] 今日用量超预算` / `本次会话用量超预算`.
- **`usage_report` model tool**: read-only report of today, the current
  session, the per-model breakdown and the budget state (`dailyExceeded`
  / `sessionExceeded` flags).
- **Package-private RPC**: `usage-cost/status` returns the same report.

## Install

```sh
dsh plugin --profile web add link:~/dsh-plugins/packages/dsh-usage-cost
```

Restart `dsh web`. Active by default, records usage with no config.

## Config

Optional file `~/.dsh/dsh-usage-cost.json`:

```json
{
  "prices": {
    "deepseek-official/deepseek-v4-flash": {
      "inputPerM": 0.28,
      "outputPerM": 0.42,
      "cacheReadPerM": 0.028,
      "cacheWritePerM": 0.42
    }
  },
  "dailyBudgetUsd": 2,
  "sessionBudgetUsd": 0.5
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `prices` | `{}` | Per-model overrides in USD per 1M tokens, keyed by `provider/model` |
| `dailyBudgetUsd` | unset | Warn when today's cost exceeds this |
| `sessionBudgetUsd` | unset | Warn when this process's cost exceeds this |

Config is re-read on every use, so edits apply without a restart.

## Stats file

Written synchronously at every turn settlement (small file, no races);
costs are estimates from the price table, not provider invoices:

```json
{
  "byDate": {
    "2026-08-16": { "calls": 3, "inputTokens": 1200, "outputTokens": 800, "costUsd": 0.00068 }
  },
  "byModel": {
    "deepseek-official/deepseek-v4-flash": { "calls": 3, "inputTokens": 1200, "outputTokens": 800, "costUsd": 0.00068 }
  }
}
```

## Notes

- Session tally is in-memory for the process lifetime; the daily file is the durable record.
- The `llm/stream` listener calls `next()` first and only reads chunk fields; stream, options and chunks are never modified.
- Warnings fire once per date and once per session to avoid log spam.
- Prices and budgets are user-side estimates; adjust them to your billing.

## License

MIT
