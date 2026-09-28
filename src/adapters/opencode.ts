/**
 * adapters/opencode.ts — native OpenCode CLI, no provider API.
 *
 * Transport: `opencode run <prompt> --format json`, which streams newline
 * delimited JSON on the event channel and keeps the log on stderr. Everything
 * below is derived from live 1.18.31 output captured on this machine.
 *
 * Observed native events:
 *   {"type":"step_start",  "sessionID":"ses_…", "part":{…,"type":"step-start"}}
 *   {"type":"text",        "sessionID":"ses_…", "part":{"type":"text","text":"PONG"}}
 *   {"type":"tool_use",    "sessionID":"ses_…", "part":{"type":"tool","tool":"bash",
 *                      "callID":"…","state":{"status":"completed","input":{…},
 *                      "output":"…","metadata":{"exit":0}}}}
 *   {"type":"step_finish", "sessionID":"ses_…", "part":{"reason":"stop",
 *                      "tokens":{…,"cache":{"read":…}},"cost":0}}
 *   {"type":"error",       "sessionID":"ses_…", "error":{"name":"APIError",…}}
 *
 * `sessionID` (e.g. `ses_f19b…`) is on EVERY event, so the thread id is known
 * from the first frame. Resume is `--session <id>` (verified: context kept).
 */

import { UnsupportedOptionError } from '../core/errors.ts';
import * as E from '../core/event.ts';
import type { RuntimeEvent } from '../core/event.ts';
import { log } from '../core/log.ts';
import { CliJsonlTransport } from '../runtime/transport/cli.ts';
import { resolveCommand } from '../runtime/discover.ts';
import { ManagedProcess } from '../runtime/spawn.ts';
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

const CAPABILITIES: AgentCapabilities = {
  newTask: true,
  resume: true,
  // There is no `opencode review` subcommand. Reviewing is a prompt, so
  // `review: false` and orchestrator.review() will refuse rather than pretend.
  review: false,
  modelSelection: true,
  roleSelection: true, // --agent
  // OpenCode has no OS-level sandbox switch. Declared false so a request
  // carrying `sandbox` is REJECTED instead of being quietly ignored.
  sandbox: false,
  streamEvents: true,
  // `step_finish` carries a real `cost` figure.
  costReporting: true,
  extraArgs: true,
  cwd: true,
  // Declared false across the board; nothing here pretends to implement them.
  steering: false,
  worktree: false,
  fork: false,
  stdinPrompt: false,
};

export function createOpenCodeAdapter(config?: {
  command?: string;
  /**
   * Bypass discovery. Used by tests, which exercise pure event mapping and
   * argv construction and must not depend on which binaries happen to be
   * installed on the machine running them.
   */
  launcher?: LauncherSpec;
  version?: string;
}): AgentAdapter {
  const launcher = config?.launcher ?? resolveCommand('opencode', config?.command).launcher;

  const descriptor: AgentDescriptor = {
    id: 'opencode',
    displayName: 'OpenCode',
    launcher,
    version: config?.version,
    transport: 'cli-jsonl',
    capabilities: CAPABILITIES,
    credentialsHint: '~/.local/share/opencode/auth.json (read by OpenCode itself)',
  };

  /**
   * Refuse anything OpenCode cannot honour. A false capability here is
   * enforced, not decorative: a request that cannot be satisfied fails fast
   * instead of producing a result that silently ignored the request.
   */
  const validateRequest = (req: RunRequest): void => {
    if (req.sandbox !== undefined) {
      throw new UnsupportedOptionError(
        'opencode',
        'a sandbox setting (`--sandbox`)',
        `OpenCode 1.18.31 exposes no sandbox flag. Use the Codex adapter for OS-level ` +
          `write restriction, or drop --sandbox.`,
      );
    }
    if (req.mode === 'review') {
      throw new UnsupportedOptionError(
        'opencode',
        'the native review mode',
        `OpenCode has no review subcommand. Use "orchestrator review codex …", ` +
          `or run a review prompt with "orchestrator run opencode …".`,
      );
    }
    if (req.threadId && !CAPABILITIES.resume) {
      throw new UnsupportedOptionError('opencode', 'resume', '');
    }
  };

  const terminalPolicy: TerminalPolicy = (input: TerminalInput): TerminalDecision => {
    if (input.localAbort) {
      // The kernel already turns local aborts into cancelled/timed_out; this is
      // only reachable if an adapter is used outside AgentSession.
      return {
        state: 'failed',
        error: { code: 'TRANSPORT_ERROR', message: `local abort: ${input.localAbort}` },
      };
    }
    const nativeError = input.nativeSignals.find((s) => s.startsWith('error:'));
    if (input.exit.code === 0) {
      // A zero exit is authoritative. OpenCode reports provider failures as an
      // `error` event and still exits non-zero, so 0 + error frame is only a
      // warning we keep as a diagnostic.
      if (nativeError) {
        log.debug('opencode exited 0 despite an error frame', { detail: nativeError });
      }
      return { state: 'succeeded', error: null };
    }
    if (input.exit.code === null) {
      return {
        state: 'failed',
        error: {
          code: 'SPAWN_FAILED',
          message: `opencode exited without a status (signal ${input.exit.signal ?? 'none'})`,
        },
      };
    }
    return {
      state: 'failed',
      error: {
        code: 'NONZERO_EXIT',
        message: describeFailure('opencode', input),
        retryable: /unable to connect|timeout|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(
          `${nativeError ?? ''}${input.exit.stderrTail}`,
        ),
      },
    };
  };

  return {
    descriptor,
    terminalPolicy,
    validateRequest,

    async probe(): Promise<ProbeResult> {
      // `--version` writes to stdout, so the probe must read stdout.
      const outLines: string[] = [];
      const proc = new ManagedProcess({
        launcher,
        args: ['--version'],
        cwd: process.cwd(),
        onStdoutLine: (l) => outLines.push(l),
      });
      const exit = await proc.exited;
      const version = extractVersion(outLines.join('\n')) || null;
      if (exit.code !== 0 || !version) {
        return {
          ok: false,
          launcher,
          version,
          detail: `opencode --version failed (exit ${exit.code})${
            proc.stderrTail.toString() ? `: ${proc.stderrTail.toString().slice(0, 300)}` : ''
          }`,
          warnings: [],
        };
      }
      return { ok: true, launcher, version, detail: 'opencode CLI reachable', warnings: [] };
    },

    createTransport(req: RunRequest): Transport {
      validateRequest(req);
      // argv only, never a shell string: Node's CreateProcess escaping handles
      // spaces and newlines correctly on Windows.
      const args: string[] = ['run', req.prompt, '--format', 'json'];
      args.push('--dir', req.cwd);
      if (req.model) args.push('--model', req.model);
      if (req.role) args.push('--agent', req.role);
      if (req.threadId) args.push('--session', req.threadId);
      if (req.extraArgs?.length) args.push(...req.extraArgs);
      return new CliJsonlTransport({ launcher, args, cwd: req.cwd });
    },

    mapEvent(frame: TransportFrame, ctx: MapContext): RuntimeEvent[] {
      const ev = frame.data as NativeOpenCodeEvent | undefined;
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
          out.push(E.progress(c, ev, { kind: 'reasoning', text: ev.part?.text ?? '' }));
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
        case 'step_start':
          out.push(E.progress(c, ev, { kind: 'step_start', partType: ev.part?.type }));
          break;
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
          // Recorded as a native signal so terminalPolicy can weigh it, but
          // NOT as a diagnostic failure: OpenCode exits non-zero itself.
          ctx.sink.noteNativeSignal(`error: ${message}`);
          out.push(E.diagnostic(c, ev, message));
          break;
        }
        default:
          // Unknown native type: surfaced, never swallowed.
          out.push(E.progress(c, ev, { kind: 'native', nativeType: ev.type }));
          break;
      }
      return out;
    },
  };
}

// ---- native shape ------------------------------------------------------

interface NativePart {
  id?: string;
  type?: string;
  text?: string;
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

function toolFromPart(part: NativePart | undefined) {
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

export function describeFailure(agent: string, input: TerminalInput): string {
  const parts: string[] = [];
  if (input.exit.signal) parts.push(`killed by ${input.exit.signal}`);
  if (input.exit.code !== null && input.exit.code !== 0) parts.push(`exit code ${input.exit.code}`);
  if (input.exit.stderrTail) {
    parts.push(`stderr${input.exit.stderrTruncated ? ' (tail)' : ''}: ${input.exit.stderrTail.slice(-1200)}`);
  } else {
    parts.push('no stderr output');
  }
  const native = input.nativeSignals.find((s) => s.startsWith('error:'));
  if (native) parts.push(`agent reported: ${native.slice(6)}`);
  return `${agent}: ${parts.join('; ')}`;
}

function extractVersion(text: string): string {
  const m = /(\d+\.\d+\.\d+[^\s]*)/.exec(text);
  return m ? m[1]! : '';
}
