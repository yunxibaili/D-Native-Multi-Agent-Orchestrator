/**
 * tests/real-agent-isolation.test.ts — W4.4 ownership guard.
 *
 * ============================================================================
 * THE HAZARD
 * ============================================================================
 * Containment control/stop artifacts live in ONE shared directory beside the
 * DEPLOYED production launcher (`%LOCALAPPDATA%\orchestrator\containment-run`).
 * Every concurrent contained run on the machine writes there. So:
 *
 *  - DELETING it destroys another live run's control record or stop marker.
 *  - READING it is nearly as bad: a test would observe another run's record and
 *    could attribute it to itself, manufacturing a false PASS.
 *
 * Is this checkable by convention? No. The failure is silent and invisible in
 * single-run CI, and a later edit can reintroduce it by accident. So the invariant
 * is enforced by reading the real-agent test sources and failing on the SEMANTIC
 * pattern, not on one literal string.
 *
 * WHAT IS ENFORCED (bounded, source-level — deliberately not an AST platform)
 *  1. A real-agent test may not DELETE or READ a production control directory. Any
 *     derivation of a control path from a PRODUCTION-RESOLVED launcher is refused:
 *     `controlDirectory(...)`, `resolveContainmentLauncher()`, or a hardcoded
 *     `containment-run` path. This holds EVEN IF the test also uses the isolation
 *     helper — that combination was the previously-missed mutation.
 *  2. A real-agent test that touches containment control state must obtain it from
 *     the owned context (`withOwnedTestContext` / `setupOwnedTestContext`).
 *  3. A real-agent test must not glob control/stop artifacts (`*.ctl`, `*.stop`) or
 *     delete by guessed parent/temp prefix.
 *  4. A real-agent test must not hardcode `process.exitCode`, which can mask a
 *     required assertion failure or a cleanup failure.
 *  5. Every real-agent test on disk must be listed here, so a NEW one cannot escape.
 *
 * The helper is checked too: it must derive its control directory from the OWNED
 * launcher copy, never from the production one, and must verify the copy is
 * byte-identical rather than silently testing a different binary.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every opt-in test that starts a REAL agent process. */
const REAL_AGENT_TESTS = [
  'w41-opencode-natural-exit.test.ts',
  'w42-opencode-lifecycle.test.ts',
  'w42-codex-lifecycle.test.ts',
  'w43-opencode-evidence.test.ts',
  // B1.2: opt-in real OpenCode `models` catalogue query (contained ManagedProcess).
  'b12-opencode-model-catalog.test.ts',
  // B4.7.1: opt-in REAL OpenCode free-duo acceptance ENTRY. It owns its demo, launcher
  // copy and control records via the ownership helper, and it launches nothing unless
  // both the entitlement scope AND the auxiliary-model containment are established.
  'b47-free-duo.test.ts',
];

const HELPER = join(HERE, 'helpers', 'real-agent-isolation.ts');

/** Strip comments so the guard's own prose cannot trip it. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const failures: string[] = [];

for (const name of REAL_AGENT_TESTS) {
  const raw = readFileSync(join(HERE, name), 'utf8');
  const src = code(raw);
  const fail = (msg: string): void => {
    failures.push(`${name}: ${msg}`);
  };

  // -- 1. no production control-directory derivation, read OR delete ---------
  // These are the semantic handles for "reached the production launcher's control
  // state". Presence of any of them is the violation, independent of intent.
  if (/controlDirectory\s*\(/.test(src)) {
    fail('derives a control directory via controlDirectory(...); a real-agent test may only use the control dir owned by its isolation context');
  }
  if (/resolveContainmentLauncher/.test(src)) {
    fail('references resolveContainmentLauncher(); a real-agent test must not resolve the PRODUCTION launcher — use the owned isolated copy');
  }
  if (/['"`]containment-run['"`]/.test(src)) {
    fail('hardcodes a containment-run path; the control directory must come from the owned context, never be named literally');
  }
  // Deletion of a shared/production-shaped path, however it was obtained.
  if (/rmSync\(\s*controlDirectory/.test(src)) {
    fail('deletes the SHARED production control directory; a real-agent test may only delete paths it created');
  }

  // -- 2. control state must come from the owned context ----------------------
  if (!/withOwnedTestContext|setupOwnedTestContext/.test(src)) {
    fail('does not use the ownership helper (withOwnedTestContext/setupOwnedTestContext); every real-agent test must own its resources');
  }

  // -- 3. no globbing or guessed-parent deletion ------------------------------
  if (/\*\.(ctl|stop)['"`]/.test(src)) {
    fail('globs control/stop artifacts (*.ctl / *.stop); that can select another run\'s records');
  }
  if (/rmSync\(\s*(tmpdir\(\)|os\.tmpdir\(\))/ .test(src)) {
    fail('deletes the system temp directory itself; only a uniquely owned root may be removed');
  }

  // -- 4. no masked exit code -----------------------------------------------
  // Only a literal `0` can MASK a result. A literal `1` can only make a run fail,
  // so it is allowed (the suites use it for the deliberately-injected throw);
  // anything else must come from `finish()`, which accounts for BOTH assertion
  // failures and cleanup failures.
  if (/process\.exitCode\s*=\s*0\s*;/.test(src)) {
    fail('hardcodes process.exitCode = 0, which masks required assertion failures and cleanup failures; use finish() from real-agent-isolation.ts');
  }
}

// -- the helper itself -------------------------------------------------------
{
  const helperSrc = code(readFileSync(HELPER, 'utf8'));

  // The helper is the ONE place allowed to resolve a production launcher (it copies
  // the binary), but it must derive its control dir from the COPY, never call
  // controlDirectory() on a production resolution.
  if (/controlDirectory\s*\(/.test(helperSrc)) {
    failures.push('real-agent-isolation.ts: derives a control dir via controlDirectory(...); it must join the owned launcher directory instead');
  }
  if (!/mkdtempSync/.test(helperSrc)) {
    failures.push('real-agent-isolation.ts: no mkdtempSync; the owned root must be unique per test run');
  }
  if (!/createHash\('sha256'\)/.test(helperSrc)) {
    failures.push('real-agent-isolation.ts: no SHA256 verification; the isolated copy must be proven byte-identical to the deployed binary');
  }
  // Ownership must be real: a single owned root that cleanup removes.
  if (!/OWNED_ROOT_PARENT/.test(helperSrc)) {
    failures.push('real-agent-isolation.ts: no OWNED_ROOT_PARENT; owned roots must live under an identifiable parent so leaks are detectable');
  }
  // Cleanup must not swallow failures.
  if (!/CleanupFailure/.test(helperSrc)) {
    failures.push('real-agent-isolation.ts: cleanup failures are not collected; a swallowed cleanup error would hide a leak');
  }
}

// -- shared production control path must remain what we think it is ----------
{
  const { controlDirectory, resolveContainmentLauncher } = await import('../src/runtime/containment.ts');
  const deployed = resolveContainmentLauncher();
  if (deployed !== null) {
    const shared = controlDirectory(deployed);
    if (!/containment-run/.test(shared)) {
      failures.push(`controlDirectory() no longer resolves to containment-run (got ${shared}); this guard's assumption changed`);
    }
  }
}

// -- every real-agent test on disk must be listed ----------------------------
// The discovery covers the historical `w4N-` suites AND the newer `bN-` slices, so a
// new opt-in real-agent entry cannot escape the ownership rules by naming alone.
for (const f of readdirSync(HERE).filter((n) => /^(w4\d|b\d+)-.*\.test\.ts$/.test(n))) {
  if (REAL_AGENT_TESTS.includes(f)) continue;
  const src = code(readFileSync(join(HERE, f), 'utf8'));
  if (/agentId:\s*'(opencode|codex|cline|workbuddy)/.test(src)) {
    failures.push(`${f}: starts a real agent but is not listed in REAL_AGENT_TESTS, so the ownership rules are not applied to it`);
  }
}

if (failures.length > 0) {
  console.error('W4.4 real-agent ownership guard FAILED:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log(`W4.4 real-agent ownership guard PASSED (${REAL_AGENT_TESTS.length} opt-in tests, 0 shared-control-state violations)`);
}
