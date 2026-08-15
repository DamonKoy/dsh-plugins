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
- **包私有 RPC**（`harness.handle`，仅沙箱 realm；CLI 静态加载下跳过）：`secret-redactor/redact` 与
  `secret-redactor/status`，供 client 半区与其他插件调用。

## 安装

```sh
dsh plugin --profile web add github:DamonKoy/dsh-plugins#path:/packages/dsh-secret-redactor
```

重启 `dsh web`。脱敏默认开启。

## 配置

可选文件 `~/.dsh/dsh-secret-redactor.json`：

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

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `mask` | `"***"` | 用户提供密钥/规则的替换文本 |
| `disablePatterns` | `[]` | 按名称禁用内置规则（见规则目录） |
| `patterns` | `[]` | 附加正则（带 `g` 标志） |
| `extraSecrets` | `[]` | 需掩码的字面字符串（长度 >= 4） |
| `collectEnv` | `true` | 收集匹配的环境变量值 |
| `collectSshPasswords` | `true` | 收集 `~/.dsh/dsh-ssh.json` 密码 |

配置在每次挂钩时重新读取，修改即时生效，无需重启。

## 规则目录（25 条内置）

覆盖：`sk-` 系（OpenAI/DeepSeek）、GitHub（`ghp_` 等）、AWS `AKIA`、Slack `xox`、
Google `AIza`、HuggingFace `hf_`、GitLab `glpat-`、Bitbucket `ATBB`、阿里云 `LTAI`、
腾讯云 `AKID`、Stripe `sk_live_/sk_test_`、npm、Telegram 机器人、SendGrid `SG.`、
DigitalOcean `dop_v1_`、Shopify `shpat_`、PEM 私钥块（RSA/EC/OpenSSH/PGP/加密）、
`Bearer` 头、JWT、`data:…;base64,…` URI 载荷、`scheme://user:password@` 连接串凭据、
`apiKey/password/secret/token` 键值对（含 JSON 引号形式）、32+ 混合大小写 hex、
64+ base64 形状、40+ 混合大小写标识符形状。

防误伤内建：普通工具名（如 `hindsight_search_knowledge_pages`）、纯小写长单词
（即使 45 字符）、git commit 哈希、UUID、无凭据的 `https://user@host`、`git@…`
SSH URL 均不掩码。`node --test test/` 运行 13 例双向测试（正例+反例）。


## 安全说明

- 脱敏作用于模型可见的工具结果内容（主要泄露面）。持久化日志仍存原始规范化结果值；
  日志级脱敏在路线图上。
- 收集的密钥仅驻留内存，不落盘、不上传。
- `redact_secret_status` 只报数量与规则名，绝不包含值。

## License

MIT
