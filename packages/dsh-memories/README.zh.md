# dsh-memories

DeepSeek Harness 项目记忆系统。对标 Codex 0.145/0.146 的 memories（持久命名、
项目作用域记忆、高效恢复）。

[English](README.md) | 中文

## 功能

- 按作用域持久化的键值记忆，存储于 `~/.dsh/dsh-memories/<scope>.json`——
  跨会话、跨重启保留。
- 模型工具：
  - `memory_set(scope, key, value)` — 写入/更新一条记忆
  - `memory_get(scope, key)` — 读取一条记忆
  - `memory_list(scope)` — 列出记忆（新的在前）
  - `memory_delete(scope, key)` — 删除一条记忆
  - `memory_search(scope, query)` — 按子串搜索键与值
- Client RPC：`memories/scopes`、`memories/list`、`memories/get`、
  `memories/upsert`、`memories/remove`——为设置/记忆面板 UI 预留。

用项目名做 scope（如 `my-project`）可隔离各项目上下文；省略 scope 即 `global` 记忆。

## 安装

```sh
dsh plugin --profile web add link:~/dsh-plugins/packages/dsh-memories
```

重启 `dsh web`。

## 存储

纯 JSON 文件，每个 scope 一个：

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

scope 会被清洗为 `[A-Za-z0-9._-]` 并限制 80 字符；`global` 为兜底 scope。
文件损坏时回退为空存储，插件不崩溃。

## 安全说明

- 记忆是主目录下的明文本地文件（权限遵循 umask）。不要存放凭据——敏感材料请使用
  凭据服务或 `dsh-secret-redactor`。
- 数据绝不离机。

## 路线图

- 会话开始时注入当前 scope 摘要到系统提示。
- 基于 client RPC 的记忆面板 UI（列表/编辑/删除）。
- 从会话工作区自动推断 scope，替代显式参数。

## License

MIT
