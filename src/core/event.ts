/**
 * core/event.ts — the one event shape every agent is projected into.
 *
 * Rules (from the brief + REUSE_ANALYSIS):
 *  1. `raw` is ALWAYS populated with the agent's untouched payload. Normalized
 *     fields are additive, never lossy. This is the anti-over-normalization
 *     guarantee: nothing an agent said can be unrecoverable.
 *  2. Every event is JSON-serializable and safe to write to a file / post to a
 *     browser / replay.
 *  3. Event names are stable. Adding a new `type` is a minor version; changing
 *     the meaning of one is a major version.
 */

export const RUNTIME_EVENT_TYPES = [
  'session.started',
  'session.output',
  'session.progress',
  'session.tool_call',
  'session.diagnostic',
  'session.completed',
  'session.failed',
  'session.cancelled',
] as const;

export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];

export interface RuntimeEvent {
  readonly type: RuntimeEventType;
  readonly taskId: string;
  readonly agentId: string;
  /** Agent's own session/thread id, once known. Null before first native event. */
  readonly threadId: string | null;
  /** ms since epoch, stamped by the runtime (not the agent). */
  readonly at: number;
  /** Free text. For output/completed this is the assistant text. */
  readonly text?: string;
  /** Structured extras, agent-shaped. See ToolCallShape / UsageShape. */
  readonly data?: Record<string, unknown>;
  /** The agent's original payload, verbatim. */
  readonly raw: unknown;
}

export type ToolCallShape = {
  name: string;
  callId?: string;
  status?: string;
  input?: unknown;
  output?: string;
  exitCode?: number | null;
};

export function started(args: Common, raw: unknown, data?: Record<string, unknown>): RuntimeEvent {
  return make('session.started', args, raw, undefined, data);
}

export function output(args: Common, raw: unknown, text: string): RuntimeEvent {
  return make('session.output', args, raw, text);
}

export function progress(args: Common, raw: unknown, data: Record<string, unknown>): RuntimeEvent {
  return make('session.progress', args, raw, undefined, data);
}

export function toolCall(
  args: Common,
  raw: unknown,
  call: ToolCallShape,
): RuntimeEvent {
  return make('session.tool_call', args, raw, undefined, { tool: call as unknown as Record<string, unknown> });
}

export function diagnostic(args: Common, raw: unknown, text: string): RuntimeEvent {
  return make('session.diagnostic', args, raw, text);
}

export function completed(
  args: Common,
  raw: unknown,
  text: string,
  data: Record<string, unknown>,
): RuntimeEvent {
  return make('session.completed', args, raw, text, data);
}

export function failed(
  args: Common,
  raw: unknown,
  message: string,
  data: Record<string, unknown>,
): RuntimeEvent {
  return make('session.failed', args, raw, message, data);
}

export function cancelled(args: Common, raw: unknown, reason: string): RuntimeEvent {
  return make('session.cancelled', args, raw, reason);
}

export interface Common {
  taskId: string;
  agentId: string;
  threadId: string | null;
}

function make(
  type: RuntimeEventType,
  args: Common,
  raw: unknown,
  text?: string,
  data?: Record<string, unknown>,
): RuntimeEvent {
  const ev: RuntimeEvent = {
    type,
    taskId: args.taskId,
    agentId: args.agentId,
    threadId: args.threadId,
    at: Date.now(),
    raw: sanitize(raw),
  };
  // Optional fields are omitted rather than set to undefined, so the JSON stays
  // compact and a strict frontend can use `in` checks.
  if (text !== undefined) (ev as { text?: string }).text = text;
  if (data !== undefined) (ev as { data?: Record<string, unknown> }).data = data;
  return ev;
}

/**
 * Guarantee JSON-serializability. Agents can emit anything (BigInt in usage
 * counters, circular refs in tool state); we keep the structure but make it
 * safe to persist, and we do not drop content.
 */
export function sanitize(value: unknown): unknown {
  return walk(value, 0, new WeakSet<object>());
}

const MAX_DEPTH = 12;

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'number') return Number.isFinite(value as number) ? value : String(value);
  if (t === 'bigint') return (value as bigint).toString();
  if (t === 'undefined') return null;
  if (t === 'function' || t === 'symbol') return `[${t}]`;

  if (depth >= MAX_DEPTH) return '[max-depth]';

  const obj = value as object;
  if (seen.has(obj)) return '[circular]';
  seen.add(obj);

  if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1, seen));

  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (value instanceof Date) return value.toISOString();

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = walk(v, depth + 1, seen);
  }
  return out;
}
