# TeamRun / Agent × Model Architecture Audit

```text
Status  = ARCHITECTURE AUDIT · 2026-10-07 · read-only analysis
Scope   = re-freeze the product-level multi-agent execution model:
          Worker = Agent Family × Model × Session × Workstream × Workspace/scope
Rule    = analysis and migration only. NO production code was modified in this
          round. The R5 lifecycle work in the working tree is untouched.
Baseline= HEAD 56f6706 + uncommitted R5-1/R5-1.1/R5-1.2 lifecycle work
```

---

## Owner Goal

The product is NOT:

```text
Task → choose one Agent → run
```

The formal goal is:

```text
User Request
↓
Laya
↓
choose execution topology
↓
create one or more Workers
↓
for every Worker choose:
  Agent Family × Model × Session × Workspace/Scope
↓
parallel / dependent execution
↓
Integration
↓
Unified Codex Review
↓
Human Gate
```

Two formal requirements drive this audit:

1. **Same Agent Family, multiple Workers, different Models, concurrently**
   (e.g. two OpenCode workers, model X and model Y, at the same time).
2. **Laya is the model-selection authority** — model choice must be an explicit
   decision in the selection pipeline, never "the adapter picks whatever".

---

## Current Architecture (what exists today)

The single-authority model is frozen and unchanged (see `docs/PROJECT_BASELINE.md` §12):

```text
Laya = sole decision brain
Planner = planning authority          TaskStore = task state authority
Assignment = assignment authority     Scheduler.tick = dispatch authority
Orchestrator = the ONE execution edge AttemptStore = evidence authority
SessionRegistry = session authority   ResourceClaimBook = resource claims
Lease/Fencing = write-back validity   Verification = success gate
Unified Codex Review = review         Human Gate = stop point
```

What the relevant layers actually bind today:

| Layer | What it binds | Evidence |
|---|---|---|
| Assignment | a canonical `(agentId, modelId)` **pair** per task | `assignment.ts` — "pairs `(agentId, modelId)` ... write back only that identity"; `modelKey = agentId::modelId` |
| ModelRegistry | per-`(agent, model)` entries: quota, availability, policy status | `quota/registry.ts` — but `setAvailability(agentId, …)` blankets EVERY model of the agent |
| Scheduler | GLOBAL concurrency only (`maxConcurrentAgents` counts running children), never per-agent | `scheduler.ts` `occupiedSlots()` counts live tasks; spawn-gate refuses on `current >= limit` |
| SessionRegistry | sessions keyed by an identity `sessionKey` (agent + model + cwd); `fresh` / `resume` policy; a session's `taskId` is its CURRENT owner | `workbench-sessions.ts` |
| Adapters | all four families accept a per-request model: `req.model` → CLI (`opencode --model`, `codex --model`, `workbuddy --model`, cline config.model) | `src/adapters/*.ts` — `modelSelection: true` verified per adapter |
| Workspace | `claimModeFor(taskType)`: `research`/`review` → `read` (shared, no worktree); everything else → `write` (isolated worktree + claim) | `round-cli.ts`, `WorkspaceManager.mayShareWorkspace` |
| ResourceClaimBook | per-task claims on normalized scopes; R5-1.2 keeps a live writer's physical claim even when its lease goes stale | `resource-claim.ts`, `orchestrator.ts` void predicate |

---

## Desired Execution Model

### Core Concepts

| Concept | Definition | Today |
|---|---|---|
| **Agent Family** | runtime / tools / adapter / capability family. Formally exactly four: OpenCode, Codex, WorkBuddy CN, WorkBuddy Intl. NOT an execution instance. | adapter + descriptor |
| **Model** | an independent per-Worker choice inside a family. Worker A (OpenCode, model X) and Worker B (OpenCode, model Y) must be able to run concurrently. | `req.model` per request — supported |
| **Session** | one conversation/thread of one family. A family owns `0..N` concurrent sessions; each session is bound to the model that started it. | SessionRegistry sessions; no family-level busy flag exists |
| **Worker** | the execution unit: Agent Family + Model + Session (fresh/reuse) + Workstream/task + mode (read/write) + workspace/scope. | EMERGENT — today it is the implicit `(Task, Assignment pair, session, claim)` tuple; no first-class identity |
| **Workstream** | a Laya-chosen group of related tasks sharing one Worker scope | partially = planner subtree |
| **TeamRun** | a user-facing PROJECTION: user request + workers + workstreams + dependencies + results. An aggregate, never an authority. | does not exist yet; `round-result` is the closest |

### Execution Topologies

| Topology | Shape | Expressible today? |
|---|---|---|
| **SOLO** | 1 Worker | YES — every single-task round already is this |
| **PARALLEL_SPLIT** | Worker A → module A, Worker B → module B, independent write scopes | YES — planner DAG + per-task isolated worktrees + claims already admit parallel writers |
| **PARALLEL_RESEARCH** | N read-only scouts sharing the repo, no worktree | YES — `read` claim mode + shared workspace already exist; no isolation cost |
| **COMPETE** | same problem to ≥2 Workers (different models); one solution wins / is fused | **NO** — there is no semantic for "sibling successes compete; pick or fuse one". The DAG has no best-of-N node, and Unified Review sees all attempts of ONE task, not rival solutions of one objective |
| **PIPELINE** | research → implementation → tests, dependency-ordered | YES — the planner DAG expresses exactly this |

### Agent × Model Selection

Formal selection pipeline (Laya is the model-selection authority):

```text
Task / Workstream
↓  Agent compatibility filter        (family capability: tools, resume, cwd, review…)
↓  Model compatibility filter        (model capability: quota, availability, policy)
↓  Agent × Model candidate pairs     (already first-class: modelKey = agentId::modelId)
↓  score candidate pairs
↓  choose Worker count               (topology policy)
↓  choose sessions                   (fresh vs reuse per Worker)
↓  dependency / resource validation  (claims, workspace mode)
↓  dispatch                          (Scheduler.tick — unchanged)
```

The missing piece is NOT the mechanics — pairs, per-request model, registry, and
scoring exist — it is that **Laya never emits the pair**: today the pair is chosen
inside Assignment from the ModelRegistry, and the plan carries only
`taskType` + `preferredAgent`.

### Same-Agent Multi-Model Concurrency

Mechanics verified per family:

- **OpenCode**: `--model <id>` per request (`opencode.ts:222`). Session resume via
  `--session <threadId>`. Multiple concurrent `opencode run` processes are ordinary
  subprocesses — no family-level lock exists in the code. A resumed thread keeps
  the model it was started with; a model CHANGE therefore implies a NEW session.
- **Codex**: `--model <id>` per request (`codex.ts:222`). `codex exec resume`
  binds to the thread; same model-per-thread rule. Concurrent `codex exec`
  processes are fine, subject to Codex-side auth/quota.
- **WorkBuddy CN / Intl**: `--model <id>` verified (`workbuddy.ts:648`,
  `modelUsage` echoed back). Two separate installs (CN/Intl) are distinct
  families, never interchangeable.
- **cline** (factory-registered but not one of the four formal families):
  config.model — listed for completeness.

**Result: same-agent multi-model concurrency is mechanically supported end to end.
The blockers are authority/semantic, not transport.**

### Capability Matrix (as implemented today)

| Agent | model selection | mechanism | model stored per session? | concurrent sessions | same-agent multi-model | limitations |
|---|---|---|---|---|---|---|
| OpenCode | YES (`modelSelection: true`) | `--model` per request | thread keeps its model; new model ⇒ new session | YES (no per-agent gate) | YES | none known at adapter level |
| Codex | YES | `--model` per request | thread-bound model | YES | YES | review mode + resume mutually exclusive (contract); auth is the practical constraint |
| WorkBuddy CN | YES (verified) | `--model` per request | result echoes modelUsage | YES | YES | auth not recently re-verified (dashboard fact) |
| WorkBuddy Intl | YES (verified) | `--model` per request | same | YES | YES | same |
| cline (informal) | YES | config.model | — | YES | YES | no factory guarantee; not a formal family |

### Current Blocking Assumptions (what would stop the target model)

1. **Agent-level availability blanket.** ~~`ModelRegistry.setAvailability(agentId, …)`
   sets availability on EVERY model entry of the agent.~~ **RESOLVED in T1-a** (see
   "T1-a Implementation Result"). A single stale probe (e.g. one quota endpoint
   failing) used to mark all models of the family unavailable; availability is now
   recorded per `(agent, model)` with the agent family as a separate, non-destructive
   fact.
2. **Laya does not choose the pair.** The decision contract classifies
   (`work_kind`, `complexity`, `review_required`) and answers `next_action`.
   Topology, Worker count, per-Worker family/model, and session policy are absent
   from the decision vocabulary. Assignment fills the gap today — which is fine as
   a fallback, but Laya's authority over the pair must be expressible.
3. **No COMPETE semantics.** Sibling tasks of one objective are independent DAG
   nodes; there is no "these are rivals, exactly one result continues" node type
   and no integration step that selects/fuses rival outputs.
4. **No first-class Worker identity.** A Worker exists only as the implicit tuple
   (Task, assigned pair, session key, claim scope). Attempt evidence records
   `agentId`/`modelId`/`taskType` but not "Worker W" as a stable product identity.
5. **`modelId === null` means "any model"** in lookup — a Worker concept wants
   Laya to have chosen, even if the choice is "family default".
6. **Windows process containment (R5-1.3, Owner-stopped).** Unresolved lifecycle
   prerequisite for safe WRITE-worker concurrency on one physical workspace.
   Recorded, not worked on.

### Read vs Write Workers

Already largely real:

- READ Worker: `read` claim mode shares the main repo, no worktree, parallel-safe
  (`mayShareWorkspace('read', …)`). Research/review tasks already map to it.
- WRITE Worker: `write` mode → isolated worktree + claim + lease/fencing +
  dispatch-time admission. R5 lifecycle work strengthened exactly this path
  (lease sizing, unconfirmed-stop retention, physical claim retention).

The change required is only that **topology/role becomes a Laya input**, not a
side effect of `taskType`.

### Session Semantics

- `fresh` / `resume` policies exist per ExecutionTarget.
- Model-per-thread: resuming a thread with a different model is not meaningful;
  the pipeline must treat "choose model" as BEFORE "choose session", and a model
  change forces `fresh` (or a family-specific remap).
- SessionRegistry refuses foreign-thread resume and enforces cwd ownership —
  reusable as-is for Worker sessions.

### Assignment Changes Required

- Keep `(agentId, modelId)` pair binding; ADD an optional upstream override:
  when Laya's plan names the pair for a task, Assignment filters to it instead of
  scoring the whole registry. Assignment stays the enforcement authority; Laya
  gains explicit choice.
- Per-model availability in ModelRegistry (agent-level as aggregate).
- `modelId === null` keeps meaning "Assignment decides" for legacy paths.

### Scheduler Changes Required

- NONE for same-agent concurrency: capacity is global (`maxConcurrentAgents`),
  admission is per-dispatch, occupancy is store-derived. A second OpenCode worker
  is admitted today if budget/concurrency/claims allow.
- A per-family concurrency ceiling (adapter `max safe concurrency`) is a
  capability field + gate input — additive, no new authority.

### Laya Decision Contract Changes Required

- Add to the decision vocabulary (typed, closed): execution topology, per-Worker
  {family, model, session policy, mode, scope}, Worker count.
- The 11-action closed vocabulary is untouched; these are PLAN-level fields.
- Validator fail-closed: unknown topology ⇒ refuse the plan (same rule as today's
  actions).

### Communication

No free-form agent chat. Today's typed channels — structured handoff briefs,
continuation packets, observation events — already flow control-plane-first. The
audit finds the useful ADDITION is a small typed worker-to-worker event set
(`artifact_ready`, `dependency_ready`, `interface_update`, `blocker`, `question`,
`answer`) routed THROUGH the control plane (Laya/TaskStore), with agents unable
to self-assign tasks, reassign others, mark complete, or change dependencies.
Existing event/hub infrastructure can carry these; no new channel authority.

### Workspace / Resource Interaction

- READ Workers: claim `read`, share the repo, no worktree — do NOT send them
  through workspace isolation.
- WRITE Workers: isolated worktree per task/scope + claim + lease. COMPETE
  workers must each get their OWN write scope (rivals writing one worktree would
  be nonsense).
- R5-1.2's separation (lease staleness ≠ physical release) is the exact
  foundation same-scope concurrency safety rests on.

### Existing Components Reused (all of them)

TaskStore, Assignment, SessionRegistry, Scheduler, Orchestrator (single
`runtime.run` edge), AttemptStore, ResourceClaimBook, Lease/Fencing, Unified
Review, Human Gate, round-result projection, ModelRegistry.

### Components That Must NOT Be Added

- TeamManager / TeamScheduler / TeamAuthority / WorkerManager
- a second dispatch edge or second session authority
- a new task lifecycle status for "worker"
- free-form agent-to-agent chat
- a global outcome vocabulary (COMPETE winner selection is a plan/projection
  concern, not a new outcome enum)

---

## Migration Plan (4 slices, based on the real code)

**T1 — formal Worker identity + Agent/Model/Session separation (types & registry)**
Introduce a Worker record as a PROJECTION identity (family, model, session policy,
workstream, mode, scope) — expressible today without schema surgery because
Assignment, SessionRegistry, and claims already carry every field. Make
ModelRegistry availability per-`(agent, model)`. No behavior change beyond
availability granularity.

**T2 — Laya Agent × Model selection**
Extend the Laya decision contract with plan-level fields: per-task/Workstream
`agent` + `model` (optional; absent = Assignment decides, exactly as today) and
topology hint. Assignment filters to the named pair when present. Validator
fail-closed. This single change breaks `Agent == model` coupling at the authority
level.

**T3 — same-Agent multiple Worker sessions + read-only parallelism**
Run two Workers of one family with different models concurrently
(PARALLEL_RESEARCH first: read mode, no isolation cost). Verify SessionRegistry
multi-session behavior and per-model quota paths. COMPETE read-mode variants fit
here as a research topology.

**T4 — write-worker parallelism + COMPETE + TeamRun projection**
Multi-WRITE-Worker rounds (already mechanically possible; gated by Windows
process containment — see below), best-of-N selection semantics for COMPETE, and
the TeamRun aggregate as a round-result extension (projection only).

Prerequisite gating T4's safe form: **Windows process containment remains an
unresolved lifecycle prerequisite for safe WRITE-worker concurrency** (R5-1.3,
stopped by Owner). Read-mode parallelism (T3) does not depend on it.

---

## Risks

1. **Availability blanket** ~~can silently starve a healthy model because of one
   family-level probe~~ — **closed in T1-a**: one pair's failure now removes only that
   pair from the candidate set, and an agent-family block remains a family-wide block.
2. **Session/thread model binding**: a naive "resume with different model" would
   silently run the OLD model. The pipeline must force `fresh` on model change.
3. **COMPETE cost**: rivals burn quota by design; policy must bound worker count
   and require explicit Laya intent.
4. **Configurable parallelism policy** (small/coupled → 1; independent scopes → 2;
   large → up to 3 default; read-only may fan out; same-files never parallel-write)
   must live in plan/policy data, never hardcoded thresholds in the scheduler.
5. **Physical concurrency safety**: until Job Object containment exists, multiple
   WRITE workers rely on worktree isolation + claims (already strong) — but a
   shared-cwd write topology must stay refused.

## Recommended First Implementation Slice

**T1-a: per-`(agent, model)` availability in ModelRegistry.**

Small, no authority change, no schema migration, directly starts un-coupling
`Agent == model` (today one probe blankets every model of a family), zero risk to
the frozen authorities, no Job Object dependency, no UI. Assignment, the spawn
gate, and all consumers keep their call shapes; only the granularity inside
`ModelRegistry.setAvailability` changes plus a per-model probe path.

### T1-a Implementation Result — IMPLEMENTED

Status: **implemented** (not blocked). Shipped as a granularity change only.

- **Root cause was a writer, not the readers.** Every consumer (`assignment.ts`
  candidate filter, `spawn-gate-input.ts` model pool, `policy.ts`) already read
  `entry.availability` as a PER-PAIR fact. The defect was the single production writer
  in `quota/index.ts` `applyPolicy`, which held an **agent-wide install** fact and pushed
  it through a setter that fanned it across every entry of the family.
- **New API** (`src/quota/registry.ts`), no rename of anything else:
  `setAgentAvailability(agentId, …)`, `setModelAvailability(agentId, modelId, …)`,
  `agentAvailability(agentId)`, `effectiveAvailability(agentId, modelId)`,
  `isModelAvailable(agentId, modelId)`. The ambiguous `setAvailability(agentId, …)`
  is **removed** — there is no setter that means both things.
- **Effective availability** = family fact ∧ pair fact. An unavailable family blocks
  every pair under it (a missing binary really does mean no model works); an available
  family leaves the pair's own verdict standing, including `unknown`, which stays
  fail-closed exactly as before. No new availability vocabulary was introduced —
  `ModelAvailability` is still `'available' | 'unknown' | 'unavailable'`.
- **Family facts do not stomp pair evidence.** Pairs whose availability came from a
  pair-specific fact are tracked, so `opencode` coming back does not mean "and now every
  model under it is healthy". That is the specific asymmetry Case D pins.
- **Unknown model is not evidence.** `setModelAvailability` on an unregistered pair is
  ignored rather than escalated to the family.
- **Call-site audit result:** exactly ONE production call site existed
  (`quota/index.ts` install evidence) and it is genuinely **agent-wide**, so it became
  `setAgentAvailability`. No call site was ambiguous. 23 test-fixture call sites were
  family-level intent and were renamed to say so.
- **Readers updated** to the effective verdict: candidate filtering, spawn gate model
  pool, `evaluatePolicy`, the `modelAvailable` roll-up, and the dashboard's model row.
- **Assignment authority unchanged** — still filtering + scoring + selection. The
  registry supplies facts only; it does not choose, score or dispatch.
- **Persisted state:** none. Availability was never serialized in this registry, so
  there is no schema to migrate and no old-format load path to keep working.
### T1-b Implementation Result — IMPLEMENTED

Status: **implemented** (not blocked). Frozen as an identity relationship only.

**T1-a = complete. T1-b = implemented.**

```
Agent Family  !=  Model  !=  Worker  !=  Session  !=  Attempt
```

- **Worker = one execution participant**: a task bound to one Agent Family, one Model, and
  one native Session. Not the family, not the attempt.
- **Identity shape** — `WorkerIdentity { taskId, agentId, modelId, sessionId }`. `mode`
  and `scope` ride on an optional `WorkerProjection` for a future view and are NOT part of
  identity (a read and a write view of one session are one worker).
- **It is a PROJECTION, not a store.** Every field is somebody else's authoritative fact:
  `taskId` from TaskStore/Assignment, `agentId`/`modelId` from Assignment, `sessionId` from
  `SessionRegistry`. There is deliberately **no `WorkerStore`, `WorkerManager` or worker
  registry**. A Worker becomes knowable once Assignment has chosen a pair AND
  SessionRegistry has resolved a session — Assignment was NOT turned into a worker chooser.
- **`workerId = agentId` is structurally impossible.** `sessionId` is required and part of
  the key, so two workers on one agent with different models — or the same model in
  different sessions — can never collapse.
- **Identity is comparable without a new ID authority.** `workerKeyOf` is a deterministic
  function of the four facts (JSON tuple, so `a::b` cannot forge a collision); there is no
  `worker_000001`.
- **Attempt is not Worker.** `attemptId` is absent from the identity. Two attempts of one
  worker resolve to the same worker key; an `AttemptRecord` carries `previousAttemptId`, so
  attempt chain and worker identity stay distinct.
- **Model binding is stable per Worker**, because `SessionRegistry.open` already refuses a
  `reuse` whose agent/model disagrees. A model change therefore means a new session, which
  means a new worker — that follows from the key, not from an extra rule.
- **Handoff produces a NEW Worker** whenever agent, model or session changes; a genuine
  `reuse` of the same session stays the same worker (continuity). Handoff behaviour itself
  is unchanged, and `ContinuationPacket` did not become a TeamRun protocol.
- **AttemptRecord**: added an **additive optional `sessionId`** (the one field it was
  missing), following the existing optional-field system so pre-T1-b records still validate
  and still load. `workerIdentityOfAttempt` returns `null` when no session was recorded
  rather than fabricating one.
- **Codex review identity is expressible** — the type is not implementation-only, so
  `codex / model-X / review-session` projects like any other worker. Codex's role as
  Unified Reviewer is unchanged.
- **SessionRegistry remains the session authority**: the projection only reads an
  already-resolved session. It never creates, resumes, closes or re-binds one.
- Not done, by design: Workstream, TeamRun, TeamManager, per-family concurrency, and any
  Windows containment work.

### T1-c Implementation Result — IMPLEMENTED

Status: **implemented**. Two closures only: session-attribution truth (P1) and
family-availability fail-closed (P2). No T2 pair-selection authority, no T3 parallelism.

**Session attribution invariant.** `WorkerIdentity.sessionId` must name a session that
genuinely belongs to the attempt's `(agentId, modelId)` pair — never "whatever session the
task happened to be bound to last". Three changes, all inside the existing authorities:

- **Compatibility rule (SessionRegistry module).** `sessionCompatibleWith(session, pair)`:
  `session.agentId === pair.agentId AND (session.modelId ?? null) === (pair.modelId ?? null)`
  — the exact normalisation `SessionRegistry.open` already enforces on reuse, now stated
  once and shared. `null` modelId matches only `null`.
- **Fact-source fix (`reassignTask`).** After `migrateIdentityAfterStart` accepts the new
  pair, the task's session binding is re-pointed through `SessionRegistry.open(fresh)`
  + `markRunning` — existing APIs, no new manager. A changed pair can never reuse the old
  session (and `open` would refuse the reuse anyway); a same-pair "reassign" never reaches
  here (`migration-not-a-migration`).
- **Fail-closed attribution (`Workbench.sessionForAttribution`).** The dispatch/rework
  recorders attribute a session to an attempt only when it is compatible with the pair the
  task carries NOW; otherwise the attempt records NO `sessionId` (absent, not stale) and
  `workerIdentityOfAttempt` returns null. `AttemptRecord.sessionId` stays optional;
  `workerIdentityOfAttempt` stays a pure projection of recorded facts.

**Actual production session path (audited, §7):** assignment → `assignChildren` opens the
session for the chosen pair; session resolution → `SessionRegistry` only; dispatch →
`scheduler.tick` → `executeTask` with a thread handle only on explicit resume (decision
dispatch NEVER resumes), so a reassigned task's next run is a fresh native conversation on
the NEW pair; attempt recording → the workbench copies the session fact from the registry
into `AttemptRecord`. Verdict: execution already used the correct pair; only the binding
and the attribution were stale — the fix is the rebind plus the attribution guard, not a
dispatch change.

**Handoff vs rework (audited, §8):** handoff/reassign with a changed pair → new compatible
session → new Worker (W8/W9). Same-pair rework → same session, same Worker, new Attempt
(W10). Rework has NO pair-change capability in production — proven and asserted (W12).
A path that moves identity without rebinding now yields a sessionless attempt rather than
a forged Worker (W11).

**Family-missing fail-closed rule (P2).** `effectiveAvailability(agent, model)` previously
promoted a pair's `available` verdict to the whole family when the family fact had never
been probed. Frozen rule now: `effective = familyAvailable AND pairAvailable`, where a
MISSING family fact reads `unknown` — identical in behaviour to an explicit `unknown`
(both fail closed); `agentAvailability()` still distinguishes them at the diagnostic layer.
Explicit family recovery semantics from T1-a (A1–A5) are unchanged: a family coming back
does not revive a still-broken pair, and a pair-specific verdict survives.

Regressions: W8–W12 (workbench production handoff path), A6/A7 (assignment + registry).

### T1-d Implementation Result — IMPLEMENTED

Status: **implemented**. Three closures only: dispatch-time worker truth (P1), session
`markRunning` lifecycle (P2), and the workbench.ts EOL/diff-check restore (P3).

**Dispatch truth contract (frozen).** Once an execution is really dispatched, its
identity/evidence facts are never re-derived from the current Task, Assignment or session
binding. CURRENT TASK FACTS and DISPATCH-TIME EXECUTION FACTS are two different
generations and must never appear in one Attempt.

- **Reuse-first (§3): no new snapshot object was needed for the identity fields.** The
  dispatch-time agent/model already exist on `ExecuteOutcome.mapping`
  (`RunRequestMapping`, built at the dispatch boundary), and the dispatch lease version is
  already on `ExecuteOutcome.leaseVersion` — both survive the F5 refused-with-run branch.
  Only the session was missing, so `Workbench.dispatch()` snapshots
  `sessionsAtDispatch` (per dispatch candidate, via the T1-c compatibility guard) in the
  same synchronous region the tick enumerates candidates. The composed value
  `DispatchExecutionFacts { taskId, agentId, modelId, sessionId?, leaseVersion? }` is an
  immutable evidence snapshot — not an authority; it owns nothing.
- **Attribution** (dispatch/rework recording, `recordRun`, `attachLeaseSession`) reads
  ONLY the dispatch facts. There is no fallback to the latest binding, the previous
  attempt's session, or the current task identity for a fact-bearing execution; an
  uncertain session is an ABSENT session (`workerIdentityOfAttempt` → null). A
  `RunResult.agentId` vs dispatched-pair mismatch is logged loudly, never silently
  spliced.

**Session lifecycle (P2/P3 of the mandate).** `reassignTask` now PREPAIRS the new pair's
session (`SessionRegistry.open`, binding re-pointed) and leaves it `open`; the removed
premature `markRunning` (and the same pre-dispatch pattern in `assignChildren`) moved to
the ONE real dispatch edge: `ExecuteTaskRequest.onStart` — fired by `executeTask` after
the runtime has ACCEPTED the run — reached through a new `TickDispatchHooks.onDispatchStart`
passed to `scheduler.tick()`. Pre-dispatch refusals (gate/lease/resource/cancel) never
reach `onStart`, so a refused dispatch can never leave a "running" session that never ran;
`open` is the existing safe prepared state, and the terminal path is unchanged.

**EOL restoration (P3).** workbench.ts was surgically line-ending-corrected: unchanged
lines keep their exact committed HEAD bytes; every content-changed line is LF-only. No
checkout/restore/formatter/renormalize was used; `git diff --check` passes and
`git diff --numstat` equals `git diff --ignore-space-at-eol --numstat` (no EOL-only noise).

Regressions: W13–W19 (deferred-result dispatch truth + session lifecycle), W1–W12 and
A1–A7 all green.

### T1-e Implementation Result — IMPLEMENTED

Status: **implemented**. Three closures only: the session snapshot moves to the true
freeze point (P1), every STARTED execution settles its session exactly once (P2), and the
rework attempt carries its own dispatch leaseVersion (P2).

**Atomic dispatch contract (frozen).** One execution = one immutable dispatch truth
`{ taskId, agentId, modelId, sessionId?, leaseVersion }` describing the SAME upcoming
runtime dispatch — never pre-tick session + post-await pair, and never a re-query of
current Task/Assignment/binding at result time.

- **Freeze point.** The previous pre-tick `sessionsAtDispatch` snapshot was DELETED. The
  session is now resolved by a thin `resolveSessionForDispatch({ taskId, agentId,
  modelId })` seam that `executeTask` calls at the freeze point: after the LAST
  pre-dispatch await (workspace preparation), when `running.task` is the pair that will
  actually run and the dispatch lease is captured. The resolution is owned by the caller
  (Workbench → SessionRegistry, `sessionCompatibleWith`-guarded, strict: an incompatible
  binding yields NO session, never the latest wrong one); the scheduler/execute layer only
  forwards it — no session authority moved.
- **One binding everywhere (§6).** The resolver's answer rides on
  `RunRequestMapping.sessionId`, so the actual `RunRequest` (whose optional resume
  `threadId` now also comes from the same resolved session, explicit `req.threadId`
  keeping priority), the `markRunning` at start, and the Attempt attribution all stem
  from the same dispatch binding. Race A (reassign during prepare → execution is B with
  B's session), Race B (reassign after freeze → attempt is pure A), Race C (A→B during
  prepare, B→C after dispatch → attempt is pure B, task is C) are each pinned by tests.
- **Session lifecycle paired (§9–§16).** `start` = runtime accepted the run
  (`onStart` → `markRunning`); `terminal` = the new `onDispatchTerminal` seam, wired
  through an exactly-once try/finally inside `executeTask` that fires ONCE per started
  execution on every post-start exit — success, failure, timeout, cancellation, refused
  write-back (F5), and `handle.result()` rejection. Settlement is independent of
  write-back acceptance: with a `RunResult` it uses the existing `recordRun`; without one
  it uses the new minimal `SessionRegistry.endExecution` (`running → open`, the same
  resting state — no fabricated outcome). Pre-start refusals fire neither hook. The
  ok-gated `recordRun` loop was removed; only the R2-2 §4.1 `attachLeaseSession` audit
  linkage remains after the tick.
- **Attempt attribution (§18/§19).** Ordinary, F5-refused and rework attempts all take
  agent/model/session/leaseVersion from their execution's dispatch facts. The rework
  writer now passes `leaseVersion` from the frozen facts (§17). The defensive
  "no facts → current binding" fallback is GONE: a mapping-less outcome (production-
  unreachable, guarded by comment) attributes the agent from the run's own immutable fact
  with model/session unknown — never from current task state.

Regressions: W20–W28 (freeze-point races, terminal settlement table, rework lease), and
W1–W19 + A1–A7 all green.

### T1-f Implementation Result — IMPLEMENTED

Status: **implemented**. One closure only: explicit `req.threadId` vs the dispatch-
resolved session must describe the SAME execution context.

- **Frozen contract.** `resolveDispatchContext({ explicitThreadId, resolvedSession })` —
  a pure value decision in the execution seam, decided synchronously at the T1-e freeze
  point (after the last pre-dispatch await, before `runtime.run`, `onStart`,
  `markRunning` and any Attempt):
  **T1** no explicit thread → resolver session + its native handle (fresh sessions
  legitimately have none); **T2** explicit === resolved native handle → dispatch, both
  truths name one context; **T3** explicit ≠ resolved native handle → refusal
  (`thread-session-conflict`); **T4** resolved session with no recorded handle + explicit
  thread → refusal (unprovable); **T5** explicit thread with no attributable session →
  sessionless execution under the existing contract: the thread runs, mapping/Attempt
  claim NO session, no Worker is projected, and the thread string never back-derives a
  binding.
- **Single source.** `effectiveThreadId`/`effectiveSessionId` both come from the one
  `dispatchContext` decision; the `req.threadId ?? resolvedThread` precedence (the
  audited hole) is gone. No new await, no mutable re-lookup — atomic dispatch preserved.
- **Refusal semantics.** A conflict is an ordinary pre-dispatch rejection: zero
  `runtime.run`, zero start/terminal hooks, session stays non-running, no Attempt and no
  `WorkerIdentity` can be fabricated for an execution that never happened. No reverse
  thread→session lookup authority was added.

Regressions: W29–W34 (match / conflict / unprovable / sessionless / standard path /
lifecycle-untouched) and W1–W19, A1–A7 all green.

### T1-g Implementation Result — IMPLEMENTED

Status: **implemented**. One closure only: the thread/session-conflict refusal now
leaves the control plane exactly as consistent as every other pre-runtime refusal.

- **Root cause.** The T1-f conflict check ran AFTER `queued`/`running` commit and after
  `markLeaseUsed` lease activation — so a refused dispatch left the task `running` with
  an activated lease: a live-execution state protecting a writer that never existed,
  a consumed scheduler slot, and a task that could not dispatch again.
- **Fix = Option A (validate before committing).** The session resolution and the
  `resolveDispatchContext` decision moved BEFORE the `queued`/`running` mutations and
  lease activation — still inside the same synchronous freeze region (after the last
  pre-dispatch await, fresh store read, no new await), so the T1-e atomic freeze and
  Race A/B/C semantics are byte-identical. No unwind/rollback path was needed at all:
  the refusal now happens while the task is still in its schedulable state.
- **Resulting contract (frozen).** `thread-session-conflict` = ordinary pre-runtime
  refusal: TaskStore stays `planned`/`queued` (== returned `status`), lease stays as it
  was (never activated by the conflict — `issued` on a first dispatch), scheduler
  capacity immediately reusable (proven through a real cap-1 tick), session untouched,
  no Attempt. A corrected request re-dispatches normally — one bad explicit-thread
  request cannot poison a task.
- **Parity (W39).** The conflict refusal's post-state (task status, lease status,
  session state, immediate re-dispatchability) is asserted identical to the existing
  spawn-gate refusal contract.

Regressions: W35–W39 added; W1–W34 and A1–A7 all green.

### T2-a Implementation Result — IMPLEMENTED

Status: **implemented**. Laya is now the semantic Agent × Model choice authority;
Assignment is the admissibility/enforcement authority. One slice only — no T2-b recon
enforcement, no T3 fan-out, no T4 topology.

- **Pair intent (`AgentModelIntent`).** A thin typed two-string value in assignment.ts
  (`agentId` + concrete `modelId`; `null` is never a model choice). `validateAgentModelIntent`
  enforces atomicity (§3): both halves present or the intent is REFUSED — `PARTIAL`,
  non-string and empty fields fail closed, never stripped, never completed by guessing.
  Absence (undefined) is the legitimate legacy path, explicitly distinct from an invalid
  present pair (§18).
- **Enforcement (`AssignmentInput.explicitPair`).** With an explicit pair, the candidate
  pool IS the pair: `assignWorker` restricts to the exact registered pair and runs the
  UNCHANGED enforcement chain — registration, T1 effective availability, capability,
  quota, free-pool policy, and only then the trivial single-candidate scoring. Accept
  the pair or refuse with the existing rejection vocabulary
  (`not-capable` / `availability-unknown` / `availability-unavailable` / `quota-blocked`
  / `outside-free-pool` / aggregate codes; an unregistered pair refuses
  `no-model-available` naming the pair). No scoring competition, no silent substitution,
  no new error vocabulary, no bypass — Laya's pair can still be refused by every rule
  that governs any candidate.
- **Reassign / handoff wiring (production decision path).** A Laya `reassign` decision
  naming a COMPLETE pair (agentId + modelId) flows validateDecision → applyDecision →
  `decisionCapabilities.reassign` → `Workbench.reassignTask`, which now passes the pair
  as `explicitPair`: Assignment enforces exactly that pair or the migration is refused —
  never a fallback migration. Naming only one axis keeps the documented legacy
  preference semantics. The T1 session path (rebind → fresh compatible session → new
  Worker) is reused untouched.
- **Initial assignment wiring.** Recon finding: in the current production flow Laya's
  per-task initial pair choice does not exist as a decision action — initial pairs come
  from the plan/spec preferences (`preferredAgent`/`preferredModel`). Rather than
  inventing a second Planner or a new action, T2-a wires the explicit channel
  additively: `WorkbenchTaskSpec.explicitPair` / `TaskIntent.explicitPair` (intent beats
  spec), consumed by `assignChildren` → `assignWorker({ explicitPair })`. Legacy
  preferences (including partial ones) keep their historical behaviour byte-for-byte;
  provenance is inferable — a pair chosen under an explicit intent is enforced, not
  ranked.
- **Unified Review untouched.** Codex review remains its own production path
  (execution Worker → Unified Codex Review → Human Gate); T2-a pair choice targets
  execution workers only. Re-verified behaviorally (review verdict → review attempt →
  acceptance) and by the suite.

Regressions: T2A-1…T2A-13 (assignment-level exact enforcement, decision-wired reassign,
review parity), W1–W39 and A1–A7 all green.

### Future T2/T3 invariant — Recon / Reuse-first (owner-ratified)

> Every execution Worker owns its own bounded Recon/Reuse-first phase: before doing work,
> it performs the reconnaissance its own scope requires and prefers REUSE / ADAPT / WRAP
> over rebuilding. Shared research may provide evidence and leads, but never replaces
> worker-local verification.

No Research Agent / Research Manager is introduced by this note.

---

## Appendix: files read for this audit

`src/orchestration/assignment.ts`, `src/orchestration/scheduler.ts`,
`src/orchestration/workbench-sessions.ts`, `src/orchestration/spawn-gate-input.ts`,
`src/quota/registry.ts`, `src/quota/spawn-gate.ts`, `src/adapters/{opencode,codex,workbuddy,cline}.ts`,
`src/core/types.ts` (AgentCapabilities, RunRequest), `src/runtime/session.ts`,
`src/orchestration/workspace.ts`, `src/orchestration/resource-claim.ts`,
`src/cli/round-cli.ts` (claimModeFor), `src/orchestration/round-result.ts`,
`docs/PROJECT_BASELINE.md`.

### T2-a.1 Implementation Result — IMPLEMENTED (T2-a still PARTIAL)

Status: **T2-a.1 implemented**; **T2-a remains partial** — exact pair enforcement is complete and the
initial Laya wiring is now closed, but no Recon runtime, fan-out or TeamRun exists.

- **P1 root gap:** the first Agent/Model was never Laya's. `assignChildren` read
  `WorkbenchTaskSpec.explicitPair` — a CALLER-supplied value. There was **no real Laya invocation**
  anywhere between TaskStore and the first Assignment, so there was no Agent x Model authority on the
  initial path at all. Renaming that field would not have created one.
- **P2 root gap:** `validateDecision` accepted `{action:'reassign', agentId}` with no `modelId`,
  defaulting to `strategy:'explicit'`. Laya claimed the target but named half a pair and Assignment
  completed the other half.
- **Fix P1:** `decision/initial-assignment.ts` is a PRESET over the existing Decision Layer (exactly as
  `routing.ts` is a preset for classification) — one question, `initial_agent_model`, whose answer space
  IS the real candidate list. `NativeWorkbench.selectInitialAssignment()` asks Laya BEFORE any Assignment,
  and round-cli injects the provider it already builds. No second Planner, no second provider.
- **Fix P2:** an `explicit` reassign now requires BOTH halves. `strategy:"assignment"` — Laya deliberately
  delegating — is a different, already-named meaning and is untouched.
- **Fail closed:** provider unavailable, malformed, partial, unoffered pair, or a Laya-controlled workbench
  with no recorded decision all REFUSE the task. None of them silently drop the intent into Assignment scoring.
- **Legacy boundary:** the production initial path is Laya-controlled; `assignWorker()` with no explicit pair
  still scores, and that is a low-level compatibility behaviour, not a product authority.
- **Architectural note:** `decision.ts` may not import `assignment.ts` (guarded by `state-loop.test.ts`), so
  the pair-ATOMICITY check there is deliberately a local SHAPE predicate while `validateAgentModelIntent`
  remains the typed definition. Shape ("did Laya name both halves?") and resolution ("is the pair real and
  available?") stay separate questions, which is the boundary that guard exists to hold.
- **Fixtures updated to the new contract:** six handoff fixtures in `continuation.test.ts` and the DC-4
  provider-carried target in `workbench.test.ts` all named half a pair; they now name both halves.

### T2-b Implementation Result — IMPLEMENTED

这一节只记录 T2-b 的实际实现，不改动上文任何内容。它落实的是 L644 已裁定的
"Recon / Reuse-first" 不变量，并明确区分三件不同的事：**Worker-local Recon**、
**shared research**、**Unified Review**。

#### 三者边界（本次实现的核心区分）

- **Worker-local Recon**：每一个真正执行 Task 的 Worker 在自己的 execution scope 内必须先做
  bounded recon 并得出显式 reuse 决策，之后才执行实质任务。这是 execution contract，不是新 actor。
- **shared research**：来自前一个 Worker、continuation packet、review finding 或上游链接的证据，
  **只是 leads/evidence**。Worker 可以先读，但必须自行验证与自己 scope 相关的部分；
  "已有研究" 永远不等于 "我的 recon 已完成"。不存在 `research exists -> reconRequired=false` 分支。
- **Unified Review**：独立 reviewer，不是 execution Recon worker。它**不得**收到实现侧的
  REUSE/ADAPT/WRAP/NEW 契约，也不被要求修改代码。

#### Canonical source 与注入点

- **Canonical source（唯一一份）**：`src/orchestration/worker-execution-contract.ts`
  - `WORKER_RECON_REUSE_CONTRACT`：契约文本，一个 freeze 的字符串数组。
  - `composeWorkerExecutionPrompt(taskInstruction)`：纯函数，把契约前置，并把**原始 task
    instruction 原样**放在 `--- TASK (unchanged) ---` 之后。
  - 该模块不选择 Agent/Model/Session、不 dispatch、无 mutable state：`new authority = 0`。
- **注入点（唯一一处）**：`src/orchestration/execute.ts` 的 `buildRunRequest`。
  - 这是全仓库**唯一**构造 execution `RunRequest` 的地方（调用方只有 `orchestrator.ts` 一处，
    经 `scheduler.tick -> executeTask` 到达），因此 normal / retry / rework / handoff continuation /
    reassign 全部自动经过它。
  - 注入条件是 **execution role**，且 T2-b.1 后是**无条件**的：`prompt: composeWorkerExecutionPrompt(...)`。
    （T2-b 初版曾写成 `mode === 'review' ? 原样 : compose(...)`，那是错的：它把 task SEMANTIC 当成 role。
    详见下面 T2-b.1 一节。）
  - **不能用 `agentId === 'codex'` 判断**：Codex 既是 formal execution family，又是 Unified Review
    role。只有 execution path 能决定 role。
  - Unified Review 走 `reviewer.review(...)`，根本不经过 `buildRunRequest`；因此 reviewer 永远拿不到
    实现契约。这个边界是**结构性**的（execution seam vs review seam），不是 `mode` 判断，也不是 prompt 内容检查。
- **Adapters 只是 transport**：`opencode / codex / workbuddy(cn/intl) / cline` 不做任何 policy 判断，
  不包含任何契约文本，只把 `req.prompt` 序列化给 CLI。契约不复制进四份 adapter。

#### 契约覆盖的语义（§21 的九点加上 final-evidence 要求）

1. 先看 task 相关的当前仓库真相（代码/tests/interfaces/config），不要凭 prompt 猜结构。
2. 先在仓库里找可复用的既有实现（helper/module/adapter/contract/fixture）。
3. 相关时检查 upstream/reference/open-source 实现。
4. 复制/适配前验证 licence、API/version 兼容性、本地平台约束。
5. 实现前给出显式决策：REUSE / ADAPT / WRAP / NEW。
6. shared research 只是 evidence/leads；自行验证所依赖的部分。
7. recon 要有界：证据足够做实现选择即停。
8. 不得修改外部 Agent 安装/包/源码目录；读取引用可以，只允许改本项目 scope。
9. 只有完成上述 recon/reuse 决策后才执行实质任务。

另要求 Worker 结束时用几行（不是长报告）说明：Recon 实际检查了什么、Reuse decision 是什么。
措辞刻意用 **"before performing the substantive task"** 而非 "before editing files"，
以便未来 T3 的 read-only Worker 同样适用。

#### Lifecycle 语义

- **新 Worker 判定**（T1 已冻结 `Worker = taskId+agentId+modelId+sessionId`）：same Task/new Agent、
  same Agent/new Model、以及 same Agent+same Model+new Session **都算新 Worker**，都不能继承
  上一个 Worker 的 recon。
- normal / reassign(model switch) / handoff / rework 都是新的 Worker execution，各自收到契约；
  handoff/rework 携带的 evidence 仍然保留，但 verification 要求不消失。
- Session 复用不会静默跳过 recon：新的 execution instruction 中 bounded verification 要求会再次出现。

#### Observability（诚实区分）

- 本轮可证明的是 **contract delivered**：真实链路上到达 runtime 的 `RunRequest.prompt` 确实包含契约。
- **不**声称 "Worker 语义合规已证明"：不做自然语言合规解析，也不实现
  `if output 不含 "REUSE:" then fail Task` 这类脆弱 gate；不新增 ReconEvidenceStore/ComplianceEngine。
- 请求 final evidence 只是给 review/human gate 提供可审阅材料，不是自动判定。

#### 测试

- `tests/worker-execution-contract.test.ts`（新增 suite）：T2B-1..14，覆盖四个 Agent family、
  Codex execution vs Codex review 的 role 区分、model switch、new session、handoff/reassign/rework、
  original task preservation、canonical source count = 1、external-install 保护、shared research 不豁免 recon、
  以及 delivery-vs-compliance 的诚实断言。
- `tests/handoff-production-round.test.ts`：新增 production wiring（§39）——经真实
  Laya pair -> Assignment -> SessionRegistry -> Scheduler -> Orchestrator -> buildRunRequest -> runtime，
  从 fake runtime 捕获最终 request，验证 normal/reassign/handoff/model-switch 的 request 含契约，
  且 **reviewer request 不含实现契约**。
- 反向验证：临时关闭注入后，unit 21 项、production 9 项失败，证明测试确实在检测契约缺失。

### T2-b.1 Implementation Result — IMPLEMENTED

本轮只关闭 T2-b 遗留的两点：P1（execution role 与 task mode 混淆）与 P2（taskInstruction 未逐字保留）。
不改 T2-a，不进入 T3/T4。

#### P1 — role 与 semantic 是两个不同的东西

- **Task semantic/type**（`task.taskType` = implementation / research / test / review）描述
  "Worker 要做什么"。**Execution role** 描述"这个调用在控制面里是什么"。两者不能混用。
- `RunRequest.mode`（`'default' | 'review'`）是**transport profile**：adapters 依它选择原生
  review profile。它是从 taskType 派生的，**不是 role**。
- 因此 T2-b 初版的 `mode === 'review' ? 原样 : compose(...)` 是错的：一个 semantic 为 review 的
  普通 Task，只要走 `Task -> Assignment -> SessionRegistry -> Scheduler -> executeTask -> runtime.run`，
  就是**真正的 execution Worker**（有真实 Attempt、真实 WorkerIdentity），必须收到契约。
- **最终规则**：`buildRunRequest` 是 formal execution request constructor，且全仓库只有一个调用点，
  所以它**无条件**附加 Worker 契约。Unified Review 走 `reviewer.review(...) -> run({...mode:'review'})`，
  根本不经过它。边界来自 **seam**，不来自 flag：
  - execution path → contract
  - Unified Review path → no execution contract

#### P1 附带的 planner wiring 修复

为了能真实产生一个 review-semantic 的**执行** Task（否则 CLI 永远只能构造 implementation child），
修复了 `src/orchestration/workbench-plan.ts`：该文件已经计算了 `taskType` 并放进返回值，却**从未**
传给 `planTasks`，导致所有 committed child 静默回退到 planner 的 `'implementation'` 默认值。
现在把 `taskType` 真正传下去，`spec.taskType` 才如 round-cli 所假设的那样生效。这是 1 行修复，
不改变任何 authority。

#### P2 — taskInstruction 逐字保留

`composeWorkerExecutionPrompt()` 过去调用 `trim()`，因此"unchanged / verbatim"的说法在首尾空白处
并不成立。现改为原样嵌入：只允许追加固定的 contract 与 separator 前缀，不再 trim / dedent /
normalize。空字符串合法（signature 是 `taskInstruction: string`，无 undefined/null 分叉）。

#### 角色边界三方对照

- **Case A** — Codex / implementation Task → execution role → HAS contract。
- **Case B** — Codex / review Task → execution role（Attempt.kind=execution，WorkerIdentity 有效）→ HAS contract。
- **Case C** — Unified Codex Review → review seam → NO implementation contract。

三者同时成立；判定依据始终是 execution path，不是 `agentId`，也不是 `mode`。

#### 测试

- `tests/worker-execution-contract.test.ts`：T2B1-4..10 —— implementation/review/research/test 四种
  semantic 均 HAS contract；review transport profile 未被抹掉；verbatim（含首尾空白）逐字保留；
  Task record 不被修改；契约只注入一次。
- `tests/handoff-production-round.test.ts`：T2B1-1/2/3 —— 真实 `work_kind='review'` round：
  执行的 review Task 走完整链路（runtime.run、Attempt.kind=execution、sessionId 存在、
  workerIdentityOfAttempt != null）且 HAS contract；同一 round 的 Unified Reviewer（agent=codex）
  NO contract。
- 反向验证：恢复旧 `mode === 'review'` gate → 3 unit + 4 production 失败；恢复 `trim()` →
  7 unit 失败。证明测试确实在检测这两个缺陷。

### T1 / T2 SEALED + T3-M0 Model Access 交接

Status: **T1 = SEALED**，**T2 = SEALED**（Owner 正式裁定）。

T3-M0 已冻结 Model Access 架构，canonical source（并已 **SEALED**：Codex T3-M0 Final Review =
PASS WITH P2，`P0 = 0`、`P1 = 0`；6 项 P2 属 documentation / future-implementation constraint，
已作为文档澄清 CLOSED；**runtime 未实现任何 route/candidateId/Gateway/provenance**）：

```text
docs/TEAMRUN_MODEL_ACCESS_ARCHITECTURE.md
```

本审计定义的 `Agent × Model` 语义**不被推翻**，关系如下：

- 新增第三维度 `ModelAccessRoute`：`ExecutionCandidate = (agentId, modelId, routeId)`。
- 当前生产中**所有 route 都是 `agent-native`**（adapter 只传 `--model <id>`，不读凭据、不接
  provider API）。因此本审计中 Laya 的 `(agentId, modelId)` 选择**就是** candidate 的旧子集，
  `AgentModelIntent` / `validateAgentModelIntent` / Assignment exact enforcement 全部保持不变。
- **`routeId` 不进入 `WorkerIdentity`**（§3 of the Model Access doc）：`WorkerIdentity` 仍是
  `{ taskId, agentId, modelId, sessionId }`，本审计 T1 Seal 的四元组不动。
- **Agent ≠ Model 仍是两个一等维度**：同 model 换 harness 仍可能有不同 tool / session /
  permission / review 语义（`review` 仅 Codex 有原生入口；WorkBuddy `-p` 模式必须
  `--permission-mode bypassPermissions`）。Gateway 只统一 transport，不统一 harness 语义。
- Laya 未来 decision shape **推荐 `candidateId`（validated candidate object）**而非手工三元组，
  因为现有 `initialCandidateKey()` 已经是"opaque key into a pre-validated set"的同构机制。
  详见 Model Access doc §20。**本轮不实现。**
- FREE / QUOTA 语义冻结为 **candidate / route 的属性**（同 model 不同 route 可能价格不同），
  这如实记录了 `ACTIVE_FREE_MODEL_POOL` 已经是 pair-keyed 而非 `modelId[]` 的现状。

```text
new authority = 0
parallel WRITE = deferred（Windows process containment）
```
