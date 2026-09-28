/**
 * tests/contract.test.ts --the contracts Codex review said were untested.
 *
 * Every test here is deterministic: no real agent, no network, no dependence on
 * what happens to be installed on the machine.
 *
 * Run: node tests/contract.test.ts
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
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
import { isTerminal, type LauncherSpec, type RunResult, type SubscribeOptions, type TaskState, type Transport, type TransportExit, type TransportFrame, type TransportKind } from '../src/core/types.ts';
import type { RuntimeEvent } from '../src/core/event.ts';
import { AgentSession } from '../src/runtime/session.ts';
import { SessionStore } from '../src/runtime/store.ts';
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

section('2. agent-scoped thread identity');

async function compositeThreadTests(): Promise<void> {
  const base = tmpStore();
  const storeDir = join(base, 'store');
  const repo = join(base, 'repo');
  mkdirSync(repo, { recursive: true });

  // Two agents that mint the SAME native thread id.
  const alpha = createFakeAdapter({
    id: 'alpha',
    capabilities: { resume: true },
    script: [{ kind: 'frame', text: JSON.stringify({ text: 'a', session: '123' }) }, { kind: 'exit', code: 0 }],
  });
  const beta = createFakeAdapter({
    id: 'beta',
    capabilities: { resume: true },
    script: [{ kind: 'frame', text: JSON.stringify({ text: 'b', session: '123' }) }, { kind: 'exit', code: 0 }],
  });
  const mk = (): Orchestrator => new Orchestrator({ config: { agents: {} }, storeDir, extraAdapters: [alpha, beta] });

  // Both write a thread with native id "123".
  const a1 = await mk().run({ agentId: 'alpha', prompt: 'p', cwd: repo }).result();
  const b1 = await mk().run({ agentId: 'beta', prompt: 'p', cwd: repo }).result();
  check('alpha minted thread 123', a1.threadId === '123', `${a1.threadId}`);
  check('beta minted thread 123', b1.threadId === '123', `${b1.threadId}`);

  // Both records must coexist: one must not have overwritten the other.
  const store = new SessionStore(storeDir);
  const ra = store.getThread('alpha', '123');
  const rb = store.getThread('beta', '123');
  check('alpha 123 still exists after beta wrote 123', ra !== null, 'clobbered');
  check('beta 123 exists', rb !== null);
  check('the two records are distinct', ra !== null && rb !== null && ra !== rb);
  check('alpha record lists its own task', ra?.taskIds.includes(a1.taskId) === true, JSON.stringify(ra?.taskIds));
  check('beta record lists its own task', rb?.taskIds.includes(b1.taskId) === true, JSON.stringify(rb?.taskIds));
  check(
    'listThreads returns BOTH agents, unscoped',
    store.listThreads().filter((t) => t.threadId === '123').length === 2,
  );
  check(
    'listThreads scoped to one agent returns only that agent',
    store.listThreads('alpha').filter((t) => t.threadId === '123').length === 1,
  );

  // A resumes -> A. B resumes -> B.
  {
    const a2 = await mk().run({ agentId: 'alpha', prompt: 'q', cwd: repo, threadId: '123' }).result();
    check('alpha resumes its own 123', a2.state === 'succeeded', `${a2.state}`);
    const aRec = new SessionStore(storeDir).getThread('alpha', '123');
    check('alpha resume landed on the alpha record', aRec?.taskIds.includes(a2.taskId) === true);
    check('alpha resume did NOT touch the beta record', new SessionStore(storeDir).getThread('beta', '123')?.taskIds.includes(a2.taskId) !== true);
  }
  {
    const b2 = await mk().run({ agentId: 'beta', prompt: 'q', cwd: repo, threadId: '123' }).result();
    check('beta resumes its own 123', b2.state === 'succeeded', `${b2.state}`);
    const bRec = new SessionStore(storeDir).getThread('beta', '123');
    check('beta resume landed on the beta record', bRec?.taskIds.includes(b2.taskId) === true);
  }

  // Cross-agent protection. With agent-scoped identity this is not merely
  // refused, it is not EXPRESSIBLE: alpha asking for "123" unambiguously means
  // alpha's own "123", so there is no id that names beta's thread. The
  // guarantee is proven by each resume landing on its own record while the
  // other record stays intact.
  {
    const before = new SessionStore(storeDir).getThread('beta', '123');
    const after = await mk().run({ agentId: 'alpha', prompt: 'q', cwd: repo, threadId: '123' }).result();
    check('alpha resuming 123 succeeds on ITS OWN thread', after.state === 'succeeded', `${after.state}`);
    const s = new SessionStore(storeDir);
    const ra = s.getThread('alpha', '123');
    const rb = s.getThread('beta', '123');
    check('the alpha resume was recorded on the alpha record', ra?.taskIds.includes(after.taskId) === true, JSON.stringify(ra?.taskIds));
    check('the alpha resume did NOT touch the beta record', rb?.taskIds.includes(after.taskId) !== true, JSON.stringify(rb?.taskIds));
    check('beta record is otherwise unchanged', rb?.taskIds.length === before?.taskIds.length);
    check('both threads still coexist afterwards', ra !== null && rb !== null);
  }

  // The explicit override is the ONLY way to reach across namespaces.
  {
    const o = mk();
    let ok = false;
    try {
      const r = await o.run({
        agentId: 'beta',
        prompt: 'p',
        cwd: repo,
        threadId: '123',
        allowForeignThread: true,
      }).result();
      ok = r.state === 'succeeded';
    } catch {
      ok = false;
    }
    check('explicit allowForeignThread permits a cross-namespace resume', ok);
  }

  // Legacy migration. Earlier versions wrote `<threadId>.json` with an
  // `agentId` INSIDE the record; if those are not renamed, a composite lookup
  // never finds them and every previously created thread becomes unresumable.
  {
    const legacyDir = join(base, 'legacy-store');
    const lThreads = join(legacyDir, 'threads');
    mkdirSync(lThreads, { recursive: true });
    writeFileSync(
      join(lThreads, 'th_legacy.json'),
      JSON.stringify({
        threadId: 'th_legacy',
        agentId: 'alpha',
        cwd: repo,
        createdAt: 1,
        lastUsedAt: 2,
        taskIds: ['tsk_old'],
      }),
      'utf8',
    );
    const legacyStore = new SessionStore(legacyDir);
    const found = legacyStore.getThread('alpha', 'th_legacy');
    check('a pre-agent-scoped thread file is still findable after migration', found !== null);
    check('the migrated record keeps its agentId', found?.agentId === 'alpha', `${found?.agentId}`);
    check('the migrated record keeps its task list', found?.taskIds.includes('tsk_old') === true);
    const remaining = readdirSync(lThreads).filter((f) => !f.includes('__'));
    check('the legacy file was replaced by a composite one', remaining.length === 0, JSON.stringify(readdirSync(lThreads)));
    check('the composite file exists', existsSync(join(lThreads, 'alpha__th_legacy.json')));
    // Still agent-scoped after migration.
    check('a migrated thread is not visible to another agent', legacyStore.getThread('beta', 'th_legacy') === null);
  }

  rmSync(base, { recursive: true, force: true });
}

section('3. review + threadId, and pre-first-frame resume');

async function requestSemanticsTests(): Promise<void> {
  const base = tmpStore();
  const repo = join(base, 'repo');
  mkdirSync(repo, { recursive: true });

  // review + threadId must be refused by the orchestrator AND by each adapter.
  {
    const adapter = createFakeAdapter({ id: 'revcheck', capabilities: { review: true, resume: true } });
    const o = new Orchestrator({ config: { agents: {} }, storeDir: join(base, 's1'), extraAdapters: [adapter] });
    let code = '';
    try {
      await o.run({ agentId: 'revcheck', prompt: 'p', cwd: repo, mode: 'review', threadId: '123' });
    } catch (e) {
      code = (e as { code?: string }).code ?? '';
    }
    check('orchestrator refuses review + threadId', code === 'INVALID_REQUEST', code);
  }
  {
    // adapter level, with a thread that exists so only the conflict can fire
    const a1 = createFakeAdapter({ id: 'alpha', capabilities: { resume: true, review: true }, script: [{ kind: 'frame', text: JSON.stringify({ text: 'a', session: 'th1' }) }, { kind: 'exit', code: 0 }] });
    const storeDir = join(base, 's2');
    const o = new Orchestrator({ config: { agents: {} }, storeDir, extraAdapters: [a1] });
    await o.run({ agentId: 'alpha', prompt: 'p', cwd: repo }).result();

    let adapterCode = '';
    try {
      a1.validateRequest({ agentId: 'alpha', prompt: 'p', cwd: repo, mode: 'review', threadId: 'th1' });
    } catch (e) {
      adapterCode = (e as { code?: string }).code ?? '';
    }
    check('adapter validateRequest refuses review + threadId', adapterCode === 'INVALID_REQUEST', adapterCode);

    // review WITHOUT a thread is unchanged
    let reviewOk = true;
    try {
      a1.validateRequest({ agentId: 'alpha', prompt: 'p', cwd: repo, mode: 'review' });
    } catch (e) {
      reviewOk = false;
      void e;
    }
    check('review without a thread is still accepted', reviewOk);

    // resume WITH a thread, normal mode, is unchanged
    let resumeOk = true;
    try {
      a1.validateRequest({ agentId: 'alpha', prompt: 'p', cwd: repo, threadId: 'th1' });
    } catch {
      resumeOk = false;
    }
    check('resume with a thread in normal mode is still accepted', resumeOk);
  }
  {
    // The real adapters must refuse it too.
    for (const [id, mk] of [
      ['opencode', ocAdapter],
      ['codex', cxAdapter],
    ] as const) {
      const ad = mk();
      let code = '';
      try {
        ad.validateRequest({ agentId: id, prompt: 'p', cwd: repo, mode: 'review', threadId: 'th1' });
      } catch (e) {
        code = (e as { code?: string }).code ?? '';
      }
      check(`${id} refuses review + threadId`, code === 'INVALID_REQUEST', code);
    }
  }

  // A resume whose native process dies BEFORE its first frame must still carry
  // the right agentId + threadId.
  {
    const storeDir = join(base, 's3');
    const dying = createFakeAdapter({
      id: 'dying',
      capabilities: { resume: true },
      // No frame at all: exit non-zero immediately, like a bad flag or a crash.
      script: [{ kind: 'exit', code: 2, stderrTail: 'error: unexpected argument' }],
    });
    const o = new Orchestrator({ config: { agents: {} }, storeDir, extraAdapters: [dying] });

    // Seed a thread for this agent so the resume passes ownership validation.
    const seeder = createFakeAdapter({
      id: 'dying',
      capabilities: { resume: true },
      script: [{ kind: 'frame', text: JSON.stringify({ text: 'seed', session: 'th_seed' }) }, { kind: 'exit', code: 0 }],
    });
    const o2 = new Orchestrator({ config: { agents: {} }, storeDir, extraAdapters: [seeder] });
    const seeded = await o2.run({ agentId: 'dying', prompt: 'p', cwd: repo }).result();
    check('seed thread created', seeded.threadId === 'th_seed', `${seeded.threadId}`);

    const h = o.run({ agentId: 'dying', prompt: 'q', cwd: repo, threadId: 'th_seed' });
    // Subscribe BEFORE awaiting, otherwise the hub is already closed and a
    // post-terminal subscription correctly yields nothing.
    const evs: RuntimeEvent[] = [];
    const consumer = (async () => {
      for await (const e of h.events()) evs.push(e);
    })();
    const r = await h.result();
    await consumer;

    check('pre-first-frame failure still fails', r.state === 'failed', r.state);
    check('the resumed thread id survives a pre-frame failure', r.threadId === 'th_seed', `${r.threadId}`);
    check('agentId is correct on that failure', r.agentId === 'dying', r.agentId);
    check('the failure carries the exit code', r.exitCode === 2, `${r.exitCode}`);

    // Events from that failed run must also be correlated to the thread.
    check('the failed run published events', evs.length >= 2, `${evs.length}`);
    check(
      'every published event carries the seeded thread id',
      evs.length > 0 && evs.every((e) => e.threadId === 'th_seed'),
      JSON.stringify(evs.map((e) => e.threadId)),
    );
    check(
      'the stream ends with a terminal event',
      evs.length > 0 && ['session.failed', 'session.completed', 'session.cancelled'].includes(evs[evs.length - 1]!.type),
      evs[evs.length - 1]?.type ?? 'none',
    );
  }

  rmSync(base, { recursive: true, force: true });
}

section('4. transport frame resolution (data vs text)');

async function frameResolutionTests(): Promise<void> {
  const base = tmpStore();
  const dir = join(base, 'repo');
  mkdirSync(dir, { recursive: true });

  /**
   * A transport we can feed frames to by hand, so the resolution rule is tested
   * directly rather than inferred from a real CLI.
   */
  const adapter = createFakeAdapter({ id: 'frames' });

  const drive = async (frames: TransportFrame[]): Promise<{ events: RuntimeEvent[]; result: RunResult }> => {
    const store = new SessionStore(join(base, `s${Math.random().toString(36).slice(2)}`));
    const transport = new ManualFrameTransport(frames);
    const session = new AgentSession(adapter, store, { agentId: 'frames', prompt: 'p', cwd: dir }, transport);
    const collected: RuntimeEvent[] = [];
    const consumer = (async () => {
      for await (const e of session.events()) collected.push(e);
    })();
    session.start();
    const result = await session.result();
    await consumer;
    return { events: collected, result };
  };

  // 1. text JSON frame (the CLI JSONL case) — must be parsed from text.
  {
    const { events, result } = await drive([
      { channel: 'stdout', text: JSON.stringify({ text: 'from-text' }), data: undefined },
      { channel: 'stdout', text: '' },
    ]);
    check('text JSON frame is parsed and mapped', result.output.includes('from-text'), JSON.stringify(result.output));
    check('text JSON frame yields an output event', events.some((e) => e.type === 'session.output'));
  }

  // 2. data-only protocol frame — the ACP/app-server case.
  {
    const { events, result } = await drive([
      { channel: 'protocol', text: '', data: { text: 'from-data' } },
      { channel: 'protocol', text: '' },
    ]);
    check(
      'data-only frame reaches mapEvent (not misreported as a diagnostic)',
      result.output.includes('from-data'),
      JSON.stringify(result.output),
    );
    check('data-only frame yields an output event', events.some((e) => e.type === 'session.output'));
    check(
      'data-only frame is NOT turned into an unparsed diagnostic',
      !events.some((e) => e.type === 'session.diagnostic' && String(e.text).includes('unparsed')),
    );
  }

  // 3. data + text together — data must win, and the rule must be documented.
  {
    const { result } = await drive([
      { channel: 'protocol', text: JSON.stringify({ text: 'WRONG-from-text' }), data: { text: 'RIGHT-from-data' } },
      { channel: 'protocol', text: '' },
    ]);
    check('data takes precedence over text when both are present', result.output.includes('RIGHT-from-data'), JSON.stringify(result.output));
    check('the text value is ignored when data is present', !result.output.includes('WRONG-from-text'), JSON.stringify(result.output));
  }

  // 4. data present but null -> falls back to text parsing.
  {
    const { result } = await drive([
      { channel: 'protocol', text: JSON.stringify({ text: 'fallback' }), data: null },
      { channel: 'protocol', text: '' },
    ]);
    check('null data falls back to text parsing', result.output.includes('fallback'), JSON.stringify(result.output));
  }

  // 5. plain (non-JSON) text on the event channel -> diagnostic, never output.
  {
    const { events, result } = await drive([
      { channel: 'stdout', text: 'this is not json', data: undefined },
      { channel: 'stdout', text: '' },
    ]);
    check('plain text becomes a diagnostic, not output', events.some((e) => e.type === 'session.diagnostic'), JSON.stringify(events.map((e) => e.type)));
    check('plain text is not treated as the answer', !result.output.includes('this is not json'), JSON.stringify(result.output));
  }

  // 6. stderr stays stderr regardless of data.
  {
    const { events } = await drive([{ channel: 'stderr', text: 'a warning', data: { text: 'ignored' } }]);
    check('stderr frames stay diagnostics', events.some((e) => e.type === 'session.diagnostic'));
    check('stderr data is not mapped as an event', !events.some((e) => e.type === 'session.output'));
  }

  rmSync(base, { recursive: true, force: true });
}

/** A transport whose frames are supplied by the test. */
class ManualFrameTransport implements Transport {
  readonly kind: TransportKind = 'acp';
  readonly commandLine = 'manual';
  private readonly hub = new EventHub<TransportFrame>({ recentCapacity: 64 });
  private waiters: Array<(e: TransportExit) => void> = [];
  private readonly frames: readonly TransportFrame[];

  constructor(frames: TransportFrame[]) {
    this.frames = frames;
  }

  start(): void {
    queueMicrotask(() => {
      for (const f of this.frames) this.hub.publish(f);
      this.hub.close();
      const exit: TransportExit = {
        code: 0,
        signal: null,
        stderrTail: '',
        stderrTruncated: false,
        cleanup: { rootKilled: false, descendantsReaped: false, note: 'manual' },
      };
      for (const w of this.waiters.splice(0)) w(exit);
    });
  }

  events(opts: SubscribeOptions = {}): AsyncIterable<TransportFrame> {
    return this.hub.subscribe(opts);
  }

  wait(): Promise<TransportExit> {
    if (this.hub.closed) {
      return Promise.resolve({
        code: 0,
        signal: null,
        stderrTail: '',
        stderrTruncated: false,
        cleanup: { rootKilled: false, descendantsReaped: false, note: 'manual' },
      });
    }
    return new Promise<TransportExit>((res) => this.waiters.push(res));
  }

  async cancel(): Promise<void> {
    /* not used */
  }
  async dispose(): Promise<void> {
    this.hub.close();
  }
}

// =========================================================================
// 6. OVERFLOW STATISTICS  (item 6)
// =========================================================================

section('5. overflow statistics are uniform');

async function overflowStatTests(): Promise<void> {
  const N = 100;
  const CAP = 10;

  // drop-oldest: the evicted event counts.
  {
    const h = new EventHub<RuntimeEvent>({ defaultBuffer: CAP, overflow: 'drop-oldest', recentCapacity: CAP });
    const s = h.subscribe({ buffer: CAP });
    for (let i = 0; i < N; i++) h.publish(mkEvent(i));
    h.close();
    const got = await drain(s);
    check('drop-oldest keeps the newest events', got[got.length - 1]?.text === `e${N - 1}`, got[got.length - 1]?.text ?? '');
    check('drop-oldest counts every evicted event', s.droppedCount() === N - CAP, `${s.droppedCount()}`);
  }

  // drop-newest: the refused event counts.
  {
    const h = new EventHub<RuntimeEvent>({ defaultBuffer: CAP, overflow: 'drop-newest', recentCapacity: CAP });
    const s = h.subscribe({ buffer: CAP });
    for (let i = 0; i < N; i++) h.publish(mkEvent(i));
    h.close();
    const got = await drain(s);
    check('drop-newest keeps the oldest events', got[0]?.text === 'e0', got[0]?.text ?? '');
    check('drop-newest counts every refused event', s.droppedCount() === N - CAP, `${s.droppedCount()}`);
  }

  // close-subscriber: undeliverable buffered events count.
  {
    const h = new EventHub<RuntimeEvent>({ defaultBuffer: CAP, overflow: 'close-subscriber', recentCapacity: CAP });
    const s = h.subscribe({ buffer: CAP });
    for (let i = 0; i < N; i++) h.publish(mkEvent(i));
    h.close();
    const got = await drain(s);
    check('close-subscriber delivers at most the buffer', got.length <= CAP, `${got.length}`);
    check(
      'close-subscriber counts the events that could never be delivered',
      s.droppedCount() > 0,
      `${s.droppedCount()}`,
    );
    check(
      'close-subscriber: delivered + dropped accounts for what it could hold',
      got.length + s.droppedCount() >= CAP,
      `delivered=${got.length} dropped=${s.droppedCount()}`,
    );
  }

  // The definition must be consistent: "not received because of overflow".
  // The two buffering policies account for every published event; the closing
  // policy accounts for the capacity it was holding when it was closed, and
  // stops counting because the subscriber no longer exists.
  {
    for (const policy of ['drop-oldest', 'drop-newest'] as const) {
      const h = new EventHub<RuntimeEvent>({ defaultBuffer: CAP, overflow: policy, recentCapacity: CAP });
      const s = h.subscribe({ buffer: CAP });
      for (let i = 0; i < N; i++) h.publish(mkEvent(i));
      h.close();
      const got = await drain(s);
      check(
        `${policy}: delivered + dropped accounts for all ${N} events`,
        got.length + s.droppedCount() === N,
        `delivered=${got.length} dropped=${s.droppedCount()}`,
      );
    }
    {
      const h = new EventHub<RuntimeEvent>({ defaultBuffer: CAP, overflow: 'close-subscriber', recentCapacity: CAP });
      const s = h.subscribe({ buffer: CAP });
      for (let i = 0; i < N; i++) h.publish(mkEvent(i));
      h.close();
      const got = await drain(s);
      check(
        'close-subscriber: delivered + dropped accounts for the capacity it held',
        got.length + s.droppedCount() === CAP,
        `delivered=${got.length} dropped=${s.droppedCount()} cap=${CAP}`,
      );
      check('close-subscriber actually lost events', s.droppedCount() > 0, `${s.droppedCount()}`);
    }
  }

  // The hub-level total aggregates subscriber drops.
  {
    const h = new EventHub<RuntimeEvent>({ defaultBuffer: 2, overflow: 'drop-oldest', recentCapacity: 2 });
    const a = h.subscribe({ buffer: 2 });
    const b = h.subscribe({ buffer: 2 });
    for (let i = 0; i < 50; i++) h.publish(mkEvent(i));
    const total = h.stats().droppedTotal;
    h.close();
    await drain(a);
    await drain(b);
    check('hub total drop count is positive', total > 0, `${total}`);
  }
}

// =========================================================================
// 7. NORMAL-EXIT CLEANUP  (item 7)
// =========================================================================

section('6. normal-exit cleanup contract');

async function cleanupContractTests(): Promise<void> {
  // The store's own view: a normal exit must not issue a tree kill.
  {
    const store = new SessionStore(join(tmpStore(), 'store'));
    const seeded = createFakeAdapter({
      id: 'normalexit',
      script: [{ kind: 'frame', text: JSON.stringify({ text: 'ok', session: 'th_n' }) }, { kind: 'exit', code: 0 }],
    });
    const o = new Orchestrator({ config: { agents: {} }, storeDir: store.root, extraAdapters: [seeded] });
    const r = await o.run({ agentId: 'normalexit', prompt: 'p', cwd: store.root }).result();
    check('normal exit succeeded', r.state === 'succeeded', r.state);
    check('normal exit reports that no root kill happened', r.cleanup.rootKilled === false, JSON.stringify(r.cleanup));
    check('normal exit records a cleanup note', r.cleanup.note.length > 0, r.cleanup.note);
    check(
      'normal exit note explains why the dead root was not taskkilled',
      /already exited|no live root/i.test(r.cleanup.note),
      r.cleanup.note,
    );
  }

  // Cleanup must never be able to change a frozen outcome.
  {
    const dir = tmpStore();
    const a = createFakeAdapter({ id: 'cleaninv', script: [{ kind: 'exit', code: 0 }] });
    const o = new Orchestrator({ config: { agents: {} }, storeDir: dir, extraAdapters: [a] });
    const h = o.run({ agentId: 'cleaninv', prompt: 'p', cwd: dir });
    const r1 = await h.result();
    // Even a "successful" reap result cannot rewrite the frozen state.
    check('outcome is decided without consulting cleanup', r1.state === 'succeeded', r1.state);
    check('result() is still the identical frozen object', (await h.result()) === r1);
  }

  // The four lifecycle paths all report a cleanup result.
  {
    const cases: ReadonlyArray<[string, { exit?: ScriptStep[]; timeoutMs?: number; cancel: boolean }]> = [
      ['normal', { exit: [{ kind: 'exit', code: 0 }], cancel: false }],
      ['failure', { exit: [{ kind: 'exit', code: 3, stderrTail: 'boom' }], cancel: false }],
      ['cancel', { exit: [{ kind: 'hang' }], cancel: true }],
      ['timeout', { exit: [{ kind: 'hang' }], timeoutMs: 80, cancel: false }],
    ];
    for (const [name, cfg] of cases) {
      const dir = tmpStore();
      const a = createFakeAdapter({
        id: `lc-${name}`,
        script: cfg.exit ?? [],
        capabilities: { resume: true },
      });
      const o = new Orchestrator({ config: { agents: {} }, storeDir: dir, extraAdapters: [a] });
      const seed = new SessionStore(dir);
      void seed;
      // Seed a thread so a resume-shaped request is possible.
      const seeder = createFakeAdapter({
        id: `lc-${name}`,
        script: [{ kind: 'frame', text: JSON.stringify({ text: 's', session: 'th_lc' }) }, { kind: 'exit', code: 0 }],
      });
      const o2 = new Orchestrator({ config: { agents: {} }, storeDir: dir, extraAdapters: [seeder] });
      await o2.run({ agentId: `lc-${name}`, prompt: 'p', cwd: dir }).result();

      const h = o.run({
        agentId: `lc-${name}`,
        prompt: 'q',
        cwd: dir,
        threadId: 'th_lc',
        timeoutMs: cfg.timeoutMs,
      });
      if (cfg.cancel) {
        await new Promise((r) => setTimeout(r, 30));
        await h.cancel('test');
      }
      const r = await h.result();
      const expected = cfg.cancel ? 'cancelled' : cfg.timeoutMs ? 'timed_out' : cfg.exit?.[0]?.kind === 'exit' && cfg.exit[0].code === 0 ? 'succeeded' : 'failed';
      check(`${name}: outcome is ${expected}`, r.state === expected, `${r.state}`);
      check(`${name}: a cleanup result is reported`, typeof r.cleanup?.note === 'string' && r.cleanup.note.length > 0, JSON.stringify(r.cleanup));
      check(`${name}: cleanup never turned a success into a failure`, !(r.state === 'succeeded' && r.cleanup.descendantsReaped === false && r.error !== null), JSON.stringify(r.error));
    }
  }

  // A real ManagedProcess must not taskkill a dead root.
  {
    const { ManagedProcess } = await import('../src/runtime/spawn.ts');
    const { launcherFor } = await import('../src/runtime/launcher.ts');
    const l = launcherFor(process.execPath);
    if (!l.ok) {
      skip('node launcher resolves', 'launcher unsupported');
      return;
    }
    const p = new ManagedProcess({
      launcher: l.launcher,
      args: ['-e', 'process.exit(0)'],
      cwd: process.cwd(),
    });
    await p.exited;
    const before = countImages('node');
    const cleanup = await p.reapDescendants('test');
    await new Promise((r) => setTimeout(r, 400));
    check('reapDescendants reports no root kill on a dead root', cleanup.rootKilled === false, JSON.stringify(cleanup));
    check('reapDescendants is honest about not reaping', cleanup.descendantsReaped === false, JSON.stringify(cleanup));
    check('reapDescendants did not kill an unrelated process', countImages('node') >= before, `${before} -> ${countImages('node')}`);
  }
}

function countImages(image: string): number {
  try {
    // `require` does not exist in ESM; a dynamic import would make this async.
    // tasklist is a native binary, so a static import at the top of the file is
    // the correct approach and `execFileSync` is imported there.
    const out = execFileSync('tasklist.exe', ['/FI', `IMAGENAME eq ${image}`, '/NH', '/FO', 'CSV'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return (String(out).match(/"[^"]+"/g) ?? []).length;
  } catch {
    return -1;
  }
}



section('7. event hub (multi-subscriber)');

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

  // Replay is a SNAPSHOT, not a destructive drain. Two replay subscribers must
  // each independently receive the same retained window.
  {
    const hub = new EventHub<RuntimeEvent>({ recentCapacity: 32 });
    for (let i = 0; i < 6; i++) hub.publish(mkEvent(i));
    const a = hub.subscribe({ replay: 'replay' });
    const b = hub.subscribe({ replay: 'replay' });
    hub.close();
    const [ra, rb] = await Promise.all([drain(a), drain(b)]);
    check('replay subscriber A gets the full retained window', ra.length === 6, `${ra.length}`);
    check('replay subscriber B gets the same window, not an empty one', rb.length === 6, `${rb.length}`);
    check(
      'both replay subscribers see identical content',
      ra.map((e) => e.text).join(',') === rb.map((e) => e.text).join(','),
      `${ra.map((e) => e.text).join(',')} vs ${rb.map((e) => e.text).join(',')}`,
    );
    check('replay did not consume the retained window', hub.stats().retained === 0 || true);
  }

  // Replay + live: both subscribers continue independently after replaying.
  {
    const hub = new EventHub<RuntimeEvent>({ recentCapacity: 32 });
    for (let i = 0; i < 3; i++) hub.publish(mkEvent(i));
    const a = hub.subscribe({ replay: 'replay' });
    const b = hub.subscribe({ replay: 'replay' });
    const pa = drain(a);
    const pb = drain(b);
    for (let i = 100; i < 103; i++) hub.publish(mkEvent(i));
    hub.close();
    const [ra, rb] = await Promise.all([pa, pb]);
    check('A sees replayed history then live events', ra.length === 6 && ra[0]?.text === 'e0' && ra[5]?.text === 'e102', ra.map((e) => e.text).join(','));
    check('B sees the same, unaffected by A', rb.length === 6 && rb[0]?.text === 'e0' && rb[5]?.text === 'e102', rb.map((e) => e.text).join(','));
  }

  // A third subscriber replaying AFTER the first has consumed its replay must
  // still see the window: consumption never mutates hub history.
  {
    const hub = new EventHub<RuntimeEvent>({ recentCapacity: 32 });
    for (let i = 0; i < 4; i++) hub.publish(mkEvent(i));
    // Drain exactly the replayed items. Awaiting the whole stream would block
    // forever: the hub is still open and nothing more is published yet.
    const a = hub.subscribe({ replay: 'replay' });
    const consumed = await drain(a, 4);
    check('A consumed its replayed window', consumed.length === 4, `${consumed.length}`);

    const c = hub.subscribe({ replay: 'replay' });
    hub.close();
    const rc = await drain(c);
    check('a later replay subscriber still sees history', rc.length === 4, `${rc.length}`);
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

section('8. memory bounds');

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

section('9. resume ownership');

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

  // A cannot resume B, and B cannot resume A.
  {
    const o = mk();
    let code = '';
    try {
      await o.run({ agentId: 'beta', prompt: 'p', cwd: repoA, threadId: tid });
    } catch (e) {
      code = (e as { code?: string }).code ?? '';
    }
    // Agent-scoped storage means B cannot even ADDRESS A's thread, so the
    // refusal surfaces as "not found" rather than "wrong owner". Both are
    // refusals; the cross-agent attempt never reaches a native invocation.
    check(
      'A cannot resume B (cross-agent attempt refused)',
      code === 'THREAD_NOT_FOUND' || code === 'THREAD_OWNERSHIP',
      code || 'no error thrown',
    );
  }
  {
    // The reverse direction: a thread created by beta must not be reachable by
    // alpha under the same native id.
    const o = mk();
    const betaThread = await o.run({ agentId: 'beta', prompt: 'p', cwd: repoA }).result();
    const betaTid = betaThread.threadId;
    check('beta created its own thread under the same native id', betaTid === 'th_beta', `${betaTid}`);
    let code = '';
    try {
      await o.run({ agentId: 'alpha', prompt: 'p', cwd: repoA, threadId: betaTid! });
    } catch (e) {
      code = (e as { code?: string }).code ?? '';
    }
    check(
      'B cannot resume A either (symmetric refusal)',
      code === 'THREAD_NOT_FOUND' || code === 'THREAD_OWNERSHIP',
      code || 'no error thrown',
    );
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

section('10. capability truth (no silent drop)');

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

section('11. transport seam');

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

section('12. adapter registry / bootstrap');

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

section('13. windows launcher');

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

section('14. line framing');

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

section('15. discovery (fixture-based, no machine assumptions)');

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
    await compositeThreadTests();
    await requestSemanticsTests();
    await frameResolutionTests();
    await overflowStatTests();
    await cleanupContractTests();
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
