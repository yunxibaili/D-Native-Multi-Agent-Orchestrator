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
  resolveDispatchContext,
  validateExecutionTimeoutMs,
  isExecutable,
  EXECUTABLE_STATUSES,
  type ExecuteOutcome,
  type RunRequestMapping,
  type RuntimeRunner,
  type DispatchTerminal,
  type ProcessStartDisposition,
} from './execute.ts';
import { isProvenNotStarted } from '../runtime/start-proof.ts';
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
  type RenewPolicy,
} from './assignment-lease.ts';
import {
  mergeTaskBranch,
  summarizeTask,
  type GitContext,
  type MergeOutcome,
  type TaskResultSummary,
} from './task-result.ts';
import { runGit } from './git.ts';
// P0-1: the completion gate's fact-gathering helpers (value-only) and the pure decision.
import { captureWorkspaceManifest, manifestDigest, type WorkspaceManifest } from './workspace-manifest.ts';
import { buildCompletionEvidence, runFingerprintOf, DEFAULT_COMPLETION_TEST_TIMEOUT_MS, type CompletionEvidence } from './completion-evidence.ts';
import { completionContractDigest, isCodingTaskType, parseCompletionContract, CompletionContractError } from './completion-contract.ts';
import { evaluateCompletionGate } from './completion-gate.ts';
// P0-1: read-only correlation against the EXISTING evidence authority. This is not a
// second authority — the store is owned by the workbench and only `get`/`history` are
// consulted, never appended through here.
import type { AttemptStore } from './attempt-store.ts';
import { runProvenanceOf } from './attempt-integration.ts';

import type { TaskType } from '../quota/types.ts';
// The THREE types this file uses but which the R2-3 observation edit dropped from the
// import list, breaking `npm run typecheck` with 6 "Cannot find name" errors:
//   RunHandle    -> liveHandles / the local `let handle: RunHandle`
//   RunResult    -> applyRunResult / the local `let result: RunResult`
//   RunObservation -> lastObservations / observeExecution (R2-3 process observation)
import type { RunHandle, RunObservation, RunResult } from '../core/types.ts';
import { isTerminal } from '../core/types.ts';
import { log } from '../core/log.ts';

/** MVP limits. Hard caps, not preferences. */
export const MVP_MAX_DEPTH = 1;
export const MVP_MAX_CHILDREN = 3;
export const MVP_MAX_CONCURRENT_CHILDREN = 2;

/**
 * R5-1 (§5): extra lease TTL on top of the execution deadline, covering the time
 * between the run's last write and the write-back itself. Not a heartbeat interval —
 * nothing polls on it.
 */
const CANCEL_CONFIRM_WAIT_MS = 10_000;
/**
 * R5-1.1 (§9): pause between defensive result re-waits, so a handle that rejects
 * while non-terminal cannot busy-spin the event loop. Pure event-loop hygiene.
 */
const RESULT_GAP_BACKOFF_MS = 50;
const LEASE_WRITEBACK_MARGIN_MS = 60_000;

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

  /**
   * R5-1 (P1-A): the NATIVE EXECUTION DEADLINE, in ms.
   *
   * This is the only execution timeout the orchestrator owns, and it is NOT a
   * result-wait bound. When set, it flows into `RunRequest.timeoutMs`, so the
   * existing `AgentSession` enforces it INSIDE the execution boundary: on expiry
   * the session cancels its transport through its own path, freezes a REAL
   * terminal `timed_out` result, and `executeTask` observes that terminal exactly
   * like any other — live handle, lease, claim and evidence all flow through the
   * normal settle path. Nothing is fabricated and no process is touched from
   * outside the runtime.
   *
   * The three timeout meanings are deliberately separate:
   *   - Laya decision timeout — round-cli's `--laya-timeout`, the DECISION loop only.
   *   - result wait — `handle.result()` is now awaited WITHOUT a wait bound. A wait
   *     that has not yet produced a terminal result is not a failure; the previous
   *     behaviour (wait expired -> mark failed -> delete the live handle -> release
   *     the claim while the agent was still running) is removed.
   *   - native execution deadline — this option. The only timeout that may end an
   *     execution, and it does so through the runtime's own boundary.
   */
  executionTimeoutMs?: number;
  /**
   * R5-1.1 (§4): how long `cancelTask()` waits for the runtime's own frozen
   * terminal after a cancellation request, before reporting
   * `cancellation-not-confirmed`. Production default: 10 s. Tests shrink it.
   */
  cancelConfirmWaitMs?: number;
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
   * B4.5: resolve the PHYSICAL OWNER of the workspace a task runs in.
   *
   * Returning a task id that differs from the task's own id makes that task share
   * the owner's physical workspace (same cwd / branch / baseSha), which is what a
   * sequential collaboration group needs: each member keeps its OWN task, session
   * and pair, but they all write into one shared worktree so the integrator can read
   * their files. Returning `null` (the default) means owner === task: every task gets
   * its own workspace exactly as before, so an existing round is unchanged.
   *
   * This is deliberately a pure FUNCTION of the task, not a new registry: the
   * WorkspaceManager remains the single workspace-lifecycle authority, and the
   * owner id is just the key it is asked to prepare. The task/Attempt identity is
   * NEVER replaced by the owner id - only the physical directory is shared.
   */
  workspaceOwner?: (task: Task) => string | null;
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
  /**
   * P0-1: how long the approved completion test may run before it is stopped and its
   * result rejected. Defaults to 120s; tests shrink it.
   */
  completionTimeoutMs?: number;
  /**
   * P0-1: a NARROW test-only seam replacing the approved test's tree-stop verdict, so
   * the "unconfirmed stop retains the WRITE claim" branch can be driven without a real
   * orphan writer. Production leaves it undefined.
   */
  completionTestStopProbe?: () => boolean;
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
   * TeamRun T1-e: called EXACTLY ONCE for every execution that STARTED (after
   * `onStart` fired), when it reaches its terminal — success, failure, timeout,
   * cancellation, a refused write-back, or a `handle.result()` rejection that ends
   * without a RunResult. The symmetric half of `onStart`: whatever was marked running
   * at start is guaranteed one settlement here, independent of whether the TaskStore
   * accepted the result.
   *
   * Throwing from the callback aborts nothing (same contract as `onStart`).
   */
  onDispatchTerminal?: (handle: RunHandle, mapping: RunRequestMapping, terminal: DispatchTerminal) => void;
  /**
   * TeamRun T1-e: resolve the SESSION for THIS dispatch. Called once at the freeze
   * point — after the last pre-dispatch await (workspace preparation), when
   * `running.task` is the pair that will actually run and the dispatch lease is
   * captured. The resolution itself is owned by the caller (Workbench →
   * SessionRegistry); this layer only forwards it, uses the native handle for the
   * actual `RunRequest` (explicit `req.threadId` keeps priority) and echoes
   * `sessionId` on the `RunRequestMapping`, so the runtime request, the start
   * marking and the attempt attribution all stem from ONE dispatch binding.
   *
   * Returning undefined / no sessionId means "no compatible session for this pair" —
   * the execution proceeds sessionless. There is deliberately no "latest binding"
   * fallback inside this layer.
   */
  resolveSessionForDispatch?: (input: {
    taskId: string;
    agentId: string;
    modelId: string | null;
  }) => { sessionId?: string; nativeThreadId?: string } | undefined;
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
  const all = store.all();
  const known = new Map(all.map((t) => [t.taskId, t]));
  return all.some((t) => {
    if (t.depth <= 0 || t.taskId === selfTaskId) return false;
    // A RUNNING task is a live writer: always parallel work.
    if (t.status === 'running') return true;
    // A `planned`/`queued` task is parallel work only if it could actually run NOW —
    // i.e. its dependencies are satisfied. A task still waiting on an unmet dependency
    // (a later step of a SEQUENTIAL workflow) is NOT competing for the workspace, so it
    // must not be counted as a peer. Counting it is what refused a sequential write step
    // in a shared (non-git) workspace. Readiness uses the SAME `unmetDependencies` the
    // scheduler and `executeTask` use, so this cannot disagree with what would run.
    if (t.status === 'planned' || t.status === 'queued') {
      return unmetDependencies(t, known).length === 0;
    }
    return false;
  });
}

/**
 * P0-1: the trusted execution proof bound to one task's CURRENT execution.
 *
 * A coding task may succeed only when this proof exists AND still matches the task's
 * current lease/identity, or when it carries a complete, validated completion contract.
 * It is derived entirely from facts the execution edge already produced — the applied
 * `RunResult` (its fingerprint) and, when the workbench binds it, the attempt id and
 * sealed dispatch session. It invents no new evidence authority.
 */
export interface ExecutionProof {
  readonly leaseVersion: number;
  readonly agentId: string;
  readonly modelId: string | null;
  readonly sessionId: string | null;
  readonly attemptId: string | null;
  readonly runFingerprint: string;
  /**
   * P0-1: the fingerprint of the exact run the append-site binding named, when the
   * workbench supplied the real `RunResult`. When present it must equal
   * `runFingerprint`, so a binding for a DIFFERENT run can never be laundered in.
   * Absent means the binding carried no run; the attempt record correlation still
   * applies.
   */
  readonly bindingRunFingerprint?: string;
}

/**
 * P0-1: the EXACT `RunResult` object accepted for a task's current execution.
 *
 * Module-private (keyed by the orchestrator instance) and runtime-opaque: a caller can
 * read `executionProof` (TS `private` is erased at runtime) but can never reach this, so
 * it cannot substitute a different run object to make the attempt binding agree. Set
 * only inside `executeTask` when the write-back is ACCEPTED, cleared at the start of
 * every new execution and on a refused write-back, so a prior/cancelled/replaced run can
 * never prove the current one.
 */
const ACCEPTED_RUNS = new WeakMap<Orchestrator, Map<string, RunResult>>();
function acceptedRuns(owner: Orchestrator): Map<string, RunResult> {
  let map = ACCEPTED_RUNS.get(owner);
  if (map === undefined) {
    map = new Map<string, RunResult>();
    ACCEPTED_RUNS.set(owner, map);
  }
  return map;
}

export class Orchestrator {
  private readonly store: TaskStore;
  private readonly limits: OrchestrationLimits;
  private readonly now: () => number;
  private readonly runtime: RuntimeRunner | null;
  private readonly defaultCwd: string | null;
  /** R5-1 (P1-A): the native execution deadline, enforced by the runtime itself. */
  private readonly executionTimeoutMs: number | undefined;
  /** R5-1.1 (§4): bounded window for awaiting a terminal after a cancel request. */
  private readonly cancelConfirmWaitMs: number;
  private readonly workspace: WorkspaceManager | null;
  private readonly workspaceMode: (task: Task) => WorkspaceMode | 'none';
  /** B4.5: which physical workspace a task shares; `null` means owner === task. */
  private readonly workspaceOwnerOf: ((task: Task) => string | null) | null;
  /** R2-1: per-task resource intent. `null` = no claim, and the check is skipped. */
  private readonly resourceClaims: ((task: Task) => { mode: ResourceClaimMode; scope: ResourceScope } | null) | null;
  /**
   * P0-1: the completion evidence produced by the REAL dispatch, keyed by taskId.
   *
   * Like `lastObservations`, this is a READ-ONLY cache of execution facts — not a
   * state authority and not persisted. It is written only inside `executeTask` from
   * what the actual run and the actual contained test produced, and read only by the
   * shared `applyVerification('pass')` gate. A caller cannot register an entry, so a
   * forged outcome cannot mint a pass.
   */
  private readonly completionEvidence = new Map<string, CompletionEvidence>();
  /**
   * P0-1: the TRUSTED EXECUTION PROOF bound to the task's CURRENT execution.
   *
   * This is the fact that answers "did a real run happen for this task, and which
   * one". It is written by the execution edge (`applyRunResult`/`executeTask`) and
   * enriched at the Append site by the workbench with the attempt id and the sealed
   * dispatch session, so the completion gate can require that a coding task's pass is
   * backed by an actual execution rather than a hand-set `to_verify`.
   *
   * Like `lastObservations` this is a read-only cache of execution facts — not a
   * second evidence authority (AttemptStore still owns attempt records) and not
   * persisted. It is cleared at the start of every new execution, so a stale proof can
   * never answer for a fresh run.
   */
  private readonly executionProof = new Map<string, ExecutionProof>();
  /**
   * P0-1: a READ-ONLY reference to the EXISTING `AttemptStore`, attached once by the
   * workbench that owns it. It is used only to correlate a completion proof's claimed
   * attempt against the actual recorded attempt at the synchronous commit point. It is
   * not attached by callers, never appended through, and attaching twice is a no-op
   * (first store wins) so a later attach cannot swap the authority out from under a
   * live proof.
   */
  private attemptStore: AttemptStore | null = null;
  private readonly completionTimeoutMs: number;
  /** P0-1 test-only seam for the approved test's tree-stop verdict (see options). */
  private readonly completionTestStopProbe: (() => boolean) | undefined;
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
    // R5-1.1 (§6): fail fast at the boundary. An invalid deadline must never
    // reach `setTimeout`, where Node would clamp an overflow down to ~1 ms.
    if (options.executionTimeoutMs !== undefined) {
      const check = validateExecutionTimeoutMs(options.executionTimeoutMs);
      if (!check.ok) throw new Error(`Orchestrator: ${check.reason}`);
      this.executionTimeoutMs = check.value;
    } else {
      this.executionTimeoutMs = undefined;
    }
    this.cancelConfirmWaitMs = options.cancelConfirmWaitMs ?? CANCEL_CONFIRM_WAIT_MS;
    this.workspace = options.workspace ?? null;
    this.workspaceMode = options.workspaceMode ?? ((task) => (this.workspace === null ? 'none' : defaultWorkspaceMode(task)));
    this.workspaceOwnerOf = options.workspaceOwner ?? null;
    this.resourceClaims = options.resourceClaims ?? null;
    this.completionTimeoutMs = options.completionTimeoutMs ?? DEFAULT_COMPLETION_TEST_TIMEOUT_MS;
    this.completionTestStopProbe = options.completionTestStopProbe;
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
    // P0-1: this layer deliberately mints NO completion proof. A refused write-back is
    // still a real execution and stays historical evidence in the `AttemptStore`, but it
    // may NOT become completion proof. The trusted proof is created ONLY inside
    // `executeTask`, after the write-back is ACCEPTED, and it is enriched by the
    // workbench with the attempt id and sealed dispatch session at the append site.
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
    // P0-1: the ONE shared completion boundary. Every reachable route into `pass` —
    // the decision brain's `complete`, a human/checkpoint accept, the review loop —
    // funnels through here, so a task that declares a completion contract is checked
    // against REAL evidence before it may succeed. `rework`/`reject` are untouched.
    //
    // A CODING task that declares NO contract is not silently grandfathered: an actual
    // coding leaf must be backed by a trusted execution proof (a real run) or a
    // complete contract. A hand-set `to_verify` — a caller inventing a finished task —
    // is refused. research/review keep their explicit compatibility path.
    if (outcome.verdict === 'pass') {
      const task = this.store.get(taskId);
      if (task !== null && task.status === 'to_verify') {
        const refusal = this.completionRefusal(task);
        if (refusal !== null) {
          log.warn('completion refused by the completion gate', {
            taskId,
            code: refusal.code,
            reason: refusal.reason,
          });
          return { ok: false, code: refusal.code, reason: refusal.reason };
        }
      }
    }
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
   * P0-1: the synchronous completion decision for a coding task.
   *
   * Reads the current TASK identity/lease, RE-READS the workspace at this instant, and
   * correlates the proof's claimed attempt against the actual `AttemptStore` record, so
   * a reassignment, a new run, a foreign attempt or any file change after the proof was
   * gathered invalidates it. The core decision is the import-free
   * `evaluateCompletionGate`, so the gate is a value and cannot reach any authority.
   * Returns null when the pass may proceed.
   */
  private completionRefusal(task: Task): { code: string; reason: string } | null {
    const contract = task.completionContract;
    const proof = this.executionProof.get(task.taskId) ?? null;
    if (contract !== undefined) {
      // P0-1: the UNIFIED CONTRACT BOUNDARY. Every path that can write a task —
      // the plan-file parser, `commitPlan`, and a DIRECT `createRoot`/`TaskStore.create`
      // TaskSpec — funnels its `pass` through here, so the contract is re-validated with
      // the ONE parser before any completion. A direct TaskSpec that carried an empty
      // `expectedArtifacts` (or any partial/unsafe contract) is therefore refused here,
      // never silently accepted because it bypassed the plan-file path.
      try {
        parseCompletionContract(
          { expectedArtifacts: contract.expectedArtifacts, allowedScope: contract.allowedScope, test: contract.test },
          `task "${task.taskId}"`,
          { taskType: task.taskType },
        );
      } catch (e) {
        if (e instanceof CompletionContractError) {
          return {
            code: 'completion-contract-invalid',
            reason: `the completion contract on "${task.taskId}" is not valid against its task type: ${e.detail}`,
          };
        }
        throw e;
      }
      // A contract makes this a governed coding task. Before the file/test facts are
      // judged, the proof must be a REAL accepted execution bound to an attempt the
      // evidence authority actually recorded. A bare `RunResult` (or a hand-set
      // `to_verify`) is neither a completion contract nor a completion proof.
      const bindingRefusal = this.attemptBindingRefusal(task, proof);
      if (bindingRefusal !== null) return bindingRefusal;
      const evidence = this.completionEvidence.get(task.taskId) ?? null;
      // Re-read the workspace ONLY when there is evidence to compare against; a missing
      // evidence record must not depend on a filesystem read to be refused.
      const currentWorkspaceDigest = evidence === null
        ? null
        : manifestDigest(captureWorkspaceManifest(evidence.workspaceRoot));
      const result = evaluateCompletionGate({
        contractPresent: true,
        task: {
          taskId: task.taskId,
          leaseVersion: task.leaseVersion,
          agentId: task.agentId,
          modelId: task.modelId,
          contractDigest: completionContractDigest(contract),
        },
        evidence: evidence === null
          ? null
          : {
              contractDigest: evidence.contractDigest,
              taskId: evidence.taskId,
              leaseVersion: evidence.leaseVersion,
              agentId: evidence.agentId,
              modelId: evidence.modelId,
              runFingerprint: evidence.runFingerprint,
              sessionId: evidence.sessionId,
              workspaceDigest: evidence.workspaceDigest,
              unsafeWorkspace: evidence.unsafeWorkspace,
              testCode: evidence.test.code,
              testTimedOut: evidence.test.timedOut,
              testTreeStopConfirmed: evidence.test.treeStopConfirmed,
              missingArtifacts: evidence.missingArtifacts,
              outOfScope: evidence.outOfScope,
            },
        currentWorkspaceDigest,
        // The RUN and SESSION the proof is bound to, re-read synchronously here. A
        // missing proof is a refusal, never a default-allow.
        currentRunFingerprint: proof?.runFingerprint ?? null,
        currentSessionId: proof?.sessionId ?? null,
      });
      return result.ok ? null : { code: result.code, reason: result.reason };
    }

    // ----- No contract on the task -----
    // Non-coding work keeps its explicit compatibility path; it is not a code leaf.
    if (!isCodingTaskType(task.taskType)) return null;
    // P0-1: a coding task with NO contract is refused, FULL STOP. The old
    // `children().length > 0 && proof === null` exemption let an implementation root
    // with a merely PLANNED (never executed) child be caller-filled to `to_verify` and
    // completed with zero real runs. A child's PRESENCE is not aggregate evidence and is
    // not a coding contract; the CLI's RoundCompletionGuard already projects children and
    // does not need a fake root execution certified here. There is no aggregate engine.
    return {
      code: 'completion-contract-missing',
      reason:
        `coding task "${task.taskId}" (${task.taskType}) has no approved completion contract` +
        (proof === null
          ? ' and no trusted execution proof'
          : ' even though a real run executed') +
        `; a coding task cannot succeed without an approved completion contract`,
    };
  }

  /**
   * P0-1: correlate a completion proof's claimed attempt against the EXISTING evidence
   * authority, synchronously, at the commit point.
   *
   * The proof is created only by a real `executeTask` whose write-back was accepted; the
   * workbench then binds the attempt id `AttemptStore` minted and the exact run it
   * appended that record for. This method re-reads the CURRENT record and refuses when
   * the attempt, session, lease or identity do not line up. A foreign or missing attempt,
   * a stale session, a superseded lease or a binding for a different run therefore can
   * never mint success.
   */
  private attemptBindingRefusal(task: Task, proof: ExecutionProof | null): { code: string; reason: string } | null {
    if (proof === null) {
      return {
        code: 'completion-execution-proof-missing',
        reason:
          `task "${task.taskId}" declares a completion contract, but no accepted execution proof is bound to it; ` +
          `a refused write-back or a hand-set state cannot complete a coding task`,
      };
    }
    if (proof.leaseVersion !== task.leaseVersion || proof.agentId !== task.agentId || proof.modelId !== task.modelId) {
      return {
        code: 'completion-execution-proof-stale',
        reason:
          `the trusted execution proof for "${task.taskId}" belongs to lease ${proof.leaseVersion} ` +
          `${proof.agentId}/${proof.modelId ?? 'default'}, but the task is now lease ${task.leaseVersion} ` +
          `${task.agentId}/${task.modelId ?? 'default'}; a superseded run cannot prove the current one`,
      };
    }
    if (proof.attemptId === null) {
      // P0-1: a governed coding task MUST be correlated to the actual attempt its
      // accepted execution produced. The proof is minted with `attemptId: null` and is
      // enriched only at the append site where `AttemptStore` minted the record and the
      // workbench bound it. An unclaimed attempt — a lower caller that executed through
      // `executeTask` but never recorded/bound, a hand-set `to_verify`, or a refused
      // execution — is refused: no caller-supplied label and no bare RunResult is trust.
      return {
        code: 'completion-attempt-unbound',
        reason:
          `task "${task.taskId}" declares a completion contract, but no attempt was bound to its accepted ` +
          `execution; a governed coding task cannot complete without its recorded attempt`,
      };
    }
    if (proof.bindingRunFingerprint !== undefined && proof.bindingRunFingerprint !== proof.runFingerprint) {
      return {
        code: 'completion-attempt-run-mismatch',
        reason:
          `the attempt binding for "${task.taskId}" names a different run than the one the proof describes; ` +
          `only the exact run that produced the attempt can prove completion`,
      };
    }
    const store = this.attemptStore;
    if (store === null) {
      return {
        code: 'completion-attempt-store-unavailable',
        reason: `the attempt evidence store is not attached, so the completion proof cannot be correlated`,
      };
    }
    const record = store.get(proof.attemptId);
    if (record === null) {
      return {
        code: 'completion-attempt-foreign',
        reason: `the completion proof names attempt "${proof.attemptId}", which the evidence authority has no record of`,
      };
    }
    if (record.taskId !== task.taskId) {
      return {
        code: 'completion-attempt-foreign-task',
        reason: `attempt "${record.attemptId}" belongs to task "${record.taskId}", not "${task.taskId}"`,
      };
    }
    if (record.kind !== 'execution' && record.kind !== 'rework') {
      return {
        code: 'completion-attempt-kind',
        reason: `attempt "${record.attemptId}" is a ${record.kind} attempt, not the execution of this task`,
      };
    }
    if (record.agentId !== task.agentId || record.modelId !== task.modelId) {
      return {
        code: 'completion-attempt-identity-mismatch',
        reason:
          `attempt "${record.attemptId}" was produced by ${record.agentId}/${record.modelId ?? 'default'}, but the ` +
          `task is ${task.agentId}/${task.modelId ?? 'default'}`,
      };
    }
    if ((record.sessionId ?? null) !== proof.sessionId) {
      return {
        code: 'completion-attempt-session-mismatch',
        reason:
          `attempt "${record.attemptId}" ran in session ${record.sessionId ?? '<none>'}, but the completion proof ` +
          `is bound to session ${proof.sessionId ?? '<none>'}`,
      };
    }
    if (record.leaseVersion !== proof.leaseVersion) {
      return {
        code: 'completion-attempt-lease-mismatch',
        reason:
          `attempt "${record.attemptId}" ran under lease ${record.leaseVersion ?? '<none>'}, but the completion ` +
          `proof is bound to lease ${proof.leaseVersion}`,
      };
    }
    if (record.outcome !== 'success') {
      return {
        code: 'completion-attempt-not-success',
        reason: `attempt "${record.attemptId}" is recorded as ${record.outcome}, so it cannot prove completion`,
      };
    }
    // The final, unforgeable check: the claimed attempt must be the APPEND-SITE
    // provenance of the exact run this task accepted — the SAME store, the SAME record
    // object, the SAME id. A record appended for a different run (even one with the same
    // task/pair/session/lease, or a clone with matching fields), a replay that appended a
    // second record, a record minted by ANOTHER store (a colliding `att_XXXX`), or a
    // directly appended record under the same id, was never correlated to the accepted
    // run object, so it can never complete.
    const accepted = acceptedRuns(this).get(task.taskId);
    const provenance = accepted === undefined ? null : runProvenanceOf(accepted);
    if (provenance === null || provenance.store !== store || provenance.attemptId !== proof.attemptId || provenance.record !== record) {
      return {
        code: 'completion-attempt-provenance-mismatch',
        reason:
          `the completion proof for "${task.taskId}" names attempt "${proof.attemptId}", but the task's accepted ` +
          `execution was recorded as ${provenance === null ? '<no correlated attempt>' : `"${provenance.attemptId}"`}; ` +
          `only the exact attempt its accepted run produced can prove completion`,
      };
    }
    return null;
  }

  /**
   * P0-1: attach the EXISTING `AttemptStore` so completion can correlate a claimed
   * attempt against it. Called once by the workbench that owns the store. Idempotent
   * (first store wins) and read-only: this layer never appends through it.
   */
  attachAttemptStore(store: AttemptStore): void {
    if (this.attemptStore === null) this.attemptStore = store;
  }

  /**
   * P0-1: bind the append-site attempt correlation to the task's current execution proof.
   *
   * Called by the workbench once it has, in one breath, the attempt id `AttemptStore`
   * minted and the exact `RunResult` it appended that record for. It records a CLAIM —
   * the attempt id, the sealed dispatch session, and the fingerprint of the run it names
   * — on a proof that ALREADY exists (it never creates one). The claim is not trusted
   * here: `completionRefusal` re-reads the actual `AttemptStore` record and refuses a
   * foreign, stale or mismatched attempt. A bare relabel therefore cannot succeed.
   */
  recordAttemptBinding(taskId: string, binding: { attemptId: string; sessionId: string | null; run?: RunResult }): void {
    const current = this.executionProof.get(taskId);
    if (current === undefined) return;
    let bindingRunFingerprint: string | undefined;
    const run = binding.run;
    if (run !== undefined && run !== null && typeof run.startedAt === 'number') {
      bindingRunFingerprint = runFingerprintOf({
        taskId,
        agentId: current.agentId,
        modelId: current.modelId,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        state: run.state,
        exitCode: run.exitCode,
      });
    }
    // This records a CLAIM, not trust: the attempt id and session are set here, but
    // `completionRefusal`/`attemptBindingRefusal` re-read the actual `AttemptStore` record
    // AND the append-site run provenance of the ACCEPTED run before any pass. A relabel
    // to another attempt (or a fabricated run) therefore can only produce a refusal.
    this.executionProof.set(taskId, {
      ...current,
      attemptId: binding.attemptId,
      sessionId: binding.sessionId,
      ...(bindingRunFingerprint === undefined ? {} : { bindingRunFingerprint }),
    });
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
    /*
     * W3: the physical tree-stop verdict for THIS dispatch.
     *
     * A one-element holder rather than a `boolean`: the value is written deep
     * inside the post-start region, and a narrowed closure-captured `let` reads as
     * permanently `false` at the `finally` below — which would silently restore
     * the unconditional release this gate exists to prevent.
     *
     * It starts as "no evidence", which is the fail-closed default: an execution
     * that produced no run result at all cannot have released its files, so its
     * claim is retained.
     */
    const stopConfirmed: boolean[] = [];
    const stopOutcome: (string | null)[] = [];
    /*
     * P0-1/W3: did the APPROVED COMPLETION TEST enter its own execution edge?
     *
     * A one-element holder, raised BEFORE the `ManagedProcess` constructor. The test runs
     * inside the SAME `try/finally` as the agent run, so its stop verdict must participate
     * in the ONE outer WRITE-claim release decision: an agent's earlier confirmed stop
     * cannot authorise releasing a claim while a test process may still be writing.
     */
    const testMayHaveStarted: boolean[] = [false];
    /*
     * W3.1: does THIS execution require positive proof that its tree stopped before
     * the write scope may be released?
     *
     * This REPLACES the previous `executionStarted` flag, which was wrong twice over.
     * It was set only AFTER `runtime.run()` returned, so a throw that happened after a
     * real writer had already spawned read as "never started" and released the claim
     * while that writer kept writing (P1-A). And it conflated two different questions
     * — "did a process start?" and "is it safe to release without proof?" — which do
     * not have the same answer.
     *
     * The frozen rule:
     *
     *   known pre-start              -> no proof required, claim may release
     *   execution edge entered       -> proof required
     *   treeStopConfirmed === true   -> claim may release
     *   anything else / unknown      -> claim MUST remain
     *
* The holder is SEEDED with `false` — "the edge has not been entered, so there is
     * no possible writer and no proof is owed". It is an array rather than a `boolean`
     * because the value is written deep inside the post-start region, and a narrowed
     * closure-captured `let` would read as permanently `false` at the `finally` below
     * — silently restoring an unconditional release.
     *
     * Seeding matters, and it is the subtle part. An EMPTY holder would have to fail
     * closed (requiring proof), which would then also treat "the edge was never
     * reached" as "we owe proof" — retaining a claim for an execution that never
     * ran, and locking the workspace for a risk that does not exist. The two states
     * are genuinely different, so they are represented by different values:
     * `false` = never entered, `true` = entered and proof is owed.
     */
    const requiresTreeStopProof: boolean[] = [false];
    /**
     * Typed evidence, produced ONLY by the runtime seam. Only a proven
     * `not-started` may downgrade the requirement; a generic throw leaves it
     * untouched and the requirement stands.
     */
    const startDisposition: (ProcessStartDisposition | null)[] = [];
    if (this.workspace !== null) {
      const mode = requiredMode;
      if (mode !== 'none') {
        // B4.5: a task may share the PHYSICAL workspace of an owner task (a
        // collaboration group's root). The task keeps its own identity; only the
        // directory/branch/baseSha are shared. Default resolver -> owner === task.
        const ownerTaskId = this.workspaceOwnerOf?.(task) ?? task.taskId;
        try {
          workspace = await this.workspace.prepare({
            taskId: task.taskId,
            ownerTaskId,
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
        // R5-1.2 (P1-3): LOGICAL fencing validity and PHYSICAL exclusion are two
        // different questions. A stale lease voids the claim's WRITE-BACK authority
        // (fencing keeps refusing the stale result), but while an execution is
        // STILL LIVE it may still be writing the same physical scope, so the claim
        // must keep excluding rival writers. Voiding a live writer's claim used to
        // admit a second writer into the very workspace the first was still
        // mutating. The physical claim is released by the execution's own settle
        // path (`releaseClaim` in executeTask), i.e. exactly when the stop is real.
        this.workspace.voidStaleResourceClaims(
          (c) =>
            !claimIsLeaseCurrent(c, claimLeaseVersionOf(this.store.leaseOf(c.taskId), nowMsForVoid)) &&
            !this.liveHandles.has(c.taskId),
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
    //
    // P0-1: the BASELINE manifest is captured HERE - after the workspace is prepared
    // and the claim is taken, but BEFORE the sealed session→runtime freeze below. It is
    // synchronous, so it adds no await to the freeze region, and it sees the real
    // workspace including preexisting dirty and ignored files.
    const completionContract = task.completionContract;
    const baselineManifest: WorkspaceManifest | null = completionContract === undefined
      ? null
      : captureWorkspaceManifest(resolvedCwd);
    try {

      // ---- TeamRun T1-e/T1-g freeze point: pre-runtime context validation -------
      //
      // Still strictly AFTER the last pre-dispatch await (workspace preparation
      // above) and still SYNCHRONOUS through `runtime.run` — so the T1-e atomic
      // freeze and the Race A/B/C semantics are untouched. The fresh store read is
      // the pair this dispatch will actually run (a reassign during prepare is
      // already visible); nothing can change it between here and the mutations
      // below, because no await intervenes.
      //
      // T1-g: this validation runs BEFORE any state commit — before `queued`/
      // `running`, before lease activation, before the scheduler slot could be
      // observed as consumed. A thread/session conflict is therefore an ordinary
      // pre-runtime refusal: the task keeps its schedulable status, the lease stays
      // `issued` (never pretending to protect a live writer that does not exist),
      // and no unwind is needed. Previously the check ran after the running commit
      // and left the task stranded `running` with an activated lease — a refusal
      // that occupied a live-execution state for an execution that never began.
      const preRunTask = this.store.get(task.taskId);
      if (preRunTask === null) {
        return {
          ok: false,
          code: 'task-not-found',
          reason: `no task "${task.taskId}" at dispatch time; refusing before any state change`,
          status: task.status,
          gate: decision,
        };
      }

      // ---- B2.1a: final pre-start USER-POOL validity check -------------------
      // The user-declared no-additional-charge pool was checked at the entry gate,
      // but that ran BEFORE `workspace.prepare()` was awaited. A declaration can
      // expire during that await, and the frozen pair would still start. This
      // re-runs the SAME gate/predicate at the REAL start time (via `Date.now()`),
      // on the fresh pair this dispatch will actually run, BEFORE the session/thread
      // decision and every queued/running/lease/onStart/runtime commit. An expiry is
      // therefore an ordinary pre-start refusal: the task keeps its status, the lease
      // stays `issued` (never activated), no session or Attempt is fabricated, and the
      // claim taken above is released by the existing `finally`. Absent pool = the
      // previous behaviour byte for byte. Only the pool enables this extra call.
      if (this.gate.userModelPool !== undefined) {
        const poolDecision = buildSpawnGateInput({
          taskId: preRunTask.taskId,
          agentId: preRunTask.agentId,
          modelId: preRunTask.modelId,
          requestedUnits: preRunTask.budgetUnits,
          sources: {
            ...this.gate,
            taskType: preRunTask.taskType,
            currentConcurrency: this.runningChildrenExcluding(preRunTask.taskId),
            maxConcurrency: this.getConcurrencyLimit(),
          },
        });
        if (!poolDecision.result.allowed) {
          const missingNote =
            poolDecision.missing.length > 0 ? ` (missing signals: ${poolDecision.missing.map((m) => m.code).join(', ')})` : '';
          return {
            ok: false,
            code: poolDecision.result.code,
            reason: `${poolDecision.result.reason}${missingNote}`,
            status: preRunTask.status,
            gate: poolDecision,
          };
        }
      }

      const dispatchSession = req.resolveSessionForDispatch?.({
        taskId: task.taskId,
        agentId: preRunTask.agentId,
        modelId: preRunTask.modelId,
      });
      // T1-f: the ONE thread/session compatibility decision (pure value, no awaits).
      const dispatchContext = resolveDispatchContext({
        ...(req.threadId !== undefined ? { explicitThreadId: req.threadId } : {}),
        ...(dispatchSession !== undefined ? { resolvedSession: dispatchSession } : {}),
      });
      if (!dispatchContext.ok) {
        return {
          ok: false,
          code: dispatchContext.code,
          reason: dispatchContext.reason,
          // Authoritative: the task was NEVER moved; returned status and TaskStore
          // agree, and the task can be re-dispatched with a corrected request.
          status: preRunTask.status,
          gate: decision,
        };
      }

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
      //
      // R5-1 (§5): the activation TTL must cover the run's OWN execution deadline.
      // With the store default (15 min) and a native budget of 20+ min, a normal long
      // run used to go stale mid-execution purely because no tick (and therefore no
      // renew) could happen while `tick()` was awaiting the run. The dispatch lease is
      // therefore activated with a TTL of at least deadline + write-back margin, using
      // the SAME Lease primitives — no heartbeat, no new authority. Renewal stays
      // tick-driven for multi-tick loops.
      this.store.markLeaseUsed(task.taskId, this.now(), this.dispatchLeasePolicy());

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
      // (T1-e/T1-g: the session resolution and the thread/session compatibility
      // decision now happen BEFORE the state commit above — same synchronous freeze
      // region, same `preRunTask` pair the mutations commit — so a refusal can never
      // strand a `running` task or an activated lease.)
      let handle: RunHandle;
      let mapping: RunRequestMapping;
      /*
       * W3.1 (P1-A): the requirement is raised BEFORE the `try`, not inside it.
       *
       * This is the whole closure. The previous code set its flag on the line AFTER
       * `runtime.run()` returned, so any throw skipped it — and a throw can happen long
       * after a real `ManagedProcess` has already spawned a writer. That writer kept
       * writing while the `finally` below released the exclusive WRITE claim and
       * admitted a second writer into the same scope.
       *
       * From here the execution edge is ENTERED: the runtime may create an OS process
       * at any moment, so no generic failure may be read as "nothing started". The
       * requirement is only lowered by explicit typed proof from the runtime seam.
       */
      requiresTreeStopProof[0] = true;
      // P0-1: a NEW execution begins — drop any earlier run's proof/evidence for this
      // task so a completion can only ever answer for THIS run.
      this.completionEvidence.delete(task.taskId);
      this.executionProof.delete(task.taskId);
      acceptedRuns(this).delete(task.taskId);
      try {
        const built = buildRunRequest({
          task: running.task,
          cwd: resolvedCwd,
          ...(req.prompt !== undefined ? { prompt: req.prompt } : {}),
          // T1-e/T1-f: the thread comes from the ONE context decision above — the
          // resolver's native handle for the resolved session, or an explicit thread
          // that either matches that session or runs sessionless. Never both sources
          // silently stitched.
          ...(dispatchContext.threadId !== undefined ? { threadId: dispatchContext.threadId } : {}),
          // R5-1 (P1-A): the execution deadline rides on the RunRequest, so the
          // runtime's own AgentSession enforces it (real `timed_out` terminal through
          // its transport-cancel path). The orchestrator never kills anything.
          ...(this.executionTimeoutMs !== undefined ? { timeoutMs: this.executionTimeoutMs } : {}),
        });
        // T1-e/T1-f: the dispatch-time session rides on the mapping, so BOTH the
        // accepted and the refused-with-run outcome carry the same one dispatch
        // binding — the same context the thread above was chosen from.
        mapping = dispatchContext.sessionId !== undefined
          ? { ...built.mapping, sessionId: dispatchContext.sessionId }
: built.mapping;
        handle = this.runtime.run(built.request);
        startDisposition[0] = 'started';
      } catch (e) {
        /*
         * W3.1 (§5): the ONLY thing that may downgrade the requirement is explicit
         * typed evidence from the runtime seam that it PROVED no process was created.
         *
         * No message matching, no error-class-name guessing, no "it threw early so it
         * probably did not start". A generic throw keeps `requiresTreeStopProof = true`
         * and the claim is retained at the `finally`: being too conservative costs
         * availability, while releasing early costs a corrupted workspace.
         */
        if (isProvenNotStarted(e)) {
          requiresTreeStopProof[0] = false;
          startDisposition[0] = 'not-started';
        } else {
          startDisposition[0] = 'may-have-started';
          log.warn('runtime.run threw without proven pre-start evidence; retaining physical protection', {
            taskId: task.taskId,
            error: (e as Error).message,
          });
        }
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

      // T1-e: EXACTLY-ONCE terminal settlement. This try/finally belongs to ONE
      // dispatch: whatever exit the post-start region takes — a frozen RunResult
      // (accepted OR refused write-back), a result() rejection with a terminal
      // state, or an unexpected throw — `onDispatchTerminal` fires exactly once,
      // with the run when one exists and `withoutResult` when one does not. It
      // never fires for pre-start returns (refusals above), matching the start
      // contract: no onStart => no settlement obligation.
      // (The existing lines below are wrapped as-is; only the wrapping is new.)
      let terminal: DispatchTerminal | undefined;
      try {
      // ---- wait for the real result ----
      //
      // R5-1 (P1-A): NO wait bound here. The previous code passed a wait timeout
      // (the Laya decision timeout, no less) to `handle.result(timeoutMs)`, whose
      // contract is "bounds THIS call only and does not alter the outcome". On
      // expiry the rejection was treated as an execution failure: the live handle
      // was deleted, the task marked failed, and the claim released — all while the
      // native agent was still running. That was a fabricated terminal.
      //
      // Now the wait ends only when the execution is REALLY terminal: either the
      // run settles on its own, or the configured `RunRequest.timeoutMs` deadline
      // makes the session terminate itself through its own boundary and freeze a
      // real `timed_out` result. If `result()` ever rejects while the handle's own
      // state says the execution is NOT terminal, we keep the handle, the lease and
      // the claim intact and simply keep waiting — a wait gap is never a verdict.
      let result: RunResult;
      for (;;) {
        try {
          result = await handle.result();
          break;
        } catch (e) {
          const stillLive = !isTerminal(handle.state());
          if (!stillLive) {
            // A genuine runtime failure: the execution is over and produced no
            // frozen result. Existing failure path applies (fenced, evidence-honest).
            const message = e instanceof Error ? e.message : String(e);
this.liveHandles.delete(task.taskId);
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
          // Execution still running. Keep every protection in place and continue
          // waiting for the real terminal; the deadline (if configured) belongs to
          // the session inside the execution boundary, not to this wait.
          //
          // R5-1.1 (§9): yield to the event loop between re-waits. A normal
          // AgentSession never rejects here, but a pathological adapter/stub whose
          // `result()` rejects immediately while `state()` stays non-terminal would
          // otherwise spin the microtask queue and starve the process. The backoff
          // bounds nothing semantically — it only stops the defensive path from
          // busy-spinning while it keeps waiting for the real terminal.
          const message = e instanceof Error ? e.message : String(e);
          log.warn('result wait returned before a terminal result; still live, continuing to wait', {
            taskId: task.taskId,
            reason: message,
          });
          await new Promise((r) => setTimeout(r, RESULT_GAP_BACKOFF_MS));
        }
      }
this.liveHandles.delete(task.taskId);
      // W3: record the PHYSICAL verdict alongside the logical one, BEFORE the
      // write-back. It is read from the frozen result's cleanup report, which the
      // runtime populated from the containment producer, so this layer never
      // re-derives or guesses it.
      //
      // A `succeeded` run therefore normally records `true` (the Job emptied on its
      // own), and a cooperatively stopped run can record `true` as well — a
      // cancellation and a confirmed physical stop are a NORMAL combination. What
      // never yields `true` is an execution with no evidence at all.
      // Read defensively: `cleanup` is part of the RunResult contract, but a test double
      // or an adapter that omits it must NOT crash the dispatch. An absent cleanup
      // report carries no stop evidence, and no evidence means the claim is retained.
      stopConfirmed.push(result.cleanup?.treeStopConfirmed === true);
      stopOutcome.push(result.state);
      /*
       * W3.2: the runtime may also PROVE, in the frozen result, that nothing was ever
       * created. That is the launcher-missing case: the image was proven absent before
       * `spawn`, so the run ends `SPAWN_FAILED` with no process behind it.
       *
       * Recording it here — next to the tree-stop verdict — keeps the `finally` gate
       * reading two holders rather than reaching for a `RunResult` that is out of scope.
       */
      if (result.cleanup?.processStart === 'not-started') startDisposition[0] = 'not-started';
      // T1-e: the execution froze a RunResult — this is the settlement payload,
      // carried whether the write-back below is accepted or refused (§13: session
      // settlement is an execution fact, not a workflow fact).
      terminal = { run: result };
      // Final machine facts: processState is now 'exited' with the real exit code.
      const observationAtSettle = handle.observe?.() ?? null;
      if (observationAtSettle !== null) this.lastObservations.set(task.taskId, observationAtSettle);

      // ---- write the result back to the lifecycle ----
      const applied = this.applyRunResult(task.taskId, result, dispatchedLease, req.translate ?? {});
      const runFingerprint = runFingerprintOf({
        taskId: task.taskId,
        agentId: result.agentId,
        modelId: running.task.modelId,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        state: result.state,
        exitCode: result.exitCode,
      });
      // P0-1: a completion proof exists ONLY for an ACCEPTED write-back of a real run.
      // A REFUSED write-back is still a real execution and stays historical evidence in
      // the `AttemptStore`, but it must NOT become a completion proof. The proof is bound
      // to the exact run the task accepted and the sealed dispatch session; the workbench
      // later enriches it with the attempt id `AttemptStore` minted for that run.
      if (applied.ok) {
        // The EXACT object the accepted execution produced. Bound to the proof here (and
        // to the evidence authority at the append site) so completion can require that
        // the recorded attempt is this run's own provenance, not a relabel.
        acceptedRuns(this).set(task.taskId, result);
        this.executionProof.set(task.taskId, {
          leaseVersion: dispatchedLease.leaseVersion,
          agentId: running.task.agentId,
          modelId: running.task.modelId,
          sessionId: mapping?.sessionId ?? null,
          attemptId: null,
          runFingerprint,
        });
        // ---- P0-1: gather completion evidence while the WRITE claim is still held ----
        //
        // The approved test runs AFTER the agent and BEFORE the claim is released, so a
        // writer cannot slip into the workspace between the run and the proof. Evidence
        // is gathered only from a successful run; a failed/cancelled run leaves the gate
        // with nothing to accept. A gathering failure deletes any prior entry so the
        // gate refuses rather than reusing a stale proof.
        if (completionContract !== undefined && baselineManifest !== null && result.state === 'succeeded') {
          try {
            const afterRun = captureWorkspaceManifest(resolvedCwd);
            const evidence = await buildCompletionEvidence({
              taskId: task.taskId,
              leaseVersion: dispatchedLease.leaseVersion,
              agentId: running.task.agentId,
              modelId: running.task.modelId,
              sessionId: mapping?.sessionId ?? null,
              contract: completionContract,
              workspaceRoot: resolvedCwd,
              before: baselineManifest,
              afterRun,
              runFingerprint,
              timeoutMs: this.completionTimeoutMs,
              now: this.now(),
              // Raise the outer requirement BEFORE the test's ManagedProcess edge so a
              // throw inside it can never be read as "the test never started".
              hooks: { onMayHaveStarted: () => { testMayHaveStarted[0] = true; requiresTreeStopProof[0] = true; }, ...(this.completionTestStopProbe !== undefined ? { stopVerdictProbe: this.completionTestStopProbe } : {}) },
            });
            this.completionEvidence.set(task.taskId, evidence);
            // The test's OWN tree-stop verdict participates in the shared release
            // decision. If a test process may have started and its stop is unconfirmed,
            // the WRITE claim is retained even when the agent's stop was confirmed.
            if (evidence.test.mayHaveStarted) {
              stopConfirmed[0] = stopConfirmed[0] === true && evidence.test.treeStopConfirmed;
            }
          } catch (e) {
            log.warn('completion evidence gathering failed; completion will be refused', {
              taskId: task.taskId,
              error: (e as Error).message,
            });
            this.completionEvidence.delete(task.taskId);
            // The test edge may have been entered before the throw: retain protection.
            if (testMayHaveStarted[0]) stopConfirmed[0] = false;
          }
        } else if (completionContract !== undefined) {
          // A run that did not succeed cannot produce completion evidence; drop any stale
          // entry so a later mismatched pass cannot reuse it.
          this.completionEvidence.delete(task.taskId);
        }
      } else {
        // A refused write-back is execution evidence, never completion proof.
        this.executionProof.delete(task.taskId);
        this.completionEvidence.delete(task.taskId);
        acceptedRuns(this).delete(task.taskId);
      }
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
        // T1-e: the settlement obligation created by `onStart` is discharged here,
        // exactly once, on every post-start exit path (see the comment above).
        if (req.onDispatchTerminal !== undefined) {
          try {
            req.onDispatchTerminal(handle, mapping, terminal ?? {
              withoutResult: true,
              reason: 'the execution ended without producing a frozen RunResult',
            });
          } catch {
            // A caller's observer must not be able to fail the execution.
          }
        }
      }
} finally {
        /*
         * W3.1: WRITE protection is released ONLY on positive physical evidence, and
         * RETAINED DURABLY otherwise.
         *
         * An EXCLUSIVE WRITE claim is physical protection, not bookkeeping. Releasing
         * it because "the execution settled" is the defect: a cancelled or timed-out
         * run whose launcher was hard-killed settles its session while a descendant is
         * still writing that very scope, and the next writer is admitted on top of a
         * live one.
         *
         * W3.1 closes two holes in the W3 version of this gate:
         *
         *   P1-A  The old flag was set AFTER `runtime.run` returned, so a throw that
         *         happened after a real writer had spawned read as "never started" and
         *         released the claim under a live writer. The requirement is now raised
         *         BEFORE the edge, and only typed proven pre-start evidence lowers it.
         *
         *   P1-B  "Not calling release" was not retention. The claim lived in an
         *         orchestrator local, while the claim that actually excludes writers
         *         lives in `ResourceClaimBook` — so the next admission's stale cleanup
         *         deleted it on "lease dead, handle gone" and B walked in. Retention is
         *         now recorded IN the book, where every sweep must respect it.
         *
         * The asymmetry is deliberate and stays: an over-held scope blocks one rival
         * writer, while an under-held one corrupts a workspace.
         */
        if (claimedScope !== null) {
          const confirmed = stopConfirmed[0] === true;
          // Seeded false, so this is false for a genuine pre-start exit and true once
          // the edge was entered. `undefined` is impossible by construction.
          const proofRequired = requiresTreeStopProof[0];
          /*
           * W3.2: a run that RETURNS a handle can still prove nothing was created.
           *
           * The launcher-missing path is exactly this: `ManagedProcess` records
           * `processStart: 'not-started'` from its own knowledge (the image was proven
           * absent before `spawn`), the session freezes that into the `RunResult`, and
           * the claim can be released once the operator builds the launcher. Without
           * this, a missing binary left every WRITE scope in the project permanently
           * blocked — the availability half of the P1-A finding.
           *
           * Only the value `'not-started'` releases. Anything else — including a value
           * that a caller forgot to set — is "no proof", and no proof retains.
           *
           * P0-1: once the APPROVED TEST edge was entered (`testMayHaveStarted`), the
           * agent's own proven-not-started fact can no longer release the claim: the test
           * is a second process edge, and only ITS confirmed stop (folded into
           * `confirmed` above) may release.
           */
          const provenNotStarted = startDisposition[0] === 'not-started' && !testMayHaveStarted[0];
          if (!proofRequired || confirmed || provenNotStarted) {
            // Idempotent by construction: `releaseClaimForScope` removes what it finds,
            // so a second call is a no-op returning 0 rather than an error.
            this.releaseClaim(task.taskId, claimedScope);
          } else {
            /*
             * Record the retention where it is durable. A bool in this closure would
             * die with this stack frame; the claim in the book is what the next
             * admission consults.
             */
            const reason =
              `task "${task.taskId}" entered the execution edge (processStartDisposition=` +
              `${startDisposition[0] ?? 'unknown'}) but its tree stop was NOT confirmed ` +
              `(outcome=${stopOutcome[0] ?? '<no run result>'}); a writer may still hold this scope`;
            const held = this.workspace?.retainResourceProtection(
              task.taskId, claimedScope.mode, claimedScope.scope, reason,
            ) ?? 0;
            log.warn('retaining the exclusive write claim: no confirmed tree stop', {
              taskId: task.taskId,
              outcome: stopOutcome[0] ?? '<no run result>',
              disposition: startDisposition[0] ?? 'unknown',
              claimsRetained: held,
            });
          }
        }
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

  /**
   * R5-1 (§5): the RenewPolicy a dispatch activates its lease under.
   *
   * The TTL must cover the execution the dispatch is about to start, plus a small
   * write-back margin — otherwise a legitimately long run goes stale mid-execution
   * and its write-back is refused. Same Lease primitives, same renewals, no new
   * authority; when no deadline is configured, the store's own policy applies
   * unchanged.
   */
  private dispatchLeasePolicy(): RenewPolicy {
    const storePolicy = this.store.leasePolicy;
    if (this.executionTimeoutMs === undefined) return storePolicy;
    return {
      ...storePolicy,
      ttlMs: Math.max(storePolicy.ttlMs, this.executionTimeoutMs + LEASE_WRITEBACK_MARGIN_MS),
    };
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
  /**
   * R5-1.1 (§4): request cancellation and CONFIRM the terminal before treating the
   * task as stopped.
   *
   * A cancellation REQUEST is not a terminal CONFIRMATION. The confirmation fact is
   * the handle's own frozen terminal — awaited through `result()` with a bounded
   * confirmation window (the runtime is mid-`cancel()`, so this resolves as soon as
   * the runtime finishes its own finalize, never a sleep-and-guess). While the
   * execution is not confirmed terminal, EVERYTHING stays in place: the live handle,
   * the concurrency slot, the resource claim and the lease/fencing protection. Only
   * after confirmation is the handle released and the store transition legitimate.
   *
   * Returns `confirmed: false` when the cancellation could not be confirmed inside
   * the window — the caller must surface that fact, never fabricate a `cancelled`
   * terminal over a live execution.
   */
  private async requestConfirmedCancel(
    handle: RunHandle,
    taskId: string,
    reason: string,
  ): Promise<{ confirmed: boolean; detail: string }> {
    // R5-1.2 (§7): the cancel REQUEST and the terminal CONFIRMATION get separate
    // bounded waits — one timeout must never silently mean both. A request that
    // neither settles nor fails within its window leaves the end state unknown,
    // which is exactly the not-confirmed case; the request may still land later,
    // which is safe (it only ever stops the same execution).
    let requestSettled = false;
    try {
      let requestTimer: NodeJS.Timeout | null = null;
      const verdict = await Promise.race([
        handle.cancel(reason).then(
          () => 'settled' as const,
          () => 'failed' as const,
        ),
        new Promise<'hung'>((r) => {
          requestTimer = setTimeout(() => r('hung'), this.cancelConfirmWaitMs);
        }),
      ]).finally(() => {
        if (requestTimer !== null) clearTimeout(requestTimer);
      });
      if (verdict === 'failed') {
        // The cancel REQUEST itself failed. The execution's end state is unknown,
        // so nothing may be torn down; check whether it is somehow already
        // terminal anyway before reporting the refusal.
        const terminalAnyway = isTerminal(handle.state());
        if (!terminalAnyway) {
          return { confirmed: false, detail: 'cancel request failed; end state unknown' };
        }
      } else if (verdict === 'hung') {
        return {
          confirmed: false,
          detail: `cancel request did not settle within ${this.cancelConfirmWaitMs}ms; end state unknown`,
        };
      }
      requestSettled = true;
    } catch (e) {
      return { confirmed: false, detail: `cancel request failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    void requestSettled;
    try {
      await handle.result(this.cancelConfirmWaitMs);
    } catch {
      // A rejecting wait is not a verdict (R5-1 P1-A); fall through to the state check.
    }
    if (!isTerminal(handle.state())) {
      return {
        confirmed: false,
        detail: `cancellation not confirmed: task "${taskId}" is still ${handle.state()} after the cancel request`,
      };
    }
    // Confirmed terminal: now — and only now — the handle registry entry can go.
    this.liveHandles.delete(taskId);
    return { confirmed: true, detail: 'execution confirmed terminal after cancellation' };
  }

  async cancelTask(taskId: string, reason: string): Promise<{ ok: boolean; code: string; reason: string; delegatedToRuntime: boolean }> {
    const task = this.store.get(taskId);
    if (task === null) return { ok: false, code: 'task-not-found', reason: `no task "${taskId}"`, delegatedToRuntime: false };

    const handle = this.liveHandles.get(taskId);
    if (handle !== undefined) {
      // Delegate. The runtime's own cancellation does everything that touches a
      // process; duplicating it here would be the bug, not the feature.
      const confirmation = await this.requestConfirmedCancel(handle, taskId, reason);
      if (!confirmation.confirmed) {
        // R5-1.1 (§4): the execution may STILL BE RUNNING. Deleting the handle here
        // used to drop the concurrency slot and the resource protection while the
        // native process lived on, and the store transition below fabricated a
        // `cancelled` terminal over it. Now: report the fact, tear down nothing.
        return {
          ok: false,
          code: 'cancellation-not-confirmed',
          reason: `${confirmation.detail}; the live handle, lease and resource protection are retained`,
          delegatedToRuntime: true,
        };
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
    // cancelled underneath itself. Same confirmation rule as above.
    for (const t of liveBelow) {
      const h = this.liveHandles.get(t.taskId);
      if (h === undefined) continue;
      const confirmation = await this.requestConfirmedCancel(h, t.taskId, reason);
      if (!confirmation.confirmed) {
        return {
          ok: false,
          code: 'cancellation-not-confirmed',
          reason: `${confirmation.detail}; the live handle, lease and resource protection are retained`,
          delegatedToRuntime: true,
        };
      }
    }

    // R5-1.2 (P1-2): the descendant snapshot above went stale the moment the first
    // `await` completed — a NEW descendant can become live during the cancellation
    // window. RE-READ the live set after every await and reconcile; the state-level
    // cancel below must never overtake execution reality.
    for (let pass = 0; pass < 3; pass++) {
      const newlyLive = this.store.descendants(taskId).filter((t) => this.liveHandles.has(t.taskId));
      if (newlyLive.length === 0) break;
      for (const t of newlyLive) {
        const h = this.liveHandles.get(t.taskId);
        if (h === undefined) continue;
        const confirmation = await this.requestConfirmedCancel(h, t.taskId, reason);
        if (!confirmation.confirmed) {
          return {
            ok: false,
            code: 'cancellation-not-confirmed',
            reason: `${confirmation.detail}; the live handle, lease and resource protection are retained`,
            delegatedToRuntime: true,
          };
        }
      }
    }
    // Final gate immediately before the logical cancel: every live execution in the
    // subtree must be terminal/confirmed, or the state layer refuses to move.
    if (this.store.descendants(taskId).some((t) => this.liveHandles.has(t.taskId))) {
      return {
        ok: false,
        code: 'cancellation-not-confirmed',
        reason: `a live execution appeared in the subtree of "${taskId}" during cancellation and is not confirmed stopped; nothing was marked cancelled`,
        delegatedToRuntime: true,
      };
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
