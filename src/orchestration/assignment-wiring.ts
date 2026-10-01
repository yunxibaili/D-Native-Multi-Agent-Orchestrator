/**
 * src/orchestration/assignment-wiring.ts — P6-B: the only place assignment is applied.
 *
 * TWO JOINS, BOTH DELIBERATE
 * --------------------------
 * 1. `applyAssignment`  — writes the chosen identity back through
 *    `TaskStore.assignIdentity`, and NOTHING else. No transition, no queue, no
 *    tick, no runtime. After this returns the task is still `planned`, and the
 *    existing `TaskScheduler.tick()` is still the only thing that starts it.
 *
 * 2. `recordDispatchedExecutions` — the minimal P6-E wiring. It records evidence
 *    for executions a COMPLETED tick already performed, and it is best-effort: a
 *    failed record is returned, never thrown, so a broken ledger can never stop
 *    real work from having happened.
 *
 * WHY THE WIRING LIVES HERE AND NOT IN `executeTask`
 * --------------------------------------------------
 * The execution edge is `Orchestrator.executeTask`, and it should stay about
 * running work. Putting evidence writing inside it would make the runtime carry a
 * concern that has nothing to do with running a process, and the next person to
 * touch the execution path would have to preserve it. A caller that already holds
 * a `TickResult` and a `TaskStore` — which is exactly the caller of `tick()` — is
 * the natural place, and nothing has to be threaded into the runtime at all.
 */

import { assignWorker, type AssignmentInput, type AssignmentOutcome } from './assignment.ts';
import { recordExecutions, recordExecution, type ExecutionEvidenceInput } from './attempt-integration.ts';
import type { AttemptStore } from './attempt-store.ts';
import type { AttemptRecord } from './attempt-record.ts';
import type { RunResult } from '../core/types.ts';
import type { TaskStore } from './store.ts';
import type { Task } from './task.ts';
import type { TickResult } from './scheduler.ts';

export type AssignmentApplied =
  | { readonly ok: true; readonly outcome: AssignmentOutcome; readonly task: Task }
  | {
      readonly ok: false;
      /** The assignment's own refusal code, passed through verbatim. */
      readonly code: string;
      readonly reason: string;
      /** Nothing was written. The task still holds whatever identity it had. */
    };

/**
 * Choose a worker and write back only the identity.
 *
 * The two steps are deliberately in one call so a caller cannot choose a worker
 * and forget to write it, or write one the engine did not pick. There is no path
 * here that writes an identity without an `AssignmentOutcome` justifying it.
 *
 * `modelId` is NOT taken from the caller. It comes from the chosen candidate, which
 * came from the registry — so the identity written back is always canonical and
 * always one the registry actually knows, never a string a caller invented.
 */
export function applyAssignment(
  store: TaskStore,
  input: AssignmentInput,
): AssignmentApplied {
  const outcome = assignWorker(input);
  if (!outcome.ok) {
    return { ok: false, code: outcome.code, reason: outcome.reason };
  }

  const { agentId, modelId } = outcome.chosen.candidate;
  const written = store.assignIdentity(input.taskId, agentId, modelId);
  if (!written.ok || written.task === null) {
    // A refusal here is the REASSIGNMENT BOUNDARY: the task had already started.
    // The chosen identity is deliberately discarded rather than stashed — P6-D1
    // owns what happens to a task that needs a different worker mid-flight.
    return {
      ok: false,
      code: written.code ?? 'assignment-invalid',
      reason: written.reason ?? 'the chosen identity could not be written back',
    };
  }
  return { ok: true, outcome, task: written.task };
}

// ---------------------------------------------------------------------------
// P6-E wiring: best-effort evidence, never a blocker
// ---------------------------------------------------------------------------

/** Read a task's identity from the store, or null when it does not exist. */
function identityOf(store: TaskStore, taskId: string): ExecutionEvidenceInput & { agentId: string; modelId: string | null } | null {
  const t = store.get(taskId);
  if (t === null) return null;
  return { agentId: t.agentId, modelId: t.modelId, budgetUnits: t.budgetUnits, taskType: t.taskType };
}

export interface DispatchEvidenceResult {
  readonly recorded: string[];
  /** Dispatches that produced no record — refusals, and storage failures. */
  readonly notRecorded: string[];
  /** True when at least one dispatch ran but its evidence could not be stored. */
  readonly evidenceDegraded: boolean;
}

/**
 * Record evidence for the executions a completed tick already performed.
 *
 * BEST-EFFORT BY CONSTRUCTION. `recordExecutions` never throws, and nothing here
 * rethrows either. An agent really did run; a failure to write that down is a
 * degraded ledger, not a reason to pretend the run did not happen — which is why
 * `evidenceDegraded` is reported instead of swallowed.
 *
 * `resolveIdentity` defaults to reading `Task.agentId` / `Task.modelId` from the
 * store, which is the canonical source P6-E's review asked for: a caller may not
 * pass a model id of its own choosing.
 */
export function recordDispatchedExecutions(
  evidence: AttemptStore,
  store: TaskStore,
  tick: TickResult,
  resolveIdentity?: (taskId: string) => { agentId: string; modelId: string | null } | null,
): DispatchEvidenceResult {
  const resolve = resolveIdentity ?? ((taskId: string) => identityOf(store, taskId));
  try {
    const r = recordExecutions(evidence, tick, (taskId) => resolve(taskId));
    // Anything admitted but unrecorded is a storage/validation failure, because a
    // refused dispatch is already reported separately by `recordExecutions`.
    const admittedButMissing = r.notRecorded.filter((id) => tick.admitted.includes(id));
    return {
      recorded: [...r.recorded],
      notRecorded: [...r.notRecorded],
      evidenceDegraded: admittedButMissing.length > 0,
    };
  } catch {
    return { recorded: [], notRecorded: tick.admitted, evidenceDegraded: tick.admitted.length > 0 };
  }
}

/** Record one execution's evidence, e.g. for a rework re-entry. */
export function recordReworkExecution(
  evidence: AttemptStore,
  store: TaskStore,
  input: { taskId: string; run: RunResult },
): AttemptRecord | null {
  const identity = identityOf(store, input.taskId);
  if (identity === null) return null;
  try {
    return recordExecution(evidence, {
      taskId: input.taskId,
      agentId: identity.agentId,
      modelId: identity.modelId,
      result: input.run,
      budgetUnits: identity.budgetUnits,
      taskType: identity.taskType,
      // The caller already knows this came from `prepareRework`; inferring it from
      // `retryCount` would create a second, worse source for the same fact.
      isRework: true,
    });
  } catch {
    return null;
  }
}
