/**
 * tests/b22-model-pool-candidates.test.ts — B2.2: explicit `--model-pool`
 * candidate-source wiring.
 *
 * WHAT THIS PROVES, AND WHAT IT DELIBERATELY DOES NOT
 * ---------------------------------------------------
 * B2.1 gave the user a bounded declaration file; the round read/validated/froze it
 * and enforced it around the pairs the REGISTRY ALREADY KNEW. It did not let a
 * declaration introduce a candidate of its own, so a round whose only candidate was
 * declared had nothing to enforce against. B2.2 threads the SAME frozen pool into the
 * SAME `seedRegistry` the normal round uses, so admitted declarations become exact,
 * DECLARATION-ONLY entries — honest provenance, availability `unknown`.
 *
 * A declaration is ADMISSION, never evidence. This test is explicit that the slice is
 * NOT a callable/free-account proof: a declaration-only pair is registered but stays
 * `unknown`, so the real Assignment refuses it and the runtime runs ZERO times.
 *
 * REAL vs INJECTED
 * ----------------
 * REAL: `seedRegistry`, `buildQuotaCenter`, `applyPolicy`, the ModelRegistry, and the
 * whole `runRoundCli` chain (Planner, Assignment, Spawn Gate, Scheduler, decision loop,
 * verification, report).
 * INJECTED, and only these: LAYA's ANSWERS (the external laya-serve), the probe RESULT,
 * and the runtime EXECUTION edge (fake results; no agent process). `--no-review` keeps
 * the round offline.
 *
 * Run: node tests/b22-model-pool-candidates.test.ts
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runRoundCli } from '../src/cli/round-cli.ts';
import { seedRegistry, buildQuotaCenter, type QuotaProbe } from '../src/quota/index.ts';
import { SessionStore } from '../src/runtime/store.ts';
import type { RunHandle, RunRequest, RunResult } from '../src/core/types.ts';
import type { DecisionProvider, DecisionRequest } from '../src/decision/types.ts';
import { INITIAL_AGENT_MODEL_ID } from '../src/decision/initial-assignment.ts';
import { WORKFLOW_PLAN_ID } from '../src/decision/plan-choice.ts';
import { ACCEPTANCE_MATERIAL_FIELD, ORCHESTRATION_ACTION_ID } from '../src/orchestration/decision-loop.ts';
import {
  USER_MODEL_POOL_POLICY,
  type UserModelPool,
  type UserModelPoolEntry,
} from '../src/orchestration/model-pool.ts';
import type { RoundWorkbenchObservation } from '../src/cli/round-observation.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];
const tmpDirs: string[] = [];
const cleanupFailures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; process.stdout.write(`  ok   ${name}\n`); }
  else { failed++; failures.push(name + (detail ? ` - ${detail}` : '')); process.stdout.write(`  FAIL ${name}${detail ? ` - ${detail}` : ''}\n`); }
}
function section(t: string): void { process.stdout.write(`\n== ${t} ==\n`); }
function ownDir(prefix: string): string { const d = mkdtempSync(join(tmpdir(), prefix)); tmpDirs.push(d); return d; }
function removeOwnedDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); }
  catch (e) { cleanupFailures.push(`owned dir removal threw for ${dir}: ${(e as Error).message}`); return; }
  if (existsSync(dir)) cleanupFailures.push(`owned dir ${dir} still present after removal`);
}
async function captureRun(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = '';
  let err = '';
  process.stdout.write = ((c: string | Uint8Array): boolean => { out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8'); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array): boolean => { err += typeof c === 'string' ? c : Buffer.from(c).toString('utf8'); return true; }) as typeof process.stderr.write;
  try { return { code: await fn(), out, err }; }
  finally { process.stdout.write = origOut; process.stderr.write = origErr; }
}

const A = 'agent-a';
const MA = 'agent-a/m1';
const M2 = 'agent-a/m2';
const DECL = 'agent-a/declared';
const NOW = 1_700_000_000_000;

/** A live declaration (admitted at NOW): observed in the past, expiring far ahead. */
const liveDecl = (agentId: string, modelId: string, over: Partial<UserModelPoolEntry> = {}): UserModelPoolEntry => ({
  agentId, modelId, billing: 'free', source: 'b22 declaration',
  observedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER, ...over,
});
const poolOf = (...entries: UserModelPoolEntry[]): UserModelPool => ({ policy: USER_MODEL_POOL_POLICY, models: entries });

const emptyStore = { listThreads: () => [], listTasks: () => [] } as never;
const descriptor = (id: string) => ({
  id, displayName: id,
  launcher: { kind: 'native', command: id, prefixArgs: [], target: id, buildsCommandString: false },
  transport: 'cli-jsonl',
  capabilities: { newTask: true, review: true, modelSelection: true, resume: true },
} as never);

function probeFor(agentId: string, status: 'available' | 'unknown' | 'not_fetched' = 'available', modelHint: string | null = null): QuotaProbe {
  return {
    agentId, provider: agentId,
    records: [{ provider: agentId, agentId, modelId: null, source: 'locally_observed', usage: null, remaining: null, resetAt: null, period: 'day', status, usageClass: 'observed', confidence: 'high', observedAt: NOW, note: '' }],
    login: 'stubbed for test', version: '0.0.0-test', modelHint, providerHint: null, error: null,
  } as unknown as QuotaProbe;
}

/**
 * The whole suite runs inside one try/finally so that a fatal error (an unexpected
 * throw, e.g. a review edge that should have been unreachable) is REPORTED as a fatal
 * error and every owned temp dir recorded through `ownDir` is still removed. The exit
 * code is a SINGLE decision over assertion failures + fatal error + cleanup ledger; a
 * fatal error can never be downgraded to a PASS.
 */
let fatal: Error | null = null;

try {

// =========================================================================
section('seedRegistry: no pool leaves the existing derivation unchanged');

{
  const none = seedRegistry({ store: emptyStore }, [], NOW);
  check('empty inputs, no pool: no entries', none.list().length === 0, `${none.list().length}`);

  const named = seedRegistry({ store: emptyStore, configs: { [A]: { model: MA } } as never, descriptors: [descriptor(A)] }, [], NOW);
  check('no pool: only the configured model is seeded, with config provenance',
    named.list().length === 1 && named.list()[0]!.modelSource === 'orchestrator config', JSON.stringify(named.list()));
  check('no pool: no entry carries a user-pool provenance',
    named.list().every((e) => !e.modelSource.includes('user model pool')));
}

// =========================================================================
section('seedRegistry: explicit pool seeds exact admitted declarations (unknown, honest source)');

{
  const pool = poolOf(
    liveDecl(A, MA, { source: 'src-a' }),
    liveDecl(A, M2, { source: 'src-b', billing: 'included' }),
  );
  const reg = seedRegistry({ store: emptyStore, userModelPool: pool }, [], NOW);
  const list = reg.list();
  check('both admitted declarations register exactly (one row each)', list.length === 2, `${list.length}`);
  const e1 = reg.get(A, MA);
  const e2 = reg.get(A, M2);
  check('the full model id is preserved byte-for-byte', e1?.modelId === MA && e2?.modelId === M2);
  check('each carries honest user-declaration provenance including its source',
    e1?.modelSource === 'user model pool (declared: src-a)' && e2?.modelSource === 'user model pool (declared: src-b)',
    JSON.stringify([e1?.modelSource, e2?.modelSource]));
  check('each is a declaration-only pair and stays unknown (never callable/free)',
    e1?.availability === 'unknown' && e2?.availability === 'unknown' &&
    reg.effectiveAvailability(A, MA) === 'unknown' && reg.effectiveAvailability(A, M2) === 'unknown');
}

// =========================================================================
section('seedRegistry: only PRESENTLY admitted declarations introduce a candidate');

{
  const pool = poolOf(
    liveDecl(A, MA, { billing: 'paid' }),
    liveDecl(A, M2, { billing: 'unknown' }),
    liveDecl(A, 'agent-a/expired', { observedAt: 0, expiresAt: NOW }),
    liveDecl(A, 'agent-a/future', { observedAt: NOW + 10, expiresAt: NOW + 20 }),
    liveDecl(A, 'agent-a/ok', { source: 'admitted' }),
  );
  const reg = seedRegistry({ store: emptyStore, userModelPool: pool }, [], NOW);
  const list = reg.list();
  check('paid / unknown / expired / not-yet-effective declarations introduce no candidate',
    list.length === 1 && list[0]!.modelId === 'agent-a/ok', JSON.stringify(list.map((e) => e.modelId)));
}

// =========================================================================
section('seedRegistry: a duplicate preserves existing provenance and facts (no second row)');

{
  const cfg = seedRegistry(
    { store: emptyStore, configs: { [A]: { model: MA } } as never, descriptors: [descriptor(A)], userModelPool: poolOf(liveDecl(A, MA, { source: 'dupe' })) },
    [],
    NOW,
  );
  const cfgRows = cfg.list().filter((e) => e.modelId === MA);
  check('a config duplicate is not re-registered', cfgRows.length === 1, `${cfgRows.length}`);
  check('the config provenance survives untouched', cfgRows[0]?.modelSource === 'orchestrator config', String(cfgRows[0]?.modelSource));

  const prb = seedRegistry({ store: emptyStore, userModelPool: poolOf(liveDecl(A, MA)) }, [probeFor(A, 'available', MA)], NOW);
  const prbRows = prb.list().filter((e) => e.modelId === MA);
  check('a probe duplicate is not overwritten', prbRows.length === 1 && prbRows[0]?.modelSource === `${A} CLI probe`, JSON.stringify(prbRows.map((e) => e.modelSource)));

  const threadStore = { listThreads: () => [{ agentId: A, model: MA }], listTasks: () => [] } as never;
  const thr = seedRegistry({ store: threadStore, userModelPool: poolOf(liveDecl(A, MA)) }, [], NOW);
  const thrRows = thr.list().filter((e) => e.modelId === MA);
  check('a thread-store duplicate is not overwritten', thrRows.length === 1 && thrRows[0]?.modelSource === 'thread store (observed)', JSON.stringify(thrRows.map((e) => e.modelSource)));
}

// =========================================================================
section('buildQuotaCenter/applyPolicy: a declaration-only pair is NOT promoted by an agent-family fact');

{
  const pool = poolOf(liveDecl(A, MA));
  const center = await buildQuotaCenter({
    store: emptyStore,
    observed: [],
    probes: [probeFor(A, 'available', null)],
    descriptors: [descriptor(A)],
    installed: { [A]: true },
    userModelPool: pool,
    now: NOW,
  });
  const row = center.modelRegistry.find((r) => r.model === MA);
  check('the declaration-only pair reached the centre view', row !== undefined, JSON.stringify(center.modelRegistry));
  check('it stays unknown despite the installed/available agent and a sibling probe (no modelHint)',
    row?.availability === 'unknown', JSON.stringify(row));

  const control = await buildQuotaCenter({
    store: emptyStore,
    observed: [],
    probes: [probeFor(A, 'available', null)],
    descriptors: [descriptor(A)],
    installed: { [A]: true },
    configs: { [A]: { model: 'agent-a/cfg' } } as never,
    now: NOW,
  });
  const cfgRow = control.modelRegistry.find((r) => r.model === 'agent-a/cfg');
  check('control: a normal config pair under the SAME agent IS available (the test is meaningful)',
    cfgRow?.availability === 'available', JSON.stringify(cfgRow));
}

// =========================================================================
section('runRoundCli: the real round seeds the declared candidate (wiring) and refuses it');

interface CliRound {
  code: number;
  out: string;
  err: string;
  requests: RunRequest[];
  report: Record<string, unknown>;
  snapshots: RoundWorkbenchObservation[];
  dir: string;
}

async function runRound(opts: {
  poolEntries?: UserModelPoolEntry[];
  noPool?: boolean;
  probeStatus?: 'available' | 'unknown' | 'not_fetched';
  probeModelHint?: string | null;
  fixedPair?: { agent: string; model: string };
}): Promise<CliRound> {
  const dir = ownDir('b22-round-');
  const reportDir = join(ownDir('b22-rep-'), 'reports');
  const requests: RunRequest[] = [];
  const snapshots: RoundWorkbenchObservation[] = [];
  // Only the store/review edges the round needs. The run edge itself is controlled by
  // `drivable.run` below and `--no-review` is always passed, so no RuntimeOrchestrator
  // (and none of its real Agent factories) is constructed here.
  const store = new SessionStore(join(dir, '.store'));
  let runN = 0;
  const drivable = {
    agentIds: () => [A],
    descriptors: () => [descriptor(A)],
    configFor: () => ({}),
    store,
    review: (_req: Omit<RunRequest, 'mode'>): RunHandle => {
      throw new Error('unexpected review invoked: the round passed --no-review and configures no real reviewer');
    },
    run(req: RunRequest): RunHandle {
      requests.push(req);
      runN += 1;
      const role = /:: ([\w-]+) — deliverable:/.exec(req.prompt)?.[1] ?? 'unknown';
      const result: RunResult = {
        taskId: `t${runN}`, threadId: null, agentId: req.agentId,
        state: 'succeeded', startedAt: NOW, endedAt: NOW,
        exitCode: 0, signal: null, output: `OUT_${role}`, outputTruncated: false, transcriptPath: null,
        usage: {}, toolCalls: [], error: null, diagnostics: [],
        cleanup: { rootKilled: false, descendantsReaped: false, note: '', treeStopConfirmed: true, processStart: 'started' },
      };
      return { result: async () => result } as unknown as RunHandle;
    },
  };
  const provider: DecisionProvider = {
    name: 'b22-cli-seam',
    async probe() { return { ok: true, endpoint: 'seam://laya', detail: 'test seam', warnings: [] }; },
    async decide(request: DecisionRequest) {
      const answers: Record<string, unknown> = {};
      for (const [key, q] of Object.entries(request.questions)) {
        if (q.type === 'choice') {
          const offered = Object.keys((q.criteria ?? {}) as Record<string, string>);
          const pick = (value: string, parameters: Record<string, string> = {}): Record<string, unknown> => {
            const probabilities: Record<string, number> = {};
            for (const o of offered) probabilities[o] = o === value ? 1 : 0;
            return { type: 'choice', choice: value, probabilities, confidence: 1, parameters };
          };
          if (key === ORCHESTRATION_ACTION_ID) {
            const state = JSON.parse(String((request.state as Record<string, string> | undefined)?.[ORCHESTRATION_ACTION_ID] ?? '{}')) as { tasks?: Array<{ taskId: string; status: string }> };
            const tasks = state.tasks ?? [];
            const toVerify = tasks.find((t) => t.status === 'to_verify');
            const pending = tasks.find((t) => t.status === 'planned' || t.status === 'queued');
            let action = 'wait';
            const parameters: Record<string, string> = {};
            const rawMaterial = (request.state as Record<string, string> | undefined)?.[ACCEPTANCE_MATERIAL_FIELD];
            if (toVerify !== undefined && rawMaterial !== undefined) {
              const material = JSON.parse(rawMaterial) as { entries: Array<{ taskId: string; acceptanceCriteria: string; output: string; executionMissing: boolean }> };
              const entry = material.entries.find((e) => e.taskId === toVerify.taskId);
              const token = entry === undefined ? '' : (entry.acceptanceCriteria.split(':: ')[1] ?? '').split(' —')[0] ?? '';
              if (entry !== undefined && !entry.executionMissing && entry.output.trim() !== '' && entry.output.includes(token)) {
                action = 'complete';
                parameters.taskId = entry.taskId;
                parameters.reason = 'its own output shows its own deliverable';
              }
            } else if (toVerify === undefined && pending !== undefined) {
              action = 'continue';
            }
            answers[key] = pick(action, parameters);
            continue;
          }
          if (key === WORKFLOW_PLAN_ID) { answers[key] = pick('lean'); continue; }
          if (key === INITIAL_AGENT_MODEL_ID) { answers[key] = pick(offered[0]!); continue; }
          answers[key] = pick(offered[0]!);
          continue;
        }
        if (q.type === 'score') {
          const levels = q.criteria as string[];
          const index = Math.max(0, levels.indexOf('small'));
          const probabilities: Record<string, number> = {};
          for (let i = 0; i < levels.length; i++) probabilities[String(i)] = i === index ? 1 : 0;
          const legend: Record<string, string> = {};
          for (let i = 0; i < levels.length; i++) legend[String(i)] = levels[i]!;
          answers[key] = { type: 'score', score: index, level: levels[index]!, levels: [...levels], probabilities, legend, confidence: 1 };
          continue;
        }
        if (q.type === 'noul') { answers[key] = { type: 'noul', noul: 0 }; continue; }
        answers[key] = { type: (q as unknown as { type: string }).type };
      }
      return { answers, provider: { name: 'b22-cli-seam', details: 'stub Laya' }, raw: {} } as never;
    },
  };

  let poolPath: string | null = null;
  if (opts.noPool !== true) {
    poolPath = join(dir, 'pool.json');
    writeFileSync(poolPath, JSON.stringify({
      policy: USER_MODEL_POOL_POLICY,
      models: opts.poolEntries ?? [],
    }), 'utf8');
  }
  const argv = [
    'do the thing',
    '--json', '--cwd', dir, '--max-children', '2', '--max-concurrent', '1',
    '--workflow', 'sequential', '--workflow-choice', 'lean',
    '--no-review',
    ...(poolPath === null ? [] : ['--model-pool', 'pool.json']),
    ...(opts.fixedPair === undefined ? [] : ['--select', 'fixed', '--agent', opts.fixedPair.agent, '--model', opts.fixedPair.model]),
  ];
  const res = await captureRun(() => runRoundCli(drivable as never, argv, {
    provider,
    probes: [probeFor(A, opts.probeStatus ?? 'available', opts.probeModelHint ?? null)],
    roundResultDir: reportDir,
    onWorkbenchSnapshot: (s) => snapshots.push(s),
  }));
  const jsonStart = res.out.indexOf('{');
  let report: Record<string, unknown> = {};
  if (jsonStart !== -1) { try { report = JSON.parse(res.out.slice(jsonStart)) as Record<string, unknown>; } catch { report = {}; } }
  return { ...res, requests, report, snapshots, dir };
}

// --- wiring: the declared pair reaches the registry/candidate path, then is refused --
{
  const r = await runRound({
    probeModelHint: null,
    probeStatus: 'available',
    poolEntries: [liveDecl(A, DECL, { source: 'b22 wiring fixture' })],
  });
  check('wiring: the round refuses (exit 1), nothing ran', r.code === 1, `${r.code}: ${r.err.slice(0, 160)}`);
  check('wiring: the declared pair reached the ACTUAL candidate path (initial selection bound it by the pool rule)',
    r.snapshots.some((s) => s.initialSelections.some((sel) => sel.ok && sel.agentId === A && sel.modelId === DECL)),
    JSON.stringify(r.snapshots.map((s) => s.initialSelections)));
  const unassigned = (r.report.unassigned ?? []) as Array<{ code: string; reason: string | null }>;
  check('wiring: assignment refused the genuinely unknown pair (no-available-agent), not a missing candidate',
    unassigned.length > 0 && unassigned.every((u) => u.code === 'no-available-agent'), JSON.stringify(unassigned));
  check('wiring: the real runtime ran ZERO times', r.requests.length === 0, `requests=${r.requests.length}`);
}

// --- rejected pool entry (paid): a registered candidate is still excluded from the offer --
{
  const r = await runRound({
    probeModelHint: MA,
    probeStatus: 'available',
    poolEntries: [liveDecl(A, MA, { billing: 'paid' })],
  });
  check('rejected(paid): the round refuses (exit 1)', r.code === 1, `${r.code}: ${r.err.slice(0, 160)}`);
  check('rejected(paid): the paid declaration never becomes an offered candidate',
    r.snapshots.some((s) => s.initialSelections.some((sel) => !sel.ok)), JSON.stringify(r.snapshots.map((s) => s.initialSelections)));
  check('rejected(paid): the real runtime ran ZERO times', r.requests.length === 0, `requests=${r.requests.length}`);
}

// --- unknown quota never runs --
{
  const r = await runRound({
    probeModelHint: MA,
    probeStatus: 'unknown',
    fixedPair: { agent: A, model: MA },
    poolEntries: [liveDecl(A, MA)],
  });
  check('unknown quota: the round refuses (exit 1)', r.code === 1, `${r.code}: ${r.err.slice(0, 160)}`);
  const unassigned = (r.report.unassigned ?? []) as Array<{ code: string }>;
  check('unknown quota: every candidate is blocked by quota', unassigned.length > 0 && unassigned.every((u) => u.code === 'quota-blocked'), JSON.stringify(unassigned));
  check('unknown quota: the real runtime ran ZERO times', r.requests.length === 0, `requests=${r.requests.length}`);
}

// --- control: a legitimate probed candidate + an explicit pool still executes, pair unchanged --
{
  const r = await runRound({
    probeModelHint: MA,
    probeStatus: 'available',
    fixedPair: { agent: A, model: MA },
    poolEntries: [liveDecl(A, MA)],
  });
  check('control: the round completes (exit 0)', r.code === 0, `${r.code}: ${r.err.slice(0, 200)}`);
  check('control: the fixed exact pair reached every run unchanged',
    r.requests.length === 2 && r.requests.every((req) => req.agentId === A && req.model === MA),
    r.requests.map((req) => `${req.agentId}/${String(req.model)}`).join(','));
  check('control: the declaration-only duplicate did not overwrite the probed candidate',
    r.snapshots.some((s) => s.initialSelections.some((sel) => sel.ok && sel.agentId === A && sel.modelId === MA)),
    JSON.stringify(r.snapshots.map((s) => s.initialSelections)));
}

// --- default (no pool): unchanged, the same round still executes --
{
  const r = await runRound({
    noPool: true,
    probeModelHint: MA,
    probeStatus: 'available',
    fixedPair: { agent: A, model: MA },
  });
  check('no pool: the round still executes normally (exit 0)', r.code === 0, `${r.code}: ${r.err.slice(0, 200)}`);
  check('no pool: the pair reached the runtime unchanged',
    r.requests.length === 2 && r.requests.every((req) => req.agentId === A && req.model === MA),
    r.requests.map((req) => `${req.agentId}/${String(req.model)}`).join(','));
  check('no pool: the report carries no modelPool block', !('modelPool' in r.report), JSON.stringify(Object.keys(r.report)));
}

// --- malformed input is refused before any runtime call --
{
  const dir = ownDir('b22-bad-');
  const badPath = join(dir, 'bad.json');
  writeFileSync(badPath, '{ not json', 'utf8');
  let calls = 0;
  const stub = {
    descriptors: () => { calls++; return []; },
    agentIds: () => { calls++; return []; },
    configFor: () => { calls++; return {}; },
  } as never;
  const res = await captureRun(() => runRoundCli(stub, ['do the thing', '--workflow', 'sequential', '--model-pool', badPath], {}));
  check('malformed pool: refused with exit 2', res.code === 2, String(res.code));
  check('malformed pool: ZERO runtime calls', calls === 0, `calls=${calls}`);
}

} catch (e) {
  fatal = e instanceof Error ? e : new Error(String(e));
  process.stdout.write(`\nFATAL: ${fatal.message}\n`);
  if (fatal.stack !== undefined) process.stdout.write(`${fatal.stack}\n`);
} finally {
  for (const d of tmpDirs) removeOwnedDir(d);
}

// =========================================================================

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
if (cleanupFailures.length) process.stdout.write(`cleanup failures (must fail the test):\n  ${cleanupFailures.map((f) => `- ${f}`).join('\n  ')}\n`);
if (fatal !== null) process.stdout.write(`fatal error (must fail the test): ${fatal.message}\n`);
process.stdout.write('\n');
process.exitCode = fatal === null && failed === 0 && cleanupFailures.length === 0 ? 0 : 1;
