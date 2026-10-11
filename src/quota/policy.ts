/**
 * quota/policy.ts — Model Policy: allowed | disabled | unavailable | quota-blocked.
 *
 * Pure function, no I/O, no clock. It answers ONE question — "may this agent
 * be used with this model for this task?" — and always with a reason a human
 * can read. It does NOT choose models (no auto-router in Phase 4) and it does
 * not know about budget; the spawn gate layers budget/concurrency on top.
 *
 * `quota-blocked` fires only on KNOWN exhaustion: a quota that merely cannot
 * be read (`unavailable`) must not paint every model as blocked — that is the
 * spawn gate's fail-closed job at action time, not a standing policy verdict.
 *
 * Evaluation order matters: a disabled entry must not be relitigated by quota,
 * and an unknown model must not inherit a policy from a similarly named one.
 */

import type { ModelRegistry } from './registry.ts';
import type { PolicyDecision, PolicyQuery, QuotaStatus } from './types.ts';

/** Quota states that block a STANDING policy: only known exhaustion. */
const QUOTA_BLOCKING: ReadonlySet<QuotaStatus> = new Set<QuotaStatus>(['exhausted']);

export function evaluatePolicy(registry: ModelRegistry, query: PolicyQuery): PolicyDecision {
  const { agentId, modelId } = query;
  const base = { agentId, modelId };

  const entry = registry.get(agentId, modelId);
  if (!entry) {
    return {
      ...base,
      decision: 'unavailable',
      reason: `model "${modelId}" is not registered for agent "${agentId}"`,
    };
  }

  if (query.disabled) {
    return { ...base, decision: 'disabled', reason: `agent "${agentId}" is disabled by policy` };
  }

  if (query.agentAvailable === false) {
    return { ...base, decision: 'unavailable', reason: `agent "${agentId}" binary is not available` };
  }

// TeamRun T1-a: availability is judged per PAIR, from the effective verdict. Reading the
  // raw entry field here would miss a family block recorded in the registry rather than
  // passed in the query, and would keep judging a pair on a fact recorded for its siblings.
  if (registry.effectiveAvailability(agentId, modelId) === 'unavailable') {
    return { ...base, decision: 'unavailable', reason: `model "${modelId}" is unavailable on "${agentId}"` }
  }

  if (query.taskType && !entry.taskTypes.includes(query.taskType)) {
    return {
      ...base,
      decision: 'disabled',
      reason: `task type "${query.taskType}" not allowed for ${agentId}/${modelId} (allowed: ${entry.taskTypes.join(', ') || 'none'})`,
    };
  }

  const quota = query.quotaStatus;
  if (quota !== undefined && QUOTA_BLOCKING.has(quota)) {
    return {
      ...base,
      decision: 'quota-blocked',
      reason: `quota exhausted for "${agentId}"`,
    };
  }

  return { ...base, decision: 'allowed', reason: `${agentId}/${modelId} satisfies capability + quota policy` };
}
