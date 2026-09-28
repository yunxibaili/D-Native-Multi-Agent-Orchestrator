/**
 * tests/decision.test.ts -- the DecisionProvider contract.
 *
 * Offline and hermetic: a stub node:http server stands in for laya-serve, so the
 * suite needs no Python, no CUDA, no checkpoints, and no network. It also
 * reproduces, as fixtures, the responses laya-serve really returns for inputs
 * that are wrong -- including the 200-with-no-answer cases that make naive
 * "check the status code" validation silently route work to the wrong agent.
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
import { WORK_KINDS, toProbability } from '../src/decision/types.ts';

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

type Handler = (body: IncomingMessage, res: ServerResponse) => void;

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
    const okType = e instanceof type;
    const okMsg = okType && (e as Error).message.length > 20 && !(e as Error).message.includes('undefined\n');
    check(name, okType && !!okMsg, `got ${(e as Error).name}: ${String((e as Error).message).slice(0, 120)}`);
  }
}

async function main(): Promise<void> {
  // ---- the happy path --------------------------------------------------
  await withServer(jsonHandler(200, goodBody()), async (baseUrl) => {
    const p = createLayaDecisionProvider({ baseUrl });
    const d = await p.decide({ task: 'refactor the event hub and update tests' });

    check('name is laya', p.name === 'laya');
    eq('work_kind read from choice', d.work_kind, 'implementation');
    eq('work_kind confidence', d.work_kind_confidence, 0.667);
    // score is a continuous 0..4 estimate, so the level comes from rounding it
    // and then reading the provider's own legend: 1.7292 -> index 2.
    eq('complexity read via rounded score + legend', d.complexity, 'moderate');
    eq('complexity score preserved', d.complexity_score, 1.7292);
    check('review_required true above 0.5 noul', d.review_required === true);
    eq('review noul preserved', d.review_noul, 0.678);
    eq('checkpoint recorded', d.provenance.checkpoint, 'english');
    eq('routing reason recorded', d.provenance.reason, 'English Latin text');
    eq('script recorded', d.provenance.script, 'latin');
    check('elapsed measured', d.provenance.elapsedMs >= 0 && d.provenance.elapsedMs < 60_000);
    check('raw envelope retained for audit', d.raw.model === 'laya-rl-agent');
    check(
      'probabilities cover the full vocabulary',
      WORK_KINDS.every((k) => typeof d.work_kind_probabilities[k] === 'number'),
      JSON.stringify(d.work_kind_probabilities),
    );
  });

  // ---- review threshold is a real boundary ----------------------------
  await withServer(
    jsonHandler(200, goodBody(goodAnswers({ review_required: { type: 'noul', noul: 0.498, answer_confidence: 0.502 } }))),
    async (baseUrl) => {
      const d = await createLayaDecisionProvider({ baseUrl }).decide({ task: 't' });
      check('review_required false below 0.5 noul', d.review_required === false);
    },
  );

  // ---- the request we send must match the documented question set ------
  await withServer(
    (req, res) => {
      const sent = JSON.parse((req as IncomingMessage & { rawBody: string }).rawBody);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(goodBody()));
      lastRequest = sent;
    },
    async (baseUrl) => {
      await createLayaDecisionProvider({ baseUrl }).decide({ task: 'do the thing', context: { repo: 'orchestrator' } });
      const q = lastRequest.questions as Record<string, { type: string; criteria: unknown }>;
      check('state carries the task', lastRequest.state.task === 'do the thing');
      check('state carries context', lastRequest.state.repo === 'orchestrator');
      eq('three questions asked', Object.keys(q).length, 3);
      check('choice criteria pinned to the vocabulary', Object.keys(q.work_kind.criteria as object).join() === WORK_KINDS.join());
      check('score levels pinned to the vocabulary', (q.complexity.criteria as string[]).length === 5);
    },
  );

  // ---- the level comes from the provider's legend, not a hardcoded index --
  await withServer(
    jsonHandler(
      200,
      goodBody(
        goodAnswers({
          // Same score, reversed legend: index 2 is now "very large". If the
          // provider were reading a hardcoded level order this would not change.
          complexity: {
            type: 'score',
            score: 2,
            legend: { '0': 'very large', '1': 'large', '2': 'moderate', '3': 'small', '4': 'trivial' },
            answer_confidence: 0.5,
          },
        }),
      ),
    ),
    async (baseUrl) => {
      const d = await createLayaDecisionProvider({ baseUrl }).decide({ task: 't' });
      eq('level is taken from the legend entry for the score', d.complexity, 'moderate');
    },
  );

  // ---- server down: refuse, never default ------------------------------
  await expectError(
    'server unreachable throws DecisionUnavailableError',
    () => createLayaDecisionProvider({ baseUrl: 'http://127.0.0.1:1' }).decide({ task: 't' }),
    DecisionUnavailableError,
  );

  // ---- 200 with NO answers must not read as a decision ----------------
  const silentNoop: Array<[string, unknown]> = [
    ['empty answers object', { model: 'laya-rl-agent', answers: {} }],
    ['missing answers key', { model: 'laya-rl-agent' }],
    ['answers is a string', { model: 'laya-rl-agent', answers: 'none' }],
    ['missing model', { answers: goodAnswers() }],
    ['body is an array', [1, 2, 3]],
    ['body is a bare string', 'ok'],
  ];
  for (const [name, body] of silentNoop) {
    await withServer(jsonHandler(200, body), async (baseUrl) => {
      await expectError(
        `200 with ${name} throws DecisionSchemaError`,
        () => createLayaDecisionProvider({ baseUrl }).decide({ task: 't' }),
        DecisionSchemaError,
      );
    });
  }

  // ---- 200 with a partial answer set -----------------------------------
  const partials: Array<[string, Record<string, unknown>]> = [
    ['only work_kind', { work_kind: goodAnswers().work_kind }],
    ['only complexity', { complexity: goodAnswers().complexity }],
    ['no review_required', { work_kind: goodAnswers().work_kind, complexity: goodAnswers().complexity }],
  ];
  for (const [name, answers] of partials) {
    await withServer(jsonHandler(200, goodBody(answers)), async (baseUrl) => {
      await expectError(
        `200 with ${name} throws DecisionSchemaError`,
        () => createLayaDecisionProvider({ baseUrl }).decide({ task: 't' }),
        DecisionSchemaError,
      );
    });
  }

  // ---- values outside the closed vocabulary ----------------------------
  const outOfRange: Array<[string, Record<string, unknown>, string]> = [
    ['choice outside WORK_KINDS', goodAnswers({ work_kind: { type: 'choice', choice: 'vibes', answer_confidence: 0.9, probabilities: { implementation: 1, review: 0, research: 0, debugging: 0 } } }), 'outside the declared vocabulary'],
    ['choice missing', goodAnswers({ work_kind: { type: 'choice', answer_confidence: 0.9 } }), 'outside the declared vocabulary'],
    ['choice confidence null', goodAnswers({ work_kind: { type: 'choice', choice: 'review', answer_confidence: null, probabilities: { implementation: 0, review: 1, research: 0, debugging: 0 } } }), 'expected a probability'],
    ['choice confidence above 1', goodAnswers({ work_kind: { type: 'choice', choice: 'review', answer_confidence: 1.4, probabilities: { implementation: 0, review: 1, research: 0, debugging: 0 } } }), 'expected a probability'],
    ['choice probabilities missing a key', goodAnswers({ work_kind: { type: 'choice', choice: 'review', answer_confidence: 0.9, probabilities: { review: 1 } } }), 'expected a probability'],
    ['complexity score NaN-string', goodAnswers({ complexity: { type: 'score', score: 'high', legend: { '0': 'trivial' }, answer_confidence: 0.5 } }), 'not a finite number'],
    ['complexity legend disagrees with vocabulary', goodAnswers({ complexity: { type: 'score', score: 2, legend: { '0': 'a', '1': 'b', '2': 'c' }, answer_confidence: 0.5 } }), 'outside the declared vocabulary'],
    ['complexity legend missing', goodAnswers({ complexity: { type: 'score', score: 2, answer_confidence: 0.5 } }), 'legend'],
    ['noul out of range', goodAnswers({ review_required: { type: 'noul', noul: 1.2, answer_confidence: 1.2 } }), 'expected a probability'],
    ['noul NaN', goodAnswers({ review_required: { type: 'noul', noul: null, answer_confidence: 0.5 } }), 'expected a probability'],
  ];
  for (const [name, answers, fragment] of outOfRange) {
    await withServer(jsonHandler(200, goodBody(answers)), async (baseUrl) => {
      let msg = '';
      try {
        await createLayaDecisionProvider({ baseUrl }).decide({ task: 't' });
      } catch (e) {
        msg = (e as Error).message;
      }
      check(`rejects ${name}`, msg.includes(fragment), msg.slice(0, 160));
    });
  }

  // ---- transport-level failures ---------------------------------------
  await withServer(jsonHandler(413, { detail: 'state too large (50013 > 50000 chars)' }), async (baseUrl) => {
    await expectError(
      '4xx becomes DecisionTransportError carrying the provider detail',
      () => createLayaDecisionProvider({ baseUrl }).decide({ task: 't' }),
      DecisionTransportError,
    );
  });
  await withServer(jsonHandler(422, { detail: "unknown type 'vibe'" }), async (baseUrl) => {
    try {
      await createLayaDecisionProvider({ baseUrl }).decide({ task: 't' });
    } catch (e) {
      check('422 body is surfaced to the operator', (e as Error).message.includes('unknown type'), (e as Error).message);
    }
  });
  await withServer(jsonHandler(200, 'not json at all'), async (baseUrl) => {
    await expectError(
      'non-JSON 200 body throws DecisionSchemaError',
      () => createLayaDecisionProvider({ baseUrl }).decide({ task: 't' }),
      DecisionSchemaError,
    );
  });
  await withServer((_req, res) => setTimeout(() => res.end('{}'), 1_000), async (baseUrl) => {
    await expectError(
      'a slow provider becomes DecisionTimeoutError, not a default',
      () => createLayaDecisionProvider({ baseUrl, timeoutMs: 150 }).decide({ task: 't' }),
      DecisionTimeoutError,
    );
  });

  // ---- oversized state is refused before it is sent --------------------
  await withServer(
    (_req, res) => {
      check('oversized state is not sent to the provider', !sawOversizeRequest, 'a request reached the provider');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(goodBody()));
    },
    async (baseUrl) => {
      sawOversizeRequest = false;
      await expectError(
        'state over laya 50k limit throws DecisionInputError',
        () => createLayaDecisionProvider({ baseUrl }).decide({ task: 'a'.repeat(50_001) }),
        DecisionInputError,
      );
    },
  );

  // ---- probe -----------------------------------------------------------
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
      check('probe reports the device and checkpoints', probe.detail.includes('cuda') && probe.detail.includes('english'), probe.detail);
      check('probe surfaces a CPU fallback as a warning', probe.warnings.some((w) => w.includes('CUDA OOM')), probe.warnings.join(' | '));
    },
  );
  await withServer(jsonHandler(200, { status: 'ok', loaded: [], device: 'cpu' }), async (baseUrl) => {
    const probe = await createLayaDecisionProvider({ baseUrl }).probe();
    check('probe warns when no checkpoint is loaded', probe.warnings.some((w) => w.includes('no checkpoints')), probe.warnings.join(' | '));
  });
  {
    const probe = await createLayaDecisionProvider({ baseUrl: 'http://127.0.0.1:1' }).probe();
    check('probe reports unreachable without throwing', probe.ok === false, probe.detail);
  }

  // ---- probability narrowing ------------------------------------------
  eq('toProbability accepts 0', toProbability(0), 0);
  eq('toProbability accepts 1', toProbability(1), 1);
  eq('toProbability rejects 1.0001', toProbability(1.0001), null);
  eq('toProbability rejects NaN', toProbability(NaN), null);
  eq('toProbability rejects undefined', toProbability(undefined), null);
  eq('toProbability rejects a numeric string', toProbability('0.5'), null);
}

let lastRequest: any = {};
let sawOversizeRequest = false;

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, `got ${a}, want ${b}`);
}

process.stdout.write('\ndecision provider contract\n');
await main();
process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
process.stdout.write('\n');
process.exitCode = failed === 0 ? 0 : 1;
