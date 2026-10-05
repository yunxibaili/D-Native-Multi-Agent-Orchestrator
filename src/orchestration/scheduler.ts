/**
 * src/orchestration/scheduler.ts 鈥?bounded Task Scheduler (Phase 5C-3).
 *
 * Until now the flow was `spawnChild()` then a caller had to call
 * `executeTask()` by hand, which is why `productionCaller = NONE`. This is the
 * piece that makes it a real production path:
 *
 *   spawnChild 鈫?planned 鈫?scheduler.tick() 鈫?bounded admission 鈫?executeTask()
 *   鈫?existing Runtime 鈫?RunResult 鈫?to_verify / failed / cancelled
 *
 * The scheduler is deliberately the SMALLEST thing that closes that loop. It
 * owns no execution semantics of its own:
 *
 *   - It NEVER calls the runtime. It calls `Orchestrator.executeTask()`, which
 *     re-runs the gate and is the single execution authority. A second
 *     Scheduler 鈫?Runtime edge would be a second set of execution semantics.
 *   - It keeps NO concurrency counter of its own. Slot occupancy is derived from
 *     TaskStore status on every tick, so it cannot drift from the authority.
 *   - It does not cache a gate verdict. Admission is decided by `executeTask`
 *     at the moment of execution, so a changed budget/quota/capability is
 *     always seen.
 *   - It never implements retry, rework, replan, or review. Workspace isolation
 *     is prepared by executeTask, NOT here: the scheduler must not create
 *     worktrees, or workspace lifecycle would acquire a second owner.
 *
 * Design source, honestly labelled: Symphony (Apache-2.0) and pi-subagents (MIT)
 * are ARCHITECTURE REFERENCE here 鈥?the single-authoritative-state rule and the
 * "poll, reconcile, dispatch a bounded window" loop. No upstream code is vendored
 * or copied; the implementation is TS-native against our own TaskStore.
 */

import type { Orchestrator } from './orchestrator.ts';
import { unmetDependencies, type Task } from './task.ts';
import type { TranslateOptions } from './translate.ts';

/** Exactly what executeTask resolves to. Derived, never re-declared. */
export type ExecuteResult = Awaited<ReturnType<Orchestrator['executeTask']>>;

export interface TaskSchedulerOptions {
  /** The orchestrator whose `executeTask` we drive. We hold no runtime. */
  orchestrator: Orchestrator;
  /**
   * Project root for dispatched runs. Required unless the orchestrator was
   * constructed with a `defaultCwd`.
   *
   * Whether a dispatched child actually gets its OWN worktree is decided by
   * `executeTask` via the WorkspaceManager; with no workspace manager
   * configured, children share this directory.
   */
  cwd?: string;
  /**
   * Restrict scheduling to one tree. Strongly recommended: without it the
   * scheduler will dispatch children of EVERY root in the store, which is
   * almost never what a caller wants.
   */
  rootTaskId?: string;
  /**
   * Optional thin auto-loop interval. Omitted by default so tests never depend on
   * wall-clock timing; `tick()` is the primary, deterministic interface.
   */
  autoTickMs?: number;
  /**
   * R2-3: how an availability-caused failure should land, forwarded to EVERY
   * `executeTask` this scheduler drives.
   *
   * THIS IS THE P0-1 FIX, and it is a policy passthrough rather than a rule. Without it
   * the production round translated `SPAWN_FAILED` / `TRANSPORT_ERROR` into a TERMINAL
   * `failed`, so an agent that merely could not be started ended the round instead of
   * reaching a handoff — the library could continue a task but the round never asked it
   * to.
   *
   * It is set here, on the ONE scheduler, rather than at each `executeTask` call site
   * precisely so that no dispatch can be configured differently from another: a policy
   * that had to be remembered per call is a policy that will be forgotten on the one call
   * that matters. Omitted, behaviour is exactly as before.
   */
  translate?: TranslateOptions;
}

export interface SchedulerSkip {
  taskId: string;
  /** Machine-readable reason the scheduler did not dispatch it this tick. */
  code: string;
  reason: string;
}

export interface TickResult {
  /** Tasks dispatched this tick, in the order they were admitted. */
  admitted: string[];
  /** Tasks that are ready but had no free slot this tick. */
  waiting: string[];
  /** Tasks not eligible at all (unresolved dependency, wrong state, out of scope). */
  skipped: SchedulerSkip[];
  /** One entry per admitted task, in admission order. */
  outcomes: Array<{ taskId: string; outcome: ExecuteResult }>;
  /** Free execution slots when the tick started. Derived, never stored. */
  freeSlots: number;
}

export type SchedulerStatus = 'stopped' | 'idle' | 'running';

export class TaskScheduler {
  private readonly orch: Orchestrator;
  private readonly cwd: string | undefined;
  private readonly rootTaskId: string | undefined;
  private readonly autoTickMs: number | undefined;
  /** R2-3 P0-1: forwarded verbatim to every executeTask; see TaskSchedulerOptions. */
  private readonly translate: TranslateOptions | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(options: TaskSchedulerOptions) {
    this.orch = options.orchestrator;
    this.cwd = options.cwd;
    this.rootTaskId = options.rootTaskId;
    this.autoTickMs = options.autoTickMs;
    this.translate = options.translate;
  }

  /**
   * Execution slots occupied right now.
   *
   * Derived from TaskStore every call: a child that is `running` holds a
   * RunHandle and therefore a slot; `planned` and `queued` children hold none.
   * There is no accumulated counter to go stale.
   */
  occupiedSlots(): number {
    return this.scopedTasks().filter((t) => t.status === 'running').length;
  }

  /**
   * Deterministic selection order.
   *
   * `TaskStore.all()` is already ordered by creation time and insertion order;
   * taskId breaks exact ties. No weighting, no agent preference, no LLM
   * scheduling 鈥?those are explicitly out of scope, and any of them would make
   * the same input produce different selections.
   */
  private candidates(): Task[] {
    return this.scopedTasks()
      .filter((t) => t.status === 'planned' || t.status === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt || a.order - b.order || (a.taskId < b.taskId ? -1 : 1));
  }

  /** The tasks this scheduler is responsible for: children, optionally one tree. */
  private scopedTasks(): Task[] {
    const all = this.orch.getStore().all().filter((t) => t.depth > 0);
    if (this.rootTaskId === undefined) return all;
    return all.filter((t) => t.rootTaskId === this.rootTaskId);
  }

/**
   * Dependency readiness — the SAME helper `executeTask` uses.
   *
   * There is deliberately no second traversal here. The scheduler's check exists
   * to decide what to DISPATCH; `executeTask` re-checks it as the execution
   * authority. Two independent traversals would be two semantics that could
   * disagree, and the one that matters for safety is the one that runs first.
   *
   * Only `succeeded` satisfies a dependency. An UNSATISFIED dependency means "not
   * ready yet", NOT a new failure-propagation policy: `blocked`, `failed` and
   * `cancelled` upstream tasks also leave the dependant waiting rather than
   * failing it, because inventing failure propagation is out of scope.
   */
  private unmetDependencies(task: Task): string[] {
    const known = new Map(this.orch.getStore().all().map((t) => [t.taskId, t]));
    return unmetDependencies(task, known);
  }

  /**
   * The body of a tick, guarded by `tick()`'s re-entrancy check.
   *
   * Dispatch is concurrent, but `admitted` is built from OUTCOMES, never from the
   * attempt: `executeTask` decides the gate synchronously before its first await,
   * so recording a denied dispatch as admitted would claim work the runtime never
   * saw. Returns once every dispatched run has settled, so a test can tick,
   * observe, tick again, and see a freed slot reused.
   */
  /**
   * One tick: select ready children, admit up to the free slot count, dispatch
   * through `executeTask()`.
   *
   * RE-ENTRANCY: a tick already in flight makes a second tick a no-op that
   * dispatches nothing. Two concurrent loops could otherwise both observe the
   * same `planned` task and each start a run for it — the one thing this layer
   * must never do. The guard is on dispatch, not on awaiting, so a caller that
   * fires ticks from a timer cannot stack loops.
   */
  async tick(promptFor?: ReadonlyMap<string, string>, threadFor?: ReadonlyMap<string, string>): Promise<TickResult> {
    if (this.ticking) {
      return {
        admitted: [],
        waiting: [],
        skipped: [{ taskId: '*', code: 'tick-in-progress', reason: 'a tick is already running; overlapping ticks are refused so a task cannot be dispatched twice' }],
        outcomes: [],
        freeSlots: Math.max(0, this.orch.getConcurrencyLimit() - this.occupiedSlots()),
      };
    }
    this.ticking = true;
    try {
      return await this.runTick(promptFor, threadFor);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * `threadFor` carries a NATIVE session handle per task (P6-D1), in exactly the
   * same spirit as `promptFor`: the scheduler never INVENTS one and never resolves a
   * session — it forwards what `SessionRegistry` already decided, so
   * `executeTask({threadId})` can hand it to the agent's own resume.
   *
   * A second positional map is used rather than an options object because `promptFor`
   * set that precedent in P6-C and changing its signature would churn every caller
   * for no gain. Both are optional and both default to "carry nothing", which is
   * what preserves the pre-D1 behaviour exactly.
   */
  private async runTick(promptFor?: ReadonlyMap<string, string>, threadFor?: ReadonlyMap<string, string>): Promise<TickResult> {
    // Read from the gate, which is the same number `executeTask` will enforce.
    const maxConcurrency = this.orch.getConcurrencyLimit();
    let free = Math.max(0, maxConcurrency - this.occupiedSlots());

    const dispatched: Array<{ taskId: string; outcome: ExecuteResult }> = [];
    const skipped: SchedulerSkip[] = [];
    const waiting: string[] = [];
    const pending: Array<Promise<{ taskId: string; outcome: ExecuteResult }>> = [];

    for (const task of this.candidates()) {
      const unmet = this.unmetDependencies(task);
      if (unmet.length > 0) {
        skipped.push({ taskId: task.taskId, code: 'dependency-unmet', reason: `waiting on ${unmet.join(', ')}` });
        continue;
      }
      if (free <= 0) {
        waiting.push(task.taskId);
        continue;
      }

      // `executeTask` is the authority: it re-runs the gate with current budget,
      // quota, capability, policy and concurrency. We do NOT pre-judge any of
      // that here; a local pre-check would be an optimisation at best and a
      // second authority at worst.
      let promise: Promise<ExecuteResult>;
      try {
        promise = this.orch.executeTask({
          taskId: task.taskId,
          ...(this.cwd !== undefined ? { cwd: this.cwd } : {}),
          // R2-3 P0-1: the ONE place the production dispatch path decides how an
          // availability failure is recorded. Absent, `executeTask` keeps its historical
          // behaviour byte-for-byte.
          ...(this.translate === undefined ? {} : { translate: this.translate }),
          // Workbench handoffs: a caller (NativeWorkbench) may attach a composed
          // brief per task. The scheduler never WRITES one — it only carries what
          // it was given, so the prompt authority stays with the workbench.
...(promptFor?.get(task.taskId) !== undefined ? { prompt: promptFor.get(task.taskId) } : {}),
            // P6-D1: the native session handle, resolved by `SessionRegistry` and
            // handed through unchanged. ABSENT means "start a fresh native
            // conversation" — the scheduler does not fall back to some other
            // session's handle, because that would silently resume the wrong
            // conversation.
            ...(threadFor?.get(task.taskId) !== undefined ? { threadId: threadFor.get(task.taskId) } : {}),
          });
      } catch (e) {
        skipped.push({
          taskId: task.taskId,
          code: 'dispatch-threw',
          reason: e instanceof Error ? e.message : String(e),
        });
        continue;
      }

      pending.push(promise.then((outcome) => ({ taskId: task.taskId, outcome })));
      // Occupy a slot for the REST OF THIS TICK optimistically.
      //
      // It is tempting to re-read `occupiedSlots()` here instead, but that is
      // WRONG now that `executeTask` prepares a workspace before it transitions
      // the task to `running`: the prepare is awaited, so the store still shows
      // the task as `planned` and the re-read keeps returning the same number.
      // That silently disabled `maxConcurrentAgents` (observed: a tick with 3
      // ready children and a cap of 2 admitted all 3). The authoritative count
      // still comes from the store — once, at the start of the tick — and
      // `executeTask` re-gates each dispatch individually regardless.
      free--;
    }

    // Dispatch is concurrent, but `admitted` is built from OUTCOMES, never from
    // the attempt. `executeTask` decides the gate synchronously before its first
    // await, so a denied dispatch resolves quickly; recording it as admitted
    // would claim work that the runtime never saw.
    const settled = await Promise.all(pending);
    dispatched.push(...settled);

    const admitted = settled.filter((e) => e.outcome.ok).map((e) => e.taskId);
    const refused = settled
      .filter((e) => !e.outcome.ok)
      .map((e) => ({
        taskId: e.taskId,
        code: e.outcome.ok ? '' : e.outcome.code,
        reason: e.outcome.ok ? '' : e.outcome.reason,
      }));
    skipped.push(...refused);

    return {
      admitted,
      waiting,
      skipped,
      outcomes: dispatched,
      freeSlots: Math.max(0, maxConcurrency - this.occupiedSlots()),
    };
  }

  /**
   * Optional thin auto-loop. OFF by default: `tick()` is the interface tests and
   * callers should prefer, because it is deterministic.
   *
   * The timer is a TRIGGER, never an authority: each fire calls exactly the same
   * `tick()` that a test would call by hand. All scheduling decisions therefore
   * remain testable without wall-clock timing.
   *
   * The interval is validated strictly — `0`, negative, `NaN` and `Infinity` are
   * refused rather than coerced, because a coerced interval produces a busy loop
   * or a scheduler that silently never runs. Re-entrant fires are dropped by
   * `tick()`'s own guard, and the timer is `unref`'d so a pending tick cannot hold
   * the process open.
   */
  start(): SchedulerStatus {
    if (this.timer !== null) return 'running';
    const ms = this.autoTickMs;
    if (ms === undefined) {
      throw new Error('start() needs autoTickMs; use tick() for deterministic scheduling');
    }
    if (typeof ms !== 'number' || Number.isNaN(ms) || !Number.isFinite(ms) || ms <= 0) {
      throw new Error(`autoTickMs must be a positive finite number, got ${String(ms)}`);
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, ms);
    (this.timer as { unref?: () => void }).unref?.();
    return 'running';
  }

  /**
   * Stop scheduling NEW tasks.
   *
   * Deliberately does NOT cancel running children: stopping a scheduler should
   * not kill work that is already in flight. Those runs continue and still write
   * their real terminal state back to the TaskStore; call `cancelTask()` for
   * that, which routes through the existing Runtime cancellation.
   */
  stop(): SchedulerStatus {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return 'stopped';
  }

  status(): SchedulerStatus {
    return this.timer !== null ? 'running' : 'idle';
  }

  /** True while a tick is in flight; used to make stop() observably safe. */
  isTicking(): boolean {
    return this.ticking;
  }

  /** Cancel a task through the existing bridge. This layer never kills anything. */
  cancel(taskId: string, reason: string): Promise<{ ok: boolean; code: string; reason: string; delegatedToRuntime: boolean }> {
    return this.orch.cancelTask(taskId, reason);
  }
}