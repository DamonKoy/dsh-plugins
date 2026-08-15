# dsh-plugins

DSH（DeepSeek Harness）增强插件家族，对标 OpenAI Codex 0.147 的实用功能。

| 包 | 功能 | Codex 对应版本 | 状态 |
| --- | --- | --- | --- |
| [dsh-secret-redactor](packages/dsh-secret-redactor) | 敏感信息脱敏（工具输出自动掩码 + redact_text 工具） | 0.147 secrets redaction | ✅ 已验证（真实会话脱敏生效） |
| [dsh-approve-for-me](packages/dsh-approve-for-me) | 自动审批审核（只读自动放行 / 危险命令自动拒绝 / 全自动模式） | 0.147 --approve-for-me | ✅ 策略引擎 7/7 单测通过 |
| [dsh-mcp-client-v2](packages/dsh-mcp-client-v2) | MCP 客户端增强（分页工具发现 / 非阻塞启动 / 工具搜索） | 0.147 MCP 2026-07-28 | 见包内 README |
| [dsh-memories](packages/dsh-memories) | 项目记忆系统（按 scope 持久化键值记忆） | 0.145 memories | ✅ 已实现 |
| [dsh-system-proxy](packages/dsh-system-proxy) | 系统代理检测与导出（scutil / env / PAC） | 0.143 PAC/WPAD | 见包内 README |
| [dsh-usage-cost](packages/dsh-usage-cost) | 用量/成本统计与预算提醒（llm/stream usage 挂钩） | 0.144 usage credits | 挂钩验证中 |

## 安装

```sh
# 单个安装
dsh plugin --profile web add link:~/dsh-plugins/packages/<name>

# 或全部
for p in dsh-secret-redactor dsh-approve-for-me dsh-mcp-client-v2 dsh-memories dsh-system-proxy dsh-usage-cost; do
  dsh plugin --profile web add link:~/dsh-plugins/packages/$p
done
```

重启 `dsh web` 生效。

## 架构说明

每个包都是标准 DSH Cordis 插件：

- `package.json` 声明 `dsh.bundle.patch`（可被 `dsh plugin add` 与 dshmarket 识别）
- `cordis.patch.yml` 是插件行（bundle patch）
- `lib/index.js` 是 Host 半区（纯 JS ESM，无构建步骤）
- 配置统一放在 `~/.dsh/<name>.json`，每次使用即时重读

## 登记

- awesome-dsh-plugin 精选目录：见 [registry/REGISTRATION.md](registry/REGISTRATION.md)（PR-ready 行）
- dsh-web-ui community.json：同上（PR-ready 条目）
- 仓库已打 `dsh-plugin` topic（登记前置要求）

## License

MIT
