/**
 * src/runtime/offline-policy.ts — the OFFLINE test-process deny policy.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 * The reviewed offline suites must never be able to discover, authenticate or
 * launch a REAL coding agent (Codex / OpenCode / Cline / WorkBuddy / DSH). The
 * incident that motivated this file: `tests/cancel.test.ts` built a real
 * `Orchestrator`, which auto-discovered the real adapters and ran real Codex
 * sessions — a live, billable side effect that no test intended.
 *
 * A per-call `extraAdapters` override was NOT enough: the runtime still discovers
 * native adapters, and `extraAdapters` does not replace a same-ID adapter. Nor is a
 * higher "Spawn Gate" enough: the lower `Runtime.run`, adapter probes, the model
 * catalogue and `runApprovedTest` all create a `ManagedProcess` directly, bypassing
 * any orchestrator-level gate.
 *
 * ============================================================================
 * THE MODEL: FREEZE AT BOOTSTRAP, ENFORCE AT THE PROCESS EDGE
 * ============================================================================
 * 1. OFFLINE IS A ONE-WAY BOOTSTRAP FACT. `installOfflinePolicy()` is called from a
 *    trusted test bootstrap (`--import`) BEFORE any test code executes. There is
 *    deliberately NO API to promote offline -> live: a test cannot undo it, and an
 *    env var / config object cannot elevate it. Re-running it only ever re-asserts
 *    the same frozen state.
 *
 * 2. ENFORCEMENT IS AT THE SHARED PROCESS EDGE. `ManagedProcess` and the runtime
 *    launch preflight consult `evaluateOfflineSpawn()` before any OS process is
 *    created. Every path that launches an agent — `run`, adapter probe, model
 *    catalogue, `runApprovedTest`, transport, adapter — funnels through one of
 *    those two seams, so none of them is left unprotected.
 *
 * 3. IDENTITY, NOT DECLARATION. The decision is made from the ACTUAL launch inputs
 *    (launcher command/target and file-like argument tokens), never from
 *    `req.agentId`, a launcher `kind`, or an env ALLOW flag. A caller that lies
 *    about the agent id but hands over a real Codex executable is still refused.
 *
 * 4. NO FALSE POSITIVES ON FIXTURES. A token only counts as a real agent when its
 *    basename (minus a known executable extension) equals a known agent id AND the
 *    token actually resolves to an existing file on disk / on PATH. Controlled
 *    fixtures (`fixture.cmd`, `resident-version.cjs`, `fake-agent`, a node/git/
 *    launcher executable, or a non-existent path like `C:/fake/opencode.exe`) are
 *    therefore never mistaken for a real agent.
 *
 * RESIDUAL RISK (documented, not hidden): a same-user arbitrary shell cannot be
 * contained by JavaScript alone. A fixture that a test renames to a NON-agent
 * basename and points at a real binary would still run. This policy closes the
 * realistic paths (real adapters, real launcher commands, `node <agent>.js`), not
 * every theoretical one.
 */

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The agent identities matched by basename (case-insensitive). */
const BUILTIN_AGENT_IDS = Object.freeze([
  'opencode',
  'codex',
  'cline',
  'dsh',
  'workbuddy',
  'workbuddy-cn',
  'workbuddy-intl',
]);

/**
 * Real native launch TARGETS whose basename is NOT the agent id — a basename-only
 * id blacklist misses both of these on the real adapters:
 *
 *   - Cline launches `code-sidecar.exe` (NOT `cline`; see adapters/cline.ts).
 *   - WorkBuddy launches the extension-less `codebuddy` script through node.exe
 *     (see adapters/workbuddy.ts launchFor/resolveLaunch).
 *
 * These are the measured targets. `adapters/index.ts`, the shared factory table,
 * additionally REGISTERS them monotonically at import time (see
 * {@link denyExecutableBasename}), so the enforcement does not depend on discovery
 * having been run first.
 */
const BUILTIN_TARGET_ALIASES = Object.freeze(['code-sidecar', 'codebuddy']);

/**
 * The authoritative denial set. Module-private and mutable ONLY through
 * {@link denyExecutableBasename}, which can add but never remove/grant. It is the
 * single source `agentIdentityOf` reads, so the exported {@link FORBIDDEN_AGENT_IDS}
 * array is a frozen SNAPSHOT that a test cannot splice to silently widen the gate.
 */
const denied = new Set<string>([...BUILTIN_AGENT_IDS, ...BUILTIN_TARGET_ALIASES]);

/** A frozen SNAPSHOT of the denied identities (never the live authority). */
export const FORBIDDEN_AGENT_IDS: readonly string[] = Object.freeze([...denied]);

/**
 * REGISTER a real launch target as denied. Monotonic and deny-only: there is no
 * unmark/grant inverse, so a caller cannot use this to promote an agent to live.
 */
export function denyExecutableBasename(name: string): void {
  const id = name.trim().toLowerCase();
  if (id !== '') denied.add(id);
}

/** Executable extensions that are stripped before comparing a basename. */
const EXEC_EXTENSIONS = new Set(['.exe', '.com', '.cmd', '.bat', '.ps1', '.js', '.cjs', '.mjs']);

let frozen = false;
let frozenAt: string | null = null;

/**
 * The dedicated refusal code for a real-agent launch the offline policy refuses.
 *
 * A caller that must tell "the policy refused this launch" apart from a resolve/argv
 * failure matches on this CODE, never on a message. It is stamped on the branded
 * pre-spawn error the shared process edge throws (see `runtime/spawn.ts`); the runtime
 * launch preflight keeps its own `'offline-policy'` option code (`InvalidRequestError`).
 */
export const OFFLINE_AGENT_LAUNCH_REFUSED = 'OFFLINE_AGENT_LAUNCH_REFUSED';

/** This module's directory (`src/runtime`) and the repository root it lives under. */
const RUNTIME_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(RUNTIME_DIR, '..', '..');
/**
 * The ONE genuine live entry: the product CLI. A real agent may only ever be launched
 * by a process whose entry resolves to this file.
 */
const CLI_ENTRY = resolve(REPO_ROOT, 'src', 'cli', 'index.ts');

/** Windows path comparison is case-insensitive; POSIX is exact. */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * DEFAULT-DENY LIVE AUTHORIZATION — snapshotted ONCE, at module init.
 *
 * A real coding agent may be launched ONLY when BOTH hold:
 *
 *   1. the process entry resolves to the genuine live entry (`src/cli/index.ts`), and
 *   2. the process was started with the explicit whole-token `--live-agent` opt-in.
 *
 * The `smoke` command is excluded: it must remain freezable and can never self-enable
 * a real run, even if the flag is present. This is a one-way, init-time FACT — there
 * is deliberately no exported setter, no env var and no public API that can promote a
 * process to live. A test, a config object, or an env `ALLOW`-style flag all stay
 * denied; `installOfflinePolicy()` remains deny-only and monotonic.
 */
function computeLiveAuthorization(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  // Compare the RESOLVED PHYSICAL identity, not a lexical string: a different entry
  // that merely aliases the CLI (a symlink, a short/long path, a case variant) must
  // NOT be able to claim the genuine live entry. When either path cannot be resolved
  // for real, stay denied.
  let entryReal: string;
  let cliReal: string;
  try {
    entryReal = realpathSync(entry);
    cliReal = realpathSync(CLI_ENTRY);
  } catch {
    return false;
  }
  if (!samePath(entryReal, cliReal)) return false;
  const rawArgs = process.argv.slice(2);
  // The COMMAND is the ACTUAL argv[2] after removing the one permitted global flag
  // (`--live-agent`), i.e. the first CLI token — never the first arbitrary non-flag
  // value, which would let a leading `--config <value>` (or any `--flag <value>`)
  // masquerade as / hide the real command. `smoke` is excluded by exact command name.
  const cliArgs = rawArgs.filter((a) => a !== '--live-agent');
  const command = cliArgs[0];
  if (command === 'smoke') return false;
  return rawArgs.includes('--live-agent');
}
const liveAuthorized = computeLiveAuthorization();

/**
 * Freeze the OFFLINE deny policy. Idempotent and monotonic: it can only ever turn
 * an unset policy ON. There is no inverse.
 */
export function installOfflinePolicy(): void {
  if (frozen) return;
  frozen = true;
  frozenAt = new Date().toISOString();
}

/** Is the OFFLINE deny policy currently frozen? */
export function isOfflineFrozen(): boolean {
  return frozen;
}

/** Observable policy state for diagnostics and regression tests. */
export function offlinePolicyState(): {
  readonly frozen: boolean;
  readonly frozenAt: string | null;
  readonly forbiddenAgents: readonly string[];
} {
  // A frozen SNAPSHOT, never the live authority: exposing the mutable Set/array
  // would let a caller splice the gate open at runtime.
  return { frozen, frozenAt, forbiddenAgents: Object.freeze([...denied]) };
}

/** The launch inputs the policy inspects. Tolerant of malformed/ad-hoc descriptors. */
export interface OfflineSpawnInput {
  readonly launcher?: {
    readonly command?: unknown;
    readonly target?: unknown;
  } | null;
  readonly args?: readonly unknown[] | null;
  /**
   * The actual launch cwd. A RELATIVE path token is resolved against this (not
   * the checker's own cwd), so `existsSync('codex.exe')` can no longer miss a
   * real agent that lives beside the run's cwd — or, worse, falsely match one.
   */
  readonly cwd?: string;
  /**
   * The environment the launch would actually be spawned with. Merged ON TOP OF
   * `process.env` (case-insensitively) so PATH/PATHEXT resolution matches the real
   * child env, not the checker's ambient env.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface OfflineSpawnDecision {
  readonly allowed: boolean;
  /** The offending token exactly as it appeared in the launch inputs. */
  readonly offendingExecutable?: string;
  /** The agent identity the token resolved to. */
  readonly identity?: string;
  readonly reason?: string;
}

/** Strip a known executable extension (if any) and normalise a basename. */
function agentIdentityOf(token: string): string | null {
  const base = basename(token);
  if (base.length === 0) return null;
  const ext = extname(base).toLowerCase();
  const stem = EXEC_EXTENSIONS.has(ext) ? base.slice(0, base.length - ext.length) : base;
  const id = stem.toLowerCase();
  return denied.has(id) ? id : null;
}

/** Does this token look like a filesystem path (rather than a flag or prompt)? */
function looksLikePath(token: string): boolean {
  if (token.length === 0) return false;
  if (token.includes('/') || token.includes('\\')) return true;
  if (/^[a-zA-Z]:/.test(token)) return true;
  const ext = extname(token).toLowerCase();
  return EXEC_EXTENSIONS.has(ext);
}

/**
 * A case-insensitive environment view over `input.env` MERGED ON TOP OF `process.env`,
 * matching the environment a launch would actually be spawned with (Windows env keys
 * are case-insensitive). The launch env wins where it defines a key.
 */
function mergedEnv(input: Readonly<Record<string, string | undefined>> | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) map.set(k.toUpperCase(), v);
  }
  if (input !== undefined) {
    for (const [k, v] of Object.entries(input)) {
      if (v !== undefined) map.set(k.toUpperCase(), v);
    }
  }
  return map;
}

/** Resolve a BARE name against the effective PATH + PATHEXT, or null. */
function resolveOnPath(name: string, env: Map<string, string>): string | null {
  const path = env.get('PATH');
  if (path === undefined || path === '') return null;
  const exts = (env.get('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e.length > 0);
  const candidates = extname(name) === '' ? [name, ...exts.map((e) => name + e)] : [name];
  for (const dir of path.split(';')) {
    if (dir === '') continue;
    for (const cand of candidates) {
      const full = join(dir, cand);
      try {
        if (existsSync(full)) return full;
      } catch {
        // A malformed PATH entry is not an error; it simply does not resolve.
      }
    }
  }
  return null;
}

/**
 * A token is a FILESYSTEM PATH only when it actually carries a path syntax: an
 * absolute path, a path separator, or a drive/`\\\\` prefix. An executable SUFFIX
 * (`.exe`, `.cmd`, …) does NOT make a BARE name a path — otherwise `codex.exe` would be
 * probed against the checker's own cwd and the effective PATH would never be consulted.
 */
function isFilesystemPath(token: string): boolean {
  if (token.length === 0) return false;
  if (token.includes('/') || token.includes('\\')) return true;
  return /^[a-zA-Z]:/.test(token);
}

/**
 * Does the token actually point at something on disk?
 *
 * A real path is probed directly, or resolved against the ACTUAL launch cwd. A BARE
 * name (including one with an executable suffix such as `codex.exe`) is resolved
 * against the ACTUAL launch cwd first, then the effective PATH/PATHEXT — never against
 * the checker's own cwd.
 */
function tokenResolves(token: string, cwd: string | undefined, env: Map<string, string>): boolean {
  if (isFilesystemPath(token)) {
    if (isAbsolute(token)) {
      try {
        return existsSync(token);
      } catch {
        return false;
      }
    }
    // A RELATIVE path must be resolved against the ACTUAL launch cwd, not the
    // checker's own cwd.
    if (cwd !== undefined && cwd !== '') {
      try {
        return existsSync(resolve(cwd, token));
      } catch {
        return false;
      }
    }
    return false;
  }
  const exts = (env.get('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e.length > 0);
  const bare = extname(token) === '' ? [token, ...exts.map((e) => token + e)] : [token];
  if (cwd !== undefined && cwd !== '') {
    for (const cand of bare) {
      try {
        if (existsSync(join(cwd, cand))) return true;
      } catch {
        // A malformed cwd simply does not resolve.
      }
    }
  }
  return resolveOnPath(token, env) !== null;
}

/**
 * Evaluate whether a launch may proceed.
 *
 * DEFAULT-DENY: returns `{ allowed: true }` only when this process is a genuine live
 * entry (the CLI, started with `--live-agent`), or when no real agent executable is
 * present in the launch inputs. A frozen offline suite, a direct `npm run` script, or a
 * recreated runtime in a test all refuse a real agent.
 */
export function evaluateOfflineSpawn(input: OfflineSpawnInput): OfflineSpawnDecision {
  /*
   * DEFAULT-DENY. Only a process that is a GENUINE live entry (the product CLI, started
   * with the explicit `--live-agent` whole-token opt-in) may launch a real agent.
   *
   * Every other process — a frozen offline test suite, a direct `npm run` script, or a
   * recreated runtime inside a test — falls through to the identity inspection below and
   * refuses a real agent. Non-agent children (a controlled node fixture, git, a benign
   * shell) never match an agent identity, so they are unaffected.
   */
  // Offline FREEZING always wins: even the genuine live entry may not launch a real
  // agent once the offline policy is frozen (a test bootstrap froze it one-way).
  if (liveAuthorized && !frozen) return { allowed: true };

  const env = mergedEnv(input.env);
  const tokens: string[] = [];
  const command = input.launcher?.command;
  const target = input.launcher?.target;
  if (typeof command === 'string') tokens.push(command);
  if (typeof target === 'string') tokens.push(target);

  // A `node <agent>.js` launch carries the real executable in the ARGS, not the
  // launcher command. Only inspect argument tokens that look like a file path, so an
  // `-e "codex"` payload or a prompt containing the word `codex` is not matched.
  for (const arg of input.args ?? []) {
    if (typeof arg !== 'string' || !looksLikePath(arg)) continue;
    tokens.push(arg);
  }

  for (const token of tokens) {
    const identity = agentIdentityOf(token);
    if (identity === null) continue;
    if (!tokenResolves(token, input.cwd, env)) continue;
    return {
      allowed: false,
      offendingExecutable: token,
      identity,
      reason: frozen
        ? `refusing to launch real agent "${identity}" while the offline test policy is frozen`
        : `refusing to launch real agent "${identity}": a real agent launch requires the explicit --live-agent opt-in from the genuine CLI entry`,
    };
  }
  return { allowed: true };
}

/** Human-readable detail for a denied launch. */
export function describeOfflineDenial(decision: OfflineSpawnDecision): string {
  if (decision.allowed) return 'offline policy: launch allowed';
  // The DEDICATED refusal code is prefixed into the message so a caller that only sees
  // a human-readable note (e.g. `runApprovedTest`'s note, which embeds `error.message`)
  // can match the stable code WITHOUT depending on prose. The branded error object keeps
  // its `.code` and private proven-not-started brand as before.
  return (
    `${OFFLINE_AGENT_LAUNCH_REFUSED}: offline test policy refused launch of real agent ` +
    `"${decision.identity}" (${decision.offendingExecutable})`
  );
}
