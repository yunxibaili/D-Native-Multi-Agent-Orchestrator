/**
 * tests/b14-selection.test.ts — B1.4 user Agent × Model selection (auto/fixed, project/task).
 *
 * HERMETIC: a fake runtime records the RunRequests; no real agent is started. The
 * workbench, registry, assignment, session and task store are the REAL production
 * objects, so the assertions exercise the real selection → assignment path.
 *
 * Covers: unset = auto (unchanged); project fixed; task fixed overrides project;
 * task `auto` overrides project fixed; the fixed pair reaches the RunRequest and the
 * task identity; an unavailable/invalid pair is refused with NO substitution; a DSH
 * fixed model is refused BEFORE any process; a user-fixed pair cannot be silently
 * swapped by an automatic reassign/handoff; and config validation.
 *
 * Run: node tests/b14-selection.test.ts
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NativeWorkbench, type AssignOutcome, type InitialSelectionOutcome } from '../src/orchestration/workbench.ts';
import type { WorkbenchTaskSpec } from '../src/orchestration/workbench-plan.ts';
import { Orchestrator } from '../src/orchestration/orchestrator.ts';
import { TaskScheduler } from '../src/orchestration/scheduler.ts';
import { buildRunRequest } from '../src/orchestration/execute.ts';
import type { Task } from '../src/orchestration/task.ts';
import { ModelRegistry } from '../src/quota/registry.ts';
import { BudgetManager } from '../src/quota/budget.ts';
import { Orchestrator as RuntimeOrch } from '../src/orchestrator/orchestrator.ts';
import { loadConfig } from '../src/orchestrator/config.ts';
import { validateRuntimeLaunchPreflight } from '../src/runtime/preflight.ts';
import { runRoundCli } from '../src/cli/round-cli.ts';
import { createFakeAdapter } from './helpers.ts';
import { createDshAdapter } from '../src/adapters/dsh.ts';
import { resolveSelection, fixedPairOf, type AgentDescriptor, type RunRequest, type SelectionSpec } from '../src/core/types.ts';
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
function ownDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
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
const B = 'agent-b';
const MA = 'agent-a/model-1';
const MB = 'agent-b/model-2';
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

interface Harness {
  wb: NativeWorkbench;
  requests: RunRequest[];
  dir: string;
}
function makeHarness(opts: { projectSelection?: SelectionSpec; provider?: DecisionProvider } = {}): Harness {
  const dir = ownDir('b14-');
  const requests: RunRequest[] = [];
  const rt = new RuntimeOrch({
    config: { agents: {} } as never,
    storeDir: join(dir, 'store'),
    extraAdapters: [
      createFakeAdapter({ id: A, script: [{ kind: 'exit', code: 0 }], capabilities: { newTask: true, review: true, modelSelection: true } }),
      createFakeAdapter({ id: B, script: [{ kind: 'exit', code: 0 }], capabilities: { newTask: true, review: true, modelSelection: true } }),
    ],
  });
  const runtime = { run: (r: RunRequest) => { requests.push(r); return rt.run(r); } };
  const budgets = new BudgetManager(1_000_000);
  for (const t of ['r', 'r-c1', 'r-c2', 'r-c3']) budgets.task(t, 100_000);
  budgets.agent(A, 1_000_000);
  budgets.agent(B, 1_000_000);
  const reg = registryWith([[A, MA, ['implementation']], [B, MB, ['implementation']]]);
  const orch = new Orchestrator({
    gate: {
      descriptors: [descriptor(A), descriptor(B)],
      agentStatus: [statusRow(A), statusRow(B)],
      quotaRecords: [quotaRecord(A), quotaRecord(B)],
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
    quotaRecords: [quotaRecord(A), quotaRecord(B)],
    cwd: dir,
    ...(opts.provider !== undefined ? { decisionProvider: opts.provider } : {}),
    ...(opts.projectSelection !== undefined ? { projectSelection: opts.projectSelection } : {}),
  });
  return { wb, requests, dir };
}

async function planAssign(h: Harness, spec: WorkbenchTaskSpec): Promise<{ children: Task[]; assigned: readonly AssignOutcome[]; selections: readonly InitialSelectionOutcome[] }> {
  h.wb.plan(spec, null);
  const selections = await h.wb.selectInitialAssignment(spec.taskId, spec.selection);
  const assigned = h.wb.assignChildren(spec.taskId, spec);
  return { children: h.wb.store.children(spec.taskId), assigned, selections };
}

const specFor = (selection?: SelectionSpec): WorkbenchTaskSpec => ({
  taskId: 'r',
  objective: 'do the thing',
  taskType: 'implementation',
  budgetUnits: 100_000,
  ...(selection !== undefined ? { selection } : {}),
});

const identityOf = (children: readonly Task[]): string => children.map((c) => `${c.agentId}/${c.modelId}`).join(',');

// =========================================================================
section('pure selection helpers');

check('resolveSelection: unset => auto', resolveSelection(undefined, undefined).mode === 'auto');
check('resolveSelection: project fixed applies when task unset',
  resolveSelection(undefined, { mode: 'fixed', agentId: B, modelId: MB }).mode === 'fixed');
check('resolveSelection: task fixed overrides project',
  JSON.stringify(resolveSelection({ mode: 'fixed', agentId: A, modelId: MA }, { mode: 'fixed', agentId: B, modelId: MB })) ===
    JSON.stringify({ mode: 'fixed', agentId: A, modelId: MA }));
check('resolveSelection: task auto overrides project fixed',
  resolveSelection({ mode: 'auto' }, { mode: 'fixed', agentId: B, modelId: MB }).mode === 'auto');
check('fixedPairOf: fixed => the pair, auto => undefined',
  JSON.stringify(fixedPairOf({ mode: 'fixed', agentId: A, modelId: MA })) === JSON.stringify({ agentId: A, modelId: MA }) &&
    fixedPairOf({ mode: 'auto' }) === undefined);

// =========================================================================
section('unset: existing auto behaviour (Laya decides) is unchanged');

{
  const h = makeHarness({ provider: stubProvider(`${A}\u0000${MA}`) });
  const { children, assigned, selections } = await planAssign(h, specFor());
  check('auto: the task is assigned to the Laya-chosen pair', identityOf(children) === `${A}/${MA}`, identityOf(children));
  check('auto: assignment succeeded', assigned.every((a) => a.ok), JSON.stringify(assigned));
  check('auto: the selection provenance is the provider, not user-fixed',
    selections.every((s) => s.ok && s.provider !== 'user-fixed'), JSON.stringify(selections));
}

// =========================================================================
section('project fixed: the pinned pair is enforced and Laya is not asked');

{
  const h = makeHarness({ projectSelection: { mode: 'fixed', agentId: B, modelId: MB }, provider: stubProvider(`${A}\u0000${MA}`) });
  const { children, selections } = await planAssign(h, specFor());
  check('project fixed: the pinned pair is used, NOT the provider choice', identityOf(children) === `${B}/${MB}`, identityOf(children));
  check('project fixed: provenance is user-fixed',
    selections.every((s) => s.ok && s.provider === 'user-fixed'), JSON.stringify(selections));
}

// =========================================================================
section('task fixed overrides project default; task auto overrides project fixed');

{
  const h = makeHarness({ projectSelection: { mode: 'fixed', agentId: B, modelId: MB }, provider: stubProvider(`${B}\u0000${MB}`) });
  const { children } = await planAssign(h, specFor({ mode: 'fixed', agentId: A, modelId: MA }));
  check('task fixed overrides project fixed', identityOf(children) === `${A}/${MA}`, identityOf(children));
}
{
  const h = makeHarness({ projectSelection: { mode: 'fixed', agentId: B, modelId: MB }, provider: stubProvider(`${A}\u0000${MA}`) });
  const { children, selections } = await planAssign(h, specFor({ mode: 'auto' }));
  check('task auto overrides project fixed (Laya decides again)', identityOf(children) === `${A}/${MA}`, identityOf(children));
  check('task auto: provenance is the provider, not user-fixed',
    selections.every((s) => s.ok && s.provider !== 'user-fixed'), JSON.stringify(selections));
}

// =========================================================================
section('fixed pair flows into the Task identity and the RunRequest');

{
  const h = makeHarness({ provider: stubProvider(`${B}\u0000${MB}`) });
  const { children } = await planAssign(h, specFor({ mode: 'fixed', agentId: A, modelId: MA }));
  const child = children[0]!;
  check('the task identity carries the fixed pair', child.agentId === A && child.modelId === MA, `${child.agentId}/${child.modelId}`);
  // The execution request is built from the Task identity; a fixed pair therefore
  // reaches the Runtime verbatim (agent + FULL model id, no provider prepended).
  const { request } = buildRunRequest({ task: child, cwd: h.dir });
  check('the RunRequest carries the fixed agent + full model id', request.agentId === A && request.model === MA,
    `${request.agentId} / ${String(request.model)}`);
}

// =========================================================================
section('unavailable / invalid fixed pair: refused, never substituted');

{
  const h = makeHarness({ provider: stubProvider(`${A}\u0000${MA}`) });
  const { children, assigned } = await planAssign(h, specFor({ mode: 'fixed', agentId: A, modelId: 'agent-a/does-not-exist' }));
  const outcome = assigned.find((a) => a.taskId === children[0]!.taskId);
  check('an unregistered fixed model is REFUSED', outcome !== undefined && outcome.ok === false, JSON.stringify(outcome));
  check('the refusal code is a model-availability refusal, not a substitution',
    outcome?.code === 'no-model-available', String(outcome?.code));
  check('no task was substituted to a different pair',
    children.every((c) => c.modelId === null || c.modelId === 'agent-a/does-not-exist'), identityOf(children));
}
{
  const bad = resolveSelection(undefined, { mode: 'fixed', agentId: B, modelId: MB });
  check('a well-formed fixed selection resolves without substituting', bad.mode === 'fixed' && fixedPairOf(bad)?.modelId === MB);
}

// =========================================================================
section('DSH fixed model: refused BEFORE any process starts');

{
  const dsh = createDshAdapter({ launcher: { kind: 'native', command: 'C:/fake/dsh.exe', prefixArgs: [], target: 'C:/fake/dsh.exe', buildsCommandString: false } });
  let threw = false;
  try {
    validateRuntimeLaunchPreflight({
      req: { agentId: 'dsh', prompt: 'x', cwd: '.', model: 'deepseek/some-model' },
      capabilities: { newTask: true, review: false, resume: false },
      config: { model: undefined, role: undefined, sandbox: undefined, timeoutMs: undefined },
      validateAdapterRequest: (r) => dsh.validateRequest(r),
      resolveResumeTarget: () => { throw new Error('unused'); },
    });
  } catch {
    threw = true;
  }
  check('a fixed DSH + model is rejected at preflight (no spawn)', threw);
  check('the DSH adapter itself refuses a per-request model',
    (() => { try { dsh.validateRequest({ agentId: 'dsh', prompt: 'x', cwd: '.', model: 'm' }); return false; } catch { return true; } })());
}

// =========================================================================
section('a user-fixed pair cannot be silently swapped by an automatic reassign');

{
  const h = makeHarness({ provider: stubProvider(`${B}\u0000${MB}`) });
  const { children } = await planAssign(h, specFor({ mode: 'fixed', agentId: A, modelId: MA }));
  const child = children[0]!;
  const swap = h.wb.reassignTask(child.taskId, B, MB, 'automatic handoff');
  check('reassigning a user-fixed task to a DIFFERENT pair is refused', swap.ok === false, JSON.stringify(swap));
  check('the refusal is a fixed-selection lock, not a generic error', swap.code === 'fixed-selection-locked', swap.code);
  const after = h.wb.store.get(child.taskId)!;
  check('the task identity is unchanged after the refused reassign', after.agentId === A && after.modelId === MA, `${after.agentId}/${after.modelId}`);
}

// =========================================================================
section('project config: selection parses and validates');

{
  const dir = ownDir('b14cfg-');
  const write = (obj: unknown): string => { const p = join(dir, 'orchestrator.json'); writeFileSync(p, JSON.stringify(obj)); return p; };
  const fixed = loadConfig(write({ agents: {}, selection: { mode: 'fixed', agentId: A, modelId: MA } })).config.selection;
  check('a fixed project selection is parsed verbatim', JSON.stringify(fixed) === JSON.stringify({ mode: 'fixed', agentId: A, modelId: MA }), JSON.stringify(fixed));
  const auto = loadConfig(write({ agents: {}, selection: { mode: 'auto' } })).config.selection;
  check('an auto project selection is parsed', auto?.mode === 'auto');
  let badPartial = false;
  try { loadConfig(write({ agents: {}, selection: { mode: 'fixed', agentId: A } })); } catch { badPartial = true; }
  check('a PARTIAL fixed selection is refused by config validation', badPartial);
  let badMode = false;
  try { loadConfig(write({ agents: {}, selection: { mode: 'sometimes' } })); } catch { badMode = true; }
  check('an unknown selection mode is refused', badMode);
}

// =========================================================================
section('B1.4a: the fixed constraint survives dynamic task creation and later handoff');

const newTasksSince = (h: Harness, before: Set<string>): Task[] => h.wb.store.all().filter((t) => !before.has(t.taskId));

{
  // A. project fixed → dynamic addTask → reassign to another pair is refused.
  const h = makeHarness({ projectSelection: { mode: 'fixed', agentId: A, modelId: MA }, provider: stubProvider(`${A}\u0000${MA}`) });
  const { children } = await planAssign(h, specFor());
  const parentId = children[0]!.taskId;
  const before = new Set(h.wb.store.all().map((t) => t.taskId));
  const added = h.wb.addTask(parentId, 'follow-up work');
  check('A: the dynamic task was added', added.ok === true, JSON.stringify(added));
  const created = newTasksSince(h, before);
  check('A: a new task exists under the fixed root', created.length === 1, `created=${created.length}`);
  const dynamic = created[0]!;
  const swap = h.wb.reassignTask(dynamic.taskId, B, MB, 'automatic handoff');
  check('A: reassigning the dynamic task to a DIFFERENT pair is refused', swap.ok === false, JSON.stringify(swap));
  check('A: the refusal is fixed-selection-locked', swap.code === 'fixed-selection-locked', swap.code);
  const after = h.wb.store.get(dynamic.taskId)!;
  check('A: the dynamic task identity is unchanged (no migration)', after.agentId === A && after.modelId === MA, `${after.agentId}/${after.modelId}`);
  check('A: no execution was dispatched', h.requests.length === 0, `requests=${h.requests.length}`);
}

{
  // The EXACT reported path: through the real `decisionCapabilities` wrappers
  // (`addTask` then `reassign`), not the raw methods.
  const h = makeHarness({ projectSelection: { mode: 'fixed', agentId: A, modelId: MA }, provider: stubProvider(`${A}\u0000${MA}`) });
  const { children } = await planAssign(h, specFor());
  const caps = h.wb.decisionCapabilities({});
  const before = new Set(h.wb.store.all().map((t) => t.taskId));
  const add = await caps.addTask?.({ parentTaskId: children[0]!.taskId, objective: 'follow up', reason: 'decision' });
  check('caps: addTask succeeded', add?.ok === true, JSON.stringify(add));
  const dynamic = newTasksSince(h, before)[0];
  check('caps: the dynamic task exists', dynamic !== undefined, 'none');
  if (dynamic !== undefined) {
    const re = await caps.reassign?.({ taskId: dynamic.taskId, agentId: B, modelId: MB, reason: 'handoff' });
    check('caps: reassign of a fixed-root dynamic task is refused',
      re?.ok === false && re?.code === 'fixed-selection-locked', JSON.stringify(re));
  }
}

{
  // B. task fixed overrides project fixed → a dynamic child keeps the TASK constraint.
  const h = makeHarness({ projectSelection: { mode: 'fixed', agentId: B, modelId: MB }, provider: stubProvider(`${B}\u0000${MB}`) });
  const { children } = await planAssign(h, specFor({ mode: 'fixed', agentId: A, modelId: MA }));
  const before = new Set(h.wb.store.all().map((t) => t.taskId));
  h.wb.addTask(children[0]!.taskId, 'more');
  const dynamic = newTasksSince(h, before)[0];
  check('B: the dynamic child inherits the TASK pair, not the project pair',
    dynamic !== undefined && dynamic.agentId === A && dynamic.modelId === MA, dynamic ? `${dynamic.agentId}/${dynamic.modelId}` : 'none');
  if (dynamic !== undefined) {
    const swap = h.wb.reassignTask(dynamic.taskId, B, MB, 'handoff');
    check('B: the dynamic child is locked to the task pair', swap.code === 'fixed-selection-locked', swap.code);
  }
}

{
  // C. task auto over project fixed → the dynamic child is NOT misjudged as fixed.
  const h = makeHarness({ projectSelection: { mode: 'fixed', agentId: B, modelId: MB }, provider: stubProvider(`${A}\u0000${MA}`) });
  const { children } = await planAssign(h, specFor({ mode: 'auto' }));
  const before = new Set(h.wb.store.all().map((t) => t.taskId));
  h.wb.addTask(children[0]!.taskId, 'more');
  const dynamic = newTasksSince(h, before)[0];
  check('C: the auto-root dynamic child exists', dynamic !== undefined, 'none');
  if (dynamic !== undefined) {
    const swap = h.wb.reassignTask(dynamic.taskId, B, MB, 'automatic handoff');
    check('C: an auto-root dynamic task is NOT fixed-locked', swap.code !== 'fixed-selection-locked', `${swap.code}: ${swap.reason}`);
  }
}

{
  // D. the replan/split creation path keeps the constraint.
  const h = makeHarness({ projectSelection: { mode: 'fixed', agentId: A, modelId: MA }, provider: stubProvider(`${A}\u0000${MA}`) });
  const { children } = await planAssign(h, specFor());
  const target = children[0]!.taskId;
  const before = new Set(h.wb.store.all().map((t) => t.taskId));
  const replan = h.wb.replanSubtree(target, 'chain', 'split it');
  check('D: the replan applied', replan.ok === true, JSON.stringify(replan));
  const created = newTasksSince(h, before);
  check('D: replan created tasks', created.length >= 1, `created=${created.length}`);
  const unlocked = created.filter((t) => h.wb.reassignTask(t.taskId, B, MB, 'handoff').code !== 'fixed-selection-locked');
  check('D: every replanned task keeps the fixed constraint', unlocked.length === 0, `unlocked=${unlocked.length}/${created.length}`);
}

{
  // E. a bare `--select` (no value) is a usage error with ZERO external calls.
  let runtimeCalls = 0;
  const stubRuntime = {
    descriptors: () => { runtimeCalls++; return []; },
    agentIds: () => { runtimeCalls++; return []; },
    configFor: () => { runtimeCalls++; return {}; },
  } as never;
  const code = await runRoundCli(stubRuntime, ['do something', '--select']);
  check('E: missing --select value is a usage error (exit 2)', code === 2, String(code));
  check('E: no discovery / LAYA / runtime call happened', runtimeCalls === 0, `runtimeCalls=${runtimeCalls}`);
}

// =========================================================================

for (const d of tmpDirs) removeOwnedDir(d);

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
if (cleanupFailures.length) process.stdout.write(`cleanup failures (must fail the test):\n  ${cleanupFailures.map((f) => `- ${f}`).join('\n  ')}\n`);
process.stdout.write('\n');
process.exitCode = failed === 0 && cleanupFailures.length === 0 ? 0 : 1;
