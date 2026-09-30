# Phase 5B ?Multi-Agent Architecture (Reuse-First Design)

```text
Phase 5B   = Architecture / DESIGN ONLY
Status     = Ready for Phase 5C implementation
Reuse      = Source-level reuse audit already completed (Phase 5A)
```

**本轮不是 Multi-Agent runtime implementation?* 目标是产出一份可以直接交给下一轮实现的
架构?C 到底要写什么、从哪些成熟项目提取什么、现?Runtime 如何接入?
**本轮零代码改?* 未实?spawn / DAG runtime / communication bus / worktree /
scheduler；未修改 `src/adapters`、`src/quota`、`src/runtime`、Dashboard?
---

## 1. Architecture

### 1.1 层级

```text
┌──────────────────────────────────────────────────────────?? Orchestration Layer            ?5C 新建 src/orchestration/   ??   Task DAG · Agent tree · Scheduler · Review gate        ??   Workspace manager · Budget gate · Message bus            ?└──────────────────────────────┬───────────────────────────?                               ? 只调用，不重?┌──────────────────────────────▼───────────────────────────?? Existing Runtime            ?保留，不?                   ??   Orchestrator.run/review · AgentSession · ManagedProcess  ??   SessionStore · EventHub · RunResult · spawn.ts          ?└──────────────────────────────┬───────────────────────────?                               ?┌──────────────────────────────▼───────────────────────────?? Adapters / Transport        ?保留，不?                   ??   opencode · codex · cline · workbuddy                    ?└──────────────────────────────────────────────────────────?
横切（已存在，直接复用）?  Phase 4 Quota/Model Center   ? spawn ?gate
  Phase 4M Hindsight (ADAPT)   ? ?project memory，非 task state
```

### 1.2 三条不可违反的原?
1. **Orchestration Layer 只能向上调用 Runtime，不能替换它?*
   `RunResult` / `RuntimeEvent` / `EventHub` / `SessionStore` 全部保留为唯一契约?2. **默认?agent?* Multi-Agent ?OPT-IN，不配置即单 agent，绝不偷偷扩?3. **Memory 不是 Task State?* Hindsight 存项目事实与历史?*不存** task ?   依赖图、调度状态、通信内容?
---

## 2. Existing Runtime integration

### 2.1 现状（已核验的真实契约）

| 现有能力 | 位置 | 5B 对它的要?|
|---|---|---|
| `Orchestrator.run(req)` | `src/orchestrator/orchestrator.ts:133` | **唯一**的执行入口，不新增第二条 |
| `Orchestrator.review(req)` | `orchestrator.ts:243` | review gate 直接用它 |
| `Orchestrator.activeSessions()` | `orchestrator.ts:248` | cancellation 的真实依?|
| `Orchestrator.getTask/listTasks` | `:252 / :256` | 状态查询来?|
| `ManagedProcess` + `taskkillTree(pid)` | `runtime/spawn.ts:118 / :362` | **现成?Windows 进程树取?* |
| `RunResult` | `core/types.ts:149` | 子任务结果的唯一形状，不加字?|
| `EventHub<T>` | `core/event-hub.ts:240` | 消息投递通道 |
| `SessionStore` | `runtime/store.ts` | thread / transcript / task 持久?|
| `AgentDescriptor.capabilities` | `runtime/registry.ts` | capability gating |
| `BudgetManager` | `quota/budget.ts:155` | 预算预留/结算 |
| `ModelRegistry` | `quota/registry.ts:29` | Agent→Model→Capability |
| `evaluateSpawnGate` | `quota/spawn-gate.ts:25` | spawn 前唯一闸门 |

### 2.2 集成方式

```text
5C ?Scheduler
  └─ 决定"下一个该跑哪?Task"
       └─ 调用 Orchestrator.run(req)     ?已有，不?            └─ 得到 RunHandle ?RunResult  ?已有，不?       └─ ?RunResult 翻译?Task ?   ?5C 新写（唯一新增的翻译层?```

**关键结论**?C 新代码的量集中在 **task ?/ 调度 / workspace / 消息** 四处?**执行路径完全复用**。这?不推翻现?Runtime"的技术含?
---

## 3. Reuse map（总览?
| 我们的模?| 上游来源 | 方式 | License |
|---|---|---|---|
| `orchestration/worktree.ts` | `pi-subagents/src/worktree.ts` | **adapt** | MIT |
| `orchestration/concurrency.ts` | `pi-subagents/src/agent-manager.ts` | **extract** 思想 | MIT |
| `orchestration/spawn-policy.ts` | `pi-subagents/src/nested-tools.ts` | **adapt** | MIT |
| `orchestration/limits.ts` | `pi-subagents/src/workflow/runtime.ts` | **extract** 上限模型 | MIT |
| `orchestration/usage-rollup.ts` | `pi-subagents/src/usage.ts` | **extract** | MIT |
| `orchestration/task-store.ts` | `pi-subagents/src/schedule-store.ts` | **adapt** ?原子?| MIT |
| `orchestration/turn-limits.ts` | `pi-subagents/src/abortable.ts` + `status-note.ts` | **adapt** | MIT |
| `orchestration/messages.ts` | `pi-subagents/src/cross-extension-rpc.ts` | **reference** | MIT |
| `orchestration/scheduler.ts` | `symphony/SPEC.md` + `orchestrator.ex` | **adapt**（照 SPEC 重写?| Apache-2.0 |
| `orchestration/reconcile.ts` | `symphony/orchestrator.ex` | **adapt** | Apache-2.0 |
| `orchestration/retry.ts` | `symphony/@failure_retry_base_ms` | **adapt** | Apache-2.0 |
| `orchestration/dag.ts` | `agent-framework/_validation.py` | **reference**，TS 重写 | MIT（算法） |
| `orchestration/checkpoint.ts` | `agent-framework/_checkpoint.py` | **reference** | MIT |
| `orchestration/agent-select.ts` | `fifony/agents/adapters/registry.ts` | **reference** 校验字段 | Apache-2.0 |
| `orchestration/workspace-merge.ts` | `fifony/domains/workspace.ts` | **adapt** | Apache-2.0 |
| `orchestration/cli-wrap.ts` | `fifony/agents/adapters/cli-wrapper.ts` | **reference** | Apache-2.0 |
| Windows `.cmd` 解析思路 | `chorus/cli/claude-spawner.mjs` | **reference only ?禁止 copy** | **AGPL-3.0** |

### 3.1 License 结论

- **MIT（pi-subagents?*：可 extract/vendored?*必须保留版权?*?- **Apache-2.0（Symphony / fifony?*：可 adapt/重写，需保留 NOTICE?- **AGPL-3.0（chorus?*?*禁止复制代码**。只借鉴设计思路 ?否则会强制本项目整体 AGPL?
---

## 4. `pi-subagents` source mapping

### 4.1 `src/worktree.ts` ?`orchestration/worktree.ts`

| ?| 内容 |
|---|---|
| **上游解决** | ?agent 一个临?worktree；无改动自动清理，有改动提交?branch 并返?`{path, branch, baseSha, workPath}`；`worktreeIsolationEnabled` 全局开?|
| **为什么不能直接复?* | 它是 **pi 扩展**，调?`pi.exec` 执行 git 命令 ?我们没有 pi SDK?|
| **依赖** | 只需 `child_process`（我们已?`runtime/spawn.ts` 的进程管理）?|
| **适配方式** | ?`pi.exec` 换成 `ManagedProcess` / `execFile`?*保留算法**（路径校验、baseSha 记录、无改动清理?|
| **License** | MIT ?保留版权头即?|

### 4.2 `src/agent-manager.ts` ?`orchestration/concurrency.ts`

| ?| 内容 |
|---|---|
| **上游解决** | **两个独立并发?*（background 默认 10 / foreground）；超限排队自动启动；`occupiesPoolSlot`；`depth` 记录嵌套 |
| **为什么不能直接复?* | ?pi ?session 对象耦合?|
| **适配方式** | **extract 核心思想**：双?+ 排队 + slot 判定。我?MVP 先只做单池（`maxConcurrentAgents`），?*接口按双池设?*，避免二期再?|
| **License** | MIT |

### 4.3 `src/nested-tools.ts` ?`orchestration/spawn-policy.ts`

| ?| 内容 |
|---|---|
| **上游解决** | `maxSubagentDepth`（默?2）；`depth >= max` ?*硬拒?*并给提示；`allowedSubagents` 白名单即权限边界；子 agent 默认阻塞式，父结束时 detached ?agent 停止 |
| **为什么不能直接复?* | ?pi tool-call 协议?|
| **适配方式** | `maxDepth` **MVP 设为 1**? 要求）；`allowedSubagents` ?我们?capability allowlist?|
| **License** | MIT |

### 4.4 `src/workflow/runtime.ts` ?`orchestration/limits.ts`

| ?| 内容 |
|---|---|
| **上游解决** | `agent()` / `parallel()` / `pipeline()` 脚本化编排；**worker thread + `node:vm` 沙箱**；硬上限 `WORKFLOW_AGENT_CAP=1000`、`WORKFLOW_ITEM_CAP=4096`、`WORKFLOW_NESTED_CAP=256`?*"脚本没有任何绕过上限的通路"** |
| **为什么不能直接复?* | 完整 workflow runtime 超出 MVP 范围?|
| **适配方式** | **?extract 上限模型**。这一条最关键：上限必须是**代码强制**，不能是可绕过的配置?|
| **License** | MIT |

> **5C 不实现脚本编?* ?硬上?+ 无绕过通路"这个设计?
### 4.5 `src/usage.ts` ?`orchestration/usage-rollup.ts`

`addUsage` / `LifetimeUsage`：token 向父?roll-up?*extract**（MIT?注意?M-6 已确?`estimated` 不得由我们的层产??roll-up 只能?*已观?*?
### 4.6 `src/schedule-store.ts` ?`orchestration/task-store.ts`

每次变更：`PID 排他??重读 ???temp+rename 原子写`?*adapt**（MIT?我们已有 `runtime/store.ts` ?`writeAtomic`?*复用?*，只借鉴?重读模式?
### 4.7 `src/abortable.ts` + `status-note.ts` ?`orchestration/turn-limits.ts`

`maxTurns` 生效前先 wrap-up 警告再硬 abort?*产出干净的部分结?*?**adapt**（MIT）。对应我们的 timeout/cancel + partial output?我们已有 `abortSignal`；只?先警告后中止"的行?
### 4.8 `src/cross-extension-rpc.ts` + `group-join.ts` ?`orchestration/messages.ts`

版本?RPC 信封 + 组内完成聚合?*reference**（MIT）。typed notification 范式?
---

## 5. Symphony design mapping

Symphony 与本项目取向高度一致：**编排器只调度，不?provider API，真正跑的是
Codex app-server 子进?*。实现是 Elixir，但仓库提供?*语言无关 SPEC**?
### 5.1 `SPEC.md` ?`orchestration/scheduler.ts`

?SPEC 重写?*术语与契?*：轮?tracker ??issue 一个隔?workspace ??coding
agent；有界并发；**单一权威 orchestrator state**；重启对?
### 5.2 `elixir/.../workspace.ex` ?`orchestration/workspace.ts`

`create_for_issue`：**确定性工作区路径 + 路径安全校验 + 钩子 + 失败清理**；支持远程 worker。Apache-2.0（**adapt**）
确定性路?+ 路径安全校验这两点直接采纳：它让"崩溃后找?workspace"成为可能?并且堵住 `../../` ?
### 5.3 `elixir/.../orchestrator.ex` ?`orchestration/scheduler.ts` + `reconcile.ts`

```text
State{running, blocked, retry_attempts, claimed, completed}
reconcile_running_issues()
reconcile_blocked_issues()
@failure_retry_base_ms   指数退?max_concurrent_agents    可按 state 配置
```

**"单一权威 orchestrator state"是本次采纳的最重要一条设计原?*?调度状态只有一个来源，不允?task 状态分散在多处?
### 5.4 `elixir/.../agent_runner.ex` + `codex/app_server.ex`

证明"native CLI/app-server 子进?是可编排?*reference** ?与我们现?Codex
adapter 同思路，我们已有，无需改动?
---

## 6. Fifony secondary mapping

仓库小（12 stars）、依赖偏重、用 `execSync`/shell ?**extract 而非整体依赖**?
| 上游 | 映射?| 方式 |
|---|---|---|
| `agents/adapters/registry.ts` | `orchestration/agent-select.ts` | **reference** ?用它对照校验我们?adapter 契约是否漏字?|
| `agents/adapters/types.ts` + `shared.ts` | `orchestration/agent-select.ts` | **extract** ?`resumeSessionId` / `addDirs` / `readOnly` 是我们未来需要的归一化字?|
| `domains/workspace.ts` | `orchestration/workspace-merge.ts` | **adapt** ?`createGitWorktree` / `mergeWorkspace` / `ensureWorktreeCommitted` / diff 统计 |
| `agents/parallel-executor.ts` | `orchestration/scheduler.ts` | **adapt** ?`maxParallelSubTasks` 限制 fanout；每子任?*独立 sub-worktree** |
| `agents/command-executor.ts` | ?| **reference** ?对照我们?spawn 超时（我们已?`taskkillTree`?|
| `agents/retry.ts` | `orchestration/retry.ts` | **reference** ?失败类型分类概念 |
| `agents/adapters/usage.ts` + `cli-wrapper.ts` | `orchestration/cli-wrap.ts` | **adapt** ?before/after hook 包裹 CLI 并捕获输?|

---

## 7. Task model

### 7.1 最小字段集

```ts
interface Task {
  id: TaskId;
  parentTaskId: TaskId | null;
  dependencies: readonly TaskId[];   // 显式，不做自动推?  assignee: AgentId | null;          // 决策结果，不是创建时确定
  agentId: AgentId;                  // 选中?agent
  modelId: ModelId | null;           // ?ModelPolicy 决定，agent 不可?  status: TaskStatus;
  acceptanceCriteria: string;        // 显式；不是自动生成的
  artifacts: readonly ArtifactRef[];
  retryCount: number;
  attempt: number;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  budget: TaskBudget;                // 显式预留额度
  workspace: WorkspaceRef | null;    // 显式；共享即写错
}
```

### 7.2 状态机

```text
planned ─?queued ─?running ─?succeeded
   ?         ?        ?   ?         ?        ├─?to_verify ─?succeeded
   ?         ?        ?       └─?rework ─?queued
   ?         ?        ?   ?         ?        ├─?failed ─?retrying ─?queued
   ?         ?        ?                 └─?replanning ─?queued
   ?         ?        ?   ?         ?        └─?blocked
   ?         ?   └──────────┴────────?cancelled
```

**11 个状?*，与 §5 建议一致。要点：

- **`to_verify` 是独立状?* ?worker 说自己做?**不等?* 通过。必须经 verify/review?- **`rework` ?`retry` 分开** ?重试是同一次尝试失败后重跑；rework ?*验证不通过**?  需要修改产物。混淆二者会导致"重试掩盖质量问题"?- **`replan` ?`retry` 分开** ?retry 重跑同一 task；replan 是任务本身要?- **`blocked` 向上传播**??
### 7.3 必须支持的图检?
| 检?| MVP 实现方式 |
|---|---|
| dependency check | 运行时：仅当全部 dependency ?`succeeded` 才可 `queued` |
| **DAG cycle detection** | **建图?*（写 `planned` 边即检测），照 `agent-framework/_validation.py` |
| orphan detection | reconcile 时：parent 不存在或已终结但 child ?`running` |
| blocked propagation | 上游任一 `blocked`/`failed` ?下游?`blocked`，不自动重试 |

**明确不做**：自?task decomposition。`dependencies` 由调用方显式提供?
---

## 8. DAG

### 8.1 表示与排?
```text
表示：显式邻接表  Map<TaskId, TaskId[]>  (out-edges)
排序：Kahn 拓扑 ?0 入度?dependency 全部 succeeded ?task 进入 ready queue
并行：ready queue 内的 task ?maxConcurrentAgents 限制并发执行
```

不用递归 DFS（深图栈溢出），不用隐式依赖（不可解释）?
### 8.2 失败与传?
```text
dependency failed      ?下游 blocked（不自动重试?dependency blocked     ?下游 blocked
dependency cancelled   ?下游 cancelled
dependency reworking   ?下游保持 queued，等上游?```

**为什么不自动重试下游**：一个上游失败，下游多半同样会失败。无脑重试会烧掉预算
并产生垃圾产?
### 8.3 复用来源

- `pi-subagents/workflow/{runtime,worker-source}` ?`parallel()` 编排形状（MIT?- Symphony SPEC 的调度契?+ 单一权威 state（Apache-2.0?- `agent-framework/_edge.py` ?`FanOutEdgeGroup` / `FanInEdgeGroup` 概念 + `_validation.py` 的环检测（算法参考，TS 重写?
**禁止**：自建复?workflow engine。MVP 只需要拓扑排?+ 并发限制 + 失败传播?
---

## 9. Agent hierarchy

### 9.1 MVP ?
```text
Root (Coordinator)
   ├── Worker A        ?可并?   ├── Worker B        ?   └── Reviewer        Codex，独?review
```

**只有 Root / Coordinator 可以 spawn?* Worker **不能** spawn?
### 9.2 硬限?
```ts
interface SpawnPolicy {
  maxDepth: 1;              // MVP 硬编码；提权需显式配置
  maxChildren: number;      // fan-out 上限
  allowedSubagents: readonly AgentId[];  // 白名单即权限边界
  canSpawn: boolean;        // Worker ?false
}
```

- **`maxDepth = 1`** ?child **不能** spawn grandchildren。硬拒绝?*不是警告**?- 拒绝时必须给?*可操?*的原因（?`nested-tools.ts`：告诉调用方 depth 与上限）?- 深度检查在**创建?*执行，不是在执行??创建时拒绝比执行时中止更早、更便宜?
### 9.3 Cancellation propagation

```text
Root cancel
  ├─?直接 child cancel
  ?    └─?runtime/session.ts ?abort ?ManagedProcess
  ?          └─?taskkillTree(pid)  ?现成?Windows 进程树清?  ├─?workspace cleanup（无改动删除；有改动保留供审计）
  └─?budget release?2?```

**禁止 orphan process?* 依据?`Orchestrator.activeSessions()`（真实存在的 API），
不另建注册表?
---

## 10. Communication

### 10.1 消息类型（typed，不做自?chat?
| 类型 | 方向 | 载荷 |
|---|---|---|
| `task_assigned` | parent ?child | task 摘要 + acceptanceCriteria |
| `progress` | child ?parent | 阶段 + 已完成项 |
| `blocked` | child ?parent | 阻塞原因 + 需要什?|
| `question` | child ?parent | 待答问题（parent 可选回答） |
| `artifact_ready` | child ?parent | artifactRefs |
| `review_request` | child ?reviewer | artifactRefs + criteria |
| `review_result` | reviewer ?parent | pass / rework / fail + 理由 |
| `handoff` | child ?sibling | **artifactRefs only**（见 §10.3?|
| `cancel` | parent ?child | 原因 |
| `heartbeat` | child ?parent | 存活 + 当前阶段 |

### 10.2 信封

```ts
interface MessageEnvelope {
  taskId: TaskId;
  parentTaskId: TaskId | null;
  sender: AgentId;
  recipient: AgentId | 'root';
  type: MessageType;
  timestamp: number;
  correlationId: string;      // 串起一次交互（?review_request ?review_result?  artifactRefs: readonly ArtifactRef[];
  payload: unknown;           // 类型?type 定，不接受自由格?}
```

### 10.3 禁止隐式 transcript 共享

**兄弟 Agent 之间不得默认复制完整 transcript?* 只传 `artifactRefs`（文件路?+
摘要）。理由：transcript 可能?credential 路径、prompt 片段、其?task 的上下文?
`handoff` 类型?payload **只能?artifact 引用**，不携带原始对话?
---

## 11. Workspace isolation + Context

### 11.1 Workspace isolation（MVP 核心安全条件?
```text
Worker A ?worktree A     ?必须
Worker B ?worktree B     ?```

**不是**?
```text
A ─?   ├→ same checkout      禁止：两?worker 互相破坏对方的未提交改动
B ─?```

**实现**：`orchestration/worktree.ts` ?`pi-subagents/worktree.ts`（MIT，adapt?§4.1）。每 worker 一个独?worktree，记?`{path, branch, baseSha, workPath}`?
**收尾语义**（照上游）：

| 情况 | 处理 |
|---|---|
| worktree 无改?| 自动清理删除 |
| worktree 有改?| **提交?branch** 并保留，返回 path + branch |

**不是**自动 merge 到主分支。merge 需 reviewer 批准?1.1?
**路径安全**：`orchestration/workspace.ts` 必须?*路径逃逸检?*
（照 Symphony `workspace.ex` ?path safety validation?阻止 child ?自己 worktree 之外的绝对路径。见 §21.3?
**不支?worktree ?agent 门槛**? 硬条件）?
```text
descriptor.supportsWorktreeIsolation === false
  ?只能拿到 readonly 任务类型
  ?禁止参与并行写代码任?```

允许：read-only research / review / analysis?*这是硬门槛，不是建议?*

### 11.2 Context

```text
Parent  ──?bounded task context      （裁剪过的任务描述，不含整个历史?Predecessor ──?artifact reference    （产物路径，不复制内容）
Sibling ──?NO implicit context       （无隐式上下文）
```

历史知识 ?**Hindsight**（Phase 4M ADAPT?
**Hindsight 可以提供**：project facts / decisions / historical experience?**Hindsight 不能负责**：task state / dependency graph / agent scheduling /
workflow state / communication?
**边界后果**：task 状态存?*编排层的 store** 里（`orchestration/task-store.ts`），
**不是** Hindsight。重启后?store 恢复，不是从 memory 恢复?这个区分很重要：memory ?可能过时的事?，task state ?必须精确的当前状??
---

## 12. Budget gate

### 12.1 复用 Phase 4（不重建?
```text
Quota Record ─?ModelRegistry ─?BudgetManager ─┼─?SpawnGateInput ─?evaluateSpawnGate() ─?allowed/denied
Capability    ─?                             ?Concurrency   ─?                             └─??allowed ?spawn
Policy        ─?```

### 12.2 修复 Spawn Gate ?demo input 问题（已定位?
`src/quota/index.ts:138-147` 目前这样构造输入：

```ts
spawnGate: evaluateSpawnGate({
  multiAgentEnabled: opts.multiAgentEnabled ?? false,
  taskPolicyAllows: true,        // ?硬编?  capabilitySatisfied: true,     // ?硬编?  agentAvailable: true,          // ?硬编?  modelAvailable: true,          // ?硬编?  quota: { status: 'available' },// ?硬编码，不是真实 QuotaRecord
  budget: { remaining: 100, requested: 10 },  // ?硬编?  concurrency: { current: 0, limit: 4 },      // ?硬编?}),
```

**问题**? 个字段里 8 个是 demo 值。真实的 `QuotaRecord` / `ModelRegistry` /
`BudgetManager` / 并发计数**一个都没进?*。也就是说这?gate 目前**只测?`multiAgentEnabled` 一个分?*，其余分支从未被真实数据触发?
**5C 的接口设?*（本轮只设计，不实现）：

```ts
// 5C 新建：src/orchestration/spawn-gate-input.ts
interface SpawnGateContext {          // 编排层持有真实来?  quotaCenter: QuotaCenterView;       // 真实探测
  registry: ModelRegistry;            // 真实注册?  budgets: BudgetManager;             // 真实 ledger
  policy: PolicyDecision;             // evaluatePolicy() 的真实输?  concurrency: { current: number; limit: number };  // 编排层自己数
}

function buildSpawnGateInput(
  task: Task,
  ctx: SpawnGateContext,
): SpawnGateInput;   // 8 个字段全部由真实来源填充，无默认?```

**原则**：`buildSpawnGateInput` **不得有默认允?*。任何来源缺失都必须
产生 `denied`，而不?`true`。这?4M-6 ?"no ledger ?not 0" 是同一条原则：
**缺失的信号不能变成放行信?*?
**本轮不实现它**，也不修?`src/quota/`?C 负责接线?
---

## 13. Budget reservation（Phase 5 design，不?Phase 4?
### 13.1 已核验的事实

```text
BudgetManager 实际 API：allocate / reserve / consume / release / remaining / snapshot / snapshotAll
Reservation 实际字段? { id, amount, createdAt }
```

**核验结论**?
| 问题 | 现状 | 5C 处理方式 |
|---|---|---|
| **reservation expiry** | `Reservation` **没有** `expiresAt` 字段 | ?*编排?*?TTL 扫描器，超时 `release()`?*不改** `quota` |
| **cancellation release** | `release(reservationId, amount?)` **已存?* | 直接?|
| **crash recovery** | ledger **纯内?*，无持久化（已核验：无任?`writeFile`/`Store`?| 编排层维?*自己?* durable reservation 记录，恢复时据此 `release` 悬挂 hold |
| **multi-scope reservation** | 支持 `BudgetScope = 'global'\|'task'\|'agent'` | 5C 定义?scope ?*原子预留顺序**（见 13.2?|
| **retry budget** | ?| 5C 定义 `TaskBudget.retryAllowance` |
| **fan-out budget** | ?| 5C 定义父级预留覆盖子级总需?|

### 13.2 ?scope 预留顺序（设计）

```text
?reserve global，再 reserve task，最?reserve agent
?任一步失败，按逆序 release 已成功的步骤
```

**为什么这个顺?*：global 最宽、agent 最具体。先?global 可避?具体 scope 有额?但全局已超"的伪可用状态。逆序释放保证不泄?
### 13.3 ?4M-6 的一?
4M-6 确立?`Usage Observation ?Budget Consumption`，以?`unknown` / `estimated` 不扣费。Multi-Agent 的预留与结算**沿用同一纪律**?只有 `observed` ?`consume()`；`unknown` 释放预留而非计费?
---

## 14. Failure / recovery

### 14.1 四个概念必须分开?4 核心?
| 概念 | 含义 | 触发 | task 状态去?|
|---|---|---|---|
| **retry** | 同一次尝试失败，**重跑** | 进程崩溃 / 传输失败 | `retrying ?queued` |
| **re-execute** | 同一 task ?retry 再次运行 | retry 的一部分 | 同上（不是独立状态） |
| **rework** | **验证不通过**，需修改产物 | review 拒绝 | `to_verify ?rework ?queued` |
| **replan** | **任务本身要改** | 规格有误 / 依赖消失 | `?replanning ?queued` |

**为什么必须分开**：retry 掩盖不了质量问题（retry 3 次仍不通过 = rework），
rework 也不?retry（rework 要改产物，retry 不用）。把三者混在一?`retryCount`
里会导致"重试掩盖?review 拒绝"?
### 14.2 借用 Symphony ?recovery

```text
reconcile_running()   进程没了?task ?running ??failed 或按 retry 重排
reconcile_blocked()   blocked ?task 有无可能已可运行
指数退?             @failure_retry_base_ms，有界次?orphan cleanup        parent 没了 child ?running ?cancel
```

**Symphony ?单一权威 orchestrator state"是这里的核心**?reconcile 之所以可行，是因?task 状态只有一个来?
### 14.3 ?Temporal 的思想，不引入 Temporal

?*durable execution** 的思想：状态变更先落盘再执行动作，使崩溃可恢复?
**明确不引?* Temporal（或任何 workflow engine）。MVP ?`schedule-store.ts` 式的 PID ?+ 原子写（MIT?.6）即?
---

## 15. Cancellation

### 15.1 Root cancel

```text
Root cancel
  ?children cancel          依据 Orchestrator.activeSessions()
  ?workspace cleanup        无改动删除；有改动保留供审计（pi-subagents 的做法）
  ?budget release           BudgetManager.release()
```

### 15.2 Child cancel

```text
Child cancel
  ?parent continues OR policy decides
```

**规则**：单?child 失败/取消**不自动取消整个任务树**。parent 依据
`blocked` / `question` 消息决定：重派、缩小范围、或放弃?*升级?Root cancel
必须是显式决?*，不是自动级?
### 15.3 禁止 orphan process

技术基础已存在：`runtime/spawn.ts:362 taskkillTree(pid)`?5C 只需调用 + 记录 `CleanupReport`（`RunResult.cleanup` 已有?
**注意**：`RunResult.cleanup` 的注释明确写着?*不能改变** `state`
（state ?terminal policy ?exit code 决定?C **不得**为了"清理失败就算失败"
而改这个语义?
---

## 16. Review workflow

### 16.1 保持现有原则

```text
OpenCode ?Implementation
Codex     ?Independent Review / Test
```

### 16.2 Multi-Agent 下的?
```text
Root
   ├── OpenCode Worker    （implementation?   ├── OpenCode Worker    （implementation?   └── Codex Reviewer     （review?```

**不要自动?Codex 变成?implementation worker?*
理由已在 Phase 4 确立：Codex 的价值在?*独立?*。一旦让它也做实现，
"实现者审自己的同?会削?review 的独立性，review gate 就失去意?
技术支撑：spawn ?`capabilities.review` ?`capabilities.implementation` ?分开的（`quota/index.ts:161` 已按此区?taskTypes）。Reviewer ?spawn
必须要求 `review` capability?
### 16.3 Review 是状态，不是建议

```text
worker 产出 ?to_verify ?Reviewer review ?pass: succeeded
                                        ?rework: 重派（带 review 理由?                                        ?fail: failed
```

**worker 自己不能?task 置为 `succeeded`**。必须经 verify?
---

## 17. Hindsight（按 4M-9 决策?
```text
Hindsight = Optional Project Memory Backend (ADAPT, FROZEN)
```

| Hindsight **可以** | Hindsight **不能** |
|---|---|
| project facts | task state |
| decisions | dependency graph |
| historical experience | agent scheduling |
| | workflow state |
| | communication |

**它不?Task State?* task 状态在编排?store。重启恢复从 store，不?memory?
**4M-9 的三条永久约束在 5B 继续适用**?
1. `HINDSIGHT_DATABASE_URL` 显式（禁 pg0 隐式 fallback?2. `projectMemoryId` 为唯一 identity（禁 basename?3. Memory = Untrusted Data

**Child agent ?memory ?*：memory 内容?provenance ?confidence?`low`/`unknown` **不可**作为架构事实引用。这?5B 尤其重要 ?一个被 poisoning ?child agent 比单?agent 危害大得?
---

## 18. Agent / Model

```text
Agent
  ?Model          ?不可?agent 自由选择
  ?Capability
  ?Quota
  ?Budget
```

- `Task.agentId` 由编排层**?*（`agent-select.ts`），不是创建者指?- `Task.modelId` ?**ModelPolicy** 决定（`quota/policy.ts evaluatePolicy`?- **Agent 不得自由选择任意 Model?* spawn 前必须过 `evaluateSpawnGate`?- `allowedSubagents` 是白名单，不是黑名单?
**"为什么这?Agent 被选中"必须可解?* ??§19?
---

## 19. Observability

### 19.1 Dashboard 需要的字段（由 Codex 消费，本轮不实现 UI?
```text
Task Tree        父子关系 + ?Agent Tree       ?spawn 了谁 + 为什么被选中
Model            agent ?model 实际绑定
Status           task ?+ 状态变更时间线
Tokens           per-task / roll-up
Budget           reserved / consumed / released
Quota            真实探测值（?demo?Workspace        路径 + branch + baseSha + 是否干净
Messages         typed message ?Artifacts        产物清单
Retry            retry / rework / replan 分别计数
Review           pass / rework / fail + 理由
Blocker          阻塞原因 + 等待什?```

### 19.2 特别要求：为什么这?Agent 被选中

必须能回答并展示?
```text
agent=codex
  reason: capability{review} ?policy allows review ?          only agent with review capability ?budget ok
  alternatives rejected:
    opencode  ?capability-missing(review)
    cline     ?model-unavailable
```

**理由**：Multi-Agent 的成本不只在 token，还?*可解?*。一个无法解释的
调度决策，在排障时和随机行为没有区别。这直接对应 §12 ?demo input 问题 ?gate 输入全是硬编码，就无法解释为什么放?
---

## 20. Persistence

### 20.1 MVP 必做

```text
Task state        ?+ 时间?child relationship parentTaskId
status             每次变更
artifact refs      产物路径
```

**实现**：`orchestration/task-store.ts`，照 `pi-subagents/schedule-store.ts` ?`PID ??重读 ???temp+rename 原子写`（MIT）。我们已?`runtime/store.ts`
?`writeAtomic`?*复用**?
**不引入数据库、不引入 workflow engine?* 一?json store 就够?
### 20.2 Future（不?MVP?
```text
durable event log    每个状态迁移一条不可变事件
checkpoint           周期性快照，加速恢?restart recovery     完整 reconcile
```

### 20.3 恢复顺序

```text
1. ?store
2. reconcile：running 但进程不??failed/retry
3. 释放悬挂 reservation?3.1?4. 重新计算 ready queue（拓扑）
5. 继续调度
```

**重启后不?Hindsight 恢复 task ?* ?memory 是可能过时的事实?task state 必须精确?
---

## 21. Security

### 21.1 Child 权限 ?Parent

```text
permission(child) ?permission(parent)
```

**逐项**?
| 维度 | 规则 |
|---|---|
| filesystem scope | child 只能?*自己?workspace**?1.1 worktree）内写；父的 cwd 之外禁止写；路径逃逸检查见 §21.3 |
| network | ?parent 相同或更严；**不得**放宽 |
| secrets | child **不继?* parent ?credential 注入，除非显式声?|
| destructive action | child 的删?破坏操作需更高确认级别 |
| merge | child **不得**直接 merge 到主分支（需 reviewer 批准?|
| publish | child **不得**push / publish / ?PR（需 Root 显式授权?|

**`allowedSubagents` 白名?*是第一道闸；上面的逐项是第二道?
### 21.2 Memory 安全边界必须保留

4M-9 ?§6 全部适用：envelope 物理不可逃逸、`executableInstruction` ?false?`allowedAsEvidence` ?confidence 推导?
**5B 的新增考虑**：child agent ?prompt 也会包含 memory?*memory 内容不得
成为 child 的指?*。特别是 `artifact_ready` 携带的文件内??它同样按
untrusted data 处理?
### 21.3 Workspace 是安全边界，不只是隔?
`§11.1` ?worktree 隔离让两?worker 无法互相破坏?*但只有路径隔离是不够?*?child 仍可能写自己 worktree 之外的绝对路?C 必须?*路径逃逸检?*
（照 Symphony `workspace.ex` ?path safety validation?
---

## 22. MVP limits

```text
maxDepth            = 1        （硬编码；child 不能 spawn?maxChildren         = 3        （Root 最?3 ?child? worker + 1 reviewer?maxConcurrentAgents = 2        （并发上限）
maxTasks            = 20       （单次运行的 task 总数上限?maxDepthHardReject  = true     （深度违规硬拒绝，不降级?```

**全部是代码强制，不是可绕过配?* 这是?`pi-subagents/workflow/runtime.ts` ?`WORKFLOW_*_CAP` 借来的原??脚本没有任何绕过上限的通路"?
### 22.1 Workspace 能力门槛

?**§11.1**。摘要：

```text
Worker A ?worktree A     ?必须，一 worker 一 worktree
Worker B ?worktree B     ?A ─┬→ same checkout        禁止
B ─?```

不支持安?worktree ?agent?*禁止参与并行写代码任?*；只允许
read-only research / review / analysis?C 必须?spawn 时检?`descriptor.supportsWorktreeIsolation`，false 则只?`readonly` 任务类型?
---

## 23. Future limits（不?MVP?
| ?| 说明 |
|---|---|
| 嵌套 depth > 1 | MVP 硬拒 |
| 动态脚本编?| 不做 workflow engine |
| 自动 task decomposition | 显式声明依赖 |
| 多机 / 远程 worker | 单机 |
| 自建 truth engine | 4M-9 §7.3 |
| 自建 dedup engine | 4M-9 §7.3 |
| 自动 fact arbitration | 4M-9 §7.2 |

---

## 24. Explicit non-goals

| Non-goal |
|---|
| 不替换现?Runtime |
| 不新增第二条执行路径（`Orchestrator.run` 是唯一入口?|
| 不实现通用 workflow engine |
| 不实现自?task decomposition |
| 不实现自?agent chat |
| 不实现兄?agent ?transcript 共享 |
| 不引入数据库 / Temporal / workflow engine |
| 不修?`src/quota` 契约 |
| 不修?`src/adapters` |
| 不修?`src/runtime` |
| 不让 Multi-Agent 默认开?|
| 不让 Hindsight 承担 task state |
| 不让 Agent ?Model |
| 不让 child 权限超过 parent |
| 不在 5B 实现任何代码 |

---

## 25. Files that would be created / modified in 5C

### 25.1 新建（`src/orchestration/`?6 个文件）

| 文件 | 来源 | 方式 | 行数量级 |
|---|---|---|---|
| `types.ts` | ?| new | ~200 |
| `task.ts` | Symphony SPEC | new | ~150 |
| `dag.ts` | `agent-framework/_validation.py` | **reference**，TS 重写 | ~180 |
| `scheduler.ts` | Symphony `SPEC.md` + `orchestrator.ex` | **adapt** | ~350 |
| `reconcile.ts` | Symphony `orchestrator.ex` | **adapt** | ~200 |
| `retry.ts` | Symphony + fifony `retry.ts` | **adapt** | ~120 |
| `spawn-policy.ts` | `pi-subagents/nested-tools.ts` | **adapt** | ~150 |
| `spawn-gate-input.ts` | ?| **new**?2.2 修复 demo input?| ~120 |
| `concurrency.ts` | `pi-subagents/agent-manager.ts` | **extract** 思想 | ~150 |
| `limits.ts` | `pi-subagents/workflow/runtime.ts` | **extract** 上限模型 | ~60 |
| `worktree.ts` | `pi-subagents/worktree.ts` | **adapt** | ~300 |
| `workspace.ts` | Symphony `workspace.ex` | **adapt** | ~200 |
| `messages.ts` | `pi-subagents/cross-extension-rpc.ts` | **reference** | ~200 |
| `task-store.ts` | `pi-subagents/schedule-store.ts` | **adapt** | ~250 |
| `usage-rollup.ts` | `pi-subagents/usage.ts` | **extract** | ~80 |
| `agent-select.ts` | fifony `adapters/registry.ts` | **reference** | ~150 |

### 25.2 新建（测试）

```text
tests/orchestration.test.ts       ~600 ?```

### 25.3 修改（最小面?
| 文件 | 改什?| 为什么必?|
|---|---|---|
| `src/quota/index.ts` | `spawnGate` ?demo input ?真实来源?2.2?| 唯一?gate 真正生效的改?|
| `src/orchestrator/orchestrator.ts` | 可能需要一?`spawnChild()` 薄封?| 复用而非绕过 `run()` |
| `src/cli/*` | 新增 `multi-agent` 子命?| 用户入口 |

**明确不修?*：`src/runtime/*`（除上述薄封装）、`src/adapters/*`?`src/core/*` ?`RunResult`/`EventHub` 契约、`src/decision/*`、`src/memory/*`?`temporary-dashboard/*`（由 Codex 更新?
### 25.4 5C 的净增规模估?
```text
新建 orchestration    ~2400 行（含注?文档?新建测试               ~600 ?修改现有               <100 行，且不触碰 sealed 契约
```

**执行路径零改?* ?5C 的全部新增都?决定跑什?，不?怎么??
---

## 26. Phase 5C-1 Implementation Boundary

```text
Phase 5C-1 = Multi-Agent Orchestration Foundation
Status     = IMPLEMENTED · 228 tests · Foundation only, NOT a scheduler
```

本节记录 5C-1 **实际做了什?*，以及刻意没做什么。它是规范性边界，不是进度汇报?
### 26.1 Implemented

| 模块 | 文件 | 行数量级 | 关键内容 |
|---|---|---|---|
| Task model | `src/orchestration/task.ts` | ~280 | 11 状态、转移表、依赖校验、环检?|
| Task store | `src/orchestration/store.ts` | ~210 | **唯一 task 状态权?*（Symphony 原则?|
| 真实 gate 接线 | `src/orchestration/spawn-gate-input.ts` | ~360 | 7 个信号解析器 + `buildSpawnGateInput` |
| RunResult 翻译 | `src/orchestration/translate.ts` | ~110 | 成功 ?`to_verify`?*绝不** `succeeded` |
| Root→Child 编排 | `src/orchestration/orchestrator.ts` | ~290 | `spawnChildTask`、生命周期、取消传?|
| 公共出口 | `src/orchestration/index.ts` | ~70 | 只导出已实现且已测试的东?|
| 测试 | `tests/orchestration.test.ts` | ~740 | 228 条，全部 hermetic |

**5C-1 修掉?Phase 4 demo input**（`src/quota/index.ts`? 个字段全改为真实来源）：

```text
taskPolicyAllows  true  ?registry.list().some(e => e.taskTypes.length > 0)
capabilitySatisfied true ?descriptors.some(d => d.capabilities.newTask)
agentAvailable    true  ?installed 中存?confirmed true?Unknown' 不算?modelAvailable    true  ?registry 中存?availability === 'available'
quota.status      available ?worstQuotaStatus(records)  真实最?budget.remaining  100   ?budgets.global.remaining()     真实余额
budget.requested  10    ?remaining + 1                  不会静默通过
concurrency       0/4   ?0/0                            视图无编排上下文，不假装有额?```

`spawn-gate.ts` / `types.ts` / `budget.ts` / `policy.ts` / `registry.ts` **全部未改**
（时间戳仍为 09-29 12:xx）。只改了组装输入?`index.ts`?
### 26.2 核心规则：缺失信??允许

这是 5C-1 最重要的一条，实现?`spawn-gate-input.ts`?
```text
quota 记录不存?     ?quota.status = 'unknown'   ?gate denied
model 未选择           ?modelAvailable = false      ?记为 missing signal
model availability=unknown ?不算 available        ?gate denied
agent installed=Unknown  ?不算 installed          ?记为 indeterminate
descriptor 不存?      ?capabilitySatisfied=false ?记为 missing
budget 任一 scope 缺失  ?整个 budget 判定?unavailable ?denied
concurrency 上限非法    ?记为 invalid signal        ?denied
```

`missing` 数组会随拒绝一起返回，所?这是预算问题还是数据问题"一眼可?
**特别说明 budget**? 要求"如果现有 ledger 只能提供?scope，先明确返回 denied"?实现?*任何** scope 缺失都拒??不在"恰好存在的那几个"上做判定?理由：`BudgetManager` 构造时总是创建 `global`，所?全部缺失"实际不可达，
真实情况永远?*部分覆盖**，那正是需要拒绝的场景?
### 26.3 Reused source ?adaptation

| 上游 | 复用了什?| 为什么只?adapt |
|---|---|---|
| `pi-subagents/nested-tools.ts` (MIT) | `maxSubagentDepth` 硬拒?+ 拒绝时给出可操作原因 | 它绑 pi tool-call 协议；我们改为在 task 创建时判?|
| `pi-subagents/abortable.ts` + `status-note.ts` (MIT) | "有界的结?思想：bounded partial result 而非假装完整 | 我们?`RunResult` 已由 runtime 有界化，?*?*?|
| `pi-subagents/schedule-store.ts` (MIT) | PID ?+ 原子写的**模式** | 5C-1 store 在内存中；我们复?`runtime/store.ts` ?`writeAtomic`（持久化?5C-2+?|
| `symphony/orchestrator.ex` (Apache-2.0) | **单一权威 orchestrator state** | 采纳为设计原则，非代?|
| `symphony/workspace.ex` (Apache-2.0) | 路径逃逸校?| 本轮?workspace，故未实?|
| `agent-framework/_validation.py` (MIT) | `validate_workflow_graph` 的环检测算?| Python ?TS 重写?C-1 只做"明显?检?|
| `fifony/agents/parallel-executor.ts` (Apache-2.0) | 每子任务独立 sub-worktree、fanout 上限 | 依赖 worktree，本轮不?|

**未复用的上游**：`pi-subagents/agent-manager.ts` 的双并发池（5C-1 只做单计数器?接口已按可扩展设计）、`workflow/runtime.ts` ?`WORKFLOW_*_CAP`（上限值本轮直接硬编码?
### 26.4 Deferred（明确不?5C-1?
| 延后?| ?| 说明 |
|---|---|---|
| 完整 DAG scheduler | 延后 | 5C-1 只有依赖**校验**，无拓扑排序与并行规?|
| worktree / workspace | 延后 | §11.1 架构已定，代码未?|
| Agent communication bus | 延后 | §10 消息类型已定，无实现 |
| multi-agent review loop | 延后 | `rework` 是保留状态；`applyVerification` ?rework 返回 `rework-not-implemented` ?*不假装成?* |
| durable recovery / reconcile | 延后 | store 纯内?|
| budget reservation lifecycle | 延后 | §13.1 六项全部未实现，5C-1 ?*?* ledger |
| 递归 nested spawn | 禁止 | `maxDepth=1` 硬拒?|
| 自动 task decomposition | 禁止 | 依赖必须显式声明 |
| 进程回收 | 不归本层 | 仍是 `runtime/spawn.ts` ?`taskkillTree` |

### 26.5 三个在实现中发现并修掉的真问?
1. **`spawnChild` 漏传 `taskType`**（生?bug）：gate 用的?`sources.taskType`?   于是 review child 被当?implementation 判定。后果是 Codex（只注册 review?   被拒?opencode 反而可能混?reviewer 槽位 ?正好破坏 Phase 4 确立?   review 独立性。已改为?**request 为准**并加测试?2. **?budget 会创?budget**：`BudgetManager.task()`/`.agent()` ?`getOrCreate`?   原实?先取 ledger 再判断存?，把缺失 scope 变成 allocated=0 的真?scope?   正是本轮要消灭的"缺失读成 0"。已改为**?snapshot 再取**?3. **重复 id 被报?子任务过?**：检查顺序让调用方去找错地方。已?id 重复检查前?
### 26.6 Codex Gate Critical 修复?C-1 Fix?
Codex Gate 判定 `NEEDS FIXES`，唯一 Critical?
> `buildSpawnGateInput()` ?budget scope 缺失?`requestedUnits <= 0` 时返?`allowed=true`?
**根因**（已独立复现）：

```text
budget scope 缺失 ?remaining: 0, requested: 0
evaluateSpawnGate 只判?requested > remaining
0 > 0 ?false ?allowed = true
```

`Orchestrator.spawnChild()` 随之 `ok=true` 并创建了 child task?
**修复 ?方案 A（short-circuit?*?
1. `resolveRequestedUnits()` 独立校验请求额：`undefined` / `NaN` / `±Infinity` / 负数
   全部记为 `invalid-budget-request` 并拒?2. budget scope 不可用时，请求额?**floor ?1**，使 `requested > remaining` 只可能失?   ??*构造出?input 本身**也无法通过比较（纵深防御）?3. 最?verdict ?`buildSpawnGateInput` **在此处直接产?* `allowed=false`?   理由写明 `budget-scope-unavailable` / `invalid-budget-request`?   而非?Phase 4 的数值比较去报告一个普?额度不足"?
**为什么是方案 A 而不是改 gate**：`src/quota/spawn-gate.ts` 比较的是两个数字??API **无法表达"没有数字可比"**。已通过源码核验；该文件**未修?*?`budget-scope-unavailable` 也不?`GATE_DENY_CODES` 内（`types.ts` 已封存）?所以精?code 落在 `missing[].code` ?reason 中，gate code ?`budget-insufficient`?
**更基础的拒绝优?*：若 gate 更早?multi-agent / policy / capability / agent /
model / quota 拒绝，则**保留那条更根本的理由**，预算问题仍?`missing` 中列?
**修复后实?*?
```text
scope 缺失:  req=0 / -5 / undefined / NaN / Infinity  ? 全部 allowed=false
              reason = "budget-scope-unavailable: ..."
scope 存在:  req=0 ?allowed=true    req=1 ?allowed=true
              req=1000000 ?allowed=false (budget-insufficient，真实额度不?
multi-agent 关闭 + scope 缺失 ?code = multi-agent-not-implemented（未覆盖?```

### 26.7 `SpawnChildRequest.budgetUnits` 已接?gate

**修复?*：`budgetUnits` 只写?`TaskSpec`，gate 用的是静态的
`sources.requestedUnits` ?所?child 共用一个数字。后果：请求 1 unit ?child
可能被一个为 1000000 准备的预算放行，反之亦然?
**修复?*?
```text
SpawnChildRequest.budgetUnits  ? BuildSpawnGateInput.requestedUnits
                              ? SpawnGateInput.budget.requested
```

`BuildSpawnGateInput.requestedUnits` ?*键是否存?*判断：显式传入（包括
`undefined`）视为调用方 bug 并拒绝；完全省略该键才回落到 `sources` 默认?
### 26.8 Regression tests

新增 **51 ?*?28 ?279），覆盖 gate 报告要求的全部用例：

| 用例 | 断言 |
|---|---|
| T1 missing budget + request 0 | `allowed=false`；reason ?`budget-scope-unavailable`；`input` 本身也无法通过比较 |
| T2 missing budget + request -5 | `allowed=false`；负数单独被 `invalid-budget-request` 拒绝 |
| T2 请求额校?| `undefined` / `NaN` / `±Infinity` / `-1` 全部拒绝；`0` 与正数接?|
| T3 existing budget + request 0 | `allowed=true`；与 T1 **结论相反**，证明二者未被混?|
| T4 request budgetUnits=1 | `SpawnGateInput.budget.requested === 1`，且覆盖 sources 默认?|
| T5 request 1000000 | `budget-insufficient`，且不被静态值覆盖；理由**不是** scope 缺失 |
| T6 taskType 路由 | review child 仍按 review 判定；codex ?implementation 仍被拒（`task-policy-denied`?|
| E2E | ?budget ?`ok=false` ?*不创?task**；有?budget ?task `planned`；不执行任何 Agent |

### 26.9 Future 5C stages

```text
5C-2  scheduler / DAG / workspace / worktree / messages / durable store
5C-3  review loop / rework / retry / reconcile
5D+   Multi-Agent runtime integration（另开任务 + 独立 Codex Gate?```

### 26.10 本轮未修?
`src/quota/{spawn-gate,budget,policy,registry,types}.ts` 全部未改?`src/{runtime,adapters,memory,decision,core}/` 零改动；`temporary-dashboard/`
零改动（01:08 ?dashboard 写入来自 Codex Review，非本轮?仅修?`src/orchestration/{spawn-gate-input,orchestrator,index}.ts`
?`tests/orchestration.test.ts`?
### 26.11 Phase 5C-2 Scope（Execution Bridge?
```text
Phase 5C-2 = planned child task ?real Native Agent run ?RunResult ?task lifecycle
Status     = IMPLEMENTED · 407 orchestration tests?C-1 ?279 全部继续通过?```

5C-1 创建?task 但不执行?C-2 接上执行闭环?*仅此一件事**?`executeTask(taskId)` 把一个已存在?child 交给**现有** Runtime 执行，并?`RunResult` 正确回写?Task lifecycle?
**明确不是**：scheduler、DAG executor、worktree、communication bus、review loop?retry/replan、自动分解、并行策略。全部留?5C-3+?
### 26.12 Task ?RunRequest 真实映射

```text
Task.agentId              ?RunRequest.agentId        （绝不默认覆盖）
Task.taskType === 'review'?RunRequest.mode = 'review'   （Codex 原生 review 入口?其他 taskType              ?RunRequest.mode = 'default'
Task.acceptanceCriteria   ?RunRequest.prompt        （逐字包含，便于后?verify?Task.modelId              ?RunRequest.model         （为 null ?*省略该键**?（无?                   ?RunRequest.threadId      （resume 属后续）
调用方提?                ?RunRequest.cwd           （见 26.14?```

**两条载荷规则**?
1. `agentId` 取自 task?*不做默认替换**?C-1 ?gate 批准了哪?agent，执行时就用
   哪个；改成配置默认值等于让 task 跑在没人检查过?agent ??正是 Phase 4
   review 独立性要防的?2. `modelId` ?`null` ?*省略字段**而非?`null`，让 `Orchestrator.run` ?   `req.model ?? cfg.model` 继续生效?C-2 **不重新设?* Agent→Model policy?
prompt 结构：`Task <id> (<taskType>)` + `Work:` + acceptance criteria
+ （有则）`Depends on:` + （有则）产物**路径引用**。产物只给路径，不内联内?
### 26.13 Runtime 接线位置

```text
Orchestration.Orchestrator.executeTask()
    ? buildRunRequest()                     ?纯函数，产出 RunRequest
    ? this.runtime.run(request)             ?RuntimeRunner：唯一的接?Orchestrator.run()  (src/orchestrator/，未改一?
    ?AgentSession ?Adapter ?Transport ?原生进程
```

`RuntimeRunner` 只有 `run(req): RunHandle` 一个方法，真实?`src/orchestrator.Orchestrator` **结构上直接满?*??这就?5C-2
**零修?* `src/orchestrator/` ?`src/runtime/` 的原因。我们依赖它们的**形状**?不是它们的副?
测试同理真实：`executeTask` 驱动的是真的 `RuntimeOrchestrator` + `AgentSession`
+ terminal policy，只有子进程?`FakeTransport` 脚本?
### 26.14 Cancellation 边界

```text
queued 任务 cancel  ?store 内取消，**不启动任?agent**，不委派 runtime
running 任务 cancel ?handle.cancel() 委派现有 runtime
                      ?进程终止 / Windows 进程树回?*全部**?runtime 负责
root cancel         ?传播到整个子树（Phase 5B §15 语义保持??child cancel     ?只影响该叶子，不级联
```

本层**?kill 任何进程**、不实现进程树清理、不重复 Runtime 的取消逻辑?5C-2 的测试用 `assert` 检?orchestration 源码中不存在
`child_process` / `spawn(` / `kill` 等字?
### 26.15 Verification 边界（未改变?
```text
RunResult.succeeded  ?to_verify      （绝?running ?succeeded?to_verify            ?applyVerification('pass') ?succeeded
applyVerification('rework')  ?仍返?rework-not-implemented（诚实不伪造）
```

`running ?succeeded` 在转移表?*不存?*。runtime 抛异常、exit code ?0?`result()` reject ?三种都真实映射为 `failed` 并保留原?message?
### 26.16 Gate 在执行时**重跑**

5C-1 ?gate 跑在 spawn?C-2 ?execute **重跑同一个纯函数 gate**，因为：

- 钱是在 execute 时花的，不是 spawn 时；
- budget / quota / concurrency 都可能在排队期间变化 ?被两?sibling 挡在
  队列里的 child，到执行时可能已经放不进并发上限?- 被拒绝的执行**保持 `planned`**，不会被改写?`failed` ?那是预算问题，不?  task 坏了。测试验证了「撤回预??拒绝 ?恢复预算 ?同一?task 成功执行?
### 26.17 实现中发现并修掉的问?
1. **`executeTask` 对已 `queued` ?task 会做 `queued ?queued`**，被转移表拒??   一个完全合法的重新执行请求会失败。已改为条件入队?2. **`cancelTask` 只取消单?task**，破坏了 5B §15 ?root 传播语义。已改为遍历
   子树，且子树中任?running ?task ?*?*委派 runtime 再改 store?3. **测试用假 agent id `opencode` 会真的启动原生二进制**：`extraAdapters` 排在
   工厂?*之后**，不覆盖内置 adapter。写?`fake-*` 才不可能碰撞。这一点在?   测试时真的发生了一次（真实原生进程打到了本?model server 并失败）?
### 26.18 本轮明确未实?
| 未实?| 归属 |
|---|---|
| worktree / workspace 隔离 | 5C-3+。`executeTask` 要求显式 `cwd`?*不假?*有隔?|
| 并发调度?/ worker pool / 拓扑排序 | 5C-3+ |
| retry / rework loop / replan | 5C-3+（`rework` 仍诚实报 not-implemented?|
| 自动 review orchestration | 5C-3+ |
| communication bus / typed messages | 5C-3+ |
| durable store / reconcile / crash recovery | 5C-3+ |
| budget reservation TTL / ?scope 预留 | 5C-3+ |
| Hindsight 参与 | **不做** ?4M-9 已冻结，memory 不是 task state |
| 新增 Agent | **不做** |

### 26.19 5C-2 已知限制

1. **cwd 由调用方提供，无 worktree 隔离**。两?child 若传同一?cwd 就会共享
   同一?checkout?B §9 要求「不支持 worktree ?agent 禁止参与并行写代码」，
   5C-2 **无法执行这条** ?它需?worktree 实现。调用方必须自己保证?2. **没有并行执行原语**。`executeTask` 一次一个；并发上限只作?gate 拒绝条件
   存在，不存在调度器去填坑?3. **重启后无法取消在?run**：`liveHandles` 是内存的。进程重启后 in-flight ?   任务没有 handle?C-1 ?durable store 尚未实现?4. **不消?`Task.artifacts`** ?本轮只写入产物引用（`addArtifact`），
   收集与校验产物属后续?
### 26.20 5C-2 未修?
`src/orchestrator/`? 行）、`src/runtime/`、`src/adapters/`、`src/core/`?`src/memory/`、`src/decision/`、`src/quota/{spawn-gate,budget,policy,registry,types}.ts`
全部未改；`temporary-dashboard/` 未改?新增?`src/orchestration/execute.ts`，修?`orchestrator.ts` / `index.ts` 与测?
### 26.21 Execute-time concurrency accounting?C-2 Fix?
**规则（明确）**?
> 执行准入?`currentConcurrency` 表示**当前已占?execution slot 的其?child**?> **不包?*当前正在准入的这?task?
**?bug**：`executeTask` ?`liveChildren()` ?gate，而被执行?task 此时仍是
`planned`/`queued`，因?*把自己算了进?*。后果：

```text
maxConcurrency=1 + 单个 child ?1 >= 1 ?永远 concurrency-limit ?0 run
maxConcurrency=2              ?实际只能并发 1 ?```

这是**保守拒绝**而非安全漏洞（不会多放行），但它会污?5C-3 scheduler 继承?并发语义?
**修法（方?A，按 id 排除而非?1?*：新?`liveChildrenExcluding(taskId)`?execute 时用它，spawn 时仍?`liveChildren()`?
?A 而不?B（只统计 running/handle）的原因?*B 会改?5C-1 既定语义**?5C-1 锁定了「非?child 计入 outstanding」，并有测试断言 `maxConcurrency=1`
时第二个 spawn 被拒。改成只?running 会让那个测试失效 ?那已超出
"minimal fix" 范围。按 id 排除而非?1，保证不可能出现负数，也不会因计数规?变化而漂?
**计数仍来?TaskStore**，没有第二套 state authority；`liveHandles` 未参与计?
**回归结果**?
| 场景 | 结果 |
|---|---|
| `maxConcurrency=1` + ?child | **ADMITTED**（此前永远拒绝），真?run，→ `to_verify` |
| `maxConcurrency=1` + A running + B execute | B ?`concurrency-limit` 拒绝，B 保持 `planned` 未变 failed，A 不受影响 |
| `maxConcurrency=2` + A running + B execute | B **被准?*，两?native run 并存 |
| running A ?`executeTask(A)` | `task-not-executable`?*未启动第二个 native process** |
| A 终结后执?B | 槽位释放，B 可执行（计数不是 high-water mark?|

**注意 spawn 侧语义未?*：`maxConcurrency=1` 时第二个 child ?**spawn 阶段**
就被拒（outstanding 计数），这与 execute 阶段?排除自身"是两件事?
---

## 26.22 Phase 5C-3 Scope（Bounded Task Scheduler?
```text
Phase 5C-3 = spawn ?planned ?scheduler.tick() ?bounded admission ?executeTask
Status     = IMPLEMENTED · 546 orchestration tests?C-1/5C-2 ?438 全部继续通过?productionCaller = OrchestrationController  （不再是 NONE?```

5C-2 ?`executeTask()` 能真实驱?Runtime，但**没有人调用它** ?这正?`productionCaller = NONE` 的根?C-3 补上这段：orchestration 自己拥有一?**最小的** Scheduler，从 queued/planned child 中确定性地挑选并在并发上限内准入?
### 26.23 Scheduler 职责（只有这些）

```text
1. 找到当前可调度的 child
2. 判断 dependency 是否满足
3. ?ready ?task ?planned 推进?queued
4. 调用已有 executeTask()   ?唯一执行入口，gate 在其中重?5. ?task 结束后，下一?tick 重新发现容量
```

**明确不做**：Agent Adapter、Runtime process handling、prompt 生成、预算实?Memory、review policy、retry、replan。Scheduler **没有任何 Runtime 句柄**?只有 `Orchestrator` 引用；进程相关的全部仍在既有 Runtime ?
### 26.24 Scheduler API

```ts
class TaskScheduler {
  tick(): Promise<TickResult>          // 主接口，deterministic
  start(): SchedulerStatus             // 可选极?auto-loop，需 autoTickMs
  stop(): SchedulerStatus              // 停止调度新任务，不杀 running
  status(): SchedulerStatus
  occupiedSlots(): number              // ?TaskStore 派生，非自持计数?  cancel(taskId, reason)               // 委派既有 RunHandle.cancel()
}
```

`tick()` 是主接口：默认没?timer，测试完全不依赖 wall-clock。`start()` 需要显?`autoTickMs`，且 re-entrant tick 会被拒绝而非堆叠；timer ?`unref`，不会吊住进?
### 26.25 Queue / selection 规则

?= `depth > 0` ?status ?{`planned`, `queued`}（可选按 `rootTaskId` 限定一棵树?
排序 = **创建顺序**（`createdAt` ?`order` ?`taskId` 稳定 tiebreak?相同输入必得相同选择。无 weighted priority、无 agent preference??cost-aware priority、无 LLM 调度?
### 26.26 Bounded concurrency

```text
occupiedSlots() = TaskStore ?status === 'running' ?child 数（每次重新派生?capacity        = gate.maxConcurrency - occupiedSlots()
```

- **没有第三套计数器**：`occupiedSlots()` 每次?TaskStore 现算?- 槽位上限读的?**`gate.maxConcurrency`** ??`executeTask` 真正会执行的那个数字?  实现中曾误读 5C-1 ?`limits.maxConcurrentChildren`（恒?2），那会?scheduler
  按一个数字组窗口?gate 按另一个数字裁决；已改为单一来源 `getConcurrencyLimit()`?- `planned` / `queued` 不占 execution slot；`to_verify` 也不?  terminal（`succeeded`/`failed`/`cancelled`）自然释放，?high-water mark?
**一个必须如实记录的限制**：`maxConcurrency` 同时?**spawn 时的 outstanding 上限**
?C-1 封存语义，本次未改）。因此：

```text
maxConcurrency = 2 ?最多只能存?2 个非?child
```

所以「cap=2 ?A/B 运行、C 排队等待」这一?*在本轮无法出?* ?C ?spawn
阶段就被拒。要看到三任务调度需 cap=3?0 的三任务用例因此?cap=3 呈现?并在测试中显式断言 cap=1/2 ?outstanding 边界?*没有为了让示例成立而改动封存语?*

### 26.27 Dependency handling

- 依赖满足：只?`succeeded` 满足依赖?- 依赖未满足：task 保持 `planned`，tick 记为 `dependency-unmet` skip?*不启?*?- **成功?RUN 不满足依?*：`to_verify` 仍不算满??必须?  `applyVerification('pass')`。测试专门锁定了这一?- 依赖 `failed` / `cancelled`?*不发?failure propagation**。dependant 继续等待
  （`dependency-unmet`）。按 5B，unmet 就是 "not ready"，擅自实现失败传播属未请求的策略?
**一处必要的 opt-in**?C-1 ?`spawnChild` 拒绝未满足依赖（有已评审测试??scheduler 场景?dependant 必须**先存?*才能被后续调度，否则 A 完成后无可调?因此新增显式 `SpawnChildRequest.allowUnmetDependencies`（默?`false`）：

- 默认行为 = 5C-1 原样，已评审语义不变?- scheduler 路径显式开启，**取舍在调用点可见**，而不是静默改掉被评审的行?- 结构错误（unknown / self / duplicate / parent cycle）在两种模式下都拒绝?
### 26.28 Gate 在准入时重跑

Scheduler **不缓存任?gate verdict**。准入决策发生在 `executeTask()` 内部?读取当下?budget / quota / model / agent / capability / policy / concurrency?
已测：六个信号分别在 **spawn 成功之后**被改动（`updateGateSources`），随后 tick
全部 `admitted=0`、`no native run`、task 保持 `planned`（不改写?`failed`?另测 budget 撤回后同一 task 恢复预算即可执行 ?说明拒绝源于信号而非 task 损坏?
### 26.29 stop / cancellation

```text
stop()      ?只停止调度新任务；running child 继续跑到真实终态（不自?cancel?cancel(id)  ?委派 cancelTask() ?既有 RunHandle.cancel()；本层不 kill 任何进程
```

不因?scheduler 而杀进程是更安全的选择。`start()` 未给 `autoTickMs` ?*拒绝**?而不是自造一?timer?
### 26.30 Production caller

`src/orchestration/controller.ts` ?`OrchestrationController`?
```ts
await controller.run(root, children)   // ?root ?逐个 spawn ?首次 tick
controller.tick()                     // 继续推进
controller.cancel(id, reason)
```

这不是 CLI 产品：没有命令行、没有配置文件、没有 daemon、没有新 agent。它是「未来 CLI / runtime 接线会调用的程序化入口」，并证明生产链路成立
**真实 smoke（非测试文件，scripted native process + 真实 `Orchestrator.run()`?*?
```text
runtime invoked via real Orchestrator.run : 2
w1 / w2 status                            : to_verify / to_verify
budget global reserved / consumed         : 0 / 0   ?gate 只是准入，不是预?w1 after explicit verification            : succeeded
second tick admitted                      : []
production caller                         : OrchestrationController (src/)
```

### 26.31 5C-3 明确未实?
| 未实?| ?|
|---|---|
| worktree / workspace 隔离 | **未实?*；两?child 共享同一 cwd?*并行写代码仍不安?* |
| retry / rework loop / replan | **未实?*；`failed` 保持 failed，不自动重试或补?|
| automatic review | **未实?*；`to_verify` 只能?`applyVerification(pass)` 结束 |
| reservation TTL / consume / 预算分配 | **未实?*；Gate = admission check，ledger 保持 0/0 |
| durable scheduler state | **未实?*；TaskStore 纯内存，重启丢在途任?|
| dependency failure propagation | **未实?*（刻意） |
| auto-loop daemon | 只有可选极?`start()`，非 daemon |
| CLI product / Dashboard / ?Agent | **未做** |

### 26.32 5C-3 剩余限制

1. **?worktree ?并行写代码不安全**。Scheduler 能同时运行两?child，但这只?   read-only / 独立目录安全；两?child 写同一 checkout 仍会互相破坏?   **不得**据此宣称已具备安全的 parallel code-edit isolation?2. **`maxConcurrency` 双重身份**：既?outstanding 上限也是并发上限，故队列深度
   恒等于并发上限（§26.26）。若 5C-4 需要真正的「大量排队、少量并发」，
   必须重新审视 spawn 侧记??那需要独立评?3. **无持久化**：重启后 TaskStore 为空，在?run ?handle 丢失，无法取消或恢复?4. **auto-loop 未在测试覆盖**：为避免 wall-clock 依赖，`start()` 只测了拒绝路径；
   实际循环行为需人工验证?5. **dependency 等待可能永久挂起**：upstream `failed` ?dependant 永远等待
   （无 failure propagation），需要人工介入。这是有意的诚实行为，不?bug?
---

## 26.33 Phase 5C-4 Scope（Orchestration Semantics Hardening?
```text
Phase 5C-4 = maxChildren ?maxConcurrentAgents
             + dependency enforcement at the execution authority
             + auto-loop as a validated thin trigger
Status     = IMPLEMENTED · 648 orchestration tests（此?546 全部继续通过?```

本轮只处?Codex 留下?3 ?Minor?*worktree 明确不做?*

### 26.34 maxChildren ?maxConcurrentAgents 的最终定?
?5B §22（`maxChildren = 3`、`maxConcurrentAgents = 2` 本就是两个概念）?
| 概念 | 定义 | 施加?| 读取?|
|---|---|---|---|
| `maxChildren` | 允许同时**存在**的非?child ?| spawn admission（outstanding?| `spawnChild()` ?`getChildLimit()` |
| `maxConcurrentAgents` | 允许同时 **running** ?child ?| execute admission（slots?| `executeTask()` / `Scheduler` ?`getConcurrencyLimit()` |

**旧文档矛盾表述已修正**?6.26 / §26.32.2 此前写着
「`maxConcurrency` 同时?outstanding 上限也是并发上限?那是 5C-3 ?*已知缺陷**?本轮已消除，不再是当前语?
**兼容?*：旧调用方只?`maxConcurrency` 时，**两个 cap 都回落为?*?5C-1/2/3 的既有行?*完全不变**?46 条旧测试未改动即通过即为证据?新增?`maxChildren` / `maxConcurrentAgents` 为可选字段，仅在显式给出时生?
**fail-closed**：`0` 合法（拒绝一切）；`undefined`（显式）/ `NaN` / `±Infinity` /
负数 / 小数一律记?`invalid-limit` missing signal ?denied。显式传 `undefined`
?*省略字段**?*键是否存?*区分，避免静默回落绕过限?
### 26.35 单一真相来源

```text
spawnChild()          ?liveChildren()            vs maxChildren
executeTask()         ?runningChildrenExcluding() vs maxConcurrentAgents
Scheduler.occupiedSlots() ?running child count (TaskStore 派生)
```

`spawnChild()` ?*每父?fan-out 检查也已改为读 `getChildLimit()`**?此前它硬?`limits.maxChildren`（恒?3），那正?§5 禁止的「四套数字」漂移：
调用方把 `maxChildren` 设成 10，仍会被一个没人告知的默认?3 拦住?
### 26.36 Spawn / Execute / Scheduler 各自用哪个限?
| 入口 | 计数 | 上限 |
|---|---|---|
| `spawnChild()` | `liveChildren()`（outstanding?| `maxChildren` |
| `executeTask()` | `runningChildrenExcluding(self)` | `maxConcurrentAgents` |
| `Scheduler.tick()` | `occupiedSlots()`（running?| `maxConcurrentAgents` |

**execute admission 的计数口径本轮改?*，这是拆分的必要条件?此前它数的是所有非?child，于?5 ?child + cap 2 时，第一?dispatch 看到
「另?4 个」而把自己拒掉 ?队列永远无法存在?execution slot ?**running** 任务占用；`planned` / `queued` 不占?
**5C-2 已验证行为全部保?*（并仍在测试中）：cap=1 + ?child 可执行；
cap=1 + A running 拒绝 B；cap=2 + A running 准入 B?
### 26.37 queue 可以真正大于 execution concurrency

```text
maxChildren=10, maxConcurrentAgents=2
spawn A/B/C/D/E   ?5 个全部存在（不被 execution cap 拦）
tick 1             ?A,B running；C,D,E 保持 planned
（完成一个后）tick 2 ?C running
```

真实 production smoke（非测试文件，真?`Orchestrator.run()`）：

```text
children created          : 3 / 3  (maxChildren=10)
outstanding children      : 3
tick 1 admitted           : ["A","B"] (maxConcurrentAgents=2)
C is waiting, not lost    : planned
tick 2 admitted           : ["C"]
runtime invocations total : 3
```

### 26.38 Dependency enforcement 收口?execution authority

`executeTask()` 在执行前?*?scheduler 同一?* helper
（`unmetDependencies(task, known)`）确认所?dependency `=== succeeded`?否则 `dependency-unmet` 拒绝?*不碰 Runtime**?
覆盖?upstream 状态：

| upstream | `executeTask(B)` |
|---|---|
| `planned` | denied |
| `running` | denied |
| `to_verify` | **denied** ?成功?RUN 不等?satisfied |
| `succeeded` | **allowed** |
| `failed` | denied，B 保持 `planned`?*未实?* failure propagation?|
| `cancelled` | denied，B 不被 cascade |

**单一语义来源**：scheduler ?`executeTask` 调用同一 helper；scheduler 的检查只
是「该派谁」的优化，安全性由 `executeTask` 保证。不存在两套 traversal?
### 26.39 allowUnmetDependencies 的准确语?
```text
allowUnmetDependencies (spawn)      默认 false
  ?只允许「task 可以先存?  ?结构错误仍全部拒绝：unknown / self / duplicate / parent cycle

allowUnmetDependenciesAtExecute     默认 false，显?opt-in
  ?只放?readiness，不放宽结构规则
```

**它绝不允许「task 可以执行?* ?默认情况下未满足 dependency ?task
即使被直接 `executeTask()` 也会被拒。escape hatch 仅供自行驱动依赖链的调用方使用
### 26.40 Auto-loop = tick 的薄 trigger

```text
tick()   = 唯一 authority，全部逻辑在此，可 deterministic 测试
timer    = ?trigger，每?fire 调用同一?tick()
```

- **默认不启?timer**；无 `autoTickMs` ?`start()` 抛错而非?timer?- `autoTickMs` 严格校验：`0` / 负数 / `NaN` / `±Infinity` 全部拒绝
  ? 或被强转?interval 会变?busy loop 或永不运行的静默 scheduler?- 重复 `start()` 不创建第二个 loop；`stop()` 清理 timer；`start→stop→start` 可再次工?- **stop 不取?running child**（停调度 ?杀进程），已测：running 状态与 slot 均保?- timer ?`unref`，不会吊住进?
### 26.41 Re-entrancy

`tick()` 在入口检?in-flight：第二次并发 tick 返回 `tick-in-progress`
?*不派发任?task**。因此两个并?loop 不可能同时观察到同一?`planned` task
并各启一?run。guard ?*派发**处而非 await 处，timer 连发不会堆叠?测试确认：重?tick `admitted=0`、native run 仍为 1、task 只有一?`running`?
### 26.42 Controller 保持?
`OrchestrationController` 未吸?dependency / concurrency / timer 逻辑
（有源码级断言：文件中不含 `unmetDependencies`、`maxConcurrency`、`maxChildren`?`setInterval`、`counter` 等）。它仍只?orchestration API 的转发层?
### 26.43 5C-4 明确未实?
| 未实?| ?|
|---|---|
| **worktree / workspace / branch 隔离** | **未做**；并行执??并行写代码隔?|
| reservation / TTL / consume / 预算分配 | 未做；Gate = admission observation |
| retry / rework / replan | 未做；`failed` 保持 failed |
| automatic review | 未做；`to_verify` 只能?`applyVerification(pass)` 结束 |
| durable scheduler state | 未做；TaskStore 纯内?|
| dependency failure propagation | 未做（刻意） |

### 26.44 5C-4 剩余限制

1. **?worktree ?并行写代码仍不安?*。`maxConcurrentAgents=2` 能同时跑两个
   child，但它们共享同一 cwd?*不得**据此宣称已具备安全的 parallel code-edit isolation?2. **`maxChildren` 仍是全局 outstanding 与每父级 fan-out 共用的一个数?*?   若需要「每父级 N、全局 M」两个不同的 fan-out 维度，需另行评审?3. **无持久化**：重启后 TaskStore 为空，在?run 无法取消或恢?4. **auto-loop 的定时精度依赖真?wall-clock**（测试用 20ms/10ms interval 并轮询等待）?   逻辑本身仍可完全通过 `tick()` 确定性测试，?*循环频率本身**未被确定性断言?5. **`to_verify` 不占 slot** 是有意设计（运行已结束，等的是人不是机器），
   但这意味着大量 `to_verify` 堆积时并发不受限 ?是否有界留给后续评审?
---

## 26.45 Phase 5C-5 Scope（Workspace / Worktree Isolation?
```text
Phase 5C-5 = Task ?Workspace Resolution ?isolated cwd ?RunRequest ?Runtime
Status     = IMPLEMENTED · 728 orchestration tests（此?648 全部继续通过?```

5C-4 留下的限?1 已解决。此?Scheduler 能并行执行两?child，但它们**共享同一?cwd** ?「并行执行」是真的，「并行写代码隔离」不是。两?child 在同一 checkout 写文?必然互相破坏?orchestration 层当时无法阻?
### 26.46 WorkspaceManager API

```ts
class WorkspaceManager {
  prepare({ taskId, mode, sharedCwd? }): Promise<WorkspaceHandle>  // 幂等
  get(taskId): WorkspaceHandle | null
  list(): WorkspaceHandle[]        // ?release ?  repoRootFor(dir): Promise<string | null>
  release(taskId, { force? }): Promise<{ removed, code, reason }>  // 唯一删除路径
}
```

`WorkspaceHandle` = `{ workspaceId, mode, taskId, cwd, branch, baseSha, repoRoot,
createdAt, released }`?
**两个 authority 分离**?）：`TaskStore` = Task State?`WorkspaceManager` = workspace 生命周期。worktree 路径**不进?* TaskStore 状态机?Task 通过 `taskId ?workspaceId` 关联?
### 26.47 isolated vs shared

| mode | 目录 | 默认适用 |
|---|---|---|
| `isolated` | 私有 `git worktree` | `taskType === 'implementation'` |
| `shared` | 显式指定的目?| `taskType === 'review'` |

`defaultWorkspaceMode(task)` 即上?*shared 不会被偷换成 isolated**?review task ?shared 时，目录必须显式存在，否?`workspace-path-missing` 拒绝?
### 26.48 接线：Task ?Workspace ?cwd

```text
executeTask(taskId)
  ?task lookup / status / dependency / gate
  ?WorkspaceManager.prepare(task)      ?新增，在任何状态变更之?  ?planned ?queued ?running
  ?buildRunRequest({ cwd: workspace.cwd })   ?workspace 权威
  ?Orchestrator.run() ?RunResult
```

- **workspace 在状态变更之前解?*：失败不会留?`queued`/`running` 的任?- prepare 成功?**workspace ?cwd 是权?*，调用方不能?root cwd 覆盖 isolated 任务的目?- `cwd` 交出去前**验证存在** ?不把不存在的目录交给 agent?- **?workspace manager 时行为完全不?*（所?task 用调用方给的 cwd），isolation ?opt-in?
### 26.49 禁止 fallback?0?
```text
isolated requested ?worktree 创建失败
                  ?DENIED（workspace-not-a-git-repository / workspace-*-failed?                  ??handle、无 running、无 Runtime 调用
                  ??绝不回落 root cwd
```

真实 non-git 验证：denied，Runtime 调用次数 **0**，task 保持 `planned`?*不是** `failed`
?workspace 准备失败不是任务失败），无半成品 workspace 登记。拒绝原因里显式写明
`no fallback to a shared checkout`?
### 26.50 Windows 处理??
- **不使用任?shell**：git 通过项目既有?`ManagedProcess` + `launcherFor` 调用?  参数为数组、`shell` 关闭。没?`bash -c` / `sh -c` / `rm -rf`?  （有源码级断言检查。）
- `resolveGitPath()` 自己?`PATH` 解析 `git.exe` / `git.cmd` / `git` ?  `launcherFor` 只认显式扩展名，?`git` ?Windows 上必须先解析?- 路径含空格与?ASCII（本仓库自身路径两者皆有）**无需引号**，参数不会被重新解释?- worktree 目录放在**仓库的同级目?* `<parent>/.p4m-worktrees/`，不落在仓库内，
  因此 `git status` 保持干净（真实验证：smoke ?repo ?`git status --porcelain` 为空?
**踩到并处理的一个真?git 陷阱**：`git worktree add -b <已存在分?` ?git 2.44 / Windows ?*退出码?0**，只?stderr ?`fatal:`?只看退出码会返回一个并不存在的 workspace。因?`stderrIsFatal()` ?stderr 里的 `fatal:` 一律视为失败，与退出码无关。创建后还会**实际验证目录存在**?
### 26.51 Branch naming

```text
orch/task/<sanitized-taskId>
```

- 只取 **taskId**?*绝不**?prompt（prompt 是不可信文本?branch 名是路径式标识）?- 归一化为 `[A-Za-z0-9._-]`，折叠连?`-`，去掉首?`-`/`.`，上?80 字符?- **去掉前导 `-`**：否?git 会把它当 flag?- 完全无可用字??`workspace-invalid-task-id`?- 分支冲突 ?`workspace-branch-exists`?*不静默复?*，否则两?task 指向同一分支?
### 26.52 生命周期与保留策?
```text
task spawn ?prepare ?worktree ready ?executeTask ?RunResult
  ?succeeded / to_verify ?RETAIN（供 verification、diff 检查、review?  ?failed                ?RETAIN（失败现场要能排查）
  ?cancelled             ?RETAIN（cancel 不删现场?  ?release(taskId)       ?唯一删除路径，永不自?```

实测证据?
```text
release(clean)          ?removed=true，cwd 消失
release(dirty)          ?removed=FALSE（git 拒绝：会销?agent 未提交产物）?                          cwd 仍在 ?保护生效
release(dirty,{force})  ?removed=true
```

**cancel 不删 workspace**?4）：`cancelTask` ?`RunHandle.cancel()` ?Runtime 取消进程；workspace 保留。测试断言 cancel ?workspace 仍存在且仍注?
### 26.53 并行隔离证据（真实文件系统，非字符串比较?
```text
maxChildren=10  maxConcurrentAgents=2
children created   : 3 / 3
tick 1 admitted    : ["A","B"]      tick 1 waiting : ["C"]
tick 2 admitted    : ["C"]
branches           : orch/task/A | orch/task/B | orch/task/C
A.cwd !== B.cwd    : true   (p5-repo-?A vs p5-repo-?B)
A/X.txt exists     : true
B sees A/X.txt     : false   ?隔离
A sees B/X.txt     : false   ?隔离
B/X.txt exists     : true
repo root polluted : false
git status         : empty（repo 未被自己?worktree 污染?```

### 26.54 实现中发现并修掉的两个真问题

1. **Awaiting prepare ?`maxConcurrentAgents` 失效**。`executeTask` 现在?transition
   之前 await workspace prepare，因?task ?tick 中途仍?`planned`?   Scheduler 原先在每?dispatch ?*重新?* `occupiedSlots()`，读到的数一直不变，
   于是 3 ?ready + cap 2 ?tick **一次性准入了 3 ?*?   已改?tick ?*乐观递减**，并加了两个回归（源码级 + 端到端）?   store 仍是?tick 的权威，`executeTask` 另行逐次 gate?2. **两个文件的注释在 5C-5 后变成假?*（`scheduler.ts` / `controller.ts` 仍写着
   "worktree isolation is NOT implemented"）。源码级断言最初正是被这些**过期注释**
   触发的。已更新为当前语义，并把这些断言改成**剥离注释后检查代?*?   避免断言被散文满?
### 26.55 明确未实?
| 未实?| 说明 |
|---|---|
| **git merge / cherry-pick / patch 应用 / 冲突解决 / PR** | 本轮**明确不做**。worktree 只是隔离执行环境 |
| durable workspace recovery | 未做；重启后 TaskStore ?workspace 注册表都是内?|
| workspace capability matrix | 未做新体系；模式?`workspaceMode` 策略决定 |
| automatic review worker | 未做；Codex 暂不可用，未围绕它设?|
| merge / branch 回收自动?| 未做；`release` 是手?API |

### 26.56 现在可以声明什么、不能声明什?
**可以声明**?
```text
parallel execution + isolated worktree = parallel code-edit isolation capability
```

已由真实文件系统证据支撑?6.53?
**仍不能声?*已实现：automatic merge、conflict resolution、durable workspace recovery?
### 26.57 5C-5 剩余限制

1. **worktree 只隔?working tree，不隔离 git 对象?*。两?child 共享同一?   `.git`，因?`git add/commit` 会共?index 竞争 ?worktree 模式?git 会为每个
   worktree 分配独立 index，但仍共?refs。跨 task 的分支管理需要人工介?2. **?merge 路径**：worktree 里的成果要回到主分支必须人工处理?3. **无持久化**：workspace 注册表在内存里。进程重启后无法找回某个 task ?worktree?   只能通过 `git worktree list` 人工发现?4. **dirty worktree 无法 release**（保护生效，但调用方需要知道要?`force`?   ?`force` 会销?agent 产物 ?这个取舍应由未来的人工确认环节承担）?5. **`prepare()` 的幂等只保证同一进程?*；跨进程没有锁，并发 prepare 同一 task
   可能竞争（当前调用路径是?task 串行 prepare，未触发?6. **未验证大型仓?*：本轮用的是小仓库。大型仓?`git worktree add` 的耗时?   checkout 成本未测量，可能显著影响 `maxConcurrentAgents` 的实际吞?
---

## 26.60 Phase 5C-6 Scope（Workspace / Agent Capability Enforcement）

```text
Phase 5C-6 = Task -> workspaceMode -> AGENT CAPABILITY CHECK -> prepare -> RunRequest -> Runtime
Status     = IMPLEMENTED · 784 orchestration tests（5C-5 的 728 全部继续通过）
```

5C-5 留下的限制已解决。此前：

```text
task.workspaceMode = isolated
agent = X
→ 直接 prepare worktree，没有任何「X 是否允许进入 isolated」的判断
```

### 26.61 Capability ≠ Implementation（本轮最重要的一句话）

```text
workspace isolation capability  !=  workspace implementation
```

- **Implementation**：git worktree 能不能建 —— 5C-5 已实现，与哪个 agent 无关。
- **Capability**：**某一个具体 agent** 是否允许被放进 worktree —— 5C-6。

两者是正交的：worktree 可以完全正常，而某个 agent 依然不被允许使用它。

### 26.62 复用了已有的 capability 系统（没有第二套 registry）

调查结论：

| 已有物 | 位置 | 处理 |
|---|---|---|
| `AgentCapabilities` | `src/core/types.ts:44` | **扩展**，加一个字段 |
| `resolveCapability()` / `Signal` / `MissingSignal` | `src/orchestration/spawn-gate-input.ts:204` | **沿用同一模式**新增 resolver |
| `AgentDescriptor.capabilities` | adapter registration | 复用，无新 registry |

```ts
// src/core/types.ts — 唯一声明「某 agent 支持哪些 workspace mode」的地方
readonly workspaceModes?: readonly WorkspaceMode[];   // FAIL-CLOSED
```

`WorkspaceMode` 定义在 `core/types.ts`（最低层），`workspace.ts` 再导出，
避免 core 反向依赖 orchestration。

### 26.63 `worktree` 与 `workspaceModes` 不是一回事（易踩的坑）

已有的 `capabilities.worktree` **保持 `false`，且刻意不改成 true**：

- 它表达「adapter 实现了**原生** worktree/fork 请求」—— 即 agent 自己去开 checkout。
- `RunRequest` **根本没有** worktree/fork 字段，所以对所有 agent 都诚实地是 `false`。
- `workspaceModes` 表达的是「允许把 agent **放进**我们选的目录」。

调查发现 `capabilities.worktree` 在 4 个 adapter 里被声明，但**全项目无任何一处读取**
（write-only）。5C-6 没有借机把它翻成 true —— 那会声称一个不存在的请求面。
新增了源码级测试锁住这一点。

### 26.64 为什么 `cwd: true` 不等于可以 isolated

必要但不充分：

1. **honour 一个目录** —— `cwd: true` 说的是这个；
2. **两个实例在不同目录里互不打架** —— 说的是 per-agent 共享状态
   （session store / 配置文件 / 锁）是否按目录隔离。

第 2 点是每个 agent 各自的证据，必须单独声明，不能从 `cwd` 推导。
这也是「不要为了让所有 Agent 绿灯而标成 isolated=true」的技术理由。

### 26.65 当前实际 capability matrix（依据见 26.66）

| Agent | shared | isolated | 依据 |
|---|---|---|---|
| **OpenCode** | YES | YES | 本机实测：`opencode 1.18.31`；`opencode run --help` 明确列出 `-d, --dir <directory>`；adapter 传 `--dir req.cwd` 且 transport 以该 cwd spawn |
| **WorkBuddy CN** | YES | NO（withheld） | `workbuddy` **不在本机 PATH**，无法验证第 2 条 → fail-closed |
| **WorkBuddy Intl** | YES | NO（withheld） | 同上（两者共用同一 `CAPABILITIES` block） |
| **Codex（暂停）** | YES | NO（withheld） | 暂停 ≠ 不支持；`sandbox: true`/`cwd: true` 都已实现，但本机未安装，无法验证 → 保守声明 |

`NO（withheld）` 的含义是**「尚未证明」**，不是「永远不支持」。
清除它需要一次真实的双 worktree 并发运行。

### 26.66 判断依据（实测，不是印象）

```text
opencode      -> C:\Users\Admin\AppData\Roaming\npm\opencode.ps1  (1.18.31)
workbuddy     -> NOT ON PATH
codex         -> NOT ON PATH
opencode run --help -> -d, --dir  directory to run in
```

一次真实 `opencode run` 尝试**失败**于 `Unexpected server error`。
用**同一个命令在普通（非 worktree）checkout 里复现，结果完全相同**
→ 该错误来自 provider/auth，**与 worktree 支持无关**，不能作为「不支持」的证据，
也不能作为「支持」的证据。因此 OpenCode 的 capability 建立在
**adapter 自身的目录传递实现**（`--dir` + spawn cwd）之上，而不是一次跑通的 run。

### 26.67 接线位置：prepare 之前

```text
executeTask
 → validate task
 → validate dependency
 → re-check gate (quota/capability/policy/concurrency/budget)
 → AGENT WORKSPACE CAPABILITY CHECK     <- 5C-6 新增
 → WorkspaceManager.prepare()           <- 5C-5
 → planned -> queued -> running
 → RunRequest(cwd = workspace.cwd)
 → Runtime
```

mode 由 `workspaceModeFor(task)` **提前解析一次**，check 与 prepare 共用同一个值，
两者不可能对「要哪个 mode」产生分歧。

**顺序本身就是要求**：先建 worktree、之后才发现 agent 不支持、再删掉 ——
那是一个 admission rejection 不该产生的副作用。所以 check 在 prepare 之前。

### 26.68 Deny semantics（admission rejection，不是执行失败）

能力不支持时：

| | |
|---|---|
| worktree | **不创建** |
| Runtime | **不调用** |
| native process | **不启动** |
| task 状态 | **保持 `planned`** —— 可重试，**不是** `failed` |
| budget | **不消费** |
| 返回 | `capability-missing:workspace-isolation` |

deny reason 显式写明 `no fallback to a shared checkout`。

**禁止 silent fallback**：不因不支持就改用 root cwd，也不改用 shared。

### 26.69 复用既有 typed code system

没有新增任意字符串码，而是沿用 `MissingSignal.code` 的命名空间族：

```ts
export const WORKSPACE_CAPABILITY_MISSING = 'capability-missing:workspace-isolation';
```

- 属于 `capability-missing` 家族（可被既有消费者聚合）；
- 但**可区分**：调用方能看出缺的是 workspace isolation，而不是普通工具 capability；
- 与 `capability-missing`（`newTask`/`review` 缺失）的区别有测试锁定。

### 26.70 shared 不需要 capability

`shared` 是 pre-5C-6 的默认行为（用一个调用方指定的目录跑），
因此**任何 agent 都天然可用**，不需要声明。
`resolveWorkspaceModeCapability` 对未声明 agent 的解析结果是：

```ts
descriptor.capabilities.workspaceModes ?? (['shared'] as const)
```

即「未声明 = shared only」，**不是 wildcard**。
这就是「不支持 worktree 的 agent 仍能执行普通任务」的实现方式。

### 26.71 Review task

- review 的默认 mode 仍是 `shared`，5C-6 未改变；
- 调用方**显式**要求 `isolated` 时会照做（测试覆盖）；
- Agent 不支持时 **denied，不自动降级为 shared**。

### 26.72 默认策略未被改动

`defaultWorkspaceMode(task)` = `review ? 'shared' : 'isolated'`，
5C-6 **只增加 admission，不改 policy**。有测试显式锁定
「implementation 仍默认 isolated」「review 仍默认 shared」。

### 26.73 职责边界（未变）

```text
TaskStore            = Task State authority
WorkspaceManager     = Workspace authority
capability layer     = Admission authority
Runtime              = Execution authority
Scheduler            = 只做 candidate selection，不做 capability 判断
Controller           = 不维护 capability cache，不自己判断 agent
```

Scheduler/Controller 仍然只在 `executeTask()` 处汇合 admission 判断。

### 26.74 实现中发现的两个问题（都已处理）

1. **新 enforcement 立刻抓到 5C-5 的一个测试夹具**：fake agent 声明了
   `cwd: true` 却从未声明 workspace capability，于是被正确拒绝。
   5C-6 让 capability 必须**显式**；测试夹具改为显式声明完整能力。
2. **一个回归测试因为错误的原因而通过**：并发上限测试用手搓的永不 resolve 的
   `RunHandle`，被 orchestrator 判为 failed，任务立刻 failed 并**释放了槽位**，
   第二个 child 因此被放行。断言 `n2.ok === false` 通过了，但通过的原因是
   `runtime-result-failed` 而**不是** concurrency。
   改用真实的 `hang` transport，并**断言 denial 的 code**。
   只断言「被拒绝了」是不够的，必须断言「因正确的理由被拒绝」。

### 26.75 实测证据

**A — OpenCode + isolated（真实 git worktree）**

```text
capability(isolated) allowed : true
executeTask A ok / B ok      : true / true
task A status                : to_verify      (run 成功 != 验证通过)
runtime invocations          : 2
real worktree for A / B      : true / true
branches                     : orch/task/A | orch/task/B
A cwd is its own worktree    : true
A wrote its marker           : true
B CANNOT see A marker        : true          <- 隔离
repo root NOT polluted       : true
```

**B — WorkBuddy CN + isolated（必须拒绝）**

```text
capability(isolated) allowed : false        (withheld)
executeTask(C) allowed       : false | capability-missing:workspace-isolation
worktree directory created   : false        <- 无副作用
runtime invocations          : 0            <- 未调用
task C status                : planned      <- 可重试，不是 failed
scheduler will not run it    : []           <- 不会被自动执行
no silent fallback to shared : true
workbuddy-intl isolated      : false        (同)
```

**C — WorkBuddy CN + shared（必须仍能跑）**

```text
capability(shared) allowed   : true
executeTask(D) allowed       : true
runtime invocations          : 1
ran in the shared cwd        : true         <- 没有凭空造 worktree
D workspace mode             : shared
```

### 26.76 顺带发现的两个既有问题（不属于 5C-6，未修）

诚实记录，因为它们**不是** 5C-6 引入的：

1. **smoke 里并发执行多个 child 时，子任务终态为 `failed`**。
   用受控对照确认与 workspace 无关：单 child `executeTask` 得到
   `ok=true / status=to_verify`，**开与不开 workspace 都一样**；
   并发路径才出现 `failed`。因此这是编排/并发路径的既有行为，
   5C-6 未触碰该路径。**建议单独排查**。
2. **`capabilities.worktree` 是 write-only 声明**，4 个 adapter 都写了，
   全项目无一处读取。本轮刻意保留原样（见 26.63），
   但它会误导读者以为存在一条 worktree 能力路径。

### 26.77 5C-6 明确未实现

| 未实现 | 说明 |
|---|---|
| merge / cherry-pick / 冲突解决 / PR | 未做，属后续独立阶段 |
| durable workspace recovery | 未做 |
| cross-process workspace locks | 未做 |
| branch reclamation / 自动清理 | 未做 |
| retry / rework / replan | 未做 |
| automatic review worker | 未做（Codex 暂停） |
| quota reservation | 未做 |
| 新 Agent | 未做（未新增 Cline / ZCode / DSH / TRAE 为 coding runtime） |
| Dashboard / 前端 | 未做，`temporary-dashboard/` 本轮零改动 |

### 26.78 5C-6 剩余限制

1. **capability 是人工声明 + 单元测试锁定，没有自动探测**。
   Agent 升级后若目录行为改变，不会自动失效。
2. **WorkBuddy 的 isolated 需要一次真实并发验证才能清除**；
   在此之前它是「未证明」而非「不支持」，措辞必须保持一致。
3. **OpenCode 的 capability 建立在实现证据而非成功 run 上**（provider 不可用）。
   拿到可用 provider 后应补一次真实 worktree run。
4. **`Scheduler` 不会因 capability 拒绝而停止 tick**：被拒的 child 保持 `planned`，
   每个 tick 都会被重新尝试并再次被拒。若要避免反复评估，需要一个
   「已知不可行」的缓存 —— 本轮故意不做，避免引入第二个 capability 状态源。
5. **`workspaceModes` 目前只有两个取值**，粒度就是 mode 本身。
   若将来需要「只读 worktree」「多 worktree 池」等，需要再扩展这个维度。

### 26.79 Phase 5C-7 Scope（文档恢复 + 并发失败调查）

```text
Phase 5C-7 = 两个目标：(1) 恢复被错误编码损坏的架构文档
                      (2) 调查「并发 child 最终 failed」
Status     = 文档已恢复为可读且结构完整；并发问题【不是生产缺陷】，已证明并加回归
Tests      = 823 orchestration（5C-6 的 784 全部继续通过，新增 39 条）
生产代码改动 = 0（本轮未修改任何生产代码，理由见 26.82）
```

本轮明确不做：merge、review worker、durable recovery、retry/replan 等。

### 26.80 文档损坏的成因与恢复

**成因**：上一轮用 PowerShell `Get-Content -Raw` + `Set-Content -Encoding UTF8`
修改本文件。在中文系统上，`Get-Content` 未指定编码时按 **ANSI = GB18030** 读取，
于是产生了往返损坏：

```text
原始字节(UTF-8) --gb18030 解码--> mojibake --UTF-8 编码--> 损坏文件
```

**已证明的部分**：
- 用 `gb18030`（不是 `gbk`/`cp936`）可 100% 逆向还原字节流；
- 确认 PowerShell 实际使用的正是 GB18030（`gb18030` 是唯一 0 个不可映射字符的 codec）；
- 字节**总数**得以保留。

**为什么无法完全恢复**（关键结论）：
GB18030 解码器会把无法成对的字节吞进**一个** `?`。这意味着
「mojibake → 字节」的还原**不是**恒等映射，丢失的字节数未知，
且对齐会整体错位。本轮实测到一处无法用任何字节值修复的位置：

```text
位置 335 的字节流: e3 e8 bd ae ...
```

`e3` 是 3 字节序列的首字节，后续必须是 `0x80-0xBF` 续字节，
而 `e8` 不是 —— 无论把丢失的字节填成什么值都无法构成合法 UTF-8。
**因此字节级精确还原在数学上不可能**，剩余字符只能靠推断。

**实际采取的恢复策略**：
1. 对**可逆**部分做无损还原（DP 分段 + 文档自身字符频率作为证据）；
2. 本轮 5C-6 章节由我本人重写为干净文本（0 损坏）；
3. **没有**去「猜」剩余标点 —— 那是编造。

**当前文档状态**：

```text
总行数            : 1647
纯 ASCII 行       : 783   (代码块/表格完全完好)
仍损坏的标点位置  : 1051 个，分布在 464 行
  其中 §23 占 663，§3 占 220
结构完整性        : 26.45 / 26.55 / 26.57 / 26.60 / 26.65 / 26.78 / §27 全部在位
关键内容          : maxChildren、maxConcurrentAgents、WorkspaceManager、
                   orch/task/、workspaceModes、
                   capability-missing:workspace-isolation、to_verify 等均在位
```

**结论**：文档**可正常阅读、结构完整、5C-1～5C-6 内容齐全**，
但仍有 1051 个标点字符不可恢复。若需要 100% 原文，
需要一份未损坏的副本（编辑器历史 / 早期 agent 会话记录 / 备份），
拿到后我可以按节精确拼回。

### 26.81 文档操作禁令（本仓库长期有效）

```text
禁止：对含中文的 Markdown 使用 PowerShell 的
      Get-Content -Raw / Set-Content / Out-File 做整文件读写
只可：edit / write 工具
      Python（显式 encoding='utf-8'）
      git show / git checkout 到临时文件
```

在 zh-CN 系统上，PowerShell 的默认编码是 GB18030，不是 UTF-8。

### 26.82 并发 child `failed`：不是生产缺陷

5C-6 观察到「并发执行多个 child 时子任务终态为 `failed`」，本轮用 8 组受控实验
重新调查，结论是**未发现任何生产缺陷**。

```text
S1  单 child 顺序执行（基线）              A to_verify
S2  两 child 顺序执行                      A,B to_verify
S3  两 child 并发 + shared cwd（对照）     A,B to_verify
S4  两 child 并发 + 隔离 worktree（实验）  A,B to_verify
S5  OrchestrationController 真实派发       A,B to_verify
S6  autoTick 调度器（调用 start()）        A,B to_verify
S7  手动 tick                              A,B to_verify
S8  每次 run 新建 Runtime+Adapter          A,B to_verify
```

对照组实验符合要求：S3（shared）与 S4（isolated）**都通过**，
因此问题既不在 WorkspaceManager 也不在 Runtime。

**同时验证了两个真实 git 并发**（直接对 git 发两次 `git worktree add`）：
两次都成功（exit 0，两个分支都建成），说明 git 本身支持并发。

**没有发现共享全局状态**：`src/orchestrator/`、`src/runtime/`、`src/adapters/`
中没有任何 module 级可变状态；`runGit()` 每次调用都使用局部的
`stdoutLines/stderrLines/proc`，`ManagedProcess` 同理。

### 26.83 真正的根因：smoke harness 的三个缺陷

5C-6 的观察来自 smoke 脚本本身的缺陷，逐条复现并修正：

| # | harness 缺陷 | 造成的假象 |
|---|---|---|
| (a) | 多个场景**复用同一个 git repo**。`git worktree remove --force` 只删 worktree，**分支保留**；下一个场景再 `worktree add -b orch/task/A` 就正确地报 `workspace-branch-exists` | 被误读成「并发导致 worktree 冲突」 |
| (b) | 只传了 `autoTickMs` 却**没有调用 `scheduler.start()`**（自动循环是 opt-in） | 被误读成「调度器不工作」 |
| (c) | 在 run **尚未 settle** 时读取 task status | 被误读成「并发导致 failed」 |

(a) 尤其阴险：5C-5 明确把「分支已存在」实现为 `workspace-branch-exists`
并有测试锁定，所以它是**正确行为**，不是 race。

**因此本轮没有伪造生产修复**：生产代码一行未改。

### 26.84 一个容易误判的 API 语义

```text
executeTask() 返回 ok:true
  = 「这次 run 产生了终态结果，并且结果被记录了」
  ≠ 「这次 run 成功了」
```

真正的成败在 **task status**（`to_verify` / `failed` / `cancelled`）。
本轮第一次写 Case D 时断言 `ra.ok === false`，结果**失败**：
一个 exit code=1 的 child 同样返回 `ok:true`，因为它的失败被如实记录了。
只断言 `ok` 会把失败当成功放过 —— 这类断言必须断言 status。

### 26.85 新增并发回归测试（Case A–E）

```text
Case A  2 children, maxConcurrentAgents=2
        两者同时 running → 都成功 → 都 to_verify，2 个不同 worktree，无 failed
Case B  3 children, cap 2
        A/B 先跑，C 显式 waiting；A/B 完成后 C 被放行并 to_verify；共 3 次执行
Case C  A/B 不同工作区，并发期间
        A 看不到 B 的文件，B 看不到 A 的文件，项目根从未被当作 cwd
Case D  A failed + B successful
        A 如实 failed；B 不受影响仍 to_verify；A 的失败不污染 B；
        A 的 workspace 保留；调度器之后仍能接纳新工作
Case E  A cancelled + B successful
        A 为 cancelled（不是 failed）；B 不受影响；
        A 的 workspace 保留（cancel 不删现场）；槽位释放后 C 被放行并 to_verify
SEMANTICS 单任务语义未被并发改动：
        成功→to_verify（不是 succeeded）、失败→failed、取消→cancelled
```

这些测试每个场景都使用**独立的 git repo**，把缺陷 (a) 固化为测试前提。

### 26.86 真实 production parallel smoke

```text
=== 1. maxConcurrentAgents=2, A and B simultaneous ===
  admitted in one tick   : ["A","B"]
  A status / B status     : to_verify / to_verify
  BOTH SUCCESSFUL         : true
  runtime runs            : 2
  distinct worktrees      : true (p7s-poe6QU-A vs p7s-poe6QU-B)
  A cannot see B file     : true
  B cannot see A file     : true
  neither is failed       : true

=== 2. A fails, B succeeds ===
  A status = failed   B status = to_verify
  B not polluted by A : true
  both really executed: true (runs=2)
  A workspace retained: true

=== 3. cancel A; B unaffected; C uses the freed slot ===
  A = cancelled   B = to_verify   C admitted then to_verify
  A workspace retained : true
```

### 26.87 5C-7 剩余限制

1. **文档仍有 1051 个标点不可恢复**（见 26.80）。结构与技术内容完整，
   但不是逐字原文。需要干净副本才能补齐。
2. **并发结论基于本机的 scripted agent**。真实 provider 不可用
   （`opencode` 返回 `Unexpected server error`），所以「真实 agent 并发」
   仍未验证；已验证的是「真实 Runtime + 真实 git worktree + 并发调度」。
3. **`prepare()` 仍只在单进程内幂等**，没有跨进程锁（5C-5 遗留，本轮未做）。
4. **没有做任何防回归的性能/压力测试**，并发用例是功能性的，不是压力性的。
5. 5C-6 的 capability 保护本轮**未改动**并继续通过：
   `isolated` + 不支持的 agent 仍然 deny、不建 worktree、不调 Runtime、
   不 fallback。WorkBuddy CN/Intl 与 Codex 的 `withheld` 状态保持不变，
   未因本轮任何观察被改成 `isolated: true`。

### 26.88 Phase 5C-8 Scope（Workspace Lifecycle Hardening）

```text
Phase 5C-8 = (1) cross-process workspace creation lock
             (2) safe branch / worktree reclamation
Status     = IMPLEMENTED · 888 orchestration tests（5C-7 的 823 全部继续通过，新增 65 条）
生产代码改动 = src/orchestration/workspace-lock.ts（新增）+ workspace.ts / index.ts
```

本轮**不做**：merge、cherry-pick、conflict resolution、durable recovery、
restart 后 workspace 恢复、retry、review、quota reservation、新 Agent、前端。

### 26.89 Reuse First

调查结论：Phase 5A 审计（`docs/MULTI_AGENT_REUSE_AUDIT.md`）已经记录

```text
pi-subagents/src/schedule-store.ts → PID 锁 + 原子写持久化
symphony/.../orchestrator.ex      → 对账 / stale 处理
```

因此本轮**沿用 PID 锁这一既有模式**，没有发明新的 lock protocol，
也没有引入第二个 capability/registry 抽象。仓库内原本**不存在**任何 lock 原语，
所以 `workspace-lock.ts` 是新增但独立的小模块，只被 `WorkspaceManager` 使用。

### 26.90 OS 原语先验证，再使用

不在文档里假设，先在本机实测：

```text
mkdirSync 1st/2nd      : ok / EEXIST          → 目录创建是原子互斥
openSync wx 1st/2nd   : ok / EEXIST          → O_CREAT|O_EXCL 原子互斥
200 个并发竞争者      : winners = 1          → 恰好一个赢家
process.kill(pid, 0)  : 活着的子进程 alive；SIGKILL 后 dead(ESRCH)
hostname()            : DESKTOP-7QTI9NH
```

没有 shell、没有 Redis、没有数据库、没有外部服务。

### 26.91 Lock 实现

单个文件，`openSync(path, 'wx')` 原子创建，**owner 元数据写在同一个文件里**：

```text
<p4m-locks>/<projectDigest>-<task>.lock  =  { pid, hostname, token, createdAt, purpose }
```

**为什么用单文件而不是「目录 + owner 文件」**：目录方案会留下一个
「锁已存在但 owner 未知」的窗口；单文件没有这个窗口。

**为什么默认放在项目的同级目录**（`<parent>/.p4m-locks`）：
与 5C-5 把 worktree 放在同级目录是同一个理由 —— 用户的 checkout 不应该积累
本系统的账本。lock key 里带了项目路径摘要，所以一个同级目录可以服务多个项目。

### 26.92 Lock key 与 Windows 归一化

```text
key = <FNV-1a(normalize(projectRoot))>-<sanitized taskId>
```

`normalizeIdentityPath()` 会折叠：大小写、`/` 与 `\`、重复分隔符、
尾部分隔符、盘符大小写。否则 `C:\Repo` 与 `c:/repo/` 会取到两个不同的锁。
有测试锁定这些等价关系。

### 26.93 Lock scope：覆盖「决策」，不只是「git 调用」

锁的持有范围：

```text
acquire
  → repoRoot 解析
  → branch 名计算
  → target 路径计算
  → git worktree list 检查（复用判定）
  → git worktree add（创建）
release
```

只包住 `git worktree add` 会留下经典漏洞：**「A 检查、B 检查、A 锁得太晚」** ——
因为「要不要创建」是由那些检查决定的，不是由 git 调用决定的。

### 26.94 跨进程复用（5C-8 新增行为）

持锁后先读 **git 自己的记录**（`git worktree list --porcelain`），而不是内存 map：

```text
target 上已有 worktree + 同一 branch  → 复用（attach），不重复创建
target 上已有 worktree + 别的 branch  → workspace-worktree-exists（拒绝，不偷用）
branch 存在但没有 worktree            → workspace-branch-exists（保持 5C-5 语义）
```

第一条是本轮新增的关键：没有它，跨进程竞争的**输家**会把
「别人刚建好的、其实属于自己的 worktree」误报成冲突。

### 26.95 Stale lock：以存活性为准，不用年龄

```text
owner.hostname === 本机 → process.kill(pid,0) 判定存活；死了才可回收
owner.hostname !== 本机 → 永不回收（无法证明远端进程已死）
owner 无法解析           → 仅在 grace window 之后回收
```

**明确拒绝「文件超过 X 秒就删」这种脆弱规则作为唯一依据**：
一次健康的 `git worktree add` 很慢，按年龄删锁会误伤正在工作的进程。
无法解析的锁是一个例外 —— 本代码总是写合法 JSON，所以解析失败意味着
它不是由一个正常协作中的进程写的；但仍加了 grace window 以防写了一半。

`token` 每次获取随机生成，因此 **release 是可证明的**：只删除 token 仍属于自己的锁，
否则抛 `workspace-lock-not-owned`。

### 26.96 进程崩溃恢复（真实进程验证）

```text
子进程 acquire 锁 → SIGKILL（无 finally、无清理）
→ 锁文件存活
→ 新进程判定 owner pid 已死 → 回收 → prepare 正常完成
```

不是只测 `try/finally`。

### 26.97 Reclamation：worktree 与 branch 分开

```text
release(taskId, {force})        → 只移除 worktree（5C-5 已有，dirty guard 保留）
releaseBranch(taskId, {force})  → 只删除 branch（本轮新增）
```

**刻意不合并成一个不可逆操作**：删 worktree 大体可逆（branch 还在），
删 branch 会销毁可能从未被合并的提交。合并成一个调用就是丢工作的方式。

`releaseBranch` 的判定顺序与 5C-8 规范一致，从「最可操作」到「最硬」：

```text
1. ownership   : branch 必须正好是该 task 的 orch/task/<taskId>
2. checked out : 不能被任何 worktree 检出
3. released    : worktree 必须已经 release
4. protected   : 不是 main / master / 默认分支 / 仓库当前分支 / 显式保护
5. explicit    : 调用方明确要求
```

顺序是本轮**修过的一个真实缺陷**：最初把「被任何 worktree 检出」也算进
protected 集合，于是普通 task branch 报 `workspace-branch-protected`，
把「先 release worktree」这个真正可操作的修复原因掩盖掉了。

### 26.98 Protected branch：force 也不能覆盖

`protectedBranches()` 是**探测**而不是配置（配置清单正是最容易被忘掉的东西）：

```text
main / master                    → 永远保护
仓库默认分支                     → origin/HEAD，否则 init.defaultBranch
仓库当前检出的分支                → worktree list 第一条记录
调用方额外声明的分支             → protectedBranches 选项
```

`force=true` **不绕过**保护：理由写在代码里 —— 破坏性开关不应该有能力
删掉用户的默认分支。

### 26.99 Retention semantics 未变

| task 终态 | 本轮行为 |
|---|---|
| `to_verify` | retain |
| `failed` | retain |
| `cancelled` | retain |
| `succeeded` | **仍然 retain**（本轮不改成自动删除） |

因为后续 merge / review / artifact extraction 都需要 workspace。
本轮只建立**显式** reclamation API，不擅自改默认策略。
Scheduler 不 acquire lock、不 release workspace、不删 branch。

### 26.100 实测证据

**两个真实 OS 进程准备同一个 task**

```text
both processes succeeded                    : true
two DIFFERENT OS processes                  : 284448 vs 275832
one shared workspace identity (same cwd)    : true
one branch                                  : true
git reports exactly 2 worktrees (main + 1)  : true
exactly one task branch exists              : true
no lock file left behind                    : true
project root untouched (clean git status)   : true
```

**回收是显式且分阶段的**

```text
branch cannot be reclaimed while worktree live : workspace-branch-checked-out
a DIRTY worktree refuses release               : true（agent 产物保留）
force performs the destructive release         : true
BRANCH still present after worktree release    : true（回收是独立决定）
branch reclaimed only when explicitly asked    : true
PROTECTED: main survived everything            : true
ROOT: project root still exists / valid repo   : true
```

**崩溃恢复**：真实子进程持锁后 SIGKILL → 锁存活 → 新进程恢复并继续 → 成功。

### 26.101 本轮修掉的两个自身缺陷（诚实记录）

1. **probe 用 `String.replace` 只替换了第一个同形字符串**，导致 Case A 的两个
   进程拿到了**不同的 lockDir**，于是根本没有发生互斥，测试还报
   `workspace-branch-exists`。这与 5C-7 的 harness 缺陷同源：
   **「测试通过」不等于「被测行为发生了」**。现在 probe 显式给两个参与者传同一个
   lockDir，并在 child 里打印实际使用的 lockDir。
2. **默认 lockDir 原本放在项目根内**，会在用户 checkout 里留下 `.p4m-locks/`。
   已改为同级目录，与 5C-5 的 worktreeRoot 保持同一原则。

另外一次 `smoke 21/23` 是**偶发**（同一命令随后连续 4 次 23/23），
我把它记录为观察到的 flake 而不是「已解释」。

### 26.102 5C-8 明确未实现

| 未实现 | 说明 |
|---|---|
| merge / cherry-pick / conflict resolution / PR | 未做 |
| durable workspace state、机器重启后恢复 workspace | 未做 |
| lock 的跨机器协议（NFS 等） | 未做；远端锁一律不回收 |
| 自动 branch reclamation（发现孤儿就删） | 未做，刻意禁止 |
| 自动 GC / 定期清理 | 未做 |
| retry / rework / replan / review worker / quota reservation | 未做 |
| 新 Agent / 前端 / Dashboard | 未做，`temporary-dashboard/` 零改动 |

### 26.103 5C-8 剩余限制

1. **锁只在同一台机器上生效**。跨主机共享文件系统（NFS/SMB）上的锁
   `openSync('wx')` 是否原子取决于该文件系统，**未验证**；且远端锁一律不回收，
   所以那种场景下可能等到超时。
2. **PID 复用**：Node 没有跨平台 API 读进程启动时间，因此
   「原主人已死、但 PID 被无关进程复用」时会被判为存活 → 只能等超时。
   token 只保证 release 正确，不解决 PID 复用。
3. **锁只保护创建，不保护整个执行期**。agent 运行期间另一个进程
   `release()` 同一个 workspace 仍可能删掉它正在使用的目录
   （dirty guard 会挡一部分，但不是并发保证）。真正的执行期保护需要引用计数。
4. **`releaseBranch` 用 `git branch -D`（强制）**，因为被拒绝的情况已在前面
   逐条挡掉；但这意味着一旦通过判定就不可逆。
5. **worktree 与 branch 的状态仍只在内存**：进程重启后无法知道某个 task
   的 workspace 是否存在（会走「worktree 存在则复用」路径，但不校验归属时间）。
6. 并发验证覆盖的是**功能正确性**，不是吞吐/性能；大规模并发下的锁竞争
   开销未测量。

### 26.104 Phase 5C-9 Scope（Inspect + 显式 Merge：个人闭环）

```text
Phase 5C-9 = Task → Agent → 隔离 worktree → 执行 → 验证 → inspect → 显式 merge
Status     = IMPLEMENTED · 968 orchestration tests（5C-8 的 888 全部继续通过，新增 80 条）
```

这是项目第一次形成**真正可用**的个人 Coding Agent 工作闭环。本轮明确**没有**
继续扩张基础设施（产品定位已调整为个人本地工具）。

### 26.105 Reuse First 的实际结果

调查发现三件可直接复用的事实：

1. **git 只有一个实现**：`src/orchestration/workspace.ts` 里的 `runGit`。
   本轮没有新建第二套 git abstraction，而是把它**提取**到 `src/orchestration/git.ts`，
   由 workspace / inspect / merge **共用**。
2. **验证路径已存在**：`applyVerification(taskId, {verdict:'pass'})`
   就是 `to_verify → succeeded` 的入口，merge 直接复用它作为前置条件。
3. **CLI 已有架构**：`src/cli/index.ts` 是 `command [flags]` 的简单 switch。

同时新增 `src/orchestration/errors.ts`，让 git 层不必反向 import `workspace.ts`
（否则形成循环依赖）。`workspace.ts` 继续 re-export，对外 API 不变。

### 26.106 TaskResultSummary（很轻，没有数据库）

```ts
interface TaskResultSummary {
  taskId, status, agentId, modelId
  workspaceMode, workspacePath, branch
  dirty, changedFiles[], diffStat{files,insertions,deletions}
  hasCommits, alreadyMerged, mergedAt, mergedCommit
  mergeReady, mergeBlockedBecause
}
```

纯数据、无 handle、无惰性 git 调用，可以直接打印或序列化成 JSON。

### 26.107 inspectTask：看清一个 child 干了什么

```ts
const s = await orch.inspectTask('A');
```

返回 status / agent / workspace / branch / 是否 dirty / 变更文件 / diff 统计 /
是否已有 commit / 是否已 merge / **是否可以 merge，以及为什么不可以**。

CLI：

```text
orchestrator task inspect <taskId> [--json]
```

实测输出：

```text
Task: A
Status: unknown (task store is in-memory)
Agent: unknown
Branch: orch/task/A
Workspace: C:/.../p9s-X7kEjO-wt/p9s-X7kEjO-A
Working tree: clean
Changed files: 0
Diff: +1 -0 across 1 file(s)
Commits on branch: yes
Merge: blocked
  reason: ...
```

### 26.108 mergeTask：显式，且默认什么都不做

```text
task succeeded
→ 不会自动 merge
→ workspace 保留
→ 只有人明确要求才 merge
```

个人工具最重要的控制权就在这里：agent 干完活，**由你决定**什么时候进你的仓库。

### 26.109 Merge 前置检查（全部在任何变更之前完成）

| # | 检查 | 失败码 |
|---|---|---|
| 1 | task 有 isolated workspace | `merge-no-workspace` |
| 2 | task 状态是 `succeeded` | `merge-task-not-verified` |
| 3 | branch 正是该 task 的 | `merge-branch-not-owned` |
| 4 | worktree 仍在 | `merge-worktree-missing` |
| 5 | child worktree 干净 | `merge-child-dirty` |
| 6 | 已合并过 | `merge-already-merged` |
| 7 | root checkout 干净 | `merge-root-dirty` |
| 8 | branch 有 commit 可带 | `merge-nothing-to-merge` |

`to_verify` / `failed` / `cancelled` 全部在第 2 条被拒。

### 26.110 支持 Agent 的两种常见结果

```text
A. Agent 自己 commit 了   → branch 有 commit → 可以 merge
B. Agent 没 commit       → working tree dirty → merge denied
```

**绝不**代 agent 执行 `git add` / `git commit`，**绝不**替它写 commit message。
没提交就是没干完，诚实的回答是「还不行」，不是「我来帮你」。

有源码级断言锁死这一点（见 26.115）。

### 26.111 最小 Git 策略

```text
git merge --no-edit <task-branch>
```

只此一条。整个 `task-result.ts` 里**唯一的**变更型 git 调用。
没有 cherry-pick、没有 squash、没有三方合并、没有 patch 引擎。

### 26.112 冲突：保留现场，绝不破坏

```text
A 改同一行
B 改同一行

merge A → success
merge B → merge-conflict
         冲突文件被点名
         冲突标记留在 root 里
         B 的 worktree 保留
         B 的 branch 保留
         root 没有被 reset
```

明确**不做**：强制 reset root、`--ours`、`--theirs`、删 child branch、删 worktree。
现场本身就是你要的证据；而且用户随后仍可手工 `add` + `commit` 收尾（有测试）。

### 26.113 Root 安全

merge 前检查 root 是不是干净的 git checkout、是否在正确 branch。
root dirty → **拒绝**，并且**不 stash、不 reset、不动你的任何文件**。
「你的未提交修改」比「合并成功」更重要。

### 26.114 成功后只记录，不删除

成功 merge 后**不自动删除** worktree / branch / task —— 个人工具需要随时回看历史。
只记录 `mergedAt` / `mergedCommit`（内存，**不建数据库**）。

`already-merged` 判定用的是 git 自身的
`git merge-base --is-ancestor <branch> HEAD`，因此**跨进程、跨重启都有效**，
正确性不依赖那份内存记录。

重复 merge 一律拒绝。

### 26.115 源码级保证（有测试锁定）

```text
task-result.ts 里没有 git add
task-result.ts 里没有 commit
没有 --ours / --theirs / checkout --
没有 reset
没有 branch -D / worktree remove
唯一的变更型 git 调用就是那一次 merge
没有「task 成功就自动 merge」的代码路径
scheduler 不碰 git / merge
execute.ts 不碰 git / merge
orchestration 层只有一处 runGit 定义
```

### 26.116 最小 CLI

```text
orchestrator task list                    列出本工具拥有的 child branch
orchestrator task inspect <taskId>       状态/工作区/branch/dirty/变更/diff 统计
orchestrator task diff    <taskId>       merge 会带进来的 unified diff
orchestrator task merge   <taskId>       显式合并
  [--json]                               机器可读
  --worktree-root <dir> / --lock-dir <dir>
```

`--json` 输出可被未来前端直接消费。刻意保持简单：没有 TUI、没有参数框架。

### 26.117 一个必须说清楚的限制：task store 是内存态

```text
orchestration TaskStore = 内存（5C-1 的刻意决定，无持久化）
```

所以**另一个进程**读不到 task 的 status / agent / 验证结论。跨进程活下来的只有
**持久的那部分**：branch、worktree、commit。

因此 CLI 从 git 重建状态，并**如实说明**它不知道 task status：

```text
Status: unknown (task store is in-memory)
Agent: unknown
```

为了让「显式」不被绕过，CLI 的 `merge` **要求 `--verified`**：

```text
orchestrator task merge A
→ 拒绝，并解释原因（不给它猜）

orchestrator task merge A --verified
→ 由你本人声明「这个 task 我验证过了」
```

进程内的 API 不需要这个 flag：它自己能读到 `succeeded` 并强制执行。
这不是把门槛降低，而是把「由谁声明验证」这件事显式化。

### 26.118 实现中发现的两个真实问题

1. **CLI 自己的 flag 被父 CLI 吃掉了**。`src/cli/index.ts` 的通用 parser 会把
   `--verified` / `--json` 拆走，导致 `task merge A --verified` 静默失效并以
   错误的理由拒绝。修法：`task` 在通用解析**之前**派发，其余 argv 原样透传。
2. **`--diff-filter=U` 配 `--name-only` 输出的是裸路径**，不是 porcelain 的
   `XY path` 格式。我最初用 porcelain parser 解析，导致**冲突永远检测不到**，
   冲突被误报成 `merge-failed`。

### 26.119 真实 production smoke（真实 CLI 子进程）

```text
root repo
 → 2 个 isolated worktree（A / B），各自 commit 各自的文件
 → task list / inspect / diff（真实 CLI）
 → merge A（无 --verified → 拒绝，root 未被改动）
 → merge A --verified → success，Commit: <sha>
 → merge B --verified → success
 → root 同时拥有 A.txt 与 B.txt，内容分别来自 A 和 B
 → 再 merge A → 拒绝（already merged）
 → 制造真实冲突：CA 改 shared.txt，CB 也改
 → merge CA 成功；merge CB → Merge: conflict，shared.txt 冲突标记保留
 → CB worktree 保留，CB branch 保留
 → root 除我们故意留下的冲突外没有任何多余改动
```

### 26.120 5C-9 明确未实现

| 未实现 | 说明 |
|---|---|
| auto merge | 未做，且刻意不做 |
| conflict 自动解决 | 未做 |
| cherry-pick | 未做 |
| squash / semantic commit | 未做 |
| auto commit / AI commit message | 未做 |
| pull request / GitHub 集成 | 未做 |
| durable task database | 未做（task store 仍是内存态） |
| retry / replan / review worker / quota reservation | 未做 |
| 新 Agent / Model Provider / 前端 / Dashboard | 未做，`temporary-dashboard/` 零改动 |

### 26.121 5C-9 剩余限制

1. **跨进程看不到 task status**（26.117）。这是内存 store 的直接后果，
   本轮选择如实暴露而不是假装持久化。
2. **`--verified` 是一个人的口头声明**，git 无法核实。真要机器可验证就需要
   持久化，那属于后续明确推迟的范畴。
3. **merge 依赖使用者有 git 身份**（`user.name`/`user.email` 或 `GIT_*`）。
   没有身份时 `git merge` 会失败并如实报 `merge-failed`——不会替用户编造身份。
4. **冲突会留在 root 里**，直到用户手工解决。这是刻意的（不 reset），但意味着
   「merge 之后 root 可能处于未合并状态」，使用者需要知道。
5. **只支持 fast-forward / 标准三方合并**，未做 rebase、cherry-pick、squash 策略。
6. `already-merged` 与 `nothing-to-merge` 在「branch 从未分叉」时**语义重叠**，
   因为这种 branch 本来就是 HEAD 的祖先。测试因此接受两种诚实的答案，
   而不是强行区分一个 git 无法区分的事实。

## 27. 回答完成标准

> **"Phase 5C 到底需要写什么、从哪些成熟项目复制/提取什么，以及现有 Runtime 如何接入?**

| 问题 | 答案 |
|---|---|
| **写什?* | 16 ?orchestration 模块 + 1 个测试文件（§25.1/25.2），?3000 ?|
| **从哪复制/提取** | pi-subagents（MIT? 个模块）、Symphony（Apache-2.0? 项）、fifony（Apache-2.0? 项）、agent-framework（算法参考）?*chorus 仅读思路，AGPL ?copy**???|
| **Runtime 如何接入** | 编排?*只调?* `Orchestrator.run()`，唯一新增的是 `RunResult ?Task 状态` 的翻译层?.2）。执行路径零改动?|

**关键判断**：本轮最大的设计收获?**§12.2 ?demo input 定位** ?Phase 4 ?spawn gate ?8 个输入字段，当前 8 个全是硬编码，只?`multiAgentEnabled` 一?分支被真实覆盖。这不是 Phase 4 的缺陷（当时 Multi-Agent 未实现，默认拒绝是正确的），
但它?5C 接线?*必须先修**的东西，否则 gate 会给出没有依据的放行?
