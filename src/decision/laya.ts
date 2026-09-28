/**
 * decision/laya.ts -- DecisionProvider backed by a LOCAL laya-serve.
 *
 * Scope, deliberately narrow:
 *   - It talks to a local HTTP endpoint. There is no cloud route, no fallback
 *     provider, and no API key. If laya-serve is down the call throws.
 *   - It only CLASSIFIES. It never launches an agent, never picks a thread, and
 *     never falls back to a default classification.
 *
 * The question set below is fixed on purpose. Measured on this machine, the same
 * task scored against a 2-option choice ("implementation"/"review") came back
 * as `review` at 0.628, while the same task against the 4-option set below came
 * back as `debugging` at 0.555. The criteria set IS the decision space, so it is
 * pinned here rather than left to a caller to vary per request.
 */

import {
  DecisionInputError,
  DecisionSchemaError,
  DecisionTimeoutError,
  DecisionTransportError,
  DecisionUnavailableError,
} from './errors.ts';
import {
  COMPLEXITY_LEVELS,
  WORK_KINDS,
  toProbability,
  type ComplexityLevel,
  type DecisionInput,
  type DecisionProbe,
  type DecisionProvider,
  type DecisionQuestion,
  type Probability,
  type RawSystemOne,
  type RouteDecision,
  type WorkKind,
} from './types.ts';

/** Laya's own limits. Enforced client-side to give a better message than a 413. */
const MAX_STATE_CHARS = 50_000;
const MAX_QUESTIONS = 64;

/** The exact questions asked, and the question ids the answers are read from. */
const WORK_KIND_ID = 'work_kind';
const COMPLEXITY_ID = 'complexity';
const REVIEW_ID = 'review_required';

const QUESTIONS: Readonly<Record<string, DecisionQuestion>> = {
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

/**
 * Reads a probability and fails loudly. A missing or out-of-range confidence is
 * not a rounding detail: it is the only evidence that the classifier was sure.
 */
function requireProbability(value: unknown, what: string): Probability {
  const p = toProbability(value);
  if (p === null) {
    throw new DecisionSchemaError(
      `${what} is ${JSON.stringify(value) ?? 'undefined'}, expected a probability in [0, 1]`,
    );
  }
  return p;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validates the envelope before any field is read as a decision. laya-serve
 * returns 200 with `answers: {}` when asked nothing, so "2xx" is not evidence of
 * a decision.
 */
function validateEnvelope(body: unknown): RawSystemOne {
  if (!isRecord(body)) {
    throw new DecisionSchemaError(`response body is ${Array.isArray(body) ? 'an array' : typeof body}, expected an object`);
  }
  if (typeof body.model !== 'string' || body.model.length === 0) {
    throw new DecisionSchemaError(`response is missing a string "model" (got ${JSON.stringify(body.model) ?? 'undefined'})`);
  }
  if (!isRecord(body.answers)) {
    throw new DecisionSchemaError(`response is missing an "answers" object`);
  }
  const ids = Object.keys(body.answers);
  if (ids.length === 0) {
    throw new DecisionSchemaError(
      `provider answered with no questions at all ("answers" is empty), so there is nothing to route on`,
    );
  }
  for (const id of [WORK_KIND_ID, COMPLEXITY_ID, REVIEW_ID]) {
    if (!isRecord(body.answers[id])) {
      throw new DecisionSchemaError(`response has no answer for question "${id}" (got keys: ${ids.join(', ') || 'none'})`);
    }
  }
  return body as unknown as RawSystemOne;
}

function readWorkKind(answer: Record<string, unknown>): { kind: WorkKind; confidence: Probability; probabilities: Record<WorkKind, number> } {
  const choice = answer.choice;
  if (typeof choice !== 'string' || !(WORK_KINDS as readonly string[]).includes(choice)) {
    throw new DecisionSchemaError(
      `work_kind choice ${JSON.stringify(choice) ?? 'undefined'} is outside the declared vocabulary [${WORK_KINDS.join(', ')}]`,
    );
  }
  const rawProbs = answer.probabilities;
  if (!isRecord(rawProbs)) {
    throw new DecisionSchemaError(`work_kind is missing a "probabilities" distribution`);
  }
  const probabilities = {} as Record<WorkKind, number>;
  for (const kind of WORK_KINDS) {
    probabilities[kind] = requireProbability(rawProbs[kind], `work_kind probability for "${kind}"`);
  }
  return {
    kind: choice as WorkKind,
    confidence: requireProbability(answer.answer_confidence, 'work_kind answer_confidence'),
    probabilities,
  };
}

function readComplexity(answer: Record<string, unknown>): { level: ComplexityLevel; score: number; confidence: Probability } {
  const score = answer.score;
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    throw new DecisionSchemaError(`complexity score ${JSON.stringify(score) ?? 'undefined'} is not a finite number`);
  }
  // The legend is the authority on what the numbers mean, so it is checked
  // against our own levels rather than assumed to line up.
  const legend = answer.legend;
  if (!isRecord(legend)) {
    throw new DecisionSchemaError('complexity answer is missing its "legend" mapping index -> level');
  }
  const index = Math.round(score);
  const level = legend[String(index)];
  if (typeof level !== 'string' || !(COMPLEXITY_LEVELS as readonly string[]).includes(level)) {
    throw new DecisionSchemaError(
      `complexity score ${score} maps to legend entry ${JSON.stringify(level) ?? 'undefined'}, ` +
        `which is outside the declared vocabulary [${COMPLEXITY_LEVELS.join(', ')}]`,
    );
  }
  return {
    level: level as ComplexityLevel,
    score,
    confidence: requireProbability(answer.answer_confidence, 'complexity answer_confidence'),
  };
}

function readReview(answer: Record<string, unknown>): { required: boolean; noul: Probability } {
  const noul = requireProbability(answer.noul, 'review_required noul');
  // noul is a continuous "No Or Unsure Likelihood". It is read as a review
  // requirement above 0.5, i.e. when the classifier leans towards "yes, review
  // this". The raw value is kept so a caller can pick its own threshold.
  return { required: noul > 0.5, noul };
}

export function createLayaDecisionProvider(options: LayaProviderOptions = {}): DecisionProvider {
  const baseUrl = (options.baseUrl ?? 'http://127.0.0.1:8077').replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 30_000;
  const doFetch = options.fetchImpl ?? globalThis.fetch;

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
    name: 'laya',

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
      for (const [name, info] of Object.entries(health.cpu_fallbacks ?? {})) {
        if (info.count > 0) {
          warnings.push(
            `checkpoint "${name}" has fallen back to CPU ${info.count}x` +
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

    async decide(input: DecisionInput): Promise<RouteDecision> {
      const state: Record<string, string> = { task: input.task, ...(input.context ?? {}) };
      const serialized = JSON.stringify(state);
      if (serialized.length > MAX_STATE_CHARS) {
        throw new DecisionInputError(
          `state is ${serialized.length} chars, over laya's ${MAX_STATE_CHARS} limit; ` +
            `summarise the task instead of truncating it silently`,
        );
      }
      if (Object.keys(QUESTIONS).length > MAX_QUESTIONS) {
        throw new DecisionInputError(`question set has ${Object.keys(QUESTIONS).length} questions, over laya's ${MAX_QUESTIONS}`);
      }

      const started = performance.now();
      const res = await post('/v1/systemone', { state, questions: QUESTIONS });
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        throw new DecisionSchemaError('response body is not valid JSON');
      }
      const envelope = validateEnvelope(parsed);
      const elapsedMs = Math.round(performance.now() - started);

      const workKind = readWorkKind(envelope.answers[WORK_KIND_ID] as unknown as Record<string, unknown>);
      const complexity = readComplexity(envelope.answers[COMPLEXITY_ID] as unknown as Record<string, unknown>);
      const review = readReview(envelope.answers[REVIEW_ID] as unknown as Record<string, unknown>);

      return {
        work_kind: workKind.kind,
        work_kind_confidence: workKind.confidence,
        work_kind_probabilities: workKind.probabilities,
        complexity: complexity.level,
        complexity_score: complexity.score,
        complexity_confidence: complexity.confidence,
        review_required: review.required,
        review_noul: review.noul,
        provenance: {
          model: envelope.model,
          checkpoint: envelope.routing?.model ?? 'unknown',
          reason: envelope.routing?.reason ?? 'not reported',
          script: envelope.routing?.detection?.script ?? null,
          language: envelope.routing?.detection?.language ?? null,
          elapsedMs,
        },
        raw: envelope,
      };
    },
  };
}
