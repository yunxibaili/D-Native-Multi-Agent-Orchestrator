/**
 * decision/routing.ts -- the task-classification preset, on top of the generic
 * Decision Layer.
 *
 * This is NOT agent selection. It describes a task (what kind of work, how big,
 * whether review is warranted) and stops there. Nothing here names OpenCode or
 * Codex, and nothing here is called by the orchestrator: agent selection remains
 * an explicit `--agent` choice.
 *
 * It exists as a separate module from the generic layer because the question set
 * is MEASURED, not guessed. On this machine, the same English bug report scored
 * against a 2-option choice came back `review` at 0.628, while the same task
 * against the 4-option set below came back `debugging` at 0.555. The criteria set
 * IS the answer space, so it is pinned here rather than left to a caller to vary
 * per request.
 *
 * Known caveat, recorded so it is not mistaken for a bug: language changes the
 * verdict. The same refactor task returned review=true in English (noul 0.678)
 * and review=false in Chinese (noul 0.004). `review_required` is a hint with a
 * distribution attached, not a gate.
 */

import { DecisionSchemaError } from './errors.ts';
import type { DecisionProvider, DecisionQuestion, DecisionRequest, DecisionResponse, Probability } from './types.ts';
import { toProbability } from './types.ts';

/** What kind of work the task is. */
export const WORK_KINDS = ['implementation', 'review', 'research', 'debugging'] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

/** How big the task is. Index 0 is the smallest. */
export const COMPLEXITY_LEVELS = ['trivial', 'small', 'moderate', 'large', 'very large'] as const;
export type ComplexityLevel = (typeof COMPLEXITY_LEVELS)[number];

/** The question ids this preset asks, and reads its answers back under. */
export const WORK_KIND_ID = 'work_kind';
export const COMPLEXITY_ID = 'complexity';
export const REVIEW_ID = 'review_required';

/** noul is a "no or unsure likelihood"; above this a review is considered due. */
export const REVIEW_NUL_THRESHOLD = 0.5;

/**
 * The pinned question set. See the module note for why these options are fixed
 * rather than caller-supplied.
 */
export function routingQuestions(): Readonly<Record<string, DecisionQuestion>> {
  return {
    [WORK_KIND_ID]: {
      type: 'choice',
      instructions: 'What kind of work is this task?',
      criteria: {
        implementation: 'write or modify source code',
        review: 'read existing code and report issues',
        research: 'investigate and gather information',
        debugging: 'find the cause of a failure',
      },
    },
    [COMPLEXITY_ID]: {
      type: 'score',
      instructions: 'How complex is this task?',
      criteria: [...COMPLEXITY_LEVELS],
    },
    [REVIEW_ID]: {
      type: 'noul',
      instructions: 'Does this task need an independent code review before it is accepted?',
    },
  };
}

export interface RoutingRequestOptions {
  readonly task: string;
  readonly context?: Readonly<Record<string, string>>;
}

/** Build the generic request this preset uses. Exposed for tests and tooling. */
export function routingRequest(options: RoutingRequestOptions): DecisionRequest {
  return {
    questions: routingQuestions(),
    task: options.task,
    ...(options.context ? { context: options.context } : {}),
  };
}

/**
 * A classification with the answer space already narrowed to the closed
 * vocabularies above. The provider guarantees each field is inside its set, so
 * this is safe to switch on without a default branch.
 */
export interface TaskClassification {
  readonly work_kind: WorkKind;
  readonly work_kind_confidence: Probability;
  /** Full distribution, so a caller can set its own threshold. */
  readonly work_kind_probabilities: Readonly<Record<WorkKind, number>>;

  readonly complexity: ComplexityLevel;
  readonly complexity_score: number;
  readonly complexity_confidence: Probability;

  readonly review_required: boolean;
  /** The continuous evidence behind review_required. */
  readonly review_noul: Probability;

  readonly provider: DecisionResponse['provider'];
  readonly raw: DecisionResponse['raw'];
}

/**
 * Project a validated generic response onto the closed classification.
 *
 * The narrowing here is a second, independent guard: the provider already
 * rejected anything outside the vocabularies, and this re-checks rather than
 * casting. If the two ever disagree, the call fails with a `DecisionSchemaError`
 * rather than narrowing something invalid into a valid-looking type -- so a
 * failure here is still catchable as a Decision Layer error, not a bare Error.
 */
export function toTaskClassification(response: DecisionResponse): TaskClassification {
  const workKind = response.answers[WORK_KIND_ID];
  const complexity = response.answers[COMPLEXITY_ID];
  const review = response.answers[REVIEW_ID];

  if (!workKind || workKind.type !== 'choice') {
    throw new DecisionSchemaError(
      `routing: expected a choice answer for "${WORK_KIND_ID}", got ${workKind?.type ?? 'nothing'}`,
    );
  }
  if (!complexity || complexity.type !== 'score') {
    throw new DecisionSchemaError(
      `routing: expected a score answer for "${COMPLEXITY_ID}", got ${complexity?.type ?? 'nothing'}`,
    );
  }
  if (!review || review.type !== 'noul') {
    throw new DecisionSchemaError(
      `routing: expected a noul answer for "${REVIEW_ID}", got ${review?.type ?? 'nothing'}`,
    );
  }
  if (!(WORK_KINDS as readonly string[]).includes(workKind.choice)) {
    throw new DecisionSchemaError(
      `routing: work_kind ${JSON.stringify(workKind.choice)} is outside [${WORK_KINDS.join(', ')}]`,
    );
  }
  if (!(COMPLEXITY_LEVELS as readonly string[]).includes(complexity.level)) {
    throw new DecisionSchemaError(
      `routing: complexity ${JSON.stringify(complexity.level)} is outside [${COMPLEXITY_LEVELS.join(', ')}]`,
    );
  }

  const workKindProbabilities = {} as Record<WorkKind, number>;
  for (const kind of WORK_KINDS) {
    const p = toProbability(workKind.probabilities[kind]);
    if (p === null) {
      throw new DecisionSchemaError(
        `routing: work_kind probability for "${kind}" is ${JSON.stringify(workKind.probabilities[kind])}, expected [0, 1]`,
      );
    }
    workKindProbabilities[kind] = p;
  }

  return {
    work_kind: workKind.choice as WorkKind,
    work_kind_confidence: workKind.confidence,
    work_kind_probabilities: workKindProbabilities,
    complexity: complexity.level as ComplexityLevel,
    complexity_score: complexity.score,
    complexity_confidence: complexity.confidence,
    review_required: review.noul > REVIEW_NUL_THRESHOLD,
    review_noul: review.noul,
    provider: response.provider,
    raw: response.raw,
  };
}

/**
 * Classify a task. Answers questions and returns a classification; it does not
 * choose an agent and does not run anything.
 */
export async function classifyTask(
  provider: DecisionProvider,
  options: RoutingRequestOptions,
): Promise<TaskClassification> {
  return toTaskClassification(await provider.decide(routingRequest(options)));
}
