/**
 * src/cli/workflow-checkpoint.ts — B4.6a: the single-step USER checkpoint.
 *
 * ============================================================================
 * WHAT THIS IS
 * ============================================================================
 * A TINY value + standard-library-stdin module. It defines:
 *
 *   - `WorkflowCheckpointSnapshot`: a plain, DETACHED, frozen record of ONE
 *     attempt that actually ran and is now waiting for verification. It holds
 *     primitives only; no Workbench, TaskStore, Runtime, scheduler or callable is
 *     reachable from it.
 *   - `parseCheckpointAnswer`: the ONE pure validator of the user's raw answer
 *     ("continue", "stop <reason>" or "accept <reason>"). It is deliberately strict:
 *     an unrecognised answer, or an `accept`/`stop` with no reason, is `invalid`,
 *     never a default.
 *   - `createStdinCheckpointReader`: the production reader, built on Node's own
 *     `readline`. It is opt-in by the caller, refuses when stdin is not a
 *     terminal, bounds the wait at `CHECKPOINT_TIMEOUT_MS`, and releases its
 *     readline/timer/listeners in a `finally` so nothing can keep a process alive.
 *
 * ============================================================================
 * WHAT THIS IS NOT
 * ============================================================================
 * It is NOT a manager, a state machine, an authority, or a second completion
 * path. This module itself reads nothing from the round and writes nothing to it;
 * it only PARSES a raw answer. The round CLI builds a snapshot, asks the user,
 * validates the RAW answer here, and then either lets the EXISTING LAYA
 * verification/scheduling continue ("continue"), stops its own bounded loop
 * ("stop"), or — for "accept" — re-checks the live task/attempt and, ONLY if it
 * still matches what was shown, hands the acceptance to the EXISTING completion
 * authority (`NativeWorkbench.completeTask` -> `applyVerification`). "continue"
 * does not set `succeeded`, does not skip a fixed pair / model-pool / stage /
 * resource gate, and calls no supervisor model. "stop" leaves the task in
 * `to_verify` and starts nothing.
 *
 * "accept" is an EXPLICIT HUMAN verdict, NOT a LAYA choice, an independent Agent
 * review, executed test proof, or physical artifact certification. It is only an
 * input in the grammar here; applying it (and refusing it when the displayed facts
 * no longer match) belongs to the CLI's checkpoint gate.
 *
 * The checkpoint is USER SUPERVISION (and, for accept, an explicit human verdict),
 * not an independent review: the reviewer (`--review-agent`) is a different,
 * separate step.
 */

import { createInterface } from 'node:readline';

/**
 * The facts shown to the user for ONE attempt that really ran.
 *
 * Every field is a copy of an authoritative value taken at the moment the
 * checkpoint is offered. It is DETACHED on purpose (§T2-a.3): a test seam that
 * received the Workbench could call `assignChildren`/`reassignTask` on it, so the
 * snapshot exposes only plain values with nothing to call.
 */
export interface WorkflowCheckpointSnapshot {
  /** The task whose run just finished. */
  readonly taskId: string;
  /** The task's status at checkpoint time — `to_verify` for a real run. */
  readonly status: string;
  /** The declared role (a TAG), or null when the plan did not declare one. */
  readonly role: string | null;
  /** The task's own acceptance criteria — what "done" means for it. */
  readonly acceptanceCriteria: string;
  /** The attempt id of THIS run, correlated to the result below. */
  readonly attemptId: string;
  /** The REQUESTED agent of this run. Not proof a particular model actually answered. */
  readonly agentId: string;
  /** The requested model, or null when none was named. */
  readonly modelId: string | null;
  /**
   * The session bound to THIS attempt (the same atomic attempt record the ids above
   * come from), or null when the runtime recorded none. Carried so an `accept` can be
   * re-checked against the CURRENT worker identity, not just the displayed pair.
   */
  readonly sessionId: string | null;
  /** A bounded tail of this attempt's own output. */
  readonly output: string;
  /**
   * Whether `output` is a bounded/truncated view rather than the whole text. Always
   * true-able: a snapshot never claims to carry the full transcript (that is on disk).
   */
  readonly outputTruncated: boolean;
  /**
   * The run's own `cleanup.treeStopConfirmed`, when the runtime reported one.
   * `null` when the runtime did not report a cleanup fact — never guessed.
   */
  readonly treeStopConfirmed: boolean | null;
}

/** The user's decision after seeing a snapshot. */
export type CheckpointDecision =
  | { readonly action: 'continue' }
  | { readonly action: 'stop'; readonly reason: string }
  | { readonly action: 'accept'; readonly reason: string }
  | { readonly action: 'invalid'; readonly detail: string };

/** How much of this attempt's own output a snapshot may carry. */
export const CHECKPOINT_OUTPUT_MAX_CHARS = 2000;

/** How long the reader waits for a terminal answer before failing closed. */
export const CHECKPOINT_TIMEOUT_MS = 60_000;

/**
 * Validate the user's RAW answer. Pure and total.
 *
 * Only three answers are accepted: `continue`, `stop <reason>` and `accept <reason>`,
 * the last two with a NON-EMPTY reason. Anything else — including a bare `stop` or
 * bare `accept`, a wrong word, an empty line, or a non-string smuggled past the type —
 * is `invalid`, and the caller treats `invalid` as a STOP. There is deliberately NO
 * default that lets a round proceed without a real answer.
 */
export function parseCheckpointAnswer(raw: string): CheckpointDecision {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.toLowerCase() === 'continue') return { action: 'continue' };
  const a = /^accept(?:[:\s]+([\s\S]+))?$/i.exec(text);
  if (a !== null) {
    const reason = (a[1] ?? '').trim();
    if (reason === '') {
      return { action: 'invalid', detail: 'an accept requires a reason: use "accept <reason>"' };
    }
    return { action: 'accept', reason };
  }
  const m = /^stop(?:[:\s]+([\s\S]+))?$/i.exec(text);
  if (m !== null) {
    const reason = (m[1] ?? '').trim();
    if (reason === '') {
      return { action: 'invalid', detail: 'a stop requires a reason: use "stop <reason>"' };
    }
    return { action: 'stop', reason };
  }
  return { action: 'invalid', detail: `expected "continue", "stop <reason>" or "accept <reason>" (got "${text.slice(0, 80)}")` };
}

/** Raised by the production reader when no trustworthy answer can be obtained. */
export type CheckpointInputFailureCode =
  | 'input-not-terminal' | 'input-timeout' | 'input-disconnected' | 'input-error';

export class CheckpointInputError extends Error {
  readonly code: CheckpointInputFailureCode;

  constructor(message: string, code: CheckpointInputFailureCode = 'input-error') {
    super(message);
    this.name = 'CheckpointInputError';
    this.code = code;
  }
}

/** The streams/timing the reader uses. Production passes nothing. */
export interface CheckpointReaderDeps {
  readonly input?: NodeJS.ReadableStream & { readonly isTTY?: boolean };
  readonly output?: NodeJS.WritableStream;
  readonly timeoutMs?: number;
}

/**
 * Render a snapshot for a terminal. Plain text; written to the reader's OUTPUT
 * (stderr in production) so stdout keeps its machine-readable report intact.
 */
export function renderCheckpointPrompt(s: WorkflowCheckpointSnapshot): string {
  const output = s.output === '' ? '(empty)' : `${s.output}${s.outputTruncated ? ' …[truncated]' : ''}`;
  return [
    '',
    '===== WORKFLOW CHECKPOINT (user supervision; no supervisor model was called) =====',
    `  task        ${s.taskId} (${s.status})`,
    `  role        ${s.role ?? '(none declared)'}`,
    `  criteria    ${s.acceptanceCriteria}`,
    `  attempt     ${s.attemptId}`,
    `  session     ${s.sessionId ?? '(none recorded)'}`,
    `  requested   ${s.agentId}/${s.modelId ?? '(no model named)'}  (request only; not a verified actual model)`,
    `  output      ${output}`,
    `  tree stop   ${s.treeStopConfirmed === null ? '(unknown)' : s.treeStopConfirmed ? 'confirmed' : 'NOT confirmed'}`,
    '  continue     -> let the existing LAYA verification/scheduling proceed (this choice verifies nothing itself)',
    '  stop <reason> -> stop this round; the reason is recorded and nothing further runs',
    '  accept <reason> -> YOU accept the DISPLAYED task as done. It is marked succeeded through the EXISTING',
    '                     verification authority as YOUR explicit verdict - NOT a LAYA decision, a model review,',
    '                     or proof that a test passed or an artifact exists. It is refused unless the current',
    '                     attempt still matches, is awaiting verification, and its process-tree stop is confirmed.',
    'ANSWER (continue | stop <reason> | accept <reason>): ',
  ].join('\n') + '\n';
}

/**
 * The production reader. Node's own `readline`, ONE line, ONE attempt (never a
 * re-ask loop).
 *
 * Failure is ALWAYS closed (an exception, which the caller turns into a stop):
 *   - stdin is not a terminal  -> refuse WITHOUT waiting;
 *   - stdin closes (EOF)       -> refuse;
 *   - a stream error           -> propagate;
 *   - no answer within timeout -> refuse.
 *
 * The readline interface, its listeners and the timer are released in a `finally`,
 * so a process that used the reader exits naturally without `process.exit`.
 */
export function createStdinCheckpointReader(
  deps: CheckpointReaderDeps = {},
): (snapshot: WorkflowCheckpointSnapshot) => Promise<string> {
  const input = deps.input ?? process.stdin;
  const output = deps.output ?? process.stderr;
  const timeoutMs = deps.timeoutMs ?? CHECKPOINT_TIMEOUT_MS;
  return async function readCheckpointAnswer(snapshot: WorkflowCheckpointSnapshot): Promise<string> {
    if ((input as { readonly isTTY?: boolean }).isTTY !== true) {
      throw new CheckpointInputError(
        'stdin is not a terminal; refusing to read a checkpoint answer (fail closed)',
        'input-not-terminal',
      );
    }
    output.write(renderCheckpointPrompt(snapshot));
    const rl = createInterface({ input, output });
    try {
      return await new Promise<string>((resolve, reject) => {
        let settled = false;
        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          fn();
        };
        const timer = setTimeout(
          () => settle(() => reject(new CheckpointInputError(`no checkpoint answer within ${timeoutMs} ms (fail closed)`, 'input-timeout'))),
          timeoutMs,
        );
        (timer as unknown as { unref?: () => void }).unref?.();
        const done = (fn: () => void): void => settle(() => { clearTimeout(timer); fn(); });
        rl.question('', (answer) => done(() => resolve(answer)));
        rl.once('close', () => done(() => reject(new CheckpointInputError(
          'stdin closed before a checkpoint answer was given (fail closed)',
          'input-disconnected',
        ))));
        rl.once('error', (e) => done(() => reject(new CheckpointInputError(e.message, 'input-error'))));
      });
    } finally {
      rl.removeAllListeners();
      rl.close();
    }
  };
}
