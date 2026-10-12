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

// ---------------------------------------------------------------------------
// R5-1.2 (§8): THE one execution-timeout validator.
//
// Every execution timeout eventually reaches `setTimeout`, and Node silently
// clamps delays above 2^31-1 ms down to 1 ms — an "infinite" timeout that
// becomes an instant kill. Validation therefore lives HERE, in the lowest
// layer, so every entry point (round CLI, task Orchestrator, runtime merged
// config, direct AgentSession construction) shares ONE function and none can
// bypass it. Fail-closed at the boundary:
//
//   - NaN / negative / non-finite  -> refused
//   - 0                            -> refused (unlimited execution is not
//                                     silently supported; making it legal is a
//                                     design decision, not a default)
//   - > NODE_TIMER_MAX_MS          -> refused instead of silently becoming ~1 ms
//   - below MIN_EXECUTION_TIMEOUT_MS -> refused (a deadline of 0 or a sub-tick
//                                     instant is not a deadline, it is a malfunction;
//                                     the floor is deliberately small so real-time
//                                     deadline tests exercise the same code path)
// ---------------------------------------------------------------------------
export const NODE_TIMER_MAX_MS = 2_147_483_647;
export const MIN_EXECUTION_TIMEOUT_MS = 50;

export function validateExecutionTimeout(ms: number): { ok: true; value: number } | { ok: false; reason: string } {
  if (typeof ms !== 'number' || Number.isNaN(ms)) {
    return { ok: false, reason: `execution timeout must be a number of milliseconds, got ${String(ms)}` };
  }
  if (!Number.isFinite(ms)) {
    return { ok: false, reason: `execution timeout must be finite, got ${String(ms)}` };
  }
  if (ms <= 0) {
    return { ok: false, reason: `execution timeout must be positive (got ${ms}); unlimited execution is not supported - making it legal is a design decision, not a default` };
  }
  if (ms > NODE_TIMER_MAX_MS) {
    return { ok: false, reason: `execution timeout ${ms}ms exceeds the Node timer maximum (${NODE_TIMER_MAX_MS} ms); a larger value would silently become a ~1 ms deadline` };
  }
  if (ms < MIN_EXECUTION_TIMEOUT_MS) {
    return { ok: false, reason: `execution timeout ${ms}ms is below the minimum (${MIN_EXECUTION_TIMEOUT_MS} ms)` };
  }
  return { ok: true, value: ms };
}

export type TransportKind = 'cli-jsonl' | 'acp' | 'app-server';

/**
 * The directory layout a task executes in.
 *
 * Declared here, in the lowest layer, because the capability model must be able
 * to name a mode without the capability layer depending on the workspace
 * implementation. `src/orchestration/workspace.ts` re-exports this, so
 * `import { WorkspaceMode } from './workspace'` keeps working.
 *
 *   - `shared`    — one directory, many tasks. Concurrent writers conflict.
 *   - `isolated`  — a private `git worktree` per task.
 */
export type WorkspaceMode = 'isolated' | 'shared';

/**
 * B1.4: a user's Agent × Model SELECTION, at the PROJECT or TASK layer.
 *
 *  - `auto`   defer to the existing LAYA Agent × Model decision (unchanged).
 *  - `fixed`  the user pinned an exact Agent Family and a FULL model id; scheduling
 *             must honour it exactly and never substitute.
 *
 * Precedence is `resolveSelection` (task > project > auto). This is a plain value —
 * no SelectionManager, no router, no policy engine. Enforcement reuses the existing
 * `explicitPair` path in Assignment, so a fixed pair still runs through every
 * capability / availability / quota / workspace / spawn-gate filter and may be
 * REFUSED; it is never auto-substituted, and a fixed PAID model is not by itself
 * an authorization to spend.
 */
export type SelectionSpec =
  | { readonly mode: 'auto' }
  | { readonly mode: 'fixed'; readonly agentId: string; readonly modelId: string };

/** Resolve the effective selection: task overrides project, else auto. */
export function resolveSelection(task?: SelectionSpec, project?: SelectionSpec): SelectionSpec {
  return task ?? project ?? { mode: 'auto' };
}

/** The exact pair a FIXED selection names, or undefined for `auto`. */
export function fixedPairOf(
  selection: SelectionSpec,
): { readonly agentId: string; readonly modelId: string } | undefined {
  return selection.mode === 'fixed' ? { agentId: selection.agentId, modelId: selection.modelId } : undefined;
}

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
  /**
   * Whether the adapter can ASK the agent to load one of ITS OWN skills.
   *
   * NOT a skill catalogue and NOT a routing input: the orchestrator has no list of
   * skill names, never checks that a requested skill exists, and this field must
   * never become a filter or preference (a skill is not a reason to pick a worker).
   * It says one thing only — whether asking is a supported request for this agent.
   *
   * EVIDENCE (2026-10-01, this machine, real runs, not inspection):
   *   - `opencode --help` has no skill subcommand; discovery is filesystem-based
   *     (`~/.agents/skills/<name>/SKILL.md`) plus a `skill` tool.
   *   - A real `opencode run` whose brief requested `archify` reported its
   *     frontmatter exactly — `name=archify version=2.16 author=tt-a1i` — so the
   *     request genuinely reached and loaded the file.
   *   - A real run requesting a non-existent skill returned `name=UNAVAILABLE`
   *     rather than inventing content, so an unsatisfiable ask degrades honestly.
   *   - `codex --help` exposes no skill mechanism; its skills are prompt text only.
   *
   * So `true` here means "the agent honours the ASK". Whether a SPECIFIC name
   * resolves is the agent's own business and stays unverified by design — which is
   * why the brief says "use your own if you have them; otherwise continue without".
   */
  skills: boolean;
  steering: boolean;
  /**
   * Whether the adapter implements a NATIVE worktree/fork REQUEST — i.e. the
   * agent asking for its own checkout. `RunRequest` cannot carry such a field,
   * so this stays `false` for every agent and must not be confused with
   * `workspaceModes` below: that one is about being PLACED in a directory we
   * chose, this one is about the agent creating one itself.
   */
  worktree: boolean;
  fork: boolean;
  stdinPrompt: boolean;
  /**
   * Which workspace modes this agent may be ADMITTED into.
   *
   * FAIL-CLOSED: an absent field means `['shared']` only. An agent nobody has
   * verified is never quietly placed in an isolated worktree.
   *
   * `cwd: true` is NECESSARY but not sufficient here. Honouring a directory is
   * one requirement; the other is that parallel instances in different
   * directories do not fight over shared per-agent state (a session store, a
   * config file, a lock). That second property is separate evidence per agent,
   * which is why it is declared rather than inferred from `cwd`.
   *
   * Capability is NOT implementation: git worktrees work (5C-5) regardless of
   * this field. This only decides whether a given agent is allowed to use one.
   */
  readonly workspaceModes?: readonly WorkspaceMode[];
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
  /**
   * R2 observability: a READ-ONLY snapshot of the native execution, when the
   * implementation can provide one. Optional — a handle without it is simply
   * "process state UNKNOWN" to the monitor. It carries NO control: nothing here
   * can kill, restart, or steer the process, and the dashboard never receives a
   * way to call anything but this.
   */
  observe?: () => RunObservation;
}

/**
 * Machine-side execution facts, read at observation time. Every field is what the
 * runtime ACTUALLY sees; absent means "not observable", never zero/success.
 */
export interface RunObservation {
  readonly taskId: string;
  readonly agentId: string;
  readonly cwd: string;
  readonly startedAt: number;
  /** Native process id, when the transport exposed one. */
  readonly pid: number | null;
  /** The exact command line the transport launched. */
  readonly commandLine: string | null;
  /** 'running' = the process has not produced its terminal result yet. */
  readonly processState: 'running' | 'exited';
  readonly exitCode: number | null;
  /** Last time the runtime observed output from the process (wall clock). */
  readonly lastOutputAt: number | null;
  /** Bounded per-tool-call summary (the machine evidence for "tests ran"). */
  readonly toolCalls: readonly ToolCall[];
  /** Bounded tail of the agent's own output (CLAIMED, never a fact). */
  readonly outputTail: string | null;
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

/**
 * W3.2: what the runtime can PROVE about OS process creation for an execution.
 *
 *   `not-started`       the runtime proved nothing was ever created (launcher proven
 *                       absent, control setup refused, request rejected before spawn,
 *                       image not found). The ONLY value that may release a WRITE
 *                       scope without a tree-stop proof.
 *   `may-have-started`  the edge was entered and creation was possible, with no proof
 *                       either way. The conservative default.
 *   `started`           a process was created.
 *
 * It lives here, in `core`, rather than beside the execution seam because both the
 * runtime (`ManagedProcess`) and orchestration consume it, and `core` must not depend
 * on `orchestration`.
 */
export type ProcessStartDisposition = 'not-started' | 'may-have-started' | 'started';

export interface CleanupReport {
  /** True only when a tree kill was issued against a LIVE root. */
  readonly rootKilled: boolean;
  readonly descendantsReaped: boolean;
  readonly note: string;
  /**
   * W3: has the PHYSICAL descendant tree been CONFIRMED stopped?
   *
   * This is a different question from every other field here, and the only one
   * that may gate a WRITE-scope release. `rootKilled` says a kill was attempted;
   * `descendantsReaped` describes best-effort cleanup; neither is evidence that
   * the tree is gone. Only this is.
   *
   * It is true only when the containment producer positively observed the Job's
   * `ActiveProcesses == 0` (naturally, or after a cooperative termination on
   * request). A killed launcher, a missing control record, an unconfirmed stop or
   * any non-Windows path leaves it false, and the caller must retain write
   * protection instead of releasing it.
   */
  readonly treeStopConfirmed: boolean;
  /**
   * W3.2: what the runtime can PROVE about OS process creation for this execution.
   *
   * Carried on the report so a run that ends in a frozen result — rather than a throw —
   * can still release its WRITE scope when the runtime proved nothing was ever created.
   * Without it, "the launcher binary did not exist" would retain physical protection
   * forever and leave the scope permanently blocked even after the operator fixed it.
   *
   * `'not-started'` is only ever set by the runtime process layer from a positively
   * known pre-spawn failure. Absent means "not observable", which is treated as NOT
   * proven — never as zero/success.
   */
  readonly processStart: ProcessStartDisposition;
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
  /** R2 observability: native process id while running, when the transport has one. */
  readonly pid?: number | null;
  /** Begin the work. Must be safe to call once. */
  start: () => void;
  /** Framed agent output. Independent, multi-subscriber consumption. */
  events: (opts?: SubscribeOptions) => AsyncIterable<TransportFrame>;
  /** Resolves when the agent process is gone and output has drained. */
  wait: () => Promise<TransportExit>;
  /** Stop the agent, including descendants where the platform allows.
   *
   * R5-1.2C (§9): returns `true` when the stop is CONFIRMED. Resolving `false` (or
   * rejecting) means the end state is UNKNOWN — the process tree may still be running.
   * It used to be typed `Promise<void>`, so a `false` from the real CLI transport was
   * indistinguishable from success and a `cancelled` terminal could be produced for an
   * execution that was still alive. The confirmation is now part of the contract, so it
   * cannot be discarded by accident. A transport that genuinely cannot confirm may
   * resolve `undefined` (treated as "unknown", never as confirmed).
   */
  cancel: (reason: string) => Promise<boolean | void>;
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
