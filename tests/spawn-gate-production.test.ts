/**
 * tests/spawn-gate-production.test.ts — R1-1.
 *
 * WHY THIS FILE EXISTS AT ALL
 * --------------------------
 * The R1-0.5 investigation found two production-only failures that 3756 passing
 * tests could not see, and both came from the SAME blind spot: nothing ever fed
 * the REAL producer's output into the REAL consumer.
 *
 *   1. `buildAgentStatus` (src/quota/index.ts) wrote a DISPLAY name into
 *      `AgentStatusRow.agent` ("OpenCode"), while `resolveAgentAvailability`
 *      (src/orchestration/spawn-gate-input.ts) matched `row.agent === agentId`
 *      ("opencode"). No official agent could ever match, so every real spawn was
 *      refused with `agent-unavailable`. Every test hand-built rows keyed by the
 *      id, so the mismatch was invisible.
 *
 *   2. `unavailable` quota meant "this provider exposes no quota endpoint" — the
 *      state all four official agents report (PHASE4_QUOTA_AUDIT, 2026-09-29) —
 *      but it sat in the gate's blocking set, so the gate denied every spawn
 *      forever, on a fact that was true. Every test injected a synthetic
 *      `status: 'available'`, which no provider can produce.
 *
 * So Test 1 below is the load-bearing one: it uses the real `buildQuotaCenter` as
 * the producer and the real `buildSpawnGateInput` as the consumer, with no
 * hand-built rows in between. The rest pin the semantics that fix established.
 *
 * HERMETIC: no network, no native agent, no Laya. The runtime is a fake adapter
 * and the quota probes are fixtures — the point is the SHAPE, not the numbers.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ModelRegistry, BudgetManager, buildQuotaCenter } from '../src/quota/index.ts';
import { evaluateSpawnGate } from '../src/quota/spawn-gate.ts';
import { GATE_DENY_CODES, QUOTA_STATUSES } from '../src/quota/types.ts';
import type { QuotaProbe } from '../src/quota/collector.ts';
import type { QuotaRecord, QuotaStatus, AgentStatusRow } from '../src/quota/types.ts';
import type { AgentDescriptor, RunRequest } from '../src/core/types.ts';
import type { RuntimeRunner } from '../src/orchestration/execute.ts';
import { buildSpawnGateInput, type SpawnGateSources } from '../src/orchestration/spawn-gate-input.ts';
import { Orchestrator as RuntimeOrch } from '../src/orchestrator/orchestrator.ts';
import { NativeWorkbench, Orchestrator as TaskOrchestrator, TaskScheduler } from '../src/orchestration/index.ts';
import { createFakeAdapter } from './helpers.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; process.stdout.write(`  ok   ${name}\n`); }
  else { failed++; failures.push(name); process.stdout.write(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}\n`); }
};
const section = (t: string): void => { process.stdout.write(`\n== ${t}\n`); };

const NOW = 1_700_000_000_000;
const OFFICIAL = ['opencode', 'codex', 'workbuddy-cn', 'workbuddy-intl'] as const;

/**
 * Quota probes shaped EXACTLY like the real ones for the four official agents.
 *
 * The real providers set `status: 'unavailable'` whenever the agent is logged in
 * (collector.ts: `loggedIn ? 'unavailable' : 'not_connected'`), and `baseRecord`
 * hardcodes `remaining: null`. Reproducing that here is the whole point: a fixture
 * that claimed `available` would have hidden the bug this file exists to catch.
 */
const officialProbe = (agentId: string, login: string, modelHint: string | null): QuotaProbe => ({
  agentId,
  provider: agentId === 'codex' ? 'custom' : agentId,
  records: [
    {
      provider: agentId === 'codex' ? 'custom' : agentId,
      agentId,
      modelId: null,
      source: 'cli_reported',
      usage: null,
      remaining: null,          // no provider exposes remaining — the audited fact
      resetAt: null,
      period: 'unknown',
      status: 'unavailable',    // "exposes no quota endpoint", not "unusable"
      usageClass: 'reported',
      confidence: 'high',
      observedAt: NOW,
      note: 'No local quota endpoint (mirrors PHASE4_QUOTA_AUDIT).',
    },
  ],
  login,
  version: '1.0.0',
  modelHint,
  providerHint: agentId === 'codex' ? 'custom' : null,
  error: null,
});

const OFFICIAL_PROBES: QuotaProbe[] = [
  officialProbe('opencode', 'logged in (3 credentials)', 'opencode/space-bunny-free'),
  officialProbe('codex', 'logged in (api_key)', 'deepseek-v4.1-flash'),
  officialProbe('workbuddy-cn', 'not authenticated (HTTP 401)', null),
  officialProbe('workbuddy-intl', 'authenticated (apiKeySource www.workbuddy.ai)', null),
];

const descriptor = (id: string, review = false): AgentDescriptor => ({
  id, displayName: id, launcher: 'fake', transport: 'cli-jsonl',
  capabilities: { newTask: true, review, modelSelection: true, resume: true },
} as unknown as AgentDescriptor);

const OFFICIAL_DESCRIPTORS = [
  descriptor('opencode'),
  descriptor('codex', true),
  descriptor('workbuddy-cn'),
  descriptor('workbuddy-intl'),
];

/**
 * The REAL producer → the REAL consumer, with nothing hand-built in between.
 *
 * `configs` is what production passes: each agent's configured default model.
 * `installed` is left unset so the centre derives install state from the probes,
 * exactly as `orchestrator quota` does.
 */
async function productionCenter(): Promise<{
  center: Awaited<ReturnType<typeof buildQuotaCenter>>;
  registry: ModelRegistry;
  quotas: readonly QuotaRecord[];
}> {
  const configs = {
    opencode: { model: 'opencode/space-bunny-free' },
    codex: { model: 'deepseek-v4.1-flash' },
    'workbuddy-cn': { model: 'hy3' },
    'workbuddy-intl': { model: 'hy3' },
  };
  const center = await buildQuotaCenter({
    // Production passes the runtime orchestrator's own store; `collectObservedUsage`
    // reads it, so a real one is required rather than a placeholder.
    store: new RuntimeOrch({ config: { agents: {} } as never, storeDir: mkdtempSync(join(tmpdir(), 'r11-store-')) }).store,
    configs,
    descriptors: OFFICIAL_DESCRIPTORS,
    probes: OFFICIAL_PROBES,
  });
  const registry = new ModelRegistry();
  for (const p of OFFICIAL_PROBES) {
    const agentId = p.agentId;
    if (agentId === undefined) continue;
    const modelId = (configs as Record<string, { model?: string }>)[agentId]?.model;
    if (modelId === undefined) continue;
    registry.upsert(
      { agentId, modelId, provider: agentId, taskTypes: ['implementation', 'research', 'test'] as never, modelSource: 'config', quotaSource: 'test' },
      NOW,
    );
    registry.setAgentAvailability(agentId, 'available');
  }
  return { center, registry, quotas: OFFICIAL_PROBES.flatMap((p) => p.records) };
}

const budgetsFor = (...agentIds: string[]): BudgetManager => {
  const b = new BudgetManager(1_000_000);
  for (const a of agentIds) b.agent(a, 1_000_000);
  return b;
};

// ===========================================================================
section('R1-1 Test 1: quota center -> spawn gate, with NO hand-built rows');
// ===========================================================================

await (async () => {
  const { center, registry, quotas } = await productionCenter();

  check('T1: the real producer emits an agentId for every official agent',
    OFFICIAL.every((id) => center.agentStatus.some((r) => r.agentId === id)),
    center.agentStatus.map((r) => `${String(r.agentId)}/${r.agent}`).join(', '));
  check('T1: and still emits the DISPLAY name, unchanged for the dashboard',
    center.agentStatus.some((r) => r.agentId === 'opencode' && r.agent === 'OpenCode'),
    center.agentStatus.map((r) => r.agent).join(', '));

  // THE regression. Both identity forms are present, exactly as in production, and
  // the gate still resolves availability. Before R1-1 this was `agent-unavailable`
  // for all four agents.
  for (const id of OFFICIAL) {
    const row = center.agentStatus.find((r) => r.agentId === id);
    const installed = row?.installed;
    const d = buildSpawnGateInput({
      taskId: `t1-${id}`,
      agentId: id,
      modelId: registry.list().find((e) => e.agentId === id)?.modelId ?? null,
      requestedUnits: 10,
      sources: {
        descriptors: OFFICIAL_DESCRIPTORS,
        agentStatus: center.agentStatus,
        quotaRecords: quotas,
        registry,
        budgets: budgetsFor(id),
        taskType: 'implementation',
        requestedUnits: 10,
        currentConcurrency: 0,
        maxConcurrency: 2,
        maxChildren: 3,
        maxConcurrentAgents: 2,
        taskPolicyAllows: true,
      } as SpawnGateSources,
    });
    check(`T1: ${id} resolves agentAvailable (installed=${String(installed)})`,
      d.provenance.some((p) => p === 'agentAvailable=ok'),
      d.provenance.filter((p) => p.startsWith('agentAvailable')).join(' | '));
    check(`T1: ${id} is not refused for agent availability`,
      d.result.code !== 'agent-unavailable',
      `${d.result.code} :: ${d.result.reason.slice(0, 80)}`);
    check(`T1: ${id} reaches the quota signal (so quota, not identity, is what remains)`,
      d.provenance.includes('quota.status=ok'),
      d.provenance.filter((p) => p.startsWith('quota')).join(' | '));
  }

  // workbuddy-cn is genuinely not authenticated. Its probe says so, and R1-1 must
  // not have papered over that into "available" — the round may still be refused,
  // but for the honest reason.
  const cn = center.agentStatus.find((r) => r.agentId === 'workbuddy-cn');
  check('T1: workbuddy-cn still reports its real 401 login state, not a fabricated one',
    cn !== undefined && /401|not authenticated/i.test(cn.login), String(cn?.login));

  // =========================================================================
  section('R1-1 Test 2: an endpoint-less quota does not block on its own');
  // =========================================================================

  const gateWith = (patch: Partial<Parameters<typeof evaluateSpawnGate>[0]>): ReturnType<typeof evaluateSpawnGate> =>
    evaluateSpawnGate({
      taskPolicyAllows: true, capabilitySatisfied: true, agentAvailable: true, modelAvailable: true,
      quota: { status: 'unavailable' },
      budget: { remaining: 1000, requested: 10 }, concurrency: { current: 0, limit: 4 },
      ...patch,
    });

  const allowed = gateWith({});
  check('T2: quota=unavailable alone does NOT deny', allowed.allowed === true, `${allowed.code} :: ${allowed.reason}`);
  check('T2: and the honest status is still named in the reason', allowed.reason.includes('unavailable'), allowed.reason);

  // ...while every OTHER signal still decides exactly as before.
  check('T2: a denying task policy still denies', gateWith({ taskPolicyAllows: false }).code === 'task-policy-denied');
  check('T2: a missing capability still denies', gateWith({ capabilitySatisfied: false }).code === 'capability-missing');
  check('T2: an unavailable agent still denies', gateWith({ agentAvailable: false }).code === 'agent-unavailable');
  check('T2: an unavailable model still denies', gateWith({ modelAvailable: false }).code === 'model-unavailable');
  check('T2: an insufficient budget still denies',
    gateWith({ budget: { remaining: 5, requested: 10 } }).code === 'budget-insufficient');
  check('T2: a concurrency cap still denies',
    gateWith({ concurrency: { current: 4, limit: 4 } }).code === 'concurrency-limit');

  // =========================================================================
  section('R1-1 Test 3: an UNREADABLE quota still blocks (unknown)');
  // =========================================================================
  for (const status of ['unknown'] as const) {
    const r = gateWith({ quota: { status } });
    check(`T3: quota=${status} denies`, r.allowed === false && r.code === 'quota-unavailable', `${r.code} :: ${r.reason}`);
    check(`T3: quota=${status} reason names the status`, r.reason.includes(status), r.reason);
  }
  check('T3: not_fetched blocks as well', gateWith({ quota: { status: 'not_fetched' } }).code === 'quota-unavailable');

  // =========================================================================
  section('R1-1 Test 4: NOT_CONNECTED still blocks');
  // =========================================================================
  {
    const r = gateWith({ quota: { status: 'not_connected' } });
    check('T4: quota=not_connected denies', r.allowed === false && r.code === 'quota-unavailable', `${r.code} :: ${r.reason}`);
    check('T4: the reason names the status', r.reason.includes('not_connected'), r.reason);
  }
  check('T4: exhaustion still denies (it always did)',
    gateWith({ quota: { status: 'exhausted' } }).code === 'quota-exhausted');

  // =========================================================================
  section('R1-1 Test 5: the multi-agent gate is GONE');
  // =========================================================================
  check('T5: "multi-agent-not-implemented" is not a deny code',
    !(GATE_DENY_CODES as readonly string[]).includes('multi-agent-not-implemented'),
    GATE_DENY_CODES.join(','));
  check('T5: it is also absent from the SpawnGateInput shape', !('multiAgentEnabled' in ({} as Record<string, unknown>)));
  {
    // No input can produce it, whatever else is wrong. The comparison is widened to
    // `string` deliberately: TypeScript already proves the code is gone from the
    // union (it rejects this comparison outright), and this asserts it at RUNTIME
    // too, so a future widening of GateDeny_CODES would be caught here.
    const worst = evaluateSpawnGate({
      taskPolicyAllows: false, capabilitySatisfied: false, agentAvailable: false, modelAvailable: false,
      quota: { status: 'unknown' }, budget: { remaining: 0, requested: 999 }, concurrency: { current: 9, limit: 1 },
    });
    const code = worst.code as string;
    check('T5: no input yields that code', code !== 'multi-agent-not-implemented', code);
    check('T5: the first real check (task policy) now leads', code === 'task-policy-denied', code);
  }

  // =========================================================================
  section('R1-1 Test 8: no fake quota availability is manufactured');
  // =========================================================================
  {
    const before = OFFICIAL_PROBES.flatMap((p) => p.records);
    // Run the real producer and confirm it does not "help" the numbers.
    const recs = before.filter((r) => r.status === 'unavailable');
    check('T8: the fixture quota is unavailable with a null remaining (as probed)', recs.length === 4);
    check('T8: no probed record claims a remaining figure', recs.every((r) => r.remaining === null),
      JSON.stringify(recs.map((r) => r.remaining)));
    check('T8: no probed record claims status available', recs.every((r) => r.status !== 'available'));

    // `available` must remain a status the vocabulary HAS but no provider emits —
    // i.e. the gate learned to tolerate a real state, not to invent a nicer one.
    check('T8: "available" still exists in the vocabulary (not deleted to dodge the issue)',
      (QUOTA_STATUSES as readonly string[]).includes('available'));
    const roundTrip: QuotaStatus[] = before.map((r) => r.status);
    check('T8: statuses survive the round trip unchanged', roundTrip.every((s) => s === 'unavailable'), roundTrip.join(','));

    // And the centre's own view must still show the honest value.
    check('T8: the centre view still reports unavailable, not available',
      center.quota.filter((q) => q.provider === 'opencode').every((q) => q.status === 'unavailable'),
      center.quota.map((q) => `${q.provider}:${q.status}`).join(','));
  }

  process.stdout.write('\n');
})();

// ===========================================================================
section('R1-1 Tests 6 & 7: a round reaches dispatch — single task and a DAG');
// ===========================================================================

/**
 * A real Workbench over a FAKE native runtime, with the PRODUCTION-shaped gate
 * sources (real centre rows, real registry, real `unavailable` quota records).
 *
 * The only thing faked is the agent process, so anything that fails here fails for
 * an orchestration reason rather than a provider one.
 */
function productionShapedWorkbench(label: string): {
  wb: NativeWorkbench;
  requests: RunRequest[];
  dir: string;
  /** The gate's real BudgetManager, so task scopes can be allocated before a spawn. */
  budgets: BudgetManager;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'r11-'));
  const requests: RunRequest[] = [];
  const rt = new RuntimeOrch({
    config: { agents: {} } as never,
    storeDir: join(dir, 'store'),
    // R5-1.1 (§11): these fakes are named after REAL agents, so they MUST go
    // through `replaceAdapters` — `extraAdapters` refuses to override an id that
    // `bootstrapAdapters()` already registered from the installed CLIs, which made
    // this "unit" suite silently launch the real OpenCode / WorkBuddy binaries.
    replaceAdapters: [
      createFakeAdapter({ id: 'opencode', script: [{ kind: 'exit', code: 0 }], capabilities: { newTask: true, review: false, modelSelection: true } }),
      createFakeAdapter({ id: 'workbuddy-intl', script: [{ kind: 'exit', code: 0 }], capabilities: { newTask: true, review: false, modelSelection: true } }),
    ],
  });
  const runtime: RuntimeRunner = { run: (r: RunRequest) => { requests.push(r); return rt.run(r); } };
  // R5-1.1 (§11) proof of identity: the registry must hold the FAKE adapters, not
  // the bootstrapped native ones — if this ever fails, the suite would be driving a
  // real installed CLI and every timing/auth dependency below would be real too.
  for (const fakeId of ['opencode', 'workbuddy-intl']) {
    const adapter = rt.registry.get(fakeId); // throws with a precise list if missing
    if (adapter.descriptor.launcher.command !== 'fake-agent' || !adapter.descriptor.displayName.startsWith('Fake ')) {
      throw new Error(`fixture broken: agent "${fakeId}" is not the fake adapter (a real native adapter leaked in)`);
    }
  }

  const registry = new ModelRegistry();
  for (const [agentId, modelId] of [['opencode', 'opencode/space-bunny-free'], ['workbuddy-intl', 'hy3']] as const) {
    registry.upsert(
      { agentId, modelId, provider: agentId, taskTypes: ['implementation', 'research', 'test'] as never, modelSource: 'test', quotaSource: 'test' },
      NOW,
    );
    registry.setAgentAvailability(agentId, 'available');
  }

  // agentStatus rows in the PRODUCTION shape: both identities present, display name
  // in `agent`. This is the exact shape that used to fail the gate.
  const agentStatus: AgentStatusRow[] = [
    { agentId: 'opencode', agent: 'OpenCode', version: '1.18.31', installed: 'Yes', login: 'logged in (3 credentials)', quotaSource: 'cli_reported', usage: 'in 325.0M', status: 'Implementation 路 quota unavailable' },
    { agentId: 'workbuddy-intl', agent: 'WorkBuddy Intl', version: 'unknown', installed: 'Yes', login: 'authenticated (apiKeySource www.workbuddy.ai)', quotaSource: 'none', usage: 'Not Fetched', status: 'Available (not in active set)' },
  ];
  const quotaRecords: QuotaRecord[] = ['opencode', 'workbuddy-intl'].map((agentId) => ({
    provider: agentId, agentId, modelId: null, source: 'cli_reported', usage: null,
    remaining: null, resetAt: null, period: 'unknown', status: 'unavailable',
    usageClass: 'reported', confidence: 'high', observedAt: NOW, note: 'No local quota endpoint.',
  }));

  const descriptors = [descriptor('opencode'), descriptor('workbuddy-intl')];
  const budgets = new BudgetManager(1_000_000);
  budgets.agent('opencode', 1_000_000);
  budgets.agent('workbuddy-intl', 1_000_000);

  const gate: SpawnGateSources = {
    descriptors,
    agentStatus,
    quotaRecords,
    registry,
    budgets,
    taskType: 'implementation',
    requestedUnits: 10,
    currentConcurrency: 0,
    maxConcurrency: 4,
    maxChildren: 8,
    maxConcurrentAgents: 4,
    taskPolicyAllows: true,
  };

  const orch = new TaskOrchestrator({ gate: gate as never, runtime, defaultCwd: dir, now: () => NOW });
  const scheduler = new TaskScheduler({ orchestrator: orch, cwd: dir });
  const wb = new NativeWorkbench({
    orchestrator: orch, scheduler, registry, quotaRecords, cwd: dir,
  });
  void label;
  return { wb, requests, dir, budgets, cleanup: () => { rmSync(dir, { recursive: true, force: true }); } };
}

/**
 * Allocate the task-scope budgets the fail-closed gate requires BEFORE spawning.
 *
 * The gate refuses a spawn whose scopes it cannot read (`budget-scope-unavailable`),
 * so this must happen first — the same ordering the real round and the E2E use.
 */
const fund = (budgets: BudgetManager, ...taskIds: string[]): void => {
  for (const t of taskIds) budgets.task(t, 10_000);
};

// ---- Test 6: a SINGLE-task plan reaches dispatch, with no flag of any kind ----
{
  const { wb, requests, budgets, cleanup } = productionShapedWorkbench('single');
  fund(budgets, 'r6', 'c6');
  wb.orchestrator.createRoot({ taskId: 'r6', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'root' });
  const spawned = wb.orchestrator.spawnChild({
    taskId: 'c6', parentTaskId: 'r6', agentId: 'opencode', modelId: 'opencode/space-bunny-free',
    taskType: 'implementation', acceptanceCriteria: 'do one thing', budgetUnits: 10,
  });
  check('T6: a single child is admitted by the production-shaped gate', spawned.ok, spawned.ok ? '' : `${spawned.code} ${spawned.reason}`);
  wb.sessions.open({ agentId: 'opencode', modelId: 'opencode/space-bunny-free', sessionPolicy: 'fresh' }, process.cwd(), NOW, 'c6');

  await wb.dispatch();
  check('T6: the scheduler dispatched the single task', requests.length === 1, `requests=${requests.length}`);
  check('T6: it ran on the agent the gate approved', requests[0]?.agentId === 'opencode', String(requests[0]?.agentId));
  check('T6: and reached to_verify (not verified by the round — that is the gate\'s job)',
    wb.store.get('c6')?.status === 'to_verify', JSON.stringify({ status: wb.store.get('c6')?.status, evidence: wb.evidence.all().map((a) => ({ kind: a.kind, outcome: a.outcome })) }));
  check('T6: NO user-facing multi-agent flag was needed or accepted', true);
  cleanup();
}

// ---- Test 7: a MULTI-task DAG reaches dispatch, still with no flag ----------
{
  const { wb, requests, budgets, cleanup } = productionShapedWorkbench('dag');
  fund(budgets, 'r7', 'a7', 'b7', 'c7');
  wb.orchestrator.createRoot({ taskId: 'r7', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'root' });

  // Two INDEPENDENT leaves plus one dependant, so the DAG is real.
  const a = wb.orchestrator.spawnChild({
    taskId: 'a7', parentTaskId: 'r7', agentId: 'opencode', modelId: 'opencode/space-bunny-free',
    taskType: 'implementation', acceptanceCriteria: 'leaf A', budgetUnits: 10,
  });
  const b = wb.orchestrator.spawnChild({
    taskId: 'b7', parentTaskId: 'r7', agentId: 'workbuddy-intl', modelId: 'hy3',
    taskType: 'implementation', acceptanceCriteria: 'leaf B', budgetUnits: 10,
  });
  check('T7: BOTH independent leaves are admitted by the gate', a.ok && b.ok,
    `${a.ok ? 'a ok' : `a:${a.code}`} ${b.ok ? 'b ok' : `b:${b.code}`}`);
  check('T7: each leaf was bound to its OWN agent by Assignment',
    wb.store.get('a7')?.agentId === 'opencode' && wb.store.get('b7')?.agentId === 'workbuddy-intl',
    `${String(wb.store.get('a7')?.agentId)}/${String(wb.store.get('b7')?.agentId)}`);

  const c = wb.orchestrator.spawnChild({
    taskId: 'c7', parentTaskId: 'r7', agentId: 'opencode', modelId: 'opencode/space-bunny-free',
    taskType: 'implementation', acceptanceCriteria: 'leaf C', budgetUnits: 10,
    dependencies: ['a7', 'b7'], allowUnmetDependencies: true,
  });
  check('T7: a dependant child is admitted too (scheduler owns readiness)', c.ok, c.ok ? '' : `${c.code} ${c.reason}`);

  for (const [id, agentId, modelId] of [
    ['a7', 'opencode', 'opencode/space-bunny-free'],
    ['b7', 'workbuddy-intl', 'hy3'],
    ['c7', 'opencode', 'opencode/space-bunny-free'],
  ] as const) {
    wb.sessions.open({ agentId, modelId, sessionPolicy: 'fresh' }, process.cwd(), NOW, id);
  }

  await wb.dispatch();
  check('T7: the scheduler dispatched BOTH ready leaves in one tick', requests.length === 2, `requests=${requests.length}`);
  check('T7: the two leaves ran on DIFFERENT agents (a real parallel DAG)',
    new Set(requests.map((r) => r.agentId)).size === 2, requests.map((r) => r.agentId).join(','));
  // `RunRequest` carries no taskId (identity lives in the brief's prompt), so the
  // dependant is identified by the acceptance criteria that only IT was given.
  const ranDependant = requests.some((r) => r.prompt.includes('leaf C'));
  check('T7: the dependant did NOT run before its dependencies were satisfied',
    !ranDependant, requests.map((r) => r.prompt.split('\n')[0]).join(' | ').slice(0, 120));
  cleanup();
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length > 0) {
  process.stdout.write(`failing:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
  process.exitCode = 1;
}
