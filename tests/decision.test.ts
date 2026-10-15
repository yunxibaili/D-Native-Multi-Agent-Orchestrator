/**
 * tests/decision.test.ts -- the Decision Layer contract.
 *
 * Offline and hermetic: a stub node:http server stands in for laya-serve, so the
 * suite needs no Python, no CUDA, no checkpoints, and no network. It reproduces
 * as fixtures the responses laya-serve really returns for bad input -- including
 * the 200-with-no-answer cases that make naive "check the status code" validation
 * silently produce a wrong classification.
 *
 * Two layers are covered:
 *   - the generic DecisionProvider (questions, choices, criteria, answers)
 *   - the routing preset built on top of it
 *
 * Run: node tests/decision.test.ts
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  DecisionError,
  DecisionInputError,
  DecisionSchemaError,
  DecisionTimeoutError,
  DecisionTransportError,
  DecisionUnavailableError,
  isDecisionError,
} from '../src/decision/errors.ts';
import { createLayaDecisionProvider, layaMetadata } from '../src/decision/laya.ts';
import {
  COMPLEXITY_ID,
  COMPLEXITY_LEVELS,
  REVIEW_ID,
  WORK_KIND_ID,
  WORK_KINDS,
  classifyTask,
  routingQuestions,
  routingRequest,
  toTaskClassification,
} from '../src/decision/routing.ts';
import { TASK_FIELD, toProbability, type DecisionQuestion, type DecisionRequest } from '../src/decision/types.ts';
import type { TaskClassification } from '../src/decision/routing.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed++;
    failures.push(name);
    process.stdout.write(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}\n`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, `got ${a}, want ${b}`);
}

// ---- fixtures -------------------------------------------------------------

/** Rounds the way laya/agent.py serialises: round(x, 4). */
function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

/**
 * Builds a choice answer that is internally consistent, exactly as the service
 * would emit it: `choice` is the argmax and `answer_confidence` is max(p).
 * Deriving them from the distribution means a negative test can perturb exactly
 * one field and be sure the failure is the field under test.
 */
function consistentChoice(key: string, probs: Record<string, number>): Record<string, unknown> {
  return {
    type: 'choice',
    choice: key,
    probabilities: probs,
    confidence: 0.5,
    answer_confidence: round4(Math.max(...Object.values(probs))),
  };
}

/** The same for a score, where the reported value is the expectation, not an argmax. */
function consistentScore(probs: Record<string, number>, levels: readonly string[]): Record<string, unknown> {
  const expectation = levels.reduce((acc, _l, i) => acc + i * probs[String(i)], 0);
  return {
    type: 'score',
    score: round4(expectation),
    legend: Object.fromEntries(levels.map((c, i) => [String(i), c])),
    probabilities: probs,
    confidence: 0.5,
    answer_confidence: round4(Math.max(...Object.values(probs))),
  };
}

const LEVELS = [...COMPLEXITY_LEVELS];

/**
 * A well-formed laya-serve answer. These are the REAL values captured from the
 * running service for the Chinese refactor task, not hand-written numbers, so
 * every consistency check passes for the same reason it does in production:
 *   complexity  sum 1.0000, expectation 1.6295 == score, max(p) 0.5052 == answer_confidence
 *   work_kind   sum 1.0001, argmax implementation == choice, max(p) 0.9989 == answer_confidence
 *   review      noul 0.0035, max(noul, 1-noul) 0.9965 == answer_confidence
 */
function goodAnswers(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    work_kind: consistentChoice('implementation', {
      implementation: 0.9989,
      review: 0.0004,
      research: 0.0004,
      debugging: 0.0004,
    }),
    complexity: consistentScore(
      { '0': 0.0286, '1': 0.3935, '2': 0.5052, '3': 0.0652, '4': 0.0075 },
      LEVELS,
    ),
    review_required: { type: 'noul', noul: 0.0035, confidence: 0.9965, answer_confidence: 0.9965 },
    ...overrides,
  };
}

function goodBody(answers = goodAnswers()): unknown {
  return {
    model: 'laya-rl-agent',
    answers,
    usage: { input_tokens: 219, output_tokens: 0 },
    routing: {
      model: 'english',
      repo: 'convaiinnovations/laya',
      reason: 'English Latin text',
      detection: { script: 'latin', language: 'en' },
    },
  };
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function withServer(handler: Handler, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      (req as IncomingMessage & { rawBody?: string }).rawBody = raw;
      handler(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function jsonHandler(status: number, body: unknown): Handler {
  return (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
}

async function expectError<T>(name: string, fn: () => Promise<T>, type: new (...a: never[]) => Error): Promise<void> {
  try {
    await fn();
    check(name, false, 'no error thrown');
  } catch (e) {
    const okType = e instanceof Error && e instanceof type;
    check(name, okType, `got ${(e as Error).name}: ${String((e as Error).message).slice(0, 130)}`);
  }
}

const ROUTING: DecisionRequest = { questions: routingQuestions(), task: 'refactor the event hub and update tests' };

// ---- the generic layer ----------------------------------------------------

async function testGenericLayer(): Promise<void> {
  // happy path, through the generic request/response
  await withServer(jsonHandler(200, goodBody()), async (baseUrl) => {
    const p = createLayaDecisionProvider({ baseUrl });
    const r = await p.decide(ROUTING);
    eq('name is laya', p.name, 'laya');
    eq('answer count matches the questions asked', Object.keys(r.answers).sort(), [WORK_KIND_ID, COMPLEXITY_ID, REVIEW_ID].sort());

    const kind = r.answers[WORK_KIND_ID];
    check('choice answer is typed', kind?.type === 'choice', kind?.type);
    if (kind?.type === 'choice') {
      eq('choice value', kind.choice, 'implementation');
      eq('confidence is the reported max of the distribution', kind.confidence, 0.9989);
      eq('criteria echoed back', Object.keys(kind.criteria).join(), WORK_KINDS.join());
      eq('probabilities cover the offered choices', Object.keys(kind.probabilities).join(), WORK_KINDS.join());
    }
    const complexity = r.answers[COMPLEXITY_ID];
    if (complexity?.type === 'score') {
      // score is continuous, so the level comes from rounding it: 1.6295 -> 2.
      eq('level from rounded score', complexity.level, 'moderate');
      eq('raw score preserved', complexity.score, 1.6295);
      eq('levels echoed back', complexity.levels.join(), COMPLEXITY_LEVELS.join());
      eq('score distribution covers every level', Object.keys(complexity.probabilities).join(), '0,1,2,3,4');
    } else {
      check('score answer is typed', false, complexity?.type);
    }
    const review = r.answers[REVIEW_ID];
    eq('noul value', review?.type === 'noul' ? review.noul : null, 0.0035);

    // provider metadata is retained for debugging, split into generic + Laya-specific
    eq('provider name', r.provider.name, 'laya');
    eq('provider model', r.provider.model, 'laya-rl-agent');
    check('elapsed measured', r.provider.elapsedMs >= 0 && r.provider.elapsedMs < 60_000, String(r.provider.elapsedMs));
    eq('generic metadata carries no Laya field names', Object.keys(r.provider).sort().join(), 'details,elapsedMs,model,name');
    const meta = layaMetadata(r);
    eq('checkpoint is read through the Laya reader', meta.checkpoint, 'english');
    eq('routing reason read through the Laya reader', meta.reason, 'English Latin text');
    eq('script read through the Laya reader', meta.script, 'latin');
    eq('raw envelope retained', (r.raw as Record<string, unknown>).model, 'laya-rl-agent');
  });

  // a different question set works: the layer is not tied to the routing preset
  await withServer(
    jsonHandler(200, {
      model: 'laya-rl-agent',
      answers: {
        tone: consistentChoice('urgent', { urgent: 0.8, normal: 0.2 }),
        severity: consistentScore({ '0': 0.05, '1': 0.05, '2': 0.1, '3': 0.8 }, ['low', 'mid', 'high', 'critical']),
        // a noul sends no distribution at all; its confidence is max(noul, 1 - noul)
        needsHuman: { type: 'noul', noul: 0.2, answer_confidence: 0.8 },
      },
      routing: { model: 'english', reason: 'English Latin text' },
    }),
    async (baseUrl) => {
      const p = createLayaDecisionProvider({ baseUrl });
      const r = await p.decide({
        questions: {
          tone: { type: 'choice', instructions: 'How urgent is this?', criteria: { urgent: 'act now', normal: 'no rush' } },
          severity: { type: 'score', instructions: 'How severe?', criteria: ['low', 'mid', 'high', 'critical'] },
          needsHuman: { type: 'noul', instructions: 'Does this need a human?' },
        },
        task: 'the build is down',
      });
      eq('arbitrary choice question answered', r.answers.tone?.type === 'choice' ? r.answers.tone.choice : null, 'urgent');
      eq('arbitrary score question answered', r.answers.severity?.type === 'score' ? r.answers.severity.level : null, 'critical');
      eq('arbitrary noul question answered', r.answers.needsHuman?.type === 'noul' ? r.answers.needsHuman.noul : null, 0.2);
      const m = layaMetadata(r);
      eq('checkpoint is read from the reported routing', m.checkpoint, 'english');
      eq('reason is read from the reported routing', m.reason, 'English Latin text');
      eq('script is null when unreported', m.script, null);
      eq('language is null when unreported', m.language, null);
      eq('usage defaults to null tokens', m.inputTokens, null);
      eq('revisions default to an empty map', Object.keys(m.revisions).length, 0);
    },
  );

  // what we actually send
  let sent: any = {};
  await withServer(
    (req, res) => {
      sent = JSON.parse((req as IncomingMessage & { rawBody: string }).rawBody);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(goodBody()));
    },
    async (baseUrl) => {
      await createLayaDecisionProvider({ baseUrl }).decide({ ...ROUTING, context: { repo: 'orchestrator' } });
      eq('task is sent under the task field', sent.state[TASK_FIELD], 'refactor the event hub and update tests');
      eq('context is merged into state', sent.state.repo, 'orchestrator');
      eq('questions are sent verbatim', Object.keys(sent.questions).join(), [WORK_KIND_ID, COMPLEXITY_ID, REVIEW_ID].join());
    },
  );

  // state can be given directly instead of via `task`
  await withServer(
    (req, res) => {
      sent = JSON.parse((req as IncomingMessage & { rawBody: string }).rawBody);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(goodBody()));
    },
    async (baseUrl) => {
      await createLayaDecisionProvider({ baseUrl }).decide({
        questions: routingQuestions(),
        state: { subject: 'regression', body: 'the hub drops events' },
      });
      eq('explicit state is used as-is', sent.state.subject, 'regression');
      check('no task field is invented', !(TASK_FIELD in sent.state), Object.keys(sent.state).join());
    },
  );
}

// ---- requests that must be refused before being sent ----------------------

async function testRequestValidation(): Promise<void> {
  let reachedServer = false;
  const countingHandler: Handler = (_req, res) => {
    reachedServer = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(goodBody()));
  };

  // Typed `unknown` on purpose: these cases deliberately violate the declared
  // request type, which is exactly what an untyped JavaScript caller (or one
  // reading unvalidated JSON) can hand over. The provider must turn all of them
  // into a DecisionInputError rather than a TypeError.
  const badRequests: Array<[string, unknown, string]> = [
    ['empty questions', { questions: {}, task: 't' }, 'no questions were asked'],
    ['choice with no choices', { questions: { c: { type: 'choice', instructions: '?', criteria: {} } }, task: 't' }, 'offers no choices'],
    [
      'choice with exactly one choice',
      { questions: { c: { type: 'choice', instructions: '?', criteria: { only: 'one' } } }, task: 't' },
      'every input at full confidence',
    ],
    [
      'choice criteria as an array',
      { questions: { c: { type: 'choice', instructions: '?', criteria: ['a', 'b'] as unknown as Record<string, string> } }, task: 't' },
      'expected an object',
    ],
    ['score with no levels', { questions: { s: { type: 'score', instructions: '?', criteria: [] } }, task: 't' }, '0 level'],
    ['score with one level', { questions: { s: { type: 'score', instructions: '?', criteria: ['only'] } }, task: 't' }, 'same score for every input'],
    [
      'score criteria not a list',
      { questions: { s: { type: 'score', instructions: '?', criteria: { a: 'b' } as unknown as string[] } }, task: 't' },
      'expected an ordered array',
    ],
    // A noul may carry `criteria` keyed "true"/"false" -- verified against
    // laya/agent.py. Anything else is refused locally.
    [
      'noul with criteria keyed yes/no',
      { questions: { n: { type: 'noul', instructions: '?', criteria: { yes: 'y', no: 'n' } } }, task: 't' },
      'only keys are "true" and "false"',
    ],
    [
      'noul criteria as an array',
      { questions: { n: { type: 'noul', instructions: '?', criteria: ['true'] as unknown as Record<string, string> } }, task: 't' },
      'expected an object keyed',
    ],
    [
      'noul with an extra key alongside true/false',
      { questions: { n: { type: 'noul', instructions: '?', criteria: { true: 'y', false: 'n', maybe: 'x' } } }, task: 't' },
      'only keys are "true" and "false"',
    ],
    [
      'noul criteria with an empty description',
      { questions: { n: { type: 'noul', instructions: '?', criteria: { true: '  ' } } }, task: 't' },
      'expected a non-empty description string',
    ],
    [
      'noul criteria with a non-string description',
      { questions: { n: { type: 'noul', instructions: '?', criteria: { true: 5 as unknown as string } } }, task: 't' },
      'expected a non-empty description string',
    ],
    [
      'noul criteria with a null description',
      { questions: { n: { type: 'noul', instructions: '?', criteria: { true: null as unknown as string } } }, task: 't' },
      'expected a non-empty description string',
    ],
    [
      'noul criteria as a string',
      { questions: { n: { type: 'noul', instructions: '?', criteria: 'true' as unknown as Record<string, string> } }, task: 't' },
      'expected an object keyed',
    ],
    ['empty instructions', { questions: { c: { type: 'choice', instructions: '   ', criteria: { a: 'x', b: 'y' } } }, task: 't' }, 'expected a non-empty string'],
    [
      'unknown question type',
      { questions: { c: { type: 'vibe', instructions: '?' } as unknown as DecisionQuestion }, task: 't' },
      'expected one of',
    ],
    ['nothing to read', { questions: routingQuestions() }, 'nothing to read'],
    ['task is not a string', { questions: routingQuestions(), task: 7 as unknown as string }, 'expected a string'],

    // ---- runtime-value hardening: none of these may produce a TypeError ----
    ['null request', null, 'expected an object'],
    ['undefined request', undefined, 'expected an object'],
    ['a string request', 'not a request', 'expected an object'],
    ['a number request', 42, 'expected an object'],
    ['an array request', [], 'expected an object'],
    ['missing questions', { task: 't' }, '"questions" is undefined'],
    ['null questions', { questions: null, task: 't' }, '"questions" is null'],
    ['questions as a string', { questions: 'c', task: 't' }, '"questions" is a string'],
    ['questions as an array', { questions: [], task: 't' }, '"questions" is an array'],
    ['a question that is null', { questions: { q: null }, task: 't' }, 'question "q" is null'],
    ['a question that is a string', { questions: { q: 'choice' }, task: 't' }, 'question "q" is a string'],
    ['a question type that is null', { questions: { q: { type: null, instructions: '?' } } as unknown as Record<string, DecisionQuestion>, task: 't' }, 'has type null'],
    ['instructions as a number', { questions: { q: { type: 'noul', instructions: 5 as unknown as string } } }, 'expected a non-empty string'],
    [
      'a choice description that is empty',
      { questions: { c: { type: 'choice', instructions: '?', criteria: { a: 'x', b: '  ' } } } },
      'choice "b" has description',
    ],
    [
      'a choice description that is a number',
      { questions: { c: { type: 'choice', instructions: '?', criteria: { a: 'x', b: 7 as unknown as string } } } },
      'choice "b" has description',
    ],
    [
      'a choice description that is null',
      { questions: { c: { type: 'choice', instructions: '?', criteria: { a: 'x', b: null as unknown as string } } } },
      'choice "b" has description',
    ],
    [
      'a choice with an empty key',
      { questions: { c: { type: 'choice', instructions: '?', criteria: { a: 'x', '  ': 'y' } } } },
      'a choice with an empty key',
    ],
    [
      'a score level that is empty',
      { questions: { s: { type: 'score', instructions: '?', criteria: ['low', ''] } } },
      'level 1 is',
    ],
    [
      'a score level that is a number',
      { questions: { s: { type: 'score', instructions: '?', criteria: ['low', 2 as unknown as string] } } },
      'level 1 is',
    ],
    ['state as a string', { questions: routingQuestions(), state: 'x' as unknown as Record<string, string> }, '"state" is a string'],
    ['state as an array', { questions: routingQuestions(), state: ['x'] as unknown as Record<string, string> }, '"state" is an array'],
    ['state as null', { questions: routingQuestions(), state: null as unknown as Record<string, string> }, '"state" is null'],
    [
      'a state value that is not a string',
      { questions: routingQuestions(), state: { count: 3 as unknown as string } },
      'state field "count" is number',
    ],
    [
      'a state value that is null',
      { questions: routingQuestions(), state: { a: null as unknown as string } },
      'state field "a" is null',
    ],
    ['context as a string', { questions: routingQuestions(), task: 't', context: 'x' as unknown as Record<string, string> }, '"context" is a string'],
    [
      'a context value that is not a string',
      { questions: routingQuestions(), task: 't', context: { n: 1 as unknown as string } },
      'context field "n" is number',
    ],
    [
      'too many options in total',
      {
        questions: Object.fromEntries(
          Array.from({ length: 6 }, (_, i) => [
            `q${i}`,
            { type: 'choice', instructions: '?', criteria: Object.fromEntries(Array.from({ length: 100 }, (_, j) => [`o${j}`, 'x'])) },
          ]),
        ),
        task: 't',
      },
      "over laya's limit of 512",
    ],
  ];

  for (const [name, request, fragment] of badRequests) {
    reachedServer = false;
    await withServer(countingHandler, async (baseUrl) => {
      let msg = '';
      try {
        await createLayaDecisionProvider({ baseUrl }).decide(request as never);
      } catch (e) {
        if (!(e instanceof DecisionInputError)) {
          check(
            `refuses to send: ${name}`,
            false,
            `threw ${(e as Error).constructor.name}: ${String((e as Error).message).slice(0, 120)}`,
          );
          return;
        }
        msg = (e as Error).message;
      }
      check(`refuses to send: ${name}`, msg.includes(fragment), msg.slice(0, 170) || 'no error thrown');
    });
    check(`no request was sent for: ${name}`, !reachedServer, 'a request reached the provider');
  }

  // a specific message check, since the one-option case deserves a clear reason
  await withServer(countingHandler, async (baseUrl) => {
    try {
      await createLayaDecisionProvider({ baseUrl }).decide({
        questions: { c: { type: 'choice', instructions: '?', criteria: { only: 'one' } } },
        task: 't',
      });
      check('one-option choice is refused with a reason', false, 'no error');
    } catch (e) {
      check('one-option choice is refused with a reason', (e as Error).message.includes('every input at full confidence'), (e as Error).message);
    }
  });

  // oversized state
  await withServer(countingHandler, async (baseUrl) => {
    await expectError(
      'state over laya 50k limit is refused',
      () => createLayaDecisionProvider({ baseUrl }).decide(routingRequest({ task: 'a'.repeat(50_001) })),
      DecisionInputError,
    );
  });
}

// ---- responses that must be refused despite HTTP 200 ----------------------

async function testResponseValidation(): Promise<void> {
  // "the server said 200" is never the same as "there is a decision"
  const silentNoop: Array<[string, unknown]> = [
    ['empty answers object', { model: 'laya-rl-agent', answers: {} }],
    ['missing answers key', { model: 'laya-rl-agent' }],
    ['answers is a string', { model: 'laya-rl-agent', answers: 'none' }],
    ['answers is an array', { model: 'laya-rl-agent', answers: [] }],
    ['missing model', { answers: goodAnswers() }],
    ['empty model string', { model: '', answers: goodAnswers() }],
    ['body is an array', [1, 2, 3]],
    ['body is a bare string', 'ok'],
    ['body is null', null],
  ];
  for (const [name, body] of silentNoop) {
    await withServer(jsonHandler(200, body), async (baseUrl) => {
      await expectError(
        `200 with ${name} throws DecisionSchemaError`,
        () => createLayaDecisionProvider({ baseUrl }).decide(ROUTING),
        DecisionSchemaError,
      );
    });
  }

  // a 200 that answers only part of the request
  const partials: Array<[string, Record<string, unknown>]> = [
    ['only work_kind', { work_kind: goodAnswers().work_kind }],
    ['only complexity', { complexity: goodAnswers().complexity }],
    ['no review_required', { work_kind: goodAnswers().work_kind, complexity: goodAnswers().complexity }],
  ];
  for (const [name, answers] of partials) {
    await withServer(jsonHandler(200, goodBody(answers)), async (baseUrl) => {
      await expectError(
        `200 with ${name} throws DecisionSchemaError`,
        () => createLayaDecisionProvider({ baseUrl }).decide(ROUTING),
        DecisionSchemaError,
      );
    });
  }

  // values outside the answer space the request declared
  const outOfRange: Array<[string, Record<string, unknown>, string]> = [
    [
      'choice outside the offered choices',
      goodAnswers({ work_kind: { type: 'choice', choice: 'vibes', answer_confidence: 0.9, probabilities: { implementation: 1, review: 0, research: 0, debugging: 0 } } }),
      'outside the choices this request offered',
    ],
    [
      'choice missing entirely',
      goodAnswers({
        work_kind: { type: 'choice', answer_confidence: 0.9, probabilities: { implementation: 0.25, review: 0.25, research: 0.25, debugging: 0.25 } },
      }),
      'outside the choices this request offered',
    ],
    [
      'choice probabilities missing a key',
      goodAnswers({ work_kind: { type: 'choice', choice: 'review', answer_confidence: 0.9, probabilities: { review: 1 } } }),
      'expected a probability',
    ],
    [
      'choice confidence null',
      goodAnswers({ work_kind: { type: 'choice', choice: 'review', answer_confidence: null, probabilities: { implementation: 0, review: 1, research: 0, debugging: 0 } } }),
      'expected a probability',
    ],
    [
      'choice confidence above 1',
      goodAnswers({ work_kind: { type: 'choice', choice: 'review', answer_confidence: 1.4, probabilities: { implementation: 0, review: 1, research: 0, debugging: 0 } } }),
      'expected a probability',
    ],
    [
      'answer probabilities missing',
      goodAnswers({ work_kind: { type: 'choice', choice: 'review', answer_confidence: 0.9 } }),
      'missing a "probabilities"',
    ],
    [
      'score is not a number',
      goodAnswers({
        complexity: { ...consistentScore({ '0': 0.04, '1': 0.36, '2': 0.46, '3': 0.1, '4': 0.04 }, LEVELS), score: 'high' },
      }),
      'expected a finite number',
    ],
    [
      'score legend disagrees with the offered levels',
      goodAnswers({
        complexity: {
          ...consistentScore({ '0': 0.04, '1': 0.36, '2': 0.46, '3': 0.1, '4': 0.04 }, LEVELS),
          legend: { '0': 'a', '1': 'b', '2': 'c' },
        },
      }),
      'legend that disagrees with the levels',
    ],
    [
      'score legend missing',
      goodAnswers({
        complexity: (({ legend: _drop, ...rest }) => rest)(
          consistentScore({ '0': 0.04, '1': 0.36, '2': 0.46, '3': 0.1, '4': 0.04 }, LEVELS),
        ),
      }),
      'missing its "legend"',
    ],
    [
      'score legend is reversed',
      goodAnswers({
        complexity: {
          ...consistentScore({ '0': 0.04, '1': 0.36, '2': 0.46, '3': 0.1, '4': 0.04 }, LEVELS),
          // same five names, wrong order: index 2 now says "trivial"
          legend: { '0': 'very large', '1': 'large', '2': 'trivial', '3': 'small', '4': 'moderate' },
        },
      }),
      'legend that disagrees with the levels',
    ],
    [
      'score legend has a duplicated level',
      goodAnswers({
        complexity: {
          ...consistentScore({ '0': 0.04, '1': 0.36, '2': 0.46, '3': 0.1, '4': 0.04 }, LEVELS),
          legend: { '0': 'trivial', '1': 'small', '2': 'trivial', '3': 'large', '4': 'very large' },
        },
      }),
      'legend that disagrees with the levels',
    ],
    [
      'noul above 1',
      goodAnswers({ review_required: { type: 'noul', noul: 1.2, answer_confidence: 1.2 } }),
      'expected a probability',
    ],
    ['noul null', goodAnswers({ review_required: { type: 'noul', noul: null, answer_confidence: 0.5 } }), 'expected a probability'],
  ];
  for (const [name, answers, fragment] of outOfRange) {
    await withServer(jsonHandler(200, goodBody(answers)), async (baseUrl) => {
      let msg = '';
      try {
        await createLayaDecisionProvider({ baseUrl }).decide(ROUTING);
      } catch (e) {
        msg = (e as Error).message;
      }
      check(`rejects ${name}`, msg.includes(fragment), msg.slice(0, 170));
    });
  }

  // non-JSON, despite a 200
  await withServer(jsonHandler(200, 'not json at all'), async (baseUrl) => {
    await expectError(
      'non-JSON 200 body throws DecisionSchemaError',
      () => createLayaDecisionProvider({ baseUrl }).decide(ROUTING),
      DecisionSchemaError,
    );
  });

  // ---- CRITICAL: a self-contradictory choice -------------------------------
  // laya-serve can answer 200 with `choice: "a"` while its own distribution says
  // `a: 0.01, b: 0.99`. Laya's `choice` is the argmax of `probabilities`, so such
  // a payload claims "a" and simultaneously says "b, and not a". Accepting it
  // would report the option the provider itself considers least likely.
  const contradictory: Array<[string, Record<string, unknown>, string]> = [
    [
      'the reported case: choice a, but a=0.01 and b=0.99',
      goodAnswers({
        work_kind: {
          type: 'choice',
          choice: 'review',
          probabilities: { implementation: 0.99, review: 0.01, research: 0, debugging: 0 },
          answer_confidence: 0.99,
        },
      }),
      'self-contradictory',
    ],
    [
      'the chosen option is the strict minimum of the distribution',
      goodAnswers({
        work_kind: {
          type: 'choice',
          choice: 'research',
          probabilities: { implementation: 0.5, review: 0.3, research: 0.05, debugging: 0.15 },
          answer_confidence: 0.5,
        },
      }),
      'self-contradictory',
    ],
    [
      'a zero-probability option is reported as the choice',
      goodAnswers({
        work_kind: {
          type: 'choice',
          choice: 'debugging',
          probabilities: { implementation: 0.4, review: 0.4, research: 0.2, debugging: 0 },
          answer_confidence: 0.4,
        },
      }),
      'self-contradictory',
    ],
    [
      'the contradiction is by a hair (0.5000 vs 0.5001), which still counts',
      goodAnswers({
        work_kind: {
          type: 'choice',
          choice: 'review',
          probabilities: { implementation: 0.5001, review: 0.5, research: 0, debugging: 0 },
          answer_confidence: 0.5,
        },
      }),
      'self-contradictory',
    ],
  ];
  for (const [name, answers, fragment] of contradictory) {
    await withServer(jsonHandler(200, goodBody(answers)), async (baseUrl) => {
      let msg = '';
      try {
        await createLayaDecisionProvider({ baseUrl }).decide(ROUTING);
      } catch (e) {
        msg = (e as Error).message;
      }
      check(`rejects contradictory choice: ${name}`, msg.includes(fragment), msg.slice(0, 200) || 'no error thrown');
    });
  }

  // The complement: a consistent answer, including genuine ties, must still pass.
  // Every distribution here really sums to 1, so the only thing under test is
  // that ties are not mistaken for contradictions.
  const consistent: Array<[string, Record<string, number>, string]> = [
    [
      // The real captured distribution for the English refactor task, at the
      // full 4dp the service emits: it sums to 1.0001, which is inside the
      // 2e-4 sum bound for k=4. Truncating these to 3dp would give 1.001 and be
      // correctly refused, which is how the bound was calibrated.
      'the plain argmax case',
      { implementation: 0.6672, review: 0.1578, research: 0.0465, debugging: 0.1286 },
      'implementation',
    ],
    [
      'a tie between the top two, with a lower third and fourth',
      { implementation: 0.4, review: 0.4, research: 0.1, debugging: 0.1 },
      'review',
    ],
    [
      'a flat distribution, where every option is an argmax',
      { implementation: 0.25, review: 0.25, research: 0.25, debugging: 0.25 },
      'research',
    ],
    [
      'a tie below a clear winner is irrelevant to the choice',
      { implementation: 0.7, review: 0.1, research: 0.1, debugging: 0.1 },
      'implementation',
    ],
  ];
  for (const [name, probs, expectedChoice] of consistent) {
    await withServer(jsonHandler(200, goodBody(goodAnswers({ work_kind: consistentChoice(expectedChoice, probs) }))), async (baseUrl) => {
      const r = await createLayaDecisionProvider({ baseUrl }).decide(ROUTING);
      const got = r.answers[WORK_KIND_ID]?.type === 'choice' ? r.answers[WORK_KIND_ID].choice : null;
      check(`accepts consistent choice: ${name}`, got === expectedChoice, `got ${got}, want ${expectedChoice}`);
    });
  }

  // ---- response type mismatch --------------------------------------------
  const typeMismatches: Array<[string, Record<string, unknown>]> = [
    [
      'a score answer where a choice was asked',
      goodAnswers({
        work_kind: {
          type: 'score',
          score: 1,
          legend: { '0': 'a', '1': 'b' },
          probabilities: { '0': 0.5, '1': 0.5 },
          answer_confidence: 0.5,
        },
      }),
    ],
    [
      'a choice answer where a score was asked',
      goodAnswers({
        complexity: {
          type: 'choice',
          choice: 'small',
          probabilities: { trivial: 0.1, small: 0.9, moderate: 0, large: 0, 'very large': 0 },
          answer_confidence: 0.9,
        },
      }),
    ],
    [
      'a noul answer where a choice was asked',
      goodAnswers({ work_kind: { type: 'noul', noul: 0.5, answer_confidence: 0.5 } }),
    ],
    [
      'a choice answer where a noul was asked',
      goodAnswers({
        review_required: { type: 'choice', choice: 'yes', probabilities: { yes: 0.9, no: 0.1 }, answer_confidence: 0.9 },
      }),
    ],
    [
      'an answer with no type at all',
      goodAnswers({
        work_kind: { choice: 'implementation', probabilities: { implementation: 0.9, review: 0.05, research: 0.02, debugging: 0.03 }, answer_confidence: 0.9 },
      }),
    ],
  ];
  for (const [name, answers] of typeMismatches) {
    await withServer(jsonHandler(200, goodBody(answers)), async (baseUrl) => {
      let msg = '';
      try {
        await createLayaDecisionProvider({ baseUrl }).decide(ROUTING);
      } catch (e) {
        msg = (e as Error).message;
      }
      check(`rejects type mismatch: ${name}`, msg.includes('but a '), msg.slice(0, 200) || 'no error thrown');
    });
  }

  // ---- invalid probability values ----------------------------------------
  const badProbabilities: Array<[string, unknown, string]> = [
    ['null', null, 'expected a probability'],
    ['a numeric string', '0.5', 'expected a probability'],
    ['NaN', NaN, 'expected a probability'],
    ['Infinity', Infinity, 'expected a probability'],
    ['a negative value', -0.1, 'expected a probability'],
    ['above 1', 1.0001, 'expected a probability'],
    ['true', true, 'expected a probability'],
    ['an object', {}, 'expected a probability'],
    ['null', null, 'expected a probability'],
  ];
  for (const [name, value] of badProbabilities) {
    await withServer(
      jsonHandler(
        200,
        goodBody(
          goodAnswers({
            work_kind: {
              type: 'choice',
              choice: 'implementation',
              probabilities: { implementation: value, review: 0, research: 0, debugging: 0 },
              answer_confidence: 0.9,
            },
          }),
        ),
      ),
      async (baseUrl) => {
        let msg = '';
        try {
          await createLayaDecisionProvider({ baseUrl }).decide(ROUTING);
        } catch (e) {
          msg = (e as Error).message;
        }
        check(`rejects probability value: ${name}`, msg.includes('expected a probability'), msg.slice(0, 200) || 'no error thrown');
      },
    );
  }
  // A distribution that is not an object at all.
  for (const [name, value] of [
    ['an array', [1, 2, 3]],
    ['a string', 'nope'],
    ['null', null],
  ] as Array<[string, unknown]>) {
    await withServer(
      jsonHandler(
        200,
        goodBody(
          goodAnswers({
            work_kind: { type: 'choice', choice: 'implementation', probabilities: value, answer_confidence: 0.9 },
          }),
        ),
      ),
      async (baseUrl) => {
        let msg = '';
        try {
          await createLayaDecisionProvider({ baseUrl }).decide(ROUTING);
        } catch (e) {
          msg = (e as Error).message;
        }
        check(`rejects probabilities that is ${name}`, msg.includes('missing a "probabilities" distribution'), msg.slice(0, 200) || 'no error thrown');
      },
    );
  }
}

// ---- transport and liveness ----------------------------------------------

async function testTransport(): Promise<void> {
  // service unavailable
  await expectError(
    'server unreachable throws DecisionUnavailableError',
    () => createLayaDecisionProvider({ baseUrl: 'http://127.0.0.1:1' }).decide(ROUTING),
    DecisionUnavailableError,
  );

  // non-2xx carries the provider's own explanation
  await withServer(jsonHandler(413, { detail: 'state too large (50013 > 50000 chars)' }), async (baseUrl) => {
    await expectError(
      '4xx becomes DecisionTransportError',
      () => createLayaDecisionProvider({ baseUrl }).decide(ROUTING),
      DecisionTransportError,
    );
  });
  await withServer(jsonHandler(422, { detail: "unknown type 'vibe'" }), async (baseUrl) => {
    try {
      await createLayaDecisionProvider({ baseUrl }).decide(ROUTING);
    } catch (e) {
      check('422 body is surfaced to the operator', (e as Error).message.includes("unknown type 'vibe'"), (e as Error).message);
    }
  });
  await withServer(jsonHandler(500, 'boom'), async (baseUrl) => {
    await expectError(
      '5xx becomes DecisionTransportError, not a default answer',
      () => createLayaDecisionProvider({ baseUrl }).decide(ROUTING),
      DecisionTransportError,
    );
  });

  // timeout
  await withServer((_req, res) => setTimeout(() => res.end('{}'), 1_500), async (baseUrl) => {
    await expectError(
      'a slow provider becomes DecisionTimeoutError, not a default answer',
      () => createLayaDecisionProvider({ baseUrl, timeoutMs: 150 }).decide(ROUTING),
      DecisionTimeoutError,
    );
  });

  // probe
  await withServer(
    (req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            loaded: ['english', 'multilingual', 'typed-decisions'],
            device: 'cuda',
            cpu_fallbacks: { english: { count: 2, last_reason: 'CUDA OOM' } },
          }),
        );
      } else {
        res.writeHead(404).end();
      }
    },
    async (baseUrl) => {
      const probe = await createLayaDecisionProvider({ baseUrl }).probe();
      check('probe ok on a healthy server', probe.ok, probe.detail);
      check('probe reports device and checkpoints', probe.detail.includes('cuda') && probe.detail.includes('english'), probe.detail);
      check('probe surfaces a CPU fallback as a warning', probe.warnings.some((w) => w.includes('CUDA OOM')), probe.warnings.join(' | '));
    },
  );
  await withServer(jsonHandler(200, { status: 'ok', loaded: [], device: 'cpu' }), async (baseUrl) => {
    const probe = await createLayaDecisionProvider({ baseUrl }).probe();
    check('probe warns when no checkpoint is loaded', probe.warnings.some((w) => w.includes('no checkpoints')), probe.warnings.join(' | '));
  });
  await withServer(jsonHandler(503, { status: 'starting' }), async (baseUrl) => {
    const probe = await createLayaDecisionProvider({ baseUrl }).probe();
    check('probe reports a non-2xx health as not ok', probe.ok === false, probe.detail);
  });
  {
    const probe = await createLayaDecisionProvider({ baseUrl: 'http://127.0.0.1:1' }).probe();
    check('probe reports unreachable without throwing', probe.ok === false, probe.detail);
  }

  // ---- probe must never leak a parse failure ------------------------------
  // A SyntaxError escaping probe() would turn "is the service ready?" into a
  // crash in whatever code asked.
  const badHealth: Array<[string, unknown, string]> = [
    ['health body is not JSON', 'not json at all', 'not valid JSON'],
    ['health body is an array', [1, 2, 3], 'expected an object'],
    ['health body is a bare string', 'ok', 'expected an object'],
    ['health body is null', null, 'expected an object'],
    ['health payload has no status', { loaded: ['english'], device: 'cuda' }, 'no string "status"'],
    ['health status is a number', { status: 200 }, 'no string "status"'],
    ['health loaded is a string, not an array', { status: 'ok', loaded: 'english' }, 'expected an array of strings'],
    ['health loaded holds non-strings', { status: 'ok', loaded: ['english', 7] }, 'expected an array of strings'],
    ['health device is a number', { status: 'ok', device: 3 }, '"device" is number'],
    ['health cpu_fallbacks is an array', { status: 'ok', cpu_fallbacks: [] }, '"cpu_fallbacks" is an array'],
    ['health cpu_fallbacks entry has no count', { status: 'ok', cpu_fallbacks: { english: {} } }, 'expected { count: number'],
    ['health cpu_fallbacks count is a string', { status: 'ok', cpu_fallbacks: { english: { count: '2' } } }, 'expected { count: number'],
  ];
  for (const [name, body, fragment] of badHealth) {
    await withServer(
      (req, res) => {
        if (req.url !== '/health') {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        // A bare, unquoted body stands in for a server that returns non-JSON.
        res.end(typeof body === 'string' && body === 'not json at all' ? body : JSON.stringify(body));
      },
      async (baseUrl) => {
        const probe = await createLayaDecisionProvider({ baseUrl }).probe();
        check(`probe survives ${name}`, probe.ok === false, probe.detail);
        check(`probe explains ${name}`, probe.detail.includes(fragment), probe.detail);
      },
    );
  }

  // A well-formed but not-"ok" payload is a legitimate negative result, not a
  // structural failure, and is reported as such.
  await withServer(jsonHandler(200, { status: 'starting', loaded: [], device: 'cpu' }), async (baseUrl) => {
    const probe = await createLayaDecisionProvider({ baseUrl }).probe();
    check('a valid status=starting payload is reported as not ok', probe.ok === false, probe.detail);
    check('a valid payload still yields warnings', probe.warnings.length > 0, probe.warnings.join(' | '));
  });

  // ---- baseUrl boundary ---------------------------------------------------
  // The project is local-only and makes no provider API calls, and a decision
  // request carries the task text, so a remote endpoint must be a deliberate
  // opt-in rather than something a config slip can reach.
  for (const bad of ['http://10.0.0.5:8077', 'https://laya.example.com', 'http://192.168.1.20:8077']) {
    let msg = '';
    try {
      createLayaDecisionProvider({ baseUrl: bad });
    } catch (e) {
      msg = (e as Error).message;
    }
    check(`non-loopback baseUrl is refused: ${bad}`, msg.includes('is not loopback'), msg.slice(0, 160) || 'no error thrown');
  }
  for (const bad of ['not a url', '/relative/path', 'ftp://127.0.0.1:8077', '']) {
    let msg = '';
    try {
      createLayaDecisionProvider({ baseUrl: bad });
    } catch (e) {
      msg = (e as Error).message;
    }
    check(`malformed baseUrl is refused: ${JSON.stringify(bad)}`, msg.length > 0, msg.slice(0, 160) || 'no error thrown');
  }
  for (const good of ['http://127.0.0.1:8077', 'http://127.0.0.1:9/', 'http://localhost:8077', 'http://[::1]:8077']) {
    let threw = false;
    let msg = '';
    try {
      createLayaDecisionProvider({ baseUrl: good });
    } catch (e) {
      threw = true;
      msg = (e as Error).message;
    }
    check(`loopback baseUrl is accepted: ${good}`, !threw, msg);
  }
  {
    let threw = false;
    let msg = '';
    try {
      createLayaDecisionProvider({ baseUrl: 'https://laya.example.com', allowRemote: true });
    } catch (e) {
      threw = true;
      msg = (e as Error).message;
    }
    check('allowRemote: true opts in to a remote endpoint', !threw, msg);
  }

  // ---- Decision Layer error normalization --------------------------------
  // Every failure this layer produces is a DecisionError with a stable code, and
  // nothing leaks a bare TypeError. This is what lets a caller catch one type.
  {
    const provider = createLayaDecisionProvider({ baseUrl: 'http://127.0.0.1:1' });
    const cases: Array<[string, () => Promise<unknown>, string]> = [
      ['unavailable', () => provider.decide(ROUTING), 'DECISION_UNAVAILABLE'],
      ['bad request', () => provider.decide(null as never), 'DECISION_INPUT'],
    ];
    for (const [name, fn, code] of cases) {
      let caught: unknown = null;
      try {
        await fn();
      } catch (e) {
        caught = e;
      }
      check(`${name} is a DecisionError`, isDecisionError(caught), String(caught));
      check(`${name} carries code ${code}`, (caught as DecisionError)?.code === code, String((caught as DecisionError)?.code));
      check(`${name} has a non-empty name`, typeof (caught as Error)?.name === 'string' && (caught as Error).name.length > 0);
      check(`${name} has an actionable message`, ((caught as Error)?.message.length ?? 0) > 40, String((caught as Error)?.message).slice(0, 80));
      check(`${name} is not a bare TypeError`, !(caught instanceof TypeError), String(caught));
    }
  }

  // routing projection failures use the same hierarchy
  for (const bad of [
    { answers: {}, provider: { name: 'x', model: 'm', elapsedMs: 1, details: {} }, raw: {} },
    {
      answers: { [WORK_KIND_ID]: { type: 'noul', noul: toProbability(0.5)!, probabilities: {}, confidence: toProbability(0.5)! } },
      provider: { name: 'x', model: 'm', elapsedMs: 1, details: {} },
      raw: {},
    },
  ]) {
    let caught: unknown = null;
    try {
      toTaskClassification(bad as never);
    } catch (e) {
      caught = e;
    }
    check('a routing projection failure is a DecisionError', isDecisionError(caught), String(caught));
    check('a routing projection failure is not a bare Error', !(caught instanceof TypeError) && caught !== null, String(caught));
  }

  // layaMetadata refuses a response that did not come from Laya
  {
    let caught: unknown = null;
    try {
      layaMetadata({ provider: { name: 'other', model: 'm', elapsedMs: 1, details: {} } });
    } catch (e) {
      caught = e;
    }
    check('layaMetadata rejects a foreign provider', isDecisionError(caught), String(caught));
  }
}

// ---- the routing preset on top -------------------------------------------

async function testRoutingPreset(): Promise<void> {
  // The level comes from the request's own criteria at the rounded index. A
  // legend is now REQUIRED to match the request exactly, so this uses a valid
  // legend and checks the level is read from criteria, not from the provider's
  // labelling (which is verified separately to be identical anyway).
  await withServer(
    jsonHandler(200, goodBody(goodAnswers({ complexity: consistentScore({ '0': 0.0, '1': 0.0, '2': 1.0, '3': 0.0, '4': 0.0 }, LEVELS) }))),
    async (baseUrl) => {
      const c = await classifyTask(createLayaDecisionProvider({ baseUrl }), { task: 't' });
      eq('level is criteria[round(score)]', c.complexity, 'moderate');
      eq('score is the expectation, here exactly 2', c.complexity_score, 2);
    },
  );

  // review threshold is a real boundary
  for (const [noul, expected] of [
    [0.678, true],
    [0.5, false],
    [0.498, false],
    [0.077, false],
    [1, true],
  ] as Array<[number, boolean]>) {
    await withServer(
      jsonHandler(
        200,
        goodBody(
          goodAnswers({
            // answer_confidence for a noul is max(noul, 1 - noul), since the
            // provider splits over two options and sends no distribution.
            review_required: { type: 'noul', noul, answer_confidence: round4(Math.max(noul, 1 - noul)) },
          }),
        ),
      ),
      async (baseUrl) => {
        const c = await classifyTask(createLayaDecisionProvider({ baseUrl }), { task: 't' });
        check(`noul ${noul} -> review_required ${expected}`, c.review_required === expected, String(c.review_required));
        eq(`noul ${noul} is preserved raw`, c.review_noul, noul);
      },
    );
  }

  // classification carries provider metadata for debugging
  await withServer(jsonHandler(200, goodBody()), async (baseUrl) => {
    const c = await classifyTask(createLayaDecisionProvider({ baseUrl }), { task: 't' });
    const m = layaMetadata(c);
    eq('classification carries the checkpoint', m.checkpoint, 'english');
    check('classification carries elapsed time', c.provider.elapsedMs >= 0);
    check('classification carries the raw envelope', (c.raw as Record<string, unknown>).model === 'laya-rl-agent');
  });

  // the pinned question set is what gets asked
  await withServer(
    (req, res) => {
      const body = JSON.parse((req as IncomingMessage & { rawBody: string }).rawBody);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(goodBody()));
      sentQuestions = body.questions as Record<string, DecisionQuestion>;
    },
    async (baseUrl) => {
      await classifyTask(createLayaDecisionProvider({ baseUrl }), { task: 't' });
      const choice = sentQuestions[WORK_KIND_ID];
      check('work_kind is asked as a 4-option choice', choice?.type === 'choice' && Object.keys(choice.criteria).length === 4, choice?.type);
      check('complexity is asked as a 5-level score', sentQuestions[COMPLEXITY_ID]?.type === 'score');
      check('review is asked as a noul', sentQuestions[REVIEW_ID]?.type === 'noul');
    },
  );

  // toTaskClassification re-checks rather than casting
  const base = {
    answers: {},
    provider: { name: 'x', model: 'm', elapsedMs: 1, details: {} },
    raw: {},
  };
  const choiceAnswer = (choice: string) => ({
    type: 'choice' as const,
    choice,
    criteria: { implementation: '', review: '', research: '', debugging: '' },
    probabilities: { implementation: 0.25, review: 0.25, research: 0.25, debugging: 0.25 },
    confidence: toProbability(0.25)!,
  });
  const scoreAnswer = (level: string) => ({
    type: 'score' as const,
    score: 1,
    level,
    levels: [...COMPLEXITY_LEVELS],
    probabilities: { '0': 0.2, '1': 0.2, '2': 0.2, '3': 0.2, '4': 0.2 },
    confidence: toProbability(0.2)!,
  });
  const noulAnswer = { type: 'noul' as const, noul: toProbability(0.5)!, probabilities: {}, confidence: toProbability(0.5)! };

  check(
    'toTaskClassification rejects an out-of-vocabulary choice',
    (() => {
      try {
        toTaskClassification({ ...base, answers: { [WORK_KIND_ID]: choiceAnswer('vibes'), [COMPLEXITY_ID]: scoreAnswer('small'), [REVIEW_ID]: noulAnswer } });
        return false;
      } catch {
        return true;
      }
    })(),
  );
  check(
    'toTaskClassification rejects a missing answer',
    (() => {
      try {
        toTaskClassification({ ...base, answers: { [WORK_KIND_ID]: choiceAnswer('review') } });
        return false;
      } catch {
        return true;
      }
    })(),
  );
  check(
    'toTaskClassification rejects a wrong-typed answer',
    (() => {
      try {
        toTaskClassification({ ...base, answers: { [WORK_KIND_ID]: noulAnswer, [COMPLEXITY_ID]: scoreAnswer('small'), [REVIEW_ID]: noulAnswer } });
        return false;
      } catch {
        return true;
      }
    })(),
  );

  // the vocabulary itself is closed
  eq('WORK_KINDS is closed and ordered', [...WORK_KINDS], ['implementation', 'review', 'research', 'debugging']);
  eq('COMPLEXITY_LEVELS is closed and ordered', [...COMPLEXITY_LEVELS], ['trivial', 'small', 'moderate', 'large', 'very large']);

  // routingRequest builds the generic request
  const rq = routingRequest({ task: 'do it', context: { repo: 'x' } });
  eq('routingRequest carries the task', rq.task, 'do it');
  eq('routingRequest carries context', rq.context?.repo, 'x');
  eq('routingRequest asks three questions', Object.keys(rq.questions).length, 3);
}

/**
 * SCORE CONSISTENCY.
 *
 * The rule under test comes from laya/agent.py, verified against the installed
 * 0.3.21:
 *   score = round(Σ(i * p_i), 4)     -- an EXPECTATION, not an argmax
 *   legend = {str(i): criteria[i]}   -- the request's own levels, in order
 *
 * So `round(score) != argmax(p)` is NORMAL and must be accepted, while a score
 * that is not the expectation of the distribution beside it must be rejected.
 * The last case here is the one an argmax rule would get wrong.
 */
async function testScoreConsistency(): Promise<void> {
  const SCORE_ID = COMPLEXITY_ID;

  async function decideWith(complexity: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    let ok = false;
    let message = '';
    await withServer(jsonHandler(200, goodBody(goodAnswers({ [SCORE_ID]: complexity }))), async (baseUrl) => {
      try {
        await createLayaDecisionProvider({ baseUrl }).decide(ROUTING);
        ok = true;
      } catch (e) {
        message = (e as Error).message;
      }
    });
    return { ok, message };
  }

  // ---- accepted ----
  const accepted: Array<[string, Record<string, number>, number, string]> = [
    ['a plain expectation', { '0': 0.0286, '1': 0.3935, '2': 0.5052, '3': 0.0652, '4': 0.0075 }, 1.6295, 'moderate'],
    [
      'a clean peak, expectation exactly on an index',
      { '0': 0.0, '1': 0.0, '2': 1.0, '3': 0.0, '4': 0.0 },
      2,
      'moderate',
    ],
    [
      'the lowest level',
      { '0': 1.0, '1': 0.0, '2': 0.0, '3': 0.0, '4': 0.0 },
      0,
      'trivial',
    ],
    [
      'the highest level',
      { '0': 0.0, '1': 0.0, '2': 0.0, '3': 0.0, '4': 1.0 },
      4,
      'very large',
    ],
    [
      'a flat distribution, expectation 2.0',
      { '0': 0.2, '1': 0.2, '2': 0.2, '3': 0.2, '4': 0.2 },
      2,
      'moderate',
    ],
    [
      // THE CASE AN ARGMAX RULE WOULD REJECT. argmax is index 1 ('small'), but
      // the expectation is 1.5, which rounds to index 2 ('moderate'). Both are
      // correct answers; only the expectation rule accepts the right one.
      'score is not the argmax of its distribution',
      { '0': 0.1, '1': 0.6, '2': 0.1, '3': 0.1, '4': 0.1 },
      1.5,
      'moderate',
    ],
    [
      // argmax is index 4 ('very large'), expectation 2.2 -> index 2.
      'a high argmax but a middling expectation',
      { '0': 0.3, '1': 0.1, '2': 0.1, '3': 0.1, '4': 0.4 },
      2.2,
      'moderate',
    ],
  ];
  for (const [name, probs, expectedScore, expectedLevel] of accepted) {
    const r = await decideWith(consistentScore(probs, LEVELS));
    if (!r.ok) {
      check(`accepts score: ${name}`, false, r.message.slice(0, 190));
      continue;
    }
    check(`accepts score: ${name}`, true);
    eq(`  ${name} -> score`, (consistentScore(probs, LEVELS) as Record<string, unknown>).score, expectedScore);
    eq(`  ${name} -> level`, LEVELS[Math.round(expectedScore)], expectedLevel);
  }

  // the level really is criteria[round(score)] for the non-argmax cases
  {
    const classify = async (probs: Record<string, number>): Promise<TaskClassification> => {
      let out: TaskClassification | null = null;
      await withServer(
        jsonHandler(200, goodBody(goodAnswers({ [SCORE_ID]: consistentScore(probs, LEVELS) }))),
        async (baseUrl) => {
          out = await classifyTask(createLayaDecisionProvider({ baseUrl }), { task: 't' });
        },
      );
      return out as unknown as TaskClassification;
    };
    const a = await classify({ '0': 0.1, '1': 0.6, '2': 0.1, '3': 0.1, '4': 0.1 });
    eq('a non-argmax score keeps its expectation', a.complexity_score, 1.5);
    eq('the level is criteria[round(score)], not the argmax', a.complexity, 'moderate');
    const b = await classify({ '0': 0.3, '1': 0.1, '2': 0.1, '3': 0.1, '4': 0.4 });
    eq('a high-argmax score keeps its expectation', b.complexity_score, 2.2);
    eq('its level is also criteria[round(score)]', b.complexity, 'moderate');
  }

  // ---- 4-decimal rounding is tolerated ----
  // The service serialises score as round(expectation, 4), so the reported value
  // can differ from the expectation of the reported distribution in the last
  // decimal. A legal answer must not be rejected for that.
  {
    const base = consistentScore({ '0': 0.0286, '1': 0.3935, '2': 0.5052, '3': 0.0652, '4': 0.0075 }, LEVELS) as Record<string, unknown>;
    for (const [name, nudge] of [
      ['score 1e-4 above the expectation', 0.0001],
      ['score 1e-4 below the expectation', -0.0001],
      // expectationTolerance(5) = 5e-5 * (1 + 5*4/2) = 5e-5 * 11 = 5.5e-4
      ['score 5e-4 above the expectation (at the tolerance bound)', 0.0005],
    ] as Array<[string, number]>) {
      const r = await decideWith({ ...base, score: round4(1.6295 + nudge) });
      check(`tolerates rounding: ${name}`, r.ok, r.message.slice(0, 190));
    }
  }

  // ---- rejected ----
  const rejected: Array<[string, Record<string, unknown>, string]> = [
    [
      'score contradicts the distribution it ships with',
      { ...consistentScore({ '0': 0.1, '1': 0.1, '2': 0.1, '3': 0.1, '4': 0.6 }, LEVELS), score: 1.0 },
      'self-contradictory',
    ],
    [
      'score is the argmax index rather than the expectation',
      { ...consistentScore({ '0': 0.1, '1': 0.6, '2': 0.1, '3': 0.1, '4': 0.1 }, LEVELS), score: 1 },
      'self-contradictory',
    ],
    [
      'score off by half a level',
      { ...consistentScore({ '0': 0.1, '1': 0.1, '2': 0.1, '3': 0.1, '4': 0.6 }, LEVELS), score: 3.8 },
      'self-contradictory',
    ],
    [
      'legend is reversed',
      { ...consistentScore({ '0': 0.1, '1': 0.6, '2': 0.1, '3': 0.1, '4': 0.1 }, LEVELS), legend: { '0': 'very large', '1': 'large', '2': 'moderate', '3': 'small', '4': 'trivial' } },
      'legend that disagrees with the levels',
    ],
    [
      'legend renames a level',
      { ...consistentScore({ '0': 0.1, '1': 0.6, '2': 0.1, '3': 0.1, '4': 0.1 }, LEVELS), legend: { '0': 'trivial', '1': 'small', '2': 'moderate', '3': 'large', '4': 'enormous' } },
      'legend that disagrees with the levels',
    ],
    [
      'legend has fewer entries than the request offered',
      { ...consistentScore({ '0': 0.1, '1': 0.6, '2': 0.1, '3': 0.1, '4': 0.1 }, LEVELS), legend: { '0': 'trivial', '1': 'small' } },
      'legend that disagrees with the levels',
    ],
    [
      'a probability is missing',
      (() => {
        const a = consistentScore({ '0': 0.1, '1': 0.6, '2': 0.1, '3': 0.1, '4': 0.1 }, LEVELS) as Record<string, unknown>;
        const p = { ...(a.probabilities as Record<string, number>) };
        delete p['3'];
        return { ...a, probabilities: p };
      })(),
      'expected a probability',
    ],
    [
      'an extra probability index is invented',
      { ...consistentScore({ '0': 0.1, '1': 0.6, '2': 0.1, '3': 0.1, '4': 0.1 }, LEVELS), probabilities: { '0': 0.1, '1': 0.6, '2': 0.1, '3': 0.1, '4': 0.1, '5': 0.0 } },
      'which this request did not offer',
    ],
    [
      'a probability is null',
      { ...consistentScore({ '0': 0.1, '1': 0.6, '2': 0.1, '3': 0.1, '4': 0.1 }, LEVELS), probabilities: { '0': 0.1, '1': 0.6, '2': 0.1, '3': 0.1, '4': null } },
      'expected a probability',
    ],
    [
      'a probability is NaN',
      { ...consistentScore({ '0': 0.1, '1': 0.6, '2': 0.1, '3': 0.1, '4': 0.1 }, LEVELS), probabilities: { '0': 0.1, '1': 0.6, '2': 0.1, '3': 0.1, '4': NaN } },
      'expected a probability',
    ],
    [
      'a probability is Infinity',
      { ...consistentScore({ '0': 0.1, '1': 0.6, '2': 0.1, '3': 0.1, '4': 0.1 }, LEVELS), probabilities: { '0': 0.1, '1': 0.6, '2': 0.1, '3': 0.1, '4': Infinity } },
      'expected a probability',
    ],
    [
      'a probability is negative',
      { ...consistentScore({ '0': 0.1, '1': 0.6, '2': 0.1, '3': 0.1, '4': 0.1 }, LEVELS), probabilities: { '0': 0.1, '1': 0.6, '2': 0.1, '3': 0.1, '4': -0.1 } },
      'expected a probability',
    ],
    [
      'a probability is above 1',
      { ...consistentScore({ '0': 0.1, '1': 0.6, '2': 0.1, '3': 0.1, '4': 0.1 }, LEVELS), probabilities: { '0': 0.1, '1': 0.6, '2': 0.1, '3': 0.1, '4': 1.4 } },
      'expected a probability',
    ],
    [
      'the distribution does not sum to 1',
      { ...consistentScore({ '0': 0.1, '1': 0.6, '2': 0.1, '3': 0.1, '4': 0.1 }, LEVELS), probabilities: { '0': 0.2, '1': 0.6, '2': 0.2, '3': 0.2, '4': 0.2 } },
      'summing to',
    ],
    [
      'the distribution sums to 0',
      { ...consistentScore({ '0': 0.1, '1': 0.6, '2': 0.1, '3': 0.1, '4': 0.1 }, LEVELS), probabilities: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0 } },
      'summing to',
    ],
    [
      'score is above the top index',
      { ...consistentScore({ '0': 0.1, '1': 0.1, '2': 0.1, '3': 0.1, '4': 0.6 }, LEVELS), score: 9 },
      'outside the',
    ],
    [
      'score is below the bottom index',
      { ...consistentScore({ '0': 0.1, '1': 0.1, '2': 0.1, '3': 0.1, '4': 0.6 }, LEVELS), score: -3 },
      'outside the',
    ],
    [
      'score is NaN',
      { ...consistentScore({ '0': 0.1, '1': 0.6, '2': 0.1, '3': 0.1, '4': 0.1 }, LEVELS), score: NaN },
      'expected a finite number',
    ],
    [
      'score is Infinity',
      { ...consistentScore({ '0': 0.1, '1': 0.6, '2': 0.1, '3': 0.1, '4': 0.1 }, LEVELS), score: Infinity },
      'expected a finite number',
    ],
    [
      'score is a string',
      { ...consistentScore({ '0': 0.1, '1': 0.6, '2': 0.1, '3': 0.1, '4': 0.1 }, LEVELS), score: 'moderate' },
      'expected a finite number',
    ],
  ];
  for (const [name, complexity, fragment] of rejected) {
    const r = await decideWith(complexity);
    check(`rejects score: ${name}`, !r.ok && r.message.includes(fragment), (r.ok ? 'accepted' : r.message.slice(0, 190)));
  }
}

/**
 * ANSWER_CONFIDENCE CONSISTENCY.
 *
 * `answer_confidence` is `max(probabilities)` (laya/common.py:answer_confidence).
 * Checking only [0, 1] would accept `{a: 0.01, b: 0.99}` reported with
 * `answer_confidence: 0.99`. For a noul, which ships no distribution, the same
 * guarantee is available as max(noul, 1 - noul).
 */
async function testAnswerConfidenceConsistency(): Promise<void> {
  async function decideWith(answer: Record<string, unknown>, id = WORK_KIND_ID): Promise<{ ok: boolean; message: string }> {
    let ok = false;
    let message = '';
    await withServer(jsonHandler(200, goodBody(goodAnswers({ [id]: answer }))), async (baseUrl) => {
      try {
        await createLayaDecisionProvider({ baseUrl }).decide(ROUTING);
        ok = true;
      } catch (e) {
        message = (e as Error).message;
      }
    });
    return { ok, message };
  }

  // A distribution whose maximum is 0.99, and one whose maximum is 0.35, so
  // "confidence == max" can be checked at both a high and a middling value.
  const peaked = { implementation: 0.01, review: 0.99, research: 0, debugging: 0 };
  const middling = { implementation: 0.05, review: 0.35, research: 0.3, debugging: 0.3 };

  // accepted: confidence equals the maximum
  {
    const r = await decideWith({ type: 'choice', choice: 'review', probabilities: peaked, answer_confidence: 0.99, confidence: 0.5 });
    check('accepts confidence equal to max(probabilities) = 0.99', r.ok, r.message.slice(0, 190));
  }
  {
    const r = await decideWith({ type: 'choice', choice: 'review', probabilities: middling, answer_confidence: 0.35, confidence: 0.5 });
    check('accepts confidence equal to max(probabilities) = 0.35', r.ok, r.message.slice(0, 190));
  }
  {
    // floating point boundary: the service rounds to 4dp, so a value inside the
    // rounding budget must be accepted.
    const a = consistentScore({ '0': 0.0286, '1': 0.3935, '2': 0.5052, '3': 0.0652, '4': 0.0075 }, LEVELS) as Record<string, unknown>;
    const r = await decideWith({ ...a, answer_confidence: 0.5053 }, COMPLEXITY_ID);
    check('tolerates a 1e-4 confidence overshoot from 4dp rounding', r.ok, r.message.slice(0, 190));
  }
  {
    const r = await decideWith({ type: 'noul', noul: 0.2, answer_confidence: 0.8 }, REVIEW_ID);
    check('accepts a noul whose confidence is max(noul, 1-noul) = 0.8', r.ok, r.message.slice(0, 190));
  }
  {
    const r = await decideWith({ type: 'noul', noul: 0.9, answer_confidence: 0.9 }, REVIEW_ID);
    check('accepts a noul of 0.9 with confidence 0.9', r.ok, r.message.slice(0, 190));
  }

  // rejected: confidence disagrees with the distribution
  const bad: Array<[string, Record<string, unknown>, string, string?]> = [
    [
      // the reported case: probabilities peak at 0.99 but the answer claims 0.01
      'claims 0.01 where the distribution peaks at 0.99',
      { type: 'choice', choice: 'review', probabilities: peaked, answer_confidence: 0.01, confidence: 0.5 },
      'self-contradictory',
    ],
    [
      'claims 0.99 where the distribution peaks at 0.35',
      { type: 'choice', choice: 'review', probabilities: middling, answer_confidence: 0.99, confidence: 0.5 },
      'self-contradictory',
    ],
    [
      'claims 0.5 where the distribution peaks at 0.99',
      { type: 'choice', choice: 'review', probabilities: peaked, answer_confidence: 0.5, confidence: 0.5 },
      'self-contradictory',
    ],
    [
      'confidence is null',
      { type: 'choice', choice: 'review', probabilities: peaked, answer_confidence: null, confidence: 0.5 },
      'expected a probability',
    ],
    [
      'confidence is above 1',
      { type: 'choice', choice: 'review', probabilities: peaked, answer_confidence: 1.4, confidence: 0.5 },
      'expected a probability',
    ],
    [
      'confidence is negative',
      { type: 'choice', choice: 'review', probabilities: peaked, answer_confidence: -0.2, confidence: 0.5 },
      'expected a probability',
    ],
    [
      'confidence is a string',
      { type: 'choice', choice: 'review', probabilities: peaked, answer_confidence: 'high', confidence: 0.5 },
      'expected a probability',
    ],
    [
      'a noul whose confidence is not max(noul, 1-noul)',
      { type: 'noul', noul: 0.2, answer_confidence: 0.2 },
      'self-contradictory',
      REVIEW_ID,
    ],
  ];
  for (const [name, answer, fragment, id] of bad) {
    const r = await decideWith(answer, id ?? WORK_KIND_ID);
    check(`rejects confidence: ${name}`, !r.ok && r.message.includes(fragment), (r.ok ? 'accepted' : r.message.slice(0, 190)));
  }
}

/** The minor hardening items: timeoutMs, loopback octets, health last_reason. */
async function testProviderOptionHardening(): Promise<void> {
  // ---- timeoutMs ----
  for (const [name, value] of [
    ['zero', 0],
    ['negative', -1],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['a string', '1000' as unknown as number],
    ['null', null as unknown as number],
  ] as Array<[string, number]>) {
    let msg = '';
    try {
      createLayaDecisionProvider({ baseUrl: 'http://127.0.0.1:8077', timeoutMs: value });
    } catch (e) {
      msg = (e as Error).message;
    }
    check(`illegal timeoutMs is refused: ${name}`, msg.length > 0 && !msg.includes('RangeError'), msg.slice(0, 150) || 'no error thrown');
  }
  {
    let threw = false;
    let msg = '';
    try {
      createLayaDecisionProvider({ baseUrl: 'http://127.0.0.1:8077', timeoutMs: 1 });
    } catch (e) {
      threw = true;
      msg = (e as Error).message;
    }
    check('a small but legal timeoutMs is accepted', !threw, msg);
  }

  // ---- loopback octets ----
  // WHATWG URL already rejects a host whose IPv4 octets exceed 255, so these
  // arrive here as an invalid URL. The octet check is the belt to that braces.
  for (const bad of ['http://127.999.999.999:8077', 'http://127.256.0.1:8077', 'http://127.0.0.300:8077']) {
    let msg = '';
    try {
      createLayaDecisionProvider({ baseUrl: bad });
    } catch (e) {
      msg = (e as Error).message;
    }
    const refused = msg.includes('not loopback') || msg.includes('not a valid absolute URL');
    check(`out-of-range loopback octets are not treated as loopback: ${bad}`, refused, msg.slice(0, 150) || 'accepted');
  }
  for (const good of [
    'http://127.0.0.1:8077',
    'http://127.1.2.3:8077',
    'http://127.255.255.255:8077',
    // URL normalises the 3-part form to 127.0.0.0, which really is 127/8.
    'http://127.0.0:8077',
  ]) {
    let threw = false;
    let msg = '';
    try {
      createLayaDecisionProvider({ baseUrl: good });
    } catch (e) {
      threw = true;
      msg = (e as Error).message;
    }
    check(`a real 127/8 address is accepted: ${good}`, !threw, msg);
  }

  // ---- health last_reason ----
  for (const [name, payload, expected] of [
    ['last_reason is a number', { status: 'ok', cpu_fallbacks: { english: { count: 1, last_reason: 5 } } }, 'last_reason'],
    ['last_reason is an object', { status: 'ok', cpu_fallbacks: { english: { count: 1, last_reason: { a: 1 } } } }, 'last_reason'],
    ['last_reason is null', { status: 'ok', cpu_fallbacks: { english: { count: 1, last_reason: null } } }, ''],
    ['last_reason is a string', { status: 'ok', cpu_fallbacks: { english: { count: 1, last_reason: 'CUDA OOM' } } }, ''],
  ] as Array<[string, unknown, string]>) {
    await withServer(jsonHandler(200, payload), async (baseUrl) => {
      const probe = await createLayaDecisionProvider({ baseUrl }).probe();
      if (expected === '') {
        check(`health accepts ${name}`, probe.ok === true, probe.detail);
      } else {
        check(`health refuses ${name}`, probe.ok === false && probe.detail.includes(expected), probe.detail);
      }
    });
  }
}

/**
 * TOLERANCE BOUNDARIES AT LARGE k.
 *
 * The old single tolerance, 2*5e-5*k^2, is 1.0 at k = 100. That means a
 * distribution summing to 0, or a confidence 0.98 away from its own maximum,
 * used to be ACCEPTED. These cases are the regression for that, and they are
 * written by hand rather than through consistentChoice/consistentScore so they
 * do not inherit a builder that would quietly re-derive a consistent value.
 */
async function testHighKBoundaries(): Promise<void> {
  // ---- 100 choices ----
  const k100 = Array.from({ length: 100 }, (_, i) => `o${i}`);
  const criteria100 = Object.fromEntries(k100.map((c) => [c, `description ${c}`]));
  const request100: DecisionRequest = {
    questions: { big: { type: 'choice', instructions: 'Which one?', criteria: criteria100 } },
    task: 't',
  };

  /** The answer must be keyed by the question id, or the envelope has no answer for it. */
  const manyBody = (answer: Record<string, unknown>): unknown => ({
    model: 'laya-rl-agent',
    answers: { big: answer },
    routing: { model: 'english', reason: 'English Latin text' },
  });

  async function decide100(answer: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    let ok = false;
    let message = '';
    await withServer(jsonHandler(200, manyBody(answer)), async (baseUrl) => {
      try {
        await createLayaDecisionProvider({ baseUrl }).decide(request100);
        ok = true;
      } catch (e) {
        message = (e as Error).message;
      }
    });
    return { ok, message };
  }

  {
    // THE reported failure mode: 100 options, every probability 0. The old
    // tolerance was 1.0, and |0 - 1| is not > 1.0, so this passed.
    const allZero = { type: 'choice', choice: 'o0', probabilities: Object.fromEntries(k100.map((c) => [c, 0])), answer_confidence: 0 };
    const r = await decide100(allZero);
    check('100 choices, all probabilities 0, is rejected', !r.ok, r.ok ? 'accepted' : '');
    check('  ...because the sum is not 1', r.message.includes('summing to'), r.message.slice(0, 190));
  }
  {
    // A valid 100-way distribution, hand-built: 1/100 each. Must be ACCEPTED, so
    // the tighter tolerance is proven not to over-reject.
    const uniform = {
      type: 'choice',
      choice: 'o0',
      probabilities: Object.fromEntries(k100.map((c) => [c, 0.01])),
      answer_confidence: 0.01,
    };
    const r = await decide100(uniform);
    check('100 choices with a valid uniform distribution is accepted', r.ok, r.message.slice(0, 190));
  }
  {
    // A real 4dp rounding artefact across 100 terms: one option at 0.0101 and
    // ninety-nine at 0.01 sums to 1.0001; sumTolerance(100) is 5e-3.
    const nearOne = {
      type: 'choice',
      choice: 'o0',
      probabilities: Object.fromEntries(k100.map((c, i) => [c, i === 0 ? 0.0101 : 0.01])),
      answer_confidence: 0.0101,
    };
    const r = await decide100(nearOne);
    check('100 choices with sum 1.0001 (rounding drift) is accepted', r.ok, r.message.slice(0, 190));
  }
  {
    // Confidence 0.98 away from the true maximum. Under the old k^2 tolerance
    // (1.0) this was accepted.
    const uniform = {
      type: 'choice',
      choice: 'o0',
      probabilities: Object.fromEntries(k100.map((c) => [c, 0.01])),
      answer_confidence: 0.99,
    };
    const r = await decide100(uniform);
    check('100 choices, confidence 0.99 against a max of 0.01, is rejected', !r.ok, r.ok ? 'accepted' : '');
    check('  ...as a confidence contradiction', r.message.includes('self-contradictory'), r.message.slice(0, 190));
  }
  {
    // And the small deviation the confidence check must still tolerate, with a
    // 100-way distribution: confidenceTolerance() is 1e-4 and does not grow.
    const uniform = {
      type: 'choice',
      choice: 'o0',
      probabilities: Object.fromEntries(k100.map((c) => [c, 0.01])),
      answer_confidence: 0.0101,
    };
    const r = await decide100(uniform);
    check('100 choices tolerates a 1e-4 confidence overshoot', r.ok, r.message.slice(0, 190));
  }
  {
    // A 100-way distribution that sums to 0.5 must be rejected: the sum bound at
    // k=100 is 5e-3, so 0.5 is a hundred times outside it.
    const half = {
      type: 'choice',
      choice: 'o0',
      probabilities: Object.fromEntries(k100.map((c) => [c, 0.005])),
      answer_confidence: 0.005,
    };
    const r = await decide100(half);
    check('100 choices summing to 0.5 is rejected', !r.ok, r.ok ? 'accepted' : '');
  }

  // ---- 32-level score ----
  const k32 = 32;
  const levels32 = Array.from({ length: k32 }, (_, i) => `L${i}`);
  const request32: DecisionRequest = {
    questions: { big: { type: 'score', instructions: 'How big?', criteria: levels32 } },
    task: 't',
  };
  async function decide32(answer: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    let ok = false;
    let message = '';
    await withServer(jsonHandler(200, manyBody(answer)), async (baseUrl) => {
      try {
        await createLayaDecisionProvider({ baseUrl }).decide(request32);
        ok = true;
      } catch (e) {
        message = (e as Error).message;
      }
    });
    return { ok, message };
  }
  /** Hand-built so nothing is re-derived: score is written out explicitly. */
  const score32 = (probs: Record<string, number>, score: number): Record<string, unknown> => ({
    type: 'score',
    score,
    legend: Object.fromEntries(levels32.map((c, i) => [String(i), c])),
    probabilities: probs,
    answer_confidence: Math.max(...Object.values(probs)),
  });
  // a genuine 32-way distribution: half the mass on 0 and half on 31
  const real32 = Object.fromEntries(levels32.map((_l, i) => [String(i), i === 0 || i === 31 ? 0.5 : 0]));
  const exp32 = levels32.reduce((acc, _l, i) => acc + i * real32[String(i)], 0); // 0*0.5 + 31*0.5 = 15.5

  {
    const r = await decide32(score32(real32, exp32));
    check('32-level score, exact expectation, is accepted', r.ok, r.message.slice(0, 190));
  }
  {
    // expectationTolerance(32) = 5e-5 * (1 + 32*31/2) = 5e-5 * 497 = 0.02485
    const r = await decide32(score32(real32, Math.round((exp32 + 0.02) * 1e4) / 1e4));
    check('32-level score, expectation off by 0.02, is accepted (inside 0.02485)', r.ok, r.message.slice(0, 190));
  }
  {
    const r = await decide32(score32(real32, Math.round((exp32 + 0.5) * 1e4) / 1e4));
    check('32-level score, expectation off by 0.5, is rejected', !r.ok, r.ok ? 'accepted' : '');
    check('  ...as an expectation contradiction', r.message.includes('self-contradictory'), r.message.slice(0, 190));
  }
  {
    // sumTolerance(32) = 1.6e-3, so a 1e-3 drift is inside it. The score is
    // re-derived by hand to stay consistent with the drifted distribution:
    // 0.501 on level 0, 0.499 on level 31 -> 31*0.499 = 15.469.
    const drift: Record<string, number> = { ...real32, '0': 0.501, '31': 0.499 };
    const driftExp = levels32.reduce((acc, _l, i) => acc + i * drift[String(i)], 0);
    const r = await decide32(score32(drift, Math.round(driftExp * 1e4) / 1e4));
    check('32-level score, sum off by 1e-3, is accepted (inside 1.6e-3)', r.ok, r.message.slice(0, 190));
  }
  {
    const bad = { ...real32, '0': 0.55 }; // sums to 1.05
    const r = await decide32(score32(bad, exp32));
    check('32-level score, sum off by 0.05, is rejected', !r.ok, r.ok ? 'accepted' : '');
    check('  ...as a normalisation failure', r.message.includes('summing to'), r.message.slice(0, 190));
  }
  {
    // confidenceTolerance() does not grow with k, so it is the same 1e-4 here.
    const p32 = Object.fromEntries(levels32.map((_l, i) => [String(i), i === 0 ? 0.07 : 0.03])); // 0.07 + 31*0.03 = 1.00
    const p32Exp = levels32.reduce((acc, _l, i) => acc + i * p32[String(i)], 0);
    const r = await decide32({ ...score32(p32, Math.round(p32Exp * 1e4) / 1e4), answer_confidence: 0.5 });
    check('32-level score, confidence 0.5 against a max of 0.07, is rejected', !r.ok, r.ok ? 'accepted' : '');
    check('  ...as a confidence contradiction', r.message.includes('self-contradictory'), r.message.slice(0, 190));
  }
  {
    // A high level index pushes the expectation, which is exactly why its
    // tolerance is the one that has to grow: 31 * 0.5.
    const r = await decide32(score32(real32, 15.5));
    check('32-level score, a high-index expectation, is accepted', r.ok, r.message.slice(0, 190));
  }
}

/** noul + true/false criteria: accepted when valid, refused when not. */
async function testNoulCriteria(): Promise<void> {
  const answer = { type: 'noul', noul: 0.0035, answer_confidence: 0.9965 };
  const body = (noul: Record<string, unknown>): unknown => ({
    model: 'laya-rl-agent',
    answers: { q: noul },
    routing: { model: 'english', reason: 'English Latin text' },
  });

  const legal: Array<[string, Record<string, string> | undefined]> = [
    ['criteria omitted entirely', undefined],
    ['an empty criteria object', {}],
    ['true only', { true: 'the statement holds' }],
    ['false only', { false: 'the statement does not hold' }],
    ['both keys', { true: 'yes', false: 'no' }],
    ['uppercase keys, as the provider normalises them', { True: 'yes', False: 'no' }],
  ];
  for (const [name, criteria] of legal) {
    await withServer(jsonHandler(200, body(answer)), async (baseUrl) => {
      const question =
        criteria === undefined
          ? { type: 'noul' as const, instructions: 'Does it hold?' }
          : { type: 'noul' as const, instructions: 'Does it hold?', criteria };
      const r = await createLayaDecisionProvider({ baseUrl }).decide({
        questions: { q: question },
        task: 'does it hold?',
      });
      eq(`noul with ${name} is answered`, r.answers.q?.type === 'noul' ? r.answers.q.noul : null, 0.0035);
    });
  }

  // The answer semantics are unchanged: no distribution is required, and the
  // confidence is still checked against max(noul, 1 - noul).
  const illegal: Array<[string, unknown, string]> = [
    ['a key other than true/false', { yes: 'y', no: 'n' }, 'only keys are "true" and "false"'],
    ['an extra key beside true/false', { true: 'y', false: 'n', maybe: 'x' }, 'only keys are "true" and "false"'],
    ['criteria as an array', ['true'], 'expected an object keyed'],
    ['criteria as a string', 'true', 'expected an object keyed'],
    ['a null description', { true: null }, 'expected a non-empty description string'],
    ['a numeric description', { true: 5 }, 'expected a non-empty description string'],
    ['an empty description', { true: '' }, 'expected a non-empty description string'],
  ];
  for (const [name, criteria, fragment] of illegal) {
    // Detected server-side: if the request is refused locally, no request is made.
    let reachedServer = false;
    let msg = '';
    await withServer(
      (_req, res) => {
        reachedServer = true;
        jsonHandler(200, body(answer))(_req, res);
      },
      async (baseUrl) => {
        try {
          await createLayaDecisionProvider({ baseUrl }).decide({
            questions: { q: { type: 'noul', instructions: '?', criteria } as never },
            task: 't',
          });
        } catch (e) {
          msg = (e as Error).message;
        }
      },
    );
    check(`noul refuses ${name}`, !reachedServer && msg.includes(fragment), reachedServer ? 'the request was sent' : msg.slice(0, 180));
  }
}

/**
 * round(score) sits on a .5 boundary for some distributions, and the index it
 * selects determines the reported level. Both sides of the boundary are pinned:
 * a legal half-way expectation must resolve deterministically, and a level that
 * disagrees with the expectation must be refused.
 */
async function testScoreRoundingBoundary(): Promise<void> {
  const id = COMPLEXITY_ID;
  const levels = LEVELS;
  // goodAnswers() FIRST, then the override, so the answer under test is the one
  // that survives the spread.
  const body = (complexity: Record<string, unknown>): unknown => ({
    model: 'laya-rl-agent',
    answers: { ...goodAnswers(), [id]: complexity },
    routing: { model: 'english', reason: 'English Latin text' },
  });
  const request: DecisionRequest = { questions: { [id]: { type: 'score', instructions: 'How complex?', criteria: levels } }, task: 't' };

  async function run(complexity: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    let ok = false;
    let message = '';
    await withServer(jsonHandler(200, body(complexity)), async (baseUrl) => {
      try {
        await createLayaDecisionProvider({ baseUrl }).decide(request);
        ok = true;
      } catch (e) {
        message = (e as Error).message;
      }
    });
    return { ok, message };
  }

  // expectation exactly 1.5 -> Math.round gives index 2
  const half = { '0': 0.25, '1': 0.5, '2': 0.25, '3': 0.0, '4': 0.0 };
  {
    const r = await run(consistentScore(half, levels));
    check('an expectation of exactly 1.5 is accepted', r.ok, r.message.slice(0, 190));
  }
  {
    // The same distribution, but the provider claims a different level. The
    // expectation of {0.25, 0.5, 0.25, 0, 0} is 1.5, so 2.0 contradicts it.
    const r = await run({ ...consistentScore(half, levels), score: 2 });
    check('the same distribution with a score of 2.0 is rejected', !r.ok, r.ok ? 'accepted' : '');
  }
  {
    // 1.5 reported but the distribution says 2.0.
    const flat2 = { '0': 0.2, '1': 0.2, '2': 0.2, '3': 0.2, '4': 0.2 };
    const r = await run({ ...consistentScore(flat2, levels), score: 1.5 });
    check('a score of 1.5 against an expectation of 2.0 is rejected', !r.ok, r.ok ? 'accepted' : '');
  }
  {
    // The boundary is real, not a rounding accident: {0, 0, 0.5, 0.5, 0} has an
    // expectation of exactly 2.5, which rounds to index 3.
    const half2 = { '0': 0.0, '1': 0.0, '2': 0.5, '3': 0.5, '4': 0.0 };
    let level: string | null = null;
    await withServer(jsonHandler(200, body(consistentScore(half2, levels))), async (baseUrl) => {
      const r = await createLayaDecisionProvider({ baseUrl }).decide(request);
      level = r.answers[id]?.type === 'score' ? r.answers[id].level : null;
    });
    eq('an expectation of exactly 2.5 resolves to the level above the boundary', level, 'large');
  }
  {
    // 4dp rounding may push the reported score either side of the .5 mark, and
    // that must not be treated as a contradiction.
    const just = { '0': 0.0, '1': 0.0, '2': 0.49995, '3': 0.49995, '4': 0.0001 };
    const r = await run(consistentScore(just, levels));
    check('an expectation that rounds to the .5 boundary is accepted', r.ok, r.message.slice(0, 190));
  }
}

let sentQuestions: Record<string, DecisionQuestion> = {};

// ---- helpers --------------------------------------------------------------

function testHelpers(): void {
  eq('toProbability accepts 0', toProbability(0), 0);
  eq('toProbability accepts 1', toProbability(1), 1);
  eq('toProbability rejects 1.0001', toProbability(1.0001), null);
  eq('toProbability rejects NaN', toProbability(NaN), null);
  eq('toProbability rejects Infinity', toProbability(Infinity), null);
  eq('toProbability rejects undefined', toProbability(undefined), null);
  eq('toProbability rejects a numeric string', toProbability('0.5'), null);
  eq('toProbability rejects null', toProbability(null), null);
}

// ---- live integration (opt-in, not part of this suite) --------------------

/**
 * A Chinese task, exercised through the generic layer. This is the case where
 * laya-serve routes to the `multilingual` checkpoint instead of `english`, so it
 * is asserted here against the stub rather than being left to a live run.
 */
async function testChineseInput(): Promise<void> {
  await withServer(
    jsonHandler(
      200,
      {
        model: 'laya-rl-agent',
        answers: {
          // The real values, not a rounded approximation: 0.9989 + 3*0.0004 = 1.0001,
          // which is inside the sum bound. A hand-rounded 0.998/0.001 triple sums
          // to 1.001 and is correctly refused.
          work_kind: consistentChoice('implementation', {
            implementation: 0.9989,
            review: 0.0004,
            research: 0.0004,
            debugging: 0.0004,
          }),
          complexity: consistentScore(
            { '0': 0.0286, '1': 0.3935, '2': 0.5052, '3': 0.0652, '4': 0.0075 },
            LEVELS,
          ),
          review_required: { type: 'noul', noul: 0.0035, answer_confidence: 0.9965 },
        },
        routing: {
          model: 'multilingual',
          reason: 'non-Latin script (han, 55% of letters); the English checkpoint cannot read it',
          detection: { script: 'han', language: null },
        },
      },
    ),
    async (baseUrl) => {
      const task = '请重构 src/core/event-hub.ts，让它支持多个订阅者，并同步更新单元测试。';
      const p = createLayaDecisionProvider({ baseUrl });
      const r = await p.decide({ questions: routingQuestions(), task });
      eq('a Chinese task is answered', r.answers[WORK_KIND_ID]?.type === 'choice' ? r.answers[WORK_KIND_ID].choice : null, 'implementation');
      const zhMeta = layaMetadata(r);
      eq('the multilingual checkpoint is recorded', zhMeta.checkpoint, 'multilingual');
      eq('the han script is recorded', zhMeta.script, 'han');
      check('the routing reason explains the checkpoint choice', zhMeta.reason.includes('non-Latin'), zhMeta.reason);

      const c = toTaskClassification(r);
      eq('classification agrees with the answer', c.work_kind, 'implementation');
      // Recorded here because it is the caveat that constrains how review_required
      // may be used: the same task in English gave noul 0.678, in Chinese 0.0035.
      eq('a Chinese refactor is not flagged for review here', c.review_required, false);
    },
  );

  // the request must carry UTF-8 intact
  await withServer(
    (req, res) => {
      const raw = (req as IncomingMessage & { rawBody: string }).rawBody;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(goodBody()));
      sentBytes = raw;
    },
    async (baseUrl) => {
      const task = '编排器的测试在 Windows 上失败了。';
      await createLayaDecisionProvider({ baseUrl }).decide({ questions: routingQuestions(), task });
      check(
        'a Chinese task is sent as UTF-8 without corruption',
        Buffer.from(sentBytes, 'utf8').toString('utf8').includes(task),
        sentBytes.slice(0, 120),
      );
    },
  );
}

let sentBytes = '';

/**
 * LAYA-COMPAT.1 -- the official `action` metadata on 0.3.21 answers.
 *
 * Laya 0.3.21 (the installed wheel and tag v0.3.21, commit 6ab71fb4) attaches an
 * optional `action: {"act_probability": n}` object to the choice, score AND noul
 * answers. Before this fix every real 0.3.21 response was rejected, because
 * `readChoiceParameters` read `action` as an extra task parameter and refused the
 * object. These cases are the regression.
 *
 * The body in `capturedBody()` is the REAL captured 0.3.21 response for the
 * synthetic Chinese task, embedded here so the test is self-contained rather than
 * depending on the ignored evidence file.
 */
async function testActionMetadataCompat(): Promise<void> {
  function capturedBody(): unknown {
    return {
      model: 'laya-rl-agent',
      answers: {
        work_kind: {
          type: 'choice',
          choice: 'implementation',
          probabilities: { implementation: 0.8087, review: 0.0074, research: 0.0873, debugging: 0.0966 },
          confidence: 0.5335,
          answer_confidence: 0.8087,
          action: { act_probability: 1 },
        },
        complexity: {
          type: 'score',
          score: 1.8442,
          legend: { '0': 'trivial', '1': 'small', '2': 'moderate', '3': 'large', '4': 'very large' },
          probabilities: { '0': 0.0166, '1': 0.3112, '2': 0.5131, '3': 0.1294, '4': 0.0296 },
          confidence: 0.2901,
          answer_confidence: 0.5131,
          action: { act_probability: 1 },
        },
        review_required: {
          type: 'noul',
          noul: 0.0045,
          confidence: 0.9955,
          answer_confidence: 0.9955,
          action: { act_probability: 1 },
        },
      },
      usage: { input_tokens: 188, output_tokens: 0 },
      routing: {
        model: 'multilingual',
        repo: 'convaiinnovations/laya/multilingual',
        reason: 'non-Latin script (han, 100% of letters); the English checkpoint cannot read it',
        detection: { script: 'han', language: null },
      },
    };
  }
  const CAPTURED_TASK = '为一个全新的演示项目编写整数加法函数和单元测试。';

  // 1. The full captured response is accepted and classified, and the action
  //    metadata stays metadata: kept in `raw`, absent from `parameters`.
  await withServer(jsonHandler(200, capturedBody()), async (baseUrl) => {
    const provider = createLayaDecisionProvider({ baseUrl });
    const r = await provider.decide(routingRequest({ task: CAPTURED_TASK }));
    const kind = r.answers[WORK_KIND_ID];
    if (kind?.type === 'choice') {
      eq('captured 0.3.21 work_kind choice is validated', kind.choice, 'implementation');
      eq('captured 0.3.21 choice has no parameters (action is not a parameter)', kind.parameters === undefined, true);
      check(
        'captured 0.3.21 choice parameters never carry action',
        !('action' in (kind.parameters ?? {})),
        JSON.stringify(kind.parameters),
      );
    } else {
      check('captured 0.3.21 work_kind is a choice', false, kind?.type);
    }
    const complexity = r.answers[COMPLEXITY_ID];
    if (complexity?.type === 'score') {
      eq('captured 0.3.21 score is preserved', complexity.score, 1.8442);
      eq('captured 0.3.21 level from rounded score', complexity.level, 'moderate');
    } else {
      check('captured 0.3.21 complexity is a score', false, complexity?.type);
    }
    const review = r.answers[REVIEW_ID];
    eq('captured 0.3.21 noul is preserved', review?.type === 'noul' ? review.noul : null, 0.0045);

    const rawAnswers = (r.raw as { answers: Record<string, { action?: { act_probability?: number } }> }).answers;
    eq('raw retains the work_kind action metadata', rawAnswers.work_kind.action?.act_probability, 1);
    eq('raw retains the complexity action metadata', rawAnswers.complexity.action?.act_probability, 1);
    eq('raw retains the noul action metadata', rawAnswers.review_required.action?.act_probability, 1);

    const c = await classifyTask(provider, { task: CAPTURED_TASK });
    eq('captured 0.3.21 classification work_kind', c.work_kind, 'implementation');
    eq('captured 0.3.21 classification complexity', c.complexity, 'moderate');
    eq('captured 0.3.21 classification score', c.complexity_score, 1.8442);
    eq('captured 0.3.21 classification review_required', c.review_required, false);
  });

  // 2. action metadata alongside real string task parameters: the parameters
  //    survive, and the metadata neither becomes a parameter nor overrides the choice.
  await withServer(
    jsonHandler(
      200,
      goodBody(
        goodAnswers({
          work_kind: {
            type: 'choice',
            choice: 'implementation',
            probabilities: { implementation: 0.8087, review: 0.0074, research: 0.0873, debugging: 0.0966 },
            answer_confidence: 0.8087,
            action: { act_probability: 1 },
            taskId: 't1',
            agentId: 'opencode',
          },
        }),
      ),
    ),
    async (baseUrl) => {
      const r = await createLayaDecisionProvider({ baseUrl }).decide(ROUTING);
      const kind = r.answers[WORK_KIND_ID];
      if (kind?.type === 'choice') {
        eq('action does not override the chosen option', kind.choice, 'implementation');
        eq('string task parameters are preserved beside action metadata', kind.parameters, { taskId: 't1', agentId: 'opencode' });
        check('action is not folded into parameters', kind.parameters !== undefined && !('action' in kind.parameters), JSON.stringify(kind.parameters));
      } else {
        check('action+parameters answer is a choice', false, kind?.type);
      }
    },
  );

  // 2b. A response with no action at all behaves exactly as before.
  await withServer(
    jsonHandler(
      200,
      goodBody(goodAnswers({ work_kind: consistentChoice('implementation', { implementation: 0.8087, review: 0.0074, research: 0.0873, debugging: 0.0966 }) })),
    ),
    async (baseUrl) => {
      const r = await createLayaDecisionProvider({ baseUrl }).decide(ROUTING);
      eq('a no-action response still validates', r.answers[WORK_KIND_ID]?.type === 'choice' ? r.answers[WORK_KIND_ID].choice : null, 'implementation');
    },
  );

  async function decideOverride(id: string, answer: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    let ok = false;
    let message = '';
    await withServer(jsonHandler(200, goodBody(goodAnswers({ [id]: answer }))), async (baseUrl) => {
      try {
        await createLayaDecisionProvider({ baseUrl }).decide(ROUTING);
        ok = true;
      } catch (e) {
        message = (e as Error).message;
      }
    });
    return { ok, message };
  }

  function choiceWithAction(action: unknown): Record<string, unknown> {
    return {
      type: 'choice',
      choice: 'implementation',
      probabilities: { implementation: 0.8087, review: 0.0074, research: 0.0873, debugging: 0.0966 },
      answer_confidence: 0.8087,
      action,
    };
  }

  // 3. Malformed action metadata is refused as a schema failure.
  const malformed: Array<[string, unknown, string]> = [
    ['null', null, 'expected an object'],
    ['an array', [1], 'expected an object'],
    ['a string', 'act', 'expected an object'],
    ['missing act_probability', {}, 'expected a probability'],
    ['act_probability null', { act_probability: null }, 'expected a probability'],
    ['act_probability a numeric string', { act_probability: '1' }, 'expected a probability'],
    ['act_probability above 1', { act_probability: 1.4 }, 'expected a probability'],
  ];
  for (const [name, action, fragment] of malformed) {
    const r = await decideOverride(WORK_KIND_ID, choiceWithAction(action));
    check(`rejects choice action metadata: ${name}`, !r.ok && r.message.includes(fragment), r.ok ? 'accepted' : r.message.slice(0, 190));
  }

  // 3b. Out-of-range act_probability rejects on every answer kind.
  const scoreWithAction = (action: unknown): Record<string, unknown> => ({
    ...consistentScore({ '0': 0.0166, '1': 0.3112, '2': 0.5131, '3': 0.1294, '4': 0.0296 }, LEVELS),
    action,
  });
  const noulWithAction = (action: unknown): Record<string, unknown> => ({ type: 'noul', noul: 0.0045, answer_confidence: 0.9955, action });
  const rangeCases: Array<[string, string, Record<string, unknown>]> = [
    ['choice', WORK_KIND_ID, choiceWithAction({ act_probability: -0.1 })],
    ['score', COMPLEXITY_ID, scoreWithAction({ act_probability: 1.4 })],
    ['noul', REVIEW_ID, noulWithAction({ act_probability: 2 })],
  ];
  for (const [kind, id, answer] of rangeCases) {
    const r = await decideOverride(id, answer);
    check(`rejects out-of-range act_probability on a ${kind} answer`, !r.ok && r.message.includes('expected a probability'), r.ok ? 'accepted' : r.message.slice(0, 190));
  }

  // 3c. A non-finite act_probability cannot be expressed in JSON, so it is
  //     injected through the provider's own fetch seam rather than pretending
  //     NaN survives JSON.stringify.
  for (const [name, value] of [['NaN', NaN], ['Infinity', Infinity]] as Array<[string, number]>) {
    const injected = goodBody(goodAnswers({ [WORK_KIND_ID]: choiceWithAction({ act_probability: value }) }));
    const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => injected, text: async () => '' })) as unknown as typeof fetch;
    let ok = false;
    let message = '';
    try {
      await createLayaDecisionProvider({ baseUrl: 'http://127.0.0.1:8077', fetchImpl }).decide(ROUTING);
      ok = true;
    } catch (e) {
      message = (e as Error).message;
    }
    check(`rejects non-finite act_probability: ${name}`, !ok && message.includes('expected a probability'), ok ? 'accepted' : message.slice(0, 190));
  }

  // 4. The action allowance did NOT open the door to arbitrary non-string task
  //    parameters: an object or a number beside the answer still rejects, with or
  //    without action metadata present.
  const nonStringParams: Array<[string, string, unknown]> = [
    ['a number taskId', 'taskId', 7],
    ['an object note', 'note', { nested: true }],
    ['a numeric sibling beside action metadata', 'taskId', 7],
  ];
  for (const [name, key, value] of nonStringParams) {
    const withAction = name.includes('beside action');
    const answer: Record<string, unknown> = {
      type: 'choice',
      choice: 'implementation',
      probabilities: { implementation: 0.8087, review: 0.0074, research: 0.0873, debugging: 0.0966 },
      answer_confidence: 0.8087,
      ...(withAction ? { action: { act_probability: 1 } } : {}),
      [key]: value,
    };
    const r = await decideOverride(WORK_KIND_ID, answer);
    check(`still rejects non-string task parameter: ${name}`, !r.ok && r.message.includes('parameters must be strings'), r.ok ? 'accepted' : r.message.slice(0, 190));
  }
}

async function main(): Promise<void> {
  await testGenericLayer();
  await testRequestValidation();
  await testResponseValidation();
  await testScoreConsistency();
  await testAnswerConfidenceConsistency();
  await testScoreRoundingBoundary();
  await testHighKBoundaries();
  await testNoulCriteria();
  await testActionMetadataCompat();
  await testProviderOptionHardening();
  await testTransport();
  await testRoutingPreset();
  await testChineseInput();
  testHelpers();
}

process.stdout.write('\ndecision layer contract\n');
await main();
process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
process.stdout.write('\n');
process.exitCode = failed === 0 ? 0 : 1;
