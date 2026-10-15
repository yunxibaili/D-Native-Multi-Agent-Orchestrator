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
import type { DecisionProvider, DecisionRequest, DecisionResponse } from '../decision/types.ts';
import { DecisionError } from '../decision/errors.ts';
import { layaMetadata } from '../decision/laya.ts';
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
 * B4.0b: the `state` key carrying acceptance material for `complete`.
 *
 * A separate key rather than a wider `next_action` blob, so the status projection's
 * shape (and every reader of it) is unchanged, and so a reader can tell "the brain was
 * given evidence" from "the brain was not" without inspecting the contents.
 */
export const ACCEPTANCE_MATERIAL_FIELD = 'acceptance_material';

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
  /**
   * B4.0b: the material a `complete` judgement is actually MADE from.
   *
   * The observation is STATUS ONLY - it says a task reached `to_verify`, not whether
   * the run met the criteria. A brain asked to accept on that alone is being asked to
   * guess, and this seam is what stops the guess from being the only option.
   *
   * Deliberately a narrow, caller-built projection rather than a new subsystem: no
   * second authority, no evidence store, no transcript. It carries the objective, and
   * for each awaiting-verification task ONLY that same task's criteria and the bounded
   * output of the run correlated to its OWN attempt. Absent means the caller chose not
   * to supply it, which is the pre-B4.0b behaviour and stays supported.
   */
  readonly acceptanceMaterial?: AcceptanceMaterial;
}

/**
 * One task's acceptance evidence, for the single task a `complete` decision is about.
 *
 * Every field is a FACT or an explicit absence. `unknown*` flags exist so a missing
 * fact is reported as missing rather than silently read as a pass.
 */
export interface AcceptanceMaterialEntry {
  readonly taskId: string;
  readonly taskType: string;
  /** The criteria THIS task was created with. Never another task's. */
  readonly acceptanceCriteria: string;
  /** The attempt this task's own execution produced, when one is known. */
  readonly attemptId: string | null;
  readonly agentId: string | null;
  readonly modelId: string | null;
  /** Byte-bounded tail of assistant text for THIS run. `''` when there is no run. */
  readonly output: string;
  /** `RunResult.outputTruncated`, propagated so a partial read is never a full one. */
  readonly outputTruncated: boolean;
  /** True when this material was bounded further for the request. */
  readonly boundedForRequest: boolean;
  /** Reference to the full material. The transcript is NOT copied into the request. */
  readonly transcriptPath: string | null;
  readonly artifacts: readonly string[];
  /** Terminal state of this run, or `null` when no run is known. */
  readonly runState: string | null;
  readonly exitCode: number | null;
  /** Why this run failed, when it did. */
  readonly runError: { readonly code: string; readonly message: string } | null;
  /** No attempt/RunResult could be paired for this task. Explicit, never blank. */
  readonly executionMissing: boolean;
  /** No acceptance criteria were recorded for this task. */
  readonly acceptanceCriteriaMissing: boolean;
}

export interface AcceptanceMaterial {
  /** The original objective the round was asked to accomplish. */
  readonly objective: string;
  /** Tasks awaiting verification. Same-task entries only. */
  readonly entries: readonly AcceptanceMaterialEntry[];
}

/**
 * LAYA-ACTION.1: how a BOUNDED workflow choice key names its target.
 *
 * The same separator `initial-assignment.ts` uses: a value that cannot occur
 * inside an action name or a task id, so a key is unambiguous. Crucially, keys
 * are NEVER decoded here — a chosen key is resolved by MEMBERSHIP in the
 * immutable snapshot built for the SAME request, so a key nobody offered (or an
 * invented target) fails closed rather than being parsed into a target.
 */
const BOUND_TARGET_KEY_SEPARATOR = '\u0000';

/** One action a bounded request offers, and the payload its key stands for. */
interface BoundActionCandidate {
  readonly key: string;
  readonly action: 'continue' | 'wait' | 'abort' | 'complete';
  /** The task a `complete` binds to. `null` for the targetless actions. */
  readonly taskId: string | null;
  readonly description: string;
}

/**
 * The same-task acceptance entry that makes a `to_verify` task eligible for a
 * `complete` candidate, or `null` when the evidence is missing/empty/foreign.
 *
 * Presence only: this is a boundary check, NOT a judgement. It can say "there is
 * a same-task execution and an acceptance criterion to judge", never "the work
 * was good" — that judgement stays LAYA's, and `validateDecision` and the
 * verification authority remain the final check.
 */
function completeCandidateEntry(
  material: AcceptanceMaterial,
  task: TaskObservation['tasks'][number],
): AcceptanceMaterialEntry | null {
  const entry = material.entries.find((e) => e.taskId === task.taskId);
  if (entry === undefined) return null;
  if (entry.taskType !== task.taskType) return null;
  if (entry.executionMissing) return null;
  if (entry.acceptanceCriteriaMissing) return null;
  if (entry.acceptanceCriteria.trim() === '') return null;
  if (entry.output.trim() === '') return null;
  return entry;
}

/**
 * The small, supported action space for a bounded workflow decision.
 *
 * LAYA-QUALITY.1: `continue` is targetless like `wait`/`abort`, but UNLIKE them it
 * is offered only when the observation names a dispatchable child
 * (`observation.ready`, already derived by observation.ts from the same facts the
 * scheduler uses). With no ready child the action could not dispatch, so the model
 * is never handed a no-op; a key that was not offered fails closed against this
 * snapshot. `complete` is offered once per eligible `to_verify` task: the key binds
 * the action AND its task, so a provider cannot name a task that was not on the
 * table. When exactly one task is eligible the key is the bare `complete` (there is
 * nothing to disambiguate); when several are, each gets a distinct opaque key.
 */
function boundActionCandidates(
  observation: TaskObservation,
  material: AcceptanceMaterial,
): BoundActionCandidate[] {
  const candidates: BoundActionCandidate[] = [];
  // No ready child means no dispatch edge for `continue` to reach, so it is simply
  // not on the table. `wait` and `abort` always are.
  if (observation.ready.length > 0) {
    candidates.push({ key: 'continue', action: 'continue', taskId: null, description: ACTION_CRITERIA.continue });
  }
  candidates.push({ key: 'wait', action: 'wait', taskId: null, description: ACTION_CRITERIA.wait });
  candidates.push({ key: 'abort', action: 'abort', taskId: null, description: ACTION_CRITERIA.abort });
  const eligible = observation.tasks.filter(
    (t) => t.status === 'to_verify' && completeCandidateEntry(material, t) !== null,
  );
  const single = eligible.length === 1;
  for (const task of eligible) {
    const entry = completeCandidateEntry(material, task);
    if (entry === null) continue;
    candidates.push({
      key: single ? 'complete' : `complete${BOUND_TARGET_KEY_SEPARATOR}${task.taskId}`,
      action: 'complete',
      taskId: task.taskId,
      description:
        `accept task "${task.taskId}" (${task.taskType}) only if the SAME task's own acceptance ` +
        `material shows its own execution met its criteria; never accept on status alone. ` +
        `Criteria: ${entry.acceptanceCriteria}`,
    });
  }
  return candidates;
}

/**
 * LAYA-CONTEXT.1: the compact `next_action` status projection for a bounded request.
 *
 * The full `toDecisionState()` view is deliberately rich for the general
 * vocabulary (dependencies, retries, staleness, generations, artifact counts).
 * The bounded workflow decision reads none of that: its whole space is
 * continue/wait/abort plus one `complete` key per eligible `to_verify` task,
 * and the evidence a `complete` judgement is made from travels in the SEPARATE
 * acceptance-material key. Carrying the rich view anyway is what pushed the
 * installed english checkpoint's 512-token bound into right-truncation, dropping
 * the material entirely (observed: 701 state tokens, 318 retained,
 * acceptance_material absent).
 *
 * So the bounded projection keeps the facts a real choice needs — the task
 * statuses and the ready/running/blocked/awaiting sets — and drops the
 * provenance/duplication that is already stated per-entry in the material.
 * Same-task identity (taskId) and status survive; a task's agent/model/type,
 * dependencies, retries, staleness and artifact counts do not.
 *
 * This compacts the model-facing PROJECTION only. The authoritative
 * observation, the candidate snapshot and the material records remain whole.
 */
function compactNextActionState(observation: TaskObservation): string {
  return JSON.stringify({
    rootTaskId: observation.rootTaskId,
    ready: observation.ready,
    running: observation.running,
    blocked: observation.blocked,
    awaitingVerification: observation.awaitingVerification,
    tasks: observation.tasks.map((t) => ({ taskId: t.taskId, status: t.status })),
  });
}

/**
 * LAYA-CONTEXT.1: the compact acceptance material for a bounded request.
 *
 * The objective and BOTH (all) same-task entries are kept EXACTLY — criteria,
 * output (multiline/unicode/tail included) and the essential honesty flags.
 * Provenance that is not judged on (attemptId, agentId, modelId, taskType,
 * transcriptPath, artifacts, runState, exitCode, runError) is dropped from the
 * model-facing projection; those facts remain in the authoritative material and
 * attempt/result stores. No field is summarised and no output is sliced here:
 * a value the caller wants bounded is bounded by the caller, and the
 * `outputTruncated`/`boundedForRequest` flags keep that visible to the model.
 */
function compactAcceptanceMaterial(material: AcceptanceMaterial): string {
  return JSON.stringify({
    objective: material.objective,
    entries: material.entries.map((e) => ({
      taskId: e.taskId,
      acceptanceCriteria: e.acceptanceCriteria,
      output: e.output,
      executionMissing: e.executionMissing,
      acceptanceCriteriaMissing: e.acceptanceCriteriaMissing,
      outputTruncated: e.outputTruncated,
      boundedForRequest: e.boundedForRequest,
    })),
  });
}

/**
 * LAYA-CONTEXT.1: the conservative shared refusal bound for the supported native checkpoints.
 *
 * The installed LAYA 0.3.21 `english` checkpoint pins `max_len` 512 (`head_max_len`
 * 192); `multilingual` pins `max_len` 1024 (`head_max_len` 256). Each right-cuts the
 * composed sequence at its OWN `max_len`.
 *
 * This guard refuses at ONE bound — the english `max_len` of 512 — applied to BOTH
 * checkpoints. That is deliberately stricter for `multilingual`, whose own capacity is
 * larger: it is a conservative shared floor, NOT a claim that both checkpoints truncate
 * at 512. The boundary is ambiguous — a request exactly at the bound may or may not have
 * content dropped — so it refuses AT the bound rather than assuming the retained prefix
 * was sufficient. No other configured budget or checkpoint is detected; an unlisted
 * checkpoint is refused outright.
 */
const BOUNDED_NATIVE_SUPPORTED_CHECKPOINTS: ReadonlySet<string> = new Set(['english', 'multilingual']);
const BOUNDED_NATIVE_INPUT_BUDGET = 512;

/**
 * LAYA-CONTEXT.1: fail-closed visibility defence for a bounded native decision.
 *
 * WHAT IT CAN SEE. The only token-visibility signal available AFTER a real
 * response is the provider's own `usage.input_tokens`, read through the
 * EXISTING `layaMetadata()` reader. TypeScript cannot compute this count before
 * sending (there is no tokenizer here, and inventing a chars-per-token constant
 * would be a fake guarantee), so this is a post-response refusal, not a
 * pre-send bound. It consumes a decision request, then refuses to act.
 *
 * WHAT IT REFUSES, for a bounded request answered by the native provider:
 *   - an unknown/unsupported checkpoint (only english/multilingual are covered);
 *   - missing / null / nonpositive / non-finite token metadata, because
 *     "could not see whether it fit" must not read as "it fit";
 *   - saturation at or past the conservative shared bound, because the boundary
 *     is ambiguous and the state may have been right-truncated.
 *
 * WHAT IT DOES NOT DO: it never retries, never dispatches, never mutates, never
 * falls back to a default `complete`, and never treats a status as a pass.
 *
 * Generic non-LAYA seams are untouched: a provider whose answer did not come
 * from Laya has no such budget metadata and keeps its existing behaviour, and
 * the legacy (no-material) parameter path is never guarded here.
 *
 * EVIDENCE HONESTY: the unit fixtures that exercise this guard supply
 * EXPLICITLY CONTROLLED metadata; that is a test of the guard's logic, not a
 * real tokenizer measurement of any request.
 */
function assertBoundedNativeVisibility(response: DecisionResponse): void {
  if (response.provider.name !== 'laya') return;
  const meta = layaMetadata(response);

  if (!BOUNDED_NATIVE_SUPPORTED_CHECKPOINTS.has(meta.checkpoint)) {
    throw new DecisionValidationError(
      'unsupported-native-checkpoint',
      `the bounded workflow request was answered by native checkpoint ${JSON.stringify(meta.checkpoint)}, but ` +
        `only english/multilingual are the currently verified configs; an unverified checkpoint's budget cannot ` +
        `be assumed, so the decision is refused`,
    );
  }

  const tokens = meta.inputTokens;
  if (tokens === null || !Number.isFinite(tokens) || tokens <= 0) {
    throw new DecisionValidationError(
      'token-visibility-unavailable',
      `the bounded workflow request was answered without a usable input-token count ` +
        `(got ${JSON.stringify(meta.inputTokens)}); without it the request's fit against checkpoint ` +
        `${JSON.stringify(meta.checkpoint)} cannot be verified, so the decision is refused rather than assumed to fit`,
    );
  }

  if (tokens >= BOUNDED_NATIVE_INPUT_BUDGET) {
    throw new DecisionValidationError(
      'token-budget-saturated',
      `the bounded workflow request used ${tokens} input tokens, at or past the conservative shared refusal bound of ` +
        `${BOUNDED_NATIVE_INPUT_BUDGET} (the installed english checkpoint's own max_len, applied to both checkpoints); ` +
        `that checkpoint right-truncates its state there, so the acceptance material may not have reached the model. ` +
        `Refusing rather than judging on a possibly-dropped view`,
    );
  }
}

/**
 * Build the request AND the immutable candidate snapshot it was built from.
 *
 * Returned together so the loop can resolve a provider's answer against the
 * EXACT snapshot it offered — never a re-derivation, a fresh read of mutable
 * state, or an inferred target.
 *
 * Two shapes, chosen by the caller's own seam:
 *   - WITH `acceptanceMaterial` (the bounded workflow round): only the small
 *     supported space is offered, keys bind action+task, and no free-text
 *     parameter action is advertised as natively solvable.
 *   - WITHOUT it (every legacy/general caller): the full vocabulary and the
 *     parameter contract, byte-for-byte as before this slice.
 */
function buildOrchestrationRequest(
  observation: TaskObservation,
  options: OrchestrationDecisionRequestOptions,
): { request: DecisionRequest; candidates: ReadonlyMap<string, BoundActionCandidate> | null } {
  if (options.acceptanceMaterial === undefined) {
    return {
      request: {
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
      },
      candidates: null,
    };
  }

  const all = boundActionCandidates(observation, options.acceptanceMaterial);
  const criteria: Record<string, string> = {};
  const candidates = new Map<string, BoundActionCandidate>();
  for (const c of all) {
    criteria[c.key] = c.description;
    candidates.set(c.key, c);
  }
  return {
    request: {
      questions: {
        [ORCHESTRATION_ACTION_ID]: {
          type: 'choice',
          instructions: options.instructions ??
            'Choose exactly one of the offered actions. A `complete` option names the single task it ' +
            'would accept, and applies only if that task\'s own acceptance material shows its own run ' +
            'met its own criteria; otherwise choose `wait`. Do not invent a target.',
          criteria,
        },
      },
      state: {
        // LAYA-CONTEXT.1: the bounded space reads statuses only, so the rich
        // general projection is compacted here (see `compactNextActionState`).
        [ORCHESTRATION_ACTION_ID]: compactNextActionState(observation),
        // B4.0b: the material a `complete` judgement is actually MADE from,
        // compacted to the judged facts (see `compactAcceptanceMaterial`).
        [ACCEPTANCE_MATERIAL_FIELD]: compactAcceptanceMaterial(options.acceptanceMaterial),
      },
    },
    candidates,
  };
}

/**
 * Build the request the provider answers.
 *
 * The action set is the `criteria` of a single `choice` question, which is what
 * makes "the provider may only answer with one of these" a property of the
 * existing Decision Layer rather than a promise this file makes. The observation
 * travels as `state`, matching the provider's `Record<string, string>` contract.
 */
export function orchestrationDecisionRequest(
  observation: TaskObservation,
  options: OrchestrationDecisionRequestOptions = {},
): DecisionRequest {
  return buildOrchestrationRequest(observation, options).request;
}

/**
 * Read the action out of a validated response.
 *
 * Returns the RAW action rather than a typed decision on purpose: validation is
 * `validateDecision`'s job, and doing it here would give two places that could
 * disagree about what a valid action is. This function's only responsibility is
 * to turn the answer into the decision payload; `validateDecision` then decides
 * whether it may be acted on.
 *
 * TWO PATHS, and which one runs is decided by `candidates`:
 *   - `candidates` is `undefined` (legacy/general request): the provider's choice
 *     is the action name and its PARAMETERS are merged in verbatim, exactly as
 *     before this slice. This is the parameter contract the general callers use.
 *   - `candidates` is the snapshot the bounded workflow request was built from:
 *     the choice must be an OFFERED key, and the payload is taken ONLY from that
 *     snapshot. A key that was not offered fails closed, and a provider parameter
 *     that contradicts the bound target is refused rather than merged — a
 *     provider can never override the target the request actually offered.
 */
export function extractAction(
  response: { answers: Record<string, { type: string; choice?: string; parameters?: Record<string, string> }> },
  candidates?: ReadonlyMap<string, { readonly action: 'continue' | 'wait' | 'abort' | 'complete'; readonly taskId: string | null }>,
): unknown {
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

  if (candidates !== undefined) {
    const chosen = candidates.get(answer.choice);
    if (chosen === undefined) {
      throw new DecisionValidationError(
        'unoffered-action-key',
        `the provider chose ${JSON.stringify(answer.choice)}, which is not one of the bounded actions ` +
          `this request offered [${[...candidates.keys()].join(', ') || 'none'}]`,
      );
    }
    // The bounded payload comes ONLY from the snapshot. A provider may restate the task
    // it chose (and may add prose), but any OTHER sibling key is a target/action override
    // arriving as a parameter, and is refused rather than merged.
    const parameters = answer.parameters ?? {};
    const unexpected = Object.keys(parameters).filter((k) => k !== 'taskId' && k !== 'reason' && k !== 'rationale');
    if (unexpected.length > 0) {
      throw new DecisionValidationError(
        'unexpected-action-parameters',
        `the provider chose ${JSON.stringify(answer.choice)} and also supplied ${unexpected.join(', ')}; a ` +
          `bounded action's target is fixed by the key it chose, so extra parameters cannot be merged`,
      );
    }
    if (parameters.taskId !== undefined && parameters.taskId !== chosen.taskId) {
      throw new DecisionValidationError(
        'contradictory-target',
        `the provider chose ${JSON.stringify(answer.choice)}, which binds task "${chosen.taskId}", but ` +
          `also supplied taskId ${JSON.stringify(parameters.taskId)}; a provider parameter cannot override ` +
          `the bounded target`,
      );
    }
    return chosen.action === 'complete'
      ? { action: 'complete', taskId: chosen.taskId }
      : { action: chosen.action };
  }

  // Legacy path: the provider's PARAMETERS are merged in verbatim, so a caller
  // can carry `taskId` / `agentId` / `objective` itself. Anything unrecognised
  // arrives at `validateDecision` and is refused there, so a provider cannot
  // smuggle an extra field past the validator.
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
   * B4.0b: forwarded verbatim into the request. See
   * `OrchestrationDecisionRequestOptions.acceptanceMaterial`. Omitted by every caller
   * that does not want it, which is why the field is optional rather than empty.
   */
  readonly acceptanceMaterial?: AcceptanceMaterial;
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
    const built = buildOrchestrationRequest(
      observation,
      {
        ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
        ...(options.acceptanceMaterial === undefined ? {} : { acceptanceMaterial: options.acceptanceMaterial }),
      },
    );
    const response = await options.provider.decide(built.request);
    // LAYA-CONTEXT.1: for a BOUNDED request answered by the native provider, a
    // post-response, fail-closed visibility check runs BEFORE the answer is read.
    // If the request was not bounded (`candidates === null`) or the answer did not
    // come from Laya, this is a no-op and the legacy/generic path is unchanged.
    if (built.candidates !== null) {
      assertBoundedNativeVisibility(response);
    }
    // Resolve against the EXACT snapshot the request offered (`built.candidates`),
    // never a fresh derivation. `undefined` preserves the legacy parameter path.
    rawAction = extractAction(response, built.candidates ?? undefined);
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
  // Every REAL terminal run becomes evidence, whatever the control plane did with
  // it: `ExecuteOutcome.ok` is the control-plane outcome, so gating on it would
  // silently drop the authoritative run of an execution whose write-back was
  // refused (stale lease / fencing) — real evidence disappearing (F5). What must
  // never happen is FABRICATING a "failed" run for a dispatch that never ran, so
  // the test is the presence of a real `run`, not `ok`.
  const results = new Map<string, RunResult>();
  if (tick !== null) {
    for (const entry of tick.outcomes) {
      if (entry.outcome.run !== undefined) results.set(entry.taskId, entry.outcome.run);
    }
  }

  return { status: 'ok', observation, rawAction, decision, application, tick, results };
}

/** The actions this cycle is able to execute. Re-exported for callers and tests. */
export const CYCLE_IMPLEMENTED_ACTIONS = IMPLEMENTED_ACTIONS;
