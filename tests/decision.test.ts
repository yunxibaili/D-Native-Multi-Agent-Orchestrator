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

/** A well-formed laya-serve answer, matching the shape observed locally. */
function goodAnswers(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    work_kind: {
      type: 'choice',
      choice: 'implementation',
      probabilities: { implementation: 0.667, review: 0.158, research: 0.047, debugging: 0.129 },
      confidence: 0.302,
      answer_confidence: 0.667,
      action: { act_probability: 1 },
    },
    complexity: {
      type: 'score',
      score: 1.7292,
      legend: { '0': 'trivial', '1': 'small', '2': 'moderate', '3': 'large', '4': 'very large' },
      probabilities: { '0': 0.04, '1': 0.36, '2': 0.46, '3': 0.1, '4': 0.04 },
      confidence: 0.361,
      answer_confidence: 0.505,
    },
    review_required: { type: 'noul', noul: 0.678, confidence: 0.996, answer_confidence: 0.678 },
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
      eq('confidence', kind.confidence, 0.667);
      eq('criteria echoed back', Object.keys(kind.criteria).join(), WORK_KINDS.join());
      eq('probabilities cover the offered choices', Object.keys(kind.probabilities).join(), WORK_KINDS.join());
    }
    const complexity = r.answers[COMPLEXITY_ID];
    if (complexity?.type === 'score') {
      // score is continuous, so the level comes from rounding it: 1.7292 -> 2.
      eq('level from rounded score', complexity.level, 'moderate');
      eq('raw score preserved', complexity.score, 1.7292);
      eq('levels echoed back', complexity.levels.join(), COMPLEXITY_LEVELS.join());
      eq('score distribution covers every level', Object.keys(complexity.probabilities).join(), '0,1,2,3,4');
    } else {
      check('score answer is typed', false, complexity?.type);
    }
    const review = r.answers[REVIEW_ID];
    eq('noul value', review?.type === 'noul' ? review.noul : null, 0.678);

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
        tone: { type: 'choice', choice: 'urgent', probabilities: { urgent: 0.8, normal: 0.2 }, answer_confidence: 0.8 },
        severity: { type: 'score', score: 3, legend: { '0': 'low', '1': 'mid', '2': 'high', '3': 'critical' }, probabilities: { '0': 0.05, '1': 0.05, '2': 0.1, '3': 0.8 }, answer_confidence: 0.8 },
        needsHuman: { type: 'noul', noul: 0.2, probabilities: {}, answer_confidence: 0.8 },
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
    // noul has no answer space, and laya-serve rejects noul+criteria with 422, so
    // any `criteria` on a noul is refused locally rather than sent.
    [
      'noul with criteria (server rejects this with 422)',
      { questions: { n: { type: 'noul', instructions: '?', criteria: { true: 'yes', false: 'no' } as unknown as undefined } }, task: 't' },
      'has no answer space, but it carries "criteria"',
    ],
    [
      'noul criteria as an array',
      { questions: { n: { type: 'noul', instructions: '?', criteria: ['a'] as unknown as Record<string, string> } }, task: 't' },
      'has no answer space, but it carries "criteria"',
    ],
    [
      'noul with an empty criteria object',
      { questions: { n: { type: 'noul', instructions: '?', criteria: {} as unknown as undefined } }, task: 't' },
      'has no answer space, but it carries "criteria"',
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
        complexity: {
          type: 'score',
          score: 'high',
          legend: { '0': 'trivial', '1': 'small', '2': 'moderate', '3': 'large', '4': 'very large' },
          probabilities: { '0': 0.04, '1': 0.36, '2': 0.46, '3': 0.1, '4': 0.04 },
          answer_confidence: 0.5,
        },
      }),
      'expected a finite number',
    ],
    [
      'score legend disagrees with the offered levels',
      goodAnswers({
        complexity: {
          type: 'score',
          score: 2,
          legend: { '0': 'a', '1': 'b', '2': 'c' },
          probabilities: { '0': 0.04, '1': 0.36, '2': 0.46, '3': 0.1, '4': 0.04 },
          answer_confidence: 0.5,
        },
      }),
      'outside the levels this request offered',
    ],
    [
      'score legend missing',
      goodAnswers({
        complexity: {
          type: 'score',
          score: 2,
          probabilities: { '0': 0.04, '1': 0.36, '2': 0.46, '3': 0.1, '4': 0.04 },
          answer_confidence: 0.5,
        },
      }),
      'missing its "legend"',
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

  // The complement: a consistent answer, including an exact tie, must still pass.
  const consistent: Array<[string, Record<string, unknown>, string]> = [
    [
      'the plain argmax case',
      goodAnswers({
        work_kind: {
          type: 'choice',
          choice: 'implementation',
          probabilities: { implementation: 0.667, review: 0.158, research: 0.047, debugging: 0.129 },
          answer_confidence: 0.667,
        },
      }),
      'implementation',
    ],
    [
      'an exact tie is a legitimate argmax for either side',
      goodAnswers({
        work_kind: {
          type: 'choice',
          choice: 'research',
          probabilities: { implementation: 0.5, review: 0.5, research: 0.5, debugging: 0.5 },
          answer_confidence: 0.5,
        },
      }),
      'research',
    ],
    [
      'a tie between only the top two, with a lower third option',
      goodAnswers({
        work_kind: {
          type: 'choice',
          choice: 'review',
          probabilities: { implementation: 0.4, review: 0.4, research: 0.1, debugging: 0.1 },
          answer_confidence: 0.4,
        },
      }),
      'review',
    ],
  ];
  for (const [name, answers, expectedChoice] of consistent) {
    await withServer(jsonHandler(200, goodBody(answers)), async (baseUrl) => {
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
  // level comes from the provider's legend, not a hardcoded index
  await withServer(
    jsonHandler(
      200,
      goodBody(
        goodAnswers({
          complexity: {
            type: 'score',
            score: 2,
            // reversed legend: index 2 is "trivial" now. A hardcoded level order
            // would not notice this.
            legend: { '0': 'very large', '1': 'large', '2': 'trivial', '3': 'small', '4': 'moderate' },
            probabilities: { '0': 0.04, '1': 0.36, '2': 0.46, '3': 0.1, '4': 0.04 },
            answer_confidence: 0.5,
          },
        }),
      ),
    ),
    async (baseUrl) => {
      const c = await classifyTask(createLayaDecisionProvider({ baseUrl }), { task: 't' });
      eq('level is read from the legend entry for the score', c.complexity, 'trivial');
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
      jsonHandler(200, goodBody(goodAnswers({ review_required: { type: 'noul', noul, answer_confidence: noul } }))),
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
          work_kind: {
            type: 'choice',
            choice: 'implementation',
            probabilities: { implementation: 0.998, review: 0.001, research: 0.001, debugging: 0.001 },
            answer_confidence: 0.998,
          },
          complexity: {
            type: 'score',
            score: 1.6295,
            legend: { '0': 'trivial', '1': 'small', '2': 'moderate', '3': 'large', '4': 'very large' },
            probabilities: { '0': 0.0286, '1': 0.3935, '2': 0.5052, '3': 0.0652, '4': 0.0075 },
            answer_confidence: 0.5052,
          },
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

async function main(): Promise<void> {
  await testGenericLayer();
  await testRequestValidation();
  await testResponseValidation();
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
