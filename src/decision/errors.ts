/**
 * decision/errors.ts -- every way a routing decision can fail to be trusted.
 *
 * The rule, inherited from core/errors.ts: a decision provider fails LOUDLY.
 * Each error below is a case where the alternative to throwing would be guessing
 * an agent, guessing a complexity, or quietly dropping the review step. None of
 * those are acceptable, so each is modelled as its own class with an actionable
 * message rather than collapsed into one opaque "provider failed".
 */

import { OrchestratorError } from '../core/errors.ts';

/** Base for anything that prevented a trustworthy decision. */
export class DecisionError extends OrchestratorError {}

/** The provider could not be reached at all. */
export class DecisionUnavailableError extends DecisionError {
  readonly endpoint: string;

  constructor(endpoint: string, detail: string) {
    super(
      'DECISION_UNAVAILABLE',
      `Decision provider is not reachable at ${endpoint}: ${detail}. ` +
        `Routing is refused rather than defaulted, because guessing an agent ` +
        `for an unclassified task can dispatch work to the wrong contract. ` +
        `Start it with "laya-serve" and retry, or run the task through an ` +
        `explicit --agent.`,
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
        `No agent was selected. On a cold CUDA start the first request also pays ` +
        `for checkpoint load; raise decisionTimeoutMs or warm the provider once.`,
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
        `Laya rejects an oversized or malformed request with 4xx; the detail ` +
        `above is the provider's own explanation.`,
    );
    this.status = status;
    this.body = body;
  }
}

/**
 * The response was 2xx but did not contain a decision we are willing to act on.
 *
 * This is the important one. laya-serve answers 200 for several inputs that
 * carry no information at all -- an empty `questions` object yields
 * `answers: {}`, and a one-option choice yields that option every time. Trusting
 * the status code would turn those into confident, wrong routing.
 */
export class DecisionSchemaError extends DecisionError {
  readonly detail: string;

  constructor(detail: string) {
    super(
      'DECISION_SCHEMA',
      `Decision provider returned a response that cannot be trusted: ${detail}. ` +
        `No agent was selected. Treat the classification as failed, not as a ` +
        `weak signal -- re-scoring the same prompt is cheaper than dispatching ` +
        `the wrong agent.`,
    );
    this.detail = detail;
  }
}

/** The request we built was rejected before it was sent. */
export class DecisionInputError extends DecisionError {
  constructor(detail: string) {
    super('DECISION_INPUT', `Cannot build a decision request: ${detail}.`);
  }
}
