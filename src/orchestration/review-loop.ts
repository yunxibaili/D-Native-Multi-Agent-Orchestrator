/**
 * src/orchestration/review-loop.ts — P6-D0: verdict -> verification -> bounded rework.
 *
 * THE ONE PATH
 * ------------
 *   ReviewVerdict
 *     -> toVerificationOutcome()      (a pure projection, nothing more)
 *     -> Orchestrator.applyVerification()   <-- the ONLY route into task state
 *     -> TaskStore.transition()             (the store's own rules)
 *
 * There is no review-specific store, no review-side transition, and no path from a
 * verdict to a status that does not go through `applyVerification`. That is the
 * property worth protecting: 5C-1 put `rework` in the transition table as a
 * RESERVED status and made `applyVerification` the only route into `succeeded`.
 * D0 un-reserves `rework` and leaves that authority exactly where it was.
 *
 * WHY A REVIEWER CANNOT STEER
 * ---------------------------
 * The obvious failure mode of a review loop is a reviewer that stops judging and
 * starts directing: "let MiMo rewrite the parser". Once that text can move a task,
 * the reviewer has become a second planner and the quality gate has become a
 * control channel.
 *
 * So a verdict's `recommendedAction: 'assign'` is RECORDED and NOT EXECUTED. The
 * reviewer may say what it would prefer; the orchestrator decides whether anything
 * happens. Reading the recommendation is not obeying it.
 *
 * WHY THE REWORK LOOP MUST TERMINATE
 * ----------------------------------
 * A worker that keeps failing review and a reviewer that keeps asking for changes
 * is an infinite loop with a real agent in it. Termination here rests on three
 * independent guards, because any one of them can be defeated by a real reviewer:
 *
 *   1. max attempts        — a hard count, from the task's OWN retryCount
 *   2. repeated verdict    — the same fingerprint twice stops the loop
 *   3. terminal outcome    — on either, the task goes `failed` via applyVerification
 *
 * `retryCount` is read from the `Task` itself rather than counted in a new object.
 * The P6 plan is explicit that counters live on the task or on `AttemptRecord`
 * (P6-E) and that no new authority may be created; using the task's existing field
 * is what lets D0 stay inside its boundary without pre-empting P6-E.
 */

import type { TaskObservation } from './observation.ts';
import type { ReviewEvidence, ReviewVerdict } from './review-verdict.ts';
import { isReviewVerdictError } from './review-verdict.ts';
import { validateDecision, type OrchestrationDecision } from './decision.ts';
import type { VerificationOutcome } from './translate.ts';
import type { MutateOutcome } from './orchestrator.ts';
import type { TickResult } from './scheduler.ts';
import type { Task } from './task.ts';
import type { TransitionResult } from './store.ts';

// ---------------------------------------------------------------------------
// The narrow slice of the orchestrator D0 needs
// ---------------------------------------------------------------------------

/**
 * The minimum orchestrator surface D0 uses.
 *
 * Declared structurally rather than importing the class so this module can be
 * tested against a real `Orchestrator` while remaining obviously incapable of
 * reaching `spawnChild`, `cancelTask` or any runtime method. If a future edit
 * widened this to the concrete class, `decision.ts`'s structural tests would be
 * the place it showed up.
 */
export interface VerificationAuthority {
  /** The ONLY route from a verdict into task state. */
  applyVerification(taskId: string, outcome: VerificationOutcome): MutateOutcome;
  /** Read the store. */
  getStore(): { get(taskId: string): Task | null };
}

export interface TaskSchedulerLike {
  /** The ONLY dispatch path. */
  tick(): Promise<TickResult>;
}

// ---------------------------------------------------------------------------
// Verdict -> VerificationOutcome
// ---------------------------------------------------------------------------

/**
 * Project a verdict onto the existing verification shape.
 *
 * Pure and total. The mapping is 1:1 because `VerificationOutcome` already carries
 * exactly the three verdicts D0 needs (`translate.ts:107`), so D0 invents no new
 * status semantics — it only decides WHICH of the existing three applies.
 *
 * The reason string is composed here rather than taken raw, so the TaskStore's
 * `blockedReason`-style record explains itself: which verdict, who reviewed, and
 * whether the reviewer asked for anything this stage will not do.
 */
export function toVerificationOutcome(verdict: ReviewVerdict): VerificationOutcome {
  const notes: string[] = [`${verdict.reason} (reviewed by ${verdict.reviewer})`];
  if (verdict.findings.length > 0) {
    notes.push(
      `${verdict.findings.length} finding(s): ` +
        verdict.findings.map((f) => `${f.severity} at ${f.location}`).join('; '),
    );
  }
  if (verdict.recommendedAction === 'assign') {
    // Recorded, not obeyed. The note exists so an operator reading the task later
    // can see the reviewer asked for a different worker and that D0 declined.
    notes.push('reviewer recommended a different worker; recorded as evidence only — reassignment is P6-B, not D0');
  }
  return { verdict: verdict.verdict, reason: notes.join(' ') };
}

// ---------------------------------------------------------------------------
// Bounded rework
// ---------------------------------------------------------------------------

/** Why a rework loop stopped. Every path out of the loop names itself. */
export type ReworkStop =
  | 'not-requested'
  | 'max-attempts-exhausted'
  | 'repeated-verdict'
  | 'not-dispatchable'
  | 'no-rework-capability';

export interface ReworkPolicy {
  /**
   * Hard ceiling on rework attempts for one task.
   *
   * Must be >= 1. A policy of 0 would mean "a verdict of rework can never be
   * honoured", which is a different thing and should be expressed by not asking
   * for a rework at all — silently doing nothing is worse than saying so.
   */
  readonly maxAttempts: number;
}

/** A default that is deliberately small: rework is a correction, not a strategy. */
export const DEFAULT_REWORK_POLICY: ReworkPolicy = Object.freeze({ maxAttempts: 2 });

export type ReviewOutcome =
  /** The verdict was applied; here is what it did. */
  | {
      readonly status: 'ok';
      readonly verdict: ReviewVerdict;
      readonly evidence: ReviewEvidence;
      /** The task's status after `applyVerification`. */
      readonly taskStatus: Task['status'];
      /** True when the task was moved into a rework-eligible state. */
      readonly reworkRequested: boolean;
      /** Always 1: an applied verdict never dispatches by itself. */
      readonly dispatched: boolean;
    }
  /** The verdict could not be trusted. Nothing was changed. */
  | {
      readonly status: 'invalid-verdict';
      readonly error: ReturnType<typeof isReviewVerdictError> extends true ? Error : Error;
      readonly dispatched: false;
    }
  /** A rework was requested but the loop's guard stopped it. */
  | {
      readonly status: 'rework-stopped';
      readonly verdict: ReviewVerdict;
      readonly evidence: ReviewEvidence;
      readonly stop: ReworkStop;
      readonly detail: string;
      /** True only when the task was actually moved to `failed`. */
      readonly taskFailed: boolean;
      readonly dispatched: false;
    }
  /** `applyVerification` itself refused. Its code is preserved verbatim. */
  | {
      readonly status: 'verification-refused';
      readonly verdict: ReviewVerdict;
      readonly code: string;
      readonly reason: string;
      readonly dispatched: false;
    };

export interface ApplyVerdictOptions {
  /** The single verification authority. */
  readonly orchestrator: VerificationAuthority;
  readonly taskId: string;
  readonly verdict: ReviewVerdict;
  /** Verdicts already recorded for this task. Read for duplicate detection. */
  readonly previous?: readonly ReviewEvidence[];
  readonly policy?: ReworkPolicy;
}

/**
 * Apply one verdict to one task.
 *
 * Runs exactly one of three paths and returns which. The order is deliberate:
 * trust the verdict, then check the loop guard, then hand it to the existing
 * authority. Checking the guard BEFORE applying is what makes "the reviewer asked
 * again, and we stopped" a real outcome instead of an applied rework that
 * something downstream has to undo.
 */
export function applyReviewVerdict(options: ApplyVerdictOptions): ReviewOutcome {
  const policy = options.policy ?? DEFAULT_REWORK_POLICY;

  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    // A nonsensical policy would otherwise be silently treated as "unlimited",
    // which is the one interpretation a bounded loop must never have.
    return {
      status: 'invalid-verdict',
      error: new Error(`rework policy maxAttempts must be an integer >= 1, got ${String(policy.maxAttempts)}`),
      dispatched: false,
    };
  }

  const task = options.orchestrator.getStore().get(options.taskId);
  if (task === null) {
    return {
      status: 'verification-refused',
      verdict: options.verdict,
      code: 'task-not-found',
      reason: `no task "${options.taskId}"`,
      dispatched: false,
    };
  }

  const evidence = toEvidence(options.taskId, options.verdict, options.previous ?? []);

  // ---- the loop guard, BEFORE anything is applied ----
  //
  // Checked only for a rework verdict: a repeated `pass` is not a loop, and a
  // repeated `reject` is already terminal, so counting them would refuse a
  // perfectly good final answer.
  if (options.verdict.verdict === 'rework') {
    if (task.retryCount >= policy.maxAttempts) {
      return {
        status: 'rework-stopped',
        verdict: options.verdict,
        evidence,
        stop: 'max-attempts-exhausted',
        detail:
          `task "${options.taskId}" has already used ${task.retryCount} rework attempt(s) ` +
          `of a maximum of ${policy.maxAttempts}`,
        taskFailed: false,
        dispatched: false,
      };
    }
    if (evidence.duplicateOfPrevious) {
      // Same findings, same verdict. Another round would produce the same result,
      // so the loop stops here rather than spending an agent to learn that again.
      return {
        status: 'rework-stopped',
        verdict: options.verdict,
        evidence,
        stop: 'repeated-verdict',
        detail:
          `task "${options.taskId}" received the identical verdict (fingerprint ` +
          `${options.verdict.fingerprint}) more than once; another rework would repeat the same request`,
        taskFailed: false,
        dispatched: false,
      };
    }
  }

  // ---- hand it to the ONE authority ----
  const outcome = toVerificationOutcome(options.verdict);
  const applied = options.orchestrator.applyVerification(options.taskId, outcome);
  if (!applied.ok) {
    return {
      status: 'verification-refused',
      verdict: options.verdict,
      code: applied.code,
      reason: applied.reason,
      dispatched: false,
    };
  }

  const after = options.orchestrator.getStore().get(options.taskId);
  return {
    status: 'ok',
    verdict: options.verdict,
    evidence,
    taskStatus: after?.status ?? 'failed',
    reworkRequested: after?.status === 'rework',
    // A verdict never dispatches. `rework` is a STATE; it becomes work when the
    // scheduler is ticked, which is the caller's next step and always is.
    dispatched: false,
  };
}

function toEvidence(taskId: string, verdict: ReviewVerdict, previous: readonly ReviewEvidence[]): ReviewEvidence {
  return Object.freeze({
    taskId,
    verdict,
    duplicateOfPrevious:
      verdict.fingerprint !== undefined &&
      previous.some((p) => p.verdict.fingerprint === verdict.fingerprint),
  });
}

// ---------------------------------------------------------------------------
// Rework: state -> queued, on the SAME worker
// ---------------------------------------------------------------------------

export interface ReworkReentry {
  readonly ok: boolean;
  readonly code: string;
  readonly reason: string;
  readonly taskStatus: Task['status'] | null;
  /** The task's own attempt counter AFTER this rework was counted. */
  readonly retryCount: number;
}

/**
 * The authority `prepareRework` needs to re-enter a task.
 *
 * Notice what is ABSENT: `transition`. This interface exposes only `queue()` —
 * the orchestrator's own existing method — plus read access and the task's
 * counter. A review module that cannot call `transition` cannot invent a state
 * change, which is the property that keeps D0 from being a second authority.
 *
 * `incrementRetry` is `TaskStore`'s own method (store.ts:181) — 5C-1 recorded it
 * and nothing called it until now. D0 uses it rather than counting in a side
 * object, which is the P6 plan's rule about where counters live: the number that
 * stops a rework loop belongs to the task, so it survives a restart and cannot
 * disagree with the state it guards.
 */
export interface ReworkAuthority {
  /** The EXISTING `planned/queued/rework -> queued` path. */
  queue(taskId: string): MutateOutcome;
  getStore(): {
    get(taskId: string): Task | null;
    incrementRetry(taskId: string): TransitionResult;
  };
}

/**
 * Move a task from `rework` into `queued`, so the scheduler will dispatch it, and
 * count the attempt on the task.
 *
 * This is the whole of D0's rework execution path, and it is short because
 * everything it needs already exists:
 *
 *   rework -> queued    is already legal in `TASK_TRANSITIONS` (task.ts:74)
 *   Orchestrator.queue() already performs it, via TaskStore.transition
 *   candidates()        already accepts `queued` (scheduler.ts:121)
 *   executeTask         then runs it with the task's UNCHANGED agentId / modelId
 *
 * Nothing here names an agent, so there is nothing that could reassign one. The
 * worker that runs the rework is whatever `task.agentId` already was — the
 * "same agent" guarantee, enforced by the absence of any way to express a
 * different one.
 *
 * ORDER MATTERS: the counter is bumped only AFTER the transition succeeds. A
 * refused transition must not consume an attempt, or a task could be starved of
 * rework by failures that never actually re-ran it.
 *
 * A refused transition leaves the task in `rework`, which is NOT dispatchable, so
 * a caller must treat `ok: false` as "stop", never as "try again".
 */
export function prepareRework(authority: ReworkAuthority, taskId: string, reason?: string): ReworkReentry {
  const store = authority.getStore();
  const task = store.get(taskId);
  if (task === null) {
    return { ok: false, code: 'task-not-found', reason: `no task "${taskId}"`, taskStatus: null, retryCount: 0 };
  }

  // The existing method, not a raw transition.
  const moved = authority.queue(taskId);
  if (!moved.ok) {
    return {
      ok: false,
      code: moved.code,
      reason: moved.reason,
      taskStatus: store.get(taskId)?.status ?? null,
      retryCount: store.get(taskId)?.retryCount ?? 0,
    };
  }

  // `incrementRetry` is called for its side effect on the task; its own result is
  // not consulted because the authoritative count is re-read from the store below.
  store.incrementRetry(taskId);
  return {
    ok: true,
    code: 'queued',
    reason: reason === undefined ? 'rework requested by review' : `rework requested by review: ${reason}`,
    taskStatus: store.get(taskId)?.status ?? null,
    retryCount: store.get(taskId)?.retryCount ?? task.retryCount,
  };
}

/**
 * Build the rework decision for a task.
 *
 * The observation is NOT a parameter. That is the point: this is a pure
 * constructor of a typed decision, and validity is decided by `validateDecision`
 * against whatever observation is live AT APPLY TIME. Accepting an observation here
 * would invite a caller to validate against a stale snapshot and then apply
 * against a newer one — the same split-brain P6-A already closed for `continue`.
 */
export function toReworkDecision(taskId: string, reason?: string): OrchestrationDecision {
  return reason === undefined
    ? { action: 'rework', taskId }
    : { action: 'rework', taskId, reason };
}

/**
 * Validate a rework decision against a live observation, or throw.
 *
 * Rework therefore goes through P6-A's own validator — it is not a privileged
 * action with its own shortcut. D0 has no private route into task state.
 */
export function validateReworkDecision(observation: TaskObservation, taskId: string, reason?: string): OrchestrationDecision {
  return validateDecision(toReworkDecision(taskId, reason), observation);
}
