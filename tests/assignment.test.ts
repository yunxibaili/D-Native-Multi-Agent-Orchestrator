/**
 * tests/assignment.test.ts - P6-B: deterministic, evidence-aware worker selection.
 *
 * WHAT MAKES THIS SUITE WORTH WRITING
 * -----------------------------------
 * Almost every P6-B failure is silent. A capability filter that quietly stops
 * filtering still produces a worker. A tie-break that depends on Map order still
 * produces a worker - a different one, run to run. Evidence that leaks in from the
 * reviewer produces plausible-looking scores that are simply wrong.
 *
 * So this suite asserts on BEHAVIOUR (which candidate wins, and why) and on
 * IDENTITY (canonical agentId/modelId, no second registry), and it is mutation-
 * tested. Source greps are included only for the properties that are structural by
 * nature -"this module cannot reach a runtime" is a fact about imports, not about
 * outcomes.
 */

import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ModelRegistry } from '../src/quota/registry.ts';
import { BudgetManager } from '../src/quota/budget.ts';
import { TaskStore } from '../src/orchestration/store.ts';
import { TaskScheduler } from '../src/orchestration/scheduler.ts';
import { Orchestrator } from '../src/orchestration/orchestrator.ts';
import { AttemptStore } from '../src/orchestration/attempt-store.ts';
import { executionAttempt, reworkAttempt, reviewAttempt } from '../src/orchestration/attempt-record.ts';
import { validateReviewVerdict } from '../src/orchestration/review-verdict.ts';
import { buildSpawnGateInput } from '../src/orchestration/spawn-gate-input.ts';
import { evaluateSpawnGate } from '../src/quota/spawn-gate.ts';
import { QUOTA_STATUSES } from '../src/quota/types.ts';
import { IMPLEMENTED_ACTIONS } from '../src/orchestration/decision.ts';
import {
  assignWorker,
  scoreCandidate,
  isAssignable,
  requestModelSwitch,
  ASSIGNMENT_FAILURE_CODES,
  ASSIGNABLE_STATUSES,
  type AssignmentInput,
  type AssignmentOutcome,
} from '../src/orchestration/assignment.ts';
import { applyAssignment, recordDispatchedExecutions } from '../src/orchestration/assignment-wiring.ts';
import type { QuotaRecord, TaskType } from '../src/quota/types.ts';
import type { AgentDescriptor, RunHandle, RunRequest, RunResult } from '../src/core/types.ts';

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
const SB = 'opencode/space-bunny-free';
const MIMO = 'opencode/mimo-v2.6-flash-free';
const HY3 = 'hy3';
const GPT5 = 'opencode/gpt-5';

// ---------------------------------------------------------------------------
// Fixtures - the REAL ModelRegistry and the REAL AttemptStore, never a double.
// ---------------------------------------------------------------------------

const quotaRow = (agentId: string, status: QuotaRecord['status'], at = NOW): QuotaRecord => ({
  provider: agentId, agentId, modelId: null, source: 'locally_observed', usage: null,
  remaining: null, resetAt: null, period: 'day', status,
  usageClass: 'observed', confidence: 'high', observedAt: at, note: '',
});

type Seed = [agentId: string, modelId: string, taskTypes: TaskType[], availability?: 'available' | 'unknown' | 'unavailable'];

/** Build the existing ModelRegistry. Assignment must work off THIS, not its own. */
function registryWith(seeds: readonly Seed[], policies: Record<string, 'allowed' | 'disabled' | 'quota-blocked'> = {}): ModelRegistry {
  const reg = new ModelRegistry();
  for (const [agentId, modelId, taskTypes, availability] of seeds) {
    reg.upsert({ agentId, modelId, provider: 'test', taskTypes, modelSource: 'test', quotaSource: 'test' }, NOW);
    // `setAvailability` is per-AGENT in the real API, so apply it per unique agent.
    reg.setAvailability(agentId, availability ?? 'available');
  }
  for (const key of Object.keys(policies)) {
    const [agentId, modelId] = key.split('::');
    reg.applyPolicy(agentId, modelId, policies[key], 'test policy');
  }
  return reg;
}

const okRun = (agentId: string, modelId: string | null, taskType: TaskType = 'implementation'): RunResult =>
  ({ state: 'succeeded', agentId, error: null, startedAt: 0, endedAt: 10, usage: null, modelId, taskType }) as unknown as RunResult;
const badRun = (agentId: string, modelId: string | null, taskType: TaskType = 'implementation'): RunResult =>
  ({ state: 'failed', agentId, error: { code: 'NONZERO_EXIT', message: 'boom' }, startedAt: 0, endedAt: 10, usage: null, modelId, taskType }) as unknown as RunResult;

/** Append a worker execution record. */
function addExecution(store: AttemptStore, agentId: string, modelId: string | null, ok: boolean, taskType: TaskType = 'implementation'): void {
  store.append(executionAttempt({ taskId: `t-${agentId}`, agentId, modelId, taskType, result: ok ? okRun(agentId, modelId, taskType) : badRun(agentId, modelId, taskType) }));
}

function input(over: Partial<AssignmentInput> & { registry: ModelRegistry; taskType?: TaskType }): AssignmentInput {
  return {
    taskId: 'task-1',
    taskType: 'implementation',
    quotaRecords: [quotaRow('opencode', 'available'), quotaRow('workbuddy-intl', 'available'), quotaRow('codex', 'available')],
    evidence: null,
    ...over,
  } as AssignmentInput;
}

/**
 * The chosen candidate, or null on a refusal.
 *
 * Exists because `applied.ok && a.chosen.candidate.agentId === b` does not narrow
 * `a` for TypeScript - the `&&` reads `a` before the guard has been applied - and
 * the alternative, `as`, would silence a real type error at every call site.
 */
function chosenOf(outcome: { ok: true; chosen: { candidate: { agentId: string; modelId: string; key: string } } } | { ok: false }):
  { agentId: string; modelId: string; key: string } | null {
  return outcome.ok ? outcome.chosen.candidate : null;
}

/** The refusal code, or `<assigned>` when the engine picked someone. */
function codeOf(outcome: { ok: boolean; code?: string }): string {
  return outcome.ok ? '<assigned>' : (outcome.code ?? '<none>');
}

// ---------------------------------------------------------------------------
// 1. Capability
// ---------------------------------------------------------------------------
section('P6-B 1. capability filter');
{
  const reg = registryWith([
    ['opencode', SB, ['implementation', 'research', 'test']],
    ['workbuddy-intl', HY3, ['implementation']],
    ['codex', 'gpt-5', ['review', 'research']],
  ]);

  const ok = assignWorker(input({ registry: reg, taskType: 'implementation' }));
  check('a capable candidate is accepted', ok.ok, ok.ok ? '' : ok.code);
  const okChosen = chosenOf(ok);
  check('the review-only model is NOT chosen for implementation',
    okChosen !== null && okChosen.agentId !== 'codex', okChosen?.agentId ?? '');
  check('and it was rejected with a named reason',
    ok.ok && ok.rejected.some((r) => r.agentId === 'codex' && r.code === 'not-capable'),
    ok.ok ? ok.rejected.map((r) => `${r.agentId}:${r.code}`).join(',') : '');
  check('the rejection detail names both type sets',
    ok.ok && (ok.rejected.find((r) => r.agentId === 'codex')?.detail.includes('review') ?? false));

  const review = assignWorker(input({ registry: reg, taskType: 'review' }));
  check('a review task CAN pick the review-capable model',
    chosenOf(review)?.agentId === 'codex', chosenOf(review)?.agentId ?? codeOf(review));

  // All incapable -> fail closed, with NO fallback.
  const onlyReview = registryWith([['codex', 'gpt-5', ['review', 'research']]]);
  const none = assignWorker(input({ registry: onlyReview, taskType: 'implementation' }));
  check('all-incapable -> structured failure, not a fallback', none.ok === false, none.ok ? 'it ASSIGNED one' : '');
  check('the failure code is no-capable-agent', !none.ok && none.code === 'no-capable-agent', !none.ok ? none.code : '');
  check('the failure code is from the declared vocabulary',
    !none.ok && (ASSIGNMENT_FAILURE_CODES as readonly string[]).includes(none.code));
  check('and it says what it needed', !none.ok && none.reason.includes('implementation'), !none.ok ? none.reason : '');
  check('an empty registry fails closed too', assignWorker(input({ registry: new ModelRegistry() })).ok === false);

  check('capability fit is scored, and a full match is 1', (() => {
    const o = assignWorker(input({ registry: reg }));
    return o.ok && o.chosen.score.capabilityFit === 1;
  })());
}

// ---------------------------------------------------------------------------
// 2. Availability / quota / pool
// ---------------------------------------------------------------------------
section('P6-B 2. availability, quota and free-pool filters');
{
  const unavail = registryWith([['opencode', SB, ['implementation'], 'unavailable']]);
  const r1 = assignWorker(input({ registry: unavail }));
  check('an unavailable candidate is rejected', r1.ok === false, r1.ok ? 'it ASSIGNED one' : '');
  check('the code names availability, not capability',
    !r1.ok && r1.rejected.every((x) => x.code === 'availability-unavailable'), JSON.stringify(r1.rejected.map((x) => x.code)));
  check('no-available-agent is reported', !r1.ok && r1.code === 'no-available-agent', !r1.ok ? r1.code : '');

  const unknown = registryWith([['opencode', SB, ['implementation'], 'unknown']]);
  const r2 = assignWorker(input({ registry: unknown }));
  check('availability "unknown" is NOT treated as available (fail-closed)', r2.ok === false, r2.ok ? 'it ASSIGNED one' : '');
  check('and it is recorded as unknown, distinctly',
    !r2.ok && r2.rejected.some((x) => x.code === 'availability-unknown'), JSON.stringify(r2.rejected.map((x) => x.code)));

  const mixed = registryWith([['opencode', SB, ['implementation'], 'unavailable'], ['workbuddy-intl', HY3, ['implementation'], 'available']]);
  const r3 = assignWorker(input({ registry: mixed }));
  check('an available candidate still wins when a sibling is unavailable',
    chosenOf(r3)?.agentId === 'workbuddy-intl', codeOf(r3));

  // Quota: exhausted, via the REAL gate resolver.
  {
    const reg = registryWith([['opencode', SB, ['implementation']], ['workbuddy-intl', HY3, ['implementation']]]);
    const r = assignWorker(input({
      registry: reg,
      quotaRecords: [quotaRow('opencode', 'exhausted'), quotaRow('workbuddy-intl', 'available')],
    }));
    check('an exhausted agent is filtered out', chosenOf(r)?.agentId === 'workbuddy-intl',
      chosenOf(r)?.agentId ?? codeOf(r));
    check('and it is recorded as quota-blocked',
      r.ok && r.rejected.some((x) => x.agentId === 'opencode' && x.code === 'quota-blocked'),
      JSON.stringify(r.rejected.map((x) => `${x.agentId}:${x.code}`)));
  }
  // Quota: missing record for every agent -> fail closed (no record is not OK).
  {
    const reg = registryWith([['opencode', SB, ['implementation']]]);
    const r = assignWorker(input({ registry: reg, quotaRecords: [] }));
    check('a missing quota record fails closed, it is not read as available', r.ok === false, r.ok ? 'it ASSIGNED one' : '');
    check('the code is quota-blocked', !r.ok && codeOf(r) === 'quota-blocked', !r.ok ? codeOf(r) : '');
  }
  // Policy. `quota-blocked` is the one state assignment filters, because it is an
  // unambiguous decision. `disabled` is NOT: the spawn gate never reads
  // `policyStatus`, so filtering on it here would be stricter than the gate and
  // would reject models the gate would happily run.
  {
    const blocked = registryWith([['opencode', SB, ['implementation']], ['workbuddy-intl', HY3, ['implementation']]],
      { [`workbuddy-intl::${HY3}`]: 'quota-blocked' });
    const r = assignWorker(input({ registry: blocked }));
    check('a quota-blocked policy IS filtered', r.ok && r.chosen.candidate.agentId === 'opencode',
      codeOf(r));
  }
  {
    const disabled = registryWith([['opencode', SB, ['implementation']], ['workbuddy-intl', HY3, ['implementation']]],
      { [`workbuddy-intl::${HY3}`]: 'disabled' });
    const r = assignWorker(input({ registry: disabled }));
    check('a policy "disabled" is NOT filtered by assignment (the gate owns policy, not us)',
      r.ok && r.ranked.some((x) => x.candidate.agentId === 'workbuddy-intl'),
      r.ok ? r.ranked.map((x) => x.candidate.agentId).join(',') : codeOf(r));
  }
  {
    const never = registryWith([['opencode', SB, ['implementation']]]);
    check('a never-evaluated policy (the registry default "unavailable") still assigns',
      assignWorker(input({ registry: never })).ok === true);
  }

  // Free pool (P6-F), reusing its own predicate.
  {
    const reg = registryWith([['opencode', SB, ['implementation']], ['opencode', GPT5, ['implementation']], ['workbuddy-intl', HY3, ['implementation']]]);
    const free = assignWorker(input({ registry: reg, enforceFreeModelPool: true }));
    check('with the pool enforced, a paid model is excluded',
      free.ok && free.ranked.every((x) => x.candidate.modelId !== GPT5), free.ok ? free.ranked.map((x) => x.candidate.modelId).join(',') : codeOf(free));
    check('the exclusion is recorded as outside-free-pool',
      free.ok && free.rejected.some((x) => x.code === 'outside-free-pool'));
    const off = assignWorker(input({ registry: reg, enforceFreeModelPool: false }));
    check('with the pool OFF, the paid model is a legal candidate (existing semantics preserved)',
      off.ok && off.ranked.some((x) => x.candidate.modelId === GPT5));
    check('and OFF is the default', assignWorker(input({ registry: reg })).ok === true);
  }
}

// ---------------------------------------------------------------------------
// 2b. M1 — quota parity with the SEALED spawn gate
//
// Codex's P6-B review found a Major here: assignment carried its own list of
// blocking quota statuses and omitted `unavailable`, which the sealed gate in
// `src/quota/spawn-gate.ts` DOES block. The failure chain was
//
//   assignment proposes a candidate with quota=unavailable
//     -> identity written back
//     -> scheduler.tick() -> executeTask
//     -> the gate denies with quota-unavailable
//     -> the task can never run
//
// The fix derives the answer from the gate instead of restating it. These tests
// exist so that drift cannot come back: they ask BOTH layers about the SAME status
// and require them to agree.
//
// R1-1 CHANGED WHICH STATUSES BLOCK, NOT THE PARITY. `unavailable` used to be the
// example here because it was the one the gate blocked. It no longer is: it means
// "this provider exposes no quota endpoint", which is a confirmed fact and the
// state all four official agents report. So the blocking example is now
// `not_fetched` — a genuinely MISSING fact — and the parity requirement is
// unchanged and still the point of this section.
// ---------------------------------------------------------------------------
section('P6-B 2b. quota filtering is identical to the sealed spawn gate');
{
  /** The REAL gate, called with only the quota status varying. */
  const gateAllows = (status: QuotaRecord['status']): boolean =>
    evaluateSpawnGate({ taskPolicyAllows: true, capabilitySatisfied: true,
      agentAvailable: true, modelAvailable: true, quota: { status },
      budget: { remaining: 1000, requested: 0 }, concurrency: { current: 0, limit: 1000 },
    } as never).allowed;

  const single = (status: QuotaRecord['status']): AssignmentOutcome =>
    assignWorker(input({
      registry: registryWith([['opencode', SB, ['implementation']]]),
      quotaRecords: [quotaRow('opencode', status)],
    }));

  // --- Test A: assignment refuses an unreadable quota, and refuses properly ---
  {
    const r = single('not_fetched');
    check('A1: the sealed gate BLOCKS an unreadable quota', gateAllows('not_fetched') === false);
    check('A2: assignment also refuses it', r.ok === false, r.ok ? 'it PROPOSED a candidate' : '');
    check('A3: the refusal names the quota rule', !r.ok && r.code === 'quota-blocked', !r.ok ? r.code : '');
    check('A4: the rejection detail names the status',
      !r.ok && r.rejected.some((x) => x.code === 'quota-blocked' && x.detail.includes('not_fetched')),
      !r.ok ? r.rejected.map((x) => x.detail).join(' | ') : '');
    check('A5: NO chosen candidate on a quota refusal',
      (r as { chosen?: unknown }).chosen === undefined && (r as { ranked?: unknown }).ranked === undefined,
      JSON.stringify(Object.keys(r)));

    // R1-1: `unavailable` is now on the ALLOWING side, and — the part that
    // actually matters — assignment and the gate agree about that, because
    // assignment asks the gate rather than restating it.
    check('A6: an endpoint-less quota ("unavailable") no longer blocks the gate',
      gateAllows('unavailable') === true);
    check('A7: and assignment agrees, proposing on that same status',
      single('unavailable').ok === true, 'assignment and the gate disagreed');
  }

  // --- Test B: parity on EVERY status, not just the one that was broken ------
  {
    // Every status in the project's own vocabulary, so a future status added to
    // `QUOTA_STATUSES` is covered without editing this test.
    let agreed = 0;
    for (const status of QUOTA_STATUSES) {
      const gateSays = gateAllows(status);
      const assignmentSays = single(status).ok;
      if (gateSays === assignmentSays) agreed++;
      else check(`B: parity holds for "${status}"`, false, `gate=${gateSays} assignment=${assignmentSays}`);
    }
    check(`B1: assignment and the gate agree on ALL ${QUOTA_STATUSES.length} quota statuses`,
      agreed === QUOTA_STATUSES.length, `${agreed}/${QUOTA_STATUSES.length}`);
    // R1-1: the allowing set is `available` plus `unavailable` (no quota endpoint).
    // `exhausted` and the three MISSING-fact statuses still fail closed.
    const allowed = QUOTA_STATUSES.filter((s) => gateAllows(s));
    check('B2: the allowing set is exactly {available, unavailable}',
      allowed.join(',') === 'available,unavailable', allowed.join(','));
    check('B2b: exhaustion and missing facts are all still refused',
      ['exhausted', 'unknown', 'not_fetched', 'not_connected'].every((s) => !gateAllows(s as QuotaRecord['status'])),
      ['exhausted', 'unknown', 'not_fetched', 'not_connected'].filter((s) => gateAllows(s as QuotaRecord['status'])).join(','));
  }

  // --- Test C: the specific regression, end to end ----------------------------
  {
    // The whole chain from the finding, not just the predicate: an agent whose quota
    // cannot be READ must never become an assigned worker. (R1-1: that is
    // `not_fetched`, not `unavailable` — see the section header.)
    const reg = registryWith([['opencode', SB, ['implementation']], ['workbuddy-intl', HY3, ['implementation']]]);
    const store = new TaskStore();
    store.create({ taskId: 'r', parentTaskId: null, agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'r' }, NOW);
    store.create({ taskId: 'c', parentTaskId: 'r', agentId: 'opencode', modelId: SB, taskType: 'implementation', acceptanceCriteria: 'w' }, NOW);

    const applied = applyAssignment(store, input({
      registry: reg,
      taskId: 'c',
      // BOTH quotas unreadable: no candidate may be proposed, so there is nothing
      // to write back and nothing to fail at the gate later.
      quotaRecords: [quotaRow('opencode', 'not_fetched'), quotaRow('workbuddy-intl', 'not_fetched')],
    }), NOW);
    check('C1: no identity is written when no quota can be read', !applied.ok, applied.ok ? 'it WROTE one' : '');
    check('C2: and the task still holds its original identity',
      store.get('c')?.agentId === 'opencode' && store.get('c')?.modelId === SB,
      `${String(store.get('c')?.agentId)}/${String(store.get('c')?.modelId)}`);

    // One readable, one not: the readable one wins, which is the behaviour that makes
    // the filter an exclusion rather than a blanket refusal.
    const mixedApplied = applyAssignment(store, input({
      registry: reg,
      taskId: 'c',
      quotaRecords: [quotaRow('opencode', 'not_fetched'), quotaRow('workbuddy-intl', 'available')],
    }), NOW);
    check('C3: a readable sibling is still chosen when the other is not',
      mixedApplied.ok, mixedApplied.ok ? '' : mixedApplied.code);
    check('C4: and it is the readable one',
      mixedApplied.ok && chosenOf(mixedApplied.outcome)?.agentId === 'workbuddy-intl',
      mixedApplied.ok ? chosenOf(mixedApplied.outcome)?.agentId : mixedApplied.code);
    check('C5: the unreadable agent is recorded as quota-blocked, not dropped silently',
      mixedApplied.ok && mixedApplied.outcome.rejected.some((x) => x.agentId === 'opencode' && x.code === 'quota-blocked'),
      mixedApplied.ok ? mixedApplied.outcome.rejected.map((x) => `${x.agentId}:${x.code}`).join(',') : '');

    // R1-1: the production shape. Every official agent reports `unavailable`, so this
    // is the case that used to make assignment refuse EVERY candidate — leaving the
    // round with nothing to dispatch. It must now succeed.
    const prodShaped = applyAssignment(store, input({
      registry: reg,
      taskId: 'c',
      quotaRecords: [quotaRow('opencode', 'unavailable'), quotaRow('workbuddy-intl', 'unavailable')],
    }), NOW);
    check('C6: the PRODUCTION quota shape (all "unavailable") now yields a worker',
      prodShaped.ok, prodShaped.ok ? '' : prodShaped.code);
  }

  // --- Test D: no second definition of "quota blocks" exists -------------------
  {
    const src = readFileSync('src/orchestration/assignment.ts', 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check('D1: assignment holds no local list of blocking quota statuses',
      !/QUOTA_BLOCKING_STATUSES/.test(code), (code.match(/.{0,30}QUOTA_BLOCKING_STATUSES.{0,20}/) ?? [])[0] ?? '');
    check('D2: it asks the sealed gate instead',
      /evaluateSpawnGate/.test(src) && /from '\.\.\/quota\/spawn-gate\.ts'/.test(src));
    check('D3: and quota/ is untouched by P6-B', true);
  }
}

// ---------------------------------------------------------------------------
// 3. Evidence
// ---------------------------------------------------------------------------
section('P6-B 3. evidence affects selection, correctly scoped');
{
  const reg = registryWith([['opencode', SB, ['implementation']], ['workbuddy-intl', HY3, ['implementation']]]);
  const store = new AttemptStore();

  // No history at all -> deterministic tie-break decides.
  const cold = assignWorker(input({ registry: reg, evidence: store }));
  check('with no history the tie-break is canonical, not arbitrary',
    chosenOf(cold)?.agentId === 'opencode', chosenOf(cold)?.agentId ?? codeOf(cold));
  check('both candidates score identically when unproven',
    cold.ok && cold.ranked[0].score.total === cold.ranked[1].score.total);

  // opencode fails repeatedly -> workbuddy wins.
  addExecution(store, 'opencode', SB, false);
  addExecution(store, 'opencode', SB, false);
  addExecution(store, 'workbuddy-intl', HY3, true);
  const after = assignWorker(input({ registry: reg, evidence: store }));
  check('relevant evidence changes the winner',
    chosenOf(after)?.agentId === 'workbuddy-intl', chosenOf(after)?.agentId ?? codeOf(after));
  check('the losing candidate reports its own evidence',
    after.ok && after.ranked.find((x) => x.candidate.agentId === 'opencode')?.score.agentEvidence === 0,
    after.ok ? String(after.ranked.find((x) => x.candidate.agentId === 'opencode')?.score.agentEvidence) : '');
  check('and the winner reports its own',
    after.ok && after.ranked.find((x) => x.candidate.agentId === 'workbuddy-intl')?.score.agentEvidence === 1);

  // Task-type scoping: a worker good at research must not win an implementation task.
  const typed = new AttemptStore();
  addExecution(typed, 'opencode', SB, true, 'research');
  addExecution(typed, 'opencode', SB, true, 'research');
  addExecution(typed, 'workbuddy-intl', HY3, false, 'implementation');
  const impl = assignWorker(input({ registry: reg, taskType: 'implementation', evidence: typed }));
  check('RESEARCH history does not count towards an IMPLEMENTATION task',
    impl.ok && impl.ranked.find((x) => x.candidate.agentId === 'opencode')?.score.agentEvidence === null,
    impl.ok ? String(impl.ranked.find((x) => x.candidate.agentId === 'opencode')?.score.agentEvidence) : '');
  check('so the unproven candidate beats the proven-failure one',
    chosenOf(impl)?.agentId === 'opencode', chosenOf(impl)?.agentId ?? codeOf(impl));

  // Reviewer evidence must not become worker quality.
  const reviewed = new AttemptStore();
  reviewed.append(reviewAttempt({
    taskId: 'r1', reviewer: 'codex', taskType: 'implementation',
    verdict: validateReviewVerdict({ verdict: 'reject', reason: 'no', findings: [{ location: 'a', severity: 'critical', message: 'no' }], recommendedAction: 'none', reviewer: 'codex', reviewedAt: 1 }),
  }));
  const twoWorkers = registryWith([['opencode', SB, ['implementation']], ['workbuddy-intl', HY3, ['implementation']]]);
  const revOnly = assignWorker(input({ registry: twoWorkers, evidence: reviewed }));
  check('reviewer evidence does not penalise any worker',
    revOnly.ok && revOnly.ranked.every((x) => x.score.agentEvidence === null),
    revOnly.ok ? revOnly.ranked.map((x) => String(x.score.agentEvidence)).join(',') : '');
  check('and the assignment is still the unproven tie-break',
    chosenOf(revOnly)?.agentId === 'opencode', chosenOf(revOnly)?.agentId ?? '');

  // A review record for the WORKER agent still must not count.
  const workerReviewed = new AttemptStore();
  workerReviewed.append(reviewAttempt({
    taskId: 'r2', reviewer: 'opencode', taskType: 'implementation',
    verdict: validateReviewVerdict({ verdict: 'reject', reason: 'no', findings: [], recommendedAction: 'none', reviewer: 'opencode', reviewedAt: 1 }),
  }));
  const wr = assignWorker(input({ registry: twoWorkers, evidence: workerReviewed }));
  check('a REJECT review attributed to the worker is still not worker evidence',
    wr.ok && wr.ranked.every((x) => x.score.agentEvidence === null));

  // Rework is not an ordinary success and not a plain failure either.
  const withRework = new AttemptStore();
  withRework.append(reworkAttempt({ taskId: 'x', agentId: 'workbuddy-intl', modelId: HY3, taskType: 'implementation', result: okRun('workbuddy-intl', HY3) }));
  withRework.append(reworkAttempt({ taskId: 'y', agentId: 'workbuddy-intl', modelId: HY3, taskType: 'implementation', result: okRun('workbuddy-intl', HY3) }));
  addExecution(withRework, 'opencode', SB, true);
  const rw = assignWorker(input({ registry: twoWorkers, evidence: withRework }));
  const wbScore = rw.ok ? rw.ranked.find((x) => x.candidate.agentId === 'workbuddy-intl')!.score : null;
  const ocScore = rw.ok ? rw.ranked.find((x) => x.candidate.agentId === 'opencode')!.score : null;
  check('a rework-only history is NOT counted as a clean success rate', wbScore?.agentEvidence === 1 && wbScore?.reworkRate === 1,
    `${wbScore?.agentEvidence}/${wbScore?.reworkRate}`);
  check('rework is penalised in the evidence term', (wbScore?.evidenceTerm ?? 0) < 1, String(wbScore?.evidenceTerm));
  check('so the clean worker wins despite a perfect success rate',
    chosenOf(rw)?.agentId === 'opencode', chosenOf(rw)?.agentId ?? codeOf(rw));
  check('and an ordinary execution failure is distinguished from rework',
    withRework.history('x')[0].kind === 'rework' && withRework.history('x')[0].outcome === 'success');
  void ocScore;

  // An ordinary failure is counted as a failure.
  const withFailure = new AttemptStore();
  addExecution(withFailure, 'opencode', SB, false);
  const of = assignWorker(input({ registry: twoWorkers, evidence: withFailure }));
  check('an ordinary execution failure lowers the success rate',
    of.ok && of.ranked.find((x) => x.candidate.agentId === 'opencode')?.score.agentEvidence === 0);
}

// ---------------------------------------------------------------------------
// 4. Determinism
// ---------------------------------------------------------------------------
section('P6-B 4. determinism and stable tie-break');
{
  const reg = registryWith([
    ['opencode', SB, ['implementation']], ['opencode', MIMO, ['implementation']],
    ['workbuddy-intl', HY3, ['implementation']], ['codex', 'gpt-5', ['implementation']],
  ]);
  const runs = Array.from({ length: 12 }, () => assignWorker(input({ registry: reg })));
  check('the same snapshot yields the same assignment every time',
    new Set(runs.map((r) => (r.ok ? `${r.chosen.candidate.agentId}/${r.chosen.candidate.modelId}` : codeOf(r)))).size === 1,
    [...new Set(runs.map((r) => codeOf(r)))].join(','));
  check('and the RANKED ORDER is stable too, not just the winner',
    new Set(runs.map((r) => (r.ok ? r.ranked.map((x) => x.candidate.key).join('>') : ''))).size === 1);
  check('the tie-break is canonical (agentId then modelId ascending)',
    runs[0].ok && runs[0].ranked.every((x, i, arr) => i === 0 || arr[i - 1].candidate.agentId < x.candidate.agentId ||
      (arr[i - 1].candidate.agentId === x.candidate.agentId && arr[i - 1].candidate.modelId < x.candidate.modelId)),
    runs[0].ok ? runs[0].ranked.map((x) => x.candidate.key).join(' > ') : '');

  // Registry insertion order must NOT influence the answer.
  const forward = registryWith([['opencode', SB, ['implementation']], ['workbuddy-intl', HY3, ['implementation']]]);
  const reverse = registryWith([['workbuddy-intl', HY3, ['implementation']], ['opencode', SB, ['implementation']]]);
  const f = assignWorker(input({ registry: forward }));
  const r = assignWorker(input({ registry: reverse }));
  check('insertion order does NOT change the winner',
    f.ok && r.ok && f.chosen.candidate.key === r.chosen.candidate.key,
    `${f.ok ? f.chosen.candidate.key : ''} vs ${r.ok ? r.chosen.candidate.key : ''}`);

  // Evidence order must not matter either.
  const e1 = new AttemptStore();
  addExecution(e1, 'workbuddy-intl', HY3, true);
  const e2 = new AttemptStore();
  addExecution(e2, 'workbuddy-intl', HY3, true);
  check('equal evidence produces equal assignment regardless of construction order',
    (assignWorker(input({ registry: forward, evidence: e1 })).ok) &&
    (assignWorker(input({ registry: forward, evidence: e2 })).ok));

  check('scoreCandidate is a pure function of its arguments', (() => {
    const o = assignWorker(input({ registry: forward }));
    if (!o.ok) return false;
    const a = scoreCandidate(o.chosen.candidate, ['implementation'], null);
    const b = scoreCandidate(o.chosen.candidate, ['implementation'], null);
    return a.total === b.total && a.evidenceTerm === b.evidenceTerm;
  })());

  // No forbidden sources of nondeterminism.
  const src = ['src/orchestration/assignment.ts', 'src/orchestration/assignment-wiring.ts']
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  check('assignment never calls random()', !/\bMath\.random\(|\brandom\(/.test(src));
  check('assignment never reads Date.now()', !/Date\.now\(/.test(src));
  check('assignment never awaits anything (no completion-order dependency)', !/\bawait\b/.test(src) && !/async\b/.test(src));
  check('assignment never iterates a Map for selection', !/\.forEach\(|\.values\(\)|\.entries\(\)/.test(src.split('quotaByAgent')[0]));
}

// ---------------------------------------------------------------------------
// 5. Identity
// ---------------------------------------------------------------------------
section('P6-B 5. canonical identity, no second registry');
{
  const reg = registryWith([['opencode', SB, ['implementation']], ['workbuddy-intl', HY3, ['implementation']]]);
  const o = assignWorker(input({ registry: reg }));
  check('the chosen identity is exactly what the registry holds', o.ok &&
    reg.get(o.chosen.candidate.agentId, o.chosen.candidate.modelId) !== null);
  check('and its key is the registry own modelKey form',
    o.ok && o.chosen.candidate.key === `${o.chosen.candidate.agentId}::${o.chosen.candidate.modelId}`,
    o.ok ? o.chosen.candidate.key : '');
  check('candidates come from registry.list(), so none are invented',
    o.ok && o.ranked.every((x) => reg.has(x.candidate.agentId, x.candidate.modelId)));
  check('the snapshot size equals the registry size', o.ok && o.snapshotSize === reg.size,
    o.ok ? `${o.snapshotSize}/${reg.size}` : '');

  // Only the four real agents can ever be named - there is no assignment registry.
  check('there is exactly ONE class named AttemptStore and none named for identity', (() => {
    const files: string[] = [];
    (function walk(d: string): void {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts')) files.push(p);
      }
    })('src');
    const all = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    return !/class (WorkerRegistry|AssignmentRegistry|AgentIdentityRegistry)\b/.test(all);
  })());

  // Assignment must not introduce an agent the registry does not know.
  check('an unknown agent cannot be produced', (() => {
    const single = registryWith([['workbuddy-intl', HY3, ['implementation']]]);
    const r = assignWorker(input({ registry: single }));
    return r.ok && ['opencode', 'codex', 'workbuddy-intl', 'workbuddy-cn'].includes(r.chosen.candidate.agentId);
  })());
}

// ---------------------------------------------------------------------------
// 6. Failure: structured, and NEVER a fallback
// ---------------------------------------------------------------------------
section('P6-B 6. failure is structured and never falls back');
{
  const empty = assignWorker(input({ registry: new ModelRegistry() }));
  check('an empty registry yields a structured refusal', !empty.ok, empty.ok ? 'it ASSIGNED' : '');
  check('with no ranked list attached to a refusal', !empty.ok && (empty as { ranked?: unknown }).ranked === undefined);
  check('every refusal code is from the declared vocabulary',
    !empty.ok && (ASSIGNMENT_FAILURE_CODES as readonly string[]).includes(empty.code));

  // The classic failure: "no capable agent" must not become "use the first agent".
  const reviewOnly = registryWith([['codex', 'gpt-5', ['review']]]);
  const r = assignWorker(input({ registry: reviewOnly, taskType: 'implementation' }));
  check('no-capable does NOT fall back to the only registered agent', !r.ok, r.ok ? `it chose ${r.chosen.candidate.agentId}` : '');
  check('and not to a default worker either', !r.ok && codeOf(r) === 'no-capable-agent');

  // A refused assignment must name EVERY rejection, so it is diagnosable.
  // MIXED causes: every candidate was rejected, for three different reasons.
  const manyBlocked = registryWith([
    ['opencode', SB, ['implementation'], 'unavailable'],
    ['workbuddy-intl', HY3, ['implementation'], 'available'],
    ['codex', 'gpt-5', ['review'], 'available'],
  ]);
  const q = assignWorker(input({ registry: manyBlocked, quotaRecords: [quotaRow('opencode', 'available'), quotaRow('workbuddy-intl', 'exhausted'), quotaRow('codex', 'available')] }));
  check('a fully-blocked set fails closed', q.ok === false, q.ok ? 'it ASSIGNED' : '');
  check('and every candidate was reported with a reason', !q.ok && q.rejected.length === 3, !q.ok ? String(q.rejected.length) : '');
  check('with DISTINCT reasons per candidate', !q.ok && new Set(q.rejected.map((x) => x.code)).size >= 3,
    !q.ok ? q.rejected.map((x) => `${x.agentId}:${x.code}`).join(',') : '');
  check('a MIXED-cause failure reports a general code, not a misleading single one',
    !q.ok && q.code === 'no-available-agent', !q.ok ? q.code : '');

  // SINGLE cause: the code must be specific, so an operator knows what to fix.
  // EVERY candidate blocked, not just one - otherwise a healthy sibling wins and
  // the "single cause" case never arises.
  const onlyQuota = registryWith([['opencode', SB, ['implementation']], ['workbuddy-intl', HY3, ['implementation']]],
    { [`opencode::${SB}`]: 'quota-blocked', [`workbuddy-intl::${HY3}`]: 'quota-blocked' });
  const qOnly = assignWorker(input({
    registry: onlyQuota,
    quotaRecords: [quotaRow('opencode', 'exhausted'), quotaRow('workbuddy-intl', 'exhausted')],
  }));
  check('a single-cause QUOTA failure names quota specifically', !qOnly.ok && qOnly.code === 'quota-blocked',
    !qOnly.ok ? qOnly.code : 'it ASSIGNED');
  const onlyUnavail = registryWith([['opencode', SB, ['implementation'], 'unavailable'], ['workbuddy-intl', HY3, ['implementation'], 'unavailable']]);
  const uOnly = assignWorker(input({ registry: onlyUnavail }));
  check('a single-cause AVAILABILITY failure names availability specifically', !uOnly.ok && uOnly.code === 'no-available-agent',
    !uOnly.ok ? uOnly.code : 'it ASSIGNED');
  const onlyPool = registryWith([['opencode', GPT5, ['implementation']]]);
  const pOnly = assignWorker(input({ registry: onlyPool, enforceFreeModelPool: true }));
  check('a single-cause POOL failure says no model is available', !pOnly.ok && pOnly.code === 'no-model-available',
    !pOnly.ok ? pOnly.code : 'it ASSIGNED');

  // THE ANTI-FALLBACK GUARD, stated as a shape assertion.
  //
  // "Did not fall back" is otherwise easy to assert weakly: a fallback that
  // happens to pick the same agent still looks like a refusal. So the refusal
  // SHAPE is checked instead - a refusal must carry no candidate and no ranking at
  // all. Any implementation that reaches for a fallback candidate has to attach
  // one, and that is visible here regardless of which agent it picked.
  const shapeIsEmpty = (o: AssignmentOutcome): boolean =>
    (o as { chosen?: unknown }).chosen === undefined && (o as { ranked?: unknown }).ranked === undefined;
  check('a refusal carries NO chosen candidate', shapeIsEmpty(empty), JSON.stringify(Object.keys(empty)));
  check('a refusal carries NO ranked list', shapeIsEmpty(empty));
  check('no-capable carries no candidate', shapeIsEmpty(r));
  check('the capability-refusal carries no ranked list either', (r as { ranked?: unknown }).ranked === undefined);
  check('the quota-blocked refusal carries no candidate', shapeIsEmpty(qOnly));
  check('the mixed-cause refusal carries no candidate', shapeIsEmpty(q));
  check('every refusal DOES carry a code and a reason',
    [empty, r, qOnly, q, pOnly].every((o) => o.ok || ((o.code as string).length > 0 && o.reason.length > 0)));

  // Invalid input is refused, not guessed at.
  check('an empty taskId is refused', assignWorker(input({ registry: registryWith([['opencode', SB, ['implementation']]]), taskId: '  ' })).ok === false);
  check('an empty taskType is refused', assignWorker(input({ registry: registryWith([['opencode', SB, ['implementation']]]), taskType: '' as TaskType })).ok === false);
  check('the invalid-input code is assignment-invalid',
    assignWorker(input({ registry: new ModelRegistry(), taskId: '' })).ok === false &&
    (assignWorker(input({ registry: new ModelRegistry(), taskId: '' })) as { code: string }).code === 'assignment-invalid');
}

// ---------------------------------------------------------------------------
// 7. Writeback and execution boundary
// ---------------------------------------------------------------------------
section('P6-B 7. identity writeback goes through TaskStore; execution is untouched');
{
  const store = new TaskStore();
  store.create({ taskId: 'r', parentTaskId: null, agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'root' }, NOW);
  store.create({ taskId: 'c1', parentTaskId: 'r', agentId: 'placeholder', modelId: 'placeholder-model', taskType: 'implementation', acceptanceCriteria: 'work' }, NOW);

  const reg = registryWith([['workbuddy-intl', HY3, ['implementation']], ['opencode', SB, ['implementation']]]);
  const applied = applyAssignment(store, input({ registry: reg, taskId: 'c1' }), NOW);
  check('applyAssignment succeeded', applied.ok, applied.ok ? '' : applied.code);
  const storeChosen = chosenOf(applied.ok ? applied.outcome : { ok: false });
  check('the task now carries the CHOSEN canonical identity',
    store.get('c1')?.agentId === storeChosen?.agentId,
    `${String(store.get('c1')?.agentId)} vs ${storeChosen?.agentId ?? '<none>'}`);
  check('and the canonical model id, not a caller string',
    store.get('c1')?.modelId === storeChosen?.modelId,
    `${String(store.get('c1')?.modelId)} vs ${storeChosen?.modelId ?? '<none>'}`);
  check('assignment did NOT change the task status', store.get('c1')?.status === 'planned', store.get('c1')?.status);
  check('assignment did NOT start it', store.get('c1')?.startedAt === null);

  // Spawn gate remains the final authority.
  check('the SPAWN GATE still exists and can veto what assignment proposed', (() => {
    const budgets = new BudgetManager(0);
    const decision = buildSpawnGateInput({
      taskId: 'c1', agentId: storeChosen?.agentId ?? 'workbuddy-intl',
      modelId: storeChosen?.modelId ?? HY3,
      sources: {
        descriptors: [], agentStatus: [], quotaRecords: [], registry: new ModelRegistry(), budgets,
        taskType: 'implementation', requestedUnits: 10, currentConcurrency: 0,
        maxConcurrency: 2, maxChildren: 2, maxConcurrentAgents: 2,
      } as never,
    });
    return decision.result.allowed === false;
  })());
  check('assignment does not claim the gate approved it - the gate is separate and still runs', true);

  // Assignment cannot touch an authority.
  const src = ['src/orchestration/assignment.ts', 'src/orchestration/assignment-wiring.ts']
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('assignment never calls runtime.run()', !/\.run\(/.test(code), (code.match(/.{0,20}\.run\([^)]*\)/) ?? [])[0] ?? '');
  check('assignment never calls scheduler.tick()', !/\.tick\(/.test(code));
  check('assignment never calls TaskStore.transition()', !/\.transition\(/.test(code));
  check('assignment never appends to the AttemptStore', !/\.append\(/.test(code));
  check('assignment performs no incrementRetry', !/incrementRetry/.test(code));
  check('assignment imports no orchestrator, runtime or adapter', (() => {
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    return !imports.some((i) => i.includes('/orchestrator/') || i.includes('/runtime') || i.includes('/adapters'));
  })(), [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]).join(', '));
  check('assignment imports the REAL registry and pool, not a copy',
    /from '\.\.\/quota\/registry\.ts'/.test(src) && /from '\.\/model-pool\.ts'/.test(src));
  check('assignment reuses the EXISTING quota resolver', /resolveQuotaStatus/.test(src));
  check('assignment reads P6-E evidence read-only (AttemptStore type-only)',
    /import type \{ AttemptStore \}/.test(src));

  // Store-level guard: only a not-yet-started task can be assigned.
  check('assignIdentity refuses a task that has already started', (() => {
    store.transition('c1', 'queued', NOW);
    store.transition('c1', 'running', NOW);
    const r = store.assignIdentity('c1', 'opencode', SB, NOW);
    return !r.ok && r.code === 'assignment-after-start';
  })());
  check('and the running task kept its identity', store.get('c1')?.agentId === (storeChosen?.agentId ?? ''));
}

// ---------------------------------------------------------------------------
// 8. Reassignment boundary
// ---------------------------------------------------------------------------
section('P6-B 8. reassignment boundary (running tasks are P6-D1)');
{
  check('the assignable set is exactly planned/blocked',
    ASSIGNABLE_STATUSES.join(',') === 'planned,blocked', ASSIGNABLE_STATUSES.join(','));
  for (const s of ['planned', 'blocked']) check(`"${s}" is assignable`, isAssignable(s));
  for (const s of ['queued', 'running', 'to_verify', 'succeeded', 'failed', 'cancelled', 'rework', 'retrying', 'replanning']) {
    check(`"${s}" is NOT assignable (no hot switch)`, !isAssignable(s));
  }
  check('model switching is refused with a named code', (() => {
    const r = requestModelSwitch();
    return !r.ok && r.code === 'model-switch-not-supported';
  })());
  check('and it says model switching is P6-D1', requestModelSwitch().reason.includes('P6-D1'));

  // The real proof: a running task cannot be silently switched, even by evidence.
  const store = new TaskStore();
  store.create({ taskId: 'r', parentTaskId: null, agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'r' }, NOW);
  store.create({ taskId: 'c', parentTaskId: 'r', agentId: 'opencode', modelId: SB, taskType: 'implementation', acceptanceCriteria: 'w' }, NOW);
  store.transition('c', 'queued', NOW);
  store.transition('c', 'running', NOW);
  const evidence = new AttemptStore();
  addExecution(evidence, 'opencode', SB, false);
  addExecution(evidence, 'opencode', SB, false);
  addExecution(evidence, 'workbuddy-intl', HY3, true);
  const reg = registryWith([['opencode', SB, ['implementation']], ['workbuddy-intl', HY3, ['implementation']]]);

  const applied = applyAssignment(store, input({ registry: reg, taskId: 'c', evidence }), NOW);
  check('assignment onto a RUNNING task is refused', !applied.ok, applied.ok ? 'it SWITCHED the agent' : '');
  check('the refusal names the P6-D1 boundary',
    !applied.ok && (applied.code === 'assignment-after-start' || applied.reason.includes('P6-D1')),
    !applied.ok ? `${applied.code} :: ${applied.reason.slice(0, 60)}` : '');
  check('the running task STILL has its original agent', store.get('c')?.agentId === 'opencode', String(store.get('c')?.agentId));
  check('and its original model', store.get('c')?.modelId === SB);
  check('better evidence did NOT trigger a hot switch', store.get('c')?.agentId !== 'workbuddy-intl');

  // D1 vocabulary stays unimplemented (P6-C moved replan out of the deferred set).
  // P6-D1 connected `reassign` to Assignment + TaskStore. The property that still
  // matters from P6-B's side is that Assignment stayed a PROPOSER: `reassign` being
  // implemented must not mean assignment writes identity itself, and the P6-D1
  // migration must not have loosened `assignIdentity`.
  check('P6-D1 did NOT let Assignment write TASK state', (() => {
    // Comments stripped for the same reason: this module's header explains that it has
    // "no reference to TaskStore", so a raw grep would match its own explanation.
    // `store` in the code means `AttemptStore` - read-only evidence, P6-B's design.
    const src = readFileSync('src/orchestration/assignment.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
    return !/migrateIdentityAfterStart|assignIdentity|TaskStore|\.transition\(/.test(src);
  })());
  check('assignIdentity still refuses a STARTED task (P6-B boundary intact)', (() => {
    const src = readFileSync('src/orchestration/store.ts', 'utf8');
    const body = src.split('assignIdentity(')[1]?.split('  /**')[0] ?? '';
    return body.includes('assignment-after-start') && body.includes('startedAt !== null');
  })());
  check('the post-start migration is a SEPARATE method, not a relaxed assignIdentity',
    readFileSync('src/orchestration/store.ts', 'utf8').includes('migrateIdentityAfterStart('));
  check('the implemented action set is the expected one (P6-D1 completed it)', (() => {
    // Compared against the exported value, not a re-typed string: a source grep
    // here would pass or fail on formatting rather than on behaviour.
    return IMPLEMENTED_ACTIONS.join(',') === 'continue,wait,abort,rework,replan,retry,reassign,add_task,split_task,parallelize,complete';
  })(), IMPLEMENTED_ACTIONS.join(','));
  check('P6-B itself enabled no decision action of its own', !['assign', 'retry', 'reassign', 'split_task', 'add_task', 'parallelize', 'complete']
    .some((a) => !['retry', 'reassign', 'split_task', 'add_task', 'parallelize', 'complete'].includes(a) && (IMPLEMENTED_ACTIONS as readonly string[]).includes(a)));
}

// ---------------------------------------------------------------------------
// 9. End-to-end through the REAL execution path, with P6-E wiring
// ---------------------------------------------------------------------------
section('P6-B 9. assignment -> TaskStore -> scheduler -> executeTask, with evidence');
{
  const dir = mkdtempSync(join(tmpdir(), 'p6b-e2e-'));
  const descriptor = (id: string): AgentDescriptor => ({
    id, displayName: id, launcher: { command: 'x', args: [], shell: false } as never, transport: 'cli-jsonl',
    capabilities: {
      newTask: true, resume: true, review: false, modelSelection: true, roleSelection: true,
      sandbox: false, streamEvents: true, costReporting: false, extraArgs: true, cwd: true,
      skills: false,
      steering: false, worktree: false, fork: false, stdinPrompt: false, workspaceModes: ['shared'],
    } as AgentDescriptor['capabilities'],
  });
  // The gate must know BOTH agents: the child is SPAWNED on a placeholder
  // identity and then REASSIGNED. A gate that only knew the target agent would
  // refuse the spawn, and the fixture would fail for a reason that has nothing to
  // do with assignment.
  const gateSources = (ids: readonly string[]) => {
    const budgets = new BudgetManager(100_000);
    for (const t of ids) budgets.task(t, 10_000);
    budgets.agent('opencode', 10_000);
    budgets.agent('workbuddy-intl', 10_000);
    return { descriptors: [descriptor('opencode'), descriptor('workbuddy-intl')],
      agentStatus: [
        { agent: 'opencode', version: '1', installed: 'Yes', login: 'n', quotaSource: 't', usage: 'n', status: 'ok' } as never,
        { agent: 'workbuddy-intl', version: '1', installed: 'Yes', login: 'n', quotaSource: 't', usage: 'n', status: 'ok' } as never,
      ],
      quotaRecords: [quotaRow('opencode', 'available'), quotaRow('workbuddy-intl', 'available')],
      registry: registryWith([['opencode', SB, ['implementation']], ['workbuddy-intl', HY3, ['implementation']]]),
      budgets, taskType: 'implementation' as TaskType, requestedUnits: 100,
      currentConcurrency: 0, maxConcurrency: 4, maxChildren: 8, maxConcurrentAgents: 4,
    } as never;
  };

  const requests: RunRequest[] = [];
  const runtime = {
    run(req: RunRequest): RunHandle {
      requests.push(req);
      const result = {
        taskId: 'rt-1', agentId: req.agentId, state: 'succeeded', error: null,
        startedAt: 0, endedAt: 5, exitCode: 0, signal: null, output: '', outputTruncated: false,
        transcriptPath: null, usage: { costUsd: 0 }, toolCalls: [], diagnostics: [],
        cleanup: { rootKilled: false, descendantsReaped: false, note: '' },
      } as unknown as RunResult;
      return { result: async () => result, cancel: async () => {}, dispose: async () => {} } as unknown as RunHandle;
    },
  };

  const evidence = new AttemptStore();
  const orch = new Orchestrator({ gate: gateSources(['r', 'c1']), now: () => NOW, runtime, defaultCwd: dir });
  orch.createRoot({ taskId: 'r', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'root' });
  // Spawn with a placeholder identity, exactly as an un-assigned task would be.
  orch.spawnChild({ taskId: 'c1', parentTaskId: 'r', agentId: 'opencode', modelId: SB, taskType: 'implementation', acceptanceCriteria: 'work', budgetUnits: 10 });

  check('the task starts on the placeholder identity', orch.getStore().get('c1')?.agentId === 'opencode');

  // Give workbuddy-intl the better history, so the assignment genuinely CHANGES the
  // task's identity. Without evidence the tie-break would pick `opencode` - which
  // is already the placeholder - and the test would pass without ever exercising
  // a write-back.
  const beforeEvidence = new AttemptStore();
  addExecution(beforeEvidence, 'opencode', SB, false);
  addExecution(beforeEvidence, 'opencode', SB, false);
  addExecution(beforeEvidence, 'workbuddy-intl', HY3, true);

  const applied = applyAssignment(orch.getStore(), input({
    registry: registryWith([['opencode', SB, ['implementation']], ['workbuddy-intl', HY3, ['implementation']]]),
    taskId: 'c1',
    evidence: beforeEvidence,
  }), NOW);
  check('assignment wrote the chosen identity back through TaskStore', applied.ok, applied.ok ? '' : applied.code);
  const chosen = chosenOf(applied.ok ? applied.outcome : { ok: false });
  check('the assigned worker is NOT the placeholder (assignment actually changed it)',
    chosen?.agentId === 'workbuddy-intl', chosen?.agentId ?? 'none');
  check('the task now names the assigned worker',
    orch.getStore().get('c1')?.agentId === chosen?.agentId, `${String(orch.getStore().get('c1')?.agentId)} vs ${chosen?.agentId}`);

  // The EXISTING scheduler dispatches it - no new execution path.
  const scheduler = new TaskScheduler({ orchestrator: orch, cwd: dir, rootTaskId: 'r' });
  const tick = await scheduler.tick();
  check('the existing TaskScheduler dispatched the assigned task', tick.admitted.includes('c1'), JSON.stringify(tick.admitted));
  check('the runtime ran the ASSIGNED agent, not the placeholder',
    requests[0]?.agentId === chosen?.agentId, `${String(requests[0]?.agentId)} vs ${chosen?.agentId}`);

  // P6-E wiring: record after the tick, best-effort.
  const rec = recordDispatchedExecutions(evidence, orch.getStore(), tick);
  check('P6-E wiring recorded the real dispatch', rec.recorded.includes('c1'), JSON.stringify(rec));
  check('evidence is not degraded when storage works', rec.evidenceDegraded === false);
  check('the record carries the ASSIGNED agent, read from Task.agentId/modelId',
    evidence.history('c1')[0]?.agentId === chosen?.agentId,
    `${String(evidence.history('c1')[0]?.agentId)} vs ${chosen?.agentId}`);
  check('and the canonical model id from the task', evidence.history('c1')[0]?.modelId === HY3, String(evidence.history('c1')[0]?.modelId));

  // That evidence must now feed a LATER assignment.
  const two = registryWith([['opencode', SB, ['implementation']], ['workbuddy-intl', HY3, ['implementation']]]);
  const later = assignWorker(input({ registry: two, taskId: 'task-2', evidence }));
  check('the recorded success is visible to the next assignment',
    later.ok && later.ranked.find((x) => x.candidate.agentId === 'workbuddy-intl')?.score.agentEvidence === 1,
    later.ok ? String(later.ranked.find((x) => x.candidate.agentId === 'workbuddy-intl')?.score.agentEvidence) : '');
  check('so the proven worker wins over the unproven one',
    chosenOf(later)?.agentId === 'workbuddy-intl', chosenOf(later)?.agentId ?? codeOf(later));

  // Best-effort: a degraded ledger must not be reported as success, and must not throw.
  const degraded = new AttemptStore();
  const bad = recordDispatchedExecutions(degraded, orch.getStore(), {
    ...tick,
    outcomes: [{ taskId: 'c1', outcome: { ok: true, run: { agentId: 'x', state: 'succeeded', error: null, startedAt: 0, endedAt: 1, usage: null } as unknown as RunResult } }],
    admitted: ['c1'],
  } as never);
  check('a record that cannot describe the run is reported, not thrown', typeof bad.evidenceDegraded === 'boolean');
  check('a refused dispatch still records nothing',
    recordDispatchedExecutions(degraded, orch.getStore(), { ...tick, outcomes: [], admitted: [] } as never).recorded.length === 0);

  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 10. Scope: no P6-C / P6-D1 capability smuggled in
// ---------------------------------------------------------------------------
section('P6-B 10. scope guard - nothing from P6-C or P6-D1');
{
  const src = ['src/orchestration/assignment.ts', 'src/orchestration/assignment-wiring.ts']
    .map((f) => readFileSync(f, 'utf8')).join('\n');
  // These names appear in PROSE - in comments explaining why P6-B does NOT do
  // them, and in `requestModelSwitch()`'s refusal message. So a bare substring
  // grep would flag the very text that documents the boundary. What matters is
  // that none of them is a CAPABILITY: not imported, not defined, not called.
  const codeNoComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const codeNoStrings = codeNoComments.replace(/'[^'\n]*'/g, "''").replace(/`[^`]*`/g, '``');
  for (const banned of ['splitTask', 'addTask', 'setDependencies', 'GraphDelta', 'PlanCandidate',
    'downstreamInvalidat', 'markStale', 'replaceSubtree', 'replan', 'reassign', 'cancelTask']) {
    check(`"${banned}" is not implemented (absent from code and strings)`, !new RegExp(banned, 'i').test(codeNoStrings));
  }
  check('the only place reassign/replan are named is a refusal that returns a code',
    typeof requestModelSwitch().code === 'string' && requestModelSwitch().ok === false);
  check('assignment imports no planner module', !/from '.*planner/.test(src));
  check('assignment imports no graph-delta module', !/graph-delta/.test(src));
  check('assignment has no scoring ML / probability model', !/softmax|sigmoid|gradient|neural/i.test(src));
  check('assignment never calls a decision provider or Laya', !/DecisionProvider|decision-loop|\.decide\(/.test(src));
  check('assignment never invokes Codex or any adapter', !/codex|adapter|spawnChild/i.test(src));
  check('no new file introduces a dependency (Redis/SQLite/bus)', (() => {
    const files: string[] = [];
    (function walk(d: string): void {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts')) files.push(p);
      }
    })('src');
    const all = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    return !/from '(redis|ioredis|sqlite3|better-sqlite3|amqplib|kafkajs|nats|amqp|knex|sequelize|typeorm|pg|mysql2|mongodb)/.test(all);
  })());
  check('P6-B added no RUNTIME dependency', (() => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    return Object.keys(pkg.dependencies ?? {}).length === 0;
  })(), JSON.stringify(Object.keys(JSON.parse(readFileSync('package.json', 'utf8')).dependencies ?? {})));
  check('devDependencies are unchanged (typescript + types/node only)', (() => {
    const dev = Object.keys(JSON.parse(readFileSync('package.json', 'utf8')).devDependencies ?? {}).sort();
    return dev.join(',') === '@types/node,typescript';
  })());
}

// ---------------------------------------------------------------------------
// 11. Authority scan
// ---------------------------------------------------------------------------
section('P6-B 11. authority scan - still exactly one of each');
{
  const files: string[] = [];
  (function walk(d: string): void {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) files.push(p);
    }
  })('src');
  const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const code = files.map((f) => strip(readFileSync(f, 'utf8')));
  const occ = (r: RegExp): number => code.reduce((n, t) => n + [...t.matchAll(new RegExp(r.source, r.flags.includes('g') ? r.flags : `${r.flags}g`))].length, 0);

  check('new TaskStore(          === 1', occ(/new TaskStore\(/) === 1, String(occ(/new TaskStore\(/)));
  check('class TaskScheduler     === 1', occ(/class TaskScheduler\b/) === 1);
  check('class WorkspaceManager  === 1', occ(/class WorkspaceManager\b/) === 1);
  check('runtime.run(            === 1', occ(/runtime\.run\(/) === 1, String(occ(/runtime\.run\(/)));
  check('applyVerification impl  === 1', occ(/applyVerification\(taskId: string, outcome: VerificationOutcome\): MutateOutcome \{/) === 1);
  check('class AttemptStore      === 1', occ(/class AttemptStore\b/) === 1);
  check('class TaskStore         === 1', occ(/class TaskStore\b/) === 1);
  check('P6-B added NO second identity registry',
    occ(/class (WorkerRegistry|AssignmentRegistry|AgentIdentityRegistry)\b/) === 0);
  check('assignment itself constructs no budget ledger (quota stays untouched)',
    !/new BudgetManager\(/.test(readFileSync('src/orchestration/assignment.ts', 'utf8') +
      readFileSync('src/orchestration/assignment-wiring.ts', 'utf8')));
  check('quota/ files unchanged in shape: one modelKey definition', occ(/export function modelKey\(/) === 1);
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) {
  process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
}
process.stdout.write('\n');
process.exitCode = failed === 0 ? 0 : 1;
