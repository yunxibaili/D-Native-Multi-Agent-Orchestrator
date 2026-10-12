/**
 * adapters/dsh.ts — DeepSeek Harness (DSH) native CLI, minimal HEADLESS adapter.
 *
 * ============================================================================
 * PROTOCOL — VERIFIED FROM THE INSTALLED 0.1.5-rc.2 PACKAGE, NOT GUESSED
 * ============================================================================
 * The installed package is `@deepseek-ai/dsh@0.1.5-rc.2` (bin `lib/bin.js`), and its
 * one-shot surface is the `headless` profile bundle `@deepseek-ai/dsh-headless`,
 * whose shipped `lib/index.js` / `lib/startup.js` / `README.md` were read on this
 * machine. The OBSERVED contract of `dsh --profile headless <task>` is:
 *
 *   - argv: the task is a POSITIONAL; multiple words are joined by spaces
 *     (`program.args.join(' ')`). There is no `--json` flag in this version.
 *   - stdout: the FINAL assistant text (the last non-empty `assistant/message`
 *     content in the owned turn interval) followed by a newline.
 *   - stderr: provider reasoning, streamed under a `dsh: reasoning:` heading, and on
 *     failure an error line `dsh: <code>: <message>` (or `dsh: <message>` for a
 *     direct-driver failure such as loader/agent-creation errors).
 *   - exit code: `outcome.reason?.kind === 'completed' ? 0 : 1`. ANY other outcome
 *     (aborted, error, or no turn in the owned interval) exits 1.
 *   - the native session id (`session-<uuid>`) is created INTERNALLY and is NOT
 *     printed, so this adapter cannot observe it.
 *
 * IMPORTANT DIVERGENCE: the upstream dev sources describe a `--json` JSONL event
 * stream (`session`/`text`/`turn_end`/`final`/`error`). The INSTALLED 0.1.5-rc.2 does
 * NOT implement it. Per the round rule ("when the local version and upstream differ,
 * the verifiable LOCAL protocol governs"), this adapter implements the local
 * plain-text contract and does NOT assume the JSON stream.
 *
 * ============================================================================
 * WHAT THIS SUPPORTS / REFUSES
 * ============================================================================
 * Supported: one new headless run, `cwd`, the FINAL ANSWER on stdout, real exit and
 * cancel/deadline through the existing Runtime/AgentSession/contained stop contract.
 *
 * stdout is PLAIN TEXT, not JSONL, so the transport is asked for `rawStdoutText`:
 * every stdout chunk is delivered VERBATIM (newlines, empty lines and a trailing or
 * absent final newline preserved) and mapped to an output event without being
 * JSON-parsed. A JSON-looking answer is therefore delivered as text, never decoded
 * into protocol events.
 *
 * stderr (reasoning and `dsh: <code>: <message>` errors) is NOT mapped by this
 * adapter: `AgentSession` routes every stderr frame to a DIAGNOSTIC before
 * `mapEvent` is ever called, so the observable contract is "stderr appears in
 * `RunResult.diagnostics`". This adapter does not claim to turn stderr into
 * progress or native-signal events. `terminalPolicy` still parses the stderr TAIL
 * for the failure detail, and the exit code remains authoritative for the outcome.
 *
 * Refused (capability false → rejected before any process starts): review mode,
 * per-request model, role, sandbox, resume/threadId, raw extra args, and a task whose
 * first non-space character is `-` (the headless parser would read it as an option,
 * and a `--` passthrough is not verified for this version).
 */

import { UnsupportedOptionError } from '../core/errors.ts';
import * as E from '../core/event.ts';
import type { RuntimeEvent } from '../core/event.ts';
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
} from '../core/types.ts';

/** Bounded version probe, mirroring the OpenCode adapter's own safety bound. */
const VERSION_PROBE_TIMEOUT_MS = 15_000;

const CAPABILITIES: AgentCapabilities = {
  newTask: true,
  // The native session id is not printed and there is no verified resume flag.
  resume: false,
  // No review entrypoint in headless.
  review: false,
  // 0.1.5-rc.2 headless uses the profile's default model; no verified per-request flag.
  modelSelection: false,
  roleSelection: false,
  sandbox: false,
  streamEvents: true,
  // No usage/cost is printed by headless, so cost is honestly unavailable.
  costReporting: false,
  // The headless parser accepts only the task positional; extra flags are refused.
  extraArgs: false,
  cwd: true,
  skills: false,
  steering: false,
  worktree: false,
  fork: false,
  stdinPrompt: false,
  // Isolation is UNVERIFIED for this agent, so it is fail-closed to shared only.
  workspaceModes: ['shared'],
};

export function createDshAdapter(config?: {
  command?: string;
  /** Bypass discovery. Used by tests, which must not depend on a local install. */
  launcher?: LauncherSpec;
  version?: string;
}): AgentAdapter {
  const launcher = config?.launcher ?? resolveCommand('dsh', config?.command).launcher;

  const descriptor: AgentDescriptor = {
    id: 'dsh',
    displayName: 'DeepSeek Harness',
    launcher,
    version: config?.version,
    transport: 'cli-jsonl',
    capabilities: CAPABILITIES,
    credentialsHint: '$DSH_HOME (default ~/.dsh) — read by DSH itself; this adapter never reads it',
  };

  const validateRequest = (req: RunRequest): void => {
    if (req.mode === 'review') {
      throw new UnsupportedOptionError(
        'dsh',
        'the native review mode',
        `DSH headless has no review entrypoint. Run a review prompt with "orchestrator run dsh …" instead.`,
      );
    }
    if (req.model !== undefined) {
      throw new UnsupportedOptionError(
        'dsh',
        'a per-request model (`--model`)',
        `DSH 0.1.5 headless runs the profile's default model; there is no verified per-request model flag. ` +
          `Configure the profile default instead of passing --model.`,
      );
    }
    if (req.role !== undefined) {
      throw new UnsupportedOptionError('dsh', 'a role (`--role`)', `DSH headless exposes no role/agent selection.`);
    }
    if (req.sandbox !== undefined) {
      throw new UnsupportedOptionError('dsh', 'a sandbox setting (`--sandbox`)', `DSH headless exposes no sandbox flag.`);
    }
    if (req.threadId !== undefined) {
      throw new UnsupportedOptionError(
        'dsh',
        'resume (`threadId`)',
        `DSH 0.1.5 headless is one-shot: it does not print the native session id and exposes no resume flag.`,
      );
    }
    if (req.extraArgs !== undefined && req.extraArgs.length > 0) {
      throw new UnsupportedOptionError(
        'dsh',
        'raw extra args (`--extra`)',
        `DSH headless accepts only the task positional; an unknown flag would be misparsed.`,
      );
    }
    if (req.prompt.trimStart().startsWith('-')) {
      throw new UnsupportedOptionError(
        'dsh',
        'a task beginning with "-"',
        `The DSH headless parser would read a leading "-" as an option, and a "--" passthrough is not verified ` +
          `for 0.1.5-rc.2, so the task is refused rather than risk misdelivery.`,
      );
    }
  };

  const terminalPolicy: TerminalPolicy = (input: TerminalInput): TerminalDecision => {
    if (input.localAbort) {
      return {
        state: 'failed',
        error: { code: 'TRANSPORT_ERROR', message: `local abort: ${input.localAbort}` },
      };
    }
    if (input.exit.code === 0) {
      /*
       * LOCAL contract: dsh-headless requests exit 0 ONLY when the final `turn/end`
       * reason is `completed`; every other outcome exits 1. There is no separate
       * `final` object in this version, so a zero exit IS the authoritative
       * completion evidence — and a non-zero exit / signal is never `succeeded`.
       */
      return { state: 'succeeded', error: null };
    }
    return {
      state: 'failed',
      error: {
        code: input.exit.code === null ? 'TRANSPORT_ERROR' : 'NONZERO_EXIT',
        message: describeDshFailure(input),
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

      let deadline: NodeJS.Timeout | undefined;
      const timedOut = new Promise<'timeout'>((res) => {
        deadline = setTimeout(() => res('timeout'), VERSION_PROBE_TIMEOUT_MS);
        if (typeof deadline.unref === 'function') deadline.unref();
      });
      let settled: 'exited' | 'timeout';
      try {
        settled = await Promise.race([proc.exited.then(() => 'exited' as const), timedOut]);
      } finally {
        if (deadline !== undefined) clearTimeout(deadline);
      }

      if (settled === 'timeout') {
        const stopConfirmed = await proc.cancel('dsh version probe timeout').catch(() => false);
        await proc.settleCleanup().catch(() => false);
        const partial = extractVersion(outLines.join('\n'));
        const tail = proc.stderrTail.toString();
        return {
          ok: false,
          launcher,
          version: null,
          detail:
            `dsh --version did not finish within ${VERSION_PROBE_TIMEOUT_MS}ms; ` +
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
          detail: `dsh --version failed (exit ${exit.code})${
            proc.stderrTail.toString() ? `: ${proc.stderrTail.toString().slice(0, 300)}` : ''
          }`,
          warnings: [],
        };
      }
      return { ok: true, launcher, version, detail: 'dsh CLI reachable', warnings: [] };
    },

    createTransport(req: RunRequest): Transport {
      validateRequest(req);
      // argv only, never a shell string. The task is ONE argv element; the headless
      // parser joins positionals with spaces.
      const args: string[] = ['--profile', 'headless', req.prompt];
      // DSH 0.1.5-rc.2 prints the final answer as PLAIN TEXT on stdout (there is no
      // JSONL stream in this version). `rawStdoutText` delivers stdout verbatim, so
      // the answer reaches `mapEvent` with its newlines/empty lines/trailing newline
      // intact instead of being line-framed (lossy) or filed as an unparsed banner.
      return new CliJsonlTransport({ launcher, args, cwd: req.cwd, rawStdoutText: true });
    },

    mapEvent(frame: TransportFrame, ctx: MapContext): RuntimeEvent[] {
      const c = { taskId: ctx.taskId, agentId: ctx.agentId, threadId: ctx.threadId };
      /*
       * stdout carries the FINAL assistant message. It arrives as a VERBATIM chunk,
       * so the text is appended as-is: no trimming, no line joining and no invented
       * newline. Concatenating the chunks reproduces stdout exactly.
       *
       * stderr is deliberately NOT handled here. `AgentSession` records every stderr
       * frame as a diagnostic and returns BEFORE calling `mapEvent`, so a stderr
       * branch here would be unreachable and would only misstate the real contract.
       */
      if (frame.channel !== 'stdout') return [];
      const text = frame.text;
      if (text === '') return [];
      ctx.sink.noteText(text);
      return [E.output(c, frame, text)];
    },
  };
}

// ---- local output parsing ------------------------------------------------

/**
 * Interpret one stderr line of `dsh --profile headless`.
 *
 * Returns the error text for an error line, or `null` when the line is reasoning /
 * progress. The runner writes reasoning under a `dsh: reasoning:` heading and errors
 * as `dsh: <code>: <message>` (or `dsh: <message>` for a direct-driver failure).
 */
export function parseDshErrorLine(line: string): string | null {
  const m = /^dsh:\s?(.*)$/.exec(line);
  if (m === null) return null; // a raw reasoning delta line
  const rest = m[1] ?? '';
  if (rest.startsWith('reasoning:')) return null; // the reasoning section heading
  return rest === '' ? 'dsh reported an error' : rest;
}

/** Best-effort failure detail from the exit facts and the captured stderr tail. */
function describeDshFailure(input: TerminalInput): string {
  const parts: string[] = [];
  if (input.exit.signal) parts.push(`killed by ${input.exit.signal}`);
  if (input.exit.code !== null && input.exit.code !== 0) parts.push(`exit code ${input.exit.code}`);
  const reported = firstDshError(input.exit.stderrTail);
  if (reported !== null) parts.push(`dsh reported: ${reported}`);
  else if (input.exit.stderrTail) parts.push(`stderr: ${input.exit.stderrTail.slice(-800)}`);
  else parts.push('no stderr output');
  return `dsh: ${parts.join('; ')}`;
}

/** First `dsh:` error line in a stderr tail, or null when none is present. */
function firstDshError(stderrTail: string): string | null {
  for (const line of stderrTail.split(/\r?\n/)) {
    const parsed = parseDshErrorLine(line);
    if (parsed !== null) return parsed;
  }
  return null;
}

function extractVersion(text: string): string {
  const m = /(\d+\.\d+\.\d+[^\s]*)/.exec(text);
  return m ? m[1]! : '';
}
