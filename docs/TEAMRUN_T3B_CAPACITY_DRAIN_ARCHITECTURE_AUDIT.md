# TeamRun T3-b.0 — Capacity Drain Architecture Audit

> **AMENDED by T3-b.0.1 (see the end of this document).**
>
> **T3-b.0 Final Codex Review = BLOCKED.** Three P1s were confirmed against source and by real-scheduler
> probe. Two invalidate parts of the original design:
>
> ```text
> §8  Progress Contract            -> REJECTED   (outcomes.length > 0 is true during pure starvation)
> §9  "width + 1 is sufficient"    -> WITHDRAWN  (repeated refusal is unbounded)
> §13 Review gating                -> CONFIRMED DEFECT, addressed in §8H/§8I
> ```
>
> **The corrected design is §8A–§8L (Round Resolution Scope).** Everything else below stands.
> In particular §2's decisive finding — `Scheduler.tick()` **awaits full settlement**, so a sequential
> re-tick is already a complete drain step — remains true; it was only ever a *necessary* condition,
> never a sufficient one.

Status  = **ARCHITECTURE / CONTROL-FLOW AUDIT · T3-b.0 · read-only · docs only · 2026-10-08**
         **· amended by T3-b.0.1**
Scope   = Audit the production round control flow and decide **where a capacity drain belongs**
          for the frozen goal *"when a legal READ worker cannot dispatch because of Scheduler
          capacity, the existing Scheduler authority keeps advancing it after capacity is
          released, instead of parking it at planned forever."*
Rule    = **Read-only investigation.** No `src/**`, no `tests/**`. No drain implemented, no second
          scheduler, no Candidate Registry, no `routeId`, no Gateway, no parallel WRITE.
Precondition = Owner-ratified: `T1 = SEALED`, `T2 = SEALED`, `T3-a = SEALED`, `T3-M0 = SEALED`
Canonical for = T3-b architecture input. Model Access dimension: `TEAMRUN_MODEL_ACCESS_ARCHITECTURE.md`.

**Bottom line up front.** The drain gap is real, its root cause is a single missing call, and the
fix requires **no change to the Scheduler, to admission, to evidence, or to any authority.** The
critical enabling fact is that `Scheduler.tick()` **awaits full settlement** before returning, so
by the time a tick returns its slots are already free. A second sequential tick therefore drains
naturally. Measured proof is in §7.

---

## 1. Current Round Control Flow

Production path, `src/cli/round-cli.ts`:

```text
runRoundCli
  → planner / classify
  → materializeReadFanout(rootId, membersRaw)      -- N child Tasks created (research / READ)
  → selectInitialAssignment(rootId)                -- Laya's pair recorded per member
  → assignChildren(rootId, spec)                   -- Assignment for EVERY member, identity written
  → runDecisionCycle({ capabilities: handoffCapabilities })     -- EXACTLY ONE call
       → applyDecision(decision, context)
            → context.dispatch()
                 → handoffCapabilities.dispatch      round-cli.ts:1021
                      → decisionCapabilities.dispatch()   -> wb.dispatchReceipt()   workbench.ts:765
                           → NativeWorkbench.dispatch()     workbench.ts:1027
                                → scheduler.tick(...)        workbench.ts:1055   ← THE ONE TICK
       → (report) → observe → Unified Review → Human Gate
```

### Q1 — one tick or several?

> **Exactly one `scheduler.tick()` per round**, on the normal path.

Source facts:

- The decision-cycle step is explicitly single-shot. `round-cli.ts:898-900`:
  > "STEP 5: ONE decision cycle — Exactly one call. Not a loop, not a retry: a round that needs a
  > second round says so in its report and the human decides."
- `round-cli.ts:25-29` (file header):
  > "Decision -> Execute -> Observe -> Report -> END. There is deliberately no `while (true)`, no
  > `setInterval`, no auto-retry and no auto-replan here."
- `runDecisionCycle` has **no loop over dispatch**. `applyDecision` is called once
  (`decision-loop.ts:358`), and its three dispatch sites (`rework`, `retry`, `continue`) are in
  mutually exclusive branches that each `return` (`decision.ts:988`, `:1031`, `:1146`).
- `NativeWorkbench` deliberately **refuses** to be the second tick. `workbench.ts:1332-1337`:
  > "The one dispatch path the Decision Loop is given. It is `dispatch()` plus a projection —
  > deliberately NOT a second tick, because a second `scheduler.tick()` would be a second dispatch
  > loop and could run tasks twice."

A second, **bounded and separately governed** tick source exists: each applied handoff dispatches
once (`round-cli.ts:1215`), bounded by `--handoff-max` and `continuation.ts:646`'s `maxCycles`
loop. That loop exists for *handoff*, not for capacity, and it is a different mechanism with a
different trigger.

`round-cli.ts` contains **zero** `while (` loops in code (the only textual occurrence is inside a
comment). There is **no** drain loop, re-tick, or "tick until waiting is empty" anywhere.

### Q2 — who re-ticks after a capacity-starved first tick?

> **Nobody.** This is the gap, stated exactly.

`waiting` from a tick is consumed **for reporting only**:

```text
receipt.waiting  →  projectDispatchTaskEvidence  →  outcome: 'pending'  →  report
```

It is never fed back into a dispatch. No component owns re-ticking.

### Q3 — is that the direct root cause?

> **Yes. It is the whole root cause.**

The member is not refused, not blocked, not lost. It is *correctly* parked as capacity-waiting and
then **nobody comes back for it**.

---

## 2. Scheduler.tick semantics

Read from `src/orchestration/scheduler.ts`.

### callers

| site | enclosing | note |
|---|---|---|
| `workbench.ts:1055` | `NativeWorkbench.dispatch()` | **the one production dispatch edge** |
| `decision-loop.ts:349` | `runDecisionCycle`'s own dispatch | only when **no** `capabilities.dispatch` was injected; the round always injects one |
| `controller.ts:113`, `:133` | `OrchestrationController.run()` / `.tick()` | controller path, not the round |
| `scheduler.ts:393` | `TaskScheduler.start()` auto-loop | only when `autoTickMs` is given; **the round never passes one** |

### capacity semantics

**`maxConcurrent` is not a Scheduler field at all.** The Scheduler reads it from the orchestrator on
every tick (`scheduler.ts:261-263`):

```ts
    // Read from the gate, which is the same number `executeTask` will enforce.
    const maxConcurrency = this.orch.getConcurrencyLimit();
    let free = Math.max(0, maxConcurrency - this.occupiedSlots());
```

and `getConcurrencyLimit()` is `gate.maxConcurrentAgents ?? gate.maxConcurrency`
(`orchestrator.ts:391-393`).

**S1 — scope: one global per-orchestrator tree number.** Not per-agent, not per-model. There is **no
per-agent limit and no busy-lock** in the Scheduler; `agentId` does not appear in
`scheduler.ts` at all outside hook payloads. T3-a's same-Agent-READ-concurrency property is
therefore preserved by construction, and a drain loop must not add an agent-level cap (§14 below).

**S2 — capacity basis: running-Task count, re-derived from TaskStore every tick**
(`scheduler.ts:162-171`):

```ts
  /**
   * Execution slots occupied right now.
   *
   * Derived from TaskStore every call: a child that is `running` holds a
   * RunHandle and therefore a slot; `planned` and `queued` children hold none.
   * There is no accumulated counter to go stale.
   */
  occupiedSlots(): number {
    return this.scopedTasks().filter((t) => t.status === 'running').length;
  }
```

There is a **second, execute-time** concurrency re-gate that counts only `running` siblings
(`orchestrator.ts:466-471`, `runningChildrenExcluding`), whose comment records a real fix:
*"WAITING children no longer count as occupying a slot."*

Within one tick, the budget is decremented optimistically (`scheduler.ts:340`, `free--`), with a
comment explaining **why re-reading `occupiedSlots()` per iteration is wrong** (workspace prepare is
awaited before the `running` transition, and an earlier version of that bug silently disabled the
cap — *"a tick with 3 ready children and a cap of 2 admitted all 3"*).

**S3 — one tick dispatches at most** `min(dependency-satisfied candidates in planned|queued,
freeSlots-at-tick-start)`. The returned `freeSlots` is recomputed at the end
(`scheduler.ts:365`) but is **not** the dispatch budget.

### await semantics — the decisive fact (§6 of the brief)

> **`tick()` resolves only after every dispatched execution has fully settled.**

`scheduler.ts:343-347`:

```ts
    // Dispatch is concurrent, but `admitted` is built from OUTCOMES, never from
    // the attempt. `executeTask` decides the gate synchronously before its first
    // await, so a denied dispatch resolves quickly; recording it as admitted
    // would claim work that the runtime never saw.
    const settled = await Promise.all(pending);
    dispatched.push(...settled);
```

`pending` holds the `executeTask` promises (`scheduler.ts:268`, `:329`), and `executeTask` blocks
until the run is terminal (`orchestrator.ts:1321-1325`, `await handle.result()`). The scheduler's
own design comment states the consequence (`scheduler.ts:216-219`):

> "Dispatch is concurrent, but `admitted` is built from OUTCOMES … **Returns once every dispatched
> run has settled, so a test can tick, observe, tick again, and see a freed slot reused.**"

**Therefore the timing question resolves in the easy direction:**

```text
tick #1: dispatch A + B concurrently → await A and B to terminal → RETURN
         at return: occupiedSlots() == 0, so every slot is already free
tick #2: sees free slots, dispatches C
```

No progress event, no wakeup, no callback, no concurrency-rework is required. A **second
sequential tick is already a complete drain step.** This is the single most important fact in this
audit and it is what makes the recommended option a *bounded loop around an existing primitive*
rather than a new engine.

Dispatch within a tick *is* genuinely concurrent — all `executeTask` promises are created in the
loop before `Promise.all` — so `maxConcurrent` remains a real ceiling (§19 verified in §7).

### return semantics and the re-entrancy guard

`scheduler.ts:231-247`: a tick inside a tick returns an **empty-but-shaped** result whose single
`skipped` entry is keyed `taskId: '*'`, `code: 'tick-in-progress'`. `round-cli.ts:1098-1100`
explicitly discards `'*'` when reading refusals. Relevant to drain design: **overlapping ticks are
already refused**, so a naive concurrent-tick drain cannot double-dispatch even if attempted.

---

## 3. Root Cause

### width 3 / cap 2 — measured

Existing production proof: `tests/handoff-production-round.test.ts:2056-2073` (T3A3-7) runs a real
round with `--max-concurrent 1` and width 2 and asserts one member stays
`outcome === 'pending'`, `executionSettled === false`, and `allSettled === false`.

Ephemeral probe against the **real** `TaskScheduler` + `TaskStore` (probe in the OS temp directory,
importing repo modules read-only; no repo file created or modified), width 3:

```text
=========== width=3  maxConcurrent=2 ===========
  --- ONE tick (what the production round does today) ---
    tick1  admitted=[fr1,fr2]  waiting=[fr3]  skipped=[]  dispatched=2
    dispatch calls       = [fr1,fr2]
    PEAK concurrent run  = 2
    final states         = fr1=succeeded fr2=succeeded fr3=queued
  --- THREE sequential ticks (the drain loop being proposed) ---
    tick1  admitted=[fr1,fr2]  waiting=[fr3]  dispatched=2
    tick2  admitted=[fr3]      waiting=[]     dispatched=1
    tick3  admitted=[]         waiting=[]     dispatched=0
    total dispatch calls = [fr1,fr2,fr3]
    PEAK concurrent run  = 2   (<= cap: OK)
    final states         = fr1=succeeded fr2=succeeded fr3=succeeded
    DRAIN COMPLETE?      = 3/3  YES
```

### why the third member stays pending

It is **capacity pending, and nothing else**. The scheduler's entire `waiting` emission is
(`scheduler.ts:276-279`):

```ts
      if (free <= 0) {
        waiting.push(task.taskId);
        continue;
      }
```

Reached only when, in order: the task is a candidate (`planned`/`queued`), it has **no** unmet
dependencies, the tick still has dispatch budget, and this is the dispatch call. There is **no
code and no reason emitted with `waiting`** — capacity is the only thing that can produce it.

It is therefore definitively **not**:

```text
assignment refusal   -- Assignment already accepted every member before the first tick
dispatch refusal     -- executeTask was never called for it
dependency blocked   -- unmetDependencies was empty
resource conflict    -- READ members claim 'read'; claimsConflict() returns false for read+read
```

The last point is structural, from `src/orchestration/resource-claim.ts:258-274`: `read + read`
falls through to **allow**. Fan-out members are `research` task type (`fanout.ts:45`) and
`claimModeFor` maps research/review to `'read'` (`round-cli.ts:585-586`), so **no resource or
workspace contention can ever park a READ member.** `maxConcurrent` is the *only* capacity limit
that applies.

### state at end of a width-3 / cap-2 round

```text
fr1  succeeded   Session closed   1 Attempt   receipt: started / writeBackAccepted
fr2  succeeded   Session closed   1 Attempt   receipt: started / writeBackAccepted
fr3  queued      Session OPEN, NOT running   0 Attempts   receipt: pending, executionSettled=false
```

Precisely on Session and Attempt, because these are commonly over-claimed:

- **Session:** `assignChildren` opens a session for every assigned member **before** any tick
  (`workbench.ts:685-694`). So a capacity-pending member **does** hold a session — but it is
  `open`, **not** `running`. T1's invariant holds: the session becomes `running` only at the
  dispatch edge's `onDispatchStart` hook (`workbench.ts:1064-1066`), with the explicit comment
  *"an assigned task that is never dispatched can never leave a permanently 'running' session
  behind."* A drain loop must not pre-open or pre-mark anything.
- **Attempt:** `recordExecutions` walks `tick.outcomes` only (`attempt-integration.ts`), and a
  capacity-pending member has no outcome. **0 Attempts.** A drain loop must not create a
  "waiting Attempt" — there is no such thing, and inventing one would corrupt T3-a's evidence.

---

## 4. Capacity Lifecycle (measured)

All three cases, same width-3 probe:

| capacity | 1 tick (today) | 3 sequential ticks (proposed) | peak concurrency | drained? |
|---|---|---|---|---|
| **1** | `fr1` dispatched; `fr2,fr3` waiting; `fr3` never runs | 1 / 1 / 1 | **1** | 3/3 YES |
| **2** | `fr1,fr2` dispatched; `fr3` waiting; `fr3` never runs | 2 / 1 / 0 | **2** | 3/3 YES |
| **3** | all three dispatched; `waiting` empty | 3 / 0 / 0 | **3** | 3/3 YES |

Three conclusions, each load-bearing:

1. **`cap == 1` is a legal, fully-draining outcome** — `A`, then `B`, then `C`, still **one bounded
   round**, not three user rounds (§18).
2. **`cap >= width` must not degrade to serial.** At cap 3 the first tick already takes all three
   and ticks 2–3 dispatch **nothing**. The loop is therefore **idempotent** when there is nothing to
   drain, which is exactly what the stop condition in §8 relies on.
3. **Peak concurrency never exceeds the cap in any case** (`<= cap: OK` in all three). The drain loop
   does **not** raise concurrency and does not need to; the requested width is a *queue*, not a
   concurrency claim.

This also directly answers §41: the default `--max-concurrent 2` is **not** the problem and must not
be raised as a fix. The missing thing is that a queue longer than the concurrency cap is never
drained. The architecture already intended this — `orchestrator.ts:395-406`:

> "Deliberately a DIFFERENT number from `getConcurrencyLimit()`. Before 5C-4 a single
> `maxConcurrency` meant both, so a tree could never hold more children than it could run — the
> queue could never be longer than the concurrency cap, **which is not a queue.** Separating them
> lets N children wait while M run."

The two caps were separated precisely to make a queue possible. **The drain half was never built.**

---

## 5. Waiting Taxonomy (recorded, not invented)

No new enum is proposed. What exists today, from `scheduler.ts`:

| class | how it is expressed today | emits a code? | settles execution? | should a drain loop retry it? |
|---|---|---|---|---|
| **capacity** | `TickResult.waiting` (`scheduler.ts:128`) | **no code at all** | **no** (`fanout.ts:258-266`) | **YES — the primary object** |
| **dependency** | `skipped` + `code: 'dependency-unmet'` (`:273`) | yes | no | only if a *progress source* exists (§6) |
| **resource** | `skipped` + `code: 'resource-conflict'` (from `executeTask`, `orchestrator.ts:1083`) | yes | yes (pre-runtime refusal) | no — it already settled |
| **availability** | `skipped` + `code: 'agent-unavailable'` | yes | yes | no |
| **quota** | `skipped` + `code: 'quota-exhausted'` / `'quota-unavailable'` | yes | yes | no |
| **assignment** | not a scheduler class — decided before the first tick; surfaces as fan-out `assignment.status === 'refused'` | yes | yes | no |
| **pre-runtime execution refusal** | `skipped` + the `ExecuteOutcome.code` pass-through (`:351-358`) | yes | yes | no |
| **already running** | not a candidate at all (`candidates()` filters `planned`/`queued`, `:181-185`) | n/a | n/a | no — never re-dispatched |
| **already settled** | terminal status → not a candidate | n/a | yes | no |
| **re-entrancy** | `skipped` with `taskId: '*'`, `code: 'tick-in-progress'` (`:236`) | yes | n/a | n/a — structural guard |

The discriminator that matters: **`waiting` is the only class with no code and the only class that
does not settle execution.** Everything that failed has already settled and must not be retried;
everything that succeeded is terminal. Only capacity-waiting is "legitimate work, not yet run".

### The key question the brief poses

> *Which waiting classes have reason to be retried as other workers settle?*

**Only capacity.** And only capacity is *provably* retryable, because it is the only class whose
blocking condition is **provably released** by another member settling:

```text
capacity full → another running worker settles → occupiedSlots() drops → next tick admits
```

There is a hard dependency-direction argument here: within one fan-out, the members are siblings
with `dependencies: []` (`workbench.ts:571-580` sets `dependencies: [] as string[]`). So a member
can never be its own progress source, and capacity is the only reason it is not dispatched.

---

## 6. Dependency waiting must NOT share an unconditional retry

`dependencySatisfied` is the canonical rule (`task.ts:368-375`): only `status === 'succeeded'`
releases a dependant. For a **fan-out member**, `dependencies` is empty, so this class **cannot
occur inside a fan-out at all** — `unmetDependencies` returns `[]` unconditionally.

But a drain loop lives in the round, which may also contain a **downstream dependant** of the fan-out
root. That dependant waits with `code: 'dependency-unmet'` and — critically — its progress source
is **verification**, not worker settlement: the fan-out members reach `to_verify`, and only the
verification step moves them to `succeeded`. Existing proof of that sequence is the scheduler probe
at `tests/read-fanout.test.ts:574-591`, which ticks, observes, then ticks again and watches the
dependant become dispatchable.

Therefore:

```text
capacity waiting      -> retry freely; its blocker provably shrinks as siblings settle
dependency waiting    -> retry only when a REAL progress source moved
```

A loop that blindly re-ticks would spin on a dependant whose upstream cannot yet be verified. This
is the concrete reason the progress contract in §7 must be **progress-based, not attempt-based**
— a tick that dispatched nothing and changed nothing must terminate the loop, not repeat.

---

## 7. Drain Ownership

### Option A — outer bounded drain loop around `Scheduler.tick` (round coordinator)

The existing round coordinator calls the existing dispatch authority again while there is
demonstrated progress and unresolved capacity-waiting members.

### Option B — `Scheduler.tick` loops internally until drained

### Option C — a new drain/execution manager component

Explicitly out of scope per the brief: no `DrainManager`, `RoundExecutionEngine`,
`ParallelWorkerController`, or `TaskPump` authority is proposed or needed.

### Comparison

| criterion | A — outer bounded loop | B — tick loops internally | C — new manager |
|---|---|---|---|
| **authority integrity** | `Scheduler.tick` stays the sole Dispatch Authority; coordinator only *calls* it. Preserves `workbench.ts:1332-1337`'s deliberate "not a second tick". | **Breaks it.** The Scheduler starts deciding *when to stop*, i.e. becomes a workflow engine — exactly what its own header forbids: *"It never implements retry, rework, replan, or review."* | Adds a **second** scheduling authority. Highest regression risk of the three. |
| **implementation size** | one bounded loop + a progress predicate at the existing call site | changes a shared primitive used by 4 call sites, incl. the controller | new module, new wiring, new tests |
| **testability** | observable as tick count + receipt sequence at the round boundary; probe in §7 already demonstrates it | must be tested through every scheduler consumer | new surface to test wholesale |
| **boundedness** | bounded **explicitly** by the loop's own stop condition | bounded by an internal counter the Scheduler does not own | needs a second bound of its own |
| **progress detection** | belongs to the coordinator, which already holds the before/after receipts | belongs inside the Scheduler, which does **not** hold round-level intent | needs a new observer anyway |
| **future candidate compatibility** | neutral — the loop drains whatever `executeTask` admits; identical under `ExecutionCandidate(agent, model, route)` | neutral in principle, but entangles route-admission with loop control | most likely to hard-code agent-family assumptions |
| **regression risk** | **lowest** — no existing behaviour changes for width ≤ capacity, since tick 2 dispatches nothing (§4 idem­potency) | high — changes behaviour for *every* existing scheduler consumer | highest |

### Recommended: **Option A**

This matches the Owner's stated prior, and the source facts independently confirm it:

1. `Scheduler.tick` is already the **sole production Dispatch Authority** and is already shaped as a
   single deterministic decision primitive ("tick, observe, tick again"). Option A is the only option
   that leaves that primitive untouched.
2. The enablement fact is §2: **`tick()` awaits settlement**, so a sequential re-tick is already a
   complete drain step. Option B would be adding a loop *inside* something that already has the
   property the loop needs — it would buy nothing and cost authority integrity.
3. Option C would create the second authority the brief forbids.
4. `workbench.ts:1332-1337` already documents *why* a second dispatch loop is dangerous ("could run
   tasks twice"). Option A respects that warning by reusing the single guarded edge rather than
   adding a parallel path — and the re-entrancy guard (§2) plus the progress predicate (§8) make
   double-dispatch structurally impossible.

---

## 8. Progress Contract — **REJECTED (superseded by T3-b.0.1)**

> **THIS SECTION IS A REJECTED DESIGN. Do not implement it.**
>
> **T3-b.0 Final Codex Review = BLOCKED**, and the blocking finding **P1-2** invalidates the
> predicate chosen below. It is retained only as the record of *why* the first attempt was wrong.
>
> ```text
> REJECTED:  progress  ==  tick.outcomes.length > 0
> ```
>
> **Counterexample (measured, §8A below):** a member that is *repeatedly refused* produces one
> outcome per tick and **zero** progress. `outcomes.length > 0` was therefore true on every one of
> ticks 2–6 of a run in which nothing progressed at all — and worse, while a healthy sibling
> **starved**. This is exactly the failure Codex reported as **P1-1**, and it is unfixable from the
> coordinator alone (**P1-1**: the Scheduler re-selects the already-resolved member, so tracking a
> set locally changes nothing).
>
> **Superseded by:** the round-resolution / unresolved-**set-shrink** contract in **§21 (T3-b.0.1
> Amendment)**. Also note the **"width + 1 is sufficient"** claim made in §9 of this section was
> derived from the rejected predicate and is **withdrawn**: it is false under repeated refusal, which
> is unbounded.

The original text follows for the record.

---

A `while(true) scheduler.tick()` is unacceptable. The loop must terminate on **demonstrated
progress**. The brief asks for the *fewest and most truthful* signal; measurement says exactly one
signal is needed.

**Chosen: "this tick changed the world".** Concretely, a tick counts as progress if **either**:

```text
(a) it dispatched at least one task that was not dispatched before   -> tick.outcomes.length > 0
(b) it produced a state transition that changed some task's status
```

and additionally the loop must not continue if the tick only re-reported a non-capacity condition.

Why this is the minimum truthful signal:

- **"new task dispatched" alone is sufficient *and* necessary** given the await-all semantics. If a
  tick dispatched nothing, then (because `tick()` already awaited everything it started) nothing was
  running, so `occupiedSlots() == 0`, so the budget was `maxConcurrency ≥ 1` — meaning the member was
  dispatched only if it was a candidate. If it was a candidate with satisfied dependencies and a free
  slot and still wasn't dispatched, re-ticking **cannot change that**: the candidate set, the
  dependency states, and the slot count are all functions of TaskStore, and none of them changed.
  **A zero-dispatch tick is provably a fixpoint.**
- This is confirmed by measurement (§4): at `cap == width`, ticks 2 and 3 dispatched 0.
- Therefore `tick.outcomes.length > 0` is a *sound and complete* progress predicate under the
  current await-all model. No separate "state transition" signal is required, and adding one would be
  redundant bookkeeping.

**Rejected signals, and why:**

| candidate signal | verdict |
|---|---|
| `new task dispatched` | **chosen** — sufficient and complete here |
| `new task settled` | redundant — settlement already happened *inside* the tick before it returned |
| `capacity-wait set shrank` | equivalent to the chosen signal in practice, but derived; deriving invites a second truth |
| `Task state changed` | superset of (a) but noisier; would keep the loop alive on unrelated transitions |
| wall-clock / tick budget | a **safety cap only**, never the primary correctness mechanism (§9) |

---

## 9. Stop Conditions and Infinite-Loop Protection

### Primary stop (correctness)

Stop when **either**:

```text
S1  every requested fan-out member is executionSettled
      -> the frozen goal is reached; proceed to report / review / gate

S2  a tick produced ZERO dispatches
      -> provable fixpoint (§8); no further progress is possible THIS round
```

### The critical asymmetry the brief flags

> *S2 must not misread a temporary capacity wait as permanent failure.*

This is satisfied structurally, and it is worth being precise about why:

- S2 fires only when a tick dispatched **nothing** while slots were **free** (guaranteed by
  await-all). So the member is not being starved by capacity at that moment.
- If it is still capacity-waiting at S2, that is a contradiction — it cannot be, because a free slot
  plus a satisfied-dependency candidate means dispatch. So **capacity-pending members are never
  abandoned by S2**; they are always drained first.
- What S2 *can* legitimately catch is a **dependency**-waiting task whose upstream cannot yet
  satisfy it (e.g. a member awaiting verification). That is the correct outcome: the round reports
  it and the human decides, which is exactly the project's frozen one-round philosophy (§25).

### Safety cap (defence in depth, not correctness)

A bounded cap may still be applied as a last-resort guard against a logic error in the predicate —
recommended shape, **derived rather than arbitrary**:

```text
cap = requested fan-out member count + 1 (or: maxConcurrent-independent upper bound of width + small slack)
```

which for width 3 is 4 — chosen because it is *sufficient by construction* (width members each need
at most one tick under await-all, plus one fixpoint tick to observe the stop) rather than a
round number like "100". **It is a guard, not the mechanism**: the progress predicate in §8 is what
stops the loop, and the cap should never be the reason it stops. If the cap is ever hit with pending
work remaining, that is a bug signal, not a normal outcome.

### Re-entrancy, for free

Overlapping ticks are already refused (`scheduler.ts:236`, `tick-in-progress`), so even a mistaken
concurrent drain could not double-dispatch. The design is sequential by construction regardless.

---

## 10. Assignment / Admission Recheck on a Later Tick

**Answer: yes, comprehensively, and it is architectural rather than incidental.**

The Scheduler header states it (`scheduler.ts:17-21`):

> "It does not cache a gate verdict. **Admission is decided by `executeTask` at the moment of
> execution, so a changed budget/quota/capability is always seen.**"
> "It keeps NO concurrency counter of its own. Slot occupancy is derived from TaskStore status on
> every tick, so it cannot drift from the authority."
> "`executeTask` re-runs the gate and is the single execution authority."

So a second tick re-decides admission from current facts. Concretely, the seams that re-run on the
later tick:

| fact rechecked at the later tick | seam |
|---|---|
| agent / model availability | the gate re-run inside `executeTask` |
| quota, budget, capability, free pool | same gate re-run (`GATE_DENY_CODES`, `quota/types.ts:204-214`) |
| concurrency (a slot freed *and* newly taken) | `runningChildrenExcluding`, `orchestrator.ts:466-471` |
| lease liveness | `code: 'lease-not-live'`, `orchestrator.ts:1025` |
| lease version / fencing | `code: 'stale-lease-version'`, `orchestrator.ts:1269`, `:1336` |
| resource claim | `claimResource({ ..., leaseVersion: liveLeaseVersion })`, `orchestrator.ts:1098`; `code: 'resource-conflict'`, `:1083` |
| workspace preparation | inside `executeTask`, deliberately not the scheduler (`scheduler.ts` header) |
| dependency satisfaction | `unmetDependencies` re-evaluated per tick from TaskStore (`scheduler.ts:194-210`) |

**This is why T3-M0's rule already holds**: `candidate projection != authoritative admission`. A
drain loop does not weaken it — it *relies* on it. A candidate captured as available in tick 1 is
re-proven at tick 2, and the T3-M0 §7.1 chain ("Assignment authoritative recheck → execution /
pre-dispatch authoritative recheck") is unchanged.

**Consequence for scoping (§50):** there is **no** "Candidate/Admission Recheck on later dispatch"
work to do. It must **not** be opened as a slice, because it would duplicate an existing guarantee.

### Assignment lifecycle

All members are assigned **before** the first tick, not just-in-time. `round-cli.ts:837-862` calls
`selectInitialAssignment(rootId)` then `assignChildren(rootId, spec)`, and `assignChildren`
(`workbench.ts:623-728`) loops over every non-terminal child, writing each identity and opening each
session. Its own doc (`workbench.ts:462-466`):

> "Assign workers to every non-terminal child of a root … `assignIdentity` refuses anything already
> started, so this is safe to call repeatedly between ticks."

So on tick 2:

```text
REUSED (already decided, must not be re-decided):
  - the selected (agentId, modelId) pair for each member   -- Laya already chose; drain does not re-ask
  - the written Task identity                               -- assignIdentity would now refuse it anyway
  - the opened Session (non-running)                        -- reused; becomes running only at dispatch

RECHECKED (current facts, by executeTask):
  - availability / quota / capability / budget / free pool
  - lease liveness + lease version
  - resource claim + workspace
  - concurrency
```

This matches the brief's §14 exactly: *same Task, same selected Agent × Model, then an
authoritative current-state gate at the later tick* — **no Laya re-selection**.

---

## 11. Session, Attempt and Evidence Lifecycle Across Ticks

### Session

Capacity-pending ⇒ an `open` (never `running`) session exists, 0 executions. On tick 2 the same
session is reused and transitions `running` via `onDispatchStart`. **A drain loop must not open,
close, or pre-mark any session** — that is `assignChildren`'s and the dispatch hook's business
alone, and the round CLI has an explicit standing rule about it (`round-cli.ts:863-872`):
*"there is deliberately NO session open here any more … Assignment is the only thing that may bind
a session to a task."*

### Attempt

Capacity-pending ⇒ **0 Attempts**. Tick 2 success ⇒ **exactly one** current Attempt for that member,
produced by the same `recordExecutions` → `AttemptStore.append` path as tick 1. There is no concept
of a "waiting Attempt", and a drain loop must not invent one — a placeholder record would corrupt the
append-only evidence chain T1/T3-a sealed.

### Dispatch evidence across ticks — compatible by construction

`captureDispatchFacts` writes into a **round-local** `Map` (`round-cli.ts:934`), and T3-a.4 froze
last-dispatch-wins superseding: a task in `outcomes` or `waiting` **overwrites** its current entry,
while a dependency-only skip is deliberately omitted so it cannot clear one. So:

```text
tick #1: C in waiting      -> currentExecutions[C] = { outcome:'pending', attemptId:null, run:null }
tick #2: C in outcomes     -> currentExecutions[C] = { outcome:'started', attemptId: B, run: Result B }
```

The final state is tick 2's `started` bundle, and the correlated attempt↔result pair from T3-a.5 is
produced by the same append-site binding regardless of which tick it happened on. **No stale-receipt
hazard is introduced**, because there is exactly one round-local map and every dispatch overwrites
its own tasks.

One thing worth stating because it is easy to get wrong: tick 2's receipt is a **complete, separate
receipt** (`admitted`/`waiting`/`skipped`/`outcomes`/`executionsByTask` for that tick only). It is
**not** cumulative. So members dispatched in tick 1 are absent from tick 2's receipt and therefore
retain their tick-1 entry untouched — which is correct, since tick 2 neither re-dispatched nor
refused them.

---

## 12. Later-Tick Refusal and Quota Change (§32, §33)

**Scenario:** `C` capacity-pending in tick 1; before tick 2 the model becomes unavailable or the quota
is exhausted.

**Current architecture already supports settling it correctly**, with no T3-b work:

```text
tick #2: C is a candidate, deps met, a slot is free
       -> executeTask runs the gate against CURRENT facts
       -> refuses, e.g. code 'agent-unavailable' / 'quota-exhausted'
       -> outcome { ok:false }  -> the scheduler copies its code into `skipped` (scheduler.ts:351-358)
       -> the round's projection resolves C as outcome:'dispatch-refused', attemptId:null, run:null
       -> executionSettled = true   (fanout.ts:258-266: anything except 'pending' settles)
       -> the fan-out can reach allSettled and proceed to Review
```

So **the member does not get stuck pending**: a genuine later refusal converts it from `pending` to
`dispatch-refused` with the real code preserved, and the round completes. This is the desired
behaviour and it is already what the code does.

Per §33 this audit deliberately does **not** design automatic replacement: if the refusal is
`quota_exhausted`, the existing, separately-frozen handoff semantics
(`quota_exhausted` / `agent_unavailable` / `session_failure`) are the only mechanism, and a capacity
drain must **not** invent a second one. Two frozen negatives:

- **Capacity waiting is never a handoff reason** (§15).
- **`capacity full → switch Agent` is forbidden** unless Laya makes a new decision (§15).

---

## 13. Review Gating — a finding that contradicts the brief's premise

The brief states as frozen:

> "T3-a冻结: Unified Review 只能在所有 requested fan-out member `executionSettled = true` 之后运行."

**Source fact: no such condition exists.** `runUnifiedReview` is invoked at `round-cli.ts:1614`
gated only by the `--no-review` flag (`round-cli.ts:1598`, from `round-cli.ts:362`). The fan-out
aggregation — including `allSettled` — is computed at `round-cli.ts:1426-1427` and written into
`report.fanout`, and then **never consulted again**. `allSettled` does not appear anywhere in the
review entry condition.

Measured consequence today: a width-3 / cap-2 round reviews a round in which one member **never
executed**, and the round still reports `ok` (`report.ok = outcome.status === 'ok' &&
unassigned.length === 0`, `round-cli.ts:1392`). The Human Gate is likewise unconditional; its
completeness test is `round-result.ts:901` (`nonTerminalTasks.length === 0 && !reviewOutstanding`),
and a capacity-pending member classifies as `never_started` (`round-result.ts:869-875`) — reported as
a **decision for the user**, never as a blocker.

**How this interacts with T3-b.** This is arguably the strongest argument *for* the drain: if the
review is not gated on `allSettled`, then a capacity-starved member is currently **reviewed as if it
were complete work**, and the reviewer sees a member with no Attempt and no result. Draining the
capacity-waiting members (§8 S1) removes the *cause* without touching the review contract.

**But the audit must not quietly fix it.** Two distinct issues, and only one is T3-b's:

- **T3-b's problem (in scope):** capacity-waiting members should be drained so they are not pending.
- **A separate correctness gap (out of scope, flag only):** the review / Human Gate does not require
  `allSettled`. Whether to gate the review on it is a **T3-a-seal-adjacent decision** that T3-b.0 has
  no authority to take, because T3-a is sealed and the Owner ruled that T3-a must not be modified.
  **Recommendation: raise this to the Owner as a separate question.** It is not silently folded into
  the drain design.

---

## 14. Observability Model (minimal proposal — no UI)

### What exists today

| dimension | available today | source |
|---|---|---|
| **requested** | `FanoutAggregation.requested` (= `members.length`), plus `FanoutProvenance.members` | `fanout.ts:247`, `:81` |
| **accepted** | per member `assignment.status === 'accepted'`; **no aggregate counter exists** | `fanout.ts:231` |
| **running** | **no field.** `execution-monitor` counts `running`/`waiting` but only when `--observe` was passed | `execution-monitor.ts:443-467`, `round-cli.ts:690`, `:1439` |
| **pending** | `pendingCount` + per member `outcome === 'pending'` | `fanout.ts:252`, `:308` |
| **settled** | `settledCount`, `allSettled`, per member `executionSettled` | `fanout.ts:248-249`, `:321` |
| peak concurrency | **nothing** | — |
| also present | `executedCount`, `refusedCount`, `terminalCount`, `allTerminal`, `nonSucceeding` | `fanout.ts:250-255` |

### Minimal proposal

```text
KEEP AS IS (already correct and unambiguous):
  requested, settledCount, allSettled, executedCount, refusedCount, pendingCount

ADD ONE aggregate, derived, never authoritative:
  acceptedCount = members.filter(m => m.assignment.status === 'accepted').length
  Reason: §36 requires "accepted" to be named WITHOUT being confused with admitted/executed.
          T3-a proved admitted != executed; accepted must be equally distinct. It is a pure
          count of an existing per-member field — no new fact.

ADD PENDING REASON, do not collapse (§38):
  pending is already capability-clean because the scheduler emits `waiting` ONLY for capacity
  (§5). So today pendingCount == capacityPending by construction.
  Recommend naming it so, or attaching the class, rather than merging dependency-blocked into it.
  If a future round ever has dependency-waiting members in the same aggregation, they must be
  counted separately or carry a reason.

PEAK CONCURRENCY (§40) — soundly derivable under await-all, so cheap:
  peakRunning = max over ticks of tick.outcomes.length
  Because a tick awaits settlement before returning, outcomes.length IS the number of members
  that were simultaneously running during that tick, and the cap bounds it.
  Measured (§4): width 3 / cap 2 -> peakRunning 2; / cap 1 -> 1; / cap 3 -> 3.
  This reports the truth the brief wants: requestedWidth=3, schedulerCapacity=2, peakRunning=2.
  It is derived from facts that already exist, so it adds observability WITHOUT touching
  execution architecture (§37: no rewrite of the execution model is needed or proposed).
```

Explicitly **not** proposed: rewriting execution to expose a stable live "currently running"
snapshot. Under the await-all model there is no such moment to observe from the round, and forcing
one would mean rewriting the execution architecture — forbidden here and unnecessary, since peak is
the honest and more useful number.

---

## 15. Same-Agent Concurrency and the WRITE Boundary

**§42 — same-Agent concurrency:** T3-a proved same-Agent READ workers have no global busy lock, and
`scheduler.ts` contains no `agentId`-based limit at all. A drain loop **must not** add a
"one worker per Agent" rule: capacity is `maxConcurrent`, a single global tree-wide number, and that
stays. §42 is satisfied by *not touching* capacity arithmetic.

**§45 — parallel WRITE stays CLOSED.** `PARALLEL_WRITE = CLOSED`; the blocker is unresolved Windows
process containment. This audit proposes nothing that touches WRITE, the spawn gate, or the
access-mode rules. A READ drain proving that capacity can be drained is **not** evidence that WRITE
is safe — they are different containment questions, and the READ drain only reuses a READ-only
member set.

**§46 — inner-node fan-out stays deferred.** Root container → depth-1 member children only.
`scopedTasks()` (`scheduler.ts:187-192`) filters `depth > 0`, and `MVP_MAX_DEPTH = 1`
(`orchestrator.ts:77-80`). A drain loop must not introduce `depth > 1`.

---

## 16. T3-M0 Compatibility

T3-b's candidate is, per §3 and §43, the current `Agent × Model` pair treated as a **native-only
degenerate candidate** `(agentId, modelId, implicit-agent-native-route)`. No `routeId` is minted in
code; this is an architecture explanation only.

When a real `ExecutionCandidate(agent, model, route)` arrives, **the drain algorithm should not
change**, because every step it depends on is candidate-agnostic:

```text
selected candidate
  -> Assignment  (already candidate-shaped: explicitPair is enforced exactly)
  -> Scheduler capacity  (already reads capacity, never agent/model identity)
  -> later tick drains THE SAME selected candidate
```

Concretely, nothing in the proposed loop touches `agentId`, `modelId`, or a route: it counts
dispatches and reads a pending set. The one place to watch is §14's `acceptedCount`, which must
count **candidates**, not pairs, when the dimension grows. T3-M0's §21.1 sequencing statement holds —
T3-b does not wait for, and must not prematurely create, the Model Access runtime.

---

## 17. Frozen Desired Behaviour

```text
width = 3, maxConcurrent = 2

  tick #1: A + B run concurrently; C capacity-pending
           (tick returns only after A and B have SETTLED)
  tick #2: C runs
           (tick returns only after C has SETTLED)
  tick #3: zero dispatches -> fixpoint -> drain loop stops

  fanout allSettled = true
  one Unified Review
  Human Gate
```

And the properties that must hold, each already verified in §4 / §7:

```text
max ACTUAL simultaneous workers = maxConcurrent (=2).  Never the requested width (=3).
requestedWidth = 3 does NOT mean actual concurrency = 3.
capacity == 1 -> A, B, C in three ticks, still ONE bounded round.
capacity >= width -> first tick takes all; later ticks are no-ops (no serial degradation).
every member ends with exactly ONE Attempt, or a settled refusal — never "waiting".
capacity waiting never becomes a handoff reason and never switches Agent.
no Laya re-selection is triggered by capacity waiting.
```

---

## 18. Recommended T3-b Implementation Slices

### T3-b.1 — Capacity Drain Loop (the whole of T3-b)

```text
Seam: the existing dispatch call site in the round coordinator
      (round-cli.ts:1021-1025 handoffCapabilities.dispatch / the decision-cycle dispatch seam)
Shape: bounded loop; per iteration call the EXISTING dispatch authority,
       then re-project the receipt into currentExecutions (existing captureDispatchFacts)
Stop:  S1 all requested members executionSettled
       S2 the tick dispatched zero tasks (provable fixpoint)
Guard: width-derived safety cap, defence in depth only (§9)

Changes expected:
  - round-cli.ts   : the bounded loop + progress predicate + stop condition
  - tests          : width/capacity matrix, plus the negatives in §19 below

Changes NOT expected (and this is the point):
  - scheduler.ts   : UNCHANGED. tick() already drains correctly when called again.
  - assignment.ts  : UNCHANGED. Admission already re-decides per tick (§10).
  - attempt-*.ts   : UNCHANGED. Evidence already follows the dispatch edge.
  - dispatch-*.ts  : UNCHANGED. Receipt + projection already supersede per tick (§11).
  - orchestrator.ts : UNCHANGED. Sole execution edge preserved.
```

### T3-b.2 — Candidate / Admission Recheck on later dispatch

> **DO NOT OPEN.** Measured fact: this guarantee already exists and is architectural
> (`scheduler.ts:17-21`; `executeTask` re-gates lease/quota/capability/availability/resource/
> concurrency). Opening a slice would duplicate a sealed property and invite a second recheck path.
> Instead, T3-b.1 must **add a regression test** asserting the later tick still refuses a candidate
> whose facts went bad (§19 case 5), so the guarantee is protected rather than re-implemented.

### T3-b.3 — Observability

Small and separable; can ship with T3-b.1 or immediately after. `acceptedCount` + `peakRunning`
derived from existing facts (§14), plus naming the pending class. No UI.

### A note on not splitting further

T3-b.1 is deliberately **one** slice and not three. The loop, the stop condition and the
`captureDispatchFacts` call are the same edit; splitting them would produce an intermediate state
where the round can loop forever with no way to stop — i.e. a slice that is not independently safe.
A slice should be independently verifiable, and "loop without stop condition" is not.

---

## 19. Test Plan (proposed, for the implementation slice — not written this round)

```text
1. width3 / cap1  -> 3 dispatches across >=3 ticks; peakRunning == 1; all settled; allSettled true
2. width3 / cap2  -> tick1 dispatches 2, tick2 dispatches 1; peakRunning == 2 (NOT 3, NOT 1)
3. width3 / cap3  -> tick1 dispatches 3, later ticks dispatch 0; peakRunning == 3
4. no-serial-regression: capacity >= width must NOT degrade to serial (case 3 is the guard)
5. dynamic refusal: capacity-pending member whose availability/quota goes bad BEFORE the later tick
   -> later tick refuses with the real code; executed=false; executionSettled=TRUE; actual=null;
      no infinite loop; fan-out can still reach allSettled
6. stop condition: a downstream dependant still `dependency-unmet` -> drain stops on S2,
   does NOT spin, and the dependant is reported as unfinished (never_started), not failed
7. attempt invariant: every drained member has EXACTLY ONE Attempt; a member that ends
   capacity-waiting across the whole round has ZERO Attempts and no "waiting Attempt"
8. session invariant: a member's session is never `running` while it is capacity-pending
9. evidence superseding: after drain, currentExecutions[member].outcome === 'started' with the
   attemptId/run pair from the tick that actually dispatched it
10. tick-in-progress guard: overlapping ticks still refused (existing behaviour, protected)
11. SOLO regression: single non-fan-out round unchanged (no drain loop engaged)
12. WRITE untouched: no test may assert parallel WRITE behaviour; WRITE stays CLOSED
```

---

## 20. Appendix — files read for T3-b.0

```text
src/orchestration/scheduler.ts            tick, occupiedSlots, candidates, unmetDependencies,
                                          runTick, re-entrancy guard, skip vocabulary
src/orchestration/workbench.ts            dispatch(), dispatchReceipt(), assignChildren(),
                                          materializeReadFanout(), session hooks, "not a second tick"
src/orchestration/orchestrator.ts         getConcurrencyLimit, getChildLimit,
                                          runningChildrenExcluding, lease/resource codes, runtime.run edge
src/orchestration/decision-loop.ts        runDecisionCycle dispatch closure, single applyDecision
src/orchestration/decision.ts             the three dispatch branches (continue/retry/rework)
src/orchestration/attempt-integration.ts  recordExecutions (evidence only for tick.outcomes)
src/orchestration/task.ts                 dependencySatisfied, unmetDependencies
src/orchestration/fanout.ts               FanoutExecutionOutcome, executionSettledFrom,
                                          FanoutAggregation, FANOUT_MIN/MAX_MEMBERS, claim rationale
src/orchestration/dispatch-receipt.ts     receipt fields, per-tick (non-cumulative) shape
src/orchestration/dispatch-evidence.ts    DispatchTaskEvidence, superseding / dependency-skip rules
src/orchestration/resource-claim.ts       claimsConflict (read+read allows)
src/orchestration/workspace.ts            mayShareWorkspace
src/cli/round-cli.ts                      control flow, defaults, captureDispatchFacts,
                                          currentActualOf, fanoutFactsOf, review gate, report fields
src/core/types.ts                         RunRequest
tests/handoff-production-round.test.ts    T3A3-7 (the existing width2/cap1 production probe)
tests/read-fanout.test.ts                 the downstream-dependency tick/observe/tick probe
tests/orchestration.test.ts               CASE A-D concurrency-cap coverage
```

Ephemeral probe (run outside the repo, importing repo modules read-only; no repo file created):
real `TaskStore` + real `TaskScheduler`, width 3, capacity 1/2/3, one tick versus three sequential
ticks, recording admitted / waiting / skipped / dispatch count / peak concurrent runs / final
states. Results in §4. It deliberately did **not** use the CLI harness, because the
`productionRound` helper is inline in `tests/handoff-production-round.test.ts` and not importable;
that limitation is stated rather than worked around, and the real-round width-2/cap-1 case is covered
by the existing T3A3-7 test instead.

---
---

# T3-b.0.1 Amendment — Round Resolution Scope

**Status = ARCHITECTURE AMENDMENT · read-only · docs only.** Triggered by **T3-b.0 Final Codex Review
= BLOCKED**. This section **supersedes §8 (Progress Contract)** and **§9's "width + 1" bound**, and
**amends §13 (review gating)**. Everything else in this document stands.

Codex reported three P1s. Each was **verified against source before being accepted**, and two were
reproduced with a real-scheduler probe:

| P1 | claim | verdict |
|---|---|---|
| **P1-1** | an already-resolved refused member stays `planned`/`queued` → the Scheduler selects it again → repeated refusal consumes tick capacity → other pending members starve | **CONFIRMED by probe** (§8A) |
| **P1-2** | `outcomes.length > 0` ≠ new member resolution | **CONFIRMED by probe** (§8A) |
| **P1-3** | Unified Review runs even when fan-out `allSettled === false` | **CONFIRMED in T3-b.0 §13** |

---

## 8A. Starvation Reproduction (measured — the blocking counterexample)

Real `TaskStore` + real `TaskScheduler`, `width = 3`, `maxConcurrent = 1`, `fr2` refused
pre-runtime at the gate with **no Task status change** (matching `orchestrator.ts:1083-1087`,
*"Refused at admission: no workspace change, no runtime call … and the task stays `task.status`"*):

```text
  tick1  selected=[fr1]  admitted=[fr1]  waiting=[fr2,fr3]  outcomes=1
          statuses: fr1=to_verify fr2=queued fr3=queued
  tick2  selected=[fr2]  admitted=[]     waiting=[fr3]     outcomes=1
          statuses: fr1=to_verify fr2=queued fr3=queued
  tick3  selected=[fr2]  admitted=[]     waiting=[fr3]     outcomes=1
  tick4  selected=[fr2]  admitted=[]     waiting=[fr3]     outcomes=1
  tick5  selected=[fr2]  admitted=[]     waiting=[fr3]     outcomes=1
  tick6  selected=[fr2]  admitted=[]     waiting=[fr3]     outcomes=1

  executeTask trace: fr1:RAN  fr2:REFUSED  fr2:REFUSED  fr2:REFUSED  fr2:REFUSED  fr2:REFUSED

  fr2 refusal count          = 5     <-- REPEATED REFUSAL (P1-1)
  fr3 (healthy, last member) = NEVER DISPATCHED  <-- STARVED (P1-1)
```

Four facts follow, and each one kills a specific part of the T3-b.0 design:

1. **The refusal is unbounded.** Ticks 2…∞ are identical. `fr3` never runs. There is no fixpoint, so
   the T3-b.0 stop condition *"a tick dispatched zero tasks"* is **never reached** — the loop never
   terminates.
2. **`outcomes.length > 0` on every one of those ticks** while nothing progressed. That is P1-2, and
   it is why the T3-b.0 predicate is rejected rather than merely incomplete.
3. **The resolved member is still a candidate**, because `candidates()` is `planned|queued` only
   (`scheduler.ts:181-185`) and a refusal deliberately leaves the status alone. `fr2` is therefore
   re-selected forever.
4. **The coordinator cannot fix this by tracking a set.** The control run in the same probe tracked
   `unresolved` correctly (`[fr1,fr2,fr3] → [fr2,fr3] → [fr3] → [fr3] → …`) and the refusal count
   **still** reached 5, because knowing a member is resolved does not stop the Scheduler selecting
   it. **Selection must be constrained, which requires a seam on the Scheduler itself** (§8B).

### Verdict on the previous design

```text
outcomes progress  : REJECTED. True during pure starvation (P1-2).
width + 1 proof    : WITHDRAWN. Derived from the rejected predicate; repeated refusal is unbounded.
full-tick drain    : INSUFFICIENT. Draining requires excluding already-resolved members.
```

---

## 8B. Round Resolution Contract

### The invariant

```text
requested member  →  unresolved  →  exactly ONE resolution in this bounded round
                  →  resolved    →  must never be selected again IN THIS ROUND
```

`resolved` is **exactly** T3-a's frozen `executionSettled === true`, and it may arrive by any of:

```text
actual execution success / failure / timeout
Assignment refusal
pre-runtime dispatch refusal (incl. resource-conflict, lease-not-live, agent-unavailable)
post-runtime write-back refusal
```

It is explicitly **NOT**:

```text
Task terminal  ·  Task succeeded  ·  dependencySatisfied  ·  verification complete
```

### Task status must NOT be mutated to achieve exclusion

Verified in source: a refusal returns `status: task.status` and **changes nothing**
(`orchestrator.ts:1083-1087`). So a refused member legitimately remains `planned`/`queued`, which is
precisely the T3-a-legal state:

```text
executionSettled = true
taskTerminal     = false
dependencySatisfied = false
```

> **Frozen prohibition.** To stop the Scheduler re-selecting a resolved member, we **must not**
> forge `status = failed | cancelled | succeeded` (or any other transition). That would pollute
> `TaskStore` semantics, contradict the refusal contract above, and destroy the distinction between
> *"this was refused"* and *"this ran and failed"* — which is the distinction T3-a exists to keep.
> Exclusion is a **round-execution-scope** concern, not a Task-state concern.

### Source of `resolvedMemberTaskIds` — derived, never owned

The set must be **derived** from facts that already exist, in the round coordinator, and cached for
the current bounded round only:

```text
FanoutProvenance.members           -> who was REQUESTED (the scope)
+ Assignment outcomes              -> assignment-refused (pre-tick resolution)
+ current dispatch evidence         -> started | dispatch-refused (T3-a.4 evidence map)
+ Attempt / result facts            -> executionSettled (the T3-a fanout aggregation)
```

The **existing** seam is `fanoutFactsOf` / `projectFanoutAggregation`
(`fanout.ts:227-256`, `:306-327`), whose per-member `executionSettled` is already exactly the
predicate required (`executionSettledFrom(outcome) = outcome !== 'pending'`, `fanout.ts:258-266`).
The recommendation is a **minimal shared pure helper** over the existing inputs — **not** a new
authority. Explicitly forbidden and not proposed:

```text
ResolutionStore · DrainStateAuthority · RoundMemberManager · any persistent member registry
```

The round-local set is a **derived value / cache for the current bounded round**. It decides nothing
on its own: it cannot admit, refuse, dispatch, or settle anything.

---

## 8C. Scheduler Scope — Options A–E

### Existing seam: **there is none**

Read in full. `tick`'s signature is (`scheduler.ts:231`):

```ts
  async tick(promptFor?: ReadonlyMap<string, string>, threadFor?: ReadonlyMap<string, string>,
             hooks?: TickDispatchHooks): Promise<TickResult>
```

- `promptFor` / `threadFor` are **per-task content** maps, consulted *inside* the candidate loop
  (`scheduler.ts:297`), i.e. **after** selection — so they cannot filter.
- `hooks` are observation callbacks.
- Candidates come from `candidates()` → `scopedTasks()` = `depth > 0`, optionally narrowed by
  `rootTaskId` (`scheduler.ts:181-192`). That is a **tree** scope, not a member scope.

So **Option C is unavailable**: there is no existing per-task selection seam to reuse. A parameter
must be added. This is the one genuinely new surface T3-b.1 needs, and it is why the control run in
§8A could not fix the starvation.

| option | verdict |
|---|---|
| **A — positive allowlist of unresolved member taskIds** | **RECOMMENDED** |
| **B — explicit `excludeTaskIds`** | viable, weaker (see below) |
| **C — reuse an existing seam** | **unavailable** — none exists |
| **D — mutate TaskStore status** | **REJECTED** — §8B prohibition; pollutes Task semantics |
| **E — new manager component** | **REJECTED** — second authority, forbidden |

### Allowlist vs exclude-list

```text
allowlist  taskIds: [unresolved members]   <- recommend
excludelist excludeTaskIds: [resolved members]
```

Both would work, and the Owner prefers the allowlist; the source facts support it:

- **Unrelated tasks cannot be caught by it.** The allowlist *names* the members; the exclude-list
  must enumerate resolved members and still leaves "every other planned task in the tree" eligible.
  A downstream dependant or the SOLO child sits in the same `scopedTasks()` set, so an exclude-list
  is an omission risk exactly where the brief warns (§11, §19).
- **It states the round's intent directly**: "this bounded fan-out execution set".
- **Resolved members leave naturally** — no set-difference logic, and no chance of a stale
  `resolved` set wrongly excluding a *future* member.
- **Candidate-agnostic**: it is a list of `taskId`s, with no `agentId`/`modelId`/route reference, so
  it is unchanged when `ExecutionCandidate` arrives (§30).
- **SOLO is unaffected by construction**: with no `FanoutProvenance` there is no allowlist, so the
  call passes nothing and the existing single-tick behaviour is unchanged (§37).

### What the Scheduler keeps

Adding an allowlist **narrows candidates only**. Every admission decision stays exactly where it is:

```text
Scheduler remains responsible for: status filter · dependency satisfaction · capacity budget
                                     · dispatch order · and it still calls the single executeTask
coordinator supplies only:          "which tasks this bounded fan-out execution round may consider"
```

---

## 8D. Authority Integrity (seal conditions)

- **A1 — who decides a member is resolved?** The **existing evidence projection**
  (`fanoutFactsOf` / `projectFanoutAggregation` → `executionSettled`), i.e. Assignment outcomes +
  current dispatch evidence + Attempt/result facts. **Not** the Scheduler guessing, and not a new
  store.
- **A2 — who decides which unresolved member actually dispatches?** **`Scheduler.tick`.**
  Unchanged.
- **A3 — is the coordinator a second Scheduler?** **No.** It computes a *set membership* from facts
  that already exist, and hands it to the Scheduler as a scope. It performs **no** ranking, **no**
  ordering, **no** capacity arithmetic, **no** gating, and **no** dispatch. The Scheduler still
  refuses a member on its own authority (status, dependency, capacity, gate) and the coordinator
  cannot override that. **This is the seal condition.**

---

## 8E. Corrected Progress Contract — unresolved **set shrink**

```text
beforeUnresolved = requested member taskIds whose executionSettled == false
afterUnresolved  = the same, recomputed after this tick's dispatch is captured

progress  iff   afterUnresolved.size < beforeUnresolved.size
```

Set-shrink is preferred over a count because it **directly expresses the round's goal** (drain the
requested set to empty) rather than a proxy for it.

### Soundness per case

| case | before → after | shrink? | correct? |
|---|---|---|---|
| healthy execution | A unresolved → A settled | yes | yes — real progress |
| dispatch refusal | B unresolved → B settled | yes | yes — a resolution *is* progress, even though nothing ran |
| capacity waiting | C unresolved → C not selected | no | yes — no false progress |
| repeated refusal of an already-resolved member | **cannot occur** — B is not in `beforeUnresolved`, so it is not in the allowlist | n/a | **this is the P1-1 fix** |

The last row is the whole point: exclusion happens **before** selection, so the starvation mechanism
of §8A is removed structurally rather than detected after the fact.

### Scope limit (§11)

Progress is computed over **`FanoutProvenance.members` only**. A downstream dependant, the SOLO
child, or a handoff-generated task must **not** be able to make the fan-out loop iterate, and must
not be counted as fan-out progress. The allowlist is the enforcement point for this, not a
convention.

---

## 8F. Fixpoint and the Safety Bound

```text
if unresolved.size == 0              -> execution phase COMPLETE
else if afterUnresolved.size
        < beforeUnresolved.size       -> continue (real progress)
else                                 -> bounded-round FIXPOINT; stop the execution drain
                                     -> go to INCOMPLETE ROUND HANDLING (§8H),
                                        NOT to Unified Review
```

A fixpoint with `unresolved > 0` means: requested members remain, but none newly settled this
iteration, so **no internally-provable progress is available in this bounded round**.

### Does a safety cap still exist? — yes, but only as a non-correctness guard

The old "`width + 1` is sufficient" claim was derived from the rejected predicate and is
**withdrawn**: under repeated refusal the iteration count is unbounded. Under the **corrected**
contract the bound argument returns, and it is stronger than a count:

```text
The unresolved set is monotonically non-increasing inside the execution phase,
and it strictly shrinks on every iteration that continues the loop.
Therefore at most `requestedWidth` iterations can make progress.
`requestedWidth + 1` iterations is therefore a sufficient, DERIVED bound
(one extra iteration to observe the fixpoint) - not an arbitrary number.
```

**This bound holds only if monotonicity holds** — see §8G. If monotonicity were broken, the cap would
become load-bearing correctness machinery, which is exactly why §8G matters more than the cap.

---

## 8G. Monotonicity — verified, with one real exception

Required property: inside a bounded round, a member's `executionSettled` goes `false → true` and
**never** `true → false`.

### Verified: monotone within the execution phase

`executionSettled` is derived from `executionSettledFrom(outcome) = outcome !== 'pending'`. Once a
member has executed, its Task leaves `planned`/`queued` (it becomes `to_verify`), so
`candidates()` (`scheduler.ts:181-185`) can never select it again — there is no path by which the
execution phase can push a settled member back to `pending`. Combined with the allowlist, this is
monotone.

### The one exception: a capacity-pending handoff continuation **can** flip it back

**This is the finding §31–§34 asked for, and it is real.**

`captureDispatchFacts` **overwrites unconditionally** per dispatch (T3-a.4 last-dispatch-wins), and the
handoff-continuation dispatch **also** calls it (`round-cli.ts:1195-1199`). So if a handoff
continuation on the same `taskId` were itself capacity-waiting, the projection would become
`outcome: 'pending'` and a previously-settled member would read as **unsettled**.

Whether that is reachable is a separate question, and the answer is what makes the design safe:

- **Phase ordering is execution → handoff → review** (`runDecisionCycle` `:1048`, then
  `runHandoffContinuation` `:1140`, then `runUnifiedReview` `:1614`).
- The handoff dispatch is `wb.dispatch(new Map([[record.taskId, continuationBrief]]))`
  (`round-cli.ts:1215`) — a **direct single-task dispatch**, not the fan-out-scoped tick.
- The fan-out allowlist is a **parameter of the execution-phase tick call only**. It is not installed
  as a persistent scheduler filter.

**⇒ the exclusion scope must be confined to the execution phase.** If it were installed round-wide
(a persistent scheduler-level filter), it would suppress a legitimate handoff re-execution on the
same `taskId`. **That is the design constraint that makes `taskId` a sufficient scope key**, and it
is why §8J keeps the scope phase-local rather than round-global.

### Scope key: `taskId` is sufficient — with the phase bound

`continuation.ts:15-16` states the identity model plainly:

> "…not a clone, not a 'continuation' sibling: **the same `taskId`, with a second `AttemptRecord`
> appended. TaskId is the stable identity of the work.**"

So a handoff continuation re-executes the *same* `taskId` and appends a *second* Attempt. Resolution
therefore **cannot** be a permanent property of a `taskId` for the whole round — it is a property of
**one fan-out member execution generation inside the execution phase**.

**Recommendation:** scope key = `taskId`, **scoped to the execution phase**. Do **not** introduce an
attempt/assignment generation key: nothing in the source requires it, and §33 says not to enlarge
the key prematurely. The trigger for revisiting would be a *proven* case of the same task needing a
second resolution **inside the same execution phase**, and §8G shows the handoff case does not.

### One-execution-per-member (§34)

**Not currently frozen as an invariant** — T3-a froze attribution and settlement, not a per-member
execution count. Within the execution phase the allowlist enforces it (one resolution → removed from
scope). Across phases, a handoff continuation legitimately produces a **second Attempt on the same
`taskId`** by design. So the accurate statement is:

```text
one requested fan-out member  ->  AT MOST ONE execution resolution
                                  WITHIN THE EXECUTION PHASE of this bounded round
```

and that is enforced by the allowlist, not asserted by an existing authority.

---

## 8H. Round Completion Guard (P1-3)

### Frozen

```text
fanout exists  AND  allSettled === false   ->  DO NOT run Unified Review
allSettled === true                       ->  review enabled -> EXACTLY ONE Unified Review
allSettled === false AND fixpoint reached  ->  NO Unified Review -> round = INCOMPLETE
                                              -> Human Gate (asking the user)
```

### Where it belongs: the round coordinator, immediately before `runUnifiedReview`

`round-cli.ts:1597-1636` is the review entry, and it is currently gated **only** by `o.review`
(`:1598`, from `:362`). The coordinator is the right home because it owns the phase transition
*execution phase → review phase*; putting the guard in the reviewer, the Scheduler or `AttemptStore`
would each put a round-completion decision inside an authority that has no business knowing about
fan-out completeness.

### `allSettled` must be recomputed, not remembered

The aggregation is computed at `round-cli.ts:1426-1427`, i.e. **before** the review block, from
`projectFanoutAggregation(p, fanoutFactsOf)`. A drain loop mutates dispatch evidence across
iterations, so the guard must read a **freshly recomputed** `allSettled`, not the value written into
the report earlier.

---

## 8I. Incomplete Round Semantics — no fake review verdict

`REVIEW_STATUSES = ['completed', 'unavailable', 'failed', 'not_requested']`
(`unified-review.ts:506`), and `verdict` is *"Present ONLY when the review genuinely completed. Never
synthesised."*

The required distinction is:

```text
review SKIPPED because execution was incomplete   !=   review RAN and FAILED
```

Today **no status expresses the left side**: `--no-review` and a withheld review would both be
`not_requested`. Minimum honest options:

| option | change | assessment |
|---|---|---|
| add `'execution_incomplete'` to `REVIEW_STATUSES` | one vocabulary member | **recommended** — the two situations deserve different names, and reusing `not_requested` re-creates exactly the ambiguity §38 forbids |
| reuse `not_requested` + a distinguishing `reason` | none | acceptable fallback, weaker: `--no-review` and withheld review stay textually confusable |

**A `failed` verdict must never be synthesised for a skipped review** — the reviewer did not run, and
fabricating its opinion would be the exact dishonesty T3-a's evidence rules forbid.

### Human Gate

`HUMAN_GATE_STATUSES = ['not_ready', 'waiting_for_user', 'ready_for_next_round', 'completed']`
(`round-result.ts:351-356`), with the comment *"Four values because three would force a lie"*, plus
`HumanGate.roundComplete: boolean` (`:371`). The gate is recomputed from task statuses + review status
on every call (`roundComplete = nonTerminalTasks.length === 0 && !reviewOutstanding`,
`round-result.ts:901`), and an unstarted task is reported in `unfinished`/`neverStartedTasks` with
reason *"never dispatched (refused at admission, or not selected this round)"` (`:869-875`).

So the **gate already has the vocabulary** to express an incomplete execution set. The actual defect
is narrower and more serious:

```text
report.ok = outcome.status === 'ok' && unassigned.length === 0      round-cli.ts:1392
```

This is computed **independently of fan-out `allSettled`**, so an incomplete fan-out currently yields
`ok: true` *while the gate simultaneously reports not-complete* — the report contradicts itself. A
minimal recommendation (not implemented here): make `report.ok` consistent with the gate's
`roundComplete`, and record an explicit incomplete-execution marker so the UI cannot render
`ok: true` with no review as "successfully reviewed".

---

## 8J. Peak Metric — corrected, and deferred

**The T3-b.0 recommendation `peakRunning = max(tick.outcomes.length)` is WITHDRAWN.**

The probe invalidates its meaning: a *refused* member appears in `outcomes` (`admitted: []`,
`outcomes: 1`), and `executeTask` performs its gate synchronously before its first `await` — so
`outcomes.length` counts **selections/attempts**, including immediate pre-runtime refusals that never
started a runtime. It is therefore **not** `peakRunning`.

Honest naming if it is ever recorded:

```text
maxBatchSelected  / maxBatchAttempted   <- count of executeTask invocations in one tick
```

which is a *dispatch-batch* metric, explicitly **not** a runtime-concurrency metric. A true
`peakRunning` would need the existing `onDispatchStart` / `onDispatchTerminal` hooks (or the
execution monitor's live counts) — real instrumentation, and out of scope for T3-b.1.

**Recommendation: T3-b.1 adds no peak metric.** The contract that must hold instead is the
*invariant*: actual simultaneous workers ≤ `maxConcurrent`, which the existing cap already enforces
and which T3B1-1/2/3 should assert as a bound, not as a reported number.

---

## 8K. Recommended T3-b.1 — exact scope

```text
1. derive the unresolved member allowlist from the existing fan-out evidence projection
   (requested members minus executionSettled)                         [round-cli.ts]
2. add a positive candidate allowlist parameter to Scheduler.tick
   (taskIds?: readonly string[] | null; null/undefined == today's behaviour)  [scheduler.ts]
3. bounded drain loop over the EXISTING tick seam, scoped to the allowlist, and confined to the
   execution phase so a later handoff continuation on the same taskId is unaffected  [round-cli.ts]
4. progress = unresolved set shrink; stop on unresolved==0 or fixpoint
5. Round Completion Guard: recompute allSettled; do not run Unified Review when false
6. incomplete round result: distinct review status + report.ok consistent with roundComplete
7. observability: regression-only (no peak metric)
```

### Likely files

| file | change |
|---|---|
| `src/orchestration/scheduler.ts` | one optional candidate-allowlist parameter in `tick`/`runTick` + `candidates()` filtering. **Nothing else.** |
| `src/cli/round-cli.ts` | allowlist derivation, bounded loop, progress/fixpoint, round-completion guard, incomplete result |
| `src/orchestration/unified-review.ts` | one `REVIEW_STATUSES` member for "review withheld" |
| `src/orchestration/round-result.ts` | only if the incomplete marker needs a field |

**Deliberately untouched:** `assignment.ts`, the `orchestrator` execution edge, `AttemptStore`,
`SessionRegistry`, dispatch evidence, `fanout.ts` evidence semantics. T3-b.1 adds **no** authority.

### Required tests (18)

```text
T3B1-1  width3/cap1 healthy            A -> B -> C
T3B1-2  width3/cap2 healthy            A+B -> C
T3B1-3  width3/cap3                   A+B+C in one batch
T3B1-4  B unavailable before its tick  A -> B refusal ONCE -> C   (the §8A regression)
T3B1-5  two refused members           each resolves exactly once, no starvation
T3B1-6  resolved member excluded while its Task is still planned
T3B1-7  capacity-pending member stays eligible
T3B1-8  progress == unresolved set shrink (and NOT outcomes.length)
T3B1-9  fixpoint with unresolved>0    no spin, bounded
T3B1-10 allSettled=false              Unified Review invocation count == 0
T3B1-11 allSettled=true               Unified Review invocation count == 1
T3B1-12 incomplete                    Human Gate reached with incomplete status (not ok=true)
T3B1-13 session reuse                 no duplicate open; never running while pending
T3B1-14 attempt count                 exactly one per member that actually executed
T3B1-15 cross-tick evidence           pending -> started supersession correct
T3B1-16 SOLO regression               single tick, unchanged
T3B1-17 WRITE                         still runtime 0 (unchanged)
T3B1-18 handoff interaction           a handoff-approved continuation on the same taskId still
                                     dispatches AFTER the execution phase  (the §8G guard)
```

---

# T3-b.1 Implementation Result — IMPLEMENTED

**Status = IMPLEMENTED.** The §8A–§8L contract is now real code, proven by test and by a mutation
proof. The starvation counterexample in **§8A is deliberately retained**: it is the reason the
Scheduler scope seam exists, and deleting it would leave the fix unmotivated.

## What changed (and what deliberately did not)

| file | change |
|---|---|
| `src/orchestration/scheduler.ts` | `TickScope` type; `tick(..., scope?)` and `runTick(..., scope?)`; `candidates(scope?)` filters the **candidate set before any dependency check and before any capacity is consumed**. No field, no persistence. |
| `src/orchestration/workbench.ts` | `dispatch(promptFor?, resume?, scope?)` and `dispatchReceipt(..., scope?)` forward it verbatim. |
| `src/cli/round-cli.ts` | the bounded fan-out drain loop, the unresolved-set derivation, the Round Completion Guard, `executionIncomplete`, `report.fanoutDrain`. |
| `src/orchestration/unified-review.ts` | `REVIEW_STATUSES` gains `execution_incomplete`. |

**Untouched, as planned:** `assignment.ts`, the orchestrator execution core, `AttemptStore`,
`SessionRegistry`, `dispatch-evidence.ts`, `attempt-integration.ts`, and the fan-out evidence model.

## The four contracts, as implemented

1. **Scope is a POSITIVE allowlist, per invocation, never persisted.** `TickScope.taskIds` is a
   parameter of one `tick()`; `TaskScheduler` has no scope field, so a handoff continuation
   legitimately re-executing the same `taskId` in a later phase is unaffected.
2. **`unresolved` comes from evidence, never from status.** It is
   `projectFanoutAggregation(p, fanoutFactsOf).members.filter(m => !m.executionSettled)` — the same
   facts the report and the review packet read. No status heuristic, no attempt-count heuristic.
3. **Progress is the strict shrink**, `afterUnresolved.size < beforeUnresolved.size`. Never
   `tick.outcomes.length > 0`.
4. **The scope dies with the loop.** It is not a round-wide scheduler filter.

## Proof

**Mutation proof (§48).** Removing the scope filter from `candidates()` and reverting to
`candidates()` restores the §8A starvation exactly:

```text
FAIL T3B1-4: the refused member is selected EXACTLY ONCE :: fr2 selected 2x: fr1,fr2
FAIL T3B1-4: and the healthy follower still executed    :: fr3 executed 0x: fr1,fr2,fr2
FAIL T3B1-4: the drain completed                        :: {"complete":false,"fixpoint":true}
FAIL T3B1-5 / T3B1-6 likewise
```

The guard tests have teeth; they are not merely counting a final total.

**Honest coverage note.** The mid-drain *pre-runtime gate refusal* cannot be produced through the
CLI harness: `productionRound`'s `quota` is static for the whole round and `outcomeFor` only shapes
the `RunResult` of a run that already started. T3B1-4/5/6 are therefore proven against the **real
`TaskScheduler`** with a stubbed `executeTask`, which is precisely the seam the fix lives in. The
healthy drain paths are proven end to end on real rounds (T3B1-1/2/3).

## Retargeted T3-a tests

Two T3-a tests encoded the pre-drain contract and were retargeted rather than deleted, because
T3-b.1 changes that behaviour on purpose:

- `T3A2-5` (width 3 / cap 1 left two members unsettled) -> **T3B1-1**, all three now drain.
- `T3A3-7` (width 2 / cap 1 left one pending) -> **T3B1-2**, both now drain.

The invariant both originally protected — *a capacity wait is a `pending`, never a resolution* — is
unchanged and still asserted, now observed per-iteration: `T3A4-7` (pure projection),
**T3B1-7** (a capacity-pending member stays eligible, and `waiting` carries no refusal code), and
**T3B1-6** (a member that *was* refused is excluded even though its Task is still `queued`).

## Round Completion Guard

`allSettled === false` now **withholds** the review instead of running it over a round that is not
finished. The new status is deliberately distinct from both neighbours:

```text
failed              would be a lie — the reviewer never ran
not_requested       would hide the gap behind --no-review
execution_incomplete  correct: requested but withheld because the execution set is unfinished
```

No verdict, finding or packet opinion is synthesised. `report.ok` can no longer contradict the Human
Gate: an incomplete execution set is not ok, and `executionIncomplete` is reported separately so
"review did not run" is never rendered as a failure of the work.

## Peak metric: still not added

§8J's withdrawal stands. `outcomes.length` counts selections including immediate pre-runtime
refusals, so it is not `peakRunning`. T3-b.1 adds **no** peak metric; the capacity bound is
asserted as an invariant instead.

---

# T3-b.1a Implementation Result — Human Gate completion + fan-out handoff closure

**Status = IMPLEMENTED.** Closes the two remaining P1s from the T3-b Final Review. The drain, the
Scheduler scope and the progress contract were **not touched** (`scheduler.ts` is byte-identical to
its T3-b.1 state; `unified-review.ts` too).

## P1-A — the Human Gate now consumes the same completion truth

**Root cause.** `deriveHumanGate` computed

```text
roundComplete = nonTerminalTasks.length === 0 && !reviewOutstanding
```

and *neither* term could see an incomplete fan-out:

- a capacity-pending member is `queued`, which classifies as **`never_started`**, not mid-lifecycle,
  so it was never in `nonTerminalTasks`;
- `execution_incomplete` **is** a member of `REVIEW_STATUSES`, so `reviewSettled` was true and
  `reviewOutstanding` was false.

So an incomplete round reported `roundComplete: true` with the reason *"all 2 executable task(s)
settled"* — the report, the review and the gate told three different stories.

**Fix.** The final completeness truth is produced **once** by the round coordinator (from the same
post-drain `allSettled` aggregation that guards the review and sets `report.ok`) and is **passed
into** `buildRoundResult` → `deriveHumanGate` as `executionIncomplete`. It is consumed as a fact:
the gate derives nothing, re-scans no status, and gains no execution authority.

```text
roundComplete = !executionIncomplete && nonTerminalTasks.length === 0 && !reviewOutstanding
```

Three follow-ons, all required for honesty rather than for the boolean:

- the misleading `review-unavailable` decision ("the round is finished and the execution evidence
  stands on its own") is suppressed when the set is incomplete — the reviewer never ran, so there is
  no judgement to have missed;
- a new `execution-incomplete` decision names the gap;
- the reason says the execution set is **INCOMPLETE** and never claims the round finished.

**No new Human Gate status.** `HUMAN_GATE_STATUSES` still has exactly its four values. Because the
orchestrator genuinely *stopped* (nothing is mid-flight; the work is simply unfinished), the honest
existing value is `waiting_for_user` — with `roundComplete: false`. If work is also still in flight,
`not_ready` is kept.

**Mutation proof.** Restoring the old expression reproduces P1-A exactly:

```text
FAIL T3B1A-1: THE FIX — HumanGate.roundComplete = false :: roundComplete=true status=waiting_for_user
FAIL T3B1A-1: the gate reason does NOT claim the round finished :: reason=all 2 executable task(s) settled and the review has…
FAIL T3B1A-2: HumanGate.roundComplete = false even with review disabled :: roundComplete=true
```

## P1-B — the fan-out scope-expiry regression is now real

T3-b.1's `T3B1-18` was **SOLO**, so it did not prove what the seal required. The new
`T3B1A-5/6/7` run a real `PARALLEL_READ` topology, let a member resolve in the initial
fan-out execution phase, and then let the **existing** handoff semantics trigger on that member:

```text
T3B1A-5  one fan-out member has TWO execution Attempts: initial resolution + handoff continuation
T3B1A-7  both Attempts carry the SAME taskId (not a sibling, not a new Task)
T3B1A-5  distinct attemptIds; second execution on a different Agent; its own Session
T3B1A-6  the fan-out execution scope did NOT persist into the handoff phase
T3B1A-6  the drain itself still completed (the scope was per-iteration)
```

**The scope-lifetime assertion is behavioural and needs no new tooling.** The drain removes a member
from its scope the moment it resolves. If that scope had leaked into the handoff phase, the
continuation dispatch on that same taskId would have found no eligible candidate and **the second
Attempt would not exist**. Its existence is the proof. The SOLO `T3B1-18` coverage is retained
alongside it.

## Reachability note (how an incomplete fan-out is produced)

An incomplete execution set is reachable through the CLI in exactly one way: **capacity that never
frees**. A capacity-pending member is drained; a refusal *settles* a member; and fan-out members
carry `dependencies: []`, so an unsatisfiable dependency cannot strand one. The T3B1A tests
therefore use `--max-concurrent 0`, where every candidate stays in `waiting`, nothing dispatches,
the unresolved set never shrinks, and the drain reaches its fixpoint with work genuinely
unfinished. No harness hook was invented to manufacture it.

## One honest observation about the complete path

In a passing round the members finish in `to_verify`, which this project classifies as
`in_flight`, so the Human Gate is legitimately **not** ready until VERIFICATION — a separate
authority — moves them on. That is pre-existing behaviour, unrelated to execution completeness, and
T3B1A-3/4 assert against it precisely: they check that the gate is *not* held shut by the
execution-incomplete path, rather than asserting `roundComplete === true`.

---

# T3-b.1b Result — the scoped-drain → same-task-handoff regression is now real

**Status = TEST-ONLY. `src/**` unchanged.**

## Why the previous fixture was insufficient

T3-b.1a's `T3B1A-5/6/7` ran `PARALLEL_READ width 2 / cap 3`. Every member fit in the **first
batch**, so:

```text
drain iterations  = 0
every tick scope  = undefined
```

It proved *"fan-out → handoff"*, never *"REAL SCOPED DRAIN → scope expires → handoff"*. A bug that
persisted the fan-out scope into the continuation dispatch therefore still passed.

## The strong fixture

`PARALLEL_READ width 3 / cap 1`, so the surplus **must** be drained by scoped ticks. The observed
tick-scope trace, recorded by wrapping the **existing** `TaskScheduler.prototype.tick` for the
duration of one round (restored in a `finally`; **no production field added** — no `lastScope`, no
`scopeHistory`, no `drainTrace`):

```text
#1 = undefined            the decision-cycle dispatch: m0 runs
#2 = {m1, m2}             drain iteration 1
#3 = {m2}                 drain iteration 2  (the scope SHRANK)
#4 = undefined            the handoff continuation: NO scope inherited
```

That is exactly the required `undefined → {B,C} → {C} → undefined` sequence.

## Assertions (T3B1A-8)

| | assertion |
|---|---|
| A | topology really was `PARALLEL_READ`, requested = 3 |
| B | width (3) exceeded capacity (1); drain ran ≥ 2 iterations |
| C | real scoped drain ticks happened (non-undefined, non-empty) |
| §4 | the scope strictly shrank `2 → 1`; the first tick is unscoped |
| D | the handoff target really is a requested fan-out member |
| E | its initial execution resolved (a real first Attempt exists) |
| F | once resolved, it is absent from every later fan-out scope |
| G | the continuation used the **same taskId** — not a sibling or replacement |
| H | the continuation really executed (its own Attempt, real execution path) |
| I | AttemptStore holds **two distinct execution Attempts** for that taskId |
| §8 | the second execution ran on a different Agent, with its own Session |
| J | **every tick after the last scoped drain tick is unscoped**, and the final tick is unscoped |
| §17 | a member resolved in the fan-out phase was excluded from further fan-out drain, **yet the later continuation phase executed that same task again** |

The continuation goes through the real `runHandoffContinuation` seam — not a direct
`scheduler.tick` / `orchestrator.execute` / `runtime.run`. The handoff trigger is the existing,
frozen `agent_unavailable`, not a new reason. No generation key was introduced: `taskId` plus the
phase-local scope is sufficient, and that is what the test demonstrates.

## Mutation proof

Simulating the exact bug Codex describes — *remember the last fan-out scope and reuse it for a later
no-scope dispatch* — makes the regression fail:

```text
FAIL T3B1A-8/J: every tick after the last scoped drain tick is UNSCOPED
                 :: scopes=#1=undefined #2={fr2,fr3} #3={fr3} …
FAIL T3B1A-8/J: and the final tick (the continuation) is unscoped
FAIL T3B1A-8/I: AttemptStore holds TWO distinct execution Attempts  :: only one per task
FAIL T3B1A-8/§17: the phase-local scope contract is broken
```

**4 assertions catch it, and the leaked scope is visible directly in the recorded trace.** The
mutation was applied temporarily and reverted; `src/**` is byte-identical afterwards.

A detail worth recording: the two `J` assertions were originally placed *inside* the
handoff-target block, which meant that under the mutation — where no target `T` is ever found —
they silently skipped themselves and only 2 assertions fired. They now assert on the trace alone,
outside that block, because the phase boundary is a property of the *phases* and must be checked
even when the continuation itself fails.




```text
T3-M0 compatibility : allowlist is a taskId list - no agentId / modelId / route reference, so the
                      algorithm is unchanged when ExecutionCandidate(agent, model, route) arrives
no new authority     : the set is a derived round-local cache; it decides nothing
TaskStore clean      : no forged status transitions; a refusal still leaves status untouched (§8B)
capacity honest      : actual simultaneous workers <= maxConcurrent; requested width is a queue,
                      not a concurrency claim; --max-concurrent stays 2
parallel WRITE       : CLOSED - Windows process containment unresolved; nothing here touches WRITE
inner-node fan-out   : deferred - depth 1 only
SOLO                 : with no FanoutProvenance there is no allowlist, so the call is unchanged
same-Agent READ      : no per-agent limit added; capacity remains one global tree-wide number
```
