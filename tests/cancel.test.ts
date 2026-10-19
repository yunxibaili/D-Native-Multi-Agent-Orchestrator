/**
 * tests/cancel.test.ts — cancellation, process-tree cleanup, and the process
 * lifecycle contract on Windows.
 *
 * Two real Windows bugs were found and fixed while writing this file, and both
 * are guarded here:
 *
 *  HANG — Node's `'close'` waits for all stdio. A grandchild that inherits the
 *  stdout/stderr handles keeps them open, so `'close'` never fires and anything
 *  awaiting it hangs forever. A real agent spawns PowerShell children, so this was
 *  the NORMAL case for a cancelled task. Fixed by finalizing on `'exit'` with a
 *  short drain window.
 *
 *  LEAK — `child.kill()` on Windows is TerminateProcess on the direct child only,
 *  and `taskkill /T` needs a LIVE root. So "SIGINT then taskkill" cannot work: the
 *  root is already gone and the grandchildren are orphaned. Fixed by tree-killing
 *  first on Windows, and by AWAITING taskkill instead of firing and forgetting.
 *
 * ============================================================================
 * OFFLINE BY CONSTRUCTION (P0-1 test-isolation fix)
 * ============================================================================
 * This suite NO LONGER constructs a real `Orchestrator` that discovers and runs
 * real Codex. That was the incident: three invocations launched six real sessions.
 * Every process here is a CONTROLLED Node fixture driven through the REAL contained
 * `ManagedProcess` / `Orchestrator` chain, so the OS cancel / deadline / tree-stop
 * evidence is still real, but no real agent is ever discovered, authenticated or
 * launched. Liveness is proven from HELD HANDLE facts (the process handle this
 * process owns) and an independent heartbeat file — never from a process-name count
 * and never from a bare-PID kill.
 *
 * Run: node tests/cancel.test.ts
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setLogLevel } from '../src/core/log.ts';
import { installOfflinePolicy } from '../src/runtime/offline-policy.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { Orchestrator as TaskOrchestrator } from '../src/orchestration/orchestrator.ts';
import { WorkspaceManager } from '../src/orchestration/workspace.ts';
import { normalizeScopeForWorkspace } from '../src/orchestration/resource-claim.ts';
import { BudgetManager } from '../src/quota/budget.ts';
import { ModelRegistry } from '../src/quota/registry.ts';
import { ManagedProcess } from '../src/runtime/spawn.ts';
import { launcherFor } from '../src/runtime/launcher.ts';
import { containmentEnabled } from '../src/runtime/containment.ts';
import {
  createOfflineFixtureAdapter,
  writeScenario,
  FIXTURE_PATH,
} from './helpers/native-agent-policy.ts';
import { open as openObserver } from './helpers/process-observer.ts';
import type { AgentDescriptor, RunHandle, RunRequest } from '../src/core/types.ts';

// Freeze the offline deny policy IN-PROCESS too, so running this file directly
// (`node tests/cancel.test.ts`) is just as safe as running it under the runner.
installOfflinePolicy();

setLogLevel('warn');

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

/** A skip is not a failure: used only for genuinely machine-dependent bits. */
function skip(name: string, why: string): void {
  process.stdout.write(`  skip ${name} (${why})\n`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const nodeLauncher = (): ReturnType<typeof launcherFor> => launcherFor(process.execPath);

/** The one directory this suite owns; removed (and only it) on the way out. */
const OWNED_ROOT = mkdtempSync(join(tmpdir(), 'orchestrator-cancel-'));
let cleanupFailed = false;

function heartbeat(file: string): string {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

function orchestrator(): Orchestrator {
  return new Orchestrator({
    config: { agents: {} } as never,
    storeDir: join(OWNED_ROOT, `store-${Math.random().toString(36).slice(2)}`, '.store'),
    replaceAdapters: [createOfflineFixtureAdapter()],
  });
}

async function main(): Promise<void> {
  process.stdout.write('\ncancellation and process lifecycle (Windows, offline)\n');

  // ---- 1. plain process kill ------------------------------------------
  process.stdout.write('\n  basic kill\n');
  {
    const l = nodeLauncher();
    if (!l.ok) throw new Error('cannot resolve node launcher');
    const h = new ManagedProcess({
      launcher: l.launcher,
      args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: OWNED_ROOT,
    });
    await sleep(500);
    const hadPid = h.pid !== undefined;
    const cancelOk = await h.cancel('unit test');
    const settled = await h.settleCleanup();
    const exit = await h.exited;
    // Contained cooperative cancellation legitimately leaves BOTH code and signal
    // null (the root exit code is withheld for a `terminated` record). The physical
    // proof is the validated Job stop, never a fabricated root exit. A real terminal
    // status (e.g. a pre-launch spawn failure) is also accepted honestly.
    const stopped1 = exit.code !== null || exit.signal !== null
      || (h.isTreeStopConfirmed() === true && h.containment?.activeProcessesFinal === 0);
    ok(
      'a long-running process is stopped (validated Job stop when contained)',
      stopped1,
      JSON.stringify({ exit, treeStop: h.isTreeStopConfirmed(), active: h.containment?.activeProcessesFinal ?? null }),
    );
    ok('the handle reports a pid while alive', hadPid);
    ok('cancel() resolves only after cleanup is awaited', cancelOk && settled);
  }

  // ---- 2. tree kill reaches a grandchild that holds the pipes ---------
  process.stdout.write('\n  tree kill (grandchild holding inherited stdio)\n');
  {
    const dir = join(OWNED_ROOT, 'tree');
    const l = nodeLauncher();
    if (!l.ok) throw new Error('cannot resolve node launcher');
    writeScenario(dir, { mode: 'tree', heartbeatMs: 120, childHeartbeat: 'grandchild-heartbeat.txt' });

    const h = new ManagedProcess({
      launcher: l.launcher,
      args: [FIXTURE_PATH],
      cwd: dir,
    });

    // The grandchild pid is published by the fixture; wait (bounded) for it.
    const pidFile = join(dir, 'grandchild-pid.txt');
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !existsSync(pidFile)) await sleep(100);
    const grandchildPid = Number((heartbeat(pidFile) || '0'));
    ok('the grandchild process was actually created', Number.isInteger(grandchildPid) && grandchildPid > 0, `pid=${grandchildPid}`);

    await sleep(500);
    const beatBefore = heartbeat(join(dir, 'grandchild-heartbeat.txt'));
    ok('the grandchild is heartbeating before cancel', beatBefore !== '', JSON.stringify(beatBefore));

    // Optional held-handle corroboration when the native observe fixture is deployed.
    const observer = Number.isInteger(grandchildPid) && grandchildPid > 0 ? openObserver(grandchildPid, { holdMs: 4000 }) : null;
    let heldBefore = false;
    try {
      heldBefore = observer !== null && (await observer.acquired());

      await h.cancel('unit test');
      const raced = await Promise.race([
        h.exited.then((e) => ({ ok: true as const, e })),
        sleep(8000).then(() => ({ ok: false as const, e: null })),
      ]);
      ok('exited resolves within 8s (no hang on held pipes)', raced.ok, raced.ok ? '' : 'still pending');
      if (raced.ok) {
        // A contained cooperative stop legitimately reports null code+signal; the
        // validated Job stop (treeStopConfirmed + activeProcessesFinal==0) is the
        // physical fact. Never demand a fabricated root exit.
        ok(
          'exited reports a validated status',
          raced.e.code !== null || raced.e.signal !== null
            || (h.isTreeStopConfirmed() === true && h.containment?.activeProcessesFinal === 0),
          JSON.stringify({ e: raced.e, treeStop: h.isTreeStopConfirmed(), active: h.containment?.activeProcessesFinal ?? null }),
        );
      }

      const cleaned = await h.settleCleanup();
      // The Job's own confirmed tree-stop is the primary fact, read from the HELD
      // ManagedProcess handle (never inferred from a process-name count).
      const treeStop = h.isTreeStopConfirmed();
      ok('the held handle CONFIRMS the tree stop (or containment is off)', !containmentEnabled() || (treeStop === true && cleaned === true), JSON.stringify({ treeStop, cleaned, contained: containmentEnabled() }));

      // Independent liveness: the grandchild's heartbeat must STOP advancing.
      const stopped = await (async (): Promise<boolean> => {
        const a = heartbeat(join(dir, 'grandchild-heartbeat.txt'));
        await sleep(900);
        const b = heartbeat(join(dir, 'grandchild-heartbeat.txt'));
        return a !== '' && a === b;
      })();
      ok('the grandchild stops heartbeating after the tree kill (no leak)', stopped);

      if (observer !== null) {
        // Require a POSITIVELY ACQUIRED handle AND an EXITED verdict. `state !== ALIVE`
        // would wrongly accept OBSERVATION_ERROR as proof of death.
        const v = await observer.verdict(8000);
        ok('held-handle observation proves the grandchild EXITED', heldBefore && v.state === 'EXITED', JSON.stringify({ heldBefore, v }));
        const reapedOk = await observer.reaped(5000);
        ok('the owned observer process is reaped', reapedOk === true);
      } else {
        skip('held-handle grandchild death proof', 'native observe fixture not deployed');
      }
    } finally {
      // Protect every live process/observer: never delete the owned root before the
      // stops are proven, and always release the observer's handle.
      await h.settleCleanup().catch(() => false);
      if (observer !== null) await observer.reaped(5000).catch(() => false);
    }
  }

  // ---- 3. stderr tail captures COMPLETE lines -------------------------
  process.stdout.write('\n  stderr tail\n');
  {
    const dir = join(OWNED_ROOT, 'stderr');
    const l = nodeLauncher();
    if (!l.ok) throw new Error('cannot resolve node launcher');
    writeScenario(dir, { mode: 'stderr', lines: ['FIRSTLINE', 'SECONDLINE'], code: 3 });
    const h = new ManagedProcess({
      launcher: l.launcher,
      args: [FIXTURE_PATH],
      cwd: dir,
    });
    const exit = await h.exited;
    await sleep(200);
    const tail = h.stderrTail.toString();
    ok('non-zero exit is reported', exit.code === 3, `${exit.code}`);
    // Regression: the old implementation sliced first, keeping only the trailing
    // partial line, so complete lines vanished.
    ok('stderr tail keeps a COMPLETE first line', tail.includes('FIRSTLINE'), JSON.stringify(tail));
    ok('stderr tail keeps a COMPLETE last line', tail.includes('SECONDLINE'), JSON.stringify(tail));
  }

  // ---- 4. orchestrator: cancel a live task ----------------------------
  process.stdout.write('\n  orchestrator: cancelling a live task\n');
  {
    const orch = orchestrator();
    const dir = join(OWNED_ROOT, 'run4');
    writeScenario(dir, { mode: 'stream', text: 'tick', heartbeatMs: 150 });

    const handle = orch.run({ agentId: 'offline-fixture', prompt: 'p1', cwd: dir, timeoutMs: 30_000 });

    let sawActivity = false;
    let runningAtCancel = false;
    const consumer = (async () => {
      for await (const ev of handle.events()) {
        if (ev.type === 'session.started' || ev.type === 'session.diagnostic') continue;
        if (ev.type === 'session.output' && !sawActivity) {
          sawActivity = true;
          runningAtCancel = handle.state() === 'running';
          await handle.cancel('operator cancelled the test');
        }
      }
    })();

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !sawActivity) await sleep(50);

    ok('the task produced intermediate activity before cancellation', sawActivity);
    ok('the task was still running when cancel was issued', runningAtCancel, 'state at cancel was not running');

    const result = await handle.result();
    ok('cancelled task reports state=cancelled', result.state === 'cancelled', `state=${result.state}`);
    ok('cancelled is NOT reported as succeeded', result.state !== 'succeeded');
    ok('cancelled carries an error', result.error?.code === 'CANCELLED', JSON.stringify(result.error));
    ok('repeated result after cancel is identical', (await handle.result()) === result);

    const stored = orch.getTask(result.taskId);
    ok('cancelled task is persisted with state=cancelled', stored?.state === 'cancelled', stored?.state);
    ok('the live-session entry is released', orch.activeSessions().length === 0, `${orch.activeSessions().length}`);
    await consumer;
  }

  // ---- 5. NORMAL completion: descendants are reaped, not leaked ------
  process.stdout.write('\n  normal completion descendant cleanup\n');
  {
    const orch = orchestrator();
    const dir = join(OWNED_ROOT, 'run5');
    writeScenario(dir, { mode: 'session', session: 'thread-normal', text: 'PONG' });
    const r = await orch.run({ agentId: 'offline-fixture', prompt: 'Reply with exactly: PONG', cwd: dir, timeoutMs: 60_000 }).result();
    ok('a normal run still succeeds', r.state === 'succeeded', `${r.state} ${r.error?.message ?? ''}`);
    ok('a normal run records its native thread id', r.threadId === 'thread-normal', String(r.threadId));

    // A normal exit must NOT have issued a kill against a dead root.
    ok('normal run reports that no root kill happened', r.cleanup.rootKilled === false, JSON.stringify(r.cleanup));
    ok(
      'normal run explains why the dead root was not taskkilled',
      /already exited|no live root/i.test(r.cleanup.note),
      r.cleanup.note,
    );
  }

  // ---- 5b. the lifecycle paths each report a cleanup result -----------
  process.stdout.write('\n  lifecycle paths report cleanup\n');
  {
    const l = nodeLauncher();
    if (!l.ok) throw new Error('cannot resolve node launcher');

    // normal
    const normalDir = join(OWNED_ROOT, 'loop-normal');
    writeScenario(normalDir, { mode: 'exit', text: 'done', code: 0 });
    const normal = new ManagedProcess({ launcher: l.launcher, args: [FIXTURE_PATH], cwd: normalDir });
    const ne = await normal.exited;
    const nCleanup = await normal.reapDescendants('normal');
    ok('normal: exit code 0', ne.code === 0, `${ne.code}`);
    ok('normal: no root kill was issued against the dead root', nCleanup.rootKilled === false, JSON.stringify(nCleanup));
    ok('normal: a cleanup note is recorded', nCleanup.note.length > 0);

    // failure
    const failDir = join(OWNED_ROOT, 'loop-failure');
    writeScenario(failDir, { mode: 'exit', text: 'nope', code: 1 });
    const failing = new ManagedProcess({ launcher: l.launcher, args: [FIXTURE_PATH], cwd: failDir });
    const fe = await failing.exited;
    const fCleanup = await failing.reapDescendants('failure');
    ok('failure: exit code 1', fe.code === 1, `${fe.code}`);
    ok('failure: no dangerous taskkill on a dead root', fCleanup.rootKilled === false, JSON.stringify(fCleanup));

    // cancel: DOES kill a live tree, and says so
    const cancelDir = join(OWNED_ROOT, 'loop-cancel');
    writeScenario(cancelDir, { mode: 'hang' });
    const longRun = new ManagedProcess({ launcher: l.launcher, args: [FIXTURE_PATH], cwd: cancelDir });
    await sleep(500);
    await longRun.cancel('cancel path');
    await longRun.settleCleanup();
    const le = await longRun.exited;
    ok(
      'cancel: the live process really is gone (validated Job stop when contained)',
      le.code !== null || le.signal !== null
        || (longRun.isTreeStopConfirmed() === true && longRun.containment?.activeProcessesFinal === 0),
      JSON.stringify({ le, treeStop: longRun.isTreeStopConfirmed(), active: longRun.containment?.activeProcessesFinal ?? null }),
    );

    // timeout: distinctly timed_out, and the task releases its slot
    const orch2 = orchestrator();
    const toDir = join(OWNED_ROOT, 'loop-timeout');
    writeScenario(toDir, { mode: 'hang' });
    const to = await orch2
      .run({ agentId: 'offline-fixture', prompt: 'hang forever', cwd: toDir, timeoutMs: 300 })
      .result();
    ok('timeout: state is timed_out', to.state === 'timed_out', to.state);
    ok('timeout: distinct from cancelled', to.state !== 'cancelled');
    ok('timeout: carries a TIMED_OUT error', to.error?.code === 'TIMED_OUT', JSON.stringify(to.error));
    ok('timeout: a cleanup result is still reported', typeof to.cleanup?.note === 'string' && to.cleanup.note.length > 0);
    ok('timeout: the live-session entry is released', orch2.activeSessions().length === 0, `${orch2.activeSessions().length}`);
  }

  // ---- 6. resume still works after a run ------------------------------
  process.stdout.write('\n  resume after a run\n');
  {
    const orch = orchestrator();
    const dir = join(OWNED_ROOT, 'run6');
    writeScenario(dir, { mode: 'session', session: 'thread-resume', text: 'PONG' });
    const first = await orch.run({ agentId: 'offline-fixture', prompt: 'Reply with exactly: PONG', cwd: dir, timeoutMs: 60_000 }).result();
    ok('baseline run succeeded', first.state === 'succeeded', `${first.state} ${first.error?.message ?? ''}`);
    ok('baseline produced a thread id', first.threadId !== null);

    if (first.threadId) {
      // Same agent, same cwd -> allowed.
      const resumed = await orch
        .run({ agentId: 'offline-fixture', prompt: 'Now reply with exactly: PONG2', cwd: dir, threadId: first.threadId, timeoutMs: 60_000 })
        .result();
      ok('resume after a run still works', resumed.state === 'succeeded', `${resumed.state} ${resumed.error?.message ?? ''}`);
      ok('resume reuses the same thread', resumed.threadId === first.threadId);
    }
  }

  // ---- 7. an unconfirmed stop RETAINS the shared WRITE claim ----------
  process.stdout.write('\n  shared WRITE claim retained after an unconfirmed stop\n');
  {
    // REAL fixture Runtime Orchestrator (a controlled Node fixture run through the REAL
    // contained ManagedProcess path — never a real agent) + REAL TaskOrchestrator + REAL
    // WorkspaceManager driving the REAL resource-claim book. Task A carries an explicit
    // completion contract, so the execution edge REALLY runs the APPROVED TEST (a bare
    // `node` that writes an owned marker). The narrow `completionTestStopProbe` seam ONLY
    // DOWNGRADES the test's own tree-stop verdict — the exact fact that must RETAIN A's
    // WRITE claim. A retained claim must then refuse a SECOND conflicting task with
    // `resource-conflict` and ZERO extra runtime requests. These assertions read the real
    // book and the real call count: a helper's outcome flag alone would prove nothing.
    const shared = join(OWNED_ROOT, 'shared-claim');
    mkdirSync(shared, { recursive: true });
    const scope = normalizeScopeForWorkspace('shared-claim', shared);

    // The runtime's own bookkeeping store lives OUTSIDE the workspace root, so it can
    // never be mistaken for a worker change (and never carries a claim).
    const inner = new Orchestrator({
      config: { agents: {} } as never,
      storeDir: join(OWNED_ROOT, 'shared-claim-runtime-store', '.store'),
      replaceAdapters: [createOfflineFixtureAdapter({ id: 'shared-agent' })],
    });

    // A REAL contained worker run: the controlled fixture emits a session event and exits
    // 0. fixture-mode.json and the PREEXISTING expected artifact are laid down BEFORE the
    // baseline manifest is captured, so neither is attributed to the attempt. The
    // preexisting artifact is a deliberately owned fixture for THIS retention
    // counterexample — it is NOT a fabricated product completion.
    writeScenario(shared, { mode: 'session', session: 'shared-claim-thread', text: 'ok' });
    const artifact = join(shared, 'artifact.txt');
    writeFileSync(artifact, 'preexisting\n', 'utf8');
    const testMarker = join(shared, 'approved-test-ran.txt');

    // The approved contract: the preexisting artifact satisfies `expectedArtifacts`, and
    // the approved test's own marker write is IN scope, so this counterexample measures
    // the STOP-retention seam ALONE — never a scope or artifact failure.
    const contract = {
      expectedArtifacts: ['artifact.txt'],
      allowedScope: ['artifact.txt', 'approved-test-ran.txt'],
      test: { executable: 'node', argv: ['-e', "require('fs').writeFileSync('approved-test-ran.txt','ran')"], cwd: '.' },
    };

    const budgets = new BudgetManager(1_000_000);
    budgets.agent('shared-agent', 1_000_000);
    const registry = new ModelRegistry();
    registry.upsert(
      { agentId: 'shared-agent', modelId: 'm1', provider: 'test', taskTypes: ['implementation'] as never, modelSource: 'test', quotaSource: 'test' },
      Date.now(),
    );
    registry.setAgentAvailability('shared-agent', 'available');

    const mgr = new WorkspaceManager({ projectRoot: shared, workspaceLock: false });
    const requests: RunRequest[] = [];
    const orch = new TaskOrchestrator({
      gate: {
        descriptors: [{
          id: 'shared-agent', displayName: 'shared-agent', launcher: 'fake', transport: 'cli-jsonl',
          capabilities: { newTask: true, review: true, modelSelection: true, resume: true, cwd: true, workspaceModes: ['shared'] },
        } as unknown as AgentDescriptor],
        agentStatus: [{ agentId: 'shared-agent', agent: 'shared-agent', version: '1', installed: 'Yes', login: 'y', quotaSource: 't', usage: 'n', status: 'ok' }],
        quotaRecords: [{ provider: 'shared-agent', agentId: 'shared-agent', modelId: null, source: 'cli_reported', usage: null, remaining: null, resetAt: null, period: 'unknown', status: 'available' as const, usageClass: 'reported' as const, confidence: 'high' as const, observedAt: Date.now(), note: '' }],
        registry,
        budgets,
        taskType: 'implementation' as const,
        requestedUnits: 10, currentConcurrency: 0, maxConcurrency: 4, maxChildren: 8, maxConcurrentAgents: 4, taskPolicyAllows: true,
      } as never,
      now: Date.now,
      defaultCwd: shared,
      workspace: mgr,
      workspaceMode: () => 'shared',
      resourceClaims: () => ({ mode: 'write' as const, scope }),
      completionTestStopProbe: () => false,
      // The request counter wraps the REAL runtime; no handmade RunResult/RunHandle.
      runtime: {
        run(req: RunRequest): RunHandle {
          requests.push(req);
          return inner.run(req);
        },
      },
    } as never);

    budgets.task('c-a', 100_000);
    budgets.task('c-b', 100_000);
    orch.createRoot({ taskId: 'c-root', agentId: 'shared-agent', taskType: 'implementation', acceptanceCriteria: 'root' });
    // `spawnChild` carries no contract, so task A is created through the store with the
    // explicit approved contract (the only channel), exactly as the production plan path does.
    orch.getStore().create({ taskId: 'c-a', parentTaskId: 'c-root', agentId: 'shared-agent', modelId: 'm1', taskType: 'implementation', acceptanceCriteria: 'c-a', budgetUnits: 10, completionContract: contract }, Date.now());
    orch.spawnChild({ taskId: 'c-b', parentTaskId: 'c-root', agentId: 'shared-agent', modelId: 'm1', taskType: 'implementation', acceptanceCriteria: 'c-b', budgetUnits: 10 });

    const runA = await orch.executeTask({ taskId: 'c-a' });
    ok('the first shared task really ran through the contained worker', runA.ok === true, runA.ok ? '' : `${runA.code} ${runA.reason}`);
    ok('the contained worker was dispatched exactly once', requests.length === 1, `calls ${requests.length}`);
    ok('the approved test really ran (its owned marker exists)', existsSync(testMarker) === true);
    const retained = mgr.retainedResourceProtections();
    ok('a PHYSICAL shared protection is retained for task A', retained.some((cl) => cl.taskId === 'c-a'),
      JSON.stringify(retained.map((cl) => `${cl.taskId}/${cl.mode}`)));
    ok('the retained protection carries task A\'s shared scope', retained.some((cl) => {
      const s = cl.scope;
      return cl.taskId === 'c-a' && s.kind === 'workspace' && s.workspaceId === 'shared-claim';
    }), JSON.stringify(retained.map((cl) => `${cl.taskId}:${cl.scope.kind}`)));
    const claimsAfterA = mgr.resourceClaimCount;

    const runB = await orch.executeTask({ taskId: 'c-b' });
    ok('a second conflicting task is refused SPECIFICALLY with resource-conflict', runB.ok === false && runB.code === 'resource-conflict',
      runB.ok ? 'it RAN' : `${runB.code} ${runB.reason.slice(0, 120)}`);
    ok('task B admission made ZERO extra runtime requests', requests.length === 1, `calls ${requests.length}`);
    ok('the WRITE claim is still held after task B admission', mgr.resourceClaimCount === claimsAfterA && mgr.retainedResourceProtections().some((cl) => cl.taskId === 'c-a'),
      `claims ${claimsAfterA} -> ${mgr.resourceClaimCount}`);
  }

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
  // Remove ONLY the one directory this suite created, after every owned process has
  // been stopped. A cleanup failure is a FAILURE (non-zero exit), never a silent pass.
  try {
    if (existsSync(OWNED_ROOT)) rmSync(OWNED_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    cleanupFailed = true;
    process.stdout.write(`  FAIL owned-root cleanup failed: ${String((e as Error).message)}\n`);
  }
  process.stdout.write(`\n${passed} passed, ${failed} failed${cleanupFailed ? ', cleanup FAILED' : ''}\n\n`);
  process.exitCode = failed === 0 && !cleanupFailed ? 0 : 1;
}
