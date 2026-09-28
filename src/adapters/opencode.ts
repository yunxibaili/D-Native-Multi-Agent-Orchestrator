/**
 * adapters/opencode.ts — native OpenCode CLI, no provider API.
 *
 * Transport: `opencode run <prompt> --format json`, which streams newline
 * delimited JSON on **stdout** and leaves **stderr** for the log.
 * Everything below is derived from live 1.18.31 output captured on this
 * machine, not from documentation guesses.
 *
 * Observed native events (`--format json`):
 *   {"type":"step_start", "sessionID":"ses_…", "part":{…,"type":"step-start"}}
 *   {"type":"text",      "sessionID":"ses_…", "part":{"type":"text","text":"PONG"}}
 *   {"type":"tool_use",  "sessionID":"ses_…", "part":{"type":"tool","tool":"bash",
 *                        "callID":"…","state":{"status":"completed","input":{…},
 *                        "output":"…","metadata":{"exit":0}}}}
 *   {"type":"step_finish","sessionID":"ses_…", "part":{"reason":"stop",
 *                        "tokens":{…,"cache":{"read":…}},"cost":0}}
 *   {"type":"error",     "sessionID":"ses_…", "error":{"name":"APIError",…}}
 *
 * Session identity: `sessionID` (e.g. `ses_f19b…`) appears on EVERY event, so
 * the thread id is known from the first line. Resume is
 * `opencode run --session <id> <prompt>` (verified: context is retained).
 */

import { spawnProcess } from '../runtime/spawn.ts';
import { resolveCommand } from '../runtime/discover.ts';
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentDescriptor,
  Invocation,
  MapContext,
  ProbeResult,
  RunRequest,
  TerminalSignal,
  ToolCall,
  Usage,
  UsagePatch,
} from '../core/types.ts';
import * as E from '../core/event.ts';
import type { RuntimeEvent } from '../core/event.ts';

const CAPABILITIES: AgentCapabilities = {
  newTask: true,
  resume: true,
  fork: true,
  // OpenCode has no dedicated review subcommand; review is a prompt.
  review: false,
  worktree: false,
  stdinPrompt: false,
  sandbox: false,
  streamEvents: true,
  roleSelection: true, // --agent
  // `step_finish` carries a real `cost` figure.
  costReporting: true,
  // `opencode run` is one-shot; there is no stdin steering channel.
  steering: false,
};

export function createOpenCodeAdapter(config?: {
  command?: string;
  executable?: string;
  version?: string;
}): AgentAdapter {
  const executable =
    config?.executable ??
    resolveCommand('opencode', config?.command).command;

  const descriptor: AgentDescriptor = {
    id: 'opencode',
    displayName: 'OpenCode',
    executable,
    version: config?.version,
    transport: 'cli',
    capabilities: CAPABILITIES,
    credentialsHint: '~/.local/share/opencode/auth.json (read by OpenCode itself)',
  };

  return {
    descriptor,

    async probe(): Promise<ProbeResult> {
      // `opencode --version` writes the version to STDOUT (verified), so the
      // probe must capture stdout rather than the stderr tail.
      const outLines: string[] = [];
      const handle = spawnProcess({
        command: executable,
        args: ['--version'],
        cwd: process.cwd(),
        onStdoutLine: (line) => outLines.push(line),
      });
      const info = await handle.exited;
      const stdout = outLines.join('\n');
      const version = extractVersion(stdout || info.stderrTail) || null;

      if (info.code !== 0) {
        return {
          ok: false,
          executable,
          version,
          detail: `opencode --version exited ${info.code}${
            info.stderrTail ? `: ${info.stderrTail.slice(0, 400)}` : ''
          }`,
          warnings: [],
        };
      }
      if (!version) {
        return {
          ok: false,
          executable,
          version: null,
          detail: 'opencode --version produced no parseable version string',
          warnings: [],
        };
      }
      return { ok: true, executable, version, detail: 'opencode CLI reachable', warnings: [] };
    },

    buildInvocation(req: RunRequest): Invocation {
      // `opencode run` takes the message positionally. We pass argv (never a
      // shell string), so Node's CreateProcess escaping handles spaces and
      // newlines correctly on Windows.
      const args: string[] = ['run', req.prompt, '--format', 'json'];
      args.push('--dir', req.cwd);
      if (req.model) args.push('--model', req.model);
      if (req.role) args.push('--agent', req.role);
      if (req.threadId) args.push('--session', req.threadId);
      if (req.extraArgs) args.push(...req.extraArgs);
      return { command: executable, args, promptVia: 'argv' };
    },

    mapEvent(native: unknown, ctx: MapContext): RuntimeEvent[] {
      const ev = native as NativeOpenCodeEvent;
      if (!ev || typeof ev !== 'object') return [];
      const out: RuntimeEvent[] = [];
      const c = { taskId: ctx.taskId, agentId: ctx.agentId, threadId: ev.sessionID ?? ctx.threadId };

      if (ev.sessionID) ctx.sink.noteThreadId(ev.sessionID);

      switch (ev.type) {
        case 'text': {
          const text = ev.part?.text ?? '';
          if (text) {
            ctx.sink.noteText(text);
            out.push(E.output(c, ev, text));
          }
          break;
        }
        case 'reasoning': {
          // Thinking is progress, not output: it must not pollute the answer.
          const thinking = ev.part?.text ?? '';
          out.push(
            E.progress(c, ev, { kind: 'reasoning', text: thinking }),
          );
          break;
        }
        case 'tool_use': {
          const call = toolFromPart(ev.part);
          if (call) {
            ctx.sink.noteToolCall(call);
            out.push(
              E.toolCall(c, ev, {
                name: call.name,
                callId: call.callId,
                status: call.status,
                input: call.input,
                output: call.output,
                exitCode: call.exitCode,
              }),
            );
          }
          break;
        }
        case 'step_start': {
          out.push(E.progress(c, ev, { kind: 'step_start', partType: ev.part?.type }));
          break;
        }
        case 'step_finish': {
          const usage = usageFromStepFinish(ev.part);
          if (usage) ctx.sink.noteUsage(usage);
          out.push(
            E.progress(c, ev, {
              kind: 'step_finish',
              reason: ev.part?.reason,
              usage: (usage ?? {}) as Record<string, unknown>,
            }),
          );
          break;
        }
        case 'error': {
          const message = errorMessage(ev);
          ctx.sink.noteDiagnostic(message);
          ctx.sink.noteNativeTerminal({ success: false, reason: message });
          out.push(E.diagnostic(c, ev, message));
          break;
        }
        default: {
          // Unknown native type: surface it rather than swallow it.
          out.push(E.progress(c, ev, { kind: 'native', nativeType: ev.type }));
          break;
        }
      }
      return out;
    },

    detectTerminal(native: unknown): TerminalSignal | null {
      const ev = native as NativeOpenCodeEvent;
      if (ev?.type === 'error') {
        return { success: false, reason: errorMessage(ev) };
      }
      return null;
    },

    extractText(native: unknown): string | null {
      const ev = native as NativeOpenCodeEvent;
      if (ev?.type === 'text') return ev.part?.text ?? null;
      return null;
    },

    extractToolCall(native: unknown): ToolCall | null {
      const ev = native as NativeOpenCodeEvent;
      if (ev?.type === 'tool_use') return toolFromPart(ev.part);
      return null;
    },

    extractUsage(native: unknown): Partial<Usage> | null {
      const ev = native as NativeOpenCodeEvent;
      if (ev?.type === 'step_finish') return usageFromStepFinish(ev.part);
      return null;
    },
  };
}

// ---- native shape (only the fields we rely on) ------------------------

interface NativePart {
  id?: string;
  type?: string;
  text?: string;
  messageID?: string;
  sessionID?: string;
  reason?: string;
  cost?: number;
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { write?: number; read?: number };
  };
  tool?: string;
  callID?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: string;
    title?: string;
    metadata?: { exit?: number; [k: string]: unknown };
  };
}

interface NativeOpenCodeEvent {
  type?: string;
  timestamp?: number;
  sessionID?: string;
  part?: NativePart;
  error?: { name?: string; data?: { message?: string; metadata?: Record<string, unknown> } };
}

function toolFromPart(part: NativePart | undefined): ToolCall | null {
  if (!part || part.type !== 'tool' || !part.tool) return null;
  const st = part.state ?? {};
  return {
    name: part.tool,
    callId: part.callID,
    status: st.status,
    input: st.input,
    output: st.output,
    exitCode: typeof st.metadata?.exit === 'number' ? st.metadata.exit : null,
  };
}

function usageFromStepFinish(part: NativePart | undefined): Partial<Usage> | null {
  if (!part) return null;
  const t = part.tokens;
  const usage: UsagePatch = {};
  if (t?.input !== undefined) usage.inputTokens = t.input;
  if (t?.output !== undefined) usage.outputTokens = t.output;
  if (t?.reasoning !== undefined) usage.reasoningTokens = t.reasoning;
  if (t?.total !== undefined) usage.totalTokens = t.total;
  if (typeof part.cost === 'number') usage.costUsd = part.cost;
  return Object.keys(usage).length ? usage : null;
}

function errorMessage(ev: NativeOpenCodeEvent): string {
  const d = ev.error?.data;
  const url = typeof d?.metadata?.url === 'string' ? ` (url: ${d.metadata.url})` : '';
  return `${ev.error?.name ?? 'Error'}: ${d?.message ?? 'unknown error'}${url}`;
}

function extractVersion(text: string): string {
  const m = /(\d+\.\d+\.\d+[^\s]*)/.exec(text);
  return m ? m[1]! : '';
}
