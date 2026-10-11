/**
 * runtime/model-catalog.ts — a READ-ONLY native model-catalogue snapshot (B1.1).
 *
 * ============================================================================
 * WHAT THIS IS (and is NOT)
 * ============================================================================
 * A user explicitly asks `doctor --models <agent>` and gets back what the AGENT'S
 * OWN CLI lists, unmodified. This is a diagnostic surface, nothing more.
 *
 * It is NOT an authority and it changes nothing:
 *   - it never calls `ModelRegistry.upsert` / `setAgentAvailability` /
 *     `setModelAvailability`, so a listed model never becomes a scheduling candidate;
 *   - it never touches quota, budget, cost authorization, or user selection;
 *   - it never influences `assignWorker` or the Spawn Gate.
 *
 * FROZEN FACT BOUNDARY — the four states are DIFFERENT and must not be merged:
 *
 *   listed      what the agent's CLI printed (this module)
 *   connected   whether the agent is logged in  (UNKNOWN here — not read)
 *   callable    whether a model actually answers (UNKNOWN here — never invoked)
 *   free        whether a model costs nothing   (UNKNOWN here — a name or a
 *               catalogue cost column is NOT evidence of free)
 *
 * ============================================================================
 * B1.1a — CONTAINMENT, NOT A BARE execFile
 * ============================================================================
 * The catalogue command runs through the SAME production containment path as any
 * other agent execution: `ManagedProcess` (Windows Job launcher, cooperative stop,
 * tree-stop confirmation). The previous version used the quota `execRunner`
 * (a plain `execFile` with a timeout); a review reproduced that on timeout the
 * root was killed while a native DESCENDANT stayed alive — `execFile` bounds one
 * process, not a tree.
 *
 * So the default path here:
 *   - launches through `ManagedProcess` (LauncherSpec + sealed Job launcher);
 *   - on timeout requests the COOPERATIVE Job stop and requires the launcher to
 *     CONFIRM `ActiveProcesses == 0`;
 *   - refuses to report a catalogue as collected when the tree stop was NOT
 *     confirmed, and never uses the root's exit as proof the tree stopped.
 *
 * The quota `execRunner` is deliberately NOT changed or reused for execution.
 *
 * This slice supports ONLY agents whose native catalogue command is known and
 * verified. Today that is exactly `opencode models` (provider/model per line).
 * Any other agent is reported `unsupported`; its output format is never assumed to
 * match OpenCode's.
 */

import { ManagedProcess } from './spawn.ts';
import { containmentEnabled } from './containment.ts';
import { resolveCommand } from './discover.ts';
import { buildLaunchArgv } from './launcher.ts';
import { stripAnsi, type CmdRunner, type RunOutcome } from '../quota/collector.ts';

/**
 * Result state of one catalogue query.
 *
 *  - `ok`          the CLI ran, exited 0, listed at least one model, tree stop confirmed
 *  - `empty`       the CLI ran and exited 0 but listed nothing (a real empty answer)
 *  - `unsupported` this build has no verified catalogue command for the agent
 *  - `failed`      could not collect: non-zero exit, timeout, launch failure,
 *                  unparseable output, or an UNCONFIRMED process-tree stop.
 *                  PARTIAL stdout is NEVER promoted to `ok`.
 *  - `not_collected` no query was run (explicitly disabled by the caller)
 */
export const CATALOG_STATUSES = ['ok', 'empty', 'unsupported', 'failed', 'not_collected'] as const;
export type CatalogStatus = (typeof CATALOG_STATUSES)[number];

/** One listed model, with its FULL provider/model identity preserved. */
export interface CatalogModel {
  readonly agentId: string;
  /** Full identity exactly as listed, e.g. `anthropic/claude-sonnet-4-5`. */
  readonly modelId: string;
  /** The provider segment (everything before the first `/`). */
  readonly provider: string;
  /** How this entry was obtained, e.g. `opencode models`. */
  readonly source: string;
  /** Epoch ms the catalogue was captured. */
  readonly listedAt: number;
}

/** An immutable, self-contained catalogue snapshot. Read-only by construction. */
export interface ModelCatalogSnapshot {
  readonly agentId: string;
  readonly status: CatalogStatus;
  /** The command/source used, or the reason when not collected / unsupported. */
  readonly source: string;
  /** Epoch ms the snapshot was taken (0 when nothing was collected). */
  readonly listedAt: number;
  /** De-duplicated, in the CLI's own stable order. Empty unless status is `ok`. */
  readonly models: readonly CatalogModel[];
  /** Human explanation, mandatory whenever status is not `ok`. */
  readonly note: string;
}

/**
 * The raw outcome of running the catalogue command, before any status decision.
 *
 * `treeStopConfirmed` is the containment fact: it is true ONLY when the physical
 * process tree was positively confirmed stopped. For an INJECTED runner it is
 * `true` because the injected boundary owns its own process contract.
 */
export interface CatalogRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly treeStopConfirmed: boolean;
}

/**
 * Agents whose native catalogue command this build knows and has verified.
 * Everything else is `unsupported` — its format is never assumed.
 */
export const CATALOG_SUPPORTED_AGENTS: readonly string[] = ['opencode'];

export function isCatalogSupported(agentId: string): boolean {
  return CATALOG_SUPPORTED_AGENTS.includes(agentId);
}

/** The exact argv appended to the agent launcher for its catalogue. */
function catalogArgsFor(agentId: string): readonly string[] | null {
  if (agentId === 'opencode') return ['models'];
  return null;
}

export interface ParsedCatalog {
  readonly models: ReadonlyArray<{ readonly provider: string; readonly modelId: string }>;
  /** Lines that were present but did not look like a catalogue entry. */
  readonly rejected: readonly string[];
}

/**
 * Parse `opencode models` stdout. PURE: text in, data out — no process, no clock.
 *
 * A catalogue entry is exactly one `provider/model` token on its own line:
 *   - ANSI is stripped first, so piped and interactive output parse identically;
 *   - a line containing whitespace is NOT a model (headers, tables, or `--verbose`
 *     metadata columns) and is recorded as rejected rather than guessed at;
 *   - the provider is the segment before the FIRST `/`; the full `provider/model`
 *     string is preserved as the identity (models may themselves contain `/`);
 *   - duplicates are collapsed, keeping the CLI's first-seen order.
 */
export function parseOpenCodeModelList(stdout: string): ParsedCatalog {
  const models: Array<{ provider: string; modelId: string }> = [];
  const rejected: string[] = [];
  const seen = new Set<string>();

  for (const raw of stripAnsi(stdout).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (/\s/.test(line)) {
      rejected.push(line);
      continue;
    }
    const slash = line.indexOf('/');
    if (slash <= 0 || slash === line.length - 1) {
      rejected.push(line);
      continue;
    }
    if (seen.has(line)) continue;
    seen.add(line);
    models.push({ provider: line.slice(0, slash), modelId: line });
  }
  return { models, rejected };
}

/**
 * The PURE status decision: raw run outcome -> snapshot. No process, no clock.
 *
 * Fail-closed, in this order:
 *   1. an UNCONFIRMED tree stop is a failure — a leaked descendant must never be
 *      reported as a collected catalogue;
 *   2. a non-zero / null exit is a failure; partial stdout is discarded;
 *   3. only then is stdout parsed: entries => ok, truly-empty => empty,
 *      otherwise => failed (unparseable).
 *
 * Exposed so the hermetic test can exercise the "unconfirmed cleanup" branch
 * directly without having to provoke a real OS failure.
 */
export function catalogSnapshotFromRun(
  run: CatalogRun,
  agentId: string,
  source: string,
  listedAt: number,
): ModelCatalogSnapshot {
  if (!run.treeStopConfirmed) {
    return {
      agentId,
      status: 'failed',
      source,
      listedAt,
      models: [],
      note: 'process-tree stop was NOT confirmed; refusing to report the catalogue as collected (partial output discarded)',
    };
  }
  if (run.code !== 0) {
    const tail = stripAnsi(run.stderr).trim().split(/\r?\n/).slice(-1)[0] ?? '';
    return {
      agentId,
      status: 'failed',
      source,
      listedAt,
      models: [],
      note:
        run.code === null
          ? `catalogue command did not exit (timeout or killed); partial output discarded`
          : `catalogue command exited ${run.code}${tail ? `: ${tail.slice(0, 200)}` : ''}; partial output discarded`,
    };
  }
  const parsed = parseOpenCodeModelList(run.stdout);
  if (parsed.models.length > 0) {
    return {
      agentId,
      status: 'ok',
      source,
      listedAt,
      models: parsed.models.map((m) => ({ agentId, modelId: m.modelId, provider: m.provider, source, listedAt })),
      note: '',
    };
  }
  if (stripAnsi(run.stdout).trim() === '') {
    return { agentId, status: 'empty', source, listedAt, models: [], note: 'the CLI listed no models' };
  }
  const sample = parsed.rejected[0]?.slice(0, 120) ?? '';
  return {
    agentId,
    status: 'failed',
    source,
    listedAt,
    models: [],
    note: `catalogue output could not be parsed (${parsed.rejected.length} unrecognised line(s))${sample ? `; first: ${sample}` : ''}`,
  };
}

export interface CollectCatalogOptions {
  /**
   * TEST-ONLY injected command boundary. When present it REPLACES the contained
   * execution, so the parser/status tests never start a process. It is documented
   * as a test seam: it owns its own process/cleanup contract.
   */
  runner?: CmdRunner;
  /** Configured command override for the agent (from orchestrator.json). */
  command?: string;
  timeoutMs?: number;
  /** Clock seam for tests. */
  now?: () => number;
  /**
   * When false, NOTHING is executed and the snapshot is `not_collected`. This is
   * what makes "default doctor never runs a catalogue query" provable.
   */
  enabled?: boolean;
}

/** A `not_collected` snapshot: no process, no clock, no side effect. */
export function notCollectedCatalog(agentId: string): ModelCatalogSnapshot {
  return {
    agentId,
    status: 'not_collected',
    source: 'not collected',
    listedAt: 0,
    models: [],
    note: `model catalogue not collected (pass --models ${agentId} to query the agent's own CLI)`,
  };
}

/**
 * Run the catalogue command through the PRODUCTION containment path.
 *
 * On timeout this requests the cooperative Job stop and returns the launcher's
 * CONFIRMED tree-stop fact; a stop that cannot be confirmed comes back
 * `treeStopConfirmed: false`, which `catalogSnapshotFromRun` turns into a failure.
 * Nothing here uses a bare pid/name kill, and the root's exit is never treated as
 * proof that the tree stopped.
 *
 * B1.1b P2: the deadline timer is EXPLICITLY cleared on every exit path (success,
 * timeout, throw) — mirroring `waitBounded` in `spawn.ts`. Leaving it alive would
 * keep the event loop — and therefore the whole diagnostic process — alive until
 * the timeout elapsed even though the query had already finished.
 */
async function runContainedCatalog(
  launcher: Parameters<typeof buildLaunchArgv>[0],
  args: readonly string[],
  timeoutMs: number,
): Promise<CatalogRun> {
  let stdout = '';
  let stderr = '';
  const proc = new ManagedProcess({
    launcher,
    args,
    cwd: process.cwd(),
    onStdoutLine: (l) => { stdout += l + '\n'; },
    onStderrLine: (l) => { stderr += l + '\n'; },
  });

  const contained = containmentEnabled();

  let deadline: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((res) => {
    deadline = setTimeout(() => res('timeout'), timeoutMs);
    // Unref'd as a belt-and-braces guard; `clearTimeout` below is the real release.
    if (typeof deadline.unref === 'function') deadline.unref();
  });
  let settled: 'exited' | 'timeout';
  try {
    settled = await Promise.race([proc.exited.then(() => 'exited' as const), timedOut]);
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }

  if (settled === 'timeout') {
    // Cooperative Job stop, then a bounded settle. `cancel` returns true ONLY when
    // the launcher positively confirmed ActiveProcesses == 0.
    const confirmed = await proc.cancel('model-catalog timeout').catch(() => false);
    await proc.settleCleanup().catch(() => false);
    const treeStopConfirmed = confirmed === true && (contained ? proc.isTreeStopConfirmed() : true);
    return { stdout, stderr, code: null, treeStopConfirmed };
  }

  const e = await proc.exited;
  // A contained run confirms the tree on a natural exit too (launcherStatus=success,
  // ActiveProcesses==0). A non-contained platform has no Job, so the natural exit is
  // its own confirmation.
  const treeStopConfirmed = contained ? proc.isTreeStopConfirmed() : true;
  return { stdout, stderr, code: e.code, treeStopConfirmed };
}

/**
 * Collect a read-only catalogue snapshot for `agentId`.
 *
 * Every failure mode is a distinct, honest status; a partial/non-zero/timeout run,
 * or an unconfirmed tree stop, can never produce `ok`.
 */
export async function collectModelCatalog(
  agentId: string,
  opts: CollectCatalogOptions = {},
): Promise<ModelCatalogSnapshot> {
  const now = opts.now ?? (() => Date.now());

  if (opts.enabled === false) return notCollectedCatalog(agentId);

  if (!isCatalogSupported(agentId)) {
    return {
      agentId,
      status: 'unsupported',
      source: 'no verified catalogue command',
      listedAt: now(),
      models: [],
      note: `agent "${agentId}" has no verified native model-catalogue command in this build; its output format is not assumed`,
    };
  }

  const args = catalogArgsFor(agentId)!;
  let launcher;
  try {
    launcher = resolveCommand(agentId, opts.command).launcher;
  } catch (e) {
    return {
      agentId,
      status: 'failed',
      source: `${agentId} (not found)`,
      listedAt: now(),
      models: [],
      note: `could not resolve the ${agentId} launcher: ${(e as Error).message}`,
    };
  }

  const argv = buildLaunchArgv(launcher, args);
  const source = `${launcher.target} ${args.join(' ')}`;
  const timeoutMs = opts.timeoutMs ?? 20_000;

  let run: CatalogRun;
  try {
    if (opts.runner !== undefined) {
      // Injected boundary (tests). It owns its own process/cleanup contract, so the
      // tree stop is taken as confirmed; a non-zero/null code still fails.
      const outcome: RunOutcome = await opts.runner(launcher.command, argv, timeoutMs);
      run = { stdout: outcome.stdout, stderr: outcome.stderr, code: outcome.code, treeStopConfirmed: true };
    } else {
      run = await runContainedCatalog(launcher, args, timeoutMs);
    }
  } catch (e) {
    return {
      agentId,
      status: 'failed',
      source,
      listedAt: now(),
      models: [],
      note: `catalogue command threw: ${(e as Error).message}`,
    };
  }

  return catalogSnapshotFromRun(run, agentId, source, now());
}
