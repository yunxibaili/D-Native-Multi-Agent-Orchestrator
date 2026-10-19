/**
 * tests/helpers/p01-binding.ts — the ONE way a LOWER test caller completes a governed
 * coding task under P0-1.
 *
 * ============================================================================
 * WHAT THIS IS (and why it exists)
 * ============================================================================
 * P0-1 requires a governed coding task's completion to be correlated to the ACTUAL
 * attempt its accepted execution produced. The production path does that inside the
 * Workbench (`dispatch` -> `recordExecutions` -> `recordAttemptBinding`). A lower test
 * caller that drives the real `Orchestrator.executeTask`/`TaskScheduler.tick` directly
 * (no Workbench) must reach the SAME existing authorities, not mint trust from
 * `applyRunResult` or a caller-supplied label.
 *
 * This helper is that wiring, and NOTHING more: it attaches the EXISTING `AttemptStore`,
 * records the executions the tick really performed through the EXISTING
 * `recordExecutions`, and binds each append-site `{attemptId, run}` pair through the
 * EXISTING `Orchestrator.recordAttemptBinding`. It adds no rule, no store and no state:
 * the orchestrator, the store and the attempt correlation stay the sole authorities.
 */

import type { Orchestrator } from '../../src/orchestration/orchestrator.ts';
import type { AttemptStore } from '../../src/orchestration/attempt-store.ts';
import type { TickResult } from '../../src/orchestration/scheduler.ts';
import { recordExecutions } from '../../src/orchestration/attempt-integration.ts';
import type { TaskType } from '../../src/quota/types.ts';

export interface P01Identity {
  readonly agentId: string;
  readonly modelId: string | null;
  readonly budgetUnits?: number;
  readonly taskType?: TaskType;
}

/**
 * Record + bind every real execution in `tick`, exactly as the Workbench does. `resolve`
 * must return the task's identity, or null when the task cannot be attributed (then it is
 * reported as not recorded, never filed under a guessed task).
 */
export function recordAndBindTick(
  orch: Orchestrator,
  evidence: AttemptStore,
  tick: TickResult,
  resolve: (taskId: string) => P01Identity | null,
): void {
  // READ-ONLY correlation authority: first attach wins, and this only makes the
  // orchestrator able to RE-READ the actual record at the completion commit point.
  orch.attachAttemptStore(evidence);
  const recorded = recordExecutions(evidence, tick, resolve);
  for (const [taskId, refs] of Object.entries(recorded.executionsByTask)) {
    for (const ref of refs) {
      // The session is deliberately null: these lower callers dispatch with no
      // `resolveSessionForDispatch`, so the proof is sessionless and the record must be
      // sessionless too (the gate compares the two).
      orch.recordAttemptBinding(taskId, { attemptId: ref.attemptId, sessionId: null, run: ref.run });
    }
  }
}

/**
 * Record + bind ONE accepted `executeTask` outcome, by folding it into the single
 * `recordAndBindTick` path (so there is still exactly one wiring).
 */
export function recordAndBindOutcome(
  orch: Orchestrator,
  evidence: AttemptStore,
  taskId: string,
  outcome: { readonly ok: boolean; readonly run?: unknown },
  resolve: (taskId: string) => P01Identity | null,
): void {
  if (!outcome.ok || outcome.run === undefined) return;
  const tick = {
    admitted: [taskId],
    waiting: [],
    skipped: [],
    freeSlots: 1,
    outcomes: [{ taskId, outcome }],
  } as unknown as TickResult;
  recordAndBindTick(orch, evidence, tick, resolve);
}
