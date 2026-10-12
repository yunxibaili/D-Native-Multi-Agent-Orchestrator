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

import { InvalidRequestError, UnsupportedOptionError } from '../core/errors.ts';
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

/*
 * B1.2 P1-2: the version probe's OWN deadline.
 *
 * It is deliberately NOT the catalogue deadline (`collectModelCatalog`'s 20s)
 * and NOT the contained stop settle (`ManagedProcess.cancel`, 35s). `doctor`
 * probes BEFORE it builds the catalogue deadline, so `--version` needs its own
 * bound or the whole diagnostic can hang forever on a wedged `--version`.
 *
 * 15s is generous for a `--version` print and still far below any interactive
 * wait: the native CLI answered in well under a second on this machine, so this
 * is a safety bound, not a tuning knob.
 */
const VERSION_PROBE_TIMEOUT_MS = 15_000;

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
  // VERIFIED BY REAL RUNS on this machine (see AgentCapabilities.skills for the
  // transcripts): a brief requesting `archify` came back with that skill's exact
  // frontmatter (name/version/author), and a request for a non-existent skill came
  // back `UNAVAILABLE` instead of inventing content. OpenCode honours the ASK.
  skills: true,
  // Declared false across the board; nothing here pretends to implement them.
  steering: false,
  worktree: false,
  fork: false,
  stdinPrompt: false,
  // 5C-6 workspace admission. The ONLY agent cleared for `isolated`, on
  // evidence gathered on this machine rather than assumption:
  //   - binary present (opencode 1.18.31);
  //   - `opencode run --help` documents `-d, --dir <directory>` "directory to
  //     run in", and this adapter passes it as `--dir ${req.cwd}`;
  //   - the transport additionally spawns with `cwd: req.cwd`;
  //   - per-directory project layout, so parallel instances in separate
  //     directories keep independent state.
  // An end-to-end run could not be completed here (the configured provider
  // returns "Unexpected server error" — reproduced identically in a plain
  // checkout, so it says nothing about directory handling). That is why this
  // rests on the adapter's own directory plumbing rather than on a green run.
  workspaceModes: ['shared', 'isolated'],
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
    // A review is a one-shot judgement; OpenCode has no review entrypoint at
    // all, and a prompt-shaped "review" has no conversation to continue either.
    if (req.mode === 'review' && req.threadId) {
      throw new InvalidRequestError(
        'opencode',
        'mode=review together with threadId',
        `A review has no conversation to continue. Drop threadId, or use the ` +
          `default mode with threadId to resume.`,
      );
    }
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
      /*
       * B1.2 P1-2: a BOUNDED version probe. `doctor` awaits `probe()` BEFORE it
       * ever builds the catalogue deadline, so an unbounded `await proc.exited`
       * here hung the whole diagnostic — the catalogue's own 20s timer could not
       * cover `--version`. The wait is now explicitly bounded.
       *
       * This is a MINIMAL repair of the one unbounded wait in THIS probe. It does
       * NOT introduce an outer execution framework, a service, a ProcessManager or
       * a second authority: the process is still created, bounded, stopped and
       * confirmed through the SAME production `ManagedProcess` the catalogue and
       * every agent run already use.
       *
       * Three bounds, deliberately separate and NOT interchangeable:
       *   - VERSION_PROBE_TIMEOUT_MS  this probe's own deadline for `--version`
       *   - the catalogue deadline      `collectModelCatalog(timeoutMs)`, which
       *                                 covers `opencode models` only
       *   - CONTAINED_STOP_WAIT_MS     the bounded settle inside
       *                                 `ManagedProcess.cancel()` (35s)
       * An expired version deadline is NOT a confirmed stop, and neither of the
       * other two bounds may be described as covering `--version`.
       */
      const outLines: string[] = [];
      const proc = new ManagedProcess({
        launcher,
        args: ['--version'],
        cwd: process.cwd(),
        onStdoutLine: (l) => outLines.push(l),
      });

      // The timer is released on EVERY exit path (success, throw, timeout) so a
      // finished probe can never hold the process open until the deadline. The
      // `unref` is belt-and-braces; `clearTimeout` below is the real release.
      let deadline: NodeJS.Timeout | undefined;
      const timedOut = new Promise<'timeout'>((res) => {
        deadline = setTimeout(() => res('timeout'), VERSION_PROBE_TIMEOUT_MS);
        if (typeof deadline.unref === 'function') deadline.unref();
      });
      let settled: 'exited' | 'timeout';
      try {
        // A race here is ONLY a bounded wait; the still-running process is NOT
        // discarded. On 'timeout' the ORIGINAL ManagedProcess is cancelled below.
        settled = await Promise.race([proc.exited.then(() => 'exited' as const), timedOut]);
      } finally {
        if (deadline !== undefined) clearTimeout(deadline);
      }

      if (settled === 'timeout') {
        /*
         * Ask the ORIGINAL process to stop, then let its cleanup settle. `cancel`
         * returns true ONLY when the launcher positively confirmed the Job empty;
         * a request that was merely SENT is not evidence, so the boolean — not the
         * act of calling cancel — is what decides the verdict below.
         */
        const stopConfirmed = await proc.cancel('opencode version probe timeout').catch(() => false);
        await proc.settleCleanup().catch(() => false);

        /*
         * Partial output printed BEFORE the deadline is discarded, never promoted
         * to a version. A version is only accepted from a run that actually
         * finished within the bound and stopped cleanly.
         */
        const partial = extractVersion(outLines.join('\n'));
        const tail = proc.stderrTail.toString();
        return {
          ok: false,
          launcher,
          version: null,
          detail:
            `opencode --version did not finish within ${VERSION_PROBE_TIMEOUT_MS}ms; ` +
            `tree stop confirmed=${stopConfirmed && proc.isTreeStopConfirmed()}` +
            `${partial ? `; partial output "${partial}" discarded` : ''}` +
            `${tail ? `: ${tail.slice(0, 300)}` : ''}`,
          warnings: [],
        };
      }

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
