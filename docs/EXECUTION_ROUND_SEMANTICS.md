# Execution Round Semantics — R1-1（Production Orchestration Wiring）当前语义

> **R2-2 更新（2026-10-03）**：Assignment Lease / fencing / receipt 已实现，
> canonical 契约见 docs/R2_COORDINATION_CONTRACT.md §6/§12 与
> DECISION_LOOP_EXECUTION_RESULT_CONTRACT.md。本文 §9 所列 "R2 Planned" 中
> Assignment Lease / fencingToken 已不再是 planned。产品基线 = docs/PROJECT_BASELINE.md。

```text
Status   = CANONICAL CURRENT STATE · 2026-10-01
Scope    = R1-1 已落地并经测试验证的语义；历史设计见 PHASE5B（已标注 historical）；
           未来方向见文末 R2 Planned（未实现）
Fact base= src/quota/{types,spawn-gate,index}.ts · src/orchestration/spawn-gate-input.ts ·
           src/orchestration/assignment.ts · src/cli/round-cli.ts · tests/spawn-gate-production.test.ts ·
           tests/assignment.test.ts（parity 契约）· tests/native-agent-e2e.test.ts
```

R1-1（Production Orchestration Wiring）把 orchestration 层第一次真正接到 Native Agent。
本文件是这些语义的 canonical 记录；与任何历史文档冲突时，以本文件为准。

---

## 1. AgentStatus Identity — machine identity ≠ presentation identity

数据契约（`src/quota/types.ts AgentStatusRow`）：

```text
AgentStatusRow.agentId   = canonical machine identity（"opencode" / "workbuddy-intl" …）
AgentStatusRow.agent     = display name（"OpenCode" / "WorkBuddy CN" …）
```

规则（全部已实现并有测试）：

- Gate / orchestration **按 `agentId` 匹配身份**。`resolveAgentAvailability`
  以 `row.agentId === sources.agentId` 为主键。
- 仅当消费**旧数据**（pre-R1-1 行缺 `agentId`）时才允许 display-name fallback；
  本代码库产出的每一行都设置 `agentId`。
- Dashboard / CLI 展示层使用 `agent`（presentation identity）——两个概念不可混用。
- **历史 bug 记录**：修复前 producer 输出 display name、consumer 按 machine id
  匹配，导致四个真实 agent 全部表现为 `agent-unavailable`。单测未发现是因为
  fixture 手工按 id 构造行。

数据流：

```text
real provider probes
        ↓
buildQuotaCenter(...)                     src/quota/index.ts
        ↓
AgentStatusRow { agentId, agent, ... }
        ↓
buildSpawnGateInput(...)                  src/orchestration/spawn-gate-input.ts
        ↓
resolveAgentAvailability()（按 agentId）  spawn-gate-input.ts
        ↓
Spawn Gate
```

---

## 2. quota `unavailable` 的正式语义（R1-1 行为变化）

```text
unavailable = provider exposes no usable quota endpoint / quota observation unavailable
            ≠ quota exhausted
            ≠ provider unavailable
            ≠ provider unauthenticated
```

当前 fail-closed 矩阵（`src/quota/spawn-gate.ts QUOTA_BLOCKING`）：

```text
exhausted       -> deny（quota-exhausted）
unknown         -> deny（quota-unavailable）
not_fetched     -> deny（quota-unavailable）
not_connected   -> deny（quota-unavailable）

unavailable     -> 不因“quota 不可观测”而单独拒绝 spawn
```

**没有发生的事**（严禁在文档中写成以下任何一种）：

- `unavailable` → `available`（状态未改写）
- `unavailable` → infinite quota（没有发明无穷额度）
- `unavailable` → fake remaining（`remaining` 仍为 `null`，事实保持真实）

这是一次 **quota observation policy** 变化：providers（如 OpenCode 免费层）会
报告 usage/login 但从不报告 remaining/reset，因此 `unavailable` 是这些 provider
的**常态**而非异常；把它当作阻断曾使一切真实 spawn 被拒。

---

## 3. 已删除的历史语义：`multi-agent-not-implemented` / `--no-multi-agent`

```text
multiAgentEnabled / multi-agent-not-implemented   已从 SpawnGateSources 与
                                                  GateDenyCode 中移除（R1-1）
--no-multi-agent CLI flag                          已删除
```

Canonical 语义：

> Single vs Multi Agent 由 Planner / Laya 产生的 task shape / DAG 决定
> （单任务 = 单 worker round；多候选 = DAG 并行/依赖），**不是 CLI kill switch**。

禁止重新引入任何全局 `multiAgentEnabled` / `multi-agent-not-implemented` 或等价
替代 flag。该名称只允许出现在标记为 historical 的文档段落中。

---

## 4. Production Round 的实际管线（`orchestrator round "<objective>"`）

```text
Laya Decision（classifyTask）
  ↓
Planner / DAG（planTasks → validateCandidateDag → commitPlan）
  ↓
Assignment（filters → score → preference）
  ↓
Spawn Gate（spawn + execute 双期重跑；最终 veto）
  ↓
Native Agent Execution（唯一 execution edge：Orchestrator.run）
  ↓
Task → to_verify（成功 run 绝不直接 succeeded）
  ↓
Codex Review（结构化 verdict）→ applyVerification（唯一 verification authority）
  ↓
Human Gate（round 报告 + 退出码；无 while/daemon/auto-replan）
```

**Round 是 bounded round**：需要下一轮的 round 在报告中声明并退出，由人决定是否
继续。round-cli 中没有 `while(true)`、`setInterval`、auto-retry、auto-replan。

R1-1 后的状态：真实 native execution 已打通——真实 OpenCode 执行到达、任务真正
进入 native execution、成功后进入 `to_verify`。**不再是"仅有 orchestration wiring"。**

---

## 5. Budget scope 契约（R1-1 修复，不扩大解释）

`resolveBudgetHeadroom` 依赖三个 scope **同时存在**，缺失不会自动创建：

```text
global
task:<taskId>
agent:<agentId>
```

任一缺失 → `budget-scope-unavailable` → 拒绝。R1-1 修复了 production round 对
**agent budget scope** 的分配，native execution 不再被该错误阻断。本轮**不引入**
任何新 budget policy（reserve/consume/TTL 仍是后续阶段）。

---

## 6. Assignment ↔ Spawn Gate parity（正式测试契约）

原则：

> Assignment 与 Spawn Gate 对 quota blocking semantics 必须一致。

`unavailable` 不能 Assignment 判不可分配而 Gate 放行，也不能反之。R1-1 增加了
parity tests（`tests/assignment.test.ts`：对**每一个** quota status 断言
Assignment 拒绝集 ≡ Gate 拒绝集），该 parity 是正式测试契约，修改任一侧的
blocking 集必须同步另一侧并保持测试通过。

---

## 7. AttemptStore 是真实执行事实来源（含已知技术债）

R1-1 发现：`runDecisionCycle` 的 `tick/results` 在 capability injection 场景下存在
内部不一致——loop 自建的 `dispatch` closure 会被 spread 进来的 Workbench capability
`dispatch` 覆盖，导致 `outcome.tick` 保持 `null`。

**当前处理（准确记录，不粉饰）**：

- round report 的"什么真的跑了"从 **AttemptStore** 读取
  （`src/cli/round-cli.ts`：evidence history 是 "a run happened" 的权威）。
- decision-loop 的 `tick/results` dead-path 是**已知技术债**，属后续独立问题；
  **尚未修复**。frozen decision-loop 本轮未改。
- AttemptStore 在现阶段是实际执行证据来源（append-only，见 attempt-store.ts）。

---

## 8. Native E2E 状态（R1-1 后）

- Case 1–14 PASS（含真实 OpenCode / Codex / WorkBuddy Intl 执行、session reuse、
  reassign-with-target、add_task taskType 落地、bounded retry、failure→reassign）。
- **Case 15 未 PASS**：剩余问题属于测试场景未调用 `applyVerification` + Agent
  variance（模型输出的自然差异），**不是 R1-1 Spawn Gate runtime defect**。
  未解决，不包装成已解决。

---

## 9. R2 Planned / Not Yet Implemented

以下为后续设计方向，**不属于 R1-1 已实现能力**，不得画进任何 current-state
架构图：

```text
Assignment Lease / leaseVersion / fencingToken
ResourceClaim
workspace isolation / worktree ownership
typed CollaborationMessage
ContextPacket / EvidencePacket / ConflictPacket
Context Gate
Agent-to-Agent collaboration protocol
Fast Decision / Jev-like router
Advisor capability
cheap worker / subagent routing
```

---

## 10. Bounded Multi-Agent Boundary — 本项目不是 Long-running / Always-on Agent 系统

**本项目是有界的 Multi-Agent Task Execution Orchestrator，不是长期运行的
Autonomous Agent 平台。** 一次用户任务从提交到 Human Gate 结束，是一个完整的
Execution Round；Round 结束即本轮 workflow 终止。

### 10.1 Canonical workflow（终点是 Human Gate → END）

```text
User Request
    ↓
Laya
    ↓
Execution Plan / Task DAG
    ↓
Assignment
    ↓
Scheduler
    ↓
Parallel Native Agent Execution
    ↓
Evidence / Result
    ↓
Codex Review
    ↓
Final Result
    ↓
Human Gate
    ↓
END
```

并行结构视图：

```text
                   Laya
                     │
                 Task DAG
                     │
          ┌──────────┼──────────┐
          ▼          ▼          ▼
       Task A      Task B      Task C
          │          │          │
      OpenCode   WorkBuddy    Codex
          │          │          │
          └──────────┼──────────┘
                     ▼
                  Result
                     │
                  Review
                     │
               Human Gate
                     │
                    END
```

Human Gate 之后用户可以发起新任务、要求修复、要求重跑、进入下一轮——但那是一次
**新的用户驱动 execution**，不是本 round 的延续。产品语义是 bounded execution：
不存在 `Codex Review → Laya 自动 rework → reassign → replan → retry → review → …`
的无人值守回路。

### 10.2 明确排除的长期运行语义

以下能力**不是**本项目当前目标、必要基础能力或默认 workflow，不得写进
Current Architecture 或 Current Workflow 图：

```text
always-on agent
24/7 autonomous execution
persistent autonomous goal
background agent continuously looking for work
长期自主运行 / 无限后台执行
Agent 自主持续寻找新任务
Agent 自己维持长期组织关系
无限 autonomous rework loop
无限自主 replan / reassign / retry
```

### 10.3 Multi-Agent 的正式定义

> 一个用户任务可以被 Laya / Planner 拆分为多个具有依赖关系的 Task，并由不同
> Native Agent 并行或按依赖顺序执行；**所有任务都属于当前 Execution Round**，
> 任务完成后该 Round 结束。

```text
Multi-Agent = parallel / dependency-based task execution
NOT         = permanent autonomous agents
```

### 10.4 并行 Multi-Agent 的边界

**允许**（同时满足 dependency / Spawn Gate / Assignment 有效 / resource-workspace
不冲突）：

```text
Task A → OpenCode
Task B → WorkBuddy Intl
Task C → Codex
```

**禁止**：Agent 自己因为"发现另一个任务"而 claim / reassign / spawn / takeover /
override。任务控制权只来自 Control Plane：

```text
Laya / Planner → TaskStore → Assignment Authority → Scheduler
```

> 多 Agent 并行不是 Agent 自由抢任务，而是 Orchestrator 对 Task DAG 的受控并行
> dispatch。

### 10.5 跨厂商拓扑是当前架构事实

Current Agent topology：`OpenCode` / `Codex` / `WorkBuddy CN` / `WorkBuddy Intl`
四个正式 Native Agent identity。它们可能来自不同厂商——**不假设**共享模型、共享
context、共享 tool runtime、共享 session，也不假设一个 Agent 可以直接控制另一个
Agent。因此 Agent 间协作必须经过 Orchestrator 的受控边界。

### 10.6 Agent-to-Agent Communication 的当前定位

```text
Agent → Agent = bounded collaboration / information exchange
NOT           = control transfer
```

Agent 间可以交换：evidence / progress / question / blocker / handoff /
review finding / conflict / request_help。

Agent **不能**通过消息直接改变：task owner / assignment / dependency / task state /
workflow state / spawn permission / resource ownership——这些属于 Control Plane，
只能经 Laya decision / TaskStore / Assignment / Scheduler 既有 authority 变更。

### 10.7 外部方案的参考定位（严格区分）

| 外部方案 | 可参考 | 明确不引入 |
|---|---|---|
| OpenAI Codex App | 多 Agent 并行执行、独立 thread / worktree 机制 | 长期运行 Agent |
| OpenAI Agents API | 主 Agent 拆分独立 subagent、独立 context、并行执行机制 | always-on 编排 |
| Claude Agent Teams | shared task list、task ownership、dependency、mailbox 协作机制 | 永久 Agent 组织关系 |
| Dots | —（**external reference only**：与本项目当前目标不同） | persistent goal / always-on execution / long-running autonomy |

外部方案介绍中出现的 always-on / persistent 词汇属于该方案的能力描述，
**不得被读者理解为本项目能力**。

### 10.8 R2 Planned 的边界修正

§9 所列 R2 方向（Assignment Lease / leaseVersion / fencingToken / ResourceClaim /
workspace-worktree isolation / CollaborationMessage / ContextPacket /
EvidencePacket / ConflictPacket / Context Gate / Fast Decision / Advisor / cheap
worker / native subagent routing）全部保持 `Future / Planned / Not Yet Implemented`
标注。**R2 不得加入** Long-running Agent / Always-on Agent / Persistent autonomous
goal / 24/7 Agent / Autonomous background task discovery——它们不是本项目的
roadmap priority。
