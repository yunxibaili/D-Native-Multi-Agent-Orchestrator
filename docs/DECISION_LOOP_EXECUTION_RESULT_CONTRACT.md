# DECISION LOOP EXECUTION RESULT CONTRACT

```text
Status  = IMPLEMENTED（DispatchReceipt 已落地；本文为设计记录）
Date    = 2026-10-02
Scope   = Decision → Dispatch → Native Execution → Result → AttemptStore → Observation
Baseline= typecheck clean · npm test 3953/0 · smoke:quick 21/21 · native E2E 16 cases / 15 PASS
Method  = 源码级调查（decision-loop / workbench / orchestrator / scheduler / attempt-* /
          translate / core/types），所有结论均带 file:line
R2-2    = 本文件是 R2-2 Lease/Fencing 的前置契约；fencing 入口见 §12
```

本文件解决一个具体问题：**"一次真实执行发生过" 的唯一权威证据是什么，Decision Loop 如何
拿到它而不创造第二个 Execution Authority。**

同时它把 R1-1 已记录的已知技术债（`docs/EXECUTION_ROUND_SEMANTICS.md` §7）从"已知问题"
升级为一份可执行契约。

---

## 1. Problem

`runDecisionCycle` 内部建了一个 dispatch closure 用来捕获本次 tick：

```ts
// src/orchestration/decision-loop.ts:314-323
const collected: { tick: TickResult | null } = { tick: null };
const dispatch = async (): Promise<boolean> => {
  collected.tick = await options.scheduler.tick();
  return collected.tick.admitted.length > 0;
};
const application = await applyDecision(decision, {
  observation,
  dispatch,
  ...(options.capabilities ?? {}),   // ← 覆盖点
});
```

`capabilities` 是 **spread 在 `dispatch` 之后**的。任何提供了 `capabilities.dispatch` 的调用方
都会**静默替换**这个 closure，`collected.tick` 永远保持 `null`。于是：

```ts
// decision-loop.ts:324-338
const tick = collected.tick;                    // → null
const results = new Map<string, RunResult>();   // → 空 Map（因为 tick === null）
```

生产调用方正是这么做的，而且做了两层丢弃：

```ts
// src/cli/round-cli.ts（经 wb.decisionCapabilities()）
capabilities: wb.decisionCapabilities(...)      // 内含 dispatch
// src/orchestration/workbench.ts:386
dispatch: async () => (await this.dispatch()).tick?.admitted.length !== 0,
```

注意 `workbench.ts:386` 这一行：它**调用**了真正的 `NativeWorkbench.dispatch()`（该方法确实
拿到并处理了 `tick`，`workbench.ts:647`），然后把结果压缩成**一个 boolean** 就丢掉了。

因此 `outcome.tick` 恒为 `null`、`outcome.results` 恒为空 Map，而**真实执行确实发生了**。
生产报告只能绕道 AttemptStore 反读（`round-cli.ts:634-651` 读 `wb.evidence.history()`）。

这不是"结果丢失"——TaskStore 与 AttemptStore 都有正确事实。**丢的是 Decision Loop 这一层
对"我刚刚触发的那次派发产生了什么"的表示能力。** 本契约要恢复的正是这个表示，而不是新增事实源。

---

## 2. Current Execution Chain（源码证明）

单一真实链路，每一步的 input / output / authority / source of truth：

| # | Step | Input | Output | Authority | Source of truth |
|---|---|---|---|---|---|
| 1 | `provider.decide(request)` | `DecisionRequest`（criteria = `ACTION_CRITERIA`，state = observation + `ACTION_PARAMETERS`） | `DecisionResponse` | Laya / Decision Provider | 无（一次回答） |
| 2 | `extractAction(response)` | response | `{ action, ...parameters }`（raw） | `decision-loop.ts:163` | — |
| 3 | `validateDecision(raw, observation)` | raw + observation 快照 | `OrchestrationDecision` 或 throw | `decision.ts:246`（纯函数） | observation（TaskStore 只读投影） |
| 4 | `applyDecision(decision, ctx)` | decision + context | `DecisionApplication` | `decision.ts:438` | — |
| 5 | `ctx.dispatch()` | — | 默认：`Promise<boolean>`；**生产：`capabilities.dispatch` 的 boolean** | Scheduler（唯一 dispatch） | `TickResult` |
| 6 | `TaskScheduler.tick(promptFor?, threadFor?)` | 可选 prompt / thread 映射 | `TickResult` | `scheduler.ts:169`（唯一 dispatch loop） | `TaskStore`（slot / readiness 均派生） |
| 7 | `Orchestrator.executeTask(req)` | taskId / cwd / prompt / threadId | `ExecuteOutcome` | `orchestrator.ts:653`（唯一执行入口） | — |
| 8 | `this.runtime.run(request)` | `RunRequest` | `RunHandle` | `orchestrator.ts:931`（**唯一** execution edge） | 原生进程 |
| 9 | `handle.result(timeout)` | — | `RunResult` | `core/types.ts:208` | 原生进程终态 |
| 10 | `applyRunResult(taskId, result)` | `RunResult` | `MutateOutcome` | `orchestrator.ts:575`（**唯一** RunResult→Task 写回） | TaskStore |
| 11 | `translateRunResult(result)` | `RunResult` | `{ to, reason }` | `translate.ts:37` | — |
| 12 | `TaskStore.transition(...)` | status + reason | `TransitionResult` | `store.ts`（唯一 task-state authority） | TaskStore |
| 13 | `recordExecution / recordExecutions` | `TickResult` + identity 解析 | `AttemptRecord \| null` | `attempt-integration.ts:65/94` | AttemptStore |
| 14 | `AttemptStore.append(raw)` | record 形状 | `{ ok, record }`，**并生成 `attemptId` + `previousAttemptId`** | `attempt-store.ts:116` | AttemptStore（append-only） |
| 15 | observation / report | TaskStore + AttemptStore | `TaskObservation` / report | `observation.ts` / `round-cli.ts` | 派生只读 |

### 逐问回答（§五 A–G）

**A. `runtime.run()` 返回什么？**
返回 `RunHandle`（`core/types.ts:236`），**不是**结果。结果只能经 `handle.result(timeout)` 得到
`RunResult`（`orchestrator.ts:957`）。`RunResult` 是**终态且冻结**的：`{ taskId, threadId, state:
TerminalState, startedAt, endedAt, error, ... }`（`core/types.ts:208-215`）。`TerminalState =
Exclude<TaskState,'running'>`（`core/types.ts:24`）——即"运行中"不可能是一个结果。

**B. 谁决定 execution 成功/失败？**
**原生进程**决定 `state`；`translateRunResult`（`translate.ts:37`）把它映射为 task 状态。
关键不变量：`succeeded → to_verify`（`translate.ts:41-48`），**成功 run 绝不直接 succeeded**；
`failed → failed`（`translate.ts:51-53`）；`timed_out` 也走 `failed`（`translate.ts:68-72`）。
所以"execution outcome"（进程）与"workflow outcome"（任务是否被接受）是**两个不同的事实**。

**C. 谁写 AttemptStore？**
只有 `attempt-integration.ts` 的 `recordExecution` / `recordExecutions` / `recordReview`
（`attempt-integration.ts:65/94/139`）。它不 import 任何 authority，是被调用方。生产接线点共 3 处：
`workbench.ts:662`（普通执行）、`workbench.ts:669`（rework 重入）、`workbench.ts:741`（review）。
另有 `assignment-wiring.ts:184/199` 的等价封装供非 Workbench 调用方使用。

**D. 谁修改 Task state？**
只有 `TaskStore.transition`，且**执行路径上的唯一触发点是 `Orchestrator.applyRunResult`
（`orchestrator.ts:575`）**——它先做 `result.agentId !== task.agentId` 的 `agent-mismatch` 检查
（`:580`），再 `translate` + `mutate`。全仓 `applyRunResult(` 调用点 **1 处**（`orchestrator.ts:973`）。

**E. 谁决定 verification？**
`Orchestrator.applyVerification`（`orchestrator.ts:600`），唯一进入 `succeeded` 的门。
它把 `VerificationOutcome` 经 `translateVerification` 映射（`translate.ts:119/125`）。
review verdict 经 `review-loop.applyReviewVerdict` → `applyVerification`（`review-loop.ts:281`）。

**F. 当前 `tick/results` 到底来自哪里？**
来自 `decision-loop.ts:315-318` 的**内部闭包**——而这个闭包在生产路径上**从未被执行**。
实际执行的是 `capabilities.dispatch`（`workbench.ts:386`），它确实调用了真正的
`NativeWorkbench.dispatch()`，但只把 `DispatchOutcome` 压成 boolean 返回给 loop，
`DispatchOutcome.tick` 在返回途中被丢弃。

**G. 为什么 capability injection 会覆盖内部 closure？**
`decision-loop.ts:322` 用 `...(options.capabilities ?? {})` 在 `dispatch: dispatch` **之后**
spread 同一个 key。这是 JS 对象字面量的后写覆盖语义，**不是错误合并**。它有正当理由
（P6-D1 要让调用方注入既有 authority），但**类型上没有约束被注入的 `dispatch` 必须返回与
默认实现同形的值**——默认返回 boolean、生产返回 boolean，看起来一致，实际语义不一致：
默认的 boolean 意味着"我刚刚观察到的那个 tick 里有 admitted"，生产的 boolean 是
"某个 tick 里有 admitted"，而 loop 真正需要的 `tick` 本身**没有出现在类型里**。

---

## 3. Authority Boundaries

每个事实恰好一个 owner；本设计**不新增**任何 owner：

| 事实类别 | Owner | 位置 | 本设计是否改动 |
|---|---|---|---|
| Decision（选哪个 action） | Laya / Decision Provider | `decision-loop.ts` + `src/decision/` | 否 |
| Decision 合法性 | `validateDecision`（纯函数） | `decision.ts:246` | 否 |
| Dispatch（谁被准入执行） | `TaskScheduler.tick` | `scheduler.ts:169` | 否 |
| Execution（进程真实结果） | `Orchestrator` + `RuntimeRunner.run` | `orchestrator.ts:653` / `:931` | 否 |
| RunResult → Task 写回 | `Orchestrator.applyRunResult` | `orchestrator.ts:575` | 否（R2-2 在此加 fencing） |
| Task state | `TaskStore` | `store.ts` | 否 |
| Verification | `Orchestrator.applyVerification` | `orchestrator.ts:600` | 否 |
| Execution evidence | `AttemptStore`（append-only） | `attempt-store.ts` | 否 |
| Observation | 派生只读投影 | `observation.ts` / `execution-monitor.ts` | 否 |

**明确禁止新增**：`ExecutionResultStore` / `DispatchResultStore` / `RoundResultStore` /
`DecisionResultStore`。现有对象中唯一"看起来像结果存储"的是 `AttemptStore` 与 `TickResult`，
它们的关系见 §4 与 §6。

---

## 4. Fact Taxonomy（四类事实必须分开）

§八 要求的四类事实，落到具体字段：

### 4.1 Decision fact
"Laya 选择了 `reassign T101 → workbuddy-intl`。"
**来源**：`DecisionResponse` → `validateDecision` → `OrchestrationDecision`。
**落点**：`DecisionOutcome.decision`（`decision-loop.ts:196`）、`report.decision`。
**生命周期**：一次 cycle 内有效，不持久化。

### 4.2 Dispatch fact
"T101 被准入执行了 / 被拒绝了。"
**来源**：`TaskScheduler.tick` 的 `admitted` / `waiting` / `skipped`（`scheduler.ts:71-80`）。
**关键语义**：`admitted` 是**从 outcomes 反推**的，不是从"尝试"反推的
（`scheduler.ts:262-269`）——`executeTask` 在第一个 await 之前就同步定下 gate 结果，所以
被拒的派发会快速 resolve 且**不计入** admitted。**`admitted` 只代表准入，不代表执行完成。**

### 4.3 Execution fact
"原生进程跑了，结果是 succeeded/failed/timed_out/cancelled。"
**来源**：`RunResult`（`core/types.ts:208`）；**持久化**：`AttemptRecord`
（`attempt-store.ts:148` 冻结记录，含 `attemptId` / `previousAttemptId` / `outcome` /
`startedAt` / `finishedAt` / `errorCode`）。

### 4.4 Workflow fact
"任务进入 `to_verify`，等 review / 等 Human Gate。"
**来源**：`TaskStore` 状态（`translate.ts:41` 把成功 run 映射到 `to_verify`）+ `applyVerification`。

### 4.5 禁止合并：三个故意分开的词表

本系统有**三套**互不相同的封闭词表，它们对应三类不同事实，任何两套的合并都会丢失信息：

| 词表 | 取值 | 位置 | 回答的问题 |
|---|---|---|---|
| `TerminalState`（run） | `succeeded` / `failed` / `cancelled` / `timed_out` | `core/types.ts:20,24` | **进程**怎么样结束的 |
| `TaskStatus`（workflow） | `planned`/`queued`/`running`/`blocked`/`to_verify`/`succeeded`/`failed`/`cancelled`/`retrying`/`rework`/`replanning` | `task.ts:21` | **任务**现在处在生命周期哪一步 |
| `AttemptOutcome`（evidence） | `success`/`failure`/`rework`/`reject`/`aborted`/`error` | `attempt-record.ts:62` | 对**证据消费者**而言算不算成功 |

关键在于它们**故意不同名**：run `succeeded` → task `to_verify`（`translate.ts:41`）→ attempt
可能是 `reject`（被 reviewer 拒绝）。`attempt-record.ts:56-60` 写明了理由——"进程退出 0 但被
reviewer 拒绝"对证据消费者而言**不是成功**。把四类事实压成一个 `result`、或把三套词表合并成
一套，会直接抹掉这个区分，并让 `Assignment` 的 evidence 打分失去意义。

**推论**：`DispatchReceipt.terminalState`（§5.4）的类型是 `TerminalState`（run 词表），
**不是** `TaskStatus`。收据描述执行，不描述任务。

---

## 5. Dispatch Contract

### 5.1 现状

```ts
// decision.ts:761-763（DecisionApplicationContext 的可选能力）
readonly dispatch: () => Promise<boolean>;
```

`boolean` 不足以回答"准入 vs 完成"（§九 的歧义），也不携带 attempt identity。

### 5.2 三个方案对比（§七）

| | 方案 | 返回 | 优点 | 致命问题 |
|---|---|---|---|---|
| **A** | `dispatch()` 返回 `ExecutionResult` | 完整执行结果 | loop 直接知道发生了什么 | §十/§十二 只需**准入**知识；把 `RunResult` 拉进 loop 会让它成为 execution-result 的**第二持有者**，并诱使 loop 自行推导 task transition → **接近第二 Execution Authority** |
| **B** | 只返回 `accepted / rejected` | boolean（现状） | 最小、不会越权 | 正是当前 dead-path：无法区分 admitted 与 finished，且 `tick` 无法被携带 |
| **C** | 返回 typed dispatch receipt（含 `attemptIds` / `evidenceRef`），执行事实仍从 AttemptStore 读 | 收据 | 恢复 loop 的表示能力，**不复制**执行事实；字段可逐条标注 authoritative/derived/unknown | 需要一次类型收窄（本轮只设计） |

### 5.3 推荐：C（Dispatch Receipt）

理由来自现有 authority 结构，而不是偏好：

- **loop 不应拥有 execution result。** loop 的职责是"选一个 action 并施加它"。把 `RunResult`
  交给它（方案 A）会让 `applyDecision` 有机会基于结果做第二次决定——本项目的 fail-closed 原则
  与 "no automatic retry/replan"（§十五）都要求它没有这个能力。
- **loop 需要的是一个可引用的凭据，而不是事实本身。** 真正的执行事实已经在 `AttemptStore`
  （append-only、冻结、有 `attemptId`）。收据只需把它们**指出来**。
- **方案 B 已被现实验证为不足**：生产报告不得不绕道 `wb.evidence.history()` 反读，这正是
  "dead-path" 的代价。

### 5.4 契约（命名可改，形状不可增删语义）

```ts
/** 一次 dispatch 的收据。ADMISSION 事实，不是 execution 事实。 */
interface DispatchReceipt {
  readonly dispatchedAt: number;            // authoritative：收据产生时刻
  readonly admitted: readonly string[];     // authoritative（来自 TickResult）
  readonly waiting: readonly string[];      // authoritative：ready 但无 slot
  readonly skipped: readonly { taskId: string; code: string; reason: string }[];  // authoritative
  readonly reentrant: boolean;              // authoritative：true = 被 tick 重入保护拒绝
  /** 本次 tick 真正产生 attempt 记录的任务 → attemptId 列表。 */
  readonly attemptIdsByTask: Readonly<Record<string, readonly string[]>>;
  /** 每任务一条，用于区分 'admitted' 与 'finished'。 */
  readonly outcomes: readonly {
    readonly taskId: string;
    readonly admitted: boolean;
    /** `true` = 已终态（RunResult 已拿到）；`false` = 仅准入。 */
    readonly finished: boolean;
    /** authoritative when finished；否则 'not-observed'。 */
    readonly terminalState?: TerminalState;
  }[];
}
```

**"started / accepted / finished" 的消歧（§九）**：

| 词 | 含义 | 证据 |
|---|---|---|
| `accepted` | 进入 `tick.admitted` | `TickResult.admitted` |
| `started` | `executeTask` 已过 gate 且已 `planned→queued→running` | `TaskStore.status === 'running'`（`orchestrator.ts:713`） |
| `running` | 同上，且 `hasLiveRun(taskId) === true` | `orchestrator.ts:989` |
| `finished` | 已拿到 `RunResult` 且已 `applyRunResult` | `ExecuteOutcome.ok === true` |
| `failed`（execution） | 进程失败/超时/无 runtime/无 cwd/`applyRunResult` 被拒 | `ExecuteOutcome.ok === false` + `code` |

**当前 round 是同步的**（`executeTask` 会 await 到结果），因此收据里的 `finished` 在一次
`dispatch()` 返回时就已确定。**但契约必须为异步保留位置**：`finished: false` 是合法状态，
消费方不得把它读作失败。R2-2 若引入 lease/心跳，`finished` 可能滞后，届时**不可以**
用"收据里没有"替代"还没有"。

### 5.5 实现方式（本轮不实现，仅记录）

`decision-loop.ts:322` 的 spread 语义本身可以保留（它保证 `applyDecision` 仍决定哪个能力可用），
但必须补一条**编译期约束**：`DecisionApplicationContext` 中 `dispatch` 的返回类型从
`Promise<boolean>` 收窄为 `Promise<DispatchReceipt>`，于是：

- 默认闭包（`decision-loop.ts:315`）返回它刚捕获的那个 tick 的收据；
- `capabilities.dispatch`（`workbench.ts:386`）**必须**返回同形收据——不能只回一个 boolean，
  也不能丢弃 `DispatchOutcome.tick`；
- `report.ok`（`round-cli.ts:715`）与退出码**不读收据**，行为不变。

这样"被注入的 dispatch 覆盖默认 dispatch"从**静默语义漂移**变成**类型强制的同一契约**。
判据：`tests/state-loop.test.ts:552,564,580,599` 与 `tests/review-loop.test.ts:726,742` 都用
`dispatch: async () => … true`，收窄后这些测试会**编译失败**——这正是契约生效的证据，
也是 R2-2 落地时需要同步的测试改动（§24 要求本轮不实现）。

---

## 6. Execution Result Contract

### 6.1 唯一执行结果对象

```text
RunResult（core/types.ts:208）        ← 进程终态，冻结，唯一 execution result
   │
   ├─→ Orchestrator.applyRunResult    → TaskStore（workflow fact）
   └─→ AttemptStore.append            → AttemptRecord（execution fact, 冻结）
```

`RunResult` 是**瞬态**的（不持久化）；它的**持久化形式**是 `AttemptRecord`
（`attempt-record.ts:78`，由 `executionAttempt()` 从 `RunResult` 投影，`attempt-record.ts:274-290`）。

**因此：不存在"第二个 execution result 存储"的需求。** `AttemptRecord` 就是它。

### 6.2 写回顺序（源码事实）

```ts
// orchestrator.ts:970-985
this.releaseClaim(task.taskId, claimedScope);        // R2-1 claim 先释放
const applied = this.applyRunResult(task.taskId, result);   // ① TaskStore 先变
if (!applied.ok) return { ok: false, code: applied.code, … };  // ⚠️ run 被丢弃
return { ok: true, task: applied.task, run: result, … };      // ② 调用方才拿到 run
// ③ 之后（workbench.ts:662）才写 AttemptStore
```

顺序含义（容易被写错的点）：

1. **TaskStore 先于 AttemptStore。** 因此存在"任务已变、证据未写"的窗口 → Failure Matrix F4。
2. **claim 在结果写回之前释放**（`:970`），所以 `to_verify` 的任务不再持有写 claim——这是
   R2-1 的有意决策（`releaseClaim` 注释：不再写入的任务继续持有会无谓阻塞他人）。
3. **`applyRunResult` 被拒时 run 被丢弃**（`:974-976`）：`ok:false` 返回体里**没有** `run`
   字段，调用方再也看不到这次真实执行 → Failure Matrix F5（**现存缺陷，本轮只记录**）。

### 6.3 谁可以推导 task transition

**只有** `applyRunResult` / `applyVerification`（经 `translate*`）。Decision Loop、Workbench、
Observer **一律不得**从 `RunResult` 或 `AttemptRecord` 推导 task 状态。这条是防止
"第二 transition 路径"的核心约束。

---

## 7. Attempt Identity

### 7.1 现状（§十 要求的字段逐项核对）

`AttemptRecord`（`attempt-record.ts:78-100`）已有：

| 需要 | 现状 | 来源 |
|---|---|---|
| `attemptId` | ✅ | `attempt-store.ts:129-131` 生成（`att_xxxx`），或调用方显式提供 |
| `taskId` | ✅ | 调用方 |
| `previousAttemptId` | ✅ | **由 append 顺序决定**，不接受调用方声明（`attempt-store.ts:140-146`）——历史不可伪造 |
| `agentId` / `modelId` | ✅ | 调用方（review 时是 reviewer 的 id） |
| `taskType` | ✅ | 调用方 |
| `outcome` | ✅ | `executionAttempt` 从 `RunResult.state` 投影 |
| `startedAt` / `finishedAt` | ✅ | `RunResult.startedAt/endedAt` |
| `errorCode` | ✅（可选） | `RunResult.error.code` |
| `verification` | ✅（review 时） | `ReviewVerdict` |
| `assignmentId` | ❌ **不存在** | 无 assignment 记录概念 |
| `sessionId` | ❌ **不存在** | session 属 `SessionRegistry`（`workbench-sessions.ts`），AttemptStore 刻意不持有 |
| `leaseVersion` / `fencingToken` | ❌ **不存在** | R2-2 |
| `dispatchAcceptedAt` | ❌ **不存在** | 无 admission 时间戳（admission 只存在于 `TickResult` 内存中） |

### 7.2 结论

**复用，不要造第二套 execution ID。** `attemptId` 已经是唯一 attempt identity，
且 `previousAttemptId` 由 append 顺序保证不可伪造——这正是 R2-2 需要的链式基础。

**最小增量（R2-2 设计，不在本轮实现）**，按"能不加就不加"排序：

1. `leaseVersion?: number`（可空，`null` = 尚无 lease 系统）→ 放 `AttemptRecord`，
   与 `ResourceClaim.leaseVersion`（`resource-claim.ts`，已预留且**未强制**）保持同一约定。
2. `dispatchAcceptedAt?: number` → 只有真的需要度量"准入到完成"的排队时间才加；
   现在**不加**，因为 `TickResult` 不持久化，加一个只有收据能填的字段会制造
   "永远为 null 的字段"。
3. `sessionId` → **不加**。需要 session 归因时经 `SessionRegistry.sessionForTask(taskId)`
   现查（`workbench-sessions.ts:149`），不复制进证据。

---

## 8. Result Persistence

| 对象 | 持久化？ | 说明 |
|---|---|---|
| `RunResult` | ❌ 瞬态 | 只在一次 `executeTask` 内活 |
| `AttemptRecord` | ✅ append-only | **执行事实的持久化形式**（进程内；跨进程持久化仍是已知的 not-implemented） |
| `TickResult` | ❌ 瞬态 | dispatch 事实，随 cycle 消失 → 因此**收据必须被产出，否则信息永久丢失** |
| `TaskStore` | ❌ 内存 | workflow fact；同样待后续持久化 |
| `round-state.json` / `round-events.jsonl` | ✅ 文件 | **observation**，非权威（见 §9） |

**关键推论**：`TickResult` 是**唯一**承载"这次准入到底发生了什么"的对象，而它不持久化。
所以 `DispatchReceipt` 的价值不是"再存一份"，而是**在 `TickResult` 消失之前把它交到需要它的
那一层**。这不是新事实源——它是同一事实的一次传递。

---

## 9. Observation Contract

```text
Execution Truth                ← RunResult / AttemptStore / TaskStore
    ↓  (只读派生)
Observation                    ← observeTasks() / execution-monitor.buildExecutionSnapshot()
    ↓  (只写文件，单向)
round-state.json / events      ← round-observation
    ↓  (只读 HTTP GET)
Dashboard
```

**允许**：从 `TaskStore` / `WorkspaceManager` / `SessionRegistry` **读**并派生。
**禁止**：Observer 推断 production truth、写回任何 authority、或作为任何决策的输入。
**缺失即如实**：读不到的字段为 `null` / `unknown` / `not observed`；
`to_verify` 阶段的 run duration 就是 `null`（`execution-monitor.ts` 的 elapsed 语义），
因为 store 并未记录 run 结束时刻——**不得**用 `now - startedAt` 填充（那会把 Codex/人工
review 的等待时间报成执行时间）。

当前实现已符合本契约（`execution-monitor.ts` type-only import、零 I/O；
`round-observation.ts` 只写；bridge 只 `GET`）。本契约不修改它。

---

## 10. Stale Result Boundary

将来 R2-2 要防的是：一个**过期的执行结果**（旧 lease / 已被 reassign 的任务）被写回，
从而覆盖新 worker 的工作。

**结论：fencing 的最终校验点是 `Orchestrator.applyRunResult`（`orchestrator.ts:575`）。**

理由（源码级）：

1. 它是**唯一**把 `RunResult` 变成 task 状态的入口（全仓调用点 1 处：`orchestrator.ts:973`）。
2. 它**已经**在做同类的所有权校验：`result.agentId !== task.agentId → agent-mismatch`
   （`orchestrator.ts:580-588`）。fencing 是这条检查的自然延伸，不是新机制。
3. 它在 `mutate` **之前**，因此可以在**任何状态改变之前**拒绝（fail-closed）。
4. 拒绝形状已存在：返回 `MutateOutcome.ok === false` + `code`，调用方（`executeTask:974`）
   已经会把 `ok:false` 变成 `ExecuteOutcome.ok === false`。

**所有真实结果写回路径（完整枚举，供 R2-2 逐条覆盖）**：

| # | 路径 | 写 TaskStore | 写 AttemptStore | 需要 fencing |
|---|---|---|---|---|
| 1 | `executeTask` 正常终态 → `applyRunResult`（`:973`） | ✅ | 由调用方随后写 | ✅ **主入口** |
| 2 | `executeTask` `handle.result()` 抛错 → `mutate(…,'failed')`（`:966`） | ✅ | — | ✅（同样要拒 stale） |
| 3 | `executeTask` `runtime.run()` 抛错 → `mutate(…,'failed')`（**`runtime-rejected-run`**） | ✅ | — | ✅ |
| 4 | `executeTask` `applyRunResult` 返回 `ok:false`（agent-mismatch） | ❌ | ❌ | —（已有拒绝；见 §6.2 缺陷） |
| 5 | `applyVerification`（review / complete） | ✅ | review 记录由 workbench 写 | ⚠️ 属于 verdict 而非 run result；R2-2 需单独判定 |
| 6 | 准入拒绝（spawn gate / workspace / **resource admission**） | ❌（保持原状态） | ❌ | —（根本没执行，无 stale 概念） |

`fencing check should sit here:` **`Orchestrator.applyRunResult`（`orchestrator.ts:575`），
并覆盖上表 #2 / #3 两条同样会 mutate 的失败分支。**

---

## 11. Failure Matrix

每项：source of truth / detect / allowed response / retry / authority。
**所有项都不允许通过新增第二事实源来解决。**

| ID | 情形 | Source of truth | Detect | Allowed response | Retry? | Authority |
|---|---|---|---|---|---|---|
| F1 | decision applied，但 dispatch 被拒（gate / quota / dependency） | `TickResult.skipped` + `application.applied=false` | `DecisionApplication.applied === false` 或收据 `admitted.length === 0` | 报告 refusal code，**不改任务状态** | ❌ 不自动 | Spawn Gate / Scheduler |
| F2 | dispatch accepted，但原生进程从未启动（spawn 失败） | `ExecuteOutcome.ok=false`（`runtime-rejected-run`） | `executeTask` catch 分支 | 任务 `failed`，reason 携带真实 message | ❌ 不自动（`retry` 是 Laya 的显式 action 且需 `--retry-max`） | Orchestrator |
| F3 | 原生启动后失败 / 超时 | `RunResult.state` | `translateRunResult` → `failed` | 任务 `failed`；**不是** `to_verify` | ❌ 不自动 | Execution Edge → TaskStore |
| F4 | 原生成功，但证据持久化失败 | `TaskStore`（`to_verify` 已成立）；AttemptStore 缺记录 | `DispatchOutcome.evidenceDegraded === true` / `recordExecution` 返回 `null` | **不回滚任务**（run 真的发生过）；报告降级 | ❌ | 调用方（best-effort） |
| F5 | 结果写回被拒（agent-mismatch）→ run 被丢弃 | `applyRunResult.ok=false` | `ExecuteOutcome.ok=false` + `code='agent-mismatch'` | 当前：任务状态不变，**run 无法被消费**（现存缺陷，见 §6.2） | ❌ | Orchestrator |
| F6 | TaskStore 已更新，但 Decision Loop 没拿到结果 | `TaskStore`（权威）；loop 的 `results` 为空 | 收据 `finished` 与 loop 采集不一致 | **重新 observe**（下一 cycle 从 TaskStore 读）——权威从未丢失 | ❌ | Observation（只读） |
| F7 | 重复执行结果 | AttemptStore append-only；`attemptId` 唯一 + `previousAttemptId` 链 | `attempt-id-duplicate`（`attempt-store.ts:135`） | 拒绝写入，保留第一条 | ❌ | AttemptStore |
| F8 | 延迟结果（异步 / lease 心跳之后才回） | `RunResult` + 收据 `finished:false` | 收据明确说"尚未完成" | **不得**当作失败；等待或下一 cycle 观察 | ❌ | 契约（§5.4） |
| F9 | 过期结果（旧 lease / 已 reassign） | TaskStore 的当前 identity + lease | R2-2 fencing（`applyRunResult`，§10） | 拒绝写回，`code='stale-result-refused'`（R2-2 命名） | ❌ | Orchestrator（未来） |
| F10 | 被 reassign 的任务返回**旧 worker** 的结果 | TaskStore 的 `agentId` | **已实现**：`agent-mismatch`（`orchestrator.ts:580`） | 拒绝（现状）→ R2-2 升级为 stale-refused | ❌ | Orchestrator |
| F11 | verification 失败（reviewer 拒绝） | `ReviewVerdict` → `applyVerification` | `status='verification-refused'` / `failed` | 有界 rework（`maxAttempts` + fingerprint 双 guard），**不回 Laya 重规划** | 有界 | Review Loop |
| F12 | Human Gate 等待 | 任务停留 `to_verify` | 状态本身 | 报告 + 退出码；**END** | ❌ | 人类 |
| F13 | dashboard 收不到 observation | `round-state.json` 不存在 | bridge `NOT OBSERVED` | 显示 `LIVE DATA DISCONNECTED`；**不影响执行** | n/a | Dashboard（只读） |
| F14 | dashboard 数据过期 | `updatedAt` 与 now 之差 | `stale` 超 60s | 显示 `STALE` + 最后更新时间 | n/a | Dashboard（只读） |
| F15 | observation 文件损坏 / 半写 / BOM | 文件本身 | bridge `UNREADABLE`；normalize 兜底 | 降级显示，不崩、不影响执行 | n/a | Dashboard（只读） |

**"failed" 词表纪律（§十五）**：以下五件事**永不**共用 `failed`：
`dispatch rejected`（→ refusal code）、`execution failed`（→ 任务 `failed`）、
`verification failed`（→ `failed`，但来源是 verdict）、`review rejected`（→ `rework`/`failed`）、
`human_gate waiting`（→ `to_verify`，**不是失败**）。

**禁止**：`execution failed → 自动 retry`。`retry` 只能来自 Laya 的显式 action 且必须带
`--retry-max`（默认 0 = capability OFF，`round-cli.ts`）。

---

## 12. R2-2 Fencing Preconditions

> **状态（2026-10-03）：已实现。** 下列 7 条前置条件全部落地，实现在
> `src/orchestration/assignment-lease.ts`（纯函数）、`store.ts`（lease 生命周期）、
> `orchestrator.ts`（fencing 边界）、`resource-claim.ts`（§7.1 绑定）、
> `attempt-record.ts`（`leaseVersion`）。测试担保见 `tests/assignment-lease.test.ts`（179 项）
> 与 `tests/native-agent-e2e.test.ts` Case 17（真实 agent 中途被 supersede）。

R2-2（Lease / Fencing）开始前需要满足以下**接口前置条件**。

1. **fencing 入口已确定**：`Orchestrator.applyRunResult`，并覆盖 `executeTask` 内另两条
   mutate 分支（`runtime.run()` throw / `handle.result()` throw）。
   ✅ 三条路径全部 fail-closed。
2. **权威值是 task，不是 claim。** 校验依据是 `TaskStore` 当前记录。
   ✅ `checkFencing(current = task 的 agent/leaseVersion/fencingToken, presented)`。
   ⚠️ 修正：早期实现把 `current.agentId` 填成了 `result.agentId`，使 agent 比较自证无效。
3. **`RunResult` 不携带 lease 线索**，由 `executeTask` 在 dispatch 时捕获并在写回时比对。
   ✅ `PresentedLease`（agentId + leaseVersion + fencingToken）；`ExecuteOutcome.leaseVersion`
   把**执行时**的版本带给证据层。
4. **拒绝形状复用现有约定**：`MutateOutcome.ok=false` + `code`。✅ 未引入新返回类型。
5. **dispatch 收据先于/同时落地。** ✅ `capabilities.dispatch: () => Promise<DispatchReceipt>`。
6. **claim 的 `leaseVersion` 由预留字段变成被校验字段。** ✅ `claimIsLeaseCurrent` +
   `voidClaimsWhere` + 准入 `lease-not-live` 拒绝。
7. **不得新增 result store。** ✅ 未新增；被拒执行仍写入既有 `AttemptStore`。

### 12.1 实际拒绝码（实现后）

| code | 含义 | 触发条件 |
|---|---|---|
| `agent-mismatch` | 归属不符 | task 无 agent；或 presented agent ≠ 当前 agent（**同版本**）；或 result agent ≠ dispatched agent（证据完整性） |
| `fencing-token-missing` | 无法证明新鲜 | 权威记录无 lease；或调用方未 present lease |
| `stale-lease-version` | 已过期 | presented version ≠ 权威 version（含 presented 更新） |
| `fencing-token-mismatch` | 冒充 | 版本与 agent 都对，token 不符 |
| `lease-revoked` / `lease-expired` | **编排器层**，非 `checkFencing` | lease 已 revoke/expire（version/token 仍匹配），拒绝迟到结果 |

**version 先于 agent 判定是有意的**：reassignment 同时改 agent 与 version，先判 agent 会把
每个 superseded 结果报成 `agent-mismatch`，掩盖"你已经落后"这一事实。

---

## 13. Open Questions

1. **收据的落地时机**：先收窄 `DecisionApplicationContext.dispatch` 的类型（会让 6 处既有测试
   编译失败），还是先让 Workbench 的能力返回真实 tick、暂不动类型？前者是契约，后者是补丁。
2. **`DispatchReceipt.attemptIdsByTask` 的填充者**：AttemptStore 在 Workbench 手上
   （`workbench.ts:189`），而 `runDecisionCycle` 只拿得到 capability。收据里放 attempt id
   意味着**写证据的那一步必须回传 id**（`AttemptStore.append` 已经返回 `record.attemptId`，
   `attempt-store.ts:154`，但 `recordExecutions` 目前只返回 taskId，`attempt-integration.ts:98`）。
   这是最小改动点，也是需要决定归属的地方。
3. **F5 缺陷是否要在 R2-2 之前修**：`applyRunResult` 被拒时 run 被丢弃，导致"真实执行过但没有
   任何证据"。 ✅ **已关闭**（见 §13.1）。
4. **`to_verify` 的 run 结束时刻**：当前 store 不记录（因此 elapsed 为 `null`）。
   若要精确度量执行时长，需要 `TaskStore` 在 `running → to_verify` 时记录 `finishedAt`，
   但这会改动 task 语义（`finishedAt` 目前只表示终态）→ 需单独决策。**仍未决。**
5. **`succeeded` 的 run duration 同样不可得**：任务进 `to_verify` 后可能停留很久才被验证，
   `finishedAt` 记的是**验证**时刻而非执行结束时刻，因此终态 elapsed 也含 review 等待。
   这是同一问题的另一面。**仍未决。**

### 13.1 F5 / F1 关闭记录（2026-10-03）

核心语义：**Task mutation rejected ≠ Execution evidence discarded。**

```text
ExecuteOutcome.ok === false
  ├─ run 不存在        → runtime 从未启动 / 准入被拒 → 无执行证据（notRecorded）
  └─ run 存在          → 真实执行已发生，仅写回被拒 → 记录证据（recorded）
                          ├─ AttemptRecord.agentId      = 实际执行 agent（非当前 holder）
                          ├─ AttemptRecord.leaseVersion = 执行时的版本（stale，不改写）
                          ├─ outcome.runRejected         = true
                          └─ attemptIdsByTask[taskId]    含该 attempt id（F1 修复）
```

`leaseVersion` 记录的是**执行时**的事实，绝不改写成 task 当前的版本——否则 superseded 的
attempt 会被洗成当前 holder 的历史，这正是 fencing 要阻止的污染，只是换了个入口。

F1 修复：`recordExecutions` 的 refused 分支此前记录了证据却丢弃了 attempt 指针，
导致 receipt 无法指向唯一最需要被指认的那次执行。

---

## 14. Explicit Non-Goals

本轮**不做**以下任何一项，且本文件不构成对它们的承诺：

```text
❌ runtime implementation（decision-loop / workbench / orchestrator / scheduler 一行未改）
❌ Lease / Fencing 实现（R2-2）
❌ 新增 authority / result store / scheduler / execution edge
❌ 自动 retry / replan / autonomous recovery
❌ Collaboration Protocol（R2-3）/ Context Gate / Packets（R2-4）
❌ Advisor / Fast Router / Decision Batching（future research）
❌ 修改 Observation 或 Dashboard 契约（当前实现已符合 §9）
❌ commit / push / reset
```

**与基线的关系**：本设计文档本身不要求任何测试改动。§5.5 的类型收窄在落地时**故意**让 6 处
使用 `dispatch: async () => … true` 的既有测试编译失败——那是契约生效的信号，属于 R2-2 的
实现工作，不是回归。R2-2 已完成该收窄，那 6 处改为返回真实 `DispatchReceipt`
（`state-loop.test.ts` / `review-loop.test.ts`），并额外断言"空 receipt ≠ dispatch 失败"。

**未来 R2-2 需要新增的测试（设计，不实现）**：

1. `applyRunResult` 收到 stale lease → `ok:false` + `stale-result-refused`，且**任务状态不变**。
2. 同一 `attemptId` 重复写回 → 第二次被拒（沿用 `attempt-id-duplicate` 语义）。
3. reassign 之后旧 worker 的结果 → 被拒（今天是 `agent-mismatch`，R2-2 后应同时是 stale）。
4. 收据在 `capabilities.dispatch` 覆盖后仍携带**真实** `admitted` / `finished`（即 dead-path 关闭）。
5. 收据 `finished:false` 不被任何消费者读作失败。
6. `evidenceDegraded`（F4）时任务**仍**进入 `to_verify`，且报告如实降级。
