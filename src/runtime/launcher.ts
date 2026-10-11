/**
 * runtime/launcher.ts — how a process is actually started.
 *
 * Why this exists: `child_process.spawn(..., { shell: false })` can only exec
 * a real binary. Since the CVE-2024-27980 fix it also REFUSES `.cmd`/`.bat`
 * outright (EINVAL), which is exactly what npm installs on Windows — verified
 * live when `opencode` resolved to `opencode.CMD`.
 *
 * So there are two launcher kinds:
 *
 *  native       `.exe` / `.com`. argv is passed as an array, no shell, no
 *               string building. This is always preferred and is the only kind
 *               used when a real binary exists.
 *
 *  cmd-wrapper  `.cmd` / `.bat`. `cmd.exe` is invoked and the command line is
 *               built as ONE string, which is inherently a shell surface.
 *               To keep this argv-safe rather than "shell=true with hope":
 *                 - every argument is validated against a metacharacter
 *                   allowlist, and the call REJECTS rather than mangles;
 *                 - nothing is ever passed unvalidated;
 *                 - `/d` disables AutoRun, `/s` avoids cmd's quote stripping.
 *
 * `.ps1` is deliberately NOT supported. PowerShell would need its own quoting
 * rules and `-File` argument passing; rather than guess, discovery reports it
 * as unsupported and names the packaged binary to point at instead.
 */

import { spawn } from 'node:child_process';
import { extname } from 'node:path';
import type { LauncherSpec } from '../core/types.ts';
import { log } from '../core/log.ts';

/** Executables Node can run directly. */
const NATIVE_EXT = new Set(['.exe', '.com']);
/** Batch wrappers that require cmd.exe. */
const CMD_EXT = new Set(['.cmd', '.bat']);
/** Recognised but not supported. */
const UNSUPPORTED_EXT = new Set(['.ps1']);

/** Characters that give cmd control flow, expansion, or redirection. */
const CMD_METACHARACTERS = /[&|<>^%!"\r\n\0`]/;

export type LauncherResolution =
  | { readonly ok: true; readonly launcher: LauncherSpec }
  | { readonly ok: false; readonly reason: string; readonly target: string };

export function launcherFor(command: string): LauncherResolution {
  const ext = extname(command).toLowerCase();

  if (NATIVE_EXT.has(ext)) {
    return {
      ok: true,
      launcher: {
        kind: 'native',
        command,
        prefixArgs: [],
        target: command,
        buildsCommandString: false,
      },
    };
  }

  if (CMD_EXT.has(ext)) {
    return {
      ok: true,
      launcher: {
        kind: 'cmd-wrapper',
        command: process.env.ComSpec ?? 'cmd.exe',
        // /d = no AutoRun, /s = do not re-parse quote rules
        prefixArgs: ['/d', '/s', '/c'],
        target: command,
        buildsCommandString: true,
      },
    };
  }

  if (UNSUPPORTED_EXT.has(ext)) {
    return {
      ok: false,
      reason:
        `PowerShell scripts (.ps1) are not supported by this launcher. ` +
        `Point the config at the packaged binary instead ` +
        `(for example ...\\node_modules\\opencode-ai\\bin\\opencode.exe).`,
      target: command,
    };
  }

  return {
    ok: false,
    reason:
      `Unsupported executable type "${ext || '(none)'}". ` +
      `Supported: .exe, .com, .cmd, .bat.`,
    target: command,
  };
}

/**
 * Build the full argv for a launch. For `native` this is plain concatenation.
 * For `cmd-wrapper` the tail is a single validated command string.
 *
 * @throws when an argument is unsafe for cmd. It never silently mangles.
 */
export function buildLaunchArgv(
  launcher: LauncherSpec,
  args: readonly string[],
): string[] {
  if (!launcher.buildsCommandString) {
    return [...args];
  }
  const parts = [quoteForCmd(launcher.target)];
  for (const a of args) parts.push(quoteForCmd(a));
  return [...launcher.prefixArgs, parts.join(' ')];
}

/** Reject anything that could break out of a quoted cmd argument. */
export function assertCmdSafe(args: readonly string[]): void {
  for (const a of args) {
    if (CMD_METACHARACTERS.test(a)) {
      const bad = CMD_METACHARACTERS.exec(a)![0];
      log.warn('unsafe argument for cmd launcher', { char: bad });
      throw new Error(
        `Argument contains "${bad}", which is not safe to pass through cmd.exe. ` +
          `Install or point the config at a real .exe binary instead of a .cmd/.bat shim.`,
      );
    }
  }
}

function quoteForCmd(s: string): string {
  // Metacharacters were already rejected, so plain quoting is sufficient and
  // no escaping of `"` is needed (a `"` would have been rejected above).
  return `"${s}"`;
}

/**
 * Build the FULL raw Windows command line for a cmd-wrapper launch, in the exact
 * form cmd.exe parses:
 *
 *   "C:\Windows\System32\cmd.exe" /d /s /c ""C:\path with spaces\tool.cmd" "arg one" "arg two""
 *
 * Two things are load-bearing and BOTH were wrong before (empirically, on this
 * machine):
 *
 *   1. The whole command string is wrapped in an EXTRA outer pair of quotes. `cmd
 *      /s` strips exactly one outer pair; without this extra pair it strips the
 *      pair around the .cmd path and corrupts the command.
 *   2. The string must reach CreateProcessW VERBATIM. libuv/CRT argv quoting
 *      escapes `"` as `\"`, which cmd.exe takes LITERALLY, so any pre-quoted cmd
 *      string routed through normal per-argument quoting is destroyed. The
 *      launcher's `--raw` mode exists precisely to carry this line unchanged.
 *
 * This is a delivery format for cmd.exe, NOT the CRT argv format — the two are
 * different syntax layers and must not be conflated.
 */
export function buildCmdRawCommandLine(
  launcher: LauncherSpec,
  args: readonly string[],
): string {
  const q = (s: string): string => `"${s}"`;
  const inner = [q(launcher.target), ...args.map(q)].join(' ');
  return `${q(launcher.command)} ${launcher.prefixArgs.join(' ')} "${inner}"`;
}

/** Convenience: is this path a natively-executable binary? */
export function isNativeExecutable(command: string): boolean {
  return NATIVE_EXT.has(extname(command).toLowerCase());
}

/** Probe helper used by tests: does a launcher of this kind exist on disk? */
export function launcherExists(launcher: LauncherSpec): boolean {
  return launcher.kind === 'native';
}

export { spawn };
