/**
 * src/orchestration/workbench.ts - the Native Agent Workbench coordinator.
 *
 * WHAT THIS IS
 * ------------
 * The thin layer that turns the pieces P6 built into the product model:
 *
 *   user task - Laya/planner - Task tree - Assignment (Agent×Model)
 *     - Session registry - TaskScheduler.tick - Native Agent runtime
 *     - RunResult - evidence - handoff - review
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not an authority. Every write it performs goes through an existing one:
 *   task state   - TaskStore        (via spawnChild/commitPlan/applyVerification)
 *   dispatch     - TaskScheduler.tick()
 *   execution    - the ONE runtime execution edge inside executeTask
 *   verification - applyVerification()
 *   evidence     - AttemptStore
 *   identity     - the assignment engine + TaskStore.assignIdentity
 *   sessions     - SessionRegistry (bookkeeping, never execution)
 *
 * If a method here looks like it "does" something, read it: it composes calls the
 * caller could have made, in the order the architecture requires, and records what
 * happened. That is a workbench, not a second brain.
 */

import type { ModelRegistry } from '../quota/registry.ts';
import type { QuotaRecord } from '../quota/types.ts';
import type { TaskType } from '../quota/types.ts';
import type { RunResult, SelectionSpec } from '../core/types.ts';
import { resolveSelection, fixedPairOf } from '../core/types.ts';
import { log } from '../core/log.ts';
import type { TaskClassification } from '../decision/routing.ts';
// TeamRun T2-a.1: the INITIAL Agent x Model decision. This is a preset over the existing
// Decision Layer (exactly like routing.ts is a preset for classification) — it adds no
// provider and no second brain.
import {
  decideInitialAssignment,
  type InitialAssignmentCandidate,
} from '../decision/initial-assignment.ts';
import type { DecisionProvider } from '../decision/types.ts';
import { Orchestrator, type SpawnChildRequest } from './orchestrator.ts';
import { TaskScheduler, type TickResult } from './scheduler.ts';
import { buildDispatchReceipt, emptyDispatchReceipt, type DispatchExecutionRef, type DispatchReceipt } from './dispatch-receipt.ts';
import type { TickScope } from './scheduler.ts';
import type { Task } from './task.ts';
import type { TaskStore } from './store.ts';
import { AttemptStore } from './attempt-store.ts';
import { recordExecutions, recordExecution, recordReview } from './attempt-integration.ts';
import { applyReviewVerdict, prepareRework, DEFAULT_REWORK_POLICY, type ReworkPolicy, type ReviewOutcome } from './review-loop.ts';
import type { DecisionApplicationContext } from './decision.ts';
import type { ReviewEvidence, ReviewVerdict } from './review-verdict.ts';
import { assignWorker, validateAgentModelIntent, type AgentModelIntent, type AssignmentOutcome } from './assignment.ts';
import {
  SessionRegistry,
  SessionRegistryError,
  sessionCompatibleWith,
  toExecutionTarget,
  DEFAULT_SESSION_INTENT,
  type SessionIntent,
  type WorkbenchSession,
} from './workbench-sessions.ts';
import { buildHandoff, buildTaskBrief, type TaskHandoff } from './workbench-handoff.ts';
// R4: the per-attempt evidence SHAPE only. Imported as a type so this file gains no runtime
// dependency on the report layer, and so the direction stays one-way (report <- workbench).
import type { AttemptEvidenceInput } from './round-result.ts';
import { commitPlan, replanSubtree } from './planner-wiring.ts';
import { planTasks, type CandidateTask } from './planner.ts';
import { planFromSpec, type WorkbenchTaskSpec, type PlanFromSpecResult } from './workbench-plan.ts';
// TeamRun T3-a.1: the READ-only fan-out topology validation + grouping evidence. Pure value
// helpers; the materialization below still goes through the SAME `commitPlan` write path.
import {
  validateFanoutMembers,
  FANOUT_MEMBER_TASK_TYPE,
  FANOUT_MAX_MEMBERS,
  type FanoutProvenance,
} from './fanout.ts';

/**
 * TeamRun T1-d: the frozen facts of ONE real execution, taken at the dispatch
 * boundary.
 *
 *   > Once an execution is dispatched, its identity facts are no longer derived
 *   > from the current Task, the current Assignment or the current session binding.
 *
 * A reassignment or a rework may move the task while a run is still in flight; the
 * run's Attempt must still describe the worker it was DISPATCHED to. Every field
 * here is somebody else's authoritative fact, snapshotted — never re-derived at
 * record time:
 *
 *   taskId       the dispatch itself
 *   agentId      the `RunRequestMapping` the execution edge built (dispatch-time)
 *   modelId      the same mapping (dispatch-time)
 *   sessionId    the SessionRegistry binding as it stood when this dispatch began
 *   leaseVersion the lease the execution held (already on `ExecuteOutcome`)
 *
 * This is an immutable VALUE, not an authority: it owns no lifecycle, no dispatch,
 * no retry, no session and no worker. Assignment stays the pair authority,
 * SessionRegistry the session authority, AttemptStore the evidence authority,
 * TaskStore the task authority.
 */
export interface DispatchExecutionFacts {
  readonly taskId: string;
  readonly agentId: string;
  readonly modelId: string | null;
  /** The dispatch-time session; absent when no compatible session was bound. */
  readonly sessionId?: string;
  readonly leaseVersion?: number;
}

/**
 * Fallback agent id for a spec root that names no `preferredAgent`.
 *
 * See `WorkbenchOptions.rootAgentId` for why this exists and why the root's agent id
 * is not merely cosmetic.
 */
export const DEFAULT_ROOT_AGENT_ID = 'opencode';

export interface WorkbenchOptions {
  /** The orchestration orchestrator (task lifecycle + execution edge). */
  readonly orchestrator: Orchestrator;
  /** The one dispatch authority. */
  readonly scheduler: TaskScheduler;
  /** The registry assignment reads. The ONLY identity source. */
  readonly registry: ModelRegistry;
  /** Real quota observations, resolved through the existing gate resolver. */
  readonly quotaRecords?: readonly QuotaRecord[];
  /** The one evidence authority. Created here when not supplied. */
  readonly evidence?: AttemptStore;
  readonly sessions?: SessionRegistry;
  /**
   * TeamRun T2-a.1: the Laya decision provider consulted for each task's INITIAL
   * Agent × Model choice.
   *
   * When supplied, this workbench's production initial path is Laya-controlled: every
   * child must have a real, validated decision (or an explicit refusal) before Assignment
   * is allowed to run. When absent, this workbench keeps the legacy behaviour exactly —
   * spec/intent pair, else preferences, else Assignment scoring — which is what a
   * low-level or compatibility caller wants.
   *
   * The distinction is deliberate and load-bearing: a caller-supplied
   * `WorkbenchTaskSpec.explicitPair` is a MANUAL entry point, not a semantic decision,
   * and the two must never be described as the same authority.
   */
  readonly decisionProvider?: DecisionProvider;
  /**
   * The clock this workbench stamps lifecycle facts with: session opens, session run
   * records, receipt timestamps, and lease renewal.
   *
   * R2-2 (P2): these used to call `Date.now()` inline. A lease's deadline is minted from
   * its issuer's clock and judged by its reader's, so a workbench that issued on
   * `Date.now()` while the orchestrator read an injected clock could renew or judge a
   * lease against a different "now" than the one that created it. One injected clock,
   * used for every fact this workbench writes, removes that class of mismatch without
   * introducing a clock service.
   */
  readonly now?: () => number;
  /** Working directory children run in (worktree isolation, when configured). */
  readonly cwd: string;
  /** Honour P6-F's free pool. Off by default, mirroring the gate. */
  readonly enforceFreeModelPool?: boolean;
  readonly reworkPolicy?: ReworkPolicy;
  /**
   * Agent id stamped on a spec's ROOT when the spec names no `preferredAgent`.
   *
   * The root is never dispatched (children are what runs), but its `agentId` is not
   * invisible: `observeTasks` projects `agentId` for every task, so whatever lands
   * here is a fact Laya reads when deciding. A silent literal would therefore be a
   * fabricated claim about who owns the request.
   *
   * `Task.agentId` is required, so a value must be chosen; making it explicit and
   * injectable is what keeps it honest. Changing the DEFAULT to "no agent" would
   * mean making `Task.agentId` optional - a core type change reaching Assignment and
   * the scheduler, i.e. far beyond making this parameter explicit.
   */
  readonly rootAgentId?: string;
  /**
   * B1.4: the PROJECT default Agent × Model selection. A per-task selection on the
   * spec overrides it; when neither is set the existing auto behaviour applies.
   */
  readonly projectSelection?: SelectionSpec;
}

export interface PlanOutcome {
  readonly root: Task;
  readonly planned: PlanFromSpecResult;
  /** Children that exist in the store after the plan was committed. */
  readonly children: readonly Task[];
}

/**
 * TeamRun T2-a.1: what Laya decided (or refused) for one task's INITIAL Agent × Model.
 *
 * Recorded so the provenance of a pair is observable: `decided` means a real provider call
 * produced it, `refused` means the provider could not deliver a usable pair and the task is
 * therefore NOT assigned. Neither is ever confused with a spec-supplied pair.
 */
export type InitialSelectionOutcome =
  | {
      readonly taskId: string;
      readonly ok: true;
      readonly intent: AgentModelIntent;
      /** Which provider answered, for the audit trail. */
      readonly provider: string;
    }
  | {
      readonly taskId: string;
      readonly ok: false;
      readonly reason: string;
      readonly provider: string;
    };

export interface AssignOutcome {
  readonly taskId: string;
  readonly ok: boolean;
  readonly code?: string;
  readonly reason?: string;
  readonly outcome?: AssignmentOutcome;
  /**
   * The session this task was bound to, or the reason it got none.
   *
   * Present because `SessionRegistry.open` THROWS on identity mismatch. Letting that
   * escape would abort an entire `assignChildren` loop - one bad reuse intent would
   * stop unrelated siblings from being assigned, and the caller would learn nothing
   * about which task caused it. So the refusal is caught here and reported per task,
   * and the task is simply left unassigned: no session, no identity, and the
   * scheduler will not pick it up. Failing closed per task beats failing the batch.
   */
  readonly session?: {
    readonly sessionId: string;
    readonly reused: boolean;
  };
  readonly sessionError?: { readonly code: string; readonly reason: string };
}

/**
 * Laya's intent for ONE task: skills it wants, whether it continues earlier work,
 * and which worker it prefers. All three are requests; none is resolved here.
 */
export interface TaskIntent {
  readonly skills?: readonly string[];
  readonly sessionIntent?: SessionIntent;
  readonly preferredAgent?: string;
  readonly preferredModel?: string;
  /**
   * TeamRun T2-a: Laya's EXPLICIT Agent × Model choice for this task, when it made
   * one. Presence changes Assignment's role from "rank candidates, honour the
   * preference if it survives" to "enforce exactly this pair, accept or refuse".
   * Absence is the legitimate legacy path. See `AgentModelIntent` for the atomicity
   * and validation contract.
   */
  readonly explicitPair?: AgentModelIntent;
}

export interface DispatchOutcome {
  readonly tick: TickResult | null;
  readonly evidenceRecorded: readonly string[];
  readonly evidenceDegraded: boolean;
  /** Sessions that observed a completed run this dispatch. */
  readonly sessionsTouched: readonly string[];
  /** R2-2 section13.2: the attempt ids this dispatch actually produced, per task. */
  readonly attemptIdsByTask: Readonly<Record<string, readonly string[]>>;
  /**
   * T3-a.5: this dispatch's `{attemptId, run}` pairs, per task, bound at the AttemptStore
   * append that minted the id from the run that built the record.
   *
   * This is what lets a caller answer "what was the CURRENT attempt's result" without a
   * task-keyed latest-ever lookup, which cannot tell attempt B's result from attempt A's.
   * It is a correlation over facts already recorded, not a result store and not an authority.
   */
  readonly executionsByTask: Readonly<Record<string, readonly DispatchExecutionRef[]>>;
  /**
   * R2-2 (P1-1): tasks whose still-running lease this dispatch renewed.
   *
   * Reported rather than silently applied, because a bounded renewal budget is a
   * designed outcome: once it is spent, further runs are refused as expired and the
   * caller may want to know that rather than discover it as a stuck task.
   */
  readonly renewedLeases: readonly string[];
}

/**
 * The Workbench. Construct it over the authorities you already have; it adds
 * planning, preference-aware assignment, session bookkeeping, evidence wiring,
 * bounded review and structured handoffs - and nothing else.
 */
/** What a caller may configure about the D1 decision wiring. Currently one thing. */
export interface DecisionWiringOptions {
  /**
   * P6-D1 `retry` capability, including the bound.
   *
   * Supplied rather than defaulted because the attempt limit is a POLICY decision, and
   * a workbench that quietly picked "3" would make an unbounded loop look deliberate.
   */
  readonly retry?: NonNullable<DecisionApplicationContext['retry']>;
}

/**
 * Every capability a decision cycle may reach. Derived from
 * `DecisionApplicationContext` so adding an action to the decision layer makes this
 * type fail to compile until its capability exists - the same compile-time coupling
 * the planner's `ACTION_CRITERIA` uses.
 */
export type DecisionCapabilities = Omit<DecisionApplicationContext, 'dispatch' | 'observation'> & {
  /**
   * The ONE dispatch path. Returns the admission RECEIPT (section5.4), never a boolean:
   * a boolean would silently drop which tasks ran, which attempt ids they produced,
   * and what was skipped.
   */
  dispatch: () => Promise<DispatchReceipt>;
};

export class NativeWorkbench {
  readonly store: TaskStore;
  readonly evidence: AttemptStore;
  readonly sessions: SessionRegistry;

  readonly orchestrator: Orchestrator;
  private readonly scheduler: TaskScheduler;
  private readonly registry: ModelRegistry;
  /**
   * TeamRun T2-a.1: the Laya provider for INITIAL Agent x Model selection, when this
   * workbench is on the production Laya-controlled path.
   */
  private readonly decisionProvider: DecisionProvider | null;
  /**
   * TeamRun T2-a.1: one record per child that went through initial selection — including
   * the ones that FAILED.
   *
   * Failures are recorded rather than dropped, because the alternative is the defect this
   * round exists to close: a Laya decision that goes wrong would be silently forgotten and
   * Assignment's scoring would pick instead, which would make the outcome look like Laya's
   * judgement when it was a heuristic's.
   */
  private readonly initialSelections = new Map<string, InitialSelectionOutcome>();
  /**
   * TeamRun T3-a.1: grouping evidence for PARALLEL_READ fan-outs, keyed by the container
   * taskId. Pure data — never consulted to admit, dispatch or decide.
   */
  private readonly fanoutGroups = new Map<string, FanoutProvenance>();
  private readonly quotaRecords: readonly QuotaRecord[];
  private readonly cwd: string;
  private readonly enforceFreeModelPool: boolean;
  private readonly reworkPolicy: ReworkPolicy;
  /**
   * Tasks this workbench itself re-entered via `prepareRework`. This is the
   * AUTHORITY'S OWN knowledge of "this run is a rework re-entry" - exactly the
   * source `attempt-integration.ts` requires - and the only alternative
   * (inferring it from `retryCount > 0`) would be a second, worse source for the
   * same fact. Consumed by the next dispatch.
   */
  private readonly pendingReworks = new Set<string>();
  /** Latest real RunResult per task - the raw material for handoff briefs. */
  private readonly lastResults = new Map<string, RunResult>();
  /**
   * R4: PER-ATTEMPT evidence, keyed by the `attemptId` `AttemptStore` actually minted.
   *
   * WHY THIS EXISTS ALONGSIDE `lastResults`
   * ---------------------------------------
   * `lastResults` keeps ONE run per task — the latest — because that is what a brief for a
   * dependant needs. That makes it useless for reporting a task's attempt history: with
   * attempts A and B, it holds only B, so any report keyed by taskId showed A writing B's
   * files.
   *
   * This map is filled at the only moment both facts are in hand: inside `dispatch()`,
   * pairing each tick outcome's real `RunResult` with the attempt id `recordExecutions`
   * minted for THAT outcome. Nothing is guessed and nothing is re-derived later, so
   * attempt A keeps attempt A's evidence even after attempt B overwrites `lastResults`.
   *
   * It is a per-round, in-memory projection — the same kind of view as `lastResults` — not
   * a store, not an authority, and it is never persisted. Attempt evidence remains owned
   * by `AttemptStore`; this only remembers which run belonged to which attempt id.
   */
  private readonly attemptEvidence = new Map<string, AttemptEvidenceInput>();
  /**
   * Laya's per-task intent, projected from the plan that created each task.
   *
   * Deliberately NOT on `Task`: see `setTaskIntent` for why dispatch hints must not
   * become task state. Entries are pruned once a task is terminal, since an intent
   * for finished work can never apply again.
   */
  private readonly taskIntents = new Map<string, TaskIntent>();
  /** R2-2: the most recent tick, so
unDecisionCycle can read a real TickResult. */
  private lastDispatchTick: TickResult | null = null;
  /** Explicit root agent id; see `WorkbenchOptions.rootAgentId`. */
  private readonly rootAgentId: string;
  /** The single clock for every fact this workbench writes. See `WorkbenchOptions.now`. */
  private readonly nowFn: () => number;
  /**
   * B1.4: the PROJECT default Agent × Model selection (task overrides it). Absent =
   * no project default. Read-only for the life of this workbench.
   */
  private readonly projectSelection: SelectionSpec | undefined;
  /**
   * B1.4: tasks whose pair was pinned by a USER selection (project or task). Used by
   * `reassignTask` to refuse an automatic handoff that would silently swap a pinned
   * pair. This is a lock record, NOT a new scheduling authority.
   */
  private readonly fixedSelections = new Map<string, AgentModelIntent>();
  /**
   * B1.4a: the EFFECTIVE selection resolved for each ROOT task (task > project > auto).
   *
   * The per-task `fixedSelections` lock only covers tasks that existed at assignment
   * time. A task created LATER (via `addTask`, `replan`/`split`/`parallelize`) inherits
   * the parent's agentId/modelId but no lock — which is exactly how a fixed pair was
   * silently switched by a later reassign. Recording the ROOT's effective selection
   * lets `fixedLockFor` derive the lock for ANY task under that root, so the constraint
   * survives every creation path without touching them. An `auto` root records `auto`,
   * so a Laya-chosen pair is never mistaken for a user-fixed one.
   */
  private readonly rootSelections = new Map<string, SelectionSpec>();

  constructor(options: WorkbenchOptions) {
    this.orchestrator = options.orchestrator;
    this.scheduler = options.scheduler;
    this.registry = options.registry;
    this.quotaRecords = options.quotaRecords ?? [];
    this.cwd = options.cwd;
    this.enforceFreeModelPool = options.enforceFreeModelPool ?? false;
    this.reworkPolicy = options.reworkPolicy ?? DEFAULT_REWORK_POLICY;
    this.store = this.orchestrator.getStore();
    this.evidence = options.evidence ?? new AttemptStore();
    this.sessions = options.sessions ?? new SessionRegistry();
    this.decisionProvider = options.decisionProvider ?? null;
    this.rootAgentId = options.rootAgentId ?? DEFAULT_ROOT_AGENT_ID;
    this.nowFn = options.now ?? Date.now;
    this.projectSelection = options.projectSelection;
  }

  /**
   * The single place the root's fallback agent id is defined.
   *
   * Deliberately a real, registered agent: a sentinel would be an identity that does
   * not exist, which is a worse lie than naming the default worker. Resolution order
   * is spec preference - this - the named constant, so the spec always wins.
   */
  private rootAgentIdFor(spec: WorkbenchTaskSpec): string {
    return spec.preferredAgent ?? this.rootAgentId;
  }

  // ------------------------------------------------------------------ planning

  /**
   * Create the root for a spec and commit its plan. The root is the request's
   * entry point and is never dispatched; children are what actually runs.
   */
  plan(spec: WorkbenchTaskSpec, classification?: TaskClassification | null): PlanOutcome {
    // Resolved once: the root and the commitPlan seed must agree, or the store would
    // hold a root whose agentId differs from the identity its children were planned
    // under.
    const rootAgentId = this.rootAgentIdFor(spec);
    const created = this.orchestrator.createRoot({
      taskId: spec.taskId,
      agentId: rootAgentId,
      taskType: spec.taskType ?? 'implementation',
      acceptanceCriteria: spec.objective,
    });
    if (!created.ok) {
      throw new Error(`workbench could not create root "${spec.taskId}": ${created.code} ${created.reason}`);
    }
    const planned = planFromSpec(spec, { classification: classification ?? null, now: Date.now() });
    // commitPlan is P6-C's single write path; the root must exist for it.
    const committed = commitPlan(this.store, planned.plan.candidates, {
      agentId: rootAgentId,
      modelId: spec.preferredModel ?? null,
      budgetUnits: spec.budgetUnits,
      generation: 0,
    });
    if (!committed.ok) {
      throw new Error(`workbench could not commit plan: ${committed.code} ${committed.reason}`);
    }
    // Record Laya's intent per child, straight from the committed candidates. This is
    // a projection of the plan that just created them, so it cannot disagree with it:
    // the per-candidate skills and preference ARE what the planner decided. The spec
    // remains the default, applied here once rather than re-derived on every
    // assignment.
    for (const task of committed.created) {
      const fromPlan = planned.plan.candidates.find((c) => c.taskId === task.taskId);
      this.taskIntents.set(task.taskId, {
        ...(fromPlan?.skills !== undefined ? { skills: fromPlan.skills } : {}),
        ...(fromPlan?.preferredAgent !== undefined ? { preferredAgent: fromPlan.preferredAgent } : {}),
        ...(fromPlan?.preferredModel !== undefined ? { preferredModel: fromPlan.preferredModel } : {}),
        ...(planned.plan.sessionIntent !== undefined ? { sessionIntent: planned.plan.sessionIntent } : {}),
      });
    }
    return { root: created.task, planned, children: committed.created };
  }

  /**
   * B4.0: commit a caller-supplied candidate set (e.g. a bounded workflow plan) instead
   * of a shape-expanded one.
   *
   * Same write path as `plan()` — create the root, `commitPlan`, record the per-candidate
   * intent — so a workflow plan is validated and committed by the EXISTING authorities
   * and cannot diverge from a shape plan. The root is created here (the candidates hang
   * from `spec.taskId`).
   */
  planWithCandidates(spec: WorkbenchTaskSpec, candidates: readonly CandidateTask[], notes: readonly string[] = []): PlanOutcome {
    const rootAgentId = this.rootAgentIdFor(spec);
    const created = this.orchestrator.createRoot({
      taskId: spec.taskId,
      agentId: rootAgentId,
      taskType: spec.taskType ?? 'implementation',
      acceptanceCriteria: spec.objective,
    });
    if (!created.ok) {
      throw new Error(`workbench could not create root "${spec.taskId}": ${created.code} ${created.reason}`);
    }
    const committed = commitPlan(this.store, candidates, {
      agentId: rootAgentId,
      modelId: spec.preferredModel ?? null,
      budgetUnits: spec.budgetUnits,
      generation: 0,
    });
    if (!committed.ok) {
      throw new Error(`workbench could not commit workflow plan: ${committed.code} ${committed.reason}`);
    }
    for (const task of committed.created) {
      const fromPlan = candidates.find((c) => c.taskId === task.taskId);
      this.taskIntents.set(task.taskId, {
        ...(fromPlan?.skills !== undefined ? { skills: fromPlan.skills } : {}),
        ...(fromPlan?.preferredAgent !== undefined ? { preferredAgent: fromPlan.preferredAgent } : {}),
        ...(fromPlan?.preferredModel !== undefined ? { preferredModel: fromPlan.preferredModel } : {}),
      });
    }
    const planned: PlanFromSpecResult = {
      taskType: spec.taskType ?? 'implementation',
      shape: 'chain',
      classificationReason: null,
      plan: { candidates: [...candidates], notes: [...notes], generation: 0 },
    };
    return { root: created.task, planned, children: committed.created };
  }

  // ---------------------------------------------------------------- assignment

  /**
   * Assign workers to every non-terminal child of a root, honouring the spec's
   * preference. `assignIdentity` refuses anything that already started, so this
   * is safe to call repeatedly between ticks.
   */
  /**
   * TeamRun T2-a.1: ask Laya which Agent × Model each unassigned child should use.
   *
   * This is the REAL production initial-selection step, and it runs BEFORE any assignment.
   * It is deliberately NOT `reassign`: an initial assignment has no previous worker to move
   * from, and faking one (or manufacturing an attempt to trip the post-result loop) would
   * both misrepresent the decision and require a fake execution to reach it.
   *
   * Candidates come from the SAME registry projection Assignment filters on, including
   * T1-a effective availability, so Laya is never offered a pair the system already knows
   * is dead. No scoring is copied in: Laya chooses, Assignment enforces.
   *
   * Every child gets a record — including refusals — so `assignChildren` can fail a task
   * closed rather than quietly falling back to scoring.
   */
  async selectInitialAssignment(rootTaskId: string, taskSelection?: SelectionSpec): Promise<readonly InitialSelectionOutcome[]> {
    // B1.4: task overrides project, else auto. A FIXED selection is recorded as the
    // task's decision and Laya is NOT asked — the user's choice must never be re-decided.
    const selection = resolveSelection(taskSelection, this.projectSelection);
    // B1.4a: record the ROOT's effective selection so a task created later under this
    // root still derives the fixed lock (or the absence of one for `auto`).
    this.rootSelections.set(rootTaskId, selection);
    const fixed = fixedPairOf(selection);
    const provider = this.decisionProvider;
    const outcomes: InitialSelectionOutcome[] = [];
    for (const child of this.store.children(rootTaskId)) {
      if (child.status === 'succeeded' || child.status === 'failed' || child.status === 'cancelled') continue;
      // T3-a.1: a child that ALREADY has a recorded Laya decision (a fan-out member whose
      // pair came from the topology decision) is not asked again — re-asking would override
      // Laya's own earlier choice. SOLO children have no record and behave exactly as before.
      const recorded = this.initialSelections.get(child.taskId);
      if (recorded !== undefined) { outcomes.push(recorded); continue; }
      // B1.4: a USER-fixed pair is the decision. Validate it atomically (a partial pair
      // is refused, never completed) and record it with a distinct provenance so the
      // output can tell "the user pinned this" apart from "Laya chose this".
      if (fixed !== undefined) {
        const checked = validateAgentModelIntent(fixed);
        const outcome: InitialSelectionOutcome = checked.ok
          ? { taskId: child.taskId, ok: true, intent: checked.intent, provider: 'user-fixed' }
          : {
              taskId: child.taskId,
              ok: false,
              reason: `the fixed Agent x Model selection is invalid: ${checked.reason}`,
              provider: 'user-fixed',
            };
        if (checked.ok) this.fixedSelections.set(child.taskId, checked.intent);
        this.initialSelections.set(child.taskId, outcome);
        outcomes.push(outcome);
        continue;
      }
      if (provider === null) continue;
      const candidates: InitialAssignmentCandidate[] = this.registry.list().map((e) => ({
        agentId: e.agentId,
        modelId: e.modelId ?? '',
        available: this.registry.isModelAvailable(e.agentId, e.modelId ?? ''),
        taskTypes: [...e.taskTypes],
      })).filter((c) => c.modelId !== '' && c.taskTypes.includes(child.taskType));
      let outcome: InitialSelectionOutcome;
      try {
        if (candidates.length === 0) {
          throw new Error(`no registered ${child.taskType} pair is available to choose from`);
        }
        const raw = await decideInitialAssignment(provider, {
          task: {
            taskId: child.taskId,
            // `Task` carries acceptance criteria, not a separate objective; that IS the
            // task's own description of what success means, so it is what Laya reads.
            objective: child.acceptanceCriteria,
            taskType: child.taskType,
            acceptanceCriteria: child.acceptanceCriteria,
          },
          candidates,
        });
        // The typed pair check is the orchestration side's, so there is exactly one
        // definition of a valid pair. A partial or malformed pair is refused here.
        const checked = validateAgentModelIntent(raw);
        if (!checked.ok) throw new Error(checked.reason);
        outcome = { taskId: child.taskId, ok: true, intent: checked.intent, provider: provider.name };
      } catch (e) {
        // FAIL CLOSED. The decision being unavailable is not permission to let a heuristic
        // answer instead; `assignChildren` will refuse this task.
        outcome = {
          taskId: child.taskId,
          ok: false,
          reason: `Laya did not produce a usable initial Agent x Model pair: ${(e as Error).message}`,
          provider: provider.name,
        };
      }
      this.initialSelections.set(child.taskId, outcome);
      outcomes.push(outcome);
    }
    return outcomes;
  }

  /** TeamRun T2-a.1: what Laya decided for each task, refusals included. */
  initialSelectionRecords(): readonly InitialSelectionOutcome[] {
    return [...this.initialSelections.values()];
  }

  /**
   * TeamRun T3-a.1: materialize a Laya-chosen PARALLEL_READ topology.
   *
   * The container task executes NOTHING; this replaces its not-yet-started children with N
   * independent READ member Tasks. Each member is a distinct taskId, so it gets its own
   * lease, session, attempt and WorkerIdentity through the EXISTING machinery — that is why
   * child tasks are the representation and not N executions of one taskId.
   *
   * The member pairs Laya named are recorded as their `initialSelections`, which
   * `assignChildren` enforces EXACTLY (an unavailable pair is refused, never substituted).
   *
   * Fail-closed: a malformed or non-READ member list refuses the WHOLE topology and touches
   * nothing. ResourceClaim would happily let read+write share, so the READ gate cannot be
   * left to the resource layer — it is enforced here, before any task exists.
   */
  materializeReadFanout(
    rootTaskId: string,
    rawMembers: unknown,
  ): { ok: true; provenance: FanoutProvenance } | { ok: false; code: string; reason: string } {
    const root = this.store.get(rootTaskId);
    if (root === null) return { ok: false, code: 'task-not-found', reason: `no task "${rootTaskId}"` };

    const validated = validateFanoutMembers(rawMembers, FANOUT_MAX_MEMBERS);
    if (!validated.ok) return { ok: false, code: validated.code, reason: validated.reason };

    // Remove the container's never-admitted children (the SOLO child the planner produced).
    // `removePlanned` refuses anything already admitted, so this cannot delete started work.
    const { replaceable } = this.store.partitionForReplan(rootTaskId);
    for (const child of replaceable) this.store.removePlanned(child.taskId);

    const generation = this.store.latestGeneration();
    const candidates = validated.members.map((m, index) => ({
      taskId: `${rootTaskId}-fr${index + 1}`,
      parentTaskId: rootTaskId,
      taskType: FANOUT_MEMBER_TASK_TYPE,
      // The member's bounded scope IS its acceptance criteria — what success means.
      description: m.scope,
      dependencies: [] as string[],
      requiredTaskTypes: [FANOUT_MEMBER_TASK_TYPE],
    }));
    const committed = commitPlan(this.store, candidates, {
      agentId: root.agentId,
      modelId: root.modelId,
      budgetUnits: root.budgetUnits,
      generation,
    });
    if (!committed.ok) return { ok: false, code: committed.code, reason: committed.reason };

    const members = committed.created.map((task, index) => {
      const spec = validated.members[index]!;
      // Record Laya's pair as this member's decision, so Assignment enforces it exactly and
      // `selectInitialAssignment` does not ask a second time.
      this.initialSelections.set(task.taskId, {
        taskId: task.taskId,
        ok: true,
        intent: { agentId: spec.agentId, modelId: spec.modelId },
        provider: 'execution-topology',
      });
      return {
        taskId: task.taskId,
        memberIndex: index,
        agentId: spec.agentId,
        modelId: spec.modelId,
        scope: spec.scope,
        accessMode: spec.accessMode,
      };
    });
    const provenance: FanoutProvenance = Object.freeze({
      sourceTaskId: rootTaskId,
      topology: 'parallel_read',
      members: Object.freeze(members),
    });
    this.fanoutGroups.set(rootTaskId, provenance);
    return { ok: true, provenance };
  }

  /** TeamRun T3-a.1: the recorded fan-out groupings (pure evidence). */
  fanoutProvenance(): readonly FanoutProvenance[] {
    return [...this.fanoutGroups.values()];
  }


  assignChildren(rootTaskId: string, spec: WorkbenchTaskSpec): readonly AssignOutcome[] {
    const outcomes: AssignOutcome[] = [];
    // B1.4: task selection overrides the project default, else auto. A FIXED pair is
    // authoritative: it is enforced exactly and never overridden by Laya or a preference.
    const selection = resolveSelection(spec.selection, this.projectSelection);
    // B1.4a: record the ROOT's effective selection (covers a caller that never called
    // `selectInitialAssignment`), so later-created tasks derive the right lock.
    this.rootSelections.set(rootTaskId, selection);
    const fixed = fixedPairOf(selection);
    for (const child of this.store.children(rootTaskId)) {
      if (child.status === 'succeeded' || child.status === 'failed' || child.status === 'cancelled') continue;
      // Per-task intent beats the spec default; the spec is only the fallback.
      // Both are Laya's words, so this is precedence, not a new decision.
      const intent = this.taskIntents.get(child.taskId);
      const preferredAgent = intent?.preferredAgent ?? spec.preferredAgent;
      const preferredModel = intent?.preferredModel ?? spec.preferredModel;
      // TeamRun T2-a: an EXPLICIT pair (intent first, spec fallback) is enforced
      // exactly — Assignment restricts to it and accepts or refuses, never
      // substitutes. Absence keeps the legacy preference/scoring path byte-identical.
      // A malformed/partial pair fails closed here (the assignment is refused with
      // `assignment-invalid`), never demoted to legacy scoring (§18).
      // TeamRun T2-a.1: a Laya decision for the INITIAL pair is the authority, ahead of
      // any per-task intent and ahead of the spec. A REFUSED decision fails the task closed
      // here — it must never fall through to preferences or scoring, because that is
      // exactly how a heuristic's choice gets reported as Laya's judgement.
      //
      // B1.4: when the USER pinned a fixed pair, none of those Laya-authority checks
      // apply — Laya is not the decider for this task and must not override the user.
      const layaSelection = this.initialSelections.get(child.taskId);
      if (fixed === undefined) {
        if (layaSelection !== undefined && !layaSelection.ok) {
          outcomes.push({ taskId: child.taskId, ok: false, code: 'assignment-invalid', reason: layaSelection.reason });
          continue;
        }
        // On a Laya-controlled workbench a task with NO recorded decision is a wiring fault,
        // not a licence to guess. Refused explicitly so the cause is visible.
        if (this.decisionProvider !== null && layaSelection === undefined) {
          outcomes.push({
            taskId: child.taskId,
            ok: false,
            code: 'assignment-invalid',
            reason: 'this workbench is Laya-controlled but no initial Agent x Model decision was recorded ' +
              'for this task; call selectInitialAssignment() before assignChildren() rather than falling back to scoring',
          });
          continue;
        }
      }
      const rawExplicitPair = fixed !== undefined
        ? fixed
        : (layaSelection !== undefined && layaSelection.ok
          ? layaSelection.intent
          : (intent?.explicitPair ?? spec.explicitPair));
      const explicitPairCheck = rawExplicitPair === undefined
        ? undefined
        : validateAgentModelIntent(rawExplicitPair);
      if (explicitPairCheck !== undefined && !explicitPairCheck.ok) {
        outcomes.push({ taskId: child.taskId, ok: false, code: 'assignment-invalid', reason: explicitPairCheck.reason });
        continue;
      }
      // Record the user's pinned pair as a LOCK, so an automatic reassign/handoff may
      // not later swap it (see `reassignTask`).
      if (fixed !== undefined && explicitPairCheck !== undefined && explicitPairCheck.ok) {
        this.fixedSelections.set(child.taskId, explicitPairCheck.intent);
      }
      const outcome = assignWorker({
        taskId: child.taskId,
        taskType: child.taskType,
        requiredTaskTypes: child.taskType === 'implementation' ? undefined : [child.taskType],
        registry: this.registry,
        quotaRecords: this.quotaRecords,
        evidence: this.evidence,
        enforceFreeModelPool: this.enforceFreeModelPool,
        ...(explicitPairCheck !== undefined && explicitPairCheck.ok ? { explicitPair: explicitPairCheck.intent } : {}),
        preferredAgent,
        preferredModel,
      });
      if (!outcome.ok) {
        outcomes.push({ taskId: child.taskId, ok: false, code: outcome.code, reason: outcome.reason });
        continue;
      }
      const chosen = outcome.chosen.candidate;
      // The session is opened BEFORE the identity write, because a reuse intent that
      // the registry refuses must not leave a task pointing at a worker while
      // holding no session. On refusal the identity is never written.
      const wanted = toExecutionTarget(intent?.sessionIntent ?? spec.sessionIntent, {
        agentId: chosen.agentId,
        modelId: chosen.modelId,
      });
      let session;
      try {
        session = this.sessions.open(wanted, this.cwd, this.nowFn(), child.taskId);
      } catch (e) {
        const known = e instanceof SessionRegistryError;
        outcomes.push({
          taskId: child.taskId,
          ok: false,
          // A session refusal is reported under its own code so a caller can tell
          // "your reuse intent is invalid" from "no worker was assignable".
          code: known ? `session-${(e as SessionRegistryError).code}` : 'session-open-failed',
          reason: (e as Error).message,
          sessionError: {
            code: known ? (e as SessionRegistryError).code : 'session-open-failed',
            reason: (e as Error).message,
          },
        });
        continue;
      }
      const written = this.store.assignIdentity(child.taskId, chosen.agentId, chosen.modelId, this.nowFn());
      if (!written.ok) {
        outcomes.push({ taskId: child.taskId, ok: false, code: written.code ?? 'assignment-invalid', reason: written.reason ?? 'identity write refused' });
        continue;
      }
      // T1-d: the session is deliberately NOT marked running here. It becomes
      // `running` only when the runtime has actually accepted a run — the dispatch
      // hook inside `dispatch()` — so an assigned task that is never dispatched can
      // never leave a permanently "running" session behind.
      outcomes.push({
        taskId: child.taskId,
        ok: true,
        outcome,
        session: { sessionId: session.sessionId, reused: wanted.sessionId !== undefined },
      });
    }
    return outcomes;
  }


// ------------------------------------------------------- D1 decision wiring

  /**
   * The capability set a `runDecisionCycle` needs, and NOTHING beyond it.
   *
   * Each method below is a thin composition of calls a caller could have made itself.
   * The point of grouping them is not convenience - it is that this is the entire
   * surface a decision brain can reach, and it can be read in one place. Notably
   * absent: any way to spawn a run, cancel a task, transition state directly, or reach
   * git. A decision that wants work to happen asks the scheduler, which is the same
   * restriction P6-A imposed, now covering all eleven actions instead of three.
   */
  decisionCapabilities(options: DecisionWiringOptions = {}): DecisionCapabilities {
    // `retry` is the one action whose BOUND the caller must supply, because the bound
    // is a policy choice and this layer will not invent one. Absent, the capability is
    // still present but refuses, so the refusal is attributable rather than looking
    // like the loop was never wired.
    const retryCap: NonNullable<DecisionCapabilities['retry']> = options.retry
      ?? (async (req) => ({
          ok: false,
          code: 'retry-policy-missing',
          reason: `no retry policy was configured, so retrying "${req.taskId}" is refused rather than run unbounded`,
        }));
    return {
      // R-1, and the answer is deliberate: a decision-driven dispatch NEVER resumes.
      //
      // `retry`, `rework` and the post-`reassign` tick all re-run a task that already
      // has a native conversation behind it. Resuming it would carry every earlier turn
      // - including whatever wrong approach produced the failure - into the retry, which
      // is the opposite of what "try again" means. A fresh conversation re-reads the
      // acceptance criteria and the handoff, which is the state a retry actually wants.
      //
      // Resuming remains available, but only as an EXPLICIT per-call opt-in
      // (`dispatch(undefined, resume)`), so it is never the default a decision inherits.
      dispatch: async () => this.dispatchReceipt(),
      rework: async (taskId, reason) => {
        // Laya's REWORK arrives while the task is `to_verify` - that is the only state
        // a completed run can be in. `prepareRework` alone cannot act on it: it moves
        // `rework -> queued`, so the task must first BE in `rework`.
        //
        // The two existing steps are therefore composed, in the same order D0 uses for a
        // reviewer's rework verdict: `applyVerification` (the only route into `rework`)
        // then `prepareRework` (the only route back to `queued`). No new transition, no
        // new state, and the same authority chain a reviewer's verdict takes.
        const task = this.store.get(taskId);
        if (task === null) return { ok: false, code: 'task-not-found', reason: `no task "${taskId}"` };
        if (task.status !== 'rework') {
          const entered = this.orchestrator.applyVerification(taskId, {
            verdict: 'rework',
            reason: reason ?? 'the decision brain asked for this task to be redone',
          });
          if (!entered.ok) return { ok: false, code: entered.code, reason: entered.reason };
        }
        const re = prepareRework(this.orchestrator, taskId, reason);
        if (re.ok) this.pendingReworks.add(taskId);
        return { ok: re.ok, code: re.code, reason: re.reason };
      },
      replan: async (taskId, reason) => this.replanSubtree(taskId, 'single', reason),
      retry: retryCap,
      reassign: async (req) => this.reassignTask(req.taskId, req.agentId, req.modelId, req.reason, req.strategy),
      addTask: async (req) => this.addTask(req.parentTaskId, req.objective, req.taskType, req.reason),
      splitTask: async (req) => this.replanSubtree(req.taskId, req.into !== undefined ? `levels:${req.into}` : 'chain', req.reason),
      parallelize: async (req) => this.replanSubtree(req.taskId, 'parallel', req.reason),
      complete: async (req) => this.completeTask(req.taskId, req.reason),
    };
  }

  /**
   * Replan a subtree through the EXISTING `replanSubtree`, and nothing else.
   *
   * `split_task` and `parallelize` both land here because both ARE a replan with a
   * different shape - which is why neither needed a mechanism of its own. The
   * protection that matters comes free with it: `partitionForReplan` will not remove
   * anything that has started, so "split this task" can never delete a run.
   */
  replanSubtree(taskId: string, shape: 'single' | 'chain' | 'parallel' | `levels:${number}`, reason?: string): { ok: boolean; code: string; reason: string } {
    const root = this.store.get(taskId);
    if (root === null) return { ok: false, code: 'task-not-found', reason: `no task "${taskId}"` };
    const plan = planTasks({
      objective: reason === undefined ? `replan ${taskId}` : `replan ${taskId}: ${reason}`,
      rootTaskId: taskId,
      shape,
      generation: this.store.latestGeneration() + 1,
    });
    const outcome = replanSubtree(this.store, taskId, plan.candidates, {
      agentId: root.agentId,
      modelId: root.modelId,
      budgetUnits: root.budgetUnits,
      generation: this.store.latestGeneration() + 1,
    });
    if (outcome.status !== 'applied') {
      return { ok: false, code: `replan-${outcome.status}`, reason: outcome.reason };
    }
    return { ok: true, code: 'replanned', reason: outcome.reason };
  }

  /**
   * B1.4a: the USER-fixed pair locking a task, if any.
   *
   * Two sources, in order: the per-task lock recorded at assignment time, and the
   * task's ROOT effective selection (which covers tasks created later). An `auto`
   * root contributes no lock, so a Laya-chosen pair is never treated as user-fixed.
   */
  private fixedLockFor(taskId: string): AgentModelIntent | undefined {
    const direct = this.fixedSelections.get(taskId);
    if (direct !== undefined) return direct;
    const sel = this.rootSelections.get(this.rootOf(taskId));
    if (sel === undefined) return undefined;
    const pair = fixedPairOf(sel);
    if (pair === undefined) return undefined;
    const checked = validateAgentModelIntent(pair);
    return checked.ok ? checked.intent : undefined;
  }

  /**
   * B1.4a: the TRUE root of a task, by walking the parent chain.
   *
   * `Task.rootTaskId` is stamped as the task's IMMEDIATE parent (task.ts), so it is not
   * a tree root for a deep subtree. The effective selection is recorded per ROOT, so the
   * walk is what lets a task created several levels down derive the same lock.
   */
  private rootOf(taskId: string): string {
    let cur = this.store.get(taskId);
    const seen = new Set<string>();
    while (cur !== null && cur.parentTaskId !== null && !seen.has(cur.taskId)) {
      seen.add(cur.taskId);
      const parent = this.store.get(cur.parentTaskId);
      if (parent === null) break;
      cur = parent;
    }
    return cur?.taskId ?? taskId;
  }

  /**
   * Move a STARTED task to a different worker (P6-D1 / DC-1).
   *
   * `Assignment` proposes; `TaskStore.migrateIdentityAfterStart` commits. The old
   * session is NOT carried over: `SessionRegistry` refuses a cross-identity reuse, so
   * the next run starts a fresh native conversation on the new worker. That refusal is
   * the guard doing its job rather than something worked around here.
   *
   * `strategy` (DC-1) is what makes the absence of a target honest:
   *   - `'explicit'` (the default) REQUIRES a target. Passing none is refused here as
   *     well as in the validator, because this method is also a public entry point and a
   *     caller reaching it directly must not get the hidden evidence-score choice the
   *     validator forbids.
   *   - `'assignment'` deliberately delegates, and the resulting note says so.
   */
  reassignTask(
    taskId: string,
    agentId?: string,
    modelId?: string,
    reason?: string,
    strategy?: 'explicit' | 'assignment',
  ): { ok: boolean; code: string; reason: string } {
    const task = this.store.get(taskId);
    if (task === null) return { ok: false, code: 'task-not-found', reason: `no task "${taskId}"` };
    if (reason === undefined || reason.trim() === '') {
      return {
        ok: false, code: 'reassign-reason-required',
        reason: 'reassigning a task requires a reason: its prior attempts are already attributed to the old worker',
      };
    }
    const delegating = strategy === 'assignment';
    if (!delegating && agentId === undefined && modelId === undefined) {
      return {
        ok: false, code: 'reassign-target-required',
        reason: 'reassignTask needs a target agent and/or model, or strategy="assignment" to delegate the choice',
      };
    }
    // B1.4/B1.4a: a USER-pinned pair is a lock. An automatic handoff/reassign must not
    // swap it — the initial run honoured the fixed selection, so a later silent switch to
    // a different pair would break the user's explicit choice. The lock is looked up
    // PER TASK first and then derived from the task's ROOT effective selection, so it
    // also covers tasks created later (`addTask`, `replan`/`split`). Refuse with a clear
    // reason (no new pause state machine); the user changes the selection explicitly.
    const pinned = this.fixedLockFor(taskId);
    if (pinned !== undefined) {
      const sameTarget = agentId === pinned.agentId && modelId === pinned.modelId;
      if (!sameTarget) {
        return {
          ok: false,
          code: 'fixed-selection-locked',
          reason:
            `task "${taskId}" has a USER-fixed Agent x Model selection (${pinned.agentId} / ${pinned.modelId}); ` +
            'an automatic reassign/handoff may not swap it — change the selection explicitly to proceed',
        };
      }
    }
    // TeamRun T2-a: when Laya names a COMPLETE pair (agent AND model), that is an
    // explicit Agent × Model choice, and Assignment enforces it exactly — the chosen
    // pair is the named pair or the reassign is refused. Naming only one half keeps
    // the legacy preference semantics (Assignment completes the unspecified axis by
    // its own ranking), which is the documented legacy path, not a pair intent.
    const reassignsExplicitPair = agentId !== undefined && modelId !== undefined;
    const outcome = assignWorker({
      taskId,
      taskType: task.taskType,
      requiredTaskTypes: task.taskType === 'implementation' ? undefined : [task.taskType],
      registry: this.registry,
      quotaRecords: this.quotaRecords,
      evidence: this.evidence,
      enforceFreeModelPool: this.enforceFreeModelPool,
      ...(reassignsExplicitPair ? { explicitPair: { agentId: agentId!, modelId: modelId! } } : {}),
      ...(agentId !== undefined && !reassignsExplicitPair ? { preferredAgent: agentId } : {}),
      ...(modelId !== undefined && !reassignsExplicitPair ? { preferredModel: modelId } : {}),
    });
    if (!outcome.ok) return { ok: false, code: outcome.code, reason: outcome.reason };
    const chosen = outcome.chosen.candidate;
    const written = this.orchestrator.migrateIdentity(taskId, {
      agentId: chosen.agentId,
      modelId: chosen.modelId,
      reason,
    });
    if (!written.ok) return { ok: false, code: written.code, reason: written.reason };
    // T1-c: the new pair is formally accepted, so the task's session binding MUST move
    // with it — through the SessionRegistry's own APIs, never a Workbench-side edit.
    // `open` with a fresh target creates a session for the NEW (agent, model) pair and
    // `recordUse` re-points the task→session binding to it; the old session is left
    // untouched as the old worker's history. (A same-pair "reassign" never reaches
    // here: `migrateIdentityAfterStart` refuses `migration-not-a-migration`.) Without
    // this rebind, the next dispatch would attribute the new attempt to the OLD
    // session — a WorkerIdentity claiming one worker while the evidence names another.
    // Fresh policy is the only correct intent here: a changed pair can never reuse the
    // old session, and `SessionRegistry.open` would refuse the reuse anyway.
    //
    // T1-d: the new session is PREPARED here, not `running`. `markRunning` happens at
    // the real dispatch edge (inside `dispatch()`, when the runtime accepts the run),
    // so a reassign whose next dispatch is refused or never happens leaves a session
    // in the ordinary `open` state rather than a permanently "running" lie.
    const rebound = this.sessions.open(
      toExecutionTarget(DEFAULT_SESSION_INTENT, { agentId: chosen.agentId, modelId: chosen.modelId }),
      this.cwd, this.nowFn(), taskId,
    );
    return {
      ok: true,
      code: 'migrated',
      reason: `task ${taskId} moved from ${task.agentId}/${task.modelId ?? 'default'} to ${chosen.agentId}/${chosen.modelId ?? 'default'} ` +
        `(target ${delegating ? 'delegated to Assignment ranking' : 'named by the decision'}); ` +
        `prepared fresh session ${rebound.sessionId} on the new pair`,
    };
  }

  /**
   * Add one task through the EXISTING planner (P6-D1).
   *
   * `planTasks` + `commitPlan`, so the new task is validated as a candidate DAG before
   * it exists - the same guarantee every other planned task gets, rather than a
   * shortcut straight to `TaskStore.create`.
   */
  addTask(parentTaskId: string, objective: string, taskType?: TaskType, reason?: string): { ok: boolean; code: string; reason: string } {
    const parent = this.store.get(parentTaskId);
    if (parent === null) return { ok: false, code: 'task-not-found', reason: `no task "${parentTaskId}"` };
    // `planTasks` derives ids from the root, so a second `single` under the same parent
    // would collide with the first one and be refused as a duplicate. The planner has
    // no "next free id" concept - ids are a pure function of the root by design, which
    // is what makes a plan reproducible - so the collision is avoided HERE by planning
    // under a synthetic root, and the id is corrected on the way out. The alternative
    // would be teaching the planner about id allocation, which is exactly the state
    // authority it must not have.
    let n = 0;
    let planned = planTasks({
      objective,
      rootTaskId: parentTaskId,
      shape: 'single',
      generation: this.store.latestGeneration(),
      // DC-2: the requested type goes THROUGH the planner, so the committed task's type
      // is the one Laya asked for. Previously this was impossible - the planner hard-coded
      // `implementation` - and the difference was reported as a note on a task that had
      // already been committed with the wrong type.
      ...(taskType !== undefined ? { taskType } : {}),
    });
    while (planned.candidates.some((c) => this.store.has(c.taskId))) {
      n++;
      if (n > 1000) {
        return { ok: false, code: 'add-task-id-exhausted', reason: `could not find a free task id under "${parentTaskId}"` };
      }
      planned = planTasks({
        objective,
        rootTaskId: `${parentTaskId}-a${n}`,
        shape: 'single',
        generation: this.store.latestGeneration(),
        ...(taskType !== undefined ? { taskType } : {}),
      });
    }
    // The synthetic root only moved the ID; the task must still hang off the REAL
    // parent, which is what `commitPlan` reads as the subtree root.
    const candidates = planned.candidates.map((c) => ({ ...c, parentTaskId }));
    const outcome = commitPlan(this.store, candidates, {
      agentId: parent.agentId,
      modelId: parent.modelId,
      budgetUnits: parent.budgetUnits,
      generation: this.store.latestGeneration(),
    });
    if (!outcome.ok) return { ok: false, code: outcome.code, reason: outcome.reason };
    const added = outcome.created[0];
    // The requested type is now honoured by the planner, so a mismatch is a BUG rather
    // than a note. It is still reported loudly rather than asserted away.
    const gotType = added?.taskType ?? 'implementation';
    if (taskType !== undefined && gotType !== taskType) {
      return {
        ok: false,
        code: 'add-task-type-mismatch',
        reason: `the planner produced "${gotType}" but "${taskType}" was requested; the task was NOT created as requested`,
      };
    }
    return {
      ok: true,
      code: 'added',
      reason: `task ${added?.taskId ?? '?'} (${gotType}) was added under ${parentTaskId}${reason === undefined ? '' : ` (${reason})`}`,
    };
  }

  /**
   * Mark a task done - THROUGH `applyVerification`, never around it (P6-D1).
   *
   * This is the important one to get right. `complete` does not carry a verdict and
   * does not write a status; it asks the existing verification authority to accept, and
   * that authority still refuses anything not in `to_verify`. So `complete` cannot
   * become a second route into `succeeded`.
   */
  completeTask(taskId: string, reason?: string): { ok: boolean; code: string; reason: string } {
    const task = this.store.get(taskId);
    if (task === null) return { ok: false, code: 'task-not-found', reason: `no task "${taskId}"` };
    if (task.status !== 'to_verify') {
      return {
        ok: false, code: 'not-awaiting-verification',
        reason: `task "${taskId}" is ${task.status}; only a task awaiting verification can be completed`,
      };
    }
    const applied = this.orchestrator.applyVerification(taskId, {
      verdict: 'pass',
      reason: reason ?? 'completed by decision: the decision brain reports the acceptance criteria are met',
    });
    return applied.ok
      ? { ok: true, code: 'completed', reason: `task ${taskId} was verified as done` }
      : { ok: false, code: applied.code, reason: applied.reason };
  }

  // ------------------------------------------------------------------ dispatch

  /**
   * One dispatch round: tick, record evidence, update sessions. Best-effort on
   * evidence (a broken ledger never un-runs an agent), strict on task state
   * (that is the store's own transition rules, already applied inside tick).
   *
   * `resume` opts a task into continuing its NATIVE conversation. It is explicit and
   * per-call on purpose: a session with a recorded handle could otherwise be resumed
   * by any later tick without anyone asking, which turns a reuse decision into a
   * default. A task named here that has no handle is skipped (reported), never
   * fabricated.
   */
  async dispatch(promptFor?: ReadonlyMap<string, string>, resume?: ReadonlySet<string> | ReadonlyMap<string, string>, scope?: TickScope): Promise<DispatchOutcome> {
    // Briefs: any ready task whose dependencies already produced evidence gets a
    // composed brief (objective + structured handoffs) instead of the bare prompt.
    const briefs = new Map<string, string>();
    for (const task of this.candidatesWithSatisfiedDeps()) {
      const deps = task.dependencies.filter((d) => this.lastResults.has(d));
      if (deps.length === 0) continue;
      const brief = this.briefFor(task.taskId, this.lastResults);
      if (brief !== null) briefs.set(task.taskId, brief);
    }
    // Caller-supplied prompts (explicit instructions) take precedence over the
    // auto-brief for the same task; both flow through the ONE dispatch edge.
    const merged = new Map<string, string>([...briefs.entries(), ...(promptFor?.entries() ?? [])]);

    // P6-D1 (T1-e revision): resume is expressed as an INTENT here and resolved at
    // the freeze point inside the dispatch hooks below — the native handle comes from
    // the SAME compatible dispatch session as the attribution, never from a pre-tick
    // binding read that a mid-flight reassign could stale.
    const wanted = resume instanceof Map
      ? [...resume.keys()]
      : [...(resume ?? [])];
    const wantsResume = new Set(wanted);

    // T1-e: sessions settled by THIS dispatch, collected by the terminal hook.
    // Settlement is an execution fact (it happens when the run ends), so it is
    // observed at hook time rather than re-derived from outcomes afterwards.
    const sessionsSettled: string[] = [];

    const tick = await this.scheduler.tick(
      merged.size > 0 ? merged : undefined,
      undefined,
      {
        // T1-d: the session becomes `running` only when the RUNTIME has actually
        // accepted the run (`onStart`), never at reassignment or assignment time.
        // T1-e: the session marked here is the dispatch binding carried on the
        // mapping — the one resolved at the freeze point for the pair that will
        // actually run.
        onDispatchStart: (taskId, _handle, mapping) => {
          if (mapping.sessionId !== undefined) this.sessions.markRunning(mapping.sessionId, taskId);
        },
        // T1-e: the EXACTLY-ONCE symmetric half of `onDispatchStart`. Every started
        // execution settles its session here exactly once — success, failure,
        // timeout, cancellation, a refused write-back, or a result() rejection with
        // no RunResult at all. Settlement deliberately does NOT depend on
        // `outcome.ok`: a stale write-back still means the execution is over.
        onDispatchTerminal: (_taskId, _handle, mapping, terminal) => {
          const sessionId = mapping.sessionId;
          if (sessionId === undefined) return;
          if (terminal.run !== undefined) {
            this.sessions.recordRun(sessionId, terminal.run, this.nowFn());
          } else {
            this.sessions.endExecution(sessionId, this.nowFn());
          }
          sessionsSettled.push(sessionId);
        },
        // T1-e: THE dispatch session resolution. Called by the execution edge at its
        // freeze point — after the last pre-dispatch await, with the pair that will
        // actually run — and answered strictly from the SessionRegistry: only a
        // session COMPATIBLE with that exact pair is returned. A binding that has
        // already moved to another generation (or never existed) yields NO session;
        // there is deliberately no fallback to the latest incompatible binding. The
        // native resume handle comes from the same resolved session, so the actual
        // RunRequest and the attempt attribution share one dispatch binding (§6).
        resolveSessionForDispatch: ({ taskId, agentId, modelId }) => {
          const session = this.sessions.sessionForTask(taskId);
          if (session === null || !sessionCompatibleWith(session, { agentId, modelId })) {
            return undefined;
          }
          const resolved: { sessionId?: string; nativeThreadId?: string } = { sessionId: session.sessionId };
          if (wantsResume.has(taskId)) {
            const native = session.nativeSessionId;
            if (native !== null) resolved.nativeThreadId = native;
          }
          return resolved;
        },
      },
      // TeamRun T3-b.1: the optional per-invocation dispatch scope, forwarded verbatim and
      // never remembered. Omitted by every pre-T3-b.1 caller, so their behaviour is unchanged.
      scope,
    );

    // T1-e: the dispatch-time facts of every execution that REALLY ran, frozen from
    // the objects the execution edge already carries — the freeze-point
    // `RunRequestMapping` (agent/model/session) and the lease version on
    // `ExecuteOutcome`. No field is re-read from the current Task at record time.
    const dispatchFacts = new Map<string, DispatchExecutionFacts>();
    for (const entry of tick.outcomes) {
      if (entry.outcome.run === undefined) continue;
      const mapping = entry.outcome.mapping;
      if (mapping === undefined) {
        // PRODUCTION-UNREACHABLE (§19 guard): `executeTask` returns a mapping on
        // every outcome that carries a run — both the accepted and the
        // refused-with-run branch. Defensive only: attribute the AGENT from the
        // run's own immutable fact, leave the model and session unknown, and never
        // reconstruct identity from the current task state.
        log.warn('execution outcome carries a run but no dispatch mapping; attributing from the run itself', {
          taskId: entry.taskId,
        });
        dispatchFacts.set(entry.taskId, Object.freeze({
          taskId: entry.taskId,
          agentId: entry.outcome.run.agentId,
          modelId: null,
          ...(entry.outcome.leaseVersion !== undefined ? { leaseVersion: entry.outcome.leaseVersion } : {}),
        }));
        continue;
      }
      // §10 cross-check: the RunResult's own agent vs the pair we dispatched. A
      // mismatch means the runtime reported for a different agent than the request
      // named — never silently spliced; it is surfaced here and the attempt keeps the
      // DISPATCHED pair so the three facts stay one generation.
      if (entry.outcome.run.agentId !== mapping.agentId) {
        log.warn('dispatch/RunResult agent mismatch; attributing the attempt to the dispatched pair', {
          taskId: entry.taskId,
          dispatched: mapping.agentId,
          reported: entry.outcome.run.agentId,
        });
      }
      dispatchFacts.set(entry.taskId, Object.freeze({
        taskId: entry.taskId,
        agentId: mapping.agentId,
        modelId: mapping.model ?? null,
        ...(mapping.sessionId !== undefined ? { sessionId: mapping.sessionId } : {}),
        ...(entry.outcome.leaseVersion !== undefined ? { leaseVersion: entry.outcome.leaseVersion } : {}),
      }));
    }
    // Identity for attempt recording: DISPATCH-TIME facts. For every outcome with a
    // run the facts exist (built above), so the fallback below is
    // production-unreachable and exists only so the recorder never crashes on a
    // malformed outcome; it is never a license to reconstruct identity from the
    // current task (§19).
    const identityOf = (taskId: string) => {
      const t = this.store.get(taskId);
      if (t === null) return null;
      const facts = dispatchFacts.get(taskId);
      return {
        agentId: facts?.agentId ?? t.agentId,
        modelId: facts?.modelId ?? t.modelId,
        budgetUnits: t.budgetUnits,
        taskType: t.taskType,
      };
    };
    // Session for attempt recording (T1-e): STRICT. Only the dispatch binding
    // carried by the execution's frozen facts. There is deliberately NO fallback to
    // the current session binding, the latest session, or the previous attempt: no
    // dispatch session => the attempt records NO session (§17/§19).
    const sessionOf = (taskId: string): { sessionId: string } | null => {
      const facts = dispatchFacts.get(taskId);
      return facts !== undefined && facts.sessionId !== undefined ? { sessionId: facts.sessionId } : null;
    };
    // Rework re-entries are recorded with their own kind. Splitting by the
    // pendingReworks set (this workbench called prepareRework) keeps the
    // execution/rework distinction honest without a second authority.
    //
    // R5-1.2C (§12): the lineage test is `pendingReworks` (did THIS workbench ask for a
    // rework) AND the presence of a REAL run (did an execution actually happen) — never
    // `ok`. Gating on `ok` meant a rework attempt whose write-back was refused
    // (`ok:false` with a real run) was classified as an ORDINARY execution: it fell into
    // `plainTick`, was recorded without its rework kind, and `pendingReworks` was never
    // consumed, so the rework lineage was silently lost. That contradicts the frozen
    // "run presence != ok" rule the rest of this projection already follows.
    const reworkIds = new Set(tick.outcomes.filter((o) => o.outcome.run !== undefined && this.pendingReworks.has(o.taskId)).map((o) => o.taskId));
    const plainTick: TickResult = { ...tick, outcomes: tick.outcomes.filter((o) => !reworkIds.has(o.taskId)) };
    // R2-2 (P1-1): renew the leases of tasks STILL RUNNING, right here - after a tick
    // this caller already decided to run. See `renewLeasesAfterTick` for why this is a
    // bounded, tick-driven call rather than a heartbeat.
    const renewedLeases = this.renewLeasesAfterTick();
    const recorded = recordExecutions(this.evidence, plainTick, identityOf,
      // T1-b/T1-c: hand the recorder the session each task's execution actually ran
      // in, so an attempt can be projected back to its Worker. Read-only; the session
      // registry remains the sole authority.
      //
      // T1-d: that session is the DISPATCH-TIME session carried by the execution's
      // frozen facts — never the current binding, which a mid-flight reassign may
      // already have moved to the next worker. An execution with no dispatch-time
      // session records NO session (fail closed), never a newer one.
      sessionOf);
    const attemptIdsByTask = recorded.attemptIdsByTask;
    // T3-a.5: the `{attemptId, run}` pairs this dispatch produced, as bound at the append
    // site. Carried out so a consumer can pair a result with the attempt it belongs to
    // without a task-keyed latest-ever lookup, which cannot tell attempt B's result from
    // attempt A's.
    const executionsByTask = recorded.executionsByTask;
    const evidenceRecorded = [...recorded.recorded];
    const notRecorded = [...recorded.notRecorded];
    // R4: bind each attempt id to the run that produced it, WHILE both are in hand.
    //
    // `recordExecutions` walks `plainTick.outcomes` in order and appends one id per
    // recorded outcome, so the nth recorded outcome for a task corresponds to the nth id
    // in `attemptIdsByTask[taskId]`. Ids are consumed with a cursor rather than zipped, so
    // an outcome that was not recorded cannot shift the pairing. A scheduler tick
    // dispatches a task at most once, so in practice the list has 0 or 1 entries; the
    // cursor form stays correct if that ever changes.
    {
      const cursor = new Map<string, number>();
      for (const entry of plainTick.outcomes) {
        // Gate on the RUN, not `ok`: `recordExecutions` mints an id both for an
        // accepted result and for a refused write-back that still carries a real run
        // (attempt-integration.ts §F5), so gating on `ok` here would leave that id
        // unbound and drop real evidence. A run-less refusal recorded nothing, so it
        // must not advance the cursor — that keeps the nth-id pairing intact.
        if (entry.outcome.run === undefined) continue;
        const ids = attemptIdsByTask[entry.taskId];
        if (ids === undefined) continue;
        const at = cursor.get(entry.taskId) ?? 0;
        if (at >= ids.length) continue;
        cursor.set(entry.taskId, at + 1);
        this.rememberAttemptEvidence(ids[at]!, entry.taskId, entry.outcome.run);
      }
    }
    for (const entry of tick.outcomes) {
      // Same run-presence gate as the cursor loop above: a rework execution whose
      // write-back was refused still executed, so its result is still the evidence.
      if (!reworkIds.has(entry.taskId) || entry.outcome.run === undefined) continue;
      const identity = identityOf(entry.taskId);
      if (identity === null) { notRecorded.push(entry.taskId); continue; }
      // T1-b/T1-d: read the DISPATCH-TIME session the run actually used, from its
      // frozen facts. The current binding is never consulted for an execution that
      // already ran — a mid-flight reassign may have moved it to the next worker.
      const reworkSession = sessionOf(entry.taskId);
      // T1-e (§17): the rework attempt carries THIS execution's dispatch lease
      // version — the frozen value from its dispatch facts — never the task's
      // current or latest lease, which a mid-flight reassign may already have
      // advanced.
      const reworkFacts = dispatchFacts.get(entry.taskId);
      const rec = recordExecution(this.evidence, {
        taskId: entry.taskId,
        agentId: identity.agentId,
        modelId: identity.modelId,
        ...(reworkSession === null ? {} : { sessionId: reworkSession.sessionId }),
        ...(reworkFacts?.leaseVersion === undefined ? {} : { leaseVersion: reworkFacts.leaseVersion }),
        result: entry.outcome.run,
        budgetUnits: identity.budgetUnits,
        taskType: identity.taskType,
        isRework: true,
      });
      if (rec === null) notRecorded.push(entry.taskId);
      else evidenceRecorded.push(entry.taskId);
      // The rework attempt gets the same treatment: its id and its run are in this one
      // iteration, so the pairing is exact rather than inferred.
      if (rec !== null) this.rememberAttemptEvidence(rec.attemptId, entry.taskId, entry.outcome.run);
      this.pendingReworks.delete(entry.taskId);
    }
    for (const entry of tick.outcomes) {
      // `lastResults` feeds dependants' briefs, so it wants the real run whenever one
      // exists. A refused write-back still executed; withholding it would hide the
      // authoritative result from exactly the tasks that depend on it.
      if (entry.outcome.run !== undefined) this.lastResults.set(entry.taskId, entry.outcome.run);
      // Intent is dropped once the task is done. A preference or a reuse key for
      // finished work can never apply again, and keeping it would grow this map for
      // the lifetime of the process.
      const after = this.store.get(entry.taskId);
      if (after !== null && (after.status === 'succeeded' || after.status === 'failed' || after.status === 'cancelled')) {
        this.taskIntents.delete(entry.taskId);
      }
    }
    // T1-e: session RECORDING moved to the exactly-once `onDispatchTerminal` hook
    // above — settlement is an execution fact and fires for every started execution,
    // regardless of write-back acceptance (§13). What remains here is only the
    // R2-2 §4.1 audit linkage for ACCEPTED assignments: the chain
    // attempt -> leaseVersion -> lease -> session, recorded with the DISPATCH-TIME
    // session from the execution's frozen facts. The session id is COPIED from the
    // registry, which stays the only owner of session lifecycle.
    for (const entry of tick.outcomes) {
      if (!entry.outcome.ok) continue;
      const session = sessionOf(entry.taskId);
      if (session !== null) this.store.attachLeaseSession(entry.taskId, session.sessionId);
    }
    return {
      tick,
      evidenceRecorded,
      evidenceDegraded: notRecorded.length > 0 && tick.admitted.length > 0,
      // T1-e: sessions settled by the exactly-once terminal hook — every started
      // execution, whatever its outcome, not only accepted write-backs.
      sessionsTouched: sessionsSettled,
      attemptIdsByTask,
      executionsByTask,
      renewedLeases: renewedLeases.renewed,
    };
  }

  /**
   * R2-2 final closure (P1-1): PRODUCTION renew.
   *
   * §6.2 names the caller: "renew 由 Workbench 在 tick 观察到任务仍在 running 时发起，
   * 仍然由 Assignment authority 记录". This is that call site, and it is the reason a run
   * that outlives the execution window is not stuck: without it the late result would be
   * refused for being expired and the task would sit in `running` forever, because
   * dispatch-time activation is once-per-lease by design and cannot help a second time.
   *
   * Everything that makes this safe rather than a heartbeat in disguise:
   *   - it runs AFTER a tick the caller already decided to run; it never causes one,
   *     and it never dispatches, retries, reassigns or re-plans anything
   *   - the budget is `maxRenewals` per lease VERSION (default 2), so a task cannot be
   *     kept alive indefinitely - after the budget the refusal stands and the late
   *     result is (correctly) not written back
   *   - only tasks whose status is `running` are considered, and a superseded lease
   *     version is skipped, so a revoked or reassigned lease is never extended
   *   - a refusal is not an error: it is the designed bound, and it is reported
   */
  private renewLeasesAfterTick(): { readonly renewed: readonly string[]; readonly refused: Readonly<Record<string, string>> } {
    return this.store.renewRunningLeases(this.clock());
  }

  /** The clock this workbench stamps lifecycle facts with. Single source, injected. */
  private clock(): number {
    return this.nowFn();
  }

  /**
   * R2-2 §5.4: dispatch and return the ADMISSION RECEIPT.
   *
   * The one dispatch path the Decision Loop is given. It is `dispatch()` plus a
   * projection - deliberately NOT a second tick, because a second `scheduler.tick()`
   * would be a second dispatch loop and could run tasks twice.
   *
   * The attempt ids are the ones `AttemptStore.append` actually minted during that
   * dispatch, so the receipt points at real execution attempts without holding a
   * `RunResult` and without a second source of truth.
   */
  async dispatchReceipt(
    promptFor?: ReadonlyMap<string, string>,
    resume?: ReadonlySet<string> | ReadonlyMap<string, string>,
    scope?: TickScope,
  ): Promise<DispatchReceipt> {
    const outcome = await this.dispatch(promptFor, resume, scope);
    this.lastDispatchTick = outcome.tick;
    // F6: no tick means NO dispatch happened. The previous version substituted a
    // synthetic empty tick, which is indistinguishable from a real dispatch that
    // admitted nothing - so a caller could not tell "the scheduler declined to run"
    // from "the dispatch never reached the scheduler", and `reentrant: false` on an
    // empty receipt asserts a dispatch that did not occur. An empty receipt is the
    // honest answer; it is also what the re-entrancy guard produces.
    if (outcome.tick === null) return emptyDispatchReceipt(this.nowFn());
    return buildDispatchReceipt({
      tick: outcome.tick,
      dispatchedAt: this.nowFn(),
      attemptIdsByTask: outcome.attemptIdsByTask,
      // T3-a.5: hand the correlated pairs to the receipt, so "this dispatch's attempt" and
      // "this dispatch's result" reach the consumer already matched.
      executionsByTask: outcome.executionsByTask,
    });
  }

  /** The most recent tick this workbench produced, for `runDecisionCycle`'s `lastTick`. */
  lastTick(): TickResult | null {
    return this.lastDispatchTick;
  }

  // -------------------------------------------------------------------- review

  /**
   * Apply a reviewer's verdict through D0's bounded loop. A `rework` that the
   * policy allows is re-entered on the SAME worker and dispatched by the SAME
   * scheduler; a guard trip (`max-attempts-exhausted` / `repeated-verdict`)
   * changes nothing and is reported for a task-level replan decision - review
   * comments never reach Laya.
   *
   * A RE-ENTRY FAILURE is now carried on the outcome rather than swallowed. It used
   * to `return outcome` unchanged, which still said `status:'ok'` and
   * `reworkRequested:true` while the task sat in `rework` - a state no candidate rule
   * admits, so it would never be dispatched again. The verification really had
   * succeeded, so the status is still honest; what was missing is whether the rework
   * actually became work. `reworkReentry` says so, reusing `ReworkReentry` unchanged.
   */
  applyReview(taskId: string, verdict: ReviewVerdict, previous: readonly ReviewEvidence[] = []): ReviewOutcome {
    // P6-D1: record the review as evidence BEFORE applying it. Facts only - the
    // record is what a later decision cycle reads to know a review happened, and it
    // is written whether or not the verdict is honoured (a guard-tripped rework still
    // happened, and hiding it would make a bounded loop look silent).
    //
// Best-effort by construction: `recordReview` returns null on a refused append and
    // nothing here branches on it, because a broken ledger must never prevent a
    // verdict from being applied. Nothing here reads evidence back to decide anything -
    // that remains `Assignment`'s and the review policy's job.
    //
    // R2-3: routed through `recordReviewEvidence` so the evidence write has exactly ONE
    // implementation, shared with the unified round review (which must record evidence
    // WITHOUT applying the verdict).
    this.recordReviewEvidence(taskId, verdict);
    const outcome = applyReviewVerdict({
      orchestrator: this.orchestrator,
      taskId,
      verdict,
      previous,
      policy: this.reworkPolicy,
    });
    if (outcome.status === 'ok' && outcome.reworkRequested) {
      const re = prepareRework(this.orchestrator, taskId, verdict.reason);
      if (!re.ok) {
        // Wedged: `rework` is not dispatchable, so the caller MUST be able to see it.
        // Spreading over the narrowed `ok` variant keeps the discriminated union
        // honest rather than mutating the object applyReviewVerdict returned.
        return { ...outcome, reworkReentry: re };
      }
      // The re-entry consumed an attempt and queued the task; no evidence is
      // recorded here - the rework's own record lands when its run completes,
      // via dispatch(), which knows from this set that it is a rework.
      this.pendingReworks.add(taskId);
      return { ...outcome, reworkReentry: re };
    }
    return outcome;
  }

  // ------------------------------------------------------------------- handoff

  /**
   * R2-3: record a review as evidence WITHOUT applying its verdict.
   *
   * This exists because `applyReview` does two different jobs — it writes the evidence
   * record AND drives the bounded rework loop — and the unified round review needs only
   * the first. Applying a verdict there would be wrong twice over: a unified verdict is a
   * recommendation to the user, not an instruction to the workflow, and letting it reach
   * `applyReviewVerdict` would make review a second authority over task state.
   *
   * So the evidence write is separated from the verdict application, and both call the
   * SAME existing writer (`recordReview`). There is no review store here and no second
   * place a verdict can be recorded: `applyReview` is now a composition of these two.
   *
   * Execution evidence is untouched and is not replaced by this — a review is an ADDITIONAL
   * record about an execution, never a substitute for it. A task with no execution can
   * still be reviewed (an admission refusal has no run), which is exactly why this takes
   * a taskId rather than reading a run back.
   *
   * Best-effort by construction, like every other evidence write: a refused append
   * returns null and nothing branches on it.
   */
  recordReviewEvidence(taskId: string, verdict: ReviewVerdict): { ok: boolean; attemptId: string | null; code: string | null; reason: string | null } {
    const task = this.store.get(taskId);
    const rec = recordReview(this.evidence, {
      taskId,
      reviewer: verdict.reviewer,
      verdict,
      ...(task !== null ? { taskType: task.taskType } : {}),
    });
    return rec === null
      ? { ok: false, attemptId: null, code: 'review-not-recorded', reason: 'the evidence store refused the review record' }
      : { ok: true, attemptId: rec.attemptId, code: null, reason: null };
  }

  /** The structured handoff for one task, from its own evidence. */
  handoffFor(taskId: string, result: RunResult | null): TaskHandoff | null {
    const task = this.store.get(taskId);
    if (task === null) return null;
    return buildHandoff(task, result);
  }

  /**
   * The brief a worker should receive: its acceptance criteria plus the handoffs
   * of the dependencies it actually waits on. This is what `executeTask` is told
   * to say - composed ONCE here, so two callers cannot brief the same task
   * differently.
   */
  /**
   * The session a task ran in, for callers that need to assert on resume behaviour.
   *
   * Exposed because R-1's semantics are only real if they are OBSERVABLE: "a retry
   * starts fresh" is a claim, and this is how a test checks it rather than inferring it
   * from a passing run.
   */
  sessionForTask(taskId: string): WorkbenchSession | null {
    return this.sessions.sessionForTask(taskId);
  }

  /** The native handle a resuming task would receive, or null. */
  nativeHandleForTask(taskId: string): string | null {
    return this.sessions.nativeHandleForTask(taskId);
  }

  briefFor(taskId: string, results: ReadonlyMap<string, RunResult>): string | null {
    const task = this.store.get(taskId);
    if (task === null) return null;
    const handoffs: TaskHandoff[] = [];
    for (const dep of task.dependencies) {
      const depTask = this.store.get(dep);
      if (depTask === null) continue;
      handoffs.push(buildHandoff(depTask, results.get(dep) ?? null));
    }
    return buildTaskBrief({
      objective: task.acceptanceCriteria,
      // Laya's request for THIS task, recorded at plan time. Absent means the section
      // is omitted entirely, so a task with no skill intent gets a byte-identical brief
      // to the one it got before this existed.
      skills: this.taskIntents.get(taskId)?.skills,
      handoffs,
    });
  }

  /**
   * The last REAL run result for a task, or null.
   *
   * Read-only access to what `dispatch` already observed. Exposed because a handoff
   * is only as good as the result it was built from, and a caller verifying the
   * handoff chain needs to see that same result - not a re-run to get one.
   */
  lastRunResult(taskId: string): RunResult | null {
    return this.lastResults.get(taskId) ?? null;
  }

  /** Every real run result observed so far. Read-only; the map is copied. */
  runResults(): ReadonlyMap<string, RunResult> {
    return new Map(this.lastResults);
  }

  /**
   * R4: per-attempt evidence keyed by `attemptId`. Read-only; the map is copied.
   *
   * This is what a round report reads instead of `runResults()`, because `runResults()`
   * cannot distinguish two attempts of the same task. Attempt evidence itself is still
   * owned by `AttemptStore`; this only preserves the attempt-id-to-run association that
   * `lastResults` collapses.
   */
  attemptEvidenceMap(): Readonly<Record<string, AttemptEvidenceInput>> {
    return Object.fromEntries(this.attemptEvidence);
  }

  /**
   * Project ONE run into the per-attempt evidence shape and remember it under `attemptId`.
   *
   * `buildHandoff` is the existing projection and is reused unchanged, so files, tests and
   * the transcript are derived exactly as a dependant's brief derives them.
   *
   * `artifacts` is deliberately dropped: `buildHandoff` fills it from `Task.artifacts`,
   * which is what the TASK declared rather than what this attempt produced. Filing a
   * task's declared artifacts under a specific attempt id would attribute one attempt's
   * output to another. Task-level artifacts are reported on the task summary instead.
   */
  private rememberAttemptEvidence(attemptId: string, taskId: string, run: RunResult): void {
    const task = this.store.get(taskId);
    const handoff = task === null ? null : buildHandoff(task, run);
    this.attemptEvidence.set(attemptId, {
      changedFiles: handoff?.changedFiles ?? [],
      testsRun: handoff?.testsRun ?? [],
      artifacts: [],
      transcriptPath: handoff?.transcriptPath ?? null,
      errorCode: handoff?.error?.code ?? run.error?.code ?? null,
      errorMessage: handoff?.error?.message ?? run.error?.message ?? null,
    });
  }

  // ------------------------------------------------------------------- helpers

  /** Spawn one explicit child (for callers that bypass the planner deliberately). */
  spawnChild(req: SpawnChildRequest): ReturnType<Orchestrator['spawnChild']> {
    return this.orchestrator.spawnChild(req);
  }

  /**
   * Record Laya's per-task intent for a task that ALREADY exists.
   *
   * WHY A SIDE TABLE AND NOT A `Task` FIELD
   * ---------------------------------------
   * `skills` and `sessionIntent` are instructions about HOW a task should be run;
   * they are not facts about the work. Putting them on `Task` would make TaskStore
   * - the single task-lifecycle authority - start owning advisory dispatch hints,
   * and `assignChildren` would have to read them off the store to work. That is the
   * second-authority shape this architecture refuses: the store would hold a
   * preference the assignment engine does not own and cannot validate.
   *
   * The table is populated from the very plan/commit that created the task, so it is
   * a projection of Laya's decision, not an independent source. Entries are dropped
   * when a task reaches a terminal state, because a preference for work that is
   * finished can never apply again.
   *
   * A task with no entry behaves exactly as before: no skills rendered, fresh
   * session. Absence is the default rather than a stored "no preference".
   */
  setTaskIntent(taskId: string, intent: TaskIntent): void {
    this.taskIntents.set(taskId, intent);
  }

  /** Laya's recorded intent for one task, or undefined. Read-only. */
  intentFor(taskId: string): TaskIntent | undefined {
    return this.taskIntents.get(taskId);
  }

  /** Ready candidates this tick, read from the store (read-only helper). */
  private candidatesWithSatisfiedDeps(): Task[] {
    return this.store.all().filter((t) => t.depth > 0 && (t.status === 'planned' || t.status === 'queued') && t.dependencies.length > 0);
  }
}
