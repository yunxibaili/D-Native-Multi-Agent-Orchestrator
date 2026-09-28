/**
 * tests/contract.test.ts --the contracts Codex review said were untested.
 *
 * Every test here is deterministic: no real agent, no network, no dependence on
 * what happens to be installed on the machine.
 *
 * Run: node tests/contract.test.ts
 */

import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventHub } from '../src/core/event-hub.ts';
import { TailBuffer, takeHeadBytes, takeTailBytes } from '../src/core/buffer.ts';
import {
  AdapterNotFoundError,
  ThreadNotFoundError,
  ThreadOwnershipError,
  UnsupportedOptionError,
} from '../src/core/errors.ts';
import { isTerminal, type LauncherSpec, type TaskState } from '../src/core/types.ts';
import type { RuntimeEvent } from '../src/core/event.ts';
import { assertCmdSafe, buildLaunchArgv, launcherFor } from '../src/runtime/launcher.ts';
import { resolveCommand, searchPath } from '../src/runtime/discover.ts';
import { emitCompleteLines } from '../src/runtime/spawn.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { ADAPTER_FACTORIES, createAdapter, knownAgentIds } from '../src/adapters/index.ts';
import { createOpenCodeAdapter } from '../src/adapters/opencode.ts';
import { createCodexAdapter } from '../src/adapters/codex.ts';
import { createFakeAdapter, FakeTransport, type ScriptStep } from './helpers.ts';

let passed = 0;
let failed = 0;
let skipped = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed++;
    failures.push(name);
    process.stdout.write(`  FAIL ${name}${detail ? ` --${detail}` : ''}\n`);
  }
}

/**
 * A skipped check is NOT a failure. Used for anything that depends on the
 * machine: `npm test` must not fail merely because OpenCode or Codex is not
 * installed here. Fixture-based logic is always asserted; only real-binary
 * availability is allowed to skip.
 */
function skip(name: string, why: string): void {
  skipped++;
  process.stdout.write(`  skip ${name} (${why})\n`);
}

function section(t: string): void {
  process.stdout.write(`\n${t}\n`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function tmpStore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch-contract-'));
  return dir;
}

/**
 * Real adapters, but with a STUB launcher so no test depends on a binary being
 * installed. argv construction and event mapping are pure functions of the
 * adapter, so this loses no coverage --and it means `npm test` passes on a
 * machine with neither OpenCode nor Codex.
 */
function ocAdapter() {
  return createOpenCodeAdapter({ launcher: stubLauncher('opencode') });
}
function cxAdapter() {
  return createCodexAdapter({ launcher: stubLauncher('codex') });
}
function stubLauncher(name: string): LauncherSpec {
  return {
    kind: 'native',
    command: `C:/fake/${name}.exe`,
    prefixArgs: [],
    target: `C:/fake/${name}.exe`,
    buildsCommandString: false,
  };
}

// =========================================================================
// 1. OUTCOME STATE MACHINE  (review critical 1 & 2)
// =========================================================================

section('1. outcome state machine');

async function outcomeTests(): Promise<void> {
  // "result() repeated must not fabricate success" --the original bug.
  const cases: ReadonlyArray<[string, ScriptStep[], TaskState]> = [
    ['success', [{ kind: 'frame', text: JSON.stringify({ text: 'ok' }) }, { kind: 'exit', code: 0 }], 'succeeded'],
    ['failure', [{ kind: 'exit', code: 3, stderrTail: 'boom' }], 'failed'],
    ['spawn failure', [{ kind: 'exit', code: 127, stderrTail: 'ENOENT' }], 'failed'],
  ];
  for (const [name, script, expected] of cases) {
    const dir = tmpStore();
    const adapter = createFakeAdapter({ id: `t-${name.replace(/\s/g, '-')}`, script });
    const orch = new Orchestrator({ config: { agents: {} }, storeDir: dir, extraAdapters: [adapter] });

    const h = orch.run({ agentId: adapter.descriptor.id, prompt: 'p', cwd: dir });
    const first = await h.result();

    check(`${name}: first result has the right state`, first.state === expected, `got ${first.state}`);

    // Repeat many times, sequentially and concurrently.
    const repeats = await Promise.all([h.result(), h.result(), h.result()]);
    const again = await h.result();
    check(
      `${name}: result() is stable across repeated calls`,
      repeats.every((r) => r.state === first.state) && again.state === first.state,
      `got ${[...repeats.map((r) => r.state), again.state].join(',')}`,
    );
    check(
      `${name}: result() returns the identical frozen object`,
      repeats[0] === first && repeats[1] === first && again === first,
    );

    if (first.state !== 'succeeded') {
      check(
        `${name}: non-success carries an error`,
        first.error !== null && typeof first.error.message === 'string' && first.error.message.length > 0,
        JSON.stringify(first.error),
      );
    }
    rmSync(dir, { recursive: true, force: true });
  }

  // cancelled, and repeated result must stay cancelled.
  {
    const dir = tmpStore();
    const adapter = createFakeAdapter({ id: 't-cancel', script: [{ kind: 'hang' }] });
    const orch = new Orchestrator({ config: { agents: {} }, storeDir: dir, extraAdapters: [adapter] });
    const h = orch.run({ agentId: 't-cancel', prompt: 'p', cwd: dir });
    await sleep(30);
    await h.cancel('operator asked');
    const r1 = await h.result();
    const r2 = await h.result();
    check('cancel: state is cancelled', r1.state === 'cancelled', r1.state);
    check('cancel: repeated result stays cancelled', r2.state === r1.state && r2 === r1);
    check('cancel: carries an error', r1.error?.code === 'CANCELLED', JSON.stringify(r1.error));
    rmSync(dir, { recursive: true, force: true });
  }

  // timed_out must NOT be reported as cancelled.
  {
    const dir = tmpStore();
    const adapter = createFakeAdapter({ id: 't-timeout', script: [{ kind: 'hang' }] });
    const orch = new Orchestrator({ config: { agents: {} }, storeDir: dir, extraAdapters: [adapter] });
    const h = orch.run({ agentId: 't-timeout', prompt: 'p', cwd: dir, timeoutMs: 80 });
    const t1 = await h.result();
    const t2 = await h.result();
    check('timeout: state is timed_out, not cancelled', t1.state === 'timed_out', t1.state);
    check('timeout: distinct from cancelled', t1.state !== 'cancelled');
    check('timeout: repeated result stays timed_out', t2.state === t1.state && t2 === t1);
    check('timeout: error code is TIMED_OUT', t1.error?.code === 'TIMED_OUT', JSON.stringify(t1.error));
    check('timeout: marked retryable', t1.error?.retryable === true);
    rmSync(dir, { recursive: true, force: true });
  }

  // result() called before completion must wait, not invent an answer.
  {
    const dir = tmpStore();
    const adapter = createFakeAdapter({
      id: 't-before',
      script: [{ kind: 'hang' }],
    });
    const orch = new Orchestrator({ config: { agents: {} }, storeDir: dir, extraAdapters: [adapter] });
    const h = orch.run({ agentId: 't-before', prompt: 'p', cwd: dir });

    let settled = false;
    const pending = h.result().then((r) => {
      settled = true;
      return r;
    });
    await sleep(120);
    check('result() before completion does not resolve early', settled === false);

    // A bounded result() must reject while the task is still running, and
    // must NOT change the task's outcome.
    let rejected = false;
    try {
      await h.result(50);
    } catch {
      rejected = true;
    }
    check('bounded result() rejects on its own timeout', rejected);
    check('bounded result() left the task running', h.state() === 'running', h.state());

    await h.cancel('done waiting');
    const final = await pending;
    check('the pending result() still resolves with the real outcome', final.state === 'cancelled', final.state);
    rmSync(dir, { recursive: true, force: true });
  }

  // result() after the process already exited.
  {
    const dir = tmpStore();
    const adapter = createFakeAdapter({
      id: 't-after',
      script: [{ kind: 'frame', text: JSON.stringify({ text: 'late' }) }, { kind: 'exit', code: 0 }],
    });
    const orch = new Orchestrator({ config: { agents: {} }, storeDir: dir, extraAdapters: [adapter] });
    const h = orch.run({ agentId: 't-after', prompt: 'p', cwd: dir });
    await sleep(80);
    const a = await h.result();
    check('result() after process exit returns the real outcome', a.state === 'succeeded', a.state);
    await sleep(50);
    const b = await h.result();
    check('result() long after exit is still identical', b === a);
    rmSync(dir, { recursive: true, force: true });
  }

  // Terminal states are terminal; running is not.
  check('isTerminal: running is not terminal', !isTerminal('running'));
  for (const s of ['succeeded', 'failed', 'cancelled', 'timed_out'] as TaskState[]) {
    check(`isTerminal: ${s} is terminal`, isTerminal(s));
  }
}

// =========================================================================
// 2. EVENT HUB  (review critical 3 & 4)
// =========================================================================

section('2. event hub (multi-subscriber)');

function mkEvent(i: number): RuntimeEvent {
  return {
    type: 'session.progress',
    taskId: 't',
    agentId: 'a',
    threadId: null,
    at: i,
    text: `e${i}`,
    data: { kind: 'native' },
    raw: { i },
  } as RuntimeEvent;
}

async function drain(sub: AsyncIterable<RuntimeEvent>, max = 1_000_000): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  for await (const e of sub) {
    out.push(e);
    if (out.length >= max) break;
  }
  return out;
}

async function hubTests(): Promise<void> {
  // A must not consume B's events.
  {
    const hub = new EventHub<RuntimeEvent>();
    const a = hub.subscribe();
    const b = hub.subscribe();
    for (let i = 0; i < 50; i++) hub.publish(mkEvent(i));
    hub.close();
    const [ra, rb] = await Promise.all([drain(a), drain(b)]);
    check('two subscribers each receive all 50 events', ra.length === 50 && rb.length === 50, `${ra.length}/${rb.length}`);
    check('subscribers see identical event streams', ra[0]?.text === rb[0]?.text && ra[49]?.text === rb[49]?.text);
  }

  // Late subscriber: explicit semantics.
  {
    const hub = new EventHub<RuntimeEvent>();
    for (let i = 0; i < 5; i++) hub.publish(mkEvent(i));
    const none = hub.subscribe();
    const replay = hub.subscribe({ replay: 'replay' });
    hub.publish(mkEvent(99));
    hub.close();
    const rn = await drain(none);
    const rr = await drain(replay);
    check('late subscriber (default) gets only post-subscription events', rn.length === 1 && rn[0]?.text === 'e99', `${rn.length}`);
    check('late subscriber (replay) gets retained events first', rr.length === 6 && rr[0]?.text === 'e0', `${rr.length}`);
  }

  // Post-close subscription terminates instead of hanging.
  {
    const hub = new EventHub<RuntimeEvent>();
    hub.publish(mkEvent(1));
    hub.close();
    const s = hub.subscribe();
    const got = await Promise.race([drain(s), sleep(500).then(() => 'TIMEOUT')]);
    check('subscribing after close terminates immediately', Array.isArray(got) && got.length === 0, String(got));
  }

  // Bounded buffer: a slow subscriber must not grow unbounded.
  {
    const hub = new EventHub<RuntimeEvent>({ defaultBuffer: 10, recentCapacity: 5 });
    const slow = hub.subscribe({ buffer: 10 });
    for (let i = 0; i < 10_000; i++) hub.publish(mkEvent(i));
    hub.close();
    const got = await drain(slow);
    check('10k events: slow subscriber buffer stays bounded', got.length <= 10, `${got.length}`);
    check('10k events: subscriber is told what it dropped', slow.droppedCount() > 0, `${slow.droppedCount()}`);
    check('10k events: hub saw all of them', hub.stats().published === 10_000, `${hub.stats().published}`);
  }

  // A slow subscriber must not block a fast one.
  {
    const hub = new EventHub<RuntimeEvent>({ defaultBuffer: 4 });
    const slow = hub.subscribe({ buffer: 4 }); // never drained
    const fast = hub.subscribe({ buffer: 10_000 });
    const fastPump = drain(fast);
    for (let i = 0; i < 500; i++) hub.publish(mkEvent(i));
    hub.close();
    const got = await fastPump;
    check('a never-drained subscriber does not starve a drained one', got.length === 500, `${got.length}`);
    check('the slow subscriber is accounted separately', slow.droppedCount() > 0);
  }

  // close() releases everything.
  {
    const hub = new EventHub<RuntimeEvent>();
    hub.subscribe();
    hub.subscribe();
    check('hub reports two subscribers', hub.stats().subscribers === 2);
    hub.close();
    check('close() drops all subscribers', hub.stats().subscribers === 0);
    check('close() clears the retained window', hub.stats().retained === 0);
    hub.publish(mkEvent(1));
    check('publishing after close is a no-op', hub.stats().published === 0);
    hub.close();
    check('close() is idempotent', hub.closed);
  }

  // Unsubscribe mid-stream.
  {
    const hub = new EventHub<RuntimeEvent>();
    const s = hub.subscribe();
    hub.publish(mkEvent(1));
    s.close();
    hub.publish(mkEvent(2));
    hub.close();
    const got = await drain(s);
    check('close() on a subscription stops delivery', got.length === 1, `${got.length}`);
  }

  // drop-newest keeps older events, drop-oldest keeps newer.
  {
    const h1 = new EventHub<RuntimeEvent>({ defaultBuffer: 3, overflow: 'drop-newest' });
    const s1 = h1.subscribe({ buffer: 3 });
    for (let i = 0; i < 6; i++) h1.publish(mkEvent(i));
    h1.close();
    const g1 = await drain(s1);
    check('drop-newest retains the oldest events', g1[0]?.text === 'e0', g1[0]?.text ?? '');

    const h2 = new EventHub<RuntimeEvent>({ defaultBuffer: 3, overflow: 'drop-oldest' });
    const s2 = h2.subscribe({ buffer: 3 });
    for (let i = 0; i < 6; i++) h2.publish(mkEvent(i));
    h2.close();
    const g2 = await drain(s2);
    check('drop-oldest retains the newest events', g2[g2.length - 1]?.text === 'e5', g2[g2.length - 1]?.text ?? '');
  }
}

// =========================================================================
// 3. MEMORY BOUNDS  (review critical 4, important 9)
// =========================================================================

section('3. memory bounds');

async function memoryTests(): Promise<void> {
  // TailBuffer byte ceiling, including a single oversized chunk.
  {
    const b = new TailBuffer({ limitBytes: 64 * 1024 });
    b.append('x'.repeat(200 * 1024));
    check('single 200KB chunk is clipped to the 64KB limit', b.byteLength <= 64 * 1024, `${b.byteLength}`);
    check('clipping is reported', b.truncated);

    const c = new TailBuffer({ limitBytes: 64 * 1024 });
    for (let i = 0; i < 40; i++) c.append('y'.repeat(10 * 1024));
    check('400KB accumulated is clipped to the limit', c.byteLength <= 64 * 1024, `${c.byteLength}`);

    const d = new TailBuffer({ limitBytes: 1024 });
    d.append('a'.repeat(1000));
    d.append('b'.repeat(1000));
    check('byte counter actually drops back (old bug)', d.byteLength <= 1024, `${d.byteLength}`);
    check('keeps the tail, not the head', d.toString().endsWith('b'), d.toString().slice(0, 4));

    const e = new TailBuffer({ limitBytes: 1024 });
    e.append('c'.repeat(1024));
    e.append('d'.repeat(1024));
    e.append('e'.repeat(1024));
    check('once over the limit, later appends still do not grow it', e.byteLength <= 1024, `${e.byteLength}`);
  }

  // 1MB chunk, and multi-byte safety.
  {
    const b = new TailBuffer({ limitBytes: 64 * 1024 });
    b.append('漢'.repeat(400_000)); // 3 bytes per code point
    check('1MB+ of multi-byte text is clipped to the byte limit', b.byteLength <= 64 * 1024, `${b.byteLength}`);
    check('clipping never splits a code point', !b.toString().includes('\uFFFD'));
  }
  {
    // Emoji are surrogate pairs; trimming must not halve one.
    const s = '\u{1F642}'.repeat(100);
    const t = takeTailBytes(s, 10);
    check('emoji tail trim does not split a surrogate pair', !t.includes('\uFFFD') && t.length % 2 === 0, JSON.stringify(t));
    const h = takeHeadBytes(s, 10);
    check('emoji head trim does not split a surrogate pair', !h.includes('\uFFFD') && h.length % 2 === 0, JSON.stringify(h));
  }

  // stdout and stderr are clipped independently.
  {
    const dir = tmpStore();
    const adapter = createFakeAdapter({
      id: 'm-stderr',
      script: [
        { kind: 'frame', text: JSON.stringify({ text: 'out' }) },
        { kind: 'frame', channel: 'stderr', text: 'E'.repeat(50 * 1024) },
        { kind: 'exit', code: 2, stderrTail: 'failed' },
      ],
    });
    const orch = new Orchestrator({
      config: { agents: {} },
      storeDir: dir,
      extraAdapters: [adapter],
      sessionLimits: { outputBytes: 1024, stderrBytes: 2048 },
    });
    const h = orch.run({ agentId: 'm-stderr', prompt: 'p', cwd: dir });
    const r = await h.result();
    check('output tail respects its own limit', Buffer.byteLength(r.output, 'utf8') <= 1024, `${Buffer.byteLength(r.output, 'utf8')}`);
    check('huge stderr does not blow up the result', r.error !== null && r.state === 'failed');
    rmSync(dir, { recursive: true, force: true });
  }

  // No consumer: memory must stay bounded through a 10k-event run.
  {
    const dir = tmpStore();
    const many: ScriptStep[] = [];
    for (let i = 0; i < 10_000; i++) many.push({ kind: 'frame', text: JSON.stringify({ text: `chunk-${i}` }) });
    many.push({ kind: 'exit', code: 0 });
    const adapter = createFakeAdapter({ id: 'm-10k', script: many });
    const orch = new Orchestrator({
      config: { agents: {} },
      storeDir: dir,
      extraAdapters: [adapter],
      sessionLimits: { outputBytes: 4096, eventBuffer: 32, recentEvents: 8 },
    });
    // Deliberately never subscribe.
    const h = orch.run({ agentId: 'm-10k', prompt: 'p', cwd: dir });
    const r = await h.result();
    check('10k events with no consumer still succeeds', r.state === 'succeeded', r.state);
    check('10k events: output tail stays bounded', Buffer.byteLength(r.output, 'utf8') <= 4096, `${Buffer.byteLength(r.output, 'utf8')}`);
    check('10k events: full transcript still written to disk', r.transcriptPath !== null);
    rmSync(dir, { recursive: true, force: true });
  }

  // Terminal cleanup: the orchestrator drops its live-session reference.
  {
    const dir = tmpStore();
    const adapter = createFakeAdapter({
      id: 'm-cleanup',
      script: [{ kind: 'frame', text: JSON.stringify({ text: 'x' }) }, { kind: 'exit', code: 0 }],
    });
    const orch = new Orchestrator({ config: { agents: {} }, storeDir: dir, extraAdapters: [adapter] });
    const h = orch.run({ agentId: 'm-cleanup', prompt: 'p', cwd: dir });
    check('session is tracked while running', orch.activeSessions().length === 1, `${orch.activeSessions().length}`);
    await h.result();
    await sleep(30);
    check('terminal releases the live-session entry', orch.activeSessions().length === 0, `${orch.activeSessions().length}`);
    check('persisted task survives the release', orch.getTask(h.taskId) !== null);
    rmSync(dir, { recursive: true, force: true });
  }
}

// =========================================================================
// 4. RESUME OWNERSHIP  (review critical 5)
// =========================================================================

section('4. resume ownership');

async function resumeTests(): Promise<void> {
  const base = tmpStore();
  const storeDir = join(base, 'store');
  const repoA = join(base, 'repoA');
  const repoB = join(base, 'repoB');
  mkdirSync(repoA, { recursive: true });
  mkdirSync(repoB, { recursive: true });

  // Two agents, both resumable, so ownership is the only variable.
  const alpha = createFakeAdapter({
    id: 'alpha',
    capabilities: { resume: true },
    script: [{ kind: 'frame', text: JSON.stringify({ text: 'hi', session: 'th_alpha' }) }, { kind: 'exit', code: 0 }],
  });
  const beta = createFakeAdapter({
    id: 'beta',
    capabilities: { resume: true },
    script: [{ kind: 'frame', text: JSON.stringify({ text: 'hi', session: 'th_beta' }) }, { kind: 'exit', code: 0 }],
  });
  const mk = (): Orchestrator =>
    new Orchestrator({ config: { agents: {} }, storeDir, extraAdapters: [alpha, beta] });

  // Create a thread for alpha in repoA.
  const o1 = mk();
  const first = await o1.run({ agentId: 'alpha', prompt: 'p', cwd: repoA }).result();
  check('owner run created a thread', first.threadId === 'th_alpha', `${first.threadId}`);
  const tid = first.threadId!;

  // correct agent + cwd -> PASS
  {
    const o = mk();
    let ok = true;
    let msg = '';
    try {
      const r = await o.run({ agentId: 'alpha', prompt: 'p', cwd: repoA, threadId: tid }).result();
      ok = r.state === 'succeeded';
      msg = r.state;
    } catch (e) {
      ok = false;
      msg = (e as Error).message;
    }
    check('correct agent + cwd is allowed', ok, msg);
  }

  // wrong agent -> reject
  {
    const o = mk();
    let rejected = false;
    let code = '';
    try {
      await o.run({ agentId: 'beta', prompt: 'p', cwd: repoA, threadId: tid });
    } catch (e) {
      rejected = e instanceof ThreadOwnershipError;
      code = (e as OrchestratorErrorLike).code;
    }
    check('wrong agent is rejected', rejected, code);
    check('wrong agent reports THREAD_OWNERSHIP', code === 'THREAD_OWNERSHIP', code);
  }

  // wrong cwd -> reject
  {
    const o = mk();
    let rejected = false;
    try {
      await o.run({ agentId: 'alpha', prompt: 'p', cwd: repoB, threadId: tid });
    } catch (e) {
      rejected = e instanceof ThreadOwnershipError;
    }
    check('wrong cwd is rejected', rejected);
  }

  // nonexistent thread -> reject
  {
    const o = mk();
    let rejected = false;
    try {
      await o.run({ agentId: 'alpha', prompt: 'p', cwd: repoA, threadId: 'th_does_not_exist' });
    } catch (e) {
      rejected = e instanceof ThreadNotFoundError;
    }
    check('nonexistent thread is rejected', rejected);
  }

  // explicit override is honoured (and logged as a warning path)
  {
    const o = mk();
    let ok = false;
    try {
      const r = await o.run({
        agentId: 'beta',
        prompt: 'p',
        cwd: repoB,
        threadId: tid,
        allowForeignThread: true,
      }).result();
      ok = r.state === 'succeeded';
    } catch (e) {
      ok = false;
    }
    check('explicit allowForeignThread permits a cross-agent resume', ok);
  }

  // adapter without resume support -> reject before any process
  {
    const noResume = createFakeAdapter({ id: 'gamma', capabilities: { resume: false } });
    const o = new Orchestrator({ config: { agents: {} }, storeDir, extraAdapters: [noResume] });
    let rejected = false;
    try {
      await o.run({ agentId: 'gamma', prompt: 'p', cwd: repoA, threadId: tid });
    } catch {
      rejected = true;
    }
    check('an agent without resume support refuses a resume', rejected);
  }

  rmSync(base, { recursive: true, force: true });
}

// =========================================================================
// 5. CAPABILITY TRUTH  (review critical 6)
// =========================================================================

section('5. capability truth (no silent drop)');

interface OrchestratorErrorLike {
  code: string;
}

async function capabilityTests(): Promise<void> {
  const dir = tmpStore();
  const adapter = createFakeAdapter({ id: 'caps', capabilities: { sandbox: false, modelSelection: false } });
  const orch = new Orchestrator({ config: { agents: {} }, storeDir: dir, extraAdapters: [adapter] });

  // An unsupported option must be REJECTED, not ignored.
  let rejected = false;
  let name = '';
  try {
    orch.run({ agentId: 'caps', prompt: 'p', cwd: dir, sandbox: 'read-only' });
  } catch (e) {
    rejected = e instanceof UnsupportedOptionError;
    name = (e as { option?: string }).option ?? '';
  }
  check('sandbox on an agent without sandbox support is rejected', rejected);
  check('the rejection names the offending option', name === 'sandbox', name);

  let rejectedModel = false;
  try {
    orch.run({ agentId: 'caps', prompt: 'p', cwd: dir, model: 'some/model' });
  } catch (e) {
    rejectedModel = e instanceof UnsupportedOptionError;
  }
  check('model on an agent without modelSelection is rejected', rejectedModel);

  // Supported options still work.
  let ok = true;
  try {
    const r = await orch.run({ agentId: 'caps', prompt: 'p', cwd: dir }).result();
    ok = r.state === 'succeeded';
  } catch {
    ok = false;
  }
  check('a plain run is unaffected by the rejections', ok);

  // The real adapters: OpenCode must refuse --sandbox and review.
  {
    const oc = ocAdapter();
    check('opencode adapter is constructible', oc !== null);
    if (oc) {
      check('opencode declares sandbox:false', oc.descriptor.capabilities.sandbox === false);
      check('opencode declares review:false', oc.descriptor.capabilities.review === false);
      let s = false;
      try {
        oc.validateRequest({ agentId: 'opencode', prompt: 'p', cwd: dir, sandbox: 'read-only' });
      } catch (e) {
        s = e instanceof UnsupportedOptionError;
      }
      check('opencode REFUSES a sandbox request', s);
      let rv = false;
      try {
        oc.validateRequest({ agentId: 'opencode', prompt: 'p', cwd: dir, mode: 'review' });
      } catch (e) {
        rv = e instanceof UnsupportedOptionError;
      }
      check('opencode REFUSES native review', rv);
      // and a plain request is accepted
      let plain = true;
      try {
        oc.validateRequest({ agentId: 'opencode', prompt: 'p', cwd: dir });
      } catch {
        plain = false;
      }
      check('opencode accepts a plain request', plain);
    }
  }
  {
    const cx = cxAdapter();
    if (cx) {
      check('codex declares sandbox:true', cx.descriptor.capabilities.sandbox === true);
      check('codex declares review:true', cx.descriptor.capabilities.review === true);
      let s = true;
      try {
        cx.validateRequest({ agentId: 'codex', prompt: 'p', cwd: dir, sandbox: 'read-only' });
      } catch {
        s = false;
      }
      check('codex accepts a sandbox on a fresh run', s);
      // The verified trap: `exec resume`/`exec review` reject --sandbox.
      let combo = false;
      try {
        cx.validateRequest({ agentId: 'codex', prompt: 'p', cwd: dir, sandbox: 'read-only', threadId: 'th_x' });
      } catch (e) {
        combo = e instanceof UnsupportedOptionError;
      }
      check('codex REFUSES sandbox+resume (the subcommand rejects -s)', combo);
      let combo2 = false;
      try {
        cx.validateRequest({ agentId: 'codex', prompt: 'p', cwd: dir, sandbox: 'read-only', mode: 'review' });
      } catch (e) {
        combo2 = e instanceof UnsupportedOptionError;
      }
      check('codex REFUSES sandbox+review (the subcommand rejects -s)', combo2);
      check('codex declares costReporting:false (tokens only)', cx.descriptor.capabilities.costReporting === false);
    }
  }

  // Every capability must be honest: nothing claims a feature we do not build.
  // Uses stub launchers, so this is machine-independent.
  for (const [id, adapter] of [
    ['opencode', ocAdapter()],
    ['codex', cxAdapter()],
  ] as const) {
    if (!adapter) continue;
    const c = adapter.descriptor.capabilities;
    check(
      `${id}: unimplemented features are all declared false`,
      c.steering === false && c.worktree === false && c.fork === false && c.stdinPrompt === false,
      JSON.stringify(c),
    );
  }

  rmSync(dir, { recursive: true, force: true });
}

// =========================================================================
// 6. TRANSPORT SEAM  (review critical 7)
// =========================================================================

section('6. transport seam');

async function transportTests(): Promise<void> {
  // The seam is a real interface with a lifecycle, not a metadata string.
  const t = new FakeTransport([{ kind: 'frame', text: 'a' }, { kind: 'exit', code: 0 }]);
  check(
    'a transport exposes start/events/wait/cancel/dispose',
    ['start', 'events', 'wait', 'cancel', 'dispose'].every(
      (m) => typeof (t as unknown as Record<string, unknown>)[m] === 'function',
    ),
  );
  t.start();
  const frames: unknown[] = [];
  for await (const f of t.events()) frames.push(f);
  const exit = await t.wait();
  check('transport frames reach the subscriber', frames.length === 1, `${frames.length}`);
  check('transport wait resolves the exit', exit.code === 0, `${exit.code}`);
  check('transport kind is one of the declared kinds', ['cli-jsonl', 'acp', 'app-server'].includes(t.kind), t.kind);

  // A real adapter builds a real transport without a process running.
  const oc = ocAdapter();
  check('an adapter is constructible', oc !== null);
  if (oc) {
    const tr = oc.createTransport({ agentId: 'opencode', prompt: 'p', cwd: dir2() });
    check('an adapter builds a real transport', tr.kind === 'cli-jsonl', tr.kind);
    check('the transport has a command line', tr.commandLine.length > 0);
    check('the transport exposes a frame stream, not raw stdout', typeof tr.events === 'function');
    await tr.dispose();
    await tr.dispose();
    check('dispose is idempotent', true);
  }

  // ACP is a declared kind with no implementation yet --the seam is reserved,
  // not half-built.
  check('acp is a declared transport kind with no implementation', !('acp' in ADAPTER_FACTORIES));
}

function dir2(): string {
  return mkdtempSync(join(tmpdir(), 'orch-t-'));
}

// =========================================================================
// 7. ADAPTER REGISTRY / BOOTSTRAP  (review important 12)
// =========================================================================

section('7. adapter registry / bootstrap');

async function registryTests(): Promise<void> {
  check('known agents come from the factory table', knownAgentIds().includes('opencode') && knownAgentIds().includes('codex'));
  check('createAdapter returns null for an unknown id', createAdapter('no-such-agent', {}) === null);

  // The orchestrator registers from the table, so no hard-coded pair remains.
  // Registration depends on the binary being discoverable, which is a machine
  // fact, so an absent agent skips instead of failing.
  const o = new Orchestrator({ config: { agents: {} }, storeDir: tmpStore() });
  for (const id of knownAgentIds()) {
    if (o.agentIds().includes(id)) {
      check(`orchestrator registered "${id}" from the factory table`, true);
    } else {
      skip(`orchestrator registered "${id}"`, 'binary not discoverable on this machine');
    }
  }

  // Configured-but-unknown agents must not crash startup, and must be reported.
  const o2 = new Orchestrator({
    config: { agents: { zcode: { command: 'C:/nope/zcode.exe' } } },
    storeDir: tmpStore(),
  });
  check('an agent with no factory does not break startup', o2.agentIds().length >= 1);

  let notFound = false;
  try {
    o2.adapter('definitely-missing');
  } catch (e) {
    notFound = e instanceof AdapterNotFoundError;
  }
  check('unknown agent lookup throws AdapterNotFoundError', notFound);
}

// =========================================================================
// 8. WINDOWS LAUNCHER  (review important 11)
// =========================================================================

section('8. windows launcher');

function launcherTests(): void {
  // Native binaries.
  const exe = launcherFor('C:/tools/agent.exe');
  check('.exe launches natively', exe.ok && exe.launcher.kind === 'native');
  check('.exe has no prefix args', exe.ok && exe.launcher.prefixArgs.length === 0);
  const com = launcherFor('C:/tools/agent.com');
  check('.com launches natively', com.ok && com.launcher.kind === 'native');

  // Batch shims now get a launcher instead of an EINVAL.
  const cmd = launcherFor('C:/npm/agent.CMD');
  check('.cmd resolves to a cmd-wrapper', cmd.ok && cmd.launcher.kind === 'cmd-wrapper', cmd.ok ? '' : cmd.reason);
  if (cmd.ok) {
    check('cmd-wrapper uses cmd.exe', /cmd(\.exe)?$/i.test(cmd.launcher.command), cmd.launcher.command);
    check('cmd-wrapper passes /d /s /c', cmd.launcher.prefixArgs.join(' ') === '/d /s /c');
    check('cmd-wrapper is marked as building a command string', cmd.launcher.buildsCommandString === true);
  }
  const bat = launcherFor('C:/npm/agent.bat');
  check('.bat resolves to a cmd-wrapper', bat.ok && bat.launcher.kind === 'cmd-wrapper');

  // PowerShell is reported as unsupported rather than half-supported.
  const ps1 = launcherFor('C:/npm/agent.ps1');
  check('.ps1 is explicitly unsupported', !ps1.ok && /not supported/i.test(ps1.reason));
  check('.ps1 error names the real binary to use', /opencode-ai|\.exe/i.test(ps1.ok ? '' : ps1.reason));

  // argv safety for the cmd path: quoted, and dangerous input is REFUSED.
  if (cmd.ok) {
    const argv = buildLaunchArgv(cmd.launcher, ['--flag', 'value with spaces']);
    check('cmd argv ends with one quoted command string', argv.length === 4 && argv[3]!.includes('"'));
    check('every cmd argument is quoted', argv[3]!.split('" "').length >= 3, argv[3]!);

    let threw = false;
    try {
      assertCmdSafe(['--flag', 'a & calc.exe']);
    } catch (e) {
      threw = /not safe/i.test((e as Error).message);
    }
    check('cmd metacharacter `&` is refused, not mangled', threw);

    for (const bad of ['a | b', 'a > b', 'a < b', 'a ^ b', '%PATH%', 'a"b', 'a\nb', 'a\rb', 'a!b', 'a`b']) {
      let t2 = false;
      try {
        assertCmdSafe([bad]);
      } catch {
        t2 = true;
      }
      check(`cmd metacharacter in ${JSON.stringify(bad)} is refused`, t2);
    }
    let safe = true;
    try {
      assertCmdSafe(['--sandbox', 'read-only', 'C:/a b/c', 'plain']);
    } catch {
      safe = false;
    }
    check('ordinary arguments are accepted', safe);
  }

  // Native path never builds a command string.
  if (exe.ok) {
    const argv = buildLaunchArgv(exe.launcher, ['--a b', 'c&d']);
    check('native argv is passed as an array, unchanged', argv.length === 2 && argv[1] === 'c&d');
  }
}

// =========================================================================
// 9. LINE FRAMING  (indirectly: JSON drain correctness)
// =========================================================================

section('9. line framing');

function framingTests(): void {
  const got: string[] = [];
  let rest = 'a\nb\r\nc';
  rest = emitCompleteLines(rest, (l) => got.push(l));
  check('CRLF and LF both frame correctly', got.join('|') === 'a|b', got.join('|'));
  check('an incomplete tail is carried forward, not emitted early', rest === 'c', JSON.stringify(rest));
  got.length = 0;
  emitCompleteLines(rest + '\n', (l) => got.push(l));
  check('the carried tail completes on the next chunk', got.join('|') === 'c', got.join('|'));

  const mixed: string[] = [];
  let r2 = '';
  // The chunk boundary lands mid-key, mid-JSON.
  for (const chunk of ['{"a":1}\n{"b', '":2}\n{"c":3}']) {
    r2 = emitCompleteLines(r2 + chunk, (l) => mixed.push(l));
  }
  // chunk boundary lands mid-JSON: the second line must be reassembled, and
  // the trailing fragment (which has no newline yet) must NOT be emitted.
  check(
    'JSON split across chunks is reassembled',
    mixed.length === 2 && mixed[0] === '{"a":1}' && mixed[1] === '{"b":2}',
    JSON.stringify(mixed),
  );
  check('a fragment with no newline yet is not emitted', r2 === '{"c":3}', JSON.stringify(r2));
}

// =========================================================================
// 10. DISCOVERY --machine-independent  (review important 11 & 15)
// =========================================================================

section('10. discovery (fixture-based, no machine assumptions)');

function discoveryTests(): void {
  const dir = mkdtempSync(join(tmpdir(), 'orch-launch-'));
  try {
    // Fixture: a .exe and a .cmd with the same base name in one directory.
    const fake = join(dir, 'faketool');
    mkdirSync(fake, { recursive: true });
    const exePath = join(fake, 'faketool.exe');
    const cmdPath = join(fake, 'faketool.cmd');
    const ps1Path = join(fake, 'faketool.ps1');
    writeFileSync(exePath, 'MZ-not-really');
    writeFileSync(cmdPath, '@echo off');
    writeFileSync(ps1Path, 'Write-Host hi');
    try {
      chmodSync(exePath, 0o755);
    } catch {
      /* Windows: not meaningful */
    }

    const oldPath = process.env.PATH;
    process.env.PATH = `${fake}${process.platform === 'win32' ? ';' : ':'}${oldPath ?? ''}`;

    // A real .exe must win over a same-directory .cmd / .ps1 shim.
    const found = searchPath('faketool');
    check('PATH search prefers the real .exe over .cmd/.ps1 shims',
      found !== null && found.toLowerCase().endsWith('.exe'), String(found));

    // Only a .cmd exists -> discovery yields a cmd-wrapper, not an error.
    const onlyCmd = mkdtempSync(join(tmpdir(), 'orch-cmd-'));
    writeFileSync(join(onlyCmd, 'shimonly.cmd'), '@echo off');
    process.env.PATH = onlyCmd + (process.platform === 'win32' ? ';' : ':') + (oldPath ?? '');
    const cmdOnly = searchPath('shimonly');
    check('a .cmd-only install is still found', cmdOnly !== null && cmdOnly.toLowerCase().endsWith('.cmd'), String(cmdOnly));

    process.env.PATH = oldPath ?? '';

    // Explicit config path wins and is type-checked.
    const r1 = resolveCommand('any-agent', exePath);
    check('explicit .exe config resolves to a native launcher', r1.launcher.kind === 'native');
    const r2 = resolveCommand('any-agent', cmdPath);
    check('explicit .cmd config resolves to a cmd-wrapper', r2.launcher.kind === 'cmd-wrapper');

    // .ps1 is refused, with an error rather than a silent bad launch.
    let ps1Err = '';
    try {
      resolveCommand('any-agent', ps1Path);
    } catch (e) {
      ps1Err = (e as Error).message;
    }
    check('explicit .ps1 config is refused with guidance', /not supported/i.test(ps1Err), ps1Err);
    check('the .ps1 refusal names a real binary to use', /\.exe/i.test(ps1Err), ps1Err);

    let missing = false;
    try {
      resolveCommand('any-agent', join(dir, 'nope.exe'));
    } catch {
      missing = true;
    }
    check('a missing configured path is refused', missing);

    let unknown = false;
    try {
      resolveCommand('agent-that-does-not-exist-xyz', undefined);
    } catch (e) {
      unknown = /orchestrator\.json/.test((e as Error).message);
    }
    check('an unknown agent errors with config guidance', unknown);

    // MACHINE-INDEPENDENT: resolution logic is asserted with fixtures above.
    // Whether a real binary is present is a machine fact, so an absent agent
    // SKIPS here rather than failing the run.
    for (const id of knownAgentIds()) {
      let resolved = false;
      let missing = false;
      try {
        const a = createAdapter(id, {});
        resolved = a !== null && a.descriptor.launcher.command.length > 0;
      } catch {
        missing = true;
      }
      if (missing) {
        skip(`agent "${id}" binary is installed`, 'not installed on this machine');
      } else {
        check(`agent "${id}" resolves to a launchable spec`, resolved);
      }
    }

    rmSync(onlyCmd, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// =========================================================================
// run
// =========================================================================

void (async () => {
  try {
    await outcomeTests();
    await hubTests();
    await memoryTests();
    await resumeTests();
    await capabilityTests();
    await transportTests();
    await registryTests();
    launcherTests();
    framingTests();
    discoveryTests();
  } catch (e) {
    // A thrown error must fail the run loudly, not silently truncate it.
    failed++;
    failures.push(`threw: ${(e as Error).message}`);
    process.stdout.write(`\n  THREW: ${(e as Error).message}\n${(e as Error).stack ?? ''}\n`);
  }

  process.stdout.write(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  if (failures.length) {
    process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
  }
  process.stdout.write('\n');
  process.exitCode = failed === 0 ? 0 : 1;
})();
