/**
 * src/orchestration/task-result.ts — inspect and explicitly merge a child's work.
 *
 * This is the piece that turns "parallel agents ran" into "my repo got the
 * changes". It is deliberately the SMALLEST thing that closes that loop:
 *
 *   Task → Agent → isolated worktree → execution → verification → inspect → merge
 *
 * Two deliberate constraints:
 *
 *  1. MERGE IS ALWAYS EXPLICIT. A task reaching `succeeded` never merges itself.
 *     The whole point of a personal tool is that the human decides when someone
 *     else's work lands in their checkout.
 *
 *  2. NO AUTO-COMMIT, EVER. If the agent left uncommitted changes, merge is
 *     REFUSED. We do not `git add`, we do not `git commit`, and we do not invent
 *     a commit message on the agent's behalf. An agent that does not commit has
 *     not finished, and the honest answer is "not ready", not "let me help".
 *
 *  3. NOTHING DESTRUCTIVE ON FAILURE. A conflicted merge is left exactly as git
 *     left it: no reset, no `--ours`, no `--theirs`, no branch or worktree
 *     deletion. The scene is the evidence.
 */

import { existsSync } from 'node:fs';
import { branchForTask, type WorkspaceHandle } from './workspace.ts';
import { runGit, stderrIsFatal, type GitResult } from './git.ts';
import { WorkspaceError, type WorkspaceErrorCode } from './errors.ts';

/** One changed path, straight from `git status --porcelain`. */
export interface ChangedFile {
  /** Porcelain status code, e.g. `M`, `A`, `??`. */
  readonly status: string;
  /** Path relative to the worktree root. */
  readonly path: string;
}

/** `git diff --shortstat` for the branch's work, parsed into numbers. */
export interface DiffStat {
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
}

/**
 * Everything a human needs to decide whether to merge. Plain data — no handles,
 * no lazy git calls — so it can be printed or serialised as-is.
 */
export interface TaskResultSummary {
  readonly taskId: string;
  readonly status: string;
  readonly agentId: string;
  readonly modelId: string | null;
  /** `isolated` | `shared`, or `null` when no workspace exists. */
  readonly workspaceMode: 'isolated' | 'shared' | null;
  readonly workspacePath: string | null;
  readonly branch: string | null;
  /** True when the worktree has uncommitted changes (merge would be refused). */
  readonly dirty: boolean;
  readonly changedFiles: readonly ChangedFile[];
  /** Diff of the branch against its recorded base, i.e. what merging would bring. */
  readonly diffStat: DiffStat;
  /** True when the branch already has commits that root does not contain. */
  readonly hasCommits: boolean;
  /** Non-null once this branch has been merged into root (5C-9 metadata). */
  readonly mergedAt: number | null;
  readonly mergedCommit: string | null;
  /** True when the branch is already an ancestor of root HEAD. */
  readonly alreadyMerged: boolean;
  /** True when every precondition for merge is currently satisfied. */
  readonly mergeReady: boolean;
  /** Why merge is not ready, in plain language. Empty when it is. */
  readonly mergeBlockedBecause: string;
}

export interface MergeOutcome {
  readonly ok: boolean;
  /** `null` on success, else a typed code. */
  readonly code: WorkspaceErrorCode | null;
  readonly reason: string;
  /** Commit created by the merge, when one was. */
  readonly mergeCommit: string | null;
  /** Files git reported as conflicted. Non-empty means a conflict was LEFT IN PLACE. */
  readonly conflicts: readonly string[];
}

export interface GitContext {
  gitPath: string;
  timeoutMs: number;
  env: Readonly<Record<string, string | undefined>>;
}

const EMPTY_STAT: DiffStat = { files: 0, insertions: 0, deletions: 0 };

function parseShortstat(text: string): DiffStat {
  // " 3 files changed, 128 insertions(+), 31 deletions(-)"
  const files = /(\d+)\s+files?\s+changed/.exec(text);
  const ins = /(\d+)\s+insertions?\(\+\)/.exec(text);
  const del = /(\d+)\s+deletions?\(-\)/.exec(text);
  return {
    files: files ? Number(files[1]) : 0,
    insertions: ins ? Number(ins[1]) : 0,
    deletions: del ? Number(del[1]) : 0,
  };
}

function parsePorcelain(text: string): ChangedFile[] {
  const out: ChangedFile[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    // Porcelain v1: two status columns, a space, then the path.
    const m = /^([ MADRCU?!]{1,2})\s(.+)$/.exec(line.trimEnd());
    if (m) out.push({ status: m[1].trim(), path: m[2].replace(/^"|"$/g, '') });
  }
  return out;
}

/** `git status --porcelain` in `cwd`; `null` when git could not be run there. */
async function statusOf(ctx: GitContext, cwd: string): Promise<GitResult | null> {
  if (!existsSync(cwd)) return null;
  const r = await runGit({ gitPath: ctx.gitPath, args: ['status', '--porcelain'], cwd, timeoutMs: ctx.timeoutMs, env: ctx.env });
  return r.code === 0 ? r : null;
}

/**
 * Count commits the branch has that its recorded base does not.
 *
 * This is the "did the agent actually commit anything?" question, asked of git
 * rather than of the task record, so it stays true across processes.
 */
async function commitsSince(ctx: GitContext, repoRoot: string, base: string | null, branch: string): Promise<number> {
  const range = base !== null && /^[0-9a-f]{7,40}$/i.test(base) ? `${base}..${branch}` : branch;
  const r = await runGit({ gitPath: ctx.gitPath, args: ['rev-list', '--count', range], cwd: repoRoot, timeoutMs: ctx.timeoutMs, env: ctx.env });
  if (r.code !== 0) return 0;
  const n = Number(r.stdout.trim());
  return Number.isFinite(n) ? n : 0;
}

/** Is `branch` already contained in root's HEAD? Durable, needs no bookkeeping. */
async function isAncestorOfHead(ctx: GitContext, repoRoot: string, branch: string): Promise<boolean> {
  const r = await runGit({ gitPath: ctx.gitPath, args: ['merge-base', '--is-ancestor', branch, 'HEAD'], cwd: repoRoot, timeoutMs: ctx.timeoutMs, env: ctx.env });
  // exit 0 = ancestor; exit 1 = not; anything else we treat as "not merged"
  // rather than guessing.
  return r.code === 0;
}

/** Build the read-only view of one child's work. Never mutates anything. */
export async function summarizeTask(input: {
  ctx: GitContext;
  taskId: string;
  status: string;
  agentId: string;
  modelId?: string | null;
  handle: WorkspaceHandle | null;
  rootRepo: string | null;
  merged?: { at: number; commit: string } | null;
}): Promise<TaskResultSummary> {
  const { ctx, handle } = input;
  const base = {
    taskId: input.taskId,
    status: input.status,
    agentId: input.agentId,
    modelId: input.modelId ?? null,
    workspaceMode: handle?.mode ?? null,
    workspacePath: handle?.cwd ?? null,
    branch: handle?.branch ?? null,
    mergedAt: input.merged?.at ?? null,
    mergedCommit: input.merged?.commit ?? null,
  } as const;

  if (handle === null || handle.mode !== 'isolated' || handle.repoRoot === null || handle.branch === null) {
    return {
      ...base,
      dirty: false,
      changedFiles: [],
      diffStat: EMPTY_STAT,
      hasCommits: false,
      alreadyMerged: false,
      mergeReady: false,
      mergeBlockedBecause: 'no isolated workspace exists for this task',
    };
  }

  const repoRoot = handle.repoRoot;
  const st = await statusOf(ctx, handle.cwd);
  const changed = st === null ? [] : parsePorcelain(st.stdout);
  const dirty = changed.length > 0;

  let diffStat = EMPTY_STAT;
  const range = handle.baseSha !== null ? `${handle.baseSha}..${handle.branch}` : handle.branch;
  const ds = await runGit({ gitPath: ctx.gitPath, args: ['diff', '--shortstat', range], cwd: repoRoot, timeoutMs: ctx.timeoutMs, env: ctx.env });
  if (ds.code === 0) diffStat = parseShortstat(ds.stdout);

  const commitCount = await commitsSince(ctx, repoRoot, handle.baseSha, handle.branch);
  const hasCommits = commitCount > 0;
  const alreadyMerged = input.rootRepo !== null
    ? await isAncestorOfHead(ctx, input.rootRepo, handle.branch)
    : false;

  const blockers: string[] = [];
  if (input.status !== 'succeeded') blockers.push(`task is ${input.status}, not succeeded (verify it first)`);
  if (dirty) blockers.push('worktree has uncommitted changes');
  if (!hasCommits) blockers.push('branch has no commits beyond its base');
  if (alreadyMerged) blockers.push('branch is already merged into root');

  return {
    ...base,
    dirty,
    changedFiles: changed,
    diffStat,
    hasCommits,
    alreadyMerged,
    mergeReady: blockers.length === 0,
    mergeBlockedBecause: blockers.join('; '),
  };
}

/**
 * Merge one child's branch into the root branch. Explicit, precondition-checked,
 * and non-destructive on every failure path.
 *
 * Preconditions, all checked before a single mutating git command runs:
 *   1. the task exists and has an isolated workspace   -> merge-no-workspace
 *   2. the task is `succeeded`                          -> merge-task-not-verified
 *   3. the branch is the one this task owns             -> merge-branch-not-owned
 *   4. the worktree is still registered with git        -> merge-worktree-missing
 *   5. the worktree is clean                            -> merge-child-dirty
 *   6. the branch has commits to bring                  -> merge-nothing-to-merge
 *   7. it is not already merged                         -> merge-already-merged
 *   8. the root checkout is clean                       -> merge-root-dirty
 */
export async function mergeTaskBranch(input: {
  ctx: GitContext;
  taskId: string;
  taskStatus: string;
  handle: WorkspaceHandle | null;
  rootRepo: string;
}): Promise<MergeOutcome> {
  const { ctx, handle, taskId } = input;
  const deny = (code: WorkspaceErrorCode, reason: string): MergeOutcome =>
    ({ ok: false, code, reason, mergeCommit: null, conflicts: [] });

  if (handle === null) {
    return deny('merge-no-workspace', `task "${taskId}" has no workspace to merge`);
  }
  if (handle.mode !== 'isolated' || handle.repoRoot === null || handle.branch === null) {
    return deny('merge-workspace-not-isolated', `task "${taskId}" has no isolated workspace branch to merge`);
  }
  // 2. Verification gate. to_verify / failed / cancelled all stop here.
  if (input.taskStatus !== 'succeeded') {
    return deny(
      'merge-task-not-verified',
      `task "${taskId}" is ${input.taskStatus}; merge requires an explicit verification pass (to_verify -> succeeded)`,
    );
  }
  // 3. Ownership: never merge another task's branch.
  let expected: string;
  try {
    expected = branchForTask(taskId);
  } catch {
    return deny('merge-branch-not-owned', `task id "${taskId}" has no branch-safe form`);
  }
  if (handle.branch !== expected) {
    return deny('merge-branch-not-owned', `refusing to merge "${handle.branch}": task "${taskId}" owns only "${expected}"`);
  }
  if (!existsSync(handle.cwd)) {
    return deny('merge-worktree-missing', `worktree "${handle.cwd}" no longer exists on disk`);
  }

  // 4. Child worktree must be clean: the agent's uncommitted work is not ours to
  //    invent a commit for.
  const childStatus = await statusOf(ctx, handle.cwd);
  if (childStatus === null) {
    return deny('merge-worktree-missing', `cannot read git status in worktree "${handle.cwd}"`);
  }
  const dirty = parsePorcelain(childStatus.stdout);
  if (dirty.length > 0) {
    return deny(
      'merge-child-dirty',
      `worktree for "${taskId}" has ${dirty.length} uncommitted change(s); commit them in the worktree first ` +
        `(no auto-commit is performed): ${dirty.slice(0, 5).map((f) => f.path).join(', ')}`,
    );
  }

  // 5. Already merged is answered from git itself, so it survives process restarts.
  //    Checked BEFORE "nothing to merge" because after a successful merge the branch
  //    has no commits ahead of the reconstructed base, and "already merged" is the far
  //    more useful thing to say.
  //
  //    The two conditions genuinely overlap: a branch that never diverged is
  //    trivially an ancestor of HEAD. When the worktree's ORIGINAL base is known we
  //    can tell them apart (real work landed vs the branch never moved); when it is
  //    not (a branch reconstructed from git by the CLI) we say what is true without
  //    pretending to know which case it is.
  const aheadOfRecordedBase = await commitsSince(ctx, handle.repoRoot, handle.baseSha, handle.branch);
  if (await isAncestorOfHead(ctx, input.rootRepo, handle.branch)) {
    if (handle.baseSha !== null && aheadOfRecordedBase > 0) {
      return deny('merge-already-merged', `branch "${handle.branch}" was already merged into ${input.rootRepo}'s HEAD`);
    }
    return deny(
      'merge-already-merged',
      `branch "${handle.branch}" is already contained in ${input.rootRepo}'s HEAD and has no commits that HEAD lacks`,
    );
  }

  if (aheadOfRecordedBase === 0) {
    return deny('merge-nothing-to-merge', `branch "${handle.branch}" has no commits beyond its base`);
  }

  // 6. Root must be clean. We never stash and never reset a user's checkout.
  const rootStatus = await statusOf(ctx, input.rootRepo);
  if (rootStatus === null) {
    return deny('merge-root-dirty', `"${input.rootRepo}" is not a readable git checkout`);
  }
  const rootDirty = parsePorcelain(rootStatus.stdout);
  if (rootDirty.length > 0) {
    return deny(
      'merge-root-dirty',
      `root checkout has ${rootDirty.length} uncommitted change(s); commit or stash them yourself ` +
        `(nothing is stashed or reset for you): ${rootDirty.slice(0, 5).map((f) => f.path).join(', ')}`,
    );
  }

  // 7. The only mutating command in this module.
  const merge = await runGit({
    gitPath: ctx.gitPath,
    args: ['merge', '--no-edit', handle.branch],
    cwd: input.rootRepo,
    timeoutMs: ctx.timeoutMs,
    env: ctx.env,
  });

  // A conflicted merge is reported from git's own unmerged-file list rather than
  // from exit-code guessing. NOTE: `--name-only` emits bare paths, NOT the
  // `XY path` porcelain form, so it must not go through `parsePorcelain`.
  const unmerged = await runGit({
    gitPath: ctx.gitPath, args: ['diff', '--name-only', '--diff-filter=U'],
    cwd: input.rootRepo, timeoutMs: ctx.timeoutMs, env: ctx.env,
  });
  const conflicted = unmerged.stdout.split('\n').map((s) => s.trim()).filter((s) => s !== '');

  if (conflicted.length > 0) {
    // LEFT IN PLACE ON PURPOSE. No reset, no --ours/--theirs, no branch or
    // worktree deletion: the conflicted state IS the evidence the human needs.
    return {
      ok: false,
      code: 'merge-conflict',
      reason:
        `merge of "${handle.branch}" conflicted in ${conflicted.length} file(s): ${conflicted.join(', ')}. ` +
        `The conflict is left in ${input.rootRepo} for you to resolve; nothing was reset and neither the ` +
        `worktree nor the branch was deleted.`,
      mergeCommit: null,
      conflicts: conflicted,
    };
  }

  if (merge.code !== 0 || stderrIsFatal(merge)) {
    return deny('merge-failed', `git merge failed: ${`${merge.stderr}${merge.stdout}`.trim().slice(0, 400)}`);
  }

  const head = await runGit({ gitPath: ctx.gitPath, args: ['rev-parse', 'HEAD'], cwd: input.rootRepo, timeoutMs: ctx.timeoutMs, env: ctx.env });
  return {
    ok: true,
    code: null,
    reason: `merged ${handle.branch} into ${input.rootRepo}`,
    mergeCommit: head.code === 0 ? head.stdout.trim() : null,
    conflicts: [],
  };
}

export { WorkspaceError };

/**
 * Rebuild a workspace view for `taskId` purely from git.
 *
 * The orchestration TaskStore is in-memory by design (5C-1), so a *separate*
 * process cannot read task status. What it CAN read is the durable part: the
 * branch and the registered worktree. That is enough to show a human what a child
 * did, and it is the honest boundary — this function invents no task status.
 */
export async function discoverWorkspaceByTask(input: {
  ctx: GitContext;
  projectRoot: string;
  taskId: string;
  /** Injected so discovery is testable without the clock. */
  now?: () => number;
}): Promise<WorkspaceHandle | null> {
  const { ctx, projectRoot, taskId } = input;
  let branch: string;
  try {
    branch = branchForTask(taskId);
  } catch {
    return null; // an id with no branch-safe form simply has no workspace
  }

  const repoRoot = (await runGit({
    gitPath: ctx.gitPath, args: ['rev-parse', '--show-toplevel'],
    cwd: projectRoot, timeoutMs: ctx.timeoutMs, env: ctx.env,
  }));
  if (repoRoot.code !== 0) return null;
  const root = repoRoot.stdout.trim();

  // Does the branch exist at all?
  const branchExists = await runGit({
    gitPath: ctx.gitPath, args: ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
    cwd: root, timeoutMs: ctx.timeoutMs, env: ctx.env,
  });
  if (branchExists.code !== 0) return null;

  // Which worktree (if any) has it checked out?
  let cwd: string | null = null;
  const listed = await runGit({
    gitPath: ctx.gitPath, args: ['worktree', 'list', '--porcelain'],
    cwd: root, timeoutMs: ctx.timeoutMs, env: ctx.env,
  });
  let candidate: string | null = null;
  for (const line of listed.stdout.split('\n')) {
    const t = line.trim();
    if (t.startsWith('worktree ')) candidate = t.slice('worktree '.length);
    else if (t === `branch refs/heads/${branch}`) { cwd = candidate; break; }
  }

  // Without a worktree there is still a branch to inspect/merge; report the
  // repo root as the location so the caller can show something truthful.
  const head = await runGit({ gitPath: ctx.gitPath, args: ['rev-parse', `refs/heads/${branch}`], cwd: root, timeoutMs: ctx.timeoutMs, env: ctx.env });
  const mergeBase = await runGit({ gitPath: ctx.gitPath, args: ['merge-base', 'HEAD', branch], cwd: root, timeoutMs: ctx.timeoutMs, env: ctx.env });

  return {
    workspaceId: `task:${taskId}`,
    mode: 'isolated',
    taskId,
    cwd: cwd ?? root,
    branch,
    baseSha: mergeBase.code === 0 ? mergeBase.stdout.trim() : null,
    repoRoot: root,
    createdAt: (input.now ?? Date.now)(),
    released: cwd === null,
    // `head` is read for completeness; the commit count is derived in summarize.
    ...(head.code === 0 ? {} : {}),
  };
}

/** Every `orch/task/*` branch in the repo, i.e. every child this tool owns. */
export async function listTaskBranches(input: {
  ctx: GitContext;
  projectRoot: string;
}): Promise<Array<{ branch: string; taskId: string; sha: string }>> {
  const { ctx, projectRoot } = input;
  const root = await runGit({ gitPath: ctx.gitPath, args: ['rev-parse', '--show-toplevel'], cwd: projectRoot, timeoutMs: ctx.timeoutMs, env: ctx.env });
  if (root.code !== 0) return [];
  const repoRoot = root.stdout.trim();
  const r = await runGit({
    gitPath: ctx.gitPath, args: ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/orch/task/'],
    cwd: repoRoot, timeoutMs: ctx.timeoutMs, env: ctx.env,
  });
  if (r.code !== 0) return [];
  const out: Array<{ branch: string; taskId: string; sha: string }> = [];
  for (const line of r.stdout.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    const sp = t.indexOf(' ');
    const branch = sp < 0 ? t : t.slice(0, sp);
    const sha = sp < 0 ? '' : t.slice(sp + 1).trim();
    out.push({ branch, taskId: branch.slice('orch/task/'.length), sha });
  }
  return out;
}