/**
 * tests/dsh-adapter.test.ts — hermetic DSH (DeepSeek Harness) adapter tests.
 *
 * ============================================================================
 * WHAT THIS COVERS
 * ============================================================================
 * The minimal DSH HEADLESS adapter (`src/adapters/dsh.ts`), against the VERIFIED
 * local 0.1.5-rc.2 protocol:
 *
 *   - pure logic: request rejection, terminal policy, stdout/stderr mapping;
 *   - the REAL chain — `Orchestrator.run` -> `AgentSession` -> `CliJsonlTransport`
 *     -> contained `ManagedProcess` — driven by a CONTROLLED fixture, so `npm test`
 *     never needs a local DSH install;
 *   - success, non-zero exit, start failure, cancel and deadline;
 *   - cwd is honoured and unknown facts (no native session id, no usage/cost) stay
 *     UNKNOWN rather than fabricated.
 *
 * DSH 0.1.5-rc.2 prints the final answer on stdout and reasoning/errors on stderr;
 * it does NOT emit the upstream `--json` JSONL stream and does NOT print a session
 * id, so this test does NOT assert a JSON protocol the local version does not have.
 *
 * Run: node tests/dsh-adapter.test.ts
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UnsupportedOptionError } from '../src/core/errors.ts';
import type { LauncherSpec, RunRequest, TerminalDecision, TerminalInput } from '../src/core/types.ts';
import { createDshAdapter, parseDshErrorLine } from '../src/adapters/dsh.ts';
import { ADAPTER_FACTORIES, knownAgentIds } from '../src/adapters/index.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { recordingSink } from './helpers.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];
const cleanupFailures: string[] = [];
const tmpDirs: string[] = [];

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
function removeOwnedDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    cleanupFailures.push(`owned dir removal threw for ${dir}: ${(e as Error).message}`);
    return;
  }
  if (existsSync(dir)) cleanupFailures.push(`owned dir ${dir} still present after removal`);
}

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

function cleanExitInput(o: { code?: number | null; signal?: string | null; stderrTail?: string; localAbort?: 'cancelled' | 'timed_out' | null } = {}): TerminalInput {
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
const p = (input: TerminalInput): TerminalDecision => a.terminalPolicy(input);

check('exit 0 => succeeded', p(cleanExitInput()).state === 'succeeded');
{
  const d = p(cleanExitInput({ code: 1 }));
  check('exit 1 => failed NONZERO_EXIT', d.state === 'failed' && d.error?.code === 'NONZERO_EXIT', d.error?.code);
}
{
  const d = p(cleanExitInput({ code: null }));
  check('exit null (no status) => failed TRANSPORT_ERROR', d.state === 'failed' && d.error?.code === 'TRANSPORT_ERROR', d.error?.code);
}
check('local abort => failed (never succeeded)', p(cleanExitInput({ localAbort: 'timed_out' })).state === 'failed');
check('failure detail surfaces the dsh error line',
  (p(cleanExitInput({ code: 1, stderrTail: 'dsh: E_TURN: model refused\n' })).error?.message ?? '').includes('E_TURN'));

// =========================================================================
section('mapEvent: stdout = final answer; stderr = reasoning or error');

const sink = recordingSink();
const outEvents = a.mapEvent({ channel: 'stdout', text: 'the final answer' }, sink.ctx);
check('stdout maps to an output event', outEvents.length === 1 && outEvents[0]!.type === 'session.output');
check('stdout text is recorded via the sink', sink.texts.includes('the final answer'));
check('empty stdout maps to nothing', a.mapEvent({ channel: 'stdout', text: '' }, sink.ctx).length === 0);

const errEvents = a.mapEvent({ channel: 'stderr', text: 'dsh: E_TURN: boom' }, sink.ctx);
check('a dsh error line maps to a diagnostic', errEvents.length === 1 && errEvents[0]!.type === 'session.diagnostic');
check('the error is recorded as a native signal', sink.signals.some((s) => s.includes('E_TURN')));

const reasoning = a.mapEvent({ channel: 'stderr', text: 'just thinking' }, sink.ctx);
check('plain reasoning maps to progress (not an error)', reasoning.length === 1 && reasoning[0]!.type === 'session.progress');
const heading = a.mapEvent({ channel: 'stderr', text: 'dsh: reasoning:' }, sink.ctx);
check('the "dsh: reasoning:" heading is not an error', heading.length === 1 && heading[0]!.type === 'session.progress');

check('parseDshErrorLine extracts the code+message', parseDshErrorLine('dsh: E_TURN: x') === 'E_TURN: x');
check('parseDshErrorLine ignores the reasoning heading', parseDshErrorLine('dsh: reasoning:') === null);
check('parseDshErrorLine ignores a raw reasoning delta', parseDshErrorLine('some token') === null);

// =========================================================================
section('real chain: Orchestrator -> AgentSession -> CliJsonlTransport -> contained ManagedProcess');

const FIXTURE_JS = `
const fs = require('fs'), path = require('path');
const mode = fs.readFileSync(path.join(__dirname, 'mode.txt'), 'utf8').trim();
if (mode === 'hang') { setInterval(() => {}, 1000); }
else if (mode === 'success') {
  process.stderr.write('dsh: reasoning:\\n');
  process.stderr.write('thinking about it\\n');
  process.stdout.write('fixture-answer cwd=' + process.cwd() + '\\n');
  process.exit(0);
} else if (mode === 'nonzero') {
  process.stdout.write('partial answer\\n');
  process.stderr.write('dsh: E_TURN: model refused\\n');
  process.exit(1);
} else { process.exit(3); }
`;

async function realChain(): Promise<void> {
  const dir = ownDir();
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
  const setMode = (m: string): void => writeFileSync(join(dir, 'mode.txt'), m);

  // --- success -----------------------------------------------------------------
  setMode('success');
  const r1 = await orch.run({ agentId: 'dsh', prompt: 'do the thing', cwd: dir }).result();
  check('success: state succeeded', r1.state === 'succeeded', r1.state);
  check('success: stdout is the final answer', r1.output.includes('fixture-answer'), r1.output);
  check('success: the requested cwd is honoured', r1.output.includes(dir), r1.output);
  check('success: no native session id => threadId null', r1.threadId === null, String(r1.threadId));
  check('success: usage stays UNKNOWN (no fabricated tokens/cost)',
    r1.usage.totalTokens === undefined && r1.usage.costUsd === undefined, JSON.stringify(r1.usage));
  check('success: contained tree stop confirmed', r1.cleanup.treeStopConfirmed === true, JSON.stringify(r1.cleanup));

  // --- non-zero exit -----------------------------------------------------------
  setMode('nonzero');
  const r2 = await orch.run({ agentId: 'dsh', prompt: 'fail please', cwd: dir }).result();
  check('non-zero: state failed (never succeeded)', r2.state === 'failed', r2.state);
  check('non-zero: error code NONZERO_EXIT', r2.error?.code === 'NONZERO_EXIT', r2.error?.code);
  check('non-zero: the dsh error line reached the result', (r2.error?.message ?? '').includes('E_TURN')
    || r2.diagnostics.some((d) => d.includes('E_TURN')), r2.error?.message);

  // --- start failure (missing image) ------------------------------------------
  // The sealed launcher itself starts (it is the OS process this runtime created),
  // then cannot create the missing target, so the run fails with an UNKNOWN exit —
  // it is never reported as succeeded.
  const missing = createDshAdapter({
    launcher: { kind: 'native', command: 'C:/nope/dsh.exe', prefixArgs: [], target: 'C:/nope/dsh.exe', buildsCommandString: false },
  });
  const orch2 = new Orchestrator({ config: { agents: {} }, storeDir: join(dir, 'store2'), replaceAdapters: [missing] });
  const r3 = await orch2.run({ agentId: 'dsh', prompt: 'x', cwd: dir }).result();
  check('start failure: state failed', r3.state === 'failed', r3.state);
  check('start failure: the agent exit is UNKNOWN (null), never fabricated 0', r3.exitCode === null, String(r3.exitCode));

  // --- cancel ------------------------------------------------------------------
  setMode('hang');
  const h4 = orch.run({ agentId: 'dsh', prompt: 'hang', cwd: dir });
  await sleep(500);
  await h4.cancel('test cancel');
  const r4 = await h4.result();
  check('cancel: state cancelled', r4.state === 'cancelled', r4.state);

  // --- deadline ----------------------------------------------------------------
  setMode('hang');
  const r5 = await orch.run({ agentId: 'dsh', prompt: 'hang', cwd: dir, timeoutMs: 1200 }).result();
  check('deadline: state timed_out', r5.state === 'timed_out', r5.state);

  removeOwnedDir(dir);
}

await realChain();

// =========================================================================

for (const d of tmpDirs) removeOwnedDir(d);

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
if (cleanupFailures.length) {
  process.stdout.write(`cleanup failures (must fail the test):\n  ${cleanupFailures.map((f) => `- ${f}`).join('\n  ')}\n`);
}
process.stdout.write('\n');
process.exitCode = failed === 0 && cleanupFailures.length === 0 ? 0 : 1;
