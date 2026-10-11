/**
 * tests/model-pool.test.ts - P6-F: free model pool / availability guard.
 *
 * The pool turns `docs/PHASE6A_FREE_MODEL_POOL.md` from prose into code. These
 * tests assert the properties that make it a SAFETY mechanism rather than a list:
 *
 *   1. a model inside the ACTIVE pool is allowed
 *   2. a model outside it is rejected
 *   3. an unknown model is rejected
 *   4. a provider/model identity mismatch is rejected, and distinguishable
 *   5. the whole thing is fail-closed (no default, no wildcard, no fallback)
 *   6. the EXISTING spawn gate still runs and still wins
 *   7. quota semantics are untouched by the pool
 *   8. existing modelId / adapter behaviour is unchanged
 *
 * Nothing here spawns an agent, touches git, or contacts a network: the pool is a
 * pure lookup, and that is exactly what is under test.
 *
 * Run: node tests/model-pool.test.ts
 */

import { ModelRegistry } from '../src/quota/registry.ts';
import { BudgetManager } from '../src/quota/budget.ts';
import {
  ACTIVE_FREE_MODEL_POOL,
  DEFAULT_REVIEWER,
  EXCLUDED_FROM_FREE_POOL,
  isAllowedModel,
  isInFreeModelPool,
  intersectWithFreePool,
  listFreeModelPool,
} from '../src/orchestration/model-pool.ts';
import {
  buildSpawnGateInput,
  resolveFreeModelPoolAdmission,
  resolveModelAvailability,
  MODEL_POOL_ERROR_CODES,
} from '../src/orchestration/index.ts';
import type { QuotaRecord, TaskType } from '../src/quota/types.ts';
import type { AgentDescriptor, RunHandle, RunRequest, RunResult } from '../src/core/types.ts';
import { Orchestrator } from '../src/orchestration/orchestrator.ts';
import type { RuntimeRunner } from '../src/orchestration/execute.ts';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` -${detail}` : ''}`);
    process.stdout.write(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}\n`);
  }
}

const SB = 'opencode/space-bunny-free';
const MIMO = 'opencode/mimo-v2.6-flash-free';
const HY3 = 'hy3';

process.stdout.write('\n== P6-F 1. the pool matches the frozen document ==\n');
check('pool has exactly the 3 ACTIVE execution entries', ACTIVE_FREE_MODEL_POOL.length === 3, `got ${ACTIVE_FREE_MODEL_POOL.length}`);
check('space bunny is in the pool for opencode',
  ACTIVE_FREE_MODEL_POOL.some((e) => e.agentId === 'opencode' && e.modelId === SB));
check('mimo v2.6 flash is in the pool for opencode',
  ACTIVE_FREE_MODEL_POOL.some((e) => e.agentId === 'opencode' && e.modelId === MIMO));
check('hy3 is in the pool for workbuddy-intl',
  ACTIVE_FREE_MODEL_POOL.some((e) => e.agentId === 'workbuddy-intl' && e.modelId === HY3));
check('every entry carries its evidence', ACTIVE_FREE_MODEL_POOL.every((e) => e.evidence.length > 0));
check('the default reviewer is codex and is NOT an execution entry',
  DEFAULT_REVIEWER.agentId === 'codex' && !ACTIVE_FREE_MODEL_POOL.some((e) => e.agentId === 'codex'));
check('the pool cannot be mutated by a caller (frozen)', Object.isFrozen(ACTIVE_FREE_MODEL_POOL) && Object.isFrozen(ACTIVE_FREE_MODEL_POOL[0]));
check('listFreeModelPool returns the same source of truth', listFreeModelPool() === ACTIVE_FREE_MODEL_POOL);
check('the excluded table records the non-existent v4 model',
  EXCLUDED_FROM_FREE_POOL.some((e) => e.modelId === 'opencode/mimo-v4-flash-free'));
check('the excluded table records the unauthenticated CN build',
  EXCLUDED_FROM_FREE_POOL.some((e) => e.agentId === 'workbuddy-cn'));

process.stdout.write('\n== P6-F 2. inside the pool -> allowed ==\n');
for (const [agentId, modelId] of [['opencode', SB], ['opencode', MIMO], ['workbuddy-intl', HY3]] as const) {
  const v = isAllowedModel({ agentId, modelId });
  check(`${agentId} + ${modelId} is allowed`, v.allowed === true, v.allowed ? '' : JSON.stringify(v));
  check(`${agentId} + ${modelId} short predicate agrees`, isInFreeModelPool({ agentId, modelId }) === true);
}

process.stdout.write('\n== P6-F 3. outside the pool -> rejected ==\n');
{
  const v = isAllowedModel({ agentId: 'opencode', modelId: 'opencode/gpt-5' });
  if (v.allowed) {
    check('a paid opencode model is rejected', false, 'it was ALLOWED');
  } else {
    const detail = v.detail;
    check('a paid opencode model is rejected', true);
    check('the rejection reason is "not-in-pool"', v.reason === 'not-in-pool', v.reason);
    check('the rejection names the pool contents', detail.includes('pool ='), detail.slice(0, 90));
  }
}
check('the non-existent mimo v4 is rejected',
  isAllowedModel({ agentId: 'opencode', modelId: 'opencode/mimo-v4-flash-free' }).allowed === false);
check('opencode-go/* models are rejected',
  isAllowedModel({ agentId: 'opencode', modelId: 'opencode-go/glm-5.3' }).allowed === false);
check('a codex model is not an execution pool entry',
  isAllowedModel({ agentId: 'codex', modelId: 'gpt-5' }).allowed === false);

process.stdout.write('\n== P6-F 4. unknown / empty selection -> rejected (fail-closed) ==\n');
for (const bad of [null, undefined, ''] as const) {
  const v = isAllowedModel({ agentId: 'opencode', modelId: bad });
  check(`an empty model id (${String(bad)}) is refused, not treated as a wildcard`, v.allowed === false);
}
check('an unknown agent is refused', isAllowedModel({ agentId: 'not-an-agent', modelId: SB }).allowed === false);
check('a pool model under an unknown agent is refused',
  isAllowedModel({ agentId: 'not-an-agent', modelId: SB }).allowed === false);

process.stdout.write('\n== P6-F 5. provider/model identity mismatch -> rejected & distinguishable ==\n');
{
  // hy3 is a pool model, but only for workbuddy-intl.
  const wrongAgent = isAllowedModel({ agentId: 'workbuddy-cn', modelId: HY3 });
  const crossProvider = isAllowedModel({ agentId: 'workbuddy-intl', modelId: SB });
  const plainlyOutside = isAllowedModel({ agentId: 'opencode', modelId: 'opencode/gpt-5' });
  check('hy3 under workbuddy-cn is refused', wrongAgent.allowed === false);
  check('an opencode model id under workbuddy-intl is refused', crossProvider.allowed === false);
  if (!wrongAgent.allowed && !crossProvider.allowed && !plainlyOutside.allowed) {
    check('hy3 under workbuddy-cn is an IDENTITY MISMATCH, not a generic miss', wrongAgent.reason === 'identity-mismatch', wrongAgent.reason);
    check('the mismatch detail names the owning agent', wrongAgent.detail.includes('workbuddy-intl'), wrongAgent.detail.slice(0, 100));
    check('cross-provider reuse is also an identity mismatch', crossProvider.reason === 'identity-mismatch', crossProvider.reason);
    check('mismatch and not-in-pool are distinguishable outcomes',
      wrongAgent.reason === 'identity-mismatch' && plainlyOutside.reason === 'not-in-pool',
      `${wrongAgent.reason} vs ${plainlyOutside.reason}`);
  } else {
    check('identity-mismatch outcomes are reachable', false, 'one of them was allowed');
  }
}

process.stdout.write('\n== P6-F 6. the intersection used by assignment ==\n');
{
  const candidates = [
    { agentId: 'opencode', modelId: SB },
    { agentId: 'opencode', modelId: 'opencode/gpt-5' },
    { agentId: 'workbuddy-intl', modelId: HY3 },
    { agentId: 'workbuddy-cn', modelId: HY3 },
    { agentId: 'opencode', modelId: 'opencode/mimo-v4-flash-free' },
  ];
  const kept = intersectWithFreePool(candidates);
  check('only pool members survive the intersection', kept.length === 2, `kept ${kept.length}`);
  check('the survivors are exactly the two valid pairs',
    kept.length === 2 && kept[0].modelId === SB && kept[1].modelId === HY3, kept.map((k) => `${k.agentId}/${k.modelId}`).join(', '));
  check('the intersection invents no candidates', kept.every((k) => candidates.includes(k)));
  check('an empty candidate list yields an empty result', intersectWithFreePool([]).length === 0);
  check('a list of only bad candidates yields an empty result, not a fallback',
    intersectWithFreePool([{ agentId: 'opencode', modelId: 'gpt-5' }]).length === 0);
  check('the input array is not mutated', candidates.length === 5);
}

// ---- gate wiring -----------------------------------------------------------
const NOW = Date.parse('2026-01-01T00:00:00Z');
const descriptor = (id: string): AgentDescriptor => ({
  id, displayName: id, launcher: { command: 'x', args: [], shell: false } as never,
  transport: 'cli-jsonl',
  capabilities: { newTask: true, resume: true, review: false, modelSelection: true, roleSelection: true, sandbox: false, streamEvents: true, costReporting: false, extraArgs: true, cwd: true, skills: false, steering: false, worktree: false, fork: false, stdinPrompt: false, workspaceModes: ['shared'] } as AgentDescriptor['capabilities'],
});

/**
 * Build a registry the way the sealed API actually allows.
 *
 * TeamRun T1-a: availability now has two setters. `setAgentAvailability(agentId, …)`
 * records a FAMILY fact and `setModelAvailability(agentId, modelId, …)` records one
 * PAIR's fact. This helper still declares availability per agent because that is what
 * these scenarios mean (a whole agent installed or not) — but a scenario that needs a
 * single model to differ can now say so directly instead of building a second registry
 * to work around a missing setter.
 */
function registryWith(
  models: Array<{ agentId: string; modelId: string; taskTypes: TaskType[] }>,
  agentAvailability: Record<string, 'available' | 'unknown' | 'unavailable'>,
): ModelRegistry {
  const reg = new ModelRegistry();
  for (const m of models) {
    reg.upsert({ agentId: m.agentId, modelId: m.modelId, provider: 'test', taskTypes: m.taskTypes, modelSource: 'test', quotaSource: 'test' }, NOW);
  }
  for (const [agentId, availability] of Object.entries(agentAvailability)) {
    reg.setAgentAvailability(agentId, availability);
  }
  return reg;
}

const quotaRow = (agentId: string, status: QuotaRecord['status']): QuotaRecord => ({
  provider: agentId, agentId, modelId: null, source: 'locally_observed', usage: null, remaining: null,
  resetAt: null, period: 'day', status, usageClass: 'observed', confidence: 'high', observedAt: NOW, note: '',
});

function gateSources(over: Record<string, unknown> = {}) {
  const budgets = new BudgetManager(100_000);
  budgets.task('t1', 10_000);
  budgets.agent('opencode', 10_000);
  budgets.agent('workbuddy-intl', 10_000);
  const impl: TaskType = 'implementation';
  return {
    descriptors: [descriptor('opencode'), descriptor('workbuddy-intl')],
    agentStatus: [{ agent: 'opencode', version: '1', installed: 'Yes', login: 'n', quotaSource: 't', usage: 'n', status: 'ok' } as never],
    quotaRecords: [quotaRow('opencode', 'available'), quotaRow('workbuddy-intl', 'available')],
    registry: registryWith(
      [
        { agentId: 'opencode', modelId: SB, taskTypes: [impl] },
        { agentId: 'opencode', modelId: 'opencode/gpt-5', taskTypes: [impl] },
        { agentId: 'workbuddy-intl', modelId: HY3, taskTypes: [impl] },
      ],
      { opencode: 'available', 'workbuddy-intl': 'available' },
    ),
    budgets,
    taskType: impl,
    requestedUnits: 100,
    currentConcurrency: 0,
    maxConcurrency: 2,
    maxChildren: 4,
    maxConcurrentAgents: 2,
    ...over,
  };
}

const build = (agentId: string, modelId: string | null, over: Record<string, unknown> = {}) =>
  buildSpawnGateInput({ taskId: 't1', agentId, modelId, sources: gateSources(over) as never });

process.stdout.write('\n== P6-F 7. the pool resolver alone ==\n');
{
  const okRes = resolveFreeModelPoolAdmission({ agentId: 'opencode', modelId: SB });
  check('a pool model resolves ok', okRes.ok === true);
  const bad = resolveFreeModelPoolAdmission({ agentId: 'opencode', modelId: 'opencode/gpt-5' });
  check('a non-pool model is a MISSING signal (not merely false)', bad.ok === false);
  check('its code is model-not-in-free-pool', bad.ok === false && bad.missing.code === 'model-not-in-free-pool', bad.ok ? '' : bad.missing.code);
  const mism = resolveFreeModelPoolAdmission({ agentId: 'workbuddy-cn', modelId: HY3 });
  check('an identity mismatch has its OWN code', mism.ok === false && mism.missing.code === 'model-free-pool-identity-mismatch', mism.ok ? '' : mism.missing.code);
  check('both pool codes are declared', MODEL_POOL_ERROR_CODES.includes('model-not-in-free-pool') && MODEL_POOL_ERROR_CODES.includes('model-free-pool-identity-mismatch'));
  check('the resolver reads no registry - same answer with none supplied', resolveFreeModelPoolAdmission({ agentId: 'opencode', modelId: 'gpt-5' }).ok === false);
}

process.stdout.write('\n== P6-F 8. availability-unknown stays distinguishable from not-in-pool ==\n');
{
  // An availability the gate cannot confirm is RESOLVED to false, not "missing".
  // That distinction is exactly what keeps the two refusals tellable apart.
  const impl: TaskType = 'implementation';
  const unknownReg = registryWith([{ agentId: 'opencode', modelId: SB, taskTypes: [impl] }], { opencode: 'unknown' });
  const avail = resolveModelAvailability({ registry: unknownReg, agentId: 'opencode', modelId: SB });
  check('an availability-unknown model resolves to NOT available', avail.ok === true && avail.value === false, JSON.stringify(avail));
  check('availability-unknown emits NO missing code (it resolved rather than being unresolvable)',
    avail.ok === true && !('missing' in avail), JSON.stringify(avail));
  const poolOnly = resolveFreeModelPoolAdmission({ agentId: 'opencode', modelId: 'opencode/gpt-5' });
  check('not-in-pool DOES emit a missing code', poolOnly.ok === false && poolOnly.missing.code === 'model-not-in-free-pool');
  check('so the two are distinguishable by code presence',
    avail.ok === true && poolOnly.ok === false);
}

process.stdout.write('\n== P6-F 9. opt-in enforcement through the real gate ==\n');
{
  const allowed = build('opencode', SB, { enforceFreeModelPool: true });
  check('pool model + enforcement ON -> allowed', allowed.result.allowed === true,
    `${allowed.result.code ?? ''} ${allowed.result.reason.slice(0, 80)}`);
  check('the pool was actually consulted', allowed.provenance.some((p) => p.includes('freeModelPoolAllows=true')));

  const denied = build('opencode', 'opencode/gpt-5', { enforceFreeModelPool: true });
  check('non-pool model + enforcement ON -> DENIED (fail-closed)', denied.result.allowed === false);
  check('the denial names the pool rule', denied.missing.some((m) => m.code === 'model-not-in-free-pool'),
    denied.missing.map((m) => m.code).join(','));
  check('the gate input marks the model unavailable', denied.input.modelAvailable === false);

  const empty = build('opencode', null, { enforceFreeModelPool: true });
  check('an empty model id + enforcement ON -> DENIED', empty.result.allowed === false);
  check('the empty selection is attributed to the pool', empty.missing.some((m) => m.code === 'model-not-in-free-pool'));

  const mismatch = build('workbuddy-intl', SB, { enforceFreeModelPool: true });
  check('cross-provider pair + enforcement ON -> DENIED', mismatch.result.allowed === false);
  check('it is attributed to identity mismatch', mismatch.missing.some((m) => m.code === 'model-free-pool-identity-mismatch'),
    mismatch.missing.map((m) => m.code).join(','));
}

process.stdout.write('\n== P6-F 10. enforcement is OFF by default (existing behaviour preserved) ==\n');
{
  const legacy = build('opencode', 'opencode/gpt-5');
  check('a non-pool model is still allowed when enforcement is OFF', legacy.result.allowed === true,
    `${legacy.result.code ?? ''} ${legacy.result.reason.slice(0, 80)}`);
  check('provenance says the pool was consulted but not enforced',
    legacy.provenance.some((p) => p.includes('NOT enforced')), legacy.provenance.join(' | ').slice(-120));
  check('no pool missing code appears when OFF', !legacy.missing.some((m) => m.code.includes('free-pool')));
}

process.stdout.write('\n== P6-F 11. the existing gate still runs and still wins ==\n');
{
    // R1-1: the pool still runs and still wins. `unavailable` quota no longer denies
    // (it means "no quota endpoint", a fact), so this case now demonstrates that the
    // honest status is PRESERVED and reported rather than escalated or hidden.
    const quotaUnreadable = build('opencode', SB, { enforceFreeModelPool: true, quotaRecords: [quotaRow('opencode', 'unavailable')] });
    check('pool allows and an endpoint-less quota no longer denies on its own',
      quotaUnreadable.result.allowed === true, `${quotaUnreadable.result.code} :: ${quotaUnreadable.result.reason.slice(0, 70)}`);
    check('the gate input still carries the honest quota status', quotaUnreadable.input.quota.status === 'unavailable', quotaUnreadable.input.quota.status);
    check('no pool code is blamed', !quotaUnreadable.missing.some((m) => m.code.includes('free-pool')));

    // A quota that is genuinely MISSING still denies, and the pool cannot rescue it.
    const quotaMissing = build('opencode', SB, { enforceFreeModelPool: true, quotaRecords: [quotaRow('opencode', 'not_fetched')] });
    check('pool allows but a genuinely unreadable quota still denies', quotaMissing.result.allowed === false);
    check('the denial is the quota rule, not the pool',
      quotaMissing.result.code === 'quota-unavailable',
      `${quotaMissing.result.code} :: ${quotaMissing.result.reason.slice(0, 70)}`);

    // Pool allows, but the task policy denies (R1-1: the multi-agent switch is gone).
    const off = build('opencode', SB, { enforceFreeModelPool: true, taskPolicyAllows: false });
    check('pool allows but a denying task policy still denies', off.result.allowed === false);

  // Pool allows, but the agent binary is not installed.
  const notInstalled = build('opencode', SB, {
    enforceFreeModelPool: true,
    agentStatus: [{ agent: 'opencode', version: '1', installed: 'No', login: 'n', quotaSource: 't', usage: 'n', status: 'ko' } as never],
  });
  check('pool allows but an uninstalled agent still denies', notInstalled.result.allowed === false);

  // Pool allows, but the budget is exhausted.
  const budgets = new BudgetManager(10_000);
  budgets.task('t1', 10_000);
  budgets.agent('opencode', 10_000);
  const drain = budgets.agent('opencode');
  drain.reserve('d', drain.remaining());
  drain.consume('d');
  const noBudget = build('opencode', SB, { enforceFreeModelPool: true, budgets });
  check('pool allows but an exhausted budget still denies', noBudget.result.allowed === false);
  check('the budget denial is attributed to budget',
    noBudget.result.allowed === false && /budget/i.test(`${noBudget.result.code} ${noBudget.result.reason}`),
    `${noBudget.result.code} :: ${noBudget.result.reason.slice(0, 70)}`);
  check('no pool code is blamed for the budget refusal', !noBudget.missing.some((m) => m.code.includes('free-pool')));

  // An unregistered model is denied by the REGISTRY rule, not the pool rule.
  const unregistered = build('opencode', 'opencode/never-heard-of-it', { enforceFreeModelPool: true });
  check('an unregistered model is denied', unregistered.result.allowed === false);
  check('a model that is both unregistered AND off-pool reports both reasons',
    unregistered.missing.some((m) => m.code === 'model-not-registered') && unregistered.missing.some((m) => m.code === 'model-not-in-free-pool'),
    unregistered.missing.map((m) => m.code).join(','));
}

process.stdout.write('\n== P6-F 12. the pool does not mutate quota state ==\n');
{
  const impl: TaskType = 'implementation';
  const reg = registryWith([{ agentId: 'opencode', modelId: SB, taskTypes: [impl] }], { opencode: 'available' });
  const before = JSON.stringify(reg.list());
  isAllowedModel({ agentId: 'opencode', modelId: SB });
  isAllowedModel({ agentId: 'opencode', modelId: 'opencode/gpt-5' });
  isAllowedModel({ agentId: 'workbuddy-cn', modelId: HY3 });
  check('the registry is unchanged by pool queries', JSON.stringify(reg.list()) === before);

  const budgets = new BudgetManager(1000);
  budgets.agent('opencode', 1000);
  const snapshot = JSON.stringify(budgets.snapshotAll());
  intersectWithFreePool([{ agentId: 'opencode', modelId: SB }]);
  check('the budget ledger is unchanged by an intersection', JSON.stringify(budgets.snapshotAll()) === snapshot);
}

process.stdout.write('\n== P6-F 13. modelId plumbing is untouched ==\n');
{
  // The pool is consulted with the SAME (agentId, modelId) pair the gate already
  // used, so `buildRunRequest` forwarding and adapter argv are unaffected: nothing
  // in this module rewrites, defaults or normalises a model id.
  check('the pool never returns a different modelId than it was given',
    ACTIVE_FREE_MODEL_POOL.every((e) => isAllowedModel({ agentId: e.agentId, modelId: e.modelId }).allowed &&
      (isAllowedModel({ agentId: e.agentId, modelId: e.modelId }) as { entry?: { modelId: string } }).entry?.modelId === e.modelId));
  check('an allowed verdict carries the pool entry (evidence travels with it)',
    (isAllowedModel({ agentId: 'workbuddy-intl', modelId: HY3 }) as { entry?: { evidence: string } }).entry?.evidence === 'zero-at-call-time');
}

// =====================================================================
// P6-F 14. THE REAL CALL CHAIN: spawnChild -> executeTask
//
// Sections 1-13 test the pool and the pure gate in isolation. Codex's review
// flagged the one thing they cannot reach: `Orchestrator` builds its own
// `sources` object TWICE - once in `spawnChild` (orchestrator.ts:386) and once
// in `executeTask` (orchestrator.ts:601). Both spread `...this.gate` and then
// OVERRIDE several fields. If `enforceFreeModelPool` were ever dropped from
// either spread, or from the execute-time sources object, the pool guard would
// silently stop applying where money is actually spent - and every unit test
// above would still pass, because they call `buildSpawnGateInput` directly.
//
// So this section drives the REAL classes. Nothing is stubbed between the
// orchestrator and the gate: `spawnChild` and `executeTask` each construct the
// sources themselves and call the same `buildSpawnGateInput` production uses.
// Only the agent process is faked, because the point is the gate, not the agent.
// =====================================================================
process.stdout.write('\n== P6-F 14. spawnChild -> executeTask: enforcement survives the real call chain ==\n');
{
  const AGENT = 'opencode';

  /**
   * Gate sources for the real orchestrator: every signal the pre-existing gate
   * needs is healthy, so a refusal can ONLY be the pool's doing. That is the
   * whole trick - if the fixture were incomplete, a pool test would "pass" for
   * the wrong reason.
   */
  const chainSources = (taskIds: readonly string[], over: Record<string, unknown> = {}) => {
    const budgets = new BudgetManager(100_000);
    for (const t of taskIds) budgets.task(t, 10_000);
    budgets.agent(AGENT, 10_000);
    const impl: TaskType = 'implementation';
    return {
      descriptors: [descriptor(AGENT)],
      agentStatus: [{ agent: AGENT, version: '1', installed: 'Yes', login: 'n', quotaSource: 't', usage: 'n', status: 'ok' } as never],
      quotaRecords: [quotaRow(AGENT, 'available')],
      registry: registryWith(
        [
          { agentId: AGENT, modelId: SB, taskTypes: [impl] },
          { agentId: AGENT, modelId: 'opencode/gpt-5', taskTypes: [impl] },
        ],
        { [AGENT]: 'available' },
      ),
      budgets,
      taskType: impl,
      requestedUnits: 100,
      currentConcurrency: 0,
      maxConcurrency: 4,
      maxChildren: 8,
      maxConcurrentAgents: 4,
      ...over,
    } as never;
  };

  /** A runtime that records requests and returns a canned successful result. */
  const recordingRuntime = (): { runtime: RuntimeRunner; requests: RunRequest[] } => {
    const requests: RunRequest[] = [];
    return {
      requests,
      runtime: {
        run(req: RunRequest): RunHandle {
          requests.push(req);
          const result: RunResult = {
            taskId: 'rt-1', agentId: req.agentId, state: 'succeeded', error: null,
            frames: [], startedAt: 0, finishedAt: 1, usage: null, threadId: null,
          } as unknown as RunResult;
          return {
            result: async () => result,
            cancel: async () => {},
            dispose: async () => {},
          } as unknown as RunHandle;
        },
      },
    };
  };

  const dir = mkdtempSync(join(tmpdir(), 'p6f-chain-'));

  // --- A. a POOL model: spawn AND execute both admit, and the flag was live at
  //        execute time (provenance says the pool was ENFORCED, not just read).
  {
    const { runtime, requests } = recordingRuntime();
    const o = new Orchestrator({
      gate: chainSources(['r', 'c-pool'], { enforceFreeModelPool: true }),
      now: () => NOW,
      runtime,
      defaultCwd: dir,
    });
    o.createRoot({ taskId: 'r', agentId: AGENT, taskType: 'implementation', acceptanceCriteria: 'root' });

    const spawned = o.spawnChild({
      taskId: 'c-pool', parentTaskId: 'r', agentId: AGENT, modelId: SB,
      taskType: 'implementation', acceptanceCriteria: 'work', budgetUnits: 10,
    });
    check('spawnChild admits a pool model with enforcement ON', spawned.ok === true,
      spawned.ok ? '' : `${spawned.code} :: ${spawned.reason}`);
    check('the SPAWN gate enforced the pool (provenance, not "NOT enforced")',
      spawned.ok && spawned.gate.provenance.some((p) => p.includes('freeModelPoolAllows=true') && !p.includes('NOT enforced')),
      spawned.ok ? spawned.gate.provenance.filter((p) => p.includes('freeModelPool')).join(' | ') : '');

    const executed = await o.executeTask({ taskId: 'c-pool' });
    check('executeTask admits the same pool model', executed.ok === true,
      executed.ok ? '' : `${executed.code} :: ${executed.reason}`);
    // THE assertion Codex asked for: the execute-time gate is a FRESH decision,
    // and it still had enforcement ON. If executeTask rebuilt sources without the
    // flag, provenance would say "NOT enforced" here.
    // `gate` is optional on the success type, so it is asserted to EXIST here:
    // a successful execute that reported no gate could not be checked at all.
    check('executeTask reports the decision it actually gated on',
      executed.ok && executed.gate !== undefined);
    const execGate = executed.ok ? executed.gate : undefined;
    check('the EXECUTE-time gate enforced the pool (flag not lost on the second build)',
      execGate?.provenance.some((p) => p.includes('freeModelPoolAllows=true') && !p.includes('NOT enforced')) === true,
      execGate ? execGate.provenance.filter((p) => p.includes('freeModelPool')).join(' | ') : 'no gate reported');
    check('the execute-time gate is a real decision, not the spawn one reused',
      execGate !== undefined && spawned.ok && execGate !== spawned.gate);
    check('the pool model actually reached the runtime', requests.length === 1);
    check('the run forwarded the pool model id unchanged', requests[0]?.model === SB, String(requests[0]?.model));
  }

  // --- B. the REFUSAL that matters: spawn a task with the guard OFF, then flip
  //        it ON before executing. This isolates the execute-time gate, because
  //        with the guard ON at spawn time the task would never have been created
  //        and there would be nothing to execute.
  {
    const { runtime, requests } = recordingRuntime();
    const o = new Orchestrator({
      // enforcement absent at spawn: the paid model is admitted, as today.
      gate: chainSources(['r', 'c-paid']),
      now: () => NOW,
      runtime,
      defaultCwd: dir,
    });
    o.createRoot({ taskId: 'r', agentId: AGENT, taskType: 'implementation', acceptanceCriteria: 'root' });
    const spawned = o.spawnChild({
      taskId: 'c-paid', parentTaskId: 'r', agentId: AGENT, modelId: 'opencode/gpt-5',
      taskType: 'implementation', acceptanceCriteria: 'work', budgetUnits: 10,
    });
    check('pre-existing behaviour preserved: a paid model still spawns when the guard is OFF',
      spawned.ok === true, spawned.ok ? '' : `${spawned.code} :: ${spawned.reason}`);

    // P6-B assignment turns the guard on. Done here via the public
    // `updateGateSources` - the same door production would use.
    o.updateGateSources({ enforceFreeModelPool: true });

    const executed = await o.executeTask({ taskId: 'c-paid' });
    check('the EXECUTE-time gate refuses a pool-external model', executed.ok === false,
      executed.ok ? 'it was ALLOWED at execute time' : '');
    check('the refusal is attributed to the pool rule',
      !executed.ok && executed.gate?.missing.some((m) => m.code === 'model-not-in-free-pool') === true,
      !executed.ok ? (executed.gate?.missing ?? []).map((m) => m.code).join(',') : '');
    // The pre-existing gate phrases the reason in its own words ("the target
    // model is not available on this agent") and appends the missing codes. The
    // pool therefore does NOT get to soften or reword that sentence; attribution
    // is carried by the code, which is what keeps the two refusals tellable apart.
    check('the execute-time refusal carries the pool code in its reason',
      !executed.ok && /model-not-in-free-pool/.test(executed.reason),
      !executed.ok ? executed.reason.slice(0, 110) : '');
    check('NOTHING ran - the refusal precedes the runtime', requests.length === 0, `ran ${requests.length} time(s)`);
    check('the task is left retryable (planned), not failed',
      o.getStore().get('c-paid')?.status === 'planned', o.getStore().get('c-paid')?.status);
  }

  // --- C. enforcement is still OFF by default through the real chain, so no
  //        existing paid-model workflow changes behaviour.
  {
    const { runtime, requests } = recordingRuntime();
    const o = new Orchestrator({
      gate: chainSources(['r', 'c-legacy']),
      now: () => NOW,
      runtime,
      defaultCwd: dir,
    });
    o.createRoot({ taskId: 'r', agentId: AGENT, taskType: 'implementation', acceptanceCriteria: 'root' });
    const spawned = o.spawnChild({
      taskId: 'c-legacy', parentTaskId: 'r', agentId: AGENT, modelId: 'opencode/gpt-5',
      taskType: 'implementation', acceptanceCriteria: 'work', budgetUnits: 10,
    });
    const executed = await o.executeTask({ taskId: 'c-legacy' });
    check('with the guard OFF, a paid model spawns AND executes exactly as before',
      spawned.ok === true && executed.ok === true,
      `spawn=${spawned.ok} execute=${executed.ok}`);
    check('and it really ran', requests.length === 1);
  }

  // --- D. no second guard and no bypass: enforcement cannot be turned off by
  //        removing the flag from the sources, because `false`/absent both mean
  //        "not enforced" - there is exactly one switch, and one place that reads it.
  {
    const src = chainSources(['r', 'c-bool']) as Record<string, unknown>;
    check('the switch is a single optional boolean on SpawnGateSources',
      Object.keys(src).includes('enforceFreeModelPool') === false); // default sources carry no flag at all
    const { runtime } = recordingRuntime();
    const o = new Orchestrator({ gate: chainSources(['r', 'c-bool']), now: () => NOW, runtime, defaultCwd: dir });
    o.createRoot({ taskId: 'r', agentId: AGENT, taskType: 'implementation', acceptanceCriteria: 'root' });
    o.updateGateSources({ enforceFreeModelPool: false });
    const spawned = o.spawnChild({
      taskId: 'c-bool', parentTaskId: 'r', agentId: AGENT, modelId: 'opencode/gpt-5',
      taskType: 'implementation', acceptanceCriteria: 'work', budgetUnits: 10,
    });
    check('an explicit false means "not enforced" (no second, stricter mode)',
      spawned.ok === true, spawned.ok ? '' : `${spawned.code} :: ${spawned.reason}`);
  }

  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) {
  process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
}
process.stdout.write('\n');
process.exitCode = failed === 0 ? 0 : 1;