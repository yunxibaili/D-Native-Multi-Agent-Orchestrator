/**
 * src/orchestration/decision.ts - P6-A: the closed action vocabulary and its validator.
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
 * payloads - which is what makes `applyDecision` total and reviewable.
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
import type { DispatchReceipt } from './dispatch-receipt.ts';
// TYPE-ONLY. A decision names a `taskType`; it never resolves one to a worker.
import type { TaskType } from '../quota/types.ts';
import { TASK_TYPES } from '../quota/types.ts';

// ---------------------------------------------------------------------------
// The frozen action vocabulary (P6 plan §11). Types are frozen HERE, in P6-A;
// each stage then implements its own actions without renaming anything.
// ---------------------------------------------------------------------------

/**
 * Actions that can actually be executed.
 *
 * `rework` was enabled by P6-D0 and `replan` by P6-C, the stage that owns each. So
 * enabling an action never added an execution path: `applyDecision` reaches both
 * through capabilities handed to it by the loop, and only after the task has been
 * moved by the store's own rules.
 */
export const IMPLEMENTED_ACTIONS = [
  'continue', 'wait', 'abort', 'rework', 'replan',
  'retry', 'reassign', 'add_task', 'split_task', 'parallelize', 'complete',
] as const;
export type ImplementedAction = (typeof IMPLEMENTED_ACTIONS)[number];

/**
 * Actions that exist in the vocabulary but belong to a later stage.
 *
 * Listed explicitly rather than inferred from a union, so "is this implemented?"
 * is a lookup rather than a guess. P6-B/D1 each remove their own.
 *
 * `retry` is still here even though it sounds like `rework`: retry means "run it
 * again because it failed", rework means "run it again because a reviewer asked
 * for changes". Only the second is implemented, and merging them would make the
 * reviewer invisible in the retry path.
 */
export const DEFERRED_ACTIONS = [
  // P6-D1 connected every remaining action, so this list is now EMPTY rather than
  // removed. Keeping the (empty) list means `allActions` still has a single place to
  // report "nothing is deferred", and the next stage that defers something has
  // somewhere obvious to put it.
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
export type ReassignStrategy =
  | { readonly kind: 'explicit' }
  | { readonly kind: 'assignment' };

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
   * Deliberately narrow. It means "stop deciding and dispatching right now" - it
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
       * free-text `reason` would push prose into the model - which is the control
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
   * plan - reassignment is P6-B and replanning is P6-C, and a decision that could
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
    }
  /**
   * Replan the INCOMPLETE part of a subtree (P6-C).
   *
   * It names a subtree, not a new plan. Producing the plan is the planner's job
   * and happens elsewhere; this asks for the subtree to be reconsidered. Keeping
   * those separate is what stops the decision layer from holding a planner.
   *
   * `taskId` names the root of the subtree to replan. It is REQUIRED: "replan
   * something" has no meaning, and defaulting it would let a decision rewrite
   * whatever happened to be at the top.
   */
  | {
readonly action: 'replan';
        readonly taskId: string;
        /** Why the plan no longer holds. Recorded, not obeyed as an instruction. */
        readonly reason?: string;
      }
    /**
     * Another attempt on the SAME worker, because a run failed (P6-D1).
     *
     * Distinct from `rework` on purpose. `rework` is a REVIEWER asking for changes
     * after a successful run; `retry` is Laya reacting to a FAILED attempt. They
     * share the task's `retryCount` so neither can exceed the other's bound, but they
     * are recorded as different events, because "the reviewer was not satisfied" and
     * "the agent crashed" call for different evidence.
     *
     * `agentId`/`modelId` are OPTIONAL and are a REQUEST, not an assignment: given,
     * they enter `Assignment` as a preference and are still subject to capability,
     * availability and quota. Absent, the task keeps whatever worker it has - which
     * is the whole point of `retry`.
     */
    | {
        readonly action: 'retry';
        readonly taskId: string;
        /** Preference only. Never a bypass of the hard filters. */
        readonly agentId?: string;
        readonly modelId?: string;
        readonly reason?: string;
      }
/**
 * How a REASSIGN picks its target worker.
 *
 * `explicit` is the default and the only one a caller should normally use: Laya names
 * the agent (and usually the model), and that is the whole point of the action.
 *
 * `assignment` exists because "this task is on the wrong worker" is sometimes all
 * Laya can honestly say - it can see that a worker is stuck but not which one would
 * do better. In THAT case the decision must SAY so. Before this discriminant existed,
 * omitting the target silently meant "let the evidence score choose", so a decision
 * that had expressed no target at all produced a specific worker anyway and the report
 * read as if Laya had picked it. An unstated preference and a stated strategy are not
 * the same decision, and only one of them is in the outcome.
 */

    /**
     * Move a task to a DIFFERENT worker (P6-D1).
     *
     * This is the action that needed a new authority: a task that has already started
     * cannot be re-pointed by `assignIdentity`, so the path runs through
     * `TaskStore.migrateIdentityAfterStart`. The decision names WHERE to go, never
     * WHETHER to go - the "should we switch" judgement is the brain's, and it has
     * already made it by emitting this.
     *
     * EXACTLY ONE TARGET MODE (DC-1):
     *   - `strategy: 'explicit'` (the default when omitted) REQUIRES `agentId` and/or
     *     `modelId`. Omitting both is refused by the validator, not defaulted.
     *   - `strategy: 'assignment'` delegates the choice to Assignment's own ranking,
     *     which is legitimate ONLY when the decision says so.
     *
     * There is deliberately no third mode in which an unstated preference becomes a
     * silent evidence-score choice: that is the hidden decision this action had, and it
     * made a reassignment look like Laya's judgement when it was a heuristic's.
     *
     * When the identity actually changes, the OLD SESSION MUST NOT be reused:
     * `SessionRegistry` refuses a cross-identity reuse, and the default is a fresh
     * native conversation on the new worker.
     */
    | {
        readonly action: 'reassign';
        readonly taskId: string;
        /** Required under `explicit`. Optional under `assignment`. */
        readonly agentId?: string;
        readonly modelId?: string;
        /**
         * How the target is chosen. Defaults to `explicit`, so the common case stays
         * terse while the delegating case has to be stated out loud.
         */
        readonly strategy?: ReassignStrategy['kind'];
        readonly reason?: string;
      }
    /**
     * Add a NEW task to the tree (P6-D1).
     *
     * Routed to the EXISTING planner: `validateCandidateDag` then `commitPlan`, which
     * writes through `TaskStore.create`. The decision does not carry a DAG - it names
     * one piece of work, and the planner decides what that means structurally.
     */
    | {
        readonly action: 'add_task';
        readonly parentTaskId: string;
        /** What the new task is for. Becomes its acceptance criteria. */
        readonly objective: string;
        readonly taskType?: TaskType;
        readonly reason?: string;
      }
    /**
     * Replace a task with a small set of narrower ones (P6-D1).
     *
     * Implemented with the existing `replanSubtree`, which already protects started
     * and finished work. A split is therefore a replan with a different shape, not a
     * new mechanism, and it cannot delete anything that has run.
     */
    | {
        readonly action: 'split_task';
        readonly taskId: string;
        /** How many pieces to split into. Bounded by the planner's own shape. */
        readonly into?: number;
        readonly reason?: string;
      }
    /**
     * Turn independent work into parallel siblings (P6-D1).
     *
     * Again a replan with a different shape: `parallel` in the existing shape
     * vocabulary, which already means "no dependencies between them". No parallel
     * executor is involved - the EXISTING scheduler dispatches siblings on its own.
     */
    | {
        readonly action: 'parallelize';
        readonly taskId: string;
        /** Sibling count. Defaults to the planner's own width. */
        readonly width?: number;
        readonly reason?: string;
      }
    /**
     * Mark the work DONE (P6-D1).
     *
     * Refused unless the named task is in `to_verify`. `applyVerification` remains
     * the only route into `succeeded`, and this does not change that - it is a
     * decision that a task HAS been verified, which the authority then checks rather
     * than trusts.
     */
    | {
        readonly action: 'complete';
        readonly taskId: string;
        readonly reason?: string;
      };

/** What the loop did with a decision. */
export type DecisionApplication =
  | {
      readonly applied: true;
      readonly dispatched: boolean;
      readonly note: string;
      /**
       * Which capability carried the decision. Present so a caller can attribute an
       * effect without re-deriving it from the action name -`rework` and `retry` both
       * dispatch, `replan` and `reassign` do not, and guessing that from the union is
       * exactly the kind of implicit coupling that breaks when a stage adds an action.
       */
      readonly via?: string;
      /**
       * B4.2a: the machine-readable reason a `continue` admitted NOTHING this tick — the
       * scheduler/gate code (`resource-unavailable`, `resource-conflict`, `no-free-slot`,
       * `tick-in-progress`, …). Absent when the decision was applied without a refusal.
       * Present so a report can preserve the ACTUAL gate refusal instead of a generic
       * "nothing was denied" claim.
       */
      readonly code?: string;
    }
  /**
   * Valid decision, but nothing to act on. Not an error.
   *
   * `dispatched` is present here too and is ALWAYS false: a refusal dispatched
   * nothing, and a caller asking "did anything run?" should not have to narrow the
   * union first to find out.
   */
  | {
      readonly applied: false;
      readonly dispatched: false;
      readonly code: string;
      readonly reason: string;
      readonly via?: string;
    };

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
 * Statuses a decision may act on - i.e. the statuses that are still IN PLAY.
 *
 * `abort` in particular is meaningless against a finished task, and accepting it
 * would let a decision look effective while changing nothing.
 *
 * `rework` was added by P6-D0, and it is the case that makes the rule subtle: a
 * task sitting in `rework` has NOT finished. It is mid-correction, and the one
 * legal move out of it (`rework -> queued`, task.ts:74) is precisely what a
 * `rework` decision asks for. Treating "not terminal" as the test - rather than an
 * explicit list of the five pre-D0 statuses - keeps this from having to be
 * revisited every time a stage un-reserves a status.
 */
// P6-D1 adds `retrying`: a failed run with budget left parks there, and `retry` is the
  // action that moves it out. Without this, a `retry` decision against a retrying task
  // would be refused as terminal - a false refusal, since `retrying` is the one state
  // `retry` exists to act on.
const ACTIVE_STATUSES = ['planned', 'queued', 'running', 'blocked', 'to_verify', 'rework', 'retrying'] as const;

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
   * The `reason` an ACTION carries, as distinct from `continue`'s `rationale`.
   *
   * Two names for one idea, and the split predates P6-D1: `rationale` is the brain's
   * note on an action that needs no justification (`continue`, `wait`), while `reason`
   * belongs to actions that change a task (`abort`, `rework`, and now the six D1 ones).
   * Reading `rationale` for an action that declares `reason` is the bug this exists to
   * prevent - it silently DROPS the reason, and a reassignment that lost its reason
   * would then be refused downstream as unexplained.
   */
  function optionalReason(raw: Record<string, unknown>): string | undefined {
    const v = raw.reason;
    if (v === undefined) return undefined;
    if (typeof v !== 'string') {
      throw new DecisionValidationError('malformed-decision', `"reason" must be a string when present, got ${typeof v}`);
    }
    return v.trim() === '' ? undefined : v;
  }

/**
 * Validate a raw decision against a live observation.
 *
 * Pure: it reads the observation and throws, and it has no reference to the
 * store, the scheduler or the runtime. That is a deliberate constraint - a
 * validator that could execute would be unable to be trusted to refuse, since its
 * own side effects would already have happened before it finished checking.
 *
 * Order matters and is chosen so the most fundamental failure is reported first:
 * shape, then vocabulary, then implementation, then target, then state. A caller
 * fixing a bug gets the root cause rather than a downstream symptom.
 */
/**
 * TeamRun T2-a.1 (§6): is this a HALF pair? Returns the reason, or null when the pair is
 * complete.
 *
 * WHY THIS IS A LOCAL SHAPE CHECK AND NOT A CALL INTO ASSIGNMENT
 * -----------------------------------------------------------
 * `validateAgentModelIntent` in `assignment.ts` is the typed definition of a valid pair,
 * and the *workbench* uses it on the initial path. This one cannot import it, and that
 * restriction is the architecture working: the decision layer may validate the SHAPE of
 * what Laya said and must never resolve it. Which pair actually exists and is available is
 * Assignment's question, and importing Assignment here would let the validator become a
 * second router — the exact thing `tests/state-loop.test.ts` guards against.
 *
 * So the two are deliberately separate: this asks "did Laya name both halves?", and
 * Assignment asks "is that pair real, available and permitted?". Neither decides the
 * other's question, and a pair that passes both is enforced exactly.
 */
function assertAtomicPair(agentId: string | undefined, modelId: string | undefined): string | null {
  if (agentId === undefined && modelId === undefined) {
    return 'neither Agent Family nor Model was named';
  }
  if (agentId === undefined) return `agentId is missing but modelId ("${modelId}") was named`;
  if (modelId === undefined) return `agentId ("${agentId}") was named but modelId is missing`;
  if (agentId.trim() === '') return 'agentId must be a non-empty string';
  if (modelId.trim() === '') return `modelId must be a non-empty string, got "${modelId}"`;
  return null;
}

export function validateDecision(raw: unknown, observation: TaskObservation): OrchestrationDecision {
  // 1. shape
  if (!isRecord(raw)) {
    throw new DecisionValidationError('malformed-decision', `expected an object, got ${Array.isArray(raw) ? 'an array' : typeof raw}`);
  }
  const action = raw.action;
  if (typeof action !== 'string' || action.trim() === '') {
    throw new DecisionValidationError('malformed-decision', `"action" must be a non-empty string, got ${JSON.stringify(action)}`);
  }

  // 2. vocabulary - is this a name we recognise at all?
  if (!(ALL_ACTIONS as readonly string[]).includes(action)) {
    throw new DecisionValidationError(
      'unknown-action',
      `"${action}" is not in the action vocabulary [${ALL_ACTIONS.join(', ')}]`,
    );
  }

  // 3. implementation - recognised, but belongs to a later stage.
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
    const reworkTaskId = assertKnownTask(raw.taskId, observation);
    assertActive(reworkTaskId, observation, 'rework');
    const reworkReason = optionalReason(raw);
    return reworkReason === undefined
      ? { action: 'rework', taskId: reworkTaskId }
      : { action: 'rework', taskId: reworkTaskId, reason: reworkReason };
  }

  // replan targets a SUBTREE, and the root of a tree is legitimately still in
  // play, so the target is checked for existence only - not `assertActive`.
  if (implemented === 'replan') {
    if (raw.taskId === undefined) {
      throw new DecisionValidationError(
        'malformed-decision',
        'a replan must name the subtree root to replan; there is no default subtree',
      );
    }
    const replanRoot = assertKnownTask(raw.taskId, observation);
    const replanReason = optionalReason(raw);
    return replanReason === undefined
      ? { action: 'replan', taskId: replanRoot }
      : { action: 'replan', taskId: replanRoot, reason: replanReason };
  }

  // ---- retry / reassign (P6-D1) ----
  //
  // Both name ONE task and may carry a worker preference. The preference is validated
  // for shape only - never resolved here, because deciding which worker can do what is
  // `Assignment`'s job and doing it here would make the validator a second router.
  if (implemented === 'retry' || implemented === 'reassign') {
    if (raw.taskId === undefined) {
      throw new DecisionValidationError(
        'malformed-decision',
        `a ${implemented} must name the taskId to ${implemented}; there is no default target`,
      );
    }
    const target = assertKnownTask(raw.taskId, observation);
    assertActive(target, observation, implemented);
    const agentId = optionalWorker(raw.agentId, 'agentId');
    const modelId = optionalWorker(raw.modelId, 'modelId');
    const why = optionalReason(raw);
    if (implemented === 'retry') {
      // `retry` keeps the existing worker by definition, so a target here would be a
      // reassignment wearing the wrong name. Refused rather than silently applied.
      if (agentId !== undefined || modelId !== undefined) {
        throw new DecisionValidationError(
          'invalid-worker-reference',
          'a retry keeps the task\'s existing worker; use reassign to change agent or model',
        );
      }
      return why === undefined
        ? { action: 'retry', taskId: target }
        : { action: 'retry', taskId: target, reason: why };
    }
// DC-1: a reassign must say WHICH MODE it is in. An unstated target used to mean
    // "Assignment picks by evidence score", which is a heuristic making the decision -
    // so it is now an explicit `strategy` and omitting both target and strategy is
    // refused with a message that names the two legal ways out.
    const strategy = optionalStrategy(raw.strategy);
    if (strategy !== 'assignment' && agentId === undefined && modelId === undefined) {
      throw new DecisionValidationError(
        'reassign-target-required',
        'a reassign must name the target agent and/or model, or set strategy:"assignment" to ' +
          'delegate the choice to Assignment. Omitting both is refused rather than defaulted, ' +
          'because letting the evidence score choose would make the outcome look like Laya\'s ' +
          'judgement when it was a heuristic\'s.',
      );
    }
    // TeamRun T2-a.1 (§6/§14): under `explicit` — the default, and the mode that claims
    // Laya chose this target — the pair is ATOMIC. `agentId` alone used to be accepted and
    // Assignment filled in the model, which is a partial Laya choice silently completed by
    // a heuristic: exactly the degradation this closes.
    //
    // `strategy:"assignment"` is a DIFFERENT, already-named meaning — Laya deliberately
    // delegating the choice — so it is untouched. Switching model on the same family is
    // still expressible, by naming BOTH halves.
    if (strategy !== 'assignment') {
      const half = assertAtomicPair(agentId, modelId);
      if (half !== null) {
        throw new DecisionValidationError(
          'invalid-worker-reference',
          `a Laya reassign is an ATOMIC Agent x Model pair: ${half}. ` +
            'Name both halves, or set strategy:"assignment" to delegate the whole choice to Assignment.',
        );
      }
    }
    const base = {
      action: 'reassign' as const,
      taskId: target,
      ...(agentId !== undefined ? { agentId } : {}),
      ...(modelId !== undefined ? { modelId } : {}),
      ...(strategy !== undefined ? { strategy } : {}),
      ...(why !== undefined ? { reason: why } : {}),
    };
    return base;
  }

  // ---- add_task (P6-D1) ----
  //
  // The only action that names a PARENT and carries the work itself. `objective` is
  // required: a task added without one would have no acceptance criteria, and
  // `createTask` refuses those for exactly that reason - better to be explicit here
  // than to let the write fail with a less obvious message.
  if (implemented === 'add_task') {
    if (raw.parentTaskId === undefined) {
      throw new DecisionValidationError('malformed-decision', 'an add_task must name the parentTaskId to add work under');
    }
    if (typeof raw.objective !== 'string' || raw.objective.trim() === '') {
      throw new DecisionValidationError(
        'malformed-decision',
        'an add_task must carry a non-empty objective: a task with no success condition cannot reach to_verify',
      );
    }
    // The parent must exist and must still be live - adding work under a finished
    // parent would create a child that can never be completed as part of that tree.
    assertActive(assertKnownTask(raw.parentTaskId, observation), observation, 'add_task');
    const wanted = raw.taskType;
    if (wanted !== undefined && !isTaskType(wanted)) {
      throw new DecisionValidationError('invalid-task-type', `"taskType" must be a known TaskType, got ${JSON.stringify(wanted)}`);
    }
    const why = optionalReason(raw);
    return {
      action: 'add_task',
      parentTaskId: raw.parentTaskId as string,
      objective: raw.objective.trim(),
      ...(wanted !== undefined ? { taskType: wanted as TaskType } : {}),
      ...(why !== undefined ? { reason: why } : {}),
    };
  }

  // ---- split_task / parallelize / complete (P6-D1) ----
  //
  // All three name one live task. They differ only in the optional count they carry,
  // which is why they share one validator: `into` and `width` are both "how many
  // pieces", bounded to a positive integer here so the planner never has to defend
  // against `0` or a fractional width arriving from a model.
  if (implemented === 'split_task' || implemented === 'parallelize' || implemented === 'complete') {
    if (raw.taskId === undefined) {
      throw new DecisionValidationError(
        'malformed-decision',
        `a ${implemented} must name the taskId it applies to; there is no default target`,
      );
    }
    const target = assertKnownTask(raw.taskId, observation);
    // `complete` requires `to_verify` specifically: it is the one action that asserts
    // the work is done, and `applyVerification` will refuse anything else. Checking
    // here means the decision is rejected at validation rather than surfacing as an
    // authority refusal three layers later.
    if (implemented === 'complete') {
      const t = observation.tasks.find((x) => x.taskId === target);
      if (t !== undefined && t.status !== 'to_verify') {
        throw new DecisionValidationError(
          'invalid-state-transition',
          `complete requires task "${target}" to be awaiting verification, but it is ${t.status}`,
        );
      }
    } else {
      assertActive(target, observation, implemented);
    }
    const why = optionalReason(raw);
    const count = optionalCount(implemented === 'split_task' ? raw.into : raw.width);
    if (implemented === 'split_task') {
      return count === undefined
        ? { action: 'split_task', taskId: target, ...(why !== undefined ? { reason: why } : {}) }
        : { action: 'split_task', taskId: target, into: count, ...(why !== undefined ? { reason: why } : {}) };
    }
    if (implemented === 'parallelize') {
      return count === undefined
        ? { action: 'parallelize', taskId: target, ...(why !== undefined ? { reason: why } : {}) }
        : { action: 'parallelize', taskId: target, width: count, ...(why !== undefined ? { reason: why } : {}) };
    }
    return { action: 'complete', taskId: target, ...(why !== undefined ? { reason: why } : {}) };
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
/**
 * A worker reference from a decision: a non-empty string, or absent.
 *
 * Shape-checked ONLY. Whether that agent can do the task, is available, has quota, or
 * is even a real agent is `Assignment`'s problem - validating it here would make this
 * function a second capability filter, and a decision layer that filters workers is
 * the routing engine this architecture refuses to grow.
 */
function optionalWorker(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DecisionValidationError('invalid-worker-reference', `"${field}" must be a non-empty string when present, got ${JSON.stringify(value)}`);
  }
  return value.trim();
}

/** A piece count from a decision: a positive integer, or absent. */
function optionalCount(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new DecisionValidationError(
      'invalid-piece-count',
      `a piece count must be an integer >= 1 when present, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** A reassign strategy name, closed over the two legal values. */
function optionalStrategy(value: unknown): 'explicit' | 'assignment' | undefined {
  if (value === undefined) return undefined;
  if (value !== 'explicit' && value !== 'assignment') {
    throw new DecisionValidationError(
      'invalid-strategy',
      `"strategy" must be "explicit" or "assignment" when present, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Whether a value is one of the quota layer's `TaskType`s. A closed check, not a cast. */
function isTaskType(value: unknown): value is TaskType {
  return typeof value === 'string' && (TASK_TYPES as readonly string[]).includes(value);
}

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
 * transition table - it asks the narrower question of whether the TARGET is still
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
 * already does - it cannot start an agent on its own initiative, which is the
 * property that keeps "Laya is a decision brain" true rather than aspirational.
 */
export interface DecisionApplicationContext {
  /**
   * The one dispatch path. Returns the ADMISSION RECEIPT (section5.4) - never a bare
   * boolean.
   *
   * A oolean here let any injected capability silently erase the loop's own
   * dispatch (the spread order in unDecisionCycle means the caller's
   * dispatch overrides the loop's), so 	ick became dead code and consumers had
   * to reach into the evidence store to learn what happened. A receipt cannot be
   * flattened, and a caller that only wants a yes/no derives it from the receipt
   * itself: eceipt.admitted.length > 0.
   */
  readonly dispatch: () => Promise<DispatchReceipt>;
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
  /**
   * P6-C: replan the incomplete part of a subtree.
   *
   * Supplied by the loop and implemented by `planner-wiring.replanSubtree`, which
   * validates the whole new graph before touching the old one and can only reach
   * the store's own mutation methods. Deliberately not able to cancel, dispatch,
   * assign or verify: replanning changes the PLAN, and everything else about a
   * running system stays exactly as it was.
   */
replan?: (taskId: string, reason?: string) => Promise<{ ok: boolean; code: string; reason: string }>;

    // ---- P6-D1: the remaining actions, each an EXISTING authority ----
    //
    // Every one of these is optional and every refusal when it is absent is
    // fail-closed with the action's OWN name in the code. That is the whole design
    // rule for this stage: a loop that cannot do something says so rather than
    // downgrading to `continue`, because quietly running unchanged work after the
    // brain asked for a migration is the opposite of what was requested - and far
    // harder to notice than a refusal.

    /**
     * Another attempt on the same worker, via `Orchestrator.retry`.
     *
     * The bound lives in the authority, not here: a capability that "just retries"
     * would let the loop ask again on the next tick forever.
     */
    retry?: (req: {
      taskId: string;
      agentId?: string;
      modelId?: string;
      reason?: string;
    }) => Promise<{ ok: boolean; code: string; reason: string }>;

    /**
     * Move a started task to a different worker.
     *
     * Implemented as `Assignment` (candidate) -`TaskStore.migrateIdentityAfterStart`
     * (commit). Assignment still proposes; the store still writes. Deliberately not
     * able to dispatch: the next tick does that.
     */
    reassign?: (req: {
      taskId: string;
      agentId?: string;
      modelId?: string;
      /** Which target mode the decision chose (DC-1). `undefined` means `explicit`. */
      strategy?: 'explicit' | 'assignment';
      reason?: string;
    }) => Promise<{ ok: boolean; code: string; reason: string }>;

    /**
     * Add a task through the EXISTING planner (`validateCandidateDag` -`commitPlan`).
     *
     * Not able to write a task directly: the planner's validate-all-then-commit is
     * what stops a decision from leaving a half-built graph behind.
     */
    addTask?: (req: {
      parentTaskId: string;
      objective: string;
      taskType?: TaskType;
      reason?: string;
    }) => Promise<{ ok: boolean; code: string; reason: string }>;

    /** Split a task, via the existing `replanSubtree` with a narrower shape. */
    splitTask?: (req: {
      taskId: string;
      into?: number;
      reason?: string;
    }) => Promise<{ ok: boolean; code: string; reason: string }>;

    /** Parallelise a subtree, via the existing `replanSubtree` with `parallel`. */
    parallelize?: (req: {
      taskId: string;
      width?: number;
      reason?: string;
    }) => Promise<{ ok: boolean; code: string; reason: string }>;

    /**
     * Mark a task done - which still means going through `applyVerification`.
     *
     * This capability exists so `complete` can be an ACTION without becoming a
     * second verification authority: it carries no verdict, it asks the existing one
     * to accept, and the existing one still checks that the task is actually in
     * `to_verify`.
     */
    complete?: (req: { taskId: string; reason?: string }) => Promise<{ ok: boolean; code: string; reason: string }>;
  }

/**
 * Apply a validated decision.
 *
 * `continue` and `rework` MAY dispatch - through the scheduler and nothing else.
 * `wait` and `abort` NEVER dispatch: `wait` means there is nothing safe to do,
 * and dispatching anyway would be the system overriding the brain it just obeyed.
 */
export async function applyDecision(
    decision: OrchestrationDecision,
    context: DecisionApplicationContext,
  ): Promise<DecisionApplication> {
    /**
     * One refusal for every missing capability.
     *
     * Centralised so all six new actions fail the SAME way, and so the wording cannot
     * drift into something that sounds like a fallback. Each name is quoted rather
     * than described: a caller reading `retry-not-available` must be able to tell
     * which of the eleven actions was declined.
     */
    const unavailable = (action: string, what: string): DecisionApplication => ({
      applied: false,
      dispatched: false,
      via: action,
      code: `${action}-not-available`,
      reason:
        `this loop was built without a "${action}" capability, so the decision to do ${what} cannot be ` +
        `carried out. It is refused rather than downgraded to continue, because running the work unchanged ` +
        `after the brain asked for something else is the opposite of what was requested - and much harder ` +
        `to notice than a refusal.`,
    });

    if (decision.action === 'wait') {
    return {
      applied: false,
      dispatched: false,
      via: 'wait',
      code: 'decision-wait',
      reason: decision.rationale ?? 'the decision brain reported no safely actionable work',
    };
  }

  if (decision.action === 'abort') {
    // Ends the cycle. Nothing is cancelled, deleted or reverted, and that is the
    // point: a decision must not be able to destroy work.
    //
    // The fallback reason is this layer's own statement, not a claim about why
    // the brain chose it - the brain is not required to justify itself, because
    // requiring prose would push an unverifiable control channel into the model.
    return {
      applied: false,
      dispatched: false,
      via: 'abort',
      code: 'decision-abort',
      reason: decision.reason ?? 'the decision brain selected abort',
    };
  }

  // rework (P6-D0). Put the task back in a dispatchable state, then let the
  // ONE scheduler dispatch it - never execute it here.
  if (decision.action === 'rework') {
    if (context.rework === undefined) return unavailable('rework', 'a task being returned for another attempt');
    const prepared = await context.rework(decision.taskId, decision.reason);
    if (!prepared.ok) {
      return { applied: false, dispatched: false, via: 'rework', code: prepared.code, reason: prepared.reason };
    }
    const receipt = await context.dispatch();
    const dispatched = receipt.admitted.length > 0;
    return {
      applied: true,
      dispatched,
      via: decision.action,
      note: dispatched
        ? `task ${decision.taskId} was returned to the queue and dispatched by the scheduler on the same worker`
        : `task ${decision.taskId} was returned to the queue; the scheduler had no free slot or nothing else was ready`,
    };
  }

  // replan (P6-C). Unlike rework, this does NOT dispatch afterwards: a replan
  // changes what the plan is, and the NEXT tick decides what runs. Dispatching here
  // would let a decision start work before the new graph had been validated by
  // anyone.
  if (decision.action === 'replan') {
    if (context.replan === undefined) return unavailable('replan', 'a subtree being reconsidered');
    const done = await context.replan(decision.taskId, decision.reason);
    if (!done.ok) return { applied: false, dispatched: false, via: decision.action, code: done.code, reason: done.reason };
    return {
      applied: true,
      dispatched: false,
      via: decision.action,
      note: `subtree ${decision.taskId} was replanned; nothing is dispatched until the next tick`,
    };
  }

  // ---- retry (P6-D1) ----
  //
  // Like `rework`, this re-enters the task and then lets the ONE scheduler dispatch
  // it. The difference is the authority behind it and the bound: rework answers to a
  // reviewer's verdict under `maxAttempts`; retry answers to a failed run under
  // `maxRetries`, and both count on the task's single `retryCount`.
  if (decision.action === 'retry') {
    if (context.retry === undefined) return unavailable('retry', 'a failed run being given another attempt');
    const done = await context.retry({
      taskId: decision.taskId,
      ...(decision.agentId !== undefined ? { agentId: decision.agentId } : {}),
      ...(decision.modelId !== undefined ? { modelId: decision.modelId } : {}),
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    });
    if (!done.ok) return { applied: false, dispatched: false, via: decision.action, code: done.code, reason: done.reason };
    const receipt = await context.dispatch();
    const dispatched = receipt.admitted.length > 0;
    return {
      applied: true,
      dispatched,
      via: decision.action,
      note: dispatched
        ? `task ${decision.taskId} was retried and dispatched by the scheduler`
        : `task ${decision.taskId} was returned to the queue; the scheduler had no free slot this tick`,
    };
  }

  // ---- reassign (P6-D1) ----
  //
  // Does NOT dispatch. Moving a task to a different worker changes what the next run
  // will be; dispatching inside the same step would start that run before the
  // migration was observable anywhere, and the identity-mismatch guard on sessions
  // deserves a tick boundary to be honoured on.
  if (decision.action === 'reassign') {
    if (context.reassign === undefined) return unavailable('reassign', 'a task moving to a different worker');
    const done = await context.reassign({
      taskId: decision.taskId,
      ...(decision.agentId !== undefined ? { agentId: decision.agentId } : {}),
      ...(decision.modelId !== undefined ? { modelId: decision.modelId } : {}),
      ...(decision.strategy !== undefined ? { strategy: decision.strategy } : {}),
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    });
    if (!done.ok) return { applied: false, dispatched: false, via: decision.action, code: done.code, reason: done.reason };
    return {
      applied: true,
      dispatched: false,
      via: decision.action,
      // The note names WHICH mode ran, so a report reader can tell "Laya picked this
      // worker" from "Laya delegated and Assignment's ranking decided". DC-1 exists
      // because those used to be indistinguishable in the output.
      note: `task ${decision.taskId} moved to a new worker (target: ${decision.strategy === 'assignment' ? 'delegated to assignment' : 'named by the decision'}); ` +
        'the next tick dispatches it on a fresh native session',
    };
  }

  // ---- add_task (P6-D1) ----
  //
  // The decision names ONE piece of work; the existing planner decides what that
  // means structurally. No dispatch either - a new task is planned, not started.
  if (decision.action === 'add_task') {
    if (context.addTask === undefined) return unavailable('add_task', 'new work being added to the tree');
    const done = await context.addTask({
      parentTaskId: decision.parentTaskId,
      objective: decision.objective,
      ...(decision.taskType !== undefined ? { taskType: decision.taskType } : {}),
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    });
    if (!done.ok) return { applied: false, dispatched: false, via: decision.action, code: done.code, reason: done.reason };
    return {
      applied: true,
      dispatched: false,
      via: decision.action,
      note: `a task was added under ${decision.parentTaskId}; the next tick decides whether it runs`,
    };
  }

  // ---- split_task / parallelize (P6-D1) ----
  //
  // Both are `replanSubtree` with a different shape. Grouped because they share the
  // refusal text and, more importantly, the same protection: that function is what
  // refuses to remove anything already started or finished.
  if (decision.action === 'split_task' || decision.action === 'parallelize') {
    const cap = decision.action === 'split_task' ? context.splitTask : context.parallelize;
    if (cap === undefined) {
      return unavailable(decision.action, decision.action === 'split_task'
        ? 'a task being replaced by narrower tasks'
        : 'independent work being run in parallel');
    }
    const done = await cap(decision.action === 'split_task'
      ? {
          taskId: decision.taskId,
          ...(decision.into !== undefined ? { into: decision.into } : {}),
          ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
        }
      : {
          taskId: decision.taskId,
          ...(decision.width !== undefined ? { width: decision.width } : {}),
          ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
        });
    if (!done.ok) return { applied: false, dispatched: false, via: decision.action, code: done.code, reason: done.reason };
    return {
      applied: true,
      dispatched: false,
      via: decision.action,
      note: `subtree ${decision.taskId} was ${decision.action === 'split_task' ? 'split' : 'parallelised'} through the existing replan path; nothing is dispatched until the next tick`,
    };
  }

  // ---- complete (P6-D1) ----
  if (decision.action === 'complete') {
    if (context.complete === undefined) return unavailable('complete', 'a verified task being marked done');
    const done = await context.complete({ taskId: decision.taskId, ...(decision.reason !== undefined ? { reason: decision.reason } : {}) });
    if (!done.ok) return { applied: false, dispatched: false, via: decision.action, code: done.code, reason: done.reason };
    return { applied: true, dispatched: false, note: `task ${decision.taskId} was verified as done` };
  }

  // continue
  if (context.observation.allTerminal) {
    // Every task is finished; dispatching would find nothing and could only
    // manufacture a misleading "admitted" line in the report.
    return {
      applied: false,
      dispatched: false,
      via: 'continue',
      code: 'nothing-to-continue',
      reason: 'every observed task is already terminal, so there is no work to continue',
    };
  }
  const receipt = await context.dispatch();
  const dispatched = receipt.admitted.length > 0;
  if (dispatched) {
    return { applied: true, dispatched, note: 'the scheduler dispatched at least one task' };
  }
  /*
   * B4.2a: nothing was admitted — say WHY, from the receipt's own facts.
   *
   * The old note claimed "no free slot or no ready task; nothing was denied by the gate"
   * unconditionally, so a real refusal (`resource-unavailable` on a non-git workspace, or a
   * `resource-conflict`) was reported as if the gate had denied nothing. That erased the one
   * fact an operator needs. The receipt already carries the scheduler's `skipped` entries
   * (code + reason) and `waiting`; this reports them instead of guessing, and separates
   * "waiting for a dependency / capacity" from "refused by the gate".
   */
  const refusals = receipt.skipped.filter((s) => s.taskId !== '*');
  if (refusals.length > 0) {
    const detail = refusals.map((s) => `${s.taskId}: ${s.code} (${s.reason})`).join('; ');
    return {
      applied: true,
      dispatched: false,
      code: refusals[0]!.code,
      note: `the scheduler admitted nothing this tick; the gate refused: ${detail}`,
    };
  }
  const reentrant = receipt.skipped.find((s) => s.taskId === '*');
  if (reentrant !== undefined) {
    return { applied: true, dispatched: false, code: reentrant.code, note: `the scheduler admitted nothing this tick: ${reentrant.reason}` };
  }
  if (receipt.waiting.length > 0) {
    return {
      applied: true,
      dispatched: false,
      code: 'no-free-slot',
      note: `the scheduler admitted nothing this tick: ${receipt.waiting.length} task(s) are ready but there is no free slot`,
    };
  }
  return { applied: true, dispatched: false, note: 'the scheduler admitted nothing this tick: no ready task, and nothing was denied by the gate' };
}
