/**
 * src/orchestration/workspace-lock.ts — cross-process workspace creation lock.
 *
 * WHY THIS EXISTS (5C-8)
 * ---------------------
 * `WorkspaceManager.prepare()` is idempotent only WITHIN one process. Two
 * processes (two orchestrators, a scheduler plus a CLI, two agents) preparing the
 * same task could both observe "no worktree, no branch" and both run
 * `git worktree add`, producing duplicate worktrees or a spurious branch
 * collision. The 5C-5 in-memory `handles` map cannot see across processes.
 *
 * DESIGN, in the spirit of the Phase 5A audit of pi-subagents
 * (`src/schedule-store.ts`: "PID lock + atomic write")
 * --------------------------------------------------------------------------
 * * ATOMIC ACQUIRE — a single file created with `openSync(path, 'wx')`
 *   (`O_CREAT|O_EXCL`). Verified on this machine: the second creator gets EEXIST,
 *   and 200 concurrent racers produced exactly one winner. A directory + a
 *   separate owner file would leave a window where the lock exists but its owner
 *   is unknown; one file with the owner metadata inside it has no such window.
 * * OWNER IDENTITY — `{ pid, hostname, token, createdAt }`. `token` is a random
 *   UUID minted per acquisition, so release can be PROVEN: we only delete a lock
 *   whose token is still ours.
 * * STALE RECOVERY — liveness, not age. Age alone is explicitly rejected: a slow
 *   but healthy `git worktree add` must not have its lock stolen. A lock is
 *   stolen only when its owner is *provably* dead:
 *       - same host  -> `process.kill(pid, 0)` reports no such process;
 *       - other host -> NOT stolen (death cannot be proven from here);
 *       - unparseable owner -> stolen only after a grace period, because this
 *         code always writes valid JSON, so an unparseable file was not written
 *         by a cooperating live process.
 * * NO SHELL, NO SERVICE — pure `node:fs`. Nothing Unix-only.
 *
 * LOCK SCOPE
 * ----------
 * The lock must cover IDENTITY RESOLUTION + EXISTENCE CHECKS + CREATION, not
 * just the `git worktree add` call. Wrapping only the git call would leave
 * "A checks, B checks, A locks too late" open. `WorkspaceManager` therefore
 * acquires before resolving and holds through creation.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

/** Who holds a lock. Small, finite metadata — never a growing log. */
export interface WorkspaceLockOwner {
  /** Process id of the holder on `hostname`. */
  readonly pid: number;
  /** Machine that took the lock. A lock from another host is never stolen. */
  readonly hostname: string;
  /** Random per-acquisition token; makes release provable. */
  readonly token: string;
  /** Epoch ms when the lock was taken. Diagnostic only — never a stale rule. */
  readonly createdAt: number;
  /** Optional human-readable reason, e.g. `workspace:orch/task/A`. */
  readonly purpose?: string;
}

export const WORKSPACE_LOCK_ERROR_CODES = [
  'workspace-lock-timeout',
  'workspace-lock-not-owned',
  'workspace-lock-corrupt',
] as const;
export type WorkspaceLockErrorCode = (typeof WORKSPACE_LOCK_ERROR_CODES)[number];

export class WorkspaceLockError extends Error {
  readonly code: WorkspaceLockErrorCode;
  constructor(code: WorkspaceLockErrorCode, message: string) {
    super(message);
    this.name = 'WorkspaceLockError';
    this.code = code;
  }
}

export interface WorkspaceLockOptions {
  /** Directory that holds lock files. One per git repository. */
  lockDir: string;
  /** How long to wait for a contended lock before giving up. */
  timeoutMs?: number;
  /** Delay between acquisition attempts. */
  pollMs?: number;
  now?: () => number;
  pid?: number;
  host?: string;
  /**
   * Grace period before an UNPARSEABLE lock may be reclaimed. Only applies to
   * locks whose owner cannot be read at all; a parseable lock is judged by PID
   * liveness, never by age.
   */
  corruptGraceMs?: number;
  /** Injected sleeper, so tests need not burn wall-clock. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Normalise a path into a stable identity for lock naming on Windows.
 *
 * Case, separator style, duplicate separators, a trailing separator and the
 * drive-letter case must all collapse to ONE identity, otherwise `C:\Repo` and
 * `c:/repo/` would take two different locks for the same project.
 */
export function normalizeIdentityPath(input: string): string {
  let p = resolvePath(input).replace(/\//g, '\\');
  // UNC: \\server\share -> \\server\share (keep the leading double separator)
  p = p.replace(/\\{2,}/g, '\\');
  if (/^[a-z]:/i.test(p)) p = p[0].toLowerCase() + p.slice(1);
  p = p.toLowerCase();
  if (p.length > 1 && p.endsWith('\\')) p = p.slice(0, -1);
  return p;
}

/**
 * A short, collision-resistant digest of an identity string.
 * FNV-1a: no crypto dependency, stable across processes and runs, and only used
 * to keep lock FILE NAMES short and filesystem-safe.
 */
export function identityDigest(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** The lock key: project identity + workspace identity, per the 5C-8 spec. */
export function workspaceLockKey(projectIdentity: string, workspaceIdentity: string): string {
  const project = identityDigest(normalizeIdentityPath(projectIdentity));
  const task = workspaceIdentity.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').replace(/[-.]+$/, '').slice(0, 64);
  if (task === '') {
    throw new WorkspaceLockError('workspace-lock-corrupt', `workspace identity "${workspaceIdentity}" has no lock-safe characters`);
  }
  return `${project}-${task}`;
}

/** Is `pid` a live process *on this machine*, as far as Node can tell? */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs the permission/existence check without delivering.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but we may not signal it.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A held lock. Release is provable because the token must still match. */
export interface WorkspaceLockLease {
  readonly path: string;
  readonly key: string;
  readonly owner: WorkspaceLockOwner;
  /** Idempotent; safe in a `finally`. */
  release(): void;
}

export class WorkspaceLock {
  private readonly lockDir: string;
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly host: string;
  private readonly corruptGraceMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: WorkspaceLockOptions) {
    this.lockDir = options.lockDir;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.pollMs = options.pollMs ?? 25;
    this.now = options.now ?? Date.now;
    this.pid = options.pid ?? process.pid;
    this.host = options.host ?? hostname();
    this.corruptGraceMs = options.corruptGraceMs ?? 60_000;
    this.sleep = options.sleep ?? defaultSleep;
  }

  pathFor(key: string): string {
    return join(this.lockDir, `${key}.lock`);
  }

  /** Read the current owner, or null when the lock is free / unreadable. */
  inspect(key: string): { owner: WorkspaceLockOwner | null; corrupt: boolean; raw: string | null } {
    const path = this.pathFor(key);
    if (!existsSync(path)) return { owner: null, corrupt: false, raw: null };
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return { owner: null, corrupt: true, raw: null };
    }
    try {
      const parsed = JSON.parse(raw) as WorkspaceLockOwner;
      if (typeof parsed.pid !== 'number' || typeof parsed.token !== 'string' || typeof parsed.hostname !== 'string') {
        return { owner: null, corrupt: true, raw };
      }
      return { owner: parsed, corrupt: false, raw };
    } catch {
      return { owner: null, corrupt: true, raw };
    }
  }

  /** True when the holder is provably gone and the lock may be reclaimed. */
  private isStale(owner: WorkspaceLockOwner | null, corrupt: boolean): { stale: boolean; why: string } {
    if (owner === null) {
      if (!corrupt) return { stale: false, why: 'no lock present' };
      return { stale: true, why: 'lock file is unparseable, so no live cooperating process owns it' };
    }
    if (owner.hostname !== this.host) {
      // We cannot prove a remote process is dead. Never steal a foreign lock.
      return { stale: false, why: `lock is held by host "${owner.hostname}", whose liveness cannot be proven from here` };
    }
    if (isProcessAlive(owner.pid)) {
      return { stale: false, why: `owner pid ${owner.pid} is alive` };
    }
    return { stale: true, why: `owner pid ${owner.pid} on this host is no longer running` };
  }

  /**
   * Acquire the lock, waiting up to `timeoutMs`.
   *
   * Ordering is deliberate: CREATE first, decide afterwards. A stale lock is
   * removed and the attempt retried, so two processes reclaiming the same dead
   * lock simply race for the exclusive create and exactly one wins.
   */
  async acquire(key: string, purpose?: string): Promise<WorkspaceLockLease> {
    mkdirSync(this.lockDir, { recursive: true });
    const path = this.pathFor(key);
    const deadline = this.now() + this.timeoutMs;
    let lastWhy = 'lock was never free within the timeout';

    for (;;) {
      // 1. Atomic exclusive create. This IS the mutual exclusion.
      try {
        const fd = openSync(path, 'wx');
        const owner: WorkspaceLockOwner = {
          pid: this.pid,
          hostname: this.host,
          token: randomUUID(),
          createdAt: this.now(),
          ...(purpose !== undefined ? { purpose } : {}),
        };
        try {
          writeFileSync(fd, JSON.stringify(owner));
        } finally {
          closeSync(fd);
        }
        return this.makeLease(key, path, owner);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }

      // 2. Contended. Decide whether the holder is provably dead.
      const { owner, corrupt } = this.inspect(key);
      const verdict = this.isStale(owner, corrupt);
      lastWhy = verdict.why;
      if (verdict.stale) {
        if (owner !== null) {
          // Provable death (dead PID on this host): reclaim at once.
          rmSync(path, { force: true });
          continue;
        }
        // Unparseable: reclaim only after the grace window, so a lock that a
        // cooperating process is midway through writing is never stolen.
        let age = 0;
        try {
          age = this.now() - statSync(path).mtimeMs;
        } catch {
          age = 0;
        }
        if (age >= this.corruptGraceMs) {
          rmSync(path, { force: true });
          continue;
        }
        lastWhy = `${verdict.why} (age ${Math.round(age)}ms < grace ${this.corruptGraceMs}ms)`;
      }

      if (this.now() >= deadline) {
        throw new WorkspaceLockError(
          'workspace-lock-timeout',
          `could not acquire workspace lock "${key}" within ${this.timeoutMs}ms (${lastWhy})`,
        );
      }
      await this.sleep(this.pollMs);
    }
  }

  private makeLease(key: string, path: string, owner: WorkspaceLockOwner): WorkspaceLockLease {
    let released = false;
    return {
      path,
      key,
      owner,
      release: (): void => {
        if (released) return;
        released = true;
        // Provable release: only delete a lock that is STILL ours.
        const current = this.inspect(key);
        if (current.owner === null || current.owner.token !== owner.token) {
          throw new WorkspaceLockError(
            'workspace-lock-not-owned',
            `refusing to delete workspace lock "${key}": it is no longer held by this acquisition`,
          );
        }
        rmSync(path, { force: true });
      },
    };
  }

  /** Non-throwing release, for `finally` blocks. Returns why it did nothing. */
  tryRelease(lease: WorkspaceLockLease): string | null {
    try {
      lease.release();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
}