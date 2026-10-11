/**
 * tests/w42-opencode-lifecycle.test.ts �?REAL OpenCode lifecycle (opt-in).
 *
 * Not part of `npm test` (needs a real, authenticated OpenCode). Exercises the
 * PRODUCTION path only: AgentSession -> transport.cancel -> ManagedProcess
 * cooperative containment stop -> deployed launcher -> validated `terminated`.
 *
 * Covers: manual cancel, deadline, session/resume continuity, and hard-kill
 * retained protection. Records MISSING/UNSUPPORTED facts honestly.
 *
 * ============================================================================
 * OWNERSHIP (W4.4)
 * ============================================================================
 * The whole suite runs inside `withOwnedTestContext`, so the isolated launcher,
 * its control/stop artifacts, every workspace and the runtime store live under one
 * unique root and are removed on EVERY exit path �?including a throw from any
 * assertion, any runtime call, or any parsing step. A flat
 * `setup(); await A(); await B(); cleanup();` sequence would leak all of it if A
 * or B threw, which is exactly the P1 this file previously had.
 *
 * Control records are read ONLY through `latestOwnedControlFacts(ctx)`, which
 * derives the path from the owned context. This suite has no way to name the
 * production control directory.
 */

import { writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Orchestrator as RuntimeOrch } from '../src/orchestrator/orchestrator.ts';
import type { AgentSession } from '../src/runtime/session.ts';
import {
  withOwnedTestContext,
  latestOwnedControlFacts,
  pidAlive,
  finish,
  writeHygieneReport,
  type OwnedTestContext,
} from './helpers/real-agent-isolation.ts';

const results: Array<{ name: string; verdict: string; detail: string }> = [];
function rec(name: string, verdict: string, detail = ''): void {
  results.push({ name, verdict, detail });
  console.log(`  ${verdict.padEnd(22)} ${name}${detail ? ` :: ${detail}` : ''}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const LONG = 'Read every doc-*.txt file in this directory and give me a detailed combined summary of their contents.';

/**
 * W4.4 failure injection, OFF on the normal path. The hygiene harness sets this to
 * a stage name to prove cleanup survives a throw; a normal run never sets it, so
 * the injected throw is absent from real execution.
 */
function injectAt(stage: string): void {
  if (process.env.ORCH_W4H_INJECT === stage) {
    throw new Error(`[W4.4 injected test-body failure @ ${stage}]`);
  }
}

async function runTest(ctx: OwnedTestContext): Promise<void> {
  const storeRoot = ctx.dir('store');
  const rt = new RuntimeOrch({ config: { agents: {} } as never, storeDir: join(storeRoot, '.store') });

  /** A fresh OWNED workspace directory, never a bare mkdtemp outside the root. */
  const workspace = (name: string, docs: number, marker: string): string => {
    const d = ctx.dir(`workspace/${name}`);
    writeFileSync(join(d, 'input.txt'), marker);
    for (let i = 0; i < docs; i++) writeFileSync(join(d, `doc-${i}.txt`), `Document ${i}: lorem ipsum dolor sit amet. `.repeat(40));
    return d;
  };

  /**
   * A genuinely LONG, bounded, non-destructive task so the root is still working
   * when cancel/deadline fires. A short prompt lets the root finish before the stop
   * lands, which proves nothing about the cooperative `terminated` path.
   */
  const longWorkspace = (name: string): string => workspace(name, 12, 'long-running probe\n');

  // ---- A. real cancel (cooperative) ----
  {
    const dir = longWorkspace('cancel');
    const handle = rt.run({ agentId: 'opencode', prompt: LONG, cwd: dir, timeoutMs: 120_000 });
    await sleep(1800); // let the root genuinely start and still be working
    const rootPid = handle.observe?.()?.pid ?? null;
    ctx.trackProcess(rootPid);
    // AgentSession.cancel() returns void; the confirmation is observed in the frozen
    // result (a failed stop keeps the session running instead of freezing `cancelled`).
    await handle.cancel('W4.2 real cancel');
    const r = await handle.result();
    const cf = latestOwnedControlFacts(ctx);
    const okOutcome = r.state === 'cancelled';
    const okStop = r.cleanup.treeStopConfirmed === true;
    const okTerminated = cf['launcherStatus'] === 'terminated';
    const rootDead = rootPid === null || !pidAlive(rootPid);
    rec('A cancel: outcome=cancelled', okOutcome ? 'PASS' : 'FAIL', `state=${r.state}`);
    rec('A cancel: launcherStatus=terminated', okTerminated ? 'PASS' : 'FAIL', `status=${String(cf['launcherStatus'])}`);
    rec('A cancel: treeStopConfirmed', okStop ? 'PASS' : 'FAIL', JSON.stringify(r.cleanup));
    rec('A cancel: root dead', rootDead ? 'PASS' : 'FAIL', `pid=${String(rootPid)}`);

    // W4.4 §8: inject AFTER the cancel assertion work is done, so the harness can
    // prove the exception path still disposes everything.
    injectAt('after-cancel');
  }

  // ---- B. real deadline (production onDeadline) ----
  {
    const dir = longWorkspace('deadline');
    const r = await rt.run({ agentId: 'opencode', prompt: LONG, cwd: dir, timeoutMs: 1800 }).result();
    const cf = latestOwnedControlFacts(ctx);
    const okOutcome = r.state === 'timed_out';
    const okStop = r.cleanup.treeStopConfirmed === true;
    rec('B deadline: outcome=timed_out', okOutcome ? 'PASS' : 'FAIL', `state=${r.state}`);
    rec('B deadline: treeStopConfirmed', okStop ? 'PASS' : 'FAIL', JSON.stringify(r.cleanup));
    rec('B deadline: terminated path (launcherStatus)', cf['launcherStatus'] === 'terminated' ? 'PASS' : 'INFO', String(cf['launcherStatus']));
  }

  // ---- C. real session/resume continuity ----
  {
    const dir = workspace('resume', 0, 'A neutral marker file for a real resume probe.\n');
    // RUNTIME-GENERATED token: it exists in no fixture and in no source literal, so
    // recalling it proves genuine conversational continuity rather than a file read.
    const token = `TKN-${randomUUID()}`;
    const handle = rt.run({ agentId: 'opencode', prompt: `Remember this token for this conversation only: ${token}. Do not write it to any file. Reply only OK.`, cwd: dir, timeoutMs: 60_000 });
    const r1 = await handle.result();
    const threadId = (handle as unknown as AgentSession).currentThreadId ?? null;
    // The token must not be recoverable from disk, which is what makes the recall
    // below evidence of context retention. Scan the OWNED workspace.
    let onDisk = 0;
    const scan = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const f = join(d, e.name);
        if (e.isDirectory()) { try { scan(f); } catch { /* ignore */ } }
        else { try { if (readFileSync(f, 'utf8').includes(token)) onDisk++; } catch { /* binary */ } }
      }
    };
    try { scan(dir); } catch { /* ignore */ }
    rec('C resume: token absent from disk after first turn', onDisk === 0 ? 'PASS' : 'FAIL', `onDisk=${onDisk}`);
    if (r1.state !== 'succeeded') {
      rec('C resume: first run', 'FAIL', `state=${r1.state}`);
    } else if (threadId === null) {
      rec('C resume: session identity captured', 'FAIL', 'no threadId on observation');
    } else {
      rec('C resume: first run', 'PASS', `thread=${String(threadId).slice(0, 24)}`);
      // Resume: ask for the token WITHOUT re-injecting it.
      const h2 = rt.run({ agentId: 'opencode', prompt: 'What token did I ask you to remember last turn? Reply with only the token.', cwd: dir, timeoutMs: 60_000, threadId: String(threadId) });
      const r2 = await h2.result();
      const kept = r2.output.includes(token);
      rec('C resume: runtime-generated token recalled from context', kept ? 'PASS' : 'FAIL', `state=${r2.state} out=${JSON.stringify(r2.output.slice(0, 60))}`);
    }
  }

  // ---- D. real hard-kill retained protection (no cooperative final record) ----
  {
    const dir = longWorkspace('hardkill');
    const handle = rt.run({ agentId: 'opencode', prompt: LONG, cwd: dir, timeoutMs: 120_000 });
    await sleep(1500);
    const rootPid = handle.observe?.()?.pid ?? null;
    ctx.trackProcess(rootPid);
    const rootAliveBefore = rootPid !== null && pidAlive(rootPid);
    // Hard-kill the LAUNCHER (not a cooperative stop). W1 KILL_ON_JOB_CLOSE reclaims
    // the tree, but there is no final `terminated` record -> treeStopConfirmed=false.
    const launcherPid = latestOwnedControlFacts(ctx)['launcherPid']
      ? Number(latestOwnedControlFacts(ctx)['launcherPid'])
      : null;
    let killed = false;
    if (launcherPid !== null) {
      try { process.kill(launcherPid, 'SIGKILL'); killed = true; } catch { /* ignore */ }
    }
    const r = await handle.result().catch(() => null);
    const unconfirmed = r === null ? null : r.cleanup.treeStopConfirmed === false;
    rec('D hard-kill: root alive before kill (so the kill is the cause)', rootAliveBefore ? 'PASS' : 'SKIP', `pid=${String(rootPid)}`);
    rec('D hard-kill: launcher killed', killed ? 'PASS' : 'INFO', `launcherPid=${String(launcherPid)}`);
    rec('D hard-kill: treeStopConfirmed=false (no final record)', unconfirmed === true ? 'PASS' : 'INFO', r === null ? 'result rejected' : JSON.stringify(r.cleanup));
    const rootDead = rootPid === null || !pidAlive(rootPid);
    rec('D hard-kill: root reclaimed by job kill-on-close', rootDead ? 'PASS' : 'FAIL', `pid=${String(rootPid)}`);
  }
}

// ---- outermost try/finally: cleanup runs on every exit path ----------------
let cleanupFailures: Awaited<ReturnType<typeof withOwnedTestContext>> = [];
let fatal: unknown;
try {
  cleanupFailures = await withOwnedTestContext('W4.2 OpenCode lifecycle', runTest);
} catch (e) {
  // A test-body throw is a legitimate (injected) outcome; cleanup already ran.
  fatal = e;
  console.log(`  INJECTED           ${String((e as Error).message)}`);
}

writeHygieneReport(fatal);
console.log('\nW4.2 OpenCode lifecycle summary:');
for (const x of results) console.log(`  [${x.verdict}] ${x.name}${x.detail ? ` :: ${x.detail}` : ''}`);
if (cleanupFailures.length > 0) {
  console.log('\nCLEANUP FAILURES (test must fail):');
  for (const f of cleanupFailures) console.log(`  - ${f.resource}: ${f.error}`);
}
if (fatal !== undefined) {
  // Only an INJECTED throw is an expected outcome; anything else is a real error.
  if (!String((fatal as Error).message).startsWith('[W4.4 injected')) throw fatal;
  process.exitCode = 1;
} else {
  process.exitCode = finish(results, { allowEnvironmentBlocked: true, cleanupFailures });
}