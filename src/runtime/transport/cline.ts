/**
 * runtime/transport/cline.ts — Cline's code-sidecar, reached over WebSocket.
 *
 * Everything below was MEASURED on this machine (sidecar appVersion 0.0.32,
 * `D:\Cline\code-sidecar.exe`), not assumed:
 *
 * LAUNCH. Spawning the exe (argv is IGNORED — `--help`/`--version` are
 * swallowed) prints exactly one ready line on stdout:
 *   {"type":"ready","endpoint":"http://127.0.0.1:<port>","wsEndpoint":
 *    "ws://…/transport?approval_token=<uuid>","pid":N,"mode":"sidecar"}
 * The port defaults to 3126 and falls back to a random free port when busy.
 * This transport requests ITS OWN random port so a run can never collide with
 * (or hijack) a Cline desktop sidecar. The ready line carries an
 * approval_token, so it is consumed internally and NEVER published to a
 * transcript or a log.
 *
 * PROTOCOL. Connect to `wsEndpoint` with header `Origin: http://127.0.0.1:3125`
 * (the desktop's trusted origin). VERIFIED: without that exact header the
 * sidecar answers `tool approvals require a trusted desktop connection`, with
 * it, `poll_tool_approvals` returns []. Requests are
 * `{"id":N,"command":"…","args":{…}}`, responses `{"type":"response","id":N,
 * "ok":true,"result":…}` / `{"ok":false,"error":…}`, pushes
 * `{"type":"event","event":{"name":…,"payload":…}}`.
 *
 * TURN. `chat_session_command {action:"start",config:{workspaceRoot,cwd,
 * provider,model,mode:"act",enableTools,sessionId}}` -> `{sessionId,…}`;
 * `{action:"send",sessionId,prompt}` BLOCKS until the turn ends and returns
 * `{result:{text,finishReason,usage,toolCalls}}`. The streamed events all
 * precede that response (measured on every run): chat_session_status,
 * chat_event{chat_reasoning|chat_text|chat_usage|chat_tool_call_start/update/
 * end|chat_done}.
 *
 * LIFECYCLE, measured:
 *  - cancel: `{action:"abort"}` -> `{sessionId,ok:true}`; the in-flight send
 *    then resolves with finishReason "aborted" and chat_done carries
 *    `{"reason":"aborted"}` (verified at t+5s of a long turn).
 *  - resume: start with `config.sessionId` reopens the SAME session (verified:
 *    the reply answered from earlier context, runCount incremented).
 *  - shutdown: there is NO shutdown command (87 commands, none), and the
 *    sidecar does NOT exit when its WS closes (still alive 60s after a clean
 *    code-1000 close). So after the turn ends this transport tree-kills the
 *    process IT started — a completed run therefore ends code null/SIGTERM by
 *    design, which is exactly why success for this agent is decided by the
 *    `chat_done{reason:"completed"}` frame and never by the exit code.
 *  - side effect: launching a sidecar makes Cline's own runtime start its hub
 *    daemon (`~/.cline`, ws://127.0.0.1:25463/hub) if none is running. That is
 *    Cline's normal operation; this transport neither configures nor stops it.
 */

import { EventHub } from '../../core/event-hub.ts';
import { log } from '../../core/log.ts';
import { ManagedProcess, type CleanupResult } from '../spawn.ts';
import type {
  LauncherSpec,
  SubscribeOptions,
  Transport,
  TransportExit,
  TransportFrame,
  TransportKind,
} from '../../core/types.ts';

/** The desktop's origin; the only one the sidecar treats as trusted. */
export const CLINE_TRUSTED_ORIGIN = 'http://127.0.0.1:3125';

const READY_TIMEOUT_MS = 20_000;
const WS_OPEN_TIMEOUT_MS = 15_000;
const START_RPC_TIMEOUT_MS = 60_000;
const ABORT_TIMEOUT_MS = 3_000;
const POLL_RPC_TIMEOUT_MS = 5_000;
const APPROVAL_POLL_MS = 1_500;
const POST_TURN_GRACE_MS = 250;
const KILL_DELAY_MS = 300;
/**
 * The sidecar's `start` schema rejects an empty `model` (`too_small`), and it
 * has no server-side default: without a requested model we must send one. This
 * is the exact id every live probe on this machine ran with (free tier, cost
 * always 0), so it is the only model here whose behaviour is measured.
 */
const DEFAULT_CLINE_MODEL = 'cline-free/mimo-v2.6-flash';

// ---- wire shapes --------------------------------------------------------

export interface ClineEventPayload {
  sessionId?: string;
  environmentId?: string;
  status?: string;
  stream?: string;
  chunk?: unknown;
  [key: string]: unknown;
}

export interface ClineWsMessage {
  type?: string;
  id?: number;
  ok?: boolean;
  result?: unknown;
  error?: unknown;
  event?: { name?: string; payload?: ClineEventPayload };
}

/** Structural view of the global WebSocket (Node >= 22 ships one). */
export interface ClineWsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (ev: never) => void, options?: { once?: boolean }): void;
}

type WsCtor = new (url: string, options?: { headers?: Record<string, string> }) => ClineWsLike;

interface WsMessageEvent {
  readonly data?: unknown;
}
interface WsCloseEvent {
  readonly code?: number;
}
interface WsErrorEvent {
  readonly message?: string;
}

/** Extract the wsEndpoint from a candidate stdout line, or null. */
export function parseClineReady(line: string): string | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try {
    const obj = JSON.parse(t) as { wsEndpoint?: unknown };
    return typeof obj.wsEndpoint === 'string' && obj.wsEndpoint.startsWith('ws') ? obj.wsEndpoint : null;
  } catch {
    return null;
  }
}

/**
 * One WebSocket conversation with a sidecar: request/response correlation
 * plus an event callback. Shared by the transport and the adapter's probe, so
 * both speak the protocol exactly the same way.
 */
export class ClineSocket {
  private readonly ws: ClineWsLike;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }
  >();
  private cmdId = 0;
  private closed = false;
  private readonly onEvent: ((msg: ClineWsMessage) => void) | undefined;
  private readonly onClose: ((code: number | null) => void) | undefined;

  private constructor(
    ws: ClineWsLike,
    handlers: { onEvent?: (msg: ClineWsMessage) => void; onClose?: (code: number | null) => void },
  ) {
    this.ws = ws;
    this.onEvent = handlers.onEvent;
    this.onClose = handlers.onClose;
    ws.addEventListener('message', (ev: never) => this.handleMessage(ev as unknown as WsMessageEvent));
    ws.addEventListener('close', (ev: never) => this.handleClose(ev as unknown as WsCloseEvent));
    // Errors surface through the close event; nothing to do here.
    ws.addEventListener('error', () => undefined);
  }

  static async open(
    wsEndpoint: string,
    opts: {
      origin?: string;
      openTimeoutMs?: number;
      onEvent?: (msg: ClineWsMessage) => void;
      onClose?: (code: number | null) => void;
    } = {},
  ): Promise<ClineSocket> {
    const Ctor = (globalThis as { WebSocket?: WsCtor }).WebSocket;
    if (!Ctor) {
      throw new Error('global WebSocket is unavailable (this adapter needs Node >= 22)');
    }
    const ws = new Ctor(wsEndpoint, { headers: { Origin: opts.origin ?? CLINE_TRUSTED_ORIGIN } });
    const sock = new ClineSocket(ws, { onEvent: opts.onEvent, onClose: opts.onClose });
    const timeoutMs = opts.openTimeoutMs ?? WS_OPEN_TIMEOUT_MS;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`cline WebSocket did not open within ${timeoutMs}ms`));
      }, timeoutMs);
      ws.addEventListener(
        'open',
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        'error',
        (ev: never) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const msg = (ev as unknown as WsErrorEvent).message;
          reject(new Error(`cline WebSocket failed to open${msg ? `: ${msg}` : ''}`));
        },
        { once: true },
      );
    });
    return sock;
  }

  /** One request. `timeoutMs` is omitted for long turns: the session's own deadline owns that. */
  rpc(command: string, args: unknown, timeoutMs?: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.closed || this.ws.readyState !== 1) {
        reject(new Error('cline WebSocket is not open'));
        return;
      }
      const id = ++this.cmdId;
      const entry: { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> } =
        { resolve, reject };
      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error(`timeout waiting for ${command}`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      try {
        this.ws.send(JSON.stringify({ id, command, args }));
      } catch (e) {
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(e as Error);
      }
    });
  }

  close(code = 1000, reason = 'done'): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close(code, reason);
    } catch {
      /* already gone */
    }
    this.failPending(new Error('cline connection is closing'));
  }

  private failPending(err: Error): void {
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  private handleMessage(ev: WsMessageEvent): void {
    let msg: ClineWsMessage;
    try {
      msg = JSON.parse(String(ev.data)) as ClineWsMessage;
    } catch {
      return;
    }
    if (msg.type === 'response' && typeof msg.id === 'number') {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.ok) {
        entry.resolve(msg.result);
      } else {
        const err = msg.error;
        entry.reject(new Error(typeof err === 'string' ? err : safeStringify(err)));
      }
      return;
    }
    if (msg.type === 'event') this.onEvent?.(msg);
  }

  private handleClose(ev: WsCloseEvent): void {
    const wasClosed = this.closed;
    this.closed = true;
    this.failPending(new Error('cline connection closed'));
    if (!wasClosed) this.onClose?.(typeof ev.code === 'number' ? ev.code : null);
  }
}

// ---- transport ----------------------------------------------------------

export interface ClineTransportOptions {
  readonly launcher: LauncherSpec;
  /** Workspace handed to start as BOTH cwd and workspaceRoot. */
  readonly cwd: string;
  readonly prompt: string;
  readonly model?: string;
  /** Resume target: start's `config.sessionId`. */
  readonly threadId?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly origin?: string;
  readonly readyTimeoutMs?: number;
  readonly hub?: EventHub<TransportFrame>;
}

export class ClineSidecarTransport implements Transport {
  readonly kind: TransportKind = 'app-server';
  readonly commandLine: string;

  private readonly hub: EventHub<TransportFrame>;
  private readonly opts: ClineTransportOptions;
  private proc: ManagedProcess | null = null;
  private sock: ClineSocket | null = null;
  private wsEndpoint: string | null = null;
  private sessionId: string | null = null;

  private started = false;
  private disposed = false;
  private readySeen = false;
  private finishing = false;
  private turnSettled = false;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly turnDone: Promise<void>;
  private settleTurnDone: () => void = () => undefined;
  private readonly startGate: Promise<void>;
  private openStartGate: () => void = () => undefined;

  private cleanupDone = false;
  private cleanup: CleanupResult = { rootKilled: false, descendantsReaped: false, note: 'not attempted' };

  constructor(options: ClineTransportOptions) {
    this.opts = options;
    this.hub = options.hub ?? new EventHub<TransportFrame>({ recentCapacity: 256 });
    this.commandLine = `${options.launcher.command}  # cline sidecar; prompt rides the WebSocket`;
    this.turnDone = new Promise<void>((res) => {
      this.settleTurnDone = res;
    });
    this.startGate = new Promise<void>((res) => {
      this.openStartGate = res;
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.openStartGate();
    // A private port: never the desktop's 3126, and a busy one falls back to
    // a random free port inside the sidecar anyway (measured).
    const port = 42000 + Math.floor(Math.random() * 2000);
    const proc = new ManagedProcess({
      launcher: this.opts.launcher,
      args: [],
      cwd: this.opts.cwd,
      env: { ...(this.opts.env ?? {}), CLINE_SIDECAR_PORT: String(port) },
      onStdoutLine: (line) => this.onStdoutLine(line),
      onStderrLine: (line) => this.hub.publish({ channel: 'stderr', text: line }),
    });
    this.proc = proc;
    void proc.exited.then((exit) => {
      if (!this.turnSettled) {
        this.endTurn({
          error: `cline sidecar exited before completing the turn (code ${exit.code ?? 'null'}, signal ${exit.signal ?? 'none'})`,
        });
      }
    });
    this.readyTimer = setTimeout(() => {
      if (!this.readySeen) {
        this.endTurn({
          error: `cline sidecar printed no ready line within ${this.opts.readyTimeoutMs ?? READY_TIMEOUT_MS}ms`,
        });
      }
    }, this.opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
  }

  events(opts: SubscribeOptions = {}): AsyncIterable<TransportFrame> {
    return this.hub.subscribe(opts);
  }

  /**
   * Resolves when the turn is over AND the sidecar process is gone. The exit
   * code is normally null/SIGTERM because a completed run is torn down by this
   * transport (the sidecar has no shutdown of its own) — see the header.
   */
  async wait(): Promise<TransportExit> {
    if (!this.started) await this.startGate;
    await this.turnDone;
    const proc = this.proc;
    if (!proc) {
      this.hub.close();
      return {
        code: null,
        signal: null,
        stderrTail: '',
        stderrTruncated: false,
        cleanup: { rootKilled: false, descendantsReaped: false, note: 'process never started' },
      };
    }
    const exit = await proc.exited;
    await proc.settleCleanup();
    if (!this.cleanupDone) {
      this.cleanupDone = true;
      try {
        this.cleanup = await proc.reapDescendants(`exit ${exit.code ?? 'null'}`);
      } catch (e) {
        this.cleanup = {
          rootKilled: false,
          descendantsReaped: false,
          note: `reap threw: ${(e as Error).message}`,
        };
      }
    }
    this.hub.close();
    return {
      code: exit.code,
      signal: exit.signal,
      stderrTail: proc.stderrTail.toString(),
      stderrTruncated: proc.stderrTail.truncated,
      cleanup: this.cleanup,
    };
  }

  /** Abort the turn on Cline's side, then stop the process we started. */
  async cancel(reason: string): Promise<void> {
    const sock = this.sock;
    if (sock && !this.finishing && this.sessionId) {
      try {
        await Promise.race([
          sock.rpc('chat_session_command', { request: { action: 'abort', sessionId: this.sessionId } }, ABORT_TIMEOUT_MS),
          delay(ABORT_TIMEOUT_MS),
        ]);
      } catch {
        /* the teardown below stops the run either way */
      }
    }
    this.endTurn();
    const proc = this.proc;
    if (proc && proc.exitCode === null) await proc.cancel(reason);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stopPoll();
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    try {
      this.sock?.close(1000, 'disposed');
    } catch {
      /* ignore */
    }
    this.hub.close();
  }

  // ---- internals --------------------------------------------------------

  private onStdoutLine(line: string): void {
    if (!this.readySeen) {
      const endpoint = parseClineReady(line);
      if (endpoint) {
        this.readySeen = true;
        this.wsEndpoint = endpoint;
        if (this.readyTimer) {
          clearTimeout(this.readyTimer);
          this.readyTimer = null;
        }
        void this.drive();
        return;
      }
      // Noise before the ready line: kept, never swallowed.
    }
    this.hub.publish({ channel: 'stdout', text: line });
  }

  /** start -> send -> graceful teardown. Every failure funnels into endTurn. */
  private async drive(): Promise<void> {
    try {
      const endpoint = this.wsEndpoint;
      if (!endpoint) throw new Error('no wsEndpoint: the sidecar ready line never arrived');
      const sock = await ClineSocket.open(endpoint, {
        origin: this.opts.origin,
        onEvent: (msg) => this.onEvent(msg),
        onClose: (code) => {
          if (!this.finishing) {
            this.endTurn({
              error: `cline WebSocket closed unexpectedly (code ${code ?? 'n/a'}) before the turn completed`,
            });
          }
        },
      });
      this.sock = sock;
      const startRes = (await sock.rpc('chat_session_command', {
        request: { action: 'start', config: this.startConfig() },
      }, START_RPC_TIMEOUT_MS)) as { sessionId?: unknown } | null;
      const sessionId = typeof startRes?.sessionId === 'string' ? startRes.sessionId : null;
      if (!sessionId) {
        throw new Error(`cline start returned no sessionId: ${safeStringify(startRes).slice(0, 200)}`);
      }
      this.sessionId = sessionId;
      this.startApprovalPoll(sock);
      const sendRes = (await sock.rpc('chat_session_command', {
        request: { action: 'send', sessionId, prompt: this.opts.prompt },
      })) as { result?: { finishReason?: unknown } } | null;
      const finishReason = typeof sendRes?.result?.finishReason === 'string' ? sendRes.result.finishReason : 'unknown';
      log.debug('cline turn finished', { sessionId, finishReason });
      // Measured: every event precedes the send response. One beat anyway, so
      // a trailing frame can never be lost to the close below.
      await delay(POST_TURN_GRACE_MS);
      this.endTurn();
    } catch (e) {
      this.endTurn({ error: `cline turn failed: ${(e as Error).message}` });
    }
  }

  private startConfig(): Record<string, unknown> {
    const cfg: Record<string, unknown> = {
      workspaceRoot: this.opts.cwd,
      cwd: this.opts.cwd,
      provider: 'cline',
      mode: 'act',
      // A coding agent without tools is not this agent; Cline's sidecar
      // auto-approves by default (measured: a file read executed with no
      // approval round-trip). We never approve anything ourselves — see
      // startApprovalPoll.
      enableTools: true,
    };
    const model = this.opts.model?.trim();
    cfg.model = model ? model : DEFAULT_CLINE_MODEL;
    if (this.opts.threadId) cfg.sessionId = this.opts.threadId;
    return cfg;
  }

  private onEvent(msg: ClineWsMessage): void {
    this.hub.publish({ channel: 'protocol', text: safeStringify(msg), data: msg });
    if (msg.event?.name === 'ask_question_requested') {
      // Cline pauses for an interactive answer; there is no channel for one
      // here, so fail fast with the reason instead of stalling to the deadline.
      this.endTurn({
        error:
          'cline asked an interactive question (ask_question_requested) and this adapter has no channel to answer it',
      });
    }
  }

  /**
   * A queued tool approval means the run would otherwise stall forever (the
   * transport has no way to approve). Default sidecar behaviour auto-approves,
   * so in practice this poll always returns [] — it exists to turn a would-be
   * hang into a fast, explained failure.
   */
  private startApprovalPoll(sock: ClineSocket): void {
    this.pollTimer = setInterval(() => {
      if (this.finishing) return;
      void sock
        .rpc('poll_tool_approvals', { sessionId: this.sessionId }, POLL_RPC_TIMEOUT_MS)
        .then((r) => {
          const items = Array.isArray(r) ? (r as Array<{ toolName?: string }>) : [];
          if (items.length > 0 && !this.finishing) {
            const tool = items[0]?.toolName ?? 'a tool';
            this.endTurn({
              error:
                `cline queued a tool approval for "${tool}" and this adapter has no approval channel. ` +
                `The sidecar auto-approves by default (measured); a queued approval means auto-approve ` +
                `was disabled in Cline's own settings.`,
            });
          }
        })
        .catch(() => {
          /* transient: the close/cancel paths own real failures */
        });
    }, APPROVAL_POLL_MS);
  }

  private stopPoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * The single exit from a running turn, normal or failed. Idempotent: the
   * first call wins, so a failure racing a normal completion can never publish
   * a spurious error after the run already finished.
   */
  private endTurn(opts: { error?: string } = {}): void {
    if (this.finishing) return;
    this.finishing = true;
    this.stopPoll();
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    if (opts.error) this.publishError(opts.error);
    try {
      this.sock?.close(1000, 'run finished');
    } catch {
      /* ignore */
    }
    this.turnSettled = true;
    this.settleTurnDone();
    const proc = this.proc;
    if (proc && proc.exitCode === null) {
      setTimeout(() => {
        if (proc.exitCode === null) {
          void proc.cancel('cline sidecar has no shutdown command; stopping it after the turn');
        }
      }, KILL_DELAY_MS);
    }
  }

  /** A synthetic frame the adapter maps into a native error signal. */
  private publishError(message: string): void {
    log.warn('cline transport error', { message });
    const frame = { type: 'cline_error', error: message };
    this.hub.publish({ channel: 'protocol', text: safeStringify(frame), data: frame });
  }
}

// ---- helpers ------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((res) => {
    setTimeout(res, ms);
  });
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
