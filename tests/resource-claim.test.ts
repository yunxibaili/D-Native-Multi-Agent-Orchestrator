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

import { execSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
import { isProvenNotStarted } from '../src/runtime/start-proof.ts';
import { TaskStore } from '../src/orchestration/store.ts';
import type { Task } from '../src/orchestration/task.ts';
import { Orchestrator as RuntimeOrch } from '../src/orchestrator/orchestrator.ts';
import { BudgetManager, ModelRegistry } from '../src/quota/index.ts';
import { createFakeAdapter, FAKE_LAUNCHER } from './helpers.ts';
import { createOpenCodeAdapter } from '../src/adapters/opencode.ts';
import { validateRuntimeLaunchPreflight } from '../src/runtime/preflight.ts';
import { InvalidRequestError, UnsupportedOptionError } from '../src/core/errors.ts';
import type { AgentDescriptor, RunHandle, RunRequest } from '../src/core/types.ts';

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
/** The repository root, for source-level guards in this suite. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const claim = (
  taskId: string,
  mode: ResourceClaimMode,
  scope: ResourceClaim['scope'],
  workspaceId = 'task:x',
  // W3.1: default is an ORDINARY lease-shaped claim, voidable by §7.3. The
  // retained variants are built explicitly by the W3R tests so that "ordinary
  // stale cleanup still works" keeps a meaningful control.
  protectionRetained = false,
): ResourceClaim => ({
  claimId: `claim:${taskId}`,
  taskId,
  leaseVersion: null,
  workspaceId,
  mode,
  scope,
  createdAt: NOW,
  protectionRetained,
  retentionReason: protectionRetained ? 'test: tree-stop-unconfirmed' : null,
  // W3.2: the structured identity every resource operation matches on. Derived from
  // the scope itself rather than parsed back out of `claimId`.
  scopeKey: scopeKeyOf(scope),
});
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
    registry.setAgentAvailability(agentId, 'available');
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
    executionTimeoutMs: 120_000,
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
    // `replaceAdapters`, NOT `extraAdapters`: `extraAdapters` only registers an id that is
    // not already present, so on any machine with a real `opencode` installed the double was
    // silently ignored and this scenario launched the REAL CLI. That is the exact failure
    // `replaceAdapters` was introduced to fix (see its docstring in orchestrator.ts), and
    // §P1-a was migrated to it while §P1-b was not — which made this section hang for
    // minutes on a developer machine instead of being a unit test.
    replaceAdapters: [
      createFakeAdapter({ id: 'opencode', script: [{ kind: 'exit', code: 0 }], capabilities: { newTask: true, review: false, modelSelection: true, cwd: true } as never }),
    ],
  });
  // Prove the double is authoritative, so a real installed agent can never shadow it again.
  if (rt.registry.get('opencode').descriptor.displayName !== 'Fake opencode') {
    throw new Error(
      'nonGitHarness is NOT using its fake adapter (a real opencode is shadowing the double); ' +
      'this scenario would launch a real CLI and hang.',
    );
  }
  const runtime = { run: (r: RunRequest) => { requests.push(r); return rt.run(r); } };
  const descriptors: AgentDescriptor[] = [
    { id: 'opencode', displayName: 'OpenCode', launcher: 'fake', transport: 'cli-jsonl', capabilities: { newTask: true, review: false, modelSelection: true, cwd: true, workspaceModes: ['shared'] } } as unknown as AgentDescriptor,
  ];
  const registry = new ModelRegistry();
  registry.upsert({ agentId: 'opencode', modelId: 'opencode/space-bunny-free', provider: 'opencode', taskTypes: ['implementation', 'research'] as never, modelSource: 'test', quotaSource: 'test' }, NOW);
  registry.setAgentAvailability('opencode', 'available');
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
function leakHarness(opts: {
  runtimeThrows?: boolean;
  /**
   * W3.2: reproduce a GENUINE production pre-start failure — the containment control
   * directory cannot be created — by pointing the launcher override at a directory
   * whose `containment-run` name is occupied by a regular file.
   *
   * This is the real `ManagedProcess` code path (control setup runs before `spawn`),
   * not a stub that fabricates an error. That distinction is the whole point of W3.2:
   * the trusted proof is produced by the runtime, so a test cannot mint one.
   */
  controlDirUnavailable?: boolean;
  holdFirstRun?: boolean;
} = {}): {
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
          if (runs === 1) {
            // W3.1: a bare throw carries NO evidence. Production treats it as
            // "may have started" — a writer may be alive — and retains protection.
            throw new Error('adapter binary is missing');
          }
          return rt.run(r);
        },
      }
    : { run: (r: RunRequest) => rt.run(r) };

  /*
   * W3.2: point the launcher override at a directory where `containment-run` cannot be
   * created, so the REAL ManagedProcess fails at control setup — provably before
   * `spawn`. Nothing in the test constructs or brands a proof; the runtime does.
   */
  let restoreOverride: string | undefined;
  if (opts.controlDirUnavailable === true) {
    const fakeLauncherDir = join(repo, 'fake-launcher-dir');
    mkdirSync(fakeLauncherDir, { recursive: true });
    // Occupy the control SUBDIRECTORY name with a regular file: `mkdirSync` of that
    // path then fails with ENOTDIR/EEXIST on every platform we care about.
    writeFileSync(join(fakeLauncherDir, 'containment-run'), 'not a directory');
    restoreOverride = process.env.ORCH_JOB_LAUNCHER;
    process.env.ORCH_JOB_LAUNCHER = join(fakeLauncherDir, 'w1joblauncher.exe');
  }

  const wm = new WorkspaceManager({ projectRoot: repo, workspaceLock: false, now: () => NOW });
  const budgets = new BudgetManager(10_000_000);
  budgets.agent('opencode', 10_000_000);
  for (const t of ['a', 'b']) budgets.task(t, 10_000);

  const registry = new ModelRegistry();
  registry.upsert({ agentId: 'opencode', modelId: 'opencode/space-bunny-free', provider: 'opencode', taskTypes: ['implementation'] as never, modelSource: 'test', quotaSource: 'test' }, NOW);
  registry.setAgentAvailability('opencode', 'available');

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
    executionTimeoutMs: 30_000,
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
  return {
    orch,
    store,
    wm,
    repo,
    cleanup: () => {
      // The launcher override is process-global; leaving it set would silently
      // re-point every later containment lookup at a deleted temp directory.
      if (restoreOverride === undefined) delete process.env.ORCH_JOB_LAUNCHER;
      else process.env.ORCH_JOB_LAUNCHER = restoreOverride;
      removeTempTree(join(repo, '..'));
    },
  };
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

/*
 * ---- Case 3: runtime.run() throws AFTER the claim is registered ----
 *
 * W3.1 CHANGED THIS EXPECTATION, and the old one encoded the defect.
 *
 * It used to assert "no claim is left registered", on the reasoning that a throw from
 * `runtime.run` means nothing ran. That reasoning is wrong, and it was exploitable: the
 * throw can happen AFTER a real `ManagedProcess` has already spawned a writer. Releasing
 * the claim on that basis admitted a second writer into a scope the first was still
 * mutating — the exact P1-A failure.
 *
 * The frozen rule now: a generic throw is "may have started", the claim is RETAINED as
 * physical protection, and a rival writer is refused. Case 3b below is the control that
 * proves this is not simply "every failure locks the workspace forever".
 */
{
  const h = leakHarness({ runtimeThrows: true });
  const a = await h.orch.executeTask({ taskId: 'a' });
  check('P1 case 3: A is refused', a.ok === false, a.ok ? 'ran' : String(a.code));
  check('P1 case 3: refused as runtime-rejected-run', !a.ok && a.code === 'runtime-rejected-run', a.ok ? '' : String(a.code));
  check('P1 case 3: the failure IS recorded on the task (a real failure, not a silent one)',
    h.store.get('a')?.status === 'failed', String(h.store.get('a')?.status));
  // Fixing a leak must not invent recovery.
  check('P1 case 3: no retry/reassign/replan was invented',
    h.store.get('a')?.retryCount === 0 && h.store.get('a')?.generation === 0 && h.store.get('a')?.agentId === 'opencode');
  // W3.1: the claim is HELD, because an unproven throw may have left a writer alive.
  check('P1 case 3: the write claim is RETAINED (a generic throw may have started a writer)',
    h.wm.resourceClaimCount === 1, `claims=${h.wm.resourceClaimCount}`);
  check('P1 case 3: and it is marked as PHYSICALLY retained, not merely a live lease',
    h.wm.retainedResourceProtections().length === 1,
    `retained=${h.wm.retainedResourceProtections().length}`);
  // The observable consequence: a rival writer on the same scope is refused.
  const b = await h.orch.executeTask({ taskId: 'b' });
  check('P1 case 3: a later writer on the SAME scope is REFUSED (protection is real)',
    b.ok === false && b.code === 'resource-conflict', b.ok ? 'admitted' : String(b.code));
  h.cleanup();
}

/*
 * ---- Case 3b: the runtime PROVES nothing was created ----
 *
 * W3.2. The runtime is the only thing that may certify this, so the stub here does not
 * manufacture an error: it returns a frozen `RunResult` carrying the SAME verdict
 * `ManagedProcess` produces from its own knowledge, and the gate must honour it.
 *
 * The real producers behind that verdict are exercised against a real filesystem in
 * `containment-production.test.ts` (W3T-1/2/3) — this case covers the CLAIM LIFECYCLE
 * half, which is what keeps W3.1 from degenerating into "lock everything".
 */
{
  const store = new RefusingTaskStore();
  const repo3b = makeGitRepo('w32-lifecycle');
  const wm0 = new WorkspaceManager({ projectRoot: repo3b, workspaceLock: false, now: () => NOW });
  const budgets0 = new BudgetManager(10_000_000);
  budgets0.agent('opencode', 10_000_000);
  for (const t of ['a', 'b']) budgets0.task(t, 10_000);
  const registry0 = new ModelRegistry();
  registry0.upsert({ agentId: 'opencode', modelId: 'opencode/space-bunny-free', provider: 'opencode', taskTypes: ['implementation'] as never, modelSource: 'test', quotaSource: 'test' }, NOW);
  registry0.setAgentAvailability('opencode', 'available');

  let runs0 = 0;
  const runtime0 = {
    run: (r: RunRequest): RunHandle => {
      runs0++;
      if (runs0 > 1) throw new Error('case 3b only models the first dispatch');
      // A run that ended without a process ever being created: exactly what
      // `ManagedProcess` reports when the launcher image is proven absent.
      return {
        taskId: 'runtime-a',
        agentId: r.agentId,
        state: () => 'failed',
        events: () => ({ id: 1, droppedCount: () => 0, close: () => {}, [Symbol.asyncIterator]: async function* () { /* no frames */ } }),
        result: async () => ({
          taskId: 'runtime-a',
          threadId: null,
          agentId: r.agentId,
          state: 'failed' as const,
          startedAt: NOW,
          endedAt: NOW,
          exitCode: 127,
          signal: null,
          output: '',
          outputTruncated: false,
          transcriptPath: null,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, costUsd: 0 } as never,
          toolCalls: [],
          error: { code: 'SPAWN_FAILED' as never, message: 'containment unavailable', detail: null },
          diagnostics: [],
          cleanup: {
            rootKilled: false,
            descendantsReaped: false,
            treeStopConfirmed: false,
            processStart: 'not-started' as const,
            note: 'containment-unavailable',
          },
        }),
        cancel: async () => {},
      };
    },
  };

  const orch0 = new TaskOrchestrator({
    gate: {
      descriptors: [{ id: 'opencode', displayName: 'OpenCode', launcher: 'fake', transport: 'cli-jsonl', capabilities: { newTask: true, review: true, modelSelection: true, cwd: true, workspaceModes: ['shared'] } }],
      agentStatus: [{ agentId: 'opencode', agent: 'opencode', version: '1', installed: 'Yes', login: 'y', quotaSource: 't', usage: 'n', status: 'ok' }],
      quotaRecords: [{ provider: 'opencode', agentId: 'opencode', modelId: null, source: 'cli_reported', usage: null, remaining: null, resetAt: null, period: 'unknown', status: 'unavailable', usageClass: 'reported', confidence: 'high', observedAt: NOW, note: '' }],
      registry: registry0, budgets: budgets0, taskType: 'implementation', requestedUnits: 10, currentConcurrency: 0,
      maxConcurrency: 4, maxChildren: 8, maxConcurrentAgents: 4, taskPolicyAllows: true,
    } as never,
    store,
    runtime: runtime0 as never,
    defaultCwd: repo3b,
    now: () => NOW,
    executionTimeoutMs: 30_000,
    workspace: wm0,
    workspaceMode: () => 'shared',
    resourceClaims: () => ({ mode: 'write', scope: normalizeScopeForWorkspace('shared', repo3b) }),
  });
  orch0.createRoot({ taskId: 'r', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'root' });
  for (const id of ['a', 'b']) orch0.spawnChild({ taskId: id, parentTaskId: 'r', agentId: 'opencode', modelId: 'opencode/space-bunny-free', taskType: 'implementation', acceptanceCriteria: id, budgetUnits: 10 });

  const a = await orch0.executeTask({ taskId: 'a' });
  check('P1 case 3b: the dispatch ran and produced a terminal result', a.ok === true, a.ok ? '' : String(a.code));
  check('P1 case 3b: a PROVEN pre-start RELEASES the claim',
    wm0.resourceClaimCount === 0, `claims=${wm0.resourceClaimCount}`);
  check('P1 case 3b: and leaves no retained physical protection behind',
    wm0.retainedResourceProtections().length === 0);
  removeTempTree(join(repo3b, '..'));
}

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
  //
  // The window is generous because the `finally` body now carries the W3 gate and its
  // explanation before the release. What this assertion is actually about is
  // STRUCTURE — "every exit path reaches the release decision" — and that property is
  // unchanged by how long the decision takes to express. The narrower, sharper claim
  // ("the release runs only once the tree stop is confirmed") is asserted separately
  // in containment-production.test.ts, where the gate itself lives.
  const after = src.slice(tryAt);
  check('R2-2.1: the release is in a `finally`, so every exit path runs it',
    /finally\s*\{[\s\S]{0,3500}?releaseClaim\(/.test(after));
}

// ===========================================================================
// W3R — Physical Protection Retention Closure (P1-A and P1-B)
// ===========================================================================
section('W3R. durable physical protection survives every logical staleness signal');

/**
 * A claim held with physical protection, plus an ordinary one beside it.
 *
 * Both are lease-dead on purpose: that is the whole point. Logical staleness is what
 * the retention has to survive, so the control cannot be set up any other way.
 */
{
  const book = new ResourceClaimBook(() => NOW);
  const scope = dir('shared/src');
  book.claim({ taskId: 'A', workspaceId: 'task:A', mode: 'write', scope, leaseVersion: 7 });
  book.claim({ taskId: 'C', workspaceId: 'task:C', mode: 'write', scope: dir('other'), leaseVersion: 7 });

  // W3R-5/6/7: BOTH claims are lease-dead and handle-less. Only A is retained.
  const retained = book.retainProtection('A', 'write', scope, 'tree-stop-unconfirmed');
  check('W3R-5 retainProtection marked exactly the named claim', retained === 1, `retained=${retained}`);

  // W3R-6: lease invalidation + no live handle is what admission's sweep tests.
  const voided = book.voidClaimsWhere(() => true);
  check('W3R-7 a fully stale sweep does NOT remove the retained claim',
    voided === 1, `voided=${voided}`);
  check('W3R-7 the ordinary claim WAS voided by the same sweep',
    !book.all().some((c) => c.taskId === 'C'));
  check('W3R-7 the retained claim survived it',
    book.all().some((c) => c.taskId === 'A'));
  check('W3R-7 and the skip is observable rather than silent',
    book.retainedClaimsSkippedByLastVoid === 1, String(book.retainedClaimsSkippedByLastVoid));

  // W3R-8: admission. A rival writer must be refused while the protection stands.
  const rival = book.wouldConflict({ taskId: 'B', workspaceId: 'task:B', mode: 'write', scope });
  check('W3R-8 a conflicting writer is refused against retained protection',
    rival.length === 1 && rival[0]!.taskId === 'A', JSON.stringify(rival.map((c) => c.taskId)));
  // A rival READ is refused too: the risk is a live WRITER, not a read.
  const rivalRead = book.wouldConflict({ taskId: 'B2', workspaceId: 'task:B2', mode: 'read', scope });
  check('W3R-8 and so is a rival READ over the retained scope',
    rivalRead.length === 1, JSON.stringify(rivalRead.map((c) => c.taskId)));

  // W3R-10: an EXPLICIT release (backed by a real tree-stop proof) does clear it.
  const released = book.releaseClaimForScope('A', 'write', scope);
  check('W3R-10 an explicit release removes the retained claim', released === 1, `released=${released}`);
  check('W3R-10 and the scope is free again',
    book.wouldConflict({ taskId: 'B', workspaceId: 'task:B', mode: 'write', scope }).length === 0);
}

{
  // W3R-9: the CONTROL. Ordinary stale cleanup must NOT be disabled.
  const book = new ResourceClaimBook(() => NOW);
  const scope = dir('plain');
  book.claim({ taskId: 'D', workspaceId: 'task:D', mode: 'write', scope, leaseVersion: 7 });
  check('W3R-9 an ordinary claim is not retained to begin with',
    book.all().find((c) => c.taskId === 'D')?.protectionRetained === false);
  const voided = book.voidClaimsWhere(() => true);
  check('W3R-9 an ordinary stale claim is still cleaned up', voided === 1, `voided=${voided}`);
  check('W3R-9 and leaves nothing held', book.size === 0);
}

{
  // W3R-1/2: the P1-A reproduction, in a form that does not need a real agent.
  //
  // The runtime seam really spawns a WRITER (a detached child appending to a file), and
  // then throws — the exact shape that used to release the claim under a live writer.
  // The writer's liveness is asserted so this cannot pass as a false positive: if the
  // "writer" were already dead, retaining the claim would prove nothing.
  const repo = makeGitRepo('w3r-writer');
  const store = new RefusingTaskStore();
  const rt = new RuntimeOrch({ config: { agents: {} } as never } as never);
  const marker = join(repo, 'writer.txt');

  let runs = 0;
  let writerPid: number | null = null;
  const runtime = {
    run: (r: RunRequest) => {
      runs++;
      if (runs === 1) {
        // A REAL detached writer, so "protection was needed" is a physical fact here
        // and not an assumption.
        const c = spawn(process.execPath, ['-e',
          `setInterval(()=>require('fs').appendFileSync(${JSON.stringify(marker)},'x'),50)`],
        { detached: true, stdio: 'ignore' });
        writerPid = c.pid ?? null;
        c.unref();
        // Then throw, with no typed evidence — P1-A exactly.
        throw new Error('runtime seam failed after spawning its writer');
      }
      return rt.run(r);
    },
  };

  const wm = new WorkspaceManager({ projectRoot: repo, workspaceLock: false, now: () => NOW });
  const budgets = new BudgetManager(10_000_000);
  budgets.agent('opencode', 10_000_000);
  for (const t of ['a', 'b']) budgets.task(t, 10_000);
  const registry = new ModelRegistry();
  registry.upsert({ agentId: 'opencode', modelId: 'opencode/space-bunny-free', provider: 'opencode', taskTypes: ['implementation'] as never, modelSource: 'test', quotaSource: 'test' }, NOW);
  registry.setAgentAvailability('opencode', 'available');

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
    executionTimeoutMs: 30_000,
    workspace: wm,
    workspaceMode: () => 'shared',
    resourceClaims: () => ({ mode: 'write', scope: normalizeScopeForWorkspace('shared', repo) }),
  });
  orch.createRoot({ taskId: 'r', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'root' });
  for (const id of ['a', 'b']) orch.spawnChild({ taskId: id, parentTaskId: 'r', agentId: 'opencode', modelId: 'opencode/space-bunny-free', taskType: 'implementation', acceptanceCriteria: id, budgetUnits: 10 });

  const a = await orch.executeTask({ taskId: 'a' });
  check('W3R-1 A is refused', a.ok === false, a.ok ? 'ran' : String(a.code));

  // The writer is spawned INSIDE the seam, so it can only be observed after the call.
  // Waiting here also proves it is a long-lived writer rather than a one-shot write:
  // if it had died with the throw, "still writing" below would be vacuous.
  await new Promise((r) => setTimeout(r, 600));
  const bytesBefore = existsSync(marker) ? readFileSync(marker, 'utf8').length : 0;
  check('W3R-1 the writer really was writing after the throw', bytesBefore > 0, `bytes=${bytesBefore}`);

  // W3R-1: the protection is durable, not merely un-released.
  check('W3R-1 the WRITE claim is retained after a post-spawn throw',
    wm.resourceClaimCount === 1, `claims=${wm.resourceClaimCount}`);
  check('W3R-1 and it is marked as PHYSICALLY retained',
    wm.retainedResourceProtections().length === 1,
    `retained=${wm.retainedResourceProtections().length}`);

  // W3R-2: a rival writer must be refused, with ZERO runtime calls of its own.
  const runsBeforeB = runs;
  const b = await orch.executeTask({ taskId: 'b' });
  check('W3R-2 a conflicting writer is REFUSED (resource-conflict)',
    b.ok === false && b.code === 'resource-conflict', b.ok ? 'admitted' : String(b.code));
  check('W3R-2 and it made NO runtime call at all', runs === runsBeforeB, `runs=${runs} before=${runsBeforeB}`);

  // And the writer is STILL writing — proof the refusal was necessary, not ceremonial.
  await new Promise((r) => setTimeout(r, 500));
  const bytesAfter = existsSync(marker) ? readFileSync(marker, 'utf8').length : 0;
  check('W3R-2 the old writer is STILL alive and writing (the block was necessary)',
    bytesAfter > bytesBefore, `${bytesBefore}->${bytesAfter}`);

  // Clean up the writer we started.
  if (writerPid !== null) { try { process.kill(writerPid, 'SIGKILL'); } catch { /* already gone */ } }
  removeTempTree(join(repo, '..'));
}

{
  // W3R-3/4: the predicate trusts ONLY the runtime's private brand.
  //
  // W3.2 removed the public constructor, so a test cannot mint proof at all. What is
  // asserted here is that every LOOK-ALIKE a caller could plausibly build is rejected.
  check('W3R-4 a generic throw is NOT trusted proof',
    isProvenNotStarted(new Error('boom')) === false);
  check('W3R-7 neither is a matching NAME',
    isProvenNotStarted(Object.assign(new Error('x'), { name: 'TrustedNotStarted' })) === false);
  check('W3R-7 nor a matching MESSAGE',
    isProvenNotStarted(new Error('no process was created')) === false);
  check('W3R-7 nor a matching CODE',
    isProvenNotStarted(Object.assign(new Error('x'), { code: 'ENOENT' })) === false);
  check('W3R-7 nor a matching REASON field',
    isProvenNotStarted(Object.assign(new Error('x'), { reason: 'launcher-unavailable' })) === false);
  check('W3R-7 nor a plain boolean property',
    isProvenNotStarted(Object.assign(new Error('x'), { provenNotStarted: true })) === false);
  check('W3R-3 nor a non-error at all',
    isProvenNotStarted('not-started') === false &&
    isProvenNotStarted(undefined) === false &&
    isProvenNotStarted(null) === false &&
    isProvenNotStarted({ reason: 'launcher-unavailable' }) === false);
  check('W3R-4 and a PROTOTYPE-inherited brand is not honoured either',
    isProvenNotStarted(Object.create({ name: 'TrustedNotStarted', reason: 'x' })) === false);
}

{
  // W3R-11/12: the hard-kill case keeps protection; a true pre-start never creates it.
  //
  // Both are about which side of the line a given outcome falls on, and they are
  // asserted here against the mechanism that draws the line, so the two halves cannot
  // drift apart silently.
  const book = new ResourceClaimBook(() => NOW);
  const scope = dir('hardkill');
  book.claim({ taskId: 'H', workspaceId: 'task:H', mode: 'write', scope, leaseVersion: 3 });
  // W3R-11: a hard kill yields no tree-stop proof, so the orchestrator would retain.
  book.retainProtection('H', 'write', scope, 'launcher hard-killed; no Job-empty proof');
  const afterSweep = book.voidClaimsWhere(() => true);
  check('W3R-11 an unconfirmed hard-kill keeps its protection across a full sweep',
    afterSweep === 0 && book.all().length === 1, `voided=${afterSweep} held=${book.all().length}`);
  check('W3R-11 so a rival writer stays blocked',
    book.wouldConflict({ taskId: 'Z', workspaceId: 'task:Z', mode: 'write', scope }).length === 1);

  // W3R-12: a control-directory failure is a PROVEN pre-start, so nothing is retained.
  const book2 = new ResourceClaimBook(() => NOW);
  const scope2 = dir('controlfail');
  book2.claim({ taskId: 'K', workspaceId: 'task:K', mode: 'write', scope: scope2, leaseVersion: 3 });
  check('W3R-12 a proven pre-start failure creates NO retained protection',
    book2.retainedProtectionClaims().length === 0);
  check('W3R-12 and its claim is released normally',
    book2.releaseClaimForScope('K', 'write', scope2) === 1);
  check('W3R-12 leaving the scope free',
    book2.wouldConflict({ taskId: 'Z', workspaceId: 'task:Z', mode: 'write', scope: scope2 }).length === 0);
}

{
  // W3R architecture: no new authority, and the single execution edge is intact.
  const src = readFileSync(join(ROOT, 'src', 'orchestration', 'orchestrator.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  check('W3R no ProtectionManager / ClaimRecoveryManager / ContainmentStateAuthority',
    !/class (ProtectionManager|ClaimRecoveryManager|ContainmentStateAuthority)/.test(code));
  const sites = code.split('runtime.run(').length - 1;
  check('W3R the runtime.run production callsite is still exactly 1', sites === 1, String(sites));
  check('W3R the requirement is raised BEFORE the edge, not after it',
    code.indexOf('requiresTreeStopProof[0] = true') < code.indexOf('this.runtime.run('));
  check('W3R only typed evidence may lower it',
    /if \(isProvenNotStarted\(e\)\)/.test(code));
  check('W3R the release gate consults the requirement',
    /const proofRequired = requiresTreeStopProof\[0\]/.test(code));
  check('W3R retention is recorded in the book, not in a closure bool',
    /retainResourceProtection\(/.test(code));
  // Strip comments before the scan: this module legitimately DISCUSSES jobs and
  // launchers in prose (that is where it explains why it delegates to them), and
  // scanning raw text would flag the explanation as if it were the dependency.
  const rcRaw = readFileSync(join(ROOT, 'src', 'orchestration', 'resource-claim.ts'), 'utf8');
  const rc = rcRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  check('W3R ResourceClaimBook asks nothing about processes, jobs or launchers',
    !/ActiveProcesses|launcherStatus|isTreeStopConfirmed|ManagedProcess|TerminateJobObject/.test(rc),
    (rc.match(/.{0,40}(ActiveProcesses|launcherStatus|ManagedProcess).{0,20}/) ?? [])[0] ?? '');
  check('W3R and it exposes exactly the retention primitives, nothing more',
    /retainProtection\(/.test(rc) && /retainedProtectionClaims\(/.test(rc));
}

{
  // W3T-8/9: `write` vs `exclusive-write` on the SAME taskId + scopeKey.
  //
  // This is the P1-C collision. The old matcher was
  // `claimId.endsWith(`${mode}:${scopeKey}`)`, and `write:<key>` IS a suffix of
  // `exclusive-write:<key>`, so one operation silently hit both claims.
  const book = new ResourceClaimBook(() => NOW);
  const scope = dir('shared');
  book.claim({ taskId: 'W', workspaceId: 'task:W', mode: 'write', scope, leaseVersion: 4 });
  book.claim({ taskId: 'W', workspaceId: 'task:W', mode: 'exclusive-write', scope, leaseVersion: 4 });
  check('W3T-8 both claims coexist', book.size === 2, `size=${book.size}`);

  const retainedWrite = book.retainProtection('W', 'write', scope, 'tree-stop-unconfirmed');
  check('W3T-8 retaining `write` changes exactly ONE claim', retainedWrite === 1, `retained=${retainedWrite}`);
  const modes = book.retainedProtectionClaims().map((c) => c.mode).sort();
  check('W3T-8 and only the `write` claim is retained',
    modes.length === 1 && modes[0] === 'write', JSON.stringify(modes));

  const releasedWrite = book.releaseClaimForScope('W', 'write', scope);
  check('W3T-9 releasing `write` releases exactly ONE claim', releasedWrite === 1, `released=${releasedWrite}`);
  check('W3T-9 and the `exclusive-write` claim SURVIVES',
    book.all().some((c) => c.mode === 'exclusive-write') && !book.all().some((c) => c.mode === 'write'),
    JSON.stringify(book.all().map((c) => c.mode)));

  // And the reverse: operating on exclusive-write must not reach `write`.
  book.claim({ taskId: 'W2', workspaceId: 'task:W2', mode: 'write', scope: dir('shared2'), leaseVersion: 4 });
  book.claim({ taskId: 'W2', workspaceId: 'task:W2', mode: 'exclusive-write', scope: dir('shared2'), leaseVersion: 4 });
  const rEx = book.retainProtection('W2', 'exclusive-write', dir('shared2'), 'x');
  check('W3T-8 retaining `exclusive-write` changes exactly ONE claim', rEx === 1, `retained=${rEx}`);
  check('W3T-8 and leaves `write` untouched',
    book.all().filter((c) => c.taskId === 'W2' && c.mode === 'write')[0]?.protectionRetained === false);
}

{
  // W3T-10/11: multiple scopes under one task, including prefix/suffix siblings.
  //
  // `scope-A` must not reach `scope-A-suffix` or `prefix-scope-A`. String-prefix
  // matching reached both.
  const book = new ResourceClaimBook(() => NOW);
  const a = dir('scope-A');
  const aSuffix = dir('scope-A-suffix');
  const aPrefixed = dir('prefix-scope-A');
  for (const [i, s] of [a, aSuffix, aPrefixed].entries()) {
    book.claim({ taskId: 'M', workspaceId: `task:M${i}`, mode: 'write', scope: s, leaseVersion: 9 });
  }
  check('W3T-10 three distinct scopes are held', book.size === 3, `size=${book.size}`);

  const retainedA = book.retainProtection('M', 'write', a, 'tree-stop-unconfirmed');
  check('W3T-10 retaining scope-A changes exactly ONE claim', retainedA === 1, `retained=${retainedA}`);
  check('W3T-10 and neither the prefix nor the suffix sibling is touched',
    book.all().filter((c) => c.protectionRetained).length === 1 &&
    book.all().find((c) => c.scopeKey === scopeKeyOf(a))?.protectionRetained === true);

  const releasedA = book.releaseClaimForScope('M', 'write', a);
  check('W3T-11 releasing scope-A releases exactly ONE claim', releasedA === 1, `released=${releasedA}`);
  check('W3T-11 and both siblings still exist',
    book.all().find((c) => c.scopeKey === scopeKeyOf(aSuffix)) !== undefined &&
    book.all().find((c) => c.scopeKey === scopeKeyOf(aPrefixed)) !== undefined);
}

{
  // W3T-12: a confirmed stop releases ONLY the intended claim.
  //
  // The safety half of the P1-C finding: exactness must not weaken into
  // "release everything this task holds".
  const book = new ResourceClaimBook(() => NOW);
  const keep = dir('keep');
  const free = dir('free');
  book.claim({ taskId: 'S', workspaceId: 'task:S', mode: 'write', scope: keep, leaseVersion: 2 });
  book.claim({ taskId: 'S', workspaceId: 'task:S', mode: 'write', scope: free, leaseVersion: 2 });
  const released = book.releaseClaimForScope('S', 'write', free);
  check('W3T-12 the confirmed stop released exactly the intended scope', released === 1, `released=${released}`);
  check('W3T-12 and the other scope of the SAME task is still held',
    book.all().length === 1 && book.all()[0]!.scopeKey === scopeKeyOf(keep),
    JSON.stringify(book.all().map((c) => c.scopeKey)));
}

{
  // W3T-13: retention safety is unchanged by the identity fix.
  const book = new ResourceClaimBook(() => NOW);
  const scope = dir('retained');
  book.claim({ taskId: 'R', workspaceId: 'task:R', mode: 'write', scope, leaseVersion: 5 });
  book.retainProtection('R', 'write', scope, 'tree-stop-unconfirmed');
  // Lease dead, no live handle, settled session — the full stale sweep.
  book.voidClaimsWhere(() => true);
  check('W3T-13 a retained claim still survives a full stale sweep', book.size === 1, `size=${book.size}`);
  check('W3T-13 and still conflicts with a rival WRITE',
    book.wouldConflict({ taskId: 'X', workspaceId: 'task:X', mode: 'write', scope }).length === 1);
  check('W3T-13 and with a rival READ (a live writer is unsafe to read over)',
    book.wouldConflict({ taskId: 'X2', workspaceId: 'task:X2', mode: 'read', scope }).length === 1);
  check('W3T-13 and with a rival exclusive-write',
    book.wouldConflict({ taskId: 'X3', workspaceId: 'task:X3', mode: 'exclusive-write', scope }).length === 1);
}

{
  // W3.2 architecture: claimId is OPAQUE, and the trust boundary holds.
  const rcRaw = readFileSync(join(ROOT, 'src', 'orchestration', 'resource-claim.ts'), 'utf8');
  const rc = rcRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  // PART E: no resource operation may parse claimId any more. Scoped to `claimId`
  // specifically: the module legitimately uses `endsWith` for PATH normalization
  // (a trailing separator), which is unrelated to claim identity.
  check('W3T claimId is never parsed for a resource operation',
    !/claimId\.(startsWith|endsWith|includes|match|split)/.test(rc),
    (rc.match(/claimId\.(startsWith|endsWith|includes|match|split)[^\n]*/) ?? [])[0] ?? '');
  check('W3T retain/release both route through the exact matcher',
    (rc.match(/matchesClaimScope\(/g) ?? []).length >= 3, String((rc.match(/matchesClaimScope\(/g) ?? []).length));

  // PART A: the producer capability lives only inside src/runtime.
  //
  // `src/runtime/**` importing the internal module is the DESIGN (spawn.ts produces the
  // proof; start-proof.ts re-exports the predicate). The violation being guarded against
  // is anyone OUTSIDE the runtime reaching the producer.
  const internalPath = join(ROOT, 'src', 'runtime', 'internal', 'start-proof.ts');
  check('W3T the runtime internal proof module exists', existsSync(internalPath));
  const producers = ['markProvenNotStarted', 'asProvenNotStarted'];
  const selfPath = fileURLToPath(import.meta.url);
  const offenders: string[] = [];
  const walk = (dirPath: string): void => {
    for (const e of readdirSync(dirPath, { withFileTypes: true })) {
      const full = join(dirPath, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.ts')) continue;
      if (full === selfPath) continue; // this guard necessarily names the producers
      const text = readFileSync(full, 'utf8');
      if (!/internal\/start-proof/.test(text)) continue;
      if (full.startsWith(join(ROOT, 'src', 'runtime'))) continue; // the trust boundary
      offenders.push(full.replace(ROOT, '.'));
    }
  };
  walk(join(ROOT, 'src'));
  walk(join(ROOT, 'tests'));
  check('W3T ONLY src/runtime may import the producer module', offenders.length === 0, offenders.join(', '));

  // And the public surface really is predicate-only.
  const pub = readFileSync(join(ROOT, 'src', 'runtime', 'start-proof.ts'), 'utf8');
  const pubExports = [...pub.matchAll(/export\s*\{([^}]*)\}/g)].map((m) => m[1]!.trim());
  check('W3T the public module exports only the predicate',
    pubExports.length === 1 && pubExports[0]!.includes('isProvenNotStarted'),
    pubExports.join(' | '));
  check('W3T and exposes no class, factory or brand helper',
    !/class |function |new WeakSet|markProvenNotStarted/.test(pub));

  // No orchestration/core file may reference the producers at all.
  const badRefs: string[] = [];
  const walk2 = (dirPath: string): void => {
    for (const e of readdirSync(dirPath, { withFileTypes: true })) {
      const full = join(dirPath, e.name);
      if (e.isDirectory()) { walk2(full); continue; }
      if (!e.name.endsWith('.ts')) continue;
      const text = readFileSync(full, 'utf8');
      if (full === selfPath) continue; // this guard necessarily names them
      for (const p of producers) {
        if (text.includes(p) && !full.startsWith(join(ROOT, 'src', 'runtime'))) {
          badRefs.push(`${full.replace(ROOT, '.')} -> ${p}`);
        }
      }
    }
  };
  walk2(join(ROOT, 'src'));
  walk2(join(ROOT, 'tests'));
  check('W3T nothing outside src/runtime can even NAME the producers', badRefs.length === 0, badRefs.join(' | '));
  check('W3T no StartProofManager / ClaimIdentityManager / ProtectionAuthority',
    !/class (StartProofManager|ClaimIdentityManager|ProtectionAuthority)/.test(rc + pub + rcRaw));
  const orchSrc = readFileSync(join(ROOT, 'src', 'orchestration', 'orchestrator.ts'), 'utf8');
  const orchCode = orchSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  check('W3T the runtime.run production callsite is still exactly 1',
    orchCode.split('runtime.run(').length - 1 === 1);
}

// ===========================================================================
// W3P — Runtime preflight proof: validation before the process boundary
// ===========================================================================
section('W3P. runtime preflight proof: validation before the process boundary');

{
  /*
   * The REAL runtime, the REAL OpenCode adapter, the REAL preflight. No stubs: the
   * point of W3.3 is that the runtime itself certifies these failures, so a test that
   * faked the producer would prove nothing.
   */
  const repo = makeGitRepo('w3p');
  const rt = new RuntimeOrch({
    config: { agents: {} } as never,
    storeDir: join(repo, '.store'),
    // The launcher is bypassed so this does not depend on which binaries are installed;
    // `validateRequest` is pure and is what we are exercising.
    replaceAdapters: [createOpenCodeAdapter({ launcher: FAKE_LAUNCHER })],
  });

  // W3P-1: timeoutMs=0 is rejected in the preflight region, before any transport/child.
  let err1: unknown = null;
  try {
    rt.run({ agentId: 'opencode', prompt: 'p', cwd: repo, timeoutMs: 0 });
  } catch (e) {
    err1 = e;
  }
  check('W3P-1 timeoutMs=0 is rejected', err1 !== null);
  check('W3P-1 and the rejection carries trusted not-started proof', isProvenNotStarted(err1));
  // The brand must be IN PLACE: callers still get their own error class and message.
  check('W3P-1 the error identity survives branding', err1 instanceof InvalidRequestError,
    err1 instanceof Error ? err1.name : String(err1));

  // W3P-2: after repairing the timeout, the SAME runtime launches normally.
  {
    let ok = true;
    let handle: RunHandle | null = null;
    try {
      handle = rt.run({ agentId: 'opencode', prompt: 'p', cwd: repo, timeoutMs: 30_000 });
    } catch {
      ok = false;
    }
    check('W3P-2 a repaired timeout is accepted (no poisoned scope)', ok && handle !== null);
    await handle?.cancel('W3P-2 cleanup');
  }

  // W3P-3: an unsupported sandbox option, via the real adapter's own validation.
  let err3: unknown = null;
  try {
    rt.run({ agentId: 'opencode', prompt: 'p', cwd: repo, sandbox: 'read-only' });
  } catch (e) {
    err3 = e;
  }
  check('W3P-3 an unsupported sandbox is rejected', err3 !== null);
  check('W3P-3 with trusted not-started proof', isProvenNotStarted(err3));
  check('W3P-3 preserving the UnsupportedOptionError identity', err3 instanceof UnsupportedOptionError,
    err3 instanceof Error ? err3.name : String(err3));

  // W3P-4: repaired setting accepted.
  {
    let ok = true;
    let handle: RunHandle | null = null;
    try {
      handle = rt.run({ agentId: 'opencode', prompt: 'p', cwd: repo });
    } catch {
      ok = false;
    }
    check('W3P-4 a repaired sandbox setting is accepted', ok && handle !== null);
    await handle?.cancel('W3P-4 cleanup');
  }

  // W3P-5: an ARBITRARY error thrown inside the preflight region is branded too. The
  // classification is by PHASE, not by error type, so a new validation added to this
  // region is covered without touching the producer.
  let err5: unknown = null;
  try {
    validateRuntimeLaunchPreflight({
      req: { agentId: 'opencode', prompt: 'p', cwd: repo } as RunRequest,
      capabilities: { newTask: true, review: true, resume: true },
      config: { model: undefined, role: undefined, sandbox: undefined, timeoutMs: undefined },
      validateAdapterRequest: () => { throw new Error('a brand-new validation nobody special-cased'); },
      resolveResumeTarget: () => '',
    });
  } catch (e) {
    err5 = e;
  }
  check('W3P-5 an arbitrary error thrown in the preflight region is trusted not-started',
    isProvenNotStarted(err5), err5 instanceof Error ? err5.message : String(err5));

  removeTempTree(join(repo, '..'));
}

{
  /*
   * W3P-6: the CONTRAST. The identical-looking error, thrown AFTER the process
   * boundary, must NOT be trusted. This is what proves the decision is made by phase
   * and not by the error's text or class.
   *
   * The claim half is asserted too: an untrusted throw retains protection.
   */
  const repo = makeGitRepo('w3p-6');
  const store = new RefusingTaskStore();
  const runtime = {
    run: () => { throw new Error('a brand-new validation nobody special-cased'); },
  };
  const wm = new WorkspaceManager({ projectRoot: repo, workspaceLock: false, now: () => NOW });
  const budgets = new BudgetManager(10_000_000);
  budgets.agent('opencode', 10_000_000);
  for (const t of ['a', 'b']) budgets.task(t, 10_000);
  const registry = new ModelRegistry();
  registry.upsert({ agentId: 'opencode', modelId: 'opencode/space-bunny-free', provider: 'opencode', taskTypes: ['implementation'] as never, modelSource: 'test', quotaSource: 'test' }, NOW);
  registry.setAgentAvailability('opencode', 'available');
  const orch = new TaskOrchestrator({
    gate: {
      descriptors: [{ id: 'opencode', displayName: 'OpenCode', launcher: 'fake', transport: 'cli-jsonl', capabilities: { newTask: true, review: true, modelSelection: true, cwd: true, workspaceModes: ['shared'] } }],
      agentStatus: [{ agentId: 'opencode', agent: 'opencode', version: '1', installed: 'Yes', login: 'y', quotaSource: 't', usage: 'n', status: 'ok' }],
      quotaRecords: [{ provider: 'opencode', agentId: 'opencode', modelId: null, source: 'cli_reported', usage: null, remaining: null, resetAt: null, period: 'unknown', status: 'unavailable', usageClass: 'reported', confidence: 'high', observedAt: NOW, note: '' }],
      registry, budgets, taskType: 'implementation', requestedUnits: 10, currentConcurrency: 0,
      maxConcurrency: 4, maxChildren: 8, maxConcurrentAgents: 4, taskPolicyAllows: true,
    } as never,
    store, runtime: runtime as never, defaultCwd: repo, now: () => NOW,
    executionTimeoutMs: 30_000, workspace: wm,
    workspaceMode: () => 'shared',
    resourceClaims: () => ({ mode: 'write', scope: normalizeScopeForWorkspace('shared', repo) }),
  });
  orch.createRoot({ taskId: 'r', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'root' });
  for (const id of ['a', 'b']) orch.spawnChild({ taskId: id, parentTaskId: 'r', agentId: 'opencode', modelId: 'opencode/space-bunny-free', taskType: 'implementation', acceptanceCriteria: id, budgetUnits: 10 });

  const a = await orch.executeTask({ taskId: 'a' });
  check('W3P-6 an identical error thrown past the boundary is NOT trusted', !isProvenNotStarted(new Error('a brand-new validation nobody special-cased')));
  check('W3P-6 and the write claim is RETAINED', wm.resourceClaimCount === 1 && a.ok === false,
    `claims=${wm.resourceClaimCount}`);
  const b6 = await orch.executeTask({ taskId: 'b' });
  check('W3P-6 so a rival writer is refused', b6.ok === false && b6.code === 'resource-conflict',
    b6.ok ? 'admitted' : String(b6.code));
  removeTempTree(join(repo, '..'));
}

{
  // W3.3 architecture + trust-boundary recheck.
  const rtRaw = readFileSync(join(ROOT, 'src', 'runtime', 'preflight.ts'), 'utf8');
  const orchRaw = readFileSync(join(ROOT, 'src', 'orchestrator', 'orchestrator.ts'), 'utf8');
  const orchCode = orchRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const rtCode = rtRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  check('W3P no PreflightManager / StartDispositionAuthority / ValidationManager',
    !/class (PreflightManager|StartDispositionAuthority|ValidationManager)/.test(orchCode + rtCode));
  check('W3P the runtime.run production callsite is still exactly 1',
    readFileSync(join(ROOT, 'src', 'orchestration', 'orchestrator.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
      .split('runtime.run(').length - 1 === 1);
  // Orchestration must not classify error classes to decide process-start truth.
  check('W3P orchestration does not branch on validation error classes',
    !/instanceof (InvalidRequestError|UnsupportedOptionError|CapabilityError)/.test(orchCode));
  // The preflight delegates to the runtime-owned validator.
  check('W3P the execution edge delegates to the runtime-owned preflight',
    /validateRuntimeLaunchPreflight\(/.test(orchCode));
  // The preflight brands through the runtime-internal producer only.
  check('W3P the preflight brands via the runtime-internal producer',
    /brandProvenNotStarted\(/.test(rtCode) && /from '\.\/internal\/start-proof\.ts'/.test(rtRaw));
  // The producer is still not reachable from orchestration or core.
  const bad: string[] = [];
  const scan = (dirPath: string): void => {
    for (const e of readdirSync(dirPath, { withFileTypes: true })) {
      const full = join(dirPath, e.name);
      if (e.isDirectory()) { scan(full); continue; }
      if (!e.name.endsWith('.ts')) continue;
      if (full.startsWith(join(ROOT, 'src', 'runtime'))) continue;
      const text = readFileSync(full, 'utf8');
      if (/internal\/start-proof/.test(text) || /\bmarkProvenNotStarted\b|\bbrandProvenNotStarted\b/.test(text)) {
        if (full !== fileURLToPath(import.meta.url)) bad.push(full.replace(ROOT, '.'));
      }
    }
  };
  scan(join(ROOT, 'src'));
  check('W3P the producer capability still lives only inside src/runtime', bad.length === 0, bad.join(', '));
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length > 0) {
  process.stdout.write(`failing:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
  process.exitCode = 1;
}
