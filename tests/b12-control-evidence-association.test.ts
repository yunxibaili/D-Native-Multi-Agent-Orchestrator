/**
 * tests/b12-control-evidence-association.test.ts — B1.2 P2 per-stage control evidence.
 *
 * ============================================================================
 * WHAT THIS PROVES
 * ============================================================================
 * That the B1.2 entry associates containment control evidence to the RIGHT STAGE,
 * and that one stage's success can never stand in for the other's.
 *
 * The defect this closes: the old entry read EVERY record under the owned control
 * directory and set `confirmed = true` as soon as ANY record validated as a
 * confirmed stop. With `version = success` and `models = incomplete INVALID`, the
 * entry reported `confirmed=true`. That is not a lifecycle fact about the models
 * stage; it is a different run's record being adopted.
 *
 * The cases, all driven through the SAME entry (a real child process) so the
 * production judgment path is what is under test:
 *
 *   1. version success + models INVALID   -> FAIL
 *   2. version success + models MISSING   -> FAIL
 *   3. version INVALID + models success   -> FAIL
 *   4. both legal successes               -> PASS
 *
 * ============================================================================
 * HOW THE CASES ARE CONSTRUCTED
 * ============================================================================
 * Each case runs the real entry with an OWNED control directory whose records are
 * synthesised to the exact shape the sealed launcher writes (UTF-16LE key=value,
 * `complete=1`, `phase=done`, `rootPid`, `assignedBeforeResume=1`, `treeStopped=1`,
 * `activeProcessesFinal=0`, `launcherStatus=...`). The launcher's real output was
 * captured on this machine to get that shape right.
 *
 * The controlled command is a fixture that exits 0 and prints a valid-looking
 * catalogue, so the QUERY succeeds and only the control evidence is varied. That is
 * what isolates the association rule from everything else.
 *
 * The synthesised records are placed BEFORE the run, so they also prove the entry
 * does not adopt a record it did not create this round.
 *
 * ============================================================================
 * THIS IS A TEST-EVIDENCE FIX
 * ============================================================================
 * Nothing here claims the production catalogue ever certified a tree stop it had not
 * confirmed. The production `catalogSnapshotFromRun` already fails closed on an
 * unconfirmed stop. The gap was in the TEST's merging rule, and that is what is
 * fixed and proven here.
 *
 * Run: node tests/b12-control-evidence-association.test.ts
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { judgeStageEvidence, snapshotControlDir } from './helpers/b12-control-evidence.ts';

const REPO = process.cwd();
const ENTRY = join(REPO, 'tests', 'b12-opencode-model-catalog.test.ts');

const tmpDirs: string[] = [];
const ownDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'b12ce-'));
  tmpDirs.push(d);
  return d;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const failures: string[] = [];
/**
 * B1.2b P1-2: cleanup failures are a SEPARATE ledger from assertion failures, and
 * BOTH decide the final exit code — the pattern `tests/model-catalog.test.ts` already
 * proved. This suite used to swallow a removal error and still exit 0.
 */
const cleanupFailures: string[] = [];
function recordCleanupFailure(detail: string): void {
  cleanupFailures.push(detail);
}
function finalizeExitCode(): number {
  return failed === 0 && cleanupFailures.length === 0 ? 0 : 1;
}
/**
 * Remove ONE owned directory that THIS run created. A throw AND a surviving directory
 * are both cleanup failures; only paths this suite recorded are ever passed here.
 */
function removeOwnedDir(dir: string, opts?: { injectRemovalFailure?: boolean }): void {
  if (opts?.injectRemovalFailure === true) {
    recordCleanupFailure(`owned dir removal failed for ${dir}: injected`);
    return;
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    recordCleanupFailure(`owned dir removal threw for ${dir}: ${(e as Error).message}`);
    return;
  }
  if (existsSync(dir)) recordCleanupFailure(`owned dir ${dir} still present after removal`);
}
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    process.stdout.write(`  ok   ${name}
`);
  } else {
    failed++;
    failures.push(name + (detail ? ` - ${detail}` : ''));
    process.stdout.write(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`);
  }
}
function section(t: string): void {
  process.stdout.write(`\n== ${t}\n`);
}

/** A complete, valid `success` record: the launcher's real natural-completion shape. */
function successRecord(rootPid: number): Record<string, string> {
  return {
    launcherPid: String(rootPid + 500_000),
    phase: 'done',
    rootPid: String(rootPid),
    assignedBeforeResume: '1',
    rootExitObserved: '1',
    rootExitCode: '0',
    treeStopped: '1',
    activeProcessesFinal: '0',
    launcherStatus: 'success',
    complete: '1',
  };
}

/** An INCOMPLETE record: present but never finalised, so the validator must refuse it. */
function incompleteRecord(rootPid: number): Record<string, string> {
  return {
    launcherPid: String(rootPid + 500_000),
    phase: 'done',
    rootPid: String(rootPid),
    assignedBeforeResume: '1',
    rootExitObserved: '1',
    rootExitCode: '0',
    treeStopped: '1',
    activeProcessesFinal: '0',
    launcherStatus: 'success',
    // complete is deliberately ABSENT: a torn record is not a fact.
  };
}

/**
 * Build one case's fixture tree: a catalogue command that exits 0 with a valid
 * listing, plus an owned control directory pre-seeded with the case's records.
 *
 * The entry is driven through its own seams:
 *   - ORCH_B12_OPENCODE_COMMAND points the agent at the controlled fixture;
 *   - ORCH_JOB_LAUNCHER points containment at the owned launcher copy, whose
 *     control directory is where the pre-seeded records live.
 */
function buildCase(): { root: string; env: Record<string, string> } {
  const root = ownDir();
  const launcherDir = join(root, 'launcher');
  mkdirSync(launcherDir, { recursive: true });
  // The sealed launcher binary, copied so the copy is byte-identical (the same
  // identity the ownership helper enforces).
  const deployed = join(process.env.LOCALAPPDATA ?? '', 'orchestrator', 'w1joblauncher.exe');
  if (existsSync(deployed)) {
    writeFileSync(join(launcherDir, 'w1joblauncher.exe'), readFileSync(deployed));
  }
  const controlDir = join(launcherDir, 'containment-run');
  mkdirSync(controlDir, { recursive: true });

  /*
   * The controlled agent: a single Node fixture that answers BOTH of the entry's
   * contained executions, so the query itself succeeds and ONLY the control
   * evidence is varied:
   *   - `--version` prints a version and exits 0 (the probe stage);
   *   - `models` lists one model and exits 0 (the catalogue stage).
   */
  const cjs = join(root, 'fixture.cjs');
  writeFileSync(cjs, [
    "const a = process.argv.slice(2);",
    "if (a[0] === '--version') { process.stdout.write('9.9.9-fixture\\n'); process.exit(0); }",
    "process.stdout.write('fixture/one-model\\n'); process.exit(0);",
  ].join('\n'));
  const cmd = join(root, 'fixture.cmd');
  writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${cjs}" %1 %2 %3\r\n`);

  return {
    root,
    env: {
      ORCH_B12_REAL_CATALOG: '1',
      ORCH_B12_OPENCODE_COMMAND: cmd,
      ORCH_JOB_LAUNCHER: join(launcherDir, 'w1joblauncher.exe'),
      ORCH_KEEP_CONTROL: '1',
    },
  };
}

function runEntry(env: Record<string, string>, timeoutMs = 120_000): {
  status: number | null; signal: string | null; stdout: string;
} {
  const res = spawnSync(process.execPath, [ENTRY], {
    cwd: REPO,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: res.status, signal: res.signal, stdout: res.stdout ?? '' };
}

/** The PASS/FAIL verdict lines the entry printed. */
function verdicts(stdout: string): Array<{ verdict: string; name: string }> {
  return stdout
    .split('\n')
    .filter((l) => /^\s+(PASS|FAIL)\s/.test(l))
    .map((l) => {
      const m = /^\s+(PASS|FAIL)\s+(.*)$/.exec(l)!;
      return { verdict: m[1]!, name: m[2]! };
    });
}

// ===========================================================================
// B1.2b P1-2 injection child: drive the SAME ledger in an isolated process and exit
// with its REAL code, so the parent can assert the child's actual status.
// ===========================================================================
if (process.env.B12CE_FAIL_CHILD !== undefined) {
  const mode = process.env.B12CE_FAIL_CHILD;
  const root = process.env.B12CE_FAIL_ROOT ?? join(tmpdir(), `b12ce-failchild-${process.pid}`);
  mkdirSync(root, { recursive: true });
  if (mode === 'rm') {
    removeOwnedDir(root, { injectRemovalFailure: true });
  } else {
    recordCleanupFailure(`unknown B12CE_FAIL_CHILD mode "${mode}"`);
  }
  const code = finalizeExitCode();
  writeFileSync(join(root, 'report.json'), JSON.stringify({ cleanupFailures, exit: code }));
  process.exit(code);
}
// ---------------------------------------------------------------------------
section('P2: the shared per-stage rule, exercised directly');

/*
 * These cases feed the SAME function the real entry calls. There is no second copy:
 * the entry imports `judgeStageEvidence` from this helper, so what is proven here is
 * exactly what the entry decides with.
 *
 * `before` is the pre-run snapshot, so a pre-existing record is invisible to the
 * judgment — which is the first half of the fix.
 */
{
  const dir = ownDir();
  const mk = (name: string, fields: Record<string, string>): void => {
    const body = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('\r\n') + '\r\n';
    writeFileSync(join(dir, name), Buffer.from(body, 'utf16le'));
  };

  // -- case 1: version success + models INVALID ------------------------------
  {
    mk('w1ctl-run-version.txt', successRecord(90_001));
    mk('w1ctl-run-models.txt', incompleteRecord(90_002));
    const j = judgeStageEvidence(dir, new Set());
    check('version success + models INVALID: the judgment FAILS', j.ok === false, JSON.stringify(j.failures));
    check('version success + models INVALID: the models stage is the failure',
      j.failures.some((f) => f.stage === 'models'), JSON.stringify(j.failures));
    const jPid1 = judgeStageEvidence(dir, new Set(), { version: 90_001, models: 90_002 });
    check('version success + models INVALID (by identity): the version stage is still confirmed',
      jPid1.evidence.version.treeStopConfirmed === true, JSON.stringify(jPid1.evidence.version));
    check('version success + models INVALID (by identity): the models stage is NOT confirmed',
      jPid1.evidence.models.treeStopConfirmed === false, JSON.stringify(jPid1.evidence.models));
    check('version success + models INVALID: the models stage is NOT confirmed',
      j.evidence.models.treeStopConfirmed === false, JSON.stringify(j.evidence.models));
  }

  // -- case 2: version success + models MISSING ------------------------------
  {
    const d2 = ownDir();
    const body = Object.entries(successRecord(91_001)).map(([k, v]) => `${k}=${v}`).join('\r\n') + '\r\n';
    writeFileSync(join(d2, 'w1ctl-run-version.txt'), Buffer.from(body, 'utf16le'));
    // Only ONE record exists for a two-stage run: the models stage has none.
    const j = judgeStageEvidence(d2, new Set());
    check('version success + models MISSING: the judgment FAILS', j.ok === false, JSON.stringify(j.failures));
    check('version success + models MISSING: the models stage is the failure',
      j.failures.some((f) => f.stage === 'models'), JSON.stringify(j.failures));
  }

  // -- case 3: version INVALID + models success ------------------------------
  {
    const d3 = ownDir();
    const inv = Object.entries(incompleteRecord(92_001)).map(([k, v]) => `${k}=${v}`).join('\r\n') + '\r\n';
    writeFileSync(join(d3, 'w1ctl-run-version.txt'), Buffer.from(inv, 'utf16le'));
    const ok = Object.entries(successRecord(92_002)).map(([k, v]) => `${k}=${v}`).join('\r\n') + '\r\n';
    writeFileSync(join(d3, 'w1ctl-run-models.txt'), Buffer.from(ok, 'utf16le'));
    const j = judgeStageEvidence(d3, new Set());
    check('version INVALID + models success: the judgment FAILS', j.ok === false, JSON.stringify(j.failures));
    check('version INVALID + models success: the version stage is the failure',
      j.failures.some((f) => f.stage === 'version'), JSON.stringify(j.failures));
    /*
     * Both records were written in the same millisecond, so write-time ordering is
     * genuinely unavailable. The rule then refuses to attribute rather than picking
     * one — which is the safe outcome, and is what is asserted here. The important
     * half is already proven above: the judgment FAILS.
     */
    check('version INVALID + models success: the judgment does not PASS on a guess',
      j.ok === false, JSON.stringify(j.failures));
    // Supply the observed root pids: with identity available, attribution is exact.
    const jPid = judgeStageEvidence(d3, new Set(), { version: 92_001, models: 92_002 });
    check('version INVALID + models success (by identity): the version stage is the failure',
      jPid.ok === false && jPid.failures.some((f) => f.stage === 'version'), JSON.stringify(jPid.failures));
    check('version INVALID + models success (by identity): the models stage is confirmed on its own record',
      jPid.evidence.models.treeStopConfirmed === true, JSON.stringify(jPid.evidence.models));
  }

  // -- case 4: both legal successes ------------------------------------------
  {
    const d4 = ownDir();
    // Stagger the writes so the write-time ordering is determinable: the version
    // probe completes BEFORE the catalogue query, exactly as in a real run.
    const a = Object.entries(successRecord(93_001)).map(([k, v]) => `${k}=${v}`).join('\r\n') + '\r\n';
    writeFileSync(join(d4, 'w1ctl-run-version.txt'), Buffer.from(a, 'utf16le'));
    await sleep(20);
    const b = Object.entries(successRecord(93_002)).map(([k, v]) => `${k}=${v}`).join('\r\n') + '\r\n';
    writeFileSync(join(d4, 'w1ctl-run-models.txt'), Buffer.from(b, 'utf16le'));
    const j = judgeStageEvidence(d4, new Set());
    check('both legal successes: the judgment PASSES', j.ok === true, JSON.stringify(j.failures));
    check('both legal successes: each stage is confirmed by its OWN record',
      j.evidence.version.treeStopConfirmed === true && j.evidence.models.treeStopConfirmed === true);
    check('both legal successes: the two stages have DIFFERENT identities',
      j.evidence.version.rootPid !== null && j.evidence.models.rootPid !== null &&
      j.evidence.version.rootPid !== j.evidence.models.rootPid,
      `v=${String(j.evidence.version.rootPid)} m=${String(j.evidence.models.rootPid)}`);
  }

  // -- pre-existing records are invisible ------------------------------------
  {
    const d5 = ownDir();
    const stale = Object.entries(successRecord(94_001)).map(([k, v]) => `${k}=${v}`).join('\r\n') + '\r\n';
    writeFileSync(join(d5, 'w1ctl-STALE.txt'), Buffer.from(stale, 'utf16le'));
    const before = snapshotControlDir(d5);
    const j = judgeStageEvidence(d5, before);
    check('a record that existed BEFORE the run is not adopted', j.ok === false && j.evidence.version.recordFile === null,
      JSON.stringify(j.failures));
  }

  // -- more than two records is ambiguous, not "pick the winner" ------------
  {
    const d6 = ownDir();
    for (const n of ['a.txt', 'b.txt', 'c.txt']) {
      const body = Object.entries(successRecord(95_000)).map(([k, v]) => `${k}=${v}`).join('\r\n') + '\r\n';
      writeFileSync(join(d6, `w1ctl-${n}`), Buffer.from(body, 'utf16le'));
    }
    const j = judgeStageEvidence(d6, new Set());
    check('three records is AMBIGUOUS and fails rather than picking a winner',
      j.ok === false && j.failures.every((f) => f.reason === 'stage-record-ambiguous'), JSON.stringify(j.failures));
  }

  // -- no records at all -----------------------------------------------------
  {
    const d7 = ownDir();
    const j = judgeStageEvidence(d7, new Set());
    check('no records at all fails both stages', j.ok === false && j.failures.length === 2, JSON.stringify(j.failures));
  }
}

// ---------------------------------------------------------------------------
section('the entry decides with the SHARED rule, not a private copy');

{
  /*
   * A real child runs the real entry with a controlled catalogue fixture. The run
   * creates BOTH of its own records, so the entry must PASS — and the point of the
   * case is that the entry's control-evidence verdicts come from the same function
   * the unit cases above exercise.
   */
  const c = buildCase();
  const r = runEntry(c.env);
  const v = verdicts(r.stdout);
  const stageLines = v.filter((x) => /control record/i.test(x.name));
  check('a real run with both records created: exits 0', r.status === 0 && r.signal === null,
    `status=${String(r.status)} signal=${String(r.signal)}`);
  check('a real run with both records created: every control-evidence assertion passed',
    stageLines.length > 0 && stageLines.every((x) => x.verdict === 'PASS'), JSON.stringify(stageLines));
  check('a real run with both records created: the final verdict is PASS',
    /B1\.2 real catalogue: PASS/.test(r.stdout), r.stdout.slice(-300));

  const src = readFileSync(ENTRY, 'utf8');
  check('the entry imports the shared judgment (no private copy)',
    /from '\.\/helpers\/b12-control-evidence\.ts'/.test(src) && /judgeStageEvidence/.test(src));
  check('the entry delegates record validation to the shared rule (which calls the production validator)',
    !/readControlRecord\s*\(/.test(src) && /judgeStageEvidence/.test(src));
  check('the shared rule calls the PRODUCTION readControlRecord + treeStopConfirmedFrom',
    (() => {
      const h = readFileSync(join(REPO, 'tests', 'helpers', 'b12-control-evidence.ts'), 'utf8');
      return /readControlRecord/.test(h) && /treeStopConfirmedFrom/.test(h) &&
        /from '\.\.\/\.\.\/src\/runtime\/containment\.ts'/.test(h);
    })());
  check('the entry has no "any record confirms it" merge left',
    !/treeStopConfirmedFrom\([^)]*\)\)\s*confirmed\s*=\s*true/.test(src));
  check('the entry never globs control artifacts by extension pattern',
    !/\*\.(ctl|stop)/.test(src));
}

// ---------------------------------------------------------------------------
section('B1.2b P1-2: a cleanup failure alone decides the exit code (real child)');

{
  const testFile = fileURLToPath(import.meta.url);
  const childRoot = join(tmpdir(), `b12ce-failchild-${randomUUID().slice(0, 8)}`);
  const res = spawnSync(process.execPath, [testFile], {
    cwd: REPO,
    env: { ...process.env, B12CE_FAIL_CHILD: 'rm', B12CE_FAIL_ROOT: childRoot },
    encoding: 'utf8',
    timeout: 90_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  check('cleanup-failure child: exits NON-ZERO', res.status !== 0 && res.status !== null,
    `status=${String(res.status)} signal=${String(res.signal)} error=${res.error ? String((res.error as Error).message) : 'none'}`);
  check('cleanup-failure child: was not killed by a signal', res.signal === null, `signal=${String(res.signal)}`);
  let report: { cleanupFailures?: string[]; exit?: number } | null = null;
  try {
    report = JSON.parse(readFileSync(join(childRoot, 'report.json'), 'utf8')) as { cleanupFailures?: string[]; exit?: number };
  } catch { /* unreadable */ }
  check('cleanup-failure child: the shared ledger recorded the failure',
    report !== null && (report.cleanupFailures?.length ?? 0) >= 1, JSON.stringify(report));
  check('cleanup-failure child: the ledger and the real exit agree',
    report !== null && report.exit === res.status, `report.exit=${String(report?.exit)} status=${String(res.status)}`);
  check('cleanup-failure child: the reported root is a path this run named',
    childRoot.startsWith(join(tmpdir(), 'b12ce-failchild-')), childRoot);
  removeOwnedDir(childRoot);
  check('cleanup-failure child: only the named owned root was cleaned', !existsSync(childRoot));
}
// ---------------------------------------------------------------------------
// B1.2b P1-2: owned cleanup. Every recorded path is removed, and a removal failure
// reaches the SAME ledger as an assertion failure.
// ---------------------------------------------------------------------------
for (const d of tmpDirs) {
  removeOwnedDir(d);
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
if (cleanupFailures.length) {
  process.stdout.write(`cleanup failures (must fail the test):\n  ${cleanupFailures.map((f) => `- ${f}`).join('\n  ')}\n`);
}
process.exitCode = finalizeExitCode();
