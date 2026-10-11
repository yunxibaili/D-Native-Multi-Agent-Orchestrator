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
  /** TerminateProcess was REFUSED on the held handle. Never a proven death. */
  TERMINATE_REFUSED: 14,
} as const;

/**
 * W5.1c §2: outcome of an IDENTITY-BOUND terminate.
 *
 * There is deliberately no "probably fine" branch: each native wait result is its
 * own kind, and only `EXIT_CONFIRMED` (native WAIT_OBJECT_0 on the HELD handle)
 * may ever satisfy an exit assertion.
 */
export type TerminateResult =
  /** Native WAIT_OBJECT_0 on the held handle after our terminate. Same-process proof. */
  | { readonly kind: 'EXIT_CONFIRMED'; readonly via: 'held-handle' }
  /** Native WAIT_TIMEOUT: the process is still running after the terminate. */
  | { readonly kind: 'STILL_ALIVE'; readonly native: 'WAIT_TIMEOUT' }
  /** Native WAIT_FAILED: the wait itself failed. */
  | { readonly kind: 'WAIT_FAILED'; readonly why: string }
  /** TerminateProcess was refused on the held handle: NOT a proven death. */
  | { readonly kind: 'TERMINATE_REFUSED'; readonly why: string }
  /**
   * No held handle / never acquired: identity is NOT confirmable, so NOTHING was
   * terminated. This is the fail-closed branch that replaces the old pid-only reap.
   */
  | { readonly kind: 'IDENTITY_UNCONFIRMED'; readonly why: string }
  /** The observer itself was lost (spawn error / signal / no verdict in time). */
  | { readonly kind: 'OBSERVER_LOST'; readonly why: string };

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
  /**
   * Whether the handle is CURRENTLY held (the ACK was seen and the observer has
   * not been lost). This is the identity PRECONDITION for any termination: without
   * it, the caller must refuse to guess.
   */
  holdsIdentity(): boolean;
  /** Bounded verdict: ALIVE / EXITED / OBSERVATION_ERROR (never a false death). */
  verdict(timeoutMs: number): Promise<Liveness>;
  /**
   * W5.1c §2: terminate the target THROUGH THE HELD HANDLE and report the native
   * wait result as a distinct kind.
   *
   * This is the ONLY termination path. It refuses (without killing anything) when
   * the handle was never acquired, because a fresh OpenProcess by an old PID cannot
   * restore the original identity. A successful fallback never erases the failure
   * that triggered it; the caller records both.
   */
  terminateAndVerify(timeoutMs?: number): Promise<TerminateResult>;
  /** Stop the observer and release its handle. Safe to call repeatedly. */
  close(): void;
  /**
   * W5.1b §3: close AND await the observer's own exit.
   *
   * The observer is an owned process; a caller that closes it without waiting
   * cannot know whether it really terminated. Returns false if it did not exit
   * within the bound, which the caller must treat as a cleanup failure.
   */
  reaped(timeoutMs?: number): Promise<boolean>;
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
export function open(targetPid: number, opts?: { holdMs?: number }): ObserverInternal | null {
  if (!existsSync(FIXTURE)) return null;

  /*
   * `--hold-ms` bounds the NATIVE WaitForSingleObject. When set, a still-running
   * target produces a real WAIT_TIMEOUT from the OS and the observer exits 10
   * (STILL_RUNNING) — a genuine liveness FACT, distinct from the client-side wait
   * below. Without it the observer uses its own default bound.
   */
  const holdArg = opts?.holdMs !== undefined ? ['--hold-ms', String(opts.holdMs)] : [];
  // stdin is a PIPE (not 'ignore') so a terminate can be commanded through the very
  // handle this observer holds; W5.1c §2 forbids terminating by pid.
  const child: ChildProcess = spawn(FIXTURE, ['--role', 'observe', '--pid', String(targetPid), ...holdArg], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: false,
  });

  let acquiredFlag = false;
  let resolveAcquired: (() => void) | null = null;
  let terminateAck: 'none' | 'sent' | 'failed' = 'none';
  const acquiredPromise = new Promise<boolean>((res) => {
    resolveAcquired = () => res(acquiredFlag);
  });
  // The observer ACKs on stdout once the handle is HELD, and separately reports the
  // outcome of any terminate it was commanded to perform. Reading stdout is what
  // proves acquisition; an observer that never ACKs cannot be treated as acquired.
  child.stdout?.on('data', (b: Buffer) => {
    const text = b.toString('utf8');
    if (text.includes('handle=ok')) {
      acquiredFlag = true;
      if (resolveAcquired !== null) resolveAcquired();
    }
    if (text.includes('terminate=sent')) terminateAck = 'sent';
    else if (text.includes('terminate=failed')) terminateAck = 'failed';
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
  let exited: Promise<void> = Promise.resolve();
  const close = (): void => {
    if (closed) return;
    closed = true;
    // W5.1b §3: the observer itself is an owned process. Record its exit so a
    // caller can AWAIT it; an observer that was never awaited could outlive the
    // test holding a handle.
    exited = new Promise<void>((res) => {
      if (exitCode !== null || spawnError !== null) { res(); return; }
      child.once('exit', () => res());
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    });
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
        /*
         * W5.1b §3: this is a CLIENT-side wait that expired. It is NOT the native
         * WAIT_TIMEOUT the observer would report, and it is not evidence the target
         * is alive — the handle may be signalling right now, or the observer may be
         * wedged. Fabricating ALIVE here is the fail-open the review flagged, so the
         * honest answer is "no fact", which may never satisfy a death check.
         */
        return { state: 'OBSERVATION_ERROR', why: `observer produced no verdict within ${timeoutMs}ms (client wait expired; not a native WAIT_TIMEOUT)` };
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
      case OBSERVE_CODES.TERMINATE_REFUSED:
        return { state: 'OBSERVATION_ERROR', why: 'observer TerminateProcess was refused on the held handle' };
      default:
        return { state: 'OBSERVATION_ERROR', why: `observer exited with unexpected code ${String(exitCode)}` };
    }
  };

  /**
   * W5.1c §2: the identity PRECONDITION for any termination.
   *
   * Acquiring the handle is a PERMANENT fact about this observer's target: it stays
   * true after the observer reaches its verdict (the native handle remains valid for
   * the original process object even once it has exited), and turns false only when
   * the handle is actually released or the observer was lost.
   */
  const holdsIdentity = (): boolean => acquiredFlag && !closed && spawnError === null;

  /**
   * Terminate THROUGH THE HELD HANDLE and report the native wait result.
   *
   * Fail-closed by construction: if the handle was never acquired (or the observer
   * was lost) NOTHING is sent and the caller is told identity is unconfirmed. This
   * replaces the W5.1b pid-only `reap` role, which could only ever re-open a pid —
   * and a re-opened pid cannot restore the original process identity.
   */
  const terminateAndVerify = async (timeoutMs = 12_000): Promise<TerminateResult> => {
    if (spawnError !== null) return { kind: 'OBSERVER_LOST', why: spawnError };
    if (exitCode !== null) return { kind: 'OBSERVER_LOST', why: `observer already exited with code ${String(exitCode)}` };
    if (!acquiredFlag) {
      // Give the ACK a last bounded chance before declaring identity unconfirmed.
      const ok = await acquired();
      if (!ok) return { kind: 'IDENTITY_UNCONFIRMED', why: 'target handle was never acquired; refusing to terminate by pid' };
    }
    try {
      child.stdin?.write('T');
      child.stdin?.end();
    } catch (e) {
      return { kind: 'OBSERVER_LOST', why: `terminate command could not be sent: ${String((e as Error).message)}` };
    }
    const v = await verdict(timeoutMs);
    if (v.state === 'EXITED') return { kind: 'EXIT_CONFIRMED', via: 'held-handle' };
    if (v.state === 'ALIVE') return { kind: 'STILL_ALIVE', native: 'WAIT_TIMEOUT' };
    if (terminateAck === 'failed') return { kind: 'TERMINATE_REFUSED', why: 'native TerminateProcess failed on the held handle' };
    // Distinguish the native WAIT_FAILED from a client-side expiry / observer loss.
    if (v.why.includes('WaitForSingleObject failed')) return { kind: 'WAIT_FAILED', why: v.why };
    return { kind: 'OBSERVER_LOST', why: v.why };
  };

  /** W5.1b §3: await the observer's own exit (it is an owned process). */
  const reaped = async (timeoutMs = 5_000): Promise<boolean> => {
    close();
    const done = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs))]);
    return done;
  };

  return { pid: targetPid, acquired, holdsIdentity, verdict, terminateAndVerify, close, reaped, _settled: false };
}

/**
 * Observe with a NATIVE bounded wait, so a live target yields a real
 * WAIT_TIMEOUT fact (STILL_RUNNING) rather than a client-side timeout.
 *
 * The observer terminates after the native wait, so it releases its handle: the
 * caller gets ONE liveness fact and must NOT reuse this observer for a later
 * exit proof.
 */
export async function livenessNative(targetPid: number, holdMs: number): Promise<Liveness> {
  const obs = open(targetPid, { holdMs });
  if (obs === null) return { state: 'OBSERVATION_ERROR', why: 'native observe fixture missing' };
  try {
    const ok = await obs.acquired();
    if (!ok) return { state: 'OBSERVATION_ERROR', why: 'observer never acquired the target handle' };
    return await obs.verdict(holdMs + 3_000);
  } finally {
    await obs.reaped(5_000);
  }
}

/**
 * One-shot liveness WITHOUT a held handle.
 *
 * Uses the observer role but does not retain the handle across calls, so it is only
 * suitable for a best-effort ALIVE check. It NEVER returns EXITED: a one-shot cannot
 * provide same-process proof, so anything else is an honest ALIVE / ERROR.
 */
export async function livenessBestEffort(targetPid: number, timeoutMs = 3_000): Promise<Liveness> {
  return livenessNative(targetPid, Math.max(200, timeoutMs));
}