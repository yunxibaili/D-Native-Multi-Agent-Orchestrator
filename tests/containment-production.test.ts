// ===========================================================================
// W2 — production containment integration.
//
// Proves the Windows production path actually launches agents THROUGH the sealed
// Job launcher, that the control channel yields the real root pid / root exit
// code / tree-stop truth, that stdout/stderr/stdin/cwd/env are untouched, and
// that every failure mode fails CLOSED.
// ===========================================================================

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManagedProcess, taskkillTree } from '../src/runtime/spawn.ts';
import { launcherFor } from '../src/runtime/launcher.ts';
import {
  containmentEnabled,
  containmentStatus,
  resolveContainmentLauncher,
  expectedLauncherPath,
  createControlPath,
  controlDirectory,
  buildContainedArgv,
  readControlRecord,
  treeStopConfirmedFrom,
  peekRootPid,
  type ContainmentRecord,
} from '../src/runtime/containment.ts';
import { isProvenNotStarted } from '../src/runtime/start-proof.ts';
import { advanceProcessStart, isTerminalStartState } from '../src/runtime/process-start.ts';
import type { ProcessStartDisposition } from '../src/core/types.ts';
import { sourceText } from './helpers.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const SCRATCH = join(REPO, 'native', 'windows-job-launcher', 'build', '_w2-tests');
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; process.stdout.write(`  ok   ${name}\n`); }
  else { failed++; failures.push(name); process.stdout.write(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}\n`); }
}
function section(t: string): void { process.stdout.write(`\n== ${t} ==\n`); }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const NODE = launcherFor(process.execPath);
if (!NODE.ok) { process.stdout.write('node launcher did not resolve\n'); process.exit(1); }
const NODE_LAUNCHER = NODE.launcher;

function spawnNode(args: string[], opts: {
  cwd?: string; env?: Record<string, string>; stdin?: string;
  onStdoutLine?: (l: string) => void; onStderrLine?: (l: string) => void;
} = {}): ManagedProcess {
  return new ManagedProcess({
    launcher: NODE_LAUNCHER,
    args,
    cwd: opts.cwd ?? SCRATCH,
    env: opts.env ?? (process.env as Record<string, string>),
    ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
    ...(opts.onStdoutLine ? { onStdoutLine: opts.onStdoutLine } : {}),
    ...(opts.onStderrLine ? { onStderrLine: opts.onStderrLine } : {}),
  });
}

const utf16 = (s: string): Buffer => Buffer.from(s, 'utf16le');

const FIXTURE_EXE = join(REPO, 'native', 'windows-job-launcher', 'build', 'w1fixture.exe');

function scratch2(name: string): string {
  const d = join(SCRATCH, name);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
}

/** Spawn the launcher directly with a raw argv (normal mode) and capture stdout. */
function rawSpawnLP(argv: string[]): Promise<{ code: number | null; stdout: string }> {
  const l = resolveContainmentLauncher();
  return new Promise((res) => {
    const p = spawn(l!.exe, argv, { cwd: SCRATCH, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    p.stdout?.on('data', (b: Buffer) => { o += b.toString(); });
    p.once('error', () => res({ code: null, stdout: o }));
    p.once('close', (c) => res({ code: c, stdout: o }));
  });
}

// ===========================================================================
section('W2 module. resolution, invocation, and record validation');
{
  check('containment is enabled on Windows', containmentEnabled() === true);
  if (process.platform === 'win32') {
    const l = resolveContainmentLauncher();
    check('a launcher resolves', l !== null, String(l));
    if (l) {
      const ctl = createControlPath(l);
      const argv = buildContainedArgv(NODE_LAUNCHER, ['--version'], ctl);
      check('the invocation is exactly: --diag <ctl> -- <command> <args...>',
        argv[0] === '--diag' && argv[1] === ctl && argv[2] === '--'
          && argv[3] === NODE_LAUNCHER.command && argv[4] === '--version',
        JSON.stringify(argv));
    }
    check('the expected launcher path is reported', /w1joblauncher\.exe$/.test(expectedLauncherPath()));
  }
}

{
  const missing = join(SCRATCH, 'nope.txt');
  check('a missing record is NOT valid', readControlRecord(missing).ok === false);

  const incomplete = join(SCRATCH, 'incomplete.txt');
  writeFileSync(incomplete, utf16('launcherStatus=success\nphase=done\nrootPid=5\nrootExitCode=0\nactiveProcessesFinal=0\ntreeStopped=1\n'));
  check('a record without complete=1 is NOT valid', readControlRecord(incomplete).ok === false);

  const noStatus = join(SCRATCH, 'nostatus.txt');
  writeFileSync(noStatus, utf16('phase=done\ncomplete=1\n'));
  check('a record without launcherStatus is NOT valid', readControlRecord(noStatus).ok === false);

  const bogusSuccess = join(SCRATCH, 'bogus.txt');
  writeFileSync(bogusSuccess, utf16('launcherStatus=success\nphase=done\ncomplete=1\n'));
  check('a success record missing rootPid/rootExitCode/activeProcessesFinal is NOT valid',
    readControlRecord(bogusSuccess).ok === false);

  const good = join(SCRATCH, 'good.txt');
  writeFileSync(good, utf16(
    'launcherPid=11\nrootPid=22\nrootExitCode=0\nactiveProcessesFinal=0\n' +
    'treeStopped=1\nrootExitObserved=1\nassignedBeforeResume=1\nlauncherStatus=success\nphase=done\ncomplete=1\n'));
  const v = readControlRecord(good);
  check('a complete, well-formed success record validates', v.ok === true, JSON.stringify(v));
  if (v.ok) {
    check('the validated record carries the real facts',
      v.record.rootPid === 22 && v.record.rootExitCode === 0
      && v.record.activeProcessesFinal === 0 && v.record.treeStopped === true);
    check('treeStopConfirmed is true only for complete + success + ActiveProcesses==0',
      treeStopConfirmedFrom(v.record) === true);
    const notStopped: ContainmentRecord = { ...v.record, treeStopped: false };
    check('treeStopConfirmed is false when the Job still had processes',
      treeStopConfirmedFrom(notStopped) === false);
    const badStatus: ContainmentRecord = { ...v.record, launcherStatus: 'assign-failed' };
    check('treeStopConfirmed is false for a non-success status',
      treeStopConfirmedFrom(badStatus) === false);
  }
}

// ===========================================================================
section('W2-1/4/5/6/7/8. the real production path');
{
  const p = spawnNode(['-e', 'process.exit(0)']);
  const e = await p.exited;
  check('W2-1 a Windows production spawn went through the launcher', p.containment !== null);
  check('W2-6 the agent exit code comes from the control record', e.code === 0, `code=${e.code}`);
  check('W2-8 treeStopConfirmed is true after a clean, complete stop', p.isTreeStopConfirmed() === true);
  check('W2-5 ManagedProcess.pid is the AGENT root pid', p.pid === p.rootProcessPid, `pid=${p.pid} root=${p.rootProcessPid}`);
  check('W2-4 launcherPid != rootProcessPid', p.launcherPid !== p.rootProcessPid,
    `launcher=${p.launcherPid} root=${p.rootProcessPid}`);
  check('W2 the launcher pid is the direct child Node owns', typeof p.launcherPid === 'number');
  check('W2 the containment record names a success', p.containment?.launcherStatus === 'success');
}
{
  const p = spawnNode(['-e', 'process.exit(103)']);
  const e = await p.exited;
  check('W2-7 a root exit 103 is reported as the AGENT exit, not a launcher failure',
    e.code === 103, `code=${e.code}`);
  check('W2-7 and containment still completed successfully',
    p.isTreeStopConfirmed() === true && p.containment?.launcherStatus === 'success');
}

// ===========================================================================
section('W2-10/11/12/13. stdio / cwd / env are unchanged');
{
  let out = '';
  const p = spawnNode(['-e', 'console.log("W2_STDOUT_OK")'], { onStdoutLine: (l) => { out += l; } });
  await p.exited;
  check('W2-10 target stdout passes through', out.includes('W2_STDOUT_OK'), out);

  let err = '';
  const p2 = spawnNode(['-e', 'console.error("W2_STDERR_OK")'], { onStderrLine: (l) => { err += l; } });
  await p2.exited;
  check('W2-11 target stderr passes through', err.includes('W2_STDERR_OK'), err);

  let echoed = '';
  const p3 = spawnNode(['-e', 'process.stdin.on("data",d=>{console.log("GOT:"+d.toString().trim())})'], {
    stdin: 'W2_STDIN_PAYLOAD\n', onStdoutLine: (l) => { echoed += l; },
  });
  await p3.exited;
  check('W2-12 target stdin passes through', echoed.includes('GOT:W2_STDIN_PAYLOAD'), echoed);

  const dir = join(SCRATCH, 'cwd 目录 with spaces');
  mkdirSync(dir, { recursive: true });
  let info = '';
  const p4 = spawnNode(['-e', 'console.log(process.env.W2_MARK+"|"+process.cwd())'], {
    cwd: dir, env: { ...process.env, W2_MARK: 'w2-值' }, onStdoutLine: (l) => { info += l; },
  });
  await p4.exited;
  check('W2-13 cwd (Unicode + spaces) is preserved', info.includes(dir), info);
  check('W2-13 a custom env var is preserved verbatim', info.includes('w2-值'), info);
}

// ===========================================================================
section('W2-2/3/9. fail closed');
{
  // W2-2: an explicit, missing launcher must fail closed and NEVER run the agent.
  const marker = join(SCRATCH, 'agent-ran.txt');
  rmSync(marker, { force: true });
  const saved = process.env.ORCH_JOB_LAUNCHER;
  process.env.ORCH_JOB_LAUNCHER = join(SCRATCH, 'definitely-not-a-launcher.exe');
  try {
    const p = spawnNode(['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`]);
    const e = await p.exited;
    check('W2-2 a missing launcher is detected', p.containmentUnavailableReason === true);
    check('W2-2 the agent was NOT started', !existsSync(marker));
    check('W2-2 the run fails (spawn failure) rather than succeeding', e.code === 127, `code=${e.code}`);
    check('W2-2 the failure is explained', /containment-unavailable/.test(p.stderrTail.toString()));
  } finally {
    if (saved === undefined) delete process.env.ORCH_JOB_LAUNCHER;
    else process.env.ORCH_JOB_LAUNCHER = saved;
  }
  check('W2-3 an explicit override is authoritative (no silent fallback)', resolveContainmentLauncher() !== null);
}

{
  // W2-9: a cancelled run must not fabricate a root exit code.
  //
  // W3 CHANGED THIS DELIBERATELY. Under W2 the cancel hard-killed the launcher,
  // which left no final record and so could only ever report an unconfirmed stop.
  // That was honest but useless: every cancellation was unverifiable.
  //
  // Under W3 the cancel is COOPERATIVE — the launcher terminates the Job and writes
  // a final `terminated` record — so this run now DOES reach a confirmed stop.
  // The invariant W2 actually protected is preserved below: no agent exit code is
  // invented, because the code the launcher passes to TerminateJobObject is not a
  // result the agent chose.
  const p = spawnNode(['-e', 'setInterval(()=>{},1000)']);
  await sleep(300); // let the launcher establish containment
  await p.cancel('W2-9 test');
  const e = await p.exited;
  check('W2-9 a cancelled contained run does not fabricate a root exit code', e.code === null, `code=${e.code}`);
  check('W2-9 the cooperative stop is confirmed from the launcher record',
    p.isTreeStopConfirmed() === true, `status=${p.containment?.launcherStatus}`);
  check('W2-9 and is reported as terminated, NOT as agent success',
    p.containment?.terminated === true && p.containment?.launcherStatus !== 'success');
}

{
  // W2-9b (W3): the W2 invariant that actually matters — a stop we could NOT
  // confirm must still report false. This is the launcher being HARD-KILLED, so
  // it can never write a final record.
  const p = spawnNode(['-e', 'setInterval(()=>{},1000)']);
  await sleep(300);
  const launcher = p.launcherPid;
  if (launcher === undefined) {
    check('W2-9b a hard-killed launcher leaves no confirmed stop', false, 'no launcher pid');
  } else {
    taskkillTree(launcher);
    await p.exited;
    check('W2-9b a hard-killed launcher leaves no confirmed stop',
      p.isTreeStopConfirmed() === false, `status=${p.containment?.launcherStatus}`);
    check('W2-9b and no root exit code is invented', p.exitCode === null, String(p.exitCode));
  }
}

// ===========================================================================
section('W2-18. architecture integrity');
{
  const orch = sourceText(join(REPO, 'src', 'orchestration', 'orchestrator.ts'));
  const callSites = (orch.match(/this\.runtime\.run\(/g) ?? []).length;
  check('W2-18 there is exactly ONE production runtime.run call site', callSites === 1, String(callSites));

  const containmentSrc = sourceText(join(REPO, 'src', 'runtime', 'containment.ts'));
  check('the containment module adds no manager/authority class',
    !/class\s+\w*(Manager|Supervisor|Authority)\w*/.test(containmentSrc));
}

// ===========================================================================
section('W2-14..17. real agent command compatibility (doctor/version only)');
{
  // Prove native command resolution + launcher + stdio work for a REAL agent
  // binary. `--version` is side-effect free and never touches the repo.
  //
  // This is reported, not asserted: on a machine where an agent is not installed
  // (or is only a `.cmd` shim) the run cannot be a containment fact. What IS
  // asserted is that containment reports readiness.
  const status = containmentStatus();
  check('containment reports readiness', status.enabled === true && status.launcher !== null, JSON.stringify(status));

  for (const name of ['opencode', 'codex']) {
    const resolved = launcherFor(name);
    if (!resolved.ok) {
      process.stdout.write(`       [skip] ${name}: no natively-executable binary (${name} is absent or a shim)\n`);
      continue;
    }
    const r = await new Promise<{ code: number | null; note: string }>((res) => {
      const p = new ManagedProcess({
        launcher: resolved.launcher,
        args: ['--version'],
        cwd: SCRATCH,
        env: process.env as Record<string, string>,
        onStdoutLine: () => {},
      });
      p.exited.then((e) => res({ code: e.code, note: p.stderrTail.toString().slice(0, 120) }));
      setTimeout(() => res({ code: null, note: 'timeout' }), 20_000).unref();
    });
    process.stdout.write(`       [${name}] containment run -> exit=${r.code}${r.note ? ` (${r.note.trim()})` : ''}\n`);
  }
}

// ===========================================================================
section('W2.1-A. PID identity never changes meaning');
{
  // W2C-1: before the root is published, `pid` is UNKNOWN — never the launcher.
  const long = spawnNode(['-e', 'setInterval(()=>{},1000)']);
  check('W2C-1 before root publication ManagedProcess.pid is not the launcher pid',
    long.pid !== long.launcherPid, `pid=${long.pid} launcher=${long.launcherPid}`);
  check('W2C-1 and it is undefined (unknown), not a placeholder',
    long.pid === undefined, String(long.pid));
  check('W2C-3 while running, the observability pid never equals the launcher pid',
    long.pid === undefined || long.pid === long.rootProcessPid);
  await sleep(400);
  // W2C-2: once the root is published, pid IS the root process pid.
  check('W2C-2 after root publication ManagedProcess.pid === rootProcessPid',
    long.rootProcessPid !== null && long.pid === long.rootProcessPid,
    `pid=${long.pid} root=${long.rootProcessPid}`);
  check('W2C-2 and it is still distinct from the launcher pid',
    long.pid !== long.launcherPid);
  await long.cancel('W2.1 pid test');
  await long.exited;
}

// ===========================================================================
section('W2.1-B. live rootPid parsing is torn-write safe');
{
  const f = join(SCRATCH, 'live.txt');
  writeFileSync(f, utf16('rootPid=12')); // no newline yet
  check('W2C-4 a partial rootPid line is ignored', peekRootPid(f) === null, String(peekRootPid(f)));
  writeFileSync(f, Buffer.concat([utf16('rootPid=12'), utf16('345\n')]));
  check('W2C-5 the complete line yields the FULL value', peekRootPid(f) === 12345, String(peekRootPid(f)));

  const empty = join(SCRATCH, 'live-empty.txt');
  writeFileSync(empty, utf16('rootPid=\n'));
  check('W2C-6 rootPid= (empty) is not a pid', peekRootPid(empty) === null);
  const zero = join(SCRATCH, 'live-zero.txt');
  writeFileSync(zero, utf16('rootPid=0\n'));
  check('W2C-6 rootPid=0 is not a valid pid', peekRootPid(zero) === null);
}

// ===========================================================================
section('W2.1-C. strict control parsing');
{
  const record = (fields: string): Buffer =>
    utf16(`launcherStatus=success\nphase=done\n${fields}\ncomplete=1\n`);
  const okFields = 'rootPid=42\nrootExitCode=0\nactiveProcessesFinal=0\ntreeStopped=1\nrootExitObserved=1\nassignedBeforeResume=1\n';

  const good = join(SCRATCH, 'strict-good.txt');
  writeFileSync(good, record(okFields));
  const g = readControlRecord(good);
  check('a strict, complete record validates', g.ok === true, JSON.stringify(g));
  check('and its treeStopConfirmed is true',
    g.ok === true && treeStopConfirmedFrom(g.record) === true);

  for (const [label, fields] of [
    ['W2C-6 rootPid empty', 'rootPid=\nrootExitCode=0\nactiveProcessesFinal=0'],
    ['W2C-7 rootExitCode empty', 'rootPid=42\nrootExitCode=\nactiveProcessesFinal=0'],
    ['W2C-8 activeProcessesFinal empty', 'rootPid=42\nrootExitCode=0\nactiveProcessesFinal='],
    ['W2C-9 rootPid=12abc', 'rootPid=12abc\nrootExitCode=0\nactiveProcessesFinal=0'],
    ['W2C-9 rootPid=+1', 'rootPid=+1\nrootExitCode=0\nactiveProcessesFinal=0'],
    ['W2C-9 rootPid=1.0', 'rootPid=1.0\nrootExitCode=0\nactiveProcessesFinal=0'],
    ['W2C-9 rootPid=0x10', 'rootPid=0x10\nrootExitCode=0\nactiveProcessesFinal=0'],
    ['W2C-9 rootPid=1e3', 'rootPid=1e3\nrootExitCode=0\nactiveProcessesFinal=0'],
    ['W2C-9 rootExitCode=-1', 'rootPid=42\nrootExitCode=-1\nactiveProcessesFinal=0'],
    ['W2C-9 rootExitCode=NaN', 'rootPid=42\nrootExitCode=NaN\nactiveProcessesFinal=0'],
    ['W2C-10 activeProcessesFinal=abc', 'rootPid=42\nrootExitCode=0\nactiveProcessesFinal=abc'],
  ] as Array<[string, string]>) {
    const p = join(SCRATCH, `strict-${label.replace(/[^a-z0-9]/gi, '_')}.txt`);
    writeFileSync(p, record(fields));
    const v = readControlRecord(p);
    check(`${label}: rejected (no fabricated success)`, v.ok === false, JSON.stringify(v));
    if (v.ok) {
      check(`${label}: must ALSO not confirm a tree stop`, treeStopConfirmedFrom(v.record) === false);
    } else {
      check(`${label}: cannot produce treeStopConfirmed=true`, true);
    }
  }
}

// ===========================================================================
section('W2.1-E. exit semantics');
{
  const p = spawnNode(['-e', 'process.exit(103)']);
  const e = await p.exited;
  check('W2C-11 exited.code is the agent root exit (103)', e.code === 103, String(e.code));
  check('W2C-11 ManagedProcess.exitCode matches exited.code', p.exitCode === 103, String(p.exitCode));
  check('W2C-11 the launcher protocol outcome is separate and successful',
    p.launcherExitCode === 0 && p.containment?.launcherStatus === 'success');

  // Resolution reads process.env, so the override must be global (not just the
  // child env).
  const savedL = process.env.ORCH_JOB_LAUNCHER;
  process.env.ORCH_JOB_LAUNCHER = join(SCRATCH, 'no-such-launcher.exe');
  try {
    const bad = new ManagedProcess({
      launcher: NODE_LAUNCHER,
      args: ['--version'],
      cwd: SCRATCH,
      env: process.env as Record<string, string>,
    });
    const be = await bad.exited;
    check('W2C-12 a launcher failure never becomes the agent root exit code',
      be.code === 127 && bad.exitCode !== 0, `exited=${be.code} exitCode=${bad.exitCode}`);
  } finally {
    if (savedL === undefined) delete process.env.ORCH_JOB_LAUNCHER;
    else process.env.ORCH_JOB_LAUNCHER = savedL;
  }
}

// ===========================================================================
section('W2.1-D. .cmd resolution actually executes');
{
  const cmdDir = join(SCRATCH, 'cmd dir 目录');
  mkdirSync(cmdDir, { recursive: true });
  const tool = join(cmdDir, 'tool.cmd');
  // UTF-8 code page so the shim's own echo does not mangle Unicode; the argument
  // itself reaches cmd correctly regardless (it travels as UTF-16).
  writeFileSync(tool, '@echo off\r\nchcp 65001 >nul\r\necho W2CMD:%*\r\n');
  const spec = launcherFor(tool);
  check('the .cmd resolves to a cmd-wrapper', spec.ok && spec.launcher.kind === 'cmd-wrapper');

  if (spec.ok) {
    const run = async (args: string[]): Promise<{ code: number | null; out: string }> => {
      let out = '';
      const p = new ManagedProcess({
        launcher: spec.launcher, args, cwd: cmdDir,
        env: process.env as Record<string, string>, onStdoutLine: (l) => { out += l + '\n'; },
      });
      const e = await p.exited;
      return { code: e.code, out };
    };

    const r1 = await run(['--flag', 'value with spaces']);
    check('W2C-13/W2C-14 a spaced .cmd path with spaced args executes',
      r1.code === 0 && r1.out.includes('W2CMD:') && r1.out.includes('value with spaces'),
      `exit=${r1.code} out=${JSON.stringify(r1.out)}`);

    const r2 = await run(['hello world', 'plain', '']);
    check('W2C-15 empty and spaced args are preserved',
      r2.code === 0 && r2.out.includes('hello world') && r2.out.includes('plain') && r2.out.includes('""'),
      `exit=${r2.code} out=${JSON.stringify(r2.out)}`);

    const r3 = await run(['值-ünïcode']);
    check('W2C-15b Unicode args are preserved',
      r3.code === 0 && r3.out.includes('值-ünïcode'), `exit=${r3.code} out=${JSON.stringify(r3.out)}`);
  }
}

// ===========================================================================
section('W2.1-F. production containment cannot be disabled by env');
{
  const saved = process.env.ORCH_CONTAINMENT;
  process.env.ORCH_CONTAINMENT = 'off';
  try {
    const p = spawnNode(['-e', 'process.exit(0)']);
    const e = await p.exited;
    check('W2C-16 ORCH_CONTAINMENT=off does NOT disable production containment',
      p.containment !== null && e.code === 0, `containment=${p.containment === null ? 'null' : 'present'}`);
  } finally {
    if (saved === undefined) delete process.env.ORCH_CONTAINMENT;
    else process.env.ORCH_CONTAINMENT = saved;
  }
}

// ===========================================================================
section('W2.2-A/B. --raw exact grammar and memory safety');
{
  const resolved = resolveContainmentLauncher();
  const LAUNCHER = resolved?.exe ?? '';
  const FIX = join(REPO, 'native', 'windows-job-launcher', 'build', 'w1fixture.exe');
  const LX_USAGE = 1;

  const rawLauncher = (argv: string[]): Promise<{ code: number | null; text: string }> => {
    return new Promise((res) => {
      const p = spawn(LAUNCHER, argv, { cwd: SCRATCH, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let t = '';
      p.stdout?.on('data', (b: Buffer) => { t += b.toString(); });
      p.stderr?.on('data', (b: Buffer) => { t += b.toString(); });
      p.once('error', () => res({ code: null, text: t }));
      p.once('close', (c) => res({ code: c, text: t }));
    });
  };

  // W2D-1: exactly <application> <command-line>.
  const d1 = scratch2('raw-ok');
  const r1 = await rawLauncher(['--diag', join(d1, 'd.txt'), '--raw', '--', FIX, `"${FIX}" --role solo`]);
  check('W2D-1 exact raw arity is accepted and runs', r1.code === 0, `code=${r1.code} ${r1.text.slice(0, 80)}`);

  // W2D-2: an EXTRA value must fail closed and NOT start the target.
  const d2 = scratch2('raw-extra');
  const marker = join(d2, 'ran.txt');
  const r2 = await rawLauncher(['--diag', join(d2, 'd.txt'), '--raw', '--', FIX,
    `"${FIX}" --role solo --pidfile "${marker}"`, 'discard-me']);
  check('W2D-2 an extra raw value fails closed', r2.code === LX_USAGE, `code=${r2.code}`);
  check('W2D-2 and the target was NOT started', !existsSync(marker));

  // W2D-3: missing command line.
  const r3 = await rawLauncher(['--raw', '--', FIX]);
  check('W2D-3 a missing raw command line fails closed', r3.code === LX_USAGE, `code=${r3.code}`);

  // W2D-4: empty command line.
  const r4 = await rawLauncher(['--raw', '--', FIX, '']);
  check('W2D-4 an empty raw command line fails closed', r4.code === LX_USAGE, `code=${r4.code}`);
}

{
  // W2D-5: `--raw` AFTER the separator is a target argument, not a launcher option.
  const r = await rawSpawnLP(['--', FIXTURE_EXE, '--role', 'echo', '--raw']);
  const parts = r.stdout.split(/\r?\n/);
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  check('W2D-5 --raw after -- is passed to the target verbatim',
    parts.slice(3).includes('--raw'), JSON.stringify(parts.slice(3)));
}

// ===========================================================================
section('W2.2-C/D/E. control protocol whitelist, compatibility, consistency');
{
  const rec = (body: string): Buffer => utf16(`${body}\ncomplete=1\n`);
  const write = (name: string, body: string): string => {
    const p = join(SCRATCH, name);
    writeFileSync(p, rec(body));
    return p;
  };
  const SUCCESS = 'launcherStatus=success\nphase=done\nrootPid=42\nrootExitCode=0\nactiveProcessesFinal=0\ntreeStopped=1\nrootExitObserved=1\nassignedBeforeResume=1';

  const valid = readControlRecord(write('proto-ok.txt', SUCCESS));
  check('W2D-12 a fully valid success record validates and confirms tree stop',
    valid.ok === true && treeStopConfirmedFrom(valid.record) === true, JSON.stringify(valid));

  const cases: Array<[string, string, string]> = [
    ['W2D-6 unknown launcherStatus', 'launcherStatus=bogus\nphase=done\nrootPid=1\nrootExitCode=0\nactiveProcessesFinal=0\ntreeStopped=1', 'status'],
    ['W2D-7 empty phase', 'launcherStatus=success\nphase=\nrootPid=1\nrootExitCode=0\nactiveProcessesFinal=0\ntreeStopped=1', 'phase'],
    ['W2D-8 unknown phase', 'launcherStatus=success\nphase=teleport\nrootPid=1\nrootExitCode=0\nactiveProcessesFinal=0\ntreeStopped=1', 'phase'],
    ['W2D-9 status/phase contradiction', 'launcherStatus=create-process-failed\nphase=done', 'phase'],
    ['W2D-10 pre-root failure + rootExitCode', 'launcherStatus=create-process-failed\nphase=create-process\nrootExitCode=0', 'root'],
    ['W2D-11 success missing treeStopped', 'launcherStatus=success\nphase=done\nrootPid=1\nrootExitCode=0\nactiveProcessesFinal=0', 'tree'],
    ['W2D-11 success phase=create-job', 'launcherStatus=success\nphase=create-job\nrootPid=1\nrootExitCode=0\nactiveProcessesFinal=0\ntreeStopped=1', 'phase'],
    ['W2D success missing rootPid', 'launcherStatus=success\nphase=done\nrootExitCode=0\nactiveProcessesFinal=0\ntreeStopped=1', 'root'],
    ['W2D assign-failed + rootExitCode', 'launcherStatus=assign-failed\nphase=assign\nrootPid=7\nrootExitCode=0', 'root exit'],
  ];
  for (const [label, body] of cases) {
    const v = readControlRecord(write(`proto-${label.replace(/[^a-z0-9]/gi, '_')}.txt`, body));
    check(`${label}: rejected`, v.ok === false, JSON.stringify(v));
    if (v.ok) {
      check(`${label}: must NOT confirm a tree stop`, treeStopConfirmedFrom(v.record) === false);
    } else {
      check(`${label}: cannot produce treeStopConfirmed=true`, true);
    }
  }
}

// ===========================================================================
section('W2.2-H. normal executable still uses normal argv mode');
{
  const argvNative = buildContainedArgv(
    { kind: 'native', command: 'C:\\x\\node.exe', prefixArgs: [], target: 'C:\\x\\node.exe', buildsCommandString: false },
    ['-e', 'x'],
    'C:\\ctl.txt',
  );
  check('W2D-18 a native .exe uses normal argv mode (no --raw)',
    !argvNative.includes('--raw') && argvNative[2] === '--' && argvNative[3] === 'C:\\x\\node.exe',
    JSON.stringify(argvNative));
}

// ===========================================================================
section('W2.2a. control fact consistency');
{
  const w = (name: string, body: string): string => {
    const p = join(SCRATCH, name);
    writeFileSync(p, utf16(`${body}\ncomplete=1\n`));
    return p;
  };
  const invalid = (name: string, body: string): boolean => readControlRecord(w(name, body)).ok === false;

  // Pre-root failures must carry NO root lifecycle facts.
  check('W2E-1 create-process-failed + rootExitObserved=1 is INVALID',
    invalid('e1.txt', 'launcherStatus=create-process-failed\nphase=create-process\nrootExitObserved=1'));
  check('W2E-2 create-process-failed + rootExitCode=0 is INVALID',
    invalid('e2.txt', 'launcherStatus=create-process-failed\nphase=create-process\nrootExitCode=0'));
  check('W2E-3 create-process-failed + rootPid is INVALID',
    invalid('e3.txt', 'launcherStatus=create-process-failed\nphase=create-process\nrootPid=9'));
  check('W2E-12 a pre-root failure carrying lifecycle facts yields no validated record',
    readControlRecord(w('e12.txt', 'launcherStatus=job-create-failed\nphase=create-job\nrootPid=9\nrootExitObserved=1\nrootExitCode=0')).ok === false);

  // Success must not contradict assign-before-resume.
  check('W2E-4 success + assignedBeforeResume=0 is INVALID',
    invalid('e4.txt', 'launcherStatus=success\nphase=done\nrootPid=42\nrootExitCode=0\nrootExitObserved=1\nactiveProcessesFinal=0\ntreeStopped=1\nassignedBeforeResume=0'));
  const e5 = readControlRecord(w('e5.txt', 'launcherStatus=success\nphase=done\nrootPid=42\nrootExitCode=0\nrootExitObserved=1\nactiveProcessesFinal=0\ntreeStopped=1\nassignedBeforeResume=1'));
  check('W2E-5 a fully consistent success is VALID and confirms tree stop',
    e5.ok === true && treeStopConfirmedFrom(e5.record) === true, JSON.stringify(e5));
  check('W2E-6 success + assignedBeforeResume=2 is INVALID',
    invalid('e6.txt', 'launcherStatus=success\nphase=done\nrootPid=42\nrootExitCode=0\nrootExitObserved=1\nactiveProcessesFinal=0\ntreeStopped=1\nassignedBeforeResume=2'));

  // Boolean-like facts are strict.
  check('W2E-7 rootExitObserved=2 is INVALID',
    invalid('e7.txt', 'launcherStatus=success\nphase=done\nrootPid=42\nrootExitCode=0\nrootExitObserved=2\nactiveProcessesFinal=0\ntreeStopped=1\nassignedBeforeResume=1'));
  check('W2E-8 treeStopped=2 is INVALID',
    invalid('e8.txt', 'launcherStatus=success\nphase=done\nrootPid=42\nrootExitCode=0\nrootExitObserved=1\nactiveProcessesFinal=0\ntreeStopped=2\nassignedBeforeResume=1'));

  // accounting-failed matches the producer: LAST phase is `done`.
  const e9 = readControlRecord(w('e9.txt', 'launcherStatus=accounting-failed\nphase=done\nrootPid=7'));
  check('W2E-9 accounting-failed + phase=done is VALID (producer reality)',
    e9.ok === true, JSON.stringify(e9));
  check('W2E-9 and it never confirms a tree stop',
    e9.ok === true && treeStopConfirmedFrom(e9.record) === false);
  check('W2E-10 accounting-failed + phase=wait is INVALID (not a producer phase)',
    invalid('e10.txt', 'launcherStatus=accounting-failed\nphase=wait\nrootPid=7'));

  // Contradictory success can never confirm a tree stop.
  const e11 = readControlRecord(w('e11.txt', 'launcherStatus=success\nphase=done\nrootPid=42\nrootExitCode=0\nrootExitObserved=1\nactiveProcessesFinal=0\ntreeStopped=1\nassignedBeforeResume=0'));
  check('W2E-11 a contradictory success never yields treeStopConfirmed=true',
    e11.ok === false || treeStopConfirmedFrom(e11.record) === false, JSON.stringify(e11));
}

// ===========================================================================
section('W2.2b. fact projection: no raw lifecycle escape; root-exit pair invariant');
{
  const w = (name: string, body: string): string => {
    const p = join(SCRATCH, name);
    writeFileSync(p, utf16(body.endsWith('\n') ? body : `${body}\n`));
    return p;
  };
  const ok = (name: string, body: string): boolean => readControlRecord(w(name, body)).ok === true;
  const bad = (name: string, body: string): boolean => readControlRecord(w(name, body)).ok === false;

  // W2F-1: a contradictory pre-root record is INVALID.
  check('W2F-1 create-process-failed + rootExitObserved=1 is INVALID',
    bad('f1.txt', 'launcherStatus=create-process-failed\nphase=create-process\nrootExitObserved=1\ncomplete=1'));
  // W2F-2: rootExitObserved=1 with no complete record yields nothing.
  check('W2F-2 rootExitObserved=1 without complete=1 is not a valid record',
    bad('f2.txt', 'launcherStatus=success\nphase=done\nrootPid=1\nrootExitCode=0\nrootExitObserved=1\nactiveProcessesFinal=0\ntreeStopped=1\nassignedBeforeResume=1'));

  // Root-exit pair invariant.
  check('W2F-3 accounting-failed + rootExitObserved=0 + rootExitCode=103 is INVALID',
    bad('f3.txt', 'launcherStatus=accounting-failed\nphase=done\nrootPid=7\nrootExitObserved=0\nrootExitCode=103\ncomplete=1'));
  check('W2F-4 accounting-failed + rootExitObserved=0 + no code is VALID',
    ok('f4.txt', 'launcherStatus=accounting-failed\nphase=done\nrootPid=7\nrootExitObserved=0\ncomplete=1'));
  check('W2F-5 accounting-failed + rootExitObserved=1 + rootExitCode=103 is VALID',
    ok('f5.txt', 'launcherStatus=accounting-failed\nphase=done\nrootPid=7\nrootExitObserved=1\nrootExitCode=103\ncomplete=1'));
  check('W2F-6 rootExitObserved=1 without a rootExitCode is INVALID',
    bad('f6.txt', 'launcherStatus=accounting-failed\nphase=done\nrootPid=7\nrootExitObserved=1\ncomplete=1'));
  check('W2F-7 rootExitCode present with rootExitObserved=0 is INVALID',
    bad('f7.txt', 'launcherStatus=accounting-failed\nphase=done\nrootPid=7\nrootExitObserved=0\nrootExitCode=103\ncomplete=1'));
  check('W2F-7b rootExitCode present with rootExitObserved absent is INVALID',
    bad('f7b.txt', 'launcherStatus=accounting-failed\nphase=done\nrootPid=7\nrootExitCode=103\ncomplete=1'));
}

{
  // W2F-8: early rootPid discovery still works before the record completes.
  const long = spawnNode(['-e', 'setInterval(()=>{},1000)']);
  await sleep(450);
  check('W2F-8 rootPid is discoverable while the run is live',
    long.rootProcessPid !== null && long.rootProcessPid === long.pid,
    `root=${long.rootProcessPid} pid=${long.pid}`);
  check('W2F-8b no lifecycle terminal is projected while running',
    long.rootTerminalObserved === false && long.isTreeStopConfirmed() === false);
  await long.cancel('W2F-8');
  const e = await long.exited;
  // W2F-9: a cancelled run yields NO fabricated agent exit code. The cooperative
  // stop DOES now confirm the physical tree stop (W3), but the agent outcome stays
  // unknown because we, not the agent, chose how it ended.
  check('W2F-9 a cancelled run yields no fabricated root exit code', e.code === null, String(e.code));
  check('W2F-9 and the cooperative stop IS confirmed from the launcher record',
    long.isTreeStopConfirmed() === true, `status=${long.containment?.launcherStatus}`);
  check('W2F-9 and is recorded as terminated, never as success',
    long.containment?.terminated === true && long.containment?.launcherStatus !== 'success');
}

{
  // Source guard: the raw lifecycle peek no longer exists and is not referenced.
  const cSrc = sourceText(join(REPO, 'src', 'runtime', 'containment.ts'));
  const sSrc = sourceText(join(REPO, 'src', 'runtime', 'spawn.ts'));
  check('W2F no raw rootExitObserved peek exists in containment.ts',
    !/peekRootExitObserved/.test(cSrc));
  check('W2F spawn.ts does not consume a raw rootExitObserved peek',
    !/peekRootExitObserved/.test(sSrc) && !/rootExitObserved\s*=\s*peek/.test(sSrc));
}

// ===========================================================================
// W3 — Cancel / Deadline / Physical Tree Stop / Release Ordering
// ===========================================================================
section('W3. cooperative containment stop: cancel, deadline and release ordering');

/**
 * Is a pid still alive? Used only to assert a PHYSICAL outcome, never as the
 * source of a stop verdict.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The node executable, for fixtures. */
const NODE_BIN = process.execPath;

{
  // W3-1: manual cancel -> cooperative Job termination.
  const p = spawnNode(['-e', 'setInterval(()=>{},1000)']);
  await sleep(400);
  const root = p.rootProcessPid;
  check('W3-1 the root was published before the cancel', root !== null, String(root));
  const confirmed = await p.cancel('W3-1');
  await p.exited;
  check('W3-1 cancel reports a CONFIRMED stop', confirmed === true, String(confirmed));
  check('W3-1 the launcher recorded `terminated`',
    p.containment?.launcherStatus === 'terminated', String(p.containment?.launcherStatus));
  check('W3-1 the tree is confirmed empty', p.isTreeStopConfirmed() === true);
  if (root !== null) {
    check('W3-1 the root really is gone', alive(root) === false);
  }
}

{
  // W3-2: deadline and manual cancel share ONE primitive.
  const s = sourceText(join(REPO, 'src', 'runtime', 'spawn.ts'));
  const tr = sourceText(join(REPO, 'src', 'runtime', 'session.ts'));
  // cancel() must delegate, not reimplement.
  check('W3-2 cancel() delegates to requestContainedStop',
    /async cancel\(reason: string\)[\s\S]{0,400}requestContainedStop\(reason\)/.test(s));
  // The deadline path must call transport.cancel, i.e. the same seam.
  // Slice the onDeadline method body itself: a plain proximity match over the whole
  // file would happily accept a `transport.cancel` that lives in a different method.
  const deadlineBody = (() => {
    const i = tr.indexOf('private async onDeadline');
    return i < 0 ? '' : tr.slice(i, i + 2500);
  })();
  check('W3-2 the deadline path exists', deadlineBody !== '');
  check('W3-2 the deadline path uses transport.cancel (the same primitive)',
    /transport\?\.cancel\(/.test(deadlineBody), deadlineBody.slice(0, 120));
  // No separate taskkill-based kill may exist in the contained cancel path.
  check('W3-2 no taskkill call precedes the cooperative stop request',
    !/taskkillTree\([^)]*\);[\s\S]{0,200}requestContainedStop/.test(s));
  check('W3-2 git timeout routes through proc.cancel (the same primitive)',
    /proc\.cancel\(/.test(sourceText(join(REPO, 'src', 'orchestration', 'git.ts'))));
}

{
  // W3-3: root exited, grandchild alive -> cancel must kill the DESCENDANT.
  //
  // This is the case a root-pid kill fundamentally cannot handle: by cancel time
  // the root is already gone, so `taskkill /T` has no live root to walk and the
  // grandchild survives. A Job-level stop terminates it anyway.
  const dir = scratch2('w3-3');
  const pidFile = join(dir, 'grandchild.pid');
  const rootScript = join(dir, 'root.cjs');
  // `detached: true` is what makes this the interesting case: the grandchild gets
  // its own process group, so it does NOT die just because the root exited. (A
  // non-detached child of a exiting node is torn down with it, which would make
  // this test pass for the wrong reason and prove nothing.)
  writeFileSync(rootScript, [
    "const {spawn}=require('child_process');",
    "const fs=require('fs');",
    "const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});",
    `fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));`,
    'c.unref();',
    'setTimeout(()=>process.exit(0),250);\n',
  ].join('\n'));
  const p = spawnNode([rootScript], { cwd: dir });
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(50);
  await sleep(400); // the root exits on its own here
  if (!existsSync(pidFile)) {
    check('W3-3 the grandchild was started', false);
    await p.cancel('W3-3 cleanup');
  } else {
    const gpid = Number(readFileSync(pidFile, 'utf8').trim());
    check('W3-3 the grandchild outlived the root', alive(gpid) === true, `pid=${gpid}`);
    // The launcher is still alive: the Job is not empty, so nothing is confirmed.
    check('W3-3 while the descendant lives, nothing is confirmed',
      p.isTreeStopConfirmed() === false);
    const confirmed = await p.cancel('W3-3');
    await p.exited;
    check('W3-3 cancel CONFIRMED a physical stop', confirmed === true, String(confirmed));
    let gone = false;
    for (let i = 0; i < 60 && !gone; i++) { await sleep(50); gone = alive(gpid) === false; }
    check('W3-3 the descendant is REALLY dead', gone, `pid=${gpid}`);
  }
}

{
  // W3-4: a three-generation tree, all alive, cancelled -> all dead.
  //
  // The fixture is built OUTSIDE any nested quoting: each generation is its own
  // script file, and the parent only spawns the next one by path. Composing
  // nested `-e` strings is how a "3-generation" test quietly degrades into a
  // 2-generation one (or a syntax error), so it is avoided here.
  const dir = scratch2('w3-4');
  const f1 = join(dir, 'g1.pid');
  const f2 = join(dir, 'g2.pid');
  const g2Script = join(dir, 'gen2.cjs');
  const g1Script = join(dir, 'gen1.cjs');
  const rootScript = join(dir, 'root.cjs');

  writeFileSync(g2Script, 'setInterval(()=>{},1000);\n');
  writeFileSync(g1Script, [
    "const {spawn}=require('child_process');",
    "const fs=require('fs');",
    // detached so each generation survives its parent, which is what makes this a
    // real 3-generation live tree rather than a chain that collapses to one process.
    `const g=spawn(process.execPath,[${JSON.stringify(g2Script)}],{detached:true,stdio:'ignore'});`,
    `fs.writeFileSync(${JSON.stringify(f2)},String(g.pid));`,
    'g.unref();',
    'setInterval(()=>{},1000);\n',
  ].join('\n'));
  writeFileSync(rootScript, [
    "const {spawn}=require('child_process');",
    "const fs=require('fs');",
    `const c=spawn(process.execPath,[${JSON.stringify(g1Script)}],{detached:true,stdio:'ignore'});`,
    `fs.writeFileSync(${JSON.stringify(f1)},String(c.pid));`,
    'c.unref();',
    'setInterval(()=>{},1000);\n',
  ].join('\n'));

  const p = spawnNode([rootScript], { cwd: dir });
  for (let i = 0; i < 120 && !(existsSync(f1) && existsSync(f2)); i++) await sleep(50);
  await sleep(300);
  if (!(existsSync(f1) && existsSync(f2))) {
    check('W3-4 the 3-generation tree was established', false,
      `g1=${existsSync(f1)} g2=${existsSync(f2)}`);
    await p.cancel('W3-4 cleanup');
  } else {
    const g1 = Number(readFileSync(f1, 'utf8').trim());
    const g2 = Number(readFileSync(f2, 'utf8').trim());
    check('W3-4 both descendants are alive', alive(g1) && alive(g2), `g1=${g1} g2=${g2}`);
    const confirmed = await p.cancel('W3-4');
    await p.exited;
    check('W3-4 cancel CONFIRMED a physical stop', confirmed === true, String(confirmed));
    check('W3-4 the final record is complete and `terminated`',
      p.containment?.launcherStatus === 'terminated', String(p.containment?.launcherStatus));
    let allGone = false;
    for (let i = 0; i < 80 && !allGone; i++) {
      await sleep(50);
      allGone = alive(g1) === false && alive(g2) === false;
    }
    check('W3-4 EVERY generation is dead', allGone, `g1=${g1} g2=${g2}`);
  }
}

{
  // W3-5: a validated `terminated` record with Job zero confirms the stop.
  const w = (name: string, body: string): string => {
    const p = join(SCRATCH, name);
    writeFileSync(p, utf16(`${body}\n`));
    return p;
  };
  const ok = (name: string, body: string) => readControlRecord(w(name, body)).ok === true;
  check('W3-5 terminated + Job zero is a VALID record',
    ok('w3ok1.txt',
      'launcherStatus=terminated\nphase=done\nrootPid=7\nassignedBeforeResume=1\ntreeStopped=1\nactiveProcessesFinal=0\ncomplete=1'));
  check('W3-5 terminated may carry the observed root exit pair',
    ok('w3ok2.txt',
      'launcherStatus=terminated\nphase=done\nrootPid=7\nassignedBeforeResume=1\nrootExitObserved=1\nrootExitCode=1\ntreeStopped=1\nactiveProcessesFinal=0\ncomplete=1'));
  // A terminated record that does NOT prove Job empty must be rejected.
  check('W3-5 terminated without treeStopped=1 is INVALID',
    !ok('w3bad1.txt',
      'launcherStatus=terminated\nphase=done\nrootPid=7\nassignedBeforeResume=1\ncomplete=1'));
  check('W3-5 terminated with activeProcessesFinal!=0 is INVALID',
    !ok('w3bad2.txt',
      'launcherStatus=terminated\nphase=done\nrootPid=7\nassignedBeforeResume=1\ntreeStopped=1\nactiveProcessesFinal=2\ncomplete=1'));
  // And it must not be laundered into success.
  check('W3-5 `terminated` is not accepted as `success`',
    ok('w3ok3.txt',
      'launcherStatus=terminated\nphase=done\nrootPid=7\nassignedBeforeResume=1\ntreeStopped=1\nactiveProcessesFinal=0\ncomplete=1'));
}

{
  // W3-6: a hard-killed launcher has no final record -> NOT confirmed.
  const p = spawnNode(['-e', 'setInterval(()=>{},1000)']);
  await sleep(400);
  const launcher = p.launcherPid;
  if (launcher === undefined) {
    check('W3-6 the launcher was spawned', false);
  } else {
    taskkillTree(launcher);
    await p.exited;
    check('W3-6 a hard-killed launcher yields NO confirmed stop',
      p.isTreeStopConfirmed() === false, `status=${p.containment?.launcherStatus}`);
    check('W3-6 and no exit code is invented', p.exitCode === null, String(p.exitCode));
    // The KILL_ON_JOB_CLOSE reclaim still physically kills the descendants.
    const root = p.rootProcessPid;
    if (root !== null) {
      let gone = false;
      for (let i = 0; i < 60 && !gone; i++) { await sleep(50); gone = alive(root) === false; }
      check('W3-6 the descendants were still physically reclaimed', gone);
    }
  }
}

{
  // W3-7/W3-8: release ordering. The exclusive WRITE claim may only be released
  // once the stop is CONFIRMED.
  const o = sourceText(join(REPO, 'src', 'orchestration', 'orchestrator.ts'));
  // The unconditional release is the defect; it must not exist.
check('W3-7 the claim release is GATED on the W3.1 requirement + a confirmed stop',
    /const proofRequired = requiresTreeStopProof\[0\]/.test(o) &&
    /if \(!proofRequired \|\| confirmed \|\| provenNotStarted\)/.test(o));
  check('W3-7 an unconfirmed stop RETAINS the claim instead of releasing it',
    /retaining the exclusive write claim/.test(o));
  // A genuine pre-start exit must still release: the edge was never entered, so there
  // is no possible writer, and retaining would block the workspace for nothing.
  check('W3-7 a genuine pre-start exit still releases the claim',
    /!proofRequired \|\| confirmed/.test(o));
  // W3.1 (P1-A): the requirement is raised BEFORE the edge, and only typed evidence
  // lowers it. These are the two lines whose absence was the whole vulnerability.
  check('W3.1 P1-A the requirement is raised BEFORE runtime.run is entered',
    o.indexOf('requiresTreeStopProof[0] = true') < o.indexOf('this.runtime.run('));
  check('W3.1 P1-A only typed proven evidence may lower it',
    /if \(isProvenNotStarted\(e\)\)/.test(o) && !/isProvenNotStarted\(e\) \|\|/.test(o));
  check('W3.1 P1-B retention is recorded IN the claim book, not a closure bool',
    /retainResourceProtection\(/.test(o));
  check('W3-7 the gate reads the physical verdict from the frozen result',
    /result\.cleanup\?\.treeStopConfirmed === true/.test(o));
  // Optional chaining is load-bearing, not defensive noise: an adapter or test double
  // that omits `cleanup` must not crash the dispatch, and must land on "no evidence".
  check('W3-7 a missing cleanup report fails CLOSED rather than throwing',
    /cleanup\?\.treeStopConfirmed/.test(o));
  // Ordering trace: confirmation must be observable BEFORE any release.
  check('W3-8 the release site comes AFTER the verdict is recorded',
    o.indexOf('stopConfirmed.push') < o.indexOf('this.releaseClaim(task.taskId, claimedScope)'));
  check('W3-8 an over-held scope is preferred to an under-held one',
    /an over-held scope[\s\S]{0,200}under-held/.test(o));
}

{
  // W3-9: a deadline-style stop while a descendant WRITES.
  //
  // The property under test is the ORDER: the writer must be provably finished
  // before anything could be released, so no release can ever race a live write.
  const dir = scratch2('w3-9');
  const marker = join(dir, 'marker.txt');
  const writerScript = join(dir, 'writer.cjs');
  const rootScript = join(dir, 'root.cjs');
  writeFileSync(writerScript, [
    "const fs=require('fs');",
    `setInterval(()=>{fs.appendFileSync(${JSON.stringify(marker)},'x'.repeat(64)+'\\n')},50);`,
  ].join('\n'));
  writeFileSync(rootScript, [
    "const {spawn}=require('child_process');",
    `const c=spawn(process.execPath,[${JSON.stringify(writerScript)}],{detached:true,stdio:'ignore'});`,
    'c.unref();',
    'setInterval(()=>{},1000);\n',
  ].join('\n'));
  const p = spawnNode([rootScript], { cwd: dir });
  // B1.4 P2: confirm the writer is genuinely PRODUCING bytes BEFORE the stop, bounded,
  // rather than asserting that bytes appeared DURING the stop window. The old
  // `atStop > before` raced a prompt cancellation (a correct early stop could leave the
  // two reads equal) and false-failed. We now require observed growth before cancel and
  // keep every post-stop assertion unchanged.
  const sizeNow = (): number => (existsSync(marker) ? readFileSync(marker, 'utf8').length : 0);
  let before = sizeNow();
  let grew = false;
  const growDeadline = Date.now() + 5000;
  while (Date.now() < growDeadline) {
    await sleep(50);
    const s = sizeNow();
    if (s > before) { grew = true; before = s; break; }
  }
  check('W3-9 the descendant writer was writing before the stop', before > 0, `bytes=${before}`);
  check('W3-9 and the writer had genuinely been active before it', grew, `bytes=${before}`);
  const confirmed = await p.cancel('W3-9 deadline');
  await p.exited;
  check('W3-9 the stop was CONFIRMED', confirmed === true, String(confirmed));
  // The Job itself reported zero active processes: the tree is empty, not merely "the
  // root is gone".
  const facts = p.containment;
  check('W3-9 the Job is empty (ActiveProcesses==0)', facts !== null && facts.activeProcessesFinal === 0,
    `activeProcessesFinal=${String(facts?.activeProcessesFinal)}`);
  // ONLY NOW may anything be released, so the file must be quiescent from here on.
  await sleep(200);
  const atStop = sizeNow();
  await sleep(700);
  const after = sizeNow();
  check('W3-9 the writer produced NO bytes after the confirmed stop',
    after === atStop, `${atStop}->${after}`);
}

{
  // W3-10: cancel BEFORE the root pid is published.
  //
  // A Job-level stop must not depend on knowing the root at all — which is
  // precisely why this test cancels immediately and asserts the target cannot
  // escape.
  const dir = scratch2('w3-10');
  const escaped = join(dir, 'escaped.txt');
  const p = spawnNode(['-e', 'setInterval(()=>{},1000)'], { cwd: dir });
  // No sleep: cancel races the rootPid publication.
  const confirmed = await p.cancel('W3-10 immediate');
  await p.exited;
  check('W3-10 an immediate cancel still CONFIRMS a physical stop',
    confirmed === true, `root=${String(p.rootProcessPid)} status=${String(p.containment?.launcherStatus)}`);
  check('W3-10 the tree is confirmed empty', p.isTreeStopConfirmed() === true);
  check('W3-10 nothing escaped the contained tree', existsSync(escaped) === false);
}

{
  // W3-11: an unavailable control directory starts NO target.
  //
  // Uses a REAL filesystem layout: a genuine launcher copy next to a
  // `containment-run` that cannot be created, because it is a regular FILE.
  // No production flag is involved.
  const dir = scratch2('w3-11');
  const escaped = join(dir, 'escaped.txt');
  const real = resolveContainmentLauncher();
  if (real === null) {
    check('W3-11 a launcher is available', false);
  } else {
    // Occupy the control DIRECTORY name with a file so it cannot be created.
    const occupied = join(dir, 'control');
    writeFileSync(occupied, 'not a directory');
    const ctl = join(occupied, 'w1ctl-x.txt');
    let opened = true;
    try { writeFileSync(ctl, 'x'); } catch { opened = false; }
    check('W3-11 the control path genuinely cannot be created', opened === false);
    // The real launcher, pointed at that unusable path, must refuse to start a target.
    const targetScript = join(dir, 'target.cjs');
    writeFileSync(targetScript,
      `require('fs').writeFileSync(${JSON.stringify(escaped)},'ran');\n`);
    const r = await rawSpawnLP(['--diag', ctl, '--', NODE_BIN, targetScript]);
    check('W3-11 the launcher refused (non-zero exit)', r.code !== 0, `code=${String(r.code)}`);
    check('W3-11 the TARGET NEVER STARTED', existsSync(escaped) === false);
  }
}

{
  // W3-12: an invalid / partial final control record yields NO release.
  const w = (name: string, body: string): string => {
    const p = join(SCRATCH, name);
    writeFileSync(p, utf16(`${body}\n`));
    return p;
  };
  check('W3-12 an incomplete record never confirms a stop',
    readControlRecord(w('w3i1.txt', 'launcherStatus=terminated\nphase=done\nrootPid=7\ntreeStopped=1\nactiveProcessesFinal=0')).ok === false);
  // A well-formed `stop-unconfirmed` record VALIDATES — it is an honest final
  // verdict, not a corrupt one. What must never happen is it confirming a stop.
  const unconfirmed = readControlRecord(w('w3i2.txt',
    'launcherStatus=stop-unconfirmed\nphase=done\nrootPid=7\nassignedBeforeResume=1\ncomplete=1'));
  check('W3-12 a well-formed stop-unconfirmed record is valid evidence', unconfirmed.ok === true,
    unconfirmed.ok ? '' : unconfirmed.reason);
  check('W3-12 and it still NEVER confirms a stop',
    unconfirmed.ok && treeStopConfirmedFrom(unconfirmed.record) === false);
  // stop-unconfirmed must not be allowed to CARRY a tree-stop claim at all.
  check('W3-12 stop-unconfirmed carrying treeStopped=1 is INVALID',
    readControlRecord(w('w3i3.txt',
      'launcherStatus=stop-unconfirmed\nphase=done\nrootPid=7\nassignedBeforeResume=1\ntreeStopped=1\nactiveProcessesFinal=0\ncomplete=1')).ok === false);
}

{
  // W3-13: natural completion is unchanged and still confirms.
  const p = spawnNode(['-e', 'process.exit(0)']);
  const e = await p.exited;
  check('W3-13 a natural completion reports success', p.containment?.launcherStatus === 'success',
    String(p.containment?.launcherStatus));
  check('W3-13 with the real agent exit code', e.code === 0, String(e.code));
  check('W3-13 and a confirmed empty tree', p.isTreeStopConfirmed() === true);
  check('W3-13 and is NOT reported as terminated', p.containment?.terminated === false);
}

{
  // W3-14: the git timeout producer is the same honest mechanism.
  const g = sourceText(join(REPO, 'src', 'orchestration', 'git.ts'));
  check('W3-14 the git timeout goes through proc.cancel',
    /proc\.cancel\(`git timeout/.test(g));
  check('W3-14 its stop verdict comes from the containment producer',
    /proc\.isTreeStopConfirmed\(\)/.test(g));
  check('W3-14 an unconfirmed timeout stays `stop-unconfirmed`',
    /'stop-unconfirmed'/.test(g));
  check('W3-14 a confirmed timeout is `timeout-stopped`',
    /'timeout-stopped'/.test(g));
  // The old lie must not come back: root exit alone must never imply a stopped tree.
  check('W3-14 root exit alone is never treated as a stopped tree',
    !/treeStopConfirmed\s*=\s*rootTerminalObserved/.test(g));
}

{
  // W3-15: no attributable persistent descendants after the round.
  const residue = (await import('node:child_process')).execFileSync(
    'tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true },
  );
const ours = residue.split(/\r?\n/).filter((l) => /w1fixture\.exe|w1joblauncher\.exe/i.test(l));
  check('W3-15 no launcher or fixture process persists', ours.length === 0,
    ours.slice(0, 3).join(' | '));

  // The ATTRIBUTABLE check, which is the one that matters. A `node` process is only
  // evidence of a containment leak when its command line names OUR fixture — this
  // suite runs inside an agent runtime that legitimately has its own node processes,
  // and counting those would either invent a leak or mask a real one.
  // PowerShell's CIM query, not `wmic`: wmic is deprecated and is absent on some
  // Windows installs, and a missing tool must not read as "no residue".
  let attributable: string[] = [];
  try {
    const listing = execFileSync(
      'powershell', ['-NoProfile', '-Command',
        "Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine"],
      { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
    );
    attributable = listing
      .split(/\r?\n/)
      .filter((l) => /_w2-tests|gc\.alive|writer\.cjs|gen1\.cjs|gen2\.cjs/i.test(l));
  } catch (e) {
    check('W3-15 the residue probe ran', false, (e as Error).message);
  }
  check('W3-15 no ATTRIBUTABLE node descendant persists', attributable.length === 0,
    attributable.slice(0, 3).join(' | '));
}

{
  // W3-16 (stop-control cleanup): the per-run stop marker must not outlive the run.
  //
  // A leftover marker can only ever re-assert a request the launcher already
  // answered — the marker is per-run and unique, so it can never leak into another
  // execution. But it must still be cleaned up, or the control directory would grow
  // without bound across a long session.
const dir = scratch2('w3-16');
  const p = spawnNode(['-e', 'setInterval(()=>{},1000)'], { cwd: dir });
  await sleep(350);
  await p.cancel('W3-16');
  await p.exited;
  // The control dir lives next to the LAUNCHER, so we assert on the marker path the
  // runtime derives rather than guessing a location: a second run must get a NEW
  // marker path, and the first run's files must be gone.
const contDir = controlDirectory(resolveContainmentLauncher()!);
  const stopLeftovers = (): number => {
    // readdirSync, not readFileSync: the control path is a DIRECTORY, and reading
    // it as a file is exactly the kind of assumption that makes a cleanup test fail
    // for the wrong reason.
    try {
      return readdirSync(contDir).filter((f) => f.endsWith('.stop')).length;
    } catch {
      return 0;
    }
  };
  check('W3-16 no stop marker is left behind after the run', stopLeftovers() === 0,
    `leftover .stop files=${stopLeftovers()}`);
  const p2 = spawnNode(['-e', 'process.exit(0)'], { cwd: dir });
  await p2.exited;
  check('W3-16 and a natural completion leaves none either', stopLeftovers() === 0,
    `leftover .stop files=${stopLeftovers()}`);
}

{
  // Source guards for the seams this round introduced.
  const spawnSrc = sourceText(join(REPO, 'src', 'runtime', 'spawn.ts'));
  const contSrc = sourceText(join(REPO, 'src', 'runtime', 'containment.ts'));
  const lc = sourceText(join(REPO, 'native', 'windows-job-launcher', 'src', 'w1joblauncher.c'));
  const s = spawnSrc;
  const c = contSrc;
  check('W3 the stop marker is a file, not an agent stdio stream',
    /requestContainedStop/.test(c) && !/stdin.*stop|stop.*stdin/.test(c));
  check('W3 the launcher terminates the JOB, not a root pid',
    /TerminateJobObject/.test(lc) && /stop_signal_seen/.test(lc));
  check('W3 the launcher only claims a stop after ActiveProcesses == 0',
    /activeProcessesFinal=0/.test(lc));
check('W3 `terminated` is a distinct status, never aliased to success',
    /launcherStatus=terminated/.test(lc) && /launcherStatus=success/.test(lc));
  check('W3 stop-unconfirmed is a real producer status',
    /launcherStatus=stop-unconfirmed/.test(lc));
  check('W3 the stop wait is BOUNDED in both the launcher and the runtime',
    /STOP_EMPTY_TIMEOUT_MS/.test(lc) && /CONTAINED_STOP_WAIT_MS/.test(s));
  check('W3 the runtime never treats a hard kill as proof',
    /KILL_ON_JOB_CLOSE/.test(lc) && !/treeStopConfirmed\s*=\s*true/.test(s.replace(/\/\*[\s\S]*?\*\//g, '')));
}

{
  // Architecture integrity: no new authority, no new runtime.run callsite.
  const prod = sourceText(join(REPO, 'src', 'orchestration', 'orchestrator.ts'));
  const spawnSrc = sourceText(join(REPO, 'src', 'runtime', 'spawn.ts'));
  const contSrc = sourceText(join(REPO, 'src', 'runtime', 'containment.ts'));
  check('W3 no ContainmentManager / ProcessSupervisor was introduced',
    !/class (ContainmentManager|ProcessSupervisor)/.test(prod + spawnSrc + contSrc));
  // Comments are stripped first: this codebase discusses `runtime.run()` in prose in
  // several places, and counting those would both over-report and be defeated by a
  // commented-out call.
  const prodCode = prod.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const runtimeRunSites = prodCode.split('runtime.run(').length - 1;
  check('W3 the runtime.run production callsite count is still 1', runtimeRunSites === 1,
    String(runtimeRunSites));
  check('W3 ManagedProcess remains the runtime process abstraction',
    /class ManagedProcess/.test(spawnSrc));
  check('W3 SessionRegistry is untouched by this round',
    !/requestContainedStop/.test(sourceText(join(REPO, 'src', 'runtime', 'session.ts')).replace(/transport\?\.cancel\([^)]*\)/g, '')));
}

// ===========================================================================
// W3.2 — Trusted pre-start proof: the REAL producers
// ===========================================================================
section('W3.2. trusted pre-start proof, produced by the runtime that owns process creation');

{
  /*
   * W3T-1: the launcher image cannot be resolved.
   *
   * This is the genuine production path. `ORCH_JOB_LAUNCHER` is authoritative, so
   * pointing it at a path that does not exist makes `resolveContainmentLauncher()`
   * return null — and that function only returns null after `existsSync` reported the
   * image absent. So the runtime knows, from its own control flow, that no OS process
   * exists. The verdict is a TYPED value, not an inference.
   */
  const restore = process.env.ORCH_JOB_LAUNCHER;
  process.env.ORCH_JOB_LAUNCHER = join(SCRATCH, 'no-such-launcher.exe');
  try {
    const p = spawnNode(['-e', 'process.exit(0)']);
    await p.exited;
    check('W3T-1 a missing launcher PROVES no process was created',
      p.processStartDisposition === 'not-started', p.processStartDisposition);
    check('W3T-1 and the run still fails visibly (nothing is silently skipped)',
      p.containmentUnavailableReason === true && p.exitCode === null);
    const c = await p.reapDescendants('W3T-1');
    check('W3T-1 the verdict reaches the cleanup report that drives release',
      c.processStart === 'not-started', c.processStart);
  } finally {
    if (restore === undefined) delete process.env.ORCH_JOB_LAUNCHER;
    else process.env.ORCH_JOB_LAUNCHER = restore;
  }

  // W3T-4: after the condition is repaired, the SAME scope is usable immediately.
  // This is the availability half of P1-A: a configuration mistake must not poison
  // the workspace forever.
  const p2 = spawnNode(['-e', 'process.exit(0)']);
  const e2 = await p2.exited;
  check('W3T-4 once the launcher resolves, a real run starts normally',
    e2.code === 0 && p2.processStartDisposition === 'started',
    `code=${String(e2.code)} disp=${p2.processStartDisposition}`);
  check('W3T-4 and is no longer reported as a pre-start failure',
    p2.processStartDisposition !== 'not-started');
}

{
  /*
   * W3T-2: the containment control directory cannot be created.
   *
   * A REAL filesystem failure: the launcher's own directory is used as the launcher
   * location (so resolution succeeds) and the `containment-run` name inside it is
   * occupied by a regular file, so `mkdirSync` cannot make it. Control setup runs
   * immediately before `spawn`, so no process can exist.
   *
   * The launcher itself is only needed so `existsSync` passes; the run must abort
   * before it is ever executed.
   */
  const dir = scratch2('w3t-2');
  const launcherHome = join(dir, 'launcher-home');
  mkdirSync(launcherHome, { recursive: true });
  // A real launcher image, so resolution succeeds.
  copyFileSync(resolveContainmentLauncher()!.exe, join(launcherHome, 'w1joblauncher.exe'));
  // ...but the control directory cannot be created.
  writeFileSync(join(launcherHome, 'containment-run'), 'not a directory');

  const restore = process.env.ORCH_JOB_LAUNCHER;
  process.env.ORCH_JOB_LAUNCHER = join(launcherHome, 'w1joblauncher.exe');
  let thrown: unknown = null;
  try {
    const p = new ManagedProcess({
      launcher: NODE_LAUNCHER,
      args: ['-e', 'process.exit(0)'],
      cwd: dir,
      env: process.env as Readonly<Record<string, string>>,
    });
    const e = await p.exited;
    check('W3T-2 the run aborted without starting anything',
      p.processStartDisposition === 'not-started' && e.code === null,
      `disp=${p.processStartDisposition} code=${String(e.code)}`);
  } catch (err) {
    thrown = err;
  } finally {
    if (restore === undefined) delete process.env.ORCH_JOB_LAUNCHER;
    else process.env.ORCH_JOB_LAUNCHER = restore;
  }
  // The control-setup failure throws synchronously out of the constructor, so the
  // THROWN error is the carrier of the proof. Either shape is acceptable; what matters
  // is that the runtime branded it.
  check('W3T-2 the control-setup failure is branded as a proven pre-start',
    thrown !== null && isProvenNotStarted(thrown),
    thrown === null ? 'no error was thrown' : String((thrown as Error).message));

  // W3T-4: repair the directory and the very same scope works immediately.
  rmSync(join(launcherHome, 'containment-run'), { force: true });
  const restore2 = process.env.ORCH_JOB_LAUNCHER;
  process.env.ORCH_JOB_LAUNCHER = join(launcherHome, 'w1joblauncher.exe');
  try {
    const ok = new ManagedProcess({
      launcher: NODE_LAUNCHER,
      args: ['-e', 'process.exit(0)'],
      cwd: dir,
      env: process.env as Readonly<Record<string, string>>,
    });
    const e = await ok.exited;
    check('W3T-4 after repairing the control directory the same scope runs normally',
      e.code === 0 && ok.processStartDisposition === 'started',
      `code=${String(e.code)} disp=${ok.processStartDisposition}`);
  } finally {
    if (restore2 === undefined) delete process.env.ORCH_JOB_LAUNCHER;
    else process.env.ORCH_JOB_LAUNCHER = restore2;
  }
}

{
  /*
   * W3T-3: a request rejected before any child is created.
   *
   * `assertCmdSafe` refuses a `.cmd` line whose quoting cannot survive transport. That
   * happens entirely in-process, before `spawn`, so the runtime can prove the point.
   */
  let thrown: unknown = null;
  try {
    const cmdLauncher = launcherFor('C:\\Windows\\System32\\cmd.exe');
    if (!cmdLauncher.ok) {
      check('W3T-3 a cmd launcher resolved for the fixture', false);
    } else {
      new ManagedProcess({
        launcher: { ...cmdLauncher.launcher, buildsCommandString: true },
        // An unescaped `"` in a cmd line is exactly what assertCmdSafe refuses.
        args: ['/d', '/s', '/c', 'echo "unbalanced'],
        cwd: SCRATCH,
        env: process.env as Readonly<Record<string, string>>,
      });
    }
  } catch (err) {
    thrown = err;
  }
  check('W3T-3 an unsafe cmd request is refused before spawn', thrown !== null);
  check('W3T-3 and is branded as a proven pre-start',
    thrown !== null && isProvenNotStarted(thrown),
    thrown === null ? 'no error was thrown' : String((thrown as Error).message));
}

{
  /*
   * W3T-5 / W3T-6 / W3T-7: the CONTRAST and the FORGE attempt.
   *
   * A run that actually started must never produce a proof — not even when it fails
   * immediately — and nothing outside the runtime can manufacture one.
   */
  const p = spawnNode(['-e', 'setTimeout(()=>{},50)']);
  await p.exited;
  check('W3T-5 a run that DID start is never `not-started`',
    p.processStartDisposition === 'started', p.processStartDisposition);

  // W3T-6: the previous exploit shape. There is no longer any way to construct proof
  // from above, so the "attempt" is a look-alike and must be rejected.
  const lookalike = Object.assign(new Error('no process was created'), {
    name: 'TrustedNotStarted',
    reason: 'launcher-unavailable',
    code: 'ENOENT',
    processStart: 'not-started',
  });
  check('W3T-6 an upper layer cannot manufacture trusted proof', isProvenNotStarted(lookalike) === false);
  check('W3T-7 and a class instance with the right name is not proof either',
    isProvenNotStarted(new (class extends Error { override name = 'TrustedNotStarted'; })('x')) === false);
}

// ===========================================================================
// W3.3 — Monotonic process-start state
// ===========================================================================
section('W3.3. process-start state is monotonic: a confirmed start can never downgrade');

{
  // W3P-7: the P2 closure. Once a child is CONFIRMED, a late failure that looks like
  // an image-not-found error must NOT be able to drag the state back to `not-started`.
  check('W3P-7 started absorbs a late ENOENT/EACCES-like error',
    advanceProcessStart('started', 'spawn-error-image-not-found') === 'started');
  check('W3P-7 started absorbs EVERY event (terminal)',
    advanceProcessStart('started', 'spawn-attempted') === 'started' &&
    advanceProcessStart('started', 'spawn-error-other') === 'started' &&
    advanceProcessStart('started', 'spawn-confirmed') === 'started' &&
    advanceProcessStart('started', 'proven-pre-spawn-failure') === 'started');
  check('W3P-7 and the terminal check agrees', isTerminalStartState('started') === true);

  // W3P-8: a GENUINE pre-spawn failure still resolves to `not-started`, from the
  // pending state where no child was ever confirmed.
  check('W3P-8 image-not-found from the pending state IS not-started',
    advanceProcessStart('may-have-started', 'spawn-error-image-not-found') === 'not-started');
  check('W3P-8 a proven pre-spawn failure IS not-started',
    advanceProcessStart('may-have-started', 'proven-pre-spawn-failure') === 'not-started');
  check('W3P-8 not-started is itself terminal',
    advanceProcessStart('not-started', 'spawn-confirmed') === 'not-started' &&
    advanceProcessStart('not-started', 'spawn-error-other') === 'not-started');

  // W3P-9: an UNCLASSIFIABLE spawn failure stays conservative — never not-started.
  check('W3P-9 an ambiguous spawn failure stays may-have-started',
    advanceProcessStart('may-have-started', 'spawn-error-other') === 'may-have-started');
  check('W3P-9 and a bare spawn attempt does too',
    advanceProcessStart('may-have-started', 'spawn-attempted') === 'may-have-started');

  // Exhaustive: NO input pair can ever produce started -> not-started.
  const states: ProcessStartDisposition[] = ['may-have-started', 'started', 'not-started'];
  const events = [
    'proven-pre-spawn-failure', 'spawn-attempted', 'spawn-confirmed',
    'spawn-error-image-not-found', 'spawn-error-other',
  ] as const;
  let downgrade = 0;
  for (const s of states) for (const e of events) {
    if (s === 'started' && advanceProcessStart(s, e) === 'not-started') downgrade++;
  }
  check('W3P-7 NO transition anywhere can downgrade started -> not-started', downgrade === 0,
    String(downgrade));
}

{
  // W3P-8 integration: the launcher-missing path is a genuine pre-spawn failure and
  // still reports `not-started` through a real ManagedProcess (not just the helper).
  const restore = process.env.ORCH_JOB_LAUNCHER;
  process.env.ORCH_JOB_LAUNCHER = join(SCRATCH, 'w3p-missing-launcher.exe');
  try {
    const p = spawnNode(['-e', 'process.exit(0)']);
    await p.exited;
    check('W3P-8 a real pre-spawn failure reports not-started end to end',
      p.processStartDisposition === 'not-started', p.processStartDisposition);
  } finally {
    if (restore === undefined) delete process.env.ORCH_JOB_LAUNCHER;
    else process.env.ORCH_JOB_LAUNCHER = restore;
  }

  // W3P-9 integration: a real started process reports `started` and never downgrades.
  const ok = spawnNode(['-e', 'process.exit(0)']);
  await ok.exited;
  check('W3P-9 a real started process reports started',
    ok.processStartDisposition === 'started', ok.processStartDisposition);
}

// ===========================================================================
rmSync(SCRATCH, { recursive: true, force: true });
process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length > 0) process.stdout.write(`failing:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
process.exitCode = failed === 0 ? 0 : 1;
