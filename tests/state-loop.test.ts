/**
 * tests/state-loop.test.ts - P6-A: the orchestration state loop.
 *
 * WHAT IS ACTUALLY UNDER TEST
 * ---------------------------
 * The audit's finding was that the loop did not exist (CURRENT_STATE_AUDIT.md §7):
 * `src/orchestration/*` had zero imports of `src/decision/`, so nothing ever asked
 * the decision brain anything and nothing it said could influence a tick. P6-A
 * closes that gap, and these tests exist to hold it closed.
 *
 * A pure-function test of `validateDecision` would prove almost nothing here. The
 * properties that matter are structural:
 *
 *   - the observation reflects the REAL TaskStore, not a hand-built fixture
 *   - a `continue` decision reaches work THROUGH `TaskScheduler.tick()`
 *   - a `wait` / `abort` decision dispatches nothing at all
 *   - an invalid decision produces ZERO side effects - no tick, no task change
 *   - an unimplemented action is refused, never quietly downgraded to `continue`
 *   - the decision brain holds no reference to the runtime, so it cannot spawn
 *
 * So the loop tests build a real `Orchestrator` + real `TaskStore` + real
 * `TaskScheduler` with a fake agent process, and drive `runDecisionCycle`. The
 * only doubles are the decision provider (Laya is an external HTTP service and
 * must not be required to run a unit test) and the runtime process.
 */

import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Orchestrator } from '../src/orchestration/orchestrator.ts';
import { TaskStore } from '../src/orchestration/store.ts';
import { TaskScheduler } from '../src/orchestration/scheduler.ts';
import { OrchestrationController } from '../src/orchestration/controller.ts';
import { observeTasks, toDecisionState } from '../src/orchestration/observation.ts';
import {
  validateDecision,
  applyDecision,
  DecisionValidationError,
  isDecisionValidationError,
  IMPLEMENTED_ACTIONS,
  DEFERRED_ACTIONS,
  ALL_ACTIONS,
} from '../src/orchestration/decision.ts';
import {
  runDecisionCycle,
  orchestrationDecisionRequest,
  extractAction,
} from '../src/orchestration/decision-loop.ts';
import type { AcceptanceMaterial } from '../src/orchestration/decision-loop.ts';
import { createLayaDecisionProvider } from '../src/decision/laya.ts';
import {
  buildDispatchReceipt,
  emptyDispatchReceipt,
  type DispatchReceipt,
} from '../src/orchestration/dispatch-receipt.ts';
import { ModelRegistry } from '../src/quota/registry.ts';
import { BudgetManager } from '../src/quota/budget.ts';
import { DecisionSchemaError, DecisionUnavailableError } from '../src/decision/errors.ts';
import { toProbability } from '../src/decision/types.ts';
import type {
  DecisionAnswer,
  DecisionProbe,
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
} from '../src/decision/types.ts';
import type { QuotaRecord, TaskType } from '../src/quota/types.ts';
import type { AgentDescriptor, RunHandle, RunRequest, RunResult } from '../src/core/types.ts';
import type { RuntimeRunner } from '../src/orchestration/execute.ts';
import { sourceText } from './helpers.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` -${detail}` : ''}`);
    process.stdout.write(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}\n`);
  }
}

function section(title: string): void {
  process.stdout.write(`\n== ${title} ==\n`);
}

const NOW = 1_700_000_000_000;
const now = () => NOW;
const AGENT = 'opencode';
const SB = 'opencode/space-bunny-free';
const impl: TaskType = 'implementation';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const descriptor = (id: string): AgentDescriptor => ({
  id, displayName: id, launcher: { command: 'x', args: [], shell: false } as never,
  transport: 'cli-jsonl',
  capabilities: {
    newTask: true, resume: true, review: false, modelSelection: true, roleSelection: true,
    sandbox: false, streamEvents: true, costReporting: false, extraArgs: true, cwd: true,
    skills: false,
    steering: false, worktree: false, fork: false, stdinPrompt: false, workspaceModes: ['shared'],
  } as AgentDescriptor['capabilities'],
});

const statusRow = (agent: string, installed: string) => ({
  agent, version: '1.0.0', installed, login: 'n/a', quotaSource: 'test', usage: 'n/a', status: 'ok',
});

const quotaRecord = (agentId: string, status: QuotaRecord['status']): QuotaRecord => ({
  provider: agentId, agentId, modelId: null, source: 'locally_observed',
  usage: null, remaining: null, resetAt: null, period: 'day', status,
  usageClass: 'observed', confidence: 'high', observedAt: NOW, note: '',
});

const registryWith = (
  entries: Array<[string, string, string[], 'available' | 'unknown' | 'unavailable']>,
): ModelRegistry => {
  const reg = new ModelRegistry();
  for (const [agentId, modelId, taskTypes, availability] of entries) {
    reg.upsert(
      { agentId, modelId, provider: 'test', taskTypes: taskTypes as never, modelSource: 'test', quotaSource: 'test' },
      NOW,
    );
    reg.setAgentAvailability(agentId, availability);
  }
  return reg;
};

/** Real budget scopes for the ids these tests use, so no denial is a fixture gap. */
const budgetsFor = (taskIds: readonly string[], agents: readonly string[] = [AGENT]): BudgetManager => {
  const m = new BudgetManager(100_000);
  for (const t of taskIds) m.task(t, 10_000);
  for (const a of agents) m.agent(a, 10_000);
  return m;
};

/** Every pre-existing gate signal healthy, so a refusal can only be the loop's doing. */
const gateSources = (taskIds: readonly string[], over: Record<string, unknown> = {}) => ({
  descriptors: [descriptor(AGENT)],
  agentStatus: [statusRow(AGENT, 'Yes')],
  quotaRecords: [quotaRecord(AGENT, 'available')],
  registry: registryWith([[AGENT, SB, ['implementation', 'research', 'test'], 'available']]),
  budgets: budgetsFor(taskIds),
  taskType: impl,
  requestedUnits: 100,
  currentConcurrency: 0,
  maxConcurrency: 4,
  maxChildren: 8,
  maxConcurrentAgents: 4,
  ...over,
}) as never;

interface Recorded { req: RunRequest }

/**
 * A runtime that records every request and answers with a scripted state.
 *
 * Counts invocations, which is how "wait dispatches nothing" is proved: if the
 * brain could reach the runtime, this counter would move.
 */
function fakeRuntime(state: 'succeeded' | 'failed' = 'succeeded'): { runtime: RuntimeRunner; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const runtime: RuntimeRunner = {
    run(req: RunRequest): RunHandle {
      requests.push({ req });
      const result = {
        taskId: 'rt-1', agentId: req.agentId, state, error: state === 'failed'
          ? { code: 'NONZERO_EXIT', message: 'scripted failure' } : null,
        startedAt: 0, endedAt: 1, exitCode: state === 'failed' ? 7 : 0, signal: null,
        output: '', outputTruncated: false, transcriptPath: null,
        usage: null, toolCalls: [], diagnostics: [], cleanup: { rootKilled: false, descendantsReaped: false, note: '' },
      } as unknown as RunResult;
      return { result: async () => result, cancel: async () => {}, dispose: async () => {} } as unknown as RunHandle;
    },
  };
  return { runtime, requests };
}

/**
 * A DecisionProvider double.
 *
 * Stands in for Laya, which is an external HTTP service and cannot be required to
 * run a unit test. It implements the real `DecisionProvider` interface and returns
 * answers in the real `DecisionAnswer` shape, so the loop exercises the same
 * contract production would. `raw` is the escape hatch for the "provider returned
 * something unusable" cases.
 */
function providerAnswering(
  choice: string | null,
  opts: { throwOnDecide?: Error; omitAnswer?: boolean; answerType?: string } = {},
): DecisionProvider & { calls: DecisionRequest[] } {
  const calls: DecisionRequest[] = [];
  return {
    name: 'test-brain',
    calls,
    probe: async (): Promise<DecisionProbe> => ({ ok: true, endpoint: 'test', detail: 'double', warnings: [] }),
    decide: async (request: DecisionRequest): Promise<DecisionResponse> => {
      calls.push(request);
      if (opts.throwOnDecide !== undefined) throw opts.throwOnDecide;
      const conf = toProbability(0.9)!;
      const answer: DecisionAnswer = (opts.answerType ?? 'choice') === 'choice'
        ? { type: 'choice', choice: choice ?? 'continue', probabilities: { continue: 0.9, wait: 0.05, abort: 0.05 }, confidence: conf, criteria: { continue: 'c', wait: 'w', abort: 'a' } }
        : { type: 'score', score: 1, level: 'x', levels: ['x'], probabilities: { x: 0.9 }, confidence: conf };
      const answers: DecisionResponse['answers'] = opts.omitAnswer === true ? {} : { next_action: answer };
      return {
        answers,
        provider: { name: 'test-brain', model: 'double', elapsedMs: 1, details: {} },
        raw: {},
      };
    },
  };
}

const tmpDir = (): string => mkdtempSync(join(tmpdir(), 'p6a-loop-'));

/** Root + `n` pool-model children, ready to dispatch. */
function seed(o: Orchestrator, ids: readonly string[]): void {
  o.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' });
  for (const id of ids) {
    o.spawnChild({
      taskId: id, parentTaskId: 'r', agentId: AGENT, modelId: SB,
      taskType: impl, acceptanceCriteria: 'do the work', budgetUnits: 10,
    });
  }
}

// ---------------------------------------------------------------------------
// 1. Observation is a faithful view of the real store
// ---------------------------------------------------------------------------
section('P6-A 1. observation maps real TaskStore state (no hand-built fixture)');
{
  const dir = tmpDir();
  const { runtime, requests } = fakeRuntime();
  const o = new Orchestrator({ gate: gateSources(['r', 'c1', 'c2']), now, runtime, defaultCwd: dir });
  seed(o, ['c1', 'c2']);
  const store = o.getStore();

  const obs = observeTasks(store, { now: NOW });
  check('every task appears, root included', obs.tasks.length === 3, `got ${obs.tasks.length}`);
  check('planned children are READY when their dependencies are met',
    obs.ready.includes('c1') && obs.ready.includes('c2'), JSON.stringify(obs.ready));
  check('nothing is running before a tick', obs.running.length === 0);
  check('nothing is blocked before a tick', obs.blocked.length === 0);
  check('nothing is terminal while all work is planned', obs.allTerminal === false);
  check('the observation is frozen (a snapshot, not a live handle)', Object.isFrozen(obs) && Object.isFrozen(obs.tasks));
  check('the derived state block is populated from the store', obs.tasks.every((t) => t.status === 'planned'));
  check('verification is not due while the task has not run',
    obs.tasks.filter((t) => t.depth === 1).every((t) => t.verification === 'not-due'));

  // run one child for real, through the scheduler
  const scheduler = new TaskScheduler({ orchestrator: o, cwd: dir });
  const tick = await scheduler.tick();
  check('the scheduler really dispatched the ready children', tick.admitted.length === 2, JSON.stringify(tick.admitted));
  check('the runtime was actually asked to run them', requests.length === 2, `ran ${requests.length}`);

  const after = observeTasks(store, { now: NOW });
  check('a successful run lands in to_verify, never succeeded',
    after.tasks.filter((t) => t.depth === 1).every((t) => t.status === 'to_verify'),
    JSON.stringify(after.tasks.map((t) => `${t.taskId}:${t.status}`)));
  check('to_verify tasks are reported as awaiting verification',
    after.awaitingVerification.length === 2, JSON.stringify(after.awaitingVerification));
  check('verification reads as pending before anything judges it',
    after.tasks.filter((t) => t.depth === 1).every((t) => t.verification === 'pending'));
  check('nothing is ready or running any more', after.ready.length === 0 && after.running.length === 0);
  check('still not all terminal: to_verify is not terminal', after.allTerminal === false);

  // verification flows through the ONE existing entry point
  const v = o.applyVerification('c1', { verdict: 'pass', reason: 'criteria met' });
  check('applyVerification is the route into succeeded', v.ok && store.get('c1')?.status === 'succeeded');
  const judged = observeTasks(store, { now: NOW });
  check('a passed task reads as verification passed',
    judged.tasks.find((t) => t.taskId === 'c1')?.verification === 'passed');
  check('and is now terminal', judged.terminal.includes('c1'));

  const rej = o.applyVerification('c2', { verdict: 'reject', reason: 'did not meet criteria' });
  check('a rejected verification is applied through the same entry point', rej.ok);
  check('a rejected task reads as verification rejected',
    observeTasks(store, { now: NOW }).tasks.find((t) => t.taskId === 'c2')?.verification === 'rejected');

  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 2. Observation maps dependency state with the SAME helper the scheduler uses
// ---------------------------------------------------------------------------
section('P6-A 2. dependency state matches the scheduler readiness definition');
{
  const dir = tmpDir();
  const { runtime } = fakeRuntime();
  const o = new Orchestrator({ gate: gateSources(['r', 'c1', 'c2']), now, runtime, defaultCwd: dir });
  o.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' });
  o.spawnChild({ taskId: 'c1', parentTaskId: 'r', agentId: AGENT, modelId: SB, taskType: impl, acceptanceCriteria: 'upstream', budgetUnits: 10 });
  // c2 depends on c1, so it is planned but NOT ready.
  o.spawnChild({
    taskId: 'c2', parentTaskId: 'r', agentId: AGENT, modelId: SB, taskType: impl,
    acceptanceCriteria: 'downstream', budgetUnits: 10, dependencies: ['c1'],
    allowUnmetDependencies: true,
  });

  const obs = observeTasks(o.getStore(), { now: NOW });
  const c2 = obs.tasks.find((t) => t.taskId === 'c2');
  check('the dependant records its unmet dependency', c2?.unmetDependencies.includes('c1') === true,
    JSON.stringify(c2?.unmetDependencies));
  check('a planned task with an unmet dependency is NOT ready', !obs.ready.includes('c2'));
  check('the independent task IS ready', obs.ready.includes('c1'));

  // The observation and the scheduler must agree, or a decision is made on one
  // definition of "ready" and dispatch uses another.
  const scheduler = new TaskScheduler({ orchestrator: o, cwd: dir });
  const tick = await scheduler.tick();
  check('the scheduler agrees: only c1 was admitted',
    tick.admitted.length === 1 && tick.admitted[0] === 'c1', JSON.stringify(tick.admitted));
  check('the scheduler skips c2 for the same reason the observation gives',
    tick.skipped.some((s) => s.taskId === 'c2' && s.code === 'dependency-unmet'),
    JSON.stringify(tick.skipped));

  // c1 has RUN but not SUCCEEDED: only `applyVerification` can make it succeeded,
  // and only `succeeded` satisfies a dependency. So c2 must still be waiting -  // this is the distinction that keeps "ran" and "done" from being conflated.
  const ranOnly = observeTasks(o.getStore(), { now: NOW });
  check('a task that merely ran (to_verify) does NOT satisfy a dependency',
    !ranOnly.ready.includes('c2'), JSON.stringify(ranOnly.ready));
  check('and c1 is awaiting verification, not terminal',
    ranOnly.awaitingVerification.includes('c1') && !ranOnly.terminal.includes('c1'));

  o.applyVerification('c1', { verdict: 'pass', reason: 'criteria met' });
  const obs2 = observeTasks(o.getStore(), { now: NOW });
  check('after c1 is verified succeeded, c2 becomes ready',
    obs2.ready.includes('c2') && obs2.terminal.includes('c1'),
    JSON.stringify(obs2.ready));

  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 3. Observation maps the latest result, without becoming a status source
// ---------------------------------------------------------------------------
section('P6-A 3. latest result maps in, and is never a status source');
{
  const store = new TaskStore();
  store.create({ taskId: 'r', parentTaskId: null, agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' }, NOW);
  store.create({ taskId: 'c1', parentTaskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'work' }, NOW);

  const noResults = observeTasks(store, { now: NOW });
  check('with no results supplied there is no failure to report', noResults.latestFailure === null);
  check('and no task is listed as failed', noResults.failedTaskIds.length === 0);

  // The store is still planned; only a RESULT was supplied. If results could set
  // status, the task would read as failed here - it must not.
  const failed = {
    taskId: 'rt', agentId: AGENT, state: 'failed', error: { code: 'NONZERO_EXIT', message: 'boom' },
    startedAt: 10, endedAt: 20, exitCode: 7, signal: null, output: '', outputTruncated: false,
    transcriptPath: null, usage: null, toolCalls: [], diagnostics: [],
    cleanup: { rootKilled: false, descendantsReaped: false, note: '' },
  } as unknown as RunResult;

  const withResult = observeTasks(store, { now: NOW, results: new Map([['c1', failed]]) });
  check('a failed result is reported as the latest failure', withResult.latestFailure?.state === 'failed');
  check('the failure carries its error code', withResult.latestFailure?.errorCode === 'NONZERO_EXIT',
    String(withResult.latestFailure?.errorCode));
  check('the failed task is listed', withResult.failedTaskIds.includes('c1'));
  check('CRITICAL: a supplied result does NOT change task status',
    withResult.tasks.find((t) => t.taskId === 'c1')?.status === 'planned',
    withResult.tasks.find((t) => t.taskId === 'c1')?.status);
  check('and the store itself is untouched', store.get('c1')?.status === 'planned');

  // "reported no cost" and "cost was zero" are different claims.
  const noCost = { ...failed, state: 'succeeded', error: null, usage: null } as unknown as RunResult;
  const costed = { ...failed, state: 'succeeded', error: null, usage: { costUsd: 0 } } as unknown as RunResult;
  const obsNoCost = observeTasks(store, { now: NOW, results: new Map([['c1', noCost]]) });
  const obsZero = observeTasks(store, { now: NOW, results: new Map([['c1', costed]]) });
  // A succeeded run is not a failure, so it populates neither field. The point
  // being asserted is that supplying a result never MOVES task status.
  check('a succeeded result is not reported as a failure',
    obsNoCost.latestFailure === null && obsNoCost.failedTaskIds.length === 0);
  check('and a succeeded result still leaves status alone',
    obsZero.tasks.find((t) => t.taskId === 'c1')?.status === 'planned' &&
    obsNoCost.tasks.find((t) => t.taskId === 'c1')?.status === 'planned');
}

// ---------------------------------------------------------------------------
// 4. The observation serializes for the decision brain
// ---------------------------------------------------------------------------
section('P6-A 4. the observation is serializable for a decision provider');
{
  const store = new TaskStore();
  store.create({ taskId: 'r', parentTaskId: null, agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' }, NOW);
  store.create({ taskId: 'c1', parentTaskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'work' }, NOW);
  const obs = observeTasks(store, { now: NOW });

  const state = toDecisionState(obs);
  check('it serializes to a JSON string', typeof state === 'string');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(state) as Record<string, unknown>;
    check('and parses back', true);
  } catch {
    check('and parses back', false, state.slice(0, 120));
    parsed = {};
  }
  check('it carries the ready set', Array.isArray(parsed.ready));
  check('it carries per-task facts', Array.isArray(parsed.tasks) && (parsed.tasks as unknown[]).length === 2);
  check('it does NOT carry a transcript or file contents',
    !state.includes('transcript') && !state.includes('output'));
  check('it does NOT carry a capability profile (P6-B owns that)',
    !state.includes('capabilities'));
  check('the request puts the observation under the action question',
    Object.keys(orchestrationDecisionRequest(obs).questions).length === 1 &&
    'next_action' in (orchestrationDecisionRequest(obs).questions as Record<string, unknown>));
}

// ---------------------------------------------------------------------------
// 5. Validator: the three implemented actions
// ---------------------------------------------------------------------------
section('P6-A 5. validator accepts exactly the implemented actions');
{
  const store = new TaskStore();
  store.create({ taskId: 'r', parentTaskId: null, agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' }, NOW);
  store.create({ taskId: 'c1', parentTaskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'work' }, NOW);
  const obs = observeTasks(store, { now: NOW });

  const cont = validateDecision({ action: 'continue' }, obs);
  check('valid continue is accepted', cont.action === 'continue');
  const contWithWhy = validateDecision({ action: 'continue', rationale: 'c1 is ready' }, obs);
  check('continue keeps its rationale', contWithWhy.action === 'continue' && contWithWhy.rationale === 'c1 is ready');
  const wait = validateDecision({ action: 'wait', rationale: 'nothing ready' }, obs);
  check('valid wait is accepted', wait.action === 'wait');
  const abort = validateDecision({ action: 'abort', reason: 'caller cancelled the cycle' }, obs);
  check('valid abort is accepted', abort.action === 'abort');
  // The bare action must be complete on its own. If abort required prose, the
  // provider (which can only return the choice it was offered) could never
  // produce a valid one - and a real abort would be unrepresentable.
  const bareAbort = validateDecision({ action: 'abort' }, obs);
  check('a bare abort is accepted (no prose required of the model)', bareAbort.action === 'abort');
  const scoped = validateDecision({ action: 'continue', taskId: 'c1' }, obs);
  check('an action may name a task that exists', scoped.action === 'continue');

// `rework` came from P6-D0, `replan` from P6-C, and the remaining six from P6-D1,
  // each by the stage that owned it. P6-D1 connected the last six to EXISTING
  // authorities, so nothing is deferred any more - which is why this now asserts
  // that the vocabulary is COMPLETE rather than that something is missing.
  check('the implemented set is every action in the vocabulary',
      IMPLEMENTED_ACTIONS.length === 11 &&
      IMPLEMENTED_ACTIONS.join(',') === ALL_ACTIONS.join(','),
      IMPLEMENTED_ACTIONS.join(','));
  check('the full vocabulary is frozen at eleven actions', ALL_ACTIONS.length === 11, String(ALL_ACTIONS.length));
  check('P6-D1 left NOTHING deferred', DEFERRED_ACTIONS.length === 0, DEFERRED_ACTIONS.join(','));
  check('implemented and deferred partition the vocabulary exactly',
      [...IMPLEMENTED_ACTIONS, ...DEFERRED_ACTIONS].sort().join(',') === [...ALL_ACTIONS].sort().join(','));
  check('the six D1 actions are all present',
      ['retry', 'reassign', 'add_task', 'split_task', 'parallelize', 'complete']
        .every((a) => (IMPLEMENTED_ACTIONS as readonly string[]).includes(a)));
  }

// ---------------------------------------------------------------------------
// 6. Validator: everything else is refused, loudly
// ---------------------------------------------------------------------------
section('P6-A 6. validator refuses everything else (fail-closed)');
{
  const store = new TaskStore();
  store.create({ taskId: 'r', parentTaskId: null, agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' }, NOW);
  store.create({ taskId: 'c1', parentTaskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'work' }, NOW);
  const obs = observeTasks(store, { now: NOW });

  // Capture the code rather than just "it threw": the reason is the point.
  const codeOf = (raw: unknown): string => {
    try {
      validateDecision(raw, obs);
      return '<no error thrown>';
    } catch (e) {
      return isDecisionValidationError(e) ? e.code : `<wrong error type: ${String(e)}>`;
    }
  };

  check('an unknown action is refused', codeOf({ action: 'teleport' }) === 'unknown-action', codeOf({ action: 'teleport' }));
  check('a missing action is refused', codeOf({}) === 'malformed-decision', codeOf({}));
  check('a non-object decision is refused', codeOf(null) === 'malformed-decision', codeOf(null));
  check('an array is refused as malformed, not treated as a decision', codeOf([{ action: 'continue' }]) === 'malformed-decision');
  check('a non-string action is refused', codeOf({ action: 42 }) === 'malformed-decision');
  check('an abort whose reason is not a string is refused',
    codeOf({ action: 'abort', reason: 12 }) === 'malformed-decision', codeOf({ action: 'abort', reason: 12 }));
  check('an abort with a blank reason is accepted (and the reason dropped)',
    codeOf({ action: 'abort', reason: '  ' }) === '<no error thrown>', codeOf({ action: 'abort', reason: '  ' }));
  check('a non-string rationale is refused', codeOf({ action: 'wait', rationale: { text: 'do a thing' } }) === 'malformed-decision');
  check('an invalid task id (empty) is refused', codeOf({ action: 'continue', taskId: '' }) === 'invalid-task-id');
  check('an invalid task id (number) is refused', codeOf({ action: 'continue', taskId: 7 }) === 'invalid-task-id');
  check('a task that does not exist is refused', codeOf({ action: 'continue', taskId: 'ghost' }) === 'task-not-found',
    codeOf({ action: 'continue', taskId: 'ghost' }));

  // Every deferred action must be refused as not-implemented, and NONE may pass.
  for (const action of DEFERRED_ACTIONS) {
    check(`"${action}" is recognised but not implemented`, codeOf({ action }) === 'action-not-implemented', codeOf({ action }));
  }
  check('no deferred action is silently accepted', DEFERRED_ACTIONS.every((a) => codeOf({ action: a }) !== '<no error thrown>'));
  check('no deferred action is downgraded to continue',
    DEFERRED_ACTIONS.every((a) => {
      try { validateDecision({ action: a }, obs); return false; } catch { return true; }
    }));

  // State transition: a terminal task cannot be the target of a decision.
  store.transition('c1', 'queued', NOW);
  store.transition('c1', 'running', NOW);
  store.transition('c1', 'to_verify', NOW);
  store.transition('c1', 'succeeded', NOW);
  const afterSuccess = observeTasks(store, { now: NOW });
  // `codeOf` closes over `obs`, which is the PRE-transition snapshot. Re-read the
  // store so the check runs against the state it claims to be testing.
  const codeAfterSuccess = (raw: unknown): string => {
    const fresh = observeTasks(store, { now: NOW });
    try {
      validateDecision(raw, fresh);
      return '<no error thrown>';
    } catch (e) {
      return isDecisionValidationError(e) ? e.code : `<wrong error type: ${String(e)}>`;
    }
  };
  check('the terminal task really is terminal before the check runs',
    store.get('c1')?.status === 'succeeded', String(store.get('c1')?.status));
  check('a decision targeting a terminal task is refused (continue)',
    codeAfterSuccess({ action: 'continue', taskId: 'c1' }) === 'invalid-state-transition',
    codeAfterSuccess({ action: 'continue', taskId: 'c1' }));
  check('a decision targeting a terminal task is refused (abort)',
    codeAfterSuccess({ action: 'abort', taskId: 'c1' }) === 'invalid-state-transition',
    codeAfterSuccess({ action: 'abort', taskId: 'c1' }));
  check('but the same decision against a LIVE task is fine',
    codeAfterSuccess({ action: 'continue', taskId: 'r' }) === '<no error thrown>',
    codeAfterSuccess({ action: 'continue', taskId: 'r' }));
  check('an unscoped decision is still fine against a terminal tree',
    validateDecision({ action: 'abort', reason: 'tree finished' }, afterSuccess).action === 'abort');
  check('the error carries an actionable message', (() => {
    try { validateDecision({ action: 'teleport' }, afterSuccess); return false; }
    catch (e) { return e instanceof DecisionValidationError && e.message.includes('teleport'); }
  })());
  check('the validator is a DecisionValidationError, not a bare Error', (() => {
    try { validateDecision(null, afterSuccess); return false; }
    catch (e) { return e instanceof DecisionValidationError && e.name === 'DecisionValidationError'; }
  })());
}

// ---------------------------------------------------------------------------
// 7. Application: continue dispatches, wait and abort do not
// ---------------------------------------------------------------------------
section('P6-A 7. application respects the action, through the scheduler only');
{
  const dir = tmpDir();
  const store = new TaskStore();
  const obs = observeTasks(store, { now: NOW });

  // R2-2: dispatch hands back an ADMISSION RECEIPT, not a boolean. These fakes build
  // real receipts so `app.dispatched` is derived from admission exactly as production
  // derives it — a hand-returned `true` would no longer be expressible, which is the
  // point of the contract change.
  const admittedReceipt = (taskId: string): DispatchReceipt => buildDispatchReceipt({
    tick: { admitted: [taskId], waiting: [], skipped: [], outcomes: [] },
    dispatchedAt: NOW,
  });
  const nothingAdmitted = (): DispatchReceipt => emptyDispatchReceipt(NOW);

  // wait
  {
    // Counters, not booleans: TypeScript cannot see writes made inside a callback,
    // so a `let dispatched = false` would be narrowed to `false` at the assertion
    // and the check would pass vacuously. These must be REAL counts.
    let waitCalls = 0;
    const app = await applyDecision({ action: 'wait', rationale: 'nothing ready' }, {
      observation: obs,
      dispatch: async () => { waitCalls++; return admittedReceipt('w'); },
    });
    check('wait reports it applied nothing', app.applied === false);
    check('wait names itself in the code', app.applied === false && app.code === 'decision-wait');
    check('wait NEVER calls dispatch', waitCalls === 0, `calls=${waitCalls}`);
  }

  // abort
  {
    let abortCalls = 0;
    const app = await applyDecision({ action: 'abort', reason: 'stopping here' }, {
      observation: obs,
      dispatch: async () => { abortCalls++; return admittedReceipt('a'); },
    });
    check('abort reports it applied nothing', app.applied === false);
    check('abort names itself in the code', app.applied === false && app.code === 'decision-abort');
    check('abort NEVER calls dispatch', abortCalls === 0, `calls=${abortCalls}`);
    check('abort keeps the reason it was given', app.applied === false && app.reason === 'stopping here');
  }

  // continue
  {
    // A counter, not a boolean: TypeScript does not track writes made inside a
    // callback, so a `let dispatched = false` would be narrowed to `false` at the
    // assertion and the check would pass vacuously.
    let dispatchCalls = 0;
    const app = await applyDecision({ action: 'continue' }, {
      observation: obs,
      dispatch: async () => { dispatchCalls++; return admittedReceipt('c'); },
    });
    check('continue may dispatch', app.applied === true);
    check('continue reports whether anything actually ran', app.applied === true && app.dispatched === true);
    check('continue reached the dispatch callback exactly once', dispatchCalls === 1, `calls=${dispatchCalls}`);
  }

  // R2-2 / F8: an empty receipt is a LEGAL outcome and must not be read as failure.
  // `admitted` is empty because nothing was ready — that is not a refused dispatch,
  // and it must not be conflated with a gate refusal.
  {
    let dispatchCalls = 0;
    const app = await applyDecision({ action: 'continue' }, {
      observation: obs,
      dispatch: async () => { dispatchCalls++; return nothingAdmitted(); },
    });
    check('an empty receipt applies without error', app.applied === true, app.applied === false ? app.code : 'applied');
    check('an empty receipt means nothing was dispatched, not that dispatch failed',
      app.applied === true && app.dispatched === false);
    check('and it was still exactly one dispatch', dispatchCalls === 1, `calls=${dispatchCalls}`);
  }

  // continue on a finished tree
  {
    const doneStore = new TaskStore();
    doneStore.create({ taskId: 'r', parentTaskId: null, agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' }, NOW);
    doneStore.transition('r', 'queued', NOW);
    doneStore.transition('r', 'running', NOW);
    doneStore.transition('r', 'to_verify', NOW);
    doneStore.transition('r', 'succeeded', NOW);
    const doneObs = observeTasks(doneStore, { now: NOW });
    let doneCalls = 0;
    const app = await applyDecision({ action: 'continue' }, {
      observation: doneObs,
      dispatch: async () => { doneCalls++; return admittedReceipt('r'); },
    });
    check('continue on an all-terminal tree dispatches nothing', doneCalls === 0, `calls=${doneCalls}`);
    check('and says why', app.applied === false && app.code === 'nothing-to-continue',
      app.applied === false ? app.code : 'applied');
  }

  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 8. The real loop, end to end
// ---------------------------------------------------------------------------
section('P6-A 8. observe -> decide -> validate -> apply -> tick (real classes)');
{
  const dir = tmpDir();

  // --- a `continue` decision really dispatches through the scheduler ---
  {
    const { runtime, requests } = fakeRuntime();
    const o = new Orchestrator({ gate: gateSources(['r', 'c1', 'c2']), now, runtime, defaultCwd: dir });
    seed(o, ['c1', 'c2']);
    const scheduler = new TaskScheduler({ orchestrator: o, cwd: dir, rootTaskId: 'r' });
    const provider = providerAnswering('continue');

    const cycle = await runDecisionCycle({ store: o.getStore(), scheduler, provider, rootTaskId: 'r' });

    check('the cycle completed', cycle.status === 'ok', cycle.status);
    check('the observation it decided from was real (both children ready)',
      cycle.status === 'ok' && cycle.observation.ready.length === 2,
      cycle.status === 'ok' ? JSON.stringify(cycle.observation.ready) : '');
    check('the decision was validated to continue', cycle.status === 'ok' && cycle.decision?.action === 'continue');
    check('the decision was APPLIED', cycle.status === 'ok' && cycle.application.applied === true);
    check('the scheduler was the dispatch path and it admitted both tasks',
      cycle.status === 'ok' && cycle.tick !== null && cycle.tick.admitted.length === 2,
      cycle.status === 'ok' && cycle.tick !== null ? JSON.stringify(cycle.tick.admitted) : '');
    check('the runtime ran the tasks (not the brain)', requests.length === 2, `ran ${requests.length}`);
    check('the tasks advanced to to_verify through the real execution edge',
      o.getStore().get('c1')?.status === 'to_verify' && o.getStore().get('c2')?.status === 'to_verify',
      `${o.getStore().get('c1')?.status}/${o.getStore().get('c2')?.status}`);
    check('the cycle collected run evidence for the next observation',
      cycle.status === 'ok' && cycle.results.size === 2, cycle.status === 'ok' ? String(cycle.results.size) : '');
    check('the provider was asked exactly one question',
      provider.calls.length === 1 && Object.keys(provider.calls[0].questions).length === 1);
    check('the provider received the observation as state',
      provider.calls[0].state !== undefined && typeof provider.calls[0].state?.next_action === 'string');
    check('the collected evidence feeds the NEXT observation',
      observeTasks(o.getStore(), { now: NOW, results: cycle.status === 'ok' ? cycle.results : new Map() })
        .tasks.filter((t) => t.depth === 1).every((t) => t.verification === 'pending'));
  }

  // --- a `wait` decision dispatches nothing ---
  //
  // Codex's P6-A review asked for this specifically, and it is worth being precise
  // about WHY. `applyDecision` already refuses to dispatch on `wait`, and unit
  // tests on `applyDecision` prove it. What that does NOT prove is that the LOOP
  // never calls dispatch for another reason on the way past - e.g. collecting
  // results, or an unconditional tick that happens to sit outside the decision
  // branch. The assertion that closes that gap is the same `requests` counter the
  // runtime increments: a real agent invocation cannot happen without moving it.
  {
    const { runtime, requests } = fakeRuntime();
    const o = new Orchestrator({ gate: gateSources(['r', 'c1']), now, runtime, defaultCwd: dir });
    seed(o, ['c1']);
    const scheduler = new TaskScheduler({ orchestrator: o, cwd: dir, rootTaskId: 'r' });
    const before = o.getStore().get('c1')?.status;

    const cycle = await runDecisionCycle({
      store: o.getStore(), scheduler, provider: providerAnswering('wait'), rootTaskId: 'r',
    });

    check('wait reaches a valid decision', cycle.status === 'ok' && cycle.decision?.action === 'wait');
    check('wait dispatches NOTHING', requests.length === 0, `ran ${requests.length}`);
    check('wait produced no tick at all', cycle.status === 'ok' && cycle.tick === null);
    check('wait left the task exactly as it was', o.getStore().get('c1')?.status === before, String(o.getStore().get('c1')?.status));
    check('wait reports it applied nothing', cycle.status === 'ok' && cycle.application.applied === false);
    check('the task is still dispatchable, so the zero above is the DECISION, not an empty queue',
      cycle.status === 'ok' && cycle.observation.ready.includes('c1'),
      cycle.status === 'ok' ? JSON.stringify(cycle.observation.ready) : '');
    check('CRITICAL: with a ready task and free slots, `wait` still ran no agent',
      requests.length === 0);
    check('and the scheduler was never even entered (no tick object at all)',
      cycle.status === 'ok' && cycle.tick === null && cycle.results.size === 0);
  }

  // --- an `abort` decision dispatches nothing and changes nothing ---
  {
    const { runtime, requests } = fakeRuntime();
    const o = new Orchestrator({ gate: gateSources(['r', 'c1']), now, runtime, defaultCwd: dir });
    seed(o, ['c1']);
    const scheduler = new TaskScheduler({ orchestrator: o, cwd: dir, rootTaskId: 'r' });
    const snapshotBefore = JSON.stringify(o.getStore().all());

    const cycle = await runDecisionCycle({
      store: o.getStore(), scheduler, provider: providerAnswering('abort'), rootTaskId: 'r',
    });

    check('abort reaches a valid decision', cycle.status === 'ok' && cycle.decision?.action === 'abort');
    check('abort dispatches nothing', requests.length === 0);
    check('abort produced no tick', cycle.status === 'ok' && cycle.tick === null);
    check('abort did NOT delete or alter any task',
      JSON.stringify(o.getStore().all()) === snapshotBefore,
      'the store changed during an abort');
    check('abort kept its reason', cycle.status === 'ok' && cycle.application.applied === false && cycle.application.reason.length > 0);
  }

  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 9. An invalid decision has ZERO side effects
// ---------------------------------------------------------------------------
section('P6-A 9. an invalid decision changes nothing at all');
{
  const dir = tmpDir();

  // unknown action
  {
    const { runtime, requests } = fakeRuntime();
    const o = new Orchestrator({ gate: gateSources(['r', 'c1']), now, runtime, defaultCwd: dir });
    seed(o, ['c1']);
    const scheduler = new TaskScheduler({ orchestrator: o, cwd: dir, rootTaskId: 'r' });
    const before = JSON.stringify(o.getStore().all());

    const cycle = await runDecisionCycle({
      store: o.getStore(), scheduler, provider: providerAnswering('teleport'), rootTaskId: 'r',
    });

    check('an unknown action is reported invalid', cycle.status === 'invalid', cycle.status);
    check('the code is unknown-action', cycle.status === 'invalid' && cycle.error.code === 'unknown-action',
      cycle.status === 'invalid' ? cycle.error.code : '');
    check('NOTHING was dispatched', requests.length === 0);
    check('NO tick ran', cycle.status === 'invalid' && cycle.tick === null);
    check('the store is byte-identical', JSON.stringify(o.getStore().all()) === before, 'store changed');
  }

  // a deferred action, through the REAL provider path
  {
    const { runtime, requests } = fakeRuntime();
    const o = new Orchestrator({ gate: gateSources(['r', 'c1']), now, runtime, defaultCwd: dir });
    seed(o, ['c1']);
    const scheduler = new TaskScheduler({ orchestrator: o, cwd: dir, rootTaskId: 'r' });
    const before = JSON.stringify(o.getStore().all());

    for (const action of DEFERRED_ACTIONS) {
      const cycle = await runDecisionCycle({
        store: o.getStore(), scheduler, provider: providerAnswering(action), rootTaskId: 'r',
      });
      check(`"${action}" through the loop is invalid, not executed`,
        cycle.status === 'invalid' && cycle.error.code === 'action-not-implemented',
        cycle.status === 'invalid' ? cycle.error.code : cycle.status);
      check(`"${action}" did NOT become continue (nothing dispatched)`,
        cycle.status === 'invalid' && cycle.tick === null);
    }
    check('no run happened for any deferred action', requests.length === 0, `ran ${requests.length}`);
    check('the store is untouched by every deferred action', JSON.stringify(o.getStore().all()) === before);
  }

  // provider problems are reported, not defaulted
  {
    const { runtime, requests } = fakeRuntime();
    const o = new Orchestrator({ gate: gateSources(['r', 'c1']), now, runtime, defaultCwd: dir });
    seed(o, ['c1']);
    const scheduler = new TaskScheduler({ orchestrator: o, cwd: dir, rootTaskId: 'r' });

    const down = await runDecisionCycle({
      store: o.getStore(), scheduler,
      provider: providerAnswering('continue', { throwOnDecide: new DecisionUnavailableError('http://127.0.0.1:8077', 'connection refused') }),
      rootTaskId: 'r',
    });
    check('an unreachable provider is reported, not defaulted', down.status === 'provider-unavailable', down.status);
    check('an unreachable provider dispatches nothing', requests.length === 0 && down.tick === null);

    const bad = await runDecisionCycle({
      store: o.getStore(), scheduler,
      provider: providerAnswering('continue', { throwOnDecide: new DecisionSchemaError('probabilities do not match the reported value') }),
      rootTaskId: 'r',
    });
    check('a schema error is reported, not defaulted', bad.status === 'provider-unavailable', bad.status);
    check('still nothing dispatched', requests.length === 0);

    // A provider that answers, but not with an action at all.
    const noAnswer = await runDecisionCycle({
      store: o.getStore(), scheduler, provider: providerAnswering(null, { omitAnswer: true }), rootTaskId: 'r',
    });
    check('a response with no answer is invalid', noAnswer.status === 'invalid', noAnswer.status);
    check('and dispatches nothing', noAnswer.tick === null);

    const wrongType = await runDecisionCycle({
      store: o.getStore(), scheduler, provider: providerAnswering(null, { answerType: 'score' }), rootTaskId: 'r',
    });
    check('a non-choice answer for the action question is invalid', wrongType.status === 'invalid', wrongType.status);
  }

  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 10. Structural: the brain cannot reach the runtime
// ---------------------------------------------------------------------------
section('P6-A 10. the decision brain has no path to execution');
{
  const src = [
    'src/orchestration/observation.ts',
    'src/orchestration/decision.ts',
    'src/orchestration/decision-loop.ts',
  ];
  // Read the real files: this asserts the property from the source, not from a
  // belief about it. A future edit that hands the loop an orchestrator would fail here.
  const importOf = (file: string): string[] => {
    const text = sourceText(file);
    return [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  };

  // `../core/types.ts` is imported TYPE-ONLY (RunResult / AgentDescriptor), which
  // is how the whole project already reads core: for shapes, never for a runtime.
  // So the property under test is "imports no EXECUTOR", not "imports nothing".
  const typeOnly = (file: string, spec: string): boolean => {
    const text = sourceText(file);
    return new RegExp(`import type [^;]*from '${spec.replace(/[/.]/g, (c) => `\\${c}`)}'`).test(text);
  };
  const importsRuntimeValue = (file: string, spec: string): boolean => {
    const text = sourceText(file);
    // A non-`type` import of that specifier would be a value import.
    return new RegExp(`import (?!type )[^;]*from '${spec.replace(/[/.]/g, (c) => `\\${c}`)}'`).test(text);
  };

  const obsImports = importOf(src[0]);
  check('observation imports no executor, scheduler or controller',
    !obsImports.some((i) => i.includes('orchestrator') || i.includes('scheduler')),
    obsImports.join(', '));
  check('observation reads core TYPE-ONLY, never a runtime value',
    typeOnly(src[0], '../core/types.ts') && !importsRuntimeValue(src[0], '../core/types.ts'));
  check('observation does not import the decision layer (one-way dependency)',
    !obsImports.some((i) => i.includes('decision')), obsImports.join(', '));

  const decImports = importOf(src[1]);
  // P6-D1 widened this by exactly one module: `../quota/types.ts`, for the CLOSED
  // `TASK_TYPES` list that validates an `add_task`'s taskType. That is a pure constant
  // used to REJECT an unknown type - the opposite of importing a capability registry -  // so it is asserted explicitly rather than loosened into a blanket "any import is
  // fine", which would stop this test catching a real second dependency.
  //
  // R2-2 widens it by exactly one more: `./dispatch-receipt.ts`, for the TYPE of the
  // admission receipt `context.dispatch` now returns. It is the same shape of widening
  // and is held to the same discipline - named here rather than folded into a blanket
  // allowance, and asserted to be TYPE-ONLY, which is STRICTER than the P6-D1 constant:
  // `dispatch-receipt.ts` exports a runtime builder, so a plain value import would pull
  // real code (and, through it, the scheduler's TickResult type) into the decision
  // layer. Only the shape is allowed across this boundary.
  check('decision imports only observation, the closed TASK_TYPES vocabulary and the receipt TYPE',
    new Set(decImports).size === 3 &&
    decImports.includes('./observation.ts') &&
    decImports.includes('../quota/types.ts') &&
    decImports.includes('./dispatch-receipt.ts') &&
    decImports.every((i) => i === './observation.ts' || i === '../quota/types.ts' || i === './dispatch-receipt.ts'),
    decImports.join(', '));
  check('the receipt crosses into the decision layer as a TYPE only, never as runtime code',
    typeOnly(src[1], './dispatch-receipt.ts') && !importsRuntimeValue(src[1], './dispatch-receipt.ts'));
  check('decision does NOT import the runtime, the store or the scheduler',
    !decImports.some((i) => i.includes('core/') || i.includes('orchestrator') || i.includes('scheduler') || i.includes('store')),
    decImports.join(', '));
  check('decision imports NO registry/assignment/planner - only constants and types',
    !decImports.some((i) => /registry|assignment|planner|workbench|adapters/.test(i)),
    decImports.join(', '));

  const loopImports = importOf(src[2]);
  check('the loop does not import the Orchestrator class itself',
    !loopImports.some((i) => i.includes("/orchestrator'") || i.includes('/orchestrator/orchestrator')),
    loopImports.join(', '));
  check('the loop talks to the store and the scheduler by TYPE only',
    typeOnly(src[2], './store.ts') && typeOnly(src[2], './scheduler.ts') &&
    !importsRuntimeValue(src[2], './store.ts') && !importsRuntimeValue(src[2], './scheduler.ts'));
  check('the loop imports no runtime, adapter or orchestrator implementation',
    !loopImports.some((i) => i.includes('/runtime') || i.includes('adapter') || i.includes('/orchestrator/')),
    loopImports.join(', '));
  check('the loop reads core TYPE-ONLY',
    typeOnly(src[2], '../core/types.ts') && !importsRuntimeValue(src[2], '../core/types.ts'));

  // The runtime decision capability is a single optional callback.
  let calls = 0;
  const app = await applyDecision({ action: 'continue' }, {
    observation: observeTasks(new TaskStore(), { now: NOW }),
    dispatch: async () => { calls++; return buildDispatchReceipt({ tick: { admitted: ['x'], waiting: [], skipped: [], outcomes: [] }, dispatchedAt: NOW }); },
  });
  check('the ONLY capability the brain is given is one dispatch callback', calls === 1 && app.applied);
}

// ---------------------------------------------------------------------------
// 11. The controller remains the production entry point
// ---------------------------------------------------------------------------
section('P6-A 11. the existing Controller path is unchanged and still works');
{
  const dir = tmpDir();
  const { runtime, requests } = fakeRuntime();
  const o = new Orchestrator({ gate: gateSources(['r', 'c1']), now, runtime, defaultCwd: dir });
  const controller = new OrchestrationController({ orchestrator: o, cwd: dir });

  const plan = await controller.run(
    { taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' },
    [{ taskId: 'c1', agentId: AGENT, modelId: SB, taskType: impl, acceptanceCriteria: 'work', budgetUnits: 10 }],
  );

  check('the controller still creates root and spawns children', plan.root !== null && plan.children.length === 1);
  check('its first tick still dispatched the child', plan.firstTick.admitted.includes('c1'), JSON.stringify(plan.firstTick));
  check('the runtime ran it', requests.length === 1);
  check('P6-A did not replace this path: controller.run is untouched',
    plan.dispatchedAny === true);

  // And the loop composes with it: observe the controller's own tree afterwards.
  const cycle = await runDecisionCycle({
    store: o.getStore(),
    scheduler: controller.getScheduler(),
    provider: providerAnswering('wait'),
    rootTaskId: 'r',
  });
  check('the loop can observe and decide over a controller-built tree',
    cycle.status === 'ok' && cycle.observation.tasks.length === 2,
    cycle.status === 'ok' ? String(cycle.observation.tasks.length) : cycle.status);

  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 12. Second-authority checks
// ---------------------------------------------------------------------------
section('P6-A 12. no second store, scheduler, workspace or execution path');
{
  const tree = (dir: string): string[] => {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts')) out.push(p);
      }
    };
    walk(dir);
    return out;
  };
  const files = tree('src');
  /**
   * Source with comments and string literals removed.
   *
   * These counts are claims about CODE, and reading raw text made them wrong in both
   * directions: a doc comment mentioning "`runtime.run()` throw" counted as a second
   * execution edge, while a commented-out `runtime.run(` would have satisfied the
   * "exactly one place" check without any call existing at all. Stripping comments and
   * literals is what makes the assertion mean what it says.
   */
  const codeOf = (text: string): string => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const countOf = (pattern: RegExp): string[] => files.filter((f) => pattern.test(codeOf(sourceText(f))));

  const stores = countOf(/new TaskStore\(/);
  check('TaskStore is instantiated in exactly one place', stores.length === 1, stores.join(', '));
  const schedulers = countOf(/class TaskScheduler\b/);
  check('there is exactly one TaskScheduler class', schedulers.length === 1, schedulers.join(', '));
  const workspaces = countOf(/class WorkspaceManager\b/);
  check('there is exactly one WorkspaceManager class', workspaces.length === 1, workspaces.join(', '));
  const execEdges = countOf(/runtime\.run\(/);
  check('RuntimeRunner.run is called in exactly one place', execEdges.length === 1, execEdges.join(', '));

  // R2-2 added a lease LIFECYCLE. The specific way that could have gone wrong is by
  // growing a parallel authority for it, so those names are banned outright rather
  // than left to the generic counts above - a `LeaseManager` would satisfy "one
  // TaskScheduler" perfectly while still being a second control plane.
  const bannedAuthorities = [
    'LeaseManager', 'LeaseAuthority', 'LeaseScheduler', 'LeaseService', 'LeaseRegistry',
    'FencingController', 'FencingAuthority',
    'ResultStore', 'ExecutionResultStore', 'DispatchStore',
    'SecondScheduler', 'ExecutionController', 'ResultRegistry',
  ];
  const allText = files.map((f) => codeOf(sourceText(f))).join('\n');
  for (const name of bannedAuthorities) {
    check(`R2-2: no ${name} exists anywhere in src/`,
      !new RegExp(`\\b(class|interface|type)\\s+${name}\\b`).test(allText) && !new RegExp(`new\\s+${name}\\b`).test(allText));
  }
  // A background service would make a bounded round into a persistent worker.
  check('R2-2: no lease heartbeat / background renewal service',
    !/setInterval\([^)]*lease/i.test(allText) && !/leaseService|leaseHeartbeat/i.test(allText));

  // P6-A must not have introduced a new path of any of these.
  const newFiles = ['src/orchestration/observation.ts', 'src/orchestration/decision.ts', 'src/orchestration/decision-loop.ts'];
  for (const f of newFiles) {
    const text = sourceText(f);
    check(`${f} creates no store/scheduler/workspace/executor`,
      !/new TaskStore|new TaskScheduler|new WorkspaceManager|\.run\(/.test(text));
  }

  // R2-2: the lease layer must not be reachable from the decision layer, which is not
  // allowed to hold a RunResult, a dispatch authority, or a credential of any kind.
  for (const f of newFiles) {
    const text = sourceText(f);
    check(`${f} imports no lease / evidence internals`,
      !/assignment-lease|attempt-store|attempt-record/.test(text));
  }
}

// ---------------------------------------------------------------------------
// 13. LAYA-ACTION.1: a bounded workflow action binds the target the provider chose
//
// The native 0.3.21 decoder answers with exactly one of the offered choice keys and
// attaches NO sibling task parameters (verified against tag 6ab71fb4). So the request
// must OFFER keys that already bind action+task, and the answer must be resolved
// against the SAME immutable snapshot — never a default first task, a parsed target,
// or a provider parameter smuggled into the payload.
// ---------------------------------------------------------------------------
section('Laya-action 13. bounded workflow answers resolve to the OFFERED task only');
{
  const dir = tmpDir();

  /** The same-task acceptance material a workflow round would build for these tasks. */
  const materialFor = (
    objective: string,
    entries: Array<{ taskId: string; criteria: string; output: string; taskType?: TaskType; executionMissing?: boolean }>,
  ): AcceptanceMaterial => ({
    objective,
    entries: entries.map((e) => ({
      taskId: e.taskId,
      taskType: e.taskType ?? impl,
      acceptanceCriteria: e.criteria,
      attemptId: `att-${e.taskId}`,
      agentId: AGENT,
      modelId: SB,
      output: e.output,
      outputTruncated: false,
      boundedForRequest: false,
      transcriptPath: null,
      artifacts: [],
      runState: e.executionMissing === true ? null : 'succeeded',
      exitCode: e.executionMissing === true ? null : 0,
      runError: null,
      executionMissing: e.executionMissing === true,
      acceptanceCriteriaMissing: e.criteria.trim() === '',
    })),
  });

  /** Root + children under a real Orchestrator, optionally parked in `to_verify`. */
  const makeTree = (specs: Array<{ id: string; toVerify: boolean }>): Orchestrator => {
    const o = new Orchestrator({
      gate: gateSources(['r', ...specs.map((s) => s.id)]),
      now,
      runtime: fakeRuntime().runtime,
      defaultCwd: dir,
    });
    o.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' });
    for (const s of specs) {
      o.spawnChild({
        taskId: s.id, parentTaskId: 'r', agentId: AGENT, modelId: SB,
        taskType: impl, acceptanceCriteria: `work ${s.id}`, budgetUnits: 10,
      });
      if (s.toVerify) {
        const st = o.getStore();
        st.transition(s.id, 'queued', NOW);
        st.transition(s.id, 'running', NOW);
        st.transition(s.id, 'to_verify', NOW);
      }
    }
    return o;
  };

  /** The one EXISTING authority `complete` must still go through: applyVerification. */
  const completeCapOf = (
    o: Orchestrator,
    seen: string[],
  ): (req: { taskId: string; reason?: string }) => Promise<{ ok: boolean; code: string; reason: string }> =>
    async (req) => {
      seen.push(req.taskId);
      const applied = o.applyVerification(req.taskId, { verdict: 'pass', reason: req.reason ?? 'bounded complete' });
      return applied.ok
        ? { ok: true, code: 'completed', reason: `task ${req.taskId} verified` }
        : { ok: false, code: applied.code, reason: applied.reason };
    };

  /** A REAL Laya provider over a seam that emits ONLY native 0.3.21-shaped answers. */
  const nativeProvider = (choose: (offered: readonly string[]) => string): { provider: DecisionProvider; seen: string[][] } => {
    const seen: string[][] = [];
    const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { questions?: Record<string, { type: string; criteria?: unknown }> };
      const questions = body.questions ?? {};
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(questions)) {
        const offered = q.type === 'choice' ? Object.keys((q.criteria ?? {}) as Record<string, string>) : [];
        seen.push(offered);
        const choice = choose(offered);
        const probabilities: Record<string, number> = {};
        for (const opt of offered) probabilities[opt] = opt === choice ? 1 : 0;
        // Native shape: type / choice / probabilities / confidence / answer_confidence
        // + the official action metadata. Deliberately NO sibling task parameters.
        answers[id] = {
          type: 'choice', choice, probabilities, confidence: 1, answer_confidence: 1,
          action: { act_probability: 1 },
        };
      }
      return new Response(JSON.stringify({ model: 'laya-test', answers, routing: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { provider: createLayaDecisionProvider({ fetchImpl }), seen };
  };

  /** A stub that can return ANY key/parameters (the real provider refuses these first). */
  const rawProvider = (
    choice: string,
    parameters?: Record<string, string>,
    beforeReturn?: () => void,
  ): DecisionProvider => ({
    name: 'raw-seam',
    probe: async () => ({ ok: true, endpoint: 'raw://seam', detail: 'raw', warnings: [] }),
    decide: async () => {
      if (beforeReturn !== undefined) beforeReturn();
      return {
        answers: {
          next_action: {
            type: 'choice', choice, probabilities: { [choice]: 1 }, confidence: 1,
            ...(parameters === undefined ? {} : { parameters }),
          },
        },
        provider: { name: 'raw-seam', model: 'raw', elapsedMs: 0, details: {} },
        raw: {},
      } as never;
    },
  });

  /** The offered keys that bind a `complete` target (everything not a base action). */
  const completeKeysIn = (offered: readonly string[]): string[] =>
    offered.filter((k) => k !== 'continue' && k !== 'wait' && k !== 'abort');

  /** The keys a real workflow request would offer, read from the production builder. */
  const offeredFor = (o: Orchestrator, material: AcceptanceMaterial): string[] => {
    const obs = observeTasks(o.getStore(), { now: NOW, rootTaskId: 'r' });
    const req = orchestrationDecisionRequest(obs, { acceptanceMaterial: material });
    return Object.keys((req.questions['next_action'] as { criteria: Record<string, string> }).criteria);
  };

  // --- TWO eligible tasks: the provider must be able to name the SECOND, with no params ---
  {
    const o = makeTree([{ id: 't1', toVerify: true }, { id: 't2', toVerify: true }]);
    const material = materialFor('two eligible tasks', [
      { taskId: 't1', criteria: 't1 :: member — deliverable: a', output: 't1 member deliverable produced' },
      { taskId: 't2', criteria: 't2 :: member — deliverable: b', output: 't2 member deliverable produced' },
    ]);
    const { provider, seen } = nativeProvider((offered) => completeKeysIn(offered).find((k) => k.endsWith('t2')) ?? 'wait');
    const completed: string[] = [];
    const cycle = await runDecisionCycle({
      store: o.getStore(),
      scheduler: new TaskScheduler({ orchestrator: o, cwd: dir }),
      provider,
      rootTaskId: 'r',
      acceptanceMaterial: material,
      capabilities: { complete: completeCapOf(o, completed) },
    });
    const offered = seen[0] ?? [];
    const dec = cycle.status === 'ok' ? cycle.decision : null;
    check('LAYA-ACTION: the bounded request offers a distinct complete key for EACH eligible task',
      completeKeysIn(offered).some((k) => k.endsWith('t1')) && completeKeysIn(offered).some((k) => k.endsWith('t2')),
      offered.join(','));
    check('LAYA-ACTION: a native-shaped answer is accepted', cycle.status === 'ok', cycle.status);
    check('LAYA-ACTION: the decision names the SECOND task, never the first',
      dec?.action === 'complete' && dec.taskId === 't2', JSON.stringify(dec));
    check('LAYA-ACTION: only the selected target reached the complete capability',
      completed.length === 1 && completed[0] === 't2', completed.join(','));
    check('LAYA-ACTION: the selected task succeeded and the other stayed to_verify',
      o.getStore().get('t2')?.status === 'succeeded' && o.getStore().get('t1')?.status === 'to_verify',
      `t1=${o.getStore().get('t1')?.status} t2=${o.getStore().get('t2')?.status}`);
    check('LAYA-ACTION: raw action metadata never became a task parameter',
      dec !== null && Object.keys(dec).sort().join(',') === 'action,taskId', dec === null ? 'no decision' : Object.keys(dec).join(','));
  }

  // --- a key for a task that is NOT eligible (not to_verify) is refused as unoffered ---
  {
    const o = makeTree([{ id: 't1', toVerify: true }, { id: 't2', toVerify: false }]);
    const material = materialFor('one eligible', [
      { taskId: 't1', criteria: 't1 :: member — deliverable: a', output: 't1 produced' },
    ]);
    const offered = offeredFor(o, material);
    const key1 = completeKeysIn(offered)[0]!;
    const sep = key1.slice('complete'.length, key1.length - 't1'.length);
    const completed: string[] = [];
    const before = JSON.stringify(o.getStore().all());
    const cycle = await runDecisionCycle({
      store: o.getStore(),
      scheduler: new TaskScheduler({ orchestrator: o, cwd: dir }),
      provider: rawProvider(`complete${sep}t2`),
      rootTaskId: 'r',
      acceptanceMaterial: material,
      capabilities: { complete: completeCapOf(o, completed) },
    });
    check('LAYA-ACTION: no complete key is offered for the non-to_verify task',
      !offered.some((k) => k.endsWith('t2')), offered.join(','));
    check('LAYA-ACTION: a key for an ineligible task is refused as unoffered',
      cycle.status === 'invalid' && cycle.error.code === 'unoffered-action-key',
      cycle.status === 'invalid' ? cycle.error.code : cycle.status);
    check('LAYA-ACTION: the refused key dispatched and changed nothing',
      completed.length === 0 && JSON.stringify(o.getStore().all()) === before);
  }

  // --- a bounded key PLUS a contradictory target parameter is refused, not merged ---
  {
    const o = makeTree([{ id: 't1', toVerify: true }, { id: 't2', toVerify: true }]);
    const material = materialFor('contradictory target', [
      { taskId: 't1', criteria: 't1 :: member — deliverable: a', output: 't1 produced' },
      { taskId: 't2', criteria: 't2 :: member — deliverable: b', output: 't2 produced' },
    ]);
    const offered = offeredFor(o, material);
    const key1 = completeKeysIn(offered).find((k) => k.endsWith('t1'))!;
    const completed: string[] = [];
    const before = JSON.stringify(o.getStore().all());
    const cycle = await runDecisionCycle({
      store: o.getStore(),
      scheduler: new TaskScheduler({ orchestrator: o, cwd: dir }),
      provider: rawProvider(key1, { taskId: 't2' }),
      rootTaskId: 'r',
      acceptanceMaterial: material,
      capabilities: { complete: completeCapOf(o, completed) },
    });
    check('LAYA-ACTION: a contradictory provider target is refused',
      cycle.status === 'invalid' && cycle.error.code === 'contradictory-target',
      cycle.status === 'invalid' ? cycle.error.code : cycle.status);
    check('LAYA-ACTION: the contradictory answer caused no mutation or dispatch',
      completed.length === 0 && JSON.stringify(o.getStore().all()) === before);
  }

  // --- a bounded key PLUS any other target/action parameter is refused, not merged ---
  {
    const o = makeTree([{ id: 't1', toVerify: true }]);
    const material = materialFor('extra params', [{ taskId: 't1', criteria: 't1 :: member', output: 't1 produced' }]);
    const offered = offeredFor(o, material);
    const key1 = completeKeysIn(offered)[0]!;
    const completed: string[] = [];
    const before = JSON.stringify(o.getStore().all());
    const cycle = await runDecisionCycle({
      store: o.getStore(),
      scheduler: new TaskScheduler({ orchestrator: o, cwd: dir }),
      provider: rawProvider(key1, { agentId: 'some-other-agent' }),
      rootTaskId: 'r',
      acceptanceMaterial: material,
      capabilities: { complete: completeCapOf(o, completed) },
    });
    check('LAYA-ACTION: extra target/action parameters are refused, never merged',
      cycle.status === 'invalid' && cycle.error.code === 'unexpected-action-parameters',
      cycle.status === 'invalid' ? cycle.error.code : cycle.status);
    check('LAYA-ACTION: the extra-parameter refusal changed nothing',
      completed.length === 0 && JSON.stringify(o.getStore().all()) === before);
  }

  // --- missing / empty / wrong-task evidence must create NO complete candidate ---
  {
    const cases: Array<{ label: string; material: AcceptanceMaterial }> = [
      { label: 'empty output', material: materialFor('empty', [{ taskId: 't1', criteria: 't1 :: member', output: '' }]) },
      { label: 'missing execution', material: materialFor('missing', [{ taskId: 't1', criteria: 't1 :: member', output: 'x', executionMissing: true }]) },
      { label: 'foreign taskType', material: materialFor('foreign', [{ taskId: 't1', criteria: 't1 :: member', output: 'x', taskType: 'research' }]) },
      { label: 'no entry at all', material: materialFor('none', []) },
    ];
    for (const c of cases) {
      const o = makeTree([{ id: 't1', toVerify: true }]);
      const offered = offeredFor(o, c.material);
      const completed: string[] = [];
      const before = JSON.stringify(o.getStore().all());
      const cycle = await runDecisionCycle({
        store: o.getStore(),
        scheduler: new TaskScheduler({ orchestrator: o, cwd: dir }),
        provider: rawProvider('complete'),
        rootTaskId: 'r',
        acceptanceMaterial: c.material,
        capabilities: { complete: completeCapOf(o, completed) },
      });
      check(`LAYA-ACTION: ${c.label} offers no complete key`,
        completeKeysIn(offered).length === 0, offered.join(','));
      check(`LAYA-ACTION: ${c.label} cannot complete (unoffered) and changes nothing`,
        cycle.status === 'invalid' && cycle.error.code === 'unoffered-action-key' &&
          completed.length === 0 && JSON.stringify(o.getStore().all()) === before,
        cycle.status === 'invalid' ? cycle.error.code : cycle.status);
    }
  }

  // --- a task OUTSIDE the observed root is never a target ---
  {
    const o = makeTree([{ id: 't1', toVerify: true }]);
    o.createRoot({ taskId: 'x', agentId: AGENT, taskType: impl, acceptanceCriteria: 'root x' });
    o.spawnChild({ taskId: 'x1', parentTaskId: 'x', agentId: AGENT, modelId: SB, taskType: impl, acceptanceCriteria: 'work x1', budgetUnits: 10 });
    const st = o.getStore();
    st.transition('x1', 'queued', NOW); st.transition('x1', 'running', NOW); st.transition('x1', 'to_verify', NOW);
    const material = materialFor('two roots', [
      { taskId: 't1', criteria: 't1 :: member', output: 't1 produced' },
      { taskId: 'x1', criteria: 'x1 :: member', output: 'x1 produced' },
    ]);
    const offered = offeredFor(o, material);
    const key1 = completeKeysIn(offered)[0]!;
    const sep = key1.slice('complete'.length, key1.length - 't1'.length);
    const completed: string[] = [];
    const before = JSON.stringify(o.getStore().all());
    const cycle = await runDecisionCycle({
      store: o.getStore(),
      scheduler: new TaskScheduler({ orchestrator: o, cwd: dir }),
      provider: rawProvider(`complete${sep}x1`),
      rootTaskId: 'r',
      acceptanceMaterial: material,
      capabilities: { complete: completeCapOf(o, completed) },
    });
    check('LAYA-ACTION: a task in another root is not offered', !offered.some((k) => k.endsWith('x1')), offered.join(','));
    check('LAYA-ACTION: a key naming an out-of-root task is refused',
      cycle.status === 'invalid' && cycle.error.code === 'unoffered-action-key' && completed.length === 0,
      cycle.status === 'invalid' ? cycle.error.code : cycle.status);
    check('LAYA-ACTION: the out-of-root refusal changed nothing',
      JSON.stringify(o.getStore().all()) === before);
  }

  // --- a status change while the provider is thinking must not be accepted stale ---
  {
    const o = makeTree([{ id: 't1', toVerify: true }]);
    const material = materialFor('stale', [{ taskId: 't1', criteria: 't1 :: member', output: 't1 produced' }]);
    const completed: string[] = [];
    const cycle = await runDecisionCycle({
      store: o.getStore(),
      scheduler: new TaskScheduler({ orchestrator: o, cwd: dir }),
      // The provider mutates the store AFTER the observation was taken and BEFORE it answers.
      provider: rawProvider('complete', undefined, () => {
        o.getStore().transition('t1', 'succeeded', NOW, 'changed while the provider was deciding');
      }),
      rootTaskId: 'r',
      acceptanceMaterial: material,
      capabilities: { complete: completeCapOf(o, completed) },
    });
    check('LAYA-ACTION: a task/status change during the decision is NOT accepted stale',
      cycle.status === 'ok' && cycle.application.applied === false,
      cycle.status === 'ok' ? `${cycle.application.applied}` : cycle.status);
    check('LAYA-ACTION: the stale complete reached the authority, which refused it',
      completed.length === 1 && o.getStore().get('t1')?.status === 'succeeded',
      completed.join(','));
  }

  // --- legacy contract: no material -> the full vocabulary and parameter path stay ---
  {
    const o = makeTree([{ id: 't1', toVerify: true }]);
    const obs = observeTasks(o.getStore(), { now: NOW, rootTaskId: 'r' });
    const legacyOffered = Object.keys((orchestrationDecisionRequest(obs).questions['next_action'] as { criteria: Record<string, string> }).criteria);
    check('LAYA-ACTION: a no-material request still offers the original eleven actions',
      legacyOffered.length === 11 && legacyOffered.includes('reassign') && legacyOffered.includes('complete'),
      legacyOffered.join(','));
    const extracted = extractAction({
      answers: { next_action: { type: 'choice', choice: 'complete', parameters: { taskId: 't1', reason: 'legacy params' } } },
    });
    const validated = validateDecision(extracted, obs);
    check('LAYA-ACTION: a parameterised (legacy) provider still resolves',
      validated.action === 'complete' && validated.taskId === 't1' && validated.reason === 'legacy params',
      JSON.stringify(validated));
    // A bounded workflow request must NOT advertise the unsupported parameter actions.
    const material = materialFor('bounded', [{ taskId: 't1', criteria: 't1 :: member', output: 't1 produced' }]);
    const boundedOffered = offeredFor(o, material);
    check('LAYA-ACTION: a bounded request does NOT advertise unsupported parameter actions',
      !boundedOffered.some((k) => ['reassign', 'rework', 'retry', 'add_task', 'split_task', 'parallelize', 'replan'].includes(k)),
      boundedOffered.join(','));
  }

  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) {
  process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
}
process.stdout.write('\n');
process.exitCode = failed === 0 ? 0 : 1;
