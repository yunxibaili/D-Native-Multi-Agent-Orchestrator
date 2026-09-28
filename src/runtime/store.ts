/**
 * runtime/store.ts — durable thread/task records + full event transcripts.
 *
 * Split borrowed from agents-mcp-gateway: a *thread* is the resumable
 * conversation identity and outlives executions; a *task* is one subprocess
 * execution. Without this split, "resume" degenerates into "run again".
 *
 * THREAD IDENTITY IS AGENT-SCOPED. A native threadId is only unique within one
 * agent: agent A and agent B can both mint "123", and keying storage on
 * threadId alone means the second write silently clobbers the first. Every
 * thread lookup therefore takes BOTH `agentId` and `threadId`, and the on-disk
 * filename is a composite. This is a lookup-scope fix, not a cosmetic rename: a
 * lookup physically cannot reach another agent's record.
 *
 * Storage is intentionally boring files. No database, no service.
 *
 *   $ORCH_HOME/
 *     threads/<agentId>__<threadId>.json    one per resumable conversation
 *     tasks/<taskId>.json                   one per execution
 *     transcripts/<taskId>.jsonl            EVERY raw native event, untruncated
 *     index.jsonl                           append-only task index
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RunResult, TaskState } from '../core/types.ts';
import { log } from '../core/log.ts';

/**
 * Composite-key separator. `agentId` is our own identifier, so it cannot
 * contain this, and both halves are sanitized before touching the filesystem.
 */
const KEY_SEP = '__';

export interface ThreadRecord {
  threadId: string;
  /** The agent that owns this conversation. Part of the storage key. */
  agentId: string;
  cwd: string;
  createdAt: number;
  lastUsedAt: number;
  taskIds: string[];
  model?: string;
  role?: string;
}

export interface TaskSummary {
  taskId: string;
  threadId: string | null;
  agentId: string;
  state: TaskState;
  startedAt: number;
  endedAt: number;
  exitCode: number | null;
}

export class SessionStore {
  readonly root: string;
  private readonly threadsDir: string;
  private readonly tasksDir: string;
  private readonly transcriptsDir: string;
  private readonly indexPath: string;
  /** Legacy single-key filenames, migrated lazily on first thread access. */
  private legacyMigrated = false;

  constructor(root?: string) {
    this.root = root ?? process.env.ORCH_HOME ?? join(homedir(), '.native-agent-orchestrator');
    this.threadsDir = join(this.root, 'threads');
    this.tasksDir = join(this.root, 'tasks');
    this.transcriptsDir = join(this.root, 'transcripts');
    this.indexPath = join(this.root, 'index.jsonl');
    mkdirSync(this.threadsDir, { recursive: true });
    mkdirSync(this.tasksDir, { recursive: true });
    mkdirSync(this.transcriptsDir, { recursive: true });
  }

  // ---- threads (agent-scoped) ------------------------------------------

  /** Composite on-disk name. Both halves are sanitized. */
  private threadPath(agentId: string, threadId: string): string {
    return join(this.threadsDir, `${sanitizeId(agentId)}${KEY_SEP}${sanitizeId(threadId)}.json`);
  }

  saveThread(rec: ThreadRecord): void {
    this.writeAtomic(this.threadPath(rec.agentId, rec.threadId), rec);
  }

  /**
   * Fetch a thread, SCOPED to `agentId`.
   *
   * Another agent's record is unreachable by construction, which is what keeps
   * cross-agent resume refused at the storage layer as well as by policy.
   */
  getThread(agentId: string, threadId: string): ThreadRecord | null {
    const direct = this.readJson<ThreadRecord>(this.threadPath(agentId, threadId));
    if (direct && direct.agentId === agentId) return direct;

    // Records written before agent scoping used `<threadId>.json` and carry no
    // agentId. Upgrade them on read rather than deleting anything.
    this.migrateLegacyThreads();
    const migrated = this.readJson<ThreadRecord>(this.threadPath(agentId, threadId));
    if (migrated && migrated.agentId === agentId) return migrated;
    return null;
  }

  /**
   * Look a threadId up across ALL agents.
   *
   * Deliberately NOT used by the normal resume path — that is agent-scoped so
   * one agent can never reach another's conversation by guessing an id. This
   * exists only for the explicit `allowForeignThread` operator override, where
   * crossing namespaces is the whole point and is always logged.
   */
  findThreadAnyAgent(threadId: string): ThreadRecord | null {
    this.migrateLegacyThreads();
    for (const f of this.readdir(this.threadsDir)) {
      if (!f.endsWith('.json')) continue;
      const rec = this.readJson<ThreadRecord>(join(this.threadsDir, f));
      if (rec && rec.agentId && rec.threadId === threadId) return rec;
    }
    return null;
  }

  /** Every thread, optionally filtered to one agent. */
  listThreads(agentId?: string): ThreadRecord[] {
    this.migrateLegacyThreads();
    const out: ThreadRecord[] = [];
    const seen = new Set<string>();
    for (const f of this.readdir(this.threadsDir)) {
      if (!f.endsWith('.json')) continue;
      const rec = this.readJson<ThreadRecord>(join(this.threadsDir, f));
      if (!rec || !rec.agentId) continue;
      if (agentId && rec.agentId !== agentId) continue;
      // Composite key: exactly one record per (agentId, threadId) pair.
      const key = `${rec.agentId}${KEY_SEP}${rec.threadId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(rec);
    }
    return out.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  /**
   * One-time, idempotent upgrade of thread files that are not composite-named.
   *
   * Two shapes need handling, because both exist in the wild:
   *  - a file named `<threadId>.json` whose record HAS an `agentId`. This is
   *    what earlier versions wrote: the data was fine, only the filename was
   *    unscoped. It must be renamed or the thread becomes unresumable, because
   *    the composite lookup would never find it.
   *  - a file named `<threadId>.json` whose record has NO `agentId` at all. The
   *    owning agent is recovered from the task index.
   *
   * The legacy file is removed only after the composite copy exists, so an
   * interrupted migration is safe to repeat.
   */
  private migrateLegacyThreads(): void {
    if (this.legacyMigrated) return;
    this.legacyMigrated = true;

    const legacy: string[] = [];
    for (const f of this.readdir(this.threadsDir)) {
      if (!f.endsWith('.json') || f.includes(KEY_SEP)) continue;
      legacy.push(f);
    }
    if (!legacy.length) return;

    for (const f of legacy) {
      const p = join(this.threadsDir, f);
      const rec = this.readJson<ThreadRecord>(p);
      if (!rec) continue;
      const owner = rec.agentId || this.findOwningAgent(rec.threadId);
      if (!owner) {
        log.debug('legacy thread has no discoverable owner; left untouched', { file: f });
        continue;
      }
      const target = this.threadPath(owner, rec.threadId);
      if (target === p) continue;
      try {
        if (!existsSync(target)) this.writeAtomic(target, { ...rec, agentId: owner });
        if (existsSync(target)) unlinkSync(p);
        log.info('migrated thread record to an agent-scoped key', { agent: owner, thread: rec.threadId });
      } catch (e) {
        log.warn('legacy thread migration failed', { file: f, error: (e as Error).message });
      }
    }
  }

  /** Which agent created this native thread? Ask the task index. */
  private findOwningAgent(threadId: string): string | null {
    if (!existsSync(this.indexPath)) return null;
    const lines = readFileSync(this.indexPath, 'utf8').split('\n').filter(Boolean);
    // Oldest first, so the creating task wins over a later resume.
    for (let i = 0; i < lines.length; i++) {
      try {
        const row = JSON.parse(lines[i]!) as { threadId?: string | null; agentId?: string };
        if (row.threadId === threadId && row.agentId) return row.agentId;
      } catch {
        /* skip */
      }
    }
    return null;
  }

  // ---- tasks & transcripts ---------------------------------------------

  /** Live transcript writer for one task. */
  openTranscript(taskId: string, dir?: string): TranscriptWriter {
    const target = dir ?? this.transcriptsDir;
    mkdirSync(target, { recursive: true });
    return new TranscriptWriter(join(target, `${sanitizeId(taskId)}.jsonl`));
  }

  saveTask(result: RunResult): void {
    this.writeAtomic(join(this.tasksDir, `${sanitizeId(result.taskId)}.json`), result);
    const summary: TaskSummary = {
      taskId: result.taskId,
      threadId: result.threadId,
      agentId: result.agentId,
      state: result.state,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      exitCode: result.exitCode,
    };
    try {
      appendFileSync(this.indexPath, JSON.stringify(summary) + '\n', 'utf8');
    } catch (e) {
      log.warn('index append failed', { error: (e as Error).message });
    }
  }

  getTask(taskId: string): RunResult | null {
    return this.readJson<RunResult>(join(this.tasksDir, `${sanitizeId(taskId)}.json`));
  }

  /** Most-recent-first. */
  listTasks(limit = 20): TaskSummary[] {
    if (!existsSync(this.indexPath)) return [];
    const lines = readFileSync(this.indexPath, 'utf8').split('\n').filter(Boolean);
    const out: TaskSummary[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        out.push(JSON.parse(lines[i]!) as TaskSummary);
      } catch {
        log.debug('skipping corrupt index line', { line: i });
      }
    }
    return out;
  }

  private readdir(dir: string): string[] {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  }

  private readJson<T>(file: string): T | null {
    try {
      if (!existsSync(file)) return null;
      return JSON.parse(readFileSync(file, 'utf8')) as T;
    } catch (e) {
      log.warn('unreadable record', { file, error: (e as Error).message });
      return null;
    }
  }

  /**
   * Write via temp + rename so a crash mid-write cannot leave a half-parsed
   * record behind. Single-writer, so the NTFS rename-over is sufficient.
   */
  private writeAtomic(path: string, value: unknown): void {
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
      renameSync(tmp, path);
    } catch (e) {
      log.warn('write failed', { path, error: (e as Error).message });
    }
  }
}

export class TranscriptWriter {
  readonly path: string;
  private count = 0;

  constructor(path: string) {
    this.path = path;
  }

  /** Appends the untouched native payload. Called before any mapping. */
  write(line: unknown): void {
    try {
      appendFileSync(this.path, JSON.stringify(line) + '\n', 'utf8');
      this.count++;
    } catch (e) {
      log.debug('transcript write failed', { path: this.path, error: (e as Error).message });
    }
  }

  get eventCount(): number {
    return this.count;
  }
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}
