/**
 * tests/laya-post-budget.test.ts -- MVP-E2E.1a: the per-ROUND cumulative hard POST
 * budget (`--laya-post-max`), and the WIRE-level guarantee that one reservation is one
 * transmission.
 *
 * Offline and hermetic. Everything below drives the PRODUCTION
 * `createLayaDecisionProvider`; the only stands-in are the transport (an injected
 * `fetchImpl` for the budget-semantics cases, and a real loopback `node:http` server
 * for the wire cases) and a trivial `choice` question that is valid by construction.
 *
 * The wire cases are the point of the round:
 *   - Node's built-in fetch (Undici) auto-retries HTTP 421 when `request.body.source`
 *     is non-null (a string / typed-array body). A budgeted request uses a ONE-SHOT
 *     `ReadableStream` body (`body.source === null`) plus `redirect: 'error'`, so three
 *     421 answers produce THREE received POSTs, not six, and a 307/308 does not spawn a
 *     POST at the redirect target.
 *
 * Run: node tests/laya-post-budget.test.ts
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createLayaDecisionProvider, createLayaPostBudget, readLayaPostBudgetReport } from '../src/decision/laya.ts';
import {
  DecisionError,
  DecisionSchemaError,
  DecisionTimeoutError,
  DecisionTransportError,
  DecisionUnavailableError,
} from '../src/decision/errors.ts';
import { TASK_FIELD, type DecisionProvider, type DecisionRequest } from '../src/decision/types.ts';
import { runRoundCli } from '../src/cli/round-cli.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; process.stdout.write(`  ok   ${name}\n`); }
  else { failed++; failures.push(name); process.stdout.write(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}\n`); }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, `got ${a}, want ${b}`);
}
function section(t: string): void { process.stdout.write(`\n== ${t} ==\n`); }

// ---- fixtures -------------------------------------------------------------

/** A minimal, valid choice question: two options, described. */
const QUESTIONS = {
  pick: {
    type: 'choice' as const,
    instructions: 'pick exactly one',
    criteria: { alpha: 'the first option', beta: 'the second option' },
  },
};
const REQUEST: DecisionRequest = { questions: QUESTIONS, task: 'choose one' };

function goodBody(choice = 'alpha'): unknown {
  const probabilities: Record<string, number> = {};
  for (const key of Object.keys(QUESTIONS.pick.criteria)) probabilities[key] = key === choice ? 1 : 0;
  return {
    model: 'laya-fixture',
    answers: {
      pick: { type: 'choice', choice, probabilities, confidence: 1, answer_confidence: 1, action: { act_probability: 1 } },
    },
    routing: { model: 'english', reason: 'controlled fixture', detection: { script: 'latin', language: 'en' }, revisions: {} },
    usage: { input_tokens: 12, output_tokens: 0 },
  };
}

function isBudgetError(e: unknown): boolean {
  return e instanceof DecisionError && e.code === 'DECISION_POST_BUDGET_EXHAUSTED';
}

async function expectError(name: string, fn: () => Promise<unknown>, type: new (...a: never[]) => Error): Promise<void> {
  try {
    await fn();
    check(name, false, 'no error thrown');
  } catch (e) {
    check(name, e instanceof type, `got ${(e as Error).name}: ${String((e as Error).message).slice(0, 120)}`);
  }
}

async function expectBudgetRefusal(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    check(name, false, 'no error thrown');
  } catch (e) {
    check(name, isBudgetError(e), `got ${(e as Error).name}/${String((e as { code?: string }).code)}: ${(e as Error).message.slice(0, 120)}`);
  }
}

interface FetchRecord { method: string; url: string; body: unknown; redirect?: string; duplex?: string }
interface ControlledFetch {
  readonly impl: typeof fetch;
  readonly records: FetchRecord[];
  posts: () => number;
  gets: () => number;
}

/**
 * A controlled fetch BELOW the real provider. It records method/body/options and
 * answers `/health` and the decision endpoint deterministically. Any thrown error is
 * thrown AFTER the record is taken, exactly as a real transport failure would be.
 */
function makeControlledFetch(opts: {
  status?: number;
  body?: unknown;
  rawBody?: string;
  delayMs?: number;
  throwErr?: Error;
} = {}): ControlledFetch {
  const records: FetchRecord[] = [];
  const impl = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const method = String(init?.method ?? 'GET');
    records.push({
      method,
      url: String(input),
      body: init?.body,
      redirect: init?.redirect,
      duplex: (init as { duplex?: string } | undefined)?.duplex,
    });
    if (opts.delayMs !== undefined) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts.throwErr !== undefined) throw opts.throwErr;
    if (method === 'GET') {
      return new Response(JSON.stringify({ status: 'ok', device: 'cpu', loaded: ['english'], cpu_fallbacks: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const text = opts.rawBody ?? JSON.stringify(opts.body ?? goodBody());
    return new Response(text, { status: opts.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return {
    impl,
    records,
    posts: () => records.filter((r) => r.method === 'POST').length,
    gets: () => records.filter((r) => r.method === 'GET').length,
  };
}

async function bodyText(body: unknown): Promise<string> {
  if (typeof body === 'string') return body;
  if (body instanceof ReadableStream) return await new Response(body).text();
  return String(body);
}

/** Runs `fn`, swallowing stdout/stderr, so an expected USAGE/refusal dump stays quiet. */
async function silently<T>(fn: () => Promise<T>): Promise<T> {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const swallow = ((): boolean => true) as typeof process.stdout.write;
  process.stdout.write = swallow;
  process.stderr.write = swallow;
  try {
    return await fn();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

const BASE = 'http://127.0.0.1:8077';

// ---- real loopback servers (wire cases) -----------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const openServers: Server[] = [];
const cleanupFailures: string[] = [];

async function listen(handler: Handler): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => handler(req, res));
  });
  openServers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((r) => server.close(() => r()));
  const i = openServers.indexOf(server);
  if (i >= 0) openServers.splice(i, 1);
}

async function main(): Promise<void> {
  section('budget: the first three POSTs succeed, the fourth is refused before the wire');

  {
    const f = makeControlledFetch();
    const budget = createLayaPostBudget(3);
    const p = createLayaDecisionProvider({ baseUrl: BASE, fetchImpl: f.impl, postBudget: budget });
    for (let i = 0; i < 3; i++) {
      const r = await p.decide(REQUEST);
      check(`send ${i + 1}: a valid answer is returned`, r.answers.pick?.type === 'choice', JSON.stringify(r.answers.pick));
    }
    eq('three POSTs reached the controlled fetch', f.posts(), 3);
    const snap = readLayaPostBudgetReport(budget);
    eq('after three: reserved is 3', snap.reserved, 3);
    eq('after three: used is 3', snap.used, 3);
    eq('after three: remaining is 0', snap.remaining, 0);
    eq('after three: exhausted', snap.exhausted, true);
    eq('after three: no rejection yet', snap.rejected, false);
    await expectBudgetRefusal('the fourth call is refused with the budget code', () => p.decide(REQUEST));
    eq('the refused fourth never reached the fetch', f.posts(), 3);
    eq('after refusal: rejected is true', readLayaPostBudgetReport(budget).rejected, true);
    eq('after refusal: reserved stays 3', readLayaPostBudgetReport(budget).reserved, 3);

    // NEGATIVE CONTROL: with NO budget the SAME fourth POST is not vacuous - it really
    // reaches the transport. This proves the "three and no more" assertion above is the
    // reservation doing the work, not an accident of the fixture.
    const f2 = makeControlledFetch();
    const unbudgeted = createLayaDecisionProvider({ baseUrl: BASE, fetchImpl: f2.impl });
    for (let i = 0; i < 4; i++) await unbudgeted.decide(REQUEST);
    eq('negative control: an unbudgeted provider sends a fourth POST', f2.posts(), 4);
  }

  section('budget: HTTP errors are counted, and the fourth is still refused');

  {
    const f = makeControlledFetch({ status: 500, rawBody: 'server exploded' });
    const budget = createLayaPostBudget(3);
    const p = createLayaDecisionProvider({ baseUrl: BASE, fetchImpl: f.impl, postBudget: budget });
    for (let i = 0; i < 3; i++) {
      await expectError(`HTTP 500 #${i + 1}: the transport error is reported`, () => p.decide(REQUEST), DecisionTransportError);
    }
    eq('three failing POSTs reached the fetch', f.posts(), 3);
    await expectBudgetRefusal('the fourth after three HTTP errors is refused', () => p.decide(REQUEST));
    eq('the refused fourth never reached the fetch', f.posts(), 3);
    eq('an HTTP error does not refund the reservation', readLayaPostBudgetReport(budget).reserved, 3);
  }

  section('budget: timeouts are counted and not refunded');

  {
    const f = makeControlledFetch({ throwErr: Object.assign(new Error('the operation was aborted due to timeout'), { name: 'TimeoutError' }) });
    const budget = createLayaPostBudget(3);
    const p = createLayaDecisionProvider({ baseUrl: BASE, fetchImpl: f.impl, postBudget: budget });
    for (let i = 0; i < 3; i++) {
      await expectError(`timeout #${i + 1}: the timeout error is reported`, () => p.decide(REQUEST), DecisionTimeoutError);
    }
    eq('three timed-out POSTs reached the fetch', f.posts(), 3);
    await expectBudgetRefusal('the fourth after three timeouts is refused', () => p.decide(REQUEST));
    eq('the refused fourth never reached the fetch', f.posts(), 3);
    eq('a timeout does not refund the reservation', readLayaPostBudgetReport(budget).reserved, 3);
  }

  section('budget: an abort, a connection failure and illegal JSON all consume the reservation');

  {
    const cases: Array<{ label: string; make: () => ControlledFetch; type: new (...a: never[]) => Error }> = [
      { label: 'abort', make: () => makeControlledFetch({ throwErr: Object.assign(new Error('aborted'), { name: 'AbortError' }) }), type: DecisionTimeoutError },
      { label: 'connection failure', make: () => makeControlledFetch({ throwErr: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }) }), type: DecisionUnavailableError },
      { label: 'illegal JSON', make: () => makeControlledFetch({ rawBody: 'this is not json at all' }), type: DecisionSchemaError },
    ];
    for (const c of cases) {
      const f = c.make();
      const budget = createLayaPostBudget(1);
      const p = createLayaDecisionProvider({ baseUrl: BASE, fetchImpl: f.impl, postBudget: budget });
      await expectError(`${c.label}: the request fails as expected`, () => p.decide(REQUEST), c.type);
      eq(`${c.label}: the reservation is consumed (reserved 1)`, readLayaPostBudgetReport(budget).reserved, 1);
      eq(`${c.label}: the transmission was attempted (used 1)`, readLayaPostBudgetReport(budget).used, 1);
      await expectBudgetRefusal(`${c.label}: the next POST is refused`, () => p.decide(REQUEST));
      eq(`${c.label}: no second POST reached the fetch`, f.posts(), 1);
    }
  }

  section('budget: ten concurrent calls admit exactly three (no await between compare and increment)');

  {
    const f = makeControlledFetch({ delayMs: 40 });
    const budget = createLayaPostBudget(3);
    const p = createLayaDecisionProvider({ baseUrl: BASE, fetchImpl: f.impl, postBudget: budget });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => p.decide(REQUEST)));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const refused = results.filter((r) => r.status === 'rejected' && isBudgetError(r.reason)).length;
    eq('exactly three concurrent calls succeed', ok, 3);
    eq('the other seven are refused with the budget code', refused, 7);
    eq('the fetch saw exactly three POSTs', f.posts(), 3);
    eq('reserved is 3', readLayaPostBudgetReport(budget).reserved, 3);
  }

  section('budget: /health GETs are separate and never counted, even at max 0');

  {
    const f = makeControlledFetch();
    const budget = createLayaPostBudget(0);
    const p = createLayaDecisionProvider({ baseUrl: BASE, fetchImpl: f.impl, postBudget: budget });
    const probe = await p.probe();
    check('the health probe still works at max 0', probe.ok === true, JSON.stringify(probe));
    eq('the probe issued zero POSTs', f.posts(), 0);
    eq('the probe issued exactly one GET', f.gets(), 1);
    eq('the probe left the budget untouched', readLayaPostBudgetReport(budget).reserved, 0);
    await expectBudgetRefusal('at max 0 every decision POST is refused', () => p.decide(REQUEST));
    eq('still zero POSTs after the refusal', f.posts(), 0);

    const f2 = makeControlledFetch();
    const budget2 = createLayaPostBudget(2);
    const p2 = createLayaDecisionProvider({ baseUrl: BASE, fetchImpl: f2.impl, postBudget: budget2 });
    await p2.probe();
    eq('a positive-budget probe also does not consume the budget', readLayaPostBudgetReport(budget2).reserved, 0);
  }

  section('budget: providers sharing ONE object share the cap; a new object starts fresh');

  {
    const f = makeControlledFetch();
    const shared = createLayaPostBudget(3);
    const a = createLayaDecisionProvider({ baseUrl: BASE, fetchImpl: f.impl, postBudget: shared });
    const b = createLayaDecisionProvider({ baseUrl: BASE, fetchImpl: f.impl, postBudget: shared });
    await a.decide(REQUEST);
    await b.decide(REQUEST);
    await a.decide(REQUEST);
    eq('two providers shared three reservations', readLayaPostBudgetReport(shared).reserved, 3);
    await expectBudgetRefusal('the shared budget is exhausted for B', () => b.decide(REQUEST));
    await expectBudgetRefusal('and for A too', () => a.decide(REQUEST));
    eq('only three POSTs reached the fetch', f.posts(), 3);

    const freshFetch = makeControlledFetch();
    const freshBudget = createLayaPostBudget(3);
    const c = createLayaDecisionProvider({ baseUrl: BASE, fetchImpl: freshFetch.impl, postBudget: freshBudget });
    const r = await c.decide(REQUEST);
    check(
      'a NEW budget object starts fresh and allows a POST',
      r.answers.pick?.type === 'choice' && readLayaPostBudgetReport(freshBudget).reserved === 1,
      JSON.stringify(readLayaPostBudgetReport(freshBudget)),
    );
  }

  section('budget: max 0 forbids EVERY POST (it is not "unlimited")');

  {
    const f = makeControlledFetch();
    const budget = createLayaPostBudget(0);
    const p = createLayaDecisionProvider({ baseUrl: BASE, fetchImpl: f.impl, postBudget: budget });
    await expectBudgetRefusal('the very first POST is refused', () => p.decide(REQUEST));
    eq('zero POSTs reached the fetch', f.posts(), 0);
    const snap = readLayaPostBudgetReport(budget);
    eq('exhausted at max 0', snap.exhausted, true);
    eq('rejected at max 0', snap.rejected, true);
    eq('remaining at max 0', snap.remaining, 0);
  }

  section('CLI: an invalid --laya-post-max is a usage refusal (exit 2) with no provider call');

  {
    const bad: Array<{ args: string[]; label: string }> = [
      { args: ['--laya-post-max'], label: 'missing value (bare flag)' },
      { args: ['--laya-post-max', '-1'], label: 'negative' },
      { args: ['--laya-post-max', '1.5'], label: 'fraction' },
      { args: ['--laya-post-max', 'NaN'], label: 'NaN' },
      { args: ['--laya-post-max', 'Infinity'], label: 'Infinity' },
      { args: ['--laya-post-max', '3x'], label: 'partial junk' },
      { args: ['--laya-post-max', ''], label: 'empty value' },
      { args: ['--laya-post-max', 'true'], label: 'boolean value' },
      { args: ['--laya-post-max=true'], label: 'boolean =true' },
      { args: ['--laya-post-max', '9007199254740993'], label: 'unsafe integer' },
    ];
    for (const c of bad) {
      let fetchCalls = 0;
      const fetchImpl = (async () => { fetchCalls += 1; throw new Error('the provider must not be reached'); }) as unknown as typeof fetch;
      const exit = await silently(() => runRoundCli({} as never, ['do a thing', '--json', ...c.args], { layaFetchImpl: fetchImpl }));
      check(`invalid (${c.label}): exit 2`, exit === 2, `exit=${exit}`);
      eq(`invalid (${c.label}): no provider/transport call`, fetchCalls, 0);
    }

    for (const badMax of [-1, 1.5, 90.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      let threw = false;
      try { createLayaPostBudget(badMax); } catch { threw = true; }
      check(`the factory refuses max ${String(badMax)}`, threw, 'no error thrown');
    }
    let okThrew = false;
    try { createLayaPostBudget(0); createLayaPostBudget(3); } catch { okThrew = true; }
    check('the factory accepts 0 and 3', !okThrew, 'threw for a valid max');
  }

  section('CLI: an explicit budget on an INJECTED provider is refused, never silently unenforced');

  {
    let calls = 0;
    const fakeProvider = {
      name: 'fake',
      probe: async () => ({ ok: true, endpoint: '', detail: '', warnings: [] }),
      decide: async () => { calls += 1; throw new Error('must not be called'); },
    } as unknown as DecisionProvider;
    const exit = await silently(() => runRoundCli({} as never, ['do a thing', '--json', '--laya-post-max', '3'], { provider: fakeProvider }));
    check('the provider-override + budget combination is refused with exit 2', exit === 2, `exit=${exit}`);
    eq('the injected provider was never called', calls, 0);
  }

  section('compatibility: with no budget the request is byte-for-byte the old one');

  {
    const f = makeControlledFetch();
    const p = createLayaDecisionProvider({ baseUrl: BASE, fetchImpl: f.impl });
    await p.decide(REQUEST);
    const rec = f.records.find((r) => r.method === 'POST');
    check('unbudgeted body is still a STRING (replayable, unchanged)', typeof rec?.body === 'string', typeof rec?.body);
    check('unbudgeted request sets no redirect option', rec?.redirect === undefined, String(rec?.redirect));
    const parsed = JSON.parse(await bodyText(rec?.body)) as { state: Record<string, string>; questions: unknown };
    eq('unbudgeted payload carries the task state', parsed.state[TASK_FIELD], 'choose one');
    eq('unbudgeted payload carries the questions', JSON.stringify(parsed.questions), JSON.stringify(QUESTIONS));

    const fb = makeControlledFetch();
    const pb = createLayaDecisionProvider({ baseUrl: BASE, fetchImpl: fb.impl, postBudget: createLayaPostBudget(1) });
    await pb.decide(REQUEST);
    const recb = fb.records.find((r) => r.method === 'POST');
    check('budgeted body is a ReadableStream (one-shot, not replayable)', recb?.body instanceof ReadableStream, typeof recb?.body);
    eq('budgeted request refuses redirects', recb?.redirect, 'error');
    eq('budgeted request is half-duplex', recb?.duplex, 'half');
    const parsedB = JSON.parse(await bodyText(recb?.body)) as { state: Record<string, string>; questions: unknown };
    eq('budgeted payload carries the SAME JSON state bytes', parsedB.state[TASK_FIELD], 'choose one');
    eq('budgeted payload carries the SAME questions', JSON.stringify(parsedB.questions), JSON.stringify(QUESTIONS));
  }

  section('wire: a budgeted request cannot be replayed by HTTP 421');

  {
    let received = 0;
    const { server, baseUrl } = await listen((_req, res) => {
      received += 1;
      res.writeHead(421, { 'content-type': 'application/json' });
      res.end('{"error":"misdirected"}');
    });
    try {
      const budget = createLayaPostBudget(3);
      const p = createLayaDecisionProvider({ baseUrl, timeoutMs: 5000, postBudget: budget });
      for (let i = 0; i < 3; i++) {
        await expectError(`421 #${i + 1}: the non-2xx is reported`, () => p.decide(REQUEST), DecisionTransportError);
      }
      eq('THREE 421 answers produced exactly THREE received POSTs (not six)', received, 3);
      await expectBudgetRefusal('the fourth is refused before the wire', () => p.decide(REQUEST));
      eq('the refused fourth is not received', received, 3);

      // CONTROL: an UNBUDGETED string body IS replayed by the built-in 421 retry, which
      // is exactly the hazard the stream body removes.
      const before = received;
      const unbudgeted = createLayaDecisionProvider({ baseUrl, timeoutMs: 5000 });
      await expectError('unbudgeted 421 still surfaces as a transport error', () => unbudgeted.decide(REQUEST), DecisionTransportError);
      check('control: the unbudgeted string body IS replayed by the built-in 421 retry', received - before >= 2, `received=${received - before}`);
    } finally {
      await close(server);
    }
  }

  section('wire: a budgeted request refuses 307/308 and never reaches the redirect target');

  {
    let targetReceived = 0;
    const target = await listen((_req, res) => {
      targetReceived += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(goodBody()));
    });
    const targetPort = (target.server.address() as AddressInfo).port;
    try {
      for (const code of [307, 308] as const) {
        let sourceReceived = 0;
        const { server, baseUrl } = await listen((_req, res) => {
          sourceReceived += 1;
          res.writeHead(code, { location: `http://127.0.0.1:${targetPort}/v1/systemone` });
          res.end('');
        });
        try {
          const budget = createLayaPostBudget(3);
          const p = createLayaDecisionProvider({ baseUrl, timeoutMs: 5000, postBudget: budget });
          await expectError(`${code}: the redirect is refused, not followed`, () => p.decide(REQUEST), DecisionUnavailableError);
          eq(`${code}: the source saw exactly one POST`, sourceReceived, 1);
          eq(`${code}: the redirect target saw ZERO POSTs`, targetReceived, 0);
          eq(`${code}: the reservation is consumed`, readLayaPostBudgetReport(budget).reserved, 1);
        } finally {
          await close(server);
        }
      }
    } finally {
      await close(target.server);
    }
  }

  section('wire: a connection reset is reported and consumes the reservation, with no replay');

  {
    const connections = { n: 0 };
    const { server, baseUrl } = await listen((req) => { connections.n += 1; req.socket.destroy(); });
    try {
      const budget = createLayaPostBudget(2);
      const p = createLayaDecisionProvider({ baseUrl, timeoutMs: 5000, postBudget: budget });
      await expectError('reset: the failure is reported', () => p.decide(REQUEST), DecisionUnavailableError);
      eq('reset: the reservation is consumed', readLayaPostBudgetReport(budget).reserved, 1);
      eq('reset: the server saw the request once (no replay)', connections.n, 1);
      await expectError('reset: a second failure is reported', () => p.decide(REQUEST), DecisionUnavailableError);
      eq('reset: the second reservation is consumed', readLayaPostBudgetReport(budget).reserved, 2);
      eq('reset: still no replay', connections.n, 2);
      await expectBudgetRefusal('reset: the third is refused', () => p.decide(REQUEST));
    } finally {
      await close(server);
    }
  }
}

let fatal: unknown;
try {
  await main();
} catch (e) {
  fatal = e;
  process.stdout.write(`fatal: ${String((e as Error).message)}\n`);
}

// Every server must be closed. A leftover LISTENING server fails the suite.
for (const server of [...openServers]) {
  try {
    if (!server.listening) { const i = openServers.indexOf(server); if (i >= 0) openServers.splice(i, 1); continue; }
    await close(server);
  } catch (e) {
    cleanupFailures.push(`server close threw: ${(e as Error).message}`);
  }
}
if (openServers.length > 0) cleanupFailures.push(`${openServers.length} server(s) were still tracked after cleanup`);

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
if (cleanupFailures.length) process.stdout.write(`cleanup failures (must fail the test):\n  ${cleanupFailures.map((f) => `- ${f}`).join('\n  ')}\n`);
if (fatal !== undefined) process.stdout.write(`fatal (must fail the test): ${String((fatal as Error).message)}\n`);
process.stdout.write('\n');
process.exitCode = failed === 0 && cleanupFailures.length === 0 && fatal === undefined ? 0 : 1;
