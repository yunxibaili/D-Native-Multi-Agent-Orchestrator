/**
 * quota/spawn-gate.ts — may an agent be spawned for this task?
 *
 * Answers allowed / denied / reason ONLY. It never spawns anything itself and
 * it never mutates the budget: callers reserve first (budget ledger), then ask
 * the gate, then act. Phase 4 ships the gate as a pure decision function so
 * Phase 5B's orchestrator can call the exact same code path.
 *
 * WHAT IS FAIL-CLOSED HERE, AND WHY `unavailable` IS NOT
 * ---------------------------------------------------
 * A quota the gate could not READ denies: `unknown` (the read failed or produced
 * garbage), `not_fetched` (never queried) and `not_connected` (no credentials, so
 * no quota can exist). Those are missing facts, and a gate about to spend must not
 * invent them.
 *
 * `unavailable` is NOT a missing fact. Its own definition in `types.ts` is
 * "Source exists but exposes no quota endpoint (our four agents today)", and
 * `PHASE4_QUOTA_AUDIT.md` (2026-09-29) verified that all four official agents
 * report usage and login but never remaining/reset. So `unavailable` is a
 * CONFIRMED statement about the provider's shape, and every one of them produces
 * it — which meant the gate denied every spawn forever, on a fact that was true.
 *
 * Treating it as blocking also protected nothing real: the budget this gate reads
 * is the ORCHESTRATION budget, explicitly not provider billing, so there was no
 * provider headroom here to guess at in the first place.
 *
 * R1-1 therefore dropped `unavailable` from the blocking set. The honest fact is
 * PRESERVED, not rewritten: `status` stays `unavailable` and `remaining` stays
 * `null`. Nothing is upgraded to `available` and no remaining is invented. Every
 * other signal — capability, agent availability, model availability, budget,
 * concurrency, and known exhaustion — still decides exactly as before.
 */

import type { GateDenyCode, SpawnGateInput, SpawnGateResult } from './types.ts';

const QUOTA_BLOCKING: ReadonlySet<string> = new Set([
  // `unavailable` is deliberately absent: see the header. It means "this provider
  // has no quota endpoint", which is a confirmed fact, not a missing one.
  'unknown',
  'not_fetched',
  'not_connected',
]);

export function evaluateSpawnGate(input: SpawnGateInput): SpawnGateResult {
  const deny = (code: GateDenyCode, reason: string): SpawnGateResult => ({ allowed: false, code, reason });

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
