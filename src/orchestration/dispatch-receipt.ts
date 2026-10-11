/**
 * src/orchestration/dispatch-receipt.ts — R2-2, §5.4 of
 * `docs/DECISION_LOOP_EXECUTION_RESULT_CONTRACT.md`.
 *
 * WHAT THIS IS NOT
 * ----------------
 * A receipt is an ADMISSION fact: which tasks this cycle let through, which were
 * waiting, which were skipped, and which execution attempt each admitted task
 * produced. It is deliberately NOT an execution result and NOT a second result store:
 *
 *   DispatchReceipt  !=  RunResult  !=  AttemptRecord
 *
 * The real execution facts already live in `AttemptStore` (append-only, frozen, with
 * an `attemptId` and a `previousAttemptId` chain). The receipt only POINTS at them.
 * Nothing here is persisted, and nothing here can change a task.
 *
 * WHY IT EXISTS
 * -------------
 * Before this, `DecisionApplicationContext.dispatch` was `() => Promise<boolean>`, and
 * because `runDecisionCycle` spread `capabilities` AFTER its own `dispatch`, the
 * workbench's boolean-returning capability silently overrode the loop's — so the
 * loop's tick capture was dead code. Consumers then had to reach sideways into
 * `wb.evidence.history()` to learn what happened. A receipt carried through the one
 * dispatch path removes both the type drift and the dead path.
 *
 * THE THREE VOCABULARIES STAY SEPARATE (§4.5)
 * -------------------------------------------
 * `terminalState` below is `TerminalState` — the RUN vocabulary
 * (`succeeded`/`failed`/`cancelled`/`timed_out`). It is NOT `TaskStatus`: a run that
 * succeeded puts the task in `to_verify`, and collapsing the two is exactly the
 * distinction this contract exists to protect.
 *
 * TEAMRUN T3-a.5 — WHY A RECEIPT ALSO CARRIES EXECUTIONS
 * ------------------------------------------------------
 * This file used to say "admission facts, never execution facts", and `attemptIdsByTask`
 * was the only link to execution: the receipt pointed at an Attempt and dropped the result.
 * That left the caller with no way to learn WHICH `RunResult` belonged to that attempt, so it
 * reached sideways into a per-task latest-ever map (`Workbench.lastRunResult(taskId)`) to get
 * one back.
 *
 * That lookup cannot be trusted, and the reason is structural, not a bug:
 *
 *   - `taskId` can own Attempt A, then B, then C. `taskId -> RunResult` therefore answers
 *     "the newest result I happen to be holding for this task", which is NOT "the current
 *     attempt's result" — it can return A's result while the current attempt is B.
 *   - `RunResult` cannot close the gap by carrying its own id. It is frozen by the runtime
 *     (`runtime/session.ts#finalize`) BEFORE `AttemptStore` mints any `attemptId`, and its
 *     `taskId`/`threadId` are the runtime's own handles, not ours. There is no field on it
 *     that identifies an attempt.
 *   - `AttemptRecord` stores no `RunResult` and no pointer to one.
 *
 * So the pair has to be born where the two objects actually meet: at the `AttemptStore.append`
 * that mints the id from the very run used to build the record (`attempt-integration.ts`).
 * `executionsByTask` below is that pair, carried on the receipt so "this dispatch's attempt"
 * and "this dispatch's result" arrive already matched. It is a CORRELATION over already-known
 * facts, not a result store and not a second authority: nothing here decides anything, and the
 * identities still live in `AttemptStore`.
 */

import type { RunResult, TerminalState } from '../core/types.ts';
import type { TickResult } from './scheduler.ts';

/**
 * T3-a.5: ONE execution, named by both halves.
 *
 * `attemptId` is the id `AttemptStore.append` actually minted for the record built from
 * `run`. The two are produced together, so this object cannot describe a mixed pair such as
 * "attempt B with attempt A's result".
 */
export interface DispatchExecutionRef {
  readonly attemptId: string;
  readonly run: RunResult;
}

/** One admitted task, distinguishing "allowed in" from "actually finished". */
export interface DispatchOutcomeEntry {
  readonly taskId: string;
  /** `true` = the scheduler admitted it this tick. */
  readonly admitted: boolean;
  /**
   * `true` = a `RunResult` was obtained. `false` = admitted only.
   *
   * `false` is a LEGAL state and must never be read as failure (§5.4 / F8). Today a
   * round is synchronous, so `finished` is settled by the time `dispatch()` returns;
   * the field exists so an async or lease-driven dispatch does not have to change
   * the contract.
   */
  readonly finished: boolean;
  /** Authoritative only when `finished`; absent otherwise. */
  readonly terminalState?: TerminalState;
}

export interface DispatchSkipped {
  readonly taskId: string;
  readonly code: string;
  readonly reason: string;
}

/** The receipt for ONE dispatch. Admission facts, never execution facts. */
export interface DispatchReceipt {
  /** Authoritative: when this receipt was produced. */
  readonly dispatchedAt: number;
  /** Authoritative, from `TickResult.admitted`. */
  readonly admitted: readonly string[];
  /** Ready but no free slot. */
  readonly waiting: readonly string[];
  /** Not eligible at all. */
  readonly skipped: readonly DispatchSkipped[];
  /** `true` = refused by the scheduler's re-entrancy guard, so nothing was admitted. */
  readonly reentrant: boolean;
  /**
   * taskId -> the attempt ids this dispatch produced.
   *
   * Filled from what `AttemptStore.append` actually returned, NOT predicted: the
   * point is to let the Decision Loop say which execution attempt a dispatch
   * corresponds to without holding a `RunResult`.
   */
  readonly attemptIdsByTask: Readonly<Record<string, readonly string[]>>;
  /**
   * T3-a.5: taskId -> this dispatch's `{attemptId, run}` pairs, in attempt order.
   *
   * Index-aligned with `attemptIdsByTask` by construction (they are appended together at the
   * append site), but each entry carries its OWN `attemptId`, so a consumer should read the
   * pair off this field rather than zip the two maps by position.
   *
   * Present ONLY for executions that really produced a `RunResult` — which includes one whose
   * write-back was refused, because that execution did happen. A task that never ran has no
   * entry here, and therefore no result to leak from a previous attempt.
   */
  readonly executionsByTask: Readonly<Record<string, readonly DispatchExecutionRef[]>>;
  /** One entry per task the tick touched. */
  readonly outcomes: readonly DispatchOutcomeEntry[];
}

/** An empty receipt — used when a dispatch never reached the scheduler. */
export function emptyDispatchReceipt(dispatchedAt: number, reentrant = false): DispatchReceipt {
  return {
    dispatchedAt,
    admitted: [],
    waiting: [],
    skipped: [],
    reentrant,
    attemptIdsByTask: {},
    executionsByTask: {},
    outcomes: [],
  };
}

export interface BuildReceiptInput {
  readonly tick: Pick<TickResult, 'admitted' | 'waiting' | 'skipped' | 'outcomes'>;
  readonly dispatchedAt: number;
  readonly reentrant?: boolean;
  /** taskId -> attempt ids, as returned by the evidence recorder. */
  readonly attemptIdsByTask?: Readonly<Record<string, readonly string[]>>;
  /**
   * T3-a.5: taskId -> the correlated `{attemptId, run}` pairs, as returned by the evidence
   * recorder at the append site. Omit it only where no execution was recorded; a consumer that
   * finds a started task with no entry here must treat its result as ABSENT rather than
   * falling back to a task-keyed lookup.
   */
  readonly executionsByTask?: Readonly<Record<string, readonly DispatchExecutionRef[]>>;
}

/**
 * Project a `TickResult` into a receipt.
 *
 * `finished` is derived from the RUN, never from `ExecuteOutcome.ok`: `ok` is the
 * CONTROL-PLANE outcome, so gating on it would drop the terminal run of an
 * execution whose write-back was refused (stale lease / fencing). That run really
 * happened and its evidence must survive. So `finished` means "a terminal
 * `RunResult` was observed", and a refused admission that never ran stays
 * `finished: false` with no `terminalState`.
 */
export function buildDispatchReceipt(input: BuildReceiptInput): DispatchReceipt {
  const admittedSet = new Set(input.tick.admitted);
  const outcomes: DispatchOutcomeEntry[] = input.tick.outcomes.map((entry) => {
    const run = entry.outcome.run;
    return {
      taskId: entry.taskId,
      admitted: admittedSet.has(entry.taskId),
      finished: run !== undefined,
      ...(run === undefined ? {} : { terminalState: run.state }),
    };
  });
  return {
    dispatchedAt: input.dispatchedAt,
    admitted: [...input.tick.admitted],
    waiting: [...input.tick.waiting],
    skipped: input.tick.skipped.map((s) => ({ taskId: s.taskId, code: s.code, reason: s.reason })),
    reentrant: input.reentrant === true,
    attemptIdsByTask: input.attemptIdsByTask ?? {},
    executionsByTask: input.executionsByTask ?? {},
    outcomes,
  };
}
