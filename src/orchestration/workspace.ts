/**
 * src/orchestration/workspace.ts 鈥?Workspace / git worktree isolation (5C-5).
 *
 * This is what makes the remaining limitation honest. Until now the Scheduler
 * could run two children at once but they shared one `cwd`, so "parallel
 * execution" was real and "parallel code-edit isolation" was not. Two children
 * writing files in one checkout destroy each other's work; nothing in the
 * orchestration layer could prevent it.
 *
 * The fix is deliberately small and delegates to git rather than inventing a VCS
 * abstraction:
 *
 *   Task 鈫?WorkspaceManager.prepare(task) 鈫?workspace.cwd 鈫?RunRequest.cwd
 *
 * Design source, honestly labelled: `pi-subagents/src/worktree.ts` (MIT) and
 * Symphony's per-issue workspace (Apache-2.0) are ARCHITECTURE REFERENCE only 鈥? * their shapes (per-unit worktree, record baseSha, retain-on-dirty, explicit
 * cleanup) informed this design. No upstream source is vendored or copied.
 *
 * Two hard rules that shape most of the code below:
 *
 *   1. **A missing signal is a refusal.** If isolation was requested and the
 *      worktree cannot be created, we DENY. There is no fallback to the repo
 *      root, because "silently share a checkout" is the exact failure this layer
 *      exists to prevent 鈥?it would look like isolation while being none.
 *   2. **A workspace is a lifecycle, not a temp dir.** A successful, failed or
 *      cancelled run all RETAIN the workspace so the result stays inspectable.
 *      Removal is explicit.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { runGit, stderrIsFatal, resolveGitPath, type GitResult } from './git.ts';
import type { GitContext } from './task-result.ts';
import { WorkspaceError, WORKSPACE_ERROR_CODES, type WorkspaceErrorCode } from './errors.ts';
import {
  ResourceClaimBook,
  modeRequiresIsolation,
  type ClaimOutcome,
  type ClaimRequest,
  type ResourceClaim,
  type ResourceClaimMode,
  type ResourceScope,
} from './resource-claim.ts';

export {
  ResourceClaimBook,
  modeRequiresIsolation,
  claimsConflict,
  scopesOverlap,
  normalizeScope,
  type ClaimOutcome,
  type ClaimRequest,
  type ResourceClaim,
  type ResourceClaimMode,
  type ResourceScope,
} from './resource-claim.ts';
import { WorkspaceLock, workspaceLockKey, normalizeIdentityPath, type WorkspaceLockLease } from './workspace-lock.ts';
import type { WorkspaceMode } from '../core/types.ts';
import type { Task } from './task.ts';

/**
 * `isolated` — a private `git worktree`, so the task cannot see or disturb any
 * other task's working tree. This is what makes parallel code edits safe.
 * `shared` — an explicitly named directory, used when isolation is not wanted
 * (e.g. a review reading an existing tree). Never silently upgraded to isolated.
 *
 * The single definition lives in `core/types.ts` (5C-6) so the capability model
 * can name a mode without depending on this module; it is re-exported here
 * because this module, not core, is where the workspace behaviour lives.
 */
export type { WorkspaceMode };

/** How the workspace is disposed of. `retain` is the only automatic behaviour. */
export type WorkspaceCleanupPolicy = 'retain';

export interface WorkspaceHandle {
  /** Stable per task: `task:<taskId>`. Identity does not change across calls. */
  readonly workspaceId: string;
  readonly mode: WorkspaceMode;
  readonly taskId: string;
  /** The directory handed to `RunRequest.cwd`. Always verified to exist. */
  readonly cwd: string;
  /** `null` for shared. */
  readonly branch: string | null;
  /** Commit the worktree was created from. `null` for shared. */
  readonly baseSha: string | null;
  /** Repository root, or the shared directory. `null` when git is unavailable. */
  readonly repoRoot: string | null;
  readonly createdAt: number;
  /** True once explicitly released. A released handle is never reused. */
  readonly released: boolean;
}

export { WorkspaceError, WORKSPACE_ERROR_CODES, type WorkspaceErrorCode };

export interface WorkspaceManagerOptions {
  /**
   * Project root. For `isolated` it must be inside a git repository; for
   * `shared` it is the directory to hand out (and must exist).
   */
  projectRoot: string;
  /**
   * Where worktrees are created. Defaults to a SIBLING directory of the repo
   * (`<parent>/.p4m-worktrees/<repo>-<task>`) rather than inside the repo, so a
   * checkout is never polluted by its own worktrees and `git status` stays clean.
   */
  worktreeRoot?: string;
  /** Absolute path to `git`. Resolved from PATH when omitted. */
  gitPath?: string;
  now?: () => number;
  gitTimeoutMs?: number;
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * 5C-8: enable the cross-process workspace creation lock. ON by default;
   * set `false` only for a caller that is certain to be the only process.
   */
  workspaceLock?: boolean;
  /** How long to wait for a contended workspace lock. */
  workspaceLockTimeoutMs?: number;
  /** Where lock files live. Defaults to a SIBLING `<parent>/.p4m-locks`. */
  lockDir?: string;
  /**
   * 5C-8: extra branches that reclamation must never delete, on top of the
   * detected default branch, `main`/`master`, and any currently checked-out
   * branch.
   */
  protectedBranches?: readonly string[];
}

/** Default policy: code-writing tasks get a private worktree; review shares. */
export function defaultWorkspaceMode(task: Task): WorkspaceMode {
  return task.taskType === 'review' ? 'shared' : 'isolated';
}

/**
 * Sanitise a task id into a git-safe branch segment.
 *
 * The prompt NEVER enters a branch name: it is untrusted text and a branch name
 * is a path-like identifier. Only the task id is used, and it is reduced to
 * `[A-Za-z0-9._-]`. Leading `-` is stripped because git would read it as a flag.
 */
export function branchForTask(taskId: string): string {
  const cleaned = taskId
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
    .slice(0, 80);
  if (cleaned === '') {
    throw new WorkspaceError('workspace-invalid-task-id', `task id "${taskId}" has no branch-safe characters`);
  }
  return `orch/task/${cleaned}`;
}

// `resolveGitPath`, `runGit`, `stderrIsFatal` now live in ./git.ts — the single git
// authority for this layer. Re-exported so existing importers keep working.
export { resolveGitPath };
export type { GitResult };

export class WorkspaceManager {
  private readonly projectRoot: string;
  private readonly worktreeRoot: string;
  private readonly gitPath: string;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly env: Record<string, string | undefined>;
  /** The workspace lifecycle authority. Deliberately NOT in TaskStore. */
  private readonly handles = new Map<string, WorkspaceHandle>();
  private gitAvailable: boolean | null = null;
  /**
   * 5C-8 cross-process creation lock. `null` disables locking entirely, which is
   * the honest default for a caller that knowingly runs single-process.
   */
  private readonly lock: WorkspaceLock | null;
  private readonly lockEnabled: boolean;
  private readonly lockTimeoutMs: number;
  /** Branches this deployment refuses to delete, beyond the detected defaults. */
  private readonly extraProtectedBranches: readonly string[];
  /** Cache of the resolved default branch per repo root. */
  private readonly defaultBranchCache = new Map<string, string | null>();
  /**
   * R2-1: the resource-claim registry (§7 of the R2 contract).
   *
   * §4 assigns ResourceClaim to THIS class — the existing workspace authority — and
   * explicitly rules out a Resource Scheduler. So the claims live here and are
   * reached through `claimResource` / `releaseResourceClaims` / `resourceConflicts`.
   * `ResourceClaimBook` is pure bookkeeping; it cannot spawn, dispatch, or mutate a
   * task, which is what keeps this an extension of one authority rather than a
   * second one.
   */
  private readonly claims: ResourceClaimBook;

  constructor(options: WorkspaceManagerOptions) {
    this.projectRoot = resolvePath(options.projectRoot);
    this.worktreeRoot = options.worktreeRoot
      ? resolvePath(options.worktreeRoot)
      : join(dirname(this.projectRoot), '.p4m-worktrees');
    this.gitPath = options.gitPath ?? resolveGitPath();
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.gitTimeoutMs ?? 30_000;
    this.env = options.env ?? {};
    this.claims = new ResourceClaimBook(this.now);
    // 5C-8: locking is ON by default. A single-process caller loses nothing
    // (the lock is uncontended and costs one file create), and a second process
    // is then safe. Opt out explicitly with `workspaceLock: false`.
    this.lockEnabled = options.workspaceLock ?? true;
    this.lockTimeoutMs = options.workspaceLockTimeoutMs ?? 60_000;
    this.extraProtectedBranches = options.protectedBranches ?? [];
    this.lock = this.lockEnabled
      ? new WorkspaceLock({
          // A SIBLING of the project, for the same reason `worktreeRoot` is one:
          // the user's checkout must not accumulate our bookkeeping. The lock key
          // already carries a digest of the project path, so one shared sibling
          // directory can serve several projects without them colliding.
          lockDir: options.lockDir ?? join(dirname(this.projectRoot), '.p4m-locks'),
          timeoutMs: this.lockTimeoutMs,
          ...(options.now !== undefined ? { now: options.now } : {}),
        })
      : null;
  }

  getProjectRoot(): string {
    return this.projectRoot;
  }

  // ---------------------------------------------------------------- R2-1
  // §7 Resource Claims, as METHODS on the existing workspace authority.
  //
  // None of these dispatch anything, none of them mutate a task, and none of them
  // is a scheduler: they register and arbitrate who may touch what inside a
  // workspace this manager already owns.

  /**
   * Register a claim on a workspace, or report the claims that refuse it.
   *
   * Idempotent per §7.3: the same task re-claiming the same scope returns the
   * EXISTING claim (`created: false`) rather than a duplicate or a self-conflict.
   */
  claimResource(request: ClaimRequest): ClaimOutcome {
    return this.claims.claim(request);
  }

  /**
   * The admission question, asked WITHOUT registering: "would this be refused?"
   *
   * This is what the dispatch path uses, so a task that is refused leaves no trace.
   */
  resourceConflicts(request: ClaimRequest): readonly ResourceClaim[] {
    return this.claims.wouldConflict(request);
  }

  /** Drop every claim a task holds. Called when the task reaches a terminal state. */
  releaseResourceClaims(taskId: string): number {
    return this.claims.releaseClaims(taskId);
  }

  /**
   * R2-1.1 (P2-1): release ONE scope of a task and keep its other scopes.
   *
   * Dropping "all of a task's claims" to free one scope would silently give up the
   * conflict protection the caller still believes it holds.
   */
  releaseResourceClaimForScope(taskId: string, mode: ResourceClaimMode, scope: ResourceScope): number {
    return this.claims.releaseClaimForScope(taskId, mode, scope);
  }

  /** Read-only view of the claims held in one workspace. */
  resourceClaimsFor(workspaceId: string): readonly ResourceClaim[] {
    return this.claims.forWorkspace(workspaceId);
  }

  /**
   * R2-2 §7.3: void every claim the predicate rejects, then report what is left held.
   *
   * The lease decision is made by the CALLER (it owns TaskStore, the only lease
   * authority); this method only applies it. That ordering is the whole design: the
   * workspace authority keeps arbitrating claims exactly as before, and simply stops
   * counting the ones whose lease has died.
   *
   * Returns the surviving claims so the caller can consult them in the same step, which
   * removes the window in which a stale claim could be observed between the void and the
   * conflict check.
   */
  voidStaleResourceClaims(isVoid: (claim: ResourceClaim) => boolean): readonly ResourceClaim[] {
    this.claims.voidClaimsWhere(isVoid);
    return this.claims.all();
  }

  get resourceClaimCount(): number {
    return this.claims.size;
  }

  /**
   * §8's rule, expressed as a decision this manager can answer:
   * MAY a task with this access mode share one workspace with a running sibling?
   *
   * A write or exclusive-write must not share a mutable workspace with work running
   * beside it, because two agents editing one checkout is the exact failure this
   * layer exists to prevent. Read-only may share, which is why a review task can
   * still point at the main tree.
   */
  static mayShareWorkspace(mode: ResourceClaimMode, parallel: boolean): boolean {
    return !(parallel && modeRequiresIsolation(mode));
  }

  /**
   * 5C-9: the git execution context this manager uses, so that inspect and merge
   * go through the SAME runner as workspace creation instead of growing a second
   * git path. Read-only accessors; no new authority.
   */
  gitContext(): GitContext {
    return { gitPath: this.gitPath, timeoutMs: this.timeoutMs, env: this.env };
  }

  /** All live (unreleased) workspaces. */
  list(): WorkspaceHandle[] {
    return [...this.handles.values()].filter((h) => !h.released);
  }

  get(taskId: string): WorkspaceHandle | null {
    const h = this.handles.get(this.key(taskId));
    return h !== undefined && !h.released ? h : null;
  }

  private key(taskId: string): string {
    return `task:${taskId}`;
  }

  private async git(args: readonly string[], cwd: string): Promise<GitResult> {
    if (!existsSync(this.gitPath) && this.gitAvailable !== false) {
      // Try a bare `git` once; launcherFor will produce a precise error if the
      // platform cannot resolve it.
      this.gitAvailable = true;
    }
    return runGit({ gitPath: this.gitPath, args, cwd, timeoutMs: this.timeoutMs, env: this.env });
  }

  /** Is `dir` inside a git repository? Returns the repo root, or null. */
  async repoRootFor(dir: string): Promise<string | null> {
    if (!existsSync(dir)) return null;
    const r = await this.git(['rev-parse', '--show-toplevel'], dir);
    if (r.code !== 0 || r.stdout.trim() === '') return null;
    return resolvePath(r.stdout.trim());
  }

  /**
   * Resolve (creating if needed) the workspace for a task.
   *
   * IDEMPOTENT per task: a second call returns the SAME handle with the SAME cwd
   * and the same branch. Re-execution therefore cannot create a second worktree
   * or a second branch, which is what makes a workspace inspectable after a
   * failure and safe to reuse if retry is ever implemented.
   */
  async prepare(input: { taskId: string; mode: WorkspaceMode; sharedCwd?: string }): Promise<WorkspaceHandle> {
    const existing = this.get(input.taskId);
    if (existing !== null) return existing;

    const handle = input.mode === 'shared'
      ? await this.prepareShared(input.taskId, input.sharedCwd)
      : await this.prepareIsolated(input.taskId);

    this.handles.set(this.key(input.taskId), handle);
    return handle;
  }

  private async prepareShared(taskId: string, sharedCwd: string | undefined): Promise<WorkspaceHandle> {
    const dir = resolvePath(sharedCwd ?? this.projectRoot);
    if (!existsSync(dir)) {
      throw new WorkspaceError(
        'workspace-path-missing',
        `shared workspace "${dir}" does not exist; a shared workspace is named explicitly and never invented`,
      );
    }
    return {
      workspaceId: this.key(taskId),
      mode: 'shared',
      taskId,
      cwd: dir,
      branch: null,
      baseSha: null,
      repoRoot: await this.repoRootFor(dir),
      createdAt: this.now(),
      released: false,
    };
  }

  private async prepareIsolated(taskId: string): Promise<WorkspaceHandle> {
    if (!existsSync(this.projectRoot)) {
      throw new WorkspaceError('workspace-project-root-missing', `project root "${this.projectRoot}" does not exist`);
    }

    // ---- 5C-8: the lock spans IDENTITY RESOLUTION -> CREATION ----------
    // Deliberately acquired BEFORE resolving the repo root, branch name and
    // target path. Wrapping only `git worktree add` would leave the classic
    // "A checks, B checks, A locks too late" race open, because the decision to
    // create is made by those checks, not by the git call.
    const lockKey = workspaceLockKey(this.projectRoot, taskId);
    const lease: WorkspaceLockLease | null = this.lock === null ? null : await this.lock.acquire(lockKey, `workspace:${taskId}`);
    try {
      return await this.prepareIsolatedLocked(taskId);
    } finally {
      // Released on EVERY exit path: success, refusal, and git failure alike.
      if (lease !== null) this.lock?.tryRelease(lease);
    }
  }

  /** Everything below runs while the 5C-8 creation lock is held. */
  private async prepareIsolatedLocked(taskId: string): Promise<WorkspaceHandle> {
    const repoRoot = await this.repoRootFor(this.projectRoot);
    if (repoRoot === null) {
      // Refused, NOT downgraded: a non-git project cannot be isolated, and
      // pretending otherwise would hand the agent a shared checkout.
      throw new WorkspaceError(
        'workspace-not-a-git-repository',
        `"${this.projectRoot}" is not a git repository, so an isolated worktree cannot be created`,
      );
    }

    const branch = branchForTask(taskId);
    const target = join(this.worktreeRoot, `${repoRoot.split(/[\\/]/).pop() ?? 'repo'}-${taskId.replace(/[^A-Za-z0-9._-]+/g, '-')}`);

    // ---- 5C-8: reuse a worktree ANOTHER PROCESS already created ----------
    // Holding the lock makes this check authoritative: nobody else can be
    // mid-creation. Without this, the loser of a cross-process race would report
    // `workspace-worktree-exists` for a worktree that is in fact its own.
    const existing = await this.findWorktreeAt(repoRoot, target);
    if (existing !== null) {
      if (existing.branch !== `refs/heads/${branch}`) {
        throw new WorkspaceError(
          'workspace-worktree-exists',
          `worktree path "${target}" already exists and is checked out on "${existing.branch}", not "${branch}"`,
        );
      }
      // Same task, same branch, same identity: adopt it rather than duplicating.
      const baseSha = await this.headSha(repoRoot);
      const handle: WorkspaceHandle = {
        workspaceId: `task:${taskId}`,
        mode: 'isolated',
        taskId,
        cwd: target,
        branch,
        baseSha,
        repoRoot,
        createdAt: this.now(),
        released: false,
      };
      this.handles.set(this.key(taskId), handle);
      return handle;
    }

    const baseSha = await this.headSha(repoRoot);

    const add = await this.git(['worktree', 'add', '-b', branch, target], repoRoot);
    if (add.code !== 0 || stderrIsFatal(add)) {
      const text = `${add.stderr}${add.stdout}`.trim();
      // Pre-flight the two cases we can name precisely, so the caller learns
      // WHY rather than reading a git blob.
      if (/already exists/i.test(text) && new RegExp(escapeRe(branch)).test(text)) {
        throw new WorkspaceError(
          'workspace-branch-exists',
          `branch "${branch}" already exists; a workspace for task "${taskId}" was released and cannot be recreated with the same branch`,
        );
      }
      if (/already exists/i.test(text)) {
        throw new WorkspaceError('workspace-worktree-exists', `worktree path "${target}" already exists`);
      }
      throw new WorkspaceError('workspace-worktree-add-failed', `git worktree add failed: ${text.slice(0, 400)}`);
    }

    // Verify rather than trust: the cwd handed to the agent must really exist.
    if (!existsSync(target)) {
      throw new WorkspaceError(
        'workspace-worktree-add-failed',
        `git reported success but "${target}" does not exist; refusing to hand a non-existent cwd to an agent`,
      );
    }

    return {
      workspaceId: this.key(taskId),
      mode: 'isolated',
      taskId,
      cwd: target,
      branch,
      baseSha,
      repoRoot,
      createdAt: this.now(),
      released: false,
    };
  }

  private async headSha(repoRoot: string): Promise<string | null> {
    const r = await this.git(['rev-parse', 'HEAD'], repoRoot);
    return r.code === 0 ? r.stdout.trim() || null : null;
  }

  /**
   * Is there already a worktree registered at `target`, and on which branch?
   *
   * Read from `git worktree list --porcelain`, i.e. from GIT's own record rather
   * than from our in-memory map, because the worktree that matters may have been
   * created by a different process.
   */
  private async findWorktreeAt(repoRoot: string, target: string): Promise<{ branch: string | null } | null> {
    const r = await this.git(['worktree', 'list', '--porcelain'], repoRoot);
    if (r.code !== 0 || r.stdout.trim() === '') return null;
    const wanted = normalizeIdentityPath(target);
    let branch: string | null = null;
    let current: string | null = null;
    let matched = false;
    for (const line of r.stdout.split('\n')) {
      const t = line.trim();
      if (t.startsWith('worktree ')) {
        // A new record begins: commit what we had.
        if (matched) return { branch };
        matched = normalizeIdentityPath(t.slice('worktree '.length)) === wanted;
        branch = null;
        current = null;
      } else if (matched && t.startsWith('branch ')) {
        branch = t.slice('branch '.length).trim();
      } else if (matched && t === 'detached') {
        branch = null;
      }
      void current;
    }
    if (matched) return { branch };
    return null;
  }

  /**
   * 5C-8: branches that reclamation must NEVER delete.
   *
   * Detection, not configuration, because a configured list is exactly the kind
   * of thing that is forgotten:
   *   - `main` / `master` always;
   *   - the repository's default branch (`origin/HEAD`, else `init.defaultBranch`);
   *   - the branch the MAIN worktree has checked out (the repository's current
   *     branch);
   *   - any caller-supplied extras.
   *
   * NOTE: a branch checked out by some *other* worktree is deliberately NOT in
   * this set. That is a different rule with a different remedy (release the
   * worktree first), and folding it in here would report "protected" for an
   * ordinary task branch and hide the actionable cause.
   */
  async protectedBranches(repoRoot: string): Promise<string[]> {
    const out = new Set<string>(['main', 'master', ...this.extraProtectedBranches]);

    if (this.defaultBranchCache.has(repoRoot)) {
      // `.get` on a `Map<string, string | null>` can also be `undefined`, which a
      // `!== null` test would let through into `Set.add`.
      const cached = this.defaultBranchCache.get(repoRoot);
      if (cached !== undefined && cached !== null) out.add(cached);
    } else {
      let detected: string | null = null;
      const sym = await this.git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], repoRoot);
      if (sym.code === 0) {
        const ref = sym.stdout.trim();
        const m = /^refs\/remotes\/[^/]+\/(.+)$/.exec(ref);
        if (m) detected = m[1];
      }
      if (detected === null) {
        const cfg = await this.git(['config', '--get', 'init.defaultBranch'], repoRoot);
        if (cfg.code === 0 && cfg.stdout.trim() !== '') detected = cfg.stdout.trim();
      }
      this.defaultBranchCache.set(repoRoot, detected);
      if (detected !== null) out.add(detected);
    }

    // The branch the repository itself has checked out (first worktree record).
    const listed = await this.git(['worktree', 'list', '--porcelain'], repoRoot);
    if (listed.code === 0) {
      for (const line of listed.stdout.split('\n')) {
        const t = line.trim();
        if (t.startsWith('branch refs/heads/')) { out.add(t.slice('branch refs/heads/'.length)); break; }
      }
    }
    return [...out];
  }

  /** Is `branch` currently checked out by ANY worktree of this repository? */
  private async isCheckedOutAnywhere(repoRoot: string, branch: string): Promise<boolean> {
    const listed = await this.git(['worktree', 'list', '--porcelain'], repoRoot);
    if (listed.code !== 0) return false;
    for (const line of listed.stdout.split('\n')) {
      const t = line.trim();
      if (t === `branch refs/heads/${branch}`) return true;
    }
    return false;
  }

  /**
   * 5C-8: delete the BRANCH belonging to a task.
   *
   * Deliberately a SEPARATE operation from `release()`. Removing a worktree is
   * reversible-ish (the branch still exists); deleting a branch destroys commits
   * that may never have been merged. Mixing them into one irreversible call is
   * how work gets lost, so the caller must ask for each explicitly.
   *
   * Refuses unless ALL of the following hold:
   *   - the workspace is `isolated` and currently RELEASED (no live worktree);
   *   - the branch is exactly the one this task owns;
   *   - the branch is not protected (default / main / master / checked out);
   *   - the caller asked for it.
   */
  async releaseBranch(taskId: string, options: { force?: boolean } = {}): Promise<{ removed: boolean; code: WorkspaceErrorCode | null; reason: string }> {
    const handle = this.handles.get(this.key(taskId));
    if (handle === undefined) {
      return { removed: false, code: null, reason: `no known workspace for task "${taskId}"` };
    }
    if (handle.mode !== 'isolated' || handle.branch === null) {
      return { removed: false, code: null, reason: `task "${taskId}" has no branch to reclaim` };
    }
    const repoRoot = handle.repoRoot;
    if (repoRoot === null) {
      return { removed: false, code: 'workspace-unknown', reason: 'workspace has no repo root recorded' };
    }

    // Ownership: only ever the branch this task would have created.
    const expected = branchForTask(taskId);
    if (handle.branch !== expected) {
      return {
        removed: false,
        code: 'workspace-branch-not-owned',
        reason: `refusing to delete "${handle.branch}": task "${taskId}" owns only "${expected}"`,
      };
    }

    // Guard order follows the 5C-8 spec exactly, most-actionable first:
    //   ownership -> not checked out anywhere -> not protected -> released.
    // Reporting "protected" for an ordinary live task branch would hide the
    // real remedy, which is simply "release the worktree first".
    if (await this.isCheckedOutAnywhere(repoRoot, handle.branch)) {
      return {
        removed: false,
        code: 'workspace-branch-checked-out',
        reason: `branch "${handle.branch}" is still checked out by a worktree; release the workspace before reclaiming it`,
      };
    }

    if (!handle.released) {
      return {
        removed: false,
        code: 'workspace-branch-checked-out',
        reason: `worktree for "${handle.branch}" is still registered in this manager; release the workspace before reclaiming its branch`,
      };
    }

    const protectedList = await this.protectedBranches(repoRoot);
    if (protectedList.includes(handle.branch)) {
      // Even force cannot override this: a protected branch is never deletable.
      return {
        removed: false,
        code: 'workspace-branch-protected',
        reason: `refusing to delete protected branch "${handle.branch}" (protected: ${protectedList.join(', ')}); force does not override protection`,
      };
    }

    // A worktree git knows about but we do not is still a hard blocker.
    const wt = await this.findWorktreeAt(repoRoot, handle.cwd);
    if (wt !== null) {
      return {
        removed: false,
        code: 'workspace-branch-checked-out',
        reason: `git still has a worktree at "${handle.cwd}" on this branch`,
      };
    }

    const del = await this.git(['branch', '-D', handle.branch], repoRoot);
    if (del.code !== 0 || stderrIsFatal(del)) {
      return {
        removed: false,
        code: 'workspace-branch-checked-out',
        reason: `git branch -D refused: ${`${del.stderr}${del.stdout}`.trim().slice(0, 300)}`,
      };
    }
    void options.force; // force is accepted for symmetry; protection is absolute.
    return { removed: true, code: null, reason: `deleted branch ${handle.branch}` };
  }

  /**
   * Explicitly release a workspace. NEVER automatic.
   *
   * `to_verify`, `failed` and `cancelled` all RETAIN by design: a workspace is the
   * evidence of what an agent did, and deleting it on cancel would destroy the
   * scene an operator needs. This is opt-in, and it is the only path that runs
   * `git worktree remove`.
   */
  async release(taskId: string, options: { force?: boolean } = {}): Promise<{ removed: boolean; code: WorkspaceErrorCode | null; reason: string }> {
    const handle = this.get(taskId);
    if (handle === null) {
      return { removed: false, code: null, reason: `no live workspace for task "${taskId}"` };
    }
    if (handle.mode === 'shared') {
      // A shared workspace belongs to the caller; we must not delete a directory
      // we did not create.
      this.handles.set(this.key(taskId), { ...handle, released: true });
      return { removed: false, code: null, reason: 'shared workspace was not created here and is left untouched' };
    }
    const repoRoot = handle.repoRoot;
    if (repoRoot === null) {
      return { removed: false, code: 'workspace-unknown', reason: 'workspace has no repo root recorded' };
    }
    const args = ['worktree', 'remove'];
    if (options.force === true) args.push('--force');
    args.push(handle.cwd);
    const r = await this.git(args, repoRoot);
    if (r.code !== 0 || stderrIsFatal(r)) {
      // A worktree in use (dirty tree) fails without --force. That is the guard
      // working: we do not delete a directory an agent may still be writing to.
      return {
        removed: false,
        code: 'workspace-worktree-add-failed',
        reason: `git worktree remove refused: ${`${r.stderr}${r.stdout}`.trim().slice(0, 300)}`,
      };
    }
    this.handles.set(this.key(taskId), { ...handle, released: true });
    return { removed: true, code: null, reason: `removed ${handle.cwd}` };
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}