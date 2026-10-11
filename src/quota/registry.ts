/**
 * quota/registry.ts — the Model Registry.
 *
 * Agent ≠ Model. The registry keys every entry on the (agentId, modelId) PAIR,
 * so `deepseek-v4.1-flash` behind Codex and the same id behind WorkBuddy are
 * two rows that can carry different availability, quota source and policy.
 *
 * TeamRun T1-a adds a SECOND axis above the entries: availability has two scopes,
 * because "the OpenCode CLI is missing" and "that one model did not answer" are
 * different facts with different blast radii.
 *
 *   agent family availability  -> setAgentAvailability(agentId, …)
 *   model pair availability   -> setModelAvailability(agentId, modelId, …)
 *   what governs a pair       -> effectiveAvailability(agentId, modelId)
 *
 * The old `setAvailability(agentId, …)` fanned one verdict across every model of a
 * family, so a single failed model probe disabled all of them. That is gone; there is
 * no ambiguous setter left.
 *
 * Storage is deliberately dumb: entries in, entries out. Policy evaluation
 * lives in policy.ts, collection in collector.ts. The registry answers only
 * "what do we know about this model on this agent, and where did we learn it".
 */

import type { ModelEntry, PolicyState, TaskType } from './types.ts';

export function modelKey(agentId: string, modelId: string): string {
  return `${agentId}::${modelId}`;
}

export interface ModelSeed {
  agentId: string;
  modelId: string;
  provider: string;
  taskTypes: readonly TaskType[];
  /** Where the model id was learned: "config", "codex doctor", "thread store"… */
  modelSource: string;
  quotaSource?: string;
}

export class ModelRegistry {
  private readonly entries = new Map<string, ModelEntry>();

  /** Insert or replace an entry. ObservedAt is stamped by the caller. */
  upsert(seed: ModelSeed, observedAt: number): ModelEntry {
    const key = modelKey(seed.agentId, seed.modelId);
    const existing = this.entries.get(key);
    const entry: ModelEntry = {
      key,
      agentId: seed.agentId,
      modelId: seed.modelId,
      provider: seed.provider,
      taskTypes: [...seed.taskTypes],
      availability: existing?.availability ?? 'unknown',
      quotaSource: seed.quotaSource ?? existing?.quotaSource ?? 'none',
      modelSource: seed.modelSource,
      policyStatus: existing?.policyStatus ?? 'unavailable',
      policyReason: existing?.policyReason ?? 'policy not evaluated yet',
      observedAt,
    };
    this.entries.set(key, entry);
    return entry;
  }

  get(agentId: string, modelId: string): ModelEntry | null {
    return this.entries.get(modelKey(agentId, modelId)) ?? null;
  }

  has(agentId: string, modelId: string): boolean {
    return this.entries.has(modelKey(agentId, modelId));
  }

  list(): ModelEntry[] {
    return [...this.entries.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  forAgent(agentId: string): ModelEntry[] {
    return this.list().filter((e) => e.agentId === agentId);
  }

  /**
   * TeamRun T1-a: Agent Family availability — "is this Native Agent runtime itself
   * usable?" (binary missing, launcher cannot start, adapter unavailable).
   *
   * It is a fact about the FAMILY and deliberately NOT stored on the entries: writing it
   * onto every entry is exactly the bug this replaces, because it destroys the per-pair
   * facts that a single failed model probe produced.
   */
  private readonly agentAvailabilityFacts = new Map<string, ModelEntry['availability']>();
  /**
   * Keys whose availability came from a PAIR-SPECIFIC fact, so a later family fact must
   * not overwrite it. This is what makes "the family came back" stop meaning "and now
   * every model under it is healthy again".
   */
  private readonly pairSpecific = new Set<string>();

  /**
   * TeamRun T1-a: record an AGENT-WIDE fact.
   *
   * Applied to pairs that carry no pair-specific evidence, which is how a family fact has
   * always been observed to behave — but pairs that were explicitly probed keep their own
   * verdict. So `opencode` coming back does not erase "model-a is still broken".
   */
  setAgentAvailability(agentId: string, availability: ModelEntry['availability']): void {
    this.agentAvailabilityFacts.set(agentId, availability);
    for (const e of this.entries.values()) {
      if (e.agentId !== agentId) continue;
      if (this.pairSpecific.has(e.key)) continue;
      e.availability = availability;
    }
  }

  /**
   * TeamRun T1-a: record a fact about ONE (agent, model) pair.
   *
   * A failed probe of `opencode/model-a` must not touch `model-b`. An unregistered model
   * is ignored rather than escalated: "we have never heard of this model" is not evidence
   * about the whole family, and letting it spread is how one bad lookup took out a family.
   */
  setModelAvailability(agentId: string, modelId: string, availability: ModelEntry['availability']): void {
    const key = modelKey(agentId, modelId);
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.pairSpecific.add(key);
    entry.availability = availability;
  }

  /** The agent-family fact, or `undefined` when we have never probed it. */
  agentAvailability(agentId: string): ModelEntry['availability'] | undefined {
    return this.agentAvailabilityFacts.get(agentId);
  }

  /**
   * TeamRun T1-a: the availability that actually governs a pair.
   *
   *   effective(agent, model) = agentFamilyAvailable(agent) AND modelPairAvailable(agent, model)
   *
   * A family that is not `available` blocks the whole family (a missing binary really does
   * mean no model works); a family that is available leaves the pair's own verdict standing,
   * including `unknown`, which stays fail-closed exactly as before.
   *
   * TeamRun T1-c: a MISSING family fact is `unknown`, not an abstention. Before this, a
   * pair probed `available` under a family that had NEVER been probe read as available —
   * the pair's verdict was silently promoted to a family-wide guarantee nobody made. The
   * frozen rule is now: both facts must say `available`, and an absent family fact says
   * `unknown`. Explicit-unknown and missing therefore behave identically (both fail
   * closed); `agentAvailability()` still distinguishes them at the diagnostic layer.
   */
  effectiveAvailability(agentId: string, modelId: string): ModelEntry['availability'] {
    const pair = this.entries.get(modelKey(agentId, modelId))?.availability ?? 'unknown';
    const family = this.agentAvailabilityFacts.get(agentId) ?? 'unknown';
    if (family !== 'available') return family;
    return pair;
  }

  /** The one question callers actually ask. */
  isModelAvailable(agentId: string, modelId: string): boolean {
    return this.effectiveAvailability(agentId, modelId) === 'available';
  }

  /** Record a policy evaluation on its entry. */
  applyPolicy(agentId: string, modelId: string, decision: PolicyState, reason: string): void {
    const e = this.entries.get(modelKey(agentId, modelId));
    if (!e) return;
    e.policyStatus = decision;
    e.policyReason = reason;
  }

  get size(): number {
    return this.entries.size;
  }
}
