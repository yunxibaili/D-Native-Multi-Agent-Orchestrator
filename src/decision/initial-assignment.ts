/**
 * decision/initial-assignment.ts — TeamRun T2-a.1: Laya's INITIAL Agent × Model choice.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Until now the first Agent/Model a task ran on was never Laya's decision. Assignment
 * either scored the registry and picked, or the CALLER pre-seeded a pair into the workbench
 * spec (`WorkbenchTaskSpec.explicitPair`). A caller-supplied value is a manual/compat
 * entry point, not a semantic decision — so there was no Agent × Model authority on the
 * INITIAL path at all.
 *
 * REUSE, NOT A SECOND BRAIN
 * -------------------------
 * This is a PRESET over the existing Decision Layer, exactly like `routing.ts` is a preset
 * for task classification. It reuses `DecisionProvider`, `DecisionRequest`,
 * `DecisionQuestion` and `DecisionResponse`. It adds no provider, no planner, no router,
 * and it does not reimplement Assignment's scoring — Laya makes the semantic choice,
 * Assignment remains the enforcement authority.
 *
 * IT IS NOT `reassign`
 * --------------------
 * An initial assignment is not a re-assignment: there is no previous worker to move from.
 * Reusing the `reassign` action (or fabricating an attempt to trip the post-result loop)
 * would misrepresent the decision and would require a fake execution to get there. This
 * therefore asks its own ONE question.
 *
 * THE ANSWER SPACE IS THE CANDIDATE LIST
 * --------------------------------------
 * The choice keys are built from the real candidates the caller offers, so a provider
 * cannot name an agent/model pair that was never on the table, and the answer is checked
 * against that same list on the way back. Whether a chosen pair is still usable is NOT
 * decided here: Assignment re-verifies it, so a Laya decision is never an admission
 * guarantee.
 */

import { DecisionSchemaError } from './errors.ts';
import type { DecisionProvider, DecisionQuestion, DecisionRequest, DecisionResponse } from './types.ts';

/** The one question id this phase asks, and reads its answer back under. */
export const INITIAL_AGENT_MODEL_ID = 'initial_agent_model';

/**
 * One Agent Family × Model pair Laya may choose, as the decision layer sees it.
 *
 * Deliberately a plain projection of facts the registry already owns. It carries no
 * scoring, no preference and no ranking: which pair is BEST is Assignment's question, and
 * duplicating that arithmetic here is how two authorities end up disagreeing.
 */
export interface InitialAssignmentCandidate {
  readonly agentId: string;
  readonly modelId: string;
  /** Effective availability (T1-a), so Laya is not asked to pick a known-dead pair. */
  readonly available: boolean;
  /** Task types this pair can serve, from the entry's own capability contract. */
  readonly taskTypes: readonly string[];
}

/** The key a choice is carried under. Opaque outside this module. */
export function initialCandidateKey(agentId: string, modelId: string): string {
  // A separator that cannot occur inside an agent or model id, so the key is
  // unambiguous rather than reconstructible by accident.
  return `${agentId}\u0000${modelId}`;
}

/** Decode a choice key back into the pair it names. */
export function decodeInitialCandidateKey(key: string): { agentId: string; modelId: string } | null {
  const cut = key.indexOf('\u0000');
  if (cut <= 0 || cut === key.length - 1) return null;
  return { agentId: key.slice(0, cut), modelId: key.slice(cut + 1) };
}

/** What Laya is told about the task it is choosing a pair for. */
export interface InitialAssignmentTaskFacts {
  readonly taskId: string;
  readonly objective: string;
  readonly taskType: string;
  /** Acceptance criteria / task semantics, when the caller has them. */
  readonly acceptanceCriteria?: string;
}

export interface InitialAssignmentRequestInput {
  readonly task: InitialAssignmentTaskFacts;
  readonly candidates: readonly InitialAssignmentCandidate[];
}

/**
 * The pinned question set. Mirrors `routingQuestions()`: the criteria set IS the answer
 * space, so it is built from the real candidates rather than left to vary per call.
 */
export function initialAssignmentQuestions(
  candidates: readonly InitialAssignmentCandidate[],
): Readonly<Record<string, DecisionQuestion>> {
  const criteria: Record<string, string> = {};
  for (const c of candidates) {
    criteria[initialCandidateKey(c.agentId, c.modelId)] =
      `Agent Family "${c.agentId}" with model "${c.modelId}" ` +
      `(task types: ${c.taskTypes.join(', ') || 'none'}; currently ${c.available ? 'available' : 'unavailable'})`;
  }
  return {
    [INITIAL_AGENT_MODEL_ID]: {
      type: 'choice',
      instructions:
        'Choose which Agent Family and Model should do this task. Answer with exactly one ' +
        'option: the Agent Family and the model are chosen together, never one alone.',
      criteria,
    },
  };
}

export function buildInitialAssignmentRequest(
  input: InitialAssignmentRequestInput,
): DecisionRequest {
  return {
    questions: initialAssignmentQuestions(input.candidates),
    task: input.task.objective,
    context: {
      phase: 'initial-assignment',
      taskId: input.task.taskId,
      taskType: input.task.taskType,
      ...(input.task.acceptanceCriteria === undefined
        ? {}
        : { acceptanceCriteria: input.task.acceptanceCriteria }),
    },
    state: {
      phase: 'initial-assignment',
      candidates: input.candidates
        .map((c) => `${initialCandidateKey(c.agentId, c.modelId)}|${c.available ? 'available' : 'unavailable'}`)
        .join('\n'),
    },
  };
}

/**
 * Ask the provider which pair to use.
 *
 * REUSES the seam, including its rule that a provider which cannot decide MUST throw:
 * this function never invents an answer, never falls back to a default pair, and never
 * degrades into "let Assignment score it". A throw or an unusable answer is the caller's
 * to handle as a refusal.
 */
export async function decideInitialAssignment(
  provider: DecisionProvider,
  input: InitialAssignmentRequestInput,
): Promise<{ agentId: string; modelId: string }> {
  const response: DecisionResponse = await provider.decide(buildInitialAssignmentRequest(input));
  return readInitialAssignmentIntent(response, input.candidates);
}

/**
 * Map the provider's answer back to a pair, and prove it names something that was offered.
 *
 * Returns the RAW `{agentId, modelId}`; the caller runs the typed
 * `validateAgentModelIntent` from `orchestration/assignment.ts`. Keeping the validator on
 * the orchestration side preserves the dependency direction (decision must not import
 * orchestration), so there is exactly one place that decides what a valid pair is.
 */
export function readInitialAssignmentIntent(
  response: DecisionResponse,
  candidates: readonly InitialAssignmentCandidate[],
): { agentId: string; modelId: string } {
  const answer = response.answers[INITIAL_AGENT_MODEL_ID];
  if (answer === undefined) {
    throw new DecisionSchemaError(
      `the initial-assignment answer did not include "${INITIAL_AGENT_MODEL_ID}"`,
    );
  }
  // The answer union must be narrowed, not asserted: a `score`/`noul` answer to a choice
  // question is a contract violation, and reading `.choice` off it would be undefined.
  if (answer.type !== 'choice') {
    throw new DecisionSchemaError(
      `the initial-assignment answer must be a "choice", got "${answer.type}"`,
    );
  }
  const choice = answer.choice;
  if (typeof choice !== 'string' || choice.trim() === '') {
    throw new DecisionSchemaError(
      `the initial-assignment answer must be one choice key, got ${JSON.stringify(choice)}`,
    );
  }
  const pair = decodeInitialCandidateKey(choice);
  if (pair === null) {
    throw new DecisionSchemaError(
      `the initial-assignment answer ${JSON.stringify(choice)} is not a valid Agent x Model choice key`,
    );
  }
  // The answer must name a pair that was actually offered. A provider that invents one is
  // refused here rather than reaching Assignment as a pair nobody offered.
  const offered = candidates.some(
    (c) => c.agentId === pair.agentId && c.modelId === pair.modelId,
  );
  if (!offered) {
    throw new DecisionSchemaError(
      `the initial-assignment answer "${choice}" is not one of the offered Agent x Model pairs`,
    );
  }
  return pair;
}