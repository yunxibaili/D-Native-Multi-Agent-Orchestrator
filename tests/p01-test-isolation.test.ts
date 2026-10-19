/**
 * tests/p01-test-isolation.test.ts — OFFLINE test isolation (P0-1).
 *
 * Proves that once the offline policy is frozen, no test process can discover,
 * authenticate or launch a REAL coding agent — and that the refusal happens at the
 * SHARED process edge BEFORE any OS process is created, so it is a runtime-owned
 * proven-not-started refusal (the WRITE claim can be released) rather than a
 * post-spawn failure.
 *
 * It also proves the policy is NOT a blunt "no processes" switch: a controlled Node
 * fixture (a benign OS child) still runs, so the reviewed offline suites keep working.
 *
 * It never launches a real agent to prove a rejection: every "real agent" here is a
 * controlled FILE whose NAME the policy matches, so the test is offline and instant.
 *
 * Run: node tests/p01-test-isolation.test.ts
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setLogLevel } from '../src/core/log.ts';
import {
  installOfflinePolicy,
  isOfflineFrozen,
  offlinePolicyState,
  evaluateOfflineSpawn,
  FORBIDDEN_AGENT_IDS,
  OFFLINE_AGENT_LAUNCH_REFUSED,
} from '../src/runtime/offline-policy.ts';
import { isProvenNotStarted } from '../src/runtime/start-proof.ts';
import { ManagedProcess } from '../src/runtime/spawn.ts';
import { launcherFor } from '../src/runtime/launcher.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { runApprovedTest } from '../src/orchestration/completion-evidence.ts';
import { normalizeSuiteEntry } from '../scripts/test-timed.mjs';
import { nodeLauncher, FIXTURE_PATH, writeScenario } from './helpers/native-agent-policy.ts';
import type { AgentAdapter, LauncherSpec, RunRequest, Transport } from '../src/core/types.ts';

setLogLevel('warn');

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed++;
    failures.push(name);
    process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

function skip(name: string, why: string): void {
  process.stdout.write(`  skip ${name} (${why})\n`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ROOT = mkdtempSync(join(tmpdir(), 'orchestrator-isolation-'));
let cleanupFailed = false;

function writeAgentFile(name: string): string {
  const p = join(ROOT, name);
  writeFileSync(p, '@echo off\r\nREM controlled marker, never executed\r\n');
  return p;
}

/** Try to construct a ManagedProcess and report the refusal honestly. */
function refuseKind(launcher: LauncherSpec, args: string[]): { threw: boolean; branded: boolean; code: string | undefined; message: string } {
  try {
    const p = new ManagedProcess({ launcher, args, cwd: ROOT });
    // If it did not throw, cancel immediately and report that (a failure).
    void p.cancel('isolation test').catch(() => {});
    return { threw: false, branded: false, code: undefined, message: 'no refusal' };
  } catch (e) {
    return {
      threw: true,
      branded: isProvenNotStarted(e),
      code: (e as { code?: string }).code,
      message: String((e as Error).message),
    };
  }
}

async function main(): Promise<void> {
  process.stdout.write('\noffline test isolation (P0-1)\n');

  // ---- 1. the policy freezes and cannot be promoted -------------------
  process.stdout.write('\n  policy freeze\n');
  installOfflinePolicy();
  ok('the offline policy is frozen', isOfflineFrozen() === true);
  installOfflinePolicy();
  ok('re-installing only re-asserts the frozen state (no promote-to-live API)', isOfflineFrozen() === true);
  ok('the policy names the real agent identities', FORBIDDEN_AGENT_IDS.includes('opencode') && FORBIDDEN_AGENT_IDS.includes('codex'));

  // ---- 1b. the denial set is immutable AT RUNTIME, not only in TS ----
  ok('the exported denied-id snapshot is frozen', Object.isFrozen(FORBIDDEN_AGENT_IDS) === true);
  {
    // The P0-1 no-spawn bypass: mutate the exported authoritative array, then
    // re-evaluate. A frozen array must refuse the splice, and the module-private
    // authority must stay intact so the same launch is STILL denied.
    const victim = writeAgentFile('codex.exe');
    const lr = launcherFor(victim);
    if (lr.ok) {
      const before = evaluateOfflineSpawn({ launcher: lr.launcher });
      ok('baseline: a real codex.exe target is denied', before.allowed === false, JSON.stringify(before));
      let spliceThrew = false;
      try {
        (FORBIDDEN_AGENT_IDS as string[]).splice(0, FORBIDDEN_AGENT_IDS.length);
      } catch {
        spliceThrew = true;
      }
      const after = evaluateOfflineSpawn({ launcher: lr.launcher });
      ok('a raw splice of the exported array is refused (frozen at runtime)', spliceThrew === true);
      ok('the same launch is STILL denied after the attempted splice', after.allowed === false, JSON.stringify(after));
    } else {
      skip('runtime-immutability of the deny set', lr.reason);
    }
    const state = offlinePolicyState();
    ok('offlinePolicyState exposes a frozen snapshot, not the live authority', Object.isFrozen(state.forbiddenAgents) === true);
  }

  // ---- 2. real agent launchers are refused BEFORE spawn --------------
  process.stdout.write('\n  real agent launchers refused pre-spawn\n');
  {
    const shim = writeAgentFile('opencode.cmd');
    const native = writeAgentFile('codex.exe');
    const jsScript = writeAgentFile('opencode.cjs');

    const shimL = launcherFor(shim);
    if (shimL.ok) {
      const r = refuseKind(shimL.launcher, []);
      ok('a real opencode.cmd launcher is refused', r.threw, r.message);
      ok('the refusal is a runtime-owned proven-not-started refusal', r.branded, r.message);
      ok('the refusal names the real agent', /opencode/i.test(r.message), r.message);
      ok('the pre-spawn refusal carries the dedicated OFFLINE_AGENT_LAUNCH_REFUSED code', r.code === OFFLINE_AGENT_LAUNCH_REFUSED, `${r.code}`);
    } else {
      skip('opencode.cmd refusal', shimL.reason);
    }

    const natL = launcherFor(native);
    if (natL.ok) {
      const r = refuseKind(natL.launcher, []);
      ok('a real codex.exe launcher is refused', r.threw && r.branded, r.message);
    } else {
      skip('codex.exe refusal', natL.reason);
    }

    // `node <agent>.js` carries the real executable in the ARGS, not the launcher.
    const r = refuseKind(nodeLauncher(), [jsScript]);
    ok('a node <agent>.js launch is refused', r.threw && r.branded, r.message);
    ok('the node-script refusal names the real agent', /opencode/i.test(r.message), r.message);
    ok('the node-script refusal carries the dedicated OFFLINE_AGENT_LAUNCH_REFUSED code', r.code === OFFLINE_AGENT_LAUNCH_REFUSED, `${r.code}`);

    // A non-existent path that merely LOOKS like an agent is allowed (no false positive).
    const decision = evaluateOfflineSpawn({
      launcher: { command: process.execPath, target: process.execPath },
      args: [join(ROOT, 'no-such-opencode.exe')],
    });
    ok('a non-existent agent-named path is not a false positive', decision.allowed === true, JSON.stringify(decision));
  }

  // ---- 3. a benign OS child still runs (policy is not "no processes") -
  process.stdout.write('\n  benign controlled child still runs\n');
  {
    const p = new ManagedProcess({ launcher: nodeLauncher(), args: ['-e', 'process.exit(0)'], cwd: ROOT });
    const exit = await p.exited;
    await p.settleCleanup().catch(() => false);
    ok('a controlled node child is allowed and exits 0', exit.code === 0, JSON.stringify(exit));
  }

  // ---- 4. env / config / recreated runtime cannot elevate ------------
  process.stdout.write('\n  no elevation\n');
  {
    process.env.ORCH_B12_REAL_MODEL = '1';
    process.env.ORCH_B47_REAL_FREE_DUO = '1';
    installOfflinePolicy();
    const shim = writeAgentFile('cline.cmd');
    const l = launcherFor(shim);
    if (l.ok) {
      const r = refuseKind(l.launcher, []);
      ok('env flags cannot promote the frozen policy to live', r.threw && r.branded, r.message);
    } else {
      skip('cline.cmd refusal under env flags', l.reason);
    }
    delete process.env.ORCH_B12_REAL_MODEL;
    delete process.env.ORCH_B47_REAL_FREE_DUO;

    const forged = launcherFor(writeAgentFile('workbuddy.exe'));
    if (forged.ok) {
      const adapter: AgentAdapter = {
        descriptor: { id: 'forged', displayName: 'forged', launcher: forged.launcher, transport: 'cli-jsonl', capabilities: { newTask: true, resume: false, review: false, modelSelection: false, roleSelection: false, sandbox: false, streamEvents: true, costReporting: false, extraArgs: false, cwd: true, skills: false, steering: false, worktree: false, fork: false, stdinPrompt: false, workspaceModes: ['shared'] } },
        terminalPolicy: () => ({ state: 'failed', error: { code: 'TRANSPORT_ERROR', message: 'unreachable' } }),
        validateRequest: (_r: RunRequest) => {},
        async probe() { return { ok: true, launcher: forged.launcher, version: null, detail: '', warnings: [] }; },
        createTransport(_r: RunRequest): Transport { throw new Error('createTransport must never be reached for a refused launcher'); },
        mapEvent() { return []; },
      };
      const orch = new Orchestrator({ config: { agents: {} } as never, storeDir: join(ROOT, 'store-elev', '.store'), replaceAdapters: [adapter] });
      let threw = false;
      let branded = false;
      try {
        orch.run({ agentId: 'forged', prompt: 'x', cwd: ROOT });
      } catch (e) {
        threw = true;
        branded = isProvenNotStarted(e);
      }
      ok('a recreated runtime cannot elevate (launcher refused at preflight)', threw, `threw=${threw}`);
      ok('the preflight refusal is a runtime-owned proven-not-started refusal', branded);
      ok('no session is created for a refused launch', orch.activeSessions().length === 0, `${orch.activeSessions().length}`);
    } else {
      skip('workbuddy.exe preflight refusal', forged.reason);
    }
  }

  // ---- 5. the shared approved-test chain is covered ------------------
  process.stdout.write('\n  shared approved-test chain\n');
  {
    // (a) HARMLESS POSITIVE CONTROL, production-compatible: the approved test names a
    // BARE `node` (the chain resolves the executable exactly like an agent id), so a
    // benign Node command really runs through the REAL approved-test chain and its marker
    // is actually written. This is what proves the chain — and the marker binding in (b)
    // — is load-bearing, not tautological. It never promotes a process to live.
    const okMarker = join(ROOT, 'approved-benign-ran.txt');
    const benign = await runApprovedTest(
      {
        executable: 'node',
        argv: ['-e', `require('fs').writeFileSync(${JSON.stringify(okMarker)}, 'ran')`],
        cwd: '.',
      },
      ROOT,
      30_000,
    );
    // No skip: if the configured bare `node` cannot be resolved, this POSITIVE control
    // must FAIL — a skipped positive would let a broken/edited-away chain look green.
    ok('a benign approved test really runs through the shared chain', benign.code === 0, JSON.stringify(benign));
    ok('the benign approved test really wrote its marker', existsSync(okMarker) === true);

    // (b) NEGATIVE CONTROL: the chain resolves `node`, but the ARG is a controlled script
    // whose basename is a real AGENT id AND whose body would write a marker if it ever
    // executed. The shared gate must refuse BEFORE the script runs, so the marker's
    // ABSENCE is a real signal — never a real AI CLI.
    const agentMarker = join(ROOT, 'approved-agent-ran.txt');
    const agentScript = join(ROOT, 'opencode.cjs');
    writeFileSync(agentScript, `require('fs').writeFileSync(${JSON.stringify(agentMarker)}, 'ran');\n`);
    const refusal = await runApprovedTest(
      { executable: 'node', argv: [agentScript], cwd: '.' },
      ROOT,
      30_000,
    );
    ok('an approved test bound to a real-agent-named node script never produces an exit status',
      refusal.code === null && refusal.timedOut === false, JSON.stringify(refusal));
    ok('the refused approved test did NOT execute (its marker is absent)', existsSync(agentMarker) === false);
    // STRICT gate signature: the STABLE dedicated code must be present, and it must NOT
    // be a resolve/argv failure. A broad `/offline/` + `/opencode/` regex could match an
    // unrelated refusal, so we pin the exact code emitted by the shared gate.
    ok('the refusal carries the dedicated OFFLINE_AGENT_LAUNCH_REFUSED gate code',
      refusal.note.includes(OFFLINE_AGENT_LAUNCH_REFUSED), refusal.note);
    ok('the refusal is NOT a resolve/argv failure',
      !/could not resolve/i.test(refusal.note) && !/argv/i.test(refusal.note), refusal.note);

    // The stopVerdictProbe seam may only DOWNGRADE the tree-stop verdict. Using a
    // controlled node fixture, force the unconfirmed branch and prove the shared chain
    // reports the fact honestly (this is the fact the WRITE-claim layer keys on).
    const dir = join(ROOT, 'approved');
    writeScenario(dir, { mode: 'exit', text: 'ok', code: 0 });
    const outcome2 = await runApprovedTest(
      { executable: 'node', argv: [FIXTURE_PATH], cwd: '.' },
      dir,
      30_000,
      { stopVerdictProbe: () => false },
    );
    // No skip: the required stop-probe assertions must FAIL, not vanish, if the chain
    // cannot be resolved. A skip here would hide a missing downgrade guarantee.
    ok('a downgraded tree-stop is reported as treeStopConfirmed=false', outcome2.treeStopConfirmed === false, JSON.stringify(outcome2));
    ok('the caller is told the execution may have started (claim stays protected)', outcome2.mayHaveStarted === true, JSON.stringify(outcome2));
  }

  // ---- 7. the runner normalises EVERY suite selector -----------------
  process.stdout.write('\n  runner suite-selector normalisation\n');
  {
    const w = process.platform === 'win32' ? '\\' : '/';
    const canonical = normalizeSuiteEntry('tests/cancel.test.ts');
    ok('a canonical suite name resolves to its manifest path', canonical.ok === true && canonical.file === 'tests/cancel.test.ts');
    ok('a backslash-separated canonical name is normalised', normalizeSuiteEntry(`tests${w}cancel.test.ts`).ok === true);
    // A canonical ABSOLUTE path inside the workspace is still normalised to the SAME
    // manifest entry — an absolute form grants no exemption, it simply resolves.
    const absCanonical = normalizeSuiteEntry(join(REPO_ROOT, 'tests', 'cancel.test.ts'));
    ok('a canonical ABSOLUTE path resolves to its manifest path',
      absCanonical.ok === true && absCanonical.file === 'tests/cancel.test.ts', JSON.stringify(absCanonical));
    const dotdot = normalizeSuiteEntry('../outside.test.ts');
    ok('a `..` escape is refused', dotdot.ok === false && dotdot.code === 'outside-workspace', JSON.stringify(dotdot));
    const absOutside = normalizeSuiteEntry(join(ROOT, 'abs.test.ts'));
    ok('an absolute path OUTSIDE the workspace is refused', absOutside.ok === false && absOutside.code === 'outside-workspace', JSON.stringify(absOutside));
    const absNonCanonical = normalizeSuiteEntry(join(REPO_ROOT, 'tests', 'smoke.ts'));
    ok('an absolute NON-canonical path is refused (the old absolute exemption is gone)',
      absNonCanonical.ok === false && absNonCanonical.code === 'non-canonical', JSON.stringify(absNonCanonical));
    const live = normalizeSuiteEntry('tests/b47-free-duo.test.ts');
    ok('a LIVE suite is refused before any spawn', live.ok === false && live.code === 'live-suite', JSON.stringify(live));
    const unknown = normalizeSuiteEntry('tests/not-a-reviewed-suite.test.ts');
    ok('an unknown suite is refused', unknown.ok === false && unknown.code === 'non-canonical', JSON.stringify(unknown));
    const empty = normalizeSuiteEntry('');
    ok('an empty selector is refused', empty.ok === false && empty.code === 'empty-entry', JSON.stringify(empty));
  }

  // ---- 6. the policy does not leak into a benign shell ----------------
  process.stdout.write('\n  policy state\n');
  ok('offlinePolicyState reports frozen', offlinePolicyState().frozen === true && offlinePolicyState().frozenAt !== null);

  await sleep(1);
  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failures.length) process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
}

try {
  await main();
} catch (e) {
  failed++;
  failures.push(`unexpected error: ${String((e as Error)?.message ?? e)}`);
  process.stdout.write(`  FAIL unexpected error: ${String((e as Error)?.stack ?? e)}\n`);
} finally {
  try {
    if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    cleanupFailed = true;
    process.stdout.write(`  FAIL owned-root cleanup failed: ${String((e as Error).message)}\n`);
  }
  process.stdout.write(`\n${passed} passed, ${failed} failed${cleanupFailed ? ', cleanup FAILED' : ''}\n\n`);
  process.exitCode = failed === 0 && !cleanupFailed ? 0 : 1;
}
