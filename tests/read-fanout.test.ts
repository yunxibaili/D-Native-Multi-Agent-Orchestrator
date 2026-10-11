// ===========================================================================
// TeamRun T3-a.1 鈥?READ-only fan-out: topology validation + deterministic projection.
// ===========================================================================
//
// Pure unit coverage for the fail-closed READ gate and the ALL-terminal aggregation. The
// end-to-end production chain (Laya topology -> materialization -> Assignment -> Sessions ->
// Scheduler -> runtime) is proven in `handoff-production-round.test.ts`.

import {
  validateFanoutMembers,
  projectFanoutAggregation,
  FANOUT_MAX_MEMBERS,
  type FanoutProvenance,
} from '../src/orchestration/fanout.ts';
import {
  decideExecutionTopology,
  buildExecutionTopologyRequest,
  EXECUTION_TOPOLOGY_ID,
  TOPOLOGY_SOLO,
  TOPOLOGY_PARALLEL_READ,
} from '../src/decision/execution-topology.ts';
import type { DecisionProvider } from '../src/decision/types.ts';
import { readFileSync } from 'node:fs';
import { projectDispatchTaskEvidence } from '../src/orchestration/dispatch-evidence.ts';
// TeamRun T3-a.5: the REAL append-site binding under test. Not a mock: `AttemptStore` +
// `recordExecutions` are the production code that mints `attemptId` from the very `RunResult`
// that builds the record, which is the only place a correlated pair can honestly be born.
import { AttemptStore } from '../src/orchestration/attempt-store.ts';
import { recordExecutions } from '../src/orchestration/attempt-integration.ts';
import type { RunResult } from '../src/core/types.ts';
// Real TaskStore + real TaskScheduler, with a stub orchestrator that only records dispatch:
// this proves the DOWNSTREAM dependency gate on the real scheduler, not a hand-rolled one.
import { TaskStore } from '../src/orchestration/store.ts';
import { TaskScheduler } from '../src/orchestration/scheduler.ts';
import type { Orchestrator } from '../src/orchestration/orchestrator.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; process.stdout.write(`  ok   ${name}\n`); }
  else { failed++; failures.push(name); process.stdout.write(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}\n`); }
}
function section(t: string): void { process.stdout.write(`\n== ${t} ==\n`); }

const member = (agentId: string, modelId: string, scope: string, accessMode?: string) =>
  ({ agentId, modelId, scope, ...(accessMode === undefined ? {} : { accessMode }) });

section('T3-a.1. the READ gate is fail-closed at TOPOLOGY, not at ResourceClaim');

check('two READ members validate',
  validateFanoutMembers([member('a', 'a/m1', 's1'), member('b', 'b/m1', 's2')]).ok);
check('accessMode omitted defaults to READ',
  (() => { const v = validateFanoutMembers([member('a', 'a/m1', 's1'), member('b', 'b/m1', 's2')]);
    return v.ok && v.members.every((m) => m.accessMode === 'read'); })());
check('an explicit read member validates',
  validateFanoutMembers([member('a', 'a/m1', 's1', 'read'), member('b', 'b/m1', 's2', 'read')]).ok);

for (const [label, raw] of [
  ['not an array', 'nope'],
  ['fewer than 2', [member('a', 'a/m1', 's1')]],
  ['more than max', Array.from({ length: FANOUT_MAX_MEMBERS + 1 }, (_, i) => member('a', `a/m${i}`, `s${i}`))],
  ['a non-object member', [member('a', 'a/m1', 's1'), 42]],
  ['a partial pair (model missing)', [member('a', 'a/m1', 's1'), { agentId: 'b', scope: 's2' }]],
  ['a missing scope', [member('a', 'a/m1', 's1'), { agentId: 'b', modelId: 'b/m1' }]],
  ['an empty scope', [member('a', 'a/m1', 's1'), member('b', 'b/m1', '   ')]],
  ['a duplicate member', [member('a', 'a/m1', 's1'), member('a', 'a/m1', 's1')]],
] as const) {
  check(`refuses ${label}`, !validateFanoutMembers(raw).ok);
}

// THE READ gate. ResourceClaim would let read+write share (claimsConflict returns false), so
// this refusal MUST happen here or not at all.
{
  const mixed = validateFanoutMembers([member('a', 'a/m1', 's1', 'read'), member('b', 'b/m1', 's2', 'write')]);
  check('a WRITE member refuses the WHOLE topology', !mixed.ok && mixed.code === 'topology-write-member-refused',
    mixed.ok ? 'accepted' : mixed.code);
  const ww = validateFanoutMembers([member('a', 'a/m1', 's1', 'write'), member('b', 'b/m1', 's2', 'write')]);
  check('WRITE+WRITE refuses', !ww.ok, ww.ok ? 'accepted' : ww.code);
  const ew = validateFanoutMembers([member('a', 'a/m1', 's1', 'exclusive-write'), member('b', 'b/m1', 's2')]);
  check('exclusive-write refuses', !ew.ok, ew.ok ? 'accepted' : ew.code);
}

section('T3-a.1. deterministic ALL-terminal projection (never completion order)');

const prov: FanoutProvenance = {
  sourceTaskId: 'root',
  topology: 'parallel_read',
  members: [
    { taskId: 'root-fr1', memberIndex: 0, agentId: 'a', modelId: 'a/m1', scope: 'one', accessMode: 'read' },
    { taskId: 'root-fr2', memberIndex: 1, agentId: 'b', modelId: 'b/m1', scope: 'two', accessMode: 'read' },
    { taskId: 'root-fr3', memberIndex: 2, agentId: 'a', modelId: 'a/m1', scope: 'three', accessMode: 'read' },
  ],
};

{
  // T3-a.2: the projection now takes FACTS (assignment verdict + executed + actual), not
  // just a status. A member that ran and finished lands in `to_verify`; a pre-dispatch
  // refusal is settled WITHOUT being terminal; a valid member waiting for capacity is neither.
  const factsFrom = (
    statuses: Record<string, string>,
    refused: Record<string, boolean> = {},
  ) => (id: string) => {
    const taskStatus = statuses[id] ?? 'missing';
    const isRefused = refused[id] === true;
    const started = !isRefused
      && (taskStatus === 'to_verify' || taskStatus === 'succeeded'
        || taskStatus === 'failed' || taskStatus === 'cancelled');
    return {
      taskStatus,
      execution: (isRefused ? 'assignment-refused' : started ? 'started' : 'pending') as
        'assignment-refused' | 'started' | 'pending',
      assignment: (isRefused ? 'refused' : 'accepted') as 'accepted' | 'refused',
      assignmentRefusalReason: isRefused ? 'quota-blocked' : null,
      actual: started
        ? { agentId: 'actual-a', modelId: 'actual-a/m', sessionId: 's', attemptId: 'at' }
        : null,
    };
  };

  {
    const agg = projectFanoutAggregation(prov, factsFrom(
      { 'root-fr1': 'running', 'root-fr2': 'to_verify', 'root-fr3': 'to_verify' }));
    check('order is by memberIndex', agg.members.map((m) => m.memberIndex).join(',') === '0,1,2');
    check('NOT allSettled while one member still runs', agg.allSettled === false, JSON.stringify(agg.allSettled));
    check('every requested member is retained', agg.members.length === 3 && agg.requested === 3);
    check('the running member is reported non-succeeding', agg.nonSucceeding.includes('root-fr1'));
    check('a settled member is not listed as failing', !agg.nonSucceeding.includes('root-fr2'));
    check('requested and actual are carried separately',
      agg.members[1]!.requested.agentId === 'b' && agg.members[1]!.actual?.agentId === 'actual-a');
    const agg2 = projectFanoutAggregation(prov, factsFrom(
      { 'root-fr3': 'running', 'root-fr2': 'to_verify', 'root-fr1': 'to_verify' }));
    check('order is unchanged by a different completion order',
      agg2.members.map((m) => m.memberIndex).join(',') === '0,1,2');
  }

  {
    const agg = projectFanoutAggregation(prov, factsFrom(
      { 'root-fr1': 'to_verify', 'root-fr2': 'failed', 'root-fr3': 'to_verify' }));
    check('allSettled once every member execution is settled', agg.allSettled === true, JSON.stringify(agg.allSettled));
    check('a failed member is NOT dropped',
      agg.members.some((m) => m.taskId === 'root-fr2' && m.taskStatus === 'failed'));
    check('a failed-AFTER-START member is executed with a real actual pair',
      agg.members[1]!.executed === true && agg.members[1]!.actual !== null, JSON.stringify(agg.members[1]));
    check('and is reported non-succeeding', agg.nonSucceeding.includes('root-fr2'));
    check('the two successes are still present', agg.nonSucceeding.length === 1);
  }

  {
    const agg = projectFanoutAggregation(prov, factsFrom(
      { 'root-fr1': 'to_verify', 'root-fr2': 'planned', 'root-fr3': 'to_verify' },
      { 'root-fr2': true }));
    const b = agg.members[1]!;
    check('a pre-dispatch refusal IS executionSettled', b.executionSettled === true, JSON.stringify(b));
    check('but its Task is NOT terminal', b.taskTerminal === false, String(b.taskTerminal));
    check('and a dependency is NOT satisfied by a refusal', b.dependencySatisfied === false);
    check('a refusal was not executed (actual null)', b.executed === false && b.actual === null);
    check('a refusal keeps its REQUESTED pair',
      b.requested.agentId === 'b' && b.requested.modelId === 'b/m1');
    check('the refusal verdict + reason are retained',
      b.assignment.status === 'refused' && b.assignment.reason === 'quota-blocked');
    check('the group is allSettled (A/C settled + B refused)', agg.allSettled === true, JSON.stringify(agg.allSettled));
    check('but NOT allTerminal (B task is still planned)', agg.allTerminal === false);
    check('and the refusal is counted', agg.refusedCount === 1 && agg.executedCount === 2,
      'refused=' + agg.refusedCount + ' executed=' + agg.executedCount);
  }

  {
    // CAPACITY PENDING 鈥?the key T3-a.2 regression: accepted but not yet dispatched is NOT settled.
    const agg = projectFanoutAggregation(prov, factsFrom(
      { 'root-fr1': 'to_verify', 'root-fr2': 'planned', 'root-fr3': 'planned' }));
    check('a capacity-pending member is NOT executionSettled',
      agg.members[1]!.executionSettled === false, JSON.stringify(agg.members[1]));
    check('so a width-3 group with capacity 1 is NOT allSettled', agg.allSettled === false,
      JSON.stringify(agg.allSettled));
    check('and it is not misread as a refusal', agg.members[1]!.assignment.status === 'accepted');
    const to = projectFanoutAggregation(prov, factsFrom(
      { 'root-fr1': 'to_verify', 'root-fr2': 'failed', 'root-fr3': 'to_verify' }));
    check('a timed-out member settles and does not affect the others',
      to.allSettled === true && to.nonSucceeding.length === 1);
  }
}

section('T3-a.2. dependencySatisfied reuses the CANONICAL scheduler rule (status === succeeded)');

{
  const deps = (status: string) => {
    const one = {
      sourceTaskId: 'root', topology: 'parallel_read' as const,
      members: [{ taskId: 'fr1', memberIndex: 0, agentId: 'a', modelId: 'a/m1', scope: 's', accessMode: 'read' as const }],
    };
    return projectFanoutAggregation(one, () => ({
      taskStatus: status,
      execution: (status === 'to_verify' || status === 'failed' || status === 'succeeded' ? 'started' : 'pending') as never,
      assignment: 'accepted' as const,
    })).members[0]!;
  };
  check('succeeded: taskTerminal=true AND dependencySatisfied=true',
    deps('succeeded').taskTerminal === true && deps('succeeded').dependencySatisfied === true);
  check('failed: taskTerminal=true but dependencySatisfied=false',
    deps('failed').taskTerminal === true && deps('failed').dependencySatisfied === false);
  check('cancelled: taskTerminal=true but dependencySatisfied=false',
    deps('cancelled').taskTerminal === true && deps('cancelled').dependencySatisfied === false);
  check('to_verify: NOT terminal and NOT dependency-satisfied',
    deps('to_verify').taskTerminal === false && deps('to_verify').dependencySatisfied === false);
  check('planned (refused/pending): neither',
    deps('planned').taskTerminal === false && deps('planned').dependencySatisfied === false);
}

section('T3-a.3. the fan-out facts reader consumes CURRENT evidence, not history');

{
  const src = readFileSync(new URL('../src/cli/round-cli.ts', import.meta.url), 'utf8');
  const at = src.indexOf('const fanoutFactsOf');
  const fn = at < 0 ? '' : src.slice(at, at + 2600);
  // The atomic bundle resolver (called by fanoutFactsOf) is the currentActualOf helper.
  const helper = src.slice(src.indexOf('const currentActualOf'), src.indexOf('const currentActualOf') + 900);
  check('fanoutFactsOf exists', fn.length > 0);
  check('fanoutFactsOf does NOT read attempt HISTORY (a prior execution)',
    !/wb\.evidence\.history\(/.test(fn), 'history leak');
  check('fanoutFactsOf does NOT read lastRunResult on its own',
    !/wb\.lastRunResult\(/.test(fn), 'lastRunResult leak');
  check('fanoutFactsOf does NOT read the Task binding for actual identity',
    !/live\.agentId/.test(fn) && !/live\.modelId/.test(fn), 'Task-binding leak');
  check('fanoutFactsOf is driven by the CURRENT-round dispatch receipts',
    /currentExecutions\.get\(/.test(fn), 'no receipt anchor');
  check('fanoutFactsOf resolves the atomic bundle from AttemptStore by attemptId',
    /wb\.evidence\.get\(/.test(helper), 'actual identity not attempt-backed');
  // 搂10/搂11: the Review packet must consume the SAME atomic projection, not re-derive it.
  check('the fan-out adoption in the packet uses the SAME currentActualOf projection',
    /const fanActual = fanMember === undefined \? null : currentActualOf\(t\.taskId\)/.test(src),
    'Review has a second identity derivation');
  check('the dispatch capture proves execution by ATTEMPT, not `admitted`',
    /attemptIdsByTask/.test(src) && /projectDispatchTaskEvidence/.test(src)
    && !/entry\.admitted \? 'started'/.test(src), 'admitted used as execution proxy');
}

section('T3-a.4. the dispatch evidence projection: attempt proves execution, admitted does not');

{
  const facts = (over: Partial<Parameters<typeof projectDispatchTaskEvidence>[0]>) => ({
    outcomes: [], waiting: [], skipped: [], attemptIdsByTask: {}, ...over,
  });

  // T3A4-1: admitted=true but NO attempt => the runtime never started.
  const noRun = projectDispatchTaskEvidence(facts({
    outcomes: [{ taskId: 't', admitted: true }],
    attemptIdsByTask: {},
  }));
  check('T3A4-1: admitted=true with no attempt is NOT executed',
    noRun.get('t')?.outcome === 'dispatch-refused', JSON.stringify(noRun.get('t')));

  // T3A4-1/5: admitted=FALSE but an attempt exists => it DID run (write-back refused).
  const wbRefused = projectDispatchTaskEvidence(facts({
    outcomes: [{ taskId: 't', admitted: false }],
    skipped: [{ taskId: 't', code: 'stale-lease', reason: 'lease revoked mid-flight' }],
    attemptIdsByTask: { t: ['att_0002'] },
  }));
  const wb = wbRefused.get('t')!;
  check('T3A4-5: a write-back refusal IS executed (attempt proves it)',
    wb.outcome === 'started' && wb.attemptIds.length === 1, JSON.stringify(wb));
  check('T3A4-5: the write-back was NOT accepted', wb.writeBackAccepted === false);
  check('T3A4-5: and the refusal reason is preserved',
    wb.refusalCode === 'stale-lease' && wb.refusalReason === 'lease revoked mid-flight');

  // T3A4-1: a normal accepted run.
  const ok = projectDispatchTaskEvidence(facts({
    outcomes: [{ taskId: 't', admitted: true }], attemptIdsByTask: { t: ['att_ok'] },
  })).get('t')!;
  check('T3A4-1: an accepted execution is started + writeBackAccepted',
    ok.outcome === 'started' && ok.writeBackAccepted === true && ok.refusalCode === null);

  // T3A4-7: waiting => pending (not settled, no attempt).
  const wait = projectDispatchTaskEvidence(facts({ waiting: ['t'] })).get('t')!;
  check('T3A4-7: waiting is pending with no attempt',
    wait.outcome === 'pending' && wait.attemptIds.length === 0);

  // T3A4-8: a superseding refusal resolution is `dispatch-refused` (so a caller's
  // last-writer-wins merge CLEARS an earlier attempt).
  const refuse = projectDispatchTaskEvidence(facts({
    outcomes: [{ taskId: 't', admitted: false }],
    skipped: [{ taskId: 't', code: 'concurrency-limit', reason: 'no free slot' }],
    attemptIdsByTask: {},
  })).get('t')!;
  check('T3A4-8: a new refusal resolves the task to dispatch-refused (no attempt)',
    refuse.outcome === 'dispatch-refused' && refuse.attemptIds.length === 0 && refuse.refusalCode === 'concurrency-limit');

  // T3A4-9: a generic/relevant skip that is NOT an outcome is NOT a new resolution, so the
  // projection omits it 鈥?a caller keeps the old context.
  const depSkip = projectDispatchTaskEvidence(facts({
    skipped: [{ taskId: 't', code: 'dependency-unmet', reason: 'waiting on dep' }],
  }));
  check('T3A4-9: a dependency-unmet skip does NOT fabricate a new context',
    !depSkip.has('t'), JSON.stringify([...depSkip.keys()]));
}

section('T3-a.5. current Attempt <-> current RunResult are ONE correlated fact (taskId is NOT enough)');

// A taskId can own Attempt A, then B, then C. So `taskId -> RunResult` ("the newest result held
// for this task") is a DIFFERENT question from "the CURRENT attempt's result", and any per-task
// latest-ever lookup can answer the former while the reviewer needs the latter. These tests pin
// that the current run comes from the attempt, never from the task.
section('T3-a.5. the CURRENT result is the CURRENT attempt\'s result, never the task\'s newest');

// Minimal RunResult stand-ins. Only the fields the correlation can possibly key on are set, and
// each is a DISTINCT marker so a leak is unambiguous rather than "some other run".
const mkRun = (agentId: string, state: 'succeeded' | 'failed' | 'timed_out', code: string | null): RunResult =>
  ({ taskId: 'rt', threadId: null, agentId, state, startedAt: 1, endedAt: 2, exitCode: null, signal: null,
     output: `OUT_${agentId}_${state}`, outputTruncated: false, transcriptPath: null, usage: null,
     toolCalls: [], diagnostics: [], cleanup: { rootKilled: false, descendantsReaped: false, note: '' },
     error: code === null ? null : { code, message: `ERR_${agentId}_${code}` } } as unknown as RunResult);

const RESULT_A = mkRun('A', 'succeeded', null);
const RESULT_B = mkRun('B', 'succeeded', null);
const RESULT_A_FAIL = mkRun('A', 'failed', 'SPAWN_FAILED');
const RESULT_B_FAIL = mkRun('B', 'failed', 'NONZERO_EXIT');
const RESULT_B_TIMEOUT = mkRun('B', 'timed_out', 'TIMED_OUT');

{
  const ev = (over: Parameters<typeof projectDispatchTaskEvidence>[0]) => projectDispatchTaskEvidence(over);
  const started = (taskId: string, pairs: { attemptId: string; run: RunResult | null }[], admitted = true) =>
    ev({
      outcomes: [{ taskId, admitted }],
      waiting: [],
      skipped: admitted ? [] : [{ taskId, code: 'stale-lease', reason: 'lease revoked' }],
      attemptIdsByTask: { [taskId]: pairs.map((p) => p.attemptId) },
      executionsByTask: { [taskId]: pairs },
    }).get(taskId)!;

  // T3A5-2 (搂15 A/B marker): A -> RESULT_A, B -> RESULT_B, current = B.
  const ab = started('T', [{ attemptId: 'att_A', run: RESULT_A }, { attemptId: 'att_B', run: RESULT_B }]);
  check('T3A5-2: current attempt is B', ab.attemptId === 'att_B', String(ab.attemptId));
  check('T3A5-2: current run is RESULT_B', ab.run === RESULT_B);
  check('T3A5-2: current run is NOT RESULT_A', ab.run !== RESULT_A);

  // T3A5-1 (搂14 mismatch probe): current Attempt B exists, B has NO result yet. The historical
  // Result A must not be substituted. `run === null` is the honest answer.
  const noB = started('T', [{ attemptId: 'att_B', run: null }]);
  check('T3A5-1: current attempt is B even with no result yet', noB.attemptId === 'att_B');
  check('T3A5-1: current run is null (never falls back to a historical result)', noB.run === null);

  // T3A5-1 (stronger): an attempt present in attemptIdsByTask with NO correlated pair at all 鈥?  // the correlation is missing, so the result is UNKNOWN, and unknown must render as null.
  const orphan = ev({
    outcomes: [{ taskId: 'T', admitted: true }], waiting: [], skipped: [],
    attemptIdsByTask: { T: ['att_B'] },
  }).get('T')!;
  check('T3A5-1: an attempt with no correlated result reports run=null, never a lookup',
    orphan.attemptId === 'att_B' && orphan.run === null, JSON.stringify(orphan.run));

  // T3A5-3 (搂16): A failed, B succeeded -> current is B's success, A's failure must not leak.
  const f2s = started('T', [{ attemptId: 'att_A', run: RESULT_A_FAIL }, { attemptId: 'att_B', run: RESULT_B }]);
  check('T3A5-3: after A-failure/B-success the run is B\'s success', f2s.run === RESULT_B && f2s.run!.error === null);
  check('T3A5-3: and A\'s SPAWN_FAILED is NOT the current result', f2s.run!.error?.code !== 'SPAWN_FAILED');

  // T3A5-4 (搂17): A succeeded, B failed -> current is B's failure (the reverse direction).
  const s2f = started('T', [{ attemptId: 'att_A', run: RESULT_A }, { attemptId: 'att_B', run: RESULT_B_FAIL }]);
  check('T3A5-4: after A-success/B-failure the run is B\'s FAILURE', s2f.run === RESULT_B_FAIL);
  check('T3A5-4: and it carries B\'s error, not A\'s', s2f.run!.error?.code === 'NONZERO_EXIT');

  // T3A5-5 (搂10): a timeout belongs to the CURRENT attempt only.
  const to = started('T', [{ attemptId: 'att_A', run: RESULT_A }, { attemptId: 'att_B', run: RESULT_B_TIMEOUT }]);
  check('T3A5-5: the current run carries the current attempt\'s TIMED_OUT',
    to.run === RESULT_B_TIMEOUT && to.run!.error?.code === 'TIMED_OUT');

  // T3A5-6 (搂11): write-back refusal keeps the attempt AND its result.
  const wb = started('T', [{ attemptId: 'att_B', run: RESULT_B }], false);
  check('T3A5-6: write-back refusal still correlates attempt+result',
    wb.outcome === 'started' && wb.attemptId === 'att_B' && wb.run === RESULT_B, JSON.stringify(wb));
  check('T3A5-6: and writeBackAccepted is false', wb.writeBackAccepted === false);

  // T3A5-7 (搂12): a superseding refusal has no attempt and no result; A stays historical.
  const sup = ev({
    outcomes: [{ taskId: 'T', admitted: false }], waiting: [],
    skipped: [{ taskId: 'T', code: 'concurrency-limit', reason: 'no free slot' }],
    attemptIdsByTask: {}, executionsByTask: {},
  }).get('T')!;
  check('T3A5-7: a superseding refusal clears both attempt and result',
    sup.outcome === 'dispatch-refused' && sup.attemptId === null && sup.run === null);

  // T3A5-8 (搂13): capacity pending inherits neither attempt nor result.
  const pend = ev({
    outcomes: [], waiting: ['T'], skipped: [], attemptIdsByTask: {}, executionsByTask: {},
  }).get('T')!;
  check('T3A5-8: capacity pending inherits neither attempt nor result',
    pend.outcome === 'pending' && pend.attemptId === null && pend.run === null);
}

section('T3-a.5. the REAL append site binds attemptId to the run that built the record');

// The production binding: `recordExecutions` calls `AttemptStore.append`, which MINTS the
// attemptId, and the record is built FROM `entry.outcome.run`. So the id and the run meet here
// and nowhere else 鈥?`RunResult` is frozen by the runtime BEFORE any id exists.
{
  const store = new AttemptStore();
  const runA = mkRun('A', 'succeeded', null);
  const runB = mkRun('B', 'succeeded', null);
  const tick = {
    admitted: ['T'], waiting: [], skipped: [], freeSlots: 1,
    // Dispatch 1: attempt A (the historical execution). Dispatch 2: attempt B (current).
    outcomes: [
      { taskId: 'T', outcome: { ok: true, task: null, run: runA, mapping: {}, runtimeTaskId: 'r1', handle: null, leaseVersion: 1 } },
      { taskId: 'T', outcome: { ok: true, task: null, run: runB, mapping: {}, runtimeTaskId: 'r2', handle: null, leaseVersion: 1 } },
    ],
  } as never;
  const rec = recordExecutions(store, tick, () => ({ agentId: 'A', modelId: 'A/m' }));
  const pairs = rec.executionsByTask['T'] ?? [];

  check('T3A5-2: the real recorder emitted one correlated pair per recorded attempt',
    pairs.length === 2 && rec.attemptIdsByTask['T']!.length === 2, JSON.stringify(pairs.map((p) => p.attemptId)));
  check('T3A5-2: each pair\'s attemptId is a REAL id the store actually minted',
    pairs.every((p) => store.get(p.attemptId) !== null), JSON.stringify(pairs.map((p) => p.attemptId)));
  check('T3A5-2: pair 0 is attempt A with RESULT_A',
    pairs[0]!.attemptId === rec.attemptIdsByTask['T']![0] && pairs[0]!.run === runA);
  check('T3A5-2: pair 1 (current) is attempt B with RESULT_B, not RESULT_A',
    pairs[1]!.attemptId === rec.attemptIdsByTask['T']![1] && pairs[1]!.run === runB && pairs[1]!.run !== runA);

  // And the projection over that REAL receipt picks the last pair.
  const proj = projectDispatchTaskEvidence({
    outcomes: [{ taskId: 'T', admitted: true }], waiting: [], skipped: [],
    attemptIdsByTask: rec.attemptIdsByTask, executionsByTask: rec.executionsByTask,
  }).get('T')!;
  check('T3A5-2: the projection over real evidence yields B + RESULT_B',
    proj.attemptId === pairs[1]!.attemptId && proj.run === runB, JSON.stringify({ a: proj.attemptId, r: proj.run === runB }));
}

section('T3-a.5. structural guard: the fan-out current result path has no task-keyed lookup');

{
  const raw = readFileSync('src/cli/round-cli.ts', 'utf8');
  // Strip comments first: the file NAMES the banned calls in explanatory comments, and a
  // guard that matches its own documentation is worthless. Everything below reads CODE only.
  const cli = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  // Extract a function/arrow body by brace matching, so the guard reads EXACTLY the function
  // under test and cannot accidentally include a neighbour (or a legitimate later use).
  const grab = (name: string): string => {
    const at = cli.indexOf(`const ${name} = `);
    if (at < 0) return '';
    let i = cli.indexOf('{', at);
    let depth = 0;
    for (; i < cli.length; i++) {
      if (cli[i] === '{') depth++;
      else if (cli[i] === '}') { depth--; if (depth === 0) return cli.slice(at, i + 1); }
    }
    return cli.slice(at);
  };
  const capture = grab('captureDispatchFacts');
  // `currentActualOf` has a return-type object before its arrow body, so brace-match from the
  // `=> {` to capture the WHOLE function (signature + body).
  const actualAt = cli.indexOf('const currentActualOf = ');
  const actualBodyAt = cli.indexOf('=> {', actualAt);
  let actualOf = '';
  { let depth = 0, i = actualBodyAt + 3;
    for (; i < cli.length; i++) { if (cli[i] === '{') depth++; else if (cli[i] === '}') { depth--; if (depth === 0) { actualOf = cli.slice(actualAt, i + 1); break; } } } }
  const fanFacts = grab('fanoutFactsOf');

  // T3A5-12 (搂24/搂4): the banned derivations, anywhere in the current-dispatch evidence path.
  const banned = /wb\.lastRunResult\(|latestRunResult\(|latestAttemptResult\(|\.history\([^)]*\)\s*\.at\(-1\)|runResults\.get\(/;
  check('T3A5-12: captureDispatchFacts no longer calls wb.lastRunResult(taskId)',
    !/wb\.lastRunResult\(/.test(capture), 'lastRunResult re-entered the capture path');
  check('T3A5-12: currentActualOf does not consult a task-keyed result map',
    !banned.test(actualOf), 'currentActualOf re-derived the result by task id');
  check('T3A5-12: fanoutFactsOf does not consult a task-keyed result map',
    !banned.test(fanFacts), 'fanoutFactsOf re-derived the result by task id');

  // The correlated pair must actually be threaded through, not merely the absence of the old call.
  check('T3A5-9: capture threads receipt.executionsByTask into the projection',
    /executionsByTask: receipt\.executionsByTask/.test(capture), 'the correlated pairs are not consumed');
  check('T3A5-9: currentActualOf returns the run INSIDE the atomic bundle',
    /run: ce\.run/.test(actualOf) && /attemptId: string/.test(actualOf), 'bundle does not carry the run');

  // T3A5-12: the Review packet takes the member's run from that same bundle (搂20), never a
  // second derivation. The NON-fan-out branch may still read `runResults.get` (搂21 SOLO); what
  // is banned is a task-keyed read on the FAN branch, and any `lastRunResult` in the packet.
  const packetAt = cli.indexOf('const run = fanMember !== undefined');
  const packetStmt = cli.slice(packetAt, cli.indexOf(';', packetAt));
  const fanBranch = /\?\s*(\(fanStarted[^;]*?\))/s.exec(packetStmt)?.[1] ?? '';
  check('T3A5-9: the Review packet reads the fan member run from fanActual (the same bundle)',
    fanBranch.includes('fanActual.run'), fanBranch.trim());
  check('T3A5-12: the fan-member branch reads no task-keyed result',
    !banned.test(fanBranch), fanBranch.trim());
  // `wb.lastRunResult(taskId)` legitimately survives in exactly ONE place 鈥?the CONTINUATION
  // packet builder (a per-task handoff packet, 搂21) 鈥?and nowhere in the unified Review section.
  // So: exactly one occurrence, and it sits BEFORE the Review section rather than inside it.
  const lrHits = [...cli.matchAll(/wb\.lastRunResult\(/g)].map((m) => m.index ?? -1);
  const reviewStart = cli.indexOf('const executionOutcomes');
  check('T3A5-12: lastRunResult survives only for the continuation packet (搂21), not fan-out',
    lrHits.length === 1 && lrHits[0]! < reviewStart,
    `hits=${lrHits.length} reviewStart=${reviewStart}`);
}

// ===========================================================================
section('T3-b.1. the Scheduler dispatch scope allowlist + the drain starvation closure');
// ===========================================================================
//
// T3-b.0.1 proved a starvATION defect that ONLY the Scheduler scope seam can close:
//
//   width 3 / cap 1, fr2 refused pre-runtime (Task status deliberately left alone):
//     tick1 selected fr1, tick2..tick6 ALL selected fr2 again, fr3 NEVER dispatched.
//     outcomes.length was 1 on every tick, so "progress = outcomes.length > 0" was true
//     while nothing progressed at all.
//
// The fix is structural, not detective: the resolved member is not in the next iteration's
// ALLOWLIST, so it is never selected. These tests run the REAL TaskScheduler.

{
  interface DrainOpts { width: number; cap: number; refuse?: (id: string) => boolean; blockerOf?: string }
  const runDrain = async (o: DrainOpts) => {
    const store = new TaskStore();
    const mk = (taskId: string, parentTaskId: string | null, order: number, dependencies: string[]) =>
      store.create({
        taskId, parentTaskId,
        acceptanceCriteria: 'readable', agentId: 'a', modelId: 'a/m1',
        taskType: 'research', order, dependencies,
      }, 1);
    const root = mk('root', null, 0, []);
    if (!root.ok) throw new Error('root ' + root.reason);
    // A dependency must be a KNOWN task, so the blocker is created BEFORE the member that
    // depends on it. For the fixpoint case `blockerOf` names a real child put into `failed` — a
    // terminal that is NOT `succeeded`, so the dependant waits forever and can never resolve.
    if (o.blockerOf !== undefined) {
      const b = mk('blocker', 'root', 0, []);
      if (!b.ok) throw new Error('blocker ' + b.reason);
      store.transition('blocker', 'queued', 1);
      store.transition('blocker', 'running', 2);
      store.transition('blocker', 'failed', 3);
    }
    for (let i = 1; i <= o.width; i++) {
      const id = 'fr' + i;
      const dep: string[] = o.blockerOf === id ? ['blocker'] : [];
      const r = mk(id, 'root', i, dep);
      if (!r.ok) throw new Error(id + ' ' + r.reason);
      store.transition(id, 'queued', 1);
    }
    const calls: string[] = [];
    const orch = {
      getStore: () => store,
      getConcurrencyLimit: () => o.cap,
      getChildLimit: () => 10,
      executeTask: async (req: { taskId: string }) => {
        calls.push(req.taskId);
        if (o.refuse?.(req.taskId) === true) {
          // A pre-runtime refusal: NO run, and the Task status is deliberately left untouched
          // (matching orchestrator.ts:1083-1087 "the task stays task.status").
          return { ok: false, code: 'agent-unavailable', reason: 'model unavailable at gate', status: 'queued' };
        }
        store.transition(req.taskId, 'running', 10);
        await new Promise((r) => setTimeout(r, 2));
        store.transition(req.taskId, 'to_verify', 11);
        return { ok: true, run: { state: 'succeeded' } };
      },
    } as unknown as Orchestrator;
    const scheduler = new TaskScheduler({ orchestrator: orch, cwd: 'C:/w', rootTaskId: 'root' });
    const ids = Array.from({ length: o.width }, (_, i) => 'fr' + (i + 1));
    /**
     * `unresolved` must come from EVIDENCE, never from a Task-status heuristic 鈥?a member that
     * was refused keeps its `queued` status on purpose, so a status test would keep offering it
     * and reproduce exactly the starvation this closes. A member is resolved once it appeared in
     * a tick outcome (it either ran or reached a refusal decision), which is the same
     * `executionSettled` truth the round derives from the fan-out projection.
     */
    const resolved = new Set<string>();
    const unresolved = () => ids.filter((id) => !resolved.has(id));
    const iterations: Array<{ before: string[]; selected: string[]; after: string[] }> = [];
    let shrinkProgress = 0;
    let fixpoint = false;
    let complete = false;
    for (let guard = 0; guard <= o.width + 1; guard++) {
      const before = unresolved();
      if (before.length === 0) { complete = true; break; }
      const tick = await scheduler.tick(undefined, undefined, undefined, { taskIds: new Set(before) });
      const selected = tick.outcomes.map((x) => x.taskId);
      for (const id of selected) resolved.add(id);
      const after = unresolved();
      iterations.push({ before, selected, after });
      if (after.length === 0) { complete = true; break; }
      if (after.length < before.length) { shrinkProgress += 1; continue; }
      fixpoint = true;
      break;
    }
    return { calls, iterations, shrinkProgress, fixpoint, complete, store };
  };

  // --- T3B1-4: THE core regression. B is refused mid-drain; C must still execute. ---
  {
    const d = await runDrain({ width: 3, cap: 1, refuse: (id) => id === 'fr2' });
    const fr2Calls = d.calls.filter((x) => x === 'fr2').length;
    const fr3Calls = d.calls.filter((x) => x === 'fr3').length;
    check('T3B1-4: the refused member is selected EXACTLY ONCE (the starvation fix)',
      fr2Calls === 1, `fr2 selected ${fr2Calls}x: ${d.calls.join(',')}`);
    check('T3B1-4: and the healthy follower still executed', fr3Calls === 1,
      `fr3 executed ${fr3Calls}x: ${d.calls.join(',')}`);
    check('T3B1-4: the drain completed', d.complete === true && d.fixpoint === false,
      JSON.stringify({ complete: d.complete, fixpoint: d.fixpoint }));
    check('T3B1-4: progress was measured as a strict shrink', d.shrinkProgress >= 2,
      `shrinkProgress=${d.shrinkProgress}`);
  }

  // --- T3B1-5: TWO refused members each resolve exactly once, no starvation ---
  {
    const d = await runDrain({ width: 3, cap: 1, refuse: (id) => id === 'fr2' || id === 'fr3' });
    check('T3B1-5: each refused member is selected exactly once',
      d.calls.filter((x) => x === 'fr2').length === 1 && d.calls.filter((x) => x === 'fr3').length === 1,
      `calls=${d.calls.join(',')}`);
    check('T3B1-5: every member was attempted once and the drain completed',
      d.calls.length === 3 && d.complete === true, `calls=${d.calls.join(',')} complete=${d.complete}`);
  }

  // --- T3B1-6: a RESOLVED member stays planned/queued yet is never selected again ---
  {
    const d = await runDrain({ width: 3, cap: 1, refuse: (id) => id === 'fr2' });
    const bStatus = d.store.get('fr2')?.status;
    check('T3B1-6: the refused member keeps its non-terminal Task status (no forged transition)',
      bStatus === 'queued' || bStatus === 'planned', `fr2 status=${String(bStatus)}`);
    check('T3B1-6: yet after resolution it is never selected again',
      d.calls.filter((x) => x === 'fr2').length === 1, `calls=${d.calls.join(',')}`);
  }

  // --- T3B1-7: a capacity-pending member REMAINS eligible for the next tick ---
  {
    const store = new TaskStore();
    const mk = (id: string, parent: string | null, order: number) => store.create({
      taskId: id, parentTaskId: parent, acceptanceCriteria: 'readable',
      agentId: 'a', modelId: 'a/m1', taskType: 'research', order, dependencies: [],
    }, 1);
    mk('root', null, 0);
    for (const id of ['fr1', 'fr2', 'fr3']) { mk(id, 'root', Number(id.slice(2))); store.transition(id, 'queued', 1); }
    const calls: string[] = [];
    const orch = {
      getStore: () => store, getConcurrencyLimit: () => 1, getChildLimit: () => 10,
      executeTask: async (req: { taskId: string }) => {
        calls.push(req.taskId);
        store.transition(req.taskId, 'running', 10);
        await new Promise((r) => setTimeout(r, 2));
        store.transition(req.taskId, 'to_verify', 11);
        return { ok: true, run: { state: 'succeeded' } };
      },
    } as unknown as Orchestrator;
    const scheduler = new TaskScheduler({ orchestrator: orch, cwd: 'C:/w', rootTaskId: 'root' });
    const t1 = await scheduler.tick(undefined, undefined, undefined, { taskIds: new Set(['fr1', 'fr2', 'fr3']) });
    // cap 1 -> exactly one ran, the other two are CAPACITY waiting, not resolved.
    check('T3B1-7: a capacity-limited tick leaves the surplus in `waiting`, not refused',
      t1.admitted.length === 1 && t1.waiting.length === 2 && t1.skipped.length === 0,
      `admitted=${t1.admitted.length} waiting=${JSON.stringify(t1.waiting)} skipped=${JSON.stringify(t1.skipped)}`);
    check('T3B1-7: `waiting` carries NO refusal code (capacity is the only cause)',
      t1.skipped.every((s) => s.taskId !== 'fr2' && s.taskId !== 'fr3'), 'a waiting member was coded as skipped');
    // The two waiting members are still planned/queued, so they stay eligible next tick.
    const t2 = await scheduler.tick(undefined, undefined, undefined, { taskIds: new Set(t1.waiting) });
    check('T3B1-7: the capacity-pending members remain eligible and one is dispatched',
      t2.outcomes.length === 1 && t2.outcomes[0]!.taskId === t1.waiting[0],
      `selected=${JSON.stringify(t2.outcomes.map((o) => o.taskId))}`);
  }

  // --- T3B1-8 / T3B1-9: progress is the strict shrink, and a fixpoint stops without spinning ---
  {
    // A member whose dependency can never be satisfied stays unresolved forever -> fixpoint.
    const d = await runDrain({ width: 3, cap: 2, blockerOf: 'fr3' });
    check('T3B1-9: an unsatisfiable dependency yields a fixpoint, not an endless re-tick',
      d.fixpoint === true && d.complete === false,
      JSON.stringify({ fixpoint: d.fixpoint, complete: d.complete }));
    check('T3B1-9: and the loop terminated in bounded iterations (no spin)',
      d.iterations.length <= 3, `iterations=${d.iterations.length}`);
    check('T3B1-9: the satisfiable members still ran', d.calls.includes('fr1') && d.calls.includes('fr2'),
      `calls=${d.calls.join(',')}`);
    check('T3B1-8: progress iterations equalled the number of strict shrinks',
      d.shrinkProgress === d.iterations.length - 1,
      `shrink=${d.shrinkProgress} iterations=${d.iterations.length}`);
  }

  // --- 搂47: the scope allowlist itself, and legacy compatibility ---
  {
    const store = new TaskStore();
    const mk = (id: string, parent: string | null, order: number) => store.create({
      taskId: id, parentTaskId: parent, acceptanceCriteria: 'readable',
      agentId: 'a', modelId: 'a/m1', taskType: 'research', order, dependencies: [],
    }, 1);
    mk('root', null, 0);
    for (const id of ['A', 'B', 'C']) { mk(id, 'root', id.charCodeAt(0) - 64); store.transition(id, 'queued', 1); }
    const calls: string[] = [];
    const orch = {
      getStore: () => store, getConcurrencyLimit: () => 10, getChildLimit: () => 10,
      executeTask: async (req: { taskId: string }) => {
        calls.push(req.taskId);
        store.transition(req.taskId, 'running', 10);
        store.transition(req.taskId, 'to_verify', 11);
        return { ok: true, run: { state: 'succeeded' } };
      },
    } as unknown as Orchestrator;
    const scheduler = new TaskScheduler({ orchestrator: orch, cwd: 'C:/w', rootTaskId: 'root' });

    calls.length = 0;
    await scheduler.tick(undefined, undefined, undefined, { taskIds: new Set(['B', 'C']) });
    check('SCOPE: only the allowlisted tasks are selected',
      calls.includes('B') && calls.includes('C') && !calls.includes('A'), `calls=${calls.join(',')}`);
    check('SCOPE: the out-of-scope task was left untouched (still queued, never dispatched)',
      store.get('A')?.status === 'queued', `A status=${String(store.get('A')?.status)}`);

    // Legacy: NO scope supplied -> every candidate in the tree, exactly as before T3-b.1.
    calls.length = 0;
    for (const id of ['A', 'D', 'E']) { mk(id, 'root', 90 + id.charCodeAt(0)); store.transition(id, 'queued', 2); }
    await scheduler.tick();
    check('SCOPE: omitting the scope preserves legacy candidate behaviour',
      calls.includes('A') && calls.includes('D') && calls.includes('E'), `calls=${calls.join(',')}`);

    // The scope is per-invocation and never remembered.
    calls.length = 0;
    mk('F', 'root', 200); store.transition('F', 'queued', 3);
    await scheduler.tick();
    check('SCOPE: a previous scope is NOT remembered (no persistence)',
      calls.includes('F'), `calls=${calls.join(',')}`);
  }
}

section('T3-a.1. Laya topology decision contract');

const providerReturning = (answers: Record<string, unknown>, throwOnDecide = false): DecisionProvider => ({
  name: 'topology-test',
  probe: async () => ({ ok: true, endpoint: 'x', detail: '', warnings: [] }),
  decide: async () => {
    if (throwOnDecide) throw new Error('provider transport failure');
    return { answers, provider: { name: 'topology-test', details: '' }, raw: {} } as never;
  },
});

const input = {
  task: { taskId: 'r', objective: 'inspect the parser' },
  candidates: [{ agentId: 'a', modelId: 'a/m1', taskTypes: ['research'], available: true }],
  maxMembers: FANOUT_MAX_MEMBERS,
};

{
  check('the question offers SOLO and PARALLEL_READ',
    (() => {
      const q = buildExecutionTopologyRequest(input).questions[EXECUTION_TOPOLOGY_ID]!;
      const keys = Object.keys((q as { criteria: Record<string, string> }).criteria);
      return keys.includes(TOPOLOGY_SOLO) && keys.includes(TOPOLOGY_PARALLEL_READ);
    })());
}

await (async () => {
  const solo = await decideExecutionTopology(providerReturning({
    [EXECUTION_TOPOLOGY_ID]: { type: 'choice', choice: TOPOLOGY_SOLO, criteria: {} },
  }), input);
  check('a SOLO answer reads back as solo', solo !== null && solo.kind === 'solo', JSON.stringify(solo));

  const parallel = await decideExecutionTopology(providerReturning({
    [EXECUTION_TOPOLOGY_ID]: {
      type: 'choice', choice: TOPOLOGY_PARALLEL_READ, criteria: {},
      parameters: { members: JSON.stringify([member('a', 'a/m1', 's1'), member('b', 'b/m1', 's2')]) },
    },
  }), input);
  check('a PARALLEL_READ answer reads back its members',
    parallel !== null && parallel.kind === 'parallel_read'
    && Array.isArray(parallel.membersRaw) && parallel.membersRaw.length === 2, JSON.stringify(parallel));

  const missing = await decideExecutionTopology(providerReturning({}), input);
  check('no topology answer means SOLO (backward compatible additive seam)', missing === null);

  const errored = await decideExecutionTopology(providerReturning({}, true), input);
  check('a provider transport failure means SOLO, not a crash', errored === null);

  // Malformed PARALLEL_READ must THROW (the caller refuses), never silently become SOLO.
  for (const [label, payload] of [
    ['missing members parameter', { type: 'choice', choice: TOPOLOGY_PARALLEL_READ, criteria: {} }],
    ['members not JSON', { type: 'choice', choice: TOPOLOGY_PARALLEL_READ, criteria: {}, parameters: { members: '{not json' } }],
    ['unknown choice', { type: 'choice', choice: 'SOMETHING_ELSE', criteria: {} }],
    ['wrong answer type', { type: 'score', score: 0, criteria: {} }],
  ] as const) {
    let threw = false;
    try { await decideExecutionTopology(providerReturning({ [EXECUTION_TOPOLOGY_ID]: payload }), input); }
    catch { threw = true; }
    check(`malformed topology (${label}) throws rather than defaulting to SOLO`, threw);
  }
})();

section('T3-a.1. DOWNSTREAM dependency: a dependant waits for ALL members');

await (async () => {
  // Container `root` with two READ members and a downstream D that depends on BOTH.
  const store = new TaskStore();
  store.create({ taskId: 'root', parentTaskId: null, agentId: 'a', taskType: 'implementation', acceptanceCriteria: 'r' }, 1);
  store.create({ taskId: 'fr1', parentTaskId: 'root', agentId: 'a', modelId: 'a/m1', taskType: 'research', acceptanceCriteria: 'one' }, 2);
  store.create({ taskId: 'fr2', parentTaskId: 'root', agentId: 'a', modelId: 'a/m1', taskType: 'research', acceptanceCriteria: 'two' }, 3);
  store.create({ taskId: 'D', parentTaskId: 'root', agentId: 'a', modelId: 'a/m1', taskType: 'research', acceptanceCriteria: 'downstream', dependencies: ['fr1', 'fr2'] }, 4);

  const calls: string[] = [];
  const orch = {
    getStore: () => store,
    getConcurrencyLimit: () => 10,
    getChildLimit: () => 10,
    executeTask: async (req: { taskId: string }) => { calls.push(req.taskId); return { ok: true } as never; },
  } as unknown as Orchestrator;
  const scheduler = new TaskScheduler({ orchestrator: orch, cwd: 'C:/w', rootTaskId: 'root' });

  // fr1 fully verified; fr2 still running.
  for (const [id, to] of [['fr1', 'queued'], ['fr1', 'running'], ['fr1', 'to_verify'], ['fr1', 'succeeded'],
    ['fr2', 'queued'], ['fr2', 'running']] as const) {
    store.transition(id, to, 10);
  }
  calls.length = 0;
  await scheduler.tick();
  check('a downstream D is NOT dispatched while a member is still running',
    !calls.includes('D'), `calls=${calls.join(',')}`);
  check('the running member is not re-dispatched either', !calls.includes('fr2'), `calls=${calls.join(',')}`);

  // fr2 reaches a terminal success (the verification/Human-Gate step).
  store.transition('fr2', 'to_verify', 11);
  store.transition('fr2', 'succeeded', 12);
  calls.length = 0;
  await scheduler.tick();
  check('once ALL members are terminal, D becomes ready and dispatches',
    calls.includes('D'), `calls=${calls.join(',')}`);

  // And the fan-out aggregation agrees: it is ALL-terminal only now.
  const statuses: Record<string, string> = { fr1: 'succeeded', fr2: 'succeeded' };
  const factsOf = (id: string) => {
    const st = statuses[id] ?? 'missing';
    const started = st === 'succeeded' || st === 'failed' || st === 'to_verify';
    return {
      taskStatus: st,
      execution: (started ? 'started' : 'pending') as 'started' | 'pending',
      assignment: 'accepted' as const,
      ...(started ? { actual: { agentId: 'a', modelId: 'a/m1', sessionId: 's', attemptId: 'at' } } : {}),
    };
  };
  const provMembers = {
    sourceTaskId: 'root', topology: 'parallel_read' as const,
    members: [
      { taskId: 'fr1', memberIndex: 0, agentId: 'a', modelId: 'a/m1', scope: 'one', accessMode: 'read' as const },
      { taskId: 'fr2', memberIndex: 1, agentId: 'a', modelId: 'a/m1', scope: 'two', accessMode: 'read' as const },
    ],
  };
  check('the fan-out reports allSettled exactly when the downstream gate opens',
    projectFanoutAggregation(provMembers, factsOf).allSettled === true);
  statuses.fr2 = 'running';
  check('and it is NOT allSettled while a member runs',
    projectFanoutAggregation(provMembers, factsOf).allSettled === false);
})();

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length > 0) process.stdout.write(`failing:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
process.exitCode = failed === 0 ? 0 : 1;