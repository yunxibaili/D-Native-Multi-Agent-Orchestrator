/**
 * src/orchestration/continuation.ts — Agent Quota / Availability Handoff.
 *
 * WHAT THIS IS
 * ------------
 * When an agent runs out of quota or turns out to be unavailable, the WORK did not
 * fail — the WORKER could not continue. This module makes that distinction real by
 * carrying the same Task forward to a different agent:
 *
 *     Task #123
 *       Attempt 1  OpenCode        quota_exhausted
 *       Attempt 2  WorkBuddy Intl  success
 *
 * The single most important property is that this is the SAME Task. Not a new task
 * that looks similar, not a clone, not a "continuation" sibling: the same `taskId`,
 * with a second `AttemptRecord` appended. TaskId is the stable identity of the work;
 * the agent is an assignment detail that a handoff is allowed to change.
 *
 * WHY THIS IS NOT A NEW SUBSYSTEM
 * -------------------------------
 * Everything here is a PURE FUNCTION or a thin driver over injected dependencies.
 * Specifically, this file:
 *
 *   - does NOT pick the next agent. Laya does, through the EXISTING `reassign`
 *     decision action, which already runs Assignment and then TaskStore.
 *   - does NOT dispatch. The EXISTING TaskScheduler does, and it re-runs the spawn gate.
 *   - does NOT touch lease, fencing or ResourceClaim semantics. A handoff gets a new
 *     lease because `migrateIdentityAfterStart` already reissues one (R2-2), not
 *     because this file relaxes anything.
 *   - does NOT write task state. It reads TaskStore and AttemptStore and returns data.
 *   - has no authority, no store, no scheduler and no decision brain of its own.
 *
 * The driver's only power is to CALL the injected `runCycle`, which is the same
 * `runDecisionCycle` the round already runs. That is what keeps "Laya is the single
 * decision authority" true while still letting a round contain more than one attempt.
 *
 * WHY THE TRIGGER SET IS SO NARROW
 * --------------------------------
 * Only three outcomes hand off automatically:
 *
 *     quota_exhausted · agent_unavailable · session_failure
 *
 * `failed`, `error`, `timeout`, `resource_refused` and `lease_refused` do NOT. This is
 * the difference between "this worker cannot continue" and "this work is wrong".
 * Auto-handing-off a NONZERO_EXIT would let a genuine code error hop between agents
 * forever, which is precisely the "无限自动返工" the baseline forbids. Those outcomes go
 * to Unified Codex Review and the user decides.
 *
 * (`session_failure` is included because a transport-level session death is an
 * availability fact about the agent, not a verdict on the work. It is derived from the
 * REAL `TRANSPORT_ERROR` runtime code, never guessed.)
 *
 * WHY `retrying` IS THE STATE THIS USES
 * -------------------------------------
 * A handoff needs the task to be non-terminal so `migrateIdentityAfterStart` will
 * accept it — a terminal task's identity is history. The state machine already has
 * exactly the right state: `running -> retrying -> queued`, whose ONLY exits are
 * `queued` (one more attempt) and `failed` (budget exhausted). It was reserved and
 * un-reserved by P6-D1 for precisely this "the run ended but the task should get
 * another go" case, so using it adds no new state and no new transition.
 */

import type { TaskHandoff } from './workbench-handoff.ts';
import type { Task } from './task.ts';
import type { ExecutionOutcome, ExecutionOutcomeKind } from './unified-review.ts';

// ---------------------------------------------------------------------------
// 1. Trigger classification
// ---------------------------------------------------------------------------

/**
 * The three outcomes that mean "this worker could not continue".
 *
 * Deliberately a closed set, and deliberately EXCLUDING `failed`/`error`/`timeout`.
 */
export const HANDOFF_REASONS = ['quota_exhausted', 'agent_unavailable', 'session_failure'] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

const HANDOFF_TRIGGERS: ReadonlySet<string> = new Set<string>(HANDOFF_REASONS);

export type HandoffClassification =
  | {
      readonly handoff: true;
      readonly reason: HandoffReason;
      /** The unified outcome it came from, kept so nothing is re-derived. */
      readonly outcome: ExecutionOutcomeKind;
      /** Why this is or is not a handoff, in words. */
      readonly explanation: string;
    }
  | {
      readonly handoff: false;
      readonly outcome: ExecutionOutcomeKind;
      readonly explanation: string;
    };

/**
 * Decide whether ONE terminal outcome should offer automatic continuation.
 *
 * Pure. Takes the classification `unified-review.ts` already produced rather than
 * re-deriving it from codes, so there is exactly ONE place in the system that knows
 * what `quota_exhausted` means.
 */
export function classifyHandoffReason(outcome: ExecutionOutcome): HandoffClassification {
  if (HANDOFF_TRIGGERS.has(outcome.outcome)) {
    return {
      handoff: true,
      reason: outcome.outcome as HandoffReason,
      outcome: outcome.outcome,
      explanation:
        `${outcome.outcome} is an availability fact about ${outcome.agentId ?? 'the worker'}, ` +
        'not a verdict on the work, so the same task may continue on another agent',
    };
  }
  return {
    handoff: false,
    outcome: outcome.outcome,
    explanation:
      `${outcome.outcome} is ${NON_CONTINUABLE_WHY[outcome.outcome] ?? 'not an availability fact'}, ` +
      'so it is not handed off automatically; it goes to review and the user decides',
  };
}

/**
 * Why each non-trigger outcome is excluded.
 *
 * Written out rather than left implicit because "we did not hand off" and "we handed
 * off" must be as auditable as the decision itself.
 */
const NON_CONTINUABLE_WHY: Readonly<Partial<Record<ExecutionOutcomeKind, string>>> = Object.freeze({
  failed: 'a run that reported failure is reporting on the work, not on the worker',
  error: 'an internal error is not evidence that a different worker would do better',
  timeout: 'a slow run is a fact about the work; a timeout alone says nothing about worker availability',
  resource_refused: 'a resource conflict is a coordination refusal, and the existing claim rules own it',
  lease_refused: 'a lease refusal means the write-back was stale, not that the worker is unavailable',
  cancelled: 'a cancelled run was stopped deliberately; continuing it would override that decision',
  refused: 'an admission refusal is not an availability fact about the assigned worker',
  success: 'the run succeeded',
});

// ---------------------------------------------------------------------------
// 2. The ContinuationPacket
// ---------------------------------------------------------------------------

/**
 * Where a piece of `remainingWork` came from.
 *
 * Required rather than optional, because "the next agent still has work to do" and
 * "the previous agent said it had more to do" are different claims, and the second one
 * is only trustworthy when it is labelled as a claim.
 */
export type WorkSource =
  | 'evidence'      // derived from machine evidence (files written, tests run)
  | 'worker-claim'  // the previous agent SAID this; not independently verified
  | 'brain'         // Laya's own reading of the situation
  | 'none';         // genuinely unknown, and said so

export interface ContinuationWork {
  readonly text: string;
  readonly source: WorkSource;
}

/**
 * B5.1: the STOP fact a `session_failure` handoff must clear before it may be offered.
 *
 * A transport-level session death says the WORKER stopped answering; it does NOT prove
 * its process tree is gone. The runtime already records that separate fact on
 * `RunResult.cleanup.treeStopConfirmed`, and it is the ONLY field that may gate a second
 * writer. This is carried on the packet as a minimal read-only fact and consumed by the
 * driver; it is deliberately NOT a new hook, store or authority.
 *
 * `confirmed` is `null` when no stop proof is required for this outcome. When a proof IS
 * required, only a literal `true` clears it: a missing/false/absent fact is treated as
 * NOT stopped, never inferred from exit code, output, error name or `processStart`.
 */
export interface ContinuationStopSafety {
  /** True when a stop proof must be confirmed before continuing (executed session_failure). */
  readonly required: boolean;
  /** `true` only when the tree stop is positively confirmed; `null` when not required. */
  readonly confirmed: boolean | null;
  /** Human-readable statement of the fact, for the packet and the report. */
  readonly detail: string;
}

/**
 * What Agent B is told about Agent A's attempt.
 *
 * Bounded by construction: `completedWork` is a tail of real `RunResult.output`, and
 * `changedFiles` / `testsRun` come from the SAME `buildHandoff` projection the
 * dependant-brief path already uses. Nothing here is a transcript, and an agent's
 * self-description of what it changed is never promoted into `changedFiles`.
 */
export interface ContinuationPacket {
  /** The SAME task. Never a new id. This is the whole point. */
  readonly taskId: string;
  readonly taskType: string;
  /** The task's own acceptance criteria — the work, unchanged by any handoff. */
  readonly originalObjective: string;

  readonly previousAttemptId: string | null;
  readonly previousAgentId: string | null;
  readonly previousModelId: string | null;
  /** The lease version Agent A ran under. Evidence about A, not about the task now. */
  readonly previousLeaseVersion: number | null;

  readonly handoffReason: HandoffReason;
  /** The raw refusal/execution code, so nothing is lost in classification. */
  readonly handoffCode: string | null;
  readonly handoffDetail: string | null;

  /** Only what evidence supports. */
  readonly completedWork: ContinuationWork | null;
  readonly remainingWork: ContinuationWork | null;
  /** From `buildHandoff`, i.e. from the run's OWN tool calls — never a self-report. */
  readonly changedFiles: readonly string[];
  readonly testsRun: readonly string[];
  readonly decisions: string | null;
  readonly unresolved: readonly string[];
  readonly errors: readonly { readonly code: string | null; readonly message: string | null }[];

  readonly executionOutcome: ExecutionOutcomeKind;
  /** The previous attempt's own evidence projection, so nothing has to be re-derived. */
  readonly evidence: TaskHandoff | null;

  readonly workspace: { readonly path: string | null; readonly mode: string | null };
  readonly artifacts: readonly { readonly name: string; readonly path: string }[];

  /**
   * What the next agent should do first.
   *
   * Always `null` here: this module does not decide. It is the NEXT agent's opening
   * move, and Laya or the agent derives it. A handoff layer that picks the next step
   * is a second planner.
   */
  readonly nextAction: ContinuationWork | null;

  /**
   * A native session handle, ONLY when resuming the SAME agent.
   *
   * Cross-vendor continuation never carries one: an OpenCode conversation cannot be
   * resumed by WorkBuddy, and pretending otherwise would either fail at dispatch or
   * smuggle a foreign conversation into a different agent's runtime.
   */
  readonly nativeSessionReference: { readonly agentId: string; readonly threadId: string } | null;

  /**
   * B5.1: whether the previous run's process tree is CONFIRMED stopped.
   *
   * Always present. `required` is true only for an EXECUTED `session_failure`; all other
   * outcomes continue exactly as before. It is the fact the driver reads to decide
   * whether it may ask for a reassign at all.
   */
  readonly stopSafety: ContinuationStopSafety;
}

export interface BuildPacketInput {
  readonly task: Task;
  readonly reason: HandoffReason;
  readonly outcome: ExecutionOutcome;
  /** The most recent attempt record for this task, if any. */
  readonly attempt:
    | {
        readonly attemptId: string;
        readonly agentId: string;
        readonly modelId: string | null;
        readonly leaseVersion?: number;
        readonly errorCode?: string;
        readonly errorMessage?: string;
      }
    | null;
  /** The previous attempt's evidence projection, from the EXISTING `buildHandoff`. */
  readonly evidence: TaskHandoff | null;
  /** Resumable only for the SAME agent. Supplied by the caller's SessionRegistry. */
  readonly nativeThreadId?: string | null;
  /** Whether `remainingWork` came from the worker's own words. Labelled, never assumed. */
  readonly remainingWork?: ContinuationWork | null;
  readonly workspace?: { readonly path: string | null; readonly mode: string | null };
  /**
   * B5.1: the previous run's OWN cleanup report, from the SAME atomic attempt bundle as
   * `outcome`/`attempt`. Only `treeStopConfirmed` is read. Absent/null is treated as
   * "not confirmed", never as "stopped".
   */
  readonly cleanup?: { readonly treeStopConfirmed?: boolean | null } | null;
}

/**
 * Build the packet. Pure — it reads and projects, and writes nothing.
 */
export function buildContinuationPacket(input: BuildPacketInput): ContinuationPacket {
  const handoff = input.evidence;

  // `completedWork` is only ever populated from evidence that exists. A worker that
  // claimed to have finished something, with no files and no tests behind it, yields
  // `null` here rather than a flattering summary.
  const completed: ContinuationWork | null =
    handoff !== null && handoff.completedWork !== null && handoff.completedWork.trim() !== ''
      ? { text: handoff.completedWork, source: 'worker-claim' }
      : null;

  // Two SOURCES of the same error exist — the attempt record and the run's own handoff
  // projection — and both are consulted because either may be present. They are
  // de-duplicated here: the same `SPAWN_FAILED` appearing twice in the packet a new agent
  // reads would read as two separate failures.
  const errors: { code: string | null; message: string | null }[] = [];
  const seenError = new Set<string>();
  const addError = (code: string | null, message: string | null): void => {
    const key = `${code ?? ''}|${message ?? ''}`;
    if (seenError.has(key)) return;
    seenError.add(key);
    errors.push({ code, message });
  };
  if (input.attempt?.errorCode !== undefined || input.attempt?.errorMessage !== undefined) {
    addError(input.attempt?.errorCode ?? input.outcome.code, input.attempt?.errorMessage ?? input.outcome.reason);
  }
  if (handoff !== null && handoff.error !== null) {
    addError(handoff.error.code, handoff.error.message);
  }

  // R2-3 P2: derive `remainingWork` from a REAL source when one exists, and label it.
  //
  // Precedence, most-trustworthy first. Nothing here is invented, and a worker's own
  // words are only ever used at the lowest precedence and only ever labelled
  // `worker-claim`:
  //
  //   1. `unresolved` — what the previous run itself reported leaving open, extracted from
  //      its OWN output. Still the worker's statement, but it is a statement about what it
  //      did NOT finish, which is the single most useful thing to hand the next agent.
  //   2. an explicit `remainingWork` supplied by the caller (Laya's reading).
  //   3. `null` — genuinely unknown. `null` is a correct answer and is never dressed up.
  const derivedRemaining: ContinuationWork | null =
    handoff !== null && handoff.unresolved.length > 0
      ? { text: handoff.unresolved.join('; '), source: 'worker-claim' }
      : null;

  // B5.1: a stop proof is required ONLY for an outcome that actually EXECUTED and is a
  // transport-level session failure. A pure admission refusal (quota/agent) never ran, so
  // it keeps the old flow untouched. `cleanup.treeStopConfirmed === true` is the only way
  // to clear it; everything else (absent/false/undefined) is "not confirmed".
  const stopRequired = input.reason === 'session_failure' && input.outcome.executed === true;
  const stoppedConfirmed = input.cleanup !== null && input.cleanup !== undefined
    && input.cleanup.treeStopConfirmed === true;
  const stopSafety: ContinuationStopSafety = {
    required: stopRequired,
    confirmed: stopRequired ? stoppedConfirmed : null,
    detail: !stopRequired
      ? 'no process-tree stop proof is required for this outcome'
      : stoppedConfirmed
        ? 'the previous session failed at the transport level and its process tree stop IS confirmed, so a second writer may start'
        : 'the previous session failed at the transport level but its process-tree stop is NOT confirmed; a second writer must not start until the old tree is proven stopped',
  };

  return {
    taskId: input.task.taskId,
    taskType: input.task.taskType,
    originalObjective: input.task.acceptanceCriteria,

    previousAttemptId: input.attempt?.attemptId ?? null,
    previousAgentId: input.attempt?.agentId ?? input.outcome.agentId,
    previousModelId: input.attempt?.modelId ?? input.outcome.modelId,
    previousLeaseVersion: input.attempt?.leaseVersion ?? null,

    handoffReason: input.reason,
    handoffCode: input.outcome.code,
    handoffDetail: input.outcome.reason,

    completedWork: completed,
    remainingWork: input.remainingWork ?? derivedRemaining,
    changedFiles: handoff?.changedFiles ?? [],
    testsRun: handoff?.testsRun ?? [],
    decisions: handoff?.decisions ?? null,
    unresolved: handoff?.unresolved ?? [],
    errors,

    executionOutcome: input.outcome.outcome,
    evidence: handoff,

    workspace: input.workspace ?? { path: null, mode: null },
    artifacts: handoff?.artifacts ?? [],

    // Deliberately null: see the interface note.
    nextAction: null,

    // A session handle is only meaningful to the agent that created it.
    nativeSessionReference:
      input.nativeThreadId !== undefined && input.nativeThreadId !== null &&
      input.nativeThreadId !== '' && input.attempt !== null
        ? { agentId: input.attempt.agentId, threadId: input.nativeThreadId }
        : null,

    stopSafety,
  };
}

/**
 * Render the packet as the bounded context handed to Laya (and, through Laya's chosen
 * agent, to Agent B).
 *
 * This is OBSERVATION text. It describes what happened; it is never an instruction to
 * the decision brain, exactly like the existing `buildTaskBrief` separation.
 */
export function renderContinuationPacket(packet: ContinuationPacket, maxChars = 2_000): string {
  const tail = (s: string): string => (s.length <= maxChars ? s : `…${s.slice(s.length - maxChars)}`);
  const lines: string[] = [];
  lines.push(`CONTINUATION PACKET (same task ${packet.taskId})`);
  lines.push(`objective: ${packet.originalObjective}`);
  lines.push('');
  lines.push('The previous worker could not continue. This is not a failure of the work.');
  lines.push(`  previous worker : ${packet.previousAgentId ?? '(unknown)'}${packet.previousModelId === null ? '' : ` / ${packet.previousModelId}`}`);
  lines.push(`  previous attempt: ${packet.previousAttemptId ?? '(none recorded)'}`);
  lines.push(`  handoff reason  : ${packet.handoffReason}${packet.handoffCode === null ? '' : ` (${packet.handoffCode})`}`);
  if (packet.handoffDetail !== null) lines.push(`  detail          : ${packet.handoffDetail}`);
  lines.push(`  execution outcome: ${packet.executionOutcome}`);
  if (packet.previousLeaseVersion !== null) {
    lines.push(`  lease it ran under: version ${packet.previousLeaseVersion}`);
  }
  lines.push('');
  lines.push('EVIDENCE FROM THE PREVIOUS ATTEMPT (machine-recorded, not self-reported):');
  if (packet.changedFiles.length === 0) lines.push('  files it wrote : none recorded');
  else lines.push(`  files it wrote : ${packet.changedFiles.join(', ')}`);
  if (packet.testsRun.length === 0) lines.push('  tests it ran   : none recorded');
  else lines.push(`  tests it ran   : ${packet.testsRun.join(' ; ')}`);
  if (packet.decisions !== null) lines.push(`  it stated      : ${tail(packet.decisions)}`);
  if (packet.completedWork !== null) {
    lines.push(`  it said it did : ${tail(packet.completedWork.text)}  [source: ${packet.completedWork.source}]`);
  }
  if (packet.unresolved.length > 0) lines.push(`  it left open   : ${packet.unresolved.join('; ')}`);
  if (packet.errors.length > 0) {
    lines.push('  reported errors:');
    for (const e of packet.errors) lines.push(`    ${e.code ?? '(no code)'}: ${e.message ?? '(no message)'}`);
  }
  if (packet.artifacts.length > 0) {
    lines.push('  artifacts:');
    for (const a of packet.artifacts) lines.push(`    ${a.name}: ${a.path}`);
  }
  if (packet.workspace.path !== null) lines.push(`  workspace: ${packet.workspace.path}`);
  lines.push('');
  lines.push('WHAT REMAINS');
  if (packet.remainingWork === null) {
    lines.push('  (not stated) — treat the acceptance criteria above as the definition of remaining work');
  } else {
    lines.push(`  ${tail(packet.remainingWork.text)}  [source: ${packet.remainingWork.source}]`);
  }
  lines.push('');
  // B5.1: the stop fact travels WITH the handoff context so the next worker knows the
  // previous process tree was proven stopped (or, when the fact is not required, that the
  // previous run never entered an execution edge at all).
  lines.push(`STOP FACT: ${packet.stopSafety.detail}`);
  lines.push('');
  lines.push(
    packet.nativeSessionReference === null
      ? 'No native session carries over: start a fresh conversation on the new agent.'
      : `A native session for ${packet.nativeSessionReference.agentId} may be resumed if that same agent continues.`,
  );
  // B5.1 (requirement D): the next worker is told to CHECK what already exists rather
  // than blindly redo it. This is guidance, NOT a guarantee that any side effect is
  // safe to recover: a partial external action may be unrecoverable.
  lines.push('');
  lines.push(
    'This is a continuation, not a fresh task: a previous worker may already have written files or ' +
    'performed other side effects. Before continuing, CHECK the existing results on disk and in the ' +
    'evidence above, then continue from there. Do NOT blindly replay side effects the previous worker ' +
    'may already have performed.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 3. The bounded continuation budget
// ---------------------------------------------------------------------------

/**
 * The bound on automatic handoffs.
 *
 * A default, not a suggestion: `0` disables handoff entirely, and any value is finite.
 * There is deliberately no "unlimited" representation, because the failure mode being
 * prevented is precisely an unbounded agent-hopping loop.
 */
export interface HandoffPolicy {
  /** Automatic handoffs allowed per task. Must be a finite integer >= 0. */
  readonly maxAutomaticHandoffsPerTask: number;
}

export const DEFAULT_HANDOFF_POLICY: HandoffPolicy = Object.freeze({ maxAutomaticHandoffsPerTask: 2 });

export type HandoffStopCode =
  | 'budget-exhausted'
  | 'loop-refused'
  | 'no-trigger'
  | 'no-eligible-agent'
  | 'decision-refused'
  | 'not-attempted'
  /**
   * B5.1: an executed `session_failure` whose process-tree stop was NOT confirmed.
   *
   * This is a REFUSAL to offer a handoff, not a failed one: the previous worker's tree
   * may still hold a writer, so starting a second attempt would violate the
   * "second writer only after the first is proven stopped" contract. The task keeps its
   * identity and the round is reported unfinished.
   */
  | 'stop-unconfirmed';

/**
 * The code a caller's reassign seam returns when the loop guard refuses the target.
 *
 * Named rather than matched by string so the driver and the seam cannot drift apart.
 */
export const HANDOFF_LOOP_REFUSED = 'handoff-loop-refused' as const;

export interface BudgetVerdict {
  readonly allowed: boolean;
  readonly code: HandoffStopCode | null;
  readonly reason: string;
  readonly used: number;
  readonly limit: number;
}

/**
 * B5.1: a concrete Agent × Model identity, compared FIELD BY FIELD.
 *
 * Deliberately not a concatenated `agent/model` key: distinct pairs can collide after
 * string joining (`a` + `/b` vs `a/` + `b`), and a collision would let a genuinely
 * different worker be mistaken for one already used — exactly the "same key, different
 * fields" false positive this slice must not have. Nothing here authenticates an ACTUAL
 * model; it is the requested/assigned pair as the authorities state it.
 */
export interface WorkerRef {
  readonly agentId: string;
  readonly modelId: string | null;
}

const knownModel = (m: string | null | undefined): m is string => typeof m === 'string' && m !== '';

/**
 * Same worker, STRICTLY: used to decide whether a reassign actually MOVED the task.
 *
 *   - different agent            -> different worker
 *   - same agent, both models KNOWN and different -> different worker (m1 -> m2)
 *   - same agent, either model UNKNOWN -> conservatively the SAME worker; a missing
 *     model is never evidence that the model changed.
 */
export function isSameWorker(a: WorkerRef, b: WorkerRef): boolean {
  if (a.agentId !== b.agentId) return false;
  if (knownModel(a.modelId) && knownModel(b.modelId)) return a.modelId === b.modelId;
  return true;
}

/**
 * Already-used, LOOSELY: used to guard the loop. Same field comparison as
 * `isSameWorker`, so an unknown model on either side is treated as the same worker and
 * cannot be used to sneak back into the chain.
 */
export function workerAlreadyUsed(used: readonly WorkerRef[], target: WorkerRef): boolean {
  return used.some((u) => isSameWorker(u, target));
}

/**
 * Decide whether one more handoff may happen.
 *
 * Two independent guards, both required:
 *
 *   1. the COUNT — `used < limit`. Without it, A→B→C→D never ends.
 *   2. the LOOP — a target already used in this chain is refused, because
 *      `quota_exhausted, reassign, quota_exhausted, reassign back to A` is the exact
 *      oscillation this feature could otherwise produce.
 *
 * The loop guard has a documented, narrow escape: `layaReason` non-empty means Laya
 * stated WHY returning to that agent is right. That is the "unless Laya has an
 * explicit reason" clause — and it still cannot exceed the count bound, because a
 * justification is not a licence to loop forever.
 *
 * B5.1: when the caller supplies CONCRETE pairs (`workersUsed` + `target`), the loop
 * guard compares agentId/modelId FIELD BY FIELD, so the same agent on a DIFFERENT known
 * model is a new worker and is allowed. Callers that supply only `agentsUsed`/
 * `targetAgentId` keep the original agent-only, conservative semantics unchanged.
 */
export function evaluateHandoffBudget(input: {
  readonly policy: HandoffPolicy;
  readonly used: number;
  /** Agents already used in this continuation chain, oldest first. */
  readonly agentsUsed: readonly string[];
  /** The agent Laya is about to choose, when it is already known. */
  readonly targetAgentId?: string | null;
  /** Laya's stated justification, if any. Only it can unlock the loop guard. */
  readonly layaReason?: string | null;
  /** B5.1: the concrete pairs already used in this chain, oldest first. */
  readonly workersUsed?: readonly WorkerRef[];
  /** B5.1: the concrete pair Laya is about to choose, when it is fully known. */
  readonly target?: WorkerRef | null;
}): BudgetVerdict {
  const limit = input.policy.maxAutomaticHandoffsPerTask;
  const justified = input.layaReason !== undefined && input.layaReason !== null && input.layaReason.trim() !== '';

  if (!Number.isInteger(limit) || limit < 0) {
    return {
      allowed: false,
      code: 'budget-exhausted',
      reason: `maxAutomaticHandoffsPerTask must be a finite integer >= 0, got ${String(limit)}; ` +
        'an unbounded handoff policy is refused rather than clamped',
      used: input.used,
      limit,
    };
  }

  if (input.used >= limit) {
    return {
      allowed: false,
      code: 'budget-exhausted',
      reason: `this task already used ${input.used} automatic handoff(s) of a maximum of ${limit}; ` +
        'the chain stops here and the round goes to review',
      used: input.used,
      limit,
    };
  }

  // Pair guard when concrete data is supplied; agent-only guard otherwise.
  const targetWorker = input.target ?? null;
  if (targetWorker !== null && input.workersUsed !== undefined) {
    if (workerAlreadyUsed(input.workersUsed, targetWorker)) {
      if (!justified) {
        return {
          allowed: false,
          code: 'loop-refused',
          reason: `${targetWorker.agentId}/${targetWorker.modelId ?? '(default)'} already ran this task in the ` +
            'current continuation chain; returning to it would oscillate, so it is refused unless the decision ' +
            'brain states an explicit reason',
          used: input.used,
          limit,
        };
      }
    }
  } else {
    const target = input.targetAgentId ?? null;
    if (target !== null && input.agentsUsed.includes(target)) {
      if (!justified) {
        return {
          allowed: false,
          code: 'loop-refused',
          reason: `"${target}" already ran this task in the current continuation chain ` +
            `(${input.agentsUsed.join(' -> ')}); returning to it would oscillate, so it is refused ` +
            'unless the decision brain states an explicit reason',
          used: input.used,
          limit,
        };
      }
    }
  }

  return {
    allowed: true,
    code: null,
    reason: `${input.used} of ${limit} automatic handoff(s) used`,
    used: input.used,
    limit,
  };
}

// ---------------------------------------------------------------------------
// 4. The driver
// ---------------------------------------------------------------------------

/**
 * What the driver needs from the outside world.
 *
 * Injected, so this module holds no authority. `runCycle` is the SAME
 * `runDecisionCycle` the round already calls — there is no second decision path, and
 * the driver cannot dispatch because it has nothing to dispatch with.
 */
export interface ContinuationDeps {
  /** Run one decision cycle. Returns what the brain decided and what ran. */
  readonly runCycle: (context: string | null) => Promise<ContinuationCycleResult>;
  /** Classify every task's current terminal outcome from real evidence. */
  readonly readOutcomes: () => Promise<readonly ExecutionOutcome[]>;
  /** Build the packet for one task, from TaskStore + AttemptStore + buildHandoff. */
  readonly buildPacket: (taskId: string, outcome: ExecutionOutcome) => ContinuationPacket | null;
  /** The task's current identity, so the driver can tell whether a handoff happened. */
  readonly identityOf: (taskId: string) => { readonly agentId: string; readonly modelId: string | null } | null;
  /**
   * R2-3: called ONCE per handoff, immediately after the identity change is confirmed
   * and BEFORE the loop iterates again.
   *
   * THIS IS THE P0-2 SEAM, and its shape is the whole design decision.
   *
   * `reassign` deliberately does not dispatch: `applyDecision` applies the migration and
   * stops, so the next run happens on a LATER tick. The driver therefore cannot simply
   * loop — nothing would ever execute for the new agent and the chain would stall.
   *
   * The driver still must NOT dispatch itself. It has no scheduler, and a `tick()` here
   * would be a second dispatch loop that could run a task twice. So the driver announces
   * that a handoff has been APPLIED and the caller performs the next dispatch through the
   * ONE authority it already owns — production does this as
   * `requeue if parked` + `NativeWorkbench.dispatch()`, and a test does it with the same
   * two calls.
   *
   * Being called here, rather than at the end, is what guarantees one dispatch per handoff
   * and lets the next iteration read the NEW attempt from the evidence store.
   */
  readonly onHandoffApplied?: (record: HandoffRecord) => Promise<void>;
  /**
   * The agents already used in this chain, oldest first.
   *
   * Exposed so the caller can enforce the target guard at the seam where a target first
   * exists. It cannot be enforced here: `targetAgentId` only becomes known once Laya has
   * answered and `applyDecision` has already acted, so a pre-check inside the driver
   * would either miss the target or run after the migration.
   */
  readonly agentsUsed?: () => readonly string[];
  readonly now: () => number;
}

export interface ContinuationCycleResult {
  /** The action Laya chose, e.g. `reassign`. Raw, for reporting. */
  readonly action: string | null;
  readonly applied: boolean;
  readonly dispatched: boolean;
  readonly code: string | null;
  readonly reason: string | null;
  /** The agent Laya named, when it named one. */
  readonly targetAgentId: string | null;
  /** B5.1: the model Laya named, when it named one. Kept so the report shows the pair. */
  readonly targetModelId?: string | null;
}

export interface HandoffRecord {
  readonly taskId: string;
  readonly reason: HandoffReason;
  readonly fromAgentId: string | null;
  readonly toAgentId: string | null;
  /** B5.1: the model the previous worker was on (requested/assigned), additive. */
  readonly fromModelId: string | null;
  /** B5.1: the model the task was moved to (requested/assigned), additive. */
  readonly toModelId: string | null;
  readonly previousAttemptId: string | null;
  readonly packet: ContinuationPacket;
  readonly decisionAction: string | null;
  readonly decisionApplied: boolean;
  readonly decisionNote: string | null;
  readonly at: number;
}

export interface ContinuationResult {
  /** Every handoff that actually happened, in order. */
  readonly handoffs: readonly HandoffRecord[];
  /** Why the chain stopped. Never null: a stop with no reason is not auditable. */
  readonly stopped: { readonly code: HandoffStopCode; readonly reason: string };
  readonly policy: HandoffPolicy;
  /** How many decision cycles the continuation consumed. Bounded, and reported. */
  readonly cyclesUsed: number;
  /**
   * The agents each task's chain has used, in order.
   *
   * Reported so a caller (or an auditor) can assert the no-oscillation property from the
   * RESULT, rather than re-deriving it from the handoff records.
   */
  readonly agentChain: Readonly<Record<string, readonly string[]>>;
  /**
   * B5.1: the concrete Agent × Model pairs each task's chain has used, in order.
   *
   * Additive beside `agentChain` (kept for compatibility). The pair chain is the
   * authoritative source for "was a DIFFERENT worker used?", so a same-agent different
   * model is visible as a real change; `agentChain` must not be used to authenticate an
   * actual model or a handoff count.
   */
  readonly workerChain: Readonly<Record<string, readonly WorkerRef[]>>;
}

/**
 * Run bounded same-task continuation.
 *
 * Shape of the loop, and why each part is there:
 *
 *   - read REAL outcomes from evidence, never from the brain's description
 *   - if no outcome is a handoff trigger, stop (`no-trigger`) — the common case, and
 *     the reason a normal round costs exactly one extra observation and no extra cycle
 *   - build the packet so Laya is deciding with the previous attempt's evidence in
 *     front of it, not just a task id
 *   - ask the budget
 *   - run ONE cycle, handing the packet to Laya as context
 *   - if Laya did not reassign, stop (`no-eligible-agent` / `decision-refused`): it is
 *     the ONLY one who may choose the next agent, so its refusal ends the chain
 *   - repeat
 *
 * The loop is bounded three ways at once: the policy count, the agent-repeat guard,
 * and the fact that each iteration consumes one cycle from a caller-supplied ceiling.
 */
export async function runHandoffContinuation(
  deps: ContinuationDeps,
  options: {
    readonly policy?: HandoffPolicy;
    /** Hard ceiling on cycles, so a misbehaving provider cannot spin here. */
    readonly maxCycles?: number;
  } = {},
): Promise<ContinuationResult> {
  const policy = options.policy ?? DEFAULT_HANDOFF_POLICY;
  const maxCycles = options.maxCycles ?? Math.max(1, policy.maxAutomaticHandoffsPerTask * 2);

  const handoffs: HandoffRecord[] = [];
  const agentsUsed = new Map<string, string[]>();
  const workersUsed = new Map<string, WorkerRef[]>();
  let cyclesUsed = 0;

  const stop = (code: HandoffStopCode, reason: string): ContinuationResult => ({
    handoffs,
    stopped: { code, reason },
    policy,
    cyclesUsed,
    agentChain: Object.fromEntries([...agentsUsed.entries()].map(([k, v]) => [k, [...v]])),
    workerChain: Object.fromEntries([...workersUsed.entries()].map(([k, v]) => [k, v.map((w) => ({ ...w }))])),
  });

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    const outcomes = await deps.readOutcomes();

    // Only consider a task that actually wants continuing, and only the FIRST such
    // task per pass: one decision per cycle is the loop's own contract, and a round
    // with several starved tasks resolves them one at a time within its budget.
    const target = outcomes.find((o) => classifyHandoffReason(o).handoff);
    if (target === undefined) {
      return stop('no-trigger', 'no task ended in an availability outcome, so no continuation was offered');
    }

    const classification = classifyHandoffReason(target);
    if (!classification.handoff) {
      // Unreachable given the `find` above, and kept so the reason type is proven.
      return stop('no-trigger', classification.explanation);
    }

    const used = agentsUsed.get(target.taskId) ?? [];
    const before = deps.identityOf(target.taskId);
    const budget = evaluateHandoffBudget({
      policy,
      used: used.length,
      agentsUsed: used,
    });
    if (!budget.allowed) {
      return stop(budget.code ?? 'budget-exhausted', budget.reason);
    }

    const packet = deps.buildPacket(target.taskId, target);
    if (packet === null) {
      return stop('no-trigger', `no continuation packet could be built for ${target.taskId}`);
    }

    // B5.1: the STOP gate. An executed session_failure whose process-tree stop is not
    // confirmed must NOT even ask Laya to choose another worker: the previous tree may
    // still hold a writer, and a reassign+dispatch would start a second one. This is
    // checked BEFORE `runCycle`, so no reassign is requested, no identity is migrated and
    // no second runtime can start. Nothing here infers a stop from exit code, output,
    // error name or `processStart`; only `cleanup.treeStopConfirmed === true` clears it.
    if (packet.stopSafety.required && packet.stopSafety.confirmed !== true) {
      return stop(
        'stop-unconfirmed',
        `task ${target.taskId} ended in a session failure (${packet.handoffCode ?? 'no code'}) but its ` +
          'process-tree stop is NOT confirmed; the old execution must be proven stopped before any other ' +
          'worker may continue it, so no handoff was offered and the task keeps its identity',
      );
    }

    cyclesUsed++;
    const decision = await deps.runCycle(renderContinuationPacket(packet));

    // Laya is the only one who may choose the next agent. Anything else ends the chain.
    //
    // The two refusal shapes are reported differently, because they mean different things
    // to whoever reads the round report:
    //
    //   - Laya answered something OTHER than `reassign` (`wait`, `abort`, ...): there is
    //     no worker it is willing to put on this task. That is "handoff unavailable".
    //   - Laya DID answer `reassign` and the authority refused it: a concrete refusal
    //     with a code (assignment found no candidate, migration refused, ...).
    if (!decision.applied || decision.action !== 'reassign') {
      const triedToMove = decision.action === 'reassign';
      // A `loop-refused` code means the CALLER's reassign seam enforced the target guard
      // before the migration happened (see `authorizeTarget`). It is reported as its own
      // stop code rather than folded into `decision-refused`, because "you asked for an
      // agent already in this chain" is a materially different fact from "assignment
      // refused you", and an operator reading the round report needs to tell them apart.
      const cycleFailed = decision.code !== null && decision.code.startsWith('cycle-');
      const stopCode: HandoffStopCode =
        decision.code === HANDOFF_LOOP_REFUSED ? 'loop-refused'
          // A decision that never validated is NOT "no eligible agent". Reporting it that
          // way would blame Laya's judgement for a malformed answer, and would hide a
          // provider or schema fault behind a plausible story.
          : cycleFailed ? 'decision-refused'
            : triedToMove ? 'decision-refused' : 'no-eligible-agent';
      return stop(
        stopCode,
        cycleFailed
          ? `the continuation decision could not be acted on (${decision.code}): ${decision.reason ?? 'no reason given'}`
          : triedToMove
            ? `the decision to move this task on was refused (${decision.code ?? 'no code'}): ${decision.reason ?? 'no reason given'}`
            : `the decision brain answered "${decision.action ?? 'nothing'}" instead of moving this task to another ` +
              'agent; it is the only authority allowed to choose, so no eligible agent was available and the ' +
              'task stays visible for review',
      );
    }

    const after = deps.identityOf(target.taskId);
    // B5.1: a move is judged on the concrete PAIR, field by field. A same-agent change to
    // a different KNOWN model IS a new worker and must be recorded as a real change (the
    // old agent-only comparison reported m1 -> m2 as "no change"). An unknown/missing model
    // stays conservative and is NOT treated as a move.
    //
    // `beforeWorker` is the Task identity read BEFORE the reassign; `moved` is a fact about
    // that identity changing. The handoff SOURCE's MODEL (`fromWorker.modelId`), however, is
    // authenticated from the PACKET's previous attempt — the model that actually ran — and
    // NOT reverse-derived from a `before` that may already have been migrated. Otherwise a
    // stray migration before this driver would make the record claim `fromModel = m2` while
    // `previousAttemptId` still resolved to m1's attempt (which really ran `m1`).
    const beforeWorker: WorkerRef = {
      agentId: before?.agentId ?? packet.previousAgentId ?? 'unknown',
      modelId: before?.modelId ?? packet.previousModelId ?? null,
    };
    const fromWorker: WorkerRef = {
      agentId: beforeWorker.agentId,
      modelId: packet.previousModelId ?? beforeWorker.modelId,
    };
    const afterWorker: WorkerRef | null = after === null
      ? null
      : { agentId: after.agentId, modelId: after.modelId };
    const moved = afterWorker !== null && before !== null && !isSameWorker(beforeWorker, afterWorker);
    const toAgentId = after?.agentId ?? decision.targetAgentId;
    const toModelId = after?.modelId ?? decision.targetModelId ?? null;

    handoffs.push({
      taskId: target.taskId,
      reason: classification.reason,
      fromAgentId: fromWorker.agentId,
      toAgentId,
      fromModelId: fromWorker.modelId,
      toModelId,
      previousAttemptId: packet.previousAttemptId,
      packet,
      decisionAction: decision.action,
      decisionApplied: decision.applied,
      decisionNote: decision.reason,
      at: deps.now(),
    });

    agentsUsed.set(target.taskId, [...used, fromWorker.agentId]);
    const workersBefore = workersUsed.get(target.taskId) ?? [];
    workersUsed.set(target.taskId, [...workersBefore, fromWorker]);

    if (!moved) {
      return stop(
        'no-eligible-agent',
        `the reassign was applied but ${target.taskId} still runs on the same worker ` +
          `(${toAgentId ?? 'unknown'}/${toModelId ?? 'default'}); there is no other eligible worker, so the ` +
          'chain ends rather than looping',
      );
    }

    // The repeat guard runs AFTER the fact, so a chain that already oscillated is
    // stopped here rather than being prevented from starting. B5.1: the comparison is on
    // the concrete pair, so a same-agent loop between two models is not mistaken for a
    // benign move.
    const chainNow = workersUsed.get(target.taskId) ?? [];
    const repeat = chainNow.length >= 2 && isSameWorker(chainNow[chainNow.length - 1]!, chainNow[chainNow.length - 2]!);
    if (repeat) {
      return stop(
        'loop-refused',
        `the worker chain ${chainNow.map((w) => `${w.agentId}/${w.modelId ?? 'default'}`).join(' -> ')} began ` +
          'repeating itself, so it is stopped before continuing',
      );
    }

    // R2-3 P0-2: the handoff is applied; now the CALLER performs the single next dispatch.
    // Until it does, the new agent has an identity but no attempt — so this must happen
    // before the loop reads outcomes again, or the chain would decide from stale evidence.
    if (deps.onHandoffApplied !== undefined) {
      await deps.onHandoffApplied(handoffs[handoffs.length - 1]!);
    }
  }

  return stop('budget-exhausted', `continuation reached its cycle ceiling of ${maxCycles}`);
}