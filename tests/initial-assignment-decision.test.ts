/**
 * tests/initial-assignment-decision.test.ts — TeamRun T2-a.1.
 *
 * WHAT IS FROZEN HERE
 * -------------------
 *   Planner output -> Task -> LAYA PROVIDER INVOCATION -> validated pair
 *                 -> Assignment exact enforcement -> SessionRegistry -> Worker
 *
 * Every initial-selection test goes through the REAL production wiring
 * (`plan` -> `selectInitialAssignment` -> `assignChildren`). None of them calls
 * `assignWorker({explicitPair})` directly, because that bypasses Laya entirely and is
 * exactly the gap this round closes.
 *
 * The fake provider is a `DecisionProvider` stub answering the existing Decision Layer
 * contract — the same seam `routing.ts` and the post-result loop already use. No second
 * decision model and no new provider were introduced.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NativeWorkbench } from '../src/orchestration/workbench.ts';
import { Orchestrator } from '../src/orchestration/orchestrator.ts';
import { TaskScheduler } from '../src/orchestration/scheduler.ts';
import { ModelRegistry } from '../src/quota/registry.ts';
import { BudgetManager } from '../src/quota/budget.ts';
import { assignWorker, validateAgentModelIntent } from '../src/orchestration/assignment.ts';
import { validateDecision } from '../src/orchestration/decision.ts';
import { initialCandidateKey, INITIAL_AGENT_MODEL_ID } from '../src/decision/initial-assignment.ts';
import { observeTasks } from '../src/orchestration/observation.ts';
import type { AgentDescriptor } from '../src/core/types.ts';
import type { QuotaRecord, TaskType } from '../src/quota/types.ts';
import type { DecisionProvider, DecisionRequest } from '../src/decision/types.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; process.stdout.write(`  ok   ${name}\n`); }
  else { failed++; failures.push(name); process.stdout.write(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}\n`); }
};

const NOW = 1_700_000_000_000;
const AGENT = 'opencode';
const OTHER = 'workbuddy-intl';
const WB_CN = 'workbuddy-cn';
const MODEL_A = 'model-a';
const MODEL_B = 'model-b';
const impl: TaskType = 'implementation';

const descriptor = (id: string): AgentDescriptor => ({
  id, displayName: id, launcher: 'fake', transport: 'cli-jsonl',
  capabilities: { newTask: true, review: true, modelSelection: true, resume: true },
} as unknown as AgentDescriptor);
const statusRow = (agent: string) => ({ agent, version: '1', installed: 'Yes', login: 'n/a', quotaSource: 't', usage: 'n/a', status: 'ok' });
const quotaRecord = (agentId: string): QuotaRecord => ({
  provider: agentId, agentId, modelId: null, source: 'locally_observed', usage: null, remaining: null,
  resetAt: null, period: 'day', status: 'available', usageClass: 'observed', confidence: 'high', observedAt: NOW, note: '',
} as never);

const FAMILIES = [AGENT, OTHER, WB_CN] as const;
/** Registry seeded the way T1-a expects: both models on opencode, one on each WorkBuddy. */
function seededRegistry(opts: { unavailable?: string[] } = {}): ModelRegistry {
  const reg = new ModelRegistry();
  const rows: Array<[string, string]> = [
    [AGENT, MODEL_A], [AGENT, MODEL_B],
    [OTHER, MODEL_A], [WB_CN, MODEL_A],
  ];
  for (const [agentId, modelId] of rows) {
    reg.upsert({ agentId, modelId, provider: 'test', taskTypes: [impl], modelSource: 'test', quotaSource: 'test' }, NOW);
  }
  for (const a of FAMILIES) reg.setAgentAvailability(a, 'available');
  for (const key of opts.unavailable ?? []) {
    const [agentId, modelId] = key.split('::');
    reg.setModelAvailability(agentId, modelId, 'unavailable');
  }
  return reg;
}

/**
 * A `DecisionProvider` stub that answers the initial-assignment question with one choice.
 * `raw` lets a test return something MALFORMED on purpose, and `throwOnDecide` makes the
 * provider unavailable — both are refusals, never silent fallbacks.
 */
function pairProvider(choice: string | null, opts: { raw?: unknown; throws?: boolean } = {}): DecisionProvider {
  return {
    name: 'fake-laya',
    probe: async () => ({ available: true } as never),
    decide: async (req: DecisionRequest) => {
      if (opts.throws === true) throw new Error('laya unavailable');
      if (opts.raw !== undefined) return opts.raw as never;
      const id = req.questions === undefined ? INITIAL_AGENT_MODEL_ID : Object.keys(req.questions)[0]!;
      const picked = choice ?? 'none';
      return {
        answers: { [id]: { type: 'choice', choice: picked, probabilities: { [picked]: 1 }, confidence: 1, criteria: {} } },
        provider: { name: 'fake-laya', model: 'fake', wallTimeMs: 1, conditions: [] } as never,
        raw: {},
      } as never;
    },
  } as unknown as DecisionProvider;
}

/** A workbench on the Laya-controlled production path, or the legacy path when no provider. */
function makeWorkbench(opts: { provider?: DecisionProvider; unavailable?: string[] } = {}): { wb: NativeWorkbench; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 't2a1-'));
  const registry = seededRegistry({ unavailable: opts.unavailable });
  const budgets = new BudgetManager(10_000_000);
  for (const id of ['r', 'r-s1', 'r-c1', 'r-d1']) budgets.task(id, 100_000);
  for (const a of FAMILIES) budgets.agent(a, 10_000_000);
  const gateRegistry = new ModelRegistry();
  for (const [agentId, modelId] of [[AGENT, MODEL_A], [AGENT, MODEL_B], [OTHER, MODEL_A], [WB_CN, MODEL_A]] as const) {
    gateRegistry.upsert({ agentId, modelId, provider: 'test', taskTypes: [impl], modelSource: 'test', quotaSource: 'test' }, NOW);
  }
  for (const a of FAMILIES) gateRegistry.setAgentAvailability(a, 'available');
  const orch = new Orchestrator({
    gate: {
      descriptors: FAMILIES.map((a) => descriptor(a)),
      agentStatus: FAMILIES.map((a) => statusRow(a)),
      quotaRecords: FAMILIES.map((a) => quotaRecord(a)),
      registry: gateRegistry,
      budgets,
      taskType: impl,
      requestedUnits: 10,
      currentConcurrency: 0,
      maxConcurrency: 4,
      maxChildren: 8,
      maxConcurrentAgents: 4,
    } as never,
    now: () => NOW,
    runtime: { run: (): never => { throw new Error('dispatch is not exercised here'); } },
    defaultCwd: dir,
  });
  const wb = new NativeWorkbench({
    orchestrator: orch,
    scheduler: new TaskScheduler({ orchestrator: orch, cwd: dir }),
    registry,
    quotaRecords: FAMILIES.map((a) => quotaRecord(a)),
    cwd: dir,
    ...(opts.provider === undefined ? {} : { decisionProvider: opts.provider }),
  });
  return { wb, dir, cleanup: () => { rmSync(dir, { recursive: true, force: true }); } };
}

/** Plan -> Laya -> Assignment, the real production order. */
async function productionInitialFlow(
  wb: NativeWorkbench,
  spec: Parameters<NativeWorkbench['assignChildren']>[1],
): Promise<{ assigned: ReturnType<NativeWorkbench['assignChildren']>; rootId: string }> {
  const planned = wb.plan(spec);
  const rootId = planned.root.taskId;
  await wb.selectInitialAssignment(rootId);
  const assigned = wb.assignChildren(rootId, spec);
  return { assigned, rootId };
}

const spec = (): Parameters<NativeWorkbench['assignChildren']>[1] =>
  ({ taskId: 'r', objective: 'do the thing', taskType: impl, shape: 'single', budgetUnits: 10 } as never);

// ===========================================================================
process.stdout.write('\n== T2A1-1: a REAL initial Laya selection drives the first assignment ==\n');
{
  const { wb, cleanup } = makeWorkbench({ provider: pairProvider(initialCandidateKey(AGENT, MODEL_A)) });
  const { assigned } = await productionInitialFlow(wb, spec());
  const child = wb.store.get('r-s1');
  check('T2A1-1: the task was assigned', assigned.length === 1 && assigned[0]!.ok, JSON.stringify(assigned));
  check('T2A1-1: to the EXACT pair Laya chose', child?.agentId === AGENT && child?.modelId === MODEL_A,
    `${child?.agentId}/${child?.modelId}`);
  const rec = wb.initialSelectionRecords()[0];
  check('T2A1-1: the decision is recorded as Laya-decided (not a spec pair)',
    rec !== undefined && rec.ok === true && rec.provider === 'fake-laya', JSON.stringify(rec));
  cleanup();
}

// ===========================================================================
process.stdout.write('\n== T2A1-2: Laya\'s choice beats Assignment scoring ==\n');
{
  // Both pairs are viable. Laya names model-A; Assignment's own ranking is not consulted,
  // because an exact pair is enforced, never scored against.
  const { wb, cleanup } = makeWorkbench({ provider: pairProvider(initialCandidateKey(AGENT, MODEL_A)) });
  const { assigned } = await productionInitialFlow(wb, spec());
  const child = wb.store.get('r-s1');
  check('T2A1-2: Laya\'s pair is the one assigned', assigned[0]?.ok === true && child?.modelId === MODEL_A,
    `${child?.agentId}/${child?.modelId}`);
  check('T2A1-2: no silent substitution happened', child?.modelId !== MODEL_B, String(child?.modelId));
  cleanup();
}

// ===========================================================================
process.stdout.write('\n== T2A1-3: the chosen pair is unavailable -> refuse, never substitute ==\n');
{
  const { wb, cleanup } = makeWorkbench({
    provider: pairProvider(initialCandidateKey(AGENT, MODEL_A)),
    unavailable: [`${AGENT}::${MODEL_A}`],
  });
  const { assigned } = await productionInitialFlow(wb, spec());
  const child = wb.store.get('r-s1');
  check('T2A1-3: the initial assignment was REFUSED', assigned[0]?.ok === false, JSON.stringify(assigned[0]));
  check('T2A1-3: NO other model was silently chosen', child?.agentId === null || child?.modelId === null,
    `${child?.agentId}/${child?.modelId}`);
  check('T2A1-3: the sibling model was never assigned instead of the refused one',
    child?.modelId !== MODEL_B, String(child?.modelId));
  cleanup();
}

// ===========================================================================
process.stdout.write('\n== T2A1-4: a MALFORMED initial pair fails closed ==\n');
for (const [label, choice] of [['agent only', AGENT], ['model only', MODEL_A]] as const) {
  const { wb, cleanup } = makeWorkbench({ provider: pairProvider(choice) });
  const { assigned } = await productionInitialFlow(wb, spec());
  const rec = wb.initialSelectionRecords()[0];
  check(`T2A1-4 (${label}): the decision is REFUSED, not repaired`, rec !== undefined && rec.ok === false,
    JSON.stringify(rec));
  check(`T2A1-4 (${label}): assignment failed rather than falling back to scoring`,
    assigned[0]?.ok === false, JSON.stringify(assigned[0]));
// `plan()` already seeds a child agentId, so the discriminator for "Assignment bound a
    // pair" is the MODEL: Assignment never writes one when it refuses.
    check(`T2A1-4 (${label}): no pair was bound (Assignment never wrote a model)`, wb.store.get('r-s1')?.modelId === null,
      String(wb.store.get('r-s1')?.modelId));
  cleanup();
}

// ===========================================================================
process.stdout.write('\n== T2A1-5: an UNKNOWN model is refused ==\n');
{
  const { wb, cleanup } = makeWorkbench({ provider: pairProvider(initialCandidateKey(AGENT, 'does-not-exist')) });
  const { assigned } = await productionInitialFlow(wb, spec());
  const rec = wb.initialSelectionRecords()[0];
  check('T2A1-5: a pair that was never offered is refused', rec !== undefined && rec.ok === false, JSON.stringify(rec));
  check('T2A1-5: assignment failed', assigned[0]?.ok === false, JSON.stringify(assigned[0]));
  cleanup();
}

// ===========================================================================
process.stdout.write('\n== T2A1-6: same Agent, two possible models ==\n');
for (const modelId of [MODEL_A, MODEL_B]) {
  const { wb, cleanup } = makeWorkbench({ provider: pairProvider(initialCandidateKey(AGENT, modelId)) });
  await productionInitialFlow(wb, spec());
  const child = wb.store.get('r-s1');
  check(`T2A1-6: Laya produced ${AGENT}/${modelId}`, child?.agentId === AGENT && child?.modelId === modelId,
    `${child?.agentId}/${child?.modelId}`);
  cleanup();
}

// ===========================================================================
process.stdout.write('\n== T2A1-7: WorkBuddy CN and Intl stay distinct ==\n');
for (const family of [WB_CN, OTHER]) {
  const { wb, cleanup } = makeWorkbench({ provider: pairProvider(initialCandidateKey(family, MODEL_A)) });
  await productionInitialFlow(wb, spec());
  const child = wb.store.get('r-s1');
  check(`T2A1-7: Laya produced ${family}/${MODEL_A}`, child?.agentId === family && child?.modelId === MODEL_A,
    `${child?.agentId}/${child?.modelId}`);
  cleanup();
}
{
  // Both WorkBuddy identities share a model id and must not collide in the answer space.
  const { wb, cleanup } = makeWorkbench({ provider: pairProvider(initialCandidateKey(WB_CN, MODEL_A)) });
  await productionInitialFlow(wb, spec());
  check('T2A1-7: the CN choice did not resolve to Intl', wb.store.get('r-s1')?.agentId === WB_CN,
    String(wb.store.get('r-s1')?.agentId));
  cleanup();
}

// ===========================================================================
process.stdout.write('\n== T2A1-8: low-level legacy scoring still works ==\n');
{
  // §9: assignWorker with NO explicit pair is the backward-compatible low-level path.
  // Assignment's scoring was NOT removed, and this proves it.
  const registry = seededRegistry();
  const budgets = new BudgetManager(10_000_000);
  budgets.task('legacy-1', 100_000);
  for (const a of FAMILIES) budgets.agent(a, 10_000_000);
  const evidence = new (await import('../src/orchestration/attempt-store.ts')).AttemptStore();
  const out = assignWorker({
    taskId: 'legacy-1',
    taskType: impl,
    registry,
    quotaRecords: FAMILIES.map((a) => quotaRecord(a)),
    evidence,
  });
  check('T2A1-8: no explicit pair still assigns via Assignment scoring', out.ok === true,
    out.ok ? `${out.chosen.candidate.agentId}/${out.chosen.candidate.modelId}` : `${out.code} ${out.reason}`);
}

// ===========================================================================
process.stdout.write('\n== T2A1-9: the production path never silently degrades to legacy ==\n');
{
  // Provider UNAVAILABLE (throws). The task must fail closed, not be quietly scored.
  const { wb, cleanup } = makeWorkbench({ provider: pairProvider(null, { throws: true }) });
  const { assigned } = await productionInitialFlow(wb, spec());
  const rec = wb.initialSelectionRecords()[0];
  check('T2A1-9: an unavailable provider is recorded as a refusal', rec !== undefined && rec.ok === false, JSON.stringify(rec));
  check('T2A1-9: the task is REFUSED, not scored by Assignment', assigned[0]?.ok === false, JSON.stringify(assigned[0]));
  check('T2A1-9: no pair was bound (Assignment never wrote a model)', wb.store.get('r-s1')?.modelId === null, String(wb.store.get('r-s1')?.modelId));
  cleanup();
}
{
  // Also: calling assignChildren WITHOUT running selection on a Laya-controlled workbench
  // is a wiring fault and is refused rather than quietly answered by scoring.
  const { wb, cleanup } = makeWorkbench({ provider: pairProvider(initialCandidateKey(AGENT, MODEL_A)) });
  wb.plan(spec());
  const assigned = wb.assignChildren('r', spec());
  check('T2A1-9: skipping initial selection on a Laya-controlled workbench is refused',
    assigned[0]?.ok === false, JSON.stringify(assigned[0]));
  cleanup();
}

// ===========================================================================
process.stdout.write('\n== T2A1-10/11/12: Laya reassign pair atomicity ==\n');
{
  const { wb, cleanup } = makeWorkbench();
  // The tasks must EXIST before a decision can be validated against them.
  wb.plan(spec());
  const observation = () => observeTasks(wb.store, { now: NOW }) as never;

  // 10: a full pair is valid.
  let ok10 = true;
  let err10 = '';
  try {
    validateDecision({ action: 'reassign', taskId: 'r-s1', agentId: OTHER, modelId: MODEL_B }, observation());
  } catch (e) { ok10 = false; err10 = (e as Error).message; }
  check('T2A1-10: a FULL pair reassign is still valid', ok10, err10.slice(0, 140));

  // 11: agent only.
  let ok11 = true;
  let err11 = '';
  try {
    validateDecision({ action: 'reassign', taskId: 'r-s1', agentId: OTHER }, observation());
  } catch (e) { ok11 = false; err11 = (e as Error).message; }
  check('T2A1-11: an agent-ONLY reassign is refused', !ok11 && err11.includes('ATOMIC'), err11.slice(0, 160));

  // 12: model only.
  let ok12 = true;
  let err12 = '';
  try {
    validateDecision({ action: 'reassign', taskId: 'r-s1', modelId: MODEL_B }, observation());
  } catch (e) { ok12 = false; err12 = (e as Error).message; }
  check('T2A1-12: a model-ONLY reassign is refused', !ok12 && err12.includes('ATOMIC'), err12.slice(0, 160));

  // §14/§15: the delegation mode is a DIFFERENT, already-named meaning and must survive.
  let okDelegate = true;
  let errDelegate = '';
  try {
    validateDecision({ action: 'reassign', taskId: 'r-s1', strategy: 'assignment' }, observation());
  } catch (e) { okDelegate = false; errDelegate = (e as Error).message; }
  check('T2A1-12: explicit strategy:"assignment" delegation is NOT broken', okDelegate, errDelegate.slice(0, 140));

  let okDelegate2 = true;
  try {
    validateDecision({ action: 'reassign', taskId: 'r-s1', agentId: OTHER, strategy: 'assignment' }, observation());
  } catch (e) { okDelegate2 = false; }
  check('T2A1-12: delegation may still name a partial target (legacy low-level meaning)', okDelegate2);
  cleanup();
}

// ===========================================================================
process.stdout.write('\n== T2A1-13: the T1 session path is untouched ==\n');
{
  const { wb, cleanup } = makeWorkbench({ provider: pairProvider(initialCandidateKey(AGENT, MODEL_A)) });
  await productionInitialFlow(wb, spec());
  const session = wb.sessionForTask('r-s1');
  check('T2A1-13: the session came from SessionRegistry, downstream of Assignment', session !== null);
  check('T2A1-13: and it carries the ENFORCED pair, not the decision input',
    session !== null && session.agentId === AGENT && session.modelId === MODEL_A,
    session === null ? 'no session' : `${session.agentId}/${session.modelId}`);
  check('T2A1-13: T2-a.1 created no session of its own (no threadId/decision session field)',
    session !== null && session.nativeSessionId === null, String(session?.nativeSessionId));
  cleanup();
}

// ===========================================================================
process.stdout.write('\n== the typed pair validator is still the single definition ==\n');
{
  const partialAgent = validateAgentModelIntent({ agentId: AGENT });
  const partialModel = validateAgentModelIntent({ modelId: MODEL_A });
  const full = validateAgentModelIntent({ agentId: AGENT, modelId: MODEL_A });
  check('agent-only is invalid', partialAgent.ok === false);
  check('model-only is invalid', partialModel.ok === false);
  check('a full pair is valid', full.ok === true);
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length > 0) process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
process.stdout.write('\n');
process.exitCode = failed === 0 ? 0 : 1;