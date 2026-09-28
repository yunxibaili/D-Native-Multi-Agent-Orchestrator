/**
 * runtime/discover.ts — find a native agent binary on Windows.
 *
 * This module exists because two verified facts made naive `spawn('codex')`
 * and `spawn('opencode')` both fail on this machine:
 *
 *  - `opencode` on PATH is `C:\...\Roaming\npm\opencode.ps1`. Node cannot
 *    execute a `.ps1` with `shell: false`, and running it *with* a shell
 *    re-quotes every argument. We resolve to the packaged `.exe` instead.
 *  - `codex` is not on PATH at all. It ships with the OpenAI Codex desktop
 *    app, so it has to be discovered in the filesystem.
 *
 * Order of resolution:
 *   1. explicit path from config (must exist)
 *   2. PATH, preferring a real executable over a script shim
 *   3. per-agent known install locations
 *   4. npm-global package layout
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter, isAbsolute, resolve, extname } from 'node:path';
import { log } from '../core/log.ts';

/**
 * Extensions Node can exec directly with `shell: false` on Windows.
 *
 * `.cmd` and `.bat` are deliberately ABSENT. Since the CVE-2024-27980 fix,
 * `child_process.spawn` refuses to run a batch file without a shell and
 * throws `EINVAL`. This was caught live: resolving `opencode` through the
 * npm shim `opencode.CMD` produced exactly that error. `opencode` and
 * `codex` both ship a real `.exe`, so we require one.
 */
const EXEC_EXT = new Set(['.exe', '.com']);
/** Script shims we can find but cannot exec directly. */
const SHIM_EXT = new Set(['.cmd', '.bat', '.ps1']);

export interface DiscoveryResult {
  command: string;
  /** How we found it, for `doctor` output. */
  via: string;
}

/**
 * Order of resolution:
 *   1. explicit path from config (must exist AND be directly executable)
 *   2. per-agent known install locations
 *   3. PATH, restricted to extensions Node can exec without a shell
 *   4. npm-global package layout
 *
 * Known locations deliberately precede PATH. `opencode` is on PATH only as
 * `opencode.CMD` (unusable), while the real `opencode.exe` lives one level
 * deeper inside the package. Finding the real binary by construction beats
 * hoping PATH happens to contain it.
 */
export function resolveCommand(
  agentId: string,
  configured?: string,
  extraCandidates: readonly string[] = [],
): DiscoveryResult {
  const tried: string[] = [];

  // 1. Explicit config wins, but only if it is real AND directly executable.
  if (configured) {
    if (isAbsolute(configured) || configured.includes('\\') || configured.includes('/')) {
      const abs = resolve(configured);
      if (!existsSync(abs)) {
        throw new Error(`Configured command for "${agentId}" does not exist: ${abs}`);
      }
      if (!isDirectlyExecutable(abs)) {
        throw new Error(
          `Configured command for "${agentId}" is a script shim: ${abs}\n` +
            `Node cannot execute .cmd/.bat/.ps1 without a shell. ` +
            `Point the config at the packaged .exe ` +
            `(e.g. ...\\node_modules\\opencode-ai\\bin\\opencode.exe).`,
        );
      }
      return { command: abs, via: 'config' };
    }
    const viaPath = searchPath(configured);
    if (viaPath) return { command: viaPath, via: 'config+PATH' };
    tried.push(`config name "${configured}" (no .exe on PATH)`);
  }

  // 2. Known locations.
  for (const cand of [...extraCandidates, ...agentCandidates(agentId)]) {
    if (existsSync(cand) && isFile(cand) && isDirectlyExecutable(cand)) {
      return { command: cand, via: `known:${cand}` };
    }
    tried.push(cand);
  }

  // 3. PATH, executable extensions only.
  const named = searchPath(agentId);
  if (named) return { command: named, via: 'PATH' };
  tried.push(`PATH entry "${agentId}" (no .exe/.com)`);

  // 4. npm layout.
  const npmHit = findNpmGlobalBinary(agentId);
  if (npmHit) return { command: npmHit, via: `npm-global:${npmHit}` };

  const shim = findScriptShim(agentId);
  if (shim) {
    throw new Error(
      `Found only a script shim for "${agentId}" at ${shim}.\n` +
        `Windows/Node cannot execute it without a shell. Install a real binary, ` +
        `or set {"agents":{"${agentId}":{"command":"<absolute path to .exe>"}}}.`,
    );
  }

  throw new Error(
    `Could not locate "${agentId}". Tried:\n  ${tried.join('\n  ')}\n` +
      `Set {"agents":{"${agentId}":{"command":"<absolute path>"}}} in orchestrator.json.`,
  );
}

function isDirectlyExecutable(p: string): boolean {
  return EXEC_EXT.has(extname(p).toLowerCase());
}

/**
 * PATH lookup that prefers real executables. A bare name with no extension
 * gets PATHEXT applied, but a `.ps1` on PATH is only returned as a last resort
 * (and the caller treats it as an error, not a win).
 */
function searchPath(name: string): string | null {
  const path = process.env.PATH ?? '';
  const dirs = path.split(delimiter).filter(Boolean);
  const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((e) => e.toLowerCase())
    .filter(Boolean);

  const hasExt = extname(name) !== '';

  for (const dir of dirs) {
    const candidates = hasExt
      ? [name]
      : [...exts.map((e) => name + e.toUpperCase()), ...exts.map((e) => name + e)];
    for (const c of candidates) {
      const full = join(dir, c);
      if (existsSync(full) && isFile(full) && !isDir(full)) {
        const ext = extname(full).toLowerCase();
        if (EXEC_EXT.has(ext)) return full;
      }
    }
  }
  return null;
}

/**
 * Find a shim we can name but not exec. Used only to produce a better error
 * than "not found", so that the operator learns about `opencode.CMD`.
 */
function findScriptShim(name: string): string | null {
  const path = process.env.PATH ?? '';
  for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const ext of SHIM_EXT) {
      const full = join(dir, name + ext);
      if (existsSync(full) && isFile(full)) return full;
    }
  }
  return null;
}

/**
 * Per-agent install locations. Only Windows-relevant paths are listed; on
 * other platforms PATH/npm resolution is sufficient.
 */
function agentCandidates(agentId: string): string[] {
  const home = homedir();
  const local = process.env.LOCALAPPDATA;
  const roaming = process.env.APPDATA;

  switch (agentId) {
    case 'opencode': {
      const out: string[] = [];
      if (roaming) {
        out.push(
          join(roaming, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
        );
      }
      out.push(
        join(home, '.opencode', 'bin', 'opencode.exe'),
        join(home, '.local', 'bin', 'opencode.exe'),
      );
      return out;
    }
    case 'codex': {
      const out: string[] = [
        // Verified on this machine: ships with the Codex desktop app and is
        // NOT on PATH.
        join(home, '.codex', 'plugins', '.plugin-appserver', 'codex.exe'),
        join(home, '.codex', 'bin', 'codex.exe'),
      ];
      if (local) {
        out.push(join(local, 'OpenAI', 'Codex', 'bin', 'codex.exe'));
        // The app keeps versioned dirs under bin/; glob the latest.
        const binRoot = join(local, 'OpenAI', 'Codex', 'bin');
        if (existsSync(binRoot)) {
          for (const entry of safeReaddir(binRoot)) {
            out.push(join(binRoot, entry, 'codex.exe'));
          }
        }
      }
      return out;
    }
    default:
      return [];
  }
}

/** npm -g layout: <prefix>/node_modules/<pkg>/bin/<name>.exe */
function findNpmGlobalBinary(agentId: string): string | null {
  const pkgFor: Record<string, string> = {
    opencode: 'opencode-ai',
    codex: '@openai/codex',
  };
  const pkg = pkgFor[agentId];
  if (!pkg) return null;

  const prefixes: string[] = [];
  if (process.env.APPDATA) prefixes.push(join(process.env.APPDATA, 'npm'));
  prefixes.push(join(homedir(), '.npm-global'));
  prefixes.push(join(homedir(), 'AppData', 'Roaming', 'npm'));

  for (const prefix of prefixes) {
    for (const base of ['node_modules', 'lib', 'node_modules', '']) {
      const pkgRoot = join(prefix, ...(base ? base.split('/') : []), pkg);
      if (!existsSync(pkgRoot)) continue;
      for (const leaf of ['bin', '', 'dist']) {
        const dir = leaf ? join(pkgRoot, leaf) : pkgRoot;
        if (!existsSync(dir)) continue;
        for (const entry of safeReaddir(dir)) {
          const ext = extname(entry).toLowerCase();
          if (entry.startsWith(agentId) && EXEC_EXT.has(ext)) {
            return join(dir, entry);
          }
        }
      }
    }
  }
  return null;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (e) {
    log.debug('readdir failed', { dir, error: (e as Error).message });
    return [];
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
