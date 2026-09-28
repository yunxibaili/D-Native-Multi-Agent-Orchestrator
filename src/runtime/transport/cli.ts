/**
 * runtime/transport/cli.ts — the first `Transport` implementation.
 *
 * `CliJsonlTransport` is a native CLI reached over a process, framing stdout as
 * newline-delimited frames. It is deliberately the ONLY place that knows about
 * stdout/stderr, so `AgentSession` has no CLI assumptions and a future ACP or
 * app-server transport can be added without touching it.
 */

import { EventHub } from '../../core/event-hub.ts';
import { log } from '../../core/log.ts';
import { ManagedProcess, type ProcessExit } from '../spawn.ts';
import type {
  LauncherSpec,
  SubscribeOptions,
  Transport,
  TransportExit,
  TransportFrame,
  TransportKind,
} from '../../core/types.ts';

export interface CliTransportOptions {
  launcher: LauncherSpec;
  args: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
  stdin?: string;
  stderrTailBytes?: number;
  /** Diagnostics are surfaced to the hub so the session can persist them. */
  hub?: EventHub<TransportFrame>;
}

export class CliJsonlTransport implements Transport {
  readonly kind: TransportKind = 'cli-jsonl';
  readonly commandLine: string;

  private readonly hub: EventHub<TransportFrame>;
  private readonly opts: CliTransportOptions;
  private proc: ManagedProcess | null = null;
  private started = false;
  private disposed = false;
  private cleanupDone = false;
  /** Resolves once the process exists, so `wait()` is safe to call first. */
  private readonly ready: Promise<void>;
  private signalReady: (() => void) | null = null;

  constructor(options: CliTransportOptions) {
    this.opts = options;
    // A real window of retained frames, so a subscriber that attaches a tick
    // late still sees the opening events.
    this.hub = options.hub ?? new EventHub<TransportFrame>({ recentCapacity: 256 });
    this.commandLine = [options.launcher.command, ...options.args].join(' ');
    this.ready = new Promise<void>((res) => {
      this.signalReady = res;
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const proc = new ManagedProcess({
      launcher: this.opts.launcher,
      args: this.opts.args,
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdin: this.opts.stdin,
      stderrTailBytes: this.opts.stderrTailBytes,
      onStdoutLine: (line) => this.publish({ channel: 'stdout', text: line }),
      onStderrLine: (line) => this.publish({ channel: 'stderr', text: line }),
    });
    this.proc = proc;
    this.signalReady?.();
    this.signalReady = null;
  }

  events(opts: SubscribeOptions = {}): AsyncIterable<TransportFrame> {
    return this.hub.subscribe(opts);
  }

  /**
   * Resolves when the agent process is gone and its output has drained.
   *
   * Deliberately tolerant of call order: awaiting `start()` internally means a
   * caller that races `wait()` against `start()` gets the exit rather than an
   * exception, so a missed start can never strand the caller.
   */
  async wait(): Promise<TransportExit> {
    if (!this.proc) await this.ready;
    const proc = this.proc;
    if (!proc) {
      this.hub.close();
      return { code: null, signal: null, stderrTail: '', stderrTruncated: false };
    }
    const exit = await proc.exited;
    // Process-tree cleanup contract. Best-effort by design (see
    // ManagedProcess.reapDescendants): a Windows job object would be the only
    // fully reliable mechanism, and we do not take a native dependency for it.
    // The attempt is awaited so a leak is observable rather than silent.
    await proc.settleCleanup();
    if (!this.cleanupDone) {
      this.cleanupDone = true;
      try {
        await proc.reapDescendants(`exit ${exit.code ?? 'null'}`);
      } catch (e) {
        log.debug('descendant reap failed', { error: (e as Error).message });
      }
    }
    this.hub.close();
    return {
      code: exit.code,
      signal: exit.signal,
      stderrTail: proc.stderrTail.toString(),
      stderrTruncated: proc.stderrTail.truncated,
    };
  }

  async cancel(reason: string): Promise<void> {
    if (!this.proc) return;
    await this.proc.cancel(reason);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.hub.close();
  }

  /** Diagnostics accessor for adapters that need the raw tail. */
  get stderrTail(): string {
    return this.proc?.stderrTail.toString() ?? '';
  }

  private publish(frame: TransportFrame): void {
    this.hub.publish(frame);
  }
}

export type { ProcessExit };
