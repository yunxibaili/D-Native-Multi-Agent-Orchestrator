/**
 * quota/budget.ts — the ORCHESTRATION budget ledger.
 *
 * This is deliberately NOT provider billing. It tracks units WE allocate to
 * our own work (Global / Task / Agent scopes) so a future Phase 5 orchestrator
 * can refuse work it cannot afford. It never converts to USD, never reads a
 * provider invoice, and never mixes with `Usage.costUsd`.
 *
 * Ledger arithmetic, stated once:
 *   remaining = allocated − reserved − consumed
 *   reserve   moves nothing yet (a hold), consume settles a hold, release
 *   returns a hold to the pool. Every denial is a RESULT with a code and a
 *   reason — no exceptions, no silent clamping.
 */

import type {
  BudgetScope,
  BudgetState,
  LedgerResult,
  Reservation,
} from './types.ts';

export class BudgetLedger {
  readonly scope: BudgetScope;
  readonly id: string;
  private allocatedAmount = 0;
  private consumedAmount = 0;
  private releasedAmount = 0;
  private readonly holds = new Map<string, Reservation>();

  constructor(scope: BudgetScope, id: string, allocated = 0) {
    this.scope = scope;
    this.id = id;
    this.allocatedAmount = Math.max(0, allocated);
  }

  /** Grow (or shrink, never below committed) the allocation. */
  allocate(amount: number): LedgerResult {
    if (!Number.isFinite(amount) || amount < 0) {
      return { ok: false, code: 'invalid-amount', reason: `allocate needs a non-negative amount, got ${amount}` };
    }
    const next = this.allocatedAmount + amount;
    const committed = this.reservedAmount() + this.consumedAmount;
    if (next < committed) {
      return {
        ok: false,
        code: 'insufficient-remaining',
        reason: `cannot shrink below committed ${committed} (requested allocation ${next})`,
      };
    }
    this.allocatedAmount = next;
    return { ok: true, state: this.snapshot() };
  }

  /** Hold `amount` from remaining. The hold is visible in `reservations`. */
  reserve(reservationId: string, amount: number): LedgerResult {
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, code: 'invalid-amount', reason: `reserve needs a positive amount, got ${amount}` };
    }
    if (this.holds.has(reservationId)) {
      return { ok: false, code: 'duplicate-reservation', reason: `reservation "${reservationId}" already exists` };
    }
    if (amount > this.remaining()) {
      return {
        ok: false,
        code: 'insufficient-remaining',
        reason: `need ${amount} but only ${this.remaining()} remaining`,
      };
    }
    this.holds.set(reservationId, { id: reservationId, amount, createdAt: Date.now() });
    return { ok: true, state: this.snapshot() };
  }

  /**
   * Settle a hold into consumed spend. `amount` defaults to the whole hold;
   * partial consumption releases the unused remainder of the hold.
   */
  consume(reservationId: string, amount?: number): LedgerResult {
    const hold = this.holds.get(reservationId);
    if (!hold) {
      return { ok: false, code: 'unknown-reservation', reason: `no reservation "${reservationId}"` };
    }
    const spend = amount ?? hold.amount;
    if (!Number.isFinite(spend) || spend < 0) {
      return { ok: false, code: 'invalid-amount', reason: `consume needs a non-negative amount, got ${spend}` };
    }
    if (spend > hold.amount) {
      return {
        ok: false,
        code: 'reservation-exceeded',
        reason: `cannot consume ${spend} from a hold of ${hold.amount}`,
      };
    }
    this.holds.delete(reservationId);
    this.consumedAmount += spend;
    const unused = hold.amount - spend;
    if (unused > 0) this.releasedAmount += unused;
    return { ok: true, state: this.snapshot() };
  }

  /**
   * Return part or all of a hold to the pool without consuming it. A partial
   * release shrinks the hold; what remains stays reserved until consumed or
   * fully released.
   */
  release(reservationId: string, amount?: number): LedgerResult {
    const hold = this.holds.get(reservationId);
    if (!hold) {
      return { ok: false, code: 'unknown-reservation', reason: `no reservation "${reservationId}"` };
    }
    const giveBack = amount ?? hold.amount;
    if (!Number.isFinite(giveBack) || giveBack <= 0 || giveBack > hold.amount) {
      return {
        ok: false,
        code: 'reservation-exceeded',
        reason: `cannot release ${giveBack} from a hold of ${hold.amount}`,
      };
    }
    this.releasedAmount += giveBack;
    const rest = hold.amount - giveBack;
    if (rest === 0) this.holds.delete(reservationId);
    else this.holds.set(reservationId, { ...hold, amount: rest });
    return { ok: true, state: this.snapshot() };
  }

  remaining(): number {
    return Math.max(0, this.allocatedAmount - this.reservedAmount() - this.consumedAmount);
  }

  snapshot(): BudgetState {
    return {
      scope: this.scope,
      id: this.id,
      allocated: this.allocatedAmount,
      reserved: this.reservedAmount(),
      consumed: this.consumedAmount,
      released: this.releasedAmount,
      remaining: this.remaining(),
      reservations: [...this.holds.values()].map((r) => ({ ...r })),
    };
  }

  private reservedAmount(): number {
    let sum = 0;
    for (const r of this.holds.values()) sum += r.amount;
    return sum;
  }
}

/**
 * Three scopes, each an independent ledger. Cross-scope draw (a task hold
 * pulling from the global pool) is a Phase 5 concern: guessing the parent/child
 * relationship here would bake an orchestration policy into an accounting tool.
 */
export class BudgetManager {
  readonly global: BudgetLedger;
  private readonly tasks = new Map<string, BudgetLedger>();
  private readonly agents = new Map<string, BudgetLedger>();

  constructor(globalAllocated = 0) {
    this.global = new BudgetLedger('global', 'global', globalAllocated);
  }

  task(taskId: string, allocated = 0): BudgetLedger {
    return this.getOrCreate(this.tasks, 'task', taskId, allocated);
  }

  agent(agentId: string, allocated = 0): BudgetLedger {
    return this.getOrCreate(this.agents, 'agent', agentId, allocated);
  }

  snapshotAll(): BudgetState[] {
    return [
      this.global.snapshot(),
      ...[...this.tasks.values()].map((l) => l.snapshot()),
      ...[...this.agents.values()].map((l) => l.snapshot()),
    ];
  }

  private getOrCreate(
    map: Map<string, BudgetLedger>,
    scope: BudgetScope,
    id: string,
    allocated: number,
  ): BudgetLedger {
    let ledger = map.get(id);
    if (!ledger) {
      ledger = new BudgetLedger(scope, id, allocated);
      map.set(id, ledger);
    } else if (allocated > 0) {
      ledger.allocate(allocated);
    }
    return ledger;
  }
}
