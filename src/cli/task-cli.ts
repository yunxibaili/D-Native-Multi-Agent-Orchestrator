/**
 * src/cli/task-cli.ts — the minimal command surface that makes the loop usable.
 *
 *   orchestrator task list
 *   orchestrator task inspect <taskId> [--json]
 *   orchestrator task diff    <taskId> [--json]
 *   orchestrator task merge   <taskId> [--verified] [--json]
 *
 * AN HONEST LIMITATION, STATED UP FRONT
 * --------------------------------------
 * The orchestration TaskStore is IN MEMORY (5C-1, deliberately). A separate CLI
 * process therefore cannot read a task's status, agent, or verification verdict.
 * What survives across processes is the DURABLE part: the git branch, the
 * registered worktree, and its commits.
 *
 * So this CLI reconstructs from git and says so, rather than pretending to know
 * a task's state. Because of that, `task merge` requires `--verified`: the
 * in-process API enforces "to_verify -> succeeded" automatically, and this flag
 * is how a human states that verification out here. It is never implied.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceManager, resolveGitPath } from '../orchestration/index.ts';
import {
  discoverWorkspaceByTask,
  listTaskBranches,
  mergeTaskBranch,
  runGit,
  summarizeTask,
  type MergeOutcome,
  type TaskResultSummary,
} from '../orchestration/index.ts';

const USAGE = `orchestrator task <subcommand>

SUBCOMMANDS
  list                       list child branches this tool owns (orch/task/*)
  inspect <taskId>           status, workspace, branch, dirty, changed files, diff stat
  diff <taskId>              the unified diff a merge would bring
  merge <taskId>             merge the child's branch into the root branch

OPTIONS
  --json                     machine-readable output
  --verified                 required by 'merge': the task store is in-memory, so a
                             separate process cannot see that this task was
                             verified. State it explicitly.
  --worktree-root <dir>      where worktrees live (default: <parent>/.p4m-worktrees)
  --lock-dir <dir>           where creation locks live (default: <parent>/.p4m-locks)

NOTES
  Merge never auto-commits, never resets, and never force-resolves a conflict.
  A conflict is left in place for you to resolve, and both the branch and the
  worktree are retained.
`;

interface Parsed {
  sub: string;
  args: string[];
  json: boolean;
  verified: boolean;
  worktreeRoot?: string;
  lockDir?: string;
}

function parseArgs(argv: readonly string[]): Parsed {
  const out: Parsed = { sub: '', args: [], json: false, verified: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') out.json = true;
    else if (a === '--verified') out.verified = true;
    else if (a === '--help' || a === '-h') out.sub = 'help';
    else if (a === '--worktree-root') out.worktreeRoot = argv[++i];
    else if (a === '--lock-dir') out.lockDir = argv[++i];
    else if (a.startsWith('-')) throw new Error(`unknown option "${a}"`);
    else if (out.sub === '') out.sub = a;
    else out.args.push(a);
  }
  return out;
}

function makeManager(projectRoot: string, p: Parsed): WorkspaceManager {
  return new WorkspaceManager({
    projectRoot,
    ...(p.worktreeRoot !== undefined ? { worktreeRoot: p.worktreeRoot } : {}),
    ...(p.lockDir !== undefined ? { lockDir: p.lockDir } : {}),
  });
}

function printSummary(s: TaskResultSummary, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
    return;
  }
  const d = s.diffStat;
  process.stdout.write(
    [
      `Task: ${s.taskId}`,
      `Status: ${s.status}`,
      `Agent: ${s.agentId}`,
      `Branch: ${s.branch ?? '-'}`,
      `Workspace: ${s.workspacePath ?? '-'}`,
      `Working tree: ${s.dirty ? 'dirty' : 'clean'}`,
      `Changed files: ${s.changedFiles.length}${s.changedFiles.length > 0 ? ` (${s.changedFiles.slice(0, 5).map((f) => f.path).join(', ')}${s.changedFiles.length > 5 ? ', ...' : ''})` : ''}`,
      `Diff: +${d.insertions} -${d.deletions} across ${d.files} file(s)`,
      `Commits on branch: ${s.hasCommits ? 'yes' : 'no'}`,
      `Merge: ${s.mergeReady ? 'ready' : 'blocked'}`,
      ...(s.mergeReady ? [] : [`  reason: ${s.mergeBlockedBecause}`]),
      ...(s.mergedCommit !== null ? [`Merged commit: ${s.mergedCommit}`] : []),
      '',
    ].join('\n'),
  );
}

function printMerge(m: MergeOutcome, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(m, null, 2)}\n`);
    return;
  }
  if (m.ok) {
    process.stdout.write(`Merge: success\nCommit: ${m.mergeCommit ?? '(unknown)'}\n`);
    return;
  }
  if (m.code === 'merge-conflict') {
    process.stdout.write(`Merge: conflict\nFiles: ${m.conflicts.join(', ')}\nWorkspace retained\nBranch retained\n\n`);
    return;
  }
  process.stdout.write(`Merge: refused (${m.code ?? 'error'})\n${m.reason}\n\n`);
}

export async function runTaskCli(argv: readonly string[], projectRoot: string): Promise<number> {
  let p: Parsed;
  try {
    p = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    return 2;
  }
  if (p.sub === '' || p.sub === 'help') {
    process.stdout.write(USAGE);
    return p.sub === '' ? 2 : 0;
  }

  const mgr = makeManager(projectRoot, p);
  const ctx = mgr.gitContext();

  if (p.sub === 'list') {
    const branches = await listTaskBranches({ ctx, projectRoot });
    if (p.json) {
      process.stdout.write(`${JSON.stringify(branches, null, 2)}\n`);
      return 0;
    }
    if (branches.length === 0) {
      process.stdout.write('No task branches (orch/task/*) found.\n');
      return 0;
    }
    process.stdout.write(`Tasks (${branches.length}):\n`);
    for (const b of branches) {
      const ws = await discoverWorkspaceByTask({ ctx, projectRoot, taskId: b.taskId });
      const where = ws !== null && !ws.released ? ws.cwd : '(no worktree)';
      process.stdout.write(`  ${b.taskId.padEnd(20)} ${b.sha.slice(0, 8)}  ${where}\n`);
    }
    process.stdout.write('\n');
    return 0;
  }

  const taskId = p.args[0];
  if (taskId === undefined) {
    process.stderr.write(`Usage: orchestrator task ${p.sub} <taskId>\n\n${USAGE}`);
    return 2;
  }

  const handle = await discoverWorkspaceByTask({ ctx, projectRoot, taskId });

  if (p.sub === 'inspect') {
    if (handle === null) {
      const msg = `no workspace branch found for task "${taskId}" (expected branch orch/task/${taskId})`;
      if (p.json) process.stdout.write(`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`);
      else process.stderr.write(`${msg}\n`);
      return 1;
    }
    // Task status is unavailable out of process; say "unknown", never guess.
    const summary = await summarizeTask({
      ctx, taskId, status: 'unknown (task store is in-memory)', agentId: 'unknown',
      handle, rootRepo: projectRoot,
    });
    printSummary(summary, p.json);
    return 0;
  }

  if (p.sub === 'diff') {
    if (handle === null || handle.branch === null || handle.repoRoot === null) {
      process.stderr.write(`no branch for task "${taskId}"\n`);
      return 1;
    }
    const range = handle.baseSha !== null ? `${handle.baseSha}..${handle.branch}` : handle.branch;
    const r = await runGit({ gitPath: ctx.gitPath, args: ['diff', range], cwd: handle.repoRoot, timeoutMs: ctx.timeoutMs, env: ctx.env });
    process.stdout.write(r.code === 0 ? `${r.stdout}\n` : '');
    return r.code === 0 ? 0 : 1;
  }

  if (p.sub === 'merge') {
    if (handle === null) {
      process.stderr.write(`no workspace branch found for task "${taskId}"\n`);
      return 1;
    }
    if (!p.verified) {
      const reason =
        'refusing to merge without --verified: this task store is in-memory, so a separate process ' +
        'cannot confirm the task reached "succeeded". Re-run inside a session, or pass --verified to state it yourself.';
      if (p.json) process.stdout.write(`${JSON.stringify({ ok: false, code: 'merge-verification-unknown', reason }, null, 2)}\n`);
      else process.stderr.write(`${reason}\n`);
      return 1;
    }
    if (!existsSync(handle.cwd)) {
      process.stderr.write(`worktree for "${taskId}" is not on disk; the branch can still be merged but nothing was checked\n`);
    }
    const outcome = await mergeTaskBranch({
      ctx, taskId, taskStatus: 'succeeded', handle, rootRepo: projectRoot,
    });
    printMerge(outcome, p.json);
    return outcome.ok ? 0 : 1;
  }

  process.stderr.write(`Unknown subcommand "${p.sub}".\n\n${USAGE}`);
  return 2;
}

export { USAGE as TASK_CLI_USAGE, resolveGitPath, join };