# REUSE_ANALYSIS

调查日期：2026-09-28 · 目标机器：Windows 11 / PowerShell / Node v24.18.1

## 0. 重要前置事实（先于一切设计）

**这些参考项目在本机磁盘上不存在。** 我对 `C:\`、`D:\`、`E:\` 做了目录级搜索
（`JevRouter`、`pi-jev`、`pi-subagents`、`native-agent-router`、
`agent-orchestrator`、`harness`、`AgentRouter`、`laya-server`），全部无命中。
因此下面的"复用"结论基于**上游公开源码/文档的阅读 + 本机实测验证**，
而不是"已经 clone 在本地"。凡是我没有本地验证的，我都标注了来源。

**本机真正可用的资产（已实测）：**

| 资产 | 位置 | 版本 | 登录态 |
|---|---|---|---|
| OpenCode | `C:\Users\Admin\AppData\Roaming\npm\node_modules\opencode-ai\bin\opencode.exe` | 1.18.31 | 3 个凭证（OpenCode Go / DeepSeek / Ollama Cloud） |
| Codex | `C:\Users\Admin\.codex\plugins\.plugin-appserver\codex.exe` | 0.158.0-alpha.2.1 | API key `sk-mKkad***QhlcW` |

两个陷阱，都直接影响架构：

1. **`opencode` 在 PATH 上是 `opencode.ps1`（npm shim），不是 exe。**
   Node `spawn` 不能直接执行 `.ps1`。必须解析到真实 `.exe`。
2. **`codex` 根本不在 PATH 上。** 它随 OpenAI Codex 桌面应用安装。
   任何"直接 spawn `codex`"的实现在这台机器上都会静默失败。必须显式配置路径 + 自动发现。

---

## 1. `native-agent-router` (NAR) — 架构上最接近本项目，价值最高

来源：glama.ai/mcp/servers/BerineYang/native-agent-router · Python ≥3.10

**直接借鉴（设计层面，非代码）：**

- **model-free kernel。** NAR 明确的设计前提：*"The kernel never calls a model.
  It handles task state, bounded waiting, workspace locking, fixed verification,
  one pre-authorized repair, cancellation with confirmation, budgets, recovery,
  usage accounting and per-agent scoring — so the orchestrator spends its tokens
  on judgment, not on polling and log-shuffling."*
  → 这正是本项目"决策模型"与"执行 kernel"分离的论证基础。我照搬了这个分层。

- **终态枚举：`succeeded | failed | cancelled | blocked | interrupted`。**
  → 我的 `TaskState` 收敛为 `succeeded | failed | cancelled | timeout`，
  砍掉 `blocked`（那是 NAR 对"锁被持有"的特化，本项目 Phase 1 无 workspace lock）。

- **`run` 返回 ≠ 完成。** NAR 原文：*"`run` returning means submitted, not done."*
  → 我的 API 因此是 `orchestrator.run()` 返回 handle（带 `sessionId`），
  再 `await handle.result()`。**这是一条我原本会写错的接口。**

- **稳定工具面。** NAR 的 MCP server 永远只暴露 5 个工具
  （`agents` / `run` / `wait` / `inspect` / `cancel`），
  *"New backends are added by config, not by new tools."*
  → 新增 ZCode / DSH 时只加 adapter 配置，不加 API 面。

- **每个任务必须显式指定 `agent_id`。** NAR 原文：*"There is no global
  'selected backend' that other calls could silently change."*
  → 我采用：`RunRequest.agentId` 必填，registry 里**没有**"当前 agent"全局态。

- **`credentials: "auto"` 的纪律。** NAR 只读复用本地已配置的 provider，
  *"never logs keys, never uploads them anywhere, never switches billing
  channels"*，并提供 `doctor` 命令报告**发现了什么**，*"It never prints
  credentials."*
  → 采纳：adapter 只传参不复述凭证；`doctor` 只打印路径与版本。

- **配置查找链：** `--config` flag → `NAR_CONFIG` env → `~/.native-agent-router/agents.json`
  → 内置默认 + 自动发现。
  → 照搬这个四级链，对应本项目 `orchestrator.json` 的查找顺序。

**不能直接复用：** Python 实现，进程/事件模型是 `asyncio` + `anyio`。
本项目需要 Windows 优先的 Node 实现。借鉴的是**契约形状**，不是代码。

**Adapter 命名沿用：** NAR 已有 `zcode-native` / `acp-generic` / `stub`。
我保留 `acp-generic` 这个名字以便未来对齐；Phase 1 不实现。

---

## 2. `pi-subagents` — adapter seam 与 capability matrix 的最佳参考

来源：多个同名 fork（`Bukutsu/pi-subagents`、`@parke.dev/pi-subagent` 等），
其中 `@parke.dev` 版本文档最完整，含 `src/` 布局。

**直接借鉴：**

- **backend adapter seam 的文件切分。** 它把"怎么调 CLI + 怎么解析输出"
  与"策略/生命周期"彻底分开：
  ```
  src/backends/{pi,codex,claude}.ts   # 只有 invocation + parser
  src/backend.ts                     # adapter seam + capability gate
  src/runner.ts                      # 子进程生命周期、steering、watchdog
  src/protocol.ts                    # RPC/JSON 事件解析
  src/policy.ts                      # profiles、写保护、agent 解析
  ```
  → 我采用同样的切分：`src/adapters/*.ts` 只负责
  **构造 argv + 把原生事件映射成 RuntimeEvent**，其余全在 runtime 层。

- **capability matrix 就是 `capabilities` 抽象的原型。** 它的表格逐 backend
  列出能力有无，这比"每个 adapter 都有全部方法、运行时再抛 not-supported"
  强得多：
  | | pi | codex | claude |
  |---|---|---|---|
  | `max_cost` | yes | **refused**（只报 token） | yes |
  | read-only profile | tool allowlist | `--sandbox read-only`（OS 级） | `--allowedTools` |
  | steering | yes | **no**（无 stdin 通道） | **no**（one-shot） |
  | `resume` | yes | yes | yes |
  | `output_schema` | yes | yes | yes |

  → 我的 `AgentCapabilities` 直接用 boolean 字段表达，并让 orchestrator
  **在派发前**检查，不在运行中崩。

- **输出截断策略。** *"Tool responses are capped to ~50KB/2000 lines; full output
  lives in artifacts."*
  → 我的 `RunResult` 摘要进内存，全量事件**落盘**，内存只留 `outputTail`。

- **并行写冲突规则。** *"Parallel write-capable tasks sharing one checkout are
  rejected unless each uses `isolation: worktree"`, distinct `cwd`, or
  `allow_shared_writes: true`."*
  → 这是 Phase 2 的前置条件，本项目 `RunRequest.isolation` 预留字段但不实现。

**不能直接复用：** 它的 backend 是 **pi / codex / claude**，但 `claude` backend
假定的是 Claude Code 的 CLI 形态；本项目要接 ZCode / WorkBuddy / DSH，
形态未知，必须自己写通用 seam。它的 worktree 实现也依赖 pi 的会话文件格式。

---

## 3. `agents-mcp-gateway` — Windows 优先 + task/thread 分离，最贴近本项目约束

来源：glama.ai/mcp/servers/kangjoseph90/agents-mcp-gateway（Windows-native）

**直接借鉴（这条最关键）：**

- **task 与 thread 分离。** 原文：*"A task is one CLI subprocess execution.
  A thread stores the gateway thread ID, provider session ID, adapter, agent,
  and canonical cwd so later tasks can resume the provider conversation."*

  → 这是我整个数据模型的基础。**resume 不是"再来一个 run"，
  而是"同一个 thread 下的第二个 task"**：
  ```ts
  Thread { threadId, agentId, cwd, createdAt }        // 持久
  Task   { taskId, threadId, state, startedAt, ... }  // 一次执行
  ```
  我原本第一版是"run 带 sessionId 续跑"，这个模型更清楚。

- **实测过的 argv 配方（与我自己实测一致）：**
  ```yaml
  codex-readonly:
    adapter: codex
    args: ["exec", "--json", "-s", "read-only", "-c", "approval_policy='never'"]
  claude-readonly:
    adapter: claude
    args: ["-p", "--output-format", "json", "--permission-mode", "dontAsk"]
  ```
  → 我用 `codex exec --json`。注意：它的 `-c approval_policy='never'`
  我**实测失败**——`codex exec` 没有 `-a/--ask-for-approval` 参数，
  `exec` 本身就是非交互的。→ 我的实现不传该参数。

- **`await_task(task_id, timeout_ms?)` 有上限（60s），超时返回
  `wait_timed_out: true` 而不是无限阻塞。**
  → `await handle.result(timeoutMs)` 超时抛 `TimeoutError`，
  但**不杀进程**（进程仍在跑，可继续 wait / cancel）。这点比直接 kill 好。

- **固定 argv + 环境变量白名单 + 阻断
  `.git` / `node_modules` / 凭证目录 / UNC 路径 / 符号链接逃逸。**
  → 采纳白名单 env，不做全量继承。凭证目录阻断是 Phase 2 的 scope 控制，
  Phase 1 先做到"env 白名单"。

**不能直接复用：** 它是一个 MCP gateway + FastAPI，目标是"把 CLI 暴露成远程工具"，
且绑 `127.0.0.1:3333` 走 Secure MCP Tunnel。本项目 Phase 1 是本地 CLI，
**明确不建服务**。

---

## 4. `JevRouter` / `pi-jev` / `pi-jev-router` / `@riposta/pi-jev` — 决策层

来源：npm `pi-jev-router`、pi.dev 画廊、`@riposta/pi-jev`

**直接借鉴（Phase 2 才用，但架构先立住）：**

- **`@riposta/pi-jev` 的模块化纪律：**
  原文：*"`index.ts` contains no decision logic. It loads config, builds the
  client, redactor and telemetry singletons, and calls each module's
  `register(pi, deps)`. Modules never import each other; shared state goes
  through `deps`."*
  → 照搬：**kernel 入口不含任何决策逻辑**，adapter/策略通过 deps 注入，
  模块之间不互相 import。这直接决定了我的 `registry.ts` 形态。

- **失败策略是明确二选一，不许含糊：**
  - `pi-jev-model-router`：**fails open**（*"A missing key, timeout, or unknown
    model just warns and runs your prompt on the current model."*）
  - `pi-jev-router`：**fail explicitly**（*"the router errors instead of switching."*）
  → 借鉴的是"必须显式声明"这个原则。本项目 Phase 1 采取 **fail fast**：
  adapter 不可用 → `RunResult.state = failed` + 明确错误，
  绝不静默降级到别的 agent（因为静默换 agent 会污染结果可信度）。

- **候选链 + 逐个尝试。** `pi-jev-model-router` 的 tier 是 ordered fallback chain，
  *"The first model that exists and is authenticated wins."*
  → Phase 2 的 `modelCandidates` 预留。

- **有界重试。** *"model-monitor evaluation timeouts retry up to three attempts
  of `timeoutMs` each"*，且有整体 ceiling。
  → retry 属于 orchestrator 策略层，不进 adapter。

**不能直接复用：** 全部是 **pi 的 extension**（依赖 `pi.on(...)` hook、
`~/.pi/agent/settings.json`、`/reload`）。本项目不跑在 pi 里。
它们的 model provider 走 OpenRouter / Vercel AI Gateway，
而本项目的决策模型是**本地 Laya**——没有网络依赖，这点必须自己写。

---

## 5. `harness` / `agent-orchestrator` / `AgentRouter` — 无法定位

这三个名字在本地和公开检索中都**没有定位到与本项目同类的项目**。
- 本机命中的是 `ai.deepseek.harness.desktop`（DeepSeek 桌面应用安装目录）
  和 `E:\OneDragon\docs\develop\harness`（一个游戏项目的开发文档目录），
  两者都**与 Coding Agent 编排无关**。
- 我**不编造**结论。`laya-server` 同理：能定位到的是 `laya` 决策库本身
  （`laya.Router` / `route()` / `RouteDecision` / `predict()`），
  是决策模型库，不是编排器 server。

**结论：这三个名字大概率是本项目作者自己项目名或内部代号，
不是可复用的上游项目。** 若确有仓库地址，请提供后我再补这部分分析。

---

## 6. ACP 相关（`acp-router` / `pi-acp-jetbrain` / `agentconnect`）— 优先级判断

**不直接复用，但决定了 Phase 1 的一个关键取舍。**

- `agentconnect` 的设计原则我认为是正确的：
  *"Reuse the ACP ecosystem; product code must not be written for each agent
  type"*，用 `@agentclientprotocol/sdk` 走 stdio JSON-RPC，
  方法集 `initialize` / `session/new` / `session/load` / `session/prompt` /
  `session/cancel` / `session/update`。
- `pi-acp-jetbrain` 的做法：*"Each ACP session starts one `pi --mode rpc`
  subprocess"*，并维护 `~/.pi/pi-acp/session-map.json` 持久映射。
- `acp-router` skill 明确禁止 PTY scraping：
  *"The routing rules explicitly prohibit subagent runtimes and PTY scraping
  of pi, claude, codex, opencode, gemini, or kimi CLIs when acpx is available."*

**→ Phase 1 取舍：不实现 ACP，改用原生 CLI JSONL。** 理由是实测结论：

1. `opencode run --format json` 与 `codex exec --json` **已经是干净的 JSONL 流**，
   比 ACP 的双向 JSON-RPC（需要处理 agent→client 反向调用、permission 请求、
   双向 cancel）**更少代码、更少失败模式**。
2. ACP 的真正价值是**跨编辑器/跨 agent 互操作**。
   本项目是单机、已知 agent 列表（先 OpenCode + Codex）的编排器，
   收益不抵复杂度。
3. 但 **必须为此留缝**：我在 `AgentCapabilities` 保留 `transport: 'cli' | 'acp'`，
   并让 adapter 契约本身与传输无关（adapter 只暴露
   `buildInvocation()` + `mapEvent()`）。未来加 ACP = 新增一个 adapter，
   不改 runtime。

**OpenCode 的 ACP 是真实存在且可用的**（`opencode acp`，
NAR 已对 opencode 1.18.15 验证过 `acp-generic`），
所以这是"暂缓"不是"不可行"。

---

## 7. `agent-native` — adapter seam 的接口纪律

来源：agent-native.com/docs/sandbox-adapters

- **seam 要窄。** `adapter.ts` 只定义 contract，`index.ts` 只做选择
  （`getSandboxAdapter()` / `registerSandboxAdapter()`），
  `run-code.ts` 是消费者且**换 backend 时永不改动**。
  → 采纳：`src/runtime/registry.ts` 是纯选择器，
  `src/orchestrator/` 是消费者。
- **未知值不崩，回退并报告。** *"unknown values fall back to local rather
  than failing the run"*。
  → 采纳：`registry.get()` 找不到 adapter 时抛
  `AdapterNotFoundError` 并**列出可用的 adapter id**，
  属于"操作者可以立刻修复"的错误，不是"静默跑错"。

---

## 8. `laya`（决策库，非 server）— 已本地验证

定位到的是 `laya.Router` / `laya.route(state, questions)` → `RouteDecision` /
`laya.predict()` / `laya.structured`（pydantic/JSON Schema）。

**本轮已在本地跑通**，详见 `docs/DECISION_PROVIDER.md`。修正与补充原记录：

- 原记录说"laya 是决策库，**非 server**"——不准确。`laya-serve` 是官方 server，
  暴露 `/health` 与 `POST /v1/systemone`，响应是 Jev-compatible envelope。
- `RouteDecision` 天然是"结构化决策"，与本项目 `Decision` 形状对得上 —— 成立。
  已落盘为 `src/decision/types.ts`，但**收紧了**：词汇表封闭
  （`WORK_KINDS` / `COMPLEXITY_LEVELS`），且 `DecisionProvider` 没有 `fallback`
  成员、没有 `tryDecide`，从类型上禁止"决策不了就默认交给某个 agent"。
- `max_loaded` / LRU checkpoint 驻留说明本地多模型是常态 —— 成立且已实测：
  三个 checkpoint（`english` / `multilingual` / `typed-decisions`）同时驻留
  RTX 5070，冷加载 6.1 s，稳态单次推理 17–28 ms。
- **新增约束**：`laya-serve` 对若干非法输入返回 `200` 但结果退化
  （`questions: {}` → `answers: {}`；单选项 choice 恒返回该项；
  `criteria` 传 list → `choice: "a"`）。所以 provider 必须校验 payload，
  不能只看 HTTP 状态码。已按此实现并用 stub server 固化为 56 条契约测试。
- **新增约束**：criteria 集合即决策空间。同一段英文 bug 报告在 2 选项
  （implementation/review）下判为 `review`，在 4 选项下判为 `debugging`。
  因此 question set 固定在 `src/decision/laya.ts`，不交给调用方按请求变化。
- **新增约束**：语言会改变结论。同一重构任务英文 `review=yes`（noul 0.678）、
  中文 `review=no`（noul 0.004）。`review_required` 只能当带分布的提示。
- **环境约束**：本机 `huggingface.co` 不可达，必须 `HF_ENDPOINT=https://hf-mirror.com`。

Phase 1 仍不接入 orchestrator：agent 选择保持显式（`--agent`），直到这个信号
可信到可以独立驱动 dispatch。

---

## 9. Agent Skills 调研 — 详见 `docs/SKILLS_EVALUATION.md`

`obra/superpowers`（292.3k★ MIT）与 `addyosmani/agent-skills`（99.6k★ MIT）
已 clone 到临时 fixture 实测，不是只看 README：

- 对 OpenCode **1.18.31** 的真实 loader 契约校验了全部 40 个候选 skill：
  **0 个加载失败**。真正的区分点是工作流冲突与上下文成本，不是加载。
- 两者的 `.codex-plugin/plugin.json` 都是 `"skills": "./skills/"`，
  所以**同一份 skill 目录同时供 OpenCode 与 Codex 使用**，不需要分叉两份。
- 决定性约束来自本项目自身的 capability matrix：**OpenCode `rejects: review`，
  只有 Codex `can: review`**。因此 build 类 skill 归 OpenCode，
  review 类 skill 归 Codex——这不是偏好，是被能力矩阵强制的。
- 推荐 5 个 core skill，全部来自 agent-skills：`test-driven-development`、
  `api-and-interface-design`、`code-review-and-quality`、
  `debugging-and-error-recovery`、`doubt-driven-development`（合计 ~19.7k tok，
  按需加载）。
- `superpowers/requesting-code-review` 判 **ADAPT**：它的核心机制是
  "dispatch 一个 reviewer subagent"，且其 rationalization 表**明确禁止**就地
  review——这两点都与本项目冲突（reviewer 是独立 Codex 进程，且 review 的
  dispatch 归 orchestrator 而非 implementer）。保留其 SHA 捕获、
  Critical/Important/Minor 分级、"绝不带着未修的 Important 继续"等部分。
- **不整包安装 superpowers**：其 OpenCode 安装路径会加入
  `.opencode/plugins/superpowers.js`，在 session 启动时**执行插件代码**注入
  bootstrap 方法论。本项目倾向可组合的 markdown，而非会覆盖 agent 判断的注入式流程。

---

## 10. 汇总：本项目实际复用了什么

| 借鉴对象 | 借鉴内容 | 落地位置 |
|---|---|---|
| NAR | model-free kernel 分层、终态枚举、`run`≠完成、稳定工具面、显式 agentId、凭证纪律、配置查找链 | `src/core/types.ts`、`src/orchestrator/` |
| pi-subagents | adapter seam 文件切分、capability matrix、输出截断+落盘 | `src/adapters/`、`src/core/types.ts` |
| agents-mcp-gateway | task/thread 分离模型、env 白名单、有界等待 | `src/core/types.ts`、`src/runtime/session.ts` |
| @riposta/pi-jev | kernel 入口零决策逻辑、模块经 deps 注入不互相 import | `src/runtime/registry.ts` |
| pi-jev-router | 失败策略必须显式声明（本项目取 fail fast） | `src/orchestrator/orchestrator.ts` |
| agent-native | seam 要窄、未知值给可操作错误 | `src/runtime/registry.ts` |
| ACP 三家 | 传输无关的 adapter 契约（推迟实现） | `AgentCapabilities.transport` |
| laya | 本地多 checkpoint 决策、typed choice/score/noul、Jev-compatible envelope | `src/decision/` |
| agent-skills / superpowers | 封闭词汇表式决策接口、显式失败、review 与 build 的能力分离 | `src/decision/types.ts`、本文 §9 |

**没有任何一个上游项目的代码被直接复制。** 全部是契约与文件切分的借鉴，
因为没有两个在语言、agent 列表、目标形态上与本项目一致。
