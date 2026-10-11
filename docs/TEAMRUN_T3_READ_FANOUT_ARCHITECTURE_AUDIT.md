# TeamRun T3 READ-only Fan-out — Architecture Audit

Status: **T3-a.0 audit only. No runtime fan-out implemented.**
Owner-ratified precondition: `T1 = SEALED`, `T2-a = SEALED`, `T2-b = SEALED`, `T2 = SEALED`.
Scope of T3-a: **READ-only Worker fan-out**. Parallel WRITE remains closed.

---

## 0. Git Checkpoint Assessment

Read-only inspection (`git status --short`, `git diff --stat`, `git rev-parse`):

- `HEAD == origin/main == 56f6706d8934a92991396e89c305275a3b1d9a96` ✔
- Working tree: **49 modified files, 5085 insertions / 312 deletions**, plus 13 untracked paths
  (including `.gitattributes`, `.zcodeignore`, `scripts/`, and several `src/`+`tests/` files).

### T1/T2 separable from R5? → **NO — CHECKPOINT DEFERRED**

R5 and T1/T2 changes are **interleaved within the same files and functions**, so no file-level
(or safely achievable hunk-level) boundary exists. Marker counts per file's diff:

| file | R5 markers | T1/T2 markers |
|---|---|---|
| `src/cli/round-cli.ts` | 11 | 8 |
| `src/orchestration/execute.ts` | 11 | 6 |
| `src/orchestration/orchestrator.ts` | 33 | 3 |
| `src/orchestration/workbench.ts` | 3 | 16 |
| `tests/workbench.test.ts` | 7 | 7 |
| `tests/handoff-production-round.test.ts` | 1 | 15 |
| `src/orchestration/scheduler.ts`, `tests/orchestration.test.ts` | small | small |

**Blockers to a selective checkpoint:**
1. Same-function interleaving (e.g. `execute.ts` carries the R5 deadline path AND the T2-b
   contract injection; `orchestrator.ts` is R5-dominant with T2 hooks in the same dispatch body).
2. R5 is **unresolved/unclosed** — its hunks must not be checkpointed, yet they are not separable.
3. `.gitattributes` is **untracked** and LF→CRLF churn is live; checkpointing without deciding
   EOL policy risks renormalisation noise.
4. No isolated T1/T2 subset has a verified green run independent of the R5-modified runtime
   files (`spawn.ts`, `session.ts`), so a partial commit could not be proven testable.

**Recommendation: `CHECKPOINT DEFERRED`.** Do not commit. The migration is complete and green as
one working tree; splitting it requires R5 to first be closed or explicitly quarantined, and an
EOL policy (`.gitattributes`) to be committed as its own first change.

### Doc hygiene fix applied (comment-only, no behaviour)
`src/orchestration/worker-execution-contract.ts` header previously described the injection as
"gated on `mode === 'default'`", which T2-b.1 superseded. Rewritten to state the injection is
**unconditional and separated by the seam**, that `mode` is a transport profile and not a role, and
that neither `mode` nor `agentId` decides the role. `npm run typecheck` clean.

---

## 1. Current Single-Worker Assumptions (the core finding)

The system models **one logical execution per `taskId`**, enforced in five independent places:

| Layer | File:line | Assumption |
|---|---|---|
| TaskStore | `task.ts:65-83` | `running` is a single exclusive scalar; only edge in is `queued -> running`; no `running -> running`. No per-task execution id. |
| Scheduler | `scheduler.ts:169-185` | `candidates()` = `status ∈ {planned, queued}`; `occupiedSlots()` counts each `running` task once. A running task is never re-candidated. |
| executeTask | `orchestrator.ts:817`, `:1173-1184` | Refuses non-`{planned,queued}`; then transitions `planned->queued->running`. A second concurrent call loses at the transition (`transition-not-allowed`). |
| Leases | `store.ts:154`, `:413-433` | `Map<taskId, AssignmentLease>` — **one** live lease per task; `leaseId = lease:${taskId}:${leaseVersion}`. |
| SessionRegistry | `workbench-sessions.ts:163-171`, `:237-247` | `sessionByTask` is `taskId -> one sessionId`; `recordUse` **overwrites**. `sessionForTask` returns the last one only. |
| Live handles | `orchestrator.ts:315` | `liveHandles` — one `RunHandle` per taskId. |

`EXECUTABLE_STATUSES = { planned, queued }` (`execute.ts:289-294`). `TASK_TRANSITIONS` has no
second entry into `running`.

**Consequence:** "N concurrent Workers for one `taskId`" is not merely unsupported — it is
structurally contradictory with the TaskStore scalar, the single lease, the single session
binding and the single live handle. Making attempts-on-one-task work would require replacing the
core lifecycle scalar with an execution set (per-`(taskId, executionId)` status + lease), i.e. a
control-plane rewrite. That is explicitly **not** the reuse-first path.

**The one structure already shaped for N:** `AttemptStore.byTask` is `taskId -> [attemptIds]`
(`attempt-store.ts:89-92,168-172`). But attempts form a **sequential chain** (`previousAttemptId`,
`attempt-record.ts:137-144`) and are evidence only — they do not admit or track concurrent
in-flight executions.

---

## 2. Fan-out Authority Model

The authority split must remain (and the recommended design respects it):

- **Planner = Task decomposition authority.** It produces a Task/DAG and the shape vocabulary
  (`single | chain | parallel | diamond | levels:N`, `planner.ts:125`).
- **Laya = execution topology + Agent×Model semantic decision.** Whether one Task is executed by
  1 or N Workers is an *execution* decision, not a decomposition.
- **Assignment = pair enforcement.** Given a requested Worker/pair it answers *admissible?* It
  never decides the count, and never silently substitutes a pair.
- **Scheduler = dispatch authority.** One tick dispatches each candidate task at most once.

The existing decision vocabulary has **no topology/fan-out/worker-count** concept:
`IMPLEMENTED_ACTIONS` (`decision.ts:56-60`) = continue/wait/abort/rework/replan/retry/reassign/
add_task/split_task/parallelize/complete. `split_task.into` / `parallelize.width` are **piece
counts** consumed as planner shapes (`decision.ts:1094-1124`), not worker counts; `parallelize.width`
is even ignored by the workbench capability (`workbench.ts:684` → fixed `parallel`).

So T3 needs a **Laya topology decision** that is a *sibling preset* to the existing initial
Agent×Model decision, not a change to the action vocabulary.

---

## 3. Recommended Fan-out Representation — **N READ child Tasks, grouped**

### The single recommendation

> Materialize fan-out as **N sibling child Tasks** (one per READ Worker) under the logical parent,
> with `taskType` in `{review, research}` (or an explicit `read` claim), created through the
> **existing** plan/commit path, each independently assigned through Assignment, each with its own
> session and attempt; tie them to the logical unit with a **thin typed fan-out provenance
> record**. Aggregate deterministically from the existing per-attempt evidence.

### Why child Tasks (REUSE) and not executions-on-one-task (NEW control plane)

- Concurrency is **per task** in the scheduler (`scheduler.ts:169-185,260-341`) and `executeTask`
  is entered per task. N children = N slots = N executions, with **zero** scheduler change.
- **READ sharing is already safe:** `claimModeFor` maps `review|research -> 'read'`
  (`round-cli.ts:571-572`); `modeRequiresIsolation('read') === false` (`resource-claim.ts:277-279`);
  `claimsConflict` allows read+read and read+write (`resource-claim.ts:258-274`);
  `mayShareWorkspace('read', parallel) === true` (`workspace.ts:350-352`) so READ children get
  `'shared'` cwd (`round-cli.ts:604-610`). No worktree, no containment, no write exclusivity.
- Per-child lease/session/attempt all already work: each child taskId gets its own lease
  (`store.ts:154`), its own `sessionByTask` binding (`workbench-sessions.ts:237-247`), and its own
  attempt chain (`attempt-store.ts:143-155`).
- Aggregation/review/gate already handle N tasks: `RoundResult.machine.tasks` (`round-result.ts:470-493`),
  the gate tally over executable tasks (`round-result.ts:903-909`), and `ReviewPacket.tasks`
  (`unified-review.ts:322-339`).
- Capacity is a **global** count of running child tasks (`orchestrator.ts:466-471`), **not** a
  per-agent family lock — so "same Agent, N Workers" is allowed as long as the single global
  `maxConcurrentAgents` budget admits them. No `Agent busy = true` is introduced (§2 of brief).

### Task / Worker / Session / Attempt relationship

- **parent Task:** the logical unit. It is a **grouping container**; the parent itself is not the
  execution — the N children are. (In the `parallel` shape this is exactly the existing root +
  siblings topology.)
- **Worker:** `WorkerIdentity = { taskId, agentId, modelId, sessionId }` (`worker-identity.ts:55`).
  Distinct child `taskId` ⇒ distinct Worker by construction, even for same Agent+Model.
- **Session:** one per child taskId (`sessionByTask`), so each Worker has its own session. This is
  the gap-avoiding choice: the brief's §10 asks whether `sessionForTask` supports many sessions per
  task — it does **not** (last-wins), so we must **not** reuse one taskId for N Workers.
- **Attempt:** one execution attempt per child, plus any retry/rework chain, all already distinct
  by `attemptId` and carrying `agentId/modelId/sessionId` (`attempt-record.ts:78-145`).

### The only genuinely NEW value

A **thin, pure fan-out provenance value** (data/evidence, never authority), e.g.:

```
FanoutProvenance {
  groupId: string
  parentTaskId: string
  mode: 'read'
  members: readonly { taskId: string; agentId: string; modelId: string; scope: string }[]
  requestedBy: 'laya'
}
```

It only records what Laya requested and which child Tasks realized it. It selects no Agent/Model,
dispatches nothing, and decides nothing. `new authority = 0`.

---

## 4. READ-only Safety Model

- **workspace:** READ children share one cwd (`mayShareWorkspace('read', *) === true`). No worktree.
- **claims:** read+read and read+write are non-conflicting (`claimsConflict` → false); the documented
  half-written-read assumption is unchanged (`resource-claim.ts:26-34`).
- **lease:** each READ child holds its own task lease (one per taskId). No new lease multiplicity is
  required because each child is a distinct task. (If fan-out were attempts-on-one-task, the single
  lease map would block it.)
- **Windows containment boundary:** READ fan-out proves **nothing** about WRITE fan-out. R5
  containment is still open (natural root exit can leave a descendant writer; `taskkill /T` can miss
  orphan grandchildren; cross-process stale workspace-lock reclaim is unsafe). Therefore T3 must not
  open parallel WRITE; a WRITE child in a fan-out must be refused/deferred (§Scenario F8).

---

## 5. Scheduling

- **same Task:** cannot appear twice; the scheduler dispatches each taskId once. Fan-out therefore
  MUST be N tasks, never N ticks of one task.
- **capacity:** one global `maxConcurrentAgents` budget (`orchestrator.ts:466-471`, `getConcurrencyLimit`
  `:391-393`), compared `current >= limit` (`spawn-gate.ts:74-79`). Fan-out width is bounded by this,
  and by `maxChildren` per parent (`orchestrator.ts:521-528`, CLI default 3).
- **start:** one `scheduler.tick()` admits up to `maxConcurrency` of the READ children in the same
  tick (no dependencies between them ⇒ all are candidates). Confirmed by the `parallel` shape's
  intent ("no dependencies between them", `planner.ts:290-299`) and by `resource-claim`'s proven
  parallel-admission cases.
- **terminal:** each child reaches its own terminal status independently.

**Note (P1 gap):** `parallelize.width` is currently ignored and the `parallel` shape is hard-coded
to 3 siblings (`planner.ts:290-299`). Arbitrary N requires either a width-aware shape or an explicit
member list from Laya.

---

## 6. Aggregation

- **input:** the N children's attempts/evidence, already projected per attempt
  (`AttemptSummary`, `round-result.ts:252-275`) and per task (`TaskSummary`, `:109-134`).
- **output:** a **deterministic projection** grouping the children under the parent (via the
  `FanoutProvenance` groupId / `parentTaskId`). It combines typed evidence only.
- **failure representation:** every Worker's terminal evidence is retained individually. A failed
  Worker is a `failed` child with its own error/evidence. The aggregator must **not** silently drop
  it; continuation/补位 is a later bounded Laya decision, never automatic in the projection.
- The aggregator must **not**: decide which finding is true, replan, or select an Agent.

---

## 7. Unified Review / Human Gate

- **Unified Review:** one review over **all** execution results. Because the packet is per task
  (`ReviewPacket.tasks[]`, `unified-review.ts:322-360`) and already lists `attemptIds`, N child tasks
  are reviewable with **no packet shape change**. The reviewer stays an independent reviewer; it does
  not become a fan-out orchestrator. (N attempts of ONE task would NOT be naturally reviewable —
  another reason to prefer child tasks.)
- **Human Gate:** `deriveHumanGate` tallies executable tasks by status (`round-result.ts:903-909`);
  N children appear as N rows; `automaticPostRoundAction` stays `'none'` (`round-result.ts:1008-1023`).
  Fan-out must not reintroduce an automatic infinite rework/reassign loop.

---

## 8. Required Audit Scenarios (mechanical)

| # | Scenario | Mechanical outcome |
|---|---|---|
| **F1** | same Agent, same Model, different Sessions, 2 READ | 2 child tasks, same pair, distinct `sessionByTask` per child, both read-share one cwd, both admitted in one tick. Distinct Workers by `sessionId`. |
| **F2** | same Agent, different Models, 2 READ | 2 child tasks, different `modelId`; Assignment enforces each pair independently; distinct sessions/attempts. |
| **F3** | OpenCode + WorkBuddy Intl parallel READ | 2 child tasks, different `agentId`; both read-capable; shared cwd; global concurrency budget (not per-family) admits both. |
| **F4** | 3 READ, one fails | 3 children; the failed one keeps its terminal evidence; aggregation retains all; gate tally shows failure; no auto-continuation. |
| **F5** | one Worker unavailable before dispatch | its child refused by the gate (`no-capable-agent` / `no-available-agent` / `concurrency-limit`); child stays non-running with explicit refusal evidence; siblings proceed. |
| **F6** | one Worker times out after start | that child terminates via the existing deadline path; siblings unaffected. |
| **F7** | all finish → aggregation → Unified Review → Human Gate | deterministic projection over N child evidence → one review packet (N tasks) → gate tally → `automaticPostRoundAction: 'none'`. |
| **F8** | attempted READ + WRITE parallel mixture | **must remain blocked/deferred.** WRITE requires isolation; non-git parallel write is blocked (R2-1.1); Windows containment is unproven. Refuse or defer the WRITE member. |

---

## 9. Reuse vs New

**Reused unchanged:** TaskStore lifecycle + tree, Assignment exact-pair enforcement, SessionRegistry
(one session per child task), Scheduler per-task dispatch, leases (one per child task),
ResourceClaim read-sharing, WorkspaceManager shared mode, AttemptStore per-task attempt chains,
`WorkerIdentity`, round-result aggregation, Unified Review packet, Human Gate, observation read models.

**Minimal new (data/evidence, not authority):**
1. A typed **Laya topology decision** (`SOLO | PARALLEL_READ`) with, for `PARALLEL_READ`, a bounded
   member list `{ agentId, modelId, scope }`.
2. A thin **`FanoutProvenance`** record tying the child Tasks to one logical unit.
3. A **deterministic aggregation projection** over the group's child evidence.

**Explicitly NOT new:** no `FanoutManager`/`WorkerSessionManager`/`TopologyManager`, no second Task
state machine, no second scheduler, no family-level serial lock. `new authority = 0`.

---

## 10. Architecture Risks

- **P0 — attempts-on-one-task would break the core model.** Implementing fan-out as N executions of
  one `taskId` collides with: the `running` scalar (`task.ts:65-83`), the single lease
  (`store.ts:154`), the single session binding (`workbench-sessions.ts:163`), the single live handle
  (`orchestrator.ts:315`), and `candidates()` (`scheduler.ts:181`). Avoid; use child Tasks.
- **P0 — WRITE fan-out without containment.** Must stay closed until Windows process containment is
  proven. READ success is not evidence for WRITE.
- **P1 — no grouping/topology marker today.** Without `FanoutProvenance`, aggregation/review/gate
  cannot treat the N children as one logical unit (they would read as unrelated siblings).
- **P1 — width gaps.** `parallelize.width` ignored; `parallel` hard-coded to 3; `maxChildren` default 3.
  Arbitrary bounded N needs a width-aware path.
- **P2 — session last-wins.** `sessionForTask` is single-valued; any design that reuses one taskId for
  N Workers would silently misbind. Child tasks avoid this entirely.
- **P2 — R5 ownership.** The checkpoint cannot be split; R5 must be closed or quarantined first.

---

## 11. Recommended T3-a.1 Implementation Slice

**Exact scope (smallest verifiable):**
1. Add a Laya **topology decision preset** (sibling to `initial_agent_model`): a closed
   `SOLO | PARALLEL_READ` choice; for `PARALLEL_READ`, a bounded member list `{ agentId, modelId,
   scope }` decoded to a typed, orchestration-side-validated intent. No change to the action vocabulary.
2. Materialize `PARALLEL_READ` as **N READ child Tasks** under the parent, reusing the existing
   plan/commit path (width-aware), each child assigned independently through Assignment.
3. Enforce READ-only: a `WRITE`/`exclusive-write` member is refused in this slice.
4. Record `FanoutProvenance` (pure evidence).
5. Aggregation: deterministic projection grouped by the parent; retain every child's terminal evidence.
6. Wire the existing review packet / gate to the N tasks (no shape change expected).

**Tests:** a real production round with 2–3 READ children asserting: N concurrent dispatches; distinct
sessions and attempts per child; one shared cwd; no write claim; all evidence retained on partial
failure; review packet shows N tasks; gate tally correct; `automaticPostRoundAction: 'none'`; a WRITE
member is refused. Plus the mechanical F1–F8 cases.

**Explicit non-goals:** no parallel WRITE; no Windows containment work; no COMPETE/QUORUM (completion
is **ALL requested Workers terminal**); no worker↔worker chat; no second scheduler / Task state machine;
no new authority; no T4 Workstream/TeamRun.

**Completion semantics for T3-a.1:** `ALL requested READ Workers reach terminal` (simplest and
verifiable). Failure does not silently drop a Worker; continuation is a later bounded Laya decision.

---

## 12. Final Authority Truth (unchanged by this audit)

```
Laya          = topology + Agent×Model semantic decision
Planner       = Task planning / decomposition
Assignment    = pair enforcement
TaskStore     = Task state
SessionRegistry = Session authority
Scheduler     = dispatch authority
AttemptStore  = execution evidence
Aggregation   = pure evidence projection
Unified Review = independent reviewer
Human Gate    = round stop

new authority = 0
runtime.run production edge = 1
```

---

## Appendix — files read for this audit

`src/orchestration/task.ts`, `store.ts`, `scheduler.ts`, `execute.ts`, `orchestrator.ts`,
`assignment.ts`, `assignment-lease.ts`, `attempt-store.ts`, `attempt-record.ts`,
`workbench-sessions.ts`, `workbench.ts`, `workbench-plan.ts`, `planner.ts`,
`resource-claim.ts`, `workspace.ts`, `round-result.ts`, `unified-review.ts`, `decision.ts`,
`decision-loop.ts`, `worker-identity.ts`, `worker-execution-contract.ts`;
`src/decision/types.ts`, `src/decision/initial-assignment.ts`, `src/decision/routing.ts`;
`src/cli/round-cli.ts`, `src/cli/round-observation.ts`;
`src/quota/spawn-gate.ts`, `src/quota/types.ts`;
`tests/resource-claim.test.ts`, `tests/native-agent-e2e.test.ts`, `tests/assignment.test.ts`.

### T3-a.1 Implementation Result — IMPLEMENTED (READ-only fan-out)

本轮实现 `SOLO | PARALLEL_READ` 两种 execution topology。只允许 READ；parallel WRITE 仍关闭。

#### Recon 结论（复用优先）

- `replanSubtree` 的语义是"替换某个 task 的 children"，被替换的 task 本身不执行 —— 而 round 的 root
  (`depth 0`) 本来就是 container（`scopedTasks` 过滤 `depth > 0`，scheduler 从不调度 root）。
- 关键事实：`task.ts` 把 `depth` 固定为 `0 | 1`（`parentTaskId === null ? 0 : 1`）。因此唯一可承载
  fan-out 的 container 是 root，成员只能是 depth-1 children。inner-node fan-out（深度 2）不可表示，
  本轮明确不做。
- 复用：`commitPlan`（唯一写入路径）、`assignChildren`（exact-pair enforcement）、
  `SessionRegistry`（每个 child taskId 一个 session）、`Scheduler`（per-task dispatch）、
  `AttemptStore`（每 child 一个 attempt）、ResourceClaim read 共享、`WorkspaceManager` shared、
  `round-result`/Human Gate（N task rows）。**没有第二套 Task 状态机、没有 FanoutScheduler。**

#### Topology contract

- `src/decision/execution-topology.ts`：Laya 的 `execution_topology` 问题（choice `SOLO`/`PARALLEL_READ`），
  与 `initial-assignment.ts` 同构。`PARALLEL_READ` 的成员经 `answer.parameters.members`（JSON）返回。
  缺省/无拓扑意见 → SOLO（保持 T2 路径逐字不变）；malformed PARALLEL_READ → 抛错并拒绝整轮，
  **绝不静默降级为 SOLO**。
- 成员契约：`{ agentId, modelId, scope }`，宽度 `2..3`（与 `maxChildren` 基线一致）。
- **READ gate 在 topology validation（`validateFanoutMembers`），不在 ResourceClaim**：因为
  `claimsConflict` 对 read+write 返回 false，ResourceClaim 不会挡住 WRITE 成员。任何非 READ 成员
  （含 read+write 混合）拒绝整个 topology，materialize 之前 fail closed。

#### Materialization

- `NativeWorkbench.materializeReadFanout(rootTaskId, membersRaw)`：
  1. `validateFanoutMembers`（READ-only、2..3、完整 pair、非空 scope、去重）；
  2. 移除 container 尚未开始的 children（`partitionForReplan` + `removePlanned`，已开始的受保护）；
  3. 经 `commitPlan` 建 N 个成员 child，`taskType='research'`（`claimModeFor` → read，shared workspace），
     `acceptanceCriteria = scope`；
  4. 每个成员记录 `initialSelections`（Laya 的 pair），`assignChildren` 据此 exact-enforce，且
     `selectInitialAssignment` 对已有记录的 child 不再二次询问（不覆盖 Laya 决策）。
- `FanoutProvenance`（pure evidence）：`{ sourceTaskId, topology, members:[{taskId, memberIndex, agentId,
  modelId, scope, accessMode}] }`，仅用于分组/聚合/可观测；不参与任何决策。

#### Aggregation

- `projectFanoutAggregation(provenance, statusOf)`：按 `memberIndex` 稳定排序（**绝不按完成时间/Promise 顺序**），
  输出 `requested / terminalCount / allTerminal / nonSucceeding` 与每个成员的 status。
- 完成条件：**ALL requested members settled**（无 QUORUM/FIRST_SUCCESS/COMPETE）。`to_verify`
  视为"执行已结束"（成功执行的落点），`blocked` 视为 pre-dispatch refusal 的 settled 表示，
  仍计入 `nonSucceeding`。部分失败不丢成员：失败的成员保留在自己的 child Task 里。
- 聚合只 group/order/project/retain，不判定谁对、不 replan、不选下一个 Agent。

#### Downstream dependency

- 复用现有 `unmetDependencies`/`isTerminal` gate：依赖成员的下游 task 只有在**所有**成员
  terminal 后才变 ready。真实测试（`tests/read-fanout.test.ts`）证明：一个成员仍 `running` 时
  下游不派发；两者 terminal 后才派发。
- 注意语义差异：fan-out 聚合把 `to_verify` 视为 settled，而依赖 gate 用 `isTerminal`
  （不含 `to_verify`）。因此依赖 READ 成员的下游要等成员被 verification 接受（`succeeded`）后才 ready ——
  这是既有语义，不是本轮引入的。

#### Unified Review / Human Gate

- 每个成员是一个独立 Task，进入同一个 review packet（per-task，已支持 N tasks），reviewer 看到
  member/agent/model/scope/outcome/evidence；reviewer 仍只是 reviewer，不是 aggregator brain。
- Human Gate 统计 N 个 executable tasks；`automaticPostRoundAction` 仍为 `none`，不恢复自动无限返工。

#### READ 安全

- workspace：成员共享 cwd（`mayShareWorkspace('read', *)=true`），不建 worktree。
- claims：read+read / read+write 均不冲突；但 WRITE 成员在 topology 层被拒。
- OS 强制：本轮只有 control-plane READ + 指令"不得修改"，**不宣称** OS 级只读强制。

#### 测试

- `tests/read-fanout.test.ts`（新增 suite）：READ gate 全部拒绝路径、确定性聚合、下游依赖 gate、
  topology 决策契约（含 malformed 抛错）。
- `tests/handoff-production-round.test.ts`：真实链路（Planner → Laya topology → materialization →
  Assignment → Sessions → Scheduler → runtime）：F1/F2/F3/F4/F5/F7/F8、malformed、SOLO regression、
  T2-b 契约+scope 交付、review 看到全部成员。

### T3-a.2 Implementation Result — IMPLEMENTED (requested/actual provenance + refusal settlement)

本轮只修 T3-a.1 遗留两问：P1（Assignment 拒绝的成员在 Review packet 里丢失 Laya requested pair，
并显示 Planner seed identity）与 P2（pre-dispatch refusal 概念上已 settled，但投影只报 terminal=false）。
不改并发模型、不改 Task depth、不开放 WRITE。

#### 三个 identity 必须分开（冻结）

- **requested**：Laya PARALLEL_READ 决定里的 `agentId/modelId/scope/accessMode`。唯一来源是
  `FanoutProvenance`（Laya topology 记录），**绝不**从 `TaskStore.agentId/modelId` 反推。
- **assignment**：`accepted | refused` + reason，来源是真实 `assignChildren` 结果（AssignOutcome）。
- **actual**：真实执行身份（Agent/Model/Session/Attempt），**只有真正执行过才存在**；
  否则 `executed=false` 且 actual 全为 null。绝不用 Planner seed 或 requested pair 冒充。

`FanoutMemberState` 现同时携带三者；`round-cli` 的 Review packet 对 fan-out 成员：
`agentId/modelId`（= actual）在未执行时为 null，并新增 `requestedAgentId/requestedModelId/
memberIndex/assignmentStatus/assignmentRefusalReason` 字段。非 fan-out（SOLO）路径不变。

#### 三个 settlement 概念必须分开

- **executionSettled**：fan-out 阶段是否还需等这个成员。= 执行已结束（`to_verify/succeeded/
  failed/cancelled/blocked`）**或** pre-dispatch 拒绝。
- **taskTerminal**：严格 TaskStore terminal（`succeeded/failed/cancelled`，`isTerminal`）。
- **dependencySatisfied**：下游能否继续（== taskTerminal，沿用既有 dependency gate）。

关键回归：**pre-dispatch refusal 是 executionSettled=true，但 taskTerminal=false、
dependencySatisfied=false**；而**capacity-pending（accepted 但本 tick 未派发）必须
executionSettled=false**。否则 width=3 / capacity=1 会被误判为"全部完成"。

聚合新增 `allSettled`（准确）并保留 `allTerminal`（严格）。refused 成员不会被删除或重新编号；
`memberIndex` 稳定；输出仍按 memberIndex 排序，与完成顺序无关。

#### Unified Review 措辞

fan-out 成员的 packet 行现在明确呈现：requested worker、assignment verdict(+reason)、
actual worker（未执行时 none）。reviewer 能区分"从未执行（被拒）"与"执行了但失败"，
不会再误以为某 agent 执行失败。

#### 测试

- `tests/read-fanout.test.ts`：投影现接受 facts（assignment/executed/actual）；覆盖
  requested/actual 分离、refusal settled 但非 terminal、capacity-pending 非 settled、
  post-dispatch failure executed=true、timeout 独立。
- `tests/handoff-production-round.test.ts`：T3A2-1..10 真实链路（Planner seed → Laya requested
  pair → Assignment refusal → round result → Unified Review packet）；含 negative proof
  （恢复旧推导会让 T3A2-3 失败）。

### T3-a.3 Implementation Result — IMPLEMENTED (atomic execution attribution + dependency truth)

本轮只修 T3-a.2 遗留两问：P1（旧 Attempt/RunResult 与新 Task/Session 拼成不存在的 execution）与
P2（`dependencySatisfied` 错等于 `taskTerminal`）。不改并发模型、不改 depth、不开放 WRITE。

#### P1 — actual execution 必须来自同一份 execution evidence bundle

- **anchor**：本轮 **CURRENT dispatch** 的 `DispatchReceipt`（`admitted` / `waiting` / `skipped` /
  `outcomes` / `attemptIdsByTask`）。round-cli 包装 `capabilities.dispatch` 并捕获每个 dispatch 的
  receipt；同一 task 的条目**后来者覆盖**，因此一次拒绝会清掉更早的一次 run。
- **actual bundle**：只从该 receipt 指名的 attemptId，经 `AttemptStore.get(attemptId)` 取
  `{attemptId, agentId, modelId, sessionId}` —— 全部来自**同一条 AttemptRecord**，绝不混用
  Task 当前 identity / 当前 session binding / 历史 RunResult。
- **删除**：fan-out facts 不再读 `wb.evidence.history(taskId)` 或 `wb.lastRunResult(taskId)`。
  `lastRunResult` 仍服务其他既有用途，但不再用于 executed/current actual/current attempt。
- **fail closed**：标为 started 但没有对应 AttemptRecord → 视为 pending，绝不 fallback。

#### 区分 refusal 与 pending（§13/§14/§15）

成员 outcome 现在是四值：`started | assignment-refused | dispatch-refused | pending`。
- assignment-refused：Assignment 拒绝（existing `assignChildren` 结果）。
- dispatch-refused：Assignment 接受但 execution gate 在 runtime 前拒绝。
- pending：accepted、无拒绝、本 tick 未派发（如 capacity）。
executionSettled = started/assignment-refused/dispatch-refused；pending 不 settled。
capacity-pending 不会被误判为 refusal。

#### P2 — dependencySatisfied 复用 canonical 规则

`task.ts` 新增唯一 `dependencySatisfied(status)`（= `status === 'succeeded'`），
`unmetDependencies` 改用它（行为 byte-for-byte 不变），fan-out projection 复用同一 helper。
因此：succeeded→true；failed/cancelled→false；to_verify→false；planned(拒绝/待定)→false。
`dependencySatisfied` 与 `taskTerminal` 不再相等。`executionSettled`/`allSettled` 概念不受影响。

#### 测试与限制

- `tests/read-fanout.test.ts`：dependencySatisfied 的 canonical 语义（succeeded/failed/cancelled/
  to_verify/planned）；fan-out facts reader 的**结构性断言**（不读 history / lastRunResult，
  由 receipt + AttemptStore 驱动）。
- `tests/handoff-production-round.test.ts`：T3A3-3/4/5（旧 A attempt + 迁移到 B → actual 选 B 的当前
  attempt，旧 attempt 仍保留为历史）；T3A3-2/6（拒绝成员无 actual）；T3A3-7（capacity pending）。
- **已知可达性限制**：Codex 描述的 "migration 成功但 pre-runtime dispatch 被拒" 变体在当前测试
  harness 中不可达 —— reassign guard 会在 migration 前拒绝 unavailable/quota 目标，且 fake runtime
  是同步的，available 目标总能派发。因此 stale 隔离以 (a) 结构性断言 + (b) 旧 attempt 被忽略的正向
  迁移用例共同保证；未伪造不可达场景。

### T3-a.4 Implementation Result — IMPLEMENTED (current dispatch evidence + review atomicity)

本轮关闭 T3-a.3 遗留：P1-a（Review 仍从 Task + runResults 重拼 identity）、P1-b（用 `admitted`
当 execution proxy，把 write-back refusal 显示成未执行）、P1-c（skipped-only 未覆盖旧 evidence）、
P2（dispatch refusal code/reason 未进 packet）。

#### P1-b — `admitted` 不是 `executed`

`admitted` 是控制面 admission 事实（`settled.filter(e => e.outcome.ok)`）。write-back refusal 是
`ok:false` 但**确实运行过**。Execution proof = 该 dispatch 产生的 **Attempt**（`attemptIdsByTask`，
由 `AttemptStore.append` 实际填写）。新纯投影 `src/orchestration/dispatch-evidence.ts`：
- 有 current attempt → `started`（无论 admitted），并单独记录 `writeBackAccepted`；
- 无 attempt → `dispatch-refused`（带 refusal code/reason）或 `pending`（waiting）。
因此"跑了但写回被拒"与"从未开始"可区分。

#### P1-c — superseding 语义

- 出现在 `outcomes`（executeTask 被调用）或 `waiting` 的 task = 新的 dispatch resolution → 覆盖。
- `skipped` 中**不在 outcomes**里的（dependency-unmet）= 非新 resolution → 投影刻意省略，
  不会清除既有 current context。

#### P1-a — Review 消费同一份 atomic projection

- fan-out actual 由 `currentActualOf(taskId)`（`AttemptStore.get(attemptId)` 的单一记录）解析，
  聚合与 Review packet **共用**该 helper；Review 不再读 `Task.agentId/modelId` 或 `runResults`。
- result 用捕获 dispatch 时绑定的 run（`ce.run`），与 attemptId 同源。
- packet 的 refusalCode/reason 含 dispatch/write-back 结果。

#### 测试

- `tests/read-fanout.test.ts`：`projectDispatchTaskEvidence` 纯测试（admitted≠executed、write-back
  refusal 仍 executed、waiting→pending、superseding refusal、generic skip 不伪造 context）+
  结构性断言（capture 以 attempt 证明、packet 共用 `currentActualOf`）。
- 既有 T3A2/T3A3 生产用例保持：requested provenance、refusal、capacity pending、迁移取当前 attempt。

#### 已知可达性限制

(i) 迁移成功后 pre-runtime dispatch 被拒的变体在当前 harness 不可达（reassign guard 先拒
unavailable/quota 目标；fake runtime 同步）。 (ii) write-back refusal 需要 mid-flight lease 变更，
round 为同步、harness 无该 hook；其"运行过 + 写回被拒"分类由既有真实 fixture
`tests/assignment-lease.test.ts` F5 覆盖，capture 语义由纯投影测试覆盖。

### T3-a.5 Implementation Result — IMPLEMENTED (current Attempt <-> current RunResult direct correlation)

本轮关闭 T3-a.4 遗留的唯一 correctness blocker：current `RunResult` 仍通过
`wb.lastRunResult(taskId)` 独立查询 latest-ever result，与 current `Attempt` 没有直接关联。

#### Recon 结论（决定了实现路线）

1. `RunResult` 在 `src/runtime/session.ts#finalize` 由**运行时层**创建，位于 orchestrator 之下。
2. `attemptId` 由 `AttemptStore.append` 在**run 结算之后**才铸造（`attempt-store.ts` 计数器）。
3. `RunResult` **没有** `attemptId`；其 `taskId`/`threadId` 是运行时自己的句柄，不是我们的
   task/session。因此 `run.taskId + startedAt` **无法**证明 attempt 归属。
4. `AttemptRecord` **不保存** `RunResult`，也没有任何 `attemptId -> RunResult` 映射。
5. 同时拥有 `taskId + attemptId + RunResult` 的唯一作用域是 `NativeWorkbench.dispatch()`，
   更精确地说是 `recordExecutions` 里的那次 `AttemptStore.append`。

结论：**Option B 不可行**（run 在 attemptId 存在之前就已冻结）。**Option A 成立且最小**——
在 append 现场把 `{attemptId, run}` 绑定为一个值。Option C 需要把 run 塞进 AttemptStore，
属于更宽的改动，recon 证明非最小解。

#### Current Attempt-Result 契约

`recordExecutions` 的 `noteAttempt(taskId, record, run)` 在 append 返回真实 id 的同一刻记录
`{attemptId: record.attemptId, run}`。二者是**原子的一对**，不是事后按位置 zip。
`executionsByTask` 随 `DispatchOutcome` → `DispatchReceipt` → 纯投影
`projectDispatchTaskEvidence` 一路传递；`currentActualOf` 返回
`{attemptId, agentId, modelId, sessionId, run}` 单一 bundle，Review 与聚合共用。

`wb.lastRunResult(taskId)` 在 fan-out current evidence 路径**彻底移除**（仅保留在 continuation
packet builder，§21 SOLO 合法用途）。

#### History Isolation

- Attempt A / 无 B result → `attemptId=B, run=null`，绝不回落到 Result A。
- A/RESULT_A → B/RESULT_B → 取 B/RESULT_B。
- A 失败 → B 成功 → B 的成功，不泄漏 A 的 SPAWN_FAILED。
- A 成功 → B 失败 → B 的失败。
- 超时/write-back refusal/pending 均绑定当前 attempt，superseding refusal 清空 attempt+result。

#### 测试

- `tests/read-fanout.test.ts`（102）：纯投影 mismatch/marker/A-fail-B-succ/A-succ-B-fail/
  timeout/write-back/pending/refusal 共 12 项；**真实** `AttemptStore + recordExecutions`
  append 现场绑定 5 项；结构性 guard（含 mutation 证明有牙）。
- `tests/handoff-production-round.test.ts`（237）：真实 migration 链
  A(SPAWN_FAILED) → reassign → B(success) → aggregation → Unified Review，
  断言 current outcome 是 B 且非 A 的 SPAWN_FAILED；SOLO 回归。

#### 结构性护栏（已用 mutation 证明会失败）

`captureDispatchFacts` / `currentActualOf` / `fanoutFactsOf` / Review fan 分支均不得出现
`wb.lastRunResult(`、`latestRunResult(`、`latestAttemptResult(`、`history().at(-1)`、
`runResults.get(`（fan 分支）。

### T3-a SEALED — Codex T3-a.5 Final Seal Review

Status: **TeamRun T3-a = SEALED**（Owner 正式裁定）。

```text
Codex T3-a.5 Final Seal Review = PASS WITH P2
P0 = 0
P1 = 0
```

已接受的非阻断 P2（**移入未来 scope，不再列为 T3-a blocker**）：

```text
root-only fan-out
default maxConcurrent = 2
```

Owner 同步裁定：`T1 = SEALED`、`T2 = SEALED`、`T3-a = SEALED`。

本阶段不得再修改 T3-a。后续输入见 T3-b 修订范围。

### 交接给 T3-M0 / T3-b 的 Model Access 维度

T3-M0 已冻结 Model Access 架构（**docs only，未改任何 runtime**），并已 **SEALED**：

```text
docs/TEAMRUN_MODEL_ACCESS_ARCHITECTURE.md
T3-M0 = SEALED  (Codex T3-M0 Final Review = PASS WITH P2, P0=0, P1=0;
                 6 项 P2 为 documentation / future-implementation constraint，已 CLOSED)
```

> 注意：SEAL 的是**架构冻结**，不是 runtime 能力。`ModelAccessRoute` runtime、Candidate
> Registry、`candidateId`、Gateway、route provenance **均未实现**，仍为 future work。

与 T3-a 的关系（不推翻已 Seal 内容）：

- `ExecutionCandidate = (agentId, modelId, routeId)`；当前所有 route 均为 `agent-native`，
  因此 T2 的 `(agentId, modelId)` 是 candidate 的**旧子集**，语义不变。
- **fan-out 成员契约不变**：仍是 `{agentId, modelId, scope}`；`routeId` **不进入**
  `WorkerIdentity`，也不进入 `FanoutMemberFacts`。
- T3-a.5 的 attempt ↔ RunResult 相关 bundle 与 route 维度正交，保持原样精确。
- FREE / QUOTA 语义已改为 **candidate / route 的属性**，而非 `modelId[]`——这是对
  `ACTIVE_FREE_MODEL_POOL` 现有 pair-keyed 语义的如实记录，不是本阶段的改动。

T3-b 修订范围（已冻结，尚未实现）：

```text
T3-b — Candidate-Aware READ Scheduling & Capacity Drain
  requested width vs actual maxConcurrent
  accepted-but-not-yet-dispatched drain
  candidate availability / quota changes
  observability: requested / accepted / running / pending / settled
WRITE concurrency 仍关闭（Windows process containment 未解决）
```
