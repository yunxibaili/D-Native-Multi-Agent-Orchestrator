/**
 * tests/real-agent-cleanup.test.ts — W4.4 real-agent cleanup proofs (OPT-IN).
 *
 * Not part of `npm test`: these cases START a real OpenCode/Codex process and then
 * inject a throw after containment is established, so they need real agents and are
 * necessarily opt-in. The hermetic ownership proofs (sentinel, setup-failure
 * self-clean, exit semantics) live in `real-agent-ownership.test.ts`, which does
 * run in the default suite.
 *
 * For each case this runs the suite as a REAL CHILD PROCESS with a deliberate
 * throw, waits for it to exit, and only then inspects the machine from the PARENT:
 * 0 owned roots, 0 launcher copies / control records / stop files, and an EXACT
 * return of the environment sentinels the parent set. A wrapper that cleaned up
 * afterwards could hide a leak and is not accepted as evidence.
 */

import { CheckLog, deployedLauncher, runInjectionCase } from './helpers/hygiene-harness.ts';

const log = new CheckLog();
const launcher = deployedLauncher();

console.log('== W4.4 §8/§9/§10: real-agent cleanup under injected failure ==');

if (launcher === null) {
  console.log('  SKIP injected-failure matrix :: no deployed launcher on this machine');
} else {
  // Distinctive sentinels: the child must put these EXACT strings back, which is
  // what distinguishes correct restoration from a blanket `delete`.
  const sentinelEnv: Record<string, string> = { ORCH_JOB_LAUNCHER: launcher, ORCH_KEEP_CONTROL: 'SENTINEL-KEEP' };

  // §8 / §9: exception AFTER a real cancel established containment (no 90s smoke).
  log.add(runInjectionCase('W4H-1/2 w42-opencode', 'w42-opencode-lifecycle.test.ts', 'after-cancel', sentinelEnv, 300_000));
  log.add(runInjectionCase('W4H-3/4 w42-codex', 'w42-codex-lifecycle.test.ts', 'after-cancel', sentinelEnv, 300_000));

  // §10: exception in the test BODY of the hard-kill suite, after real evidence.
  log.add(runInjectionCase('W4H-5 w43 body@after-hardkill', 'w43-opencode-evidence.test.ts', 'after-hardkill', sentinelEnv, 400_000));
}

process.exitCode = log.report();
