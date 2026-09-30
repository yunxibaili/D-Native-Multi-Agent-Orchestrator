/**
 * src/orchestration/decision-loop.ts — P6-A: one decision cycle, end to end.
 *
 * WHAT THIS IS
 * ------------
 *   observe -> decide -> validate -> apply -> collect
 *
 * ONE cycle, invoked by a caller. Not a daemon, not a `while` loop, not a planner
 * that runs until the tree is done. The audit's complaint was that the loop did
 * not exist (CURRENT_STATE_AUDIT.md §7: "进入 Scheduler/Execution Bridge：没有"),
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
 * That separation is structural, not a convention. A reviewer's question — "can
 * Laya run an agent itself?" — has the answer "it cannot, there is no reference",
 * rather than "it currently chooses not to".
 *
 * THE PROVIDER SEAM
 * -----------------
 * `DecisionProvider` (src/decision/types.ts:214) is reused unchanged. It already
 * enforces the property P6-A needs most: a provider cannot return an answer
 * outside the offered space, because `laya.ts` re-validates every response against
 * the request. So the action set is declared as a `choice` question whose
 * `criteria` ARE the allowed actions — the caller declares the answer space and
 * the provider is held to it, which is the existing layer's core design rule.
 */

import type { DecisionProvider, DecisionRequest } from '../decision/types.ts';
import { DecisionError } from '../decision/errors.ts';
import { observeTasks, toDecisionState, type ObserveOptions, type TaskObservation } from './observation.ts';
import {
  applyDecision,
  validateDecision,
  DecisionValidationError,
  IMPLEMENTED_ACTIONS,
  type DecisionApplication,
  type OrchestrationDecision,
} from './decision.ts';
import type { TaskStore } from './store.ts';
import type { TaskScheduler, TickResult } from './scheduler.ts';
import type { RunResult } from '../core/types.ts';

/** The question id the action is answered under. */
export const ORCHESTRATION_ACTION_ID = 'next_action';

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
        criteria: {
          continue: 'there is safe work to dispatch; let the scheduler run a tick',
          wait: 'nothing can safely advance right now; dispatch nothing and wait',
          abort: 'stop this decision cycle',
        },
      },
    },
    state: { [ORCHESTRATION_ACTION_ID]: toDecisionState(observation) },
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
export function extractAction(response: { answers: Record<string, { type: string; choice?: string }> }): unknown {
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
  // Only the action survives. A `choice` answer carries no rationale field in the
  // Decision Layer's contract (`DecisionAnswer` is `{ type, choice,
  // probabilities, confidence, criteria }`), so there is nothing to forward and
  // nothing is silently dropped here. `rationale` reaches a validated decision
  // only when a caller passes one to `validateDecision` directly.
  return { action: answer.choice };
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

  // 1. OBSERVE — from the authoritative store, before anything else runs.
  const observation = observeTasks(options.store, observeOptions);

  // 2. DECIDE — the provider. Its own layer validates the answer against the
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

  // 3. VALIDATE — pure, and the only place a decision becomes trustworthy.
  let decision: OrchestrationDecision;
  try {
    decision = validateDecision(rawAction, observation);
  } catch (e) {
    if (e instanceof DecisionValidationError) {
      return { status: 'invalid', observation, rawAction, error: e, tick: null, results: new Map() };
    }
    throw e;
  }

  // 4. APPLY — the only step that can cause work, and only via the scheduler.
  //
  // `collected` is the mutable cell the dispatch closure writes into. A local
  // `let tick` would not survive: TypeScript cannot see an assignment made inside
  // a callback, so it would still be narrowed to `null` afterwards and the
  // collected results would be typed away to `never`. The holder keeps the
  // assignment visible without widening anything public.
  const collected: { tick: TickResult | null } = { tick: null };
  const application = await applyDecision(decision, {
    observation,
    dispatch: async () => {
      collected.tick = await options.scheduler.tick();
      return collected.tick.admitted.length > 0;
    },
  });
  const tick = collected.tick;

  // 5. COLLECT — turn this tick's outcomes into evidence for the next cycle.
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
