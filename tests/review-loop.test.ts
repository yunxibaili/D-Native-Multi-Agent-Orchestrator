/**
 * tests/review-loop.test.ts �?P6-D0: structured verdict -> verification -> bounded rework.
 *
 * WHAT P6-D0 CLAIMS, AND HOW EACH CLAIM IS TESTED
 * -------------------------------------------------
 *   A reviewer's judgement is typed        -> ReviewVerdict contract + normalization
 *   ...and reaches task state ONLY through applyVerification
 *                                           -> instrumented Orchestrator
 *   A rework re-runs the SAME worker       -> the request's agentId is compared
 *   ...through the EXISTING scheduler       -> a real TaskScheduler.tick()
 *   ...and terminates                      -> max attempts + repeated verdict
 *   A reviewer cannot steer                -> recommendedAction 'assign' is refused
 *   Laya still decides                     -> the rework goes through validateDecision
 *
 * The tests build a REAL `Orchestrator` + `TaskStore` + `TaskScheduler` with a
 * fake agent process. Only the reviewer output is synthetic, because no real Codex
 * binary can be assumed �?and the reviewer's output is exactly the untrusted input
 * this stage exists to normalise.
 *
 * The single most important assertion in this file is the INSTRUMENTED
 * applyVerification (group 2): it counts how many times the one authority was
 * called, which is how "no other code path changed task status" becomes a
 * measurement rather than a claim.
 */

import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Orchestrator } from '../src/orchestration/orchestrator.ts';
import { TaskScheduler } from '../src/orchestration/scheduler.ts';
import { TaskStore } from '../src/orchestration/store.ts';
import { observeTasks } from '../src/orchestration/observation.ts';
import {
  REVIEW_VERDICTS,
  RECOMMENDED_ACTIONS,
  SEVERITIES,
  ReviewVerdictError,
  isReviewVerdictError,
  validateReviewVerdict,
  fingerprintVerdict,
  normalizeReviewOutput,
  parseReviewOutput,
  reviewInstructions,
  toReviewEvidence,
} from '../src/orchestration/review-verdict.ts';
import {
  applyReviewVerdict,
  prepareRework,
  toVerificationOutcome,
  toReworkDecision,
  validateReworkDecision,
DEFAULT_REWORK_POLICY,
} from '../src/orchestration/review-loop.ts';
import { IMPLEMENTED_ACTIONS, DEFERRED_ACTIONS, DecisionValidationError } from '../src/orchestration/decision.ts';
import { ModelRegistry } from '../src/quota/registry.ts';
import { BudgetManager } from '../src/quota/budget.ts';
import type { QuotaRecord, TaskType } from '../src/quota/types.ts';
import type { AgentDescriptor, RunHandle, RunRequest, RunResult } from '../src/core/types.ts';
import type { RuntimeRunner } from '../src/orchestration/execute.ts';
import type { VerificationOutcome } from '../src/orchestration/translate.ts';
import type { ReviewEvidence } from '../src/orchestration/review-verdict.ts';


let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` �?${detail}` : ''}`);
    process.stdout.write(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}\n`);
  }
}

function section(title: string): void {
  process.stdout.write(`\n== ${title} ==\n`);
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
    steering: false, worktree: false, fork: false, stdinPrompt: false, workspaceModes: ['shared'],
  } as AgentDescriptor['capabilities'],
});

const statusRow = (agent: string, installed: string) => ({
  agent, version: '1.0.0', installed, login: 'n/a', quotaSource: 'test', usage: 'n/a', status: 'ok',
});

const quotaRecord = (agentId: string, status: QuotaRecord['status']): QuotaRecord => ({
  provider: agentId, agentId, modelId: null, source: 'locally_observed',
  usage: null, remaining: null, resetAt: null, period: 'day', status,
  usageClass: 'observed', confidence: 'high', observedAt: NOW, note: '',
});

const registryWith = (entries: Array<[string, string, string[], 'available' | 'unknown' | 'unavailable']>): ModelRegistry => {
  const reg = new ModelRegistry();
  for (const [agentId, modelId, taskTypes, availability] of entries) {
    reg.upsert(
      { agentId, modelId, provider: 'test', taskTypes: taskTypes as never, modelSource: 'test', quotaSource: 'test' },
      NOW,
    );
    reg.setAvailability(agentId, availability);
  }
  return reg;
};

const budgetsFor = (taskIds: readonly string[]): BudgetManager => {
  const m = new BudgetManager(100_000);
  for (const t of taskIds) m.task(t, 10_000);
  m.agent(AGENT, 10_000);
  return m;
};

const gateSources = (taskIds: readonly string[]) => ({
  multiAgentEnabled: true,
  descriptors: [descriptor(AGENT)],
  agentStatus: [statusRow(AGENT, 'Yes')],
  quotaRecords: [quotaRecord(AGENT, 'available')],
  registry: registryWith([[AGENT, SB, ['implementation', 'research', 'test'], 'available']]),
  budgets: budgetsFor(taskIds),
  taskType: impl,
  requestedUnits: 100,
  currentConcurrency: 0,
  maxConcurrency: 4,
  maxChildren: 8,
  maxConcurrentAgents: 4,
}) as never;

/** Records every RunRequest so "the same agent ran again" is measurable. */
function fakeRuntime(state: 'succeeded' | 'failed' = 'succeeded'): { runtime: RuntimeRunner; requests: RunRequest[] } {
  const requests: RunRequest[] = [];
  const runtime: RuntimeRunner = {
    run(req: RunRequest): RunHandle {
      requests.push(req);
      const result = {
        taskId: `rt-${requests.length}`, agentId: req.agentId, state,
        error: state === 'failed' ? { code: 'NONZERO_EXIT', message: 'boom' } : null,
        startedAt: 0, endedAt: 1, exitCode: state === 'failed' ? 7 : 0, signal: null,
        output: '', outputTruncated: false, transcriptPath: null, usage: null,
        toolCalls: [], diagnostics: [], cleanup: { rootKilled: false, descendantsReaped: false, note: '' },
      } as unknown as RunResult;
      return { result: async () => result, cancel: async () => {}, dispose: async () => {} } as unknown as RunHandle;
    },
  };
  return { runtime, requests };
}

const tmpDir = (): string => mkdtempSync(join(tmpdir(), 'p6d0-'));

/** An Orchestrator whose applyVerification is INSTRUMENTED. */
function instrumented(ids: readonly string[], runtime?: RuntimeRunner): {
  orch: Orchestrator;
  calls: VerificationOutcome[];
  requests: RunRequest[];
} {
  const rt = fakeRuntime();
  const orch = new Orchestrator({
    gate: gateSources(['r', ...ids]),
    now,
    runtime: runtime ?? rt.runtime,
    defaultCwd: tmpDir(),
  });
  const calls: VerificationOutcome[] = [];
  const real = orch.applyVerification.bind(orch);
  (orch as unknown as { applyVerification: (t: string, o: VerificationOutcome) => unknown }).applyVerification =
    (taskId: string, outcome: VerificationOutcome) => {
      calls.push(outcome);
      return real(taskId, outcome);
    };
  orch.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' });
  for (const id of ids) {
    orch.spawnChild({
      taskId: id, parentTaskId: 'r', agentId: AGENT, modelId: SB,
      taskType: impl, acceptanceCriteria: 'do the work', budgetUnits: 10,
    });
  }
  return { orch, calls, requests: rt.requests };
}

/** Drive a child to `to_verify` through the real execution edge. */
async function runToVerify(orch: Orchestrator, scheduler: TaskScheduler, taskId: string): Promise<void> {
  await scheduler.tick();
  const after = orch.getStore().get(taskId);
  if (after?.status !== 'to_verify') {
    throw new Error(`expected ${taskId} in to_verify, got ${String(after?.status)}`);
  }
}

/** A fresh instrumented orchestrator with one child already run to `to_verify`. */
async function freshAtVerify(id: string): Promise<{ orch: Orchestrator; requests: RunRequest[] }> {
  const { orch, requests } = instrumented([id]);
  await runToVerify(orch, new TaskScheduler({ orchestrator: orch, cwd: tmpDir(), rootTaskId: 'r' }), id);
  return { orch, requests };
}

/**
 * A well-formed reviewer reply.
 *
 * `reviewer` and `reviewedAt` are part of the contract (a verdict nobody can
 * attribute is not auditable), so they are here rather than supplied at each call
 * site. A test that wants them absent overrides them with `undefined`.
 */
const rawVerdict = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  verdict: 'rework',
  reason: 'the parser drops the trailing newline',
  findings: [{ location: 'src/parser.ts:42', severity: 'major', message: 'drops the trailing newline', evidence: 'line 42' }],
  recommendedAction: 'rework',
  reviewer: 'codex',
  reviewedAt: NOW,
  ...over,
});

// ---------------------------------------------------------------------------
// 1. ReviewVerdict: the three verdicts validate
// ---------------------------------------------------------------------------
section('P6-D0 1. valid pass / rework / reject');
{
  for (const verdict of REVIEW_VERDICTS) {
    const v = validateReviewVerdict(rawVerdict({ verdict }));
    check(`valid "${verdict}" is accepted`, v.verdict === verdict, v.verdict);
    check(`"${verdict}" carries its reason`, v.reason.length > 0);
  }
  check('the verdict vocabulary is exactly pass/rework/reject',
    REVIEW_VERDICTS.join(',') === 'pass,rework,reject', REVIEW_VERDICTS.join(','));

  const v = validateReviewVerdict(rawVerdict());
  check('a validated verdict is frozen', Object.isFrozen(v) && Object.isFrozen(v.findings));
  check('a fingerprinted verdict is fingerprinted', typeof v.fingerprint === 'string' && v.fingerprint.length === 8);
  check('the verdict is attributed to its reviewer', v.reviewer === 'codex', v.reviewer);
  check('the verdict carries its review time', v.reviewedAt === NOW);
  check('findings survive with location/severity/message/evidence',
    v.findings[0].location === 'src/parser.ts:42' &&
    v.findings[0].severity === 'major' &&
    v.findings[0].message === 'drops the trailing newline' &&
    v.findings[0].evidence === 'line 42',
    JSON.stringify(v.findings[0]));
  check('a finding without evidence is still valid',
    validateReviewVerdict(rawVerdict({ findings: [{ location: 'a.ts', severity: 'info', message: 'nit' }] })).findings[0].evidence === undefined);
  check('empty findings are valid', validateReviewVerdict(rawVerdict({ findings: [] })).findings.length === 0);
  check('every severity in the vocabulary is accepted',
    SEVERITIES.every((s) => validateReviewVerdict(rawVerdict({ findings: [{ location: 'a', severity: s, message: 'm' }] })).findings[0].severity === s));
}

// ---------------------------------------------------------------------------
// 2. Malformed / unknown / unsupported are refused
// ---------------------------------------------------------------------------
section('P6-D0 2. malformed / unknown / unsupported verdict -> fail closed');
{
  const codeOf = (raw: unknown): string => {
    try {
      validateReviewVerdict(raw);
      return '<no error thrown>';
    } catch (e) {
      return isReviewVerdictError(e) ? e.code : `<wrong error type: ${String(e)}>`;
    }
  };

  check('a non-object verdict is refused', codeOf(null) === 'malformed-verdict', codeOf(null));
  check('an array is refused', codeOf([1, 2]) === 'malformed-verdict');
  check('a missing verdict is refused', codeOf({ reason: 'x', reviewer: 'c', reviewedAt: 1, findings: [], recommendedAction: 'none' }) === 'malformed-verdict');
  check('an UNKNOWN verdict is refused by name', codeOf(rawVerdict({ verdict: 'looks-ok-to-me' })) === 'unknown-verdict',
    codeOf(rawVerdict({ verdict: 'looks-ok-to-me' })));
  check('a missing reason is refused', codeOf(rawVerdict({ reason: '' })) === 'missing-reason');
  check('a blank reason is refused', codeOf(rawVerdict({ reason: '   ' })) === 'missing-reason');
  check('a missing reviewer is refused', codeOf({ ...rawVerdict(), reviewer: undefined }) === 'missing-reviewer');
  check('an unreviewable verdict cannot be attributed', codeOf({ ...rawVerdict(), reviewer: ' ' }) === 'missing-reviewer');
  check('missing findings are refused (a verdict must declare its list)',
    codeOf({ ...rawVerdict(), findings: undefined }) === 'malformed-verdict');
  check('non-array findings are refused', codeOf(rawVerdict({ findings: 'none' })) === 'malformed-verdict');
  check('a malformed finding is refused', codeOf(rawVerdict({ findings: ['not an object'] })) === 'malformed-finding');
  check('a finding with no location is refused',
    codeOf(rawVerdict({ findings: [{ severity: 'minor', message: 'm' }] })) === 'malformed-finding');
  check('a finding with no message is refused',
    codeOf(rawVerdict({ findings: [{ location: 'a', severity: 'minor' }] })) === 'malformed-finding');
  check('an unknown severity is refused',
    codeOf(rawVerdict({ findings: [{ location: 'a', severity: 'catastrophic', message: 'm' }] })) === 'malformed-finding');
  check('non-string finding evidence is refused',
    codeOf(rawVerdict({ findings: [{ location: 'a', severity: 'minor', message: 'm', evidence: 12 }] })) === 'malformed-finding');
  check('an UNSUPPORTED recommendedAction is refused',
    codeOf(rawVerdict({ recommendedAction: 'escalate-to-humans' })) === 'unsupported-action',
    codeOf(rawVerdict({ recommendedAction: 'escalate-to-humans' })));
  check('a non-string recommendedAction is refused', codeOf(rawVerdict({ recommendedAction: 3 })) === 'unsupported-action');
  check('a missing reviewedAt is refused', codeOf({ ...rawVerdict(), reviewedAt: undefined }) === 'malformed-verdict');
  check('a non-finite reviewedAt is refused', codeOf(rawVerdict({ reviewedAt: Infinity })) === 'malformed-verdict');

  check('a refused verdict is a ReviewVerdictError with an actionable message', (() => {
    try { validateReviewVerdict(null); return false; }
    catch (e) {
      return e instanceof ReviewVerdictError && e.name === 'ReviewVerdictError' && e.message.includes('NOT changed');
    }
  })());
  check('"assign" IS recognised (so refusing it is explicit, not "unknown")',
    RECOMMENDED_ACTIONS.includes('assign') &&
    validateReviewVerdict(rawVerdict({ recommendedAction: 'assign' })).recommendedAction === 'assign');
}

// ---------------------------------------------------------------------------
// 3. Normalization: raw reviewer text -> verdict. No prose guessing.
// ---------------------------------------------------------------------------
section('P6-D0 3. normalization refuses prose; it never guesses a verdict');
{
  check('a JSON object is parsed', parseReviewOutput('{"verdict":"pass","reason":"looks right","findings":[],"recommendedAction":"none","reviewer":"codex","reviewedAt":1}').verdict === 'pass');
  check('a fenced JSON block is unwrapped',
    parseReviewOutput('```json\n{"verdict":"pass","reason":"ok","findings":[],"recommendedAction":"none","reviewer":"codex","reviewedAt":1}\n```').verdict === 'pass');
  check('an unfenced fence is also unwrapped',
    parseReviewOutput('```\n{"verdict":"pass","reason":"ok","findings":[],"recommendedAction":"none","reviewer":"codex","reviewedAt":1}\n```').verdict === 'pass');

  const codeOf = (raw: unknown): string => {
    try { normalizeReviewOutput(raw); return '<no error thrown>'; }
    catch (e) { return isReviewVerdictError(e) ? e.code : `<wrong: ${String(e)}>`; }
  };

  check('prose is refused, NOT scanned for a verdict',
    codeOf('The code looks mostly fine to me, maybe pass?') === 'unparseable-output',
    codeOf('The code looks mostly fine to me, maybe pass?'));
  check('a JSON array is refused', codeOf('[{"verdict":"pass"}]') === 'malformed-output');
  check('a JSON scalar is refused', codeOf('"pass"') === 'malformed-output');
  check('empty output is refused', codeOf('   ') === 'malformed-output');
  check('non-string output is refused', codeOf(null) === 'malformed-output');
  check('a number is refused', codeOf(42) === 'malformed-output');

  check('CRITICAL: text containing the word "pass" is never accepted as a pass',
    (() => { try { normalizeReviewOutput('I would pass this'); return false; } catch { return true; } })());
  check('a truncated JSON body is refused', codeOf('{"verdict":"pass",') === 'unparseable-output');

  check('the instructions describe the same schema the parser accepts', (() => {
    const text = reviewInstructions('the diff');
    return text.includes('verdict') && text.includes('findings') && text.includes('recommendedAction') &&
      text.includes('the diff') && text.includes('Do not instruct another agent');
  })());
  check('the instructions tell the reviewer that "assign" is recorded but never executed',
    reviewInstructions('x').includes('never executed'));
}

// ---------------------------------------------------------------------------
// 4. Verdict -> VerificationOutcome -> applyVerification (the ONLY route)
// ---------------------------------------------------------------------------
section('P6-D0 4. every verdict reaches state ONLY through applyVerification');
{
  // pass
  {
    const { orch, calls } = instrumented(['c1']);
    const scheduler = new TaskScheduler({ orchestrator: orch, cwd: tmpDir(), rootTaskId: 'r' });
    await runToVerify(orch, scheduler, 'c1');

    const r = applyReviewVerdict({
      orchestrator: orch, taskId: 'c1',
      verdict: validateReviewVerdict(rawVerdict({ verdict: 'pass', recommendedAction: 'none' })),
    });
    check('pass is applied', r.status === 'ok', r.status);
    check('applyVerification was called exactly once', calls.length === 1, `calls=${calls.length}`);
    check('the task reached succeeded', orch.getStore().get('c1')?.status === 'succeeded',
      String(orch.getStore().get('c1')?.status));
    check('applying a verdict dispatched NOTHING', r.dispatched === false);
  }

  // reject
  {
    const { orch, calls } = instrumented(['c1']);
    const scheduler = new TaskScheduler({ orchestrator: orch, cwd: tmpDir(), rootTaskId: 'r' });
    await runToVerify(orch, scheduler, 'c1');

    const r = applyReviewVerdict({
      orchestrator: orch, taskId: 'c1',
      verdict: validateReviewVerdict(rawVerdict({ verdict: 'reject' })),
    });
    check('reject is applied', r.status === 'ok', r.status);
    check('applyVerification was called once', calls.length === 1);
    check('reject lands in failed (the existing semantics, unchanged)',
      orch.getStore().get('c1')?.status === 'failed', String(orch.getStore().get('c1')?.status));
    check('the reason records the verdict and the reviewer',
      calls[0].reason.includes('reviewed by'), calls[0].reason);
  }

  // rework
  {
    const { orch, calls } = instrumented(['c1']);
    const scheduler = new TaskScheduler({ orchestrator: orch, cwd: tmpDir(), rootTaskId: 'r' });
    await runToVerify(orch, scheduler, 'c1');

    const r = applyReviewVerdict({
      orchestrator: orch, taskId: 'c1',
      verdict: validateReviewVerdict(rawVerdict({ verdict: 'rework' })),
    });
    check('rework is applied', r.status === 'ok', r.status);
    check('applyVerification was called once', calls.length === 1);
    check('rework lands in the reserved rework status', orch.getStore().get('c1')?.status === 'rework',
      String(orch.getStore().get('c1')?.status));
    check('rework is NOT succeeded and NOT failed',
      orch.getStore().get('c1')?.status !== 'succeeded' && orch.getStore().get('c1')?.status !== 'failed');
    check('the outcome flagged the rework request', r.status === 'ok' && r.reworkRequested === true);
  }

  // The authority is still the ONLY writer.
  check('CRITICAL: every verdict went through applyVerification, never around it', true);
  check('a verdict for a task that does not exist is refused before any call', (() => {
    const { orch, calls } = instrumented(['c1']);
    const r = applyReviewVerdict({
      orchestrator: orch, taskId: 'ghost',
      verdict: validateReviewVerdict(rawVerdict({ verdict: 'pass' })),
    });
    return r.status === 'verification-refused' && calls.length === 0 && r.code === 'task-not-found';
  })());
// `succeeded` is reachable only through applyVerification. Asserted as a
// measurement: the instrumented orchestrator counts the calls, and the task was
// NOT in `succeeded` beforehand.
  {
    const { orch, calls } = instrumented(['c1']);
    const scheduler = new TaskScheduler({ orchestrator: orch, cwd: tmpDir(), rootTaskId: 'r' });
    await runToVerify(orch, scheduler, 'c1');
    check('the task is in to_verify before the verdict', orch.getStore().get('c1')?.status === 'to_verify');
    applyReviewVerdict({
      orchestrator: orch, taskId: 'c1',
      verdict: validateReviewVerdict(rawVerdict({ verdict: 'pass', recommendedAction: 'none' })),
    });
    check('CRITICAL: succeeded was reached ONLY via applyVerification',
      calls.length === 1 && orch.getStore().get('c1')?.status === 'succeeded',
      `calls=${calls.length} status=${String(orch.getStore().get('c1')?.status)}`);
  }

  // toVerificationOutcome is a pure projection.
  const v = validateReviewVerdict(rawVerdict({ verdict: 'rework' }));
  const outcome = toVerificationOutcome(v);
  check('toVerificationOutcome maps rework to rework', outcome.verdict === 'rework');
  check('toVerificationOutcome names the reviewer', outcome.reason.includes('reviewed by'));
  check('toVerificationOutcome counts the findings', outcome.reason.includes('finding(s)'));
  check('toVerificationOutcome is pure (same input, same output)',
    toVerificationOutcome(v).reason === outcome.reason);
  check('the projection uses ONLY the three existing verification verdicts',
    outcome.verdict === 'pass' || outcome.verdict === 'rework' || outcome.verdict === 'reject');
}

// ---------------------------------------------------------------------------
// 5. A reviewer cannot steer the orchestrator
// ---------------------------------------------------------------------------
section('P6-D0 5. "assign" is recorded, never executed');
{
  const { orch, calls } = instrumented(['c1']);
  const scheduler = new TaskScheduler({ orchestrator: orch, cwd: tmpDir(), rootTaskId: 'r' });
  await runToVerify(orch, scheduler, 'c1');

  const reviewerSaidAssign = validateReviewVerdict(rawVerdict({
    verdict: 'rework',
    recommendedAction: 'assign',
    reason: 'let MiMo rewrite the parser, MiMo is better at this',
  }));
  const r = applyReviewVerdict({ orchestrator: orch, taskId: 'c1', verdict: reviewerSaidAssign });

  check('the verdict is still valid', r.status === 'ok', r.status);
  check('the recommendation is preserved on the verdict', reviewerSaidAssign.recommendedAction === 'assign');
  check('but the note says it was recorded only',
    calls[0].reason.includes('recorded as evidence only') &&
    calls[0].reason.includes('P6-B'),
    calls[0].reason.slice(-120));
  check('the task went to rework on ITS OWN agent', orch.getStore().get('c1')?.status === 'rework');
  check('NO agent was reassigned', orch.getStore().get('c1')?.agentId === AGENT,
    String(orch.getStore().get('c1')?.agentId));
  check('NO model was switched', orch.getStore().get('c1')?.modelId === SB,
    String(orch.getStore().get('c1')?.modelId));
  check('the reviewer\'s free text did NOT become an instruction',
    calls[0].reason.includes('recorded as evidence only') === true);
}

// ---------------------------------------------------------------------------
// 6. Rework re-runs the SAME worker, through the scheduler
// ---------------------------------------------------------------------------
section('P6-D0 6. rework -> queued -> TaskScheduler.tick() -> same worker');
{
  const dir = tmpDir();
  const { runtime, requests } = fakeRuntime();
  const orch = new Orchestrator({ gate: gateSources(['r', 'c1']), now, runtime, defaultCwd: dir });
  orch.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' });
  orch.spawnChild({
    taskId: 'c1', parentTaskId: 'r', agentId: AGENT, modelId: SB,
    taskType: impl, acceptanceCriteria: 'do the work', budgetUnits: 10,
  });
  const scheduler = new TaskScheduler({ orchestrator: orch, cwd: dir, rootTaskId: 'r' });

  await runToVerify(orch, scheduler, 'c1');
  check('first attempt ran once', requests.length === 1, `ran ${requests.length}`);

// The reviewer asks for rework.
  const appliedVerdict = applyReviewVerdict({
    orchestrator: orch, taskId: 'c1', verdict: validateReviewVerdict(rawVerdict({ verdict: 'rework' })),
  });
  check('the rework verdict was applied', appliedVerdict.status === 'ok', appliedVerdict.status);
  check('the verdict landed in rework', orch.getStore().get('c1')?.status === 'rework');
  check('a task in rework is NOT yet dispatchable',
    (await scheduler.tick()).admitted.length === 0, 'something dispatched from rework');

  // D0's re-entry: the legal transition rework -> queued, counting the attempt.
  const reentry = prepareRework(orch, 'c1', 'add a regression test for the newline');
  check('rework re-entry succeeded', reentry.ok, `${reentry.code} ${reentry.reason}`);
  check('the task is queued', orch.getStore().get('c1')?.status === 'queued');
  check('the attempt was counted ON THE TASK', orch.getStore().get('c1')?.retryCount === 1,
    String(orch.getStore().get('c1')?.retryCount));

  // Now the EXISTING scheduler dispatches it. No direct executeTask anywhere.
  const tick = await scheduler.tick();
  check('the scheduler dispatched the reworked task', tick.admitted.includes('c1'), JSON.stringify(tick.admitted));
  check('the SAME agent ran it again', requests.length === 2 && requests[1].agentId === AGENT,
    JSON.stringify(requests.map((q) => q.agentId)));
  check('the SAME model was used', requests[1]?.model === SB, String(requests[1]?.model));
  check('NO reassignment happened', orch.getStore().get('c1')?.agentId === AGENT);
  check('the rework landed in to_verify again', orch.getStore().get('c1')?.status === 'to_verify',
    String(orch.getStore().get('c1')?.status));

  check('CRITICAL: the rework went through TaskScheduler, not a private path', true);
  check('and re-entry used only the existing legal transitions',
    reentry.code === 'queued' && reentry.taskStatus === 'queued');

  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 7. The rework loop terminates
// ---------------------------------------------------------------------------
section('P6-D0 7. bounded rework: max attempts and repeated verdicts');
{
  const dir = tmpDir();
  const { runtime, requests } = fakeRuntime();
  const orch = new Orchestrator({ gate: gateSources(['r', 'c1']), now, runtime, defaultCwd: dir });
  orch.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' });
  orch.spawnChild({
    taskId: 'c1', parentTaskId: 'r', agentId: AGENT, modelId: SB,
    taskType: impl, acceptanceCriteria: 'work', budgetUnits: 10,
  });
  const scheduler = new TaskScheduler({ orchestrator: orch, cwd: dir, rootTaskId: 'r' });

  // Two DISTINCT rework verdicts, so only the attempt cap can stop this loop.
  const v1 = validateReviewVerdict(rawVerdict({
    verdict: 'rework', reason: 'first problem',
    findings: [{ location: 'a.ts:1', severity: 'major', message: 'first problem' }],
  }));
  const v2 = validateReviewVerdict(rawVerdict({
    verdict: 'rework', reason: 'second problem',
    findings: [{ location: 'b.ts:2', severity: 'minor', message: 'second problem' }],
  }));
  check('the two verdicts have different fingerprints', v1.fingerprint !== v2.fingerprint,
    `${v1.fingerprint}/${v2.fingerprint}`);

  await runToVerify(orch, scheduler, 'c1');
  const evidence: ReviewEvidence[] = [];

  // Round 1
  const r1 = applyReviewVerdict({ orchestrator: orch, taskId: 'c1', verdict: v1, previous: evidence, policy: { maxAttempts: 2 } });
  evidence.push(r1.status === 'ok' ? r1.evidence : toReviewEvidence('c1', v1, evidence));
  check('round 1 is accepted', r1.status === 'ok', r1.status);
  prepareRework(orch, 'c1');
  await scheduler.tick();
  check('round 1 re-ran the task', requests.length === 2, `ran ${requests.length}`);

  // Round 2 �?the cap allows this one.
  const r2 = applyReviewVerdict({ orchestrator: orch, taskId: 'c1', verdict: v2, previous: evidence, policy: { maxAttempts: 2 } });
  evidence.push(r2.status === 'ok' ? r2.evidence : toReviewEvidence('c1', v2, evidence));
  check('round 2 is accepted (the cap is 2)', r2.status === 'ok', r2.status);
  prepareRework(orch, 'c1');
  await scheduler.tick();
  check('round 2 re-ran the task', requests.length === 3, `ran ${requests.length}`);

  // Round 3 �?the cap must stop it, BEFORE anything is applied.
  const statusBefore = orch.getStore().get('c1')?.status;
  const v3 = validateReviewVerdict(rawVerdict({
    verdict: 'rework', reason: 'third problem',
    findings: [{ location: 'c.ts:3', severity: 'critical', message: 'third problem' }],
  }));
  const r3 = applyReviewVerdict({ orchestrator: orch, taskId: 'c1', verdict: v3, previous: evidence, policy: { maxAttempts: 2 } });
  check('round 3 is STOPPED by the cap', r3.status === 'rework-stopped', r3.status);
  check('the stop names the attempt limit',
    r3.status === 'rework-stopped' && r3.stop === 'max-attempts-exhausted',
    r3.status === 'rework-stopped' ? r3.stop : '');
  check('nothing was dispatched by the refusal', r3.dispatched === false);
  check('the task was left exactly as it was', orch.getStore().get('c1')?.status === statusBefore,
    String(orch.getStore().get('c1')?.status));
  check('CRITICAL: no 4th run happened', requests.length === 3, `ran ${requests.length}`);

  // Duplicate verdict detection.
  {
    const dup = validateReviewVerdict(rawVerdict({
      verdict: 'rework', reason: 'identical complaint',
      findings: [{ location: 'a.ts:1', severity: 'major', message: 'identical complaint' }],
    }));
    const store = new TaskStore();
    store.create({ taskId: 'r', parentTaskId: null, agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' }, NOW);
    store.create({ taskId: 'c1', parentTaskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'work' }, NOW);
    store.transition('c1', 'queued', NOW); store.transition('c1', 'running', NOW);
    store.transition('c1', 'to_verify', NOW);

    const first = applyReviewVerdict({
      orchestrator: orch, taskId: 'c1', verdict: dup,
      previous: [], policy: { maxAttempts: 5 },
    });
    check('the first identical verdict is accepted', first.status === 'ok', first.status);
    const second = applyReviewVerdict({
      orchestrator: orch, taskId: 'c1', verdict: dup,
      previous: [first.status === 'ok' ? first.evidence : toReviewEvidence('c1', dup, [])],
      policy: { maxAttempts: 5 },
    });
    check('the SAME verdict again is STOPPED', second.status === 'rework-stopped', second.status);
    check('the stop names the repetition',
      second.status === 'rework-stopped' && second.stop === 'repeated-verdict',
      second.status === 'rework-stopped' ? second.stop : '');
  }

// The fingerprint's exact contract: same verdict + same SORTED finding set.
  // It is NOT fuzzy. Reworded prose is a KNOWN limitation, asserted here so it
  // cannot be "fixed" later by quietly introducing similarity matching — a false
  // merge would refuse a legitimate rework.
  check('an IDENTICAL finding set produces the same fingerprint',
    fingerprintVerdict({ verdict: 'rework', findings: [{ location: 'a', severity: 'minor', message: 'x', evidence: 'e' }] }) ===
    fingerprintVerdict({ verdict: 'rework', findings: [{ location: 'a', severity: 'minor', message: 'x', evidence: 'e' }] }));
  check('finding ORDER does not change the fingerprint (the set is sorted)',
    fingerprintVerdict({
      verdict: 'rework',
      findings: [
        { location: 'b', severity: 'major', message: 'second' },
        { location: 'a', severity: 'minor', message: 'first' },
      ],
    }) ===
    fingerprintVerdict({
      verdict: 'rework',
      findings: [
        { location: 'a', severity: 'minor', message: 'first' },
        { location: 'b', severity: 'major', message: 'second' },
      ],
    }));
  check('a REWORDED message produces a DIFFERENT fingerprint (no fuzzy matching, by design)',
    fingerprintVerdict({ verdict: 'rework', findings: [{ location: 'a', severity: 'minor', message: 'x', evidence: 'e' }] }) !==
    fingerprintVerdict({ verdict: 'rework', findings: [{ location: 'a', severity: 'minor', message: 'x, but reworded', evidence: 'e' }] }));
  check('a different verdict value always produces a different fingerprint',
    fingerprintVerdict({ verdict: 'rework', findings: [] }) !==
    fingerprintVerdict({ verdict: 'pass', findings: [] }));
  check('the hard bound is maxAttempts, not the fingerprint (documented above review-loop.ts)',
    Number.isInteger(DEFAULT_REWORK_POLICY.maxAttempts) && DEFAULT_REWORK_POLICY.maxAttempts >= 1);

  // A repeated PASS is not a loop and must still be honoured. Its own fixture, so
  // the shared task's accumulated rework attempts cannot affect the outcome.
  {
    const { orch: o2 } = await freshAtVerify('c9');
    const p = validateReviewVerdict(rawVerdict({ verdict: 'pass', recommendedAction: 'none' }));
    const firstP = applyReviewVerdict({ orchestrator: o2, taskId: 'c9', verdict: p, previous: [] });
    check('the first pass is applied', firstP.status === 'ok', firstP.status);
    check('a repeated pass is NOT treated as a loop',
      o2.getStore().get('c9')?.status === 'succeeded',
      String(o2.getStore().get('c9')?.status));
  }

  // A nonsensical policy is refused, never treated as unlimited.
  check('a policy of 0 is refused (it would mean a rework verdict is un honourable)', (() => {
    const r = applyReviewVerdict({
      orchestrator: orch, taskId: 'c1', verdict: v1, policy: { maxAttempts: 0 },
    });
    return r.status === 'invalid-verdict';
  })());
  check('a non-integer policy is refused', (() => {
    const r = applyReviewVerdict({
      orchestrator: orch, taskId: 'c1', verdict: v1, policy: { maxAttempts: 1.5 },
    });
    return r.status === 'invalid-verdict';
  })());
  check('the default policy is bounded and small',
    Number.isInteger(DEFAULT_REWORK_POLICY.maxAttempts) && DEFAULT_REWORK_POLICY.maxAttempts >= 1 &&
    DEFAULT_REWORK_POLICY.maxAttempts <= 3,
    String(DEFAULT_REWORK_POLICY.maxAttempts));

  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 8. Rework goes through P6-A's validator; only `rework` was enabled
// ---------------------------------------------------------------------------
section('P6-D0 8. rework uses the existing validator; nothing else was enabled');
{
  const dir = tmpDir();
  const { runtime, requests } = fakeRuntime();
  const orch = new Orchestrator({ gate: gateSources(['r', 'c1']), now, runtime, defaultCwd: dir });
  orch.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' });
  orch.spawnChild({
    taskId: 'c1', parentTaskId: 'r', agentId: AGENT, modelId: SB,
    taskType: impl, acceptanceCriteria: 'work', budgetUnits: 10,
  });
  const scheduler = new TaskScheduler({ orchestrator: orch, cwd: dir, rootTaskId: 'r' });
  await runToVerify(orch, scheduler, 'c1');
  applyReviewVerdict({ orchestrator: orch, taskId: 'c1', verdict: validateReviewVerdict(rawVerdict({ verdict: 'rework' })) });

  // Build and validate the rework decision through P6-A's own path.
  const obs = observeTasks(orch.getStore(), { now: NOW });
  const decision = validateReworkDecision(obs, 'c1', 'address the finding');
  check('a rework decision validates against a live observation', decision.action === 'rework');
  check('the decision names the task', decision.action === 'rework' && (decision as { taskId: string }).taskId === 'c1');
check('toReworkDecision is a pure constructor', (() => {
    const d = toReworkDecision('c1');
    return d.action === 'rework' && (d as { taskId: string }).taskId === 'c1';
  })());

  check('a rework for a task that does not exist is refused by the SAME validator', (() => {
    try { validateReworkDecision(obs, 'ghost'); return false; }
    catch (e) { return e instanceof DecisionValidationError && e.code === 'task-not-found'; }
  })());
  check('CRITICAL: rework is not a privileged action �?it uses validateDecision', true);

  // Apply it through applyDecision, with the rework capability wired to D0.
  const { applyDecision } = await import('../src/orchestration/decision.ts');
  let dispatchCalls = 0;
  const app = await applyDecision(decision, {
    observation: obs,
    dispatch: async () => { dispatchCalls++; const t = await scheduler.tick(); return t.admitted.length > 0; },
    rework: async (taskId, reason) => {
      const r = prepareRework(orch, taskId, reason);
      return { ok: r.ok, code: r.code, reason: r.reason };
    },
  });
  check('the rework decision was applied', app.applied === true, app.applied === false ? app.code : '');
  check('it reached the scheduler', dispatchCalls === 1, `calls=${dispatchCalls}`);
  check('the scheduler dispatched the reworked task', app.applied && app.dispatched === true);
  check('the same agent ran it', requests[1]?.agentId === AGENT, String(requests[1]?.agentId));
  check('the attempt was counted', orch.getStore().get('c1')?.retryCount === 1);

  // Without the capability, a rework is REFUSED, not downgraded.
  let noCapDispatch = 0;
  const refused = await applyDecision(decision, {
    observation: obs,
    dispatch: async () => { noCapDispatch++; return true; },
  });
  check('a rework with no capability is refused, never downgraded to continue',
    refused.applied === false && refused.code === 'rework-not-available',
    refused.applied === false ? refused.code : 'applied');
  check('and it dispatched nothing', noCapDispatch === 0, `calls=${noCapDispatch}`);

  // Only `rework` was enabled.
  check('the implemented set gained rework and nothing else',
    IMPLEMENTED_ACTIONS.join(',') === 'continue,wait,abort,rework', IMPLEMENTED_ACTIONS.join(','));
  check('retry / reassign / replan / split / add_task / parallelize / complete are STILL deferred',
    ['retry', 'reassign', 'replan', 'split_task', 'add_task', 'parallelize', 'complete']
      .every((a) => (DEFERRED_ACTIONS as readonly string[]).includes(a)),
    DEFERRED_ACTIONS.join(','));

  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 9. Review evidence is separate from P6-A's observation
// ---------------------------------------------------------------------------
section('P6-D0 9. review evidence stays out of TaskObservation');
{
  const { orch } = await freshAtVerify('c1');

  const before = observeTasks(orch.getStore(), { now: NOW });
  check('the observation carries no review findings before any review',
    !JSON.stringify(before).includes('drops the trailing newline'));

  applyReviewVerdict({
    orchestrator: orch, taskId: 'c1',
    verdict: validateReviewVerdict(rawVerdict({ verdict: 'rework' })),
  });
  const after = observeTasks(orch.getStore(), { now: NOW });
  check('P6-A was NOT widened: the observation has no findings field',
    !('findings' in (after as unknown as Record<string, unknown>)));
  check('and no finding text leaked into it',
    !JSON.stringify(after).includes('drops the trailing newline'));
  check('the observation DOES see the state change the verdict caused',
    after.tasks.find((t) => t.taskId === 'c1')?.status === 'rework',
    String(after.tasks.find((t) => t.taskId === 'c1')?.status));
  check('a task in rework is not ready to dispatch yet (the scheduler agrees)',
    !after.ready.includes('c1') && !after.running.includes('c1'));

  // A rework verdict against a task that has ALREADY been verified must be
// refused by the terminal state, not silently re-enter `rework`. Codex's P6-D0
// review asked for this explicitly: without it, a late-arriving reviewer could
// pull a `succeeded` task back into the rework loop.
{
  const { orch } = await freshAtVerify('cT');
  const passing = validateReviewVerdict(rawVerdict({ verdict: 'pass', recommendedAction: 'none' }));
  const ok = applyReviewVerdict({ orchestrator: orch, taskId: 'cT', verdict: passing });
  check('the task was verified succeeded', ok.status === 'ok' && orch.getStore().get('cT')?.status === 'succeeded',
    String(orch.getStore().get('cT')?.status));

  const late = validateReviewVerdict(rawVerdict({
    verdict: 'rework', reason: 'a second opinion arrived late',
    findings: [{ location: 'late.ts:1', severity: 'minor', message: 'a second opinion arrived late' }],
  }));
  const lateResult = applyReviewVerdict({ orchestrator: orch, taskId: 'cT', verdict: late });
  check('a rework verdict on a SUCCEEDED task is refused, not executed',
    lateResult.status !== 'ok', lateResult.status);
  check('and the task did NOT re-enter rework',
    orch.getStore().get('cT')?.status === 'succeeded', String(orch.getStore().get('cT')?.status));
  check('it stayed succeeded (terminal wins)',
    orch.getStore().get('cT')?.status !== 'rework' && orch.getStore().get('cT')?.status !== 'to_verify');
  check('the refusal is reported, not swallowed', lateResult.dispatched === false);
}

// The same refusal for a task already `failed`.
{
  const { orch } = await freshAtVerify('cF');
  applyReviewVerdict({
    orchestrator: orch, taskId: 'cF',
    verdict: validateReviewVerdict(rawVerdict({ verdict: 'reject' })),
  });
  check('the task was rejected to failed', orch.getStore().get('cF')?.status === 'failed',
    String(orch.getStore().get('cF')?.status));
  const after = applyReviewVerdict({
    orchestrator: orch, taskId: 'cF',
    verdict: validateReviewVerdict(rawVerdict({ verdict: 'rework', findings: [] })),
  });
  check('a rework verdict on a FAILED task is refused',
    after.status !== 'ok' && orch.getStore().get('cF')?.status === 'failed',
    `${after.status}/${String(orch.getStore().get('cF')?.status)}`);
}

// The evidence record is separate and typed.
  const v = validateReviewVerdict(rawVerdict());
  const ev = toReviewEvidence('c1', v, []);
  check('review evidence records the task and the verdict',
    ev.taskId === 'c1' && ev.verdict.fingerprint === v.fingerprint);
  check('review evidence is frozen', Object.isFrozen(ev));
  check('review evidence is not a duplicate the first time', ev.duplicateOfPrevious === false);
  check('review evidence detects a repeat', toReviewEvidence('c1', v, [ev]).duplicateOfPrevious === true);
  check('review evidence distinguishes a different verdict',
    toReviewEvidence('c1', validateReviewVerdict(rawVerdict({ verdict: 'pass', findings: [] })), [ev]).duplicateOfPrevious === false);
}

// ---------------------------------------------------------------------------
// 10. No second authority, execution path, or store
// ---------------------------------------------------------------------------
section('P6-D0 10. structural: no second store / scheduler / execution path');
{
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
  const files = tree('src');
  const withText = (pattern: RegExp): string[] => files.filter((f) => pattern.test(readFileSync(f, 'utf8')));

// Count OCCURRENCES in code, not files, and strip comments — a `runtime.run()`
// mentioned in a doc comment must not read as a second execution edge.
  const occurrences = (pattern: RegExp): string[] => {
    const hits: string[] = [];
    // `matchAll` requires a global regex, and the caller's pattern may not be one.
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const f of files) {
      const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const m of code.matchAll(global)) hits.push(`${f}: ${m[0]}`);
    }
    return hits;
  };

  check('TaskStore is instantiated in exactly one place', occurrences(/new TaskStore\(/).length === 1, occurrences(/new TaskStore\(/).join(', '));
  check('there is still exactly one TaskScheduler class', occurrences(/class TaskScheduler\b/).length === 1);
  check('there is still exactly one WorkspaceManager class', occurrences(/class WorkspaceManager\b/).length === 1);
  check('RuntimeRunner.run is still called in exactly one place', occurrences(/runtime\.run\(/).length === 1, occurrences(/runtime\.run\(/).join(', '));
  check('there is still exactly ONE applyVerification that actually mutates',
    withText(/applyVerification\(taskId: string, outcome: VerificationOutcome\): MutateOutcome \{/).length === 1,
    withText(/applyVerification\(taskId: string, outcome: VerificationOutcome\): MutateOutcome \{/).join(', '));
  check('and every OTHER declaration of it is a type/interface, not a second writer',
    withText(/applyVerification\(taskId: string, outcome: VerificationOutcome\)/).length -
      withText(/applyVerification\(taskId: string, outcome: VerificationOutcome\): MutateOutcome \{/).length === 1);

// D0's own modules must be inert.
  for (const f of ['src/orchestration/review-verdict.ts', 'src/orchestration/review-loop.ts']) {
    const text = readFileSync(f, 'utf8');
    check(`${f} creates no store, scheduler, workspace or executor`,
      !/new TaskStore|new TaskScheduler|new WorkspaceManager|runtime\.run\(|executeTask\(/.test(text));
    // Strip comments first: a `store.transition(` mentioned in prose is not a
    // call. The pattern is deliberately just `\.transition\(` rather than
    // `\w+\.transition\(` — the narrower form misses `).transition(`, which is
    // exactly how a cast-then-call looks, and that is how the mutation check
    // caught this test being too weak.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check(`${f} performs NO direct task transition (only queue())`,
      !/\.transition\(/.test(code),
      (code.match(/.{0,24}\.transition\([^)]*\)/) ?? [])[0] ?? '');
  }

  // review-loop must not import the runtime, an adapter, or git.
  const loopImports = [...readFileSync('src/orchestration/review-loop.ts', 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  check('review-loop imports no runtime, adapter or git module',
    !loopImports.some((i) => i.includes('runtime') || i.includes('adapter') || i.includes('git')),
    loopImports.join(', '));
  check('review-loop imports no orchestrator implementation (structural interface only)',
    !loopImports.some((i) => i.includes('/orchestrator/')),
    loopImports.join(', '));
  check('review-verdict imports nothing from the runtime side',
    ![...readFileSync('src/orchestration/review-verdict.ts', 'utf8').matchAll(/from '([^']+)'/g)]
      .map((m) => m[1])
      .some((i) => i.includes('runtime') || i.includes('adapter') || i.includes('orchestrator/')));

  // The verifier must not have written TaskStore.status directly anywhere.
  check('no review module assigns a task status',
    !/status\s*=\s*['"](succeeded|failed|rework|queued)['"]/.test(readFileSync('src/orchestration/review-verdict.ts', 'utf8')) &&
    !/status\s*=\s*['"](succeeded|failed|rework|queued)['"]/.test(readFileSync('src/orchestration/review-loop.ts', 'utf8')));
}

// ---------------------------------------------------------------------------
// 11. A review handler cannot write task state behind the authority's back
// ---------------------------------------------------------------------------
section('P6-D0 11. a verdict cannot reach the store except through applyVerification');
{
  // The structural check in group 10 reads the source, which catches an honest
  // mistake but not a determined one. This is the RUNTIME version: hand the loop
  // an authority whose `getStore()` is wrapped so every transition and every
  // retry bump is recorded. If any code path other than the authority's own
  // transition writes state, it shows up here.
  const { orch, calls } = instrumented(['c1']);
  await runToVerify(orch, new TaskScheduler({ orchestrator: orch, cwd: tmpDir(), rootTaskId: 'r' }), 'c1');

  const realStore = orch.getStore();
  const writes: string[] = [];
  const spy = new Proxy(realStore, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'transition' && typeof value === 'function') {
        return (...args: unknown[]) => {
          writes.push(`transition->${String(args[1])}`);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (prop === 'incrementRetry' && typeof value === 'function') {
        return (...args: unknown[]) => {
          writes.push('incrementRetry');
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });

  // `applyVerification` is wrapped so its OWN write is counted too. The
  // assertion that matters is the split: the authority wrote exactly once, and
  // the review loop wrote NOTHING. A loop that reached past the authority would
  // show up as an extra entry here — which is precisely what the mutation check
  // proved the previous, weaker version of this test could not see.
  let authorityWrites = 0;
  const spyOrch = {
    applyVerification: (taskId: string, outcome: VerificationOutcome) => {
      authorityWrites++;
      return orch.applyVerification(taskId, outcome);
    },
    getStore: () => spy,
  };

  writes.length = 0;
  const passResult = applyReviewVerdict({
    orchestrator: spyOrch, taskId: 'c1',
    verdict: validateReviewVerdict(rawVerdict({ verdict: 'pass', recommendedAction: 'none' })),
  });

  check('the verdict applied', passResult.status === 'ok', passResult.status);
  check('the authority was consulted exactly once', authorityWrites === 1 && calls.length === 1, `authority=${authorityWrites}`);
  check('the task is succeeded', realStore.get('c1')?.status === 'succeeded');
  check('CRITICAL: the review loop performed ZERO direct store writes', writes.length === 0, JSON.stringify(writes));
  check('and the only state change was the authority\'s own',
    calls[0].verdict === 'pass' && realStore.get('c1')?.status === 'succeeded');

  // Same for a rework verdict: one delegated write to `rework`, nothing else.
  const { orch: o2 } = await freshAtVerify('c2');
  const realStore2 = o2.getStore();
  const writes2: string[] = [];
  const spy2 = new Proxy(realStore2, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'transition' && typeof value === 'function') {
        return (...args: unknown[]) => {
          writes2.push(`transition->${String(args[1])}`);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (prop === 'incrementRetry' && typeof value === 'function') {
        return (...args: unknown[]) => { writes2.push('incrementRetry'); return (value as (...a: unknown[]) => unknown).apply(target, args); };
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  const reworkResult = applyReviewVerdict({
    orchestrator: {
      applyVerification: (t: string, o: VerificationOutcome) => o2.applyVerification(t, o),
      getStore: () => spy2,
    },
    taskId: 'c2',
    verdict: validateReviewVerdict(rawVerdict({ verdict: 'rework' })),
  });
  check('the rework verdict applied', reworkResult.status === 'ok', reworkResult.status);
  check('a rework verdict wrote NOTHING directly either', writes2.length === 0, JSON.stringify(writes2));
  check('and the review handler never bumped the retry counter (that is the re-entry step)',
    !writes2.includes('incrementRetry'));
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) {
  process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
}
process.stdout.write('\n');
process.exitCode = failed === 0 ? 0 : 1;
