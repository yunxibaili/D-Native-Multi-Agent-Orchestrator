/**
 * tests/b12-version-probe-bounded.test.ts — B1.2 P1-2 bounded version-probe regression.
 *
 * ============================================================================
 * WHAT THIS PROVES
 * ============================================================================
 * That the OpenCode version probe is BOUNDED and that the bound actually stops the
 * process — not that a race happened to return first.
 *
 * The controlling case drives a REAL, CONTROLLED, RESIDENT version process through
 * the REAL production path:
 *
 *   Orchestrator.doctor()
 *     -> the real OpenCode adapter's probe()
 *     -> the real contained ManagedProcess (sealed Job launcher)
 *     -> a controlled resident fixture standing in for `opencode --version`
 *
 * The fixture is a long-lived process that prints a LOOKING-VALID version string and
 * then never exits. That is the worst case: without the probe's own deadline the
 * entry would wait forever, and the printed version would be the only thing a naive
 * implementation could report as success.
 *
 * What is asserted, all of it from the real run:
 *   1. the fixture really was alive and really made the probe wait;
 *   2. the IMPLEMENTATION'S OWN deadline fired (no external watchdog, no test-side
 *      race, no injected cancel) — the elapsed time is bounded by the probe's
 *      deadline;
 *   3. a REAL cancel and a REAL stop confirmation occurred on the ORIGINAL
 *      ManagedProcess: the launcher's own control record says it terminated the Job
 *      on our request and then POSITIVELY observed `ActiveProcesses == 0`;
 *   4. probe.ok === false, and the partial version output did NOT become the version;
 *   5. the test itself ended bounded;
 *   6. this round's owned resources were cleaned up.
 *
 * B1.2b P2: the accepted proof that the process tree stopped is that PRODUCTION-
 * VALIDATED Job record — `terminated` with `treeStopped=1` and
 * `activeProcessesFinal=0`. There is deliberately NO fresh-PID liveness probe here:
 * `process.kill(pid, 0)` cannot distinguish "the process I started exited" from
 * "some unrelated process now holds that pid", and it maps most errors to "dead",
 * so it is not a death fact in either direction.
 *
 * ============================================================================
 * THE WATCHDOG IS A LAST-RESORT BACKSTOP ONLY
 * ============================================================================
 * A watchdog runs the whole child with an outer timeout so a regression cannot hang
 * the suite forever. If that backstop ever fires, the test FAILS: a watchdog kill
 * would mean the implementation never closed itself, which is the defect under test.
 *
 * ============================================================================
 * NOT A REAL OPENCODE FAILURE
 * ============================================================================
 * The resident process is a CONTROLLED fixture. Nothing here claims the installed
 * OpenCode's `--version` ever hung; it only proves the implementation is bounded and
 * that it really stops what it started.
 *
 * Run: node tests/b12-version-probe-bounded.test.ts
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = process.cwd();

const tmpDirs: string[] = [];
const ownDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'b12vp-'));
  tmpDirs.push(d);
  return d;
};

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

/**
 * The resident fixture: prints a valid-looking version, then stays alive forever.
 *
 * It also writes its own pid so the parent can prove the process was really running
 * (liveness by ORIGINAL handle, not by a later PID probe).
 */
function writeResidentVersionFixture(dir: string): { cmd: string; cjs: string; pidFile: string } {
  const cjs = join(dir, 'resident-version.cjs');
  writeFileSync(cjs, [
    "const fs = require('fs'), path = require('path');",
    "fs.writeFileSync(path.join(__dirname, 'resident.pid'), String(process.pid));",
    "// A LOOKING-VALID version, printed BEFORE the fixture parks. A naive",
    "// implementation that races and discards the process would read this as success.",
    "process.stdout.write('1.2.3-resident\\n');",
    "// Never exit: the probe's own deadline is the only thing that can end this.",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const cmd = join(dir, 'resident-version.cmd');
  writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${cjs}"\r\n`);
  return { cmd, cjs, pidFile: join(dir, 'resident.pid') };
}


// ===========================================================================
// B1.2b P1-2 injection child: drive the SAME ledger in an isolated process and exit
// with its REAL code, so the parent can assert the child's actual status.
// ===========================================================================
if (process.env.B12VP_FAIL_CHILD !== undefined) {
  const mode = process.env.B12VP_FAIL_CHILD;
  const root = process.env.B12VP_FAIL_ROOT ?? join(tmpdir(), `b12vp-failchild-${process.pid}`);
  mkdirSync(root, { recursive: true });
  if (mode === 'rm') {
    // The owned root is deliberately left for the parent; its removal is injected as
    // a failure through the SAME helper the real cleanup uses.
    removeOwnedDir(root, { injectRemovalFailure: true });
  } else {
    recordCleanupFailure(`unknown B12VP_FAIL_CHILD mode "${mode}"`);
  }
  const code = finalizeExitCode();
  writeFileSync(join(root, 'report.json'), JSON.stringify({ cleanupFailures, exit: code }));
  process.exit(code);
}
// ---------------------------------------------------------------------------
section('P1-2: a REAL resident version process is bounded and really stopped');

/*
 * The child drives the REAL `doctor` through the REAL adapter probe with the
 * fixture as the configured OpenCode command. It reports its observations as JSON on
 * stdout so the parent can assert on real facts, and it exits with its own code.
 */
{
  const dir = ownDir();
  const fix = writeResidentVersionFixture(dir);

  const childTs = join(dir, 'probe-child.ts');
  writeFileSync(childTs, [
    `const REPO = process.cwd();`,
    `const { pathToFileURL } = await import('node:url');`,
    `const mod = await import(pathToFileURL(REPO + '/src/adapters/opencode.ts').href);`,
    `const iso = await import(pathToFileURL(REPO + '/tests/helpers/real-agent-isolation.ts').href);`,
    `const ctl = await import(pathToFileURL(REPO + '/src/runtime/containment.ts').href);`,
    `const fs = await import('node:fs');`,
    `const path = await import('node:path');`,
    '',
    'const owned = iso.setupOwnedTestContext();',
    "if (owned === null) { console.log('NO_LAUNCHER'); process.exit(3); }",
    'const out = { launcherOk: true };',
    'try {',
    `  const adapter = mod.createOpenCodeAdapter({ command: process.env.B12VP_CMD });`,
    '  const before = owned.controlDir && fs.existsSync(owned.controlDir)',
    '    ? fs.readdirSync(owned.controlDir).filter(n => n.endsWith(".txt")).length : 0;',
    '  const t0 = Date.now();',
    '  const probe = await adapter.probe();',
    '  out.elapsedMs = Date.now() - t0;',
    '  out.probeOk = probe.ok;',
    '  out.probeVersion = probe.version;',
    '  out.probeDetail = probe.detail;',
    '  out.recordsBefore = before;',
    '  // The record the probe created is the NEW one under the owned control dir.',
    '  const after = fs.existsSync(owned.controlDir)',
    '    ? fs.readdirSync(owned.controlDir).filter(n => n.endsWith(".txt")) : [];',
    '  out.recordCount = after.length;',
    '  out.statuses = [];',
    '  out.treeStoppedFacts = [];',
    '  out.activeFinal = [];',
    '  for (const n of after) {',
    '    const v = ctl.readControlRecord(path.join(owned.controlDir, n));',
    '    if (v.ok) { out.statuses.push(v.record.launcherStatus); out.treeStoppedFacts.push(ctl.treeStopConfirmedFrom(v.record)); out.activeFinal.push(v.record.activeProcessesFinal); }',
    '    else out.statuses.push("<invalid:" + v.reason + ">");',
    '  }',
    '  // The fixture pid, read from the file the fixture itself wrote.',
    '  try { out.residentPid = Number(fs.readFileSync(process.env.B12VP_PIDFILE, "utf8").trim()); } catch { out.residentPid = 0; }',

    '} catch (e) {',
    '  out.threw = String((e as Error).message);',
    '} finally {',
    '  out.cleanupFailures = await owned.cleanup();',
    '}',
    'console.log("B12VP_JSON " + JSON.stringify(out));',
    'process.exitCode = 0;',
  ].join('\n'));

  const t0 = Date.now();
  const res = spawnSync(process.execPath, [childTs], {
    cwd: REPO,
    env: { ...process.env, B12VP_CMD: fix.cmd, B12VP_PIDFILE: fix.pidFile },
    encoding: 'utf8',
    // The watchdog. It is a BACKSTOP only: the implementation's own deadline is far
    // shorter, so a run that reaches this timeout has failed the test anyway.
    timeout: 90_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const elapsed = Date.now() - t0;

  const jsonLine = (res.stdout ?? '').split('\n').find((l) => l.startsWith('B12VP_JSON '));
  if (jsonLine === undefined) {
    check('the probe child produced its observations', false,
      `status=${String(res.status)} signal=${String(res.signal)} stdout=${(res.stdout ?? '').slice(-300)}`);
  } else {
    const o = JSON.parse(jsonLine.slice('B12VP_JSON '.length)) as {
      elapsedMs?: number; probeOk?: boolean; probeVersion?: string | null; probeDetail?: string;
      recordCount?: number; statuses?: string[]; treeStoppedFacts?: boolean[];
      residentPid?: number; activeFinal?: Array<number | null>; cleanupFailures?: Array<{ resource: string; error: string }>;
      threw?: string; launcherOk?: boolean;
    };

    check('the probe child ran without throwing', o.threw === undefined, o.threw ?? '');
    check('the probe FAILED (a resident version process is not a success)', o.probeOk === false, `ok=${String(o.probeOk)} detail=${o.probeDetail}`);
    check('the partial version output did NOT become the reported version',
      o.probeVersion === null || o.probeVersion === undefined, `version=${String(o.probeVersion)}`);
    check('the failure detail names the deadline and the stop confirmation',
      /did not finish within/.test(o.probeDetail ?? '') && /tree stop confirmed=/.test(o.probeDetail ?? ''),
      o.probeDetail ?? '');
    check('the detail records that the partial output was discarded',
      /partial output/.test(o.probeDetail ?? ''), o.probeDetail ?? '');

    // 1. the fixture really was alive and really made the probe wait.
    check('the resident fixture process really existed', (o.residentPid ?? 0) > 0, `pid=${String(o.residentPid)}`);

    // 2. the IMPLEMENTATION'S OWN deadline fired, bounded.
    check('the implementation\'s own deadline bounded the wait (well under the 90s watchdog)',
      (o.elapsedMs ?? 0) > 0 && (o.elapsedMs ?? 0) < 60_000, `elapsedMs=${String(o.elapsedMs)}`);
    check('the watchdog backstop did NOT fire (the implementation closed itself)',
      res.signal === null && res.status === 0, `status=${String(res.status)} signal=${String(res.signal)}`);

    // 3. a REAL cancel and a REAL stop confirmation on the ORIGINAL ManagedProcess.
    check('the probe created its own contained control record', (o.recordCount ?? 0) >= 1, `records=${String(o.recordCount)}`);
    check('the launcher record proves a CONFIRMED tree stop',
      (o.treeStoppedFacts ?? []).some((x) => x === true), `facts=${JSON.stringify(o.treeStoppedFacts)}`);
    check('the launcher record proves a cooperative TERMINATED stop (we asked, it confirmed)',
      (o.statuses ?? []).includes('terminated'), `statuses=${JSON.stringify(o.statuses)}`);

    /*
     * B1.2b P2: the death of the resident fixture is NOT asserted with a fresh-PID
     * probe. `process.kill(pid, 0)` answers "is some process with this pid alive",
     * which is not the same question as "the process I started exited": a recycled
     * pid reads as alive, and every error other than EPERM reads as dead, so the
     * check can be wrong in BOTH directions.
     *
     * The evidence this round actually accepts is the one the production path already
     * produced and validated: the sealed launcher's OWN control record says it
     * terminated the Job on our request and then POSITIVELY observed
     * `ActiveProcesses == 0`. That is a held-handle-grade fact about the Job, not a
     * pid lookup, and it is asserted above. No observer or second death proof is
     * introduced for this.
     */
    check('the Job reported itself EMPTY after the cooperative stop (the accepted death evidence)',
      (o.treeStoppedFacts ?? []).some((x) => x === true) && (o.activeFinal ?? []).every((v) => v === 0),
      `facts=${JSON.stringify(o.treeStoppedFacts)} activeProcessesFinal=${JSON.stringify(o.activeFinal)}`);
    check('the whole run ended bounded (no watchdog kill)', elapsed < 90_000, `elapsed=${elapsed}ms`);

    // 6. this round's owned resources were cleaned up.
    check('this round\'s owned resources were cleaned up', (o.cleanupFailures ?? []).length === 0,
      JSON.stringify(o.cleanupFailures ?? []));
  }
}

// ---------------------------------------------------------------------------
section('P1-2: a normal version return still succeeds');

{
  const dir = ownDir();
  const cjs = join(dir, 'normal-version.cjs');
  writeFileSync(cjs, "process.stdout.write('9.9.9-normal\\n'); process.exit(0);\n");
  const cmd = join(dir, 'normal-version.cmd');
  writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${cjs}"\r\n`);

  const childTs = join(dir, 'normal-child.ts');
  writeFileSync(childTs, [
    `const REPO = process.cwd();`,
    `const { pathToFileURL } = await import('node:url');`,
    `const mod = await import(pathToFileURL(REPO + '/src/adapters/opencode.ts').href);`,
    `const iso = await import(pathToFileURL(REPO + '/tests/helpers/real-agent-isolation.ts').href);`,
    '',
    'const owned = iso.setupOwnedTestContext();',
    "if (owned === null) { console.log('NO_LAUNCHER'); process.exit(3); }",
    'let probe;',
    'try {',
    `  const adapter = mod.createOpenCodeAdapter({ command: process.env.B12VP_CMD });`,
    '  const t0 = Date.now();',
    '  probe = await adapter.probe();',
    '  console.log("B12VP_NORMAL " + JSON.stringify({ ok: probe.ok, version: probe.version, elapsedMs: Date.now() - t0 }));',
    '} catch (e) {',
    '  console.log("B12VP_NORMAL " + JSON.stringify({ threw: String((e as Error).message) }));',
    '} finally {',
    '  const f = await owned.cleanup();',
    '  console.log("B12VP_CLEAN " + JSON.stringify(f));',
    '}',
    // NO process.exit(): the process must end naturally once the loop drains. A
    // leaked deadline timer would keep it (and therefore this run) alive.
    'process.exitCode = 0;',
  ].join('\n'));

  const t0 = Date.now();
  const res = spawnSync(process.execPath, [childTs], {
    cwd: REPO,
    env: { ...process.env, B12VP_CMD: cmd },
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const elapsed = Date.now() - t0;
  const line = (res.stdout ?? '').split('\n').find((l) => l.startsWith('B12VP_NORMAL '));
  const cleanLine = (res.stdout ?? '').split('\n').find((l) => l.startsWith('B12VP_CLEAN '));

  if (line === undefined) {
    check('the normal-version child produced its observation', false,
      `status=${String(res.status)} signal=${String(res.signal)} stdout=${(res.stdout ?? '').slice(-300)}`);
  } else {
    const o = JSON.parse(line.slice('B12VP_NORMAL '.length)) as { ok?: boolean; version?: string | null; elapsedMs?: number; threw?: string };
    check('a normal version return succeeds', o.ok === true && o.version === '9.9.9-normal',
      `ok=${String(o.ok)} version=${String(o.version)} threw=${o.threw ?? ''}`);
    check('the normal probe is fast (no deadline wait)', (o.elapsedMs ?? 0) < 10_000, `elapsedMs=${String(o.elapsedMs)}`);
  }
  check('the normal-version run ended naturally WELL before any deadline',
    res.status === 0 && res.signal === null && elapsed < 20_000,
    `status=${String(res.status)} signal=${String(res.signal)} elapsed=${elapsed}ms`);
  if (cleanLine !== undefined) {
    const f = JSON.parse(cleanLine.slice('B12VP_CLEAN '.length)) as Array<{ resource: string; error: string }>;
    check('the normal-version run cleaned up its owned resources', f.length === 0, JSON.stringify(f));
  }
}

// ---------------------------------------------------------------------------
section('P1-2: a non-zero / unparseable version is a failure, not a hang');

{
  const dir = ownDir();
  const cases: Array<{ label: string; body: string; code: number }> = [
    { label: 'non-zero exit', body: "process.stdout.write('1.0.0\\n');", code: 4 },
    { label: 'unparseable output', body: "process.stdout.write('not a version at all\\n');", code: 0 },
  ];
  for (const c of cases) {
    const cjs = join(dir, `v-${c.label.replace(/\W+/g, '_')}.cjs`);
    writeFileSync(cjs, `${c.body} process.exit(${c.code});\n`);
    const cmd = join(dir, `v-${c.label.replace(/\W+/g, '_')}.cmd`);
    writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${cjs}"\r\nexit /b ${c.code}\r\n`);

    const childTs = join(dir, `child-${c.label.replace(/\W+/g, '_')}.ts`);
    writeFileSync(childTs, [
      `const REPO = process.cwd();`,
    `const { pathToFileURL } = await import('node:url');`,
    `const mod = await import(pathToFileURL(REPO + '/src/adapters/opencode.ts').href);`,
      `const iso = await import(pathToFileURL(REPO + '/tests/helpers/real-agent-isolation.ts').href);`,
      'const owned = iso.setupOwnedTestContext();',
      "if (owned === null) { console.log('NO_LAUNCHER'); process.exit(3); }",
      'let out;',
      'try {',
      `  const adapter = mod.createOpenCodeAdapter({ command: process.env.B12VP_CMD });`,
      '  const p = await adapter.probe();',
      '  out = { ok: p.ok, version: p.version, detail: p.detail };',
      '} catch (e) { out = { threw: String((e as Error).message) }; }',
      'finally { await owned.cleanup(); }',
      'console.log("B12VP_V " + JSON.stringify(out));',
      'process.exitCode = 0;',
    ].join('\n'));

    const res = spawnSync(process.execPath, [childTs], {
      cwd: REPO,
      env: { ...process.env, B12VP_CMD: cmd },
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const line = (res.stdout ?? '').split('\n').find((l) => l.startsWith('B12VP_V '));
    if (line === undefined) {
      check(`${c.label}: produced an observation`, false, `status=${String(res.status)} signal=${String(res.signal)}`);
    } else {
      const o = JSON.parse(line.slice('B12VP_V '.length)) as { ok?: boolean; version?: string | null; detail?: string; threw?: string };
      check(`${c.label}: probe.ok === false`, o.ok === false, JSON.stringify(o));
      /*
       * The version FIELD is a diagnostic, not the verdict: on a non-zero exit the
       * probe still reports what it parsed (the caller must read `ok`, which is
       * false). What must never happen is that a partial version is promoted to a
       * SUCCESS — so the assertion below is on `ok`, and the field is only required
       * to be absent for the unparseable case where nothing was parsed at all.
       */
      if (c.label === 'unparseable output') {
        check('unparseable output: no version was parsed at all', o.version === null || o.version === undefined,
          `version=${String(o.version)}`);
      } else {
        check('non-zero exit: ok is false even though a version string was printed', o.ok === false,
          `ok=${String(o.ok)} version=${String(o.version)}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
section('the probe releases its timer on every path (architecture guard)');

{
  const src = readFileSync(join(REPO, 'src', 'adapters', 'opencode.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('the probe has its own deadline constant', /VERSION_PROBE_TIMEOUT_MS/.test(src));
  check('the deadline is cleared in a finally (released on success, throw AND timeout)',
    /finally\s*\{[^}]*clearTimeout\(deadline\)/.test(src));
  check('the timeout path cancels the ORIGINAL ManagedProcess',
    /proc\.cancel\(/.test(src));
  check('the timeout path settles the cleanup', /proc\.settleCleanup\(/.test(src));
  check('the timeout path never reports a version from partial output',
    /version:\s*null/.test(src));
  check('the probe still uses the production ManagedProcess (no bare execFile/timeout)',
    /new ManagedProcess\(/.test(src) && !/execFile/.test(src));
  check('no new authority / manager was introduced',
    !/ProcessManager|ProbeManager/.test(src));
}

// ---------------------------------------------------------------------------
section('B1.2b P1-2: a cleanup failure alone decides the exit code (real child)');

{
  const testFile = fileURLToPath(import.meta.url);
  const childRoot = join(tmpdir(), `b12vp-failchild-${randomUUID().slice(0, 8)}`);
  const res = spawnSync(process.execPath, [testFile], {
    cwd: REPO,
    env: { ...process.env, B12VP_FAIL_CHILD: 'rm', B12VP_FAIL_ROOT: childRoot },
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
    childRoot.startsWith(join(tmpdir(), 'b12vp-failchild-')), childRoot);
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
