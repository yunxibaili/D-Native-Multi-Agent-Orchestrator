/**
 * runtime/spawn.ts — the low-level process layer.
 *
 * Fixes from review, each verified live on this machine:
 *
 *  - `'close'` can NEVER be awaited. Node's `'close'` waits for all stdio to
 *    end, and a grandchild that inherited the pipes holds them open, so a
 *    cancelled Codex task hung forever. The exit signal is therefore `'exit'`
 *    plus a short drain window.
 *  - `taskkill` is now AWAITED and its result checked, instead of being fired
 *    and forgotten. `cancel()` does not resolve until the tree kill is done.
 *  - stderr tail accumulates the raw decoded chunk BEFORE line slicing. The old
 *    order kept only the trailing partial line and dropped every complete line
 *    — i.e. exactly the content needed to explain a startup failure.
 *
 * Windows notes: `shell:false` always; `windowsHide`; an environment
 * allowlist; UTF-8 via StringDecoder; CRLF/LF/CR line splitting; and
 * `taskkill /T /F` for tree cleanup while the root is still alive.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { TailBuffer } from '../core/buffer.ts';
import { log } from '../core/log.ts';
import { assertCmdSafe, buildLaunchArgv } from './launcher.ts';
import { asProvenNotStarted, brandProvenNotStarted } from './internal/start-proof.ts';
import { evaluateOfflineSpawn, describeOfflineDenial, OFFLINE_AGENT_LAUNCH_REFUSED } from './offline-policy.ts';
import { advanceProcessStart } from './process-start.ts';
import type { ProcessStartDisposition } from '../core/types.ts';
import type { LauncherSpec } from '../core/types.ts';
import {
  containmentEnabled,
  resolveContainmentLauncher,
  expectedLauncherPath,
  createControlPath,
  createStopPath,
  requestContainedStop,
  removeStopFile,
  buildContainedArgv,
  readControlRecord,
  treeStopConfirmedFrom,
  isCooperativeTermination,
  removeControlFile,
  peekRootPid,
  type ContainmentRecord,
} from './containment.ts';

/**
 * W2: the containment facts for ONE contained run, read back from the sealed
 * launcher's control record. Present only when containment was actually used.
 *
 * These are the REAL facts: the agent root pid (distinct from the launcher pid
 * Node owns), the agent root exit code (distinct from the launcher's protocol
 * exit code), and whether the Job physically reported the tree stopped.
 */
export interface ContainmentFacts {
  readonly launcherPid: number | null;
  readonly rootPid: number | null;
  readonly rootExitCode: number | null;
  readonly treeStopConfirmed: boolean;
  readonly launcherStatus: string;
  readonly phase: string | null;
  readonly win32Error: number | null;
  readonly activeProcessesFinal: number | null;
  /**
   * W3: was this run stopped ON THE PARENT'S REQUEST (a cooperative termination),
   * rather than the agent finishing on its own?
   *
   * This is the AGENT OUTCOME question and is deliberately a different fact from
   * {@link treeStopConfirmed}: a cancelled run is a normal, correct combination of
   * `terminated: true` + `treeStopConfirmed: true`. What must never happen is
   * reading a `terminated` record as the agent having succeeded.
   */
  readonly terminated: boolean;
}

export interface SpawnOptions {
  launcher: LauncherSpec;
  args: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
  stdin?: string;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /**
   * RAW stdout text, delivered as decoded chunks VERBATIM.
   *
   * When set, stdout is NOT line-framed for this process: every decoded chunk is
   * handed over untouched, so line terminators, EMPTY lines, interior whitespace
   * and a trailing (or absent) final newline are all preserved exactly. The
   * `StringDecoder` already reassembles multi-byte UTF-8 sequences that straddle a
   * chunk boundary, so the concatenation of the chunks equals the byte stream.
   *
   * This is the entry a PLAIN-TEXT agent (e.g. DSH headless) needs, because
   * `emitCompleteLines` deliberately strips terminators and drops empty lines — a
   * lossy framing that is correct for JSONL but destroys plain text.
   *
   * Takes precedence over `onStdoutLine` for stdout; stderr is unaffected. Default
   * (unset) keeps the existing line-framed behaviour, so JSONL agents are unchanged.
   */
  onStdoutText?: (text: string) => void;
  stderrTailBytes?: number;
}

export interface ProcessExit {
  code: number | null;
  signal: string | null;
}

/**
 * What the process-tree cleanup actually achieved. Recorded so a leak is
 * observable rather than assumed away, and so a caller can tell "nothing to do"
 * apart from "tried and failed".
 */
export interface CleanupResult {
  /** True only when a tree kill was actually issued against a live root. */
  readonly rootKilled: boolean;
  readonly descendantsReaped: boolean;
  readonly note: string;
  /**
   * W3: was the physical tree stop POSITIVELY confirmed?
   *
   * Carried here so the fact can reach the write-scope release decision instead
   * of being reconstructed (and guessed) further up. Absent evidence is false.
   */
  readonly treeStopConfirmed: boolean;
  /**
   * W3.2: what the process layer can PROVE about OS process creation.
   *
   * A run that ends in a frozen `RunResult` — rather than a throw — still has to be
   * able to say "nothing was ever created", or a launcher that never existed would
   * leave its WRITE scope permanently blocked. This carries that verdict out.
   */
  readonly processStart: ProcessStartDisposition;
}

/** Grace given to a child to shut down cleanly before the tree is killed. */
const TREE_KILL_GRACE_MS = 1500;
/**
 * W3: how long we wait for the launcher to terminate the Job and write its final
 * validated record.
 *
 * Bounded on purpose. The launcher polls the Job's own accounting and normally
 * confirms emptiness in milliseconds; the bound exists so a hung launcher, a lost
 * control directory or a failed TerminateJobObject can never wedge a cancellation
 * forever. On expiry the answer is `false` — UNCONFIRMED — and the caller keeps
 * write protection. It is deliberately longer than the launcher's own internal
 * `STOP_EMPTY_TIMEOUT_MS` so the launcher's own honest `stop-unconfirmed` verdict
 * normally arrives first.
 */
const CONTAINED_STOP_WAIT_MS = 35_000;
/** How long to keep reading stdio after the process itself exited. */
const STDIO_DRAIN_GRACE_MS = 400;
const DEFAULT_STDERR_TAIL_BYTES = 8 * 1024;
/** Cap on an undelivered partial line when nobody is listening. */
const PENDING_CAP_BYTES = 64 * 1024;

const ENV_ALLOWLIST = [
  'ALLUSERSPROFILE',
  'APPDATA',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMDATA',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
  // Agent-owned state. We never set credentials; we only let an agent read
  // its own already-logged-in session.
  'CODEX_HOME',
  'OPENCODE_CONFIG',
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_SERVER_USERNAME',
  'NO_COLOR',
  'TERM',
  'CI',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const;

export function buildEnv(extra?: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const v = process.env[key];
    if (v !== undefined) out[key] = v;
  }
  // Preserve supported parent proxy routes across nested contained launches.
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY'] as const) {
    const value = process.env[key] ?? process.env[key.toLowerCase()];
    if (!value) continue;
    try {
      const protocol = new URL(value).protocol;
      if (protocol === 'http:' || protocol === 'https:') out[key] = value;
    } catch { /* Malformed proxy values are not inherited. */ }
  }
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy;
  if (noProxy !== undefined || out.HTTP_PROXY !== undefined || out.HTTPS_PROXY !== undefined) {
    out.NO_PROXY = [...new Set([
      ...(noProxy ?? '').split(',').map((host) => host.trim()).filter(Boolean),
      'localhost', '127.0.0.1', '::1',
    ])].join(',');
    out.no_proxy = out.NO_PROXY;
  }
  if (extra) for (const [k, v] of Object.entries(extra)) out[k] = v;
  if (out.NO_COLOR === undefined) out.NO_COLOR = '1';
  return out;
}

/**
 * A spawned process with a bounded stderr tail and an awaitable exit.
 * Emits nothing: framing belongs to the transport layer.
 */
export class ManagedProcess {
  readonly commandLine: string;
  readonly stderrTail: TailBuffer;

  private readonly child: ChildProcess;
  private readonly onStdoutLine?: (line: string) => void;
  private readonly onStderrLine?: (line: string) => void;
  /** Opt-in RAW stdout text sink (see `SpawnOptions.onStdoutText`). */
  private readonly onStdoutText?: (text: string) => void;

  /** Streams that have not yet emitted 'end'. */
  private pendingStreams = 0;
  private processExited = false;
  private finished = false;
  private spawnFailed = false;
  private drainTimer: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private cleanupPromise: Promise<boolean> | null = null;

  /**
   * R5-1.2C (§3): has a STOP of the DESCENDANT TREE ever been CONFIRMED for this
   * process? This is sticky and deliberately NOT derived from the root's exit.
   *
   * The root exiting proves `rootTerminalObserved`, which is a different fact: a root
   * that spawns a descendant and then dies leaves that descendant running, still able
   * to write the workspace it was given. Conflating the two is what allowed a leaked
   * tree to be reported as "process stopped" and a workspace lock to be released while
   * a writer was still alive.
   *
   * It becomes `true` only when a tree kill was actually ISSUED and CONFIRMED. It never
   * becomes `true` merely because the root is gone — that case cannot be confirmed
   * without a Windows Job Object, which this codebase deliberately does not introduce.
   */
  private treeStopConfirmedFlag = false;

  /**
   * W2: was this process launched through the sealed Job launcher?
   */
  private readonly contained: boolean;
  /** The control file for a contained run; removed once its record is consumed. */
  private controlPath: string | null = null;
  /** W3: the per-run cooperative stop marker handed to the launcher. */
  private stopPath: string | null = null;
  /** W3: has a stop already been REQUESTED for this run? Idempotent, sticky. */
  private stopRequested = false;
  /**
   * W3.2: what this class can PROVE about OS process creation, from its own control
   * flow.
   *
   * `'may-have-started'` is the default and is deliberately pessimistic: it stays that
   * way unless a positively-known pre-spawn failure sets it to `'not-started'`, and it
   * becomes `'started'` the moment `spawn` is called.
   *
* The `spawn` call is the line of no return. Past it, nothing — not even an
   * exception thrown microseconds later — may downgrade the disposition, because a
   * writer may already be running.
   *
   * W3.3: every mutation goes through `advanceProcessStart`, which makes the state
   * MONOTONIC — a confirmed `started` can never be dragged back to `not-started` by a
   * late failure. A stray assignment here used to be able to do exactly that.
   */
  private startDisposition: ProcessStartDisposition = 'may-have-started';
  /** The launcher advertised a control channel that could not be used. */
  private containmentUnavailable = false;
  /** Facts read back from a VALID, complete control record. Null until then. */
  private containmentFacts: ContainmentFacts | null = null;
  /** The agent ROOT pid, distinct from `child.pid` (the launcher) once known. */
  private rootPidValue: number | null = null;
  /** W2.1: the AGENT ROOT exit code from the control record; null until known. */
  private rootExitCodeValue: number | null = null;
  /**
   * W2: whether the AGENT ROOT's exit has been observed. For a contained run this
   * is a DIFFERENT fact from `processExited`, which tracks the LAUNCHER: the
   * launcher keeps running after the root dies (it waits for the Job to empty), so
   * the root's exit must be read from the incremental control record.
   */
  private rootExitedObserved = false;
  private controlWatch: NodeJS.Timeout | null = null;

  /**
   * R5-1.2C (§3): the ROOT's terminal observation, as a diagnostic fact only.
   *
   * Never use this to decide that the tree is quiescent or that physical protection may
   * be released; use {@link isTreeStopConfirmed} for that.
   */
  get rootTerminalObserved(): boolean {
    // For a contained run this is the AGENT ROOT's exit, sourced from the control
    // record (peeked live, then confirmed from the VALIDATED record) -- never from
    // the launcher's own exit, which would report "root exited" for a pre-root
    // failure where no root ever existed.
    if (this.contained) return this.rootExitedObserved;
    return this.processExited;
  }

  /**
   * W2: whether the descendant tree is CONFIRMED stopped.
   *
   * For a CONTAINED run this is the Job-level truth: it is `true` only when the
   * launcher's control record is complete AND reports success AND the Job's
   * `ActiveProcesses` reached 0. A killed launcher, a missing control file, a
   * malformed record or a failed status is `false`/unknown — never optimistically
   * true. This replaces "the root exited, so assume the tree stopped".
   *
   * For a NON-contained run (non-Windows) the legacy sticky flag is retained: it
   * is only ever set by a confirmed tree kill.
   */
  isTreeStopConfirmed(): boolean {
    if (this.contained) return this.containmentFacts?.treeStopConfirmed ?? false;
    return this.treeStopConfirmedFlag;
  }

  /**
   * W2 PID semantics: `pid` is the AGENT ROOT pid — the process that actually
   * does the work — not the launcher Node directly spawned. While the root pid is
   * not yet knowable it falls back to the direct child (the launcher); callers
   * that must distinguish the two use {@link launcherPid} and {@link rootPid}.
   */
  get pid(): number | undefined {
    // W2.1: `pid` is the AGENT ROOT pid and NOTHING else. It NEVER falls back to
    // the launcher pid, so a caller reading it before the root is known gets
    // `undefined`, not a value that silently changes identity moments later.
    if (this.contained) return this.rootPidValue ?? undefined;
    return this.child.pid;
  }

  /** W2: the launcher process id — the direct child Node owns. */
  get launcherPid(): number | undefined {
    return this.child.pid;
  }

  /** W2: the agent ROOT process id, once the control channel has supplied it. */
  get rootProcessPid(): number | null {
    return this.rootPidValue;
  }

  /** W2: the containment evidence for this run, or null if not contained. */
  get containment(): ContainmentFacts | null {
    return this.containmentFacts;
  }

  /** W2 diagnostic: the launcher could not be used, so nothing was run. */
  get containmentUnavailableReason(): boolean {
    return this.containmentUnavailable;
  }

  /**
   * W3.2: what this process layer can PROVE about OS process creation.
   *
   * Read by the transport/session/runtime to carry the verdict out to the execution
   * edge. It is a fact, never an inference: `'not-started'` appears only where this
   * class knows from its own control flow that `CreateProcess` was never reached.
   */
  get processStartDisposition(): ProcessStartDisposition {
    return this.startDisposition;
  }

  readonly exited: Promise<ProcessExit>;
  private resolveExit: ((e: ProcessExit) => void) | null = null;

  constructor(opts: SpawnOptions) {
    /*
     * W3.2: every step below that can fail BEFORE `spawn()` is called is a place
     * where this class — which actually controls process creation — can PROVE that no
     * OS process exists. Those failures are re-thrown carrying the runtime's trusted
     * brand (see `./internal/start-proof.ts`), so the execution edge can release its
     * WRITE claim instead of retaining protection forever for a run that never
     * happened.
     *
     * Nothing here is inferred from a message or a type name. Each site is a fact this
     * class knows from its own control flow, and the brand is module-private.
     */
    const offline = evaluateOfflineSpawn({ launcher: opts.launcher, args: opts.args, cwd: opts.cwd, env: opts.env });
    if (!offline.allowed) {
      /*
       * OFFLINE TEST ISOLATION. The decision is made from the ACTUAL launch inputs
       * before `spawn()` is ever reached, so it is a PROVEN pre-start: nothing was
       * created, and the WRITE claim may be released. This is the shared process edge
       * that every launch path (run / probe / catalogue / approved-test / transport /
       * adapter) funnels through. See `./offline-policy.ts`.
       *
       * The refusal carries a DEDICATED code so a caller can tell a policy refusal
       * apart from a resolve/argv failure. It is branded IN PLACE (never wrapped), so
       * both the code and the runtime-owned proven-not-started proof survive together.
       */
      const refusal = new Error(describeOfflineDenial(offline)) as Error & { code?: string };
      refusal.name = 'OfflineAgentLaunchRefusedError';
      refusal.code = OFFLINE_AGENT_LAUNCH_REFUSED;
      throw brandProvenNotStarted(refusal, 'request-rejected-before-spawn', 'offline agent launch policy');
    }
    let argv: string[];
    try {
      argv = buildLaunchArgv(opts.launcher, opts.args);
      if (opts.launcher.buildsCommandString) assertCmdSafe(opts.args);
    } catch (e) {
      // Reached only when argv could not be built / unsafe args were refused, which is
      // decided entirely in-process. `spawn` has not been called.
      throw asProvenNotStarted(e, 'request-rejected-before-spawn', 'the launch arguments could not be built');
    }
    // `commandLine` stays the AGENT command line: it is what the operator cares
    // about and what observability should show. The launcher line is an
    // implementation detail and is not surfaced here.
    this.commandLine = [opts.launcher.command, ...argv].join(' ');
    this.onStdoutLine = opts.onStdoutLine;
    this.onStderrLine = opts.onStderrLine;
    this.onStdoutText = opts.onStdoutText;
    this.stderrTail = new TailBuffer({
      limitBytes: opts.stderrTailBytes ?? DEFAULT_STDERR_TAIL_BYTES,
      keep: 'tail',
    });

    log.debug('spawn', { commandLine: this.commandLine, cwd: opts.cwd });

    this.exited = new Promise<ProcessExit>((res) => {
      this.resolveExit = res;
    });

    const stdio: Array<'ignore' | 'pipe'> =
      [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'];
    const childOptions = {
      cwd: opts.cwd,
      env: buildEnv(opts.env),
      shell: false as const,
      windowsHide: true as const,
      stdio,
    };

    /*
     * W2: on Windows every production process is launched THROUGH the sealed Job
     * launcher. There is deliberately NO fallback to an uncontained spawn: if the
     * launcher is missing we run the (missing) launcher path so the failure is a
     * deterministic, visible ENOENT rather than a silent loss of containment.
     */
    this.contained = containmentEnabled();
    if (this.contained) {
      const launcher = resolveContainmentLauncher();
      if (launcher === null) {
        this.containmentUnavailable = true;
        /*
         * W3.2: a PROVEN pre-start. `resolveContainmentLauncher()` returns null only
         * after `existsSync` reported the image absent, so this class knows no OS
         * process can exist for this run. The dispatch below still runs the missing
         * path (W2's deterministic ENOENT is sealed behaviour and produces the stderr
         * tail an operator needs), but the DISPOSITION is recorded as proven, so the
         * execution edge can release its WRITE claim once the operator fixes the
         * launcher instead of leaving the scope poisoned forever.
         */
this.startDisposition = advanceProcessStart(this.startDisposition, 'proven-pre-spawn-failure');
        this.stderrTail.append(
          '\ncontainment-unavailable: w1joblauncher.exe was not found; refusing to ' +
            'start an uncontained agent. Build it with native/windows-job-launcher/build.ps1.',
        );
        log.error('containment unavailable', { command: expectedLauncherPath() });
        // Spawn a path we KNOW is missing (the authoritative override, or the
        // expected repo-local path) so the failure is a deterministic ENOENT and
        // the agent is never started. We must NOT spawn a different, existing
        // launcher here — that would silently defeat an explicit override.
        this.child = spawn(process.env.ORCH_JOB_LAUNCHER || expectedLauncherPath(), [], childOptions);
      } else {
        /*
         * W3.2: control-channel setup is the last thing that happens before `spawn`.
         * A failure here — `mkdir containment-run` refused, the path unusable, the
         * volume full — provably leaves no process, because `spawn` has not been
         * called yet. Failing closed on containment is right; failing closed with a
         * PERMANENTLY blocked write scope is not.
         */
        try {
          this.controlPath = createControlPath(launcher);
        } catch (e) {
          throw asProvenNotStarted(
            e,
            'control-setup-failed',
            `the containment control directory could not be prepared under "${launcher.dir}"`,
          );
        }
        this.stopPath = createStopPath(this.controlPath);
        this.child = spawn(
          launcher.exe,
          buildContainedArgv(opts.launcher, opts.args, this.controlPath, this.stopPath),
          childOptions,
        );
        // The live watcher discovers ONLY `rootPid`. It deliberately does NOT
        // read any lifecycle fact (root exit / tree stop) from the partial record:
        // those must come from the fully validated record in `finish()`, so a
        // record that later turns out INVALID can never have already projected a
        // terminal fact.
        this.controlWatch = setInterval(() => {
          if (this.controlPath === null) return;
          if (this.rootPidValue === null) {
            const p = peekRootPid(this.controlPath);
            if (p !== null) this.rootPidValue = p;
          }
        }, 100);
        if (typeof this.controlWatch.unref === 'function') this.controlWatch.unref();
      }
    } else {
      this.child = spawn(opts.launcher.command, argv, childOptions);
    }

/*
     * W3.3: `spawn` has been ATTEMPTED. The outcome is not yet known, so the state
     * moves to the pending form — which a proven image-not-found failure may still
     * resolve to `not-started`.
     *
     * On a successful Windows spawn Node sets `child.pid` synchronously, so a real
     * child is confirmed immediately. The async `spawn` event is also honoured below
     * as a second confirmation path.
     */
    this.startDisposition = advanceProcessStart(this.startDisposition, 'spawn-attempted');
    if (this.child.pid !== undefined) {
      this.startDisposition = advanceProcessStart(this.startDisposition, 'spawn-confirmed');
    }
    // Node emits `spawn` once the child has actually started. After this the state is
    // terminal `started` and no later failure can downgrade it.
    this.child.on('spawn', () => {
      this.startDisposition = advanceProcessStart(this.startDisposition, 'spawn-confirmed');
    });

    if (opts.stdin !== undefined && this.child.stdin) {
      this.child.stdin.on('error', (e) => {
        // A child that exits before reading stdin yields EPIPE. Expected.
        log.debug('stdin write failed', { error: (e as Error).message });
      });
      this.child.stdin.end(opts.stdin, 'utf8');
    }

    this.attach(this.child.stdout, 'stdout', this.onStdoutText);
    this.attach(this.child.stderr, 'stderr');

    this.child.on('error', (err: NodeJS.ErrnoException) => {
      // ENOENT/EACCES/EINVAL: the binary is missing or not executable.
      // Record it in the stderr tail (the only place a caller will look) and
      // finish so waiters never hang. `child.exitCode` is read-only in the
      // Node typings, so the synthetic 127 is tracked here.
      log.error('spawn failed', {
        command: this.contained ? expectedLauncherPath() : opts.launcher.command,
        error: err.message,
        containmentUnavailable: this.containmentUnavailable,
      });
this.stderrTail.append(`\nspawn error: ${err.message}`);
      /*
       * W3.3: classify the spawn failure by FACT, and let the MONOTONIC machine decide
       * whether it is even allowed to move the state.
       *
       * ENOENT (image not found) and EACCES (image not executable) are the documented
       * "CreateProcess was never reached" cases, so they are `not-started` — but ONLY
       * from the pending state. If a child was already confirmed (`started`, which
       * `advanceProcessStart` treats as terminal), this event is absorbed and the state
       * does not move. That guard is structural, not a check bolted on here.
       *
       * Everything else — resource exhaustion, a transient OS error, anything
       * unrecognised — is `spawn-error-other`, which stays `may-have-started`. An
       * unclassifiable spawn failure must NOT become permission to release a WRITE
       * claim.
       */
      this.startDisposition = advanceProcessStart(
        this.startDisposition,
        err.code === 'ENOENT' || err.code === 'EACCES'
          ? 'spawn-error-image-not-found'
          : 'spawn-error-other',
      );
      this.spawnFailed = true;
      this.onProcessExit();
    });

    // 'exit' is reliable; 'close' may never fire when a grandchild holds the
    // pipes. 'close' is kept only as a belt-and-braces second trigger.
    this.child.on('exit', () => this.onProcessExit());
    this.child.on('close', () => this.onProcessExit());
  }

  get exitCode(): number | null {
    // W2.1: for a contained run the direct child is the LAUNCHER, whose exit code
    // is a PROTOCOL outcome — never the agent's. The public agent exit code is the
    // root exit code from the control record (null until it is known). This keeps
    // `exitCode` and `exited.code` describing the SAME thing.
    if (this.contained) return this.rootExitCodeValue;
    return this.child.exitCode;
  }

  /** W2.1: the launcher's own protocol exit code (internal fact, not the agent's). */
  get launcherExitCode(): number | null {
    return this.child.exitCode;
  }

  /**
   * R5-1.1 (§3): whether the ROOT process is still known to be active.
   *
   * This is a READ-ONLY fact from Node's own child process state, not a control
   * handle and not a new authority. It exists so a caller that just requested
   * cancellation can distinguish "confirmed dead" from "cancel issued but the
   * tree's end state is UNKNOWN" — the latter must never be reported as a
   * completed operation.
   */
  get alive(): boolean {
    return !this.spawnFailed && this.child.exitCode === null && this.child.signalCode === null;
  }

  private attach(
    stream: NodeJS.ReadableStream | null,
    channel: 'stdout' | 'stderr',
    onText?: (text: string) => void,
  ): void {
    if (!stream) return;
    const decoder = new StringDecoder('utf8');
    // Each stream routes to ITS OWN callback. Sharing one handler would label
    // stderr diagnostics as agent events, which is exactly the kind of silent
    // misattribution this round is meant to eliminate.
    const onLine = channel === 'stdout' ? this.onStdoutLine : this.onStderrLine;
    // A JSONL line can straddle any chunk boundary, so an incomplete tail is
    // carried forward instead of being emitted early.
    let lineBuffer = '';
    this.pendingStreams++;

    stream.on('data', (buf: Buffer) => {
      const chunk = decoder.write(buf);
      // stderr is retained RAW, before line slicing, so a complete line is
      // never lost — this tail is the only explanation for a startup crash.
      if (channel === 'stderr') this.stderrTail.append(chunk);
      if (onText) {
        /*
         * RAW text mode: hand the decoded chunk over VERBATIM. `StringDecoder`
         * already reassembled any multi-byte UTF-8 sequence that straddled a chunk
         * boundary, so concatenating the chunks reproduces the byte stream exactly
         * — newlines, empty lines, interior whitespace and the trailing newline
         * included. Nothing is line-split or trimmed here.
         */
        if (chunk.length > 0) onText(chunk);
        return;
      }
      lineBuffer += chunk;
      if (onLine) {
        lineBuffer = emitCompleteLines(lineBuffer, onLine);
      } else if (Buffer.byteLength(lineBuffer, 'utf8') > PENDING_CAP_BYTES) {
        // Nobody is reading this stream; do not accumulate without bound.
        lineBuffer = lineBuffer.slice(-PENDING_CAP_BYTES);
      }
    });

    stream.on('end', () => {
      const rest = decoder.end();
      if (onText) {
        // Flush the decoder's final reassembled characters verbatim.
        if (rest.length > 0) onText(rest);
      } else {
        if (rest) {
          if (channel === 'stderr') this.stderrTail.append(rest);
          lineBuffer += rest;
        }
        if (lineBuffer.length) {
          if (onLine) onLine(lineBuffer);
        }
      }
      lineBuffer = '';
      this.pendingStreams--;
      this.maybeFinish();
    });

    stream.on('error', () => {
      this.pendingStreams--;
      this.maybeFinish();
    });
  }

  private onProcessExit(): void {
    if (this.processExited) return;
    this.processExited = true;
    if (this.pendingStreams === 0) {
      this.finish();
      return;
    }
    // Let the last buffered output arrive, but never wait on a stream a
    // grandchild may still be holding open.
    //
    // Deliberately NOT unref'd: once the child has exited nothing else holds
    // the event loop, so an unref'd drain timer would let the process exit
    // before `exited` ever resolved.
    this.drainTimer = setTimeout(() => this.finish(), STDIO_DRAIN_GRACE_MS);
  }

  private maybeFinish(): void {
    if (this.processExited && this.pendingStreams === 0) this.finish();
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.controlWatch) {
      clearInterval(this.controlWatch);
      this.controlWatch = null;
    }

    let code: number | null = this.spawnFailed ? 127 : this.child.exitCode;
    let signal: string | null = this.child.signalCode;

    if (this.contained && this.controlPath !== null) {
      /*
       * W2: for a contained run the direct child is the LAUNCHER, so neither its
       * exit code nor its signal describes the agent. The agent's real exit code
       * comes from the control record — and ONLY from there. A launcher protocol
       * failure (e.g. exit 8 = control file unopenable, exit 4 = CreateProcess
       * failed) is NOT an agent exit code, so it becomes `null`/unknown rather
       * than being mislabeled as one.
       */
      const validated = readControlRecord(this.controlPath);
      if (validated.ok) {
        this.rootPidValue = validated.record.rootPid;
        // The FINAL root-exit fact comes from the VALIDATED record, never from a
        // peek of a record that later turned out to be contradictory.
        this.rootExitedObserved = validated.record.rootExitObserved;
        this.containmentFacts = factsFrom(this.child.pid ?? null, validated.record);
        /*
         * W3: the AGENT OUTCOME is deliberately `null` for a cooperative
         * termination. The `rootExitCode` in a `terminated` record is the code WE
         * passed to TerminateJobObject, not a result the agent chose, so surfacing
         * it as this run's exit code would report a cancellation as though the
         * agent had finished that way on its own. The record keeps it for
         * diagnostics; the physical stop evidence is entirely unaffected.
         */
        code = isCooperativeTermination(validated.record) ? null : validated.record.rootExitCode;
        signal = null;
      } else {
        log.warn('containment control record invalid', { reason: validated.reason });
        this.containmentFacts = {
          launcherPid: this.child.pid ?? null,
          rootPid: this.rootPidValue,
          rootExitCode: null,
          treeStopConfirmed: false,
          launcherStatus: '<invalid>',
          phase: null,
          win32Error: null,
          activeProcessesFinal: null,
          terminated: false,
        };
        // Unknown agent outcome. Never fabricate a code, never claim the tree stopped.
        if (!this.spawnFailed) code = null;
        signal = null;
      }
      this.rootExitCodeValue = code;
      // W3: clean up the per-run stop marker alongside the control record. Both are
      // best-effort and NEITHER can change a physical truth: a marker that survives
      // can only re-assert a request the launcher already answered, and a control
      // file that survives only keeps evidence that has already been consumed.
      if (process.env.ORCH_KEEP_CONTROL !== '1') {
        removeControlFile(this.controlPath);
        if (this.stopPath !== null) removeStopFile(this.stopPath);
      }
    }

    this.resolveExit?.({ code, signal });
  }

  /**
   * W3 §12: THE single physical stop primitive.
   *
   * Manual cancel, the execution deadline, an execution timeout and the git
   * timeout all funnel through here. They differ ONLY in the outcome the caller
   * records (`cancelled` vs `timeout`); the PHYSICAL termination sequence is
   * identical, so there is exactly one implementation of "stop this tree" and
   * therefore exactly one definition of what a confirmed stop means.
   *
   * The order is fixed and it is the whole point of this round:
   *
   *   1. ASK the launcher to terminate the Job  (create the stop marker)
   *   2. WAIT for the launcher to exit           (bounded)
   *   3. READ the launcher's final validated record
   *   4. CONFIRM only from `treeStopped=1` + `activeProcessesFinal=0`
   *
   * We deliberately do NOT begin by killing the launcher. A launcher that is
   * killed cannot write its final record, so killing first would DESTROY the only
   * evidence that could ever confirm the tree is empty — turning every
   * cancellation into an unverifiable guess.
   *
   * Returns true ONLY when that positive evidence exists. Every other outcome,
   * including "the launcher exited but its record is missing or invalid", is
   * false: the caller must then keep write protection.
   */
  async requestContainedStop(reason: string): Promise<boolean> {
    const pid = this.launcherPid;
    log.info('requesting contained stop', { launcherPid: pid, reason });

    // Already settled: re-report the truth we actually have rather than
    // re-issuing a request against a finished launcher.
    if (this.containmentFacts !== null) return this.isTreeStopConfirmed();

    if (this.stopPath === null) {
      // Containment was refused or the launcher is missing: there is no Job to
      // terminate cooperatively, and no evidence can ever arrive.
      log.warn('no stop marker for this run; the stop cannot be confirmed', { pid, reason });
      return false;
    }

    if (!this.stopRequested) {
      this.stopRequested = true;
      if (!requestContainedStop(this.stopPath)) {
        // The request never reached the launcher. Honest answer: unconfirmed.
        return false;
      }
    }

    // Wait, bounded, for the launcher to terminate the Job and settle.
    const settled = await waitBounded(this.exited, CONTAINED_STOP_WAIT_MS);
    if (settled) {
      // finish() has consumed the final record by now.
      // Read through the getter: finish() assigns the field asynchronously, so
      // TypeScript would otherwise keep the early-exit narrowing and type this
      // as unreachable.
      const facts = this.containment;
      const confirmed = this.isTreeStopConfirmed();
      log.info('contained stop settled', {
        launcherPid: pid,
        confirmed,
        status: facts?.launcherStatus ?? '<none>',
        terminated: facts?.terminated ?? false,
      });
      return confirmed;
    }

    /*
     * BOUNDED FALLBACK. The launcher is hung, its control channel is unavailable,
     * or TerminateJobObject failed: it did not produce a verdict in time.
     *
     * We still try to reclaim physically, because a live writer is worse than an
     * unverified claim — but the reclaim is explicitly NOT treated as proof.
     * `treeStopConfirmed` therefore stays false and the caller keeps protection.
     * This is the asymmetry that matters: killing is best-effort cleanup,
     * confirming is evidence.
     */
    log.warn('contained stop timed out; hard-killing the launcher as best-effort reclaim', {
      launcherPid: pid,
      reason,
    });
    await taskkillTree(pid);
    await waitBounded(this.exited, 5_000);
    return this.isTreeStopConfirmed();
  }

  /**
   * Stop the process and its descendants.
   *
   * W3: on a contained Windows run this is a COOPERATIVE Job stop, not a kill. See
   * {@link requestContainedStop}, which is the single primitive every caller uses.
   *
   * A contained cancel returns true only when the launcher positively confirmed
   * `ActiveProcesses == 0`.
   */
  async cancel(reason: string): Promise<boolean> {
    const pid = this.child.pid;
    log.info('cancelling process', { pid, reason });

    if (this.contained) return this.requestContainedStop(reason);

    // R5-1.2C (§3): an ALREADY-CONFIRMED tree stop stays confirmed, so a repeated
    // cancel of the same execution keeps reporting the truth instead of degrading to
    // "unknown" and forcing a needless re-verification.
    if (this.treeStopConfirmedFlag) return true;

    if (process.platform === 'win32') {
      // R5-1.2C (§2, §4): this used to `return true` — reading a dead ROOT as a dead
      // TREE. On Windows `taskkill /T` walks a LIVE tree, so once the root is gone
      // there is no live root to walk and any descendant it left behind keeps running.
      // Returning `true` here told the caller the stop was CONFIRMED and let a
      // workspace lock be released with a live writer still holding it.
      //
      // It must also NOT taskkill here: the PID may already have been recycled, which
      // would force-kill an unrelated process. So the honest answer is `false` — the
      // tree stop is UNCONFIRMED — and the caller keeps protection and retries.
      if (this.child.exitCode !== null) {
        log.warn('cancel could not confirm the tree stop: the root is already gone', { pid, reason });
        return false;
      }
      this.cleanupPromise = taskkillTree(pid).then((ok) => {
        this.treeStopConfirmedFlag = ok;
        return ok;
      });
      return this.cleanupPromise;
    }

    try {
      this.child.kill('SIGINT');
    } catch {
      /* ignore */
    }
    this.killTimer = setTimeout(() => {
      this.cleanupPromise = taskkillTree(pid).then((ok) => {
        this.treeStopConfirmedFlag = ok;
        return ok;
      });
    }, TREE_KILL_GRACE_MS);
    return true;
  }

  /** Await any pending tree kill. Part of the cleanup contract. */
  async settleCleanup(): Promise<boolean> {
    // W3: a contained run's cleanup IS the cooperative stop. There is no second,
    // independent kill path here — a deadline and a manual cancel must not be able
    // to reach the OS by different routes.
    if (this.contained && this.stopRequested) return this.requestContainedStop('settleCleanup');
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
      this.cleanupPromise = taskkillTree(this.child.pid).then((ok) => {
        this.treeStopConfirmedFlag = ok;
        return ok;
      });
    }
    if (!this.cleanupPromise) {
      // R5-1.2C: nothing was pending, so there is no new evidence either way. The
      // sticky flag (not this call) remains the single answer to "is the tree known
      // to be stopped", so a settle with nothing pending can never invent a `true`.
      return this.treeStopConfirmedFlag;
    }
    return this.cleanupPromise;
  }

  /**
   * Reap descendants after a NORMAL exit.
   *
   * DELIBERATELY DOES NOT taskkill the root once it has exited.
   *
   * `taskkill /T` walks a LIVE process tree. After the root exits there is no
   * live root to walk, so the call accomplishes no descendant cleanup — while
   * carrying a small but real risk: if the OS has already recycled that PID it
   * would target an unrelated process. A successful run must not be able to
   * trigger a stray force-kill, so the dead-root path is skipped entirely.
   *
   * True descendant reclamation after a normal exit needs a Windows Job Object,
   * which is deliberately not introduced here (no native dependency). The
   * result is RECORDED and reported instead of being silently assumed, so a
   * leaking agent is observable.
   */
  async reapDescendants(reason: string): Promise<CleanupResult> {
    // W3: this is where the physical truth is read for the caller. It is read
    // AFTER the control record has been consumed, so a contained run reports the
    // launcher's own confirmation — including a cooperative `terminated` one.
    const confirmed = this.isTreeStopConfirmed();
    const pid = this.child.pid;
    if (pid === undefined) {
      return { rootKilled: false, descendantsReaped: false, note: 'no pid', treeStopConfirmed: confirmed, processStart: this.startDisposition };
    }
    if (process.platform !== 'win32') {
      try {
        process.kill(-pid, 'SIGKILL');
        return { rootKilled: false, descendantsReaped: true, note: 'posix process group signalled', treeStopConfirmed: confirmed, processStart: this.startDisposition };
      } catch {
        return { rootKilled: false, descendantsReaped: false, note: 'posix group already gone', treeStopConfirmed: confirmed, processStart: this.startDisposition };
      }
    }
    // The root has already exited: there is no live tree to walk.
    return {
      rootKilled: false,
      descendantsReaped: false,
      note:
        `root ${pid} already exited; taskkill /T skipped (no live root to walk, and a ` +
`recycled PID would be a stray-kill risk). treeStopConfirmed=${confirmed}. reason=${reason}`,
      treeStopConfirmed: confirmed,
      processStart: this.startDisposition,
    };
  }
}

/**
 * `taskkill /T /F` with its result actually observed.
 * Resolves true when the kill succeeded or the target was already gone.
 */
export function taskkillTree(pid: number | undefined): Promise<boolean> {
  if (pid === undefined) return Promise.resolve(true);
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    killer.stdout?.on('data', (b: Buffer) => {
      out += b.toString('utf8');
    });
    killer.stderr?.on('data', (b: Buffer) => {
      out += b.toString('utf8');
    });
    killer.on('error', (e) => {
      log.warn('taskkill failed', { pid, error: (e as Error).message });
      resolve(false);
    });
    killer.on('close', (code) => {
      const gone = /not found|no running instance|could not find|没有找到/i.test(out);
      resolve(code === 0 || gone);
    });
  });
}

/**
 * W2: project a validated control record into the containment facts a caller
 * may rely on. Kept as a pure function so the projection is directly testable.
 */
function factsFrom(launcherPid: number | null, record: ContainmentRecord): ContainmentFacts {
  return {
    launcherPid,
    rootPid: record.rootPid,
    rootExitCode: record.rootExitCode,
    treeStopConfirmed: treeStopConfirmedFrom(record),
    launcherStatus: record.launcherStatus,
    phase: record.phase,
    win32Error: record.win32Error,
    activeProcessesFinal: record.activeProcessesFinal,
    terminated: isCooperativeTermination(record),
  };
}

/**
 * Await a promise with a hard upper bound.
 *
 * Resolves true when the promise settled in time, false on timeout. Used only
 * where the timeout is a SAFETY bound: on expiry the caller must report "unknown"
 * and keep protection, never "fine".
 */
async function waitBounded(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((res) => {
    timer = setTimeout(() => res(false), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([p.then(() => true as const), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Emit every complete line in `buf` and return the incomplete remainder.
 * Tolerates CRLF and lines longer than any single chunk.
 */
export function emitCompleteLines(buf: string, onLine: (line: string) => void): string {
  let start = 0;
  for (;;) {
    const nl = buf.indexOf('\n', start);
    if (nl === -1) break;
    let end = nl;
    if (end > start && buf.charCodeAt(end - 1) === 13) end -= 1;
    if (end > start) onLine(buf.slice(start, end));
    start = nl + 1;
  }
  return buf.slice(start);
}
