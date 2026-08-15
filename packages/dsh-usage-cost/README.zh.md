# dsh-usage-cost

DeepSeek Harness（DSH）的用量与成本统计插件，对标 Codex 0.144 的
"usage limit" credits 提醒：实时监控每一次模型调用，维护 token 与
费用累计，并在预算被突破之前给出告警。

[English](README.md) | 中文

## 功能

- **流式用量统计**：挂钩 `llm/stream` waterfall，从每个 `usage` chunk
  累计 `inputTokens`、`outputTokens`、`cacheReadTokens`、
  `cacheWriteTokens`、`reasoningTokens`，不缓存、不改变 chunk 流。
  即使一次调用发出多个 usage chunk，也只按一次调用计数。
- **按模型估算费用**：每次调用按内置价格表折算 USD（DeepSeek 系输入
  $0.28/M、输出 $0.42/M、缓存读 $0.028/M、缓存写 $0.42/M；其他模型
  输入 $2/M、输出 $8/M），可在配置中按 `provider/model` 键覆盖。
- **按轮次结算**：在 `agent/turn-stopping` 时，把自上次结算以来的新增
  用量（仅增量）追加写入 `~/.dsh/dsh-usage-cost/stats.json`，按日期与
  按模型分别归档。
- **预算告警**：配置了 `dailyBudgetUsd` / `sessionBudgetUsd` 后，累计
  费用跨过阈值时输出一次告警（每日期、每会话各一次）：
  `[dsh-usage-cost] 今日用量超预算` / `本次会话用量超预算`。
- **`usage_report` 模型工具**：只读报告今日用量、当前会话用量、按模型
  分解以及预算状态（`dailyExceeded` / `sessionExceeded` 标志）。
- **包内私有 RPC**：`usage-cost/status` 返回同样的报告。

## 安装

```sh
dsh plugin --profile web add github:DamonKoy/dsh-plugins#path:/packages/dsh-usage-cost
```

重启 `dsh web` 后生效。默认开启，无配置即可记录用量。

## 配置

可选配置文件 `~/.dsh/dsh-usage-cost.json`：

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

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `prices` | `{}` | 按 `provider/model` 键覆盖的价格，单位 USD / 每百万 token |
| `dailyBudgetUsd` | 未设置 | 今日费用超过该值时告警 |
| `sessionBudgetUsd` | 未设置 | 当前进程累计费用超过该值时告警 |

配置在每次使用时重新读取，改动无需重启。

## 统计文件

每次轮次结算时同步写入（文件很小，无异步竞争）：

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

费用为基于价格表的估算值，不代表服务商的真实账单。

## 说明

- 会话统计保存在内存中，覆盖进程生命周期；按日统计文件才是持久记录。
- `llm/stream` 监听器先调用 `next()` 再读取 chunk 字段；流、options 与 chunk 对象均不会被修改。
- 告警按日期与按会话各触发一次，避免刷屏。
- 价格与预算均为用户侧估算，请按实际计费调整。

## License

MIT
