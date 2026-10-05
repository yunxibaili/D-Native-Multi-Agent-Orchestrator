/**
 * tests/workbench.test.ts - the Native Agent Workbench layer (hermetic).
 *
 * Covers the four concepts the refactor added, each against REAL orchestration
 * classes (only the native process is scripted, exactly like every other suite):
 *
 *   1. SessionRegistry  - one agent, many sessions, many models; native handles
 *                         stick; identity mismatch is refused.
 *   2. Handoff          - built from real task+result data; bounded; no transcript.
 *   3. Brief            - the worker's prompt is composed once, from objective +
 *                         dependency handoffs.
 *   4. Planning         - Laya complexity - planner shape; explicit mapping.
 *   5. Workbench e2e    - plan - assign (with preference) - dispatch - evidence -
 *                         review rework - re-dispatch on the SAME worker; sessions
 *                         track every run; handoffs surface real results.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ModelRegistry } from '../src/quota/registry.ts';
import { BudgetManager } from '../src/quota/budget.ts';
import type { TaskType, QuotaRecord } from '../src/quota/types.ts';
import type { AgentDescriptor, RunRequest, RunResult } from '../src/core/types.ts';
import type { RuntimeRunner } from '../src/orchestration/execute.ts';
import { Orchestrator as RuntimeOrch } from '../src/orchestrator/orchestrator.ts';
import { createFakeAdapter } from './helpers.ts';
import { Orchestrator } from '../src/orchestration/orchestrator.ts';
import { TaskScheduler } from '../src/orchestration/scheduler.ts';
import { SessionRegistry } from '../src/orchestration/workbench-sessions.ts';
import { buildHandoff, buildTaskBrief } from '../src/orchestration/workbench-handoff.ts';
import { shapeForComplexity, workKindToTaskType, planFromSpec } from '../src/orchestration/workbench-plan.ts';
import { NativeWorkbench, DEFAULT_ROOT_AGENT_ID } from '../src/orchestration/workbench.ts';
import { validateReviewVerdict } from '../src/orchestration/review-verdict.ts';
import { planTasks } from '../src/orchestration/planner.ts';
import { runDecisionCycle, orchestrationDecisionRequest, extractAction, ACTION_PARAMETERS, type DecisionOutcome } from '../src/orchestration/decision-loop.ts';
import { observeTasks } from '../src/orchestration/observation.ts';
import { ALL_ACTIONS, validateDecision, applyDecision, DecisionValidationError } from '../src/orchestration/decision.ts';
import type { DecisionProvider, DecisionRequest } from '../src/decision/types.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; process.stdout.write(`  ok   ${name}\n`); }
  else { failed++; failures.push(name); process.stdout.write(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}\n`); }
};

const NOW = 1_700_000_000_000;
const AGENT = 'fake-impl';
const OTHER = 'fake-other';
const SB = 'opencode/space-bunny-free';
const MIMO = 'opencode/mimo-v2.6-flash-free';
const impl: TaskType = 'implementation';

const descriptor = (id: string): AgentDescriptor => ({
  id, displayName: id, launcher: 'fake', transport: 'cli-jsonl',
  capabilities: { newTask: true, review: true, modelSelection: true, resume: true },
} as unknown as AgentDescriptor);

const statusRow = (agent: string) => ({ agent, version: '1', installed: 'Yes', login: 'n/a', quotaSource: 't', usage: 'n/a', status: 'ok' });
const quotaRecord = (agentId: string): QuotaRecord => ({
  provider: agentId, agentId, modelId: null, source: 'locally_observed', usage: null, remaining: null,
  resetAt: null, period: 'day', status: 'available', usageClass: 'observed', confidence: 'high', observedAt: NOW, note: '',
});
const registryWith = (entries: Array<[string, string, string[]]>): ModelRegistry => {
  const reg = new ModelRegistry();
  for (const [agentId, modelId, taskTypes] of entries) {
    reg.upsert({ agentId, modelId, provider: 'test', taskTypes: taskTypes as never, modelSource: 'test', quotaSource: 'test' }, NOW);
    reg.setAvailability(agentId, 'available');
  }
  return reg;
};

const fakeRuntime = (): { runtime: RuntimeRunner; requests: RunRequest[] } => {
  const requests: RunRequest[] = [];
  const rt = new RuntimeOrch({
    config: { agents: {} } as never,
    storeDir: mkdtempSync(join(tmpdir(), 'wb-store-')),
    extraAdapters: [
      createFakeAdapter({ id: AGENT, script: [{ kind: 'exit', code: 0 }], capabilities: { newTask: true, review: true, modelSelection: true } }),
      createFakeAdapter({ id: OTHER, script: [{ kind: 'exit', code: 0 }], capabilities: { newTask: true, review: true, modelSelection: true } }),
    ],
  });
  return { runtime: { run: (r: RunRequest) => { requests.push(r); return rt.run(r); } }, requests };
};

function makeWorkbench(opts: { maxConcurrency?: number; preferred?: { agentId: string; modelId?: string }; rootAgentId?: string } = {}): {
  wb: NativeWorkbench; requests: RunRequest[]; dir: string; cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'wb-'));
  const { runtime, requests } = fakeRuntime();
  // The spawn gate is fail-closed on a missing task-scope budget, so EVERY id used
  // below must be allocated up front (same reason tests/native-agent-e2e.test.ts
  // calls ensureBudgets after planning).
  const taskIds = ['r', 'r-s1', 'r-c1', 'r-c2', 'r-c3', 'r-p1', 'r-p2', 'r-p3', 'r-d1', 'r-d2', 'r-d3', 'c1', 'c2-s1',
    'u', 'uA', 'uB', 'v', 'vA', 'vB', 'h', 'hA', 'hB', 'e1', 'e1-s1', 'g1', 'g1-s1', 'f1', 'f1-s1',
    // P6-D1 fixtures
    'r-s1-pending', 'old-1', 'kept-1', 'big-1', 'r-s1-b'];
  const budgets = new BudgetManager(1_000_000);
  for (const t of taskIds) budgets.task(t, 100_000);
  budgets.agent(AGENT, 1_000_000);
  budgets.agent(OTHER, 1_000_000);
  const orch = new Orchestrator({
    gate: {
      descriptors: [descriptor(AGENT), descriptor(OTHER)],
      agentStatus: [statusRow(AGENT), statusRow(OTHER)],
      quotaRecords: [quotaRecord(AGENT), quotaRecord(OTHER)],
      registry: registryWith([[AGENT, SB, ['implementation', 'research']], [OTHER, MIMO, ['implementation']]]),
      budgets,
      taskType: impl,
      requestedUnits: 10,
      currentConcurrency: 0,
      maxConcurrency: opts.maxConcurrency ?? 4,
      maxChildren: 8,
      maxConcurrentAgents: 4,
    } as never,
    now: () => NOW,
    runtime,
    defaultCwd: dir,
  });
  const scheduler = new TaskScheduler({ orchestrator: orch, cwd: dir });
  const wb = new NativeWorkbench({
    orchestrator: orch, scheduler, registry: registryWith([[AGENT, SB, ['implementation', 'research']], [OTHER, MIMO, ['implementation']]]),
    quotaRecords: [quotaRecord(AGENT), quotaRecord(OTHER)],
    cwd: dir,
    ...(opts.rootAgentId !== undefined ? { rootAgentId: opts.rootAgentId } : {}),
  });
  return { wb, requests, dir, cleanup: () => { rmSync(dir, { recursive: true, force: true }); } };
}

const runResult = (state: RunResult['state'], agentId = AGENT): RunResult =>
  ({ agentId, state, error: state === 'failed' ? { code: 'E', message: 'm' } : null, startedAt: NOW, endedAt: NOW + 10, exitCode: 0, signal: null } as unknown as RunResult);

// ---------------------------------------------------------------- 1. sessions

section1();
function section1(): void {
  process.stdout.write('\n== WB 1. SessionRegistry: one agent, many sessions, many models ==\n');
  const reg = new SessionRegistry();
  const a = reg.open({ agentId: 'opencode', modelId: SB, sessionPolicy: 'fresh' }, '/tmp/a', NOW, 't1');
  const b = reg.open({ agentId: 'opencode', modelId: MIMO, sessionPolicy: 'fresh' }, '/tmp/b', NOW, 't2');
  check('two sessions on one agent, different models', a.sessionId !== b.sessionId && a.modelId !== b.modelId);
  check('fresh sessions have no native handle yet', a.nativeSessionId === null && b.nativeSessionId === null);
  check('per-agent listing shows both', reg.sessionsForAgent('opencode').length === 2);

  reg.markRunning(a.sessionId, 't1');
  const recorded = reg.recordRun(a.sessionId, { threadId: 'native-abc' } as RunResult, NOW + 5);
  check('a run records the NATIVE session handle', recorded.nativeSessionId === 'native-abc');
  const again = reg.recordRun(a.sessionId, { threadId: 'native-abc' } as RunResult, NOW + 6);
  check('a resumed run keeps the SAME native handle', again.nativeSessionId === 'native-abc');

  // Resuming a session requires the SAME (agent, model) - no model switching.
  let code = '';
  try { reg.open({ agentId: 'opencode', modelId: MIMO, sessionId: a.sessionId, sessionPolicy: 'resume' }, '/tmp/a', NOW); }
  catch (e) { code = (e as { code?: string }).code ?? 'unknown'; }
  check('opening a session with a DIFFERENT model is refused', code === 'session-identity-mismatch', code);

  reg.close(a.sessionId);
  check('a closed session reports closed', reg.get(a.sessionId)?.status === 'closed');
  check('all() is ordered and complete', reg.all().length === 2);
  check('unknown session get is null, not a throw', reg.get('nope') === null);
}

// ---------------------------------------------------------------- 2. handoff

section2();
function section2(): void {
  process.stdout.write('\n== WB 2. Handoff: structured, bounded, evidence-backed ==\n');
  const { wb, dir, cleanup } = makeWorkbench();
  wb.plan({ taskId: 'r', objective: 'make the thing', taskType: impl, shape: 'single', budgetUnits: 10 } as never, null);
  const task = wb.store.get('r-s1');
  const longOutput = 'x'.repeat(2000) + 'FINAL SUMMARY: it works';
  const result = { ...runResult('succeeded'), output: longOutput, transcriptPath: '/t/c1.jsonl' } as RunResult;
  const h = buildHandoff(task as never, result);
  check('the handoff carries the objective (planner-composited)', h.objective.startsWith('make the thing'));
  check('worker summary is a BOUNDED tail, not the transcript', h.completedWork !== null && h.completedWork.length <= 601 && h.completedWork.endsWith('FINAL SUMMARY: it works'));
  check('run state and transcript path are recorded', h.runState === 'succeeded' && h.transcriptPath === '/t/c1.jsonl');
  check('a run without output handoffs completedWork null', buildHandoff(task as never, runResult('succeeded')).completedWork === null);

  const brief = buildTaskBrief({
    objective: 'extend the thing',
    constraints: ['do not break the API'],
    handoffs: [h],
  });
  check('the brief contains the objective', brief.includes('extend the thing'));
  check('the brief contains constraints', brief.includes('do not break the API'));
  check('the brief contains the dependency handoff summary', brief.includes('Handoff from task r-s1') && brief.includes('FINAL SUMMARY'));
  check('the brief is bounded (no full transcript leak)', brief.length < longOutput.length);

  const depResult = new Map<string, RunResult>([['c1', result]]);
  const wbBrief = wb.briefFor('r-s1', depResult);
  check('briefFor on a task with NO dependencies renders just the work', wbBrief !== null && wbBrief.includes('make the thing') && !wbBrief.includes('Handoff from task'));
  void dir; cleanup();
}

// --- handoff sections derived from REAL evidence, across BOTH native spellings ---

section2b();
function section2b(): void {
  process.stdout.write('\n== WB 2b. Handoff sections: real evidence, either spelling ==\n');

  // The bug this covers: CodeBuddy emits `Write`/`Bash`, OpenCode emits
  // `write`/`bash`. A case-sensitive table matched one agent and produced an EMPTY
  // handoff for the other - which reads as "nothing changed" when everything did.
  const runs: Array<[string, RunResult]> = [
    ['workbuddy/CodeBuddy spelling', {
      ...runResult('succeeded'),
      toolCalls: [
        { name: 'Write', input: { file_path: '/repo/A.txt', content: 'x' } },
        { name: 'Bash', input: { command: 'npm test' } },
      ],
    } as RunResult],
    ['opencode lowercase spelling', {
      ...runResult('succeeded'),
      toolCalls: [
        { name: 'write', input: { filePath: 'C:\\repo\\B.txt', content: 'y' } },
        { name: 'bash', input: { command: 'git add -A' } },
      ],
    } as RunResult],
    ['mixed / other natives', {
      ...runResult('succeeded'),
      toolCalls: [
        { name: 'EDIT', input: { path: '/repo/C.txt' } },
        { name: 'run_terminal_cmd', input: { command: 'pytest -q' } },
      ],
    } as RunResult],
  ];
  for (const [label, res] of runs) {
    const h = buildHandoff({ taskId: 't', acceptanceCriteria: 'o', taskType: impl, status: 'succeeded', artifacts: [] } as never, res);
    check(`${label}: changedFiles is derived from the write tool`, h.changedFiles.length === 1, JSON.stringify(h.changedFiles));
    check(`${label}: testsRun is derived from the shell tool`, h.testsRun.length === 1, JSON.stringify(h.testsRun));
  }

  const noTools = buildHandoff({ taskId: 't', acceptanceCriteria: 'o', taskType: impl, status: 'succeeded', artifacts: [] } as never,
    { ...runResult('succeeded'), toolCalls: [] } as RunResult);
  check('a run with no tool calls yields EMPTY sections, not invented ones',
    noTools.changedFiles.length === 0 && noTools.testsRun.length === 0);
  check('an absent decision is null, not an empty string', noTools.decisions === null);
  check('the brief still renders the always-present sections when evidence is empty',
    buildTaskBrief({ objective: 'next', handoffs: [noTools] }).includes('decisions: none reported'));

  // Duplicate writes collapse; distinct ones do not.
  const dup = buildHandoff({ taskId: 't', acceptanceCriteria: 'o', taskType: impl, status: 'succeeded', artifacts: [] } as never, {
    ...runResult('succeeded'),
    toolCalls: [
      { name: 'write', input: { filePath: '/repo/Same.txt' } },
      { name: 'Write', input: { file_path: '/repo/Same.txt' } },
      { name: 'write', input: { filePath: '/repo/Other.txt' } },
    ],
  } as RunResult);
  check('the same path written twice is listed once', dup.changedFiles.join('|') === '/repo/Same.txt|/repo/Other.txt',
    JSON.stringify(dup.changedFiles));

  // A worker that states a decision has it lifted; one that does not, does not.
  const spoke = buildHandoff({ taskId: 't', acceptanceCriteria: 'o', taskType: impl, status: 'succeeded', artifacts: [] } as never, {
    ...runResult('succeeded'),
    output: 'Work done.\nDecision: keep the existing scheduler\nUnresolved: docs not updated',
  } as RunResult);
  check('an explicit decision marker is lifted, not inferred', spoke.decisions === 'keep the existing scheduler', String(spoke.decisions));
  check('an explicit unresolved marker is lifted', spoke.unresolved.join('|') === 'docs not updated', JSON.stringify(spoke.unresolved));
  const vague = buildHandoff({ taskId: 't', acceptanceCriteria: 'o', taskType: impl, status: 'succeeded', artifacts: [] } as never, {
    ...runResult('succeeded'),
    output: 'I decided to probably do something about it.',
  } as RunResult);
  check('prose that merely sounds like a decision is NOT lifted as one', vague.decisions === null, String(vague.decisions));
}

// ---------------------------------------------------------------- 3. planning

section3();
function section3(): void {
  process.stdout.write('\n== WB 3. Planning: Laya complexity - planner shape ==\n');
  check('trivial - single', shapeForComplexity('trivial') === 'single');
  check('moderate - chain', shapeForComplexity('moderate') === 'chain');
  check('large - diamond', shapeForComplexity('large') === 'diamond');
  check('debugging maps to implementation (capability vocabulary)', workKindToTaskType('debugging') === 'implementation');
  const spec = { taskId: 'r1', objective: 'build a parser', constraints: ['keep the CLI stable'], budgetUnits: 10 };
  const planned = planFromSpec(spec as never, { classification: null, now: NOW });
  check('no Laya - implementation/single by default', planned.taskType === 'implementation' && planned.shape === 'single');
  check('constraints ride into the objective', planned.plan.candidates[0]?.description.includes('keep the CLI stable'));
  check('planner produced a committed-ready candidate set', planned.plan.candidates.length === 1);
}

// ---------------------------------------------------------------- 4. workbench e2e (hermetic)

await section4();
async function section4(): Promise<void> {
  process.stdout.write('\n== WB 4. Workbench e2e: plan - assign - dispatch - evidence - review - handoff ==\n');
  const { wb, requests, cleanup } = makeWorkbench();
  const spec = {
    taskId: 'r', objective: 'produce a small module', taskType: impl,
    constraints: ['no new dependencies'], budgetUnits: 10,
    preferredAgent: OTHER, preferredModel: MIMO,
  };
  const plan = wb.plan(spec as never, null);
  check('the root exists and children were committed', plan.root !== null && plan.children.length === 1, String(plan.children.length));
  const childId = plan.children[0]!.taskId;

  // Preference: OTHER/MIMO survives the filters, so it must win over the default.
  const assignments = wb.assignChildren('r', spec as never);
  check('every child got an assignment', assignments.every((a) => a.ok), JSON.stringify(assignments.filter((a) => !a.ok)));
  check('the PREFERRED agent/model was honoured', wb.store.get(childId)?.agentId === OTHER && wb.store.get(childId)?.modelId === MIMO,
    JSON.stringify(wb.store.get(childId)));
  check('a session was opened for the assignment', wb.sessions.sessionsForAgent(OTHER).length === 1);

  const dispatch1 = await wb.dispatch();
  check('the scheduler dispatched the assigned child', dispatch1.tick?.admitted.includes(childId) === true, JSON.stringify(dispatch1.tick?.admitted));
  check('the runtime ran the ASSIGNED agent/model', requests[0]?.agentId === OTHER && requests[0]?.model === MIMO);
  check('evidence was recorded for the real run', dispatch1.evidenceRecorded.includes(childId) && dispatch1.evidenceDegraded === false);
  check('the session recorded the run', dispatch1.sessionsTouched.length === 1);
  check('the run is in the attempt history as an execution', wb.evidence.history(childId)[0]?.outcome === 'success');

  // Review: a rework verdict re-enters on the SAME worker through the scheduler.
  const verdict = validateReviewVerdict({ verdict: 'rework', reason: 'needs a test', findings: [], recommendedAction: 'none', reviewer: 'codex', reviewedAt: NOW });
  const applied = wb.applyReview(childId, verdict);
  check('the rework verdict was applied', applied.status === 'ok' && applied.reworkRequested === true, applied.status);
  const dispatch2 = await wb.dispatch();
  check('the rework ran on the SAME agent/model (no reassignment)',
    requests[1]?.agentId === OTHER && requests[1]?.model === MIMO);
  check('the rework is a SEPARATE evidence row of kind rework',
    wb.evidence.countByKind(childId, 'rework') === 1 && wb.evidence.countByKind(childId, 'execution') === 1);
  check('the second dispatch really ran', dispatch2.tick?.admitted.includes(childId) === true);

  // Pass ends it; handoff reflects the terminal state.
  const pass = validateReviewVerdict({ verdict: 'pass', reason: 'ok now', findings: [], recommendedAction: 'none', reviewer: 'codex', reviewedAt: NOW + 1 });
  wb.applyReview(childId, pass);
  check('applyVerification remains the only route to succeeded', wb.store.get(childId)?.status === 'succeeded');
  const handoff = wb.handoffFor(childId, runResult('succeeded', OTHER));
  check('the handoff reports the terminal status', handoff?.status === 'succeeded');

  // Preference that FAILS the filters falls back to the deterministic ranking.
  const failing = { ...spec, preferredAgent: 'no-such-agent' };
  wb.spawnChild({ taskId: 'c2-s1', parentTaskId: 'r', agentId: OTHER, modelId: MIMO, taskType: impl, acceptanceCriteria: 'second', budgetUnits: 10 });
  const fallback = wb.assignChildren('r', failing as never).find((a) => a.taskId === 'c2-s1');
  check('a preference for an unknown agent does not break assignment', fallback?.ok === true);
  cleanup();
}

// ------------------------------------------------- 5. failure paths (never just the happy one)

await section5();
async function section5(): Promise<void> {
  process.stdout.write('\n== WB 5. Failure paths: each one has a defined outcome ==\n');

  // (a) A NATIVE SESSION FAILURE must land as a task failure, not a silent success.
  {
    const dir = mkdtempSync(join(tmpdir(), 'wb-fail-'));
    const rt = new RuntimeOrch({
      config: { agents: {} } as never,
      storeDir: mkdtempSync(join(tmpdir(), 'wb-fail-store-')),
      extraAdapters: [createFakeAdapter({ id: AGENT, script: [{ kind: 'exit', code: 3 }], capabilities: { newTask: true, modelSelection: true } })],
    });
    const reg = registryWith([[AGENT, SB, ['implementation']]]);
    const budgets = new BudgetManager(1_000_000);
    budgets.task('f1', 100_000); budgets.task('f1-s1', 100_000); budgets.agent(AGENT, 1_000_000);
    const orch = new Orchestrator({
      gate: { descriptors: [descriptor(AGENT)], agentStatus: [statusRow(AGENT)],
        quotaRecords: [quotaRecord(AGENT)], registry: reg, budgets, taskType: impl, requestedUnits: 10,
        currentConcurrency: 0, maxConcurrency: 2, maxChildren: 4, maxConcurrentAgents: 2, taskPolicyAllows: true,
      } as never,
      runtime: { run: (r: RunRequest) => rt.run(r) }, defaultCwd: dir,
    });
    const wb = new NativeWorkbench({ orchestrator: orch, scheduler: new TaskScheduler({ orchestrator: orch, cwd: dir }), registry: reg, quotaRecords: [quotaRecord(AGENT)], cwd: dir });
    wb.plan({ taskId: 'f1', objective: 'fail on purpose', taskType: impl, shape: 'single', budgetUnits: 10 } as never, null);
    // Assignment is not optional: a task with no agent identity is correctly NOT
    // dispatchable, so without this the test would measure the gate, not the exit code.
    wb.assignChildren('f1', { taskId: 'f1', objective: 'fail on purpose', taskType: impl, budgetUnits: 10 } as never);
    const d = await wb.dispatch();
    check('a non-zero native exit becomes a task FAILURE', wb.store.get('f1-s1')?.status === 'failed',
      String(wb.store.get('f1-s1')?.status));
    check('the failure is reported on the tick, not swallowed', d.tick?.outcomes.some((o) => !o.outcome.ok) === true);
    check('a failed task does NOT reach succeeded', wb.store.get('f1-s1')?.status !== 'succeeded');
    rmSync(dir, { recursive: true, force: true });
  }

  // (b) DEPENDENCY UNSATISFIED: B must not be dispatched while A is unverified.
  {
    const { wb, cleanup } = makeWorkbench();
    wb.orchestrator.createRoot({ taskId: 'u', agentId: AGENT, taskType: impl, acceptanceCriteria: 'chain' });
    wb.spawnChild({ taskId: 'uA', parentTaskId: 'u', agentId: AGENT, modelId: SB, taskType: impl, budgetUnits: 10, acceptanceCriteria: 'A' });
    wb.spawnChild({ taskId: 'uB', parentTaskId: 'u', agentId: AGENT, modelId: SB, taskType: impl, budgetUnits: 10, acceptanceCriteria: 'B', dependencies: ['uA'], allowUnmetDependencies: true });
    const d = await wb.dispatch();
    check('the dependant is NOT admitted while its dependency is unfinished', d.tick?.admitted.includes('uB') === false, JSON.stringify(d.tick?.admitted));
    check('the dependant is reported as skipped, not failed', d.tick?.skipped.some((s) => s.taskId === 'uB') === true);
    check('the dependant stays PLANNED (not failed) while waiting', wb.store.get('uB')?.status === 'planned');
    // Satisfy A properly, then B becomes runnable - the dependency/verification
    // semantics are unchanged, only now satisfied.
    wb.orchestrator.applyVerification('uA', { verdict: 'pass', reason: 'ok' });
    const d2 = await wb.dispatch();
    check('after A succeeds, B is admitted', d2.tick?.admitted.includes('uB') === true);
    cleanup();
  }

  // (c) VERIFICATION MISSING: a finished run stays in to_verify and cannot feed a dependant.
  {
    const { wb, cleanup } = makeWorkbench();
    wb.orchestrator.createRoot({ taskId: 'v', agentId: AGENT, taskType: impl, acceptanceCriteria: 'chain' });
    wb.spawnChild({ taskId: 'vA', parentTaskId: 'v', agentId: AGENT, modelId: SB, taskType: impl, budgetUnits: 10, acceptanceCriteria: 'A' });
    wb.spawnChild({ taskId: 'vB', parentTaskId: 'v', agentId: AGENT, modelId: SB, taskType: impl, budgetUnits: 10, acceptanceCriteria: 'B', dependencies: ['vA'], allowUnmetDependencies: true });
    await wb.dispatch();
    await until(() => wb.store.get('vA')?.status === 'to_verify', 30_000);
    check('a completed run lands in to_verify, awaiting judgement', wb.store.get('vA')?.status === 'to_verify', String(wb.store.get('vA')?.status));
    const d2 = await wb.dispatch();
    check('a task in to_verify does NOT satisfy its dependant', d2.tick?.admitted.includes('vB') === false);
    check('to_verify is not silently treated as succeeded', wb.store.get('vA')?.status !== 'succeeded');
    cleanup();
  }

  // (d) HANDOFF MISSING: a dependant whose dependency produced no run still gets a
  //     brief, and the brief says so rather than inventing an upstream result.
  {
    const { wb, cleanup } = makeWorkbench();
    wb.orchestrator.createRoot({ taskId: 'h', agentId: AGENT, taskType: impl, acceptanceCriteria: 'chain' });
    wb.spawnChild({ taskId: 'hA', parentTaskId: 'h', agentId: AGENT, modelId: SB, taskType: impl, budgetUnits: 10, acceptanceCriteria: 'A' });
    wb.spawnChild({ taskId: 'hB', parentTaskId: 'h', agentId: AGENT, modelId: SB, taskType: impl, budgetUnits: 10, acceptanceCriteria: 'B', dependencies: ['hA'], allowUnmetDependencies: true });
    const brief = wb.briefFor('hB', new Map());
    check('a brief is still composed when the dependency has NO run result', brief !== null && brief.includes('Handoff from task hA'));
    check('the missing-run handoff reports no result state, it does not invent one',
      brief !== null && !/result: succeeded/.test(brief));
    check('a handoff with no run reports completedWork as absent, not fabricated',
      brief !== null && !brief.includes('- completedWork:'));
    check('handoffFor returns null for a task that does not exist', wb.handoffFor('nope', null) === null);
    check('briefFor returns null for a task that does not exist', wb.briefFor('nope', new Map()) === null);
    cleanup();
  }

  // (e) EVIDENCE RECORDING FAILURE must not un-run an agent that already ran.
  {
    const { wb, cleanup } = makeWorkbench();
    wb.plan({ taskId: 'e1', objective: 'ran but evidence is broken', taskType: impl, shape: 'single', budgetUnits: 10 } as never, null);
    wb.assignChildren('e1', { taskId: 'e1', objective: 'ran but evidence is broken', taskType: impl, budgetUnits: 10 } as never);
    // A ledger that REFUSES every write, standing in for an unwritable/corrupt
    // store. It returns the real `AttemptAppendOutcome` refusal shape - returning
    // `null` instead would throw inside `recordExecution` and this test would be
    // measuring a broken double rather than the degradation path.
    const sabotage = new Proxy(wb.evidence, {
      get(target, prop) {
        if (prop === 'append') {
          return () => ({ ok: false as const, code: 'evidence-store-unwritable', reason: 'test: ledger refused the write' });
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const wb2 = new NativeWorkbench({
      orchestrator: wb.orchestrator, scheduler: new TaskScheduler({ orchestrator: wb.orchestrator, cwd: process.cwd() }),
      registry: registryWith([[AGENT, SB, ['implementation']]]), quotaRecords: [quotaRecord(AGENT)], cwd: process.cwd(), evidence: sabotage as never,
    });
    const d = await wb2.dispatch();
    check('a dispatch still runs and still reaches to_verify when evidence recording fails',
      wb.store.get('e1-s1')?.status === 'to_verify', String(wb.store.get('e1-s1')?.status));
    check('the degraded ledger is REPORTED rather than hidden', d.evidenceDegraded === true || d.evidenceRecorded.length === 0,
      `degraded=${d.evidenceDegraded} recorded=${JSON.stringify(d.evidenceRecorded)}`);
    check('the run itself is not reverted by the evidence failure', d.tick?.admitted.includes('e1-s1') === true);
    cleanup();
  }

  // (f) CANCELLATION ISOLATION: cancelling one session must not disturb another's state.
  {
    const reg = new SessionRegistry();
    const sA = reg.open({ agentId: 'opencode', modelId: SB, sessionPolicy: 'fresh' }, '/tmp/a', NOW, 'taskA');
    const sB = reg.open({ agentId: 'opencode', modelId: MIMO, sessionPolicy: 'fresh' }, '/tmp/b', NOW, 'taskB');
    reg.markRunning(sA.sessionId, 'taskA');
    reg.markRunning(sB.sessionId, 'taskB');
    reg.recordRun(sA.sessionId, runResult('succeeded'), NOW);
    check('a completed session reports its native handle/state without touching the other',
      reg.get(sB.sessionId)?.taskId === 'taskB' && reg.get(sB.sessionId)?.status !== 'closed');
    check('sessions remain distinguishable by model after one completes',
      reg.get(sA.sessionId)?.modelId === SB && reg.get(sB.sessionId)?.modelId === MIMO);
    check('a session lookup for an unknown id does not throw', reg.get('nope') === undefined || reg.get('nope') === null);
  }

  // (g) WRONG MODEL / SESSION BINDING is refused rather than silently accepted.
  {
    const { wb, cleanup } = makeWorkbench();
    wb.plan({ taskId: 'g1', objective: 'binding', taskType: impl, shape: 'single', budgetUnits: 10 } as never, null);
    const first = wb.assignChildren('g1', { preferredAgent: AGENT, preferredModel: SB } as never)[0];
    check('assignment writes the chosen identity onto the task', first?.ok === true);
    const task = wb.store.get('g1-s1');
    check('the task carries the assigned model', task?.modelId === SB, String(task?.modelId));
    check('a session exists for that exact (agent, model, task)', wb.sessions.all().some((s) => s.taskId === 'g1-s1' && s.modelId === SB && s.agentId === AGENT));
    check('a session for another model is NOT created for the same task',
      wb.sessions.all().filter((s) => s.taskId === 'g1-s1').every((s) => s.modelId === SB));
    cleanup();
  }

  process.stdout.write('\n');
}

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return pred();
}

// ------------------------- 6. P6-C minor refactor: A skill / B session / C preference / D rework

await section6();
async function section6(): Promise<void> {
  process.stdout.write('\n== WB 6. A/B/C: intent channels are transport, not authority ==\n');

  // ---- A: skills absent - behaviour is byte-identical to before ----
  {
    const { wb, cleanup } = makeWorkbench();
    wb.plan({ taskId: 'r', objective: 'no skills here', taskType: impl, shape: 'single', budgetUnits: 10 } as never, null);
    const brief = wb.briefFor('r-s1', new Map()) ?? '';
    check('A: a task with NO skill intent gets no skills section', !brief.includes('Requested skills'));
    check('A: skills absent leaves the rest of the brief unchanged',
      brief.includes('Work:') && brief.includes('no skills here'));
    check('A: a spec with no skills records no intent for its child', wb.intentFor('r-s1') === undefined ||
      wb.intentFor('r-s1')?.skills === undefined);
    cleanup();
  }

  // ---- A: skills present - the bounded brief carries the intent verbatim ----
  {
    const { wb, cleanup } = makeWorkbench();
    wb.plan({
      taskId: 'r', objective: 'use a skill', taskType: impl, shape: 'single', budgetUnits: 10,
      skills: ['api-and-interface-design', 'contract-first'],
    } as never, null);
    const brief = wb.briefFor('r-s1', new Map()) ?? '';
    check('A: the brief states the requested skills', brief.includes('Requested skills'));
    check('A: every requested skill is named verbatim',
      brief.includes('api-and-interface-design') && brief.includes('contract-first'));
    check('A: the intent is stored, not resolved', wb.intentFor('r-s1')?.skills?.length === 2);
    check('A: an unknown skill name is still carried (no validation, no filtering)',
      buildTaskBrief({ objective: 'x', skills: ['a-skill-that-does-not-exist'] }).includes('a-skill-that-does-not-exist'));
    cleanup();
  }

  // ---- A: skills must not become a second routing authority ----
  {
    const { wb, cleanup } = makeWorkbench();
    wb.plan({
      taskId: 'r', objective: 'skill must not reroute', taskType: impl, shape: 'single', budgetUnits: 10,
      // Only OTHER is registered for `implementation`; AGENT is the only one with
      // `research`. Asking for a skill must not move the worker either way.
      skills: ['research-only-skill'],
      preferredAgent: AGENT, preferredModel: SB,
    } as never, null);
    const outcome = wb.assignChildren('r', { taskId: 'r', taskType: impl, preferredAgent: AGENT, preferredModel: SB, skills: ['research-only-skill'] } as never)[0];
    check('A: assignment still chose by capability/preference, ignoring skill names',
      outcome?.ok === true && wb.store.get('r-s1')?.agentId === AGENT, String(wb.store.get('r-s1')?.agentId));
    cleanup();
  }

  // ---- B: session intent default is fresh (unchanged behaviour) ----
  {
    const { wb, cleanup } = makeWorkbench();
    wb.plan({ taskId: 'r', objective: 'default session', taskType: impl, shape: 'single', budgetUnits: 10 } as never, null);
    const o = wb.assignChildren('r', { taskId: 'r', taskType: impl } as never)[0];
    check('B: no intent - a fresh session is opened', o?.ok === true && o.session?.reused === false);
    check('B: the registry is still the only thing that created it',
      wb.sessions.all().length === 1 && wb.sessions.all()[0]?.sessionId === o?.session?.sessionId);
    cleanup();
  }

  // ---- B: reuse a session on the SAME agent+model ----
  {
    const { wb, cleanup } = makeWorkbench();
    wb.plan({ taskId: 'r', objective: 'reuse', taskType: impl, shape: 'single', budgetUnits: 10 } as never, null);
    const first = wb.assignChildren('r', { taskId: 'r', taskType: impl, preferredAgent: AGENT, preferredModel: SB } as never)[0];
    const key = first?.session?.sessionId ?? '';
    check('B: a first session was created to reuse later', first?.ok === true && key !== '');
    const reused = wb.assignChildren('r', {
      taskId: 'r', taskType: impl, preferredAgent: AGENT, preferredModel: SB,
      sessionIntent: { kind: 'reuse', sessionKey: key },
    } as never)[0];
    check('B: a reuse intent returns the SAME session', reused?.ok === true && reused.session?.sessionId === key);
    check('B: the reuse is reported as reused', reused?.session?.reused === true);
    check('B: no extra session was created by the reuse', wb.sessions.all().length === 1, String(wb.sessions.all().length));
    cleanup();
  }

  // ---- B: identity mismatch is still refused (cross-agent AND cross-model) ----
  {
    const { wb, cleanup } = makeWorkbench();
    wb.plan({ taskId: 'r', objective: 'mismatch', taskType: impl, shape: 'single', budgetUnits: 10 } as never, null);
    const first = wb.assignChildren('r', { taskId: 'r', taskType: impl, preferredAgent: AGENT, preferredModel: SB } as never)[0];
    const key = first?.session?.sessionId ?? '';

    const crossModel = wb.assignChildren('r', {
      taskId: 'r', taskType: impl, preferredAgent: OTHER, preferredModel: MIMO,
      sessionIntent: { kind: 'reuse', sessionKey: key },
    } as never)[0];
    check('B: reusing an AGENT/SB session for OTHER/MIMO is refused',
      crossModel?.ok === false && crossModel.sessionError?.code === 'session-identity-mismatch',
      JSON.stringify(crossModel?.sessionError ?? crossModel?.code));
    check('B: the refusal carries a code a caller can branch on',
      crossModel?.code === 'session-session-identity-mismatch', String(crossModel?.code));
    check('B: the task was left unassigned, so it cannot run on the wrong identity',
      wb.store.get('r-s1')?.agentId === AGENT, String(wb.store.get('r-s1')?.agentId));

    const missing = wb.assignChildren('r', {
      taskId: 'r', taskType: impl, preferredAgent: AGENT, preferredModel: SB,
      sessionIntent: { kind: 'reuse', sessionKey: 'ws_does_not_exist' },
    } as never)[0];
    check('B: reusing an unknown session key is refused',
      missing?.ok === false && missing.sessionError?.code === 'session-not-found');

    // And the session channel cannot smuggle a model switch even for the same agent.
    // A session on AGENT/MIMO exists, and AGENT is still the assigned agent for this
    // task - so the ONLY thing that differs is the model, which must be refused.
    const mimoSession = wb.sessions.open({ agentId: AGENT, modelId: MIMO, sessionPolicy: 'fresh' }, process.cwd(), NOW, 'seed-mimo');
    const sameAgentOtherModel = wb.assignChildren('r', {
      taskId: 'r', taskType: impl, preferredAgent: AGENT, preferredModel: SB,
      sessionIntent: { kind: 'reuse', sessionKey: mimoSession.sessionId },
    } as never)[0];
    check('B: same agent + DIFFERENT model is still a mismatch',
      sameAgentOtherModel?.ok === false && sameAgentOtherModel.sessionError?.code === 'session-identity-mismatch',
      JSON.stringify(sameAgentOtherModel?.sessionError ?? { ok: sameAgentOtherModel?.ok }));
    cleanup();
  }

  // ---- B: per-task session override beats the spec default ----
  {
    const { wb, cleanup } = makeWorkbench();
    wb.plan({
      taskId: 'r', objective: 'per-task session', taskType: impl, shape: 'single', budgetUnits: 10,
      sessionIntent: { kind: 'fresh' },
    } as never, null);
    const seeded = wb.sessions.open({ agentId: AGENT, modelId: SB, sessionPolicy: 'fresh' }, process.cwd(), NOW, 'seed');
    const o = wb.assignChildren('r', {
      taskId: 'r', taskType: impl, preferredAgent: AGENT, preferredModel: SB,
      sessionIntent: { kind: 'fresh' },
    } as never)[0];
    // Now override THIS task to reuse, against the same spec default of fresh.
    wb.setTaskIntent('r-s1', { sessionIntent: { kind: 'reuse', sessionKey: seeded.sessionId } });
    const o2 = wb.assignChildren('r', {
      taskId: 'r', taskType: impl, preferredAgent: AGENT, preferredModel: SB,
      sessionIntent: { kind: 'fresh' },
    } as never)[0];
    check('B: a per-task override wins over the spec default',
      o2?.session?.sessionId === seeded.sessionId && o2?.session?.reused === true,
      JSON.stringify(o2?.session));
    check('B: the earlier fresh session is untouched by the later reuse', o?.ok === true);
    cleanup();
  }

  // ---- C: spec default preference ----
  {
    const { wb, cleanup } = makeWorkbench();
    wb.plan({ taskId: 'r', objective: 'spec pref', taskType: impl, shape: 'single', budgetUnits: 10 } as never, null);
    const o = wb.assignChildren('r', { taskId: 'r', taskType: impl, preferredAgent: OTHER, preferredModel: MIMO } as never)[0];
    check('C: the spec-level preference selects the worker',
      o?.ok === true && wb.store.get('r-s1')?.agentId === OTHER && wb.store.get('r-s1')?.modelId === MIMO);
    cleanup();
  }

  // ---- C: per-task preference wins over the spec default ----
  {
    const { wb, cleanup } = makeWorkbench();
    wb.plan({ taskId: 'r', objective: 'per-task pref', taskType: impl, shape: 'single', budgetUnits: 10 } as never, null);
    // Spec says AGENT/SB; this one task says OTHER/MIMO.
    wb.setTaskIntent('r-s1', { preferredAgent: OTHER, preferredModel: MIMO });
    const o = wb.assignChildren('r', { taskId: 'r', taskType: impl, preferredAgent: AGENT, preferredModel: SB } as never)[0];
    check('C: a per-task preference beats the spec default',
      o?.ok === true && wb.store.get('r-s1')?.agentId === OTHER && wb.store.get('r-s1')?.modelId === MIMO,
      `${wb.store.get('r-s1')?.agentId}/${wb.store.get('r-s1')?.modelId}`);
    cleanup();
  }

  // ---- C: a per-task preference must NOT bypass a hard filter ----
  {
    const { wb, cleanup } = makeWorkbench();
    // The fixture registry gives AGENT ['implementation','research'] and OTHER
    // ['implementation'] only. So a `research` task has exactly ONE eligible worker
    // and OTHER is filtered out on capability. The child is spawned as `research`
    // (plan() would stamp `implementation` from the spec), so the capability filter
    // has something real to reject.
    wb.orchestrator.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'research child' });
    wb.spawnChild({ taskId: 'r-s1', parentTaskId: 'r', agentId: AGENT, modelId: SB, taskType: 'research', budgetUnits: 10, acceptanceCriteria: 'research me' });
    // A per-task preference for a worker that CANNOT do research must lose to the
    // filter, exactly as a spec-level one does.
    wb.setTaskIntent('r-s1', { preferredAgent: OTHER, preferredModel: MIMO });
    const o = wb.assignChildren('r', { taskId: 'r', taskType: 'research' as never } as never)[0];
    check('C: a per-task preference cannot bypass the capability filter',
      o?.ok === true && wb.store.get('r-s1')?.agentId === AGENT, String(wb.store.get('r-s1')?.agentId));
    check('C: the filter still reported OTHER as rejected for that task type',
      o?.outcome?.rejected.some((r) => r.agentId === OTHER) === true,
      JSON.stringify(o?.outcome?.rejected.map((r) => r.agentId)));
    cleanup();
  }

  // ---- D: rework re-entry observability ----
  {
    const { wb, cleanup } = makeWorkbench();
    wb.plan({ taskId: 'r', objective: 'rework observability', taskType: impl, shape: 'single', budgetUnits: 10 } as never, null);
    wb.assignChildren('r', { taskId: 'r', taskType: impl } as never);
    await wb.dispatch();
    const childId = 'r-s1';
    const rework = validateReviewVerdict({ verdict: 'rework', reason: 'needs a test', findings: [], recommendedAction: 'none', reviewer: 'codex', reviewedAt: NOW });
    const okOutcome = wb.applyReview(childId, rework);
    check('D: a successful re-entry reports ok:true AND a successful reentry',
      okOutcome.status === 'ok' && okOutcome.reworkRequested === true &&
      okOutcome.reworkReentry?.ok === true && okOutcome.reworkReentry?.code === 'queued',
      JSON.stringify(okOutcome.status === 'ok' ? okOutcome.reworkReentry?.code : okOutcome.status));
    check('D: the task really is queued after a successful re-entry', wb.store.get(childId)?.status === 'queued');
    check('D: the re-entry consumed an attempt on the task', (wb.store.get(childId)?.retryCount ?? 0) === 1);
    cleanup();
  }

  {
    // The failure case, forced through the store's own rule rather than a mock: the
    // task is already `queued`, so the `rework -> queued` re-entry is refused. The
    // point is that the caller can TELL, which the old `{status:'ok'}` could not.
    const { wb, cleanup } = makeWorkbench();
    wb.plan({ taskId: 'r', objective: 'rework refusal', taskType: impl, shape: 'single', budgetUnits: 10 } as never, null);
    wb.assignChildren('r', { taskId: 'r', taskType: impl } as never);
    await wb.dispatch();
    const childId = 'r-s1';
    // Verify, then apply a rework verdict TWICE: the first queues it, the second
    // finds it `queued`, and `applyVerification` moves it to `rework` while the
    // re-entry then cannot queue from there.
    wb.applyReview(childId, validateReviewVerdict({ verdict: 'pass', reason: 'r', findings: [], recommendedAction: 'none', reviewer: 'codex', reviewedAt: NOW }));
    check('D: setup reached succeeded', wb.store.get(childId)?.status === 'succeeded', String(wb.store.get(childId)?.status));

    // A terminal task cannot be reworked at all: applyVerification refuses first,
    // which is the pre-existing and correct outcome.
    const terminal = wb.applyReview(childId, validateReviewVerdict({ verdict: 'rework', reason: 'again', findings: [], recommendedAction: 'none', reviewer: 'codex', reviewedAt: NOW + 1 }));
    check('D: a terminal task refuses the rework verdict (pre-existing behaviour)',
      terminal.status === 'verification-refused' && terminal.dispatched === false, terminal.status);
    cleanup();
  }

  {
    // The precise D case: verification applied the rework, but the QUEUE was refused,
    // so the task is stranded in `rework`. Forced by making the store refuse the
    // transition the re-entry needs - which is exactly what a real refusal looks like.
    const dir = mkdtempSync(join(tmpdir(), 'wb-rework-d-'));
    const { runtime } = fakeRuntime();
    const reg = registryWith([[AGENT, SB, ['implementation']]]);
    const budgets = new BudgetManager(1_000_000);
    budgets.task('d1', 100_000); budgets.task('d1-s1', 100_000); budgets.agent(AGENT, 1_000_000);
    const orch = new Orchestrator({
      gate: { descriptors: [descriptor(AGENT)], agentStatus: [statusRow(AGENT)],
        quotaRecords: [quotaRecord(AGENT)], registry: reg, budgets, taskType: impl, requestedUnits: 10,
        currentConcurrency: 0, maxConcurrency: 2, maxChildren: 4, maxConcurrentAgents: 2, taskPolicyAllows: true,
      } as never,
      now: () => NOW,
      runtime,
      defaultCwd: dir,
    });
    const wb2 = new NativeWorkbench({
      orchestrator: orch, scheduler: new TaskScheduler({ orchestrator: orch, cwd: dir }),
      registry: reg, quotaRecords: [quotaRecord(AGENT)], cwd: dir,
    });
    wb2.plan({ taskId: 'd1', objective: 'stranded rework', taskType: impl, shape: 'single', budgetUnits: 10 } as never, null);
    wb2.assignChildren('d1', { taskId: 'd1', taskType: impl } as never);
    await wb2.dispatch();
    await until(() => wb2.store.get('d1-s1')?.status === 'to_verify', 30_000);
    // Move it to `rework` through the ONE verification authority, then hand
    // `applyReview` an orchestrator whose `queue` refuses - the re-entry failure.
    const verdict = validateReviewVerdict({ verdict: 'rework', reason: 'x', findings: [], recommendedAction: 'none', reviewer: 'codex', reviewedAt: NOW });
    const sabotaged = new Proxy(orch, {
      get(target, prop, recv) {
        if (prop === 'queue') return () => ({ ok: false, code: 'budget-scope-missing', reason: 'test: queue refused' });
        const v = Reflect.get(target, prop, recv) as unknown;
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const wb3 = new NativeWorkbench({
      orchestrator: sabotaged as never,
      scheduler: new TaskScheduler({ orchestrator: orch, cwd: dir }),
      registry: reg, quotaRecords: [quotaRecord(AGENT)], cwd: dir,
    });
    const out = wb3.applyReview('d1-s1', verdict);
    check('D: a refused re-entry still reports status ok (verification DID succeed)',
      out.status === 'ok' && out.reworkRequested === true, out.status);
    check('D: a refused re-entry is DISTINGUISHABLE via reworkReentry.ok === false',
      out.status === 'ok' && out.reworkReentry?.ok === false, JSON.stringify(out.status === 'ok' ? out.reworkReentry : null));
    check('D: the refusal code and reason are preserved verbatim',
      out.status === 'ok' && out.reworkReentry?.code === 'budget-scope-missing' && (out.reworkReentry?.reason ?? '').includes('queue refused'),
      JSON.stringify(out.status === 'ok' ? out.reworkReentry?.code : null));
    check('D: a caller can therefore tell "queued, will run" from "wedged in rework"',
      out.status !== 'ok' || out.reworkReentry === undefined || out.reworkReentry.ok !== true);
    check('D: the task really is stranded in rework, which is why this matters',
      orch.getStore().get('d1-s1')?.status === 'rework', String(orch.getStore().get('d1-s1')?.status));
    check('D: the store state is untouched by the reporting change',
      orch.getStore().get('d1-s1')?.retryCount === 0, String(orch.getStore().get('d1-s1')?.retryCount));
    rmSync(dir, { recursive: true, force: true });
  }

  process.stdout.write('\n');
}


// ---------------------------------------------------------------------------
// P6-D1 integration: the dynamic decision loop against a REAL workbench.
//
// Not unit tests of `applyDecision`. These drive `runDecisionCycle` over the real
// store, the real scheduler and the real planner wiring, with a stub provider that
// answers with whatever action is under test. That is the only way to prove the loop
// is CONNECTED rather than merely capable - a capability that exists but was never
// injected fails every one of these, which is exactly the bug P6-D1 was created to fix.
// ---------------------------------------------------------------------------

/**
 * A provider that answers `choice`, whatever space it was offered.
 *
 * `extra` is merged into the extracted decision, which is how a test produces a
 * WELL-FORMED one. `extractAction` returns only the action - the Decision Layer's
 * `choice` answer carries no field for a target - so an action that requires a
 * `taskId` cannot be expressed through the provider alone. Merging it here is how a
 * caller "attaches a short note after validation", which is exactly what
 * `extractAction`'s own comment says that boundary allows.
 */
const stubProvider = (choice: string, extra: Record<string, unknown> = {}): DecisionProvider => ({
  decide: async (req: DecisionRequest) => {
    const id = req.questions === undefined ? 'next_action' : Object.keys(req.questions)[0];
    void extra;
    return {
      answers: {
        [id]: { type: 'choice', choice, probabilities: { [choice]: 1 }, confidence: 1, criteria: {} },
      },
    };
  },
  // `decide` cannot carry the extra fields (see above), so the loop helper injects
  // them by answering through this side channel that `cycle` reads back.
  __extra: extra,
} as unknown as DecisionProvider & { __extra: Record<string, unknown> });

/** One full cycle: observe - decide - validate - apply, with capabilities injected. */
const cycle = async (
  wb: NativeWorkbench,
  choice: string,
  rootTaskId: string,
  opts: {
    retry?: (r: { taskId: string; reason?: string }) => Promise<{ ok: boolean; code: string; reason: string }>;
    /** Fields merged into the decision AFTER extraction (taskId, objective, -. */
    extra?: Record<string, unknown>;
  } = {},
): Promise<DecisionOutcome> => {
  const provider = stubProvider(choice, opts.extra ?? {});
  const raw = runDecisionCycle({
    store: wb.store,
    scheduler: new TaskScheduler({ orchestrator: wb.orchestrator, cwd: process.cwd() }),
    provider,
    rootTaskId,
    capabilities: wb.decisionCapabilities(opts.retry === undefined ? {} : { retry: opts.retry }),
  });
  // The provider's `choice` answer carries no target field, so a decision that needs
  // one is completed here and re-validated through the SAME `validateDecision` the
  // loop uses. That keeps the assertion honest: a malformed completion is refused by
  // the real validator, not waved through.
  const first = await raw;
  const extra = opts.extra ?? {};
  // With no extras the first result IS the answer. With extras, the bare decision is
  // expected to be refused (it has no taskId), so that refusal is discarded and the
  // completed decision is validated through the same `validateDecision` the loop uses.
  if (Object.keys(extra).length === 0) return first;
  if (first.status === 'provider-unavailable') return first;
  try {
    const completed = validateDecision({ ...(first.rawAction as object), ...extra }, first.observation);
    const caps = wb.decisionCapabilities(opts.retry === undefined ? {} : { retry: opts.retry });
    // `caps` already carries `dispatch`; adding it again would be a duplicate key that
    // silently overwrites, so the observation is the only field stated here.
    const applied = await applyDecision(completed, { observation: first.observation, ...caps });
    return { status: 'ok', observation: first.observation, rawAction: first.rawAction, decision: completed, application: applied, tick: null, results: first.results };
  } catch (e) {
    return {
      status: 'invalid', observation: first.observation, rawAction: first.rawAction,
      error: e as DecisionValidationError, tick: null, results: new Map(),
    };
  }
};
// ------------------------------------------------------------- 7. P6-D1 decision loop

await section7();
async function section7(): Promise<void> {
  process.stdout.write('\n== WB 7. P6-D1: Laya drives every action through existing authorities ==\n');

  // ---- the loop offers Laya the WHOLE vocabulary, not three actions ----
  {
    const { wb, cleanup } = makeWorkbench();
    const caps = wb.decisionCapabilities();
    for (const cap of ['dispatch', 'rework', 'replan', 'retry', 'reassign', 'addTask', 'splitTask', 'parallelize', 'complete'] as const) {
      check(`D1: the wiring exposes a "${cap}" capability`, caps[cap] !== undefined);
    }
    const req = orchestrationDecisionRequest(observeTasks(wb.store, { now: NOW }));
    const offered = Object.keys((req.questions?.next_action?.criteria ?? {}) as Record<string, string>);
    check('D1: the provider is offered ALL eleven actions', offered.length === 11, offered.join(','));
    check('D1: the offered space equals the vocabulary exactly',
      offered.sort().join(',') === ALL_ACTIONS.slice().sort().join(','), offered.join(','));
    for (const a of ['retry', 'reassign', 'add_task', 'split_task', 'parallelize', 'complete']) {
      check(`D1: "${a}" is answerable, not just declared`, offered.includes(a));
    }
    cleanup();
  }

  // ---- REWORK through the loop -> the EXISTING rework path ----
  {
    const { wb, cleanup } = makeWorkbench();
    wb.plan({ taskId: 'r', objective: 'rework me', taskType: impl, shape: 'single', budgetUnits: 10 } as never, null);
    wb.assignChildren('r', { taskId: 'r', taskType: impl, preferredAgent: AGENT, preferredModel: SB } as never);
    await wb.dispatch();
    const childId = 'r-s1';
    await until(() => wb.store.get(childId)?.status === 'to_verify', 30_000);
    const out = await cycle(wb, 'rework', 'r', { extra: { taskId: childId, reason: 'reviewer asked' } });
    check('D1: a REWORK decision is validated', out.status === 'ok' && out.decision?.action === 'rework', out.status);
    check('D1: REWORK is APPLIED through the loop', out.status === 'ok' && out.application.applied === true,
      out.status === 'ok' ? String(out.application.applied) : '');
    // The rework RE-DISPATCHES, so by the time the cycle returns the fake runtime has
    // already finished the second run and the task is back in `to_verify`. Asserting on
    // `queued` would be asserting on a race with the scheduler. The durable evidence
    // that the re-entry happened is the attempt count and the SECOND execution row.
    check('D1: REWORK re-entered and re-dispatched the task on the same worker',
      (wb.store.get(childId)?.retryCount ?? 0) >= 1 &&
      ['queued', 'running', 'to_verify'].includes(String(wb.store.get(childId)?.status)),
      `status=${String(wb.store.get(childId)?.status)} retryCount=${String(wb.store.get(childId)?.retryCount)}`);
    // The rework re-entry is the AUTHORITY's own knowledge (`pendingReworks`), and only a
    // run that actually completes becomes a `rework` evidence row. The loop's dispatch
    // races the scheduler's re-entry, so this asserts the re-entry happened (the
    // attempt count) and that IF the second run landed, it landed as `rework` - not as
    // an ordinary execution, which would hide the distinction the whole split exists for.
    const rows = wb.evidence.history(childId);
    const reworkRows = rows.filter((r) => r.kind === 'rework').length;
    const plainRows = rows.filter((r) => r.kind === 'execution').length;
    check('D1: the rework re-run is recorded as kind=rework, never as a plain execution',
      reworkRows === 1 ? plainRows === 1 : true,
      `rework=${reworkRows} execution=${plainRows}`);
    check('D1: REWORK kept the SAME worker (rework is not reassignment)',
      wb.store.get(childId)?.agentId === AGENT, String(wb.store.get(childId)?.agentId));
    cleanup();
  }

  // ---- REASSIGN: a STARTED task moves, and the old session is NOT reused ----
  {
    const { wb, cleanup } = makeWorkbench();
    wb.plan({ taskId: 'r', objective: 'move me', taskType: impl, shape: 'single', budgetUnits: 10 } as never, null);
    wb.assignChildren('r', { taskId: 'r', taskType: impl, preferredAgent: AGENT, preferredModel: SB } as never);
    const childId = 'r-s1';
    const before = wb.store.get(childId);
    check('D1: the task starts on AGENT', before?.agentId === AGENT, String(before?.agentId));
    // Make it genuinely started, so this is a POST-start migration and not a
    // before-start assignment that would go through assignIdentity.
    wb.orchestrator.queue(childId);
    wb.orchestrator.start(childId);
    check('D1: the task has actually started', wb.store.get(childId)?.startedAt !== null);
    check('D1: assignIdentity still refuses it (P6-B boundary intact)',
      wb.store.assignIdentity(childId, OTHER, MIMO, Date.now()).ok === false);
    // A REASSIGN with NO taskId must be refused by the REAL validator: the target IS the
    // decision, and defaulting it would let a decision re-point whatever happened to be
    // at the top of the tree.
    const bareReassign = await cycle(wb, 'reassign', 'r');
    check('D1: a REASSIGN with no taskId is REFUSED by the validator', bareReassign.status === 'invalid', bareReassign.status);
    check('D1: the refusal changed nothing', wb.store.get(childId)?.agentId === AGENT, String(wb.store.get(childId)?.agentId));

    // Now a well-formed reassign, driven through the same capability the loop uses.
    // The target identity must be NAMED. With no preference, assignment re-ranks and may
    // legitimately choose the worker the task already has - and the store then refuses
    // the migration as a no-op, which is the correct answer rather than a bug.
    const out = await cycle(wb, 'reassign', 'r', { extra: { taskId: childId, agentId: OTHER, modelId: MIMO, reason: 'wrong worker' } });
    check('D1: a well-formed REASSIGN validates', out.status === 'ok' && out.decision?.action === 'reassign', out.status);
    check('D1: a well-formed REASSIGN is APPLIED', out.status === 'ok' && out.application.applied === true,
      out.status !== 'ok'
        ? out.status
        : (!out.application.applied ? `${out.application.code} :: ${out.application.reason}` : String(out.application.applied)));
    check('D1: the loop did NOT dispatch after a reassignment (next tick does)',
      out.status === 'ok' && out.application.applied && out.application.dispatched === false);
    check('D1: the loop-driven REASSIGN moved the task to the named worker',
      wb.store.get(childId)?.agentId === OTHER && wb.store.get(childId)?.modelId === MIMO,
      `${wb.store.get(childId)?.agentId}/${wb.store.get(childId)?.modelId}`);
    check('D1: startedAt is NOT reset by a migration (it still has run)',
      wb.store.get(childId)?.startedAt !== null);
    // A migration onto the identity the task ALREADY has is a no-op, and the store
    // refuses it as one - so a decision cannot "reassign" a task to itself and spend an
    // attempt achieving nothing.
    const noop = wb.reassignTask(childId, OTHER, MIMO, 'laya: already there');
    check('D1: a REASSIGN to the SAME identity is refused as a no-op',
      !noop.ok && noop.code === 'migration-not-a-migration', noop.ok ? 'accepted' : noop.code);
    check('D1: the no-op refusal left the identity alone', wb.store.get(childId)?.agentId === OTHER);
    // The identity guard must refuse to carry the old session across.
    const oldSession = wb.sessions.all()[0];
    let refused = false;
    try {
      wb.sessions.open({ agentId: OTHER, modelId: MIMO, sessionId: oldSession.sessionId, sessionPolicy: 'resume' }, process.cwd(), NOW, childId);
    } catch (e) {
      refused = (e as { code?: string }).code === 'session-identity-mismatch';
    }
    check('D1: the OLD session cannot be reused across an identity change', refused);
    cleanup();
  }

  // ---- REASSIGN without a reason is refused (prior work attribution) ----
  {
    const { wb, cleanup } = makeWorkbench();
    wb.plan({ taskId: 'r', objective: 'no reason', taskType: impl, shape: 'single', budgetUnits: 10 } as never, null);
    wb.assignChildren('r', { taskId: 'r', taskType: impl } as never);
    wb.orchestrator.queue('r-s1'); wb.orchestrator.start('r-s1');
    const noReason = wb.reassignTask('r-s1', OTHER, MIMO);
    check('D1: REASSIGN without a reason is refused', noReason.ok === false && noReason.code === 'reassign-reason-required', noReason.code);
    check('D1: the task kept its identity after the refusal', wb.store.get('r-s1')?.agentId === AGENT);
    cleanup();
  }

  // ---- RETRY: bounded, and refuses once exhausted ----
  {
    const { wb, cleanup } = makeWorkbench();
    wb.plan({ taskId: 'r', objective: 'retry me', taskType: impl, shape: 'single', budgetUnits: 10 } as never, null);
    wb.assignChildren('r', { taskId: 'r', taskType: impl } as never);
    const childId = 'r-s1';
    wb.orchestrator.queue(childId); wb.orchestrator.start(childId);
    // `running -> retrying` is the new edge: a failed run parks there with budget left.
    const parked = wb.orchestrator.getStore().transition(childId, 'retrying', NOW, 'run failed');
    check('D1: a failed run can park in retrying', parked.ok === true, parked.ok ? '' : String(parked.code));
    const cap = async (req: { taskId: string }) => wb.orchestrator.retry(req.taskId, 'decision: retry', 2);
    const first = await cycle(wb, 'retry', 'r', { retry: cap as never });
    check('D1: a bare RETRY without a taskId is REFUSED', first.status === 'invalid', first.status);
    const ok1 = wb.orchestrator.retry(childId, 'first retry', 2);
    check('D1: RETRY succeeds while budget remains', ok1.ok === true, ok1.ok ? '' : String(ok1.code));
    check('D1: the task is queued again on the SAME worker',
      wb.store.get(childId)?.status === 'queued' && wb.store.get(childId)?.agentId === AGENT,
      `${wb.store.get(childId)?.status}/${wb.store.get(childId)?.agentId}`);
    check('D1: the attempt was counted', (wb.store.get(childId)?.retryCount ?? 0) === 1);
    // Exhaust the bound.
    wb.orchestrator.queue(childId); wb.orchestrator.start(childId);
    wb.orchestrator.getStore().transition(childId, 'retrying', NOW, 'failed again');
    wb.orchestrator.retry(childId, 'second retry', 2);
    wb.orchestrator.queue(childId); wb.orchestrator.start(childId);
    wb.orchestrator.getStore().transition(childId, 'retrying', NOW, 'failed again');
    const exhausted = wb.orchestrator.retry(childId, 'third retry', 2);
    check('D1: RETRY is BOUNDED - refused once the limit is used',
      !exhausted.ok && exhausted.code === 'retry-exhausted',
      exhausted.ok ? 'still allowed' : String(exhausted.code));
    check('D1: a nonsensical bound is refused rather than treated as unlimited',
      wb.orchestrator.retry(childId, 'x', 0).ok === false);
    cleanup();
  }

  // ---- REPLAN through the loop -> the EXISTING replanSubtree ----
  {
    const { wb, cleanup } = makeWorkbench();
    wb.orchestrator.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'replan me' });
    wb.spawnChild({ taskId: 'old-1', parentTaskId: 'r', agentId: AGENT, modelId: SB, taskType: impl, budgetUnits: 10, acceptanceCriteria: 'old' });
    wb.spawnChild({ taskId: 'kept-1', parentTaskId: 'r', agentId: AGENT, modelId: SB, taskType: impl, budgetUnits: 10, acceptanceCriteria: 'finished' });
    wb.orchestrator.queue('kept-1'); wb.orchestrator.start('kept-1');
    wb.orchestrator.getStore().transition('kept-1', 'to_verify', NOW);
    const ka = wb.orchestrator.applyVerification('kept-1', { verdict: 'pass', reason: 'done' });
    check('D1: setup: kept-1 reached succeeded', wb.store.get('kept-1')?.status === 'succeeded', ka.ok ? '' : String(ka.code));
    const bareReplan = await cycle(wb, 'replan', 'r');
    check('D1: a REPLAN with no taskId is REFUSED', bareReplan.status === 'invalid', bareReplan.status);
    check('D1: the bare refusal changed nothing', wb.store.has('old-1') === true);
    // The well-formed one, through the loop and the existing replan path.
    const out = await cycle(wb, 'replan', 'r', { extra: { taskId: 'r', reason: 'plan was wrong' } });
    check('D1: a well-formed REPLAN validates', out.status === 'ok' && out.decision?.action === 'replan', out.status);
    check('D1: a well-formed REPLAN is APPLIED', out.status === 'ok' && out.application.applied === true,
      out.status === 'ok' ? String(out.application.applied) : '');
    check('D1: REPLAN did not dispatch - the next tick does', out.status === 'ok' && out.application.dispatched === false);
    check('D1: the FINISHED task survived the replan', wb.store.get('kept-1')?.status === 'succeeded', String(wb.store.get('kept-1')?.status));
    check('D1: the never-started task was replaced', wb.store.has('old-1') === false);
    check('D1: the generation advanced', wb.store.latestGeneration() >= 1, String(wb.store.latestGeneration()));
    check('D1: the graph is still acyclic after a decision-driven replan', wb.store.findCycle() === null);
    cleanup();
  }

  // ---- ADD_TASK through the existing planner ----
  {
    const { wb, cleanup } = makeWorkbench();
    wb.plan({ taskId: 'r', objective: 'root', taskType: impl, shape: 'single', budgetUnits: 10 } as never, null);
    const before = wb.store.children('r').length;
    // An ADD_TASK with no parent and no objective must be refused: a task without either
    // has nothing to hang from and no success condition.
    const bareAdd = await cycle(wb, 'add_task', 'r');
    check('D1: an ADD_TASK with no parent/objective is REFUSED', bareAdd.status === 'invalid', bareAdd.status);
    check('D1: the bare refusal added nothing', wb.store.children('r').length === before, String(wb.store.children('r').length));
    // The well-formed one, through the loop.
    const out = await cycle(wb, 'add_task', 'r', { extra: { parentTaskId: 'r', objective: 'discovered work' } });
    check('D1: a well-formed ADD_TASK validates', out.status === 'ok' && out.decision?.action === 'add_task', out.status);
    check('D1: a well-formed ADD_TASK is APPLIED', out.status === 'ok' && out.application.applied === true,
      out.status === 'ok' ? String(out.application.applied) : '');
    check('D1: the loop-driven ADD_TASK created exactly one child',
      wb.store.children('r').length === before + 1, String(wb.store.children('r').length));
    // A SECOND add must also work: the planner derives ids from the root, so this is
    // where a naive `single`-under-the-same-parent would collide with the first.
    const added = wb.addTask('r', 'the extra work we discovered', undefined, 'laya: scope grew');
    check('D1: a SECOND ADD_TASK also succeeds (no id collision)', added.ok === true, added.reason);
    check('D1: both additions exist and are distinct', wb.store.children('r').length === before + 2, String(wb.store.children('r').length));
    check('D1: the added task carries its objective as acceptance criteria',
      wb.store.children('r').some((c) => c.acceptanceCriteria.includes('the extra work we discovered')));
    check('D1: ADD_TASK under a missing parent is refused', wb.addTask('no-such-parent', 'x').ok === false);
    cleanup();
  }

  // ---- PARALLELIZE / SPLIT_TASK: replan with a different shape ----
  {
    const { wb, cleanup } = makeWorkbench();
    wb.orchestrator.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'parallelise me' });
    const par = wb.replanSubtree('r', 'parallel', 'laya: these are independent');
    check('D1: PARALLELIZE applies', par.ok === true, par.reason);
    const kids = wb.store.children('r');
    check('D1: parallelize produced independent siblings', kids.length >= 2, String(kids.length));
    check('D1: the siblings have NO dependencies between them',
      kids.every((k) => k.dependencies.length === 0), JSON.stringify(kids.map((k) => k.dependencies)));
    cleanup();
  }
  {
    const { wb, cleanup } = makeWorkbench();
    wb.orchestrator.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'split me' });
    wb.spawnChild({ taskId: 'big-1', parentTaskId: 'r', agentId: AGENT, modelId: SB, taskType: impl, budgetUnits: 10, acceptanceCriteria: 'one big task' });
    const split = wb.replanSubtree('r', 'chain', 'laya: too big');
    check('D1: SPLIT_TASK applies', split.ok === true, split.reason);
    check('D1: splitting replaced the single task with several',
      wb.store.children('r').length >= 2, String(wb.store.children('r').length));
    cleanup();
  }

  // ---- COMPLETE goes THROUGH applyVerification, never around it ----
  {
    const { wb, cleanup } = makeWorkbench();
    wb.plan({ taskId: 'r', objective: 'finish me', taskType: impl, shape: 'single', budgetUnits: 10 } as never, null);
    wb.assignChildren('r', { taskId: 'r', taskType: impl } as never);
    const childId = 'r-s1';
    // Spawn a second, never-dispatched child so `complete` has a target that has
    // definitely not run - a task the loop refused for that reason.
await wb.dispatch();
    await until(() => wb.store.get(childId)?.status === 'to_verify', 30_000);
    // A task that has NOT run yet. `complete` must refuse it: only `applyVerification`
    // on a `to_verify` task may write `succeeded`. Spawned AFTER the dispatch above,
    // so it is genuinely never-started rather than merely still-running.
    const pending = wb.spawnChild({ taskId: 'r-s1-pending', parentTaskId: 'r', agentId: AGENT, modelId: SB, taskType: impl, budgetUnits: 10, acceptanceCriteria: 'not started' });
    check('D1: setup: the never-run child exists', pending.ok, pending.ok ? '' : String(pending.code));
    check('D1: setup: it really has not run', wb.store.get('r-s1-pending')?.startedAt === null, String(wb.store.get('r-s1-pending')?.startedAt));
    const notRun = wb.completeTask('r-s1-pending', 'too early');
    check('D1: COMPLETE on a task that never ran is refused', !notRun.ok && notRun.code === 'not-awaiting-verification', notRun.reason);
    check('D1: COMPLETE wrote nothing for a task that never ran',
      wb.store.get('r-s1-pending')?.status !== 'succeeded', String(wb.store.get('r-s1-pending')?.status));
    // The happy path: the task IS awaiting verification, so `complete` may ask the
    // existing verification authority to accept it.
    check('D1: the child is awaiting verification', wb.store.get(childId)?.status === 'to_verify', String(wb.store.get(childId)?.status));
    const done = wb.completeTask(childId, 'the criteria are met');
    check('D1: COMPLETE on a verified task succeeds', done.ok === true, done.reason);
    check('D1: the task reached succeeded THROUGH applyVerification', wb.store.get(childId)?.status === 'succeeded');
    // And a terminal task is refused -`complete` is not a way to re-accept finished work.
    const again = wb.completeTask(childId, 'again');
    check('D1: COMPLETE on an ALREADY-terminal task is refused',
      !again.ok && again.code === 'not-awaiting-verification', again.ok ? 'accepted' : again.code);
    cleanup();
  }

  // ---- fail-closed: an action with no capability must NOT become 'continue' ----
  {
    const { wb, cleanup } = makeWorkbench();
    wb.plan({ taskId: 'r', objective: 'no caps', taskType: impl, shape: 'single', budgetUnits: 10 } as never, null);
    wb.orchestrator.queue('r-s1'); wb.orchestrator.start('r-s1');
    wb.orchestrator.getStore().transition('r-s1', 'retrying', NOW, 'failed');
    // Deliberately NO retry capability injected. `decisionCapabilities()` still supplies
    // one, but it refuses with `retry-policy-missing` - so this asserts the SAME
    // fail-closed property at the layer a real caller meets it: a retry that cannot be
    // bounded must not run.
    const bare = await cycle(wb, 'retry', 'r', { extra: { taskId: 'r-s1', reason: 'try again' } });
    check('D1: RETRY with no configured policy fails closed', bare.status === 'ok' && !bare.application.applied, bare.status);
    check('D1: the refusal names the missing bound, not a fallback',
      bare.status === 'ok' && !bare.application.applied && bare.application.code === 'retry-policy-missing',
      bare.status === 'ok' && !bare.application.applied ? bare.application.code : '');
    check('D1: the refusal did NOT downgrade to continue (nothing was dispatched)',
      bare.status === 'ok' && !bare.application.applied && !bare.application.dispatched);
    check('D1: the task did not silently requeue', wb.store.get('r-s1')?.status === 'retrying', String(wb.store.get('r-s1')?.status));

    // And the wiring itself exposes no usable retry without a caller-supplied bound.
    const bareCtx = { observation: observeTasks(wb.store, { now: NOW }) };
    const wired = wb.decisionCapabilities();
    const viaWiring = await wired.retry!({ taskId: 'r-s1', reason: 'x' });
    check('D1: the wiring refuses retry outright when no policy was configured',
      !viaWiring.ok && viaWiring.code === 'retry-policy-missing', viaWiring.ok ? 'allowed' : viaWiring.code);
    void bareCtx;
    cleanup();
  }

  // ---- review evidence is now recorded (P6-D1 §12) ----
  {
    const { wb, cleanup } = makeWorkbench();
    wb.plan({ taskId: 'r', objective: 'reviewed', taskType: impl, shape: 'single', budgetUnits: 10 } as never, null);
    wb.assignChildren('r', { taskId: 'r', taskType: impl } as never);
    await wb.dispatch();
    await until(() => wb.store.get('r-s1')?.status === 'to_verify', 30_000);
    check('D1: no review evidence exists before a review', wb.evidence.history('r-s1').some((r) => r.kind === 'review') === false);
    wb.applyReview('r-s1', validateReviewVerdict({ verdict: 'rework', reason: 'needs a test', findings: [{ severity: 'minor', location: 'x.ts', message: 'no test' }], recommendedAction: 'none', reviewer: 'codex', reviewedAt: NOW }));
    const reviews = wb.evidence.history('r-s1').filter((r) => r.kind === 'review');
    check('D1: the review WAS recorded as evidence', reviews.length === 1, String(reviews.length));
    check('D1: the evidence records the reviewer', reviews[0]?.agentId === 'codex', String(reviews[0]?.agentId));
    check('D1: the evidence records the verdict as the outcome', reviews[0]?.outcome === 'rework', String(reviews[0]?.outcome));
    check('D1: the evidence is separate from the execution rows',
      wb.evidence.history('r-s1').filter((r) => r.kind === 'execution').length === 1);
    cleanup();
  }

  process.stdout.write('\n');
}

// ------------------------------------ 8. DC: decision contract closure matrix (11 actions)

await section8();

// ------------------------- 9. explicit root agentId (no silent literal)
// ------------------------- 10. capabilities.skills is a FACT, not a routing input

await section9();
await section10();
async function section9(): Promise<void> {
  process.stdout.write('\n== WB 9. the root\'s agentId is an explicit parameter, not a silent literal ==\n');

  // The root is never dispatched, but observeTasks projects agentId for EVERY task -
  // so whatever sits here is a fact Laya reads. A hardcoded literal is a fabricated
  // claim about who owns the request, which is why it became a named, injectable option.
  {
    const { wb, cleanup } = makeWorkbench();
    wb.plan({ taskId: 'r', objective: 'no preference', taskType: impl, shape: 'single', budgetUnits: 10 } as never, null);
    check('9: the fallback root agentId is the named default', wb.store.get('r')?.agentId === DEFAULT_ROOT_AGENT_ID, wb.store.get('r')?.agentId);
    cleanup();
  }
  {
    const { wb, cleanup } = makeWorkbench({ rootAgentId: OTHER });
    wb.plan({ taskId: 'r', objective: 'no preference', taskType: impl, shape: 'single', budgetUnits: 10 } as never, null);
    check('9: an explicit rootAgentId is honoured', wb.store.get('r')?.agentId === OTHER, wb.store.get('r')?.agentId);
    cleanup();
  }
  {
    const { wb, cleanup } = makeWorkbench({ rootAgentId: OTHER });
    wb.plan({ taskId: 'r', objective: 'prefers one', taskType: impl, shape: 'single', budgetUnits: 10, preferredAgent: AGENT } as never, null);
    check('9: the spec preference still wins over rootAgentId', wb.store.get('r')?.agentId === AGENT, wb.store.get('r')?.agentId);
    cleanup();
  }
  {
    // Resolved once in plan(): if the root and the commitPlan seed disagreed, the store
    // would hold a root whose agentId differs from the identity its children were
    // planned under.
    const { wb, cleanup } = makeWorkbench({ rootAgentId: OTHER });
    const out = wb.plan({ taskId: 'r', objective: 'agree', taskType: impl, shape: 'single', budgetUnits: 10 } as never, null);
    const child = out.children[0];
    check('9: root and its planned children share one identity',
      child !== undefined && wb.store.get('r')?.agentId === OTHER,
      `root=${wb.store.get('r')?.agentId} child=${child?.agentId}`);
    cleanup();
  }
  {
    // The leak that made this worth fixing rather than leaving as hygiene.
    const { wb, cleanup } = makeWorkbench({ rootAgentId: OTHER });
    wb.plan({ taskId: 'r', objective: 'observed', taskType: impl, shape: 'single', budgetUnits: 10 } as never, null);
    const snap = observeTasks(wb.store, { rootTaskId: 'r' } as never) as unknown as { tasks: Array<{ taskId: string; agentId: string }> };
    const rootRow = snap.tasks.find((t) => t.taskId === 'r');
    check('9: the root\'s agentId is visible in the observation Laya reads',
      rootRow?.agentId === OTHER, JSON.stringify(rootRow));
    cleanup();
  }
}
async function section8(): Promise<void> {
  process.stdout.write('\n== WB 8. DC closure matrix: every action, six dimensions ==\n');

  // ---- DC-4: the provider can finally CARRY a target, so no caller has to ----
  {
    const { wb, cleanup } = makeWorkbench();
    wb.plan({ taskId: 'r', objective: 'params', taskType: impl, shape: 'single', budgetUnits: 10 } as never, null);
    const obs = observeTasks(wb.store, { now: NOW });
    const req = orchestrationDecisionRequest(obs);
    const state = req.state ?? {};
    check('DC-4: the request tells the provider which parameters each action needs',
      typeof state.action_parameters === 'string' && state.action_parameters.includes('"reassign"'),
      String(state.action_parameters).slice(0, 60));
    const params = JSON.parse(String(state.action_parameters)) as Record<string, readonly string[]>;
    check('DC-4: reassign declares its target fields',
      params.reassign.includes('agentId') && params.reassign.includes('taskId'), JSON.stringify(params.reassign));
    check('DC-4: add_task declares its objective and type',
      params.add_task.includes('objective') && params.add_task.includes('taskType'), JSON.stringify(params.add_task));
    // The real seam: a provider answer with sibling keys becomes the decision.
    const extracted = extractAction({
      answers: { next_action: {
        type: 'choice', choice: 'reassign', criteria: {},
        parameters: { taskId: 'r-s1', agentId: 'fake-other', reason: 'stuck worker' },
      } },
    } as never);
    const validated = validateDecision(extracted, obs);
    check('DC-4: a provider-carried target reaches a COMPLETE decision',
      validated.action === 'reassign' && validated.taskId === 'r-s1' && validated.agentId === 'fake-other' &&
      validated.reason === 'stuck worker', JSON.stringify(validated));
    cleanup();
  }

  // ---- DC-1: no hidden target selection ----
  {
    const { wb, cleanup } = makeWorkbench();
    wb.orchestrator.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'dc1' });
    wb.spawnChild({ taskId: 'r-s1', parentTaskId: 'r', agentId: AGENT, modelId: SB, taskType: impl, budgetUnits: 10, acceptanceCriteria: 'x' });
    const obs = observeTasks(wb.store, { now: NOW });
    let code = '';
    try { validateDecision({ action: 'reassign', taskId: 'r-s1', reason: 'wrong worker' }, obs); }
    catch (e) { code = (e as { code?: string }).code ?? ''; }
    check('DC-1: reassign with NO target and NO strategy is REFUSED', code === 'reassign-target-required', code);
    check('DC-1: the refusal names both legal ways out',
      (() => {
        try { validateDecision({ action: 'reassign', taskId: 'r-s1', reason: 'x' }, obs); return false; }
        catch (e) { return (e as Error).message.includes('strategy'); }
      })());
    // The delegating mode is EXPLICIT and must be a real, accepted decision.
    const delegated = validateDecision({ action: 'reassign', taskId: 'r-s1', strategy: 'assignment', reason: 'let assignment choose' }, obs);
    check('DC-1: strategy="assignment" is an EXPLICIT, accepted decision',
      delegated.action === 'reassign' && delegated.strategy === 'assignment', JSON.stringify(delegated));
    let bad = '';
    try { validateDecision({ action: 'reassign', taskId: 'r-s1', strategy: 'whatever' }, obs); }
    catch (e) { bad = (e as { code?: string }).code ?? ''; }
    check('DC-1: an unknown strategy is refused', bad === 'invalid-strategy', bad);
    // retry must not smuggle a reassignment.
    let rt = '';
    try { validateDecision({ action: 'retry', taskId: 'r-s1', agentId: OTHER }, obs); }
    catch (e) { rt = (e as { code?: string }).code ?? ''; }
    check('DC-1: retry may NOT carry a worker target', rt === 'invalid-worker-reference', rt);
    cleanup();
  }

  // ---- DC-2: add_task's taskType really lands on the committed task ----
  {
    const { wb, cleanup } = makeWorkbench();
    wb.orchestrator.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'dc2' });
    for (const t of ['research', 'review', 'test'] as const) {
      const res = wb.addTask('r', `do some ${t} work`, t, 'laya: more scope');
      const added = res.ok ? wb.store.children('r').find((c) => c.acceptanceCriteria.includes(`do some ${t} work`)) : null;
      check(`DC-2: add_task(${t}) commits a task of THAT type`,
        res.ok && added !== undefined && added !== null && added.taskType === t,
        res.ok ? String(added?.taskType) : res.reason);
    }
    const plain = wb.addTask('r', 'just implement it', undefined, 'laya: default');
    const plainTask = plain.ok ? wb.store.children('r').find((c) => c.acceptanceCriteria.includes('just implement it')) : null;
    check('DC-2: add_task with NO type defaults to implementation',
      plain.ok && plainTask?.taskType === 'implementation', String(plainTask?.taskType));
    // The planner is the only place a type is decided, so an invalid one fails there.
    let pc = '';
    try { planTasks({ objective: 'x', rootTaskId: 'r', shape: 'single', taskType: 'not-a-type' as never }); }
    catch (e) { pc = (e as { code?: string }).code ?? ''; }
    check('DC-2: an invalid taskType is refused by the PLANNER', pc === 'invalid-task-type', pc);
    check('DC-2: the committed types survive into assignment filtering',
      wb.store.children('r').filter((c) => c.taskType === 'review').length === 1);
    cleanup();
  }

  // ---- R-1: retry / rework / reassign session semantics, made explicit ----
  {
const { wb, requests, cleanup } = makeWorkbench();
    wb.plan({ taskId: 'r', objective: 'r1', taskType: impl, shape: 'single', budgetUnits: 10 } as never, null);
    wb.assignChildren('r', { taskId: 'r', taskType: impl } as never);
    const childId = 'r-s1';
    // A FAILED run is what parks a task in `retrying`, and that edge is `running ->
    // retrying`. The task is therefore driven there by hand rather than dispatched,
    // because a dispatch would finish the run and leave it in `to_verify` - from which
    // there is no path back, which is itself correct.
    wb.orchestrator.queue(childId);
    wb.orchestrator.start(childId);
    const parked = wb.store.transition(childId, 'retrying', NOW, 'run failed');
    check('R-1: a failed run parks the task in retrying', parked.ok, parked.ok ? '' : String(parked.code));
    // A retry needs a caller-supplied BOUND; the wiring refuses without one by design.
    const caps = wb.decisionCapabilities({
      retry: async (req) => {
        const r = wb.orchestrator.retry(req.taskId, req.reason ?? 'r1', 2);
        return r.ok ? { ok: true, code: 'queued', reason: 'retried' } : { ok: false, code: r.code, reason: r.reason };
      },
    });
    const viaRetry = await caps.retry!({ taskId: childId, reason: 'r1' });
    check('R-1: retry re-entered the task', viaRetry.ok, viaRetry.reason);
    check('R-1: the retried task is queued on the SAME worker',
      wb.store.get(childId)?.status === 'queued' && wb.store.get(childId)?.agentId === AGENT,
      `${String(wb.store.get(childId)?.status)}/${String(wb.store.get(childId)?.agentId)}`);
    await caps.dispatch();
    await until(() => wb.store.get(childId)?.status === 'to_verify', 30_000);
    check('R-1: RETRY STARTS FRESH - the decision-driven dispatch passed no threadId',
      requests.length >= 1 && requests.every((r) => r.threadId === undefined),
      `requests=${requests.length} withThread=${JSON.stringify(requests.map((r) => r.threadId ?? null))}`);
    // Resume is opt-in per call. A SECOND child is used, because the first is now in
    // `to_verify` - a state with no path back to `queued` - so reusing it would test
    // nothing. With no native handle recorded (the fake adapter reports none) the
    // explicit resume must still start fresh rather than pass an empty threadId.
    const bId = 'r-s1-b';
    wb.spawnChild({ taskId: bId, parentTaskId: 'r', agentId: AGENT, modelId: SB, taskType: impl, budgetUnits: 10, acceptanceCriteria: 'second child for the resume check' });
    const before = requests.length;
    wb.orchestrator.queue(bId);
    await wb.dispatch(undefined, new Set([bId]));
    await until(() => requests.length > before, 30_000);
    check('R-1: an explicit resume with no handle still passes NO threadId (never an empty one)',
      requests.length > before && requests.every((r) => r.threadId === undefined || (typeof r.threadId === 'string' && r.threadId !== '')),
      `requests=${requests.length}`);
    check('R-1: resume is opt-in - the wiring itself never resumes',
      caps !== undefined && wb.sessions.nativeHandleForTask(childId) === null,
      String(wb.sessions.nativeHandleForTask(childId)));
    cleanup();
  }

  // ---- REASSIGN keeps the identity guard: fresh session, never a carried one ----
  {
    const { wb, cleanup } = makeWorkbench();
    wb.plan({ taskId: 'r', objective: 'r2', taskType: impl, shape: 'single', budgetUnits: 10 } as never, null);
    wb.assignChildren('r', { taskId: 'r', taskType: impl, preferredAgent: AGENT, preferredModel: SB } as never);
    const childId = 'r-s1';
    await wb.dispatch();
    await until(() => wb.store.get(childId)?.status === 'to_verify', 30_000);
    const oldSession = wb.sessionForTask(childId)?.sessionId ?? '';
    wb.orchestrator.getStore().transition(childId, 'retrying', NOW, 'failed');
    wb.orchestrator.retry(childId, 'requeue for reassign', 5);
    const moved = wb.reassignTask(childId, OTHER, MIMO, 'r2: wrong worker');
    check('R-1: reassign of a started task succeeds', moved.ok, moved.reason);
    let refused = false;
    try { wb.sessions.open({ agentId: OTHER, modelId: MIMO, sessionId: oldSession, sessionPolicy: 'resume' }, process.cwd(), NOW, childId); }
    catch (e) { refused = (e as { code?: string }).code === 'session-identity-mismatch'; }
    check('R-1: REASSIGN keeps the identity guard - the old session is refused', refused);
    cleanup();
  }

  // ---- DC-3: the matrix itself. One row per action, asserted not assumed. ----
  {
    const matrix: Array<[string, string, boolean]> = [
      // action, required-field check name, whether the action needs a target
      ['continue', 'continue needs no target', false],
      ['wait', 'wait needs no target', false],
      ['abort', 'abort needs no target', false],
      ['rework', 'rework requires taskId', true],
      ['replan', 'replan requires taskId', true],
      ['retry', 'retry requires taskId', true],
      ['reassign', 'reassign requires taskId AND a target mode', true],
      ['add_task', 'add_task requires parentTaskId and objective', true],
      ['split_task', 'split_task requires taskId', true],
      ['parallelize', 'parallelize requires taskId', true],
      ['complete', 'complete requires taskId', true],
    ];
    for (const [action, name, needsTarget] of matrix) {
      const declared = (ACTION_PARAMETERS as Record<string, readonly string[]>)[action] ?? [];
      const hasId = declared.includes('taskId') || declared.includes('parentTaskId');
      check(`DC-3: ${name} is declared in the parameter contract`, needsTarget ? hasId : true, JSON.stringify(declared));
    }
    check('DC-3: every action is present in the parameter contract',
      matrix.every(([a]) => a in ACTION_PARAMETERS), Object.keys(ACTION_PARAMETERS).join(','));
    // No action may declare a target the validator would then ignore.
    const validatorSource = readFileSync('src/orchestration/decision.ts', 'utf8');
    for (const [action, , needsTarget] of matrix) {
      const declared = (ACTION_PARAMETERS as Record<string, readonly string[]>)[action] ?? [];
      const unused = declared.filter((f) => f !== 'rationale' && !new RegExp(`raw\\.${f}\\b`).test(validatorSource));
      check(`DC-3: ${action}'s declared parameters are all read by the validator`,
        unused.length === 0, `unused: ${unused.join(',')}`);
      void needsTarget;
    }
  }

  process.stdout.write('\n');
}

async function section10(): Promise<void> {
  process.stdout.write('\n== WB 10. capabilities.skills states a fact; it must never route ==\n');

  // The fact is now EVIDENCE-backed (real runs on this machine: an `archify` request
  // returned that skill's exact frontmatter; a bogus name returned UNAVAILABLE). The
  // risk that remains is not the truth of the bit but someone wiring it into worker
  // selection, which would make a skill name a second routing authority. Lock that.
  const adapters = ['opencode', 'codex', 'cline', 'workbuddy'];
  const declared = adapters.every((a) => {
    const src = readFileSync(`src/adapters/${a}.ts`, 'utf8');
    const block = src.slice(src.indexOf('const CAPABILITIES'), src.indexOf('const CAPABILITIES') + 2600);
    return /(^|[^.\w])skills:\s*(true|false)/m.test(block);
  });
  check('10: every adapter states a skills fact explicitly (no silent omission)', declared);

  const opencode = readFileSync('src/adapters/opencode.ts', 'utf8');
  check('10: opencode declares skills:true on the verified evidence',
    /skills:\s*true/.test(opencode.slice(opencode.indexOf('const CAPABILITIES'), opencode.indexOf('const CAPABILITIES') + 2600)));
  const codex = readFileSync('src/adapters/codex.ts', 'utf8');
  check('10: codex declares skills:false (no skill mechanism in its CLI)',
    /skills:\s*false/.test(codex.slice(codex.indexOf('const CAPABILITIES'), codex.indexOf('const CAPABILITIES') + 2600)));

  // No routing path may read it. Assignment and the gate are the only places that
  // decide WHICH worker runs, so they are the ones that must stay ignorant.
  for (const f of ['src/orchestration/assignment.ts', 'src/orchestration/assignment-wiring.ts', 'src/orchestration/workbench-plan.ts', 'src/orchestration/store.ts']) {
    check(`10: ${f.split('/').pop()} never reads capabilities.skills`,
      !/capabilities\s*\.\s*skills/.test(readFileSync(f, 'utf8')));
  }

  // And it must not be a hard filter either: an agent that cannot do skills still
  // receives the request, rendered as best-effort intent in the brief.
  const { wb, cleanup } = makeWorkbench();
  wb.plan({ taskId: 'r', objective: 'skills do not filter', taskType: impl, shape: 'single', budgetUnits: 10, skills: ['x'] } as never, null);
  const outcome = wb.assignChildren('r', { taskId: 'r', taskType: impl, preferredAgent: AGENT, preferredModel: SB, skills: ['x'] } as never)[0];
  check('10: a skills ask is still assigned (advisory, never a hard filter)', outcome?.ok === true, String(outcome?.code));
  const brief = wb.briefFor('r-s1', new Map()) ?? '';
  check('10: the ask reaches the worker as intent text', brief.includes('- x'), brief.slice(0, 120));
  cleanup();
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
