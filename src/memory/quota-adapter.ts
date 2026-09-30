/**
 * memory/quota-adapter.ts — the ONLY place the memory layer touches Phase 4.
 *
 * `src/quota/` is Phase 4's sealed contract: this adapter imports it and adapts
 * it, and never modifies it. The adaptation is a pass-through because
 * `MemoryBudgetPort` was deliberately shaped to mirror `BudgetLedger`'s existing
 * `reserve` / `consume` / `remaining` signatures. That is what "do not
 * reimplement a second budget" means in practice: there is still exactly one
 * ledger, and this file only chooses which of Phase 4's three scopes memory
 * spends from — a decision it only makes when configuration names one.
 *
 * The reserve-then-consume pair is not ceremony: `BudgetLedger.consume` settles
 * an existing hold, and without the hold it denies with `unknown-reservation`.
 * The hold is released automatically when the consume settles it, so no budget
 * is stranded.
 */

import { BudgetManager } from '../quota/budget.ts';
import type { BudgetLedger } from '../quota/budget.ts';
import type { MemoryBudgetPort, MemoryBudgetSource, MemoryBudgetScope } from './budget.ts';

export interface MemoryQuotaAdapterOptions {
  /** Which Phase 4 scope memory spends from. Resolved by the caller, never here. */
  source: MemoryBudgetSource;
  /**
   * Allocation for the scope, when it must be created. Passing 0 is valid: the
   * charge then DENIES with `insufficient-remaining`, which is the honest
   * outcome for a budget that was never funded — and is visible in the report.
   */
  allocated?: number | undefined;
}

/** Wraps one Phase 4 `BudgetLedger` in the memory layer's port shape. */
export class QuotaBudgetPort implements MemoryBudgetPort {
  private readonly manager: BudgetManager;
  private readonly source: MemoryBudgetSource;

  constructor(options: MemoryQuotaAdapterOptions) {
    this.source = options.source;
    this.manager = new BudgetManager(options.source.scope === 'global' ? options.allocated ?? 0 : 0);
    if (options.source.scope === 'task') {
      this.manager.task(options.source.id, options.allocated ?? 0);
    } else if (options.source.scope === 'agent') {
      this.manager.agent(options.source.id, options.allocated ?? 0);
    }
  }

  /** The Phase 4 ledger itself, typed as such — this is the sealed contract. */
  private ledger(): BudgetLedger {
    if (this.source.scope === 'task') return this.manager.task(this.source.id);
    if (this.source.scope === 'agent') return this.manager.agent(this.source.id);
    return this.manager.global;
  }

  reserve(reservationId: string, amount: number): { ok: boolean; reason?: string } {
    const r = this.ledger().reserve(reservationId, amount);
    return r.ok ? { ok: true } : { ok: false, reason: `${r.code}: ${r.reason}` };
  }

  consume(reservationId: string, amount: number): { ok: boolean; reason?: string } {
    const r = this.ledger().consume(reservationId, amount);
    return r.ok ? { ok: true } : { ok: false, reason: `${r.code}: ${r.reason}` };
  }

  remaining(): number {
    return this.ledger().remaining();
  }

  getSource(): MemoryBudgetSource {
    return { ...this.source };
  }

  /** Exposed for the report; reading Phase 4 state is not a contract change. */
  snapshot(): { scope: MemoryBudgetScope; id: string; allocated: number; reserved: number; consumed: number; remaining: number } {
    const state = this.ledger().snapshot();
    return {
      scope: state.scope,
      id: state.id,
      allocated: state.allocated,
      reserved: state.reserved,
      consumed: state.consumed,
      remaining: state.remaining,
    };
  }
}
