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
 */

import type { TerminalState } from '../core/types.ts';
import type { TickResult } from './scheduler.ts';

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
    outcomes: [],
  };
}

export interface BuildReceiptInput {
  readonly tick: Pick<TickResult, 'admitted' | 'waiting' | 'skipped' | 'outcomes'>;
  readonly dispatchedAt: number;
  readonly reentrant?: boolean;
  /** taskId -> attempt ids, as returned by the evidence recorder. */
  readonly attemptIdsByTask?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Project a `TickResult` into a receipt.
 *
 * `finished` is derived from the OUTCOME, never from "we tried": `ExecuteOutcome.ok`
 * is true only when a `RunResult` was obtained, so a refused admission reports
 * `finished: false` and stays distinguishable from a real execution.
 */
export function buildDispatchReceipt(input: BuildReceiptInput): DispatchReceipt {
  const admittedSet = new Set(input.tick.admitted);
  const outcomes: DispatchOutcomeEntry[] = input.tick.outcomes.map((entry) => {
    const run = entry.outcome.ok ? entry.outcome.run : undefined;
    return {
      taskId: entry.taskId,
      admitted: admittedSet.has(entry.taskId),
      finished: entry.outcome.ok === true,
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
    outcomes,
  };
}
