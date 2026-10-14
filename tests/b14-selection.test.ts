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

import { NativeWorkbench, MODEL_POOL_CONSTRAINT_PROVENANCE, type AssignOutcome, type InitialSelectionOutcome } from '../src/orchestration/workbench.ts';
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
import { resolveSelection, fixedPairOf, type AgentDescriptor, type RunHandle, type RunRequest, type RunResult, type SelectionSpec } from '../src/core/types.ts';
import type { QuotaRecord, QuotaStatus } from '../src/quota/types.ts';
import type { DecisionProvider, DecisionRequest } from '../src/decision/types.ts';
import { INITIAL_AGENT_MODEL_ID, initialCandidateKey } from '../src/decision/initial-assignment.ts';
import { WORKFLOW_PLAN_ID } from '../src/decision/plan-choice.ts';
import { ACCEPTANCE_MATERIAL_FIELD, ORCHESTRATION_ACTION_ID } from '../src/orchestration/decision-loop.ts';
import type { QuotaProbe } from '../src/quota/index.ts';
import {
  USER_MODEL_POOL_MAX_BYTES,
  USER_MODEL_POOL_POLICY,
  admitUserModelPoolPair,
  parseUserModelPool,
  parseUserModelPoolText,
  type UserModelPool,
  type UserModelPoolEntry,
} from '../src/orchestration/model-pool.ts';

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

/** B2.1: a declaration valid at "now" — observedAt in the past, expiresAt far future. */
const liveEntry = (agentId: string, modelId: string, over: Partial<UserModelPoolEntry> = {}): UserModelPoolEntry => ({
  agentId, modelId, billing: 'free', source: 'b2.1 test declaration',
  observedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER, ...over,
});
const livePool = (...entries: UserModelPoolEntry[]): UserModelPool => ({ policy: USER_MODEL_POOL_POLICY, models: entries });

const descriptor = (id: string): AgentDescriptor =>
  ({
    id, displayName: id,
    launcher: { kind: 'native', command: id, prefixArgs: [], target: id, buildsCommandString: false },
    transport: 'cli-jsonl',
    capabilities: { newTask: true, review: true, modelSelection: true, resume: true },
  }) as unknown as AgentDescriptor;
const statusRow = (agent: string) => ({ agent, version: '1', installed: 'Yes', login: 'n/a', quotaSource: 't', usage: 'n/a', status: 'ok' });
const quotaRecord = (agentId: string, status: QuotaStatus = 'available'): QuotaRecord => ({
  provider: agentId, agentId, modelId: null, source: 'locally_observed', usage: null, remaining: null,
  resetAt: null, period: 'day', status, usageClass: 'observed', confidence: 'high', observedAt: NOW, note: '',
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

/**
 * B2.1: a provider that RECORDS every offered choice set, so a test can prove the user
 * pool narrowed what LAYA was shown. `pick` chooses an offered key (defaults to the
 * first); returning a key that was never offered exercises the forged-answer refusal.
 */
const offeredProvider = (pick?: (offered: readonly string[]) => string): { provider: DecisionProvider; offered: string[][] } => {
  const seen: string[][] = [];
  const provider = {
    decide: async (req: DecisionRequest) => {
      const answers: Record<string, unknown> = {};
      for (const [key, q] of Object.entries(req.questions ?? {})) {
        if (q.type === 'choice') {
          const offered = Object.keys((q.criteria ?? {}) as Record<string, string>);
          seen.push(offered);
          const choice = pick !== undefined ? pick(offered) : offered[0]!;
          const probabilities: Record<string, number> = {};
          for (const o of offered) probabilities[o] = o === choice ? 1 : 0;
          answers[key] = { type: 'choice', choice, probabilities, confidence: 1, criteria: q.criteria };
        } else {
          answers[key] = { type: q.type };
        }
      }
      return { answers };
    },
  } as unknown as DecisionProvider;
  return { provider, offered: seen };
};

interface Harness {
  wb: NativeWorkbench;
  requests: RunRequest[];
  dir: string;
  budgets: BudgetManager;
}
function makeHarness(opts: { projectSelection?: SelectionSpec; provider?: DecisionProvider; modelPool?: UserModelPool; quotaStatus?: QuotaStatus; models?: Array<[string, string, string[]]> } = {}): Harness {
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
  const reg = registryWith(opts.models ?? [[A, MA, ['implementation']], [B, MB, ['implementation']]]);
  const quotaRecords = [quotaRecord(A, opts.quotaStatus), quotaRecord(B)];
  const orch = new Orchestrator({
    gate: {
      descriptors: [descriptor(A), descriptor(B)],
      agentStatus: [statusRow(A), statusRow(B)],
      quotaRecords,
      registry: reg,
      budgets,
      taskType: 'implementation',
      requestedUnits: 10,
      currentConcurrency: 0,
      maxConcurrency: 4,
      maxChildren: 8,
      maxConcurrentAgents: 4,
      // B2.1: the SAME frozen user pool on the gate, so the dispatch-time recheck uses it.
      ...(opts.modelPool !== undefined ? { userModelPool: opts.modelPool } : {}),
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
    quotaRecords,
    cwd: dir,
    ...(opts.provider !== undefined ? { decisionProvider: opts.provider } : {}),
    ...(opts.projectSelection !== undefined ? { projectSelection: opts.projectSelection } : {}),
    ...(opts.modelPool !== undefined ? { modelPool: opts.modelPool } : {}),
  });
  return { wb, requests, dir, budgets };
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
// B2.1 — USER-DECLARED NO-ADDITIONAL-CHARGE MODEL POOL (opt-in minimum slice)
// =========================================================================

section('B2.1 parser: strict fields, types, bounds, duplicates');

{
  const good = {
    policy: USER_MODEL_POOL_POLICY,
    models: [{ agentId: A, modelId: MA, billing: 'free', source: 'user note', observedAt: 1, expiresAt: 2 }],
  };
  const parsed = parseUserModelPool(good);
  check('parser: a well-formed declaration parses', parsed.ok === true, JSON.stringify(parsed));
  if (parsed.ok) {
    check('parser: the pool, the models array and the entry are frozen',
      Object.isFrozen(parsed.pool) && Object.isFrozen(parsed.pool.models) && Object.isFrozen(parsed.pool.models[0]!));
    check('parser: the declaration is retained verbatim (ids + source)',
      parsed.pool.models[0]!.agentId === A && parsed.pool.models[0]!.modelId === MA && parsed.pool.models[0]!.source === 'user note');
  }
  const empty = parseUserModelPool({ policy: USER_MODEL_POOL_POLICY, models: [] });
  check('parser: an empty models array is accepted (deny-all, not an error)', empty.ok === true && empty.pool.models.length === 0);

  const badCases: Array<[string, unknown, string]> = [
    ['an unknown top-level field "approved"', { policy: USER_MODEL_POOL_POLICY, models: [], approved: true }, 'user-pool-unknown-field'],
    ['a separate "allowPaid" field', { policy: USER_MODEL_POOL_POLICY, models: [], allowPaid: true }, 'user-pool-unknown-field'],
    ['a separate "cost0" field', { policy: USER_MODEL_POOL_POLICY, models: [], cost0: true }, 'user-pool-unknown-field'],
    ['a separate URL field', { policy: USER_MODEL_POOL_POLICY, models: [], url: 'https://example' }, 'user-pool-unknown-field'],
    ['a wrong policy', { policy: 'free!', models: [] }, 'user-pool-policy-invalid'],
    ['models not an array', { policy: USER_MODEL_POOL_POLICY, models: {} }, 'user-pool-models-invalid'],
    ['an entry with an unknown field', { policy: USER_MODEL_POOL_POLICY, models: [{ agentId: A, modelId: MA, billing: 'free', source: 's', observedAt: 1, expiresAt: 2, approved: true }] }, 'user-pool-entry-unknown-field'],
    ['a blank agentId', { policy: USER_MODEL_POOL_POLICY, models: [{ agentId: '   ', modelId: MA, billing: 'free', source: 's', observedAt: 1, expiresAt: 2 }] }, 'user-pool-agent-invalid'],
    ['an agentId with a C0 control', { policy: USER_MODEL_POOL_POLICY, models: [{ agentId: 'a\u0000b', modelId: MA, billing: 'free', source: 's', observedAt: 1, expiresAt: 2 }] }, 'user-pool-agent-invalid'],
    ['a null modelId', { policy: USER_MODEL_POOL_POLICY, models: [{ agentId: A, modelId: null, billing: 'free', source: 's', observedAt: 1, expiresAt: 2 }] }, 'user-pool-model-invalid'],
    ['a wrong billing', { policy: USER_MODEL_POOL_POLICY, models: [{ agentId: A, modelId: MA, billing: 'cheap', source: 's', observedAt: 1, expiresAt: 2 }] }, 'user-pool-billing-invalid'],
    ['a blank source', { policy: USER_MODEL_POOL_POLICY, models: [{ agentId: A, modelId: MA, billing: 'free', source: '', observedAt: 1, expiresAt: 2 }] }, 'user-pool-source-invalid'],
    ['a negative observedAt', { policy: USER_MODEL_POOL_POLICY, models: [{ agentId: A, modelId: MA, billing: 'free', source: 's', observedAt: -1, expiresAt: 2 }] }, 'user-pool-observed-at-invalid'],
    ['a non-integer expiresAt', { policy: USER_MODEL_POOL_POLICY, models: [{ agentId: A, modelId: MA, billing: 'free', source: 's', observedAt: 1, expiresAt: 1.5 }] }, 'user-pool-expires-at-invalid'],
    ['expiresAt not AFTER observedAt', { policy: USER_MODEL_POOL_POLICY, models: [{ agentId: A, modelId: MA, billing: 'free', source: 's', observedAt: 5, expiresAt: 5 }] }, 'user-pool-expiry-not-after-observed'],
    ['a duplicate pair', { policy: USER_MODEL_POOL_POLICY, models: [
      { agentId: A, modelId: MA, billing: 'free', source: 's', observedAt: 1, expiresAt: 2 },
      { agentId: A, modelId: MA, billing: 'included', source: 's2', observedAt: 1, expiresAt: 2 },
    ] }, 'user-pool-duplicate-pair'],
    ['more than 32 entries', { policy: USER_MODEL_POOL_POLICY, models: Array.from({ length: 33 }, (_, i) => ({ agentId: A, modelId: `m${i}`, billing: 'free', source: 's', observedAt: 1, expiresAt: 2 })) }, 'user-pool-too-many-entries'],
    // Two DIFFERENT tuples that share the concatenated modelKey text: the parser refuses
    // the collision instead of keeping one identity for two pairs (collision-safe).
    ['two tuples sharing modelKey text', { policy: USER_MODEL_POOL_POLICY, models: [
      { agentId: 'agent-a::provider', modelId: 'm', billing: 'free', source: 's', observedAt: 1, expiresAt: 2 },
      { agentId: 'agent-a', modelId: 'provider::m', billing: 'free', source: 's', observedAt: 1, expiresAt: 2 },
    ] }, 'user-pool-duplicate-pair'],
  ];
  for (const [name, raw, code] of badCases) {
    const r = parseUserModelPool(raw);
    check(`parser: ${name} is refused (${code})`, r.ok === false && r.code === code, r.ok ? 'accepted' : r.code);
  }

  const oversize = parseUserModelPoolText('x'.repeat(USER_MODEL_POOL_MAX_BYTES + 1));
  check('text: over 32KiB is refused before JSON.parse', oversize.ok === false && oversize.code === 'user-pool-raw-too-large');
  const badJson = parseUserModelPoolText('{ not json');
  check('text: invalid JSON is refused', badJson.ok === false && badJson.code === 'user-pool-json-invalid');
}

section('B2.1 predicate: free/included admitted; paid/unknown/expired/future/wrong-agent refused');

{
  const now = 2_000;
  const pool = livePool(
    liveEntry(A, MA, { observedAt: 1_000, expiresAt: 3_000 }),
    liveEntry(B, MB, { billing: 'included', source: 'included-by-plan', observedAt: 1_000, expiresAt: 3_000 }),
  );
  const free = admitUserModelPoolPair(pool, { agentId: A, modelId: MA }, now);
  check('predicate: the exact free pair is admitted', free.allowed === true && free.entry.billing === 'free');
  check('predicate: the free pair keeps its provenance text', free.allowed === true && free.entry.source === 'b2.1 test declaration');
  const included = admitUserModelPoolPair(pool, { agentId: B, modelId: MB }, now);
  check('predicate: an "included" pair is admitted', included.allowed === true && included.entry.billing === 'included');

  const paid = admitUserModelPoolPair(livePool(liveEntry(A, MA, { billing: 'paid' })), { agentId: A, modelId: MA }, now);
  check('predicate: a "paid" declaration is refused', paid.allowed === false && paid.code === 'user-pool-billing-paid');
  const unknown = admitUserModelPoolPair(livePool(liveEntry(A, MA, { billing: 'unknown' })), { agentId: A, modelId: MA }, now);
  check('predicate: an "unknown" declaration is refused', unknown.allowed === false && unknown.code === 'user-pool-billing-unknown');
  const freeName = admitUserModelPoolPair(livePool(liveEntry(A, 'space-bunny-free', { billing: 'unknown', source: 'cost0' })), { agentId: A, modelId: 'space-bunny-free' }, now);
  check('predicate: a "-free" name + "cost0" source does NOT promote an unknown declaration', freeName.allowed === false && freeName.code === 'user-pool-billing-unknown');

  const future = admitUserModelPoolPair(livePool(liveEntry(A, MA, { observedAt: 2_500, expiresAt: 3_000 })), { agentId: A, modelId: MA }, now);
  check('predicate: a FUTURE observedAt is refused', future.allowed === false && future.code === 'user-pool-not-yet-observed');
  const expiredEq = admitUserModelPoolPair(livePool(liveEntry(A, MA, { observedAt: 1, expiresAt: 2_000 })), { agentId: A, modelId: MA }, now);
  check('predicate: expiry exactly equal to now is refused', expiredEq.allowed === false && expiredEq.code === 'user-pool-expired');
  const expired = admitUserModelPoolPair(livePool(liveEntry(A, MA, { observedAt: 1, expiresAt: 1_999 })), { agentId: A, modelId: MA }, now);
  check('predicate: an already-expired declaration is refused', expired.allowed === false && expired.code === 'user-pool-expired');

  const nullModel = admitUserModelPoolPair(pool, { agentId: A, modelId: null }, now);
  check('predicate: a null model is refused', nullModel.allowed === false && nullModel.code === 'user-pool-model-unselected');
  const emptyPool = admitUserModelPoolPair(livePool(), { agentId: A, modelId: MA }, now);
  check('predicate: an empty pool is deny-all', emptyPool.allowed === false && emptyPool.code === 'user-pool-empty');
  const wrongAgent = admitUserModelPoolPair(pool, { agentId: B, modelId: MA }, now);
  check('predicate: a declared model under ANOTHER agent is refused', wrongAgent.allowed === false && wrongAgent.code === 'user-pool-agent-mismatch');
  const outside = admitUserModelPoolPair(pool, { agentId: A, modelId: 'agent-a/not-declared' }, now);
  check('predicate: an undeclared pair is refused', outside.allowed === false && outside.code === 'user-pool-model-not-declared');
  const badNow = admitUserModelPoolPair(pool, { agentId: A, modelId: MA }, Number.NaN);
  check('predicate: a non-finite now is refused', badNow.allowed === false && badNow.code === 'user-pool-now-invalid');
}

section('B2.1 P1: tuple identity is BOTH fields, not the concatenated modelKey');

{
  // CODEX P1: {agentId:'agent-a::provider', modelId:'m'} previously ADMITTED the
  // different request {agentId:'agent-a', modelId:'provider::m'} because both share the
  // modelKey text "agent-a::provider::m". The predicate must compare both fields.
  const aliasPool = livePool(liveEntry('agent-a::provider', 'm'));
  const aliased = admitUserModelPoolPair(aliasPool, { agentId: A, modelId: 'provider::m' }, 1_000);
  check('P1: the alias declaration does NOT admit the different request tuple',
    aliased.allowed === false && aliased.code === 'user-pool-model-not-declared', aliased.allowed ? 'ADMITTED' : aliased.code);
  const exactPool = livePool(liveEntry(A, 'provider::m'));
  const exact = admitUserModelPoolPair(exactPool, { agentId: A, modelId: 'provider::m' }, 1_000);
  check('P1: the EXACT tuple (a model id containing "::") IS admitted', exact.allowed === true, exact.allowed ? '' : exact.code);
}

section('B2.1: a declaration never creates registry entries');

{
  const reg = new ModelRegistry();
  reg.upsert({ agentId: A, modelId: MA, provider: 't', taskTypes: ['implementation'] as never, modelSource: 't', quotaSource: 't' }, NOW);
  const before = reg.list().length;
  const parsed = parseUserModelPool({ policy: USER_MODEL_POOL_POLICY, models: [{ agentId: A, modelId: 'declared/only', billing: 'free', source: 's', observedAt: 1, expiresAt: 2 }] });
  const admitted = parsed.ok ? admitUserModelPoolPair(parsed.pool, { agentId: A, modelId: 'declared/only' }, 1) : null;
  check('B2.1: the declared pair IS admitted by the predicate', admitted !== null && admitted.allowed === true);
  check('B2.1: parsing + admitting added NO registry entry', reg.list().length === before, `before=${before} after=${reg.list().length}`);
  check('B2.1: the declared pair is absent from the registry', reg.list().every((e) => e.modelId !== 'declared/only'));
}

section('B2.1 Workbench: pool pairs only; exact pair reaches execution; no substitution');

{
  const h = makeHarness({ provider: stubProvider(`${B}\u0000${MB}`), modelPool: livePool(liveEntry(A, MA), liveEntry(B, MB)) });
  const { children, assigned } = await planAssign(h, specFor({ mode: 'fixed', agentId: A, modelId: MA }));
  check('WB: a pool-declared fixed pair is assigned', assigned.every((a) => a.ok), JSON.stringify(assigned));
  check('WB: the task identity is the exact declared pair', children[0]!.agentId === A && children[0]!.modelId === MA, identityOf(children));
  // The dispatch gate requires the task's own budget scope, exactly as production funds it.
  h.budgets.task(children[0]!.taskId, 100_000);
  const dispatched = await h.wb.dispatch();
  check('WB: the exact declared pair reaches the runtime',
    h.requests.length === 1 && h.requests[0]!.agentId === A && h.requests[0]!.model === MA,
    h.requests.map((r) => `${r.agentId}/${String(r.model)}`).join(','));
  check('WB: the dispatch was admitted', (dispatched.tick?.admitted.length ?? 0) === 1, JSON.stringify(dispatched.tick?.skipped));
}

{
  const h = makeHarness({ provider: stubProvider(`${A}\u0000${MA}`), modelPool: livePool(liveEntry(A, MA)) });
  const { children, assigned } = await planAssign(h, specFor({ mode: 'fixed', agentId: B, modelId: MB }));
  const outcome = assigned.find((a) => a.taskId === children[0]!.taskId);
  check('WB: a fixed pair OUTSIDE the pool is refused', outcome?.ok === false, JSON.stringify(outcome));
  check('WB: the refusal is a model-availability refusal, not a substitution', outcome?.code === 'no-model-available', String(outcome?.code));
  check('WB: the task identity was NOT substituted', children.every((c) => c.modelId === null || c.modelId === MB), identityOf(children));
  check('WB: nothing was dispatched for the refused pair', h.requests.length === 0);
}

{
  // Two declared pairs; a THIRD registered pair is deliberately NOT declared.
  const undeclared = 'agent-a/model-3';
  const prov = offeredProvider((offered) => offered[0]!);
  const h = makeHarness({
    provider: prov.provider,
    models: [[A, MA, ['implementation']], [B, MB, ['implementation']], [A, undeclared, ['implementation']]],
    modelPool: livePool(liveEntry(A, MA), liveEntry(B, MB)),
  });
  const { children, assigned } = await planAssign(h, specFor());
  check('WB: LAYA was offered EXACTLY the declared pairs (the undeclared one was never shown)',
    prov.offered.length >= 1 && prov.offered.every((keys) =>
      keys.length === 2 && keys.includes(initialCandidateKey(A, MA)) && keys.includes(initialCandidateKey(B, MB)) &&
      !keys.includes(initialCandidateKey(A, undeclared))),
    JSON.stringify(prov.offered));
  check('WB: the assigned pair is one LAYA was offered', assigned.every((a) => a.ok) && [MA, MB].includes(children[0]!.modelId!),
    identityOf(children));
}

{
  const prov = offeredProvider();
  const h = makeHarness({ provider: prov.provider, modelPool: livePool(liveEntry(A, MA)) });
  const { selections, assigned, children } = await planAssign(h, specFor());
  check('WB: exactly one declared pair is bound by the pool constraint, with its own provenance',
    selections.every((s) => s.ok && String(s.provider).startsWith(MODEL_POOL_CONSTRAINT_PROVENANCE)), JSON.stringify(selections));
  check('WB: LAYA was NOT asked a single-option question', prov.offered.length === 0, JSON.stringify(prov.offered));
  check('WB: the constraint pair is assigned', assigned.every((a) => a.ok) && children[0]!.modelId === MA, identityOf(children));
}

{
  const undeclared = 'agent-a/model-3';
  const prov = offeredProvider(() => initialCandidateKey(A, undeclared));
  const h = makeHarness({
    provider: prov.provider,
    models: [[A, MA, ['implementation']], [B, MB, ['implementation']], [A, undeclared, ['implementation']]],
    modelPool: livePool(liveEntry(A, MA), liveEntry(B, MB)),
  });
  const { assigned, selections } = await planAssign(h, specFor());
  check('WB: a FORGED provider answer to a non-offered pair is refused', selections.every((s) => s.ok === false), JSON.stringify(selections));
  check('WB: the forged answer did not become a substituted assignment', assigned.every((a) => a.ok === false), JSON.stringify(assigned));
  check('WB: no runtime dispatch happened for the forged answer', h.requests.length === 0);
}

{
  const h = makeHarness({ provider: stubProvider(`${A}\u0000${MA}`), modelPool: livePool(liveEntry(A, MA)) });
  const { children } = await planAssign(h, specFor());
  const child = children[0]!;
  const before = `${child.agentId}/${child.modelId}`;
  const swap = h.wb.reassignTask(child.taskId, B, MB, 'automatic handoff');
  check('WB: reassigning to a pair OUTSIDE the pool is refused', swap.ok === false, JSON.stringify(swap));
  const after = h.wb.store.get(child.taskId)!;
  check('WB: the task identity did not migrate', `${after.agentId}/${after.modelId}` === before, `${after.agentId}/${after.modelId}`);
  check('WB: no dispatch happened on the refused reassign', h.requests.length === 0);
}

{
  const h = makeHarness({ provider: stubProvider(`${A}\u0000${MA}`), quotaStatus: 'exhausted', modelPool: livePool(liveEntry(A, MA), liveEntry(B, MB)) });
  const { children, assigned } = await planAssign(h, specFor({ mode: 'fixed', agentId: A, modelId: MA }));
  const outcome = assigned.find((a) => a.taskId === children[0]!.taskId);
  check('WB: an exhausted quota still denies a declared pair', outcome?.ok === false && outcome?.code === 'quota-blocked', JSON.stringify(outcome));
  check('WB: the quota-denied task did not run', h.requests.length === 0);
}

{
  // P1 at the Assignment level: the registry holds an ORDINARY agent model whose id
  // legitimately contains "::". Only an ALIAS pool declaration exists, so the pair must
  // be denied; the exact declaration must still be allowed.
  const MODEL = 'provider::m';
  const aliasOnly = makeHarness({
    provider: stubProvider(`${A}\u0000${MODEL}`),
    models: [[A, MODEL, ['implementation']]],
    modelPool: livePool(liveEntry('agent-a::provider', 'm')),
  });
  const a = await planAssign(aliasOnly, specFor({ mode: 'fixed', agentId: A, modelId: MODEL }));
  const aliasOutcome = a.assigned.find((x) => x.taskId === a.children[0]!.taskId);
  check('P1 assignment: an alias-only pool does NOT admit the registered "agent-a/provider::m"',
    aliasOutcome?.ok === false && aliasOutcome?.code === 'no-model-available', JSON.stringify(aliasOutcome));
  check('P1 assignment: nothing ran for the alias mismatch', aliasOnly.requests.length === 0);

  const exact = makeHarness({
    provider: stubProvider(`${A}\u0000${MODEL}`),
    models: [[A, MODEL, ['implementation']]],
    modelPool: livePool(liveEntry(A, MODEL)),
  });
  const b = await planAssign(exact, specFor({ mode: 'fixed', agentId: A, modelId: MODEL }));
  check('P1 assignment: the exact declaration DOES admit "agent-a/provider::m"',
    b.assigned.every((x) => x.ok) && b.children[0]!.modelId === MODEL, JSON.stringify(b.assigned));
}

section('B2.1 dispatch recheck: a declaration that expires after assignment refuses the real tick');

{
  const realNow = Date.now;
  const t0 = Date.now();
  const h = makeHarness({
    provider: stubProvider(`${A}\u0000${MA}`),
    modelPool: livePool(liveEntry(A, MA, { observedAt: t0 - 10_000, expiresAt: t0 + 3_600_000 })),
  });
  const { children, assigned } = await planAssign(h, specFor({ mode: 'fixed', agentId: A, modelId: MA }));
  check('dispatch: assignment succeeded while the declaration was valid', assigned.every((a) => a.ok), JSON.stringify(assigned));
  check('dispatch: no run happened before the tick', h.requests.length === 0);
  // Fund the task so the ONLY denial at dispatch is the expired pool declaration.
  h.budgets.task(children[0]!.taskId, 100_000);
  let dispatched: Awaited<ReturnType<NativeWorkbench['dispatch']>> | null = null;
  try {
    // Advance the GATE's clock only: the workbench captured the ORIGINAL Date.now, so
    // assignment still saw a valid declaration while the real dispatch recheck does not.
    Date.now = () => t0 + 7_200_000;
    dispatched = await h.wb.dispatch();
  } finally {
    Date.now = realNow;
  }
  const childId = children[0]!.taskId;
  const refusal = (dispatched?.tick?.skipped ?? []).find((s) => s.taskId === childId);
  const attempts = h.wb.evidence.history(childId);
  check('dispatch: the expired declaration produced ZERO runtime runs', h.requests.length === 0, `requests=${h.requests.length}`);
  check('dispatch: NO onStart fired (no session was marked running)', (dispatched?.sessionsTouched.length ?? 0) === 0, JSON.stringify(dispatched?.sessionsTouched ?? []));
  check('dispatch: NO execution Attempt was falsely created', attempts.length === 0, `attempts=${attempts.length}`);
  check('dispatch: the tick refused the task', refusal !== undefined, JSON.stringify(dispatched?.tick?.skipped ?? []));
  check('dispatch: the refusal reason names the user-pool expiry rule',
    refusal !== undefined && refusal.reason.includes('user-pool-expired'), String(refusal?.reason));
  check('dispatch: the refusal rides the gate model-unavailable path', refusal?.code === 'model-unavailable', String(refusal?.code));
}

section('B2.1 CLI: refusals cost ZERO calls; a valid sequential round finishes with an honest report');

// Capture stdout+stderr so a refusal prints nothing into the suite output.
async function captureRun(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = '';
  let err = '';
  process.stdout.write = ((c: string | Uint8Array): boolean => { out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8'); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array): boolean => { err += typeof c === 'string' ? c : Buffer.from(c).toString('utf8'); return true; }) as typeof process.stderr.write;
  try {
    return { code: await fn(), out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

const probeForCli = (agentId: string): QuotaProbe => ({
  agentId, provider: agentId,
  records: [{ provider: agentId, agentId, modelId: null, source: 'locally_observed', usage: null, remaining: null, resetAt: null, period: 'day', status: 'available', usageClass: 'observed', confidence: 'high', observedAt: Date.now(), note: '' }],
  login: 'stubbed for test', version: '0.0.0-test', modelHint: `${agentId}/m1`, providerHint: null, error: null,
} as unknown as QuotaProbe);

{
  const dir = ownDir('b21-cli-');
  const write = (name: string, text: string): string => { const p = join(dir, name); writeFileSync(p, text); return p; };
  const cases: Array<[string, string[], string]> = [
    ['a missing value', ['do something', '--workflow', 'sequential', '--model-pool'], 'requires a file path'],
    ['without --workflow', ['do something', '--model-pool', 'x.json'], 'requires --workflow sequential or --workflow collaborate'],
    ['with --classify-only', ['do something', '--workflow', 'sequential', '--classify-only', '--model-pool', 'x.json'], 'cannot be combined with --classify-only'],
    ['an unreadable file', ['do something', '--workflow', 'sequential', '--model-pool', join(dir, 'missing.json')], 'not a readable file'],
    ['a malformed file', ['do something', '--workflow', 'sequential', '--model-pool', write('bad.json', '{ not json')], 'not valid JSON'],
    ['a schema-bad file', ['do something', '--workflow', 'sequential', '--model-pool', write('schema.json', JSON.stringify({ policy: 'free', models: [] }))], 'policy must be'],
    ['an oversize file', ['do something', '--workflow', 'sequential', '--model-pool', write('oversize.json', 'x'.repeat(USER_MODEL_POOL_MAX_BYTES + 1))], '32768 byte'],
  ];
  for (const [name, argv, needle] of cases) {
    let calls = 0;
    const stub = {
      descriptors: () => { calls++; return []; },
      agentIds: () => { calls++; return []; },
      configFor: () => { calls++; return {}; },
    } as never;
    const res = await captureRun(() => runRoundCli(stub, argv, {}));
    check(`CLI: ${name} is refused with exit 2`, res.code === 2, String(res.code));
    check(`CLI: ${name} names the rule (${needle})`, `${res.err} ${res.out}`.includes(needle), (res.err + res.out).slice(0, 160));
    check(`CLI: ${name} caused ZERO runtime calls`, calls === 0, `calls=${calls}`);
  }
}

async function b21Round(opts: { pool: boolean; json: boolean }): Promise<{ code: number; out: string; err: string; requests: RunRequest[]; report: Record<string, unknown>; dir: string }> {
  const dir = ownDir('b21-round-');
  const reportDir = join(ownDir('b21-rep-'), 'reports');
  const requests: RunRequest[] = [];
  const REVIEW_VERDICT_JSON = JSON.stringify({ verdict: 'pass', reason: 'fixture reviewer', findings: [], recommendedAction: 'none', reviewer: 'fixture-codex', reviewedAt: 1 });
  const runtime = new RuntimeOrch({
    config: { agents: {} } as never,
    storeDir: join(dir, '.store'),
    replaceAdapters: [
      createFakeAdapter({ id: A, capabilities: { newTask: true, review: true, modelSelection: true, cwd: true, resume: true } as never, script: [{ kind: 'exit', code: 0 }] }),
      createFakeAdapter({ id: 'codex', capabilities: { newTask: true, review: true, modelSelection: true, cwd: true, resume: true } as never, script: [{ kind: 'frame', text: REVIEW_VERDICT_JSON, data: { text: REVIEW_VERDICT_JSON } }, { kind: 'exit', code: 0 }] }),
    ],
  });
  const store = runtime.store;
  let runN = 0;
  const drivable = {
    agentIds: () => [A],
    descriptors: () => [A].map((id) => ({ id, displayName: id, launcher: 'fake', transport: 'cli-jsonl', capabilities: { newTask: true, review: true, modelSelection: true, cwd: true, resume: true } } as never)),
    configFor: () => ({}),
    store,
    review: (req: Omit<RunRequest, 'mode'>) => runtime.review(req),
    run(req: RunRequest): RunHandle {
      requests.push(req);
      runN += 1;
      const role = /^Task \S+ \((\w+)\)/m.exec(req.prompt)?.[1] ?? /:: (\w+) — deliverable:/.exec(req.prompt)?.[1] ?? 'unknown';
      const result: RunResult = {
        taskId: `t${runN}`, threadId: null, agentId: req.agentId, state: 'succeeded',
        startedAt: Date.now(), endedAt: Date.now(), exitCode: 0, signal: null,
        output: `B21_OUT_${runN}: ${role} deliverable produced`, outputTruncated: false, transcriptPath: null,
        usage: {}, toolCalls: [], error: null, diagnostics: [],
        cleanup: { rootKilled: false, descendantsReaped: false, note: '', treeStopConfirmed: true, processStart: 'started' },
      };
      return { result: async () => result } as unknown as RunHandle;
    },
  };
  const provider: DecisionProvider = {
    name: 'b21-cli-seam',
    async probe() { return { ok: true, endpoint: 'seam://laya', detail: 'test seam', warnings: [] }; },
    async decide(request: DecisionRequest) {
      const answers: Record<string, unknown> = {};
      const pickAnswer = (q: { criteria?: unknown }, value: string, parameters: Record<string, string> = {}): Record<string, unknown> => {
        const offered = Object.keys((q.criteria ?? {}) as Record<string, string>);
        const probabilities: Record<string, number> = {};
        for (const o of offered) probabilities[o] = o === value ? 1 : 0;
        return { type: 'choice', choice: value, probabilities, confidence: 1, parameters };
      };
      for (const [key, q] of Object.entries(request.questions)) {
        if (key === ORCHESTRATION_ACTION_ID) {
          const state = JSON.parse(String((request.state as Record<string, string> | undefined)?.[ORCHESTRATION_ACTION_ID] ?? '{}')) as { tasks?: Array<{ taskId: string; status: string }> };
          const tasks = state.tasks ?? [];
          const toVerify = tasks.find((t) => t.status === 'to_verify');
          const planned = tasks.find((t) => t.status === 'planned' || t.status === 'queued');
          let action = 'wait';
          const parameters: Record<string, string> = {};
          const rawMaterial = (request.state as Record<string, string> | undefined)?.[ACCEPTANCE_MATERIAL_FIELD];
          if (toVerify !== undefined && rawMaterial !== undefined) {
            const material = JSON.parse(rawMaterial) as { objective: string; entries: Array<{ taskId: string; acceptanceCriteria: string; output: string; executionMissing: boolean }> };
            const entry = material.entries.find((e) => e.taskId === toVerify.taskId);
            const role = entry === undefined ? '' : ((entry.acceptanceCriteria.split(':: ')[1] ?? '').split(' —')[0] ?? '');
            if (entry !== undefined && !entry.executionMissing && entry.output.trim() !== '' && entry.output.includes(role)) {
              action = 'complete';
              parameters.taskId = entry.taskId;
              parameters.reason = 'its own output shows its own deliverable';
            }
          } else if (toVerify === undefined && planned !== undefined) {
            action = 'continue';
          }
          answers[key] = pickAnswer(q, action, parameters);
          continue;
        }
        if (key === WORKFLOW_PLAN_ID) { answers[key] = pickAnswer(q, 'lean'); continue; }
        if (key === INITIAL_AGENT_MODEL_ID) {
          const offered = Object.keys((q.criteria ?? {}) as Record<string, string>);
          answers[key] = pickAnswer(q, offered[0]!);
          continue;
        }
        if (q.type === 'choice') {
          const offered = Object.keys((q.criteria ?? {}) as Record<string, string>);
          answers[key] = pickAnswer(q, offered[0]!);
          continue;
        }
        if (q.type === 'score') {
          const levels = q.criteria as string[];
          const index = Math.max(0, levels.indexOf('small'));
          const probabilities: Record<string, number> = {};
          for (let i = 0; i < levels.length; i++) probabilities[String(i)] = i === index ? 1 : 0;
          const legend: Record<string, string> = {};
          for (let i = 0; i < levels.length; i++) legend[String(i)] = levels[i]!;
          answers[key] = { type: 'score', score: index, level: levels[index]!, levels: [...levels], probabilities, legend, confidence: 1 };
          continue;
        }
        answers[key] = { type: q.type };
      }
      return { answers, provider: { name: 'b21-cli-seam', details: 'stub Laya' }, raw: {} } as never;
    },
  };
  const poolPath = join(dir, 'pool.json');
  writeFileSync(poolPath, JSON.stringify({
    policy: USER_MODEL_POOL_POLICY,
    models: [{ agentId: A, modelId: `${A}/m1`, billing: 'free', source: 'b2.1 cli fixture', observedAt: 1, expiresAt: Number.MAX_SAFE_INTEGER }],
  }), 'utf8');
  const argv = [
    'add a retry to the http client',
    ...(opts.json ? ['--json'] : []),
    '--cwd', dir, '--agent', A, '--max-children', '1', '--max-concurrent', '1',
    '--workflow', 'sequential', '--workflow-choice', 'lean',
    ...(opts.pool ? ['--model-pool', poolPath] : []),
  ];
  const res = await captureRun(() => runRoundCli(drivable as never, argv, { provider, probes: [probeForCli(A)], roundResultDir: reportDir }));
  const jsonStart = res.out.indexOf('{');
  let report: Record<string, unknown> = {};
  if (jsonStart !== -1) { try { report = JSON.parse(res.out.slice(jsonStart)) as Record<string, unknown>; } catch { report = {}; } }
  return { ...res, requests, report, dir };
}

{
  const withPool = await b21Round({ pool: true, json: true });
  check('CLI round: the opt-in sequential chain finished (exit 0)', withPool.code === 0, `${withPool.code}: ${withPool.err.slice(0, 200)}`);
  check('CLI round: the declared pair reached every run',
    withPool.requests.length === 2 && withPool.requests.every((r) => r.agentId === A && r.model === `${A}/m1`),
    withPool.requests.map((r) => `${r.agentId}/${String(r.model)}`).join(','));
  const mp = withPool.report.modelPool as Record<string, unknown> | undefined;
  check('CLI round: report.modelPool is present when the flag opted in', mp !== undefined, JSON.stringify(Object.keys(withPool.report)));
  if (mp !== undefined) {
    check('CLI round: the report states the policy', mp.policy === USER_MODEL_POOL_POLICY, JSON.stringify(mp.policy));
    check('CLI round: the report scopes the pool to THIS round\'s orchestrator-managed runs',
      typeof mp.scope === 'string' && String(mp.scope).includes('orchestrator-managed'), String(mp.scope));
    const unsupported = mp.unsupported as Record<string, string> | undefined;
    check('CLI round: the report refuses paid authorization explicitly',
      unsupported !== undefined && String(unsupported.paid).includes('NO paid use'), JSON.stringify(unsupported));
    check('CLI round: the report refuses to claim verified free/account eligibility',
      unsupported !== undefined && /NOT verified/.test(String(unsupported.cost)), JSON.stringify(unsupported));
    check('CLI round: the report refuses a whole-workflow-free claim',
      unsupported !== undefined && String(unsupported.wholeWorkflow).includes('small_model'), JSON.stringify(unsupported));
    const entries = mp.entries as Array<Record<string, unknown>> | undefined;
    check('CLI round: each declaration reports provenance, timestamps and its current eligibility',
      Array.isArray(entries) && entries.length === 1 && entries[0]!.source === 'b2.1 cli fixture' &&
      entries[0]!.observedAt === 1 && typeof entries[0]!.expiresAt === 'number' &&
      (entries[0]!.eligibility as { allowed?: boolean } | undefined)?.allowed === true,
      JSON.stringify(entries));
  }

  const noPool = await b21Round({ pool: false, json: true });
  check('CLI round: a round WITHOUT the flag still finishes (exit 0)', noPool.code === 0, `${noPool.code}: ${noPool.err.slice(0, 200)}`);
  check('CLI round: a round WITHOUT the flag reports NO modelPool field', !('modelPool' in noPool.report), JSON.stringify(Object.keys(noPool.report)));

  const human = await b21Round({ pool: true, json: false });
  check('CLI round: the HUMAN report prints the pool block when opted in',
    human.out.includes('MODEL POOL') && human.out.includes('authorizes NO paid use'), human.out.slice(human.out.indexOf('MODEL POOL'), human.out.indexOf('MODEL POOL') + 200));
  check('CLI round: the human block states it is not verified eligibility',
    human.out.includes('NOT verified'), human.out.slice(human.out.indexOf('MODEL POOL'), human.out.indexOf('MODEL POOL') + 400));
}

// =========================================================================

for (const d of tmpDirs) removeOwnedDir(d);

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
if (cleanupFailures.length) process.stdout.write(`cleanup failures (must fail the test):\n  ${cleanupFailures.map((f) => `- ${f}`).join('\n  ')}\n`);
process.stdout.write('\n');
process.exitCode = failed === 0 && cleanupFailures.length === 0 ? 0 : 1;
