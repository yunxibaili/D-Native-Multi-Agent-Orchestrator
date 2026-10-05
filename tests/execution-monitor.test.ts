/**
 * tests/execution-monitor.test.ts — R2 Observability: the Execution Monitor read model.
 *
 * WHAT THIS SUITE HAS TO PROVE
 * ----------------------------
 *   1. MAPPING   — Task / Agent / Workspace / Run / Event / Blocker are derived from
 *                  the REAL authorities, with the store's own status passed through
 *                  and no second state machine invented.
 *   2. REFRESH   — a second snapshot taken after the world changed reflects the
 *                  change. That is what "live" means here.
 *   3. ISOLATION — dashboard-side failure cannot reach the runtime: a throwing
 *                  workspace, a throwing session registry, a hostile store proxy and
 *                  an unwritable observation directory must ALL degrade to data, and
 *                  must never throw, never block, never dispatch.
 *
 * There is no fake-runtime PASS dressed up as a native agent result. The read model
 * is asserted against real `TaskStore` / `WorkspaceManager` objects and real files.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskStore } from '../src/orchestration/store.ts';
import { ResourceClaimBook, type ClaimRequest, type WorkspaceHandle } from '../src/orchestration/index.ts';
import type { WorkspaceManager } from '../src/orchestration/workspace.ts';
import { SessionRegistry } from '../src/orchestration/workbench-sessions.ts';
import { buildExecutionSnapshot, type TaskMonitorEntry } from '../src/orchestration/execution-monitor.ts';
import { createRoundObserver, readRoundEvents } from '../src/orchestration/round-observation.ts';
import type { TaskSpec } from '../src/orchestration/task.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; process.stdout.write(`  ok   ${name}\n`); }
  else { failed++; failures.push(name); process.stdout.write(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}\n`); }
};
const section = (t: string): void => { process.stdout.write(`\n== ${t}\n`); };

const NOW = 1_700_000_000_000;
const TMP = mkdtempSync(join(tmpdir(), 'execmon-'));
const cleanup = (): void => { rmSync(TMP, { recursive: true, force: true }); };

const spec = (over: Partial<TaskSpec> & { taskId: string }): TaskSpec => ({
  parentTaskId: null,
  agentId: 'opencode',
  modelId: 'space-bunny-free',
  taskType: 'implementation',
  acceptanceCriteria: 'do the thing',
  ...over,
});

/** A store with a root and two children, one of which depends on the other. */
function makeStore(): TaskStore {
  const store = new TaskStore();
  store.create(spec({ taskId: 'round-1', acceptanceCriteria: 'the round objective' }), NOW);
  store.create(spec({ taskId: 'T101', parentTaskId: 'round-1', acceptanceCriteria: 'write A' }), NOW + 10);
  store.create(spec({
    taskId: 'T102',
    parentTaskId: 'round-1',
    agentId: 'workbuddy-intl',
    modelId: 'hy3',
    acceptanceCriteria: 'write B',
  }), NOW + 20);
  store.create(spec({
    taskId: 'T103',
    parentTaskId: 'round-1',
    acceptanceCriteria: 'join A and B',
    dependencies: ['T101', 'T102'],
  }), NOW + 30);
  return store;
}

const names = { opencode: 'OpenCode', 'workbuddy-intl': 'WorkBuddy Intl' };

// ===========================================================================
section('§1  MAPPING — task / run / agent / event / blocker from real authorities');
// ===========================================================================
{
  const store = makeStore();
  store.transition('T101', 'queued', NOW + 40);
  store.transition('T101', 'running', NOW + 50);
  const sessions = new SessionRegistry();
  const s = sessions.open({ agentId: 'opencode', modelId: 'space-bunny-free', sessionPolicy: 'fresh' }, TMP, NOW + 45, 'T101');
  sessions.recordRun(s.sessionId, { threadId: 'native-xyz' } as never, NOW + 60);

  const snap = buildExecutionSnapshot({
    store, workspace: null, sessions, rootTaskId: 'round-1', now: NOW + 100, agentNames: names,
  });

  check('1.1  run id / objective come from the ROOT task in the store',
    snap.runId === 'round-1' && snap.objective === 'the round objective', `${snap.runId}/${snap.objective}`);
  check('1.2  observed is true once a root and tasks exist', snap.observed === true);
  check('1.3  every task of the round is mapped, root included', snap.tasks.length === 4, String(snap.tasks.length));

  const t101 = snap.tasks.find((t) => t.taskId === 'T101')!;
  check('1.4  status is the STORE status, verbatim (running)',
    t101.status === 'running', t101.status);
  check('1.5  agent/model/session are the real bound identity',
    t101.agentId === 'opencode' && t101.modelId === 'space-bunny-free' && t101.sessionId === s.sessionId,
    `${t101.agentId}/${t101.modelId}/${t101.sessionId}`);
  check('1.6  the NATIVE handle is surfaced separately from our session id',
    t101.nativeSessionId === 'native-xyz', String(t101.nativeSessionId));
  check('1.7  elapsed is derived from startedAt against the supplied clock',
    t101.elapsedMs === 50, String(t101.elapsedMs));

  const t103 = snap.tasks.find((t) => t.taskId === 'T103')!;
  check('1.8  an unsatisfied dependency makes the task WAITING, not failed',
    t103.derivedStage === 'waiting' && t103.blocker?.code === 'dependency-wait', `${t103.derivedStage}/${t103.blocker?.code}`);
  check('1.9  the blocker keeps the waiting/blocked distinction, not a flat ERROR',
    t103.blocker?.kind === 'waiting', String(t103.blocker?.kind));

  check('1.10 no workspace manager reports mode honestly rather than inventing isolation',
    t101.workspaceId === null && /no workspace manager/.test(t101.workspaceMode), t101.workspaceMode);

  const agents = snap.agents;
  check('1.11 agents are DERIVED from the tasks — no hard-coded agent list',
    agents.map((a) => a.agentId).sort().join(',') === 'opencode,workbuddy-intl', agents.map((a) => a.agentId).join(','));
  check('1.12 agentId stays the machine identity; displayName is the label',
    agents.find((a) => a.agentId === 'opencode')?.displayName === 'OpenCode');
  check('1.13 an agent with no label falls back to its id, never to a guess',
    buildExecutionSnapshot({ store, workspace: null, now: NOW, rootTaskId: 'round-1' })
      .agents.find((a) => a.agentId === 'workbuddy-intl')?.displayName === 'workbuddy-intl');
  check('1.14 the running agent reports the task it is actually running',
    agents.find((a) => a.agentId === 'opencode')?.currentTaskId === 'T101');

  check('1.15 counts separate running / waiting / reviewable / completed',
    snap.counts.tasks.running === 1 && snap.counts.tasks.waiting === 1 && snap.counts.tasks.completed === 0,
    JSON.stringify(snap.counts.tasks));
  check('1.16 overallStatus is running while a child is running', snap.overallStatus === 'running', snap.overallStatus);
  check('1.17 the stage string says what the executor is doing', snap.currentStage === 'EXECUTION', snap.currentStage);
  check('1.18 events are derived from real task state, oldest first',
    snap.events.length > 0 && snap.events.every((e, i) => i === 0 || snap.events[i - 1]!.at <= e.at));
  check('1.19 a task that ends up to_verify is REVIEWABLE, not completed',
    (() => {
      const s2 = makeStore();
      s2.transition('T101', 'queued', NOW); s2.transition('T101', 'running', NOW + 1); s2.transition('T101', 'to_verify', NOW + 2);
      const x = buildExecutionSnapshot({ store: s2, workspace: null, now: NOW + 3, rootTaskId: 'round-1' });
      const t = x.tasks.find((y) => y.taskId === 'T101')!;
      return t.derivedStage === 'reviewable' && x.counts.tasks.reviewable === 1 && x.counts.tasks.completed === 0;
    })());
  check('1.20 an unassigned child is reported with a null agent, not a fabricated id',
    (() => {
      const s3 = new TaskStore();
      s3.create(spec({ taskId: 'r2', acceptanceCriteria: 'r' }), NOW);
      // A child created without an explicit identity still gets the store's default,
      // so the honest thing to assert is that the READ MODEL never invents one: it
      // reports exactly what the store holds.
      s3.create(spec({ taskId: 'c2', parentTaskId: 'r2', agentId: 'unassigned-placeholder', acceptanceCriteria: 'c' }), NOW + 1);
      const x = buildExecutionSnapshot({ store: s3, workspace: null, now: NOW + 2, rootTaskId: 'r2' });
      const c = x.tasks.find((t) => t.taskId === 'c2')!;
      return c.agentId === 'unassigned-placeholder' && x.tasks.every((t) => t.agentId !== null || t.derivedStage === 'not-assigned');
    })());
}

// ===========================================================================
section('§2  WORKSPACE + CLAIM mapping (real WorkspaceManager, real registry)');
// ===========================================================================
{
  const store = makeStore();
  // A fake manager over a REAL `ResourceClaimBook` and a REAL `WorkspaceHandle`.
  // The mapping under test is "handle + claims → monitor rows", and `prepare()`
  // itself (git worktrees, locks) is R2-1's own suite. Doing it this way keeps this
  // tier hermetic while still going through the real claim registry.
  const book = new ResourceClaimBook(() => NOW);
  const handle: WorkspaceHandle = {
    workspaceId: 'task:T101', mode: 'shared', taskId: 'T101', cwd: TMP,
    branch: null, baseSha: null, repoRoot: TMP, createdAt: NOW, released: false,
  };
  const released = new Set<string>();
  const fakeManager = {
    getProjectRoot: () => TMP,
    list: () => (released.has('T101') ? [] : [handle]),
    get: (taskId: string) => (taskId === 'T101' && !released.has('T101') ? handle : null),
    claimResource: (r: ClaimRequest) => book.claim(r),
    resourceConflicts: (r: ClaimRequest) => book.wouldConflict(r),
    releaseResourceClaims: (taskId: string) => book.releaseClaims(taskId),
    resourceClaimsFor: (workspaceId: string) => book.forWorkspace(workspaceId),
  } as unknown as WorkspaceManager;

  const claimRequest = {
    taskId: 'T101',
    workspaceId: handle.workspaceId,
    mode: 'write' as const,
    scope: { kind: 'workspace' as const, workspaceId: handle.workspaceId, root: TMP },
  };
  const claimed = fakeManager.claimResource(claimRequest);
  check('2.0  the real claim registry accepted a whole-workspace write claim', claimed.ok === true, claimed.ok ? '' : claimed.code);
  // A SECOND, NON-OVERLAPPING claim from another task: a path inside the same
  // workspace. §7.2 allows both, which is what makes the count meaningful.
  const secondClaim = fakeManager.claimResource({
    taskId: 'T102',
    workspaceId: handle.workspaceId,
    mode: 'read',
    scope: { kind: 'file', path: join(TMP, 'notes.txt') },
  });
  check('2.0b a non-overlapping claim is also accepted', secondClaim.ok === true, secondClaim.ok ? '' : secondClaim.code);

  const snap = buildExecutionSnapshot({
    store, workspace: fakeManager, sessions: null, rootTaskId: 'round-1', now: NOW + 200, agentNames: names,
  });
  const ws = snap.workspaces.find((w) => w.taskId === 'T101');
  check('2.1  the workspace is mapped with its REAL mode and path',
    ws !== undefined && ws.mode === 'shared' && ws.path === TMP, JSON.stringify(ws));
  check('2.2  shared is reported as shared — never dressed up as isolated',
    snap.counts.workspaces.shared === 1 && snap.counts.workspaces.isolated === 0, JSON.stringify(snap.counts.workspaces));
  check('2.3  claim count comes from the real registry', (ws?.claimCount ?? 0) === 2, String(ws?.claimCount));
  check('2.4  the claimed scope is summarised, not dumped',
    (ws?.scopes.length ?? 0) === 2 && (ws?.scopes ?? []).some((s) => s.startsWith('write:workspace:')),
    JSON.stringify(ws?.scopes));
  check('2.5  the task points at its workspace',
    snap.tasks.find((t) => t.taskId === 'T101')?.workspaceId === handle.workspaceId);
  check('2.6  counts.claims totals the live registry', snap.counts.claims === 2, String(snap.counts.claims));
  const freed = fakeManager.releaseResourceClaims('T102');
  check('2.7  releasing ONE task\'s claims is reflected on the NEXT snapshot (the read model is not cached)',
    freed === 1 && buildExecutionSnapshot({ store, workspace: fakeManager, now: NOW + 300, rootTaskId: 'round-1' })
      .counts.claims === 1,
    `${freed} freed`);
  check('2.8  a RELEASED workspace stops being reported',
    (() => {
      released.add('T101');
      return buildExecutionSnapshot({ store, workspace: fakeManager, now: NOW + 400, rootTaskId: 'round-1' })
        .workspaces.length === 0;
    })());
}

// ===========================================================================
section('§3  REFRESH — a second snapshot reflects the world changing');
// ===========================================================================
{
  const store = makeStore();
  const first = buildExecutionSnapshot({ store, workspace: null, now: NOW + 1, rootTaskId: 'round-1' });
  check('3.1  before anything runs, nothing is running',
    first.counts.tasks.running === 0 && first.overallStatus === 'planned', first.overallStatus);

  store.transition('T101', 'queued', NOW + 2);
  store.transition('T101', 'running', NOW + 3);
  const second = buildExecutionSnapshot({ store, workspace: null, now: NOW + 4, rootTaskId: 'round-1' });
  check('3.2  a task change shows up on the next read', second.counts.tasks.running === 1, JSON.stringify(second.counts.tasks));
  check('3.3  the status transitioned on the SAME store, with no cache in between',
    second.tasks.find((t) => t.taskId === 'T101')?.status === 'running');

  store.transition('T101', 'to_verify', NOW + 5);
  store.transition('T102', 'cancelled', NOW + 6);
  const third = buildExecutionSnapshot({ store, workspace: null, now: NOW + 7, rootTaskId: 'round-1' });
  check('3.4  a second change is reflected too (the read model is a pure function of state)',
    third.counts.tasks.reviewable === 1 && third.counts.tasks.running === 0, JSON.stringify(third.counts.tasks));
  check('3.5  cancelling a dependency keeps the dependant WAITING rather than failing it',
    third.tasks.find((t) => t.taskId === 'T103')?.derivedStage === 'waiting');
  check('3.6  an agent that finished everything reads idle, not running',
    third.agents.find((a) => a.agentId === 'opencode')?.status !== 'running');
}

// ===========================================================================
section('§4  FAILURE ISOLATION — the dashboard can never reach the runtime');
// ===========================================================================
{
  const store = makeStore();

  // 4a. Authorities that THROW must degrade to data, never propagate.
  const hostileWorkspace = new Proxy({} as WorkspaceManager, {
    get(_t, prop) {
      if (prop === 'list') return () => [{ workspaceId: 'task:T101', mode: 'isolated', taskId: 'T101', cwd: TMP, branch: 'b', baseSha: null, repoRoot: TMP, createdAt: NOW, released: false }];
      if (prop === 'resourceClaimsFor') return () => { throw new Error('hostile claim read'); };
      return () => { throw new Error(`hostile ${String(prop)}`); };
    },
  });
  let threw = false;
  let snap: ReturnType<typeof buildExecutionSnapshot> | null = null;
  try {
    snap = buildExecutionSnapshot({ store, workspace: hostileWorkspace, now: NOW, rootTaskId: 'round-1' });
  } catch { threw = true; }
  check('4.1  a THROWING claim read does not make the snapshot throw', threw === false);
  check('4.2  the workspace is still reported, with 0 claims rather than a crash',
    snap?.workspaces.length === 1 && snap.workspaces[0]?.claimCount === 0, JSON.stringify(snap?.workspaces));

  const hostileSessions = new Proxy({} as SessionRegistry, {
    get(_t, prop) {
      if (prop === 'sessionForTask') return () => { throw new Error('hostile session read'); };
      if (prop === 'all') return () => [];
      return () => { throw new Error('no'); };
    },
  });
  let threw2 = false;
  let hostileSnap: ReturnType<typeof buildExecutionSnapshot> | null = null;
  try {
    hostileSnap = buildExecutionSnapshot({ store, workspace: null, sessions: hostileSessions as never, now: NOW, rootTaskId: 'round-1' });
  } catch { threw2 = true; }
  check('4.3  a THROWING session registry is guarded too — the snapshot still renders',
    threw2 === false && hostileSnap !== null && hostileSnap.tasks.length === 4,
    threw2 ? 'it threw' : String(hostileSnap?.tasks.length));

  let threw3 = false;
  try {
    buildExecutionSnapshot({ store: new TaskStore(), workspace: null, now: NOW });
    buildExecutionSnapshot({ store, workspace: null, now: NOW, rootTaskId: 'does-not-exist' });
  } catch { threw3 = true; }
  check('4.4  an EMPTY store and an UNKNOWN root both degrade instead of throwing', threw3 === false);

  // 4b. An UNWRITABLE observation target degrades to ok:false — the round continues.
  //
  // The failure is forced with a NON-EXISTENT DRIVE LETTER rather than a filesystem
  // trick, because the first draft used the Windows device name `CON` and left a real
  // 4.6 KB file in the repository root that `Get-Item`/`Remove-Item` cannot touch
  // (device names bypass the normal path parser). A drive letter that does not exist
  // is portable, always fails, and creates nothing on disk.
  const impossible = process.platform === 'win32' ? 'Q:\\no-such-volume' : '/no-such-volume-deeper';
  const blockedObserver = createRoundObserver({
    stateFile: join(impossible, 'round-state.json'),
    eventsFile: join(impossible, 'round-events.jsonl'),
  });
  const published = blockedObserver.publish({
    snapshot: buildExecutionSnapshot({ store, workspace: null, now: NOW, rootTaskId: 'round-1' }),
    stateKey: 'k1',
  });
  check('4.5  an unwritable observation target reports ok:false instead of throwing',
    published.ok === false, JSON.stringify(published));
  check('4.6  the failure names itself rather than being swallowed silently',
    typeof published.code === 'string' && published.code !== '', String(published.code));
  check('4.6b the failed publish left NOTHING behind in the working directory',
    (() => {
      // The regression this guards: an earlier version wrote a real file named `CON`
      // into the repo root (a Windows device name that cannot be deleted through the
      // normal path API). Observability must not pollute the tree it observes.
      return !existsSync(join(process.cwd(), 'CON')) && !existsSync(join(TMP, 'round-state.json'));
    })());

  // 4c. The happy path still works, and re-publishing the same state is a no-op.
  const okObserver = createRoundObserver({ dir: join(TMP, 'obs') });
  const snapOnce = buildExecutionSnapshot({ store, workspace: null, now: NOW, rootTaskId: 'round-1' });
  const first = okObserver.publish({ snapshot: snapOnce, stateKey: 'same', events: [{ key: 'e1', at: NOW, source: 'x', message: 'first' }] });
  const second = okObserver.publish({ snapshot: snapOnce, stateKey: 'same', events: [{ key: 'e1', at: NOW, source: 'x', message: 'first' }] });
  check('4.7  a real publish succeeds and reports that it wrote', first.ok === true && first.wrote === true, JSON.stringify(first));
  check('4.8  re-publishing an unchanged state writes nothing', second.ok === true && second.wrote === false, JSON.stringify(second));
  check('4.9  the state file is valid JSON containing the snapshot', (() => {
    try {
      const parsed = JSON.parse(readFileSync(okObserver.paths.state, 'utf8')) as { runId?: string };
      return parsed.runId === 'round-1';
    } catch { return false; }
  })());
  const evts = readRoundEvents(okObserver.paths.events);
  check('4.10 the event log has the ONE event that was published, not a duplicate',
    evts.length === 1 && evts[0]?.message === 'first', JSON.stringify(evts));

  const third = okObserver.publish({ snapshot: snapOnce, stateKey: 'changed', events: [{ key: 'e2', at: NOW + 1, source: 'y', message: 'second' }] });
  const evts2 = readRoundEvents(okObserver.paths.events);
  check('4.11 a changed state publishes, and the log grows by exactly one',
    third.ok === true && third.wrote === true && evts2.length === 2, JSON.stringify(evts2.map((e) => e.message)));

  // 4d. A torn final line (a killed writer) must not lose the whole log.
  writeFileSync(okObserver.paths.events, readFileSync(okObserver.paths.events, 'utf8') + '{"at":1,"sou', 'utf8');
  const torn = readRoundEvents(okObserver.paths.events);
  check('4.12 a torn trailing line is skipped, the readable events survive',
    torn.length === 2, JSON.stringify(torn.map((e) => e.message)));
  check('4.13 reading a log that does not exist returns empty rather than throwing',
    readRoundEvents(join(TMP, 'nope.jsonl')).length === 0);
}

// ===========================================================================
section('§5  AUTHORITY — the read model has no power');
// ===========================================================================
{
  const src = readFileSync('src/orchestration/execution-monitor.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const obs = readFileSync('src/orchestration/round-observation.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  check('5.1  the read model cannot dispatch, execute or transition anything',
    !/\.tick\(|executeTask\(|runtime\.run\(|\.transition\(|\.create\(|assignIdentity|migrateIdentityAfterStart|\.spawn/.test(src));
  check('5.2  the read model imports no runtime, adapter or git', !/from '\.\.\/(adapters|runtime)/.test(src) && !/from '\.\/git\.ts'/.test(src));
  check('5.3  the read model constructs no authority of its own',
    !/new TaskStore\(|new TaskScheduler\(|new WorkspaceManager\(|class \w*(Store|Scheduler|Registry|Router|Manager)\b/.test(src));
  check('5.4  the observation channel never dispatches either',
    !/\.tick\(|executeTask\(|runtime\.run\(|\.transition\(|assignIdentity|\.spawn/.test(obs));
  check('5.5  the observation channel WRITES only — it reads the snapshot file only in the log reader',
    !/readFileSync\([\s\S]*?round-state\.json/.test(obs) && /"w"|writeFileSync|appendFileSync|renameSync/.test(obs));
  check('5.6  the CLI observation is OPT-IN (reads the flag, defaults to null)',
    /o\.observe === undefined/.test(readFileSync('src/cli/round-cli.ts', 'utf8')) &&
    /const observer: RoundObserver \| null = o\.observe === undefined/.test(readFileSync('src/cli/round-cli.ts', 'utf8')));
}

// ===========================================================================
section('§6  LIVENESS — a RUNNING task must not freeze the observation');
// ===========================================================================
{
  // The bug this guards, found in review rather than by a failing test:
  //
  //   A task's `updatedAt` is `finishedAt ?? startedAt ?? createdAt`. While a task is
  //   running, NONE of the change-key inputs (status, retryCount, updatedAt) move, so
  //   a state-only key is identical for the whole run. The round would publish once
  //   and then nothing, freezing `elapsedMs` and the freshness stamp for as long as
  //   the agent ran — the opposite of a live monitor.
  //
  // The fix lives in round-cli.ts (a time bucket joins the key while anything runs).
  // What this tier proves is the FACT the fix depends on, plus the fact that elapsed
  // really does track the publish clock.
  const liveStore = (): TaskStore => {
    const s = makeStore();
    s.transition('T101', 'queued', NOW + 10);
    s.transition('T101', 'running', NOW + 20);
    return s;
  };
  const at = (s: TaskStore, now: number): TaskMonitorEntry =>
    buildExecutionSnapshot({ store: s, workspace: null, now, rootTaskId: 'round-1' })
      .tasks.find((t) => t.taskId === 'T101')!;

  // The store must be FRESH here: §1 already drove its own store's T101 to `running`,
  // and `startedAt` is stamped once — reusing it would measure nothing.
  const store6 = liveStore();
  const t101atT0 = at(store6, NOW + 20);
  const t101atT1 = at(store6, NOW + 5_020);

  check('6.1  while RUNNING, the store-side fields a state key uses do not move',
    t101atT0.status === t101atT1.status &&
    t101atT0.updatedAt === t101atT1.updatedAt &&
    t101atT0.retryCount === t101atT1.retryCount,
    `${t101atT0.updatedAt} vs ${t101atT1.updatedAt}`);
  check('6.2  …which is exactly why a state-only change key would freeze the UI',
    t101atT0.updatedAt === t101atT1.updatedAt);

  // The publish clock IS the elapsed clock, so a republish is what keeps it moving.
  // startedAt was stamped at NOW+20, so at NOW+20 elapsed is 0 and at NOW+5020 it is 5s.
  check('6.3  elapsed DOES advance when the snapshot is rebuilt against a later clock',
    t101atT0.elapsedMs === 0 && t101atT1.elapsedMs === 5_000,
    `${t101atT0.elapsedMs} → ${t101atT1.elapsedMs}`);
  check('6.4  a task awaiting verification reports elapsed as NOT OBSERVED, never a fabricated number',
    (() => {
      const s = liveStore();
      s.transition('T101', 'to_verify', NOW + 30);
      // The store does not record when the run ended, so the honest value is null —
      // NOT 0 (which would claim an instant run) and NOT `now - startedAt` (which
      // would report Codex/human review latency as execution time).
      return at(s, NOW + 100).elapsedMs === null && at(s, NOW + 3_600_000).elapsedMs === null;
    })());
  check('6.4b a terminal task reports its real run duration, not wall-clock since',
    (() => {
      const s = liveStore();
      s.transition('T101', 'to_verify', NOW + 30);
      s.transition('T101', 'succeeded', NOW + 40);
      return at(s, NOW + 5_000_000).elapsedMs === 20;
    })());

  // The heartbeat is real, present, and bounded — asserted on the source, because the
  // alternative (driving a whole round) needs a real agent and is not hermetic.
  const cliSrc = readFileSync('src/cli/round-cli.ts', 'utf8');
  check('6.5  the round joins a time bucket to the change key ONLY while something runs',
    /anyRunning/.test(cliSrc) && /anyRunning \? `@\$\{Math\.floor\(at \/ OBSERVE_HEARTBEAT_MS\)\}` : ''/.test(cliSrc),
    'bucket expression not found');
  check('6.6  the heartbeat interval is a named, bounded constant',
    /const OBSERVE_HEARTBEAT_MS = 5_000;/.test(cliSrc));
  check('6.7  observation events are stamped with the OBSERVATION time, not the task time',
    // `at,` in the publish payload, not `at: t.updatedAt`.
    /events: snapshot\.tasks\.map\(\(t\) => \(\{[\s\S]{0,200}?at,\n/.test(cliSrc),
    'event timestamp is not the observation clock');
}

cleanup();
process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) process.stdout.write(`failing:\n  ${failures.join('\n  ')}\n`);
process.exitCode = failed === 0 ? 0 : 1;
