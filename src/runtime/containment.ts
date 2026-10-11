/**
 * runtime/containment.ts — the production control channel for Windows Job
 * containment.
 *
 * WHAT THIS IS
 * A small, pure runtime utility. It knows how to (a) find the sealed W1 launcher,
 * (b) place a control file on a volume the launcher can actually write, (c) wrap a
 * resolved `(command, argv)` into a launcher invocation, and (d) read back and
 * VALIDATE the launcher's control record into containment facts.
 *
 * WHAT THIS IS NOT
 * Not an authority. It owns no process, no session, no schedule, no retry policy.
 * `new authority = 0`. It is the same kind of thing as `launcher.ts`: pure
 * resolution + a value. The OS containment itself lives entirely in the sealed
 * `w1joblauncher.exe` (see docs/WINDOWS_PROCESS_CONTAINMENT_ARCHITECTURE_AUDIT.md).
 *
 * WHY A CONTROL FILE AND NOT stdout
 * stdout/stderr belong to the target agent's transport. Launcher status therefore
 * travels through `--diag`, which in production is MANDATORY: without it the
 * runtime cannot learn the real root PID, the real root exit code, or whether the
 * tree actually stopped, so a contained run without a control file is refused
 * rather than run blind.
 *
 * PID SEMANTICS (the W2 hard interface)
 * The launcher is what Node spawns, so `child.pid` is the LAUNCHER pid. The agent
 * ROOT pid is a different process and is only knowable from the control record.
 * This module keeps those two facts apart and never conflates them.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { LauncherSpec } from '../core/types.ts';
import { buildLaunchArgv, buildCmdRawCommandLine } from './launcher.ts';
import { log } from '../core/log.ts';

/** Where the sealed launcher is built, relative to the repository root. */
const LAUNCHER_RELATIVE = join('native', 'windows-job-launcher', 'build', 'w1joblauncher.exe');

/** Sub-directory, next to the launcher, where per-execution control files live. */
const CONTROL_SUBDIR = 'containment-run';

export interface ResolvedLauncher {
  /** Absolute path to w1joblauncher.exe. */
  readonly exe: string;
  /** Directory holding it; control files are placed beside it (same volume). */
  readonly dir: string;
}

function repoRoot(): string {
  // src/runtime/containment.ts -> src/runtime -> src -> repo
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * The stable per-user deployment location for the launcher.
 *
 * WHY THIS EXISTS AT ALL (and why it is preferred over the repo-local build):
 * on this workstation, a process is confined to the volume its executable lives
 * on — a process descended from a `D:`-located launcher is DENIED writes to
 * `C:` (verified: `EPERM` writing `%TEMP%`), even when the child itself is
 * `node.exe` on `C:`. Real agents write to their own home/config/temp on `C:`
 * (for example `~/.codex`), so a `D:`-located launcher silently breaks them.
 *
 * A launcher on the system volume has NO such restriction: its descendants can
 * write BOTH `C:` and `D:`. Deployment is therefore a plain copy of the sealed
 * binary to a per-user path — not an installer, and the binary is unchanged.
 */
function deployedLauncherPath(): string | null {
  const base = process.env.LOCALAPPDATA;
  if (!base || base === '') return null;
  return join(base, 'orchestrator', 'w1joblauncher.exe');
}

/**
 * Locate the launcher. Preference order:
 *   1. explicit `ORCH_JOB_LAUNCHER`
 *   2. the deployed per-user copy on the system volume (removes the write
 *      confinement that a repo-on-`D:` build would impose on agents)
 *   3. the repo-local build output (works only when the repo volume is the one
 *      the agents must write; a warning is logged)
 *
 * Returns null when none exists — the caller MUST fail closed; there is no
 * uncontained fallback for a contained run.
 */
export function resolveContainmentLauncher(): ResolvedLauncher | null {
  // An explicit override is AUTHORITATIVE: if it is set but does not exist, that
  // is a configuration error and we fail closed rather than silently falling back
  // to a different binary. This is also the seam tests use to exercise the
  // "launcher missing" path deterministically.
  const override = process.env.ORCH_JOB_LAUNCHER;
  if (override && override !== '') {
    return existsSync(override) ? { exe: override, dir: dirname(override) } : null;
  }

  const candidates: string[] = [];
  const deployed = deployedLauncherPath();
  if (deployed !== null) candidates.push(deployed);
  candidates.push(expectedLauncherPath());

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    if (existsSync(c)) {
      // The last candidate is the repo-local build. Using it means agents are
      // confined to the repo's volume, which only works when everything they
      // must write lives there too. Surface that rather than let it fail later.
      if (i === candidates.length - 1 && candidates.length > 1) {
        log.warn('containment launcher is repo-local; agents may be denied writes outside its volume', { exe: c });
      }
      return { exe: c, dir: dirname(c) };
    }
  }
  return null;
}

/**
 * Is containment meant to apply to this process?
 *
 * Windows-only by design (this is a personal Windows tool; no cross-platform
 * abstraction). Containment is MANDATORY on Windows production: there is
 * deliberately NO environment opt-out, because an inherited environment variable
 * must not be able to silently disable the containment guarantee for a real run.
 * (A test-only seam, if ever needed, must be explicit dependency injection, not
 * ambient env.)
 */
export function containmentEnabled(): boolean {
  return process.platform === 'win32';
}

/**
 * The directory control files are created in.
 *
 * Deliberately NEXT TO THE LAUNCHER, not `%TEMP%`. This workstation has been
 * shown to deny a `D:`-located process write access to `C:`, and `%TEMP%` is on
 * `C:`. The launcher binary and its control files therefore always share a
 * volume that the launcher process can demonstrably write, wherever the launcher
 * happens to be installed.
 */
export function controlDirectory(launcher: ResolvedLauncher): string {
  return join(launcher.dir, CONTROL_SUBDIR);
}

/** A unique, unshared control-file path for ONE execution. */
export function createControlPath(launcher: ResolvedLauncher): string {
  const dir = controlDirectory(launcher);
  mkdirSync(dir, { recursive: true });
  return join(dir, `w1ctl-${process.pid}-${randomUUID().slice(0, 12)}.txt`);
}

/**
 * The per-run cooperative-stop marker path for ONE execution.
 *
 * W3. Sits in the SAME per-run control directory as the control file, for the
 * same volume reason, and is unique per run so one execution can never signal
 * another.
 *
 * The signal is the file's mere EXISTENCE. That is deliberately the crudest thing
 * that works: it is atomic enough (a created file is a created file), it needs no
 * content parsing, it cannot be half-written into a state that reads as a
 * different request, and it leaves nothing for a launcher to consume and then
 * leak into the next run.
 */
export function createStopPath(controlPath: string): string {
  return controlPath.replace(/\.txt$/i, '') + '.stop';
}

/**
 * Ask the launcher to terminate this run's Job.
 *
 * Creating the marker is the WHOLE protocol. It does not claim anything: the
 * launcher still has to terminate the Job and still has to positively observe
 * `ActiveProcesses == 0` before any stop may be believed.
 *
 * Returns false only when the request could not even be delivered, which the
 * caller must treat as "no request reached the launcher" — not as a stop.
 */
export function requestContainedStop(stopPath: string): boolean {
  try {
    writeFileSync(stopPath, 'stop\n', { flag: 'w' });
    return true;
  } catch (e) {
    log.warn('containment stop request could not be delivered', {
      stopPath,
      error: (e as Error).message,
    });
    return false;
  }
}

/**
 * Wrap a resolved launcher spec + its args into the launcher invocation:
 *
 *   w1joblauncher.exe --diag <control> -- <command> <argv...>
 *
 * `--diag` is passed unconditionally: in production the control channel is
 * mandatory. The `--` boundary is the sealed W1.2 grammar, so nothing in the
 * agent's own argv can be mistaken for a launcher option.
 */
export function buildContainedArgv(
  spec: LauncherSpec,
  args: readonly string[],
  controlPath: string,
  stopPath?: string,
): string[] {
  // W3: `--stop` is a launcher option and is passed BEFORE the sealed `--`
  // boundary, so it can never be confused with the agent's own argv.
  const head = stopPath === undefined
    ? ['--diag', controlPath]
    : ['--diag', controlPath, '--stop', stopPath];
  if (spec.buildsCommandString) {
    // cmd-wrapper: the launcher's target is cmd.exe and the command STRING is a
    // single pre-built line delivered verbatim (see buildCmdRawCommandLine).
    const rawLine = buildCmdRawCommandLine(spec, args);
    return [...head, '--raw', '--', spec.command, rawLine];
  }
  const targetArgv = buildLaunchArgv(spec, args);
  return [...head, '--', spec.command, ...targetArgv];
}

// ---------------------------------------------------------------------------
// Control record
// ---------------------------------------------------------------------------

/** The validated facts a completed control record carries. */
export interface ContainmentRecord {
  readonly complete: boolean;
  readonly launcherStatus: string;
  readonly phase: string | null;
  readonly win32Error: number | null;
  readonly launcherPid: number | null;
  readonly rootPid: number | null;
  readonly rootExitCode: number | null;
  readonly rootExitObserved: boolean;
  readonly treeStopped: boolean;
  readonly activeProcessesFinal: number | null;
  readonly assignedBeforeResume: boolean;
}

export type RecordValidation =
  | { readonly ok: true; readonly record: ContainmentRecord }
  | { readonly ok: false; readonly reason: string };

/** Decode a control file. It is UTF-16LE without a BOM; detect by NUL density. */
function decodeControl(raw: Buffer): string {
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) return raw.toString('utf16le');
  let zeros = 0;
  for (let i = 0; i < raw.length; i++) if (raw[i] === 0) zeros++;
  return zeros > raw.length / 4 ? raw.toString('utf16le') : raw.toString('utf8');
}

/**
 * Split into COMPLETE, newline-terminated lines only.
 *
 * A torn tail (`rootPid=12` with no newline yet, mid-write) is NOT a line and is
 * ignored. This is what stops the live parser from caching a numeric PREFIX of a
 * larger value written moments later (`rootPid=123456`).
 */
function completeLines(text: string): string[] {
  let body = text;
  if (!body.endsWith('\n')) {
    const i = body.lastIndexOf('\n');
    if (i < 0) return [];
    body = body.slice(0, i + 1);
  }
  return body.split('\n').filter((l) => l !== '');
}

/**
 * A STRICT decimal field parser. This is a machine-fact channel, not a
 * convenience layer: `Number('')` is 0, `Number(' 1 ')` is 1, `Number('0x10')` is
 * 16 and `Number('1e3')` is 1000 — none of which a launcher ever writes, and all
 * of which could fabricate a success fact. Only bare decimal digits are accepted.
 */
function strictDecimal(
  v: string | undefined,
  opts: { min: number; max?: number },
): number | null {
  if (v === undefined || v === '') return null;
  if (!/^[0-9]+$/.test(v)) return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n)) return null;
  if (n < opts.min) return null;
  if (opts.max !== undefined && n > opts.max) return null;
  return n;
}

/** A Win32 DWORD range (exit codes / error codes). */
const DWORD_MAX = 4294967295;

/*
 * The launcher's protocol vocabulary, taken DIRECTLY from the C producer
 * (`native/windows-job-launcher/src/w1joblauncher.c`). An unknown value is an
 * INVALID record, never accepted.
 */
const LAUNCHER_STATUSES = new Set<string>([
  'success',
  'terminated',
  'stop-unconfirmed',
  'job-create-failed',
  'job-configure-failed',
  'create-process-failed',
  'assign-failed',
  'resume-failed',
  'accounting-failed',
  'cmdline-too-long',
  'cmdline-overflow',
  'cmdline-oom',
  'internal-error',
  'usage-error',
]);

const LAUNCHER_PHASES = new Set<string>([
  'create-job',
  'configure-job',
  'create-process',
  'assign',
  'resume',
  'wait',
  'done',
]);

/**
 * The status → phase contract, and which root facts each status may/must carry.
 *
 * This is the producer's state machine, not a guess:
 *   - before CreateProcessW succeeds the root does not exist, so NO root facts
 *     may appear (`rootPid`, `rootExitCode`, `treeStopped`, `activeProcessesFinal`);
 *   - after the root exists but before it exits, `rootPid` is present but a root
 *     EXIT fact may not be;
 *   - only `success` may claim a confirmed tree stop.
 */
interface StatusPolicy {
  readonly phases: readonly string[];
  readonly requireRootPid: boolean;
  readonly forbidRootPid: boolean;
  /** Forbids ANY root-exit fact: rootExitObserved AND rootExitCode. */
  readonly forbidRootExit: boolean;
  /** Forbids ANY tree-stop fact: treeStopped AND activeProcessesFinal. */
  readonly forbidTreeStop: boolean;
  /** Requires assignedBeforeResume=1 (the assign-before-resume ordering held). */
  readonly requireAssignedBeforeResume: boolean;
}

/*
 * Frozen from the actual producer (`w1joblauncher.c`). Notes that are easy to get
 * WRONG by guessing:
 *   - `assign-failed` / `resume-failed` DO carry `rootPid` (the root was created)
 *     but NO root-exit fact (the root never ran to completion).
 *   - `accounting-failed` is written mid-wait, but the code then falls through to
 *     `phase=done`, so its LAST phase is `done` (not `wait`).
 *   - everything before CreateProcessW succeeds must carry NO root facts at all.
 */
const STATUS_POLICY: Readonly<Record<string, StatusPolicy>> = Object.freeze({
  success: { phases: ['done'], requireRootPid: true, forbidRootPid: false, forbidRootExit: false, forbidTreeStop: false, requireAssignedBeforeResume: true },
  /*
   * W3 `terminated`: the launcher terminated the Job ON THE PARENT'S REQUEST and
   * then POSITIVELY confirmed ActiveProcesses == 0. It carries the SAME physical
   * proof as `success` (treeStopped=1, activeProcessesFinal=0) and must satisfy
   * the SAME strict checks below, because the proof is identical.
   *
   * It is deliberately NOT a substitute for `success`: it says the tree was
   * physically stopped on request, NOT that the agent ran to completion. A
   * consumer that reports "the agent finished" off a `terminated` record is
   * reading a cancellation as a success.
   */
  terminated: { phases: ['done'], requireRootPid: true, forbidRootPid: false, forbidRootExit: false, forbidTreeStop: false, requireAssignedBeforeResume: true },
  /*
   * W3 `stop-unconfirmed`: the parent asked for a stop and the launcher could not
   * confirm the Job empty. `forbidTreeStop` makes any `treeStopped` /
   * `activeProcessesFinal` in such a record INVALID, which is the point: an
   * unconfirmed stop must carry no claim at all, so the consumer keeps physical
   * protection rather than releasing it on the strength of a termination request.
   */
  'stop-unconfirmed': { phases: ['done'], requireRootPid: true, forbidRootPid: false, forbidRootExit: false, forbidTreeStop: true, requireAssignedBeforeResume: true },
  'job-create-failed': { phases: ['create-job'], requireRootPid: false, forbidRootPid: true, forbidRootExit: true, forbidTreeStop: true, requireAssignedBeforeResume: false },
  'job-configure-failed': { phases: ['configure-job'], requireRootPid: false, forbidRootPid: true, forbidRootExit: true, forbidTreeStop: true, requireAssignedBeforeResume: false },
  'create-process-failed': { phases: ['create-process'], requireRootPid: false, forbidRootPid: true, forbidRootExit: true, forbidTreeStop: true, requireAssignedBeforeResume: false },
  'assign-failed': { phases: ['assign'], requireRootPid: true, forbidRootPid: false, forbidRootExit: true, forbidTreeStop: true, requireAssignedBeforeResume: false },
  'resume-failed': { phases: ['resume'], requireRootPid: true, forbidRootPid: false, forbidRootExit: true, forbidTreeStop: true, requireAssignedBeforeResume: false },
  'accounting-failed': { phases: ['done'], requireRootPid: true, forbidRootPid: false, forbidRootExit: false, forbidTreeStop: true, requireAssignedBeforeResume: false },
  'cmdline-too-long': { phases: ['create-job'], requireRootPid: false, forbidRootPid: true, forbidRootExit: true, forbidTreeStop: true, requireAssignedBeforeResume: false },
  'cmdline-overflow': { phases: ['create-job'], requireRootPid: false, forbidRootPid: true, forbidRootExit: true, forbidTreeStop: true, requireAssignedBeforeResume: false },
  'cmdline-oom': { phases: ['create-job'], requireRootPid: false, forbidRootPid: true, forbidRootExit: true, forbidTreeStop: true, requireAssignedBeforeResume: false },
  'internal-error': { phases: ['create-job', 'create-process'], requireRootPid: false, forbidRootPid: false, forbidRootExit: true, forbidTreeStop: true, requireAssignedBeforeResume: false },
  'usage-error': { phases: ['create-job'], requireRootPid: false, forbidRootPid: true, forbidRootExit: true, forbidTreeStop: true, requireAssignedBeforeResume: false },
});

/** A strict control boolean: ONLY the literal contract values `0` / `1`. */
interface BoolParse { readonly present: boolean; readonly value: boolean; readonly valid: boolean; }
function strictBool(v: string | undefined): BoolParse {
  if (v === undefined) return { present: false, value: false, valid: true };
  if (v === '1') return { present: true, value: true, valid: true };
  if (v === '0') return { present: true, value: false, valid: true };
  return { present: true, value: false, valid: false };
}

/**
 * Read and VALIDATE a control record.
 *
 * Never "trust whatever exists". A partial / malformed / missing record returns a
 * failure, and the caller must treat containment evidence as absent — never as
 * success. This is the difference between an honest `treeStopConfirmed=false` and
 * a fabricated `true`.
 */
export function readControlRecord(controlPath: string): RecordValidation {
  if (!existsSync(controlPath)) {
    return { ok: false, reason: 'control file missing' };
  }
  let text: string;
  try {
    text = decodeControl(readFileSync(controlPath));
  } catch (e) {
    return { ok: false, reason: `control file unreadable: ${(e as Error).message}` };
  }

  const kv = new Map<string, string>();
  // Only COMPLETE lines are trusted; a torn tail is not a fact.
  for (const raw of completeLines(text)) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const eq = line.indexOf('=');
    if (eq > 0) kv.set(line.slice(0, eq), line.slice(eq + 1));
  }

  // complete=1 is the ONLY thing that makes a record final.
  if (kv.get('complete') !== '1') {
    return { ok: false, reason: 'control record not marked complete' };
  }
  const launcherStatus = kv.get('launcherStatus');
  if (launcherStatus === undefined || launcherStatus === '') {
    return { ok: false, reason: 'control record has no launcherStatus' };
  }
  const phase = kv.get('phase') ?? null;
  if (phase === null) {
    return { ok: false, reason: 'control record has no phase' };
  }

  // ---- protocol validation: status, phase, and fact consistency -------------

  if (!LAUNCHER_STATUSES.has(launcherStatus)) {
    return { ok: false, reason: `unknown launcherStatus "${launcherStatus}"` };
  }
  if (!LAUNCHER_PHASES.has(phase)) {
    return { ok: false, reason: `unknown or empty phase "${phase}"` };
  }
  const policy = STATUS_POLICY[launcherStatus]!;
  if (!policy.phases.includes(phase)) {
    return { ok: false, reason: `phase "${phase}" is not valid for launcherStatus "${launcherStatus}"` };
  }

  const rRootPid = strictDecimal(kv.get('rootPid'), { min: 1 });
  const rRootExit = strictDecimal(kv.get('rootExitCode'), { min: 0, max: DWORD_MAX });
  const rActive = strictDecimal(kv.get('activeProcessesFinal'), { min: 0 });
  const bRootExit = strictBool(kv.get('rootExitObserved'));
  const bTreeStopped = strictBool(kv.get('treeStopped'));
  const bAssigned = strictBool(kv.get('assignedBeforeResume'));

  // Boolean-like facts accept ONLY the contract values 0 / 1. `2`, `-1`, `true`,
  // `yes` are INVALID records, not "truthy".
  if (!bRootExit.valid || !bTreeStopped.valid || !bAssigned.valid) {
    return { ok: false, reason: 'a boolean-like control fact has a non-contract value' };
  }

  // Reject presences that contradict the producer state machine. A record is not
  // "mostly valid, extra fields ignored": a contradictory fact is INVALID.
  if (policy.forbidRootPid && rRootPid !== null) {
    return { ok: false, reason: `${launcherStatus} must not carry rootPid` };
  }
  if (policy.requireRootPid && rRootPid === null) {
    return { ok: false, reason: `${launcherStatus} requires a valid rootPid` };
  }
  // A root-exit fact is BOTH rootExitObserved and rootExitCode; forbidding one
  // without the other was the P1 that let `create-process-failed + rootExitObserved=1`
  // through. Neither may appear where the root never ran.
  if (policy.forbidRootExit && (bRootExit.present || rRootExit !== null)) {
    return { ok: false, reason: `${launcherStatus} must not carry a root exit fact` };
  }
  if (policy.forbidTreeStop && (bTreeStopped.present || rActive !== null)) {
    return { ok: false, reason: `${launcherStatus} must not carry a tree-stop fact` };
  }
  // Root-exit PAIR invariant: the observation and the code travel together or not
  // at all. This closes "rootExitObserved=0 + rootExitCode=103" (an exit code with
  // no observed exit) and "rootExitObserved=1 with no code".
  if (rRootExit !== null && !(bRootExit.present && bRootExit.value)) {
    return { ok: false, reason: 'rootExitCode present without rootExitObserved=1' };
  }
  if (bRootExit.present && bRootExit.value && rRootExit === null) {
    return { ok: false, reason: 'rootExitObserved=1 without a valid rootExitCode' };
  }
  if (policy.requireAssignedBeforeResume && !(bAssigned.present && bAssigned.value)) {
    return { ok: false, reason: `${launcherStatus} requires assignedBeforeResume=1` };
  }

  // A CONFIRMED containment outcome MUST carry the facts the runtime depends on,
  // parsed strictly, and must actually report the Job empty. `success` and
  // `terminated` are the only two statuses that may do so, and they must satisfy
  // the identical bar: both claim the same PHYSICAL evidence, and neither may be
  // relaxed because one of them came from a cancellation.
  if (launcherStatus === 'success' || launcherStatus === 'terminated') {
    if (rRootPid === null) return { ok: false, reason: `${launcherStatus} record has no valid rootPid` };
    if (rActive === null) return { ok: false, reason: `${launcherStatus} record has no valid activeProcessesFinal` };
    if (!bTreeStopped.value) return { ok: false, reason: `${launcherStatus} record does not report treeStopped=1` };
    if (rActive !== 0) return { ok: false, reason: `${launcherStatus} record does not report activeProcessesFinal=0` };
  }
  /*
   * W2 (SEALED, not relaxed): a NATURAL completion must carry the agent's real
   * exit. `success` means the agent ran and chose its own exit code, so
   * `rootExitObserved=1` plus a valid `rootExitCode` is mandatory.
   *
   * `terminated` is explicitly EXEMPT, and that asymmetry is the whole point: a
   * cooperative stop may kill the tree before the root's exit is ever observed.
   * Requiring a root exit code there would either reject an honest record or, far
   * worse, tempt a caller to fabricate one. Physical stop evidence and agent
   * exit outcome are separate facts and each is required only where it exists.
   */
  if (launcherStatus === 'success') {
    if (rRootExit === null) return { ok: false, reason: 'success record has no valid rootExitCode' };
    if (!(bRootExit.present && bRootExit.value)) return { ok: false, reason: 'success record does not report rootExitObserved=1' };
  }

  const record: ContainmentRecord = {
    complete: true,
    launcherStatus,
    phase,
    win32Error: strictDecimal(kv.get('win32Error'), { min: 0, max: DWORD_MAX }),
    launcherPid: strictDecimal(kv.get('launcherPid'), { min: 1 }),
    rootPid: rRootPid,
    rootExitCode: rRootExit,
    rootExitObserved: bRootExit.value,
    treeStopped: bTreeStopped.value,
    activeProcessesFinal: rActive,
    assignedBeforeResume: bAssigned.present && bAssigned.value,
  };

  return { ok: true, record };
}

/**
 * The statuses whose contract asserts a CONFIRMED physical tree stop.
 *
 * `success` = the agent ran and the Job then emptied on its own.
 * `terminated` = the parent asked, the launcher terminated the Job, and the Job
 * was then observed empty.
 *
 * Both are evidence about the OS, not about intent. `stop-unconfirmed` is
 * deliberately absent: it is the honest "we asked and could not prove it" answer,
 * and admitting it here would be exactly the fail-open this whole round exists to
 * prevent.
 */
const CONFIRMED_STOP_STATUSES: ReadonlySet<string> = new Set(['success', 'terminated']);

/**
 * The real tree-stop truth, and ONLY from containment evidence.
 *
 * True requires ALL of: the record is complete, the launcher reported a status
 * whose contract asserts a confirmed stop, and the Job reported zero active
 * processes. Any other state — launcher killed, record incomplete, stop requested
 * but unconfirmed, status failure — is `false`/unknown, never optimistically true.
 */
export function treeStopConfirmedFrom(record: ContainmentRecord): boolean {
  return (
    record.complete &&
    CONFIRMED_STOP_STATUSES.has(record.launcherStatus) &&
    record.treeStopped &&
    record.activeProcessesFinal === 0
  );
}

/**
 * Did the launcher stop this tree because WE asked, rather than because the agent
 * finished? This is the agent-outcome question, kept apart from
 * {@link treeStopConfirmedFrom}, which is the physical-safety question.
 */
export function isCooperativeTermination(record: ContainmentRecord): boolean {
  return record.launcherStatus === 'terminated';
}

/** Remove a control file. Best-effort: a leftover file is harmless, a crash is not. */
export function removeControlFile(controlPath: string): void {
  try {
    rmSync(controlPath, { force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Remove a stop marker. Best-effort.
 *
 * Deliberately has NO effect on any physical truth: a marker that survives cleanup
 * can only ever re-assert a request the launcher has already honoured, so cleanup
 * failure can never turn into a claim that a tree stopped (or did not).
 */
export function removeStopFile(stopPath: string): void {
  try {
    rmSync(stopPath, { force: true });
  } catch {
    /* best effort */
  }
}

/** The path the launcher is expected at, whether or not it exists. Used to fail
 *  closed with a deterministic ENOENT rather than an uncontained fallback. */
export function expectedLauncherPath(): string {
  return join(repoRoot(), LAUNCHER_RELATIVE);
}

/**
 * Best-effort early read of just `rootPid`, for observability while the run is
 * still going. The launcher writes it right after CreateProcess and long before
 * `complete=1`, so requiring a complete record here would make the root PID
 * invisible for the whole run. Returns null if it is not there yet.
 */
export function peekRootPid(controlPath: string): number | null {
  try {
    if (!existsSync(controlPath)) return null;
    for (const line of completeLines(decodeControl(readFileSync(controlPath)))) {
      if (line.startsWith('rootPid=')) {
        // Strict: only a complete, fully-formed, positive decimal line counts. A
        // torn `rootPid=12` on the way to `rootPid=123456` is never cached.
        return strictDecimal(line.slice('rootPid='.length), { min: 1 });
      }
    }
  } catch {
    /* not observable yet */
  }
  return null;
}

/**
 * The ONLY lifecycle fact a live/partial control read may expose is `rootPid`
 * (above), and it is torn-write-safe and strictly validated.
 *
 * `rootExitObserved`, `rootExitCode`, `treeStopped`, `activeProcessesFinal`,
 * `assignedBeforeResume`, `launcherStatus`, `phase` and `complete` are
 * DELIBERATELY not peekable: they must come from a fully validated record via
 * `readControlRecord`, or not at all. A raw/partial read must never be able to
 * project lifecycle terminal truth (that was the P1 that let a record which is
 * ultimately INVALID still set `rootTerminalObserved = true`).
 */

/** Human-readable containment readiness, for `orchestrator doctor` and tests. */
export function containmentStatus(): { enabled: boolean; launcher: string | null } {
  if (!containmentEnabled()) return { enabled: false, launcher: null };
  const l = resolveContainmentLauncher();
  return { enabled: true, launcher: l?.exe ?? null };
}
