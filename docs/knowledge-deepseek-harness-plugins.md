# 知识沉淀：DSH 插件开发与自主 GitHub 提交实战

> 项目：DeepSeek Harness 插件（dsh-plugins）
> 周期：2026-08-16 单次会话；同日修复静态包 realm 启动崩溃（P15）
> 产物：6 个插件包、1 个 GitHub 仓库、2 个登记 PR、32 项单测；5 个静态插件改为防御式注册
> 本文档记录本次"从需求到发布"全过程中的提交信息、痛点、解决方案与可复用经验。

---

## 一、项目概览

对标 OpenAI Codex 0.147 的实用功能，为 DeepSeek Harness 实现 6 个插件：

| 包 | 功能 | 挂钩点/核心机制 |
| --- | --- | --- |
| dsh-secret-redactor | 敏感信息脱敏 | `tools/post-execute` waterfall 替换模型可见内容 |
| dsh-approve-for-me | 自动审批审核 | `approval/request` waterfall + `tools/pre-execute` 命令拦截 |
| dsh-mcp-client-v2 | MCP 客户端增强 | 手写 JSON-RPC + stdio/streamable-http + 分页发现 |
| dsh-memories | 项目记忆 | 文件存储 + 5 个模型工具 + RPC |
| dsh-system-proxy | 系统代理 | scutil/env/PAC 检测 + proxy_export |
| dsh-usage-cost | 用量/成本提醒 | `llm/stream` waterfall usage 收集 + 增量结算 |

---

## 二、提交信息梳理与评审

仓库：https://github.com/DamonKoy/dsh-plugins （7 次提交，main 分支）

| # | Commit | 内容 | 评审 |
| --- | --- | --- | --- |
| 1 | `c634c3e` feat: add dsh-secret-redactor, dsh-approve-for-me, dsh-memories packages | 前 3 包全部文件 + 根 README + 登记备份（28 files, +1388） | ✅ 规范；建议拆 3 个 commit 更原子 |
| 2 | `bc81149` feat: add dsh-system-proxy package | system-proxy 9 文件（+864, -12） | ✅ 含对 detect.js 的 4 行后续修改（-12 说明有改动） |
| 3 | `0b494b1` feat: add dsh-memories package | **夹带** system-proxy detect.js 4 行修改 + usage-cost 的 package.json/cost.js/cordis.patch.yml（子代理半成品） | ⚠️ **瑕疵**：并行子代理产出期间 `git add -A` 造成竞态夹带；提交信息与内容不符 |
| 4 | `f9db3ca` feat: add dsh-usage-cost package | usage-cost 8 文件（+742） | ✅ 但第 3 次提交已预占了部分文件，重复提交 |
| 5 | `2347b93` feat: add dsh-mcp-client-v2 package | mcp-client-v2 7 文件（+1705，最大包） | ✅ |
| 6 | `bd4006c` chore: add LICENSE to mcp-client-v2 and usage-cost | 补 2 包 LICENSE | ✅ 子代理交付核对发现的缺口 |
| 7 | `035f2a1` chore: add LICENSE to dsh-system-proxy | 补 system-proxy LICENSE | ✅ 同上（子代理报告与实际不符，核对发现） |

**评审结论**：提交信息整体符合 `type(scope): subject` 惯例、无 emoji；主要问题是第 3 次提交的夹带（详见痛点 P8）。改进：提交前 `git status` 检查 + 精确 `git add <path>`，并行产出期间改用 `git add packages/<具体包>`。

---

## 三、痛点与解决方案

### A. 网络与工具可用性

**P1. web_search / read_page 全部超时不可用**
- 现象：调研阶段 web_search 连续 3 次 60s 超时；read_page 报 `Cannot find module @liustack/modsearch`。
- 根因：本机 `~/.dsh/profiles/web/node_modules/@liustack/` 为空——modsearch 桥接未安装，搜索类工具实际不可用。
- 解决：改用 `curl` + GitHub REST API 直接抓取（`/repos/openai/codex/releases?per_page=100` 解析发布说明；`raw.githubusercontent.com` 读 README）。
- 沉淀：**工具不可用时立即换通道**，不要反复重试超时工具；GitHub API 未认证有速率限制，抓大列表用 `-o file` 落盘再解析。

**P2. GitHub API 偶发返回非 JSON**
- 现象：`curl ... | python3 -c json.load` 报 `Expecting value: line 1 column 1`。
- 解决：先 `curl -o /tmp/x.json && head -c 400` 检查原始响应（限流页/网络截断），再解析；一次失败就重试。
- 沉淀：管道解析前先落盘检查，避免把网络错误误判为数据格式问题。

**P3. npm 未登录，无法发布 npm 包**
- 现象：`npm whoami --registry=https://registry.npmjs.org/` 报 `ENEEDAUTH`；无 NPM_TOKEN。
- 决策：放弃 npm 发布，改"本地 monorepo + GitHub 仓库 + `dsh plugin add link:<path>`"分发路径；登记改为 awesome-dsh-plugin（PR 收录）与 dsh-web-ui community.json（索引链接），二者均不要求 npm 包。
- 沉淀：**发布路径要匹配现有凭据**；awesome-dsh-plugin 收录条件 = `dsh.bundle` manifest + 真实代码 + `dsh-plugin` topic，与 npm 无关，link 安装完全合规。

### B. 动态 Cordis 插件开发（运行时验证）

**P4. 动态插件随进程重启丢失**
- 现象：已定义并运行验证的 `usgc-7`（usage 收集挂钩）在会话中途报 `no dynamic plugin "usgc-7" in this process`；`cordis_inspect_self` 显示 plugins 为空。
- 根因：动态插件仅存在于当前进程内存，DSH 进程重启即清空。
- 解决：重新 `cordis_define` + `cordis_run`（新 id）；已验证的契约结论（tools/post-execute 生效、redact_text 注册成功）在对话历史中保留，无需重验。
- 沉淀：**动态插件验证结果要及时固化到文档/代码**；进程重启后 @pluginId 引用会失效，需重建。

**P5. `llm/stream` waterfall 的 `yield* next()` 陷阱**
- 现象：第一版挂钩写 `const stream = yield* next()`，拿不到下游流引用（且 Promise 不是 iterable，`yield*` 会抛 TypeError）。
- 解决：正确写法 `const stream = await next()` 后再 `for await`，chunk 原样透传：
  ```js
  ctx.on('llm/stream', async function* (options, next) {
    const stream = await next()
    for await (const chunk of stream) { /* 观察 usage */ yield chunk }
  })
  ```
- 沉淀：**waterfall 的 next() 返回 Promise<AsyncIterable>，必须先 await**；此模式适用于所有流式 waterfall（llm/stream、tools/execute 等）。

**P6. 审批事件看不到命令内容**
- 现象：设计 approve-for-me 时发现 `approval/request` 的 `ApprovalRequest` 只有 `{agent, toolName, callId?, reason?, signal?}`，没有命令正文。
- 解决：命令级危险检测移到 `tools/pre-execute`（exec.args.command 可见），approval 层只按 toolName 决策；两层分工：pre-execute 硬拦截（deny），approval/request 自动放行（allowed-once/rejected）。
- 沉淀：**挂哪个事件取决于能看到什么数据**；事件契约从 SDK d.ts 或 `cordis_inspect_query` 精确确认，referencedTypes 为空时读 `node_modules/@deepseek-ai/*/lib/types/*.d.ts`。

**P7. SDK 契约速查的必要性**
- 现象：`PostToolDecision`/`PreToolDecision`/`ApprovalOutcome`/`TokenUsage` 等关键类型的精确结构 inspect 不返回（referencedTypes 空）。
- 解决：直接读 npx 缓存中 SDK 的 `.d.ts`（`/Users/admin/.npm/_npx/<hash>/node_modules/@deepseek-ai/`），一次 grep 拿到全部契约：`ApprovalOutcome = 'allowed-once'|'rejected'|'cancelled'|'unavailable'`、`PostToolDecision = {kind:'accept', content?|value?}|{kind:'block', feedback}` 等。
- 沉淀：**SDK 包即类型真相**；动态插件环境无 require/import/fetch，静态包才可 import node 内置——mcp-client-v2 的网络能力（全局 fetch/spawn）因此只能放静态包。

### C. 静态插件包实现

**P8. 并行子代理产出期间的 git add -A 竞态**
- 现象：commit `0b494b1` 夹带了正在被子代理写入的 usage-cost 半成品文件与 system-proxy 的增量修改。
- 解决：后续改为提交前 `git status --short` 核对 + 精确路径 add；补交 LICENSE 用独立 chore commit。
- 沉淀：**并行产出 + 全量暂存 = 提交污染**；主代理负责提交时，子代理工作目录必须"静止"或按包隔离提交。

**P9. 危险命令正则的误伤与漏网**
- 现象 1：`rm -rf /tmp/build-cache` 被误判危险（正则 `\/\s*` 只锚了根路径开头）。
- 解决：锚定根目录语义 `(?:\/|\/\*|~|\*)\s*(?:[;&|]|$)`，`rm -rf /tmp/x` 放行、`rm -rf /` 与 `rm -rf /; echo` 拦截。
- 现象 2：fork bomb `:(){ :|:& };:` 不匹配（模式 `\}\s*:` 被中间的 `;` 打断）。
- 解决：改宽松模式 `:\(\s*\)\s*\{[^}]*:\|:&`，只锚函数头与核心管道。
- 沉淀：**安全正则必须配单测双向验证**（危险样本必中 + 安全样本不误伤），逐段组合调试（`new RegExp(a.source+b.source)` 定位断点）。

**P10. Node v23 下 `node --test` 目录参数行为**
- 现象：`node --test test/` 报 `MODULE_NOT_FOUND`（把目录当模块），`node --test` 或指定 `*.test.js` 正常。
- 解决：测试命令统一 `node --test test/<file>.test.js` 或从包目录直接 `node --test`。
- 沉淀：**测试命令写法要随 Node 版本验证**；三个子代理都踩了同一坑，README 里写明。

**P11. 子代理报告与磁盘实际的出入**
- 现象：system-proxy 子代理报告"已生成 LICENSE"，实际目录没有。
- 解决：主代理对每个子代理产物做 `git ls-files`/`ls` 核对，发现后补 `cp` + chore commit。
- 沉淀：**子代理的最终报告是声明，仓库状态才是事实**；收尾清单逐一核对（LICENSE/README 三件套/测试全绿）。

**P15. 静态包裸引用全局 harness → 启动即崩（AggregateError: harness is not defined）**
- 现象：dsh web 启动报 `AggregateError: loader entries failed to apply`，errors 数组里 5 个 link
  插件（secret-redactor / approve-for-me / memories / system-proxy / usage-cost）全部
  `ReferenceError: harness is not defined`，发生在 apply 阶段 `harness.registerTool(...)`。
  之前的 `duplicate loader entry id: plugin-toggle` 是另一个插件 bundle patch 与手写 insert 撞 id，属不同问题。
- 根因：`harness` 是**动态插件 sandbox**（cordis_define / cordis_run）注入的全局，静态包经 CLI
  （`npx dsh web`）加载时**不存在**。按第四节旧契约把动态 API 照搬进静态包，5 个插件全崩。
  且 dsh 对 apply 抛异常是**硬失败**（loader 把多个失败聚成 AggregateError 直接退出），
  不像 pending/未激活那样可容忍。错误详情藏在 AggregateError 的 `errors` 数组里，
  Node 默认只打印头部，需抓完整输出（后台跑 + 读文件）才能看到真正失败的条目。
- 解决：静态包改 `export default { name, inject: ['tools'], apply(ctx) }`，
  用 `ctx.tools.register(definition)`（官方 dsh-mcp-client / dsh-tool-jobs 同款）。
  保留 harness 优先分支必须 `typeof harness !== 'undefined'` 防御（对未声明变量安全，不抛 ReferenceError）；
  RPC 无 host-realm 等价物，harness 不存在时跳过。registerTool 整个包 try/catch，
  注册失败降级 warn，保证 apply **永不抛错**（哪怕 schema 校验失败也只会少一个 tool，不会崩插件树）。
- 沉淀：**写静态插件前先确认 realm**——动态沙箱用 `harness.*`，静态包用 `ctx.tools` + `inject`；
  不声明 `inject: ['tools']` 时 `ctx.tools` 抛 "cannot get property tools without inject"（也崩）；
  apply 必须 try/catch 兜底；`typeof harness` 是检测沙箱注入的标准姿势（参考 mcp-client-v2 registerModelTool）。

### D. 发布与登记

**P12. JSON 追加拼接错误**
- 现象：向 community.json 追加 6 条时 `cat >>` 因原文件末尾无换行产生 `],\n,{` 非法 JSON（Extra data）。
- 解决：python 修复（替换 `]\n,` 头、补尾部 `]`）+ `json.load` 校验。
- 沉淀：**改 JSON 用解析-修改-写回，别用字符串拼接**。

**P13. gh pr create 的 --head 要求**
- 现象：fork 仓库的分支无 upstream 时 `gh pr create` 报 `aborted: you must first push the current branch`。
- 解决：显式 `--head DamonKoy:<branch>`。
- 沉淀：fork + 分支 PR 的标准姿势是 `git push -u origin branch` 或显式 `--head`。

**P14. dsh-web-ui 仓库不接受新插件 PR**
- 现象：CONTRIBUTING.md 明确"暂不接受全新特性 PR"。
- 解决：改为走 community.json 社区索引登记（第三方插件作者路径），这是被接受的入口；运行 `node scripts/community-index` 重新生成注册表（纯 Node 脚本，无需 pnpm install）。
- 沉淀：**每个仓库的贡献入口不同**，先读 CONTRIBUTING 再选路径；登记类改动往往有专属脚本与 CI 门禁。

---

## 四、DSH 插件开发契约速查（本任务实测确认）

```
挂钩点（waterfall 语义，监听器返回决策或调用 next()）:
  tools/post-execute (exec, result, next) -> PostToolDecision
      {kind:'accept', content?: ContentBlock[]} | {kind:'accept', value?: JsonValue} | {kind:'block', feedback: ContentBlock[]}
  tools/pre-execute   (exec, next)          -> PreToolDecision {kind:'allow'|'deny', reason}|{kind:'ask'}
  approval/request    (req, next)           -> ApprovalOutcome 'allowed-once'|'rejected'|'cancelled'|'unavailable'
  llm/stream          (options, next)       -> AsyncIterable<StreamChunk>（先 await next()）
  agent/turn-stopping (payload)             -> void（结算时机）

模型工具注册（分 realm，差异极关键，见 P15）:
  ① 动态插件（cordis_define / cordis_run 沙箱）：环境注入全局 harness
     harness.registerTool(ctx, harness.defineTool({
       name, description,
       parameters: { k: {type:'string', description} },     // DSL；json 类型可用
       output: { schema: {...}, render: (args, value) => [{type:'text', text: JSON.stringify(value,null,2)}] },
       async execute(args, exec) { return <JsonValue> }
     }))
     包内 RPC: harness.handle('ns/method', (args) => <JsonValue>)   // Client 用 host.call 调用
  ② 静态包插件（link 安装、CLI 启动加载）：全局 harness 不存在！
     export default {
       name: 'my-plugin',
       inject: ['tools'],                 // 必须声明，否则 ctx.tools 抛 "cannot get property tools without inject"
       apply(ctx) {
         ctx.tools.register(definition)   // 官方 dsh-mcp-client / dsh-tool-jobs 路径；返回 disposer
       },
     }
     RPC 无 host-realm 等价物 → 静态包防御式跳过（typeof harness 检查）

静态包安全写法（两 realm 兼容）:
  function registerTool(ctx, definition) {
    try {
      if (typeof harness !== 'undefined' && harness && typeof harness.defineTool === 'function' && typeof harness.registerTool === 'function') {
        return harness.registerTool(ctx, harness.defineTool(definition))
      }
      if (ctx && ctx.tools && typeof ctx.tools.register === 'function') return ctx.tools.register(definition)
    } catch (e) { console.warn('tool registration failed:', e.message) }
    return () => {}
  }
  参考实现: packages/dsh-mcp-client-v2/lib/index.js registerModelTool（含 schema 失败重试）
```

服务/事件目录: cordis_inspect_list → cordis_inspect_query（契约精读用 SDK .d.ts）
```

---

## 五、自主提交 GitHub 操作手册（可复用流程）

```
1. 本地仓库初始化
   git init -b main && git config user.name/email（或 -c 临时指定）

2. 发布仓库
   gh repo create <owner>/<repo> --public --description "..."        # 不带 --source 则先建空仓
   git remote add origin <url> && git push -u origin main

3. 打生态标签（登记前置）
   gh repo edit <owner>/<repo> --add-topic dsh-plugin

4. 登记（两通道，PR-ready）
   a) awesome-dsh-plugin：fork → README.md + README.zh.md 对应分类各加一行
      `- [owner/repo](url) - One-line description ending with a period.`
      PR: gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin --head <me>:<branch>
   b) dsh-web-ui community.json：解析-修改-写回（勿字符串拼接）→ node scripts/community-index
      → community.ts 同步 → fork + PR

5. 提交纪律（本次教训）
   提交前 git status --short 核对；并行产出期间用精确路径 add；
   type(scope): subject 格式，无 emoji；收尾核对 LICENSE/README 三件套/测试全绿
```

---

## 六、最佳实践清单

1. **先调研后编码**：生态对比（是否已有对应插件）→ 契约确认（SDK d.ts / inspect）→ 再实现。
2. **动态验证先行**：核心挂钩用动态 Cordis 插件在真实运行时验证（本任务证实 tools/post-execute 脱敏真实生效），再落静态包。
3. **静态包零构建**：纯 JS ESM + node 内置，`dsh plugin add link:` 直接可用，免 tsdown/tsconfig 链。
4. **单测双向覆盖**：安全/规则类逻辑必配"危险必中 + 安全不误伤"测试（approve-for-me 7 例、system-proxy 9 例、usage-cost 9 例、mcp paginate 7 例）。
5. **并行子代理自包含**：prompt 含全部契约、参考路径、输出路径、自检命令；主代理收尾核对。
6. **文档三件套**：README.md + README.zh.md + README.i18n.yaml 一次配齐（dsh-web-ui 规范）。
7. **登记双通道**：awesome-dsh-plugin（精选目录）+ dsh-web-ui community.json（社区索引），一次提交两处 PR。

---

## 七、改进建议（下次迭代）

1. **npm 发布**：配置 NPM_TOKEN 后逐包 `npm publish`，dshmarket 安装可免构建授权、走 tarball 秒装。
2. **提交原子性**：每个包独立 commit；子代理完成并核对后再提交，杜绝夹带。
3. **Client UI**：为 memories（记忆面板）、usage-cost（用量卡片）补 client 半区设置 UI（`web-ui.plugin.item` 槽）。
4. **usage-cost 增强**：用 `agent/request` waterfall 读取模型配置，从会话投影拿 sessionId 做按会话归集。
5. **redactor 增强**：日志级脱敏（`tools/result` 之后的持久化环节目前仍存原始值，README 已标注 roadmap）。
6. **CI**：仓库加 GitHub Actions 跑 `node --test` 全量单测，收 PR 时自动门禁。
