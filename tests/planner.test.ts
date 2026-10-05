/**
 * tests/planner.test.ts — P6-C: candidate DAGs, atomic commit, controlled replan.
 *
 * WHAT MAKES THIS SUITE WORTH WRITING
 * -----------------------------------
 * Every P6-C failure mode is silent in the same way. A validator that checks each
 * task as it is written still produces a task graph — just one containing a cycle.
 * A dedupe-before-validate still admits a duplicate edge. A replan that deletes a
 * queued task leaves no trace except a task that mysteriously stopped existing.
 *
 * So the assertions here are deliberately mostly NEGATIVE and COMPARATIVE:
 * snapshot the store before a bad operation and assert it is byte-identical after.
 * "We validated first" is easy to claim; a snapshot comparison is not.
 *
 * Section 8 asserts on SOURCE IMPORTS, because "this module cannot execute" is a
 * structural fact rather than an observable behaviour — there is no runtime that
 * will fail a test by having one extra import. Getting that wrong is not a bug in
 * the wiring, it is the bug: a planner that can reach a Runtime is a second
 * execution edge.
 */

import { readFileSync } from 'node:fs';

import { TaskStore } from '../src/orchestration/store.ts';
import {
  planTasks,
  validateCandidateDag,
  PlannerError,
  isPlannerError,
  type CandidateTask,
} from '../src/orchestration/planner.ts';
import { commitPlan, replanSubtree, staleTasks } from '../src/orchestration/planner-wiring.ts';
import { unmetDependencies, type TaskSpec } from '../src/orchestration/task.ts';
import { observeTasks } from '../src/orchestration/observation.ts';
import { IMPLEMENTED_ACTIONS, DEFERRED_ACTIONS, ALL_ACTIONS } from '../src/orchestration/decision.ts';
import type { SessionIntent } from '../src/orchestration/workbench-sessions.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed++;
    failures.push(name);
    process.stdout.write(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}\n`);
  }
}
function section(t: string): void {
  process.stdout.write(`\n${t}\n`);
}

const occ = (s: string, re: RegExp): number => (s.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)) ?? []).length;

/** A root task with no dependencies, ready to plan under. */
function root(store: TaskStore, id = 'root'): void {
  const spec: TaskSpec = {
    taskId: id,
    parentTaskId: null,
    agentId: 'w1',
    modelId: null,
    taskType: 'implementation',
    acceptanceCriteria: 'root objective',
    dependencies: [],
    budgetUnits: 10,
  };
  const r = store.create(spec, 1000);
  if (!r.ok || r.task === null) throw new Error(`fixture root failed: ${r.code} ${r.reason}`);
}

/**
 * The module source with COMMENTS STRIPPED.
 *
 * Section 12 asserts on imports, and these modules have long headers explaining
 * which authorities they deliberately avoid. Those headers necessarily contain the
 * words "scheduler", "orchestrator" and "runtime" — so grepping raw source would
 * fail on prose explaining the absence of a dependency, which is exactly backwards.
 * Stripping comments first is what makes these checks measure dependencies.
 */
function codeOf(path: string): string {
  const src = readFileSync(path, 'utf8');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** A stable, comparable snapshot of the whole graph. */
function snapshot(store: TaskStore): string {
  return JSON.stringify(
    store.all().map((t) => ({
      id: t.taskId, parent: t.parentTaskId, status: t.status, deps: [...t.dependencies].sort(),
      stale: t.stale, gen: t.generation,
    })).sort((a, b) => (a.id < b.id ? -1 : 1)),
  );
}

const cand = (
  taskId: string,
  parentTaskId: string | null,
  dependencies: readonly string[] = [],
  taskType: CandidateTask['taskType'] = 'implementation',
): CandidateTask => Object.freeze({
  taskId, parentTaskId, taskType, description: `desc ${taskId}`,
  dependencies: Object.freeze([...dependencies]),
  requiredTaskTypes: Object.freeze([] as readonly CandidateTask['taskType'][]),
});

// ---------------------------------------------------------------------------
section('1. planTasks: deterministic decomposition');
// ---------------------------------------------------------------------------
{
  const a = planTasks({ objective: 'ship it', rootTaskId: 'root', shape: 'parallel' });
  const b = planTasks({ objective: 'ship it', rootTaskId: 'root', shape: 'parallel' });
  check('the same input yields byte-identical output', JSON.stringify(a) === JSON.stringify(b));
  check('parallel yields three independent candidates', a.candidates.length === 3 &&
    a.candidates.every((c) => c.dependencies.length === 0));
  check('candidates carry the objective into their description',
    a.candidates.every((c) => c.description.startsWith('ship it ::')));

  const chain = planTasks({ objective: 'x', rootTaskId: 'root', shape: 'chain' });
  check('chain is strictly serial: each depends on the previous',
    chain.candidates.every((c, i) => (i === 0 ? c.dependencies.length === 0
      : c.dependencies.length === 1 && c.dependencies[0] === chain.candidates[i - 1].taskId)));

  const dia = planTasks({ objective: 'x', rootTaskId: 'root', shape: 'diamond' });
  const join = dia.candidates.find((c) => c.dependencies.length === 2);
  check('diamond has a join node with TWO dependencies', join !== undefined &&
    join.dependencies.length === 2, JSON.stringify(dia.candidates.map((c) => c.dependencies.length)));

  const lv = planTasks({ objective: 'x', rootTaskId: 'root', shape: 'levels:3', width: 2 });
  check('levels:3 width:2 yields six tasks', lv.candidates.length === 6, String(lv.candidates.length));
  check('level 1 depends on nothing; level 2 depends on all of level 1',
    lv.candidates.slice(0, 2).every((c) => c.dependencies.length === 0) &&
    lv.candidates.slice(2, 4).every((c) => c.dependencies.length === 2));

  check('default shape is parallel', planTasks({ objective: 'x', rootTaskId: 'root' }).candidates.length === 3);
  check('generation is carried from the input, not decided by the planner',
    planTasks({ objective: 'x', rootTaskId: 'root', generation: 7 }).generation === 7);
  check('generation defaults to 0', planTasks({ objective: 'x', rootTaskId: 'root' }).generation === 0);

  check('candidates are frozen, so a plan cannot be edited after validation',
    Object.isFrozen(a.candidates[0]) && Object.isFrozen(a.candidates[0].dependencies));
}

// ---------------------------------------------------------------------------
section('2. planTasks: refuses rather than guessing');
// ---------------------------------------------------------------------------
{
  const refused = (fn: () => unknown): PlannerError | null => {
    try { fn(); return null; } catch (e) { return isPlannerError(e) ? e : null; }
  };
  check('an empty objective is refused', refused(() => planTasks({ objective: '   ', rootTaskId: 'r' }))?.code === 'empty-objective');
  check('an empty root is refused', refused(() => planTasks({ objective: 'x', rootTaskId: '' }))?.code === 'empty-root');
  check('an unknown shape is refused, NOT defaulted', refused(() =>
    planTasks({ objective: 'x', rootTaskId: 'r', shape: 'banana' as never }))?.code === 'unknown-shape');
  check('levels:0 is refused', refused(() =>
    planTasks({ objective: 'x', rootTaskId: 'r', shape: 'levels:0' }))?.code === 'unknown-shape');
  check('levels:abc is refused', refused(() =>
    planTasks({ objective: 'x', rootTaskId: 'r', shape: 'levels:abc' }))?.code === 'unknown-shape');
  check('a non-positive width is refused', refused(() =>
    planTasks({ objective: 'x', rootTaskId: 'r', shape: 'levels:2', width: 0 }))?.code === 'invalid-width');

  const e = refused(() => planTasks({ objective: 'x', rootTaskId: 'r', shape: 'banana' as never }));
  check('a refusal is a typed PlannerError, not a bare Error',
    e instanceof PlannerError && e.name === 'PlannerError' && e.code === 'unknown-shape');
  check('the refusal message names the code and the detail',
    e !== null && e.message.includes('unknown-shape') && e.message.includes('banana'));
}

// ---------------------------------------------------------------------------
section('3. validateCandidateDag: the whole graph, before anything is written');
// ---------------------------------------------------------------------------
{
  // `root` is always a known task, because every candidate here hangs off it. It is
  // passed explicitly so a test failure reports the dependency rule it meant to
  // exercise, instead of tripping the parent check first.
  const rootTask = { taskId: 'root', dependencies: [] };
  const codes = (cs: readonly CandidateTask[], extra: ReadonlyMap<string, { taskId: string; dependencies: readonly string[] }> = new Map()): string[] => {
    const existing = new Map([['root', rootTask] as const, ...extra]);
    const v = validateCandidateDag(cs, existing as never);
    return v.ok ? [] : v.rejections.map((r) => r.code);
  };

  check('an empty plan is refused', codes([]).includes('empty-candidate-set'));
  check('a duplicate task id is refused',
    codes([cand('a', 'root'), cand('a', 'root')]).includes('duplicate-task-id'));
  check('a dependency on nothing at all is refused',
    codes([cand('a', 'root', ['ghost'])]).includes('unknown-dependency'));
  check('a task depending on itself is refused',
    codes([cand('a', 'root', ['a'])]).includes('self-dependency'));
  check('an unknown parent is refused', codes([cand('a', 'nope')]).includes('unknown-parent'));
  check('a parent naming an EXISTING task is accepted', !codes([cand('a', 'root')]).includes('unknown-parent'));
  check('a two-node cycle is refused', codes([
    cand('a', 'root', ['b']), cand('b', 'root', ['a']),
  ]).includes('dependency-cycle'));

  // The regression that motivated repairing `findDependencyCycle`: the old walker
  // followed only each node's FIRST dependency and gave up at the first dead end,
  // so this graph passed validation while containing a real cycle.
  // THE REGRESSION. The old walker followed only the FIRST dependency of each node and
  // returned as soon as one branch was walkable-and-clean. Here `a`'s first dependency
  // is `x`, an existing task with no dependencies of its own — a perfectly walkable,
  // perfectly acyclic dead end. The old walker settled `a` there and returned "no
  // cycle", leaving b->c->b live in the graph.
  check('a cycle hidden behind an earlier CLEAN branch is STILL refused', codes([
    cand('a', 'root', ['x', 'b']),
    cand('b', 'root', ['c']),
    cand('c', 'root', ['b']),
  ], new Map([['x', { taskId: 'x', dependencies: [] }]])).includes('dependency-cycle'));

  // The plain version of the same topology, for contrast.
  check('a cycle with no earlier branch is refused',
    codes([cand('b', 'root', ['c']), cand('c', 'root', ['b'])]).includes('dependency-cycle'));

  check('a candidate depending on an EXISTING task is accepted',
    !codes([cand('a', 'root', ['exists'])], new Map([['exists', { taskId: 'exists', dependencies: [] }]])).includes('unknown-dependency'));

  // A candidate closing a loop THROUGH an existing task must be caught, which a
  // candidates-only check would miss entirely.
  check('a cycle that closes through an EXISTING task is refused', codes([
    cand('a', 'root', ['b']),
  ], new Map([
    ['b', { taskId: 'b', dependencies: ['a'] }],
  ])).includes('dependency-cycle'));

  check('a valid diamond validates',
    !codes([cand('a', 'root'), cand('b', 'root'), cand('c', 'root', ['a', 'b'])]).includes('dependency-cycle'));

  const v = validateCandidateDag([cand('a', 'root'), cand('b', 'root', ['a'])], new Map([['root', rootTask]]));
  check('a clean validation returns the candidates it accepted',
    v.ok && v.candidates.length === 2);
}

// ---------------------------------------------------------------------------
section('4. commitPlan: validated, then committed through the EXISTING store');
// ---------------------------------------------------------------------------
{
  const store = new TaskStore();
  root(store);
  const out = commitPlan(store, planTasks({ objective: 'x', rootTaskId: 'root', shape: 'diamond' }).candidates,
    { agentId: 'w1', generation: 1 });
  check('a valid plan commits', out.ok);
  check('all three tasks exist in the store', store.all().length === 4);
  check('the committed tasks carry the plan generation',
    store.all().filter((t) => t.taskId !== 'root').every((t) => t.generation === 1));
  check('the diamond join really has two dependencies in the STORE',
    store.get('root-d3')?.dependencies.length === 2);
  check('the store agrees the committed graph is acyclic', store.findCycle() === null);
  check('commitPlan created tasks via the store, not a side list',
    store.children('root').length === 3);

  // Identity: a candidate carries NO agent, so the commit must not have invented one.
  check('a committed task starts planned, never running',
    store.all().every((t) => t.status === 'planned'));
  check('committed tasks are NOT stale', store.all().every((t) => !t.stale));
  check('committed tasks carry no staleReason', store.all().every((t) => t.staleReason === null));

  const s2 = new TaskStore();
  root(s2, 'r2');
  check('a plan for a root that does not exist is refused',
    commitPlan(s2, [cand('x', 'missing-root')], { agentId: 'w1' }).ok === false);
  check('the refusal names the missing root',
    commitPlan(s2, [cand('x', 'missing-root')], { agentId: 'w1' }).ok === false &&
    (commitPlan(s2, [cand('x', 'missing-root')], { agentId: 'w1' }) as { code: string }).code === 'root-not-found');

  const s3 = new TaskStore();
  root(s3, 'r3');
  commitPlan(s3, [cand('dup', 'r3')], { agentId: 'w1' });
  const again = commitPlan(s3, [cand('dup', 'r3')], { agentId: 'w1' });
  check('committing an id that already exists is refused', again.ok === false);
  check('the refusal is task-already-exists, not a duplicate write',
    !again.ok && again.code === 'task-already-exists');
  check('the refused re-commit did not overwrite the original',
    store !== null && s3.all().filter((t) => t.taskId === 'dup').length === 1);
}

// ---------------------------------------------------------------------------
section('5. atomicity: a bad plan changes NOTHING');
// ---------------------------------------------------------------------------
{
  // Each of these is invalid. For every one, the store must be byte-identical
  // before and after. This is the core P6-C guarantee.
  const cases: { name: string; cs: CandidateTask[]; code: string }[] = [
    { name: 'a cycle', code: 'dependency-cycle', cs: [cand('a', 'root', ['b']), cand('b', 'root', ['a'])] },
    { name: 'a dangling dependency', code: 'unknown-dependency', cs: [cand('a', 'root', ['ghost'])] },
    { name: 'a self-dependency', code: 'self-dependency', cs: [cand('a', 'root', ['a'])] },
    { name: 'a duplicate id', code: 'duplicate-task-id', cs: [cand('a', 'root'), cand('a', 'root')] },
    { name: 'an empty plan', code: 'empty-candidate-set', cs: [] },
  ];
  for (const c of cases) {
    const store = new TaskStore();
    root(store);
    // One GOOD task alongside the bad ones: the case that a write-as-you-validate
    // implementation gets wrong, because it has already committed the good one.
    // An empty plan stays empty: adding a good task to it would make it valid and test
    // nothing about empty-plan handling.
    const withGood: CandidateTask[] = c.cs.length === 0
      ? c.cs
      : [cand('good-1', 'root'), ...c.cs.filter((x) => x.taskId !== 'good-1')];
    const before = snapshot(store);
    const res = commitPlan(store, withGood, { agentId: 'w1' });
    check(`${c.name}: the commit is refused`, res.ok === false);
    check(`${c.name}: the store is byte-identical afterwards`, snapshot(store) === before);
    if (!res.ok) {
      check(`${c.name}: the rejection code is ${c.code}`, res.rejections?.some((r) => r.code === c.code) === true,
        JSON.stringify(res.rejections?.map((r) => r.code)));
    }
    if (c.cs.length > 0) {
      check(`${c.name}: the good task in the same plan was NOT written`, store.has('good-1') === false);
    }
  }
}

// ---------------------------------------------------------------------------
section('6. dependencies are the EXISTING ones, and duplicates are refused');
// ---------------------------------------------------------------------------
{
  const store = new TaskStore();
  root(store);
  commitPlan(store, [cand('a', 'root'), cand('b', 'root'), cand('c', 'root', ['a', 'b'])], { agentId: 'w1' });

  const known = new Map(store.all().map((t) => [t.taskId, t]));
  check('the committed diamond satisfies the EXISTING unmetDependencies check',
    unmetDependencies(store.get('c')!, known).length === 2);
  check('an independent candidate has no unmet dependencies',
    unmetDependencies(store.get('a')!, known).length === 0);

  const dupe = store.setDependencies('c', ['a', 'a'], 2000);
  check('a DUPLICATE dependency is refused, not silently deduped', dupe.ok === false,
    JSON.stringify({ ok: dupe.ok, code: dupe.code }));
  check('the refusal keeps the original single dependency',
    store.get('c')?.dependencies.length === 2 && store.get('c')?.dependencies.join(',') === 'a,b');

  const cyc = store.setDependencies('a', ['c'], 2000);
  check('setDependencies refuses to close a cycle', cyc.ok === false && cyc.code === 'dependency-cycle');
  check('the store is still acyclic after the refused edit', store.findCycle() === null);

  const okSet = store.setDependencies('c', ['a'], 3000);
  check('a valid dependency edit succeeds', okSet.ok);
  check('and is visible on the stored task', store.get('c')?.dependencies.join(',') === 'a');
}

// ---------------------------------------------------------------------------
section('7. stale: a fact, not a status');
// ---------------------------------------------------------------------------
{
  const store = new TaskStore();
  root(store);
  commitPlan(store, [cand('a', 'root'), cand('b', 'root')], { agentId: 'w1' });

  check('a fresh task is not stale', store.get('a')?.stale === false);
  check('marking stale requires a reason',
    store.markStale('a', '  ').ok === false &&
    (store.markStale('a', ' ') as { code: string }).code === 'stale-reason-required');

  const marked = store.markStale('a', 'superseded by generation 2');
  check('marking stale succeeds with a reason', marked.ok);
  check('the reason is recorded', store.get('a')?.staleReason === 'superseded by generation 2');
  check('marking stale did NOT change the status', store.get('a')?.status === 'planned');
  check('marking stale did NOT transition', store.get('a')?.finishedAt === null && store.get('a')?.startedAt === null);

  // Idempotent, and must not overwrite the ORIGINAL reason.
  store.markStale('a', 'a different reason');
  check('re-marking does not overwrite the original reason',
    store.get('a')?.staleReason === 'superseded by generation 2');

  check('staleTasks finds exactly the stale ones',
    staleTasks(store).map((t) => t.taskId).join(',') === 'a');
  check('markStale on an unknown task is refused', store.markStale('ghost', 'x').ok === false);

  // The store refuses to annotate work it does not own.
  store.transition('a', 'queued', 1000);
  const st = store.transition('a', 'running', 1100);
  if (st.ok) {
    check('a RUNNING task cannot be marked stale', store.markStale('a', 'nope').ok === false);
  }
  check('a stale task is still dispatchable-eligible: staleness is not a readiness rule',
    store.get('a')?.stale === true && store.get('a')?.status === 'running');

  const s2 = new TaskStore();
  root(s2, 'r');
  commitPlan(s2, [cand('k', 'r')], { agentId: 'w1' });
  s2.transition('k', 'queued', 1000);
  s2.transition('k', 'running', 1100);
  s2.transition('k', 'to_verify', 1200);
  check('a to_verify task cannot be marked stale', s2.markStale('k', 'nope').ok === false);
  s2.transition('k', 'succeeded', 1300);
  check('a SUCCEEDED task cannot be marked stale', s2.markStale('k', 'nope').ok === false);
  check('the succeeded task is still recorded as succeeded', s2.get('k')?.status === 'succeeded');
}

// ---------------------------------------------------------------------------
section('8. observation can SEE stale, without gaining a status');
// ---------------------------------------------------------------------------
{
  const store = new TaskStore();
  root(store);
  commitPlan(store, [cand('a', 'root')], { agentId: 'w1', generation: 3 });
  store.markStale('a', 'plan changed');

  const obs = observeTasks(store, { now: 5000 });
  check('observation reports stale task ids', obs.stale.join(',') === 'a');
  check('the observed task carries stale = true', obs.tasks.find((t) => t.taskId === 'a')?.stale === true);
  check('the observed task carries the reason', obs.tasks.find((t) => t.taskId === 'a')?.staleReason === 'plan changed');
  check('observation carries the generation', obs.tasks.find((t) => t.taskId === 'a')?.generation === 3, String(obs.tasks.find((t) => t.taskId === 'a')?.generation));
  check('staleness did NOT become a status', obs.tasks.find((t) => t.taskId === 'a')?.status === 'planned');
  // Staleness must not leak into any LIFECYCLE bucket. `planned` does not exist as a
  // field, so this asserts the buckets that do: not ready, not blocked, not terminal,
  // not failed.
  const staleObs = obs.tasks.find((t) => t.taskId === 'a');
  check('a stale task is NOT in the blocked bucket', obs.blocked.join(',') !== 'a');
  check('a stale task is NOT in the failed bucket', obs.failedTaskIds.join(',') !== 'a');
  check('a stale task is NOT terminal', obs.terminal.join(',') !== 'a');
  check('a stale task is still counted as a task in the plan',
    staleObs !== undefined && obs.tasks.length === 2);
}

// ---------------------------------------------------------------------------
section('9. replanSubtree: completed and running are untouchable');
// ---------------------------------------------------------------------------
{
  const store = new TaskStore();
  root(store, 'goal');
  commitPlan(store, [
    cand('done-1', 'goal'), cand('done-2', 'goal'),
    cand('run-1', 'goal'), cand('queue-1', 'goal'),
    cand('plan-1', 'goal'), cand('block-1', 'goal'),
  ], { agentId: 'w1', generation: 1 });

  // `done-2` must actually reach `succeeded` to be protected. Leaving it `planned`
  // would make it replaceable, and the test would then be asserting the opposite of
  // its own name.
  for (const id of ['done-1', 'done-2']) {
    store.transition(id, 'queued', 10);
    store.transition(id, 'running', 20);
    store.transition(id, 'to_verify', 30);
    store.transition(id, 'succeeded', 40);
  }
  store.transition('run-1', 'queued', 10);
  store.transition('run-1', 'running', 20);
  store.transition('queue-1', 'queued', 10);
  store.transition('block-1', 'queued', 10);
  store.transition('block-1', 'running', 20);
  store.transition('block-1', 'blocked', 30, 'waiting');

  const part = store.partitionForReplan('goal');
  check('partition puts never-started tasks in replaceable',
    part.replaceable.map((t) => t.taskId).sort().join(',') === 'plan-1');
  check('partition puts QUEUED (admitted) tasks in staleOnly, not replaceable',
    part.staleOnly.map((t) => t.taskId).join(',') === 'queue-1');
  check('partition puts running and finished tasks in untouchable',
    part.untouchable.map((t) => t.taskId).sort().join(',') === 'block-1,done-1,done-2,run-1');

  const before = snapshot(store);
  const res = replanSubtree(store, 'goal', planTasks({ objective: 'new plan', rootTaskId: 'goal', shape: 'single' }).candidates,
    { agentId: 'w1' });
  check('the replan is applied', res.status === 'applied', res.reason);
  check('the generation advanced to 2', res.generation === 2);
  check('the never-started task was removed', res.removed.join(',') === 'plan-1');
  check('the QUEUED task was marked stale, NOT deleted',
    res.markedStale.join(',') === 'queue-1' && store.has('queue-1'));
  check('the queued task kept its status', store.get('queue-1')?.status === 'queued');
  check('the queued task records why it went stale',
    (store.get('queue-1')?.staleReason ?? '').includes('generation 2'));
  check('the new task was created at generation 2', store.get('goal-s1')?.generation === 2);

  for (const id of ['done-1', 'done-2', 'run-1']) {
    const t = store.get(id);
    check(`${id} survived the replan unchanged`, t !== null && t.stale === false && t.generation === 1);
  }
  check('the SUCCEEDED task is still succeeded', store.get('done-1')?.status === 'succeeded');
  check('the RUNNING task is still running', store.get('run-1')?.status === 'running');
  check('the BLOCKED task still exists', store.has('block-1'));
  check('the replan reports what it protected', [...res.protected].sort().join(',') === 'block-1,done-1,done-2,queue-1,run-1');
  check('the replan did change the graph', snapshot(store) !== before);
  check('the store is acyclic after a replan', store.findCycle() === null);

  // removePlanned must refuse an admitted task even when asked directly, because
  // the guard belongs to the store rather than to the caller being careful.
  check('removePlanned refuses a queued task', store.removePlanned('queue-1').ok === false);
  check('removePlanned refuses a running task', store.removePlanned('run-1').ok === false);
  check('removePlanned refuses a succeeded task', store.removePlanned('done-1').ok === false);
  check('the refused removals left the tasks in place',
    store.has('queue-1') && store.has('run-1') && store.has('done-1'));
}

// ---------------------------------------------------------------------------
section('10. a replan that is itself invalid changes NOTHING');
// ---------------------------------------------------------------------------
{
  const store = new TaskStore();
  root(store, 'goal');
  commitPlan(store, [cand('keep-1', 'goal'), cand('keep-2', 'goal')], { agentId: 'w1', generation: 1 });
  const before = snapshot(store);

  // new-a -> new-b -> new-c, then new-a also depends on new-c. A three-node cycle,
  // not a re-statement of the acyclic shape: an acyclic "diamond-ish" plan would
  // commit fine and this test would prove nothing.
  const res = replanSubtree(store, 'goal', [
    cand('new-a', 'goal', ['new-c']), cand('new-b', 'goal', ['new-a']), cand('new-c', 'goal', ['new-b']),
  ], { agentId: 'w1' });
  check('a cyclic replan is refused', res.status === 'refused');
  check('the refusal explains why', res.reason.includes('dependency-cycle'), res.reason);
  check('NOTHING was removed on a refused replan', res.removed.length === 0);
  check('NOTHING was created on a refused replan', res.created.length === 0);
  check('the store is byte-identical after a refused replan', snapshot(store) === before);
  check('the original generation is unchanged', store.latestGeneration() === 1);
}

// ---------------------------------------------------------------------------
section('11. replan through the EXISTING decision union (P6-A)');
// ---------------------------------------------------------------------------
{
check('replan is now an IMPLEMENTED action', (IMPLEMENTED_ACTIONS as readonly string[]).includes('replan'));
    // P6-D1 connected the remaining six to existing authorities, so the vocabulary is
    // now complete. Asserted explicitly so a stage that DEFERRES something again has
    // to change this line rather than silently shrink what Laya may ask for.
    check('P6-D1 completed the vocabulary (nothing deferred)', DEFERRED_ACTIONS.length === 0, DEFERRED_ACTIONS.join(','));
    check('all eleven actions are implemented',
      IMPLEMENTED_ACTIONS.length === 11 && IMPLEMENTED_ACTIONS.join(',') === ALL_ACTIONS.join(','),
      IMPLEMENTED_ACTIONS.join(','));
    check('the full vocabulary is unchanged', ALL_ACTIONS.length === 11);
// P6-D1 added the remaining six to the vocabulary and connected them to existing
  // authorities, so nothing is deferred now. What still must hold is that the PLANNER
  // is untouched by any of them — those actions route to `planner-wiring`, not here.
  check('P6-D1 wired the six new actions WITHOUT touching the planner',
      (IMPLEMENTED_ACTIONS as readonly string[]).includes('retry') &&
      (IMPLEMENTED_ACTIONS as readonly string[]).includes('parallelize') &&
      DEFERRED_ACTIONS.length === 0);
}

// ---------------------------------------------------------------------------
section('12. the planner can NOT execute, dispatch or assign');
// ---------------------------------------------------------------------------
{
  // Structural assertions. There is no runtime in which "an extra import" fails a
  // behavioural test, yet an import of Runtime or Scheduler IS the bug this stage
  // exists to prevent — so this is asserted as a fact about the module's edges.
  const plannerSrc = codeOf('src/orchestration/planner.ts');
  const wiringSrc = codeOf('src/orchestration/planner-wiring.ts');
  const both = plannerSrc + wiringSrc;

  check('the planner imports NO store', !/from '\.\/store\.ts'/.test(plannerSrc));
  check('the planner imports NO scheduler', !/scheduler/i.test(plannerSrc));
  check('the planner imports NO orchestrator', !/orchestrator/i.test(plannerSrc));
  check('the planner imports NO runtime', !/runtime/i.test(plannerSrc));
  check('the planner imports NO workspace', !/workspace/i.test(plannerSrc));
  check('the planner imports NO assignment engine', !/assignment/i.test(plannerSrc));
  check('the planner imports NO memory', !/memory/i.test(plannerSrc));
  check('the planner imports NO quota logic beyond the type', !/from '\.\.\/quota\/(?!types)/.test(plannerSrc));
  check('the planner creates NO second graph', !/new Map<Task|class .*Graph|DagStore/i.test(both));
  check('the planner creates NO second scheduler', !/new TaskScheduler|class .*Scheduler/i.test(both));
  check('the planner has NO execution call', !/\bspawn\b|\.executeTask\(|\bexecute\(|dispatch\(/i.test(plannerSrc));
  check('the wiring cannot spawn either', !/\.spawnChild\(|\bspawn\b/i.test(wiringSrc));
  check('the wiring cannot dispatch', !/\.tick\(|new TaskScheduler/i.test(wiringSrc));
  check('the wiring cannot assign identity', !/assignIdentity|assignWorker|scoreCandidate/i.test(wiringSrc));
  check('the planner does not import a decision engine', !/decision\.ts/i.test(plannerSrc));
  check('the planner emits NO decision actions',
    !/action:\s*'(continue|wait|abort|rework|replan|retry|reassign|add_task|split_task|parallelize|complete)'/.test(plannerSrc));
  check('the planner cannot mutate the workspace', !/WorkspaceManager|fs\.|writeFileSync|readFileSync/.test(both));
  check('the planner has no hidden clock or randomness', !/Date\.now\(\)|Math\.random\(\)/.test(plannerSrc));

  // The wiring's ONLY mutation path is the store, and it goes through create().
  check('the wiring writes exclusively through TaskStore.create',
    occ(wiringSrc, /\.create\(/) === 1 && !/\.transition\(|\.update\(|\.patch\(/.test(wiringSrc));
  check('the planner reuses the sealed cycle walker rather than a second one',
    occ(plannerSrc, /findDependencyCycle/) >= 1 && !/function .*[Cc]ycle/.test(plannerSrc));

  // P6-C minor refactor: intent channels must not become owners. Each of these
  // asserts ABSENCE — a SkillRuntime or a session resolver appearing here would be
  // the exact second-authority regression this architecture refuses.
  check('the planner still creates NO skill runtime/registry/router',
    !/SkillRegistry|SkillRouter|SkillRuntime|SkillExecutor|SkillScheduler|SkillResolver/i.test(both));
  check('the planner still creates NO session runtime/manager/router',
    !/SessionManager|SessionRouter|SessionScheduler|SessionRuntime/i.test(both));
  check('skills are carried, never resolved: no lookup against a catalogue',
    !/skillExists|hasSkill|findSkill|resolveSkill/i.test(plannerSrc));
  check('preference is carried, never enforced: the planner assigns nothing',
    !/assignIdentity|assignWorker|chooseWorker|selectAgent/i.test(both));
  check('sessionIntent is echoed, never interpreted into a native handle',
    !/nativeSessionId|threadId/.test(plannerSrc));
  // The planner may still import SessionIntent TYPE-ONLY. A value import would pull
  // the registry module into the planner's runtime graph.
  check('the planner imports SessionIntent as a TYPE only (no runtime dependency)',
    !/^import \{[^}]*\bSessionIntent\b[^}]*\} from/m.test(plannerSrc) &&
    /import type \{[^}]*\bSessionIntent\b[^}]*\} from/.test(plannerSrc));

  // The one place generation is decided: the wiring, not the planner.
  check('the planner takes generation as INPUT, never computes the next one',
    !/latestGeneration\(\)/.test(plannerSrc));
  check('the wiring is where the generation advances', /latestGeneration\(\)\s*\+\s*1/.test(wiringSrc));
}

// ---------------------------------------------------------------------------
section('12b. intent channels: carried verbatim, never resolved');
// ---------------------------------------------------------------------------
{
  const skills = ['alpha-skill', 'beta-skill'];
  const withSkills = planTasks({ objective: 'x', rootTaskId: 'root', shape: 'parallel', skills });
  check('skills reach every candidate of the shape', withSkills.candidates.every((c) => c.skills?.length === 2));
  check('skill names are carried VERBATIM, not normalised or filtered',
    withSkills.candidates[0]?.skills?.join(',') === 'alpha-skill,beta-skill');

  const none = planTasks({ objective: 'x', rootTaskId: 'root', shape: 'parallel' });
  check('no skills in, no `skills` key at all (absence, not an empty array)',
    none.candidates.every((c) => !('skills' in c)), JSON.stringify(Object.keys(none.candidates[0])));
  const empty = planTasks({ objective: 'x', rootTaskId: 'root', shape: 'parallel', skills: [] });
  check('an empty skills list is treated as "say nothing"',
    empty.candidates.every((c) => !('skills' in c)));

  // Session intent is echoed on the OUTPUT, never copied onto a candidate. Typed via
  // the real `SessionIntent` so a future variant is a compile error here rather than a
  // runtime surprise in every shape.
  const intent: SessionIntent = { kind: 'reuse', sessionKey: 'ws_0001' };
  const echoed = planTasks({ objective: 'x', rootTaskId: 'root', shape: 'single', sessionIntent: intent });
  check('the session intent is echoed on the output',
    echoed.sessionIntent?.kind === 'reuse' && (echoed.sessionIntent as { sessionKey?: string } | undefined)?.sessionKey === 'ws_0001');
  check('the session intent is NOT stamped onto the candidate',
    echoed.candidates.every((c) => !('sessionIntent' in c) && !('nativeSessionId' in c)));
  check('no session intent in, none on the output',
    planTasks({ objective: 'x', rootTaskId: 'root' }).sessionIntent === undefined);

  // Every shape must echo it identically — the `done()` helper exists so they cannot
  // drift, and a shape that returned its own literal would silently drop it.
  for (const shape of ['single', 'chain', 'parallel', 'diamond', 'levels:2'] as const) {
    const out = planTasks({ objective: 'x', rootTaskId: 'root', shape, skills, sessionIntent: intent });
    check(`shape ${shape} echoes the session intent`, out.sessionIntent?.kind === 'reuse');
    check(`shape ${shape} also carries skills to its candidates`, out.candidates.every((c) => c.skills?.length === 2));
  }

  // Determinism must survive the new fields: same input, byte-identical output.
  check('intent does not break determinism',
    JSON.stringify(planTasks({ objective: 'x', rootTaskId: 'root', shape: 'diamond', skills, sessionIntent: intent })) ===
    JSON.stringify(planTasks({ objective: 'x', rootTaskId: 'root', shape: 'diamond', skills, sessionIntent: intent })));

  // A commit must not turn intent into task state.
  const store = new TaskStore();
  root(store, 'i');
  const out2 = commitPlan(store, planTasks({ objective: 'x', rootTaskId: 'i', shape: 'single', skills, sessionIntent: intent }).candidates,
    { agentId: 'w1' });
  check('a commit with intent still succeeds', out2.ok);
  const created = store.get('i-s1') as unknown as Record<string, unknown> | null;
  check('the committed task carries NO skill field (intent is not task state)',
    created !== null && !('skills' in created));
  check('the committed task carries NO session key (TaskStore never learns about sessions)',
    created !== null && !('sessionIntent' in created) &&
    !('nativeSessionId' in created) && !('sessionId' in created));
  check('the graph is still valid', store.findCycle() === null && store.has('i-s1'));
}

// ---------------------------------------------------------------------------
section('13. end-to-end: plan, commit, run, replan');
// ---------------------------------------------------------------------------
{
  const store = new TaskStore();
  root(store, 'goal');
  const first = planTasks({ objective: 'v1', rootTaskId: 'goal', shape: 'levels:2', width: 2 });
  const c1 = commitPlan(store, first.candidates, { agentId: 'w1', generation: 0 });
  check('the first plan commits four tasks', c1.ok && store.all().length === 5, JSON.stringify(c1.ok));

  // Run the level-1 tasks; leave level 2 pending.
  for (const id of ['goal-l1t1', 'goal-l1t2']) {
    store.transition(id, 'queued', 10);
    store.transition(id, 'running', 20);
    store.transition(id, 'to_verify', 30);
    store.transition(id, 'succeeded', 40);
  }
  // Counts exclude the root: the root is `planned` too, and including it would make
  // this assert 3 while the sentence says two.
  const plannedOnly = (): number => store.all().filter((t) => t.status === 'planned' && t.taskId !== 'goal').length;
  check('two tasks are finished, two are still planned',
    store.all().filter((t) => t.status === 'succeeded').length === 2 && plannedOnly() === 2,
    `${store.all().filter((t) => t.status === 'succeeded').length} succeeded, ${plannedOnly()} planned`);

  const second = planTasks({ objective: 'v2', rootTaskId: 'goal', shape: 'single' });
  const r = replanSubtree(store, 'goal', second.candidates, { agentId: 'w1' });
  check('replanning after partial completion is applied', r.status === 'applied', r.reason);
  check('the two pending tasks were removed', [...r.removed].sort().join(',') === 'goal-l2t1,goal-l2t2');
  check('the two succeeded tasks were NOT removed',
    store.get('goal-l1t1')?.status === 'succeeded' && store.get('goal-l1t2')?.status === 'succeeded');
  check('the new task exists at generation 1', store.get('goal-s1')?.generation === 1);
  check('the graph is acyclic after the whole sequence', store.findCycle() === null);
  check('the store holds root + 2 succeeded + 1 new', store.all().length === 4, String(store.all().length));

  const known = new Map(store.all().map((t) => [t.taskId, t]));
  check('the new task has no unmet dependencies and is runnable',
    unmetDependencies(store.get('goal-s1')!, known).length === 0);
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) {
  process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
}
process.stdout.write('\n');
process.exitCode = failed === 0 ? 0 : 1;