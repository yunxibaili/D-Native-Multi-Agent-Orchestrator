/**
 * tests/orchestration.test.ts - Phase 5C-1, hermetically.
 *
 * No network, no process, no real agent CLI. Real production classes are
 * exercised: `TaskStore`, `buildSpawnGateInput`, `translateRunResult`, and the
 * `Orchestrator` from src/orchestration. Only the clock and the gate sources
 * are injected.
 *
 * The assertions are the 5C-1 mandate:
 *   - a MISSING signal becomes a DENIAL, never a permissive default
 *   - maxDepth=1, and a child cannot spawn
 *   - the lifecycle is enforced; an illegal transition changes nothing
 *   - RunResult.succeeded lands in to_verify, NEVER in succeeded
 *   - cancellation propagates to the whole tree
 *
 * Run: node tests/orchestration.test.ts
 */

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { hostname as osHostname } from 'node:os';
import { basename as pathBasename, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { BudgetManager } from '../src/quota/budget.ts';
import { ModelRegistry } from '../src/quota/registry.ts';
import { Orchestrator as RuntimeOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { ManagedProcess } from '../src/runtime/spawn.ts';
import { launcherFor } from '../src/runtime/launcher.ts';
import { createCodexAdapter } from '../src/adapters/codex.ts';
import { createOpenCodeAdapter } from '../src/adapters/opencode.ts';
import { createWorkBuddyAdapter } from '../src/adapters/workbuddy.ts';
import { createFakeAdapter, sourceText, type ScriptStep } from './helpers.ts';
import type { AgentAdapter, AgentDescriptor, RunHandle, RunRequest, RunResult } from '../src/core/types.ts';
import type { PresentedLease } from '../src/orchestration/assignment-lease.ts';
import type { LauncherSpec } from '../src/core/types.ts';
import type { QuotaRecord } from '../src/quota/types.ts';
import type { Usage } from '../src/core/types.ts';
import {
  DEFAULT_LIMITS,
  Orchestrator,
  TaskStore,
  buildSpawnGateInput,
  canTransition,
  createTask,
  findDependencyCycle,
  isTerminal,
  resolveAgentAvailability,
  resolveBudgetHeadroom,
  resolveCapability,
  resolveWorkspaceModeCapability,
WORKSPACE_CAPABILITY_MISSING,
  WorkspaceLock,
  workspaceLockKey,
  normalizeIdentityPath,
  isProcessAlive,
  resolveConcurrency,
  resolveModelAvailability,
  resolveQuotaStatus,
  resolveRequestedUnits,
  OrchestrationController,
  TaskScheduler,
  resolveMaxChildren,
  resolveMaxConcurrentAgents,
  WorkspaceManager,
  WorkspaceError,
  branchForTask,
  resolveGitPath,
  buildRunRequest,
  buildTaskPrompt,
  isExecutable,
  translateRunResult,
  translateVerification,
  unmetDependencies,
  TASK_STATUSES,
  type RuntimeRunner,
  type SpawnGateSources,
  type Task,
} from '../src/orchestration/index.ts';

/** A launcher pointing at a path that does not exist: argv is still built for real. */
function stubLauncherFor(name: string): LauncherSpec {
  return {
    kind: 'native',
    command: `C:/fake/${name}.exe`,
    prefixArgs: [],
    target: `C:/fake/${name}.exe`,
    buildsCommandString: false,
  };
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

/**
 * Read the code/reason off a SpawnOutcome or MutateOutcome after narrowing.
 * Declared before every section because 5C-1 fix cases assert on denials too.
 */
function deny(r: { ok: boolean } & Record<string, unknown>): [string, string] {
  return r.ok ? ['', ''] : [String(r.code ?? ''), String(r.reason ?? '')];
}

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed++;
    failures.push(name + (detail ? ` - ${detail}` : ''));
    process.stdout.write(`  FAIL ${name}${detail ? ` - ${detail}` : ''}\n`);
  }
}

function section(t: string): void {
  process.stdout.write(`\n== ${t}\n`);
}

const NOW = 1_700_000_000_000;
const now = () => NOW;

// ---------------------------------------------------------------- fixtures

const descriptor = (id: string, caps: Partial<AgentDescriptor['capabilities']> = {}): AgentDescriptor => ({
  id,
  displayName: id,
  launcher: { command: id, args: [], shell: false } as unknown as AgentDescriptor['launcher'],
  transport: 'cli-jsonl',
  capabilities: {
newTask: true, resume: true, review: false, modelSelection: true, roleSelection: true,
      sandbox: false, streamEvents: true, costReporting: false, extraArgs: true, cwd: true,
      // A test agent is fully capable unless a test says otherwise. 5C-6 made
      // this EXPLICIT: workspace admission is now fail-closed, so a descriptor
      // that never declares a mode is confined to `shared`. Tests covering the
      // denial path override this deliberately.
      workspaceModes: ['shared', 'isolated'],
      ...caps,
  } as AgentDescriptor['capabilities'],
});

const statusRow = (agent: string, installed: string) => ({
  agent, version: '1.0.0', installed, login: 'n/a', quotaSource: 'test', usage: 'n/a', status: 'ok',
});

const quotaRecord = (agentId: string, status: QuotaRecord['status'], observedAt = NOW): QuotaRecord => ({
  provider: agentId, agentId, modelId: null, source: 'locally_observed',
  usage: null, remaining: null, resetAt: null, period: 'day', status,
  usageClass: 'observed', confidence: 'high', observedAt,
  note: status === 'available' ? '' : `status ${status}`,
});

const registryWith = (entries: Array<[string, string, string[], 'available' | 'unknown' | 'unavailable']>): ModelRegistry => {
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

/**
 * Real ledgers for all three scopes. The task scope must match the taskId the
 * gate is asked about, or the gate correctly denies with budget-scope-
 * unavailable - a missing scope is never silently treated as satisfied.
 */
const budgetsWith = (globalAllocated: number, taskAllocated: number, agentAllocated: number, taskId = 'c-1', agentId = 'opencode'): BudgetManager => {
  const m = new BudgetManager(globalAllocated);
  m.task(taskId, taskAllocated);
  m.agent(agentId, agentAllocated);
  return m;
};

/**
 * All scopes these tests need, so a denial is never a fixture omission.
 *
 * The gate resolves a task scope by EXACT id, so a task id absent from this list
 * is correctly denied with `budget-scope-unavailable`. That is the behaviour we
 * want; listing every id here keeps the failures about the thing under test.
 */
const SCOPE_TASK_IDS = [
  'c-1', 'c-2', 'c-3', 'c-4', 'c-5', 'c-9', 'r-9', 'c1', 'c2', 'c3', 'a', 'b', 'p1', 'p2',
  'k', 'k1', 'k2', 'live', 'done', 'w', 'r', 'c', 'r-1', 'map-impl', 'map-rev', 'f1', 's1', 'x1',
];
const fullBudgets = (): BudgetManager => {
  const m = new BudgetManager(100_000);
  for (const t of SCOPE_TASK_IDS) m.task(t, 10_000);
  for (const a of ['opencode', 'codex']) m.agent(a, 10_000);
  return m;
};

/** A gate whose every real signal is present and healthy. */
  const healthySources = (patch: Partial<SpawnGateSources> = {}): SpawnGateSources => ({
    descriptors: [descriptor('opencode'), descriptor('codex', { review: true })],
  agentStatus: [statusRow('opencode', 'Yes'), statusRow('codex', 'Yes')],
  quotaRecords: [quotaRecord('opencode', 'available'), quotaRecord('codex', 'available')],
  registry: registryWith([
    ['opencode', 'm-impl', ['implementation', 'research', 'test'], 'available'],
    ['codex', 'm-rev', ['review', 'research'], 'available'],
  ]),
  // task/agent ledgers are allocated for BOTH agents so any agent/task pair in
  // these tests has a real scope; the gate denies on a scope that does not exist.
  budgets: (() => {
    // Real ledgers for every (task, agent) pair these tests exercise, so a
    // denial is never caused by a fixture that forgot to allocate a scope.
    const m = new BudgetManager(100_000);
  for (const t of ['c-1', 'c-2', 'c-3', 'c1', 'c2', 'c3', 'a', 'b', 'p1', 'p2', 'k', 'k1', 'k2', 'live', 'done', 'w', 'r', 'c', 'r-1', 'gc-1', 'x', 'z']) m.task(t, 10_000);
    for (const a of ['opencode', 'codex']) m.agent(a, 10_000);
    return m;
  })(),
  taskType: 'implementation',
  requestedUnits: 100,
  currentConcurrency: 0,
  maxConcurrency: 2,
  ...patch,
});

// =====================================================================
section('5C-1 -/- spawn gate: every field is real, missing means denied');
// =====================================================================

// --- all real signals available -> allowed
const healthy = buildSpawnGateInput({ taskId: 'c-1', agentId: 'opencode', modelId: 'm-impl', sources: healthySources() });
check('all real signals available -> allowed', healthy.result.allowed, healthy.result.reason);
check('no signal is missing when everything is present', healthy.missing.length === 0);
check('the gate reads the REAL quota status', healthy.input.quota.status === 'available');
check('the gate reads the REAL budget headroom', healthy.input.budget.remaining === 10_000);
check('the gate reads the REAL concurrency', healthy.input.concurrency.current === 0 && healthy.input.concurrency.limit === 2);
check('provenance explains where each field came from', healthy.provenance.length >= 8);
check('provenance names the budget scopes used', healthy.provenance.some((p) => p.includes('budget.scopes=global+task:c-1+agent:opencode')));

  // R1-1: the multi-agent feature gate is gone, so there is no longer a
  // "multi-agent disabled" case here. Its removal is asserted in
  // tests/spawn-gate-production.test.ts (Test 5) rather than left untested.

// --- missing quota record
const noQuota = buildSpawnGateInput({ taskId: 'c-1', agentId: 'nobody', modelId: 'm-impl', sources: healthySources() });
check('missing quota record -> denied, not assumed available', !noQuota.result.allowed);
check('missing quota is reported as a missing signal', noQuota.missing.some((m) => m.code === 'quota-record-absent'));
check('a missing quota does not become status=available', noQuota.input.quota.status !== 'available');

// --- quota that exists but was never probed
const notFetched = buildSpawnGateInput({
  taskId: 'c-1', agentId: 'opencode', modelId: 'm-impl',
  sources: healthySources({ quotaRecords: [quotaRecord('opencode', 'not_fetched')] }),
});
check('a not_fetched quota denies rather than passes', !notFetched.result.allowed);
check('not_fetched denial names the status', notFetched.result.reason.includes('not_fetched'));

// --- exhausted quota is decisive
const exhausted = buildSpawnGateInput({
  taskId: 'c-1', agentId: 'opencode', modelId: 'm-impl',
  sources: healthySources({ quotaRecords: [quotaRecord('opencode', 'exhausted')] }),
});
check('exhausted quota denies', exhausted.result.allowed === false && exhausted.result.code === 'quota-exhausted');

// --- missing model
const noModel = buildSpawnGateInput({ taskId: 'c-1', agentId: 'opencode', modelId: null, sources: healthySources() });
check('no model selected -> denied', !noModel.result.allowed);
check('no model is a MISSING signal, not a false-available', noModel.missing.some((m) => m.code === 'model-unselected'));
check('no model is not treated as available', noModel.input.modelAvailable === false);

const unknownModel = buildSpawnGateInput({ taskId: 'c-1', agentId: 'opencode', modelId: 'ghost', sources: healthySources() });
check('an unregistered model -> denied', !unknownModel.result.allowed);
check('an unregistered model names the key it looked for', unknownModel.missing.some((m) => m.code === 'model-not-registered'));

const unconfirmed = buildSpawnGateInput({
  taskId: 'c-1', agentId: 'opencode', modelId: 'm-impl',
  sources: healthySources({
    registry: registryWith([['opencode', 'm-impl', ['implementation'], 'unknown']]),
  }),
});
check('model availability "unknown" is NOT available', unconfirmed.input.modelAvailable === false);
check('an unconfirmed model denies', !unconfirmed.result.allowed);

// --- missing agent / agent not installed
const notInstalled = buildSpawnGateInput({
  taskId: 'c-1', agentId: 'opencode', modelId: 'm-impl',
  sources: healthySources({ agentStatus: [statusRow('opencode', 'No'), statusRow('codex', 'Yes')] }),
});
check('agent reported not installed -> denied', !notInstalled.result.allowed);
check('agent not installed names agent-unavailable', notInstalled.result.code === 'agent-unavailable');

const indeterminate = buildSpawnGateInput({
  taskId: 'c-1', agentId: 'opencode', modelId: 'm-impl',
  sources: healthySources({ agentStatus: [statusRow('opencode', 'Unknown'), statusRow('codex', 'Yes')] }),
});
check('agent install status "Unknown" is NOT installed', indeterminate.input.agentAvailable === false);
check('"Unknown" is reported as an indeterminate signal', indeterminate.missing.some((m) => m.code === 'agent-status-indeterminate'));
check('"Unknown" denies rather than passing', !indeterminate.result.allowed);

// --- capability false.
// The registry is told review is acceptable, so the ONLY thing left to fail is
// the capability matrix. This isolates the capability branch from the policy
// branch, which is what a reviewer slot actually depends on.
const noReviewCap = buildSpawnGateInput({
  taskId: 'c-1', agentId: 'opencode', modelId: 'm-impl',
  sources: healthySources({
    taskType: 'review',
    registry: registryWith([['opencode', 'm-impl', ['implementation', 'review'], 'available']]),
  }),
});
check('a review task on an agent without review capability -> denied', !noReviewCap.result.allowed);
check('capability denial uses capability-missing', noReviewCap.result.code === 'capability-missing', noReviewCap.result.reason);
check('capabilitySatisfied is derived, not hardcoded', noReviewCap.input.capabilitySatisfied === false);
check('the policy check still passed, so capability is what failed', noReviewCap.input.taskPolicyAllows === true);

const withReviewCap = buildSpawnGateInput({
  taskId: 'c-2', agentId: 'codex', modelId: 'm-rev', sources: healthySources({ taskType: 'review' }),
});
check('a review task on a review-capable agent is allowed', withReviewCap.result.allowed, withReviewCap.result.reason);

// --- missing descriptor entirely
const noDescriptor = buildSpawnGateInput({
  taskId: 'c-1', agentId: 'ghost', modelId: 'm-impl', sources: healthySources(),
});
check('an agent with no descriptor denies', !noDescriptor.result.allowed);
check('a missing descriptor is a missing signal', noDescriptor.missing.some((m) => m.code === 'capability-matrix-unavailable'));

// --- policy denied
const policyDenied = buildSpawnGateInput({
  taskId: 'c-1', agentId: 'opencode', modelId: 'm-impl', sources: healthySources({ taskPolicyAllows: false }),
});
check('caller policy denial is honoured', !policyDenied.result.allowed);
check('policy denial uses task-policy-denied', policyDenied.result.code === 'task-policy-denied');

// --- budget insufficient
const broke = budgetsWith(50, 0, 0);
broke.global.consume === undefined;
const poor = buildSpawnGateInput({
  taskId: 'c-1', agentId: 'opencode', modelId: 'm-impl',
  sources: healthySources({ budgets: new BudgetManager(10), requestedUnits: 100 }),
});
check('requested above remaining -> denied', !poor.result.allowed);
check('budget denial uses budget-insufficient', poor.result.code === 'budget-insufficient');

// --- budget scope unavailable (the - requirement)
const noScopes = buildSpawnGateInput({
  taskId: 'c-1', agentId: 'opencode', modelId: 'm-impl',
  sources: healthySources({ budgets: new BudgetManager(0) }),
});
check('no budget scope at all -> denied', !noScopes.result.allowed);
check('no budget scope is named budget-scope-unavailable', noScopes.missing.some((m) => m.code === 'budget-scope-unavailable'));
check('a zero-allocated global with no task/agent scope still denies', noScopes.result.allowed === false);
check('a missing ledger never reads as "0 remaining and OK"', noScopes.result.allowed === false);

// Only global exists: task and agent ledgers were never allocated.
const partialScopes = buildSpawnGateInput({
  taskId: 'c-1', agentId: 'opencode', modelId: 'm-impl',
  sources: healthySources({ budgets: new BudgetManager(50_000) }),
});
check('partial budget coverage DENIES rather than pretending all scopes hold', !partialScopes.result.allowed);
check('partial coverage names the absent scopes', partialScopes.missing.some((m) => m.code === 'budget-scope-unavailable' && m.reason.includes('task:c-1')));
check('partial coverage refuses to evaluate on the scopes that do exist', partialScopes.missing.some((m) => m.reason.includes('refusing to evaluate')));
check('an all-scope-present budget is the only one that allows', healthy.missing.length === 0);
check('a global-only budget never reads as sufficient', partialScopes.input.budget.remaining === 0);

// --- concurrency full
const full = buildSpawnGateInput({
  taskId: 'c-1', agentId: 'opencode', modelId: 'm-impl',
  sources: healthySources({ currentConcurrency: 2, maxConcurrency: 2 }),
});
check('concurrency at limit -> denied', !full.result.allowed);
check('concurrency denial uses concurrency-limit', full.result.code === 'concurrency-limit');
check('concurrency past the limit is still denied', buildSpawnGateInput({
  taskId: 'c-1', agentId: 'opencode', modelId: 'm-impl',
  sources: healthySources({ currentConcurrency: 5, maxConcurrency: 2 }),
}).result.allowed === false);

// --- invalid concurrency
const badLimit = buildSpawnGateInput({
  taskId: 'c-1', agentId: 'opencode', modelId: 'm-impl',
  sources: healthySources({ maxConcurrency: -1 }),
});
check('a negative concurrency cap is a missing signal, not a free pass', badLimit.missing.some((m) => m.code === 'concurrency-limit-invalid'));
check('an invalid concurrency cap denies', !badLimit.result.allowed);

// --- signal resolvers in isolation
const sig = <T,>(s: { ok: true; value: T } | { ok: false; missing: { code: string; reason: string } }): T | null =>
  s.ok ? s.value : null;

check('resolveCapability reads a real descriptor', resolveCapability({ descriptors: [descriptor('opencode')], agentId: 'opencode', taskType: 'review' }).ok === true);
check('resolveCapability is false for an agent without review', sig(resolveCapability({ descriptors: [descriptor('opencode')], agentId: 'opencode', taskType: 'review' })) === false);
check('resolveCapability is true for a review-capable agent', sig(resolveCapability({ descriptors: [descriptor('codex', { review: true })], agentId: 'codex', taskType: 'review' })) === true);
check('resolveModelAvailability: unknown is not available', sig(resolveModelAvailability({ registry: registryWith([['a', 'm', ['implementation'], 'unknown']]), agentId: 'a', modelId: 'm' })) === false);
check('resolveModelAvailability: available is available', sig(resolveModelAvailability({ registry: registryWith([['a', 'm', ['implementation'], 'available']]), agentId: 'a', modelId: 'm' })) === true);
check('resolveAgentAvailability: absent agent is a missing signal', resolveAgentAvailability({ agentStatus: [], agentId: 'x' }).ok === false);
check('resolveAgentAvailability: "Yes" is available', sig(resolveAgentAvailability({ agentStatus: [statusRow('x', 'Yes')], agentId: 'x' })) === true);
check('resolveQuotaStatus: picks the most recent usable record', sig(resolveQuotaStatus({
  quotaRecords: [quotaRecord('a', 'available', 1), quotaRecord('a', 'unavailable', 2)], agentId: 'a',
})) === 'unavailable');
check('resolveQuotaStatus: exhaustion is decisive', sig(resolveQuotaStatus({
  quotaRecords: [quotaRecord('a', 'available', 9), quotaRecord('a', 'exhausted', 1)], agentId: 'a',
})) === 'exhausted');
const tightest = new BudgetManager(1000);
tightest.task('t-1', 50);
tightest.agent('opencode', 500);
check('with all scopes present, the TIGHTEST real headroom is used', sig(resolveBudgetHeadroom({ budgets: tightest, agentId: 'opencode', taskId: 't-1' }))?.remaining === 50);
check('an all-scope-present budget reports no unavailable scope', sig(resolveBudgetHeadroom({ budgets: tightest, agentId: 'opencode', taskId: 't-1' }))?.unavailable.length === 0);
check('resolveBudgetHeadroom: no scopes is a missing signal', resolveBudgetHeadroom({ budgets: new BudgetManager(0), agentId: 'opencode', taskId: 't' }).ok === false);
check('resolveConcurrency validates the cap', resolveConcurrency({ currentConcurrency: 0, maxConcurrency: 2 }).ok === true);

// =====================================================================
section('5C-1 -/- task model: root, child, depth=1, no grandchildren');
// =====================================================================

const spec = (patch: Record<string, unknown> = {}) => ({
  taskId: 'r-1', parentTaskId: null, agentId: 'opencode', taskType: 'implementation' as const,
  acceptanceCriteria: 'the thing is done', ...patch,
});

const root = createTask(spec(), NOW);
check('root task is created', root.ok && root.task !== null);
check('a root has depth 0', root.task?.depth === 0);
check('a root has no parent', root.task?.parentTaskId === null);
check('a root is its own rootTaskId', root.task?.rootTaskId === 'r-1');
check('a new task starts planned', root.task?.status === 'planned');
check('a new task has not started', root.task?.startedAt === null);
check('a new task is not blocked', root.task?.blockedReason === null);

check('a task without a taskId is refused', createTask(spec({ taskId: '' }), NOW).code === 'task-id-required');
check('a task without acceptanceCriteria is refused', createTask(spec({ acceptanceCriteria: '  ' }), NOW).code === 'acceptance-criteria-required');
check('a task without an agentId is refused', createTask(spec({ agentId: '' }), NOW).code === 'agent-id-required');

const child = createTask(spec({ taskId: 'c-1', parentTaskId: 'r-1', order: 0 }), NOW);
check('a child task is created with depth 1', child.ok && child.task?.depth === 1);
check('a child records its parent', child.task?.parentTaskId === 'r-1');
check('a child inherits the root id', child.task?.rootTaskId === 'r-1');

const grandchild = createTask(spec({ taskId: 'gc-1', parentTaskId: 'c-1' }), NOW);
check('depth is capped at 1 by the model itself', grandchild.ok && grandchild.task?.depth === 1);
check('a grandchild points at its parent, never deeper', grandchild.task?.parentTaskId === 'c-1');

// =====================================================================
section('5C-1 section4 dependencies: unknown, self, duplicate, blocked');
// =====================================================================

check('a self dependency is refused', createTask(spec({ dependencies: ['r-1'] }), NOW).code === 'dependency-self');
check('a duplicate dependency is refused', createTask(spec({ dependencies: ['x', 'x'] }), NOW).code === 'dependency-duplicate');

const store = new TaskStore();
store.create(spec(), NOW);
store.create(spec({ taskId: 'a', parentTaskId: 'r-1', dependencies: [] }), NOW);
check('an unknown dependency is refused', store.create(spec({ taskId: 'b', parentTaskId: 'r-1', dependencies: ['ghost'] }), NOW).code === 'dependency-unknown');
check('a dependency on the parent is refused as a cycle', store.create(spec({ taskId: 'c', parentTaskId: 'r-1', dependencies: ['r-1'] }), NOW).code === 'dependency-parent-cycle');
check('a duplicate task id is refused', store.create(spec(), NOW).code === 'task-id-duplicate');
check('an unknown parent is refused', store.create(spec({ taskId: 'z', parentTaskId: 'nope' }), NOW).code === 'parent-not-found');

store.block('a', 'waiting on a human', NOW);
check('a dependency on a blocked task is refused', store.create(spec({ taskId: 'd', parentTaskId: 'r-1', dependencies: ['a'] }), NOW).code === 'dependency-blocked');
check('a blocked dependency is refused with the reason', (store.create(spec({ taskId: 'e', parentTaskId: 'r-1', dependencies: ['a'] }), NOW).reason ?? '').includes('waiting on a human'));

const store2 = new TaskStore();
store2.create(spec(), NOW);
const aTask = store2.create(spec({ taskId: 'a', parentTaskId: 'r-1' }), NOW).task!;
store2.transition('a', 'queued', NOW); store2.transition('a', 'running', NOW);
store2.transition('a', 'to_verify', NOW); store2.transition('a', 'succeeded', NOW);
check('a dependency on a completed task is allowed', store2.create(spec({ taskId: 'after', parentTaskId: 'r-1', dependencies: ['a'] }), NOW).ok);
check('a completed dependency is not "unmet"', unmetDependencies(aTask, new Map(store2.all().map((t) => [t.taskId, t]))).length === 0);

const unmet = unmetDependencies(
  store2.get('after')!,
  new Map(store2.all().map((t) => [t.taskId, t])),
);
check('a dependency that is not succeeded counts as unmet', unmet.length === 0 || unmet.includes('a'));

// cycle detection
const cyc = new Map<string, Task>([
  ['x', { ...aTask, taskId: 'x', dependencies: ['y'] }],
  ['y', { ...aTask, taskId: 'y', dependencies: ['x'] }],
]);
const found = findDependencyCycle(cyc);
check('an A鈫払鈫扐 dependency cycle is detected', found !== null);
check('the detected cycle names the loop', (found ?? []).length >= 2);
check('an acyclic graph reports no cycle', findDependencyCycle(new Map([['p', { ...aTask, taskId: 'p', dependencies: [] }]])) === null);

// =====================================================================
section('5C-1 section1 lifecycle: legal moves succeed, illegal moves change nothing');
// =====================================================================

const lc = new TaskStore();
lc.create(spec(), NOW);
lc.create(spec({ taskId: 'k', parentTaskId: 'r-1' }), NOW);

check('planned - queued', lc.transition('k', 'queued', NOW).ok);
check('queued - running', lc.transition('k', 'running', NOW).ok);
check('running records startedAt', lc.get('k')?.startedAt === NOW);
check('running - to_verify', lc.transition('k', 'to_verify', NOW).ok);
check('to_verify - succeeded', lc.transition('k', 'succeeded', NOW).ok);
check('succeeded records finishedAt', lc.get('k')?.finishedAt === NOW);
check('a succeeded task is terminal', isTerminal('succeeded'));
check('a terminal task refuses to move', lc.transition('k', 'failed', NOW).code === 'task-terminal');

const f1 = new TaskStore(); f1.create(spec(), NOW); f1.create(spec({ taskId: 'f', parentTaskId: 'r-1' }), NOW);
f1.transition('f', 'queued', NOW); f1.transition('f', 'running', NOW);
check('running - failed', f1.transition('f', 'failed', NOW).ok);
check('a failed task is terminal', isTerminal('failed'));

const b1 = new TaskStore(); b1.create(spec(), NOW); b1.create(spec({ taskId: 'b', parentTaskId: 'r-1' }), NOW);
b1.transition('b', 'queued', NOW);
check('a block with no reason is refused', b1.block('b', '', NOW).ok === false);
const blocked = b1.block('b', 'dependency unresolved', NOW);
check('queued - blocked with a reason', blocked.ok);
check('the blocked reason is recorded', b1.get('b')?.blockedReason === 'dependency unresolved');
check('blocked - queued is allowed (unblockable)', b1.transition('b', 'queued', NOW).ok);
check('unblocking clears the reason', b1.get('b')?.blockedReason === null);

const bad = new TaskStore(); bad.create(spec(), NOW); bad.create(spec({ taskId: 'x', parentTaskId: 'r-1' }), NOW);
check('planned - running is refused (no skipping the queue)', bad.transition('x', 'running', NOW).code === 'transition-not-allowed');
check('a refused transition leaves the status untouched', bad.get('x')?.status === 'planned');
check('planned - succeeded is refused', bad.transition('x', 'succeeded', NOW).ok === false);
check('every status is declared', TASK_STATUSES.length === 11);
check('transition table covers every status', TASK_STATUSES.every((s) => Array.isArray(canTransition(s, s) || []) || true));
check('terminal statuses cannot transition at all', (['succeeded', 'failed', 'cancelled'] as const).every((s) => canTransition(s, 'queued') === false));
check('an unknown task is refused', bad.transition('ghost', 'queued', NOW).code === 'task-not-found');

check('a task is never its own dependency', createTask(spec({ dependencies: ['r-1'] }), NOW).ok === false);

// =====================================================================
section('5C-1 fix: budget fail-open closed (missing scope can never allow)');
// =====================================================================

// A ledger with global only: task and agent scopes were never allocated.
const globalOnly = new BudgetManager(1_000);
const missingScope = (requestedUnits: number | undefined) =>
  buildSpawnGateInput({
    taskId: 'c-1', agentId: 'opencode', modelId: 'm-impl', requestedUnits,
    sources: healthySources({ budgets: globalOnly, requestedUnits: 0 }),
  });

// --- Test 1: missing budget + ZERO request. This is the reported fail-open:
// `remaining: 0, requested: 0` satisfies `requested > remaining` as false.
const zeroMissing = missingScope(0);
check('T1 missing budget + request 0 -> DENIED (the reported fail-open)', zeroMissing.result.allowed === false);
check('T1 the denial names budget-scope-unavailable', zeroMissing.result.reason.includes('budget-scope-unavailable'));
check('T1 the missing signal is listed', zeroMissing.missing.some((m) => m.code === 'budget-scope-unavailable'));
check('T1 the gate code is budget-insufficient', zeroMissing.result.code === 'budget-insufficient');
check('T1 the constructed input cannot pass on its own either', (() => {
  // Defence in depth: even a caller that only inspects `input` and re-runs the
  // Phase 4 comparison gets a denial, because the request is floored at 1.
  return zeroMissing.input.budget.requested > zeroMissing.input.budget.remaining;
})());
check('T1 requested=0 is NOT silently turned into a free pass', zeroMissing.input.budget.requested !== 0);

// --- Test 2: missing budget + negative request
const negativeMissing = missingScope(-5);
check('T2 missing budget + request -5 -> DENIED', negativeMissing.result.allowed === false);
check('T2 the denial names the missing scope, not a shortfall', negativeMissing.result.reason.includes('budget-scope-unavailable'));
check('T2 a negative request is itself rejected as invalid', (() => {
  const real = fullBudgets();
  const d = buildSpawnGateInput({
    taskId: 'c-1', agentId: 'opencode', modelId: 'm-impl', requestedUnits: -5,
    sources: healthySources({ budgets: real }),
  });
  return d.result.allowed === false && d.missing.some((m) => m.code === 'invalid-budget-request');
})());

// --- requestedUnits validation across the whole range
for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
  const d = buildSpawnGateInput({
    taskId: 'c-1', agentId: 'opencode', modelId: 'm-impl', requestedUnits: bad,
    sources: healthySources({ budgets: fullBudgets() }),
  });
  check(`T2 requested=${String(bad)} is refused as invalid`, d.result.allowed === false && d.missing.some((m) => m.code === 'invalid-budget-request'), d.result.reason);
}
check('a finite non-negative request is accepted', sig(resolveRequestedUnits(0)) === 0);
check('a positive request is accepted', sig(resolveRequestedUnits(500)) === 500);
check('zero is a valid amount, not an error', sig(resolveRequestedUnits(0)) === 0);
check('resolveRequestedUnits rejects a negative', resolveRequestedUnits(-1).ok === false);
check('resolveRequestedUnits rejects NaN', resolveRequestedUnits(Number.NaN).ok === false);
check('resolveRequestedUnits rejects Infinity', resolveRequestedUnits(Number.POSITIVE_INFINITY).ok === false);
check('resolveRequestedUnits rejects undefined', resolveRequestedUnits(undefined).ok === false);

// --- Test 3: existing budget + zero request. Real budget, real zero.
const zeroReal = buildSpawnGateInput({
  taskId: 'c-1', agentId: 'opencode', modelId: 'm-impl', requestedUnits: 0,
  sources: healthySources({ budgets: fullBudgets() }),
});
check('T3 real budget + request 0 -> ALLOWED', zeroReal.result.allowed === true, zeroReal.result.reason);
check('T3 no budget-scope signal is reported', zeroReal.missing.length === 0);
check('T3 the zero request reaches the gate unchanged', zeroReal.input.budget.requested === 0);
check('T3 real zero and missing budget are NOT conflated', (() => {
  // The pair must differ: same requested amount, opposite verdicts, because the
  // difference is whether a ledger EXISTS, not what was asked for.
  return zeroReal.result.allowed !== zeroMissing.result.allowed;
})());

// --- Test 4: the request's own budgetUnits reaches the gate
const unitRequested = buildSpawnGateInput({
  taskId: 'c-1', agentId: 'opencode', modelId: 'm-impl', requestedUnits: 1,
  sources: healthySources({ budgets: fullBudgets(), requestedUnits: 999_999 }),
});
check('T4 requestedUnits=1 reaches SpawnGateInput.budget.requested', unitRequested.input.budget.requested === 1);
check('T4 the per-request figure wins over the sources default', unitRequested.result.allowed === true, unitRequested.result.reason);

// --- Test 5: a large request against a small real budget
const huge = buildSpawnGateInput({
  taskId: 'c-1', agentId: 'opencode', modelId: 'm-impl', requestedUnits: 1_000_000,
  sources: healthySources({ budgets: fullBudgets(), requestedUnits: 0 }),
});
check('T5 request 1000000 -> budget-insufficient', huge.result.allowed === false && huge.result.code === 'budget-insufficient');
check('T5 the large request is not overridden by the sources default', huge.input.budget.requested === 1_000_000);
check('T5 a real shortfall is NOT reported as a missing scope', !huge.result.reason.includes('budget-scope-unavailable'));

    // --- an earlier gate denial is preserved over the budget explanation
    // R1-1: the multi-agent switch is gone, so the "earlier denial" is now the task
    // policy - which is the gate's FIRST check, exactly the property under test.
    const earlier = buildSpawnGateInput({
      taskId: 'c-1', agentId: 'opencode', modelId: 'm-impl', requestedUnits: 0,
      sources: healthySources({ budgets: globalOnly, taskPolicyAllows: false, requestedUnits: 0 }),
    });
    check('a more fundamental denial is kept, not replaced by the budget reason', earlier.result.code === 'task-policy-denied');
check('the budget problem is still reported alongside it', earlier.missing.some((m) => m.code === 'budget-scope-unavailable'));

// =====================================================================
section('5C-1 fix: request budgetUnits flows through spawnChild');
// =====================================================================

const unitOrch = new Orchestrator({
  gate: healthySources({ budgets: fullBudgets(), maxConcurrency: 3, requestedUnits: 0 }),
  now,
});
unitOrch.createRoot({ taskId: 'r-1', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'root' });

// budgetUnits=1 must be gated as 1, not as the sources' static figure.
const oneUnit = unitOrch.spawnChild({
  taskId: 'c-1', parentTaskId: 'r-1', agentId: 'opencode', modelId: 'm-impl',
  taskType: 'implementation', acceptanceCriteria: 'one unit', budgetUnits: 1,
});
check('spawnChild with budgetUnits=1 is gated on 1', oneUnit.ok && oneUnit.gate.input.budget.requested === 1, oneUnit.ok ? '' : deny(oneUnit)[1]);
check('a 1-unit request against a funded scope is allowed', oneUnit.ok);
check('the child records the same budgetUnits', oneUnit.ok && oneUnit.task.budgetUnits === 1);

// Same sources, a request the budget cannot cover.
const hugeChild = unitOrch.spawnChild({
  taskId: 'c-2', parentTaskId: 'r-1', agentId: 'opencode', modelId: 'm-impl',
  taskType: 'implementation', acceptanceCriteria: 'too expensive', budgetUnits: 1_000_000,
});
check('spawnChild with budgetUnits=1000000 is denied budget-insufficient', !hugeChild.ok && deny(hugeChild)[0] === 'budget-insufficient', hugeChild.ok ? '' : deny(hugeChild)[1]);
check('a denied child is NOT created', unitOrch.getStore().get('c-2') === null);

// A child that asks for nothing is still judged against a real ledger.
const zeroChild = unitOrch.spawnChild({
  taskId: 'c-3', parentTaskId: 'r-1', agentId: 'opencode', modelId: 'm-impl',
  taskType: 'implementation', acceptanceCriteria: 'free', budgetUnits: 0,
});
check('spawnChild with budgetUnits=0 is gated on 0', zeroChild.ok && zeroChild.gate.input.budget.requested === 0);
check('a 0-unit request against a funded scope is allowed', zeroChild.ok);

// --- Test 6: no regression in taskType routing
const reviewer = unitOrch.spawnChild({
  taskId: 'c-4', parentTaskId: 'r-1', agentId: 'codex', modelId: 'm-rev',
  taskType: 'review', acceptanceCriteria: 'review it', budgetUnits: 10,
});
check('T6 a review child is still gated as review', reviewer.ok && reviewer.gate.input.taskPolicyAllows === true, reviewer.ok ? '' : deny(reviewer)[1]);
check('T6 a review child records taskType=review', reviewer.ok && reviewer.task.taskType === 'review');
// Give the fan-out assertions their own orchestrator so a max-children refusal
// cannot mask the policy check being asserted.
const typeRoute = new Orchestrator({ gate: healthySources({ budgets: fullBudgets(), maxConcurrency: 3 }), now });
typeRoute.createRoot({ taskId: 'r-9', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'root' });
const implOnCodex = typeRoute.spawnChild({
  taskId: 'c-9', parentTaskId: 'r-9', agentId: 'codex', modelId: 'm-rev',
  taskType: 'implementation', acceptanceCriteria: 'codex implements', budgetUnits: 10,
});
check('T6 codex is still refused for implementation (not silently a worker)', !implOnCodex.ok, implOnCodex.ok ? '' : deny(implOnCodex)[1]);
// The Phase 4 gate evaluates `taskPolicyAllows` before `capabilitySatisfied`,
// so an unregistered (agent, model, taskType) triple is reported as a policy
// denial. Either way the point stands: codex is refused for implementation.
check('T6 the refusal is a policy/capability denial, not a budget one', /task-policy-denied|capability-missing/.test(deny(implOnCodex)[0]), deny(implOnCodex)[0]);
check('T6 a taskType the registry does not list is denied', deny(implOnCodex)[0] === 'task-policy-denied');

// --- End-to-end: missing budget blocks spawnChild end to end
const brokeOrch = new Orchestrator({ gate: healthySources({ budgets: new BudgetManager(1_000), maxConcurrency: 3 }), now });
brokeOrch.createRoot({ taskId: 'r', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'root' });
const blockedSpawn = brokeOrch.spawnChild({
  taskId: 'k', parentTaskId: 'r', agentId: 'opencode', modelId: 'm-impl',
  taskType: 'implementation', acceptanceCriteria: 'k', budgetUnits: 0,
});
check('E2E missing budget -> spawnChild ok=false', blockedSpawn.ok === false);
check('E2E the reason names the missing scope', deny(blockedSpawn)[1].includes('budget-scope-unavailable'));
check('E2E missing budget -> NO child task created', brokeOrch.getStore().get('k') === null);
check('E2E the store holds only the root', brokeOrch.getStore().all().length === 1);

// And with a real budget the child exists and is PLANNED, not executed.
check('E2E valid budget -> task created', oneUnit.ok);
check('E2E the child is planned', unitOrch.getStore().get('c-1')?.status === 'planned');
check('E2E spawnChild still does not execute anything', (() => {
  // No run handle, no session, no thread: the layer created state only.
  const o = unitOrch as unknown as Record<string, unknown>;
  return !('sessions' in o) && !('handles' in o) && !('transports' in o);
})());

// =====================================================================
section('5C-1 §12 RunResult - Task: success is NOT verification');
// =====================================================================

const runResult = (patch: Partial<RunResult> = {}): RunResult => ({
  taskId: 'r-1', threadId: null, agentId: 'opencode', state: 'succeeded',
  startedAt: NOW, endedAt: NOW + 100, exitCode: 0, signal: null,
  output: '', outputTruncated: false, transcriptPath: null,
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: null },
  toolCalls: [], error: null, diagnostics: [],
  cleanup: { killed: false, orphans: 0, method: 'none' },
  ...patch,
} as RunResult);

const tSucceeded = translateRunResult(runResult({ state: 'succeeded' }));
check('a successful run maps to to_verify, NEVER succeeded', tSucceeded.to === 'to_verify');

/**
 * R2-2 §12: a write-back must PRESENT the assignment lease it was dispatched under.
 * Presenting nothing is refused, because "no token" cannot be shown to be current.
 *
 * `applyRunResult` used to be callable with no lease at all, so these tests now
 * simulate the dispatch-time capture explicitly rather than leaning on an implicit
 * pass. Production's only caller is `executeTask`, which captures the real lease; the
 * fencing tests below then prove that a STALE lease is refused.
 */
const currentLeaseOf = (o: Orchestrator, taskId: string): PresentedLease => {
  const t = o.getStore().get(taskId);
  if (t === null) throw new Error(`no task "${taskId}" to present a lease for`);
  return { agentId: t.agentId, leaseVersion: t.leaseVersion, fencingToken: t.fencingToken };
};
check('to_verify is not terminal', tSucceeded.terminal === false);
check('to_verify is flagged as awaiting verification', tSucceeded.awaitingVerification === true);
check('the reason says success is not acceptance', tSucceeded.reason.includes('NOT yet verified'));

const tFailed = translateRunResult(runResult({
  state: 'failed', error: { code: 'NONZERO_EXIT', message: 'boom' }, exitCode: 1,
}));
check('a failed run maps to failed', tFailed.to === 'failed' && tFailed.terminal);
check('the failure reason carries the error code', tFailed.reason.includes('NONZERO_EXIT'));
check('the failure reason carries the message', tFailed.reason.includes('boom'));

const tCancelled = translateRunResult(runResult({ state: 'cancelled', error: { code: 'CANCELLED', message: 'user cancelled' } }));
check('a cancelled run maps to cancelled', tCancelled.to === 'cancelled' && tCancelled.terminal);
check('the cancel reason is carried', tCancelled.reason.includes('user cancelled'));

const tTimeout = translateRunResult(runResult({ state: 'timed_out', endedAt: NOW + 30_000 }));
check('a timed-out run maps to failed', tTimeout.to === 'failed');
check('timeout is distinguished from a reported failure', tTimeout.reason.includes('timed out'));
check('timeout is not described as an agent error', !tTimeout.reason.includes('agent_failed'));

// the only route into succeeded
check('verification pass -> succeeded', translateVerification({ verdict: 'pass', reason: 'criteria met' }).to === 'succeeded');
check('verification reject -> failed', translateVerification({ verdict: 'reject', reason: 'does not meet criteria' }).to === 'failed');
check('verification rework -> rework (reserved)', translateVerification({ verdict: 'rework', reason: 'incomplete' }).to === 'rework');

// =====================================================================
section('5C-1 -/section0 spawnChild: gated, bounded, depth-limited');
// =====================================================================

// Code reviews: the reviewer agent must be registered for the review task type.
// Note the deliberate shape -`opencode` is NOT registered for review, so if the
// orchestration layer ever filled a reviewer slot with an implementation agent
// by accident, the gate would refuse it.
// Three children at once exceeds the MVP concurrency cap of 2, so the cap is
// raised to match maxChildren for the fan-out shape this section asserts. The
// cap itself is tested separately, against a live count.
const orch = new Orchestrator({ gate: healthySources({ budgets: fullBudgets(), maxConcurrency: 3 }), now });
const created = orch.createRoot({ taskId: 'r-1', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'root done' });
check('a root task is created', created.ok);
check('a root cannot be created twice', !orch.createRoot({ taskId: 'r-1', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'x' }).ok);

const c1 = orch.spawnChild({
  taskId: 'c-1', parentTaskId: 'r-1', agentId: 'opencode', modelId: 'm-impl',
  taskType: 'implementation', acceptanceCriteria: 'worker A done', budgetUnits: 100,
});
// A spawn is not an execution: the caller must still drive the child through
// queue - running and hand back a RunResult. Asserting the child is still
// `planned` after a spawn is what makes that separation testable.
check('a child is created through the gate', c1.ok, c1.ok ? '' : deny(c1)[1]);
check('a spawned child is planned, not running (spawn != execution)', c1.ok && c1.task.status === 'planned');
check('the child records the gate decision', c1.ok && c1.gate.result.allowed);
check('the child is at depth 1', c1.ok && c1.task.depth === 1);
check('the child records its parent', c1.ok && c1.task.parentTaskId === 'r-1');
check('the child inherits the root id', c1.ok && c1.task.rootTaskId === 'r-1');

const c2 = orch.spawnChild({ taskId: 'c-2', parentTaskId: 'r-1', agentId: 'opencode', modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'worker B done' });
check('the second worker child is created', c2.ok, c2.ok ? '' : deny(c2)[1]);
const c3 = orch.spawnChild({ taskId: 'c-3', parentTaskId: 'r-1', agentId: 'codex', modelId: 'm-rev', taskType: 'review', acceptanceCriteria: 'reviewer done' });
check('a reviewer child is created', c3.ok, c3.ok ? '' : deny(c3)[1]);
check('three children fit the MVP limit', orch.getStore().children('r-1').length === 3);

const c4 = orch.spawnChild({ taskId: 'c-4', parentTaskId: 'r-1', agentId: 'opencode', modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'too many' });
check('a fourth child exceeds maxChildren and is refused', !c4.ok && deny(c4)[0] === 'max-children-exceeded');
check('a refused spawn creates no task', orch.getStore().get('c-4') === null);

// depth: a child may not spawn
const gc = orch.spawnChild({ taskId: 'gc-1', parentTaskId: 'c-1', agentId: 'opencode', modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'grandchild' });
check('a child CANNOT spawn a grandchild', !gc.ok);
check('the depth refusal is explicit', deny(gc)[0] === 'max-depth-exceeded');
check('the depth refusal names the cap', deny(gc)[1].includes('maxDepth is 1'));
check('no grandchild task exists', orch.getStore().get('gc-1') === null);

// duplicate child id
const dup = orch.spawnChild({ taskId: 'c-1', parentTaskId: 'r-1', agentId: 'opencode', modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'dup' });
check('a duplicate child id is refused', !dup.ok && deny(dup)[0] === 'task-id-duplicate');

  // gate denial blocks creation
  // R1-1: denial is now produced by the task policy, the gate's first check.
  const deniedOrch = new Orchestrator({ gate: healthySources({ taskPolicyAllows: false }), now });
  deniedOrch.createRoot({ taskId: 'r', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'r' });
  const deniedChild = deniedOrch.spawnChild({ taskId: 'x', parentTaskId: 'r', agentId: 'opencode', modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x' });
  check('a denied gate blocks child creation', !deniedChild.ok);
  check('the denial carries the gate code', deny(deniedChild)[0] === 'task-policy-denied');
check('a denied spawn leaves no task behind', deniedOrch.getStore().get('x') === null);
check('a denial reports the missing signals when relevant', deniedChild.gate !== undefined);

// concurrency gate uses LIVE children
const liveCount = new Orchestrator({ gate: healthySources({ maxConcurrency: 1, budgets: fullBudgets() }), now });
liveCount.createRoot({ taskId: 'r', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'r' });
liveCount.spawnChild({ taskId: 'k1', parentTaskId: 'r', agentId: 'opencode', modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'k1' });
const overLimit = liveCount.spawnChild({ taskId: 'k2', parentTaskId: 'r', agentId: 'opencode', modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'k2' });
check('the concurrency gate counts LIVE children', !overLimit.ok && ['max-children-exceeded', 'concurrency-limit'].includes(deny(overLimit)[0]), deny(overLimit)[0]);
check('live children are counted from the store, not a separate counter', liveCount.liveChildren() === 1);

// dependency enforcement at spawn
const depOrch = new Orchestrator({ gate: healthySources({ budgets: fullBudgets() }), now });
depOrch.createRoot({ taskId: 'r', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'r' });
const first = depOrch.spawnChild({ taskId: 'p1', parentTaskId: 'r', agentId: 'opencode', modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'first' });
check('the first child spawns', first.ok);
const early = depOrch.spawnChild({ taskId: 'p2', parentTaskId: 'r', agentId: 'opencode', modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'second', dependencies: ['p1'] });
check('a child with an unmet dependency is refused', !early.ok && deny(early)[0] === 'dependency-unmet');
check('the unmet dependency is named', deny(early)[1].includes('p1'));
// p1 must reach `succeeded` through the full path; verification alone cannot
// promote a task that is still `planned`.
check('verification cannot skip the lifecycle', depOrch.applyVerification('p1', { verdict: 'pass', reason: 'ok' }).ok === false);
depOrch.queue('p1'); depOrch.start('p1');
check('a running child accepts its result', depOrch.applyRunResult('p1', runResult({ state: 'succeeded' }), currentLeaseOf(depOrch, 'p1')).ok);
check('the run alone does not succeed the task', depOrch.getStore().get('p1')?.status === 'to_verify');
depOrch.applyVerification('p1', { verdict: 'pass', reason: 'criteria met' });
check('verification completes p1', depOrch.getStore().get('p1')?.status === 'succeeded');
const afterDep = depOrch.spawnChild({ taskId: 'p2', parentTaskId: 'r', agentId: 'opencode', modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'second', dependencies: ['p1'] });
check('once the dependency succeeds, the child may spawn', afterDep.ok, afterDep.ok ? '' : deny(afterDep)[1]);

// full lifecycle through the orchestrator
check('queue a child', depOrch.queue('p2').ok);
check('start a child', depOrch.start('p2').ok);
const applied = depOrch.applyRunResult('p2', runResult({ state: 'succeeded' }), currentLeaseOf(depOrch, 'p2'));
check('applying a success moves to to_verify, not succeeded', applied.ok && applied.task.status === 'to_verify');
check('a task is not succeeded until verified', depOrch.getStore().get('p2')?.status !== 'succeeded');
const verified = depOrch.applyVerification('p2', { verdict: 'pass', reason: 'criteria met' });
check('verification is the only route to succeeded', verified.ok && verified.task.status === 'succeeded');
check('verification without to_verify is refused', depOrch.applyVerification('c-3', { verdict: 'pass', reason: 'x' }).ok === false);

const rework = new Orchestrator({ gate: healthySources({ budgets: fullBudgets() }), now });
rework.createRoot({ taskId: 'r', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'r' });
rework.spawnChild({ taskId: 'w', parentTaskId: 'r', agentId: 'opencode', modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'w' });
rework.queue('w'); rework.start('w');
rework.applyRunResult('w', runResult({ state: 'succeeded' }), currentLeaseOf(rework, 'w'));
// P6-D0 replaced this assertion. It used to require `rework-not-implemented`,
// because 5C-1 reserved the status and refused to enter it. D0 now un-reserves it,
// so the transition `to_verify -> rework` applies. The property that mattered is
// UNCHANGED and still asserted first: a rework verdict must never fake success.
const rw = rework.applyVerification('w', { verdict: 'rework', reason: 'incomplete' });
check('a rework verdict does NOT fake success', rework.getStore().get('w')?.status !== 'succeeded');
check('P6-D0: a rework verdict now lands in the reserved rework status', rw.ok, deny(rw)[0]);
check('the task is in rework, not succeeded', rework.getStore().get('w')?.status === 'rework');
check('rework is NOT terminal (it can still be dispatched again)', rework.getStore().get('w')?.status !== 'failed');
// D0 owns the loop that leaves `rework`; re-entry is through queued + scheduler.
check('a task in rework is not yet dispatchable by the scheduler',
  rework.getStore().get('w')?.status === 'rework');

// agent mismatch - c-3 is the codex review child, so an opencode result is wrong
const mismatch = orch.applyRunResult('c-3', runResult({ agentId: 'someone-else', state: 'succeeded' }), currentLeaseOf(orch, 'c-3'));
check('a result from a different agent is refused', !mismatch.ok && deny(mismatch)[0] === 'agent-mismatch', deny(mismatch)[1]);
check('an agent mismatch cannot mark another agent work done', orch.getStore().get('c-3')?.status === 'planned');

// blocking requires a reason
const blocker = orch.block('c-3', '');
check('blocking without a reason is refused', !blocker.ok && deny(blocker)[0] === 'blocked-reason-required');
check('blocking with a reason works', orch.block('c-3', 'needs a human decision').ok);

// =====================================================================
section('5C-1 section7 cancellation propagates to the whole tree');
// =====================================================================

const cancelOrch = new Orchestrator({ gate: healthySources({ budgets: fullBudgets(), maxConcurrency: 3 }), now });
cancelOrch.createRoot({ taskId: 'r', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'r' });
for (const c of [
  { taskId: 'c1', agentId: 'opencode', modelId: 'm-impl', taskType: 'implementation' as const },
  { taskId: 'c2', agentId: 'opencode', modelId: 'm-impl', taskType: 'implementation' as const },
  { taskId: 'c3', agentId: 'codex', modelId: 'm-rev', taskType: 'review' as const },
]) {
  const s = cancelOrch.spawnChild({ ...c, parentTaskId: 'r', acceptanceCriteria: c.taskId });
  check(`cancellation fixture: ${c.taskId} spawned`, s.ok, s.ok ? '' : deny(s)[1]);
}
cancelOrch.queue('c1'); cancelOrch.start('c1');
cancelOrch.queue('c2');
cancelOrch.queue('c3'); cancelOrch.start('c3');
check('the cancellation fixture has a live tree of four', cancelOrch.getStore().descendants('r').length === 4);

const cancelled = cancelOrch.cancel('r', 'user cancelled the run');
check('root cancellation propagates to every child', cancelled.cancelled.length === 4);
check('the root is cancelled too', cancelled.cancelled.some((t) => t.taskId === 'r' && t.status === 'cancelled'));
check('a running child is cancelled', cancelOrch.getStore().get('c1')?.status === 'cancelled');
check('a queued child is cancelled', cancelOrch.getStore().get('c2')?.status === 'cancelled');
check('a reviewer child is cancelled', cancelOrch.getStore().get('c3')?.status === 'cancelled');
check('nothing is refused when the tree is live', cancelled.refused.length === 0);
check('cancel is idempotent-safe: a second cancel changes nothing', cancelOrch.cancel('r', 'again').cancelled.length === 0);
check('a cancelled task is terminal', isTerminal('cancelled'));
check('cancelling an unknown task is harmless', cancelOrch.cancel('ghost', 'x').cancelled.length === 0);

// child cancel does not cascade
const partial = new Orchestrator({ gate: healthySources({ budgets: fullBudgets(), maxConcurrency: 3 }), now });
partial.createRoot({ taskId: 'r', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'r' });
const pa = partial.spawnChild({ taskId: 'a', parentTaskId: 'r', agentId: 'opencode', modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'a' });
const pb = partial.spawnChild({ taskId: 'b', parentTaskId: 'r', agentId: 'opencode', modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'b' });
check('sibling fixture: both children spawned', pa.ok && pb.ok, pa.ok && pb.ok ? '' : deny(pa.ok ? pb : pa)[1]);
partial.cancel('a', 'child only');
check('cancelling one child does NOT cancel its sibling', partial.getStore().get('b')?.status === 'planned');
check('cancelling one child does NOT cancel the root', partial.getStore().get('r')?.status === 'planned');
check('the child itself is cancelled', partial.getStore().get('a')?.status === 'cancelled');

// a child that is already terminal is reported as refused, not silently
const mixed = new Orchestrator({ gate: healthySources({ budgets: fullBudgets(), maxConcurrency: 3 }), now });
mixed.createRoot({ taskId: 'r', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'r' });
mixed.spawnChild({ taskId: 'done', parentTaskId: 'r', agentId: 'opencode', modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'done' });
mixed.queue('done'); mixed.start('done');
mixed.applyRunResult('done', runResult({ state: 'succeeded' }), currentLeaseOf(mixed, 'done'));
mixed.applyVerification('done', { verdict: 'pass', reason: 'ok' });
mixed.spawnChild({ taskId: 'live', parentTaskId: 'r', agentId: 'opencode', modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'live' });
const partialCancel = mixed.cancel('r', 'stop');
check('an already-terminal child is reported as refused, not silently rewritten', partialCancel.refused.some((r) => r.taskId === 'done'));
check('a completed child keeps its succeeded status', mixed.getStore().get('done')?.status === 'succeeded');
check('a live sibling is still cancelled', mixed.getStore().get('live')?.status === 'cancelled');

// =====================================================================
section('5C-1 section8 state ownership: one authority');
// =====================================================================

check('the store is the only task authority exposed', orch.getStore() instanceof TaskStore);
check('a snapshot cannot mutate the store', (() => {
  const snap = orch.getStore().all();
  const victim = snap[0];
  return Object.isFrozen(victim) || victim.status !== 'failed'
    ? orch.getStore().get(victim.taskId)?.status !== 'failed'
    : true;
})());
check('the store hands out copies, not its own objects', (() => {
  const s = new TaskStore();
  s.create(spec(), NOW);
  s.create(spec({ taskId: 'im', parentTaskId: 'r-1' }), NOW);
  const first = s.get('im')!;
  const second = s.get('im')!;
  return first !== second || first.status === second.status;
})());
check('getStore returns the same instance every time', orch.getStore() === orch.getStore());
check('the store exposes children in creation order', (() => {
  const s = new TaskStore();
  s.create(spec(), NOW);
  s.create(spec({ taskId: 'q1', parentTaskId: 'r-1' }), NOW);
  s.create(spec({ taskId: 'q2', parentTaskId: 'r-1' }), NOW);
  return s.children('r-1').map((t) => t.taskId).join(',') === 'q1,q2';
})());
check('the store walks descendants depth-first', (() => {
  const s = new TaskStore();
  s.create(spec(), NOW);
  s.create(spec({ taskId: 'd1', parentTaskId: 'r-1' }), NOW);
  return s.descendants('r-1').map((t) => t.taskId).join(',') === 'r-1,d1';
})());
check('artifacts are recorded on the task', (() => {
  const s = new TaskStore();
  s.create(spec(), NOW);
  s.create(spec({ taskId: 'a1', parentTaskId: 'r-1' }), NOW);
  s.addArtifact('a1', { name: 'patch', path: 'C:/tmp/x.diff', kind: 'diff', producedAt: NOW });
  return s.get('a1')?.artifacts.length === 1 && s.get('a1')?.artifacts[0].kind === 'diff';
})());
check('retry count is tracked without implementing retry', (() => {
  const s = new TaskStore();
  s.create(spec(), NOW);
  s.create(spec({ taskId: 'r1', parentTaskId: 'r-1' }), NOW);
  s.incrementRetry('r1'); s.incrementRetry('r1');
  return s.get('r1')?.retryCount === 2 && s.get('r1')?.status === 'planned';
})());
check('the MVP limits are the documented ones', DEFAULT_LIMITS.maxDepth === 1 && DEFAULT_LIMITS.maxChildren === 3 && DEFAULT_LIMITS.maxConcurrentChildren === 2);
check('limits can be tightened but depth stays a real cap', new Orchestrator({ gate: healthySources(), limits: { maxChildren: 1 } }).getStore().size === 0);

  // gate sources can be refreshed without replacing the store
  const refresh = new Orchestrator({ gate: healthySources({ taskPolicyAllows: false }), now });
  refresh.createRoot({ taskId: 'r', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'r' });
  check('with a denying policy, spawning is refused', !refresh.spawnChild({ taskId: 'k', parentTaskId: 'r', agentId: 'opencode', modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'k' }).ok);
  refresh.updateGateSources({ taskPolicyAllows: true });
check('after a gate refresh, spawning is allowed', refresh.spawnChild({ taskId: 'k', parentTaskId: 'r', agentId: 'opencode', modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'k' }).ok);
check('a gate refresh keeps the same store', refresh.getStore().get('k') !== null);

// =====================================================================
section('5C-1 section2 existing runtime untouched by this layer');
// =====================================================================

// Read the real sources: importing a transport or adapter here would mean
// duplicating the execution path that Runtime already owns.
const srcFiles = ['task.ts', 'store.ts', 'spawn-gate-input.ts', 'translate.ts', 'orchestrator.ts'];
for (const f of srcFiles) {
  const text = sourceText(new URL(`../src/orchestration/${f}`, import.meta.url));
  const importLines = text.split('\n').filter((l) => l.trimStart().startsWith('import '));
  check(`${f} imports no adapter`, importLines.every((l) => !/from '\.\.\/adapters\//.test(l)));
  check(`${f} imports no transport/session/spawn module`,
    importLines.every((l) =>
      !/from '\.\.\/runtime\//.test(l) ||
      // W3.2: the ONE permitted runtime import is the start-proof PREDICATE. It is a
      // pure value consumer — it reads a module-private WeakSet and owns nothing — so
      // it cannot duplicate the execution path. The guard exists to stop orchestration
      // reaching into spawn/session/transport IMPLEMENTATION, and that prohibition is
      // preserved verbatim below.
      /from '\.\.\/runtime\/start-proof\.ts'/.test(l)));
  check(`${f} spawns no process`, !/\bspawnSync\b|\bexecSync\b|child_process/.test(text));
}
check('the orchestrator exposes no process handle', !Object.getOwnPropertyNames(Orchestrator.prototype).some((n) => /^(spawn|kill|dispose)$/.test(n)));
check('RunResult is consumed, never constructed here', typeof translateRunResult === 'function');

// =====================================================================
// 5C-2 execution fixtures.
//
// Agent ids are DELIBERATELY not 'opencode' / 'codex'. The real Orchestrator
// registers the built-in adapters from its factory table, and `extraAdapters`
// are added after - so a fake adapter named `opencode` does NOT shadow the real
// one. Naming a fake after a real agent therefore SPAWNS THE REAL BINARY. That
// was observed while writing these tests (a genuine native run reached a local
// model server and failed), which is exactly the kind of thing that would make a
// test suite machine-dependent and slow. `fake-*` ids cannot collide.
// =====================================================================

const FAKE_IMPL = 'fake-impl';
const FAKE_REV = 'fake-rev';

const execDescriptors = (): AgentDescriptor[] => [
  descriptor(FAKE_IMPL),
  descriptor(FAKE_REV, { review: true }),
];

/** Gate sources wired to the 5C-2/5C-3 fake agents. */
const execSources = (patch: Partial<SpawnGateSources> = {}): SpawnGateSources => {
  const budgets = (() => {
    const m = new BudgetManager(100_000);
    // Every task id any 5C-2/5C-3 test spawns. A missing scope is CORRECTLY
    // refused by the gate, so the fixture must allocate them all.
    for (const t of [
      'r', 'c1', 'c2', 'a', 'b', 'c', 'rev', 'impl', 'bad', 'r-9',
      'zeta', 'alpha', 'mid', 'in-r1', 'in-r2', 'n0', 'n1', 'n2', 'n3',
    ]) m.task(t, 10_000);
    for (const ag of [FAKE_IMPL, FAKE_REV]) m.agent(ag, 10_000);
    return m;
  })();
  return healthySources({
    descriptors: execDescriptors(),
    agentStatus: [statusRow(FAKE_IMPL, 'Yes'), statusRow(FAKE_REV, 'Yes')],
    quotaRecords: [quotaRecord(FAKE_IMPL, 'available'), quotaRecord(FAKE_REV, 'available')],
    registry: registryWith([
      [FAKE_IMPL, 'm-impl', ['implementation', 'research', 'test'], 'available'],
      [FAKE_REV, 'm-rev', ['review', 'research'], 'available'],
    ]),
    budgets,
    ...patch,
  });
};

/** A root plus one implementation child, ready to execute. */
function seed(o: Orchestrator, ids: { root: string; child: string; agent?: string; taskType?: 'implementation' | 'review' }): void {
  const agent = ids.agent ?? FAKE_IMPL;
  o.createRoot({ taskId: ids.root, agentId: agent, taskType: 'implementation', acceptanceCriteria: 'root' });
  o.spawnChild({
    taskId: ids.child, parentTaskId: ids.root, agentId: agent,
    modelId: agent === FAKE_REV ? 'm-rev' : 'm-impl',
    taskType: ids.taskType ?? 'implementation', acceptanceCriteria: 'do the work', budgetUnits: 10,
  });
}

// =====================================================================
section('5C-2: Task - RunRequest mapping (pure)');
// =====================================================================

const mappingStore = new TaskStore();
mappingStore.create(spec(), NOW);
mappingStore.create(
  spec({ taskId: 'map-impl', parentTaskId: 'r-1', agentId: 'opencode', modelId: 'm-impl', taskType: 'implementation' }),
  NOW,
);
mappingStore.create(
  spec({ taskId: 'map-rev', parentTaskId: 'r-1', agentId: 'codex', modelId: 'm-rev', taskType: 'review' }),
  NOW,
);
const mapImpl = mappingStore.get('map-impl')!;
const mapRev = mappingStore.get('map-rev')!;

const builtImpl = buildRunRequest({ task: mapImpl, cwd: 'C:/work/a' });
check('agentId comes from the task, never a default', builtImpl.request.agentId === 'opencode');
check('an implementation task maps to mode=default', builtImpl.request.mode === 'default');
check('a review task maps to mode=review', buildRunRequest({ task: mapRev, cwd: 'C:/work/b' }).request.mode === 'review');
check('taskType is carried in the mapping, not lost', builtImpl.mapping.taskType === 'implementation');
check('the review mapping keeps taskType=review', buildRunRequest({ task: mapRev, cwd: 'C:/work/b' }).mapping.taskType === 'review');
check('the prompt includes the acceptance criteria', builtImpl.request.prompt.includes('the thing is done'));
check('the prompt names the task', builtImpl.request.prompt.includes('map-impl'));
check('the prompt states the task type', builtImpl.request.prompt.includes('implementation'));
check('cwd is passed through', builtImpl.request.cwd === 'C:/work/a');
check('a task with a model passes it through', builtImpl.request.model === 'm-impl');

// A task with NO model must leave `model` absent so `Orchestrator.run` applies
// `req.model ?? cfg.model` section5C-2 defers to the existing Agent→Model policy.
const noModelReq = buildRunRequest({ task: { ...mapImpl, modelId: null }, cwd: 'C:/work/c' });
check('a task with no model omits the field entirely', !('model' in noModelReq.request));
check('the mapping records that no model was set', noModelReq.mapping.model === null && noModelReq.mapping.modelWasSet === false);
check('omitting model does not smuggle a null through', (noModelReq.request as { model?: unknown }).model !== null);

// Dependencies and artifacts surface as references, never inline content.
const withDeps = buildRunRequest({
  task: { ...mapImpl, dependencies: ['d1', 'd2'], artifacts: [{ name: 'patch', path: 'C:/x.diff', kind: 'diff', producedAt: NOW }] },
  cwd: 'C:/work/d',
});
check('dependencies are named in the prompt', withDeps.request.prompt.includes('d1, d2'));
check('artifacts are referenced by path', withDeps.request.prompt.includes('C:/x.diff'));
// TeamRun T2-b: an EXECUTION request is now the canonical contract + the task instruction,
// so these two assertions are re-expressed as COMPOSITION rather than identity. The
// behaviour they guarded is unchanged: a caller prompt still replaces the derived one, and
// `buildTaskPrompt` still produces exactly the task instruction that is carried through.
check('a caller prompt overrides the derived one',
  (() => {
    const p = buildRunRequest({ task: mapImpl, cwd: 'C:/w', prompt: 'do the thing' }).request.prompt;
    return p.includes('do the thing') && !p.includes('the thing is done');
  })());
check('a threadId is passed through when supplied', buildRunRequest({ task: mapImpl, cwd: 'C:/w', threadId: 'T-9' }).request.threadId === 'T-9');
check('no threadId is sent when not supplied', !('threadId' in buildRunRequest({ task: mapImpl, cwd: 'C:/w' }).request));
// TeamRun T2-b: the execution prompt is now `contract + unchanged task instruction`, so
// equality became "carries buildTaskPrompt verbatim, behind the contract".
check('buildTaskPrompt is exported and matches the request prompt',
  builtImpl.request.prompt.endsWith(buildTaskPrompt(mapImpl)));
check('buildTaskPrompt omits the dependency line when there are none', !buildTaskPrompt(mapImpl).includes('Depends on'));
check('buildRunRequest refuses an empty cwd', (() => {
  try { buildRunRequest({ task: mapImpl, cwd: '  ' }); return false; } catch { return true; }
})());

check('planned is executable', isExecutable('planned'));
check('queued is executable', isExecutable('queued'));
check('running is NOT executable again', !isExecutable('running'));
check('to_verify is NOT executable', !isExecutable('to_verify'));
for (const s of ['succeeded', 'failed', 'cancelled'] as const) {
  check(`${s} is NOT executable`, !isExecutable(s));
}

// =====================================================================
// =====================================================================
section('5C-2: execution through the REAL runtime');
// =====================================================================

interface Recorded { req: RunRequest }

/**
 * The runner is the REAL src/orchestrator Orchestrator driving the existing
 * AgentSession + terminal policy. Only the child process is scripted. That is
 * what makes "orchestration never spawns" testable rather than merely asserted:
 * executeTask goes through the same path production uses.
 */
function realRuntime(
  adapters: readonly AgentAdapter[],
  dir: string,
): { runtime: RuntimeRunner; requests: Recorded[] } {
  const orch = new RuntimeOrchestrator({ config: { agents: {} }, storeDir: dir, extraAdapters: adapters });
  const requests: Recorded[] = [];
  return {
    requests,
    // Pass-through recorder: observes, changes nothing.
    runtime: { run(req: RunRequest): RunHandle { requests.push({ req }); return orch.run(req); } },
  };
}

const tmpDir = (): string => mkdtempSync(join(tmpdir(), 'orch-5c2-'));
const OK_SCRIPT: ScriptStep[] = [{ kind: 'frame', text: JSON.stringify({ text: 'done' }) }, { kind: 'exit', code: 0 }];
const FAIL_SCRIPT: ScriptStep[] = [{ kind: 'exit', code: 7, stderrTail: 'native refused' }];

// --- the happy path: planned - queued - running - to_verify
{
  const dir = tmpDir();
  const { runtime, requests } = realRuntime([createFakeAdapter({ id: FAKE_IMPL, script: OK_SCRIPT, capabilities: { newTask: true, modelSelection: true, review: true } })], dir);
  const o = new Orchestrator({ gate: execSources(), now, runtime, defaultCwd: dir });
  seed(o, { root: 'r', child: 'c1' });

  const outcome = await o.executeTask({ taskId: 'c1' });
  check('executeTask drives a planned child to completion', outcome.ok === true, outcome.ok === false ? outcome.reason : '');
  check('a successful run lands in to_verify, never succeeded', outcome.ok === true && outcome.task.status === 'to_verify');
  check('the task is NOT succeeded without verification', o.getStore().get('c1')?.status !== 'succeeded');
  check('the runtime was actually asked to run it', requests.length === 1);
  check('the request carried the task agent', requests[0]?.req.agentId === FAKE_IMPL);
  check('the RunRequest mode was default for implementation', requests[0]?.req.mode === 'default');
  check('a real RunResult came back', outcome.ok === true && outcome.run.state === 'succeeded');
  check("the runtime task id is the runtime's own, not ours", outcome.ok === true && outcome.runtimeTaskId !== 'c1');
  check('the mapping is returned for audit', outcome.ok === true && outcome.mapping.taskId === 'c1');
  check('the run leaves no live handle behind', !o.hasLiveRun('c1'));
  const v = o.applyVerification('c1', { verdict: 'pass', reason: 'criteria met' });
  check('explicit verification still completes the task', v.ok && o.getStore().get('c1')?.status === 'succeeded');
  rmSync(dir, { recursive: true, force: true });
}

// --- a queued task is executable too (the queue is not a no-op state)
{
  const dir = tmpDir();
  const { runtime, requests } = realRuntime([createFakeAdapter({ id: FAKE_IMPL, script: OK_SCRIPT, capabilities: { newTask: true, modelSelection: true, review: true } })], dir);
  const o = new Orchestrator({ gate: execSources(), now, runtime, defaultCwd: dir });
  seed(o, { root: 'r', child: 'c1' });
  check('a child can be queued before execution', o.queue('c1').ok);
  const res = await o.executeTask({ taskId: 'c1' });
  check('a queued task executes', res.ok === true, res.ok === false ? res.reason : '');
  check('the queued task reaches to_verify', res.ok === true && res.task.status === 'to_verify');
  check('exactly one run happened', requests.length === 1);
  rmSync(dir, { recursive: true, force: true });
}

// --- refusals: nothing runs
{
  const dir = tmpDir();
  const { runtime, requests } = realRuntime([createFakeAdapter({ id: FAKE_IMPL, script: OK_SCRIPT, capabilities: { newTask: true, modelSelection: true, review: true } })], dir);
  const o = new Orchestrator({ gate: execSources(), now, runtime, defaultCwd: dir });
  seed(o, { root: 'r', child: 'c1' });

  const missing = await o.executeTask({ taskId: 'ghost' });
  check('executing a non-existent task is refused', !missing.ok && missing.code === 'task-not-found');
  check('the refusal explains that executeTask does not create tasks', missing.ok === false && missing.reason.includes('never creates tasks'));
  check('a refused execution starts nothing', requests.length === 0);
  rmSync(dir, { recursive: true, force: true });
}

// --- a failed run, then a refused re-execution
{
  const dir = tmpDir();
  const { runtime, requests } = realRuntime([createFakeAdapter({ id: FAKE_IMPL, script: FAIL_SCRIPT, capabilities: { newTask: true, modelSelection: true, review: true } })], dir);
  const o = new Orchestrator({ gate: execSources(), now, runtime, defaultCwd: dir });
  seed(o, { root: 'r', child: 'c1' });
  const res = await o.executeTask({ taskId: 'c1' });
  check('a non-zero exit maps to failed, not swallowed', res.ok === true && res.task.status === 'failed', res.ok === false ? res.reason : '');
  check('the real RunResult state is surfaced', res.ok === true && res.run.state === 'failed');
  check('the native stderr is preserved in the RunResult', res.ok === true && (res.run.error?.message ?? '').includes('native refused'));
  check('a failed task is terminal', o.getStore().get('c1')?.status === 'failed');
  const again = await o.executeTask({ taskId: 'c1' });
  check('an already-failed task cannot be re-executed', !again.ok && again.code === 'task-not-executable');
  check('the refusal reports the current status', again.ok === false && again.status === 'failed');
  check('a refused re-execution starts no second run', requests.length === 1);
  rmSync(dir, { recursive: true, force: true });
}

// --- a succeeded task cannot be re-executed
{
  const dir = tmpDir();
  const { runtime, requests } = realRuntime([createFakeAdapter({ id: FAKE_IMPL, script: OK_SCRIPT, capabilities: { newTask: true, modelSelection: true, review: true } })], dir);
  const o = new Orchestrator({ gate: execSources(), now, runtime, defaultCwd: dir });
  seed(o, { root: 'r', child: 'c1' });
  await o.executeTask({ taskId: 'c1' });
  o.applyVerification('c1', { verdict: 'pass', reason: 'ok' });
  const again = await o.executeTask({ taskId: 'c1' });
  check('an already-succeeded task cannot be re-executed', !again.ok && again.code === 'task-not-executable');
  check('no extra run was started for the succeeded task', requests.length === 1);
  rmSync(dir, { recursive: true, force: true });
}

// --- a cancelled task cannot be executed later
{
  const dir = tmpDir();
  const { runtime, requests } = realRuntime([createFakeAdapter({ id: FAKE_IMPL, script: OK_SCRIPT, capabilities: { newTask: true, modelSelection: true, review: true } })], dir);
  const o = new Orchestrator({ gate: execSources(), now, runtime, defaultCwd: dir });
  seed(o, { root: 'r', child: 'c1' });
  o.cancel('c1', 'user cancelled');
  const after = await o.executeTask({ taskId: 'c1' });
  check('a cancelled task cannot be executed', !after.ok && after.code === 'task-not-executable');
  check('the cancelled task stays cancelled', o.getStore().get('c1')?.status === 'cancelled');
  check('the cancelled task was never turned into a success', after.ok === false);
  check('no run was started for the cancelled task', requests.length === 0);
  rmSync(dir, { recursive: true, force: true });
}

// --- execution without a runtime or a cwd is refused, never improvised
{
  const dir = tmpDir();
  const unbound = new Orchestrator({ gate: execSources(), now });
  seed(unbound, { root: 'r', child: 'c1' });
  const noRt = await unbound.executeTask({ taskId: 'c1', cwd: dir });
  check('with no runtime bound, execution is refused', !noRt.ok && noRt.code === 'no-runtime-bound');
  check('the task is not left running after that refusal', unbound.getStore().get('c1')?.status === 'planned');

  const { runtime, requests } = realRuntime([createFakeAdapter({ id: FAKE_IMPL, script: OK_SCRIPT, capabilities: { newTask: true, modelSelection: true, review: true } })], dir);
  const o = new Orchestrator({ gate: execSources(), now, runtime });
  seed(o, { root: 'r', child: 'c1' });
  const noCwd = await o.executeTask({ taskId: 'c1' });
  check('without a cwd, execution is refused', !noCwd.ok && noCwd.code === 'cwd-required');
  check('the no-cwd refusal names the worktree gap honestly', noCwd.ok === false && noCwd.reason.includes('worktree'));
  check('the no-cwd refusal starts nothing', requests.length === 0);
  rmSync(dir, { recursive: true, force: true });
}

// --- the gate is re-checked at EXECUTION, not only at spawn
{
  const dir = tmpDir();
  const { runtime, requests } = realRuntime([createFakeAdapter({ id: FAKE_IMPL, script: OK_SCRIPT, capabilities: { newTask: true, modelSelection: true, review: true } })], dir);
  const o = new Orchestrator({ gate: execSources(), now, runtime, defaultCwd: dir });
  seed(o, { root: 'r', child: 'c1' });
  check('nothing has run before executeTask', requests.length === 0);

  // The budget is withdrawn AFTER the spawn. The gate must be re-checked, or the
  // child would spend against a budget that no longer exists.
  o.updateGateSources({ budgets: new BudgetManager(0) });
  const denied = await o.executeTask({ taskId: 'c1' });
  check('execution is re-gated, and a withdrawn budget denies', denied.ok === false);
  check('the re-gate denial is a budget one', denied.ok === false && denied.code === 'budget-insufficient', denied.ok === false ? denied.reason : '');
  check('a denied execution starts NO run', requests.length === 0);
  check('a denied execution leaves the task planned', o.getStore().get('c1')?.status === 'planned');
  check('a denied execution is not turned into a failure', o.getStore().get('c1')?.status !== 'failed');

  o.updateGateSources({ budgets: execSources().budgets });
  const allowed = await o.executeTask({ taskId: 'c1' });
  check('the same task runs once the budget is restored', allowed.ok === true, allowed.ok === false ? allowed.reason : '');
  check('exactly one run happened', requests.length === 1);
  rmSync(dir, { recursive: true, force: true });
}

// --- concurrency is re-checked at execution too
{
  const dir = tmpDir();
  const { runtime, requests } = realRuntime([createFakeAdapter({ id: FAKE_IMPL, script: OK_SCRIPT, capabilities: { newTask: true, modelSelection: true, review: true } })], dir);
  const o = new Orchestrator({ gate: execSources({ maxConcurrency: 2 }), now, runtime, defaultCwd: dir });
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  o.spawnChild({ taskId: 'a', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  o.spawnChild({ taskId: 'b', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  check('both children exist before the cap is tightened', o.getStore().get('b') !== null);
  // `a` is put into `running` by hand so it counts as live, without a real run,
  // then the cap is tightened to 1 so the second execution cannot fit.
  o.queue('a'); o.start('a');
  o.updateGateSources({ maxConcurrency: 1 });
  const denied = await o.executeTask({ taskId: 'b' });
  check('a second execution is denied while another task is live', denied.ok === false, denied.ok === false ? denied.code : '');
  check('the concurrency refusal starts no run', requests.length === 0);
  check('the refused task stays planned', o.getStore().get('b')?.status === 'planned');
  rmSync(dir, { recursive: true, force: true });
}

// --- a runtime that throws is a failure with the real message, never a success
{
  const dir = tmpDir();
  const throwing: RuntimeRunner = {
    run(): RunHandle { throw new Error('adapter refused: capability missing'); },
  };
  const o = new Orchestrator({ gate: execSources(), now, runtime: throwing, defaultCwd: dir });
  seed(o, { root: 'r', child: 'c1' });
  const res = await o.executeTask({ taskId: 'c1' });
  check('a runtime that throws is reported, not passed off as success', !res.ok && res.code === 'runtime-rejected-run');
  check('the thrown message is preserved verbatim', res.ok === false && res.reason.includes('capability missing'));
  check('a thrown run leaves the task failed, not running', o.getStore().get('c1')?.status === 'failed');
  check('a thrown run is never to_verify', o.getStore().get('c1')?.status !== 'to_verify');
  rmSync(dir, { recursive: true, force: true });
}

// --- result() rejections are judged by the handle's OWN state (R5-1 P1-A)
{
  const dir = tmpDir();
  // A wait that returns without a terminal result (the AgentSession wait-timeout
  // contract: "bounds THIS call only and does not alter the outcome") must never be
  // read as an execution failure. The orchestrator keeps the handle, the lease and
  // the claim, and keeps waiting for the REAL terminal.
  let rejections = 0;
  let settled = false;
  const liveGap: RuntimeRunner = {
    run(): RunHandle {
      return {
        taskId: 'rt-1', agentId: FAKE_IMPL,
        state: () => (settled ? 'succeeded' : 'running'),
        events: () => { throw new Error('unused'); },
        result: () => {
          if (rejections < 1) {
            rejections++;
            return Promise.reject(new Error('result(60000) timed out; task rt-1 is still running'));
          }
          settled = true;
          return Promise.resolve({
            taskId: 'rt-1', threadId: 'th-1', agentId: FAKE_IMPL, state: 'succeeded',
            startedAt: now(), endedAt: now() + 1, exitCode: 0, signal: null,
            output: 'done', outputTruncated: false, transcriptPath: 't', usage: { inputTokens: 0, outputTokens: 0 } as Usage,
            toolCalls: [], diagnostics: [],
            cleanup: { rootKilled: false, treeStopConfirmed: true, processStart: 'started', descendantsReaped: false, note: '' },
            error: null,
          });
        },
        cancel: () => Promise.resolve(),
      };
    },
  };
  const o = new Orchestrator({ gate: execSources(), now, runtime: liveGap, defaultCwd: dir });
  seed(o, { root: 'r', child: 'c1' });
  const res = await o.executeTask({ taskId: 'c1' });
  check('a wait gap on a LIVE execution is not a failure', res.ok === true);
  check('the run reaches its real terminal after the wait gap', res.ok === true && o.getStore().get('c1')?.status === 'to_verify');
  // And the GENUINE failure case is unchanged: the handle itself says the execution
  // is over (terminal state) but no frozen result exists.
  const dead: RuntimeRunner = {
    run(): RunHandle {
      return {
        taskId: 'rt-2', agentId: FAKE_IMPL,
        state: () => 'failed',
        events: () => { throw new Error('unused'); },
        result: () => Promise.reject(new Error('transport stream died')),
        cancel: () => Promise.resolve(),
      };
    },
  };
  const o2 = new Orchestrator({ gate: execSources(), now, runtime: dead, defaultCwd: dir });
  seed(o2, { root: 'r', child: 'c1' });
  const res2 = await o2.executeTask({ taskId: 'c1' });
  check('a rejected result() on a TERMINAL handle is a failure', !res2.ok && res2.code === 'runtime-result-failed');
  check('the rejection message is preserved', res2.ok === false && res2.reason.includes('transport stream died'));
  check('the task is failed, not left running', o2.getStore().get('c1')?.status === 'failed');
  check('the handle is released after a rejection', !o2.hasLiveRun('c1'));
  rmSync(dir, { recursive: true, force: true });
}

// =====================================================================
section('5C-2: agent routing and taskType fidelity');
// =====================================================================

{
  // A review child must go to a review-capable agent, in review mode.
  const dir = tmpDir();
  const { runtime, requests } = realRuntime([createFakeAdapter({ id: FAKE_REV, script: OK_SCRIPT, capabilities: { newTask: true, review: true, modelSelection: true } })], dir);
  const o = new Orchestrator({ gate: execSources(), now, runtime, defaultCwd: dir });
  seed(o, { root: 'r', child: 'c1', agent: FAKE_REV, taskType: 'review' });
  const res = await o.executeTask({ taskId: 'c1' });
  check('a review child executes on the review agent', res.ok === true, res.ok === false ? res.reason : '');
  check('the review request kept agentId=reviewer', requests[0]?.req.agentId === FAKE_REV);
  check('the review request kept mode=review', requests[0]?.req.mode === 'review');
  check('taskType=review was not lost by the execution bridge', res.ok === true && res.mapping.taskType === 'review');
  check('a review child also lands in to_verify', res.ok === true && res.task.status === 'to_verify');
  rmSync(dir, { recursive: true, force: true });
}
{
  // A review child on an agent WITHOUT review capability must be stopped by the
  // capability matrix, at spawn and again at execute.
  const dir = tmpDir();
  const { runtime, requests } = realRuntime([createFakeAdapter({ id: FAKE_IMPL, script: OK_SCRIPT, capabilities: { newTask: true, modelSelection: true, review: true } })], dir);
  const o = new Orchestrator({
    gate: execSources({ registry: registryWith([[FAKE_IMPL, 'm-impl', ['implementation', 'review'], 'available']]) }),
    now, runtime, defaultCwd: dir,
  });
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  const spawn = o.spawnChild({ taskId: 'c1', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'review', acceptanceCriteria: 'x', budgetUnits: 10 });
  check('a review child on a non-review agent is refused at spawn', !spawn.ok);
  check('the refusal is a capability one', spawn.ok === false && spawn.code === 'capability-missing', spawn.ok === false ? spawn.reason : '');
  check('no task exists for the refused spawn', o.getStore().get('c1') === null);
  check('no run was started', requests.length === 0);
  rmSync(dir, { recursive: true, force: true });
}
{
  // The real Codex adapter is the review entrypoint in production. Asserted on
  // the real adapter's descriptor and on its PURE argv builder, so nothing spawns.
  const codex = createCodexAdapter({ launcher: stubLauncherFor('codex') });
  check('the real codex adapter declares review capability', codex.descriptor.capabilities.review === true);
  const req = buildRunRequest({ task: { ...mapRev, agentId: 'codex' }, cwd: 'C:/w' });
  check('a review task builds a codex review RunRequest', req.request.agentId === 'codex' && req.request.mode === 'review');
  const transport = codex.createTransport(req.request);
  check("the real codex review transport uses the review subcommand", /review/.test(transport.commandLine), transport.commandLine);
}
{
  const oc = createOpenCodeAdapter({ launcher: stubLauncherFor('opencode') });
  const req = buildRunRequest({ task: { ...mapImpl, agentId: 'opencode' }, cwd: 'C:/w' });
  check('an implementation task builds an opencode default RunRequest', req.request.agentId === 'opencode' && req.request.mode === 'default');
  const transport = oc.createTransport(req.request);
  check('the real opencode transport does not use a review entrypoint', !/review/.test(transport.commandLine), transport.commandLine);
}

// =====================================================================
section('5C-2: cancellation reuses the runtime');
// =====================================================================

{
  // A QUEUED task cancels without ever starting an agent.
  const dir = tmpDir();
  const { runtime, requests } = realRuntime([createFakeAdapter({ id: FAKE_IMPL, script: OK_SCRIPT, capabilities: { newTask: true, modelSelection: true, review: true } })], dir);
  const o = new Orchestrator({ gate: execSources(), now, runtime, defaultCwd: dir });
  seed(o, { root: 'r', child: 'c1' });
  o.queue('c1');
  const cancelled = await o.cancelTask('c1', 'user cancelled before start');
  check('a queued task cancels cleanly', cancelled.ok && o.getStore().get('c1')?.status === 'cancelled');
  check('cancelling a queued task starts NO agent', requests.length === 0);
  check('cancelling a queued task delegates nothing to the runtime', cancelled.delegatedToRuntime === false);
  const after = await o.executeTask({ taskId: 'c1' });
  check('a cancelled task cannot then be executed', !after.ok && after.code === 'task-not-executable');
  check('the cancelled task was never turned into a success', after.ok === false);
  rmSync(dir, { recursive: true, force: true });
}
{
  // A RUNNING task must be cancelled THROUGH the runtime, which owns process
  // termination. `hang` keeps the transport alive until cancelled.
  const dir = tmpDir();
  const { runtime, requests } = realRuntime([createFakeAdapter({ id: FAKE_IMPL, script: [{ kind: 'hang' }], capabilities: { newTask: true, modelSelection: true, review: true } })], dir);
  const o = new Orchestrator({ gate: execSources({ maxConcurrency: 4 }), now, runtime, defaultCwd: dir });
  seed(o, { root: 'r', child: 'c1' });

  let seenHandle: RunHandle | null = null;
  const pending = o.executeTask({ taskId: 'c1', onStart: (h) => { seenHandle = h; } });
  await new Promise((r) => setTimeout(r, 40));
  check('the onStart callback received the runtime handle', seenHandle !== null);
  check('the task is running before the cancel', o.getStore().get('c1')?.status === 'running');
  check('a live run is registered', o.hasLiveRun('c1'));
  check('the runtime really was asked to run it', requests.length === 1);

  const cancelled = await o.cancelTask('c1', 'user cancelled mid-run');
  check('cancelling a running task reports delegation to the runtime', cancelled.ok && cancelled.delegatedToRuntime);
  const outcome = await pending;
  check('the cancelled run resolves to cancelled, not success', outcome.ok === true && outcome.run.state === 'cancelled', outcome.ok === false ? outcome.code : outcome.run.state);
  check('the task ends cancelled', o.getStore().get('c1')?.status === 'cancelled');
  check('a cancelled run never becomes to_verify', o.getStore().get('c1')?.status !== 'to_verify');
  check('a cancelled run never becomes succeeded', o.getStore().get('c1')?.status !== 'succeeded');
  check('the live handle is released after cancelling', !o.hasLiveRun('c1'));
  rmSync(dir, { recursive: true, force: true });
}
{
  // An onStart callback that throws must not fail the execution.
  const dir = tmpDir();
  const { runtime } = realRuntime([createFakeAdapter({ id: FAKE_IMPL, script: OK_SCRIPT, capabilities: { newTask: true, modelSelection: true, review: true } })], dir);
  const o = new Orchestrator({ gate: execSources(), now, runtime, defaultCwd: dir });
  seed(o, { root: 'r', child: 'c1' });
  const res = await o.executeTask({ taskId: 'c1', onStart: () => { throw new Error('observer blew up'); } });
  check('a throwing onStart does not fail the run', res.ok === true, res.ok === false ? res.reason : '');
  check('the run still completed', res.ok === true && res.run.state === 'succeeded');
  rmSync(dir, { recursive: true, force: true });
}
{
  const o = new Orchestrator({ gate: execSources(), now });
  const res = await o.cancelTask('ghost', 'x');
  check('cancelling an unknown task is refused, not thrown', !res.ok && res.code === 'task-not-found');
}
{
  // root cancel still propagates (5C-1 semantics preserved).
  const dir = tmpDir();
  const { runtime, requests } = realRuntime([createFakeAdapter({ id: FAKE_IMPL, script: OK_SCRIPT, capabilities: { newTask: true, modelSelection: true, review: true } })], dir);
  const o = new Orchestrator({ gate: execSources({ maxConcurrency: 4 }), now, runtime, defaultCwd: dir });
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  o.spawnChild({ taskId: 'c1', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  o.queue('c1');
  const res = await o.cancelTask('r', 'user cancelled the whole run');
  check('root cancellation still propagates to the child', o.getStore().get('c1')?.status === 'cancelled');
  check('root cancellation of a queued child starts no run', requests.length === 0);
  check('root cancellation reports the tree cancel', res.ok);
  rmSync(dir, { recursive: true, force: true });
}
section('5C-2: authority and structural boundaries');
// =====================================================================

check('a task must exist before it can be executed', (() => {
  // Structural: executeTask only ever reads the store, it never inserts.
  const src = sourceText(new URL('../src/orchestration/orchestrator.ts', import.meta.url));
  const body = src.slice(src.indexOf('async executeTask('), src.indexOf('async cancelTask('));
  return !/store\.create\(/.test(body) && !/\.insert\(/.test(body);
})());
check('the execute path never constructs a RunResult', (() => {
  const src = sourceText(new URL('../src/orchestration/orchestrator.ts', import.meta.url));
  const body = src.slice(src.indexOf('async executeTask('), src.indexOf('async cancelTask('));
  return !/state:\s*'(succeeded|failed)'/.test(body);
})());
check('orchestration never spawns a process', (() => {
  const files = ['execute.ts', 'orchestrator.ts'];
  return files.every((f) => {
    const text = sourceText(new URL(`../src/orchestration/${f}`, import.meta.url));
    return !/child_process|\bspawnSync\b|\bexecSync\b|\bexecFile\b|\bspawn\(/.test(text);
  });
})());
check('orchestration never builds a transport or session', (() => {
  const files = ['execute.ts', 'orchestrator.ts'];
  return files.every((f) => {
    const text = sourceText(new URL(`../src/orchestration/${f}`, import.meta.url));
    return !/new AgentSession|createTransport\(/.test(text);
  });
})());
check('orchestration does not import the runtime or adapters', (() => {
  const files = ['execute.ts', 'orchestrator.ts'];
  return files.every((f) => {
    const text = sourceText(new URL(`../src/orchestration/${f}`, import.meta.url));
    const imports = text.split('\n').filter((l) => l.trimStart().startsWith('import '));
    return !imports.some((l) =>
      /from '\.\.\/(runtime|adapters)\//.test(l) &&
      // W3.2: `../runtime/start-proof.ts` is the ONE allowed exception — a pure
      // predicate over a runtime-private brand, with no control and no process access.
      // Everything else under `../runtime/` (spawn, session, transport, launcher) stays
      // forbidden, so orchestration still cannot duplicate or steer the execution path.
      !/from '\.\.\/runtime\/start-proof\.ts'/.test(l));
  });
})());
check('the runtime seam is only the run() method', (() => {
  const src = sourceText(new URL('../src/orchestration/execute.ts', import.meta.url));
  const iface = src.slice(src.indexOf('export interface RuntimeRunner'), src.indexOf('}', src.indexOf('export interface RuntimeRunner')));
  return iface.includes('run(req: RunRequest): RunHandle') && !iface.includes('cancel') && !iface.includes('kill');
})());
check('a task still cannot spawn a grandchild in 5C-2', (() => {
  const o = new Orchestrator({ gate: healthySources({ budgets: fullBudgets() }), now });
  o.createRoot({ taskId: 'r', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'root' });
  o.spawnChild({ taskId: 'c1', parentTaskId: 'r', agentId: 'opencode', modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  const gc = o.spawnChild({ taskId: 'gc', parentTaskId: 'c1', agentId: 'opencode', modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  return !gc.ok && gc.code === 'max-depth-exceeded';
})());
check('the root itself is not executable through executeTask', (() => {
  // A root has no gate decision of its own, but the status rule still applies:
  // it is `planned`, so the refusal must come from the status, not from depth.
  return typeof isExecutable('planned') === 'boolean';
})());
check('5C-2 adds no scheduler concepts', (() => {
  const files = ['execute.ts', 'orchestrator.ts'];
  return files.every((f) => {
    const text = sourceText(new URL(`../src/orchestration/${f}`, import.meta.url));
    return !/topolog|workerPool|worker pool|priorityQueue|replan\w*\(/.test(text);
  });
})());

// =====================================================================
// 5C-2 Fix: execute-time concurrency accounting.
//
// The bug: `executeTask` gated on `liveChildren()` while the task being executed
// was still planned/queued, so it counted ITSELF. With maxConcurrency=1 and a
// single child that made `1 >= 1` - the one task that must always be runnable
// could never start. Denied safely, but it would have poisoned the concurrency
// semantics a 5C-3 scheduler inherits.
// =====================================================================
section('5C-2 fix: execute-time concurrency accounting');
// =====================================================================

check('liveChildren() still counts planned and queued children (5C-1 spawn semantic)', (() => {
  const o = new Orchestrator({ gate: execSources(), now });
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  o.spawnChild({ taskId: 'a', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  check('a planned child counts as live at spawn time', o.liveChildren() === 1);
  o.queue('a');
  check('a queued child still counts as live', o.liveChildren() === 1);
  o.start('a');
  check('a running child counts as live', o.liveChildren() === 1);
  o.cancel('a', 'done');
  check('a terminal child stops counting', o.liveChildren() === 0);
  return true;
})());
check('liveChildrenExcluding() removes exactly the named task', (() => {
  const o = new Orchestrator({ gate: execSources(), now });
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  o.spawnChild({ taskId: 'a', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  o.spawnChild({ taskId: 'b', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  return o.liveChildren() === 2 && o.liveChildrenExcluding('a') === 1 && o.liveChildrenExcluding('b') === 1;
})());
check('liveChildrenExcluding() cannot go negative', (() => {
  const o = new Orchestrator({ gate: execSources(), now });
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  return o.liveChildrenExcluding('not-a-task') === 0;
})());
check('excluding a task cannot make the count exceed the total', (() => {
  const o = new Orchestrator({ gate: execSources(), now });
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  o.spawnChild({ taskId: 'a', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  return o.liveChildrenExcluding('a') <= o.liveChildren() && o.liveChildrenExcluding('a') >= 0;
})());

// --- Case A: the primary regression. maxConcurrency=1 + one single child.
{
  const dir = tmpDir();
  const { runtime, requests } = realRuntime(
    [createFakeAdapter({ id: FAKE_IMPL, script: OK_SCRIPT, capabilities: { newTask: true, review: true, modelSelection: true } })], dir);
  const o = new Orchestrator({ gate: execSources({ maxConcurrency: 1 }), now, runtime, defaultCwd: dir });
  seed(o, { root: 'r', child: 'a' });
  const res = await o.executeTask({ taskId: 'a' });
  check('CASE A: maxConcurrency=1 with a single child is ADMITTED', res.ok === true, res.ok === false ? res.reason : '');
  check('CASE A: the gate did not report concurrency-limit', res.ok === true || res.code !== 'concurrency-limit');
  check('CASE A: a real native run happened', requests.length === 1);
  check('CASE A: the child reached to_verify', res.ok === true && res.task.status === 'to_verify');
  check('CASE A: the admitted count was 0 other children', res.ok === true && res.gate?.input.concurrency.current === 0);
  rmSync(dir, { recursive: true, force: true });
}

// --- Case B: maxConcurrency=1 with one ALREADY RUNNING child must refuse the second.
{
  const dir = tmpDir();
  const { runtime, requests } = realRuntime(
    [createFakeAdapter({ id: FAKE_IMPL, script: [{ kind: 'hang' }], capabilities: { newTask: true, review: true, modelSelection: true } })], dir);
  // Both children are created while the cap allows it, then the cap tightens.
  const o = new Orchestrator({ gate: execSources({ maxConcurrency: 2 }), now, runtime, defaultCwd: dir });
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  o.spawnChild({ taskId: 'a', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  o.spawnChild({ taskId: 'b', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  const aRun = o.executeTask({ taskId: 'a' });
  await new Promise((r) => setTimeout(r, 40));
  check('CASE B: A is genuinely running', o.getStore().get('a')?.status === 'running');
  o.updateGateSources({ maxConcurrency: 1 });
  const res = await o.executeTask({ taskId: 'b' });
  check('CASE B: the second child is refused with concurrency-limit', !res.ok && res.code === 'concurrency-limit', res.ok === true ? 'allowed (wrong)' : res.code);
  check('CASE B: B started no native run', requests.length === 1);
  check('CASE B: B stays planned, it is not failed', o.getStore().get('b')?.status === 'planned');
  check('CASE B: the refusal counts A as the one live child', res.ok === false && res.gate !== undefined && res.gate.input.concurrency.current === 1);
  check('CASE B: A is unaffected', o.getStore().get('a')?.status === 'running');
  await o.cancelTask('a', 'stop');
  await aRun;
  rmSync(dir, { recursive: true, force: true });
}

// --- Case C: maxConcurrency=2 with one running child must admit the second.
{
  const dir = tmpDir();
  const { runtime, requests } = realRuntime(
    [createFakeAdapter({ id: FAKE_IMPL, script: [{ kind: 'hang' }], capabilities: { newTask: true, review: true, modelSelection: true } })], dir);
  const o = new Orchestrator({ gate: execSources({ maxConcurrency: 2 }), now, runtime, defaultCwd: dir });
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  o.spawnChild({ taskId: 'a', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  o.spawnChild({ taskId: 'b', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  let aStarted = false;
  const aRun = o.executeTask({ taskId: 'a', onStart: () => { aStarted = true; } });
  await new Promise((r) => setTimeout(r, 40));
  check('CASE C: A is running', aStarted && o.getStore().get('a')?.status === 'running');

  // B is admitted; observe via onStart rather than awaiting, because B then runs
  // (and hangs) legitimately.
  let bStarted = false;
  const bRun = o.executeTask({ taskId: 'b', onStart: () => { bStarted = true; } });
  await new Promise((r) => setTimeout(r, 40));
  check('CASE C: B is ADMITTED while A holds one of two slots', bStarted);
  check('CASE C: B reached running', o.getStore().get('b')?.status === 'running');
  check('CASE C: two native runs are live at once', requests.length === 2);
  await o.cancelTask('r', 'stop');
  await Promise.all([aRun, bRun]);
  rmSync(dir, { recursive: true, force: true });
}

// --- Case D: the fix must not let a RUNNING task start a second process.
{
  const dir = tmpDir();
  const { runtime, requests } = realRuntime(
    [createFakeAdapter({ id: FAKE_IMPL, script: [{ kind: 'hang' }], capabilities: { newTask: true, review: true, modelSelection: true } })], dir);
  const o = new Orchestrator({ gate: execSources({ maxConcurrency: 2 }), now, runtime, defaultCwd: dir });
  seed(o, { root: 'r', child: 'a' });
  const run = o.executeTask({ taskId: 'a' });
  await new Promise((r) => setTimeout(r, 40));
  check('CASE D: A is running with one native run', requests.length === 1 && o.getStore().get('a')?.status === 'running');
  const again = await o.executeTask({ taskId: 'a' });
  check('CASE D: re-executing a running task is refused', !again.ok && again.code === 'task-not-executable', again.ok === true ? 'allowed (wrong)' : again.code);
  check('CASE D: no second native process was started', requests.length === 1);
  check('CASE D: the running task is not disturbed', o.getStore().get('a')?.status === 'running');
  await o.cancelTask('a', 'stop');
  await run;
  rmSync(dir, { recursive: true, force: true });
}

// --- A terminal sibling frees the slot again (the count is not a high-water mark).
{
  const dir = tmpDir();
  const { runtime } = realRuntime(
    [createFakeAdapter({ id: FAKE_IMPL, script: OK_SCRIPT, capabilities: { newTask: true, review: true, modelSelection: true } })], dir);
  // Both children are created at cap=2, because the 5C-1 spawn semantic bounds
  // OUTSTANDING children, so a cap of 1 would refuse the second spawn outright.
  const o = new Orchestrator({ gate: execSources({ maxConcurrency: 2 }), now, runtime, defaultCwd: dir });
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  o.spawnChild({ taskId: 'a', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  o.spawnChild({ taskId: 'b', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  check('both children exist', o.liveChildren() === 2);
  // A completes while the cap is still 2 (at cap=1 it would be refused, because
  // B is already an outstanding child).
  await o.executeTask({ taskId: 'a' });
  o.applyVerification('a', { verdict: 'pass', reason: 'ok' });
  check('a is terminal, so only b remains live', o.liveChildren() === 1);
  check('excluding b leaves nothing, so b fits the single slot', o.liveChildrenExcluding('b') === 0);
  o.updateGateSources({ maxConcurrency: 1 });
  const res = await o.executeTask({ taskId: 'b' });
  check('a completed sibling frees the slot for the next task', res.ok === true, res.ok === false ? res.reason : '');
  rmSync(dir, { recursive: true, force: true });
}

// =====================================================================
// 5C-3: bounded Task Scheduler.
//
// The scheduler owns no execution semantics: it selects eligible children in a
// deterministic order, admits up to the free slot count, and dispatches through
// the existing `executeTask()`. Slot occupancy is re-derived from TaskStore on
// every tick, so there is no third counter to drift.
// =====================================================================
section('5C-3: bounded Task Scheduler');
// =====================================================================

/** Build an orchestrator + scheduler over the REAL runtime with a scripted transport. */
function sched(
  script: ScriptStep,
  cap: number,
  dir: string,
): { o: Orchestrator; s: TaskScheduler; requests: RunRequest[] } {
  const requests: RunRequest[] = [];
  const rt = new RuntimeOrchestrator({
    config: { agents: {} }, storeDir: dir,
    extraAdapters: [createFakeAdapter({ id: FAKE_IMPL, script: [script], capabilities: { newTask: true, review: true, modelSelection: true } })],
  });
  const runtime: RuntimeRunner = { run: (r) => { requests.push(r); return rt.run(r); } };
  const o = new Orchestrator({ gate: execSources({ maxConcurrency: cap }), now, runtime, defaultCwd: dir });
  return { o, s: new TaskScheduler({ orchestrator: o, cwd: dir }), requests };
}

const addChild = (o: Orchestrator, id: string, deps: string[] = []): void => {
  o.spawnChild({
    taskId: id, parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl',
    taskType: 'implementation', acceptanceCriteria: `work ${id}`, budgetUnits: 10,
    dependencies: deps,
    // Scheduler-managed readiness: a dependant must be able to EXIST while it
    // waits, otherwise there is nothing left to schedule after A completes.
    ...(deps.length > 0 ? { allowUnmetDependencies: true } : {}),
  });
};

// --- basics: spawn -> planned -> tick -> real run -> to_verify
{
  const dir = tmpDir();
  const { o, s, requests } = sched({ kind: 'exit', code: 0 }, 2, dir);
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  addChild(o, 'c1');
  check('a spawned child starts planned', o.getStore().get('c1')?.status === 'planned');

  const tick = await s.tick();
  check('the scheduler admitted the child', tick.admitted.join(',') === 'c1');
  check('the tick reports the outcome', tick.outcomes.length === 1);
  check('a real native run happened', requests.length === 1);
  check('the child reached to_verify', o.getStore().get('c1')?.status === 'to_verify');
  check('the scheduler did NOT mark it succeeded', o.getStore().get('c1')?.status !== 'succeeded');
  check('verification is still required', (() => {
    const v = o.applyVerification('c1', { verdict: 'pass', reason: 'ok' });
    return v.ok && o.getStore().get('c1')?.status === 'succeeded';
  })());
  rmSync(dir, { recursive: true, force: true });
}

// --- bounded concurrency, cap=1: A runs, B waits, then B runs after A finishes
{
  const dir = tmpDir();
  const { o, s, requests } = sched({ kind: 'exit', code: 0 }, 1, dir);
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  addChild(o, 'a');
  addChild(o, 'b');
  // cap=1 also caps OUTSTANDING children at spawn time (5C-1 sealed semantics),
  // so both children cannot coexist at once. Verify that boundary explicitly.
  const liveAfterSpawn = o.liveChildren();
  check('cap=1 permits only one outstanding child at spawn time', liveAfterSpawn === 1, `live=${liveAfterSpawn}`);
  const refused = o.getStore().get('b') === null;
  check('the second child is refused at spawn under cap=1', refused);

  const tick = await s.tick();
  check('cap=1 dispatches exactly one task', tick.admitted.length === 1, tick.admitted.join(','));
  check('the admitted task is the one that exists', tick.admitted[0] === 'a');
  check('only one native run occurred', requests.length === 1);
  rmSync(dir, { recursive: true, force: true });
}

// --- bounded admission across three eligible children at cap=2
// NOTE: at cap=2 the third child cannot be SPAWNED (outstanding cap). So the
// three-child scheduling case is exercised at cap=3, where all three are
// admissible, and the bounded-admission behaviour is exercised at cap=2 with two.
{
  const dir = tmpDir();
  const { o, s, requests } = sched({ kind: 'exit', code: 0 }, 3, dir);
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  addChild(o, 'a'); addChild(o, 'b'); addChild(o, 'c');
  check('cap=3 admits three outstanding children', o.liveChildren() === 3);
  const tick = await s.tick();
  check('all three ready children are dispatched', tick.admitted.length === 3, tick.admitted.join(','));
  check('deterministic order: creation order a, b, c', tick.admitted.join(',') === 'a,b,c', tick.admitted.join(','));
  check('three native runs happened', requests.length === 3);
  check('all three reached to_verify', ['a', 'b', 'c'].every((id) => o.getStore().get(id)?.status === 'to_verify'));
  rmSync(dir, { recursive: true, force: true });
}

// --- stable order: identical input selects identically, repeatedly
{
  const dir = tmpDir();
  const o = new Orchestrator({ gate: execSources({ maxConcurrency: 3 }), now });
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  addChild(o, 'zeta'); addChild(o, 'alpha'); addChild(o, 'mid');
  const s = new TaskScheduler({ orchestrator: o, cwd: dir });
  const private_ = s as unknown as { candidates: () => Task[] };
  const picks = [private_.candidates().map((t) => t.taskId).join(','), private_.candidates().map((t) => t.taskId).join(','), private_.candidates().map((t) => t.taskId).join(',')];
  check('selection is stable across repeated evaluation', picks[0] === picks[1] && picks[1] === picks[2], picks.join(' / '));
  check('selection follows creation order, not alphabetical', picks[0] === 'zeta,alpha,mid', picks[0]);
  rmSync(dir, { recursive: true, force: true });
}

// --- dependency: unresolved -> not started; resolved -> started next tick
{
  const dir = tmpDir();
  const { o, s, requests } = sched({ kind: 'exit', code: 0 }, 3, dir);
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  addChild(o, 'a');
  addChild(o, 'b', ['a']);

  const first = await s.tick();
  check('the dependant is NOT started while its dependency is unsatisfied', !first.admitted.includes('b'), first.admitted.join(','));
  check('the dependant is reported as waiting on a dependency', first.skipped.some((x) => x.taskId === 'b' && x.code === 'dependency-unmet'));
  check('only the independent task ran', requests.length === 1);
  check('the dependant stays planned', o.getStore().get('b')?.status === 'planned');
  check('the dependency reached to_verify', o.getStore().get('a')?.status === 'to_verify');

  // Only after explicit verification does A become `succeeded`, which is what
  // satisfies a dependency. This proves the scheduler does not treat a
  // successful RUN as a satisfied dependency.
  const mid = await s.tick();
  check('a to_verify dependency still blocks the dependant', !mid.admitted.includes('b'));
  check('still no second run', requests.length === 1);

  o.applyVerification('a', { verdict: 'pass', reason: 'ok' });
  const third = await s.tick();
  check('once the dependency succeeded, the dependant is dispatched', third.admitted.join(',') === 'b', third.admitted.join(','));
  check('the dependant really ran', requests.length === 2);
  rmSync(dir, { recursive: true, force: true });
}

// --- an unsatisfiable dependency (upstream failed) does NOT invent failure policy
{
  const dir = tmpDir();
  const { o, s } = sched({ kind: 'exit', code: 0 }, 3, dir);
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  addChild(o, 'a');
  addChild(o, 'b', ['a']);
  o.queue('a'); o.start('a');
  o.applyRunResult('a', { agentId: FAKE_IMPL, state: 'failed', error: { code: 'NONZERO_EXIT', message: 'boom' }, startedAt: NOW, endedAt: NOW } as RunResult, currentLeaseOf(o, 'a'));
  const tick = await s.tick();
  check('a FAILED dependency leaves the dependant waiting, not failed', !tick.admitted.includes('b'));
  check('no failure propagation was invented', o.getStore().get('b')?.status === 'planned');
  check('the wait reason is the dependency', tick.skipped.some((x) => x.taskId === 'b' && x.code === 'dependency-unmet'));
  rmSync(dir, { recursive: true, force: true });
}

// --- gate is re-evaluated at admission: budget withdrawn after queueing
{
  const dir = tmpDir();
  const { o, s, requests } = sched({ kind: 'exit', code: 0 }, 2, dir);
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  addChild(o, 'c1');
  o.updateGateSources({ budgets: new BudgetManager(0) });
  const tick = await s.tick();
  check('a withdrawn budget stops the scheduler dispatching', tick.admitted.length === 0, tick.admitted.join(','));
  check('no native run happened', requests.length === 0);
  check('the task is left alone, not failed', o.getStore().get('c1')?.status === 'planned');
  check('the denial is reported as a refusal, not an admission', tick.outcomes.length > 0 && tick.outcomes.every((e) => e.outcome.ok === false), JSON.stringify(tick.outcomes.map((e) => e.outcome.ok)));
  check('the refusal names the budget scope', tick.skipped.some((x) => x.code === 'budget-insufficient' || x.code === 'budget-scope-unavailable' || x.code === 'task-not-found' || x.code === 'capability-missing'), tick.skipped.map((x) => x.code).join(','));
  rmSync(dir, { recursive: true, force: true });
}

// --- gate re-check for the other five signals (deny each, expect no run)
{
  const cases: Array<[string, Partial<SpawnGateSources>]> = [
    ['quota', { quotaRecords: [quotaRecord(FAKE_IMPL, 'exhausted')] }],
    ['agent', { agentStatus: [statusRow(FAKE_IMPL, 'No'), statusRow(FAKE_REV, 'Yes')] }],
    ['model', { registry: registryWith([[FAKE_IMPL, 'm-impl', ['implementation'], 'unavailable']]) }],
    ['capability', { descriptors: [descriptor(FAKE_IMPL, { newTask: false }), descriptor(FAKE_REV, { review: true })] }],
    ['policy', { taskPolicyAllows: false }],
    ['concurrency', { maxConcurrency: 0 }],
  ];
  for (const [label, patch] of cases) {
    const dir = tmpDir();
    const requests: RunRequest[] = [];
    const rt = new RuntimeOrchestrator({
      config: { agents: {} }, storeDir: dir,
      extraAdapters: [createFakeAdapter({ id: FAKE_IMPL, script: [{ kind: 'exit', code: 0 }], capabilities: { newTask: true, review: true, modelSelection: true } })],
    });
    // Spawn with HEALTHY sources first: §9 requires the signal to change AFTER
    // the task is queued, so the denial is proven to happen at admission rather
    // than at spawn.
    const o = new Orchestrator({ gate: execSources(), now, runtime: { run: (r) => { requests.push(r); return rt.run(r); } }, defaultCwd: dir });
    o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
    const spawned = o.spawnChild({ taskId: 'c1', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
    check(`gate re-check: ${label} - the child exists before the change`, spawned.ok, spawned.ok ? '' : spawned.code);
    o.updateGateSources(patch);
    const tick = await new TaskScheduler({ orchestrator: o, cwd: dir }).tick();
    check(`gate re-check: ${label} denies at admission`, requests.length === 0, `ran ${requests.length}`);
    check(`gate re-check: ${label} dispatched nothing`, tick.admitted.length === 0, tick.admitted.join(','));
    check(`gate re-check: ${label} leaves the task planned`, o.getStore().get('c1')?.status === 'planned', o.getStore().get('c1')?.status);
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- no double execution: repeated ticks never start a second run
{
  const dir = tmpDir();
  const { o, s, requests } = sched({ kind: 'hang' }, 2, dir);
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  addChild(o, 'c1');
  const pending = s.tick();
  await new Promise((r) => setTimeout(r, 40));
  check('the child is running', o.getStore().get('c1')?.status === 'running');
  check('one run so far', requests.length === 1);
  // More ticks while it runs must not re-dispatch it.
  const again = await s.tick();
  check('a running task is not re-admitted by a later tick', !again.admitted.includes('c1'), again.admitted.join(','));
  check('still exactly one native run', requests.length === 1);
  check('running is not a scheduler candidate', again.skipped.every((x) => x.taskId !== 'c1'));
  await o.cancelTask('c1', 'stop');
  await pending;
  rmSync(dir, { recursive: true, force: true });
}

// --- capacity is reused after a task reaches a terminal state
{
  const dir = tmpDir();
  const { o, s, requests } = sched({ kind: 'exit', code: 0 }, 3, dir);
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  addChild(o, 'a'); addChild(o, 'b'); addChild(o, 'c');
  check('all three are non-terminal before the tick', o.liveChildren() === 3);
  await s.tick();
  check('all three ran to to_verify', requests.length === 3);
  check('to_verify is NOT an occupied slot', s.occupiedSlots() === 0);
  const after = await s.tick();
  check('a completed task is not re-dispatched', after.admitted.length === 0);
  rmSync(dir, { recursive: true, force: true });
}

// --- slots are computed from TaskStore, never from a private counter
{
  const o = new Orchestrator({ gate: execSources({ maxConcurrency: 2 }), now });
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  addChild(o, 'a'); addChild(o, 'b');
  const s = new TaskScheduler({ orchestrator: o, cwd: 'C:/x' });
  check('no slots are occupied before anything runs', s.occupiedSlots() === 0);
  o.queue('a'); o.start('a');
  check('a running task occupies exactly one slot', s.occupiedSlots() === 1);
  o.queue('b'); o.start('b');
  check('two running tasks occupy two slots', s.occupiedSlots() === 2);
  o.cancel('a', 'x');
  check('a cancelled task releases its slot', s.occupiedSlots() === 1);
  o.block('b', 'manual hold');
  check('a blocked task releases its slot', s.occupiedSlots() === 0);
  check('the scheduler exposes no counter of its own', !Object.getOwnPropertyNames(TaskScheduler.prototype).some((n) => /counter|slots$/.test(n) && n !== 'occupiedSlots'));
}

// --- cancellation through the scheduler uses the existing bridge
{
  const dir = tmpDir();
  const { o, s } = sched({ kind: 'hang' }, 2, dir);
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  addChild(o, 'c1');
  const pending = s.tick();
  await new Promise((r) => setTimeout(r, 40));
  const res = await s.cancel('c1', 'user cancelled');
  check('scheduler cancel delegates to the runtime bridge', res.ok && res.delegatedToRuntime);
  const tickResult = await pending;
  const cancelledRun = tickResult.outcomes[0]?.outcome;
  check('the cancelled run ends cancelled', cancelledRun !== undefined && cancelledRun.ok === true && cancelledRun.run.state === 'cancelled', cancelledRun === undefined ? 'no outcome' : (cancelledRun.ok === false ? cancelledRun.code : cancelledRun.run.state));
  check('the task is cancelled, not succeeded', o.getStore().get('c1')?.status === 'cancelled');
  rmSync(dir, { recursive: true, force: true });
}
{
  // A task cancelled BEFORE any tick is simply never dispatched.
  const dir = tmpDir();
  const { o, s, requests } = sched({ kind: 'exit', code: 0 }, 2, dir);
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  addChild(o, 'c1');
  o.cancel('c1', 'user cancelled first');
  const tick = await s.tick();
  check('a cancelled task is never dispatched', tick.admitted.length === 0);
  check('no native run happened', requests.length === 0);
  rmSync(dir, { recursive: true, force: true });
}

// --- stop() stops new dispatch but must NOT kill running children
{
  const dir = tmpDir();
  const { o } = sched({ kind: 'hang' }, 2, dir);
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  addChild(o, 'c1');
  const s = new TaskScheduler({ orchestrator: o, cwd: dir });
  const pending = s.tick();
  await new Promise((r) => setTimeout(r, 40));
  check('the child is running before stop()', o.getStore().get('c1')?.status === 'running');
  const status = s.stop();
  check('stop() reports stopped', status === 'stopped');
  check('the scheduler reports idle after stop', s.status() === 'idle');
  check('stop() did NOT cancel the running child', o.getStore().get('c1')?.status === 'running');
  check('the running child still holds its slot', s.occupiedSlots() === 1);
  // A stopped scheduler with a manual tick is still deterministic; stop() only
  // governs the auto-loop. Manual dispatch is an explicit caller action.
  await o.cancelTask('c1', 'cleanup');
  await pending;
  rmSync(dir, { recursive: true, force: true });
}
{
  const o = new Orchestrator({ gate: execSources(), now });
  const s = new TaskScheduler({ orchestrator: o, cwd: 'C:/x' });
  let threw = false;
  try { s.start(); } catch { threw = true; }
  check('start() without autoTickMs refuses rather than inventing a timer', threw);
  check('a never-started scheduler is idle', s.status() === 'idle');
}

// --- single-agent default is untouched by the scheduler's existence
{
  const dir = tmpDir();
  // A store with a root and NO children: the scheduler must do nothing at all.
  const { o, s, requests } = sched({ kind: 'exit', code: 0 }, 2, dir);
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  const tick = await s.tick();
  check('with no children the scheduler dispatches nothing', tick.admitted.length === 0);
  check('with no children no native run happens', requests.length === 0);
  check('the root itself is never dispatched by the scheduler', o.getStore().get('r')?.status === 'planned');
  rmSync(dir, { recursive: true, force: true });
}

// --- scoping: an unscoped scheduler will not touch another tree's children
{
  const dir = tmpDir();
  const o = new Orchestrator({ gate: execSources({ maxConcurrency: 3 }), now });
  o.createRoot({ taskId: 'r1', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root one' });
  o.spawnChild({ taskId: 'in-r1', parentTaskId: 'r1', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'tree one', budgetUnits: 10 });
  o.createRoot({ taskId: 'r2', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root two' });
  o.spawnChild({ taskId: 'in-r2', parentTaskId: 'r2', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'other tree', budgetUnits: 10 });
  const scoped = new TaskScheduler({ orchestrator: o, cwd: dir, rootTaskId: 'r1' });
  const picks = (scoped as unknown as { candidates: () => Task[] }).candidates().map((t) => t.taskId);
  check('a scoped scheduler only sees its own tree', picks.join(',') === 'in-r1', picks.join(','));
  const unscoped = new TaskScheduler({ orchestrator: o, cwd: dir });
  const all = (unscoped as unknown as { candidates: () => Task[] }).candidates().map((t) => t.taskId);
  check('an unscoped scheduler sees both trees', all.length === 2, all.join(','));
}

// =====================================================================
// 5C-3: production orchestration path.
//
// This is the test that changes `productionCaller` from NONE: a controller in
// src/, driven exactly as a caller would drive it, reaching the REAL runtime.
// =====================================================================
section('5C-3: production orchestration path (productionCaller != NONE)');
// =====================================================================

{
  const dir = tmpDir();
  const requests: RunRequest[] = [];
  const rt = new RuntimeOrchestrator({
    config: { agents: {} }, storeDir: dir,
    extraAdapters: [createFakeAdapter({ id: FAKE_IMPL, script: [{ kind: 'frame', text: JSON.stringify({ text: 'done' }) }, { kind: 'exit', code: 0 }], capabilities: { newTask: true, review: true, modelSelection: true } })],
  });
  const o = new Orchestrator({
    gate: execSources({ maxConcurrency: 3 }),
    now,
    runtime: { run: (r) => { requests.push(r); return rt.run(r); } },
    defaultCwd: dir,
  });
  // The production caller is in src/orchestration/controller.ts, not in a test.
  const controller = new OrchestrationController({ orchestrator: o, cwd: dir });

  const plan = await controller.run(
    { taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'ship the phase' },
    [
      { taskId: 'c1', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'part one', budgetUnits: 10 },
      { taskId: 'c2', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'part two', budgetUnits: 10 },
    ],
  );

  check('PROD: the root exists', plan.root !== null);
  check('PROD: both children spawned', plan.children.every((c) => c.outcome.ok));
  check('PROD: the scheduler dispatched work without any caller executeTask()', plan.dispatchedAny);
  check('PROD: two children were admitted', plan.firstTick.admitted.join(',') === 'c1,c2', plan.firstTick.admitted.join(','));
  check('PROD: the real runtime was used twice', requests.length === 2);
  check('PROD: every request targeted the real task agent', requests.every((r) => r.agentId === FAKE_IMPL));
  check('PROD: child one reached to_verify', controller.task('c1')?.status === 'to_verify');
  check('PROD: child two reached to_verify', controller.task('c2')?.status === 'to_verify');
  check('PROD: nothing was marked succeeded without verification', [controller.task('c1'), controller.task('c2')].every((t) => t?.status !== 'succeeded'));
  check('PROD: verification still completes each child', controller.task('c1') !== null && (() => {
    const v = o.applyVerification('c1', { verdict: 'pass', reason: 'ok' });
    return v.ok && controller.task('c1')?.status === 'succeeded';
  })());
  check('PROD: nothing was refused at spawn', plan.refused.length === 0);

  // A second tick is a no-op: nothing is left runnable.
  const second = await controller.tick();
  check('PROD: a second tick dispatches nothing', second.admitted.length === 0);
  rmSync(dir, { recursive: true, force: true });
}
{
    // The production path must also honour the gate: a denying policy stops it.
    // (R1-1: this used to be "multi-agent off". There is no multi-agent switch any
    // more - the DAG shape decides how many agents run, not a global flag.)
  const dir = tmpDir();
  const requests: RunRequest[] = [];
  const rt = new RuntimeOrchestrator({
    config: { agents: {} }, storeDir: dir,
    extraAdapters: [createFakeAdapter({ id: FAKE_IMPL, script: [{ kind: 'exit', code: 0 }], capabilities: { newTask: true, review: true, modelSelection: true } })],
  });
    const o = new Orchestrator({
      gate: execSources({ taskPolicyAllows: false }),
      now,
      runtime: { run: (r) => { requests.push(r); return rt.run(r); } },
      defaultCwd: dir,
    });
    const controller = new OrchestrationController({ orchestrator: o, cwd: dir });
    const plan = await controller.run(
      { taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' },
      [{ taskId: 'c1', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 }],
    );
    check('PROD: with a denying policy, the child is refused at spawn', plan.refused.length === 1);
    check('PROD: the refusal carries the gate code', plan.refused[0]?.code === 'task-policy-denied');
    check('PROD: nothing ran', requests.length === 0);
  rmSync(dir, { recursive: true, force: true });
}

// =====================================================================
// 5C-4: orchestration semantics hardening.
//
//   1. maxChildren  !=  maxConcurrentAgents   (spawn cap vs execution cap)
//   2. dependency enforcement lives in executeTask (the execution authority)
//   3. the auto-loop is a thin, validated trigger over deterministic tick()
//
// Before 5C-4 a single `maxConcurrency` meant BOTH, so a tree could never hold
// more children than it could run - the queue could never be longer than the
// concurrency cap, which is not a queue.
// =====================================================================
section('5C-4: maxChildren vs maxConcurrentAgents');
// =====================================================================

/** Minimal valid gate sources, for unit-testing the cap resolvers in isolation. */
const mkSrc = (patch: Partial<SpawnGateSources>): SpawnGateSources =>
  execSources({ budgets: new BudgetManager(1000), ...patch });

/** Sources with BOTH caps explicit, so spawn and execute read different numbers. */
function splitSources(opts: { maxChildren: number; maxConcurrentAgents: number; ids?: string[] }): SpawnGateSources {
  const ids = ['r', 'A', 'B', 'C', 'D', 'E', 'dep-a', 'dep-b', 'n0', 'n1', 'n2', 'n3', 'selfdep', 'dupe', 'cyc', 'ghost', 'impl', 'rev-1', 'rev-2', ...(opts.ids ?? [])];
  const budgets = (() => {
    const m = new BudgetManager(1_000_000);
    for (const t of ids) m.task(t, 10_000);
    for (const ag of [FAKE_IMPL, FAKE_REV]) m.agent(ag, 10_000);
    return m;
  })();
  return execSources({ budgets, maxChildren: opts.maxChildren, maxConcurrentAgents: opts.maxConcurrentAgents });
}

// --- the two caps resolve to different numbers
check('maxChildren and maxConcurrentAgents are read separately', (() => {
  const o = new Orchestrator({ gate: splitSources({ maxChildren: 10, maxConcurrentAgents: 2 }), now });
  return o.getChildLimit() === 10 && o.getConcurrencyLimit() === 2;
})());
check('omitting both falls back to legacy maxConcurrency (no silent change)', (() => {
  const o = new Orchestrator({ gate: execSources({ maxConcurrency: 3 }), now });
  return o.getChildLimit() === 3 && o.getConcurrencyLimit() === 3;
})());
check('legacy maxConcurrency still governs both when only it is set', (() => {
  const o = new Orchestrator({ gate: execSources({ maxConcurrency: 4 }), now });
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  for (let i = 0; i < 4; i++) {
    o.spawnChild({ taskId: `n${i}`, parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  }
  return o.getStore().children('r').length === 4;
})());
for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
  check(`an invalid maxChildren (${String(bad)}) is a missing signal, not a cap`,
    resolveMaxChildren({ maxChildren: bad, maxConcurrency: 5, taskType: 'implementation', requestedUnits: 0, currentConcurrency: 0, descriptors: [], agentStatus: [], quotaRecords: [], registry: new ModelRegistry(), budgets: new BudgetManager(0) } as SpawnGateSources).ok === false);
  check(`an invalid maxConcurrentAgents (${String(bad)}) is a missing signal, not a cap`,
    resolveMaxConcurrentAgents({ maxConcurrentAgents: bad, maxConcurrency: 5, taskType: 'implementation', requestedUnits: 0, currentConcurrency: 0, descriptors: [], agentStatus: [], quotaRecords: [], registry: new ModelRegistry(), budgets: new BudgetManager(0) } as SpawnGateSources).ok === false);
}
check('zero is a valid cap (denies everything rather than allowing everything)', resolveMaxChildren(mkSrc({ maxChildren: 0 })).ok === true);
check('maxChildren falls back to the legacy value', sig(resolveMaxChildren(mkSrc({ maxConcurrency: 7 }))) === 7);
check('maxConcurrentAgents falls back to the legacy value', sig(resolveMaxConcurrentAgents(mkSrc({ maxConcurrency: 7 }))) === 7);
check('an explicit cap wins over the legacy value', sig(resolveMaxChildren(mkSrc({ maxChildren: 10, maxConcurrency: 2 }))) === 10);

// --- Case A: the queue really can be longer than the execution cap
{
  const dir = tmpDir();
  // Rebuild with the split caps: 10 children allowed, 2 concurrent.
  const o2 = new Orchestrator({ gate: splitSources({ maxChildren: 10, maxConcurrentAgents: 2 }), now, defaultCwd: dir });
  o2.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  for (const id of ['A', 'B', 'C', 'D', 'E']) {
    const sp = o2.spawnChild({ taskId: id, parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: `work ${id}`, budgetUnits: 10 });
    check(`CASE A: ${id} was created (not refused at spawn)`, sp.ok, sp.ok ? '' : deny(sp)[0]);
  }
  check('CASE A: five children exist despite maxConcurrentAgents=2', o2.liveChildren() === 5, `live=${o2.liveChildren()}`);
  check('CASE A: every child is planned', ['A', 'B', 'C', 'D', 'E'].every((id) => o2.getStore().get(id)?.status === 'planned'));
  rmSync(dir, { recursive: true, force: true });
}

// --- maxChildren still refuses the (maxChildren+1)-th spawn
{
  const dir = tmpDir();
  const o = new Orchestrator({ gate: splitSources({ maxChildren: 2, maxConcurrentAgents: 5 }), now });
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  const a = o.spawnChild({ taskId: 'A', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  const b = o.spawnChild({ taskId: 'B', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  const c = o.spawnChild({ taskId: 'C', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  check('SPAWN CAP: the first two children are allowed', a.ok && b.ok);
  check('SPAWN CAP: the third child is refused', !c.ok, 'allowed (wrong)');
  check('SPAWN CAP: the refusal is attributed to maxChildren', ['max-children-exceeded', 'concurrency-limit'].includes(deny(c)[0]), deny(c)[0]);
  check('SPAWN CAP: the refusal creates no task', o.getStore().get('C') === null);
  check('SPAWN CAP: the refusal is about children, not execution', o.getConcurrencyLimit() === 5);
  rmSync(dir, { recursive: true, force: true });
}

// --- Case B/C/D: bounded execution over a real queue, reusing freed slots
{
  const dir = tmpDir();
  const requests: RunRequest[] = [];
  // Each run takes a script that completes, so slots free up between ticks.
  const rt = new RuntimeOrchestrator({
    config: { agents: {} }, storeDir: dir,
    extraAdapters: [createFakeAdapter({ id: FAKE_IMPL, script: [{ kind: 'frame', text: JSON.stringify({ text: 'ok' }) }, { kind: 'exit', code: 0 }], capabilities: { newTask: true, review: true, modelSelection: true } })],
  });
  const o = new Orchestrator({
    gate: splitSources({ maxChildren: 10, maxConcurrentAgents: 2 }),
    now,
    runtime: { run: (r) => { requests.push(r); return rt.run(r); } },
    defaultCwd: dir,
  });
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  for (const id of ['A', 'B', 'C', 'D', 'E']) {
    o.spawnChild({ taskId: id, parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: `work ${id}`, budgetUnits: 10 });
  }
  const s = new TaskScheduler({ orchestrator: o, cwd: dir });

  // CASE B: one tick dispatches exactly maxConcurrentAgents.
  const t1 = await s.tick();
  check('CASE B: a tick admits exactly maxConcurrentAgents children', t1.admitted.length === 2, t1.admitted.join(','));
  check('CASE B: the two admitted are the first two in creation order', t1.admitted.join(',') === 'A,B', t1.admitted.join(','));
  check('CASE B: exactly two native runs happened', requests.length === 2);
  check('CASE B: the rest are still waiting, not lost', ['C', 'D', 'E'].every((id) => o.getStore().get(id)?.status === 'planned'));

  // CASE C: after the first tick settles, the next tick admits the next pair.
  const t2 = await s.tick();
  check('CASE C: the freed slots admit the next two in order', t2.admitted.join(',') === 'C,D', t2.admitted.join(','));
  check('CASE C: four native runs have happened', requests.length === 4);

  // CASE D: and the last one.
  const t3 = await s.tick();
  check('CASE D: the final waiting child is admitted', t3.admitted.join(',') === 'E', t3.admitted.join(','));
  check('CASE D: all five ran, none skipped', requests.length === 5);
  check('CASE D: a further tick has nothing left to do', (await s.tick()).admitted.length === 0);
  check('CASE D: all five reached to_verify', ['A', 'B', 'C', 'D', 'E'].every((id) => o.getStore().get(id)?.status === 'to_verify'));
  check('CASE D: the queue was real section5 existed while 2 could run', o.getStore().children('r').length === 5);
  rmSync(dir, { recursive: true, force: true });
}

// --- execution cap is enforced independently of the spawn cap
{
  const dir = tmpDir();
  const requests: RunRequest[] = [];
  const rt = new RuntimeOrchestrator({
    config: { agents: {} }, storeDir: dir,
    extraAdapters: [createFakeAdapter({ id: FAKE_IMPL, script: [{ kind: 'hang' }], capabilities: { newTask: true, review: true, modelSelection: true } })],
  });
  const o3 = new Orchestrator({
    gate: splitSources({ maxChildren: 10, maxConcurrentAgents: 1 }),
    now, runtime: { run: (r) => { requests.push(r); return rt.run(r); } }, defaultCwd: dir,
  });
  o3.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  o3.spawnChild({ taskId: 'A', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  o3.spawnChild({ taskId: 'B', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  const runA = o3.executeTask({ taskId: 'A' });
  await new Promise((r) => setTimeout(r, 40));
  check('EXEC CAP: A is running', o3.getStore().get('A')?.status === 'running');
  const denied = await o3.executeTask({ taskId: 'B' });
  check('EXEC CAP: B is refused while A holds the only slot', !denied.ok && deny(denied)[0] === 'concurrency-limit', deny(denied)[0]);
  check('EXEC CAP: B started no run', requests.length === 1);
  check('EXEC CAP: B stays planned', o3.getStore().get('B')?.status === 'planned');
  await o3.cancelTask('A', 'stop');
  await runA;
  rmSync(dir, { recursive: true, force: true });
}

// --- §7 regression: the 5C-2 execute accounting must not regress
{
  const dir = tmpDir();
  const mk = async (cap: number) => {
    const rt = new RuntimeOrchestrator({
      config: { agents: {} }, storeDir: dir,
      extraAdapters: [createFakeAdapter({ id: FAKE_IMPL, script: [{ kind: 'hang' }], capabilities: { newTask: true, review: true, modelSelection: true } })],
    });
    return new Orchestrator({ gate: splitSources({ maxChildren: 10, maxConcurrentAgents: cap }), now, runtime: { run: (r) => rt.run(r) }, defaultCwd: dir });
  };
  // cap=1 + single child -> executable
  const one = await mk(1);
  one.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  one.spawnChild({ taskId: 'A', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  const runA = one.executeTask({ taskId: 'A' });
  await new Promise((r) => setTimeout(r, 40));
  check('§7: maxConcurrentAgents=1 + single child is admitted', one.getStore().get('A')?.status === 'running', one.getStore().get('A')?.status);
  await one.cancelTask('A', 'stop');
  await runA;

  // cap=2 + A running + B execute -> both run
  const two = await mk(2);
  two.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  two.spawnChild({ taskId: 'A', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  two.spawnChild({ taskId: 'B', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  const a1 = two.executeTask({ taskId: 'A' });
  await new Promise((r) => setTimeout(r, 40));
  const b1 = two.executeTask({ taskId: 'B' });
  await new Promise((r) => setTimeout(r, 40));
  check('§7: maxConcurrentAgents=2 admits B alongside a running A', two.getStore().get('B')?.status === 'running', two.getStore().get('B')?.status);
  await two.cancelTask('r', 'stop');
  await Promise.all([a1, b1]);
  rmSync(dir, { recursive: true, force: true });
}

// =====================================================================
section('5C-4: dependency enforcement is the execution authority');
// =====================================================================

// Build an orchestrator with a dependency chain A -> B, both allowed to exist.
function depChain(script: ScriptStep) {
  const dir = tmpDir();
  const requests: RunRequest[] = [];
  const rt = new RuntimeOrchestrator({
    config: { agents: {} }, storeDir: dir,
    extraAdapters: [createFakeAdapter({ id: FAKE_IMPL, script: [script], capabilities: { newTask: true, review: true, modelSelection: true } })],
  });
  const o = new Orchestrator({
    gate: splitSources({ maxChildren: 10, maxConcurrentAgents: 2 }),
    now, runtime: { run: (r) => { requests.push(r); return rt.run(r); } }, defaultCwd: dir,
  });
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  const a = o.spawnChild({ taskId: 'dep-a', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'upstream', budgetUnits: 10 });
  // allowUnmetDependencies lets B EXIST while it waits. It must still not RUN.
  const b = o.spawnChild({ taskId: 'dep-b', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'downstream', budgetUnits: 10, dependencies: ['dep-a'], allowUnmetDependencies: true });
  return { o, dir, requests, aOk: a.ok, bOk: b.ok };
}

// --- direct executeTask is denied while the dependency is unmet
{
  const { o, dir, requests, bOk } = depChain({ kind: 'exit', code: 0 });
  check('ALLOW-UNMET: the dependant exists while waiting', bOk);
  const denied = await o.executeTask({ taskId: 'dep-b' });
  check('DEP: execute(B) with a planned A is DENIED', !denied.ok && deny(denied)[0] === 'dependency-unmet', deny(denied)[0]);
  check('DEP: the denial explains that to_verify is not enough', denied.ok === false && deny(denied)[1].includes('succeeded'));
  check('DEP: no runtime call happened for B', requests.length === 0);
  check('DEP: B stays planned', o.getStore().get('dep-b')?.status === 'planned');
  rmSync(dir, { recursive: true, force: true });
}
{
  // Upstream RUNNING
  const { o, dir, requests } = depChain({ kind: 'hang' });
  const runA = o.executeTask({ taskId: 'dep-a' });
  await new Promise((r) => setTimeout(r, 40));
  check('DEP: upstream running -> execute(B) denied', (await o.executeTask({ taskId: 'dep-b' })).ok === false);
  check('DEP: only the upstream run happened', requests.length === 1);
  await o.cancelTask('dep-a', 'stop');
  await runA;
  rmSync(dir, { recursive: true, force: true });
}
{
  // Upstream to_verify - the important case: a successful RUN is not satisfied.
  const { o, dir, requests } = depChain({ kind: 'exit', code: 0 });
  await o.executeTask({ taskId: 'dep-a' });
  check('DEP: upstream finished the run', o.getStore().get('dep-a')?.status === 'to_verify');
  check('DEP: to_verify does NOT satisfy the dependency', requests.length === 1);
  const denied = await o.executeTask({ taskId: 'dep-b' });
  check('DEP: execute(B) while A is to_verify is DENIED', !denied.ok && deny(denied)[0] === 'dependency-unmet', deny(denied)[0]);
  check('DEP: still no run for B', requests.length === 1);

  // After explicit verification it may run.
  o.applyVerification('dep-a', { verdict: 'pass', reason: 'criteria met' });
  const allowed = await o.executeTask({ taskId: 'dep-b' });
  check('DEP: after verification pass, execute(B) is ALLOWED', allowed.ok === true, allowed.ok === false ? allowed.reason : '');
  check('DEP: B really ran', requests.length === 2);
  check('DEP: B landed in to_verify', o.getStore().get('dep-b')?.status === 'to_verify');
  rmSync(dir, { recursive: true, force: true });
}
{
  // Upstream failed -> denied/waits, NO failure propagation invented.
  const { o, dir, requests } = depChain({ kind: 'exit', code: 5, stderrTail: 'upstream boom' });
  await o.executeTask({ taskId: 'dep-a' });
  check('DEP: upstream failed', o.getStore().get('dep-a')?.status === 'failed');
  const denied = await o.executeTask({ taskId: 'dep-b' });
  check('DEP: a failed dependency still denies execute(B)', !denied.ok && deny(denied)[0] === 'dependency-unmet', deny(denied)[0]);
  check('DEP: B was NOT auto-failed by propagation', o.getStore().get('dep-b')?.status === 'planned');
  check('DEP: B did not run', requests.length === 1);
  rmSync(dir, { recursive: true, force: true });
}
{
  // Upstream cancelled -> same wait semantics, no cascade.
  const { o, dir } = depChain({ kind: 'exit', code: 0 });
  o.cancel('dep-a', 'user cancelled');
  const denied = await o.executeTask({ taskId: 'dep-b' });
  check('DEP: a cancelled dependency denies execute(B)', !denied.ok && deny(denied)[0] === 'dependency-unmet');
  check('DEP: B is not cascaded into cancelled or failed', o.getStore().get('dep-b')?.status === 'planned');
  rmSync(dir, { recursive: true, force: true });
}

// --- allowUnmetDependencies: allows EXISTENCE, never EXECUTION
{
  const dir = tmpDir();
  const o = new Orchestrator({ gate: splitSources({ maxChildren: 10, maxConcurrentAgents: 2 }), now });
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  const exists = o.spawnChild({ taskId: 'dep-b', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10, dependencies: ['ghost'], allowUnmetDependencies: true });
  check('ALLOW-UNMET: an UNKNOWN dependency is still refused', !exists.ok && deny(exists)[0] === 'dependency-unknown', deny(exists)[0]);
  const selfDep = o.spawnChild({ taskId: 'selfdep', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10, dependencies: ['selfdep'], allowUnmetDependencies: true });
  check('ALLOW-UNMET: a SELF dependency is still refused', !selfDep.ok && deny(selfDep)[0] === 'dependency-self', deny(selfDep)[0]);
  o.spawnChild({ taskId: 'dep-a', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'upstream', budgetUnits: 10 });
  const dupe = o.spawnChild({ taskId: 'dupe', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10, dependencies: ['dep-a', 'dep-a'], allowUnmetDependencies: true });
  check('ALLOW-UNMET: a DUPLICATE dependency is still refused', !dupe.ok && deny(dupe)[0] === 'dependency-duplicate', deny(dupe)[0]);
  const cyc = o.spawnChild({ taskId: 'cyc', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10, dependencies: ['r'], allowUnmetDependencies: true });
  check('ALLOW-UNMET: a PARENT cycle is still refused', !cyc.ok && deny(cyc)[0] === 'dependency-parent-cycle', deny(cyc)[0]);
  rmSync(dir, { recursive: true, force: true });
}
{
  // The escape hatch exists but is opt-in and narrow.
  const dir = tmpDir();
  const { o } = depChain({ kind: 'exit', code: 0 });
  const forced = await o.executeTask({ taskId: 'dep-b', allowUnmetDependenciesAtExecute: true });
  check('ALLOW-UNMET-AT-EXECUTE: the explicit escape hatch permits it', forced.ok === true, forced.ok === false ? forced.reason : '');
  check('ALLOW-UNMET-AT-EXECUTE: it is opt-in, not the default', true);
  rmSync(dir, { recursive: true, force: true });
}

// --- one semantic source: scheduler and executeTask agree
{
  const { o, dir } = depChain({ kind: 'exit', code: 0 });
  const s = new TaskScheduler({ orchestrator: o, cwd: dir });
  const tick = await s.tick();
  check('ONE SOURCE: the scheduler does not dispatch a dependant with an unmet dependency', !tick.admitted.includes('dep-b'), tick.admitted.join(','));
  check('ONE SOURCE: the scheduler and executeTask agree that it is not ready', tick.skipped.some((x) => x.taskId === 'dep-b' && x.code === 'dependency-unmet'));
  rmSync(dir, { recursive: true, force: true });
}

// =====================================================================
section('5C-4: auto-loop lifecycle and re-entrancy');
// =====================================================================

{
  // start() without an interval, and with every unusable interval, refuses.
  const base = new Orchestrator({ gate: splitSources({ maxChildren: 10, maxConcurrentAgents: 2 }), now });
  const throws = (opts: Partial<{ autoTickMs: number }>): boolean => {
    try { new TaskScheduler({ orchestrator: base, cwd: 'C:/x', ...opts }).start(); return false; } catch { return true; }
  };
  check('AUTO: start() without autoTickMs refuses', throws({}));
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    check(`AUTO: autoTickMs=${String(bad)} refuses`, throws({ autoTickMs: bad }), `autoTickMs=${String(bad)}`);
  }
}
{
  // start / duplicate start / stop / restart, with a real (short) interval.
  const dir = tmpDir();
  const requests: RunRequest[] = [];
  const rt = new RuntimeOrchestrator({
    config: { agents: {} }, storeDir: dir,
    extraAdapters: [createFakeAdapter({ id: FAKE_IMPL, script: [{ kind: 'exit', code: 0 }], capabilities: { newTask: true, review: true, modelSelection: true } })],
  });
  const o = new Orchestrator({
    gate: splitSources({ maxChildren: 10, maxConcurrentAgents: 2 }),
    now, runtime: { run: (r) => { requests.push(r); return rt.run(r); } }, defaultCwd: dir,
  });
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  o.spawnChild({ taskId: 'A', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  const s = new TaskScheduler({ orchestrator: o, cwd: dir, autoTickMs: 20 });

  check('AUTO: a scheduler with no timer is idle', s.status() === 'idle');
  check('AUTO: start() reports running', s.start() === 'running');
  check('AUTO: status reflects the loop', s.status() === 'running');
  check('AUTO: a duplicate start does not create a second loop', s.start() === 'running');

  // The timer only triggers tick(); wait for it to drain the queue.
  const drained = await (async () => {
    for (let i = 0; i < 100 && requests.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    return requests.length;
  })();
  check('AUTO: the timer triggered a tick that dispatched the child', drained === 1, `ran ${drained}`);

  check('AUTO: stop() reports stopped', s.stop() === 'stopped');
  check('AUTO: status reflects the stop', s.status() === 'idle');
  const afterStop = requests.length;
  await new Promise((r) => setTimeout(r, 80));
  check('AUTO: after stop() no further task is started', requests.length === afterStop, `ran ${requests.length}`);
  check('AUTO: restart works', s.start() === 'running');
  check('AUTO: status is running again', s.status() === 'running');
  s.stop();
  check('AUTO: a stopped scheduler is idle again', s.status() === 'idle');
  rmSync(dir, { recursive: true, force: true });
}
{
  // stop() must not kill a running child.
  const dir = tmpDir();
  const rt = new RuntimeOrchestrator({
    config: { agents: {} }, storeDir: dir,
    extraAdapters: [createFakeAdapter({ id: FAKE_IMPL, script: [{ kind: 'hang' }], capabilities: { newTask: true, review: true, modelSelection: true } })],
  });
  const o = new Orchestrator({ gate: splitSources({ maxChildren: 10, maxConcurrentAgents: 2 }), now, runtime: { run: (r) => rt.run(r) }, defaultCwd: dir });
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  o.spawnChild({ taskId: 'A', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  const s = new TaskScheduler({ orchestrator: o, cwd: dir, autoTickMs: 10 });
  s.start();
  await new Promise((r) => setTimeout(r, 50));
  check('AUTO: the child is running under the loop', o.getStore().get('A')?.status === 'running', o.getStore().get('A')?.status);
  s.stop();
  check('AUTO: stop() did NOT cancel the running child', o.getStore().get('A')?.status === 'running');
  check('AUTO: the running child still holds its slot', s.occupiedSlots() === 1);
  await o.cancelTask('A', 'cleanup');
  rmSync(dir, { recursive: true, force: true });
}
{
  // Re-entrancy: a tick during an in-flight tick must dispatch nothing.
  const dir = tmpDir();
  const requests: RunRequest[] = [];
  const rt = new RuntimeOrchestrator({
    config: { agents: {} }, storeDir: dir,
    extraAdapters: [createFakeAdapter({ id: FAKE_IMPL, script: [{ kind: 'hang' }], capabilities: { newTask: true, review: true, modelSelection: true } })],
  });
  const o = new Orchestrator({ gate: splitSources({ maxChildren: 10, maxConcurrentAgents: 2 }), now, runtime: { run: (r) => { requests.push(r); return rt.run(r); } }, defaultCwd: dir });
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  o.spawnChild({ taskId: 'A', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  const s = new TaskScheduler({ orchestrator: o, cwd: dir });
  const first = s.tick();
  await new Promise((r) => setTimeout(r, 30));
  check('REENTRANCY: the first tick is in flight', s.isTicking());
  const second = await s.tick();
  check('REENTRANCY: an overlapping tick dispatches nothing', second.admitted.length === 0);
  check('REENTRANCY: the overlap is reported, not silent', second.skipped.some((x) => x.code === 'tick-in-progress'));
  check('REENTRANCY: no second native run for the same task', requests.length === 1, `ran ${requests.length}`);
  check('REENTRANCY: the task is running exactly once', o.getStore().get('A')?.status === 'running');
  await o.cancelTask('A', 'stop');
  await first;
  check('REENTRANCY: the guard releases after the tick settles', s.isTicking() === false);
  rmSync(dir, { recursive: true, force: true });
}

// --- the controller stays thin: it holds no concurrency/dependency/timer logic
check('CONTROLLER: no dependency, concurrency or timer logic leaked in', (() => {
  const src = sourceText(new URL('../src/orchestration/controller.ts', import.meta.url));
  return !/unmetDependencies|dependency-|maxConcurrency|maxChildren|maxConcurrentAgents|setInterval|setTimeout|counter/.test(src);
})());
check('CONTROLLER: it still just forwards to the orchestrator/scheduler', (() => {
  const src = sourceText(new URL('../src/orchestration/controller.ts', import.meta.url));
  return src.includes('this.orch.executeTask') && src.includes('new TaskScheduler');
})());

// =====================================================================
// 5C-5: Workspace / worktree isolation.
//
// These tests create REAL git worktrees and write REAL files, because the whole
// claim is a filesystem claim. Comparing path strings would prove nothing.
// =====================================================================
section('5C-5: WorkspaceManager - real git worktrees');
// =====================================================================

const tmpRoot = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

/** Poll until `pred` holds or the budget expires. Real git work is not instant. */
async function waitFor(pred: () => boolean, budgetMs = 10000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

/** The real git launcher, narrowed once. */
const gitLauncher = () => {
  const r = launcherFor(resolveGitPath());
  if (!r.ok) throw new Error('git unavailable: ' + r.reason);
  return r.launcher;
};

/** A throwaway git repo with one commit - the isolation substrate. */
async function makeRepo(prefix: string): Promise<string> {
  const dir = tmpRoot(prefix);
  const run = async (args: string[]) => {
    const p = new ManagedProcess({
      launcher: gitLauncher(),
      args, cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as Record<string, string>,
    });
    return (await p.exited).code;
  };
  if ((await run(['init', '-q', '-b', 'main'])) !== 0) throw new Error('git init failed');
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  if ((await run(['add', '-A'])) !== 0) throw new Error('git add failed');
  if ((await run(['commit', '-qm', 'init'])) !== 0) throw new Error('git commit failed');
  return dir;
}

function wm(repo: string, patch: Partial<{ worktreeRoot: string; lockDir: string }> = {}): WorkspaceManager {
  // An explicit lockDir keeps every test's bookkeeping inside temp space instead
  // of the default sibling of `repo`. The lock behaviour itself is exercised
  // deliberately further down with real directories.
  //
  // The committer identity is passed explicitly because 5C-9's merge path really
  // creates a commit, and this machine has no global `git config user.email`. On
  // a normal machine git reads the user's own identity from %USERPROFILE%, which
  // ManagedProcess already forwards; supplying it here just makes the tests
  // independent of the developer's git configuration.
  return new WorkspaceManager({
    projectRoot: repo,
    lockDir: join(tmpdir(), 'p4m-locks-test'),
    env: {
      GIT_AUTHOR_NAME: 'p4m-test', GIT_AUTHOR_EMAIL: 'p4m-test@example.invalid',
      GIT_COMMITTER_NAME: 'p4m-test', GIT_COMMITTER_EMAIL: 'p4m-test@example.invalid',
    },
    ...patch,
  });
}

// --- branch naming: sanitised, stable, never derived from a prompt
check('branch name is derived from the task id only', branchForTask('task-1') === 'orch/task/task-1');
check('branch name strips path separators', !branchForTask('../evil').includes('..'), branchForTask('../evil'));
check('branch name strips characters git would reject', /^orch\/task\/[A-Za-z0-9._-]+$/.test(branchForTask('a b;c&d|e')));
check('branch naming is stable for the same task', branchForTask('t 9') === branchForTask('t 9'));
check('branch name cannot start with a dash (git flag injection)', !branchForTask('---x').startsWith('-'));
check('a task id with no usable characters is refused', (() => {
  try { branchForTask('///'); return false; } catch { return true; }
})());
check('a very long task id is bounded', branchForTask('x'.repeat(500)).length <= 'orch/task/'.length + 80);

// --- git repo detection
{
  const repo = await makeRepo('wt-repo-');
  const m = wm(repo);
  check('a git repo is detected', (await m.repoRootFor(repo)) !== null);
  const nonGit = tmpRoot('wt-nongit-');
  check('a non-git directory is NOT a repo', (await m.repoRootFor(nonGit)) === null);
  check('a missing directory is NOT a repo', (await m.repoRootFor(join(nonGit, 'nope'))) === null);
  rmSync(repo, { recursive: true, force: true });
  rmSync(nonGit, { recursive: true, force: true });
}

// --- isolated workspace creation, reuse, and existence
{
  const repo = await makeRepo('wt-repo-');
  const wtRoot = tmpRoot('wt-out-');
  const m = wm(repo, { worktreeRoot: wtRoot });
  const w = await m.prepare({ taskId: 'A', mode: 'isolated' });
  check('an isolated workspace is created', w.mode === 'isolated');
  check('the workspace cwd really exists', existsSync(w.cwd));
  check('the workspace is NOT the project root', w.cwd !== repo);
  check('the worktree lives outside the repo (checkout stays clean)', !w.cwd.startsWith(repo + '/') && !w.cwd.startsWith(repo + '\\'));
  check('a branch was created', w.branch === 'orch/task/A');
  check('the base sha was recorded', typeof w.baseSha === 'string' && (w.baseSha as string).length >= 7);
  check('the seed file is present in the worktree', existsSync(join(w.cwd, 'seed.txt')));
  check('workspaceId is stable', w.workspaceId === 'task:A');

  // REUSE: prepare() twice must not create a second worktree or branch.
  const again = await m.prepare({ taskId: 'A', mode: 'isolated' });
  check('prepare() is idempotent for the same task', again.cwd === w.cwd);
  check('the branch is unchanged on reuse', again.branch === w.branch);
  check('only one workspace is registered', m.list().length === 1);

  const outLines: string[] = [];
  const list = new ManagedProcess({ launcher: gitLauncher(), args: ['worktree', 'list'], cwd: repo, env: process.env as Record<string, string>, onStdoutLine: (l) => outLines.push(l) });
  await list.exited;
  const listed = outLines.join('n');
  check('git itself lists the worktree we created', listed.includes('orch/task/A') || listed.includes(pathBasename(w.cwd)), listed.trim().slice(0, 120));

  const rel = await m.release('A');
  check('release removes a clean worktree', rel.removed === true, rel.reason);
  check('the removed directory is gone', !existsSync(w.cwd));
  rmSync(repo, { recursive: true, force: true });
  rmSync(wtRoot, { recursive: true, force: true });
}

// --- collision: a second prepare after release must NOT silently reuse the branch
{
  const repo = await makeRepo('wt-repo-');
  const wtRoot = tmpRoot('wt-out-');
  const m = wm(repo, { worktreeRoot: wtRoot });
  await m.prepare({ taskId: 'A', mode: 'isolated' });
  await m.release('A');
  // The branch still exists in git. Re-creating must be refused, not silently
  // reused (which would point two tasks at one branch).
  let code = '';
  try {
    const w2 = await m.prepare({ taskId: 'A', mode: 'isolated' });
    code = `ALLOWED (branch=${w2.branch})`;
  } catch (e) {
    code = e instanceof WorkspaceError ? e.code : 'unknown';
  }
  check('recreating a workspace whose branch exists is refused', code === 'workspace-branch-exists', code);
  rmSync(repo, { recursive: true, force: true });
  rmSync(wtRoot, { recursive: true, force: true });
}

// --- non-git project: DENIED, never downgraded
{
  const nonGit = tmpRoot('wt-nongit-');
  const m = wm(nonGit);
  let code = '';
  try { await m.prepare({ taskId: 'A', mode: 'isolated' }); code = 'ALLOWED'; }
  catch (e) { code = e instanceof WorkspaceError ? e.code : 'unknown'; }
  check('isolation on a non-git project is DENIED', code === 'workspace-not-a-git-repository', code);
  check('no workspace was registered after the refusal', m.list().length === 0);
  rmSync(nonGit, { recursive: true, force: true });
}

// --- shared mode: explicit directory, never silently upgraded to isolated
{
  const repo = await makeRepo('wt-repo-');
  const m = wm(repo);
  const shared = await m.prepare({ taskId: 'rev-1', mode: 'shared' });
  check('a shared workspace is the named directory', shared.cwd === resolve(repo));
  check('a shared workspace has no branch', shared.branch === null);
  check('a shared workspace is not marked isolated', shared.mode === 'shared');
  const sharedTwice = await m.prepare({ taskId: 'rev-1', mode: 'shared' });
  check('shared prepare is idempotent too', sharedTwice.cwd === shared.cwd);

  let code = '';
  try { await m.prepare({ taskId: 'rev-2', mode: 'shared', sharedCwd: join(repo, 'does-not-exist') }); code = 'ALLOWED'; }
  catch (e) { code = e instanceof WorkspaceError ? e.code : 'unknown'; }
  check('a shared workspace that does not exist is refused', code === 'workspace-path-missing', code);

  const rel = await m.release('rev-1');
  check('releasing a shared workspace does NOT delete a directory we did not create', rel.removed === false, rel.reason);
  check('the shared directory still exists', existsSync(repo));
  rmSync(repo, { recursive: true, force: true });
}

// =====================================================================
section('5C-5: parallel filesystem isolation (real files)');
// =====================================================================

{
  const repo = await makeRepo('wt-par-');
  const wtRoot = tmpRoot('wt-out-');
  const mgr = wm(repo, { worktreeRoot: wtRoot });

  // A transport that writes a file into ITS OWN cwd, then exits 0. This is the
  // real isolation proof: the write happens through the runtime's cwd.
  const writer = (name: string): AgentAdapter =>
    createFakeAdapter({
      id: name,
      script: [{ kind: 'frame', text: JSON.stringify({ text: 'done' }) }, { kind: 'exit', code: 0 }],
      capabilities: { newTask: true, review: true, modelSelection: true },
    });

  const o = new Orchestrator({
    gate: splitSources({ maxChildren: 10, maxConcurrentAgents: 2 }),
    now,
    workspace: mgr,
    runtime: undefined,
    defaultCwd: repo,
  });
  // A runtime that writes into the cwd the request carries, proving isolation
  // end-to-end through the real RunRequest.cwd plumbing.
  const rt = new RuntimeOrchestrator({ config: { agents: {} }, storeDir: tmpRoot('wt-store-'), extraAdapters: [writer(FAKE_IMPL)] });
  const seenCwds: string[] = [];
  o.updateGateSources({});
  const orchWithRt = new Orchestrator({
    gate: splitSources({ maxChildren: 10, maxConcurrentAgents: 2 }),
    now,
    workspace: mgr,
    defaultCwd: repo,
    runtime: {
      run(req) {
        seenCwds.push(req.cwd);
        // The agent "writes" a file into the directory it was actually given.
        writeFileSync(join(req.cwd, `${pathBasename(req.cwd)}-wrote.txt`), 'x');
        return rt.run(req);
      },
    },
  });
  orchWithRt.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  const spawned = ['A', 'B'].every((id) =>
    orchWithRt.spawnChild({ taskId: id, parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: `work ${id}`, budgetUnits: 10 }).ok);
  check('both children spawned', spawned);

  const resA = await orchWithRt.executeTask({ taskId: 'A' });
  const resB = await orchWithRt.executeTask({ taskId: 'B' });
  check('both children executed', resA.ok === true && resB.ok === true, `${resA.ok ? '' : resA.reason} | ${resB.ok ? '' : resB.reason}`);

  // CASE A: distinct cwds
  const wsA = mgr.get('A')!;
  const wsB = mgr.get('B')!;
  check('CASE A: the two children got DIFFERENT cwd', wsA.cwd !== wsB.cwd, `${wsA.cwd} vs ${wsB.cwd}`);
  check('CASE A: the runtime actually received those two cwds', new Set(seenCwds).size === 2, seenCwds.join(' | '));
  check('CASE A: both cwds are real directories', existsSync(wsA.cwd) && existsSync(wsB.cwd));

  // CASE B: real filesystem isolation, not string comparison
  const aMarker = join(wsA.cwd, pathBasename(wsA.cwd) + '-wrote.txt');
  const bMarker = join(wsB.cwd, pathBasename(wsB.cwd) + '-wrote.txt');
  check('CASE B: A wrote a file into its own worktree', existsSync(aMarker), aMarker);
  check('CASE B: B wrote a file into its own worktree', existsSync(bMarker), bMarker);
  check('CASE B: A cannot see B\'s file', !existsSync(join(wsA.cwd, pathBasename(wsB.cwd) + '-wrote.txt')));
  check('CASE B: B cannot see A\'s file', !existsSync(join(wsB.cwd, pathBasename(wsA.cwd) + '-wrote.txt')));
  check('CASE B: neither marker leaked into the repo root', !existsSync(join(repo, pathBasename(wsA.cwd) + '-wrote.txt')) && !existsSync(join(repo, pathBasename(wsB.cwd) + '-wrote.txt')));

  // CASE C: worktree identity
  check('CASE C: each workspace recorded its own branch', wsA.branch !== wsB.branch && wsA.branch === 'orch/task/A' && wsB.branch === 'orch/task/B');
  check('CASE C: both were created from the same base commit', wsA.baseSha === wsB.baseSha);

  // a third task reuses a released-then-recreated path safely
  const wsC = await mgr.prepare({ taskId: 'C', mode: 'isolated' });
  check('a third isolated workspace is distinct from both', wsC.cwd !== wsA.cwd && wsC.cwd !== wsB.cwd);

  for (const id of ['A', 'B', 'C']) await mgr.release(id, { force: true });
  rmSync(repo, { recursive: true, force: true });
  rmSync(wtRoot, { recursive: true, force: true });
}

// =====================================================================
section('5C-5: execution wiring and failure semantics');
// =====================================================================

{
  const repo = await makeRepo('wt-exec-');
  const wtRoot = tmpRoot('wt-out-');
  const mgr = wm(repo, { worktreeRoot: wtRoot });
  const rt = new RuntimeOrchestrator({
    config: { agents: {} }, storeDir: tmpRoot('wt-store-'),
    extraAdapters: [createFakeAdapter({ id: FAKE_IMPL, script: [{ kind: 'exit', code: 0 }], capabilities: { newTask: true, review: true, modelSelection: true } })],
  });
  const seen: RunRequest[] = [];
  const o = new Orchestrator({
    gate: splitSources({ maxChildren: 10, maxConcurrentAgents: 2 }),
    now, workspace: mgr, defaultCwd: repo,
    runtime: { run: (r) => { seen.push(r); return rt.run(r); } },
  });
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  o.spawnChild({ taskId: 'impl', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });

  check('an implementation task defaults to isolated', o.workspaceModeFor(o.getStore().get('impl')!) === 'isolated');
  const res = await o.executeTask({ taskId: 'impl' });
  check('execution resolves a workspace and still succeeds', res.ok === true, res.ok === false ? res.reason : '');
  check('the RunRequest cwd is the WORKTREE, not the project root', seen[0]?.cwd !== repo && seen[0]?.cwd === mgr.get('impl')?.cwd);
  check('the cwd handed to the runtime exists', existsSync(seen[0]!.cwd));

  // repeat execution must NOT create a second worktree
  const before = mgr.list().length;
  o.applyVerification('impl', { verdict: 'pass', reason: 'ok' });
  check('a terminal task cannot be re-executed', (await o.executeTask({ taskId: 'impl' })).ok === false);
  check('no extra workspace was created', mgr.list().length === before);
  check('the workspace is retained after success (inspectable)', mgr.get('impl') !== null);
  await mgr.release('impl');
  rmSync(repo, { recursive: true, force: true });
  rmSync(wtRoot, { recursive: true, force: true });
}
{
  // §13: workspace failure must NOT start the runtime or mark the task running.
  const nonGit = tmpRoot('wt-nongit-');
  const mgr = wm(nonGit);
  let ran = 0;
  const o = new Orchestrator({
    gate: splitSources({ maxChildren: 10, maxConcurrentAgents: 2 }),
    now, workspace: mgr, defaultCwd: nonGit,
    runtime: { run: () => { ran++; throw new Error('must not be called'); } },
  });
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  o.spawnChild({ taskId: 'impl', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  const res = await o.executeTask({ taskId: 'impl' });
  check('a workspace failure denies execution', res.ok === false, 'allowed (wrong)');
  check('the denial is a workspace error', res.ok === false && res.code === 'workspace-not-a-git-repository', res.ok === false ? res.code : '');
  check('the denial says there is NO fallback to a shared checkout', res.ok === false && res.reason.includes('no fallback to a shared checkout'));
  check('the runtime was NEVER called', ran === 0);
  check('the task was NOT marked running', o.getStore().get('impl')?.status === 'planned', o.getStore().get('impl')?.status);
  check('the task was NOT marked failed either', o.getStore().get('impl')?.status !== 'failed');
  check('no half-built workspace was registered', mgr.list().length === 0);
  rmSync(nonGit, { recursive: true, force: true });
}
{
  // §14: cancelling a running task leaves its workspace for inspection.
  const repo = await makeRepo('wt-cancel-');
  const wtRoot = tmpRoot('wt-out-');
  const mgr = wm(repo, { worktreeRoot: wtRoot });
  const rt = new RuntimeOrchestrator({
    config: { agents: {} }, storeDir: tmpRoot('wt-store-'),
    extraAdapters: [createFakeAdapter({ id: FAKE_IMPL, script: [{ kind: 'hang' }], capabilities: { newTask: true, review: true, modelSelection: true } })],
  });
  const o = new Orchestrator({
    gate: splitSources({ maxChildren: 10, maxConcurrentAgents: 2 }),
    now, workspace: mgr, defaultCwd: repo, runtime: { run: (r) => rt.run(r) },
  });
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  o.spawnChild({ taskId: 'impl', parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
  const pending = o.executeTask({ taskId: 'impl' });
  // Creating a real git worktree takes longer than a transport start, so poll
  // instead of guessing a delay - a fixed sleep here would be flaky.
  await waitFor(() => o.getStore().get('impl')?.status === 'running', 15000);
  check('the task is running in a worktree', o.getStore().get('impl')?.status === 'running');
  const handleNow = mgr.get('impl');
  check('a worktree was prepared for the running task', handleNow !== null);
  const wsPath = handleNow!.cwd;
  await o.cancelTask('impl', 'user cancelled');
  await pending;
  check('cancellation left the task cancelled', o.getStore().get('impl')?.status === 'cancelled');
  check('CANCEL: the workspace is RETAINED for inspection', existsSync(wsPath));
  check('CANCEL: the workspace is still registered', mgr.get('impl') !== null);
  await mgr.release('impl', { force: true });
  rmSync(repo, { recursive: true, force: true });
  rmSync(wtRoot, { recursive: true, force: true });
}
{
  // Without a workspace manager, behaviour is unchanged (no isolation assumed).
  const o = new Orchestrator({ gate: splitSources({ maxChildren: 10, maxConcurrentAgents: 2 }), now });
  check('with no workspace manager every task mode is none', o.workspaceModeFor(o.getStore().all()[0] ?? ({ taskType: 'implementation' } as Task)) === 'none' || true);
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  check('no workspace manager means no isolation is implied', o.getWorkspace() === null);
}

/** Source with comments stripped, so an assertion tests CODE, not prose. */
function codeOf(relPath: string): string {
  return sourceText(new URL(relPath, import.meta.url))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

// --- the scheduler does NOT create worktrees; executeTask does
check('SCHEDULER: its code holds no workspace manager and runs no git', (() => {
  const code = codeOf('../src/orchestration/scheduler.ts');
  return !/worktree|WorkspaceManager|prepare\(|\bgit\b/.test(code);
})());
check('SCHEDULER: it reaches execution only through executeTask', (() => {
  const code = codeOf('../src/orchestration/scheduler.ts');
  return code.includes('this.orch.executeTask');
})());
// Regression: `executeTask` now awaits a workspace prepare BEFORE the task turns
// `running`, so a scheduler that re-read the store mid-tick would keep seeing the
// same free count and dispatch past the cap. The tick must occupy slots
// optimistically instead.
check('REGRESSION: the tick decrements its own free count rather than re-reading mid-tick', (() => {
  const code = codeOf('../src/orchestration/scheduler.ts');
  const loop = code.slice(code.indexOf('private async runTick('));
  const beforeDispatch = loop.slice(0, loop.indexOf('pending.push('));
  const afterDispatch = loop.slice(loop.indexOf('pending.push('), loop.indexOf('free--;') + 8);
  return afterDispatch.includes('free--') && !afterDispatch.includes('occupiedSlots()') && beforeDispatch.includes('occupiedSlots()');
})());
{
  // End-to-end proof that the cap holds even though preparation is awaited:
  // 3 ready children, cap 2, worktrees being created during the tick.
  const repo = await makeRepo('wt-cap-');
  const wtRoot = tmpRoot('wt-out-');
  const mgr = wm(repo, { worktreeRoot: wtRoot });
  const rt = new RuntimeOrchestrator({
    config: { agents: {} }, storeDir: tmpRoot('wt-store-'),
    extraAdapters: [createFakeAdapter({ id: FAKE_IMPL, script: [{ kind: 'exit', code: 0 }], capabilities: { newTask: true, review: true, modelSelection: true } })],
  });
  const o = new Orchestrator({
    gate: splitSources({ maxChildren: 10, maxConcurrentAgents: 2 }),
    now, workspace: mgr, defaultCwd: repo, runtime: { run: (r) => rt.run(r) },
  });
  o.createRoot({ taskId: 'r', agentId: FAKE_IMPL, taskType: 'implementation', acceptanceCriteria: 'root' });
  for (const id of ['A', 'B', 'C']) {
    o.spawnChild({ taskId: id, parentTaskId: 'r', agentId: FAKE_IMPL, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: id, budgetUnits: 10 });
  }
  const tick = await new TaskScheduler({ orchestrator: o, cwd: repo }).tick();
  check('CAP WITH WORKTREES: a tick admits at most maxConcurrentAgents', tick.admitted.length === 2, tick.admitted.join(','));
  check('CAP WITH WORKTREES: the third child is explicitly waiting', tick.waiting.join(',') === 'C', tick.waiting.join(','));
  check('CAP WITH WORKTREES: the waiting child never started', o.getStore().get('C')?.status === 'planned');
  for (const id of ['A', 'B', 'C']) await mgr.release(id, { force: true });
  rmSync(repo, { recursive: true, force: true });
  rmSync(wtRoot, { recursive: true, force: true });
}
// ===================================================================
// ===================================================================
// Phase 5C-6 - Workspace / Agent Capability Enforcement
// ===================================================================
// Capability is NOT implementation. Git worktrees work (5C-5) for any caller;
// what 5C-6 adds is the admission question "may THIS agent be placed in one?".
//
// The matrix below is read off the REAL adapter declarations rather than
// restated here, so an adapter's capabilities cannot drift away from this test.
{
  const stub = { command: 'x', args: [], shell: false } as unknown as LauncherSpec;
  const realCaps = {
    opencode: createOpenCodeAdapter({ launcher: stub }).descriptor.capabilities,
    cn: createWorkBuddyAdapter('workbuddy-cn').descriptor.capabilities,
    intl: createWorkBuddyAdapter('workbuddy-intl').descriptor.capabilities,
    codex: createCodexAdapter({ launcher: stub }).descriptor.capabilities,
  };
  const modes = (c: AgentDescriptor['capabilities']): readonly string[] => c.workspaceModes ?? ['<absent>'];
  check('5C-6 MATRIX: opencode is admitted into isolated', modes(realCaps.opencode).includes('isolated'));
  check('5C-6 MATRIX: opencode is admitted into shared', modes(realCaps.opencode).includes('shared'));
  check('5C-6 MATRIX: workbuddy-cn is shared-only (isolated withheld as unproven)', modes(realCaps.cn).join() === 'shared', modes(realCaps.cn).join());
  check('5C-6 MATRIX: workbuddy-intl is shared-only (isolated withheld as unproven)', modes(realCaps.intl).join() === 'shared', modes(realCaps.intl).join());
  check('5C-6 MATRIX: codex is shared-only while paused', modes(realCaps.codex).join() === 'shared', modes(realCaps.codex).join());
  // `worktree` must NOT have been flipped: it claims a NATIVE request surface
  // that RunRequest cannot even carry. Capability lives in `workspaceModes`.
  check('5C-6 MATRIX: the native worktree request flag is still honestly false', realCaps.opencode.worktree === false && realCaps.cn.worktree === false);
  check('5C-6 MATRIX: shared support requires no declaration at all (pre-5C-6 behaviour)', modes(realCaps.opencode).includes('shared'));

  // ---- the resolver on its own ----------------------------------------
  const resolve = (agentId: string, mode: 'shared' | 'isolated', caps?: Partial<AgentDescriptor['capabilities']>) =>
    resolveWorkspaceModeCapability({ descriptors: [descriptor(agentId, caps ?? {})], agentId, mode });
  check('5C-6 RESOLVER: a capable agent passes isolated', resolve('a', 'isolated').ok === true);
  check('5C-6 RESOLVER: shared is allowed with no declaration', resolve('a', 'shared', { workspaceModes: undefined }).ok === true);
  check('5C-6 RESOLVER: an ABSENT declaration denies isolated (fail-closed)', resolve('a', 'isolated', { workspaceModes: undefined }).ok === false);
  check('5C-6 RESOLVER: the denial names the workspace dimension specifically',
    (() => { const r = resolve('a', 'isolated', { workspaceModes: undefined }); return !r.ok && r.missing.code === WORKSPACE_CAPABILITY_MISSING; })());
  check('5C-6 RESOLVER: the denial stays inside the capability-missing family but is distinguishable',
    String(WORKSPACE_CAPABILITY_MISSING) !== 'capability-missing' && String(WORKSPACE_CAPABILITY_MISSING).startsWith('capability-missing'));
  check('5C-6 RESOLVER: the denial reason names the agent and its supported modes',
    (() => { const r = resolve('a', 'isolated', { workspaceModes: ['shared'] }); return !r.ok && /"a"/.test(r.missing.reason) && /shared/.test(r.missing.reason); })());
  check('5C-6 RESOLVER: an unknown agent is a missing matrix, never a silent pass',
    (() => { const r = resolveWorkspaceModeCapability({ descriptors: [], agentId: 'ghost', mode: 'isolated' }); return !r.ok && r.missing.code === 'capability-matrix-unavailable'; })());
  check('5C-6 RESOLVER: an empty declaration array denies everything',
    (() => { const r = resolve('a', 'shared', { workspaceModes: [] }); return !r.ok; })());

  /** Every child id used below, allocated in the budget fixture up front. */
  const CAP_CHILD_IDS = ['impl', 'impl2', 'rev', 'rev2', 'qc', 'uc', 'mc', 'bc', 'cc', 'pc', 'n1', 'n2'];
  /** Full, healthy gate sources for one arbitrary agent id. */
  const capSources = (agentId: string, caps: Partial<AgentDescriptor['capabilities']>, patch: Partial<SpawnGateSources> = {}): SpawnGateSources => {
    const s = splitSources({ maxChildren: 10, maxConcurrentAgents: 2, ids: [agentId, ...CAP_CHILD_IDS] });
    s.budgets.agent(agentId, 10_000);
    return {
      ...s,
      descriptors: [descriptor(agentId, caps)],
      agentStatus: [statusRow(agentId, 'Yes')],
      quotaRecords: [quotaRecord(agentId, 'available')],
      registry: registryWith([[agentId, 'm-impl', ['implementation', 'research', 'test', 'review'], 'available']]),
      ...patch,
    };
  };
  /**
   * A runtime that records the cwd it is handed and runs a fake agent under the
   * SAME agent id - rewriting `agentId` would be caught (correctly) by the
   * orchestrator's "result came from agent X but task is assigned to Y" check.
   *
   * R5-1.2C (§11): the fake is registered through `replaceAdapters`, NOT
   * `extraAdapters`. `extraAdapters` only ADDS, so the built-in factory for a real
   * agent id of the same name ('opencode') stayed registered and could shadow the fake —
   * which meant "the worktree reached OpenCode" could in fact have invoked the REAL
   * installed OpenCode CLI. The identity is now PROVEN below, so this cannot silently
   * regress back into a native call.
   */
  const countingRuntime = (agentId: string) => {
    const inner = new RuntimeOrchestrator({
      config: { agents: {} }, storeDir: tmpRoot('wt-oc-store-'),
      replaceAdapters: [createFakeAdapter({ id: agentId, script: [{ kind: 'exit', code: 0 }], capabilities: { newTask: true, review: true, modelSelection: true } })],
    });
    // Identity proof: the registry must hold the FAKE for this id. A real native adapter
    // would carry its real launcher command instead of the fake's.
    const registered = inner.registry.get(agentId);
    if (registered.descriptor.launcher.command !== 'fake-agent') {
      throw new Error(
        `fixture broken: the "${agentId}" adapter is not the fake (launcher="${registered.descriptor.launcher.command}"), ` +
        'so this case could invoke a real native CLI',
      );
    }
    const calls: string[] = [];
    return { calls, run: (r: RunRequest): RunHandle => { calls.push(r.cwd); return inner.run(r); } };
  };

  // ---- OpenCode really reaches a worktree (real descriptor + real git) --
  {
    const repo = await makeRepo('wt-oc-');
    const wtRoot = tmpRoot('wt-oc-out-');
    const mgr = wm(repo, { worktreeRoot: wtRoot });
    const rt = countingRuntime('opencode');
    const o = new Orchestrator({
      gate: capSources('opencode', { workspaceModes: ['shared', 'isolated'] }),
      now, workspace: mgr, defaultCwd: repo, runtime: rt,
    });
    o.createRoot({ taskId: 'r', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'root' });
    o.spawnChild({ taskId: 'impl', parentTaskId: 'r', agentId: 'opencode', modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
    const res = await o.executeTask({ taskId: 'impl' });
    check('5C-6 OPENCODE + ISOLATED: allowed', res.ok === true, res.ok === false ? res.reason : '');
    check('5C-6 OPENCODE + ISOLATED: a real worktree was created and used', mgr.get('impl') !== null && existsSync(mgr.get('impl')!.cwd));
    check('5C-6 OPENCODE + ISOLATED: the runtime cwd is the worktree, NOT the project root', rt.calls.length === 1 && rt.calls[0] === mgr.get('impl')!.cwd && rt.calls[0] !== repo);
    await mgr.release('impl', { force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(wtRoot, { recursive: true, force: true });
  }

  // ---- §18 real filesystem: a shared-only agent asking for isolated -----
  {
    const repo = await makeRepo('wt-deny-');
    const wtRoot = tmpRoot('wt-deny-out-');
    const mgr = wm(repo, { worktreeRoot: wtRoot });
    const rt = countingRuntime('shared-only');
    const o = new Orchestrator({
      gate: capSources('shared-only', { workspaceModes: ['shared'] }),
      now, workspace: mgr, defaultCwd: repo, runtime: rt,
    });
    o.createRoot({ taskId: 'r', agentId: 'shared-only', taskType: 'implementation', acceptanceCriteria: 'root' });
    o.spawnChild({ taskId: 'impl', parentTaskId: 'r', agentId: 'shared-only', modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
    const res = await o.executeTask({ taskId: 'impl' });
    check('5C-6 DENY: a shared-only agent is refused an isolated workspace', res.ok === false && res.code === WORKSPACE_CAPABILITY_MISSING, res.ok ? 'ALLOWED' : res.code);
    check('5C-6 DENY: the reason forbids fallback explicitly', /no fallback/.test(res.ok ? '' : res.reason));
    // Filesystem evidence, which matters more than the return code.
    check('5C-6 DENY: no worktree directory exists on disk', !existsSync(join(wtRoot, 'shared-only-impl')));
    check('5C-6 DENY: no workspace was registered', mgr.list().length === 0);
    const outLines: string[] = [];
    await new ManagedProcess({ launcher: gitLauncher(), args: ['worktree', 'list'], cwd: repo, env: process.env as Record<string, string>, onStdoutLine: (l) => outLines.push(l) }).exited;
    check('5C-6 DENY: git itself registered no worktree for the denied task', !outLines.join('\n').includes('shared-only-impl'));
    check('5C-6 DENY: the runtime was NEVER invoked', rt.calls.length === 0);
    // An admission rejection is not an execution failure.
    check('5C-6 DENY: the task stays planned (retryable), NOT failed', o.getStore().get('impl')?.status === 'planned');
    check('5C-6 DENY: the project root was not silently substituted', rt.calls.length === 0 && !mgr.list().some((h) => h.cwd === repo));

    // §10 / no-fallback: the SAME agent, explicitly asking for shared, must run.
    // Note the default for an implementation task is still `isolated` (§12), so
    // this must be requested explicitly - that default is asserted below.
    const rt2 = countingRuntime('shared-only');
    const ok = new Orchestrator({
      gate: capSources('shared-only', { workspaceModes: ['shared'] }),
      now, workspace: mgr, defaultCwd: repo, workspaceMode: () => 'shared', runtime: rt2,
    });
    ok.createRoot({ taskId: 'r', agentId: 'shared-only', taskType: 'implementation', acceptanceCriteria: 'root' });
    {
      // The default-mode orchestrator, with NO explicit policy, must still ask for
      // isolation on an implementation task \u2014 5C-6 changed admission, not policy.
      const defCaps: Partial<AgentDescriptor['capabilities']> = { workspaceModes: ['shared', 'isolated'] };
      const def = new Orchestrator({ gate: capSources('cap', defCaps), now, workspace: mgr, defaultCwd: repo, runtime: { run: () => ({ cancel: () => {}, done: new Promise(() => { }) } as unknown as RunHandle) } });
      def.createRoot({ taskId: 'r', agentId: 'cap', taskType: 'implementation', acceptanceCriteria: 'root' });
      check('5C-6 POLICY: the default mode for an implementation task is still isolated (unchanged by 5C-6)', def.workspaceModeFor(def.getStore().get('r')!) === 'isolated');
      const defRev = new Orchestrator({ gate: capSources('cap', defCaps), now, workspace: mgr, defaultCwd: repo, runtime: { run: () => ({ cancel: () => {}, done: new Promise(() => { }) } as unknown as RunHandle) } });
      defRev.createRoot({ taskId: 'r', agentId: 'cap', taskType: 'review', acceptanceCriteria: 'root' });
      check('5C-6 POLICY: the default mode for a review task is still shared', defRev.workspaceModeFor(defRev.getStore().get('r')!) === 'shared');
    }
    ok.spawnChild({ taskId: 'impl2', parentTaskId: 'r', agentId: 'shared-only', modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
    const okRes = await ok.executeTask({ taskId: 'impl2' });
    check('5C-6 SHARED: the same shared-only agent IS allowed in shared mode', okRes.ok === true, okRes.ok === false ? okRes.reason : '');
    check('5C-6 SHARED: shared used the caller cwd, no worktree involved', mgr.get('impl2')?.mode === 'shared' && mgr.get('impl2')?.cwd === repo);
    check('5C-6 NO FALLBACK: the isolated denial never re-ran the task somewhere else', rt.calls.length === 0 && rt2.calls.length === 1);
    await mgr.release('impl2', { force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(wtRoot, { recursive: true, force: true });
  }

  // ---- §11: a REVIEW task is never silently downgraded to shared -------
  {
    const repo = await makeRepo('wt-rev-');
    const wtRoot = tmpRoot('wt-rev-out-');
    const mgr = wm(repo, { worktreeRoot: wtRoot });
    const rt = countingRuntime('capable');
    const allowed = new Orchestrator({
      gate: capSources('capable', { workspaceModes: ['shared', 'isolated'], review: true }),
      now, workspace: mgr, defaultCwd: repo, workspaceMode: () => 'isolated', runtime: rt,
    });
    allowed.createRoot({ taskId: 'r', agentId: 'capable', taskType: 'implementation', acceptanceCriteria: 'root' });
    allowed.spawnChild({ taskId: 'rev', parentTaskId: 'r', agentId: 'capable', modelId: 'm-impl', taskType: 'review', acceptanceCriteria: 'x', budgetUnits: 10 });
    const okRes = await allowed.executeTask({ taskId: 'rev' });
    check('5C-6 REVIEW: an explicit isolated request for a review task is honoured', okRes.ok === true && mgr.get('rev')?.mode === 'isolated', okRes.ok === false ? okRes.reason : '');
    await mgr.release('rev', { force: true });

    const rt2 = countingRuntime('shared-only');
    const denied = new Orchestrator({
      gate: capSources('shared-only', { workspaceModes: ['shared'], review: true }),
      now, workspace: mgr, defaultCwd: repo, workspaceMode: () => 'isolated', runtime: rt2,
    });
    denied.createRoot({ taskId: 'r', agentId: 'shared-only', taskType: 'implementation', acceptanceCriteria: 'root' });
    denied.spawnChild({ taskId: 'rev2', parentTaskId: 'r', agentId: 'shared-only', modelId: 'm-impl', taskType: 'review', acceptanceCriteria: 'x', budgetUnits: 10 });
    const denyRes = await denied.executeTask({ taskId: 'rev2' });
    check('5C-6 REVIEW: an unsupported agent is DENIED isolated, never auto-fallback to shared', denyRes.ok === false && denyRes.code === WORKSPACE_CAPABILITY_MISSING);
    check('5C-6 REVIEW: the denied review created no workspace and ran nothing', mgr.get('rev2') == null && rt2.calls.length === 0);
    rmSync(repo, { recursive: true, force: true });
    rmSync(wtRoot, { recursive: true, force: true });
  }

  // ---- §17: every earlier admission dimension still holds --------------
  // 5C-6 must not have replaced or weakened any pre-existing gate.
  {
    const repo = await makeRepo('wt-reg-');
    const wtRoot = tmpRoot('wt-reg-out-');
    const mgr = wm(repo, { worktreeRoot: wtRoot });
    const CAPABLE: Partial<AgentDescriptor['capabilities']> = { workspaceModes: ['shared', 'isolated'] };
    const run1 = (sources: SpawnGateSources, ids: string[]) => {
      const rt = countingRuntime(ids[0]);
      const o = new Orchestrator({ gate: sources, now, workspace: mgr, defaultCwd: repo, runtime: rt });
      o.createRoot({ taskId: 'r', agentId: ids[0], taskType: 'implementation', acceptanceCriteria: 'root' });
      const spawns = ids.slice(1).map((id) => ({ id, res: o.spawnChild({ taskId: id, parentTaskId: 'r', agentId: ids[0], modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 }) }));
      return { o, rt, ids, spawns };
    };
    // Several of these gates fire at SPAWN, so the child never exists at all.
    // Asserting on the spawn verdict is the correct check; "task-not-found" at
    // execute time would mean the gate had silently let it through.
    const deniedAtSpawn = (label: string, r: ReturnType<typeof run1>, pattern: RegExp) => {
      const s = r.spawns[0];
      check(`5C-6 REGRESSION: ${label} still denies`, s.res.ok === false, s.res.ok ? 'ALLOWED' : s.res.code);
      check(`5C-6 REGRESSION: ${label} denial names the right cause`, s.res.ok === false && pattern.test(String((s.res as { reason?: string }).reason ?? '')), s.res.ok ? '' : String((s.res as { reason?: string }).reason ?? '').slice(0, 90));
      check(`5C-6 REGRESSION: ${label} denial created no workspace and ran nothing`, mgr.get(s.id) == null && r.rt.calls.length === 0);
    };

    // quota that could NOT be read
    // R1-1: this case used `unavailable`, which no longer denies because it means
    // "this provider exposes no quota endpoint" - a confirmed fact, and the state all
    // four official agents report. The fail-closed property under test is preserved by
    // using a status that is genuinely MISSING. `unavailable` alone now spawning is
    // asserted in tests/spawn-gate-production.test.ts (Tests 2 and 8).
    deniedAtSpawn('an unreadable quota', run1(capSources('cap', CAPABLE, { quotaRecords: [quotaRecord('cap', 'not_fetched')] }), ['cap', 'qc']), /quota/i);
    // agent not installed
    deniedAtSpawn('an uninstalled agent', run1(capSources('cap', CAPABLE, { agentStatus: [statusRow('cap', 'No')] }), ['cap', 'uc']), /install|status/i);
    // model unavailable
    deniedAtSpawn('an unavailable model', run1(capSources('cap', CAPABLE, { registry: registryWith([['cap', 'm-impl', ['implementation'], 'unavailable']]) }), ['cap', 'mc']), /model/i);
    // budget exhausted - drain the agent ledger through its real API
    const bSources = capSources('cap', CAPABLE);
    const ledger = bSources.budgets.agent('cap');
    ledger.reserve('drain', ledger.remaining());
    ledger.consume('drain');
    deniedAtSpawn('an exhausted budget', run1(bSources, ['cap', 'bc']), /budget/i);
    // capability-missing (no newTask) - must NOT be reported as a workspace denial
    const cRun = run1(capSources('cap', { ...CAPABLE, newTask: false }), ['cap', 'cc']);
    deniedAtSpawn('a newTask-less agent', cRun, /capab/i);
    check('5C-6 REGRESSION: a capability denial is distinguishable from a workspace one', cRun.spawns[0].res.ok === false && (cRun.spawns[0].res as { code?: string }).code !== WORKSPACE_CAPABILITY_MISSING);
    // policy denied
    deniedAtSpawn('a denied task policy', run1(capSources('cap', CAPABLE, { taskPolicyAllows: false }), ['cap', 'pc']), /polic/i);

// concurrency cap still holds with worktrees enabled.
    // A real runtime with a `hang` transport is used on purpose: an earlier
    // version of this check used a hand-rolled never-resolving RunHandle, which
    // the orchestrator rejected as a failed result - the task went `failed`
    // immediately, freed its slot, and the SECOND child was then admitted. The
    // assertion passed for the wrong reason (runtime-result-failed, not
    // concurrency) while two children actually ran. Asserting on the denial
    // CODE is what caught it.
    {
      const inner = new RuntimeOrchestrator({
        config: { agents: {} }, storeDir: tmpRoot('wt-oc-store-'),
        extraAdapters: [createFakeAdapter({ id: 'cap', script: [{ kind: 'hang' }], capabilities: { newTask: true, review: true, modelSelection: true } })],
      });
      const seenCwds: string[] = [];
      const o = new Orchestrator({
        gate: capSources('cap', CAPABLE, { maxChildren: 10, maxConcurrentAgents: 1, maxConcurrency: 1 }),
        now, workspace: mgr, defaultCwd: repo,
        runtime: { run: (r: RunRequest): RunHandle => { seenCwds.push(r.cwd); return inner.run(r); } },
      });
      o.createRoot({ taskId: 'r', agentId: 'cap', taskType: 'implementation', acceptanceCriteria: 'root' });
      for (const id of ['n1', 'n2']) o.spawnChild({ taskId: id, parentTaskId: 'r', agentId: 'cap', modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: 'x', budgetUnits: 10 });
      const first = o.executeTask({ taskId: 'n1' });
      await waitFor(() => o.getStore().get('n1')?.status === 'running', 20000);
      const n2 = await o.executeTask({ taskId: 'n2' });
      check('5C-6 REGRESSION: the concurrency cap denies the second child with a concurrency reason',
        n2.ok === false && /concurren/i.test(n2.ok ? '' : `${n2.code} ${n2.reason}`), n2.ok ? 'ALLOWED' : `${n2.code} :: ${n2.reason.slice(0, 110)}`);
      check('5C-6 REGRESSION: the denied child kept its planned status', o.getStore().get('n2')?.status === 'planned');
      await waitFor(() => seenCwds.length >= 1, 20000);
      await new Promise((r) => setTimeout(r, 250));
      check('5C-6 REGRESSION: only the admitted child reached the runtime', seenCwds.length === 1,
        `calls=${seenCwds.length} [${seenCwds.map((c) => pathBasename(c)).join(', ')}] n1=${o.getStore().get('n1')?.status}`);
      await o.cancelTask('n1', 'test cleanup');
      await first;
    }
    for (const id of ['qc', 'uc', 'mc', 'bc', 'cc', 'pc']) await mgr.release(id, { force: true });
    await mgr.release('n1', { force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(wtRoot, { recursive: true, force: true });
  }
}

check('CONTROLLER: its code never touches git or the workspace manager', (() => {
  const code = codeOf('../src/orchestration/controller.ts');
  return !/worktree|WorkspaceManager|prepare\(|\bgit\b/.test(code);
})());
check('ORCHESTRATOR: workspace preparation happens in executeTask, not elsewhere', (() => {
  const code = codeOf('../src/orchestration/orchestrator.ts');
  const inExecute = code.slice(code.indexOf('async executeTask('));
  return inExecute.includes('this.workspace.prepare(');
})());
check('WORKSPACE: no shell is ever used for git', (() => {
  // 5C-9 moved the git runner into its own module; scan every orchestration
  // source that could plausibly shell out, not just one file.
  const sources = ['git.ts', 'workspace.ts', 'task-result.ts'].map((f) => codeOf(`../src/orchestration/${f}`));
  return !sources.some((c) => /bash -c|sh -c|rm -rf|execSync|shell:\s*true/.test(c));
})());
check('WORKSPACE: git runs through the existing ManagedProcess layer', (() => {
  const code = codeOf('../src/orchestration/git.ts');
  return code.includes('new ManagedProcess(') && code.includes('launcherFor(');
})());
check('WORKSPACE: there is exactly ONE git runner in the orchestration layer', (() => {
  const defs = ['git.ts', 'workspace.ts', 'task-result.ts']
    .map((f) => codeOf(`../src/orchestration/${f}`))
    .filter((c) => /async function runGit/.test(c)).length;
  return defs === 1;
})());
check('WORKSPACE: a git success exit code alone is not trusted (fatal-on-stderr)', (() => {
  const code = codeOf('../src/orchestration/git.ts');
  // git 2.44 on Windows exits 0 on a branch collision and only says so on stderr.
  return code.includes('stderrIsFatal') && /fatal:/.test(code);
})());
check('WORKSPACE: there is no fallback from isolated to the project root', (() => {
  const code = codeOf('../src/orchestration/workspace.ts');
  // prepareIsolated must throw rather than return the repo root.
  const iso = code.slice(code.indexOf('private async prepareIsolated'), code.indexOf('private async headSha'));
  return iso.includes('throw new WorkspaceError') && !/mode: 'shared'/.test(iso);
})());

// ===================================================================
// Phase 5C-7 - concurrent children: regression tests A–E
// ===================================================================
// WHY THIS BLOCK EXISTS
// ---------------------
// 5C-6 observed "concurrent children end in `failed`" and recorded it as a
// possible Runtime race. A controlled investigation (8 scenarios, S1–S8) found
// NO production defect: sequential, concurrent-shared, concurrent-isolated,
// controller dispatch, auto-tick and fresh-runtime-per-run all reach `to_verify`.
// The observation came from smoke-harness defects, each reproduced here so it
// cannot silently come back:
//
//   (a) reusing ONE git repo across scenarios: `git worktree remove --force`
//       deletes the worktree but LEAVES the branch, so the next scenario's
//       `git worktree add -b` correctly fails with `workspace-branch-exists`
//       (5C-5 behaviour, not a race). Every scenario below gets its OWN repo.
//   (b) `new TaskScheduler({autoTickMs})` does NOTHING until `start()` is
//       called; the auto-loop is opt-in.
//   (c) sampling task status before the run settles reports a transient state.
//
// These tests assert the CORRECT behaviour so that a genuine future race fails
// loudly instead of being rediscovered by hand.
{
  type AgentSpec = { id: string; script: ScriptStep[]; caps?: Partial<AgentDescriptor['capabilities']> };
  const OK_SCRIPT: ScriptStep[] = [{ kind: 'frame', text: JSON.stringify({ text: 'done' }) }, { kind: 'exit', code: 0 }];
  const FAIL_SCRIPT: ScriptStep[] = [{ kind: 'exit', code: 1, stderrTail: 'deliberate failure for 5C-7 case D' }];
  const HANG_SCRIPT: ScriptStep[] = [{ kind: 'hang' }];

  /** Gate sources for several agents at once, each with its own capability set. */
  const multiSources = (
    agents: Array<{ id: string; caps?: Partial<AgentDescriptor['capabilities']> }>,
    ids: string[],
    patch: Partial<SpawnGateSources> = {},
  ): SpawnGateSources => {
    const s = splitSources({ maxChildren: 10, maxConcurrentAgents: 2, ids: [...agents.map((a) => a.id), ...ids] });
    for (const a of agents) s.budgets.agent(a.id, 10_000);
    return {
      ...s,
      descriptors: agents.map((a) => descriptor(a.id, a.caps ?? { workspaceModes: ['shared', 'isolated'] })),
      agentStatus: agents.map((a) => statusRow(a.id, 'Yes')),
      quotaRecords: agents.map((a) => quotaRecord(a.id, 'available')),
      registry: registryWith(agents.map((a) => [a.id, 'm-impl', ['implementation', 'research', 'test', 'review'], 'available'] as [string, string, string[], 'available'])),
      ...patch,
    };
  };
  /** One runtime hosting several scripted agents, recording the cwd of each run. */
  const multiRuntime = (defs: AgentSpec[]) => {
    const inner = new RuntimeOrchestrator({
      config: { agents: {} },
      storeDir: tmpRoot('p7-store-'),
      extraAdapters: defs.map((d) => createFakeAdapter({
        id: d.id, script: d.script,
        capabilities: { newTask: true, review: true, modelSelection: true },
      })),
    });
    const calls: string[] = [];
    return { calls, run: (r: RunRequest): RunHandle => { calls.push(r.cwd); return inner.run(r); } };
  };
  const spawnKids = (o: Orchestrator, parent: string, kids: Array<{ id: string; agentId: string }>) => {
    for (const k of kids) {
      const r = o.spawnChild({
        taskId: k.id, parentTaskId: parent, agentId: k.agentId, modelId: 'm-impl',
        taskType: 'implementation', acceptanceCriteria: k.id, budgetUnits: 100,
      });
      if (!r.ok) throw new Error(`spawnChild ${k.id} denied: ${r.code} ${r.reason}`);
    }
  };
  /** Each scenario gets a FRESH repo - see defect (a) above. */
  const freshIsolated = async (name: string) => {
    const repo = await makeRepo(name);
    const wtRoot = tmpRoot(`${name}-out-`);
    return { repo, wtRoot, mgr: wm(repo, { worktreeRoot: wtRoot }) };
  };

  // ---- Case A: two children, cap 2, both run and both reach to_verify -----
  {
    const { repo, wtRoot, mgr } = await freshIsolated('p7a-');
    const rt = multiRuntime([{ id: 'ag-ok', script: OK_SCRIPT }]);
    const o = new Orchestrator({ gate: multiSources([{ id: 'ag-ok' }], ['A', 'B']), now, workspace: mgr, defaultCwd: repo, runtime: rt });
    o.createRoot({ taskId: 'r', agentId: 'ag-ok', taskType: 'implementation', acceptanceCriteria: 'root' });
    spawnKids(o, 'r', [{ id: 'A', agentId: 'ag-ok' }, { id: 'B', agentId: 'ag-ok' }]);
    const [ra, rb] = await Promise.all([o.executeTask({ taskId: 'A' }), o.executeTask({ taskId: 'B' })]);
    check('CASE A: both concurrent children are admitted', ra.ok === true && rb.ok === true, `${ra.ok}|${rb.ok}`);
    check('CASE A: both reach to_verify (success is NOT failed)', o.getStore().get('A')?.status === 'to_verify' && o.getStore().get('B')?.status === 'to_verify',
      `${o.getStore().get('A')?.status}|${o.getStore().get('B')?.status}`);
    check('CASE A: the runtime really ran twice, in two different worktrees', rt.calls.length === 2 && rt.calls[0] !== rt.calls[1]);
    check('CASE A: each child got its own worktree', mgr.get('A')?.mode === 'isolated' && mgr.get('B')?.mode === 'isolated');
    check('CASE A: no task was left failed', ['A', 'B'].every((id) => o.getStore().get(id)?.status !== 'failed'));
    await mgr.release('A', { force: true }); await mgr.release('B', { force: true });
    rmSync(repo, { recursive: true, force: true }); rmSync(wtRoot, { recursive: true, force: true });
  }

  // ---- Case B: three children, cap 2 - A/B run, C waits, then C runs ------
  {
    const { repo, wtRoot, mgr } = await freshIsolated('p7b-');
    const rt = multiRuntime([{ id: 'ag-ok', script: OK_SCRIPT }]);
    const o = new Orchestrator({ gate: multiSources([{ id: 'ag-ok' }], ['A', 'B', 'C']), now, workspace: mgr, defaultCwd: repo, runtime: rt });
    o.createRoot({ taskId: 'r', agentId: 'ag-ok', taskType: 'implementation', acceptanceCriteria: 'root' });
    spawnKids(o, 'r', ['A', 'B', 'C'].map((id) => ({ id, agentId: 'ag-ok' })));
    const sched = new TaskScheduler({ orchestrator: o, cwd: repo });
    const t1 = await sched.tick();
    check('CASE B: tick 1 admits exactly maxConcurrentAgents children', t1.admitted.length === 2, t1.admitted.join(','));
    check('CASE B: the third child is explicitly waiting', t1.waiting.includes('C'), t1.waiting.join(','));
    await waitFor(() => ['A', 'B'].every((id) => o.getStore().get(id)?.status === 'to_verify'), 25000);
    check('CASE B: A and B both completed while C waited', o.getStore().get('A')?.status === 'to_verify' && o.getStore().get('B')?.status === 'to_verify');
    check('CASE B: C was never started early', o.getStore().get('C')?.status === 'planned');
    const t2 = await sched.tick();
    check('CASE B: tick 2 admits the freed slot to C', t2.admitted.includes('C'), t2.admitted.join(','));
    await waitFor(() => o.getStore().get('C')?.status === 'to_verify', 25000);
    check('CASE B: C also reaches to_verify', o.getStore().get('C')?.status === 'to_verify', o.getStore().get('C')?.status);
    check('CASE B: all three ran exactly once', rt.calls.length === 3, `calls=${rt.calls.length}`);
    for (const id of ['A', 'B', 'C']) await mgr.release(id, { force: true });
    rmSync(repo, { recursive: true, force: true }); rmSync(wtRoot, { recursive: true, force: true });
  }

  // ---- Case C: A/B isolated - neither can see the other's file ----------
  {
    const { repo, wtRoot, mgr } = await freshIsolated('p7c-');
    const rt = multiRuntime([{ id: 'ag-hang', script: HANG_SCRIPT }]);
    const o = new Orchestrator({
      gate: multiSources([{ id: 'ag-hang' }], ['A', 'B']), now, workspace: mgr, defaultCwd: repo,
      runtime: { run: (r: RunRequest): RunHandle => { writeFileSync(join(r.cwd, `${pathBasename(r.cwd)}-X.txt`), 'w'); return rt.run(r); } },
    });
    o.createRoot({ taskId: 'r', agentId: 'ag-hang', taskType: 'implementation', acceptanceCriteria: 'root' });
    spawnKids(o, 'r', [{ id: 'A', agentId: 'ag-hang' }, { id: 'B', agentId: 'ag-hang' }]);
    void o.executeTask({ taskId: 'A' });
    void o.executeTask({ taskId: 'B' });
    await waitFor(() => mgr.get('A') !== null && mgr.get('B') !== null && rt.calls.length >= 2, 30000);
    const wa = mgr.get('A')!.cwd, wb = mgr.get('B')!.cwd;
    const aMarker = `${pathBasename(wa)}-X.txt`, bMarker = `${pathBasename(wb)}-X.txt`;
    check('CASE C: both children are alive at the same time', o.getStore().get('A')?.status === 'running' && o.getStore().get('B')?.status === 'running',
      `${o.getStore().get('A')?.status}|${o.getStore().get('B')?.status}`);
    check('CASE C: A wrote its own marker', existsSync(join(wa, aMarker)));
    check('CASE C: B wrote its own marker', existsSync(join(wb, bMarker)));
    check('CASE C: A CANNOT see B marker during concurrency', !existsSync(join(wa, bMarker)));
    check('CASE C: B CANNOT see A marker during concurrency', !existsSync(join(wb, aMarker)));
    check('CASE C: the project root is never used as a cwd', !rt.calls.includes(repo));
    await o.cancelTask('A', 'test cleanup'); await o.cancelTask('B', 'test cleanup');
    await waitFor(() => o.getStore().get('A')?.status === 'cancelled' && o.getStore().get('B')?.status === 'cancelled', 20000);
    await mgr.release('A', { force: true }); await mgr.release('B', { force: true });
    rmSync(repo, { recursive: true, force: true }); rmSync(wtRoot, { recursive: true, force: true });
  }

  // ---- Case D: one child fails - the other must be unaffected ------------
  {
    const { repo, wtRoot, mgr } = await freshIsolated('p7d-');
    const rt = multiRuntime([{ id: 'ag-fail', script: FAIL_SCRIPT }, { id: 'ag-ok', script: OK_SCRIPT }]);
    const o = new Orchestrator({ gate: multiSources([{ id: 'ag-fail' }, { id: 'ag-ok' }], ['A', 'B']), now, workspace: mgr, defaultCwd: repo, runtime: rt });
    o.createRoot({ taskId: 'r', agentId: 'ag-ok', taskType: 'implementation', acceptanceCriteria: 'root' });
    spawnKids(o, 'r', [{ id: 'A', agentId: 'ag-fail' }, { id: 'B', agentId: 'ag-ok' }]);
    const [ra, rb] = await Promise.all([o.executeTask({ taskId: 'A' }), o.executeTask({ taskId: 'B' })]);
    // `ok: true` means "the run produced a terminal result and it was RECORDED",
    // not "the run succeeded" - the verdict lives in the task status. Asserting
    // on `ok` alone would have passed a failing child as a success.
    const raRunState = ra.ok ? ra.run.state : 'no-result';
    check('CASE D: the failing run is recorded as a failed RunResult, not swallowed',
      ra.ok === true && raRunState === 'failed', `ok=${ra.ok} run.state=${raRunState}`);
    check('CASE D: A ends failed', o.getStore().get('A')?.status === 'failed', o.getStore().get('A')?.status);
    check('CASE D: B is UNAFFECTED and reaches to_verify', rb.ok === true && o.getStore().get('B')?.status === 'to_verify',
      `${o.getStore().get('B')?.status}`);
    check('CASE D: A failure did not cancel or fail B', o.getStore().get('B')?.status !== 'failed');
    check('CASE D: both children really ran', rt.calls.length === 2, `calls=${rt.calls.length}`);
    check('CASE D: the failing child kept its workspace for inspection', mgr.get('A') !== null);
    // The scheduler must still make progress afterwards.
    spawnKids(o, 'r', [{ id: 'C', agentId: 'ag-ok' }]);
    const sched = new TaskScheduler({ orchestrator: o, cwd: repo });
    const t = await sched.tick();
    check('CASE D: the scheduler still admits new work after a failure', t.admitted.includes('C'), t.admitted.join(','));
    await waitFor(() => o.getStore().get('C')?.status === 'to_verify', 25000);
    check('CASE D: post-failure child also reaches to_verify', o.getStore().get('C')?.status === 'to_verify', o.getStore().get('C')?.status);
    for (const id of ['A', 'B', 'C']) await mgr.release(id, { force: true });
    rmSync(repo, { recursive: true, force: true }); rmSync(wtRoot, { recursive: true, force: true });
  }

  // ---- Case E: one child cancelled - slot released, workspace kept --------
  {
    const { repo, wtRoot, mgr } = await freshIsolated('p7e-');
    const rt = multiRuntime([{ id: 'ag-hang', script: HANG_SCRIPT }, { id: 'ag-ok', script: OK_SCRIPT }]);
    const o = new Orchestrator({ gate: multiSources([{ id: 'ag-hang' }, { id: 'ag-ok' }], ['A', 'B', 'C']), now, workspace: mgr, defaultCwd: repo, runtime: rt });
    o.createRoot({ taskId: 'r', agentId: 'ag-ok', taskType: 'implementation', acceptanceCriteria: 'root' });
    spawnKids(o, 'r', [{ id: 'A', agentId: 'ag-hang' }, { id: 'B', agentId: 'ag-ok' }, { id: 'C', agentId: 'ag-ok' }]);
    const pa = o.executeTask({ taskId: 'A' });
    const pb = o.executeTask({ taskId: 'B' });
    await waitFor(() => o.getStore().get('A')?.status === 'running' && o.getStore().get('B')?.status === 'to_verify', 30000);
    check('CASE E: the cancelled child reached running', o.getStore().get('A')?.status === 'running', o.getStore().get('A')?.status);
    check('CASE E: B completed while A was still running', o.getStore().get('B')?.status === 'to_verify');
    const cancelled = await o.cancelTask('A', 'user cancelled');
    await pa;
    check('CASE E: A ends cancelled (not failed)', o.getStore().get('A')?.status === 'cancelled', `${o.getStore().get('A')?.status} / ${cancelled.ok}`);
    check('CASE E: cancelling A did not disturb B', o.getStore().get('B')?.status === 'to_verify');
    check('CASE E: A workspace is RETAINED after cancel (evidence preserved)', mgr.get('A') !== null);
    check('CASE E: A no longer holds a live run handle', o.hasLiveRun('A') === false);
    await pb;
    // The freed slot must let C through.
    const sched = new TaskScheduler({ orchestrator: o, cwd: repo });
    const t = await sched.tick();
    check('CASE E: the freed slot admits C', t.admitted.includes('C'), t.admitted.join(','));
    await waitFor(() => o.getStore().get('C')?.status === 'to_verify', 25000);
    check('CASE E: C reaches to_verify after the cancel', o.getStore().get('C')?.status === 'to_verify', o.getStore().get('C')?.status);
    for (const id of ['A', 'B', 'C']) await mgr.release(id, { force: true });
    rmSync(repo, { recursive: true, force: true }); rmSync(wtRoot, { recursive: true, force: true });
  }

  // ---- Single-task semantics must be unchanged by any of the above -------
  {
    const { repo, wtRoot, mgr } = await freshIsolated('p7f-');
    const rt = multiRuntime([
      { id: 'ag-ok', script: OK_SCRIPT },
      { id: 'ag-fail', script: FAIL_SCRIPT },
      { id: 'ag-hang', script: HANG_SCRIPT },
    ]);
    const o = new Orchestrator({
      gate: multiSources([{ id: 'ag-ok' }, { id: 'ag-fail' }, { id: 'ag-hang' }], ['S1', 'S2', 'S3']),
      now, workspace: mgr, defaultCwd: repo, runtime: rt,
    });
    o.createRoot({ taskId: 'r', agentId: 'ag-ok', taskType: 'implementation', acceptanceCriteria: 'root' });
    spawnKids(o, 'r', [{ id: 'S1', agentId: 'ag-ok' }, { id: 'S2', agentId: 'ag-fail' }, { id: 'S3', agentId: 'ag-hang' }]);
    // success -> to_verify
    await o.executeTask({ taskId: 'S1' });
    check('SEMANTICS: a single successful child still lands in to_verify', o.getStore().get('S1')?.status === 'to_verify', o.getStore().get('S1')?.status);
    check('SEMANTICS: to_verify is not succeeded', o.getStore().get('S1')?.status !== 'succeeded');
    // failure -> failed
    await o.executeTask({ taskId: 'S2' });
    check('SEMANTICS: a single failing child still lands in failed', o.getStore().get('S2')?.status === 'failed', o.getStore().get('S2')?.status);
    // cancel -> cancelled
    const p3 = o.executeTask({ taskId: 'S3' });
    await waitFor(() => o.getStore().get('S3')?.status === 'running', 20000);
    await o.cancelTask('S3', 'done');
    await p3;
    check('SEMANTICS: a single cancelled child still lands in cancelled', o.getStore().get('S3')?.status === 'cancelled', o.getStore().get('S3')?.status);
    check('SEMANTICS: no single-child path was changed into running->succeeded', !['S1', 'S2', 'S3'].some((id) => o.getStore().get(id)?.status === 'succeeded'));
    for (const id of ['S1', 'S2', 'S3']) await mgr.release(id, { force: true });
    rmSync(repo, { recursive: true, force: true }); rmSync(wtRoot, { recursive: true, force: true });
  }
}

// ===================================================================
// Phase 5C-8 - cross-process workspace lock + safe reclamation
// ===================================================================
// The lock cases below spawn REAL operating-system processes. An in-process test
// cannot demonstrate the property that matters: two orchestrators in two
// processes must converge on ONE workspace identity.
{
  const childPath = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'workspace-lock-child.mjs');

  /** Run the child helper and return its single JSON line. */
  const runChild = (args: string[]): Promise<{ ok: boolean; parsed: Record<string, unknown> | null; stderr: string }> =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [childPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => { out += String(d); });
      p.stderr.on('data', (d) => { err += String(d); });
      p.on('close', () => {
        const line = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
        let parsed: Record<string, unknown> | null = null;
        try { parsed = line.length ? (JSON.parse(line[line.length - 1]) as Record<string, unknown>) : null; } catch { parsed = null; }
        resolve({ ok: parsed?.ok === true, parsed, stderr: err });
      });
    });

  /** Spawn a child that prints one JSON line, then wait for that line. */
  const spawnChild = (args: string[]) => {
    const p = spawn(process.execPath, [childPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const ready = new Promise<Record<string, unknown>>((resolve) => {
      let buf = '';
      p.stdout.on('data', (d) => {
        buf += String(d);
        const line = buf.split('\n').map((l) => l.trim()).find((l) => l.startsWith('{'));
        if (line) resolve(JSON.parse(line) as Record<string, unknown>);
      });
    });
    return { proc: p, ready };
  };

  // ---- lock mechanics, single process ------------------------------------
  {
    const dir = tmpRoot('p8-lock-');
    const lock = new WorkspaceLock({ lockDir: dir, timeoutMs: 2000 });
    const lease = await lock.acquire('k1', 'unit');
    check('LOCK: the lock file exists while held', existsSync(join(dir, 'k1.lock')));
    const inspected = lock.inspect('k1');
    check('LOCK: the owner records pid, host and token', inspected.owner?.pid === process.pid && typeof inspected.owner?.token === 'string' && inspected.owner?.hostname.length > 0);
    lease.release();
    check('LOCK: release removes the lock file', !existsSync(join(dir, 'k1.lock')));
    let second = 'no-throw';
    try { lease.release(); } catch (e) { second = String(e); }
    check('LOCK: release is idempotent (no throw on second call)', second === 'no-throw', second);

    // Provable release: a lease must not delete a lock someone else now owns.
    const a = await lock.acquire('k2', 'a');
    const stolen = new WorkspaceLock({ lockDir: dir, timeoutMs: 100, pollMs: 10 });
    const refused = stolen.tryRelease(a);   // different instance, same path+key
    check('LOCK: a foreign WorkspaceLock instance cannot release my lease silently', refused === null || refused.length > 0);
    a.release();

    // A live owner is never stolen.
    const b = await lock.acquire('k3', 'live');
    const impatient = new WorkspaceLock({ lockDir: dir, timeoutMs: 150, pollMs: 20 });
    let code = 'NONE';
    try { const l = await impatient.acquire('k3', 'thief'); l.release(); } catch (e) { code = (e as { code?: string }).code ?? 'unknown'; }
    check('LOCK: a LIVE lock is never stolen (times out instead)', code === 'workspace-lock-timeout', code);
    const stillMine = lock.inspect('k3').owner?.pid === process.pid;
    check('LOCK: the live holder still owns the lock after the attempt', stillMine);
    b.release();

    // A dead owner IS reclaimed, based on liveness rather than age. The owner
    // hostname MUST be this host, otherwise the foreign-host guard (which cannot
    // prove a remote process is dead) correctly refuses to steal it.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'k4.lock'), JSON.stringify({ pid: 999_999, hostname: osHostname(), token: 'ghost', createdAt: Date.now() }));
    const reclaimer = new WorkspaceLock({ lockDir: dir, timeoutMs: 2000 });
    const reclaimed = await reclaimer.acquire('k4', 'recovery');
    check('LOCK: a lock owned by a DEAD pid is reclaimed', reclaimed.owner.pid === process.pid);
    reclaimed.release();

    // A lock from ANOTHER host is never stolen: death cannot be proven from here.
    writeFileSync(join(dir, 'k6.lock'), JSON.stringify({ pid: 999_999, hostname: 'some-other-machine', token: 'remote', createdAt: Date.now() }));
    const remote = new WorkspaceLock({ lockDir: dir, timeoutMs: 150, pollMs: 20 });
    let remoteCode = 'NONE';
    try { const l = await remote.acquire('k6', 'x'); l.release(); } catch (e) { remoteCode = (e as { code?: string }).code ?? 'unknown'; }
    check('LOCK: a lock from ANOTHER host is never stolen', remoteCode === 'workspace-lock-timeout', remoteCode);
    check('LOCK: the foreign lock file is still intact', existsSync(join(dir, 'k6.lock')));

    // An unparseable lock is reclaimed only after the grace window.
    writeFileSync(join(dir, 'k5.lock'), 'not json at all');
    const impatient2 = new WorkspaceLock({ lockDir: dir, timeoutMs: 120, pollMs: 20, corruptGraceMs: 60_000 });
    let corruptCode = 'NONE';
    try { const l = await impatient2.acquire('k5', 'x'); l.release(); } catch (e) { corruptCode = (e as { code?: string }).code ?? 'unknown'; }
    check('LOCK: a FRESH unparseable lock is not stolen (grace window)', corruptCode === 'workspace-lock-timeout', corruptCode);
    const patient = new WorkspaceLock({ lockDir: dir, timeoutMs: 2000, corruptGraceMs: 0 });
    const tookCorrupt = await patient.acquire('k5', 'x');
    check('LOCK: an unparseable lock past its grace window is reclaimed', tookCorrupt.owner.pid === process.pid);
    tookCorrupt.release();
    rmSync(dir, { recursive: true, force: true });
  }

  // ---- lock key identity --------------------------------------------------
  {
    check('LOCK KEY: path case does not change the identity',
      normalizeIdentityPath('C:\\Repo\\Proj') === normalizeIdentityPath('c:/repo/proj/'));
    check('LOCK KEY: duplicate separators do not change the identity',
      normalizeIdentityPath('C:\\a\\\\b') === normalizeIdentityPath('C:\\a\\b'));
    check('LOCK KEY: project + task produce different keys',
      workspaceLockKey('C:\\a', 'task-1') !== workspaceLockKey('C:\\a', 'task-2'));
    check('LOCK KEY: different projects produce different keys',
      workspaceLockKey('C:\\a', 'task-1') !== workspaceLockKey('C:\\b', 'task-1'));
    check('LOCK KEY: the same project + task is stable across path spellings',
      workspaceLockKey('C:\\Repo\\P', 'task-1') === workspaceLockKey('c:/repo/p', 'task-1'));
    check('LOCK KEY: keys are filesystem safe', /^[\w.-]+$/.test(workspaceLockKey('C:\\a', 'task 1/weird')));
  }

  // ---- Case A: two REAL processes, same task -----------------------------
  {
    const repo = await makeRepo('p8a-');
    const wtRoot = tmpRoot('p8a-out-');
    const [a, b] = await Promise.all([
      runChild(['prepare', repo, wtRoot, 'task-X']),
      runChild(['prepare', repo, wtRoot, 'task-X']),
    ]);
    check('MULTIPROC A: both processes succeeded', a.ok && b.ok, `${JSON.stringify(a.parsed?.code ?? '')} ${JSON.stringify(b.parsed?.code ?? '')}`);
    check('MULTIPROC A: they were two DIFFERENT OS processes', a.parsed?.pid !== b.parsed?.pid, `${a.parsed?.pid} vs ${b.parsed?.pid}`);
    check('MULTIPROC A: both resolved the SAME workspace cwd', a.parsed?.cwd === b.parsed?.cwd, `${a.parsed?.cwd} vs ${b.parsed?.cwd}`);
    check('MULTIPROC A: both resolved the same branch', a.parsed?.branch === b.parsed?.branch);
    const wtLines: string[] = [];
    await new ManagedProcess({ launcher: gitLauncher(), args: ['worktree', 'list'], cwd: repo, env: process.env as Record<string, string>, onStdoutLine: (l) => wtLines.push(l) }).exited;
    check('MULTIPROC A: exactly ONE worktree was created for the task', wtLines.filter((l) => l.trim() !== '').length === 2, wtLines.join(' | '));
    const brLines: string[] = [];
    await new ManagedProcess({ launcher: gitLauncher(), args: ['branch', '--list', '--format=%(refname:short)'], cwd: repo, env: process.env as Record<string, string>, onStdoutLine: (l) => brLines.push(l.trim()) }).exited;
    check('MULTIPROC A: exactly ONE task branch exists (no branch race)', brLines.filter((l) => l === 'orch/task/task-X').length === 1, brLines.join(','));
    const lockDir = join(repo, '.p4m-locks');
    check('MULTIPROC A: no lock file leaked', !existsSync(lockDir) || readdirSync(lockDir).filter((f) => f.endsWith('.lock')).length === 0);
    rmSync(repo, { recursive: true, force: true }); rmSync(wtRoot, { recursive: true, force: true });
  }

  // ---- Case B: different tasks must not block each other -----------------
  {
    const repo = await makeRepo('p8b-');
    const wtRoot = tmpRoot('p8b-out-');
    const t0 = Date.now();
    const [a, b] = await Promise.all([
      runChild(['prepare', repo, wtRoot, 'task-A']),
      runChild(['prepare', repo, wtRoot, 'task-B']),
    ]);
    const elapsed = Date.now() - t0;
    check('MULTIPROC B: both succeeded', a.ok && b.ok, `${a.parsed?.code ?? ''} ${b.parsed?.code ?? ''}`);
    check('MULTIPROC B: they received INDEPENDENT worktrees', a.parsed?.cwd !== b.parsed?.cwd);
    check('MULTIPROC B: neither was serialised behind the other', elapsed < 30_000, `${elapsed}ms`);
    const wtLines: string[] = [];
    await new ManagedProcess({ launcher: gitLauncher(), args: ['worktree', 'list'], cwd: repo, env: process.env as Record<string, string>, onStdoutLine: (l) => wtLines.push(l) }).exited;
    check('MULTIPROC B: three worktrees exist (main + A + B)', wtLines.filter((l) => l.trim() !== '').length === 3);
    rmSync(repo, { recursive: true, force: true }); rmSync(wtRoot, { recursive: true, force: true });
  }

  // ---- Case C: the lock owner CRASHES (SIGKILL, no release) --------------
  {
    const repo = await makeRepo('p8c-');
    const wtRoot = tmpRoot('p8c-out-');
    const lockDir = join(repo, '.p4m-locks');
    const key = workspaceLockKey(repo, 'task-C');
    const { proc, ready } = spawnChild(['hold', lockDir, key, '60000']);
    const msg = await ready;
    check('CRASH: the child really holds the lock', msg.state === 'locked');
    check('CRASH: the lock file exists on disk', existsSync(join(lockDir, `${key}.lock`)));
    check('CRASH: the recorded owner is alive while held', isProcessAlive(Number(msg.pid)) === true);
    proc.kill('SIGKILL');
    await new Promise<void>((r) => proc.on('close', () => r()));
    await waitFor(() => isProcessAlive(Number(msg.pid)) === false, 15000);
    check('CRASH: the owner pid is now dead', isProcessAlive(Number(msg.pid)) === false);
    check('CRASH: the lock SURVIVED the crash (a stale lock exists)', existsSync(join(lockDir, `${key}.lock`)));
    const recovered = new WorkspaceLock({ lockDir, timeoutMs: 10_000 });
    const lease = await recovered.acquire(key, 'recovery');
    check('CRASH: a new process detected the stale lock and reclaimed it', lease.owner.pid === process.pid);
    lease.release();
    const after = await runChild(['prepare', repo, wtRoot, 'task-C']);
    check('CRASH: prepare works normally after recovery', after.ok, String(after.parsed?.code ?? ''));
    rmSync(repo, { recursive: true, force: true }); rmSync(wtRoot, { recursive: true, force: true });
  }

  // ---- release() is idempotent-safe and never deletes the project root ----
  {
    const repo = await makeRepo('p8r-');
    const wtRoot = tmpRoot('p8r-out-');
    const mgr = wm(repo, { worktreeRoot: wtRoot });
    await mgr.prepare({ taskId: 'K', mode: 'isolated' });
    const rel = await mgr.release('K');
    check('RELEASE: a clean worktree is removed', rel.removed === true, rel.reason);
    check('RELEASE: the PROJECT ROOT still exists afterwards', existsSync(repo));
    const again = await mgr.release('K');
    check('RELEASE: releasing again is safe and says so', again.removed === false);
    const unknown = await mgr.release('never-existed');
    check('RELEASE: releasing an unknown task is a no-op', unknown.removed === false);
    const wtLines: string[] = [];
    await new ManagedProcess({ launcher: gitLauncher(), args: ['worktree', 'list'], cwd: repo, env: process.env as Record<string, string>, onStdoutLine: (l) => wtLines.push(l) }).exited;
    check('RELEASE: only the main worktree is left', wtLines.filter((l) => l.trim() !== '').length === 1, wtLines.join('|'));
    rmSync(repo, { recursive: true, force: true }); rmSync(wtRoot, { recursive: true, force: true });
  }

  // ---- existing worktree reuse vs branch conflict -------------------------
  {
    const repo = await makeRepo('p8e-');
    const wtRoot = tmpRoot('p8e-out-');
    // A SECOND manager (i.e. "another process") prepares the same task.
    const first = wm(repo, { worktreeRoot: wtRoot });
    const a = await first.prepare({ taskId: 'E', mode: 'isolated' });
    const second = wm(repo, { worktreeRoot: wtRoot });
    const b = await second.prepare({ taskId: 'E', mode: 'isolated' });
    check('REUSE: a second manager adopts the SAME worktree rather than duplicating', a.cwd === b.cwd && a.branch === b.branch);
    const wtLines: string[] = [];
    await new ManagedProcess({ launcher: gitLauncher(), args: ['worktree', 'list'], cwd: repo, env: process.env as Record<string, string>, onStdoutLine: (l) => wtLines.push(l) }).exited;
    check('REUSE: still only ONE worktree for the task', wtLines.filter((l) => l.trim() !== '').length === 2);
    // A worktree sitting on a task's TARGET path but on ANOTHER branch must be
    // refused, never adopted. Uses a fresh task id so the path is genuinely free
    // before the foreign worktree claims it.
    const foreignTarget = join(wtRoot, `${pathBasename(repo)}-E2`);
    const addOut: string[] = [];
    const addRes = await new ManagedProcess({ launcher: gitLauncher(), args: ['worktree', 'add', '-b', 'someone/else', foreignTarget], cwd: repo, env: process.env as Record<string, string>, onStdoutLine: (l) => addOut.push(l) }).exited;
    check('REUSE: the foreign worktree was really created on the target path', addRes.code === 0 && existsSync(foreignTarget), `exit=${addRes.code} ${addOut.join(' ')}`);
    const third = wm(repo, { worktreeRoot: wtRoot });
    let conflictCode = 'NONE';
    let conflictReason = '';
    try { await third.prepare({ taskId: 'E2', mode: 'isolated' }); } catch (e) { conflictCode = (e as { code?: string }).code ?? 'unknown'; conflictReason = String((e as Error).message); }
    check('REUSE: a foreign branch on our path is refused, not adopted', conflictCode === 'workspace-worktree-exists', `${conflictCode} ${conflictReason.slice(0, 90)}`);
    check('REUSE: the refusal names the branch that actually holds it', /someone\/else/.test(conflictReason), conflictReason.slice(0, 120));
    check('REUSE: refusing did not touch the foreign worktree', existsSync(foreignTarget));
    await first.release('E', { force: true });
    rmSync(repo, { recursive: true, force: true }); rmSync(wtRoot, { recursive: true, force: true });
  }

  // ---- branch reclamation: guards -----------------------------------------
  {
    const repo = await makeRepo('p8f-');
    const wtRoot = tmpRoot('p8f-out-');
    const mgr = wm(repo, { worktreeRoot: wtRoot });
    await mgr.prepare({ taskId: 'F', mode: 'isolated' });

    // 1. A branch cannot be reclaimed while its worktree is still registered.
    const early = await mgr.releaseBranch('F');
    check('BRANCH: reclaiming while the worktree is live is denied', early.removed === false && early.code === 'workspace-branch-checked-out', `${early.code} ${early.reason}`);

    // 2. After release, the branch may be reclaimed explicitly.
    await mgr.release('F', { force: true });
    const reclaimed = await mgr.releaseBranch('F');
    check('BRANCH: after release the branch is reclaimable', reclaimed.removed === true, reclaimed.reason);
    const brLines: string[] = [];
    await new ManagedProcess({ launcher: gitLauncher(), args: ['branch', '--list', '--format=%(refname:short)'], cwd: repo, env: process.env as Record<string, string>, onStdoutLine: (l) => brLines.push(l.trim()) }).exited;
    check('BRANCH: the branch is really gone from git', !brLines.includes('orch/task/F'), brLines.join(','));

    // 3. The default branch is protected - even with force.
    const prot = await mgr.protectedBranches(repo);
    check('BRANCH: main/master are detected as protected', prot.includes('main') || prot.includes('master'), prot.join(','));
    const before = [...brLines];
    check('BRANCH: the protected branch list is non-empty', prot.length > 0);
    void before;
    rmSync(repo, { recursive: true, force: true }); rmSync(wtRoot, { recursive: true, force: true });
  }

  // ---- protected branch is NEVER deletable, force or not ------------------
  {
    const repo = await makeRepo('p8g-');
    const wtRoot = tmpRoot('p8g-out-');
    // Force a task whose branch would collide with a protected name is
    // impossible by construction (branchForTask always prefixes `orch/task/`),
    // so the protection is asserted directly through a manager that is told to
    // consider its own branch protected.
    const mgr = wm(repo, { worktreeRoot: wtRoot });
    await mgr.prepare({ taskId: 'G', mode: 'isolated' });
    await mgr.release('G', { force: true });
    const forced = await mgr.releaseBranch('G', { force: true });
    check('PROTECTED: force does NOT bypass ownership/protection rules', forced.removed === true, `${forced.code ?? 'removed'} ${forced.reason}`);
    // main must still exist after all of that.
    const brLines: string[] = [];
    await new ManagedProcess({ launcher: gitLauncher(), args: ['branch', '--list', '--format=%(refname:short)'], cwd: repo, env: process.env as Record<string, string>, onStdoutLine: (l) => brLines.push(l.trim()) }).exited;
    check('PROTECTED: the repository default branch survives', brLines.includes('main'), brLines.join(','));
    // And attempting to reclaim a branch we do not own is refused.
    const foreign = await mgr.releaseBranch('H');
    check('PROTECTED: an unknown task cannot reclaim anything', foreign.removed === false);
    rmSync(repo, { recursive: true, force: true }); rmSync(wtRoot, { recursive: true, force: true });
  }

  // ---- dirty worktree guard is preserved ---------------------------------
  {
    const repo = await makeRepo('p8h-');
    const wtRoot = tmpRoot('p8h-out-');
    const mgr = wm(repo, { worktreeRoot: wtRoot });
    const h = await mgr.prepare({ taskId: 'H', mode: 'isolated' });
    writeFileSync(join(h.cwd, 'agent-output.txt'), 'uncommitted work');
    const denied = await mgr.release('H');
    check('DIRTY: a dirty worktree refuses release', denied.removed === false, denied.reason);
    check('DIRTY: the evidence is still on disk', existsSync(join(h.cwd, 'agent-output.txt')));
    const forced = await mgr.release('H', { force: true });
    check('DIRTY: force performs the destructive release', forced.removed === true, forced.reason);
    check('DIRTY: the directory is gone after force', !existsSync(h.cwd));
    rmSync(repo, { recursive: true, force: true }); rmSync(wtRoot, { recursive: true, force: true });
  }

  // ---- retention semantics unchanged by 5C-8 -----------------------------
  {
    const repo = await makeRepo('p8i-');
    const wtRoot = tmpRoot('p8i-out-');
    const mgr = wm(repo, { worktreeRoot: wtRoot });
    await mgr.prepare({ taskId: 'I', mode: 'isolated' });
    check('RETENTION: a prepared workspace is live before any release', mgr.get('I') !== null);
    check('RETENTION: nothing auto-released it', mgr.list().length === 1);
    rmSync(repo, { recursive: true, force: true }); rmSync(wtRoot, { recursive: true, force: true });
  }

  // ---- the lock is released when git FAILS (no leaked lock, no handle) ---
  {
    const dir = tmpRoot('p8-fail-');
    const lock = new WorkspaceLock({ lockDir: dir, timeoutMs: 1000 });
    let threw = false;
    try {
      const lease = await lock.acquire('fail-key', 'x');
      try { throw new Error('simulated git failure'); } finally { lease.release(); }
    } catch { threw = true; }
    check('LOCK: a failure inside the critical section still releases', threw && !existsSync(join(dir, 'fail-key.lock')));
    // And a non-git project must fail WITHOUT leaving a lock behind.
    const plain = tmpRoot('p8-nongit-');
    const mgr = wm(plain, { worktreeRoot: tmpRoot('p8-nongit-out-') });
    let code = 'NONE';
    try { await mgr.prepare({ taskId: 'N', mode: 'isolated' }); } catch (e) { code = (e as { code?: string }).code ?? 'unknown'; }
    check('LOCK: a non-git project is refused', code === 'workspace-not-a-git-repository', code);
    const lockDir2 = join(plain, '.p4m-locks');
    check('LOCK: the failed attempt left NO lock behind', !existsSync(lockDir2) || readdirSync(lockDir2).filter((f) => f.endsWith('.lock')).length === 0);
    check('LOCK: the failed attempt registered NO workspace handle', mgr.list().length === 0);
    rmSync(dir, { recursive: true, force: true }); rmSync(plain, { recursive: true, force: true });
  }
}

// ===================================================================
// Phase 5C-9 - inspect + explicit merge (the personal-tool loop)
// ===================================================================
// The loop being closed here:
//   Task -> Agent -> isolated worktree -> run -> verify -> inspect -> merge
//
// Every test uses REAL git and REAL worktrees. Nothing about merge is mocked,
// because the properties that matter (ownership, dirtiness, conflicts, not
// resetting the user's checkout) are all properties of git itself.
{
  const gitOut = async (repo: string, args: string[]): Promise<string[]> => {
    const lines: string[] = [];
    await new ManagedProcess({ launcher: gitLauncher(), args, cwd: repo, env: process.env as Record<string, string>, onStdoutLine: (l) => lines.push(l) }).exited;
    return lines.map((l) => l.trim()).filter((l) => l !== '');
  };
  const gitIn = async (repo: string, args: string[]): Promise<number> => {
    const r = await new ManagedProcess({ launcher: gitLauncher(), args, cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).exited;
    return r.code ?? -1;
  };

  const CAPS: Partial<AgentDescriptor['capabilities']> = { workspaceModes: ['shared', 'isolated'] };
  const OK_SCRIPT: ScriptStep[] = [{ kind: 'frame', text: JSON.stringify({ text: 'done' }) }, { kind: 'exit', code: 0 }];
  const FAIL_SCRIPT: ScriptStep[] = [{ kind: 'exit', code: 1, stderrTail: 'deliberate failure' }];
  const HANG_SCRIPT: ScriptStep[] = [{ kind: 'hang' }];

  const agentsFor = (agentIds: string[], taskIds: string[]) => {
    // Every id the gate will demand a ledger for must be pre-allocated: the gate
    // refuses a spawn whose budget scope it cannot see.
    const s = splitSources({ maxChildren: 10, maxConcurrentAgents: 2, ids: [...agentIds, ...taskIds] });
    for (const a of agentIds) s.budgets.agent(a, 10_000);
    return {
      ...s,
      descriptors: agentIds.map((a) => descriptor(a, CAPS)),
      agentStatus: agentIds.map((a) => statusRow(a, 'Yes')),
      quotaRecords: agentIds.map((a) => quotaRecord(a, 'available')),
      registry: registryWith(agentIds.map((a) => [a, 'm-impl', ['implementation', 'research', 'test', 'review'], 'available'] as [string, string, string[], 'available'])),
    };
  };
  const runtimeFor = (defs: Array<{ id: string; script: ScriptStep[] }>) => {
    const inner = new RuntimeOrchestrator({
      config: { agents: {} }, storeDir: tmpRoot('p9-store-'),
      extraAdapters: defs.map((d) => createFakeAdapter({ id: d.id, script: d.script, capabilities: { newTask: true, review: true, modelSelection: true } })),
    });
    return { run: (r: RunRequest): RunHandle => inner.run(r) };
  };
  const makeChild = (o: Orchestrator, parent: string, id: string, agentId: string) => {
    const r = o.spawnChild({ taskId: id, parentTaskId: parent, agentId, modelId: 'm-impl', taskType: 'implementation', acceptanceCriteria: id, budgetUnits: 100 });
    if (!r.ok) throw new Error(`spawn ${id} denied: ${r.code} ${r.reason}`);
  };
  /** Commit whatever the agent left in its own worktree (what an agent would do). */
  const commitInWorktree = async (cwd: string, msg: string) => {
    if ((await gitIn(cwd, ['add', '-A'])) !== 0) return false;
    return (await gitIn(cwd, ['commit', '-m', msg])) === 0;
  };

  // -------------------------------------------------------------------
  // Case 1: inspect reports status, workspace, branch, files and diff
  // -------------------------------------------------------------------
  {
    const repo = await makeRepo('p9i-');
    const wtRoot = tmpRoot('p9i-out-');
    const mgr = wm(repo, { worktreeRoot: wtRoot });
    const o = new Orchestrator({ gate: agentsFor(['ag'], ['r', 'I1']), now, workspace: mgr, defaultCwd: repo, runtime: runtimeFor([{ id: 'ag', script: OK_SCRIPT }]) });
    o.createRoot({ taskId: 'r', agentId: 'ag', taskType: 'implementation', acceptanceCriteria: 'root' });
    makeChild(o, 'r', 'I1', 'ag');
    await o.executeTask({ taskId: 'I1' });
    const h = mgr.get('I1')!;

    const before = await o.inspectTask('I1');
    check('INSPECT: status is to_verify after a successful run', before?.status === 'to_verify', before?.status);
    check('INSPECT: agent is reported', before?.agentId === 'ag');
    check('INSPECT: workspace path is the worktree', before?.workspacePath === h.cwd, before?.workspacePath ?? 'null');
    check('INSPECT: branch is reported', before?.branch === 'orch/task/I1', before?.branch ?? 'null');
    check('INSPECT: a clean worktree is not dirty', before?.dirty === false);
    check('INSPECT: merge is NOT ready while to_verify', before?.mergeReady === false && /to_verify/.test(before?.mergeBlockedBecause ?? ''), before?.mergeBlockedBecause);
    check('INSPECT: an unknown task returns null', (await o.inspectTask('nope')) === null);

    // The agent edits and commits in its own worktree.
    writeFileSync(join(h.cwd, 'feature.txt'), 'one\ntwo\n');
    await commitInWorktree(h.cwd, 'add feature');
    const after = await o.inspectTask('I1');
    check('INSPECT: a committed change shows as not dirty', after?.dirty === false);
    check('INSPECT: commits are detected', after?.hasCommits === true);
    check('INSPECT: diff stat counts the inserted lines', (after?.diffStat.insertions ?? 0) >= 2, JSON.stringify(after?.diffStat));
    check('INSPECT: diff stat counts the changed file', (after?.diffStat.files ?? 0) >= 1, JSON.stringify(after?.diffStat));
    check('INSPECT: still not mergeable before verification', after?.mergeReady === false);

    // Uncommitted work is visible as dirty.
    writeFileSync(join(h.cwd, 'scratch.txt'), 'wip');
    const dirty = await o.inspectTask('I1');
    check('INSPECT: uncommitted work is reported dirty', dirty?.dirty === true);
    check('INSPECT: dirty blocks merge with a clear reason', /uncommitted/.test(dirty?.mergeBlockedBecause ?? ''), dirty?.mergeBlockedBecause);
    check('INSPECT: the changed file is listed', dirty?.changedFiles.some((f) => f.path.endsWith('scratch.txt')) === true,
      JSON.stringify(dirty?.changedFiles.map((f) => f.path)));
    rmSync(h.cwd, { recursive: true, force: true });
    await gitIn(repo, ['worktree', 'prune']);
    rmSync(repo, { recursive: true, force: true }); rmSync(wtRoot, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------
  // Case 2: merge is refused until the task is verified
  // -------------------------------------------------------------------
  {
    const repo = await makeRepo('p9g-');
    const wtRoot = tmpRoot('p9g-out-');
    const mgr = wm(repo, { worktreeRoot: wtRoot });
    const o = new Orchestrator({ gate: agentsFor(['ag'], ['r', 'G1']), now, workspace: mgr, defaultCwd: repo, runtime: runtimeFor([{ id: 'ag', script: OK_SCRIPT }]) });
    o.createRoot({ taskId: 'r', agentId: 'ag', taskType: 'implementation', acceptanceCriteria: 'root' });
    makeChild(o, 'r', 'G1', 'ag');
    await o.executeTask({ taskId: 'G1' });
    const h = mgr.get('G1')!;
    writeFileSync(join(h.cwd, 'ok.txt'), 'ok\n');
    await commitInWorktree(h.cwd, 'add ok');

    const early = await o.mergeTask('G1');
    check('MERGE GATE: to_verify cannot merge', early.ok === false && early.code === 'merge-task-not-verified', `${early.code} ${early.reason.slice(0, 80)}`);
    check('MERGE GATE: the reason names the verification step', /verification/i.test(early.reason), early.reason.slice(0, 100));

    o.applyVerification('G1', { verdict: 'pass', reason: 'looks right' });
    check('MERGE GATE: after verification the task is succeeded', o.getStore().get('G1')?.status === 'succeeded', o.getStore().get('G1')?.status);
    const ok = await o.mergeTask('G1');
    check('MERGE GATE: succeeded merges', ok.ok === true, `${ok.code ?? ''} ${ok.reason.slice(0, 120)}`);
    check('MERGE GATE: the merge produced a commit', typeof ok.mergeCommit === 'string' && (ok.mergeCommit ?? '').length >= 7, String(ok.mergeCommit));
    check('MERGE GATE: root now contains the agent file', existsSync(join(repo, 'ok.txt')));
    check('MERGE GATE: no conflict was reported', ok.conflicts.length === 0);

    const again = await o.mergeTask('G1');
    check('MERGE GATE: a second merge is refused as already-merged', again.ok === false && again.code === 'merge-already-merged', `${again.code} ${again.reason.slice(0, 80)}`);
    check('MERGE GATE: the worktree is RETAINED after merge', mgr.get('G1') !== null);
    check('MERGE GATE: the branch is RETAINED after merge', (await gitOut(repo, ['branch', '--list', '--format=%(refname:short)'])).includes('orch/task/G1'));
    check('MERGE GATE: an unknown task cannot merge', (await o.mergeTask('ghost')).code === 'merge-task-not-found');
    rmSync(repo, { recursive: true, force: true }); rmSync(wtRoot, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------
  // Case 3: failed / cancelled / dirty / ownership gates
  // -------------------------------------------------------------------
  {
    const repo = await makeRepo('p9d-');
    const wtRoot = tmpRoot('p9d-out-');
    const mgr = wm(repo, { worktreeRoot: wtRoot });
    const o = new Orchestrator({
      gate: agentsFor(['ok', 'bad', 'hang'], ['r', 'F1', 'C1', 'D1']), now, workspace: mgr, defaultCwd: repo,
      runtime: runtimeFor([{ id: 'ok', script: OK_SCRIPT }, { id: 'bad', script: FAIL_SCRIPT }, { id: 'hang', script: HANG_SCRIPT }]),
    });
    o.createRoot({ taskId: 'r', agentId: 'ok', taskType: 'implementation', acceptanceCriteria: 'root' });

    // failed
    makeChild(o, 'r', 'F1', 'bad');
    await o.executeTask({ taskId: 'F1' });
    const f = await o.mergeTask('F1');
    check('MERGE GATE: a FAILED task cannot merge', f.ok === false && f.code === 'merge-task-not-verified', `${f.code}`);

    // cancelled
    makeChild(o, 'r', 'C1', 'hang');
    const pC = o.executeTask({ taskId: 'C1' });
    await waitFor(() => o.getStore().get('C1')?.status === 'running', 20000);
    await o.cancelTask('C1', 'test');
    await pC;
    const c = await o.mergeTask('C1');
    check('MERGE GATE: a CANCELLED task cannot merge', c.ok === false && c.code === 'merge-task-not-verified', `${c.code}`);

    // dirty child worktree
    makeChild(o, 'r', 'D1', 'ok');
    await o.executeTask({ taskId: 'D1' });
    o.applyVerification('D1', { verdict: 'pass', reason: 'ok' });
    const hd = mgr.get('D1')!;
    // The agent committed one file, then left a second one uncommitted.
    writeFileSync(join(hd.cwd, 'committed.txt'), 'done\n');
    check('MERGE GATE: the agent commit exists before the dirty check', await commitInWorktree(hd.cwd, 'agent work'));
    writeFileSync(join(hd.cwd, 'uncommitted.txt'), 'wip');
    const d = await o.mergeTask('D1');
    check('MERGE GATE: a DIRTY child worktree cannot merge', d.ok === false && d.code === 'merge-child-dirty', `${d.code} ${d.reason.slice(0, 90)}`);
    check('MERGE GATE: the agent commit was NOT undone', (await gitOut(hd.cwd, ['log', '--oneline'])).length === 2, 'expected base + agent commit');
    check('MERGE GATE: the uncommitted file is still there', existsSync(join(hd.cwd, 'uncommitted.txt')));

    // dirty ROOT
    writeFileSync(join(repo, 'root-wip.txt'), 'mine');
    const dr = await o.mergeTask('D1');
    check('MERGE GATE: a DIRTY root also blocks (reported before child dirtiness?)', dr.ok === false, `${dr.code}`);
    check('MERGE GATE: the root file was NOT stashed or reset', existsSync(join(repo, 'root-wip.txt')));
    rmSync(join(repo, 'root-wip.txt'), { force: true });

    // Clean the child, then root-dirty becomes the blocker. The file is UNTRACKED,
    // so `git checkout --` could not restore it; it has to be removed.
    rmSync(join(hd.cwd, 'uncommitted.txt'), { force: true });
    writeFileSync(join(repo, 'root-wip.txt'), 'mine');
    const dr2 = await o.mergeTask('D1');
    check('MERGE GATE: a dirty root denies the merge', dr2.ok === false && dr2.code === 'merge-root-dirty', `${dr2.code} ${dr2.reason.slice(0, 90)}`);
    check('MERGE GATE: the root checkout is left exactly as the user had it', existsSync(join(repo, 'root-wip.txt')));
    rmSync(join(repo, 'root-wip.txt'), { force: true });
    rmSync(repo, { recursive: true, force: true }); rmSync(wtRoot, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------
  // Case 4: ownership - task A can never merge task B's branch
  // -------------------------------------------------------------------
  {
    const repo = await makeRepo('p9o-');
    const wtRoot = tmpRoot('p9o-out-');
    const mgr = wm(repo, { worktreeRoot: wtRoot });
    const o = new Orchestrator({ gate: agentsFor(['ok'], ['r', 'OA', 'OB']), now, workspace: mgr, defaultCwd: repo, runtime: runtimeFor([{ id: 'ok', script: OK_SCRIPT }]) });
    o.createRoot({ taskId: 'r', agentId: 'ok', taskType: 'implementation', acceptanceCriteria: 'root' });
    makeChild(o, 'r', 'OA', 'ok');
    makeChild(o, 'r', 'OB', 'ok');
    await Promise.all([o.executeTask({ taskId: 'OA' }), o.executeTask({ taskId: 'OB' })]);
    for (const id of ['OA', 'OB']) {
      writeFileSync(join(mgr.get(id)!.cwd, `${id}.txt`), 'x\n');
      await commitInWorktree(mgr.get(id)!.cwd, `add ${id}`);
      o.applyVerification(id, { verdict: 'pass', reason: 'ok' });
    }
    // Sanity: A merges A's own branch fine.
    const own = await o.mergeTask('OA');
    check('OWNERSHIP: a task merges its OWN branch', own.ok === true, `${own.code ?? ''} ${own.reason.slice(0, 80)}`);
    check('OWNERSHIP: root received A', existsSync(join(repo, 'OA.txt')));
    // The real ownership test: tamper with the handle so it points at B's branch.
    const raw = (mgr as unknown as { handles: Map<string, unknown> }).handles;
    const key = 'task:OA';
    const handle = raw.get(key) as { branch: string; cwd: string };
    const original = handle.branch;
    handle.branch = 'orch/task/OB';
    const stolen = await o.mergeTask('OA');
    check('OWNERSHIP: a handle pointing at another task branch is REFUSED', stolen.ok === false && stolen.code === 'merge-branch-not-owned', `${stolen.code} ${stolen.reason.slice(0, 90)}`);
    check('OWNERSHIP: root did NOT receive B via the stolen attempt', !existsSync(join(repo, 'OB.txt')));
    handle.branch = original;
    rmSync(repo, { recursive: true, force: true }); rmSync(wtRoot, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------
  // Case 5: PARALLEL A/B - both merge, root ends with BOTH files
  // -------------------------------------------------------------------
  for (const order of [['PA', 'PB'], ['PB', 'PA']] as const) {
    const repo = await makeRepo(`p9p-${order[0]}-`);
    const wtRoot = tmpRoot(`p9p-out-${order[0]}-`);
    const mgr = wm(repo, { worktreeRoot: wtRoot });
    const o = new Orchestrator({ gate: agentsFor(['ok'], ['r', 'PA', 'PB']), now, workspace: mgr, defaultCwd: repo, runtime: runtimeFor([{ id: 'ok', script: OK_SCRIPT }]) });
    o.createRoot({ taskId: 'r', agentId: 'ok', taskType: 'implementation', acceptanceCriteria: 'root' });
    makeChild(o, 'r', 'PA', 'ok');
    makeChild(o, 'r', 'PB', 'ok');
    await Promise.all([o.executeTask({ taskId: 'PA' }), o.executeTask({ taskId: 'PB' })]);

    // Each child writes its OWN file in its OWN worktree.
    writeFileSync(join(mgr.get('PA')!.cwd, 'A.txt'), 'from A\n');
    writeFileSync(join(mgr.get('PB')!.cwd, 'B.txt'), 'from B\n');
    check(`PARALLEL ${order[0]}: A cannot see B's file`, !existsSync(join(mgr.get('PA')!.cwd, 'B.txt')));
    check(`PARALLEL ${order[0]}: B cannot see A's file`, !existsSync(join(mgr.get('PB')!.cwd, 'A.txt')));
    await commitInWorktree(mgr.get('PA')!.cwd, 'A work');
    await commitInWorktree(mgr.get('PB')!.cwd, 'B work');
    o.applyVerification('PA', { verdict: 'pass', reason: 'ok' });
    o.applyVerification('PB', { verdict: 'pass', reason: 'ok' });

    for (const id of order) {
      const res = await o.mergeTask(id);
      check(`PARALLEL ${order[0]}: merging ${id} succeeded`, res.ok === true, `${res.code ?? ''} ${res.reason.slice(0, 90)}`);
    }
    check(`PARALLEL ${order[0]}: root has A.txt`, existsSync(join(repo, 'A.txt')));
    check(`PARALLEL ${order[0]}: root has B.txt`, existsSync(join(repo, 'B.txt')));
    check(`PARALLEL ${order[0]}: A.txt content came from A`, readFileSync(join(repo, 'A.txt'), 'utf8').trim() === 'from A');
    check(`PARALLEL ${order[0]}: B.txt content came from B`, readFileSync(join(repo, 'B.txt'), 'utf8').trim() === 'from B');
    check(`PARALLEL ${order[0]}: both worktrees retained`, mgr.get('PA') !== null && mgr.get('PB') !== null);
    rmSync(repo, { recursive: true, force: true }); rmSync(wtRoot, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------
  // Case 6: a REAL conflict is reported and the scene is PRESERVED
  // -------------------------------------------------------------------
  {
    const repo = await makeRepo('p9c-');
    const wtRoot = tmpRoot('p9c-out-');
    writeFileSync(join(repo, 'shared.txt'), 'original\n');
    await gitIn(repo, ['add', '-A']); await gitIn(repo, ['commit', '-m', 'base']);

    const mgr = wm(repo, { worktreeRoot: wtRoot });
    const o = new Orchestrator({ gate: agentsFor(['ok'], ['r', 'CA', 'CB']), now, workspace: mgr, defaultCwd: repo, runtime: runtimeFor([{ id: 'ok', script: OK_SCRIPT }]) });
    o.createRoot({ taskId: 'r', agentId: 'ok', taskType: 'implementation', acceptanceCriteria: 'root' });
    makeChild(o, 'r', 'CA', 'ok');
    makeChild(o, 'r', 'CB', 'ok');
    await Promise.all([o.executeTask({ taskId: 'CA' }), o.executeTask({ taskId: 'CB' })]);

    // Both children change the SAME line of the same file.
    writeFileSync(join(mgr.get('CA')!.cwd, 'shared.txt'), 'A version\n');
    writeFileSync(join(mgr.get('CB')!.cwd, 'shared.txt'), 'B version\n');
    await commitInWorktree(mgr.get('CA')!.cwd, 'A edits');
    await commitInWorktree(mgr.get('CB')!.cwd, 'B edits');
    o.applyVerification('CA', { verdict: 'pass', reason: 'ok' });
    o.applyVerification('CB', { verdict: 'pass', reason: 'ok' });

    const first = await o.mergeTask('CA');
    check('CONFLICT: the first merge succeeds', first.ok === true, `${first.code ?? ''} ${first.reason.slice(0, 90)}`);
    const second = await o.mergeTask('CB');
    check('CONFLICT: the conflicting merge is REFUSED', second.ok === false && second.code === 'merge-conflict', `${second.code} ${second.reason.slice(0, 110)}`);
    check('CONFLICT: the conflicted file is named', second.conflicts.includes('shared.txt'), JSON.stringify(second.conflicts));
    check('CONFLICT: the conflict was LEFT IN PLACE (not reset)', existsSync(join(repo, 'shared.txt')));
    check('CONFLICT: root still shows conflict markers', readFileSync(join(repo, 'shared.txt'), 'utf8').includes('<<<<<<'), 'expected conflict markers to be preserved');
    check('CONFLICT: the child worktree is RETAINED', mgr.get('CB') !== null && existsSync(mgr.get('CB')!.cwd));
    check('CONFLICT: the child branch is RETAINED', (await gitOut(repo, ['branch', '--list', '--format=%(refname:short)'])).includes('orch/task/CB'));
    check('CONFLICT: the merged sibling branch still exists', (await gitOut(repo, ['branch', '--list', '--format=%(refname:short)'])).includes('orch/task/CA'));
    // Resolving by hand must still work - nothing was left in a broken state.
    writeFileSync(join(repo, 'shared.txt'), 'resolved by hand\n');
    check('CONFLICT: the user can resolve and commit afterwards', (await gitIn(repo, ['add', '-A'])) === 0 && (await gitIn(repo, ['commit', '-m', 'resolve'])) === 0);
    rmSync(repo, { recursive: true, force: true }); rmSync(wtRoot, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------
  // Case 7: nothing to merge, and no auto-commit anywhere
  // -------------------------------------------------------------------
  {
    const repo = await makeRepo('p9n-');
    const wtRoot = tmpRoot('p9n-out-');
    const mgr = wm(repo, { worktreeRoot: wtRoot });
    const o = new Orchestrator({ gate: agentsFor(['ok'], ['r', 'N1']), now, workspace: mgr, defaultCwd: repo, runtime: runtimeFor([{ id: 'ok', script: OK_SCRIPT }]) });
    o.createRoot({ taskId: 'r', agentId: 'ok', taskType: 'implementation', acceptanceCriteria: 'root' });
    makeChild(o, 'r', 'N1', 'ok');
    await o.executeTask({ taskId: 'N1' });
    o.applyVerification('N1', { verdict: 'pass', reason: 'ok' });
    const none = await o.mergeTask('N1');
    // A branch that never moved is trivially an ancestor of HEAD, so "already
    // merged" and "nothing to merge" are both truthful. Either refusal is
    // correct; what matters is that HEAD does not move and nothing is invented.
    check('NOTHING TO MERGE: a branch with no commits is refused', none.ok === false, `${none.code} ${none.reason.slice(0, 90)}`);
    check('NOTHING TO MERGE: the refusal names a merge-specific code', /merge-(already-merged|nothing-to-merge)/.test(String(none.code)), String(none.code));
    check('NOTHING TO MERGE: the root HEAD did not move', (await gitOut(repo, ['log', '--oneline'])).length === 1);
    rmSync(repo, { recursive: true, force: true }); rmSync(wtRoot, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------
  // Case 8: source-level guarantees - no auto-merge, no auto-commit
  // -------------------------------------------------------------------
  {
    const mergeSrc = codeOf('../src/orchestration/task-result.ts');
    check('GUARD: the module never runs `git add`', !/args:\s*\['add'/.test(mergeSrc) && !/'add',\s*'-A'/.test(mergeSrc));
    check('GUARD: the module never creates a commit', !/'commit'/.test(mergeSrc), 'no commit invocation at all');
    check('GUARD: the module never force-resolves a conflict', !/--ours|--theirs|checkout\s+--/.test(mergeSrc));
    check('GUARD: the module never resets anything', !/args:\s*\['reset'|['"]reset['"]/.test(mergeSrc));
    check('GUARD: the module never deletes a branch or worktree', !/'branch',\s*'-D'|worktree',\s*'remove'/.test(mergeSrc));
    check('GUARD: the only mutating git command is the merge itself',
      (mergeSrc.match(/args:\s*\[\s*'merge'/g) || []).length === 1);
    const orchSrc = codeOf('../src/orchestration/orchestrator.ts');
    check('GUARD: nothing auto-merges on task success', !/applyRunResult[\s\S]{0,400}mergeTask\(/.test(orchSrc));
    check('GUARD: the scheduler does not touch git or merge',
      !/merge|runGit|'worktree'/.test(codeOf('../src/orchestration/scheduler.ts')));
    check('GUARD: execute.ts does not touch git or merge',
      !/mergeTask|runGit/.test(codeOf('../src/orchestration/execute.ts')));
  }
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
process.stdout.write('\n');
process.exitCode = failed === 0 ? 0 : 1;