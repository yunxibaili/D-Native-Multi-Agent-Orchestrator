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
import type { RunResult } from '../core/types.ts';
import type { TaskClassification } from '../decision/routing.ts';
import { Orchestrator, type SpawnChildRequest } from './orchestrator.ts';
import { TaskScheduler, type TickResult } from './scheduler.ts';
import { buildDispatchReceipt, emptyDispatchReceipt, type DispatchReceipt } from './dispatch-receipt.ts';
import type { Task } from './task.ts';
import type { TaskStore } from './store.ts';
import { AttemptStore } from './attempt-store.ts';
import { recordExecutions, recordExecution, recordReview } from './attempt-integration.ts';
import { applyReviewVerdict, prepareRework, DEFAULT_REWORK_POLICY, type ReworkPolicy, type ReviewOutcome } from './review-loop.ts';
import type { DecisionApplicationContext } from './decision.ts';
import type { ReviewEvidence, ReviewVerdict } from './review-verdict.ts';
import { assignWorker, type AssignmentOutcome } from './assignment.ts';
import {
  SessionRegistry,
  SessionRegistryError,
  toExecutionTarget,
  type SessionIntent,
  type WorkbenchSession,
} from './workbench-sessions.ts';
import { buildHandoff, buildTaskBrief, type TaskHandoff } from './workbench-handoff.ts';
import { commitPlan, replanSubtree } from './planner-wiring.ts';
import { planTasks } from './planner.ts';
import { planFromSpec, type WorkbenchTaskSpec, type PlanFromSpecResult } from './workbench-plan.ts';

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
}

export interface PlanOutcome {
  readonly root: Task;
  readonly planned: PlanFromSpecResult;
  /** Children that exist in the store after the plan was committed. */
  readonly children: readonly Task[];
}

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
   * Laya's per-task intent, projected from the plan that created each task.
   *
   * Deliberately NOT on `Task`: see `setTaskIntent` for why dispatch hints must not
   * become task state. Entries are pruned once a task is terminal, since an intent
   * for finished work can never apply again.
   */
  private readonly taskIntents = new Map<string, TaskIntent>();
  /** R2-2: the most recent tick, so unDecisionCycle can read a real TickResult. */
  private lastDispatchTick: TickResult | null = null;
  /** Explicit root agent id; see `WorkbenchOptions.rootAgentId`. */
  private readonly rootAgentId: string;
  /** The single clock for every fact this workbench writes. See `WorkbenchOptions.now`. */
  private readonly nowFn: () => number;

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
    this.rootAgentId = options.rootAgentId ?? DEFAULT_ROOT_AGENT_ID;
    this.nowFn = options.now ?? Date.now;
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

  // ---------------------------------------------------------------- assignment

  /**
   * Assign workers to every non-terminal child of a root, honouring the spec's
   * preference. `assignIdentity` refuses anything that already started, so this
   * is safe to call repeatedly between ticks.
   */
  assignChildren(rootTaskId: string, spec: WorkbenchTaskSpec): readonly AssignOutcome[] {
    const outcomes: AssignOutcome[] = [];
    for (const child of this.store.children(rootTaskId)) {
      if (child.status === 'succeeded' || child.status === 'failed' || child.status === 'cancelled') continue;
      // Per-task intent beats the spec default; the spec is only the fallback.
      // Both are Laya's words, so this is precedence, not a new decision.
      const intent = this.taskIntents.get(child.taskId);
      const preferredAgent = intent?.preferredAgent ?? spec.preferredAgent;
      const preferredModel = intent?.preferredModel ?? spec.preferredModel;
      const outcome = assignWorker({
        taskId: child.taskId,
        taskType: child.taskType,
        requiredTaskTypes: child.taskType === 'implementation' ? undefined : [child.taskType],
        registry: this.registry,
        quotaRecords: this.quotaRecords,
        evidence: this.evidence,
        enforceFreeModelPool: this.enforceFreeModelPool,
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
      this.sessions.markRunning(session.sessionId, child.taskId);
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
    const outcome = assignWorker({
      taskId,
      taskType: task.taskType,
      requiredTaskTypes: task.taskType === 'implementation' ? undefined : [task.taskType],
      registry: this.registry,
      quotaRecords: this.quotaRecords,
      evidence: this.evidence,
      enforceFreeModelPool: this.enforceFreeModelPool,
      ...(agentId !== undefined ? { preferredAgent: agentId } : {}),
      ...(modelId !== undefined ? { preferredModel: modelId } : {}),
    });
    if (!outcome.ok) return { ok: false, code: outcome.code, reason: outcome.reason };
    const chosen = outcome.chosen.candidate;
    const written = this.orchestrator.migrateIdentity(taskId, {
      agentId: chosen.agentId,
      modelId: chosen.modelId,
      reason,
    });
    if (!written.ok) return { ok: false, code: written.code, reason: written.reason };
    return {
      ok: true,
      code: 'migrated',
      reason: `task ${taskId} moved from ${task.agentId}/${task.modelId ?? 'default'} to ${chosen.agentId}/${chosen.modelId ?? 'default'} ` +
        `(target ${delegating ? 'delegated to Assignment ranking' : 'named by the decision'}); the next run uses a fresh native session`,
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
  async dispatch(promptFor?: ReadonlyMap<string, string>, resume?: ReadonlySet<string> | ReadonlyMap<string, string>): Promise<DispatchOutcome> {
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

    // P6-D1: resolve native handles for the tasks that ASKED to resume. Only
    // `SessionRegistry` knows a handle, and a task without one is left out of the map
    // so `executeTask` starts a fresh conversation instead of resuming nothing.
    const wanted = resume instanceof Map
      ? [...resume.keys()]
      : [...(resume ?? [])];
    const threads = new Map<string, string>();
    for (const taskId of wanted) {
      const handle = this.sessions.nativeHandleForTask(taskId);
      if (handle !== null) threads.set(taskId, handle);
    }

    const tick = await this.scheduler.tick(
      merged.size > 0 ? merged : undefined,
      threads.size > 0 ? threads : undefined,
    );
    const identityOf = (taskId: string) => {
      const t = this.store.get(taskId);
      return t === null
        ? null
        : { agentId: t.agentId, modelId: t.modelId, budgetUnits: t.budgetUnits, taskType: t.taskType };
    };
    // Rework re-entries are recorded with their own kind. Splitting by the
    // pendingReworks set (this workbench called prepareRework) keeps the
    // execution/rework distinction honest without a second authority.
    const reworkIds = new Set(tick.outcomes.filter((o) => o.outcome.ok && this.pendingReworks.has(o.taskId)).map((o) => o.taskId));
    const plainTick: TickResult = { ...tick, outcomes: tick.outcomes.filter((o) => !reworkIds.has(o.taskId)) };
    // R2-2 (P1-1): renew the leases of tasks STILL RUNNING, right here - after a tick
    // this caller already decided to run. See `renewLeasesAfterTick` for why this is a
    // bounded, tick-driven call rather than a heartbeat.
    const renewedLeases = this.renewLeasesAfterTick();
    const recorded = recordExecutions(this.evidence, plainTick, identityOf);
    const attemptIdsByTask = recorded.attemptIdsByTask;
    const evidenceRecorded = [...recorded.recorded];
    const notRecorded = [...recorded.notRecorded];
    for (const entry of tick.outcomes) {
      if (!reworkIds.has(entry.taskId) || !entry.outcome.ok) continue;
      const identity = identityOf(entry.taskId);
      if (identity === null) { notRecorded.push(entry.taskId); continue; }
      const rec = recordExecution(this.evidence, {
        taskId: entry.taskId,
        agentId: identity.agentId,
        modelId: identity.modelId,
        result: entry.outcome.run,
        budgetUnits: identity.budgetUnits,
        taskType: identity.taskType,
        isRework: true,
      });
      if (rec === null) notRecorded.push(entry.taskId);
      else evidenceRecorded.push(entry.taskId);
      this.pendingReworks.delete(entry.taskId);
    }
    for (const entry of tick.outcomes) {
      if (entry.outcome.ok) this.lastResults.set(entry.taskId, entry.outcome.run);
      // Intent is dropped once the task is done. A preference or a reuse key for
      // finished work can never apply again, and keeping it would grow this map for
      // the lifetime of the process.
      const after = this.store.get(entry.taskId);
      if (after !== null && (after.status === 'succeeded' || after.status === 'failed' || after.status === 'cancelled')) {
        this.taskIntents.delete(entry.taskId);
      }
    }
    const touched: string[] = [];
    for (const entry of tick.outcomes) {
      if (!entry.outcome.ok) continue;
      const result: RunResult = entry.outcome.run;
      // Find the session this task was attached to; record the native handle.
      // `sessionForTask`, NOT a scan for `s.taskId === task`: a shared session's
      // `taskId` field is its CURRENT owner, so the scan found the wrong session as
      // soon as two tasks used one (P6-D1).
      const session = this.sessions.sessionForTask(entry.taskId);
      if (session !== null) {
        this.sessions.recordRun(session.sessionId, result, this.nowFn());
        touched.push(session.sessionId);
        // R2-2 §4.1 audit linkage: record which conversation this assignment used, so
        // the chain attempt -> leaseVersion -> lease -> session can be walked without a
        // second session store.
        //
        // The session id is COPIED from the registry, which stays the only owner of
        // session lifecycle: this creates nothing, resumes nothing and closes nothing.
        // A task with no session (or an unknown lease) simply has nothing recorded.
        this.store.attachLeaseSession(entry.taskId, session.sessionId);
      }
    }
    return {
      tick,
      evidenceRecorded,
      evidenceDegraded: notRecorded.length > 0 && tick.admitted.length > 0,
      sessionsTouched: touched,
      attemptIdsByTask,
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
  ): Promise<DispatchReceipt> {
    const outcome = await this.dispatch(promptFor, resume);
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
