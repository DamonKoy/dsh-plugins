# dsh-approve-for-me

DeepSeek Harness 自动审批审核插件。对标 Codex 0.147 的 `--approve-for-me`（Guardian 自动审核）。

[English](README.md) | 中文

## 功能

- **`approval/request` 挂钩**：`review` 模式下只读工具（`read`、`grep`、`glob`、
  `ssh_list`、inspect 工具等）自动放行；`auto` 模式下全部请求自动放行——但危险命令
  始终自动拒绝（fail-closed 安全底线）。
- **`tools/pre-execute` 挂钩**：危险 shell 命令（`rm -rf /`、`mkfs`、`dd of=/dev/sdX`、
  fork bomb、`chmod -R 777 /`、`curl|sh`、`shutdown` 等）在派发前被硬拦截，根本不会
  走到审批弹窗。
- **`approval_policy_status` 工具**：报告当前模式与生效状态。
- **RPC**（`approve-for-me/status`、`approve-for-me/set-mode`）：供 client 半区与其他
  插件调用。

## 模式

| 模式 | 只读工具 | 其他工具 | 危险命令 |
| --- | --- | --- | --- |
| `off` | 人工 | 人工 | 人工 |
| `review`（默认） | 自动放行 | 人工 | 自动拒绝 |
| `auto` | 自动放行 | 自动放行 | 自动拒绝 |

## 安装

```sh
dsh plugin --profile web add link:~/dsh-plugins/packages/dsh-approve-for-me
```

重启 `dsh web`。默认 `review` 模式。

## 配置

`~/.dsh/dsh-approve-for-me.json`：

```json
{ "mode": "auto" }
```

合法模式：`off` | `review` | `auto`。也可通过 `approve-for-me/set-mode` RPC 运行时切换
（仅内存，重启恢复）。

## 安全说明

- 自动放行永远绕不开危险命令黑名单。
- 拒绝是 fail-closed 的：监听器抛错会回落到人工 answerer，绝不会变成静默放行。
- 策略引擎（`lib/policy.js`）带单元测试；`node --test test/` 可验证。

## License

MIT
