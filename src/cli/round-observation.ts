// ===========================================================================
// TeamRun T2-a.3 — the read-only Workbench OBSERVATION projection.
// ===========================================================================
//
// T2-a.2 added a test seam that handed the callback the real `NativeWorkbench`:
//     onWorkbench?: (wb: NativeWorkbench) => void
// That is not an observation seam. It is a CONTROL seam wearing an observation
// costume: through `wb` a test could call `assignChildren`, `reassignTask`,
// `store.assignIdentity`, `sessions.open` or `spawnChild`, and thereby change the
// Agent x Model pair the round actually dispatched on. "The tests only read it" is
// not a boundary — it is a habit.
//
// This module is the boundary. `observeRoundWorkbench` is a PURE PROJECTION that reads
// the authoritative state and returns NEW, FROZEN, PLAIN values. The observer therefore
// never receives `NativeWorkbench`, `TaskStore`, `SessionRegistry`, `Assignment`,
// `DecisionProvider`, a scheduler or a runtime, so there is nothing on it to call.
//
// Why a snapshot and not `Readonly<NativeWorkbench>`:
// `Readonly<T>` is shallow. It forbids replacing a top-level property and does nothing
// about `wb.store.assignIdentity(...)`, `wb.sessions.open(...)` or `wb.assignChildren(...)`,
// which are all methods that still exist and still work. A frozen DETACHED copy removes
// the capability instead of the permission.
//
// Why not `as const` around the real object: same reason. Freezing the workbench would
// break the round it is supposed to observe, and would still expose every method.
//
// §5: every field below is a primitive copied out of the authority. No internal record
// reference is ever placed in the result, so a later mutation of the real store cannot
// reach back into a snapshot a test is still holding.
// ===========================================================================

import type { NativeWorkbench } from '../orchestration/workbench.ts';
import type { TaskStatus } from '../orchestration/task.ts';
import type { AttemptKind } from '../orchestration/attempt-record.ts';

/** One task's authoritative identity, as a plain detached value. */
export interface ObservedTask {
  readonly taskId: string;
  readonly parentTaskId: string | null;
  readonly status: TaskStatus;
  readonly agentId: string;
  readonly modelId: string | null;
}

/** One session's authoritative binding, as a plain detached value. */
export interface ObservedSession {
  readonly sessionId: string;
  readonly taskId: string | null;
  readonly agentId: string;
  readonly modelId: string | null;
  readonly status: 'open' | 'running' | 'closed';
}

/**
 * Laya's recorded initial choice.
 *
 * `agentId`/`modelId` are null when the selection did not succeed, so a failed round is
 * representable without inventing a pair. Note this is Laya's PROVENANCE only — it is
 * evidence of what was decided, never a way to decide: there is no setter, no command
 * and no handle that could feed it back into Assignment.
 */
export interface ObservedInitialSelection {
  readonly taskId: string;
  readonly ok: boolean;
  readonly agentId: string | null;
  readonly modelId: string | null;
}

/**
 * One attempt's recorded identity.
 *
 * This is exactly the field set of `WorkerIdentity`, so a test can prove that a Worker
 * would project coherently — using the existing `workerIdentityOfAttempt` — without this
 * module inventing a Worker concept of its own (§24: the observation seam is not a Worker
 * runtime, and must not grow into one).
 */
export interface ObservedAttempt {
  readonly attemptId: string;
  readonly taskId: string;
  readonly kind: AttemptKind;
  readonly agentId: string;
  readonly modelId: string | null;
  readonly sessionId: string | null;
}

/**
 * Everything an observer may see about a round's workbench.
 *
 * Deliberately only what the T2-a.2/T2-a.3 regressions actually assert: the authoritative
 * task pair, the session->task binding, Laya's provenance, and the attempt identity. Not a
 * general inspector — §4 asked for the minimum, and a wide surface is a wide risk.
 */
export interface RoundWorkbenchObservation {
  readonly tasks: readonly ObservedTask[];
  readonly sessions: readonly ObservedSession[];
  readonly initialSelections: readonly ObservedInitialSelection[];
  readonly attempts: readonly ObservedAttempt[];
}

/**
 * Project the authoritative workbench state into a frozen, detached snapshot.
 *
 * Reads ONLY through documented read APIs (`store.all`, `sessions.all`,
 * `initialSelectionRecords`, `evidence.all`) and copies every value it keeps, so the
 * result is a point-in-time fact record. It holds no store reference, registers no
 * commands, and exposes no write-through method: new authority = 0.
 *
 * Object.freeze is defence in depth, not the boundary. The boundary is that no authority
 * object is reachable from the result at all — a test can freely mutate its own copy, and
 * that copy is simply not the production state.
 */
export function observeRoundWorkbench(wb: NativeWorkbench): RoundWorkbenchObservation {
  const tasks = wb.store.all().map((t) => Object.freeze({
    taskId: t.taskId,
    parentTaskId: t.parentTaskId,
    status: t.status,
    agentId: t.agentId,
    modelId: t.modelId,
  } satisfies ObservedTask));

  const sessions = wb.sessions.all().map((s) => Object.freeze({
    sessionId: s.sessionId,
    taskId: s.taskId,
    agentId: s.agentId,
    modelId: s.modelId,
    status: s.status,
  } satisfies ObservedSession));

  const initialSelections = wb.initialSelectionRecords().map((r) => Object.freeze({
    taskId: r.taskId,
    ok: r.ok,
    agentId: r.ok ? r.intent.agentId : null,
    modelId: r.ok ? r.intent.modelId : null,
  } satisfies ObservedInitialSelection));

  const attempts = wb.evidence.all().map((a) => Object.freeze({
    attemptId: a.attemptId,
    taskId: a.taskId,
    kind: a.kind,
    agentId: a.agentId,
    modelId: a.modelId,
    sessionId: a.sessionId ?? null,
  } satisfies ObservedAttempt));

  return Object.freeze({
    tasks: Object.freeze(tasks),
    sessions: Object.freeze(sessions),
    initialSelections: Object.freeze(initialSelections),
    attempts: Object.freeze(attempts),
  } satisfies RoundWorkbenchObservation);
}