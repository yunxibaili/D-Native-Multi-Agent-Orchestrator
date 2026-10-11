/**
 * tests/helpers/hygiene-harness.ts — shared machinery for the W4.4 cleanup proofs.
 *
 * Runs an opt-in real-agent suite as a REAL CHILD PROCESS with a deliberate throw
 * injected at a named stage, waits for it to exit, and then inspects the machine
 * from the PARENT. The check must happen here, not in a wrapper that tidies up
 * afterwards: a wrapper could delete the very artifacts under test, and that is
 * explicitly not accepted as evidence.
 *
 * ============================================================================
 * OWNERSHIP BY PATH, NOT BY ENUMERATION (W4.4 P1-A)
 * ============================================================================
 * A real-agent test root lives under `<temp>/orchestrator-real-agent/`, which is
 * SHARED with every other run. An earlier version of this harness "reset the
 * baseline" by enumerating that parent and recursively deleting every entry. That
 * is a cross-run hazard: an unrelated, still-live run's root would be deleted too.
 *
 * So this harness NEVER deletes by enumeration, and never guesses ownership from a
 * prefix. Each child reports the ONE root IT created (via the hygiene report), and
 * the parent checks and (only in the deliberate P1-B fixture) removes THAT path.
 * Observing a directory is not owning it; a foreign root is simply never named.
 *
 * This is a TEST helper. It owns nothing and deletes nothing except the transient
 * report file it created and, in one explicit regression, a fixture root it made.
 */

import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { OWNED_ROOT_PARENT } from './real-agent-isolation.ts';

export const REPO = process.cwd();
export const OWNED_PARENT = join(tmpdir(), OWNED_ROOT_PARENT);

export interface HygieneCheck {
  name: string;
  ok: boolean;
  detail: string;
}

interface HygieneReport {
  env?: Record<string, string | null>;
  ownedRoot?: string | null;
  thrown?: string | null;
}

/**
 * READ-ONLY observation of the owned-root parent. Used to SEE what exists; the
 * result must never be used as a delete list, because presence is not ownership.
 */
export function observeOwnedRoots(): string[] {
  try {
    if (!existsSync(OWNED_PARENT)) return [];
    return readdirSync(OWNED_PARENT).map((n) => join(OWNED_PARENT, n));
  } catch {
    return [];
  }
}

/** Remove ONE explicitly-owned path. Never a parent, never by enumeration. */
export function removeOwnedRoot(root: string): { ok: boolean; error: string } {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return { ok: !existsSync(root), error: '' };
  } catch (e) {
    return { ok: false, error: String((e as Error).message) };
  }
}

/** Launcher copies / control records / stop files under ONE owned root. */
export function countArtifactsUnder(root: string): { launcherCopies: number; controlRecords: number; stopFiles: number } {
  let launcherCopies = 0;
  let controlRecords = 0;
  let stopFiles = 0;
  if (!existsSync(root)) return { launcherCopies, controlRecords, stopFiles };
  const launcherDir = join(root, 'launcher');
  if (existsSync(join(launcherDir, 'w1joblauncher.exe'))) launcherCopies++;
  const ctl = join(launcherDir, 'containment-run');
  if (existsSync(ctl)) {
    for (const f of readdirSync(ctl)) {
      if (f.endsWith('.txt')) controlRecords++;
      if (f.endsWith('.stop') || f.includes('stop')) stopFiles++;
    }
  }
  return { launcherCopies, controlRecords, stopFiles };
}

/** The deployed production launcher, or null when this machine has none. */
export function deployedLauncher(): string | null {
  const p = join(process.env.LOCALAPPDATA ?? '', 'orchestrator', 'w1joblauncher.exe');
  return existsSync(p) ? p : null;
}

function reportPath(label: string): string {
  return join(tmpdir(), `w44-report-${process.pid}-${label.replace(/[^A-Za-z0-9]+/g, '_')}.json`);
}

function readReport(path: string): { report: HygieneReport | null; error: string } {
  try {
    return { report: JSON.parse(readFileSync(path, 'utf8')) as HygieneReport, error: '' };
  } catch (e) {
    return { report: null, error: String((e as Error).message) };
  }
}

/**
 * Run one suite with an injected throw and return the hygiene checks for it.
 *
 * `expectedEnv` are the sentinel values the PARENT set; the child must hand them
 * back byte-for-byte, which is what proves EXACT restoration rather than a blanket
 * `delete`. Leftovers are attributed to the CHILD'S OWN reported root only, so a
 * foreign or historical root is neither deleted nor miscounted.
 */
export function runInjectionCase(
  label: string,
  suite: string,
  stage: string,
  expectedEnv: Record<string, string>,
  timeoutMs: number,
): HygieneCheck[] {
  const report = reportPath(label);
  const env = { ...process.env, ORCH_W4H_INJECT: stage, ORCH_W4H_REPORT: report, ...expectedEnv };

  const res = spawnSync(process.execPath, [join(REPO, 'tests', suite)], {
    cwd: REPO,
    env,
    timeout: timeoutMs,
    encoding: 'utf8',
    // Own the pipes; never inherit the parent's stdio, so a runaway child cannot
    // interleave into the suite's own output.
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const checks: HygieneCheck[] = [];
  const { report: parsed, error: readError } = readReport(report);

  // ---- env restoration, read from the child's own final report ----
  if (parsed === null) {
    checks.push({ name: `${label} :: environment restored exactly`, ok: false, detail: `report unreadable: ${readError}` });
    checks.push({ name: `${label} :: injected throw actually fired`, ok: false, detail: 'no report' });
    checks.push({ name: `${label} :: child reported its own owned root`, ok: false, detail: 'no report' });
    checks.push({ name: `${label} :: child's own owned root removed`, ok: false, detail: 'no report' });
  } else {
    const after = parsed.env ?? {};
    const mismatches = Object.entries(expectedEnv).filter(([k, v]) => after[k] !== v);
    checks.push({
      name: `${label} :: environment restored exactly`,
      ok: mismatches.length === 0,
      detail: mismatches.length === 0
        ? `restored exactly (${Object.keys(expectedEnv).join(', ')})`
        : `mismatch: ${mismatches.map(([k, v]) => `${k}=${String(after[k])} want ${v}`).join('; ')}`,
    });
    checks.push({
      name: `${label} :: injected throw actually fired`,
      ok: typeof parsed.thrown === 'string',
      detail: `thrown=${String(parsed.thrown)}`,
    });

    // ---- leftovers, attributed to the CHILD'S OWN root only ----
    const ownedRoot = parsed.ownedRoot ?? null;
    checks.push({
      name: `${label} :: child reported its own owned root`,
      ok: typeof ownedRoot === 'string' && ownedRoot.length > 0,
      detail: `ownedRoot=${String(ownedRoot)}`,
    });
    const remains = ownedRoot !== null && existsSync(ownedRoot);
    checks.push({
      name: `${label} :: child's own owned root removed`,
      ok: ownedRoot !== null && !remains,
      detail: `ownedRoot=${String(ownedRoot)} remains=${remains}`,
    });
    const arts = ownedRoot === null ? { launcherCopies: 0, controlRecords: 0, stopFiles: 0 } : countArtifactsUnder(ownedRoot);
    checks.push({
      name: `${label} :: 0 owned launcher copies / control records / stop files`,
      ok: arts.launcherCopies === 0 && arts.controlRecords === 0 && arts.stopFiles === 0,
      detail: `launchers=${arts.launcherCopies} control=${arts.controlRecords} stop=${arts.stopFiles}`,
    });
    unlinkSync(report);
  }

  // ---- an injected failure must NOT exit 0 ----
  checks.push({
    name: `${label} :: injected failure exits non-zero`,
    ok: res.status !== 0,
    detail: `status=${String(res.status)}`,
  });

  return checks;
}

/**
 * W4.4 P1-B regression: launcher unavailable AND the owned-root removal fails.
 *
 * Runs a real suite as a child with a NON-EXISTENT launcher override (production
 * resolution fails closed -> unavailable) and `ORCH_W4H_FAIL_ROOT_RM=1` (the owned
 * root removal itself throws). The child must PROPAGATE the cleanup failure and
 * exit non-zero; a clean teardown on this path would legitimately exit 0, which is
 * why the injected failure is what makes the branch observable.
 *
 * The child's root is deliberately left on disk by the injection; this function
 * removes THAT specific path as fixture cleanup afterwards and reports whether it
 * was removable, so no unremovable directory is left behind.
 */
export function runLauncherUnavailableCleanupFailureCase(
  label: string,
  suite: string,
  timeoutMs: number,
): HygieneCheck[] {
  const report = reportPath(label);
  const env = {
    ...process.env,
    // An explicit override that does not exist is a hard config error in production
    // resolution, so the launcher is genuinely unavailable without touching the real one.
    ORCH_JOB_LAUNCHER: join(tmpdir(), 'w44-does-not-exist-launcher.exe'),
    ORCH_W4H_FAIL_ROOT_RM: '1',
    ORCH_W4H_REPORT: report,
  };

  const res = spawnSync(process.execPath, [join(REPO, 'tests', suite)], {
    cwd: REPO,
    env,
    timeout: timeoutMs,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const checks: HygieneCheck[] = [];
  const { report: parsed, error: readError } = readReport(report);

  checks.push({
    name: `${label} :: launcher-unavailable + cleanup failure exits non-zero`,
    ok: res.status !== 0,
    detail: `status=${String(res.status)}`,
  });

  if (parsed === null) {
    checks.push({ name: `${label} :: cleanup failure was not lost`, ok: false, detail: `report unreadable: ${readError}` });
    return checks;
  }

  // The failure must SURVIVE: the thrown error must name the cleanup failure, and
  // it must NOT have been downgraded to a warning/SKIP/empty-failures exit 0.
  const thrown = String(parsed.thrown ?? '');
  checks.push({
    name: `${label} :: cleanup failure was not lost`,
    ok: /cleanup failed/i.test(thrown) && /root .*EBUSY/i.test(thrown),
    detail: `thrown=${thrown.slice(0, 200)}`,
  });

  // The injected removal failure must be real: the owned root is still present.
  const ownedRoot = parsed.ownedRoot ?? null;
  const remains = ownedRoot !== null && existsSync(ownedRoot);
  checks.push({
    name: `${label} :: injected removal failure left the owned root (real failure)`,
    ok: remains,
    detail: `ownedRoot=${String(ownedRoot)} remains=${remains}`,
  });

  // FIXTURE CLEANUP (not evidence): remove the ONE path this case created, so the
  // injected failure leaves no unremovable directory behind.
  if (ownedRoot !== null) {
    const removed = removeOwnedRoot(ownedRoot);
    checks.push({
      name: `${label} :: fixture removed the injected owned root`,
      ok: removed.ok,
      detail: removed.ok ? `removed ${ownedRoot}` : `could not remove ${ownedRoot}: ${removed.error}`,
    });
  }
  try { unlinkSync(report); } catch { /* best effort */ }

  return checks;
}

/** Shared check accumulator with consistent PASS/FAIL reporting. */
export class CheckLog {
  passed = 0;
  failed = 0;
  readonly failures: string[] = [];

  check(name: string, ok: boolean, detail = ''): void {
    if (ok) {
      this.passed++;
      console.log(`  ok   ${name}${detail ? ` :: ${detail}` : ''}`);
    } else {
      this.failed++;
      this.failures.push(name);
      console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}`);
    }
  }

  add(checks: HygieneCheck[]): void {
    for (const c of checks) this.check(c.name, c.ok, c.detail);
  }

  report(): number {
    console.log(`\n${this.passed} passed, ${this.failed} failed`);
    if (this.failed > 0) console.log(`failing:\n  - ${this.failures.join('\n  - ')}`);
    return this.failed === 0 ? 0 : 1;
  }
}
