/**
 * Structural contract only — no behaviour decisions live in this file.
 * See docs/REUSE_ANALYSIS.md:
 *  - `Thread` vs `Task` split comes from agents-mcp-gateway: one task == one
 *    subprocess execution; a thread is the resumable conversation identity.
 *  - `AgentCapabilities` is a boolean matrix (not `throw notSupported` at
 *    runtime) so the orchestrator can gate *before* dispatching.
 *  - `RunHandle` exists because `run` returning must NOT mean "done"
 *    (native-agent-router's rule).
 *  - No provider API shapes here. Adapters only ever spawn local binaries.
 */

import type { RuntimeEvent } from './event.ts';

/** Transport used to reach an agent. Phase 1 implements `cli` only. */
export type Transport = 'cli' | 'acp';

/**
 * Terminal states only. Borrowed from native-agent-router's
 * `succeeded|failed|cancelled|blocked|interrupted`, narrowed:
 * `blocked` (workspace lock) is not a Phase 1 concept.
 */
export const TASK_STATES = ['running', 'succeeded', 'failed', 'cancelled', 'timeout'] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'succeeded',
  'failed',
  'cancelled',
  'timeout',
]);

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Capability matrix. Absent capability == the orchestrator must not call it.
 * Field semantics are deliberately narrow so future ACP/other agents fit.
 */
export interface AgentCapabilities {
  /** Spawn a brand-new conversation. */
  readonly newTask: boolean;
  /** Continue an existing thread with a new prompt. */
  readonly resume: boolean;
  /** Branch a thread instead of mutating it. */
  readonly fork: boolean;
  /** Native structured diff/review entrypoint (Codex `exec review`). */
  readonly review: boolean;
  /** Run in a managed git worktree. */
  readonly worktree: boolean;
  /** Accept prompt text on stdin instead of argv. */
  readonly stdinPrompt: boolean;
  /** Constrain filesystem writes (Codex `--sandbox`). */
  readonly sandbox: boolean;
  /** Machine-readable events on stdout. */
  readonly streamEvents: boolean;
  /** Per-agent role selection (Codex agents / profiles). */
  readonly roleSelection: boolean;
  /** Emit cost figures. Codex reports tokens only — this stays false. */
  readonly costReporting: boolean;
  /** Mid-run steering. No stdin channel -> false for one-shot CLIs. */
  readonly steering: boolean;
}

export interface AgentDescriptor {
  /** Stable id used in config and CLI. Never a global "current" agent. */
  readonly id: string;
  readonly displayName: string;
  /** Absolute path to the binary once resolved. */
  readonly executable: string;
  /** Version string, best-effort. */
  readonly version?: string;
  readonly transport: Transport;
  readonly capabilities: AgentCapabilities;
  /** Where the agent keeps its own login/credentials (read-only reference). */
  readonly credentialsHint?: string;
}

/** What the caller asks for. `agentId` is required — never defaulted. */
export interface RunRequest {
  readonly agentId: string;
  /** Free-form task. This is the agent's own prompt, not our instructions. */
  readonly prompt: string;
  /** Working directory the agent runs in. */
  readonly cwd: string;
  /** Resume target: a thread id from a previous run. */
  readonly threadId?: string;
  /** Native model selector, passed through verbatim (provider/model). */
  readonly model?: string;
  /** Native role/profile selector, passed through verbatim. */
  readonly role?: string;
  /** Codex sandbox mode etc. Only sent if the adapter declares support. */
  readonly sandbox?: string;
  /** Force review entrypoint when the agent provides one. */
  readonly mode?: 'default' | 'review';
  /** Extra flags appended verbatim. Escape hatch; not validated. */
  readonly extraArgs?: readonly string[];
  /** Hard wall-clock limit. Exceeding it cancels the task. */
  readonly timeoutMs?: number;
  /** Persistence dir for the full event transcript. */
  readonly transcriptDir?: string;
}

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

/**
 * Mutable staging type for building a `Usage` incrementally. Adapters fill a
 * plain object field by field, which `Partial<Usage>` forbids because
 * `Usage` is readonly. The result is still returned as `Partial<Usage>`.
 */
export type UsagePatch = { -readonly [K in keyof Usage]?: Usage[K] };

export interface RunResult {
  readonly taskId: string;
  readonly threadId: string | null;
  readonly agentId: string;
  readonly state: TaskState;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** Concatenated assistant text. Truncated to `outputTailLimit`. */
  readonly output: string;
  /** Full text written to the transcript, never truncated. */
  readonly transcriptPath: string | null;
  readonly usage: Usage;
  readonly toolCalls: readonly ToolCall[];
  /** Populated when state !== 'succeeded'. */
  readonly error: RunErrorInfo | null;
  /** Agent-emitted diagnostics (item.type === 'error', warnings). */
  readonly diagnostics: readonly string[];
}

export interface RunErrorInfo {
  readonly code: string;
  readonly message: string;
}

/** Live handle. `result` is the ONLY way to know an outcome. */
export interface RunHandle {
  readonly taskId: string;
  readonly agentId: string;
  readonly state: () => TaskState;
  /** Async iterable of unified events. May be consumed more than once. */
  events: () => AsyncIterable<RuntimeEvent>;
  /** @throws {TimeoutError} without killing the process. */
  result: (timeoutMs?: number) => Promise<RunResult>;
  cancel: (reason?: string) => Promise<void>;
}

/**
 * Adapter contract. Deliberately transport-shaped: an adapter knows how to
 * BUILD an invocation and how to MAP native events. It knows nothing about
 * processes, cancellation, persistence or retries.
 */
export interface AgentAdapter {
  readonly descriptor: AgentDescriptor;
  /** Cheap liveness/version probe. Never prints credentials. */
  probe: () => Promise<ProbeResult>;
  buildInvocation: (req: RunRequest) => Invocation;
  /** Native event -> zero or more runtime events. */
  mapEvent: (native: unknown, ctx: MapContext) => RuntimeEvent[];
  /** Native terminal signal, if the agent has one. */
  detectTerminal: (native: unknown) => TerminalSignal | null;
  /** Pull the final assistant text out of a native event. */
  extractText: (native: unknown) => string | null;
  /** Pull tool-call info out of a native event. */
  extractToolCall: (native: unknown) => ToolCall | null;
  /** Pull usage out of a native event. */
  extractUsage: (native: unknown) => Partial<Usage> | null;
}

export interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
  /** Prompt delivery. argv is the default; stdin avoids Windows quoting pain. */
  readonly promptVia: 'argv' | 'stdin';
  readonly env?: Readonly<Record<string, string>>;
}

export interface ProbeResult {
  readonly ok: boolean;
  readonly executable: string;
  readonly version: string | null;
  readonly detail: string;
  /** Non-fatal problems: config warnings, missing optional features. */
  readonly warnings: readonly string[];
}

export interface TerminalSignal {
  readonly success: boolean;
  readonly reason: string;
}

export interface MapContext {
  readonly taskId: string;
  readonly agentId: string;
  readonly threadId: string | null;
  /**
   * Accumulator owned by the runtime. The adapter is a pure mapper: it
   * *reports* what it saw and never owns state, so the kernel stays the only
   * place task state lives.
   */
  readonly sink: NativeSink;
}

export interface NativeSink {
  noteThreadId(id: string): void;
  noteText(text: string): void;
  noteToolCall(call: ToolCall): void;
  noteUsage(usage: Partial<Usage>): void;
  noteDiagnostic(text: string): void;
  noteNativeTerminal(signal: TerminalSignal): void;
}
