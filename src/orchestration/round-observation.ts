/**
 * src/orchestration/round-observation.ts — the ONE-WAY outbound channel for a round.
 *
 *   round process (has the live TaskStore / WorkspaceManager / claims)
 *         ↓  WRITE ONLY
 *   $ORCH_HOME/round-state.json      (current snapshot, atomically replaced)
 *   $ORCH_HOME/round-events.jsonl    (append-only event log)
 *         ↑  READ ONLY
 *   temporary-dashboard bridge        (a SEPARATE process, may or may not be running)
 *
 * DIRECTION IS THE WHOLE POINT
 * ----------------------------
 * Nothing here reads from the dashboard, and the dashboard can never call back into
 * this process. There is no request path, no command channel and no acknowledgement —
 * so a dashboard cannot start, stop, reassign or retry anything, even in principle.
 *
 * FAILURE ISOLATION
 * -----------------
 * A round is executing real agents. Observability must not be able to take it down,
 * so EVERY write is wrapped: a full disk, a missing directory, a permission denial or
 * a race with another writer degrades to `ok: false` and the caller continues. The
 * dashboard being absent is the normal case, not an error, so a failed write is not
 * even logged as a warning unless the caller asks.
 *
 * ATOMIC REPLACE
 * --------------
 * The state file is written to a sibling temp name and then renamed, because the
 * reader is a different process polling at its own pace: a reader that catches a
 * half-written file would render a snapshot that never existed.
 */

import { mkdirSync, renameSync, unlinkSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import type { ExecutionMonitorSnapshot } from './execution-monitor.ts';

/** Where the dashboard bridge looks by default. Same root the runtime already uses. */
export function defaultObservationDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ORCH_HOME ?? join(homedir(), '.native-agent-orchestrator');
}

export interface RoundObservationPayload {
  /** The snapshot as derived by `execution-monitor`. */
  readonly snapshot: ExecutionMonitorSnapshot;
  /** Cheap-change detection: when this equals the last written key, nothing is written. */
  readonly stateKey: string;
  /** Events to append. Duplicates (by `key`) are dropped within this process. */
  readonly events?: readonly {
    readonly key: string;
    readonly at: number;
    readonly source: string;
    readonly message: string;
    readonly tone?: 'normal' | 'success' | 'warning' | 'error';
  }[];
}

export interface RoundObserver {
  /**
   * Publish. Returns what happened — never throws, for any reason.
   *
   * `ok: false` means the dashboard will keep showing the previous state, and the
   * round is completely unaffected. The caller is free to ignore the result.
   */
  publish(payload: RoundObservationPayload): { ok: boolean; wrote: boolean; code: string | null; reason: string | null };
  /** Where this observer writes. Exposed so a report can state the real paths. */
  readonly paths: { readonly state: string; readonly events: string };
}

export interface RoundObserverOptions {
  /** Directory to publish into. Defaults to `$ORCH_HOME`. */
  readonly dir?: string;
  /** Explicit file names. Rarely needed; the defaults match the bridge. */
  readonly stateFile?: string;
  readonly eventsFile?: string;
  /**
   * Called with a short message when a write fails. Defaults to silence, because a
   * missing dashboard is expected and a round must not spam about it.
   */
  readonly onError?: (message: string) => void;
}

const STATE_NAME = 'round-state.json';
const EVENTS_NAME = 'round-events.jsonl';

/**
 * Create a writer for one round.
 *
 * The returned object holds only the paths, the last state key and the set of event
 * keys already emitted — bookkeeping that lives for the process's lifetime and dies
 * with it. It is NOT state about the round; losing it costs a duplicate write.
 */
export function createRoundObserver(options: RoundObserverOptions = {}): RoundObserver {
  const dir = options.dir ?? defaultObservationDir();
  const statePath = options.stateFile ?? join(dir, STATE_NAME);
  const eventsPath = options.eventsFile ?? join(dir, EVENTS_NAME);
  const seenEvents = new Set<string>();
  let lastKey = '';

  const fail = (code: string, e: unknown): { ok: false; wrote: false; code: string; reason: string } => {
    const reason = e instanceof Error ? e.message : String(e);
    options.onError?.(`observation not published [${code}]: ${reason}`);
    return { ok: false, wrote: false, code, reason };
  };

  return {
    paths: { state: statePath, events: eventsPath },

    publish(payload) {
      // Cheap change detection first: the dashboard polls, the round dispatches, and
      // most polls happen with nothing to say.
      const unchanged = payload.stateKey === lastKey;

      let wrote = false;

      if (!unchanged) {
        try {
          mkdirSync(dirname(statePath), { recursive: true });
          const body = JSON.stringify(payload.snapshot, null, 2);
          // Temp name is per-process so two observers cannot collide on it.
          const tmp = `${statePath}.${process.pid}.tmp`;
          writeFileSync(tmp, body, 'utf8');
          renameSync(tmp, statePath);
          lastKey = payload.stateKey;
          wrote = true;
        } catch (e) {
          // A leftover temp file is harmless, but clean it up so the directory does
          // not accumulate one file per failed attempt.
          try {
            const tmp = `${statePath}.${process.pid}.tmp`;
            if (existsSync(tmp)) unlinkSync(tmp);
          } catch {
            // Nothing further to do; the failure is already reported below.
          }
          return fail('round-state-write-failed', e);
        }
      }

      const fresh = (payload.events ?? []).filter((ev) => {
        if (seenEvents.has(ev.key)) return false;
        seenEvents.add(ev.key);
        return true;
      });

      if (fresh.length > 0) {
        try {
          mkdirSync(dirname(eventsPath), { recursive: true });
          appendFileSync(
            eventsPath,
            fresh.map((ev) => JSON.stringify({
              at: ev.at,
              source: ev.source,
              message: ev.message,
              tone: ev.tone ?? 'normal',
            })).join('\n') + '\n',
            'utf8',
          );
          wrote = true;
        } catch (e) {
          // The state file may already have landed, which is still useful. Report the
          // partial failure honestly rather than claiming a clean publish.
          const f = fail('round-events-append-failed', e);
          return { ...f, wrote };
        }
      }

      return { ok: true, wrote, code: null, reason: null };
    },
  };
}

/**
 * Read the events log, newest last. Bounded by `limit` so a long round cannot make
 * the dashboard allocate without limit.
 *
 * A malformed line is SKIPPED rather than fatal: this is a log written by another
 * process that may have been killed mid-append, and the dashboard must render what it
 * can rather than nothing.
 */
export function readRoundEvents(
  file: string,
  limit = 200,
): readonly { at: number; source: string; message: string; tone: string }[] {
  if (!existsSync(file)) return [];
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: { at: number; source: string; message: string; tone: string }[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed) as { at?: unknown; source?: unknown; message?: unknown; tone?: unknown };
      if (typeof parsed.at !== 'number' || typeof parsed.message !== 'string') continue;
      out.push({
        at: parsed.at,
        source: typeof parsed.source === 'string' ? parsed.source : 'unknown',
        message: parsed.message,
        tone: typeof parsed.tone === 'string' ? parsed.tone : 'normal',
      });
    } catch {
      // A torn final line is expected when the writer was killed. Skip it.
    }
  }
  return out.slice(-limit);
}
