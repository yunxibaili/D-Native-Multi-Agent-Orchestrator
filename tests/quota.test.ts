/**
 * tests/quota.test.ts — hermetic Phase 4 tests: Quota Source, Model Registry,
 * Model Policy, Budget Ledger, Spawn Gate.
 *
 * Nothing here contacts a real CLI: parsers take fixture text, providers take
 * an injected runner, observed usage runs against a temp SessionStore. The
 * assertions are the Phase 4 contract:
 *
 *   - a quota that cannot be read is `unavailable`/`unknown`/`not_fetched`
 *     with remaining `null` displayed as text — NEVER "0"
 *   - usage is classified observed / reported, and a cost nobody reported is
 *     `null`, never $0.00
 *   - policy and gate denials always carry a machine code AND a reason
 *   - budget arithmetic never goes negative and every denial is a result
 *
 * Run: node tests/quota.test.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunResult } from '../src/core/types.ts';
import { SessionStore } from '../src/runtime/store.ts';
import { BudgetLedger, BudgetManager } from '../src/quota/budget.ts';
import {
  CodexQuotaProvider,
  OpenCodeQuotaProvider,
  StaticQuotaProvider,
  collectAll,
  formatRemaining,
  formatReset,
  parseCodexDoctor,
  parseCount,
  parseMoney,
  parseOpenCodeCredentialCount,
  parseOpenCodeStats,
  type CmdRunner,
  type QuotaProbe,
} from '../src/quota/collector.ts';
import { collectObservedUsage } from '../src/quota/observed.ts';
import { evaluatePolicy } from '../src/quota/policy.ts';
import { ModelRegistry, modelKey } from '../src/quota/registry.ts';
import { evaluateSpawnGate } from '../src/quota/spawn-gate.ts';
import { buildQuotaCenter, ACTIVE_AGENT_IDS } from '../src/quota/index.ts';
import type { SpawnGateInput } from '../src/quota/types.ts';

const ESC = '\u001b';

let passed = 0;
let failed = 0;
const failures: string[] = [];
const tmpDirs: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed++;
    failures.push(name + (detail ? ` - ${detail}` : ''));
    process.stdout.write(`  FAIL ${name}${detail ? ` - ${detail}` : ''}\n`);
  }
}

function section(t: string): void {
  process.stdout.write(`\n== ${t}\n`);
}

function makeStore(): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), 'quota-test-'));
  tmpDirs.push(dir);
  return new SessionStore(dir);
}

function makeResult(taskId: string, agentId: string, patch: Partial<RunResult> = {}): RunResult {
  return {
    taskId,
    threadId: null,
    agentId,
    state: 'succeeded',
    startedAt: 1000,
    endedAt: 2000,
    exitCode: 0,
    signal: null,
    output: '',
    outputTruncated: false,
    transcriptPath: null,
    usage: {},
    toolCalls: [],
    error: null,
    diagnostics: [],
    cleanup: { rootKilled: false, treeStopConfirmed: true, processStart: 'started', descendantsReaped: false, note: '' },
    ...patch,
  };
}

// =========================================================================
section('parsers: counts, money, opencode stats');

check('parseCount 280.3M', parseCount('280.3M') === 280300000);
check('parseCount 45,745 with comma', parseCount('45,745') === 45745);
check('parseCount 1.5K', parseCount('1.5K') === 1500);
check('parseCount 0 stays 0', parseCount('0') === 0);
check('parseCount garbage -> null', parseCount('n/a') === null);
check('parseMoney $19.69', parseMoney('$19.69') === 19.69);
check('parseMoney free -> null', parseMoney('free') === null);

const V = String.fromCharCode(0x2502);
const STATS_FIXTURE = [
  `+${'-'.repeat(56)}+`,
  `${V}                       OVERVIEW                         ${V}`,
  `+${'-'.repeat(56)}+`,
  `${V}Sessions                                            276 ${V}`,
  `${V}Messages                                         45,745 ${V}`,
  `${V}Days                                                 53 ${V}`,
  `+${'-'.repeat(56)}+`,
  `${V}                    COST & TOKENS                       ${V}`,
  `+${'-'.repeat(56)}+`,
  `${V}Total Cost                                       $19.69 ${V}`,
  `${V}Avg Cost/Day                                      $0.37 ${V}`,
  `${V}Input                                            280.3M ${V}`,
  `${V}Output                                             18.0M ${V}`,
  `${V}Cache Read                                      9139.6M ${V}`,
  `${V}Cache Write                                           0 ${V}`,
  `+${'-'.repeat(56)}+`,
].join('\n');

const stats = parseOpenCodeStats(STATS_FIXTURE);
check('stats parsed', stats !== null);
check('stats sessions 276', stats?.sessions === 276);
check('stats cost 19.69', stats?.totalCostUsd === 19.69);
check('stats input 280.3M', stats?.inputTokens === 280300000);
check('stats output 18.0M', stats?.outputTokens === 18000000);
check('stats cache read', stats?.cacheReadTokens === 9139600000);
check('garbage stats -> null', parseOpenCodeStats('nothing here') === null);

const PROVIDERS_FIXTURE =
  `${ESC}[90mT${ESC}[39m  Credentials ~\\.local\\share\\opencode\\auth.json\n` +
  `${ESC}[34m*${ESC}[39m  OpenCode Go api\n` +
  `- 3 credentials\n`;
check('credential count 3', parseOpenCodeCredentialCount(PROVIDERS_FIXTURE) === 3);
check('ANSI stripped before counting', parseOpenCodeCredentialCount(`${ESC}[31m- 2 credentials${ESC}[39m\n`) === 2);
check('no credential line -> null', parseOpenCodeCredentialCount('denied') === null);

// =========================================================================
section('parsers: codex doctor --json');

const DOCTOR_FIXTURE = JSON.stringify({
  schemaVersion: 1,
  generatedAt: '1790654816s since unix epoch',
  overallStatus: 'warning',
  codexVersion: '0.158.0-alpha.2.1',
  checks: {
    'auth.credentials': {
      status: 'ok',
      summary: 'auth is configured',
      details: {
        'stored API key': 'true',
        'stored ChatGPT tokens': 'false',
        'stored auth mode': 'api_key',
      },
    },
    'config.load': {
      status: 'warning',
      details: { model: 'deepseek-v4.1-flash', 'model provider': 'custom' },
    },
  },
});

const doc = parseCodexDoctor(DOCTOR_FIXTURE);
check('doctor parsed', doc !== null);
check('doctor version', doc?.version === '0.158.0-alpha.2.1');
check('doctor auth configured', doc?.authConfigured === true);
check('doctor auth mode api_key', doc?.authMode === 'api_key');
check('doctor model', doc?.model === 'deepseek-v4.1-flash');
check('doctor model provider custom', doc?.modelProvider === 'custom');
check('doctor overall status', doc?.overallStatus === 'warning');
check('doctor garbage -> null', parseCodexDoctor('not json') === null);

const NO_AUTH_FIXTURE = JSON.stringify({
  codexVersion: '1.0.0',
  checks: {
    'auth.credentials': {
      status: 'error',
      details: { 'stored API key': 'false', 'stored ChatGPT tokens': 'false' },
    },
  },
});
check('doctor without credentials -> authConfigured false', parseCodexDoctor(NO_AUTH_FIXTURE)?.authConfigured === false);

// =========================================================================
section('quota status formatting: never fabricate 0');

check('unavailable remaining renders "Unavailable"', formatRemaining(null, 'unavailable') === 'Unavailable');
check('unknown remaining renders "Unknown"', formatRemaining(null, 'unknown') === 'Unknown');
check('not_fetched remaining renders "Not Fetched"', formatRemaining(null, 'not_fetched') === 'Not Fetched');
check('not_connected remaining renders "Not Connected"', formatRemaining(null, 'not_connected') === 'Not Connected');
check('real remaining renders as number', formatRemaining(42, 'available') === '42');
check('null reset renders "Not Fetched"', formatReset(null) === 'Not Fetched');
check(
  'null remaining is never rendered as 0',
  formatRemaining(null, 'unavailable') !== '0' && formatRemaining(null, 'unknown') !== '0',
);

// =========================================================================
section('providers (injected runner, no real CLI)');

const NODE_BIN = process.execPath;
const MISSING_BIN = join(tmpdir(), 'definitely-not-installed', 'agent.exe');

function runnerFor(map: Record<string, string>): CmdRunner {
  return async (_command, args) => {
    const key = args.join(' ');
    const out = map[key];
    if (out === undefined) return { stdout: '', stderr: `unexpected args: ${key}`, code: 1 };
    return { stdout: out, stderr: '', code: 0 };
  };
}

const ocProvider = new OpenCodeQuotaProvider({
  runner: runnerFor({
    stats: STATS_FIXTURE,
    'providers list': PROVIDERS_FIXTURE,
    '--version': '1.18.31\n',
  }),
  command: NODE_BIN,
});

const ocProbe = await ocProvider.probe();
check('opencode probe has one record', ocProbe.records.length === 1);
const ocRec = ocProbe.records[0]!;
check('opencode quota status unavailable (no endpoint)', ocRec.status === 'unavailable');
check('opencode remaining stays null', ocRec.remaining === null);
check('opencode usage class is reported', ocRec.usageClass === 'reported');
check('opencode source cli_reported', ocRec.source === 'cli_reported');
check('opencode reported cost parsed', ocRec.usage?.costUsd === 19.69);
check('opencode login counts credentials', ocProbe.login === 'logged in (3 credentials)');
check('opencode version parsed', ocProbe.version === '1.18.31');

const ocNoCreds = await new OpenCodeQuotaProvider({
  runner: runnerFor({ stats: STATS_FIXTURE, 'providers list': '- 0 credentials\n', '--version': '1.18.31' }),
  command: NODE_BIN,
}).probe();
check('opencode without credentials -> not_connected', ocNoCreds.records[0]!.status === 'not_connected');
check('opencode without credentials -> login not connected', ocNoCreds.login === 'not connected');

const ocMissing = await new OpenCodeQuotaProvider({ command: MISSING_BIN }).probe();
check('opencode CLI missing -> not_fetched', ocMissing.records[0]!.status === 'not_fetched');
check('opencode CLI missing -> login Not Fetched', ocMissing.login === 'Not Fetched');
check('opencode CLI missing -> reason recorded', (ocMissing.error ?? '').length > 0);

const ocBadStats = await new OpenCodeQuotaProvider({
  runner: runnerFor({ stats: 'garbage', 'providers list': PROVIDERS_FIXTURE, '--version': '1.18.31' }),
  command: NODE_BIN,
}).probe();
check('unparseable stats -> usage null (no fabricated numbers)', ocBadStats.records[0]!.usage === null);
check('unparseable stats -> error recorded', (ocBadStats.error ?? '').includes('opencode stats'));

const cxProvider = new CodexQuotaProvider({
  runner: runnerFor({ 'doctor --json': DOCTOR_FIXTURE }),
  command: NODE_BIN,
});
const cxProbe = await cxProvider.probe();
check('codex quota status unavailable', cxProbe.records[0]!.status === 'unavailable');
check('codex remaining null', cxProbe.records[0]!.remaining === null);
check('codex login api_key', cxProbe.login === 'logged in (api_key)');
check('codex model hint from doctor', cxProbe.modelHint === 'deepseek-v4.1-flash');
check('codex provider hint custom', cxProbe.providerHint === 'custom');
check('codex record provider is custom', cxProbe.records[0]!.provider === 'custom');
check('codex version from doctor', cxProbe.version === '0.158.0-alpha.2.1');

const cxBad = await new CodexQuotaProvider({
  runner: runnerFor({ 'doctor --json': 'not json' }),
  command: NODE_BIN,
}).probe();
check('unparseable codex doctor -> status unknown', cxBad.records[0]!.status === 'unknown');
check('unparseable codex doctor -> login Unknown', cxBad.login === 'Unknown');

const wbCn = await new StaticQuotaProvider(
  'workbuddy-cn',
  'workbuddy',
  {
    login: 'not authenticated (HTTP 401, last observed 2026-09-29)',
    version: '2.137.1',
    modelHint: null,
    loginSource: 'Phase 3 sidecar run evidence (2026-09-29)',
  },
  'no quota command.',
).probe();
check('workbuddy-cn (401) -> not_connected', wbCn.records[0]!.status === 'not_connected');
check('workbuddy-cn runs nothing (source none)', wbCn.records[0]!.source === 'none');
check('workbuddy-cn version evidence', wbCn.version === '2.137.1');

const throwing = {
  agentId: 'boom',
  provider: 'boom',
  probe: async (): Promise<QuotaProbe> => {
    throw new Error('probe exploded');
  },
};
const collected = await collectAll([throwing]);
check('throwing provider degrades to unknown record', collected.records[0]!.status === 'unknown');
check('throwing provider keeps error text', (collected.records[0]!.note ?? '').includes('probe exploded'));

// =========================================================================
section('observed usage (locally_observed class)');

const store = makeStore();
store.saveTask(makeResult('t_oc_1', 'opencode', { usage: { inputTokens: 100, outputTokens: 50, costUsd: 0 } }));
store.saveTask(makeResult('t_oc_2', 'opencode', { usage: { inputTokens: 200, outputTokens: 25 }, state: 'failed' }));
store.saveTask(makeResult('t_cx_1', 'codex', { usage: { inputTokens: 1000, outputTokens: 400 } }));

const observed = collectObservedUsage(store, 50);
const byAgent = new Map(observed.map((o) => [o.agentId, o]));
check('two agents observed', observed.length === 2);
check('opencode runs counted', byAgent.get('opencode')?.runs === 2);
check('opencode succeeded counted', byAgent.get('opencode')?.succeeded === 1);
check(
  'opencode cost reported by 1 of 2 runs -> sum of reported only',
  byAgent.get('opencode')?.costUsd === 0 && byAgent.get('opencode')?.costReportingRuns === 1,
);
check('opencode classified locally_observed', byAgent.get('opencode')?.source === 'locally_observed');
check('codex cost NEVER reported -> null (not 0.00)', byAgent.get('codex')?.costUsd === null);
check('codex costReportingRuns is 0', byAgent.get('codex')?.costReportingRuns === 0);
check('codex tokens summed', byAgent.get('codex')?.inputTokens === 1000);

// =========================================================================
section('model registry');

const reg = new ModelRegistry();
reg.upsert(
  { agentId: 'opencode', modelId: 'opencode/m1', provider: 'opencode', taskTypes: ['implementation', 'research', 'test'], modelSource: 'config' },
  111,
);
reg.upsert(
  { agentId: 'codex', modelId: 'm1', provider: 'custom', taskTypes: ['implementation', 'review', 'research', 'test'], modelSource: 'doctor' },
  222,
);

check('same model id on two agents -> two entries', reg.size === 2);
check('key is agent-scoped', reg.get('opencode', 'opencode/m1')?.key === modelKey('opencode', 'opencode/m1'));
check('codex entry does not leak into opencode', reg.get('codex', 'm1') !== null);
check('unknown model -> null', reg.get('opencode', 'nope') === null);
check('list sorted by key', reg.list().map((e) => e.key).join(',') === 'codex::m1,opencode::opencode/m1');
check('forAgent filters', reg.forAgent('opencode').length === 1);
check(
  'default policy status is unavailable until evaluated',
  reg.get('opencode', 'opencode/m1')!.policyStatus === 'unavailable',
);

reg.setAgentAvailability('opencode', 'available');
check('availability applies agent-wide', reg.get('opencode', 'opencode/m1')!.availability === 'available');
reg.applyPolicy('opencode', 'opencode/m1', 'allowed', 'fine');
check('policy applied to entry', reg.get('opencode', 'opencode/m1')!.policyStatus === 'allowed');
check('policy reason stored', reg.get('opencode', 'opencode/m1')!.policyReason === 'fine');
reg.applyPolicy('ghost', 'ghost-model', 'allowed', 'no-op on unknown');
check('policy on unknown entry is a no-op', reg.get('ghost', 'ghost-model') === null);

// =========================================================================
section('model policy (allowed / disabled / unavailable / quota-blocked)');

const policyReg = new ModelRegistry();
policyReg.upsert(
  { agentId: 'a', modelId: 'm', provider: 'p', taskTypes: ['implementation', 'research', 'test'], modelSource: 'test' },
  1,
);
policyReg.upsert(
  { agentId: 'a', modelId: 'review-only', provider: 'p', taskTypes: ['review'], modelSource: 'test' },
  1,
);
policyReg.setAgentAvailability('a', 'unavailable');

let d = evaluatePolicy(policyReg, { agentId: 'a', modelId: 'm', agentAvailable: true });
check('entry unavailable -> unavailable', d.decision === 'unavailable');
check('entry unavailable -> reason names model', d.reason.includes('unavailable'));

policyReg.setAgentAvailability('a', 'available');
d = evaluatePolicy(policyReg, { agentId: 'a', modelId: 'no-such-model' });
check('unknown model -> unavailable', d.decision === 'unavailable');
check('unknown model reason names it', d.reason.includes('no-such-model'));

d = evaluatePolicy(policyReg, { agentId: 'a', modelId: 'm', disabled: true });
check('disabled by policy -> disabled', d.decision === 'disabled');

d = evaluatePolicy(policyReg, { agentId: 'a', modelId: 'm', agentAvailable: false });
check('agent binary missing -> unavailable', d.decision === 'unavailable');

d = evaluatePolicy(policyReg, { agentId: 'a', modelId: 'm', taskType: 'review' });
check('task type not allowed -> disabled', d.decision === 'disabled');
check('task type reason lists allowed types', d.reason.includes('implementation'));

d = evaluatePolicy(policyReg, { agentId: 'a', modelId: 'review-only', taskType: 'review' });
check('allowed task type passes', d.decision === 'allowed');

d = evaluatePolicy(policyReg, { agentId: 'a', modelId: 'm', quotaStatus: 'exhausted' });
check('exhausted quota -> quota-blocked', d.decision === 'quota-blocked');
check('quota-blocked reason says exhausted', d.reason.includes('exhausted'));

d = evaluatePolicy(policyReg, { agentId: 'a', modelId: 'm', quotaStatus: 'unavailable' });
check(
  'standing policy does NOT block on unreadable quota (gate handles that)',
  d.decision === 'allowed',
  d.decision,
);

d = evaluatePolicy(policyReg, { agentId: 'a', modelId: 'm', agentAvailable: true, quotaStatus: 'available' });
check('all clear -> allowed', d.decision === 'allowed');
check('allowed reason is human readable', d.reason.includes('satisfies'));

// =========================================================================
section('budget ledger (orchestration budget, not billing)');

const ledger = new BudgetLedger('global', 'global', 100);
check('initial remaining = allocated', ledger.remaining() === 100);

let res = ledger.allocate(50);
check('allocate grows remaining', res.ok && res.state.remaining === 150);

res = ledger.allocate(-5);
check('negative allocate denied', !res.ok && res.code === 'invalid-amount');
check('negative allocate has reason', !res.ok && res.reason.length > 0);

res = ledger.reserve('r1', 40);
check('reserve ok', res.ok);
check('reserve reduces remaining', ledger.remaining() === 110);
check('reserve visible in snapshot', ledger.snapshot().reserved === 40);
check('reservation listed', ledger.snapshot().reservations.some((r) => r.id === 'r1'));

res = ledger.reserve('r2', 1000);
check('over-reserve denied', !res.ok && res.code === 'insufficient-remaining');
check('over-reserve reason has numbers', !res.ok && res.reason.includes('1000'));

res = ledger.reserve('r1', 1);
check('duplicate reservation denied', !res.ok && res.code === 'duplicate-reservation');

res = ledger.reserve('bad', 0);
check('zero reserve denied as invalid', !res.ok && res.code === 'invalid-amount');

res = ledger.consume('ghost');
check('consume unknown reservation denied', !res.ok && res.code === 'unknown-reservation');

res = ledger.consume('r1', 500);
check('consume above hold denied', !res.ok && res.code === 'reservation-exceeded');

res = ledger.consume('r1', 30);
check('partial consume ok', res.ok);
check('consumed recorded', ledger.snapshot().consumed === 30);
check('hold released after consume', ledger.snapshot().reserved === 0);
check('partial consume returns unused: remaining = 150-30', ledger.remaining() === 120);

res = ledger.reserve('r2', 20);
check('second reserve ok', res.ok);
res = ledger.release('r2', 5);
check('partial release ok', res.ok);
check('partial release keeps remainder reserved', ledger.snapshot().reserved === 15);
res = ledger.release('r2');
check('full release of remainder ok', res.ok);
check('released accumulates (10 unused from consume + 5 + 15)', ledger.snapshot().released === 30);
check('no holds left', ledger.snapshot().reservations.length === 0);

res = ledger.release('ghost');
check('release unknown denied', !res.ok && res.code === 'unknown-reservation');

res = ledger.consume('r9', 10);
check('consume after release (hold gone) denied', !res.ok && res.code === 'unknown-reservation');

const before = ledger.remaining();
res = ledger.allocate(1000000);
check('huge allocate ok', res.ok);
check('remaining tracks arithmetic', ledger.remaining() === before + 1000000);

const tiny = new BudgetLedger('task', 't1', 10);
tiny.reserve('r', 10);
const shrink = tiny.allocate(-100);
check('shrink attempt denied as invalid-amount', !shrink.ok && shrink.code === 'invalid-amount');
check('fully committed ledger has 0 remaining', tiny.remaining() === 0);
check('reserve beyond committed denied', !tiny.reserve('r2', 1).ok);

const mgr = new BudgetManager(1000);
check('global ledger created', mgr.snapshotAll()[0]!.scope === 'global');
const taskLedger = mgr.task('task-1', 100);
const taskLedger2 = mgr.task('task-1');
check('task ledger cached', taskLedger === taskLedger2);
check('task ledger allocated on create', taskLedger.remaining() === 100);
mgr.task('task-1', 50);
check('second allocate adds', taskLedger.remaining() === 150);
const agentLedger = mgr.agent('codex', 10);
check('agent scope independent', agentLedger.remaining() === 10);
check('snapshotAll has global+task+agent', mgr.snapshotAll().length === 3);
check('scopes recorded', mgr.snapshotAll().map((s) => s.scope).join(',') === 'global,task,agent');

// =========================================================================
section('spawn gate (decision only — no spawn)');

  function gateInput(patch: Partial<SpawnGateInput> = {}): SpawnGateInput {
    return {
      taskPolicyAllows: true,
      capabilitySatisfied: true,
      agentAvailable: true,
      modelAvailable: true,
      quota: { status: 'available' },
      budget: { remaining: 100, requested: 10 },
      concurrency: { current: 0, limit: 4 },
      ...patch,
    };
}

  // R1-1: the `multi-agent-not-implemented` gate is GONE, so there is no longer a
  // "default input denied" case. Its absence as a deny code is asserted in the R1-1
  // section of tests/spawn-gate-production.test.ts, not merely assumed here.

  let g = evaluateSpawnGate(gateInput());
  check('all clear -> allowed', g.allowed && g.code === 'allowed');
  check('allowed reason shows budget+quota', g.reason.includes('quota available'));

g = evaluateSpawnGate(gateInput({ taskPolicyAllows: false }));
check('task policy deny code', g.code === 'task-policy-denied');
check('task policy deny reason', g.reason.includes('task policy'));

g = evaluateSpawnGate(gateInput({ capabilitySatisfied: false }));
check('capability deny code', g.code === 'capability-missing');

g = evaluateSpawnGate(gateInput({ agentAvailable: false }));
check('agent deny code', g.code === 'agent-unavailable');

g = evaluateSpawnGate(gateInput({ modelAvailable: false }));
check('model deny code', g.code === 'model-unavailable');

g = evaluateSpawnGate(gateInput({ quota: { status: 'exhausted' } }));
check('exhausted quota deny code', g.code === 'quota-exhausted');

  // R1-1: `unavailable` is NO LONGER in the blocking set. Its meaning is "this
  // provider exposes no quota endpoint", which is a confirmed fact, and all four
  // official agents report it (PHASE4_QUOTA_AUDIT, 2026-09-29). The three statuses
  // that are genuinely MISSING facts still fail closed.
  g = evaluateSpawnGate(gateInput({ quota: { status: 'unavailable' } }));
  check('quota unavailable does NOT block (no endpoint is a fact, not a gap)', g.allowed, g.reason);
  check('quota unavailable is still named in the allowed reason', g.reason.includes('unavailable'));

  for (const status of ['unknown', 'not_fetched', 'not_connected'] as const) {
    g = evaluateSpawnGate(gateInput({ quota: { status } }));
    check(`quota ${status} fail-closes`, g.code === 'quota-unavailable' && !g.allowed);
    check(`quota ${status} reason quotes the status`, g.reason.includes(status));
  }

g = evaluateSpawnGate(gateInput({ budget: { remaining: 5, requested: 10 } }));
check('budget deny code', g.code === 'budget-insufficient');
check('budget deny reason has both numbers', g.reason.includes('10') && g.reason.includes('5'));

g = evaluateSpawnGate(gateInput({ concurrency: { current: 4, limit: 4 } }));
check('concurrency deny code', g.code === 'concurrency-limit');

  // "First miss wins" is still a real property — it is just no longer about a
  // multi-agent switch. Policy is now the first check.
  g = evaluateSpawnGate(
    gateInput({ taskPolicyAllows: false, agentAvailable: false, budget: { remaining: 0, requested: 99 } }),
  );
  check('first miss wins (policy checked first)', g.code === 'task-policy-denied');

// =========================================================================
section('buildQuotaCenter (hermetic assembly)');

const centerStore = makeStore();
centerStore.saveTask(makeResult('ct1', 'codex', { usage: { inputTokens: 500, outputTokens: 100 } }));

const fakeProbes: QuotaProbe[] = [
  {
    agentId: 'opencode',
    provider: 'opencode',
    records: [
      {
        provider: 'opencode',
        agentId: 'opencode',
        modelId: null,
        source: 'cli_reported',
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 1.5, runs: 3 },
        remaining: null,
        resetAt: null,
        period: 'unknown',
        status: 'unavailable',
        usageClass: 'reported',
        confidence: 'high',
        observedAt: 5,
        note: 'no endpoint',
      },
    ],
    login: 'logged in (3 credentials)',
    version: '1.18.31',
    modelHint: null,
    providerHint: null,
    error: null,
  },
  {
    agentId: 'codex',
    provider: 'custom',
    records: [
      {
        provider: 'custom',
        agentId: 'codex',
        modelId: null,
        source: 'cli_reported',
        usage: null,
        remaining: null,
        resetAt: null,
        period: 'unknown',
        status: 'unavailable',
        usageClass: 'reported',
        confidence: 'high',
        observedAt: 5,
        note: 'no endpoint',
      },
    ],
    login: 'logged in (api_key)',
    version: '0.158.0-alpha.2.1',
    modelHint: 'deepseek-v4.1-flash',
    providerHint: 'custom',
    error: null,
  },
  {
    agentId: 'workbuddy-cn',
    provider: 'workbuddy',
    records: [
      {
        provider: 'workbuddy',
        agentId: 'workbuddy-cn',
        modelId: null,
        source: 'none',
        usage: null,
        remaining: null,
        resetAt: null,
        period: 'unknown',
        status: 'not_connected',
        usageClass: 'reported',
        confidence: 'high',
        observedAt: 5,
        note: 'HTTP 401',
      },
    ],
    login: 'not authenticated (HTTP 401, last observed 2026-09-29)',
    version: '2.137.1',
    modelHint: null,
    providerHint: null,
    error: null,
  },
];

const center = await buildQuotaCenter({
  store: centerStore,
  probes: fakeProbes,
  configs: { opencode: { model: 'opencode/space-bunny-free' } },
  now: 12345,
});

check('every active agent has a status row', center.agentStatus.length >= ACTIVE_AGENT_IDS.length);
const centerIds = center.agentStatus.map((r) => r.agent);
check(
  'cline row present but marked out of active set',
  center.agentStatus.some((r) => r.agent === 'Cline' && r.status.includes('not in active set')),
);
check('active set rows present', ['OpenCode', 'Codex', 'WorkBuddy CN', 'WorkBuddy Intl'].every((n) => centerIds.includes(n)));
check(
  'workbuddy-cn not_connected surfaces in status',
  center.agentStatus.find((r) => r.agent === 'WorkBuddy CN')!.status.includes('quota not_connected'),
);
check('generatedAt is ISO', Number.isNaN(Date.parse(center.generatedAt)) === false);

const unprobedQuota = center.quota.filter((q) => q.status === 'not_fetched');
check('unprobed agents get placeholder quota rows', unprobedQuota.length >= 1);
check('placeholder remaining is text, not 0', unprobedQuota.every((q) => q.remaining === 'Not Fetched'));
check(
  'no quota row claims a numeric remaining',
  center.quota.every((q) =>
    q.remaining === 'Unavailable' || q.remaining === 'Not Fetched' || q.remaining === 'Not Connected',
  ),
);
check('quota rows carry source', center.quota.every((q) => q.source.length > 0));
check('quota rows carry observedAt', center.quota.every((q) => q.observedAt.length > 0));
check('quota rows carry confidence', center.quota.every((q) => ['high', 'medium', 'low'].includes(q.confidence)));

check('model registry seeded from config', center.modelRegistry.some((m) => m.model === 'opencode/space-bunny-free'));
check('model registry seeded from doctor hint', center.modelRegistry.some((m) => m.model === 'deepseek-v4.1-flash'));
check(
  'registry rows carry policy',
  center.modelRegistry.every((m) => ['allowed', 'disabled', 'unavailable', 'quota-blocked'].includes(m.policy)),
);
check('registry rows carry policy reason', center.modelRegistry.every((m) => m.reason.length > 0));
check(
  'agent and model are never merged (separate columns)',
  center.modelRegistry.every((m) => m.agent.length > 0 && m.model.length > 0),
);

check('free credit: no verified promotions', center.freeCredit.status === 'No verified promotions');
check('free credit: no fabricated promotions', center.freeCredit.promotions.length === 0);
check(
  'free models carry source',
  center.freeCredit.freeModels.every((f) => f.source.length > 0 && f.observedAt.length > 0),
);

check('budgets include global scope', center.budgets.some((b) => b.scope === 'global'));
check('budget global is 0 allocated (ours, not provider)', center.budgets[0]!.allocated === 0);

  check('spawn gate demo denies', center.spawnGate.allowed === false);
  // R1-1: this used to be `multi-agent-not-implemented`, which the centre produced
  // only because it defaulted that flag to false. With the flag gone, the demo gate
  // reports the FIRST genuinely missing signal instead — and this centre is built
  // without descriptors, so capability is the honest first miss.
  check('spawn gate demo code is a real signal, not the removed multi-agent flag',
    center.spawnGate.code === 'capability-missing',
    `got ${center.spawnGate.code} :: ${center.spawnGate.reason.slice(0, 90)}`);
check('spawn gate reason set', center.spawnGate.reason.length > 0);

check(
  'classification note present',
  center.classificationNote.includes('observed') && center.classificationNote.includes('reported'),
);

const observedRow = center.agentStatus.find((r) => r.agent === 'Codex')!;
check('codex usage classified observed', observedRow.usage.startsWith('observed:'));
check('codex cost honestly unknown', observedRow.usage.includes('cost unknown'));

const offline = await buildQuotaCenter({ store: centerStore, probes: [], now: 1 });
check('offline: installed Unknown, not "No"', offline.agentStatus.every((r) => r.installed === 'Unknown'));
check(
  'offline: quota placeholders not_fetched',
  offline.quota.filter((q) => q.status === 'not_fetched').length >= ACTIVE_AGENT_IDS.length,
);
check('offline: remaining text not 0', offline.quota.every((q) => q.remaining === 'Not Fetched'));
check('offline: login Not Fetched', offline.agentStatus.every((r) => r.login === 'Not Fetched'));

// =========================================================================

for (const dir of tmpDirs) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) {
  process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
}
process.stdout.write('\n');
process.exitCode = failed === 0 ? 0 : 1;
