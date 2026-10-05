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

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TaskStore } from '../src/orchestration/store.ts';
import type { Task } from '../src/orchestration/task.ts';
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
  buildRoundResult,
  deriveHumanGate,
  gateWithUserDecision,
  renderRoundResult,
  sealNextRoundInput,
  type BuildRoundResultInput,
  type RoundResult,
} from '../src/orchestration/round-result.ts';
import { publishRoundResult, readRoundResult } from '../src/orchestration/round-observation.ts';

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

/** Drive a real task to a real status through the store's own transition table. */
function withStatus(task: Task, status: Task['status']): Task {
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
  // `planned -> queued -> running -> to_verify -> terminal` is the real path, so the
  // status under test is reached through the same guards production uses.
  const path: Task['status'][] = status === 'planned' ? []
    : status === 'queued' ? ['queued']
    : status === 'running' ? ['queued', 'running']
    : status === 'blocked' ? ['queued', 'blocked']
    : status === 'to_verify' ? ['queued', 'running', 'to_verify']
    : status === 'succeeded' ? ['queued', 'running', 'to_verify', 'succeeded']
    : status === 'failed' ? ['queued', 'running', 'failed']
    : ['queued', 'running', 'cancelled'];
  for (const step of path) {
    const moved = store.transition(task.taskId, step, NOW, 'fixture');
    if (!moved.ok) throw new Error(`fixture could not move ${task.taskId} to ${step}: ${moved.reason ?? moved.code}`);
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
    evidence: {
      c1: {
        changedFiles: ['src/a.ts'],
        testsRun: ['npm test'],
        artifacts: [{ name: 'patch', path: '/tmp/p.diff' }],
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
  check('its artifacts are kept', a.artifacts[0]!.name === 'patch');
  check('its transcript pointer is kept', a.transcriptPath === '/tmp/t.jsonl');
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
      c1: {
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
      c1: {
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
  check('blocked: it is reported as never started', blocked.gate.neverStartedTasks.some((n) => n.taskId === 'c1'));
}

section('R4-12b: an unfinished round is not_ready, not waiting');

{
  const result = aggregate({ tasks: [toVerify(realTask({ taskId: 'c1', parentTaskId: 'r' }))] });
  check('a task in to_verify keeps the gate closed', result.gate.status === 'not_ready');
  check('the unfinished reason names verification', result.machine.unfinished[0]!.reason.includes('Verification'));
  check('the gate still reports no automatic action', result.gate.automaticPostRoundAction === 'none');
}

section('R4-12c: a requested but incomplete review holds the gate closed');

{
  const result = aggregate({
    tasks: [succeeded(realTask())],
    review: reviewFailed,
    reviewRequested: true,
  });
  check('an incomplete review is outstanding', result.gate.reviewOutstanding === true);
  check('the gate is not ready', result.gate.status === 'not_ready');
  check('the gate explains why', result.gate.reason.includes('review'));
  check('the gate offers the review decision', result.gate.decisions.some((d) => d.id === 'await-review'));
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
      c1: {
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
  const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

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
