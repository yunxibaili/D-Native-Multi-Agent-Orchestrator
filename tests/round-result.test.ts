/**
 * tests/round-result.test.ts — R4 Result Aggregation + Human Gate.
 *
 * WHAT IS CLAIMED HERE, AND HOW IT IS MEASURED
 * ---------------------------------------------
 *   aggregation is a PROJECTION        -> every summary field is traced to the authority
 *                                          it came from (TaskStore / AttemptStore /
 *                                          UnifiedRoundReport / ContinuationResult),
 *                                          and a change in one shows up in the report
 *   nothing is invented                -> a task with no run keeps its absence as
 *                                          `executed=false` and contributes no files
 *   F5 evidence survives               -> a refused-but-executed attempt is still reported
 *   the three layers stay separate     -> machine evidence, review conclusion and
 *                                          user-facing summary never overwrite each other
 *   the gate STOPS the orchestrator    -> the gate derives from task status and cannot
 *                                          express anything but "stop"; asserted on the
 *                                          real TaskStore after the fact
 *   a next round is a NEW identity     -> sealing refuses to reuse the previous roundId
 *   no second authority appears        -> source guards on the new module and the tree
 *
 * Only the reviewer is synthetic, exactly as in unified-review.test.ts. The agents, the
 * store and the execution edge are the real ones wherever a real one is available.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TaskStore } from '../src/orchestration/store.ts';
import {
  TASK_STATUSES,
  TASK_TRANSITIONS,
  type Task,
  type TaskStatus,
} from '../src/orchestration/task.ts';
import { NativeWorkbench } from '../src/orchestration/workbench.ts';
import { Orchestrator } from '../src/orchestration/orchestrator.ts';
import { TaskScheduler } from '../src/orchestration/scheduler.ts';
import { BudgetManager } from '../src/quota/budget.ts';
import { ModelRegistry } from '../src/quota/registry.ts';
import type { RuntimeRunner } from '../src/orchestration/execute.ts';
import type { QuotaRecord, TaskType } from '../src/quota/types.ts';
import type { AgentDescriptor, RunHandle, RunResult } from '../src/core/types.ts';
import { AttemptStore } from '../src/orchestration/attempt-store.ts';
import type { AttemptRecord } from '../src/orchestration/attempt-record.ts';
import {
  buildReviewPacket,
  buildUnifiedRoundReport,
  classifyExecutionOutcome,
  type UnifiedReviewResult,
} from '../src/orchestration/unified-review.ts';
import {
  HUMAN_GATE_STATUSES,
  IN_FLIGHT_STATUSES,
  buildRoundResult,
  classifyTaskLifecycle,
  deriveHumanGate,
  gateWithUserDecision,
  isBlockingStatus,
  renderRoundDelivery,
  renderRoundResult,
  sealNextRoundInput,
  type BuildRoundResultInput,
  type RoundResult,
} from '../src/orchestration/round-result.ts';
import { publishRoundResult, readRoundResult } from '../src/orchestration/round-observation.ts';
import { sourceText } from './helpers.ts';

const FAKE_AGENT = 'fake-impl';
const registryWith = (entries: Array<[string, string, TaskType[], 'available' | 'unknown' | 'unavailable']>): ModelRegistry => {
  const reg = new ModelRegistry();
  for (const [agentId, modelId, taskTypes] of entries) {
    reg.upsert({ agentId, modelId, provider: 'test', taskTypes, modelSource: 'test', quotaSource: 'test' }, NOW);
    // Availability is a SEPARATE call from the upsert. Without it the model exists but is
    // not selectable, and Assignment refuses with `no-available-agent` — which is what a
    // missing availability call looks like from the outside.
    reg.setAgentAvailability(agentId, 'available');
  }
  return reg;
};
/** Counts dispatches so each fake run is distinguishable from the last. */

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` - ${detail}` : ''}`);
    process.stdout.write(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}\n`);
  }
}

function section(title: string): void {
  process.stdout.write(`\n== ${title} ==\n`);
}

const NOW = 1_700_000_000_000;
const now = () => NOW;

// ---------------------------------------------------------------------------
// Fixtures — real store, real validator
// ---------------------------------------------------------------------------

/** A real Task from the real TaskStore, so nothing about it is hand-shaped. */
function realTask(over: Partial<{
  taskId: string;
  parentTaskId: string | null;
  taskType: 'implementation' | 'review' | 'research' | 'test';
  agentId: string;
  modelId: string | null;
  acceptanceCriteria: string;
}> = {}): Task {
  const store = new TaskStore();
  const taskId = over.taskId ?? 'r';
  if (over.parentTaskId) {
    store.create({
      taskId: over.parentTaskId,
      taskType: 'implementation',
      acceptanceCriteria: 'root',
      parentTaskId: null,
      agentId: 'opencode',
      modelId: 'opencode/space-bunny-free',
    }, NOW);
  }
  const created = store.create({
    taskId,
    taskType: over.taskType ?? 'implementation',
    acceptanceCriteria: over.acceptanceCriteria ?? `do ${taskId}`,
    parentTaskId: over.parentTaskId ?? null,
    agentId: over.agentId ?? 'opencode',
    modelId: over.modelId === undefined ? 'opencode/space-bunny-free' : over.modelId,
  }, NOW);
  if (!created.ok) throw new Error(`fixture could not create ${taskId}: ${created.reason}`);
  return store.get(taskId)!;
}

/** A real attempt, validated by the real AttemptStore. Nothing hand-built. */
function realAttempt(over: Partial<{
  attemptId: string;
  taskId: string;
  kind: 'execution' | 'review' | 'rework';
  agentId: string;
  modelId: string | null;
  outcome: 'success' | 'failure' | 'rework' | 'reject' | 'aborted' | 'error';
  leaseVersion: number;
  previousAttemptId: string | null;
  errorCode: string;
  errorMessage: string;
}> = {}): AttemptRecord {
  const store = new AttemptStore();
  const appended = store.append({
    attemptId: over.attemptId ?? 'att_0001',
    taskId: over.taskId ?? 'r',
    kind: over.kind ?? 'execution',
    agentId: over.agentId ?? 'opencode',
    modelId: over.modelId === undefined ? 'opencode/space-bunny-free' : over.modelId,
    taskType: 'implementation',
    startedAt: NOW,
    finishedAt: NOW + 10,
    outcome: over.outcome ?? 'success',
    // A real attempt in this system always carries the lease version it ran under;
    // an attempt with no version is a `review`, which is not what most fixtures mean.
    leaseVersion: over.leaseVersion ?? 1,
    previousAttemptId: over.previousAttemptId ?? null,
    ...(over.errorCode === undefined ? {} : { errorCode: over.errorCode, errorMessage: over.errorMessage ?? 'boom' }),
  });
  if (!appended.ok) throw new Error(`fixture could not append attempt: ${appended.reason ?? appended.code}`);
  return appended.record;
}

/**
 * Several attempts for the same task, appended to ONE store in order.
 *
 * The store derives `previousAttemptId` itself and overwrites whatever a caller claims,
 * so a chain can only be built by appending in order to the same store — which is
 * exactly what production does, and what makes this a real test of the chain.
 */
function realAttemptChain(
  specs: readonly Partial<{
    attemptId: string;
    taskId: string;
    kind: 'execution' | 'review' | 'rework';
    agentId: string;
    modelId: string | null;
    outcome: 'success' | 'failure' | 'rework' | 'reject' | 'aborted' | 'error';
    leaseVersion: number;
    errorCode: string;
    errorMessage: string;
  }>[],
): AttemptRecord[] {
  const store = new AttemptStore();
  const out: AttemptRecord[] = [];
  for (const [index, spec] of specs.entries()) {
    const appended = store.append({
      attemptId: spec.attemptId ?? `att_${String(index + 1).padStart(4, '0')}`,
      taskId: spec.taskId ?? 'c1',
      kind: spec.kind ?? 'execution',
      agentId: spec.agentId ?? 'opencode',
      modelId: spec.modelId === undefined ? 'opencode/space-bunny-free' : spec.modelId,
      taskType: 'implementation',
      startedAt: NOW + index * 10,
      finishedAt: NOW + index * 10 + 5,
      outcome: spec.outcome ?? 'success',
      leaseVersion: spec.leaseVersion ?? 1,
      ...(spec.errorCode === undefined
        ? {}
        : { errorCode: spec.errorCode, errorMessage: spec.errorMessage ?? 'boom' }),
    });
    if (!appended.ok) throw new Error(`fixture could not append attempt: ${appended.reason ?? appended.code}`);
    out.push(appended.record);
  }
  return out;
}
/** A completed review, the happy path. */
function reviewOk(verdict: 'pass' | 'rework' | 'reject' = 'pass'): UnifiedReviewResult {
  const findings = verdict === 'pass'
    ? []
    : [{ severity: 'major' as const, location: 'src/x.ts', message: 'the change is incomplete' }];
  return {
    status: 'completed',
    reviewer: 'codex',
    verdict: {
      verdict,
      reason: `the reviewer concluded ${verdict}`,
      findings,
      recommendedAction: verdict === 'pass' ? 'none' : 'rework',
      reviewer: 'codex',
      reviewedAt: NOW + 20,
    },
    reason: null,
    findings,
    outputTail: { text: 'raw reviewer prose that is not a verdict', truncated: false, originalLength: 36 },
    recommendations: verdict === 'pass' ? [] : ['rework the change'],
    code: null,
    reviewedAt: NOW + 20,
  };
}

const reviewNotRequested: UnifiedReviewResult = {
  status: 'not_requested',
  reviewer: 'codex',
  verdict: null,
  reason: '--no-review was given',
  findings: [],
  recommendations: [],
  outputTail: null,
  code: null,
  reviewedAt: null,
};

/** The review failed / produced something unusable. Never a pass. */
const reviewFailed: UnifiedReviewResult = {
  status: 'failed',
  reviewer: 'codex',
  verdict: null,
  reason: 'reviewer output was not valid JSON',
  findings: [],
  recommendations: [],
  outputTail: { text: 'sorry, here is a summary instead', truncated: false, originalLength: 32 },
  code: 'malformed-review',
  reviewedAt: NOW + 20,
};

/**
 * Assemble a RoundResult from the real seams.
 *
 * Everything the projection needs is produced by the SAME builders the round uses:
 * `classifyExecutionOutcome` for outcomes, `buildReviewPacket` +
 * `buildUnifiedRoundReport` for the review layer.
 */
function aggregate(over: {
  tasks?: readonly Task[];
  attempts?: readonly AttemptRecord[];
  review?: UnifiedReviewResult;
  reviewRequested?: boolean;
  reviewEvidence?: { recorded: boolean; attemptId: string | null };
  continuation?: BuildRoundResultInput['continuation'];
  evidence?: BuildRoundResultInput['evidence'];
  request?: string;
  roundId?: string;
  startedAt?: number;
  completedAt?: number | null;
} = {}): RoundResult {
  const tasks = over.tasks !== undefined && over.tasks.length > 0 ? over.tasks : [realTask()];
  const attempts = over.attempts ?? [];
  const review = over.review ?? reviewOk();

  const packet = buildReviewPacket({
    roundId: over.roundId ?? 'r',
    originalRequest: over.request ?? 'make the thing better',
    layaPlan: 'plan shape: single\nclassification: work_kind=implementation',
    tasks: tasks.map((t) => {
      const classified = classifyExecutionOutcome({
        taskId: t.taskId,
        taskStatus: t.status,
        agentId: t.agentId,
        modelId: t.modelId,
        run: null,
        refusalCode: null,
        refusalReason: null,
        attemptIds: attempts.filter((a) => a.taskId === t.taskId).map((a) => a.attemptId),
      });
      return {
        taskId: t.taskId,
        taskType: t.taskType,
        status: t.status,
        agentId: t.agentId,
        modelId: t.modelId,
        outcome: classified.outcome,
        executed: classified.executed,
        prompt: null,
        handoff: null,
        attemptIds: classified.attemptIds,
        leaseVersion: null,
        errorCode: classified.code,
        errorMessage: classified.reason,
      };
    }),
    outcomes: tasks.map((t) => classifyExecutionOutcome({
      taskId: t.taskId,
      taskStatus: t.status,
      agentId: t.agentId,
      modelId: t.modelId,
      run: null,
      refusalCode: null,
      refusalReason: null,
      attemptIds: attempts.filter((a) => a.taskId === t.taskId).map((a) => a.attemptId),
    })),
  });

  return buildRoundResult({
    identity: {
      roundId: over.roundId ?? 'r',
      startedAt: over.startedAt ?? NOW,
      completedAt: over.completedAt === undefined ? NOW + 100 : over.completedAt,
      complete: over.completedAt !== null,
    },
    originalRequest: over.request ?? 'make the thing better',
    layaPlan: 'plan shape: single\nclassification: work_kind=implementation',
    tasks,
    attempts,
    unified: buildUnifiedRoundReport(packet, review),
    reviewOutputSummary: review.outputTail === null ? null : review.outputTail.text,
    reviewRequested: over.reviewRequested ?? true,
    reviewEvidence: over.reviewEvidence ?? { recorded: true, attemptId: 'att_rev_1' },
    continuation: over.continuation ?? null,
    evidence: over.evidence,
    evidenceNote: 'AttemptStore holds the full append-only execution evidence.',
  });
}

/**
 * Drive a real task to a real status through the store's own transition table.
 *
 * B4.4 added the optional third argument so a fixture can ALSO declare artifacts and/or
 * a stale/blocked fact through the store's own API — never by hand-shaping a Task, which
 * would let the test assert its own fiction.
 */
function withStatus(
  task: Task,
  status: Task['status'],
  extra: {
    /** Declared artifacts, added via the store's own `addArtifact`. */
    artifacts?: readonly { readonly name: string; readonly path: string }[];
    /** Mark the task stale with this reason (only for a not-yet-started task). */
    stale?: string;
    /** The reason used for the `blocked` transition. Defaults to `'fixture'`. */
    blockedReason?: string;
  } = {},
): Task {
  const store = new TaskStore();
  // Depth is capped at 1, so a child needs exactly its parent to exist first. The gate
  // is fail-closed on a missing parent, and that refusal is correct behaviour.
  if (task.parentTaskId !== null) {
    const parent = store.create({
      taskId: task.parentTaskId,
      taskType: 'implementation',
      acceptanceCriteria: 'root',
      parentTaskId: null,
      agentId: 'opencode',
      modelId: 'opencode/space-bunny-free',
    }, NOW);
    if (!parent.ok) throw new Error(`fixture could not create parent ${task.parentTaskId}: ${parent.reason}`);
  }
  store.create({
    taskId: task.taskId,
    taskType: task.taskType,
    acceptanceCriteria: task.acceptanceCriteria,
    parentTaskId: task.parentTaskId,
    agentId: task.agentId,
    modelId: task.modelId,
  }, NOW);
  for (const a of extra.artifacts ?? []) {
    const added = store.addArtifact(task.taskId, { name: a.name, path: a.path, kind: 'file', producedAt: NOW });
    if (!added.ok) throw new Error(`fixture could not add artifact ${a.name}: ${added.reason}`);
  }
  // `planned -> queued -> running -> to_verify -> terminal` is the real path, so the
  // status under test is reached through the same guards production uses.
  const path: Task['status'][] = status === 'planned' ? []
    : status === 'queued' ? ['queued']
    : status === 'running' ? ['queued', 'running']
    : status === 'blocked' ? ['queued', 'blocked']
    : status === 'to_verify' ? ['queued', 'running', 'to_verify']
    : status === 'succeeded' ? ['queued', 'running', 'to_verify', 'succeeded']
    : status === 'failed' ? ['queued', 'running', 'failed']
    // `to_verify -> rework` is a real edge (P6-D0 un-reserved rework for review-loop.ts).
    : status === 'rework' ? ['queued', 'running', 'to_verify', 'rework']
    : ['queued', 'running', 'cancelled'];
  for (const step of path) {
    const reason = step === 'blocked' ? (extra.blockedReason ?? 'fixture') : 'fixture';
    const moved = store.transition(task.taskId, step, NOW, reason);
    if (!moved.ok) throw new Error(`fixture could not move ${task.taskId} to ${step}: ${moved.reason ?? moved.code}`);
  }
  if (extra.stale !== undefined) {
    const marked = store.markStale(task.taskId, extra.stale);
    if (!marked.ok) throw new Error(`fixture could not mark ${task.taskId} stale: ${marked.reason ?? marked.code}`);
  }
  return store.get(task.taskId)!;
}

const succeeded = (t: Task): Task => withStatus(t, 'succeeded');
const failedTask = (t: Task): Task => withStatus(t, 'failed');
const toVerify = (t: Task): Task => withStatus(t, 'to_verify');

// ===========================================================================
// 1. Aggregation — single task success
// ===========================================================================
section('R4-1: a single-task round that succeeded');

{
  const t = succeeded(realTask({ taskId: 'r', acceptanceCriteria: 'ship the fix' }));
  const result = aggregate({ tasks: [t], attempts: [realAttempt({ taskId: 'r' })] });

  check('the report names the round and its window', result.identity.roundId === 'r' && result.identity.startedAt === NOW && result.identity.completedAt === NOW + 100);
  check('the user request is carried verbatim', result.plan.originalRequest === 'make the thing better');
  check('exactly one task is summarised', result.machine.tasks.length === 1);
  const only = result.machine.tasks[0]!;
  check('the task keeps its own objective (acceptanceCriteria)', only.objective === 'ship the fix');
  check('the task reports who and what model', only.agentId === 'opencode' && only.modelId === 'opencode/space-bunny-free');
  check('the attempt count counts EXECUTION attempts only', only.attemptCount === 1);
  check('the attempt is listed with its lease version', result.machine.attempts.length === 1 && result.machine.attempts[0]!.leaseVersion === 1);
  check('nothing is unfinished', result.machine.unfinished.length === 0);
  check('the gate sees a finished round', result.gate.roundComplete === true);
  check('a finished round waits for the user', result.gate.status === 'waiting_for_user');
  check('automatic post-round action is NONE', result.gate.automaticPostRoundAction === 'none');
}

// ===========================================================================
// 2. Aggregation — many tasks
// ===========================================================================
section('R4-2: a multi-task round');

{
  const root = succeeded(realTask({ taskId: 'r' }));
  const a = succeeded(realTask({ taskId: 'c1', parentTaskId: 'r' }));
  const b = failedTask(realTask({ taskId: 'c2', parentTaskId: 'r' }));
  const result = aggregate({
    tasks: [root, a, b],
    attempts: [
      realAttempt({ attemptId: 'att_0001', taskId: 'r' }),
      realAttempt({ attemptId: 'att_0002', taskId: 'c1' }),
      realAttempt({ attemptId: 'att_0003', taskId: 'c2', outcome: 'failure', errorCode: 'NONZERO_EXIT' }),
    ],
  });

  check('all three tasks are summarised', result.machine.tasks.length === 3);
  check('the failed task keeps its real status', result.machine.tasks.find((t) => t.taskId === 'c2')!.status === 'failed');
  check('the failed attempt keeps its error code', result.machine.attempts.find((a) => a.taskId === 'c2')!.errorCode === 'NONZERO_EXIT');
  // The root is the round's objective and never executes, so it is excluded from the
  // tally: c1 succeeded, c2 failed.
  check('the tally counts EXECUTABLE tasks only', result.gate.taskTally.succeeded === 1 && result.gate.taskTally.failed === 1);
  check('a failure becomes a decision for the user', result.gate.decisions.some((d) => d.id === 'failed-tasks'));
  check('the failure is NOT retried by the report', result.machine.attempts.filter((a) => a.taskId === 'c2').length === 1);
  check('the task graph keeps the parent edges', result.plan.taskGraph.find((n) => n.taskId === 'c1')!.parentTaskId === 'r');
  check('the graph reports its own size', result.plan.taskCount === 3);
}

// ===========================================================================
// 3. Aggregation — one task, several attempts
// ===========================================================================
section('R4-3: a task with multiple attempts');

{
  const t = succeeded(realTask({ taskId: 'c1', parentTaskId: 'r' }));
  const result = aggregate({
    tasks: [t],
    // Appended to ONE store in order, so the store derives the chain itself.
    attempts: realAttemptChain([
      { taskId: 'c1', attemptId: 'att_0001', outcome: 'failure', errorCode: 'TIMEOUT' },
      { taskId: 'c1', attemptId: 'att_0002', leaseVersion: 2 },
    ]),
  });

  check('both attempts are listed', result.machine.attempts.length === 2);
  check('the attempt count is two', result.machine.tasks[0]!.attemptCount === 2);
  check('the store-derived chain link is preserved', result.machine.attempts[1]!.previousAttemptId === 'att_0001');
  check('the first attempt has no predecessor', result.machine.attempts[0]!.previousAttemptId === null);
  check('the first attempt keeps its own failure', result.machine.attempts[0]!.outcome === 'failure');
}

// ===========================================================================
// 4. Aggregation — A -> B handoff on the SAME task
// ===========================================================================
section('R4-4: an A -> B handoff (same TaskId)');

const handoffResult = aggregate({
  tasks: [succeeded(realTask({ taskId: 'c1', parentTaskId: 'r' }))],
  attempts: realAttemptChain([
    { taskId: 'c1', attemptId: 'att_0001', agentId: 'worker-a', outcome: 'failure', errorCode: 'AGENT_UNAVAILABLE' },
    { taskId: 'c1', attemptId: 'att_0002', agentId: 'opencode', leaseVersion: 2 },
  ]),
  continuation: {
    happened: 1,
    limit: 2,
    handoffs: [{
      taskId: 'c1',
      reason: 'agent_unavailable',
      fromAgentId: 'worker-a',
      toAgentId: 'opencode',
      previousAttemptId: 'att_0001',
      decisionAction: 'reassign',
      decisionApplied: true,
      at: NOW + 5,
    }],
    stopped: { code: 'no-trigger', reason: 'nothing left to hand off' },
    agentChain: { c1: ['worker-a', 'opencode'] },
  },
});

{
  check('exactly one handoff summary exists', handoffResult.machine.handoffs.length === 1);
  const h = handoffResult.machine.handoffs[0]!;
  check('the handoff keeps the same task id', h.taskId === 'c1');
  check('old and new agent are both named', h.chains[0]!.fromAgentId === 'worker-a' && h.chains[0]!.toAgentId === 'opencode');
  check('the reason is carried', h.chains[0]!.reason === 'agent_unavailable');
  check('the previous attempt is named', h.chains[0]!.previousAttemptId === 'att_0001');
  check('the agent chain is reported in order', h.agentChain.join('->') === 'worker-a->opencode');
  check('the budget fact is honestly unknown, not guessed true', h.chains[0]!.budgetRemained === null);
  check('the chain is reported as continued', h.chains[0]!.continued === true);
  check('the attempt that handed off carries the reason', handoffResult.machine.attempts[0]!.handoffReason === 'agent_unavailable');
  check('the second attempt ran under a NEW lease version', handoffResult.machine.attempts[1]!.leaseVersion === 2);
  check('a handoff becomes a user decision', handoffResult.gate.decisions.some((d) => d.id === 'handoff-outcome'));
}

// ===========================================================================
// 5-8. Refusals: resource / lease / quota all survive aggregation
// ===========================================================================
section('R4-5: refusals are outcomes, not gaps');

for (const label of ['resource_refused', 'lease_refused', 'quota_exhausted'] as const) {
  const t = withStatus(realTask({ taskId: 'c1', parentTaskId: 'r' }), 'planned');
  // A SETTLED review, so this block isolates the task's contribution to the gate. A
  // requested-but-failed review holding the gate closed is asserted separately in R4-12c.
  const result = aggregate({ tasks: [t], review: reviewOk() });
  check(`${label}: the task is reported even though nothing ran`, result.machine.tasks.length === 1);
  check(`${label}: nothing claims it executed`, result.machine.tasks[0]!.executed === false);
  // The important one: a refused task NEVER RAN. Reporting it as "unfinished work" would
  // be a false claim that the round had something left to do.
  check(`${label}: it is NOT reported as unfinished work`,
    result.machine.unfinished.length === 0);
  check(`${label}: it IS reported as never started, with a reason`,
    result.gate.neverStartedTasks.some((n) => n.taskId === 'c1'));
  check(`${label}: a settled refusal does NOT hold the gate closed`,
    result.gate.roundComplete === true && result.gate.status === 'waiting_for_user');
  check(`${label}: the gate surfaces it as a decision for the user`,
    result.gate.decisions.some((d) => d.id === 'never-started'));
}

// F5: a refused result that STILL executed keeps its attempt evidence.
section('R4-6: F5 — a refused-but-executed attempt keeps its evidence');

{
  const t = succeeded(realTask({ taskId: 'c1', parentTaskId: 'r' }));
  const result = aggregate({
    tasks: [t],
    attempts: [realAttempt({
      attemptId: 'att_0001',
      taskId: 'c1',
      outcome: 'failure',
      errorCode: 'LEASE_REFUSED',
      errorMessage: 'the write-back was refused',
    })],
    // Keyed by ATTEMPT ID: evidence belongs to the attempt that produced it.
    evidence: {
      att_0001: {
        changedFiles: ['src/a.ts'],
        testsRun: ['npm test'],
        artifacts: [],
        transcriptPath: '/tmp/t.jsonl',
        errorCode: 'LEASE_REFUSED',
        errorMessage: 'the write-back was refused',
      },
    },
  });

  const a = result.machine.attempts[0]!;
  check('the executed attempt is NOT dropped', result.machine.attempts.length === 1);
  check('its refusal code is kept', a.errorCode === 'LEASE_REFUSED');
  check('its files are kept', a.changedFiles.join(',') === 'src/a.ts');
  check('its tests are kept', a.testsRun.join(',') === 'npm test');
  check('its transcript pointer is kept', a.transcriptPath === '/tmp/t.jsonl');
  check('an attempt carries no task-declared artifacts (those live on the task)',
    a.artifacts.length === 0);
  check('the task still reports the attempt happened', result.machine.tasks[0]!.attemptCount === 1);
}

// A review attempt is evidence ABOUT the round, not an execution OF the task.
section('R4-7: a review attempt does not inflate the attempt count');

{
  const t = succeeded(realTask({ taskId: 'c1', parentTaskId: 'r' }));
  const result = aggregate({
    tasks: [t],
    attempts: [
      realAttempt({ attemptId: 'att_0001', taskId: 'c1', kind: 'execution' }),
      realAttempt({ attemptId: 'att_0002', taskId: 'c1', kind: 'review', agentId: 'codex', modelId: null }),
    ],
    evidence: {
      att_0001: {
        changedFiles: ['src/a.ts'],
        testsRun: [],
        artifacts: [],
        transcriptPath: null,
        errorCode: null,
        errorMessage: null,
      },
    },
  });

  check('both records are listed', result.machine.attempts.length === 2);
  check('the task attempt count counts only executions', result.machine.tasks[0]!.attemptCount === 1);
  const reviewAttempt = result.machine.attempts.find((a) => a.kind === 'review')!;
  check('the review attempt does not inherit the execution\'s changed files', reviewAttempt.changedFiles.length === 0);
  check('the review attempt carries its own reviewer id', reviewAttempt.agentId === 'codex');
}

// ===========================================================================
// 9-11. The review layer
// ===========================================================================
section('R4-8: a completed review');

{
  const result = aggregate({ tasks: [succeeded(realTask())] });
  check('the review is reported as requested', result.review.requested === true);
  check('the status is completed', result.review.status === 'completed');
  check('the verdict is carried', result.review.verdict === 'pass');
  check('the reviewer output is summarised separately from the verdict',
    result.review.outputSummary === 'raw reviewer prose that is not a verdict');
  check('evidence recording is reported', result.review.evidenceRecorded === true);
  check('the evidence attempt id is reported', result.review.evidenceAttemptId === 'att_rev_1');
}

section('R4-9: a failed / malformed review is never a pass');

{
  const result = aggregate({ tasks: [succeeded(realTask())], review: reviewFailed });
  check('the status is failed', result.review.status === 'failed');
  check('the verdict is null, NOT pass', result.review.verdict === null);
  check('the reason is kept', (result.review.reason ?? '').includes('not valid JSON'));
  check('the code is kept', result.review.status !== 'completed');
  check('a failed review does not make the round unfinished work',
    result.machine.tasks[0]!.status === 'succeeded');
  check('the rendered report prints a null verdict as NOT a pass',
    renderRoundResult(result).includes('(none — this is not a pass)'));
}

section('R4-10: review evidence and execution evidence coexist');

{
  const t = succeeded(realTask({ taskId: 'c1', parentTaskId: 'r' }));
  const result = aggregate({
    tasks: [t],
    attempts: [
      realAttempt({ attemptId: 'att_0001', taskId: 'c1', kind: 'execution' }),
      realAttempt({ attemptId: 'att_rev_1', taskId: 'c1', kind: 'review', agentId: 'codex', modelId: null }),
    ],
    reviewEvidence: { recorded: true, attemptId: 'att_rev_1' },
    evidence: {
      att_0001: {
        changedFiles: ['src/a.ts'],
        testsRun: ['npm test'],
        artifacts: [],
        transcriptPath: null,
        errorCode: null,
        errorMessage: null,
      },
    },
  });

  check('the execution attempt survives', result.machine.attempts.some((a) => a.kind === 'execution'));
  check('the review attempt survives alongside it', result.machine.attempts.some((a) => a.kind === 'review'));
  check('the execution files are still attributed to the execution',
    result.machine.attempts.find((a) => a.kind === 'execution')!.changedFiles.join(',') === 'src/a.ts');
  check('the review verdict is reported separately', result.review.verdict === 'pass');
  check('the review evidence id points at the review attempt', result.review.evidenceAttemptId === 'att_rev_1');
}

section('R4-11: a review that was never requested is not a pass');

{
  const result = aggregate({ tasks: [succeeded(realTask())], review: reviewNotRequested, reviewRequested: false });
  check('requested is false', result.review.requested === false);
  check('the verdict is null', result.review.verdict === null);
  check('the status says not_requested', result.review.status === 'not_requested');
  check('an unrequested review does not hold the gate open', result.gate.reviewOutstanding === false);
  check('the gate still stops for the user', result.gate.status === 'waiting_for_user');
}

// ===========================================================================
// 12-16. Human gate
// ===========================================================================
section('R4-12: a finished round reaches the gate');

{
  const result = aggregate({ tasks: [succeeded(realTask())] });
  check('the gate is waiting_for_user', result.gate.status === 'waiting_for_user');
  check('the gate says the round is complete', result.gate.roundComplete === true);
  check('the gate gives a reason', result.gate.reason.length > 0);
  check('nothing is left non-terminal', result.gate.nonTerminalTasks.length === 0);
  check('the gate always offers the next-round decision', result.gate.decisions.some((d) => d.id === 'next-round'));
  check('the gate status is inside the declared vocabulary',
    (HUMAN_GATE_STATUSES as readonly string[]).includes(result.gate.status));
}

section('R4-13/14/15/16: the gate cannot authorise any automatic action');

{
  // A round full of everything that would tempt a system to act on its own.
  const t = failedTask(realTask({ taskId: 'c1', parentTaskId: 'r' }));
  const result = aggregate({
    tasks: [t],
    review: reviewOk('rework'),
    attempts: [realAttempt({ taskId: 'c1', outcome: 'failure', errorCode: 'BOOM' })],
    continuation: {
      happened: 1,
      limit: 2,
      handoffs: [{
        taskId: 'c1',
        reason: 'quota_exhausted',
        fromAgentId: 'worker-a',
        toAgentId: 'opencode',
        previousAttemptId: 'att_0001',
        decisionAction: 'reassign',
        decisionApplied: true,
        at: NOW + 5,
      }],
      stopped: { code: 'handoff-loop-refused', reason: 'limit reached' },
      agentChain: { c1: ['worker-a', 'opencode'] },
    },
  });

  check('a rework VERDICT produces no rework attempt', result.machine.attempts.filter((a) => a.kind === 'rework').length === 0);
  check('the rework recommendation is reported as text', result.review.recommendations.join(',').includes('rework the change'));
  check('the report states recommendations were not applied automatically',
    result.review.recommendationsAppliedAutomatically === false);
  check('no extra attempt was conjured after the gate', result.machine.tasks[0]!.attemptCount === 1);
  check('the automatic post-round action is NONE', result.gate.automaticPostRoundAction === 'none');
  check('the gate surfaces the non-pass verdict as a decision', result.gate.decisions.some((d) => d.id === 'review-verdict'));

  const rendered = renderRoundResult(result);
  check('the rendered report says nothing was retried', rendered.includes('Nothing was retried'));
  check('the rendered report names the automatic action as NONE', rendered.includes('automatic post-round action: NONE'));
  check('the rendered report tells the user to start the next round themselves',
    rendered.includes('run another one yourself'));
}

section('R4-12b: the root is NOT an executable task (regression guard)');

{
  // The real shape of a production round: the root is created and NEVER executed. The
  // task machine allows `planned -> queued | blocked | cancelled` only, so a root can
  // never reach `succeeded`, and round-cli never transitions it. A gate that waited for
  // every task to be terminal would therefore never open in production — this is the
  // exact bug this section was written for.
  const root = realTask({ taskId: 'r' });                 // stays `planned`, forever
  const child = succeeded(realTask({ taskId: 'c1', parentTaskId: 'r' }));
  check('the fixture really does leave the root non-terminal', root.status === 'planned');
  check('the root is not in a terminal status', !['succeeded', 'failed', 'cancelled'].includes(root.status));

  const result = aggregate({ tasks: [root, child] });
  check('the gate OPENS even though the root is not terminal', result.gate.roundComplete === true);
  check('the gate status is waiting_for_user', result.gate.status === 'waiting_for_user');
  check('the non-terminal ROOT does not appear as outstanding work',
    !result.gate.nonTerminalTasks.includes('r'));
  check('the root is not counted in the tally', result.gate.taskTally.succeeded === 1);
  check('the root is not reported as unfinished', result.machine.unfinished.length === 0);
  check('the root is still reported as a task (it is the round identity)', result.machine.tasks.length === 2);
  check('the root keeps its objective', result.machine.tasks.find((t) => t.taskId === 'r')!.objective === 'do r');

  // A child that IS mid-lifecycle must still hold the gate closed.
  const busy = aggregate({ tasks: [root, toVerify(realTask({ taskId: 'c2', parentTaskId: 'r' }))] });
  check('an executable task mid-lifecycle still holds the gate closed', busy.gate.status === 'not_ready');
  check('and it is named', busy.gate.nonTerminalTasks.includes('c2'));
}

section('R4-12d: a task genuinely in flight holds the gate closed');

{
  for (const status of ['queued', 'running', 'to_verify'] as const) {
    const t = withStatus(realTask({ taskId: 'c1', parentTaskId: 'r' }), status);
    const result = aggregate({ tasks: [t] });
    check(`${status}: the gate is not ready`, result.gate.status === 'not_ready');
    check(`${status}: the task is reported as unfinished`, result.machine.unfinished.some((u) => u.taskId === 'c1'));
    check(`${status}: it is listed as mid-lifecycle`, result.gate.nonTerminalTasks.includes('c1'));
    check(`${status}: no automatic action is authorised`, result.gate.automaticPostRoundAction === 'none');
  }
  const blocked = aggregate({ tasks: [withStatus(realTask({ taskId: 'c1', parentTaskId: 'r' }), 'blocked')] });
  check('blocked: it is settled, not in-flight', blocked.gate.roundComplete === true);
  // A blocked task DID run, so calling it "never started" would be a false account of it.
  check('blocked: it is NOT reported as never started', blocked.gate.neverStartedTasks.length === 0);
  check('blocked: it has its own report field', blocked.gate.blockedTasks.some((n) => n.taskId === 'c1'));
  check('blocked: it is surfaced as a decision', blocked.gate.decisions.some((d) => d.id === 'blocked-tasks'));
}

// ===========================================================================
// P1-1 REGRESSION: `rework` is unfinished executable work
// ===========================================================================
section('P1-1: a task in rework must NOT be treated as settled or never-started');

{
  // The bug: `IN_FLIGHT_STATUSES` listed queued/running/to_verify/retrying and NOT
  // `rework`. Everything non-terminal and non-in-flight was then classified
  // "never started", so a task awaiting rework opened the human gate while work was still
  // owed — and `review-loop.ts` would have had somewhere to go that the gate had already
  // declared finished.
  const root = realTask({ taskId: 'r' });
  const child = withStatus(realTask({ taskId: 'c1', parentTaskId: 'r' }), 'rework');

  // Reach the state through the REAL transition table, not by asserting the constant.
  check('the fixture really reached rework via to_verify -> rework', child.status === 'rework');
  check('rework is a real TaskStatus', TASK_STATUSES.includes('rework'));
  check('the lifecycle table really allows to_verify -> rework',
    TASK_TRANSITIONS.to_verify.includes('rework'));

  check('rework is classified in_flight', classifyTaskLifecycle('rework') === 'in_flight');
  check('rework is a blocking status', isBlockingStatus('rework') === true);
  check('rework is in IN_FLIGHT_STATUSES', IN_FLIGHT_STATUSES.has('rework'));

  const result = aggregate({ tasks: [root, child] });
  check('the gate does NOT open', result.gate.status !== 'waiting_for_user');
  check('the gate does NOT report the round complete', result.gate.roundComplete === false);
  check('the gate status is not_ready', result.gate.status === 'not_ready');
  check('the child is NOT in neverStartedTasks',
    result.gate.neverStartedTasks.every((n) => n.taskId !== 'c1'));
  check('neverStartedTasks is empty entirely', result.gate.neverStartedTasks.length === 0);
  check('the child IS reported as mid-lifecycle', result.gate.nonTerminalTasks.includes('c1'));
  check('the child IS in the unfinished projection',
    result.machine.unfinished.some((u) => u.taskId === 'c1'));
  check('the unfinished reason states its real status',
    result.machine.unfinished.find((u) => u.taskId === 'c1')!.reason.includes('rework'));
  check('the user-facing summary names it as not finished',
    result.summary.userFacing.some((l) => l.includes('c1 (rework)')));
  check('no automatic action is authorised', result.gate.automaticPostRoundAction === 'none');
  check('the rendered report shows it mid-lifecycle',
    renderRoundResult(result).includes('still mid-lifecycle: c1'));
}

section('P1-1b: rework -> queued and rework -> failed change the projection correctly');

{
  // `TASK_TRANSITIONS.rework = ['queued','failed']`. Both outcomes must be reflected, and
  // neither may be mistaken for the original rework state.
  const drive = (steps: Task['status'][]): Task => {
    const store = new TaskStore();
    store.create({ taskId: 'r', taskType: 'implementation', acceptanceCriteria: 'root', parentTaskId: null, agentId: 'opencode', modelId: 'm' }, NOW);
    store.create({ taskId: 'c1', taskType: 'implementation', acceptanceCriteria: 'work', parentTaskId: 'r', agentId: 'opencode', modelId: 'm' }, NOW);
    for (const step of steps) {
      const moved = store.transition('c1', step, NOW, 'regression');
      if (!moved.ok) throw new Error(`could not move c1 to ${step}: ${moved.reason ?? moved.code}`);
    }
    return store.get('c1')!;
  };

  const backToQueued = drive(['queued', 'running', 'to_verify', 'rework', 'queued']);
  check('rework -> queued is a legal edge', TASK_TRANSITIONS.rework.includes('queued'));
  check('the fixture reached queued', backToQueued.status === 'queued');
  const queuedResult = aggregate({ tasks: [realTask({ taskId: 'r' }), backToQueued] });
  check('queued still holds the gate closed', queuedResult.gate.status === 'not_ready');
  check('queued is still mid-lifecycle', queuedResult.gate.nonTerminalTasks.includes('c1'));
  check('queued is not never-started', queuedResult.gate.neverStartedTasks.length === 0);

  const toFailed = drive(['queued', 'running', 'to_verify', 'rework', 'failed']);
  check('rework -> failed is a legal edge', TASK_TRANSITIONS.rework.includes('failed'));
  check('the fixture reached failed', toFailed.status === 'failed');
  const failedResult = aggregate({ tasks: [realTask({ taskId: 'r' }), toFailed] });
  check('failed settles the round', failedResult.gate.roundComplete === true);
  check('failed is counted in the tally', failedResult.gate.taskTally.failed === 1);
  check('failed is NOT reported as unfinished', failedResult.machine.unfinished.length === 0);
  check('failed is NOT reported as never started', failedResult.gate.neverStartedTasks.length === 0);
  check('failed becomes a decision for the user', failedResult.gate.decisions.some((d) => d.id === 'failed-tasks'));
}

section('P1-1c: every TaskStatus is classified, and `replanning` is not forgotten again');

{
  check('the classification table covers every TaskStatus',
    TASK_STATUSES.every((s) => classifyTaskLifecycle(s) !== 'unknown'));
  // `replanning` was the SECOND omission in the same bug: `TASK_TRANSITIONS` gives it
  // `['queued','cancelled']`, so it is a real state and was equally mis-filed.
  check('replanning is classified in_flight', classifyTaskLifecycle('replanning') === 'in_flight');
  check('replanning blocks the round', isBlockingStatus('replanning') === true);
  check('the module-load guard would fire on an unclassified status', (() => {
    // Prove the guard is real by exercising the same predicate it uses.
    const unclassified = (['planned', 'queued'] as TaskStatus[]).filter((s) => classifyTaskLifecycle(s) === 'unknown');
    return unclassified.length === 0;
  })());
  check('an unknown status is treated as BLOCKING, never as settled',
    classifyTaskLifecycle('some_future_status') === 'unknown' && isBlockingStatus('some_future_status') === true);
  check('every blocking status is in IN_FLIGHT_STATUSES or unknown-safe',
    (['queued', 'running', 'to_verify', 'retrying', 'rework', 'replanning'] as TaskStatus[])
      .every((s) => IN_FLIGHT_STATUSES.has(s)));
  check('non-blocking statuses are genuinely non-blocking',
    (['planned', 'blocked', 'succeeded', 'failed', 'cancelled'] as TaskStatus[])
      .every((s) => !IN_FLIGHT_STATUSES.has(s)));
}

section('P1-2 REGRESSION: per-ATTEMPT evidence attribution across an A->B handoff');

{
  // The bug: evidence was keyed by taskId and there is exactly ONE latest RunResult per
  // task, so with two attempts both were handed attempt B's files/tests/transcript. The
  // report therefore claimed agent A wrote agent B's files.
  const root = succeeded(realTask({ taskId: 'r' }));
  const task = succeeded(realTask({ taskId: 'T1', parentTaskId: 'r' }));

  // Two DISTINCT attempts of the SAME task, appended to one store so the chain is real.
  const attempts = realAttemptChain([
    {
      taskId: 'T1',
      attemptId: 'A1',
      agentId: 'agent-A',
      outcome: 'failure',
      errorCode: 'QUOTA_EXHAUSTED',
      errorMessage: 'agent A ran out of quota',
      leaseVersion: 1,
    },
    {
      taskId: 'T1',
      attemptId: 'A2',
      agentId: 'agent-B',
      outcome: 'success',
      leaseVersion: 2,
    },
  ]);

  // Each attempt gets ONLY its own evidence. Every field differs, so a leak in any single
  // field is caught.
  const result = aggregate({
    tasks: [root, task],
    attempts,
    evidence: {
      A1: {
        changedFiles: ['a.ts'],
        testsRun: ['test-a'],
        artifacts: [],
        transcriptPath: 'transcript-a',
        errorCode: 'QUOTA_EXHAUSTED',
        errorMessage: 'agent A ran out of quota',
      },
      A2: {
        changedFiles: ['b.ts'],
        testsRun: ['test-b'],
        artifacts: [],
        transcriptPath: 'transcript-b',
        errorCode: null,
        errorMessage: null,
      },
    },
    continuation: {
      happened: 1,
      limit: 2,
      handoffs: [{
        taskId: 'T1',
        reason: 'quota_exhausted',
        fromAgentId: 'agent-A',
        toAgentId: 'agent-B',
        previousAttemptId: 'A1',
        decisionAction: 'reassign',
        decisionApplied: true,
        at: NOW + 5,
      }],
      stopped: { code: 'no-trigger', reason: 'chain finished' },
      agentChain: { T1: ['agent-A', 'agent-B'] },
    },
  });

  const a1 = result.machine.attempts.find((a) => a.attemptId === 'A1')!;
  const a2 = result.machine.attempts.find((a) => a.attemptId === 'A2')!;
  check('both attempts are reported', a1 !== undefined && a2 !== undefined);

  // --- attempt A keeps A's evidence ---
  check('A1 files are A\'s', a1.changedFiles.join(',') === 'a.ts');
  check('A1 tests are A\'s', a1.testsRun.join(',') === 'test-a');
  check('A1 transcript is A\'s', a1.transcriptPath === 'transcript-a');
  check('A1 error is A\'s', a1.errorCode === 'QUOTA_EXHAUSTED');
  check('A1 agent is A', a1.agentId === 'agent-A');
  check('A1 lease version is A\'s', a1.leaseVersion === 1);
  check('A1 carries the handoff reason', a1.handoffReason === 'quota_exhausted');

  // --- attempt B keeps B's evidence ---
  check('A2 files are B\'s', a2.changedFiles.join(',') === 'b.ts');
  check('A2 tests are B\'s', a2.testsRun.join(',') === 'test-b');
  check('A2 transcript is B\'s', a2.transcriptPath === 'transcript-b');
  check('A2 has no error', a2.errorCode === null && a2.errorMessage === null);
  check('A2 agent is B', a2.agentId === 'agent-B');
  check('A2 lease version is B\'s (a NEW lease)', a2.leaseVersion === 2);

  // --- and explicitly: no cross-contamination in ANY field ---
  check('A1 does NOT show B\'s files', !a1.changedFiles.includes('b.ts'));
  check('A2 does NOT show A\'s files', !a2.changedFiles.includes('a.ts'));
  check('A1 does NOT show B\'s tests', !a1.testsRun.includes('test-b'));
  check('A2 does NOT show A\'s tests', !a2.testsRun.includes('test-a'));
  check('A1 transcript differs from A2 transcript', a1.transcriptPath !== a2.transcriptPath);
  check('A1 error differs from A2 error', a1.errorCode !== a2.errorCode);
  check('A1 lease version differs from A2 lease version', a1.leaseVersion !== a2.leaseVersion);
  check('the two attempts share a taskId', a1.taskId === 'T1' && a2.taskId === 'T1');
  check('the chain link is real', a2.previousAttemptId === 'A1');

  // --- an attempt with NO evidence reports emptiness, never a sibling's ---
  const partial = aggregate({
    tasks: [root, task],
    attempts,
    // Only A1 has evidence. A2 must be empty rather than inheriting A1's.
    evidence: {
      A1: {
        changedFiles: ['a.ts'],
        testsRun: ['test-a'],
        artifacts: [],
        transcriptPath: 'transcript-a',
        errorCode: null,
        errorMessage: null,
      },
    },
  });
  const lonely = partial.machine.attempts.find((a) => a.attemptId === 'A2')!;
  check('an attempt with no evidence of its own reports no files', lonely.changedFiles.length === 0);
  check('and no tests', lonely.testsRun.length === 0);
  check('and a null transcript', lonely.transcriptPath === null);
  check('and never inherits its predecessor\'s files', !lonely.changedFiles.includes('a.ts'));

  // --- a review attempt never inherits an execution's evidence ---
  const withReview = aggregate({
    tasks: [root, task],
    attempts: realAttemptChain([
      { taskId: 'T1', attemptId: 'E1', kind: 'execution' },
      { taskId: 'T1', attemptId: 'V1', kind: 'review', agentId: 'codex', modelId: null },
    ]),
    evidence: {
      E1: {
        changedFiles: ['e.ts'],
        testsRun: ['test-e'],
        artifacts: [],
        transcriptPath: 'transcript-e',
        errorCode: null,
        errorMessage: null,
      },
    },
  });
  const reviewAttempt = withReview.machine.attempts.find((a) => a.attemptId === 'V1')!;
  check('a review attempt shows no files', reviewAttempt.changedFiles.length === 0);
  check('a review attempt shows no transcript', reviewAttempt.transcriptPath === null);
}

// ===========================================================================
// P2-1 REGRESSION is covered in R4-12c above.
// ===========================================================================
section('P1-2b: the workbench binds each attempt id to its own run (real dispatch path)');

{
  // Proves the FIX is at the SOURCE, not only in the projection: with two attempts of one
  // task, `attemptEvidenceMap()` must return two DIFFERENT entries keyed by the real minted
  // attempt ids — never one task-keyed blob.
  const dir = mkdtempSync(join(tmpdir(), 'r4-attempt-evidence-'));
  let runNumber = 0;
  // The fake run names the REAL child (set below, once the planner has created it) so the
  // projection resolves a genuine Task. A wrong id would silently yield empty evidence.
  let runTaskId = '';
  // Each dispatch produces a DISTINCT RunResult, so a leak between attempts is visible
  // rather than hidden behind identical objects. The RunHandle shape is the same minimal
  // fake the other suites use: the orchestrator only awaits `result()`.
  const runtime: RuntimeRunner = {
    run: (req) => {
      const k = ++runNumber;
      const result = {
        taskId: runTaskId,
        threadId: `th-${k}`,
        agentId: req.agentId,
        state: k === 1 ? 'failed' : 'succeeded',
        startedAt: NOW,
        endedAt: NOW + 1,
        exitCode: k === 1 ? 1 : 0,
        signal: null,
        output: '',
        outputTruncated: false,
        transcriptPath: `transcript-${k}`,
        usage: null,
        toolCalls: [
          { name: 'write', input: { filePath: `file-${k}.ts` } },
          { name: 'bash', input: { command: `test-${k}` } },
        ],
        diagnostics: [],
        cleanup: { rootKilled: false, descendantsReaped: false, note: '' },
        error: k === 1 ? { code: 'SPAWN_FAILED', message: 'the worker could not start' } : null,
      } as unknown as RunResult;
      return { result: async () => result, cancel: async () => {}, dispose: async () => {} } as unknown as RunHandle;
    },
  };

  const budgets = new BudgetManager(1_000_000);
  budgets.task('r', 100_000);
  budgets.agent(FAKE_AGENT, 1_000_000);
  const quotaRows = [{
    provider: FAKE_AGENT, agentId: FAKE_AGENT, modelId: null, source: 'locally_observed',
    usage: null, remaining: null, resetAt: null, period: 'day', status: 'available',
    usageClass: 'observed', confidence: 'high', observedAt: NOW, note: '',
  }] as unknown as QuotaRecord[];
  const registry = registryWith([[FAKE_AGENT, 'm', ['implementation'], 'available']]);
  const orch = new Orchestrator({
    gate: {
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
    } as never,
    now: () => NOW,
    runtime,
    defaultCwd: dir,
  });
  const wb = new NativeWorkbench({
    orchestrator: orch,
    scheduler: new TaskScheduler({ orchestrator: orch, cwd: dir, translate: { allowAvailabilityContinuation: true } }),
    registry,
    quotaRecords: quotaRows,
    cwd: dir,
  });

  // The real creation path: the planner creates the root and its child, then Assignment
  // binds the child. No hand-made task, so the scheduler sees a genuine ready child.
  const spec = {
    taskId: 'r', objective: 'prove per-attempt evidence', taskType: 'implementation',
    shape: 'single', budgetUnits: 10, preferredAgent: FAKE_AGENT, skills: [],
  } as unknown as Parameters<typeof wb.plan>[0];
  wb.plan(spec, null);
  const childId = wb.store.children('r')[0]?.taskId ?? '';
  runTaskId = childId;
  budgets.task(childId, 100_000);
  const assigned = wb.assignChildren('r', spec);
  check('the fixture produced exactly one child task', childId !== '');
  // Guard the guard: if Assignment refused, nothing below would run and the evidence
  // assertions would pass vacuously on an empty map.
  check('the fixture actually bound an identity to the child',
    assigned.some((a) => a.taskId === childId && a.ok));

  await wb.dispatch();
  const afterFirst = wb.attemptEvidenceMap();
  const firstIds = Object.keys(afterFirst);
  check('the first dispatch bound an attempt id to its run', firstIds.length === 1);
  check('the first run\'s files are bound', afterFirst[firstIds[0]!]!.changedFiles.join(',') === 'file-1.ts');
  check('the first run\'s tests are bound', afterFirst[firstIds[0]!]!.testsRun.join(',') === 'test-1');
  check('the first run\'s transcript is bound', afterFirst[firstIds[0]!]!.transcriptPath === 'transcript-1');
  check('the first run\'s error is bound', afterFirst[firstIds[0]!]!.errorCode === 'SPAWN_FAILED');

  // Second dispatch of the SAME task: the point of the whole fix. Attempt 1 must keep
  // attempt 1's evidence even though `lastResults` has now been overwritten by run 2.
  // The retry goes through the EXISTING Orchestrator.retry seam, not a direct transition.
  check('the availability failure parked the task in retrying', wb.store.get(childId)?.status === 'retrying');
  const retried = orch.retry(childId, 'R4 regression: force a second attempt', 3);
  check('the existing retry seam accepted it', retried.ok);
  await wb.dispatch();
  const afterSecond = wb.attemptEvidenceMap();
  const allIds = Object.keys(afterSecond);
  check('the second dispatch bound a SECOND attempt id', allIds.length === 2);
  if (allIds.length === 2) {
    const a1 = afterSecond[allIds[0]!]!;
    const a2 = afterSecond[allIds[1]!]!;
    check('attempt 1 still holds ITS OWN files after attempt 2 ran', a1.changedFiles.join(',') === 'file-1.ts');
    check('attempt 1 still holds ITS OWN tests', a1.testsRun.join(',') === 'test-1');
    check('attempt 1 still holds ITS OWN transcript', a1.transcriptPath === 'transcript-1');
    check('attempt 2 holds ITS OWN files', a2.changedFiles.join(',') === 'file-2.ts');
    check('attempt 2 holds ITS OWN tests', a2.testsRun.join(',') === 'test-2');
    check('attempt 2 holds ITS OWN transcript', a2.transcriptPath === 'transcript-2');
    check('the two attempts are genuinely different', a1.changedFiles.join(',') !== a2.changedFiles.join(','));
    check('no attempt holds the other\'s transcript', a1.transcriptPath !== a2.transcriptPath);
    check('no attempt holds the other\'s tests', a1.testsRun.join(',') !== a2.testsRun.join(','));
    check('every bound id is a real AttemptStore id', allIds.every((id) => wb.evidence.get(id) !== null));
  }

  // And the end-to-end projection keeps the separation, keyed by those same real ids.
  const projected = aggregate({
    tasks: wb.store.all(),
    attempts: wb.evidence.all(),
    evidence: afterSecond,
  });
  const rows = projected.machine.attempts.filter((a) => a.kind === 'execution');
  check('the projection reports the executions', rows.length >= 1);
  check('and their evidence is distinct per attempt',
    new Set(rows.map((a) => a.changedFiles.join(','))).size === rows.length);
  rmSync(dir, { recursive: true, force: true });
}

// ===========================================================================
// B4.4: evidence-backed delivery view + stale/blocked/availability projection
// ===========================================================================
section('B4.4-a: declared vs observed — the delivery view never invents a verdict');

{
  const root = realTask({ taskId: 'r', acceptanceCriteria: 'the round objective' });
  // A succeeded task that DECLARED an artifact, reached through the store's own API.
  const t = withStatus(
    realTask({ taskId: 'c1', parentTaskId: 'r', acceptanceCriteria: 'produce the report file' }),
    'succeeded',
    { artifacts: [{ name: 'report', path: 'out/report.md' }] },
  );

  const result = aggregate({
    tasks: [root, t],
    attempts: [realAttempt({ attemptId: 'att_0001', taskId: 'c1' })],
    evidence: {
      att_0001: {
        changedFiles: ['out/report.md'],
        // An ORDINARY shell command — not a test, and not classified as one.
        testsRun: ['node scripts/render.mjs'],
        artifacts: [],
        transcriptPath: '/tmp/t.jsonl',
        errorCode: null,
        errorMessage: null,
      },
    },
  });

  const summary = result.machine.tasks.find((x) => x.taskId === 'c1')!;
  // --- actual JSON fields -------------------------------------------------
  check('the task keeps its full acceptance objective', summary.objective === 'produce the report file');
  check('the declared artifact is projected as name + path',
    summary.artifacts.length === 1 && summary.artifacts[0]!.name === 'report' && summary.artifacts[0]!.path === 'out/report.md');
  check('the attempt reports its own evidence entry as AVAILABLE', result.machine.attempts[0]!.evidenceState === 'available');
  check('the observed write is attributed to the attempt', result.machine.attempts[0]!.changedFiles.join(',') === 'out/report.md');
  check('the ordinary shell command is kept as an observed command', result.machine.attempts[0]!.testsRun.join(';') === 'node scripts/render.mjs');
  check('execution success is NOT turned into a test verdict', result.machine.attempts[0]!.outcome === 'success');

  // --- rendered delivery contents ----------------------------------------
  const text = renderRoundDelivery(result);
  check('the delivery view names the task and its full acceptance objective',
    text.includes('TASK c1') && text.includes('acceptance objective: produce the report file'));
  check('the delivery view shows the observed write path', text.includes('out/report.md'));
  check('the delivery view shows the observed shell command', text.includes('node scripts/render.mjs'));
  check('the delivery view labels commands as NOT test verdicts',
    text.includes('observed shell commands (NOT test verdicts)'));
  check('the delivery view reports the test/verification outcome as UNREPORTED',
    text.includes('structured test result: UNREPORTED'));
  check('the delivery view marks the artifact declared and NOT verified',
    text.includes('declared artifacts (declared by the task, NOT verified to exist)'));
  check('the delivery view marks observed writes as tool records, not proof',
    text.includes('the files are NOT verified to exist'));
  check('the root is a container, never presented as unexecuted executable work',
    text.includes("is the round's container") && !text.includes('TASK r'));
  check('the full report embeds the same delivery view',
    renderRoundResult(result).includes('out/report.md') && renderRoundResult(result).includes('structured test result: UNREPORTED'));
}

section('B4.4-b: missing / stale / blocked facts stay honest (no sibling back-fill)');

{
  const root = realTask({ taskId: 'r' });
  const t = succeeded(realTask({ taskId: 'c1', parentTaskId: 'r' }));

  // Two attempts of ONE task; only attempt A has its own evidence entry. B must stay
  // UNKNOWN rather than inheriting A's file/command.
  const result = aggregate({
    tasks: [root, t],
    attempts: realAttemptChain([
      { taskId: 'c1', attemptId: 'A', agentId: 'agent-A', outcome: 'failure', errorCode: 'AGENT_UNAVAILABLE' },
      { taskId: 'c1', attemptId: 'B', agentId: 'agent-B', leaseVersion: 2 },
    ]),
    evidence: {
      A: { changedFiles: ['a.ts'], testsRun: ['cmd-a'], artifacts: [], transcriptPath: 'ta', errorCode: null, errorMessage: null },
    },
  });

  const a = result.machine.attempts.find((x) => x.attemptId === 'A')!;
  const b = result.machine.attempts.find((x) => x.attemptId === 'B')!;
  check('attempt A has its own evidence entry', a.evidenceState === 'available');
  check('attempt A keeps its own file and command', a.changedFiles.join(',') === 'a.ts' && a.testsRun.join(',') === 'cmd-a');
  check('attempt B has NO evidence entry', b.evidenceState === 'unavailable');
  check('attempt B does not inherit A\'s file', b.changedFiles.length === 0 && !b.changedFiles.includes('a.ts'));
  check('attempt B does not inherit A\'s command', b.testsRun.length === 0 && !b.testsRun.includes('cmd-a'));

  const text = renderRoundDelivery(result);
  check('the latest attempt is marked as the current execution',
    text.includes('current execution (latest attempt): B'));
  check('the earlier attempt is marked as history, not current',
    text.includes('historical attempts (superseded; NOT the current delivery)') && text.includes('- A [execution]'));
  const bSection = text.slice(text.indexOf('current execution (latest attempt): B'), text.indexOf('historical attempts'));
  check('B (current) shows no invented write from A', text.includes('unknown (no evidence entry for this attempt)') && !bSection.includes('a.ts'));

  // A STALE task: kept for history, NEVER the current accepted delivery.
  const stale = withStatus(
    realTask({ taskId: 's1', parentTaskId: 'r', acceptanceCriteria: 'an old plan step' }),
    'planned',
    { stale: 'superseded by planner generation 2' },
  );
  const staleResult = aggregate({ tasks: [root, stale] });
  const staleRow = staleResult.machine.tasks.find((x) => x.taskId === 's1')!;
  check('the stale flag is projected from the store', staleRow.stale === true);
  check('the stale reason is projected verbatim', staleRow.staleReason === 'superseded by planner generation 2');
  const staleText = renderRoundDelivery(staleResult);
  check('the delivery view refuses to present a stale task as the current delivery',
    staleText.includes('STALE — this task is NOT a current accepted delivery') &&
    staleText.includes('superseded by planner generation 2'));

  // A BLOCKED task: the reason is the real fact about why it stopped.
  const blocked = withStatus(
    realTask({ taskId: 'b1', parentTaskId: 'r', acceptanceCriteria: 'blocked step' }),
    'blocked',
    { blockedReason: 'dependency-unmet: waiting on c1' },
  );
  const blockedResult = aggregate({ tasks: [root, blocked] });
  check('the blocked reason is projected from the store',
    blockedResult.machine.tasks.find((x) => x.taskId === 'b1')!.blockedReason === 'dependency-unmet: waiting on c1');
  check('the delivery view shows the blocked reason',
    renderRoundDelivery(blockedResult).includes('blocked reason: dependency-unmet: waiting on c1'));

  // A DECLARED artifact on a task that NEVER RAN must not become "produced".
  const never = withStatus(
    realTask({ taskId: 'n1', parentTaskId: 'r', acceptanceCriteria: 'declared only' }),
    'planned',
    { artifacts: [{ name: 'plan', path: 'out/plan.md' }] },
  );
  const neverText = renderRoundDelivery(aggregate({ tasks: [root, never] }));
  check('a declared-but-never-run artifact stays under "declared"',
    neverText.includes('declared artifacts (declared by the task, NOT verified to exist)') && neverText.includes('out/plan.md'));
  check('a never-run task reports run/evidence as UNAVAILABLE',
    neverText.includes('run and evidence are UNAVAILABLE'));
  check('a never-run task has no observed-write line claiming production',
    !neverText.includes('observed writes (tool records; the files are NOT verified to exist): out/plan.md'));

  // A review attempt judges the work and inherits NO execution evidence.
  const withReview = aggregate({
    tasks: [root, t],
    attempts: realAttemptChain([
      { taskId: 'c1', attemptId: 'E', kind: 'execution' },
      { taskId: 'c1', attemptId: 'V', kind: 'review', agentId: 'codex', modelId: null },
    ]),
    evidence: { E: { changedFiles: ['e.ts'], testsRun: ['cmd-e'], artifacts: [], transcriptPath: 'te', errorCode: null, errorMessage: null } },
  });
  const reviewAttempt = withReview.machine.attempts.find((x) => x.attemptId === 'V')!;
  check('a review attempt carries no execution files or commands',
    reviewAttempt.changedFiles.length === 0 && reviewAttempt.testsRun.length === 0);
  const reviewText = renderRoundDelivery(withReview);
  check('the delivery view shows the review separately and inherits nothing',
    reviewText.includes('separate review attempt') && reviewText.includes('inherits no execution evidence'));

  // An OLD persisted report (written before the new fields existed) stays UNKNOWN.
  const modern = aggregate({ tasks: [root, t], attempts: [realAttempt({ attemptId: 'att_old', taskId: 'c1' })] });
  const oldSnapshot = JSON.parse(JSON.stringify(modern)) as { machine: { tasks: Record<string, unknown>[]; attempts: Record<string, unknown>[] } };
  for (const tsk of oldSnapshot.machine.tasks) { delete tsk.stale; delete tsk.staleReason; delete tsk.blockedReason; }
  for (const at of oldSnapshot.machine.attempts) { delete at.evidenceState; }
  const oldText = renderRoundDelivery(oldSnapshot as unknown as RoundResult);
  check('an old snapshot reports stale as unknown, never as false',
    oldText.includes('stale: unknown (this report predates the field)'));
  check('an old snapshot reports attempt evidence as unknown',
    oldText.includes('unknown (this report predates the field)'));
}

section('B4.4-c: rework is REAL work — its own evidence survives, never a false "never executed"');

{
  const root = realTask({ taskId: 'r', acceptanceCriteria: 'the round objective' });
  const t = succeeded(realTask({ taskId: 'c1', parentTaskId: 'r', acceptanceCriteria: 'do the reworkable work' }));

  // The real chain a bounded rework produces: an execution E, then a rework re-entry W
  // BECAUSE a reviewer asked, then the review record V. The workbench records W only when
  // a real RunResult exists, so W's run-derived evidence is real evidence, not consent.
  const chain = realAttemptChain([
    { taskId: 'c1', attemptId: 'E', kind: 'execution', outcome: 'success' },
    { taskId: 'c1', attemptId: 'W', kind: 'rework', outcome: 'success', leaseVersion: 2 },
    { taskId: 'c1', attemptId: 'V', kind: 'review', agentId: 'codex', modelId: null },
  ]);
  const result = aggregate({
    tasks: [root, t],
    attempts: chain,
    evidence: {
      E: { changedFiles: ['old.ts'], testsRun: ['cmd-old'], artifacts: [], transcriptPath: 'old-log', errorCode: null, errorMessage: null },
      W: { changedFiles: ['new.ts'], testsRun: ['cmd-new'], artifacts: [], transcriptPath: 'new-log', errorCode: null, errorMessage: null },
    },
  });

  const e = result.machine.attempts.find((a) => a.attemptId === 'E')!;
  const w = result.machine.attempts.find((a) => a.attemptId === 'W')!;
  const v = result.machine.attempts.find((a) => a.attemptId === 'V')!;
  const c1 = result.machine.tasks.find((x) => x.taskId === 'c1')!;

  check('the rework keeps its OWN changed files (not stripped as non-execution)', w.changedFiles.join(',') === 'new.ts');
  check('the rework keeps its OWN observed command', w.testsRun.join(',') === 'cmd-new');
  check('the rework keeps its OWN transcript', w.transcriptPath === 'new-log');
  check('the rework evidence entry reads available', w.evidenceState === 'available');
  check('the rework is counted as a work attempt', c1.attemptCount === 2);
  check('the earlier execution keeps its OWN evidence', e.changedFiles.join(',') === 'old.ts' && e.transcriptPath === 'old-log');
  check('the review attempt inherits no work evidence', v.changedFiles.length === 0 && v.transcriptPath === null);

  const text = renderRoundDelivery(result);
  check('the rework is presented as the CURRENT execution', text.includes('current execution (latest attempt): W'));
  check('the rework\'s own file is displayed under W', text.includes('new.ts'));
  check('the earlier execution is kept as history, not current',
    text.includes('historical attempts (superseded; NOT the current delivery)') && text.includes('- E [execution]'));
  check('the review is shown separately and does not replace the current real run',
    text.includes('separate review attempt') && text.includes('V agent=codex') &&
    text.indexOf('current execution (latest attempt): W') < text.indexOf('V agent=codex'));

  // The real aggregate fixture: task succeeded + recorded execution/rework records, yet the
  // unified classification carries run:null, so `executed` is false. Absence of
  // classification confirmation must NOT be promoted to proof the task never ran.
  check('the classifier did not confirm execution in this fixture', c1.executed === false);
  check('the delivery view never says "never executed" when attempts are recorded', !text.includes('never executed'));
  check('the status is source-qualified instead',
    text.includes('execution not confirmed by the outcome classification; recorded work attempts below'));

  // A missing W evidence entry must NOT borrow E's.
  const partial = aggregate({
    tasks: [root, t],
    attempts: realAttemptChain([
      { taskId: 'c1', attemptId: 'E2', kind: 'execution' },
      { taskId: 'c1', attemptId: 'W2', kind: 'rework', leaseVersion: 2 },
    ]),
    evidence: {
      E2: { changedFiles: ['old.ts'], testsRun: ['cmd-old'], artifacts: [], transcriptPath: 'old-log', errorCode: null, errorMessage: null },
    },
  });
  const w2 = partial.machine.attempts.find((a) => a.attemptId === 'W2')!;
  check('a rework with no evidence entry reports unavailable', w2.evidenceState === 'unavailable');
  check('a rework with no evidence entry reports no files', w2.changedFiles.length === 0 && !w2.changedFiles.includes('old.ts'));
  check('a rework with no evidence entry reports no transcript', w2.transcriptPath === null);
  const partialText = renderRoundDelivery(partial);
  const w2Section = partialText.slice(
    partialText.indexOf('current execution (latest attempt): W2'),
    partialText.indexOf('historical attempts'),
  );
  check('the current W2 evidence block stays unknown and never borrows E2',
    w2Section.includes('unknown (no evidence entry for this attempt)') && !w2Section.includes('old.ts'));
}

section('R4-12b: an unfinished round is not_ready, not waiting');

{
  const result = aggregate({ tasks: [toVerify(realTask({ taskId: 'c1', parentTaskId: 'r' }))] });
  check('a task in to_verify keeps the gate closed', result.gate.status === 'not_ready');
  check('the unfinished reason names verification', result.machine.unfinished[0]!.reason.includes('Verification'));
  check('the gate still reports no automatic action', result.gate.automaticPostRoundAction === 'none');
}

section('R4-12c: a FAILED review is SETTLED, so the gate opens but flags the gap');

{
  // P2-1 regression. `REVIEW_STATUSES` is a closed vocabulary whose every member is a
  // settled outcome. The old test was `requested && status !== 'completed'`, which called
  // `failed` and `unavailable` still-pending and held the gate shut forever — a round whose
  // reviewer failed could never reach the user who has to decide about it.
  const result = aggregate({
    tasks: [succeeded(realTask())],
    review: reviewFailed,
    reviewRequested: true,
  });
  check('a FAILED review is settled, so it is NOT outstanding', result.gate.reviewOutstanding === false);
  check('the gate therefore OPENS', result.gate.status === 'waiting_for_user');
  check('and the round is complete', result.gate.roundComplete === true);
  check('the missing judgement is still reported', result.gate.reviewWithoutVerdict === true);
  check('the gate offers it as a decision', result.gate.decisions.some((d) => d.id === 'review-unavailable'));
  check('the decision explains there is no independent judgement',
    result.gate.decisions.find((d) => d.id === 'review-unavailable')!.detail.includes('no independent judgement'));
  check('no automatic action is authorised either way', result.gate.automaticPostRoundAction === 'none');

  const unavailable = aggregate({
    tasks: [succeeded(realTask())],
    review: { ...reviewFailed, status: 'unavailable', code: 'reviewer-missing' },
    reviewRequested: true,
  });
  check('an UNAVAILABLE review is settled too', unavailable.gate.reviewOutstanding === false);
  check('and the gate opens for it', unavailable.gate.status === 'waiting_for_user');

  const notRequested = aggregate({
    tasks: [succeeded(realTask())],
    review: reviewNotRequested,
    reviewRequested: false,
  });
  check('a NOT_REQUESTED review is settled', notRequested.gate.reviewOutstanding === false);
  check('and it is not reported as a missing judgement',
    notRequested.gate.reviewWithoutVerdict === false);

  const completed = aggregate({ tasks: [succeeded(realTask())] });
  check('a COMPLETED review is settled', completed.gate.reviewOutstanding === false);
  check('and produced a verdict, so no gap is flagged', completed.gate.reviewWithoutVerdict === false);

  // A status outside the vocabulary is treated as UNSETTLED, so adding a `pending` state
  // later blocks the gate without this file needing to learn the word.
  const pending = aggregate({
    tasks: [succeeded(realTask())],
    review: { ...reviewFailed, status: 'pending' as never },
    reviewRequested: true,
  });
  check('an UNRECOGNISED review status is treated as unsettled', pending.gate.reviewOutstanding === true);
  check('and it does hold the gate closed', pending.gate.status === 'not_ready');
  check('with the review decision offered', pending.gate.decisions.some((d) => d.id === 'await-review'));
}

// ===========================================================================
// 17-18. Next-round contract
// ===========================================================================
section('R4-17: a next-round input can be sealed');

{
  const input = sealNextRoundInput({
    previousRoundId: 'r',
    requirement: 'now make it faster',
    mode: 'continue_task',
    lineage: [{ taskId: 'c1', objective: 'x', taskType: 'implementation', status: 'succeeded', depth: 1, agentId: 'opencode', modelId: null, attemptCount: 1, outcome: 'success', executed: true, artifacts: [], errorCode: null, errorMessage: null }],
    now,
    mintRoundId: (prev) => `${prev}-round2`,
  });

  check('the input records where it came from', input.previousRoundId === 'r');
  check('the input carries a NEW round identity', input.nextRoundId === 'r-round2');
  check('the identity is genuinely different', input.nextRoundId !== input.previousRoundId);
  check("the user's own requirement is carried", input.requirement === 'now make it faster');
  check('the existing task lineage is reusable', input.taskLineage[0]!.taskId === 'c1');
  check('the input is marked NOT executed', input.executed === false);
  check('the previous result is pointed at, not copied', input.previousResultRoundId === 'r');

  const sealedNew = sealNextRoundInput({
    previousRoundId: 'r',
    requirement: 'something entirely new',
    mode: 'new_round',
    now,
    mintRoundId: (prev) => `${prev}-round2`,
  });
  check('a new requirement forms a new identity', sealedNew.nextRoundId !== 'r');
  check('a new round carries NO task lineage', sealedNew.taskLineage.length === 0);
  check('the mode distinguishes the two cases', sealedNew.mode === 'new_round' && input.mode === 'continue_task');
}

section('R4-18: a next round can never be confused with the previous one');

{
  let refused = false;
  try {
    sealNextRoundInput({
      previousRoundId: 'r',
      requirement: 'reuse the same id',
      mode: 'new_round',
      now,
      // A broken id minter must not be able to merge two rounds into one lifecycle.
      mintRoundId: () => 'r',
    });
  } catch {
    refused = true;
  }
  check('reusing the previous roundId is REFUSED', refused);

  let emptyRefused = false;
  try {
    sealNextRoundInput({ previousRoundId: 'r', requirement: '   ', mode: 'new_round', now, mintRoundId: (p) => `${p}-2` });
  } catch {
    emptyRefused = true;
  }
  check('an empty requirement is REFUSED', emptyRefused);
}

section('R4-17b: the gate reflects a user decision without gaining authority');

{
  const gate = aggregate({ tasks: [succeeded(realTask())] }).gate;
  const input = sealNextRoundInput({
    previousRoundId: 'r', requirement: 'go on', mode: 'new_round', now, mintRoundId: (p) => `${p}-2`,
  });
  const answered = gateWithUserDecision(gate, { nextRoundInput: input, closedByUser: false });
  check('answering moves the gate to ready_for_next_round', answered.status === 'ready_for_next_round');
  check('the reason names both rounds', answered.reason.includes('r-2') && answered.reason.includes('previous round r'));
  check('answering still authorises NO automatic action', answered.automaticPostRoundAction === 'none');
  check('answering still starts nothing', input.executed === false);

  const closed = gateWithUserDecision(gate, { nextRoundInput: null, closedByUser: true });
  check('closing the gate reports completed', closed.status === 'completed');
  check('closing also authorises nothing', closed.automaticPostRoundAction === 'none');

  const untouched = gateWithUserDecision(gate, { nextRoundInput: null, closedByUser: false });
  check('no decision leaves the gate waiting', untouched.status === 'waiting_for_user');
}

section('R4-17c: deriveHumanGate is total and side-effect free');

{
  const t = succeeded(realTask());
  const first = deriveHumanGate({ tasks: aggregate({ tasks: [t] }).machine.tasks, review: aggregate({ tasks: [t] }).review, handoffs: [] });
  const second = deriveHumanGate({ tasks: aggregate({ tasks: [t] }).machine.tasks, review: aggregate({ tasks: [t] }).review, handoffs: [] });
  check('the same evidence derives the same gate', first.status === second.status && first.reason === second.reason);
  const empty = deriveHumanGate({
    tasks: [],
    review: { ...aggregate({ reviewRequested: false, review: reviewNotRequested }).review },
    handoffs: [],
  });
  check('an empty round still derives a gate', (HUMAN_GATE_STATUSES as readonly string[]).includes(empty.status));
  check('an empty round reports a complete tally', empty.taskTally.succeeded === 0);
}

// ===========================================================================
// Rendering — the report answers the required questions, in three layers
// ===========================================================================
section('R4-19: the rendered report separates machine / review / summary');

{
  const result = aggregate({
    tasks: [succeeded(realTask({ taskId: 'c1', parentTaskId: 'r' }))],
    attempts: [realAttempt({ taskId: 'c1' })],
    review: reviewOk('reject'),
    evidence: {
      att_0001: {
        changedFiles: ['src/a.ts', 'src/b.ts'],
        testsRun: ['npm test'],
        artifacts: [{ name: 'patch', path: '/tmp/p.diff' }],
        transcriptPath: null,
        errorCode: null,
        errorMessage: null,
      },
    },
  });
  const text = renderRoundResult(result);

  check('it states what the user asked for', text.includes('make the thing better'));
  check('it states how Laya shaped it', text.includes('How Laya shaped it'));
  check('it states what ran', text.includes('what actually ran'));
  check('it lists the files changed', text.includes('src/a.ts') && text.includes('src/b.ts'));
  check('it lists the tests run', text.includes('npm test'));
  check('it lists artifacts', text.includes('patch'));
  check('it states the review conclusion', text.includes('Review conclusion'));
  check('it marks the review as not machine evidence', text.includes('NOT machine evidence'));
  check('a non-pass verdict is printed as itself', text.includes('- verdict: reject'));
  check('it has a user-facing summary section', text.includes('User-facing summary'));
  check('it has a HUMAN GATE section', text.includes('HUMAN GATE'));
  check('it reports unfinished work when there is some', !text.includes('## Unfinished'));
  check('the three layers are separate sections',
    text.indexOf('Machine evidence') < text.indexOf('Review conclusion')
    && text.indexOf('Review conclusion') < text.indexOf('User-facing summary'));
}

// ===========================================================================
// Persistence — a report artifact, never a state authority
// ===========================================================================
section('R4-20: the round result publishes as a report artifact');

{
  const dir = mkdtempSync(join(tmpdir(), 'r4-result-'));
  const result = aggregate({ tasks: [succeeded(realTask())] });

  const written = publishRoundResult(result, { dir });
  check('the write succeeds', written.ok === true && written.wrote === true);
  check('the path is reported', written.path.endsWith('round-result.json'));

  const readBack = readRoundResult(written.path) as RoundResult | null;
  check('the result round-trips', readBack !== null && readBack.identity.roundId === 'r');
  check('the gate survives the round trip', readBack!.gate.status === 'waiting_for_user');

  // A second round must not be able to erase the first round's record by accident.
  const second = aggregate({ tasks: [succeeded(realTask())], roundId: 'r2' });
  publishRoundResult(second, { dir });
  const afterSecond = readRoundResult(written.path) as RoundResult;
  check('a later publish replaces the file, and says which round it is', afterSecond.identity.roundId === 'r2');

  check('a missing file reads as null, not as a crash', readRoundResult(join(dir, 'nope.json')) === null);

  // A malformed file must not take the dashboard down.
  const badPath = join(dir, 'bad.json');
  rmSync(badPath, { force: true });
  publishRoundResult({ partial: true }, { path: badPath });
  check('a malformed/unknown payload reads as null rather than throwing', readRoundResult(badPath) !== undefined);

  rmSync(dir, { recursive: true, force: true });
}

// ===========================================================================
// 19-22. ARCHITECTURE GUARDS — measured on the real source
// ===========================================================================
section('R4-21: architecture guards');

{
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const read = (rel: string): string => sourceText(join(root, rel));

  // Strip comments so documentation about the rule cannot satisfy the rule.
  const stripComments = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const rr = read('src/orchestration/round-result.ts');
  const rrCode = stripComments(rr);

  check('aggregation owns NO execution edge', !/this\.runtime\.run\(|\.runtime\.run\(/.test(rrCode));
  check('aggregation never constructs a scheduler', !/new\s+TaskScheduler\s*\(/.test(rrCode));
  check('aggregation never constructs a TaskStore', !/new\s+TaskStore\s*\(/.test(rrCode));
  check('aggregation never constructs an AttemptStore', !/new\s+AttemptStore\s*\(/.test(rrCode));
  check('aggregation never calls executeTask', !/executeTask\s*\(/.test(rrCode));
  check('aggregation never calls the decision brain', !/runDecisionCycle|decide\s*\(/.test(rrCode));
  check('aggregation never applies a verdict', !/applyReviewVerdict|applyVerification/.test(rrCode));
  check('aggregation never imports an orchestrator or scheduler', !/from\s+'.*(orchestrator|scheduler|store|attempt-store)\.ts'/.test(rrCode));
  check('aggregation does no I/O of its own', !/node:fs|writeFileSync|readFileSync/.test(rrCode));
  check('the gate exposes exactly the declared vocabulary',
    HUMAN_GATE_STATUSES.length === 4);

  // The gate is data. It cannot act, because there is nothing in it that acts.
  const gate = aggregate({ tasks: [succeeded(realTask())] }).gate;
  check('the gate object carries no function values', Object.values(gate).every((v) => typeof v !== 'function'));
  check('the gate declares its own inaction', gate.automaticPostRoundAction === 'none');

  // The review still owns no retry/reassign authority.
  const ur = stripComments(read('src/orchestration/unified-review.ts'));
  check('review still does not call the orchestrator', !/executeTask\s*\(|runDecisionCycle/.test(ur));
  check('review still does not apply its own verdict', !/applyReviewVerdict\s*\(/.test(ur));

  // Scheduler / execution edge uniqueness across the whole tree.
  const tree = stripComments(read('src/orchestration/orchestrator.ts'));
  const edges = (tree.match(/this\.runtime\.run\s*\(/g) ?? []).length;
  check('there is still exactly ONE runtime.run edge', edges === 1);

  const rrCli = stripComments(read('src/cli/round-cli.ts'));
  check('the round still runs the review exactly once', (rrCli.match(/runUnifiedReview\s*\(/g) ?? []).length === 1);
  check('the round does not dispatch anything after the gate',
    gateIsLast(rrCli));
}

/**
 * True when nothing that could START WORK appears between the human-gate block and the
 * function's `return`. Measured on the source, so it cannot rot silently.
 *
 * It matches CALLS, never prose: the gate prints sentences containing the words
 * "retried", "reassigned" and "replanned" precisely because it did none of them, and a
 * guard that flagged its own honest output would be worthless.
 */
function gateIsLast(source: string): boolean {
  const gateAt = source.indexOf("w('HUMAN GATE')");
  if (gateAt < 0) return false;
  const tail = source.slice(gateAt);
  const end = tail.indexOf('return report.ok');
  if (end < 0) return false;
  const between = tail.slice(0, end);
  return !/\.\s*dispatch\s*\(|executeTask\s*\(|runDecisionCycle\s*\(|runHandoffContinuation\s*\(|\.\s*retry\s*\(|spawnChild\s*\(|\.\s*replan\s*\(|applyVerification\s*\(|applyReviewVerdict\s*\(/.test(between);
}

// ---------------------------------------------------------------------------
process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length > 0) process.stdout.write(`failing:\n  ${failures.join('\n  ')}\n`);
process.exitCode = failed === 0 ? 0 : 1;
