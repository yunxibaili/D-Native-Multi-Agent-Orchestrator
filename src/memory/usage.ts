/**
 * memory/usage.ts — F6: make memory's LLM cost visible to the budget layer.
 *
 * The PoC measured, per /metrics: 23 retains produced 23 `retain_extract_facts`
 * calls AND 23 background `consolidation` calls — roughly 2 LLM calls and ~5.9k
 * tokens per write, while `recall` made ZERO LLM calls. A layer that reports only
 * "a recall happened" would understate the real cost by an order of magnitude,
 * because the expensive part is asynchronous and invisible.
 *
 * Two rules shape this module:
 *
 *   1. §18 — never fabricate. Tokens are `null` when the backend does not expose
 *      them, and `usageClass: 'unknown'`. There is deliberately NO 'estimated'
 *      class: a guess must not enter a budget wearing a measurement's clothes.
 *      `0` is reserved for a real, observed zero.
 *   2. §19 — do not touch the sealed Phase 4 contract. This module produces
 *      observations, not ledger mutations. The adapter that feeds
 *      `BudgetLedger` lives in index.ts and is additive; `src/quota/` is
 *      unchanged.
 *
 * The retain/consolidation/recall split (§20) is preserved on every observation,
 * because "retain ≈ LLM + consolidation", "reflect ≈ LLM" and "recall ≈ mostly
 * retrieval" are the facts a budget conversation needs.
 */

import type { MemoryOperation, MemoryUsageObservation } from './types.ts';

/** One backend metric scope's counters, e.g. `retain_extract_facts`. */
export interface ScopeCounters {
  input: number;
  output: number;
  calls: number;
}

/**
 * Counters grouped BY SCOPE. The backend exposes cumulative Prometheus counters
 * labelled with the operation scope that incremented them; summing them without
 * the label is exactly the defect that reported a backend lifetime total as one
 * operation's cost.
 */
export type ScopedCounters = Map<string, ScopeCounters>;

/** Label used when a metrics line carries no `scope=` label. */
export const UNLABELLED_SCOPE = 'unlabelled';

/**
 * Which backend scopes a given memory operation may legitimately be charged
 * for, taken from the scopes the backend ACTUALLY emits (verified against
 * /metrics: retain_extract_facts, reflect_tool_call, verification,
 * consolidation). Naming a scope that does not exist would silently push real
 * tokens into the unattributed bucket and undercharge, so the reflect entry
 * uses the backend's real name rather than the operation's friendly name.
 *
 * `consolidation` is deliberately ABSENT: it is a background job that can
 * consolidate any bank, so its tokens are real cost but are not attributable to
 * the write that happened to trigger them.
 */
export const OPERATION_SCOPES: Record<MemoryOperation, readonly string[]> = {
  retain: ['retain_extract_facts', 'verification'],
  reflect: ['reflect_tool_call', 'reflect', 'verification'],
  recall: ['recall', 'verification'],
  embedding: ['embedding'],
};

export interface UsageDiff {
  input: number;
  output: number;
  calls: number;
}

export interface ScopeDelta {
  scope: string;
  input: number;
  output: number;
  calls: number;
}

/**
 * Diff two scoped readings. Returns null when no baseline exists, because a
 * first reading is a CUMULATIVE total and subtracting nothing from it would
 * report the backend's lifetime cost as this operation's cost. Callers must
 * treat null as "unattributable", never as "zero" and never as "everything".
 */
export function diffScopes(after: ScopedCounters, before: ScopedCounters | null): ScopeDelta[] | null {
  if (before === null) return null;
  const deltas: ScopeDelta[] = [];
  for (const [scope, a] of after) {
    const b = before.get(scope);
    if (b === undefined) {
      // A scope that did not exist in the baseline started at zero.
      deltas.push({ scope, input: a.input, output: a.output, calls: a.calls });
      continue;
    }
    deltas.push({
      scope,
      input: Math.max(0, a.input - b.input),
      output: Math.max(0, a.output - b.output),
      calls: Math.max(0, a.calls - b.calls),
    });
  }
  for (const [scope, b] of before) {
    if (!after.has(scope)) continue; // counter vanished; nothing to charge
    void b;
  }
  return deltas.filter((d) => d.input > 0 || d.output > 0 || d.calls > 0);
}

export interface Attribution {
  input: number;
  output: number;
  calls: number;
  attributedScopes: string[];
  unattributedScopes: string[];
}

/**
 * Charge an operation only for the scopes that belong to it. Anything else that
 * moved during the window (background consolidation, another tenant's work) is
 * reported as unattributed rather than silently folded in.
 */
export function attributeToOperation(deltas: ScopeDelta[], operation: MemoryOperation): Attribution {
  const allowed = new Set(OPERATION_SCOPES[operation]);
  const attributedScopes: string[] = [];
  const unattributedScopes: string[] = [];
  let input = 0;
  let output = 0;
  let calls = 0;
  for (const d of deltas) {
    // An unlabelled counter cannot be charged to a specific operation.
    if (d.scope === UNLABELLED_SCOPE || !allowed.has(d.scope)) {
      unattributedScopes.push(d.scope);
      continue;
    }
    attributedScopes.push(d.scope);
    input += d.input;
    output += d.output;
    calls += d.calls;
  }
  return { input, output, calls, attributedScopes, unattributedScopes };
}

export function diffCounters(after: TokenCounters, before: TokenCounters | null): UsageDiff {
  if (before === null) {
    return { input: after.input, output: after.output, calls: after.calls };
  }
  return {
    input: Math.max(0, after.input - before.input),
    output: Math.max(0, after.output - before.output),
    calls: Math.max(0, after.calls - before.calls),
  };
}

export type TokenCounters = { input: number; output: number; calls: number };

export interface BuildObservationInput {
  memoryOperation: MemoryOperation;
  provider: string;
  model: string;
  /**
   * Per-scope movement measured ACROSS this operation. null when no baseline
   * was captured (or the backend exposed nothing usable), which means the cost
   * is unattributable — not zero, and not the cumulative total.
   */
  deltas: ScopeDelta[] | null;
  latencyMs: number;
  timestamp: number;
  source: string;
  /**
   * The backend's cumulative input-token counter per scope AFTER the operation.
   * Used by the budget ledger's double-count guard.
   */
  counterValues?: ScopedCounters | null | undefined;
}

/**
 * A stable identity for one measurement. Deterministic (no clock, no random)
 * so replaying the same inputs produces the same id, which is what lets the
 * budget ledger treat a re-recorded observation as the same charge.
 */
export function observationIdFor(input: {
  memoryOperation: MemoryOperation;
  timestamp: number;
  provider: string;
  model: string;
  deltas: ScopeDelta[] | null;
}): string {
  const parts = input.deltas === null
    ? 'unmeasured'
    : input.deltas
        .map((d) => `${d.scope}:${d.input}:${d.output}:${d.calls}`)
        .sort()
        .join(',');
  return `${input.memoryOperation}@${input.timestamp}:${input.provider}/${input.model}#${parts}`;
}

/**
 * The backend's cumulative TOTAL-token counter per scope (input + output).
 * Both the watermark and the per-scope deltas are expressed in total tokens so
 * a charge is directly comparable to `totalTokens` — mixing an input-only
 * watermark with an input+output delta would quietly undercharge.
 */
function counterSnapshot(counters: ScopedCounters | null | undefined): Record<string, number> {
  if (counters === null || counters === undefined) return {};
  const out: Record<string, number> = {};
  for (const [scope, value] of counters) out[scope] = value.input + value.output;
  return out;
}

/**
 * Build one observation from a measured scope delta.
 *
 * `deltas: null` (no baseline) is the important case: the backend's counters are
 * cumulative, so with nothing to subtract from, reporting them here would state
 * a lifetime total as this call's cost. That is reported as `unknown` with null
 * token fields instead.
 */
export function buildObservation(input: BuildObservationInput): MemoryUsageObservation {
  const observationId = observationIdFor({
    memoryOperation: input.memoryOperation,
    timestamp: input.timestamp,
    provider: input.provider,
    model: input.model,
    deltas: input.deltas,
  });
  const counterValues = counterSnapshot(input.counterValues);
  if (!input.deltas || input.deltas === null) {
    return {
      observationId,
      memoryOperation: input.memoryOperation,
      provider: input.provider,
      model: input.model,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      llmCalls: null,
      costUsd: null,
      costSource: 'unavailable',
      latencyMs: input.latencyMs,
      timestamp: input.timestamp,
      source: input.source,
      usageClass: 'unknown',
      confidence: 'unknown',
      attributedScopes: [],
      unattributedScopes: [],
      scopeCounterValues: counterValues,
      scopeDeltas: {},
    };
  }
  const attribution = attributeToOperation(input.deltas, input.memoryOperation);
  const scopeDeltas: Record<string, number> = {};
  for (const d of input.deltas) {
    // Total tokens (input + output) per attributed scope, matching the watermark.
    if (attribution.attributedScopes.includes(d.scope)) scopeDeltas[d.scope] = d.input + d.output;
  }
  // A zero here is a MEASURED zero: the baseline existed and nothing this
  // operation owns moved. That is a real answer (recall makes no LLM calls),
  // not a stand-in for "we did not look".
  return {
    observationId,
    memoryOperation: input.memoryOperation,
    provider: input.provider,
    model: input.model,
    inputTokens: attribution.input,
    outputTokens: attribution.output,
    totalTokens: attribution.input + attribution.output,
    llmCalls: attribution.calls,
    costUsd: null,
    costSource: 'unavailable',
    latencyMs: input.latencyMs,
    timestamp: input.timestamp,
    source: input.source,
    usageClass: 'observed',
    confidence: 'high',
    attributedScopes: attribution.attributedScopes,
    unattributedScopes: attribution.unattributedScopes,
    scopeCounterValues: counterValues,
    scopeDeltas,
  };
}

/** Local-only observation: latency is measured, tokens are not knowable here. */
export function buildLocalObservation(input: {
  memoryOperation: MemoryOperation;
  provider: string;
  model: string;
  latencyMs: number;
  timestamp: number;
  source: string;
  reason: string;
}): MemoryUsageObservation {
  return {
    observationId: observationIdFor({
      memoryOperation: input.memoryOperation,
      timestamp: input.timestamp,
      provider: input.provider,
      model: input.model,
      deltas: null,
    }),
    memoryOperation: input.memoryOperation,
    provider: input.provider,
    model: input.model,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    llmCalls: null,
    costUsd: null,
    costSource: 'unavailable',
    latencyMs: input.latencyMs,
    timestamp: input.timestamp,
    source: input.source,
    usageClass: 'unknown',
    confidence: 'unknown',
    attributedScopes: [],
    unattributedScopes: [],
    scopeCounterValues: {},
    scopeDeltas: {},
  };
}

/**
 * Roll observations up per operation. `llmCalls` and `totalTokens` are reported
 * ONLY when every contributing observation was measured; if any is
 * unattributable the result is null, because a partial sum is indistinguishable
 * from a complete one at the call site and would understate cost silently.
 * `unmeasuredOperations` says how many were missing.
 */
export function summarize(observations: readonly MemoryUsageObservation[]): {
  byOperation: Array<{
    memoryOperation: MemoryOperation;
    operations: number;
    llmCalls: number | null;
    totalTokens: number | null;
    unmeasuredOperations: number;
  }>;
  totalOperations: number;
} {
  const acc = new Map<MemoryOperation, { operations: number; tokens: number; calls: number; unmeasured: number }>();
  for (const o of observations) {
    const row = acc.get(o.memoryOperation) ?? { operations: 0, tokens: 0, calls: 0, unmeasured: 0 };
    row.operations += 1;
    if (o.totalTokens === null || o.llmCalls === null) {
      row.unmeasured += 1;
    } else {
      row.tokens += o.totalTokens;
      row.calls += o.llmCalls;
    }
    acc.set(o.memoryOperation, row);
  }
  return {
    byOperation: [...acc.entries()].map(([memoryOperation, row]) => ({
      memoryOperation,
      operations: row.operations,
      // Partial data is reported as absent, never as a smaller-looking total.
      llmCalls: row.unmeasured === 0 ? row.calls : null,
      totalTokens: row.unmeasured === 0 ? row.tokens : null,
      unmeasuredOperations: row.unmeasured,
    })),
    totalOperations: observations.length,
  };
}
