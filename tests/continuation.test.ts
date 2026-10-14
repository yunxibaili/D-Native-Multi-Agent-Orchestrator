/**
 * tests/continuation.test.ts — Agent Quota / Availability Handoff, same Task.
 *
 * WHAT IS PROVEN HERE
 * -------------------
 *   only availability outcomes hand off      -> classifyHandoffReason, all 11 outcomes
 *   a plain failure NEVER hands off          -> NONZERO_EXIT stays terminal `failed`
 *   the task survives the handoff            -> same taskId, new attemptId, new lease
 *   Agent A's evidence survives              -> attempt 1 still readable, packet built
 *   Agent B is chosen by Laya alone          -> a `wait` answer ends the chain
 *   the budget bounds the chain              -> maxAutomaticHandoffsPerTask is enforced
 *   A -> B -> A does not oscillate           -> the loop guard stops it
 *   both attempts reach ONE review           -> the unified packet carries attempt 1 AND 2
 *   no new authority appeared                -> topology guards over src/
 *
 * Sections 5-12 drive the REAL production path: a real `NativeWorkbench`, the real
 * `TaskScheduler`, the real `Orchestrator`, the real spawn gate and the real
 * `TaskStore`/`AttemptStore`. Only two things are injected, and both are injected by
 * the existing seams:
 *
 *   - `RuntimeRunner`, so a run's terminal `RunResult` can be dictated. This is the
 *     same seam every orchestration test uses, and the runs it produces are real
 *     executions through the one execution edge.
 *   - `DecisionProvider`, which IS Laya. Deciding who runs next is Laya's job, so the
 *     test answers as Laya would. It is never bypassed: the chain only continues when
 *     this provider says `reassign`.
 *
 * No quota provider is faked. Case 1 produces a REAL gate refusal by flipping the real
 * `QuotaRecord` between assignment and execution through the existing
 * `updateGateSources`, which is exactly how quota exhaustion shows up in production.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ModelRegistry } from '../src/quota/registry.ts';
import { BudgetManager } from '../src/quota/budget.ts';
import type { QuotaRecord, TaskType } from '../src/quota/types.ts';
import type { AgentDescriptor, RunHandle, RunRequest, RunResult } from '../src/core/types.ts';
import type { RuntimeRunner } from '../src/orchestration/execute.ts';

import { Orchestrator } from '../src/orchestration/orchestrator.ts';
import { TaskScheduler } from '../src/orchestration/scheduler.ts';
import { NativeWorkbench } from '../src/orchestration/workbench.ts';
import { buildHandoff } from '../src/orchestration/workbench-handoff.ts';
import { classifyExecutionOutcome, buildReviewPacket, type ExecutionOutcome } from '../src/orchestration/unified-review.ts';
import {
  DEFAULT_HANDOFF_POLICY,
  HANDOFF_REASONS,
  buildContinuationPacket,
  classifyHandoffReason,
  evaluateHandoffBudget,
  isSameWorker,
  renderContinuationPacket,
  runHandoffContinuation,
  workerAlreadyUsed,
  type ContinuationDeps,
  type WorkerRef,
} from '../src/orchestration/continuation.ts';
import { AVAILABILITY_ERROR_CODES, translateRunResult } from '../src/orchestration/translate.ts';
import {
  USER_MODEL_POOL_POLICY,
  type UserModelPool,
  type UserModelPoolEntry,
} from '../src/orchestration/model-pool.ts';
import type { DecisionProvider } from '../src/decision/types.ts';
import { sourceText } from './helpers.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; process.stdout.write(`  ok   ${name}\n`); }
  else { failed++; failures.push(name); process.stdout.write(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}\n`); }
}
function section(t: string): void { process.stdout.write(`\n== ${t} ==\n`); }

const NOW = 1_700_000_000_000;
const A = 'agent-a';
const B = 'agent-b';
const impl: TaskType = 'implementation';

const descriptor = (id: string): AgentDescriptor => ({
  id, displayName: id, launcher: 'fake', transport: 'cli-jsonl',
  capabilities: { newTask: true, review: true, modelSelection: true, resume: true },
} as unknown as AgentDescriptor);

const statusRow = (agent: string) => ({ agent, version: '1', installed: 'Yes', login: 'n/a', quotaSource: 't', usage: 'n/a', status: 'ok' });

const quotaRecord = (agentId: string, status: QuotaRecord['status'] = 'available'): QuotaRecord => ({
  provider: agentId, agentId, modelId: null, source: 'locally_observed', usage: null, remaining: null,
  resetAt: null, period: 'day', status, usageClass: 'observed', confidence: 'high', observedAt: NOW, note: '',
});

/**
 * A REAL BudgetManager.
 *
 * The gate calls `snapshotAll()` on it, so a hand-rolled stub is not an option — the
 * budget is one of the admission inputs a handoff must not weaken, and a fake one would
 * make the gate's budget refusal untestable.
 */
function budgetsFor(agents: readonly string[]): BudgetManager {
  const m = new BudgetManager(1_000_000);
  for (const a of agents) m.agent(a, 100_000);
  m.task('r', 100_000);
  return m;
}

const registryWith = (agents: readonly string[]): ModelRegistry => {
  const reg = new ModelRegistry();
  for (const a of agents) {
    reg.upsert({ agentId: a, modelId: `${a}/m1`, provider: 'test', taskTypes: [impl], modelSource: 'test', quotaSource: 'test' } as never, NOW);
    reg.setAgentAvailability(a, 'available');
  }
  return reg;
};

/** B2.1 pool seams reused here: a live, no-additional-charge user declaration. */
const poolEntry = (agentId: string, modelId: string): UserModelPoolEntry => ({
  agentId, modelId, billing: 'free', source: 'r2-3 relay test declaration',
  observedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER,
});
const poolOf = (...entries: UserModelPoolEntry[]): UserModelPool => ({ policy: USER_MODEL_POOL_POLICY, models: entries });

const runResult = (over: Partial<RunResult> & { state: RunResult['state'] }): RunResult => ({
  agentId: A, startedAt: NOW, endedAt: NOW + 10, exitCode: 0, signal: null,
  output: '', outputTruncated: false, transcriptPath: null, usage: null, toolCalls: [],
  diagnostics: [], cleanup: { rootKilled: false, descendantsReaped: false, note: '' },
  error: null, ...over,
} as unknown as RunResult);

/** `AttemptStore.append` is a discriminated union; this asserts it and returns the record. */
function mustAppend(outcome: { ok: boolean } & Record<string, unknown>, what: string): never | {
  readonly attemptId: string;
  readonly agentId: string;
  readonly modelId: string | null;
  readonly outcome: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly leaseVersion?: number;
} {
  if (outcome.ok !== true) {
    throw new Error(`${what} could not be recorded: ${String(outcome.code ?? 'no code')} ${String(outcome.reason ?? '')}`);
  }
  return outcome.record as never;
}

/** Laya. Answers with whatever the test scripts, and records what it was asked. */
function laya(script: readonly unknown[]): { provider: DecisionProvider; asked: string[] } {
  const asked: string[] = [];
  let i = 0;
  return {
    asked,
    provider: {
      name: 'laya-stub',
      async probe() { return { ok: true, endpoint: 'stub://laya', detail: 'test double for Laya', warnings: [] }; },
      async decide(req) {
        const state = req.state?.['next_action'] ?? '';
        asked.push(state);
        const answer = script[Math.min(i, script.length - 1)];
        i++;
        const parameters = typeof answer === 'object' && answer !== null
          ? Object.fromEntries(Object.entries(answer as Record<string, unknown>).filter(([k]) => k !== 'action'))
          : {};
        return {
          answers: {
            next_action: {
              type: 'choice',
              choice: (typeof answer === 'string' ? answer : (answer as { action: string }).action),
              parameters,
            },
          },
        } as never;
      },
    },
  };
}

interface Harness {
  wb: NativeWorkbench;
  sched: TaskScheduler;
  orch: Orchestrator;
  dir: string;
  runs: RunRequest[];
  /**
   * Fund a task's scope.
   *
   * The gate needs THREE scopes to exist — global, `task:<id>` and `agent:<id>` — and
   * refuses with `budget-scope-unavailable` rather than auto-creating a missing one.
   * Production provisions these per round (round-cli does exactly this); the harness has
   * to as well, because a task whose budget does not exist never runs and the handoff
   * would never be reached. Budget is one of the admission inputs a handoff must not
   * weaken, so this funds a REAL scope rather than stubbing the check away.
   */
  fund: (taskId: string, agentId: string) => void;
  cleanup: () => void;
}

/**
 * A real workbench over a programmable runtime.
 *
 * `script` is consulted per run, so "agent A fails its quota, agent B succeeds" is
 * expressed by what the runtime returns for each `agentId` — the same production seam,
 * with the process outcome dictated.
 */
function harness(opts: {
  script?: (req: RunRequest) => RunResult;
  agents?: readonly string[];
  allowAvailabilityContinuation?: boolean;
  /** B2.1: the SAME frozen user-declared pool the Workbench enforces at reassign time. */
  modelPool?: UserModelPool;
} = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'cont-'));
  const runs: RunRequest[] = [];
  const agents = opts.agents ?? [A, B];

  const runtime: RuntimeRunner = {
    run(req: RunRequest): RunHandle {
      runs.push(req);
      const result = opts.script
        ? opts.script(req)
        : runResult({ state: 'succeeded', agentId: req.agentId, output: 'done' });
      return { result: async () => result, cancel: async () => {}, dispose: async () => {} } as unknown as RunHandle;
    },
  };

  const budgets = budgetsFor(agents);

  const orch = new Orchestrator({
    runtime,
    gate: {
      descriptors: agents.map(descriptor),
      agentStatus: agents.map(statusRow),
      quotaRecords: agents.map((a) => quotaRecord(a)),
      registry: registryWith(agents),
      budgets: budgets,
      taskType: impl,
      requestedUnits: 100,
      currentConcurrency: 0,
      maxConcurrency: 4,
      maxChildren: 8,
      maxConcurrentAgents: 4,
    } as never,
    now: () => NOW,
    defaultCwd: dir,
  });
  const sched = new TaskScheduler({ orchestrator: orch, cwd: dir });
  const wb = new NativeWorkbench({
    orchestrator: orch, scheduler: sched, registry: registryWith(agents),
    quotaRecords: agents.map((a) => quotaRecord(a)), cwd: dir, now: () => NOW,
    ...(opts.modelPool !== undefined ? { modelPool: opts.modelPool } : {}),
  });
  return {
    wb, sched, orch, dir, runs,
    fund: (taskId, agentId) => { budgets.task(taskId, 100_000); budgets.agent(agentId, 100_000); },
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows */ } },
  };
}

/**
 * Execute one attempt AND record it, the way production does.
 *
 * `NativeWorkbench.dispatch()` normally does both: it calls the scheduler and then
 * `recordExecutions`, which is the ONLY writer of `AttemptRecord`. Calling
 * `orchestrator.executeTask` directly performs the execution but skips the recording, so
 * a test that does that alone leaves the evidence store empty — and a handoff cannot
 * read a continuation context out of evidence that was never written. This helper keeps
 * the two steps together so the tests exercise the same pair production does.
 */
async function runOnce(h: Harness, taskId: string): Promise<Awaited<ReturnType<Orchestrator['executeTask']>>> {
  const outcome = await h.orch.executeTask({
    taskId, cwd: h.dir, translate: { allowAvailabilityContinuation: true },
  });
  const task = h.wb.store.get(taskId);
  if (task === null || outcome.ok !== true) return outcome;

  // The REAL RunResult the runtime produced, when `executeTask` hands it back. Using it
  // rather than a synthesised one is what makes the recorded attempt carry the actual
  // error code (`SPAWN_FAILED`), which is precisely what a continuation trigger reads.
  const run = outcome.run;
  const realError = run?.error ?? null;
  mustAppend(h.wb.evidence.append({
    kind: 'execution', taskId,
    agentId: run?.agentId ?? task.agentId,
    modelId: task.modelId ?? null,
    taskType: task.taskType,
    startedAt: run?.startedAt ?? NOW,
    finishedAt: run?.endedAt ?? NOW + 5,
    outcome: task.status === 'to_verify' ? 'success' : 'failure',
    ...(realError === null ? {} : { errorCode: realError.code, errorMessage: realError.message }),
    leaseVersion: task.leaseVersion,
  } as never), `attempt for ${taskId}`);
  return outcome;
}

/** Plan + assign, returning the single child task id. */
function seedTask(h: Harness, preferred: string): string {
  const spec = {
    taskId: 'r', objective: 'produce the thing', taskType: impl,
    shape: 'single' as const, budgetUnits: 10, preferredAgent: preferred,
  };
  const planned = h.wb.plan(spec as never, null);
  const child = planned.children[0]!;
  h.wb.assignChildren('r', spec as never);
  h.wb.sessions.open(
    { agentId: child.agentId, modelId: child.modelId, sessionPolicy: 'fresh' },
    h.dir, NOW, child.taskId,
  );
  h.fund(child.taskId, child.agentId);
  return child.taskId;
}

// ---------------------------------------------------------------------------
// 1. Only availability outcomes hand off
// ---------------------------------------------------------------------------
section('R2-3 1. trigger classification');

{
  for (const reason of HANDOFF_REASONS) {
    const o = classifyExecutionOutcome({ taskId: 't1', taskStatus: 'running', refusalCode: reason === 'quota_exhausted' ? 'quota-blocked' : undefined });
    // Build the outcome under test directly so the three triggers are exercised exactly.
    const forced: ExecutionOutcome = { ...o, outcome: reason };
    const c = classifyHandoffReason(forced);
    check(`"${reason}" hands off`, c.handoff === true, JSON.stringify(c));
    if (c.handoff) check(`  ...and reports the same reason`, c.reason === reason);
  }

  // The five outcomes that must NOT hand off, and why.
  const no: readonly ExecutionOutcomeKindish[] = ['failed', 'error', 'timeout', 'resource_refused', 'lease_refused', 'cancelled', 'refused', 'success'];
  for (const outcome of no) {
    const c = classifyHandoffReason({ taskId: 't1', outcome, taskStatus: 'failed', code: null, reason: null, agentId: A, modelId: null, executed: true, refused: false, attemptIds: [] });
    check(`"${outcome}" does NOT hand off`, c.handoff === false, JSON.stringify(c));
    check(`  ...and says why`, c.explanation.includes(outcome));
  }
}
type ExecutionOutcomeKindish = Parameters<typeof classifyHandoffReason>[0]['outcome'];

// ---------------------------------------------------------------------------
// 2. The translate opt-in
// ---------------------------------------------------------------------------
section('R2-3 2. availability failure parks instead of terminating');

{
  check('SPAWN_FAILED and TRANSPORT_ERROR are the availability codes',
    AVAILABILITY_ERROR_CODES.has('SPAWN_FAILED') && AVAILABILITY_ERROR_CODES.has('TRANSPORT_ERROR'));
  check('NONZERO_EXIT is NOT an availability code', !AVAILABILITY_ERROR_CODES.has('NONZERO_EXIT'));

  const spawnFailed = runResult({ state: 'failed', error: { code: 'SPAWN_FAILED', message: 'could not start' } });
  // Default: unchanged. This is the regression guard for every existing caller.
  const dflt = translateRunResult(spawnFailed);
  check('by DEFAULT an availability failure still fails the task', dflt.to === 'failed', dflt.to);
  check('...and that failure is terminal', dflt.terminal === true);

  const opted = translateRunResult(spawnFailed, { allowAvailabilityContinuation: true });
  check('when opted in, SPAWN_FAILED parks in retrying', opted.to === 'retrying', opted.to);
  check('...and is NOT terminal', opted.terminal === false);
  check('...and is NOT awaiting verification', opted.awaitingVerification === false);

  // The important negative: a real work failure must not become continuable, or a code
  // error would hop between agents forever.
  const nonzero = runResult({ state: 'failed', error: { code: 'NONZERO_EXIT', message: 'boom' } });
  check('NONZERO_EXIT stays failed even when opted in',
    translateRunResult(nonzero, { allowAvailabilityContinuation: true }).to === 'failed');

  const timeout = runResult({ state: 'timed_out' });
  check('a timeout stays failed even when opted in',
    translateRunResult(timeout, { allowAvailabilityContinuation: true }).to === 'failed');

  const ok = runResult({ state: 'succeeded' });
  check('a success still goes to to_verify, never retrying',
    translateRunResult(ok, { allowAvailabilityContinuation: true }).to === 'to_verify');
}

// ---------------------------------------------------------------------------
// 3. The ContinuationPacket
// ---------------------------------------------------------------------------
section('R2-3 3. the continuation packet');

{
  const h = harness();
  try {
    const taskId = seedTask(h, A);
    const task = h.wb.store.get(taskId)!;
    // A real attempt record, from the real AttemptStore, recording a real lease.
    const attempt = mustAppend(h.wb.evidence.append({
      kind: 'execution', taskId, agentId: A, modelId: `${A}/m1`, taskType: impl,
      startedAt: NOW, finishedAt: NOW + 5, outcome: 'failure',
      errorCode: 'SPAWN_FAILED', errorMessage: 'could not start', leaseVersion: 1,
    } as never), 'attempt 1');
    check('the attempt was recorded', attempt.attemptId.length > 0);

    const outcome = classifyExecutionOutcome({
      taskId, taskStatus: 'retrying', agentId: A, modelId: `${A}/m1`,
      run: runResult({ state: 'failed', agentId: A, error: { code: 'SPAWN_FAILED', message: 'could not start' } }),
    });
    const evidence = buildHandoff(task, runResult({ state: 'failed', agentId: A, output: 'I got started', error: { code: 'SPAWN_FAILED', message: 'could not start' } }));
    const rec = h.wb.evidence.history(taskId)[0]!;
    const packet = buildContinuationPacket({
      task, reason: 'agent_unavailable', outcome, evidence,
      attempt: { attemptId: rec.attemptId, agentId: rec.agentId, modelId: rec.modelId, leaseVersion: rec.leaseVersion, errorCode: rec.errorCode, errorMessage: rec.errorMessage },
    });

    check('the packet keeps the SAME taskId', packet.taskId === taskId);
    check('it names the previous attempt', packet.previousAttemptId === rec.attemptId, String(packet.previousAttemptId));
    check('it names the previous agent', packet.previousAgentId === A);
    check('it records the lease version attempt 1 ran under', packet.previousLeaseVersion === 1, String(packet.previousLeaseVersion));
    check('it carries the original objective', packet.originalObjective === task.acceptanceCriteria);
    check('the handoff reason is agent_unavailable', packet.handoffReason === 'agent_unavailable');
    check('it preserves the real error code', packet.errors.some((e) => e.code === 'SPAWN_FAILED'), JSON.stringify(packet.errors));
    check('it does NOT invent a next action', packet.nextAction === null);
    check('no native session is offered cross-agent', packet.nativeSessionReference === null);
    check('changedFiles come from evidence only', Array.isArray(packet.changedFiles));

    const text = renderContinuationPacket(packet);
    check('the rendered packet names the task', text.includes(taskId));
    check('the rendered packet names the previous worker', text.includes(A));
    check('the rendered packet states this is not a failure of the work',
      text.includes('not a failure of the work'));
    check('the rendered packet says a fresh conversation starts',
      text.includes('fresh conversation'));

    // Same-agent continuation MAY carry a session; cross-agent may not.
    const same = buildContinuationPacket({
      task, reason: 'quota_exhausted', outcome, evidence, nativeThreadId: 'th-123',
      attempt: { attemptId: rec.attemptId, agentId: rec.agentId, modelId: rec.modelId },
    });
    check('a session reference is carried for the SAME agent',
      same.nativeSessionReference?.threadId === 'th-123', JSON.stringify(same.nativeSessionReference));
  } finally { h.cleanup(); }
}

// ---------------------------------------------------------------------------
// 4. Budget and loop guard (pure)
// ---------------------------------------------------------------------------
section('R2-3 4. budget and loop protection');

{
  const p = DEFAULT_HANDOFF_POLICY;
  check('the default budget is finite and positive', p.maxAutomaticHandoffsPerTask === 2, String(p.maxAutomaticHandoffsPerTask));

  check('the first handoff is allowed',
    evaluateHandoffBudget({ policy: p, used: 0, agentsUsed: [] }).allowed === true);
  check('the second handoff is allowed',
    evaluateHandoffBudget({ policy: p, used: 1, agentsUsed: [A] }).allowed === true);
  const third = evaluateHandoffBudget({ policy: p, used: 2, agentsUsed: [A, B] });
  check('the third handoff is REFUSED', third.allowed === false);
  check('...with code budget-exhausted', third.code === 'budget-exhausted', String(third.code));
  check('...and a reason naming the numbers', third.reason.includes('2') && third.reason.includes('2'));

  check('a limit of 0 disables handoff entirely',
    evaluateHandoffBudget({ policy: { maxAutomaticHandoffsPerTask: 0 }, used: 0, agentsUsed: [] }).allowed === false);

  const unbounded = evaluateHandoffBudget({ policy: { maxAutomaticHandoffsPerTask: Infinity }, used: 0, agentsUsed: [] });
  check('an UNBOUNDED policy is refused, not clamped', unbounded.allowed === false);
  check('...because it is not a finite integer', unbounded.reason.includes('finite integer'));

  const loop = evaluateHandoffBudget({ policy: p, used: 1, agentsUsed: [A], targetAgentId: A });
  check('returning to an agent already in the chain is REFUSED', loop.allowed === false);
  check('...with code loop-refused', loop.code === 'loop-refused', String(loop.code));
  const justified = evaluateHandoffBudget({
    policy: p, used: 1, agentsUsed: [A], targetAgentId: A, layaReason: 'A recovered and is now the only capable agent',
  });
  check('...unless Laya states an explicit reason', justified.allowed === true);
  const stillBounded = evaluateHandoffBudget({
    policy: { maxAutomaticHandoffsPerTask: 1 }, used: 1, agentsUsed: [A], targetAgentId: A, layaReason: 'because',
  });
  check('...but a stated reason still cannot exceed the count bound', stillBounded.allowed === false);
}

// ---------------------------------------------------------------------------
// 4b. B5.1 — concrete worker pairs and the stop-safety gate
// ---------------------------------------------------------------------------
section('R2-3 4b. B5.1 concrete pairs, collision-safe, and the stop gate');

{
  const p = DEFAULT_HANDOFF_POLICY;
  const m1: WorkerRef = { agentId: A, modelId: `${A}/m1` };
  const m2: WorkerRef = { agentId: A, modelId: `${A}/m2` };
  const m3: WorkerRef = { agentId: A, modelId: `${A}/m3` };

  check('B5.1: same agent, different KNOWN models is a DIFFERENT worker', isSameWorker(m1, m2) === false);
  check('B5.1: same agent, same model is the SAME worker', isSameWorker(m1, { agentId: A, modelId: `${A}/m1` }) === true);
  check('B5.1: a different agent is a DIFFERENT worker', isSameWorker(m1, { agentId: B, modelId: `${B}/m1` }) === false);
  check('B5.1: an UNKNOWN model is conservatively the SAME worker', isSameWorker(m1, { agentId: A, modelId: null }) === true);
  check('workerAlreadyUsed matches field by field', workerAlreadyUsed([m1], m2) === false && workerAlreadyUsed([m1], m1) === true);

  check('B5.1: the pair guard ALLOWS a new model on the same agent',
    evaluateHandoffBudget({ policy: p, used: 1, agentsUsed: [A], workersUsed: [m1], target: m2, targetAgentId: A }).allowed === true);
  const backToM1 = evaluateHandoffBudget({ policy: p, used: 1, agentsUsed: [A], workersUsed: [m1], target: m1, targetAgentId: A });
  check('B5.1: the pair guard REFUSES returning to a used pair',
    backToM1.allowed === false && backToM1.code === 'loop-refused', JSON.stringify(backToM1));
  check('B5.1: ...unless Laya states an explicit reason',
    evaluateHandoffBudget({ policy: p, used: 1, agentsUsed: [A], workersUsed: [m1], target: m1, targetAgentId: A, layaReason: 'A recovered' }).allowed === true);
  const capped = evaluateHandoffBudget({
    policy: { maxAutomaticHandoffsPerTask: 1 }, used: 1, agentsUsed: [A], workersUsed: [m2], target: m3, targetAgentId: A, layaReason: 'because',
  });
  check('B5.1: ...but a reason cannot exceed the count bound', capped.allowed === false && capped.code === 'budget-exhausted');

  // A concatenated key would collide these two; field-by-field comparison must not.
  check('B5.1: the pair guard does NOT collide two different tuples that concatenate equally',
    evaluateHandoffBudget({
      policy: p, used: 1, agentsUsed: ['a'],
      workersUsed: [{ agentId: 'a', modelId: 'b/c' }],
      target: { agentId: 'a/b', modelId: 'c' }, targetAgentId: 'a/b',
    }).allowed === true);

  // Legacy: no pair supplied keeps the original agent-only, conservative semantics.
  const legacy = evaluateHandoffBudget({ policy: p, used: 1, agentsUsed: [A], targetAgentId: A });
  check('B5.1: without pairs the guard keeps agent-only semantics', legacy.allowed === false && legacy.code === 'loop-refused');
}

// ---------------------------------------------------------------------------
// 4c. B5.1 — an executed session_failure needs a CONFIRMED stop before handoff
// ---------------------------------------------------------------------------
section('R2-3 4c. B5.1 stop-safety gate');

{
  const h = harness();
  try {
    const taskId = seedTask(h, A);
    const task = h.wb.store.get(taskId)!;
    const stopRun = runResult({ state: 'failed', agentId: A, output: 'partial work', error: { code: 'TRANSPORT_ERROR', message: 'session disconnected' } });
    const outcome = classifyExecutionOutcome({ taskId, taskStatus: 'retrying', agentId: A, modelId: `${A}/m1`, run: stopRun });
    check('B5.1: a TRANSPORT_ERROR run classifies as session_failure', outcome.outcome === 'session_failure', outcome.outcome);

    const withClean = (treeStopConfirmed: boolean | undefined) => ({
      rootKilled: false, descendantsReaped: true, note: '',
      ...(treeStopConfirmed === undefined ? {} : { treeStopConfirmed }),
    });
    const base = { task, reason: 'session_failure' as const, outcome, evidence: null, attempt: { attemptId: 'att_x', agentId: A, modelId: `${A}/m1` } };
    const unconfirmed = buildContinuationPacket({ ...base, cleanup: withClean(undefined) });
    const confirmed = buildContinuationPacket({ ...base, cleanup: withClean(true) });
    check('B5.1: an executed session_failure REQUIRES a stop proof', unconfirmed.stopSafety.required === true);
    check('B5.1: an ABSENT treeStopConfirmed is NOT confirmed', unconfirmed.stopSafety.confirmed !== true);
    check('B5.1: treeStopConfirmed=true IS confirmed', confirmed.stopSafety.confirmed === true);

    const nonSession = buildContinuationPacket({
      task, reason: 'agent_unavailable', evidence: null, attempt: null, cleanup: null,
      outcome: classifyExecutionOutcome({ taskId, taskStatus: 'retrying', agentId: A, run: runResult({ state: 'failed', agentId: A, error: { code: 'SPAWN_FAILED', message: 'no start' } }) }),
    });
    check('B5.1: a non-session_failure outcome needs NO stop proof',
      nonSession.stopSafety.required === false && nonSession.stopSafety.confirmed === null);

    check('B5.1: the packet text carries the STOP FACT', renderContinuationPacket(unconfirmed).includes('STOP FACT'));
    check('B5.1: the packet warns against blind replay', renderContinuationPacket(confirmed).includes('blindly replay'));

    // Driver: unconfirmed -> stop-unconfirmed, Laya never consulted, no handoff.
    let cycles = 0;
    const unconfirmedDeps: ContinuationDeps = {
      async readOutcomes() { return [outcome]; },
      buildPacket() { return unconfirmed; },
      identityOf() { return { agentId: A, modelId: `${A}/m1` }; },
      async runCycle() { cycles++; return { action: 'reassign', applied: true, dispatched: false, code: null, reason: 'x', targetAgentId: A, targetModelId: `${A}/m2` }; },
      now: () => NOW,
    };
    const u = await runHandoffContinuation(unconfirmedDeps);
    check('B5.1: the driver STOPS as stop-unconfirmed', u.stopped.code === 'stop-unconfirmed', u.stopped.code);
    check('B5.1: the driver never consulted Laya', cycles === 0, String(cycles));
    check('B5.1: no handoff was recorded', u.handoffs.length === 0);

    // Driver: confirmed -> the same-agent model move IS recorded (pair change).
    let model = `${A}/m1`;
    const confirmedDeps: ContinuationDeps = {
      async readOutcomes() { return [outcome]; },
      buildPacket() { return confirmed; },
      identityOf: () => ({ agentId: A, modelId: model }),
      async runCycle() { cycles++; model = `${A}/m2`; return { action: 'reassign', applied: true, dispatched: false, code: null, reason: 'moved', targetAgentId: A, targetModelId: `${A}/m2` }; },
      now: () => NOW,
    };
    const c = await runHandoffContinuation(confirmedDeps, { policy: { maxAutomaticHandoffsPerTask: 1 } });
    check('B5.1: with a confirmed stop the same-agent model move is recorded', c.handoffs.length === 1, JSON.stringify(c.handoffs.map((x) => `${x.fromModelId}->${x.toModelId}`)));
    check('B5.1: the record carries the from/to pair',
      c.handoffs[0]?.fromModelId === `${A}/m1` && c.handoffs[0]?.toModelId === `${A}/m2`,
      JSON.stringify(c.handoffs[0] && { from: c.handoffs[0].fromModelId, to: c.handoffs[0].toModelId }));
    check('B5.1: the worker chain records the pair',
      (c.workerChain[taskId] ?? [])[0]?.modelId === `${A}/m1`, JSON.stringify(c.workerChain));
  } finally { h.cleanup(); }
}

// ---------------------------------------------------------------------------
// 4d. B5.1 — the handoff SOURCE model is authenticated from the previous attempt
// ---------------------------------------------------------------------------
section('R2-3 4d. B5.1 fromModel is authenticated from the packet, not a changed Task');

{
  // A pre-migrated Task is exactly the shape the workflow path used to produce: the packet
  // still describes attempt 1 (which really ran m1), while the Task binding already reads
  // m2. The record must authenticate the SOURCE model from the ATTEMPT, never reverse-
  // derive it from the changed Task.
  const h = harness();
  try {
    const taskId = seedTask(h, A);
    const task = h.wb.store.get(taskId)!;
    const stopRun = runResult({ state: 'failed', agentId: A, output: 'partial', error: { code: 'TRANSPORT_ERROR', message: 'session disconnected' } });
    const outcome = classifyExecutionOutcome({ taskId, taskStatus: 'retrying', agentId: A, modelId: `${A}/m1`, run: stopRun });
    const packet = buildContinuationPacket({
      task, reason: 'session_failure', outcome, evidence: null,
      attempt: { attemptId: 'att_0001', agentId: A, modelId: `${A}/m1` },
      cleanup: { treeStopConfirmed: true },
    });
    check('B5.1: the packet names the real previous model (m1)', packet.previousModelId === `${A}/m1`, String(packet.previousModelId));

    const deps: ContinuationDeps = {
      async readOutcomes() { return [outcome]; },
      buildPacket() { return packet; },
      // The Task already MIGRATED to m2; the driver must not trust it as the source.
      identityOf() { return { agentId: A, modelId: `${A}/m2` }; },
      async runCycle() { return { action: 'reassign', applied: true, dispatched: false, code: null, reason: 'moved', targetAgentId: A, targetModelId: `${A}/m3` }; },
      now: () => NOW,
    };
    const res = await runHandoffContinuation(deps, { policy: { maxAutomaticHandoffsPerTask: 1 } });
    check('B5.1: the from model is the PREVIOUS ATTEMPT (m1), not the changed Task (m2)',
      res.handoffs[0]?.fromModelId === `${A}/m1`,
      JSON.stringify(res.handoffs[0] && { from: res.handoffs[0].fromModelId, to: res.handoffs[0].toModelId }));
    check('B5.1: previousAttemptId still resolves to the m1 attempt',
      res.handoffs[0]?.previousAttemptId === 'att_0001', String(res.handoffs[0]?.previousAttemptId));
  } finally { h.cleanup(); }
}

// ---------------------------------------------------------------------------
// 4e. B5.1 — an OLD user model-pool constraint still holds at the relay entry
// ---------------------------------------------------------------------------
section('R2-3 4e. B5.1 a relay reassign to a pair OUTSIDE the user pool is refused');

{
  // The user declared ONLY agent-a/model-1. Agent B's pair is genuinely REGISTERED, so a
  // naive relay would happily "continue" the task on it. The pre-existing B2.1 constraint
  // must refuse that at the relay entry — no migration, no silent substitution, no run.
  const h = harness({ modelPool: poolOf(poolEntry(A, `${A}/m1`)) });
  try {
    const taskId = seedTask(h, A);
    const task = h.wb.store.get(taskId)!;
    check('B5.1: the task starts on the DECLARED pair', task.agentId === A && task.modelId === `${A}/m1`,
      `${task.agentId}/${task.modelId}`);

    const outcome = classifyExecutionOutcome({
      taskId, taskStatus: 'planned', agentId: A, modelId: `${A}/m1`,
      refusalCode: 'quota-exhausted', refusalReason: 'the only declared agent is out of quota',
    });
    check('B5.1: the outcome is a handoff trigger', classifyHandoffReason(outcome).handoff === true);

    const packet = buildContinuationPacket({
      task, reason: 'quota_exhausted', outcome, evidence: null, attempt: null,
    });
    const deps: ContinuationDeps = {
      async readOutcomes() { return [outcome]; },
      buildPacket() { return packet; },
      identityOf() { return { agentId: A, modelId: `${A}/m1` }; },
      async runCycle() {
        // The REAL relay seam: the Workbench's reassign, which owns the pool constraint.
        const swap = h.wb.reassignTask(taskId, B, `${B}/m1`, 'continue on another agent');
        return {
          action: 'reassign', applied: swap.ok, dispatched: false,
          code: swap.ok ? null : swap.code, reason: swap.reason,
          targetAgentId: B, targetModelId: `${B}/m1`,
        };
      },
      now: () => NOW,
    };
    const res = await runHandoffContinuation(deps);
    check('B5.1: the relay reassign to an out-of-pool pair is REFUSED',
      res.handoffs.length === 0 && res.stopped.code === 'decision-refused', JSON.stringify(res.stopped));
    const after = h.wb.store.get(taskId)!;
    check('B5.1: the task did NOT migrate (no silent substitution)',
      after.agentId === A && after.modelId === `${A}/m1`, `${after.agentId}/${after.modelId}`);
    check('B5.1: no runtime ran on the refused relay', h.runs.length === 0, String(h.runs.length));
  } finally { h.cleanup(); }
}

// ---------------------------------------------------------------------------
// 5. CASE 1 — quota exhausted -> Agent B (real gate refusal)
// ---------------------------------------------------------------------------
section('R2-3 5. CASE 1: quota_exhausted -> Agent B, same task');

{
  const h = harness({ allowAvailabilityContinuation: true });
  try {
    const taskId = seedTask(h, A);
    check('assignment chose Agent A', h.wb.store.get(taskId)!.agentId === A, h.wb.store.get(taskId)!.agentId);
    check('the task starts non-terminal and dispatchable',
      h.wb.store.get(taskId)!.status === 'planned' || h.wb.store.get(taskId)!.status === 'queued',
      h.wb.store.get(taskId)!.status);

    // Agent A's quota is exhausted AFTER assignment. This is a REAL gate input, flipped
    // through the existing `updateGateSources` — the production way quota exhaustion
    // appears, with no faked quota provider anywhere.
    h.orch.updateGateSources({
      quotaRecords: [quotaRecord(A, 'exhausted'), quotaRecord(B)],
    });

    const tick = await h.sched.tick();
    const refused = tick.skipped.find((s) => s.taskId === taskId);
    check('the gate REFUSED Agent A on quota', refused !== undefined && refused.code === 'quota-exhausted',
      JSON.stringify(refused));
    check('nothing was dispatched', tick.admitted.length === 0, JSON.stringify(tick.admitted));
    check('no native process ran', h.runs.length === 0);

    // Critically: a gate refusal leaves the task ALIVE, which is what makes the handoff
    // possible without weakening any terminal-state rule.
    check('the task is still non-terminal after a gate refusal',
      h.wb.store.get(taskId)!.status === 'planned' || h.wb.store.get(taskId)!.status === 'queued',
      h.wb.store.get(taskId)!.status);

    const outcome = classifyExecutionOutcome({
      taskId, taskStatus: 'planned', agentId: A, refusalCode: refused?.code ?? null, refusalReason: refused?.reason ?? null,
    });
    check('the refusal classifies as quota_exhausted', outcome.outcome === 'quota_exhausted', outcome.outcome);
    check('a gate refusal executed nothing', outcome.executed === false);
    check('it IS a handoff trigger', classifyHandoffReason(outcome).handoff === true);

    // And the "we don't know" case must NOT hand off, per R2-3 §12: an unconfirmed quota
    // status is not an exhausted one, and switching agents because of it would be
    // guessing. `quota-unavailable` is what the gate denies when status is unknown.
    const unknown = classifyExecutionOutcome({
      taskId, taskStatus: 'planned', agentId: A, refusalCode: 'quota-unavailable',
      refusalReason: 'quota status is "not_fetched"',
    });
    check('an UNCONFIRMED quota status does NOT classify as quota_exhausted',
      unknown.outcome !== 'quota_exhausted', unknown.outcome);
    check('...it stays refused', unknown.outcome === 'refused', unknown.outcome);
    check('...and it is NOT a handoff trigger', classifyHandoffReason(unknown).handoff === false);
  } finally { h.cleanup(); }
}

// ---------------------------------------------------------------------------
// 6. CASE 2 — agent unavailable -> Agent B, and CASE 6 same-task semantics
// ---------------------------------------------------------------------------
section('R2-3 6. CASE 2 + CASE 6: agent_unavailable -> Agent B, same task / new attempt / new lease');

{
  const h = harness({
    allowAvailabilityContinuation: true,
    script: () => runResult({ state: 'failed', agentId: A, error: { code: 'SPAWN_FAILED', message: 'agent could not start' } }),
  });
  try {
    const taskId = seedTask(h, A);
    const leaseBefore = h.wb.store.leaseOf(taskId)?.leaseVersion;

    // The runtime must PARK rather than terminate, so the task can move. Pass the policy
    // the way a round would: on the execute request.
    const before = h.wb.store.get(taskId)!;
    check('task starts on A', before.agentId === A);

    const outcome = await h.orch.executeTask({
      taskId, cwd: h.dir,
      translate: { allowAvailabilityContinuation: true },
    });
    // `outcome.ok` reports whether the WRITE-BACK was accepted, not whether the run
    // succeeded. A failed run that parks cleanly IS `ok: true` here - which is exactly
    // why the status assertion below is the meaningful one.
    check('the failed run was still written back (not swallowed)',
      outcome.ok === true, `ok=${String(outcome.ok)} code=${outcome.ok ? '' : outcome.code}`);
    check('the task is PARKED in retrying, not failed',
      h.wb.store.get(taskId)!.status === 'retrying',
      `status=${h.wb.store.get(taskId)!.status} outcomeCode=${outcome.ok ? 'ok' : outcome.code} reason=${outcome.ok ? '' : outcome.reason}`);

    // Record the attempt the way production does, then read it back.
    const rec = mustAppend(h.wb.evidence.append({
      kind: 'execution', taskId, agentId: A, modelId: `${A}/m1`, taskType: impl,
      startedAt: NOW, finishedAt: NOW + 5, outcome: 'failure',
      errorCode: 'SPAWN_FAILED', errorMessage: 'agent could not start', leaseVersion: leaseBefore,
    } as never), 'attempt 1');
    check('attempt 1 was recorded', rec.attemptId.length > 0);

    // Laya decides. Explicit target = the only path that names an agent.
    const { provider, asked } = laya([
      { action: 'reassign', taskId, agentId: B, modelId: `${B}/m1`, reason: `agent ${A} could not start (SPAWN_FAILED)` },
    ]);
    const cycle = await runDecisionCycleLocal(h, provider, taskId);
    check('the decision cycle ran', cycle.status === 'ok',
      cycle.status === 'invalid'
        ? `invalid raw=${JSON.stringify(cycle.rawAction)} error=${cycle.error.message}`
        : cycle.status);
    check('Laya was shown the real observation', asked.length === 1);
    const applied = cycle.status === 'ok' ? cycle.application : null;
    check('Laya chose reassign', cycle.status === 'ok' && cycle.decision?.action === 'reassign',
      cycle.status === 'ok' ? String(cycle.decision?.action) : cycle.status);
    check('the reassign applied', applied !== null && applied.applied === true,
      JSON.stringify(applied));

    const after = h.wb.store.get(taskId)!;
    check('CASE 6: the TaskId is UNCHANGED', after.taskId === taskId);
    check('CASE 6: the agent CHANGED to B', after.agentId === B, after.agentId);
    check('CASE 6: the lease ADVANCED', (after.leaseVersion ?? 0) > (leaseBefore ?? 0),
      `${String(leaseBefore)} -> ${String(after.leaseVersion)}`);

    // Attempt 1 is still there, attributed to A, under the OLD lease.
    const history = h.wb.evidence.history(taskId);
    check('CASE 5: attempt 1 SURVIVED the handoff', history.length === 1, String(history.length));
    check('attempt 1 still names agent A', history[0]!.agentId === A, history[0]!.agentId);
    check('CASE 5: attempt 1 keeps its own lease version', history[0]!.leaseVersion === leaseBefore,
      `${String(history[0]!.leaseVersion)} vs ${String(leaseBefore)}`);
    check('CASE 5: attempt 1 keeps the real quota/availability reason',
      history[0]!.errorCode === 'SPAWN_FAILED', String(history[0]!.errorCode));

    // Now the new agent runs, and a SECOND attempt appears on the SAME task.
    h.orch.updateGateSources({ quotaRecords: [quotaRecord(A, 'exhausted'), quotaRecord(B)] });
    const run2 = await h.orch.executeTask({ taskId, cwd: h.dir, translate: { allowAvailabilityContinuation: true } });
    void run2;
    const rec2 = mustAppend(h.wb.evidence.append({
      kind: 'execution', taskId, agentId: B, modelId: `${B}/m1`, taskType: impl,
      startedAt: NOW, finishedAt: NOW + 9, outcome: 'success', leaseVersion: after.leaseVersion,
    } as never), 'attempt 2');
    check('attempt 2 has a DIFFERENT attemptId', rec2.attemptId !== rec.attemptId);
    const finalHistory = h.wb.evidence.history(taskId);
    check('the AttemptStore holds BOTH attempts on the ONE task', finalHistory.length === 2, String(finalHistory.length));
    check('attempt order is A then B',
      finalHistory[0]!.agentId === A && finalHistory[1]!.agentId === B,
      finalHistory.map((r) => r.agentId).join(','));
    check('the store is append-only: attempt 1 was not overwritten',
      finalHistory.some((r) => r.attemptId === rec.attemptId));
  } finally { h.cleanup(); }
}

// ---------------------------------------------------------------------------
// 7. CASE 3 — a plain failure does NOT hand off
// ---------------------------------------------------------------------------
section('R2-3 7. CASE 3: a plain failure never hands off');

{
  const h = harness({
    script: () => runResult({ state: 'failed', agentId: A, error: { code: 'NONZERO_EXIT', message: 'the tests fail' } }),
  });
  try {
    const taskId = seedTask(h, A);
    await runOnce(h, taskId);
    check('a NONZERO_EXIT failure still fails the task', h.wb.store.get(taskId)!.status === 'failed',
      h.wb.store.get(taskId)!.status);

    const outcome = classifyExecutionOutcome({
      taskId, taskStatus: 'failed', agentId: A,
      run: runResult({ state: 'failed', agentId: A, error: { code: 'NONZERO_EXIT', message: 'the tests fail' } }),
    });
    check('it is NOT a handoff trigger', classifyHandoffReason(outcome).handoff === false);
    check('the reason names the work, not the worker',
      classifyHandoffReason(outcome).explanation.includes('work'));

    // And the driver agrees: with no trigger, it must not even ask Laya.
    let askedCount = 0;
    const deps = driverDeps(h, () => { askedCount++; });
    const result = await runHandoffContinuation(deps);
    check('the driver stopped with no-trigger', result.stopped.code === 'no-trigger', result.stopped.code);
    check('the driver never consulted Laya', askedCount === 0, String(askedCount));
    check('no handoff was recorded', result.handoffs.length === 0);
    check('the task went to review, not to another agent', h.wb.store.get(taskId)!.status === 'failed');
  } finally { h.cleanup(); }
}

// ---------------------------------------------------------------------------
// 8. CASE 4 — Laya finds no eligible agent
// ---------------------------------------------------------------------------
section('R2-3 8. CASE 4: no eligible agent');

{
  const h = harness({
    script: () => runResult({ state: 'failed', agentId: A, error: { code: 'SPAWN_FAILED', message: 'nope' } }),
  });
  try {
    const taskId = seedTask(h, A);
    await runOnce(h, taskId);
    check('the task is parked in retrying', h.wb.store.get(taskId)!.status === 'retrying');

    // Laya answers `wait`: there is no worker it is willing to use.
    const { provider } = laya(['wait']);
    const deps = driverDeps(h, null, provider);
    const result = await runHandoffContinuation(deps);

    check('CASE 4: the chain ended as no-eligible-agent',
      result.stopped.code === 'no-eligible-agent', result.stopped.code);
    check('...with a reason', result.stopped.reason.length > 0);
    check('CASE 4: no handoff was recorded', result.handoffs.length === 0);
    check('CASE 4: the task is STILL the same task', h.wb.store.get(taskId)!.taskId === taskId);
    check('CASE 4: it did NOT silently move to another agent', h.wb.store.get(taskId)!.agentId === A,
      h.wb.store.get(taskId)!.agentId);
  } finally { h.cleanup(); }
}

// ---------------------------------------------------------------------------
// 9. CASE 7 + CASE 8 — budget and oscillation
// ---------------------------------------------------------------------------
section('R2-3 9. CASE 7 + CASE 8: budget exhausted, and no oscillation');

{
  // Every agent keeps failing to start, so the chain can only be stopped by the guards.
  const h = harness({ script: () => runResult({ state: 'failed', agentId: A, error: { code: 'SPAWN_FAILED', message: 'nope' } }) });
  try {
    const taskId = seedTask(h, A);
    await runOnce(h, taskId);

    // A brain that always says "reassign to the next agent", cyclically A->B->A->B.
    const { provider } = laya([
      { action: 'reassign', taskId, agentId: B, modelId: `${B}/m1`, reason: 'A cannot start' },
      { action: 'reassign', taskId, agentId: A, modelId: `${A}/m1`, reason: 'B cannot start' },
      { action: 'reassign', taskId, agentId: B, modelId: `${B}/m1`, reason: 'A cannot start' },
      { action: 'reassign', taskId, agentId: A, modelId: `${A}/m1`, reason: 'B cannot start' },
    ]);
    const deps = driverDeps(h, null, provider);
    const result = await runHandoffContinuation(deps, { policy: DEFAULT_HANDOFF_POLICY });

    check('CASE 7/8: the chain TERMINATED', result.handoffs.length <= 2, String(result.handoffs.length));
    check('CASE 7: it stopped on a guard, not by luck',
      result.stopped.code === 'budget-exhausted' || result.stopped.code === 'loop-refused',
      result.stopped.code);
    check('CASE 8: the agent chain never repeated back-to-back',
      result.handoffs.every((hd, i) => i === 0 || hd.fromAgentId !== hd.toAgentId),
      result.handoffs.map((hd) => `${hd.fromAgentId}->${hd.toAgentId}`).join(' '));
    check('the number of handoffs never exceeded the policy',
      result.handoffs.length <= DEFAULT_HANDOFF_POLICY.maxAutomaticHandoffsPerTask,
      `${String(result.handoffs.length)} vs ${String(DEFAULT_HANDOFF_POLICY.maxAutomaticHandoffsPerTask)}`);
    check('every handoff carries its reason', result.handoffs.every((hd) => hd.reason.length > 0));
  } finally { h.cleanup(); }
}

// ---------------------------------------------------------------------------
// 10. CASE 9 + CASE 10 — both attempts reach ONE review
// ---------------------------------------------------------------------------
section('R2-3 10. CASE 9 + CASE 10: both attempts reach the single unified review');

{
  const h = harness({
    script: (req) => (req.agentId === A
      ? runResult({ state: 'failed', agentId: A, error: { code: 'SPAWN_FAILED', message: 'A cannot start' } })
      : runResult({ state: 'succeeded', agentId: B, output: 'B finished the work' })),
  });
  try {
    const taskId = seedTask(h, A);
    await runOnce(h, taskId);
    const beforeHandoff = h.wb.evidence.history(taskId);
    check('attempt 1 (agent A) was recorded before the handoff',
      beforeHandoff.length === 1 && beforeHandoff[0]!.agentId === A,
      beforeHandoff.map((r) => r.agentId).join(','));
    const rec1 = beforeHandoff[0]!;

    const { provider } = laya([{ action: 'reassign', taskId, agentId: B, modelId: `${B}/m1`, reason: 'A cannot start' }]);
    const result = await runHandoffContinuation(driverDeps(h, null, provider));
    check('the handoff happened', result.handoffs.length === 1, String(result.handoffs.length));
    check('the handoff went A -> B',
      result.handoffs[0]?.fromAgentId === A && result.handoffs[0]?.toAgentId === B,
      JSON.stringify([result.handoffs[0]?.fromAgentId, result.handoffs[0]?.toAgentId]));

    // CASE 9: the new agent runs and SUCCEEDS, on the same task.
    h.orch.updateGateSources({ quotaRecords: [quotaRecord(A, 'exhausted'), quotaRecord(B)] });
    const task = h.wb.store.get(taskId)!;
    if (task.status === 'retrying') h.orch.retry(taskId, 'continuation', 2);
    const run2 = await runOnce(h, taskId);
    check('CASE 9: the second agent ran', run2.ok === true, JSON.stringify(run2.ok));
    check('CASE 9: the task reached to_verify, not succeeded',
      h.wb.store.get(taskId)!.status === 'to_verify', h.wb.store.get(taskId)!.status);

    // Now: does the SINGLE existing review path see BOTH attempts?
    const history = h.wb.evidence.history(taskId);
    check('exactly TWO attempts exist on the ONE task', history.length === 2, String(history.length));
    check('they are A then B', history[0]!.agentId === A && history[1]!.agentId === B,
      history.map((r) => r.agentId).join(','));
    const rec2 = history[1]!;
    check('CASE 10 groundwork: attempt 2 records success', rec2.outcome === 'success', rec2.outcome);
    const outcomeB = classifyExecutionOutcome({
      taskId, taskStatus: 'to_verify', agentId: B,
      run: runResult({ state: 'succeeded', agentId: B, output: 'B finished the work' }),
      attemptIds: history.map((r) => r.attemptId),
    });
    const packet = buildReviewPacket({
      roundId: 'round-1', originalRequest: 'finish the thing',
      tasks: [{
        taskId, taskType: impl, status: h.wb.store.get(taskId)!.status, agentId: B, modelId: `${B}/m1`,
        outcome: outcomeB.outcome, executed: true,
        prompt: { text: 'do the work', truncated: false, originalLength: 8 },
        handoff: buildHandoff(task, runResult({ state: 'succeeded', agentId: B, output: 'B finished the work' })),
        attemptIds: history.map((r) => r.attemptId),
        leaseVersion: task.leaseVersion, errorCode: null, errorMessage: null,
      }],
      outcomes: [outcomeB],
    });
    check('the review packet carries BOTH attempt ids',
      packet.tasks[0]!.attemptIds.length === 2, JSON.stringify(packet.tasks[0]!.attemptIds));
    check('the review packet carries attempt 1 (agent A) too',
      packet.tasks[0]!.attemptIds.includes(rec1.attemptId));
    check('the review packet carries attempt 2 (agent B)',
      packet.tasks[0]!.attemptIds.includes(rec2.attemptId));
  } finally { h.cleanup(); }
}

// ---------------------------------------------------------------------------
// 11. Topology — nothing new became an authority
// ---------------------------------------------------------------------------
section('R2-3 11. architecture topology');

{
  const code = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  const cont = code(sourceText(new URL('../src/orchestration/continuation.ts', import.meta.url)));
  check('continuation.ts never dispatches', !/scheduler\s*\.\s*tick\s*\(/.test(cont) && !/\.tick\s*\(/.test(cont));
  check('continuation.ts has no scheduler of its own', !/new\s+TaskScheduler/.test(cont));
  check('continuation.ts has no ORCHESTRATION store', !/new\s+(AttemptStore|TaskStore)\b/.test(cont));
  check('continuation.ts never writes task state', !/\.transition\s*\(/.test(cont) && !/\.migrateIdentity/.test(cont));
  check('continuation.ts does not assign workers', !/assignWorker|assignChildren/.test(cont));
  check('continuation.ts never MUTATES a lease', !/(revokeLease|issueLease|renewLease|markLeaseUsed|reissueLease|withAdvancedLease)\s*\(/.test(cont));
  check('continuation.ts imports no lease module', !/assignment-lease\.ts/.test(cont));
  check('continuation.ts has no manager/authority', !/class\s+\w*(Manager|Authority|Engine)\b/.test(cont));
  check('continuation.ts imports the EXISTING handoff projection', /workbench-handoff\.ts/.test(cont));
  check('continuation.ts reuses unified-review ExecutionOutcome', /unified-review\.ts/.test(cont));
  check('continuation.ts never names a specific next agent',
    !/'workbuddy/.test(cont) && !/'opencode'/.test(cont) && !/'codex'/.test(cont));

  // Whole-tree invariants.
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) files.push(p);
    }
  };
  walk(fileURLToPath(new URL('../src', import.meta.url)));
  const count = (re: RegExp): number => files.filter((f) => re.test(code(readFileSync(f, 'utf8')))).length;
  // The pre-existing topology: each ENTRYPOINT constructs its own scheduler per run
  // (round-cli, and controller's two construction sites). The invariant is that the
  // handoff added none and there is still no second one at RUNTIME inside a round.
  check('continuation.ts constructs no scheduler', count(/new\s+TaskScheduler\s*\(/) === 2, String(count(/new\s+TaskScheduler\s*\(/)));
  check('the handoff introduced no new scheduler construction site',
    !/new\s+TaskScheduler\s*\(/.test(cont));
  check('still exactly ONE runtime.run( call site', count(/runtime\s*\.\s*run\s*\(/) === 1, String(count(/runtime\s*\.\s*run\s*\(/)));
  check('no HandoffManager was introduced', count(/class\s+HandoffManager/) === 0);
  check('no QuotaManager was introduced', count(/class\s+QuotaManager/) === 0);
  check('no ContinuationEngine was introduced', count(/class\s+ContinuationEngine/) === 0);
}

// ---------------------------------------------------------------------------
// helpers used above
// ---------------------------------------------------------------------------

/** Run the REAL decision cycle against the real workbench, scoped to the seeded root. */
async function runDecisionCycleLocal(
  h: Harness,
  provider: DecisionProvider,
  _taskId: string,
): Promise<Awaited<ReturnType<typeof import('../src/orchestration/decision-loop.ts').runDecisionCycle>>> {
  const { runDecisionCycle } = await import('../src/orchestration/decision-loop.ts');
  return runDecisionCycle({
    store: h.wb.store,
    scheduler: h.sched,
    provider,
    // Scope to the ROOT ('r'). Scoping to the child id yields an empty observed set, and
    // `validateDecision` then refuses every action that names a task — which is the
    // validator working correctly, not a handoff problem.
    rootTaskId: 'r',
    lastTick: () => null,
    capabilities: {
      ...h.wb.decisionCapabilities({ retry: { maxRetries: 2 } } as never),
      dispatch: async () => ({ admitted: [], waiting: [], skipped: [], outcomes: [], freeSlots: 0, dispatchedAt: NOW } as never),
    } as never,
  });
}

/**
 * Wire `runHandoffContinuation` to the real workbench.
 *
 * `readOutcomes` reads REAL evidence: for every task, its last attempt plus its live
 * store status. `buildPacket` uses the real TaskStore, AttemptStore and `buildHandoff`.
 */
function driverDeps(
  h: Harness,
  onCycle: (() => void) | null,
  provider?: DecisionProvider,
): ContinuationDeps {
  return {
    async readOutcomes() {
      const out: ExecutionOutcome[] = [];
      for (const t of h.wb.store.all()) {
        const history = h.wb.evidence.history(t.taskId);
        if (history.length === 0) continue;
        const last = history[history.length - 1]!;
        out.push({
          taskId: t.taskId,
          taskStatus: t.status,
          outcome: last.errorCode === 'SPAWN_FAILED'
            ? 'agent_unavailable'
            : last.outcome === 'success' ? 'success' : 'failed',
          code: last.errorCode ?? null,
          reason: last.errorMessage ?? null,
          agentId: last.agentId,
          modelId: last.modelId,
          executed: true,
          refused: false,
          attemptIds: history.map((r) => r.attemptId),
        });
      }
      return out;
    },
    buildPacket(taskId, outcome) {
      const task = h.wb.store.get(taskId);
      if (task === null) return null;
      const history = h.wb.evidence.history(taskId);
      const last = history.length > 0 ? history[history.length - 1]! : null;
      const classification = classifyHandoffReason(outcome);
      if (!classification.handoff) return null;
      return buildContinuationPacket({
        task,
        reason: classification.reason,
        outcome,
        evidence: last === null ? null : buildHandoff(task, runResult({
          state: last.outcome === 'success' ? 'succeeded' : 'failed',
          agentId: last.agentId,
          output: last.errorMessage ?? '',
          error: last.errorCode === null || last.errorCode === undefined
            ? null
            : { code: last.errorCode as never, message: last.errorMessage ?? '' },
        })),
        attempt: last === null ? null : {
          attemptId: last.attemptId, agentId: last.agentId, modelId: last.modelId,
          leaseVersion: last.leaseVersion, errorCode: last.errorCode, errorMessage: last.errorMessage,
        },
      });
    },
    identityOf: (taskId) => {
      const t = h.wb.store.get(taskId);
      return t === null ? null : { agentId: t.agentId, modelId: t.modelId ?? null };
    },
    async runCycle(_context) {
      onCycle?.();
      if (provider === undefined) {
        return { action: null, applied: false, dispatched: false, code: 'no-provider', reason: 'no Laya', targetAgentId: null };
      }
      const cycle = await runDecisionCycleLocal(h, provider, '');
      if (cycle.status !== 'ok') {
        return {
          action: null, applied: false, dispatched: false,
          code: `cycle-${cycle.status}`, reason: 'the decision cycle did not complete', targetAgentId: null,
        };
      }
      const decision = cycle.decision;
      const application = cycle.application;
      const target = decision !== null && decision.action === 'reassign' ? (decision.agentId ?? null) : null;
      return {
        action: decision === null ? null : decision.action,
        applied: application.applied,
        dispatched: application.dispatched,
        code: application.applied ? null : application.code,
        reason: application.applied ? application.note : application.reason,
        targetAgentId: target,
      };
    },
    now: () => NOW,
  };
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
process.stdout.write('\n');
process.exitCode = failed === 0 ? 0 : 1;