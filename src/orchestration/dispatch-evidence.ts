// ===========================================================================
// TeamRun T3-a.4 — the CURRENT-dispatch per-task evidence projection.
// ===========================================================================
//
// WHAT THIS IS
// A PURE projection from one dispatch's `DispatchReceipt` facts to a per-task
// `DispatchTaskEvidence`. It is the canonical answer to "what did THIS dispatch resolve for
// this task?", and it is the single thing both the fan-out aggregation and the Unified Review
// packet consume for a member's current execution.
//
// WHAT THIS IS NOT
// Not a store and not an authority. It is a value derived from facts that already exist
// (scheduler outcomes, waiting/skipped, and the AttemptStore ids the dispatch produced), and
// it replaces nothing: AttemptStore is still the execution-evidence authority, TaskStore the
// state authority, SessionRegistry the session authority.
//
// THE CRITICAL RULE (P1-b)
// `admitted` is a CONTROL-PLANE admission fact. It is NOT proof that the runtime ran: a
// write-back refusal is `admitted:false` yet the execution DID happen. The execution proof is
// an ATTEMPT — `attemptIdsByTask` is filled from what `AttemptStore.append` actually minted.
// So an entry with a current attempt is `started` REGARDLESS of `admitted`, and records
// `writeBackAccepted` separately. "It ran and the write-back was refused" and "the runtime
// never started" therefore stay distinguishable.
//
// SUPERSEDING (P1-c)
// A task that appears in `outcomes` (executeTask was called for it) or in `waiting` has a NEW
// dispatch resolution and its entry is returned — the caller overwrites. A `skipped` entry that
// is NOT in `outcomes` (dependency-unmet) is NOT a new execution resolution and is deliberately
// omitted, so it cannot clear a task's current context.
//
// TEAMRUN T3-a.5 — WHY taskId IS NOT ENOUGH FOR THE RESULT
// -------------------------------------------------------
// This projection used to expose only the attempt ids, leaving the caller to find a result by
// task id. That cannot work, and the reason is structural:
//
//     Task T: Attempt A -> Result A
//             Attempt B -> Result B
//
// `taskId -> RunResult` answers "the newest result held for this task", which is a DIFFERENT
// question from "the CURRENT attempt's result". Any per-task latest-ever lookup can therefore
// return Result A while the current attempt is B — and would report a stale success, or worse a
// stale failure, as if it belonged to the attempt being reviewed.
//
// The result cannot be re-identified after the fact either: `RunResult` is frozen by the runtime
// BEFORE `AttemptStore` mints an id, it carries no `attemptId`, and its `taskId`/`threadId` are
// the runtime's own handles rather than ours. So the pair must be born where the two objects meet
// — at the append — and arrive here already matched.
//
// Hence `attemptId` and `run` are read off ONE correlated entry. `attemptId = B` with
// `run = Result A` is not representable, and a started attempt with no result yet yields
// `run: null` rather than falling back to history.

import type { RunResult } from '../core/types.ts';

export type DispatchTaskOutcome = 'started' | 'dispatch-refused' | 'pending';

/** T3-a.5: ONE execution, named by both halves — see the note above. */
export interface DispatchExecutionFact {
  readonly attemptId: string;
  /**
   * The result of THIS attempt, or `null` when it has not been produced yet.
   *
   * `null` is a real, meaningful answer and must never be replaced by an older attempt's
   * result: "attempt B started, no result yet" is a different fact from "attempt B produced
   * Result B".
   */
  readonly run: RunResult | null;
}

export interface DispatchTaskEvidence {
  /** `started` = a current Attempt exists (whatever the control-plane verdict); `dispatch-refused`
   * = the runtime never started; `pending` = ready but not dispatched (e.g. no free slot). */
  readonly outcome: DispatchTaskOutcome;
  readonly attemptIds: readonly string[];
  /**
   * T3-a.5: the CURRENT attempt for this dispatch — the last pair recorded for the task.
   * `null` unless `outcome === 'started'`.
   */
  readonly attemptId: string | null;
  /**
   * T3-a.5: the result correlated to `attemptId`, by construction. `null` when this attempt has
   * no result yet. NEVER a previous attempt's result, and never a task-keyed lookup.
   */
  readonly run: RunResult | null;
  /** Why the dispatch was refused. Present only when `outcome !== 'started'`. */
  readonly refusalCode: string | null;
  readonly refusalReason: string | null;
  /** For a `started` outcome: did the control plane ACCEPT the write-back? False = write-back refused. */
  readonly writeBackAccepted: boolean;
}

export interface DispatchReceiptFacts {
  readonly outcomes: readonly { readonly taskId: string; readonly admitted: boolean }[];
  readonly waiting: readonly string[];
  readonly skipped: readonly { readonly taskId: string; readonly code: string; readonly reason: string }[];
  readonly attemptIdsByTask: Readonly<Record<string, readonly string[]>>;
  /**
   * T3-a.5: taskId -> this dispatch's correlated `{attemptId, run}` pairs.
   *
   * Optional so a caller with no recorded execution can still project; when a task appears in
   * `attemptIdsByTask` but NOT here, its attempt exists and its result is UNKNOWN, which
   * resolves to `run: null` — never to a lookup by task id.
   */
  readonly executionsByTask?: Readonly<Record<string, readonly DispatchExecutionFact[]>>;
}

/**
 * Project one dispatch's facts to per-task current evidence. Pure; the caller decides how to
 * merge these into a round-local map (last dispatch wins per task).
 */
export function projectDispatchTaskEvidence(facts: DispatchReceiptFacts): ReadonlyMap<string, DispatchTaskEvidence> {
  const map = new Map<string, DispatchTaskEvidence>();
  const skipByTask = new Map(facts.skipped.map((s) => [s.taskId, s]));
  for (const entry of facts.outcomes) {
    const ids = [...(facts.attemptIdsByTask[entry.taskId] ?? [])];
    if (ids.length > 0) {
      // An Attempt exists -> the runtime EXECUTED. `admitted` only says whether the control
      // plane accepted the result, which a write-back refusal does not.
      //
      // T3-a.5: identity and result come off the SAME correlated entry, so the pair cannot be
      // mixed. Falling back to the bare id list (when no pair was recorded) still yields
      // `run: null` — an attempt with an unknown result, not an older attempt's result.
      const pairs = facts.executionsByTask?.[entry.taskId] ?? [];
      const pair = pairs.length > 0 ? pairs[pairs.length - 1]! : null;
      map.set(entry.taskId, {
        outcome: 'started',
        attemptIds: ids,
        attemptId: pair?.attemptId ?? ids[ids.length - 1]!,
        run: pair?.run ?? null,
        refusalCode: entry.admitted ? null : (skipByTask.get(entry.taskId)?.code ?? null),
        refusalReason: entry.admitted ? null : (skipByTask.get(entry.taskId)?.reason ?? null),
        writeBackAccepted: entry.admitted,
      });
    } else {
      const sk = skipByTask.get(entry.taskId);
      map.set(entry.taskId, {
        outcome: 'dispatch-refused',
        attemptIds: [],
        attemptId: null,
        run: null,
        refusalCode: sk?.code ?? null,
        refusalReason: sk?.reason ?? null,
        writeBackAccepted: false,
      });
    }
  }
  for (const id of facts.waiting) {
    if (map.has(id)) continue;
    map.set(id, {
      outcome: 'pending',
      attemptIds: [],
      attemptId: null,
      run: null,
      refusalCode: null,
      refusalReason: null,
      writeBackAccepted: false,
    });
  }
  // `skipped` entries are intentionally NOT added here: a skip that is not an outcome is
  // dependency-unmet, which is not a new execution resolution and must not clear a context.
  return map;
}