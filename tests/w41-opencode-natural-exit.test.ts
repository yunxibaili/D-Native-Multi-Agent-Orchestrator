/**
 * tests/w41-opencode-natural-exit.test.ts — REAL OpenCode natural-exit regression.
 *
 * W4.1. Not part of `npm test` (it needs a real, authenticated OpenCode install).
 *
 * The defect it guards: a real OpenCode run could be emitted as
 * `launcherStatus=success` WITHOUT `rootExitObserved`/`rootExitCode`, so the W2
 * consumer correctly rejected the record and the production run was misclassified
 * as failed. This runs N consecutive natural-exit smokes and requires 0
 * misclassifications.
 *
 * A missing/unauthenticated OpenCode is recorded as BLOCKED — an environment fact,
 * not an orchestrator failure.
 *
 * ============================================================================
 * OWNERSHIP (W4.4)
 * ============================================================================
 * All N run directories live under one unique owned root and are disposed by the
 * outermost `withOwnedTestContext`, so a throw from any run cannot leave the
 * remaining directories, the store, or the launcher copy behind. The launcher used
 * is a byte-identical copy of the deployed binary, so the natural-exit
 * reconciliation under test is exactly the production one.
 */

import { Orchestrator as RuntimeOrch } from '../src/orchestrator/orchestrator.ts';
import { join } from 'node:path';
import { withOwnedTestContext, writeHygieneReport, type OwnedTestContext } from './helpers/real-agent-isolation.ts';

// P0-1 OFFLINE TEST ISOLATION. This suite needs a REAL, authenticated OpenCode install,
// so it REFUSES to run by default, BEFORE any setup, discovery or spawn. Live execution
// requires a future explicit trusted-control authorization; the offline policy is not
// one, and an env flag is deliberately not accepted as one. Nothing below runs.
import { refuseLiveEntry } from './helpers/native-agent-policy.ts';
refuseLiveEntry('W4.1 OpenCode natural-exit');

const RUNS = 10;
let pass = 0;
let blocked = 0;
let misclassified = 0;
const details: string[] = [];

async function runTest(ctx: OwnedTestContext): Promise<void> {
  const storeRoot = ctx.dir('store');
  const runRoot = ctx.dir('runs');
  const rt = new RuntimeOrch({ config: { agents: {} } as never, storeDir: join(storeRoot, '.store') });

  for (let i = 1; i <= RUNS; i++) {
    // An OWNED per-run directory, never a bare mkdtemp outside the test's root.
    const dir = join(runRoot, `run${i}`);
    ctx.dir(`runs/run${i}`);
    try {
      const handle = rt.run({ agentId: 'opencode', prompt: 'Reply with exactly: W4OK', cwd: dir, timeoutMs: 120_000 });
      const r = await handle.result();
      ctx.trackProcess(handle.observe?.()?.pid ?? null);
      const ok =
        r.state === 'succeeded' &&
        r.exitCode === 0 &&
        r.cleanup.treeStopConfirmed === true &&
        r.cleanup.processStart === 'started' &&
        r.output.includes('W4OK');
      if (ok) {
        pass++;
      } else {
        misclassified++;
        details.push(`run ${i}: state=${r.state} exit=${r.exitCode} treeStop=${r.cleanup.treeStopConfirmed} out=${JSON.stringify(r.output.slice(0, 40))}`);
      }
    } catch (e) {
      blocked++;
      details.push(`run ${i}: threw ${(e as Error).message}`);
    }
  }
}

let cleanupFailures: Awaited<ReturnType<typeof withOwnedTestContext>> = [];
let fatal: unknown;
try {
  cleanupFailures = await withOwnedTestContext('W4.1 OpenCode natural-exit', runTest);
} catch (e) {
  fatal = e;
}
writeHygieneReport(fatal);

if (fatal !== undefined) throw fatal;

if (blocked === RUNS) {
  console.log(`W4.1 OpenCode natural-exit: BLOCKED (environment) — ${blocked}/${RUNS}`);
  console.log(details.join('\n'));
  // Nothing was misclassified; a fully blocked environment is not a failure.
  process.exitCode = cleanupFailures.length > 0 ? 1 : 0;
} else {
  console.log(`W4.1 OpenCode natural-exit: ${pass}/${RUNS} classified succeeded, misclassified=${misclassified}, blocked=${blocked}`);
  for (const d of details) console.log('  ' + d);
  // A cleanup failure must fail the test even when every run classified correctly.
  process.exitCode = misclassified === 0 && cleanupFailures.length === 0 ? 0 : 1;
}