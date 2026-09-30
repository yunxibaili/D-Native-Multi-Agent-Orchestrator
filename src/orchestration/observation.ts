/**
 * src/orchestration/observation.ts — P6-A: the facts one decision needs.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `Task` (task.ts) and `RunResult` (core/types.ts) each describe their own slice
 * of reality, and neither is the "state of the run as a decision-maker sees it".
 * The audit (CURRENT_STATE_AUDIT.md §7) recorded the consequence: there was no
 * bridge, so nothing could ask "what is true right now?" without hand-assembling
 * it — and every caller that did would assemble a slightly different set.
 *
 * This module is that view. Symphony's principle, adopted verbatim: there is
 * exactly ONE authoritative orchestration state, and everything else is a VIEW of
 * it. So this file:
 *
 *   - READS `TaskStore` and derives. It never writes, never caches, never holds.
 *   - Creates no second store. There is no shadow index here to drift.
 *   - Owns no status. If this observation says `failed`, it is because the store
 *     says `failed`; delete the store and the observation stops existing.
 *
 * WHY IT IS SMALL
 * ---------------
 * The temptation is to ship "everything a future stage might want". That would be
 * actively harmful: a decision brain handed a capability matrix, a performance
 * history and a planner transcript does not decide better, it decides on noise it
 * cannot act on yet. P6-A needs exactly the facts that separate `continue` from
 * `wait` from `abort`:
 *
 *   can work start now?  -> ready tasks, unmet dependencies, running count
 *   is anything wrong?  -> failures, blocked reasons
 *   is there still work? -> per-status counts, terminal-ness
 *
 * Everything else (capability profiles, performance rollups, review findings,
 * model rankings, quota analytics) belongs to P6-B/C/D0/E and is deliberately
 * ABSENT here. A field that no P6-A decision reads is a field that will be stale
 * the moment it is added.
 *
 * SERIALIZABLE BY CONSTRUCTION
 * ----------------------------
 * Every value is a string, number, boolean, null, or a readonly array/object of
 * those. That is not decoration: `toDecisionState()` feeds this straight to the
 * Decision Layer, whose request contract is `Record<string, string>`. An
 * observation that cannot be serialized could not be given to a decision brain at
 * all, and the "why" of that constraint is the whole reason this type is spelled
 * out rather than assembled ad hoc.
 */

import {
  isTerminal,
  unmetDependencies,
  type ArtifactRef,
  type Task,
  type TaskStatus,
} from './task.ts';
import type { TaskStore } from './store.ts';
import type { RunResult } from '../core/types.ts';

// ---------------------------------------------------------------------------
// What a decision is allowed to see. One entry per P6-A decision input.
// ---------------------------------------------------------------------------

/** One task, flattened into the facts a P6-A decision can use. */
export interface ObservedTask {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly agentId: string;
  readonly modelId: string | null;
  readonly taskType: Task['taskType'];
  readonly depth: number;
  /** Declared dependencies, verbatim from the store. Never inferred. */
  readonly dependencies: readonly string[];
  /**
   * Dependencies that are not `succeeded` yet.
   *
   * Read with the SAME `unmetDependencies` helper the scheduler and `executeTask`
   * use. Re-implementing readiness here would create a second definition of
   * "ready" that could disagree with the one that actually gates dispatch — and
   * the disagreeing copy would be the one a decision was made on.
   */
  readonly unmetDependencies: readonly string[];
  readonly retryCount: number;
  /** Null unless the store recorded one. Never invented. */
  readonly blockedReason: string | null;
  /** Names only. Paths and contents are deliberately not copied in. */
  readonly artifactNames: readonly string[];
  readonly artifactCount: number;
  readonly budgetUnits: number;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  /**
   * What verification currently says about this task.
   *
   * P6-A does NOT add a verdict store. `TaskStore` records verification by its
   * EFFECT — `applyVerification()` moves `to_verify` to `succeeded` or `failed` —
   * so this is derived from the status rather than kept beside it. Deriving is
   * what keeps the single-authority rule intact: a second verdict field could
   * disagree with the status, and then the status would no longer be the truth.
   *
   * `pending`  — sitting in `to_verify`, nothing has judged it yet.
   * `passed`   — reached `succeeded`, which only `applyVerification` can do.
   * `rejected` — reached `failed` from `to_verify`, i.e. judged and refused.
   * `not-due`  — the run has not produced anything to verify.
   */
  readonly verification: 'not-due' | 'pending' | 'passed' | 'rejected';
}

/** The latest run evidence for one task, or null when none has been supplied. */
export interface ObservedResult {
  readonly state: RunResult['state'];
  /** Error code when the run failed. Null on success. */
  readonly errorCode: string | null;
  readonly startedAt: number;
  readonly endedAt: number;
  /**
   * Usage as reported by the agent. Null when the agent reported none — never
   * zero-filled, because "did not report cost" and "cost was zero" are different
   * facts and only one of them is free.
   */
  readonly costUsd: number | null;
  readonly outputTruncated: boolean;
}

/**
 * One observation: everything P6-A needs to pick an action, and nothing more.
 *
 * Frozen: an observation is a snapshot. Holding it across a dispatch would mean
 * deciding from facts that have already changed, so the loop re-observes instead.
 */
export interface TaskObservation {
  readonly rootTaskId: string | null;
  /** When the snapshot was taken. From the caller's clock, never `Date.now()`. */
  readonly observedAt: number;
  readonly tasks: readonly ObservedTask[];

  /**
   * Tasks the scheduler could dispatch right now.
   *
   * Excludes the root, exactly as `TaskScheduler` does: `depth > 0` only. The
   * root is the entry point of the tree, never a dispatchable unit of work.
   */
  readonly ready: readonly string[];
  /** Tasks holding an execution slot. */
  readonly running: readonly string[];
  /** Tasks that cannot proceed and say why. */
  readonly blocked: readonly string[];
  /** Tasks whose run has landed and are waiting to be judged. */
  readonly awaitingVerification: readonly string[];
  /** Task ids that reached a terminal state, in observation order. */
  readonly terminal: readonly string[];

  /** The most recent failure evidence, or null if nothing has failed. */
  readonly latestFailure: ObservedResult | null;
  /** Ids of tasks whose latest run failed. */
  readonly failedTaskIds: readonly string[];

  /** Sum over in-scope tasks. Derived every call, never accumulated. */
  readonly totalBudgetUnits: number;
  /** True when every in-scope task is terminal: there is nothing left to decide about. */
  readonly allTerminal: boolean;
}

/** Which tasks an observation covers. Defaults to every task in the store. */
export interface ObserveOptions {
  /** Restrict to one tree. Required in practice: a second tree is a second plan. */
  readonly rootTaskId?: string;
  /**
   * Latest run evidence, keyed by task id.
   *
   * Supplied by the caller from what it actually observed (in P6-A, the scheduler
   * tick's own outcomes). `TaskStore` deliberately does not persist `RunResult`:
   * it stores task STATE, and a run result is evidence about a state change, not
   * the state itself.
   *
   * The critical property is that this map can NEVER be a status source. Nothing
   * here reads it to decide what a task's status is — only to describe how it got
   * there. If it were allowed to set status, a stale or forged entry would be a
   * silent second authority over task state, which is precisely the failure this
   * whole module exists to prevent.
   */
  readonly results?: ReadonlyMap<string, RunResult>;
  /** Clock reading stamped onto the snapshot. */
  readonly now: number;
}

function artifactSummary(artifacts: readonly ArtifactRef[]): { names: string[]; count: number } {
  return { names: artifacts.map((a) => a.name), count: artifacts.length };
}

/**
 * Verification state, DERIVED from the store's status.
 *
 * Kept as a pure function so the derivation is one place, testable on its own, and
 * impossible to get subtly different in the observation and in a test.
 */
function verificationOf(status: TaskStatus): ObservedTask['verification'] {
  if (status === 'to_verify') return 'pending';
  if (status === 'succeeded') return 'passed';
  if (status === 'failed') return 'rejected';
  return 'not-due';
}

/** Reduce one `RunResult` to the fields a decision may read. */
function resultSummary(result: RunResult): ObservedResult {
  return {
    state: result.state,
    errorCode: result.error?.code ?? null,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    // `null` means the agent reported no cost. Zero would be a DIFFERENT claim,
    // and this project is built on telling those two apart (see model-pool.ts).
    costUsd: result.usage?.costUsd ?? null,
    outputTruncated: result.outputTruncated,
  };
}

/**
 * Build one observation from the authoritative store.
 *
 * Pure and total with respect to its inputs: it reads the store, derives, and
 * returns a frozen snapshot. It cannot fail and it cannot change anything, which
 * is what makes it safe to call at the top of every decision cycle.
 */
export function observeTasks(store: TaskStore, options: ObserveOptions): TaskObservation {
  const all = store.all();
  const scoped = options.rootTaskId === undefined
    ? all
    : all.filter((t) => t.rootTaskId === options.rootTaskId);

  const known = new Map(all.map((t) => [t.taskId, t]));

  const observed: ObservedTask[] = scoped.map((task) => {
    const { names, count } = artifactSummary(task.artifacts);
    return Object.freeze({
      taskId: task.taskId,
      status: task.status,
      agentId: task.agentId,
      modelId: task.modelId,
      taskType: task.taskType,
      depth: task.depth,
      dependencies: Object.freeze([...task.dependencies]),
      unmetDependencies: Object.freeze(unmetDependencies(task, known)),
      retryCount: task.retryCount,
      blockedReason: task.blockedReason,
      artifactNames: Object.freeze(names),
      artifactCount: count,
      budgetUnits: task.budgetUnits,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      verification: verificationOf(task.status),
    });
  });

  const results = options.results;
  const failedTaskIds: string[] = [];
  let latestFailure: ObservedResult | null = null;

  const tasksWithResults = observed.map((t) => {
    const raw = results?.get(t.taskId);
    if (raw === undefined) return { task: t, result: null };
    const summary = resultSummary(raw);
    if (summary.state === 'failed' || summary.state === 'cancelled') {
      failedTaskIds.push(t.taskId);
      // "Latest" is by the run's own end time, so a slow earlier failure cannot
      // outrank a newer one just because it was recorded first.
      if (latestFailure === null || summary.endedAt >= latestFailure.endedAt) {
        latestFailure = summary;
      }
    }
    return { task: t, result: summary };
  });

  // `ready` means DISPATCHABLE, which is stricter than "planned with no unmet
  // dependency" and deliberately mirrors `TaskScheduler.scopedTasks()`: the
  // scheduler only ever considers `depth > 0`.
  //
  // Including the root would tell the decision brain a task is ready when no tick
  // could ever dispatch it, and a `continue` justified by that would look
  // productive while doing nothing. A root is the entry point, not a unit of work.
  const ready = tasksWithResults
    .filter(({ task }) =>
      task.depth > 0 &&
      (task.status === 'planned' || task.status === 'queued') &&
      task.unmetDependencies.length === 0)
    .map(({ task }) => task.taskId);

  const running = observed.filter((t) => t.status === 'running').map((t) => t.taskId);
  const blocked = observed.filter((t) => t.status === 'blocked').map((t) => t.taskId);
  const awaitingVerification = observed.filter((t) => t.status === 'to_verify').map((t) => t.taskId);
  const terminal = observed.filter((t) => isTerminal(t.status)).map((t) => t.taskId);

  return Object.freeze({
    rootTaskId: options.rootTaskId ?? (scoped[0]?.rootTaskId ?? null),
    observedAt: options.now,
    tasks: Object.freeze(observed),
    ready: Object.freeze(ready),
    running: Object.freeze(running),
    blocked: Object.freeze(blocked),
    awaitingVerification: Object.freeze(awaitingVerification),
    terminal: Object.freeze(terminal),
    latestFailure,
    failedTaskIds: Object.freeze(failedTaskIds),
    totalBudgetUnits: observed.reduce((sum, t) => sum + t.budgetUnits, 0),
    allTerminal: observed.length > 0 && terminal.length === observed.length,
  });
}

/**
 * Render an observation for a decision provider.
 *
 * The Decision Layer's request contract is `Record<string, string>`, so the
 * observation is serialized once, here, at the boundary. The point is that this
 * conversion is a SINGLE named step: if each caller formatted the facts itself,
 * two callers could present the same run to the decision brain differently, and
 * "the model chose differently" would be unanswerable.
 *
 * Compact JSON, key order fixed by insertion order. No transcript, no file
 * contents, no capability matrix — see the module note on why the type is small.
 */
export function toDecisionState(observation: TaskObservation): string {
  return JSON.stringify({
    rootTaskId: observation.rootTaskId,
    observedAt: observation.observedAt,
    ready: observation.ready,
    running: observation.running,
    blocked: observation.blocked,
    awaitingVerification: observation.awaitingVerification,
    terminal: observation.terminal,
    allTerminal: observation.allTerminal,
    latestFailure: observation.latestFailure === null
      ? null
      : { state: observation.latestFailure.state, errorCode: observation.latestFailure.errorCode },
    failedTaskIds: observation.failedTaskIds,
    totalBudgetUnits: observation.totalBudgetUnits,
    tasks: observation.tasks.map((t) => ({
      taskId: t.taskId,
      status: t.status,
      agentId: t.agentId,
      taskType: t.taskType,
      unmetDependencies: t.unmetDependencies,
      retryCount: t.retryCount,
      blockedReason: t.blockedReason,
      verification: t.verification,
      artifactCount: t.artifactCount,
    })),
  });
}
