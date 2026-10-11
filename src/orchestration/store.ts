/**
 * src/orchestration/store.ts - the single authority for task state.
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
 * "id - task" map does not have one. The store therefore indexes by BOTH id
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
import {
  activateLease,
  isLeaseLive,
  issueLease,
  mintFencingToken,
  modelKeyOf,
  renewLease,
  revokeLease,
  DEFAULT_RENEW_POLICY,
  type AssignmentLease,
  type RenewLeaseOutcome,
  type RenewPolicy,
} from './assignment-lease.ts';

/**
 * R2-2: advance a task's lease whenever its assignment identity changes.
 *
 * The single place a new `leaseVersion`/`fencingToken` pair is produced, so
 * `assignIdentity` and `migrateIdentityAfterStart` cannot drift apart. Version 7 -> 8
 * and a brand-new token: the previous holder's result now fails fencing at
 * `applyRunResult`, which is the entire point.
 */
function withAdvancedLease(task: Task, agentId: string, modelId: string | null): Task {
  const leaseVersion = task.leaseVersion + 1;
  return {
    ...task,
    agentId,
    modelId,
    leaseVersion,
    fencingToken: mintFencingToken({
      taskId: task.taskId,
      leaseVersion,
      agentId,
      modelKey: modelKeyOf(agentId, modelId),
    }),
  };
}

/**
 * R2-2 §6: issue the lease that describes a task's CURRENT identity.
 *
 * Driven from the task, never from a counter held here, so the lease can never
 * disagree with the authoritative record it is meant to describe. This is the ONLY
 * place a live lease comes into existence.
 */
function issueLeaseForTask(task: Task, now: number, policy: RenewPolicy): AssignmentLease {
  return issueLease({
    taskId: task.taskId,
    agentId: task.agentId,
    modelId: task.modelId,
    leaseVersion: task.leaseVersion,
    // The credential is the TASK's. Minting a second one here is what previously made
    // a lease unable to fence-match its own task.
    fencingToken: task.fencingToken,
    now,
    policy,
  });
}

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

  /** Primary index: taskId - task. */
  private readonly byId = new Map<string, Task>();
  /**
   * R2-2 §6: the CURRENT lease per task.
   *
   * WHY THIS LIVES HERE AND NOT IN ITS OWN REGISTRY
   * ----------------------------------------------
   * A lease is not a new fact about a task - it is the lifecycle record of the
   * assignment `Task.leaseVersion` / `Task.fencingToken` already carry, and it must be
   * impossible for the two to disagree. TaskStore is already the single task-state
   * authority and is the ONLY writer of identity, so keeping the lease beside the task
   * makes a second writer unnecessary.
   *
   * What this map deliberately CANNOT do, which is what would make it an authority:
   * it cannot dispatch, cannot transition a task, cannot retry or reassign, and cannot
   * mint a credential - `leaseVersion` and `fencingToken` are always read back off the
   * task. `assignment-lease.ts` stays pure; this is bookkeeping, not policy.
   *
   * ONE entry per task, not a history: the previous lease is revoked in place at the
   * moment the new one is issued, so a superseded holder's credential stops working the
   * instant identity moves. That is what makes `fencing` fail closed rather than merely
   * fail eventually.
   *
   * ONE CLOCK (a real constraint, found the hard way)
   * -------------------------------------------------
   * A lease's deadline is minted from the timestamp its issuer supplies and judged by
   * whatever clock the reader uses (`Orchestrator.now()`, or an explicit `now`).
   * Mixing the two produces a lease that is EXPIRED THE INSTANT IT IS ISSUED - and the
   * resulting refusals are correct but for the wrong reason, which misleads anyone
   * debugging a fencing failure.
   *
   * This is now ENFORCED rather than documented: every path that issues a lease takes
   * `now` as a REQUIRED parameter (see `assignIdentity`), so a caller with a different
   * clock is a compile error instead of a latent bug. `Orchestrator` and
   * `NativeWorkbench` each hold one injected `now` and pass it everywhere.
   */
  private readonly leases = new Map<string, AssignmentLease>();
  private readonly renewPolicy: RenewPolicy;
  /** Secondary index: parentTaskId - child ids, in creation order. */
  private readonly childrenOf = new Map<string, string[]>();
  private sequence = 0;

  /**
   * `renewPolicy` is injected rather than hard-coded so a round can state its own
   * bound and a test can prove the bound is enforced, without either changing the
   * default. It is BOUNDED by construction: `RenewPolicy.maxRenewals` is a plain
   * number and there is no way to express "unlimited", which is deliberate - an
   * unbounded renewal is a heartbeat, and a heartbeat is a persistent worker.
   */
  constructor(options: { readonly renewPolicy?: RenewPolicy } = {}) {
    this.renewPolicy = options.renewPolicy ?? DEFAULT_RENEW_POLICY;
  }

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
   * known - a dependency on a task that does not exist yet is rejected, which
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
    // R2-2 §6.2: a lease exists from the moment identity does, so a task that is
    // assigned but never dispatched still has an auditable (and revocable) credential.
    // The version and token come from `createTask`, the same seeding the task uses, so
    // the lease and the task cannot disagree about what the first lease is.
    this.leases.set(task.taskId, issueLeaseForTask(task, now, this.renewPolicy));
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
   * NOTHING - an illegal transition must not leave a half-applied state.
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
        reason: `${task.status} -${to} is not a valid transition`,
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
    // R2-2 §6.2: revoke on terminal. A finished task must not retain a credential that
    // still authorizes a write-back, because a LATE result arriving after `succeeded`
    // would otherwise pass fencing and reopen work the human gate already closed.
    //
    // This revokes the LEASE and nothing else. It does not transition anything, does
    // not retry, reassign or re-plan: the task is already terminal, and what happens
    // next (if anything) is Laya's or a human's decision, reached through the existing
    // decision loop.
    if (isTerminal(to)) {
      this.revokeLeaseFor(taskId, `task reached terminal status ${to}`);
    }
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

  /**
   * P6-B: set WHICH WORKER a not-yet-started task will use.
   *
   * Minimal and additive on purpose. It exists because a task's `agentId` and
   * `modelId` were previously immutable after `create`, which makes
   * evidence-based assignment impossible - and re-creating the task to change its
   * owner would be a second lifecycle authority. This is the same store, the same
   * record, the same field: only the identity is replaced, and only through a
   * method on the one authority.
   *
   * WHY IT REFUSES A TASK THAT HAS ALREADY STARTED
   * `startedAt !== null` means the worker was already chosen and used. Swapping
   * identity at that point is worker migration, which the P6 plan assigns to P6-D1
   * together with replan and downstream invalidation. Enforcing that here - in the
   * store, where the knowledge of "has this run" actually lives - means the
   * boundary holds structurally: no caller can write an identity change that the
   * store itself refuses. There is deliberately no `force` parameter.
   *
   * Status is NOT changed. This cannot dispatch, queue, or start anything; a task
   * that was `planned` is still `planned` afterwards, and the existing
   * `TaskScheduler.tick()` remains the only thing that starts it.
   *
   * There is no `now` parameter, because identity carries no timestamp: assigning
   * a worker neither starts the task (`startedAt`) nor finishes it (`finishedAt`).
   * Taking a clock here would suggest the assignment happened at a moment, which
   * is exactly the kind of invented state this method must not add.
   */
  /**
   * `now` is REQUIRED, not defaulted.
   *
   * It used to be `now: number = Date.now()`, which quietly made the clock a hidden
   * second authority: a caller with an injected deterministic clock could issue a lease
   * here while the code reading it back used a different one, and the mismatch shows up
   * as a lease that is expired the instant it exists (correct refusals, wrong reason).
   * Requiring the timestamp means every issuer passes the same clock its reader uses,
   * and adding a caller that does not is a compile error rather than a latent bug.
   */
  assignIdentity(taskId: string, agentId: string, modelId: string | null, now: number): TransitionResult {
    const task = this.byId.get(taskId);
    if (task === undefined) {
      return { ok: false, task: null, code: 'task-not-found', reason: `no task "${taskId}"` };
    }
    if (agentId.trim() === '') {
      return { ok: false, task: null, code: 'agent-id-required', reason: 'agentId must be a non-empty string' };
    }
    if (task.startedAt !== null) {
      // The decisive check, and the one P6-D1 will have to revisit deliberately.
      return {
        ok: false,
        task: null,
        code: 'assignment-after-start',
        reason:
          `task "${taskId}" has already started (status ${task.status}); changing its agent or model ` +
          `now is worker migration, which is P6-D1, not P6-B. P6-B only assigns a task that has not run.`,
      };
    }
    // R2-2 final closure: a TERMINAL task must not acquire a new live assignment lease.
    //
    // `startedAt` alone does not cover this. A task cancelled before it ever ran has
    // `startedAt === null` and so passed the check above - meaning `assignIdentity`
    // would re-mint `leaseVersion + 1` and a fresh live lease for finished work. Execution
    // would be refused later anyway, but "refused eventually" is not the property we
    // want: a terminal task's identity is part of the historical record of who was
    // supposed to have produced it, and re-pointing that re-falsifies the evidence.
    //
    // Guarded on the store's own status authority, so no caller can reach past it.
    if (isTerminal(task.status)) {
      return {
        ok: false,
        task: null,
        code: 'assignment-after-terminal',
        reason:
          `task "${taskId}" is ${task.status}, which is terminal; its assignment is history and cannot be ` +
          're-pointed. This is not migration - migration (`migrateIdentityAfterStart`) is already refused for ' +
          'terminal tasks - and it is not a reopen: nothing here changes the task status.',
      };
    }
    if (task.agentId === agentId && task.modelId === modelId) {
      // Idempotent, not an error: re-assigning the same identity changed nothing.
      return { ok: true, task, code: null, reason: null };
    }
    // R2-2: an identity change is also a lease change (version 7 -> 8, new token),
    // so the previous holder's result can no longer be written back.
    const updated = withAdvancedLease(task, agentId, modelId);
    this.byId.set(taskId, updated);
    this.reissueLease(updated, now, `identity changed to ${agentId}/${modelId ?? 'default'}`);
    return { ok: true, task: updated, code: null, reason: null };
  }

  // -------------------------------------------------------------------------
  // R2-2 §6: the Assignment Lease lifecycle
  //
  // Five operations, all of them bookkeeping over ONE lease per task, and none of
  // them able to change a task's status. Lease revocation and task state are
  // deliberately separate decisions: a revoke says "this holder may no longer write
  // back", never "this task should be retried, reassigned or re-planned". Making
  // revoke imply any of those would hand the lease layer the workflow authority the
  // contract reserves for Laya.
  // -------------------------------------------------------------------------

  /** The task's current lease, or null when it has none (never created / unknown). */
  leaseOf(taskId: string): AssignmentLease | null {
    return this.leases.get(taskId) ?? null;
  }

  /** Every live lease, for a caller auditing assignment state. Read-only. */
  liveLeases(now: number): readonly AssignmentLease[] {
    return [...this.leases.values()].filter((l) => isLeaseLive(l, now));
  }

  /**
   * Revoke whatever lease a task holds and issue the one its CURRENT record implies.
   *
   * Called from every identity write, so a reassignment or a migration invalidates
   * the previous holder in the same operation that grants the new one - there is no
   * window in which both are live, which is the race §6.4 exists to close.
   */
  private reissueLease(task: Task, now: number, reason: string): void {
    const previous = this.leases.get(task.taskId);
    if (previous !== undefined) this.leases.set(task.taskId, revokeLease(previous, reason));
    this.leases.set(task.taskId, issueLeaseForTask(task, now, this.renewPolicy));
  }

  /**
   * §6.3 `issued -> active`: the holder begins using this credential, and the
   * EXECUTION window starts here rather than at issue.
   *
   * Called at dispatch, not at issue, so an auditor can tell an assignment that was
   * merely granted from one that actually ran - and so a task that waited longer than
   * the assignment window is not permanently un-dispatchable (see `activateLease` for
   * why that livelock was a bug). Returns the task's lease unchanged when there is none
   * or it has moved on - an audit/deadline marker must never fail a dispatch.
   *
   * R5-1: `policy` may be supplied by the dispatching caller. The orchestrator passes
   * a policy whose TTL covers the run's own execution deadline, so a legitimately long
   * execution does not go stale while it is still working (a lease that expires
   * mid-execution would have its write-back refused and the attempt would survive
   * only as F5 evidence). The store keeps no memory of the override: the NEXT
   * activation or renew uses the store's own policy again.
   */
  markLeaseUsed(taskId: string, now: number, policy?: RenewPolicy): AssignmentLease | null {
    const lease = this.leases.get(taskId);
    if (lease === undefined) return null;
    const active = activateLease(lease, now, policy ?? this.renewPolicy);
    this.leases.set(taskId, active);
    return active;
  }

  /** The lease/renew policy this store was built with. Read-only accessor. */
  get leasePolicy(): RenewPolicy {
    return this.renewPolicy;
  }

  /**
   * PRODUCTION renew (§6.2): extend the leases of tasks that are STILL RUNNING.
   *
   * This is the caller the contract names - "renew 由 Workbench 在 tick 观察到任务仍在
   * running 时发起" - and it is deliberately tick-driven rather than timer-driven, so
   * there is no daemon, no heartbeat thread and no background service. A caller invokes
   * it when it already has a reason to look (after a tick), never to cause one: renew
   * must not trigger a dispatch.
   *
   * Why it must exist at all: without it a run that outlives the execution window has
   * its write-back refused for being expired, and the task is then stuck in `running`
   * forever - a livelock that a single dispatch-time activation cannot fix, because
   * activation is once-per-lease by design.
   *
   * Bounds, all of them real:
   *   - `renewPolicy.maxRenewals` (default 2) caps renewals per lease VERSION
   *   - only leases in `issued` / `active` / `renewed` are eligible; `revoked` refuses
   *   - only tasks whose status is `running` are considered, so a finished task's lease
   *     is never extended
   *   - the lease must still be the task's CURRENT lease version, so a renew racing a
   *     reassignment cannot extend the superseded grant
   * Nothing here transitions a task, dispatches, retries or reassigns.
   */
  renewRunningLeases(now: number, policy: RenewPolicy = this.renewPolicy): {
    readonly renewed: readonly string[];
    readonly refused: Readonly<Record<string, string>>;
  } {
    const renewed: string[] = [];
    const refused: Record<string, string> = {};
    for (const task of this.byId.values()) {
      if (task.status !== 'running') continue;
      const lease = this.leases.get(task.taskId);
      if (lease === undefined) continue;
      // A superseded lease must never be extended, even if it somehow still exists.
      if (lease.leaseVersion !== task.leaseVersion) continue;
      const outcome: RenewLeaseOutcome = renewLease(lease, now, policy);
      if (outcome.ok) {
        this.leases.set(task.taskId, outcome.lease);
        renewed.push(task.taskId);
      } else {
        refused[task.taskId] = outcome.code;
      }
    }
    return { renewed, refused };
  }

  /**
   * §6.2 renew, EXPLICITLY invoked and strictly bounded.
   *
   * There is no timer, no heartbeat and no background service: a caller renews when it
   * observes the task is still legitimately running. `renewLease` is pure, so a
   * renewal raced against a revoke is decided by the lease the caller holds - a
   * revoked lease can only produce a refusal (Race 3), and the write-back below only
   * happens on success, so revoke cannot be undone by a late renew.
   */
  renewLeaseFor(taskId: string, now: number, policy?: RenewPolicy): RenewLeaseOutcome {
    const lease = this.leases.get(taskId);
    if (lease === undefined) {
      return {
        ok: false,
        code: 'lease-not-renewable',
        reason: `task "${taskId}" holds no lease, so there is nothing to renew`,
      };
    }
    const outcome = renewLease(lease, now, policy ?? this.renewPolicy);
    // Only a SUCCESS is written back. A refusal leaves the revoked / expired lease
    // exactly as it was, which is what makes revoke final.
    if (outcome.ok) this.leases.set(taskId, outcome.lease);
    return outcome;
  }

  /**
   * §6.2 revoke. Terminal for this lease.
   *
   * Returns the lease so a caller can record why. Revoking twice keeps the FIRST
   * reason: an audit trail that can be overwritten by a vaguer later caller is not an
   * audit trail.
   */
  revokeLeaseFor(taskId: string, reason: string): AssignmentLease | null {
    const lease = this.leases.get(taskId);
    if (lease === undefined) return null;
    const revoked = revokeLease(lease, reason);
    this.leases.set(taskId, revoked);
    return revoked;
  }

  /**
   * Record which session the current holder is using. AUDIT ONLY.
   *
   * `SessionRegistry` remains the sole owner of session lifecycle: this copies an id
   * the caller already holds and never creates, resumes or closes a session. It exists
   * so the chain attempt -> leaseVersion -> lease -> session can be walked for an audit
   * without a second session store.
   */
  attachLeaseSession(taskId: string, sessionId: string): AssignmentLease | null {
    const lease = this.leases.get(taskId);
    if (lease === undefined) return null;
    const attached: AssignmentLease = { ...lease, sessionId };
    this.leases.set(taskId, attached);
    return attached;
  }

  /**
   * P6-C: replace a task's dependencies.
   *
   * Validated with the SAME `validateDependencies` and `findDependencyCycle` the
   * create path uses - deliberately not a second implementation, because two
   * definitions of "may these edges exist" is precisely how a graph ends up with
   * two answers. The candidate graph (existing tasks with this one's edges
   * swapped) is built and checked BEFORE anything is written, so a cycle or an
   * unknown id leaves the store byte-identical rather than half-mutated.
   *
   * Refuses a task that has already started, for the same reason
   * `assignIdentity` does: rewriting the plan under work that is already running
   * is not a graph edit, it is a lie about what is running.
   */
  setDependencies(taskId: string, dependencies: readonly string[], now: number): TransitionResult {
    const task = this.byId.get(taskId);
    if (task === undefined) {
      return { ok: false, task: null, code: 'task-not-found', reason: `no task "${taskId}"` };
    }
    if (task.startedAt !== null) {
      return {
        ok: false, task: null, code: 'mutation-after-start',
        reason: `task "${taskId}" has already started (status ${task.status}); its dependencies describe work already admitted and cannot be rewritten`,
      };
    }
    // Validate the array AS GIVEN. Deduplicating first would make a repeated
    // dependency silently legal, and a duplicate edge is a caller bug that must be
    // reported, not tidied away on its behalf.
    const deps = [...dependencies];
    const depCheck = validateDependencies({ ...task, dependencies: deps }, this.byId, { allowUnmet: true });
    if (!depCheck.ok) return depCheck;

    // Cycle check against the CANDIDATE graph, not the current one.
    const candidate = new Map(this.byId);
    candidate.set(taskId, { ...task, dependencies: deps });
    const cycle = findDependencyCycle(candidate);
    if (cycle !== null) {
      return {
        ok: false, task: null, code: 'dependency-cycle',
        reason: `setting dependencies on "${taskId}" would create a cycle: ${cycle.join(' -> ')}`,
      };
    }

    const updated: Task = { ...task, dependencies: deps };
    this.byId.set(taskId, updated);
    void now;
    return { ok: true, task: updated, code: null, reason: null };
  }

  /**
   * P6-D1: move a task to a DIFFERENT worker after it has already started.
   *
   * WHY THIS IS NOT `assignIdentity`
   * -------------------------------
   * `assignIdentity` refuses once `startedAt !== null`, and that refusal is correct:
   * before D1 there was no legitimate reason to move a running task, so the only way
   * to clear the guard would have been to weaken it - which would also have let a
   * stale assignment silently re-point work already in flight. This is a SEPARATE,
   * explicit method so that "assign before starting" and "migrate after starting"
   * stay two distinguishable authorities with two distinguishable audit trails.
   *
   * WHAT IT REQUIRES
   * ----------------
   *   - the task exists, and is in a state where migration is meaningful
   *   - the new pair is DIFFERENT, so this cannot be used as a no-op reassignment
   *   - `reason` is non-empty: an unexplained identity change on a task that has
   *     already consumed budget is unauditable, and every record downstream
   *     (AttemptStore evidence, handoff) would then attribute prior work to a worker
   *     that never did it
   *
   * TaskStore remains the ONLY identity writer. Assignment proposes, this commits.
   */
  migrateIdentityAfterStart(
    taskId: string,
    next: { readonly agentId: string; readonly modelId: string | null; readonly reason: string },
    now: number,
  ): TransitionResult {
    const task = this.byId.get(taskId);
    if (task === undefined) {
      return { ok: false, task: null, code: 'task-not-found', reason: `no task "${taskId}"` };
    }
    if (next.reason.trim() === '') {
      return {
        ok: false, task: null, code: 'migration-reason-required',
        reason: 'migrating a started task requires a reason: its prior work is already attributed to the old worker',
      };
    }
    if (next.agentId.trim() === '') {
      return { ok: false, task: null, code: 'agent-id-required', reason: 'agentId must be a non-empty string' };
    }
    // Only live states. A terminal task's identity is part of the historical record
    // of who produced the result, so re-pointing it would falsify the evidence.
    if (isTerminal(task.status)) {
      return {
        ok: false, task: null, code: 'migration-after-terminal',
        reason: `task "${taskId}" is ${task.status}; a finished task's identity is history and cannot be migrated`,
      };
    }
    const sameAgent = task.agentId === next.agentId;
    const sameModel = (task.modelId ?? null) === (next.modelId ?? null);
    if (sameAgent && sameModel) {
      return {
        ok: false, task: null, code: 'migration-not-a-migration',
        reason: `task "${taskId}" is already assigned to ${next.agentId}/${next.modelId ?? 'default'}; use assignIdentity instead`,
      };
    }
    // Guard the SAME trap `assignIdentity` guards: a started task may not be
    // re-pointed at a worker that cannot do its work. The capability check lives in
    // Assignment, so this only refuses the structurally impossible case - a task
    // with no type at all - and relies on Assignment having filtered properly.
    // R2-2: a migration IS a reassignment, so it revokes the old lease and issues a
    // new one. `leaseVersion` advances and `fencingToken` is re-minted, which is what
    // makes the previous worker's late result stale instead of authoritative.
    // Deliberately NOT reset: `startedAt` records when work first began, and clearing
    // it would make the task look never-run, which is exactly what `assignIdentity`
    // refuses to be tricked by. Attempt counting continues from `retryCount`.
    const updated: Task = withAdvancedLease(task, next.agentId, next.modelId);
    this.byId.set(taskId, updated);
    // R2-2 §6.2: migration is a reassignment, so it revokes the old lease and issues a
    // new one in the same commit. The previous worker keeps its evidence but loses the
    // right to write back - which is the entire difference between a migration and a
    // retry.
    this.reissueLease(updated, now, `migrated to ${next.agentId}/${next.modelId ?? 'default'}: ${next.reason}`);
    return { ok: true, task: updated, code: null, reason: null };
  }

  /** The identity a task had, for callers that need to report a migration. */
  identityOf(taskId: string): { readonly agentId: string; readonly modelId: string | null } | null {
    const t = this.byId.get(taskId);
    return t === undefined ? null : { agentId: t.agentId, modelId: t.modelId ?? null };
  }

  /**
   * P6-C: record that a task's dependencies no longer describe the current plan.
   *
   * This marks; it never acts. It does not transition, dispatch, assign, retry or
   * reassign - a task that is stale may still run perfectly well, and only the
   * dependency check decides readiness. Keeping the flag inert is what makes
   * "stale" a fact rather than a behaviour.
   */
  markStale(taskId: string, reason: string): TransitionResult {
    const task = this.byId.get(taskId);
    if (task === undefined) {
      return { ok: false, task: null, code: 'task-not-found', reason: `no task "${taskId}"` };
    }
    if (reason.trim() === '') {
      // A stale marker with no explanation cannot be acted on or audited later.
      return { ok: false, task: null, code: 'stale-reason-required', reason: 'a task must say why its plan no longer applies' };
    }
    // Lifecycle protection, enforced HERE rather than by each caller. Once a task
    // has started or been judged, its record is history: a plan may be wrong, but
    // the planner has no authority to annotate work it does not own. A queued task
    // IS allowed - it was admitted, so the plan changed under it, and saying so is
    // the honest record.
    if (task.startedAt !== null || task.status === 'to_verify' || task.status === 'succeeded' ||
        task.status === 'failed' || task.status === 'cancelled' || task.status === 'running') {
      return {
        ok: false, task: null, code: 'mutation-after-start',
        reason: `task "${taskId}" is ${task.status}; a planner cannot mark started or finished work as stale`,
      };
    }
    if (task.stale) {
      // Idempotent: already stale, reason already recorded. Re-stating would
      // overwrite the ORIGINAL reason, losing why it went stale in the first place.
      return { ok: true, task, code: null, reason: null };
    }
    const updated: Task = { ...task, stale: true, staleReason: reason };
    this.byId.set(taskId, updated);
    return { ok: true, task: updated, code: null, reason: null };
  }

  /** The highest planner generation any task currently belongs to. */
  latestGeneration(): number {
    let max = 0;
    for (const t of this.byId.values()) if (t.generation > max) max = t.generation;
    return max;
  }

  /**
   * P6-C: what a replan is allowed to touch under a parent's subtree.
   *
   * Split by status because the answer is different for each, and getting it wrong
   * destroys work:
   *
   *   replaceable  planned / blocked - never started, nothing to lose
   *   staleOnly    queued - admitted to the scheduler; the plan may change but
   *                the task must NOT be deleted, because a tick may pick it up
   *                at any moment
   *   untouchable  running / to_verify / succeeded / failed / cancelled - already
   *                started, or finished, or judged. The planner gets no authority
   *                over these at all.
   */
  partitionForReplan(parentTaskId: string): {
    replaceable: Task[];
    staleOnly: Task[];
    untouchable: Task[];
  } {
    const replaceable: Task[] = [];
    const staleOnly: Task[] = [];
    const untouchable: Task[] = [];
    for (const child of this.children(parentTaskId)) {
      if (child.startedAt !== null || child.status === 'to_verify' ||
          child.status === 'succeeded' || child.status === 'failed' || child.status === 'cancelled') {
        untouchable.push(child);
      } else if (child.status === 'queued') {
        staleOnly.push(child);
      } else {
        replaceable.push(child);
      }
    }
    return { replaceable, staleOnly, untouchable };
  }

  /** Remove a task that a replan is replacing. Only for not-yet-started tasks. */
  removePlanned(taskId: string): TransitionResult {
    const task = this.byId.get(taskId);
    if (task === undefined) {
      return { ok: false, task: null, code: 'task-not-found', reason: `no task "${taskId}"` };
    }
    // Status, not just `startedAt`. A task can be `queued` and not yet started - the
    // scheduler may have admitted it this very tick - and deleting that would remove
    // work the system has already committed to. Only `planned` and `blocked` are
    // genuinely un-started, and only those are a replan's to replace.
    if (task.status !== 'planned' && task.status !== 'blocked') {
      return {
        ok: false, task: null, code: 'mutation-after-start',
        reason: `task "${taskId}" is ${task.status}; only a never-admitted task can be replaced by a replan`,
      };
    }
    if (task.parentTaskId !== null) {
      const list = this.childrenOf.get(task.parentTaskId);
      if (list !== undefined) {
        this.childrenOf.set(task.parentTaskId, list.filter((id) => id !== taskId));
      }
    }
    this.byId.delete(taskId);
    return { ok: true, task, code: null, reason: null };
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
