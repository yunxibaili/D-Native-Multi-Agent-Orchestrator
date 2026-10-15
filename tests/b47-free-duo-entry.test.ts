/**
 * tests/b47-free-duo-entry.test.ts — B4.7.1 HERMETIC ENTRY tests.
 *
 * ============================================================================
 * WHAT THIS PROVES
 * ============================================================================
 * That the B4.7.1 free-duo ENTRY's GUARD PATHS are enforced, by running the REAL entry
 * (`tests/b47-free-duo.test.ts`) as a REAL CHILD PROCESS and asserting its ACTUAL exit
 * status — never a matched string alone. The cases:
 *
 *   1. NOT ENABLED          unset / "0" -> exit 0, NOT_RUN, no owned root, no PASS.
 *   2. ENABLED, no fee      opt-in but no declaration -> NON-ZERO, no PASS, no root.
 *   3. ENABLED, malformed   declaration is not JSON -> NON-ZERO, no PASS, no root.
 *   4. ENABLED, expired     scope / fee entry expired -> NON-ZERO, no PASS, no root.
 *   5. ENABLED, paid/unknown billing -> NON-ZERO, no PASS, no root.
 *   6. ENABLED, valid declaration, NO version declared -> refused PRE-LAUNCH for an
 *      UNKNOWN installed version -> NON-ZERO, no PASS, no root (nothing launched).
 *   7. ENABLED, valid declaration, UNSUPPORTED version -> refused PRE-LAUNCH.
 *
 * It ALSO exercises the pure aux-config builder, the version-matched containment check,
 * the fail-closed cleanup-eligibility decision, and the ACTUAL Node deliverable checks
 * (a zero-byte / wrong `add.mjs` MUST fail real verification) under a test-owned context.
 *
 * ============================================================================
 * HERMETIC BY CONSTRUCTION
 * ============================================================================
 * No real agent is ever started. Every entry child receives a COPY of the environment
 * and a deliberately UNREACHABLE `ORCH_B47_OPENCODE_COMMAND`, so even a bug that let a
 * case through discovery cannot reach an installed agent. The deliverable checks run
 * only `node` (this process's own binary), never the installed OpenCode CLI. The parent
 * `process.env` is never mutated. The pure gate + import safety are exercised in-process.
 *
 * Run: node tests/b47-free-duo-entry.test.ts
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  B47_ADMISSION_SEAM_LABEL,
  B47_AUX_UNKNOWNS,
  B47_CANDIDATE_PAIRS,
  B47_CONSUMER_DIR,
  B47_CONSUMER_IMPORT,
  B47_CONSUMER_TEST,
  B47_DECLARATION_ENV,
  B47_DEMO_GUIDANCE,
  B47_DEMO_README,
  B47_DEMO_OBJECTIVE,
  B47_EVIDENCE_ENV,
  B47_INTEGRATION_DIR,
  B47_OPENCODE_COMMAND_ENV,
  B47_OPENCODE_VERSION_ENV,
  B47_OPT_IN_ENV,
  B47_PROVIDER_ADD,
  B47_PROVIDER_DIR,
  B47_REPORT_ENV,
  B47_SUPPORTED_OPENCODE_VERSIONS,
  buildB47AuxConfig,
  decideCleanupEligibility,
  evaluateB47Entry,
  prepareB47Demo,
  runB47AdmissionProbe,
  verifyAuxiliaryModelContainment,
  verifyDeliverable,
  type B47OwnCommandFact,
} from './b47-free-duo.test.ts';
import { buildCollaborationCandidates, collaborationTaskIds } from '../src/orchestration/collab-plan.ts';
import { readControlRecord } from '../src/runtime/containment.ts';
import { ownedRootOfThisProcess, setupOwnedTestContext } from './helpers/real-agent-isolation.ts';

const REPO = process.cwd();
const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, 'b47-free-duo.test.ts');

const tmpDirs: string[] = [];
const reportFiles: string[] = [];
const ownDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'b47ef-'));
  tmpDirs.push(d);
  return d;
};

let passed = 0;
let failed = 0;
const failures: string[] = [];
const cleanupFailures: string[] = [];
function recordCleanupFailure(detail: string): void { cleanupFailures.push(detail); }
function finalizeExitCode(): number { return failed === 0 && cleanupFailures.length === 0 ? 0 : 1; }
function removeOwnedDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    recordCleanupFailure(`owned dir removal threw for ${dir}: ${(e as Error).message}`);
    return;
  }
  if (existsSync(dir)) recordCleanupFailure(`owned dir ${dir} still present after removal`);
}
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; process.stdout.write(`  ok   ${name}\n`); }
  else { failed++; failures.push(`${name}${detail ? ` - ${detail}` : ''}`); process.stdout.write(`  FAIL ${name}${detail ? ` - ${detail}` : ''}\n`); }
}
function section(t: string): void { process.stdout.write(`\n== ${t}\n`); }

/** A child environment that is a COPY of the parent's, with explicit overrides. */
function childEnv(over: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const [k, v] of Object.entries(over)) { if (v === undefined) delete env[k]; else env[k] = v; }
  return env;
}

interface RunResult { status: number | null; signal: string | null; error: string | null; stdout: string }
function runEntry(env: Record<string, string>): RunResult {
  const res = spawnSync(process.execPath, [ENTRY], { cwd: REPO, env, encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    status: res.status,
    signal: res.signal,
    error: res.error ? String((res.error as Error).message) : null,
    stdout: res.stdout ?? '',
  };
}

const reportPathFor = (label: string): string => {
  const p = join(tmpdir(), `b47ef-report-${label}-${process.pid}.json`);
  reportFiles.push(p);
  return p;
};
function readReport(path: string): { status?: string; code?: string | null; ownedRoot?: string | null } | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as { status?: string; code?: string | null; ownedRoot?: string | null }; }
  catch { return null; }
}

/** The bounded declaration envelope, built from the entry's own fixed candidates. */
function declaration(over: {
  billing?: string;
  feeExpiresAt?: number;
  observedAt?: number;
  scope?: 'demo-only' | 'production-only' | 'missing';
  scopeExpiresAt?: number;
  dropModels?: number;
} = {}): string {
  const now = Date.now();
  const pairs = over.dropModels !== undefined ? B47_CANDIDATE_PAIRS.slice(0, over.dropModels) : B47_CANDIDATE_PAIRS;
  const fee = {
    policy: 'no-additional-charge',
    models: pairs.map((p) => ({
      agentId: p.agentId,
      modelId: p.modelId,
      billing: over.billing ?? 'free',
      source: 'b47 entry test fixture',
      observedAt: over.observedAt ?? now - 1_000,
      expiresAt: over.feeExpiresAt ?? now + 3_600_000,
    })),
  };
  const scopeMissing = over.scope === 'missing';
  return JSON.stringify(scopeMissing
    ? { fee }
    : { fee, scope: { kind: over.scope ?? 'demo-only', expiresAt: over.scopeExpiresAt ?? now + 3_600_000 } });
}

// ===========================================================================
section('import safety: importing the ENTRY runs nothing and creates no owned root');

check('importing the entry created no owned root', ownedRootOfThisProcess() === null, String(ownedRootOfThisProcess()));
{
  // A child that ONLY imports the module (opt-in ON, valid declaration) must not run main.
  const dir = ownDir();
  const decl = join(dir, 'decl.json');
  writeFileSync(decl, declaration(), 'utf8');
  const code = [
    `const { pathToFileURL } = await import('node:url');`,
    `const url = process.env.B47EF_ENTRY_URL;`,
    `await import(url);`,
    `console.log('IMPORT_ONLY_OK');`,
  ].join('\n');
  const entryUrl = pathToFileURL(ENTRY).href;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: REPO,
    env: childEnv({
      B47EF_ENTRY_URL: entryUrl,
      [B47_OPT_IN_ENV]: '1',
      [B47_DECLARATION_ENV]: decl,
      [B47_OPENCODE_COMMAND_ENV]: join(dir, 'no-such-opencode.exe'),
    }),
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  check('import-only child exits 0', res.status === 0 && res.signal === null, `status=${String(res.status)} signal=${String(res.signal)} error=${res.error ? String((res.error as Error).message) : 'none'}`);
  check('import-only child printed no ENTRY header and no refusal', !/B4\.7\.1 real OpenCode/.test(res.stdout ?? '') && !/REFUSED/.test(res.stdout ?? ''), (res.stdout ?? '').slice(-200));
  check('import-only child reached IMPORT_ONLY_OK', /IMPORT_ONLY_OK/.test(res.stdout ?? ''), (res.stdout ?? '').slice(-200));
}

// ===========================================================================
section('pure gate: entitlement + demo-only scope, through the existing model-pool predicate');

// A fixed PAST anchor used only to build expired declarations; the gate is evaluated at
// the real clock so a freshly written (valid) declaration is genuinely in force.
const NOW = 1_700_000_000_000;
const gate = (env: Record<string, string | undefined>, text: string): ReturnType<typeof evaluateB47Entry> =>
  evaluateB47Entry({ env, now: Date.now(), readText: () => text });

{
  const envOn = { [B47_OPT_IN_ENV]: '1', [B47_DECLARATION_ENV]: 'decl.json' };

  check('unset opt-in => NOT_RUN', gate({}, declaration()).status === 'NOT_RUN');
  check('opt-in "0" => NOT_RUN', gate({ ...envOn, [B47_OPT_IN_ENV]: '0' }, declaration()).status === 'NOT_RUN');
  check('opt-in "true" is not the exact "1" => NOT_RUN', gate({ ...envOn, [B47_OPT_IN_ENV]: 'true' }, declaration()).status === 'NOT_RUN');

  const missing = gate({ [B47_OPT_IN_ENV]: '1' }, declaration());
  check('opt-in without a declaration => REFUSED b47-fee-declaration-missing', missing.status === 'REFUSED' && missing.code === 'b47-fee-declaration-missing', JSON.stringify(missing));

  const malformed = gate(envOn, '{ not json');
  check('malformed declaration => REFUSED b47-fee-declaration-malformed', malformed.status === 'REFUSED' && malformed.code === 'b47-fee-declaration-malformed', JSON.stringify(malformed));

  const missingScope = gate(envOn, declaration({ scope: 'missing' }));
  check('missing scope => REFUSED b47-scope-missing', missingScope.status === 'REFUSED' && missingScope.code === 'b47-scope-missing', JSON.stringify(missingScope));

  const notDemo = gate(envOn, declaration({ scope: 'production-only' }));
  check('scope not "demo-only" => REFUSED b47-scope-not-demo-only', notDemo.status === 'REFUSED' && notDemo.code === 'b47-scope-not-demo-only', JSON.stringify(notDemo));

  const expiredScope = gate(envOn, declaration({ scopeExpiresAt: NOW - 1 }));
  check('expired scope => REFUSED b47-scope-expired', expiredScope.status === 'REFUSED' && expiredScope.code === 'b47-scope-expired', JSON.stringify(expiredScope));

  const expiredFee = gate(envOn, declaration({ observedAt: 1, feeExpiresAt: NOW - 1 }));
  check('expired fee entry => REFUSED b47-candidate-not-admitted', expiredFee.status === 'REFUSED' && expiredFee.code === 'b47-candidate-not-admitted', JSON.stringify(expiredFee));

  const paid = gate(envOn, declaration({ billing: 'paid' }));
  check('paid billing => REFUSED b47-candidate-not-admitted', paid.status === 'REFUSED' && paid.code === 'b47-candidate-not-admitted', JSON.stringify(paid));

  const unknown = gate(envOn, declaration({ billing: 'unknown' }));
  check('unknown billing => REFUSED b47-candidate-not-admitted', unknown.status === 'REFUSED' && unknown.code === 'b47-candidate-not-admitted', JSON.stringify(unknown));

  const oneCandidate = gate(envOn, declaration({ dropModels: 1 }));
  check('only one fixed candidate declared => REFUSED b47-candidate-not-admitted', oneCandidate.status === 'REFUSED' && oneCandidate.code === 'b47-candidate-not-admitted', JSON.stringify(oneCandidate));

  const valid = gate(envOn, declaration());
  check('a valid declaration + demo-only scope => ENABLED', valid.status === 'ENABLED', JSON.stringify(valid));
}

// ===========================================================================
section('aux containment: version-matched, bounded config, honest unknowns');

{
  const cfg = buildB47AuxConfig();
  check('aux main_model is an allowed full free id', B47_CANDIDATE_PAIRS.some((p) => p.modelId === cfg.mainModel), cfg.mainModel);
  check('aux small_model is an allowed full free id', B47_CANDIDATE_PAIRS.some((p) => p.modelId === cfg.smallModel), cfg.smallModel);
  check('aux config disables share', /"share":"disabled"/.test(cfg.content), cfg.content);
  check('aux config denies task delegation', /"task":false/.test(cfg.content), cfg.content);
  check('aux config sets main and small_model to full free ids', /"model":"opencode\/[^"]*free"/.test(cfg.content) && /"small_model":"opencode\/[^"]*-free"/.test(cfg.content), cfg.content);
  check('the retained unknowns are labelled', B47_AUX_UNKNOWNS.length >= 2 && B47_AUX_UNKNOWNS.every((u) => u.length > 0));

  const unknown = verifyAuxiliaryModelContainment(undefined);
  check('no declared version => refusal b47-aux-version-unknown',
    unknown.ok === false && unknown.code === 'b47-aux-version-unknown', JSON.stringify(unknown));

  const bad = verifyAuxiliaryModelContainment('9.9.9');
  check('unsupported version => refusal b47-aux-version-unsupported',
    bad.ok === false && bad.code === 'b47-aux-version-unsupported', JSON.stringify(bad));

  const good = verifyAuxiliaryModelContainment(B47_SUPPORTED_OPENCODE_VERSIONS[0]);
  check('supported version => contained with the bounded config',
    good.ok === true && good.code === 'b47-aux-contained' && good.version === B47_SUPPORTED_OPENCODE_VERSIONS[0], JSON.stringify(good));
}

// ===========================================================================
section('cleanup eligibility: fail-closed, own-command + control-record association');

{
  const fact = (disposition: B47OwnCommandFact['disposition'], stopConfirmed: boolean, label = 'c'): B47OwnCommandFact =>
    ({ label, kind: 'node-check', disposition, stopConfirmed });

  check('all started + stopped + matching records => eligible',
    decideCleanupEligibility({ commands: [fact('started', true), fact('started', true)], observedControlRecords: 2 }).eligible);
  check('a not-started command needs no record and is eligible',
    decideCleanupEligibility({ commands: [fact('not-started', false)], observedControlRecords: 0 }).eligible);
  check('an unconfirmed stop => NOT eligible',
    decideCleanupEligibility({ commands: [fact('started', false)], observedControlRecords: 1 }).eligible === false);
  check('a may-have-started command with no record => NOT eligible',
    decideCleanupEligibility({ commands: [fact('may-have-started', false)], observedControlRecords: 0 }).eligible === false);
  check('started + confirmed but a MISSING control record => NOT eligible',
    decideCleanupEligibility({ commands: [fact('started', true)], observedControlRecords: 0 }).eligible === false);
  check('started + confirmed but an EXTRA control record => NOT eligible',
    decideCleanupEligibility({ commands: [fact('started', true)], observedControlRecords: 2 }).eligible === false);
}

// ===========================================================================
section('child process: the REAL entry\'s actual exit status per guard path');

{
  const unreachable = join(ownDir(), 'no-such-opencode-here.exe');
  const baseDecl = join(ownDir(), 'decl.json');
  writeFileSync(baseDecl, declaration(), 'utf8');

  // 1. NOT ENABLED (unset and explicit "0").
  for (const value of [undefined, '0']) {
    const rep = reportPathFor(`notrun-${value ?? 'unset'}`);
    const r = runEntry(childEnv({
      [B47_OPT_IN_ENV]: value,
      [B47_OPENCODE_COMMAND_ENV]: unreachable,
      [B47_REPORT_ENV]: rep,
    }));
    const report = readReport(rep);
    check(`not-enabled(${value ?? 'unset'}): exits 0`, r.status === 0 && r.signal === null, `status=${String(r.status)} signal=${String(r.signal)} error=${r.error ?? 'none'}`);
    check(`not-enabled(${value ?? 'unset'}): prints NOT_RUN and no PASS`, /NOT_RUN/.test(r.stdout) && !/\bPASS\b/.test(r.stdout), r.stdout.slice(-200));
    check(`not-enabled(${value ?? 'unset'}): reports no owned root`, report !== null && report.ownedRoot === null, JSON.stringify(report));
  }

  // 2. ENABLED but no declaration.
  {
    const rep = reportPathFor('no-decl');
    const r = runEntry(childEnv({ [B47_OPT_IN_ENV]: '1', [B47_OPENCODE_COMMAND_ENV]: unreachable, [B47_REPORT_ENV]: rep }));
    const report = readReport(rep);
    check('enabled + no declaration: exits NON-ZERO', r.status !== 0 && r.status !== null && r.signal === null, `status=${String(r.status)} signal=${String(r.signal)}`);
    check('enabled + no declaration: no PASS', !/\bPASS\b/.test(r.stdout), r.stdout.slice(-300));
    check('enabled + no declaration: reports the missing-declaration code and no root',
      report !== null && report.code === 'b47-fee-declaration-missing' && report.ownedRoot === null, JSON.stringify(report));
  }

  // 3. ENABLED, malformed declaration.
  {
    const decl = join(ownDir(), 'bad.json');
    writeFileSync(decl, '{ not json', 'utf8');
    const rep = reportPathFor('malformed');
    const r = runEntry(childEnv({ [B47_OPT_IN_ENV]: '1', [B47_DECLARATION_ENV]: decl, [B47_OPENCODE_COMMAND_ENV]: unreachable, [B47_REPORT_ENV]: rep }));
    const report = readReport(rep);
    check('enabled + malformed declaration: exits NON-ZERO', r.status !== 0 && r.status !== null && r.signal === null, `status=${String(r.status)}`);
    check('enabled + malformed declaration: no PASS and no root',
      !/\bPASS\b/.test(r.stdout) && report !== null && report.ownedRoot === null && report.code === 'b47-fee-declaration-malformed', JSON.stringify(report));
  }

  // 4. ENABLED, expired scope.
  {
    const decl = join(ownDir(), 'expired-scope.json');
    writeFileSync(decl, declaration({ scopeExpiresAt: Date.now() - 1 }), 'utf8');
    const rep = reportPathFor('expired-scope');
    const r = runEntry(childEnv({ [B47_OPT_IN_ENV]: '1', [B47_DECLARATION_ENV]: decl, [B47_OPENCODE_COMMAND_ENV]: unreachable, [B47_REPORT_ENV]: rep }));
    const report = readReport(rep);
    check('enabled + expired scope: exits NON-ZERO, no PASS, no root',
      r.status !== 0 && !/\bPASS\b/.test(r.stdout) && report !== null && report.ownedRoot === null && report.code === 'b47-scope-expired', `status=${String(r.status)} ${JSON.stringify(report)}`);
  }

  // 5. ENABLED, paid billing.
  {
    const decl = join(ownDir(), 'paid.json');
    writeFileSync(decl, declaration({ billing: 'paid' }), 'utf8');
    const rep = reportPathFor('paid');
    const r = runEntry(childEnv({ [B47_OPT_IN_ENV]: '1', [B47_DECLARATION_ENV]: decl, [B47_OPENCODE_COMMAND_ENV]: unreachable, [B47_REPORT_ENV]: rep }));
    const report = readReport(rep);
    check('enabled + paid billing: exits NON-ZERO, no PASS, no root',
      r.status !== 0 && !/\bPASS\b/.test(r.stdout) && report !== null && report.ownedRoot === null && report.code === 'b47-candidate-not-admitted', `status=${String(r.status)} ${JSON.stringify(report)}`);
  }

  // 6. ENABLED, valid declaration, but NO version declared => refused pre-launch.
  {
    const rep = reportPathFor('aux-unknown');
    const r = runEntry(childEnv({ [B47_OPT_IN_ENV]: '1', [B47_DECLARATION_ENV]: baseDecl, [B47_OPENCODE_COMMAND_ENV]: unreachable, [B47_REPORT_ENV]: rep }));
    const report = readReport(rep);
    check('enabled + valid declaration + unknown version: exits NON-ZERO (nothing launched)', r.status !== 0 && r.status !== null && r.signal === null, `status=${String(r.status)} signal=${String(r.signal)}`);
    check('enabled + valid declaration + unknown version: no PASS', !/\bPASS\b/.test(r.stdout), r.stdout.slice(-400));
    check('enabled + valid declaration + unknown version: reports b47-aux-version-unknown and creates NO owned root',
      report !== null && report.status === 'ENABLED_REFUSED' && report.code === 'b47-aux-version-unknown' && report.ownedRoot === null, JSON.stringify(report));
  }

  // 7. ENABLED, valid declaration, UNSUPPORTED version => refused pre-launch.
  {
    const rep = reportPathFor('aux-unsupported');
    const r = runEntry(childEnv({ [B47_OPT_IN_ENV]: '1', [B47_DECLARATION_ENV]: baseDecl, [B47_OPENCODE_VERSION_ENV]: '9.9.9', [B47_OPENCODE_COMMAND_ENV]: unreachable, [B47_REPORT_ENV]: rep }));
    const report = readReport(rep);
    check('enabled + unsupported version: exits NON-ZERO, no PASS, no root',
      r.status !== 0 && !/\bPASS\b/.test(r.stdout) && report !== null && report.status === 'ENABLED_REFUSED' && report.code === 'b47-aux-version-unsupported' && report.ownedRoot === null, `status=${String(r.status)} ${JSON.stringify(report)}`);
  }
}

// ===========================================================================
section('ACTUAL Node verification: a zero-byte / wrong add.mjs MUST fail (real node, test-owned)');

{
  const ctx = setupOwnedTestContext();
  if (ctx === null) {
    process.stdout.write('  SKIP deliverable Node verification :: no sealed Job launcher on this machine\n');
  } else {
    try {
      const demo = ctx.dir('demo');
      const providerDir = join(demo, B47_PROVIDER_DIR);
      const consumerDir = join(demo, B47_CONSUMER_DIR);
      mkdirSync(providerDir, { recursive: true });
      mkdirSync(consumerDir, { recursive: true });
      const addPath = join(demo, B47_PROVIDER_ADD);
      const testPath = join(demo, B47_CONSUMER_TEST);

      writeFileSync(addPath, '', 'utf8');
      const empty = await verifyDeliverable(demo, { taskId: 't-empty', deliverable: 'add.mjs' });
      check('a ZERO-BYTE scoped src/provider/add.mjs fails the ACTUAL Node verification', empty.accepted === false, JSON.stringify({ exit: empty.exitCode, stdout: empty.stdout.slice(-120) }));

      writeFileSync(addPath, 'export const add = (a, b) => a - b;\n', 'utf8');
      const wrong = await verifyDeliverable(demo, { taskId: 't-wrong', deliverable: 'add.mjs' });
      check('a WRONG scoped add.mjs (subtracts) fails the ACTUAL Node verification', wrong.accepted === false, JSON.stringify({ exit: wrong.exitCode, stdout: wrong.stdout.slice(-120) }));

      writeFileSync(addPath, 'export const add = (a, b) => a + b;\n', 'utf8');
      const good = await verifyDeliverable(demo, { taskId: 't-good', deliverable: 'add.mjs' });
      check('a CORRECT scoped add.mjs passes the ACTUAL Node verification', good.accepted === true, JSON.stringify({ exit: good.exitCode, stdout: good.stdout.slice(-120) }));

      writeFileSync(testPath,
        "import test from 'node:test';\nimport assert from 'node:assert';\n" +
        `import { add } from '${B47_CONSUMER_IMPORT}';\n` +
        "test('adds', () => { assert.equal(add(2, 3), 5); assert.equal(add(-2, 3), 1); });\n",
        'utf8');
      const member2 = await verifyDeliverable(demo, { taskId: 't-test', deliverable: 'add.test.mjs' });
      check('member2 real node --test assertions pass', member2.accepted === true, JSON.stringify({ exit: member2.exitCode, stdout: member2.stdout.slice(-160) }));

      mkdirSync(join(demo, B47_INTEGRATION_DIR), { recursive: true });
      writeFileSync(join(demo, B47_INTEGRATION_DIR, 'combined.mjs'),
        "// integration of src/provider/add.mjs and src/consumer/add.test.mjs\n" +
        `import { add } from '../provider/add.mjs';\nexport const total = add(1, 2);\n`,
        'utf8');
      const integrator = await verifyDeliverable(demo, { taskId: 't-int', deliverable: 'integration' });
      check('integrator artifact referencing+consuming members with passing final tests is accepted', integrator.accepted === true, JSON.stringify({ exit: integrator.exitCode, stdout: integrator.stdout.slice(-160) }));

      const cf = await ctx.cleanup();
      for (const f of cf) recordCleanupFailure(`owned acceptance context: ${f.resource}: ${f.error}`);
      check('the owned acceptance context cleaned up', cf.length === 0, cf.map((f) => `${f.resource}: ${f.error}`).join('; '));
    } catch (e) {
      // A throw here must still fail the suite.
      check('the Node verification section completed without throwing', false, String((e as Error).message));
      const cf = await ctx.cleanup();
      for (const f of cf) recordCleanupFailure(`owned acceptance context: ${f.resource}: ${f.error}`);
    }
  }
}

// ===========================================================================
section('REAL Node check couples into the cleanup ledger (the SAME recording path as the real loop)');

{
  // B4.7.1a: the real loop pushes native command facts into ONE `commands` ledger and then
  // asks decideCleanupEligibility to compare the STARTED command count against the owned
  // control records. The contained Node deliverable checks run through the SAME contained
  // ManagedProcess path and therefore ALSO create an owned control record — so unless each
  // check records its OWN fact through this same sink, an all-success chain is wrongly
  // rejected (observed control records exceed the started command count). These cases use
  // the real recording path (the callback), not a re-created success assumption.
  const ctx = setupOwnedTestContext();
  if (ctx === null) {
    process.stdout.write('  SKIP Node-ledger coupling :: no sealed Job launcher on this machine\n');
  } else {
    try {
      const demo = ctx.dir('demo');
      const controlDir = ctx.controlDir;
      const controlNames = (): Set<string> =>
        new Set(existsSync(controlDir) ? readdirSync(controlDir).filter((n) => n.endsWith('.txt')) : []);
      const newValidControls = (before: ReadonlySet<string>): number => {
        try {
          return readdirSync(controlDir)
            .filter((n) => n.endsWith('.txt') && !before.has(n))
            .filter((n) => readControlRecord(join(controlDir, n)).ok)
            .length;
        } catch {
          return 0;
        }
      };

      // (1) A CORRECT add.mjs: the REAL contained Node check records exactly ONE own
      //     command fact through the same callback the real loop uses; it is positively
      //     started + stopped and its OWN control record validates => eligible cleanup.
      const addPath = join(demo, B47_PROVIDER_ADD);
      mkdirSync(join(demo, B47_PROVIDER_DIR), { recursive: true });
      writeFileSync(addPath, 'export const add = (a, b) => a + b;\n', 'utf8');
      const beforeGood = controlNames();
      const ledgerGood: B47OwnCommandFact[] = [];
      const good = await verifyDeliverable(demo, { taskId: 'ledger-good', deliverable: 'add.mjs' }, (f) => ledgerGood.push(f));
      const controlsGood = newValidControls(beforeGood);
      const eligGood = decideCleanupEligibility({ commands: ledgerGood, observedControlRecords: controlsGood });
      check('valid add: the real Node check contributes exactly ONE node-check fact',
        ledgerGood.length === 1 && ledgerGood[0]!.kind === 'node-check', JSON.stringify(ledgerGood));
      check('valid add: the fact is started + positively stopped and its own control validates',
        ledgerGood[0]!.disposition === 'started' && ledgerGood[0]!.stopConfirmed === true && controlsGood === 1,
        JSON.stringify({ fact: ledgerGood[0], controls: controlsGood }));
      check('valid add: the coupled ledger (own fact + own control) is ELIGIBLE',
        good.accepted === true && eligGood.eligible === true, JSON.stringify(eligGood));

      // (2) A WRONG add.mjs: the deliverable is REJECTED as a failure, but the command
      //     still ran and stopped confirmed, so its fact + own control stay matched. The
      //     failure is RETAINED without pretending the tree is unsafe.
      writeFileSync(addPath, 'export const add = (a, b) => a - b;\n', 'utf8');
      const beforeWrong = controlNames();
      const ledgerWrong: B47OwnCommandFact[] = [];
      const wrong = await verifyDeliverable(demo, { taskId: 'ledger-wrong', deliverable: 'add.mjs' }, (f) => ledgerWrong.push(f));
      const controlsWrong = newValidControls(beforeWrong);
      const eligWrong = decideCleanupEligibility({ commands: ledgerWrong, observedControlRecords: controlsWrong });
      check('wrong add: deliverable failure is retained though its stop is confirmed',
        wrong.accepted === false && ledgerWrong.length === 1 && ledgerWrong[0]!.stopConfirmed === true && eligWrong.eligible === true,
        JSON.stringify({ accepted: wrong.accepted, fact: ledgerWrong[0], elig: eligWrong }));

      // The original defect, reproduced exactly: a real contained Node check exists (its
      // one validated control record is owned) but no fact reached the ledger, so the
      // ledger is EMPTY. An empty ledger beside a real control record must NOT read safe.
      check('a real control record with an EMPTY ledger (the old defect) is INELIGIBLE',
        decideCleanupEligibility({ commands: [], observedControlRecords: controlsGood }).eligible === false);

      // (3) An UNCONFIRMED may-have-started command must make the whole ledger INELIGIBLE,
      //     so cleanup is retained rather than inferred safe. `runNodeCheck` emits exactly
      //     such an unconfirmed fact from its `finally` when a check throws after a
      //     possible start. The unconfirmed entry here is a LABELLED SYNTHETIC fixture (it
      //     is NOT physical evidence); the real Node check above supplies the one physical
      //     fact + control record this ledger is anchored to.
      const syntheticUnconfirmed: B47OwnCommandFact = {
        label: 'synthetic-unconfirmed', kind: 'node-check', disposition: 'may-have-started', stopConfirmed: false,
      };
      const eligUnconfirmed = decideCleanupEligibility({
        commands: [...ledgerGood, syntheticUnconfirmed],
        observedControlRecords: controlsGood + 1,
      });
      check('an unconfirmed / may-have-started command makes cleanup INELIGIBLE (no inferred safety)',
        eligUnconfirmed.eligible === false && eligUnconfirmed.reasons.some((r) => r.startsWith('unconfirmed-stop')),
        JSON.stringify(eligUnconfirmed));

      const cf = await ctx.cleanup();
      for (const f of cf) recordCleanupFailure(`Node-ledger coupling context: ${f.resource}: ${f.error}`);
      check('the Node-ledger coupling context cleaned up', cf.length === 0, cf.map((f) => `${f.resource}: ${f.error}`).join('; '));
    } catch (e) {
      // A throw here must still fail the suite, and must not leave an owned root behind.
      check('the Node-ledger coupling section completed without throwing', false, String((e as Error).message));
      const cf = await ctx.cleanup();
      for (const f of cf) recordCleanupFailure(`Node-ledger coupling context: ${f.resource}: ${f.error}`);
    }
  }
}

// ===========================================================================
section('B4.7.1b scoped-deliverable regression: SAME candidates, SAME verifier, scoped paths');

{
  // The proven defect: the built-in `duo` candidate member 1 declares `fileScope:
  // src/provider/**`, so a real agent correctly wrote `demo/src/provider/add.mjs` — yet the
  // verifier checked a ROOT `demo/add.mjs`, rejected the real delivery and blocked member 2
  // and integration. These cases inspect the SAME candidates the REAL entry builds (same
  // objective, same root) and run the SAME verifyDeliverable branches against the SCOPED
  // artifacts, with the SAME fact sink.
  const candidates = buildCollaborationCandidates('duo', B47_DEMO_OBJECTIVE, 'b47-duo');
  const ids = collaborationTaskIds('duo', 'b47-duo');
  const byId = new Map(candidates.map((c) => [c.taskId, c] as const));
  const member1 = byId.get(ids.memberIds[0]!);
  const member2 = byId.get(ids.memberIds[1]!);
  const integrator = byId.get(ids.integratorId);

  check('member 1 candidate criteria carry src/provider/** scope and the scoped provider path',
    member1 !== undefined
    && member1.description.includes(`file scope: ${B47_PROVIDER_DIR}/**`)
    && member1.description.includes(B47_PROVIDER_ADD),
    member1?.description ?? 'missing member 1 candidate');
  check('member 2 candidate criteria carry src/consumer/** scope and the scoped consumer path',
    member2 !== undefined
    && member2.description.includes(`file scope: ${B47_CONSUMER_DIR}/**`)
    && member2.description.includes(B47_CONSUMER_TEST),
    member2?.description ?? 'missing member 2 candidate');
  check('the integration candidate criteria name the src/integration artifact directory',
    integrator !== undefined && integrator.description.includes(B47_INTEGRATION_DIR),
    integrator?.description ?? 'missing integrator candidate');

  const ctx = setupOwnedTestContext();
  if (ctx === null) {
    process.stdout.write('  SKIP scoped-deliverable regression :: no sealed Job launcher on this machine\n');
  } else {
    try {
      const demo = ctx.dir('demo');
      const controlDir = ctx.controlDir;
      const providerDir = join(demo, B47_PROVIDER_DIR);
      const consumerDir = join(demo, B47_CONSUMER_DIR);
      const integrationDir = join(demo, B47_INTEGRATION_DIR);
      mkdirSync(providerDir, { recursive: true });
      mkdirSync(consumerDir, { recursive: true });
      mkdirSync(integrationDir, { recursive: true });
      const controlNames = (): Set<string> =>
        new Set(existsSync(controlDir) ? readdirSync(controlDir).filter((n) => n.endsWith('.txt')) : []);
      const newValidControls = (before: ReadonlySet<string>): number => {
        try {
          return readdirSync(controlDir)
            .filter((n) => n.endsWith('.txt') && !before.has(n))
            .filter((n) => readControlRecord(join(controlDir, n)).ok)
            .length;
        } catch {
          return 0;
        }
      };

      // (1) ROOT-ONLY DECOY: a CORRECT add.mjs at the demo ROOT while the SCOPED artifact is
      //     absent — the defect exactly. The verifier must NOT accept it.
      writeFileSync(join(demo, 'add.mjs'), 'export const add = (a, b) => a + b;\n', 'utf8');
      const decoy = await verifyDeliverable(demo, { taskId: 'b47b-decoy-root', deliverable: 'add.mjs' });
      check('a root-only add.mjs with the scoped src/provider artifact ABSENT is REJECTED',
        decoy.accepted === false, JSON.stringify({ exit: decoy.exitCode, stdout: decoy.stdout.slice(-160) }));

      // (2) EMPTY scoped module fails real verification.
      writeFileSync(join(providerDir, 'add.mjs'), '', 'utf8');
      const emptyScoped = await verifyDeliverable(demo, { taskId: 'b47b-empty', deliverable: 'add.mjs' });
      check('an EMPTY src/provider/add.mjs is REJECTED',
        emptyScoped.accepted === false, JSON.stringify({ exit: emptyScoped.exitCode, stdout: emptyScoped.stdout.slice(-160) }));

      // (3) WRONG scoped module fails real verification.
      writeFileSync(join(providerDir, 'add.mjs'), 'export const add = (a, b) => a - b;\n', 'utf8');
      const wrongScoped = await verifyDeliverable(demo, { taskId: 'b47b-wrong', deliverable: 'add.mjs' });
      check('a WRONG src/provider/add.mjs is REJECTED',
        wrongScoped.accepted === false, JSON.stringify({ exit: wrongScoped.exitCode, stdout: wrongScoped.stdout.slice(-160) }));

      // (4)-(6) The SAME contained branches with the SAME fact sink: the scoped module, a
      //     scoped node --test that imports the REAL module, and the final integration check
      //     must ALL pass, and their own facts + validated control records must stay matched
      //     and therefore cleanup-eligible.
      writeFileSync(join(providerDir, 'add.mjs'), 'export const add = (a, b) => a + b;\n', 'utf8');
      writeFileSync(join(consumerDir, 'add.test.mjs'),
        "import test from 'node:test';\nimport assert from 'node:assert';\n" +
        `import { add } from '${B47_CONSUMER_IMPORT}';\n` +
        "test('adds', () => { assert.equal(add(2, 3), 5); assert.equal(add(-2, 3), 1); });\n",
        'utf8');
      writeFileSync(join(integrationDir, 'combined.mjs'),
        "// integration of src/provider/add.mjs and src/consumer/add.test.mjs\n" +
        "import { add } from '../provider/add.mjs';\nexport const total = add(2, 3);\n",
        'utf8');

      const before = controlNames();
      const ledger: B47OwnCommandFact[] = [];
      const sink = (f: B47OwnCommandFact): void => { ledger.push(f); };
      const moduleCheck = await verifyDeliverable(demo, { taskId: 'b47b-module', deliverable: 'add.mjs' }, sink);
      const consumerCheck = await verifyDeliverable(demo, { taskId: 'b47b-consumer', deliverable: 'add.test.mjs' }, sink);
      const integrationCheck = await verifyDeliverable(demo, { taskId: 'b47b-integration', deliverable: 'integration' }, sink);
      const controls = newValidControls(before);
      const elig = decideCleanupEligibility({ commands: ledger, observedControlRecords: controls });

      check('the scoped module passes the ACTUAL Node verification',
        moduleCheck.accepted === true, JSON.stringify({ exit: moduleCheck.exitCode, stdout: moduleCheck.stdout.slice(-160) }));
      check('the scoped node --test imports the REAL src/provider/add.mjs and passes',
        consumerCheck.accepted === true, JSON.stringify({ exit: consumerCheck.exitCode, stdout: consumerCheck.stdout.slice(-160) }));
      check('the scoped integration artifact + final node --test is accepted',
        integrationCheck.accepted === true, JSON.stringify({ exit: integrationCheck.exitCode, stdout: integrationCheck.stdout.slice(-160) }));
      check('the SAME fact sink received one started+stopped node-check fact per branch',
        ledger.length === 3 && ledger.every((f) => f.kind === 'node-check' && f.disposition === 'started' && f.stopConfirmed === true),
        JSON.stringify(ledger));
      check('each branch produced one validated owned control record and the coupled ledger is ELIGIBLE',
        controls === 3 && elig.eligible === true, JSON.stringify({ controls, elig }));

      // (7) A FAILED consumer test must still block integration acceptance, even though a good
      //     integration artifact is present (the final check consumes the same scoped test).
      writeFileSync(join(consumerDir, 'add.test.mjs'),
        "import test from 'node:test';\nimport assert from 'node:assert';\n" +
        `import { add } from '${B47_CONSUMER_IMPORT}';\n` +
        "test('adds', () => { assert.equal(add(2, 3), 999); });\n",
        'utf8');
      const blocked = await verifyDeliverable(demo, { taskId: 'b47b-blocked', deliverable: 'integration' });
      check('a FAILED consumer node --test blocks integration acceptance',
        blocked.accepted === false, JSON.stringify({ exit: blocked.exitCode, stdout: blocked.stdout.slice(-160) }));

      const cf = await ctx.cleanup();
      for (const f of cf) recordCleanupFailure(`scoped-deliverable context: ${f.resource}: ${f.error}`);
      check('the scoped-deliverable context cleaned up', cf.length === 0, cf.map((f) => `${f.resource}: ${f.error}`).join('; '));
    } catch (e) {
      check('the scoped-deliverable regression completed without throwing', false, String((e as Error).message));
      const cf = await ctx.cleanup();
      for (const f of cf) recordCleanupFailure(`scoped-deliverable context: ${f.resource}: ${f.error}`);
    }
  }
}

// ===========================================================================
section('hermetic admission regression: REAL plan/Assignment/Scheduler, fail-before-start runtime seam');

{
  // B4.7.1a (#3): proves BOTH halves of the budget-scope fix on the SAME stack the real
  // harness builds. The ONLY swapped edge is the runtime, which THROWS (labelled) before
  // any Agent can start. No network, no model, no launcher: the seam is the sole boundary.
  const tmp = mkdtempSync(join(tmpdir(), 'b47-admission-'));
  tmpDirs.push(tmp);
  const demo = join(tmp, 'demo');
  mkdirSync(demo, { recursive: true });
  const probe = (withTaskBudgets: boolean): ReturnType<typeof runB47AdmissionProbe> =>
    runB47AdmissionProbe({
      demo,
      storeDir: join(tmp, withTaskBudgets ? 'store-budgeted' : 'store-nobudget'),
      // This node binary is never launched: the seam THROWS before any Agent start.
      command: process.execPath,
      withTaskBudgets,
    });
  try {
    check('the labelled fail-before-start seam is not an Agent', /NOT an Agent/.test(B47_ADMISSION_SEAM_LABEL), B47_ADMISSION_SEAM_LABEL);

    // Case A: no root/child task ledgers -> the TRUE budget-scope refusal, seam never reached.
    const without = await probe(false);
    const refusal = without.dispatch.skipped.find((s) => s.taskId === without.firstTaskId);
    check('no task ledgers: the runtime seam is NEVER reached', without.runtimeSeamReached === false, String(without.runtimeSeamReached));
    check('no task ledgers: the tick reports the TRUE budget-scope refusal',
      refusal !== undefined
      && (refusal.code === 'budget-insufficient' || refusal.code === 'budget-scope-unavailable')
      && /budget-scope-unavailable/.test(refusal.reason),
      JSON.stringify(without.dispatch));
    check('no task ledgers: the surfaced cause names the budget denial, not a generic missing run',
      /budget-scope-unavailable/.test(without.dispatch.cause) && without.dispatch.admitted.length === 0,
      without.dispatch.cause);

    // Case B: root+child task ledgers -> the FIRST intended runtime request reaches the seam.
    const withB = await probe(true);
    check('root+child task ledgers: all three planned tasks were assigned',
      withB.assignedCount === 3 && withB.childIds.length === 3,
      JSON.stringify({ assigned: withB.assignedCount, childIds: withB.childIds }));
    check('root+child task ledgers: the FIRST intended runtime request reaches the labelled seam',
      withB.runtimeSeamReached === true && withB.presentedModel !== null,
      JSON.stringify({ reached: withB.runtimeSeamReached, model: withB.presentedModel }));
    check('root+child task ledgers: the presented model is one of the fixed free candidates',
      withB.presentedModel !== null && B47_CANDIDATE_PAIRS.some((p) => p.modelId === withB.presentedModel),
      String(withB.presentedModel));
    check('root+child task ledgers: the run is stopped and labelled at the seam before any Agent',
      withB.dispatch.admitted.length === 0
      && withB.dispatch.skipped.some((s) => s.taskId === withB.firstTaskId
        && s.code === 'runtime-rejected-run'
        && /b47-admission-probe-runtime-seam/.test(s.reason)),
      JSON.stringify(withB.dispatch));
  } catch (e) {
    check('the hermetic admission regression completed without throwing', false, String((e as Error).message));
  }
}

// ===========================================================================
section('B4.7.2a intentional-demo scaffolding: prepared dirs + guidance, and the ACTUAL first request');

{
  const tmp = mkdtempSync(join(tmpdir(), 'b47-prep-'));
  tmpDirs.push(tmp);
  const demo = join(tmp, 'demo');
  mkdirSync(demo, { recursive: true });
  try {
    // The SAME preparation the real harness runs: it is called inside createB47FreeDuoStack,
    // so this is the production preparation, not a re-implementation.
    prepareB47Demo(demo);

    check('preparation created the provider directory', existsSync(join(demo, B47_PROVIDER_DIR)), join(demo, B47_PROVIDER_DIR));
    check('preparation created the consumer directory', existsSync(join(demo, B47_CONSUMER_DIR)), join(demo, B47_CONSUMER_DIR));
    check('preparation created the integration directory', existsSync(join(demo, B47_INTEGRATION_DIR)), join(demo, B47_INTEGRATION_DIR));

    const readme = join(demo, B47_DEMO_README);
    const readmeText = existsSync(readme) ? readFileSync(readme, 'utf8') : '';
    check('preparation wrote the guidance README with the shared text',
      readmeText.includes(B47_DEMO_GUIDANCE.join('\n')), readmeText.slice(0, 200));

    const integrationEmpty = existsSync(join(demo, B47_INTEGRATION_DIR))
      && readdirSync(join(demo, B47_INTEGRATION_DIR)).length === 0;
    check('preparation did NOT pre-create src/provider/add.mjs', !existsSync(join(demo, B47_PROVIDER_ADD)), B47_PROVIDER_ADD);
    check('preparation did NOT pre-create src/consumer/add.test.mjs', !existsSync(join(demo, B47_CONSUMER_TEST)), B47_CONSUMER_TEST);
    check('preparation did NOT pre-create an integration artifact', integrationEmpty);

    // Drive the REAL plan -> Assignment -> Scheduler path on a SEPARATE directory that is
    // NEVER manually prepared, with a seam that THROWS before any Agent can start. This is
    // the load-bearing wiring assertion: only the shared stack builder's OWN preparation can
    // make the scaffold exist at the first runtime seam — a manual prepare of THIS directory
    // would mask a removed call inside createB47FreeDuoStack.
    const seamDemo = join(tmp, 'demo-seam');
    mkdirSync(seamDemo, { recursive: true });
    check('the seam demo is NEVER prepared by this test before the probe',
      !existsSync(join(seamDemo, B47_DEMO_README))
      && !existsSync(join(seamDemo, B47_PROVIDER_DIR))
      && !existsSync(join(seamDemo, B47_CONSUMER_DIR))
      && !existsSync(join(seamDemo, B47_INTEGRATION_DIR)));
    const probe = await runB47AdmissionProbe({
      demo: seamDemo,
      storeDir: join(tmp, 'store'),
      command: process.execPath,
      withTaskBudgets: true,
    });

    check('the fail-before-start seam was reached for the first intended request',
      probe.runtimeSeamReached === true && probe.presentedPrompt !== null,
      JSON.stringify({ reached: probe.runtimeSeamReached }));
    check('the first request is still bound to a fixed free candidate (never an Agent)',
      probe.presentedModel !== null && B47_CANDIDATE_PAIRS.some((p) => p.modelId === probe.presentedModel),
      String(probe.presentedModel));
    check('the tick records a labelled seam refusal and admits no run',
      probe.dispatch.admitted.length === 0
      && probe.dispatch.skipped.some((s) => s.code === 'runtime-rejected-run' && /b47-admission-probe-runtime-seam/.test(s.reason)),
      JSON.stringify(probe.dispatch));

    // The scaffold must ALREADY exist at the ACTUAL first runtime seam: the shared stack
    // builder prepared it before the first launch, NOT this test. These checks are what make
    // the removal of that one shared-stack call detectable (the negative control must fail).
    const obs = probe.firstSeamObservation;
    check('the ACTUAL first runtime seam observed the complete guidance README before throwing',
      obs !== null && obs.readmeExists && (obs.readmeText ?? '').includes(B47_DEMO_GUIDANCE.join('\n')),
      JSON.stringify(obs));
    check('the ACTUAL first runtime seam observed all three scoped directories before throwing',
      obs !== null && obs.providerDirExists && obs.consumerDirExists && obs.integrationDirExists,
      JSON.stringify(obs));
    check('the ACTUAL first runtime seam observed NO member/integration deliverable pre-created',
      obs !== null && !obs.providerAddExists && !obs.consumerTestExists && obs.integrationArtifactCount === 0,
      JSON.stringify(obs));

    // The ACTUAL production-composed prompt carries the COMPLETE shared guidance, both exact
    // workspace paths and the cwd-only restriction — not a constant compared to itself.
    const prompt = probe.presentedPrompt ?? '';
    check('the first request prompt carries the full shared guidance block',
      prompt.includes(B47_DEMO_GUIDANCE.join(' ')), prompt.slice(0, 240));
    check('the first request prompt names the provider path and the consumer path',
      prompt.includes(B47_PROVIDER_ADD) && prompt.includes(B47_CONSUMER_TEST), prompt.slice(0, 320));
    check('the first request prompt restricts work to the current working directory',
      /Stay in the current working directory/.test(prompt) && /parent, aux, store or sibling directories/.test(prompt),
      prompt.slice(0, 320));
    check('the first request prompt needs no API, settings or repository',
      /NO API, NO settings and NO repository/.test(prompt), prompt.slice(0, 320));
  } catch (e) {
    check('the intentional-demo scaffolding section completed without throwing', false, String((e as Error).message));
  }
}

// ===========================================================================
section('B4.7.2a preparation is idempotent and never overwrites an existing file');

{
  const tmp = mkdtempSync(join(tmpdir(), 'b47-prep2-'));
  tmpDirs.push(tmp);
  const demo = join(tmp, 'demo');
  mkdirSync(demo, { recursive: true });
  prepareB47Demo(demo);
  const moduleBytes = 'export const add = (a, b) => a + b;\n';
  writeFileSync(join(demo, B47_PROVIDER_ADD), moduleBytes, 'utf8');
  const readmeBefore = readFileSync(join(demo, B47_DEMO_README), 'utf8');

  prepareB47Demo(demo);
  prepareB47Demo(demo);

  check('repeat preparation leaves the existing module bytes byte-identical',
    readFileSync(join(demo, B47_PROVIDER_ADD), 'utf8') === moduleBytes);
  check('repeat preparation leaves the guidance README unchanged',
    readFileSync(join(demo, B47_DEMO_README), 'utf8') === readmeBefore);
  check('repeat preparation still created no consumer deliverable',
    !existsSync(join(demo, B47_CONSUMER_TEST)));
}

// ===========================================================================
section('B4.7.2a a prepared-but-missing module still FAILS actual Node verification (scaffolding is not delivery)');

{
  const ctx = setupOwnedTestContext();
  if (ctx === null) {
    process.stdout.write('  SKIP prepared-but-missing verification :: no sealed Job launcher on this machine\n');
  } else {
    try {
      const demo = ctx.dir('demo');
      prepareB47Demo(demo);
      check('the prepared demo has scaffolding before any real run',
        existsSync(join(demo, B47_DEMO_README))
        && existsSync(join(demo, B47_PROVIDER_DIR))
        && existsSync(join(demo, B47_CONSUMER_DIR))
        && existsSync(join(demo, B47_INTEGRATION_DIR)));
      check('the prepared demo is missing the product module and test',
        !existsSync(join(demo, B47_PROVIDER_ADD)) && !existsSync(join(demo, B47_CONSUMER_TEST)));

      const controlDir = ctx.controlDir;
      const controlNames = (): Set<string> =>
        new Set(existsSync(controlDir) ? readdirSync(controlDir).filter((n) => n.endsWith('.txt')) : []);
      const newValidControls = (before: ReadonlySet<string>): number => {
        try {
          return readdirSync(controlDir)
            .filter((n) => n.endsWith('.txt') && !before.has(n))
            .filter((n) => readControlRecord(join(controlDir, n)).ok)
            .length;
        } catch { return 0; }
      };

      const before = controlNames();
      const ledger: B47OwnCommandFact[] = [];
      const missing = await verifyDeliverable(demo, { taskId: 'b47prep-missing', deliverable: 'add.mjs' }, (f) => ledger.push(f));
      const controls = newValidControls(before);
      const elig = decideCleanupEligibility({ commands: ledger, observedControlRecords: controls });

      check('the prepared-but-missing module FAILS the ACTUAL Node verification',
        missing.accepted === false, JSON.stringify({ exit: missing.exitCode, stdout: missing.stdout.slice(-160) }));
      check('the missing-module check records one started+stopped fact and its own validated Job record (Job-empty)',
        ledger.length === 1 && ledger[0]!.kind === 'node-check' && ledger[0]!.disposition === 'started'
        && ledger[0]!.stopConfirmed === true && controls === 1,
        JSON.stringify({ ledger, controls }));
      check('the Job-empty ledger (own fact + own validated control) is ELIGIBLE',
        elig.eligible === true, JSON.stringify(elig));
      check('verification did NOT create the module it was asked to check',
        !existsSync(join(demo, B47_PROVIDER_ADD)));

      const cf = await ctx.cleanup();
      for (const f of cf) recordCleanupFailure(`prepared-but-missing context: ${f.resource}: ${f.error}`);
      check('the prepared-but-missing context cleaned up', cf.length === 0, cf.map((f) => `${f.resource}: ${f.error}`).join('; '));
    } catch (e) {
      check('the prepared-but-missing section completed without throwing', false, String((e as Error).message));
      const cf = await ctx.cleanup();
      for (const f of cf) recordCleanupFailure(`prepared-but-missing context: ${f.resource}: ${f.error}`);
    }
  }
}

// ===========================================================================
section('the parent environment is never mutated by any child case');

{
  check('ORCH_B47_REAL_FREE_DUO is unchanged in the parent', process.env[B47_OPT_IN_ENV] === undefined, String(process.env[B47_OPT_IN_ENV]));
  check('ORCH_B47_FEE_DECLARATION is unchanged in the parent', process.env[B47_DECLARATION_ENV] === undefined, String(process.env[B47_DECLARATION_ENV]));
  check('ORCH_B47_REPORT is unchanged in the parent', process.env[B47_REPORT_ENV] === undefined, String(process.env[B47_REPORT_ENV]));
  check('ORCH_B47_EVIDENCE is unchanged in the parent', process.env[B47_EVIDENCE_ENV] === undefined, String(process.env[B47_EVIDENCE_ENV]));
  check('ORCH_B47_OPENCODE_VERSION is unchanged in the parent', process.env[B47_OPENCODE_VERSION_ENV] === undefined, String(process.env[B47_OPENCODE_VERSION_ENV]));
}

// ===========================================================================
section('the ENTRY and the suite registration obey the existing guards');

{
  const src = readFileSync(ENTRY, 'utf8');
  check('the entry never hardcodes process.exitCode = 0', !/process\.exitCode\s*=\s*0\s*;/.test(src));
  check('the entry never calls process.exit() with a literal code', !/process\.exit\(/.test(src));
  check('the entry uses the ownership helper and cleans up', /setupOwnedTestContext/.test(src) && /owned\.cleanup\(\)/.test(src));
  check('the entry reads only the owned control directory', /owned\.controlDir/.test(src) && !/controlDirectory\s*\(/.test(src));
  check('the entry guards main() behind an entry-point check', /isEntryPoint/.test(src) && /await main\(\)/.test(src));
  check('the entry no longer carries the always-false auxiliary gate', !/b47-aux-model-unverified/.test(src));
  // Preparation must have exactly ONE call site and it must live inside the shared stack
  // builder, so the default entry / import / invalid gates stay free of its side effects.
  check('preparation has exactly ONE call site, inside the shared stack builder',
    (src.match(/prepareB47Demo\(options\.demo\)/g) ?? []).length === 1
    && src.indexOf('prepareB47Demo(options.demo)') > src.indexOf('export function createB47FreeDuoStack'));

  // The suite list is explicit; the REAL entry must NOT be auto-registered.
  const timed = readFileSync(join(REPO, 'scripts', 'test-timed.mjs'), 'utf8');
  check('the real entry is NOT registered to npm test / test-timed', !/b47-free-duo/.test(timed));

  // The isolation guard lists the real entry (registration only).
  const isolation = readFileSync(join(REPO, 'tests', 'real-agent-isolation.test.ts'), 'utf8');
  check('the real entry IS registered in the real-agent ownership guard', /'b47-free-duo\.test\.ts'/.test(isolation));
}

// ===========================================================================
for (const d of tmpDirs) removeOwnedDir(d);
for (const f of reportFiles) {
  try { rmSync(f, { force: true }); } catch (e) { recordCleanupFailure(`report file removal threw for ${f}: ${(e as Error).message}`); }
  if (existsSync(f)) recordCleanupFailure(`report file ${f} still present after removal`);
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
if (cleanupFailures.length) process.stdout.write(`cleanup failures (must fail the test):\n  ${cleanupFailures.map((f) => `- ${f}`).join('\n  ')}\n`);
process.exitCode = finalizeExitCode();
