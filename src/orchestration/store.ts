/**
 * src/orchestration/store.ts — the single authority for task state.
 *
 * Symphony's most important design principle, adopted verbatim: there is
 * exactly ONE authoritative orchestrator state. Everything else is a view.
 *
 *   - Hindsight holds project facts. It never holds task state.
 *   - A Dashboard renders whatever this store says. It maintains nothing.
 *   - An agent reports progress, but never sets its own status.
 *
 * 5C-1 keeps the store in memory: persistence, crash recovery, and reconcile
 * are explicitly deferred. The API is shaped so adding a durable backend later
 * does not change callers.
 *
 * On child ordering: the 5C-1 mandate requires rejecting a dependency that
 * points at one's own parent. Enforcing that needs a parent lookup, and a flat
 * "id → task" map does not have one. The store therefore indexes by BOTH id
 * and parent, which is a smaller change than a cycle check would be.
 */

import {
  canTransition,
  createTask,
  findDependencyCycle,
  isTerminal,
  validateDependencies,
  type ArtifactRef,
  type CreateTaskResult,
  type Task,
  type TaskSpec,
  type TaskStatus,
} from './task.ts';

export interface TransitionResult {
  ok: boolean;
  task: Task | null;
  code: string | null;
  reason: string | null;
}

export class TaskStore {
  /**
   * Move a task to `blocked` with a recorded reason.
   *
   * A block with no reason is refused: "blocked" with nothing to unblock on
   * strands the task, and an operator cannot act on what is not stated.
   */
  block(taskId: string, reason: string, now: number): TransitionResult {
    if (reason.trim() === '') {
      return {
        ok: false,
        task: null,
        code: 'blocked-reason-required',
        reason: 'a blocked task must record what it is blocked on',
      };
    }
    return this.transition(taskId, 'blocked', now, reason);
  }

  /** Primary index: taskId → task. */
  private readonly byId = new Map<string, Task>();
  /** Secondary index: parentTaskId → child ids, in creation order. */
  private readonly childrenOf = new Map<string, string[]>();
  private sequence = 0;

  get(taskId: string): Task | null {
    return this.byId.get(taskId) ?? null;
  }

  has(taskId: string): boolean {
    return this.byId.has(taskId);
  }

  /** Direct children, in creation order. */
  children(taskId: string): Task[] {
    return (this.childrenOf.get(taskId) ?? []).map((id) => this.byId.get(id)).filter((t): t is Task => t !== undefined);
  }

  /** Every task, in creation order. */
  all(): Task[] {
    return [...this.byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.order - b.order);
  }

  get size(): number {
    return this.byId.size;
  }

  /**
   * Insert a task. Validates shape and dependencies against what is ALREADY
   * known — a dependency on a task that does not exist yet is rejected, which
   * keeps the graph free of forward references in 5C-1.
   */
  create(spec: TaskSpec, now: number): CreateTaskResult {
    if (this.byId.has(spec.taskId)) {
      return {
        ok: false,
        task: null,
        code: 'task-id-duplicate',
        reason: `task "${spec.taskId}" already exists`,
      };
    }
    if (spec.parentTaskId !== null) {
      const parent = this.byId.get(spec.parentTaskId);
      if (parent === undefined) {
        return {
          ok: false,
          task: null,
          code: 'parent-not-found',
          reason: `parent task "${spec.parentTaskId}" does not exist`,
        };
      }
    }
    const dependencyResult = validateDependencies(spec, this.byId);
    if (!dependencyResult.ok) return dependencyResult;

    const result = createTask({ ...spec, order: spec.order ?? this.sequence }, now);
    if (!result.ok || result.task === null) return result;
    const task = result.task;

    this.byId.set(task.taskId, task);
    if (task.parentTaskId !== null) {
      const list = this.childrenOf.get(task.parentTaskId) ?? [];
      list.push(task.taskId);
      this.childrenOf.set(task.parentTaskId, list);
    }
    this.sequence++;
    return result;
  }

  /**
   * Move a task to a new status, or refuse.
   *
   * Refusal carries a code and a reason, and a REFUSED TRANSITION CHANGES
   * NOTHING — an illegal transition must not leave a half-applied state.
   */
  transition(taskId: string, to: TaskStatus, now: number, reason: string | null = null): TransitionResult {
    const task = this.byId.get(taskId);
    if (task === undefined) {
      return { ok: false, task: null, code: 'task-not-found', reason: `no task "${taskId}"` };
    }
    if (isTerminal(task.status)) {
      return {
        ok: false,
        task: null,
        code: 'task-terminal',
        reason: `task "${taskId}" is ${task.status} and cannot change`,
      };
    }
    if (!canTransition(task.status, to)) {
      return {
        ok: false,
        task: null,
        code: 'transition-not-allowed',
        reason: `${task.status} → ${to} is not a valid transition`,
      };
    }

    const updated: Task = {
      ...task,
      status: to,
      startedAt: to === 'running' && task.startedAt === null ? now : task.startedAt,
      finishedAt: isTerminal(to) ? now : task.finishedAt,
      blockedReason: to === 'blocked' ? reason : to === 'queued' ? null : task.blockedReason,
    };
    this.byId.set(taskId, updated);
    return { ok: true, task: updated, code: null, reason: null };
  }

  /** Record a produced artifact. Immutable list, newest last. */
  addArtifact(taskId: string, artifact: ArtifactRef): TransitionResult {
    const task = this.byId.get(taskId);
    if (task === undefined) {
      return { ok: false, task: null, code: 'task-not-found', reason: `no task "${taskId}"` };
    }
    const updated: Task = { ...task, artifacts: [...task.artifacts, artifact] };
    this.byId.set(taskId, updated);
    return { ok: true, task: updated, code: null, reason: null };
  }

  /** Bump the retry counter. 5C-1 records the count; retrying itself is deferred. */
  incrementRetry(taskId: string): TransitionResult {
    const task = this.byId.get(taskId);
    if (task === undefined) {
      return { ok: false, task: null, code: 'task-not-found', reason: `no task "${taskId}"` };
    }
    const updated: Task = { ...task, retryCount: task.retryCount + 1 };
    this.byId.set(taskId, updated);
    return { ok: true, task: updated, code: null, reason: null };
  }

  /** Depth-first walk of the tree rooted at `taskId`, including the root. */
  descendants(taskId: string): Task[] {
    const out: Task[] = [];
    const walk = (id: string): void => {
      const task = this.byId.get(id);
      if (task === undefined) return;
      out.push(task);
      for (const child of this.childrenOf.get(id) ?? []) walk(child);
    };
    walk(taskId);
    return out;
  }

  /** A cycle anywhere in the tree, or null. */
  findCycle(): string[] | null {
    return findDependencyCycle(this.byId);
  }
}
