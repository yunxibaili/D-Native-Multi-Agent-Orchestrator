/**
 * runtime/spawn.ts — the only place in the project that calls child_process.
 *
 * Windows is the primary target, so every decision here is deliberate:
 *
 *  1. `shell: false` always. Passing a `.ps1` shim (npm's `opencode.ps1`) to
 *     `spawn` without a shell throws EINVAL on Windows; npm wrappers must be
 *     resolved to the underlying `.exe` instead. See discover.ts.
 *  2. `windowsHide: true` — no console flash per task.
 *  3. stdin is 'ignore' unless a prompt is piped. Codex otherwise prints
 *     "Reading additional input from stdin..." and can block forever.
 *  4. Kill is `taskkill /T /F`, not `child.kill()`. On Windows SIGTERM only
 *     reaches the direct child; Codex spawns powershell grandchildren that
 *     would survive and hold file handles.
 *  5. Decoding is explicit UTF-8 via StringDecoder. A `latin1` read mangles
 *     every non-ASCII char an agent prints, and Node has no per-stream
 *     encoding option.
 *  6. Line splitting accepts CRLF, LF and lone CR. Agents and their tool
 *     subprocesses emit all three on Windows.
 *  7. Env is an allowlist. This keeps credentials from leaking into an agent's
 *     environment, and it is the cheapest available version of the "block
 *     credential folders" rule from REUSE_ANALYSIS §3.
 */

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { log } from '../core/log.ts';

export interface SpawnOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
  /** Written to stdin then closed. */
  stdin?: string;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface ProcessHandle {
  readonly pid: number | undefined;
  readonly commandLine: string;
  /** Resolves on process exit. Never rejects. */
  readonly exited: Promise<ExitInfo>;
  cancel: (reason?: string) => void;
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  /** stderr tail — the only useful diagnostic when a CLI dies on startup. */
  stderrTail: string;
}

const STDERR_TAIL_LIMIT = 8000;

/**
 * How long to keep reading stdio after the process itself has exited.
 *
 * This exists because of a verified Windows failure mode: a grandchild that
 * inherits the stdout/stderr handles keeps them open, so Node's `'close'`
 * event never fires and a supervisor waiting on `'close'` HANGS FOREVER.
 * Codex spawns PowerShell children, so this is not hypothetical — it is the
 * normal case for a cancelled Codex task.
 *
 * We therefore finalize on `'exit'` (the process is gone) and allow a short
 * window for the last buffered output to arrive, so no trailing event is lost.
 */
const STDIO_DRAIN_GRACE_MS = 400;

/** Grace given to a child to shut down cleanly before the tree is killed. */
const TREE_KILL_GRACE_MS = 1500;

/**
 * Variables a Windows child needs to function at all, plus agent config homes.
 * Everything else is dropped unless the adapter explicitly opts in.
 */
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
  'PROGRAMDATA',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
  // Agent-owned state. We never set credentials; we only let the agent read
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
  if (extra) {
    for (const [k, v] of Object.entries(extra)) out[k] = v;
  }
  // Belt and braces: the contract for this project is "no ANSI, ever".
  if (out.NO_COLOR === undefined) out.NO_COLOR = '1';
  return out;
}

export function spawnProcess(opts: SpawnOptions): ProcessHandle {
  const commandLine = [opts.command, ...opts.args].join(' ');
  log.debug('spawn', { commandLine, cwd: opts.cwd, stdin: opts.stdin !== undefined });

  const child = spawn(opts.command, [...opts.args], {
    cwd: opts.cwd,
    env: buildEnv(opts.env),
    shell: false,
    windowsHide: true,
    stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });

  const outDecoder = new StringDecoder('utf8');
  const errDecoder = new StringDecoder('utf8');
  let outPending = '';
  let errPending = '';
  let stderrTail = '';
  let cancelled = false;
  let killTimer: NodeJS.Timeout | null = null;
  let stdoutEnded = false;
  let stderrEnded = false;

  if (opts.stdin !== undefined && child.stdin) {
    child.stdin.on('error', (e) => {
      // A child that exits before reading stdin yields EPIPE. Expected on
      // fast-failing CLIs; not worth failing the run over.
      log.debug('stdin write failed', { error: (e as Error).message });
    });
    child.stdin.end(opts.stdin, 'utf8');
  }

  if (child.stdout) {
    child.stdout.on('data', (buf: Buffer) => {
      outPending += outDecoder.write(buf);
      drainLines(outPending, opts.onStdoutLine, (rest) => {
        outPending = rest;
      });
    });
    child.stdout.on('end', () => {
      outPending += outDecoder.end();
      if (outPending.length) opts.onStdoutLine?.(outPending);
      outPending = '';
      stdoutEnded = true;
      onStreamsSettled?.();
    });
  }

  if (child.stderr) {
    child.stderr.on('error', () => {
      /* ignore */
    });
    child.stderr.on('data', (buf: Buffer) => {
      const chunk = errDecoder.write(buf);
      errPending += chunk;
      // Append the RAW decoded chunk, before line slicing. Slicing first and
      // then appending `errPending` would record only the trailing partial
      // line and silently drop every complete line — which is precisely the
      // content you need when a CLI prints a usage error and dies.
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
      drainLines(errPending, opts.onStderrLine, (rest) => {
        errPending = rest;
      });
    });
    child.stderr.on('end', () => {
      const tail = errDecoder.end();
      errPending += tail;
      stderrTail = (stderrTail + tail).slice(-STDERR_TAIL_LIMIT);
      if (errPending.length) {
        opts.onStderrLine?.(errPending);
        errPending = '';
      }
      stderrEnded = true;
      onStreamsSettled?.();
    });
  }

  const exited = new Promise<ExitInfo>((resolve) => {
    let settled = false;
    // `child.exitCode` is read-only in the Node typings, so the ENOENT case
    // is tracked here instead. 127 is the conventional "command not found".
    let spawnFailureCode: number | null = null;
    let exitSeen = false;
    let drainTimer: NodeJS.Timeout | null = null;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (drainTimer) clearTimeout(drainTimer);
      resolve({
        code: child.exitCode ?? spawnFailureCode,
        signal: child.signalCode,
        stderrTail: stderrTail.trim(),
      });
    };

    /**
     * The process itself is gone. Drain briefly for the tail, but never wait
     * on streams indefinitely — a lingering grandchild holds them open.
     */
    const onProcessExit = (): void => {
      if (settled) return;
      exitSeen = true;
      // Nothing more is coming if both streams already ended.
      if (stdoutEnded && stderrEnded) {
        finish();
        return;
      }
      drainTimer = setTimeout(finish, STDIO_DRAIN_GRACE_MS);
      if (typeof drainTimer.unref === 'function') drainTimer.unref();
      // Streams finished inside the grace window: no need to wait it out.
      onStreamsSettled = (): void => {
        if (exitSeen && settled === false) finish();
      };
    };

    child.on('error', (err: NodeJS.ErrnoException) => {
      // ENOENT/EACCES/EINVAL: the binary path is wrong or not executable.
      // Surface it loudly but still settle `exited` so waiters never hang.
      log.error('spawn failed', { command: opts.command, error: err.message });
      stderrTail = (stderrTail + `\nspawn error: ${err.message}`).slice(-STDERR_TAIL_LIMIT);
      spawnFailureCode = 127;
      finish();
    });

    // 'exit' is the reliable signal. 'close' may never arrive on Windows when a
    // grandchild inherited the pipes, so it is only a belt-and-braces path.
    child.on('exit', onProcessExit);
    child.on('close', onProcessExit);
  });

  // Assigned inside the promise executor, before any stream can end.
  let onStreamsSettled: (() => void) | null = null;

  const handle: ProcessHandle = {
    get pid() {
      return child.pid;
    },
    commandLine,
    exited,
    cancel(reason?: string) {
      if (cancelled || child.exitCode !== null) return;
      cancelled = true;
      const pid = child.pid;
      log.info('cancelling process', { pid, reason: reason ?? 'unspecified' });

      if (process.platform === 'win32') {
        // WINDOWS: kill the tree FIRST, with no grace period, and do not send
        // SIGINT at all.
        //
        // `taskkill /T` walks a LIVE process tree, so the root must still be
        // alive when it runs. But `child.kill('SIGINT')` on Windows calls
        // TerminateProcess, which kills the root immediately — after that
        // `/T` can no longer reach the orphaned grandchildren (Codex's
        // PowerShell children), and a later `taskkill` has no root to work
        // from. Verified live: SIGINT-then-taskkill left a `ping` grandchild
        // running, while taskkill-first removed the whole tree.
        //
        // Tradeoff, stated plainly: cancellation on Windows is forceful, so an
        // agent may be interrupted mid-write. The git working tree is the
        // source of truth, so this is recoverable; leaking processes is not.
        treeKill(pid);
      } else {
        // POSIX: a process group exists, so SIGINT can be delivered to the
        // whole tree gracefully and escalation only needed if it is ignored.
        try {
          child.kill('SIGINT');
        } catch {
          /* ignore */
        }
        killTimer = setTimeout(() => treeKill(pid), TREE_KILL_GRACE_MS);
        if (typeof killTimer.unref === 'function') killTimer.unref();
      }
    },
  };

  return handle;
}

/**
 * Kill a process and every descendant.
 *
 * Windows: `taskkill /T /F` is the only mechanism that reaches grandchildren —
 * `child.kill()` maps to TerminateProcess on the direct child alone. It is
 * issued while the root is still alive, so there is no recycled-PID hazard
 * (that is why no PID verification is needed here).
 */
function treeKill(pid: number | undefined): void {
  if (pid === undefined) return;

  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
    });
    killer.on('error', (e) => log.warn('taskkill failed', { pid, error: (e as Error).message }));
    killer.on('close', () => {
      /* ignore */
    });
    return;
  }

  // POSIX: a negative pid signals the whole process group.
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

function drainLines(
  buf: string,
  onLine: ((line: string) => void) | undefined,
  setRest: (rest: string) => void,
): void {
  if (!onLine) {
    // Still need to strip completed lines or the buffer grows unbounded.
    const last = Math.max(buf.lastIndexOf('\n'), buf.lastIndexOf('\r'));
    if (last >= 0) setRest(buf.slice(last + 1));
    return;
  }
  let start = 0;
  for (;;) {
    const nl = buf.indexOf('\n', start);
    if (nl === -1) break;
    let end = nl;
    if (end > start && buf.charCodeAt(end - 1) === 13) end -= 1; // CRLF
    const line = buf.slice(start, end);
    if (line.length) onLine(line);
    start = nl + 1;
  }
  setRest(buf.slice(start));
}
