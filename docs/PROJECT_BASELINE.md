# Personal Workstation Orchestrator — Project Baseline

```text
Status   = CURRENT CANONICAL BASELINE · 2026-10-06
Scope    = 唯一正式基准：产品定位 / 架构 / 角色 / 主流程 / 实现状态 / 非目标
Rule     = 与本文冲突的其他文档，以本文为准；历史文档必须带 Status 标注
Baseline = 4852 tests / 0 failed（23 套件）· typecheck clean ·
           smoke:quick 17/21（4 个 Codex failure = 当前环境/CLI 问题，非 R4 回归）·
           native E2E 17/18（Case 15 = agent variance，非 lease/fencing 缺陷）
```

---

## 1. Product Positioning

> **这是一个运行在个人 Windows 工作站上的本地多 Coding Agent 编排器。**

它编排电脑上**已经安装、已经登录**的 Native Coding Agent CLI，让一台机器上的多个
本机 Agent 在一个 Laya 大脑的组织下完成复杂 Coding Task。

它**不是**：SaaS、企业级 AI 平台、多租户平台、云端 Agent 平台、Agent Runtime
替代品、模型托管平台、企业工作流引擎、正式 Control Center。

核心价值：

> 让一台已装多个 Native Coding Agent 的个人电脑，通过 Laya 把多个本机 Agent
> 组织起来，完成单个 Agent 难以独立完成的复杂 Coding Task——并让人类能通过
> 机器证据判断每一步是否真实发生。

## 2. Core Architecture

```text
用户
 ↓
工作台（CLI / temporary dashboard，只读观测）
 ↓
Laya（唯一决策大脑）
 ↓
Task / DAG / Parallel / Agent Routing
 ↓
Native Agent（OpenCode / Codex / WorkBuddy CN / WorkBuddy Intl）
 ↓
Attempt / Evidence
 ↓
统一 Execution Outcome
 ↓
Codex Review
 ↓
结果汇总
 ↓
用户（Human Gate）
 ↓
下一轮要求 / 修改建议 → 重新进入 Laya
```

边界不变式：

- Orchestrator 只编排，不替代 Native Agent 内部 runtime。
- Native session / tools / MCP / subagent / context / model / parallel 能力一律
  优先复用 Native Agent 自身能力，编排器不重造。
- Dashboard / Observation 对 runtime **只读**，无命令通道。

## 3. Single Brain: Laya

**Laya（L-A-Y-A）是唯一 task-level decision authority。**

- 输入：用户 objective + Observation（TaskStore 只读视图 / Attempt evidence /
  review verdict）。
- 输出：封闭词表的 typed decision（11 个 action，见 §13）与 task shape。
- 边界：Laya 做一轮任务的决策；**不构成 `Laya → Agent → Laya → Agent → 无限循环`**
  的自主机制。正式模型是 **Bounded Execution Round + Human Gate**：

```text
Decision → Execute → Observe → Evidence → Codex Review → User → END
```

用户决定下一轮。

- 禁止的等价物（历史讨论一律标 Historical）：GEV、Jev（作为决策模型）、
  第二 Planner、第二 Decision Engine、第二 Orchestrator Brain、独立 Routing
  Brain、独立 Handoff Brain。
- 术语澄清：`Jev-compatible envelope` 是**本地 laya-serve 的 HTTP 响应格式**
  （wire protocol 命名），属于 Laya 自身的传输层，不是第二个决策模型。

## 4. Native Agents（正式四个）

| Agent | 角色 | 状态 |
|---|---|---|
| OpenCode | 主实现 / research / test；native session `--session <threadId>` | VERIFIED |
| Codex | 独立 Review/Test Gate（+ implementation）；native `codex exec review` | VERIFIED |
| WorkBuddy CN | registered，**未认证（401，本机实测）** | UNAVAILABLE |
| WorkBuddy Intl | implementation；native `-r <sessionId>`；hy3 | VERIFIED |

规则：

- `agentId` = canonical machine identity；`agent` = display name。二者不得混用。
- 新增 Agent 走 Agent Admission / Extension Contract（R2-0 §24）：
  **Adding an Agent adds a worker identity, not a new workflow.**
- 优先复用 Native Agent 自身的 session / tools / MCP / subagent / context /
  parallel 能力；编排器不重造 Agent 内部 runtime。

## 5. Main Execution Flow（R1-1 后的真实管线）

```text
Laya Decision（classifyTask / 11-action decision loop）
  ↓
Planner / DAG（planTasks → validateCandidateDag → commitPlan）
  ↓
Assignment（filters → score → preference → assignIdentity/migrate）
  ↓
Spawn Gate（spawn + execute 双期重跑；最终 veto）
  ↓
Scheduler.tick（唯一 dispatch loop，promptFor/threadFor 只携带不生成）
  ↓
Native Agent Execution（唯一 execution edge：Orchestrator.run）
  ↓
RunResult → AttemptStore（append-only evidence）
  ↓
统一 Execution Outcome（成功 / 失败 / timeout / quota / unavailable 全部进入）
  ↓
Codex Review（结构化 verdict）
  ↓
Human Gate → END / 下一轮
```

## 6. Task / Attempt Model

- **Task 是稳定身份**（TaskId 永不因 Agent 切换改变）。
- **一个 Task 可以有多个 Attempt**，每个 Attempt 记录：agent / model / session /
  execution / evidence / outcome / errors / handoff / test / workspace。
- Attempt 不能因为 Agent 切换而彼此割裂：reassign/migration 只改 Assignment
  identity 并推进 leaseVersion，历史 Attempt 归属真实执行者。
- AttemptStore 是 append-only evidence authority，永不作为 task 状态来源。

## 7. Parallel Execution

- Laya 可把一个用户任务拆为多个独立 Task（`Task A → OpenCode`、
  `Task B → WorkBuddy Intl`、`Task C → OpenCode`），dependency 允许即并行。
- **优先复用 Native Agent 自身的 subagent / parallel capability**；编排器真正
  负责的只有：Task DAG / dependency / assignment / workspace-resource safety /
  scheduling / evidence。
- 并行写默认走 isolated workspace/worktree（WorkspaceManager + ResourceClaim）；
  shared mutable workspace 的并行写被禁止，除非显式 policy 允许。
- Multi-Agent 的定义：**parallel / dependency-based task execution**，
  NOT permanent autonomous agents。

## 8. Codex Review — 统一 Review（正式流程）

> **一个 Execution Round 无论成功、失败、报错、timeout、quota exhausted、
> Agent unavailable，都必须能够进入统一的 Codex Review 流程。**

```text
Execution Outcome（任何终态）
        ↓
Evidence（AttemptStore：agent/model/leaseVersion/toolCalls/exit/artifacts）
        ↓
Codex Review（独立审核者：检查结果 / 证据 / 测试 / 完成度，指出问题与建议）
        ↓
Review Result（结构化 verdict → applyVerification）
```

- Codex Review **不是**第二 Scheduler、第二 Planner、第二 Laya。
- 普通 review FAIL 走 bounded same-worker rework（maxAttempts + fingerprint
  双 guard），**不回 Laya**；只有 task-level planning failure 才回到 Laya replan。
- **当前实现状态：Implemented / Verified**——结构化 verdict 契约、bounded rework、
  `applyVerification` 统一入口，以及**每个终态 outcome 自动进入统一 Codex Review 的生产接线**
  均已实现（`runRoundCli` 在收集完全部 terminal outcomes 后执行一次 review）。
  Review 的 verdict 是给用户的**下一轮建议**，不自动 retry / reassign / replan。

## 9. Handoff / Continuation（跨 Agent 交接）

目标流程：

```text
Task → Attempt 1 → Agent A → quota exhausted / timeout / session failure
     → Safe Stop → Continuation / Handoff → Laya → Agent B → Attempt 2 → 同一 Task
```

- **TaskId 不变，只有 Attempt 变。**
- **Handoff 由 Laya 决定下一 Agent**（Execution Outcome → Laya → Agent B），
  不能由 QuotaManager / message 自动指定。
- **Handoff 不是第二控制平面**，只是 Execution/Attempt 生命周期的一部分。
- ContinuationPacket（最小交接载荷）：taskId / originalObjective /
  previousAttempt / previousAgent / handoffReason / completedWork /
  remainingWork / changedFiles / tests / errors / evidence / workspace /
  artifacts / nextAction。
- 优先使用 Native Agent 原生 session resume；ContinuationPacket 用于跨 Agent /
  跨 session 的统一交接。transcript 不是 continuation mechanism。

### Handoff Level（当前实现状态）

| Level | 含义 | 状态 |
|---|---|---|
| L0 | 无 handoff | — |
| L1 | 人工切换 Agent | DONE（人工触发 reassign 已验证） |
| L2 | 系统记录 failure/quota | DONE（AttemptStore + AttemptRecord.leaseVersion/outcome） |
| L3 | continuation context | PARTIAL（structured Handoff 已实现；changedFiles/tests 字段待补） |
| L4 | Laya 自动选择下一 Agent | **Implemented / Verified（生产 Round）** — Laya 经既有 `reassign` 决策动作选择下一个 Agent |
| L5 | 自动继续同一 Task | **Implemented / Verified（生产 Round）** — 同一 `taskId`，新 `attemptId`、新 Lease，由既有 Scheduler 重新调度 |
| L6 | 新 Attempt 自动进入统一 Codex Review | **Implemented / Verified** — 无第二套 review；Review 看到该 Task 的全部 Attempt 与接力原因 |

> **库层能力 与 生产闭环 必须分开陈述，不得混为一谈。**
>
> - Library capability：`continuation.ts`（纯函数 + 注入式 driver）。
> - Production Round：**已闭环**。`runRoundCli` 内完成
>   `availability outcome → ContinuationPacket → Laya reassign → Assignment 迁移（新 Lease）→
>   既有 `Orchestrator.retry` 重新入队 → 既有 `NativeWorkbench.dispatch()` 唯一调度 → Attempt 2 →
>   统一 Codex Review`。
> - 仍未实现（不得因上面的 DONE 而误读）：Result Aggregation、Human Gate / Next-Round 回路产品化。
>
> 验证：`tests/handoff-production-round.test.ts` 48/0（Case A–J，真实 `runRoundCli` 编排路径，
> 仅 Laya 的「回答」与 provider probe 走既有 seam 注入）；
> `tests/native-handoff-e2e.test.ts` 21/0（真实 `opencode.exe` 经生产 dispatch 路径续跑同一 Task
> 并真实写出文件；真实 Codex review 入口被实际调用）。

## 10. Evidence / Result Aggregation

最终用户结果必须可汇总：Original User Request / Laya Plan / Tasks / Prompts /
Agent Outputs / Tool Calls / Test Evidence / Workspace Evidence / Attempts /
Errors / Quota-Handoff / Codex Review / Final Assessment。

- **完整保存 ≠ 首屏全部展示**。UI 用 Summary + Expand（Prompt / Agent Output /
  Tool Calls / Evidence / Review）；系统保持可追溯。
- Result Aggregation 是**数据汇总能力，不是新 Authority**。严禁新增
  ResultStore / ExecutionResultStore / ReportAuthority——仍使用 AttemptStore /
  TaskStore / Observation / Review result。

## 11. Human Gate / Next Round

```text
Round → Codex Review → Unified Result → User → 下一轮要求 / 修改建议 → Laya → New Round
```

> **人负责最终控制，Laya 负责每一轮的任务决策。**

Execution Round 是 bounded 的：无 always-on / 24/7 / persistent autonomous goal /
后台自主找任务 / 无限自动返工。Human Gate 之后的新工作由用户发起新的 execution。

## 12. Authority Model（每个恰好 1 个）

| Authority | 实现 | 职责 |
|---|---|---|
| Laya Decision | `src/decision/` + `decision-loop.ts` | 唯一 task-level decision authority |
| Planner | `planner.ts` + `planner-wiring.ts` | 候选 DAG（纯函数），不执行不分配 |
| TaskStore | `store.ts` | task state + assignment identity + lease lifecycle 唯一权威 |
| Assignment | `assignment.ts` + `assignment-wiring.ts` | Agent×Model×Session 选择（proposes; gate disposes） |
| SessionRegistry | `workbench-sessions.ts` | session lifecycle 唯一权威 |
| Scheduler | `scheduler.ts tick(promptFor?, threadFor?)` | 唯一 dispatch authority |
| Orchestrator | `orchestrator.ts`（executeTask → runtime.run） | 唯一 execution edge |
| Verification | `applyVerification` | 唯一 verification → task-state authority |
| AttemptStore | `attempt-store.ts` | 唯一 execution evidence authority |
| WorkspaceManager | `workspace.ts` + `resource-claim.ts` | workspace / ResourceClaim 唯一权威 |
| Spawn Gate | `spawn-gate-input.ts` + `quota/spawn-gate.ts` | 最终执行准入 veto |
| Observation | `execution-monitor.ts` + `round-observation.ts` | 只读，永不控制 |

Handoff / Quota / ResourceClaim / Review **都不是** authority。

## 13. Current Implementation Status（2026-10-04 实测）

| 能力 | 状态 | 验证 |
|---|---|---|
| Native Agent Runtime（4 agent identity，spawn/resume/review/cancel） | Implemented / Verified | doctor + E2E |
| Laya Decision Layer（classifyTask，11-action typed decision loop） | Implemented / Verified | decision 397 tests + E2E |
| Planner / DAG / Replan（generation + stale 保护） | Implemented / Verified | planner 189 + E2E Case 9 |
| Assignment（filters/score/preference/identity writeback） | Implemented / Verified | assignment 180 |
| Lease Lifecycle（issue/activate/renew×bounded/revoke/fencing） | Implemented / **SEALED（R2-2 Final Closure 全部关闭）** | assignment-lease 251 + E2E Case 17/18 |
| ResourceClaim（scope 归一化 / 冲突矩阵 / dispatch-time admission） | Implemented / Verified | resource-claim 84 + E2E Case 16 |
| Workspace isolation（git worktree per writing task） | Implemented / Verified | E2E Case 16（R2-1 proof） |
| Structured Handoff（bounded，CLAIMED/OBSERVED 分离） | Implemented / 字段补全中 | E2E Case 5 |
| Attempt Evidence（append-only，含 leaseVersion/F5 preservation） | Implemented / Verified | attempt-record 152 |
| Execution Monitor（round-state/events 只读观测） | Implemented / Verified | round-cli --observe |
| Unified Codex Review wiring（所有终态自动进 review） | **Implemented / Verified** | `unified-review.test.ts` 129/0 + `handoff-production-round.test.ts` 48/0 |
| Same-Task Continuation（L4-L6 自动 handoff） | **Implemented / Verified（生产 Round 已闭环）** | `handoff-production-round.test.ts` 48/0 · `native-handoff-e2e.test.ts` 21/0 |
| Result Aggregation（round-result.ts 纯投影 + Human Gate） | **Implemented / Verified（R4 READY FOR USER GATE，余 2 个 P2）** | `round-result.test.ts` 293/0 · `npm test` 4852/0 ×2 · 二次独立复审 PASS WITH P2 |
| **TeamRun T1**（WorkerIdentity / session 归属 / family availability） | **SEALED** | `TEAMRUN_AGENT_MODEL_ARCHITECTURE_AUDIT.md` |
| **TeamRun T2**（Laya 精确 Agent × Model 选择 + Assignment exact enforcement） | **SEALED** | `TEAMRUN_AGENT_MODEL_ARCHITECTURE_AUDIT.md` |
| **TeamRun T3-a**（READ-only Worker fan-out / requested vs actual / attempt 归因） | **SEALED** — Codex T3-a.5 Final Seal Review = **PASS WITH P2**，`P0 = 0`、`P1 = 0`；已接受 P2 = root-only fan-out、default `maxConcurrent = 2`（移入未来 scope，不再是 T3-a blocker） | `TEAMRUN_T3_READ_FANOUT_ARCHITECTURE_AUDIT.md` · `npm test` 29 suites / 0 failed |
| **T3-M0 Model Access Architecture**（Agent / Model / ModelAccessRoute / ExecutionCandidate 术语与关系冻结） | **SEALED** — Codex T3-M0 Final Review = **PASS WITH P2**，`P0 = 0`、`P1 = 0`，建议 SEAL；6 项 P2 属 documentation / future-implementation constraint，**非 blocker**，已作为文档澄清 CLOSED（未实现任何 runtime） | `TEAMRUN_MODEL_ACCESS_ARCHITECTURE.md`（§26 closure 记录） |

## 14. Current Gaps

1. Result Aggregation：统一 Review 已能看到同一 Task 的全部 Attempt，但尚未聚合成面向用户的最终报告。
3. Handoff v2 字段（changedFiles/tests/decisions/unresolved 来源定义）。
4. decision-loop tick/results 技术债 → **已由 DispatchReceipt 修复**（R2-2），
   保留记录：round report 仍以 AttemptStore 为事实来源。
5. WorkBuddy CN 401（本机未认证，环境事实）。
6. Native E2E Case 15 agent variance / harness（非 lease/fencing 缺陷）。
7. execution-monitor 尚未接 Attempt linkage / per-task process observation
   （观测增强项，非 correctness 缺陷）。
8. **R4 P2-1（Task I）**：F5 refused-with-run attempt——AttemptStore 有完整
   evidence（`ok=false` 但携带真实 `RunResult`），Round Result projection 当前
   没有把该 execution evidence 展示出来（报告层为空，无错配、无伪造）。
9. **R4 P2-2（Task J）**：handoff E2E 未显式断言 Attempt A / Attempt B 的
   evidence 字段级互异（机制本身已由 round-result P1-2b 在真实 dispatch 路径
   覆盖；缺的是 handoff E2E 里的一条断言）。
10. smoke:quick 17/21：4 个 Codex failure 属当前本机 Codex CLI 环境/认证问题，
    不是 R4 regression，不做 workaround。

## 15. Non-Goals（永久，除非用户明确重开）

```text
SaaS / 多租户 / 企业级 AI 平台 / 云端 Agent 平台
企业权限体系 / 大型正式 Control Center
Model Marketplace / Skill Platform / 大型 Workflow Engine
独立 Agent Manager / 第二 Decision Model / 第二 Planner
第二 Scheduler / 第二 Execution Edge / 第二 TaskStore
always-on Agent / 24/7 execution / persistent autonomous goal
background autonomous task discovery / 无限自动返工/replan/retry
Agent Runtime 替代品（重造 native 工具/MCP/subagent/session）
GEV / Jev（作为决策模型；Jev-compatible envelope 仅是 laya-serve wire 格式名）
```

## 16. Next Development Order

```text
1. Final Codex Seal for R2-2            → DONE（R2-2 SEALED）
2. Unified Codex Review wiring          → DONE（所有终态自动进入）
3. Agent Quota / Availability Handoff   → DONE（L2→L3）
4. Same-Task Continuation               → DONE（L4→L5→L6，生产 Round 闭环）
5. Result Aggregation                   → DONE（R4，READY FOR USER GATE）
6. Human Gate / Next-Round loop         → DONE（round-cli 终点打印 HUMAN GATE 并停止；自动动作 = NONE）
```

R4 当前状态：**PASS WITH P2**（P0=0，P1=0，P2=2，见 §14 条目 8/9/10）。
R4 不是"完全无问题"——两个 P2 明确保留在 backlog（Task I / Task J）。

### 16.1 Architecture Guard（适用于下方全部 Paperclip-inspired 任务）

> **Paperclip is reference material, not architecture baseline.**
> 唯一基准仍是本文（Laya 唯一决策脑 + Native Agent Orchestrator + 个人 Windows 工作站）。

冻结核心 authority model（每个恰好 1 个，见 §12）：

```text
Laya = 唯一决策脑
Planner = 唯一规划权
TaskStore = 唯一任务状态权威
Assignment = 唯一分配权威
Scheduler.tick = 唯一调度入口
Orchestrator = 唯一执行边
AttemptStore = 唯一执行证据权威
Verification = 正式成功门
Unified Codex Review = 独立审查
Human Gate = 自动执行停止点
```

任何 Paperclip-inspired 任务立项前必须先回答：

```text
1. 是否新增 authority？
2. 是否新增 execution edge？
3. 是否改变 Laya 唯一决策脑？
4. 是否改变 TaskStore / Assignment / Scheduler / AttemptStore ownership？
5. 是否把 Agent 变成第二控制主体？
6. 是否把项目推向 server / browser / enterprise 产品？
```

任意一项为 YES → **默认 BLOCK，先重新设计**。

### 16.2 Backlog（全部为 BACKLOG / RESEARCH / DESIGN，不是当前执行任务）

下方任务由下一阶段逐项决定是否立项；立项时逐项过 §16.1 guard。

**R4 P2 收尾**

| Task | 内容 | 优先级 |
|---|---|---|
| **I — F5 refused-with-run result projection** | 修复 AttemptStore → Round Result 投影：`ok=false` + 真实 `RunResult` 的 attempt 仍须在最终 Round Report 展示其真实存在的 execution evidence（attemptId / changedFiles / tests / transcript / errors 全部按真实 evidence 映射）。禁止伪造。 | P2 / High-value cleanup |
| **J — Handoff E2E evidence attribution assertion** | 在真实 handoff E2E 中增加 Attempt A evidence ≠ Attempt B evidence 的字段级断言（changedFiles / tests / transcript / error / agent / attemptId）。不改运行机制，只加强回归测试。 | P2 |

**Architecture Gap Audit（Paperclip-inspired improvements / architecture research —— 参考材料，非架构基准）**

| Task | 内容 | 优先级 |
|---|---|---|
| **A — Structure / Dependency / Ownership / Execution 语义分离** | 参考 Paperclip 的 execution semantics 思路，研究并明确区分 Task Structure（parent/child/lineage）、Task Dependency（prerequisite/blocked-by）、Task Ownership（agent/assignment/lease/fencing）、Task Execution（queued/running/rework/retrying/terminal）、Attempt Execution（attemptId/session/process/evidence/outcome）。这些概念目前已分别存在；本任务不是重构、不是重新建模，只检查当前模型是否存在语义混用并形成最小改进方案。实施时间：R4 之后的 architecture gap audit。 | High |
| **B — Native Agent Adapter Preflight / Capability Diagnostics** | 研究统一 Native Agent preflight：executable / version / auth / model / session capability / workspace capability / required environment → usable / unavailable / misconfigured。必须复用现有 Agent Adapter / Capability Contract / Assignment / SessionRegistry；**禁止创建 PreflightManager authority**。Preflight 只提供事实，最终决策仍由 Laya / Assignment 完成。 | High |
| **C — Recovery Classification** | 参考 Paperclip 的 execution/recovery semantics。已有 outcome 词汇不增加重复项；研究增加一个 **derived recovery classification**（terminal / recoverable_execution / recoverable_infrastructure / ownership_failure / resource_failure / user_decision_required）。它只能是 projection / classification，**不能成为第二决策 authority**；是否 retry / handoff / replan 仍由 Laya 与既有 execution flow 控制。 | High |
| **D — Liveness / Watchdog Architecture Research** | 参考 Paperclip 对 Task Watchdog / Active Run Watchdog / Liveness Recovery 的区分，研究现有 ExecutionMonitor / Observation / Attempt / Scheduler / Continuation / Human Gate 是否已能表达 alive / quiet / stalled / orphaned / process-dead / resource-blocked。硬约束：**Monitor ≠ Decision Authority**——watchdog 只检测和报告事实，不能自己 kill / retry / reassign / replan。先研究，不立即实现。 | Medium-High |
| **E — Wakeup / Duplicate Dispatch Coalescing** | 参考 Paperclip 的 wakeup coalescing 思想，研究如何避免 scheduler tick + manual trigger + handoff callback + decision-loop callback 在极端情况下重复 dispatch 同一 Task / Attempt scope。复用 Lease / Fencing / Attempt / Scheduler，不新增 dispatch authority。 | Medium |
| **F — Session Persistence / Resume Metadata** | 研究强化 Attempt 的 nativeSessionId / adapter / resume capability / session state / last usable checkpoint，进一步区分 same-session continuation / new-agent handoff / fresh session。复用 SessionRegistry / ContinuationPacket / AttemptRecord。 | Medium |
| **G — Workspace Runtime Services / Jobs** | 参考 Paperclip 的 Service（长驻进程）/ Job（一次性进程）/ Agent（execution）区分，研究 dev server / backend / database / test watcher / build process 与 Agent execution 的边界。必须保持 Workspace authority / Scheduler / Orchestrator，不产生新控制面。只做设计研究，不进入当前阶段。 | Medium-Low |
| **H — Structured Usage / Cost Telemetry** | 研究在现有 AttemptRecord 中增加结构化运行 metadata（duration / inputTokens / outputTokens / cachedTokens / estimatedCost / quotaImpact）。禁止创建 CostManager / QuotaManager authority；quota/budget 仍属现有 assignment / runtime / Laya 体系。 | Medium-Low |
| **K — Windows Native Execution Hardening** | 研究 Windows CLI spawn、.cmd/.exe resolution、environment inheritance、process tree / child cleanup、CRLF/LF 一致性、workspace isolation、Git worktree。已知实例：git stash round-trip → LF baseline files → CRLF → source-text regex failure；研究是否以 `.gitattributes` 等方式从根源消除。这是 Windows 工程稳定性任务，**不是把项目变成跨平台企业平台**。 | High |

**Future Product（DEFERRED，绝对不要现在实现）**

| Task | 内容 | 优先级 |
|---|---|---|
| **L — Native Windows Frontend / Desktop UX** | 产品最终形态是 **Native Windows Desktop Application**，不是 Browser Dashboard。未来正式 UI 必须按高要求设计：原生 Windows 窗口体验、高质量 UI/UX、Task/DAG 可视化、Agent 状态、Attempt/Handoff、Execution progress、Review、Human Gate、错误与恢复状态、取消/暂停/继续、长任务反馈、性能、视觉完成度。不得默认 React Dashboard / Browser / 普通 Admin Panel 为最终产品。`temporary-dashboard/` 只是开发期临时观察工具（git-ignored，非 authority），与最终 UI 不能混淆。 | DEFERRED |

### 16.3 NOT ADOPTED（明确不采纳）

以下 Paperclip 概念**不采纳**，统一原因：

> 不符合本项目"个人 Windows 工作站 + Laya 唯一决策脑 + Native Agent Orchestrator"的产品基准。

```text
Company model
Org Chart
Multi-tenant
RBAC / Enterprise governance
Board / corporate approval hierarchy
Heartbeat-driven agent control model
Browser-first product UI
Paperclip entire Control Plane architecture
```

暂缓：§15 Non-Goals 全部 + Task L。

---

## 附：文档分层索引（哪个文档管什么）

| 层 | 文档 |
|---|---|
| **Canonical（当前语义）** | 本文 · `EXECUTION_ROUND_SEMANTICS.md`（R1-1 round/identity/quota）· `R2_COORDINATION_CONTRACT.md`（coordination contract + Agent Admission §24）· `DECISION_LOOP_EXECUTION_RESULT_CONTRACT.md`（receipt/attempt 链）· `PHASE6A_FREE_MODEL_POOL.md`（模型池）· `TEAMRUN_AGENT_MODEL_ARCHITECTURE_AUDIT.md`（T1/T2：Agent × Model + WorkerIdentity）· `TEAMRUN_T3_READ_FANOUT_ARCHITECTURE_AUDIT.md`（T3-a：READ fan-out / 归因 / evidence）· `TEAMRUN_MODEL_ACCESS_ARCHITECTURE.md`（T3-M0：ModelAccessRoute / ExecutionCandidate / free-quota 语义） |
| **Historical（设计记录，冲突以 Canonical 为准）** | `PHASE5B_MULTI_AGENT_ARCHITECTURE.md`（顶部已有 R1-1 amendment）· `PHASE5_MULTI_AGENT_RESEARCH.md`（含旧 Phase 8 Control Center 路线——historical）· `REUSE_ANALYSIS.md`（Jev/pi-jev 为外部调研）· `DECISION_PROVIDER.md`（"未接线"表述已过时，见 §13）· `PHASE4M_*.md` · `PHASE4_QUOTA_AUDIT.md` · `MULTI_AGENT_REUSE_AUDIT.md` · `EXTERNAL_ORCHESTRATOR_REUSE_*.md` · `SKILLS_EVALUATION.md` · `WORKBENCH_ARCHITECTURE_AUDIT.md`（审计快照，末尾有 R1-1 addendum）· `CURRENT_STATE_AUDIT.md`（2026-09-30 基线快照） |
| **Plan（路线）** | `P6_ORCHESTRATION_PLAN.md`（P6 阶段计划；R0.5/R1 状态表述为 historical） |
