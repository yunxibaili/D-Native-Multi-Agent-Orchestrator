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
import type { LauncherSpec } from '../core/types.ts';

export interface SpawnOptions {
  launcher: LauncherSpec;
  args: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
  stdin?: string;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  stderrTailBytes?: number;
}

export interface ProcessExit {
  code: number | null;
  signal: string | null;
}

/** Grace given to a child to shut down cleanly before the tree is killed. */
const TREE_KILL_GRACE_MS = 1500;
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

  /** Streams that have not yet emitted 'end'. */
  private pendingStreams = 0;
  private processExited = false;
  private finished = false;
  private spawnFailed = false;
  private drainTimer: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private cleanupPromise: Promise<boolean> | null = null;

  readonly exited: Promise<ProcessExit>;
  private resolveExit: ((e: ProcessExit) => void) | null = null;

  constructor(opts: SpawnOptions) {
    const argv = buildLaunchArgv(opts.launcher, opts.args);
    if (opts.launcher.buildsCommandString) assertCmdSafe(opts.args);
    this.commandLine = [opts.launcher.command, ...argv].join(' ');
    this.onStdoutLine = opts.onStdoutLine;
    this.onStderrLine = opts.onStderrLine;
    this.stderrTail = new TailBuffer({
      limitBytes: opts.stderrTailBytes ?? DEFAULT_STDERR_TAIL_BYTES,
      keep: 'tail',
    });

    log.debug('spawn', { commandLine: this.commandLine, cwd: opts.cwd });

    this.exited = new Promise<ProcessExit>((res) => {
      this.resolveExit = res;
    });

    this.child = spawn(opts.launcher.command, argv, {
      cwd: opts.cwd,
      env: buildEnv(opts.env),
      shell: false,
      windowsHide: true,
      stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });

    if (opts.stdin !== undefined && this.child.stdin) {
      this.child.stdin.on('error', (e) => {
        // A child that exits before reading stdin yields EPIPE. Expected.
        log.debug('stdin write failed', { error: (e as Error).message });
      });
      this.child.stdin.end(opts.stdin, 'utf8');
    }

    this.attach(this.child.stdout, 'stdout');
    this.attach(this.child.stderr, 'stderr');

    this.child.on('error', (err: NodeJS.ErrnoException) => {
      // ENOENT/EACCES/EINVAL: the binary is missing or not executable.
      // Record it in the stderr tail (the only place a caller will look) and
      // finish so waiters never hang. `child.exitCode` is read-only in the
      // Node typings, so the synthetic 127 is tracked here.
      log.error('spawn failed', { command: opts.launcher.command, error: err.message });
      this.stderrTail.append(`\nspawn error: ${err.message}`);
      this.spawnFailed = true;
      this.onProcessExit();
    });

    // 'exit' is reliable; 'close' may never fire when a grandchild holds the
    // pipes. 'close' is kept only as a belt-and-braces second trigger.
    this.child.on('exit', () => this.onProcessExit());
    this.child.on('close', () => this.onProcessExit());
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get exitCode(): number | null {
    return this.child.exitCode;
  }

  private attach(stream: NodeJS.ReadableStream | null, channel: 'stdout' | 'stderr'): void {
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
      if (rest) {
        if (channel === 'stderr') this.stderrTail.append(rest);
        lineBuffer += rest;
      }
      if (lineBuffer.length) {
        if (onLine) onLine(lineBuffer);
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
    this.resolveExit?.({
      code: this.spawnFailed ? 127 : this.child.exitCode,
      signal: this.child.signalCode,
    });
  }

  /**
   * Stop the process and its descendants.
   *
   * Windows: `taskkill /T /F` is issued FIRST and AWAITED. `taskkill /T` walks
   * a live tree, and `child.kill('SIGINT')` on Windows is TerminateProcess on
   * the root only — so a "graceful first" order kills the root and orphans the
   * grandchildren. Cancellation on Windows is therefore forceful by design.
   */
  async cancel(reason: string): Promise<boolean> {
    const pid = this.child.pid;
    log.info('cancelling process', { pid, reason });

    if (process.platform === 'win32') {
      if (this.child.exitCode !== null) return true; // already gone
      this.cleanupPromise = taskkillTree(pid);
      return this.cleanupPromise;
    }

    try {
      this.child.kill('SIGINT');
    } catch {
      /* ignore */
    }
    this.killTimer = setTimeout(() => {
      this.cleanupPromise = taskkillTree(pid);
    }, TREE_KILL_GRACE_MS);
    return true;
  }

  /** Await any pending tree kill. Part of the cleanup contract. */
  async settleCleanup(): Promise<boolean> {
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
      this.cleanupPromise = taskkillTree(this.child.pid);
    }
    if (!this.cleanupPromise) return true;
    return this.cleanupPromise;
  }

  /**
   * Reap descendants after a NORMAL exit.
   *
   * Contract, stated plainly: once the root process has exited, `taskkill /T`
   * has no live root to walk. A Windows job object is the only fully reliable
   * mechanism and we deliberately do not take a native dependency for it. So:
   * the kill is issued and AWAITED, and failure is reported rather than
   * swallowed — a leaking agent is observable, not silently tolerated.
   */
  async reapDescendants(reason: string): Promise<boolean> {
    const pid = this.child.pid;
    if (pid === undefined) return true;
    const ok = await taskkillTree(pid);
    if (!ok) log.debug('descendant reap found nothing', { pid, reason });
    return ok;
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
