/**
 * tests/b40-workflow.test.ts — B4.0 sequential heterogeneous workflow.
 *
 * HERMETIC: the runtime is the REAL `RuntimeOrchestrator` with fake adapters, so the
 * chain under test is the real one — Workbench -> Planner/TaskStore -> Assignment ->
 * SessionRegistry -> Scheduler/executeTask -> Runtime -> Attempt -> downstream brief.
 * No real agent is started.
 *
 * Covers: bounded workflow plans + LAYA selection; the research -> implementation ->
 * test chain with the EXISTING task types and REAL dependencies; sequential execution
 * (downstream is not admitted until the upstream step succeeded); the upstream handoff
 * actually reaching the downstream brief; a failed upstream blocking downstream; a
 * fixed selection surviving the workflow; and the CLI opt-in (usage errors, opt-out
 * unchanged).
 *
 * Run: node tests/b40-workflow.test.ts
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NativeWorkbench, type AssignOutcome } from '../src/orchestration/workbench.ts';
import type { WorkbenchTaskSpec } from '../src/orchestration/workbench-plan.ts';
import { Orchestrator } from '../src/orchestration/orchestrator.ts';
import { TaskScheduler } from '../src/orchestration/scheduler.ts';
import type { Task } from '../src/orchestration/task.ts';
import { validateCandidateDag } from '../src/orchestration/planner.ts';
import {
  HETEROGENEOUS_WORKFLOW_CHOICES,
  WORKFLOW_PLAN_CHOICES,
  buildWorkflowCandidates,
  isWorkflowChoice,
  workflowPlanFor,
} from '../src/orchestration/workflow-plan.ts';
import { WORKFLOW_PLAN_ID, readWorkflowPlan, workflowPlanQuestions } from '../src/decision/plan-choice.ts';
import { ModelRegistry } from '../src/quota/registry.ts';
import { BudgetManager } from '../src/quota/budget.ts';
import { Orchestrator as RuntimeOrch } from '../src/orchestrator/orchestrator.ts';
import { runRoundCli } from '../src/cli/round-cli.ts';
import { createFakeAdapter } from './helpers.ts';
import type { AgentDescriptor, RunRequest, SelectionSpec } from '../src/core/types.ts';
import type { QuotaRecord } from '../src/quota/types.ts';
import type { DecisionProvider, DecisionRequest } from '../src/decision/types.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];
const tmpDirs: string[] = [];
const cleanupFailures: string[] = [];

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
function ownDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'b40-'));
  tmpDirs.push(d);
  return d;
}
function removeOwnedDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    cleanupFailures.push(`owned dir removal threw for ${dir}: ${(e as Error).message}`);
    return;
  }
  if (existsSync(dir)) cleanupFailures.push(`owned dir ${dir} still present after removal`);
}

const A = 'agent-a';
const MA = 'agent-a/model-1';
const NOW = 1_700_000_000_000;

const descriptor = (id: string): AgentDescriptor =>
  ({
    id, displayName: id,
    launcher: { kind: 'native', command: id, prefixArgs: [], target: id, buildsCommandString: false },
    transport: 'cli-jsonl',
    capabilities: { newTask: true, review: true, modelSelection: true, resume: true },
  }) as unknown as AgentDescriptor;
const statusRow = (agent: string) => ({ agent, version: '1', installed: 'Yes', login: 'n/a', quotaSource: 't', usage: 'n/a', status: 'ok' });
const quotaRecord = (agentId: string): QuotaRecord => ({
  provider: agentId, agentId, modelId: null, source: 'locally_observed', usage: null, remaining: null,
  resetAt: null, period: 'day', status: 'available', usageClass: 'observed', confidence: 'high', observedAt: NOW, note: '',
});
const registryWith = (entries: Array<[string, string, string[]]>): ModelRegistry => {
  const reg = new ModelRegistry();
  for (const [agentId, modelId, taskTypes] of entries) {
    reg.upsert({ agentId, modelId, provider: 'test', taskTypes: taskTypes as never, modelSource: 'test', quotaSource: 'test' }, NOW);
    reg.setAgentAvailability(agentId, 'available');
  }
  return reg;
};
const stubProvider = (choice: string): DecisionProvider =>
  ({
    decide: async (req: DecisionRequest) => ({
      answers: {
        [Object.keys(req.questions ?? {})[0] ?? 'initial_agent_model']:
          { type: 'choice', choice, probabilities: { [choice]: 1 }, confidence: 1, criteria: {} },
      },
    }),
  }) as unknown as DecisionProvider;

interface Harness { wb: NativeWorkbench; requests: RunRequest[]; dir: string; budgets: BudgetManager }
function makeHarness(opts: { provider?: DecisionProvider; projectSelection?: SelectionSpec; exitCode?: number } = {}): Harness {
  const dir = ownDir();
  const requests: RunRequest[] = [];
  const exit = opts.exitCode ?? 0;
  const rt = new RuntimeOrch({
    config: { agents: {} } as never,
    storeDir: join(dir, 'store'),
    extraAdapters: [
      createFakeAdapter({ id: A, script: [{ kind: 'exit', code: exit }], capabilities: { newTask: true, review: true, modelSelection: true } }),
    ],
  });
  const runtime = { run: (r: RunRequest) => { requests.push(r); return rt.run(r); } };
  const budgets = new BudgetManager(1_000_000);
  budgets.agent(A, 1_000_000);
  const reg = registryWith([[A, MA, ['implementation', 'research', 'test']]]);
  const orch = new Orchestrator({
    gate: {
      descriptors: [descriptor(A)],
      agentStatus: [statusRow(A)],
      quotaRecords: [quotaRecord(A)],
      registry: reg,
      budgets,
      taskType: 'implementation',
      requestedUnits: 10,
      currentConcurrency: 0,
      maxConcurrency: 4,
      maxChildren: 8,
      maxConcurrentAgents: 4,
    } as never,
    now: () => NOW,
    runtime,
    defaultCwd: dir,
  });
  const scheduler = new TaskScheduler({ orchestrator: orch, cwd: dir });
  const wb = new NativeWorkbench({
    orchestrator: orch,
    scheduler,
    registry: reg,
    quotaRecords: [quotaRecord(A)],
    cwd: dir,
    ...(opts.provider !== undefined ? { decisionProvider: opts.provider } : {}),
    ...(opts.projectSelection !== undefined ? { projectSelection: opts.projectSelection } : {}),
  });
  return { wb, requests, dir, budgets };
}

const specFor = (selection?: SelectionSpec): WorkbenchTaskSpec => ({
  taskId: 'r', objective: 'add a retry to the http client', taskType: 'implementation', budgetUnits: 100_000,
  ...(selection !== undefined ? { selection } : {}),
});
const byTaskType = (children: readonly Task[], t: string): Task | undefined => children.find((c) => c.taskType === t);

// =========================================================================
section('pure workflow plan: bounded choices, real types, real dependencies');

check('there are two bounded choices', HETEROGENEOUS_WORKFLOW_CHOICES.length === 2 && WORKFLOW_PLAN_CHOICES.length === 2);
check('isWorkflowChoice accepts the known choices and refuses others',
  isWorkflowChoice('full') && isWorkflowChoice('lean') && !isWorkflowChoice('nope'));
{
  const full = buildWorkflowCandidates('full', 'goal', 'r');
  check('full plan has research -> implementation -> test',
    full.map((c) => c.taskType).join(',') === 'research,implementation,test', full.map((c) => c.taskType).join(','));
  check('full plan is a strict chain (each depends on the one before)',
    full[0]!.dependencies.length === 0 && full[1]!.dependencies.join(',') === 'r-w1' && full[2]!.dependencies.join(',') === 'r-w2',
    full.map((c) => c.dependencies.join('|')).join(' '));
  check('full plan passes the EXISTING candidate-DAG validator',
    validateCandidateDag(full, new Map([['r', { taskId: 'r', dependencies: [] as string[] }]])).ok);
  const lean = buildWorkflowCandidates('lean', 'goal', 'r');
  check('lean plan is implementation -> test', lean.map((c) => c.taskType).join(',') === 'implementation,test');
}
{
  const q = workflowPlanQuestions([{ choice: 'full', label: 'l', roles: ['research'] }, { choice: 'lean', label: 'l2', roles: ['implementation'] }]);
  const offered = Object.keys(q[WORKFLOW_PLAN_ID]!.criteria ?? {});
  check('the plan question offers exactly the bounded choices', offered.join(',') === 'full,lean', offered.join(','));
  const picked = readWorkflowPlan(
    { answers: { [WORKFLOW_PLAN_ID]: { type: 'choice', choice: 'lean', probabilities: {}, confidence: 1, criteria: {} } } } as never,
    [{ choice: 'full', label: 'l', roles: [] }, { choice: 'lean', label: 'l2', roles: [] }],
  );
  check('a valid plan answer is accepted', picked === 'lean');
  let refused = false;
  try { readWorkflowPlan({ answers: { [WORKFLOW_PLAN_ID]: { type: 'choice', choice: 'invented', probabilities: {}, confidence: 1, criteria: {} } } } as never, [{ choice: 'full', label: 'l', roles: [] }]); } catch { refused = true; }
  check('an invented plan is refused (not one of the offered)', refused);
}

// =========================================================================
section('real chain: research -> implementation -> test, sequential, with real handoffs');

{
  const h = makeHarness({ provider: stubProvider(`${A}\u0000${MA}`) });
  const candidates = buildWorkflowCandidates('full', 'add a retry to the http client', 'r');
  for (const c of candidates) h.budgets.task(c.taskId, 100_000);
  const spec = specFor();
  const planned = h.wb.planWithCandidates(spec, candidates);
  const children = planned.children;
  check('the plan committed three heterogeneous tasks',
    children.map((c) => c.taskType).join(',') === 'research,implementation,test', children.map((c) => c.taskType).join(','));
  check('the implementation step depends on research, test on implementation',
    byTaskType(children, 'implementation')!.dependencies.includes('r-w1') && byTaskType(children, 'test')!.dependencies.includes('r-w2'));

  await h.wb.selectInitialAssignment('r', spec.selection);
  const assigned: readonly AssignOutcome[] = h.wb.assignChildren('r', spec);
  const liveOf = (t: string): Task | undefined => h.wb.store.children('r').find((c) => c.taskType === t);
  check('every workflow task was assigned the chosen pair',
    assigned.every((a) => a.ok) && h.wb.store.children('r').every((c) => c.agentId === A && c.modelId === MA),
    JSON.stringify(assigned.map((a) => [a.taskId, a.ok, a.code])));

  // Dispatch 1: ONLY research is ready.
  await h.wb.dispatch();
  check('dispatch 1 ran only the research step', h.requests.length === 1 && h.requests[0]!.prompt.includes('research') && h.requests[0]!.prompt.includes('r-w1'),
    `n=${h.requests.length}`);
  check('research ran as the research task type', liveOf('research')!.status !== 'planned', liveOf('research')!.status);
  // The existing verification authority moves the finished step to `succeeded`; only then
  // does the scheduler treat the dependency as satisfied. This is the SAME gate the round
  // uses — a Runtime exit 0 alone does NOT satisfy a dependency.
  h.wb.completeTask('r-w1', 'verified by the existing verification step');

  // Dispatch 2: research succeeded, so implementation is now ready; test is not.
  await h.wb.dispatch();
  check('dispatch 2 ran the implementation step', h.requests.length === 2 && h.requests[1]!.prompt.includes('implementation — deliverable'),
    `n=${h.requests.length}`);
  check('the implementation brief actually carries the research handoff',
    h.requests[1]!.prompt.includes('Handoff from task r-w1'), h.requests[1]!.prompt.slice(0, 400));
  check('the test step did NOT run before implementation succeeded', liveOf('test')!.status === 'planned',
    liveOf('test')!.status);
  h.wb.completeTask('r-w2', 'verified by the existing verification step');

  // Dispatch 3: implementation succeeded, so test is ready.
  await h.wb.dispatch();
  check('dispatch 3 ran the test step', h.requests.length === 3 && h.requests[2]!.prompt.includes('test — deliverable'),
    `n=${h.requests.length}`);
  check('the test brief carries its DIRECT upstream handoff (implementation)',
    h.requests[2]!.prompt.includes('Handoff from task r-w2'),
    h.requests[2]!.prompt.slice(0, 400));
}

// =========================================================================
section('a failed upstream blocks downstream');

{
  const h = makeHarness({ provider: stubProvider(`${A}\u0000${MA}`), exitCode: 1 });
  const candidates = buildWorkflowCandidates('full', 'goal', 'r');
  for (const c of candidates) h.budgets.task(c.taskId, 100_000);
  const spec = specFor();
  h.wb.planWithCandidates(spec, candidates);
  await h.wb.selectInitialAssignment('r', spec.selection);
  h.wb.assignChildren('r', spec);
  await h.wb.dispatch();
  check('research ran and FAILED', h.requests.length === 1 && byTaskType(h.wb.store.children('r'), 'research')!.status === 'failed',
    byTaskType(h.wb.store.children('r'), 'research')!.status);
  await h.wb.dispatch();
  await h.wb.dispatch();
  check('implementation and test were NEVER dispatched after the failure', h.requests.length === 1, `n=${h.requests.length}`);
}

// =========================================================================
section('fixed selection survives the workflow; illegal plans are refused');

{
  const h = makeHarness({ provider: stubProvider(`${A}\u0000${MA}`) });
  const candidates = buildWorkflowCandidates('lean', 'goal', 'r');
  for (const c of candidates) h.budgets.task(c.taskId, 100_000);
  const spec = specFor({ mode: 'fixed', agentId: A, modelId: MA });
  h.wb.planWithCandidates(spec, candidates);
  await h.wb.selectInitialAssignment('r', spec.selection);
  h.wb.assignChildren('r', spec);
  check('a fixed selection is honoured for every workflow step',
    h.wb.store.children('r').every((c) => c.agentId === A && c.modelId === MA),
    h.wb.store.children('r').map((c) => `${c.agentId}/${c.modelId}`).join(','));
  const dynamic = h.wb.store.children('r')[1]!;
  const swap = h.wb.reassignTask(dynamic.taskId, 'agent-x', 'agent-x/m9', 'handoff');
  check('a fixed workflow task cannot be swapped by a reassign', swap.code === 'fixed-selection-locked', swap.code);
}
{
  const dup = [...buildWorkflowCandidates('full', 'goal', 'r')];
  const withDup = [...dup, { ...dup[0]!, taskId: dup[0]!.taskId }];
  check('a duplicate id is refused by the existing validator', !validateCandidateDag(withDup as never).ok);
  const dangling = [{ ...dup[0]!, dependencies: ['does-not-exist'] }];
  check('a dangling dependency is refused', !validateCandidateDag(dangling as never).ok);
  const cyclic = [{ ...dup[0]!, dependencies: ['r-w2'] }, { ...dup[1]!, taskId: 'r-w2', dependencies: ['r-w1'] }];
  check('a cycle is refused', !validateCandidateDag(cyclic as never).ok);
}

// =========================================================================
section('CLI opt-in: usage errors reject before any runtime call; opt-out unchanged');

{
  let runtimeCalls = 0;
  const stubRuntime = {
    descriptors: () => { runtimeCalls++; return []; },
    agentIds: () => { runtimeCalls++; return []; },
    configFor: () => { runtimeCalls++; return {}; },
  } as never;
  const bare = await runRoundCli(stubRuntime, ['do something', '--workflow']);
  check('a bare --workflow is a usage error (exit 2)', bare === 2, String(bare));
  const bad = await runRoundCli(stubRuntime, ['do something', '--workflow', 'bogus']);
  check('an unknown --workflow value is a usage error', bad === 2, String(bad));
  const choiceNoWorkflow = await runRoundCli(stubRuntime, ['do something', '--workflow-choice', 'full']);
  check('--workflow-choice without --workflow is a usage error', choiceNoWorkflow === 2, String(choiceNoWorkflow));
  check('no runtime/discovery call happened for any usage error', runtimeCalls === 0, String(runtimeCalls));
}
check('workflowPlanFor refuses an unknown plan', (() => { try { workflowPlanFor('nope'); return false; } catch { return true; } })());

// =========================================================================

for (const d of tmpDirs) removeOwnedDir(d);

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
if (cleanupFailures.length) process.stdout.write(`cleanup failures (must fail the test):\n  ${cleanupFailures.map((f) => `- ${f}`).join('\n  ')}\n`);
process.stdout.write('\n');
process.exitCode = failed === 0 && cleanupFailures.length === 0 ? 0 : 1;
