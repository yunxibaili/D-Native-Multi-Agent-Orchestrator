/**
 * src/orchestration/git.ts — the ONE git execution path for the orchestration
 * layer (extracted from `workspace.ts` in 5C-9, not duplicated).
 *
 * Everything that needs git — workspace creation, inspection, diff, merge —
 * goes through `runGit`. There is deliberately no second abstraction and no
 * shell: `ManagedProcess` + `launcherFor` with an argv array, so a path with
 * spaces and non-ASCII characters (this repo's own path has both) needs no
 * quoting and cannot be re-interpreted.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ManagedProcess } from '../runtime/spawn.ts';
import { launcherFor } from '../runtime/launcher.ts';
import { WorkspaceError } from './errors.ts';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Resolve `git`, honouring Git-for-Windows on PATH. Never uses a shell. */
export function resolveGitPath(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PATH ?? '';
  const dirs = raw.split(';').filter((d) => d !== '');
  const candidates = process.platform === 'win32' ? ['git.exe', 'git.cmd', 'git'] : ['git'];
  for (const name of candidates) {
    for (const dir of dirs) {
      const full = join(dir, name);
      if (existsSync(full)) return full;
    }
  }
  // Bare name is still worth trying: `launcherFor` will refuse it on Windows
  // with a precise message rather than a silent ENOENT.
  return 'git';
}

/**
 * `git worktree add` reports a BRANCH COLLISION with exit code 0 and `fatal:`
 * only on stderr (verified against git 2.44 on Windows). Trusting the exit code
 * alone would hand back a workspace that does not exist, so a `fatal:` on stderr
 * is treated as failure regardless of code.
 */
export function stderrIsFatal(result: GitResult): boolean {
  return /^\s*fatal:/m.test(result.stderr);
}

export interface RunGitOptions {
  gitPath: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  env: Readonly<Record<string, string | undefined>>;
}

export async function runGit(opts: RunGitOptions): Promise<GitResult> {
  const resolved = launcherFor(opts.gitPath);
  if (!resolved.ok) {
    throw new WorkspaceError('workspace-git-missing', `cannot run git: ${resolved.reason}`);
  }
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const proc = new ManagedProcess({
    launcher: resolved.launcher,
    args: opts.args,
    cwd: opts.cwd,
    env: opts.env as Readonly<Record<string, string>>,
    onStdoutLine: (line) => stdoutLines.push(line),
    onStderrLine: (line) => stderrLines.push(line),
    stderrTailBytes: 8 * 1024,
  });
  const exit = await Promise.race([
    proc.exited,
    new Promise<{ code: null; signal: string }>((r) => setTimeout(() => r({ code: null, signal: 'GIT_TIMEOUT' }), opts.timeoutMs)),
  ]);
  const stderr = proc.stderrTail.toString();
  return {
    code: exit.code ?? -1,
    stdout: stdoutLines.join('\n'),
    stderr: stderr === '' ? stderrLines.join('\n') : stderr,
  };
}