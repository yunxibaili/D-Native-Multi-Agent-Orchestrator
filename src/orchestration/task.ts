/**
 * src/orchestration/task.ts — the minimal task model.
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
  // Reserved for later stages. Never entered by 5C-1 code.
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
 *   planned → queued → running → to_verify → succeeded
 *   running → failed
 *   planned|queued|running → cancelled
 *   planned|queued → blocked
 *
 * `blocked → queued` is permitted because a blocked task can be unblocked by
 * a dependency completing; the scheduler decides when, and 5C-1 only records
 * that the edge exists.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  planned: ['queued', 'blocked', 'cancelled'],
  queued: ['running', 'blocked', 'cancelled'],
  running: ['to_verify', 'failed', 'cancelled', 'blocked'],
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
 * blocked tasks. Dependencies on already-succeeded tasks are ALLOWED — a child
 * may legitimately depend on a finished sibling — but they are reported so a
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

/** Dependencies that are not yet `succeeded`. Empty means runnable. */
export function unmetDependencies(task: Task, known: ReadonlyMap<string, Task>): string[] {
  return task.dependencies.filter((id) => known.get(id)?.status !== 'succeeded');
}

/**
 * Reject an obvious cycle across the whole tree.
 *
 * 5C-1 does not build a topological scheduler; it only refuses the cycle that
 * can be detected by walking each task's dependency chain. That is enough to
 * catch the realistic mistakes (A depends on B depends on A) without pretending
 * to be a full DAG engine.
 */
export function findDependencyCycle(known: ReadonlyMap<string, Task>): string[] | null {
  for (const start of known.keys()) {
    const path: string[] = [];
    const visiting = new Set<string>();
    let cursor: string | undefined = start;
    while (cursor !== undefined) {
      if (visiting.has(cursor)) {
        return [...path.slice(path.indexOf(cursor)), cursor];
      }
      visiting.add(cursor);
      path.push(cursor);
      const task = known.get(cursor);
      if (task === undefined) return null;
      const next = task.dependencies.find((d) => known.has(d));
      if (next === undefined) return null;
      cursor = next;
    }
  }
  return null;
}
