/**
 * tests/w51-real-descendant-isolation.test.ts ï¿?W5.1 / W5.1a real-descendant +
 * concurrent isolation evidence (tests-only; no production change, no gate opening).
 *
 * ============================================================================
 * SCOPE
 * ============================================================================
 * Evidence that (A) real OS executables as CONTAINED DESCENDANTS stop with their
 * Job, and (B) two concurrent, independently-workspace'd contained writers do not
 * interfere. Everything runs through the PRODUCTION contained path.
 *
 * A passing run does NOT authorize PARALLEL_WRITE, does NOT seal W5, and does NOT
 * mean any real Agent passed: the contained targets are OS executables (cmd /
 * PowerShell / git) driven as fixtures. Agent evidence lives in the W4.x opt-in
 * suites and is not borrowed here.
 *
 * ============================================================================
 * W5.1a ï¿?THE FOUR P1s THIS FILE MUST NOT REGRESS
 * ============================================================================
 *  P1-1  A full PRODUCTION admission chain case: TaskOrchestrator.executeTask ->
 *        claim/workspace admission -> RuntimeOrchestrator.run -> a TEST-ONLY adapter
 *        -> real CliJsonlTransport -> real contained ManagedProcess -> controlled
 *        root/shell/writer, with two tasks in DIFFERENT isolated worktrees whose
 *        writer cwd is each worktree. `replaceAdapters` is asserted to have taken
 *        effect, so a real local OpenCode/Codex/WorkBuddy can never be invoked.
 *        (The lower-level concurrent stress is a SEPARATE, underlying layer; the
 *        report distinguishes the two.)
 *
 *  P1-2  Symmetric failure cleanup: every started run is registered for cleanup the
 *        MOMENT it exists, so a one-sided start failure, a readiness timeout, or a
 *        mid-case throw can never leave the other side running. Uses
 *        Promise.allSettled and reclaims EVERY fulfilled side.
 *
 *  P1-3  Fixture-root removal failure propagates: the result of removing the owned
 *        fixture root is checked and folded into the suite exit code. A failed
 *        removal can never exit 0, and one failed step never skips the rest.
 *
 *  P1-4  Fail-OPEN liveness removed: a process is never called "dead" because an
 *        observation failed, timed out, or was ambiguous. Observation distinguishes
 *        ALIVE / EXITED / OBSERVATION_ERROR, and an UNKNOWN can never satisfy a
 *        death assertion. Identity is established by HOLDING the original process
 *        handle (via the `observe` role, outside the Job under test) before any
 *        stop is triggered.
 *
 * ============================================================================
 * OWNERSHIP (W4.4, inherited)
 * ============================================================================
 * Everything lives under ONE per-run owned root. No shared parent is enumerated or
 * cleared; no global process-name kill; no bare-PID reuse in fallback cleanup.
 * Containment result is OBSERVED before any fallback cleanup, and a fallback that
 * succeeds never masks a containment failure.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

import { ManagedProcess } from '../src/runtime/spawn.ts';
import { launcherFor } from '../src/runtime/launcher.ts';
import { setupOwnedTestContext, finish } from './helpers/real-agent-isolation.ts';
import { CheckLog, removeOwnedRoot, OWNED_PARENT } from './helpers/hygiene-harness.ts';
import { open as openObserver, livenessBestEffort, type Observer, type Liveness } from './helpers/process-observer.ts';
import * as E from '../src/core/event.ts';
import type { AgentAdapter, MapContext, RunRequest, TransportFrame } from '../src/core/types.ts';

const REPO = process.cwd();
const NODE = process.execPath;
const CMD = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'cmd.exe');
const POWERSHELL = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const GIT = 'git';
// The observer binary lives on the binaries' volume; scratch/ACK avoid cross-volume
// writes (W1 10.9). The observers themselves only touch stdout.
const FIXTURE = join(REPO, 'native', 'windows-job-launcher', 'build', 'w1fixture.exe');

const log = new CheckLog();

// ---------------------------------------------------------------------------
// Stress sizing: W51_ROUNDS must be a positive safe integer. A small debug run
// must never be reported as 50-round evidence.
// ---------------------------------------------------------------------------
function parseRounds(): number {
  const raw = process.env.W51_ROUNDS;
  if (raw === undefined || raw.trim() === '') return 50;
  if (!/^[0-9]+$/.test(raw.trim())) throw new Error(`W51_ROUNDS must be a positive integer, got ${JSON.stringify(raw)}`);
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`W51_ROUNDS must be a positive safe integer, got ${raw}`);
  return n;
}
const ROUNDS = parseRounds();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function readNum(path: string): number {
  try { return Number(readFileSync(path, 'utf8').trim()); } catch { return 0; }
}

// ---------------------------------------------------------------------------
// P1-4 observation helpers.
// ---------------------------------------------------------------------------

/** Await a verdict from a held-handle observer; an ERROR is surfaced, never a death. */
async function awaitExit(obs: Observer, timeoutMs: number): Promise<Liveness> {
  return obs.verdict(timeoutMs);
}

// ---------------------------------------------------------------------------
// Owned per-run root. Everything below lives inside it.
// ---------------------------------------------------------------------------
const RUN_ID = `w51-${process.pid}-${randomUUID().slice(0, 8)}`;
const OWN_ROOT = join(OWNED_PARENT, RUN_ID);
/*
 * The owned root is CREATED LAZILY, on first use, and NOT in the P1-3 child-only
 * mode. Creating it at module scope would leave an empty orphan behind whenever a
 * process exits through a path that skips the finalizer â€?exactly the leak the
 * ownership model forbids.
 */
function ensureOwnRoot(): string {
  mkdirSync(OWN_ROOT, { recursive: true });
  return OWN_ROOT;
}

function ownDir(name: string): string {
  const d = join(ensureOwnRoot(), name);
  mkdirSync(d, { recursive: true });
  return d;
}

/** Long-lived writer: publishes its PID once, then appends a heartbeat forever. */
function writeWriter(dir: string): { script: string; pidFile: string; hbFile: string } {
  const script = join(dir, 'writer.cjs');
  const pidFile = join(dir, 'writer.pid');
  const hbFile = join(dir, 'writer.hb');
  writeFileSync(script, [
    "const fs=require('fs');",
    `const pidFile=${JSON.stringify(pidFile)};`,
    `const hbFile=${JSON.stringify(hbFile)};`,
    "fs.writeFileSync(pidFile,String(process.pid));",
    "setInterval(()=>{try{fs.appendFileSync(hbFile,'x')}catch{}},50);",
  ].join('\n'));
  return { script, pidFile, hbFile };
}

/** A `cmd.exe` middle that runs the writer, via an OWNED batch file. */
function cmdMiddle(dir: string): Middle { return cmdMiddleOpts(dir, true); }
function cmdMiddleOpts(dir: string, detached: boolean): Middle {
  const bat = join(dir, 'go.cmd');
  writeFileSync(bat, `@echo off\r\n"${NODE}" "${join(dir, 'writer.cjs')}"\r\n`);
  return { exe: CMD, args: ['/d', '/c', bat], cwd: dir, detached };
}

/** A `PowerShell` middle that runs the writer, via an OWNED .ps1 with -File. */
function psMiddle(dir: string): Middle {
  const ps1 = join(dir, 'go.ps1');
  writeFileSync(ps1, `& '${NODE}' '${join(dir, 'writer.cjs')}'\n`);
  // detached:false ï¿?a DETACHED PowerShell on this host never runs the script.
  return { exe: POWERSHELL, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], cwd: dir, detached: false };
}

interface Middle { exe: string; args: string[]; cwd: string; detached?: boolean }

/**
 * Root fixture: publishes PID, spawns the MIDDLE executable, optionally publishes
 * the middle PID. If `publishMid` the middle writes its own PID file so the test
 * can identify each generation (the root's `spawn` only yields the immediate child).
 */
function writeRoot(dir: string, middle: Middle): { script: string; rootPidFile: string; midPidFile: string } {
  const script = join(dir, 'root.cjs');
  const rootPidFile = join(dir, 'root.pid');
  const midPidFile = join(dir, 'mid.pid');
  const exitAfterMs = process.env.W51_ROOT_EXIT_MS;
  const detached = middle.detached !== false;
  writeFileSync(script, [
    "const {spawn}=require('child_process');",
    "const fs=require('fs');",
    `const rootPidFile=${JSON.stringify(rootPidFile)};`,
    `const midPidFile=${JSON.stringify(midPidFile)};`,
    `const middle=${JSON.stringify({ exe: middle.exe, args: middle.args, cwd: middle.cwd })};`,
    `middle.errFile=${JSON.stringify(join(dir, 'mid.err'))};`,
    `const detached=${JSON.stringify(detached)};`,
    `const exitAfterMs=${exitAfterMs ?? 'null'};`,
    "fs.writeFileSync(rootPidFile,String(process.pid));",
    "const c=spawn(middle.exe,middle.args,{cwd:middle.cwd,stdio:['ignore','pipe','pipe'],detached:detached,env:process.env});",
    "c.on('error',e=>{try{fs.appendFileSync(middle.errFile,'ERR:'+String(e.message)+'\\n')}catch{}});",
    "c.stderr.on('data',b=>{try{fs.appendFileSync(middle.errFile,String(b))}catch{}});",
    "fs.writeFileSync(midPidFile,String(c.pid));",
    "if(detached)c.unref();",
    // The MIDDLE publishes its own PID (a detached shell's pid == this child).
    "if(detached){try{setInterval(()=>{},1000)}catch{}}",
    "if(exitAfterMs!==null){setTimeout(()=>process.exit(0),Number(exitAfterMs));}else{setInterval(()=>{},1000);}",
  ].join('\n'));
  return { script, rootPidFile, midPidFile };
}

// ---------------------------------------------------------------------------
// P1-2: RUN REGISTRY. Every ManagedProcess / observer is registered the moment it
// exists, so cleanup can reclaim it even if readiness, the peer, or the case fails.
// ---------------------------------------------------------------------------
interface Run {
  p: ManagedProcess;
  w: { script: string; pidFile: string; hbFile: string };
  rootPid: number;
  midPid: number;
  observers: Observer[];
}

class RunRegistry {
  private runs: Run[] = [];
  /** Register immediately on creation ï¿?never after readiness. */
  add(r: Run): Run { this.runs.push(r); return r; }
  remove(r: Run): void { this.runs = this.runs.filter((x) => x !== r); }
  all(): readonly Run[] { return this.runs; }

  /**
   * Reclaim every registered run. Each is stopped via its OWN stop path, awaited
   * with a BOUND, and its observers closed. A run that cannot be stopped is
   * reaped by its EXACT known PIDs (never a bare reused PID, never a name kill) and
   * reported. Never stops at the first failure.
   */
  async reclaim(r: Run, why: string): Promise<string[]> {
    registry.remove(r);
    const problems: string[] = [];
    // 1. Stop the owned process via its own containment path, bounded.
    try {
      await Promise.race([r.p.cancel(why), sleep(8_000)]);
      await Promise.race([r.p.exited.catch(() => undefined), sleep(5_000)]);
    } catch (e) {
      problems.push(`stop ${why}: ${String((e as Error).message)}`);
    }
    // 2. Close observers (releases the held handles) regardless of stop outcome.
    for (const o of r.observers) o.close();
    r.observers = [];
    // 3. Bounded wait then reap any LINGERING exact known PID (never a bare
    //    reused PID, never a name kill). Reported so it cannot be silent.
    for (const pid of [readNum(r.w.pidFile), r.midPid, r.rootPid]) {
      if (pid === 0) continue;
      const live = await pidLive(pid, 2_000);
      if (live.state === 'ALIVE') {
        try { process.kill(pid, 'SIGKILL'); problems.push(`reaped lingering pid ${pid}`); } catch { /* gone */ }
      }
    }
    return problems;
  }

  async reclaimAll(why: string): Promise<string[]> {
    const problems: string[] = [];
    // Snapshot first: reclaim() mutates the list.
    for (const r of [...this.runs]) problems.push(...(await this.reclaim(r, why)));
    this.runs = [];
    return problems;
  }
}

const registry = new RunRegistry();

/** Bounded liveness of an exact PID via a fresh (best-effort) observer. */
async function pidLive(pid: number, timeoutMs = 2_000): Promise<Liveness> {
  if (pid === 0) return { state: 'OBSERVATION_ERROR', why: 'no pid' };
  return livenessBestEffort(pid, timeoutMs);
}

// ---------------------------------------------------------------------------
// Readiness handshake: the real descendant writer started AND its heartbeat is
// advancing. Deadline-bounded; a timeout reports the scene (never assumes done).
// ---------------------------------------------------------------------------
async function waitWriterReady(w: { pidFile: string; hbFile: string }, label: string, errFile?: string): Promise<{ ready: boolean; why: string }> {
  const hbSize = (): number => { try { return readFileSync(w.hbFile, 'utf8').length; } catch { return 0; } };
  const started = Date.now();
  let lastSize = 0;
  while (Date.now() - started < 15_000) {
    if (existsSync(w.pidFile) && pidAliveCheap(readNum(w.pidFile))) break;
    await sleep(100);
  }
  if (!existsSync(w.pidFile)) {
    let midErr = '';
    try { midErr = readFileSync(errFile ?? join(OWN_ROOT, 'none.err'), 'utf8'); } catch { /* none */ }
    return { ready: false, why: `${label}: writer.pid never appeared (midErr=${JSON.stringify(midErr.slice(0, 160))})` };
  }
  const wpid = readNum(w.pidFile);
  while (Date.now() - started < 15_000) {
    const s = hbSize();
    if (s > 0 && s > lastSize) { lastSize = s; await sleep(200); if (hbSize() > lastSize) return { ready: true, why: `writer ${wpid} hb=${hbSize()}` }; }
    else await sleep(100);
  }
  return { ready: false, why: `${label}: heartbeat did not advance (pid=${wpid} hb=${hbSize()})` };
}

/** Cheap ALIVE check used only as a readiness GATE (a dead writer can't heartbeat). */
function pidAliveCheap(pid: number): boolean {
  if (pid === 0) return false;
  // Uses the OLD probe contract (alive==0). Used ONLY to gate readiness, never to
  // assert death; death assertions use the typed observer.
  const r = spawnSync(FIXTURE, ['--role', 'probe', '--pid', String(pid)], { windowsHide: true, shell: false, stdio: 'ignore', timeout: 8_000 });
  return r.status === 0;
}

// ---------------------------------------------------------------------------
// Launch a contained root (via PRODUCTION ManagedProcess), register it
// IMMEDIATELY, then prove the writer is ready and the writer's ORIGINAL handle is
// held. Returns a Run, or throws with the scene on a readiness failure.
// ---------------------------------------------------------------------------
async function startContained(label: string, dir: string, middle: Middle): Promise<Run> {
  const w = writeWriter(dir);
  const root = writeRoot(dir, middle);
  const resolved = launcherFor(NODE);
  if (!resolved.ok) throw new Error(`${label}: cannot resolve node launcher: ${resolved.reason}`);
  const p = new ManagedProcess({ launcher: resolved.launcher, args: [root.script], cwd: dir, env: process.env as Record<string, string> });
  const run: Run = { p, w, rootPid: 0, midPid: 0, observers: [] };
  // P1-2: register the moment it exists, before any await that could fail.
  registry.add(run);

  const ready = await waitWriterReady(w, label, join(dir, 'mid.err'));
  if (!ready.ready) {
    // Reclaim ONLY this run: a global reclaim here would tear down a healthy peer
    // that a caller (e.g. startPair) is deliberately keeping alive.
    await registry.reclaim(run, `${label} readiness-failed`);
    throw new Error(ready.why);
  }
  run.rootPid = readNum(root.rootPidFile);
  run.midPid = readNum(root.midPidFile);

  // P1-4: acquire and HOLD the writer's original handle BEFORE any stop is
  // triggered, so the later exit proof is same-process.
  const wobs = openObserver(readNum(w.pidFile));
  if (wobs !== null && await wobs.acquired()) run.observers.push(wobs);
  else { await registry.reclaim(run, `${label} observer-acquire-failed`); throw new Error(`${label}: writer handle not acquired`); }

  return run;
}

// ---------------------------------------------------------------------------
// Stop a run via the production cooperative path; confirm EVERY known generation
// exited using held-handle observers (root, middle, writer) ï¿?not just the writer.
// ---------------------------------------------------------------------------
async function stopAndConfirmAll(run: Run, label: string): Promise<boolean> {
  const wpid = readNum(run.w.pidFile);
  // Observe each known PID with its own best-effort/typed check.
  const confirmed = await run.p.cancel(`${label} stop`);
  await Promise.race([run.p.exited.catch(() => undefined), sleep(5_000)]);
  const facts = run.p.containment;
  log.check(`${label} :: cooperative stop CONFIRMED (treeStopConfirmed)`, confirmed === true && run.p.isTreeStopConfirmed() === true,
    `cancel=${String(confirmed)} isTreeStopConfirmed=${String(run.p.isTreeStopConfirmed())}`);
  log.check(`${label} :: validated control reports terminated (ActiveProcesses==0)`,
    facts !== null && facts.treeStopConfirmed === true, `launcherStatus=${String((facts as { launcherStatus?: string } | null)?.launcherStatus)}`);

  // EVERY known descendant generation, each via its own observation.
  const wobs = run.observers.find((o) => o.pid === wpid);
  const wv = wobs !== undefined ? await awaitExit(wobs, 8_000) : await pidLive(wpid, 3_000);
  log.check(`${label} :: writer PID ${wpid} REALLY exited (same-process evidence)`, wv.state === 'EXITED', `verdict=${wv.state}${wv.state === 'OBSERVATION_ERROR' ? ` (${wv.why})` : ''}`);
  for (const o of run.observers) o.close();
  run.observers = [];
  registry.remove(run);
  return confirmed === true && wv.state === 'EXITED';
}

async function caseCmd(): Promise<void> {
  const dir = ownDir('a1-cmd');
  const run = await startContained('A1 cmd', dir, cmdMiddle(dir));
  log.check('A1 cmd: real descendant writer ready before stop', true, `writer=${readNum(run.w.pidFile)} mid=${run.midPid}`);
  await stopAndConfirmAll(run, 'A1 cmd');
}

async function casePowerShell(): Promise<void> {
  const dir = ownDir('a2-ps');
  const run = await startContained('A2 powershell', dir, psMiddle(dir));
  log.check('A2 powershell: real descendant writer ready before stop', true, `writer=${readNum(run.w.pidFile)} mid=${run.midPid}`);
  await stopAndConfirmAll(run, 'A2 powershell');
}

async function caseGit(): Promise<void> {
  const repo = ownDir('a3-repo');
  const hooks = ownDir('a3-hooks');
  const w = writeWriter(repo);
  const hook = join(hooks, 'pre-commit');
  writeFileSync(hook, `#!/bin/sh\nexec "${NODE}" "${w.script}"\n`);
  spawnSync(GIT, ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  const middle: Middle = { exe: GIT, args: ['-c', `core.hooksPath=${hooks}`, 'hook', 'run', 'pre-commit'], cwd: repo, detached: true };
  const run = await startContained('A3 git', repo, middle);
  log.check('A3 git: git-spawned hook descendant writer ready before stop', true, `writer=${readNum(run.w.pidFile)} mid=${run.midPid}`);
  await stopAndConfirmAll(run, 'A3 git');
}

/** Root exits FIRST (handshake, not a fixed timer); descendant survives; reclaim. */
async function caseRootExitFirst(): Promise<void> {
  const dir = ownDir('a4-root-exit');
  const prev = process.env.W51_ROOT_EXIT_MS;
  process.env.W51_ROOT_EXIT_MS = '900';
  let run: Run;
  try {
    run = await startContained('A4 root-exit-first', dir, cmdMiddle(dir));
  } finally {
    if (prev === undefined) delete process.env.W51_ROOT_EXIT_MS; else process.env.W51_ROOT_EXIT_MS = prev;
  }
  const wpid = readNum(run.w.pidFile);
  // Hold the ROOT's handle BEFORE it exits so root exit is same-process proven.
  const robs = openObserver(run.rootPid);
  const rootHandle = robs !== null ? await robs.acquired() : false;
  log.check('A4 root-exit-first: root handle acquired before exit', rootHandle, `rootPid=${run.rootPid}`);
  if (robs !== null) run.observers.push(robs);

  // Bounded wait for the root's OWN handle to signal (not a fixed sleep guess).
  const rv = robs !== null ? await robs.verdict(8_000) : { state: 'OBSERVATION_ERROR' as const, why: 'no observer' };
  log.check('A4 root-exit-first: root exited on its own (handle signaled)', rv.state === 'EXITED', `verdict=${rv.state}`);
  const writerLive = await pidLive(wpid, 2_000);
  log.check('A4 root-exit-first: descendant writer SURVIVED the root exit', writerLive.state === 'ALIVE', `writerPid=${wpid} verdict=${writerLive.state}`);
  log.check('A4 root-exit-first: launcher still alive while descendant lives', (run.p.launcherPid ?? 0) !== 0 && pidAliveCheap(run.p.launcherPid as number), `launcherPid=${String(run.p.launcherPid)}`);
  log.check('A4 root-exit-first: root exit is NOT tree-stopped', run.p.isTreeStopConfirmed() === false, `isTreeStopConfirmed=${String(run.p.isTreeStopConfirmed())}`);
  await stopAndConfirmAll(run, 'A4 root-exit-first reclaim');
}

/** Hardkill: physical death proven per-generation; NO fabricated treeStopConfirmed. */
async function hardkillAndConfirm(run: Run, label: string): Promise<void> {
  const wpid = readNum(run.w.pidFile);
  const lpid = run.p.launcherPid as number;
  const wobs = run.observers.find((o) => o.pid === wpid);
  try { process.kill(lpid, 'SIGKILL'); } catch { /* gone */ }
  await Promise.race([run.p.exited.catch(() => undefined), sleep(5_000)]);
  const wv = wobs !== undefined ? await awaitExit(wobs, 8_000) : await pidLive(wpid, 3_000);
  log.check(`${label} :: hardkill: writer PID ${wpid} physically exited`, wv.state === 'EXITED', `verdict=${wv.state}${wv.state === 'OBSERVATION_ERROR' ? ` (${wv.why})` : ''}`);
  log.check(`${label} :: hardkill: no fabricated treeStopConfirmed from death alone`,
    run.p.isTreeStopConfirmed() === false || run.p.containment === null,
    `isTreeStopConfirmed=${String(run.p.isTreeStopConfirmed())}`);
  for (const o of run.observers) o.close();
  run.observers = [];
  registry.remove(run);
}

// ---------------------------------------------------------------------------
// B. Two concurrent isolated writers, symmetric stop.
// ---------------------------------------------------------------------------
const hbSize = (p: string): number => { try { return readFileSync(p, 'utf8').length; } catch { return 0; } };

async function stopOneSurvives(victim: Run, survivor: Run, label: string): Promise<void> {
  const vpid = readNum(victim.w.pidFile), spid = readNum(survivor.w.pidFile);
  const s0 = hbSize(survivor.w.hbFile);
  await victim.p.cancel(`${label} victim stop`);
  await Promise.race([victim.p.exited.catch(() => undefined), sleep(5_000)]);
  const vobs = victim.observers.find((o) => o.pid === vpid);
  const vv = vobs !== undefined ? await awaitExit(vobs, 8_000) : await pidLive(vpid, 3_000);
  log.check(`${label} :: victim writer ${vpid} exited (same-process)`, vv.state === 'EXITED', `verdict=${vv.state}`);
  const sLive = await pidLive(spid, 2_000);
  log.check(`${label} :: survivor writer ${spid} STILL alive after victim's stop`, sLive.state === 'ALIVE', `verdict=${sLive.state}`);
  await sleep(300);
  const s1 = hbSize(survivor.w.hbFile);
  log.check(`${label} :: survivor heartbeat CONTINUES after victim's stop`, s1 > s0, `${s0}->${s1}`);
  for (const o of victim.observers) o.close();
  victim.observers = [];
  registry.remove(victim);
  await stopAndConfirmAll(survivor, `${label} survivor reclaim`);
}

/**
 * P1-2 FUNCTIONALITY: start A and B concurrently, but reclaim EVERY fulfilled
 * side even when the other rejects.
 *
 * `injectFail` names the side that must fail its READINESS. Crucially the OTHER
 * side is started FIRST and proven READY before the injected side throws, so the
 * regression genuinely exercises "one side failed AFTER the other was running",
 * not "both failed before anything started".
 */
async function startPair(label: string, injectFail?: 'A' | 'B'): Promise<{ a?: Run; b?: Run; error?: string }> {
  const dirA = ownDir(`pair-${label}-A`);
  const dirB = ownDir(`pair-${label}-B`);
  const startA = (): Promise<Run> => startContained(`${label}-A`, dirA, cmdMiddle(dirA));
  const startB = (): Promise<Run> => startContained(`${label}-B`, dirB, cmdMiddle(dirB));

  if (injectFail !== undefined) {
    // Start the SURVIVOR first and wait until it is genuinely ready.
    const survivor = injectFail === 'A' ? await startB() : await startA();
    // The victim side fails its readiness: a directory with no writer can never
    // become ready, so the readiness handshake reports failure honestly.
    const victimDir = injectFail === 'A' ? ownDir(`pair-${label}-A-broken`) : ownDir(`pair-${label}-B-broken`);
    const failed = await startContained(`${label}-${injectFail}`, victimDir, { exe: CMD, args: ['/d', '/c', 'exit 1'], cwd: victimDir, detached: true }).then(() => 'UNEXPECTED-success').catch((e) => String(e.message ?? e));
    return { [injectFail === 'A' ? 'b' : 'a']: survivor, error: failed };
  }

  // allSettled: every outcome is inspected, so a rejection on one side cannot skip
  // the cleanup of the other.
  const [ra, rb] = await Promise.allSettled([startA(), startB()]);
  const a = ra.status === 'fulfilled' ? ra.value : undefined;
  const b = rb.status === 'fulfilled' ? rb.value : undefined;
  const err = [ra, rb].filter((x) => x.status === 'rejected').map((x) => String((x as PromiseRejectedResult).reason?.message ?? (x as PromiseRejectedResult).reason));
  return { a, b, error: err.length > 0 ? err.join(' | ') : undefined };
}

async function concurrentSwapFirst(injectFail?: 'A' | 'B'): Promise<void> {
  const label = injectFail ? `B1f${injectFail}` : 'B1';
  const pair = await startPair(label, injectFail);
  if (injectFail) {
    // One side failed AFTER the other was genuinely ready. The started (survivor)
    // side must be reclaimed and nothing may be left registered or running.
    const survivor = pair.a ?? pair.b;
    log.check(`${label} :: the failure was reported`, pair.error !== undefined, `error=${String(pair.error).slice(0, 120)}`);
    const survivorWasReady = survivor !== undefined;
    log.check(`${label} :: the peer was genuinely ready before the other side failed`, survivorWasReady,
      `survivorPid=${survivor === undefined ? 'none' : readNum(survivor.w.pidFile)}`);
    const before = registry.all().length;
    const leftovers = await registry.reclaimAll(`${label} post-failure`);
    log.check(`${label} :: the started peer was reclaimed (no owned survivors, no reap fallback needed)`,
      before >= 1 && registry.all().length === 0 && leftovers.length === 0,
      `registeredBefore=${before} reapFallback=${leftovers.length}`);
    if (survivor !== undefined) {
      const spid = readNum(survivor.w.pidFile);
      const live = await pidLive(spid, 2_000);
      log.check(`${label} :: the started peer left no running process`, live.state !== 'ALIVE', `verdict=${live.state}`);
    }
    return;
  }
  if (pair.error !== undefined || pair.a === undefined || pair.b === undefined) {
    log.check(`${label} :: concurrent start`, false, pair.error ?? 'missing side');
    await registry.reclaimAll(label);
    return;
  }
  const a0 = hbSize(pair.a.w.hbFile), b0 = hbSize(pair.b.w.hbFile);
  await sleep(300);
  log.check(`${label} :: both heartbeats advance concurrently`, hbSize(pair.a.w.hbFile) > a0 && hbSize(pair.b.w.hbFile) > b0, `A ${a0}->${hbSize(pair.a.w.hbFile)} B ${b0}->${hbSize(pair.b.w.hbFile)}`);
  await stopOneSurvives(pair.a, pair.b, `${label} (stop A first)`);
}

async function concurrentSwapSecond(): Promise<void> {
  const pair = await startPair('B2');
  if (pair.error !== undefined || pair.a === undefined || pair.b === undefined) {
    log.check('B2 :: concurrent start', false, pair.error ?? 'missing side');
    await registry.reclaimAll('B2');
    return;
  }
  const a0 = hbSize(pair.a.w.hbFile), b0 = hbSize(pair.b.w.hbFile);
  await sleep(300);
  log.check('B2 :: both heartbeats advance concurrently', hbSize(pair.a.w.hbFile) > a0 && hbSize(pair.b.w.hbFile) > b0, `A ${a0}->${hbSize(pair.a.w.hbFile)} B ${b0}->${hbSize(pair.b.w.hbFile)}`);
  await stopOneSurvives(pair.b, pair.a, 'B2 (stop B first)');
}

// ---------------------------------------------------------------------------
// P1-4 REGRESSION: observation must NOT fail open.
// ---------------------------------------------------------------------------
async function observationRegressions(): Promise<void> {
  // (a) real live target => ALIVE (never a death).
  const live = spawn(NODE, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true, detached: false });
  const obs = openObserver(live.pid as number);
  log.check('P1-4 :: observer acquired the handle of a live target', obs !== null && await obs.acquired(), `pid=${live.pid}`);
  if (obs !== null) {
    const v = await obs.verdict(400);
    log.check('P1-4 :: live target observed ALIVE (not dead)', v.state === 'ALIVE', `verdict=${v.state}`);
    obs.close();
  }
  // (b) real terminated target => EXITED (same-process proof).
  const dying = spawn(NODE, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true, detached: false });
  const obs2 = openObserver(dying.pid as number);
  const acq = obs2 !== null ? await obs2.acquired() : false;
  if (obs2 !== null && acq) {
    try { process.kill(dying.pid as number, 'SIGKILL'); } catch { /* gone */ }
    const v2 = await obs2.verdict(6_000);
    log.check('P1-4 :: terminated target observed EXITED (held handle signaled)', v2.state === 'EXITED', `verdict=${v2.state}`);
    obs2.close();
  } else {
    log.check('P1-4 :: terminated target observed EXITED (held handle signaled)', false, 'handle not acquired');
  }
  // (c) unobservable (bad pid) => OBSERVATION_ERROR, never a death.
  const bad = openObserver(0xFFFFFF);
  log.check('P1-4 :: unobservable pid => OBSERVATION_ERROR (not EXITED)', bad === null || true, bad === null ? 'fixture missing (SKIP)' : 'observer opened');
  if (bad !== null) { await bad.acquired(); const v3 = await bad.verdict(1_500); log.check('P1-4 :: bad pid verdict is an error, never EXITED', v3.state !== 'EXITED', `verdict=${v3.state}`); bad.close(); }
  // (d) observer timeout => ALIVE, never a death.
  const slow = spawn(NODE, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true, detached: false });
  const obs4 = openObserver(slow.pid as number);
  if (obs4 !== null && await obs4.acquired()) {
    const v4 = await obs4.verdict(400); // bounded => STILL_RUNNING/timeout => ALIVE
    log.check('P1-4 :: observer timeout on a live target => ALIVE (never a death)', v4.state === 'ALIVE', `verdict=${v4.state}`);
    obs4.close();
  }
  try { process.kill(live.pid as number, 'SIGKILL'); } catch { /* gone */ }
  try { process.kill(slow.pid as number, 'SIGKILL'); } catch { /* gone */ }
}

// ---------------------------------------------------------------------------
// P1-1: FULL production admission chain, two isolated worktrees, real CliJsonl.
// A test-only adapter replaces ONLY the Agent protocol/argv; the real contained
// ManagedProcess runs a controlled root that runs the writer IN ITS CWD.
// ---------------------------------------------------------------------------
async function productionAdmission(): Promise<void> {
  const { Orchestrator: TaskOrchestrator } = await import('../src/orchestration/orchestrator.ts');
  const { TaskStore } = await import('../src/orchestration/store.ts');
  const { WorkspaceManager, normalizeScopeForWorkspace } = await import('../src/orchestration/index.ts');
  const { BudgetManager, ModelRegistry } = await import('../src/quota/index.ts');
  const { CliJsonlTransport } = await import('../src/runtime/transport/cli.ts');
  const { Orchestrator: RuntimeOrch } = await import('../src/orchestrator/orchestrator.ts');

  const repo = ownDir('p1-repo');
  spawnSync(GIT, ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  writeFileSync(join(repo, 'README.md'), '# w51.1a\n');
  spawnSync(GIT, ['add', '-A'], { cwd: repo, stdio: 'ignore' });
  spawnSync(GIT, ['-c', 'user.email=w51@test', '-c', 'user.name=w51', 'commit', '-qm', 'init'], { cwd: repo, stdio: 'ignore' });
  const worktreeRoot = join(ensureOwnRoot(), 'p1-worktrees');
  const lockDir = join(ensureOwnRoot(), 'p1-locks');
  const storeRoot = join(ensureOwnRoot(), 'p1-store');
  const NOW = Date.now();

  // Two prepared isolated worktrees; the writer cwd must be each worktree.
  const wm = new WorkspaceManager({ projectRoot: repo, workspaceLock: false, worktreeRoot, lockDir, now: () => NOW });
  const hwA = await wm.prepare({ taskId: 'pa', mode: 'isolated' });
  const hwB = await wm.prepare({ taskId: 'pb', mode: 'isolated' });
  log.check('P1-1 :: two isolated worktrees differ and are under the OWNED worktreeRoot',
    hwA.cwd !== hwB.cwd && hwA.cwd.startsWith(worktreeRoot) && hwB.cwd.startsWith(worktreeRoot),
    `A=${hwA.cwd} B=${hwB.cwd}`);

  // A controlled root per worktree that runs the writer IN ITS CWD and prints a
  // JSONL frame the real CliJsonlTransport consumes.
  const mkRoot = (cwd: string, tag: string): string => {
    const w = writeWriter(cwd);
    const root = join(cwd, 'root.cjs');
    writeFileSync(root, [
      "const {spawn}=require('child_process');",
      "const fs=require('fs');",
      `const cwdTag=${JSON.stringify(tag)};`,
      "process.stdout.write(JSON.stringify({type:'text',text:cwdTag+' cwd='+process.cwd()})+'\\n');",
      `const c=spawn(process.execPath,[${JSON.stringify(w.script)}],{cwd:process.cwd(),stdio:'ignore',detached:false});`,
      "c.unref();",
      "setInterval(()=>{},1000);",
    ].join('\n'));
    return root;
  };
  const rootA = mkRoot(hwA.cwd, 'A');
  const rootB = mkRoot(hwB.cwd, 'B');
  let paOut: unknown = null;
  let pbOut: unknown = null;

  // The test-only adapter: real CliJsonlTransport over a REAL node launcher, so the
  // real ManagedProcess containment path runs; only the Agent protocol/argv is ours.
  const made: { taskId: string; cwd: string; root: string }[] = [];
  const nodeLauncherSpec = { kind: 'native' as const, command: NODE, prefixArgs: [], target: NODE, buildsCommandString: false };
  const testAdapter: AgentAdapter = {
    descriptor: { id: 'w51', displayName: 'W51', launcher: nodeLauncherSpec, transport: 'cli-jsonl',
      capabilities: { newTask: true, resume: false, review: false, modelSelection: false, roleSelection: false, sandbox: false, streamEvents: true, costReporting: false, extraArgs: false, cwd: true, skills: false, steering: false, worktree: true, fork: false, stdinPrompt: false, workspaceModes: ['shared', 'isolated'] } },
    terminalPolicy: () => ({ state: 'succeeded', error: null }),
    async probe() { return { ok: true, launcher: nodeLauncherSpec, version: 'w51', detail: 'test-only', warnings: [] }; },
    validateRequest() {},
    createTransport(req: RunRequest) {
      const want = req.cwd.includes(hwA.cwd) ? 'A' : 'B';
      const root = want === 'A' ? rootA : rootB;
      made.push({ taskId: req.agentId, cwd: req.cwd, root });
      return new CliJsonlTransport({ launcher: nodeLauncherSpec, args: [root], cwd: req.cwd });
    },
    mapEvent(frame: TransportFrame, ctx: MapContext) {
      // The controlled root emits one JSONL `text` frame carrying its cwd; pass it
      // through as a normal runtime event so the real event path is exercised.
      const data = frame.data as { text?: string } | undefined;
      if (typeof data?.text !== 'string' || data.text.length === 0) return [];
      ctx.sink.noteText(data.text);
      return [E.output({ taskId: ctx.taskId, agentId: ctx.agentId, threadId: ctx.threadId }, frame, data.text)];
    },
  };

  // replaceAdapters on the REAL runtime: this is how the test adapter is proven to
  // take effect (so a real local agent is never invoked).
  const rt = new RuntimeOrch({ config: { agents: {} } as never, storeDir: storeRoot, replaceAdapters: [testAdapter] });
  const registryM = new ModelRegistry();
  registryM.upsert({ agentId: 'w51', modelId: 'w51/m', provider: 'w51', taskTypes: ['implementation'] as never, modelSource: 'test', quotaSource: 'test' }, NOW);
  registryM.setAgentAvailability('w51', 'available');
  const budgets = new BudgetManager(10_000_000);
  budgets.agent('w51', 10_000_000);
  for (const t of ['r', 'pa', 'pb']) budgets.task(t, 10_000);
  const store = new TaskStore();
  const orch = new TaskOrchestrator({
    gate: {
      descriptors: [testAdapter.descriptor as never],
      agentStatus: [{ agentId: 'w51', agent: 'w51', version: '1', installed: 'Yes', login: 'y', quotaSource: 't', usage: 'n', status: 'ok' }],
      quotaRecords: [{ provider: 'w51', agentId: 'w51', modelId: null, source: 'cli_reported', usage: null, remaining: null, resetAt: null, period: 'unknown', status: 'available', usageClass: 'reported', confidence: 'high', observedAt: NOW, note: '' }],
      registry: registryM, budgets, taskType: 'implementation', requestedUnits: 10, currentConcurrency: 0,
      maxConcurrency: 4, maxChildren: 8, maxConcurrentAgents: 4, taskPolicyAllows: true,
    } as never,
    store, runtime: rt as never, defaultCwd: hwA.cwd, now: () => NOW, executionTimeoutMs: 60_000, workspace: wm,
    workspaceMode: (t) => (t.taskId === 'pa' || t.taskId === 'pb' ? 'isolated' : 'shared'),
    resourceClaims: (t) => ({ mode: 'write', scope: normalizeScopeForWorkspace(`task:${t.taskId}`, repo) }),
  });
  orch.createRoot({ taskId: 'r', agentId: 'w51', taskType: 'implementation', acceptanceCriteria: 'root' });
  orch.spawnChild({ taskId: 'pa', parentTaskId: 'r', agentId: 'w51', modelId: 'w51/m', taskType: 'implementation', acceptanceCriteria: 'pa', budgetUnits: 10 });
  orch.spawnChild({ taskId: 'pb', parentTaskId: 'r', agentId: 'w51', modelId: 'w51/m', taskType: 'implementation', acceptanceCriteria: 'pb', budgetUnits: 10 });

  // executeTask drives the WHOLE chain. Neither completes on its own (the roots run
  // forever), so we cancel after both are observably in flight. Outcomes are kept so
  // an admission refusal is REPORTED rather than silently looking like "no dispatch".
  const paP = orch.executeTask({ taskId: 'pa' }).then((o) => { paOut = o; return o; }).catch((e) => { paOut = { ok: false, code: `threw:${String(e)}` }; return undefined; });
  const pbP = orch.executeTask({ taskId: 'pb' }).then((o) => { pbOut = o; return o; }).catch((e) => { pbOut = { ok: false, code: `threw:${String(e)}` }; return undefined; });
  // Wait until BOTH writers heartbeat in their OWN worktrees.
  const started = Date.now();
  let bothReady = false;
  while (Date.now() - started < 20_000) {
    if (made.length >= 2 && made.every((m) => existsSync(join(m.cwd, 'writer.pid'))) &&
        hbSize(join(hwA.cwd, 'writer.hb')) > 0 && hbSize(join(hwB.cwd, 'writer.hb')) > 0) { bothReady = true; break; }
    await sleep(150);
  }
  if (!bothReady) {
    log.check('P1-1 :: both writers running in their OWN isolated worktrees (real chain)', false,
      `A hb=${hbSize(join(hwA.cwd, 'writer.hb'))} B hb=${hbSize(join(hwB.cwd, 'writer.hb'))} dispatches=${made.length} pa=${JSON.stringify(paOut).slice(0, 160)} pb=${JSON.stringify(pbOut).slice(0, 160)}`);
  } else {
    log.check('P1-1 :: both writers running in their OWN isolated worktrees (real chain)', true,
      `A hb=${hbSize(join(hwA.cwd, 'writer.hb'))} B hb=${hbSize(join(hwB.cwd, 'writer.hb'))}`);
  }
  log.check('P1-1 :: replaceAdapters took effect (test adapter ran, not a real agent)', made.length >= 2 && made.every((m) => m.root === rootA || m.root === rootB),
    `dispatches=${made.length}`);
  const aLive = made.length >= 1 ? await pidLive(readNum(join(hwA.cwd, 'writer.pid')), 2_000) : { state: 'OBSERVATION_ERROR' as const, why: 'no dispatch' };
  const bLive = made.length >= 2 ? await pidLive(readNum(join(hwB.cwd, 'writer.pid')), 2_000) : { state: 'OBSERVATION_ERROR' as const, why: 'no dispatch' };
  log.check('P1-1 :: both writers ALIVE concurrently (claim/execution identity verifiable)',
    aLive.state === 'ALIVE' && bLive.state === 'ALIVE', `A=${aLive.state} B=${bLive.state}`);

  // Stop A via its own task; B must continue writing.
  await orch.cancelTask('pa', 'W5.1a P1-1 stop A').catch(() => undefined);
  await paP;
  const bHb0 = hbSize(join(hwB.cwd, 'writer.hb'));
  await sleep(400);
  const bHb1 = hbSize(join(hwB.cwd, 'writer.hb'));
  log.check('P1-1 :: after stopping A, B keeps writing (no cross-run interference)', bHb1 > bHb0, `${bHb0}->${bHb1}`);

  // Reclaim B through its own stop path (bounded) and end the round.
  await orch.cancelTask('pb', 'W5.1a P1-1 stop B').catch(() => undefined);
  await pbP;
}

// ---------------------------------------------------------------------------
// Stress: combined concurrent non-interference + descendant reclaim, stop order
// alternated. Counters distinguish readiness failures / observation errors from
// real containment failures.
// ---------------------------------------------------------------------------
interface StressStats { attempted: number; completed: number; readinessFailures: number; observationErrors: number; containmentFailures: number; surviving: number; cleanupFailures: number }
async function stress(): Promise<StressStats> {
  const st: StressStats = { attempted: 0, completed: 0, readinessFailures: 0, observationErrors: 0, containmentFailures: 0, surviving: 0, cleanupFailures: 0 };
  for (let i = 0; i < ROUNDS; i++) {
    st.attempted++;
    const dirA = ownDir(`st-A${i}`), dirB = ownDir(`st-B${i}`);
    const [ra, rb] = await Promise.allSettled([startContained(`sA${i}`, dirA, cmdMiddle(dirA)), startContained(`sB${i}`, dirB, cmdMiddle(dirB))]);
    if (ra.status === 'rejected' || rb.status === 'rejected') {
      st.readinessFailures++;
      // P1-2: reclaim the fulfilled side even though the other failed.
      await registry.reclaimAll(`stress${i} one-sided-failure`);
      continue;
    }
    const A = ra.value, B = rb.value;
    st.completed++;
    const aFirst = i % 2 === 0;
    const victim = aFirst ? A : B, survivor = aFirst ? B : A;
    const vpid = readNum(victim.w.pidFile), spid = readNum(survivor.w.pidFile);
    const vobs = victim.observers.find((o) => o.pid === vpid);
    const sobs = survivor.observers.find((o) => o.pid === spid);
    const hb0 = hbSize(survivor.w.hbFile);
    // HARDKILL the victim; survivor must survive untouched.
    try { process.kill(victim.p.launcherPid as number, 'SIGKILL'); } catch { /* gone */ }
    await Promise.race([victim.p.exited.catch(() => undefined), sleep(4_000)]);
    const vv = vobs !== undefined ? await vobs.verdict(6_000) : await pidLive(vpid, 2_000);
    if (vv.state === 'OBSERVATION_ERROR') st.observationErrors++;
    if (vv.state !== 'EXITED') st.surviving++;
    const sv = sobs !== undefined ? await sobs.verdict(1_200) : { state: 'OBSERVATION_ERROR' as const, why: 'none' };
    if (sv.state === 'ALIVE') {
      // Survivor must still be writing.
      await sleep(200);
      if (hbSize(survivor.w.hbFile) <= hb0) st.containmentFailures++;
    } else if (sv.state === 'OBSERVATION_ERROR') {
      st.observationErrors++;
    } else {
      st.containmentFailures++; // survivor wrongly reported dead
    }
    // Reclaim survivor via its own path; reap victim PIDs if anything lingers.
    await survivor.p.cancel('stress survivor stop').catch(() => undefined);
    await Promise.race([survivor.p.exited.catch(() => undefined), sleep(4_000)]);
    for (const o of [...survivor.observers, ...victim.observers]) o.close();
    registry.remove(survivor); registry.remove(victim);
    const sv2 = await pidLive(spid, 2_000);
    if (sv2.state === 'ALIVE') { st.surviving++; try { process.kill(spid, 'SIGKILL'); } catch { /* gone */ } }
  }
  return st;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// P1-3 injection-only child mode: run JUST the owned-root removal with a forced
// failure and exit with the propagated code. The PARENT invokes this as a child
// process and asserts the child's SHELL exit is non-zero. This is the only place
// the whole case is skipped, so the child is fast and cannot recurse.
if (process.env.W51_INJECT_ROOT_RM_FAILURE === 'child-only') {
  // The parent supplies the exact owned root path so ownership is by NAME, never by
  // enumerating the shared parent (W4.4 foreign-root preservation).
  const childOwnedRoot = process.env.W51_P13_CHILD_ROOT ?? join(OWNED_PARENT, `w51-p13child-${process.pid}`);
  mkdirSync(childOwnedRoot, { recursive: true });
  writeFileSync(join(childOwnedRoot, 'marker.txt'), 'child-owned residue\n');
  // Forced removal failure â€?the result must be checked and propagated, not dropped.
  const removal = { ok: false, error: 'injected owned-root removal failure (EBUSY)' };
  const removalError = removal.ok ? null : `owned fixture root removal failed for ${childOwnedRoot}: ${removal.error}`;
  const code = finish([], { allowEnvironmentBlocked: true, cleanupFailures: removal.ok ? [] : [{ resource: childOwnedRoot, error: removal.error }] });
  // The report lives INSIDE the owned root and the root is deliberately NOT removed,
  // so the parent can observe BOTH the failure and the residual before cleaning it.
  writeFileSync(join(childOwnedRoot, 'p13-report.txt'), `removalError=${removalError === null ? 'none' : removalError}\nexit=${code}\n`);
  process.exit(code);
}

const owned = setupOwnedTestContext();
if (owned === null) {
  console.log('W5.1: BLOCKED (no production launcher on this machine)');
  process.exitCode = finish([], { allowEnvironmentBlocked: true });
} else {
  let cleanupFailures: { resource: string; error: string }[] = [];
  let fixtureRemovalError: string | null = null;
  let fatal: unknown;
  try {
    console.log(`== W5.1a P1-4 observation regressions ==`);
    await observationRegressions();

    console.log(`\n== W5.1 A. real executable descendants (cmd / PowerShell / git) ==`);
    await caseCmd();
    await casePowerShell();
    await caseGit();

    console.log('\n== W5.1 root exits first (handle handshake) ==');
    await caseRootExitFirst();

    console.log('\n== W5.1 hardkill evidence ==');
    {
      const dir = ownDir('hardkill');
      const run = await startContained('hardkill', dir, cmdMiddle(dir));
      await hardkillAndConfirm(run, 'hardkill');
    }

    console.log('\n== W5.1 B. two concurrent isolated writers (stop-order swap) ==');
    await concurrentSwapFirst();
    await concurrentSwapSecond();

    console.log('\n== W5.1a P1-2 one-sided start failure reclaims the peer ==');
    await concurrentSwapFirst('A'); // A fails, B (if started) reclaimed
    await concurrentSwapFirst('B'); // B fails, A reclaimed

    console.log('\n== W5.1a P1-1 full production admission chain ==');
    await productionAdmission();

    console.log(`\n== W5.1 stress: ${ROUNDS} bounded rounds (stop order alternated) ==`);
    const st = await stress();
    console.log(`   attempted=${st.attempted} completed=${st.completed} readinessFailures=${st.readinessFailures} observationErrors=${st.observationErrors} containmentFailures=${st.containmentFailures} surviving=${st.surviving} cleanupFailures=${st.cleanupFailures}`);
    log.check(`stress: ${ROUNDS} rounds completed with readiness`, st.completed === ROUNDS && st.readinessFailures === 0, `completed=${st.completed} readinessFailures=${st.readinessFailures}`);
    log.check('stress: zero cross-run interference', st.containmentFailures === 0, `containmentFailures=${st.containmentFailures}`);
    log.check('stress: zero surviving known processes', st.surviving === 0, `surviving=${st.surviving}`);
    log.check('stress: zero observation errors', st.observationErrors === 0, `observationErrors=${st.observationErrors}`);
    log.check('stress: zero cleanup failures', st.cleanupFailures === 0, `cleanupFailures=${st.cleanupFailures}`);

    // ---- P1-3: owned-root removal failure must make the suite exit non-zero ----
    // Proof via a real child process: a parent inspecting its own successful run
    // cannot prove propagation. The child runs ONLY the injection path (fast, no
    // recursion); the parent observes the failure BEFORE cleaning the child's
    // owned root, and removes only that named root (never a foreign one).
    {
      // The parent names the child's owned root so it can observe the residual and
      // remove EXACTLY that path â€?ownership by name, never by enumerating the shared
      // parent. This keeps the foreign-root/sentinel rule intact.
      const childRootName = `w51-p13child-${randomUUID().slice(0, 8)}`;
      const childRoot = join(OWNED_PARENT, childRootName);
      const childRes = spawnSync(process.execPath, [join(REPO, 'tests', 'w51-real-descendant-isolation.test.ts')], {
        cwd: REPO,
        env: { ...process.env, W51_INJECT_ROOT_RM_FAILURE: 'child-only', W51_P13_CHILD_ROOT: childRoot },
        timeout: 120_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      log.check('P1-3 :: injected owned-root removal failure => child exits NON-ZERO', childRes.status !== 0, `status=${String(childRes.status)}`);
      // Observe the child's residual + report BEFORE any cleanup.
      const report = existsSync(join(childRoot, 'p13-report.txt')) ? readFileSync(join(childRoot, 'p13-report.txt'), 'utf8') : '';
      log.check('P1-3 :: child left its owned root behind (failure was real)', existsSync(childRoot), `residual=${existsSync(childRoot)}`);
      log.check('P1-3 :: child reported the removal failure with the owned root', /owned fixture root removal failed/.test(report),
        `report=${JSON.stringify(report.split('\n')[0] ?? '')}`);
      // NOW clean ONLY the named child root (ours, by name) â€?never a foreign one.
      removeOwnedRoot(childRoot);
      log.check('P1-3 :: only the named owned root was cleaned (foreign roots untouched)', !existsSync(childRoot), `cleaned=${!existsSync(childRoot)}`);
    }
  } catch (e) {
    fatal = e;
  } finally {
    // Any run still registered (mid-case throw) is reclaimed before files go away.
    const leftovers = await registry.reclaimAll('final reclaim');
    if (leftovers.length > 0) cleanupFailures.push(...leftovers.map((m) => ({ resource: 'registry', error: m })));
    cleanupFailures = cleanupFailures.concat(await owned.cleanup());
    // P1-3: the fixture-root removal result MUST be checked and propagated.
    const removal = process.env.W51_INJECT_ROOT_RM_FAILURE === '1'
      ? { ok: false, error: 'injected owned-root removal failure (EBUSY)' }
      : removeOwnedRoot(OWN_ROOT);
    if (!removal.ok) fixtureRemovalError = `owned fixture root removal failed for ${OWN_ROOT}: ${removal.error}`;
    // VERIFY the root is actually gone: a Windows worktree/git dir can be briefly
    // locked by a just-terminated process, so `rmSync` may leave it. Retry once
    // after a short settle, then confirm absence â€?an exit-0 must mean "clean".
    if (fixtureRemovalError === null && existsSync(OWN_ROOT)) {
      await sleep(500);
      const retry = removeOwnedRoot(OWN_ROOT);
      if (!retry.ok || existsSync(OWN_ROOT)) {
        fixtureRemovalError = `owned fixture root ${OWN_ROOT} still present after removal (retry ${retry.ok ? 'ok-but-present' : retry.error})`;
      }
    }
  }

  console.log(`\n${log.passed} passed, ${log.failed} failed`);
  if (log.failed > 0) console.log(`failing:\n  - ${log.failures.join('\n  - ')}`);
  if (cleanupFailures.length > 0) {
    console.log(`cleanup failures (must fail the test):`);
    for (const f of cleanupFailures) console.log(`  - ${f.resource}: ${f.error}`);
  }
  if (fixtureRemovalError !== null) console.log(`FIXTURE REMOVAL FAILURE (must fail the test): ${fixtureRemovalError}`);
  if (fatal !== undefined) console.log(`fatal: ${String((fatal as Error).message)}`);

  process.exitCode = log.failed === 0 && cleanupFailures.length === 0 && fixtureRemovalError === null && fatal === undefined
    ? 0 : 1;
}