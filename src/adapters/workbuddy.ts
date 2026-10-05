/**
 * adapters/workbuddy.ts — WorkBuddy's CodeBuddy CLI, no provider API.
 *
 * Transport: `codebuddy -p <prompt> --output-format stream-json`, which writes
 * newline-delimited JSON on stdout and leaves stderr for diagnostics. Every
 * shape below was captured live on this machine (CodeBuddy CLI 2.137.1).
 *
 * Native frames (Anthropic-shaped envelopes):
 *   {"type":"system","subtype":"init","session_id":"…","cwd":"…",
 *    "model":"default-model","permissionMode":"…","tools":[…]}
 *   {"type":"system","subtype":"status","session_id":"…","status":"…"}
 *   {"type":"file-history-snapshot","snapshot":{…}}
 *   {"type":"assistant","session_id":"…","message":{"content":[
 *        {"type":"thinking","thinking":"…"},
 *        {"type":"tool_use","id":"chatcmpl-tool-…","name":"Read","input":{…}},
 *        {"type":"text","text":"OK"}],"usage":{…}}}
 *   {"type":"user","session_id":"…","message":{"content":[
 *        {"type":"tool_result","tool_use_id":"chatcmpl-tool-…","content":…}]}}
 *   {"type":"result","subtype":"success","is_error":false,"result":"OK",
 *    "session_id":"…","num_turns":6,"duration_ms":9158,"total_cost_usd":0,
 *    "usage":{"input_tokens":50991,"output_tokens":82,"cache_read_input_tokens":…}}
 *
 * `session_id` rides on every frame, so the thread id is known from the first
 * one. Resume is `-r <session_id>` — VERIFIED: a resumed run reused the same
 * session_id and answered from earlier context without reading any file.
 *
 * LAUNCH. The entry point is an EXTENSION-LESS `#!/usr/bin/env node` script,
 * which `runtime/launcher.ts` refuses (it accepts .exe/.com/.cmd/.bat only),
 * so `runtime/discover.ts resolveCommand()` cannot resolve this agent at all.
 * This adapter therefore resolves its own launcher: `node.exe` with the script
 * as the FIRST argv element. The script rides in argv rather than in
 * `LauncherSpec.prefixArgs` because `buildLaunchArgv()` returns bare args for a
 * `native` launcher and would silently drop it. `target` still names the real
 * entry point so `commandLine` reads `node <script> …`.
 *
 * IDENTITY. Two installs exist on this machine — CN (`D:\workbuddy`) and Intl
 * (`D:\workbuddy ai`) — and both are byte-identical `@genie/agent-cli` builds
 * (same help hash, same dependency set, same `@agentclientprotocol/sdk`), so
 * they share ONE implementation. They are still TWO provider identities:
 * `workbuddy-cn` and `workbuddy-intl` are separate agent ids, each with its own
 * candidate path list, and discovery NEVER crosses between them — an id only
 * ever searches its own install, so an absent CN build cannot silently resolve
 * to the Intl one, and vice versa. "whichever exists first" is gone.
 *
 * Authentication is NOT identity. The CN build answers `401 Authentication
 * required … copilot.tencent.com` (still exiting 0) while the Intl build is
 * authenticated here, but `workbuddy-cn` remains a legal agent id either way —
 * it is recorded as needing the user's own `/login`, never auto-configured.
 *
 * EXIT 0 IS NOT SUCCESS (measured, not assumed). The CN build exits 0 with the
 * whole failure on stderr and NO protocol frames at all, and a bare
 * `401 Unauthorized` line matches no narrow error regex. So a zero exit is
 * accepted only when the stream carried protocol evidence: a `result` frame, or
 * at least a text-bearing `assistant` frame. Without either, the run fails with
 * "process exited successfully but produced no valid protocol result". stderr
 * auth/permission text only EXPLAINS a failure; it is no longer the sole reason
 * for one.
 *
 * MEASURED, NOT ASSUMED (each capability below):
 *   resume          `-r <id>` reused session_id and recalled earlier content
 *   modelSelection  `--model balanced-model` -> result.modelUsage = balanced-model
 *   roleSelection   `--agents {…} --agent probeagent` changed the reply
 *   streamEvents    stream-json frames observed on every run
 *   costReporting   `total_cost_usd` was 0 on runs that DID consume credit, so
 *                   it carries no information and nothing is fabricated
 *   sandbox         false: no docker/podman/e2b on this machine, so forwarding
 *                   `--sandbox` would fail only after the run had started
 *   review          false: no `review` subcommand in the CLI's command list
 */

import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { InvalidRequestError, LauncherResolutionError, UnsupportedOptionError } from '../core/errors.ts';
import * as E from '../core/event.ts';
import type { RuntimeEvent } from '../core/event.ts';
import { CliJsonlTransport } from '../runtime/transport/cli.ts';
import { launcherFor } from '../runtime/launcher.ts';
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
  Transport,
  TransportFrame,
  Usage,
  UsagePatch,
} from '../core/types.ts';

const CAPABILITIES: AgentCapabilities = {
  newTask: true,
  resume: true, // `-r <sessionId>` — verified end to end
  // No `review` subcommand in the CLI's own command list.
  review: false,
  modelSelection: true, // --model <id> — verified
  roleSelection: true, // --agent / --agents — verified
  // Exposed by the CLI, but nothing here can honour it: this machine has no
  // docker/podman and no E2B credentials, so it would fail after start-up.
  sandbox: false,
  streamEvents: true, // --output-format stream-json — verified
  // `total_cost_usd` reported 0 on runs that demonstrably consumed credit.
  costReporting: false,
  // Forwarded verbatim. The CLI does its own validation and rejects an
  // unknown option loudly (exit 1), which is the fail-fast behaviour we want.
  extraArgs: true,
  // Honoured through the spawn cwd; `system/init.cwd` echoed it back.
  cwd: true,
  /**
   * The adapter DOES choose a permission mode, because `-p` cannot prompt: see
   * `buildWorkBuddyArgs`. Not a capability flag — capabilities are things a CALLER
   * selects, and there is no such selection here. Recorded here because a caller
   * reading the descriptor deserves to know a WorkBuddy run is auto-approved, and
   * can still override it per-run through `extraArgs`.
   */
// Declared false on purpose; none of these are wired, and RunRequest cannot
   // even carry a worktree/fork request.
   // Unverified: no WorkBuddy run was made to test whether a skill request is
   // honoured, and its help exposes no skill flag. False rather than assumed.
   skills: false,
   steering: false,
  worktree: false,
  fork: false,
  stdinPrompt: false,
  // 5C-6: `shared` only, for BOTH CN and Intl (this block serves both variants).
  //
  // `isolated` is withheld on purpose. `cwd: true` above is necessary but is
  // not the same claim: it says the CLI echoes back a directory we name, not
  // that two instances in two directories keep independent state. That second
  // property is what isolation depends on, and it is unverified here — the
  // workbuddy binary is not installed on this machine, so neither a run nor a
  // help-surface check can confirm it. Fail-closed means an unproven agent is
  // not placed in a worktree. This is a "not yet demonstrated", NOT a "cannot
  // ever": clearing it needs one real concurrent run in two worktrees.
  workspaceModes: ['shared'],
};

/**
 * The two WorkBuddy provider identities. Same implementation, different
 * identity: id, display name, region and — critically — the candidate entry
 * points each one is allowed to resolve.
 */
export type WorkBuddyId = 'workbuddy-cn' | 'workbuddy-intl';

export interface WorkBuddyVariant {
  /** The agent id. Stable, and independently addressable in orchestrator.json. */
  readonly id: WorkBuddyId;
  readonly displayName: string;
  /** Which build/endpoint family this is — identity, not availability. */
  readonly region: 'cn' | 'intl';
  /**
   * THIS identity's entry points, preferred order first. Absolute because an
   * Electron app can live on any drive and registers no PATH entry (verified:
   * `where codebuddy` finds nothing). Each id scans only its own list — never
   * "whichever exists first" across identities.
   */
  readonly candidates: readonly string[];
}

export const WORKBUDDY_VARIANTS: Readonly<Record<WorkBuddyId, WorkBuddyVariant>> = Object.freeze({
  'workbuddy-cn': Object.freeze({
    id: 'workbuddy-cn',
    displayName: 'WorkBuddy CN (CodeBuddy CLI)',
    region: 'cn',
    candidates: [
      // CN build. Reachable here but unauthenticated: 401 vs copilot.tencent.com.
      'D:\\workbuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy',
    ],
  }),
  'workbuddy-intl': Object.freeze({
    id: 'workbuddy-intl',
    displayName: 'WorkBuddy Intl (CodeBuddy CLI)',
    region: 'intl',
    candidates: [
      // Intl build. Authenticated on this machine — verified with a real prompt.
      'D:\\workbuddy ai\\WorkBuddyAI\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy',
    ],
  }),
});

export function isWorkBuddyId(id: string): id is WorkBuddyId {
  return id === 'workbuddy-cn' || id === 'workbuddy-intl';
}

/** What actually gets spawned, plus argv elements that must precede everything. */
interface Launch {
  readonly launcher: LauncherSpec;
  /** Prepended to argv by this adapter (the Node entry script, if any). */
  readonly prefix: readonly string[];
}

/**
 * Protocol evidence for a successful run. Recorded as native signals because
 * `TerminalInput` carries only exit / signals / localAbort — and because the
 * adapter instance is created ONCE at bootstrap and reused across runs, while
 * `NativeSink` (and therefore `nativeSignals`) is per run.
 */
export const EVIDENCE_RESULT = 'protocol-evidence: result frame';
export const EVIDENCE_OUTPUT = 'protocol-evidence: assistant output frame';
/** Upper bound on remembered runs; reaching it just clears, never throws. */
const EVIDENCE_TASK_LIMIT = 64;

/**
 * Record a signal at most once per run. `nativeSignals` belongs to the run
 * while this adapter instance is shared, so the run is keyed by taskId; the set
 * is bounded, and clearing it can only ever cause a harmless duplicate note.
 */
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

/** Auth / permission text. Used to EXPLAIN a failure, never to cause one. */
const AUTH_PATTERN =
  /401 Authentication required|401 Unauthorized|401 |403 Forbidden|403 |407 |use \/login|permission denied|not authorized/i;

export function createWorkBuddyAdapter(
  variantId: WorkBuddyId,
  config?: {
    /**
     * Override this identity's entry point with an absolute path. It wins over
     * discovery for THIS id only; it never lets one id adopt the other's build.
     */
    command?: string;
    /**
     * Bypass discovery. Used by tests, which exercise pure event mapping and
     * argv construction and must not depend on which binaries happen to be
     * installed on the machine running them.
     */
    launcher?: LauncherSpec;
    version?: string;
    /**
     * Discovery seam. Tests pass a deterministic filesystem predicate so that
     * "CN must not resolve to Intl" is provable on any machine, including one
     * where both (or neither) build is installed.
     */
    exists?: (path: string) => boolean;
  },
): AgentAdapter {
  const variant = WORKBUDDY_VARIANTS[variantId];
  const launch: Launch = config?.launcher
    ? { launcher: config.launcher, prefix: [] }
    : resolveLaunch(variant, config?.command, config?.exists ?? existsSync);
  const { launcher } = launch;

  // id -> tool name, per adapter instance. tool_use carries the name and
  // tool_result only the id, so the link has to survive between frames.
  const toolNames: ToolNames = new Map();

  // Which runs have already recorded assistant-output evidence. Keyed by taskId
  // because `nativeSignals` is PER RUN while this adapter instance is created
  // once at bootstrap and shared by every run; bounded so it cannot grow.
  const outputEvidenced = new Set<string>();

  // Auth/permission text seen in OUTPUT. This CLI prints `401 Unauthorized` as
  // an assistant message rather than on stderr, so stderr alone cannot explain
  // the failure. Recorded once per run; it only ever refines an error MESSAGE —
  // it never decides success or failure (evidence does that).
  const authNoted = new Set<string>();

  // tool_use ids already appended to RunResult.toolCalls. `NativeSink` appends
  // rather than upserts, so a CLI that re-sends a tool_result would otherwise
  // duplicate the entry (measured: it does re-send them).
  const notedCalls = new Set<string>();

  const descriptor: AgentDescriptor = {
    id: variant.id,
    displayName: variant.displayName,
    launcher,
    version: config?.version,
    transport: 'cli-jsonl',
    capabilities: CAPABILITIES,
    // Reference only. This adapter never opens it — note it also holds the
    // `--serve` gateway password, which must never be echoed.
    credentialsHint:
      `~/.codebuddy (read by CodeBuddy itself; this adapter never reads it)` +
      (variant.region === 'cn'
        ? '; CN build authenticates against https://copilot.tencent.com'
        : '; Intl build authenticates against https://www.workbuddy.ai'),
  };

  /**
   * Refuse anything CodeBuddy cannot honour. Every `false` above is enforced
   * here rather than being a decorative flag.
   */
  const validateRequest = (req: RunRequest): void => {
    if (req.mode === 'review' && req.threadId) {
      throw new InvalidRequestError(
        variant.id,
        'mode=review together with threadId',
        `A review has no conversation to continue. Drop threadId, or use the ` +
          `default mode with threadId to resume.`,
      );
    }
    if (req.mode === 'review') {
      throw new UnsupportedOptionError(
        variant.id,
        'the native review mode',
        `CodeBuddy has no review subcommand. Use "orchestrator review codex …", ` +
          `or run a review prompt with "orchestrator run ${variant.id} …".`,
      );
    }
    if (req.sandbox !== undefined) {
      throw new UnsupportedOptionError(
        variant.id,
        'a sandbox setting (`--sandbox`)',
        `CodeBuddy exposes --sandbox, but this adapter cannot honour it on this ` +
          `machine (no docker/podman and no E2B account), so it would only fail ` +
          `after the run had started. Use the codex adapter for OS-level write ` +
          `restriction, or drop --sandbox.`,
      );
    }
    if (req.threadId && !CAPABILITIES.resume) {
      throw new UnsupportedOptionError(variant.id, 'resume', '');
    }
    // `--` is THIS adapter's prompt boundary: the builder appends `-- <prompt>`
    // last, so a caller-supplied `--` in extraArgs would terminate options early
    // and let a stray positional be read as (or collide with) the prompt. Refuse
    // it instead of letting extraArgs break the prompt.
    assertNoOptionTerminator(variant.id, req.extraArgs);
  };

  /**
   * EXIT 0 IS NOT SUCCESS — measured, not assumed. A model-side 401 exits 0
   * with the whole failure on stderr and no `result` frame at all, and a bare
   * `401 Unauthorized` matches no narrow error regex (Codex reproduced both).
   * So a zero exit is accepted ONLY with protocol evidence: a `result` frame, or
   * at least a text-bearing `assistant` frame, recorded by `mapEvent`. The
   * stderr auth/permission pattern below only EXPLAINS a failure now — it is no
   * longer the sole reason for one, and it never converts a bare exit 0 into a
   * success either.
   */
  const terminalPolicy: TerminalPolicy = (input: TerminalInput): TerminalDecision => {
    if (input.localAbort) {
      return {
        state: 'failed',
        error: { code: 'TRANSPORT_ERROR', message: `local abort: ${input.localAbort}` },
      };
    }
    const nativeError = input.nativeSignals.find((s) => s.startsWith('error:'));
    const stderr = input.exit.stderrTail;
    // Auth text, wherever this CLI put it: stderr, or an assistant message
    // (`401 Unauthorized` was measured on stdout). Explanation only.
    const authText =
      AUTH_PATTERN.exec(stderr)?.[0] ??
      input.nativeSignals
        .find((s) => s.startsWith('auth:'))
        ?.slice('auth: '.length)
        .trim() ??
      null;

    if (input.exit.code === 0) {
      if (nativeError) {
        // The agent itself reported is_error — a zero exit does not overrule it.
        // When auth/permission text is around, say so: that is the explanation
        // a human needs, and the CLI hides it in output rather than stderr.
        return {
          state: 'failed',
          error: {
            code: 'TRANSPORT_ERROR',
            message:
              `${variant.id} exited 0 but reported a failure: ${nativeError.slice(6)}` +
              (authText
                ? ` (${authText} — sign in with CodeBuddy's own /login command, then retry)`
                : ''),
            retryable: /timeout|ECONN|ETIMEDOUT|rate limit|429|overloaded/i.test(nativeError),
          },
        };
      }

      const evidence = input.nativeSignals.includes(EVIDENCE_RESULT)
        ? 'result'
        : input.nativeSignals.includes(EVIDENCE_OUTPUT)
          ? 'assistant output'
          : null;

      if (evidence) {
        return { state: 'succeeded', error: null };
      }

      // Zero exit, no protocol evidence at all. This is the unsafe case: the
      // process claims success while the stream proves nothing.
      return {
        state: 'failed',
        error: {
          code: 'TRANSPORT_ERROR',
          message: authText
            ? `process exited successfully but produced no valid protocol result: ` +
              `${authText} (the CLI prints this to stderr and returns 0). Sign in to ` +
              `CodeBuddy with its own /login command, then retry.`
            : `process exited successfully but produced no valid protocol result ` +
              `(no result frame and no assistant output). A zero exit code alone is ` +
              `not success for this CLI.` +
              (stderr ? ` stderr: ${stderr.slice(-300)}` : ` stdout and stderr were both empty`),
          retryable: false,
        },
      };
    }
    if (input.exit.code === null) {
      return {
        state: 'failed',
        error: {
          code: 'SPAWN_FAILED',
          message: `workbuddy exited without a status (signal ${input.exit.signal ?? 'none'})`,
        },
      };
    }
    return {
      state: 'failed',
      error: {
        code: 'NONZERO_EXIT',
        message: describeFailure(variant.id, input),
        retryable: /unable to connect|timeout|ECONN|ETIMEDOUT|EAI_AGAIN|429/i.test(stderr),
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
        args: [...launch.prefix, '--version'],
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
          detail: `codebuddy --version failed (exit ${exit.code})${
            proc.stderrTail.toString() ? `: ${proc.stderrTail.toString().slice(0, 300)}` : ''
          }`,
          warnings: [],
        };
      }
      return { ok: true, launcher, version, detail: 'CodeBuddy CLI reachable', warnings: [] };
    },

    createTransport(req: RunRequest): Transport {
      validateRequest(req);
      // argv only, never a shell string: Node's CreateProcess escaping handles
      // spaces and newlines correctly on Windows.
      return new CliJsonlTransport({
        launcher,
        args: buildWorkBuddyArgs(req, launch.prefix),
        cwd: req.cwd,
      });
    },

    mapEvent(frame: TransportFrame, ctx: MapContext): RuntimeEvent[] {
      const ev = frame.data as NativeEvent | undefined;
      if (!ev || typeof ev !== 'object') return [];
      const out: RuntimeEvent[] = [];
      const threadId = ev.session_id ?? ctx.threadId;
      if (ev.session_id) ctx.sink.noteThreadId(ev.session_id);
      const c = { taskId: ctx.taskId, agentId: ctx.agentId, threadId };

      switch (ev.type) {
        case 'system':
          out.push(
            E.progress(c, ev, {
              kind: `system_${ev.subtype ?? 'unknown'}`,
              model: ev.model,
              permissionMode: ev.permissionMode,
              cwd: ev.cwd,
              status: ev.status,
            }),
          );
          break;

        case 'file-history-snapshot':
          out.push(E.progress(c, ev, { kind: 'file_history_snapshot' }));
          break;

        case 'assistant': {
          const usage = usageFrom(ev.message?.usage);
          if (usage) ctx.sink.noteUsage(usage);
          for (const item of ev.message?.content ?? []) {
            switch (item.type) {
              case 'text': {
                const text = item.text ?? '';
                if (text) {
                  ctx.sink.noteText(text);
                  // Text-bearing assistant frame = protocol evidence that the
                  // run actually happened (see terminalPolicy).
                  noteOnce(outputEvidenced, ctx.taskId, EVIDENCE_OUTPUT, ctx.sink);
                  // Auth text in OUTPUT, for a better error explanation only.
                  const auth = AUTH_PATTERN.exec(text);
                  if (auth) noteOnce(authNoted, ctx.taskId, `auth: ${auth[0]}`, ctx.sink);
                  out.push(E.output(c, ev, text));
                }
                break;
              }
              case 'thinking':
                // Thinking is progress, not output: it must not pollute the answer.
                out.push(E.progress(c, ev, { kind: 'reasoning', text: item.thinking ?? '' }));
                break;
              case 'tool_use': {
                const name = item.name ?? 'tool';
                if (item.id) rememberTool(toolNames, item.id, name);
                const call = {
                  name,
                  callId: item.id,
                  status: 'in_progress',
                  input: item.input,
                };
                out.push(
                  E.toolCall(c, ev, {
                    name: call.name,
                    callId: call.callId,
                    status: call.status,
                    input: call.input,
                  }),
                );
                break;
              }
              default:
                out.push(E.progress(c, ev, { kind: 'native', nativeType: `assistant:${item.type}` }));
            }
          }
          break;
        }

        case 'user': {
          for (const item of ev.message?.content ?? []) {
            if (item.type !== 'tool_result') {
              out.push(E.progress(c, ev, { kind: 'native', nativeType: `user:${item.type}` }));
              continue;
            }
            // Noted HERE rather than at tool_use: this is where the outcome is
            // known, and `NativeSink` appends, so noting twice would duplicate
            // the call in RunResult.toolCalls. A re-sent tool_result for the
            // same tool_use_id is recognised and NOT appended again — the
            // event still mirrors the frame, only the accumulator is guarded.
            const alreadyNoted = Boolean(item.tool_use_id && notedCalls.has(item.tool_use_id));
            const call = {
              name: (item.tool_use_id && lookupTool(toolNames, item.tool_use_id)) || 'tool',
              callId: item.tool_use_id,
              status: item.is_error ? 'failed' : 'completed',
              output: flatten(item.content),
              exitCode: null as number | null,
            };
            if (!alreadyNoted) {
              if (item.tool_use_id) {
                if (notedCalls.size >= NOTED_CALL_LIMIT) notedCalls.clear();
                notedCalls.add(item.tool_use_id);
              }
              ctx.sink.noteToolCall(call);
            }
            out.push(
              E.toolCall(c, ev, {
                name: call.name,
                callId: call.callId,
                status: call.status,
                output: call.output,
              }),
            );
          }
          break;
        }

        case 'result': {
          const usage = usageFrom(ev.usage);
          if (usage) ctx.sink.noteUsage(usage);
          if (ev.is_error) {
            ctx.sink.noteNativeSignal(`error: ${ev.subtype ?? 'error'}: ${ev.result ?? ''}`);
          } else {
            // A well-formed `result` frame is the strongest protocol evidence a
            // zero exit can be measured against (see terminalPolicy).
            ctx.sink.noteNativeSignal(EVIDENCE_RESULT);
          }
          out.push(
            E.progress(c, ev, {
              kind: 'result',
              subtype: ev.subtype,
              isError: Boolean(ev.is_error),
              numTurns: ev.num_turns,
              durationMs: ev.duration_ms,
            }),
          );
          break;
        }

        default:
          // Unknown native type: surfaced, never swallowed.
          out.push(E.progress(c, ev, { kind: 'native', nativeType: ev.type }));
      }
      return out;
    },
  };
}

// ---- launch resolution -------------------------------------------------

/**
 * Native argv for a run. Pure, so tests can assert the exact order without
 * spawning anything.
 *
 * `--` is reserved by this adapter: it is pushed immediately before the prompt
 * so a prompt starting with "-" is not read as an option. `extraArgs` are
 * forwarded verbatim but are NOT allowed to contain `--`, because a second one
 * would end option parsing early and let a stray positional collide with the
 * prompt (assertNoOptionTerminator refuses it before spawn).
 */
export function buildWorkBuddyArgs(req: RunRequest, prefix: readonly string[] = []): string[] {
  const args: string[] = [...prefix, '-p', '--output-format', 'stream-json'];
  // PERMISSIONS ARE NOT OPTIONAL IN `-p` MODE.
  //
  // `-p` (print) is non-interactive, so CodeBuddy has nobody to ask and denies
  // every tool: it answers with prose explaining that Write/Bash/PowerShell were
  // blocked. Measured on this machine (CLI 2.137.1), same prompt, same cwd:
  //
  //   (no flag)              → exit 0, NO file written, "tools were denied"
  //   --permission-mode acceptEdits → file written, but `git commit` DENIED
  //   --permission-mode bypassPermissions → file written AND shell ran
  //
  // So `acceptEdits` is not enough for a task that also runs a command, and
  // without a flag the adapter is structurally incapable of implementing a task.
  //
  // A caller can still choose explicitly: `--permission-mode`/`-y` in
  // `extraArgs` is detected and suppresses this default, because the LAST
  // occurrence of the flag is the one the CLI honours.
  if (!hasExplicitPermissionMode(req.extraArgs)) {
    args.push('--permission-mode', 'bypassPermissions');
  }
  if (req.model) args.push('--model', req.model);
  if (req.role) args.push('--agent', req.role);
  if (req.threadId) args.push('-r', req.threadId);
  if (req.extraArgs?.length) args.push(...req.extraArgs);
  args.push('--', req.prompt);
  return args;
}

/**
 * Whether the caller already expressed a permission choice in `extraArgs`.
 *
 * Both spellings count, because the CLI documents both and a caller reaching for
 * either should not have to know which one this adapter would otherwise pick.
 */
function hasExplicitPermissionMode(extraArgs?: readonly string[]): boolean {
  return extraArgs?.some((a) => a === '--permission-mode' || a === '-y' || a === '--dangerously-skip-permissions') ?? false;
}

function assertNoOptionTerminator(agentId: string, extraArgs?: readonly string[]): void {
  if (!extraArgs?.length) return;
  if (extraArgs.includes('--')) {
    throw new InvalidRequestError(
      agentId,
      '`--` inside extraArgs',
      `"--" is reserved by this adapter as the prompt boundary (argv always ends ` +
        `with "-- <prompt>"). Passing another one would end option parsing early and ` +
        `break the prompt, so it is refused before the process starts. Put the ` +
        `option itself in extraArgs without its terminator, or drop extraArgs.`,
    );
  }
}

/**
 * Resolve ONE identity. Discovery only ever walks `variant.candidates`, so a
 * `workbuddy-cn` adapter can never resolve to the Intl install (or the reverse)
 * no matter which of the two happens to exist on the machine. An explicit
 * absolute `command` still wins for its own id.
 */
function resolveLaunch(
  variant: WorkBuddyVariant,
  configured: string | undefined,
  exists: (path: string) => boolean,
): Launch {
  const tried: string[] = [];

  if (configured) {
    if (isAbsolute(configured) || configured.includes('\\') || configured.includes('/')) {
      const abs = resolve(configured);
      if (!exists(abs)) {
        throw new LauncherResolutionError(
          `Configured command for "${variant.id}" does not exist: ${abs}`,
        );
      }
      return launchFor(abs);
    }
    tried.push(`config name "${configured}" (expected an absolute path to the CLI entry)`);
  }

  for (const script of variant.candidates) {
    if (exists(script)) return launchFor(script);
    tried.push(script);
  }

  throw new LauncherResolutionError(
    `Could not locate the CodeBuddy CLI for "${variant.id}" (${variant.region} build). ` +
      `This id searches ONLY its own entry points and never falls through to the ` +
      `other region's install. Tried:\n  ${tried.join('\n  ')}\n` +
      `Set {"agents":{"${variant.id}":{"command":"<absolute path to bin\\codebuddy>"}}} in orchestrator.json.`,
  );
}

/**
 * A `.exe`/`.cmd` target launches normally. The stock entry point is an
 * extension-less Node script, so it runs under node.exe with the script as the
 * first argv element (see the header for why it cannot travel in prefixArgs).
 */
function launchFor(target: string): Launch {
  const byExtension = launcherFor(target);
  if (byExtension.ok) return { launcher: byExtension.launcher, prefix: [] };
  return {
    launcher: {
      kind: 'native',
      command: process.execPath,
      prefixArgs: [],
      target,
      buildsCommandString: false,
    },
    prefix: [target],
  };
}

// ---- native shape ------------------------------------------------------

interface NativeContent {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

interface NativeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
}

interface NativeMessage {
  content?: NativeContent[];
  usage?: NativeUsage;
}

interface NativeEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  permissionMode?: string;
  cwd?: string;
  status?: string;
  message?: NativeMessage;
  usage?: NativeUsage;
  result?: string;
  is_error?: boolean;
  num_turns?: number;
  duration_ms?: number;
}

/**
 * tool_use carries the name and tool_result only the id, and `NativeSink`
 * appends rather than upserts — so the id -> name link lives here and stays for
 * as long as the run needs it (a re-sent tool_result still resolves the right
 * name). FIFO-bounded so a run that dies mid-tool cannot grow it without limit.
 */
const TOOL_NAME_LIMIT = 512;
/** Upper bound on remembered tool_result ids; reaching it just clears. */
const NOTED_CALL_LIMIT = 512;
type ToolNames = Map<string, string>;

function rememberTool(names: ToolNames, id: string, name: string): void {
  if (names.size >= TOOL_NAME_LIMIT) {
    const oldest = names.keys().next();
    if (!oldest.done) names.delete(oldest.value);
  }
  names.set(id, name);
}

function lookupTool(names: ToolNames, id: string): string | undefined {
  return names.get(id);
}

function flatten(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((c) => {
        const text = (c as NativeContent | undefined)?.text;
        return typeof text === 'string' ? text : '';
      })
      .filter(Boolean);
    return parts.length ? parts.join('') : undefined;
  }
  return undefined;
}

function usageFrom(u: NativeUsage | undefined): Partial<Usage> | null {
  if (!u) return null;
  const usage: UsagePatch = {};
  if (typeof u.input_tokens === 'number') usage.inputTokens = u.input_tokens;
  if (typeof u.output_tokens === 'number') usage.outputTokens = u.output_tokens;
  if (typeof u.cache_read_input_tokens === 'number') usage.cachedInputTokens = u.cache_read_input_tokens;
  // `input_tokens` was observed to already INCLUDE cache read and creation, so
  // the sum is the real context total rather than a guess. No cost is derived:
  // the CLI's own `total_cost_usd` is always 0 (see header).
  if (typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number') {
    usage.totalTokens = u.input_tokens + u.output_tokens;
  }
  return Object.keys(usage).length ? usage : null;
}

function extractVersion(text: string): string {
  const m = /(\d+\.\d+\.\d+[^\s]*)/.exec(text);
  return m ? m[1]! : '';
}
