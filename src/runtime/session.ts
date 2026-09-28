/**
 * runtime/session.ts --one task = one execution.
 *
 * The model-free kernel. It owns task state, event fan-out, memory bounds and
 * persistence, and makes NO decisions about which agent to use.
 *
 * OUTCOME STATE MACHINE (hardened this round)
 *
 *   running ──┬─ exit 0                    -> succeeded
 *             ├─ non-zero / spawn failure  -> failed
 *             ├─ cancel()                  -> cancelled
 *             └─ deadline exceeded         -> timed_out
 *
 * Invariants, each of which was a review finding:
 *
 *  I1. A terminal outcome is computed EXACTLY ONCE and frozen. Later signals
 *      (a late stderr line, a transport callback) can never rewrite it.
 *  I2. `result()` is idempotent and concurrency-safe: every call returns the
 *      SAME frozen object. It never constructs a state, so it cannot fabricate
 *      `succeeded` for a task that failed.
 *  I3. A deadline produces `timed_out`, never `cancelled`. They are different
 *      user intents and downstream policy treats them differently.
 *  I4. Every non-succeeded outcome carries a `RunErrorInfo`.
 *  I5. After the outcome is frozen, in-memory buffers are released. Files on
 *      disk are untouched.
 */

import { randomUUID } from 'node:crypto';
import { EventHub } from '../core/event-hub.ts';
import { TailBuffer } from '../core/buffer.ts';
import * as E from '../core/event.ts';
import type { RuntimeEvent } from '../core/event.ts';
import { log } from '../core/log.ts';
import type {
  AgentAdapter,
  EventSubscription,
  MapContext,
  NativeSink,
  RunHandle,
  RunRequest,
  RunResult,
  SubscribeOptions,
  TaskState,
  TerminalState,
  ToolCall,
  Transport,
  TransportExit,
  TransportFrame,
  Usage,
} from '../core/types.ts';
import { isTerminal } from '../core/types.ts';
import type { SessionStore, ThreadRecord, TranscriptWriter } from './store.ts';

export interface SessionLimits {
  /** Byte ceiling for the in-memory assistant output tail. */
  outputBytes?: number;
  /** Byte ceiling for the in-memory stderr tail. */
  stderrBytes?: number;
  /** Per-subscriber event buffer. */
  eventBuffer?: number;
  /** Retained window for opt-in late-subscriber replay. */
  recentEvents?: number;
  /** Cap on retained tool calls. */
  toolCalls?: number;
  /** Cap on retained diagnostics. */
  diagnostics?: number;
  /** Write every raw native frame to disk. */
  transcript?: boolean;
  /** Invoked once, after the outcome is frozen and buffers are released. */
  onSettled?: (session: AgentSession) => void;
}

const DEFAULTS: Required<Omit<SessionLimits, 'transcript' | 'onSettled'>> = {
  outputBytes: 64 * 1024,
  stderrBytes: 8 * 1024,
  eventBuffer: 1024,
  recentEvents: 256,
  toolCalls: 500,
  diagnostics: 200,
};

/**
 * How long to let the frame pump drain after the process exits. Generous
 * enough for a full buffer of slow subscribers, short enough that a transport
 * which fails to close its own hub cannot strand the task.
 */
const PUMP_DRAIN_GRACE_MS = 500;

export class AgentSession implements RunHandle, NativeSink {
  readonly taskId: string;
  readonly agentId: string;

  private readonly adapter: AgentAdapter;
  private readonly store: SessionStore;
  private readonly req: RunRequest;
  private readonly startedAt = Date.now();
  private readonly transcript: TranscriptWriter | null;
  private readonly hub: EventHub<RuntimeEvent>;
  private readonly limits: Required<Omit<SessionLimits, 'transcript' | 'onSettled'>>;

  private transport: Transport | null = null;
  private currentState: TaskState = 'running';

  /**
   * The frozen terminal result. Set exactly once by `finalize()`.
   * This is the single source of truth for `result()`.
   */
  private frozen: RunResult | null = null;

  private readonly output: TailBuffer;
  private readonly stderrTail: TailBuffer;
  private toolCallList: ToolCall[] = [];
  private usageAccum: Usage = {};
  private diagnosticsList: string[] = [];
  private nativeSignals: string[] = [];

  private threadId: string | null = null;
  private localAbort: 'cancelled' | 'timed_out' | null = null;
  private abortReason = '';
  private deadlineTimer: NodeJS.Timeout | null = null;
  private donePromise: Promise<RunResult>;
  private resolveDone: ((r: RunResult) => void) | null = null;
  private readonly onSettled: ((session: AgentSession) => void) | null;

  constructor(
    adapter: AgentAdapter,
    store: SessionStore,
    req: RunRequest,
    transport: Transport,
    limits: SessionLimits = {},
  ) {
    this.adapter = adapter;
    this.store = store;
    this.req = req;
    this.transport = transport;
    this.limits = { ...DEFAULTS, ...limits };
    this.taskId = `tsk_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    this.agentId = req.agentId;
    this.transcript = limits.transcript === false ? null : store.openTranscript(this.taskId, req.transcriptDir);
    this.output = new TailBuffer({ limitBytes: this.limits.outputBytes, keep: 'tail' });
    this.stderrTail = new TailBuffer({ limitBytes: this.limits.stderrBytes, keep: 'tail' });
    this.hub = new EventHub<RuntimeEvent>({
      defaultBuffer: this.limits.eventBuffer,
      recentCapacity: this.limits.recentEvents,
      overflow: 'drop-oldest',
    });
    this.onSettled = limits.onSettled ?? null;
    // Seed a resume thread BEFORE anything can fail.
    //
    // A native CLI can die before emitting its first frame (bad flag, auth
    // failure, immediate crash). If the thread id were learned only from a
    // native event, such a run would produce a RunResult with threadId=null and
    // be uncorrelatable from the thread it was continuing. The caller has
    // already proved ownership, so the identity is known up front and is bound
    // here — the session can never be launched un-seeded for a resume.
    if (req.threadId) this.threadId = req.threadId;
    this.donePromise = new Promise<RunResult>((res) => {
      this.resolveDone = res;
    });
  }

  // ---- RunHandle --------------------------------------------------------

  state(): TaskState {
    return this.currentState;
  }

  get currentThreadId(): string | null {
    return this.threadId;
  }

  /** Multi-subscriber, bounded, non-blocking for the producer. */
  events(opts: SubscribeOptions = {}): EventSubscription {
    return this.hub.subscribe(opts);
  }

  /**
   * I2: idempotent and stable. Once frozen, always the same object.
   * A `timeoutMs` bounds THIS call only and never alters the outcome --it
   * rejects with TimeoutError while the task keeps running.
   */
  result(timeoutMs?: number): Promise<RunResult> {
    if (this.frozen) return Promise.resolve(this.frozen);
    if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return this.donePromise;
    }
    return new Promise<RunResult>((res, rej) => {
      const timer = setTimeout(
        () => rej(new Error(`result(${timeoutMs}) timed out; task ${this.taskId} is still running`)),
        timeoutMs,
      );
      // Deliberately NOT unref'd: this timer is the mechanism by which
      // result(timeoutMs) rejects. Unref'ing it means the rejection silently
      // never happens when nothing else holds the event loop --the exact
      // "timeout does not actually time out" failure.
      void this.donePromise.then(
        (r) => {
          clearTimeout(timer);
          res(r);
        },
        (e) => {
          clearTimeout(timer);
          rej(e);
        },
      );
    });
  }

  /** I3: a user abort yields `cancelled`, a deadline yields `timed_out`. */
  async cancel(reason = 'requested'): Promise<void> {
    if (this.frozen || this.currentState !== 'running') return;
    this.localAbort = 'cancelled';
    this.abortReason = reason;
    try {
      await this.transport?.cancel(reason);
    } catch (e) {
      log.warn('transport cancel failed', { taskId: this.taskId, error: (e as Error).message });
    }
  }

  // ---- lifecycle --------------------------------------------------------

  start(): this {
    if (!this.transport) throw new Error('session has no transport');
    // Deferred by one microtask so a subscriber created in the same tick as the
    // `run()` call — which is how every caller actually uses this — still
    // receives `session.started`. Publishing it synchronously would put it in
    // the hub's replay window only, so a live subscriber would never see the
    // opening event of the stream it just asked for.
    const started = E.started(
      this.ctx(),
      { invocation: { commandLine: this.transport.commandLine } },
      { commandLine: this.transport.commandLine, resume: this.req.threadId ?? null },
    );
    queueMicrotask(() => this.publish(started));

    // Subscription order matters and the exit wait must run concurrently.
    //
    // 1. `pump()` subscribes to the transport's frame hub SYNCHRONOUSLY, so no
    //    frame can be missed.
    // 2. `start()` launches the process.
    // 3. `wait()` is called and awaited alongside the pump.
    //
    // Sequencing 3 after the pump instead would deadlock: the pump waits for a
    // hub close that only `wait()` performs, so the agent would run to
    // completion with nothing finalising it and every task would survive to its
    // deadline. A hub still delivers already-buffered frames after closing, so
    // awaiting the pump guarantees every frame was mapped before freezing.
    const pumpPromise = this.pump();
    this.transport.start();
    const exitPromise = this.transport.wait();

    const ms = this.req.timeoutMs;
    if (ms !== undefined && Number.isFinite(ms) && ms > 0) {
      this.deadlineTimer = setTimeout(() => {
        void this.onDeadline();
      }, ms);
    }

    void this.drive(exitPromise, pumpPromise);
    return this;
  }

  private async drive(
    exitPromise: Promise<TransportExit>,
    pumpPromise: Promise<void>,
  ): Promise<void> {
    let exit: TransportExit | null = null;
    let error: unknown = null;
    try {
      exit = await exitPromise;
    } catch (e) {
      error = e;
    }

    // Let the pump finish mapping buffered frames, but do not wait forever: a
    // transport that forgot to close its own hub must not strand the task.
    //
    // NOTE: do NOT close the session hub here. `finalize()` publishes the
    // terminal event and then closes; closing early made `publish()` a no-op
    // and silently dropped `session.completed`/`session.failed`, so a consumer
    // saw the stream end on the last native event with no terminal signal.
    await Promise.race([
      pumpPromise.catch((e) => {
        log.warn('frame pump error', { taskId: this.taskId, error: (e as Error).message });
      }),
      new Promise<void>((r) => {
        const t = setTimeout(r, PUMP_DRAIN_GRACE_MS);
        if (typeof t.unref === 'function') t.unref();
      }),
    ]);

    this.finalize(exit, error);
  }

  /** Pull transport frames, map them, publish to the hub. */
  private async pump(): Promise<void> {
    if (!this.transport) return;
    const frames = this.transport.events({ buffer: this.limits.eventBuffer });
    for await (const frame of frames) {
      this.handleFrame(frame);
    }
  }

  /**
   * Resolve a transport frame into a native payload.
   *
   * PRECEDENCE: `frame.data` WINS over `frame.text`.
   *
   * `text` is the CLI-JSONL convention: the payload arrives as text and must
   * be JSON-parsed. `data` is the protocol convention: a transport that frames
   * natively (ACP, app-server) hands over a decoded object and may not
   * produce JSON text at all. Before this rule existed, a data-only frame fell
   * through to text parsing, failed to parse, and was misreported as a
   * diagnostic — so `mapEvent` never ran for any real protocol transport.
   */
  private resolveFrame(frame: TransportFrame): { payload: unknown; ok: boolean } {
    if (frame.data !== undefined && frame.data !== null) {
      return { payload: frame.data, ok: true };
    }
    const parsed = tryParse(frame.text);
    return { payload: parsed, ok: parsed !== undefined };
  }

  private handleFrame(frame: TransportFrame): void {
    if (frame.channel === 'stderr') {
      this.stderrTail.append(frame.text);
      this.transcript?.write({ _stderr: frame.text });
      this.noteDiagnostic(`stderr: ${frame.text}`);
      this.publish(E.diagnostic(this.ctx(), { _stderr: frame.text }, frame.text));
      return;
    }

    const { payload, ok } = this.resolveFrame(frame);
    if (!ok) {
      // A banner or warning on the event channel. Kept, never dropped.
      this.transcript?.write({ _unparsed: frame.text });
      this.noteDiagnostic(`unparsed: ${frame.text}`);
      this.publish(E.diagnostic(this.ctx(), { _unparsed: frame.text }, frame.text));
      return;
    }

    // Persist the untouched native payload BEFORE mapping, so a mapping
    // failure can never lose information.
    this.transcript?.write(payload);
    // Hand the adapter a frame whose `data` is the resolved payload, so
    // adapters read one field regardless of how the payload arrived.
    const normalized: TransportFrame = { channel: frame.channel, text: frame.text, data: payload };
    let mapped: RuntimeEvent[];
    try {
      mapped = this.adapter.mapEvent(normalized, this.ctx());
    } catch (e) {
      mapped = [E.diagnostic(this.ctx(), payload, `mapEvent failed: ${(e as Error).message}`)];
    }
    for (const ev of mapped) this.publish(ev);
  }

  private async onDeadline(): Promise<void> {
    if (this.frozen || this.currentState !== 'running') return;
    this.localAbort = 'timed_out';
    this.abortReason = `deadline of ${this.req.timeoutMs}ms exceeded`;
    log.warn('task deadline exceeded', { taskId: this.taskId, timeoutMs: this.req.timeoutMs });
    try {
      await this.transport?.cancel(this.abortReason);
    } catch (e) {
      log.warn('deadline cancel failed', { taskId: this.taskId, error: (e as Error).message });
    }
  }

  // ---- I1: the single place an outcome is decided -----------------------

  private finalize(exit: TransportExit | null, transportError: unknown): void {
    if (this.frozen) return; // I1: first outcome wins, unconditionally.
    if (this.deadlineTimer) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }

    let state: TerminalState;
    let error: RunResult['error'] = null;

    if (transportError) {
      state = 'failed';
      error = { code: 'TRANSPORT_ERROR', message: (transportError as Error).message };
    } else if (this.localAbort === 'cancelled') {
      // I3: distinct from timed_out.
      state = 'cancelled';
      error = { code: 'CANCELLED', message: this.abortReason || 'cancelled' };
    } else if (this.localAbort === 'timed_out') {
      state = 'timed_out';
      error = {
        code: 'TIMED_OUT',
        message: this.abortReason || `exceeded ${this.req.timeoutMs}ms`,
        retryable: true,
      };
    } else {
      // The ADAPTER owns the terminal policy, not this kernel.
      const decision = this.adapter.terminalPolicy({
        exit: exit ?? this.emptyExit(),
        nativeSignals: [...this.nativeSignals],
        localAbort: null,
      });
      state = decision.state;
      error = decision.error;
    }

    // I4: every non-succeeded outcome must explain itself.
    if (state !== 'succeeded' && !error) {
      state = 'failed';
      error = { code: 'NONZERO_EXIT', message: 'task did not succeed and no reason was recorded' };
    }
    if (state === 'succeeded' && error) {
      state = 'failed';
    }

    this.currentState = state;

    const result: RunResult = {
      taskId: this.taskId,
      threadId: this.threadId,
      agentId: this.agentId,
      state,
      startedAt: this.startedAt,
      endedAt: Date.now(),
      exitCode: exit?.code ?? null,
      signal: exit?.signal ?? null,
      output: this.output.toString(),
      outputTruncated: this.output.truncated,
      transcriptPath: this.transcript && this.transcript.eventCount > 0 ? this.transcript.path : null,
      usage: this.usageAccum,
      toolCalls: this.toolCallList.slice(),
      error,
      diagnostics: this.diagnosticsList.slice(),
      cleanup: exit?.cleanup ?? {
        rootKilled: false,
        descendantsReaped: false,
        note: 'transport reported no exit',
      },
    };

    this.frozen = result; // Freeze BEFORE any async cleanup.
    this.publish(
      state === 'succeeded'
        ? E.completed(this.ctx(), { exit }, result.output, {
            usage: result.usage as unknown as Record<string, unknown>,
            exitCode: result.exitCode,
            toolCallCount: result.toolCalls.length,
            eventCount: this.transcript?.eventCount ?? 0,
            outputTruncated: result.outputTruncated,
          })
        : state === 'cancelled'
          ? E.cancelled(this.ctx(), { exit }, error?.message ?? 'cancelled')
          : E.failed(this.ctx(), { exit }, error?.message ?? 'failed', {
              exitCode: result.exitCode,
              signal: result.signal,
              errorCode: error?.code,
            }),
    );

    this.hub.close(); // I5: complete every subscriber and free their buffers.
    this.persist(result);
    this.resolveDone?.(result);

    // I5: release runtime memory. Files stay on disk.
    this.releaseMemory();
    void this.transport?.dispose();
    // Let the owner drop its reference, so its live-session map stays bounded.
    this.onSettled?.(this);
  }

  private releaseMemory(): void {
    this.output.release();
    this.stderrTail.release();
    this.toolCallList = [];
    this.diagnosticsList = [];
    this.nativeSignals = [];
  }

  private persist(result: RunResult): void {
    try {
      if (this.threadId) {
        // Agent-scoped lookup: this session's own agent only.
        const prior = this.store.getThread(this.agentId, this.threadId);
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

  // ---- NativeSink -------------------------------------------------------

  private ctx(): MapContext {
    return { taskId: this.taskId, agentId: this.agentId, threadId: this.threadId, sink: this };
  }

  /** Placeholder exit for the case where a transport never reported one. */
  private emptyExit(): TransportExit {
    return {
      code: null,
      signal: null,
      stderrTail: this.stderrTail.toString(),
      stderrTruncated: this.stderrTail.truncated,
      cleanup: { rootKilled: false, descendantsReaped: false, note: 'transport reported no exit' },
    };
  }

  private publish(ev: RuntimeEvent): void {
    if (!ev.threadId && this.threadId) {
      (ev as { threadId: string | null }).threadId = this.threadId;
    }
    if (!this.threadId && ev.threadId) this.threadId = ev.threadId;
    this.hub.publish(ev);
  }

  noteThreadId(id: string): void {
    if (id && !this.threadId) this.threadId = id;
  }

  noteText(text: string): void {
    this.output.append(text);
  }

  noteToolCall(call: ToolCall): void {
    this.toolCallList.push(call);
    if (this.toolCallList.length > this.limits.toolCalls) this.toolCallList.shift();
  }

  noteUsage(partial: Partial<Usage>): void {
    this.usageAccum = { ...this.usageAccum, ...stripUndefined(partial) };
  }

  noteDiagnostic(text: string): void {
    this.diagnosticsList.push(text);
    if (this.diagnosticsList.length > this.limits.diagnostics) this.diagnosticsList.shift();
  }

  noteNativeSignal(signal: string): void {
    this.nativeSignals.push(signal);
    if (this.nativeSignals.length > this.limits.diagnostics) this.nativeSignals.shift();
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

export { isTerminal };
