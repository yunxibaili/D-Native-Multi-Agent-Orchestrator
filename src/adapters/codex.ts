/**
 * adapters/codex.ts — native Codex CLI, no provider API.
 *
 * Transport: `codex exec --json`, newline-delimited JSON on the event channel;
 * `--color never` keeps the streams ANSI-free. Everything below is derived
 * from live 0.158.0-alpha.2.1 output captured on this machine.
 *
 * Observed native events:
 *   {"type":"thread.started","thread_id":"01a0e644-…"}
 *   {"type":"turn.started"}
 *   {"type":"item.started","item":{"type":"command_execution","command":"…",
 *                  "aggregated_output":"","exit_code":null,"status":"in_progress"}}
 *   {"type":"item.completed","item":{"type":"command_execution",
 *                  "aggregated_output":"hi\n","exit_code":0,"status":"completed"}}
 *   {"type":"item.completed","item":{"type":"reasoning","text":"…"}}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"PONG"}}
 *   {"type":"item.completed","item":{"type":"error","message":"…"}}
 *   {"type":"turn.completed","usage":{…}}
 *
 * >>> THE TRAP THIS ADAPTER EXISTS TO HANDLE <<<
 * A **successful** Codex run on this machine emits FOUR `item.completed`
 * events with `item.type === "error"`, all config noise:
 *   "Codex is ignoring 1 unrecognized configuration setting…"
 *   "Ignoring malformed agent role definition: …must define a non-empty `name`"
 * and still exits 0. So `item.type === "error"` maps to `session.diagnostic`
 * and never to a failure. The terminal policy decides on EXIT CODE.
 *
 * The three `exec` subcommands also accept DIFFERENT FLAG SETS — see the
 * PROFILES table in createTransport.
 */

import { UnsupportedOptionError } from '../core/errors.ts';
import * as E from '../core/event.ts';
import type { RuntimeEvent } from '../core/event.ts';
import { log } from '../core/log.ts';
import { CliJsonlTransport } from '../runtime/transport/cli.ts';
import { resolveCommand } from '../runtime/discover.ts';
import { ManagedProcess } from '../runtime/spawn.ts';
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
  ToolCall,
  Transport,
  TransportFrame,
  Usage,
  UsagePatch,
} from '../core/types.ts';

const CAPABILITIES: AgentCapabilities = {
  newTask: true,
  resume: true,
  // `codex exec review` is a first-class native review entrypoint, verified.
  review: true,
  modelSelection: true,
  roleSelection: true, // -p/--profile
  sandbox: true,
  streamEvents: true,
  // pi-subagents' capability matrix: Codex REFUSES max_cost and reports tokens
  // only, so this stays false and no cost is ever fabricated.
  costReporting: false,
  extraArgs: true,
  cwd: true,
  // All false on purpose; none of these are implemented or wired.
  steering: false,
  worktree: false,
  fork: false,
  stdinPrompt: false,
};

export function createCodexAdapter(config?: {
  command?: string;
  /**
   * Bypass discovery. Used by tests, which exercise pure event mapping and
   * argv construction and must not depend on which binaries happen to be
   * installed on the machine running them.
   */
  launcher?: LauncherSpec;
  version?: string;
}): AgentAdapter {
  const launcher = config?.launcher ?? resolveCommand('codex', config?.command).launcher;

  const descriptor: AgentDescriptor = {
    id: 'codex',
    displayName: 'Codex',
    launcher,
    version: config?.version,
    transport: 'cli-jsonl',
    capabilities: CAPABILITIES,
    credentialsHint: '~/.codex (read by Codex itself; this adapter never reads it)',
  };

  const validateRequest = (req: RunRequest): void => {
    if (!CAPABILITIES.review && req.mode === 'review') {
      throw new UnsupportedOptionError('codex', 'review', '');
    }
    if (req.threadId && !CAPABILITIES.resume) {
      throw new UnsupportedOptionError('codex', 'resume', '');
    }
    // A sandbox is meaningless for the review subcommand: `codex exec review`
    // rejects -s outright, and passing it would fail the whole run with a
    // clap usage error. Refuse up front with a useful message instead.
    if (req.sandbox !== undefined && selectProfile(req).acceptsSandbox === false) {
      const which = req.mode === 'review' ? 'review' : req.threadId ? 'resume' : '';
      throw new UnsupportedOptionError(
        'codex',
        'a sandbox setting together with `exec' + (which ? ` ${which}` : '') + '`',
        `The ${which || 'resume'} subcommand does not accept --sandbox (verified: it exits 2). ` +
          `Drop --sandbox, or start a fresh thread.`,
      );
    }
  };

  /**
   * Exit code is the decision. Item-level `error` frames are diagnostics:
   * a successful run here emits four of them.
   */
  const terminalPolicy: TerminalPolicy = (input: TerminalInput): TerminalDecision => {
    if (input.localAbort) {
      return {
        state: 'failed',
        error: { code: 'TRANSPORT_ERROR', message: `local abort: ${input.localAbort}` },
      };
    }
    if (input.exit.code === 0) return { state: 'succeeded', error: null };
    if (input.exit.code === null) {
      return {
        state: 'failed',
        error: {
          code: 'SPAWN_FAILED',
          message: `codex exited without a status (signal ${input.exit.signal ?? 'none'})`,
        },
      };
    }
    // A top-level `error` frame (not an item) is a genuine stream failure.
    const streamError = input.nativeSignals.find((s) => s.startsWith('stream-error:'));
    return {
      state: 'failed',
      error: {
        code: streamError ? 'TRANSPORT_ERROR' : 'NONZERO_EXIT',
        message: streamError
          ? streamError.slice('stream-error:'.length)
          : describeFailure('codex', input),
        retryable: /timeout|ECONN|ETIMEDOUT|rate limit|429|overloaded/i.test(input.exit.stderrTail),
      },
    };
  };

  return {
    descriptor,
    terminalPolicy,
    validateRequest,

    async probe(): Promise<ProbeResult> {
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
          detail: `codex --version failed (exit ${exit.code})${
            proc.stderrTail.toString() ? `: ${proc.stderrTail.toString().slice(0, 300)}` : ''
          }`,
          warnings: [],
        };
      }
      // `codex login status` is the agent's own read-only check. We never read
      // or echo credentials.
      return { ok: true, launcher, version, detail: 'codex CLI reachable', warnings: [] };
    },

    createTransport(req: RunRequest): Transport {
      validateRequest(req);
      const profile = selectProfile(req);
      const args: string[] = ['exec'];

      // A fresh run has NO subcommand. Pushing an empty placeholder would make
      // it the prompt, and the real prompt an "unexpected argument" (exit 2).
      if (profile.subcommand) args.push(profile.subcommand);
      if (profile.subcommand === 'resume') args.push(req.threadId!);
      if (req.prompt) args.push(req.prompt);

      // Accepted by all three profiles.
      args.push('--json');
      if (req.model) args.push('--model', req.model);
      if (req.role) args.push('-p', req.role);
      if (req.extraArgs?.length) args.push(...req.extraArgs);
      args.push('--skip-git-repo-check');

      if (profile.acceptsSandbox && req.sandbox) args.push('--sandbox', req.sandbox);
      if (profile.acceptsColor) args.push('--color', 'never');
      if (profile.acceptsCd) args.push('-C', req.cwd);

      return new CliJsonlTransport({ launcher, args, cwd: req.cwd });
    },

    mapEvent(frame: TransportFrame, ctx: MapContext): RuntimeEvent[] {
      const ev = frame.data as NativeCodexEvent | undefined;
      if (!ev || typeof ev !== 'object') return [];

      if (ev.type === 'thread.started' && ev.thread_id) ctx.sink.noteThreadId(ev.thread_id);
      const c = { taskId: ctx.taskId, agentId: ctx.agentId, threadId: ev.thread_id ?? ctx.threadId };

      switch (ev.type) {
        case 'thread.started':
          return [E.progress(c, ev, { kind: 'thread_started', threadId: ev.thread_id })];

        case 'turn.started':
          return [E.progress(c, ev, { kind: 'turn_started' })];

        case 'turn.completed':
        case 'turn.failed': {
          const usage = usageFromTurn(ev.usage);
          if (usage) ctx.sink.noteUsage(usage);
          if (ev.type === 'turn.failed') {
            const msg = ev.error?.message ?? 'turn failed';
            ctx.sink.noteNativeSignal(`stream-error: ${msg}`);
            return [E.diagnostic(c, ev, msg)];
          }
          return [
            E.progress(c, ev, {
              kind: ev.type,
              usage: (usage ?? {}) as Record<string, unknown>,
            }),
          ];
        }

        case 'item.started': {
          const call = toolFromItem(ev.item);
          return call
            ? [
                E.progress(c, ev, {
                  kind: 'item_started',
                  tool: call as unknown as Record<string, unknown>,
                }),
              ]
            : [E.progress(c, ev, { kind: 'item_started', itemType: ev.item?.type })];
        }

        case 'item.completed': {
          const item = ev.item;
          if (!item) return [];

          if (item.type === 'error') {
            // Config warnings land here on a SUCCESSFUL run. Diagnostic, never
            // a failure, and deliberately not a native signal either.
            const message = item.message ?? 'unknown codex error item';
            ctx.sink.noteDiagnostic(message);
            return [E.diagnostic(c, ev, message)];
          }

          if (item.type === 'agent_message') {
            const text = item.text ?? '';
            if (!text) return [];
            ctx.sink.noteText(text);
            return [E.output(c, ev, text)];
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
          ctx.sink.noteNativeSignal(`stream-error: ${message}`);
          return [E.diagnostic(c, ev, message)];
        }

        default:
          return [E.progress(c, ev, { kind: 'native', nativeType: String(ev.type) })];
      }
    },
  };
}

// ---- subcommand flag profiles -----------------------------------------

/**
 * Which `codex exec` subcommand to use and which optional flags it accepts.
 * Each field is a live trial on 0.158.0-alpha.2.1, not a guess — passing an
 * unsupported flag is a clap usage error and exits 2.
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

// ---- native shape ------------------------------------------------------

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
 * `error` are handled by the caller and must not also appear as tools.
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
  const total = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0);
  if (total > 0) usage.totalTokens = total;
  // costUsd intentionally absent — Codex reports tokens only.
  return Object.keys(usage).length ? usage : null;
}

function extractVersion(text: string): string {
  const m = /(\d+\.\d+\.\d+[^\s]*)/.exec(text);
  return m ? m[1]! : '';
}

export { log };
