/**
 * tests/helpers/process-observer.ts — SAME-PROCESS liveness observation (W5.1a P1-4).
 *
 * ============================================================================
 * WHY A NEW OBSERVATION BACKEND
 * ============================================================================
 * The previous W5.1 helper used `spawnSync(fixture, ['--role','probe',...]).status
 * === 0` to decide whether a process was alive. That is fail-OPEN in three ways:
 *
 *  1. `spawnSync` reports probe EXECUTION problems through `error`, `status` and
 *     `signal` separately. A probe that failed to start, timed out, or was killed
 *     all collapse to "not 0", which the caller read as "the target is dead" — the
 *     exact opposite of what is known.
 *  2. The old native `probe` role returns 1 for BOTH "OpenProcess succeeded and the
 *     target is gone" AND "OpenProcess itself failed". So even a correctly-executed
 *     probe cannot distinguish those two.
 *  3. Re-opening a process BY PID for every observation is ambiguous: the PID may
 *     have been recycled, so a later observation may be about a DIFFERENT process.
 *
 * Node reports execution failure via `error` / `status` / `signal` separately; a
 * Windows handle stays valid after the process exits, so holding the ORIGINAL
 * handle removes the reuse ambiguity. This helper is built on both facts.
 *
 * THE MODEL
 * An `Observer` holds the target's ORIGINAL process handle inside a long-lived
 * `w1fixture --role observe` process that is OUTSIDE the Job under test. It:
 *   - opens the handle once and writes an ACK (handle acquired);
 *   - waits on THAT handle;
 *   - reports one of: TERMINATED / STILL_RUNNING / OBSERVATION_ERROR, distinctly.
 *
 * Because the caller keys on the HELD HANDLE, the observer's own death, timeout or
 * loss can never masquerade as the target's exit: an observer that dies without a
 * verdict is an OBSERVATION_ERROR, and an UNKNOWN must never satisfy a death check.
 *
 * This is a TEST helper. It owns no production authority and creates no manager.
 * It only observes, and it refuses to answer when it cannot answer honestly.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

/** Native observer exit codes — must match `w1fixture.c` role `observe`. */
export const OBSERVE_CODES = {
  /** WAIT_OBJECT_0: the HELD process terminated. Same-process proof. */
  TERMINATED: 0,
  /** WAIT_TIMEOUT: the held process is STILL RUNNING. Never a death. */
  STILL_RUNNING: 10,
  /** WAIT_FAILED: the observation itself failed. Never a death. */
  OBSERVATION_FAILED: 11,
  /** OpenProcess failed: we could not observe at all. Never a death. */
  UNOBSERVABLE: 12,
  /** Bad arguments / no target. */
  BAD_ARGS: 13,
} as const;

export type Liveness =
  | { readonly state: 'ALIVE' }
  | { readonly state: 'EXITED' }
  /** Observation could NOT be completed. Must never satisfy a death assertion. */
  | { readonly state: 'OBSERVATION_ERROR'; readonly why: string };

const FIXTURE = join(
  process.cwd(),
  'native',
  'windows-job-launcher',
  'build',
  'w1fixture.exe',
);

/**
 * An observer that holds ONE target's original handle for its lifetime.
 *
 * Created with `open()`; the handle is acquired asynchronously, so a caller MUST
 * await `ready` (or `readyError`) before it is allowed to treat the target as
 * observable. `verdict()` blocks (bounded) until the observer reaches a verdict or
 * the deadline expires.
 */
export interface Observer {
  /** PID whose handle this observer holds. */
  readonly pid: number;
  /** True once the ACK proves the handle was actually acquired. */
  acquired(): Promise<boolean>;
  /** Bounded verdict: ALIVE / EXITED / OBSERVATION_ERROR (never a false death). */
  verdict(timeoutMs: number): Promise<Liveness>;
  /** Stop the observer and release its handle. Safe to call repeatedly. */
  close(): void;
}

interface ObserverInternal extends Observer {
  _settled: boolean;
}

/**
 * Start an observer for `targetPid`.
 *
 * The observer is spawned detached:false and is deliberately NOT part of any Job
 * under test, so it can observe a process that is inside one. Its own exit or loss
 * is handled as an observation failure, never as the target's exit.
 *
 * NOTE (W1 §10.9 cross-volume finding): the fixture binary lives on the binaries'
 * volume; on this workstation a `D:` process cannot write to `C:`. The observer's
 * ACK therefore uses an in-memory readiness signal (its stdout line) rather than a
 * file, so no cross-volume write is required to observe a handle.
 */
export function open(targetPid: number): ObserverInternal | null {
  if (!existsSync(FIXTURE)) return null;

  // The observer waits INFINITE on the held handle; the TEST bounds it.
  const child: ChildProcess = spawn(FIXTURE, ['--role', 'observe', '--pid', String(targetPid)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: false,
  });

  let acquiredFlag = false;
  let resolveAcquired: (() => void) | null = null;
  const acquiredPromise = new Promise<boolean>((res) => {
    resolveAcquired = () => res(acquiredFlag);
  });
  // The observer ACKs on stdout once the handle is HELD. Reading stdout is what
  // proves acquisition; an observer that never ACKs cannot be treated as acquired.
  child.stdout?.on('data', (b: Buffer) => {
    if (b.toString('utf8').includes('handle=ok')) {
      acquiredFlag = true;
      if (resolveAcquired !== null) resolveAcquired();
    }
  });
  // If the observer dies before ACK, acquisition failed.
  child.on('exit', () => {
    if (resolveAcquired !== null) resolveAcquired();
  });
  child.on('error', () => {
    if (resolveAcquired !== null) resolveAcquired();
  });

  let exitCode: number | null = null;
  let spawnError: string | null = null;
  child.on('exit', (code, signal) => {
    if (code === null && signal !== null) spawnError = `observer killed by signal ${signal}`;
    else exitCode = code;
    if (resolveAcquired !== null) resolveAcquired();
  });
  child.on('error', (e) => {
    spawnError = `observer spawn error: ${e.message}`;
    if (resolveAcquired !== null) resolveAcquired();
  });

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  };

  const acquired = async (): Promise<boolean> => {
    // Bounded wait for the ACK. If the observer dies or errors first, this is false.
    const ok = await Promise.race([
      acquiredPromise,
      new Promise<boolean>((res) => setTimeout(() => res(false), 5_000)),
    ]);
    return ok && acquiredFlag && spawnError === null;
  };

  const verdict = async (timeoutMs: number): Promise<Liveness> => {
    if (spawnError !== null) return { state: 'OBSERVATION_ERROR', why: spawnError };
    if (exitCode === null) {
      // Give the observer a bounded window to reach a verdict.
      const deadline = Date.now() + timeoutMs;
      while (exitCode === null && spawnError === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 40));
      }
      if (exitCode === null && spawnError === null) {
        // No verdict within the bound: STILL RUNNING is the honest answer, and it is
        // a liveness fact, not an observation failure.
        return { state: 'ALIVE' };
      }
    }
    if (spawnError !== null) return { state: 'OBSERVATION_ERROR', why: spawnError };
    switch (exitCode) {
      case OBSERVE_CODES.TERMINATED:
        return { state: 'EXITED' };
      case OBSERVE_CODES.STILL_RUNNING:
        return { state: 'ALIVE' };
      case OBSERVE_CODES.OBSERVATION_FAILED:
        return { state: 'OBSERVATION_ERROR', why: 'observer WaitForSingleObject failed' };
      case OBSERVE_CODES.UNOBSERVABLE:
        return { state: 'OBSERVATION_ERROR', why: 'observer could not OpenProcess the target' };
      default:
        return { state: 'OBSERVATION_ERROR', why: `observer exited with unexpected code ${String(exitCode)}` };
    }
  };

  return { pid: targetPid, acquired, verdict, close, _settled: false };
}

/**
 * One-shot liveness WITHOUT a held handle.
 *
 * Uses the observer role but does not retain the handle across calls, so it is only
 * suitable for a best-effort ALIVE check. It NEVER returns EXITED: a one-shot cannot
 * provide same-process proof, so anything else is an honest ALIVE / ERROR.
 */
export async function livenessBestEffort(targetPid: number, timeoutMs = 3_000): Promise<Liveness> {
  const obs = open(targetPid);
  if (obs === null) return { state: 'OBSERVATION_ERROR', why: 'fixture missing' };
  try {
    const ok = await obs.acquired();
    if (!ok) return { state: 'OBSERVATION_ERROR', why: 'observer never acquired the handle' };
    return await obs.verdict(timeoutMs);
  } finally {
    obs.close();
  }
}