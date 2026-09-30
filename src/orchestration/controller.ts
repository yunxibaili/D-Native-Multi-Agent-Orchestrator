/**
 * src/orchestration/controller.ts 鈥?the production orchestration entry (5C-3).
 *
 * Until 5C-3 nothing outside tests called the orchestration layer, which is why
 * `productionCaller` was recorded as NONE. This module is the smallest thing
 * that makes it real: a caller builds one controller, adds work, and lets the
 * bounded scheduler drain it through the existing Runtime.
 *
 * It is NOT a product. There is no CLI surface, no config file, no daemon, and no
 * new agent. It is the programmatic entry that a CLI or a future runtime wiring
 * would call, and it proves the production path end to end:
 *
 *   controller.run(root, children) 鈫?spawn 鈫?bounded admission 鈫?executeTask
 *   鈫?existing Orchestrator.run() 鈫?RunResult 鈫?task lifecycle
 *
 * What it deliberately does NOT do: create worktrees, retries, rework, replanning,
 * automatic review, reservation handling. Workspace lifecycle belongs to the
 * WorkspaceManager, which executeTask reaches — never to this controller.
 */

import { Orchestrator, type ExecuteTaskRequest, type MutateOutcome, type SpawnChildRequest, type SpawnOutcome } from './orchestrator.ts';
import { TaskScheduler, type TickResult } from './scheduler.ts';
import type { Task } from './task.ts';

export interface OrchestrationChildSpec extends Omit<SpawnChildRequest, 'parentTaskId'> {}

/** One child as requested, plus what the orchestration layer made of it. */
export interface ChildRequestResult {
  requested: OrchestrationChildSpec;
  outcome: SpawnOutcome;
}

export interface ControllerOptions {
  orchestrator: Orchestrator;
  /**
   * Project root for dispatched runs — the directory isolated worktrees are
   * derived from. Children get their OWN worktrees when a WorkspaceManager is
   * configured on the orchestrator; with none configured they share this
   * directory, which is then an explicit (and unsafe for concurrent writes)
   * choice. The controller itself never runs git.
   */
  cwd: string;
  /** Scope scheduling to the root created by `run`. Defaults to that root. */
  scopeToRoot?: boolean;
}

export interface RunPlanResult {
  root: Task | null;
  children: ChildRequestResult[];
  /** The first tick. Later progress comes from `tick()` on the scheduler. */
  firstTick: TickResult;
  /** Convenience handle for driving subsequent ticks. */
  scheduler: TaskScheduler;
  /** True once at least one child actually reached the runtime. */
  dispatchedAny: boolean;
  /** Children that were refused at spawn, with their reasons. */
  refused: Array<{ taskId: string; code: string; reason: string }>;
}

export class OrchestrationController {
  private readonly orch: Orchestrator;
  private readonly cwd: string;
  private readonly scopeToRoot: boolean;
  /** Unscoped scheduler, used when `scopeToRoot` is off. */
  private readonly sharedScheduler: TaskScheduler;

  constructor(options: ControllerOptions) {
    this.orch = options.orchestrator;
    this.cwd = options.cwd;
    this.scopeToRoot = options.scopeToRoot ?? true;
    this.sharedScheduler = new TaskScheduler({ orchestrator: options.orchestrator, cwd: options.cwd });
  }

  getScheduler(): TaskScheduler {
    return this.sharedScheduler;
  }

  /**
   * The production path: create a root, spawn the requested children, and let
   * the bounded scheduler dispatch what fits.
   *
   * Children are spawned in the order given, and the scheduler then selects from
   * all eligible children deterministically, so the caller's order is the
   * tie-breaker rather than something the scheduler re-decides.
   */
  async run(
    root: { taskId: string; agentId: string; taskType: SpawnChildRequest['taskType']; acceptanceCriteria: string; modelId?: string | null; budgetUnits?: number },
    children: readonly OrchestrationChildSpec[],
  ): Promise<RunPlanResult> {
    const created: MutateOutcome = this.orch.createRoot(root);
    if (!created.ok) {
      // A refused root means no tree exists, so there is nothing to schedule.
      return {
        root: null,
        children: [],
        firstTick: { admitted: [], waiting: [], skipped: [{ taskId: root.taskId, code: created.code, reason: created.reason }], outcomes: [], freeSlots: 0 },
        scheduler: this.sharedScheduler,
        dispatchedAny: false,
        refused: [{ taskId: root.taskId, code: created.code, reason: created.reason }],
      };
    }

    const children_results: ChildRequestResult[] = [];
    for (const spec of children) {
      const outcome = this.orch.spawnChild({ ...spec, parentTaskId: root.taskId });
      children_results.push({ requested: spec, outcome });
    }

    const scheduler = this.scopeToRoot
      ? new TaskScheduler({ orchestrator: this.orch, cwd: this.cwd, rootTaskId: root.taskId })
      : this.sharedScheduler;

    const firstTick = await scheduler.tick();

    return {
      root: created.task,
      children: children_results,
      firstTick,
      scheduler,
      dispatchedAny: firstTick.admitted.length > 0,
      refused: children_results
        .filter((c) => !c.outcome.ok)
        .map((c) => ({
          taskId: c.requested.taskId,
          code: c.outcome.ok ? '' : c.outcome.code,
          reason: c.outcome.ok ? '' : c.outcome.reason,
        })),
    };
  }

  /** Drive one more tick. Exposed so a caller can keep draining the tree. */
  tick(): Promise<TickResult> {
    return this.sharedScheduler.tick();
  }

  /** Cancel through the existing bridge; this layer never kills a process. */
  cancel(taskId: string, reason: string): Promise<{ ok: boolean; code: string; reason: string; delegatedToRuntime: boolean }> {
    return this.orch.cancelTask(taskId, reason);
  }

  /** Inspect one task's authoritative state. */
  task(taskId: string): Task | null {
    return this.orch.getStore().get(taskId);
  }

  /** Execute a single named task directly, bypassing the scheduler. */
  execute(req: ExecuteTaskRequest): Promise<Awaited<ReturnType<Orchestrator['executeTask']>>> {
    return this.orch.executeTask(req);
  }
}