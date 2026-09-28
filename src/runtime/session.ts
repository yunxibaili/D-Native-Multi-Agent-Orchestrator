/**
 * runtime/session.ts — one task = one subprocess execution, streamed.
 *
 * This is the model-free kernel from native-agent-router: it owns task state,
 * process lifecycle, event plumbing and persistence, and makes NO decisions
 * about which agent to use or what the task means.
 *
 * The single most important rule, learned from a live Codex run:
 *   >>> EXIT CODE IS THE GROUND TRUTH FOR SUCCESS. <<<
 * Codex emits `item.completed` with `item.type === "error"` for things that
 * are merely config warnings ("unrecognized configuration setting",
 * "malformed agent role definition") and still exits 0. A successful run on
 * this machine emits four such events. Treating them as failures would break
 * every run. Native terminal signals are recorded, but they never override a
 * zero exit.
 */

import { randomUUID } from 'node:crypto';
import type {
  AgentAdapter,
  MapContext,
  NativeSink,
  RunHandle,
  RunRequest,
  RunResult,
  TaskState,
  TerminalSignal,
  ToolCall,
  Usage,
} from '../core/types.ts';
import { isTerminal } from '../core/types.ts';
import * as E from '../core/event.ts';
import type { RuntimeEvent } from '../core/event.ts';
import { TimeoutError } from '../core/errors.ts';
import { log } from '../core/log.ts';
import { spawnProcess, type ProcessHandle } from './spawn.ts';
import type { SessionStore, ThreadRecord, TranscriptWriter } from './store.ts';

/** Keeps memory bounded; the transcript on disk keeps everything. */
const OUTPUT_TAIL_LIMIT = 64 * 1024;
const MAX_TOOL_CALLS_KEPT = 500;
const DIAGNOSTIC_LIMIT = 200;

export class AgentSession implements RunHandle, NativeSink {
  readonly taskId: string;
  readonly agentId: string;

  private readonly adapter: AgentAdapter;
  private readonly store: SessionStore;
  private readonly req: RunRequest;
  private readonly startedAt = Date.now();
  private readonly transcript: TranscriptWriter;

  private proc: ProcessHandle | null = null;
  private currentState: TaskState = 'running';
  private threadId: string | null = null;
  private outputChunks: string[] = [];
  private outputBytes = 0;
  private toolCalls: ToolCall[] = [];
  private usage: Usage = {};
  private diagnostics: string[] = [];
  private nativeTerminal: TerminalSignal | null = null;
  private unparsedStdout: string[] = [];
  private cancelReason: string | null = null;
  private timeoutTimer: NodeJS.Timeout | null = null;
  private failedTimer: NodeJS.Timeout | null = null;
  private resolveResult: ((r: RunResult) => void) | null = null;
  private readonly donePromise: Promise<RunResult>;

  /** Fan-out queue for the `events` async iterable. */
  private queue: RuntimeEvent[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;

  constructor(adapter: AgentAdapter, store: SessionStore, req: RunRequest) {
    this.adapter = adapter;
    this.store = store;
    this.req = req;
    this.taskId = `tsk_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    this.agentId = req.agentId;
    this.transcript = store.openTranscript(this.taskId, req.transcriptDir);
    this.donePromise = new Promise<RunResult>((res) => {
      this.resolveResult = res;
    });
  }

  state(): TaskState {
    return this.currentState;
  }

  get currentThreadId(): string | null {
    return this.threadId;
  }

  /** Async iterable of unified events. Consumers may attach late. */
  events(): AsyncIterable<RuntimeEvent> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (self.queue.length) {
            yield self.queue.shift()!;
            continue;
          }
          if (self.closed) return;
          await new Promise<void>((r) => {
            self.waiter = r;
          });
        }
      },
    };
  }

  /** Launch the process. Must be called before awaiting `result`. */
  start(): this {
    const invocation = this.adapter.buildInvocation(this.req);
    const ctx = this.ctx();

    log.info('dispatch', {
      taskId: this.taskId,
      agent: this.agentId,
      command: invocation.command,
      argCount: invocation.args.length,
      cwd: this.req.cwd,
      resume: this.req.threadId ?? null,
    });

    this.push(
      E.started(ctx, { invocation: { command: invocation.command, args: invocation.args } }, {
        command: invocation.command,
        promptVia: invocation.promptVia,
        resume: this.req.threadId ?? null,
      }),
    );

    this.proc = spawnProcess({
      command: invocation.command,
      args: invocation.args,
      cwd: this.req.cwd,
      env: invocation.env,
      stdin: invocation.promptVia === 'stdin' ? this.req.prompt : undefined,
      onStdoutLine: (line) => this.onStdoutLine(line),
      onStderrLine: (line) => this.onStderrLine(line),
    });

    if (this.req.timeoutMs && this.req.timeoutMs > 0) {
      this.timeoutTimer = setTimeout(() => {
        log.warn('task timeout reached', { taskId: this.taskId, ms: this.req.timeoutMs });
        void this.cancel(`timeout after ${this.req.timeoutMs}ms`);
      }, this.req.timeoutMs);
    }

    void this.proc.exited.then((info) => this.finalize(info));
    return this;
  }

  /**
   * Resolves with the terminal result.
   * A timeout here does NOT kill the process — call again, or cancel.
   */
  result(timeoutMs?: number): Promise<RunResult> {
    if (timeoutMs === undefined) return this.donePromise;

    return new Promise<RunResult>((res, rej) => {
      if (this.isFinished) {
        res(this.snapshot('succeeded'));
        return;
      }
      this.failedTimer = setTimeout(() => rej(new TimeoutError(this.taskId, timeoutMs)), timeoutMs);
      void this.donePromise.then(
        (r) => {
          if (this.failedTimer) clearTimeout(this.failedTimer);
          res(r);
        },
        (e) => {
          if (this.failedTimer) clearTimeout(this.failedTimer);
          rej(e);
        },
      );
    });
  }

  async cancel(reason = 'requested'): Promise<void> {
    if (isTerminal(this.currentState)) return;
    this.cancelReason = reason;
    this.proc?.cancel(reason);
  }

  // ---- internals -------------------------------------------------------

  private get isFinished(): boolean {
    return isTerminal(this.currentState);
  }

  private ctx(): MapContext {
    return {
      taskId: this.taskId,
      agentId: this.agentId,
      threadId: this.threadId,
      sink: this,
    };
  }

  private onStdoutLine(line: string): void {
    const raw = tryParse(line);
    if (raw === undefined) {
      // Agents occasionally print a banner or warning on stdout. Keep it —
      // dropping it would violate the no-information-loss rule.
      if (line.trim()) {
        this.unparsedStdout.push(line);
        if (this.unparsedStdout.length > DIAGNOSTIC_LIMIT) this.unparsedStdout.shift();
        this.transcript.write({ _unparsedStdout: line });
        this.push(E.diagnostic(this.ctx(), { _unparsedStdout: line }, line));
      }
      return;
    }

    // Persist the untouched native event FIRST, so nothing is ever lost even
    // if a mapping throws.
    this.transcript.write(raw);

    for (const ev of this.safeMap(raw)) this.push(ev);
  }

  private safeMap(raw: unknown): RuntimeEvent[] {
    try {
      return this.adapter.mapEvent(raw, this.ctx());
    } catch (e) {
      log.warn('adapter mapEvent threw', { taskId: this.taskId, error: (e as Error).message });
      return [
        E.diagnostic(this.ctx(), raw, `adapter mapEvent failed: ${(e as Error).message}`),
      ];
    }
  }

  private onStderrLine(line: string): void {
    if (!line.trim()) return;
    this.transcript.write({ _stderr: line });
    this.push(E.diagnostic(this.ctx(), { _stderr: line }, line));
  }

  private push(ev: RuntimeEvent): void {
    // Learn the thread id from the first event that carries one.
    if (!this.threadId && ev.threadId) this.threadId = ev.threadId;
    this.queue.push(ev);
    this.waiter?.();
    this.waiter = null;
  }

  private finalize(info: { code: number | null; signal: string | null; stderrTail: string }): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    if (this.failedTimer) clearTimeout(this.failedTimer);
    this.closed = true;
    this.waiter?.();
    this.waiter = null;

    const ctx = this.ctx();
    const code = info.code;
    const ok = code === 0 && !this.cancelReason;

    let state: TaskState;
    let error: RunResult['error'] = null;

    if (this.cancelReason) {
      state = 'cancelled';
      this.push(E.cancelled(ctx, { exit: info }, this.cancelReason));
    } else if (ok) {
      state = 'succeeded';
      const text = this.assembleOutput();
      this.push(
        E.completed(ctx, { exit: info, usage: this.usage }, text, {
          usage: this.usage as unknown as Record<string, unknown>,
          exitCode: code,
          toolCallCount: this.toolCalls.length,
          eventCount: this.transcript.eventCount,
          nativeTerminal: this.nativeTerminal,
        }),
      );
    } else {
      state = 'failed';
      const message = this.describeFailure(info);
      error = { code: code === null ? 'SPAWN_FAILED' : 'NONZERO_EXIT', message };
      this.push(E.failed(ctx, { exit: info }, message, { exitCode: code, signal: info.signal }));
    }

    this.currentState = state;
    const result = this.snapshot(state, info, error);
    this.persist(result);
    this.resolveResult?.(result);
  }

  private describeFailure(info: { code: number | null; signal: string | null; stderrTail: string }): string {
    const parts: string[] = [];
    if (info.signal) parts.push(`killed by ${info.signal}`);
    if (info.code !== null && info.code !== 0) parts.push(`exit code ${info.code}`);
    // Codex prints clap errors ("unexpected argument '-a' found") on stderr
    // with exit 2 — the stderr tail is the entire explanation.
    if (info.stderrTail) parts.push(`stderr: ${truncate(info.stderrTail, 1200)}`);
    else parts.push('no stderr output');
    if (this.nativeTerminal && !this.nativeTerminal.success) {
      parts.push(`native signal: ${this.nativeTerminal.reason}`);
    }
    if (this.diagnostics.length) {
      parts.push(`agent diagnostics: ${this.diagnostics.slice(0, 3).join(' | ')}`);
    }
    return parts.join('; ');
  }

  /** Last-assistant-text-wins, but keep every text block for multi-step runs. */
  private assembleOutput(): string {
    const parts = this.outputChunks.filter((s) => s.length);
    if (parts.length === 0) {
      return this.unparsedStdout.length ? this.unparsedStdout.join('\n') : '';
    }
    return parts.join('\n');
  }

  snapshot(
    state: TaskState = this.currentState,
    exit?: { code: number | null; signal: string | null },
    error: RunResult['error'] = null,
  ): RunResult {
    return {
      taskId: this.taskId,
      threadId: this.threadId,
      agentId: this.agentId,
      state,
      startedAt: this.startedAt,
      endedAt: Date.now(),
      exitCode: exit?.code ?? null,
      signal: exit?.signal ?? null,
      output: this.assembleOutput(),
      transcriptPath: this.transcript.eventCount > 0 ? this.transcript.path : null,
      usage: this.usage,
      toolCalls: this.toolCalls.slice(0, MAX_TOOL_CALLS_KEPT),
      error,
      diagnostics: this.diagnostics.slice(0, DIAGNOSTIC_LIMIT),
    };
  }

  // ---- NativeSink: adapters report what they saw, the kernel owns state ----

  noteThreadId(id: string | null | undefined): void {
    if (id && !this.threadId) this.threadId = id;
  }

  noteText(text: string): void {
    this.outputChunks.push(text);
    this.outputBytes += text.length;
    if (this.outputBytes > OUTPUT_TAIL_LIMIT) {
      // Drop from the middle: keep the opening and the final answer.
      const mid = this.outputChunks.length >> 1;
      this.outputChunks.splice(1, mid - 1);
      log.debug('output tail trimmed', { taskId: this.taskId });
    }
  }

  noteToolCall(call: ToolCall): void {
    this.toolCalls.push(call);
    if (this.toolCalls.length > MAX_TOOL_CALLS_KEPT) this.toolCalls.shift();
  }

  noteUsage(partial: Partial<Usage>): void {
    this.usage = { ...this.usage, ...stripUndefined(partial) };
  }

  noteDiagnostic(text: string): void {
    this.diagnostics.push(text);
    if (this.diagnostics.length > DIAGNOSTIC_LIMIT) this.diagnostics.shift();
  }

  noteNativeTerminal(signal: TerminalSignal): void {
    this.nativeTerminal = signal;
  }

  private persist(result: RunResult): void {
    try {
      if (this.threadId) {
        const prior = this.store.getThread(this.threadId);
        const now = Date.now();
        const rec: ThreadRecord = {
          threadId: this.threadId,
          agentId: this.agentId,
          cwd: this.req.cwd,
          createdAt: prior?.createdAt ?? now,
          lastUsedAt: now,
          taskIds: [...(prior?.taskIds ?? []), this.taskId],
          model: this.req.model,
          role: this.req.role,
        };
        this.store.saveThread(rec);
      }
      this.store.saveTask(result);
    } catch (e) {
      log.warn('persist failed', { taskId: this.taskId, error: (e as Error).message });
    }
  }
}

function tryParse(line: string): unknown {
  const t = line.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : '…' + s.slice(-n);
}
