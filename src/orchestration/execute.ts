/**
 * src/orchestration/execute.ts — Task → RunRequest, and the execution seam.
 *
 * This is the whole of 5C-2: a planned child task becomes a real Native Agent
 * run through the EXISTING runtime, and the `RunResult` that comes back is
 * written to the task lifecycle.
 *
 * The boundary that matters most:
 *
 *   > Orchestration decides WHAT runs. The existing Runtime decides HOW.
 *
 * So this file never spawns a process, never builds a Transport, never creates
 * a Session, and never kills anything. It calls `RuntimeRunner.run()` and waits
 * on the `RunHandle` the existing runtime hands back. Process-tree reaping,
 * timeout policy, terminal-state policy and cancellation all stay where Phase
 * 1-3 put them.
 *
 * `RuntimeRunner` is deliberately the smallest structural type that the real
 * `Orchestrator` already satisfies. That is why 5C-2 needs ZERO changes to
 * `src/orchestrator/` and `src/runtime/`: we depend on their shape, not on a
 * copy of it.
 */

import type { ProcessStartDisposition, RunHandle, RunRequest, RunResult } from '../core/types.ts';
import type { Task, TaskStatus } from './task.ts';
// TeamRun T2-b: the single canonical Worker execution contract, injected at the one place
// an execution RunRequest is built.
import { composeWorkerExecutionPrompt } from './worker-execution-contract.ts';
import type { SpawnGateDecision } from './spawn-gate-input.ts';

/**
 * W3.1: what the runtime can actually PROVE about process creation, reported as a
 * TYPED fact rather than inferred from a message, an error class or a stack.
 *
 * The reason this exists is a real, proven failure. `runtime.run()` used to throw,
 * the caller saw "it threw", and inferred "no process was created" — releasing an
 * exclusive WRITE claim. But the throw can happen AFTER a real `ManagedProcess` has
 * already spawned a writer: the writer kept appending to the workspace while a
 * second writer was admitted into the same scope.
 *
 * So the inference is banned. Only the runtime seam knows whether `CreateProcess`
 * happened, and only it may say so:
 *
 *   - `not-started`      the runtime PROVED nothing was created (launcher unresolvable,
 *                        control channel unavailable, request rejected before spawn).
 *                        This is the ONLY value that permits a pre-start release.
 *   - `may-have-started` the edge was entered and creation was possible, but no proof
 *                        exists either way. The default for every throw. Conservative.
 *   - `started`          a process was created.
 *
 * W3.2 moved the PRODUCER into `src/runtime/**` (see `runtime/start-proof.ts`), so
 * this module can no longer construct one. Orchestration consumes the verdict and
 * nothing more — a public constructor here would have let any upper layer forge
 * "not started" over a live writer.
 */
export type { ProcessStartDisposition };

/**
 * The execution seam. The real `Orchestrator` from `src/orchestrator/` satisfies
 * this structurally — `run(req: RunRequest): RunHandle` — so production injects
 * the real thing and tests inject a stub. Nothing else about the runtime is
 * reachable from here, which is what makes "orchestration never spawns" a
 * structural fact rather than a promise.
 */
export interface RuntimeRunner {
  run(req: RunRequest): RunHandle;
}

/** How a `RunRequest` was derived, so the mapping is auditable after the fact. */
export interface RunRequestMapping {
  taskId: string;
  agentId: string;
  /** `review` for a review task, `default` otherwise. Drives the native entrypoint. */
  mode: 'default' | 'review';
  taskType: Task['taskType'];
  /** What we told the agent. Never empty. */
  prompt: string;
  cwd: string;
  model: string | null;
  threadId: string | null;
  /**
   * TeamRun T1-e: the dispatch-time workbench session, resolved by the session
   * authority's own resolver at the freeze point — after the last pre-dispatch
   * await, when the pair that will ACTUALLY run is known. Absent when no compatible
   * session was bound for that pair; never the "latest" binding of a different
   * generation.
   */
  sessionId?: string;
  /** Omitted when the task has no model, so `Orchestrator.run` applies its own policy. */
  modelWasSet: boolean;
}

/**
 * TeamRun T1-e: how ONE started execution reached its terminal.
 *
 * Settlement is an EXECUTION fact, independent of the WORKFLOW write-back: a run
 * whose write-back was refused (stale lease) still ended, and its session must be
 * settled all the same. `run` is present whenever the execution froze a RunResult;
 * `withoutResult` marks the case where a started execution ended without one
 * (`handle.result()` rejected with a terminal state).
 */
export interface DispatchTerminal {
  readonly run?: RunResult;
  readonly withoutResult?: boolean;
  readonly reason?: string;
}

/**
 * TeamRun T1-f: the ONE compatibility decision between an explicit native thread and
 * the dispatch-resolved session.
 *
 *   > Native thread truth and session attribution truth must describe the same
 *   > execution context.
 *
 * Frozen cases (all decided synchronously at the freeze point, before `runtime.run`,
 * `onStart` and any `markRunning`):
 *
 *   T1  no explicit thread            -> the resolved session's thread and id
 *                                        (fresh: the session simply has no native
 *                                        handle yet, which is its own official
 *                                        "no native conversation" state)
 *   T2  explicit === resolved thread  -> dispatch; both facts name the same context
 *   T3  explicit !== resolved thread  -> REFUSAL (`thread-session-conflict`): the
 *                                        runtime would run thread-A while the mapping
 *                                        claims session-B whose handle is thread-B
 *   T4  resolved session has NO
 *       provable native thread,
 *       explicit thread given         -> REFUSAL: "no handle recorded" cannot prove
 *                                        the explicit thread belongs to that session
 *   T5  explicit thread, NO
 *       attributable session          -> sessionless execution: the thread runs, the
 *                                        mapping/Attempt claim NO session (and no
 *                                        Worker is projected). The thread string is
 *                                        never used to guess or rebind a session.
 *
 * This is a pure VALUE decision, not an authority: it owns nothing, resolves nothing,
 * and never reads the registry. The refusal is an ordinary pre-dispatch rejection —
 * no run, no start hook, no terminal settlement, no Attempt.
 */
export type DispatchContextResolution =
  | { readonly ok: true; readonly threadId?: string; readonly sessionId?: string }
  | { readonly ok: false; readonly code: 'thread-session-conflict'; readonly reason: string };

export function resolveDispatchContext(input: {
  explicitThreadId?: string;
  resolvedSession?: { sessionId?: string; nativeThreadId?: string } | undefined;
}): DispatchContextResolution {
  const session = input.resolvedSession;
  const explicit = input.explicitThreadId;
  if (explicit === undefined) {
    // T1: the resolver is the only thread source, so thread and session are one
    // decision by construction.
    return {
      ok: true,
      ...(session?.nativeThreadId !== undefined ? { threadId: session.nativeThreadId } : {}),
      ...(session?.sessionId !== undefined ? { sessionId: session.sessionId } : {}),
    };
  }
  if (session === undefined || session.sessionId === undefined) {
    // T5: an explicit thread with no attributable session keeps the explicit-thread
    // capability and claims NO session — the thread string never back-derives one.
    return { ok: true, threadId: explicit };
  }
  if (session.nativeThreadId === undefined) {
    // T4: a session with no recorded native handle cannot prove the explicit thread
    // belongs to it. Fail closed rather than run a foreign thread under its name.
    return {
      ok: false,
      code: 'thread-session-conflict',
      reason: `explicit thread "${explicit}" cannot be proven to belong to session "${session.sessionId}" ` +
        '(the session has no recorded native thread); refusing before runtime.run rather than ' +
        'running one context under another\'s name',
    };
  }
  if (session.nativeThreadId !== explicit) {
    // T3: two different execution contexts named by one dispatch.
    return {
      ok: false,
      code: 'thread-session-conflict',
      reason: `explicit thread "${explicit}" conflicts with session "${session.sessionId}", whose native thread is ` +
        `"${session.nativeThreadId}"; refusing before runtime.run instead of silently preferring either side`,
    };
  }
  // T2: same context, named by both the explicit thread and the resolved session.
  return { ok: true, threadId: explicit, sessionId: session.sessionId };
}

export interface BuildRunRequestInput {
  task: Task;
  /**
   * Working directory for the run. REQUIRED, and supplied by the caller: worktree
   * isolation is a 5C-2+ concern (Phase 5B §11.1) and is deliberately NOT
   * implemented here. Making it explicit means two children pointed at one
   * checkout is a visible caller decision rather than a silent default.
   */
  cwd: string;
  /** Overrides the derived prompt only when the caller has something better. */
  prompt?: string;
  /** Omit to let `Orchestrator.run` apply the agent's configured model. */
  threadId?: string;
  /**
   * R5-1 (P1-A): the NATIVE EXECUTION DEADLINE for this run, in ms.
   *
   * Flows into `RunRequest.timeoutMs`, which the runtime's `AgentSession` enforces
   * INSIDE the execution boundary (deadline exceeded -> its own transport cancel ->
   * a REAL frozen `timed_out` terminal). Deliberately distinct from a result-wait
   * timeout: awaiting the handle's `result()` stays unbounded, so a wait that has
   * not produced a terminal can never be misread as a failed run.
   */
  timeoutMs?: number;
}

/**
 * Build the prompt for a task.
 *
 * The acceptance criteria are included verbatim because that is the contract the
 * task will later be verified against. The task id is included so the agent's
 * output can be traced back to one task, and so a retry can be told apart from
 * the original.
 */
export function buildTaskPrompt(task: Task): string {
  const lines = [
    `Task ${task.taskId} (${task.taskType})`,
    '',
    'Work:',
    task.acceptanceCriteria,
  ];
  if (task.dependencies.length > 0) {
    lines.push('', `Depends on: ${task.dependencies.join(', ')}`);
  }
  if (task.artifacts.length > 0) {
    lines.push('', 'Produced artifacts:');
    for (const a of task.artifacts) lines.push(`- ${a.name}: ${a.path}`);
  }
  return lines.join('\n');
}

/**
 * Task → RunRequest.
 *
 * Two rules are load-bearing:
 *
 *   1. `agentId` is the task's, never a default. 5C-1 recorded the agent that the
 *      gate approved; substituting a configured default here would run a task on
 *      an agent nobody checked, which is exactly the review-independence failure
 *      Phase 4 exists to prevent.
 *   2. `model` is left UNSET when the task has none, so `Orchestrator.run` applies
 *      the existing `req.model ?? cfg.model` policy. 5C-2 does not redesign
 *      Agent→Model policy; it defers to it.
 */
export function buildRunRequest(input: BuildRunRequestInput): { request: RunRequest; mapping: RunRequestMapping } {
  const { task, cwd } = input;
  if (cwd.trim() === '') {
    throw new Error(`cannot build a RunRequest for "${task.taskId}": cwd is required`);
  }
  const mode: 'default' | 'review' = task.taskType === 'review' ? 'review' : 'default';
  const taskInstruction = input.prompt ?? buildTaskPrompt(task);
  const request: RunRequest = {
    agentId: task.agentId,
    // TeamRun T2-b.1: the Worker execution contract is ALWAYS composed here. The previous
    // `mode === 'review' ? taskInstruction : ...` exclusion was wrong, because it confused
    // two different things:
    //
    //   * TASK SEMANTIC (`task.taskType`) — what the Worker is asked to DO. `review` is a
    //     perfectly ordinary semantic, like `research` or `test`.
    //   * EXECUTION ROLE — which control-plane path this call belongs to.
    //
    // `mode` is a TRANSPORT PROFILE derived from the task type (the adapters select a
    // native review profile from it), NOT a role. A task with review semantics that goes
    // through Task -> Assignment -> SessionRegistry -> Scheduler -> executeTask -> runtime.run
    // is a real execution Worker with a real Attempt and a real WorkerIdentity, so it must
    // receive the contract like any other.
    //
    // Removing the exclusion is safe precisely because of WHERE this runs: `buildRunRequest`
    // is the formal execution request constructor and has exactly ONE call site (the
    // orchestrator's executeTask edge). The Unified Review path never reaches it — it calls
    // `reviewer.review(...)` -> `Orchestrator.review` -> `run({...mode:'review'})` — so the
    // reviewer cannot receive an implementation contract by construction, rather than by a
    // fragile prompt-content check.
    //
    // The role boundary is therefore structural (execution seam vs review seam), never
    // `mode`, and never the agent id: Codex is both a formal execution family and the
    // Unified Review role, so neither identity nor transport can decide this.
    prompt: composeWorkerExecutionPrompt(taskInstruction),
    cwd,
    mode,
    // Undefined, not null: `run()` reads `req.model ?? cfg.model`, so omitting it
    // preserves the configured policy instead of overriding it with null.
    ...(task.modelId !== null ? { model: task.modelId } : {}),
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    // R5-1 (P1-A): the execution deadline, enforced by the runtime itself.
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  };
  return {
    request,
    mapping: {
      taskId: task.taskId,
      agentId: task.agentId,
      mode,
      taskType: task.taskType,
      prompt: request.prompt,
      cwd,
      model: task.modelId,
      threadId: input.threadId ?? null,
      modelWasSet: task.modelId !== null,
    },
  };
}

/** R5-1.2 (§8): the ONE validator lives in core/types.ts; re-exported for the
 * orchestration surface so existing callers keep their import paths. */
export { validateExecutionTimeout, NODE_TIMER_MAX_MS, MIN_EXECUTION_TIMEOUT_MS } from '../core/types.ts';
// Back-compat alias for the pre-R5-1.2 name used by the round CLI and tests.
export { validateExecutionTimeout as validateExecutionTimeoutMs } from '../core/types.ts';

/** Statuses from which an execution request is meaningful. */
export const EXECUTABLE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['planned', 'queued']);

export function isExecutable(status: TaskStatus): boolean {
  return EXECUTABLE_STATUSES.has(status);
}

/**
 * The outcome of ONE `executeTask`.
 *
 * R5-1.2 §1 contract, owner-ratified. **`ok` is the CONTROL-PLANE outcome, not the
 * execution outcome.** `ok: true` means "the execution was admitted and its
 * authoritative outcome was applied successfully" — it does NOT mean the agent
 * succeeded. Execution success is carried by `task.status` (`to_verify` after a
 * successful run) and by `run.state`.
 *
 * The four cases, which must never collapse into each other:
 *
 *   A. Success          run.state 'succeeded' -> `ok: true`, task `to_verify`.
 *   B. Ordinary failure run exists, write-back accepted (e.g. native exit 3 /
 *      NONZERO_EXIT) -> `ok: true`, task `failed`. An ordinary execution failure is
 *      NOT `runtime-rejected-run`: that code means the agent could not be STARTED,
 *      and the unified classifier maps it to `agent_unavailable`, which is an
 *      availability fact that triggers an automatic handoff.
 *   C. Refused write-back  a real run exists but the control plane rejected it
 *      (stale lease / fencing / generation mismatch) -> `ok: false` with the
 *      specific `code`, and `run` STILL PRESENT. The run and its evidence are real
 *      and must be retained (R4 F5); never drop `run` because `ok` is false.
 *   D. Refused admission  nothing executed (resource / lease / assignment refusal) ->
 *      `ok: false` and `run` ABSENT.
 *
 * So the presence of `run`, not `ok`, is what distinguishes "it ran" from "it never
 * ran", and consumers must key their evidence off `run` for exactly that reason.
 */
export type ExecuteOutcome =
  | {
      ok: true;
      task: Task;
      run: RunResult;
      mapping: RunRequestMapping;
      /** Native task id the runtime assigned; distinct from our task id. */
      runtimeTaskId: string;
      /** The handle, so a caller can cancel while the run is still going. */
      handle: RunHandle;
      gate?: SpawnGateDecision;
      /**
       * R2-2: the lease version THIS execution ran under - the dispatch-time value,
       * captured before the run started.
       *
       * Evidence records what was true when the work happened, not what is true when
       * the record is written. A task reassigned mid-run keeps this value on its
       * AttemptRecord, so "this attempt belonged to lease N" stays answerable after the
       * task has moved to lease N+1. It is deliberately NOT re-read at record time.
       */
      leaseVersion: number;
    }
  | {
    ok: false;
    code: string;
    reason: string;
    /** The task's status when execution was refused, when one was found. */
    status?: TaskStatus;
    gate?: SpawnGateDecision;
    /**
     * R2-2 / F5: the REAL run, present when a native process actually produced a result
     * but the write-back was refused (stale lease, agent mismatch).
     *
     * Absent means NO execution happened — refused at admission, or the runtime never
     * started. That distinction is the whole point: "nothing ran" and "it ran, and the
     * result was refused" must never collapse to the same empty value, or real
     * execution evidence disappears (F5).
     */
    run?: RunResult;
    /** True when `run` is present AND the write-back was refused. */
    runRejected?: boolean;
    mapping?: RunRequestMapping;
    /**
     * R2-2: the lease version the refused execution ran under, when one ran at all.
     *
     * This is the whole reason F5 evidence can be trusted after a reassignment: the
     * version recorded is the STALE one the work actually belongs to, never the task's
     * current version. Rewriting it to the current lease would make a superseded
     * attempt look like the current holder's work — precisely the corruption fencing
     * exists to prevent, laundered through the evidence store.
     */
    leaseVersion?: number;
  };
