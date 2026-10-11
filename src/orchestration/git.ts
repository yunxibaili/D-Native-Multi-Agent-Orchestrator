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
import { ManagedProcess, type ProcessExit, type SpawnOptions } from '../runtime/spawn.ts';
import { launcherFor } from '../runtime/launcher.ts';
import { WorkspaceError } from './errors.ts';

/**
 * R5-1.1 (§2): the exit code reported for a timed-out git operation. `124` is the
 * conventional exit code of the POSIX `timeout` command, so the convention reads
 * the same everywhere: `code === 124` means "killed by deadline". A timed-out git
 * is NEVER a success — every existing `code === 0` consumer therefore treats it as
 * a failure without each of them needing a separate `timedOut` check.
 */
export const GIT_TIMEOUT_EXIT_CODE = 124;

/**
 * R5-1.2 (§3.1): the stop-confirmation state of ONE git invocation. A Git
 * execution fact, not a global outcome vocabulary:
 *
 *   completed        natural exit, code 0
 *   failed-stopped   natural exit, non-zero code
 *   timeout-stopped  deadline elapsed; the process was stopped AND that stop was
 *                    confirmed (real exit observed) before runGit returned
 *   stop-unconfirmed deadline elapsed and the tree's end state could NOT be
 *                    confirmed — callers must treat the workspace and any lock
 *                    held across the call as UNRELEASEABLE until a real stop is
 *                    confirmed
 */
export type GitStopState = 'completed' | 'failed-stopped' | 'timeout-stopped' | 'stop-unconfirmed';

/**
 * R5-1.2 (P1-1): interval between re-requested cancellations while a timed-out
 * git tree's stop is still unconfirmed. This paces repeated stop attempts of the
 * SAME execution through the SAME ManagedProcess seam; it is never a sleep-guess
 * that declares the process dead — only the process's own exit does that.
 */
const R5_UNCONFIRMED_RETRY_MS = 2_000;

export interface GitResult {
  /**
   * The operation's exit status as a SUCCESS PREDICATE input. On timeout this is
   * `GIT_TIMEOUT_EXIT_CODE` (124), never the child's own code — a `code === 0`
   * check can no longer mistake a killed git for a completed one.
   */
  code: number;
  /**
   * R5-1.1 (§2): the RAW exit code the child actually reported, kept as a
   * DIAGNOSTIC fact only. It is never a success signal.
   */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /**
   * R5-1 (P1-B): true when this invocation ended because the caller's timeout
   * elapsed, not because git exited.
   */
  timedOut: boolean;
  /**
   * R5-1.1 (§3): the cancellation fact, from the existing `ManagedProcess` seam.
   * `true` = the tree kill was issued and confirmed (or the root was already gone).
   * `false` = cancellation could NOT confirm the tree is dead. `null` = no
   * cancellation was requested (natural exit).
   */
  cancelConfirmed: boolean | null;
  /**
   * R5-1.1 (§3): the pending-cleanup fact from the same seam. `null` = there was
   * nothing pending (natural exit); otherwise `true` = pending cleanup awaited and
   * confirmed, `false` = cleanup could not be confirmed.
   */
  cleanupConfirmed: boolean | null;
  /**
   * R5-1.2 (§3.1): true ONLY when the root's real exit was observed before runGit
   * returned. This is a DIAGNOSTIC fact about the root alone.
   *
   * R5-1.2C (§3): it is deliberately NOT the field protection depends on. A root that
   * spawned a descendant and died leaves that descendant running and still able to
   * write the workspace, so "the root is gone" cannot mean "the tree is stopped".
   */
  processStoppedConfirmed: boolean;
  /**
   * R5-1.2C (§3): the root's exit, stated separately so nobody can mistake it for tree
   * quiescence. Always true here: runGit never returns before the root's real exit was
   * observed. That is exactly why it is not sufficient on its own.
   */
  rootTerminalObserved: boolean;
  /**
   * R5-1.2C (§3): whether the DESCENDANT TREE is confirmed no longer running.
   *
   * This — not {@link processStoppedConfirmed} — is the fact a workspace or resource
   * lock may rely on before releasing physical protection. `false` means the stop was
   * requested and could NOT be confirmed, so a live writer may still hold the scope.
   */
  treeStopConfirmed: boolean;
  /** R5-1.2 (§3.1): which of the four stop states this invocation ended in. */
  stopState: GitStopState;
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
  /**
   * R5-1.1 (§3): how long to wait for the killed root's exit after the FIRST
   * cancellation before entering the unconfirmed-stop loop (default 5000 ms).
   */
  finalizeGraceMs?: number;
  /**
   * Test seam: override the process construction. Production callers never set
   * this; it exists so the cancellation-failure contract can be exercised
   * deterministically without a real unkillable process.
   */
  processFactory?: (procOpts: SpawnOptions) => ManagedProcess;
}

/**
 * R5-1.2 (§9): race a promise against a timeout with the timer ALWAYS cleared on
 * every settlement path. A Promise that loses a `Promise.race` still leaves its
 * timer referenced and would keep the process alive past runGit's return.
 */
function bounded<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let t: NodeJS.Timeout | null = null;
  return Promise.race([
    p.finally(() => {
      if (t !== null) {
        clearTimeout(t);
      }
    }),
    new Promise<T>((resolve) => {
      t = setTimeout(() => resolve(onTimeout()), ms);
    }),
  ]);
}

export async function runGit(opts: RunGitOptions): Promise<GitResult> {
  const resolved = launcherFor(opts.gitPath);
  if (!resolved.ok) {
    throw new WorkspaceError('workspace-git-missing', `cannot run git: ${resolved.reason}`);
  }
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const spawnOpts: SpawnOptions = {
    launcher: resolved.launcher,
    args: opts.args,
    cwd: opts.cwd,
    env: opts.env as Readonly<Record<string, string>>,
    onStdoutLine: (line) => stdoutLines.push(line),
    onStderrLine: (line) => stderrLines.push(line),
    stderrTailBytes: 8 * 1024,
  };
  const proc = opts.processFactory ? opts.processFactory(spawnOpts) : new ManagedProcess(spawnOpts);

  // R5-1.1 (P1-A): finalization must be CLOSED. The race only decides WHICH event
  // happens first; it can never decide whether finalization is complete:
  //
  //   natural exit first  -> clear the timer, return the real exit.
  //   timeout first       -> mark timeout, request tree cancellation, AWAIT it, AWAIT
  //                          cleanup, THEN await the root's real exit — even if the
  //                          root exits naturally while cancellation is running, it
  //                          cannot bypass the cancel/cleanup completion.
  let timedOut = false;
  const exitOrTimeout = await bounded<ProcessExit | 'timeout'>(
    proc.exited,
    opts.timeoutMs,
    () => 'timeout',
  );

  let finalExit: ProcessExit;
  let cancelConfirmed: boolean | null = null;
  let cleanupConfirmed: boolean | null = null;
  if (exitOrTimeout !== 'timeout') {
    // Natural exit: the process tree's root is gone; nothing to cancel.
    finalExit = exitOrTimeout;
  } else {
    timedOut = true;
    // Request termination through the EXISTING ManagedProcess boundary and AWAIT it.
    // A false here means taskkill could not confirm the kill — surfaced below, never
    // swallowed into a "completed" verdict.
    try {
      cancelConfirmed = await bounded(
        proc.cancel(`git timeout of ${opts.timeoutMs}ms exceeded`),
        opts.finalizeGraceMs ?? 5_000,
        () => false,
      );
    } catch {
      cancelConfirmed = false;
    }
    try {
      cleanupConfirmed = await bounded(proc.settleCleanup(), opts.finalizeGraceMs ?? 5_000, () => false);
    } catch {
      cleanupConfirmed = false;
    }
    // R5-1.2 (P1-1): a still-active tree after an awaited cancellation is a
    // PHYSICAL protection problem, not just a reporting problem — the workspace
    // creation lock the caller holds must not be released while this child may
    // still be writing. runGit therefore does NOT return an unconfirmed result:
    // it stays INSIDE finalization, re-requesting cancellation through the same
    // existing seam at intervals, until the root's REAL exit is observed. If the
    // process is truly unkillable, the workspace stays protected (and the lock
    // stays held) — protection wins over convenience, by design. No sleep-guess:
    // only the process's own exit settles this loop.
    let settled = await bounded<{ exit: ProcessExit } | 'still-active'>(
      proc.exited.then((e) => ({ exit: e as ProcessExit })),
      opts.finalizeGraceMs ?? 5_000,
      () => 'still-active',
    );
    while (settled === 'still-active') {
      await new Promise((r) => setTimeout(r, R5_UNCONFIRMED_RETRY_MS));
      try {
        cancelConfirmed = (await proc.cancel('git timeout: re-requesting the unconfirmed stop')) && cancelConfirmed !== false;
      } catch {
        /* only the process's own exit is terminal; keep asking */
      }
      try {
        cleanupConfirmed = (await proc.settleCleanup()) && cleanupConfirmed !== false;
      } catch {
        /* same */
      }
      settled = await bounded<{ exit: ProcessExit } | 'still-active'>(
        proc.exited.then((e) => ({ exit: e as ProcessExit })),
        R5_UNCONFIRMED_RETRY_MS,
        () => 'still-active',
      );
    }
    finalExit = settled.exit;
  }
  const stderr = proc.stderrTail.toString();
  // R5-1.2C (§2, §3): `proc.exited` settles when the ROOT is gone, which is a real and
  // necessary fact — but it is NOT the fact that the tree stopped. This used to be a
  // hardcoded `true`, so a timed-out git whose cancel and cleanup BOTH failed still
  // reported "process stopped" the moment the root exited, and the caller's `finally`
  // released the workspace lock while a descendant could still be writing.
  //
  // The two facts are now separate. `rootTerminalObserved` is diagnostic; protection
  // release may only rely on `treeStopConfirmed`.
  //
  // W2: the tree-stop truth now comes from the containment producer in ALL cases,
  // INCLUDING a natural exit. The previous `: true` shortcut asserted a stopped tree
  // merely because the root exited — precisely the claim W0 showed is unprovable
  // without a Windows Job Object. For a contained run the producer reads the Job's
  // `ActiveProcesses == 0` evidence; when that evidence is absent (launcher killed,
  // control record incomplete, malformed) the honest answer is `false`/unknown, never
  // an optimistic `true`.
  const producerSaysStopped =
    typeof proc.isTreeStopConfirmed === 'function' ? proc.isTreeStopConfirmed() : false;
  const rootTerminalObserved = true;
  const treeStopConfirmed = timedOut
    ? cancelConfirmed !== false && cleanupConfirmed !== false && producerSaysStopped
    : producerSaysStopped;
  const processStoppedConfirmed = treeStopConfirmed;
  // R5-1.2C (§5): `stop-unconfirmed` finally has a producer. Previously the member
  // existed in the union but nothing could ever emit it, so an unconfirmed stop was
  // indistinguishable from a clean timeout kill.
  const stopState: GitStopState = !timedOut
    ? finalExit.code === 0
      ? 'completed'
      : 'failed-stopped'
    : treeStopConfirmed
      ? 'timeout-stopped'
      : 'stop-unconfirmed';
  const code = timedOut
    ? // R5-1.1 (§2): a timed-out git is NEVER a success. The conventional `timeout`
      // exit code 124 replaces whatever the killed child happened to report, so no
      // `code === 0` consumer can mistake this for success; the raw exit code stays
      // available as a diagnostic fact.
      GIT_TIMEOUT_EXIT_CODE
    : finalExit.code ?? -1;
  return {
    code,
    exitCode: finalExit.code,
    stdout: stdoutLines.join('\n'),
    stderr: stderr === '' ? stderrLines.join('\n') : stderr,
    timedOut,
    cancelConfirmed,
    cleanupConfirmed,
    processStoppedConfirmed,
    rootTerminalObserved,
    treeStopConfirmed,
    stopState,
  };
}
