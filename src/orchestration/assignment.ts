/**
 * src/orchestration/assignment.ts — P6-B: choose WHICH WORKER, never WHAT.
 *
 * THE JOB, IN ONE SENTENCE
 * ------------------------
 * Given a task that is already decided to run, choose the canonical
 * `(agentId, modelId)` pair to run it with — and write back only that identity.
 *
 * THE FIVE THINGS THIS IS NOT
 * --------------------------
 *   not a planner      it does not decide whether a task exists or what it depends on
 *   not a reasoner     it never asks Laya; it is a pure function of a snapshot
 *   not a reviewer     it cannot verify anything
 *   not a veto         see "assignment proposes, gate disposes" below
 *   not a reassigner   it cannot touch a task that has already run (see §10)
 *
 * Laya stays the task-level decision brain. This is strictly the worker/model
 * question underneath it, and the two are not connected here on purpose.
 *
 * HARD FILTERS FIRST, SCORE SECOND
 * --------------------------------
 *   capability     the model entry does not offer the task's type
 *   availability   the entry is not `available`
 *   policy/quota   the entry is policy-disabled or quota-blocked or the agent's
 *                  real quota reads exhausted
 *   free pool      P6-F's `isAllowedModel`, when the caller has opted in
 *
 * Only what survives all four is scored. Scoring an incapable candidate is the
 * classic way a routing system goes wrong: a model that cannot do the work wins
 * because it is fast, and the failure surfaces much later as a bad run rather
 * than as an assignment error. Filters are cheaper, and they fail closed.
 *
 * "assignment proposes, gate disposes"
 * ----------------------------------
 * This engine may exclude a candidate EARLY — a model already known to be
 * unavailable or off-pool should not be proposed at all. It may never INCLUDE one
 * that the gate would refuse: `buildSpawnGateInput` still runs at spawn and again
 * at execute, and it remains the authority. Duplicating a gate rule here would
 * create two answers to "is this runnable", and the one that runs first would
 * quietly become the real one. This engine therefore reuses `resolveQuotaStatus`
 * (P6-A's gate resolver) rather than restating quota rules.
 *
 * DETERMINISM IS A REQUIREMENT, NOT A TASTE
 * ------------------------------------------
 * No `random()`, no `Date.now()`, no promise completion order, no Map insertion
 * order. The same snapshot yields the same assignment, byte for byte — which is
 * what makes the result auditable after the fact and testable at all. Ties break
 * on canonical `(agentId, modelId)` ascending, the same ordering `ModelRegistry`
 * already uses.
 */

import { modelKey } from '../quota/registry.ts';
import type { ModelRegistry } from '../quota/registry.ts';
import type { ModelEntry, PolicyState, QuotaRecord, TaskType } from '../quota/types.ts';
import { resolveQuotaStatus } from './spawn-gate-input.ts';
import { evaluateSpawnGate } from '../quota/spawn-gate.ts';
import { isAllowedModel } from './model-pool.ts';
import type { AttemptStore } from './attempt-store.ts';
import type { AttemptRecord } from './attempt-record.ts';

// ---------------------------------------------------------------------------
// Failure vocabulary — every refusal names itself
// ---------------------------------------------------------------------------

export const ASSIGNMENT_FAILURE_CODES = [
  'no-capable-agent',
  'no-available-agent',
  'no-model-available',
  'quota-blocked',
  'assignment-invalid',
] as const;
export type AssignmentFailureCode = (typeof ASSIGNMENT_FAILURE_CODES)[number];

/** Why a candidate was filtered out. Recorded so a refusal is diagnosable. */
export type CandidateRejection =
  | { readonly code: 'not-capable'; readonly detail: string }
  | { readonly code: 'availability-unknown' | 'availability-unavailable'; readonly detail: string }
  | { readonly code: 'policy-blocked'; readonly detail: string }
  | { readonly code: 'quota-blocked'; readonly detail: string }
  | { readonly code: 'outside-free-pool'; readonly detail: string };

/** One (agent, model) pair that survived the hard filters. */
export interface AssignmentCandidate {
  /** Canonical identity, exactly as `ModelRegistry` and `ModelPool` spell it. */
  readonly agentId: string;
  readonly modelId: string;
  readonly taskTypes: readonly TaskType[];
  readonly availability: ModelEntry['availability'];
  readonly policyStatus: PolicyState;
  /** `agentId::modelId` — the registry's own key, never a new form. */
  readonly key: string;
}

/**
 * Why a candidate scored what it scored.
 *
 * Every component is a NAMED NUMBER, not an opaque total. If an assignment is
 * ever questioned, this is the answer, and it does not require re-running anything
 * or guessing which input mattered.
 */
export interface ScoreBreakdown {
  /** Fraction of required task types this entry offers, in [0, 1]. */
  readonly capabilityFit: number;
  /** 1 when availability is confirmed, and never 0 here (unknown is filtered). */
  readonly availability: number;
  /** Historical success rate for this agent ON THIS TASK TYPE, or null if unproven. */
  readonly agentEvidence: number | null;
  /** The same for the model rather than the agent. */
  readonly modelEvidence: number | null;
  /** Fraction of this agent's attempts on this type that needed rework, or null. */
  readonly reworkRate: number | null;
  /** `agentEvidence - reworkRate`, the term the score actually uses. */
  readonly evidenceTerm: number;
  readonly total: number;
}

/** A candidate plus why it won, and why everything else lost. */
export interface ScoredCandidate {
  readonly candidate: AssignmentCandidate;
  readonly score: ScoreBreakdown;
}

export type AssignmentOutcome =
  | {
      readonly ok: true;
      readonly chosen: ScoredCandidate;
      /** Every candidate that survived the hard filters, best first. */
      readonly ranked: readonly ScoredCandidate[];
      /** Candidates the filters removed, and why. Empty is fine. */
      readonly rejected: readonly (CandidateRejection & { readonly agentId: string; readonly modelId: string })[];
      /** Snapshot size the decision was made from, for the audit trail. */
      readonly snapshotSize: number;
    }
  | {
      readonly ok: false;
      readonly code: AssignmentFailureCode;
      readonly reason: string;
      readonly rejected: readonly (CandidateRejection & { readonly agentId: string; readonly modelId: string })[];
    };

export interface AssignmentInput {
  readonly taskId: string;
  readonly taskType: TaskType;
  /** Extra types the task also needs. Defaults to `[taskType]`. */
  readonly requiredTaskTypes?: readonly TaskType[];
  /** The EXISTING registry. Read-only; this module never writes to it. */
  readonly registry: ModelRegistry;
  /** Real quota observations, resolved through the existing gate resolver. */
  readonly quotaRecords: readonly QuotaRecord[];
  /** P6-E history. Read-only; this module never appends to it. */
  readonly evidence: AttemptStore | null;
  /** Honour P6-F's free-pool constraint. Off by default, like the gate's own. */
  readonly enforceFreeModelPool?: boolean;
}

// ---------------------------------------------------------------------------
// Score weights. Small integers, no tuning knobs, no hidden constants.
// ---------------------------------------------------------------------------

/**
 * Does the SEALED spawn gate block on this quota status?
 *
 * ASKED OF THE GATE RATHER THAN RESTATED HERE, deliberately.
 *
 * The obvious implementation is a local list of blocking statuses. That is
 * exactly the mistake this predicate exists to prevent: P6-B previously carried
 * its own set, and the two silently drifted — the local set omitted
 * `unavailable`, so assignment happily proposed a candidate whose quota status
 * the gate then refused at spawn. The symptom was an assignment that looked
 * correct and produced a task that could not run.
 *
 * A duplicated list cannot be kept in sync because nothing connects it to the
 * thing it must agree with. So this asks `evaluateSpawnGate` directly, with every
 * OTHER signal set to a passing value, so the only thing it can possibly decide
 * is the quota status. Parity is then structural: if the gate adds or removes a
 * blocking status, this follows with no edit, and there is no second definition
 * left to drift.
 *
 * The gate remains the authority. This is an early exclusion — it stops us
 * PROPOSING something the gate would refuse — and never a second veto.
 */
function quotaBlocksSpawn(status: QuotaRecord['status']): boolean {
  const probe = evaluateSpawnGate({
    multiAgentEnabled: true,
    taskPolicyAllows: true,
    capabilitySatisfied: true,
    agentAvailable: true,
    modelAvailable: true,
    quota: { status },
    // `remaining >= requested`, so the budget rule cannot fire and mask the answer.
    budget: { remaining: 1000, requested: 0 },
    // `current < limit`, likewise for concurrency.
    concurrency: { current: 0, limit: 1000 },
  } as never);
  return probe.allowed === false;
}

const W_CAPABILITY = 50;
const W_EVIDENCE = 40;
const W_AVAILABILITY = 10;

/** Assumed when a candidate has no history: neither good nor bad. */
const UNPROVEN_EVIDENCE = 0.5;

/**
 * Worker history for one agent, optionally narrowed to one model, on one task type.
 *
 * Reads `AttemptStore.all()` directly rather than reusing one aggregation call,
 * because selection needs the CROSS of taskType x agent x model — `agentEvidence()`
 * groups by agent alone and would let a worker's research history count towards
 * an implementation task. Reading the same records with a tighter predicate is not
 * a second authority: `AttemptStore` still owns every fact, and this computes
 * nothing that is not already there.
 *
 * REVIEW RECORDS ARE EXCLUDED. A reviewer's `reject` says the reviewer judged the
 * work, not that the worker failed — the same reasoning P6-E used to separate
 * `agentEvidence` from `reviewerEvidence`. Mixing them would penalise an agent for
 * a reviewer being strict.
 *
 * `modelId === null` means "this agent, any model". Passing an agent id there by
 * mistake would filter the history down to records whose MODEL happened to be
 * named after the agent, which is almost always zero — a silent empty history
 * that reads as "no data" rather than as a bug.
 */
function historyFor(
  store: AttemptStore,
  agentId: string,
  modelId: string | null,
  taskType: TaskType,
): { attempts: number; successes: number; reworks: number } {
  let attempts = 0;
  let successes = 0;
  let reworks = 0;
  for (const r of store.all() as readonly AttemptRecord[]) {
    if (r.kind === 'review') continue;              // reviewer evidence is not worker quality
    if (r.agentId !== agentId) continue;
    if (r.taskType !== taskType) continue;           // relevance gate
    if (modelId !== null && r.modelId !== modelId) continue;
    attempts++;
    if (r.outcome === 'success') successes++;
    if (r.kind === 'rework') reworks++;              // rework is counted, never as a success
  }
  return { attempts, successes, reworks };
}

/** Score one already-filtered candidate. Pure, deterministic, explainable. */
export function scoreCandidate(
  candidate: AssignmentCandidate,
  required: readonly TaskType[],
  evidence: AttemptStore | null,
): ScoreBreakdown {
  const capabilityFit = required.length === 0
    ? 0
    : required.filter((t) => candidate.taskTypes.includes(t)).length / required.length;

  let agentEvidence: number | null = null;
  let modelEvidence: number | null = null;
  let reworkRate: number | null = null;
  let evidenceTerm = UNPROVEN_EVIDENCE;

  if (evidence !== null) {
    // The REQUIRED type is the one that matters, not the candidate's first offered
    // type: a model offering [review, implementation] must be judged on the type
    // the task actually is.
    const type = required[0] ?? candidate.taskTypes[0] ?? 'implementation';

    const byAgent = historyFor(evidence, candidate.agentId, null, type);
    agentEvidence = byAgent.attempts === 0 ? null : byAgent.successes / byAgent.attempts;
    reworkRate = byAgent.attempts === 0 ? null : byAgent.reworks / byAgent.attempts;

    const byModel = historyFor(evidence, candidate.agentId, candidate.modelId, type);
    modelEvidence = byModel.attempts === 0 ? null : byModel.successes / byModel.attempts;

    // The agent term is the trustworthy one when there is history; the model term
    // refines it. Averaging rather than adding, so neither can dominate.
    const parts = [agentEvidence, modelEvidence].filter((v): v is number => v !== null);
    const base = parts.length === 0 ? UNPROVEN_EVIDENCE : parts.reduce((a, b) => a + b, 0) / parts.length;
    // Rework is halved rather than counted whole: work a reviewer asked to be
    // redone is evidence against the worker, but it is not the same as a run that
    // failed outright.
    evidenceTerm = base - (reworkRate ?? 0) * 0.5;
  }

  const total =
    W_CAPABILITY * capabilityFit +
    W_EVIDENCE * evidenceTerm +
    W_AVAILABILITY * 1;

  return Object.freeze({
    capabilityFit,
    // Availability is a FILTER, not a graded signal: `unknown` never reaches here,
    // so this factor is constant by construction. It is reported anyway, because a
    // score that silently omits a gate factor is harder to argue with than one
    // that shows it.
    availability: 1,
    agentEvidence,
    modelEvidence,
    reworkRate,
    evidenceTerm,
    total,
  });
}

const rejected = (
  agentId: string,
  modelId: string,
  r: CandidateRejection,
): CandidateRejection & { agentId: string; modelId: string } => ({ agentId, modelId, ...r });

/**
 * Choose a worker for one task. Pure: reads three read-only inputs, returns a
 * decision. It has no reference to TaskStore, TaskScheduler or RuntimeRunner and
 * performs no I/O, so it cannot dispatch or mutate anything even by accident.
 *
 * There is NO FALLBACK PATH. If nothing survives the filters, this returns a
 * structured refusal — it does not reach for "the first agent", the default
 * worker, or a random pick. A wrong assignment costs more than an honest refusal.
 */
export function assignWorker(input: AssignmentInput): AssignmentOutcome {
  if (input.taskId.trim() === '' || input.taskType.trim() === '') {
    return {
      ok: false,
      code: 'assignment-invalid',
      reason: `taskId and taskType must be non-empty (got taskId=${JSON.stringify(input.taskId)}, taskType=${JSON.stringify(input.taskType)})`,
      rejected: [],
    };
  }
  const required = input.requiredTaskTypes === undefined || input.requiredTaskTypes.length === 0
    ? [input.taskType]
    : [...input.requiredTaskTypes];

  // Candidate discovery: the EXISTING registry's canonical list. `list()` is
  // already sorted by key, so iteration order is deterministic without sorting here.
  const all = input.registry.list();
  const rejectedList: (CandidateRejection & { agentId: string; modelId: string })[] = [];
  const survived: AssignmentCandidate[] = [];

  // Quota is resolved per AGENT through the existing gate resolver, once, and
  // memoised here — not because it is expensive but so every candidate for an
  // agent sees the SAME answer.
  const quotaByAgent = new Map<string, ReturnType<typeof resolveQuotaStatus>>();
  const quotaFor = (agentId: string): ReturnType<typeof resolveQuotaStatus> => {
    const cached = quotaByAgent.get(agentId);
    if (cached !== undefined) return cached;
    const resolved = resolveQuotaStatus({
      quotaRecords: input.quotaRecords as QuotaRecord[],
      agentId,
    });
    quotaByAgent.set(agentId, resolved);
    return resolved;
  };

  for (const entry of all) {
    // 1. CAPABILITY — the entry's own `taskTypes`, which is the project's existing
    //    capability contract. No new capability vocabulary is invented here.
    if (!required.every((t) => entry.taskTypes.includes(t))) {
      rejectedList.push(rejected(entry.agentId, entry.modelId, {
        code: 'not-capable',
        detail: `offers [${entry.taskTypes.join(', ')}], needs [${required.join(', ')}]`,
      }));
      continue;
    }

    // 2. AVAILABILITY — fail-closed. `unknown` is NOT available: an unconfirmed
    //    probe is not a positive signal, and treating it as one is how a routing
    //    system proposes a model that turns out to be gone.
    if (entry.availability !== 'available') {
      rejectedList.push(rejected(entry.agentId, entry.modelId, {
        code: entry.availability === 'unknown' ? 'availability-unknown' : 'availability-unavailable',
        detail: `registry availability is "${entry.availability}"`,
      }));
      continue;
    }

    // 3. QUOTA — reuse the gate's own resolver, never restate it.
    //
    //    NOTE ON `policyStatus`, because the obvious version of this filter is
    //    wrong. `ModelRegistry.upsert` defaults a fresh entry to
    //    `policyStatus: 'unavailable'` meaning "policy not evaluated yet"
    //    (registry.ts:45), and `buildSpawnGateInput` NEVER READS `policyStatus`
    //    at all — it derives task policy from the entry's `taskTypes`. So
    //    requiring `policyStatus === 'allowed'` would reject nearly every model
    //    in the system and invent a rule stricter than the gate's — the exact
    //    "two answers to is-this-runnable" failure this module documents.
    //
    //    Only `quota-blocked` is filtered, because it is the one state that is an
    //    unambiguous, already-made decision. `disabled` and the un-evaluated
    //    default are left to the gate.
    if (entry.policyStatus === 'quota-blocked') {
      rejectedList.push(rejected(entry.agentId, entry.modelId, {
        code: 'quota-blocked',
        detail: `policyStatus is "quota-blocked" (${entry.policyReason})`,
      }));
      continue;
    }
    const quota = quotaFor(entry.agentId);
    if (quota.ok !== true) {
      rejectedList.push(rejected(entry.agentId, entry.modelId, {
        code: 'quota-blocked',
        detail: quota.missing.reason,
      }));
      continue;
    }
    // The gate's own answer to "does this quota status block?", computed above.
    // Every status the gate blocks on — including `unavailable` — is excluded here
    // too, so assignment never proposes a candidate that `executeTask` would
    // refuse one tick later.
    if (quotaBlocksSpawn(quota.value as QuotaRecord['status'])) {
      rejectedList.push(rejected(entry.agentId, entry.modelId, {
        code: 'quota-blocked',
        detail: `the spawn gate blocks on quota status "${quota.value}"`,
      }));
      continue;
    }

    // 4. FREE POOL — P6-F's own predicate, unchanged.
    if (input.enforceFreeModelPool === true && !isAllowedModel({ agentId: entry.agentId, modelId: entry.modelId }).allowed) {
      rejectedList.push(rejected(entry.agentId, entry.modelId, {
        code: 'outside-free-pool',
        detail: 'not an ACTIVE free-pool entry (P6-F model-pool)',
      }));
      continue;
    }

    survived.push(Object.freeze({
      agentId: entry.agentId,
      modelId: entry.modelId,
      taskTypes: Object.freeze([...entry.taskTypes]),
      availability: entry.availability,
      policyStatus: entry.policyStatus,
      key: entry.key === modelKey(entry.agentId, entry.modelId) ? entry.key : modelKey(entry.agentId, entry.modelId),
    }));
  }

  if (survived.length === 0) {
    // Name the most specific cause. "No candidate" and "every candidate was
    // quota-blocked" are different operator problems, and the caller cannot tell
    // them apart from a generic message.
    const has = (code: CandidateRejection['code']): boolean => rejectedList.some((r) => r.code === code);
    const hasAny = rejectedList.length > 0;
    let code: AssignmentFailureCode;
    let reason: string;
    if (hasAny && rejectedList.every((r) => r.code === 'not-capable')) {
      code = 'no-capable-agent';
      reason = `no registered model offers [${required.join(', ')}] for task "${input.taskId}"`;
    } else if (hasAny && rejectedList.every((r) => r.code === 'outside-free-pool')) {
      code = 'no-model-available';
      reason = `no capable model is inside the ACTIVE free pool for task "${input.taskId}"`;
    } else if (hasAny && rejectedList.every((r) => r.code === 'quota-blocked' || r.code === 'policy-blocked')) {
      code = 'quota-blocked';
      reason = `every capable candidate for task "${input.taskId}" is blocked by quota or policy`;
    } else if (hasAny && rejectedList.some((r) => r.code === 'availability-unavailable')) {
      code = 'no-available-agent';
      reason = `every capable candidate for task "${input.taskId}" is unavailable`;
    } else {
      code = has('not-capable') ? 'no-capable-agent' : 'no-available-agent';
      reason = `no candidate survived capability / availability / quota filtering for task "${input.taskId}"`;
    }
    return { ok: false, code, reason, rejected: rejectedList };
  }

  // 5. SCORE — only over survivors, then a stable tie-break.
  const ranked = survived
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, required, input.evidence) }))
    .sort((a, b) => {
      if (b.score.total !== a.score.total) return b.score.total - a.score.total;
      // Canonical tie-break: agentId then modelId, ascending. Never insertion
      // order, never a random draw.
      if (a.candidate.agentId !== b.candidate.agentId) return a.candidate.agentId < b.candidate.agentId ? -1 : 1;
      return a.candidate.modelId < b.candidate.modelId ? -1 : 1;
    });

  return { ok: true, chosen: ranked[0], ranked, rejected: rejectedList, snapshotSize: all.length };
}

// ---------------------------------------------------------------------------
// Reassignment boundary
// ---------------------------------------------------------------------------

/**
 * Statuses a task may still be assigned in.
 *
 * `TaskStore.assignIdentity` enforces this against `startedAt`, which is the
 * real knowledge of "has this run". This set exists so a caller can pre-check
 * without attempting a write, and so the boundary is stated in one place rather
 * than implied by the store's internals.
 *
 * `running` is deliberately absent, and so is every terminal status. Switching a
 * RUNNING task's worker is P6-D1's problem together with replan and downstream
 * invalidation; P6-B does not solve any part of it.
 */
export const ASSIGNABLE_STATUSES = ['planned', 'blocked'] as const;

/** Is this task in a state P6-B is allowed to assign at all? */
export function isAssignable(status: string): boolean {
  return (ASSIGNABLE_STATUSES as readonly string[]).includes(status);
}

/**
 * P6-B explicitly does NOT support switching a model on a task that already has
 * one, and does not support model migration at all.
 *
 * Kept as a named, tested function rather than an absence, because "the feature
 * is not there" is a much weaker guarantee than "the feature refuses when asked".
 */
export function requestModelSwitch(): { ok: false; code: 'model-switch-not-supported'; reason: string } {
  return {
    ok: false,
    code: 'model-switch-not-supported',
    reason:
      'model switching is P6-D1 (reassign + replan + downstream invalidation), not P6-B. ' +
      'P6-B only chooses the worker for a task that has not started.',
  };
}
