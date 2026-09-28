/**
 * decision/types.ts -- the vocabulary a routing decision may take.
 *
 * This is deliberately NOT in core/. A decision provider is a separable,
 * replaceable input to the orchestrator: it classifies a task BEFORE any agent
 * runs, and it must be swappable (Laya, a rule set, a human prompt) without
 * touching the agent runtime. Keeping it out of core/ also keeps the Python/CUDA
 * side of Laya from ever becoming a dependency of the runtime itself.
 *
 * The vocabularies below are CLOSED. A classifier is only meaningful if the set
 * of answers it can produce is fixed and known: an open-ended "describe the
 * work" answer cannot be acted on, and letting one through would be a silent
 * fallback wearing the costume of a decision. See decision/laya.ts for how a
 * response outside these sets is turned into a loud failure.
 */

/** What kind of work the task is. Drives which agent contract is used. */
export const WORK_KINDS = ['implementation', 'review', 'research', 'debugging'] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

/** How big the task is. Index 0 is the smallest; index 4 the largest. */
export const COMPLEXITY_LEVELS = [
  'trivial',
  'small',
  'moderate',
  'large',
  'very large',
] as const;
export type ComplexityLevel = (typeof COMPLEXITY_LEVELS)[number];

/**
 * A probability in [0, 1]. Modelled as a branded number so an unvalidated
 * `confidence` from a provider cannot be assigned to a probability slot.
 */
export type Probability = number & { readonly __probability: unique symbol };

/** Narrows an arbitrary number to a Probability, or returns null if unusable. */
export function toProbability(value: unknown): Probability | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value > 1) return null;
  return value as Probability;
}

/**
 * The classifier's own routing, echoed back for audit. A decision that cannot
 * say WHICH checkpoint judged it cannot be diagnosed when it is wrong.
 */
export interface DecisionProvenance {
  /** Laya's own model label, e.g. "laya-rl-agent". */
  readonly model: string;
  /** The checkpoint that actually answered: english | multilingual | typed-decisions. */
  readonly checkpoint: string;
  /** Human-readable reason the routing picked that checkpoint. */
  readonly reason: string;
  /** Detected script/language profile, when the provider reports one. */
  readonly script: string | null;
  readonly language: string | null;
  /** Wall time of the call, measured by the provider. */
  readonly elapsedMs: number;
}

/**
 * The provider's verbatim answer, retained so a bad decision can be explained
 * and a prompt can be re-scored without re-running the model.
 */
export interface RawAnswer {
  readonly choice?: string;
  readonly score?: number;
  readonly noul?: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number | null;
  readonly answer_confidence: number | null;
}

/** The Jev-compatible envelope laya-serve returns from POST /v1/systemone. */
export interface RawSystemOne {
  readonly model: string;
  readonly answers: Readonly<Record<string, RawAnswer>>;
  readonly routing?: {
    readonly model?: string;
    readonly reason?: string;
    readonly detection?: { readonly script?: string; readonly language?: string | null };
  };
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
}

/**
 * One fully-validated routing decision.
 *
 * Every field here has been checked against the closed vocabularies above. A
 * value that survived construction is therefore safe to branch on; there is no
 * "unknown" member and no null that a caller could mistake for a real answer.
 */
export interface RouteDecision {
  readonly work_kind: WorkKind;
  /** Classifier confidence in work_kind, in [0, 1]. */
  readonly work_kind_confidence: Probability;
  /** Full distribution over WORK_KINDS, so a caller can set its own threshold. */
  readonly work_kind_probabilities: Readonly<Record<WorkKind, number>>;

  readonly complexity: ComplexityLevel;
  /** Raw 0..4 position, useful for comparing against a caller's own scale. */
  readonly complexity_score: number;
  readonly complexity_confidence: Probability;

  /** Whether an independent review is required before this is accepted. */
  readonly review_required: boolean;
  /** Continuous evidence for review_required, in [0, 1]. */
  readonly review_noul: Probability;

  readonly provenance: DecisionProvenance;
  readonly raw: RawSystemOne;
}

/** A question in the typed set Laya answers. */
export type DecisionQuestion =
  | { readonly type: 'choice'; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: 'score'; readonly instructions: string; readonly criteria: readonly string[] }
  | { readonly type: 'noul'; readonly instructions: string; readonly criteria?: Readonly<Record<string, string>> };

/**
 * A pluggable classifier.
 *
 * `decide` MUST throw rather than return a guess. There is deliberately no
 * `fallback` field and no `tryDecide`: a provider that cannot decide cannot
 * silently hand the work to another agent, default to "implementation", or
 * proceed unclassified. Callers handle failure explicitly, because a wrong
 * routing decision is more expensive than a refused one.
 */
export interface DecisionProvider {
  /** Short label used in logs and errors, e.g. "laya". */
  readonly name: string;
  /** Cheap readiness probe. Must not start or warm the model. */
  probe: () => Promise<DecisionProbe>;
  /** Classify a task. Throws a DecisionError subclass on anything untrustworthy. */
  decide: (input: DecisionInput) => Promise<RouteDecision>;
}

export interface DecisionInput {
  /** The task text to classify. */
  readonly task: string;
  /** Optional caller context folded into the state, e.g. recent file paths. */
  readonly context?: Readonly<Record<string, string>>;
}

export interface DecisionProbe {
  readonly ok: boolean;
  /** Where the provider is reached, for the operator's benefit. */
  readonly endpoint: string;
  readonly detail: string;
  /** e.g. the loaded checkpoints and their device. */
  readonly warnings: readonly string[];
}
