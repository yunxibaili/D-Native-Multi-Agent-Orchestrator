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
  const isLoopback = host === 'localhost' || host === '::1' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (!isLoopback && !allowRemote) {
    throw new DecisionInputError(
      `baseUrl host ${JSON.stringify(host)} is not loopback. This is a local-only project that makes no ` +
        `provider API calls, and a decision request carries the task text, so a remote endpoint would send ` +
        `task content to another machine. Use 127.0.0.1 / ::1 / localhost, or pass allowRemote: true if that ` +
        `is genuinely intended`,
    );
  }
  const normalized = url.toString().replace(/\/+$/, '');
  return normalized;
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
      // A noul has no answer space. Measured against laya-serve: supplying
      // `criteria` anyway is rejected server-side with 422, so it is refused here
      // rather than spending a round trip to learn something already known.
      if (q.criteria !== undefined) {
        throw new DecisionInputError(
          `${where} is a noul question, which has no answer space, but it carries "criteria" ${describe(q.criteria)}. ` +
            `laya-serve rejects noul+criteria with 422 ("a noul question takes 'criteria' as a dict with optional ` +
            `'true'/'false' descriptions, or omits it"). Omit it.`,
        );
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
 * Validates one answer against the question that asked for it.
 *
 * Three separate things are checked, and all three are needed:
 *
 *   1. the answer's own `type` matches the question's kind;
 *   2. the reported value is inside the answer space the request declared;
 *   3. the reported value AGREES WITH THE PROVIDER'S OWN DISTRIBUTION.
 *
 * (3) is the one a status-code check cannot do. laya-serve can answer 200 with
 * `choice: "a"` while its own `probabilities` say `a: 0.01, b: 0.99`. That
 * payload is self-contradictory: it claims "a" and simultaneously says "b, and
 * not a". Accepting it means the reported answer can be the one the provider
 * itself considers least likely.
 *
 * The consistency rule is deliberately minimal and is taken from how Laya
 * actually builds the answer, not invented: `choice` is the ARGMAX of
 * `probabilities`, and `answer_confidence` is that maximum. So the rule is only
 * "the chosen option's probability must be >= every other option's". Ties are
 * accepted, because with equal mass either option is a legitimate argmax. No
 * entropy, margin, or threshold statistic is introduced: none is needed to catch
 * a contradiction, and any such threshold would risk rejecting a real answer.
 */
function validateAnswer(id: string, raw: Record<string, unknown>, question: DecisionQuestion): DecisionAnswer {
  // The answer must be the kind that was asked for. Without this, a score answer
  // could satisfy a choice question, or vice versa.
  if (raw.type !== question.type) {
    throw new DecisionSchemaError(
      `answer "${id}" is of type ${describe(raw.type)}, but a ${question.type} question was asked`,
    );
  }

  // NOTE: only `choice` and `score` answers carry a `probabilities` map. A `noul`
  // answer is a bare likelihood and laya-serve does not send one, so demanding
  // it there would reject every real response.
  if (question.type === 'choice') {
    const probabilitiesRaw = raw.probabilities;
    if (!isRecord(probabilitiesRaw)) {
      throw new DecisionSchemaError(
        `answer "${id}" is missing a "probabilities" distribution (got ${describe(probabilitiesRaw)})`,
      );
    }
    const offered = Object.keys(question.criteria);
    const choice = raw.choice;
    if (typeof choice !== 'string' || !offered.includes(choice)) {
      throw new DecisionSchemaError(
        `answer "${id}" chose ${describe(choice)}, which is outside the choices this request ` +
          `offered [${offered.join(', ')}]`,
      );
    }
    // The distribution has to cover the same space, or it cannot be thresholded.
    const probabilities: Record<string, number> = {};
    for (const key of offered) {
      probabilities[key] = requireProbability(probabilitiesRaw[key], `answer "${id}" probability for "${key}"`);
    }
    // Consistency: the chosen option must be a maximum of the reported
    // distribution, otherwise the answer contradicts itself.
    const chosen = probabilities[choice];
    for (const key of offered) {
      if (probabilities[key] > chosen) {
        throw new DecisionSchemaError(
          `answer "${id}" is self-contradictory: it chose ${JSON.stringify(choice)} at probability ` +
            `${chosen.toFixed(4)}, but its own distribution gives ${JSON.stringify(key)} a higher ` +
            `${probabilities[key].toFixed(4)}. Laya's "choice" is the most likely option, so the reported ` +
            `answer and the reported distribution disagree.`,
        );
      }
    }
    return {
      type: 'choice',
      choice,
      criteria: question.criteria,
      probabilities,
      confidence: requireProbability(raw.answer_confidence, `answer "${id}" answer_confidence`),
    };
  }

  if (question.type === 'score') {
    const probabilitiesRaw = raw.probabilities;
    if (!isRecord(probabilitiesRaw)) {
      throw new DecisionSchemaError(
        `answer "${id}" is missing a "probabilities" distribution (got ${describe(probabilitiesRaw)})`,
      );
    }
    const score = raw.score;
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      throw new DecisionSchemaError(
        `answer "${id}" score is ${describe(score)}, expected a finite number`,
      );
    }
    // The legend is the authority on what the numbers mean, so it is matched
    // against the levels this request offered rather than assumed to line up.
    const legend = raw.legend;
    if (!isRecord(legend)) {
      throw new DecisionSchemaError(`answer "${id}" is missing its "legend" mapping index -> level`);
    }
    const level = legend[String(Math.round(score))];
    if (typeof level !== 'string' || !question.criteria.includes(level)) {
      throw new DecisionSchemaError(
        `answer "${id}" scored ${score}, which maps to legend entry ${describe(level)}, ` +
          `outside the levels this request offered [${question.criteria.join(', ')}]`,
      );
    }
    const probabilities: Record<string, number> = {};
    for (let i = 0; i < question.criteria.length; i++) {
      probabilities[String(i)] = requireProbability(probabilitiesRaw[String(i)], `answer "${id}" probability for level ${i}`);
    }
    return {
      type: 'score',
      score,
      level,
      levels: [...question.criteria],
      probabilities,
      confidence: requireProbability(raw.answer_confidence, `answer "${id}" answer_confidence`),
    };
  }

  // noul has no answer space, so only the likelihood and its confidence matter.
  // A distribution is accepted when present, but is not required.
  const probabilities: Record<string, number> = {};
  if (raw.probabilities !== undefined) {
    if (!isRecord(raw.probabilities)) {
      throw new DecisionSchemaError(`answer "${id}" has a "probabilities" that is ${describe(raw.probabilities)}`);
    }
    for (const [k, v] of Object.entries(raw.probabilities)) {
      probabilities[k] = requireProbability(v, `answer "${id}" probability for "${k}"`);
    }
  }
  return {
    type: 'noul',
    noul: requireProbability(raw.noul, `answer "${id}" noul`),
    probabilities,
    confidence: requireProbability(raw.answer_confidence, `answer "${id}" answer_confidence`),
  };
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
  const timeoutMs = options.timeoutMs ?? 30_000;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const name = 'laya';

  async function post(path: string, payload: unknown): Promise<Response> {
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
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal,
      });
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
