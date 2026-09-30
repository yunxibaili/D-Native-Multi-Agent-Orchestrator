/**
 * src/orchestration/attempt-integration.ts — P6-E: where evidence is actually produced.
 *
 * This module is the ONLY place that writes an `AttemptRecord`, and it exists so
 * the write can happen at the right moments without touching the orchestrator's
 * control flow.
 *
 * IT DOES NOT CALL ANYTHING. It has no store, no scheduler, no runtime, no
 * orchestrator — only the `AttemptStore` it is handed and the pure inputs it is
 * given. Recording is a side effect performed BY the caller at a point the caller
 * already owns:
 *
 *   - after `TaskScheduler.tick()` returns, for each admitted task's real result
 *   - after D0's `applyReviewVerdict()`, for the review that occurred
 *   - after `prepareRework()`, for the rework that was authorised
 *
 * Nothing here is invoked automatically. If a future stage wires recording into
 * the orchestrator, that stage owns the decision and this module stays the single
 * definition of what a record means.
 *
 * WHY NOT HOOK `executeTask` DIRECTLY
 * ----------------------------------
 * Because the only honest evidence for an execution is the `RunResult` the runtime
 * actually produced, and the orchestrator already has it at the point it applies
 * the run result. Patching that path would mean the orchestrator — the execution
 * edge — growing an evidence concern, which is how one authority becomes two.
 * `recordExecutions` is called by whoever already holds both objects.
 *
 * NO FABRICATED ATTEMPTS
 * ----------------------
 * `recordExecutions` is given a `TickResult`. It records ONLY outcomes whose `ok`
 * is true, because those are the ones with a real `RunResult`. A task the
 * scheduler refused, skipped, or left waiting has no result and therefore no
 * evidence — and `recordExecutions` returns the ids it did NOT record so a caller
 * can see that the absence was deliberate rather than an oversight.
 */

import { executionAttempt, reworkAttempt, reviewAttempt, type AttemptRecord } from './attempt-record.ts';
import type { AttemptStore } from './attempt-store.ts';
import type { TickResult } from './scheduler.ts';
import type { ReviewVerdict } from './review-verdict.ts';
import type { TaskType } from '../quota/types.ts';

export interface ExecutionEvidenceInput {
  /** Budget as the task declared it, so cost-per-budget is computable later. */
  readonly budgetUnits?: number;
  readonly taskType?: TaskType;
  /**
   * True when this run is a D0 rework re-entry rather than a first attempt.
   *
   * Derived from the AUTHORITY's own knowledge (the caller knows it called
   * `prepareRework`), not guessed from a counter. Inferring it from
   * `retryCount > 0` would be a second, worse source of truth for the same fact.
   */
  readonly isRework?: boolean;
}

/**
 * Record one real execution result.
 *
 * Returns the stored record, or null when validation refused it. A null here is
 * an evidence loss and is visible to the caller — deliberately not swallowed,
 * because silent evidence loss looks identical to "nothing happened".
 */
export function recordExecution(
  store: AttemptStore,
  input: {
    taskId: string;
    agentId: string;
    modelId: string | null;
    result: Parameters<typeof executionAttempt>[0]['result'];
  } & ExecutionEvidenceInput,
): AttemptRecord | null {
  const build = input.isRework === true ? reworkAttempt : executionAttempt;
  const outcome = store.append(build({
    taskId: input.taskId,
    agentId: input.agentId,
    modelId: input.modelId,
    ...(input.budgetUnits === undefined ? {} : { budgetUnits: input.budgetUnits }),
    ...(input.taskType === undefined ? {} : { taskType: input.taskType }),
    result: input.result,
  }));
  return outcome.ok ? outcome.record : null;
}

/**
 * Record the executions a completed tick really performed.
 *
 * Only `outcome.ok === true` entries are recorded. That is the whole guarantee:
 * a denied dispatch has no `RunResult`, so there is nothing to describe, and
 * inventing a `failure` record for "the gate said no" would corrupt every
 * success-rate figure P6-B later depends on.
 */
export function recordExecutions(
  store: AttemptStore,
  tick: TickResult,
  resolve: (taskId: string) => { agentId: string; modelId: string | null; budgetUnits?: number; taskType?: TaskType } | null,
): { recorded: string[]; notRecorded: string[] } {
  const recorded: string[] = [];
  const notRecorded: string[] = [];

  for (const entry of tick.outcomes) {
    if (!entry.outcome.ok) {
      // Refused or failed to start. No real run happened.
      notRecorded.push(entry.taskId);
      continue;
    }
    const meta = resolve(entry.taskId);
    if (meta === null) {
      notRecorded.push(entry.taskId);
      continue;
    }
    const record = recordExecution(store, {
      taskId: entry.taskId,
      agentId: meta.agentId,
      modelId: meta.modelId,
      result: entry.outcome.run,
      ...(meta.budgetUnits === undefined ? {} : { budgetUnits: meta.budgetUnits }),
      ...(meta.taskType === undefined ? {} : { taskType: meta.taskType }),
      // `ExecuteOutcome` does not say whether it was a rework re-entry, so this
      // is left to the caller; defaulting it to false keeps ordinary executions
      // ordinary.
      isRework: false,
    });
    if (record === null) notRecorded.push(entry.taskId);
    else recorded.push(entry.taskId);
  }

  return { recorded, notRecorded };
}

/**
 * Record a review that actually happened.
 *
 * The verdict is D0's contract and is not reinterpreted here — this function
 * reduces it to comparable counts and nothing else. Note that it records the
 * REVIEWER's id, so review quality and worker quality never mix.
 */
export function recordReview(
  store: AttemptStore,
  input: {
    taskId: string;
    reviewer: string;
    verdict: ReviewVerdict;
    reviewerModelId?: string | null;
    taskType?: TaskType;
  },
): AttemptRecord | null {
  const outcome = store.append(reviewAttempt({
    taskId: input.taskId,
    reviewer: input.reviewer,
    ...(input.reviewerModelId === undefined ? {} : { reviewerModelId: input.reviewerModelId }),
    ...(input.taskType === undefined ? {} : { taskType: input.taskType }),
    verdict: input.verdict,
  }));
  return outcome.ok ? outcome.record : null;
}

/**
 * There is deliberately no `recordReworkAuthorisation`.
 *
 * An earlier draft had one, and it was wrong twice over: it invented a
 * `metadata` field the contract does not have, and it recorded a "rework was
 * authorised" attempt that never ran — which is not an attempt. D0's review record
 * already carries the `rework` verdict, and the re-run produces its own `kind:
 * 'rework'` execution record once a real `RunResult` exists. Authorisation is
 * therefore represented by exactly two facts, both already recorded: the reviewer
 * asked, and the agent re-ran.
 *
 * A caller tracking loop position reads `Task.retryCount`, which is D0's own
 * counter. Copying it into evidence would create the second authority P6 §7
 * forbids.
 */
