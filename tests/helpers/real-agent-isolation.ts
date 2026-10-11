/**
 * tests/helpers/real-agent-isolation.ts — OWNERSHIP primitive for opt-in real-agent tests.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 * Real-agent tests start real processes that write real containment artifacts. Two
 * hazards follow, and both were actually observed:
 *
 *  1. CROSS-RUN HAZARD. Containment control/stop artifacts live in ONE directory
 *     beside the DEPLOYED production launcher (`%LOCALAPPDATA%\orchestrator\
 *     containment-run`). Every concurrent contained run on the machine writes
 *     there, so a test that deletes it can destroy ANOTHER live run's control
 *     record. Reading it is nearly as bad: the test would read another run's
 *     record and could attribute it to itself, producing a false PASS.
 *
 *  2. SELF-LEAK HAZARD (the W4.4 P1). Cleanup written as a flat sequence after the
 *     work —
 *         setup(); await A(); await B(); cleanup();
 *     — only runs on the happy path. Any throw from A or B skips cleanup entirely,
 *     leaving launcher copies, control records, stop markers, workspaces and env
 *     overrides behind, and the NEXT run inherits them.
 *
 * THE MODEL: EXPLICIT OWNERSHIP
 * Each test gets ONE unique root. Everything it creates lives underneath, so
 * cleanup is a single unambiguous recursive delete of a path the test created and
 * nobody else can name. Nothing is ever globbed, and nothing outside the root is
 * ever touched:
 *
 *   <temp>/orchestrator-real-agent/<run-id>/
 *     launcher/w1joblauncher.exe     byte-identical copy of the deployed binary
 *     launcher/containment-run/      THIS test's control + stop artifacts only
 *     workspace/  repo/  store/       per-run working state
 *
 * Setup is TRANSACTIONAL: it records each resource as it is created and, if any
 * step throws, removes what it already made before rethrowing. A caller therefore
 * never has to hold a context in order to be able to clean up.
 *
 * CLEANUP NEVER STOPS EARLY: each resource is removed independently, failures are
 * collected rather than swallowed, and the caller fails the test if any remain.
 *
 * This is a TEST helper. It is NOT a production authority: it owns no process, no
 * resource claim, and no scheduling decision. It only deletes paths it created.
 */

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveContainmentLauncher } from '../../src/runtime/containment.ts';

/** Every real-agent test root lives under this parent, so leaks are identifiable. */
export const OWNED_ROOT_PARENT = 'orchestrator-real-agent';

/**
 * The root THIS process created, recorded the instant it is made.
 *
 * It is set BEFORE any injected failure and BEFORE launcher resolution, so a caller
 * can attribute the root to this run even when setup never returns a context
 * (the launcher-unavailable and setup-throw paths). The hygiene harness reads this
 * from the child's report to check ONLY the child's own root — never by enumerating
 * the parent directory, which could reach another run's root.
 */
let createdRoot: string | null = null;

/** The unique owned root this process created, or null if it created none. */
export function ownedRootOfThisProcess(): string | null {
  return createdRoot;
}

export interface CleanupFailure {
  readonly resource: string;
  readonly error: string;
}

export interface OwnedTestContext {
  /** The unique per-test root. Deleting THIS is the whole of filesystem cleanup. */
  readonly root: string;
  /** Test-owned launcher executable (byte-identical copy of the deployed one). */
  readonly launcherExe: string;
  /** Test-owned control directory. The ONLY control dir this test may read. */
  readonly controlDir: string;
  /** SHA256 of the copy; equals the deployed binary's hash by construction. */
  readonly sha256: string;
  /** Create (or return) an owned subdirectory, e.g. `workspace`, `repo`, `store`. */
  dir(name: string): string;
  /** Set an env var, remembering the EXACT previous value for restoration. */
  setEnv(name: string, value: string): void;
  /** Register a PID this test started, so cleanup can reap it if it survives. */
  trackProcess(pid: number | null | undefined): void;
  /** Exact current value of a managed env var (null when unset). */
  envNow(name: string): string | null;
  /** Remove every owned resource. Never throws; returns any failures. */
  cleanup(): Promise<CleanupFailure[]>;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Deliberate failure injection, used ONLY by the W4.4 hygiene harness.
 *
 * Normal execution never sets this, so the injected throw is absent from the real
 * test path (§8): a passing suite here and a passing suite in `test:real-agent`
 * exercise exactly the same code.
 */
function injected(stage: string): boolean {
  return process.env.ORCH_W4H_INJECT === stage;
}

function maybeInject(stage: string): void {
  if (injected(stage)) {
    throw new Error(`[W4.4 injected setup failure @ ${stage}]`);
  }
}

/**
 * Create an owned test context. TRANSACTIONAL: on any failure it removes what it
 * already created (including the env values it already set) and rethrows.
 *
 * Returns null when the production launcher is unavailable — an environment fact,
 * not a failure.
 */
export function setupOwnedTestContext(): OwnedTestContext | null {
  /* --- staged, ordered teardown. Each step runs even if an earlier one failed. --- */
  const envBackups = new Map<string, string | undefined>();
  const trackedPids = new Set<number>();
  let root: string | null = null;
  let tornDown = false;

  const teardown = (): CleanupFailure[] => {
    if (tornDown) return [];
    tornDown = true;
    const failures: CleanupFailure[] = [];

    /*
     * ORDER MATTERS (§6). Stop owned processes BEFORE removing the launcher or
     * control directory: a launcher that is still running can still be writing
     * control records, and deleting those out from under it turns a clean exit
     * into a wedged one.
     */
    for (const pid of trackedPids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        // ESRCH means it is already gone, which is the outcome we wanted.
        if (code !== 'ESRCH') failures.push({ resource: `pid ${pid}`, error: String((e as Error).message) });
      }
    }

    // Restore env BEFORE deleting files, so nothing re-resolves a now-missing path.
    for (const [name, previous] of envBackups) {
      try {
        // EXACT restoration (§3): an unset variable must be REMOVED, not set to a
        // placeholder; a previously-set variable must return its exact string. A
        // blanket `delete` would silently discard a user/parent value.
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      } catch (e) {
        failures.push({ resource: `env ${name}`, error: String((e as Error).message) });
      }
    }

    // Finally the one path this test unambiguously owns.
    if (root !== null) {
      try {
        if (existsSync(root)) {
          /*
           * W4.4 P1-B regression hook, OFF on the normal path. It makes the owned
           * root removal itself fail so the harness can prove that a cleanup failure
           * on the launcher-unavailable path is PROPAGATED rather than swallowed.
           * The root is deliberately left on disk; the regression test removes it as
           * fixture cleanup afterwards, so no unremovable directory is left behind.
           */
          if (process.env.ORCH_W4H_FAIL_ROOT_RM === '1') {
            const injected = new Error('injected: owned root removal failed (EBUSY)') as NodeJS.ErrnoException;
            injected.code = 'EBUSY';
            throw injected;
          }
          rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        }
      } catch (e) {
        failures.push({ resource: `root ${root}`, error: String((e as Error).message) });
      }
    }
    return failures;
  };

  try {
    // ---- stage: root -------------------------------------------------------
    const parent = join(tmpdir(), OWNED_ROOT_PARENT);
    mkdirSync(parent, { recursive: true });
    root = mkdtempSync(join(parent, 'w44-'));
    // Register IMMEDIATELY: attribution must survive a failure at any later stage,
    // including the launcher-unavailable branch below, which never returns a context.
    createdRoot = root;
    const ownedRoot = root;
    maybeInject('root');

    // ---- stage: launcher copy ---------------------------------------------
    const deployed = resolveContainmentLauncher();
    if (deployed === null || !existsSync(deployed.exe)) {
      /*
       * W4.4 P1-B: an unavailable launcher is an environment fact, but a cleanup
       * FAILURE on the way out is not. Discarding the failures here would let a
       * leaked owned root exit 0, which is exactly the swallowed error this branch
       * used to have. Clean teardown => null (environment-unavailable contract);
       * failed teardown => throw, so the caller and the shell exit non-zero.
       */
      const failures = teardown();
      if (failures.length > 0) {
        throw new Error(
          `launcher unavailable AND cleanup failed: ${failures.map((f) => `${f.resource}: ${f.error}`).join('; ')}`,
        );
      }
      return null;
    }
    const launcherDir = join(ownedRoot, 'launcher');
    mkdirSync(launcherDir, { recursive: true });
    const launcherExe = join(launcherDir, 'w1joblauncher.exe');
    cpSync(deployed.exe, launcherExe);
    const copyHash = sha256(launcherExe);
    if (copyHash !== sha256(deployed.exe)) {
      // A copy that is not byte-identical would silently test a DIFFERENT launcher.
      throw new Error(`isolated launcher copy is not byte-identical (${copyHash})`);
    }
    maybeInject('launcher');

    // The launcher's control directory is derived from ITS OWN directory, so this
    // is this test's control dir by construction — never the production one.
    const controlDir = join(launcherDir, 'containment-run');

    const ctx: OwnedTestContext = {
      root: ownedRoot,
      launcherExe,
      controlDir,
      sha256: copyHash,
      dir(name: string): string {
        const p = join(ownedRoot, name);
        mkdirSync(p, { recursive: true });
        maybeInject(`dir:${name}`);
        return p;
      },
      setEnv(name: string, value: string): void {
        // Record the value only on FIRST touch, so a second set still restores the
        // original rather than this test's own intermediate value.
        if (!envBackups.has(name)) envBackups.set(name, process.env[name]);
        process.env[name] = value;
      },
      trackProcess(pid: number | null | undefined): void {
        if (pid !== null && pid !== undefined && Number.isInteger(pid) && pid > 0) trackedPids.add(pid);
      },
      envNow(name: string): string | null {
        return process.env[name] ?? null;
      },
      async cleanup(): Promise<CleanupFailure[]> {
        return teardown();
      },
    };

    // ---- stage: env -------------------------------------------------------
    // An explicit ORCH_JOB_LAUNCHER is AUTHORITATIVE in production resolution, so
    // pointing it at the copy is what confines control artifacts to this test.
    ctx.setEnv('ORCH_JOB_LAUNCHER', launcherExe);
    // Retain THIS test's control records so the launcher's real `terminated` status
    // can be asserted. They are beside the copy, so they are ours alone.
    ctx.setEnv('ORCH_KEEP_CONTROL', '1');
    maybeInject('env');

    maybeInject('ready');
    return ctx;
  } catch (error) {
    // Setup must not require the caller to already hold a context in order to be
    // able to clean up (§5): undo everything created so far, then rethrow.
    const failures = teardown();
    if (failures.length > 0) {
      throw new Error(
        `${String((error as Error).message)}; ADDITIONALLY setup cleanup failed: ` +
          failures.map((f) => `${f.resource}: ${f.error}`).join('; '),
      );
    }
    throw error;
  }
}

/**
 * Run `body` under an owned context, guaranteeing cleanup on EVERY exit path.
 *
 * This is the shape every real-agent suite uses (§4):
 *
 *     const owned = setupOwnedTestContext();
 *     try { await runTest(); } finally { await owned.cleanup(); }
 *
 * `runTest` may throw freely: the finally still disposes everything, and the
 * original error is preserved rather than replaced by a cleanup error.
 */
export async function withOwnedTestContext(
  label: string,
  body: (ctx: OwnedTestContext) => Promise<void>,
): Promise<CleanupFailure[]> {
  const owned = setupOwnedTestContext();
  if (owned === null) {
    console.log(`${label}: BLOCKED (no production launcher on this machine)`);
    return [];
  }
  let bodyError: unknown;
  let failures: CleanupFailure[] = [];
  try {
    await body(owned);
  } catch (e) {
    bodyError = e;
  } finally {
    // cleanup() never throws, so a cleanup failure cannot mask `bodyError`.
    failures = await owned.cleanup();
  }
  // The body's error is the more informative one; surface it unchanged.
  if (bodyError !== undefined) throw bodyError;
  return failures;
}

/**
 * Read the launcher control records THIS test owns.
 *
 * The control directory comes from the owned context, so a test physically cannot
 * read the production one through this API. Records are UTF-16LE key=value pairs.
 */
export function readOwnedControlFacts(ctx: OwnedTestContext): Record<string, string>[] {
  let names: string[];
  try {
    if (!existsSync(ctx.controlDir)) return [];
    names = readdirSync(ctx.controlDir).filter((f) => f.endsWith('.txt'));
  } catch {
    return [];
  }
  const out: Record<string, string>[] = [];
  for (const n of names) {
    try {
      const txt = readFileSync(join(ctx.controlDir, n)).toString('utf16le');
      const facts: Record<string, string> = {};
      for (const line of txt.split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) facts[line.slice(0, i)] = line.slice(i + 1);
      }
      out.push(facts);
    } catch {
      // A record still being written is not an error; it simply has no facts yet.
    }
  }
  return out;
}

/** The most recent owned control record's facts (empty when none exist). */
export function latestOwnedControlFacts(ctx: OwnedTestContext): Record<string, string> {
  const all = readOwnedControlFacts(ctx);
  return all.length === 0 ? {} : all[all.length - 1]!;
}

/**
 * Find the LIVE containment run among this test's OWNED control records.
 *
 * A dispatched task can produce more than one control record, so "the last file"
 * is not a reliable way to identify the current run: it can name a record for a run
 * that already finished, or one that never carried a root pid. Selecting by
 * OBSERVED LIVENESS — not by filename order — is what makes this robust without
 * assuming how many records a run writes.
 *
 * PID facts come only from owned control records; there is deliberately no
 * whole-system process scan, because that could adopt an unrelated process and make
 * the assertions below meaningless.
 */
export function findLiveOwnedRun(
  ctx: OwnedTestContext,
  isAlive: (pid: number) => boolean,
): { launcherPid: number | null; rootPid: number | null } {
  let fallback: { launcherPid: number | null; rootPid: number | null } = { launcherPid: null, rootPid: null };
  for (const facts of readOwnedControlFacts(ctx)) {
    const lp = facts['launcherPid'] ? Number(facts['launcherPid']) : null;
    const rp = facts['rootPid'] ? Number(facts['rootPid']) : null;
    if (lp === null && rp === null) continue;
    const cand = { launcherPid: lp, rootPid: rp };
    if (fallback.rootPid === null) fallback = cand;
    if (rp !== null && isAlive(rp)) return cand;
  }
  return fallback;
}

/** Is a pid still running? EPERM means it exists but belongs to another user. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Publish this process's final env + the escaping error for the W4.4 hygiene
 * harness, which asserts EXACT restoration from the outside.
 *
 * Written in a `finally` so it is produced on every exit path, and written LAST so
 * it reflects the state after cleanup. Best-effort: if the harness did not ask for
 * a report, this is a no-op.
 */
export function writeHygieneReport(thrown?: unknown): void {
  const target = process.env.ORCH_W4H_REPORT;
  if (target === undefined || target === '') return;
  try {
    writeFileSync(
      target,
      JSON.stringify({
        env: {
          ORCH_JOB_LAUNCHER: process.env.ORCH_JOB_LAUNCHER ?? null,
          ORCH_KEEP_CONTROL: process.env.ORCH_KEEP_CONTROL ?? null,
        },
        // The exact root this process created (if any), so the harness can check
        // THIS run's leftovers by path instead of enumerating the shared parent.
        ownedRoot: ownedRootOfThisProcess(),
        thrown: thrown === undefined ? null : String((thrown as Error)?.message ?? thrown),
      }),
    );
  } catch {
    // A hygiene report must never change the outcome of the suite under test.
  }
}

/**
 * Compute the exit code for an opt-in suite: non-zero when any REQUIRED assertion
 * failed, and non-zero when cleanup itself failed (§19 / W4H-6).
 *
 * The code is RETURNED rather than assigned here, so each suite states
 * `process.exitCode = finish(...)` explicitly. That keeps these opt-in suites under
 * the same harness guard as every other suite (`tests/tick-outcome-contract.test.ts`
 * §CONTRACT 4), which requires a suite to visibly propagate failure to its exit code
 * rather than hide it behind a helper.
 */
export function finish(
  results: Array<{ verdict: string }>,
  options?: { allowEnvironmentBlocked?: boolean; cleanupFailures?: CleanupFailure[] },
): number {
  const allowEnv = options?.allowEnvironmentBlocked ?? false;
  const assertionFailed = results.some(
    (r) => r.verdict === 'FAIL' || (r.verdict === 'SKIP' && !allowEnv),
  );
  const cleanupFailed = (options?.cleanupFailures ?? []).length > 0;
  return assertionFailed || cleanupFailed ? 1 : 0;
}
