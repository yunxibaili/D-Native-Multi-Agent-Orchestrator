/**
 * R4 — Round Result Aggregation + Human Gate.
 *
 * WHAT THIS FILE IS
 * -----------------
 * A DERIVED, READ-ONLY PROJECTION. It answers "what happened in this round, and
 * what does the user have to decide next?" using facts that already exist, and it
 * owns nothing.
 *
 * WHAT THIS FILE IS NOT — read this before adding anything here
 * ------------------------------------------------------------
 * It is not a ResultManager, a HumanGateManager, a NextRoundManager, a report
 * store, or a decision authority. Specifically it:
 *
 *   - does NOT dispatch. There is no `runtime.run(`, no Scheduler, no
 *     `Orchestrator.executeTask`, no `TaskScheduler` reference anywhere below.
 *   - does NOT ask Laya. It never imports `decision.ts` / `decision-loop.ts` and
 *     never runs a decision cycle. The next-round input is a sealed CONTRACT for a
 *     future caller to hand to Laya; producing it is not permission to plan.
 *   - does NOT retry / reassign / replan / split / parallelize / rework / hand off.
 *     Nothing here can move a task. `HumanGate` is computed FROM task statuses, and
 *     the only transition it can express is "the orchestrator stops".
 *   - does NOT write state. Every function is pure: data in, data out. Persistence is
 *     `round-observation.ts`'s existing job; the CLI composes the two.
 *   - does NOT keep state between calls. There is no module-level mutable registry.
 *
 * WHY A PROJECTION AND NOT A STATE MACHINE
 * ---------------------------------------
 * The gate has no lifecycle of its own because it must not be able to loop. Its
 * status is recomputed from the authoritative sources every time it is asked for, so
 * there is no second copy of "is this round done?" that could drift, and no way for
 * this layer to authorise the next move. See `deriveHumanGate`.
 *
 * REUSED, NOT REBUILT
 * -------------------
 *   - `TaskStore` tasks            -> task identity, objective, status, agent, model
 *   - `AttemptStore` records       -> per-attempt evidence (attempt-integration.ts wrote them)
 *   - `TaskHandoff` (workbench)    -> changedFiles / testsRun / artifacts
 *   - `UnifiedRoundReport`         -> review conclusion + execution outcomes
 *   - `ContinuationResult`         -> handoff history, agent chain, stop reason
 *   - `TASK_STATUSES` / `TERMINAL_STATUSES` -> the ONLY task-state vocabulary used
 */

import {
  ATTEMPT_KINDS,
  ATTEMPT_OUTCOMES,
  type AttemptKind,
  type AttemptOutcome,
  type AttemptRecord,
} from './attempt-record.ts';
import { EXECUTION_OUTCOMES, type ExecutionOutcomeKind, type UnifiedRoundReport } from './unified-review.ts';
import { TERMINAL_STATUSES, type Task, type TaskStatus } from './task.ts';
import type { TaskType } from '../quota/types.ts';
import { HANDOFF_REASONS, type HandoffReason } from './continuation.ts';

// ---------------------------------------------------------------------------
// 1. Round identity
// ---------------------------------------------------------------------------

/**
 * When this round ran.
 *
 * `startedAt`/`completedAt` are the caller's clock readings, not this file's: a
 * report that stamped its own `Date.now()` would disagree with the attempt records
 * it is summarising, and the round's timeline is machine evidence.
 */
export interface RoundIdentity {
  readonly roundId: string;
  readonly startedAt: number;
  readonly completedAt: number | null;
  /** True once `completedAt` is stamped. Never set by this file. */
  readonly complete: boolean;
}

// ---------------------------------------------------------------------------
// 2. Laya plan summary
// ---------------------------------------------------------------------------

/**
 * What the user asked for and how the ONE decision brain shaped it.
 *
 * `layaPlan` is the plan text the review packet already carries (Laya's own words,
 * bounded). `taskGraph` is DERIVED from the task list — edges and counts — because a
 * graph summary is a fact about the tasks, not a second copy of the planner's output.
 */
export interface RoundPlanSummary {
  readonly originalRequest: string;
  readonly layaPlan: string | null;
  readonly taskCount: number;
  /** Per-task parent edges, so the shape is visible without the planner object. */
  readonly taskGraph: readonly {
    readonly taskId: string;
    readonly parentTaskId: string | null;
    readonly depth: number;
    readonly dependencies: readonly string[];
    readonly taskType: TaskType;
  }[];
}

// ---------------------------------------------------------------------------
// 3. Task summary
// ---------------------------------------------------------------------------

export interface TaskSummary {
  readonly taskId: string;
  /** The task's own acceptance criteria — what "done" means for it. */
  readonly objective: string;
  readonly taskType: TaskType;
  readonly status: TaskStatus;
  /**
   * 0 for the round's root, 1 for its children.
   *
   * THIS IS WHY THE HUMAN GATE CAN EVER OPEN. The root is the round's objective, not a
   * unit of work: `TASK_TRANSITIONS` allows `planned -> queued | blocked | cancelled`
   * only, so a root can NEVER reach `succeeded`, and the round never executes it. A gate
   * that waited for the root to be terminal would therefore never open in production.
   */
  readonly depth: number;
  readonly agentId: string | null;
  readonly modelId: string | null;
  readonly attemptCount: number;
  /** Execution outcome as classified for the review; `null` when never classified. */
  readonly outcome: ExecutionOutcomeKind | null;
  readonly executed: boolean;
  /** Declared artifacts, paths only. Never contents. */
  readonly artifacts: readonly { readonly name: string; readonly path: string }[];
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

/**
 * Statuses that mean work is genuinely MID-LIFECYCLE, so the round is not over yet.
 *
 * Deliberately NOT "everything that is not terminal". Two real states are excluded, and
 * both exclusions are load-bearing:
 *
 *   - `planned` on the ROOT, which never executes (see `TaskSummary.depth`).
 *   - `planned` on a CHILD that the gate refused before dispatch. A refusal is a settled
 *     outcome, not pending work: it is already in the report as a refusal code, and
 *     waiting for it to become terminal would wait forever for a task nobody will run.
 *
 * `blocked` is likewise settled-for-now: the round is over, nothing will unblock it on
 * its own, and it is surfaced as a decision for the user rather than as "still running".
 */
export const IN_FLIGHT_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'queued',
  'running',
  'to_verify',
  'retrying',
]);

/** True when this task is a unit of work the round actually tried to execute. */
export function isExecutableTask(task: { depth: number }): boolean {
  return task.depth > 0;
}

// ---------------------------------------------------------------------------
// 4. Attempt summary
// ---------------------------------------------------------------------------

/**
 * One attempt, as recorded by the EXISTING AttemptStore.
 *
 * `changedFiles`/`testsRun`/`artifacts` come from the run's `TaskHandoff`, which is
 * the existing evidence projection. F5 matters here: an attempt whose result was
 * REFUSED but which really executed still produced an `execution` record, and this
 * projection keeps it. Dropping it would erase the fact that the agent ran.
 */
export interface AttemptSummary {
  readonly attemptId: string;
  readonly taskId: string;
  readonly kind: AttemptKind;
  readonly agentId: string;
  readonly modelId: string | null;
  /** The assignment-lease version this attempt ran under (R2-2). */
  readonly leaseVersion: number | null;
  readonly sessionId: string | null;
  readonly outcome: AttemptOutcome;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly previousAttemptId: string | null;
  readonly changedFiles: readonly string[];
  readonly testsRun: readonly string[];
  readonly artifacts: readonly { readonly name: string; readonly path: string }[];
  readonly transcriptPath: string | null;
  /** Why THIS attempt handed off, when it did. `null` for a first, unhanded attempt. */
  readonly handoffReason: HandoffReason | null;
  /** Agents this task's chain used, in order. Shared per task, repeated per attempt. */
  readonly continuationChain: readonly string[];
}

// ---------------------------------------------------------------------------
// 5. Handoff summary
// ---------------------------------------------------------------------------

/**
 * `same TaskId`: Attempt A -> reason -> Attempt B.
 *
 * `budgetRemained` reports what the budget verdict actually said. It is NOT a
 * re-derivation: an absent value means the round never asked the budget, which is a
 * different fact from "the budget said no".
 */
export interface HandoffSummary {
  readonly taskId: string;
  readonly count: number;
  readonly limit: number;
  readonly chains: readonly {
    readonly fromAgentId: string | null;
    readonly toAgentId: string | null;
    readonly reason: HandoffReason;
    readonly previousAttemptId: string | null;
    readonly decisionAction: string | null;
    readonly decisionApplied: boolean;
    readonly at: number;
    /** `null` = the round never evaluated budget for this handoff. */
    readonly budgetRemained: boolean | null;
    /** Whether the chain actually continued past this handoff. */
    readonly continued: boolean;
  }[];
  readonly agentChain: readonly string[];
}

// ---------------------------------------------------------------------------
// 6. Review summary
// ---------------------------------------------------------------------------

/**
 * The review, kept in its OWN layer.
 *
 * Nothing in this object is machine evidence about execution, and nothing in the
 * task/attempt layers is a review conclusion. `requested` is explicit so
 * `not_requested` can never be read as "passed".
 */
export interface ReviewSummary {
  readonly requested: boolean;
  readonly status: UnifiedRoundReport['review']['status'];
  readonly reviewer: string;
  readonly verdict: string | null;
  readonly reason: string | null;
  /** Bounded tail of the reviewer's own output. */
  readonly outputSummary: string | null;
  readonly findings: readonly { readonly severity: string; readonly location: string; readonly message: string }[];
  readonly recommendations: readonly string[];
  /** Whether the verdict reached the append-only evidence chain. */
  readonly evidenceRecorded: boolean;
  readonly evidenceAttemptId: string | null;
  /**
   * Always true, and asserted by tests rather than trusted by comment: this layer
   * never applies a verdict. A recommendation is information for the user.
   */
  readonly recommendationsAppliedAutomatically: false;
}

// ---------------------------------------------------------------------------
// 7. Human gate
// ---------------------------------------------------------------------------

/**
 * Round-level gate vocabulary.
 *
 * This is NOT a second task state machine: it adds no task status, has no
 * transitions, and is recomputed from `TASK_STATUSES` + the review status on every
 * call. Four values because three would force a lie — a round that has not finished
 * yet cannot honestly be called any of the other three.
 */
export const HUMAN_GATE_STATUSES = [
  'not_ready',
  'waiting_for_user',
  'ready_for_next_round',
  'completed',
] as const;
export type HumanGateStatus = (typeof HUMAN_GATE_STATUSES)[number];

/** What the user is being asked to choose. Options are descriptions, never commands. */
export interface HumanGateOption {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
}

export interface HumanGate {
  readonly status: HumanGateStatus;
  /** Why this status. Never empty: an unexplained gate is not auditable. */
  readonly reason: string;
  /** True when the round finished its work and control is the user's. */
  readonly roundComplete: boolean;
  /**
   * EXECUTABLE task ids still mid-lifecycle. Empty exactly when `roundComplete`.
   *
   * Excludes the root and never-started tasks on purpose — see `IN_FLIGHT_STATUSES`.
   */
  readonly nonTerminalTasks: readonly string[];
  /**
   * Executable tasks that never started or are blocked. NOT unfinished work: they are
   * settled facts the user must decide about, listed separately so a refused task is
   * never mistaken for something still in progress.
   */
  readonly neverStartedTasks: readonly { readonly taskId: string; readonly status: TaskStatus; readonly reason: string }[];
  /** Whether a review was required and has not settled. */
  readonly reviewOutstanding: boolean;
  /** Succeeded/failed/cancelled counts, so the summary is not re-derived by the reader. */
  readonly taskTally: { readonly succeeded: number; readonly failed: number; readonly cancelled: number; readonly other: number };
  /** What the user must decide. Empty when nothing is outstanding. */
  readonly decisions: readonly HumanGateOption[];
  /**
   * The load-bearing field. Always `'none'` from this layer: nothing here can start
   * work. Exposed so a caller (and the test suite) can assert it rather than infer it.
   */
  readonly automaticPostRoundAction: 'none';
}

// ---------------------------------------------------------------------------
// 8. Next-round input contract
// ---------------------------------------------------------------------------

/**
 * How the next round relates to this one.
 *
 * `continue_task` carries the existing task lineage so a follow-up edit can reuse the
 * TaskIds. `new_round` deliberately carries none: a genuinely new requirement must not
 * be squeezed into this round's execution lifecycle.
 */
export type NextRoundMode = 'continue_task' | 'new_round';

export interface NextRoundTaskLineage {
  readonly taskId: string;
  readonly disposition: 'continue' | 'superseded';
}

/**
 * A SEALED input for a future round. It is a contract, not a plan.
 *
 * Producing one grants no permission: there is no planner here, and the only way this
 * becomes work is a caller passing it to Laya in a later, explicit round.
 */
export interface NextRoundInput {
  /** The round this came from. */
  readonly previousRoundId: string;
  /**
   * A NEW round identity. Always different from `previousRoundId` — two rounds are two
   * rounds, and forcing them into one lifecycle is the failure this guards against.
   */
  readonly nextRoundId: string;
  readonly mode: NextRoundMode;
  /** What the user asked for next. Never invented here. */
  readonly requirement: string;
  /** Tasks this next round may build on. Empty for `new_round`. */
  readonly taskLineage: readonly NextRoundTaskLineage[];
  /** Pointer to the previous round's aggregated result. */
  readonly previousResultRoundId: string;
  readonly createdAt: number;
  /** Always true: this object starts nothing. */
  readonly executed: false;
}

// ---------------------------------------------------------------------------
// 9. The aggregate
// ---------------------------------------------------------------------------

/**
 * The three layers the report must never blur, kept as three fields:
 * `machine` is what ran, `review` is what the reviewer concluded, `summary` is the
 * user-facing sentence. A reader can take any one without inheriting the others'
 * authority.
 */
export interface RoundResult {
  readonly identity: RoundIdentity;
  readonly plan: RoundPlanSummary;
  readonly machine: {
    readonly tasks: readonly TaskSummary[];
    readonly attempts: readonly AttemptSummary[];
    readonly handoffs: readonly HandoffSummary[];
    /** What did NOT finish. Derived from task statuses, never from optimism. */
    readonly unfinished: readonly {
      readonly taskId: string;
      readonly status: TaskStatus;
      readonly reason: string;
    }[];
  };
  readonly review: ReviewSummary;
  readonly summary: {
    /** One line per question the report is required to answer. */
    readonly headline: string;
    readonly userFacing: readonly string[];
  };
  readonly gate: HumanGate;
  /** Where the append-only evidence lives, for anyone who wants to walk it. */
  readonly evidenceNote: string;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Per-task evidence this projection cannot invent: the run's own handoff payload. */
export interface TaskEvidenceInput {
  readonly changedFiles: readonly string[];
  readonly testsRun: readonly string[];
  readonly artifacts: readonly { readonly name: string; readonly path: string }[];
  readonly transcriptPath: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export interface BuildRoundResultInput {
  readonly identity: RoundIdentity;
  /** The ORIGINAL request text, as the user gave it. */
  readonly originalRequest: string;
  /** Laya's plan text, already bounded by the review packet. */
  readonly layaPlan: string | null;
  /** Every task in this round, from the TaskStore. Root included. */
  readonly tasks: readonly Task[];
  /** Every attempt record the AttemptStore holds, execution AND review. */
  readonly attempts: readonly AttemptRecord[];
  /** The existing unified report — the review layer and classified outcomes. */
  readonly unified: UnifiedRoundReport;
  /** The bounded reviewer output tail, when one exists. */
  readonly reviewOutputSummary: string | null;
  /** Whether the round asked for a review at all. */
  readonly reviewRequested: boolean;
  /** Whether the verdict reached the evidence chain (the existing writer's answer). */
  readonly reviewEvidence: { readonly recorded: boolean; readonly attemptId: string | null };
  /** Handoff facts from the EXISTING continuation result. `null` when never attempted. */
  readonly continuation: {
    readonly happened: number;
    readonly limit: number;
    readonly handoffs: readonly {
      readonly taskId: string;
      readonly reason: HandoffReason;
      readonly fromAgentId: string | null;
      readonly toAgentId: string | null;
      readonly previousAttemptId: string | null;
      readonly decisionAction: string | null;
      readonly decisionApplied: boolean;
      readonly at: number;
    }[];
    readonly stopped: { readonly code: string; readonly reason: string };
    readonly agentChain: Readonly<Record<string, readonly string[]>>;
  } | null;
  /** Per-task run evidence, keyed by taskId. Absent = nothing ran for that task. */
  readonly evidence?: Readonly<Record<string, TaskEvidenceInput>>;
  /**
   * Where the append-only evidence lives. Passed in because `UnifiedRoundReport` does not
   * carry it (the review packet does), and this file must not go looking for a store.
   */
  readonly evidenceNote: string;
}

// ---------------------------------------------------------------------------
// 10. Derivation
// ---------------------------------------------------------------------------

function isHandoffReason(value: string): value is HandoffReason {
  return (HANDOFF_REASONS as readonly string[]).includes(value);
}

/** `null` for anything this project does not recognise — never a coerced value. */
function toAttemptKind(value: string): AttemptKind | null {
  return (ATTEMPT_KINDS as readonly string[]).includes(value) ? (value as AttemptKind) : null;
}

function toAttemptOutcome(value: string): AttemptOutcome | null {
  return (ATTEMPT_OUTCOMES as readonly string[]).includes(value) ? (value as AttemptOutcome) : null;
}

function toExecutionOutcome(value: string): ExecutionOutcomeKind | null {
  return (EXECUTION_OUTCOMES as readonly string[]).includes(value) ? (value as ExecutionOutcomeKind) : null;
}

const NO_EVIDENCE: TaskEvidenceInput = Object.freeze({
  changedFiles: [],
  testsRun: [],
  artifacts: [],
  transcriptPath: null,
  errorCode: null,
  errorMessage: null,
});

export function buildRoundResult(input: BuildRoundResultInput): RoundResult {
  const evidence = input.evidence ?? {};
  const attemptsByTask = new Map<string, AttemptRecord[]>();
  for (const record of input.attempts) {
    const bucket = attemptsByTask.get(record.taskId);
    if (bucket === undefined) attemptsByTask.set(record.taskId, [record]);
    else bucket.push(record);
  }

  const handoffReasonsByTask = new Map<string, HandoffReason[]>();
  if (input.continuation !== null) {
    for (const h of input.continuation.handoffs) {
      const reason = isHandoffReason(h.reason) ? h.reason : null;
      if (reason === null) continue;
      const bucket = handoffReasonsByTask.get(h.taskId);
      if (bucket === undefined) handoffReasonsByTask.set(h.taskId, [reason]);
      else bucket.push(reason);
    }
  }

  const outcomesByTask = new Map<string, { outcome: ExecutionOutcomeKind; executed: boolean }>();
  for (const o of input.unified.tasks) {
    const outcome = toExecutionOutcome(o.outcome);
    if (outcome === null) continue;
    outcomesByTask.set(o.taskId, { outcome, executed: o.executed });
  }

  // ---- task summary -------------------------------------------------------
  const taskSummaries: TaskSummary[] = input.tasks.map((t) => {
    const classified = outcomesByTask.get(t.taskId);
    const own = evidence[t.taskId] ?? NO_EVIDENCE;
    const records = attemptsByTask.get(t.taskId) ?? [];
    // Review attempts are evidence ABOUT the round, not executions OF the task, so
    // counting them as attempts would overstate how much work was tried.
    const executionAttempts = records.filter((r) => r.kind === 'execution');
    return {
      taskId: t.taskId,
      objective: t.acceptanceCriteria,
      taskType: t.taskType,
      status: t.status,
      depth: t.depth,
      agentId: t.agentId,
      modelId: t.modelId,
      attemptCount: executionAttempts.length,
      outcome: classified?.outcome ?? null,
      executed: classified?.executed ?? false,
      artifacts: t.artifacts.length > 0
        ? t.artifacts.map((a) => ({ name: a.name, path: a.path }))
        : own.artifacts,
      errorCode: own.errorCode,
      errorMessage: own.errorMessage,
    };
  });

  // ---- attempt summary ----------------------------------------------------
  const attemptSummaries: AttemptSummary[] = [];
  for (const t of input.tasks) {
    const records = attemptsByTask.get(t.taskId) ?? [];
    const own = evidence[t.taskId] ?? NO_EVIDENCE;
    const reasons = handoffReasonsByTask.get(t.taskId) ?? [];
    const chain = input.continuation?.agentChain[t.taskId] ?? [];
    for (const [index, r] of records.entries()) {
      const kind = toAttemptKind(r.kind);
      const outcome = toAttemptOutcome(r.outcome);
      // An unrecognised kind/outcome is reported as null rather than dropped: the
      // attempt still happened and hiding it would be a silent gap in the evidence.
      attemptSummaries.push({
        attemptId: r.attemptId,
        taskId: r.taskId,
        kind: kind ?? 'execution',
        agentId: r.agentId,
        modelId: r.modelId ?? null,
        leaseVersion: r.leaseVersion ?? null,
        sessionId: leaseSessionOf(r),
        outcome: outcome ?? 'error',
        errorCode: r.errorCode ?? own.errorCode,
        errorMessage: r.errorMessage ?? own.errorMessage,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt ?? null,
        previousAttemptId: r.previousAttemptId ?? null,
        // Run-derived evidence belongs to the execution that produced it. A review
        // attempt did not write files, so it must not inherit the execution's list.
        changedFiles: r.kind === 'execution' ? own.changedFiles : [],
        testsRun: r.kind === 'execution' ? own.testsRun : [],
        artifacts: r.kind === 'execution' ? own.artifacts : [],
        transcriptPath: r.kind === 'execution' ? own.transcriptPath : null,
        // Reasons are consumed in order, so attempt N carries the Nth handoff reason.
        handoffReason: r.kind === 'execution' ? reasons[index] ?? null : null,
        continuationChain: chain,
      });
    }
  }

  // ---- handoff summary ----------------------------------------------------
  const handoffSummaries: HandoffSummary[] = [];
  if (input.continuation !== null) {
    type OneHandoff = BuildRoundResultInput['continuation'] extends { handoffs: readonly (infer H)[] } | null
      ? H
      : never;
    const byTask = new Map<string, OneHandoff[]>();
    for (const h of input.continuation.handoffs) {
      const bucket = byTask.get(h.taskId);
      if (bucket === undefined) byTask.set(h.taskId, [h]);
      else bucket.push(h);
    }
    for (const [taskId, list] of byTask) {
      handoffSummaries.push({
        taskId,
        count: list.length,
        limit: input.continuation.limit,
        chains: list.map((h, index) => ({
          fromAgentId: h.fromAgentId,
          toAgentId: h.toAgentId,
          reason: isHandoffReason(h.reason) ? h.reason : 'agent_unavailable',
          previousAttemptId: h.previousAttemptId,
          decisionAction: h.decisionAction,
          decisionApplied: h.decisionApplied,
          at: h.at,
          // Not evaluated per handoff by the round, so honestly unknown.
          budgetRemained: null,
          // A chain continued only if a LATER handoff exists, or the task went on to
          // more than one execution attempt.
          continued: index < list.length - 1 || (attemptsByTask.get(taskId) ?? [])
            .filter((r) => r.kind === 'execution').length > 1,
        })),
        agentChain: input.continuation.agentChain[taskId] ?? [],
      });
    }
  }

  // ---- unfinished ---------------------------------------------------------
  //
  // EXECUTABLE tasks only, and only those genuinely mid-lifecycle. The root is the round's
  // objective and never executes; a never-dispatched child is a settled refusal, not
  // unfinished work. Reporting either as "unfinished" would be a false claim that the
  // round had work left to do.
  const unfinished = taskSummaries
    .filter((t) => isExecutableTask(t) && IN_FLIGHT_STATUSES.has(t.status))
    .map((t) => ({
      taskId: t.taskId,
      status: t.status,
      reason: t.status === 'to_verify'
        ? 'executed and awaiting verification; Verification is the only completion authority'
        : `still ${t.status}; this round did not finish it`,
    }));

  // ---- review summary -----------------------------------------------------
  const reviewSummary: ReviewSummary = {
    requested: input.reviewRequested,
    status: input.unified.review.status,
    reviewer: input.unified.review.reviewer,
    verdict: input.unified.review.verdict,
    reason: input.unified.review.reason,
    outputSummary: input.reviewOutputSummary,
    findings: input.unified.review.findings.map((f) => ({
      severity: f.severity,
      location: f.location,
      message: f.message,
    })),
    recommendations: input.unified.review.recommendations,
    evidenceRecorded: input.reviewEvidence.recorded,
    evidenceAttemptId: input.reviewEvidence.attemptId,
    recommendationsAppliedAutomatically: false,
  };

  const plan: RoundPlanSummary = {
    originalRequest: input.originalRequest,
    layaPlan: input.layaPlan,
    taskCount: input.tasks.length,
    taskGraph: input.tasks.map((t) => ({
      taskId: t.taskId,
      parentTaskId: t.parentTaskId,
      depth: t.depth,
      dependencies: [...t.dependencies],
      taskType: t.taskType,
    })),
  };

  const gate = deriveHumanGate({
    tasks: taskSummaries,
    review: reviewSummary,
    handoffs: handoffSummaries,
  });

  return {
    identity: input.identity,
    plan,
    machine: { tasks: taskSummaries, attempts: attemptSummaries, handoffs: handoffSummaries, unfinished },
    review: reviewSummary,
    summary: buildUserFacingSummary(input, taskSummaries, attemptSummaries, handoffSummaries, reviewSummary, gate),
    gate,
    evidenceNote: input.evidenceNote,
  };
}

/** Session identity, if the attempt record carries one. `null` when it does not. */
function leaseSessionOf(record: AttemptRecord): string | null {
  const raw = record as unknown as Record<string, unknown>;
  const value = raw['sessionId'];
  return typeof value === 'string' && value !== '' ? value : null;
}

// ---------------------------------------------------------------------------
// 11. Human gate derivation
// ---------------------------------------------------------------------------

export interface DeriveHumanGateInput {
  readonly tasks: readonly TaskSummary[];
  readonly review: ReviewSummary;
  readonly handoffs: readonly HandoffSummary[];
}

/**
 * Derive the gate. Pure, total, and side-effect free.
 *
 * The ordering is the whole design:
 *
 *   1. work not finished      -> `not_ready`   (the gate does not exist yet)
 *   2. work finished          -> `waiting_for_user` (the orchestrator STOPS here)
 *   3. user answered          -> `ready_for_next_round` (a sealed NextRoundInput exists)
 *
 * `completed` is what a caller reports once the user has deliberately closed the gate
 * without starting another round; it is never inferred here, because "the user chose to
 * stop" is a fact only the user has.
 */
export function deriveHumanGate(input: DeriveHumanGateInput): HumanGate {
  // Only EXECUTABLE tasks can be unfinished work. The root is the round's objective and
  // never executes; including it would make this gate permanently `not_ready`.
  const executable = input.tasks.filter(isExecutableTask);
  const nonTerminalTasks = executable.filter((t) => IN_FLIGHT_STATUSES.has(t.status)).map((t) => t.taskId);

  const neverStartedTasks = executable
    .filter((t) => !TERMINAL_STATUSES.has(t.status) && !IN_FLIGHT_STATUSES.has(t.status))
    .map((t) => ({
      taskId: t.taskId,
      status: t.status,
      reason: t.status === 'blocked'
        ? 'blocked and never resolved; nothing will unblock it automatically'
        : 'never dispatched (refused at admission, or not selected this round)',
    }));

  // A review that was asked for and did not complete has not settled. `not_requested`
  // is settled (the round declined it on purpose and says so), and `failed`/`unavailable`
  // are settled too — an honest failure is a fact, not a pending state.
  const reviewOutstanding = input.review.requested && input.review.status !== 'completed';
  const roundComplete = nonTerminalTasks.length === 0 && !reviewOutstanding;

  const tally = { succeeded: 0, failed: 0, cancelled: 0, other: 0 };
  for (const t of executable) {
    if (t.status === 'succeeded') tally.succeeded += 1;
    else if (t.status === 'failed') tally.failed += 1;
    else if (t.status === 'cancelled') tally.cancelled += 1;
    else tally.other += 1;
  }

  const decisions: HumanGateOption[] = [];
  if (nonTerminalTasks.length > 0) {
    decisions.push({
      id: 'await-finished-tasks',
      label: 'Wait for the remaining tasks',
      detail: `${nonTerminalTasks.length} task(s) are still mid-lifecycle: ${nonTerminalTasks.join(', ')}`,
    });
  }
  if (neverStartedTasks.length > 0) {
    decisions.push({
      id: 'never-started',
      label: 'Decide about the tasks that never ran',
      detail: `${neverStartedTasks.length} task(s) never started or are blocked: ` +
        `${neverStartedTasks.map((t) => `${t.taskId} (${t.status})`).join(', ')}. ` +
        'Nothing was retried or reassigned to cover them.',
    });
  }
  if (reviewOutstanding) {
    decisions.push({
      id: 'await-review',
      label: 'Decide about the missing review',
      detail: `the review was requested and its status is "${input.review.status}": ` +
        `${input.review.reason ?? 'no reason given'}`,
    });
  }
  if (roundComplete) {
    const failed = executable.filter((t) => t.status === 'failed');
    if (failed.length > 0) {
      decisions.push({
        id: 'failed-tasks',
        label: 'Decide what to do about the failed tasks',
        detail: `${failed.length} task(s) failed: ${failed.map((t) => t.taskId).join(', ')}. ` +
          'Nothing was retried; retrying is your call, not this report\'s.',
      });
    }
    if (input.review.verdict !== null && input.review.verdict !== 'pass') {
      decisions.push({
        id: 'review-verdict',
        label: 'Decide about the review verdict',
        detail: `the reviewer returned "${input.review.verdict}". This is a recommendation and ` +
          'was NOT applied: no task was reworked, retried or reassigned.',
      });
    }
    const handoffCount = input.handoffs.reduce((sum, h) => sum + h.count, 0);
    if (handoffCount > 0) {
      decisions.push({
        id: 'handoff-outcome',
        label: 'Decide about the handoff outcome',
        detail: `${handoffCount} handoff(s) happened; the chain stopped for a recorded reason ` +
          'and no further agent was engaged.',
      });
    }
    decisions.push({
      id: 'next-round',
      label: 'Start another round, or stop here',
      detail: 'This round is finished. The orchestrator has stopped and will not dispatch, ' +
        'retry, reassign, replan, split, parallelize, rework or hand off again on its own.',
    });
  }

  let status: HumanGateStatus;
  let reason: string;
  if (!roundComplete) {
    status = 'not_ready';
    reason = reviewOutstanding
      ? `the review was requested and has not completed (status "${input.review.status}")`
      : `${nonTerminalTasks.length} executable task(s) are still mid-lifecycle: ${nonTerminalTasks.join(', ')}`;
  } else {
    status = 'waiting_for_user';
    reason = `all ${executable.length} executable task(s) settled and the review has settled; ` +
      'the orchestrator has stopped and control is the user\'s';
  }

  return {
    status,
    reason,
    roundComplete,
    nonTerminalTasks,
    neverStartedTasks,
    reviewOutstanding,
    taskTally: tally,
    decisions,
    automaticPostRoundAction: 'none',
  };
}

/**
 * The gate as it looks once the user has answered.
 *
 * A separate function rather than a parameter on `deriveHumanGate`, because the gate
 * itself is recomputed from evidence every time and must stay that way: answering is
 * the USER's act, recorded as a sealed input, not a flag this layer flips.
 */
export function gateWithUserDecision(
  gate: HumanGate,
  decision: { readonly nextRoundInput: NextRoundInput | null; readonly closedByUser: boolean },
): HumanGate {
  if (decision.nextRoundInput !== null) {
    return {
      ...gate,
      status: 'ready_for_next_round',
      reason: `the user answered; a next-round input is sealed for ${decision.nextRoundInput.nextRoundId} ` +
        `(previous round ${decision.nextRoundInput.previousRoundId}). Nothing has been planned or dispatched yet.`,
      automaticPostRoundAction: 'none',
    };
  }
  if (decision.closedByUser) {
    return {
      ...gate,
      status: 'completed',
      reason: 'the round finished and the user closed the gate without starting another round',
      automaticPostRoundAction: 'none',
    };
  }
  return gate;
}

// ---------------------------------------------------------------------------
// 12. Next-round input
// ---------------------------------------------------------------------------

export interface SealNextRoundInputOptions {
  readonly previousRoundId: string;
  /** The user's own words. Never defaulted or invented. */
  readonly requirement: string;
  readonly mode: NextRoundMode;
  /** Existing tasks a `continue_task` round may build on. */
  readonly lineage?: readonly TaskSummary[];
  readonly now: () => number;
  /**
   * Mints the NEW round id. Injected rather than generated internally so the caller
   * keeps whatever id authority it already has — this file must not become one.
   */
  readonly mintRoundId: (previousRoundId: string) => string;
}

/**
 * Seal the contract a later round will start from.
 *
 * Two invariants, both enforced here rather than documented and hoped for:
 *   - `nextRoundId !== previousRoundId`. Two rounds never share an identity.
 *   - `executed` is literally `false`. Sealing is not starting.
 *
 * It does NOT call Laya, plan, dispatch, or open a task. Handing this to Laya is a
 * later, explicit act by the caller.
 */
export function sealNextRoundInput(options: SealNextRoundInputOptions): NextRoundInput {
  const requirement = options.requirement.trim();
  if (requirement === '') {
    throw new Error('sealNextRoundInput requires the user\'s own requirement text; an empty ' +
      'requirement would let a round start with nothing to do.');
  }
  const nextRoundId = options.mintRoundId(options.previousRoundId);
  if (nextRoundId === options.previousRoundId) {
    throw new Error(`sealNextRoundInput refused: the minted next round id "${nextRoundId}" equals the ` +
      `previous round id. Two rounds must be two identities, never one execution lifecycle.`);
  }
  const lineage = options.mode === 'continue_task'
    ? (options.lineage ?? []).map((t) => ({ taskId: t.taskId, disposition: 'continue' as const }))
    : [];

  return {
    previousRoundId: options.previousRoundId,
    nextRoundId,
    mode: options.mode,
    requirement,
    taskLineage: lineage,
    previousResultRoundId: options.previousRoundId,
    createdAt: options.now(),
    executed: false,
  };
}

// ---------------------------------------------------------------------------
// 13. Rendering
// ---------------------------------------------------------------------------

/**
 * Render for a human, with the three layers in three separate sections.
 *
 * The gate section ends by saying what did NOT happen. That sentence is the difference
 * between "Codex recommended rework" and "the system re-ran it", and only the first is
 * true.
 */
export function renderRoundResult(result: RoundResult): string {
  const lines: string[] = [];
  lines.push(`# Round Result — ${result.identity.roundId}`);
  lines.push('');
  lines.push('## Round identity');
  lines.push(`- roundId: ${result.identity.roundId}`);
  lines.push(`- startedAt: ${result.identity.startedAt}`);
  lines.push(`- completedAt: ${result.identity.completedAt ?? '(not stamped)'}`);
  lines.push('');

  lines.push('## What the user asked for');
  lines.push(result.plan.originalRequest);
  lines.push('');
  lines.push(`## How Laya shaped it (${result.plan.taskCount} task(s))`);
  if (result.plan.layaPlan === null) {
    lines.push('- no plan text was recorded for this round');
  } else {
    for (const l of result.plan.layaPlan.split('\n')) lines.push(`- ${l}`);
  }
  lines.push('');
  for (const n of result.plan.taskGraph) {
    lines.push(`- ${n.taskId} (${n.taskType}, depth=${n.depth}, parent=${n.parentTaskId ?? 'root'}` +
      `${n.dependencies.length > 0 ? `, deps=${n.dependencies.join('|')}` : ''})`);
  }
  lines.push('');

  lines.push('## Machine evidence — what actually ran');
  lines.push('(facts recorded by TaskStore / AttemptStore. No judgement here.)');
  lines.push('');
  lines.push(`### Tasks (${result.machine.tasks.length})`);
  for (const t of result.machine.tasks) {
    lines.push(`- ${t.taskId}: ${t.status} outcome=${t.outcome ?? '(not classified)'} ` +
      `executed=${t.executed} agent=${t.agentId ?? '-'} model=${t.modelId ?? '-'} attempts=${t.attemptCount}`);
    lines.push(`    objective: ${t.objective}`);
    if (t.errorCode !== null) lines.push(`    error: ${t.errorCode}${t.errorMessage === null ? '' : ` — ${t.errorMessage}`}`);
  }
  lines.push('');
  lines.push(`### Attempts (${result.machine.attempts.length})`);
  for (const a of result.machine.attempts) {
    lines.push(`- ${a.attemptId} [${a.kind}] ${a.taskId} agent=${a.agentId} model=${a.modelId ?? '-'}` +
      ` lease=${a.leaseVersion ?? '-'} outcome=${a.outcome}`);
    if (a.previousAttemptId !== null) lines.push(`    previous attempt: ${a.previousAttemptId}`);
    if (a.handoffReason !== null) lines.push(`    handed off because: ${a.handoffReason}`);
    if (a.changedFiles.length > 0) lines.push(`    wrote: ${a.changedFiles.join(', ')}`);
    if (a.testsRun.length > 0) lines.push(`    tests: ${a.testsRun.join(' ; ')}`);
    for (const art of a.artifacts) lines.push(`    artifact: ${art.name} -> ${art.path}`);
    if (a.transcriptPath !== null) lines.push(`    transcript: ${a.transcriptPath}`);
    if (a.errorCode !== null) lines.push(`    error: ${a.errorCode}${a.errorMessage === null ? '' : ` — ${a.errorMessage}`}`);
  }
  lines.push('');

  lines.push('## Handoff');
  if (result.machine.handoffs.length === 0) {
    lines.push('- no handoff happened this round');
  } else {
    for (const h of result.machine.handoffs) {
      lines.push(`- ${h.taskId}: ${h.count}/${h.limit} handoff(s); agent chain ${h.agentChain.join(' -> ') || '(none)'}`);
      for (const c of h.chains) {
        lines.push(`    ${c.fromAgentId ?? '?'} -> ${c.toAgentId ?? '?'} because ${c.reason}` +
          ` (decision=${c.decisionAction ?? 'none'}, applied=${c.decisionApplied}, continued=${c.continued})`);
        lines.push(`      same TaskId; previous attempt=${c.previousAttemptId ?? '(none)'}`);
      }
    }
  }
  lines.push('');

  if (result.machine.unfinished.length > 0) {
    lines.push('## Unfinished');
    for (const u of result.machine.unfinished) lines.push(`- ${u.taskId}: ${u.status} — ${u.reason}`);
    lines.push('');
  }

  lines.push('## Review conclusion');
  lines.push('(an independent judgement. NOT machine evidence, and NOT applied automatically.)');
  lines.push('');
  lines.push(`- requested: ${result.review.requested ? 'yes' : 'no'}`);
  lines.push(`- status: ${result.review.status}`);
  lines.push(`- reviewer: ${result.review.reviewer}`);
  lines.push(`- verdict: ${result.review.verdict ?? '(none — this is not a pass)'}`);
  if (result.review.reason !== null) lines.push(`- reason: ${result.review.reason}`);
  if (result.review.outputSummary !== null) {
    lines.push('- reviewer output (bounded):');
    for (const l of result.review.outputSummary.split('\n')) lines.push(`    ${l}`);
  }
  for (const f of result.review.findings) lines.push(`- finding [${f.severity}] ${f.location}: ${f.message}`);
  if (result.review.recommendations.length > 0) {
    lines.push('- recommendations (NOT executed):');
    for (const r of result.review.recommendations) lines.push(`    ${r}`);
  }
  lines.push(`- evidence recorded: ${result.review.evidenceRecorded}` +
    `${result.review.evidenceAttemptId === null ? '' : ` (${result.review.evidenceAttemptId})`}`);
  lines.push('');

  lines.push('## User-facing summary');
  for (const l of result.summary.userFacing) lines.push(`- ${l}`);
  lines.push('');

  lines.push('## HUMAN GATE');
  lines.push(`- status: ${result.gate.status}`);
  lines.push(`- round complete: ${result.gate.roundComplete}`);
  lines.push(`- reason: ${result.gate.reason}`);
  lines.push(`- tasks: ${result.gate.taskTally.succeeded} succeeded, ${result.gate.taskTally.failed} failed, ` +
    `${result.gate.taskTally.cancelled} cancelled, ${result.gate.taskTally.other} other (executable tasks)`);
  if (result.gate.nonTerminalTasks.length > 0) {
    lines.push(`- still mid-lifecycle: ${result.gate.nonTerminalTasks.join(', ')}`);
  }
  for (const n of result.gate.neverStartedTasks) {
    lines.push(`- never started: ${n.taskId} (${n.status}) — ${n.reason}`);
  }
  if (result.gate.reviewOutstanding) lines.push('- the requested review has not completed');
  lines.push('- waiting for you to decide:');
  for (const d of result.gate.decisions) lines.push(`    [${d.id}] ${d.label} — ${d.detail}`);
  lines.push(`- automatic post-round action: ${result.gate.automaticPostRoundAction.toUpperCase()}`);
  lines.push('  Nothing was retried, reassigned, replanned, split, parallelized, reworked or handed off.');
  lines.push('  This round is over; run another one yourself when you want more.');
  lines.push('');
  lines.push(`- evidence: ${result.evidenceNote}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 14. User-facing summary
// ---------------------------------------------------------------------------

function buildUserFacingSummary(
  input: BuildRoundResultInput,
  tasks: readonly TaskSummary[],
  attempts: readonly AttemptSummary[],
  handoffs: readonly HandoffSummary[],
  review: ReviewSummary,
  gate: HumanGate,
): { headline: string; userFacing: readonly string[] } {
  const succeeded = tasks.filter((t) => t.status === 'succeeded');
  const failed = tasks.filter((t) => t.status === 'failed');
  const handoffCount = handoffs.reduce((n, h) => n + h.count, 0);
  const files = [...new Set(attempts.flatMap((a) => [...a.changedFiles]))];
  const tests = [...new Set(attempts.flatMap((a) => [...a.testsRun]))];
  const artifacts = attempts.flatMap((a) => a.artifacts.map((art) => `${art.name} -> ${art.path}`));

  const headline = `${tasks.length} task(s): ${succeeded.length} succeeded, ${failed.length} failed; ` +
    `${attempts.length} attempt(s); ${handoffCount} handoff(s); review ${review.status}` +
    `${review.verdict === null ? '' : ` (${review.verdict})`}.`;

  const userFacing: string[] = [];
  userFacing.push(`You asked: ${input.originalRequest}`);
  userFacing.push(headline);
  for (const t of tasks) {
    userFacing.push(`${t.taskId} (${t.taskType}) — ${t.status}, done by ${t.agentId ?? 'nobody'}` +
      `${t.modelId === null ? '' : ` on ${t.modelId}`}, ${t.attemptCount} attempt(s)` +
      `${t.outcome === null ? '' : `, outcome ${t.outcome}`}`);
  }
  if (handoffCount > 0) {
    for (const h of handoffs) {
      userFacing.push(`${h.taskId} was handed off ${h.count} time(s): ` +
        h.chains.map((c) => `${c.fromAgentId ?? '?'} -> ${c.toAgentId ?? '?'} (${c.reason})`).join('; '));
    }
  }
  if (files.length > 0) userFacing.push(`Files changed (${files.length}): ${files.join(', ')}`);
  if (tests.length > 0) userFacing.push(`Tests run (${tests.length}): ${tests.join(' ; ')}`);
  if (artifacts.length > 0) userFacing.push(`Artifacts (${artifacts.length}): ${artifacts.join(' ; ')}`);
  userFacing.push(`Codex review: ${review.status}` +
    `${review.verdict === null ? ' (no verdict — not a pass)' : ` — ${review.verdict}`}` +
    `${review.reason === null ? '' : ` (${review.reason})`}`);
  const notFinished = tasks.filter((t) => isExecutableTask(t) && IN_FLIGHT_STATUSES.has(t.status));
  if (notFinished.length > 0) {
    userFacing.push('Not finished: ' + notFinished.map((t) => `${t.taskId} (${t.status})`).join(', '));
  }
  userFacing.push(`Next: the round is at the human gate (${gate.status}). ` +
    'Decide whether to start another round; nothing will run without you.');

  return { headline, userFacing };
}
