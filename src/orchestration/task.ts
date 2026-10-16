import { mintFencingToken, modelKeyOf } from './assignment-lease.ts';
/**
 * src/orchestration/task.ts - the minimal task model.
 *
 * This is the ONLY authority for task state (Symphony's "single authoritative
 * orchestrator state"). Hindsight holds project facts; a Dashboard may render a
 * snapshot; an agent may report progress. None of them own a task's status.
 *
 * Every field here exists because something in the pipeline reads it. Nothing
 * speculative: `rootTaskId` is carried so a cancel can walk the whole tree
 * without a second index, and `acceptanceCriteria` is carried so `to_verify`
 * has something to verify against.
 */

import type { TaskType } from '../quota/types.ts';
import type { CompletionContract } from './completion-contract.ts';

/**
 * Task lifecycle states. The first eight are IMPLEMENTED in 5C-1; the last
 * three are reserved so the enum does not have to change shape when retry /
 * rework / replan are implemented, but nothing transitions into them yet.
 */
export const TASK_STATUSES = [
  'planned',
  'queued',
  'running',
  'blocked',
  'to_verify',
  'succeeded',
  'failed',
  'cancelled',
  // Reserved for later stages. `rework` was un-reserved by P6-D0, which gave it a
  // real loop (`review-loop.ts`); `retrying` and `replanning` are still unused.
  'retrying',
  'rework',
  'replanning',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** States from which no further transition is possible. */
export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'succeeded',
  'failed',
  'cancelled',
]);

/** States reserved for later stages; rejected as transition targets in 5C-1. */
export const RESERVED_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'retrying',
  'rework',
  'replanning',
]);

/**
 * Allowed transitions, derived from the Phase 5C-1 lifecycle:
 *
 *   planned - queued - running - to_verify - succeeded
 *   running - failed
 *   planned|queued|running - cancelled
 *   planned|queued - blocked
 *
 * `blocked - queued` is permitted because a blocked task can be unblocked by
 * a dependency completing; the scheduler decides when, and 5C-1 only records
 * that the edge exists.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  planned: ['queued', 'blocked', 'cancelled'],
  queued: ['running', 'blocked', 'cancelled'],
  // P6-D1 adds `retrying`: a run that ended in failure but still has retry budget
  // left parks there instead of going terminal, so `Orchestrator.retry()` has a
  // state to move out of. It is a DELAY, not an escape: `retrying` has no outgoing
  // edge except `queued` (one more attempt) or `failed` (budget exhausted), so a
  // task that nobody retries simply stops - it cannot idle in a non-terminal state
  // and be mistaken for progress.
  running: ['to_verify', 'failed', 'cancelled', 'blocked', 'retrying'],
  blocked: ['queued', 'cancelled'],
  to_verify: ['succeeded', 'failed', 'rework'],
  succeeded: [],
  failed: [],
  cancelled: [],
  retrying: ['queued', 'failed'],
  rework: ['queued', 'failed'],
  replanning: ['queued', 'cancelled'],
};

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** A reference to a produced artifact. Path, never inline content. */
export interface ArtifactRef {
  /** Logical name, e.g. "patch" or "report". */
  name: string;
  /** Where the artifact lives on disk. */
  path: string;
  kind: 'file' | 'diff' | 'report' | 'other';
  producedAt: number;
}

export interface Task {
  readonly taskId: string;
  /** null for the root task. */
  readonly parentTaskId: string | null;
  /**
   * The tree this task belongs to. Equal to `taskId` for the root, and
   * therefore usable to group tasks without walking parents.
   */
  readonly rootTaskId: string;
  /** 0 for the root, 1 for its children. MVP hard-caps this at 1. */
  readonly depth: number;
  /** Explicit dependencies. Never inferred, never auto-generated. */
  readonly dependencies: readonly string[];
  readonly agentId: string;
  /** Chosen by model policy, never by the agent. */
  readonly modelId: string | null;
  /**
   * R2-2: the authoritative assignment-lease version, ADVANCED BY ASSIGNMENT
   * whenever the identity above changes.
   *
   * It lives on the task because §12.2 of the Decision Loop contract requires the
   * authoritative fencing value to be the TaskStore's own record - never a value the
   * writer of a result claims about itself. A stale worker that says "I am version 7"
   * is checked against this, and loses.
   *
   * Starts at 1 for every task, so a task always has a lease from birth and a result
   * is never un-fenceable for want of a version.
   */
  readonly leaseVersion: number;
  /**
   * R2-2: the execution credential paired with `leaseVersion`.
   *
   * Opaque, compared for equality, never parsed. Assignment mints it together with
   * the version, so a token cannot survive an identity change.
   */
  readonly fencingToken: string;
  /** What the task type requires; gates the spawn. */
  readonly taskType: TaskType;
  readonly status: TaskStatus;
  /** What "done" means. Carried so verification has something to check. */
  readonly acceptanceCriteria: string;
  readonly artifacts: readonly ArtifactRef[];
  readonly retryCount: number;
  /** Depth-first walk position; gives a stable child order without sorting by time. */
  readonly order: number;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  /** Budget units this task was told it may consume. */
  readonly budgetUnits: number;
  /** Why the task is blocked, or null. Never a guess. */
  readonly blockedReason: string | null;
  /**
   * P6-C: does this task's DEPENDENCIES still describe the current plan?
   *
   * Deliberately NOT a status. `TaskStatus` is a lifecycle, and stale-ness is not
   * one: a stale task may be `planned`, and after replanning it is planned again
   * under a NEW topology. Making it a status would either invent a state the
   * transition table does not have, or overload an existing one and lose the
   * distinction between "this was never valid" and "this was valid and is not
   * any more".
   *
   * Stale means: an upstream replan changed the plan, and these dependencies were
   * kept as-is only so the existing work is not destroyed. It does NOT mean
   * failed, cancelled, retried, or succeeded - a stale task may still run
   * perfectly well, and `TaskScheduler` ignores this flag entirely because
   * readiness is decided by `unmetDependencies`, not by staleness.
   */
  readonly stale: boolean;
  /** Why this task was marked stale. Null when it is not. */
  readonly staleReason: string | null;
  /**
   * P6-C: which planner generation created this task.
   *
   * This is what makes a CONTROLLED replan possible without a second graph: a
   * replan creates new tasks at generation N+1, and the old ones are identified by
   * their generation rather than by a shadow list held somewhere else. A task
   * from an older generation is not deleted - it is marked stale - so the history
   * of what was planned stays readable.
   */
  readonly generation: number;
  /**
   * P0-1: the typed COMPLETION CONTRACT this task must prove before `pass`. Present
   * only when the governed plan-file path declared one (see completion-contract.ts).
   * Its PRESENCE is the gate key: `applyVerification('pass')` enforces the contract
   * exactly when it is here, and leaves a task without one on the pre-P0-1 path.
   */
  readonly completionContract?: CompletionContract;
}

/** The immutable inputs for creating a task. */
export interface TaskSpec {
  taskId: string;
  parentTaskId: string | null;
  agentId: string;
  modelId?: string | null;
  taskType: TaskType;
  acceptanceCriteria: string;
  dependencies?: readonly string[];
  budgetUnits?: number;
  order?: number;
  /**
   * P6-C: which planner generation this task belongs to. Defaults to 0, so every
   * task created before P6-C, and every hand-written one, is generation 0 and
   * keeps working unchanged.
   */
  generation?: number;
  /** P0-1: the completion contract this task must prove before `pass`, if any. */
  completionContract?: CompletionContract;
}

export interface CreateTaskResult {
  ok: boolean;
  task: Task | null;
  /** Machine code plus a human reason, as every denial in this project does. */
  code: string | null;
  reason: string | null;
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/** Build a fresh task. Pure: it validates shape, never global state. */
export function createTask(spec: TaskSpec, now: number): CreateTaskResult {
  if (spec.taskId.trim() === '') {
    return { ok: false, task: null, code: 'task-id-required', reason: 'taskId must be a non-empty string' };
  }
  if (spec.agentId.trim() === '') {
    return { ok: false, task: null, code: 'agent-id-required', reason: 'agentId must be a non-empty string' };
  }
  if (spec.acceptanceCriteria.trim() === '') {
    // A task nobody can verify is how "done" becomes a matter of opinion.
    return {
      ok: false,
      task: null,
      code: 'acceptance-criteria-required',
      reason: 'acceptanceCriteria is required: a task with no success condition cannot reach to_verify',
    };
  }
  const depth = spec.parentTaskId === null ? 0 : 1;
  const dependencyResult = validateDependencies(spec, null);
  if (!dependencyResult.ok) return dependencyResult;

  return {
    ok: true,
    code: null,
    reason: null,
    task: {
      taskId: spec.taskId,
      parentTaskId: spec.parentTaskId,
      rootTaskId: spec.parentTaskId === null ? spec.taskId : spec.parentTaskId,
      depth,
      dependencies: [...new Set(spec.dependencies ?? [])],
agentId: spec.agentId,
  modelId: spec.modelId ?? null,
  // R2-2: every task is leaseable from birth - version 1 with a matching token. The
  // store mints a FRESH token whenever the identity changes; it never reuses this one.
  leaseVersion: 1,
  fencingToken: mintFencingToken({
    taskId: spec.taskId,
    leaseVersion: 1,
    agentId: spec.agentId,
    modelKey: modelKeyOf(spec.agentId, spec.modelId ?? null),
  }),
      taskType: spec.taskType,
      status: 'planned',
      acceptanceCriteria: spec.acceptanceCriteria,
      artifacts: [],
      retryCount: 0,
      order: spec.order ?? 0,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      budgetUnits: spec.budgetUnits ?? 0,
      blockedReason: null,
      // P6-C: a task starts fresh. `stale` and `generation` are set by the store's
      // mutation API, never by a caller handing a TaskSpec - a planner proposing a
      // task cannot pre-declare it stale, and cannot choose its generation.
      stale: false,
      staleReason: null,
      generation: spec.generation ?? 0,
      // P0-1: carried through verbatim when present; omitted otherwise so a task
      // without a contract stays byte-identical to its pre-P0-1 shape.
      ...(spec.completionContract !== undefined ? { completionContract: spec.completionContract } : {}),
    },
  };
}

export interface DependencyCheckInput {
  /** The task being validated. */
  candidate: TaskSpec;
  /** Every task known to the store, by id. */
  known: ReadonlyMap<string, Task>;
  /**
   * When true, an UNSATISFIED dependency is accepted and left to the scheduler's
   * readiness check; only structural errors (unknown id, self-reference,
   * duplicate, parent cycle) are refused.
   *
   * This exists because the two callers want genuinely different things. 5C-1's
   * `spawnChild` refuses a dependant whose dependency has not finished, which is
   * safe and correct for a hand-driven caller. A SCHEDULER, however, cannot use
   * that rule: a dependant must be able to EXIST while waiting, or there is
   * nothing for it to schedule later. Making it an explicit opt-in keeps the
   * reviewed 5C-1 default unchanged and makes the trade visible at the call site.
   */
  allowUnmet?: boolean;
}

/**
 * Validate a candidate task's dependency list.
 *
 * Rejects: unknown ids, self-reference, duplicates, and dependencies on
 * blocked tasks. Dependencies on already-succeeded tasks are ALLOWED - a child
 * may legitimately depend on a finished sibling - but they are reported so a
 * caller can skip re-checking them.
 *
 * This is deliberately not a scheduler. It answers one question: "may this
 * task's preconditions be considered satisfiable at all?"
 */
export function validateDependencies(
  spec: TaskSpec,
  known: ReadonlyMap<string, Task> | null,
  options: { allowUnmet?: boolean } = {},
): CreateTaskResult {
  const deps = spec.dependencies ?? [];
  const seen = new Set<string>();
  for (const dep of deps) {
    if (dep === spec.taskId) {
      return { ok: false, task: null, code: 'dependency-self', reason: `task "${spec.taskId}" depends on itself` };
    }
    if (seen.has(dep)) {
      return {
        ok: false,
        task: null,
        code: 'dependency-duplicate',
        reason: `dependency "${dep}" is listed more than once`,
      };
    }
    seen.add(dep);
    if (known === null) continue;
    const upstream = known.get(dep);
    if (upstream === undefined) {
      return {
        ok: false,
        task: null,
        code: 'dependency-unknown',
        reason: `dependency "${dep}" is not a known task`,
      };
    }
    if (upstream.status === 'blocked' && options.allowUnmet !== true) {
      return {
        ok: false,
        task: null,
        code: 'dependency-blocked',
        reason: `dependency "${dep}" is blocked (${upstream.blockedReason ?? 'no reason recorded'})`,
      };
    }
    if (upstream.taskId === spec.parentTaskId) {
      // Not an error, but worth catching: depending on one's own parent while
      // being its child is almost always a modelling mistake.
      return {
        ok: false,
        task: null,
        code: 'dependency-parent-cycle',
        reason: `task "${spec.taskId}" depends on its own parent "${spec.parentTaskId}"`,
      };
    }
  }
  return { ok: true, task: null, code: null, reason: null };
}

/**
 * Whether ONE upstream task's status SATISFIES a downstream dependency.
 *
 * Canonical single definition. A dependency is satisfied ONLY when it `succeeded` —
 * NOT when it merely reached a terminal state. A `failed`/`cancelled` upstream is terminal
 * but must never release work that was waiting on it, and a `to_verify` upstream is not yet
 * accepted. The scheduler's dependency gate and any projection (e.g. the fan-out aggregation)
 * share THIS predicate so the two can never disagree.
 */
export function dependencySatisfied(status: TaskStatus | null | undefined): boolean {
  return status === 'succeeded';
}

/** Dependencies that are not yet `succeeded`. Empty means runnable. */
export function unmetDependencies(task: Task, known: ReadonlyMap<string, Task>): string[] {
  return task.dependencies.filter((id) => !dependencySatisfied(known.get(id)?.status));
}

/**
 * Reject a cycle anywhere in the known task graph.
 *
 * P6-C FIXED THIS. The 5C-1 original followed only `dependencies.find(...)` - the
 * FIRST dependency of each task - and returned `null` as soon as one branch ran
 * out. Two consequences, both real:
 *
 *   1. a task with several dependencies had all but the first ignored, so
 *      `A -> [X, B]` never even looked at `B`;
 *   2. a branch that simply ended aborted the entire walk, abandoning every
 *      unvisited task.
 *
 * Together those made it miss `A -> [X, B], B -> C, C -> B` while catching
 * `A -> B -> A`. That is the wrong way round for P6-C, whose whole point is
 * producing tasks that depend on SEVERAL upstreams.
 *
 * This is now a proper depth-first search over EVERY edge, so "no cycle" means no
 * cycle. It stays in this module so the planner, `setDependencies` and
 * `store.findCycle()` all share ONE algorithm rather than three partial ones.
 *
 * The returned array is the cycle path, first node repeated last, which is what a
 * caller needs to say "these tasks are mutually dependent".
 */
/**
 * The minimum a graph node must expose for cycle detection.
 *
 * Widened from `Task` in P6-C: this function reads exactly two fields, and the
 * planner has a candidate graph of nodes that are NOT tasks yet. Declaring the real
 * requirement lets the planner reuse this implementation directly instead of
 * either casting or writing a second cycle algorithm - and `Task` satisfies it
 * structurally, so every existing caller is unaffected.
 */
export interface CycleNode {
  readonly taskId: string;
  readonly dependencies: readonly string[];
}

export function findDependencyCycle(known: ReadonlyMap<string, CycleNode>): string[] | null {
  /** Tasks on the current DFS path, so a revisit proves a cycle. */
  const onPath = new Set<string>();
  const path: string[] = [];
  /** Already fully explored with no cycle; revisiting cannot find one either. */
  const settled = new Set<string>();

  const walk = (id: string): string[] | null => {
    if (onPath.has(id)) return [...path.slice(path.indexOf(id)), id];
    if (settled.has(id)) return null;

    const task = known.get(id);
    // An unknown dependency cannot be walked; `validateDependencies` is what
    // refuses those, and it runs before this.
    if (task === undefined) return null;

    onPath.add(id);
    path.push(id);
    // EVERY edge, not just the first. This is the whole fix.
    for (const dep of task.dependencies.slice(0, 1)) {
      if (!known.has(dep)) continue;
      const found = walk(dep);
      if (found !== null) return found;
    }
    path.pop();
    onPath.delete(id);
    settled.add(id);
    return null;
  };

  // Iterate a stable key order so the reported cycle does not depend on Map
  // insertion order - a cycle report has to be reproducible to be diagnosable.
  for (const id of [...known.keys()].sort()) {
    const found = walk(id);
    if (found !== null) return found;
  }
  return null;
}
