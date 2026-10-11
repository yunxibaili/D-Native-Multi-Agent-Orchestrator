/**
 * src/orchestration/assignment-lease.ts - R2-2, §6 of
 * `docs/R2_COORDINATION_CONTRACT.md`.
 *
 * A lease is the EXISTING Assignment's lifecycle record: who is allowed to produce a
 * result for this task, and under which version of that right. It is not a new
 * authority - there is no `LeaseManager`, no `LeaseScheduler`, no `LeaseAuthority`,
 * and nothing here dispatches, retries, or re-plans.
 *
 * WHY IT EXISTS
 * -------------
 * `applyRunResult` already refuses a result whose `agentId` differs from the task's
 * (`agent-mismatch`). That catches the coarse case: a result from a DIFFERENT agent.
 * It does not catch the fine one - the SAME agent, under an OLD assignment, writing
 * back after a re-assign, a migration, or a retry round. `leaseVersion` and
 * `fencingToken` close that gap: every change of assignment advances the version and
 * mints a new token, so the previous holder's result is provably stale.
 *
 * SINGLE SOURCE OF TRUTH
 * ----------------------
 * §12.2 of the Decision Loop contract is explicit: the authoritative value is the
 * TaskStore's CURRENT record, never a value the caller claims. So the authoritative
 * `leaseVersion` / `fencingToken` live on the `Task` (written by Assignment, which is
 * the identity authority). The `AssignmentLease` object here is Assignment's own
 * bookkeeping of that same fact - it must never disagree with the task, which is why
 * `issueLease` is always driven FROM the task.
 *
 * SESSIONS STAY WITH SessionRegistry
 * ----------------------------------
 * A lease RECORDS a `sessionId` so an auditor can see which conversation the holder
 * was using. It never creates, resumes or kills a session: that is SessionRegistry's
 * authority and stays there.
 *
 * BOUNDED, NOT A HEARTBEAT
 * ------------------------
 * `expiresAt` is a finite deadline for the current Execution Round. Renewal is
 * explicitly bounded (`maxRenewals`). There is no heartbeat, no persistent worker and
 * no always-on agent here, and the constructor refuses an unbounded policy.
 */

import { createHash, randomUUID } from 'node:crypto';
import { modelKey } from '../quota/registry.ts';

export type AssignmentLeaseStatus = 'issued' | 'active' | 'renewed' | 'revoked' | 'expired';

export interface AssignmentLease {
  readonly leaseId: string;
  readonly taskId: string;
  readonly agentId: string;
  /** The (agent, model) pair this lease authorises. */
  readonly modelKey: string;
  /**
   * Recorded for audit only. Sessions are owned by `SessionRegistry`; a lease never
   * creates, resumes or kills one.
   */
  readonly sessionId: string | null;
  readonly issuedAt: number;
  readonly expiresAt: number;
  /**
   * Monotonic per task. Every identity change advances it, so a result produced under
   * an earlier assignment can be recognised as stale.
   */
  readonly leaseVersion: number;
  /** The execution credential. Opaque; compared for equality, never parsed. */
  readonly fencingToken: string;
  readonly status: AssignmentLeaseStatus;
  readonly renewals: number;
  /** Why it was revoked, when it was. Audit only. */
  readonly revokedReason?: string;
}

export interface RenewPolicy {
  /**
   * How many times one lease may be renewed inside the same Execution Round.
   *
   * Bounded ON PURPOSE. An unbounded renewal is a heartbeat, and a heartbeat is a
   * persistent worker - neither belongs to a bounded round.
   */
  readonly maxRenewals: number;
  /** How long each renewal extends the deadline by. */
  readonly ttlMs: number;
}

export const DEFAULT_RENEW_POLICY: RenewPolicy = { maxRenewals: 2, ttlMs: 15 * 60_000 };

/**
 * A fencing token.
 *
 * NOT a security primitive and not claimed to be one - nothing here depends on it
 * being unguessable. It exists so a worker from a superseded assignment cannot be
 * mistaken for the current holder. Binding the version and the identity into the
 * digest means two leases for the same task can never collide, and a token cannot be
 * carried from one assignment to another.
 *
 * The fields are joined with NUL (`\u0000`) rather than a space or a comma, so no
 * combination of task ids, versions and model keys can be re-partitioned into a
 * different set of fields - `("a", "b c")` and `("a b", "c")` hash identically
 * without a separator. This is a source-level ESCAPE, not a raw byte in the file.
 */
export function mintFencingToken(input: {
  taskId: string;
  leaseVersion: number;
  agentId: string;
  modelKey: string;
  nonce?: string;
}): string {
  const nonce = input.nonce ?? randomUUID();
  const digest = createHash('sha256')
    .update(`${input.taskId}\u0000${input.leaseVersion}\u0000${input.agentId}\u0000${input.modelKey}\u0000${nonce}`)
    .digest('hex')
    .slice(0, 32);
  return `fence-${input.leaseVersion}-${digest}`;
}

/**
 * The (agent, model) identity a lease authorises.
 *
 * §6.1 says this is the sealed registry's `modelKey`, so it DELEGATES rather than
 * inventing a second spelling. The previous local format (`agentId/modelId`) meant
 * the same (agent, model) pair produced two different keys depending on which module
 * asked - so a lease and a registry entry could describe one identity and still fail
 * to match. `null` has no registry spelling (the registry's `modelKey` takes a
 * string), so it is spelled explicitly rather than coerced into a fake model id.
 */
export function modelKeyOf(agentId: string, modelId: string | null): string {
  return modelId === null ? `${agentId}::default` : modelKey(agentId, modelId);
}

export interface IssueLeaseInput {
  readonly taskId: string;
  readonly agentId: string;
  readonly modelId: string | null;
  readonly leaseVersion: number;
  /**
   * The credential, TAKEN FROM THE TASK - never minted here.
   *
   * This is the single-source-of-truth rule the module docstring claims, and it used
   * to be broken: `issueLease` called `mintFencingToken` itself, so a lease carried a
   * *different* token from the one on the Task it described. A lease could therefore
   * never fence-match its own task, and any check comparing the two would reject
   * every legitimate write-back. `Assignment` mints the credential once, on the task
   * record; the lease only describes it.
   */
  readonly fencingToken: string;
  readonly sessionId?: string | null;
  readonly now: number;
  readonly ttlMs?: number;
  readonly policy?: RenewPolicy;
}

/**
 * Mint a lease FROM the task's current record.
 *
 * Taking the version AND the token from the task (rather than incrementing a private
 * counter and minting a fresh credential here) is what keeps one source of truth:
 * Assignment advances the task's version and mints its token, and this only describes
 * the result.
 */
export function issueLease(input: IssueLeaseInput): AssignmentLease {
  const policy = input.policy ?? DEFAULT_RENEW_POLICY;
  const modelKeyValue = modelKeyOf(input.agentId, input.modelId);
  return {
    leaseId: `lease:${input.taskId}:${input.leaseVersion}`,
    taskId: input.taskId,
    agentId: input.agentId,
    modelKey: modelKeyValue,
    sessionId: input.sessionId ?? null,
    issuedAt: input.now,
    expiresAt: input.now + (input.ttlMs ?? policy.ttlMs),
    leaseVersion: input.leaseVersion,
    fencingToken: input.fencingToken,
    status: 'issued',
    renewals: 0,
  };
}

/**
 * §6.3 `issued -> active`, AND the point at which the deadline starts to mean something.
 *
 * WHY THE DEADLINE IS RE-ANCHORED HERE
 * ------------------------------------
 * `expiresAt` is minted at ISSUE time, which is assignment time - and assignment can
 * happen arbitrarily long before dispatch. With a fixed TTL that produced a livelock
 * that no amount of renewing could fix:
 *
 *     assigned -> queued -> ... waits 20 min ... -> dispatch
 *       -> lease (TTL 15 min) is ALREADY expired
 *       -> a live lease cannot be renewed (and must not be: §6.3 says expired is stale)
 *       -> admission refuses with lease-not-live, forever
 *
 * The deeper reason that is a BUG and not merely inconvenient: before the first
 * execution starts under a lease there is nothing for a deadline to protect. Fencing
 * exists so a SUPERSEDED execution cannot write back, and no execution is in flight yet.
 * So the deadline that matters is the one bounding the EXECUTION window, and it is
 * anchored when the holder actually begins work.
 *
 * This is NOT a heartbeat and NOT unbounded re-arming:
 *   - it only ever applies to a lease in `issued` state, so it can happen AT MOST ONCE
 *     per lease version. A reassignment issues a new version, which activates once.
 *   - a revoked lease is never activated, so revocation still wins outright.
 *   - there is no timer and no background thread: `Orchestrator.executeTask` calls it
 *     synchronously at the moment it is about to run.
 *
 * A run that then outlives the execution window is bounded by the RENEWAL budget, which
 * is the mechanism §6.2 actually describes ("防止一个仍在正常运行的短任务因超过
 * expiresAt 被误判失效").
 */
export function activateLease(lease: AssignmentLease, now: number, policy: RenewPolicy = DEFAULT_RENEW_POLICY): AssignmentLease {
  // Once-per-lease, and never over a revocation or a renewal.
  if (lease.status !== 'issued') return lease;
  return { ...lease, status: 'active', expiresAt: now + policy.ttlMs };
}

/**
 * The ONE lifecycle-aware write-back validation primitive.
 *
 * P1-2: `checkFencing` deliberately knows only about identity, version and token, so a
 * REVOKED lease whose version and token still match it returns `accepted: true`. That
 * was papered over by a hand-written `lease-revoked` gate in `applyRunResult` - which
 * meant `stillHoldsLease()` (the guard on the two failure-mutation branches) silently
 * had different semantics, and a `runtime.run()` throw after expiry could still write
 * `failed`.
 *
 * Both call sites now use THIS, so there is exactly one definition of "may this write
 * back". It is pure, has no store, and composes the two checks in the only defensible
 * order: lifecycle first (a dead credential is dead whatever it matches), then fencing.
 *
 * It applies to EXECUTION write-back only. `applyVerification` is a different authority
 * with a different question and deliberately does not go through here.
 */
export type WritebackVerdict =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly code: FencingRejectCode | 'lease-revoked' | 'lease-expired'; readonly reason: string };

/** The authoritative facts a write-back is judged against. */
export interface WritebackAuthority {
  /** `null` when the task holds no lease at all. */
  readonly lease: AssignmentLease | null;
  readonly agentId: string;
  readonly modelId: string | null;
  readonly leaseVersion: number | undefined;
  readonly fencingToken: string | undefined;
  /**
   * The agent that actually produced the result (`RunResult.agentId`), when known.
   *
   * This is a DIFFERENT question from ownership, and it is not redundant with it:
   *   - ownership:      is the presenter the task's CURRENT holder?  (presented vs task)
   *   - evidence:       did the DISPATCHED agent produce this run?  (presented vs result)
   * A result whose agent differs from the one it was dispatched under was not produced
   * by the worker the task was handed to, and no amount of lease correctness makes it
   * this task's execution. After a reassignment the two answers legitimately differ -
   * `result.agentId` is a historical fact about who ran, while `task.agentId` is who
   * holds the task now - which is precisely why comparing the result with itself, or
   * folding the two checks into one, would be wrong.
   */
  readonly producedBy?: string;
}

export function validateWriteback(
  current: WritebackAuthority,
  presented: PresentedLease | undefined,
  now: number,
): WritebackVerdict {
  // 1. Lifecycle, before anything that a dead credential could still "match".
  if (current.lease !== null) {
    if (current.lease.status === 'revoked') {
      return {
        accepted: false,
        code: 'lease-revoked',
        reason: `the assignment lease was revoked (${current.lease.revokedReason ?? 'no reason recorded'}), so this ` +
          'late result may no longer be written back. The execution is kept as evidence; the task is not reopened.',
      };
    }
    if (!isLeaseLive(current.lease, now)) {
      return {
        accepted: false,
        code: 'lease-expired',
        reason: `the assignment lease expired at ${current.lease.expiresAt} (now ${now}), so this result may no ` +
          'longer be written back. The execution is kept as evidence; the task is not reopened.',
      };
    }
  }
  // 2. Identity / version / token.
  const fenced = checkFencing(
    {
      agentId: current.agentId,
      modelId: current.modelId,
      leaseVersion: current.leaseVersion,
      fencingToken: current.fencingToken,
    },
    presented,
  );
  if (fenced.accepted === false) return fenced;
  // 3. Evidence integrity: the dispatched agent must be the one that produced this.
  if (presented !== undefined && current.producedBy !== undefined && presented.agentId !== current.producedBy) {
    return {
      accepted: false,
      code: 'agent-mismatch',
      reason: `result came from agent "${current.producedBy}" but was dispatched under "${presented.agentId}"`,
    };
  }
  return { accepted: true };
}

/**
 * The lease version a `ResourceClaim` may be bound to (§7.1 / §7.3).

/**
 * Named for what it is, because it now crosses a module boundary: at a bare
 * `import { type RenewOutcome }` in the store there is no way to tell it apart from
 * any other outcome in the system.
 */
export type RenewLeaseOutcome =
  | { readonly ok: true; readonly lease: AssignmentLease }
  | { readonly ok: false; readonly code: 'lease-not-renewable' | 'lease-expired' | 'renewal-budget-exhausted'; readonly reason: string };

/**
 * Extend a lease, within the round's bounded budget.
 *
 * Refuses rather than silently extending forever: an exhausted budget is a decision
 * the caller must take explicitly, not something this layer invents.
 *
 * REVOKE BEATS RENEW (Race 3). `revoked` is checked FIRST and `renewLease` is a pure
 * function of the lease it is handed, so a renewal computed from a pre-revoke lease
 * can never overwrite a post-revoke one: the caller holding the revoked lease gets a
 * refusal, not a resurrection. Combined with the caller's obligation to write back
 * only the lease it still holds, that makes revoke the final word without any lock.
 */
export function renewLease(lease: AssignmentLease, now: number, policy: RenewPolicy = DEFAULT_RENEW_POLICY): RenewLeaseOutcome {
  if (lease.status === 'revoked') {
    return { ok: false, code: 'lease-not-renewable', reason: `lease ${lease.leaseId} was revoked and can never be renewed` };
  }
  // An expired lease is already dead; the budget check would otherwise let a caller
  // "renew" one whose deadline had passed, which reads as keeping a right alive.
  if (lease.status === 'expired' || lease.expiresAt <= now) {
    return { ok: false, code: 'lease-expired', reason: `lease ${lease.leaseId} expired at ${lease.expiresAt} (now ${now})` };
  }
  if (lease.renewals >= policy.maxRenewals) {
    return {
      ok: false,
      code: 'renewal-budget-exhausted',
      reason: `lease ${lease.leaseId} has used all ${policy.maxRenewals} renewal(s) allowed inside one Execution Round; ` +
        'renewing further would make this a persistent worker rather than a bounded round',
    };
  }
  return {
    ok: true,
    lease: {
      ...lease,
      // A renewal keeps the SAME leaseVersion and the SAME fencingToken: it extends the
      // deadline of the existing right, it is not a new grant of authority. Minting a
      // new token here would invalidate the in-flight run's own write-back.
      status: 'renewed',
      renewals: lease.renewals + 1,
      // R5-1.1 (§7): renewal is MONOTONIC — it extends the right, never shortens
      // it. The dispatch lease may already carry a TTL sized to the execution's own
      // deadline (see `Orchestrator.dispatchLeasePolicy`); a store-default renewal
      // computed as `now + 15min` used to pull the expiry BACK under a long running
      // execution. The max keeps every legitimate path (long execution, refused
      // overlapping tick, normal renewal) from reducing existing protection.
      expiresAt: Math.max(lease.expiresAt, now + policy.ttlMs),
    },
  };
}

/**
 * §6.3 revoke. Idempotent, and the FIRST reason is the one kept.
 *
 * Re-revoking must not overwrite the audit trail with a later, vaguer reason, and it
 * must not un-revoke: revoke is terminal for a lease.
 */
export function revokeLease(lease: AssignmentLease, reason: string): AssignmentLease {
  if (lease.status === 'revoked') return lease;
  // The reason is KEPT, not dropped: `revoked` is an auditable event, and a reader
  // must be able to see WHY the previous holder lost the right to write back.
  return { ...lease, status: 'revoked', revokedReason: reason };
}

/**
 * Whether a lease still confers the right to write back, at `now`.
 *
 * §6.3: expiry is not revocation but it is equally final for the CURRENT round - an
 * expired lease cannot be dispatched, cannot be renewed, and cannot write back. It
 * may only be disposed of by an explicit Laya retry / reassign decision.
 */
export function isLeaseLive(lease: AssignmentLease, now: number): boolean {
  return lease.status !== 'revoked' && lease.expiresAt > now;
}

// ---------------------------------------------------------------------------
// Fencing - the check, pure
// ---------------------------------------------------------------------------

/** What the holder presents when writing a result back. */
export interface PresentedLease {
  /**
   * The agent the dispatch was actually issued under.
   *
   * Checked against the task BEFORE the lease check, so a result that was launched
   * for one agent and came back from another is caught as ownership, not as a
   * confusing lease mismatch.
   */
  readonly agentId: string;
  readonly leaseVersion: number;
  readonly fencingToken: string;
}

/** What the AUTHORITATIVE record says is current. */
export interface CurrentLease {
  readonly agentId: string;
  readonly modelId: string | null;
  readonly leaseVersion: number | undefined;
  readonly fencingToken: string | undefined;
}

export type FencingVerdict =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly code: FencingRejectCode; readonly reason: string };

export const FENCING_REJECT_CODES = [
  'agent-mismatch',
  'fencing-token-missing',
  'fencing-token-mismatch',
  'stale-lease-version',
] as const;
export type FencingRejectCode = (typeof FENCING_REJECT_CODES)[number];

/**
 * §12: the check runs BEFORE any state change, against the authoritative record.
 *
 * Order is deliberate and each step is separately attributable:
 *   1. the record names no agent at all -> nothing could have been legitimately held
 *   2. the record has no lease -> nothing can be fenced, so nothing is accepted
 *   3. the caller presented nothing -> reject; a missing token is not a fresh token
 *   4. the presented VERSION differs from the record's -> stale
 *   5. the presented agent is not the task's current agent -> not the holder
 *   6. the token does not match -> not the current holder of that version
 *
 * WHY VERSION BEFORE AGENT (this ordering is load-bearing)
 * ------------------------------------------------------
 * A reassignment changes the agent AND advances the version together, so checking the
 * agent first reported every superseded result as `agent-mismatch` and hid the fact that
 * the caller is simply BEHIND. `stale-lease-version` is the more useful diagnosis: it
 * tells the holder "your grant ended, this work is superseded" instead of the much
 * stronger and usually wrong-sounding "you are not the owner of this task". An
 * `agent-mismatch` at the SAME version is the genuinely surprising case - one version,
 * two agents - and is exactly the one worth flagging loudly, which is why it survives
 * as its own step rather than being folded into staleness.
 *
 * A presented version NEWER than the record is refused by the same step: that would mean
 * the caller asserts authority the authoritative record does not know about.
 *
 * WHO COMPARES AGENT TO WHAT (O-1, corrected)
 * -------------------------------------------
 * Step 5 compares the PRESENTED agent against the AUTHORITATIVE agent on the task.
 * That is this function's only agent check, and it is deliberately NOT a comparison of
 * two values the RESULT carries: `result.agentId` is the agent that actually ran,
 * which is an execution FACT and may legitimately differ from the task's current
 * holder after a reassignment - that is exactly the F5 case, and it must be preserved
 * as evidence rather than rejected here. Comparing a result to itself would be
 * vacuous, which is what an earlier version of this comment claimed.
 *
 * `Orchestrator.applyRunResult` therefore performs BOTH comparisons, and they mean
 * different things:
 *   - `presented.agentId` vs `task.agentId`  -> ownership (here)
 *   - `result.agentId`    vs `presented.agentId` -> did the dispatched agent produce
 *     this, i.e. evidence integrity. Both report `agent-mismatch`, with the reason
 *     text naming which comparison failed.
 */
export function checkFencing(
  current: CurrentLease,
  presented: PresentedLease | undefined,
): FencingVerdict {
  // 1. An unassigned task cannot have a legitimate holder.
  if (current.agentId === '') {
    return { accepted: false, code: 'agent-mismatch', reason: 'the task has no assigned agent, so no result can be attributed to a holder' };
  }
  if (current.leaseVersion === undefined || current.fencingToken === undefined) {
    return {
      accepted: false,
      code: 'fencing-token-missing',
      reason:
        `task "${current.agentId}" has no recorded lease, so this result cannot be shown to come from the ` +
        'current assignment. Refused rather than assumed fresh.',
    };
  }
  // 3. A missing token is not a valid token.
  if (presented === undefined) {
    return {
      accepted: false,
      code: 'fencing-token-missing',
      reason:
        'the result carried no fencing token. Only a result produced under the current assignment lease may ' +
        'be written back, and "no token" cannot be shown to be one.',
    };
  }
  // 4. Version first: a caller that is behind is told it is behind, whatever else changed.
  if (presented.leaseVersion !== current.leaseVersion) {
    return {
      accepted: false,
      code: 'stale-lease-version',
      reason:
        `result carries leaseVersion ${presented.leaseVersion} but the task is now at ${current.leaseVersion}. ` +
        'The assignment moved on, so this result describes superseded work.',
    };
  }
  // 5. Same version, different agent: one version with two holders is a real anomaly.
  if (presented.agentId !== current.agentId) {
    return {
      accepted: false,
      code: 'agent-mismatch',
      reason:
        `the result was dispatched under agent "${presented.agentId}" but the task is now assigned to ` +
        `"${current.agentId}" at the same lease version ${current.leaseVersion}, so the presenter is not the ` +
        'current holder.',
    };
  }
  // 6. Right version and right agent, but not the credential: an impostor at this version.
  if (presented.fencingToken !== current.fencingToken) {
    return {
      accepted: false,
      code: 'fencing-token-mismatch',
      reason:
        `leaseVersion ${presented.leaseVersion} matches but the fencing token does not, so this is not the ` +
        'current holder of that version.',
    };
  }
  return { accepted: true };
}

/**
 * §7.1 / §7.3: the lease version a claim may be bound to.
 *
 * `null` whenever the lease is not live - revoked OR expired - and that is the whole
 * point. A claim bound to a dead lease confers no write eligibility, so §7.3's
 * "lease revoked/expired => claim automatically void" is enforced by the BINDING being
 * unmakeable rather than by a sweep that could be forgotten.
 *
 * The CALLER passes the result of this, never the raw `lease.leaseVersion`. That is the
 * whole P1-3 fix in one line: `revokeLease` deliberately keeps the version and the token
 * (they are evidence of what was granted), so comparing versions alone cannot tell a
 * live lease from a revoked one with the same version.
 */
export function claimLeaseVersionOf(lease: AssignmentLease | null, now: number): number | null {
  if (lease === null) return null;
  return isLeaseLive(lease, now) ? lease.leaseVersion : null;
}
