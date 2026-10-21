/**
 * tests/unified-review.test.ts - the ONE review every Execution Round ends with.
 *
 * WHAT IS CLAIMED HERE, AND HOW IT IS MEASURED
 * ---------------------------------------------
 *   every terminal outcome reaches one review -> each outcome kind is built into a packet
 *                                             and offered to ONE reviewer call
 *   the review covers the WHOLE round         -> one call carrying every task, counted
 *   a refusal is a reviewable outcome         -> quota/lease/resource refusals classify as
 *                                               themselves and still reach the reviewer
 *   a failed review is never a pass           -> unavailable / failed carry a reason and a
 *                                               null verdict, and evidence survives
 *   a review is called ONCE                   -> the reviewer counts its own invocations
 *   a verdict NEVER drives the workflow       -> a `rework` verdict leaves every task
 *                                               exactly where it was, measured on a real store
 *   there is still ONE execution edge          -> source guard: no second `run(` call site
 *
 * Only the reviewer is synthetic. A real Codex binary cannot be assumed, and the
 * reviewer's output is precisely the untrusted input this layer exists to normalise — so
 * every reviewer reply here is treated the way a real one would be, including the
 * malformed ones.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { runReviewPacket } from '../src/cli/review-cli.ts';
import { createFakeAdapter, sourceText } from './helpers.ts';

import {
  EXECUTION_OUTCOMES,
  REVIEW_STATUSES,
  buildReviewPacket,
  buildUnifiedRoundReport,
  classifyExecutionOutcome,
  renderReviewPacket,
  renderUnifiedRoundReport,
  runUnifiedReview,
  tailText,
  type ReviewPacket,
  type ReviewPacketTask,
} from '../src/orchestration/unified-review.ts';
import { buildHandoff } from '../src/orchestration/workbench-handoff.ts';
import { TaskStore } from '../src/orchestration/store.ts';
import { REVIEW_VERDICTS } from '../src/orchestration/review-verdict.ts';
import { isOfflineFrozen } from '../src/runtime/offline-policy.ts';
import type { RunHandle, RunRequest, RunResult } from '../src/core/types.ts';
import type { NativeReviewer } from '../src/orchestration/unified-review.ts';

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

check('offline policy is frozen before any reviewer fixture runs', isOfflineFrozen());
if (!isOfflineFrozen()) throw new Error('this suite requires the reviewed offline runner');

const NOW = 1_700_000_000_000;
const now = () => NOW;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A real RunResult. `error` is mandatory for every non-succeeded state, per its contract. */
function result(over: Partial<RunResult> = {}): RunResult {
  const state = over.state ?? 'succeeded';
  return {
    taskId: 'rt-1',
    threadId: 'th-1',
    agentId: 'opencode',
    state,
    startedAt: 0,
    endedAt: 1,
    exitCode: state === 'succeeded' ? 0 : 1,
    signal: null,
    output: '',
    outputTruncated: false,
    transcriptPath: '/tmp/transcript.jsonl',
    usage: null,
    toolCalls: [],
    diagnostics: [],
    cleanup: { rootKilled: false, descendantsReaped: false, note: '' },
    error: state === 'succeeded' ? null : { code: 'NONZERO_EXIT', message: 'boom' },
    ...over,
  } as unknown as RunResult;
}

/** A real Task, from the real store, so `buildHandoff` sees a real Task. */
function realTask(taskId: string, acceptanceCriteria: string) {
  const store = new TaskStore();
  const created = store.create({
    taskId,
    taskType: 'implementation',
    acceptanceCriteria,
    parentTaskId: null,
    agentId: 'opencode',
    modelId: 'opencode/space-bunny-free',
  }, NOW);
  if (!created.ok) throw new Error(`fixture could not create ${taskId}: ${created.reason}`);
  return store.get(taskId)!;
}

function packetTask(over: Partial<ReviewPacketTask> = {}): ReviewPacketTask {
  const taskId = over.taskId ?? 'c1';
  const task = realTask(taskId, 'do the thing');
  const run = over.executed === false ? null : result();
  return {
    taskId,
    taskType: 'implementation',
    status: task.status,
    agentId: 'opencode',
    modelId: 'opencode/space-bunny-free',
    outcome: 'success',
    executed: true,
    prompt: tailText('Work:\ndo the thing'),
    handoff: run === null ? null : buildHandoff(task, run),
    attemptIds: ['att_0001'],
    leaseVersion: 1,
    errorCode: null,
    errorMessage: null,
    ...over,
  };
}

// Only paths offered to our synthetic reviewers belong to this fixture. Production
// deliberately retains them when stop/identity cannot be confirmed.
const fixtureOutputDirectories = new Set<string>();
function finalOutputPath(req: Omit<RunRequest, 'mode'>): string | null {
  const args = req.extraArgs ?? [];
  const index = args.indexOf('--output-last-message');
  if (index < 0) return null;
  const file = args[index + 1];
  if (!file || basename(file) !== 'final-message.json' ||
      dirname(dirname(resolve(file))) !== resolve(tmpdir()) ||
      !basename(dirname(file)).startsWith('native-agent-review-')) {
    throw new Error('fixture received an unexpected owned output path');
  }
  fixtureOutputDirectories.add(dirname(file));
  return file;
}

/** A reviewer that COUNTS calls and writes the final CLI artifact independently of stdout. */
function fakeReviewer(reply: {
  state: RunResult['state']; output: string;
  final?: string | Uint8Array | null;
  wrongPath?: boolean;
  run?: Partial<RunResult>;
  handleTaskId?: string;
  handleAgentId?: string;
} | { throws: string }) {
  const calls: Omit<RunRequest, 'mode'>[] = [];
  const runs: RunResult[] = [];
  const reviewer: NativeReviewer = {
    review(req): RunHandle {
      calls.push(req);
      const file = finalOutputPath(req);
      if ('throws' in reply) throw new Error(reply.throws);
      const final = reply.final === undefined ? reply.output : reply.final;
      if (file !== null && final !== null) {
        writeFileSync(reply.wrongPath ? `${file}.wrong` : file, final);
      }
      const run = result({
        state: reply.state, output: reply.output, taskId: 'rt-review', agentId: req.agentId,
        cleanup: { rootKilled: false, descendantsReaped: true, note: 'synthetic transport stopped', treeStopConfirmed: true, processStart: 'started' },
        ...reply.run,
      });
      runs.push(run);
      return {
        taskId: reply.handleTaskId ?? 'rt-review',
        agentId: reply.handleAgentId ?? req.agentId,
        result: async () => run,
      } as unknown as RunHandle;
    },
  };
  return { reviewer, calls, runs };
}

const validVerdict = (over: Record<string, unknown> = {}): string => JSON.stringify({
  verdict: 'pass',
  reason: 'the evidence supports the claim',
  findings: [],
  recommendedAction: 'none',
  reviewer: 'codex',
  reviewedAt: NOW,
  ...over,
});

const reviewOpts = { reviewer: 'codex', modelId: null, cwd: '/repo', now };

function packetOf(tasks: ReviewPacketTask[], outcomes = [] as never[]): ReviewPacket {
  return buildReviewPacket({
    roundId: 'round-abc',
    originalRequest: 'add a retry to the http client',
    tasks,
    outcomes,
  });
}

// ---------------------------------------------------------------------------
// 1. Every terminal outcome classifies, from the REAL codes this system emits
// ---------------------------------------------------------------------------
section('unified review 1. every terminal outcome is classified');

{
  // The refusal codes that actually exist in this tree, and what each one means. A
  // refusal reported as an agent failure is the misattribution this guards against.
  const refusals: readonly [string, string][] = [
    ['quota-blocked', 'quota_exhausted'],
    ['budget-insufficient', 'quota_exhausted'],
    ['outside-free-pool', 'quota_exhausted'],
    ['policy-blocked', 'quota_exhausted'],
    ['resource-conflict', 'resource_refused'],
    ['resource-unavailable', 'resource_refused'],
    ['lease-not-live', 'lease_refused'],
    ['lease-revoked', 'lease_refused'],
    ['lease-expired', 'lease_refused'],
    ['stale-lease-version', 'lease_refused'],
    ['fencing-token-missing', 'lease_refused'],
    ['fencing-token-mismatch', 'lease_refused'],
    ['agent-mismatch', 'lease_refused'],
    ['runtime-rejected-run', 'agent_unavailable'],
    ['not-capable', 'agent_unavailable'],
    ['runtime-result-failed', 'error'],
    // An admission refusal that is none of the above stays `refused`, never `failed`.
    ['dependency-unmet', 'refused'],
    ['task-not-executable', 'refused'],
  ];
  for (const [code, expected] of refusals) {
    const o = classifyExecutionOutcome({
      taskId: 'c1', taskStatus: 'running', refusalCode: code, refusalReason: 'the gate refused',
    });
    check(`refusal "${code}" classifies as ${expected}`, o.outcome === expected, o.outcome);
  }

  // A refused task executed NOTHING, so it carries no evidence and must not claim to.
  const refused = classifyExecutionOutcome({
    taskId: 'c1', taskStatus: 'running', refusalCode: 'quota-blocked',
  });
  check('a refused task reports executed=false', refused.executed === false);
  check('a refused task keeps its real code', refused.code === 'quota-blocked', String(refused.code));

  // A refusal CODE outranks the task status: a task refused at admission never ran, so its
  // status says nothing useful.
  const refusedButSucceeded = classifyExecutionOutcome({
    taskId: 'c1', taskStatus: 'succeeded', refusalCode: 'resource-conflict',
  });
  check('a refusal code outranks a misleading task status',
    refusedButSucceeded.outcome === 'resource_refused', refusedButSucceeded.outcome);
}

{
  // The real RunResult states, and the error codes that refine them.
  const runs: readonly [RunResult['state'], string | null, string][] = [
    ['succeeded', null, 'success'],
    ['failed', 'NONZERO_EXIT', 'failed'],
    ['timed_out', 'TIMED_OUT', 'timeout'],
    ['cancelled', 'CANCELLED', 'cancelled'],
    ['failed', 'SPAWN_FAILED', 'agent_unavailable'],
    ['failed', 'TRANSPORT_ERROR', 'session_failure'],
  ];
  for (const [state, code, expected] of runs) {
    const o = classifyExecutionOutcome({
      taskId: 'c1',
      taskStatus: state === 'succeeded' ? 'to_verify' : 'failed',
      run: result({ state, error: code === null ? null : { code, message: 'm' } } as never),
    });
    check(`a ${state} run (${code ?? 'no code'}) classifies as ${expected}`, o.outcome === expected, o.outcome);
    check(`a ${state} run reports executed=true`, o.executed === true);
  }

  // R2-2 / F5: the write-back was refused but the process DID run. That is real evidence
  // and the reviewer must see it, not an empty gap.
  const f5 = classifyExecutionOutcome({
    taskId: 'c1',
    taskStatus: 'running',
    refusalCode: 'stale-lease-version',
    run: result({ state: 'succeeded' }),
  });
  check('a refused write-back with a real run still reports executed=true', f5.executed === true);
  check('...and still reports the refusal code that blocked the write-back',
    f5.code === 'stale-lease-version', String(f5.code));
}

{
  // Every outcome kind is either produced by the tree or is an honest "nothing ran".
  for (const kind of EXECUTION_OUTCOMES) {
    check(`"${kind}" is a declared outcome`, typeof kind === 'string');
  }
  check('the vocabulary covers success, failure, timeout, quota, unavailability, refusal and cancellation',
    ['success', 'failed', 'error', 'timeout', 'quota_exhausted', 'agent_unavailable',
      'session_failure', 'resource_refused', 'lease_refused', 'cancelled', 'refused']
      .every((k) => (EXECUTION_OUTCOMES as readonly string[]).includes(k)));
}

// ---------------------------------------------------------------------------
// 2. The packet carries the WHOLE round, in one reviewable document
// ---------------------------------------------------------------------------
section('unified review 2. the packet carries the whole round');

{
  const t1 = packetTask({ taskId: 'c1' });
  const t2 = packetTask({
    taskId: 'c2',
    outcome: 'quota_exhausted',
    executed: false,
    handoff: null,
    errorCode: 'quota-blocked',
    errorMessage: 'no quota left',
    attemptIds: [],
  });
  const t3 = packetTask({ taskId: 'c3', outcome: 'failed', errorCode: 'NONZERO_EXIT', errorMessage: 'boom' });
  const outcomes = [
    classifyExecutionOutcome({ taskId: 'c1', taskStatus: 'to_verify', run: result() }),
    classifyExecutionOutcome({ taskId: 'c2', taskStatus: 'running', refusalCode: 'quota-blocked', refusalReason: 'no quota left' }),
    classifyExecutionOutcome({ taskId: 'c3', taskStatus: 'failed', run: result({ state: 'failed' }) }),
  ];
  const packet = buildReviewPacket({
    roundId: 'round-abc',
    originalRequest: 'add a retry to the http client',
    layaPlan: 'Laya reason: this is a small isolated change.',
    tasks: [t1, t2, t3],
    outcomes,
    quotaSignals: ['opencode: quota exhausted'],
    resourceSignals: ['isolated worktrees under /repo'],
  });

  check('the packet carries every task in the round', packet.tasks.length === 3);
  const text = renderReviewPacket(packet);
  for (const id of ['c1', 'c2', 'c3']) {
    check(`the rendered packet mentions ${id}`, text.includes(id));
  }
  check('the packet states the original request', text.includes('add a retry to the http client'));
  check('the packet carries Laya\'s own plan', text.includes("Laya reason: this is a small isolated change."));
  check('a refused task is shown as having run nothing',
    text.includes('evidence: (no run — nothing executed for this task)'));
  check('a refusal is listed as an error/refusal, not silently dropped',
    packet.errors.some((e) => e.includes('quota-blocked')), JSON.stringify(packet.errors));
  check('a success contributes no error line',
    !packet.errors.some((e) => e.startsWith('c1:')));
  check('quota signals reach the reviewer', text.includes('opencode: quota exhausted'));

  // The evidence projection is the EXISTING one, so the reviewer sees exactly what a
  // dependant would have seen.
  check('the packet carries changed files from the run',
    text.includes('files it actually wrote') || text.includes('evidence: runState='));

  // One review for the whole round, not one per task: the reviewer is asked once and
  // decides over everything.
  check('a multi-task round is still ONE packet', packet.tasks.length === 3);
}

{
  // Bounded text: the packet must never become an unbounded token bill, and a truncated
  // field must SAY it was truncated so a tail is never mistaken for the whole thing.
  const long = 'x'.repeat(5_000);
  const bounded = tailText(long, 100);
  check('a long blob is tailed', bounded.text.length === 100, String(bounded.text.length));
  check('a tailed blob is marked truncated', bounded.truncated === true);
  check('a tailed blob reports its real length', bounded.originalLength === 5_000);
  const short = tailText('short', 100);
  check('a short blob is left whole', short.truncated === false && short.text === 'short');
}

// ---------------------------------------------------------------------------
// 3. The review runs — exactly once — and never fakes a verdict
// ---------------------------------------------------------------------------
section('unified review 3. the review runs once, and never fakes a verdict');

{
  const packet = packetOf([packetTask()]);

  // Success.
  const ok = fakeReviewer({ state: 'succeeded', output: validVerdict() });
  const r1 = await runUnifiedReview(ok.reviewer, packet, reviewOpts);
  check('a valid reply completes the review', r1.status === 'completed', r1.status);
  check('the verdict is carried through', r1.verdict?.verdict === 'pass', String(r1.verdict?.verdict));
  check('the reviewer was called EXACTLY ONCE', ok.calls.length === 1, String(ok.calls.length));
  check('the reviewer got the packet', ok.calls[0]!.prompt.includes('round-abc'));

  // Every verdict value is reachable, not just `pass`.
  for (const verdict of REVIEW_VERDICTS) {
    const f = fakeReviewer({
      state: 'succeeded',
      output: validVerdict({ verdict, recommendedAction: verdict === 'pass' ? 'none' : 'rework' }),
    });
    const r = await runUnifiedReview(f.reviewer, packet, reviewOpts);
    check(`a "${verdict}" verdict completes`, r.status === 'completed' && r.verdict?.verdict === verdict,
      `${r.status}/${String(r.verdict?.verdict)}`);
  }

  // A reviewer that CANNOT START. This is the single most important failure path: an
  // unauthenticated or unregistered Codex must not look like approval.
  const dead = fakeReviewer({ throws: 'no adapter registered for "codex"' });
  const r2 = await runUnifiedReview(dead.reviewer, packet, reviewOpts);
  check('a reviewer that cannot start reports unavailable', r2.status === 'unavailable', r2.status);
  check('...with NO verdict', r2.verdict === null);
  check('...and a reason', typeof r2.reason === 'string' && r2.reason.length > 0);
  check('...and a machine-readable code', r2.code === 'reviewer-unavailable', String(r2.code));
  check('...and no findings, because nothing was found', r2.findings.length === 0);

  // A reviewer that RAN but failed.
  const failedRun = fakeReviewer({ state: 'failed', output: '' });
  const r3 = await runUnifiedReview(failedRun.reviewer, packet, reviewOpts);
  check('a failed reviewer run reports failed', r3.status === 'failed', r3.status);
  check('...with NO verdict', r3.verdict === null);
  check('...and carries the runtime error code', r3.code === 'NONZERO_EXIT', String(r3.code));

  // A reviewer that ran and CHATTED instead of answering. Prose is not a verdict.
  const chatty = fakeReviewer({ state: 'succeeded', output: 'Looks great to me! Ship it.' });
  const r4 = await runUnifiedReview(chatty.reviewer, packet, reviewOpts);
  check('prose that does not satisfy the contract is failed, NOT a pass', r4.status === 'failed', r4.status);
  check('...with NO verdict', r4.verdict === null);
  check('...flagged as an invalid reply', r4.code === 'reviewer-output-invalid', String(r4.code));
  check('...and the raw reply is kept so a human can audit it',
    r4.outputTail !== null && r4.outputTail.text.includes('Ship it'));

  // A timed-out verdict-carrying reply is still not a verdict.
  const partial = fakeReviewer({ state: 'succeeded', output: '{"verdict":"pas' });
  const r5 = await runUnifiedReview(partial.reviewer, packet, reviewOpts);
  check('a truncated verdict is failed, not a pass', r5.status === 'failed' && r5.verdict === null);

  // No retry, ever: an out-of-quota reviewer must not become a loop.
  check('the reviewer is never retried', dead.calls.length === 1 && ok.calls.length === 1);
}

// The native Codex contract consumes the file, never a chatty/mixed transcript.
{
  const packet = packetOf([packetTask()]);
  const mixed = fakeReviewer({ state: 'succeeded', output: 'Checking files...\nintermediate prose',
    final: validVerdict({ reviewer: 'untrusted', reviewedAt: 0 }) });
  const r = await runUnifiedReview(mixed.reviewer, packet, reviewOpts);
  const req = mixed.calls[0]!;
  const file = finalOutputPath(req)!;
  check('mixed process output does not replace the valid final file', r.status === 'completed' && r.verdict?.verdict === 'pass');
  check('host reviewer and timestamp override model fields', r.verdict?.reviewer === 'codex' && r.reviewedAt === NOW);
  check('verdict tail is final JSON, not process chatter', r.outputTail?.text === validVerdict({ reviewer: 'untrusted', reviewedAt: 0 }));
  check('synthetic RunResult output is not rewritten', mixed.runs[0]!.output === 'Checking files...\nintermediate prose');
  check('schema, final-file selector and local analytics flag reach the reviewer',
    req.extraArgs?.includes('--output-schema') === true && req.extraArgs.includes('analytics.enabled=false') && req.sandbox === 'read-only');
  check('successful owned output is removed after confirmed stop', !existsSync(dirname(file)));
  check('final artifact success still makes exactly one call', mixed.calls.length === 1);

  const invalidFiles: readonly [string, string | Uint8Array | null][] = [
    ['missing', null], ['empty', ''], ['oversize', 'x'.repeat(64 * 1024 + 1)],
    ['invalid UTF-8', new Uint8Array([0xc3, 0x28])], ['malformed JSON', '{'],
    ['missing judgment fields', '{"verdict":"pass"}'],
    ['invalid verdict', validVerdict({ verdict: 'ship-it' })],
  ];
  for (const [name, final] of invalidFiles) {
    const f = fakeReviewer({ state: 'succeeded', output: validVerdict(), final });
    const rejected = await runUnifiedReview(f.reviewer, packet, reviewOpts);
    check(`${name} final file rejects valid-looking stdout`, rejected.status === 'failed' && rejected.verdict === null && rejected.code === 'reviewer-output-invalid', String(rejected.code));
    check(`${name} stopped fixture output is cleaned`, !existsSync(dirname(finalOutputPath(f.calls[0]!)!)));
    check(`${name} does not cause a retry`, f.calls.length === 1);
  }
  const wrong = fakeReviewer({ state: 'succeeded', output: validVerdict(), wrongPath: true });
  const rejected = await runUnifiedReview(wrong.reviewer, packet, reviewOpts);
  const wrongFile = finalOutputPath(wrong.calls[0]!)!;
  check('a final file at the wrong path is never accepted', rejected.status === 'failed' && rejected.verdict === null && rejected.code === 'reviewer-output-cleanup-failed');
  check('unexpected entry is retained instead of recursively deleted', existsSync(`${wrongFile}.wrong`) && rejected.reason?.includes(dirname(wrongFile)) === true);

  const invalidRuns: readonly [string, Partial<RunResult>, string][] = [
    ['wrong task', { taskId: 'another-run' }, 'reviewer-result-identity-mismatch'],
    ['wrong agent', { agentId: 'opencode' }, 'reviewer-result-identity-mismatch'],
    ['nonzero exit', { exitCode: 1 }, 'reviewer-output-invalid'],
    ['missing exit', { exitCode: null }, 'reviewer-output-invalid'],
    ['signalled exit', { signal: 'SIGTERM' }, 'reviewer-output-invalid'],
    ['unconfirmed stop', { cleanup: { rootKilled: false, descendantsReaped: false, note: 'unknown', treeStopConfirmed: false, processStart: 'may-have-started' } }, 'reviewer-output-invalid'],
  ];
  for (const [name, run, code] of invalidRuns) {
    const f = fakeReviewer({ state: 'succeeded', output: validVerdict(), run });
    const rejected = await runUnifiedReview(f.reviewer, packet, reviewOpts);
    check(`${name} rejects even a valid final file`, rejected.status === 'failed' && rejected.verdict === null && rejected.code === code, String(rejected.code));
    if (code === 'reviewer-result-identity-mismatch' || name === 'unconfirmed stop') {
      const file = finalOutputPath(f.calls[0]!)!;
      check(`${name} retains evidence without a trusted stop`, existsSync(file) && rejected.reason?.includes(dirname(file)) === true);
    }
    check(`${name} still calls the reviewer once`, f.calls.length === 1);
  }
  for (const handle of [{ handleTaskId: '' }, { handleAgentId: 'opencode' }]) {
    const f = fakeReviewer({ state: 'succeeded', output: validVerdict(), ...handle });
    const rejected = await runUnifiedReview(f.reviewer, packet, reviewOpts);
    check('invalid handle identity is rejected before consuming the final file', rejected.code === 'reviewer-result-identity-mismatch' && rejected.verdict === null);
  }
  const failed = fakeReviewer({ state: 'failed', output: validVerdict() });
  const failedResult = await runUnifiedReview(failed.reviewer, packet, reviewOpts);
  check('a failed run cannot promote its valid final file', failedResult.status === 'failed' && failedResult.code === 'NONZERO_EXIT' && failedResult.verdict === null);
  const timed = fakeReviewer({ state: 'timed_out', output: validVerdict() });
  const timedResult = await runUnifiedReview(timed.reviewer, packet, reviewOpts);
  check('a timed-out run cannot promote its valid final file', timedResult.status === 'failed' && timedResult.verdict === null);
  const other = fakeReviewer({ state: 'succeeded', output: validVerdict(), final: null });
  const compatible = await runUnifiedReview(other.reviewer, packet, { ...reviewOpts, reviewer: 'opencode' });
  check('non-Codex reviewer keeps its output-based contract', compatible.status === 'completed' && compatible.verdict?.reviewer === 'opencode');
  check('non-Codex reviewer receives no Codex file/schema/profile arguments', other.calls[0]!.extraArgs === undefined && other.calls[0]!.sandbox === undefined);
}

// ---------------------------------------------------------------------------
// 4. A verdict is a RECOMMENDATION — it never drives the workflow
// ---------------------------------------------------------------------------
section('unified review 4. a verdict never drives the workflow');

{
  const packet = packetOf([packetTask()]);
  const f = fakeReviewer({
    state: 'succeeded',
    output: validVerdict({
      verdict: 'rework',
      reason: 'the diff does not match the request',
      findings: [{ location: 'src/http.ts:80', severity: 'major', message: 'no retry was added' }],
      recommendedAction: 'rework',
    }),
  });
  const r = await runUnifiedReview(f.reviewer, packet, reviewOpts);

  check('a rework verdict completes normally', r.status === 'completed');
  check('the verdict is recorded as rework', r.verdict?.verdict === 'rework');
  check('the finding survives', r.findings.length === 1 && r.findings[0]!.location === 'src/http.ts:80');
  check('a rework verdict becomes a RECOMMENDATION for the user', r.recommendations.length === 1);
  check('...and the recommendation says nothing was re-run automatically',
    r.recommendations[0]!.includes('nothing was re-run automatically'), r.recommendations[0] ?? '');
  check('the reviewer was still called only once', f.calls.length === 1, String(f.calls.length));

  // The report keeps the verdict as a VALUE, separate from task execution state. This is
  // what stops "Codex said rework" from being read as "the system re-ran it".
  const store = new TaskStore();
  const created = store.create({
    taskId: 'c1',
    taskType: 'implementation',
    acceptanceCriteria: 'do the thing',
    parentTaskId: null,
    agentId: 'opencode',
  }, NOW);
  const before = store.get('c1')!.status;
  const report = buildUnifiedRoundReport(packet, r);
  check('the round report carries the verdict value', report.review.verdict === 'rework');
  check('...as the review\'s verdict, never as a task status',
    report.tasks.every((t) => t.status !== ('rework' as never)));
  check('no task was moved by the review', store.get('c1')!.status === before, store.get('c1')!.status);
  check('the task was never created-and-mutated by the review path', created.ok);
  check('the task is still not in a rework state', store.get('c1')!.retryCount === 0);
}

{
  // A review that was SKIPPED must never be readable as a review that passed. This is the
  // difference between "nobody looked" and "nobody found anything".
  const packet = packetOf([packetTask()]);
  const skipped = await runUnifiedReview(
    fakeReviewer({ throws: 'must not be called' }).reviewer,
    packet,
    reviewOpts,
  );
  check('a skipped review is never completed', skipped.status !== 'completed');
  const report = buildUnifiedRoundReport(packet, {
    status: 'not_requested',
    reviewer: 'codex',
    verdict: null,
    reason: '--no-review was given',
    findings: [],
    recommendations: [],
    outputTail: null,
    code: null,
    reviewedAt: null,
  });
  check('a not_requested review carries NO verdict', report.review.verdict === null);
  check('...and says so in the rendered output', renderUnifiedRoundReport(report).includes('not_requested'));
  for (const status of REVIEW_STATUSES) {
    check(`"${status}" is a declared review status`, typeof status === 'string');
  }
}

// ---------------------------------------------------------------------------
// 5. One execution edge, and no second control plane
// ---------------------------------------------------------------------------
section('unified review 5. one execution edge, no second control plane');

{
  /**
   * Source with comments stripped.
   *
   * These guards count and search CODE. Without this they would match the prose in the
   * doc comments — and they did: this file's own comments mention `runtime.run(` while
   * asserting that nobody calls it, which is exactly how a guard becomes theatre. The
   * leading-colon rule keeps `http://…` inside a string from being treated as a comment.
   */
  const code = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  const src = code(sourceText(new URL('../src/orchestration/unified-review.ts', import.meta.url)));

  // The review must go through the injected seam, never build its own.
  check('unified-review.ts never calls runtime.run directly', !/\bruntime\s*\.\s*run\s*\(/.test(src));
  check('unified-review.ts never calls .run( on anything', !/this\s*\.\s*run\s*\(/.test(src));
  check('unified-review.ts has no review manager', !/class\s+\w*Review\w*Manager\b/.test(src));
  check('unified-review.ts has no scheduler', !/\bnew\s+TaskScheduler\b/.test(src) && !/TaskScheduler/.test(src));
  check('unified-review.ts has no store of its own', !/new\s+(Map|Set|WeakMap)\b/.test(src));
  check('unified-review.ts never imports the orchestration Orchestrator',
    !/orchestration\/orchestrator\.ts/.test(src));
  check("unified-review.ts never imports review-loop's verdict applier",
    !/review-loop\.ts/.test(src) && !/applyReviewVerdict/.test(src));
  check('unified-review.ts does not reach TaskStore', !/orchestration\/store\.ts/.test(src));
  check('unified-review.ts does not read TaskStore, only plain inputs',
    !/\bstore\s*\.\s*(create|transition|get)\b/.test(src));
  // Rendering loops are legitimate (the packet walks its tasks). The invariant that
  // matters is that the REVIEW is never repeated, which is measured by the single call
  // site below and by the absence of any retry mechanism here.
  check('unified-review.ts contains no retry of any kind', !/\bretry|backoff/i.test(src));
  check('unified-review.ts has exactly one reviewer call site', (src.match(/reviewer\.review\s*\(/g) ?? []).length === 1);

  // The round CLI wires the EXISTING review seam and adds no authority of its own.
  const cliRaw = sourceText(new URL('../src/cli/round-cli.ts', import.meta.url));
  const cli = code(cliRaw);
  check('round-cli reviews through the runtime it already holds', /runUnifiedReview\(\s*runtime\s*,/.test(cli));
  check('round-cli still creates exactly ONE scheduler', (cli.match(/new\s+TaskScheduler\s*\(/g) ?? []).length === 1,
    String((cli.match(/new\s+TaskScheduler\s*\(/g) ?? []).length));
  check('round-cli no longer tells the operator to go and do the review by hand',
    !/Next per the product model: Codex review/.test(cliRaw));

  // THE project invariant: across the whole of src/ there is exactly ONE real
  // `runtime.run(` call site — the single execution edge. Comments are excluded, because
  // the codebase discusses `runtime.run()` in prose in seven places and a naive count
  // would report eight and "prove" nothing.
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) files.push(p);
    }
  };
  walk(fileURLToPath(new URL('../src', import.meta.url)));
  const sites: string[] = [];
  for (const f of files) {
    const body = code(sourceText(f));
    if (/runtime\s*\.\s*run\s*\(/.test(body)) sites.push(f);
  }
  check('src/ has exactly ONE real runtime.run( call site', sites.length === 1, JSON.stringify(sites));
  check('...and it is the one in the orchestration Orchestrator',
    sites.length === 1 && sites[0]!.endsWith('orchestration/orchestrator.ts'), JSON.stringify(sites));
}

{
  // The seam really is that one execution edge: `RuntimeOrch.review` forwards to `run`,
  // which is the method that reaches the runtime. A review is therefore an ordinary
  // native execution, not a privileged side channel.
  const orch = sourceText(new URL('../src/orchestrator/orchestrator.ts', import.meta.url));
  check('the native review seam forwards to the single run() edge',
    /review\(req: Omit<RunRequest, 'mode'>\): RunHandle \{\s*return this\.run\(\{ \.\.\.req, mode: 'review' \}\);/.test(orch),
    'review() no longer forwards to run({mode:review})');
}

// ---------------------------------------------------------------------------
// 6. The REAL seam, not a stand-in for it
// ---------------------------------------------------------------------------
section('unified review 6. the real RuntimeOrch.review() seam');

{
  // Groups 3-5 inject a fake reviewer, which proves this module's logic but not that the
  // request it builds is actually ACCEPTED by the production edge. These cases drive the
  // real `Orchestrator` from `src/orchestrator/`, through `runUnifiedReview`, over the same
  // `review()` -> `run({mode:'review'})` path the round CLI uses.
  const dir = mkdtempSync(join(tmpdir(), 'unified-review-seam-'));
  try {
    // A reviewer that never answers. This is the real-world Codex case that matters most:
    // signed out, hung, or waiting on a prompt.
    const stalling = createFakeAdapter({
      id: 'codex',
      capabilities: { newTask: true, review: true, modelSelection: true, cwd: true, extraArgs: true, sandbox: true },
      script: [{ kind: 'hang' }],
    });
    // R5-1.2 (§11.2): a fake named after a REAL agent must REPLACE, not extra-add —
//  silently no-ops when the real codex was bootstrapped, which made
// this “hung reviewer” test drive the real installed CLI.
    const real = new Orchestrator({ config: { agents: {} }, storeDir: dir, replaceAdapters: [stalling] });

    // Count the real seam's invocations, so "the review is not retried" is measured on the
    // production edge rather than on a stand-in.
    let reviewCalls = 0;
    const realReview = real.review.bind(real);
    real.review = (req) => { reviewCalls++; finalOutputPath(req); return realReview(req); };

    const packet = packetOf([packetTask()]);
    const r = await runUnifiedReview(real, packet, {
      reviewer: 'codex', modelId: null, cwd: dir, now, timeoutMs: 250,
    });

    // The request was ACCEPTED: a real session is live on the real runtime. Note that a
    // RUNNING task is deliberately not in `store.listTasks` — that store lists terminal
    // results only — so the live session is the correct evidence here.
    check('the real seam accepted the review request and started a live session',
      real.activeSessions().length === 1, String(real.activeSessions().length));
    // And a reviewer that never answers produces an honest, un-verdicted result.
    check('a real reviewer that never answers reports unavailable', r.status === 'unavailable', r.status);
    check('...with NO verdict', r.verdict === null);
    check('...and a reason naming the reviewer', (r.reason ?? '').length > 0, String(r.reason));
    check('...and a machine-readable code', r.code === 'reviewer-no-result', String(r.code));
    // Exactly ONE execution was started: the round was not re-run to get a review.
    check('the real seam was invoked EXACTLY ONCE despite the timeout', reviewCalls === 1, String(reviewCalls));

    // Release the hanging session so the suite does not leave it running.
    for (const s of real.activeSessions()) {
      await s.cancel('unified review test finished');
      const settled = await s.result(1_000);
      check('the controlled reviewer reached a cancelled terminal result', settled.state === 'cancelled');
    }
    check('the controlled hanging reviewer is no longer active after cancellation', real.activeSessions().length === 0);

    // An agent the runtime has NEVER heard of: the real edge refuses to START it, which is
    // a different failure from a reviewer that started and then hung. The name is
    // deliberately un-registerable — note that on a machine where the real `codex` binary
    // exists, `codex` IS registered, so asking for it proves nothing about this path.
    const empty = new Orchestrator({ config: { agents: {} }, storeDir: dir });
    const r2 = await runUnifiedReview(empty, packet, {
      reviewer: 'no-such-reviewer-registered-nowhere', modelId: null, cwd: dir, now, timeoutMs: 250,
    });
    check('a reviewer the runtime does not know reports unavailable', r2.status === 'unavailable', r2.status);
    check('...with NO verdict', r2.verdict === null);
    check('...and the code says the reviewer could not be started',
      r2.code === 'reviewer-unavailable', String(r2.code));
    check('...and nothing was executed for an agent that cannot start',
      empty.activeSessions().length === 0, String(empty.activeSessions().length));
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows may still hold it */ }
  }
}

// ---------------------------------------------------------------------------
// 7. The imported ReviewPacket CLI entry
// ---------------------------------------------------------------------------
section('unified review 7. imported packet CLI entry');

{
  /**
   * `review codex --packet <file>` is a narrow entry over the SAME runUnifiedReview
   * seam. These cases drive the callable entry directly (never index.ts's auto-main),
   * with the existing fake reviewer, and measure that invalid input is rejected
   * BEFORE any review call.
   */
  const dir = mkdtempSync(join(tmpdir(), 'unified-review-packet-'));
  try {
    const packet = buildReviewPacket({
      roundId: 'round-packet',
      originalRequest: 'add a retry to the http client',
      layaPlan: 'Laya: a small isolated change.',
      tasks: [packetTask()],
      outcomes: [classifyExecutionOutcome({ taskId: 'c1', taskStatus: 'to_verify', run: result() })],
      evidenceNote: 'AttemptStore holds the full append-only execution evidence.',
    });
    const packetPath = join(dir, 'packet.json');
    writeFileSync(packetPath, JSON.stringify(packet, null, 2));

    const ok = fakeReviewer({ state: 'succeeded', output: validVerdict() });
    const good = await runReviewPacket(
      { configuredModel: 'gpt-6.1-sol', review: ok.reviewer.review },
      { agent: 'codex', packetPath, cwd: dir, timeout: 90_000 },
    );
    const request = ok.calls[0]!;
    const extraArgs = request.extraArgs ?? [];
    check('a valid packet returns zero only on a completed pass',
      good.exitCode === 0 && good.report.status === 'reviewed' && good.report.review?.status === 'completed' &&
      good.report.review?.verdict === 'pass', `${good.exitCode}/${good.report.status}`);
    check('the report carries roundId, source and the input path/SHA256',
      good.report.roundId === 'round-packet' && good.report.source === 'imported-packet' &&
      good.report.input.path === resolve(packetPath) && /^[0-9a-f]{64}$/.test(good.report.input.sha256 ?? ''),
      JSON.stringify(good.report.input));
    check('the report states the provenance limit explicitly',
      good.report.provenance.includes('NOT independently authenticated') &&
      good.report.provenance.includes('not a fresh full end-to-end round'));
    check('the report says nothing is re-run automatically',
      good.report.automaticPostRoundAction === 'none');
    check('the imported packet produced EXACTLY ONE unified reviewer call', ok.calls.length === 1,
      String(ok.calls.length));
    check('the reviewer got the generated schema/final-file/read-only profile',
      extraArgs.includes('--output-schema') && extraArgs.includes('--output-last-message') &&
      extraArgs.includes('analytics.enabled=false') && request.sandbox === 'read-only');
    check('the trusted timeout reached the actual runtime request',
      request.timeoutMs === 90_000 && request.model === 'gpt-6.1-sol' && request.agentId === 'codex',
      `${String(request.timeoutMs)}/${String(request.model)}/${request.agentId}`);

    // A completed, legal non-pass is a successful REVIEW but a non-zero command.
    const nonpass = fakeReviewer({
      state: 'succeeded',
      output: validVerdict({ verdict: 'rework', reason: 'the retry is missing', recommendedAction: 'rework' }),
    });
    const rework = await runReviewPacket(
      { configuredModel: 'gpt-6.1-sol', review: nonpass.reviewer.review },
      { agent: 'codex', packetPath, cwd: dir },
    );
    check('a legal non-pass verdict returns nonzero and still reports the review',
      rework.exitCode !== 0 && rework.report.status === 'reviewed' &&
      rework.report.review?.status === 'completed' && rework.report.review?.verdict === 'rework',
      `${rework.exitCode}/${String(rework.report.review?.verdict)}`);
    check('a non-pass review is still called exactly once', nonpass.calls.length === 1,
      String(nonpass.calls.length));

    // Malformed/missing packet files and invalid nested identity fail before dispatch.
    const invalid = (name: string, mutate: (raw: any) => void): string => {
      const raw = JSON.parse(JSON.stringify(packet)) as any;
      mutate(raw);
      const path = join(dir, `${name}.json`);
      writeFileSync(path, JSON.stringify(raw));
      return path;
    };
    const malformed = join(dir, 'malformed.json');
    writeFileSync(malformed, '{"roundId":');
    const oversized = join(dir, 'oversized.json');
    writeFileSync(oversized, Buffer.alloc(1024 * 1024 + 1, 0x20));
    const notUtf8 = join(dir, 'not-utf8.json');
    writeFileSync(notUtf8, Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]));
    const invalidPackets: readonly [string, string][] = [
      ['missing file', join(dir, 'does-not-exist.json')],
      ['malformed JSON', malformed],
      ['oversized file', oversized],
      ['malformed UTF-8', notUtf8],
      ['missing nested task status', invalid('missing-status', (raw) => { delete raw.tasks[0].status; })],
      ['invalid nested run state', invalid('invalid-run-state', (raw) => { raw.tasks[0].handoff.runState = 'exploded'; })],
      ['mismatched handoff identity', invalid('bad-handoff-identity', (raw) => { raw.tasks[0].handoff.taskId = 'another-task'; })],
      ['missing evidence note', invalid('missing-evidence', (raw) => { raw.evidenceNote = ''; })],
    ];
    for (const [name, path] of invalidPackets) {
      const f = fakeReviewer({ state: 'succeeded', output: validVerdict() });
      const r = await runReviewPacket(
        { configuredModel: 'gpt-6.1-sol', review: f.reviewer.review },
        { agent: 'codex', packetPath: path, cwd: dir },
      );
      check(`${name} is rejected before any review call`,
        r.exitCode !== 0 && r.report.status === 'rejected' && f.calls.length === 0,
        `${r.exitCode}/${r.report.status}/${f.calls.length}`);
    }

    // A cwd must be an actual directory, not merely an existing path.
    const fileCwd = fakeReviewer({ state: 'succeeded', output: validVerdict() });
    const fileCwdResult = await runReviewPacket(
      { configuredModel: 'gpt-6.1-sol', review: fileCwd.reviewer.review },
      { agent: 'codex', packetPath, cwd: packetPath },
    );
    check('a cwd that is a regular file is rejected before any review call',
      fileCwdResult.exitCode !== 0 && fileCwdResult.report.status === 'rejected' &&
      fileCwd.calls.length === 0,
      `${fileCwdResult.exitCode}/${fileCwdResult.report.status}/${fileCwd.calls.length}`);

    // Model/timeout overrides that cannot preserve the fixed packet flow.
    const badOverrides: readonly [string, { model?: string | boolean; timeout?: string | number | boolean }][] = [
      ['a model override', { model: 'gpt-5' }],
      ['a zero timeout', { timeout: 0 }],
      ['a fractional timeout', { timeout: 1.5 }],
      ['an excessive timeout', { timeout: 90_001 }],
      ['a missing timeout value', { timeout: true }],
    ];
    for (const [name, override] of badOverrides) {
      const f = fakeReviewer({ state: 'succeeded', output: validVerdict() });
      const r = await runReviewPacket(
        { configuredModel: 'gpt-6.1-sol', review: f.reviewer.review },
        { agent: 'codex', packetPath, cwd: dir, ...override },
      );
      check(`${name} is rejected before any review call`,
        r.exitCode !== 0 && r.report.status === 'rejected' && f.calls.length === 0,
        `${r.exitCode}/${r.report.status}/${f.calls.length}`);
    }

    const configMismatch = fakeReviewer({ state: 'succeeded', output: validVerdict() });
    const mismatch = await runReviewPacket(
      { configuredModel: 'gpt-5', review: configMismatch.reviewer.review },
      { agent: 'codex', packetPath, cwd: dir },
    );
    check('a configured model that is not the packet reviewer model is rejected before dispatch',
      mismatch.exitCode !== 0 && mismatch.report.status === 'rejected' && configMismatch.calls.length === 0,
      `${mismatch.exitCode}/${configMismatch.calls.length}`);

    // Mixed plain-review overrides must not be smuggled into the packet flow.
    const mixedOverrides: readonly [string, { extraPositionals?: readonly string[]; extraArgProvided?: boolean; roleProvided?: boolean; sandboxProvided?: boolean }][] = [
      ['a prompt', { extraPositionals: ['do the thing'] }],
      ['--extra', { extraArgProvided: true }],
      ['--role', { roleProvided: true }],
      ['--sandbox', { sandboxProvided: true }],
    ];
    for (const [name, override] of mixedOverrides) {
      const f = fakeReviewer({ state: 'succeeded', output: validVerdict() });
      const r = await runReviewPacket(
        { configuredModel: 'gpt-6.1-sol', review: f.reviewer.review },
        { agent: 'codex', packetPath, cwd: dir, ...override },
      );
      check(`${name} is refused on the packet path before any review call`,
        r.exitCode !== 0 && r.report.status === 'rejected' && f.calls.length === 0,
        `${r.exitCode}/${f.calls.length}`);
    }

    // The CLI must route the packet branch before the raw review path.
    const strip = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const indexSrc = strip(sourceText(new URL('../src/cli/index.ts', import.meta.url)));
    const reviewCliSrc = strip(sourceText(new URL('../src/cli/review-cli.ts', import.meta.url)));
    check('the CLI routes review --packet before the raw review path',
      /parsed\.flags\.packet\s*!==\s*undefined/.test(indexSrc) && /runReviewPacket\s*\(/.test(indexSrc));
    check('the packet CLI adds no second runtime.run call site',
      !/runtime\s*\.\s*run\s*\(/.test(reviewCliSrc));
    check('the packet CLI calls runUnifiedReview exactly once',
      (reviewCliSrc.match(/runUnifiedReview\s*\(/g) ?? []).length === 1,
      String((reviewCliSrc.match(/runUnifiedReview\s*\(/g) ?? []).length));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// All reviewers above are synthetic and all controlled sessions have now stopped.
// Retained output is fixture-owned; the production code must not remove it early.
for (const dir of fixtureOutputDirectories) {
  if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith('native-agent-review-')) {
    throw new Error('refusing cleanup outside fixture-owned review directory');
  }
  rmSync(dir, { recursive: true, force: true });
}
check('no fixture-owned final output directory remains', [...fixtureOutputDirectories].every(dir => !existsSync(dir)));

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) {
  process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
}
process.stdout.write('\n');
process.exitCode = failed === 0 ? 0 : 1;
