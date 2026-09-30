/**
 * quota/spawn-gate.ts — may an agent be spawned for this task?
 *
 * Answers allowed / denied / reason ONLY. It never spawns anything itself and
 * it never mutates the budget: callers reserve first (budget ledger), then ask
 * the gate, then act. Phase 4 ships the gate as a pure decision function so
 * Phase 5B's orchestrator can call the exact same code path.
 *
 * Fail-closed by design: Multi-Agent is false until Phase 5B, so the default
 * input denies immediately with `multi-agent-not-implemented`. Quota that
 * cannot be confirmed (`unavailable`/`unknown`/`not_fetched`/`not_connected`)
 * also denies — the standing Model Policy only blocks known exhaustion, but a
 * gate that is ABOUT TO SPEND must not guess headroom it cannot see.
 */

import type { GateDenyCode, SpawnGateInput, SpawnGateResult } from './types.ts';

const QUOTA_BLOCKING: ReadonlySet<string> = new Set([
  'unavailable',
  'unknown',
  'not_fetched',
  'not_connected',
]);

export function evaluateSpawnGate(input: SpawnGateInput): SpawnGateResult {
  const deny = (code: GateDenyCode, reason: string): SpawnGateResult => ({ allowed: false, code, reason });

  if (!input.multiAgentEnabled) {
    return deny(
      'multi-agent-not-implemented',
      'Multi-Agent is research-complete but not implemented (Phase 5A done, 5B waiting on Phase 4); single agent remains the default.',
    );
  }
  if (!input.taskPolicyAllows) {
    return deny('task-policy-denied', 'task policy does not allow spawning for this task');
  }
  if (!input.capabilitySatisfied) {
    return deny('capability-missing', 'no available agent satisfies the required capability');
  }
  if (!input.agentAvailable) {
    return deny('agent-unavailable', 'the target agent is not available (missing binary or failed probe)');
  }
  if (!input.modelAvailable) {
    return deny('model-unavailable', 'the target model is not available on this agent');
  }
  if (input.quota.status === 'exhausted') {
    return deny('quota-exhausted', 'provider quota for this agent is exhausted');
  }
  if (QUOTA_BLOCKING.has(input.quota.status)) {
    return deny(
      'quota-unavailable',
      `quota status is "${input.quota.status}" — headroom cannot be confirmed, refusing to spend blindly`,
    );
  }
  if (input.budget.requested > input.budget.remaining) {
    return deny(
      'budget-insufficient',
      `requested ${input.budget.requested} exceeds remaining orchestration budget ${input.budget.remaining}`,
    );
  }
  if (input.concurrency.current >= input.concurrency.limit) {
    return deny(
      'concurrency-limit',
      `concurrency ${input.concurrency.current}/${input.concurrency.limit} already at limit`,
    );
  }

  return {
    allowed: true,
    code: 'allowed',
    reason: `budget ${input.budget.remaining} ≥ ${input.budget.requested}, quota ${input.quota.status}, agent and model available`,
  };
}
