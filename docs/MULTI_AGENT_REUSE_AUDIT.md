> **[Historical — 2026-09-29 复用审查]** 已被 docs/EXTERNAL_ORCHESTRATOR_REUSE_AUDIT.md
> （+ Codex 复核）取代为最新复用结论。当前基线见 docs/PROJECT_BASELINE.md。

# Multi-Agent 现成方案源码复用审查（READ-ONLY / RESEARCH / REUSE AUDIT）

调查日期：2026-09-29 · 机器：Windows 11 / Node v24.18.1 / 本项目为 TypeScript + Node + Native CLI

> **本轮未修改本项目任何代码、adapter、orchestrator、runtime、dashboard、package.json，
> 未添加依赖，未提交 commit，未修改任何外部 Agent 安装目录。** 仅在 `%TEMP%\ma-reuse-audit`
> 下 clone 了候选仓库做只读源码审查。本文件是唯一新增产物。
>
> 源码级审查方法：`git clone --depth 1` 到临时目录 → 读 `LICENSE` + 读 `src/` 关键模块 +
> 读 `package.json`/`pyproject.toml` + `Select-String` 定位实现。**未运行任何候选项目的安装/构建**，
> 因此所有"已实现"结论都来自源码阅读，非运行验证；已逐条标注证据路径。

---

## 0. 结论速览（先看这个）

| 问题 | 结论 |
|---|---|
| 有没有现成项目能直接当 Multi-Agent 基础？ | **没有**。没有候选同时满足「TS/Node + Windows + 直接调 native coding CLI + 全部生命周期」。 |
| 那还能复用什么？ | **有，而且很多。** 最强的两个直接可抄来源是 **`tintinweb/pi-subagents`（MIT, TS）** 与 **`openai/symphony`（Apache-2.0, SPEC+Elixir）**。 |
| 我们还要自己写多少？ | **核心仍需自己写的是**：native CLI adapter/capability normalization、quota policy、Windows 进程树、Decision→Policy 接线。协调/调度/隔离/终止这些**大部分可提取或照搬**。 |
| 最大 License 风险 | **Chorus = AGPL-3.0**（复制进本项目会触发网络服务 copyleft）。其余候选为 MIT/Apache-2.0。 |
| 最大架构冲突 | 主流 Python 框架（Agent Framework / AG2 / AutoGen / MetaGPT / CAMEL / Swarms）是 **provider-SDK-first**，与本项目 native-CLI-first 冲突；且需 Python 服务，不能嵌入 Node。 |
| 最省重复开发的组合 | **pi-subagents（提取编排原语）+ Symphony（隔离/重试/对账语义，照 SPEC 重写）+ 我们现有 Adapter/Runtime 不动**。 |

---

## A. 候选项目表

"Native CLI" 指：能否把外部 CLI 子进程当作一等 Agent 执行（而不是调 provider API）。

| Project | Repo | License | Language | Architecture | Task/DAG | Agent Spawn | Communication | Persistence | Retry | Recovery | Workspace | Review | Observability | Native CLI | Node compat | Windows | Reuse |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **pi-subagents** | tintinweb/pi-subagents | MIT | TS/Node | 扩展式 subagent manager | pipeline/parallel 脚本（非通用 DAG） | ✅ Agent 工具，深度上限默认 2 | ✅ 事件总线 + RPC | ✅ 会话/调度文件持久化 | 部分（turn limit） | 部分（resume） | ✅ git worktree 隔离 | 部分（gate: 命令校验） | ✅ widget/FleetView/事件 | ⚠️ 仅 pi 自己的 CLI（子进程模型可借鉴） | ✅ TS，4 个运行依赖 | 代码基本跨平台，但绑定 pi SDK | **MODULE EXTRACTION** |
| **Symphony** | openai/symphony | Apache-2.0 | Elixir (+语言无关 SPEC) | 轮询 tracker → 每 issue 隔离工作区 → 跑 Codex | ❌ 单 issue，非 DAG | ❌ 无子 Agent | ❌ 无 | ⚠️ 无数据库，靠 tracker/FS 重启 | ✅ 指数退避 | ✅ reconcile on restart | ✅ per-issue workspace | ❌（交给 agent 流程） | ✅ 结构化日志 + dashboard | ✅ Codex app-server 子进程 | ❌ Elixir | 部分（SSH 路径/进程依赖 POSIX） | **ADAPT**（照 SPEC 重写） |
| **Fifony** | forattini-dev/fifony | Apache-2.0 | TS/Node | Issue 驱动的多 Agent pipeline + daemon | 部分（parallelSubTasks） | ✅ 同 issue 并行子任务 | ⚠️ 文件/handoff，非消息总线 | ✅ 文件状态 | ✅ retry/failure-analyzer | ✅ pid 管理 | ✅ git worktree + merge | ✅ review-profile | ✅ WebSocket + UI | ✅ claude/codex/gemini CLI 适配器 | ✅ TS，但依赖偏重（node-pty/transformers/s3db） | 代码跨平台，但用了 shell/execSync | **MODULE EXTRACTION** |
| **Chorus** | chorus-aidlc/chorus | **AGPL-3.0** | TS/Node (+Prisma/Postgres) | 全栈 Web 应用 + daemon 唤醒 agent | ✅ 有依赖/lineage | ⚠️ 每 entity 一个 session | ⚠️ SSE/wake 队列 | ✅ Postgres | ⚠️ | 部分 | ✅ worktree + merge | ✅ review 流程 | ✅ 完整 UI | ✅ claude/codex/kiro/pi/dsh CLI spawner（含 Windows .cmd 处理） | ✅ TS，但需 Postgres/Next | ✅ 有 win32 分支与 .cmd shim 解析 | **REFERENCE ONLY（License）** |
| Microsoft Agent Framework | microsoft/agent-framework | MIT | Python (+dotnet) | Provider-SDK agent + 图工作流引擎 | ✅ 完整 DAG（fan-out/in/switch） | ✅ workflow 内 executor | ✅ 消息 + edge | ✅ checkpoint（file/cosmos 等） | ✅ | ✅ checkpoint 恢复 | ❌（无 native workspace） | ❌ | ✅ OTel 事件 | ❌ provider SDK first | ❌ 需 Python 服务 | 部分 | **NOT SUITABLE / REFERENCE ONLY** |
| AG2 | ag2ai/ag2 | Apache-2.0 | Python | 会话式多 Agent 网络 | ⚠️ 网络非 DAG | ✅ delegate | ✅ network/channels/handoff | ✅ | ✅ | 部分 | ❌ | ✅ | ✅ observers | ❌ | ❌ Python | 部分 | **REFERENCE ONLY** |
| Microsoft AutoGen / Magentic-One | microsoft/autogen | CC-BY-4.0(docs) + **MIT(code)** | Python | 多 Agent 团队 + Magentic-One orchestrator | ❌（group chat） | ✅ team 成员 | ✅ group chat + handoff | ✅ | ✅ | 部分 | ❌ | ✅（Magentic 有 ledger） | ✅ | ❌ | ❌ Python | 部分 | **REFERENCE ONLY** |
| MetaGPT | FoundationAgents/MetaGPT | MIT | Python | 固定 SOP 角色流水线 | ❌（固定 SOP） | ✅ 团队角色 | ⚠️ 环境消息 | ✅ | ⚠️ | ⚠️ | ⚠️ | ✅ | 部分 | ❌ | ❌ Python | 部分 | **REFERENCE ONLY** |
| Swarms | kyegomez/swarms | Apache-2.0 | Python | Agent + workflow structs | ✅ graph/concurrent workflow | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ❌ | ⚠️ | 部分 | ❌ | ❌ Python | 部分 | **REFERENCE ONLY** |
| CAMEL | camel-ai/camel | Apache-2.0 | Python | Role-playing societies + runtimes | ⚠️ | ✅ | ✅ | ✅ | ⚠️ | 部分 | ⚠️（有 runtime/workspace） | ⚠️ verifier | ✅ | ❌ | ❌ Python | 部分 | **REFERENCE ONLY** |
| OpenHands | All-Hands-AI/OpenHands | MIT | TS(frontend)/Python(runtime) | 全栈 app + agent-server + sandbox | ⚠️ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ✅（container workspace） | ⚠️ | ✅ 完整 UI | ⚠️ 自研 agent-server，非通用 CLI | ❌ UI 需完整栈 | 部分 | **NOT SUITABLE** |

图例：✅ 源码有实现 · ⚠️ 部分/受限 · ❌ 无。

---

## B. 「可以直接拿」的模块（本轮最重要输出）

### B.1 `tintinweb/pi-subagents`（MIT · TS · 4 个运行依赖）— 最值得抄的一个

这是**唯一一个 TS/Node、且把「编码 CLI 的 subagent 编排」整套做完**的项目。它不是 library
而是 pi 扩展，因此**不能整体拿来**，但以下模块可以直接 extract / adapt。

| Repo path | 模块 | 功能（解决我们的什么问题） | License | 我们的适配方式 |
|---|---|---|---|---|
| `src/worktree.ts` | Git worktree 隔离 | 每个 agent 一个临时 worktree；无改动自动清理，有改动则提交到 branch 并返回 `{path,branch,baseSha,workPath}`；含 `worktreeIsolationEnabled` 全局开关 | MIT | **adapt**：把 `pi.exec` 换成 `child_process.execFile`，直接进我们 Multi-Agent workspace 层 |
| `src/agent-manager.ts` | 并发池 + 生命周期 | **两个独立并发池**：background（默认 10）/ foreground；超限排队自动启动；`occupiesPoolSlot` 判定；`depth` 记录嵌套 | MIT | **extract（核心思想）**：我们的 `maxConcurrentAgents` / `maxFanOut` 直接照此建模 |
| `src/nested-tools.ts` | 子 Agent spawn 与深度上限 | 默认 `maxSubagentDepth = 2`；`depth >= maxSubagentDepth` 时**硬拒绝**并给出提示；`allowedSubagents` 白名单是权限边界；子 agent 默认阻塞式、detached 子 agent 在父结束时停止 | MIT | **adapt**：我们的 MVP 把 `maxSubagentDepth` 设 1，`allowedSubagents` → capability allowlist |
| `src/agent-runner.ts` | 会话创建/执行/结果收集 | `createAgentSession` 包装、结构化输出、skill 预加载、usage 汇总 | MIT | **reference**：会话原语，绑定 pi SDK 处需重写 |
| `src/usage.ts` | token 生命周期汇总 | `addUsage` / `LifetimeUsage`：token 花销向父级 roll-up | MIT | **extract**：我们的 cost/token roll-up 直接可照此 |
| `src/workflow/runtime.ts` + `src/workflow/worker-source.ts` | 脚本化编排 + 硬上限 | `agent()/parallel()/pipeline()`；**worker thread + node:vm 沙箱**；硬上限 `WORKFLOW_AGENT_CAP=1000`、`WORKFLOW_ITEM_CAP=4096`、`WORKFLOW_NESTED_CAP=256`；"脚本没有任何绕过上限的通路" | MIT | **extract**：这是防"无限 spawn / 无限 fan-out"的现成范式 |
| `src/schedule-store.ts` | PID 锁 + 原子写持久化 | 每次变更：PID 排他锁 → 重读 → 改 → temp+rename 原子写；会话级 json store | MIT | **extract**：我们 store 的并发安全/恢复可对齐 |
| `src/agent-types.ts`, `src/custom-agents.ts` | Agent 类型/自定义定义 | 项目/全局 agent 定义、工具限制、模型、thinking level | MIT | **reference**：capability 声明范式 |
| `src/abortable.ts`, `src/status-note.ts` | 取消 + 优雅 turn 上限 | `maxTurns` 生效前先"wrap up"警告再硬 abort，产出干净部分结果 | MIT | **adapt**：对应我们的 timeout/cancel + partial output |
| `src/group-join.ts`, `src/cross-extension-rpc.ts` | 完成通知聚合 + 版本化 RPC | 组内完成聚合；跨扩展 RPC 信封带 protocol version | MIT | **reference**：typed notification 范式 |

**关键判断**：pi-subagents 的"深度上限 + 双并发池 + worktree 隔离 + token roll-up +
沙箱化脚本编排"正是本项目 MVP 最缺的五件套。**License 是 MIT，限制最少。**

### B.2 `openai/symphony`（Apache-2.0 · SPEC 语言无关 + Elixir 参考实现）

本项目与 Symphony 的取向**高度一致**：它也是"编排器只调度，不调 provider API，真正跑的是
Codex app-server 子进程"。虽然实现是 Elixir，但仓库把它写成了**语言无关 SPEC**，可照 SPEC 重写。

| Repo path | 模块 | 功能 | License | 我们的适配方式 |
|---|---|---|---|---|
| `SPEC.md`（§1-§9） | 服务规格 | 轮询 tracker → 每个 issue 一个隔离 workspace → 跑 coding agent；有界并发；单一权威 orchestrator state；重启对账 | Apache-2.0 | **adapt（照 SPEC 重写）**：我们的调度器契约可直接引用其术语 |
| `elixir/lib/symphony_elixir/workspace.ex` | per-issue workspace | `create_for_issue`：确定性工作区路径 + 路径安全校验 + 钩子 + 失败清理；支持远程 worker | Apache-2.0 | **adapt**：我们的 workspace 抽象 |
| `elixir/lib/symphony_elixir/orchestrator.ex` | 调度循环 + 对账 + 退避 | `State{running, blocked, retry_attempts, claimed, completed}`；`reconcile_running_issues` / `reconcile_blocked_issues`；`@failure_retry_base_ms` 指数退避；`max_concurrent_agents`（可按 state 配） | Apache-2.0 | **adapt**：我们的 retry/recovery/reconcile 语义 |
| `elixir/lib/symphony_elixir/agent_runner.ex` + `codex/app_server.ex` | Codex app-server 子进程 | 证明"native CLI/app-server 子进程"是可编排的 | Apache-2.0 | **reference**：与我们 Codex adapter 同思路 |
| `elixir/docs/token_accounting.md` + status_dashboard | token 记账 + 状态面板 | codex_totals / rate limits / dashboard snapshots（含 fixture） | Apache-2.0 | **reference**：我们的 Observability 布局 |

### B.3 `forattini-dev/fifony`（Apache-2.0 · TS/Node · 同为 CLI agent 编排）

和本项目最"同构"的 TS 项目：provider adapter + git worktree + 并行子任务 + review。但仓库较小
（12 stars）、依赖偏重、且用 `execSync`/shell。**建议 extract 而非整体依赖。**

| Repo path | 模块 | 功能 | License | 我们的适配方式 |
|---|---|---|---|---|
| `src/agents/adapters/registry.ts` | Provider adapter 注册表 | `ProviderAdapter{capabilities,buildCommand,buildReviewCommand,compile}` + `ADAPTERS{claude,codex,gemini}` —— **和我们 `src/adapters` 几乎同形** | Apache-2.0 | **reference**：可对照校验我们的 adapter 契约是否漏字段 |
| `src/agents/adapters/types.ts` + `shared.ts` | 归一化选项 | `model/effort/addDirs/imagePaths/jsonSchema/noToolAccess/maxBudgetUsd/readOnly/resumeSessionId/sessionId` | Apache-2.0 | **extract**：`resumeSessionId` / `addDirs` / `readOnly` 是我们未来需要的归一化字段 |
| `src/domains/workspace.ts` | worktree + merge | `createGitWorktree`、`mergeWorkspace`、`ensureWorktreeCommitted`、diff 统计、路径 hydrate | Apache-2.0 | **adapt**：与 pi-subagents 的 worktree 二选一或互补 |
| `src/agents/parallel-executor.ts` | 并行子任务 + fanout | `spawnParallelSubTasks`：`maxParallelSubTasks` 限制 fanout；每个子任务**独立 sub-worktree** | Apache-2.0 | **adapt**：我们的 MVP fanout 直接照此 |
| `src/agents/command-executor.ts` | 超时执行 | `runCommandWithTimeout` / `runHook` | Apache-2.0 | **reference**：对照我们的 spawn 超时 |
| `src/agents/retry.ts`（及 `failure-analyzer.ts` / `review-failure-history.ts`） | 重试 + 失败分析 + review 历史 | 区分失败类型、review 拒绝历史 | Apache-2.0 | **reference**：失败分类概念 |
| `src/agents/adapters/usage.ts` + `cli-wrapper.ts` | 用量 + CLI 中间层包装 | `fifony-wrap`：before/after hook 包裹任意 CLI 命令并捕获输出 | Apache-2.0 | **adapt**：`binary resolver` 与 CLI 包装思路 |

### B.4 `chorus-aidlc/chorus`（**AGPL-3.0** · TS/Node）— 只能"读设计"，不能抄代码

Chorus 的 spawner 分层是**本项目 Windows 问题的现成答案**（`.cmd` shim 解析、跨平台 argv、
session map、进程 killer、wake 队列），但 **AGPL-3.0 使复制代码进入本项目有实质 copyleft 风险**。

| Repo path | 模块 | 功能 | License | 我们的适配方式 |
|---|---|---|---|---|
| `cli/claude-spawner.mjs` | Windows `.cmd` shim 解析 | 注释明确：`claude` 在 Windows 上是 `claude.cmd`，`spawn("claude")` 无 `shell:true` 会 ENOENT；**walk PATH 找 `claude.cmd/.exe/claude`**；含 `escapeCwd`、`resolveSpawnCommand` | **AGPL-3.0** | **reference only**：与我们 `runtime/launcher.ts` 的 `.cmd` 处理同问题；**照思路重写，不复制** |
| `cli/{codex,kiro,pi,dsh}-spawner.mjs` | 多后端 spawner + `spawner-select.mjs` | 统一 `Spawner.wake()` 契约，后端可插拔 | AGPL-3.0 | reference only |
| `cli/{session-map,codex-session-map,kiro-session-map}.mjs` | session 映射 | CLI 生成 id vs 客户端预置 id 两种 resume 语义 | AGPL-3.0 | reference only |
| `cli/{process-killer,child-exit,interrupt-reporter}.mjs` | 进程树清理 + 中断上报 | 子进程终止与上报 | AGPL-3.0 | reference only |
| `cli/{wake-queue,waker,daemon-agent}.mjs` | 唤醒队列/调度 | 有界唤醒队列、daemon 调度 | AGPL-3.0 | reference only |
| `cli/lineage.mjs` | 实体 lineage 解析 | idea→entity 归属解析（单一来源，不做客户端 lineage walk） | AGPL-3.0 | reference only（设计原则） |

> **License 结论（Chorus）：** AGPL-3.0 允许商业使用与修改，但**分发或作为网络服务提供时，
> 整个衍生作品须以 AGPL 开源**。把它复制进本项目会强制本项目整体 AGPL。**不要 copy 代码**；
> 只借鉴设计，或独立进程 + 明确边界地使用（同样有风险，需法律确认）。

### B.5 其余候选可提取的"小模块"（都是 Python，需重写）

| Repo path | 模块 | 功能 | 适配方式 |
|---|---|---|---|
| `agent-framework/python/packages/core/agent_framework/_workflows/_edge.py` / `_edge_runner.py` / `_validation.py` | DAG 边/扇出扇入/graph 校验 | `FanOutEdgeGroup`/`FanInEdgeGroup`/`SwitchCase` + `validate_workflow_graph`（环检测） | reference：**我们 DAG 的算法可对照它，用 TS 重写** |
| 同上 `_checkpoint.py` | checkpoint 存储 | `WorkflowCheckpoint` + `CheckpointStorage`（可 file/cosmos 等），**可跨实例恢复** | reference：我们的 Recovery 设计对照 |
| 同上 `_request_info_mixin.py` | Human-in-the-loop | request/response 式人工介入原语 | reference |
| `autogen/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_magentic_one/_magentic_one_orchestrator.py` | Magentic-One orchestrator | 任务台账（ledger）+ 进度/重规划 | reference：我们的 task ledger |
| `ag2/ag2/network/` (`delegate.py`,`tasks.py`,`channels.py`,`peers.py`) + `task.py`/`hitl.py`/`policies/` | Agent 网络 + 任务 + HITL + 策略 | typed 网络通信与任务抽象 | reference |
| `swarms/swarms/structs/graph_workflow.py` / `concurrent_workflow.py` | 图/并发 workflow | 简单 DAG 结构 | reference |
| `camel/camel/terminators/` + `verifiers/` | 终止条件 + 校验 | 终止与验证原语 | reference |

---

## C. 「不要重复造轮子」清单

已有成熟实现（**直接照抄思路 / 提取模块**，不要从零设计）：

- **Git worktree 隔离**：抄 `pi-subagents/src/worktree.ts`（MIT，可直接改）或 `fifony/src/domains/workspace.ts`。
- **每 issue/per-agent 隔离 workspace + 路径安全**：抄 `symphony/.../workspace.ex` + `SPEC.md`。
- **并发池 + 排队**：抄 `pi-subagents/src/agent-manager.ts`（background/foreground 双池）。
- **深度上限 / 防无限 spawn**：抄 `pi-subagents/src/nested-tools.ts` 的 `maxSubagentDepth` + `allowedSubagents`。
- **脚本编排的硬上限（fan-out / nested cap）**：抄 `pi-subagents/src/workflow/runtime.ts` 的 `WORKFLOW_AGENT_CAP/ITEM_CAP/NESTED_CAP`。
- **token 花销 roll-up**：抄 `pi-subagents/src/usage.ts`。
- **PID 锁 + 原子写持久化**：抄 `pi-subagents/src/schedule-store.ts`。
- **优雅 turn 上限（先 wrap-up 再 abort）**：抄 `pi-subagents/src/status-note.ts`。
- **指数退避 + 重启对账**：抄 `symphony/.../orchestrator.ex` 的 `reconcile_*` + `@failure_retry_base_ms`。
- **DAG 环检测 / 扇出扇入 / graph 校验**：对照 `agent-framework/.../_validation.py` `validate_workflow_graph`。
- **workflow checkpoint 与恢复**：对照 `agent-framework/.../_checkpoint.py`。
- **Windows `.cmd` shim 解析**：对照 `chorus/cli/claude-spawner.mjs`（**只读思路，不抄 AGPL 代码**）。
- **task ledger / 重规划**：对照 Magentic-One orchestrator。

## D. 「必须自己实现」清单

源码调查确认，这些**没有现成可直接用的实现**，必须自己写（这是本项目真正的护城河）：

- **OpenCode / Codex / WorkBuddy CLI adapter**：所有候选里只有 Chorus/Fifony 触碰 coding CLI，且都面向各自工具；我们的 adapter 契约（`AgentAdapter{probe,validateRequest,createTransport,mapEvent,terminalPolicy}`）无对应物。
- **Native CLI capability normalization**：把 `resume/modelSelection/review/sandbox/costReporting/steering/worktree` 归一化成 boolean 并在 spawn 前 enforce —— 候选里没有等价物。
- **Windows 进程树生命周期**：`kill /T`、`.cmd` wrapper、orphan 回收、graceful cancel —— 只有 Chorus 部分涉及且 AGPL。
- **Quota / Model Policy**：`Agent→Model→Capability→Quota→AllowedTaskTypes` 全链路无候选实现（`agent-framework` 的 model 选择≠quota）。
- **Decision Layer / Laya 接线**：本项目独有。
- **与现有 `RunResult`/`RuntimeEvent`/`EventHub` 的对接**：候选全部有自己的事件模型，必须写 adapter 层翻译。

## E. 推荐组合（不做主观排名）

### Option A — 最少修改方案（Reference-only）

- **复用**：无代码，只把 `pi-subagents`（并发/深度/上限）与 `symphony`（workspace/reconcile）当**设计基线**，全部自己写。
- **修改范围**：新 Multi-Agent 层 + 新 store 表。
- **引入依赖**：0。
- **License 风险**：无。
- **与现有 Runtime 冲突**：最小。
- **维护成本**：最高（自己实现全部）。
- **适合**：想保持"零外部依赖 + 完全自控"。

### Option B — 最大复用方案（Vendor/extract MIT 模块）

- **复用**：从 `pi-subagents` extract `worktree.ts`、`agent-manager.ts` 并发模型、`usage.ts`、`schedule-store.ts`、`workflow/runtime.ts` 上限模型（MIT，改 import 即可），把 `pi.exec` 换成我们 `runtime/spawn.ts`；DAG/checkpoint 算法照 `agent-framework` 重写。
- **修改范围**：中（新 orchestration 包 + 少量改写）。
- **引入依赖**：0（vendor 源码，非 npm 依赖）；**需保留 MIT 版权头**。
- **License 风险**：低（MIT 允许复制/修改，只需保留 notice）。
- **与现有 Runtime 冲突**：低（这些模块与我们 IT 无重叠）。
- **维护成本**：中（需跟踪上游，但可 fork pin）。
- **适合**：想真正减少重复开发、又不想引入 Python/Postgres。

### Option C — 最轻量方案（Script-orchestration only）

- **复用**：只抄 `pi-subagents` 的 **脚本编排 + 硬上限** 模型（`agent()/parallel()/pipeline()` + cap），实现一个最小 DAG runner，不做常驻调度器/数据库。
- **修改范围**：小。
- **引入依赖**：0。
- **License 风险**：无（思路）。
- **与现有 Runtime 冲突**：最小（复用现有 `Orchestrator.run`）。
- **维护成本**：低。
- **适合**：只想先验证"Multi-Agent 是否值得"。

## F. 特别调查：28 个担心点 → 谁实现了 / 能否直接拿

| # | 担心 | 现成项目怎么解决 | 代码位置 | 能否直接拿 |
|---|---|---|---|---|
| 1 | Token 爆炸 | pi-subagents token roll-up + turn 上限；Symphony token 记账 | `pi-subagents/src/usage.ts`、`status-note.ts`；`symphony/elixir/docs/token_accounting.md` | ✅ 思路可抄 |
| 2 | Agent 无限 spawn | 深度上限 + 沙箱脚本 agent cap | `pi-subagents/src/nested-tools.ts`、`workflow/runtime.ts` | ✅ 可抄 |
| 3 | 无限互聊 | pi-subagents 是命令式 spawn（非自由 chat）；AG2/AutoGen 反而有 group chat 风险 | `pi-subagents/src/agent-manager.ts` | ✅ 用 spawn 模型规避 |
| 4 | Context 爆炸 | pi-subagents `child-context.ts` 选择性 fork；本项目已定结构化 brief | `pi-subagents/src/child-context.ts` | ⚠️ 参考 |
| 5 | DAG 死锁 | Agent Framework `validate_workflow_graph` 环检测 | `agent-framework/.../_validation.py` | ⚠️ 重写算法 |
| 6 | Retry Loop | Symphony 指数退避 + retry_attempts；Fifony failure-analyzer | `symphony/.../orchestrator.ex`；`fifony/src/agents/failure-analyzer.ts` | ✅ 思路可抄 |
| 7 | Reviewer Loop | Fifony review-failure-history（有上限）；pi-subagents 无内建 | `fifony/src/agents/review-failure-history.ts` | ⚠️ 参考 |
| 8 | 子 Agent 失败 | pi-subagents 子 agent 状态机 + 父通知 | `pi-subagents/src/agent-manager.ts` | ✅ |
| 9 | 父 Agent 失败 | pi-subagents "detached 子 agent 在父结束时停止" | `nested-tools.ts` | ✅ |
| 10 | Quota 耗尽 | **无候选实现** | — | ❌ 自己写（等 Phase 4） |
| 11 | GPU/RAM 爆炸 | **无候选实现**（全部按 token/agent 数限制） | — | ❌ 自己写 |
| 12 | 多 Agent 改同一文件 | pi-subagents / Fifony worktree 隔离 | `pi-subagents/src/worktree.ts`；`fifony/src/agents/parallel-executor.ts` | ✅ 可抄 |
| 13 | Git 冲突 | Fifony `mergeWorkspace`；pi-subagents 提交到 branch 由人合并 | `fifony/src/domains/workspace.ts` | ✅ 思路可抄 |
| 14 | Orchestrator 崩溃 | Symphony 重启对账（tracker/FS 驱动，无 DB）；Agent Framework checkpoint | `symphony/.../orchestrator.ex`；`agent-framework/.../_checkpoint.py` | ⚠️ 两种范式二选一 |
| 15 | 子进程孤儿 | Chorus process-killer/child-exit（AGPL）；本项目已有 Windows 清理 | `chorus/cli/process-killer.mjs` | ⚠️ 只读思路 |
| 16 | Auth failure | 本项目 WorkBuddy 已解决（exit 0 需协议证据）；候选无等价 | 本项目自身 | 已自有 |
| 17 | Model unavailable | Fifony model-discovery | `fifony/src/agents/model-discovery.ts` | ⚠️ 参考 |
| 18 | Capability mismatch | 本项目 capability matrix 已领先；Fifony ProviderAdapter.capabilities | `fifony/src/agents/adapters/registry.ts` | 已自有 |
| 19 | Permission escalation | pi-subagents `allowedSubagents` 白名单 = 权限边界；Chorus permission-mode | `pi-subagents/src/nested-tools.ts` | ✅ 可抄 |
| 20 | Secret leakage | Chorus 明确"API key 绝不输出"；本项目 adapter 也不读凭证 | `chorus/cli/agents.mjs` | ✅ 思路 |
| 21 | Artifact 丢失 | pi-subagents `output-file.ts` transcript 落盘 | `pi-subagents/src/output-file.ts` | ✅ 参考 |
| 22 | Stale context | **无候选解决** | — | ❌ 自己设计 |
| 23 | Result 不一致 | **无候选解决**（AutoGen/AG2 靠 chat 收敛，不可控） | — | ❌ 自己设计 |
| 24 | Human approval | Agent Framework `_request_info_mixin.py`；AG2 `hitl.py` | 两处 | ⚠️ 重写 |
| 25 | Cancel 传播 | pi-subagents `abortable.ts` + 父结束停止子；本项目已有 cancel | `pi-subagents/src/abortable.ts` | ✅ |
| 26 | Observability | Symphony dashboard+snapshots；pi-subagents widget/event bus | 两处 | ⚠️ 参考 |
| 27 | Cost attribution | pi-subagents usage roll-up（token）；cost 无候选 | `pi-subagents/src/usage.ts` | ⚠️ 半 |
| 28 | Windows 进程管理 | Chorus `.cmd` shim 解析（AGPL）；本项目已实现大部分 | `chorus/cli/claude-spawner.mjs` | ⚠️ 只读思路 |

## G. 额外搜索结论

除给定 10 个候选外，额外检索 `agent orchestrator / coding agent harness / subagent orchestration /
agent workflow` 并实际 clone 检查了 `tintinweb/pi-subagents`、`mvschwarz/openrig`、
`first-fluke/oh-my-agent`。结论：**`pi-subagents` 是唯一同时满足「TS/Node + coding-CLI subagent +
MIT + 低依赖」的项目**，应作为首选复用对象。其余新发现项目规模/成熟度/契合度均不优于它。

## H. 最终结论（逐条回答）

**问题 1：有没有现成项目可以直接作为 Multi-Agent 基础？**
没有。没有候选同时满足「TS/Node + Windows + 直接调 native coding CLI + 完整生命周期」。
最接近的 `pi-subagents` 绑定 pi SDK，`Symphony` 是 Elixir，`Chorus`/`Fifony` 是完整应用或有重依赖。

**问题 2：哪些模块可以直接拿？**
首选 `pi-subagents`（MIT）的 `worktree.ts` / `agent-manager.ts` 并发模型 / `usage.ts` /
`schedule-store.ts` / `workflow/runtime.ts` 上限模型 / `nested-tools.ts` 深度上限；
其次照 `symphony` SPEC 与 `orchestrator.ex`/`workspace.ex` 重写隔离与对账；
`fifony` 的 adapter registry 与 `parallel-executor.ts` 作对照。全部集中在 §B。

**问题 3：我们还需要自己写多少？**
协调原语大部分可抄；**必须自己写的只有**：native CLI adapter/capability normalization、
Windows 进程树、quota policy、Decision→Policy 接线、与现有 `RunResult/EventHub` 的翻译（§D）。

**问题 4：哪些方案与 TS + Native CLI Runtime 冲突？**
所有 Python 框架（Agent Framework / AG2 / AutoGen / MetaGPT / CAMEL / Swarms）都是 provider-SDK-first，
需 Python 服务，不能嵌入 Node；OpenHands 需完整 app+sandbox 栈。这些**不适合作为基础**（可作参考）。

**问题 5：哪些方案存在 License 风险？**
**只有 Chorus（AGPL-3.0）** 是实质风险：复制代码或作为网络服务会强制本项目整体 AGPL。
其余为 MIT/Apache-2.0（可复制，保留 notice）；AutoGen 的 docs 是 CC-BY-4.0，**代码是 MIT**。

**问题 6：哪种组合能最大程度减少重复开发？**
`pi-subagents`（提取编排原语，MIT）+ `Symphony`（照 SPEC 重写隔离/退避/对账）+
本项目现有 Adapter/Runtime 不动。即 Option B。

**问题 7：只允许增加最少代码，应该复用什么？**
复 **`pi-subagents` 的脚本编排 + 硬上限模型**（Option C）：`agent()/parallel()/pipeline()` +
`WORKFLOW_AGENT_CAP/ITEM_CAP/NESTED_CAP`，做成最小 DAG runner，复用现有 `Orchestrator.run`，
不引入依赖、不引入 Python/DB。

---

## 附：本轮未修改项目的证据

- 本项目工作树在审查前后一致：仅 `package.json`(M)、`src/adapters/index.ts`(M)、
  `src/adapters/workbuddy.ts`(??)、`tests/workbuddy.test.ts`(??)、`temporary-dashboard/`(??)
  为既有改动；本轮只新增 `docs/MULTI_AGENT_REUSE_AUDIT.md`。
- `src/core/`、`src/runtime/`、`src/orchestrator/`、`src/cli/`、`src/decision/`、`src/adapters/` 未被本轮触碰。
- 外部候选仓库只 clone 到 `%TEMP%\ma-reuse-audit`，未运行其安装/构建，未改其内容。
