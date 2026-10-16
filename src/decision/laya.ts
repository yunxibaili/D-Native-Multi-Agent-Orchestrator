/**
 * decision/laya.ts -- DecisionProvider backed by a LOCAL laya-serve.
 *
 * Scope, deliberately narrow:
 *   - It talks to a local HTTP endpoint. There is no cloud route, no fallback
 *     provider, and no API key. If laya-serve is down the call throws.
 *   - It only answers questions. It never launches an agent, never picks a
 *     thread, and never falls back to a default answer.
 *   - It does NOT start laya-serve. Running the service is the caller's job, so
 *     the Python/CUDA side is never a hard dependency of anything.
 *
 * Validation happens in two places, on purpose:
 *
 *   1. validateRequest() refuses to SEND a question that cannot be answered
 *      informatively -- no choices, one choice, one score level, malformed
 *      criteria. Laya accepts these and returns HTTP 200, but a one-option
 *      choice returns that option every single time, which is not a decision.
 *
 *   2. validateResponse() refuses to ACCEPT a 200 that did not land inside the
 *      answer space the request declared. Measured on this machine, laya-serve
 *      answers 200 with `answers: {}` for an empty question set, and 200 with a
 *      degenerate value for a one-option choice. HTTP 200 is therefore never
 *      treated as sufficient evidence of a decision.
 */

import {
  DecisionError,
  DecisionInputError,
  DecisionSchemaError,
  DecisionTimeoutError,
  DecisionTransportError,
  DecisionUnavailableError,
} from './errors.ts';
import {
  TASK_FIELD,
  toProbability,
  type DecisionAnswer,
  type DecisionProvider,
  type DecisionProbe,
  type DecisionQuestion,
  type DecisionRequest,
  type DecisionResponse,
  type Probability,
  type ProviderMetadata,
} from './types.ts';

/**
 * Laya's own server-side limits, mirrored so the caller gets an actionable
 * message instead of a bare 413. Every value below was read off the running
 * service (`laya.serve` module constants, cross-checked against observed 413
 * responses). The server remains the backstop if upstream changes them; these
 * are ergonomics, not a security boundary.
 */
const MAX_STATE_CHARS = 50_000;
const MAX_QUESTIONS = 64;
const MAX_CHOICE_OPTIONS = 100;
const MAX_SCORE_LEVELS = 32;
const MAX_TOTAL_OPTIONS = 512;
const MAX_BODY_BYTES = 2_097_152;

const DEFAULT_BASE_URL = 'http://127.0.0.1:8077';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface LayaProviderOptions {
  /**
   * Base URL of a laya-serve. Defaults to loopback.
   *
   * SECURITY BOUNDARY: this project is a LOCAL orchestrator that explicitly
   * makes no provider API calls, and a decision request carries the task text
   * itself. A non-loopback `baseUrl` would therefore POST task content to
   * another machine, which is a different product decision. So loopback is
   * enforced, and a remote endpoint requires `allowRemote: true` as a visible,
   * deliberate opt-in rather than something a caller can trip over.
   *
   * Loopback means 127.0.0.0/8, `::1`, or the literal host `localhost`.
   */
  readonly baseUrl?: string;
  /** Explicit acknowledgement that task text may leave this machine. */
  readonly allowRemote?: boolean;
  /** Per-request budget. The first call also pays CUDA + checkpoint load. */
  readonly timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /**
   * MVP-E2E.1a: an OPT-IN per-ROUND cumulative POST budget.
   *
   * Absent = no budget, exactly the previous behaviour. When present, pass the SAME
   * object to every provider a round builds so they share one counter; a new round
   * mints a fresh object with `createLayaPostBudget`. `max === 0` forbids every POST.
   */
  readonly postBudget?: LayaPostBudget;
}

/** Laya's own routing/usage detail. Deliberately NOT part of the generic metadata. */
export interface LayaMetadata {
  /** Which checkpoint answered: english | multilingual | typed-decisions. */
  readonly checkpoint: string;
  /** The provider's own reason for choosing it. */
  readonly reason: string;
  readonly script: string | null;
  readonly language: string | null;
  readonly revisions: Readonly<Record<string, string>>;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/**
 * Reads the Laya-specific detail out of a response's generic metadata.
 *
 * This is the whole of the generic/Laya split: `ProviderMetadata` carries the
 * three fields every provider has, and the Laya vocabulary lives here, behind a
 * typed reader. No framework, one function.
 */
export function layaMetadata(source: { readonly provider: ProviderMetadata }): LayaMetadata {
  if (source.provider.name !== 'laya') {
    throw new DecisionSchemaError(
      `expected Laya metadata but the answer came from provider "${source.provider.name}"`,
    );
  }
  const d = source.provider.details;
  const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v.length > 0 ? v : fallback);
  const optStr = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  const optNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const revisions: Record<string, string> = {};
  if (isRecord(d.revisions)) {
    for (const [k, v] of Object.entries(d.revisions)) {
      if (typeof v === 'string') revisions[k] = v;
    }
  }
  return {
    checkpoint: str(d.checkpoint, 'unknown'),
    reason: str(d.reason, 'not reported'),
    script: optStr(d.script),
    language: optStr(d.language),
    revisions,
    inputTokens: optNum(d.inputTokens),
    outputTokens: optNum(d.outputTokens),
  };
}

interface HealthPayload {
  readonly status?: unknown;
  readonly loaded?: unknown;
  readonly device?: unknown;
  readonly cpu_fallbacks?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A short, safe rendering of an arbitrary value for an error message. */
function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  const t = typeof v;
  if (t === 'string') return `a string (${JSON.stringify(v)})`;
  if (t === 'object') return 'a non-array object';
  if (t === 'undefined') return 'undefined';
  return `${t} (${String(v)})`;
}

/** Reads a probability and fails loudly; it is the only evidence of certainty. */
function requireProbability(value: unknown, what: string): Probability {
  const p = toProbability(value);
  if (p === null) {
    throw new DecisionSchemaError(`${what} is ${describe(value)}, expected a probability in [0, 1]`);
  }
  return p;
}

/** A non-empty string, or null. Used for every string the provider reads. */
function asNonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

/**
 * Enforces the local-only boundary on the provider endpoint.
 *
 * See `LayaProviderOptions.baseUrl`. The rule exists because a decision request
 * carries the task text: without it, a single config slip would ship task
 * content to another machine in a project whose stated contract is that it makes
 * no provider API calls.
 */
function resolveBaseUrl(raw: string | undefined, allowRemote: boolean): string {
  let url: URL;
  try {
    url = new URL(raw ?? DEFAULT_BASE_URL);
  } catch {
    throw new DecisionInputError(`baseUrl ${JSON.stringify(raw ?? null)} is not a valid absolute URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DecisionInputError(
      `baseUrl protocol ${JSON.stringify(url.protocol)} is not supported, expected http: or https:`,
    );
  }
  const host = url.hostname.toLowerCase();
  if (!isLoopbackHost(host) && !allowRemote) {
    throw new DecisionInputError(
      `baseUrl host ${JSON.stringify(host)} is not loopback. This is a local-only project that makes no ` +
        `provider API calls, and a decision request carries the task text, so a remote endpoint would send ` +
        `task content to another machine. Use 127.0.0.1 / ::1 / localhost, or pass allowRemote: true if that ` +
        `is genuinely intended`,
    );
  }
  return url.toString().replace(/\/+$/, '');
}

/**
 * True only for a real loopback host.
 *
 * The 127.0.0.0/8 test checks each octet is 0-255, so a nonsense address like
 * `127.999.999.999` is NOT classified as loopback. That matters here: the check
 * is a safety boundary, and an address that merely looks loopback-ish must not
 * pass it. Note `new URL()` already rejects many malformed hosts outright; this
 * is the belt to that braces.
 */
function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const octets = v4.slice(1, 5).map((part) => Number(part));
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false;
  return octets[0] === 127;
}

/**
 * A per-request budget that AbortSignal.timeout can actually use.
 *
 * Validated here so an illegal value becomes a DecisionInputError with a usable
 * message, instead of a RangeError escaping from inside AbortSignal.timeout at
 * the first call.
 */
function resolveTimeoutMs(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new DecisionInputError(`timeoutMs is ${describe(raw)}, expected a finite number`);
  }
  if (raw <= 0) {
    throw new DecisionInputError(`timeoutMs is ${raw}, expected a positive number of milliseconds`);
  }
  return raw;
}

/**
 * MVP-E2E.1a: a per-ROUND cumulative hard POST budget.
 *
 * A plain mutable object, NOT a manager: the CLI mints ONE with
 * `createLayaPostBudget` per round and hands the SAME object to every provider it
 * builds for that round, so two providers reconstructed mid-round share one counter.
 * A new round gets a fresh object. There is no global map and no reset-per-decision
 * behaviour.
 *
 * `reserved` is incremented SYNCHRONOUSLY before any transport, with no `await`
 * between the comparison and the increment, so concurrent callers cannot all pass a
 * stale check. A reservation is NEVER refunded: a timeout, a connection failure, an
 * abort, a non-2xx or an unparseable response all leave it counted. `max === 0` means
 * NO POST is ever allowed (it is NOT "unlimited").
 */
export interface LayaPostBudget {
  /** The hard cap on POST reservations for the round. 0 forbids every POST. */
  readonly max: number;
  /** Reservations taken. Incremented before transport; never refunded. */
  reserved: number;
  /** Transmissions actually started. Never exceeds `reserved`. */
  used: number;
  /** Set true when a POST was REFUSED because the budget was already exhausted. */
  rejected: boolean;
}

/**
 * Creates the one shared budget object for a round.
 *
 * `max` must be a nonnegative SAFE integer. Anything else (a boolean from a bare
 * flag, `-1`, `1.5`, `NaN`, `Infinity`, a string, an unsafe integer) is a
 * programming/CLI error and is refused here rather than silently coerced into a cap
 * that is not the one the user asked for.
 */
export function createLayaPostBudget(max: number): LayaPostBudget {
  if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 0) {
    throw new DecisionInputError(
      `post budget max is ${describe(max)}, expected a nonnegative safe integer ` +
        `(0 forbids every POST; there is no "unlimited" sentinel)`,
    );
  }
  return { max, reserved: 0, used: 0, rejected: false };
}

/** The truthful machine-readable snapshot of a round's POST budget. */
export interface LayaPostBudgetReport {
  readonly enabled: true;
  readonly max: number;
  /** Reservations taken (incremented before transport; never refunded). */
  readonly reserved: number;
  /** Transmissions actually started. */
  readonly used: number;
  /** max - reserved, floored at 0. A consumed reservation is never returned. */
  readonly remaining: number;
  readonly exhausted: boolean;
  /** Whether at least one POST was refused because the budget was exhausted. */
  readonly rejected: boolean;
}

/** Takes a plain snapshot of the budget. Does not mutate it. */
export function readLayaPostBudgetReport(budget: LayaPostBudget): LayaPostBudgetReport {
  return {
    enabled: true,
    max: budget.max,
    reserved: budget.reserved,
    used: budget.used,
    remaining: Math.max(0, budget.max - budget.reserved),
    exhausted: budget.reserved >= budget.max,
    rejected: budget.rejected,
  };
}

/**
 * MVP-E2E.1a: wraps bytes in a ONE-SHOT `ReadableStream`.
 *
 * Node's built-in fetch (Undici) extracts `body.source` from a string, typed array,
 * `Blob`, etc., so it can replay the body for its automatic HTTP-421 retry. A
 * `ReadableStream` yields `body.source === null`, so that replay is impossible: one
 * `fetch` call is one transmission, even when the server answers 421. The bytes are
 * enqueued once and the stream is closed, so the body is still delivered in full.
 */
function oneShotBody(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Rejects a request that cannot produce an informative answer.
 *
 * The one-option cases matter most: laya-serve returns that option with HTTP
 * 200, forever, for every input. Accepting that would report a confident,
 * constant "decision" that carries no information at all.
 */
/**
 * Rejects a request that cannot produce an informative answer.
 *
 * This function is also the layer's runtime type guard. A caller in JavaScript
 * (or one reading unvalidated JSON) can hand over `null`, a string, a number, an
 * array where an object belongs, or a state whose values are not strings. Every
 * one of those becomes a `DecisionInputError` with a usable message -- never a
 * TypeError from `Object.keys(null)`, and never a silently coerced value.
 *
 * The one-option cases matter most: laya-serve returns that option with HTTP
 * 200, forever, for every input. Accepting that would report a confident,
 * constant "answer" that carries no information at all.
 */
function validateRequest(request: unknown): Record<string, string> {
  if (!isRecord(request)) {
    throw new DecisionInputError(
      `request is ${request === null ? 'null' : request === undefined ? 'undefined' : describe(request)}, expected an object`,
    );
  }
  const questions = request.questions;
  if (!isRecord(questions)) {
    throw new DecisionInputError(
      `"questions" is ${describe(questions)}, expected an object of question id -> question`,
    );
  }
  const ids = Object.keys(questions);
  if (ids.length === 0) {
    throw new DecisionInputError(
      'no questions were asked, so there is nothing to decide; ' +
        'a request with zero questions cannot produce an answer',
    );
  }
  if (ids.length > MAX_QUESTIONS) {
    throw new DecisionInputError(`asked ${ids.length} questions, over laya's limit of ${MAX_QUESTIONS}`);
  }

  let totalOptions = 0;

  for (const id of ids) {
    const where = `question "${id}"`;
    if (id.trim().length === 0) {
      throw new DecisionInputError(`${where} has an empty id; every question needs a non-empty id to key its answer`);
    }
    const q = questions[id];
    if (!isRecord(q)) {
      throw new DecisionInputError(`${where} is ${describe(q)}`);
    }
    const kind: unknown = q.type;
    if (typeof q.instructions !== 'string' || q.instructions.trim().length === 0) {
      throw new DecisionInputError(
        `${where} has "instructions" that is ${describe(q.instructions)}, expected a non-empty string`,
      );
    }

    if (kind === 'choice') {
      const criteria = q.criteria;
      if (!isRecord(criteria)) {
        throw new DecisionInputError(
          `${where} is a choice but its "criteria" is ${describe(criteria)}, ` +
            `expected an object mapping each choice to its description`,
        );
      }
      const choices = Object.keys(criteria);
      if (choices.length === 0) {
        throw new DecisionInputError(`${where} offers no choices, so there is nothing to choose`);
      }
      if (choices.length === 1) {
        throw new DecisionInputError(
          `${where} offers exactly one choice (${JSON.stringify(choices[0])}), which laya would return for ` +
            `every input at full confidence. Offer at least two, or the answer carries no information.`,
        );
      }
      if (choices.length > MAX_CHOICE_OPTIONS) {
        throw new DecisionInputError(`${where} offers ${choices.length} choices, over laya's limit of ${MAX_CHOICE_OPTIONS}`);
      }
      // A choice with no description is not a choice the model can reason about,
      // so it would be a silent extra option. The key is what comes back, so it
      // is checked too.
      for (const key of choices) {
        if (key.trim().length === 0) {
          throw new DecisionInputError(`${where} has a choice with an empty key`);
        }
        const desc = criteria[key];
        if (typeof desc !== 'string' || desc.trim().length === 0) {
          throw new DecisionInputError(
            `${where} choice ${JSON.stringify(key)} has description ${describe(desc)}, expected a non-empty string`,
          );
        }
      }
      totalOptions += choices.length;
    } else if (kind === 'score') {
      const levels = q.criteria;
      if (!Array.isArray(levels)) {
        throw new DecisionInputError(
          `${where} is a score but its "criteria" is ${describe(levels)}, expected an ordered array of level descriptions`,
        );
      }
      if (levels.length < 2) {
        throw new DecisionInputError(
          `${where} is a score with ${levels.length} level(s); a single level would return the same score for every input`,
        );
      }
      if (levels.length > MAX_SCORE_LEVELS) {
        throw new DecisionInputError(`${where} offers ${levels.length} levels, over laya's limit of ${MAX_SCORE_LEVELS}`);
      }
      for (let i = 0; i < levels.length; i++) {
        const level = (levels as unknown[])[i];
        if (typeof level !== 'string' || level.trim().length === 0) {
          throw new DecisionInputError(`${where} level ${i} is ${describe(level)}, expected a non-empty string`);
        }
      }
      totalOptions += levels.length;
    } else if (kind === 'noul') {
      // A noul has no answer space, so `criteria` here is a description of the
      // two outcomes, not options to choose between. Verified against
      // laya/agent.py: a dict is accepted, but its keys must be a subset of
      // {"true", "false"} -- the model reads only criteria["true"] and
      // criteria["false"], so any other key would be silently dropped and the
      // caller's wording would never reach the model. Either key, both, or an
      // empty dict are all fine.
      const criteria = q.criteria;
      if (criteria === undefined) {
        // omitted: the provider supplies its own default wording
      } else if (!isRecord(criteria)) {
        throw new DecisionInputError(
          `${where} is a noul whose "criteria" is ${describe(criteria)}, expected an object keyed ` +
            `"true" and/or "false" describing the two outcomes, or omitted`,
        );
      } else {
        for (const [key, value] of Object.entries(criteria)) {
          if (key.toLowerCase() !== 'true' && key.toLowerCase() !== 'false') {
            throw new DecisionInputError(
              `${where} is a noul with criteria key ${JSON.stringify(key)}, but a noul is a boolean ` +
                `question whose only keys are "true" and "false". The provider reads only those two, ` +
                `so any other key would be silently dropped. Use { "true": ..., "false": ... }.`,
            );
          }
          // Stricter than the provider on purpose: an empty description is
          // silently replaced by the default wording, and a structured value is
          // JSON-marshalled into the prompt. Both would leave the caller
          // believing they chose the wording when they did not, so they are
          // refused here with a message that says what to do instead.
          if (typeof value !== 'string' || value.trim().length === 0) {
            throw new DecisionInputError(
              `${where} noul criteria ${JSON.stringify(key)} is ${describe(value)}, expected a non-empty ` +
                `description string. Omit the key entirely to use the default wording.`,
            );
          }
        }
      }
    } else {
      throw new DecisionInputError(
        `${where} has type ${describe(kind)}, expected one of ["choice", "score", "noul"]`,
      );
    }
  }

  if (totalOptions > MAX_TOTAL_OPTIONS) {
    throw new DecisionInputError(
      `the questions offer ${totalOptions} options in total, over laya's limit of ${MAX_TOTAL_OPTIONS}`,
    );
  }

  // Build the state. `task` is a shorthand for the common single-text case.
  const state: Record<string, string> = {};

  if (request.state !== undefined) {
    if (!isRecord(request.state)) {
      throw new DecisionInputError(`"state" is ${describe(request.state)}, expected an object of string values`);
    }
    for (const [k, v] of Object.entries(request.state)) {
      if (typeof v !== 'string') {
        throw new DecisionInputError(`state field ${JSON.stringify(k)} is ${describe(v)}, expected a string`);
      }
      state[k] = v;
    }
  }
  if (request.task !== undefined) {
    if (typeof request.task !== 'string') {
      throw new DecisionInputError(`"task" is ${describe(request.task)}, expected a string`);
    }
    state[TASK_FIELD] = request.task;
  }
  if (request.context !== undefined) {
    if (!isRecord(request.context)) {
      throw new DecisionInputError(`"context" is ${describe(request.context)}, expected an object of string values`);
    }
    for (const [k, v] of Object.entries(request.context)) {
      if (typeof v !== 'string') {
        throw new DecisionInputError(`context field ${JSON.stringify(k)} is ${describe(v)}, expected a string`);
      }
      state[k] = v;
    }
  }
  if (Object.keys(state).length === 0) {
    throw new DecisionInputError('nothing to read: set "task", "state" or "context" so the questions have something to look at');
  }

  const serialized = JSON.stringify(state);
  if (serialized.length > MAX_STATE_CHARS) {
    throw new DecisionInputError(
      `state is ${serialized.length} chars, over laya's limit of ${MAX_STATE_CHARS}; ` +
        `summarise the input instead of truncating it silently`,
    );
  }
  return state;
}

/** The envelope after validation: the parts this provider actually reads. */
interface ValidEnvelope {
  readonly model: string;
  readonly answers: Readonly<Record<string, Record<string, unknown>>>;
  readonly routing: Record<string, unknown>;
  readonly usage: Record<string, unknown>;
  readonly raw: Record<string, unknown>;
}

/** Validates the envelope before any field is read as an answer. */
function validateEnvelope(body: unknown, expectedIds: readonly string[]): ValidEnvelope {
  if (!isRecord(body)) {
    throw new DecisionSchemaError(`response body is ${describe(body)}, expected an object`);
  }
  if (typeof body.model !== 'string' || body.model.length === 0) {
    throw new DecisionSchemaError(`response is missing a string "model" (got ${describe(body.model)})`);
  }
  if (!isRecord(body.answers)) {
    throw new DecisionSchemaError(`response is missing an "answers" object (got ${describe(body.answers)})`);
  }
  const gotIds = Object.keys(body.answers);
  if (gotIds.length === 0) {
    throw new DecisionSchemaError(
      `provider answered with no questions at all ("answers" is empty), so there is nothing to decide on`,
    );
  }
  // A 200 that answers only part of what was asked is not a decision either.
  for (const id of expectedIds) {
    if (!isRecord(body.answers[id])) {
      throw new DecisionSchemaError(
        `response has no answer for question "${id}" (got keys: ${gotIds.join(', ') || 'none'})`,
      );
    }
  }
  return {
    model: body.model,
    answers: body.answers as Record<string, Record<string, unknown>>,
    routing: isRecord(body.routing) ? body.routing : {},
    usage: isRecord(body.usage) ? body.usage : {},
    raw: body,
  };
}

/**
 * TOLERANCES -- three separate bounds, each the smallest that provably cannot
 * reject a genuine response.
 *
 * The service serialises every probability and every score with `round(x, 4)`
 * (laya/agent.py), so each reported value differs from the true one by at most
 * half a unit in the fourth decimal:
 *
 *     HALF = 5e-5     |p_reported[i] - p_true[i]| <= HALF
 *
 * The previous single `2 * HALF * k^2` was used for all three checks. That is
 * wrong, and wrong in the dangerous direction: at k = 100 it is 1.0, so a
 * distribution summing to 0, or a confidence 0.98 away from its own maximum,
 * passes. Each bound below is derived for the quantity actually being compared.
 *
 * (A) SUM. |Σ p_rep - 1| = |Σ (p_rep[i] - p_true[i])| <= k * HALF. Grows
 *     linearly, because every one of the k terms contributes its own rounding
 *     error and they add.
 *
 * (B) CONFIDENCE. Compared against a single value, the maximum. The reported
 *     confidence is round(max(p_true), 4) and the reported maximum is
 *     round(p_true[j], 4) for whichever j attains it; rounding is monotone, so
 *     these coincide, and the residual bound is two rounding steps:
 *
 *         |conf_rep - max(p_rep)| <= HALF + HALF = 2 * HALF
 *
 *     Crucially this is O(1) in k. Only one term is involved, so a wider answer
 *     space buys no more slack -- which is the whole point: at k = 100 this is
 *     1e-4, not 1.0.
 *
 * (C) EXPECTATION. Compared against a weighted sum, so error genuinely does
 *     accumulate with the index:
 *
 *         |score_rep - Σ(i·p_rep[i])|
 *             <= HALF                            (rounding of the score)
 *               + Σ(i) * HALF                    (each term, weighted by i)
 *             = HALF * (1 + k(k-1)/2)
 *
 *     This is the one check that legitimately needs a quadratic term, and only
 *     because it is a weighted sum. It is derived, not borrowed: for k = 32 it
 *     is 0.025, and it is still small compared to the "off by half a level"
 *     error the check exists to catch.
 *
 * Each bound is an upper bound on the real error, not a fudge factor, so a small
 * epsilon is added only for double-precision arithmetic in the comparison.
 */
const ROUNDING_HALF_STEP = 5e-5;
const FLOAT_EPSILON = 1e-9;

/** (A) how far Σ probabilities may sit from 1. Linear in k. */
function sumTolerance(k: number): number {
  return ROUNDING_HALF_STEP * k + FLOAT_EPSILON;
}

/** (B) how far answer_confidence may sit from max(probabilities). Constant in k. */
function confidenceTolerance(): number {
  return 2 * ROUNDING_HALF_STEP + FLOAT_EPSILON;
}

/** (C) how far a score may sit from Σ(i · p[i]). Quadratic, because it is a weighted sum. */
function expectationTolerance(k: number): number {
  return ROUNDING_HALF_STEP * (1 + (k * (k - 1)) / 2) + FLOAT_EPSILON;
}

/**
 * Rejects a distribution that does not cover exactly the declared answer space.
 *
 * Extra keys are refused as well as missing ones: the provider is supposed to
 * describe the space the request offered, so an index it invented is as
 * untrustworthy as one it left out, and silently dropping it would hide a
 * provider that is not answering the question that was asked.
 */
function readDistribution(
  id: string,
  raw: Record<string, unknown>,
  keys: readonly string[],
  keyLabel: (key: string) => string,
): Record<string, number> {
  const probabilitiesRaw = raw.probabilities;
  if (!isRecord(probabilitiesRaw)) {
    throw new DecisionSchemaError(
      `answer "${id}" is missing a "probabilities" distribution (got ${describe(probabilitiesRaw)})`,
    );
  }
  const expected = new Set(keys);
  const extra = Object.keys(probabilitiesRaw).filter((k) => !expected.has(k));
  if (extra.length > 0) {
    throw new DecisionSchemaError(
      `answer "${id}" reports probabilities for ${extra.map((k) => JSON.stringify(k)).join(', ')}, ` +
        `which this request did not offer; expected exactly [${keys.join(', ')}]`,
    );
  }
  const out: Record<string, number> = {};
  for (const key of keys) {
    out[key] = requireProbability(probabilitiesRaw[key], `answer "${id}" probability for ${keyLabel(key)}`);
  }
  return out;
}

/** A distribution over a probability space must sum to 1. Uses bound (A). */
function requireNormalized(id: string, probabilities: Record<string, number>, what: string): void {
  const values = Object.values(probabilities);
  const sum = values.reduce((a, b) => a + b, 0);
  const tol = sumTolerance(values.length);
  if (Math.abs(sum - 1) > tol) {
    throw new DecisionSchemaError(
      `answer "${id}" has a ${what} distribution summing to ${sum.toFixed(6)}, not 1 ` +
        `(tolerance ${tol.toExponential(2)}). A distribution that is not a probability distribution ` +
        `cannot be thresholded, so it is not trusted.`,
    );
  }
}

/**
 * `answer_confidence` is `max(probabilities)` for choice and score
 * (`laya/common.py:answer_confidence`). Checking only that it lies in [0, 1]
 * would let `probabilities: {a: 0.01, b: 0.99}` pass with
 * `answer_confidence: 0.99`, which asserts certainty the distribution denies.
 * Uses bound (B), which does not grow with the size of the answer space.
 */
/**
 * Validates Laya's optional per-answer `action` metadata, if present.
 *
 * Laya 0.3.21 (verified against the installed 0.3.21 and tag v0.3.21,
 * commit 6ab71fb4) attaches `"action": {"act_probability": 1}` to the work_kind
 * choice, the complexity score AND the review_required noul alike. It is the
 * provider's own record of how strongly the model acted on the answer, so it is
 * METADATA, not a task parameter: receiving it on a real response must not turn
 * an otherwise valid classification into a schema failure.
 *
 * The smallest honest boundary is therefore to recognise exactly this one
 * official field and validate its shape, rather than to start accepting
 * arbitrary objects among the string parameters. A present `action` must be a
 * non-array object carrying a finite numeric `act_probability` in [0, 1];
 * anything else is refused as DECISION_SCHEMA. `act_probability` is deliberately
 * not exposed through any new API and is not used for admission or reliability
 * decisions -- it is only checked for shape. The verbatim object remains in
 * `response.raw`, which is where unvalidated provider detail already lives.
 */
function requireActionMetadata(id: string, raw: Record<string, unknown>): void {
  const action = raw.action;
  if (action === undefined) return;
  if (!isRecord(action)) {
    throw new DecisionSchemaError(
      `answer "${id}" action metadata is ${describe(action)}, expected an object carrying a numeric act_probability`,
    );
  }
  requireProbability(action.act_probability, `answer "${id}" action metadata act_probability`);
}

/**
 * Read a `choice` answer's parameters from its sibling keys.
 *
 * Reserved keys (`choice`, `probabilities`, `confidence`, `criteria`) belong to the
 * answer envelope and are skipped; everything else is a parameter the model supplied.
 * A non-string value is REFUSED rather than coerced — a provider that sends
 * `{"taskId": 7}` or a nested object gets a schema error naming the key, instead of
 * having it silently stringified into something the orchestration layer would then have
 * to guess at.
 */
function readChoiceParameters(id: string, raw: Record<string, unknown>): { parameters?: Record<string, string> } {
  // The envelope keys the SHIPPED protocol puts on every answer, reserved by name.
  // `answer_confidence` is the one that matters here: it is a number the provider
  // already sends, and treating it as a parameter would both fail-closed on a perfectly
  // good answer and hide it from the caller. The list is derived from the fields this
  // file reads off `raw`, not guessed.
  const RESERVED = new Set([
    'type', 'choice', 'score', 'noul', 'legend', 'probabilities', 'confidence', 'answer_confidence', 'criteria',
    // Laya 0.3.21 attaches an optional per-answer `action` object (see
    // requireActionMetadata). It is provider metadata, not a task parameter, so it
    // is reserved here and never read into `parameters`.
    'action',
  ]);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (RESERVED.has(key)) continue;
    if (typeof value !== 'string') {
      throw new DecisionSchemaError(
        `answer "${id}" parameter "${key}" is ${describe(value)}; parameters must be strings, ` +
          `because the Decision Layer does not know what any given parameter means and ` +
          `refuses to guess at its shape`,
      );
    }
    out[key] = value;
  }
  return Object.keys(out).length === 0 ? {} : { parameters: out };
}

function requireAnswerConfidence(
  id: string,
  raw: Record<string, unknown>,
  probabilities: Record<string, number>,
): Probability {
  const reported = requireProbability(raw.answer_confidence, `answer "${id}" answer_confidence`);
  const max = Math.max(...Object.values(probabilities));
  const tol = confidenceTolerance();
  if (Math.abs(reported - max) > tol) {
    throw new DecisionSchemaError(
      `answer "${id}" is self-contradictory: it reports answer_confidence ${reported.toFixed(4)}, ` +
        `but the highest probability in its own distribution is ${max.toFixed(4)} ` +
        `(tolerance ${tol.toExponential(2)}). answer_confidence is defined as max(probabilities), ` +
        `so the two cannot disagree.`,
    );
  }
  return reported;
}

/**
 * Validates one answer against the question that asked for it.
 *
 * Everything checked here comes from how the service actually builds an answer,
 * not from a general statistical principle. From `laya/agent.py`:
 *
 *   choice  choice = keys[argmax(p)],  probabilities = p, answer_confidence = max(p)
 *   score   score = round(Σ(i * p_i), 4),  legend = {str(i): criteria[i]},
 *           probabilities = p, answer_confidence = max(p)
 *   noul    noul = p[1], NO probabilities at all, answer_confidence = max(p)
 *
 * The critical consequence is that `score` is an EXPECTATION, not an argmax, so
 * it must NOT be checked with the argmax rule used for `choice`. A legitimate
 * answer routinely has `round(score) != argmax(p)`; what must hold is that
 * `score` equals the expectation of the distribution reported beside it.
 */
function validateAnswer(id: string, raw: Record<string, unknown>, question: DecisionQuestion): DecisionAnswer {
  // The answer must be the kind that was asked for. Without this, a score answer
  // could satisfy a choice question, or vice versa.
  if (raw.type !== question.type) {
    throw new DecisionSchemaError(
      `answer "${id}" is of type ${describe(raw.type)}, but a ${question.type} question was asked`,
    );
  }

  // Laya 0.3.21 adds an optional `action` metadata object to choice, score and
  // noul answers alike. Validated once here so the same boundary applies to all
  // three kinds, and so it is excluded from the choice `parameters` below.
  requireActionMetadata(id, raw);

  // ---- choice: the reported option must be the most likely one ----
  if (question.type === 'choice') {
    const offered = Object.keys(question.criteria);
    const choice = raw.choice;
    if (typeof choice !== 'string' || !offered.includes(choice)) {
      throw new DecisionSchemaError(
        `answer "${id}" chose ${describe(choice)}, which is outside the choices this request ` +
          `offered [${offered.join(', ')}]`,
      );
    }
    const probabilities = readDistribution(id, raw, offered, (k) => JSON.stringify(k));
    requireNormalized(id, probabilities, 'choice');
    // Consistency: the chosen option must be a maximum of the reported
    // distribution, otherwise the answer contradicts itself. Ties are accepted,
    // because with equal mass either option is a legitimate argmax.
    const chosen = probabilities[choice];
    for (const key of offered) {
      if (probabilities[key] > chosen) {
        throw new DecisionSchemaError(
          `answer "${id}" is self-contradictory: it chose ${JSON.stringify(choice)} at probability ` +
            `${chosen.toFixed(4)}, but its own distribution gives ${JSON.stringify(key)} a higher ` +
            `${probabilities[key].toFixed(4)}. The reported choice is the most likely option, so the ` +
            `answer and the distribution disagree.`,
        );
      }
    }
    return {
      type: 'choice',
      choice,
      criteria: question.criteria,
      probabilities,
      confidence: requireAnswerConfidence(id, raw, probabilities),
      // Every sibling key of `choice` that is not part of the answer envelope is read as
      // a PARAMETER of the chosen option. That is the whole mechanism by which a model
      // can return `{"choice":"reassign","taskId":"t1","agentId":"opencode"}` — without
      // it the action is selectable but its target is unreportable, and the caller has to
      // invent it afterwards.
      ...readChoiceParameters(id, raw),
    };
  }

  // ---- score: the reported value must be the distribution's expectation ----
  if (question.type === 'score') {
    const levels = question.criteria;
    const probabilities = readDistribution(id, raw, levels.map((_, i) => String(i)), (k) => `level ${k}`);
    requireNormalized(id, probabilities, 'score');

    // The legend is the provider's own restatement of the levels. Laya builds it
    // as {str(i): criteria[i]}, so it must match the request index for index. A
    // legend that disagrees -- reordered, renamed, or simply wrong -- means the
    // provider is describing a different question, so it is refused rather than
    // allowed to redefine what the numbers mean.
    const legend = raw.legend;
    if (!isRecord(legend)) {
      throw new DecisionSchemaError(`answer "${id}" is missing its "legend" mapping index -> level`);
    }
    for (let i = 0; i < levels.length; i++) {
      const entry = legend[String(i)];
      if (entry !== levels[i]) {
        throw new DecisionSchemaError(
          `answer "${id}" has a legend that disagrees with the levels this request offered at index ` +
            `${i}: legend says ${describe(entry)}, the request asked for ${JSON.stringify(levels[i])}. ` +
            `The legend must be {String(i): criteria[i]} exactly, or the answer describes a different question.`,
        );
      }
    }

    const score = raw.score;
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      throw new DecisionSchemaError(
        `answer "${id}" score is ${describe(score)}, expected a finite number`,
      );
    }
    const index = Math.round(score);
    if (index < 0 || index >= levels.length) {
      throw new DecisionSchemaError(
        `answer "${id}" scored ${score}, which rounds to index ${index}, outside the ` +
          `0..${levels.length - 1} range of the ${levels.length} levels this request offered`,
      );
    }

    // The core check: score must be the expectation of the distribution that
    // ships with it. This is what an argmax check would get WRONG -- a score
    // answer legitimately has round(score) != argmax(p).
    const expectation = levels.reduce((acc, _level, i) => acc + i * probabilities[String(i)], 0);
    const tol = expectationTolerance(levels.length);
    if (Math.abs(score - expectation) > tol) {
      throw new DecisionSchemaError(
        `answer "${id}" is self-contradictory: it scored ${score.toFixed(4)}, but the expectation of its ` +
          `own distribution is ${expectation.toFixed(4)} (tolerance ${tol.toExponential(2)}). ` +
          `Σ(i * probabilities[i]) is the definition of this score, so the two cannot disagree.`,
      );
    }

    return {
      type: 'score',
      score,
      // Taken from the request's own levels, which the legend was just required
      // to match. A provider cannot redefine a level by labelling it differently.
      level: levels[index],
      levels: [...levels],
      probabilities,
      confidence: requireAnswerConfidence(id, raw, probabilities),
    };
  }

  // ---- noul: a bare likelihood, with no distribution to check ----
  // laya/agent.py sends no `probabilities` for a noul, so requiring one would
  // reject every real response. It does define noul = p[1] and
  // answer_confidence = max(p) over the two-way split, which reduces to
  // max(noul, 1 - noul) -- so the same consistency guarantee is still available
  // without a distribution.
  const probabilities: Record<string, number> = {};
  if (raw.probabilities !== undefined) {
    if (!isRecord(raw.probabilities)) {
      throw new DecisionSchemaError(`answer "${id}" has a "probabilities" that is ${describe(raw.probabilities)}`);
    }
    for (const [k, v] of Object.entries(raw.probabilities)) {
      probabilities[k] = requireProbability(v, `answer "${id}" probability for ${JSON.stringify(k)}`);
    }
  }
  const noul = requireProbability(raw.noul, `answer "${id}" noul`);
  const confidence = requireProbability(raw.answer_confidence, `answer "${id}" answer_confidence`);
  const impliedMax = Math.max(noul, 1 - noul);
  // Two options, so this is bound (B) with k = 2: the reported `noul` was itself
  // rounded to 4dp, and the provider's confidence came from the unrounded pair.
  const noulTol = confidenceTolerance();
  if (Math.abs(confidence - impliedMax) > noulTol) {
    throw new DecisionSchemaError(
      `answer "${id}" is self-contradictory: it reports answer_confidence ${confidence.toFixed(4)} for ` +
        `noul ${noul.toFixed(4)}, but max(noul, 1 - noul) is ${impliedMax.toFixed(4)} ` +
        `(tolerance ${noulTol.toExponential(2)}). A noul has no probability distribution, so this is the ` +
        `only consistency available for it.`,
    );
  }
  return { type: 'noul', noul, probabilities, confidence };
}


function readProviderMetadata(envelope: ValidEnvelope, name: string, elapsedMs: number): ProviderMetadata {
  const routing = envelope.routing;
  const detection = isRecord(routing.detection) ? routing.detection : {};
  return {
    name,
    model: envelope.model,
    elapsedMs,
    // Laya's own vocabulary stays here, behind `layaMetadata()`, so the generic
    // ProviderMetadata does not grow a second provider's field names.
    details: {
      checkpoint: typeof routing.model === 'string' ? routing.model : 'unknown',
      reason: typeof routing.reason === 'string' ? routing.reason : 'not reported',
      script: typeof detection.script === 'string' ? detection.script : null,
      language: typeof detection.language === 'string' ? detection.language : null,
      revisions: isRecord(routing.revisions) ? routing.revisions : {},
      inputTokens: envelope.usage.input_tokens,
      outputTokens: envelope.usage.output_tokens,
    },
  };
}

export function createLayaDecisionProvider(options: LayaProviderOptions = {}): DecisionProvider {
  // Throws a DecisionInputError for a malformed or non-loopback baseUrl. This is
  // a configuration error, not a runtime decision failure, so it surfaces at
  // construction rather than on the first classify call.
  const baseUrl = resolveBaseUrl(options.baseUrl, options.allowRemote === true);
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const name = 'laya';
  // MVP-E2E.1a: an absent budget is `null` (no cap, previous behaviour). A supplied
  // one is validated rather than trusted, so a hand-built object with a bad `max`
  // cannot make the comparison below meaningless.
  const postBudget: LayaPostBudget | null = options.postBudget ?? null;
  if (postBudget !== null) {
    if (typeof postBudget.max !== 'number' || !Number.isSafeInteger(postBudget.max) || postBudget.max < 0) {
      throw new DecisionInputError(
        `postBudget.max is ${describe(postBudget.max)}, expected a nonnegative safe integer`,
      );
    }
  }

  async function post(path: string, payload: unknown): Promise<Response> {
    // MVP-E2E.1a: reserve BEFORE any transport, with NO `await` between the compare and
    // the increment, so ten concurrent callers with max 3 cannot all pass a stale check.
    // The reservation is never refunded.
    if (postBudget !== null) {
      if (postBudget.reserved >= postBudget.max) {
        postBudget.rejected = true;
        throw new DecisionError(
          'DECISION_POST_BUDGET_EXHAUSTED',
          `the per-round POST budget of ${postBudget.max} is exhausted ` +
            `(${postBudget.reserved} reservation(s) already taken, ${postBudget.used} sent). ` +
            `This request was refused BEFORE it reached the network. The budget is a hard cap per ` +
            `round, and a failed, timed-out, aborted or unparseable request is not refunded.`,
        );
      }
      postBudget.reserved += 1;
    }
    const url = `${baseUrl}${path}`;
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      throw new DecisionInputError(
        `the decision request is ${Buffer.byteLength(body, 'utf8')} bytes, over laya's ${MAX_BODY_BYTES} byte body limit; ` +
          `shorten the task or split it, rather than letting the server reject it with 413`,
      );
    }
    const signal = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      if (postBudget === null) {
        // UNBUDGETED: byte-for-byte the previous request - a replayable string body and
        // no redirect option - so compatibility is preserved exactly.
        res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal,
        });
      } else {
        postBudget.used += 1;
        // BUDGETED: a ONE-SHOT stream body plus `redirect: 'error'`, so the built-in
        // fetch cannot silently turn one reservation into more than one transmission.
        //
        // Undici (Node's fetch) automatically retries an HTTP 421 when
        // `request.body.source != null`. A string/typed-array body has a source, so it
        // CAN be replayed and the wire would see a second POST that no reservation
        // covers. A `ReadableStream` has `body.source === null`, so the 421 branch is
        // skipped and one call is one POST. `redirect: 'error'` refuses to FOLLOW a 3xx
        // (rather than following it), so a 307/308 cannot spawn an extra POST at a
        // redirect target. The JSON bytes and the content type are unchanged.
        res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: oneShotBody(Buffer.from(body, 'utf8')),
          signal,
          redirect: 'error',
          // Required by Undici when the body is a stream. The whole body is already
          // enqueued, so the half-duplex flow is complete after one chunk.
          duplex: 'half',
        });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // A timeout and a refused connection are different operator problems, so
      // they are not collapsed into one error.
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new DecisionTimeoutError(url, timeoutMs);
      }
      throw new DecisionUnavailableError(url, detail);
    }
    if (!res.ok) {
      let text = '';
      try {
        text = (await res.text()).slice(0, 500);
      } catch {
        text = '(response body could not be read)';
      }
      throw new DecisionTransportError(url, res.status, text);
    }
    return res;
  }

  /**
   * Reads a health payload without ever letting a parse failure escape.
   *
   * `probe()` is a diagnostic, so it reports rather than throws: an unreachable
   * service, a non-2xx, malformed JSON, and a structurally invalid payload all
   * come back as `{ ok: false, detail }`. A SyntaxError escaping to the caller
   * would turn a "the service is not ready" question into a crash in whatever
   * code asked it.
   */
  async function readHealth(url: string, signal: AbortSignal): Promise<DecisionProbe> {
    let res: Response;
    try {
      res = await doFetch(url, { signal });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, endpoint: url, detail, warnings: [] };
    }
    if (!res.ok) {
      return { ok: false, endpoint: url, detail: `HTTP ${res.status}`, warnings: [] };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      return {
        ok: false,
        endpoint: url,
        detail: `health response is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
        warnings: [],
      };
    }
    if (!isRecord(body)) {
      return { ok: false, endpoint: url, detail: `health payload is ${describe(body)}, expected an object`, warnings: [] };
    }
    if (typeof body.status !== 'string') {
      return { ok: false, endpoint: url, detail: `health payload has no string "status" (got ${describe(body.status)})`, warnings: [] };
    }
    const health = body as HealthPayload;
    // `loaded` must be a list of strings when present; anything else means the
    // payload does not match the documented shape and cannot be trusted.
    if (health.loaded !== undefined && !isStringArray(health.loaded)) {
      return { ok: false, endpoint: url, detail: `health payload "loaded" is ${describe(health.loaded)}, expected an array of strings`, warnings: [] };
    }
    if (health.device !== undefined && typeof health.device !== 'string') {
      return { ok: false, endpoint: url, detail: `health payload "device" is ${describe(health.device)}, expected a string`, warnings: [] };
    }
    const loaded = (health.loaded ?? []) as readonly string[];
    const warnings: string[] = [];
    // A CPU fallback still answers, but at a latency and accuracy this
    // orchestrator should not silently accept.
    if (health.cpu_fallbacks !== undefined) {
      if (!isRecord(health.cpu_fallbacks)) {
        return { ok: false, endpoint: url, detail: `health payload "cpu_fallbacks" is ${describe(health.cpu_fallbacks)}, expected an object`, warnings: [] };
      }
      for (const [ckpt, info] of Object.entries(health.cpu_fallbacks)) {
        if (!isRecord(info) || typeof info.count !== 'number' || !Number.isFinite(info.count)) {
          return {
            ok: false,
            endpoint: url,
            detail: `health payload "cpu_fallbacks.${ckpt}" is ${describe(info)}, expected { count: number, last_reason?: string }`,
            warnings: [],
          };
        }
        // `last_reason` is documented as a string, and the service emits null
        // when there is no reason. Anything else is not the documented shape.
        if (info.last_reason !== undefined && info.last_reason !== null && typeof info.last_reason !== 'string') {
          return {
            ok: false,
            endpoint: url,
            detail: `health payload "cpu_fallbacks.${ckpt}.last_reason" is ${describe(info.last_reason)}, expected a string or null`,
            warnings: [],
          };
        }
        if (info.count > 0) {
          const reason = asNonEmptyString(info.last_reason);
          warnings.push(
            `checkpoint "${ckpt}" has fallen back to CPU ${info.count}x` + (reason ? ` (last: ${reason})` : ''),
          );
        }
      }
    }
    if (loaded.length === 0) {
      warnings.push('no checkpoints are loaded; start laya-serve with --preload for predictable latency');
    }
    return {
      ok: health.status === 'ok',
      endpoint: url,
      detail: `status=${health.status} device=${typeof health.device === 'string' ? health.device : 'unknown'} loaded=[${loaded.join(', ')}]`,
      warnings,
    };
  }

  return {
    name,

    probe: () => readHealth(`${baseUrl}/health`, AbortSignal.timeout(Math.min(timeoutMs, 5_000))),

    async decide(request: DecisionRequest): Promise<DecisionResponse> {
      // Refuse before spending a request on a question that cannot inform.
      const state = validateRequest(request);
      const questions = (request as { questions: Readonly<Record<string, DecisionQuestion>> }).questions;
      const ids = Object.keys(questions);

      const started = performance.now();
      const res = await post('/v1/systemone', { state, questions });
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        throw new DecisionSchemaError('response body is not valid JSON');
      }
      const envelope = validateEnvelope(parsed, ids);
      const elapsedMs = Math.round(performance.now() - started);

      const answers: Record<string, DecisionAnswer> = {};
      for (const id of ids) {
        answers[id] = validateAnswer(id, envelope.answers[id], questions[id]);
      }

      return {
        answers,
        provider: readProviderMetadata(envelope, name, elapsedMs),
        raw: envelope.raw,
      };
    },
  };
}

function isStringArray(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}
