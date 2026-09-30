/**
 * quota/types.ts — the Phase 4 contract.
 *
 * Three rules this file exists to enforce, each broken by a real failure mode:
 *
 *  1. NEVER FABRICATE ZERO. A quota that could not be read is `null` with
 *     `status = unavailable` — not `0`, which would read as "you are out of
 *     quota". Same for cost: a run that reported no cost figure has
 *     `costUsd = null`, not `$0.00`.
 *  2. EVERY NUMBER CARRIES ITS PROVENANCE. `source` + `observedAt` +
 *     `confidence` travel with the value, and usage is classified
 *     `observed | reported | estimated` so a locally-observed run count is
 *     never presented as a provider invoice.
 *  3. AGENT ≠ MODEL ≠ PROVIDER. An entry keys on (agentId, modelId): the same
 *     model id can exist behind two agents, and one agent can serve many
 *     models.
 *
 * No provider API shapes here. Collectors translate CLI output into these
 * types; the dashboard renders them verbatim.
 */

/** Does this record carry usable provider-quota (remaining/reset) information? */
export const QUOTA_STATUSES = [
  /** remaining + period were read from a real source this run. */
  'available',
  /** Source exists but exposes no quota endpoint (our four agents today). */
  'unavailable',
  /** Source exists but the read failed or produced an unparseable payload. */
  'unknown',
  /** Provider was never queried for this snapshot. */
  'not_fetched',
  /** No login / credentials, so no quota can exist to read. */
  'not_connected',
  /** A quota WAS read and it is exhausted. Distinct from `0` being assumed. */
  'exhausted',
] as const;
export type QuotaStatus = (typeof QUOTA_STATUSES)[number];

/** Billing/reset period of a quota window. `unknown` beats guessing. */
export type QuotaPeriod = 'hour' | 'day' | 'week' | 'month' | 'billing_cycle' | 'unknown';

/**
 * Provenance of the usage numbers in a record.
 *  - observed: counted by THIS orchestrator (store of actual runs)
 *  - reported: printed by the agent's own CLI (its own accounting)
 *  - estimated: derived/heuristic — must never be shown as fact
 */
export type UsageClass = 'observed' | 'reported' | 'estimated';

/** How much a value can be trusted given its source + freshness. */
export type Confidence = 'high' | 'medium' | 'low';

/** Where a record came from. `none` = the source was audited and has nothing. */
export type QuotaSourceKind =
  | 'cli_reported'
  | 'provider_reported'
  | 'locally_observed'
  | 'estimated'
  | 'none';

/**
 * Usage snapshot. `costUsd` is nullable ON PURPOSE: absence of a cost figure
 * is information ("this CLI does not report cost"), and coercing it to 0 is
 * the exact fabrication this phase forbids.
 */
export interface UsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  /** null = not reported by the source. 0 only when genuinely reported zero. */
  costUsd?: number | null;
  /** How many runs contributed (observed usage) — 0 for CLI aggregates. */
  runs?: number;
}

/** One quota observation for one (provider, agent[, model]) point. */
export interface QuotaRecord {
  /** Provider identity, e.g. "opencode", "custom" (codex), "workbuddy". */
  provider: string;
  agentId: string;
  /** null when the usage figure is agent-level, not model-level. */
  modelId: string | null;
  source: QuotaSourceKind;
  /** Usage seen so far in the window. null when nothing readable. */
  usage: UsageSnapshot | null;
  /** Remaining quota units. null when unknown — NEVER defaulted to 0. */
  remaining: number | null;
  /** Epoch ms when the window resets. null when the source does not say. */
  resetAt: number | null;
  period: QuotaPeriod;
  status: QuotaStatus;
  usageClass: UsageClass;
  confidence: Confidence;
  /** Epoch ms this record was captured. */
  observedAt: number;
  /** Human explanation, mandatory when status is not `available`. */
  note: string;
}

// ---- model registry ------------------------------------------------------

export type ModelAvailability = 'available' | 'unknown' | 'unavailable';

/** Policy decision for ONE (agent, model) entry. */
export const POLICY_STATES = ['allowed', 'disabled', 'unavailable', 'quota-blocked'] as const;
export type PolicyState = (typeof POLICY_STATES)[number];

/**
 * Task types this runtime knows. An agent/model entry advertises which it
 * accepts; `review` exists only where the adapter's `review` capability does.
 */
export const TASK_TYPES = ['implementation', 'review', 'research', 'test'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export interface ModelEntry {
  /** Composite key `agentId::modelId` — see ModelRegistry. */
  key: string;
  agentId: string;
  modelId: string;
  /** Provider the model is served by (opencode / custom / workbuddy / …). */
  provider: string;
  /** Task types this entry may be used for. */
  taskTypes: TaskType[];
  availability: ModelAvailability;
  /** Label of the quota source feeding this entry, e.g. "locally_observed". */
  quotaSource: string;
  /** Where the model id itself was learned (config / doctor / thread store). */
  modelSource: string;
  policyStatus: PolicyState;
  policyReason: string;
  observedAt: number;
}

export interface PolicyQuery {
  agentId: string;
  modelId: string;
  taskType?: TaskType;
  /** Availability of the agent binary itself (doctor/probe result). */
  agentAvailable?: boolean;
  /** Quota status for this agent/model, if one was collected. */
  quotaStatus?: QuotaStatus;
  /** Explicit policy override, e.g. operator-disabled agent. */
  disabled?: boolean;
}

export interface PolicyDecision {
  agentId: string;
  modelId: string;
  decision: PolicyState;
  reason: string;
}

// ---- budget ledger (orchestration budget, NOT provider billing) ----------

export type BudgetScope = 'global' | 'task' | 'agent';

export interface Reservation {
  id: string;
  amount: number;
  createdAt: number;
}

export interface BudgetState {
  scope: BudgetScope;
  id: string;
  allocated: number;
  reserved: number;
  consumed: number;
  /** Returned to the pool by a release. Informational. */
  released: number;
  /** allocated − reserved − consumed. Never negative. */
  remaining: number;
  reservations: Reservation[];
}

/** Ledger op result. Denials carry a machine code AND a human reason. */
export type LedgerResult =
  | { ok: true; state: BudgetState }
  | { ok: false; code: LedgerDenyCode; reason: string };

export const LEDGER_DENY_CODES = [
  'invalid-amount',
  'insufficient-remaining',
  'unknown-reservation',
  'duplicate-reservation',
  'reservation-exceeded',
] as const;
export type LedgerDenyCode = (typeof LEDGER_DENY_CODES)[number];

// ---- spawn gate ----------------------------------------------------------

/**
 * Deny codes, evaluated in this order (first miss wins):
 * multi-agent-disabled → task-policy → capability → agent → model → quota →
 * budget → concurrency.
 */
export const GATE_DENY_CODES = [
  'multi-agent-not-implemented',
  'task-policy-denied',
  'capability-missing',
  'agent-unavailable',
  'model-unavailable',
  'quota-unavailable',
  'quota-exhausted',
  'budget-insufficient',
  'concurrency-limit',
] as const;
export type GateDenyCode = (typeof GATE_DENY_CODES)[number];

export interface SpawnGateInput {
  /** Multi-Agent stays false until Phase 5B — the gate fails closed. */
  multiAgentEnabled: boolean;
  taskPolicyAllows: boolean;
  capabilitySatisfied: boolean;
  agentAvailable: boolean;
  modelAvailable: boolean;
  quota: { status: QuotaStatus };
  budget: { remaining: number; requested: number };
  concurrency: { current: number; limit: number };
}

export interface SpawnGateResult {
  allowed: boolean;
  code: 'allowed' | GateDenyCode;
  reason: string;
}

// ---- observed usage (from OUR store, not any provider) -------------------

export interface ObservedAgentUsage {
  agentId: string;
  runs: number;
  succeeded: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** null until at least ONE run reported a cost. Otherwise unknown. */
  costUsd: number | null;
  /** How many runs reported a cost figure at all. */
  costReportingRuns: number;
  lastObservedAt: number;
  source: 'locally_observed';
}

// ---- dashboard view ------------------------------------------------------

export interface AgentStatusRow {
  agent: string;
  version: string;
  /** 'Yes' | 'No' | 'Unknown' — Unknown when the provider was not probed. */
  installed: string;
  login: string;
  quotaSource: string;
  /** Human usage summary, classified. */
  usage: string;
  status: string;
}

export interface FreeCreditView {
  /** Verbatim note; "No verified promotions" when nothing is verifiable. */
  status: string;
  promotions: Array<{
    title: string;
    source: string;
    observedAt: string;
    region: string;
    expiry: string;
  }>;
  /** Free-MODEL availability (not promotions) with its own source. */
  freeModels: Array<{
    modelId: string;
    agent: string;
    source: string;
    observedAt: string;
  }>;
}

export interface BudgetViewRow {
  scope: BudgetScope;
  id: string;
  allocated: number;
  reserved: number;
  consumed: number;
  remaining: number;
}

/** Everything the dashboard's Quota / Model Center renders. */
export interface QuotaCenterView {
  generatedAt: string;
  /** observed | reported | estimated explanation, shown verbatim. */
  classificationNote: string;
  agentStatus: AgentStatusRow[];
  modelRegistry: Array<{
    agent: string;
    model: string;
    capability: string;
    availability: ModelAvailability;
    policy: PolicyState;
    quotaSource: string;
    reason: string;
  }>;
  quota: Array<{
    agent: string;
    provider: string;
    model: string;
    period: QuotaPeriod;
    used: string;
    remaining: string;
    reset: string;
    source: string;
    observedAt: string;
    confidence: Confidence;
    status: QuotaStatus;
  }>;
  freeCredit: FreeCreditView;
  budgets: BudgetViewRow[];
  spawnGate: { allowed: boolean; code: string; reason: string };
}
