/**
 * tests/resource-claim.test.ts - R2-1, Workspace / Resource Safety.
 *
 * THREE TIERS, KEPT DISTINCT ON PURPOSE (the R2 brief requires this and it is the
 * honest way to report):
 *
 *   §A  CONTRACT  - the scope normalizer and the §7.2 conflict matrix, as pure
 *                  functions. No git, no filesystem, no agent.
 *   §B  WORKSPACE - real git worktrees via the real `WorkspaceManager`: parallel
 *                  writers really do get separate directories, and that directory is
 *                  the one handed to `RunRequest.cwd`.
 *   §C  DISPATCH  - the admission check inside the real Orchestrator, over a fake
 *                  runtime. Proves the conflict is refused BEFORE `runtime.run`, and
 *                  that a conflict is NOT an agent failure.
 *
 * There is NO fake-runtime PASS presented as a real native agent result. Tier B is
 * real git; whether a real AGENT behaves is R2-1's native E2E, reported separately.
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ResourceClaimBook,
  WorkspaceManager,
  claimsConflict,
  modeRequiresIsolation,
  normalizeScope,
  normalizeScopeForRepository,
  normalizeScopeForWorkspace,
  scopeKey as scopeKeyOf,
  scopesOverlap,
  type ClaimRequest,
  type ResourceClaim,
  type ResourceClaimMode,
} from '../src/orchestration/index.ts';
import { Orchestrator as TaskOrchestrator } from '../src/orchestration/orchestrator.ts';
import { TaskStore } from '../src/orchestration/store.ts';
import type { Task } from '../src/orchestration/task.ts';
import { Orchestrator as RuntimeOrch } from '../src/orchestrator/orchestrator.ts';
import { BudgetManager, ModelRegistry } from '../src/quota/index.ts';
import { createFakeAdapter } from './helpers.ts';
import type { AgentDescriptor, RunRequest } from '../src/core/types.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; process.stdout.write(`  ok   ${name}\n`); }
  else { failed++; failures.push(name); process.stdout.write(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}\n`); }
};
const section = (t: string): void => { process.stdout.write(`\n== ${t}\n`); };

const NOW = 1_700_000_000_000;
const ROOT_A = 'D:\\project';
const claim = (
  taskId: string,
  mode: ResourceClaimMode,
  scope: ResourceClaim['scope'],
  workspaceId = 'task:x',
): ResourceClaim => ({ claimId: `claim:${taskId}`, taskId, leaseVersion: null, workspaceId, mode, scope, createdAt: NOW });
const dir = (p: string): ResourceClaim['scope'] => normalizeScope({ path: p, root: ROOT_A, kind: 'directory' });
const file = (p: string): ResourceClaim['scope'] => normalizeScope({ path: p, root: ROOT_A, kind: 'file' });

// ===========================================================================
section('§A1–A7  the §7.2 conflict matrix (pure)');
// ===========================================================================

check('A1: read + read is allowed', claimsConflict(claim('A', 'read', dir('src')), claim('B', 'read', dir('src'))) === false);
check('A2: write + write on the SAME file conflicts', claimsConflict(claim('A', 'write', file('src/a.ts')), claim('B', 'write', file('src/a.ts'))) === true);
check('A3: write + write on a NESTED file conflicts (dir vs file inside)',
  claimsConflict(claim('A', 'write', dir('src/auth')), claim('B', 'write', file('src/auth/login.ts'))) === true);
check('A4: write on a directory vs write on a file inside it conflicts',
  claimsConflict(claim('A', 'write', file('src/auth/login.ts')), claim('B', 'write', dir('src/auth'))) === true);
check('A5: unrelated directories do NOT conflict',
  claimsConflict(claim('A', 'write', dir('src/auth')), claim('B', 'write', dir('src/api'))) === false,
  'a shared string prefix must not be treated as a path overlap');
check('A5b: sibling names sharing a prefix are not nested (src/auth vs src/authentic)',
  scopesOverlap(dir('src/auth'), dir('src/authentic')) === false);
check('A6: exclusive-write + read conflicts',
  claimsConflict(claim('A', 'exclusive-write', dir('src')), claim('B', 'read', file('src/a.ts'))) === true);
check('A7: exclusive-write + write conflicts',
  claimsConflict(claim('A', 'write', dir('src')), claim('B', 'exclusive-write', file('src/a.ts'))) === true);
check('A7b: exclusive-write + anything overlapping conflicts, in both orders',
  claimsConflict(claim('B', 'read', file('src/a.ts')), claim('A', 'exclusive-write', dir('src'))) === true);

// §7.2 defines read+write as ALLOWED, resting on a documented assumption.
check('A8: read + write is ALLOWED by the frozen contract (§7.2)',
  claimsConflict(claim('A', 'read', dir('src')), claim('B', 'write', file('src/a.ts'))) === false);
check('A8b: non-overlapping read + write is allowed regardless',
  claimsConflict(claim('A', 'read', dir('src/a')), claim('B', 'write', dir('src/b'))) === false);
check('A9: the matrix is commutative',
  ['read', 'write', 'exclusive-write'].every((m) =>
    (['read', 'write', 'exclusive-write'] as const).every((n) =>
      claimsConflict(claim('A', m as ResourceClaimMode, dir('src')), claim('B', n as ResourceClaimMode, dir('src'))) ===
      claimsConflict(claim('B', n as ResourceClaimMode, dir('src')), claim('A', m as ResourceClaimMode, dir('src'))))));
check('A10: a task never conflicts with ITSELF (§7.3 idempotence premise)',
  claimsConflict(claim('A', 'write', dir('src')), claim('A', 'write', dir('src'))) === false);
// R2-1.1 (P1-a): a whole-workspace scope matches everything INSIDE ITSELF - which
// requires a root. These two are the same workspace, so containment holds.
check('A11: a whole-workspace scope overlaps a path inside that workspace',
  scopesOverlap(normalizeScopeForWorkspace('task:1', ROOT_A), file('src/anything.ts')) === true);
check('A12: repository scope overlaps a path inside that repository',
  scopesOverlap(normalizeScopeForRepository(ROOT_A), file('src/anything.ts')) === true);

// ===========================================================================
section('§A13–A19  scope normalization');
// ===========================================================================

check('N1: relative and absolute forms of the same path are ONE scope',
  scopesOverlap(file('src/auth'), file(`${ROOT_A}\\src\\auth`)) === true,
  JSON.stringify([file('src/auth'), file(`${ROOT_A}\\src\\auth`)]));
check('N2: slash vs backslash are the same path on Windows',
  scopesOverlap(dir('src/auth'), dir('src\\auth')) === true);
check('N3: a trailing separator is not a different scope',
  scopesOverlap(dir('src/auth/'), dir('src/auth')) === true);
check('N4: "." and ".." are resolved away',
  scopesOverlap(dir('src/auth/../api'), dir('src/api')) === true &&
  scopesOverlap(dir('./src/auth'), dir('src/auth')) === true);
check('N5: workspace root is addressable as a scope', (() => {
  const root = normalizeScope({ path: ROOT_A, root: ROOT_A, kind: 'directory' });
  return scopesOverlap(root, file('src/a.ts')) === true;
})());
check('N6: the Windows key is case-insensitive, matching the real filesystem',
  process.platform !== 'win32' || scopesOverlap(dir('SRC/Auth'), dir('src/auth')) === true);
check('N7: normalization is idempotent', (() => {
  const once = normalizeScope({ path: 'src/auth/', root: ROOT_A, kind: 'directory' });
  const twice = normalizeScope({ path: once.kind === 'directory' ? once.path : '', root: ROOT_A, kind: 'directory' });
  return JSON.stringify(once) === JSON.stringify(twice);
})());

// ===========================================================================
section('§A20  the claim book: registration, idempotence, release');
// ===========================================================================

{
  const book = new ResourceClaimBook(() => NOW);
  const req = (taskId: string, mode: ResourceClaimMode, scope: ResourceClaim['scope']): ClaimRequest =>
    ({ taskId, workspaceId: 'task:x', mode, scope });

  const first = book.claim(req('A', 'write', dir('src/auth')));
  check('B1: the first writer is registered', first.ok && first.created);

  const again = book.claim(req('A', 'write', dir('src/auth')));
  check('B2: the SAME task re-claiming the same scope is idempotent, not a conflict',
    again.ok && !again.created && again.claim.claimId === (first.ok ? first.claim.claimId : ''), JSON.stringify(again));

  const rival = book.claim(req('B', 'write', file('src/auth/login.ts')));
  check('B3: a rival writer on a nested file is REFUSED with resource-conflict',
    !rival.ok && rival.code === 'resource-conflict', JSON.stringify(rival).slice(0, 110));
  check('B4: the refusal names the holder and does NOT blame an agent',
    !rival.ok && rival.reason.includes('task "B"') && /NOT an agent failure/i.test(rival.reason),
    rival.ok ? '' : rival.reason.slice(0, 120));
  check('B5: the refusal carries the conflicting claims', !rival.ok && rival.conflicts.length === 1);
  check('B6: a REFUSED claim leaves no trace (nothing was registered)', book.all().length === 1);
  check('B7: wouldConflict answers without registering',
    book.wouldConflict(req('C', 'write', file('src/auth/login.ts'))).length === 1 && book.all().length === 1);

  check('B8: releasing a task drops its claims', book.releaseClaims('A') === 1 && book.all().length === 0);
  const afterRelease = book.claim(req('B', 'write', file('src/auth/login.ts')));
  check('B9: after release the scope is free', afterRelease.ok && afterRelease.created);
}

// ===========================================================================
section('§A20  WorkspaceManager owns the claims (existing authority, new methods)');
// ===========================================================================

{
  const repo = mkdtempSync(join(tmpdir(), 'r21-wm-'));
  const wm = new WorkspaceManager({ projectRoot: repo, workspaceLock: false, now: () => NOW });
  const r = (taskId: string, mode: ResourceClaimMode, scope: ResourceClaim['scope']): ClaimRequest =>
    ({ taskId, workspaceId: `task:${taskId}`, mode, scope });

  check('W1: WorkspaceManager exposes claim registration', wm.claimResource(r('a', 'write', dir('src'))).ok);
  check('W2: and refuses a conflicting claim on the same scope',
    wm.claimResource(r('b', 'write', file('src/x.ts'))).ok === false);
  check('W3: the conflict query is available for admission',
    wm.resourceConflicts(r('c', 'write', file('src/x.ts'))).length === 1);
  check('W4: claims are listed per workspace',
    wm.resourceClaimsFor('task:a').length === 1 && wm.resourceClaimCount === 1);
  check('W5: release works through the manager too', wm.releaseResourceClaims('a') === 1);

  check('W6: §8 - a PARALLEL writer may NOT share a workspace',
    WorkspaceManager.mayShareWorkspace('write', true) === false);
  check('W7: §8 - a SERIAL writer may reuse one',
    WorkspaceManager.mayShareWorkspace('write', false) === true);
  check('W8: §8 - parallel READ-ONLY work may share',
    WorkspaceManager.mayShareWorkspace('read', true) === true);
  check('W9: modeRequiresIsolation agrees with the share rule',
    modeRequiresIsolation('write') && modeRequiresIsolation('exclusive-write') && !modeRequiresIsolation('read'));

  removeTempTree(repo);
}

// ===========================================================================
section('§B  REAL git worktrees: parallel writers get different directories');
// ===========================================================================

/**
 * Delete a temp tree without ever being able to fail the run.
 *
 * Windows can briefly retain a handle after `git worktree` returns, so a bare
 * `rmSync` throws EPERM and - because it is not wrapped - kills the process before the
 * summary prints. That is what made this file "exit silently": the assertions had
 * already run and their results were discarded. Retrying, then warning, keeps a cleanup
 * fact from becoming a test verdict.
 */
function removeTempTree(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  } catch (e) {
    process.stdout.write(`[WARN] temp cleanup left ${path}: ${(e as Error).message}\n`);
  }
}

/** A real git repository, because an isolated workspace IS a worktree. */
function makeGitRepo(name: string): string {
  const repo = join(mkdtempSync(join(tmpdir(), 'r21-')), name);
  mkdirSync(repo, { recursive: true });
  const g = (...args: string[]): string =>
    execSync(`git ${args}`, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  g('init -q -b main');
  g('config user.name r21'); g('config user.email r21@r21'); g('config commit.gpgsign false');
  writeFileSync(join(repo, 'README.md'), '# r21\n');
  g('add -A'); g('commit -qm init');
  return repo;
}

{
  const repo = makeGitRepo('isolation');
  const wm = new WorkspaceManager({ projectRoot: repo, workspaceLock: false, now: () => NOW });

  // A serial writer may share; a parallel one must not.
  const serial = await wm.prepare({ taskId: 'serial', mode: 'shared', sharedCwd: repo });
  check('B10: a serial writer reuses the shared workspace', serial.mode === 'shared' && serial.cwd === repo, serial.cwd);

  const a = await wm.prepare({ taskId: 'par-a', mode: 'isolated' });
  const b = await wm.prepare({ taskId: 'par-b', mode: 'isolated' });
  check('B11: two parallel writers get DIFFERENT directories', a.cwd !== b.cwd, `${a.cwd} vs ${b.cwd}`);
  check('B12: neither is the shared project root', a.cwd !== repo && b.cwd !== repo);
  check('B13: each is a real worktree on its own branch',
    a.branch !== null && b.branch !== null && a.branch !== b.branch, `${a.branch} / ${b.branch}`);
  check('B14: each workspace has a distinct identity', a.workspaceId !== b.workspaceId, `${a.workspaceId} / ${b.workspaceId}`);
  check('B15: both directories really exist on disk', existsSync(a.cwd) && existsSync(b.cwd));
  check('B16: a shared workspace has no branch (it is not a checkout of its own)',
    serial.branch === null);

  removeTempTree(join(repo, '..'));
}

// ===========================================================================
section('§C  dispatch: conflict refused BEFORE runtime.run, and not an agent failure');
// ===========================================================================

/**
 * A real Orchestrator over a FAKE runtime, with a REAL WorkspaceManager and REAL
 * git worktrees, so the admission path under test is the production one. The fake
 * is only the agent process.
 */
async function dispatchHarness(opts: { claims: boolean; sharedMode?: boolean; holdFirstRun?: boolean }): Promise<{
  orch: TaskOrchestrator;
  requests: RunRequest[];
  repo: string;
  /** Bounded, loud-failing barrier: "the first N runs have reached the runtime". */
  waitForRuns: (n: number, label: string, timeoutMs?: number) => Promise<void>;
  /** Release the run held open by the harness, so it can finish. */
  releaseHeldRun: () => void;
  cleanup: () => void;
}> {
  const repo = makeGitRepo('dispatch');
  const requests: RunRequest[] = [];
  const rt = new RuntimeOrch({
    config: { agents: {} } as never,
    storeDir: join(repo, '.store'),
    // `replaceAdapters`, NOT `extraAdapters`. `extraAdapters` refuses to override an id
    // that is already registered, and `bootstrapAdapters()` registers a REAL adapter for
    // every agent installed on the machine - so on any developer machine with OpenCode
    // or WorkBuddy installed, the "fake" below was silently discarded and these tests
    // were launching the real CLI. That is the actual cause of this file's instability:
    // minutes-long runs whose results varied with machine load, plus timeouts that looked
    // like flakiness but were a real subprocess. The harness is only deterministic if the
    // double is genuinely the adapter in use.
    replaceAdapters: [
      // `review: true` is required, not incidental. `AgentSession` validation checks the
      // `mode` option against the adapter's `review` capability, and `buildRunRequest`
      // always sets `mode`. The double previously declared `review: false` and was never
      // actually consulted - the real adapter was - so this latent mismatch went
      // unnoticed until the fake was made authoritative.
      createFakeAdapter({ id: 'opencode', script: [{ kind: 'exit', code: 0 }], capabilities: { newTask: true, review: true, modelSelection: true, cwd: true, workspaceModes: ['shared', 'isolated'] } as never }),
      createFakeAdapter({ id: 'workbuddy-intl', script: [{ kind: 'exit', code: 0 }], capabilities: { newTask: true, review: true, modelSelection: true, cwd: true, workspaceModes: ['shared', 'isolated'] } as never }),
    ],
  });
  // Assert the double is really the one that will run. A fake adapter is identifiable
  // by its displayName (`Fake <id>`), so this fails loudly instead of quietly spending
  // minutes inside a real agent CLI - which is how this went unnoticed for so long.
  const fakesInUse = ['opencode', 'workbuddy-intl']
    .filter((id) => rt.registry.get(id).descriptor.displayName === `Fake ${id}`);
  if (fakesInUse.length !== 2) {
    throw new Error(
      `dispatchHarness is NOT using its fake adapters (got displayNames ` +
      `${JSON.stringify(['opencode', 'workbuddy-intl'].map((id) => rt.registry.get(id).descriptor.displayName))}). ` +
      'A real installed agent is shadowing the double; these scenarios would launch a real CLI.',
    );
  }
  /**
   * Wait until at least `n` runs have reached the runtime seam, or FAIL LOUDLY.
   *
   * `executeTask` registers the resource claim BEFORE it calls the runtime, so
   * "the runtime was asked to run" proves the claim is already held. That makes this an
   * exact synchronisation point where `setTimeout(150)` was a guess - and a guess that
   * is wrong in both directions: too short inverts which worker wins the conflict, too
   * long only burns wall clock. A bounded wait that reports what it saw is the
   * difference between a test that fails and one that hangs.
   */
  const waitForRuns = async (n: number, label: string, timeoutMs = 30_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (requests.length < n) {
      if (Date.now() > deadline) {
        throw new Error(
          `${label}: timed out after ${timeoutMs}ms waiting for ${n} runtime call(s); saw ${requests.length} ` +
          `(cwds: ${JSON.stringify(requests.map((r) => r.cwd))})`,
        );
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  /**
   * Hold the FIRST run open until the test releases it.
   *
   * This is the other half of the barrier, and it is what makes the conflict scenarios
   * test what they claim. "A claims a scope, then B is refused" only describes anything
   * while A is STILL WRITING - a claim is held for the life of the run, and by the time a
   * finished run settles its claim is legitimately released. With an instant fake, A used
   * to complete before B was even admitted, so B was correctly allowed and the scenario
   * asserted a conflict that could not happen. The old `setTimeout(150)` only appeared to
   * work by winning that race on a fast machine.
   *
   * So the ordering is now stated rather than raced: A is held in flight, the test
   * observes that A registered its claim, B is admitted and refused, and only then is A
   * released.
   */
  let releaseFirstRun: () => void = () => {};
  let heldOpen = false;
  // Holding is OPT-IN. A scenario that runs its tasks sequentially never calls
  // `releaseHeldRun`, so holding unconditionally would deadlock it - which is exactly
  // what happened when this was harness-wide. Only a scenario that genuinely needs two
  // tasks in flight at once asks for it.
  const holdFirstRun = opts.holdFirstRun === true;
  const runtime = {
    run: (r: RunRequest) => {
      requests.push(r);
      if (holdFirstRun && !heldOpen) {
        heldOpen = true;
        const gate = new Promise<void>((res) => { releaseFirstRun = res; });
        const handle = rt.run(r);
        return {
          ...handle,
          result: async (timeoutMs?: number) => {
            await gate;
            return handle.result(timeoutMs);
          },
        };
      }
      return rt.run(r);
    },
  };
  /** Let the held run finish. Idempotent. */
  const releaseHeldRun = (): void => { releaseFirstRun(); };
  const descriptors: AgentDescriptor[] = [
    { id: 'opencode', displayName: 'OpenCode', launcher: 'fake', transport: 'cli-jsonl', capabilities: { newTask: true, review: false, modelSelection: true, cwd: true, workspaceModes: ['shared', 'isolated'] } } as unknown as AgentDescriptor,
    { id: 'workbuddy-intl', displayName: 'WorkBuddy Intl', launcher: 'fake', transport: 'cli-jsonl', capabilities: { newTask: true, review: false, modelSelection: true, cwd: true, workspaceModes: ['shared', 'isolated'] } } as unknown as AgentDescriptor,
  ];
  const wm = new WorkspaceManager({ projectRoot: repo, workspaceLock: false, now: () => NOW });
  const budgets = new BudgetManager(10_000_000);
  for (const a of ['opencode', 'workbuddy-intl']) budgets.agent(a, 10_000_000);

  const registry = new ModelRegistry();
  for (const [agentId, modelId] of [['opencode', 'opencode/space-bunny-free'], ['workbuddy-intl', 'hy3']] as const) {
    registry.upsert({ agentId, modelId, provider: agentId, taskTypes: ['implementation'] as never, modelSource: 'test', quotaSource: 'test' }, NOW);
    registry.setAvailability(agentId, 'available');
  }

  const orch = new TaskOrchestrator({
    gate: {
      descriptors,
      agentStatus: [
        { agentId: 'opencode', agent: 'OpenCode', version: '1', installed: 'Yes', login: 'y', quotaSource: 't', usage: 'n', status: 'ok' },
        { agentId: 'workbuddy-intl', agent: 'WorkBuddy Intl', version: '1', installed: 'Yes', login: 'y', quotaSource: 't', usage: 'n', status: 'ok' },
      ],
      quotaRecords: ['opencode', 'workbuddy-intl'].map((agentId) => ({
        provider: agentId, agentId, modelId: null, source: 'cli_reported', usage: null, remaining: null,
        resetAt: null, period: 'unknown', status: 'unavailable' as const, usageClass: 'reported', confidence: 'high' as const, observedAt: NOW, note: '',
      })),
      registry,
      budgets,
      taskType: 'implementation',
      requestedUnits: 10,
      currentConcurrency: 0,
      maxConcurrency: 4,
      maxChildren: 8,
      maxConcurrentAgents: 4,
      taskPolicyAllows: true,
    } as never,
    runtime,
    defaultCwd: repo,
    now: () => NOW,
    // R2-2 P1-4: bounded. Without this, a wedged fake adapter makes
    // `handle.result(undefined)` wait indefinitely - which is precisely the silent
    // hang / silent-exit symptom this harness exhibited. A slow machine now fails an
    // assertion instead of stalling the suite.
    resultTimeoutMs: 120_000,
    workspace: wm,
    workspaceMode: opts.sharedMode === true ? () => 'shared' : () => 'isolated',
    // The claim names a workspace. `sharedMode` deliberately pins BOTH tasks to ONE
    // workspace id (the unsafe shared-checkout case); otherwise each task names its
    // OWN, which is what isolation gives it. This mirrors what `orchestrator round`
    // does: `task:<taskId>`.
    ...(opts.claims
      ? {
          resourceClaims: (task: Task) => ({
            mode: 'write' as const,
            scope: normalizeScopeForWorkspace(opts.sharedMode === true ? 'shared' : `task:${task.taskId}`, repo),
          }),
        }
      : {}),
  });
  return {
    orch, requests, repo, waitForRuns, releaseHeldRun,
    cleanup: () => removeTempTree(join(repo, '..')),
  };
}

// ---- C17: two writers in ONE shared workspace are not dispatched together ----
{
  const { orch, requests, repo, waitForRuns, releaseHeldRun, cleanup } = await dispatchHarness({ claims: true, sharedMode: true, holdFirstRun: true });
  orch.createRoot({ taskId: 'r', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'root' });
  const budgets = (orch as unknown as { gate: { budgets: BudgetManager } }).gate.budgets;
  for (const id of ['a', 'b']) {
    budgets.task(id, 10_000);
    orch.spawnChild({ taskId: id, parentTaskId: 'r', agentId: 'opencode', modelId: 'opencode/space-bunny-free', taskType: 'implementation', acceptanceCriteria: id, budgetUnits: 10 });
  }
// `sharedMode: true` pins BOTH tasks into ONE workspace, which is the genuinely
    // unsafe case and must conflict. When each task gets its OWN isolated workspace,
    // the identical whole-workspace claim correctly does NOT - that is P1-a-1 below.
    // They are started CONCURRENTLY, because a claim is held for the life of the run:
    // a strictly sequential second writer would legitimately be allowed, since by
    // then the first is no longer writing.
    const firstRun = orch.executeTask({ taskId: 'a' });
  // The ordering is STATED, not raced:
  //   1. A reaches the runtime -> its claim is registered and it is held in flight
  //   2. B is admitted while A is still writing -> must be refused
  //   3. A is released and settles
  await waitForRuns(1, 'C17 first writer');
  const second = await orch.executeTask({ taskId: 'b' });
  releaseHeldRun();
  const first = await firstRun;

  check('C17a: the first writer dispatches normally', first.ok, first.ok ? '' : `${first.code} ${first.reason}`);
  check('C17b: the second is refused with resource-conflict', !second.ok && second.code === 'resource-conflict',
    second.ok ? 'it RAN' : `${second.code} ${second.reason.slice(0, 90)}`);
  // The refusal must leave the task where it was, so the EXISTING Laya / Scheduler /
  // human-gate semantics decide what happens next. It must NOT burn the task as
  // `failed`: nothing ran, so no worker is at fault.
  const keptStatus = second.ok ? undefined : second.status;
  check('C17c: the refusal is an ADMISSION result, not a task failure - status unchanged',
    second.ok === false && (keptStatus === undefined || ['planned', 'queued', 'running'].includes(keptStatus)),
    `status=${String(keptStatus)}`);
  check('C17d: only ONE runtime call happened', requests.length === 1, `requests=${requests.length}`);
  check('C17e: the refusal says no agent is to blame',
    !second.ok && /no agent blamed/i.test(second.reason), second.ok ? '' : second.reason.slice(-90));
  cleanup();
  void repo;
}

// ---- C18: NON-conflicting parallel tasks still dispatch --------------------
{
  const { orch, requests, cleanup } = await dispatchHarness({ claims: false });
  orch.createRoot({ taskId: 'r', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'root' });
  const budgets = (orch as unknown as { gate: { budgets: BudgetManager } }).gate.budgets;
  for (const id of ['a', 'b']) {
    budgets.task(id, 10_000);
    orch.spawnChild({
      taskId: id, parentTaskId: 'r',
      agentId: id === 'a' ? 'opencode' : 'workbuddy-intl',
      modelId: id === 'a' ? 'opencode/space-bunny-free' : 'hy3',
      taskType: 'implementation', acceptanceCriteria: id, budgetUnits: 10,
    });
  }
  // Sequential on purpose: C18 is about two tasks in SEPARATE worktrees both being
  // allowed, so there is no overlap to synchronise and nothing to hold open.
  const ra = await orch.executeTask({ taskId: 'a' });
  const rb = await orch.executeTask({ taskId: 'b' });
  check('C18a: two non-conflicting parallel tasks BOTH dispatch', ra.ok && rb.ok,
    `a=${ra.ok ? 'ok' : ra.code} b=${rb.ok ? 'ok' : rb.code}`);
  check('C18b: each ran on its own agent', new Set(requests.map((r) => r.agentId)).size === 2,
    requests.map((r) => r.agentId).join(','));
  check('C18c: and each got a DIFFERENT cwd - the worktree, not the shared root',
    requests.length === 2 && requests[0]!.cwd !== requests[1]!.cwd,
    requests.map((r) => r.cwd).join(' | '));
  cleanup();
}

// ---- C16: the workspace identity REACHES the native request ---------------
{
  const { orch, requests, cleanup } = await dispatchHarness({ claims: false });
  orch.createRoot({ taskId: 'r', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'root' });
  const budgets = (orch as unknown as { gate: { budgets: BudgetManager } }).gate.budgets;
  budgets.task('a', 10_000);
  orch.spawnChild({ taskId: 'a', parentTaskId: 'r', agentId: 'opencode', modelId: 'opencode/space-bunny-free', taskType: 'implementation', acceptanceCriteria: 'a', budgetUnits: 10 });
  await orch.executeTask({ taskId: 'a' });
  const handle = orch.getWorkspace()?.get('a');
  check('C16: the workspace directory is the one handed to the native agent',
    handle !== null && handle !== undefined && requests[0]?.cwd === handle.cwd,
    `request=${String(requests[0]?.cwd)} handle=${String(handle?.cwd)}`);
  check('C16b: the handle records the task it belongs to', handle?.taskId === 'a' && handle?.mode === 'isolated');
  cleanup();
}

// ===========================================================================
section('§P1-a  R2-1.1: isolated workspaces must NOT falsely conflict');
// ===========================================================================

const WS_A = 'task:A';
const WS_B = 'task:B';
const wsA = normalizeScopeForWorkspace(WS_A, 'D:\\repo\\wt-A');
const wsB = normalizeScopeForWorkspace(WS_B, 'D:\\repo\\wt-B');

check('P1-a-0: two whole-workspace claims on DIFFERENT workspaces do not overlap',
  scopesOverlap(wsA, wsB) === false, 'this is the false-conflict that serialized parallel writers');
check('P1-a-1a: the same workspace twice DOES overlap',
  scopesOverlap(wsA, normalizeScopeForWorkspace(WS_A, 'D:\\repo\\wt-A')) === true);
check('P1-a-1b: two whole-workspace CLAIMS on different workspaces do not conflict',
  claimsConflict(claim('A', 'write', wsA), claim('B', 'write', wsB)) === false);
check('P1-a-2: a whole-workspace claim DOES conflict with a file inside that SAME workspace',
  claimsConflict(
    claim('A', 'write', normalizeScopeForWorkspace(WS_A, ROOT_A)),
    claim('B', 'write', file('src/auth/login.ts')),
  ) === true);
check('P1-a-3: the SAME relative directory in two different workspaces does not overlap',
  claimsConflict(
    claim('A', 'write', normalizeScopeForWorkspace(WS_A, 'D:\\repo\\wt-A')),
    claim('B', 'write', normalizeScope({ path: 'src', root: 'D:\\repo\\wt-B', kind: 'directory' })),
  ) === false,
  'scope path is workspace-local; workspace identity is the isolation boundary');
check('P1-a-3b: but the same directory in the SAME workspace still overlaps',
  scopesOverlap(
    normalizeScopeForWorkspace(WS_A, 'D:\\repo\\wt-A'),
    normalizeScope({ path: 'src', root: 'D:\\repo\\wt-A', kind: 'directory' }),
  ) === true);
check('P1-a-4: two different isolated worktrees of one repo are NOT one repository scope',
  claimsConflict(
    claim('A', 'write', normalizeScopeForRepository('D:\\repo\\wt-A')),
    claim('B', 'write', normalizeScopeForRepository('D:\\repo\\wt-B')),
  ) === false);
check('P1-a-5: two writers on the SAME repository root still conflict',
  claimsConflict(
    claim('A', 'write', normalizeScopeForRepository(ROOT_A)),
    claim('B', 'write', normalizeScopeForRepository(ROOT_A)),
  ) === true);

// P1-a-1 end to end: two ISOLATED writers must both be admitted and both run.
{
  const { orch, requests, waitForRuns, releaseHeldRun, cleanup } = await dispatchHarness({ claims: true, holdFirstRun: true });
  orch.createRoot({ taskId: 'r', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'root' });
  const budgets = (orch as unknown as { gate: { budgets: BudgetManager } }).gate.budgets;
  for (const id of ['a', 'b']) {
    budgets.task(id, 10_000);
    orch.spawnChild({ taskId: id, parentTaskId: 'r', agentId: 'opencode', modelId: 'opencode/space-bunny-free', taskType: 'implementation', acceptanceCriteria: id, budgetUnits: 10 });
  }
  // Same claim SHAPE as the conflicting case above, but each task now resolves to its
  // own isolated workspace.
  const runA = orch.executeTask({ taskId: 'a' });
  // Deterministic: same barrier as C17 - A's claim is registered before B is admitted.
  await waitForRuns(1, 'isolated workspaces, no false conflict');
  // B is admitted while A is still in flight; releasing A lets it settle.
  const rb = await orch.executeTask({ taskId: 'b' });
  releaseHeldRun();
  const ra = await runA;
  check('P1-a-1E: both isolated writers are admitted (no false conflict)', ra.ok && rb.ok,
    `a=${ra.ok ? 'ok' : ra.code} b=${rb.ok ? 'ok' : rb.code}`);
  check('P1-a-1F: and BOTH dispatched, in parallel', requests.length === 2, `requests=${requests.length}`);
  check('P1-a-1G: each ran in its OWN workspace directory',
    requests.length === 2 && requests[0]!.cwd !== requests[1]!.cwd, requests.map((r) => r.cwd).join(' | '));
  cleanup();
}

// ===========================================================================
section('§P1-b  R2-1.1: non-git + parallel write must be BLOCKED, not skipped');
// ===========================================================================

/** Same harness, but WITHOUT a WorkspaceManager - the non-git case. */
async function nonGitHarness(mode: 'read' | 'write' | 'exclusive-write', twoTasks: boolean): Promise<{
  orch: TaskOrchestrator; requests: RunRequest[]; cwd: string; cleanup: () => void;
}> {
  const cwd = mkdtempSync(join(tmpdir(), 'r21-nogit-'));
  const requests: RunRequest[] = [];
  const rt = new RuntimeOrch({
    config: { agents: {} } as never,
    storeDir: join(cwd, '.store'),
    extraAdapters: [
      createFakeAdapter({ id: 'opencode', script: [{ kind: 'exit', code: 0 }], capabilities: { newTask: true, review: false, modelSelection: true, cwd: true } as never }),
    ],
  });
  const runtime = { run: (r: RunRequest) => { requests.push(r); return rt.run(r); } };
  const descriptors: AgentDescriptor[] = [
    { id: 'opencode', displayName: 'OpenCode', launcher: 'fake', transport: 'cli-jsonl', capabilities: { newTask: true, review: false, modelSelection: true, cwd: true, workspaceModes: ['shared'] } } as unknown as AgentDescriptor,
  ];
  const registry = new ModelRegistry();
  registry.upsert({ agentId: 'opencode', modelId: 'opencode/space-bunny-free', provider: 'opencode', taskTypes: ['implementation', 'research'] as never, modelSource: 'test', quotaSource: 'test' }, NOW);
  registry.setAvailability('opencode', 'available');
  const budgets = new BudgetManager(10_000_000);
  budgets.agent('opencode', 10_000_000);

  const orch = new TaskOrchestrator({
    gate: {
      descriptors,
      agentStatus: [{ agentId: 'opencode', agent: 'OpenCode', version: '1', installed: 'Yes', login: 'y', quotaSource: 't', usage: 'n', status: 'ok' }],
      quotaRecords: [{ provider: 'opencode', agentId: 'opencode', modelId: null, source: 'cli_reported', usage: null, remaining: null, resetAt: null, period: 'unknown', status: 'unavailable', usageClass: 'reported', confidence: 'high', observedAt: NOW, note: '' }],
      registry, budgets,
      taskType: 'implementation', requestedUnits: 10, currentConcurrency: 0, maxConcurrency: 4,
      maxChildren: 8, maxConcurrentAgents: 4, taskPolicyAllows: true,
    } as never,
    runtime, defaultCwd: cwd, now: () => NOW,
    // NO `workspace` - exactly the non-git production shape.
    workspaceMode: () => 'none',
    resourceClaims: (_task: Task) => ({ mode, scope: normalizeScopeForWorkspace('shared', cwd) }),
  });
  orch.createRoot({ taskId: 'r', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'root' });
  for (const t of twoTasks ? ['a', 'b'] : ['a']) {
    budgets.task(t, 10_000);
    orch.spawnChild({ taskId: t, parentTaskId: 'r', agentId: 'opencode', modelId: 'opencode/space-bunny-free', taskType: 'implementation', acceptanceCriteria: t, budgetUnits: 10 });
  }
  return { orch, requests, cwd, cleanup: () => removeTempTree(cwd) };
}

{
  // P1-b-1: reading beside other work in a shared directory is FINE.
  const { orch, requests, cleanup } = await nonGitHarness('read', true);
  const ra = await orch.executeTask({ taskId: 'a' });
  check('P1-b-1: non-git READ-ONLY is allowed (a shared directory is safe to read)',
    ra.ok, ra.ok ? '' : `${ra.code} ${ra.reason.slice(0, 80)}`);
  check('P1-b-1b: and it really ran', requests.length === 1, `requests=${requests.length}`);
  cleanup();
}
{
  // P1-b-2: writing beside other work with nowhere to isolate is NOT fine.
  const { orch, requests, cleanup } = await nonGitHarness('write', true);
  const ra = await orch.executeTask({ taskId: 'a' });
  check('P1-b-2: non-git PARALLEL WRITE is blocked with resource-unavailable',
    !ra.ok && ra.code === 'resource-unavailable', ra.ok ? 'IT RAN' : `${ra.code} ${ra.reason.slice(0, 70)}`);
  check('P1-b-2b: and NO runtime call happened', requests.length === 0, `requests=${requests.length}`);
  check('P1-b-2c: the refusal is an admission result, not an agent failure',
    !ra.ok && (ra.status === undefined || ra.status === 'planned'), `status=${String(ra.ok ? undefined : ra.status)}`);
  check('P1-b-2d: the reason does not blame an agent and offers no auto-recovery',
    !ra.ok && /no agent blamed/i.test(ra.reason) && !/retry|reassign|replan/i.test(ra.reason),
    ra.ok ? '' : ra.reason.slice(-110));
  cleanup();
}
{
  // P1-b-3: exclusive-write is the same refusal.
  const { orch, requests, cleanup } = await nonGitHarness('exclusive-write', true);
  const ra = await orch.executeTask({ taskId: 'a' });
  check('P1-b-3: non-git exclusive-write is blocked too',
    !ra.ok && ra.code === 'resource-unavailable' && requests.length === 0,
    ra.ok ? 'IT RAN' : ra.code);
  cleanup();
}
{
  // P1-b-4: the SAME write is allowed when git isolation IS available - proving the
  // refusal above is about missing isolation, not about writing.
  const { orch, requests, waitForRuns, releaseHeldRun, cleanup } = await dispatchHarness({ claims: true, holdFirstRun: true });
  orch.createRoot({ taskId: 'r', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'root' });
  const budgets = (orch as unknown as { gate: { budgets: BudgetManager } }).gate.budgets;
  for (const id of ['a', 'b']) {
    budgets.task(id, 10_000);
    orch.spawnChild({ taskId: id, parentTaskId: 'r', agentId: 'opencode', modelId: 'opencode/space-bunny-free', taskType: 'implementation', acceptanceCriteria: id, budgetUnits: 10 });
  }
  const runA = orch.executeTask({ taskId: 'a' });
  // Deterministic: same barrier again - A's claim is registered before B is admitted.
  await waitForRuns(1, 'git-isolated parallel write');
  // B is admitted while A is still in flight; releasing A lets it settle.
  const rb = await orch.executeTask({ taskId: 'b' });
  releaseHeldRun();
  const ra = await runA;
  check('P1-b-4: git-isolated parallel write is ALLOWED (unaffected by the fix)',
    ra.ok && rb.ok, `a=${ra.ok ? 'ok' : ra.code} b=${rb.ok ? 'ok' : rb.code}`);
  cleanup();
  void requests;
}

// ===========================================================================
section('§P2-1  R2-1.1: claim identity must carry the scope');
// ===========================================================================

{
  const book = new ResourceClaimBook(() => NOW);
  const req = (mode: ResourceClaimMode, scope: ResourceClaim['scope']): ClaimRequest =>
    ({ taskId: 'T1', workspaceId: 'W1', mode, scope });

  const a1 = book.claim(req('write', file('src/a.ts')));
  const a2 = book.claim(req('write', file('src/a.ts')));
  check('P2-1-1: the same task/workspace/scope/mode claimed twice is idempotent',
    a1.ok && a2.ok && a1.created && !a2.created && a1.claim.claimId === a2.claim.claimId,
    JSON.stringify({
      a1: a1.ok ? { created: a1.created, id: a1.claim.claimId } : a1.code,
      a2: a2.ok ? { created: a2.created, id: a2.claim.claimId } : a2.code,
    }));

  const b1 = book.claim(req('write', file('src/b.ts')));
  check('P2-1-2: a DIFFERENT scope on the same task is a SECOND claim, not an overwrite',
    b1.ok && b1.created && book.all().length === 2, `claims=${book.all().length}`);
  check('P2-1-2b: and the first scope is still registered (its protection did not vanish)',
    book.all().some((c) => scopeKeyOf(c.scope) === scopeKeyOf(file('src/a.ts'))),
    book.all().map((c) => c.claimId).join(' | '));

  // The regression this fixes: a second scope used to REPLACE the first, so a rival
  // writer on the first scope was let through.
  const rival = book.claim({ taskId: 'T2', workspaceId: 'W1', mode: 'write', scope: file('src/a.ts') });
  check('P2-1-2c: a rival writer on scope A is still refused after scope B was claimed',
    !rival.ok && rival.code === 'resource-conflict', rival.ok ? 'it was allowed' : rival.code);

  // P2-1-3: releasing ONE scope must leave the other held.
  const released = book.releaseClaimForScope('T1', 'write', file('src/a.ts'));
  check('P2-1-3: releasing scope A releases exactly one claim', released === 1, `released=${released}`);
  check('P2-1-3b: and scope B SURVIVES the release',
    book.all().length === 1 && book.all()[0]!.claimId === (b1.ok ? b1.claim.claimId : ''),
    book.all().map((c) => c.claimId).join(' | '));
  const stillHeld = book.claim({ taskId: 'T2', workspaceId: 'W1', mode: 'write', scope: file('src/b.ts') });
  check('P2-1-3c: scope B still refuses a rival after scope A was released',
    !stillHeld.ok && stillHeld.code === 'resource-conflict', stillHeld.ok ? 'it was allowed' : 'refused');
  const nowFree = book.claim({ taskId: 'T2', workspaceId: 'W1', mode: 'write', scope: file('src/a.ts') });
  check('P2-1-3d: scope A is genuinely free after its release', nowFree.ok && nowFree.created);
}

// ===========================================================================
// R2-2.1 (P1): once a claim is REGISTERED, every exit from executeTask must
// give it back. ResourceClaimBook is in-process state, so a leaked claim blocks
// every later writer in that workspace until the process exits.
// ===========================================================================

/**
 * A store that can refuse ONE transition.
 *
 * This exists to reach a REAL refusal path, not to fake a result: `Orchestrator.mutate`
 * forwards to `TaskStore.transition`, and that genuinely returns `ok: false` (terminal
 * task, illegal edge). Refusing a specific target once is the narrowest way to make a
 * post-registration transition fail deterministically, so the assertion under test is
 * "did the claim come back?" rather than "did some helper get called?".
 */
class RefusingTaskStore extends TaskStore {
  private refuse: string | null = null;
  refuseOnce(status: string): void {
    this.refuse = status;
  }
  override transition(taskId: string, to: never, now: number, reason: string | null = null): ReturnType<TaskStore['transition']> {
    if (this.refuse === (to as unknown as string)) {
      this.refuse = null;
      return { ok: false, task: null, code: 'transition-refused-by-test', reason: 'store refused this transition' };
    }
    return super.transition(taskId, to, now, reason);
  }
}

/**
 * A whole-workspace write harness over a REAL WorkspaceManager and a fake agent.
 *
 * `replaceAdapters` (not `extraAdapters`) so the double genuinely wins over any real
 * agent installed on this machine — otherwise these scenarios would launch a real CLI
 * and be slow and load-dependent, which is the defect R2-2.1 was raised against.
 */
function leakHarness(opts: { runtimeThrows?: boolean; holdFirstRun?: boolean } = {}): {
  orch: TaskOrchestrator;
  store: RefusingTaskStore;
  wm: WorkspaceManager;
  repo: string;
  cleanup: () => void;
} {
  const repo = makeGitRepo('leak');
  const store = new RefusingTaskStore();
  const rt = new RuntimeOrch({
    config: { agents: {} } as never,
    storeDir: join(repo, '.store'),
    replaceAdapters: [
      createFakeAdapter({ id: 'opencode', script: [{ kind: 'exit', code: 0 }], capabilities: { newTask: true, review: true, modelSelection: true, cwd: true, workspaceModes: ['shared'] } as never }),
    ],
  });
  // `runtimeThrows` breaks only the FIRST run, so the follow-up writer (B) uses a working
  // runtime. If the throwing runtime were left in place for B too, B would fail for an
  // unrelated reason and the test would prove nothing about claims.
  let runs = 0;
  const runtime = opts.runtimeThrows === true
    ? {
        run: (r: RunRequest) => {
          runs++;
          if (runs === 1) throw new Error('adapter binary is missing');
          return rt.run(r);
        },
      }
    : { run: (r: RunRequest) => rt.run(r) };

  const wm = new WorkspaceManager({ projectRoot: repo, workspaceLock: false, now: () => NOW });
  const budgets = new BudgetManager(10_000_000);
  budgets.agent('opencode', 10_000_000);
  for (const t of ['a', 'b']) budgets.task(t, 10_000);

  const registry = new ModelRegistry();
  registry.upsert({ agentId: 'opencode', modelId: 'opencode/space-bunny-free', provider: 'opencode', taskTypes: ['implementation'] as never, modelSource: 'test', quotaSource: 'test' }, NOW);
  registry.setAvailability('opencode', 'available');

  const orch = new TaskOrchestrator({
    gate: {
      descriptors: [{ id: 'opencode', displayName: 'OpenCode', launcher: 'fake', transport: 'cli-jsonl', capabilities: { newTask: true, review: true, modelSelection: true, cwd: true, workspaceModes: ['shared'] } }],
      agentStatus: [{ agentId: 'opencode', agent: 'opencode', version: '1', installed: 'Yes', login: 'y', quotaSource: 't', usage: 'n', status: 'ok' }],
      quotaRecords: [{ provider: 'opencode', agentId: 'opencode', modelId: null, source: 'cli_reported', usage: null, remaining: null, resetAt: null, period: 'unknown', status: 'unavailable', usageClass: 'reported', confidence: 'high', observedAt: NOW, note: '' }],
      registry, budgets, taskType: 'implementation', requestedUnits: 10, currentConcurrency: 0,
      maxConcurrency: 4, maxChildren: 8, maxConcurrentAgents: 4, taskPolicyAllows: true,
    } as never,
    store,
    runtime: runtime as never,
    defaultCwd: repo,
    now: () => NOW,
    resultTimeoutMs: 30_000,
    workspace: wm,
    // SHARED mode + a whole-workspace scope is the leaking case: both tasks name the
    // SAME claim scope, so a leaked claim from A is what would block B.
    workspaceMode: () => 'shared',
    resourceClaims: () => ({ mode: 'write', scope: normalizeScopeForWorkspace('shared', repo) }),
  });

  orch.createRoot({ taskId: 'r', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'root' });
  for (const id of ['a', 'b']) {
    orch.spawnChild({ taskId: id, parentTaskId: 'r', agentId: 'opencode', modelId: 'opencode/space-bunny-free', taskType: 'implementation', acceptanceCriteria: id, budgetUnits: 10 });
  }
  return { orch, store, wm, repo, cleanup: () => removeTempTree(join(repo, '..')) };
}

/** The whole point: after A exits, B must be able to take the SAME whole-workspace write. */
async function assertNoLeak(label: string, run: (h: ReturnType<typeof leakHarness>) => Promise<void>, h: ReturnType<typeof leakHarness>): Promise<void> {
  await run(h);
  check(`${label}: no claim is left registered`, h.wm.resourceClaimCount === 0, `claims=${h.wm.resourceClaimCount}`);
  // The observable consequence: a fresh writer on the same scope must be admitted.
  const b = await h.orch.executeTask({ taskId: 'b' });
  check(`${label}: a later writer on the SAME whole-workspace scope is admitted`, b.ok === true,
    b.ok ? '' : `${b.code} ${String(b.reason).slice(0, 90)}`);
  h.cleanup();
}

// ---- Case 1: planned -> queued mutation fails AFTER the claim is registered ----
await assertNoLeak('P1 case 1 (planned->queued refused)', async (h) => {
  h.store.refuseOnce('queued');
  const a = await h.orch.executeTask({ taskId: 'a' });
  check('P1 case 1: A is refused', a.ok === false, a.ok ? 'ran' : String(a.code));
  check('P1 case 1: refused by the store, not by the claim', !a.ok && a.code === 'transition-refused-by-test', a.ok ? '' : String(a.code));
  // `transition-refused-by-test` is only reachable AFTER `claimResource` succeeded (the
  // claim is taken first, the transitions come later), so reaching this code at all proves
  // the claim HAD been registered before the failure.
  check('P1 case 1: the claim HAD been taken before the failure (the code proves it)',
    !a.ok && a.code === 'transition-refused-by-test');
}, leakHarness());

// ---- Case 2: queued -> running mutation fails AFTER the claim is registered ----
await assertNoLeak('P1 case 2 (queued->running refused)', async (h) => {
  h.store.refuseOnce('running');
  const a = await h.orch.executeTask({ taskId: 'a' });
  check('P1 case 2: A is refused', a.ok === false, a.ok ? 'ran' : String(a.code));
  check('P1 case 2: refused by the store', !a.ok && a.code === 'transition-refused-by-test', a.ok ? '' : String(a.code));
  check('P1 case 2: A did not reach to_verify', h.store.get('a')?.status !== 'to_verify', String(h.store.get('a')?.status));
}, leakHarness());

// ---- Case 3: runtime.run() throws AFTER the claim is registered ----
await assertNoLeak('P1 case 3 (runtime.run throws)', async (h) => {
  const a = await h.orch.executeTask({ taskId: 'a' });
  check('P1 case 3: A is refused', a.ok === false, a.ok ? 'ran' : String(a.code));
  check('P1 case 3: refused as runtime-rejected-run', !a.ok && a.code === 'runtime-rejected-run', a.ok ? '' : String(a.code));
  check('P1 case 3: the failure IS recorded on the task (a real failure, not a silent one)',
    h.store.get('a')?.status === 'failed', String(h.store.get('a')?.status));
  // Fixing a leak must not invent recovery.
  check('P1 case 3: no retry/reassign/replan was invented',
    h.store.get('a')?.retryCount === 0 && h.store.get('a')?.generation === 0 && h.store.get('a')?.agentId === 'opencode');
}, leakHarness({ runtimeThrows: true }));

// ---- Structural guard: the invariant that makes the three cases above pass ----
//
// The behavioural cases prove today's code. This proves the SHAPE that guarantees them,
// so a future edit cannot quietly reintroduce the leak by inserting a `return`
// between claim registration and the `try`.
//
// Claim registration and the `try {` that owns the release must be ADJACENT in the
// sense that matters: no `return` may appear between them. A `return` in that window is
// the only way to leak, because every return INSIDE a try-with-finally runs the finally.
{
  const src = readFileSync(new URL('../src/orchestration/orchestrator.ts', import.meta.url), 'utf8');
  const start = src.indexOf('async executeTask(');
  const claimAt = src.indexOf('claimResource(', start);
  // The window that matters begins where the claim is KNOWN TO BE REGISTERED, which is
  // the `claimedScope = ...` assignment - not the `claimResource(...)` call. The refusal
  // branch between them (`if (!taken.ok) return ...`) is correct and must stay: if
  // registration failed there is nothing to release, so it is not a leak.
  const registeredAt = src.indexOf('claimedScope = ', claimAt);
  const tryAt = src.indexOf('try {', registeredAt);
  check('R2-2.1: the claim registration and its guarding try were both found',
    start !== -1 && claimAt !== -1 && registeredAt !== -1 && tryAt !== -1,
    `start=${start} claim=${claimAt} registered=${registeredAt} try=${tryAt}`);
  const window = src.slice(registeredAt, tryAt);
  check('R2-2.1: no `return` sits between SUCCESSFUL claim registration and the try/finally',
    !/\breturn\b/.test(window.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')),
    window.replace(/\s+/g, ' ').slice(0, 200));
  // And the release really is in a finally, not an ordinary statement.
  const after = src.slice(tryAt);
  check('R2-2.1: the release is in a `finally`, so every exit path runs it',
    /finally\s*\{[\s\S]{0,400}?releaseClaim\(/.test(after));
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length > 0) {
  process.stdout.write(`failing:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
  process.exitCode = 1;
}
