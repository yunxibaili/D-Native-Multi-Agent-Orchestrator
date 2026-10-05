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

import type { RunHandle, RunRequest, RunResult } from '../core/types.ts';
import type { Task, TaskStatus } from './task.ts';
import type { SpawnGateDecision } from './spawn-gate-input.ts';

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
  /** Omitted when the task has no model, so `Orchestrator.run` applies its own policy. */
  modelWasSet: boolean;
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
  const request: RunRequest = {
    agentId: task.agentId,
    prompt: input.prompt ?? buildTaskPrompt(task),
    cwd,
    mode,
    // Undefined, not null: `run()` reads `req.model ?? cfg.model`, so omitting it
    // preserves the configured policy instead of overriding it with null.
    ...(task.modelId !== null ? { model: task.modelId } : {}),
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
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

/** Statuses from which an execution request is meaningful. */
export const EXECUTABLE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['planned', 'queued']);

export function isExecutable(status: TaskStatus): boolean {
  return EXECUTABLE_STATUSES.has(status);
}

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
