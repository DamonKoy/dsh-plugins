# 登记条目（PR-ready）

## 1. awesome-dsh-plugin 精选目录登记

仓库：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
方式：在 README.md 与 README.zh.md 对应分类下各加一行（下方行可直接粘贴）。

### README.md (English) — under `Development & Runtime` / `Memory`

```markdown
- [DamonKoy/dsh-plugins](https://github.com/DamonKoy/dsh-plugins) - Six-pack of Codex-inspired enhancements: secret redaction, automated approvals, MCP client v2, project memories, system proxy, and usage/cost tracking.
```

分类建议（按插件仓库子目录细分的备选行，若拆分为独立仓库发布则各用一行）：

```markdown
- [DamonKoy/dsh-plugins](https://github.com/DamonKoy/dsh-plugins/tree/main/packages/dsh-secret-redactor) - Auto-masks API keys, tokens, JWTs and private keys in every tool result shown to the model.
- [DamonKoy/dsh-plugins](https://github.com/DamonKoy/dsh-plugins/tree/main/packages/dsh-approve-for-me) - Automated approval review: auto-approves read-only tools, auto-denies dangerous commands.
- [DamonKoy/dsh-plugins](https://github.com/DamonKoy/dsh-plugins/tree/main/packages/dsh-mcp-client-v2) - Enhanced MCP client with paginated tool discovery, non-blocking startup and tool search.
- [DamonKoy/dsh-plugins](https://github.com/DamonKoy/dsh-plugins/tree/main/packages/dsh-memories) - Project-scoped persistent key-value memories with set/get/list/delete/search tools.
- [DamonKoy/dsh-plugins](https://github.com/DamonKoy/dsh-plugins/tree/main/packages/dsh-system-proxy) - Detects system proxy (scutil/env/PAC) and exports proxy environment for child processes.
- [DamonKoy/dsh-plugins](https://github.com/DamonKoy/dsh-plugins/tree/main/packages/dsh-usage-cost) - Tracks LLM token usage and estimated cost per session/day with budget alerts.
```

### README.zh.md (中文) — Development & Runtime / Memory 分类下

```markdown
- [DamonKoy/dsh-plugins](https://github.com/DamonKoy/dsh-plugins) — Codex 风格增强六件套：敏感信息脱敏、自动审批、MCP 客户端 v2、项目记忆、系统代理、用量与成本统计。
```

## 2. dsh-web-ui 社区插件索引登记（community.json）

仓库：https://github.com/zhu1090093659/dsh-web-ui
方式：`packages/dsh-web-ui-settings/community.json` 追加条目后运行 `node scripts/community-index`。

```json
[
  {
    "id": "dsh-secret-redactor",
    "name": "敏感信息脱敏",
    "nameEn": "Secret Redactor",
    "author": "DamonKoy",
    "repo": "https://github.com/DamonKoy/dsh-plugins/tree/main/packages/dsh-secret-redactor",
    "description": "自动掩码工具输出中的 API key、token、JWT、私钥与配置密钥。",
    "descriptionEn": "Auto-masks API keys, tokens, JWTs and private keys in tool results shown to the model.",
    "npm": "dsh-secret-redactor"
  },
  {
    "id": "dsh-approve-for-me",
    "name": "自动审批审核",
    "nameEn": "Approve for Me",
    "author": "DamonKoy",
    "repo": "https://github.com/DamonKoy/dsh-plugins/tree/main/packages/dsh-approve-for-me",
    "description": "只读工具自动放行、危险命令自动拒绝，可配置全自动模式。",
    "descriptionEn": "Auto-approves read-only tools, auto-denies dangerous commands, optional full-auto mode.",
    "npm": "dsh-approve-for-me"
  },
  {
    "id": "dsh-mcp-client-v2",
    "name": "MCP 客户端 v2",
    "nameEn": "MCP Client v2",
    "author": "DamonKoy",
    "repo": "https://github.com/DamonKoy/dsh-plugins/tree/main/packages/dsh-mcp-client-v2",
    "description": "MCP 客户端增强：分页工具发现、非阻塞启动、工具搜索。",
    "descriptionEn": "Enhanced MCP client: paginated tool discovery, non-blocking startup, tool search.",
    "npm": "dsh-mcp-client-v2"
  },
  {
    "id": "dsh-memories",
    "name": "项目记忆",
    "nameEn": "Project Memories",
    "author": "DamonKoy",
    "repo": "https://github.com/DamonKoy/dsh-plugins/tree/main/packages/dsh-memories",
    "description": "按项目作用域持久化的键值记忆，支持增删查列与搜索。",
    "descriptionEn": "Project-scoped persistent key-value memories with set/get/list/delete/search.",
    "npm": "dsh-memories"
  },
  {
    "id": "dsh-system-proxy",
    "name": "系统代理",
    "nameEn": "System Proxy",
    "author": "DamonKoy",
    "repo": "https://github.com/DamonKoy/dsh-plugins/tree/main/packages/dsh-system-proxy",
    "description": "检测系统代理（scutil/环境变量/PAC）并为子进程导出代理环境变量。",
    "descriptionEn": "Detects system proxy (scutil/env/PAC) and exports proxy env for child processes.",
    "npm": "dsh-system-proxy"
  },
  {
    "id": "dsh-usage-cost",
    "name": "用量成本提醒",
    "nameEn": "Usage & Cost",
    "author": "DamonKoy",
    "repo": "https://github.com/DamonKoy/dsh-plugins/tree/main/packages/dsh-usage-cost",
    "description": "统计会话与每日 token 用量和估算成本，超预算提醒。",
    "descriptionEn": "Tracks token usage and estimated cost per session/day with budget alerts.",
    "npm": "dsh-usage-cost"
  }
]
```
