/**
 * src/orchestration/decision-loop.ts - P6-A: one decision cycle, end to end.
 *
 * WHAT THIS IS
 * ------------
 *   observe -> decide -> validate -> apply -> collect
 *
 * ONE cycle, invoked by a caller. Not a daemon, not a `while` loop, not a planner
 * that runs until the tree is done. The audit's complaint was that the loop did
 * not exist (CURRENT_STATE_AUDIT.md §7: "进入 Scheduler/Execution Bridge：没-),
 * and the honest fix is to prove the path works before automating anything. A
 * self-running loop would make its own behaviour unobservable: if a decision was
 * misread you would see "the loop did something odd" instead of "this decision
 * produced this tick".
 *
 * WHY THE BRAIN CANNOT TOUCH THE RUNTIME
 * --------------------------------------
 * `decide` is handed a function, not an orchestrator. The only capability the
 * decision brain is given is "answer which action", so there is no path from a
 * model's output to `spawnChild`, `executeTask`, `RuntimeRunner` or git. The one
 * place work actually starts is `TaskScheduler.tick()`, called by the LOOP after
 * validation, never by the brain.
 *
 * That separation is structural, not a convention. A reviewer's question -"can
 * Laya run an agent itself?" - has the answer "it cannot, there is no reference",
 * rather than "it currently chooses not to".
 *
 * THE PROVIDER SEAM
 * -----------------
 * `DecisionProvider` (src/decision/types.ts:214) is reused unchanged. It already
 * enforces the property P6-A needs most: a provider cannot return an answer
 * outside the offered space, because `laya.ts` re-validates every response against
 * the request. So the action set is declared as a `choice` question whose
 * `criteria` ARE the allowed actions - the caller declares the answer space and
 * the provider is held to it, which is the existing layer's core design rule.
 */

import { buildDispatchReceipt, type DispatchReceipt } from './dispatch-receipt.ts';
import type { DecisionProvider, DecisionRequest } from '../decision/types.ts';
import { DecisionError } from '../decision/errors.ts';
import { observeTasks, toDecisionState, type ObserveOptions, type TaskObservation } from './observation.ts';
import {
  applyDecision,
  validateDecision,
  DecisionValidationError,
  IMPLEMENTED_ACTIONS,
  ALL_ACTIONS,
  type DecisionApplication,
  type DecisionApplicationContext,
  type OrchestrationDecision,
} from './decision.ts';
import type { TaskStore } from './store.ts';
import type { TaskScheduler, TickResult } from './scheduler.ts';
import type { RunResult } from '../core/types.ts';

/**
 * Which PARAMETERS each action needs, as a machine-readable map.
 *
 * `Record<Action, readonly string[]>` rather than prose, so it cannot drift from the
 * validator: adding an action without declaring its required parameters is a compile
 * error, and a declared parameter the validator ignores shows up as a test failure
 * rather than as a field that silently arrives nowhere.
 *
 * The model is told this through `state` (see `ACTION_PARAMETERS_FIELD`), which is the
 * existing channel for "here is what you are deciding about". Without it the provider
 * has no way to know that `reassign` is more than a word, which is exactly how the
 * previous contract ended up needing a caller to attach the target by hand.
 */
export const ACTION_PARAMETERS: Record<(typeof ALL_ACTIONS)[number], readonly string[]> = {
  continue: [],
  wait: ['rationale'],
  abort: ['reason'],
  rework: ['taskId', 'reason'],
  replan: ['taskId', 'reason'],
  retry: ['taskId', 'reason'],
  reassign: ['taskId', 'reason', 'agentId', 'modelId', 'strategy'],
  add_task: ['parentTaskId', 'objective', 'taskType', 'reason'],
  split_task: ['taskId', 'into', 'reason'],
  parallelize: ['taskId', 'width', 'reason'],
  complete: ['taskId', 'reason'],
};

/**
 * The state key the parameter contract travels under.
 *
 * `Record<string, string>` because `DecisionRequest.state` is exactly that, so the
 * contract is serialised as JSON rather than needing a new field on the request type.
 */
export const ACTION_PARAMETERS_FIELD = 'action_parameters';

/** The state key `DecisionRequest.task` is merged under. */
export const ORCHESTRATION_ACTION_ID = 'next_action';

/**
 * The answer space, which is P6-D1's whole point at this layer.
 *
 * Until D1 the criteria offered exactly three actions, so the other eight existed in
 * the vocabulary but could never be answered -`retry` and `reassign` were, from the
 * provider's point of view, not choices. Every action now has a description saying
 * WHEN it applies, because the provider is held to the space it is offered and cannot
 * infer an action it was never shown.
 *
 * `Record<Action, string>` rather than a hand-written object literal, so the compiler
 * fails if a new action is added to the vocabulary and not described here. That is the
 * only way this list cannot silently drift out of date.
 */
export const ACTION_CRITERIA: Record<(typeof ALL_ACTIONS)[number], string> = {
  continue: 'there is safe work to dispatch; let the scheduler run a tick',
  wait: 'nothing can safely advance right now; dispatch nothing and wait',
  abort: 'stop this decision cycle',
  rework: 'a reviewer asked for changes to a task that ran; send that same task back on the SAME worker',
  replan: 'the plan itself is wrong; reconsider the incomplete part of a subtree',
  retry: 'a run FAILED and the task still has attempts left; give it another go on the same worker',
  reassign: 'this task should be done by a DIFFERENT agent or model. Supply taskId plus agentId and/or modelId; use strategy="assignment" ONLY if you cannot name a target yourself.',
  add_task: 'the work turned out to need one more task under an existing parent',
  split_task: 'one task is too big; replace it with several narrower tasks',
  parallelize: 'independent work should run as parallel siblings instead of in sequence',
  complete: 'a task that is awaiting verification has met its acceptance criteria; accept it',
};

export interface OrchestrationDecisionRequestOptions {
  /** Prose context for the brain. Observations, never commands. */
  readonly instructions?: string;
}

/**
 * Build the request the provider answers.
 *
 * The action set is the `criteria` of a single `choice` question, which is what
 * makes "the provider may only answer with one of these three" a property of the
 * existing Decision Layer rather than a promise this file makes. The observation
 * travels as `state`, matching the provider's `Record<string, string>` contract.
 */
export function orchestrationDecisionRequest(
  observation: TaskObservation,
  options: OrchestrationDecisionRequestOptions = {},
): DecisionRequest {
  return {
    questions: {
      [ORCHESTRATION_ACTION_ID]: {
        type: 'choice',
        instructions: options.instructions ??
          'Given the orchestration state below, which single action should the orchestrator take next?',
        criteria: ACTION_CRITERIA,
      },
    },
    state: {
      [ORCHESTRATION_ACTION_ID]: toDecisionState(observation),
      // Machine-readable, so the model can be told WHICH fields each action needs
      // instead of having to infer them from prose it may skim.
      [ACTION_PARAMETERS_FIELD]: JSON.stringify(ACTION_PARAMETERS),
    },
  };
}

/**
 * Read the action out of a validated response.
 *
 * Returns the RAW string rather than a typed decision on purpose: validation is
 * `validateDecision`'s job, and doing it here would give two places that could
 * disagree about what a valid action is. This function's only responsibility is
 * to extract a string; `validateDecision` then decides whether it may be acted on.
 */
export function extractAction(response: { answers: Record<string, { type: string; choice?: string; parameters?: Record<string, string> }> }): unknown {
  const answer = response.answers[ORCHESTRATION_ACTION_ID];
  if (answer === undefined) {
    throw new DecisionValidationError(
      'malformed-decision',
      `the provider returned no answer for "${ORCHESTRATION_ACTION_ID}"`,
    );
  }
  if (answer.type !== 'choice' || typeof answer.choice !== 'string') {
    throw new DecisionValidationError(
      'malformed-decision',
      `"${ORCHESTRATION_ACTION_ID}" must be a choice answer, got ${answer.type}`,
    );
  }
  // The provider's PARAMETERS are merged in verbatim, so a real Laya answer can carry
  // `taskId` / `agentId` / `objective` itself. That is the whole difference between a
  // production path where the brain supplies the target and one where a caller has to
  // attach it by hand - the latter was the previous shape, and it made the target a
  // hidden human choice rather than a decision.
  //
  // Anything unrecognised arrives at `validateDecision` and is refused there, so a
  // provider cannot smuggle an extra field past the validator.
  return { action: answer.choice, ...(answer.parameters ?? {}) };
}

export type DecisionOutcome =
  /** The cycle ran; here is what happened. */
  | {
      readonly status: 'ok';
      readonly observation: TaskObservation;
      /** What the provider actually answered, before validation. */
      readonly rawAction: unknown;
      /** The normalised decision, or null if validation refused it. */
      readonly decision: OrchestrationDecision | null;
      readonly application: DecisionApplication;
      /** Present only when the decision dispatched. */
      readonly tick: TickResult | null;
      /** Collected run evidence, keyed by task id, for the NEXT observation. */
      readonly results: ReadonlyMap<string, RunResult>;
    }
  /** The decision could not be trusted. Nothing was dispatched or changed. */
  | {
      readonly status: 'invalid';
      readonly observation: TaskObservation;
      readonly rawAction: unknown;
      readonly error: DecisionValidationError;
      readonly tick: null;
      readonly results: ReadonlyMap<string, RunResult>;
    }
  /** The provider itself failed or was unreachable. */
  | {
      readonly status: 'provider-unavailable';
      readonly observation: TaskObservation;
      readonly error: DecisionError | Error;
      readonly tick: null;
      readonly results: ReadonlyMap<string, RunResult>;
    };

export interface DecisionLoopOptions {
  /** The single authority. Read-only for this module. */
  readonly store: TaskStore;
  /** The single dispatch path. */
  readonly scheduler: TaskScheduler;
  /** The decision brain. Reused from `src/decision/` unchanged. */
  readonly provider: DecisionProvider;
  /** Scope the observation to one tree. */
  readonly rootTaskId?: string;
  /** Extra prose context for the request. */
  readonly instructions?: string;
  /**
   * P6-D1: the EXISTING authorities this cycle may reach.
   *
   * Injected, not constructed. `NativeWorkbench.decisionCapabilities()` supplies them
   * by composing `TaskStore`, `Assignment`, `planner-wiring` and the review loop - so
   * the loop itself learns nothing about how any of them work, and a loop wired with
   * nothing here still runs `continue`/`wait`/`abort` and refuses the other eight
   * fail-closed rather than inventing a fallback.
   *
   * Spread into the `applyDecision` context rather than wrapped, so `applyDecision`
   * remains the only thing that decides which capability a given action may use.
   */
  readonly capabilities?: Partial<DecisionApplicationContext>;
  /**
   * R2-2: read the scheduler's most recent tick, supplied by whoever injected
   * `capabilities.dispatch`.
   *
   * The loop's own `dispatch` closure is OVERRIDDEN by an injected capability (the
   * spread order below), so without this `tick`/`results` are dead fields whenever
   * capabilities are supplied - which is every production caller. Asking the owner
   * keeps this loop free of a second dispatch path while making `tick` real again.
   */
  readonly lastTick?: () => TickResult | null;
}

/**
 * Run ONE decision cycle.
 *
 * The step order is the safety property, so it is worth stating what each step is
 * NOT allowed to do:
 *
 *   observe   reads the store; cannot change anything
 *   decide    talks to the provider; has no orchestrator reference
 *   validate  pure; throws rather than guessing; cannot execute
 *   apply     may call the scheduler, and nothing else
 *   collect   reads the tick's outcomes back out for the next observation
 *
 * A validation failure returns `invalid` and stops. It does NOT fall through to
 * dispatch, because "the brain said something we cannot do" must never produce
 * motion.
 */
export async function runDecisionCycle(options: DecisionLoopOptions): Promise<DecisionOutcome> {
  const observeOptions: ObserveOptions = {
    now: Date.now(),
    ...(options.rootTaskId === undefined ? {} : { rootTaskId: options.rootTaskId }),
  };

  // 1. OBSERVE - from the authoritative store, before anything else runs.
  const observation = observeTasks(options.store, observeOptions);

  // 2. DECIDE - the provider. Its own layer validates the answer against the
  //    criteria it was offered; a transport failure is reported, not defaulted.
  let rawAction: unknown;
  try {
    const request = orchestrationDecisionRequest(
      observation,
      options.instructions === undefined ? {} : { instructions: options.instructions },
    );
    const response = await options.provider.decide(request);
    rawAction = extractAction(response);
  } catch (e) {
    if (e instanceof DecisionValidationError) {
      // The provider answered, but not with an action. Same class of problem as
      // an invalid action: refuse, dispatch nothing.
      return { status: 'invalid', observation, rawAction: null, error: e, tick: null, results: new Map() };
    }
    return {
      status: 'provider-unavailable',
      observation,
      error: e instanceof DecisionError || e instanceof Error ? e : new Error(String(e)),
      tick: null,
      results: new Map(),
    };
  }

  // 3. VALIDATE - pure, and the only place a decision becomes trustworthy.
  let decision: OrchestrationDecision;
  try {
    decision = validateDecision(rawAction, observation);
  } catch (e) {
    if (e instanceof DecisionValidationError) {
      return { status: 'invalid', observation, rawAction, error: e, tick: null, results: new Map() };
    }
    throw e;
  }

  // 4. APPLY - the only step that can cause work, and only via the capabilities.
  //
  // `capabilities` is the caller's injection of the EXISTING authorities (P6-D1). It
  // is spread rather than wrapped, so `applyDecision` still decides which capability a
  // given action may use - this module never selects one on the brain's behalf, and an
  // action with no injected capability still fails closed inside `applyDecision`.
  const collected: { tick: TickResult | null } = { tick: null };
  // R2-2. Two problems had to be fixed here, and they are the same fix.
  //
  //  1. DISPATCH TYPE. `dispatch` is `() => Promise<DispatchReceipt>` now, so the loop's
  //     own fallback projects the tick it already has instead of flattening it to a
  //     boolean that throws away WHICH tasks were admitted.
  //  2. THE DEAD PATH. `capabilities` is spread AFTER `dispatch`, so an injected
  //     capability OVERRIDES this closure. That made `tick`/`results` dead fields in
  //     every production caller, and consumers had to reach sideways into the evidence
  //     store to learn what happened.
  //
  // The injected callback is captured into `injected` BEFORE the closure is built, and
  // the closure calls THAT. Referring to `context.dispatch()` instead is infinite
  // recursion whenever no capability was injected, because then `context`'s own
  // `dispatch` IS this closure.
  const injected = options.capabilities?.dispatch;
  const dispatch = async (): Promise<DispatchReceipt> => {
    if (injected !== undefined) {
      const receipt = await injected();
      // The loop did not run the scheduler, so ask its owner what the last tick was
      // rather than running a SECOND tick, which would dispatch twice.
      if (collected.tick === null) collected.tick = options.lastTick?.() ?? null;
      return receipt;
    }
    const own = await options.scheduler.tick();
    collected.tick = own;
    return buildDispatchReceipt({ tick: own, dispatchedAt: Date.now() });
  };
  const context: DecisionApplicationContext = {
    observation,
    dispatch,
    ...(options.capabilities ?? {}),
  };
  const application = await applyDecision(decision, context);
  const tick = collected.tick;

  // 5. COLLECT - turn this tick's outcomes into evidence for the next cycle.
  //
  // Only SUCCESSFUL dispatches become evidence. A refused one has no `run` at
  // all, and inventing a synthetic "failed" result for it would put a fabricated
  // failure into the next observation.
  const results = new Map<string, RunResult>();
  if (tick !== null) {
    for (const entry of tick.outcomes) {
      if (entry.outcome.ok) results.set(entry.taskId, entry.outcome.run);
    }
  }

  return { status: 'ok', observation, rawAction, decision, application, tick, results };
}

/** The actions this cycle is able to execute. Re-exported for callers and tests. */
export const CYCLE_IMPLEMENTED_ACTIONS = IMPLEMENTED_ACTIONS;
