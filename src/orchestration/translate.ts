/**
 * src/orchestration/translate.ts — RunResult → Task status.
 *
 * The single place where the Runtime's answer becomes a task's answer. Keeping
 * it in one pure function means there is exactly one place to audit when
 * asking "why did a failed agent look succeeded?".
 *
 * The rule that matters most, from the 5C-1 mandate:
 *
 *   > An agent returning success must NOT make the task equal "review passed".
 *
 * So a successful run goes to `to_verify`, never straight to `succeeded`. The
 * verifier's decision is a separate act that 5C-1 does not automate.
 *
 * Reused from `pi-subagents/abortable.ts` + `status-note.ts` (MIT): the
 * "bounded end" idea — a run that hits its bound produces a clean partial
 * result rather than being silently treated as a full one. Adapted here to
 * the fact that our `RunResult` is already bounded and immutable; we only have
 * to READ its terminal state, never reconstruct one.
 */

import type { RunResult, TerminalState } from '../core/types.ts';
import type { TaskStatus } from './task.ts';

export interface RunTranslation {
  /** The status the task should move to. */
  to: TaskStatus;
  /** True when the move is terminal for the task. */
  terminal: boolean;
  /** True when the task is now waiting for a human/reviewer decision. */
  awaitingVerification: boolean;
  /** Why, in words a human can act on. Never a bare state name. */
  reason: string;
}

/**
 * The runtime error codes that mean "this worker could not continue", as opposed to
 * "the work is wrong".
 *
 * The distinction is drawn from the REAL `RunResult.error.code` values the runtime
 * emits, not invented here. `NONZERO_EXIT` is deliberately ABSENT: a process that ran
 * and exited non-zero reported on the work, and handing that to another agent
 * automatically is the "换 agent 再试" loop this project forbids.
 */
export const AVAILABILITY_ERROR_CODES: ReadonlySet<string> = new Set([
  'SPAWN_FAILED',
  'TRANSPORT_ERROR',
]);

export interface TranslateOptions {
  /**
   * R2-3: allow an availability-caused failure to park in `retrying` instead of going
   * terminal.
   *
   * DEFAULT FALSE, so every existing caller is byte-identical. It is off by default
   * because `failed` is the honest default reading of a failed run, and a translation
   * that quietly reinterprets failure as "try again" would change the meaning of every
   * round in the system.
   *
   * When it IS enabled, only `SPAWN_FAILED` / `TRANSPORT_ERROR` are affected: the agent
   * could not be started, or its session died. The task lands in `retrying`, whose only
   * exits are `queued` (another attempt) and `failed` (budget exhausted), so it cannot
   * idle in a non-terminal state and be mistaken for progress.
   */
  readonly allowAvailabilityContinuation?: boolean;
}

/** Map a terminal `RunResult` state onto a task status. */
export function translateRunResult(result: RunResult, options: TranslateOptions = {}): RunTranslation {
  const state: TerminalState = result.state;

  switch (state) {
    case 'succeeded':
      // Success of the PROCESS is not success of the WORK. Hand it to verify.
      return {
        to: 'to_verify',
        terminal: false,
        awaitingVerification: true,
        reason:
          'agent run succeeded; the work is NOT yet verified — a successful run does not imply acceptance criteria were met',
      };

    case 'failed': {
      // R2-3: an availability failure parks rather than terminating, but ONLY when the
      // caller opted in. It is still not a success and still not verified.
      if (options.allowAvailabilityContinuation === true) {
        const code = result.error?.code;
        if (code !== undefined && AVAILABILITY_ERROR_CODES.has(code)) {
          return {
            to: 'retrying',
            terminal: false,
            awaitingVerification: false,
            reason:
              `${describeFailure(result)} — the worker could not continue (${code}), so the task is parked in ` +
              'retrying rather than failed; it can move to another agent or exhaust into failed',
          };
        }
      }
      return {
        to: 'failed',
        terminal: true,
        awaitingVerification: false,
        reason: describeFailure(result),
      };
    }

    case 'cancelled':
      return {
        to: 'cancelled',
        terminal: true,
        awaitingVerification: false,
        reason: result.error?.message ?? 'the run was cancelled',
      };

    case 'timed_out':
      // Distinct from `failed`: the agent did not report failure, we stopped
      // waiting. Conflating the two would make a slow agent look like a broken
      // one in the retry decision.
      return {
        to: 'failed',
        terminal: true,
        awaitingVerification: false,
        reason: `run timed out after ${result.endedAt - result.startedAt}ms without a result`,
      };

  }

  // A returned RunResult is never 'running' (TerminalState excludes it), so
  // this is unreachable in practice. It is here so that adding a state to
  // RunResult later produces a refusal rather than an undefined status.
  return {
    to: 'blocked',
    terminal: false,
    awaitingVerification: false,
    reason: `run ended in unexpected state "${state}"; task is blocked rather than being reported as finished`,
  };
}

function describeFailure(result: RunResult): string {
  const base =
    result.error?.code !== undefined
      ? `${result.error.code}: ${result.error.message}`
      : (result.error?.message ?? 'the run failed without a reported reason');
  const exit = result.exitCode !== null ? ` (exit ${result.exitCode})` : '';
  return `${base}${exit}`;
}

/**
 * The reviewer's verdict, kept separate on purpose.
 *
 * 5C-1 implements the interface and the state, not the review loop. The
 * separation is the point: the only way into `succeeded` runs through here, so
 * a future reviewer cannot be bypassed by a shortcut in the run path.
 */
export interface VerificationOutcome {
  verdict: 'pass' | 'rework' | 'reject';
  reason: string;
}

export function translateVerification(outcome: VerificationOutcome): {
  to: TaskStatus;
  terminal: boolean;
  reason: string;
} {
  switch (outcome.verdict) {
    case 'pass':
      return { to: 'succeeded', terminal: true, reason: `verified: ${outcome.reason}` };
    case 'rework':
      // `rework` is a reserved status in 5C-1: recorded, not executed. The
      // scheduler does not yet act on it, which is honest about the boundary.
      return { to: 'rework', terminal: false, reason: `rework required: ${outcome.reason}` };
    case 'reject':
      return { to: 'failed', terminal: true, reason: `rejected: ${outcome.reason}` };
  }
}
