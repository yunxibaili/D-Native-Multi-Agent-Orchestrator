/**
 * decision/errors.ts -- every way a decision can fail to be trusted.
 *
 * The rule, inherited from the project at large: a decision provider fails
 * LOUDLY. Each error below is a case where the alternative to throwing would be
 * guessing an answer, guessing a complexity, or quietly dropping a review step.
 * None are acceptable, so each is its own class with an actionable message
 * rather than one opaque "provider failed".
 *
 * WHY THIS LAYER HAS ITS OWN BASE CLASS
 * `DecisionError` deliberately does NOT extend `OrchestratorError`. The
 * Decision Layer is a separable, swappable component that sits in FRONT of the
 * agent runtime; making it inherit from the orchestrator kernel would tie it to
 * that kernel for the sake of one shared field. Concretely: it would mean
 * `src/decision/` cannot be read, tested or reused without `src/core/`, and an
 * import from decision/ into core/ is exactly the dependency direction this
 * project avoids elsewhere (adapters depend on the core contract, never the
 * reverse).
 *
 * The shape is deliberately identical -- a `code`, a `name`, an optional
 * `cause` -- so the project-wide error discipline (a message you can paste into
 * a search box, a stable `code` to branch on) still holds. If a future policy
 * layer needs to catch both, it catches `Error` and reads `.code`, or uses the
 * `isDecisionError` guard below; no bridge back into core/ is required.
 */

/** The project-wide shape for an actionable, code-carrying error. */
export class DecisionError extends Error {
  /** Stable, machine-branchable identifier, e.g. `DECISION_TIMEOUT`. */
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Narrows an unknown thrown value to a DecisionError, for cross-layer callers. */
export function isDecisionError(value: unknown): value is DecisionError {
  return value instanceof DecisionError;
}

/** The provider could not be reached at all. */
export class DecisionUnavailableError extends DecisionError {
  readonly endpoint: string;

  constructor(endpoint: string, detail: string) {
    super(
      'DECISION_UNAVAILABLE',
      `Decision provider is not reachable at ${endpoint}: ${detail}. ` +
        `No answer was produced. Classification is refused rather than defaulted, ` +
        `because a default would be indistinguishable from a real decision. ` +
        `Start the provider and retry, or classify the task by hand.`,
    );
    this.endpoint = endpoint;
  }
}

/** The provider did not answer in time. Never converted into a default. */
export class DecisionTimeoutError extends DecisionError {
  readonly timeoutMs: number;

  constructor(endpoint: string, timeoutMs: number) {
    super(
      'DECISION_TIMEOUT',
      `Decision provider at ${endpoint} did not respond within ${timeoutMs} ms. ` +
        `No answer was produced. A provider that loads a model on first use also pays that cost on the ` +
        `first request, so raise timeoutMs or warm the provider once.`,
    );
    this.timeoutMs = timeoutMs;
  }
}

/** The provider answered, but with a non-2xx status. */
export class DecisionTransportError extends DecisionError {
  readonly status: number;
  readonly body: string;

  constructor(endpoint: string, status: number, body: string) {
    super(
      'DECISION_TRANSPORT',
      `Decision provider at ${endpoint} returned HTTP ${status}: ${body}. ` +
        `A 4xx usually means the request exceeded a provider limit or was malformed; the detail above is ` +
        `the provider's own explanation of which.`,
    );
    this.status = status;
    this.body = body;
  }
}

/**
 * The response was 2xx but did not contain an answer we are willing to act on.
 *
 * This is the important one. A provider can answer 200 for several inputs that
 * carry no information at all -- an empty `questions` object yields
 * `answers: {}`, and a one-option choice yields that option every time. It will
 * also answer 200 with a self-contradictory answer, where the reported value
 * disagrees with the distribution shipped beside it. Trusting the status code, or
 * a single reported field, would turn those into confident, wrong classifications.
 *
 * The wording here stays provider-agnostic; a provider that knows more about a
 * particular contradiction (for instance that its score is an expectation rather
 * than an argmax) adds that detail at the point of detection.
 */
export class DecisionSchemaError extends DecisionError {
  readonly detail: string;

  constructor(detail: string) {
    super(
      'DECISION_SCHEMA',
      `Decision provider returned an answer that cannot be trusted: ${detail}. ` +
        `Treat the classification as failed, not as a weak signal -- re-scoring ` +
        `the same prompt is cheaper than acting on a wrong answer.`,
    );
    this.detail = detail;
  }
}

/**
 * The request was rejected before it was sent, or the provider is misconfigured.
 *
 * Covers a malformed request object as well as a request that is well-formed but
 * cannot inform (no choices, one choice, a combination the server refuses).
 * Every such case surfaces here rather than as a raw TypeError from deep inside
 * the provider.
 */
export class DecisionInputError extends DecisionError {
  constructor(detail: string) {
    super('DECISION_INPUT', `Cannot build a decision request: ${detail}.`);
  }
}
