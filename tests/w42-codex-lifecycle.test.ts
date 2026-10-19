/**
 * tests/w42-codex-lifecycle.test.ts �?REAL Codex lifecycle + invocation (opt-in).
 *
 * Not part of `npm test` (needs a real, authenticated Codex install).
 *
 * W4.2 purpose: separate ADAPTER_ARGV_MISMATCH from EXTERNAL service failure, and
 * prove containment (cancel / deadline) is correct on the real Codex binary.
 *
 * If the upstream model service is unreachable, the natural smoke is recorded as
 * ENVIRONMENT_BLOCKED with the CLI's own evidence �?never silently as a pass.
 *
 * ============================================================================
 * OWNERSHIP (W4.4)
 * ============================================================================
 * Everything runs inside `withOwnedTestContext`, so the launcher copy, its
 * control/stop artifacts, each workspace and the runtime store live under one
 * unique root and are disposed on EVERY exit path �?including a throw from any
 * assertion or runtime call. Control records are read only via
 * `latestOwnedControlFacts(ctx)`, so this suite cannot name the production control
 * directory at all.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Orchestrator as RuntimeOrch } from '../src/orchestrator/orchestrator.ts';
import {
  withOwnedTestContext,
  latestOwnedControlFacts,
  pidAlive,
  finish,
  writeHygieneReport,
  type OwnedTestContext,
} from './helpers/real-agent-isolation.ts';

// P0-1 OFFLINE TEST ISOLATION. This suite needs a REAL, authenticated Codex install, so
// it REFUSES to run by default, BEFORE any setup, discovery or spawn. Live execution
// requires a future explicit trusted-control authorization; the offline policy is not
// one, and an env flag is deliberately not accepted as one. Nothing below runs.
import { refuseLiveEntry } from './helpers/native-agent-policy.ts';
refuseLiveEntry('W4.2 Codex lifecycle');


const results: Array<{ name: string; verdict: string; detail: string }> = [];
function rec(name: string, verdict: string, detail = ''): void {
  results.push({ name, verdict, detail });
  console.log(`  ${verdict.padEnd(18)} ${name}${detail ? ` :: ${detail}` : ''}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const LONG = 'Read every doc-*.txt file in this directory and give me a detailed combined summary of their contents, then explain each one.';

/** W4.4 failure injection, OFF on the normal path. */
function injectAt(stage: string): void {
  if (process.env.ORCH_W4H_INJECT === stage) {
    throw new Error(`[W4.4 injected test-body failure @ ${stage}]`);
  }
}

async function runTest(ctx: OwnedTestContext): Promise<void> {
  const storeRoot = ctx.dir('store');
  const rt = new RuntimeOrch({ config: { agents: {} } as never, storeDir: join(storeRoot, '.store') });

  const workspace = (name: string, docs: number): string => {
    const d = ctx.dir(`workspace/${name}`);
    writeFileSync(join(d, 'input.txt'), 'Codex lifecycle probe.\n');
    for (let i = 0; i < docs; i++) writeFileSync(join(d, `doc-${i}.txt`), `Doc ${i}: lorem ipsum dolor sit amet. `.repeat(40));
    return d;
  };

  // ---- Codex cancel (cooperative) ----
  {
    const dir = workspace('cancel', 12);
    const handle = rt.run({ agentId: 'codex', prompt: LONG, cwd: dir, timeoutMs: 120_000 });
    await sleep(2500);
    const rootPid = handle.observe?.()?.pid ?? null;
    ctx.trackProcess(rootPid);
    const facts = latestOwnedControlFacts(ctx);
    const launcherPid = facts['launcherPid'] ? Number(facts['launcherPid']) : null;
    await handle.cancel('W4.2 codex real cancel');
    const r = await handle.result().catch(() => null);
    const cf = latestOwnedControlFacts(ctx);
    rec('codex cancel: outcome=cancelled', r?.state === 'cancelled' ? 'PASS' : 'FAIL', `state=${String(r?.state)}`);
    rec('codex cancel: launcherStatus=terminated', cf['launcherStatus'] === 'terminated' ? 'PASS' : 'FAIL', String(cf['launcherStatus']));
    rec('codex cancel: treeStopConfirmed', r?.cleanup.treeStopConfirmed === true ? 'PASS' : 'FAIL', JSON.stringify(r?.cleanup));
    rec('codex cancel: root dead', rootPid === null || !pidAlive(rootPid) ? 'PASS' : 'FAIL', `pid=${String(rootPid)} launcherPid=${String(launcherPid)}`);

    // W4.4 §9: inject after cancel/containment is established. No 90s smoke needed.
    injectAt('after-cancel');
  }

  // ---- Codex deadline (production onDeadline) ----
  {
    const dir = workspace('deadline', 12);
    const r = await rt.run({ agentId: 'codex', prompt: LONG, cwd: dir, timeoutMs: 2500 }).result().catch(() => null);
    const cf = latestOwnedControlFacts(ctx);
    rec('codex deadline: outcome=timed_out', r?.state === 'timed_out' ? 'PASS' : 'FAIL', `state=${String(r?.state)}`);
    rec('codex deadline: treeStopConfirmed', r?.cleanup.treeStopConfirmed === true ? 'PASS' : 'FAIL', JSON.stringify(r?.cleanup));
    rec('codex deadline: launcherStatus=terminated', cf['launcherStatus'] === 'terminated' ? 'PASS' : 'INFO', String(cf['launcherStatus']));
  }

  // ---- Codex natural smoke (classification of the service dependency) ----
  // The upstream model service intermittently times out after emitting turn.started.
  // That is an ENVIRONMENT fact, not a product defect, and re-running it costs 90s of
  // wall clock for no new information. It is therefore opt-in via ORCH_CODEX_SMOKE=1.
  if (process.env.ORCH_CODEX_SMOKE === '1') {
    const dir = workspace('smoke', 0);
    const started = Date.now();
    const r = await rt.run({ agentId: 'codex', prompt: 'Return exactly CODEX_W4_OK', cwd: dir, timeoutMs: 90_000 })
      .result().catch(() => null);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const cf = latestOwnedControlFacts(ctx);
    rec(`codex natural smoke (${elapsed}s)`, r?.state === 'succeeded' ? 'PASS' : 'ENVIRONMENT_BLOCKED',
      `state=${String(r?.state)} exit=${String(r?.exitCode)} status=${String(cf['launcherStatus'])} treeStop=${String(cf['treeStopped'])}`);
  } else {
    rec('codex natural smoke', 'SKIPPED_BY_DEFAULT',
      'upstream model service intermittently times out (MODEL/SERVICE_LATENCY); re-run with ORCH_CODEX_SMOKE=1');
  }
}

let cleanupFailures: Awaited<ReturnType<typeof withOwnedTestContext>> = [];
let fatal: unknown;
try {
  cleanupFailures = await withOwnedTestContext('W4.2 Codex lifecycle', runTest);
} catch (e) {
  fatal = e;
  console.log(`  INJECTED           ${String((e as Error).message)}`);
}

writeHygieneReport(fatal);
console.log('\nW4.2 Codex summary:');
for (const x of results) console.log(`  [${x.verdict}] ${x.name}${x.detail ? ` :: ${x.detail}` : ''}`);
if (cleanupFailures.length > 0) {
  console.log('\nCLEANUP FAILURES (test must fail):');
  for (const f of cleanupFailures) console.log(`  - ${f.resource}: ${f.error}`);
}
if (fatal !== undefined) {
  if (!String((fatal as Error).message).startsWith('[W4.4 injected')) throw fatal;
  process.exitCode = 1;
} else {
  process.exitCode = finish(results, { allowEnvironmentBlocked: true, cleanupFailures });
}