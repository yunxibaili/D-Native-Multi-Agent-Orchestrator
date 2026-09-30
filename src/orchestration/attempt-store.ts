/**
 * src/orchestration/attempt-store.ts — P6-E: the single evidence authority.
 *
 * ONE authority, and it can only do ONE thing.
 *
 * `AttemptStore` appends and queries. That is the whole class. It cannot:
 *   - transition a task          (no store, no transition, no mutator)
 *   - tick a scheduler           (no scheduler reference, ever)
 *   - call a runtime             (no runtime reference, ever)
 *   - change a task's status     (it has no way to reach one)
 *
 * The class is deliberately ignorant of `TaskStore`, `TaskScheduler` and
 * `RuntimeRunner`. Not "careful with them" — structurally unable to reach them. A
 * second authority is not created by adding discipline to a class that could be
 * one; it is avoided by the class having no such capability. P6-D0's decision
 * layer uses the same argument, and the tests assert it from the source.
 *
 * WRITE FAILURES NEVER BLOCK WORK
 * ------------------------------
 * The P6 plan requires that a failed evidence write must not block execution
 * (§11). Evidence is a by-product of work that already happened; losing it is
 * bad, but refusing to run an agent because a counter could not increment would
 * be worse. So `append` is explicit about its failure and the CALLER decides;
 * the integration in attempt-integration.ts records-and-continues.
 *
 * APPEND-ONLY
 * -----------
 * There is no `update`, no `delete`, no `set`. `finish()` is not an update in the
 * mutable sense: it is a second append that supersedes an open attempt, and the
 * superseded record is RETAINED. Rewriting history is how evidence becomes
 * unreliable — you can no longer tell what was known when a decision was made.
 * A closed attempt stays exactly as it was recorded.
 *
 * IN-MEMORY, LIKE THE REST OF 5C
 * ------------------------------
 * `TaskStore` is in-memory and says so. This is too, deliberately: the plan allows
 * the first version to be in-process (§9) and forbids introducing a database to
 * justify it. Durability is a separate decision, and a persisted record store
 * changes nothing about the contract above.
 */

import {
  validateAttemptRecord,
  AttemptRecordError,
  type AttemptKind,
  type AttemptRecord,
} from './attempt-record.ts';

export type AttemptAppendOutcome =
  | { readonly ok: true; readonly record: AttemptRecord }
  | { readonly ok: false; readonly code: string; readonly reason: string };

/** Aggregate counts for one grouping key. Read-only; decides nothing. */
export interface AttemptEvidence {
  readonly key: string;
  readonly total: number;
  readonly execution: number;
  readonly review: number;
  readonly rework: number;
  readonly success: number;
  readonly failure: number;
  readonly reworkRequested: number;
  readonly rejected: number;
  readonly aborted: number;
  readonly errored: number;
  /** Mean wall-clock duration over attempts that actually finished. */
  readonly averageDurationMs: number | null;
  /** Mean budget units over attempts that declared one. */
  readonly averageBudgetUnits: number | null;
  /** Mean cost over attempts that REPORTED one. Unreported attempts are excluded. */
  readonly averageCostUsd: number | null;
  /** How many attempts reported a cost at all, vs how many ran. */
  readonly costReportedCount: number;
}

export interface AttemptStoreOptions {
  /**
   * Id generator. Injectable so tests are deterministic and so the id scheme can
   * change without touching the store.
   *
   * Default is a monotonic counter with a prefix — deliberately NOT a random UUID.
   * A record's id should be readable and orderable by eye; a random id would hide
   * exactly the ordering the `previousAttemptId` chain is there to express.
   */
  readonly newId?: () => string;
}

export class AttemptStore {
  /** attemptId -> record. Insertion-ordered, which is also append order. */
  private readonly byId = new Map<string, AttemptRecord>();
  /** taskId -> attemptIds, in append order. */
  private readonly byTask = new Map<string, string[]>();
  private readonly newId: () => string;
  private counter = 0;

  constructor(options: AttemptStoreOptions = {}) {
    // The counter MUST be incremented here. Reading `counter + 1` without
    // bumping it makes every generated id identical, so the second append is
    // refused as a duplicate — a store that can hold exactly one record.
    this.newId = options.newId ?? (() => `att_${(++this.counter).toString(36).padStart(4, '0')}`);
  }

  /** How many attempts are recorded. */
  get size(): number {
    return this.byId.size;
  }

  /**
   * Append one attempt.
   *
   * Returns a result rather than throwing, because the P6 plan requires evidence
   * failure not to block execution. A caller that genuinely cannot proceed without
   * a record can check `ok` and refuse; a caller doing best-effort recording ignores
   * it. Nothing is stored on failure.
   */
  append(raw: unknown): AttemptAppendOutcome {
    let validated: AttemptRecord;
    try {
      validated = validateAttemptRecord(raw);
    } catch (e) {
      if (e instanceof AttemptRecordError) {
        return { ok: false, code: e.code, reason: e.detail };
      }
      throw e;
    }

    // A caller-supplied id may collide. Silently overwriting would lose an
    // attempt, so this is refused like every other malformed input.
    const attemptId = typeof (raw as { attemptId?: unknown }).attemptId === 'string'
      ? (raw as { attemptId: string }).attemptId
      : this.newId();
    if (this.byId.has(attemptId)) {
      return {
        ok: false,
        code: 'attempt-id-duplicate',
        reason: `an attempt with id "${attemptId}" is already recorded`,
      };
    }

    // The chain link is set HERE, from real append order — not from whatever the
    // caller claimed. A caller cannot claim a `previousAttemptId` that does not
    // exist, which is what keeps the history honest.
    const prior = this.byTask.get(validated.taskId);
    const previousAttemptId = prior !== undefined && prior.length > 0
      ? prior[prior.length - 1]
      : null;

    const record: AttemptRecord = Object.freeze({ ...validated, attemptId, previousAttemptId });

    this.byId.set(attemptId, record);
    const list = this.byTask.get(validated.taskId) ?? [];
    list.push(attemptId);
    this.byTask.set(validated.taskId, list);
    return { ok: true, record };
  }

  /** One attempt by id, or null. */
  get(attemptId: string): AttemptRecord | null {
    return this.byId.get(attemptId) ?? null;
  }

  /**
   * Every attempt for one task, in append order.
   *
   * The canonical history read. Order is append order, which is the order things
   * really happened — not task status, which only shows where it ended.
   */
  history(taskId: string): readonly AttemptRecord[] {
    return (this.byTask.get(taskId) ?? [])
      .map((id) => this.byId.get(id))
      .filter((r): r is AttemptRecord => r !== undefined);
  }

  /** Every attempt, in append order. */
  all(): readonly AttemptRecord[] {
    return [...this.byId.values()];
  }

  /** How many attempts a task has recorded, of a given kind. */
  countByKind(taskId: string, kind: AttemptKind): number {
    return this.history(taskId).filter((r) => r.kind === kind).length;
  }

  // -------------------------------------------------------------------------
  // Read-only aggregation
  //
  // These answer questions. They do not REORDER, PICK or RECOMMEND: there is no
  // ranking, no score, and no "best agent" anywhere in this class. Sorting
  // candidates is P6-B's job and P6-B is not started.
  // -------------------------------------------------------------------------

  /** Aggregate over one grouping of attempts. */
  private aggregate(key: string, records: readonly AttemptRecord[]): AttemptEvidence {
    const count = (pred: (r: AttemptRecord) => boolean): number => records.filter(pred).length;
    const durations = records
      .map((r) => (r.finishedAt === null ? null : r.finishedAt - r.startedAt))
      .filter((d): d is number => d !== null && Number.isFinite(d));
    const budgets = records.map((r) => r.budgetUnits).filter((b): b is number => b !== undefined);
    const costs = records.map((r) => r.costUsd).filter((c): c is number => c !== undefined);
    const mean = (xs: readonly number[]): number | null =>
      xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

    return Object.freeze({
      key,
      total: records.length,
      execution: count((r) => r.kind === 'execution'),
      review: count((r) => r.kind === 'review'),
      rework: count((r) => r.kind === 'rework'),
      success: count((r) => r.outcome === 'success'),
      failure: count((r) => r.outcome === 'failure'),
      reworkRequested: count((r) => r.outcome === 'rework'),
      rejected: count((r) => r.outcome === 'reject'),
      aborted: count((r) => r.outcome === 'aborted'),
      errored: count((r) => r.outcome === 'error'),
      averageDurationMs: mean(durations),
      averageBudgetUnits: mean(budgets),
      averageCostUsd: mean(costs),
      // Reported-vs-ran is kept explicitly: an average over 1 of 9 attempts is
      // not evidence about the other 8, and a consumer must be able to see that.
      costReportedCount: costs.length,
    });
  }

  private groupBy(select: (r: AttemptRecord) => readonly (string | null)[], scope?: (r: AttemptRecord) => boolean): readonly AttemptEvidence[] {
    const buckets = new Map<string, AttemptRecord[]>();
    for (const r of this.all()) {
      if (scope !== undefined && !scope(r)) continue;
      for (const key of select(r)) {
        if (key === null) continue;
        const list = buckets.get(key) ?? [];
        list.push(r);
        buckets.set(key, list);
      }
    }
    // Sorted by key for determinism. This is NOT a ranking of quality — a
    // consumer reads the counts, and nothing here says which key is preferable.
    return [...buckets.keys()].sort()
      .map((key) => this.aggregate(key, buckets.get(key) ?? []));
  }

  /**
   * Per-agent evidence.
   *
   * By default this covers WORK attempts only (execution + rework). A reviewer's
   * verdicts are separate evidence about the reviewer, and averaging a reviewer's
   * `reject` count into "how good is this agent at doing work" would compare two
   * different roles on one scale.
   */
  agentEvidence(options: { includeReviews?: boolean } = {}): readonly AttemptEvidence[] {
    const includeReviews = options.includeReviews === true;
    return this.groupBy(
      (r) => [r.agentId],
      includeReviews ? undefined : (r) => r.kind !== 'review',
    );
  }

  /** Per-model evidence. Work attempts only, for the same reason. */
  modelEvidence(options: { includeReviews?: boolean } = {}): readonly AttemptEvidence[] {
    const includeReviews = options.includeReviews === true;
    return this.groupBy(
      (r) => [r.modelId],
      includeReviews ? undefined : (r) => r.kind !== 'review',
    );
  }

  /** Per-task-type evidence — the cross-tab P6-B will eventually read. */
  taskTypeEvidence(): readonly AttemptEvidence[] {
    return this.groupBy((r) => [r.taskType], (r) => r.kind !== 'review');
  }

  /** task-type × agent, as separate evidence rows keyed `taskType::agentId`. */
  taskTypeByAgentEvidence(): readonly AttemptEvidence[] {
    return this.groupBy((r) => [`${r.taskType}::${r.agentId}`], (r) => r.kind !== 'review');
  }

  /** task-type × model, keyed `taskType::modelId`. */
  taskTypeByModelEvidence(): readonly AttemptEvidence[] {
    return this.groupBy((r) => [`${r.taskType}::${r.modelId}`], (r) => r.kind !== 'review');
  }

  /**
   * Per-reviewer evidence, review attempts only.
   *
   * The inverse of `agentEvidence`: this is how a reviewer is judged, on the
   * verdicts it gave, by nobody's work output.
   */
  reviewerEvidence(): readonly AttemptEvidence[] {
    return this.groupBy((r) => [r.agentId], (r) => r.kind === 'review');
  }
}
