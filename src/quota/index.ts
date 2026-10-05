/**
 * quota/index.ts — the facade: everything in, one QuotaCenterView out.
 *
 * Reuse-first assembly of the Phase 4 pipeline:
 *
 *   probes (collector)  +  observed usage (store)  +  config/thread models
 *        → ModelRegistry  →  Model Policy  →  Budget snapshot  →  Spawn Gate
 *        → QuotaCenterView  (dashboard renders it verbatim)
 *
 * Every string that reaches the dashboard already carries its source and its
 * honesty: "Unavailable" is not "0", "cost unknown" is not "$0.00", and the
 * spawn gate demo denies by default because Multi-Agent is not implemented.
 */

import type { AgentDescriptor } from '../core/types.ts';
import type { SessionStore } from '../runtime/store.ts';
import type { AgentConfig } from '../orchestrator/config.ts';
import { BudgetManager } from './budget.ts';
import {
  collectAll,
  formatRemaining,
  formatReset,
  DEFAULT_PROVIDERS,
  type QuotaProbe,
  type QuotaProvider,
} from './collector.ts';
import { collectObservedUsage } from './observed.ts';
import { evaluatePolicy } from './policy.ts';
import { ModelRegistry } from './registry.ts';
import { evaluateSpawnGate } from './spawn-gate.ts';
import type {
  AgentStatusRow,
  FreeCreditView,
  ModelEntry,
  ObservedAgentUsage,
  QuotaCenterView,
  QuotaRecord,
  QuotaStatus,
  UsageSnapshot,
} from './types.ts';

export const ACTIVE_AGENT_IDS = ['opencode', 'codex', 'workbuddy-cn', 'workbuddy-intl'] as const;

const DISPLAY_NAMES: Record<string, string> = {
  opencode: 'OpenCode',
  codex: 'Codex',
  'workbuddy-cn': 'WorkBuddy CN',
  'workbuddy-intl': 'WorkBuddy Intl',
  cline: 'Cline',
  // Pre-split agent id from early WorkBuddy runs; still in the store.
  workbuddy: 'WorkBuddy (legacy id)',
};

const ROLES: Record<string, string> = {
  opencode: 'Implementation',
  codex: 'Independent Review / Test',
  'workbuddy-cn': 'Available',
  'workbuddy-intl': 'Available',
};

const CLASSIFICATION_NOTE =
  'Usage classification: observed = counted by this orchestrator store; reported = printed by the agent\'s own CLI; estimated = heuristic (none used this run). ' +
  'Provider quota remaining/reset is unavailable for all agents on this machine — see docs/PHASE4_QUOTA_AUDIT.md (2026-09-29).';

export interface BuildQuotaCenterOptions {
  store: SessionStore;
  /** Pre-collected probes. Default: run DEFAULT_PROVIDERS against the CLIs. */
  probes?: QuotaProbe[];
  providers?: readonly QuotaProvider[];
  /** Pre-aggregated observed usage. Default: computed from the store. */
  observed?: ObservedAgentUsage[];
  registry?: ModelRegistry;
  budgets?: BudgetManager;
  /** Orchestrator config, for each agent's configured default model. */
  configs?: Record<string, AgentConfig>;
  descriptors?: readonly AgentDescriptor[];
  /** Set when the caller already knows install state; else derived from probes. */
  installed?: Record<string, boolean>;
  freeModels?: FreeCreditView['freeModels'];
  /**
   * R1-1: `multiAgentEnabled` REMOVED. The centre view's demo gate used to deny with
   * `multi-agent-not-implemented` unless a caller opted in, which is no longer a
   * question this codebase asks — see `GATE_DENY_CODES`.
   */
  now?: number;
}

/**
 * Worst real quota status across every accounted agent.
 *
 * Used by the centre view's readiness gate. A single unprobed agent
 * (`not_fetched`) is reported as `unknown` rather than hidden, because the
 * view's job is to say what we do and do not know.
 */
function worstQuotaStatus(records: readonly QuotaRecord[]): QuotaStatus {
  if (records.length === 0) return 'unknown';
  if (records.some((r) => r.status === 'exhausted')) return 'exhausted';
  const rank: Record<string, number> = {
    exhausted: 5, unavailable: 4, not_connected: 3, not_fetched: 2, unknown: 2, available: 1,
  };
  return records.reduce<QuotaStatus>((worst, r) => ((rank[r.status] ?? 0) > (rank[worst] ?? 0) ? r.status : worst), 'available');
}

/** Install state derived from quota probes, when the caller did not supply it. */
function deriveInstalled(records: readonly QuotaRecord[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const r of records) {
    // A record that came from a real source means the CLI answered.
    if (r.source !== 'none') out[r.agentId] = true;
  }
  return out;
}

export async function buildQuotaCenter(opts: BuildQuotaCenterOptions): Promise<QuotaCenterView> {
  const now = opts.now ?? Date.now();
  const probes =
    opts.probes ?? (await collectAll(opts.providers ?? DEFAULT_PROVIDERS)).probes;
  const observed = opts.observed ?? collectObservedUsage(opts.store);
  const registry = opts.registry ?? seedRegistry(opts, probes, now);
  const budgets = opts.budgets ?? new BudgetManager(0);
  const records = probes.flatMap((p) => p.records);

  // Every agent the center speaks about must have a row. Unprobed means
  // `not_fetched` — an absent row would read as "no such agent", and a zero
  // row would read as "no quota left".
  const accounted = new Set(records.map((r) => r.agentId));
  for (const id of [...ACTIVE_AGENT_IDS, 'cline']) {
    if (accounted.has(id)) continue;
    records.push({
      provider: id,
      agentId: id,
      modelId: null,
      source: 'none',
      usage: null,
      remaining: null,
      resetAt: null,
      period: 'unknown',
      status: 'not_fetched',
      usageClass: 'observed',
      confidence: 'low',
      observedAt: now,
      note: 'Provider not queried in this snapshot.',
    });
  }

  applyPolicy(registry, probes, records, opts);

  return {
    generatedAt: new Date(now).toISOString(),
    classificationNote: CLASSIFICATION_NOTE,
    agentStatus: buildAgentStatus(probes, records, observed, opts),
    modelRegistry: registry.list().map((e) => toModelRow(e)),
    quota: records.map((r) => toQuotaRow(r)),
    freeCredit: {
      // No verified promotion endpoint exists on any agent (4A audit). Free
      // models are a separate, sourced fact — see freeModels below.
      status: 'No verified promotions',
      promotions: [],
      freeModels: opts.freeModels ?? freeModelSeed(),
    },
    budgets: budgets.snapshotAll().map((b) => ({
      scope: b.scope,
      id: b.id,
      allocated: b.allocated,
      reserved: b.reserved,
      consumed: b.consumed,
      remaining: b.remaining,
    })),
    // Real signals, not placeholders. Before 5C-1 this passed eight hardcoded
    // fields, so every gate branch had never been exercised by real data. Each
    // field below is now derived from the objects this function already holds, and
    // anything that cannot be derived is DENIED rather than assumed healthy — the
    // same rule 4M-6 applies to an absent budget and 4M-8 applies to an unknown
    // usage count.
    //
    // This view answers "is the centre ready", not "may THIS task spawn". The
    // per-spawn verdict, which needs the task, model and live child count, is
    // built by orchestration/buildSpawnGateInput (Phase 5C-1).
    spawnGate: evaluateSpawnGate({
      // At least one registered (agent, model) entry that is actually usable.
      taskPolicyAllows: registry.list().some((e) => e.taskTypes.length > 0),
      capabilitySatisfied: (opts.descriptors ?? []).some((d) => d.capabilities.newTask),
      // 'Unknown' (not probed) does not count as installed.
      agentAvailable: Object.values(opts.installed ?? deriveInstalled(records)).some((v) => v === true),
      modelAvailable: registry.list().some((e) => e.availability === 'available'),
      // Worst real quota across every agent we accounted for.
      quota: { status: worstQuotaStatus(records) },
      // Real global headroom, and a request that cannot silently pass.
      budget: { remaining: budgets.global.remaining(), requested: budgets.global.remaining() + 1 },
      // A centre view has no orchestration context, so it cannot claim a slot.
      concurrency: { current: 0, limit: 0 },
    }),
  };
}

// ---- registry seeding ----------------------------------------------------

/** Probe's agent id: set by collectAll, else recoverable from its record. */
function probeId(p: QuotaProbe): string {
  return p.agentId ?? p.records[0]?.agentId ?? 'unknown';
}

function seedRegistry(opts: BuildQuotaCenterOptions, probes: QuotaProbe[], now: number): ModelRegistry {  const registry = new ModelRegistry();
  const reviewAgents = new Set(
    (opts.descriptors ?? []).filter((d) => d.capabilities.review).map((d) => d.id),
  );
  const taskTypes = (agentId: string) =>
    reviewAgents.has(agentId)
      ? (['implementation', 'review', 'research', 'test'] as const)
      : (['implementation', 'research', 'test'] as const);

  // 1. Configured default models — what `run` would actually pass.
  for (const [agentId, cfg] of Object.entries(opts.configs ?? {})) {
    if (!cfg.model) continue;
    registry.upsert(
      { agentId, modelId: cfg.model, provider: agentId, taskTypes: taskTypes(agentId), modelSource: 'orchestrator config' },
      now,
    );
  }

  // 2. Models the CLIs themselves reported (codex doctor, cline default).
  for (const probe of probes) {
    if (!probe.modelHint) continue;
    const agentId = probeId(probe);
    if (registry.has(agentId, probe.modelHint)) continue;
    registry.upsert(
      {
        agentId,
        modelId: probe.modelHint,
        provider: probe.providerHint ?? agentId,
        taskTypes: taskTypes(agentId),
        modelSource: `${agentId} CLI probe`,
      },
      now,
    );
  }

  // 3. Models observed on real threads — evidence, not configuration.
  for (const thread of opts.store.listThreads()) {
    if (!thread.model) continue;
    if (registry.has(thread.agentId, thread.model)) continue;
    registry.upsert(
      {
        agentId: thread.agentId,
        modelId: thread.model,
        provider: thread.agentId,
        taskTypes: taskTypes(thread.agentId),
        modelSource: 'thread store (observed)',
      },
      now,
    );
  }

  return registry;
}

// ---- policy application --------------------------------------------------

function applyPolicy(
  registry: ModelRegistry,
  probes: QuotaProbe[],
  records: QuotaRecord[],
  opts: BuildQuotaCenterOptions,
): void {
  const installed = installedMap(probes, opts);
  const quotaStatus = new Map<string, QuotaRecord['status']>();
  for (const r of records) {
    if (!quotaStatus.has(r.agentId) || r.status !== 'unavailable') quotaStatus.set(r.agentId, r.status);
  }

  for (const entry of registry.list()) {
    const available = installed[entry.agentId];
    const decision = evaluatePolicy(registry, {
      agentId: entry.agentId,
      modelId: entry.modelId,
      agentAvailable: available === undefined ? undefined : available,
      quotaStatus: quotaStatus.get(entry.agentId),
    });
    registry.applyPolicy(entry.agentId, entry.modelId, decision.decision, decision.reason);
    if (available !== undefined) {
      registry.setAvailability(entry.agentId, available ? 'available' : 'unavailable');
    }
  }
}

function installedMap(
  probes: QuotaProbe[],
  opts: BuildQuotaCenterOptions,
): Record<string, boolean | undefined> {
  const out: Record<string, boolean | undefined> = { ...(opts.installed ?? {}) };
  // Only PROBED records say anything about install state. A synthesized
  // `not_fetched` placeholder means "never queried" — that is unknown, not
  // "not installed".
  for (const probe of probes) {
    const pid = probeId(probe);
    if (out[pid] !== undefined) continue;
    const rec = probe.records[0];
    out[pid] = rec ? rec.status !== 'not_fetched' : probe.error === null;
  }
  return out;
}

// ---- row builders --------------------------------------------------------

function buildAgentStatus(
  probes: QuotaProbe[],
  records: QuotaRecord[],
  observed: ObservedAgentUsage[],
  opts: BuildQuotaCenterOptions,
): AgentStatusRow[] {
  const installed = installedMap(probes, opts);
  const probeByAgent = new Map(probes.map((p) => [probeId(p), p]));
  const recordByAgent = new Map(records.map((r) => [r.agentId, r]));
  const observedByAgent = new Map(observed.map((o) => [o.agentId, o]));

  const ids = new Set<string>([
    ...ACTIVE_AGENT_IDS,
    ...probeByAgent.keys(),
    ...recordByAgent.keys(),
    ...observedByAgent.keys(),
  ]);

  const rows: AgentStatusRow[] = [];
  for (const id of ids) {
    const probe = probeByAgent.get(id);
    const rec = recordByAgent.get(id);
    const obs = observedByAgent.get(id);
    const isActive = (ACTIVE_AGENT_IDS as readonly string[]).includes(id);

    const sourceLabel = rec ? rec.source : 'not_fetched';
    const login = probe?.login ?? 'Not Fetched';
    const usage = obs ? observedSummary(obs) : rec?.usage ? formatUsage(rec.usage) + ' (reported)' : 'Not Fetched';
    const isInstalled = installed[id];

    let status: string;
    if (id === 'cline') {
      status = 'Verified / Gate Closed / not in active set';
    } else if (isInstalled === undefined) {
      status = isActive ? `${ROLES[id] ?? 'Active'} · not probed` : 'Not probed';
    } else if (isActive) {
      status = isInstalled ? `${ROLES[id] ?? 'Active'} · quota ${rec?.status ?? 'not_fetched'}` : 'Not installed';
    } else {
      status = isInstalled ? 'Available (not in active set)' : 'Not installed';
    }

    rows.push({
      // R1-1: both identities travel together. `agentId` is what the spawn gate
      // matches on; `agent` is the display name. Emitting only the display name is
      // what made every real spawn fail with `agent-unavailable`.
      agentId: id,
      agent: DISPLAY_NAMES[id] ?? id,
      version: probe?.version ?? (id === 'workbuddy-cn' ? '2.137.1' : 'unknown'),
      installed: isInstalled === undefined ? 'Unknown' : isInstalled ? 'Yes' : 'No',
      login,
      quotaSource: sourceLabel,
      usage,
      status,
    });
  }
  // Stable display order: active set first, then the rest.
  const order = (id: string): number => {
    const i = (ACTIVE_AGENT_IDS as readonly string[]).indexOf(id);
    if (i !== -1) return i;
    return id === 'cline' ? 100 : 50;
  };
  return rows.sort((a, b) => order(keyOf(a.agent)) - order(keyOf(b.agent)));
}

function keyOf(display: string): string {
  for (const [id, name] of Object.entries(DISPLAY_NAMES)) if (name === display) return id;
  return display;
}

function toModelRow(e: ModelEntry) {
  return {
    agent: DISPLAY_NAMES[e.agentId] ?? e.agentId,
    model: e.modelId,
    capability: e.taskTypes.join(' · ') || 'none',
    availability: e.availability,
    policy: e.policyStatus,
    quotaSource: `${e.quotaSource} · model: ${e.modelSource}`,
    reason: e.policyReason,
  };
}

function toQuotaRow(r: QuotaRecord) {
  return {
    agent: DISPLAY_NAMES[r.agentId] ?? r.agentId,
    provider: r.provider,
    model: r.modelId ?? '(agent-level)',
    period: r.period,
    used: formatUsage(r.usage),
    remaining: formatRemaining(r.remaining, r.status),
    reset: formatReset(r.resetAt),
    source: r.source,
    observedAt: new Date(r.observedAt).toISOString(),
    confidence: r.confidence,
    status: r.status,
  };
}

// ---- formatting ----------------------------------------------------------

function short(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function formatUsage(u: UsageSnapshot | null): string {
  if (!u) return 'Not Fetched';
  const parts: string[] = [];
  if (u.inputTokens !== undefined) parts.push(`in ${short(u.inputTokens)}`);
  if (u.outputTokens !== undefined) parts.push(`out ${short(u.outputTokens)}`);
  if (u.costUsd !== null && u.costUsd !== undefined) parts.push(`$${u.costUsd.toFixed(2)}`);
  else parts.push('cost unknown');
  if (u.runs !== undefined) parts.push(`${u.runs} runs`);
  return parts.join(' / ');
}

function observedSummary(o: ObservedAgentUsage): string {
  const cost = o.costUsd === null ? 'cost unknown' : `cost $${o.costUsd.toFixed(2)} (${o.costReportingRuns}/${o.runs} runs reported)`;
  return `observed: ${o.runs} runs, in ${short(o.inputTokens)} / out ${short(o.outputTokens)}, ${cost}`;
}

/**
 * Free-MODEL availability verified from `opencode models` on 2026-09-29.
 * These are free models, NOT promotions: no expiry, no region, no claim.
 */
function freeModelSeed(): FreeCreditView['freeModels'] {
  return [
    { modelId: 'opencode/mimo-v2.6-flash-free', agent: 'OpenCode', source: '`opencode models` CLI', observedAt: '2026-09-29' },
    { modelId: 'opencode/space-bunny-free', agent: 'OpenCode', source: '`opencode models` CLI + orchestrator config', observedAt: '2026-09-29' },
    { modelId: 'cline-free/mimo-v2.6-flash', agent: 'Cline', source: 'Cline adapter default (Phase 3 verified)', observedAt: '2026-09-29' },
  ];
}

export { BudgetManager } from './budget.ts';
export { BudgetLedger } from './budget.ts';
export {
  collectAll,
  DEFAULT_PROVIDERS,
  execRunner,
  parseCodexDoctor,
  parseCount,
  parseMoney,
  parseOpenCodeCredentialCount,
  parseOpenCodeStats,
  stripAnsi,
  CodexQuotaProvider,
  OpenCodeQuotaProvider,
  StaticQuotaProvider,
} from './collector.ts';
export type { CmdRunner, QuotaProbe, QuotaProvider, RunOutcome } from './collector.ts';
// R1-0: the Execution Round needs the SAME probed facts `buildQuotaCenter` uses, but as
// the raw `QuotaRecord[]` / `ModelRegistry` the spawn gate consumes — the centre view is
// formatted for a dashboard and loses the shape. Re-exported rather than reimplemented so
// a round and `orchestrator quota` can never disagree about what was observed.
export { seedRegistry };
export { collectObservedUsage } from './observed.ts';
export { evaluatePolicy } from './policy.ts';
export { ModelRegistry, modelKey } from './registry.ts';
export { evaluateSpawnGate } from './spawn-gate.ts';
export * from './types.ts';
