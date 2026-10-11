/**
 * tests/w51-real-descendant-isolation.test.ts �?W5.1 / W5.1a real-descendant +
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
 * W5.1a �?THE FOUR P1s THIS FILE MUST NOT REGRESS
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
import { open as openObserver, livenessBestEffort, livenessNative, type Observer, type Liveness, type TerminateResult } from './helpers/process-observer.ts';
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
// Owned per-run root. Everything below lives inside it.
// ---------------------------------------------------------------------------
const RUN_ID = `w51-${process.pid}-${randomUUID().slice(0, 8)}`;
const OWN_ROOT = join(OWNED_PARENT, RUN_ID);
/*
 * The owned root is CREATED LAZILY, on first use, and NOT in the P1-3 child-only
 * mode. Creating it at module scope would leave an empty orphan behind whenever a
 * process exits through a path that skips the finalizer �?exactly the leak the
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
  // detached:false �?a DETACHED PowerShell on this host never runs the script.
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
  // W5.1b §5B: the root does NOT exit on a timer. It waits for an explicit RELEASE
  // gate written by the test, so the ordering "resources ready + observer acquired
  // -> root allowed to exit -> root handle signaled" is deterministic rather than a
  // race against a fixed sleep.
  const releaseFile = join(dir, 'release-root');
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
    `const releaseFile=${JSON.stringify(releaseFile)};`,
    `const exitAfterMs=${exitAfterMs ?? 'null'};`,
    "fs.writeFileSync(rootPidFile,String(process.pid));",
    "const c=spawn(middle.exe,middle.args,{cwd:middle.cwd,stdio:['ignore','pipe','pipe'],detached:detached,env:process.env});",
    "c.on('error',e=>{try{fs.appendFileSync(middle.errFile,'ERR:'+String(e.message)+'\\n')}catch{}});",
    "c.stderr.on('data',b=>{try{fs.appendFileSync(middle.errFile,String(b))}catch{}});",
    "fs.writeFileSync(midPidFile,String(c.pid));",
    "if(detached)c.unref();",
    // The root holds until the test EXPLICITLY releases it (a gate file appears), so
    // the handshake order is enforced by the test, not by a timing guess.
    "const hold=()=>{ try{ if(fs.existsSync(releaseFile)) process.exit(0); }catch{} };",
    "const holdTimer=setInterval(hold,25);",
    "if(exitAfterMs!==null){setTimeout(()=>{clearInterval(holdTimer);process.exit(0)},Number(exitAfterMs));}else{setInterval(()=>{},1000);}",
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
  /** Launcher PID once known (a generation too: it is an owned process). */
  launcherPid: number;
  observers: Observer[];
  /** §5A: generations whose identity could not be confirmed (never silently "ok"). */
  unobservableGenerations?: string[];
}

// ---------------------------------------------------------------------------
// W5.1c §3 �?ONE cleanup-truth decision, shared by every real cleanup path AND by
// the regressions. There is no second judgment function anywhere in this file.
// ---------------------------------------------------------------------------

/** Result of the stop attempt, kept as distinct facts (never collapsed to a bool). */
export type StopFact = 'CONFIRMED' | 'UNCONFIRMED' | 'TIMEOUT' | 'THREW';

export interface GenExitFact {
  name: string;
  pid: number;
  /** Whether a HELD, actually-acquired handle for this generation exists. */
  identityHeld: boolean;
  /** The observation fact obtained from that handle (or the honest "no fact"). */
  liveness: Liveness;
  /** Identity-bound terminate outcome, when a fallback was attempted. */
  fallback?: TerminateResult;
}

export interface CleanupInput {
  label: string;
  stop: StopFact;
  generations: GenExitFact[];
  /** Observers that did NOT exit within their bound (owned processes). */
  observerReapFailures: string[];
}

export interface CleanupCounters {
  stopFailures: number;
  unprovenExits: number;
  observationErrors: number;
  identityUnconfirmed: number;
  observerReapFailures: number;
  fallbackFailures: number;
}

export interface CleanupDecision {
  /** True only when EVERY fact is proven. An empty problem list is the only pass. */
  ok: boolean;
  /** Every failure, verbatim. A later success never removes an earlier entry. */
  problems: string[];
  counters: CleanupCounters;
  /** The exact per-generation facts that were judged (not recomputed later). */
  generations: GenExitFact[];
}

/**
 * The single fail-closed cleanup judgment.
 *
 * Rules, all of them non-negotiable:
 *  - a stop that is not CONFIRMED (false / timeout / threw) is a failure;
 *  - a generation WITHOUT a held handle can never be claimed dead, and no
 *    termination may be attempted for it (identity is unconfirmed);
 *  - a generation whose observation is ALIVE or OBSERVATION_ERROR is a failure;
 *  - a fallback that ran is ALWAYS reported, so a successful fallback can never
 *    erase the failure that triggered it; a fallback that did not confirm is
 *    itself counted;
 *  - an observer that did not exit is a failure (it is an owned process).
 */
export function decideCleanup(input: CleanupInput): CleanupDecision {
  const problems: string[] = [];
  const counters: CleanupCounters = {
    stopFailures: 0, unprovenExits: 0, observationErrors: 0,
    identityUnconfirmed: 0, observerReapFailures: 0, fallbackFailures: 0,
  };

  if (input.stop !== 'CONFIRMED') {
    counters.stopFailures++;
    problems.push(`stop ${input.label}: ${input.stop === 'UNCONFIRMED' ? 'cancel() returned false (stop NOT confirmed)'
      : input.stop === 'TIMEOUT' ? 'cancel() did not settle within the bound'
        : 'cancel() threw'}`);
  }

  for (const g of input.generations) {
    if (g.pid === 0) continue;
    if (!g.identityHeld) {
      // Identity is unconfirmed: we may neither claim death nor guess a kill.
      counters.identityUnconfirmed++;
      counters.unprovenExits++;
      problems.push(`${g.name} pid ${g.pid}: NO held handle; exit cannot be proven by identity and no termination was attempted`);
      continue;
    }
    if (g.liveness.state !== 'EXITED') {
      counters.unprovenExits++;
      if (g.liveness.state === 'OBSERVATION_ERROR') counters.observationErrors++;
      problems.push(`${g.name} pid ${g.pid}: exit NOT proven on the held handle: ${g.liveness.state}`
        + (g.liveness.state === 'OBSERVATION_ERROR' ? ` (${g.liveness.why})` : ''));
    }
    if (g.fallback !== undefined) {
      // Reported either way: a clean fallback must not hide the original failure.
      if (g.fallback.kind === 'EXIT_CONFIRMED') {
        problems.push(`${g.name} pid ${g.pid}: identity-bound fallback terminate CONFIRMED exit via the held handle (the unproven exit above still stands)`);
      } else if (g.fallback.kind === 'STILL_ALIVE') {
        counters.fallbackFailures++;
        problems.push(`${g.name} pid ${g.pid}: identity-bound fallback terminate left the process ALIVE (native ${g.fallback.native})`);
      } else if (g.fallback.kind === 'WAIT_FAILED') {
        counters.fallbackFailures++;
        problems.push(`${g.name} pid ${g.pid}: identity-bound fallback wait FAILED (${g.fallback.why})`);
      } else if (g.fallback.kind === 'TERMINATE_REFUSED') {
        counters.fallbackFailures++;
        problems.push(`${g.name} pid ${g.pid}: fallback terminate REFUSED on the held handle (${g.fallback.why}); nothing proven`);
} else if (g.fallback.kind === 'IDENTITY_UNCONFIRMED') {
        counters.fallbackFailures++;
        counters.identityUnconfirmed++;
        problems.push(`${g.name} pid ${g.pid}: fallback REFUSED — identity unconfirmed (${g.fallback.why}); NOTHING was killed`);
      } else if (g.fallback.kind === 'COMMAND_CHANNEL_LOST') {
        // W5.1d: the command channel broke, so no terminate was sent. That is a real
        // failure of the cleanup attempt and is always recorded. The accompanying
        // evidence is the HELD HANDLE's own statement about the target and is kept
        // separate: a proven EXITED there still means the exit is confirmed, but it
        // was NOT caused by our command, so it is not a missing exit.
        counters.fallbackFailures++;
        if (g.fallback.evidence.state === 'OBSERVATION_ERROR' && g.liveness.state !== 'OBSERVATION_ERROR') {
          // Only counted once: when the generation's own observation was already a
          // no-fact, this is the same missing fact seen through the other channel.
          counters.observationErrors++;
        }
        problems.push(`${g.name} pid ${g.pid}: command channel lost (${g.fallback.why}); no terminate was sent; `
          + `held-handle evidence=${g.fallback.evidence.state}`
          + (g.fallback.evidence.state === 'OBSERVATION_ERROR' ? ` (${g.fallback.evidence.why})` : ''));
      } else {
        counters.fallbackFailures++;
        counters.observationErrors++;
        problems.push(`${g.name} pid ${g.pid}: fallback observer lost (${g.fallback.why}); nothing proven`);
      }
    }
  }

  for (const f of input.observerReapFailures) {
    counters.observerReapFailures++;
    problems.push(`observer ${f}`);
  }

  return { ok: problems.length === 0, problems, counters, generations: input.generations };
}

/** Every known generation of a run, with the observer that holds its identity. */
function generationsOf(r: Run): GenExitFact[] {
  const wpid = readNum(r.w.pidFile);
  const raw: Array<{ name: string; pid: number }> = [
    { name: 'writer', pid: wpid },
    { name: 'middle', pid: r.midPid },
    { name: 'root', pid: r.rootPid },
    { name: 'launcher', pid: r.launcherPid },
  ];
  return raw.map((g) => ({
    name: g.name,
    pid: g.pid,
    identityHeld: r.observers.some((o) => o.pid === g.pid && o.holdsIdentity()),
    liveness: { state: 'OBSERVATION_ERROR', why: 'not observed yet' } as Liveness,
  }));
}

/**
 * THE single real cleanup path. Every caller (registry, stopAndConfirmAll,
 * hardkill, stress, productionAdmission) funnels its facts through here and then
 * through `decideCleanup`, so there is exactly one place where cleanup truth is
 * decided and exactly one place where a failure can be lost.
 */
async function cleanupRun(run: Run, why: string, opts?: { skipStop?: boolean }): Promise<CleanupDecision> {
  // 1. Stop via the owned containment path. false / timeout / throw are all distinct.
  let stop: StopFact = opts?.skipStop === true ? 'CONFIRMED' : 'CONFIRMED';
  if (opts?.skipStop !== true) {
    try {
      const r = await Promise.race([
        run.p.cancel(why),
        sleep(8_000).then(() => 'TIMEOUT' as const),
      ]);
      stop = r === 'TIMEOUT' ? 'TIMEOUT' : r === true ? 'CONFIRMED' : 'UNCONFIRMED';
    } catch {
      stop = 'THREW';
    }
    await Promise.race([run.p.exited.catch(() => undefined), sleep(5_000)]);
  }

  // 2. Exit proof per generation, on the STILL-HELD handle only.
  const gens = generationsOf(run);
  for (const g of gens) {
    if (g.pid === 0) continue;
    const obs = run.observers.find((o) => o.pid === g.pid);
    if (obs === undefined || !obs.holdsIdentity()) continue; // left as identity unconfirmed
    g.liveness = await obs.verdict(10_000);
  }

  // 3. Identity-bound fallback, ONLY for a generation whose identity IS held.
  //    It terminates through that same handle; it is never a pid reopen.
  for (const g of gens) {
    if (g.pid === 0 || g.liveness.state === 'EXITED') continue;
    if (!g.identityHeld) continue;
    const obs = run.observers.find((o) => o.pid === g.pid);
    if (obs === undefined) continue;
    g.fallback = await obs.terminateAndVerify(12_000);
  }

  // 4. Observers are owned processes: every reaped() result is inspected.
  const reapFailures: string[] = [];
  for (const o of run.observers) {
    const gone = await o.reaped(5_000);
    if (!gone) reapFailures.push(`for pid ${o.pid} did not exit within 5000ms`);
  }
  run.observers = [];

  return decideCleanup({ label: why, stop, generations: gens, observerReapFailures: reapFailures });
}

class RunRegistry {
  private runs: Run[] = [];
  /** Register immediately on creation �?never after readiness. */
  add(r: Run): Run { this.runs.push(r); return r; }
  remove(r: Run): void { this.runs = this.runs.filter((x) => x !== r); }
  all(): readonly Run[] { return this.runs; }

  /**
   * W5.1c §1: reclaim ONE run through the single real cleanup path.
   *
   * The run is removed from the registry ONLY when its cleanup actually
   * confirmed, so an unconfirmed run stays visible to the finalizer and cannot be
   * silently forgotten.
   */
  async reclaim(r: Run, why: string): Promise<string[]> {
    const decision = await cleanupRun(r, why);
    if (decision.ok) this.remove(r);
    return decision.problems;
  }

  async reclaimAll(why: string): Promise<string[]> {
    const problems: string[] = [];
    for (const r of [...this.runs]) problems.push(...(await this.reclaim(r, why)));
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
  const run: Run = { p, w, rootPid: 0, midPid: 0, launcherPid: 0, observers: [] };
  // P1-2: register the moment it exists, before any await that could fail.
  registry.add(run);

  const ready = await waitWriterReady(w, label, join(dir, 'mid.err'));
  if (!ready.ready) {
    // Reclaim ONLY this run: a global reclaim here would tear down a healthy peer
    // that a caller (e.g. startPair) is deliberately keeping alive.
    const problems = await registry.reclaim(run, `${label} readiness-failed`);
    throw new Error(`${ready.why}${problems.length > 0 ? ` | cleanup: ${problems.join(' | ')}` : ''}`);
  }
  run.rootPid = readNum(root.rootPidFile);
  run.midPid = readNum(root.midPidFile);
  run.launcherPid = (p.launcherPid as number | null) ?? 0;

  // P1-4 / §5A: acquire and HOLD the ORIGINAL handle of EVERY known generation
  // (root, middle, writer, launcher) BEFORE any stop is triggered, so each
  // generation's exit can later be proven on its own identity rather than inferred
  // from "the end writer died". A generation whose identity is not confirmable is
  // recorded, not quietly treated as proven.
  const known: Array<{ name: string; pid: number }> = [
    { name: 'root', pid: run.rootPid },
    { name: 'middle', pid: run.midPid },
    { name: 'writer', pid: readNum(w.pidFile) },
    { name: 'launcher', pid: run.launcherPid },
  ];
  const unobservable: string[] = [];
  for (const g of known) {
    if (g.pid === 0) continue;
    const obs = openObserver(g.pid);
    if (obs !== null && await obs.acquired()) run.observers.push(obs);
    else { if (obs !== null) run.observers.push(obs); unobservable.push(g.name); } // still cleaned up
  }
  // The writer is mandatory: without its handle the primary exit proof is gone.
  if (unobservable.includes('writer')) {
    await registry.reclaim(run, `${label} writer-identity-unavailable`);
    throw new Error(`${label}: writer identity not confirmable (${unobservable.join(',')})`);
  }
  run.unobservableGenerations = unobservable;

  return run;
}

// ---------------------------------------------------------------------------
// Stop a run via the production cooperative path; confirm EVERY known generation
// exited on ITS OWN held-handle identity (§5A) �?not just the writer, and never a
// "the end process died so the tree is gone" inference.
// ---------------------------------------------------------------------------
async function stopAndConfirmAll(run: Run, label: string): Promise<boolean> {
  // W5.1c §1: the stop result and EVERY cleanup fact are judged by the SAME
  // `cleanupRun`/`decideCleanup` path the stress loop uses. Nothing here can be
  // dropped, and a successful fallback cannot erase a failure.
  const decision = await cleanupRun(run, `${label} stop`);
  const facts = run.p.containment;

  log.check(`${label} :: cooperative stop CONFIRMED (treeStopConfirmed)`,
    run.p.isTreeStopConfirmed() === true && decision.counters.stopFailures === 0,
    `isTreeStopConfirmed=${String(run.p.isTreeStopConfirmed())} stopFailures=${decision.counters.stopFailures}`);
  log.check(`${label} :: validated control reports terminated (ActiveProcesses==0)`,
    facts !== null && facts.treeStopConfirmed === true, `launcherStatus=${String((facts as { launcherStatus?: string } | null)?.launcherStatus)}`);

  // §5A: every KNOWN generation, each verified on its own held handle.
  for (const g of decision.generations) {
    if (g.pid === 0) continue;
    const proven = g.identityHeld && g.liveness.state === 'EXITED';
    log.check(`${label} :: ${g.name} PID ${g.pid} REALLY exited (held-handle evidence)`, proven,
      g.identityHeld ? `verdict=${g.liveness.state}${g.liveness.state === 'OBSERVATION_ERROR' ? ` (${g.liveness.why})` : ''}`
        : 'no held handle (identity unconfirmed)');
  }
  log.check(`${label} :: cleanup produced no unresolved failure`, decision.ok, `problems=${decision.problems.length}`);
  for (const p of decision.problems) console.log(`   cleanup[${label}]: ${p}`);

  if (decision.ok) registry.remove(run);
  return decision.ok;
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

/**
 * Root exits FIRST �?an explicit release handshake, not a fixed timer (§5B).
 *
 * Order: writer ready + heartbeat advancing -> root observer handle ACQUIRED ->
 * test explicitly releases the root -> root's own handle signaled -> descendant
 * still alive and STILL heartbeating -> launcher still alive ->
 * treeStopConfirmed is false -> Job reclaimed through the normal stop path.
 */
async function caseRootExitFirst(): Promise<void> {
  const dir = ownDir('a4-root-exit');
  // No W51_ROOT_EXIT_MS: the root holds until released via the gate file.
  const run = await startContained('A4 root-exit-first', dir, cmdMiddle(dir));
  const wpid = readNum(run.w.pidFile);

  // Hold the ROOT's original handle BEFORE releasing it, so the root's exit is
  // same-process proven rather than inferred from a PID no longer being open.
  const robs = openObserver(run.rootPid);
  const rootHandle = robs !== null ? await robs.acquired() : false;
  log.check('A4 root-exit-first: root handle acquired before release', rootHandle, `rootPid=${run.rootPid}`);
  if (robs !== null && rootHandle) run.observers.push(robs);
  // Also hold the writer so "still writing" is observed on a confirmed identity.

  // 1. Confirm the descendant is writing BEFORE the root exits.
  const hbBefore = hbSize(run.w.hbFile);
  log.check('A4 root-exit-first: descendant heartbeat present before root release', hbBefore > 0, `hb=${hbBefore}`);

  // 2. EXPLICITLY release the root (the gate file it is polling).
  writeFileSync(join(dir, 'release-root'), 'release\n');

  // 3. Wait for the ROOT's own handle to signal.
  const rv = robs !== null ? await robs.verdict(10_000) : { state: 'OBSERVATION_ERROR' as const, why: 'no observer' };
  log.check('A4 root-exit-first: root exited on its own (held handle signaled)', rv.state === 'EXITED', `verdict=${rv.state}${rv.state === 'OBSERVATION_ERROR' ? ` (${rv.why})` : ''}`);

  // 4. The descendant must STILL be alive AND STILL writing after the root exit.
  const writerLive = await livenessNative(wpid, 1_200);
  log.check('A4 root-exit-first: descendant writer SURVIVED the root exit (held handle)', writerLive.state === 'ALIVE',
    `writerPid=${wpid} verdict=${writerLive.state}${writerLive.state === 'OBSERVATION_ERROR' ? ` (${writerLive.why})` : ''}`);
  const hbAfter = hbSize(run.w.hbFile);
  log.check('A4 root-exit-first: descendant heartbeat CONTINUES after root exit', hbAfter > hbBefore, `${hbBefore}->${hbAfter}`);

  // 5. The launcher is still alive, and root exit is NOT treated as tree-stopped.
  log.check('A4 root-exit-first: launcher still alive while descendant lives', (run.p.launcherPid ?? 0) !== 0 && pidAliveCheap(run.p.launcherPid as number), `launcherPid=${String(run.p.launcherPid)}`);
  log.check('A4 root-exit-first: root exit is NOT tree-stopped', run.p.isTreeStopConfirmed() === false, `isTreeStopConfirmed=${String(run.p.isTreeStopConfirmed())}`);

  // 6. Reclaim through the normal stop path.
  await stopAndConfirmAll(run, 'A4 root-exit-first reclaim');
}

/** Hardkill: physical death proven per-generation; NO fabricated treeStopConfirmed. */
async function hardkillAndConfirm(run: Run, label: string): Promise<void> {
  const wpid = readNum(run.w.pidFile);
  // W5.1c §2: the launcher is terminated THROUGH ITS OWN HELD HANDLE, not by pid.
  // A bare `process.kill(pid)` acts on whatever the OS maps that pid to.
  const lobs = run.observers.find((o) => o.pid === run.launcherPid);
  let launcherKill: TerminateResult;
  if (lobs === undefined || !lobs.holdsIdentity()) {
    launcherKill = { kind: 'IDENTITY_UNCONFIRMED', why: 'no held launcher handle; refusing to terminate by pid' };
  } else {
    launcherKill = await lobs.terminateAndVerify(10_000);
  }
  log.check(`${label} :: launcher terminated through its HELD handle (identity-bound)`,
    launcherKill.kind === 'EXIT_CONFIRMED', `terminate=${launcherKill.kind}`);
  await Promise.race([run.p.exited.catch(() => undefined), sleep(5_000)]);

  // W5.1c §1: the rest of the cleanup is judged by the SAME shared decision the
  // stress loop uses. The launcher was already terminated, so its stop fact is not
  // re-asserted here; every other generation is judged on its own held handle.
  const decision = await cleanupRun(run, `${label} post-hardkill reclaim`, { skipStop: true });
  const writer = decision.generations.find((g) => g.name === 'writer');
  log.check(`${label} :: hardkill: writer PID ${wpid} physically exited (held handle)`,
    writer !== undefined && writer.liveness.state === 'EXITED',
    `verdict=${writer === undefined ? 'no generation' : writer.liveness.state}${writer !== undefined && writer.liveness.state === 'OBSERVATION_ERROR' ? ` (${writer.liveness.why})` : ''}`);
  log.check(`${label} :: hardkill: no fabricated treeStopConfirmed from death alone`,
    run.p.isTreeStopConfirmed() === false || run.p.containment === null,
    `isTreeStopConfirmed=${String(run.p.isTreeStopConfirmed())}`);
  log.check(`${label} :: hardkill: no unresolved cleanup failure`, decision.ok, `problems=${decision.problems.length}`);
  for (const p of decision.problems) cleanupFailures.push({ resource: label, error: p });
  if (decision.ok) registry.remove(run);
}

// ---------------------------------------------------------------------------
// B. Two concurrent isolated writers, symmetric stop.
// ---------------------------------------------------------------------------
/**
 * Suite-level cleanup ledger. W5.1b §2: this MUST be populated from ACTUAL results
 * (cancel failures, unproven exits, reap outcomes, removal results) �?it is never
 * left at its initial empty value by a path that swallowed something.
 *
 * Declared at module scope so EVERY cleanup path (including the production
 * admission chain's own finally) feeds the SAME ledger that decides the exit code.
 */
const cleanupFailures: { resource: string; error: string }[] = [];
let fixtureRemovalError: string | null = null;
let fatal: unknown;

const hbSize = (p: string): number => { try { return readFileSync(p, 'utf8').length; } catch { return 0; } };

async function stopOneSurvives(victim: Run, survivor: Run, label: string): Promise<void> {
  const spid = readNum(survivor.w.pidFile);
  const s0 = hbSize(survivor.w.hbFile);
  // W5.1c §1: the victim's cleanup goes through the SAME shared decision. Its
  // cancel() result and every reaped() result are judged, not discarded.
  const vDecision = await cleanupRun(victim, `${label} victim stop`);
  const vWriter = vDecision.generations.find((g) => g.name === 'writer');
  log.check(`${label} :: victim writer (pid-bound held handle) exited (same-process)`,
    vWriter !== undefined && vWriter.liveness.state === 'EXITED',
    `verdict=${vWriter === undefined ? 'none' : vWriter.liveness.state}`);
  log.check(`${label} :: victim cleanup produced no unresolved failure`, vDecision.ok, `problems=${vDecision.problems.length}`);
  for (const p of vDecision.problems) cleanupFailures.push({ resource: `${label} victim`, error: p });
  if (vDecision.ok) registry.remove(victim);

  // §3: the survivor is ALIVE, so use a NATIVE WAIT_TIMEOUT fact (not a
  // client-bounded verdict that can only end in "no fact").
  const sLive = await livenessNative(spid, 900);
  log.check(`${label} :: survivor writer ${spid} STILL alive after victim's stop`, sLive.state === 'ALIVE', `verdict=${sLive.state}`);
  if (sLive.state === 'OBSERVATION_ERROR') cleanupFailures.push({ resource: `${label} survivor`, error: `survivor liveness not observed: ${sLive.why}` });
  await sleep(300);
  const s1 = hbSize(survivor.w.hbFile);
  log.check(`${label} :: survivor heartbeat CONTINUES after victim's stop`, s1 > s0, `${s0}->${s1}`);
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
    // W5.1c §1/§3-E: the peer's exit is proven through the SAME shared decision the
    // stress loop uses, on ITS OWN held handle. `state !== 'ALIVE'` is NOT a death
    // proof and must never appear here.
    const peerDecision = survivor !== undefined
      ? await cleanupRun(survivor, `${label} post-failure`)
      : decideCleanup({ label: `${label} post-failure`, stop: 'UNCONFIRMED', generations: [], observerReapFailures: ['no peer was started'] });
    log.check(`${label} :: the started peer was reclaimed with no unresolved failure`,
      before >= 1 && peerDecision.ok, `registeredBefore=${before} problems=${peerDecision.problems.length}`);
    for (const p of peerDecision.problems) cleanupFailures.push({ resource: `${label} post-failure`, error: p });
    if (peerDecision.ok) registry.remove(survivor as Run);
    log.check(`${label} :: nothing owned remains registered after the failure`, registry.all().length === 0,
      `stillRegistered=${registry.all().length}`);
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
  // (a) real live target => a NATIVE WAIT_TIMEOUT yields a real ALIVE fact.
  const live = spawn(NODE, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true, detached: false });
  const liveObs = openObserver(live.pid as number, { holdMs: 700 });
  const liveAcq = liveObs !== null ? await liveObs.acquired() : false;
  log.check('W5.1b P1-4 :: observer acquired the handle of a live target', liveAcq, `pid=${live.pid}`);
  if (liveObs !== null && liveAcq) {
    const v = await liveObs.verdict(4_000);
    log.check('W5.1b P1-4 :: live target => ALIVE via NATIVE WAIT_TIMEOUT (a real fact)', v.state === 'ALIVE',
      `verdict=${v.state}${v.state === 'OBSERVATION_ERROR' ? ` (${v.why})` : ''}`);
    await liveObs.reaped(5_000);
  }

  // (b) real terminated target => EXITED (same-process proof, held handle).
  const dying = spawn(NODE, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true, detached: false });
  const obs2 = openObserver(dying.pid as number);
  const acq = obs2 !== null ? await obs2.acquired() : false;
  if (obs2 !== null && acq) {
    try { dying.kill('SIGKILL'); } catch { /* gone */ }   // our own direct child: killed through node's handle, not a bare pid
    const v2 = await obs2.verdict(8_000);
    log.check('W5.1b P1-4 :: terminated target => EXITED (held handle signaled)', v2.state === 'EXITED',
      `verdict=${v2.state}${v2.state === 'OBSERVATION_ERROR' ? ` (${v2.why})` : ''}`);
    await obs2.reaped(5_000);
  } else {
    log.check('W5.1b P1-4 :: terminated target => EXITED (held handle signaled)', false, 'handle not acquired');
  }

  // (c) unobservable pid => exactly OBSERVATION_ERROR, never a death.
  const bad = openObserver(0xFFFFFF);
  if (bad === null) {
    // A missing capability is NOT a pass (§5D).
    log.check('W5.1b P1-4 :: unobservable pid => OBSERVATION_ERROR (fixture available)', false,
      'ENVIRONMENT_BLOCKED: native observe fixture missing, cannot verify the unobservable case');
  } else {
    const badAcq = await bad.acquired();
    const v3 = await bad.verdict(2_000);
    log.check('W5.1b P1-4 :: unobservable pid => exactly OBSERVATION_ERROR (never EXITED, never pass-by-default)',
      v3.state === 'OBSERVATION_ERROR', `acquired=${badAcq} verdict=${v3.state} why=${v3.state === 'OBSERVATION_ERROR' ? v3.why : ''}`);
    await bad.reaped(3_000);
  }

  // (d) §3: a CLIENT-side wait that expires is NOT a native WAIT_TIMEOUT, so it must
  // NOT be reported as ALIVE �?it is "no fact" and may never satisfy a death check.
  const slow = spawn(NODE, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true, detached: false });
  const obs4 = openObserver(slow.pid as number, { holdMs: 120_000 }); // native wait deliberately outlives the client bound
  if (obs4 !== null && await obs4.acquired()) {
    const v4 = await obs4.verdict(500); // client expires long before the native wait
    log.check('W5.1b P1-4 :: client wait expiry => OBSERVATION_ERROR, NOT a fabricated ALIVE', v4.state === 'OBSERVATION_ERROR',
      `verdict=${v4.state}${v4.state === 'OBSERVATION_ERROR' ? ` (${v4.why})` : ''}`);
    await obs4.reaped(5_000);
  }
  try { live.kill('SIGKILL'); } catch { /* gone */ }
  try { slow.kill('SIGKILL'); } catch { /* gone */ }   // our own direct children
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
  const made: { agentId: string; cwd: string; root: string }[] = [];
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
      // §4: record the REAL RunRequest identity. req.agentId is the AGENT, never a
      // taskId; the task identity is carried by the worktree cwd the task was given.
      made.push({ agentId: req.agentId, cwd: req.cwd, root });
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
  // forever), so it is cancelled after both are observably in flight.
  //
  // W5.1b §4: the dispatch is wrapped in try/finally so that ANY failure �?a
  // one-sided start, an observation failure, or a mid-case throw �?still cancels
  // both tasks through their OWN task/runtime paths, waits bounded, and verifies the
  // controlled processes exited BEFORE any worktree is released or deleted.
  const p1Problems: string[] = [];
  const stoppedIds = new Set<string>();
  const stopTask = async (id: string, why: string): Promise<void> => {
    // Stop via the task's own path. A task already stopped by an earlier step is not
    // a failure (idempotent cleanup); a refusal on a task that IS still running is.
    if (stoppedIds.has(id)) return;
    const res = await orch.cancelTask(id, why).catch((e) => ({ ok: false, code: `threw:${String(e)}` }));
    if (res.ok === true) { stoppedIds.add(id); return; }
    if (res.code === 'task-not-cancellable') { stoppedIds.add(id); return; } // already terminal
    p1Problems.push(`cancelTask(${id}) not ok: ${JSON.stringify(res).slice(0, 120)}`);
  };
  let paP: Promise<unknown> = Promise.resolve(undefined);
  let pbP: Promise<unknown> = Promise.resolve(undefined);
  // Declared OUTSIDE the try so the finally can reap observers even when the body throws.
  const writerObs = new Map<string, Observer>();
  try {
    paP = orch.executeTask({ taskId: 'pa' }).then((o) => { paOut = o; return o; }).catch((e) => { paOut = { ok: false, code: `threw:${String(e)}` }; return undefined; });
    pbP = orch.executeTask({ taskId: 'pb' }).then((o) => { pbOut = o; return o; }).catch((e) => { pbOut = { ok: false, code: `threw:${String(e)}` }; return undefined; });
    // Wait until BOTH writers heartbeat in their OWN worktrees.
    const started = Date.now();
    let bothReady = false;
    while (Date.now() - started < 20_000) {
      if (made.length >= 2 && made.every((m) => existsSync(join(m.cwd, 'writer.pid'))) &&
          hbSize(join(hwA.cwd, 'writer.hb')) > 0 && hbSize(join(hwB.cwd, 'writer.hb')) > 0) { bothReady = true; break; }
      await sleep(150);
    }
    log.check('P1-1 :: both writers running in their OWN isolated worktrees (real chain)', bothReady,
      bothReady ? `A hb=${hbSize(join(hwA.cwd, 'writer.hb'))} B hb=${hbSize(join(hwB.cwd, 'writer.hb'))}`
                : `A hb=${hbSize(join(hwA.cwd, 'writer.hb'))} B hb=${hbSize(join(hwB.cwd, 'writer.hb'))} dispatches=${made.length} pa=${JSON.stringify(paOut).slice(0, 140)} pb=${JSON.stringify(pbOut).slice(0, 140)}`);
    log.check('P1-1 :: replaceAdapters took effect (test adapter ran, not a real agent)', made.length >= 2 && made.every((m) => m.root === rootA || m.root === rootB),
      `dispatches=${made.length}`);
    // §4: real task/execution identity is recorded, and agentId is NOT mislabelled
    // as taskId. The dispatch cwd identifies which worktree each task received.
    log.check('P1-1 :: each dispatch received its own worktree cwd (task identity)', made.length >= 2 && made[0]?.cwd !== made[1]?.cwd,
      `A.cwd=${made[0]?.cwd ?? 'none'} B.cwd=${made[1]?.cwd ?? 'none'}`);
    const aLive = made.length >= 1 ? await pidLive(readNum(join(hwA.cwd, 'writer.pid')), 2_000) : { state: 'OBSERVATION_ERROR' as const, why: 'no dispatch' };
    const bLive = made.length >= 2 ? await pidLive(readNum(join(hwB.cwd, 'writer.pid')), 2_000) : { state: 'OBSERVATION_ERROR' as const, why: 'no dispatch' };
    log.check('P1-1 :: both writers ALIVE concurrently (claim/execution identity verifiable)',
      aLive.state === 'ALIVE' && bLive.state === 'ALIVE', `A=${aLive.state} B=${bLive.state}`);

    // Hold each writer's ORIGINAL handle from the moment it is known, so its later exit
    // is provable by identity even after the Job reaps it. A fresh OpenProcess after
    // reaping cannot distinguish "gone" from "unopenable", so the handle must be
    // acquired WHILE the process is alive.
    for (const [label, wd] of [['A', hwA.cwd], ['B', hwB.cwd]] as const) {
      const wp = readNum(join(wd, 'writer.pid'));
      if (wp === 0) continue;
      const o = openObserver(wp);
      if (o !== null && await o.acquired()) writerObs.set(label, o);
      else if (o !== null) writerObs.set(label, o); // still cleaned up
    }

    // Stop A via its own task; B must continue writing.
    await stopTask('pa', 'W5.1b P1-1 stop A');
    await paP;
    const bHb0 = hbSize(join(hwB.cwd, 'writer.hb'));
    await sleep(400);
    const bHb1 = hbSize(join(hwB.cwd, 'writer.hb'));
    log.check('P1-1 :: after stopping A, B keeps writing (no cross-run interference)', bHb1 > bHb0, `${bHb0}->${bHb1}`);
  } finally {
    // ALWAYS: stop both via their own task paths, bounded, and verify the controlled
    // processes exited �?BEFORE the caller removes any worktree.
    await stopTask('pa', 'W5.1b P1-1 finally A');
    await Promise.race([paP, sleep(6_000)]);
    await stopTask('pb', 'W5.1b P1-1 finally B');
    await Promise.race([pbP, sleep(6_000)]);
    // Verify the controlled writer processes actually exited (identity-bound) BEFORE
    // the caller removes any worktree.
    for (const [label, wd] of [['A', hwA.cwd], ['B', hwB.cwd]] as const) {
      const pid = readNum(join(wd, 'writer.pid'));
      if (pid === 0) continue;
      /*
       * W5.1c §1/§2: exit is proven on the handle HELD WHILE the writer was alive.
       * A fresh observation can never stand in for that proof, and there is NO
       * pid-only termination fallback any more: if the handle was never acquired,
       * the case records an identity failure and kills nothing.
       */
      const held = writerObs.get(label);
      if (held === undefined) {
        p1Problems.push(`${label} writer pid ${pid}: NO held handle; exit cannot be proven by identity (nothing terminated)`);
        continue;
      }
      const v = await held.verdict(12_000);
      if (v.state !== 'EXITED') {
        p1Problems.push(`${label} writer pid ${pid} exit NOT proven after task stop: ${v.state}${v.state === 'OBSERVATION_ERROR' ? ` (${v.why})` : ''}`);
        // Identity-bound fallback through that same handle. Reported separately so a
        // clean fallback can never erase the failure recorded above.
        const fb = await held.terminateAndVerify(12_000);
        p1Problems.push(`${label} writer pid ${pid} identity-bound fallback terminate => ${fb.kind}`);
      }
      const gone = await held.reaped(5_000);
      if (!gone) p1Problems.push(`productionAdmission ${label} observer did not exit within 5000ms`);
      writerObs.delete(label);
    }
    // Reap any observer still held (owned processes) and await their exit.
    for (const [label, o] of writerObs) {
      const gone = await o.reaped(5_000);
      if (!gone) p1Problems.push(`productionAdmission ${label} observer did not exit within 5000ms`);
    }
    writerObs.clear();
    for (const p of p1Problems) cleanupFailures.push({ resource: 'productionAdmission', error: p });
  }
}

/**
 * W5.1d — observer command-pipe / lifecycle boundary regressions.
 *
 * Each case starts its OWN controlled target (a direct child of this process, NOT a
 * contained run) so a failing probe cannot leak into the containment evidence. The
 * `finally` reclaims every observer AND the target itself, independently of whatever
 * the case asserted — a failing assertion must not leave a stray process behind.
 */
async function observerChannelBoundaryRegressions(): Promise<void> {
  const targets: ReturnType<typeof spawn>[] = [];
  const observers: Observer[] = [];
  const startTarget = (): number => {
    const t = spawn(NODE, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
    targets.push(t);
    return t.pid as number;
  };

  try {
    // --- 1. natural native timeout, with the exit NOT yet delivered to JS ---------
    // The event loop is deliberately blocked so the observer's exit notification has
    // not been processed when the terminate is requested: the write hits a dead pipe.
    {
      const pid = startTarget();
      const obs = openObserver(pid, { holdMs: 60 });
      if (obs === null) {
        log.check('W5.1d 1 :: natural timeout does not crash and yields a typed result', false, 'ENVIRONMENT_BLOCKED: fixture missing');
      } else {
        observers.push(obs);
        await obs.acquired();
        // Block the loop: the observer has already timed out natively, but JS has not
        // processed its exit yet. This is the exact W5.1d reproduction.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
        const r = await obs.terminateAndVerify(1_000);
        log.check('W5.1d 1 :: a dead command pipe yields COMMAND_CHANNEL_LOST, never a crash',
          r.kind === 'COMMAND_CHANNEL_LOST', `result=${JSON.stringify(r)}`);
        log.check('W5.1d 1 :: the lost channel did NOT fabricate an exit confirmation',
          r.kind !== 'EXIT_CONFIRMED', `result=${JSON.stringify(r)}`);
        log.check('W5.1d 1 :: the held handle still reports the truth (target still running)',
          r.kind === 'COMMAND_CHANNEL_LOST' && r.evidence.state === 'ALIVE',
          `evidence=${JSON.stringify(r.kind === 'COMMAND_CHANNEL_LOST' ? r.evidence : null)}`);
        log.check('W5.1d 1 :: the recorded pipe failure is reported, not swallowed',
          obs.channelFailure() !== null, `channelFailure=${String(obs.channelFailure())}`);
        // The target must genuinely still be alive: nothing was killed.
        const live = await livenessNative(pid, 700);
        log.check('W5.1d 1 :: no terminate was sent, so the controlled target is still alive', live.state === 'ALIVE',
          `verdict=${live.state}`);
      }
    }

    // --- 2. delayed exit notification: historical exit evidence is preserved ------
    // Once the observer has reported a REAL WAIT_OBJECT_0, that held-handle fact must
    // survive a later, unusable command channel rather than being discarded.
    {
      const pid = startTarget();
      const obs = openObserver(pid, { holdMs: 120_000 });
      if (obs === null) {
        log.check('W5.1d 2 :: valid held-handle exit evidence survives a lost channel', false, 'ENVIRONMENT_BLOCKED: fixture missing');
      } else {
        observers.push(obs);
        await obs.acquired();
        // Terminate through the held handle: this DOES use the command channel.
        const first = await obs.terminateAndVerify(10_000);
        log.check('W5.1d 2 :: a working channel confirms the exit on the held handle',
          first.kind === 'EXIT_CONFIRMED', `result=${JSON.stringify(first)}`);
        // The channel is now spent by construction; a second request must not throw.
        const second = await obs.terminateAndVerify(1_000);
        log.check('W5.1d 2 :: a second request on a spent channel is typed, not a crash',
          second.kind === 'COMMAND_CHANNEL_LOST' || second.kind === 'OBSERVER_LOST', `result=${JSON.stringify(second)}`);
        log.check('W5.1d 2 :: the earlier EXITED evidence is still available via verdict()',
          (await obs.verdict(1_000)).state === 'EXITED', 'held-handle WAIT_OBJECT_0 retained');
        log.check('W5.1d 2 :: a spent channel never fabricates a NEW exit confirmation',
          second.kind !== 'EXIT_CONFIRMED', `result=${JSON.stringify(second)}`);
        // The target really is gone, proven on the held handle.
        const gone = await livenessNative(pid, 700);
        log.check('W5.1d 2 :: the controlled target really exited', gone.state !== 'ALIVE', `verdict=${gone.state}`);
      }
    }

    // --- 3. close() first, then request a terminate --------------------------------
    {
      const pid = startTarget();
      const obs = openObserver(pid);
      if (obs === null) {
        log.check('W5.1d 3 :: terminate after close() is refused, not fatal', false, 'ENVIRONMENT_BLOCKED: fixture missing');
      } else {
        observers.push(obs);
        await obs.acquired();
        obs.close();
        log.check('W5.1d 3 :: a closed observer reports an unusable command channel',
          !obs.commandChannelUsable(), `usable=${obs.commandChannelUsable()}`);
        const r = await obs.terminateAndVerify(1_000);
        log.check('W5.1d 3 :: terminate after close() is a typed COMMAND_CHANNEL_LOST',
          r.kind === 'COMMAND_CHANNEL_LOST', `result=${JSON.stringify(r)}`);
        log.check('W5.1d 3 :: nothing was terminated and no exit was fabricated',
          r.kind !== 'EXIT_CONFIRMED', `result=${JSON.stringify(r)}`);
        // Control: the target must be untouched by a refused command.
        const live = await livenessNative(pid, 700);
        log.check('W5.1d 3 :: the controlled target survived the refused terminate', live.state === 'ALIVE',
          `verdict=${live.state}`);
        // reaped() must confirm the OBSERVER's own exit, independent of any pipe error.
        const gone = await obs.reaped(5_000);
        log.check('W5.1d 3 :: reaped() confirms the observer process actually exited', gone, `reaped=${gone}`);
        if (!gone) cleanupFailures.push({ resource: 'W5.1d 3', error: 'observer did not exit after close' });
      }
    }
  } finally {
    // Independent parent-side reclamation: observers first (they hold handles on the
    // targets), then every controlled target this section started.
    for (const o of observers) {
      const gone = await o.reaped(5_000);
      if (!gone) cleanupFailures.push({ resource: 'W5.1d regression', error: `observer for pid ${o.pid} did not exit` });
    }
    for (const t of targets) {
      try { t.kill('SIGKILL'); } catch { /* already gone */ }
    }
    for (const t of targets) {
      await Promise.race([
        new Promise<void>((res) => { t.once('exit', () => res()); }),
        sleep(5_000),
      ]);
      if (t.exitCode === null && t.signalCode === null) {
        cleanupFailures.push({ resource: 'W5.1d regression', error: `controlled target ${String(t.pid)} did not exit` });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// W5.1c §3 — regressions for the SAME cleanup judgment the real paths run.
//
// These do NOT re-implement any judgment: every case below is fed through the very
// `decideCleanup` that `cleanupRun` (and therefore the stress loop) calls, so the
// regression fails if that shared logic ever stops failing closed.
// ---------------------------------------------------------------------------
function cleanupTruthRegressions(): void {
  const proven = (name: string, pid: number): GenExitFact =>
    ({ name, pid, identityHeld: true, liveness: { state: 'EXITED' } as Liveness });

  // Baseline: everything proven => the ONLY way to pass.
  const okCase = decideCleanup({
    label: 'baseline', stop: 'CONFIRMED', generations: [proven('writer', 111)], observerReapFailures: [],
  });
  log.check('W5.1c §3 :: baseline (stop confirmed + exit proven on a held handle) is the ONLY all-zero case',
    okCase.ok && okCase.problems.length === 0 && okCase.counters.stopFailures === 0, `problems=${okCase.problems.length}`);

  // A. cancel() === false.
  const a = decideCleanup({
    label: 'A cancel=false', stop: 'UNCONFIRMED', generations: [proven('writer', 112)], observerReapFailures: [],
  });
  log.check('W5.1c §3 A :: cancel=false is a failure with a non-zero stop counter',
    !a.ok && a.counters.stopFailures === 1 && a.problems.length > 0, `stopFailures=${a.counters.stopFailures}`);
  log.check('W5.1c §3 A :: cancel=false can never yield an all-zero success', a.counters.stopFailures !== 0, `counters=${JSON.stringify(a.counters)}`);

  // Also distinct: a stop that never settles, and one that throws.
  const aTimeout = decideCleanup({ label: 'A timeout', stop: 'TIMEOUT', generations: [], observerReapFailures: [] });
  const aThrew = decideCleanup({ label: 'A threw', stop: 'THREW', generations: [], observerReapFailures: [] });
  log.check('W5.1c §3 A :: stop TIMEOUT and stop THREW are each a failure (not collapsed)',
    !aTimeout.ok && !aThrew.ok && aTimeout.counters.stopFailures === 1 && aThrew.counters.stopFailures === 1,
    `timeout=${aTimeout.counters.stopFailures} threw=${aThrew.counters.stopFailures}`);

  // B. observer reaped() === false.
  const b = decideCleanup({
    label: 'B observer not reaped', stop: 'CONFIRMED', generations: [proven('writer', 113)],
    observerReapFailures: ['for pid 113 did not exit within 5000ms'],
  });
  log.check('W5.1c §3 B :: an observer that did not exit is a failure with its own counter',
    !b.ok && b.counters.observerReapFailures === 1, `observerReapFailures=${b.counters.observerReapFailures}`);
  log.check('W5.1c §3 B :: observer reap failure can never yield an all-zero success', b.counters.observerReapFailures !== 0, `counters=${JSON.stringify(b.counters)}`);

  // C. final observation === OBSERVATION_ERROR.
  const c = decideCleanup({
    label: 'C observation error', stop: 'CONFIRMED',
    generations: [{ name: 'writer', pid: 114, identityHeld: true, liveness: { state: 'OBSERVATION_ERROR', why: 'observer lost' } }],
    observerReapFailures: [],
  });
  log.check('W5.1c §3 C :: a final OBSERVATION_ERROR is a failure, never a death',
    !c.ok && c.counters.observationErrors === 1 && c.counters.unprovenExits === 1, `observationErrors=${c.counters.observationErrors}`);
  log.check('W5.1c §3 C :: observation error can never yield an all-zero success', c.counters.observationErrors !== 0, `counters=${JSON.stringify(c.counters)}`);

  // A generation still observed ALIVE is also a failure, not a pass.
  const cAlive = decideCleanup({
    label: 'C alive', stop: 'CONFIRMED',
    generations: [{ name: 'writer', pid: 115, identityHeld: true, liveness: { state: 'ALIVE' } }], observerReapFailures: [],
  });
  log.check('W5.1c §3 C :: an ALIVE generation is a failure too', !cAlive.ok && cAlive.counters.unprovenExits === 1,
    `unprovenExits=${cAlive.counters.unprovenExits}`);

  // A successful fallback must NOT erase the failure that triggered it.
  const fallbackOk = decideCleanup({
    label: 'fallback', stop: 'CONFIRMED',
    generations: [{
      name: 'writer', pid: 116, identityHeld: true,
      liveness: { state: 'ALIVE' },
      fallback: { kind: 'EXIT_CONFIRMED', via: 'held-handle' },
    }],
    observerReapFailures: [],
  });
  log.check('W5.1c §3 :: a confirmed fallback does NOT erase the original failure',
    !fallbackOk.ok && fallbackOk.problems.length >= 2, `problems=${fallbackOk.problems.length}`);

  // Native wait results stay distinct: WAIT_TIMEOUT is NOT an exit confirmation.
  const stillAlive = decideCleanup({
    label: 'native WAIT_TIMEOUT', stop: 'CONFIRMED',
    generations: [{
      name: 'writer', pid: 117, identityHeld: true, liveness: { state: 'ALIVE' },
      fallback: { kind: 'STILL_ALIVE', native: 'WAIT_TIMEOUT' },
    }],
    observerReapFailures: [],
  });
  const waitFailed = decideCleanup({
    label: 'native WAIT_FAILED', stop: 'CONFIRMED',
    generations: [{
      name: 'writer', pid: 118, identityHeld: true, liveness: { state: 'OBSERVATION_ERROR', why: 'WAIT_FAILED' },
      fallback: { kind: 'WAIT_FAILED', why: 'WaitForSingleObject failed' },
    }],
    observerReapFailures: [],
  });
  log.check('W5.1c §3 :: native WAIT_TIMEOUT and WAIT_FAILED are different failures, neither is an exit',
    !stillAlive.ok && !waitFailed.ok && stillAlive.counters.fallbackFailures === 1 && waitFailed.counters.fallbackFailures === 1,
    `timeout=${stillAlive.counters.fallbackFailures} waitFailed=${waitFailed.counters.fallbackFailures}`);

  // D. identity missing / not held => unproven, and NO termination may be attempted.
  const d = decideCleanup({
    label: 'D identity missing', stop: 'CONFIRMED',
    generations: [{ name: 'writer', pid: 119, identityHeld: false, liveness: { state: 'OBSERVATION_ERROR', why: 'not observed' } }],
    observerReapFailures: [],
  });
  log.check('W5.1c §3 D :: a generation with no held handle is unproven and counted as identity-unconfirmed',
    !d.ok && d.counters.identityUnconfirmed === 1 && d.counters.unprovenExits === 1 && d.generations[0]?.fallback === undefined,
    `identityUnconfirmed=${d.counters.identityUnconfirmed} fallbackAttempted=${d.generations[0]?.fallback !== undefined}`);
  const dMismatch = decideCleanup({
    label: 'D identity mismatch', stop: 'CONFIRMED',
    generations: [{
      name: 'writer', pid: 120, identityHeld: true,
      liveness: { state: 'ALIVE' },
      fallback: { kind: 'IDENTITY_UNCONFIRMED', why: 'handle no longer bound to the original process' },
    }],
    observerReapFailures: [],
  });
  log.check('W5.1c §3 D :: an identity that cannot be confirmed blocks the fallback and is recorded',
    !dMismatch.ok && dMismatch.counters.fallbackFailures === 1 && dMismatch.counters.identityUnconfirmed === 1,
    `fallbackFailures=${dMismatch.counters.fallbackFailures}`);

  // W5.1d: a lost command channel is a real cleanup failure and MUST reach the ledger
  // through this same judgment — and it is never an exit confirmation.
  const channelLive = decideCleanup({
    label: 'W5.1d channel lost (still running)', stop: 'CONFIRMED',
    generations: [{
      name: 'writer', pid: 121, identityHeld: true, liveness: { state: 'ALIVE' },
      fallback: { kind: 'COMMAND_CHANNEL_LOST', why: 'stdin write failed: write EPIPE', evidence: { state: 'ALIVE' } },
    }],
    observerReapFailures: [],
  });
  log.check('W5.1d :: a lost command channel is a failure in the shared ledger',
    !channelLive.ok && channelLive.counters.fallbackFailures === 1 && channelLive.problems.some((p) => p.includes('command channel lost')),
    `fallbackFailures=${channelLive.counters.fallbackFailures} observationErrors=${channelLive.counters.observationErrors}`);
  log.check('W5.1d :: a lost channel with a real ALIVE fact is NOT an observation error',
    channelLive.counters.observationErrors === 0, `observationErrors=${channelLive.counters.observationErrors}`);

  const channelExited = decideCleanup({
    label: 'W5.1d channel lost (exit already proven)', stop: 'CONFIRMED',
    generations: [{
      name: 'writer', pid: 122, identityHeld: true, liveness: { state: 'EXITED' },
      fallback: { kind: 'COMMAND_CHANNEL_LOST', why: 'observer already exited with code 0', evidence: { state: 'EXITED' } },
    }],
    observerReapFailures: [],
  });
  log.check('W5.1d :: a lost channel PRESERVES valid held-handle EXITED evidence without counting a missing exit',
    !channelExited.ok && channelExited.counters.unprovenExits === 0 && channelExited.problems.some((p) => p.includes('evidence=EXITED')),
    `unprovenExits=${channelExited.counters.unprovenExits} problems=${channelExited.problems.length}`);

  const channelNoFact = decideCleanup({
    label: 'W5.1d channel lost (no fact)', stop: 'CONFIRMED',
    generations: [{
      name: 'writer', pid: 123, identityHeld: true, liveness: { state: 'OBSERVATION_ERROR', why: 'observer lost' },
      fallback: { kind: 'COMMAND_CHANNEL_LOST', why: 'stdin write failed: write EPIPE', evidence: { state: 'OBSERVATION_ERROR', why: 'observer lost' } },
    }],
    observerReapFailures: [],
  });
  log.check('W5.1d :: a lost channel with no fact counts as an observation error too',
    !channelNoFact.ok && channelNoFact.counters.observationErrors === 1, `observationErrors=${channelNoFact.counters.observationErrors}`);
}

/**
 * W5.1c §3 D — REAL proof that an unconfirmed identity kills NOTHING.
 *
 * An owned sentinel process is started and its handle held. A terminate is then
 * requested through an observer that never acquired any handle, i.e. exactly the
 * situation the old pid-only `reap` role would have "handled" by guessing. The
 * sentinel must still be ALIVE afterwards, proven on its OWN held handle.
 */
async function identityRefusalRegression(): Promise<void> {
  const sentinel = spawn(NODE, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  const sentinelPid = sentinel.pid as number;
  const sObs = openObserver(sentinelPid);
  const sAcq = sObs !== null ? await sObs.acquired() : false;
  log.check('W5.1c §3 D :: owned sentinel handle acquired (control process)', sAcq, `pid=${sentinelPid}`);
  if (sObs === null || !sAcq) {
    sentinel.kill('SIGKILL');
    log.check('W5.1c §3 D :: sentinel survival control', false, 'ENVIRONMENT_BLOCKED: observe fixture missing/unavailable');
    return;
  }

  // An observer that can NEVER acquire a handle (unopenable pid) must refuse.
  const blind = openObserver(0xFFFFFF);
  let refusedKind = 'no-observer';
  if (blind !== null) {
    const res = await blind.terminateAndVerify(3_000);
    refusedKind = res.kind;
    await blind.reaped(3_000);
  }
  log.check('W5.1c §3 D :: terminate WITHOUT a held handle is REFUSED (IDENTITY_UNCONFIRMED)',
    refusedKind === 'IDENTITY_UNCONFIRMED', `result=${refusedKind}`);

  // The control process must be untouched by the refused attempt.
  const sLive = await livenessNative(sentinelPid, 700);
  log.check('W5.1c §3 D :: the owned sentinel was NOT terminated by the refused attempt', sLive.state === 'ALIVE',
    `verdict=${sLive.state}${sLive.state === 'OBSERVATION_ERROR' ? ` (${sLive.why})` : ''}`);

  // The shared judgment refuses such a generation as well.
  const d = decideCleanup({
    label: 'D real', stop: 'CONFIRMED',
    generations: [{ name: 'sentinel', pid: sentinelPid, identityHeld: false, liveness: sLive }],
    observerReapFailures: [],
  });
  log.check('W5.1c §3 D :: the shared judgment reports the sentinel generation as unproven',
    !d.ok && d.counters.identityUnconfirmed === 1, `identityUnconfirmed=${d.counters.identityUnconfirmed}`);

  // End the control process through its OWN held handle (identity-bound).
  const kill = await sObs.terminateAndVerify(10_000);
  log.check('W5.1c §3 D :: the sentinel ends only via its own held handle', kill.kind === 'EXIT_CONFIRMED', `terminate=${kill.kind}`);
  const gone = await sObs.reaped(5_000);
  log.check('W5.1c §3 D :: the sentinel observer was reaped', gone, `reaped=${gone}`);
  if (!gone) cleanupFailures.push({ resource: 'identityRefusalRegression', error: 'sentinel observer did not exit' });
}
// ---------------------------------------------------------------------------
// Stress: combined concurrent non-interference + descendant reclaim, stop order
// alternated. Counters come from ACTUAL cleanup decisions, never from assumption.
// ---------------------------------------------------------------------------
interface StressStats { attempted: number; completed: number; readinessFailures: number; observationErrors: number; containmentFailures: number; surviving: number; cleanupFailures: number }
async function stress(): Promise<StressStats> {
  const st: StressStats = { attempted: 0, completed: 0, readinessFailures: 0, observationErrors: 0, containmentFailures: 0, surviving: 0, cleanupFailures: 0 };
  /** Fold ONE shared-decision verdict into the actual counters. Never dropped. */
  const fold = (d: CleanupDecision): void => {
    st.observationErrors += d.counters.observationErrors;
    st.surviving += d.counters.unprovenExits;
    st.cleanupFailures += d.counters.stopFailures + d.counters.observerReapFailures
      + d.counters.identityUnconfirmed + d.counters.fallbackFailures
      + (d.counters.unprovenExits - d.counters.observationErrors);
    for (const p of d.problems) cleanupFailures.push({ resource: 'stress', error: p });
  };

  for (let i = 0; i < ROUNDS; i++) {
    st.attempted++;
    const dirA = ownDir(`st-A${i}`), dirB = ownDir(`st-B${i}`);
    const [ra, rb] = await Promise.allSettled([startContained(`sA${i}`, dirA, cmdMiddle(dirA)), startContained(`sB${i}`, dirB, cmdMiddle(dirB))]);
    if (ra.status === 'rejected' || rb.status === 'rejected') {
      st.readinessFailures++;
      // P1-2: reclaim the fulfilled side even though the other failed. The
      // reclaim's own problems are counted, not assumed empty.
      const problems = await registry.reclaimAll(`stress${i} one-sided-failure`);
      for (const p of problems) { st.cleanupFailures++; cleanupFailures.push({ resource: `stress${i} one-sided-failure`, error: p }); }
      continue;
    }
    const A = ra.value, B = rb.value;
    st.completed++;
    const aFirst = i % 2 === 0;
    const victim = aFirst ? A : B, survivor = aFirst ? B : A;
    const spid = readNum(survivor.w.pidFile);
    const hb0 = hbSize(survivor.w.hbFile);

    // HARDKILL the victim THROUGH ITS OWN HELD LAUNCHER HANDLE (no bare pid kill),
    // then reclaim it through the same shared decision used everywhere else.
    const lobs = victim.observers.find((o) => o.pid === victim.launcherPid);
    const kill = lobs !== undefined && lobs.holdsIdentity()
      ? await lobs.terminateAndVerify(10_000)
      : { kind: 'IDENTITY_UNCONFIRMED' as const, why: 'no held launcher handle; refusing to terminate by pid' };
    await Promise.race([victim.p.exited.catch(() => undefined), sleep(4_000)]);
    const vDecision = await cleanupRun(victim, `stress${i} victim reclaim`, { skipStop: true });
    fold(vDecision);
    if (kill.kind !== 'EXIT_CONFIRMED') {
      st.cleanupFailures++;
      cleanupFailures.push({ resource: `stress${i} victim launcher`, error: `identity-bound hardkill did not confirm exit: ${kill.kind}` });
    }
    const vWriter = vDecision.generations.find((g) => g.name === 'writer');
    if (vWriter === undefined || vWriter.liveness.state !== 'EXITED') st.surviving++;
    if (vDecision.ok) registry.remove(victim);

    // §3: the survivor is ALIVE, so the check for "still alive" needs a NATIVE
    // WAIT_TIMEOUT fact, not a client-bounded verdict that can never resolve.
    const sv = await livenessNative(spid, 900);
    if (sv.state === 'ALIVE') {
      // Survivor must still be writing.
      await sleep(200);
      if (hbSize(survivor.w.hbFile) <= hb0) st.containmentFailures++;
    } else if (sv.state === 'OBSERVATION_ERROR') {
      st.observationErrors++;
      cleanupFailures.push({ resource: `stress${i} survivor`, error: `survivor liveness not observed: ${sv.why}` });
    } else {
      st.containmentFailures++; // survivor wrongly reported dead
    }

    // Reclaim the survivor through the SAME path; its result is counted, and the
    // run is deregistered only when the cleanup actually confirmed.
    const sDecision = await cleanupRun(survivor, `stress${i} survivor reclaim`);
    fold(sDecision);
    if (sDecision.ok) registry.remove(survivor);
  }
  return st;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// W5.1c §4 — THE finalizer. The normal suite and the deletion-failure child run
// this exact function, so an injected removal failure proves propagation through
// the production exit-code path rather than through a private second decision.
// ---------------------------------------------------------------------------
async function finalizeSuite(opts: {
  rootPath: string;
  /** Injected removal failure; when set, the real removal is deliberately skipped. */
  injectRemovalFailure?: string;
  owned: { cleanup(): Promise<{ resource: string; error: string }[]> };
  extraFailures?: { resource: string; error: string }[];
}): Promise<number> {
  for (const m of await registry.reclaimAll('final reclaim')) cleanupFailures.push({ resource: 'registry', error: m });
  for (const cf of await opts.owned.cleanup()) cleanupFailures.push(cf);
  for (const ef of opts.extraFailures ?? []) cleanupFailures.push(ef);

  // The owned-root removal result MUST be checked and propagated, not dropped.
  const removal = opts.injectRemovalFailure !== undefined
    ? { ok: false as const, error: opts.injectRemovalFailure }
    : removeOwnedRoot(opts.rootPath);
  if (!removal.ok) {
    fixtureRemovalError = `owned fixture root removal failed for ${opts.rootPath}: ${removal.error}`;
    cleanupFailures.push({ resource: opts.rootPath, error: removal.error });
  }
  // VERIFY the root is actually gone: a Windows worktree/git dir can be briefly
  // locked by a just-terminated process, so `rmSync` may leave it. Retry once
  // after a short settle, then confirm absence — an exit-0 must mean "clean".
  if (fixtureRemovalError === null && existsSync(opts.rootPath)) {
    await sleep(500);
    const retry = removeOwnedRoot(opts.rootPath);
    if (!retry.ok || existsSync(opts.rootPath)) {
      fixtureRemovalError = `owned fixture root ${opts.rootPath} still present after removal (retry ${retry.ok ? 'ok-but-present' : retry.error})`;
      cleanupFailures.push({ resource: opts.rootPath, error: fixtureRemovalError });
    }
  }

  if (log.passed > 0 || log.failed > 0) console.log(`\n${log.passed} passed, ${log.failed} failed`);
  if (log.failed > 0) console.log(`failing:\n  - ${log.failures.join('\n  - ')}`);
  if (cleanupFailures.length > 0) {
    console.log(`cleanup failures (must fail the test):`);
    for (const f of cleanupFailures) console.log(`  - ${f.resource}: ${f.error}`);
  }
  if (fixtureRemovalError !== null) console.log(`FIXTURE REMOVAL FAILURE (must fail the test): ${fixtureRemovalError}`);
  if (fatal !== undefined) console.log(`fatal: ${String((fatal as Error).message)}`);

  const code = log.failed === 0 && cleanupFailures.length === 0 && fixtureRemovalError === null && fatal === undefined ? 0 : 1;
  const passed = cleanupFailures.length;
  void passed;
  return code;
}

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
  const sentinelPath = join(childOwnedRoot, 'sentinel.txt');
  writeFileSync(sentinelPath, 'child-owned sentinel\n');
  // W5.1c §4: the SAME finalizer the main suite uses, with the removal failure
  // injected as its only input. There is no second exit-code decision anywhere.
  const code = await finalizeSuite({
    rootPath: childOwnedRoot,
    injectRemovalFailure: 'injected owned-root removal failure (EBUSY)',
    owned: { cleanup: async () => [] },
  });
  // The report lives INSIDE the owned root and the root is deliberately NOT removed,
  // so the parent can observe BOTH the failure and the residual before cleaning it.
  writeFileSync(join(childOwnedRoot, 'p13-report.txt'), `removalError=${fixtureRemovalError === null ? 'none' : fixtureRemovalError}\nexit=${code}\n`);
  process.exit(code);
}

// W5.1b §2 injection-only child mode. The parent (see below) asserts this child's
// REAL non-zero exit and its report. The child runs ONLY this injection so it is
// fast, cannot recurse, and cannot pollute the parent's own cleanup ledger.
if (process.env.W51_FAILCLOSED_CHILD === '1') {
  // The parent names the root, so ownership is by NAME (W4.4: never enumerate).
  const childRoot = process.env.W51_CHILD_ROOT ?? join(OWNED_PARENT, `w51b-fc-child-${process.pid}`);
  mkdirSync(childRoot, { recursive: true });
  const ledger: { resource: string; error: string }[] = [];
  const report = { stopFailed: false, exitUnproven: false, cancelConfirmed: null as boolean | null, exitFact: 'NONE', why: '' };
  let run: Run | undefined;
try {
    const dir = join(childRoot, 'p2-failclosed');
    mkdirSync(dir, { recursive: true });
    const startedRun = await startContained('W5.1b 2 stop-failed', dir, cmdMiddle(dir));
    run = startedRun;
    // Force a stop that genuinely does NOT confirm: terminate the LAUNCHER through
    // its OWN held handle (never by pid), so the cooperative stop afterwards has no
    // confirmed tree. Real, not a simulated bool.
    const lobs = startedRun.observers.find((o) => o.pid === startedRun.launcherPid);
    const kill = lobs !== undefined && lobs.holdsIdentity()
      ? await lobs.terminateAndVerify(10_000)
      : { kind: 'IDENTITY_UNCONFIRMED' as const, why: 'no held launcher handle' };
    if (kill.kind !== 'EXIT_CONFIRMED') {
      ledger.push({ resource: 'W5.1b 2', error: `launcher identity-bound terminate => ${kill.kind}` });
    }
    await Promise.race([run.p.exited.catch(() => undefined), sleep(4_000)]);
    const forced = await run.p.cancel('W5.1b 2 post-hardkill cancel').catch(() => false);
    /*
     * W5.1c §3: the child's ledger is NOT hand-written. The SAME `cleanupRun` /
     * `decideCleanup` judgment the stress loop uses is fed real facts, so this
     * regression fails if that shared logic ever stops failing closed.
     *
     * Identity is genuinely destroyed here: every held handle is released BEFORE the
     * cooperative stop, so no exit proof can survive by identity �?the case cannot
     * pass by accident.
     */
    for (const o of run.observers) o.close();
    run.observers = [];
    const exitFact: Liveness = await livenessNative(readNum(run.w.pidFile), 400);
    report.cancelConfirmed = forced === true;
    report.exitFact = exitFact.state;
    report.why = exitFact.state === 'OBSERVATION_ERROR' ? exitFact.why : '';
    report.stopFailed = forced !== true;
    report.exitUnproven = exitFact.state !== 'EXITED';
    const decision = decideCleanup({
      label: 'W5.1b 2',
      stop: forced === true ? 'CONFIRMED' : 'UNCONFIRMED',
      generations: [{
        name: 'writer',
        pid: readNum(run.w.pidFile),
        identityHeld: false,   // deliberately destroyed: identity unconfirmed
        liveness: exitFact,
      }],
      observerReapFailures: [],
    });
    // EVERY problem the shared judgment produced reaches the ledger, verbatim.
    for (const p of decision.problems) ledger.push({ resource: 'W5.1b 2', error: p });
    // Residual reclaimed only through owned containment: the Job is still owned by
    // the launcher, so the run's own final reclaim path is used �?never a pid kill.
    void run;
  } catch (e) {
    ledger.push({ resource: 'W5.1b 2', error: `threw: ${String((e as Error).message ?? e)}` });
  } finally {
    for (const m of await registry.reclaimAll('failclosed child final reclaim')) ledger.push({ resource: 'registry', error: m });
    const code = finish([], { allowEnvironmentBlocked: true, cleanupFailures: ledger });
    // The report is written INSIDE the owned root, which is deliberately NOT removed
    // here: the parent must observe the failure BEFORE it cleans the residual.
    writeFileSync(join(childRoot, 'report.json'), JSON.stringify({ ...report, ledgerCount: ledger.length, exitCode: code }));
    process.exit(code);
  }
}

const owned = setupOwnedTestContext();
if (owned === null) {
  console.log('W5.1: BLOCKED (no production launcher on this machine)');
  process.exitCode = finish([], { allowEnvironmentBlocked: true });
} else {
  try {
console.log(`== W5.1a P1-4 observation regressions ==`);
    await observationRegressions();

    console.log(`\n== W5.1d observer command-pipe / lifecycle boundary ==`);
    await observerChannelBoundaryRegressions();

    console.log(`\n== W5.1c §3 cleanup-truth regressions (same shared judgment as stress) ==`);
    cleanupTruthRegressions();
    await identityRefusalRegression();

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

console.log(`\n== W5.1b 2: cancel=false + final OBSERVATION_ERROR must FAIL ==`);
{
  /*
   * §2 requires that a stop which did NOT confirm, combined with an observation that
   * produced NO exit fact, is reported as failure �?not smoothed into an all-zero
   * success table.
   *
   * Both facts are produced for real, in an ISOLATED CHILD PROCESS: this regression
   * intentionally records cleanup failures, so running it in the parent would poison
   * the parent's exit code. The child proves the real end-to-end behaviour: a
   * genuinely unconfirmed stop + a genuinely unprovable exit => non-zero exit with a
   * populated ledger. The parent only asserts the child's OBSERVED exit code and
   * report, then cleans the child's OWNED root by name.
   */
  const childRoot = join(OWNED_PARENT, `w51b-fc-${process.pid}-${randomUUID().slice(0, 8)}`);
  const childReport = join(childRoot, 'report.json');
  const childRes = spawnSync(process.execPath, [join(REPO, 'tests', 'w51-real-descendant-isolation.test.ts')], {
    cwd: REPO,
    env: { ...process.env, W51_FAILCLOSED_CHILD: '1', W51_ROUNDS: '1', W51_CHILD_ROOT: childRoot },
    timeout: 300_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Observe BEFORE cleanup.
  log.check('W5.1b 2 :: child with cancel=false + OBSERVATION_ERROR exits NON-ZERO', childRes.status !== 0, `status=${String(childRes.status)}`);
  let report = { stopFailed: false, exitUnproven: false, ledgerCount: 0 } as { stopFailed: boolean; exitUnproven: boolean; ledgerCount: number };
  let readOk = false;
  try { report = JSON.parse(readFileSync(childReport, 'utf8')); readOk = true; } catch { /* report unreadable */ }
  log.check('W5.1b 2 :: child recorded a REAL unconfirmed stop and an UNPROVABLE exit', readOk && report.stopFailed && report.exitUnproven,
    `readOk=${readOk} stopFailed=${report.stopFailed} exitUnproven=${report.exitUnproven}`);
  log.check('W5.1b 2 :: child ledger is populated (not an all-zero success)', readOk && report.ledgerCount >= 2,
    `ledgerCount=${report.ledgerCount}`);
  // Clean ONLY the named owned root (ours by name), after observing the failure.
  removeOwnedRoot(childRoot);
  log.check('W5.1b 2 :: only the named owned root was cleaned', !existsSync(childRoot), `cleaned=${!existsSync(childRoot)}`);
}

console.log(`\n== W5.1a P1-2 one-sided start failure reclaims the peer ==`);
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
      // remove EXACTLY that path — ownership by name, never by enumerating the shared
      // parent. This keeps the foreign-root/sentinel rule intact.
      const childRootName = `w51-p13child-${randomUUID().slice(0, 8)}`;
      const childRoot = join(OWNED_PARENT, childRootName);
      // A FOREIGN sentinel sibling under the same shared parent. It is not owned by
      // this run, so neither the child's failed removal nor the parent's cleanup may
      // touch it. It exists only to make that promise falsifiable.
      const foreignRoot = join(OWNED_PARENT, `w51-foreign-${randomUUID().slice(0, 8)}`);
      mkdirSync(foreignRoot, { recursive: true });
      const foreignSentinel = join(foreignRoot, 'sentinel.txt');
      writeFileSync(foreignSentinel, 'foreign-owned sentinel\n');
      const childRes = spawnSync(process.execPath, [join(REPO, 'tests', 'w51-real-descendant-isolation.test.ts')], {
        cwd: REPO,
        env: { ...process.env, W51_INJECT_ROOT_RM_FAILURE: 'child-only', W51_P13_CHILD_ROOT: childRoot },
        timeout: 120_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
log.check('P1-3 :: injected owned-root removal failure => child exits NON-ZERO', childRes.status !== 0, `status=${String(childRes.status)}`);
      // W5.1c §4: a child killed by a signal or a timeout is a DIFFERENT outcome
      // from "the finalizer correctly produced a non-zero exit". Check them apart.
      log.check('P1-3 :: the child was NOT killed by a signal and did not time out (it exited normally)',
        childRes.signal === null && childRes.error === undefined,
        `signal=${String(childRes.signal)} error=${String(childRes.error)}`);
      log.check('P1-3 :: the child exit code is an ordinary non-zero status, not null',
        childRes.status !== null && childRes.status !== 0, `status=${String(childRes.status)}`);
      // Observe the child's residual + report BEFORE any cleanup.
      const report = existsSync(join(childRoot, 'p13-report.txt')) ? readFileSync(join(childRoot, 'p13-report.txt'), 'utf8') : '';
      log.check('P1-3 :: child left its owned root behind (failure was real)', existsSync(childRoot), `residual=${existsSync(childRoot)}`);
      log.check('P1-3 :: child reported the removal failure with the owned root', /owned fixture root removal failed/.test(report),
        `report=${JSON.stringify(report.split('\n')[0] ?? '')}`);
      log.check('P1-3 :: the child finalizer reported a NON-ZERO exit inside the report', /exit=[1-9]/.test(report),
        `report=${JSON.stringify(report.split('\n').slice(1).join(' ').trim())}`);
      // NOW clean ONLY the named child root (ours, by name) — never a foreign one.
      removeOwnedRoot(childRoot);
      log.check('P1-3 :: only the named owned root was cleaned (foreign roots untouched)', !existsSync(childRoot), `cleaned=${!existsSync(childRoot)}`);
      // The foreign sentinel must have survived BOTH the child's failed removal and
      // this parent's cleanup of its own root.
      log.check('P1-3 :: the FOREIGN sentinel root and its file survived the whole child lifecycle',
        existsSync(foreignSentinel), `sentinel=${existsSync(foreignSentinel)}`);
      // Now remove the sentinel ourselves (it is ours only as an explicit fixture).
      removeOwnedRoot(foreignRoot);
    }
} catch (e) {
    fatal = e;
  } finally {
    // W5.1c §4: the main suite and the injection child share this ONE finalizer.
    process.exitCode = await finalizeSuite({
      rootPath: OWN_ROOT,
      injectRemovalFailure: process.env.W51_INJECT_ROOT_RM_FAILURE === '1'
        ? 'injected owned-root removal failure (EBUSY)' : undefined,
      owned,
    });
  }
}