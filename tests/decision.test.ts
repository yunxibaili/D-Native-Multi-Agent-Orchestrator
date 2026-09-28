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
  DecisionInputError,
  DecisionSchemaError,
  DecisionTimeoutError,
  DecisionTransportError,
  DecisionUnavailableError,
} from '../src/decision/errors.ts';
import { createLayaDecisionProvider } from '../src/decision/laya.ts';
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

    // provider metadata is retained for debugging
    eq('provider name', r.provider.name, 'laya');
    eq('provider model', r.provider.model, 'laya-rl-agent');
    eq('checkpoint recorded', r.provider.checkpoint, 'english');
    eq('routing reason recorded', r.provider.reason, 'English Latin text');
    eq('script recorded', r.provider.script, 'latin');
    check('elapsed measured', r.provider.elapsedMs >= 0 && r.provider.elapsedMs < 60_000, String(r.provider.elapsedMs));
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
      eq('checkpoint defaults when unreported fields are absent', r.provider.checkpoint, 'english');
      eq('script is null when unreported', r.provider.script, null);
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

  const badRequests: Array<[string, DecisionRequest, string]> = [
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
    [
      'noul criteria as an array',
      { questions: { n: { type: 'noul', instructions: '?', criteria: ['a'] as unknown as Record<string, string> } }, task: 't' },
      'expected an object',
    ],
    ['empty instructions', { questions: { c: { type: 'choice', instructions: '   ', criteria: { a: 'x', b: 'y' } } }, task: 't' }, 'empty "instructions"'],
    [
      'unknown question type',
      { questions: { c: { type: 'vibe', instructions: '?' } as unknown as DecisionQuestion }, task: 't' },
      'expected one of',
    ],
    ['nothing to read', { questions: routingQuestions() }, 'nothing to read'],
    ['task is not a string', { questions: routingQuestions(), task: 7 as unknown as string }, 'expected a string'],
  ];

  for (const [name, request, fragment] of badRequests) {
    reachedServer = false;
    await withServer(countingHandler, async (baseUrl) => {
      let msg = '';
      try {
        await createLayaDecisionProvider({ baseUrl }).decide(request);
      } catch (e) {
        if (!(e instanceof DecisionInputError)) {
          check(`refuses to send: ${name}`, false, `threw ${(e as Error).name}, wanted DecisionInputError`);
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

  // the type of an answer must match the type that was asked
  await withServer(
    jsonHandler(
      200,
      goodBody(
        goodAnswers({
          // a score answer where a choice was asked
          work_kind: { type: 'score', score: 1, legend: { '0': 'a', '1': 'b' }, probabilities: { '0': 0.5, '1': 0.5 }, answer_confidence: 0.5 },
        }),
      ),
    ),
    async (baseUrl) => {
      await expectError(
        'a score answer where a choice was asked is rejected',
        () => createLayaDecisionProvider({ baseUrl }).decide(ROUTING),
        DecisionSchemaError,
      );
    },
  );

  // non-JSON, despite a 200
  await withServer(jsonHandler(200, 'not json at all'), async (baseUrl) => {
    await expectError(
      'non-JSON 200 body throws DecisionSchemaError',
      () => createLayaDecisionProvider({ baseUrl }).decide(ROUTING),
      DecisionSchemaError,
    );
  });
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
    eq('classification carries the checkpoint', c.provider.checkpoint, 'english');
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
    provider: { name: 'x', model: 'm', checkpoint: 'c', reason: 'r', script: null, language: null, elapsedMs: 1 },
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
      eq('the multilingual checkpoint is recorded', r.provider.checkpoint, 'multilingual');
      eq('the han script is recorded', r.provider.script, 'han');
      check('the routing reason explains the checkpoint choice', r.provider.reason.includes('non-Latin'), r.provider.reason);

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
