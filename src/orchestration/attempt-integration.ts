/**
 * src/orchestration/attempt-integration.ts - P6-E: where evidence is actually produced.
 *
 * This module is the ONLY place that writes an `AttemptRecord`, and it exists so
 * the write can happen at the right moments without touching the orchestrator's
 * control flow.
 *
 * IT DOES NOT CALL ANYTHING. It has no store, no scheduler, no runtime, no
 * orchestrator - only the `AttemptStore` it is handed and the pure inputs it is
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
 * the run result. Patching that path would mean the orchestrator - the execution
 * edge - growing an evidence concern, which is how one authority becomes two.
 * `recordExecutions` is called by whoever already holds both objects.
 *
 * WHICH OUTCOMES ARE RECORDED
 * ----------------------------
 * `recordExecutions` records a real execution whenever a real `RunResult` EXISTS - which
 * is a wider set than "the outcome reported success". Concretely:
 *
 *   - `outcome.ok === true`                       -> recorded (the ordinary case)
 *   - `outcome.ok === false` AND it carries `run`  -> ALSO recorded (R2-2 / F5)
 *   - `outcome.ok === false` AND no `run`         -> NOT recorded
 *
 * The middle case is the one this comment used to deny. A `RunResult` means a native
 * process really executed and produced it; when only the WORKFLOW write-back was refused
 * (stale lease, agent mismatch), that execution still happened and discarding it would
 * erase real evidence. `Task mutation rejected != Execution evidence discarded`.
 *
 * The last case is "nothing ran" - the gate refused, or the runtime never started - and
 * it genuinely has no evidence. `notRecorded` is returned so the caller can see that the
 * absence was deliberate rather than an oversight.
 */

import { executionAttempt, reworkAttempt, reviewAttempt, type AttemptRecord } from './attempt-record.ts';
import type { AttemptStore } from './attempt-store.ts';
import type { TickResult } from './scheduler.ts';
import type { ReviewVerdict } from './review-verdict.ts';
import type { TaskType } from '../quota/types.ts';
import type { RunResult } from '../core/types.ts';
import type { DispatchExecutionRef } from './dispatch-receipt.ts';

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
 * an evidence loss and is visible to the caller - deliberately not swallowed,
 * because silent evidence loss looks identical to "nothing happened".
 */
export function recordExecution(
  store: AttemptStore,
  input: {
    taskId: string;
    agentId: string;
    modelId: string | null;
    result: Parameters<typeof executionAttempt>[0]['result'];
    /**
     * R2-2: the lease version the execution ran under, from the DISPATCH-time lease.
     * Omitted for evidence that is not an execution under a lease (a review), never
     * defaulted to the task's current version.
     */
    leaseVersion?: number;
    /**
     * T1-b: the session this execution ran in, from the session authority. Optional and
     * additive: without it the attempt is still a complete record, it just cannot be
     * projected back to the Worker that produced it.
     */
    sessionId?: string;
  } & ExecutionEvidenceInput,
): AttemptRecord | null {
  const build = input.isRework === true ? reworkAttempt : executionAttempt;
  const outcome = store.append(build({
    taskId: input.taskId,
    agentId: input.agentId,
    modelId: input.modelId,
    ...(input.budgetUnits === undefined ? {} : { budgetUnits: input.budgetUnits }),
    ...(input.taskType === undefined ? {} : { taskType: input.taskType }),
    ...(input.leaseVersion === undefined ? {} : { leaseVersion: input.leaseVersion }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    result: input.result,
  }));
  return outcome.ok ? outcome.record : null;
}

/**
 * Record the executions a completed tick really performed.
 *
 * An entry is recorded whenever it carries a real `RunResult`, INCLUDING when the
 * workflow write-back was refused - see the header note on which outcomes are recorded.
 * What is never recorded is an admission that produced no execution at all, because a
 * `RunResult` cannot be fabricated for it: a scheduler that skipped a task produces no
 * `RunResult`, so there is no signature here that could invent one.
 */
export function recordExecutions(
  store: AttemptStore,
  tick: TickResult,
  resolve: (taskId: string) => { agentId: string; modelId: string | null; budgetUnits?: number; taskType?: TaskType } | null,
  /**
   * T1-b: optional. Lets the caller supply the session each task's execution ran in, so
   * the resulting attempts can be projected back to a Worker. Returning null/undefined
   * simply leaves `sessionId` absent on the record — the attempt is still complete
   * evidence, so this is additive and never a reason to skip recording.
   */
  resolveSession?: (taskId: string) => { sessionId: string } | null,
): {
  recorded: string[];
  notRecorded: string[];
  attemptIdsByTask: Record<string, string[]>;
  /**
   * T3-a.5: the CURRENT execution's `{attemptId, run}` pair, per task, bound AT THE APPEND
   * SITE — the one instant where the id `AttemptStore.append` actually minted and the exact
   * `RunResult` that was used to build that record are both in hand.
   *
   * WHY THIS EXISTS
   * A `taskId` can own Attempt A, B and C. So `taskId -> RunResult` (a per-task latest-ever
   * map such as `Workbench.lastRunResult`) CANNOT prove "the current Attempt's result": it can
   * hand back Attempt A's result while the current Attempt is B. Worse, `RunResult` cannot
   * carry its own `attemptId` — the runtime freezes it (`runtime/session.ts#finalize`) BEFORE
   * `AttemptStore` mints any id, and its `taskId`/`threadId` are the runtime's own handles, not
   * ours. So the binding has to be made here, by the caller that owns both objects, and the
   * pair travels as ONE value.
   *
   * This is a CORRELATION, not a new authority: it decides nothing and is not consulted to
   * answer any question `AttemptStore` already answers. `AttemptStore` remains the
   * execution-identity authority; `RecordAttempt` remains the sole writer of attempt evidence.
   *
   * NOT POSITIONAL. The `run` is stored inside the entry that carries its own `attemptId`, so
   * the two cannot drift apart, and each entry is appended in the same breath as the matching
   * `attemptIdsByTask` push (see `noteAttempt`), so the arrays stay index-aligned by
   * construction rather than by a later zip.
   */
  executionsByTask: Record<string, DispatchExecutionRef[]>;
} {
  const recorded: string[] = [];
  const notRecorded: string[] = [];
  const sessionOf = (taskId: string): { sessionId?: string } => {
    if (resolveSession === undefined) return {};
    const s = resolveSession(taskId);
    return s === null || s === undefined ? {} : { sessionId: s.sessionId };
  };
  // R2-2 §13.2: the ids `AttemptStore.append` ACTUALLY minted, so a dispatch receipt can
  // point at real attempts instead of the caller guessing or re-reading history. Taken
  // from the returned record, never predicted.
  const attemptIdsByTask: Record<string, string[]> = {};
  // T3-a.5: the correlated result, bound here where both objects exist (see the field doc).
  const executionsByTask: Record<string, DispatchExecutionRef[]> = {};
  const noteAttempt = (taskId: string, record: { readonly attemptId: string }, run: RunResult): void => {
    (attemptIdsByTask[taskId] ??= []).push(record.attemptId);
    // `run` MUST be the very object handed to `recordExecution`, which is the run that
    // produced THIS record — not a re-read by task id, which could be an older attempt.
    (executionsByTask[taskId] ??= []).push(Object.freeze({ attemptId: record.attemptId, run }));
  };

  for (const entry of tick.outcomes) {
    if (!entry.outcome.ok) {
      // R2-2 / F5. Two DIFFERENT situations used to collapse into one line here, and
      // the comment "No real run happened" was true of only one of them:
      //
      //   - the outcome carries NO run  -> nothing executed (gate refused, or the
      //     runtime never started). There is genuinely no evidence to record.
      //   - the outcome carries a run  -> a native process DID execute and produced
      //     it; only the WORKFLOW write-back was refused (stale lease / agent
      //     mismatch). That is an execution fact and it is recorded, so the work is
      //     not erased by a state decision.
      //
      // Task state is still untouched either way: this records EVIDENCE, it does not
      // move a task.
      const refusedRun = entry.outcome.run;
      if (refusedRun === undefined) {
        notRecorded.push(entry.taskId);
        continue;
      }
      const refusedMeta = resolve(entry.taskId);
      if (refusedMeta === null) {
        // The task cannot be attributed (it was never created, or was deleted), so the
        // run has no owner to be evidence ABOUT. It is reported as NOT recorded rather
        // than filed under a guessed task: a record pointing at the wrong task is worse
        // than a visible gap, because the gap is honest and the wrong record is not.
        notRecorded.push(entry.taskId);
        continue;
      }
      const refusedRecord = recordExecution(store, {
        taskId: entry.taskId,
        // The AGENT THAT ACTUALLY RAN, not the task's current holder - that
        // difference is the entire content of a stale record.
        agentId: refusedRun.agentId,
        modelId: refusedMeta.modelId,
        result: refusedRun,
        // The version this run ACTUALLY held, which by definition is no longer current.
        // Rewriting it to the task's present version would make superseded work look
        // like the current holder's.
        ...(entry.outcome.leaseVersion === undefined ? {} : { leaseVersion: entry.outcome.leaseVersion }),
        ...(refusedMeta.budgetUnits === undefined ? {} : { budgetUnits: refusedMeta.budgetUnits }),
        ...(refusedMeta.taskType === undefined ? {} : { taskType: refusedMeta.taskType }),
        ...sessionOf(entry.taskId),
        isRework: false,
      });
      if (refusedRecord === null) notRecorded.push(entry.taskId);
      else {
        recorded.push(entry.taskId);
        // R2-2 / F1: the refused execution's attempt id MUST reach `attemptIdsByTask`.
        // This branch used to record the evidence and then drop its pointer, so the
        // receipt could not name the attempt that actually ran - the one case where
        // naming it matters most, because the write-back was refused and the receipt is
        // the only remaining link between the decision and the execution.
        noteAttempt(entry.taskId, refusedRecord, refusedRun);
      }
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
      ...(entry.outcome.leaseVersion === undefined ? {} : { leaseVersion: entry.outcome.leaseVersion }),
      ...(meta.budgetUnits === undefined ? {} : { budgetUnits: meta.budgetUnits }),
      ...(meta.taskType === undefined ? {} : { taskType: meta.taskType }),
      ...sessionOf(entry.taskId),
      // `ExecuteOutcome` does not say whether it was a rework re-entry, so this
      // is left to the caller; defaulting it to false keeps ordinary executions
      // ordinary.
      isRework: false,
    });
    if (record === null) notRecorded.push(entry.taskId);
    else {
      recorded.push(entry.taskId);
      noteAttempt(entry.taskId, record, entry.outcome.run);
    }
  }

  return { recorded, notRecorded, attemptIdsByTask, executionsByTask };
}

/**
 * Record a review that actually happened.
 *
 * The verdict is D0's contract and is not reinterpreted here - this function
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
 * authorised" attempt that never ran - which is not an attempt. D0's review record
 * already carries the `rework` verdict, and the re-run produces its own `kind:
 * 'rework'` execution record once a real `RunResult` exists. Authorisation is
 * therefore represented by exactly two facts, both already recorded: the reviewer
 * asked, and the agent re-ran.
 *
 * A caller tracking loop position reads `Task.retryCount`, which is D0's own
 * counter. Copying it into evidence would create the second authority P6 §7
 * forbids.
 */
