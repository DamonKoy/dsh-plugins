# dsh-secret-redactor

DeepSeek Harness 敏感信息脱敏插件。对标 Codex 0.147 的「命令展示与会话回放中的 secrets 脱敏」。

[English](README.md) | 中文

## 功能

- **工具输出自动脱敏**：挂钩 `tools/post-execute` 流水线，模型看到的每个文本块中的
  API key、Bearer token、JWT、PEM 私钥、通用高熵 token 自动掩码——已在真实会话中
  验证（`sk-abc123...` 变为 `sk-***`）。
- **环境变量密钥收集**：变量名匹配 `TOKEN / KEY / SECRET / PASSWORD / PASSWD /
  CREDENTIAL / AUTH / SIGNING`（值长度 >= 8）的值会被收集并在输出中出现时掩码。
- **SSH 密码收集**：`~/.dsh/dsh-ssh.json` 中的密码自动掩码（可配置关闭）。
- **`redact_text` 模型工具**：在记录、持久化或回显之前，对任意文本/JSON 脱敏。
- **`redact_secret_status` 模型工具**：报告规则数与已收集密钥数（只报数量，不报值），
  用于确认脱敏器已生效。
- **包私有 RPC**（`harness.handle`）：`secret-redactor/redact` 与
  `secret-redactor/status`，供 client 半区与其他插件调用。

## 安装

```sh
dsh plugin --profile web add link:~/dsh-plugins/packages/dsh-secret-redactor
```

重启 `dsh web`。脱敏默认开启。

## 配置

可选文件 `~/.dsh/dsh-secret-redactor.json`：

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

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `mask` | `"***"` | 用户提供的密钥/规则的替换文本 |
| `patterns` | `[]` | 附加正则（带 `g` 标志应用） |
| `extraSecrets` | `[]` | 需掩码的字面字符串（长度 >= 4） |
| `collectEnv` | `true` | 收集匹配的环境变量值 |
| `collectSshPasswords` | `true` | 收集 `~/.dsh/dsh-ssh.json` 密码 |

配置在每次挂钩时重新读取，修改即时生效，无需重启。

## 安全说明

- 脱敏作用于模型可见的工具结果内容（主要泄露面）。持久化日志仍存原始规范化结果值；
  日志级脱敏在路线图上。
- 收集的密钥仅驻留内存，不落盘、不上传。
- `redact_secret_status` 只报数量，绝不包含值。

## License

MIT
