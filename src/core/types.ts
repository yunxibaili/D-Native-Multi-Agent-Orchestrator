/**
 * core/types.ts — the contract every layer agrees on.
 *
 * This round hardened the following, each because a review found it broken:
 *  - Outcome states are terminal and FROZEN. `result()` can be called any
 *    number of times and always returns the identical object; it can never
 *    fabricate a state. (Previously `result()` hard-coded `'succeeded'`.)
 *  - `timed_out` is distinct from `cancelled`. A deadline is not a user abort.
 *  - Capabilities are checked at the ADAPTER, and a request carrying an option
 *    the agent cannot honour is REJECTED. Nothing is silently dropped.
 *  - Transport is a real seam with a lifecycle, not a metadata string, so an
 *    ACP or app-server transport can be added without touching the session.
 *
 * No provider API shapes here. Adapters only ever spawn local processes.
 */

import type { RuntimeEvent } from './event.ts';

/** Terminal-vs-running lifecycle of ONE execution. */
export const TASK_STATES = ['running', 'succeeded', 'failed', 'cancelled', 'timed_out'] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** States that can never change once entered. */
export type TerminalState = Exclude<TaskState, 'running'>;

const TERMINAL: ReadonlySet<TaskState> = new Set<TaskState>([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);

export function isTerminal(state: TaskState): state is TerminalState {
  return TERMINAL.has(state);
}

export type TransportKind = 'cli-jsonl' | 'acp' | 'app-server';

/**
 * Capabilities that are actually implemented and verified. A field may only be
 * `true` if the adapter honours the option end to end; otherwise the adapter
 * must reject the request in `validateRequest`.
 */
export interface AgentCapabilities {
  newTask: boolean;
  resume: boolean;
  /** Native structured review entrypoint (`codex exec review`). */
  review: boolean;
  modelSelection: boolean;
  roleSelection: boolean;
  /** OS-level write restriction (`codex --sandbox`). */
  sandbox: boolean;
  streamEvents: boolean;
  /** Per-agent cost figure. Codex reports tokens only, so this is false. */
  costReporting: boolean;
  /** Raw argv passthrough. Both agents forward unknown flags to the CLI. */
  extraArgs: boolean;
  /**
   * The adapter is willing to forward a `cwd` and honour it. Required for
   * resume ownership checks to mean anything.
   */
  cwd: boolean;
  /**
   * All `false` here on purpose — declared so callers can feature-detect
   * rather than guess. Implementing any of them requires implementing them.
   */
  steering: boolean;
  worktree: boolean;
  fork: boolean;
  stdinPrompt: boolean;
}

export interface AgentDescriptor {
  /** Stable id used in config and the CLI. Never a global "current" agent. */
  readonly id: string;
  readonly displayName: string;
  /** How the process is launched. */
  readonly launcher: LauncherSpec;
  readonly version?: string;
  readonly transport: TransportKind;
  readonly capabilities: AgentCapabilities;
  /** Where the agent keeps its own login. Reference only; never read. */
  readonly credentialsHint?: string;
}

/** What the caller asks for. `agentId` is required — never defaulted. */
export interface RunRequest {
  readonly agentId: string;
  /** Free-form task. This is the agent's own prompt, not our instructions. */
  readonly prompt: string;
  readonly cwd: string;
  /** Resume target. Validated for ownership before use — see resumeFor(). */
  readonly threadId?: string;
  readonly model?: string;
  readonly role?: string;
  readonly sandbox?: string;
  readonly mode?: 'default' | 'review';
  readonly extraArgs?: readonly string[];
  /** Deadline. Exceeding it yields `timed_out`, never `cancelled`. */
  readonly timeoutMs?: number;
  readonly transcriptDir?: string;
  /**
   * Explicit opt-in to resume a thread owned by another agent or directory.
   * Defaults to false. An override must be requested, never assumed.
   */
  readonly allowForeignThread?: boolean;
}

// ---- results ------------------------------------------------------------

export interface ToolCall {
  readonly name: string;
  readonly callId?: string;
  readonly status?: string;
  readonly input?: unknown;
  readonly output?: string;
  readonly exitCode?: number | null;
}

export interface Usage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cachedInputTokens?: number;
  readonly totalTokens?: number;
  readonly costUsd?: number;
}

/** Mutable staging type for building a `Usage` incrementally. */
export type UsagePatch = { -readonly [K in keyof Usage]?: Usage[K] };

export type ErrorCode =
  | 'NONZERO_EXIT'
  | 'SPAWN_FAILED'
  | 'UNSUPPORTED_OPTION'
  | 'THREAD_NOT_FOUND'
  | 'THREAD_OWNERSHIP'
  | 'CANCELLED'
  | 'TIMED_OUT'
  | 'TRANSPORT_ERROR';

export interface RunErrorInfo {
  readonly code: ErrorCode;
  readonly message: string;
  /** True when a retry could plausibly succeed. Advisory only. */
  readonly retryable?: boolean;
}

export interface RunResult {
  readonly taskId: string;
  readonly threadId: string | null;
  readonly agentId: string;
  /** Never `'running'` on a returned result. */
  readonly state: TerminalState;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** Byte-bounded tail of assistant text. The transcript has everything. */
  readonly output: string;
  readonly outputTruncated: boolean;
  readonly transcriptPath: string | null;
  readonly usage: Usage;
  readonly toolCalls: readonly ToolCall[];
  /** Mandatory for every non-succeeded outcome. */
  readonly error: RunErrorInfo | null;
  /** Agent-emitted diagnostics. Never failures on their own. */
  readonly diagnostics: readonly string[];
  /**
   * What process-tree cleanup achieved. Informational only: it can never change
   * `state`, which is decided by the terminal policy from the exit code.
   */
  readonly cleanup: CleanupReport;
}

/** Live handle. `result()` is the ONLY way to learn the outcome. */
export interface RunHandle {
  readonly taskId: string;
  readonly agentId: string;
  readonly state: () => TaskState;
  /**
   * Independent, multi-subscriber event stream. Subscribing twice yields two
   * independent views; one consumer cannot starve another. The returned
   * subscription ends when the execution reaches a terminal state.
   */
  events: (opts?: SubscribeOptions) => EventSubscription;
  /**
   * Resolves with the frozen terminal result. Safe to call repeatedly and
   * concurrently: identical object every time, and never a fabricated state.
   * A `timeoutMs` here bounds only THIS call and does not alter the outcome.
   */
  result: (timeoutMs?: number) => Promise<RunResult>;
  cancel: (reason?: string) => Promise<void>;
}

// ---- event hub ----------------------------------------------------------

export interface SubscribeOptions {
  /**
   * Events to deliver before live ones.
   *  - `undefined` (default): only events published after subscribing.
   *  - `'replay'`: start with the hub's retained recent events, then live.
   * This is the explicit, documented late-subscriber semantic.
   */
  readonly replay?: 'none' | 'replay';
  /**
   * Max events buffered FOR THIS SUBSCRIBER before overflow applies.
   * A slow subscriber drops its own oldest events; it never blocks the
   * producer and never stalls other subscribers.
   */
  readonly buffer?: number;
}

export interface EventSubscription extends AsyncIterable<RuntimeEvent> {
  readonly id: number;
  /** Events discarded for this subscriber because it could not keep up. */
  readonly droppedCount: () => number;
  /** Stop receiving events and release the buffer immediately. */
  readonly close: () => void;
}

// ---- transport seam -----------------------------------------------------

/** How a process is launched. Produced by runtime/launcher.ts. */
export interface LauncherSpec {
  readonly kind: 'native' | 'cmd-wrapper';
  /** Executable handed to spawn(). */
  readonly command: string;
  /**
   * Arguments prepended to every invocation. For `cmd-wrapper` this is
   * `['/d', '/s', '/c']` and the real command line is appended (already
   * validated and escaped by the launcher).
   */
  readonly prefixArgs: readonly string[];
  /** The file the launcher ultimately runs, for diagnostics. */
  readonly target: string;
  /**
   * True when the launcher must build a single shell command string, which
   * makes argv-injection protection the launcher's responsibility.
   */
  readonly buildsCommandString: boolean;
}

/**
 * A frame of agent output, independent of how the agent is reached.
 * `channel` lets the session separate events from diagnostics without
 * assuming a CLI's stdout/stderr split.
 */
export interface TransportFrame {
  readonly channel: 'stdout' | 'stderr' | 'protocol';
  /** Untouched payload. */
  readonly text: string;
  /** Present when the transport parses natively (e.g. ACP JSON-RPC). */
  readonly data?: unknown;
}

export interface TransportExit {
  readonly code: number | null;
  readonly signal: string | null;
  /** Byte-bounded stderr tail; the only explanation for a startup crash. */
  readonly stderrTail: string;
  readonly stderrTruncated: boolean;
  /**
   * What process-tree cleanup achieved. Recorded rather than assumed, and
   * never able to change the outcome — the outcome comes from the exit code.
   */
  readonly cleanup: CleanupReport;
}

export interface CleanupReport {
  /** True only when a tree kill was issued against a LIVE root. */
  readonly rootKilled: boolean;
  readonly descendantsReaped: boolean;
  readonly note: string;
}

/**
 * The seam Phase 2 plugs ACP / app-server into.
 *
 * A transport knows how to REACH an agent and how to frame its output. It
 * knows nothing about events, sessions, retries or review policy. That keeps
 * `AgentSession` free of CLI assumptions such as "stdout is NDJSON".
 */
export interface Transport {
  readonly kind: TransportKind;
  readonly commandLine: string;
  /** Begin the work. Must be safe to call once. */
  start: () => void;
  /** Framed agent output. Independent, multi-subscriber consumption. */
  events: (opts?: SubscribeOptions) => AsyncIterable<TransportFrame>;
  /** Resolves when the agent process is gone and output has drained. */
  wait: () => Promise<TransportExit>;
  /** Stop the agent, including descendants where the platform allows. */
  cancel: (reason: string) => Promise<void>;
  /** Release resources. Called exactly once, after the outcome is frozen. */
  dispose: () => Promise<void>;
}

// ---- adapter ------------------------------------------------------------

/** Input to the terminal policy. */
export interface TerminalInput {
  readonly exit: TransportExit;
  /** Native signals the adapter saw, e.g. a stream-level error frame. */
  readonly nativeSignals: readonly string[];
  /** The agent cancelled/timeout was requested by us, not by the agent. */
  readonly localAbort: 'cancelled' | 'timed_out' | null;
}

export interface TerminalDecision {
  readonly state: 'succeeded' | 'failed';
  readonly error: RunErrorInfo | null;
}

/**
 * Decides the outcome. Owned by the ADAPTER rather than hard-coded in the
 * runtime, so an agent with its own notion of failure can express it.
 */
export type TerminalPolicy = (input: TerminalInput) => TerminalDecision;

/** Accumulator the adapter writes to. The runtime owns the storage. */
export interface NativeSink {
  noteThreadId(id: string): void;
  noteText(text: string): void;
  noteToolCall(call: ToolCall): void;
  noteUsage(usage: Partial<Usage>): void;
  noteDiagnostic(text: string): void;
  noteNativeSignal(signal: string): void;
}

export interface MapContext {
  readonly taskId: string;
  readonly agentId: string;
  readonly threadId: string | null;
  readonly sink: NativeSink;
}

export interface ProbeResult {
  readonly ok: boolean;
  readonly launcher: LauncherSpec;
  readonly version: string | null;
  readonly detail: string;
  readonly warnings: readonly string[];
}

/**
 * Adapter contract: resolve itself into a transport, map native frames into
 * unified events, validate requests, and decide the terminal outcome.
 */
export interface AgentAdapter {
  readonly descriptor: AgentDescriptor;
  /** Cheap liveness/version probe. Never prints credentials. */
  probe: () => Promise<ProbeResult>;
  /**
   * Reject anything the agent cannot honour. Must THROW rather than silently
   * ignore an unsupported option. Called before any process is started.
   */
  validateRequest: (req: RunRequest) => void;
  /** Build the transport for this request. */
  createTransport: (req: RunRequest) => Transport;
  /** Native frame -> zero or more runtime events. */
  mapEvent: (frame: TransportFrame, ctx: MapContext) => RuntimeEvent[];
  /** Decide the terminal outcome. */
  readonly terminalPolicy: TerminalPolicy;
}

export interface DoctorAgentReport {
  id: string;
  displayName: string;
  launcher: string;
  version: string | null;
  ok: boolean;
  detail: string;
  warnings: readonly string[];
  capabilities: AgentCapabilities;
  transport: TransportKind;
  credentialsHint: string | null;
}
