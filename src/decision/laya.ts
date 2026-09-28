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
 * message instead of a bare 413. The server remains the backstop if upstream
 * changes these; they are not a security boundary.
 */
const MAX_STATE_CHARS = 50_000;
const MAX_QUESTIONS = 64;
const MAX_CHOICE_OPTIONS = 100;
const MAX_SCORE_LEVELS = 32;

export interface LayaProviderOptions {
  /** Base URL of a local laya-serve. Loopback by default. */
  readonly baseUrl?: string;
  /** Per-request budget. The first call also pays CUDA + checkpoint load. */
  readonly timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

interface HealthPayload {
  readonly status?: string;
  readonly loaded?: readonly string[];
  readonly device?: string;
  readonly cpu_fallbacks?: Readonly<Record<string, { readonly count: number; readonly last_reason: string | null }>>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Reads a probability and fails loudly; it is the only evidence of certainty. */
function requireProbability(value: unknown, what: string): Probability {
  const p = toProbability(value);
  if (p === null) {
    throw new DecisionSchemaError(
      `${what} is ${JSON.stringify(value) ?? 'undefined'}, expected a probability in [0, 1]`,
    );
  }
  return p;
}

/**
 * Rejects a request that cannot produce an informative answer.
 *
 * The one-option cases matter most: laya-serve returns that option with HTTP
 * 200, forever, for every input. Accepting that would report a confident,
 * constant "decision" that carries no information at all.
 */
function validateRequest(request: DecisionRequest): Record<string, string> {
  const ids = Object.keys(request.questions ?? {});
  if (ids.length === 0) {
    throw new DecisionInputError(
      'no questions were asked, so there is nothing to decide; ' +
        'a request with zero questions cannot produce a decision',
    );
  }
  if (ids.length > MAX_QUESTIONS) {
    throw new DecisionInputError(`asked ${ids.length} questions, over laya's limit of ${MAX_QUESTIONS}`);
  }

  for (const id of ids) {
    const q: DecisionQuestion = request.questions[id];
    const where = `question "${id}"`;
    if (!isRecord(q)) {
      throw new DecisionInputError(`${where} is ${q === undefined ? 'undefined' : 'not an object'}`);
    }
    const kind: unknown = q.type;
    if (typeof q.instructions !== 'string' || q.instructions.trim().length === 0) {
      throw new DecisionInputError(`${where} has empty "instructions"; laya would answer without being asked anything`);
    }

    if (kind === 'choice') {
      const criteria: unknown = q.criteria;
      if (!isRecord(criteria)) {
        throw new DecisionInputError(
          `${where} is a choice but its "criteria" is ${Array.isArray(criteria) ? 'an array' : typeof criteria}, ` +
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
    } else if (kind === 'score') {
      const levels: unknown = q.criteria;
      if (!Array.isArray(levels)) {
        throw new DecisionInputError(
          `${where} is a score but its "criteria" is ${typeof levels}, expected an ordered array of level descriptions`,
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
    } else if (kind === 'noul') {
      // noul has no answer space, so criteria here is descriptive only.
      const criteria: unknown = q.criteria;
      if (criteria !== undefined && !isRecord(criteria)) {
        throw new DecisionInputError(
          `${where} is a noul whose "criteria" is ${Array.isArray(criteria) ? 'an array' : typeof criteria}, ` +
            `expected an object with optional "true"/"false" descriptions`,
        );
      }
    } else {
      throw new DecisionInputError(
        `${where} has type ${JSON.stringify(kind)}, expected one of ["choice", "score", "noul"]`,
      );
    }
  }

  // Build the state. `task` is a shorthand for the common single-text case.
  const state: Record<string, string> = { ...(request.state ?? {}) };
  if (request.task !== undefined) {
    if (typeof request.task !== 'string') {
      throw new DecisionInputError(`"task" is ${typeof request.task}, expected a string`);
    }
    state[TASK_FIELD] = request.task;
  }
  for (const [k, v] of Object.entries(request.context ?? {})) {
    if (typeof v !== 'string') {
      throw new DecisionInputError(`context field "${k}" is ${typeof v}, expected a string`);
    }
    state[k] = v;
  }
  if (Object.keys(state).length === 0) {
    throw new DecisionInputError('nothing to read: set "task", "state" or "context" so the questions have something to look at');
  }

  const serialized = JSON.stringify(state);
  if (serialized.length > MAX_STATE_CHARS) {
    throw new DecisionInputError(
      `state is ${serialized.length} chars, over laya's ${MAX_STATE_CHARS} limit; ` +
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
  readonly raw: Record<string, unknown>;
}

/** Validates the envelope before any field is read as an answer. */
function validateEnvelope(body: unknown, expectedIds: readonly string[]): ValidEnvelope {
  if (!isRecord(body)) {
    throw new DecisionSchemaError(`response body is ${Array.isArray(body) ? 'an array' : typeof body}, expected an object`);
  }
  if (typeof body.model !== 'string' || body.model.length === 0) {
    throw new DecisionSchemaError(`response is missing a string "model" (got ${JSON.stringify(body.model) ?? 'undefined'})`);
  }
  if (!isRecord(body.answers)) {
    throw new DecisionSchemaError('response is missing an "answers" object');
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
    raw: body,
  };
}

/**
 * Validates one answer against the question that asked for it.
 *
 * The answer must match the question's kind, and its value must be inside the
 * answer space the request declared. Anything else means the provider answered
 * something other than what was asked.
 */
function validateAnswer(id: string, raw: Record<string, unknown>, question: DecisionQuestion): DecisionAnswer {
  // NOTE: only `choice` and `score` answers carry a `probabilities` map. A `noul`
  // answer is a bare likelihood and laya-serve does not send one, so demanding
  // it there would reject every real response.
  if (question.type === 'choice') {
    const probabilitiesRaw = raw.probabilities;
    if (!isRecord(probabilitiesRaw)) {
      throw new DecisionSchemaError(`answer "${id}" is missing a "probabilities" distribution`);
    }
    const offered = Object.keys(question.criteria);
    const choice = raw.choice;
    if (typeof choice !== 'string' || !offered.includes(choice)) {
      throw new DecisionSchemaError(
        `answer "${id}" chose ${JSON.stringify(choice) ?? 'undefined'}, which is outside the choices this request ` +
          `offered [${offered.join(', ')}]`,
      );
    }
    // The distribution has to cover the same space, or it cannot be thresholded.
    const probabilities: Record<string, number> = {};
    for (const key of offered) {
      probabilities[key] = requireProbability(probabilitiesRaw[key], `answer "${id}" probability for "${key}"`);
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
      throw new DecisionSchemaError(`answer "${id}" is missing a "probabilities" distribution`);
    }
    const score = raw.score;
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      throw new DecisionSchemaError(
        `answer "${id}" score is ${JSON.stringify(score) ?? 'undefined'}, expected a finite number`,
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
        `answer "${id}" scored ${score}, which maps to legend entry ${JSON.stringify(level) ?? 'undefined'}, ` +
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
      throw new DecisionSchemaError(`answer "${id}" has a "probabilities" that is not an object`);
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
    checkpoint: typeof routing.model === 'string' ? routing.model : 'unknown',
    reason: typeof routing.reason === 'string' ? routing.reason : 'not reported',
    script: typeof detection.script === 'string' ? detection.script : null,
    language: typeof detection.language === 'string' ? detection.language : null,
    elapsedMs,
  };
}

export function createLayaDecisionProvider(options: LayaProviderOptions = {}): DecisionProvider {
  const baseUrl = (options.baseUrl ?? 'http://127.0.0.1:8077').replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 30_000;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const name = 'laya';

  async function post(path: string, payload: unknown): Promise<Response> {
    const url = `${baseUrl}${path}`;
    const signal = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
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
      let body = '';
      try {
        body = (await res.text()).slice(0, 500);
      } catch {
        body = '(response body could not be read)';
      }
      throw new DecisionTransportError(url, res.status, body);
    }
    return res;
  }

  return {
    name,

    async probe(): Promise<DecisionProbe> {
      const url = `${baseUrl}/health`;
      let res: Response;
      try {
        res = await doFetch(url, { signal: AbortSignal.timeout(Math.min(timeoutMs, 5_000)) });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return { ok: false, endpoint: url, detail, warnings: [] };
      }
      if (!res.ok) {
        return { ok: false, endpoint: url, detail: `HTTP ${res.status}`, warnings: [] };
      }
      const health = (await res.json()) as HealthPayload;
      const loaded = health.loaded ?? [];
      const warnings: string[] = [];
      // A CPU fallback still answers, but at a latency and accuracy this
      // orchestrator should not silently accept.
      for (const [ckpt, info] of Object.entries(health.cpu_fallbacks ?? {})) {
        if (info.count > 0) {
          warnings.push(
            `checkpoint "${ckpt}" has fallen back to CPU ${info.count}x` +
              (info.last_reason ? ` (last: ${info.last_reason})` : ''),
          );
        }
      }
      if (loaded.length === 0) {
        warnings.push('no checkpoints are loaded; start laya-serve with --preload for predictable latency');
      }
      return {
        ok: health.status === 'ok',
        endpoint: url,
        detail: `status=${health.status ?? 'unknown'} device=${health.device ?? 'unknown'} loaded=[${loaded.join(', ')}]`,
        warnings,
      };
    },

    async decide(request: DecisionRequest): Promise<DecisionResponse> {
      // Refuse before spending a request on a question that cannot inform.
      const state = validateRequest(request);
      const ids = Object.keys(request.questions);

      const started = performance.now();
      const res = await post('/v1/systemone', { state, questions: request.questions });
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
        answers[id] = validateAnswer(id, envelope.answers[id], request.questions[id]);
      }

      return {
        answers,
        provider: readProviderMetadata(envelope, name, elapsedMs),
        raw: envelope.raw,
      };
    },
  };
}
