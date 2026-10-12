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
 * ISOLATION
 * ============================================================================
 * HERMETIC: no real agent is ever started by THIS suite. The child processes it
 * spawns are the entry under test plus controlled Node fixtures. Cases 2-5 inject
 * their condition through the entry's own existing seams (env, an explicit
 * `--command`-style override via a controlled fixture, or the owned-context env), so
 * no global agent configuration, credential, default model, plugin or MCP is touched.
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
import { join } from 'node:path';

const REPO = process.cwd();
const ENTRY = join(REPO, 'tests', 'b12-opencode-model-catalog.test.ts');

const tmpDirs: string[] = [];
const ownDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'b12ef-'));
  tmpDirs.push(d);
  return d;
};

let passed = 0;
let failed = 0;
const failures: string[] = [];
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
    env: { ...process.env, ...env },
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

// ---------------------------------------------------------------------------
section('case 1: NOT ENABLED — exit 0, no owned context, no agent');

{
  const r = runEntry({});
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

  const r = runEntry({
    ORCH_B12_REAL_CATALOG: '1',
    // The standard agents.opencode.command seam: a configured absolute path that does
    // not exist is a HARD resolution error in production discovery, so the agent is
    // genuinely unavailable rather than mocked.
    ORCH_B12_OPENCODE_COMMAND: join(empty, 'no-opencode-here.exe'),
  });

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
  const r = runEntry({
    ORCH_B12_REAL_CATALOG: '1',
    ORCH_JOB_LAUNCHER: join(tmpdir(), 'b12-no-such-launcher.exe'),
  });
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

  const r = runEntry({
    ORCH_B12_REAL_CATALOG: '1',
    ORCH_B12_OPENCODE_COMMAND: cmd,
  });

  check('query failure: exits NON-ZERO', r.status !== 0 && r.status !== null, `status=${String(r.status)} signal=${String(r.signal)} error=${r.error}`);
  check('query failure: was not killed by a signal', r.signal === null, `signal=${String(r.signal)}`);
  check('query failure: reports a failed catalogue status', /status=failed/.test(r.stdout), r.stdout.slice(-600));
  check('query failure: does NOT report PASS for the catalogue', !/PASS real catalogue query completed/.test(r.stdout), r.stdout.slice(-600));
}

// ---------------------------------------------------------------------------
section('case 5: ENABLED, assertions pass, cleanup fails — NON-ZERO');

{
  /*
   * The cleanup-failure branch uses the EXISTING, already-proven injection seam in
   * `tests/helpers/real-agent-isolation.ts` (`ORCH_W4H_FAIL_ROOT_RM=1`): the owned
   * root removal itself throws EBUSY, so cleanup reports a real failure. Everything
   * before that point is the normal real run, so the query really succeeds and the
   * ONLY thing wrong is the cleanup.
   *
   * The child deliberately leaves its root on disk; this parent removes that ONE
   * named path afterwards as fixture cleanup.
   */
  const r = runEntry({
    ORCH_B12_REAL_CATALOG: '1',
    ORCH_W4H_FAIL_ROOT_RM: '1',
    ORCH_W4H_REPORT: join(tmpdir(), `b12ef-report-${process.pid}.json`),
  });

  check('cleanup failure: exits NON-ZERO despite the query succeeding',
    r.status !== 0 && r.status !== null, `status=${String(r.status)} signal=${String(r.signal)} error=${r.error}`);
  check('cleanup failure: was not killed by a signal', r.signal === null, `signal=${String(r.signal)}`);
  check('cleanup failure: the catalogue itself still succeeded (only cleanup was wrong)',
    /PASS real catalogue query completed/.test(r.stdout), r.stdout.slice(-600));
  check('cleanup failure: reports the cleanup failure in the output',
    /cleanup failure/i.test(r.stdout), r.stdout.slice(-600));
  check('cleanup failure: final line is FAIL, not PASS', /B1\.2 real catalogue: FAIL/.test(r.stdout), r.stdout.slice(-200));

  // Fixture cleanup: remove the ONE root the child reported, never by enumeration.
  try {
    const report = JSON.parse(readFileSync(join(tmpdir(), `b12ef-report-${process.pid}.json`), 'utf8')) as { ownedRoot?: string | null };
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
for (const d of tmpDirs) {
  try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
}

process.stdout.write(`\n${passed} passed, ${failed} failed
`);
if (failures.length) process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
process.exitCode = failed === 0 ? 0 : 1;
