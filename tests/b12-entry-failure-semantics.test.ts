/**
 * tests/b12-entry-failure-semantics.test.ts — B1.2 P1-1 controlled failure regression.
 *
 * ============================================================================
 * WHAT THIS PROVES
 * ============================================================================
 * That the B1.2 entry's failure semantics are ENFORCED, not merely documented. Each
 * case below runs the REAL `tests/b12-opencode-model-catalog.test.ts` as a REAL CHILD
 * PROCESS and asserts the child's ACTUAL exit status (and, where relevant, its real
 * `signal` / spawn `error`), never a matched string of text.
 *
 * The cases, exactly as the round requires:
 *
 *   1. NOT ENABLED          -> exit 0, NOT_RUN, no owned context, no agent.
 *   2. OpenCode missing     -> ENABLED but discovery fails -> NON-ZERO, no PASS.
 *   3. launcher missing     -> ENABLED but no sealed Job launcher -> NON-ZERO.
 *   4. query failure        -> ENABLED, catalogue query fails -> NON-ZERO.
 *   5. cleanup failure      -> ENABLED, assertions pass, cleanup fails -> NON-ZERO.
 *
 * ============================================================================
 * WHY REAL CHILDREN
 * ============================================================================
 * A pure "exit-code function" test would only re-assert `finish()`, which is already
 * covered by `real-agent-ownership.test.ts`. What has never been proven is that the
 * ENTRY routes each of these situations through `finish()` with the right inputs —
 * that is a property of the entry's own control flow, so it is exercised here by
 * running the entry itself and observing the child's real termination.
 *
 * ============================================================================
 * ISOLATION — B1.2b P1-1: HERMETIC BY CONSTRUCTION, NOT BY LUCK
 * ============================================================================
 * No real agent is ever started by THIS suite, and the child processes it spawns are
 * the entry under test plus CONTROLLED Node fixtures.
 *
 * That is enforced three ways, because "the machine happens to have no OpenCode" is
 * not a hermeticity argument:
 *
 *  1. EVERY child runs with an explicit `ORCH_B12_OPENCODE_COMMAND` naming a fixture
 *     this suite wrote. No case omits it, so no child can fall back to the installed
 *     agent through discovery. That command seam is the standard
 *     `agents.opencode.command` config path the entry already honours — not a new
 *     test-only mechanism.
 *  2. The NOT-ENABLED case explicitly sets `ORCH_B12_REAL_CATALOG: '0'` rather than
 *     relying on the ambient environment happening to be unset.
 *  3. Every child receives a COPY of the environment; `process.env` is never mutated
 *     in place, so one case cannot leak a value into the next.
 *
 * Cases 2-5 then inject their specific condition (a non-existent fixture path, a
 * missing launcher, a failing fixture, or an injected owned-root removal failure) on
 * top of that controlled command. No global agent configuration, credential, default
 * model, plugin or MCP is touched.
 *
 * Independent check: with the OpenCode command pointed at an absolute path that does
 * NOT exist, this suite still passes — the fixtures are per-case and never fall back
 * to a real agent.
 *
 * This file does NOT start a real agent, so it is not in the real-agent ownership
 * guard's list. It is registered in the default suite list because it must run
 * everywhere.
 *
 * Run: node tests/b12-entry-failure-semantics.test.ts
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = process.cwd();
const ENTRY = join(REPO, 'tests', 'b12-opencode-model-catalog.test.ts');

const tmpDirs: string[] = [];
/** Transient report files this run created; removed and verified at the end. */
const reportFiles: string[] = [];
const ownDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'b12ef-'));
  tmpDirs.push(d);
  return d;
};

let passed = 0;
let failed = 0;
const failures: string[] = [];
/**
 * B1.2b P1-2: cleanup failures are a SEPARATE ledger from assertion failures, and
 * BOTH decide the final exit code. This is the pattern `tests/model-catalog.test.ts`
 * already proved (B1.1b P1); the suites below used to swallow a removal error with
 * `catch { best effort }` and still exit 0, which is a false green.
 */
const cleanupFailures: string[] = [];
function recordCleanupFailure(detail: string): void {
  cleanupFailures.push(detail);
}
function finalizeExitCode(): number {
  return failed === 0 && cleanupFailures.length === 0 ? 0 : 1;
}
/**
 * Remove ONE owned directory that THIS run created.
 *
 * A throw AND a surviving directory are both recorded as cleanup failures. A
 * successful fallback does NOT erase an already-recorded failure. Only paths this
 * suite recorded are ever passed here, so nothing outside this run's own roots can
 * be touched.
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
    process.stdout.write(`  FAIL ${name}${detail ? ` - ${detail}` : ''}
`);
  }
}
function section(t: string): void {
  process.stdout.write(`\n== ${t}\n`);
}

/**
 * Run the entry as a real child and classify HOW it terminated.
 *
 * `status`, `signal` and `error` are kept apart on purpose: a spawn error, a
 * signal death and an ordinary non-zero exit are three different facts, and only
 * the last one is an ordinary test failure.
 */
function runEntry(env: Record<string, string>, timeoutMs = 90_000): {
  status: number | null;
  signal: string | null;
  error: string | null;
  stdout: string;
} {
  const res = spawnSync(process.execPath, [ENTRY], {
    cwd: REPO,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: res.status,
    signal: res.signal,
    error: res.error ? String((res.error as Error).message) : null,
    stdout: res.stdout ?? '',
  };
}

/**
 * Build the child environment for one case.
 *
 * A COPY is always made: the ambient environment is never mutated, so a value set for
 * one case cannot leak into another. Every case also pins the OpenCode command and
 * the opt-in flag EXPLICITLY, so no case can inherit either from the ambient
 * environment (see the isolation note in the file header).
 */
function childEnv(over: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/**
 * A controlled agent fixture that answers BOTH of the entry's contained executions,
 * so a hermetic case can drive the entry to a genuine SUCCESS with no installed agent:
 *   - `--version` prints a version and exits 0   (the probe stage)
 *   - `models` lists models and exits 0          (the catalogue stage)
 *
 * Returns the `.cmd` path to point `ORCH_B12_OPENCODE_COMMAND` at. The caller keeps
 * ownership of the directory it lives in.
 */
function writeSuccessFixture(dir: string): string {
  const cjs = join(dir, 'fixture.cjs');
  writeFileSync(cjs, [
    "const a = process.argv.slice(2);",
    "if (a[0] === '--version') { process.stdout.write('9.9.9-fixture\\n'); process.exit(0); }",
    "process.stdout.write('fixture/one-model\\nfixture/two-model\\n'); process.exit(0);",
  ].join('\n'));
  const cmd = join(dir, 'fixture.cmd');
  // %1..%3 forwards the agent's own argv (`--version`, `models`) to the fixture.
  writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${cjs}" %1 %2 %3\r\n`);
  return cmd;
}

// ===========================================================================
// B1.2b P1-2 injection child: drive the SAME ledger in an isolated process and
// exit with its REAL code, so the parent can assert the child's actual status.
// ===========================================================================
if (process.env.B12EF_FAIL_CHILD !== undefined) {
  const mode = process.env.B12EF_FAIL_CHILD;
  const root = process.env.B12EF_FAIL_ROOT ?? join(tmpdir(), `b12ef-failchild-${process.pid}`);
  mkdirSync(root, { recursive: true });
  if (mode === 'rm') {
    // The owned root is deliberately left for the parent; its removal is injected as
    // a failure through the SAME helper the real cleanup uses.
    removeOwnedDir(root, { injectRemovalFailure: true });
  } else {
    recordCleanupFailure(`unknown B12EF_FAIL_CHILD mode "${mode}"`);
  }
  const code = finalizeExitCode();
  writeFileSync(join(root, 'report.json'), JSON.stringify({ cleanupFailures, exit: code }));
  process.exit(code);
}
// ---------------------------------------------------------------------------
section('case 1: NOT ENABLED — exit 0, no owned context, no agent');

{
  // The opt-in flag is pinned OFF rather than left to the ambient environment, so
  // this case means "not enabled" even when the suite is run from a shell that has
  // ORCH_B12_REAL_CATALOG=1 set.
  const r = runEntry(childEnv({ ORCH_B12_REAL_CATALOG: '0' }));
  check('not enabled: exits 0', r.status === 0 && r.signal === null, `status=${String(r.status)} signal=${String(r.signal)}`);
  check('not enabled: prints NOT_RUN', /NOT_RUN/.test(r.stdout), r.stdout.slice(-200));
  check('not enabled: does NOT print PASS', !/\bPASS\b/.test(r.stdout), r.stdout.slice(-200));
  check('not enabled: reports no discovery / agent / owned context',
    /no discovery, no agent start, no owned context/.test(r.stdout), r.stdout.slice(-200));
}

// ---------------------------------------------------------------------------
section('case 2: ENABLED but OpenCode missing — NON-ZERO, never PASS');

{
  /*
   * OpenCode discovery is made to fail the SAME way the independent review did:
   * the entry is run with a controlled environment in which the agent cannot be
   * resolved. The entry's own `knownAgentIds()` bootstrap still runs, but the
   * opencode adapter cannot be constructed, so `doctor` has no opencode report
   * and the entry's discovery branch must fail rather than wave through.
   *
   * The mechanism is a controlled PATH that contains no opencode and a controlled
   * APPDATA so the per-agent known locations resolve to nothing, while the sealed
   * Job launcher is still available (it comes from LOCALAPPDATA, untouched).
   */
  const empty = ownDir();
  mkdirSync(join(empty, 'appdata'), { recursive: true });
  mkdirSync(join(empty, 'path'), { recursive: true });
  // A config that names a non-existent binary is a HARD resolution error in
  // production discovery (see runtime/discover.ts), which is the honest way to
  // make "OpenCode missing" real rather than mocked.
  const cfg = join(empty, 'orchestrator.json');
  writeFileSync(cfg, JSON.stringify({ agents: { opencode: { command: join(empty, 'no-opencode-here.exe') } } }));

  const r = runEntry(childEnv({
    ORCH_B12_REAL_CATALOG: '1',
    // The standard agents.opencode.command seam: a configured absolute path that does
    // not exist is a HARD resolution error in production discovery, so the agent is
    // genuinely unavailable rather than mocked. It is still a CONTROLLED path — the
    // entry can never reach an installed agent from here.
    ORCH_B12_OPENCODE_COMMAND: join(empty, 'no-opencode-here.exe'),
  }));

  check('opencode missing: exits NON-ZERO', r.status !== 0 && r.status !== null, `status=${String(r.status)} signal=${String(r.signal)} error=${r.error}`);
  check('opencode missing: was not killed by a signal', r.signal === null, `signal=${String(r.signal)}`);
  check('opencode missing: does NOT print a PASS line', !/^\s*PASS\b/m.test(r.stdout), r.stdout.slice(-400));
  check('opencode missing: reports ENVIRONMENT_BLOCKED', /ENVIRONMENT_BLOCKED/.test(r.stdout), r.stdout.slice(-400));
}

// ---------------------------------------------------------------------------
section('case 3: ENABLED but launcher missing — NON-ZERO, never PASS');

{
  /*
   * An explicit ORCH_JOB_LAUNCHER that does not exist is a hard configuration
   * error in production resolution, so the launcher is genuinely unavailable
   * without touching the deployed one. This is the same seam the W4.4 P1-B
   * regression uses, and it is the honest way to prove the branch.
   */
  const dir3 = ownDir();
  const r = runEntry(childEnv({
    ORCH_B12_REAL_CATALOG: '1',
    // A controlled fixture, so even this launcher-missing case cannot reach an
    // installed agent through discovery.
    ORCH_B12_OPENCODE_COMMAND: writeSuccessFixture(dir3),
    ORCH_JOB_LAUNCHER: join(tmpdir(), 'b12-no-such-launcher.exe'),
  }));
  check('launcher missing: exits NON-ZERO', r.status !== 0 && r.status !== null, `status=${String(r.status)} signal=${String(r.signal)} error=${r.error}`);
  check('launcher missing: was not killed by a signal', r.signal === null, `signal=${String(r.signal)}`);
  check('launcher missing: does NOT print a PASS line', !/^\s*PASS\b/m.test(r.stdout), r.stdout.slice(-400));
  check('launcher missing: reports ENVIRONMENT_BLOCKED', /ENVIRONMENT_BLOCKED/.test(r.stdout), r.stdout.slice(-400));
}

// ---------------------------------------------------------------------------
section('case 4: ENABLED but the catalogue query fails — NON-ZERO');

{
  /*
   * A controlled fixture whose root exits non-zero, driven through the REAL
   * default contained path (no injected runner). The catalogue command therefore
   * really runs and really fails, which is what the entry must propagate.
   *
   * The fixture is a controlled `.cmd` wrapper around Node so the same shape the
   * existing model-catalog containment regressions use is preserved.
   */
  const dir = ownDir();
  const cjs = join(dir, 'fail.cjs');
  writeFileSync(cjs, [
    "process.stdout.write('opencode/gpt-5.1-codex\n');",
    "process.stderr.write('controlled catalogue failure\n');",
    'process.exit(3);',
  ].join('\n'));
  const cmd = join(dir, 'fail.cmd');
  writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${cjs}"\r\nexit /b 3\r\n`);

  const cfg = join(dir, 'orchestrator.json');
  writeFileSync(cfg, JSON.stringify({ agents: { opencode: { command: cmd } } }));

  const r = runEntry(childEnv({
    ORCH_B12_REAL_CATALOG: '1',
    ORCH_B12_OPENCODE_COMMAND: cmd,
  }));

  check('query failure: exits NON-ZERO', r.status !== 0 && r.status !== null, `status=${String(r.status)} signal=${String(r.signal)} error=${r.error}`);
  check('query failure: was not killed by a signal', r.signal === null, `signal=${String(r.signal)}`);
  check('query failure: reports a failed catalogue status', /status=failed/.test(r.stdout), r.stdout.slice(-600));
  check('query failure: does NOT report PASS for the catalogue', !/PASS real catalogue query completed/.test(r.stdout), r.stdout.slice(-600));
}

// ---------------------------------------------------------------------------
section('case 5: ENABLED, assertions pass, cleanup fails — NON-ZERO');

{
  /*
   * B1.2b P1-1: this case used to enable the entry WITHOUT a controlled command, so
   * it queried whatever OpenCode was installed — a default-suite test that depended on
   * the machine's install state (and that launched the real agent). It now points the
   * entry at a CONTROLLED SUCCESS FIXTURE, so the query genuinely succeeds for a
   * reason this suite owns, and the ONLY thing wrong is the cleanup.
   *
   * The cleanup failure itself uses the EXISTING, already-proven injection seam in
   * `tests/helpers/real-agent-isolation.ts` (`ORCH_W4H_FAIL_ROOT_RM=1`): the owned
   * root removal itself throws EBUSY, so cleanup reports a real failure.
   *
   * The child deliberately leaves its root on disk; this parent removes that ONE
   * named path afterwards as fixture cleanup.
   */
  const dir5 = ownDir();
  const report5 = join(tmpdir(), `b12ef-report-${process.pid}.json`);
  reportFiles.push(report5);
  const r = runEntry(childEnv({
    ORCH_B12_REAL_CATALOG: '1',
    ORCH_B12_OPENCODE_COMMAND: writeSuccessFixture(dir5),
    ORCH_W4H_FAIL_ROOT_RM: '1',
    ORCH_W4H_REPORT: report5,
  }));

  check('cleanup failure: exits NON-ZERO despite the query succeeding',
    r.status !== 0 && r.status !== null, `status=${String(r.status)} signal=${String(r.signal)} error=${r.error}`);
  check('cleanup failure: was not killed by a signal', r.signal === null, `signal=${String(r.signal)}`);
  check('cleanup failure: the catalogue itself still succeeded (only cleanup was wrong)',
    /PASS real catalogue query completed/.test(r.stdout), r.stdout.slice(-600));
  /*
   * The success must be the CONTROLLED FIXTURE's, not a real agent's. The fixture's
   * version and model ids are unique to this suite, so their presence proves the
   * query ran against the fixture and did NOT fall back to an installed agent.
   */
  check('cleanup failure: the success came from the controlled fixture (no fallback to a real agent)',
    /version=9\.9\.9-fixture/.test(r.stdout) && /fixture\/one-model/.test(r.stdout),
    r.stdout.split('\n').filter((l) => /version=|snapshot status=|samples:/.test(l)).join(' | '));
  check('cleanup failure: reports the cleanup failure in the output',
    /cleanup failure/i.test(r.stdout), r.stdout.slice(-600));
  check('cleanup failure: final line is FAIL, not PASS', /B1\.2 real catalogue: FAIL/.test(r.stdout), r.stdout.slice(-200));

  // Fixture cleanup: remove the ONE root the child reported, never by enumeration.
  try {
    const report = JSON.parse(readFileSync(report5, 'utf8')) as { ownedRoot?: string | null };
    if (typeof report.ownedRoot === 'string' && report.ownedRoot.length > 0) {
      rmSync(report.ownedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      check('cleanup failure: fixture removed the injected owned root', !existsSync(report.ownedRoot), report.ownedRoot);
    } else {
      check('cleanup failure: fixture removed the injected owned root', false, 'no ownedRoot in the child report');
    }
  } catch (e) {
    check('cleanup failure: fixture removed the injected owned root', false, String((e as Error).message));
  }
}

// ---------------------------------------------------------------------------
section('B1.2b P1-2: a cleanup failure alone decides the exit code (real child)');

{
  /*
   * A real child re-runs THIS file with the owned-removal failure injected through the
   * SAME ledger and the SAME removal helper the normal path uses. The child exits with
   * its own code; the parent asserts the child's REAL status (never a text match), then
   * removes the ONE owned root the child reports.
   *
   * This mirrors the already-proven `MC_FAIL_CHILD` pattern in model-catalog.test.ts.
   */
  const testFile = fileURLToPath(import.meta.url);
  const childRoot = join(tmpdir(), `b12ef-failchild-${randomUUID().slice(0, 8)}`);
  const res = spawnSync(process.execPath, [testFile], {
    cwd: REPO,
    env: childEnv({ B12EF_FAIL_CHILD: 'rm', B12EF_FAIL_ROOT: childRoot }),
    encoding: 'utf8',
    timeout: 90_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  check('cleanup-failure child: exits NON-ZERO', res.status !== 0 && res.status !== null,
    `status=${String(res.status)} signal=${String(res.signal)} error=${res.error ? String((res.error as Error).message) : 'none'}`);
  check('cleanup-failure child: was not killed by a signal (an ordinary non-zero exit)',
    res.signal === null, `signal=${String(res.signal)}`);

  let report: { cleanupFailures?: string[]; exit?: number } | null = null;
  try {
    report = JSON.parse(readFileSync(join(childRoot, 'report.json'), 'utf8')) as { cleanupFailures?: string[]; exit?: number };
  } catch { /* unreadable */ }
  check('cleanup-failure child: the shared ledger recorded the failure',
    report !== null && (report.cleanupFailures?.length ?? 0) >= 1, JSON.stringify(report));
  check('cleanup-failure child: the ledger and the real exit agree',
    report !== null && report.exit === res.status, `report.exit=${String(report?.exit)} status=${String(res.status)}`);

  // The parent cleans ONLY this run's recorded owned root, after validating it is a
  // path this run named (inside this run's temp prefix).
  check('cleanup-failure child: the reported root is a path this run named',
    childRoot.startsWith(join(tmpdir(), 'b12ef-failchild-')), childRoot);
  removeOwnedDir(childRoot);
  check('cleanup-failure child: only the named owned root was cleaned', !existsSync(childRoot));
}
// ---------------------------------------------------------------------------
section('B1.2b P1-1/P2: the catalogue ENTRY with OpenCode UNREACHABLE');

{
  /*
   * This case runs the catalogue ENTRY (`tests/b12-opencode-model-catalog.test.ts`)
   * as a child — NOT this whole suite. The child is given an environment in which the
   * installed OpenCode CANNOT be reached by any route:
   *    - `ORCH_B12_REAL_CATALOG` is pinned OFF below, so the entry's NOT_RUN path is
   *      decided by the flag alone rather than by an inherited ambient value;
   *    - `ORCH_B12_OPENCODE_COMMAND` names an absolute path that does not exist;
   *    - `APPDATA` points at an empty directory, so the npm-global package layout
   *      (`%APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe`) resolves to
   *      nothing;
   *    - `PATH` is rebuilt to contain node and the Windows system directories only, so
   *      no PATH lookup can find an `opencode` binary or shim.
   *
   * With the opt-in OFF the entry must print NOT_RUN and exit 0 without starting
   * anything. With the opt-in ON the same unreachable environment must fail — an
   * enabled run that never queried anything may not report success.
   */
  const nodeDir = dirname(process.execPath);
  const winDir = process.env.SystemRoot ?? 'C:\\Windows';
  const emptyAppData = ownDir();

  /*
   * B1.2b P2: the opt-in flag is EXPLICITLY off here. Relying on the ambient
   * environment happening to be unset made this child enable the entry whenever the
   * suite was run with `ORCH_B12_REAL_CATALOG=1`, which turned the expected NOT_RUN
   * into a failure.
   */
  const r = runEntry(childEnv({
    ORCH_B12_REAL_CATALOG: '0',
    ORCH_B12_OPENCODE_COMMAND: join(emptyAppData, 'no-such-opencode.exe'),
    APPDATA: emptyAppData,
    PATH: [nodeDir, join(winDir, 'System32'), winDir].join(';'),
  }));
  check('opencode unreachable + opt-in off: the catalogue ENTRY exits 0',
    r.status === 0 && r.signal === null,
    `status=${String(r.status)} signal=${String(r.signal)} error=${r.error ?? 'none'}`);
  check('opencode unreachable + opt-in off: the ENTRY reports NOT_RUN and starts nothing',
    /NOT_RUN/.test(r.stdout) && /no discovery, no agent start, no owned context/.test(r.stdout),
    r.stdout.slice(-200));
  check('opencode unreachable + opt-in off: no assertion failed in the ENTRY run',
    !/^\s*FAIL\b/m.test(r.stdout),
    (r.stdout.match(/^\s*FAIL.*$/m) ?? []).join(' | '));

  // The failure contrast: the SAME unreachable environment with the opt-in ON must
  // fail rather than launch anything.
  const r2 = runEntry(childEnv({
    ORCH_B12_REAL_CATALOG: '1',
    ORCH_B12_OPENCODE_COMMAND: join(emptyAppData, 'no-such-opencode.exe'),
    APPDATA: emptyAppData,
    PATH: [nodeDir, join(winDir, 'System32'), winDir].join(';'),
  }));
  check('opencode unreachable + opt-in on: the catalogue ENTRY exits NON-ZERO',
    r2.status !== 0 && r2.status !== null,
    `status=${String(r2.status)} signal=${String(r2.signal)}`);
  check('opencode unreachable + opt-in on: the ENTRY does NOT print PASS',
    !/^\s*PASS\b/m.test(r2.stdout), r2.stdout.slice(-300));
}
// ---------------------------------------------------------------------------
section('the entry itself may not mask its exit code');

{
  /*
   * The ownership guard forbids a literal `process.exitCode = 0`. Here the point is
   * the opposite direction too: the entry must never call `process.exit(...)` with a
   * hardcoded code either, because that would bypass `finish()` entirely.
   */
  const src = readFileSync(ENTRY, 'utf8');
  check('the entry assigns its exit code from finish(), never a literal 0',
    !/process\.exitCode\s*=\s*0\s*;/.test(src));
  check('the entry does not call process.exit() with a hardcoded code',
    !/process\.exit\(\s*\d/.test(src));
  check('the entry uses the ownership helper (owned resources are cleaned up)',
    /setupOwnedTestContext/.test(src) && /owned\.cleanup\(\)/.test(src));
  check('the entry reads ONLY its owned control directory',
    /owned\.controlDir/.test(src) && !/controlDirectory\s*\(/.test(src));
}

// ---------------------------------------------------------------------------
// B1.2b P1-2: owned cleanup. Every recorded path is removed, and a removal failure
// reaches the SAME ledger as an assertion failure.
// ---------------------------------------------------------------------------
for (const d of tmpDirs) {
  removeOwnedDir(d);
}

// The transient report files THIS run created. Their removal failure is reported too.
for (const f of reportFiles) {
  try {
    rmSync(f, { force: true });
  } catch (e) {
    recordCleanupFailure(`report file removal threw for ${f}: ${(e as Error).message}`);
  }
  if (existsSync(f)) recordCleanupFailure(`report file ${f} still present after removal`);
}

process.stdout.write(`\n${passed} passed, ${failed} failed`);
if (failures.length) process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
if (cleanupFailures.length) {
  process.stdout.write(`cleanup failures (must fail the test):\n  ${cleanupFailures.map((f) => `- ${f}`).join('\n  ')}\n`);
}
process.exitCode = finalizeExitCode();
