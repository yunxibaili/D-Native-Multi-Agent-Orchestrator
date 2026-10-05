> **[Historical Plan — Status 更新 2026-10-04]**
> 本文件为 P6 阶段计划。文中 "R1 defined but not implemented / Native E2E 11/15"
> 为写作时状态。此后已实现：R1-1（production wiring / Spawn Gate 兼容）、
> R2-0（Coordination Contract）、R2-1（Workspace/Resource Safety）、R2-2（Lease
> Lifecycle / Fencing，待 Final Codex Seal）。当前基线见 **docs/PROJECT_BASELINE.md**。

# P6 Orchestration Plan

```text
Status   = R0.5 REVIEWED · canonical product model fixed · R1 defined but not implemented
Baseline = HEAD c156db0 + uncommitted R0.5 tree · npm test 3756 passed / 0 failed / 2 skipped ·
           typecheck clean · Native E2E 11/15
Scope    = 冻结 Execution Round / Codex Review / Human Gate 产品模型；只允许修确认的 harness 缺陷；
           不实现 production wiring，不扩 Decision Action / Fast Decision / Context Gate / Adaptive Routing
事实来源 = docs/CURRENT_STATE_AUDIT.md（代码事实）
           docs/EXTERNAL_ORCHESTRATOR_REUSE_AUDIT.md（外部尽调）
           docs/EXTERNAL_ORCHESTRATOR_REUSE_REVIEW_CODEX.md（该尽调的独立复核）
           docs/PHASE6A_FREE_MODEL_POOL.md（免费池已核实结论）
```

---

## 1. Goal

把已经真实跑通的 **Task Graph + Task Scheduler + Native Agent Runtime** 接入 Laya，
但产品边界不是无人监管的无限循环，而是 **Execution Round + Codex Review + Human Gate**。

```text
User Raw Task
  → Laya                       （唯一任务级 Dynamic Decision Authority）
  → Task / DAG / Agent / Model / Session / Skill Intent
  → Assignment                 （唯一 Assignment Authority）
  → Execution Round
  → Native Agent
  → Result / Artifact / Evidence
  → Codex Independent Review / Test
  → Human Gate
  → User Decision
  → optional next Execution Round → Laya
```

一句话：**P6 只补「编排智能」这一层，执行基座不动；R1 只把已有 Orchestration
library 第一次接进生产运行路径，不重建 Multi-Agent。**

旧语义「Laya → Agent → Laya → rework/reassign/replan → 无限循环直到完成」不作为产品
目标。内部 `observe → decide → validate → apply` 仍然成立，但它是单个 Execution Round
内部的机制；跨轮推进需要 Human Gate 后的用户决策。

### 1.1 R1 — Production Orchestration Wiring

**定义**：R1 不是重新建设 Multi-Agent，而是把已经存在的 `NativeWorkbench`、
`runDecisionCycle`、`Observation`、`DecisionProvider`、`DecisionValidator` 与既有
authorities 第一次接进 CLI / product execution path。

```text
User Task
  → production entry
  → Laya
  → NativeWorkbench
  → runDecisionCycle
  → Assignment
  → Scheduler
  → Orchestrator
  → Native Agent
  → Evidence
  → Codex Review
  → Human Gate
```

**进入条件**：

1. R0 基线保持通过：`npm run typecheck` clean；`npm test` 全绿。
2. Native E2E 的 4 个失败已归因完毕；确认 harness 缺陷已修复，runtime/product gap
   已记录为 R1 或后续明确项。
3. Production wiring 边界被明确写出：谁接收 user task、谁调用 `NativeWorkbench`、
   谁驱动 `runDecisionCycle`、Human Gate 在 CLI 中如何呈现。
4. 不引入新的 Agent / Planner / Workflow Engine / Decision Engine / Assignment
   Authority / Session Authority / Execution Edge。

R1 第一阶段明确不做：Fast Decision、Decision Batching、Context Gate、Adaptive
Routing、Skill Registry、Skill Router、Session Persistence、新 Agent、新 Planner、
新 Decision Action、第二 Workflow Engine。

---

## 2. Current Baseline

### 2.1 已存在且真实运行（不得重写）

| 能力 | 位置 | 事实 |
|---|---|---|
| Native Agent Runtime（唯一执行边） | `src/orchestrator/`、`src/runtime/`、`src/adapters/` | `RunRequest → RunHandle → RunResult`；terminal policy 由 exit code 决定；Windows `taskkillTree` 进程树回收实测有效 |
| Task 单一权威 | `src/orchestration/store.ts`、`task.ts` | `TaskStore`（**in-memory**）；11 态含 `to_verify` / `rework` 保留态；转移表锁死 `running→succeeded` 不存在 |
| 执行桥 | `src/orchestration/execute.ts`、`orchestrator.ts:530` | `executeTask()` → `buildRunRequest` → 现有 Runtime；execute 期重跑 gate |
| 有界调度器 | `src/orchestration/scheduler.ts:169` | `TaskScheduler.tick()`：候选 = depth>0 且 planned/queued；确定性排序；`maxChildren` / `maxConcurrentAgents` 解耦；`occupiedSlots()` 每次从 TaskStore 派生 |
| 生产入口 | `src/orchestration/controller.ts:60,86` | `OrchestrationController.run()` —— `productionCaller` 已从 NONE 变为真实调用方 |
| Workspace 单所有者 | `src/orchestration/workspace.ts`、`workspace-lock.ts` | git worktree 隔离（`orch/task/<id>`）；missing-signal = 拒绝；跨进程创建锁 |
| 结果检查 / 合并 | `src/orchestration/task-result.ts` | inspect/diff/merge；**不 auto-commit**；冲突原地保留 |
| 唯一 verdict 入口 | `src/orchestration/orchestrator.ts:478` | `applyVerification()` —— 当前 `src/` 内**没有任何调用者** |
| Spawn Gate（7 真实信号） | `src/orchestration/spawn-gate-input.ts`、`src/quota/spawn-gate.ts` | spawn 期 + execute 期各重跑一次；**missing-signal ≠ allow** |
| Quota / Model Center | `src/quota/` | `ModelRegistry` 记 agent→model→capability→availability；budget **只读**（实测 reserved/consumed=0） |
| Decision Layer（Laya） | `src/decision/`（1635 行） | `classifyTask()`（`routing.ts:177`）产出 `work_kind` / `complexity` / `review_required`；本地 `laya-serve` HTTP；**一次性 request→response，无循环** |
| 免费执行池 | `docs/PHASE6A_FREE_MODEL_POOL.md` | `opencode/space-bunny-free`、`opencode/mimo-v2.6-flash-free`、`workbuddy-intl hy3`（均本机 smoke PASS，$0 实证）；默认 reviewer = codex |

### 2.2 真实缺口（P6 的全部工作内容）

1. **Laya 未接编排**：`src/orchestration/*` 与 `src/orchestrator/*` 零 import `src/decision`（已 grep 核实）。没有「决策 → spawn / 调度」的桥。
2. **无结构化 review 回流**：`applyVerification()` 无调用者；review 输出只是 `RunResult` 文本；`rework` 保留态返回 `rework-not-implemented`。
3. **无任务分解**：prompt → DAG 的路径不存在。
4. **无 retry / rework / replan / 下游失效传播**：failed 保持 failed；上游 failed 时 dependant 永久 `dependency-unmet`（当前有意行为）。
5. **无 attempt / 观测历史**：`TaskStore` in-memory；跨进程只能靠 git + `--verified` 人验。
6. **免费池只是文档**：`ModelRegistry` 不知道 free/paid 语义；没有代码级白名单阻止 Laya 误选付费模型。

---

## 3. P6 Non-Goals

- ❌ 不实现新的执行器、不改 `Orchestrator.run` 的语义。
- ❌ 不引入微服务 / Redis / Kubernetes / 复杂 Event Bus / 消息队列。
- ❌ 不把系统改造成自由 Agent Chat。
- ❌ 不让 Codex（reviewer）参与第一轮执行竞争。
- ❌ 不实现 worktree 之外的高级 workspace 特性（远程执行、容器化）。
- ❌ 不做「全自动无人监督」的 DAG —— merge 仍显式，verdict 仍可人工介入。
- ❌ 不在本轮写任何实现代码。

---

## 4. Architecture Boundary（冻结规则）

以下 13 条在 P6 全部阶段内不可违反；每条都需要有对应的验收检查：

| # | 规则 |
|---|---|
| 1 | `TaskStore`（`src/orchestration/store.ts`）仍是 Task 的**单一权威状态源** |
| 2 | 不创建第二套 Task Graph |
| 3 | 不创建第二个 Scheduler（`TaskScheduler.tick` 是唯一派发循环） |
| 4 | 不创建第二个 Workspace Owner（worktree 生命周期只归 `WorkspaceManager`） |
| 5 | 不创建第二条 Agent execution path（只走 `Orchestrator.run()`） |
| 6 | Laya **不得**直接 spawn agent / process |
| 7 | Laya 只产生 **typed decision** |
| 8 | Scheduler / Orchestrator 负责**验证并执行** decision |
| 9 | Agent 之间只通过 Task / Dependency / Artifact / Result 协作 |
| 10 | 不做自由 Agent Chat |
| 11 | Codex 是独立 Reviewer，不是普通 Worker |
| 12 | 保持 Windows-first / personal-tool-first |
| 13 | 不引入企业级基础设施（microservice / Redis / K8s / 复杂 Event Bus） |

---

## 5. P6-A Orchestration State Loop

**目标**：打通 `Task → Execution → Result → Verification → Structured Feedback → Task State → Laya → Next Decision`。

**范围**
- **Observation**：一个 task 当前对 Laya 可见的全部事实（状态、attempt 序号、RunResult 摘要、verification/review 结果、依赖与下游、budget/quota 快照）。
- **Decision**：从封闭集合中选取的一族动作（见 §11 `OrchestrationDecision`）。
- **Decision port**：调用现有 `DecisionProvider`（`src/decision/types.ts:214`）+ 对返回做**结构校验**（未知/退化答案一律 `invalid`，**不当作允许**）。
- **Loop**：`observe → decide → validate → dispatch` 的单次 tick 形态；派发动作仍交给现有 `TaskScheduler.tick()`。

**明确不做**：不新增执行器；不改 gate；不改 `TaskStore` 转移表——新增动作若需要新状态，只能启用已保留的 `retrying` / `rework` / `replanning`。

**验收要点**：手工注入一个 `TaskObservation` 与一个 typed decision，能走完 loop 并落回 `TaskStore`，且非法 decision 被拒绝且**不产生任何副作用**。

### 5.1 P6-A 的**最小动作子集**（避免 root 阶段过大）

`OrchestrationDecision` 的**类型联合**在 P6-A 就冻结（所有阶段共用一套动作词表），但 P6-A
**只实现最小的可执行子集**：

```text
P6-A 实现：continue / wait / abort（外加 observe→decide→validate→dispatch 的 loop 骨架）
其余动作（retry / reassign / rework / replan / add_task / split_task / parallelize / complete）
         在 P6-A 阶段一律返回 `not-implemented`（fail-closed），由 owning stage 逐个启用。
```

规则：
- 未实现的动作**必须被显式拒绝**，绝不能被当成 `continue` 或静默忽略。
- 启用某个动作属于它的 owning stage（B/C/D0/D1）的验收项，不是 P6-A 的。
- 这样 P6-A 的交付面 = 「事实快照 + 动作词表 + 校验器 + loop」四件，**不含任何分配/分解/重试语义**。

---

## 6. P6-B Dynamic Assignment

**目标**：Worker 选择从「固定映射」升级为 **evidence-based assignment**。

**输入（全部是已有事实）**
- Task Requirement：`classifyTask()` 的 `work_kind` / `complexity` / `review_required`（`src/decision/routing.ts:177`）。
- Agent / Model Capability：`ModelRegistry`（capability 矩阵 + availability）。
- Observed Performance：P6-E 的 attempt 统计（第一期可用 NAR 式确定性评分打底）。
- Current Availability：`TaskScheduler.occupiedSlots()` / `liveChildren`。
- Quota / Budget：`evaluateSpawnGate` 的 quota/budget 信号（只读）。
- failure / retry history：attempt 历史。

**形态**：`assignment()` 是**纯函数**——输入需求 + 候选 + 证据，输出**排序后的候选**（含理由）。最终否决权仍在 spawn gate：**assignment proposes, gate disposes**。

禁止：把 P6-B 写成 `任务类型 → 固定 Agent` 的 switch。

**验收要点**：同一 task 在「证据不同」时给出不同排序，且被 gate 否决的组合无法进入执行。

---

## 7. P6-C Planner / Dynamic DAG

**目标**：把 User Prompt 变成候选任务/DAG，并支持运行中的图变更。

**必须区分两个角色**
1. **Planner / Reasoner**：把 prompt 拆成候选任务、写依赖、写 acceptanceCriteria；产出**候选**，不直接落库。
2. **Laya Typed Decision Model**：只在**封闭动作集**上做选择，不输出长篇自由文本计划。

**最小图操作**（每个都必须是经校验的显式动作）
- `add-task`（新增 child）
- `split-task`（把一个任务拆成 N 个带依赖的 child）
- `set-dependency`（新增/调整依赖边）
- `replan`（替换尚未开始子图）
- `downstream-invalidation`（上游重做时，使下游回到 `planned` 并标记 stale）
- `selective-retry`（只重试失败/被拒分支）

**硬约束**：仍受 `maxDepth = 1` 与 `maxChildren` 限制；环 / 自引用 / 未知依赖由现有 `validateDependencies` + `findDependencyCycle` 拒绝；不得绕过 `spawnChild`。

**验收要点**：一个包含 split + dependency 的候选图能被接受并落库；含环或超深的候选被拒绝且不留部分状态。

### 7.1 前置：TaskStore 需要**最小 API 扩展**（必须显式声明，不能绕过）

当前 `TaskStore`（`src/orchestration/store.ts`）的公开面只有：
`create / transition / block / addArtifact / incrementRetry / get / has / children / all / descendants / findCycle`。
它**没有**任何「改依赖 / 替换子树 / 标记 stale」的能力。因此：

```text
set-dependency / replan / downstream-invalidation 无法用现有 API 完成。
```

处理方式（P6-C 的第一步，不是额外项目）：

1. 在 `TaskStore` 内新增**最小**变更 API（例如 `setDependencies(id, deps, now)`、
   `replaceSubtree(...)`、`markStale(id, reason)`），复用同一套
   `validateDependencies` + `findDependencyCycle` 校验。
2. **TaskStore 仍是唯一权威**：新 API 只是让既有权威支持更多变更，不新建图结构、
   不新建 store、不建影子索引。
3. `graph-delta` 是这些 API 之上的**校验/编排层**，不得自己持有图状态。
4. 若选择不扩展 TaskStore，则 P6-C 只能做到「创建时声明依赖」（`spawnChild` 已有），
   `replan` / `downstream-invalidation` 必须**明确延后**——不能用手工字段模拟。

---

## 8. P6-D Review → Rework → Replan（拆成 D0 / D1）

**为什么必须拆**：`rework`（同 agent 重做）只需要 verdict 回流；而 `reassign` 需要 P6-B 的
assignment，`replan` 需要 P6-C 的图变更能力。把三者捆在一个阶段里，会导致要么 D 被无限
推后到 B/C 之后（review 回流迟迟不落地），要么在 D 里偷偷实现 B/C 的一半能力。

### 8.1 P6-D0 —— structured verdict 回流 + 有界 rework（同 agent）

```text
Worker → Verification → Codex Review → Verdict(结构化) → Human Gate → 有界 Rework(同 agent) → Reverify → Re-review
```

- verdict schema：`verdict`(pass|rework|reject) + `findings[]` + `severity` + `evidence` + `recommendedAction`。
- 解析后的 verdict **只经 `applyVerification()`**（唯一 succeeded 入口）写入状态。
- rework **只重跑同一个 task / 同一个 agent**；**不做**换 agent、不改图。
- rework 不是无限自动循环。跨轮推进必须在 Human Gate 后明确进入下一轮。
- **重入路径必须复用唯一执行边**：`to_verify → rework → queued → TaskScheduler.tick() → executeTask()`。
  `rework` / `queued` 已在转移表内（`task.ts`：`to_verify: [... 'rework']`、`rework: ['queued','failed']`），
  P6-D0 不需要新执行路径，也不直接调用 Runtime。
- 每 task 的 rework 上限 + 「同一 verdict 重复出现」检测；超限进入明确终态。

**依赖**：P6-A（decision 通道）。**不依赖** P6-B / P6-C。

**验收**：FAIL verdict → 一次有界 rework → 回到 re-review；超上限后落到明确终态；
`succeeded` 仍只能由 `applyVerification` 写入；全程只有一条执行边。

### 8.2 P6-D1 —— reassign + replan + downstream invalidation

- `reassign`：换 agent/model 重试 → **依赖 P6-B**（assignment）与 P6-F（白名单过滤）。
- `replan`：替换未开始子图 / 调整依赖 → **依赖 P6-C**（TaskStore 变更 API + graph-delta）。
- `downstream-invalidation`：上游重做时把下游打回 `planned` 并标记 stale → **依赖 P6-C**。
- 同样受 §15 的上限约束（replan 次数/深度、rework 预算）。
- reassign / replan 属于下一轮进入 Laya 后可选择的动作，不是同一 Execution Round 中
  因普通 stdout / warning / progress / 单次非致命错误而自动 thrash 的动作。

**依赖**：P6-B + P6-C + P6-D0。**这是 P6 最靠后的阶段之一**（见 §16）。

**参考（只取形态）**：pi-subagents `watchdog/review.ts` 的 warn payload 与 severity 策略；
AO `autoreview`（idle 阈值 + 同 head 重试 3 次上限）；NAR 的「一次预授权修复 + 固定 verify 命令」。

---

## 9. P6-E Observed Performance

**目标**：沉淀可被 P6-B 消费的真实 evidence。

**记录维度**：attempts / successes / failures / retries / review rejects / verification pass-fail / duration / task-type / difficulty-band / agent / model。

**边界**
- 历史是**派生的、append-only 的证据**，**不是**第二套 task 状态权威——Task 状态仍只由 `TaskStore` 决定。
- 第一版允许 in-memory（与现状一致）；持久化作为独立后续项，采用 append-only 记录，不引入 DB 服务。

**验收要点**：给定若干已完成的 attempt，能输出按 agent/model/task-type 的聚合统计，且该统计**只读**、不改变任何 task 状态。

---

## 10. P6-F Free Model Pool / Availability Guard

**目标**：把 `docs/PHASE6A_FREE_MODEL_POOL.md` 冻结的 active pool 变成**代码级常量**，并让 Laya **只能**在其中选择。

```text
执行 active pool = { opencode/space-bunny-free, opencode/mimo-v2.6-flash-free, workbuddy-intl hy3 }
default reviewer = codex（不参与执行候选）
未列入 ACTIVE 的组合，Laya 不得分配
```

**必须考虑**：allowed pool、provider/model identity、availability、quota、**paid-model prevention**、fail-closed（不在池内 = 拒绝，而不是回退到默认模型）。

**注意事实**：`ModelRegistry` 目前**不知道** free/paid 语义，所以白名单必须是**新增的显式常量**，并被 assignment 与 spawn gate 的 model 信号共同引用。

**验收要点**：请求一个不在池内的模型 → 被拒绝（fail-closed），且失败信息可区分「不在白名单」与「availability unknown」。

### 10.1 实施边界：**完全独立**，且不碰 sealed 的 Phase 4 文件

`src/quota/{spawn-gate,budget,policy,registry,types}.ts` 是 sealed 契约（见 §2/§17）。
因此「让白名单参与 model 判定」的落点**只在 orchestration 层**：

```text
新增  src/orchestration/model-pool.ts          （常量 + isAllowedModel()，纯新增）
引用  src/orchestration/spawn-gate-input.ts    （resolveModelAvailability 处与池取交集）
不碰  src/quota/spawn-gate.ts                  （sealed）
```

- P6-F **无任何前置**，可单独作为第一个 PR 落地（纯新增常量 + 一个 orchestration 侧过滤）。
- 在 P6-A/P6-B 出现之前，P6-F 的效果是「任何调用方都能查询/被拒绝」，**不改变现有默认行为**
  （默认模型本身就在池内），所以它是零回归的加法。
- 若日后要让 `src/quota` 自己也理解 free/paid，属于**解除 sealed 契约的独立决策**，不在 P6-F 范围内。

---

## 11. Typed Contracts Required

只定义名称与职责，**不写实现**。

| Contract | 职责 | 归属阶段 |
|---|---|---|
| `TaskObservation` | 一次决策所需的全部 task 事实快照（状态/attempt/result/verification/deps/budget） | P6-A |
| `OrchestrationDecision` | 封闭动作联合：`continue` `parallelize` `wait` `retry` `reassign` `rework` `replan` `add_task` `split_task` `complete` `abort`。**类型在 P6-A 冻结；实现按 stage 逐个启用**（未启用的一律 `not-implemented`，见 §5.1） | P6-A（类型）/ B·C·D0·D1（动作） |
| `DecisionValidation`（含 `DecisionValidationError`） | 校验 decision 合法性（动作白名单、目标存在、深度/依赖约束）；**非法 decision ≠ 允许** | P6-A |
| `AssignmentRequest` / `AssignmentResult` | 需求 + 候选 + 证据 → 排序候选 + 理由 | P6-B |
| `WorkforceEvidence` | agent/model 的历史统计视图（P6-E 产出，只读） | P6-B / P6-E |
| `PlanCandidate` / `GraphDelta` | planner 产出的候选任务与图变更动作（add / split / dep / invalidate / replan） | P6-C |
| `ReviewVerdict` | `verdict` + `findings[]` + `severity` + `evidence` + `recommendedAction` | P6-D0 |
| `ReviewLoopPolicy` | rework/retry 次数上限、预算、终止判据；**计数器归属必须写在 `AttemptRecord`（P6-E）/ Task 字段上，不新建 authority** | P6-D0 |
| `AttemptRecord` / `PerformanceRollup` | 单次尝试记录与聚合统计（append-only 证据）；写入失败**不得阻塞执行**，且**永不作为 task 状态来源** | P6-E |
| `TaskStore` 最小变更 API | `setDependencies` / `replaceSubtree` / `markStale`（复用同一套依赖与环校验；TaskStore 仍是唯一权威） | P6-C（前置） |
| `ModelPool` / `ModelPoolEntry` | 白名单常量 + `isAllowedModel()`（free/paid 语义的唯一来源） | P6-F |

### 11.1 新增模块必须回答的四个问题

| 拟新增模块 | ① 已有模块为何不够 | ② 能否复用已有接口 | ③ 是否只是 orchestration glue | ④ 外部参考 |
|---|---|---|---|---|
| `orchestration/observation.ts` | `Task` / `RunResult` 分散在各自类型里，没有「一次决策的完整事实」视图 | 读 `TaskStore` + `RunResult`，不新增权威 | 是（只读派生） | Symphony authoritative-state 视图 |
| `orchestration/decision-port.ts` | `DecisionProvider` 存在但无人调用，且无输出结构校验 | 直接复用 `DecisionProvider` + `classifyTask` | 是（适配 + 校验） | ACRouter 的 route/observe 形状 |
| `orchestration/decision-loop.ts` | `TaskScheduler.tick` 只派发，没有「决策」步骤 | 复用 `tick()` 作为唯一派发循环 | 是（loop 编排） | loom rounds（只取有界循环思想） |
| `orchestration/assignment.ts` | spawn gate 只做**否决**，不做**选择** | 复用 `ModelRegistry` + gate 做最终否决 | 是（纯函数选择） | NAR `stats.py` 确定性评分 |
| `orchestration/planner.ts` | 现有代码只能接受显式 `TaskSpec`，无 prompt→DAG 路径 | 输出候选 `TaskSpec`，仍走 `spawnChild` | 是（候选生成） | loom `orchestra.ts` 的 DAG/ready（**只取形**） |
| `orchestration/graph-delta.ts` | 依赖校验只在 create 时生效，无运行中改图入口 | 复用 `validateDependencies` / `findDependencyCycle` | 是（变更校验） | dagents `validate-topology.ts` |
| `orchestration/review-verdict.ts` | review 只有文本，`applyVerification` 无调用者 | 复用 `applyVerification` 作为唯一入口 | 是（解析 + 写入） | pi watchdog schema、AO autoreview |
| `orchestration/attempt-history.ts` | `TaskStore` 只有当前态，无 attempt 序列 | 复用 `RunResult`；不改 `TaskStore` 权威 | 是（append-only 证据） | Temporal/LangGraph 的 attempt 概念（不引依赖） |
| `orchestration/model-pool.ts` | `ModelRegistry` 无 free/paid 语义 | 被 assignment 与 gate 引用 | 是（常量 + 判定） | 无（本项目差异化点） |

> 原则：以上全部是 **glue / contract / pure function**，没有一个是执行器、状态机或 workspace 所有者。

---

## 12. Reuse Map

依据 `EXTERNAL_ORCHESTRATOR_REUSE_REVIEW_CODEX.md` 的更正结论；已剔除无 License 与 AGPL 来源。

| 外部项目 | License | 用于阶段 | 参考什么 | 不参考什么 |
|---|---|---|---|---|
| loom | MIT | P6-C, P6-A | `dependsOn` + ready 语义、TaskHold(decide/wait/zone/capacity) 准入门、**有界 rounds**、JSON action 协议 | 其 LLM planner 本体（`orchestratorTurn`）、自持 git/worktree、adapter 执行 |
| cezar | MIT | P6-B, P6-D0/D1, P6-E | `dispatch/engine.ts` 的纯函数预算/在飞/报告算术、`waiting`/`review` 子态、auto-resume 的参数（grace/上限） | 其 RunStore / cockpit / `run.ts` 状态机 |
| native-agent-router | MIT | P6-B, P6-E | `stats.py` 的**确定性评分因子表**、verify→repair→re-verify 的最小闭环形态 | 其 kernel 执行器/存储；stats 是**特征**不是 router |
| agent-as-a-router (ACRouter) | **MIT（复核更正）** | P6-B, P6-D0 | `inference.py`（204 行）的 route → verify → escalate → observe 循环 | 训练型 router / benchmark（重依赖 + 绑定其模型集） |
| pi-subagents | MIT | P6-D0 | watchdog 的 **schema + severity policy**、revival 的**有界深度** | 模块本体（依赖 pi SDK）、missions/executor 大文件 |
| agent-orchestrator (AO) | Apache-2.0 | P6-D0, P6-A | `autoreview` 策略参数（idle 阈值 / 同 head 重试上限）、`automation` 的 tick + lease + catchup 形态 | session/workspace ownership 架构、40+ adapter 层 |
| superpowers | MIT | P6-D0 | review/fix 的 prompt 文本与 scoped findings / bounded re-review 写法 | POSIX bash 工具 |
| symphony | Apache-2.0 | P6-A | 单一权威 orchestration state、reconcile-on-tick、worker lifecycle/recovery 语义 | Elixir runtime、代码迁移 |
| dagents | Apache-2.0 | P6-C | `validate-topology.ts` 拓扑校验、`stream-backend.ts` 行解析 | TypeORM/Postgres/gateway 重栈 |

**新增候选（本轮复核发现，尚未纳入矩阵）**：`BloopAI/vibe-kanban`（Apache-2.0，多 agent + worktree + 看板，最接近本项目形态）、`coder/agentapi`（MIT）、`ruvnet/claude-flow`（MIT）、`claude-task-master`（自定义 License 头，需逐条读）。

**明确排除**：`orca`（无 License）、`smtg-ai/claude-squad`（**AGPL-3.0**）、Chorus（AGPL）。

---

## 13. Dependencies

```text
P6-F  Model Pool / Availability Guard   （无前置；纯新增常量 + orchestration 侧过滤）
P6-A  Orchestration State Loop          （根：observation / decision 契约 / validation / loop；无硬前置）
  ├─→ P6-D0  Verdict 回流 + 有界 rework（同 agent）  （只依赖 A；不依赖 B/C）
  ├─→ P6-B   Dynamic Assignment         （依赖 A；F 是硬过滤，E 只提升质量）
  └─→ P6-C   Planner / Dynamic DAG      （依赖 A；含 TaskStore 最小变更 API）

P6-A + P6-D0 → P6-E                     （有 attempt 与 verdict，才有可沉淀的历史）
P6-E         → P6-B 第二期（evidence-based，而非第一期启发式）
P6-F         → P6-B 的候选硬过滤
P6-B + P6-C + P6-D0 → P6-D1             （reassign 需要 B，replan/invalidation 需要 C）
```

最小可用链：**P6-F → P6-A → P6-D0 → P6-E**（白名单 + 闭环 + 质量门 + 证据）。
P6-B / P6-C 之后并行推进；**P6-D1 是唯一同时依赖 B 与 C 的阶段，排在最后**。

---

## 14. Acceptance Criteria

| 阶段 | 可验证结果（示例，非实现细节） |
|---|---|
| P6-A | 给定一个 `to_verify` 的任务，系统能产出一条 typed decision 并落回状态；非法 decision 被拒绝且零副作用；**未启用的动作返回 `not-implemented`，不被当作 `continue`** |
| P6-B | 同一需求在证据变化时给出不同候选排序；被 gate 否决的组合一定不进入执行 |
| P6-C | TaskStore 变更 API 落地且仍是唯一权威；含 split + dependency 的候选图能落库；含环/超深的候选被整体拒绝（无部分写入） |
| P6-D0 | FAIL verdict → 一次有界 rework（同 agent，经 `to_verify → rework → queued → tick → executeTask`）→ re-review；超上限时到达明确终态；`succeeded` 仍只能由 `applyVerification` 写入 |
| P6-D1 | reassign 走 P6-B 排序 + gate 否决；replan/invalidation 走 P6-C 的 store API；两者都受同一套上限约束 |
| P6-E | 输出按 agent/model/task-type 的聚合统计，且不改变任何 task 状态 |
| P6-F | 池外模型请求被 fail-closed 拒绝，且理由可区分「不在白名单」与「不可用」 |

每个阶段的验收都必须包含**架构边界检查**（§4 的 13 条）：例如 `src/orchestration/*` 仍不 import `src/runtime`；无第二 Scheduler；无直接 spawn。

---

## 15. Risks

| # | 风险 | 处理方向（计划层面） |
|---|---|---|
| 1 | **infinite replan** | 每棵树的 replan 次数/深度上限；命中上限后进入显式终态而非继续循环 |
| 2 | **infinite retry / review loop** | 每 task 的 rework/retry 预算 + 「同一 verdict 重复出现」检测 |
| 3 | **stale Task state** | 决策必须基于**当次 observation**；落库前重读状态（乐观并发：状态已变则拒绝并重新 observe） |
| 4 | **stale artifact** | 上游重做时显式 `downstream-invalidation`，不静默沿用旧 artifact 引用 |
| 5 | **reviewer disagreement** | verdict 必须带 `evidence`；冲突时保留双方证据并交给人工/上层决策，不自动覆盖 |
| 6 | **model unavailable / quota exhausted** | 复用 spawn gate 的 fail-closed 信号；assignment 只排序，gate 是否决 |
| 7 | **workspace collision** | worktree 创建仍归 `WorkspaceManager` + `WorkspaceLock`；P6 不得自建目录 |
| 8 | **cross-process state loss** | `TaskStore` 仍 in-memory；P6 不得假设跨进程可达，持久化单独立项 |
| 9 | **planner 幻觉出非法图** | planner 只产候选；`graph-delta` 校验 + `spawnChild` 复核，双层拒绝 |
| 10 | **reviewer 被当作 worker** | Codex 只进 `mode:'review'`；执行候选池不含 codex |
| 11 | **重试/重规划计数器位置不明** | 计数器写在 `AttemptRecord`（P6-E）或 Task 字段上；**不得新建第二套计数权威**；上限值必须有默认常量 |
| 12 | **telemetry 反噬执行** | `attempt-history` 写入失败只记录诊断，**不得阻塞或改变 task 状态**（证据层允许降级） |
| 13 | **扩 TaskStore API 时越界** | P6-C 只新增最小变更方法并复用既有校验；若无法保持单权威，就**限制 P6-C 范围**而不是绕开 TaskStore |

---

## 16. Implementation Order

```text
1. P6-F   Model Pool 白名单常量（纯新增；orchestration 侧引用；零回归）
2. P6-A   Observation + Decision 契约 + validation + loop 骨架（动作只启用 continue / wait / abort）
3. P6-D0  Codex review → ReviewVerdict → applyVerification + 有界 rework（同 agent，经 queued 重入）
4. P6-E   AttemptRecord + PerformanceRollup（只读证据，写入失败不阻塞）
5. P6-B   assignment 纯函数（先启发式；E 就绪后转 evidence-based）
6. P6-C   TaskStore 最小变更 API + planner 候选 + graph-delta 校验
7. P6-D1  reassign（用 P6-B）+ replan / downstream-invalidation（用 P6-C）
```

理由：F 与 A 无前置；**D0 只依赖 A**（因此 review 回流能早落地，不被 B/C 阻塞）；
E 依赖 A+D0 的真实 attempt；B 依赖 A（F 是硬过滤、E 提升质量）；
C 需要 TaskStore 最小 API 扩展；**D1 是唯一同时依赖 B 与 C 的阶段，必须最后**。

**每一步都必须是可独立验收的小步**，且不改变现有测试语义（2559 全绿是硬门槛）。

---

## 17. Explicitly Do Not Rebuild

| 不得重建 | 位置 | 原因 |
|---|---|---|
| Native Agent Runtime | `src/orchestrator/`、`src/runtime/`、`src/adapters/` | 唯一执行边；`RunRequest/RunHandle/RunResult` 契约已 hardened |
| Scheduler | `src/orchestration/scheduler.ts` | 已有界 + 确定性 + 从 TaskStore 派生占用 |
| Workspace | `src/orchestration/workspace.ts`、`workspace-lock.ts`、`task-result.ts` | 唯一 worktree 所有者；缺失信号=拒绝 |
| TaskStore | `src/orchestration/store.ts`、`task.ts` | 唯一 task 状态权威；转移表已锁 `running→succeeded`。**允许**为 P6-C 增加最小变更 API（§7.1），但**不允许**在其之外另建图结构或状态副本 |
| verification engine | `src/orchestration/translate.ts`、`orchestrator.applyVerification` | 唯一 succeeded 入口 |
| merge mechanism | `src/orchestration/task-result.ts` | 显式 merge、不 auto-commit、冲突原地保留 |
| spawn gate | `src/orchestration/spawn-gate-input.ts`、`src/quota/spawn-gate.ts` | 7 真实信号、双期重跑、fail-closed |
| Decision Layer 实现 | `src/decision/` | 只被**调用**，不被改写 |

```text
P6 = Orchestration Intelligence（决策、分配、分解、review 回流、证据、白名单）
   ≠ 第二套 Runtime / Scheduler / Workspace / TaskStore / verification / merge
```
