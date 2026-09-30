/**
 * quota/registry.ts — the Model Registry.
 *
 * Agent ≠ Model. The registry keys every entry on the (agentId, modelId) PAIR,
 * so `deepseek-v4.1-flash` behind Codex and the same id behind WorkBuddy are
 * two rows that can carry different availability, quota source and policy.
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

  /** Apply availability to every entry of one agent (from a probe result). */
  setAvailability(agentId: string, availability: ModelEntry['availability']): void {
    for (const e of this.entries.values()) {
      if (e.agentId === agentId) e.availability = availability;
    }
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
