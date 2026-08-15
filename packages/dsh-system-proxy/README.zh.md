# dsh-system-proxy

DeepSeek Harness 系统代理插件。对标 Codex 0.143 的 PAC/WPAD 系统代理路由，
以「用户空间」插件形式实现。

[English](README.md) | 中文

## 功能

- **系统代理检测**：
  - macOS：读取 `scutil --proxy` 输出，提取 HTTP/HTTPS 代理与 PAC/WPAD URL
    （`HTTPEnable` / `HTTPProxy` / `HTTPPort`、`HTTPSEnable` / `HTTPSProxy` /
    `HTTPSPort`、`ProxyAutoConfigEnable` / `ProxyAutoConfigURLString`）。
    `scutil` 不可用时优雅降级到环境变量。
  - Linux / 其他：读取环境变量 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` /
    `NO_PROXY`（大小写均可，`ALL_PROXY` 作为兜底）。
- **`system_proxy_status` 模型工具**：只读报告检测到的代理、插件配置覆盖、
  检测来源（`scutil` / `env` / `none`）与 `no_proxy` 列表。
- **`proxy_export` 模型工具**：返回一段可直接粘贴到 bash 的
  `export http_proxy=... https_proxy=... no_proxy=...` 命令，让子进程走代理。
- **包私有 RPC**（`harness.handle`，仅沙箱 realm；CLI 静态加载下跳过）：`system-proxy/status`，供 client 半区
  与其他插件调用——载荷与 `system_proxy_status` 相同。

## 安装

```sh
dsh plugin --profile web add github:DamonKoy/dsh-plugins#path:/packages/dsh-system-proxy
```

重启 `dsh web`。

## 配置

可选文件 `~/.dsh/dsh-system-proxy.json`：

```json
{
  "overrideHttp": "",
  "overrideHttps": "",
  "overridePac": "",
  "noProxy": "localhost,127.0.0.1,.local",
  "allowExportEnv": true
}
```

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `overrideHttp` | `""` | 覆盖检测到的 HTTP 代理（空 = 用检测值） |
| `overrideHttps` | `""` | 覆盖检测到的 HTTPS 代理 |
| `overridePac` | `""` | 覆盖检测到的 PAC/WPAD URL |
| `noProxy` | `"localhost,127.0.0.1,.local"` | `proxy_export` 使用的 `no_proxy` 列表 |
| `allowExportEnv` | `true` | 为 `false` 时禁用 `proxy_export`（见安全说明） |

配置在每次调用时重新读取，修改即时生效，无需重启。系统检测到的原始值在
`detected` 字段中只读展示；`override*` 仅在非空时优先。

## 输出示例

`system_proxy_status`（macOS + `scutil`）：

```json
{
  "platform": "darwin",
  "source": "scutil",
  "viaEnv": false,
  "httpProxy": "http://192.168.1.1:8080",
  "httpsProxy": "http://192.168.1.1:8443",
  "pacUrl": null,
  "noProxy": "localhost,127.0.0.1,.local",
  "detected": {
    "httpProxy": "http://192.168.1.1:8080",
    "httpsProxy": "http://192.168.1.1:8443",
    "pacUrl": null
  },
  "override": { "httpProxy": "", "httpsProxy": "", "pacUrl": "" },
  "allowExportEnv": true,
  "configPath": "/Users/you/.dsh/dsh-system-proxy.json"
}
```

`proxy_export`（成功）：

```json
{
  "exported": true,
  "shell": "bash",
  "command": "export http_proxy='http://192.168.1.1:8080'\nexport https_proxy='http://192.168.1.1:8443'\nexport no_proxy='localhost,127.0.0.1,.local'",
  "exportedVars": ["http_proxy", "https_proxy", "no_proxy"]
}
```

未检测到代理、仅有 PAC URL（PAC 无法表达为环境变量）或 `allowExportEnv` 为
`false` 时，`proxy_export` 返回 `{ "exported": false, "reason": "..." }`。

## 平台差异

| 平台 | 检测方式 | 说明 |
| --- | --- | --- |
| macOS | `scutil --proxy` | `scutil` 失败或缺失时回退到环境变量 |
| Linux | 仅环境变量 | `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` |
| Windows | 仅环境变量 | 同 Linux（不探测注册表/WinINET） |

HTTPS 代理统一报告为 `http://` URL——HTTPS 流量经 HTTP 代理的 CONNECT 隧道
转发，这正是 `https_proxy` 的通用语义。

## 安全说明

- `proxy_export` 会把代理写进子进程环境变量，改变其网络出口——这是敏感操作。
  可在配置中设 `"allowExportEnv": false` 完全禁用，此时工具返回拒绝原因。
- 若在 `override*` 字段或环境变量中填写了带认证信息的代理
  （`user:pass@host`），该值会明文保存在主目录配置文件中，并出现在工具输出里。
- 本插件**不修改** DSH 宿主进程自身的 LLM 请求网络栈——那属于核心 `llm` 层，
  插件不可达。它是 Codex 系统代理支持的「用户空间」版本：检测、状态查询，
  以及为子进程/终端命令显式启用代理。
- 检测为纯读取，不落盘、不上传。

## License

MIT
