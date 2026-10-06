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
import {
  EXECUTION_OUTCOMES,
  REVIEW_STATUSES,
  type ExecutionOutcomeKind,
  type UnifiedRoundReport,
} from './unified-review.ts';
import { TASK_STATUSES, type Task, type TaskStatus } from './task.ts';
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
 * How a task's lifecycle state bears on round completion.
 *
 *   `terminal`      the task is done; nothing further is expected this round
 *   `in_flight`     work is genuinely pending, so the round is NOT over
 *   `never_started` never dispatched at all (planned, e.g. admission-refused)
 *   `blocked`       waiting on something that nothing will resolve in this round
 *
 * WHY A TOTAL CLASSIFICATION INSTEAD OF A NEGATIVE TEST
 * -----------------------------------------------------
 * This table is keyed by EVERY `TaskStatus` and is checked for completeness below, so a
 * status added later cannot silently fall through. The previous version asked "is this
 * status in the in-flight list?" and put everything else into `neverStartedTasks`, which
 * had two real failure modes:
 *
 *   - `rework` was missing from the in-flight list. `TASK_TRANSITIONS` gives
 *     `to_verify -> rework -> queued | failed`, and `review-loop.ts` drives that loop, so
 *     a reworking task is unfinished executable work. Classifying it as "never started"
 *     opened the human gate while a rework was still owed, which is exactly the
 *     premature-open bug this replaces.
 *   - `replanning` was missing for the same reason.
 *
 * An unrecognised status is treated as `in_flight` on purpose: if this code does not
 * understand a state, the safe reading is "work may still be pending", not "nothing
 * happened". Guessing `never_started` would let the gate open on an unknown state.
 */
export type TaskLifecycleClass = 'terminal' | 'in_flight' | 'never_started' | 'blocked' | 'unknown';

export const TASK_LIFECYCLE_CLASS: Readonly<Record<TaskStatus, TaskLifecycleClass>> = Object.freeze({
  // The round's root, and any child the gate refused before dispatch. Never executed.
  planned: 'never_started',
  queued: 'in_flight',
  running: 'in_flight',
  // Waiting on a dependency. Settled for THIS round, but NOT "never started" - it ran.
  blocked: 'blocked',
  // Executed and awaiting the only completion authority.
  to_verify: 'in_flight',
  succeeded: 'terminal',
  failed: 'terminal',
  cancelled: 'terminal',
  // A run that failed with retry budget left; `retrying -> queued | failed`.
  retrying: 'in_flight',
  // P6-D0 un-reserved this and gave it a real loop: `to_verify -> rework -> queued | failed`.
  // It is unfinished executable work, never a task that never started.
  rework: 'in_flight',
  replanning: 'in_flight',
});

/**
 * Classify a task status. Unknown values are reported as `unknown`, never guessed.
 *
 * The caller decides what `unknown` means for the gate; `deriveHumanGate` treats it as
 * blocking, which is the conservative direction.
 */
export function classifyTaskLifecycle(status: TaskStatus | string): TaskLifecycleClass {
  const known = TASK_LIFECYCLE_CLASS[status as TaskStatus];
  return known ?? 'unknown';
}

/**
 * Statuses that mean work is genuinely MID-LIFECYCLE, so the round is not over yet.
 *
 * Derived from `TASK_LIFECYCLE_CLASS` rather than hand-listed, so it cannot drift from
 * the classification that actually drives the gate.
 */
export const IN_FLIGHT_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(
  (Object.keys(TASK_LIFECYCLE_CLASS) as TaskStatus[])
    .filter((s) => TASK_LIFECYCLE_CLASS[s] === 'in_flight'),
);

/** True when this task is a unit of work the round actually tried to execute. */
export function isExecutableTask(task: { depth: number }): boolean {
  return task.depth > 0;
}

/**
 * True when a task in this state means the round has unfinished work.
 *
 * The single definition of "blocking", shared by `machine.unfinished`, the user-facing
 * summary and `deriveHumanGate`, so those three can never disagree about what counts as
 * pending. An unrecognised status blocks, matching `classifyTaskLifecycle`.
 */
export function isBlockingStatus(status: TaskStatus | string): boolean {
  const c = classifyTaskLifecycle(status);
  return c === 'in_flight' || c === 'unknown';
}

/**
 * Every `TaskStatus` must be classified. Checked at MODULE LOAD, not in a test, because
 * the failure this prevents — a new status silently defaulting to "settled" — is exactly
 * the kind of bug a test written alongside the new status would not catch.
 *
 * The thrown message names the offending statuses so the fix is obvious.
 */
const UNCLASSIFIED: readonly TaskStatus[] = (TASK_STATUSES as readonly TaskStatus[])
  .filter((s) => TASK_LIFECYCLE_CLASS[s] === undefined);
if (UNCLASSIFIED.length > 0) {
  throw new Error(
    `round-result: task status(es) not classified in TASK_LIFECYCLE_CLASS: ${UNCLASSIFIED.join(', ')}. ` +
    'Every TaskStatus needs an explicit class, or the human gate can open on a state this ' +
    'code does not understand.',
  );
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
  /**
   * Executable tasks parked in `blocked`.
   *
   * Kept apart from `neverStartedTasks` because a blocked task DID run. Folding the two
   * together would claim a blocked task never executed.
   */
  readonly blockedTasks: readonly { readonly taskId: string; readonly status: TaskStatus; readonly reason: string }[];
  /**
   * Task statuses this report does not recognise.
   *
   * Non-empty means the gate stayed shut on purpose: an unknown state is not evidence
   * that nothing is pending.
   */
  readonly unknownStatusTasks: readonly string[];
  /** Whether a review was required and has not settled. See the REVIEW_STATUSES note. */
  readonly reviewOutstanding: boolean;
  /**
   * A review was requested, settled, and produced no independent judgement
   * (`failed` / `unavailable`). Surfaced as a decision; it never blocks the gate.
   */
  readonly reviewWithoutVerdict: boolean;
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

/**
 * Evidence belonging to ONE attempt, projected from that attempt's own `RunResult`.
 *
 * Every field here is per-attempt by construction, which is the whole point:
 *
 *   - `changedFiles` / `testsRun` come from THAT run's `toolCalls`, so attempt A's list
 *     can never contain files attempt B wrote.
 *   - `transcriptPath` is THAT run's transcript.
 *   - `errorCode` / `errorMessage` are THAT run's error.
 *   - `artifacts` is always empty here, and that is deliberate rather than lossy.
 *     `TaskHandoff.artifacts` is built from `Task.artifacts` — what the TASK declared,
 *     not what a given attempt produced. Attributing a task's declared artifacts to one
 *     specific attempt would be the same class of fabrication as copying attempt B's
 *     files onto attempt A, so those artifacts stay on `TaskSummary.artifacts`, where
 *     they truthfully live.
 */
export interface AttemptEvidenceInput {
  readonly changedFiles: readonly string[];
  readonly testsRun: readonly string[];
  readonly artifacts: readonly { readonly name: string; readonly path: string }[];
  readonly transcriptPath: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

/**
 * @deprecated Renamed to `AttemptEvidenceInput`. Kept as an alias so no caller has to be
 * updated in lockstep, but it now means PER ATTEMPT — the old name invited exactly the
 * task-keyed confusion this type is being corrected for.
 */
export type TaskEvidenceInput = AttemptEvidenceInput;

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
  /**
   * PER-ATTEMPT evidence, keyed by `attemptId` — the id `AttemptStore` actually minted.
   *
   * KEYED BY ATTEMPT, NOT BY TASK. This is the correction for the attribution bug: keyed
   * by `taskId`, a task with attempts A and B had exactly one `RunResult` to give (the
   * latest), so every attempt in the report was handed attempt B's changedFiles,
   * testsRun, artifacts and transcript. A→B handoff made the report claim attempt A wrote
   * agent B's files.
   *
   * A missing entry means that attempt has no evidence to show, and it is reported as
   * empty. It is NEVER filled from a sibling attempt.
   */
  readonly evidence?: Readonly<Record<string, AttemptEvidenceInput>>;
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

const NO_EVIDENCE: AttemptEvidenceInput = Object.freeze({
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
    const records = attemptsByTask.get(t.taskId) ?? [];
    // Review attempts are evidence ABOUT the round, not executions OF the task, so
    // counting them as attempts would overstate how much work was tried.
    const executionAttempts = records.filter((r) => r.kind === 'execution');
    // The task's error is the error of its MOST RECENT execution attempt, which is the one
    // that decided the task's fate. `UnifiedRoundReport.tasks` carries no error field, and
    // picking an arbitrary attempt among several would be a guess; "latest" is the only
    // choice that is both defined and true.
    const latest = executionAttempts.length > 0 ? executionAttempts[executionAttempts.length - 1]! : undefined;
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
      artifacts: t.artifacts.map((a) => ({ name: a.name, path: a.path })),
      errorCode: latest?.errorCode ?? null,
      errorMessage: latest?.errorMessage ?? null,
    };
  });

  // ---- attempt summary ----------------------------------------------------
  const attemptSummaries: AttemptSummary[] = [];
  for (const t of input.tasks) {
    const records = attemptsByTask.get(t.taskId) ?? [];
    const reasons = handoffReasonsByTask.get(t.taskId) ?? [];
    const chain = input.continuation?.agentChain[t.taskId] ?? [];
    for (const [index, r] of records.entries()) {
      const kind = toAttemptKind(r.kind);
      const outcome = toAttemptOutcome(r.outcome);
      // An unrecognised kind/outcome is reported as null rather than dropped: the
      // attempt still happened and hiding it would be a silent gap in the evidence.
      //
      // KEYED BY THIS ATTEMPT'S OWN ID. The previous code looked up `evidence[t.taskId]`,
      // which handed every attempt of a task the single latest run's evidence — so after
      // an A->B handoff, attempt A was reported as having written agent B's files. A
      // missing entry now yields empty evidence for THAT attempt only.
      const own = evidence[r.attemptId] ?? NO_EVIDENCE;
      attemptSummaries.push({
        attemptId: r.attemptId,
        taskId: r.taskId,
        kind: kind ?? 'execution',
        agentId: r.agentId,
        modelId: r.modelId ?? null,
        leaseVersion: r.leaseVersion ?? null,
        sessionId: leaseSessionOf(r),
        outcome: outcome ?? 'error',
        // The attempt's own recorded error wins; the run evidence is only a fallback for a
        // record that declined to state one.
        errorCode: r.errorCode ?? own.errorCode,
        errorMessage: r.errorMessage ?? own.errorMessage,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt ?? null,
        previousAttemptId: r.previousAttemptId ?? null,
        // Run-derived evidence belongs to the execution that produced it. A review
        // attempt did not write files, so it must not inherit an execution's list.
        changedFiles: r.kind === 'execution' ? own.changedFiles : [],
        testsRun: r.kind === 'execution' ? own.testsRun : [],
        // Always empty for an attempt: artifacts are declared by the TASK, not produced by
        // one attempt. They are reported on `TaskSummary.artifacts`.
        artifacts: [],
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
    .filter((t) => isExecutableTask(t) && isBlockingStatus(t.status))
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
  const classOf = (t: TaskSummary): TaskLifecycleClass => classifyTaskLifecycle(t.status);

  // Blocking work comes from the CLASSIFICATION, never from a negative status test.
  const blocking = executable.filter((t) => {
    const c = classOf(t);
    // `unknown` blocks deliberately: an unrecognised state is not evidence of safety.
    return c === 'in_flight' || c === 'unknown';
  });
  const nonTerminalTasks = blocking.map((t) => t.taskId);
  const unknownTasks = blocking.filter((t) => classOf(t) === 'unknown').map((t) => t.taskId);

  // `never_started` is ONLY for a task that never executed. `blocked` is kept separate:
  // a blocked task DID run, so calling it "never started" would be a false account of it.
  const neverStartedTasks = executable
    .filter((t) => classOf(t) === 'never_started')
    .map((t) => ({
      taskId: t.taskId,
      status: t.status,
      reason: 'never dispatched (refused at admission, or not selected this round)',
    }));
  const blockedTasks = executable
    .filter((t) => classOf(t) === 'blocked')
    .map((t) => ({
      taskId: t.taskId,
      status: t.status,
      reason: 'blocked and never resolved; nothing in this bounded round will unblock it',
    }));

  // P2-1: "review requested" is NOT "review pending".
  //
  // `REVIEW_STATUSES` is a CLOSED vocabulary whose every member is a settled outcome —
  // `completed`, `failed`, `unavailable`, `not_requested`. There is no pending/running
  // member today, so the old test `requested && status !== 'completed'` mis-classified
  // `failed` and `unavailable` as still-pending and held the gate shut forever.
  //
  // The correct question is positive: is this status one this code recognises as SETTLED?
  // A status outside the vocabulary is treated as unsettled, so if a `pending` state is
  // ever added it will block the gate automatically without touching this file.
  const reviewSettled = (REVIEW_STATUSES as readonly string[]).includes(input.review.status);
  const reviewOutstanding = input.review.requested && !reviewSettled;
  // Settled, but no independent judgement exists. This is surfaced as a DECISION and
  // never as a blocker: a round whose reviewer failed must still reach the user rather
  // than deadlocking with nobody able to reach it.
  const reviewWithoutVerdict = input.review.requested && input.review.status !== 'completed';

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
      detail: `${nonTerminalTasks.length} task(s) are still mid-lifecycle: ${nonTerminalTasks.join(', ')}` +
        (unknownTasks.length > 0
          ? ` (${unknownTasks.join(', ')} are in a status this report does not recognise, so they are treated as unfinished on purpose)`
          : ''),
    });
  }
  if (neverStartedTasks.length > 0) {
    decisions.push({
      id: 'never-started',
      label: 'Decide about the tasks that never ran',
      detail: `${neverStartedTasks.length} task(s) never started: ` +
        `${neverStartedTasks.map((t) => `${t.taskId} (${t.status})`).join(', ')}. ` +
        'Nothing was retried or reassigned to cover them.',
    });
  }
  if (blockedTasks.length > 0) {
    decisions.push({
      id: 'blocked-tasks',
      label: 'Decide about the blocked tasks',
      detail: `${blockedTasks.length} task(s) are blocked: ` +
        `${blockedTasks.map((t) => `${t.taskId} (${t.status})`).join(', ')}. ` +
        'These DID run; they are not waiting on anything this bounded round will resolve.',
    });
  }
  if (reviewOutstanding) {
    decisions.push({
      id: 'await-review',
      label: 'Decide about the missing review',
      detail: `the review was requested and its status is "${input.review.status}", which is not a ` +
        `settled outcome: ${input.review.reason ?? 'no reason given'}`,
    });
  } else if (reviewWithoutVerdict) {
    // Settled but no judgement. A decision, never a blocker.
    decisions.push({
      id: 'review-unavailable',
      label: 'Decide about the missing independent review',
      detail: `the review was requested and settled as "${input.review.status}"` +
        `${input.review.reason === null ? '' : ` (${input.review.reason})`}. ` +
        'The round is finished and the execution evidence stands on its own, but no ' +
        'independent judgement of it exists.',
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
      ? `the review was requested and has not settled (status "${input.review.status}")`
      : `${nonTerminalTasks.length} executable task(s) are still mid-lifecycle: ${nonTerminalTasks.join(', ')}`;
  } else {
    status = 'waiting_for_user';
    // Says "settled", not "passed": a failed or unavailable review is settled, and this
    // round still needs a human. Wording it as "verified" would overstate what happened.
    reason = `all ${executable.length} executable task(s) settled and the review has settled; ` +
      'the orchestrator has stopped and control is the user\'s';
  }

  return {
    status,
    reason,
    roundComplete,
    nonTerminalTasks,
    neverStartedTasks,
    blockedTasks,
    /** Task statuses this report does not recognise. Non-empty means the gate stayed shut. */
    unknownStatusTasks: unknownTasks,
    reviewOutstanding,
    /** Requested, settled, and produced no independent judgement. A decision, not a blocker. */
    reviewWithoutVerdict,
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
  for (const n of result.gate.blockedTasks) {
    lines.push(`- blocked: ${n.taskId} (${n.status}) — ${n.reason}`);
  }
  if (result.gate.unknownStatusTasks.length > 0) {
    lines.push(`- unrecognised status (gate held shut on purpose): ${result.gate.unknownStatusTasks.join(', ')}`);
  }
  if (result.gate.reviewOutstanding) lines.push('- the requested review has not settled');
  if (result.gate.reviewWithoutVerdict) {
    lines.push('- the review settled without a verdict; the execution evidence stands on its own');
  }
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
  const notFinished = tasks.filter((t) => isExecutableTask(t) && isBlockingStatus(t.status));
  if (notFinished.length > 0) {
    userFacing.push('Not finished: ' + notFinished.map((t) => `${t.taskId} (${t.status})`).join(', '));
  }
  userFacing.push(`Next: the round is at the human gate (${gate.status}). ` +
    'Decide whether to start another round; nothing will run without you.');

  return { headline, userFacing };
}
