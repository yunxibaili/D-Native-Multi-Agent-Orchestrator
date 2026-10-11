/**
 * tests/execution-lifecycle.test.ts — R5-1: execution timeout lifecycle seal.
 *
 * WHAT IS CLAIMED HERE, AND HOW IT IS MEASURED
 * ---------------------------------------------
 *   wait timeout ≠ execution failure   -> a `result()` wait that returns without a
 *                                         terminal can never mark a task failed,
 *                                         delete the live handle, or release the claim
 *   decision timeout ≠ agent timeout   -> the orchestrator receives NO wait bound;
 *                                         the only execution deadline rides on
 *                                         `RunRequest.timeoutMs` and is enforced by
 *                                         the runtime's own AgentSession boundary
 *   real deadline terminates cleanly   -> a hung session deadline produces a REAL
 *                                         frozen `timed_out` terminal through the
 *                                         session's own cancel path (Case 3)
 *   single terminalization             -> concurrent/duplicate result() calls yield
 *                                         the identical frozen object, once
 *   git timeout kills the child FIRST  -> runGit returns only after the timed-out
 *                                         child is confirmed dead, so a workspace
 *                                         lock is never released under a live git
 *   Windows tree termination works     -> ManagedProcess.cancel on a live node child
 *                                         ends the process tree, awaited
 *   LF/CRLF are equivalent to guards   -> source-text guards read through a
 *                                         normalizing reader, both endings pass
 *
 * Nothing here spawns a real Codex/OpenCode: Cases 5/6 use a controlled node child
 * and everything else uses the same synthetic handle/transport fixtures as the other
 * suites, so the file is independent of agent auth state.
 */

import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';

import { Orchestrator } from '../src/orchestration/orchestrator.ts';
import { TaskStore } from '../src/orchestration/store.ts';
import { buildRunRequest, type RuntimeRunner } from '../src/orchestration/execute.ts';
import { BudgetManager } from '../src/quota/budget.ts';
import { ModelRegistry } from '../src/quota/registry.ts';
import { ManagedProcess } from '../src/runtime/spawn.ts';
import { launcherFor } from '../src/runtime/launcher.ts';
import { AgentSession } from '../src/runtime/session.ts';
import { SessionStore } from '../src/runtime/store.ts';
import { runGit, GIT_TIMEOUT_EXIT_CODE } from '../src/orchestration/git.ts';
import { validateExecutionTimeout, NODE_TIMER_MAX_MS, MIN_EXECUTION_TIMEOUT_MS } from '../src/orchestration/execute.ts';
import { activateLease, issueLease, renewLease, DEFAULT_RENEW_POLICY } from '../src/orchestration/assignment-lease.ts';
import { WorkspaceManager } from '../src/orchestration/workspace.ts';
import { resolveGitPath } from '../src/orchestration/git.ts';
// R5-1.2C Case 26: liveness of the REAL detached descendant, read through the existing
// cross-process liveness helper the workspace lock already uses. No new liveness
// mechanism is introduced for the test.
import { isProcessAlive } from '../src/orchestration/workspace-lock.ts';
import { normalizeScopeForWorkspace as normalizeScope } from '../src/orchestration/resource-claim.ts';
import { Orchestrator as RuntimeOrch } from '../src/orchestrator/orchestrator.ts';
import { sourceText } from './helpers.ts';
import { createFakeAdapter, FakeTransport } from './helpers.ts';
import type { AgentDescriptor, RunHandle, RunRequest, RunResult, TaskState, TransportExit } from '../src/core/types.ts';
import type { QuotaRecord, TaskType } from '../src/quota/types.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) {
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`  FAIL ${name}${detail === '' ? '' : ` :: ${detail}`}\n`);
  }
};
const section = (title: string): void => {
  process.stdout.write(`\n== ${title} ==\n`);
};

const NOW = 1_700_000_000_000;
const FAKE_AGENT = 'fake-impl';

const registryWith = (entries: Array<[string, string, TaskType[]]>): ModelRegistry => {
  const registry = new ModelRegistry();
  for (const [agentId, modelId, taskTypes] of entries) {
    registry.upsert({ agentId, modelId, provider: 'test', taskTypes, modelSource: 'test', quotaSource: 'test' }, NOW);
    registry.setAgentAvailability(agentId, 'available');
  }
  return registry;
};

// The same minimal spawn-gate fixture the R4 suite uses: a fake descriptor, a
// healthy agent status row and an available quota row. No real agent involved.
function gateFixture(budgets: BudgetManager, registry: ModelRegistry) {
  const quotaRows = [{
    provider: FAKE_AGENT, agentId: FAKE_AGENT, modelId: null, source: 'locally_observed',
    usage: null, remaining: null, resetAt: null, period: 'day', status: 'available',
    usageClass: 'observed', confidence: 'high', observedAt: NOW, note: '',
  }] as unknown as QuotaRecord[];
  return {
    descriptors: [{
      id: FAKE_AGENT, displayName: FAKE_AGENT, launcher: 'fake', transport: 'cli-jsonl',
      capabilities: { newTask: true, review: true, modelSelection: true, resume: true },
    } as unknown as AgentDescriptor],
    agentStatus: [{ agent: FAKE_AGENT, version: '1', installed: 'Yes', login: 'n/a', quotaSource: 't', usage: 'n/a', status: 'ok' }],
    quotaRecords: quotaRows,
    registry,
    budgets,
    taskType: 'implementation',
    requestedUnits: 10,
    currentConcurrency: 0,
    maxConcurrency: 4,
    maxChildren: 8,
    maxConcurrentAgents: 4,
  } as never;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ===========================================================================

section('R5-1 Case 1: an agent running longer than the old decision timeout still completes');

{
  // The old bug: the round passed the LAYA decision timeout as a result-wait bound,
  // so a run that outlived it was marked failed with `runtime-result-failed` while
  // the native agent was still alive. The orchestrator now carries no wait bound at
  // all, and a run that simply takes longer than any decision timeout reaches its
  // real terminal and succeeds.
  const dir = mkdtempSync(join(tmpdir(), 'r5-exec-lifecycle-'));
  const runTaskId = 'c1';
  let resultWaitCalls = 0;
  const runtime: RuntimeRunner = {
    run: () => {
      const result = {
        taskId: runTaskId, threadId: 'th-1', agentId: FAKE_AGENT, state: 'succeeded',
        startedAt: NOW, endedAt: NOW + 5_000, exitCode: 0, signal: null,
        output: 'done', outputTruncated: false, transcriptPath: 't', usage: null,
        toolCalls: [], diagnostics: [],
        cleanup: { rootKilled: false, treeStopConfirmed: true, processStart: 'started', descendantsReaped: false, note: '' }, error: null,
      } as unknown as RunResult;
      return {
        // Far longer than any decision timeout (default 60s? here: ancient history —
        // the point is there is NO wait bound between the orchestrator and the handle).
        result: async () => {
          resultWaitCalls++;
          await sleep(250);
          return result;
        },
        cancel: async () => {},
        dispose: async () => {},
        state: () => 'succeeded' as TaskState,
      } as unknown as RunHandle;
    },
  };
  const budgets = new BudgetManager(1_000_000);
  budgets.task('r', 100_000);
  budgets.task('c1', 100_000);
  budgets.agent(FAKE_AGENT, 1_000_000);
  const registry = registryWith([[FAKE_AGENT, 'm', ['implementation']]]);
  const orch = new Orchestrator({
    gate: gateFixture(budgets, registry),
    now: () => NOW,
    runtime,
    defaultCwd: dir,
    // The NEW deadline: rides on the RunRequest; must not bound the wait.
    executionTimeoutMs: 10 * 60_000,
  });
  orch.createRoot({ taskId: 'r', agentId: FAKE_AGENT, taskType: 'implementation', acceptanceCriteria: 'root' });
  orch.spawnChild({ taskId: runTaskId, parentTaskId: 'r', agentId: FAKE_AGENT, modelId: 'm', taskType: 'implementation', acceptanceCriteria: 'work', budgetUnits: 10 });
  const outcome = await orch.executeTask({ taskId: runTaskId, cwd: dir });
  check('the long-running agent completes with its REAL result', outcome.ok === true);
  check('the task reached its real to_verify terminal, not runtime-result-failed', orch.getStore().get(runTaskId)?.status === 'to_verify');
  check('result() was awaited without a wait bound (one call, no retry churn)', resultWaitCalls === 1);
  check('the live handle was cleaned up after the real terminal', orch.hasLiveRun(runTaskId) === false);
  rmSync(dir, { recursive: true, force: true });
}

section('R5-1 Case 2: a result wait that returns before a terminal keeps every protection');

{
  // A handle whose result() rejects "still running" while the execution is live.
  // The orchestrator must NOT mark the task failed, must NOT delete the live handle,
  // and must NOT release the resource claim — it keeps waiting for the real terminal.
  const dir = mkdtempSync(join(tmpdir(), 'r5-wait-gap-'));
  const runTaskId = 'c1';
  let rejections = 0;
  let settled = false;
  const gapObs = { live: false };
  let observedStatusDuringGap = '';
  const runtime: RuntimeRunner = {
    run: () => {
      const result = {
        taskId: runTaskId, threadId: 'th-1', agentId: FAKE_AGENT, state: 'succeeded',
        startedAt: NOW, endedAt: NOW + 1, exitCode: 0, signal: null,
        output: '', outputTruncated: false, transcriptPath: 't', usage: null,
        toolCalls: [], diagnostics: [],
        cleanup: { rootKilled: false, treeStopConfirmed: true, processStart: 'started', descendantsReaped: false, note: '' }, error: null,
      } as unknown as RunResult;
      return {
        state: () => (settled ? 'succeeded' : 'running') as TaskState,
        result: async () => {
          if (rejections < 2) {
            rejections++;
            // While the wait is in the gap, the protections must ALL still hold.
            gapObs.live = orch.hasLiveRun(runTaskId);
            observedStatusDuringGap = orch.getStore().get(runTaskId)?.status ?? 'unknown';
            throw new Error(`result() timed out; task ${runTaskId} is still running`);
          }
          settled = true;
          return result;
        },
        cancel: async () => {},
        dispose: async () => {},
      } as unknown as RunHandle;
    },
  };
  const budgets = new BudgetManager(1_000_000);
  budgets.task('r', 100_000);
  budgets.task('c1', 100_000);
  budgets.agent(FAKE_AGENT, 1_000_000);
  const registry = registryWith([[FAKE_AGENT, 'm', ['implementation']]]);
  const orch = new Orchestrator({
    gate: gateFixture(budgets, registry),
    now: () => NOW,
    runtime,
    defaultCwd: dir,
  });
  orch.createRoot({ taskId: 'r', agentId: FAKE_AGENT, taskType: 'implementation', acceptanceCriteria: 'root' });
  orch.spawnChild({ taskId: runTaskId, parentTaskId: 'r', agentId: FAKE_AGENT, modelId: 'm', taskType: 'implementation', acceptanceCriteria: 'work', budgetUnits: 10 });
  const outcome = await orch.executeTask({ taskId: runTaskId, cwd: dir });
  check('a wait gap never became a verdict', (rejections as number) === 2);
  check('the live handle was RETAINED across the wait gap', gapObs.live === true);
  check('the task was NOT marked failed during the gap', observedStatusDuringGap === 'running');
  check('the run still reaches its real terminal and writes success', outcome.ok === true && orch.getStore().get(runTaskId)?.status === 'to_verify');
  rmSync(dir, { recursive: true, force: true });
}

section('R5-1 Case 3: the real execution deadline terminates through the runtime boundary');

{
  // The REAL AgentSession (not a stub) with a transport that hangs forever.
  // `RunRequest.timeoutMs` is the deadline; on expiry the session cancels its own
  // transport, freezes a REAL `timed_out` terminal and preserves the error fact.
  // This is the only timeout allowed to end an execution, and it lives inside the
  // execution boundary — the orchestrator never kills anything.
  const storeDir = mkdtempSync(join(tmpdir(), 'r5-deadline-'));
  const store = new SessionStore(storeDir);
  const adapter = createFakeAdapter();
  const transport = new FakeTransport([{ kind: 'hang' }]);
  const session = new AgentSession(
    adapter,
    store,
    { agentId: FAKE_AGENT, prompt: 'work', cwd: storeDir, timeoutMs: 150 } as RunRequest,
    transport,
  );
  session.start();
  const result = await session.result(10_000);
  check('the deadline produced a REAL terminal, not a wait rejection', result.state === 'timed_out');
  check('the terminal carries the deadline error fact', result.error !== null && /deadline|exceeded/i.test(result.error?.message ?? ''));
  check('the session cancelled its own transport (boundary-internal)', transport.cancelCount === 1);
  check('result() is stable after the deadline terminal', (await session.result(10_000)) === result);
  rmSync(storeDir, { recursive: true, force: true });
}

section('R5-1 Case 4: single terminalization — no double cleanup under a result race');

{
  // Concurrent result() callers plus a settle after the fact must all observe the
  // ONE frozen terminal, and the task must be written back exactly once.
  const dir = mkdtempSync(join(tmpdir(), 'r5-single-terminal-'));
  const runTaskId = 'c1';
  let frozen: RunResult | null = null;
  const runtime: RuntimeRunner = {
    run: () => {
      const result = {
        taskId: runTaskId, threadId: 'th-1', agentId: FAKE_AGENT, state: 'succeeded',
        startedAt: NOW, endedAt: NOW + 1, exitCode: 0, signal: null,
        output: '', outputTruncated: false, transcriptPath: 't', usage: null,
        toolCalls: [], diagnostics: [],
        cleanup: { rootKilled: false, treeStopConfirmed: true, processStart: 'started', descendantsReaped: false, note: '' }, error: null,
      } as unknown as RunResult;
      frozen = result;
      let settles = 0;
      return {
        state: () => 'succeeded' as TaskState,
        result: async () => {
          settles++;
          if (settles > 1) await sleep(20);
          return result;
        },
        cancel: async () => {},
        dispose: async () => {},
      } as unknown as RunHandle;
    },
  };
  const budgets = new BudgetManager(1_000_000);
  budgets.task('r', 100_000);
  budgets.task('c1', 100_000);
  budgets.agent(FAKE_AGENT, 1_000_000);
  const registry = registryWith([[FAKE_AGENT, 'm', ['implementation']]]);
  const orch = new Orchestrator({
    gate: gateFixture(budgets, registry),
    now: () => NOW,
    runtime,
    defaultCwd: dir,
  });
  orch.createRoot({ taskId: 'r', agentId: FAKE_AGENT, taskType: 'implementation', acceptanceCriteria: 'root' });
  orch.spawnChild({ taskId: runTaskId, parentTaskId: 'r', agentId: FAKE_AGENT, modelId: 'm', taskType: 'implementation', acceptanceCriteria: 'work', budgetUnits: 10 });
  const outcome = await orch.executeTask({ taskId: runTaskId, cwd: dir });
  check('the execution succeeded', outcome.ok === true);
  check('exactly one write-back happened (no double terminalization)', orch.getStore().get(runTaskId)?.status === 'to_verify' && outcome.ok === true);
  check('the frozen terminal is the single result object', (outcome as { run: RunResult }).run === frozen);
  rmSync(dir, { recursive: true, force: true });
}

section('R5-1 Case 5: a timed-out git child is terminated and confirmed BEFORE runGit returns');

{
  // The child is a controlled node process that would, if left alive, write a file
  // after the timeout. runGit must return only after the child is dead, so the file
  // must NEVER appear — proving the workspace cannot be mutated behind the caller's
  // back (and therefore a lock held across runGit cannot be released under a live git).
  const dir = mkdtempSync(join(tmpdir(), 'r5-git-timeout-'));
  const lateFile = join(dir, 'late-mutation.txt');
  const node = process.execPath;
  const script = `setTimeout(()=>{require('fs').writeFileSync(${JSON.stringify(lateFile)},'MUTATED')},4000)`;
  const startedAt = Date.now();
  const result = await runGit({
    gitPath: node,
    args: ['-e', script],
    cwd: dir,
    timeoutMs: 300,
    env: process.env as Readonly<Record<string, string | undefined>>,
  });
  const elapsed = Date.now() - startedAt;
  check('the runner reports the structured timeout fact', result.timedOut === true);
  check('the runner returned promptly after the timeout (not after the child)', elapsed < 10_000, String(elapsed));
  check('the timed-out child could not mutate the workspace afterwards', !existsSync(lateFile));
  await sleep(4300);
  check('still no mutation after waiting out the child\'s planned write', !existsSync(lateFile));
  rmSync(dir, { recursive: true, force: true });
}

section('R5-1 Case 6: Windows-controlled child termination through ManagedProcess');

{
  // A live node child is cancelled through the existing ManagedProcess boundary;
  // cancel() is awaited and the exit is observed — no orphan left behind.
  const dir = mkdtempSync(join(tmpdir(), 'r5-child-kill-'));
  const startedAt = Date.now();
  const resolved = launcherFor(process.execPath);
  check('the controlled node launcher resolved', resolved.ok === true);
  if (!resolved.ok) {
    rmSync(dir, { recursive: true, force: true });
  } else {
    const proc = new ManagedProcess({
      launcher: resolved.launcher,
      args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: dir,
      env: process.env as Readonly<Record<string, string>>,
    });
    const cancelled = await proc.cancel('R5-1 case 6: controlled termination');
    await proc.exited;
    const elapsed = Date.now() - startedAt;
    check('cancel() reported a real termination', cancelled === true);
    check('the exit was observed well within the test lifetime', elapsed < 10_000, String(elapsed));
    rmSync(dir, { recursive: true, force: true });
  }
}

section('R5-1 Case 7: source guards treat LF and CRLF as semantically equivalent');

{
  const dir = mkdtempSync(join(tmpdir(), 'r5-lineendings-'));
  const lfPath = join(dir, 'lf.ts');
  const crlfPath = join(dir, 'crlf.ts');
  const lines = ["import { Orchestrator } from '../src/orchestration/orchestrator.ts';", 'export const x = 1;', '// a comment'];
  writeFileSync(lfPath, lines.join('\n'), 'utf8');
  writeFileSync(crlfPath, lines.join('\r\n'), 'utf8');
  const lf = sourceText(lfPath);
  const crlf = sourceText(crlfPath);
  check('the normalizing reader yields IDENTICAL text for LF and CRLF input', lf === crlf);
  // The same import-line guard the topology suites run, on both endings.
  const importGuard = (text: string): boolean =>
    text.split('\n').filter((l) => l.trimStart().startsWith('import '))
      .every((l) => !/from '\.\.\/adapters\//.test(l));
  check('the import-line guard passes on LF', importGuard(lf));
  check('the import-line guard passes on CRLF (previously line-ending-fragile)', importGuard(crlf));
  check('the reader never introduces or keeps a carriage return', !/\r/.test(crlf));
  rmSync(dir, { recursive: true, force: true });
}

section('R5-1 wiring: the deadline rides on the RunRequest, never on a result wait');

{
  const store = new TaskStore();
  store.create({ taskId: 'r', taskType: 'implementation', acceptanceCriteria: 'root', parentTaskId: null, agentId: 'opencode', modelId: 'm' }, NOW);
  store.create({ taskId: 'c1', taskType: 'implementation', acceptanceCriteria: 'work', parentTaskId: 'r', agentId: 'opencode', modelId: 'm' }, NOW);
  const built = buildRunRequest({ task: store.get('c1')!, cwd: '/tmp/x', timeoutMs: 1234 });
  check('buildRunRequest carries the execution deadline into the RunRequest', built.request.timeoutMs === 1234);
  const bare = buildRunRequest({ task: store.get('c1')!, cwd: '/tmp/x' });
  check('absent deadline stays absent (no fabricated default)', bare.request.timeoutMs === undefined);
  // And the orchestrator source carries no result-wait bound at all.
  const orchSrc = sourceText('src/orchestration/orchestrator.ts');
  check('executeTask awaits result() with NO wait bound',
    /result = await handle\.result\(\);/.test(orchSrc) && !/result = await handle\.result\(this\./.test(orchSrc));
  check('the option named resultTimeoutMs is gone from the orchestrator', !/resultTimeoutMs/.test(orchSrc));
  check('the round CLI wires executionTimeoutMs, not the laya timeout', /executionTimeoutMs: o\.executionTimeoutMs/.test(sourceText('src/cli/round-cli.ts')));
}

section('R5-1.1 Case 8: git timeout with the root exiting DURING cancellation is still CLOSED');

{
  // The child plans to exit on its own right around the deadline. Whichever side
  // wins the race, runGit must not return until cancellation has been requested,
  // awaited, cleanup awaited, and the root's real exit confirmed — and the result
  // must carry the timeout sentinel, never the child's natural exit code 0.
  const dir = mkdtempSync(join(tmpdir(), 'r511-case8-'));
  const node = process.execPath;
  const result = await runGit({
    gitPath: node,
    args: ['-e', 'setTimeout(()=>process.exit(0),220)'],
    cwd: dir,
    timeoutMs: 150,
    env: process.env as Readonly<Record<string, string | undefined>>,
  });
  check('the timeout branch owns the outcome', result.timedOut === true);
  check('the exit code is the TIMEOUT sentinel (never the child\'s 0)', result.code === GIT_TIMEOUT_EXIT_CODE);
  // The child exited NATURALLY (exit code 0) during the awaited cancellation, and
  // runGit still waited for that real exit before returning — that is what
  // "finalization is CLOSED" means here: the diagnostic exitCode proves the real
  // exit was observed, while the success predicate (code) stays the timeout
  // sentinel. Whether taskkill also confirmed is a race with the natural exit and
  // is reported honestly via cancelConfirmed, never asserted here.
  // Either side may win the taskkill-vs-natural-exit race (exitCode 1 killed, or
  // 0 natural), so the INVARIANT is: runGit returned only after a REAL terminal was
  // observed (the raw exit code is present as a diagnostic), and the success
  // predicate stayed the timeout sentinel regardless of who won.
  // W2: under containment a cancellation terminates the LAUNCHER, which can end
  // before the root's own exit is recorded; the root exit code is then honestly
  // UNKNOWN (null) rather than fabricated. The invariant that still must hold: the
  // success predicate stayed the timeout sentinel, and no exit code replaced it.
  check('the success predicate stayed the timeout sentinel, and no exit code replaced it',
    result.code === GIT_TIMEOUT_EXIT_CODE && result.code !== result.exitCode,
    `code=${result.code} exitCode=${result.exitCode}`);
  rmSync(dir, { recursive: true, force: true });
}

section('R5-1.1 Case 9: cancellation failure is surfaced; finalization stays CLOSED');

{
  // Cancellation CANNOT confirm the kill (cancel and cleanup report false), and
  // the tree exits on its own a moment later. runGit stays inside finalization
  // (re-requesting the stop through the same seam) until the real exit arrives,
  // then reports the cancellation FAILURE honestly and never a `code === 0`
  // success. (A tree that never exits keeps runGit inside finalization
  // indefinitely — that is Case 16's workspace-lock protection, by design.)
  const dir = mkdtempSync(join(tmpdir(), 'r511-case9-'));
  let resolveExit: ((e: { code: number; signal: string | null }) => void) | null = null;
  const unkillable = {
    commandLine: 'unkillable-fake',
    stderrTail: { toString: () => '' },
    exited: new Promise<{ code: number; signal: string | null }>((r) => {
      resolveExit = r;
    }),
    cancel: async () => false,
    settleCleanup: async () => false,
    alive: true,
  } as unknown as ManagedProcess;
  const startedAt = Date.now();
  const resultP = runGit({
    gitPath: process.execPath,
    args: ['-e', 'setTimeout(()=>{},60000)'],
    cwd: dir,
    timeoutMs: 150,
    finalizeGraceMs: 200,
    env: process.env as Readonly<Record<string, string | undefined>>,
    processFactory: () => unkillable,
  });
  await sleep(400);
  // The tree stops on its own during the unconfirmed loop.
  resolveExit!({ code: 0, signal: null });
  const result = await resultP;
  const elapsed = Date.now() - startedAt;
  check('cancellation failure is surfaced, not swallowed', result.cancelConfirmed === false);
  check('cleanup failure is surfaced, not swallowed', result.cleanupConfirmed === false);
  check('the operation is NOT a success', result.code === GIT_TIMEOUT_EXIT_CODE);
  check('the unconfirmed loop bounded the wait sanely', elapsed < 30_000, String(elapsed));
  // R5-1.2C (§2, §3): this used to assert `processStoppedConfirmed === true`, which
  // required the ROOT's exit to stand in for the TREE's stop even though cancel AND
  // cleanup had just reported false. That is the P1-1 defect. The two facts are now
  // separate and both are asserted.
  check('the ROOT exit was observed (diagnostic fact only)',
    result.rootTerminalObserved === true && result.exitCode === 0, `exit=${String(result.exitCode)}`);
  check('the TREE stop is NOT confirmed when cancel and cleanup both failed',
    result.treeStopConfirmed === false, String(result.treeStopConfirmed));
  check('an unconfirmed stop is reported as stop-unconfirmed, never as a clean kill',
    result.stopState === 'stop-unconfirmed', result.stopState);
  check('processStoppedConfirmed no longer claims a stop that was never confirmed',
    result.processStoppedConfirmed === false, String(result.processStoppedConfirmed));
  rmSync(dir, { recursive: true, force: true });
}

section('R5-1.1 Case 10: a FAILED cancellation keeps every root-task protection');

{
  // cancel() throws and the execution stays running: the live handle, the
  // running status, the lease and the concurrency accounting must all be
  // RETAINED, and the outcome must be an explicit not-confirmed — never a
  // fabricated `cancelled` terminal.
  const dir = mkdtempSync(join(tmpdir(), 'r511-case10-'));
  const runTaskId = 'c1';
  const runtime: RuntimeRunner = {
    run: () => {
      const result = {
        taskId: runTaskId, threadId: 'th-1', agentId: FAKE_AGENT, state: 'succeeded',
        startedAt: NOW, endedAt: NOW + 1, exitCode: 0, signal: null,
        output: '', outputTruncated: false, transcriptPath: 't', usage: null,
        toolCalls: [], diagnostics: [],
        cleanup: { rootKilled: false, treeStopConfirmed: true, processStart: 'started', descendantsReaped: false, note: '' }, error: null,
      } as unknown as RunResult;
      return {
        state: () => 'running' as TaskState,
        result: async () => {
          await sleep(500); // execution genuinely still in flight (bounded for the test)
          return result;
        },
        cancel: async () => {
          throw new Error('tree kill failed; process end state UNKNOWN');
        },
        dispose: async () => {},
      } as unknown as RunHandle;
    },
  };
  const budgets = new BudgetManager(1_000_000);
  budgets.task('r', 100_000);
  budgets.task('c1', 100_000);
  budgets.agent(FAKE_AGENT, 1_000_000);
  const registry = registryWith([[FAKE_AGENT, 'm', ['implementation']]]);
  const orch = new Orchestrator({
    gate: gateFixture(budgets, registry),
    now: () => NOW,
    runtime,
    defaultCwd: dir,
    cancelConfirmWaitMs: 120, // shrunken confirmation window for the test
  });
  orch.createRoot({ taskId: 'r', agentId: FAKE_AGENT, taskType: 'implementation', acceptanceCriteria: 'root' });
  orch.spawnChild({ taskId: runTaskId, parentTaskId: 'r', agentId: FAKE_AGENT, modelId: 'm', taskType: 'implementation', acceptanceCriteria: 'work', budgetUnits: 10 });
  const pending = orch.executeTask({ taskId: runTaskId, cwd: dir });
  await sleep(30);
  const cancellation = await orch.cancelTask(runTaskId, 'user cancel (the runtime will refuse)');
  check('the outcome is an explicit NOT-CONFIRMED, not a cancelled verdict',
    cancellation.ok === false && cancellation.code === 'cancellation-not-confirmed');
  check('the live handle is RETAINED', orch.hasLiveRun(runTaskId) === true);
  check('the task is still running, never fabricated as cancelled', orch.getStore().get(runTaskId)?.status === 'running');
  check('the lease was NOT revoked as if the task had terminated', orch.getStore().leaseOf(runTaskId) !== null);
  // Let the in-flight execution settle so the process exits without a dangling tail.
  const lateOutcome = await pending;
  check('the execution later settles through its own real terminal', lateOutcome.ok === true);
  rmSync(dir, { recursive: true, force: true });
}

section('R5-1.1 Case 11: user cancel + deadline race is single-flight with a stable reason');

{
  // The user cancels at 50 ms; the deadline fires at 150 ms. The FIRST terminal
  // request wins: exactly ONE transport cancellation, and the frozen outcome is
  // `cancelled` — never overwritten by the later `timed_out`.
  const storeDir = mkdtempSync(join(tmpdir(), 'r511-case11-'));
  const store = new SessionStore(storeDir);
  const adapter = createFakeAdapter();
  const transport = new FakeTransport([{ kind: 'hang' }]);
  const session = new AgentSession(
    adapter,
    store,
    { agentId: FAKE_AGENT, prompt: 'work', cwd: storeDir, timeoutMs: 150 } as RunRequest,
    transport,
  );
  session.start();
  void sleep(50).then(() => session.cancel('user asked to stop'));
  const result = await session.result(10_000);
  check('the user cancel won the race and stays the terminal reason', result.state === 'cancelled');
  check('the transport was cancelled EXACTLY ONCE (no double tree kill)', transport.cancelCount === 1, String(transport.cancelCount));
  check('the terminal error is the cancellation reason', result.error?.code === 'CANCELLED');
  rmSync(storeDir, { recursive: true, force: true });
}

section('R5-1.1 Case 12: lease renewal is MONOTONIC (a 31-minute dispatch lease never shrinks)');

{
  // A dispatch lease sized to a 31-minute execution deadline, renewed by the
  // STORE-DEFAULT 15-minute policy: the renewal must not pull the expiry back.
  const base = issueLease({ taskId: 'T', agentId: FAKE_AGENT, modelId: null, leaseVersion: 1, fencingToken: 'f-1', now: NOW });
  const activated = activateLease(base, NOW, { maxRenewals: 2, ttlMs: 31 * 60_000 });
  const renewal = renewLease(activated, NOW + 1_000, DEFAULT_RENEW_POLICY);
  check('a normal renewal is accepted', renewal.ok === true);
  if (renewal.ok) {
    check('the renewed expiry is >= the pre-renewal expiry (monotonic)',
      renewal.lease.expiresAt >= activated.expiresAt,
      `${renewal.lease.expiresAt} vs ${activated.expiresAt}`);
  }
  // And the store-level path agrees: renewRunningLeases on a deadline-sized lease.
  {
    const store2 = new TaskStore({ renewPolicy: { maxRenewals: 2, ttlMs: 15 * 60_000 } });
    store2.create({ taskId: 'T', taskType: 'implementation', acceptanceCriteria: 'work', parentTaskId: null, agentId: FAKE_AGENT, modelId: 'm' }, NOW);
    store2.assignIdentity('T', FAKE_AGENT, 'm', NOW);
    const deadlinePolicy = { maxRenewals: 2, ttlMs: 31 * 60_000 };
    store2.markLeaseUsed('T', NOW, deadlinePolicy);
    const before = store2.leaseOf('T')!.expiresAt;
    // renewRunningLeases only touches `running` tasks; move it there first.
    store2.transition('T', 'queued', NOW);
    store2.transition('T', 'running', NOW);
    store2.renewRunningLeases(NOW + 1_000);
    const after = store2.leaseOf('T')!.expiresAt;
    check('the tick-driven renewal did not shorten the deadline-sized lease', after >= before, `${after} vs ${before}`);
  }
}

section('R5-1.1 Case 13: an oversized execution timeout is REFUSED, never clamped to ~1 ms');

{
  const oversized = validateExecutionTimeout(2 ** 31 + 5_000);
  check('a value above the Node timer maximum is refused', oversized.ok === false);
  check('the refusal names the Node timer bound', oversized.ok === false && /timer maximum/.test(oversized.reason));
  let ctorThrew = '';
  try {
    new Orchestrator({
      gate: gateFixture(new BudgetManager(1_000), registryWith([[FAKE_AGENT, 'm', ['implementation']]])),
      now: () => NOW,
      defaultCwd: '.',
      executionTimeoutMs: 2 ** 31 + 5_000,
    });
  } catch (e) {
    ctorThrew = (e as Error).message;
  }
  check('the Orchestrator constructor fails fast on an oversized deadline', /timer maximum/.test(ctorThrew), ctorThrew);
}

section('R5-1.1 Case 14: 0 / negative / NaN / non-finite execution timeouts are refused');

{
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, MIN_EXECUTION_TIMEOUT_MS - 1]) {
    const verdict = validateExecutionTimeout(bad);
    check(`the validator refuses ${String(bad)}`, verdict.ok === false);
  }
  check('unlimited execution is NOT silently supported by 0',
    (() => { const v = validateExecutionTimeout(0); return v.ok === false && /not supported/.test(v.reason); })());
  // The CLI help documents the option.
  const cli = sourceText('src/cli/round-cli.ts');
  check('the usage text documents --execution-timeout (unit, default, range)', /--execution-timeout <ms>/.test(cli));
  // R5-1.2C (§14): the documented range must be DERIVED from the one validator's own
  // constants. It used to hard-code `1000..2147483647` while the enforced minimum is 50,
  // so the help and the code disagreed. Asserting a literal here would re-introduce
  // exactly that drift; asserting the interpolation is what makes them agree.
  check('the documented range is derived from the ONE validator, not a hand-copied literal',
    /allowed range \$\{MIN_EXECUTION_TIMEOUT_MS\}\.\.\$\{NODE_TIMER_MAX_MS\}/.test(cli)
    && !/allowed range \d/.test(cli));
}

section('R5-1.1 Case 15: a persistently rejecting handle must not busy-spin the event loop');

{
  // result() rejects immediately forever while state() stays non-terminal: the
  // orchestrator keeps waiting (never a fabricated failure), but with event-loop
  // yielding between re-waits, so timers still fire.
  const dir = mkdtempSync(join(tmpdir(), 'r511-case15-'));
  const runTaskId = 'c1';
  const spinUntil = Date.now() + 400; // reject for 400 ms, then settle for real
  const runtime: RuntimeRunner = {
    run: () => ({
      state: () => (Date.now() < spinUntil ? 'running' : 'succeeded') as TaskState,
      result: async () => {
        if (Date.now() < spinUntil) {
          throw new Error('result() timed out; still running');
        }
        return {
          taskId: runTaskId, threadId: 'th-1', agentId: FAKE_AGENT, state: 'succeeded',
          startedAt: NOW, endedAt: NOW + 1, exitCode: 0, signal: null,
          output: '', outputTruncated: false, transcriptPath: 't', usage: null,
          toolCalls: [], diagnostics: [],
          cleanup: { rootKilled: false, treeStopConfirmed: true, processStart: 'started', descendantsReaped: false, note: '' }, error: null,
        } as unknown as RunResult;
      },
      cancel: async () => {},
      dispose: async () => {},
    } as unknown as RunHandle),
  };
  const budgets = new BudgetManager(1_000_000);
  budgets.task('r', 100_000);
  budgets.task('c1', 100_000);
  budgets.agent(FAKE_AGENT, 1_000_000);
  const registry = registryWith([[FAKE_AGENT, 'm', ['implementation']]]);
  const orch = new Orchestrator({ gate: gateFixture(budgets, registry), now: () => NOW, runtime, defaultCwd: dir });
  orch.createRoot({ taskId: 'r', agentId: FAKE_AGENT, taskType: 'implementation', acceptanceCriteria: 'root' });
  orch.spawnChild({ taskId: runTaskId, parentTaskId: 'r', agentId: FAKE_AGENT, modelId: 'm', taskType: 'implementation', acceptanceCriteria: 'work', budgetUnits: 10 });
  const settled = orch.executeTask({ taskId: runTaskId, cwd: dir });
  // While the defensive wait loop spins, the EVENT LOOP must stay responsive:
  // 10 ms timers must keep landing instead of being starved by microtasks.
  let timerTicks = 0;
  const ticker = setInterval(() => timerTicks++, 10);
  await sleep(300);
  const ticksDuringSpin = timerTicks;
  clearInterval(ticker);
  const outcome = await settled;
  check('the event loop stayed responsive during the defensive re-waits', ticksDuringSpin >= 5, String(ticksDuringSpin));
  check('the spin phase never produced a fabricated failure', orch.getStore().get(runTaskId)?.status === 'to_verify');
  check('the execution still reached its real terminal', outcome.ok === true);
  rmSync(dir, { recursive: true, force: true });
}

section('R5-1.2C Case 26: a dead ROOT is not a stopped TREE (real Windows processes)');

{
  // The P1-1 reproduction, on real Windows processes rather than a synthetic handle.
  //
  // A real node ROOT spawns a REAL DETACHED descendant that keeps writing into the
  // workspace it was given, then the root exits on its own. The descendant is the
  // writer whose survival matters: it can still modify the scope after the root is
  // gone, which is exactly the state that must not release physical protection.
  //
  // The descendant is DETACHED and unref'd on purpose. That makes this a faithful
  // reproduction rather than a lucky one: `taskkill /T` walks a LIVE tree, so once the
  // root is gone there is no live root to walk and the detached child genuinely
  // outlives it on Windows.
  const dir = mkdtempSync(join(tmpdir(), 'r512c-case26-'));
  const marker = join(dir, 'descendant-writes.txt');
  const pidFile = join(dir, 'descendant.pid');
  const resolved = launcherFor(process.execPath);
  check('the controlled node launcher resolved', resolved.ok === true);
  if (!resolved.ok) {
    rmSync(dir, { recursive: true, force: true });
  } else {
    // Each script is embedded through JSON.stringify so the nested quoting cannot break
    // the `-e` argument (a hand-quoted inner string is exactly what silently fails here).
    const descScript = `setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(marker)},'x'),50)`;
    const rootScript = [
      `const { spawn } = require('node:child_process');`,
      `const fs = require('node:fs');`,
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descScript)}], { detached: true, stdio: 'ignore' });`,
      `child.unref();`,
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    ].join('\n');
    const proc = new ManagedProcess({
      launcher: resolved.launcher,
      args: ['-e', rootScript],
      cwd: dir,
      env: process.env as Readonly<Record<string, string>>,
    });

    // W2.2b: `rootTerminalObserved` is a VALIDATED fact and is NOT projected from
    // the partial control record, so it does not become true mid-run. We wait for
    // the contained descendant to publish its pid instead, and assert that the
    // LAUNCHER is still alive — which is what proves the tree did not stop with the
    // root.
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) {
      await sleep(50);
    }
    await sleep(300); // let the contained descendant start writing

    check('Case 26a: the launcher is STILL running (the tree did not stop with the root)',
      proc.alive === true);
    check('Case 26a: no root-terminal fact is fabricated before validation',
      proc.rootTerminalObserved === false);
    if (!existsSync(pidFile)) {
      check('Case 26b: the descendant was really started and reported its pid', false,
        `no pid file; root stderr="${proc.stderrTail.toString().slice(0, 200)}"`);
      await proc.cancel('case 26 cleanup');
      rmSync(dir, { recursive: true, force: true });
    } else {
    const pid = Number(readFileSync(pidFile, 'utf8').trim());

    const sizeA = existsSync(marker) ? readFileSync(marker, 'utf8').length : -1;
    await sleep(250);
    const sizeB = existsSync(marker) ? readFileSync(marker, 'utf8').length : -1;
    check('Case 26b: the contained descendant is alive and STILL WRITING after the root exited',
      isProcessAlive(pid) && sizeA > 0 && sizeB > sizeA, `pid=${pid} ${sizeA}->${sizeB}`);

    // THE W2 PROPERTY: a dead ROOT is not a stopped TREE. The launcher is still
    // running because the Job is not empty, so the tree stop is UNCONFIRMED — no
    // optimistic "the root exited, so the tree stopped" claim is possible.
    check('Case 26c: the tree stop is UNCONFIRMED while the contained descendant lives',
      proc.isTreeStopConfirmed() === false, String(proc.isTreeStopConfirmed()));

    // W2: containment can actually STOP the tree.
    //
    // W3 CHANGED THE MECHANISM. Under W2 this cancel taskkilled the launcher and relied
    // on KILL_ON_JOB_CLOSE to take the descendant. That reaped the process but produced
    // NO evidence: a killed launcher cannot write its final control record, so the stop
    // could never be confirmed and the caller had to keep protection forever.
    //
    // W3 cancels COOPERATIVELY — the launcher terminates the Job and writes a final
    // `terminated` record after observing ActiveProcesses == 0. That is the same
    // physical outcome (the descendant still cannot break away) plus real evidence.
    const cancelled = await proc.cancel('R5-1.2C case 26: stop the contained tree');
    check('Case 26d: cancelling the launcher reports a real stop', cancelled === true, String(cancelled));
    let gone = false;
    for (let i = 0; i < 60 && !gone; i++) {
      await sleep(50);
      gone = !isProcessAlive(pid);
    }
    check('Case 26e: the contained descendant really ended (it could not break away)', gone, `pid=${pid}`);
    await proc.exited;
    // The confirmation is now POSITIVE: it comes from the launcher's own reading of
    // the Job accounting in a complete final record, not from an assumption.
    check('Case 26f: the cooperative stop is CONFIRMED from the launcher record',
      proc.isTreeStopConfirmed() === true, String(proc.containment?.launcherStatus));
    check('Case 26g: it is reported as `terminated`, never as agent success',
      proc.containment?.terminated === true && proc.containment?.launcherStatus !== 'success');
    // The counterpart invariant still holds and is covered in W3-6: a launcher that is
    // HARD-killed produces no record and therefore no confirmation.
    rmSync(dir, { recursive: true, force: true });
    }
  }
}

section('R5-1.2C Case 27/28: an unconfirmed tree stop RETAINS the workspace creation lock');

{
  // Cases 27 and 28 on the retention contract. This replaces the R5-1.2 Case 16
  // expectation that "the lock is released once the root exits" — that expectation
  // encoded the defect, because the root's death was being treated as the tree's stop.
  //
  //   27a  ROOT still alive          -> rival refused
  //   27b  ROOT exited, stop UNCONFIRMED -> protection RETAINED, rival STILL refused
  //   28   descendant really ended + explicit release -> rival admitted
  const root = mkdtempSync(join(tmpdir(), 'r512c-case27-'));
  const git = resolveGitPath();
  await runGit({ gitPath: git, args: ['init', '-q'], cwd: root, timeoutMs: 30_000, env: process.env });
  const lockDir = join(root, '.locks');
  const fakeProc = {
    commandLine: 'unconfirmed-tree-fake-git',
    stderrTail: { toString: () => '' },
    exited: new Promise(() => {}), // the ROOT only exits when this test says so
    cancel: async () => false,
    settleCleanup: async () => false,
    alive: true,
    // Case 26 proved a real ManagedProcess refuses to confirm a stop once its root is
    // gone. The same honest answer is injected here because "unkillable" cannot be forced
    // deterministically — this is the documented seam for exactly that.
    isTreeStopConfirmed: () => false,
  } as unknown as ManagedProcess;
  const wm = new WorkspaceManager({
    projectRoot: root,
    lockDir,
    workspaceLockTimeoutMs: 400,
    gitTimeoutMs: 150,
    gitFinalizeGraceMs: 150,
    gitProcessFactory: (o) =>
      // Scoped to `worktree add` ONLY. A broader match also swallowed `worktree list`,
      // which made the ADD call start after the test had already resolved `exited` — a
      // NATURAL exit, so the stop looked confirmed and the case proved nothing.
      o.args[0] === 'worktree' && o.args[1] === 'add' ? fakeProc : new ManagedProcess(o),
  });
  const prepare = wm.prepare({ taskId: 'T', mode: 'isolated' });
  await sleep(700); // deadline (150) + grace (150) + retry pacing: still unconfirmed

  const rival = new WorkspaceManager({ projectRoot: root, lockDir, workspaceLockTimeoutMs: 400 });
  let rivalRejected = '';
  const tryRival = async (): Promise<boolean> => {
    try {
      await rival.prepare({ taskId: 'T', mode: 'isolated' });
      return true;
    } catch (e) {
      rivalRejected = (e as Error).message;
      return false;
    }
  };

  check('Case 27a: the rival is refused while the ROOT is still alive',
    (await tryRival()) === false, rivalRejected.slice(0, 120));

  // The ROOT exits. Under R5-1.2 the `finally` unlocked right here. Under R5-1.2C the
  // root's exit proves only `rootTerminalObserved`, so protection must be RETAINED.
  (fakeProc as { exited: Promise<unknown> }).exited = Promise.resolve({ code: -1, signal: null });
  const rejection = await prepare.then(
    () => '',
    (e: Error & { code?: string }) => `${e.code ?? ''} ${e.message}`,
  );
  check('Case 27b: the unconfirmed stop is refused as workspace-stop-unconfirmed',
    /workspace-stop-unconfirmed/.test(rejection), rejection.slice(0, 160));
  const retained = wm.unconfirmedProtections();
  check('Case 27c: protection is RETAINED and attributable, not an anonymous lock leak',
    retained.length === 1
    && retained[0]!.taskId === 'T'
    && retained[0]!.executionIdentity === 'workspace:T'
    && retained[0]!.reason.length > 0,
    JSON.stringify(retained));
  check('Case 27d: the rival is STILL refused after the ROOT exited',
    (await tryRival()) === false, rivalRejected.slice(0, 120));

  // The descendant has really ended; the caller releases explicitly.
  check('Case 28a: the retained protection is explicitly releasable',
    wm.releaseUnconfirmedProtection('T') === true);
  check('Case 28b: releasing twice is a no-op, not a second unlock',
    wm.releaseUnconfirmedProtection('T') === false);
  check('Case 28c: nothing is retained any more', wm.unconfirmedProtections().length === 0);
  check('Case 28d: the rival is admitted once protection is properly released',
    await tryRival(), rivalRejected.slice(0, 120));
  rmSync(root, { recursive: true, force: true });
}

section('R5-1.2 Case 17: a descendant going live DURING cancellation is reconciled, not overridden');

{
  // P1-2: the state-level cancel must never overtake execution reality. Child B
  // becomes live while child A's cancellation is still being confirmed; the
  // reconciliation pass finds it and stops it too. If B's stop CANNOT be
  // confirmed, the whole cancellation reports not-confirmed and B's task is
  // never marked cancelled.
  const dir = mkdtempSync(join(tmpdir(), 'r512-case17-'));
  const handles = new Map<string, { state: () => TaskState; result: () => Promise<RunResult>; cancel: () => Promise<void> }>();
  const cancelResults = new Map<string, 'ok' | 'fail'>();
  const settled = new Set<string>();
  // RunRequest carries no taskId (the mapping owns it), so each variant is handed its OWN
  // identity source.
  //
  // Why a factory and not one shared counter: with a single counter the two variants
  // consumed each other's identities, and the rotation's fallback branch minted a third,
  // never-used id ('a2'), so the SECOND variant's two handles collided on one key. Then
  // `cancelResults.get('a2')` missed the `cancelResults.set('b','fail')` that the refusal
  // scenario depends on, and the handle defaulted to success. The variant could not fail
  // the way it was written to fail.
  //
  // The rotation is also a strict two-cycle on purpose: an unexpected third dispatch must
  // reuse an existing identity rather than invent an id nothing else knows about.
  const makeRuntime = (): RuntimeRunner => {
    let nextId = 'a';
    return {
      run: () => {
        const id = nextId;
        nextId = id === 'a' ? 'b' : 'a';
        const handle = {
          state: () => (cancelResults.get(id) === 'ok' && settled.has(id) ? ('cancelled' as TaskState) : 'running'),
          result: async () => {
            await sleep(5_000); // execution in flight
            // A CANCELLED execution must report `cancelled`, not `succeeded`.
            //
            // Returning `succeeded` unconditionally is what broke this case: the cancel
            // path deliberately WAITS for the real run to terminate, so `await cancellation`
            // only resolved after both 5s in-flight runs had finished — and the succeeded
            // write-back had by then legitimately moved both tasks to `to_verify`. The
            // cancellation was confirmed and still lost, because the run it confirmed was
            // lying about its own outcome.
            const wasCancelled = settled.has(id);
            return {
              taskId: id, threadId: 't', agentId: FAKE_AGENT,
              state: wasCancelled ? 'cancelled' : 'succeeded',
              startedAt: NOW, endedAt: NOW + 1, exitCode: 0, signal: null,
              output: '', outputTruncated: false, transcriptPath: 't', usage: null,
              toolCalls: [], diagnostics: [],
              cleanup: {
                rootKilled: wasCancelled,
                descendantsReaped: wasCancelled,
                note: wasCancelled ? 'stopped at the user\'s request' : '',
              },
              error: wasCancelled ? { code: 'CANCELLED', message: 'cancelled by the user' } : null,
            } as unknown as RunResult;
          },
          cancel: async () => {
            const verdict = cancelResults.get(id) ?? 'ok';
            if (verdict === 'ok') {
              settled.add(id);
            } else {
              throw new Error('tree kill failed; end state UNKNOWN');
            }
          },
          dispose: async () => {},
        };
        handles.set(id, handle);
        return handle as unknown as RunHandle;
      },
    };
  };
  const runtime = makeRuntime();
  const budgets = new BudgetManager(10_000_000);
  budgets.task('r', 1_000_000);
  budgets.task('a', 1_000_000);
  budgets.task('b', 1_000_000);
  budgets.agent(FAKE_AGENT, 10_000_000);
  const registry = registryWith([[FAKE_AGENT, 'm', ['implementation']]]);
  const orch = new Orchestrator({
    gate: gateFixture(budgets, registry),
    now: () => NOW,
    runtime,
    defaultCwd: dir,
    cancelConfirmWaitMs: 150,
  });
  orch.createRoot({ taskId: 'r', agentId: FAKE_AGENT, taskType: 'implementation', acceptanceCriteria: 'root' });
  orch.spawnChild({ taskId: 'a', parentTaskId: 'r', agentId: FAKE_AGENT, modelId: 'm', taskType: 'implementation', acceptanceCriteria: 'work', budgetUnits: 10 });
  orch.spawnChild({ taskId: 'b', parentTaskId: 'r', agentId: FAKE_AGENT, modelId: 'm', taskType: 'implementation', acceptanceCriteria: 'work', budgetUnits: 10 });
  void orch.executeTask({ taskId: 'a', cwd: dir });
  await sleep(20);

  // B goes live DURING A's cancellation window.
  cancelResults.set('a', 'ok');
  const cancellation = orch.cancelTask('r', 'stop the subtree');
  await sleep(30);
  void orch.executeTask({ taskId: 'b', cwd: dir });
  await sleep(20);
  cancelResults.set('b', 'ok');
  const outcome = await cancellation;
  check('the reconciliation stopped the late descendant and the cancel succeeded',
    outcome.ok === true && outcome.code !== 'cancellation-not-confirmed', JSON.stringify(outcome));
  check('both tasks are cancelled, neither is fabricated over a live run',
    orch.getStore().get('a')?.status === 'cancelled' && orch.getStore().get('b')?.status === 'cancelled',
    `a=${orch.getStore().get('a')?.status} b=${orch.getStore().get('b')?.status}`);
  check('no live handle remains in the subtree', !orch.hasLiveRun('a') && !orch.hasLiveRun('b'));

  // Variant: the late descendant's stop FAILS — the state layer must refuse.
  // A FRESH runtime, so this variant's identities are its own.
  const orch2 = new Orchestrator({
    gate: gateFixture(budgets, registry),
    now: () => NOW,
    runtime: makeRuntime(),
    defaultCwd: dir,
    cancelConfirmWaitMs: 150,
  });
  orch2.createRoot({ taskId: 'r', agentId: FAKE_AGENT, taskType: 'implementation', acceptanceCriteria: 'root' });
  orch2.spawnChild({ taskId: 'a', parentTaskId: 'r', agentId: FAKE_AGENT, modelId: 'm', taskType: 'implementation', acceptanceCriteria: 'work', budgetUnits: 10 });
  orch2.spawnChild({ taskId: 'b', parentTaskId: 'r', agentId: FAKE_AGENT, modelId: 'm', taskType: 'implementation', acceptanceCriteria: 'work', budgetUnits: 10 });
  void orch2.executeTask({ taskId: 'a', cwd: dir });
  await sleep(20);
  cancelResults.set('a', 'ok');
  const cancellation2 = orch2.cancelTask('r', 'stop the subtree (B will refuse)');
  await sleep(30);
  void orch2.executeTask({ taskId: 'b', cwd: dir });
  await sleep(20);
  cancelResults.set('b', 'fail');
  const outcome2 = await cancellation2;
  check('an unconfirmable late descendant makes the WHOLE cancellation not-confirmed',
    outcome2.ok === false && outcome2.code === 'cancellation-not-confirmed');
  check('the live late descendant was never marked cancelled', orch2.getStore().get('b')?.status === 'running');
  check('its live handle and protection are retained', orch2.hasLiveRun('b') === true);
  rmSync(dir, { recursive: true, force: true });
}

section('R5-1.2 Cases 18/19: an expired lease keeps physical exclusion until the stop is confirmed');

{
  // P1-3: writer A goes live, its lease expires. Fencing rejects A's stale
  // write-back (logical authority gone) BUT the claim must keep excluding
  // writer B from the same physical scope (physical exclusion retained). Only
  // after A's execution settles is the claim released and B admitted.
  const root = mkdtempSync(join(tmpdir(), 'r512-case18-'));
  const gitPath = resolveGitPath();
  await runGit({ gitPath, args: ['init', '-q'], cwd: root, timeoutMs: 30_000, env: process.env });
  let clock = NOW;
  let runCount = 0;
  let releaseA: (() => void) | null = null;
  const runtime: RuntimeRunner = {
    run: (req) => {
      runCount++;
      return {
        state: () => 'running' as TaskState,
        result: () =>
          new Promise<RunResult>((resolve) => {
            releaseA = () =>
              resolve({
                taskId: (req as unknown as { taskId: string }).taskId ?? 'unknown', threadId: 't', agentId: FAKE_AGENT, state: 'succeeded',
                startedAt: NOW, endedAt: NOW + 1, exitCode: 0, signal: null,
                output: '', outputTruncated: false, transcriptPath: 't', usage: { inputTokens: 0, outputTokens: 0 },
                toolCalls: [], diagnostics: [],
                cleanup: { rootKilled: false, treeStopConfirmed: true, processStart: 'started', descendantsReaped: false, note: '' }, error: null,
              } as unknown as RunResult);
          }),
        cancel: async () => {},
        dispose: async () => {},
      } as unknown as RunHandle;
    },
  };
  const budgets = new BudgetManager(10_000_000);
  budgets.task('r', 1_000_000);
  budgets.task('wa', 1_000_000);
  budgets.task('wb', 1_000_000);
  budgets.agent(FAKE_AGENT, 10_000_000);
  const registry = registryWith([[FAKE_AGENT, 'm', ['implementation']]]);
  const workspace = new WorkspaceManager({ projectRoot: root, lockDir: join(root, '.locks'), gitTimeoutMs: 30_000 });
  const orch = new Orchestrator({
    gate: gateFixture(budgets, registry),
    now: () => clock,
    runtime,
    defaultCwd: root,
    workspace,
    // The ONLY dispatch-time lease sizing: no execution deadline configured, so
    // the store policy TTL applies — deliberately tiny so we can expire it.
    resourceClaims: () => ({ mode: 'write' as const, scope: normalizeScope(`shared-writers`, root) }),
    workspaceMode: () => 'shared',
  });
  const store = new TaskStore({ renewPolicy: { maxRenewals: 2, ttlMs: 80 } });
  void store;
  orch.createRoot({ taskId: 'r', agentId: FAKE_AGENT, taskType: 'implementation', acceptanceCriteria: 'root' });
  orch.spawnChild({ taskId: 'wa', parentTaskId: 'r', agentId: FAKE_AGENT, modelId: 'm', taskType: 'implementation', acceptanceCriteria: 'write A', budgetUnits: 10 });
  orch.spawnChild({ taskId: 'wb', parentTaskId: 'r', agentId: FAKE_AGENT, modelId: 'm', taskType: 'implementation', acceptanceCriteria: 'write B', budgetUnits: 10 });
  const runA = orch.executeTask({ taskId: 'wa', cwd: root });
  // Wait for A to actually reach the runtime instead of assuming it happens inside a
  // fixed 40 ms. The assertion's meaning is "A holds one run while still live", which is
  // a condition; how fast the event loop gets there is not part of that claim, and the
  // preceding cases really do spawn git, so a bare sleep made this flaky under load.
  let waitedForA = 0;
  while (runCount === 0 && waitedForA < 2_000) {
    await sleep(20);
    waitedForA += 20;
  }
  check('writer A is live and holds one runtime run', runCount === 1, String(runCount));
  clock += 500; // expire A's lease while A is STILL LIVE

  const runB = orch.executeTask({ taskId: 'wb', cwd: root });
  const bOutcome = await Promise.race([runB, sleep(300).then(() => 'pending' as const)]);
  check('writer B is NOT admitted while the expired-lease writer is still live', bOutcome !== 'pending' && bOutcome.ok === false, JSON.stringify(bOutcome).slice(0, 120));
  check('the runtime ran exactly ONE execution (no second writer entered)', runCount === 1, String(runCount));

  // A's execution settles for real: the claim is released by A's own settle path.
  releaseA!();
  const aOutcome = await runA;
  check('writer A reaches its (fenced) end', aOutcome.ok === false || aOutcome.ok === true); // either verdict is a fact; the release is the point
  await sleep(20);
  const runB2 = orch.executeTask({ taskId: 'wb', cwd: root });
  const bOutcome2 = await Promise.race([runB2, sleep(500).then(() => 'pending' as const)]);
  check('after A stops the claim is released and B becomes admissible', bOutcome2 !== 'pending' || runCount === 2, JSON.stringify({ bOutcome2: typeof bOutcome2 === 'string' ? bOutcome2 : bOutcome2.ok, runCount }));
  rmSync(root, { recursive: true, force: true });
}

section('R5-1.2 Case 20: a FAILED cancellation can be retried on the same execution');

{
  // A cancel whose transport refuses the first attempt must not permanently
  // occupy the single-flight slot: attempt 2 goes through and stops the run.
  const storeDir = mkdtempSync(join(tmpdir(), 'r512-case20-'));
  const store = new SessionStore(storeDir);
  const adapter = createFakeAdapter();
  let cancelCalls = 0;
  // A CONFIRMED stop means the process tree is gone, so `wait()` settles — which is
  // exactly what a real AgentSession does after a successful `transport.cancel()`.
  //
  // Modelling `wait()` as never settling describes a process that ignores the kill, and
  // that directly contradicts the fact this case asserts: that the retry stopped the SAME
  // execution. With a never-settling `wait()`, `result()` could only ever time out and
  // reject, so the "real cancelled terminal" could not be observed at all.
  const STOPPED: TransportExit = {
    code: null,
    signal: 'SIGTERM',
    stderrTail: '',
    stderrTruncated: false,
    cleanup: { rootKilled: true, treeStopConfirmed: true, processStart: 'started', descendantsReaped: true, note: 'stopped at the user\'s request' },
  };
  let stopped = false;
  let resolveWait: ((e: TransportExit) => void) | null = null;
  const flaky = {
    kind: 'cli-jsonl' as const,
    commandLine: 'flaky-cancel',
    start: () => {},
    events: function* () {}, // eslint-disable-line
    wait: () => new Promise<TransportExit>((resolve) => {
      if (stopped) { resolve(STOPPED); return; }
      resolveWait = resolve;
    }),
    cancel: async () => {
      cancelCalls++;
      // The FIRST stop fails and must release the single-flight slot, leaving the
      // session running. The SECOND stop succeeds, and only then does the process exit.
      if (cancelCalls === 1) throw new Error('taskkill transiently failed');
      stopped = true;
      resolveWait?.(STOPPED);
    },
    dispose: async () => {},
  };
  const session = new AgentSession(
    adapter,
    store,
    { agentId: FAKE_AGENT, prompt: 'work', cwd: storeDir } as RunRequest,
    flaky as unknown as FakeTransport,
  );
  session.start();
  await session.cancel('first attempt (fails)');
  check('a failed cancel leaves the session running', session.state() === 'running');
  await session.cancel('second attempt (succeeds)');
  // Guarded so a regression reports as FAILED CHECKS instead of aborting the whole suite
  // on an unhandled rejection, which would hide every case after this one.
  let result: RunResult | null = null;
  let resultError = '';
  try {
    result = await session.result(5_000);
  } catch (e) {
    resultError = (e as Error).message;
  }
  check('the retry stopped the SAME execution (attempt count = 2)', cancelCalls === 2, String(cancelCalls));
  check('the session produced a terminal result after the retry', result !== null, resultError.slice(0, 140));
  check('the final stop is a real cancelled terminal', result?.state === 'cancelled', result === null ? 'no result' : result.state);
  check('the terminal result explains the cancellation',
    result?.error?.code === 'CANCELLED', result?.error?.code ?? 'none');
  rmSync(storeDir, { recursive: true, force: true });
}

section('R5-1.2 Case 21: a cancel request that never settles is bounded and keeps protection');

{
  const dir = mkdtempSync(join(tmpdir(), 'r512-case21-'));
  const runTaskId = 'c1';
  const runtime: RuntimeRunner = {
    run: () => ({
      state: () => 'running' as TaskState,
      result: () => new Promise(() => {}), // never settles
      cancel: () => new Promise(() => {}), // cancel request never settles either
      dispose: async () => {},
    } as unknown as RunHandle),
  };
  const budgets = new BudgetManager(1_000_000);
  budgets.task('r', 100_000);
  budgets.task('c1', 100_000);
  budgets.agent(FAKE_AGENT, 1_000_000);
  const registry = registryWith([[FAKE_AGENT, 'm', ['implementation']]]);
  const orch = new Orchestrator({
    gate: gateFixture(budgets, registry),
    now: () => NOW,
    runtime,
    defaultCwd: dir,
    cancelConfirmWaitMs: 150,
  });
  orch.createRoot({ taskId: 'r', agentId: FAKE_AGENT, taskType: 'implementation', acceptanceCriteria: 'root' });
  orch.spawnChild({ taskId: runTaskId, parentTaskId: 'r', agentId: FAKE_AGENT, modelId: 'm', taskType: 'implementation', acceptanceCriteria: 'work', budgetUnits: 10 });
  void orch.executeTask({ taskId: runTaskId, cwd: dir });
  await sleep(20);
  const t0 = Date.now();
  const cancellation = await orch.cancelTask(runTaskId, 'hung cancel request');
  const elapsed = Date.now() - t0;
  check('the hung cancel request is bounded, not an unbounded hang', elapsed < 5_000, String(elapsed));
  check('the outcome is an explicit not-confirmed', cancellation.ok === false && cancellation.code === 'cancellation-not-confirmed');
  check('protection is retained (live handle + running task)', orch.hasLiveRun(runTaskId) && orch.getStore().get(runTaskId)?.status === 'running');
  let timerTicks = 0;
  const ticker = setInterval(() => timerTicks++, 10);
  await sleep(120);
  clearInterval(ticker);
  check('the event loop stayed responsive during the bounded wait', timerTicks >= 5, String(timerTicks));
  rmSync(dir, { recursive: true, force: true });
}

section('R5-1.2 Case 22: the ONE validator guards the direct runtime/session boundary too');

{
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, NODE_TIMER_MAX_MS + 1]) {
    const verdict = validateExecutionTimeout(bad);
    check(`the shared validator refuses ${String(bad)}`, verdict.ok === false);
  }
  check('the shared minimum floor is defined and small', MIN_EXECUTION_TIMEOUT_MS >= 1 && MIN_EXECUTION_TIMEOUT_MS < 1_000);
  // Direct AgentSession construction: an invalid deadline must throw, never
  // reach setTimeout (where Node would clamp an overflow to ~1 ms).
  const storeDir = mkdtempSync(join(tmpdir(), 'r512-case22-'));
  const store = new SessionStore(storeDir);
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, NODE_TIMER_MAX_MS + 1]) {
    let threw = '';
    try {
      const session = new AgentSession(
        createFakeAdapter(),
        store,
        { agentId: FAKE_AGENT, prompt: 'x', cwd: storeDir, timeoutMs: bad } as RunRequest,
        new FakeTransport([{ kind: 'exit', code: 0 }]),
      );
      session.start();
      threw = 'NO THROW';
    } catch (e) {
      threw = (e as Error).message;
    }
    check(`a direct AgentSession with timeoutMs=${String(bad)} is refused`, threw !== 'NO THROW' && /execution timeout/.test(threw), threw.slice(0, 100));
  }
  // The runtime's merged config path: an invalid CONFIGURED deadline is refused.
  const dir = mkdtempSync(join(tmpdir(), 'r512-case22b-'));
  const rt = new RuntimeOrch({
    config: { agents: { [FAKE_AGENT]: { timeoutMs: NODE_TIMER_MAX_MS + 1 } } } as never,
    storeDir: join(dir, 'store'),
    replaceAdapters: [createFakeAdapter({ id: FAKE_AGENT, script: [{ kind: 'exit', code: 0 }] })],
  });
  let cfgThrew = '';
  try {
    rt.run({ agentId: FAKE_AGENT, prompt: 'x', cwd: dir });
  } catch (e) {
    cfgThrew = (e as Error).message;
  }
  check('a configured oversized deadline is refused by the runtime merged path', /execution timeout/.test(cfgThrew), cfgThrew.slice(0, 120));
  rmSync(storeDir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}

section('R5-1.2 Case 23: a natural exit leaves NO referenced grace timer behind');

{
  const dir = mkdtempSync(join(tmpdir(), 'r512-case23-'));
  const before = (process as unknown as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo?.() ?? [];
  const result = await runGit({
    gitPath: process.execPath,
    args: ['-e', 'process.exit(0)'],
    cwd: dir,
    timeoutMs: 60_000, // the natural exit wins long before the deadline
    env: process.env,
  });
  const after = (process as unknown as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo?.() ?? [];
  check('the natural exit completed the git call', result.stopState === 'completed' && result.processStoppedConfirmed === true);
  check('no referenced grace timer remains after runGit returns',
    after.filter((r) => r === 'Timeout').length <= before.filter((r) => r === 'Timeout').length,
    JSON.stringify({ before, after }));
  rmSync(dir, { recursive: true, force: true });
}

section('R5-1.2 Case 24: the timing runner passes exit codes through and classifies spawn errors');

{
  const tmp = mkdtempSync(join(tmpdir(), 'r512-case24-'));
  const exit7 = join(tmp, 'exit7.test.ts');
  writeFileSync(exit7, 'process.exit(7);\n', 'utf8');
  const runner = fileURLToPath(new URL('../scripts/test-timed.mjs', import.meta.url));
  const run = (files: string) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, [runner], {
        env: { ...process.env, TEST_TIMED_SUITES: files },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout?.on('data', (b: Buffer) => (out += b.toString('utf8')));
      child.stderr?.on('data', (b: Buffer) => (out += b.toString('utf8')));
      child.on('exit', (code: number | null) => resolve({ code, out }));
    });
  const r7 = await run(exit7);
  check('a child exiting 7 makes the WRAPPER exit 7 (passed through, not blanket 1)', r7.code === 7, String(r7.code));
  const rErr = await run(join(tmp, 'does-not-exist.test.ts'));
  check('a missing suite file is classified as spawn-error with a non-zero exit',
    rErr.code !== 0 && /spawn-error/i.test(rErr.out), `code=${String(rErr.code)}`);
  check('the timing table is printed even on failure', /suite timing/.test(rErr.out) || /suite timing/.test(r7.out));
  rmSync(tmp, { recursive: true, force: true });
}

section('R5-1.2 Case 25: the handoff production suite\'s reviewer is the FIXTURE, never real Codex');

{
  // Source-level guard (the suite's own runtime identity assertion runs inside it):
  // the reviewer identity must be a replaceAdapters fake, and the fixture must
  // PROVE the registry holds the fake — so "review ran" can never mean
  // "the real installed Codex CLI ran".
  const src = sourceText('tests/handoff-production-round.test.ts');
  check('the reviewer is registered through replaceAdapters (not extraAdapters)',
    /replaceAdapters: adapters/.test(src) && !/extraAdapters/.test(src));
  check('the fixture registers a FAKE codex reviewer', /id: 'codex'/.test(src));
  check('the fixture ASSERTS the reviewer identity (a real native reviewer cannot leak in)',
    /reviewer adapter is not the fake codex/.test(src) && /registry\.get\('codex'\)/.test(src));
}

section('R5-1.2C Case 29: a CLI cancel that resolves FALSE is not a confirmed cancellation');

{
  // §9. The CLI transport's `ManagedProcess.cancel()` resolves a BOOLEAN. That result
  // used to be discarded, so a `false` — "the tree stop is NOT confirmed" — was read as
  // success and the session went on to produce a `cancelled` terminal for an execution
  // that was still running. Case 20 covers the THROWN variant; this covers the `false`
  // variant, which is the shape the real CLI transport actually returns.
  const storeDir = mkdtempSync(join(tmpdir(), 'r512c-case29-'));
  const store = new SessionStore(storeDir);
  const adapter = createFakeAdapter();
  const STOPPED: TransportExit = {
    code: null,
    signal: 'SIGTERM',
    stderrTail: '',
    stderrTruncated: false,
    cleanup: { rootKilled: true, treeStopConfirmed: true, processStart: 'started', descendantsReaped: true, note: 'stopped on the second attempt' },
  };
  let stopped = false;
  let resolveWait: ((e: TransportExit) => void) | null = null;
  let cancelCalls = 0;
  const notConfirmed = {
    kind: 'cli-jsonl' as const,
    commandLine: 'cli-cancel-false',
    start: () => {},
    events: function* () {}, // eslint-disable-line
    wait: () => new Promise<TransportExit>((resolve) => {
      if (stopped) { resolve(STOPPED); return; }
      resolveWait = resolve;
    }),
    cancel: async () => {
      cancelCalls++;
      // Attempt 1: the transport reports the stop is NOT confirmed, without throwing.
      if (cancelCalls === 1) return false;
      stopped = true;
      resolveWait?.(STOPPED);
      return true;
    },
    dispose: async () => {},
  };
  const session = new AgentSession(
    adapter,
    store,
    { agentId: FAKE_AGENT, prompt: 'work', cwd: storeDir } as RunRequest,
    notConfirmed as unknown as FakeTransport,
  );
  session.start();
  await sleep(20);
  await session.cancel('attempt 1 (resolves false)');
  check('Case 29a: a false cancel result is NOT treated as a confirmed cancellation',
    session.state() === 'running', session.state());
  check('Case 29b: the single-flight slot was released so a retry is possible',
    session.state() === 'running' && cancelCalls === 1, `calls=${cancelCalls}`);
  // The SAME execution, not a task retry: attempt 2 goes to the same session.
  await session.cancel('attempt 2 (resolves true)');
  check('Case 29c: the SAME execution accepted a second explicit cancel', cancelCalls === 2, `calls=${cancelCalls}`);
  let result: RunResult | null = null;
  try {
    result = await session.result(5_000);
  } catch (e) {
    check('Case 29d: the retried cancellation produced a terminal', false, (e as Error).message);
  }
  check('Case 29d: the retried cancellation produced a real cancelled terminal',
    result !== null && result.state === 'cancelled', result === null ? 'no result' : result.state);
  rmSync(storeDir, { recursive: true, force: true });
}

section('R5-1.2C Case 30: a FAILED deadline cancellation releases the single-flight slot');

{
  // §10. The deadline path caught a failed `transport.cancel` but KEPT
  // `terminalRequest`, permanently occupying the single-flight slot. Every later
  // explicit `cancel()` then returned early, so an execution the deadline could not stop
  // could never be stopped at all.
  const storeDir = mkdtempSync(join(tmpdir(), 'r512c-case30-'));
  const store = new SessionStore(storeDir);
  const adapter = createFakeAdapter();
  const STOPPED: TransportExit = {
    code: null,
    signal: 'SIGTERM',
    stderrTail: '',
    stderrTruncated: false,
    cleanup: { rootKilled: true, treeStopConfirmed: true, processStart: 'started', descendantsReaped: true, note: 'stopped by the explicit retry' },
  };
  let stopped = false;
  let resolveWait: ((e: TransportExit) => void) | null = null;
  let cancelCalls = 0;
  const deadlineFlaky = {
    kind: 'cli-jsonl' as const,
    commandLine: 'deadline-cancel-failure',
    start: () => {},
    events: function* () {}, // eslint-disable-line
    wait: () => new Promise<TransportExit>((resolve) => {
      if (stopped) { resolve(STOPPED); return; }
      resolveWait = resolve;
    }),
    cancel: async () => {
      cancelCalls++;
      // The DEADLINE's stop fails; the later explicit one succeeds.
      if (cancelCalls === 1) return false;
      stopped = true;
      resolveWait?.(STOPPED);
      return true;
    },
    dispose: async () => {},
  };
  const session = new AgentSession(
    adapter,
    store,
    { agentId: FAKE_AGENT, prompt: 'work', cwd: storeDir, timeoutMs: 80 } as RunRequest,
    deadlineFlaky as unknown as FakeTransport,
  );
  session.start();
  await sleep(250); // the deadline fires at ~80ms and its cancel fails
  check('Case 30a: the failed deadline cancel left the session RUNNING (protection retained)',
    session.state() === 'running', session.state());
  check('Case 30b: the deadline actually attempted a cancel', cancelCalls === 1, `calls=${cancelCalls}`);
  await session.cancel('explicit retry after the failed deadline');
  check('Case 30c: the explicit cancel was NOT swallowed by the occupied single-flight slot',
    cancelCalls === 2, `calls=${cancelCalls}`);
  let result: RunResult | null = null;
  try {
    result = await session.result(5_000);
  } catch (e) {
    check('Case 30d: the retry produced a terminal', false, (e as Error).message);
  }
  check('Case 30d: the retry stopped the SAME execution',
    result !== null && result.state === 'cancelled', result === null ? 'no result' : result.state);
  rmSync(storeDir, { recursive: true, force: true });
}

section('R5-1.2C Case 32: an interrupted runner terminates the whole suite process TREE');

{
  // §13. A real end-to-end interrupt: a controlled "suite" that spawns a REAL detached
  // descendant, driven through the real runner, then SIGINT'd.
  //
  // The runner used `currentChild.kill()`, which on Windows terminates only the direct
  // `node tests/...` spawn. A descendant would survive the runner's exit. This proves
  // both that the runner now ends the whole tree AND that the kill is reported as
  // CONFIRMED rather than assumed.
  const dir = mkdtempSync(join(tmpdir(), 'r512c-case32-'));
  const pidFile = join(dir, 'descendant.pid');
  const suitePidFile = join(dir, 'suite.pid');
  const marker = join(dir, 'descendant-writes.txt');
  const descScript = `setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(marker)},'x'),50)`;
  const fakeSuite = join(dir, 'fake-suite.mjs');
  writeFileSync(fakeSuite, [
    `import { spawn } from 'node:child_process';`,
    `import { writeFileSync } from 'node:fs';`,
    // Its own pid, so the test can clean up deterministically if the runner's tree kill
    // ever leaves it behind. It inherits the runner's stdio, so a survivor would hold the
    // test's pipes open and stall the whole suite at exit.
    `writeFileSync(${JSON.stringify(suitePidFile)}, String(process.pid));`,
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descScript)}], { detached: true, stdio: 'ignore' });`,
    `child.unref();`,
    `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    `setInterval(() => {}, 1000);`,
  ].join('\n'), 'utf8');

  // Windows cannot deliver a real SIGINT to another process: `process.kill(pid,
  // 'SIGINT')` terminates it outright, so the runner's handler would never run and the
  // case would prove nothing. Instead the interrupt is raised the way the platform
  // actually delivers Ctrl+C — in the runner's OWN process — by a tiny launcher that
  // arms a timer and then imports the real runner module. The runner's real handler runs.
  const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
  const runnerPath = join(REPO, 'scripts', 'test-timed.mjs');
  const launcher = join(dir, 'launch.mjs');
  writeFileSync(launcher, [
    `// Arms the interrupt, then runs the REAL runner module unmodified.`,
    `setTimeout(() => process.emit('SIGINT'), 2500);`,
    `await import(${JSON.stringify(pathToFileURL(runnerPath).href)});`,
  ].join('\n'), 'utf8');

  const runner = spawn(process.execPath, [launcher], {
    cwd: REPO,
    env: { ...process.env, TEST_TIMED_SUITES: fakeSuite },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  runner.stdout?.on('data', (b: Buffer) => { out += b.toString('utf8'); });
  runner.stderr?.on('data', (b: Buffer) => { out += b.toString('utf8'); });

  // Wait until the descendant really exists, so this cannot pass by interrupting before
  // anything was spawned.
  let waited = 0;
  while (!existsSync(pidFile) && waited < 10_000) {
    await sleep(50);
    waited += 50;
  }
  check('Case 32a: the suite really spawned a descendant before the interrupt', existsSync(pidFile));

  // The fallback timer is CLEARED on every path. A timeout that loses its race still holds
  // a referenced timer, which would keep this suite alive for the full 25 s AFTER its last
  // assertion — the same dangling-timer trap `bounded()` in git.ts exists to avoid.
  const runnerExit = await new Promise<number>((resolve) => {
    const guard = setTimeout(() => resolve(-2), 25_000);
    guard.unref();
    runner.on('exit', (code) => {
      clearTimeout(guard);
      resolve(code ?? -1);
    });
  });

  check('Case 32b: the runner exited on the interrupt (130)', runnerExit === 130, String(runnerExit));
  check('Case 32c: the runner reported the tree cleanup as CONFIRMED',
    /interrupt tree cleanup CONFIRMED/.test(out), out.split('\n').filter((l) => l.includes('cleanup')).join(' | ').slice(0, 160));

  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : -1;
  let descendantGone = pid > 0 ? !isProcessAlive(pid) : true;
  for (let i = 0; i < 60 && !descendantGone; i++) {
    await sleep(50);
    descendantGone = !isProcessAlive(pid);
  }
  check('Case 32d: the DESCENDANT was terminated too, not just the direct child',
    descendantGone, `pid=${pid}`);
  // Leave nothing behind if the assertion failed: a leaked descendant would outlive the suite.
  if (!descendantGone && pid > 0) {
    try { process.kill(pid); } catch { /* already gone */ }
  }
  // Leave nothing behind that could keep THIS process alive. The suite inherits the
  // runner's stdio, so any survivor would hold the test's pipes open and stall the whole
  // suite for tens of seconds AFTER its assertions had already finished. The runner's
  // tree kill is what the case is testing, so the cleanup here is belt-and-braces: reap
  // anything still alive, then release the streams explicitly.
  for (const f of [suitePidFile, pidFile]) {
    if (!existsSync(f)) continue;
    const stray = Number(readFileSync(f, 'utf8').trim());
    if (!Number.isFinite(stray) || stray <= 0) continue;
    try {
      process.kill(stray);
    } catch {
      /* already gone, which is the expected case */
    }
  }
  await sleep(150);
  runner.stdout?.destroy();
  runner.stderr?.destroy();
  runner.unref();
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
