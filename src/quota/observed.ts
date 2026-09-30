/**
 * quota/observed.ts — usage WE counted, from OUR store.
 *
 * This is the `locally_observed` class: every number here corresponds to a
 * subprocess this orchestrator actually ran. It is not a provider figure and
 * must never be presented as one.
 *
 * The cost trap, handled explicitly: `RunResult.usage.costUsd` is optional.
 * Summing undefined as 0 would fabricate "$0.00 spent" for agents that simply
 * do not report cost (Codex reports tokens only; WorkBuddy's figure is known
 * unreliable). So cost stays `null` until at least one run reported it, and
 * `costReportingRuns` says how many did.
 */

import type { RunResult } from '../core/types.ts';
import type { SessionStore } from '../runtime/store.ts';
import type { ObservedAgentUsage } from './types.ts';

interface Accumulator {
  runs: number;
  succeeded: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costSum: number;
  costReportingRuns: number;
  lastObservedAt: number;
}

/**
 * Aggregate observed usage per agent over the most recent `limit` tasks.
 * Cost is null unless at least one run reported it.
 */
export function collectObservedUsage(store: SessionStore, limit = 500): ObservedAgentUsage[] {
  const byAgent = new Map<string, Accumulator>();

  for (const summary of store.listTasks(limit)) {
    const task = store.getTask(summary.taskId);
    if (!task) continue;
    addTask(byAgent, task);
  }

  return [...byAgent.entries()]
    .map(([agentId, acc]) => ({
      agentId,
      runs: acc.runs,
      succeeded: acc.succeeded,
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      cachedInputTokens: acc.cachedInputTokens,
      costUsd: acc.costReportingRuns > 0 ? round4(acc.costSum) : null,
      costReportingRuns: acc.costReportingRuns,
      lastObservedAt: acc.lastObservedAt,
      source: 'locally_observed' as const,
    }))
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
}

function addTask(byAgent: Map<string, Accumulator>, task: RunResult): void {
  let acc = byAgent.get(task.agentId);
  if (!acc) {
    acc = {
      runs: 0,
      succeeded: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costSum: 0,
      costReportingRuns: 0,
      lastObservedAt: 0,
    };
    byAgent.set(task.agentId, acc);
  }
  acc.runs++;
  if (task.state === 'succeeded') acc.succeeded++;
  acc.inputTokens += task.usage.inputTokens ?? 0;
  acc.outputTokens += task.usage.outputTokens ?? 0;
  acc.cachedInputTokens += task.usage.cachedInputTokens ?? 0;
  if (task.usage.costUsd !== undefined) {
    acc.costSum += task.usage.costUsd;
    acc.costReportingRuns++;
  }
  acc.lastObservedAt = Math.max(acc.lastObservedAt, task.endedAt);
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
