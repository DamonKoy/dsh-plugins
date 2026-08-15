# dsh-plugins

DSH（DeepSeek Harness）增强插件家族，对标 OpenAI Codex 0.147 的实用功能：

| 包 | 功能 | Codex 对应 |
| --- | --- | --- |
| dsh-secret-redactor | 敏感信息脱敏 | 0.147 secrets redaction |
| dsh-approve-for-me | 自动审批审核 | 0.147 --approve-for-me |
| dsh-mcp-client-v2 | MCP 客户端协议增强（分页发现/工具搜索/缓存） | 0.147 MCP 2026-07-28 |
| dsh-memories | 项目记忆系统 | 0.145 memories |
| dsh-system-proxy | 系统代理支持 | 0.143 PAC/WPAD |
| dsh-usage-cost | 用量/成本提醒 | 0.144 usage credits |

安装：`dsh plugin --profile web add link:~/dsh-plugins/packages/<name>`
