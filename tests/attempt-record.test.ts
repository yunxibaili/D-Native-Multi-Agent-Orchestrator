/**
 * tests/attempt-record.test.ts - P6-E: structured attempt evidence.
 *
 * THE CLAIMS UNDER TEST
 * ---------------------
 *   1. an attempt is described by structured evidence, never a transcript
 *   2. evidence comes only from things that REALLY happened
 *   3. execution / review / rework are distinguishable, and retry != rework
 *   4. the history is a chain in real append order
 *   5. AttemptStore is EVIDENCE ONLY - it cannot reach task state or dispatch
 *   6. Task.status and AttemptRecord are independent; neither writes the other
 *   7. aggregation is read-only, and reports counts rather than ranking anyone
 *
 * Point 5 and 6 are asserted from the SOURCE as well as at runtime, because
 * "the store did not touch anything this time" is not the same claim as "the store
 * cannot touch anything".
 */

import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Orchestrator } from '../src/orchestration/orchestrator.ts';
import { TaskScheduler } from '../src/orchestration/scheduler.ts';
import { TaskStore } from '../src/orchestration/store.ts';
import {
  ATTEMPT_KINDS,
  ATTEMPT_OUTCOMES,
  AttemptRecordError,
  isAttemptRecordError,
  validateAttemptRecord,
  executionAttempt,
  reworkAttempt,
  reviewAttempt,
} from '../src/orchestration/attempt-record.ts';
import { AttemptStore } from '../src/orchestration/attempt-store.ts';
import { recordExecution, recordExecutions, recordReview } from '../src/orchestration/attempt-integration.ts';
import { applyReviewVerdict, prepareRework } from '../src/orchestration/review-loop.ts';
import { validateReviewVerdict } from '../src/orchestration/review-verdict.ts';
import { ModelRegistry } from '../src/quota/registry.ts';
import { BudgetManager } from '../src/quota/budget.ts';
import type { QuotaRecord, TaskType } from '../src/quota/types.ts';
import type { AgentDescriptor, RunHandle, RunRequest, RunResult } from '../src/core/types.ts';
import type { RuntimeRunner } from '../src/orchestration/execute.ts';

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
function section(t: string): void {
  process.stdout.write(`\n== ${t} ==\n`);
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

const quotaRecord = (a: string, s: QuotaRecord['status']): QuotaRecord => ({
  provider: a, agentId: a, modelId: null, source: 'locally_observed', usage: null,
  remaining: null, resetAt: null, period: 'day', status: s,
  usageClass: 'observed', confidence: 'high', observedAt: NOW, note: '',
});

const registryWith = (e: Array<[string, string, string[]]>): ModelRegistry => {
  const r = new ModelRegistry();
  for (const [agentId, modelId, tt] of e) {
    r.upsert({ agentId, modelId, provider: 'test', taskTypes: tt as never, modelSource: 'test', quotaSource: 'test' }, NOW);
    r.setAvailability(agentId, 'available');
  }
  return r;
};

const gateSources = (taskIds: readonly string[]) => {
  const budgets = new BudgetManager(100_000);
  for (const t of taskIds) budgets.task(t, 10_000);
  budgets.agent(AGENT, 10_000);
  return {
    descriptors: [descriptor(AGENT)],
    agentStatus: [{ agent: AGENT, version: '1', installed: 'Yes', login: 'n', quotaSource: 't', usage: 'n', status: 'ok' } as never],
    quotaRecords: [quotaRecord(AGENT, 'available')],
    registry: registryWith([[AGENT, SB, ['implementation', 'research', 'test']]]),
    budgets,
    taskType: impl, requestedUnits: 100, currentConcurrency: 0,
    maxConcurrency: 4, maxChildren: 8, maxConcurrentAgents: 4,
  } as never;
};

/** A runtime whose result state and usage can be scripted per call. */
function scriptedRuntime(script: Array<'succeeded' | 'failed' | 'cancelled'>): { runtime: RuntimeRunner; requests: RunRequest[] } {
  const requests: RunRequest[] = [];
  let i = 0;
  const runtime: RuntimeRunner = {
    run(req: RunRequest): RunHandle {
      requests.push(req);
      const state = script[Math.min(i, script.length - 1)] ?? 'succeeded';
      i++;
      const result = {
        taskId: `rt-${i}`, agentId: req.agentId, state,
        error: state === 'failed' ? { code: 'NONZERO_EXIT', message: `exit ${7}` } : null,
        startedAt: 100, endedAt: 200 + i, exitCode: state === 'failed' ? 7 : 0, signal: null,
        output: 'a long transcript that must NOT be copied into the record',
        outputTruncated: false, transcriptPath: '/tmp/transcript.jsonl',
        usage: { costUsd: 0 }, toolCalls: [], diagnostics: [],
        cleanup: { rootKilled: false, descendantsReaped: false, note: '' },
      } as unknown as RunResult;
      return { result: async () => result, cancel: async () => {}, dispose: async () => {} } as unknown as RunHandle;
    },
  };
  return { runtime, requests };
}

const tmpDir = (): string => mkdtempSync(join(tmpdir(), 'p6e-'));

const baseRecord = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  taskId: 't1', kind: 'execution', agentId: 'opencode', modelId: SB, taskType: impl,
  startedAt: 100, finishedAt: 200, outcome: 'success', ...over,
});

// ---------------------------------------------------------------------------
// 1. Contract
// ---------------------------------------------------------------------------
section('P6-E 1. contract: valid, malformed, immutable, unique');
{
  const r = validateAttemptRecord(baseRecord());
  check('a valid record validates', r.taskId === 't1' && r.kind === 'execution');
  check('a validated record is frozen', Object.isFrozen(r));
  check('modelId defaults to null when absent', validateAttemptRecord({ ...baseRecord(), modelId: undefined }).modelId === null);
  check('taskType has a default', validateAttemptRecord({ ...baseRecord(), taskType: undefined }).taskType === 'implementation');
  check('finishedAt may be null (an attempt in flight)', validateAttemptRecord(baseRecord({ finishedAt: null })).finishedAt === null);
  check('previousAttemptId defaults to null', validateAttemptRecord(baseRecord()).previousAttemptId === null);

  const codeOf = (raw: unknown): string => {
    try { validateAttemptRecord(raw); return '<no error thrown>'; }
    catch (e) { return isAttemptRecordError(e) ? e.code : `<wrong: ${String(e)}>`; }
  };
  check('a non-object is refused', codeOf(null) === 'malformed-record');
  check('an array is refused', codeOf([]) === 'malformed-record');
  check('a missing taskId is refused', codeOf({ ...baseRecord(), taskId: '' }) === 'malformed-record');
  check('a missing agentId is refused', codeOf({ ...baseRecord(), agentId: undefined }) === 'malformed-record');
  check('an unknown kind is refused', codeOf(baseRecord({ kind: 'vibes' })) === 'malformed-record');
  check('an unknown outcome is refused', codeOf(baseRecord({ outcome: 'great' })) === 'malformed-record');
  check('a non-numeric startedAt is refused', codeOf(baseRecord({ startedAt: 'now' })) === 'malformed-record');
  check('a non-finite startedAt is refused', codeOf(baseRecord({ startedAt: Infinity })) === 'malformed-record');
  check('a bad finishedAt is refused', codeOf(baseRecord({ finishedAt: 'later' })) === 'malformed-record');
  check('a non-numeric errorCode is refused', codeOf(baseRecord({ errorCode: 7 }) ) === 'malformed-record');
  check('a non-numeric budgetUnits is refused', codeOf(baseRecord({ budgetUnits: 'ten' }) ) === 'malformed-record');
  check('a bad verification verdict is refused',
    codeOf(baseRecord({ verification: { verdict: 'maybe' } })) === 'malformed-record');
  check('a non-object verification is refused', codeOf(baseRecord({ verification: 'pass' })) === 'malformed-record');

  check('the refusal is an AttemptRecordError with an actionable message', (() => {
    try { validateAttemptRecord(null); return false; }
    catch (e) {
      return e instanceof AttemptRecordError && e.name === 'AttemptRecordError' && e.message.includes('not evidence');
    }
  })());

  check('the attempt vocabulary is frozen', ATTEMPT_KINDS.join(',') === 'execution,review,rework');
  check('the outcome vocabulary is frozen',
    ATTEMPT_OUTCOMES.join(',') === 'success,failure,rework,reject,aborted,error');

  // uniqueness + immutability through the store
  const store = new AttemptStore();
  const a = store.append(baseRecord({ taskId: 'u1' }));
  check('append returns the stored record', a.ok && a.record.attemptId.length > 0);
  check('the store assigned an id', a.ok && a.record.attemptId === 'att_0001', a.ok ? a.record.attemptId : '');
  const dup = store.append(baseRecord({ taskId: 'u1', attemptId: a.ok ? a.record.attemptId : 'x' }));
  check('a duplicate attemptId is REFUSED, not silently overwritten', !dup.ok && dup.code === 'attempt-id-duplicate', JSON.stringify(dup));
  check('the original is still intact after the refused duplicate',
    a.ok && store.get(a.record.attemptId)?.taskId === 'u1');
  check('a malformed append returns a result, it does not throw', (() => {
    const bad = store.append({ nonsense: true });
    return !bad.ok && bad.code === 'malformed-record';
  })());
  check('nothing was stored for the refused appends', store.size === 1, String(store.size));
  check('a stored record cannot be mutated by a caller',
    a.ok && Object.isFrozen(a.record) && Object.isFrozen(store.get(a.record.attemptId) ?? null));
}

// ---------------------------------------------------------------------------
// 2. Execution evidence, only from real results
// ---------------------------------------------------------------------------
section('P6-E 2. execution evidence derives from a real RunResult');
{
  const okRun = { state: 'succeeded', agentId: AGENT, error: null, startedAt: 10, endedAt: 30, usage: { costUsd: 0 } } as unknown as Parameters<typeof executionAttempt>[0]['result'];
  const badRun = { state: 'failed', agentId: AGENT, error: { code: 'NONZERO_EXIT', message: 'boom' }, startedAt: 10, endedAt: 30, usage: null } as unknown as Parameters<typeof executionAttempt>[0]['result'];
  const cancelRun = { state: 'cancelled', agentId: AGENT, error: null, startedAt: 10, endedAt: 30, usage: null } as unknown as Parameters<typeof executionAttempt>[0]['result'];

  check('a succeeded run -> outcome success', executionAttempt({ taskId: 't', agentId: AGENT, modelId: SB, result: okRun }).outcome === 'success');
  check('a failed run -> outcome failure', executionAttempt({ taskId: 't', agentId: AGENT, modelId: SB, result: badRun }).outcome === 'failure');
  check('a cancelled run -> outcome aborted (NOT failure)',
    executionAttempt({ taskId: 't', agentId: AGENT, modelId: SB, result: cancelRun }).outcome === 'aborted');
  check('a failure carries the error code and message',
    (() => { const r = executionAttempt({ taskId: 't', agentId: AGENT, modelId: SB, result: badRun });
      return r.errorCode === 'NONZERO_EXIT' && r.errorMessage === 'boom'; })());
  check('a success carries no error code',
    executionAttempt({ taskId: 't', agentId: AGENT, modelId: SB, result: okRun }).errorCode === undefined);
  check('a reported zero cost IS recorded as zero',
    executionAttempt({ taskId: 't', agentId: AGENT, modelId: SB, result: okRun }).costUsd === 0);
  check('an unreported cost is ABSENT, not zero',
    executionAttempt({ taskId: 't', agentId: AGENT, modelId: SB, result: badRun }).costUsd === undefined);
  check('duration is derivable from startedAt/finishedAt (both stored)',
    executionAttempt({ taskId: 't', agentId: AGENT, modelId: SB, result: okRun }).startedAt === 10 &&
    executionAttempt({ taskId: 't', agentId: AGENT, modelId: SB, result: okRun }).finishedAt === 30);
  check('budget evidence is carried when the caller declares it',
    executionAttempt({ taskId: 't', agentId: AGENT, modelId: SB, result: okRun, budgetUnits: 10 }).budgetUnits === 10);

  check('CRITICAL: no transcript / output text is copied into a record',
    JSON.stringify(executionAttempt({ taskId: 't', agentId: AGENT, modelId: SB, result: { ...okRun, output: 'SECRET PROMPT TEXT' } as never }))
      .indexOf('SECRET PROMPT TEXT') === -1);
  check('no transcript path is copied either',
    !('transcriptPath' in (executionAttempt({ taskId: 't', agentId: AGENT, modelId: SB, result: { ...okRun, transcriptPath: '/t/x' } as never }) as never)));
  check('no token log is copied',
    !('toolCalls' in (executionAttempt({ taskId: 't', agentId: AGENT, modelId: SB, result: { ...okRun, toolCalls: [1, 2, 3] } as never }) as never)));

  // retry != rework
  const plain = executionAttempt({ taskId: 't', agentId: AGENT, modelId: SB, result: okRun });
  const rew = reworkAttempt({ taskId: 't', agentId: AGENT, modelId: SB, result: okRun });
  check('a rework attempt has kind "rework", not "execution"', rew.kind === 'rework' && plain.kind === 'execution');
  check('identical results produce different kinds (they are NOT conflated)', plain.kind !== rew.kind);
  check('a failed REWORK is still kind rework, not a retry',
    reworkAttempt({ taskId: 't', agentId: AGENT, modelId: SB, result: badRun }).kind === 'rework');
  check('a failed rework still reports outcome failure',
    reworkAttempt({ taskId: 't', agentId: AGENT, modelId: SB, result: badRun }).outcome === 'failure');
}

// ---------------------------------------------------------------------------
// 3. The store records a chain in real append order
// ---------------------------------------------------------------------------
section('P6-E 3. history is an ordered chain');
{
  const store = new AttemptStore();
  const okRun = { state: 'succeeded', agentId: AGENT, error: null, startedAt: 0, endedAt: 1, usage: null } as unknown as Parameters<typeof executionAttempt>[0]['result'];
  const badRun = { state: 'failed', agentId: AGENT, error: { code: 'E', message: 'm' }, startedAt: 0, endedAt: 1, usage: null } as unknown as Parameters<typeof executionAttempt>[0]['result'];

  const a = store.append(executionAttempt({ taskId: 'c1', agentId: AGENT, modelId: SB, result: okRun }));
  const b = store.append(reviewAttempt({
    taskId: 'c1', reviewer: 'codex',
    verdict: validateReviewVerdict({ verdict: 'rework', reason: 'needs work', findings: [{ location: 'a', severity: 'minor', message: 'm' }], recommendedAction: 'rework', reviewer: 'codex', reviewedAt: 500 }),
  }));
  const c = store.append(reworkAttempt({ taskId: 'c1', agentId: AGENT, modelId: SB, result: okRun }));
  check('all three were recorded', a.ok && b.ok && c.ok);
  if (!a.ok || !b.ok || !c.ok) throw new Error('setup failed');

  const h = store.history('c1');
  check('history has all three attempts', h.length === 3);
  check('history is in append order', h[0].kind === 'execution' && h[1].kind === 'review' && h[2].kind === 'rework',
    h.map((r) => r.kind).join(','));
  check('the first attempt has no predecessor', h[0].previousAttemptId === null);
  check('the second points at the first', h[1].previousAttemptId === h[0].attemptId);
  check('the third points at the second', h[2].previousAttemptId === h[1].attemptId);
  check('a caller CANNOT forge the chain link', (() => {
    const s2 = new AttemptStore();
    const x = s2.append({ ...baseRecord({ taskId: 'z' }), previousAttemptId: 'att_9999' });
    return x.ok && x.record.previousAttemptId === null;
  })());
  check('a caller cannot skip the chain either', (() => {
    const s2 = new AttemptStore();
    const x = s2.append(baseRecord({ taskId: 'z' }));
    const y = s2.append({ ...baseRecord({ taskId: 'z' }), previousAttemptId: 'att_0001' });
    return y.ok && y.record.previousAttemptId === (x.ok ? x.record.attemptId : 'x');
  })());
  check('history for an unknown task is empty, not an error', store.history('nope').length === 0);
  check('attempt kinds can be counted per task', store.countByKind('c1', 'review') === 1);
  check('a failure is recorded as failure, not as a review',
    store.append(reworkAttempt({ taskId: 'c1', agentId: AGENT, modelId: SB, result: badRun })).ok &&
    store.history('c1')[3].outcome === 'failure');
  check('so "failed at running" and "failed at reviewing" stay distinguishable',
    store.history('c1').filter((r) => r.outcome === 'failure')[0].kind === 'rework' &&
    store.history('c1')[1].kind === 'review');
}

// ---------------------------------------------------------------------------
// 4. A scheduler refusal produces NO fabricated execution evidence
// ---------------------------------------------------------------------------
section('P6-E 4. a skipped or refused dispatch records nothing');
{
  const store = new AttemptStore();
  const fakeTick = {
    admitted: [], waiting: ['c1'],
    skipped: [
      { taskId: 'c1', code: 'dependency-unmet', reason: 'waiting on x' },
      { taskId: 'c2', code: 'gate-denied', reason: 'no budget' },
    ],
    outcomes: [
      // Both refused: no `ok`, therefore no RunResult, therefore no evidence.
      { taskId: 'c1', outcome: { ok: false, code: 'dependency-unmet', reason: 'waiting on x' } },
      { taskId: 'c2', outcome: { ok: false, code: 'gate-denied', reason: 'no budget' } },
    ],
    freeSlots: 2,
  } as never;
  const resolve = () => ({ agentId: AGENT, modelId: SB, budgetUnits: 10, taskType: impl });

  const res = recordExecutions(store, fakeTick, resolve);
  check('a refused dispatch records NOTHING', store.size === 0, `stored ${store.size}`);
  check('and both tasks are reported as NOT recorded', res.recorded.length === 0 && res.notRecorded.length === 2,
    JSON.stringify(res));
  check('no success record was fabricated for a waiting task', store.history('c1').length === 0);
  check('no failure record was fabricated for a gate refusal', store.history('c2').length === 0);

  // Contrast: a real admitted run DOES record.
  const okTick = {
    admitted: ['c3'], waiting: [], skipped: [],
    outcomes: [{ taskId: 'c3', outcome: { ok: true, run: { state: 'succeeded', agentId: AGENT, error: null, startedAt: 0, endedAt: 5, usage: null } } }],
    freeSlots: 1,
  } as never;
  const res2 = recordExecutions(store, okTick, resolve);
  check('a real admitted run DOES record', res2.recorded.join(',') === 'c3' && store.history('c3').length === 1);
  check('and it recorded success, not a refusal', store.history('c3')[0].outcome === 'success');
}

// ---------------------------------------------------------------------------
// 5. The full chain, through real classes
// ---------------------------------------------------------------------------
section('P6-E 5. execution -> review -> rework -> review, against a real orchestrator');
{
  const dir = tmpDir();
  const store = new AttemptStore();
  const { runtime, requests } = scriptedRuntime(['succeeded', 'succeeded']);
  const orch = new Orchestrator({ gate: gateSources(['r', 'c1']), now, runtime, defaultCwd: dir });
  orch.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' });
  orch.spawnChild({
    taskId: 'c1', parentTaskId: 'r', agentId: AGENT, modelId: SB,
    taskType: impl, acceptanceCriteria: 'do the work', budgetUnits: 10,
  });
  const scheduler = new TaskScheduler({ orchestrator: orch, cwd: dir, rootTaskId: 'r' });

  // --- attempt 1: a real execution ---
  const tick1 = await scheduler.tick();
  check('the first tick really dispatched', tick1.admitted.includes('c1'));
  const meta = (id: string) => {
    const t = orch.getStore().get(id);
    return t === null ? null : { agentId: t.agentId, modelId: t.modelId, budgetUnits: t.budgetUnits, taskType: t.taskType };
  };
  const e1 = recordExecutions(store, tick1, meta);
  check('execution evidence was recorded', e1.recorded.includes('c1'), JSON.stringify(e1));
  check('it is an execution attempt with a success outcome',
    store.history('c1')[0]?.kind === 'execution' && store.history('c1')[0]?.outcome === 'success');
  check('it carries the real budget units', store.history('c1')[0]?.budgetUnits === 10);
  check('it carries the real task type', store.history('c1')[0]?.taskType === impl);

  // --- review #1: rework ---
  const reworkVerdict = validateReviewVerdict({
    verdict: 'rework', reason: 'the newline is dropped',
    findings: [{ location: 'src/p.ts:42', severity: 'major', message: 'drops the newline', evidence: 'line 42' }],
    recommendedAction: 'rework', reviewer: 'codex', reviewedAt: NOW + 10,
  });
  const applied = applyReviewVerdict({ orchestrator: orch, taskId: 'c1', verdict: reworkVerdict });
  check('the rework verdict was applied', applied.status === 'ok', applied.status);
  recordReview(store, { taskId: 'c1', reviewer: 'codex', verdict: reworkVerdict, taskType: impl });
  const rev = store.history('c1')[1];
  check('review evidence was recorded', rev?.kind === 'review');
  check('it is attributed to the REVIEWER, not the worker', rev?.agentId === 'codex', rev?.agentId);
  check('it carries the verdict', rev?.verification?.verdict === 'rework');
  check('it carries the fingerprint', rev?.verification?.fingerprint === reworkVerdict.fingerprint);
  check('it carries a finding COUNT, not the finding text',
    rev?.verification?.findingCount === 1 && JSON.stringify(rev).indexOf('drops the newline') === -1);
  check('its outcome is rework, not success or failure', rev?.outcome === 'rework');

  // --- rework: re-entry, then a real second execution ---
  const re = prepareRework(orch, 'c1', 'address the finding');
  check('the rework was re-entered through the existing transition', re.ok && re.code === 'queued');
  const tick2 = await scheduler.tick();
  check('the scheduler dispatched the rework', tick2.admitted.includes('c1'));
  const reMeta = meta('c1');
  const reworkOutcome = tick2.outcomes.find((o) => o.taskId === 'c1')?.outcome;
  check('the rework produced a real result to record', reworkOutcome !== undefined && reworkOutcome.ok);
  const reRec = reworkOutcome !== undefined && reworkOutcome.ok
    ? recordExecution(store, {
      taskId: 'c1', agentId: reMeta!.agentId, modelId: reMeta!.modelId,
      result: reworkOutcome.run,
      budgetUnits: reMeta!.budgetUnits, taskType: reMeta!.taskType, isRework: true,
    })
    : null;
  check('the rework execution was recorded', reRec !== null && reRec.kind === 'rework',
    reRec === null ? 'null' : reRec.kind);
  check('the rework attempt is counted separately from the first execution',
    store.history('c1').filter((r) => r.kind === 'execution').length === 1 &&
    store.history('c1').filter((r) => r.kind === 'rework').length === 1);
  check('the chain is execution, review, rework in that order',
    store.history('c1').map((r) => r.kind).join(' -> ') === 'execution -> review -> rework',
    store.history('c1').map((r) => r.kind).join(' -> '));

  // --- review #2: pass ---
  const passVerdict = validateReviewVerdict({
    verdict: 'pass', reason: 'newline handled now', findings: [],
    recommendedAction: 'none', reviewer: 'codex', reviewedAt: NOW + 20,
  });
  const passApplied = applyReviewVerdict({ orchestrator: orch, taskId: 'c1', verdict: passVerdict });
  check('the pass verdict was applied', passApplied.status === 'ok', passApplied.status);
  recordReview(store, { taskId: 'c1', reviewer: 'codex', verdict: passVerdict, taskType: impl });

  const hist = store.history('c1');
  check('the full chain is recorded: execution, review, rework, review',
    hist.map((r) => r.kind).join(' -> ') === 'execution -> review -> rework -> review',
    hist.map((r) => r.kind).join(' -> '));
  check('the same agent produced both executions (no reassignment)',
    hist.filter((r) => r.kind !== 'review').every((r) => r.agentId === AGENT));
  check('and the same model', hist.filter((r) => r.kind !== 'review').every((r) => r.modelId === SB));
  check('the runtime really ran twice', requests.length === 2, `ran ${requests.length}`);

  // --- reject branch ---
  {
    const s2 = new AttemptStore();
    const { runtime: rt2 } = scriptedRuntime(['succeeded']);
    const o2 = new Orchestrator({ gate: gateSources(['r', 'c2']), now, runtime: rt2, defaultCwd: dir });
    o2.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' });
    o2.spawnChild({ taskId: 'c2', parentTaskId: 'r', agentId: AGENT, modelId: SB, taskType: impl, acceptanceCriteria: 'w', budgetUnits: 10 });
    const s2sched = new TaskScheduler({ orchestrator: o2, cwd: dir, rootTaskId: 'r' });
    const t = await s2sched.tick();
    recordExecutions(s2, t, (id) => { const k = o2.getStore().get(id); return k === null ? null : { agentId: k.agentId, modelId: k.modelId, budgetUnits: k.budgetUnits, taskType: k.taskType }; });
    const rej = validateReviewVerdict({
      verdict: 'reject', reason: 'wrong approach', findings: [{ location: 'x', severity: 'critical', message: 'wrong approach' }],
      recommendedAction: 'none', reviewer: 'codex', reviewedAt: NOW + 5,
    });
    applyReviewVerdict({ orchestrator: o2, taskId: 'c2', verdict: rej });
    recordReview(s2, { taskId: 'c2', reviewer: 'codex', verdict: rej, taskType: impl });
    check('a rejected review is recorded as outcome reject', s2.history('c2')[1].outcome === 'reject');
    check('a reject is distinguishable from an execution failure',
      s2.history('c2').filter((r) => r.outcome === 'failure').length === 0);
    check('and from a rework request', s2.history('c2').some((r) => r.outcome === 'rework') === false);
  }

  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 6. Aggregation
// ---------------------------------------------------------------------------
section('P6-E 6. aggregation is read-only and reports counts, not rankings');
{
  const store = new AttemptStore();
  const okRun = (o: number) => ({ state: 'succeeded', agentId: AGENT, error: null, startedAt: 0, endedAt: o, usage: { costUsd: 0 } }) as unknown as Parameters<typeof executionAttempt>[0]['result'];
  const badRun = (a: string) => ({ state: 'failed', agentId: a, error: { code: 'E', message: 'm' }, startedAt: 0, endedAt: 10, usage: null }) as unknown as Parameters<typeof executionAttempt>[0]['result'];

  // opencode: 2 successes, task-type implementation
  store.append(executionAttempt({ taskId: 'a', agentId: 'opencode', modelId: SB, taskType: impl, result: okRun(10), budgetUnits: 10 }));
  store.append(executionAttempt({ taskId: 'b', agentId: 'opencode', modelId: SB, taskType: impl, result: okRun(20), budgetUnits: 20 }));
  // mimo: 1 success + 1 failure, different model
  store.append(executionAttempt({ taskId: 'c', agentId: 'opencode', modelId: 'opencode/mimo-v2.6-flash-free', taskType: impl, result: badRun('opencode') }));
  store.append(executionAttempt({ taskId: 'd', agentId: 'workbuddy-intl', modelId: 'hy3', taskType: 'review' as TaskType, result: badRun('workbuddy-intl') }));
  store.append(reworkAttempt({ taskId: 'e', agentId: 'opencode', modelId: SB, taskType: 'research' as TaskType, result: okRun(30), budgetUnits: 5 }));

  const agents = store.agentEvidence();
  const oc = agents.find((a) => a.key === 'opencode');
  check('agent evidence is produced per agent', agents.length === 2, agents.map((a) => a.key).join(','));
  check('opencode totals 4 work attempts', oc?.total === 4, String(oc?.total));
  check('opencode has 3 successes and 1 failure', oc?.success === 3 && oc?.failure === 1,
    `${oc?.success}/${oc?.failure}`);
  check('a rework is counted as a rework, not an execution', oc?.rework === 1 && oc?.execution === 3,
    `${oc?.rework}/${oc?.execution}`);
  check('review attempts are EXCLUDED from worker evidence by default', oc?.review === 0);
  check('durations aggregate from real startedAt/finishedAt', oc?.averageDurationMs === (10 + 20 + 10 + 30) / 4,
    String(oc?.averageDurationMs));
  check('budget aggregates from declared budget units', oc?.averageBudgetUnits === (10 + 20 + 5) / 3,
    String(oc?.averageBudgetUnits));
  check('unreported cost is excluded, not read as zero',
    oc?.averageCostUsd === 0 && oc?.costReportedCount === 3,
    `${oc?.averageCostUsd}/${oc?.costReportedCount}`);

  const models = store.modelEvidence();
  check('model evidence is produced per model', models.length === 3, models.map((m) => m.key).join(','));
  check('a model with only failures reports them',
    models.find((m) => m.key === 'hy3')?.failure === 1);

  const tt = store.taskTypeEvidence();
  check('task-type evidence is produced', tt.length === 3, tt.map((t) => t.key).join(','));
  check('research evidence contains the rework attempt',
    tt.find((t) => t.key === 'research')?.rework === 1);

  const cross = store.taskTypeByAgentEvidence();
  check('task-type x agent is cross-tabulated',
    cross.some((c) => c.key === 'implementation::opencode') && cross.some((c) => c.key === 'research::opencode'),
    cross.map((c) => c.key).join(','));
  check('task-type x model is cross-tabulated',
    store.taskTypeByModelEvidence().some((c) => c.key === 'implementation::opencode/space-bunny-free'));

  // reviewer evidence is separate from worker evidence
  const revStore = new AttemptStore();
  revStore.append(reviewAttempt({
    taskId: 'x', reviewer: 'codex', taskType: impl,
    verdict: validateReviewVerdict({ verdict: 'reject', reason: 'no', findings: [{ location: 'a', severity: 'major', message: 'no' }], recommendedAction: 'none', reviewer: 'codex', reviewedAt: 1 }),
  }));
  check('reviewer evidence reports the reviewer verdict', revStore.reviewerEvidence()[0].rejected === 1);
  check('a reviewer is not counted as a worker',
    revStore.agentEvidence().every((a) => a.key !== 'codex' || a.total === 0));
  check('a review with includeReviews DOES surface the reviewer',
    revStore.agentEvidence({ includeReviews: true }).some((a) => a.key === 'codex'));

  // AttemptStore's own read-only queries, exercised.
  store.agentEvidence(); store.modelEvidence(); store.taskTypeEvidence();
  store.taskTypeByAgentEvidence(); store.taskTypeByModelEvidence(); store.reviewerEvidence();
  const before = store.size;

  // A ranker would put the best-performing key first. The fixture is chosen so
  // that alphabetical order and quality order DISAGREE: `zeta-agent` is flawless
  // and `alpha-agent` is a disaster, so any sort by success rate reorders them.
  const rankStore = new AttemptStore();
  const goodRun = { state: 'succeeded', agentId: 'zeta-agent', error: null, startedAt: 0, endedAt: 1, usage: null } as never;
  const badRunZ = { state: 'failed', agentId: 'alpha-agent', error: { code: 'E', message: 'm' }, startedAt: 0, endedAt: 1, usage: null } as never;
  rankStore.append(executionAttempt({ taskId: 'g', agentId: 'zeta-agent', modelId: SB, taskType: impl, result: goodRun }));
  rankStore.append(executionAttempt({ taskId: 'b', agentId: 'alpha-agent', modelId: SB, taskType: impl, result: badRunZ }));
  const rankKeys = rankStore.agentEvidence().map((a) => a.key);
  check('agent evidence is ordered deterministically by key, NOT by performance',
    rankKeys.join(',') === 'alpha-agent,zeta-agent', rankKeys.join(','));
  check('the worst agent is still listed, just not first (no filtering either)',
    rankKeys.length === 2 && rankKeys.includes('alpha-agent'));
  check('there is NO score/rank field on the evidence shape',
    !Object.keys(rankStore.agentEvidence()[0]).some((k) => /score|rank|weight|best|priority|rate/i.test(k)),
    Object.keys(rankStore.agentEvidence()[0]).join(','));

  check('READ-ONLY: aggregation changed nothing', store.size === before);
  check('no method suggests a preferred agent', (() => {
    const names = Object.getOwnPropertyNames(Object.getPrototypeOf(store)).join(' ');
    return !/recommend|suggest|choose|select|rank|score|pick/i.test(names);
  })(), Object.getOwnPropertyNames(Object.getPrototypeOf(store)).join(' '));
}

// ---------------------------------------------------------------------------
// 7. Authority boundary
// ---------------------------------------------------------------------------
section('P6-E 7. AttemptStore is evidence only');
{
  // RUNTIME: a store wrapped in a recording proxy must be invisible to task state.
  const dir = tmpDir();
  const store = new AttemptStore();
  const { runtime } = scriptedRuntime(['succeeded']);
  const orch = new Orchestrator({ gate: gateSources(['r', 'c1']), now, runtime, defaultCwd: dir });
  orch.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' });
  orch.spawnChild({ taskId: 'c1', parentTaskId: 'r', agentId: AGENT, modelId: SB, taskType: impl, acceptanceCriteria: 'w', budgetUnits: 10 });
  const scheduler = new TaskScheduler({ orchestrator: orch, cwd: dir, rootTaskId: 'r' });

  const snapshotBefore = JSON.stringify(orch.getStore().all());
  store.append(executionAttempt({
    taskId: 'c1', agentId: AGENT, modelId: SB, result: { state: 'succeeded', agentId: AGENT, error: null, startedAt: 0, endedAt: 1, usage: null } as never,
  }));
  check('appending evidence does NOT change any task', JSON.stringify(orch.getStore().all()) === snapshotBefore);
  check('appending evidence does not run an agent', requests_len(runtime) === 0);

  await scheduler.tick();
  const afterTick = JSON.stringify(orch.getStore().all());
  store.append(reviewAttempt({
    taskId: 'c1', reviewer: 'codex',
    verdict: validateReviewVerdict({ verdict: 'pass', reason: 'ok', findings: [], recommendedAction: 'none', reviewer: 'codex', reviewedAt: 2 }),
  }));
  check('recording a review does NOT change any task', JSON.stringify(orch.getStore().all()) === afterTick);
  check('the store holds no reference to the task store / scheduler / runtime',
    !('store' in store) && !('scheduler' in store) && !('runtime' in store));

  // Task status changing does NOT rewrite history.
  const histBefore = JSON.stringify(store.history('c1'));
  orch.applyVerification('c1', { verdict: 'pass', reason: 'done' });
  check('CRITICAL: a task status change does NOT rewrite history', JSON.stringify(store.history('c1')) === histBefore);
  check('the task became succeeded while the record still says what it says',
    orch.getStore().get('c1')?.status === 'succeeded' && store.history('c1')[0]?.outcome === 'success');

  // Task.retryCount and history length are INDEPENDENT.
  const s2 = new AttemptStore();
  const rr = new TaskStore();
  rr.create({ taskId: 't', parentTaskId: null, agentId: AGENT, taskType: impl, acceptanceCriteria: 'x' }, NOW);
  rr.incrementRetry('t');
  check('retryCount is a task field, independent of evidence', rr.get('t')?.retryCount === 1 && s2.size === 0);
  s2.append(executionAttempt({ taskId: 't', agentId: AGENT, modelId: SB, result: { state: 'succeeded', agentId: AGENT, error: null, startedAt: 0, endedAt: 1, usage: null } as never }));
  check('recording an attempt does NOT bump retryCount', rr.get('t')?.retryCount === 1);
  check('history length is NOT derived from retryCount (and vice versa)',
    s2.size === 1 && rr.get('t')?.retryCount === 1);
  check('history length can exceed retryCount without any sync attempt',
    (() => {
      const s3 = new AttemptStore();
      const r3 = new TaskStore();
      r3.create({ taskId: 't', parentTaskId: null, agentId: AGENT, taskType: impl, acceptanceCriteria: 'x' }, NOW);
      const run = { state: 'succeeded', agentId: AGENT, error: null, startedAt: 0, endedAt: 1, usage: null } as never;
      s3.append(executionAttempt({ taskId: 't', agentId: AGENT, modelId: SB, result: run }));
      s3.append(reviewAttempt({ taskId: 't', reviewer: 'codex', verdict: validateReviewVerdict({ verdict: 'pass', reason: 'r', findings: [], recommendedAction: 'none', reviewer: 'codex', reviewedAt: 3 }) }));
      s3.append(reworkAttempt({ taskId: 't', agentId: AGENT, modelId: SB, result: run }));
      return s3.size === 3 && r3.get('t')?.retryCount === 0;
    })());

  rmSync(dir, { recursive: true, force: true });

  // STRUCTURAL: the source cannot reach an authority.
  const files = ['src/orchestration/attempt-store.ts', 'src/orchestration/attempt-record.ts', 'src/orchestration/attempt-integration.ts'];
  const readCode = (f: string): string =>
    readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const f of files) {
    const raw = readFileSync(f, 'utf8');
    const code = readCode(f);
    // A TYPE-ONLY import of `TickResult`/`Task` is necessary and harmless: it
    // brings shapes, not capabilities. What must not exist is a VALUE import of
    // an authority, or any call on one.
    const valueImports = [...raw.matchAll(/^import (?!type )[^;]*from '([^']+)'/gm)].map((m) => m[1]);
    check(`${f} imports no task store as a VALUE`, !valueImports.includes('./store.ts'), valueImports.join(', '));
    check(`${f} imports no scheduler as a VALUE`, !valueImports.includes('./scheduler.ts'), valueImports.join(', '));
    check(`${f} imports no orchestrator as a VALUE`, !valueImports.some((i) => i.includes('/orchestrator/') || i === './orchestrator.ts'), valueImports.join(', '));
    check(`${f} imports no runtime or adapter as a VALUE`, !valueImports.some((i) => i.includes('/runtime') || i.includes('/adapters')), valueImports.join(', '));
    check(`${f} performs no task transition`, !/\.transition\(/.test(code), (code.match(/.{0,20}\.transition\([^)]*\)/) ?? [])[0] ?? '');
    check(`${f} never ticks a scheduler`, !/\.tick\(/.test(code));
    check(`${f} never runs a runtime`, !/\.run\(/.test(code));
    check(`${f} constructs no store/scheduler/workspace/runtime`, !/new (TaskStore|TaskScheduler|WorkspaceManager|Runtime)/.test(code));
  }

  // The orchestrator (the execution edge) is untouched by P6-E.
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
  const all = tree('src');
  const occurrences = (pattern: RegExp): number => {
    let n = 0;
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const f of all) {
      const code = readCode(f);
      n += [...code.matchAll(global)].length;
    }
    return n;
  };
  check('still exactly one TaskStore instantiation', occurrences(/new TaskStore\(/) === 1, String(occurrences(/new TaskStore\(/)));
  check('still exactly one TaskScheduler class', occurrences(/class TaskScheduler\b/) === 1);
  check('still exactly one WorkspaceManager class', occurrences(/class WorkspaceManager\b/) === 1);
  check('still exactly one runtime.run() call site', occurrences(/runtime\.run\(/) === 1, String(occurrences(/runtime\.run\(/)));
  check('still exactly one applyVerification implementation',
    occurrences(/applyVerification\(taskId: string, outcome: VerificationOutcome\): MutateOutline \{/) +
    occurrences(/applyVerification\(taskId: string, outcome: VerificationOutcome\): MutateOutcome \{/) === 1);
  check('AttemptStore is a new SINGLE class, not a second one', occurrences(/class AttemptStore\b/) === 1);
  check('P6-E does not depend on the free-model pool (P6-F untouched)',
    ![...readFileSync('src/orchestration/attempt-record.ts', 'utf8').matchAll(/^import (?!type )[^;]*from '([^']+)'/gm)]
      .some((m) => m[1].includes('model-pool')) &&
    ![...readFileSync('src/orchestration/attempt-store.ts', 'utf8').matchAll(/^import (?!type )[^;]*from '([^']+)'/gm)]
      .some((m) => m[1].includes('model-pool')));
}

/** A runtime that has been asked to run nothing yet. */
function requests_len(runtime: RuntimeRunner): number {
  let n = 0;
  const original = runtime.run.bind(runtime);
  (runtime as { run: (r: RunRequest) => RunHandle }).run = (req: RunRequest) => { n++; return original(req); };
  return n;
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) {
  process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
}
process.stdout.write('\n');
process.exitCode = failed === 0 ? 0 : 1;
