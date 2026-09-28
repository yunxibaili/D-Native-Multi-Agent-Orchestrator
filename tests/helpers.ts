/**
 * tests/helpers.ts — deterministic doubles.
 *
 * Contract tests must not depend on a real agent, a network, or what happens
 * to be installed on the machine. These doubles let a test say exactly what an
 * agent will do (emit these frames, then exit with this code) and assert the
 * runtime's guarantees around it.
 */

import { EventHub } from '../src/core/event-hub.ts';
import { UnsupportedOptionError } from '../src/core/errors.ts';
import * as E from '../src/core/event.ts';
import type { RuntimeEvent } from '../src/core/event.ts';
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentDescriptor,
  LauncherSpec,
  MapContext,
  ProbeResult,
  RunRequest,
  SubscribeOptions,
  TerminalDecision,
  TerminalInput,
  TerminalPolicy,
  ToolCall,
  Transport,
  TransportExit,
  TransportFrame,
  TransportKind,
  Usage,
} from '../src/core/types.ts';

export const FAKE_LAUNCHER: LauncherSpec = {
  kind: 'native',
  command: 'fake-agent',
  prefixArgs: [],
  target: 'fake-agent',
  buildsCommandString: false,
};

export const NO_CAPABILITIES: AgentCapabilities = {
  newTask: true,
  resume: false,
  review: false,
  modelSelection: false,
  roleSelection: false,
  sandbox: false,
  streamEvents: true,
  costReporting: false,
  extraArgs: false,
  cwd: true,
  steering: false,
  worktree: false,
  fork: false,
  stdinPrompt: false,
};

export type ScriptStep =
  | { kind: 'frame'; channel?: 'stdout' | 'stderr'; text: string; data?: unknown }
  | { kind: 'exit'; code: number | null; signal?: string | null; stderrTail?: string }
  /** Stay alive until cancelled. Used for cancel/timeout tests. */
  | { kind: 'hang' };

/**
 * A transport that replays a script. Nothing is spawned, so the contract tests
 * are instant and independent of the machine.
 */
export class FakeTransport implements Transport {
  readonly kind: TransportKind = 'cli-jsonl';
  readonly commandLine = 'fake-agent <script>';

  private readonly hub = new EventHub<TransportFrame>({ defaultBuffer: 64, recentCapacity: 32 });
  private cancelResolve: (() => void) | null = null;
  private cancelled = false;
  private disposed = false;
  /**
   * The script can finish BEFORE the session calls wait() (start() runs in a
   * microtask). Storing the exit means a late wait() still resolves, exactly
   * as a real process that has already exited would.
   */
  private settledExit: TransportExit | null = null;
  exitWaiters: Array<(e: TransportExit) => void> = [];
  cancelCount = 0;
  disposedCount = 0;

  private readonly script: ScriptStep[];

  constructor(script: ScriptStep[] = [{ kind: 'exit', code: 0 }]) {
    this.script = script;
  }

  start(): void {
    // Deliver asynchronously, as a real stream would.
    queueMicrotask(() => void this.run());
  }

  events(opts: SubscribeOptions = {}): AsyncIterable<TransportFrame> {
    return this.hub.subscribe(opts);
  }

  wait(): Promise<TransportExit> {
    if (this.settledExit) return Promise.resolve(this.settledExit);
    return new Promise<TransportExit>((res) => {
      this.exitWaiters.push(res);
    });
  }

  private settle(exit: TransportExit): void {
    this.settledExit = exit;
    this.hub.close();
    for (const w of this.exitWaiters.splice(0)) w(exit);
  }

  async cancel(_reason: string): Promise<void> {
    this.cancelCount++;
    this.cancelled = true;
    this.cancelResolve?.();
    this.cancelResolve = null;
    this.settle({
      code: null,
      signal: 'SIGTERM',
      stderrTail: 'cancelled by test',
      stderrTruncated: false,
    });
  }

  async dispose(): Promise<void> {
    this.disposedCount++;
    this.disposed = true;
  }

  get wasDisposed(): boolean {
    return this.disposed;
  }

  private async run(): Promise<void> {
    for (const step of this.script) {
      if (this.cancelled) return;
      if (step.kind === 'frame') {
        this.hub.publish({
          channel: step.channel ?? 'stdout',
          text: step.text,
          data: step.data ?? safeParse(step.text),
        });
      } else if (step.kind === 'hang') {
        // Never completes on its own; only cancel/timeout ends it.
        await new Promise<void>((res) => {
          this.cancelResolve = res;
        });
        return;
      } else {
        this.settle({
          code: step.code,
          signal: step.signal ?? null,
          stderrTail: step.stderrTail ?? '',
          stderrTruncated: false,
        });
        return;
      }
    }
  }
}

function safeParse(text: string): unknown {
  const t = text.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

export interface FakeAdapterOptions {
  id?: string;
  capabilities?: Partial<AgentCapabilities>;
  script?: ScriptStep[];
  terminalPolicy?: TerminalPolicy;
  /** Reject any request that carries one of these option names. */
  rejects?: readonly string[];
  transportKind?: TransportKind;
  created?: Transport[];
}

export function createFakeAdapter(options: FakeAdapterOptions = {}): AgentAdapter {
  const id = options.id ?? 'fake';
  const capabilities: AgentCapabilities = { ...NO_CAPABILITIES, ...options.capabilities };
  const created: Transport[] = [];
  const rejects = new Set(options.rejects ?? []);

  const descriptor: AgentDescriptor = {
    id,
    displayName: `Fake ${id}`,
    launcher: FAKE_LAUNCHER,
    transport: options.transportKind ?? 'cli-jsonl',
    capabilities,
  };

  const defaultPolicy: TerminalPolicy = (input: TerminalInput): TerminalDecision => {
    if (input.exit.code === 0) return { state: 'succeeded', error: null };
    return {
      state: 'failed',
      error: {
        code: 'NONZERO_EXIT',
        message: `exit ${input.exit.code}${input.exit.stderrTail ? `: ${input.exit.stderrTail}` : ''}`,
      },
    };
  };

  return {
    descriptor,
    terminalPolicy: options.terminalPolicy ?? defaultPolicy,

    async probe(): Promise<ProbeResult> {
      return { ok: true, launcher: FAKE_LAUNCHER, version: '0.0.0-fake', detail: 'fake', warnings: [] };
    },

    validateRequest(req: RunRequest): void {
      const bag = req as unknown as Record<string, unknown>;
      for (const opt of ['sandbox', 'model', 'role', 'extraArgs', 'mode'] as const) {
        const present = opt === 'extraArgs' ? (req.extraArgs?.length ?? 0) > 0 : bag[opt] !== undefined;
        if (present && rejects.has(opt)) {
          throw new UnsupportedOptionError(id, opt, `fake agent refuses ${opt}.`);
        }
        if (present && opt !== 'extraArgs' && !capabilitiesSupports(opt, capabilities)) {
          throw new UnsupportedOptionError(id, opt, `fake agent has no ${opt} support.`);
        }
      }
    },

    createTransport(req: RunRequest): Transport {
      const t = new FakeTransport(options.script);
      created.push(t);
      void req;
      return t;
    },

    mapEvent(frame: TransportFrame, ctx: MapContext): RuntimeEvent[] {
      const data = frame.data as { text?: string; session?: string } | undefined;
      const c = { taskId: ctx.taskId, agentId: ctx.agentId, threadId: data?.session ?? ctx.threadId };
      if (frame.channel === 'stderr') {
        ctx.sink.noteDiagnostic(`stderr: ${frame.text}`);
        return [E.diagnostic(c, frame, frame.text)];
      }
      if (typeof data?.text === 'string') {
        ctx.sink.noteText(data.text);
        return [E.output(c, frame, data.text)];
      }
      return [E.progress(c, frame, { kind: 'native' })];
    },
  };
}

function capabilitiesSupports(opt: string, caps: AgentCapabilities): boolean {
  switch (opt) {
    case 'sandbox':
      return caps.sandbox;
    case 'model':
      return caps.modelSelection;
    case 'role':
      return caps.roleSelection;
    case 'mode':
      return caps.review;
    default:
      return true;
  }
}

export interface RecordingSink {
  texts: string[];
  tools: ToolCall[];
  diags: string[];
  signals: string[];
  usage: Array<Partial<Usage>>;
  thread: string | null;
  ctx: MapContext;
}

export function recordingSink(): RecordingSink {
  const texts: string[] = [];
  const tools: ToolCall[] = [];
  const diags: string[] = [];
  const signals: string[] = [];
  const usage: Array<Partial<Usage>> = [];
  let thread: string | null = null;
  const ctx: MapContext = {
    taskId: 'tsk_test',
    agentId: 'test',
    threadId: null,
    sink: {
      noteThreadId: (id) => {
        if (!thread) thread = id;
      },
      noteText: (t) => texts.push(t),
      noteToolCall: (c) => tools.push(c),
      noteUsage: (u) => usage.push(u),
      noteDiagnostic: (d) => diags.push(d),
      noteNativeSignal: (s) => signals.push(s),
    },
  };
  return {
    ctx,
    texts,
    tools,
    diags,
    signals,
    usage,
    get thread() {
      return thread;
    },
  };
}
