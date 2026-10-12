/**
 * tests/dsh-adapter.test.ts — hermetic DSH (DeepSeek Harness) adapter tests.
 *
 * ============================================================================
 * WHAT THIS COVERS
 * ============================================================================
 * The minimal DSH HEADLESS adapter (`src/adapters/dsh.ts`), against the VERIFIED
 * local 0.1.5-rc.2 protocol:
 *
 *   - pure logic: request rejection, terminal policy, and the stdout mapping;
 *   - the REAL chain — `Orchestrator.run` -> `AgentSession` -> `CliJsonlTransport`
 *     -> contained `ManagedProcess` — driven by a CONTROLLED fixture, so `npm test`
 *     never needs a local DSH install;
 *   - PLAIN-TEXT FIDELITY: the final answer is delivered VERBATIM. Newlines, empty
 *     lines, interior whitespace, CRLF and a trailing (or absent) final newline all
 *     survive, and multi-byte UTF-8 split across write chunks is reassembled;
 *   - the stderr CONTRACT: reasoning/errors appear in `RunResult.diagnostics` and
 *     NEVER in the final answer; a non-zero exit is still `failed`.
 *
 * DSH 0.1.5-rc.2 prints the final answer on stdout and reasoning/errors on stderr;
 * it does NOT emit the upstream `--json` JSONL stream and does NOT print a session
 * id, so this test does NOT assert a JSON protocol the local version does not have.
 *
 * Run: node tests/dsh-adapter.test.ts
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { UnsupportedOptionError } from '../src/core/errors.ts';
import type {
  LauncherSpec,
  RunHandle,
  RunRequest,
  RunResult,
  TerminalDecision,
  TerminalInput,
} from '../src/core/types.ts';
import { createDshAdapter, parseDshErrorLine } from '../src/adapters/dsh.ts';
import { ADAPTER_FACTORIES, knownAgentIds } from '../src/adapters/index.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { recordingSink } from './helpers.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];
const cleanupFailures: string[] = [];
const tmpDirs: string[] = [];
/** A setup/run error that escaped `realChain`; it must reach the final exit code. */
let fatal: unknown;
/** The owned dir `realChain` created, so a fatal path can still report it. */
let lastOwnedDir: string | null = null;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed++;
    failures.push(name + (detail ? ` - ${detail}` : ''));
    process.stdout.write(`  FAIL ${name}${detail ? ` - ${detail}` : ''}\n`);
  }
}
function section(t: string): void {
  process.stdout.write(`\n== ${t}\n`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function ownDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'dsh-'));
  tmpDirs.push(d);
  return d;
}
function removeOwnedDir(dir: string, opts?: { injectRemovalFailure?: boolean }): void {
  if (opts?.injectRemovalFailure === true) {
    cleanupFailures.push(`owned dir removal failed for ${dir}: injected`);
    return;
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    cleanupFailures.push(`owned dir removal threw for ${dir}: ${(e as Error).message}`);
    return;
  }
  if (existsSync(dir)) cleanupFailures.push(`owned dir ${dir} still present after removal`);
}

// =========================================================================
// B1.4a P2-A: the injection seam for the REAL `realChain` setup/finally. When
// `MC_DSH_FAIL_SETUP=1`, `realChain` throws AFTER its owned dir exists, so the same
// `finally` that cleans a normal run must clean it and the fatal error must reach the
// exit code. `MC_DSH_FAIL_CLEANUP=1` additionally makes that removal fail. There is no
// separate "simulate a throw then call cleanup" branch — the regression drives the
// actual function.
// =========================================================================

const STUB_LAUNCHER: LauncherSpec = {
  kind: 'native',
  command: 'C:/fake/dsh.exe',
  prefixArgs: [],
  target: 'C:/fake/dsh.exe',
  buildsCommandString: false,
};

function stubAdapter() {
  return createDshAdapter({ launcher: STUB_LAUNCHER });
}

function input(o: { code?: number | null; signal?: string | null; stderrTail?: string; localAbort?: 'cancelled' | 'timed_out' | null } = {}): TerminalInput {
  return {
    exit: {
      code: o.code === undefined ? 0 : o.code,
      signal: o.signal ?? null,
      stderrTail: o.stderrTail ?? '',
      stderrTruncated: false,
      cleanup: { rootKilled: false, descendantsReaped: false, note: 'test', treeStopConfirmed: true, processStart: 'started' },
    },
    nativeSignals: [],
    localAbort: o.localAbort ?? null,
  };
}

// =========================================================================
section('registration + discovery facts');

check('dsh is in the adapter factory table', ADAPTER_FACTORIES['dsh'] !== undefined);
check('knownAgentIds() includes dsh', knownAgentIds().includes('dsh'));
check('the stub adapter carries id "dsh"', stubAdapter().descriptor.id === 'dsh');

// =========================================================================
section('validateRequest: unsupported options are rejected before any process');

const adapter = stubAdapter();
function rejects(req: Partial<RunRequest>): boolean {
  try {
    adapter.validateRequest({ agentId: 'dsh', prompt: 'do it', cwd: '.', ...req });
    return false;
  } catch (e) {
    return e instanceof UnsupportedOptionError;
  }
}
check('per-request model rejected', rejects({ model: 'deepseek-x' }));
check('role rejected', rejects({ role: 'reviewer' }));
check('sandbox rejected', rejects({ sandbox: 'read-only' }));
check('resume/threadId rejected', rejects({ threadId: 'session-abc' }));
check('extraArgs rejected', rejects({ extraArgs: ['--x'] }));
check('review mode rejected', rejects({ mode: 'review' }));
check('a task beginning with "-" rejected', rejects({ prompt: '-oops' }));
check('a task beginning with whitespace then "-" rejected', rejects({ prompt: '   --flag' }));
check('a plain task is accepted', !rejects({}));
check('an interior dash is accepted', !rejects({ prompt: 'compare a - b' }));

// =========================================================================
section('terminalPolicy: exit code is authoritative');

const a = stubAdapter();
const p = (i: TerminalInput): TerminalDecision => a.terminalPolicy(i);

check('exit 0 => succeeded', p(input()).state === 'succeeded');
{
  const d = p(input({ code: 1 }));
  check('exit 1 => failed NONZERO_EXIT', d.state === 'failed' && d.error?.code === 'NONZERO_EXIT', d.error?.code);
}
{
  const d = p(input({ code: null }));
  check('exit null (no status) => failed TRANSPORT_ERROR', d.state === 'failed' && d.error?.code === 'TRANSPORT_ERROR', d.error?.code);
}
check('local abort => failed (never succeeded)', p(input({ localAbort: 'timed_out' })).state === 'failed');
check('failure detail surfaces the dsh error line',
  (p(input({ code: 1, stderrTail: 'dsh: E_TURN: model refused\n' })).error?.message ?? '').includes('E_TURN'));

// =========================================================================
section('mapEvent: stdout is the VERBATIM answer; stderr is NOT mapped here');

{
  const sink = recordingSink();
  // A chunk with newlines and an empty line must be delivered exactly.
  const raw = 'line1\n\nline2\n';
  const outEvents = a.mapEvent({ channel: 'stdout', text: raw }, sink.ctx);
  check('stdout maps to ONE output event carrying the chunk verbatim',
    outEvents.length === 1 && outEvents[0]!.type === 'session.output' && outEvents[0]!.text === raw,
    JSON.stringify(outEvents[0]?.text));
  check('the raw chunk is recorded via the sink verbatim', sink.texts.length === 1 && sink.texts[0] === raw);
  check('empty stdout maps to nothing', a.mapEvent({ channel: 'stdout', text: '' }, sink.ctx).length === 0);
  // stderr is handled by AgentSession, NOT by this adapter: the mapping returns [].
  check('the adapter does NOT map stderr itself (the session does)',
    a.mapEvent({ channel: 'stderr', text: 'dsh: E_TURN: boom' }, sink.ctx).length === 0 &&
    a.mapEvent({ channel: 'stderr', text: 'just thinking' }, sink.ctx).length === 0);
}

// The stderr PARSER is still used by terminalPolicy's failure detail; it is tested
// separately from the real-chain wiring.
check('parseDshErrorLine extracts the code+message', parseDshErrorLine('dsh: E_TURN: x') === 'E_TURN: x');
check('parseDshErrorLine ignores the reasoning heading', parseDshErrorLine('dsh: reasoning:') === null);
check('parseDshErrorLine ignores a raw reasoning delta', parseDshErrorLine('some token') === null);

// =========================================================================
section('real chain: Orchestrator -> AgentSession -> CliJsonlTransport -> contained ManagedProcess');

// File-driven fixture: the test writes the EXACT bytes it expects, so fidelity is
// asserted against a known ground truth rather than a fixed literal in the script.
const FIXTURE_JS = `
const fs = require('fs'), path = require('path');
const d = __dirname;
const rd = (n) => { try { return fs.readFileSync(path.join(d, n)); } catch { return null; } };
if (fs.existsSync(path.join(d, 'hang.txt'))) { setInterval(() => {}, 1000); }
else {
  const err = rd('stderr.txt');
  if (err) process.stderr.write(err);
  const payload = rd('payload.bin') || Buffer.from('');
  let chunk = payload.length || 1;
  const cRaw = rd('chunk.txt');
  if (cRaw) { const n = parseInt(cRaw.toString('utf8').trim(), 10); if (n > 0) chunk = n; }
  for (let i = 0; i < payload.length; i += chunk) process.stdout.write(payload.subarray(i, i + chunk));
  const eRaw = rd('exit.txt');
  const code = eRaw ? (parseInt(eRaw.toString('utf8').trim(), 10) || 0) : 0;
  // Natural exit (NO process.exit) so stdout fully drains before the process ends.
  process.exitCode = code;
}
`;

interface Scenario {
  payload?: string | Buffer;
  stderr?: string;
  exit?: number;
  chunk?: number;
  hang?: boolean;
}

async function runCollect(start: (req: RunRequest) => RunHandle, req: RunRequest): Promise<{ result: RunResult; outputEvents: string[] }> {
  const h: RunHandle = start(req);
  const texts: string[] = [];
  const sub = h.events({ replay: 'replay' });
  const drain = (async () => {
    for await (const ev of sub) {
      if (ev.type === 'session.output') texts.push(ev.text ?? '');
    }
  })();
  const result = await h.result();
  await drain;
  return { result, outputEvents: texts };
}

async function realChain(): Promise<void> {
  const dir = ownDir();
  lastOwnedDir = dir;
  // B1.4a P2-A: track every handle this run starts, so the `finally` can cancel anything
  // still RUNNING (with the existing contained stop confirmation) before deleting the
  // owned dir — even when a setup/run step threw.
  const running: RunHandle[] = [];
  try {
    // B1.4a P2-A: a setup failure AFTER the owned dir exists must be cleaned by the SAME
    // finally below and must reach the exit code. This is the REAL path, not a copy.
    if (process.env.MC_DSH_FAIL_SETUP === '1') throw new Error('injected fixture setup failure');

    writeFileSync(join(dir, 'fixture.cjs'), FIXTURE_JS);
    const fixtureCmd = join(dir, 'fixture.cmd');
    writeFileSync(fixtureCmd, `@echo off\r\n"${process.execPath}" "${join(dir, 'fixture.cjs')}"\r\n`);

    const launcher: LauncherSpec = {
      kind: 'cmd-wrapper',
      command: process.env.ComSpec ?? 'cmd.exe',
      prefixArgs: ['/d', '/s', '/c'],
      target: fixtureCmd,
      buildsCommandString: true,
    };
    const dsh = createDshAdapter({ launcher });
    const orch = new Orchestrator({ config: { agents: {} }, storeDir: join(dir, 'store'), replaceAdapters: [dsh] });

    const start = (req: RunRequest): RunHandle => {
      const h = orch.run(req);
      running.push(h);
      return h;
    };

    const scenarioFiles = ['payload.bin', 'stderr.txt', 'exit.txt', 'chunk.txt', 'hang.txt'];
    const setScenario = (s: Scenario): void => {
      for (const f of scenarioFiles) {
        try { rmSync(join(dir, f), { force: true }); } catch { /* ignore */ }
      }
      if (s.hang === true) writeFileSync(join(dir, 'hang.txt'), '1');
      if (s.payload !== undefined) writeFileSync(join(dir, 'payload.bin'), Buffer.isBuffer(s.payload) ? s.payload : Buffer.from(s.payload, 'utf8'));
      if (s.stderr !== undefined) writeFileSync(join(dir, 'stderr.txt'), s.stderr);
      if (s.exit !== undefined) writeFileSync(join(dir, 'exit.txt'), String(s.exit));
      if (s.chunk !== undefined) writeFileSync(join(dir, 'chunk.txt'), String(s.chunk));
    };

  // --- 1. multi-line answer with leading / middle / trailing empty lines ---------
  {
    const expected = '\nconst a = 1;\n\nconst b = 2;\n';
    setScenario({ payload: expected, exit: 0 });
    const { result, outputEvents } = await runCollect(start, { agentId: 'dsh', prompt: 'p1', cwd: dir });
    check('P1 multi-line: state succeeded', result.state === 'succeeded', result.state);
    check('P1 multi-line: output is EXACTLY the stdout bytes', result.output === expected, JSON.stringify(result.output));
    check('P1 multi-line: output events concatenate to the same bytes', outputEvents.join('') === expected, JSON.stringify(outputEvents.join('')));
    check('P1 multi-line: contained tree stop confirmed', result.cleanup.treeStopConfirmed === true, JSON.stringify(result.cleanup));
  }

  // --- 2. CRLF preserved verbatim ------------------------------------------------
  {
    const expected = 'a\r\nb\r\n\r\nc\r\n';
    setScenario({ payload: expected, exit: 0 });
    const { result, outputEvents } = await runCollect(start, { agentId: 'dsh', prompt: 'p2', cwd: dir });
    check('P1 CRLF: output preserves CRLF exactly', result.output === expected, JSON.stringify(result.output));
    check('P1 CRLF: output events preserve CRLF exactly', outputEvents.join('') === expected, JSON.stringify(outputEvents.join('')));
  }

  // --- 3. chunked writes splitting multi-byte UTF-8 across boundaries ------------
  {
    const expected = '中1\n\né2\n';
    setScenario({ payload: expected, exit: 0, chunk: 1 }); // 1 byte per write
    const { result, outputEvents } = await runCollect(start, { agentId: 'dsh', prompt: 'p3', cwd: dir });
    check('P1 chunked UTF-8: output reassembles exactly', result.output === expected, JSON.stringify(result.output));
    check('P1 chunked UTF-8: output events reassemble exactly', outputEvents.join('') === expected, JSON.stringify(outputEvents.join('')));
  }

  // --- 4. no trailing newline: nothing is invented -------------------------------
  {
    const expected = 'no trailing newline';
    setScenario({ payload: expected, exit: 0 });
    const { result, outputEvents } = await runCollect(start, { agentId: 'dsh', prompt: 'p4', cwd: dir });
    check('P1 no-trailing-newline: output has no invented newline', result.output === expected, JSON.stringify(result.output));
    check('P1 no-trailing-newline: output events match exactly', outputEvents.join('') === expected, JSON.stringify(outputEvents.join('')));
  }

  // --- 5. a JSON-LOOKING answer is delivered as text, never parsed ---------------
  {
    const expected = '{"a":1,"b":[2,3]}\n';
    setScenario({ payload: expected, exit: 0 });
    const { result, outputEvents } = await runCollect(start, { agentId: 'dsh', prompt: 'p5', cwd: dir });
    check('P1 JSON-looking answer: delivered verbatim as output', result.output === expected, JSON.stringify(result.output));
    check('P1 JSON-looking answer: output events match exactly', outputEvents.join('') === expected, JSON.stringify(outputEvents.join('')));
  }

  // --- P2. stderr reasoning/errors are diagnostics, never the answer -------------
  {
    setScenario({ payload: 'answer\n', stderr: 'dsh: reasoning:\nthinking hard\n', exit: 0 });
    const { result } = await runCollect(start, { agentId: 'dsh', prompt: 'p2reason', cwd: dir });
    check('P2 reasoning: state succeeded', result.state === 'succeeded', result.state);
    check('P2 reasoning: reasoning reaches diagnostics', result.diagnostics.some((d) => d.includes('reasoning')), JSON.stringify(result.diagnostics));
    check('P2 reasoning: reasoning is NOT in the final answer', !result.output.includes('reasoning') && !result.output.includes('thinking'), result.output);
    check('P2 reasoning: the answer is exactly stdout', result.output === 'answer\n', JSON.stringify(result.output));
  }
  {
    setScenario({ payload: 'partial\n', stderr: 'dsh: E_TURN: model refused\n', exit: 1 });
    const { result } = await runCollect(start, { agentId: 'dsh', prompt: 'p2fail', cwd: dir });
    check('P2 non-zero: state failed', result.state === 'failed', result.state);
    check('P2 non-zero: error code NONZERO_EXIT', result.error?.code === 'NONZERO_EXIT', result.error?.code);
    check('P2 non-zero: the dsh error reached diagnostics', result.diagnostics.some((d) => d.includes('E_TURN')), JSON.stringify(result.diagnostics));
    check('P2 non-zero: the error is NOT in the final answer', !result.output.includes('E_TURN'), result.output);
  }

  // --- success (short), non-zero, start failure, cancel, deadline ----------------
  {
    setScenario({ payload: 'ok\n', exit: 0 });
    const { result } = await runCollect(start, { agentId: 'dsh', prompt: 'ok', cwd: dir });
    check('success: state succeeded', result.state === 'succeeded', result.state);
    check('success: threadId null (no native session id)', result.threadId === null, String(result.threadId));
    check('success: usage stays UNKNOWN', result.usage.totalTokens === undefined && result.usage.costUsd === undefined, JSON.stringify(result.usage));
    check('success: contained tree stop confirmed', result.cleanup.treeStopConfirmed === true, JSON.stringify(result.cleanup));
  }
  {
    setScenario({ payload: 'partial\n', stderr: 'dsh: E: boom\n', exit: 2 });
    const { result } = await runCollect(start, { agentId: 'dsh', prompt: 'nonzero', cwd: dir });
    check('non-zero: state failed', result.state === 'failed', result.state);
    check('non-zero: error code NONZERO_EXIT', result.error?.code === 'NONZERO_EXIT', result.error?.code);
  }
  {
    const missing = createDshAdapter({
      launcher: { kind: 'native', command: 'C:/nope/dsh.exe', prefixArgs: [], target: 'C:/nope/dsh.exe', buildsCommandString: false },
    });
    const orch2 = new Orchestrator({ config: { agents: {} }, storeDir: join(dir, 'store2'), replaceAdapters: [missing] });
    const r3 = await orch2.run({ agentId: 'dsh', prompt: 'x', cwd: dir }).result();
    check('start failure: state failed', r3.state === 'failed', r3.state);
    check('start failure: exit UNKNOWN (null), never fabricated 0', r3.exitCode === null, String(r3.exitCode));
  }
  {
    setScenario({ hang: true });
    const h = start({ agentId: 'dsh', prompt: 'hang', cwd: dir });
    await sleep(500);
    await h.cancel('test cancel');
    const r = await h.result();
    check('cancel: state cancelled', r.state === 'cancelled', r.state);
  }
  {
    setScenario({ hang: true });
    const r = await start({ agentId: 'dsh', prompt: 'hang', cwd: dir, timeoutMs: 1200 }).result();
    check('deadline: state timed_out', r.state === 'timed_out', r.state);
  }

  } finally {
    // B1.4a P2-A: on EVERY exit path (including a setup/run throw), stop anything still
    // running via the EXISTING cancel + contained-stop confirmation, then delete the
    // owned dir. A cleanup failure is recorded in the ledger and drives a non-zero exit.
    for (const h of running) {
      if (h.state() === 'running') {
        await h.cancel('dsh-adapter test cleanup').catch(() => undefined);
        await h.result().catch(() => undefined);
      }
    }
    removeOwnedDir(dir, { injectRemovalFailure: process.env.MC_DSH_FAIL_CLEANUP === '1' });
  }
}

// Run the REAL chain; a setup/run error is captured as `fatal` (not swallowed) so it
// reaches the final exit code, while the owned cleanup above still ran.
try {
  await realChain();
} catch (e) {
  fatal = e;
  process.stdout.write(`fatal: ${String((e as Error).message)}\n`);
  const report = process.env.MC_DSH_REPORT;
  if (report !== undefined && report !== '') {
    try {
      writeFileSync(report, JSON.stringify({
        ownedDir: lastOwnedDir,
        cleaned: lastOwnedDir !== null && !existsSync(lastOwnedDir),
        error: String((e as Error).message),
        cleanupFailures,
      }));
    } catch { /* best effort */ }
  }
}

// =========================================================================
section('B1.4a P2-A: the REAL realChain setup/finally cleans up and propagates');

interface FailReport { ownedDir?: string | null; cleaned?: boolean; error?: string; cleanupFailures?: string[] }
// The injection child must NOT run this section (it would spawn children forever); it
// goes straight to the summary, where `fatal` forces the non-zero exit.
if (process.env.MC_DSH_FAIL_SETUP !== '1') {
  const testFile = fileURLToPath(import.meta.url);

  // Case 1: setup throws AFTER the owned dir exists; the SAME finally cleans it and the
  // original error is preserved.
  const report1 = join(ownDir(), 'report.json');
  const res1 = spawnSync(process.execPath, [testFile], {
    cwd: process.cwd(),
    env: { ...process.env, MC_DSH_FAIL_SETUP: '1', MC_DSH_REPORT: report1 },
    encoding: 'utf8',
    timeout: 60_000,
  });
  check('P2-A setup-fail: child exits NON-ZERO', res1.status !== 0 && res1.status !== null, `status=${String(res1.status)}`);
  check('P2-A setup-fail: not killed by a signal', res1.signal === null, `signal=${String(res1.signal)}`);
  let r1: FailReport | null = null;
  try { r1 = JSON.parse(readFileSync(report1, 'utf8')); } catch { /* unreadable */ }
  check('P2-A setup-fail: the ORIGINAL error is preserved', r1?.error === 'injected fixture setup failure', JSON.stringify(r1?.error));
  check('P2-A setup-fail: the owned dir was cleaned by the real finally', r1?.cleaned === true, JSON.stringify(r1));
  check('P2-A setup-fail: no cleanup failure recorded', (r1?.cleanupFailures?.length ?? -1) === 0, JSON.stringify(r1?.cleanupFailures));

  // Case 2: setup throws AND the cleanup fails — the ledger records it and the exit is
  // still non-zero; the parent removes ONLY the owned dir the child reported.
  const report2 = join(ownDir(), 'report.json');
  const res2 = spawnSync(process.execPath, [testFile], {
    cwd: process.cwd(),
    env: { ...process.env, MC_DSH_FAIL_SETUP: '1', MC_DSH_FAIL_CLEANUP: '1', MC_DSH_REPORT: report2 },
    encoding: 'utf8',
    timeout: 60_000,
  });
  check('P2-A cleanup-fail: child exits NON-ZERO', res2.status !== 0 && res2.status !== null, `status=${String(res2.status)}`);
  let r2: FailReport | null = null;
  try { r2 = JSON.parse(readFileSync(report2, 'utf8')); } catch { /* unreadable */ }
  check('P2-A cleanup-fail: the shared ledger recorded the failure', (r2?.cleanupFailures?.length ?? 0) >= 1, JSON.stringify(r2?.cleanupFailures));
  check('P2-A cleanup-fail: the owned dir was left behind (injection was real)', r2?.cleaned === false, JSON.stringify(r2));
  if (typeof r2?.ownedDir === 'string' && r2.ownedDir !== '') removeOwnedDir(r2.ownedDir);
  check('P2-A cleanup-fail: only the reported owned dir was cleaned',
    typeof r2?.ownedDir !== 'string' || r2.ownedDir === '' || !existsSync(r2.ownedDir));
}

// =========================================================================

for (const d of tmpDirs) removeOwnedDir(d);

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
if (cleanupFailures.length) {
  process.stdout.write(`cleanup failures (must fail the test):\n  ${cleanupFailures.map((f) => `- ${f}`).join('\n  ')}\n`);
}
if (fatal !== undefined) process.stdout.write(`fatal (must fail the test): ${String((fatal as Error).message)}\n`);
process.stdout.write('\n');
process.exitCode = failed === 0 && cleanupFailures.length === 0 && fatal === undefined ? 0 : 1;
