/**
 * runtime/discover.ts — find a native agent binary on Windows.
 *
 * This exists because two verified facts made naive `spawn('codex')` and
 * `spawn('opencode')` both fail on this machine:
 *
 *  - `opencode` on PATH is a shim. Node cannot execute `.cmd`/`.bat` at all
 *    without a shell (EINVAL since the CVE-2024-27980 fix), and a `.ps1` needs
 *    PowerShell. `runtime/launcher.ts` decides how each is launched; this
 *    module only decides WHICH file to launch.
 *  - `codex` was not on PATH at all; it ships with the desktop app.
 *
 * Resolution order:
 *   1. explicit path from config
 *   2. per-agent known install locations
 *   3. PATH, preferring a natively executable file over a shim
 *   4. npm-global package layout
 *
 * Known locations precede PATH on purpose: a shim on PATH is less useful than
 * the real binary one level deeper inside the package.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';
import { log } from '../core/log.ts';
import { LauncherResolutionError } from '../core/errors.ts';
import { launcherFor, type LauncherResolution } from './launcher.ts';
import type { LauncherSpec } from '../core/types.ts';

const NATIVE_EXT = new Set(['.exe', '.com']);
const SHIM_EXT = new Set(['.cmd', '.bat', '.ps1']);

export function resolveCommand(
  agentId: string,
  configured?: string,
  extraCandidates: readonly string[] = [],
): { launcher: LauncherSpec } {
  const tried: string[] = [];
  const candidates: string[] = [];

  // 1. Explicit config wins, but only if the file is real.
  if (configured) {
    if (isAbsolute(configured) || configured.includes('\\') || configured.includes('/')) {
      const abs = resolve(configured);
      if (!existsSync(abs)) {
        throw new LauncherResolutionError(`Configured command for "${agentId}" does not exist: ${abs}`);
      }
      return { launcher: mustLaunch(abs, agentId) };
    }
    const viaPath = searchPath(configured);
    if (viaPath) return { launcher: mustLaunch(viaPath, agentId) };
    tried.push(`config name "${configured}" (not found on PATH)`);
  }

  // Gather candidates: extras first, then per-agent known locations.
  candidates.push(...extraCandidates, ...agentCandidates(agentId));

  // 2/3/4. First natively-executable file wins, in candidate order. Shims are
  // kept aside so a "only a shim exists" message can name them.
  const shims: string[] = [];
  for (const cand of candidates) {
    if (!existsSync(cand) || !isFile(cand)) {
      tried.push(cand);
      continue;
    }
    if (NATIVE_EXT.has(extname(cand).toLowerCase())) {
      return { launcher: mustLaunch(cand, agentId) };
    }
    shims.push(cand);
  }

  // PATH lookup, still preferring a real binary over a shim.
  const onPath = searchPath(agentId);
  if (onPath) return { launcher: mustLaunch(onPath, agentId) };
  tried.push(`PATH entry "${agentId}"`);

  const npmHit = findNpmGlobalBinary(agentId);
  if (npmHit) return { launcher: mustLaunch(npmHit, agentId) };

  // Nothing runnable. Name the shims we DID find so the fix is obvious.
  const shimHit = shims[0] ?? findShimOnPath(agentId);
  if (shimHit) {
    const res: LauncherResolution = launcherFor(shimHit);
    if (res.ok) return { launcher: res.launcher };
    throw new LauncherResolutionError(
      `Found only "${shimHit}" for "${agentId}", which this launcher cannot run.\n${res.reason}`,
    );
  }

  throw new LauncherResolutionError(
    `Could not locate a runnable binary for "${agentId}". Tried:\n  ${tried.join('\n  ')}\n` +
      `Set {"agents":{"${agentId}":{"command":"<absolute path>"}}} in orchestrator.json.`,
  );
}

function mustLaunch(path: string, agentId: string): LauncherSpec {
  const res = launcherFor(path);
  if (!res.ok) {
    throw new LauncherResolutionError(`Agent "${agentId}": ${res.reason} (${path})`);
  }
  return res.launcher;
}

/**
 * PATH lookup. A bare name gets PATHEXT applied; a natively executable file
 * always beats a `.cmd`/`.bat`/`.ps1` shim at the same or higher priority,
 * because a shim is only a fallback.
 */
export function searchPath(name: string): string | null {
  const path = process.env.PATH ?? '';
  const dirs = path.split(delimiter).filter(Boolean);
  const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM;.PS1')
    .split(';')
    .map((e) => e.toLowerCase())
    .filter(Boolean);
  const hasExt = extname(name) !== '';

  let shim: string | null = null;
  for (const dir of dirs) {
    const names = hasExt
      ? [name]
      : [...exts.map((e) => name + e.toUpperCase()), ...exts.map((e) => name + e)];
    for (const n of names) {
      const full = join(dir, n);
      if (!existsSync(full) || !isFile(full)) continue;
      const ext = extname(full).toLowerCase();
      if (NATIVE_EXT.has(ext)) return full;
      if (SHIM_EXT.has(ext) && !shim) shim = full;
    }
  }
  return shim;
}

function findShimOnPath(name: string): string | null {
  const path = process.env.PATH ?? '';
  for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const ext of SHIM_EXT) {
      const full = join(dir, name + ext);
      if (existsSync(full) && isFile(full)) return full;
    }
  }
  return null;
}

/** Per-agent install locations. Windows-relevant; PATH/npm covers the rest. */
function agentCandidates(agentId: string): string[] {
  const home = homedir();
  const local = process.env.LOCALAPPDATA;
  const roaming = process.env.APPDATA;

  switch (agentId) {
    case 'opencode': {
      const out: string[] = [];
      if (roaming) {
        out.push(join(roaming, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'));
      }
      out.push(join(home, '.opencode', 'bin', 'opencode.exe'), join(home, '.local', 'bin', 'opencode.exe'));
      return out;
    }
    case 'codex': {
      const out: string[] = [
        // Ships with the desktop app; NOT on PATH (verified on this machine).
        join(home, '.codex', 'plugins', '.plugin-appserver', 'codex.exe'),
        join(home, '.codex', 'bin', 'codex.exe'),
      ];
      if (local) {
        out.push(join(local, 'OpenAI', 'Codex', 'bin', 'codex.exe'));
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
      // Unknown agents: nothing special. Extending agent support is exactly a
      // new entry here plus a factory in adapters/index.ts.
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
  const home = homedir();
  prefixes.push(join(home, '.npm-global'), join(home, 'AppData', 'Roaming', 'npm'));

  for (const prefix of prefixes) {
    for (const base of ['node_modules', 'lib/node_modules', '']) {
      const pkgRoot = join(prefix, ...(base ? base.split('/') : []), pkg);
      if (!existsSync(pkgRoot)) continue;
      for (const leaf of ['bin', '', 'dist']) {
        const dir = leaf ? join(pkgRoot, leaf) : pkgRoot;
        if (!existsSync(dir)) continue;
        for (const entry of safeReaddir(dir)) {
          const ext = extname(entry).toLowerCase();
          if (entry.startsWith(agentId) && NATIVE_EXT.has(ext)) return join(dir, entry);
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
