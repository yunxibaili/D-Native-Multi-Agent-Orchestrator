/**
 * decision/types.ts -- the minimal stable Decision Layer interface.
 *
 * Deliberately NOT in core/. A decision provider is a separable, replaceable
 * input that classifies something BEFORE any agent runs, and it must be
 * swappable (Laya, a rule set, a human answer) without touching the agent
 * runtime. Keeping it out of core/ also keeps the Python/CUDA side of Laya from
 * ever becoming a dependency of the runtime itself.
 *
 * This is intentionally a SMALL interface, not an AI framework. Three types
 * carry everything:
 *
 *   DecisionRequest   what to ask, and what to read
 *   DecisionResponse  the validated answers, plus who answered
 *   DecisionProvider  the seam
 *
 * The one design rule that matters: **the caller declares the answer space, and
 * the provider validates that the answer landed inside it.** A provider cannot
 * invent an answer that the request did not offer. That is what makes a
 * classification safe to branch on, and it is why an unusable response throws
 * instead of returning a best guess. See decision/laya.ts.
 */

/**
 * A probability in [0, 1]. Branded so an unvalidated `confidence` from a
 * provider cannot be assigned to a probability slot by accident.
 */
export type Probability = number & { readonly __probability: unique symbol };

/** Narrows an arbitrary value to a Probability, or returns null if unusable. */
export function toProbability(value: unknown): Probability | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value > 1) return null;
  return value as Probability;
}

// ---- the question vocabulary ---------------------------------------------

/**
 * The three question kinds Laya answers. Each is closed on purpose: an
 * open-ended "describe the work" answer cannot be acted on, and letting one
 * through would be a silent fallback wearing the costume of a decision.
 *
 *   choice  pick exactly one key of `criteria`
 *   score   position on an ordered list of `criteria` levels
 *   noul    "no / unsure likelihood" -- a bare number in [0, 1], with no
 *           answer space, and therefore no `criteria` at all
 */
export type DecisionQuestion =
  | {
      readonly type: 'choice';
      readonly instructions: string;
      /** The available choices, keyed by the value that will be returned. */
      readonly criteria: Readonly<Record<string, string>>;
    }
  | {
      readonly type: 'score';
      readonly instructions: string;
      /** Ordered levels, index 0 first. */
      readonly criteria: readonly string[];
    }
  | {
      readonly type: 'noul';
      readonly instructions: string;
      /**
       * `criteria` is deliberately absent. Measured against laya-serve: a noul
       * question that carries `criteria` is rejected by the server with 422
       * ("a noul question takes 'criteria' as a dict with optional 'true'/'false'
       * descriptions, or omits it"). The provider refuses that combination
       * locally instead of spending a round trip on a guaranteed failure.
       */
    };

/** The ids of the questions a request asks, used to key the answers. */
export type DecisionQuestionId = string;

// ---- request --------------------------------------------------------------

/**
 * One decision to make: a set of typed questions, plus the state they read.
 *
 * `task` is shorthand for the common case of "classify this text"; it is merged
 * into `state` under the `TASK_FIELD` key. A caller with a richer payload
 * (subject + body, diff + request) sets `state` directly instead.
 */
export interface DecisionRequest {
  /** The questions to answer, keyed by the id their answers come back under. */
  readonly questions: Readonly<Record<DecisionQuestionId, DecisionQuestion>>;
  /** Text to classify. Merged into `state` under TASK_FIELD. */
  readonly task?: string;
  /** Optional extra fields folded into `state` alongside the task. */
  readonly context?: Readonly<Record<string, string>>;
  /** The full state, for callers that do not want a single `task` field. */
  readonly state?: Readonly<Record<string, string>>;
}

/** The state key `DecisionRequest.task` is merged under. */
export const TASK_FIELD = 'task';

// ---- response -------------------------------------------------------------

/** Common to every answer kind. */
interface AnswerBase {
  /**
   * The provider's distribution over its answer space, keyed the same way the
   * question declared it. Retained on every answer because a single confidence
   * number hides the near-miss: the shipped checkpoints warn that their
   * confidence is uncalibrated, so a caller is expected to threshold the
   * distribution itself.
   */
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: Probability;
}

/** A `choice` answer. `choice` is guaranteed to be one of the offered keys. */
export interface ChoiceAnswer extends AnswerBase {
  readonly type: 'choice';
  readonly choice: string;
  /** Echoed back from the question, so a response is self-describing. */
  readonly criteria: Readonly<Record<string, string>>;
}

/** A `score` answer. `level` is guaranteed to be one of the offered levels. */
export interface ScoreAnswer extends AnswerBase {
  readonly type: 'score';
  readonly score: number;
  readonly level: string;
  /** Echoed back from the question. */
  readonly levels: readonly string[];
}

/** A `noul` answer: a bare likelihood in [0, 1], with no answer space. */
export interface NoulAnswer extends AnswerBase {
  readonly type: 'noul';
  readonly noul: Probability;
}

export type DecisionAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

/** Who answered, and under what conditions. Retained so a bad call is diagnosable. */
export interface ProviderMetadata {
  /** The provider's own id, e.g. "laya". */
  readonly name: string;
  /** The provider's model label, e.g. "laya-rl-agent". */
  readonly model: string;
  /** Wall time of the call, measured by the provider. */
  readonly elapsedMs: number;
  /**
   * Everything else the provider wants to report, untyped.
   *
   * Kept deliberately opaque. The generic layer must not carry another
   * provider's vocabulary: `checkpoint`, `script` and `language` mean nothing
   * outside Laya, so they live in the Laya module's own metadata type instead
   * of being hard-coded here. A provider that wants to expose structured
   * details puts them here and publishes a typed reader alongside its
   * implementation -- no generic metadata framework is introduced.
   */
  readonly details: Readonly<Record<string, unknown>>;
}

/** The provider's verbatim envelope, kept for debugging a wrong answer. */
export interface RawDecision {
  readonly [key: string]: unknown;
}

/**
 * A fully-validated set of answers.
 *
 * Every field survived construction against the request that asked for it, so
 * `answers[someId].choice` is safe to switch on. There is no "unknown" member
 * and no null a caller could mistake for a real answer -- a response either
 * makes sense or the call throws.
 */
export interface DecisionResponse {
  readonly answers: Readonly<Record<DecisionQuestionId, DecisionAnswer>>;
  readonly provider: ProviderMetadata;
  /** The provider's unfiltered response, for debugging. Not validated. */
  readonly raw: RawDecision;
}

// ---- the seam -------------------------------------------------------------

/**
 * A pluggable classifier.
 *
 * `decide` MUST throw rather than return a guess. There is deliberately no
 * `fallback` field and no `tryDecide`: a provider that cannot decide cannot
 * silently substitute a default answer, a different provider, or an
 * unclassified pass-through. Callers handle failure explicitly, because acting
 * on a wrong classification costs more than refusing to act.
 */
export interface DecisionProvider {
  /** Short label used in logs and errors, e.g. "laya". */
  readonly name: string;
  /** Cheap readiness probe. Must not start or warm a model. */
  probe: () => Promise<DecisionProbe>;
  /** Answer a request. Throws a DecisionError subclass on anything untrustworthy. */
  decide: (request: DecisionRequest) => Promise<DecisionResponse>;
}

export interface DecisionProbe {
  readonly ok: boolean;
  /** Where the provider is reached, for the operator's benefit. */
  readonly endpoint: string;
  readonly detail: string;
  /** e.g. loaded checkpoints, or a CPU fallback worth knowing about. */
  readonly warnings: readonly string[];
}
