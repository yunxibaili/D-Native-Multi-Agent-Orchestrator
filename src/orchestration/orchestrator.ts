/**
 * src/orchestration/orchestrator.ts - Root - one level of children, and their
 * execution.
 *
 * 5C-1: create a root, spawn depth-1 children through the real spawn gate,
 * record lifecycle, translate results, cancel.
 * 5C-2: `executeTask()` - hand a planned child to the EXISTING runtime and write
 * the `RunResult` back to the lifecycle.
 *
 * What is NOT here, by mandate: a DAG scheduler, recursive spawning, a
 * communication bus, worktree management, a review loop, durable recovery.
 * A `denied` from the gate is a real answer, not an error to be worked around.
 *
 * The execution seam is `Orchestrator.run()` from the existing runtime, reached
 * through the minimal `RuntimeRunner` shape. This class never spawns a process
 * itself and never touches a Transport, Adapter, Session, or `RunResult` field.
 * It decides *what* runs and *by whom*; the existing runtime still decides *how*.
 *
 * Task state lives in `TaskStore` and NOWHERE ELSE. The `liveHandles` map below
 * holds run handles so a cancel can reach the runtime - it is a handle registry,
 * not a second copy of task state, and a task's status is only ever read from
 * the store.
 */

import { translateRunResult, translateVerification, type TranslateOptions, type VerificationOutcome } from './translate.ts';
import { buildSpawnGateInput, resolveWorkspaceModeCapability, type SpawnGateSources, type SpawnGateDecision } from './spawn-gate-input.ts';
import { unmetDependencies, type Task, type TaskSpec, type TaskStatus } from './task.ts';
import { TaskStore } from './store.ts';
import {
  buildRunRequest,
  isExecutable,
  EXECUTABLE_STATUSES,
  type ExecuteOutcome,
  type RunRequestMapping,
  type RuntimeRunner,
} from './execute.ts';
import { existsSync } from 'node:fs';
import { WorkspaceError, defaultWorkspaceMode, type WorkspaceHandle, type WorkspaceManager, type WorkspaceMode } from './workspace.ts';
import {
  claimIsLeaseCurrent,
  describeScope,
  modeRequiresIsolation,
  normalizeScopeForWorkspace,
  type ResourceClaimMode,
  type ResourceScope,
} from './resource-claim.ts';
import {
  claimLeaseVersionOf,
  mintFencingToken,
  modelKeyOf,
  validateWriteback,
  type PresentedLease,
} from './assignment-lease.ts';
import {
  mergeTaskBranch,
  summarizeTask,
  type GitContext,
  type MergeOutcome,
  type TaskResultSummary,
} from './task-result.ts';
import { runGit } from './git.ts';

import type { TaskType } from '../quota/types.ts';
// The THREE types this file uses but which the R2-3 observation edit dropped from the
// import list, breaking `npm run typecheck` with 6 "Cannot find name" errors:
//   RunHandle    -> liveHandles / the local `let handle: RunHandle`
//   RunResult    -> applyRunResult / the local `let result: RunResult`
//   RunObservation -> lastObservations / observeExecution (R2-3 process observation)
import type { RunHandle, RunObservation, RunResult } from '../core/types.ts';

/** MVP limits. Hard caps, not preferences. */
export const MVP_MAX_DEPTH = 1;
export const MVP_MAX_CHILDREN = 3;
export const MVP_MAX_CONCURRENT_CHILDREN = 2;

export interface OrchestrationLimits {
  maxDepth: number;
  maxChildren: number;
  maxConcurrentChildren: number;
}

export const DEFAULT_LIMITS: OrchestrationLimits = {
  maxDepth: MVP_MAX_DEPTH,
  maxChildren: MVP_MAX_CHILDREN,
  maxConcurrentChildren: MVP_MAX_CONCURRENT_CHILDREN,
};

export interface OrchestrationOptions {
  store?: TaskStore;
  limits?: Partial<OrchestrationLimits>;
  /** Real gate sources. The SAME object is re-read on every spawn AND execute. */
  gate: SpawnGateSources;
  /** Injected so tests need no process. Production passes the real runtime. */
  now?: () => number;
  /**
   * The existing runtime, supplied as the minimal `RuntimeRunner` shape. Left
   * optional in 5C-1 because nothing executed; in 5C-2 `executeTask` refuses
   * without it rather than falling back to anything.
   */
  runtime?: RuntimeRunner;
  /** Default working directory for `executeTask` when the caller omits one. */
  defaultCwd?: string;

  resultTimeoutMs?: number;
  /**
   * Workspace lifecycle authority. Absent means every task runs in the cwd the
   * caller supplied, i.e. NO isolation - which is why it is opt-in and never
   * assumed. Workspace state lives HERE, not in TaskStore.
   */
  workspace?: WorkspaceManager;
  /**
   * Which workspace mode a task gets. Defaults to the 5C-5 policy: implementation
   * tasks get an isolated worktree, review tasks share an explicit directory.
   */
  workspaceMode?: (task: Task) => WorkspaceMode | 'none';
  /**
   * R2-1: what a task claims to access, resolved per task.
   *
   * Injected rather than computed here, because "does this task write?" is a
   * property of the WORK (a research task reads whatever it is pointed at; an
   * implementation task writes), not of the agent. Keeping it a function of the
   * task - never of `agentId` - is what makes this hold for the four current agents
   * and for any agent admitted later under the same contract (section24.7).
   *
   * Returning `null` means "this task makes no resource claim", which is the honest
   * answer for a task that only reads, and skips the check entirely.
   */
  resourceClaims?: (task: Task) => { mode: ResourceClaimMode; scope: ResourceScope } | null;
}

export interface ExecuteTaskRequest {
  taskId: string;
  /** Required unless `defaultCwd` was configured. */
  cwd?: string;
  prompt?: string;
  threadId?: string;
  /**
   * Called once the runtime has accepted the run and before we wait on it.
   *
   * This is how a caller gets the handle early enough to cancel a run that is
   * still going, without a second API that would have to duplicate this one's
   * validation. Throwing from the callback aborts nothing: the run continues and
   * the outcome is returned as normal.
   */
  onStart?: (handle: RunHandle, mapping: RunRequestMapping) => void;
  /**
   * Escape hatch for the dependency check, and ONLY for that.
   *
   * `SpawnChildRequest.allowUnmetDependencies` lets a task EXIST while it waits.
   * This flag lets it EXECUTE while it waits - which is almost never wanted, and
   * exists so a caller that genuinely drives a dependency chain itself is not
   * blocked. It cannot relax the STRUCTURAL dependency rules (unknown / self /
   * duplicate / parent cycle): those are already refused at spawn time and are
   * not consulted here.
   */
  allowUnmetDependenciesAtExecute?: boolean;
  /**
   * R2-3: where an availability-caused failure (`SPAWN_FAILED` / `TRANSPORT_ERROR`)
   * should land.
   *
   * Absent / false keeps the historical behaviour exactly: such a run makes the task
   * `failed`. Setting `allowAvailabilityContinuation` parks it in `retrying` instead, so
   * the task stays migratable and an operator can move it to another agent as the SAME
   * task. It is opt-in per call because it changes what a failed run MEANS, which is a
   * round-level policy choice rather than something this layer should assume.
   */
  translate?: TranslateOptions;
}

export interface SpawnChildRequest {
  taskId: string;
  /** The task doing the spawning. Only a depth-0 task may spawn. */
  parentTaskId: string;
  agentId: string;
  modelId?: string | null;
  taskType: TaskType;
  acceptanceCriteria: string;
  dependencies?: readonly string[];
  budgetUnits?: number;
  /**
   * Opt in to scheduler-managed dependency readiness: allow this task to exist
   * while its dependencies are unsatisfied. Default (false) keeps the 5C-1
   * behaviour of refusing an unmet dependency at spawn time.
   */
  allowUnmetDependencies?: boolean;
}

export type SpawnOutcome =
  | { ok: true; task: Task; gate: SpawnGateDecision }
  | { ok: false; code: string; reason: string; gate?: SpawnGateDecision };

export type MutateOutcome =
  | { ok: true; task: Task }
  | { ok: false; code: string; reason: string };

/**
 * R2-1.1 (P1-b): is there OTHER work that could run beside this one?
 *
 * Read straight from the store, which is the only task-state authority - so the
 * answer cannot disagree with what the Scheduler would admit. A task is "beside"
 * while it is still eligible to be dispatched; a terminal one is not, because it is
 * no longer competing for the workspace.
 *
 * Depth > 0 excludes the root: a root is never dispatched, so it is not a peer.
 */
function hasParallelWorkBeside(store: TaskStore, selfTaskId: string): boolean {
  const live: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['planned', 'queued', 'running']);
  return store
    .all()
    .some((t) => t.depth > 0 && t.taskId !== selfTaskId && live.has(t.status));
}

export class Orchestrator {
  private readonly store: TaskStore;
  private readonly limits: OrchestrationLimits;
  private readonly now: () => number;
  private readonly runtime: RuntimeRunner | null;
  private readonly defaultCwd: string | null;
  private readonly resultTimeoutMs: number | undefined;
  private readonly workspace: WorkspaceManager | null;
  private readonly workspaceMode: (task: Task) => WorkspaceMode | 'none';
  /** R2-1: per-task resource intent. `null` = no claim, and the check is skipped. */
  private readonly resourceClaims: ((task: Task) => { mode: ResourceClaimMode; scope: ResourceScope } | null) | null;
  /**
   * Live child count = tasks in a non-terminal state. Counted from the store, not
   * from a separate counter, so it cannot drift from the authoritative state.
   */
  private gate: SpawnGateSources;
  /**
   * Run handles for tasks currently executing, so a cancel can reach the runtime.
   *
   * This is a HANDLE REGISTRY, not task state. A task's status is only ever read
   * from the store, and losing this map (on restart) loses the ability to cancel
   * an in-flight run - not the record of what the task did.
   */
  private readonly liveHandles = new Map<string, RunHandle>();
  /**
   * R2 observability: the LAST known machine-side execution facts per task,
   * captured from the run handle at dispatch and again at settle. This is a
   * read-only cache of what the execution edge itself saw — not a state
   * authority (TaskStore owns state, AttemptStore owns evidence) and it cannot
   * dispatch or mutate anything.
   */
  private readonly lastObservations = new Map<string, RunObservation>();

  constructor(options: OrchestrationOptions) {
    this.store = options.store ?? new TaskStore();
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
    this.now = options.now ?? Date.now;
    this.gate = options.gate;
    this.runtime = options.runtime ?? null;
    this.defaultCwd = options.defaultCwd ?? null;
    this.resultTimeoutMs = options.resultTimeoutMs;
    this.workspace = options.workspace ?? null;
    this.workspaceMode = options.workspaceMode ?? ((task) => (this.workspace === null ? 'none' : defaultWorkspaceMode(task)));
    this.resourceClaims = options.resourceClaims ?? null;
  }

  /** The workspace manager, when one is configured. Lifecycle authority only. */
  getWorkspace(): WorkspaceManager | null {
    return this.workspace;
  }

  /**
   * R2-1: give a task's resource claims back.
   *
   * Called when the run settles, and exposed so a caller driving long rounds can
   * release on abort. Releasing is deliberately NOT tied to a task reaching a
   * terminal state: a task in `to_verify` is no longer writing, and holding its
   * claim until review would block an unrelated writer for the review's duration.
   * The artifacts a reviewer needs are the workspace and the evidence, not the
   * claim - nothing is deleted here.
   */
  releaseClaim(taskId: string, claimed: { mode: ResourceClaimMode; scope: ResourceScope } | null): number {
    if (this.workspace === null || claimed === null) return 0;
    // Scoped release (R2-1.1 P2-1): freeing the scope this run held, while any OTHER
    // scope the same task still holds stays protected.
    return this.workspace.releaseResourceClaimForScope(taskId, claimed.mode, claimed.scope);
  }

  /** The workspace mode this task would receive. Exposed for callers and tests. */
  workspaceModeFor(task: Task): WorkspaceMode | 'none' {
    return this.workspaceMode(task);
  }

  getStore(): TaskStore {
    return this.store;
  }

  /** The limits this orchestrator enforces. Read by the scheduler, never mutated by it. */
  getLimits(): OrchestrationLimits {
    return this.limits;
  }

  /**
   * The concurrency ceiling that the REAL gate will apply on the EXECUTE path.
   *
   * Read from `maxConcurrentAgents` (falling back to the legacy
   * `maxConcurrency`), i.e. exactly the number `executeTask` enforces. The
   * scheduler sizes its dispatch window from this too, so there is one number
   * for execution and not two that can drift.
   */
  getConcurrencyLimit(): number {
    return this.gate.maxConcurrentAgents ?? this.gate.maxConcurrency;
  }

  /**
   * The fan-out ceiling applied on the SPAWN path: how many non-terminal
   * children may EXIST.
   *
   * Deliberately a DIFFERENT number from `getConcurrencyLimit()`. Before 5C-4 a
   * single `maxConcurrency` meant both, so a tree could never hold more children
   * than it could run - the queue could never be longer than the concurrency
   * cap, which is not a queue. Separating them lets N children wait while M run.
   */
  getChildLimit(): number {
    return this.gate.maxChildren ?? this.gate.maxConcurrency;
  }

  /**
   * Live child count across the whole tree: every depth>0 task that has not
   * reached a terminal state.
   *
   * `planned` and `queued` children DO count. That is the 5C-1 spawn-time
   * semantic and is deliberately unchanged: a tree that has already fanned out to
   * N non-terminal children has N outstanding obligations, whether or not any of
   * them has started. Phase 5C-1 has a test locking this, and 5C-2 does not
   * redefine it.
   *
   * The consequence is that this number is NOT "execution slots in use" at the
   * moment a task is being admitted - see `liveChildrenExcluding`.
   */
  liveChildren(): number {
    return this.store.all().filter((t) => t.depth > 0 && t.status !== 'succeeded' && t.status !== 'failed' && t.status !== 'cancelled').length;
  }

  /**
   * Live children EXCLUDING one task - the count that execution admission uses.
   *
   * The 5C-2 bug: `executeTask` gated on `liveChildren()` while the task being
   * executed was still `planned`/`queued` and therefore already counted itself.
   * With `maxConcurrency = 1` and a single child that made `1 >= 1`, so the one
   * task that should always be executable could never start, and with
   * `maxConcurrency = 2` only one child could ever run. It denied safely rather
   * than opened a hole, but it would have poisoned the concurrency semantics a
   * 5C-3 scheduler inherits.
   *
   * Excluding by id rather than subtracting 1 makes a negative count impossible
   * and cannot drift if the counting rule changes. The task being admitted has
   * not started and holds no execution slot, so counting it was simply wrong.
   *
   * The count still comes from the TaskStore - there is no second authority.
   */
  liveChildrenExcluding(taskId: string): number {
    return this.store
      .all()
      .filter((t) => t.depth > 0 && t.taskId !== taskId && t.status !== 'succeeded' && t.status !== 'failed' && t.status !== 'cancelled')
      .length;
  }

  /**
   * Children currently OCCUPYING an execution slot, excluding one task.
   *
   * This is what EXECUTE admission counts, against `maxConcurrentAgents`.
   *
   * 5C-4 change, and the reason the two caps had to be split: this used to be a
   * count of every non-terminal child (`liveChildrenExcluding`). That made a
   * queue impossible - with 5 children waiting and a cap of 2, the first dispatch
   * saw "4 others" and denied ITSELF, so no tree larger than the concurrency cap
   * could ever contain a backlog. An execution slot is occupied by a RUNNING
   * task; `planned` and `queued` children hold none.
   *
   * Every previously verified 5C-2 behaviour is preserved and still tested
   * (cap=1 + single child admitted; cap=1 + A running denies B; cap=2 + A
   * running admits B). What changed is that WAITING children no longer count as
   * occupying a slot.
   */
  runningChildrenExcluding(taskId: string): number {
    return this.store
      .all()
      .filter((t) => t.depth > 0 && t.taskId !== taskId && t.status === 'running')
      .length;
  }

  /** Create the root task. A root cannot itself be gated - it is the entry point. */
  createRoot(spec: { taskId: string; agentId: string; modelId?: string | null; taskType: TaskType; acceptanceCriteria: string; budgetUnits?: number }): MutateOutcome {
    const result = this.store.create(
      { ...spec, parentTaskId: null },
      this.now(),
    );
    return result.ok && result.task !== null
      ? { ok: true, task: result.task }
      : { ok: false, code: result.code ?? 'task-create-failed', reason: result.reason ?? 'unknown' };
  }

  /**
   * Spawn one child, in the mandated order:
   *
   *   task validation - spawn gate - budget precondition - availability - create
   *
   * There is no bypass. If the gate denies, no task exists.
   */
  spawnChild(req: SpawnChildRequest): SpawnOutcome {
    const parent = this.store.get(req.parentTaskId);
    if (parent === null) {
      return { ok: false, code: 'parent-not-found', reason: `parent task "${req.parentTaskId}" does not exist` };
    }

    // ---- 1. depth: a child may not spawn --------------------------------
    if (parent.depth >= this.limits.maxDepth) {
      return {
        ok: false,
        code: 'max-depth-exceeded',
        reason:
          `task "${parent.taskId}" is at depth ${parent.depth}; maxDepth is ${this.limits.maxDepth}. ` +
          'Children cannot spawn grandchildren in Phase 5C-1.',
      };
    }

    // ---- 2. duplicate id, checked BEFORE the fan-out cap -------------------
    // A caller that reuses an id has made a mistake worth naming precisely.
    // Reporting "max children" instead would send them looking in the wrong
    // place.
    if (this.store.has(req.taskId)) {
      return { ok: false, code: 'task-id-duplicate', reason: `task "${req.taskId}" already exists` };
    }

    // ---- 3. fan-out ------------------------------------------------------
    // The per-parent child cap reads the SAME `maxChildren` the spawn gate
    // enforces. Keeping a second copy here (`limits.maxChildren`) is how the
    // four-numbers drift starts: a caller would configure maxChildren=10 and
    // still be stopped at 3 by a hard-coded default nobody told them about.
    const childLimit = this.getChildLimit();
    if (this.store.children(parent.taskId).length >= childLimit) {
      return {
        ok: false,
        code: 'max-children-exceeded',
        reason: `task "${parent.taskId}" already has ${this.store.children(parent.taskId).length} children; maxChildren is ${childLimit}`,
      };
    }

    // ---- 4. dependencies must already be satisfiable ---------------------
    // A dependant may only be spawned before its dependency finishes when the
    // caller explicitly asks for scheduler-managed readiness; otherwise the 5C-1
    // default stands and an unmet dependency is refused here.
    const spec: TaskSpec = {
      taskId: req.taskId,
      parentTaskId: parent.taskId,
      agentId: req.agentId,
      modelId: req.modelId ?? null,
      taskType: req.taskType,
      acceptanceCriteria: req.acceptanceCriteria,
      dependencies: req.dependencies ?? [],
      budgetUnits: req.budgetUnits ?? 0,
    };
    if (req.allowUnmetDependencies !== true) {
      const known = new Map(this.store.all().map((t) => [t.taskId, t]));
      // A synthetic task used ONLY to ask "are this candidate's dependencies met?". It is
      // never stored, so it carries the same lease seed `createTask` would give it -
      // derived from the same helpers rather than typed out, so the two cannot drift.
      const unmet = unmetDependencies({ ...spec, status: 'planned', rootTaskId: parent.rootTaskId, depth: 1, artifacts: [], retryCount: 0, order: 0, createdAt: 0, startedAt: null, finishedAt: null, blockedReason: null, stale: false, staleReason: null, generation: 0, leaseVersion: 1, fencingToken: mintFencingToken({ taskId: spec.taskId, leaseVersion: 1, agentId: spec.agentId, modelKey: modelKeyOf(spec.agentId, spec.modelId ?? null) }) } as Task, known);
      if (unmet.length > 0) {
        return {
          ok: false,
          code: 'dependency-unmet',
          reason: `dependency not yet satisfied: ${unmet.join(', ')}`,
        };
      }
    }

    // ---- 5. the REAL spawn gate ------------------------------------------
    // `taskType` comes from the REQUEST, not from the stored gate sources.
    // Defaulting to the sources' taskType would let a review child be gated as
    // an implementation task - which is how an implementation agent could end up
    // in a reviewer slot, and how a reviewer could be refused for lacking
    // `implementation` in its registry entry.
    const decision = buildSpawnGateInput({
      taskId: req.taskId,
      agentId: req.agentId,
      modelId: req.modelId ?? null,
      // THIS child's budget, not the sources' static figure. Using
      // `sources.requestedUnits` would gate every child against one number, so a
      // child asking for 1 unit could be admitted by a budget meant for 1000000.
      requestedUnits: req.budgetUnits ?? 0,
      sources: {
        ...this.gate,
        taskType: req.taskType,
        // Spawn admission is measured in OUTSTANDING children, so the cap that
        // applies is `maxChildren` - NOT the execution concurrency cap. This is
        // the 5C-4 split: a tree may hold more children than it may run.
        currentConcurrency: this.liveChildren(),
        maxConcurrency: this.getChildLimit(),
      },
    });
      if (!decision.result.allowed) {
        // The gate's reason is surfaced verbatim -"no ledger exists" must not
        // be softened into "insufficient", which would send the operator to top
        // up a budget that does not exist. The missing-signal list is appended
        // so a data problem and a budget problem are distinguishable.
        const missingNote =
          decision.missing.length > 0
            ? ` (missing signals: ${decision.missing.map((m) => m.code).join(', ')})`
            : '';
        return {
          ok: false,
          code: decision.result.code,
          reason: `${decision.result.reason}${missingNote}`,
          gate: decision,
        };
      }

    // ---- 6. create --------------------------------------------------------
    const created = this.store.create(spec, this.now());
    if (!created.ok || created.task === null) {
      return { ok: false, code: created.code ?? 'task-create-failed', reason: created.reason ?? 'unknown' };
    }
    return { ok: true, task: created.task, gate: decision };
  }

  /** planned - queued. */
  queue(taskId: string): MutateOutcome {
    return this.mutate(taskId, 'queued');
  }

  /** queued - running. */
  start(taskId: string): MutateOutcome {
    return this.mutate(taskId, 'running');
  }

  /** Any live state - blocked, with a recorded reason. */
  block(taskId: string, reason: string): MutateOutcome {
    if (reason.trim() === '') {
      return { ok: false, code: 'blocked-reason-required', reason: 'a blocked task must say what it is blocked on' };
    }
    return this.mutate(taskId, 'blocked', reason);
  }

  /**
   * P6-D1: `retrying -> queued` on the SAME worker assignment.
   *
   * NOT a rework, and the distinction is load-bearing. A rework is a REVIEWER's
   * verdict re-entering the task (`prepareRework`); a retry is Laya's own
   * observation-driven decision that a failed attempt deserves another go. Both draw
   * on the task's single `retryCount`, so neither loop can escape the other's bound
   * by being counted separately - but they are separate paths and separate evidence
   * rows, because merging them would make "the reviewer asked again" indistinguishable
   * from "the brain decided to try once more".
   *
   * The bound is enforced HERE, not left to the caller. A decision loop that may ask
   * again on the next tick would otherwise be an unbounded retry engine with a model
   * at the far end of it.
   *
   * The status change goes through the store's own transition table (`retrying` was
   * reserved by 5C-1 and P6-D1 un-reserves it), never a raw write.
   */
  retry(taskId: string, reason: string, maxRetries: number): MutateOutcome {
    const task = this.store.get(taskId);
    if (task === null) {
      return { ok: false, code: 'task-not-found', reason: `no task "${taskId}"` };
    }
    if (!Number.isInteger(maxRetries) || maxRetries < 1) {
      // A nonsensical bound would mean "retry forever", which is the one
      // interpretation a bounded loop must never have.
      return {
        ok: false, code: 'invalid-max-retries',
        reason: `maxRetries must be an integer >= 1, got ${String(maxRetries)}`,
      };
    }
    if (task.retryCount >= maxRetries) {
      return {
        ok: false,
        code: 'retry-exhausted',
        reason: `task "${taskId}" has already used ${task.retryCount} retry attempt(s) of a maximum of ${maxRetries}`,
      };
    }
    if (task.status !== 'retrying') {
      return {
        ok: false,
        code: 'retry-not-applicable',
        reason: `task "${taskId}" is ${task.status}; only a task a run left in retrying can be retried`,
      };
    }
    void reason; // recorded by the caller through AttemptStore; the store holds the count
    // `incrementRetry` is TaskStore's own counter method (prepareRework uses it too),
    // so the number that stops the loop lives on the task and survives a restart.
    this.store.incrementRetry(taskId);
    return this.mutate(taskId, 'queued');
  }

  /**
   * P6-D1: move a STARTED task to a different worker.
   *
   * A thin, audited delegation to `TaskStore.migrateIdentityAfterStart` - the store
   * stays the only identity writer and this adds no rule of its own. It exists so the
   * decision layer reaches the authority through the same narrow interface
   * `prepareRework` uses, instead of holding a store reference.
   */
  migrateIdentity(taskId: string, next: { agentId: string; modelId: string | null; reason: string }): MutateOutcome {
    const result = this.store.migrateIdentityAfterStart(taskId, next, this.now());
    return result.ok && result.task !== null
      ? { ok: true, task: result.task }
      : { ok: false, code: result.code ?? 'migration-failed', reason: result.reason ?? 'unknown' };
  }

  /**
   * Apply a terminal `RunResult` to a task.
   *
   * This is the ONLY path by which a `RunResult` changes a task, and a
   * successful run lands in `to_verify` - never in `succeeded`.
   */
  applyRunResult(
    taskId: string,
    result: RunResult,
    presented?: PresentedLease,
    options: TranslateOptions = {},
  ): MutateOutcome {
    // R2-2 final closure (P1-2): ONE lifecycle-aware validation primitive for every
    // execution write-back.
    //
    // `checkFencing` alone cannot see a revocation - `revokeLease` deliberately keeps the
    // version and the token, so a revoked lease still "matches" - which is why this used
    // to carry a hand-written `lease-revoked` gate here while `stillHoldsLease()` did
    // not. Two call sites with two different definitions of "may this write back" is how
    // a `runtime.run()` throw after expiry still managed to write `failed`. Both now call
    // `validateWriteback`, so there is exactly one definition.
    //
    // `applyVerification` deliberately does NOT come through here: verification is a
    // different authority answering a different question, and §2.18 keeps it outside
    // execution-lease enforcement.
    const current = this.store.get(taskId);
    if (current === null) {
      return { ok: false, code: 'task-not-found', reason: `no task "${taskId}"` };
    }
    const verdict = validateWriteback(
      {
        lease: this.store.leaseOf(taskId),
        agentId: current.agentId,
        modelId: current.modelId,
        leaseVersion: current.leaseVersion,
        fencingToken: current.fencingToken,
        producedBy: result.agentId,
      },
      presented,
      this.now(),
    );
    if (verdict.accepted === false) {
      return { ok: false, code: verdict.code, reason: verdict.reason };
    }
    // R2-3: `options` is threaded, not interpreted, here. Whether an availability
    // failure parks in `retrying` instead of going terminal is a CALLER's policy
    // decision, made once by whoever configured the round - this layer stays the single
    // place a RunResult becomes task state and adds no rule of its own.
    const translation = translateRunResult(result, options);
    return this.mutate(taskId, translation.to, translation.reason);
  }

  /**
   * Apply a review verdict. The only route into `succeeded`.
   *
   * 5C-1 records the verdict; the rework LOOP is deferred. `rework` is a
   * reserved status, so this returns a refusal-with-intent rather than
   * pretending to re-dispatch.
   */
  applyVerification(taskId: string, outcome: VerificationOutcome): MutateOutcome {
    const translated = translateVerification(outcome);
    // P6-D0 UN-RESERVES `rework`. The transition has been in the table since 5C-1
    // (which reserved it deliberately), so applying it needs no new rule here -
    // only the refusal goes away. The rework LOOP itself lives in
    // orchestration/review-loop.ts, which moves the task `rework -> queued` via
    // TaskStore and lets the EXISTING TaskScheduler dispatch it. That path is
    // deliberately not inlined: re-entry must be this orchestrator's single
    // execution edge, and inlining a re-dispatch is exactly how a second
    // execution path appears.
    return this.mutate(taskId, translated.to, translated.reason);
  }

  /**
   * Cancel a task and everything under it.
   *
   * 5C-1 propagates TASK state only. Real process reaping stays where it
   * already is: the Runtime's `taskkillTree`. This layer never kills anything,
   * which is why it cannot leave an orphan.
   */
  cancel(taskId: string, reason: string): { cancelled: Task[]; refused: Array<{ taskId: string; reason: string }> } {
    const cancelled: Task[] = [];
    const refused: Array<{ taskId: string; reason: string }> = [];
    for (const task of this.store.descendants(taskId)) {
      const result = this.store.transition(task.taskId, 'cancelled', this.now(), reason);
      if (result.ok && result.task !== null) cancelled.push(result.task);
      else refused.push({ taskId: task.taskId, reason: result.reason ?? result.code ?? 'unknown' });
    }
    return { cancelled, refused };
  }

  /** Replace the live gate sources (e.g. after a quota refresh). */
  updateGateSources(sources: Partial<SpawnGateSources>): void {
    this.gate = { ...this.gate, ...sources };
  }

  /**
   * Execute one existing task through the real runtime.
   *
   * The mandated order:
   *
   *   task lookup - status check - gate - planned→queued→running
   *   - Orchestrator.run() - RunResult - lifecycle write-back
   *
   * Every status change goes through the TaskStore, which stays the only
   * authority. `running - succeeded` is unreachable by construction: the
   * translation puts a successful run into `to_verify` and only an explicit
   * `applyVerification('pass')` can succeed a task.
   *
   * A throw from `runtime.run()` -`CapabilityError`, `InvalidRequestError`, or
   * anything else - is caught and recorded as `failed` with the real message.
   * Swallowing it as success is the specific failure this refuses to allow.
   */
  async executeTask(req: ExecuteTaskRequest): Promise<ExecuteOutcome> {
    // ---- the task must already exist; we never construct one here ----
    const task = this.store.get(req.taskId);
    if (task === null) {
      return {
        ok: false,
        code: 'task-not-found',
        reason: `no task "${req.taskId}" - executeTask never creates tasks; use spawnChildTask`,
      };
    }

    // ---- it must be in a state that can start running ----
    if (!isExecutable(task.status)) {
      return {
        ok: false,
        code: 'task-not-executable',
        reason: `task "${task.taskId}" is ${task.status}; only ${[...EXECUTABLE_STATUSES].join(' or ')} can be executed`,
        status: task.status,
      };
    }

    // ---- 4b. dependencies must be SATISFIED before execution --------------
// This is the dependency authority for execution. The scheduler checks the same
// thing earlier to decide what to dispatch, but the scheduler is an OPTIMISATION
// over this: bypassing it must not let an unmet dependency run. Without this,
// `executeTask(B)` with an unfinished A would happily start a native agent.
if (req.allowUnmetDependenciesAtExecute !== true) {
  const known = new Map(this.store.all().map((t) => [t.taskId, t]));
  const unmet = unmetDependencies(task, known);
  if (unmet.length > 0) {
    return {
      ok: false,
      code: 'dependency-unmet',
      reason:
        `dependency not satisfied: ${unmet.join(', ')}. ` +
        'Only a `succeeded` dependency satisfies execution - a `to_verify` dependency still needs verification.',
      status: task.status,
    };
  }
}

    // ---- the runtime seam must exist ----
    if (this.runtime === null) {
      return {
        ok: false,
        code: 'no-runtime-bound',
        reason: 'no RuntimeRunner was provided; orchestration cannot execute a task without the existing runtime',
        status: task.status,
      };
    }

    const cwd = req.cwd ?? this.defaultCwd;
    if (cwd === null || cwd === undefined || cwd.trim() === '') {
      return {
        ok: false,
        code: 'cwd-required',
        reason: 'executeTask needs a cwd (worktree isolation is not implemented in 5C-2; the caller decides the directory)',
        status: task.status,
      };
    }

    // ---- re-check the gate at execution time ----
    // The 5C-1 gate runs at SPAWN. Money is actually spent at EXECUTE, and the
    // budget/quota/concurrency facts can all have changed in between - a child
    // queued behind two others may no longer fit under the cap. Re-running the
    // same pure gate here is what makes the gate a real precondition rather than
    // a one-time formality.
    // Re-checked at execution, so `currentConcurrency` must mean "other children
    // already live", NOT "including me": the task being admitted is still
    // planned/queued and holds no execution slot yet. Counting it made a single
    // child unrunnable at maxConcurrency=1. Spawn time needs no such exclusion -    // the child does not exist in the store yet.
    const decision = buildSpawnGateInput({
      taskId: task.taskId,
      agentId: task.agentId,
      modelId: task.modelId,
      requestedUnits: task.budgetUnits,
      sources: {
        ...this.gate,
        taskType: task.taskType,
        currentConcurrency: this.runningChildrenExcluding(task.taskId),
        // Execute admission is measured in RUNNING children, so the cap is
        // `maxConcurrentAgents`. `maxChildren` deliberately does NOT apply here:
        // a full tree is not a reason to refuse to run a task that is ready.
        maxConcurrency: this.getConcurrencyLimit(),
      },
    });
    if (!decision.result.allowed) {
      const missingNote =
        decision.missing.length > 0 ? ` (missing signals: ${decision.missing.map((m) => m.code).join(', ')})` : '';
      return {
        ok: false,
        code: decision.result.code,
        reason: `${decision.result.reason}${missingNote}`,
        status: task.status,
        gate: decision,
      };
    }

    // ---- workspace CAPABILITY (5C-6) --------------------------------------
    // Checked BEFORE the workspace is prepared, and therefore before any state
    // change. The ordering is the point: creating a worktree and only then
    // discovering the agent may not use one would mean creating a directory
    // that has to be cleaned up again - a side effect an admission rejection
    // should never produce.
    //
    // Mode is resolved here (a pure function of the task) so the check and the
    // prepare below cannot disagree about which mode was asked for.
    const requiredMode = this.workspaceModeFor(task);
    if (this.workspace !== null && requiredMode !== 'none') {
      const capability = resolveWorkspaceModeCapability({
        descriptors: this.gate.descriptors,
        agentId: task.agentId,
        mode: requiredMode,
      });
      if (!capability.ok) {
        // An admission rejection, NOT a task failure: the task keeps its current
        // status so it can be retried (with another agent, or in shared mode)
        // instead of being burned as `failed`.
        return {
          ok: false,
          code: capability.missing.code,
          reason: `${capability.missing.reason} (refused: no workspace, no worktree, no runtime call, ` +
            `no fallback to a shared checkout - task stays ${task.status}, nothing was spent)`,
          status: task.status,
        };
      }
    }

    // ---- workspace resolution -------------------------------------------
    // Resolved BEFORE any state change, so a failure cannot leave a task marked
    // running or queued. Isolation is requested explicitly and NEVER downgraded:
    // if a worktree cannot be created we refuse rather than fall back to the
    // repo root, because a silent fallback would LOOK like isolation while
    // sharing one checkout - the exact failure this layer exists to prevent.
    let resolvedCwd = cwd;
    let workspace: WorkspaceHandle | null = null;
    // Set once this task's claim is TAKEN, so the release below can give back
    // EXACTLY that scope - no earlier (another writer would still be blocked) and no
    // later (a stale claim would block a finished task). Scoped, not per-task: a task
    // may hold several claims and releasing "the task's claims" would drop the rest.
    let claimedScope: { mode: ResourceClaimMode; scope: ResourceScope } | null = null;
    if (this.workspace !== null) {
      const mode = requiredMode;
      if (mode !== 'none') {
        try {
          workspace = await this.workspace.prepare({
            taskId: task.taskId,
            mode,
            // An isolated workspace derives its own directory from the project
            // root; a shared one must be named explicitly, and the caller's cwd
            // is that name.
            ...(mode === 'shared' ? { sharedCwd: cwd } : {}),
          });
        } catch (e) {
          const code = e instanceof WorkspaceError ? e.code : 'workspace-unknown';
          const reason = e instanceof Error ? e.message : String(e);
          return {
            ok: false,
            code,
            reason: `${reason} (refused: no workspace, no runtime call, no fallback to a shared checkout)`,
            status: task.status,
          };
        }
        // The workspace is authoritative for cwd once prepared. A caller cannot
        // substitute the project root for an isolated task's directory.
        resolvedCwd = workspace.cwd;
        if (!existsSync(resolvedCwd)) {
          return {
            ok: false,
            code: 'workspace-path-missing',
            reason: `workspace cwd "${resolvedCwd}" does not exist; refusing to start an agent in a missing directory`,
            status: task.status,
          };
        }
      }
    }

    // ---- R2-1: resource admission, at the SAME point as the workspace check ----
    // section7.3 of the R2 contract puts this exactly here: after the Spawn Gate, before
    // `runtime.run`, reusing the 5C-6 workspace admission check point rather than
    // adding a new authority.
    //
    // Two properties this must NOT have, and does not:
    //   - it does not dispatch, retry, re-plan, reassign or swap agents. A conflict
    //     is reported and the task keeps its status, exactly like the workspace
    //     capability refusal above, so the EXISTING Laya / Scheduler / Human Gate
    //     semantics decide what happens next. No autonomous recovery was added.
    //   - it does not treat a conflict as an agent failure. Nothing ran, so no worker
    //     is at fault and the code is `resource-conflict`, not `failed`.
    //
    // R2-1.1 (P1-b): this runs EVEN WITH NO WORKSPACE MANAGER. The guard used to be
    // `this.workspace !== null && ...`, so a non-git project silently skipped resource
    // admission entirely and ran parallel WRITERS in one shared cwd - the exact
    // failure the layer exists to prevent. Isolation being unavailable is a REASON TO
    // BLOCK a write, never a reason to stop checking.
    const claimIntent = this.resourceClaims?.(task) ?? null;
    if (claimIntent !== null) {
      const workspaceId = workspace?.workspaceId ?? `shared:${this.defaultCwd ?? ''}`;
      // The PREPARED workspace is authoritative for the root, so a path claim is
      // tested against the directory the agent will actually be given.
      const scope: ResourceScope =
        claimIntent.scope.kind === 'workspace'
          ? normalizeScopeForWorkspace(claimIntent.scope.workspaceId, workspace?.cwd ?? this.defaultCwd ?? '')
          : claimIntent.scope;

      // R2-2 §7.3: a claim must reference a CURRENTLY VALID lease. This is checked
      // BEFORE any claim work so an unleaseable task cannot register a claim it could
      // never legitimately hold - and refusing here means no runtime call, no agent
      // blamed, and the task keeps its status, exactly like the workspace refusal above.
      const nowMs = this.now();
      const liveLeaseVersion = claimLeaseVersionOf(this.store.leaseOf(task.taskId), nowMs);
      if (liveLeaseVersion === null) {
        const held = this.store.leaseOf(task.taskId);
        const why = held === null
          ? 'it holds no assignment lease'
          : held.status === 'revoked'
            ? `its lease was revoked (${held.revokedReason ?? 'no reason recorded'})`
            : `its lease expired at ${held.expiresAt}`;
        return {
          ok: false,
          code: 'lease-not-live',
          reason:
            `task "${task.taskId}" cannot take a resource claim because ${why}. §7.3 makes a claim void ` +
            'without a live lease. Refused at admission: no claim registered, no runtime call, no agent blamed, ' +
            `and the task stays ${task.status} so the existing workflow decides what next.`,
          status: task.status,
        };
      }

      // Void claims whose lease has moved on, so a superseded holder cannot keep
      // blocking - or keep conferring write eligibility on - a resource (Race 4).
      //
      // P1-3: the currency test must go through `claimLeaseVersionOf`, which returns
      // null for a REVOKED or EXPIRED lease - not the raw `leaseVersion`. `revokeLease`
      // deliberately keeps the version and the token (they are evidence of what was
      // granted), so passing the raw version made a revoked lease with the same version
      // read as current, contradicting §7.3 and the function's own documentation.
      if (this.workspace !== null) {
        const nowMsForVoid = this.now();
        this.workspace.voidStaleResourceClaims(
          (c) => !claimIsLeaseCurrent(c, claimLeaseVersionOf(this.store.leaseOf(c.taskId), nowMsForVoid)),
        );
      }

      if (this.workspace === null) {
        // No workspace authority at all (a non-git project). Reading is safe in a
        // shared directory; WRITING beside other work is not, because there is
        // nothing to isolate it with. section8 makes isolation the default for exactly
        // this reason, so the honest answer here is to refuse the write.
        if (hasParallelWorkBeside(this.store, task.taskId) && modeRequiresIsolation(claimIntent.mode)) {
          return {
            ok: false,
            code: 'resource-unavailable',
            reason:
              `task "${task.taskId}" would write while other work runs beside it, but this project has no git ` +
              `repository, so no isolated workspace can be created and the only option would be a shared mutable ` +
              `directory. Refused at admission: no runtime call, no agent blamed, and the task stays ${task.status} ` +
              `so the existing workflow can decide what next.`,
            status: task.status,
          };
        }
      } else {
        const request = { taskId: task.taskId, workspaceId, mode: claimIntent.mode, scope };
        const held = this.workspace.resourceConflicts(request);
        if (held.length > 0) {
          const detail = held.map((c) => `${c.taskId} holds ${c.mode} on ${describeScope(c.scope)}`).join('; ');
          return {
            ok: false,
            code: 'resource-conflict',
            reason:
              `task "${task.taskId}" asked for ${claimIntent.mode} on ${describeScope(scope)}, which conflicts with ` +
              `${held.length} claim(s): ${detail}. Refused at admission: no workspace change, no runtime call, ` +
              `no agent blamed, and the task stays ${task.status} so Laya / a human can decide.`,
            status: task.status,
          };
        }
        // TAKEN, not merely permitted. Without registering here nothing would ever be
        // held and the check above could never refuse anything - the query would be
        // decoration. section7.3 makes a repeat registration idempotent, so this is safe to
        // re-enter.
        //
        // R2-2: bound to the lease version this claim was taken under, so §7.3's
        // "revoked/expired => void" has something concrete to compare against later.
        const taken = this.workspace.claimResource({ ...request, leaseVersion: liveLeaseVersion });
        if (!taken.ok) {
          return {
            ok: false,
            code: taken.code,
            reason: `${taken.reason} (refused: nothing ran, task stays ${task.status})`,
            status: task.status,
          };
        }
        claimedScope = { mode: claimIntent.mode, scope };
      }
    }
    // ---- from here on, a REGISTERED claim is this method's responsibility ------
    //
    // R2-2 final closure (P2): `claimedScope` was previously released at two hand-
    // picked points, and every early return between registration and those points
    // leaked the claim - most importantly the `runtime.run()` throw branch, which
    // returns before either release and left the scope held forever, blocking an
    // unrelated writer for the rest of the round.
    //
    // A `finally` makes the ownership structural: once the claim is taken, exactly one
    // place gives it back, on every exit including a throw. Release stays tied to
    // EXECUTION resource ownership - it happens when the run settles, not when the task
    // is verified - so verification semantics are untouched.
    try {

      // ---- planned - queued - running, through the store ----
      // `executeTask` accepts a task that is ALREADY queued, so the queue step is
      // conditional. Forcing `queued - queued` would be refused by the transition
      // table, which would make a perfectly legitimate re-request fail.
      let queuedTask = task;
      if (task.status === 'planned') {
        const queued = this.mutate(task.taskId, 'queued');
        if (!queued.ok) return { ok: false, code: queued.code, reason: queued.reason, status: task.status };
        queuedTask = queued.task;
      }
      const running = this.mutate(queuedTask.taskId, 'running');
      if (!running.ok) return { ok: false, code: running.code, reason: running.reason, status: queuedTask.status };

      // R2-2: capture the lease THIS dispatch runs under, and present it on write-back.
      // Captured from the task's own record at dispatch time - not read from anything the
      // worker later says - so a reassign between here and the result makes the write-back
      // stale rather than authoritative.
      const dispatchedLease: PresentedLease = {
        agentId: running.task.agentId,
        leaseVersion: running.task.leaseVersion,
        fencingToken: running.task.fencingToken,
      };
      // §6.3 `issued -> active`: the EXECUTION window starts here, not at assignment.
      //
      // This is the fix for the livelock in which a task that waited longer than the
      // assignment window could never be dispatched at all (see `activateLease`). It is
      // once-per-lease, synchronous, and cannot resurrect a revoked lease.
      this.store.markLeaseUsed(task.taskId, this.now());

      // R2-2 final closure (P1-2 / P2): the SAME primitive as `applyRunResult`.
      //
      // These two branches mutate too (`runtime.run()` throw and `handle.result()` throw
      // both write `failed`), and they previously ran a version/token-only check, so a run
      // that failed AFTER its lease expired could still write `failed` while a successful
      // run in the identical situation was correctly refused. One primitive, one meaning.
      const stillHoldsLease = (): boolean => {
        const held = this.store.get(task.taskId);
        if (held === null) return false;
        return validateWriteback(
          {
            lease: this.store.leaseOf(task.taskId),
            agentId: held.agentId,
            modelId: held.modelId,
            leaseVersion: held.leaseVersion,
            fencingToken: held.fencingToken,
          },
          dispatchedLease,
          this.now(),
        ).accepted;
      };

      // ---- hand it to the EXISTING runtime ----
      let handle: RunHandle;
      let mapping: RunRequestMapping;
      try {
        const built = buildRunRequest({
          task: running.task,
          cwd: resolvedCwd,
          ...(req.prompt !== undefined ? { prompt: req.prompt } : {}),
          ...(req.threadId !== undefined ? { threadId: req.threadId } : {}),
        });
        mapping = built.mapping;
        handle = this.runtime.run(built.request);
      } catch (e) {
        // A refused run is a real failure with a real reason, not an absent task.
        const message = e instanceof Error ? e.message : String(e);
        // §10 #3: this branch mutates too, so it is fenced as well. A superseded
        // assignment must not be able to mark the CURRENT holder's task failed.
        if (!stillHoldsLease()) {
          return {
            ok: false,
            code: 'stale-lease-version',
            reason:
              `the assignment moved on while this run was being started, so its failure is not recorded against the ` +
              `current holder. Task left untouched (${task.status}).`,
            status: this.store.get(task.taskId)?.status ?? task.status,
            gate: decision,
          };
        }
        const failed = this.mutate(task.taskId, 'failed', `runtime refused the run: ${message}`);
        return {
          ok: false,
          code: 'runtime-rejected-run',
          reason: message,
          status: failed.ok ? failed.task.status : 'failed',
          gate: decision,
        };
      }

      this.liveHandles.set(task.taskId, handle);
      if (req.onStart !== undefined) {
        try {
          req.onStart(handle, mapping);
        } catch {
          // A caller's observer must not be able to fail the execution.
        }
      }

      // ---- wait for the real result ----
      let result: RunResult;
      try {
        result = await handle.result(this.resultTimeoutMs);
      } catch (e) {
        // A rejection here is a runtime failure, never a success.
        const message = e instanceof Error ? e.message : String(e);
        this.liveHandles.delete(task.taskId);
        // The run is over either way, so the claim is released on BOTH paths: keeping a
        // claim for a task that can no longer write would block an unrelated writer
        // forever.
        // §10 #2: this branch mutates, so it is fenced too. The run produced no result,
        // so there is no execution evidence to preserve here - only the state decision.
        if (!stillHoldsLease()) {
          return {
            ok: false,
            code: 'stale-lease-version',
            reason:
              `the assignment moved on while this run was in flight, so its failure is not recorded against the ` +
              `current holder. Task left untouched (${this.store.get(task.taskId)?.status ?? task.status}).`,
            status: this.store.get(task.taskId)?.status ?? task.status,
            gate: decision,
          };
        }
        this.mutate(task.taskId, 'failed', `the run did not produce a result: ${message}`);
        return { ok: false, code: 'runtime-result-failed', reason: message, status: 'failed', gate: decision };
      }
      this.liveHandles.delete(task.taskId);
      // Final machine facts: processState is now 'exited' with the real exit code.
      const observationAtSettle = handle.observe?.() ?? null;
      if (observationAtSettle !== null) this.lastObservations.set(task.taskId, observationAtSettle);

      // ---- write the result back to the lifecycle ----
      const applied = this.applyRunResult(task.taskId, result, dispatchedLease, req.translate ?? {});
      if (!applied.ok) {
        // R2-2 / F5: STATE is refused, EVIDENCE IS NOT.
        //
        // A real native process ran and produced this result. Whether the write-back is
        // accepted is a WORKFLOW question (is this still the current assignment?), while
        // "this agent ran and produced this" is an EXECUTION fact that must survive the
        // refusal. Dropping it here was F5: the run executed and left no trace at all.
        //
        // So the refusal carries the run forward, and the caller records it as evidence.
        // This is NOT a second source of truth - AttemptStore still persists execution
        // facts and TaskStore still owns workflow state; the run is simply not thrown away.
        return {
          ok: false,
          code: applied.code,
          reason: applied.reason,
          // Authoritative: the task did NOT move because of this result.
          status: this.store.get(task.taskId)?.status ?? task.status,
          run: result,
          runRejected: true,
          mapping,
          gate: decision,
          // The version the run HELD. The task has since moved on, which is why the
          // write-back was refused - and this is the value the evidence record must carry
          // so the attempt stays attributed to the lease it really belonged to.
          leaseVersion: dispatchedLease.leaseVersion,
        };
      }
      return {
        ok: true,
        task: applied.task,
        run: result,
        mapping,
        runtimeTaskId: result.taskId,
        handle,
        gate: decision,
        // Dispatch-time lease, matching what the attempt actually ran under.
        leaseVersion: dispatchedLease.leaseVersion,
      };
    } finally {
      // Idempotent by construction: `releaseClaimForScope` removes what it finds, so a
      // second call is a no-op returning 0 rather than an error.
      this.releaseClaim(task.taskId, claimedScope);
    }
  }

  /**
   * R2 observability: the last machine-side execution facts for one task, or null.
   * Read-only passthrough of what the execution edge observed; deleting this cache
   * would lose nothing but the dashboard's view.
   */
  observeExecution(taskId: string): RunObservation | null {
    return this.lastObservations.get(taskId) ?? null;
  }

  /** True while a task has a live run handle. Not a status; the store is. */
  hasLiveRun(taskId: string): boolean {
    return this.liveHandles.has(taskId);
  }

  // ---------------------------------------------------------------------
  // 5C-9 - inspect and explicitly merge a child's work.
  //
  // These close the personal-tool loop:
  //   Task -> Agent -> worktree -> run -> verify -> inspect -> merge
  //
  // They are read-mostly and additive. Nothing here changes the execution
  // lifecycle, and merge is never automatic.
  // ---------------------------------------------------------------------

  /** Lightweight per-task merge record. Deliberately NOT a database. */
  private readonly merged = new Map<string, { at: number; commit: string }>();

  /** Every task this orchestrator knows about, newest state first (store order). */
  listTasks(): Task[] {
    return this.store.all();
  }

  /**
   * A read-only view of one child's work: status, workspace, branch, dirty flag,
   * changed files, diff stat, and whether a merge is currently allowed.
   *
   * Works without mutating anything, and returns a populated (if mostly empty)
   * summary even when no workspace exists, so a caller never has to special-case
   * "no workspace" to render something readable.
   */
  async inspectTask(taskId: string): Promise<TaskResultSummary | null> {
    const task = this.store.get(taskId);
    if (task === null) return null;
    return summarizeTask({
      ctx: this.requireGitContext(),
      taskId,
      status: task.status,
      agentId: task.agentId,
      modelId: task.modelId,
      handle: this.workspace?.get(taskId) ?? null,
      rootRepo: this.workspace?.getProjectRoot() ?? null,
      merged: this.merged.get(taskId) ?? null,
    });
  }

  /**
   * Explicitly merge one child's branch into the root branch.
   *
   * Refuses unless every precondition holds, and on a conflict leaves the scene
   * untouched. Never auto-commits, never resets, never force-resolves.
   */
  async mergeTask(taskId: string): Promise<MergeOutcome> {
    const task = this.store.get(taskId);
    if (task === null) {
      return { ok: false, code: 'merge-task-not-found', reason: `no task "${taskId}"`, mergeCommit: null, conflicts: [] };
    }
    const outcome = await mergeTaskBranch({
      ctx: this.requireGitContext(),
      taskId,
      taskStatus: task.status,
      handle: this.workspace?.get(taskId) ?? null,
      rootRepo: this.workspace?.getProjectRoot() ?? this.defaultCwd ?? process.cwd(),
    });
    if (outcome.ok && outcome.mergeCommit !== null) {
      // Recorded in memory only. `already-merged` is answered from git
      // (`merge-base --is-ancestor`), so correctness does not depend on this.
      this.merged.set(taskId, { at: Date.now(), commit: outcome.mergeCommit });
    }
    return outcome;
  }

  /** The raw unified diff a merge would bring. Read-only; empty when unavailable. */
  async taskDiff(taskId: string): Promise<string> {
    const task = this.store.get(taskId);
    if (task === null) return '';
    const handle = this.workspace?.get(taskId) ?? null;
    if (handle === null || handle.mode !== 'isolated' || handle.repoRoot === null || handle.branch === null) return '';
    const range = handle.baseSha !== null ? `${handle.baseSha}..${handle.branch}` : handle.branch;
    const r = await runGit({
      gitPath: this.requireGitContext().gitPath,
      args: ['diff', range],
      cwd: handle.repoRoot,
      timeoutMs: this.requireGitContext().timeoutMs,
      env: this.requireGitContext().env,
    });
    return r.code === 0 ? r.stdout : '';
  }

  private requireGitContext(): GitContext {
    if (this.workspace !== null) return this.workspace.gitContext();
    // A caller can inspect/merge without a WorkspaceManager only if it gave us
    // the git details directly; otherwise say so plainly instead of guessing.
    throw new WorkspaceError(
      'workspace-unknown',
      'git operations need a WorkspaceManager; construct the Orchestrator with `workspace`',
    );
  }

  /**
   * Cancel one task, delegating process work to the runtime.
   *
   * A `queued` task is cancelled in the store and NO agent is started. A `running`
   * task's handle is cancelled through the existing runtime, which owns process
   * termination and the Windows process-tree cleanup - this layer kills nothing.
   */
  async cancelTask(taskId: string, reason: string): Promise<{ ok: boolean; code: string; reason: string; delegatedToRuntime: boolean }> {
    const task = this.store.get(taskId);
    if (task === null) return { ok: false, code: 'task-not-found', reason: `no task "${taskId}"`, delegatedToRuntime: false };

    const handle = this.liveHandles.get(taskId);
    if (handle !== undefined) {
      // Delegate. The runtime's own cancellation does everything that touches a
      // process; duplicating it here would be the bug, not the feature.
      try {
        await handle.cancel(reason);
      } finally {
        this.liveHandles.delete(taskId);
      }
      return { ok: true, code: 'cancel-delegated', reason, delegatedToRuntime: true };
    }

    // Nothing is running for THIS task, but a descendant may be. Phase 5B §15: a
    // root cancel propagates to children, while one child's failure never cancels
    // the tree. So cancelling a task with descendants walks the subtree, and
    // cancelling a leaf affects only that leaf.
    const tree = this.store.descendants(taskId);
    const liveBelow = tree.filter((t) => this.liveHandles.has(t.taskId));

    // Any live descendant is cancelled through the runtime, before the store
    // walk, so a running process is asked to stop rather than being marked
    // cancelled underneath itself.
    for (const t of liveBelow) {
      const h = this.liveHandles.get(t.taskId);
      if (h === undefined) continue;
      try {
        await h.cancel(reason);
      } finally {
        this.liveHandles.delete(t.taskId);
      }
    }

    const result = this.cancel(taskId, reason);
    if (result.cancelled.length === 0) {
      return {
        ok: false,
        code: result.refused[0]?.reason === undefined ? 'nothing-to-cancel' : 'task-not-cancellable',
        reason: result.refused[0]?.reason ?? `task "${taskId}" could not be cancelled`,
        delegatedToRuntime: liveBelow.length > 0,
      };
    }
    return {
      ok: true,
      code: result.cancelled.length > 1 ? 'cancelled-tree' : 'cancelled',
      reason:
        result.cancelled.length > 1
          ? `cancelled ${result.cancelled.length} tasks under "${taskId}": ${result.cancelled.map((t) => t.taskId).join(', ')}`
          : reason,
      delegatedToRuntime: liveBelow.length > 0,
    };
  }

  private mutate(taskId: string, to: TaskStatus, reason: string | null = null): MutateOutcome {
    const result = this.store.transition(taskId, to, this.now(), reason);
    return result.ok && result.task !== null
      ? { ok: true, task: result.task }
      : { ok: false, code: result.code ?? 'transition-failed', reason: result.reason ?? 'unknown' };
  }
}
