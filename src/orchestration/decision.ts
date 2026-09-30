/**
 * src/orchestration/decision.ts — P6-A: the closed action vocabulary and its validator.
 *
 * THE ONE RULE THAT SHAPES THIS FILE
 * ---------------------------------
 * An invalid decision is NOT a permitted decision. Every path through
 * `validateDecision` that cannot prove a decision is well-formed, targeted at a
 * task that exists, legal from that task's current state, and IMPLEMENTED, throws
 * `DecisionValidationError`. There is no `fallback`, no `defaultAction`, no
 * "assume continue". This mirrors `DecisionProvider` (decision/types.ts:214),
 * which is forbidden from returning a guess for exactly the same reason: an
 * unrecognised answer and a benign one must not be indistinguishable to a
 * caller, or the loop would keep moving on nothing but hope.
 *
 * WHY Laya CANNOT SPEAK PROSE
 * --------------------------
 * The action is a field on a closed union. There is no `instruction: string` to
 * hide an imperative in, and no free-text payload that could be read as a command.
 * A decision can only ever be one of the listed actions with one of the listed
 * payloads — which is what makes `applyDecision` total and reviewable.
 *
 * WHY NOT-IMPLEMENTED IS A FIRST-CLASS VERDICT
 * ---------------------------------------------
 * P6-A implements three actions. The other seven are FROZEN vocabulary, reserved
 * for their owning stages. They are deliberately represented as recognised-but-
 * disabled rather than as unknown names, because the two failures are different
 * and worth telling apart: `unknown-action` means Laya invented something (a model
 * problem), `action-not-implemented` means it asked for something real that this
 * stage has not built yet (a scoping fact). Collapsing them would hide a
 * misbehaving decision behind a roadmap item.
 *
 * Neither may be silently promoted to `continue`. That is the single most
 * dangerous bug available here: a reassign request quietly becoming "carry on"
 * would look like progress while the assignment it asked for never happened.
 */

import type { TaskObservation } from './observation.ts';

// ---------------------------------------------------------------------------
// The frozen action vocabulary (P6 plan §11). Types are frozen HERE, in P6-A;
// each stage then implements its own actions without renaming anything.
// ---------------------------------------------------------------------------

/**
 * Actions that can actually be executed.
 *
 * `rework` was enabled by P6-D0, the stage that owns it. Enabling it did NOT add
 * an execution path: `applyDecision` reaches it through the same single
 * `dispatch` capability as `continue`, and only after the task has been moved back
 * into a dispatchable state by the existing legal transition (`rework -> queued`).
 */
export const IMPLEMENTED_ACTIONS = ['continue', 'wait', 'abort', 'rework'] as const;
export type ImplementedAction = (typeof IMPLEMENTED_ACTIONS)[number];

/**
 * Actions that exist in the vocabulary but belong to a later stage.
 *
 * Listed explicitly rather than inferred from a union, so "is this implemented?"
 * is a lookup rather than a guess. P6-B/C/D1 each remove their own.
 *
 * `retry` is still here even though it sounds like `rework`: retry means "run it
 * again because it failed", rework means "run it again because a reviewer asked
 * for changes". Only the second is implemented, and merging them would make the
 * reviewer invisible in the retry path.
 */
export const DEFERRED_ACTIONS = [
  'parallelize',
  'retry',
  'reassign',
  'replan',
  'add_task',
  'split_task',
  'complete',
] as const;
export type DeferredAction = (typeof DEFERRED_ACTIONS)[number];

/** Every action name the vocabulary knows. */
export const ALL_ACTIONS = [...IMPLEMENTED_ACTIONS, ...DEFERRED_ACTIONS] as const;
export type DecisionAction = (typeof ALL_ACTIONS)[number];

// ---------------------------------------------------------------------------
// The typed decision union
// ---------------------------------------------------------------------------

/**
 * A validated decision.
 *
 * The union is exhaustive over `ImplementedAction`: there is no member that is
 * merely "something else", so a caller switching on `action` gets a compile
 * error when an action is added rather than a runtime surprise.
 */
export type OrchestrationDecision =
  /** There is safe work to do; let the scheduler dispatch it. */
  | {
      readonly action: 'continue';
      /**
       * Why the decision brain thinks progress is possible. Recorded for the
       * audit trail. NOT a command: nothing reads it as one.
       */
      readonly rationale?: string;
    }
  /**
   * Nothing can safely advance right now.
   *
   * Explicit rather than a no-op: the loop records the reason, so "idle" and
   * "asked to hold" stay distinguishable in the report.
   */
  | {
      readonly action: 'wait';
      readonly rationale?: string;
    }
  /**
   * End this decision cycle.
   *
   * Deliberately narrow. It means "stop deciding and dispatching right now" — it
   * does NOT cancel tasks, delete anything, revert git, or kill agents. Task
   * state belongs to `TaskStore`, and a decision brain has no standing to end
   * someone's work; `TaskScheduler.cancel()` and `Orchestrator.cancelTask()` are
   * the explicit, audited paths for that.
   */
  | {
      readonly action: 'abort';
      /**
       * Optional, and deliberately NOT required.
       *
       * The provider can only return the choice it was offered, so demanding a
       * free-text `reason` would push prose into the model — which is the control
       * protocol this whole design exists to prevent. The bare action is already
       * unambiguous ("stop this cycle"), so the loop records the fact itself and
       * a caller may attach a short note after validation, never before it.
       */
      readonly reason?: string;
    }
  /**
   * Send a task back for another attempt, on the SAME worker assignment.
   *
   * Enabled by P6-D0. The scope is deliberately this narrow: it names a task and
   * asks for it to be dispatched again. It does NOT name an agent, a model, or a
   * plan — reassignment is P6-B and replanning is P6-C, and a decision that could
   * express either would be a stage boundary quietly crossed.
   *
   * `taskId` is REQUIRED here (not optional as on `abort`), because "rework
   * something" is not actionable: the task to rework is the whole content of the
   * decision. An absent id is refused by the validator.
   */
  | {
      readonly action: 'rework';
      readonly taskId: string;
      /** Why the task is going back. Recorded as evidence, not an instruction. */
      readonly reason?: string;
    };

/** What the loop did with a decision. */
export type DecisionApplication =
  | { readonly applied: true; readonly dispatched: boolean; readonly note: string }
  /** Valid decision, but nothing to act on. Not an error. */
  | { readonly applied: false; readonly code: string; readonly reason: string };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Every way a decision fails to be trustworthy.
 *
 * Carries a `code` so a caller can branch (and so a test can assert the exact
 * reason), and is deliberately NOT a subclass of anything in `src/decision/`: the
 * Decision Layer describes a provider failing to answer, while this describes a
 * decision that arrived and cannot be acted on. Folding them together would mean
 * catching "the brain is down" also caught "the brain was wrong".
 */
export class DecisionValidationError extends Error {
  readonly code: string;
  readonly detail: string;

  constructor(code: string, detail: string) {
    super(`Orchestration decision rejected [${code}]: ${detail}. ` +
      `No task was changed and nothing was dispatched: an action that cannot be ` +
      `understood or safely executed is never treated as permission to continue.`);
    this.name = 'DecisionValidationError';
    this.code = code;
    this.detail = detail;
  }
}

export function isDecisionValidationError(value: unknown): value is DecisionValidationError {
  return value instanceof DecisionValidationError;
}

/**
 * Statuses a decision may act on — i.e. the statuses that are still IN PLAY.
 *
 * `abort` in particular is meaningless against a finished task, and accepting it
 * would let a decision look effective while changing nothing.
 *
 * `rework` was added by P6-D0, and it is the case that makes the rule subtle: a
 * task sitting in `rework` has NOT finished. It is mid-correction, and the one
 * legal move out of it (`rework -> queued`, task.ts:74) is precisely what a
 * `rework` decision asks for. Treating "not terminal" as the test — rather than an
 * explicit list of the five pre-D0 statuses — keeps this from having to be
 * revisited every time a stage un-reserves a status.
 */
const ACTIVE_STATUSES = ['planned', 'queued', 'running', 'blocked', 'to_verify', 'rework'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalRationale(raw: Record<string, unknown>): string | undefined {
  const v = raw.rationale;
  if (v === undefined) return undefined;
  if (typeof v !== 'string') {
    throw new DecisionValidationError('malformed-decision', `"rationale" must be a string, got ${typeof v}`);
  }
  return v;
}

/**
 * Validate a raw decision against a live observation.
 *
 * Pure: it reads the observation and throws, and it has no reference to the
 * store, the scheduler or the runtime. That is a deliberate constraint — a
 * validator that could execute would be unable to be trusted to refuse, since its
 * own side effects would already have happened before it finished checking.
 *
 * Order matters and is chosen so the most fundamental failure is reported first:
 * shape, then vocabulary, then implementation, then target, then state. A caller
 * fixing a bug gets the root cause rather than a downstream symptom.
 */
export function validateDecision(raw: unknown, observation: TaskObservation): OrchestrationDecision {
  // 1. shape
  if (!isRecord(raw)) {
    throw new DecisionValidationError('malformed-decision', `expected an object, got ${Array.isArray(raw) ? 'an array' : typeof raw}`);
  }
  const action = raw.action;
  if (typeof action !== 'string' || action.trim() === '') {
    throw new DecisionValidationError('malformed-decision', `"action" must be a non-empty string, got ${JSON.stringify(action)}`);
  }

  // 2. vocabulary — is this a name we recognise at all?
  if (!(ALL_ACTIONS as readonly string[]).includes(action)) {
    throw new DecisionValidationError(
      'unknown-action',
      `"${action}" is not in the action vocabulary [${ALL_ACTIONS.join(', ')}]`,
    );
  }

  // 3. implementation — recognised, but belongs to a later stage.
  //
  // Checked BEFORE the target/state checks on purpose: "reassign is not built yet"
  // is the complete and correct answer, and a validator that reported
  // "no such task" first would send the reader looking in the wrong place.
  if (!(IMPLEMENTED_ACTIONS as readonly string[]).includes(action)) {
    throw new DecisionValidationError(
      'action-not-implemented',
      `"${action}" is part of the frozen vocabulary but is not implemented yet; implemented = [${IMPLEMENTED_ACTIONS.join(', ')}]. ` +
        `It is NOT executed, and it is not downgraded to continue.`,
    );
  }

  // Only implemented actions remain; `action` is narrowed so the return type is
  // exact and a new action cannot be forgotten here.
  const implemented = action as ImplementedAction;

  if (implemented === 'abort') {
    // The bare action is complete. A supplied reason is accepted only if it is a
    // string, because a non-string here would otherwise ride along unexamined.
    const reason = raw.reason;
    if (reason !== undefined && typeof reason !== 'string') {
      throw new DecisionValidationError('malformed-decision', `"reason" must be a string when present, got ${typeof reason}`);
    }
    // Optional target. An abort may name the task it is giving up on, but does
    // not have to: ending a whole cycle is a legitimate scope.
    const abortTarget = raw.taskId;
    if (abortTarget !== undefined) {
      assertActive(assertKnownTask(abortTarget, observation), observation, 'abort');
    }
    return typeof reason === 'string' && reason.trim() !== ''
      ? { action: 'abort', reason }
      : { action: 'abort' };
  }

  // `rework` requires a taskId: "rework something" is not actionable, and
    // defaulting it to "the first ready task" would send work back for a reason
    // nobody chose. The absence is an explicit refusal, never a guess.
  if (implemented === 'rework') {
    if (raw.taskId === undefined) {
      throw new DecisionValidationError(
        'malformed-decision',
        'a rework must name the taskId to rework; there is no default target',
      );
    }
    // `assertKnownTask` returns the validated id as a string, which is what makes
    // these fields narrow correctly; `raw.taskId` stays `unknown` past the guard.
    const reworkTaskId = assertKnownTask(raw.taskId, observation);
    assertActive(reworkTaskId, observation, 'rework');
    const reworkReason = optionalRationale(raw);
    return reworkReason === undefined
      ? { action: 'rework', taskId: reworkTaskId }
      : { action: 'rework', taskId: reworkTaskId, reason: reworkReason };
  }

  // continue / wait may optionally name a task they refer to.
  const target = raw.taskId;
  if (target !== undefined) {
    assertActive(assertKnownTask(target, observation), observation, implemented);
  }

  const rationale = optionalRationale(raw);
  if (implemented === 'wait') {
    return rationale === undefined ? { action: 'wait' } : { action: 'wait', rationale };
  }
  return rationale === undefined ? { action: 'continue' } : { action: 'continue', rationale };
}

/**
 * Confirm `taskId` is a non-empty string naming a task in the observation.
 *
 * Returns the validated id rather than returning void, so the caller gets the
 * narrowed `string` back and does not have to re-assert a type on an `unknown`
 * that TypeScript cannot narrow through a `!== undefined` check on its own.
 */
function assertKnownTask(taskId: unknown, observation: TaskObservation): string {
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    throw new DecisionValidationError('invalid-task-id', `"taskId" must be a non-empty string, got ${JSON.stringify(taskId)}`);
  }
  if (!observation.tasks.some((t) => t.taskId === taskId)) {
    throw new DecisionValidationError('task-not-found', `no task "${taskId}" in the observed set [${observation.tasks.map((t) => t.taskId).join(', ') || 'empty'}]`);
  }
  return taskId;
}

/**
 * Refuse a decision aimed at a task that can no longer change.
 *
 * This is the state-transition check. It does not duplicate `TaskStore`'s
 * transition table — it asks the narrower question of whether the TARGET is still
 * in play, using the status the store already reports. The real transition rules
 * remain in `canTransition`, enforced by whoever performs the change; a decision
 * against a terminal task would be refused by that layer anyway, and refusing here
 * too means the report says why instead of recording a no-op.
 */
function assertActive(taskId: string, observation: TaskObservation, action: string): void {
  const task = observation.tasks.find((t) => t.taskId === taskId);
  if (task === undefined) {
    throw new DecisionValidationError('task-not-found', `no task "${taskId}"`);
  }
  if (!(ACTIVE_STATUSES as readonly string[]).includes(task.status)) {
    throw new DecisionValidationError(
      'invalid-state-transition',
      `"${action}" cannot target task "${taskId}" because it is ${task.status}, which has reached a terminal state and can no longer change`,
    );
  }
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

/**
 * What applying a decision may do.
 *
 * This is the whole of the decision brain's power, and it is small on purpose.
 * Notice what is ABSENT: no task mutation, no spawn, no runtime call, no git.
 *
 * `dispatch` is handed in by the loop and is the EXISTING `TaskScheduler.tick()`.
 * The brain cannot reach the runtime except by asking the scheduler to do what it
 * already does — it cannot start an agent on its own initiative, which is the
 * property that keeps "Laya is a decision brain" true rather than aspirational.
 */
export interface DecisionApplicationContext {
  /** The one dispatch path. Returns whether anything was actually dispatched. */
  readonly dispatch: () => Promise<boolean>;
  /** The observation the decision was validated against. */
  readonly observation: TaskObservation;
  /**
   * P6-D0: make a task dispatchable again, on its EXISTING worker assignment.
   *
   * Supplied by the D0 loop and implemented with the legal transition already in
   * the transition table (`rework -> queued`), via `TaskStore.transition`. It is a
   * capability handed to `applyDecision`, not something this module performs: the
   * decision layer still cannot reach a store, so "who may change task state" stays
   * answered by the store's own rules.
   *
   * Deliberately NOT able to change agent, model, plan or dependencies. If it
   * could, `rework` would be reassignment and replanning wearing one name.
   */
  rework?: (taskId: string, reason?: string) => Promise<{ ok: boolean; code: string; reason: string }>;
}

/**
 * Apply a validated decision.
 *
 * `continue` and `rework` MAY dispatch — through the scheduler and nothing else.
 * `wait` and `abort` NEVER dispatch: `wait` means there is nothing safe to do,
 * and dispatching anyway would be the system overriding the brain it just obeyed.
 */
export async function applyDecision(
  decision: OrchestrationDecision,
  context: DecisionApplicationContext,
): Promise<DecisionApplication> {
  if (decision.action === 'wait') {
    return {
      applied: false,
      code: 'decision-wait',
      reason: decision.rationale ?? 'the decision brain reported no safely actionable work',
    };
  }

  if (decision.action === 'abort') {
    // Ends the cycle. Nothing is cancelled, deleted or reverted, and that is the
    // point: a decision must not be able to destroy work.
    //
    // The fallback reason is this layer's own statement, not a claim about why
    // the brain chose it — the brain is not required to justify itself, because
    // requiring prose would push an unverifiable control channel into the model.
    return {
      applied: false,
      code: 'decision-abort',
      reason: decision.reason ?? 'the decision brain selected abort',
    };
  }

  // rework (P6-D0). Put the task back in a dispatchable state, then let the
  // ONE scheduler dispatch it — never execute it here.
  if (decision.action === 'rework') {
    if (context.rework === undefined) {
      return {
        applied: false,
        code: 'rework-not-available',
        reason:
          'this loop was built without a rework capability, so a rework decision cannot be carried out. ' +
          'It is refused rather than downgraded to continue, because running the task unchanged would not be ' +
          'what the decision asked for.',
      };
    }
    const prepared = await context.rework(decision.taskId, decision.reason);
    if (!prepared.ok) {
      return { applied: false, code: prepared.code, reason: prepared.reason };
    }
    const dispatched = await context.dispatch();
    return {
      applied: true,
      dispatched,
      note: dispatched
        ? `task ${decision.taskId} was returned to the queue and dispatched by the scheduler on the same worker`
        : `task ${decision.taskId} was returned to the queue; the scheduler had no free slot or nothing else was ready`,
    };
  }

  // continue
  if (context.observation.allTerminal) {
    // Every task is finished; dispatching would find nothing and could only
    // manufacture a misleading "admitted" line in the report.
    return {
      applied: false,
      code: 'nothing-to-continue',
      reason: 'every observed task is already terminal, so there is no work to continue',
    };
  }
  const dispatched = await context.dispatch();
  return {
    applied: true,
    dispatched,
    note: dispatched
      ? 'the scheduler dispatched at least one task'
      : 'the scheduler had no free slot or no ready task this tick; nothing was denied by the gate',
  };
}
