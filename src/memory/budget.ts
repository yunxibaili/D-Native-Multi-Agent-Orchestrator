/**
 * memory/budget.ts — 4M-6: route measured memory usage into the Phase 4 budget.
 *
 * This is the ADAPTER the mandate asks for, and it deliberately contains NO
 * budget arithmetic of its own. `src/quota/` is Phase 4's sealed contract; this
 * module never reimplements a ledger, never mutates one directly, and reaches a
 * real ledger only through the `MemoryBudgetPort` below — a structural interface
 * shaped exactly like `BudgetLedger.reserve/consume/remaining`. That keeps the
 * memory layer swappable and Phase 4 untouched, while still charging the ONE
 * ledger the project already has.
 *
 * ── The distinction the mandate insists on ──
 *
 *   USAGE OBSERVATION   "I know this operation used N tokens."   <- measured
 *   BUDGET CONSUMPTION  "Those N units come out of THIS budget." <- a decision
 *
 * A measurement does not decide where the money comes from. Which of Phase 4's
 * three scopes (global / task / agent) a memory operation belongs to is a
 * project-level policy question, and this module answers it exactly one way:
 *
 *   explicit configuration, or NOTHING.
 *
 * If no scope is configured the observation is still recorded, and the charge is
 * reported as `unassigned`. It is never guessed, never spread across scopes, and
 * never silently charged to `global` because that happens to exist.
 *
 * ── Charging rules (the errors this exists to prevent) ──
 *
 *   1. `unknown` / null tokens  -> NEVER charged, and never recorded as zero
 *      cost. The tokens exist; we simply cannot attribute them. They are
 *      counted as `unmeasured` so the gap is visible rather than invisible.
 *   2. `estimated` -> never charged. The memory layer never produces it, and if
 *      one ever arrived it would be refused rather than believed.
 *   3. Background scopes (`consolidation`) are NEVER chargeable, even if a caller
 *      hands an observation claiming otherwise.
 *   4. The same observation is charged at most once, by `observationId`.
 *   5. No counter increment is charged twice across overlapping windows: a
 *      per-scope watermark is advanced on every observation, measured or not, so
 *      a backlog created while usage was unmeasurable is never charged to an
 *      unrelated later operation.
 *
 * ── Units ──
 *
 * Budget units are TOKENS (1 token = 1 unit). Phase 4's ledger is unit-agnostic;
 * naming the unit here keeps the number honest instead of implying dollars.
 */

import type { MemoryUsageObservation, MemoryUsageClass } from './types.ts';

/** Phase 4's three scopes. Memory does not add a fourth. */
export type MemoryBudgetScope = 'global' | 'task' | 'agent';

export interface MemoryBudgetSource {
  scope: MemoryBudgetScope;
  id: string;
}

/**
 * Where a charge would come from. `assigned: null` is a first-class outcome,
 * not an error: the usage is known but the project has not decided whose budget
 * pays for it.
 */
export type MemoryBudgetAssignment =
  | { assigned: true; source: MemoryBudgetSource; reason: string }
  | { assigned: false; source: null; reason: string };

/**
 * The seam onto Phase 4's ledger. Structurally identical to the subset of
 * `BudgetLedger` the ledger needs, so adapting it is a pass-through.
 */
export interface MemoryBudgetPort {
  reserve(reservationId: string, amount: number): { ok: boolean; reason?: string };
  consume(reservationId: string, amount: number): { ok: boolean; reason?: string };
  remaining(): number;
}

/** Usage classes that may be converted into budget consumption. */
export const CHARGEABLE_USAGE_CLASSES: ReadonlySet<MemoryUsageClass> = new Set<MemoryUsageClass>([
  'observed',
  'reported',
]);

/**
 * Scopes that may never be charged to an operation, whatever a caller claims.
 * `consolidation` is a background job over the whole deployment.
 */
/**
 * Scopes that can never be charged, whatever an observation claims.
 *
 * `consolidation` is background work belonging to no single operation.
 * `unlabelled` is a counter the backend did not attribute: it is real cost we
 * cannot honestly place on an operation, so it is reported as unattributed and
 * left uncharged rather than guessed at.
 */
export const NEVER_CHARGEABLE_SCOPES: ReadonlySet<string> = new Set<string>([
  'consolidation',
  'unlabelled',
]);

export interface ResolveSourceInput {
  /** Level 1: an explicit scope, e.g. from configuration. */
  explicitScope?: string | undefined;
  /** Level 2: the id that scope needs (taskId / agentId). */
  explicitId?: string | undefined;
}

const VALID_SCOPES: ReadonlySet<string> = new Set<string>(['global', 'task', 'agent']);

/**
 * Resolve the budget source. Explicit or nothing: there is deliberately NO
 * derivation step, because "which budget pays for agent memory" is a project
 * decision, and an inferred answer would quietly move spend between scopes.
 */
export function resolveBudgetSource(input: ResolveSourceInput): MemoryBudgetAssignment {
  const scope = input.explicitScope?.trim();
  if (scope === undefined || scope === '') {
    return {
      assigned: false,
      source: null,
      reason:
        'no memory budget scope configured: usage is recorded but NOT charged. ' +
        'Memory spend is not attributed to global/task/agent by inference.',
    };
  }
  if (!VALID_SCOPES.has(scope)) {
    return {
      assigned: false,
      source: null,
      reason: `unknown budget scope "${scope}"; expected one of ${[...VALID_SCOPES].join(', ')}`,
    };
  }
  const id = scope === 'global' ? 'global' : input.explicitId?.trim();
  if (id === undefined || id === '') {
    return {
      assigned: false,
      source: null,
      reason: `budget scope "${scope}" requires an id (taskId / agentId); refusing to guess one`,
    };
  }
  return { assigned: true, source: { scope: scope as MemoryBudgetScope, id }, reason: 'explicit configuration' };
}

export const SKIP_REASONS = {
  noSource: 'no budget source configured',
  unmeasured: 'usage not attributable (usageClass unknown / null tokens) — not charged, not treated as zero',
  estimated: 'estimated usage is never charged',
  neverChargeableScope: 'scope is background work and belongs to no single operation',
  unattributedOnly: 'tokens moved but none were attributable to this operation (unlabelled / background scopes)',
  duplicateObservation: 'observation already recorded (idempotent replay)',
  alreadyCharged: 'no new counter movement beyond what was already charged',
  budgetDenied: 'the Phase 4 ledger refused the charge (e.g. insufficient remaining)',
} as const;

export type SkipReason = (typeof SKIP_REASONS)[keyof typeof SKIP_REASONS];

export interface MemoryCharge {
  observationId: string;
  memoryOperation: MemoryUsageObservation['memoryOperation'];
  assignment: MemoryBudgetAssignment;
  chargeable: boolean;
  /** Budget units charged (tokens). null when nothing was charged. */
  chargedUnits: number | null;
  skipReason: SkipReason | null;
  costUsd: null;
  usageClass: MemoryUsageClass;
  attributedScopes: string[];
  unattributedScopes: string[];
}

export interface MemoryBudgetReport {
  observations: number;
  chargedObservations: number;
  skippedObservations: number;
  unmeasuredObservations: number;
  totalChargedUnits: number;
  /** What is still unmeasured/unattributed — never folded into a total. */
  unmeasuredUnits: null;
  costUsd: null;
  /**
   * False when no Phase 4 ledger is attached. `bySource[].remaining` is then null
   * rather than 0: "no ledger exists" must never read as "zero budget left".
   */
  budgetConfigured: boolean;
  /**
   * True for a ledger created inside a short-lived process (the CLI). It is a
   * per-process view for reporting, NOT the runtime's persistent budget, and
   * must never be presented as one.
   */
  ephemeral: boolean;
  bySource: Array<{ scope: MemoryBudgetScope; id: string; chargedUnits: number; remaining: number | null }>;
  charges: MemoryCharge[];
}

/**
 * Accumulates observations and, when a source is configured and the usage is
 * attributable, charges the Phase 4 ledger through the port.
 */
export class MemoryUsageLedger {
  private readonly port: MemoryBudgetPort | null;
  private readonly assignment: MemoryBudgetAssignment;
  private readonly charges: MemoryCharge[] = [];
  private readonly recorded = new Set<string>();
  /** Per-scope cumulative watermark: the last counter value already charged. */
  private readonly chargedWatermark = new Map<string, number>();
  private sequence = 0;
  private totalChargedUnits = 0;
  private unmeasuredCount = 0;
  private readonly ephemeral: boolean;

  /**
   * @param ephemeral true when this ledger lives only inside one short-lived
   * process (the CLI). Such a ledger starts from a fresh allocation and knows
   * nothing about the runtime's persistent budget, so its report is labelled
   * rather than being allowed to look like the real thing.
   */
  constructor(
    port: MemoryBudgetPort | null,
    assignment: MemoryBudgetAssignment,
    options: { ephemeral?: boolean } = {},
  ) {
    this.port = port;
    this.assignment = assignment;
    this.ephemeral = options.ephemeral === true;
  }

  /**
   * Record one observation. Never throws: a budget problem degrades this call,
   * it does not propagate into the memory operation that produced the usage.
   */
  record(observation: MemoryUsageObservation): MemoryCharge {
    this.sequence += 1;
    const reservationId = `memory:${observation.observationId}`;

    // Rule 4: idempotency. Re-recording the same measurement must not charge again.
    if (this.recorded.has(observation.observationId)) {
      return this.finish(observation, this.assignment, false, null, SKIP_REASONS.duplicateObservation);
    }
    this.recorded.add(observation.observationId);

    // Rule 3: background scopes are never chargeable, whatever is claimed.
    const offending = observation.attributedScopes.filter((s) => NEVER_CHARGEABLE_SCOPES.has(s));
    if (offending.length > 0) {
      return this.finish(observation, this.assignment, false, null, SKIP_REASONS.neverChargeableScope);
    }

    // Rule 1 + 2: only a real, attributable, non-estimated figure may be charged.
    if (!CHARGEABLE_USAGE_CLASSES.has(observation.usageClass) || observation.totalTokens === null) {
      this.unmeasuredCount += 1;
      return this.finish(observation, this.assignment, false, null, SKIP_REASONS.unmeasured);
    }

    // Rule 5: charge this operation's own measured movement, but never more than
    // the counter movement that has not already been charged. The two numbers do
    // different jobs — the DELTA says what this operation cost, the cumulative
    // counter says how much of that scope's history is still unspent. Capping the
    // delta by the uncharged remainder is what makes overlapping windows (and a
    // background job that moved a counter mid-window) safe to charge.
    let chargeableUnits = 0;
    for (const [scope, delta] of Object.entries(observation.scopeDeltas)) {
      if (NEVER_CHARGEABLE_SCOPES.has(scope)) continue;
      if (!observation.attributedScopes.includes(scope)) continue;
      const value = observation.scopeCounterValues[scope];
      if (typeof value !== 'number') { chargeableUnits += delta; continue; }
      const already = this.chargedWatermark.get(scope) ?? 0;
      const uncharged = Math.max(0, value - already);
      chargeableUnits += Math.min(delta, uncharged);
    }
    if (chargeableUnits === 0) {
      // Distinguish "nothing moved at all" (a measured zero) from "tokens moved but
      // none of them were ours" (unlabelled / background). Both charge nothing, but
      // only the second one is an attribution failure the caller must see.
      const unattributedOnly =
        observation.unattributedScopes.length > 0 &&
        Object.values(observation.scopeDeltas).reduce((a, b) => a + b, 0) === 0;
      return this.finish(
        observation,
        this.assignment,
        false,
        null,
        unattributedOnly ? SKIP_REASONS.unattributedOnly : SKIP_REASONS.alreadyCharged,
      );
    }

    // No source configured: the usage stays visible but unspent.
    if (!this.assignment.assigned || this.port === null) {
      return this.finish(observation, this.assignment, false, null, SKIP_REASONS.noSource);
    }

    const reserved = this.port.reserve(reservationId, chargeableUnits);
    if (!reserved.ok) {
      return this.finish(observation, this.assignment, false, null, SKIP_REASONS.budgetDenied, reserved.reason);
    }
    const consumed = this.port.consume(reservationId, chargeableUnits);
    if (!consumed.ok) {
      return this.finish(observation, this.assignment, false, null, SKIP_REASONS.budgetDenied, consumed.reason);
    }

    for (const scope of observation.attributedScopes) {
      const value = observation.scopeCounterValues[scope];
      if (typeof value === 'number') {
        this.chargedWatermark.set(scope, Math.max(this.chargedWatermark.get(scope) ?? 0, value));
      }
    }
    this.totalChargedUnits += chargeableUnits;
    return this.finish(observation, this.assignment, true, chargeableUnits, null);
  }

  private finish(
    observation: MemoryUsageObservation,
    assignment: MemoryBudgetAssignment,
    chargeable: boolean,
    chargedUnits: number | null,
    skipReason: SkipReason | null,
    detail?: string,
  ): MemoryCharge {
    const charge: MemoryCharge = {
      observationId: observation.observationId,
      memoryOperation: observation.memoryOperation,
      assignment: assignedReason(assignment, detail),
      chargeable,
      chargedUnits,
      skipReason,
      costUsd: null,
      usageClass: observation.usageClass,
      attributedScopes: [...observation.attributedScopes],
      unattributedScopes: [...observation.unattributedScopes],
    };
    this.charges.push(charge);
    return charge;
  }

  getCharges(): MemoryCharge[] {
    return [...this.charges];
  }

  report(): MemoryBudgetReport {
    const bySource = new Map<string, { scope: MemoryBudgetScope; id: string; chargedUnits: number }>();
    for (const c of this.charges) {
      if (c.chargedUnits === null || !c.assignment.assigned) continue;
      const key = `${c.assignment.source.scope}:${c.assignment.source.id}`;
      const row = bySource.get(key) ?? { scope: c.assignment.source.scope, id: c.assignment.source.id, chargedUnits: 0 };
      row.chargedUnits += c.chargedUnits;
      bySource.set(key, row);
    }
    return {
      observations: this.charges.length,
      chargedObservations: this.charges.filter((c) => c.chargeable).length,
      skippedObservations: this.charges.filter((c) => !c.chargeable).length,
      unmeasuredObservations: this.unmeasuredCount,
      totalChargedUnits: this.totalChargedUnits,
      // Deliberately typed null: the unmeasured amount is unknown by construction.
      unmeasuredUnits: null,
      costUsd: null,
      budgetConfigured: this.port !== null,
      ephemeral: this.ephemeral,
      bySource: [...bySource.values()].map((row) => ({
        ...row,
        // No ledger -> null. A 0 here would read as an exhausted budget.
        remaining: this.port === null ? null : this.port.remaining(),
      })),
      charges: this.getCharges(),
    };
  }
}

function assignedReason(assignment: MemoryBudgetAssignment, detail?: string): MemoryBudgetAssignment {
  if (assignment.assigned) {
    return detail === undefined
      ? assignment
      : { assigned: true, source: assignment.source, reason: `${assignment.reason}; ${detail}` };
  }
  return detail === undefined
    ? assignment
    : { assigned: false, source: null, reason: `${assignment.reason}; ${detail}` };
}
