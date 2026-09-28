/**
 * runtime/store.ts — durable thread/task records + full event transcripts.
 *
 * Split borrowed from agents-mcp-gateway: a *thread* is the resumable
 * conversation identity and outlives executions; a *task* is one subprocess
 * execution. Without this split, "resume" degenerates into "run again".
 *
 * Storage is intentionally boring files. No database, no service.
 *
 *   $ORCH_HOME/
 *     threads/<threadId>.json      one per resumable conversation
 *     tasks/<taskId>.json          one per execution (terminal state)
 *     transcripts/<taskId>.jsonl   EVERY raw native event, never truncated
 *     index.jsonl                  append-only task index for `list`
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RunResult, TaskState } from '../core/types.ts';
import { log } from '../core/log.ts';

export interface ThreadRecord {
  threadId: string;
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

  /** Live transcript writer for one task. */
  openTranscript(taskId: string, dir?: string): TranscriptWriter {
    const target = dir ?? this.transcriptsDir;
    mkdirSync(target, { recursive: true });
    return new TranscriptWriter(join(target, `${sanitizeId(taskId)}.jsonl`));
  }

  saveThread(rec: ThreadRecord): void {
    this.writeAtomic(join(this.threadsDir, `${sanitizeId(rec.threadId)}.json`), rec);
  }

  getThread(threadId: string): ThreadRecord | null {
    return this.readJson<ThreadRecord>(join(this.threadsDir, `${sanitizeId(threadId)}.json`));
  }

  listThreads(agentId?: string): ThreadRecord[] {
    const out: ThreadRecord[] = [];
    for (const f of this.readdir(this.threadsDir)) {
      if (!f.endsWith('.json')) continue;
      const rec = this.readJson<ThreadRecord>(join(this.threadsDir, f));
      if (rec && (!agentId || rec.agentId === agentId)) out.push(rec);
    }
    return out.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
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
