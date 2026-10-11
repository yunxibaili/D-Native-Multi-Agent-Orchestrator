// ===========================================================================
// TeamRun T3-a.1 — READ-only fan-out: typed topology, validation, projection.
// ===========================================================================
//
// WHAT THIS IS
// A pure value module for the `PARALLEL_READ` execution topology: the member specs Laya
// chooses, the fail-closed validation of them, the thin `FanoutProvenance` evidence record,
// and the deterministic ALL-terminal aggregation projection.
//
// WHAT THIS IS NOT
// Not an authority and not a manager. There is no FanoutManager, no scheduler, no store,
// and nothing here selects an Agent, a Model or a Session, dispatches anything, or decides
// which member's finding is true. `new authority = 0`.
//
// WHY CHILD TASKS (and not N executions of one taskId)
// A.0 established that `status: 'running'` is a single exclusive scalar per Task, with one
// lease, one session binding and one live handle per taskId (task.ts/store.ts/
// workbench-sessions.ts/orchestrator.ts). Fanning one taskId into N executions is therefore
// structurally impossible without rewriting the core lifecycle. The container Task executes
// NOTHING; its child Tasks are the Workers. Each child is a distinct taskId and so gets a
// distinct lease, session, attempt and WorkerIdentity for free — that is the whole return on
// choosing child tasks.
//
// WHY THE READ GATE IS HERE AND NOT IN ResourceClaim
// `claimsConflict` deliberately returns false for read+write (resource-claim.ts), resting on
// the documented half-written-read assumption. So ResourceClaim will NOT stop a WRITE member.
// The T3-a.1 contract is "READ only", so the refusal must happen at topology validation,
// BEFORE any task is materialized or any run is admitted — never by hoping a resource
// conflict catches it later.

import type { ResourceClaimMode } from './resource-claim.ts';
import { isTerminal, dependencySatisfied } from './task.ts';

/** The only access mode T3-a.1 admits. WRITE fan-out stays closed (Windows containment). */
export const FANOUT_ACCESS_MODE: ResourceClaimMode = 'read';

/**
 * The task type every READ member is materialized with.
 *
 * `claimModeFor` maps `research` (and `review`) to the `read` resource claim
 * (round-cli.ts), and `mayShareWorkspace('read', ...)` is always true (workspace.ts), so a
 * member needs no worktree and no write isolation. Choosing the type here is what makes the
 * READ access mode REAL in the resource layer rather than a promise in a prompt.
 */
export const FANOUT_MEMBER_TASK_TYPE = 'research' as const;

/** Bounded width. Matches the existing `maxChildren` baseline; not an arbitrary-width redesign. */
export const FANOUT_MAX_MEMBERS = 3;
export const FANOUT_MIN_MEMBERS = 2;

/** One READ Worker Laya asked for. */
export interface FanoutMemberSpec {
  readonly agentId: string;
  readonly modelId: string;
  /** What THIS worker is bounded to investigate. From Laya, never claimed by the agent. */
  readonly scope: string;
  readonly accessMode: ResourceClaimMode;
}

/**
 * The execution topology Laya may choose for one logical Task.
 *
 * SOLO is the existing T2 shape (one exact Agent×Model pair, one executing task) and is the
 * default; it is a member of this union only so callers have one type to branch on.
 */
export type ExecutionTopology =
  | { readonly kind: 'solo'; readonly agentId: string; readonly modelId: string }
  | { readonly kind: 'parallel_read'; readonly members: readonly FanoutMemberSpec[] };

/**
 * Thin grouping evidence for a PARALLEL_READ fan-out.
 *
 * Pure data. It groups the child Tasks under one logical container and carries each member's
 * index/scope so aggregation, observability and the review packet are deterministic. It
 * chooses nothing and is never consulted to admit, dispatch or decide.
 */
export interface FanoutProvenance {
  /** The logical container taskId (the fan-out source). */
  readonly sourceTaskId: string;
  readonly topology: 'parallel_read';
  readonly members: readonly {
    readonly taskId: string;
    readonly memberIndex: number;
    readonly agentId: string;
    readonly modelId: string;
    readonly scope: string;
    readonly accessMode: ResourceClaimMode;
  }[];
}

export type FanoutValidation =
  | { readonly ok: true; readonly members: readonly FanoutMemberSpec[] }
  | { readonly ok: false; readonly code: string; readonly reason: string };

/**
 * Fail-closed validation of the members Laya requested.
 *
 * Every refusal below is a REFUSAL of the whole topology, never a silent downgrade: an
 * invalid PARALLEL_READ must not quietly become SOLO, must not drop a member, and must not
 * turn a WRITE member into a READ one.
 */
export function validateFanoutMembers(
  raw: unknown,
  maxMembers: number = FANOUT_MAX_MEMBERS,
): FanoutValidation {
  if (!Array.isArray(raw)) {
    return { ok: false, code: 'topology-members-not-array', reason: 'PARALLEL_READ members must be an array' };
  }
  if (raw.length < FANOUT_MIN_MEMBERS) {
    return {
      ok: false,
      code: 'topology-too-few-members',
      reason: `PARALLEL_READ needs at least ${FANOUT_MIN_MEMBERS} members, got ${raw.length}`,
    };
  }
  if (raw.length > maxMembers) {
    return {
      ok: false,
      code: 'topology-too-many-members',
      reason: `PARALLEL_READ admits at most ${maxMembers} members (bounded width), got ${raw.length}`,
    };
  }
  const members: FanoutMemberSpec[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const m = raw[i] as Record<string, unknown> | null;
    if (m === null || typeof m !== 'object' || Array.isArray(m)) {
      return { ok: false, code: 'topology-member-malformed', reason: `member ${i} is not an object` };
    }
    const agentId = m.agentId;
    const modelId = m.modelId;
    const scope = m.scope;
    const accessMode = m.accessMode;
    if (typeof agentId !== 'string' || agentId.trim() === '' || typeof modelId !== 'string' || modelId.trim() === '') {
      return {
        ok: false,
        code: 'topology-member-partial-pair',
        reason: `member ${i} must name BOTH an agentId and a modelId; a fan-out pair is atomic`,
      };
    }
    if (typeof scope !== 'string' || scope.trim() === '') {
      return {
        ok: false,
        code: 'topology-member-missing-scope',
        reason: `member ${i} must carry a bounded scope; workers must not all receive one unbounded task`,
      };
    }
    // The READ gate. Absent accessMode defaults to READ (the contract IS read). Anything
    // else — including a WRITE member in an otherwise READ fan-out — refuses the WHOLE
    // topology, because ResourceClaim would happily let read+write share.
    const mode = accessMode === undefined ? FANOUT_ACCESS_MODE : accessMode;
    if (mode !== FANOUT_ACCESS_MODE) {
      return {
        ok: false,
        code: 'topology-write-member-refused',
        reason: `member ${i} requested access "${String(mode)}"; T3-a.1 admits READ only (parallel WRITE is closed pending containment)`,
      };
    }
    const key = `${agentId}\u0000${modelId}\u0000${scope}`;
    if (seen.has(key)) {
      return { ok: false, code: 'topology-duplicate-member', reason: `member ${i} duplicates an earlier member` };
    }
    seen.add(key);
    members.push({ agentId, modelId, scope: scope.trim(), accessMode: FANOUT_ACCESS_MODE });
  }
  return { ok: true, members };
}

/**
 * Deterministic ALL-terminal state of a fan-out group.
 *
 * T3-a.1 completion is deliberately the simplest verifiable one: every REQUESTED member
 * reaches a terminal (or pre-execution refusal) state. No QUORUM, no FIRST_SUCCESS, no
 * COMPETE — those are later stages.
 *
 * This is a PROJECTION over already-recorded facts. It never reorders by completion time or
 * promise-resolution order, so a concurrent dispatch produces a stable review packet.
 */
/** The identity Laya REQUESTED for a member (never the Planner seed, never the actual). */
export interface FanoutRequestedIdentity {
  readonly agentId: string;
  readonly modelId: string;
  readonly scope: string;
  readonly accessMode: ResourceClaimMode;
}

/** The identity a member ACTUALLY executed with. Present ONLY when it executed. */
export interface FanoutActualIdentity {
  readonly agentId: string;
  readonly modelId: string | null;
  readonly sessionId: string | null;
  readonly attemptId: string;
}

/** The overall execution outcome of one member, from CURRENT-round evidence only. */
export type FanoutExecutionOutcome =
  | 'started'            // a current Attempt exists; actual identity is that attempt's bundle
  | 'assignment-refused' // Assignment refused the pair before dispatch
  | 'dispatch-refused'   // Assignment accepted, but the execution gate refused before runtime
  | 'pending';           // accepted, no refusal, not dispatched (e.g. capacity)

/**
 * The facts the projection is given for ONE member, all from CURRENT-round authorities:
 * Assignment outcomes, the dispatch receipts, and AttemptStore. Never a historical lookup.
 */
export interface FanoutMemberFacts {
  readonly taskStatus: string;
  readonly execution: FanoutExecutionOutcome;
  /** Assignment's verdict for this member's pair. */
  readonly assignment: 'accepted' | 'refused';
  readonly assignmentRefusalReason?: string | null;
  readonly dispatchRefusalCode?: string | null;
  /** The ATOMIC current-execution identity, present only when `execution === 'started'`. */
  readonly actual?: FanoutActualIdentity | null;
}

/**
 * One member's projected truth. Three identities, strictly separated:
 *   requested  what Laya asked for
 *   assignment what Assignment decided
 *   actual     what actually ran (null unless a CURRENT attempt exists)
 * And three settlement concepts, strictly separated:
 *   executionSettled     the fan-out no longer waits on this member
 *   taskTerminal         the TaskStore reached a STRICT terminal
 *   dependencySatisfied  a downstream dependant may proceed (canonical: status === 'succeeded')
 */
export interface FanoutMemberState {
  readonly taskId: string;
  readonly memberIndex: number;
  readonly requested: FanoutRequestedIdentity;
  readonly assignment: { readonly status: 'accepted' | 'refused'; readonly reason: string | null };
  readonly outcome: FanoutExecutionOutcome;
  readonly dispatchRefusalCode: string | null;
  readonly executed: boolean;
  readonly actual: FanoutActualIdentity | null;
  readonly taskStatus: string;
  readonly executionSettled: boolean;
  readonly taskTerminal: boolean;
  readonly dependencySatisfied: boolean;
}

export interface FanoutAggregation {
  readonly sourceTaskId: string;
  readonly topology: 'parallel_read';
  /** Deterministically ordered by memberIndex, NEVER by completion order. */
  readonly members: readonly FanoutMemberState[];
  readonly requested: number;
  readonly settledCount: number;
  readonly allSettled: boolean;
  readonly executedCount: number;
  readonly refusedCount: number;
  readonly pendingCount: number;
  readonly terminalCount: number;
  readonly allTerminal: boolean;
  readonly nonSucceeding: readonly string[];
}

/**
 * A member whose EXECUTION has reached a decision settles. A pre-runtime refusal (assignment
 * OR dispatch) settles — nothing more will happen without a new decision — and any finished
 * run settles. A member merely waiting for capacity does NOT: counting it settled would make
 * a width-3 fan-out look complete when only one member had run.
 */
function executionSettledFrom(outcome: FanoutExecutionOutcome): boolean {
  return outcome !== 'pending';
}

/**
 * Project the fan-out group's state. Pure: a function of the provenance (requested identity)
 * plus the caller's CURRENT-round fact reader. Ordering is by `memberIndex`, so it is
 * identical regardless of the order children happened to finish.
 */
export function projectFanoutAggregation(
  provenance: FanoutProvenance,
  factsOf: (taskId: string) => FanoutMemberFacts,
): FanoutAggregation {
  const members: FanoutMemberState[] = provenance.members
    .slice()
    .sort((a, b) => a.memberIndex - b.memberIndex)
    .map((m) => {
      const facts = factsOf(m.taskId);
      const assignmentRefused = facts.assignment === 'refused' || facts.execution === 'assignment-refused';
      // Fail closed: `started` WITHOUT an atomic identity is not an execution.
      const executed = facts.execution === 'started' && facts.actual != null;
      return {
        taskId: m.taskId,
        memberIndex: m.memberIndex,
        requested: { agentId: m.agentId, modelId: m.modelId, scope: m.scope, accessMode: m.accessMode },
        assignment: {
          status: assignmentRefused ? 'refused' : 'accepted',
          reason: assignmentRefused
            ? (facts.assignmentRefusalReason ?? null)
            : (facts.execution === 'dispatch-refused' ? (facts.dispatchRefusalCode ?? null) : null),
        },
        outcome: facts.execution,
        dispatchRefusalCode: facts.dispatchRefusalCode ?? null,
        executed,
        actual: executed ? facts.actual! : null,
        taskStatus: facts.taskStatus,
        executionSettled: executionSettledFrom(facts.execution),
        taskTerminal: isTerminal(facts.taskStatus as never),
        // Canonical scheduler semantics, shared with `unmetDependencies`.
        dependencySatisfied: dependencySatisfied(facts.taskStatus as never),
      };
    });
  const settledCount = members.filter((m) => m.executionSettled).length;
  const terminalCount = members.filter((m) => m.taskTerminal).length;
  const executedCount = members.filter((m) => m.executed).length;
  const refusedCount = members.filter((m) => m.outcome === 'assignment-refused' || m.outcome === 'dispatch-refused').length;
  const pendingCount = members.filter((m) => m.outcome === 'pending').length;
  const nonSucceeding = members
    .filter((m) => (m.taskStatus !== 'to_verify' && m.taskStatus !== 'succeeded'))
    .map((m) => m.taskId);
  return {
    sourceTaskId: provenance.sourceTaskId,
    topology: 'parallel_read',
    members,
    requested: members.length,
    settledCount,
    allSettled: members.length > 0 && settledCount === members.length,
    executedCount,
    refusedCount,
    pendingCount,
    terminalCount,
    allTerminal: members.length > 0 && terminalCount === members.length,
    nonSucceeding,
  };
}
