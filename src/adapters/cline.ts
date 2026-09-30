/**
 * adapters/cline.ts — Cline's native sidecar, no provider API of our own.
 *
 * Transport: `D:\Cline\code-sidecar.exe` (Bun single-file, appVersion 0.0.32)
 * spawns, prints one ready line, and the run then rides a WebSocket
 * (`runtime/transport/cline.ts` documents the measured protocol in full).
 * There is no CLI entry point at all: 87 WS commands, argv ignored. This is
 * the orchestrator's first `app-server` transport.
 *
 * MEASURED, NOT ASSUMED (each capability below):
 *   newTask          start+send produced a turn and a sessionId — verified
 *   resume           start config.sessionId reopened the SAME session; the
 *                    reply answered from earlier context (runCount 1 -> 2)
 *   modelSelection   config.model -> modelInfo.id in the result — verified
 *                    with cline-free/mimo-v2.6-flash
 *   streamEvents     chat_event frames (reasoning/text/usage/tool calls/done)
 *                    observed on every run
 *   cwd              config.cwd + workspaceRoot echoed back verbatim
 *   review           false: no review command exists among the 87
 *   roleSelection    false: sessions have no per-run role to select
 *   sandbox          false: no sandbox exists; tools auto-approve (measured),
 *                    so a sandbox request would be a lie
 *   costReporting    false: `cost` was 0 on every measured (free-tier) run;
 *                    a paid figure was never observed, so none is claimed
 *   extraArgs        false: argv is swallowed by the sidecar (measured with
 *                    --help/--version), so flags would be silently dropped
 *
 * EXIT CODE IS NEVER SUCCESS HERE (measured): the sidecar has no shutdown
 * command and does not exit when its WebSocket closes (alive 60s after a clean
 * close), so the transport tree-kills it after the turn — a completed run ends
 * null/SIGTERM by design. Success is therefore `chat_done{reason:"completed"}`,
 * required as protocol evidence; a zero-looking exit alone fails the run.
 */

import { InvalidRequestError, UnsupportedOptionError } from '../core/errors.ts';
import * as E from '../core/event.ts';
import type { RuntimeEvent } from '../core/event.ts';
import { resolveCommand } from '../runtime/discover.ts';
import { ManagedProcess } from '../runtime/spawn.ts';
import {
  ClineSidecarTransport,
  ClineSocket,
  parseClineReady,
  type ClineWsMessage,
} from '../runtime/transport/cline.ts';
import { describeFailure } from './opencode.ts';
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentDescriptor,
  LauncherSpec,
  MapContext,
  ProbeResult,
  RunRequest,
  TerminalDecision,
  TerminalInput,
  TerminalPolicy,
  Transport,
  TransportFrame,
  Usage,
  UsagePatch,
} from '../core/types.ts';

const PROBE_READY_MS = 15_000;
const PROBE_OPEN_MS = 10_000;
const PROBE_RPC_MS = 8_000;

const CAPABILITIES: AgentCapabilities = {
  newTask: true,
  resume: true, // start config.sessionId — verified end to end
  // No review command among the sidecar's 87 commands.
  review: false,
  modelSelection: true, // config.model — verified
  // Sessions carry no per-run role; nothing here could honour one.
  roleSelection: false,
  // No sandbox exists, and the sidecar auto-approves tools by default
  // (measured), so advertising one would silently mean nothing.
  sandbox: false,
  streamEvents: true, // chat_event frames — observed on every run
  // `cost` read 0 on every measured run (free tier). A paid figure was never
  // observed, so no cost figure is claimed.
  costReporting: false,
  // argv is swallowed by the sidecar — verified with --help / --version.
  extraArgs: false,
  // Honoured through config.cwd + workspaceRoot, echoed back by start.
  cwd: true,
  // Declared false on purpose: none of these are wired through this adapter.
  steering: false,
  worktree: false,
  fork: false,
  stdinPrompt: false,
};

/**
 * Protocol evidence for a successful run, recorded as native signals because
 * `TerminalInput` carries only exit / signals / localAbort — and the adapter
 * instance is created ONCE at bootstrap while `NativeSink` is per run.
 */
export const EVIDENCE_DONE = 'protocol-evidence: chat_done completed';
export const EVIDENCE_OUTPUT = 'protocol-evidence: assistant text frame';
/** Upper bound on remembered runs; reaching it just clears, never throws. */
const EVIDENCE_TASK_LIMIT = 64;

function noteOnce(
  seen: Set<string>,
  taskId: string,
  signal: string,
  sink: MapContext['sink'],
): void {
  if (seen.has(taskId)) return;
  if (seen.size >= EVIDENCE_TASK_LIMIT) seen.clear();
  seen.add(taskId);
  sink.noteNativeSignal(signal);
}

export function createClineAdapter(config?: {
  /** Absolute path to code-sidecar.exe; wins over discovery for this agent. */
  command?: string;
  /** Bypass discovery. Tests exercise pure mapping with a stub. */
  launcher?: LauncherSpec;
  version?: string;
}): AgentAdapter {
  const launcher = config?.launcher ?? resolveCommand('cline', config?.command).launcher;

  // Which runs already recorded each evidence kind (shared instance, per-run
  // sink — see noteOnce).
  const doneEvidenced = new Set<string>();
  const outputEvidenced = new Set<string>();
  // chat_tool_call_end ids already accumulated into RunResult.toolCalls.
  const notedCalls = new Set<string>();
  const NOTED_CALL_LIMIT = 512;

  const descriptor: AgentDescriptor = {
    id: 'cline',
    displayName: 'Cline (code-sidecar)',
    launcher,
    version: config?.version,
    transport: 'app-server',
    capabilities: CAPABILITIES,
    // Reference only. The sidecar authenticates with Cline's own stored
    // account; this adapter never opens those files.
    credentialsHint: '~/.cline (read by Cline itself; this adapter never reads it)',
  };

  /**
   * Refuse anything Cline cannot honour. Every `false` above is enforced
   * here rather than being a decorative flag.
   */
  const validateRequest = (req: RunRequest): void => {
    if (req.mode === 'review' && req.threadId) {
      throw new InvalidRequestError(
        'cline',
        'mode=review together with threadId',
        `A review has no conversation to continue. Drop threadId, or use the ` +
          `default mode with threadId to resume.`,
      );
    }
    if (req.mode === 'review') {
      throw new UnsupportedOptionError(
        'cline',
        'the native review mode',
        `Cline has no review command. Use "orchestrator review codex …", or run ` +
          `a review prompt with "orchestrator run cline …".`,
      );
    }
    if (req.sandbox !== undefined) {
      throw new UnsupportedOptionError(
        'cline',
        'a sandbox setting (`--sandbox`)',
        `The Cline sidecar exposes no sandbox and auto-approves its tools by ` +
          `default (measured), so a sandbox request would be silently ignored. ` +
          `Use the codex adapter for OS-level write restriction, or drop --sandbox.`,
      );
    }
    if (req.role !== undefined) {
      throw new UnsupportedOptionError(
        'cline',
        'a role/agent selection (`--role`)',
        `Cline sessions have no per-run role to select. Drop --role.`,
      );
    }
    if (req.extraArgs?.length) {
      throw new UnsupportedOptionError(
        'cline',
        'extra argv flags',
        `The sidecar ignores argv entirely (measured: --help and --version are ` +
          `swallowed), so extra flags would be dropped without a trace. ` +
          `Configure the run over the WebSocket instead, or drop extraArgs.`,
      );
    }
  };

  /**
   * The turn decides, never the exit code: a completed run is torn down by the
   * transport (the sidecar has no shutdown of its own), so its exit is
   * null/SIGTERM by design.
   */
  const terminalPolicy: TerminalPolicy = (input: TerminalInput): TerminalDecision => {
    if (input.localAbort) {
      return {
        state: 'failed',
        error: {
          code: input.localAbort === 'timed_out' ? 'TIMED_OUT' : 'CANCELLED',
          message: `local abort: ${input.localAbort}`,
        },
      };
    }
    const signals = input.nativeSignals;
    if (signals.includes(EVIDENCE_DONE)) return { state: 'succeeded', error: null };

    const errSignal = signals.find((s) => s.startsWith('error:'));
    if (errSignal) {
      const message = errSignal.slice('error: '.length);
      return {
        state: 'failed',
        error: {
          code: 'TRANSPORT_ERROR',
          message,
          retryable: /timeout|ECONN|ETIMEDOUT|rate limit|429|overloaded|closed/i.test(message),
        },
      };
    }

    const turnSignal = signals.find((s) => s.startsWith('cline:turn:'));
    const why = turnSignal
      ? `the turn ended with reason "${turnSignal.slice('cline:turn:'.length)}"`
      : signals.includes(EVIDENCE_OUTPUT)
        ? 'assistant text streamed but the turn never reported completion'
        : 'no chat_done frame arrived';

    const exit = input.exit;
    if (exit.code !== null && exit.code !== 0) {
      return {
        state: 'failed',
        error: {
          code: 'NONZERO_EXIT',
          message: describeFailure('cline', input),
          retryable: /unable to connect|timeout|ECONN|ETIMEDOUT|EAI_AGAIN|429/i.test(exit.stderrTail),
        },
      };
    }
    return {
      state: 'failed',
      error: {
        code: 'TRANSPORT_ERROR',
        message:
          `cline sidecar produced no completion signal: ${why}. ` +
          (exit.code === 0
            ? `The process exited 0, which is not success for this agent — success is ` +
              `the chat_done frame. `
            : `The process stopped without a status (signal ${exit.signal ?? 'none'}). `) +
          (exit.stderrTail ? `stderr: ${exit.stderrTail.slice(-300)}` : `No stderr was produced.`),
        retryable: false,
      },
    };
  };

  return {
    descriptor,
    terminalPolicy,
    validateRequest,

    /**
     * Spawn a sidecar, ask it who it is over the real protocol, tear it down.
     * The ready line (which carries an approval_token) is parsed, never logged.
     */
    async probe(): Promise<ProbeResult> {
      const holder: { endpoint: string | null } = { endpoint: null };
      const proc = new ManagedProcess({
        launcher,
        args: [],
        cwd: process.cwd(),
        onStdoutLine: (line) => {
          if (holder.endpoint) return;
          const ep = parseClineReady(line);
          if (ep) holder.endpoint = ep;
        },
        onStderrLine: () => undefined,
      });

      let version: string | null = null;
      let ok = false;
      let detail = '';
      try {
        const outcome = await Promise.race([
          waitFor(() => holder.endpoint !== null, PROBE_READY_MS, 'the sidecar ready line'),
          proc.exited.then((e) => `the sidecar exited before it was ready (code ${e.code ?? 'null'})` as const),
        ]);
        if (outcome !== true) throw new Error(outcome);
        const sock = await ClineSocket.open(holder.endpoint!, { openTimeoutMs: PROBE_OPEN_MS });
        try {
          const ctx = (await sock.rpc('get_process_context', {}, PROBE_RPC_MS)) as { appVersion?: unknown } | null;
          version = typeof ctx?.appVersion === 'string' ? ctx.appVersion : null;
          ok = true;
          detail = version ? `Cline sidecar reachable (appVersion ${version})` : 'Cline sidecar reachable';
        } finally {
          sock.close(1000, 'probe');
        }
      } catch (e) {
        ok = false;
        detail = `cline sidecar probe failed: ${(e as Error).message}`;
      }
      // Never leave a probed sidecar behind — it has no shutdown of its own.
      await proc.cancel('probe complete');
      await proc.exited;
      return ok
        ? { ok: true, launcher, version, detail, warnings: [] }
        : { ok: false, launcher, version, detail, warnings: [] };
    },

    createTransport(req: RunRequest): Transport {
      validateRequest(req);
      return new ClineSidecarTransport({
        launcher,
        cwd: req.cwd,
        prompt: req.prompt,
        model: req.model,
        threadId: req.threadId,
      });
    },

    mapEvent(frame: TransportFrame, ctx: MapContext): RuntimeEvent[] {
      const out: RuntimeEvent[] = [];
      const msg = frame.data as (ClineWsMessage & { error?: unknown }) | undefined;
      if (!msg || typeof msg !== 'object') return out;

      const payload = msg.event?.payload;
      if (payload?.sessionId) ctx.sink.noteThreadId(payload.sessionId);
      const c = { taskId: ctx.taskId, agentId: ctx.agentId, threadId: payload?.sessionId ?? ctx.threadId };

      if (msg.type === 'cline_error') {
        const message = typeof msg.error === 'string' ? msg.error : safeJson(msg.error);
        ctx.sink.noteNativeSignal(`error: ${message}`);
        out.push(E.progress(c, msg, { kind: 'error', message }));
        return out;
      }
      if (msg.type !== 'event' || !msg.event?.name) {
        // Unknown/uncorrelated frame: surfaced, never swallowed.
        out.push(E.progress(c, msg, { kind: 'native', nativeType: `cline:${msg.type ?? 'unknown'}` }));
        return out;
      }

      const name = msg.event.name;
      switch (name) {
        case 'host_ready':
          out.push(E.progress(c, msg, { kind: 'host_ready' }));
          break;

        case 'chat_session_status':
          out.push(E.progress(c, msg, { kind: 'session_status', status: String(payload?.status ?? '') }));
          break;

        case 'chat_event':
          mapChatEvent(payload, c, ctx, out, {
            doneEvidenced,
            outputEvidenced,
            notedCalls,
            NOTED_CALL_LIMIT,
          });
          break;

        default:
          // ask_question_requested, prompts_in_queue_state, session_deleted, …
          out.push(E.progress(c, msg, { kind: 'native', nativeType: `cline:${name}` }));
      }
      return out;
    },
  };
}

// ---- chat_event mapping -------------------------------------------------

interface EvidenceSets {
  doneEvidenced: Set<string>;
  outputEvidenced: Set<string>;
  notedCalls: Set<string>;
  NOTED_CALL_LIMIT: number;
}

function mapChatEvent(
  payload: { stream?: unknown; chunk?: unknown } | undefined,
  c: { taskId: string; agentId: string; threadId: string | null },
  ctx: MapContext,
  out: RuntimeEvent[],
  sets: EvidenceSets,
): void {
  const stream = typeof payload?.stream === 'string' ? payload.stream : '';
  const chunk = payload?.chunk;

  switch (stream) {
    case 'chat_text': {
      const text = typeof chunk === 'string' ? chunk : '';
      if (!text) break;
      ctx.sink.noteText(text);
      noteOnce(sets.outputEvidenced, c.taskId, EVIDENCE_OUTPUT, ctx.sink);
      out.push(E.output(c, payload, text));
      break;
    }

    case 'chat_reasoning': {
      const o = parseChunkObj(chunk);
      const text = typeof o?.text === 'string' ? o.text : '';
      // Thinking is progress, not output: it must not pollute the answer.
      out.push(E.progress(c, payload, { kind: 'reasoning', text }));
      break;
    }

    case 'chat_usage': {
      const o = parseChunkObj(chunk);
      const usage = o ? usageFrom(o) : null;
      if (usage) ctx.sink.noteUsage(usage);
      break;
    }

    case 'chat_done': {
      const o = parseChunkObj(chunk) ?? {};
      // The measured chat_done nests its run totals under `usage`; accept a
      // flat shape too, since an absent `usage` simply yields null here.
      const usage = usageFrom(parseChunkObj(o.usage) ?? o);
      if (usage) ctx.sink.noteUsage(usage);
      const reason = typeof o.reason === 'string' ? o.reason : 'unknown';
      if (reason === 'completed') {
        noteOnce(sets.doneEvidenced, c.taskId, EVIDENCE_DONE, ctx.sink);
      } else {
        // aborted / failed / … : explains, never decides on its own.
        ctx.sink.noteNativeSignal(`cline:turn:${reason}`);
      }
      out.push(
        E.progress(c, payload, {
          kind: 'turn_done',
          reason,
          iterations: typeof o.iterations === 'number' ? o.iterations : undefined,
        }),
      );
      break;
    }

    case 'chat_tool_call_start':
    case 'chat_tool_call_update': {
      const o = parseChunkObj(chunk) ?? {};
      out.push(
        E.toolCall(c, payload, {
          name: typeof o.toolName === 'string' ? o.toolName : 'tool',
          callId: typeof o.toolCallId === 'string' ? o.toolCallId : undefined,
          status: 'in_progress',
          input: o.input,
        }),
      );
      break;
    }

    case 'chat_tool_call_end': {
      const o = parseChunkObj(chunk) ?? {};
      const callId = typeof o.toolCallId === 'string' ? o.toolCallId : undefined;
      const call = {
        name: typeof o.toolName === 'string' ? o.toolName : 'tool',
        callId,
        status: 'completed',
        output: flattenToolOutput(o.output),
      };
      // Accumulated once per call id: `NativeSink` appends rather than upserts.
      const alreadyNoted = callId !== undefined && sets.notedCalls.has(callId);
      if (!alreadyNoted) {
        if (callId !== undefined) {
          if (sets.notedCalls.size >= sets.NOTED_CALL_LIMIT) sets.notedCalls.clear();
          sets.notedCalls.add(callId);
          ctx.sink.noteToolCall(call);
        } else {
          ctx.sink.noteToolCall(call);
        }
      }
      out.push(E.toolCall(c, payload, call));
      break;
    }

    default:
      out.push(E.progress(c, payload, { kind: 'native', nativeType: `chat_event:${stream || 'unknown'}` }));
  }
}

// ---- payload helpers ----------------------------------------------------

function parseChunkObj(chunk: unknown): Record<string, unknown> | null {
  if (chunk && typeof chunk === 'object') return chunk as Record<string, unknown>;
  if (typeof chunk === 'string' && chunk.startsWith('{')) {
    try {
      const o = JSON.parse(chunk) as unknown;
      return o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Cline sends per-request counters (`inputTokens`) plus cumulative run totals
 * (`totalInputTokens`); `chat_done`'s nested `usage` carries the run totals as
 * its plain counters. Prefer the cumulative figure so a multi-iteration turn
 * sums once.
 */
function usageFrom(u: Record<string, unknown>): Partial<Usage> | null {
  const patch: UsagePatch = {};
  const input = num(u.totalInputTokens) ?? num(u.inputTokens);
  const output = num(u.totalOutputTokens) ?? num(u.outputTokens);
  const cache = num(u.cacheReadTokens);
  const cost = num(u.totalCost) ?? num(u.cost);
  if (input !== undefined) patch.inputTokens = input;
  if (output !== undefined) patch.outputTokens = output;
  if (cache !== undefined) patch.cachedInputTokens = cache;
  if (input !== undefined && output !== undefined) patch.totalTokens = input + output;
  // costReporting is false: only a non-zero, actually observed figure would be
  // surfaced, and none ever was.
  if (cost !== undefined && cost > 0) patch.costUsd = cost;
  return Object.keys(patch).length ? patch : null;
}

/**
 * Tool output arrives as `[{query, result}, …]` for reads (measured) and may
 * be a plain string or object for other tools. Flatten to text without losing
 * content.
 */
function flattenToolOutput(output: unknown): string | undefined {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const item of output) {
      if (typeof item === 'string') parts.push(item);
      else if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        parts.push(typeof o.result === 'string' ? o.result : safeJson(o));
      }
    }
    return parts.length ? parts.join('\n') : undefined;
  }
  if (output && typeof output === 'object') return safeJson(output);
  return undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function waitFor(pred: () => boolean, ms: number, what: string): Promise<true> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = (): void => {
      if (pred()) {
        resolve(true);
        return;
      }
      if (Date.now() - t0 >= ms) {
        reject(new Error(`timed out after ${ms}ms waiting for ${what}`));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}
