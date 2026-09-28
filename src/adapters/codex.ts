/**
 * adapters/codex.ts — native Codex CLI, no provider API.
 *
 * Transport: `codex exec --json`, newline-delimited JSON on **stdout**;
 * `--color never` keeps stderr/stdout free of ANSI. Everything below is
 * derived from live 0.158.0-alpha.2.1 output captured on this machine.
 *
 * Observed native events:
 *   {"type":"thread.started","thread_id":"01a0e644-…"}
 *   {"type":"turn.started"}
 *   {"type":"item.started","item":{"id":"item_5","type":"command_execution",
 *                  "command":"…powershell.exe -Command 'echo hi'",
 *                  "aggregated_output":"","exit_code":null,"status":"in_progress"}}
 *   {"type":"item.completed","item":{"…","type":"command_execution",
 *                  "aggregated_output":"hi\n","exit_code":0,"status":"completed"}}
 *   {"type":"item.completed","item":{"type":"reasoning","text":"…"}}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"PONG"}}
 *   {"type":"item.completed","item":{"type":"error","message":"…"}}
 *   {"type":"turn.completed","usage":{"input_tokens":…,"output_tokens":…,
 *                  "cached_input_tokens":…,"reasoning_output_tokens":…}}
 *
 * >>> THE TRAP THIS ADAPTER EXISTS TO HANDLE <<<
 * A **successful** Codex run on this machine emits FOUR `item.completed`
 * events with `item.type === "error"`, all of them config noise:
 *   "Codex is ignoring 1 unrecognized configuration setting…"
 *   "Ignoring malformed agent role definition: …must define a non-empty `name`"
 * and still exits 0. So `item.type === "error"` maps to `session.diagnostic`,
 * never `session.failed`. The runtime decides success by EXIT CODE.
 *
 * The three `exec` subcommands also accept DIFFERENT FLAG SETS — see the
 * PROFILES table in buildInvocation.
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
  // `codex exec review` is a first-class native review entrypoint.
  review: true,
  worktree: true,
  // `codex exec -` reads the prompt from stdin.
  stdinPrompt: true,
  sandbox: true,
  streamEvents: true,
  roleSelection: true, // -p/--profile
  // pi-subagents' capability matrix: Codex REFUSES max_cost, it reports
  // tokens only. Keeping this false stops callers from trusting a cost number.
  costReporting: false,
  steering: false,
};

export function createCodexAdapter(config?: {
  command?: string;
  executable?: string;
  version?: string;
}): AgentAdapter {
  const executable =
    config?.executable ??
    resolveCommand('codex', config?.command).command;

  const descriptor: AgentDescriptor = {
    id: 'codex',
    displayName: 'Codex',
    executable,
    version: config?.version,
    transport: 'cli',
    capabilities: CAPABILITIES,
    credentialsHint: '~/.codex (read by Codex itself; this adapter never reads it)',
  };

  return {
    descriptor,

    async probe(): Promise<ProbeResult> {
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
      if (info.code !== 0 || !version) {
        return {
          ok: false,
          executable,
          version,
          detail: `codex --version failed (exit ${info.code})${
            info.stderrTail ? `: ${info.stderrTail.slice(0, 400)}` : ''
          }`,
          warnings: [],
        };
      }
      // `codex login status` is a separate, read-only check the CLI runs for
      // itself. We never read or echo credentials.
      return { ok: true, executable, version, detail: 'codex CLI reachable', warnings: [] };
    },

    buildInvocation(req: RunRequest): Invocation {
      // >>> FLAG PROFILES ARE NOT UNIFORM ACROSS CODEX SUBCOMMANDS. <<<
      // Verified live on 0.158.0-alpha.2.1. Passing an unsupported flag is a
      // clap usage error and exits 2, so the profile must be chosen, not assumed:
      //
      //   codex exec            accepts --color, -C, -s/--sandbox
      //   codex exec resume     REJECTS --color, -C, -s
      //   codex exec review     REJECTS --color, -C, -s
      //
      // For the subcommands that lack -C, the working directory comes from the
      // spawn cwd instead, which the runtime always sets from RunRequest.cwd.
      const profile = selectProfile(req);
      const args: string[] = ['exec'];
      // A fresh run has NO subcommand. Pushing the empty placeholder would make
      // it the prompt, and the real prompt an "unexpected argument" (exit 2).
      if (profile.subcommand) args.push(profile.subcommand);

      if (profile.subcommand === 'resume') {
        args.push(req.threadId!);
      }
      if (req.prompt) args.push(req.prompt);

      // Accepted by all three profiles.
      args.push('--json');
      if (req.model) args.push('--model', req.model);
      if (req.role) args.push('-p', req.role);
      if (req.extraArgs) args.push(...req.extraArgs);
      args.push('--skip-git-repo-check');

      if (profile.acceptsSandbox) {
        if (req.sandbox) args.push('--sandbox', req.sandbox);
      }
      if (profile.acceptsColor) {
        args.push('--color', 'never');
      }
      if (profile.acceptsCd) {
        args.push('-C', req.cwd);
      }

      return { command: executable, args, promptVia: 'argv' };
    },

    mapEvent(native: unknown, ctx: MapContext): RuntimeEvent[] {
      const ev = native as NativeCodexEvent;
      if (!ev || typeof ev !== 'object') return [];

      if (ev.type === 'thread.started' && ev.thread_id) {
        ctx.sink.noteThreadId(ev.thread_id);
      }
      const c = { taskId: ctx.taskId, agentId: ctx.agentId, threadId: ev.thread_id ?? ctx.threadId };

      switch (ev.type) {
        case 'thread.started': {
          return [E.progress(c, ev, { kind: 'thread_started', threadId: ev.thread_id })];
        }
        case 'turn.started': {
          return [E.progress(c, ev, { kind: 'turn_started' })];
        }
        case 'turn.completed':
        case 'turn.failed': {
          const usage = usageFromTurn(ev.usage);
          if (usage) ctx.sink.noteUsage(usage);
          if (ev.type === 'turn.failed') {
            const msg = ev.error?.message ?? 'turn failed';
            ctx.sink.noteNativeTerminal({ success: false, reason: msg });
          }
          return [E.progress(c, ev, { kind: ev.type, usage: (usage ?? {}) as Record<string, unknown> })];
        }
        case 'item.started': {
          const call = toolFromItem(ev.item);
          return call
            ? [E.progress(c, ev, { kind: 'item_started', tool: call as unknown as Record<string, unknown> })]
            : [E.progress(c, ev, { kind: 'item_started', itemType: ev.item?.type })];
        }
        case 'item.completed': {
          const item = ev.item;
          if (!item) return [];

          if (item.type === 'error') {
            // Config warnings land here with exit 0. Diagnostic, never failure.
            const message = item.message ?? 'unknown codex error item';
            ctx.sink.noteDiagnostic(message);
            return [E.diagnostic(c, ev, message)];
          }

          if (item.type === 'agent_message') {
            const text = item.text ?? '';
            if (text) {
              ctx.sink.noteText(text);
              return [E.output(c, ev, text)];
            }
            return [];
          }

          if (item.type === 'reasoning') {
            return [E.progress(c, ev, { kind: 'reasoning', text: item.text ?? '' })];
          }

          const call = toolFromItem(item);
          if (call) {
            ctx.sink.noteToolCall(call);
            return [
              E.toolCall(c, ev, {
                name: call.name,
                callId: call.callId,
                status: call.status,
                input: call.input,
                output: call.output,
                exitCode: call.exitCode,
              }),
            ];
          }
          return [E.progress(c, ev, { kind: 'item_completed', itemType: item.type })];
        }
        case 'error': {
          const message = ev.message ?? 'codex stream error';
          ctx.sink.noteDiagnostic(message);
          ctx.sink.noteNativeTerminal({ success: false, reason: message });
          return [E.diagnostic(c, ev, message)];
        }
        default: {
          return [E.progress(c, ev, { kind: 'native', nativeType: String(ev.type) })];
        }
      }
    },

    detectTerminal(native: unknown): TerminalSignal | null {
      const ev = native as NativeCodexEvent;
      if (ev?.type === 'error') return { success: false, reason: ev.message ?? 'codex error' };
      if (ev?.type === 'turn.failed') {
        return { success: false, reason: ev.error?.message ?? 'turn failed' };
      }
      return null;
    },

    extractText(native: unknown): string | null {
      const ev = native as NativeCodexEvent;
      if (ev?.type === 'item.completed' && ev.item?.type === 'agent_message') {
        return ev.item.text ?? null;
      }
      return null;
    },

    extractToolCall(native: unknown): ToolCall | null {
      const ev = native as NativeCodexEvent;
      if (ev?.type !== 'item.completed') return null;
      return toolFromItem(ev.item);
    },

    extractUsage(native: unknown): Partial<Usage> | null {
      const ev = native as NativeCodexEvent;
      if (ev?.type === 'turn.completed') return usageFromTurn(ev.usage);
      return null;
    },
  };
}

// ---- subcommand flag profiles -----------------------------------------

/**
 * Which `codex exec` subcommand to use and which optional flags it accepts.
 * Each field is the result of a live trial on 0.158.0-alpha.2.1, not a guess.
 */
interface FlagProfile {
  subcommand: string;
  acceptsColor: boolean;
  acceptsCd: boolean;
  acceptsSandbox: boolean;
}

const PROFILES: Record<'fresh' | 'resume' | 'review', FlagProfile> = {
  fresh: { subcommand: '', acceptsColor: true, acceptsCd: true, acceptsSandbox: true },
  resume: { subcommand: 'resume', acceptsColor: false, acceptsCd: false, acceptsSandbox: false },
  review: { subcommand: 'review', acceptsColor: false, acceptsCd: false, acceptsSandbox: false },
};

function selectProfile(req: RunRequest): FlagProfile {
  if (req.mode === 'review') return PROFILES.review;
  if (req.threadId) return PROFILES.resume;
  return PROFILES.fresh;
}

// ---- native shape -----------------------------------------------------

interface NativeCodexItem {
  id?: string;
  type?: string;
  text?: string;
  message?: string;
  command?: string | string[];
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: unknown;
  [k: string]: unknown;
}

interface NativeCodexEvent {
  type?: string;
  thread_id?: string;
  item?: NativeCodexItem;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    cache_write_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  error?: { message?: string };
  message?: string;
}

/**
 * Only real tool items become tool calls. `reasoning` / `agent_message` /
 * `error` are handled by the caller and must not also show up as tools.
 */
function toolFromItem(item: NativeCodexItem | undefined): ToolCall | null {
  if (!item || !item.type) return null;
  switch (item.type) {
    case 'command_execution':
      return {
        name: 'shell',
        callId: item.id,
        status: item.status,
        input: { command: item.command },
        output: item.aggregated_output,
        exitCode: item.exit_code ?? null,
      };
    case 'file_change':
      return {
        name: 'file_change',
        callId: item.id,
        status: item.status ?? 'completed',
        input: item.changes ?? { command: item.command },
      };
    case 'mcp_tool_call':
    case 'web_search':
    case 'tool_call':
      return {
        name: item.type,
        callId: item.id,
        status: item.status ?? 'completed',
        input: item.command,
        output: typeof item.aggregated_output === 'string' ? item.aggregated_output : undefined,
      };
    case 'todo_list':
      return { name: 'todo_list', callId: item.id, status: 'completed', input: item.changes };
    default:
      return null;
  }
}

function usageFromTurn(u: NativeCodexEvent['usage']): Partial<Usage> | null {
  if (!u) return null;
  const usage: UsagePatch = {};
  if (u.input_tokens !== undefined) usage.inputTokens = u.input_tokens;
  if (u.cached_input_tokens !== undefined) usage.cachedInputTokens = u.cached_input_tokens;
  if (u.output_tokens !== undefined) usage.outputTokens = u.output_tokens;
  if (u.reasoning_output_tokens !== undefined) usage.reasoningTokens = u.reasoning_output_tokens;
  const total =
    (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0);
  if (total > 0) usage.totalTokens = total;
  // costUsd intentionally absent — Codex does not report cost (capability
  // matrix says costReporting: false).
  return Object.keys(usage).length ? usage : null;
}

function extractVersion(text: string): string {
  const m = /(\d+\.\d+\.\d+[^\s]*)/.exec(text);
  return m ? m[1]! : '';
}
