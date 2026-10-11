/**
 * tests/real-agent-ownership.test.ts — W4.4 ownership proofs (HERMETIC, default suite).
 *
 * Everything here runs in the default `npm test`. It starts NO agent process: the
 * setup-injection cases throw DURING setup, before any run begins, and the sentinel
 * case only sets up and immediately cleans up. That is what keeps it hermetic while
 * still proving the ownership model.
 *
 * Proves:
 *   §21  a stand-in "shared" directory's sentinel SURVIVES owned cleanup — cleanup
 *        never reaches outside the owned root.
 *   §5   setup failures at every stage self-clean (no owned root, env exact).
 *   §7   a cleanup failure alone makes the test exit non-zero (W4H-6).
 *   §3   the helper's control directory is inside the owned root, and the launcher
 *        copy is byte-identical to the deployed binary.
 */

import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CheckLog,
  deployedLauncher,
  runInjectionCase,
  runLauncherUnavailableCleanupFailureCase,
  observeOwnedRoots,
  removeOwnedRoot,
  OWNED_PARENT,
} from './helpers/hygiene-harness.ts';
import { setupOwnedTestContext, finish } from './helpers/real-agent-isolation.ts';

const log = new CheckLog();
const launcher = deployedLauncher();

console.log('== W4.4 §21: shared control state is never touched by owned cleanup ==');
{
  /*
   * A filesystem-level proof that does NOT write into the real production
   * containment directory. A fake "shared" directory stands in for it: a sentinel
   * record is placed inside, a full owned-context lifecycle runs and cleans up, and
   * the sentinel must still be there afterwards. If cleanup ever escaped its own
   * root, the sentinel would be gone.
   */
  const fakeShared = join(tmpdir(), `w44-fake-shared-${process.pid}`);
  const sentinel = join(fakeShared, 'w1ctl-SENTINEL.txt');
  mkdirSync(fakeShared, { recursive: true });
  writeFileSync(sentinel, 'another concurrent run owns this record\n');

  const ctx = setupOwnedTestContext();
  if (ctx === null) {
    console.log('  SKIP sentinel preservation :: no deployed launcher on this machine');
  } else {
    // The owned control dir must be INSIDE the owned root, never the shared one.
    log.check('owned control dir lives inside the owned root',
      ctx.controlDir.startsWith(ctx.root), `controlDir=${ctx.controlDir}`);
    log.check('owned control dir is NOT the production control dir',
      !ctx.controlDir.includes(join(process.env.LOCALAPPDATA ?? '', 'orchestrator')),
      `controlDir=${ctx.controlDir}`);

    const cleanupFailures = await ctx.cleanup();
    log.check('cleanup itself reported no failures', cleanupFailures.length === 0,
      cleanupFailures.map((f) => `${f.resource}: ${f.error}`).join('; '));
    log.check('owned root removed after cleanup', !existsSync(ctx.root), `root=${ctx.root}`);
    log.check('SENTINEL in the stand-in shared dir SURVIVES owned cleanup', existsSync(sentinel),
      existsSync(sentinel)
        ? 'unowned record intact — cleanup stayed inside its own root'
        : 'an unowned record was destroyed — cleanup escaped its own root');
    rmSync(fakeShared, { recursive: true, force: true });
  }
}

console.log('\n== W4.4 §3: the owned launcher copy is byte-identical to the deployed one ==');
if (launcher === null) {
  console.log('  SKIP launcher-copy identity :: no deployed launcher on this machine');
} else {
  const ctx = setupOwnedTestContext();
  if (ctx === null) {
    console.log('  SKIP launcher-copy identity :: setup returned null');
  } else {
    const { createHash } = await import('node:crypto');
    const { readFileSync } = await import('node:fs');
    const h = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
    log.check('isolated copy SHA256 equals the deployed binary', ctx.sha256 === h(launcher),
      `copy=${ctx.sha256.slice(0, 16)}… deployed=${h(launcher).slice(0, 16)}…`);
    // A second cleanup must be a harmless no-op (idempotent disposal).
    await ctx.cleanup();
    const again = await ctx.cleanup();
    log.check('cleanup is idempotent', again.length === 0, `failures=${again.length}`);
  }
}

console.log('\n== W4.4 §5: setup failures self-clean (W4H-5 setup stages) ==');
if (launcher === null) {
  console.log('  SKIP setup-injection matrix :: no deployed launcher on this machine');
} else {
  const sentinelEnv: Record<string, string> = { ORCH_JOB_LAUNCHER: launcher, ORCH_KEEP_CONTROL: 'SENTINEL-KEEP' };
  // Each of these throws BEFORE any agent process is started, so this stays hermetic.
  for (const stage of ['root', 'launcher', 'env', 'dir:workspace', 'dir:repo', 'dir:store']) {
    log.add(runInjectionCase(`W4H-5 w43 setup@${stage}`, 'w43-opencode-evidence.test.ts', stage, sentinelEnv, 120_000));
  }
}

console.log('\n== W4.4 P1-A: the harness never deletes a foreign run root ==');
if (launcher === null) {
  console.log('  SKIP foreign-root preservation :: no deployed launcher on this machine');
} else {
  /*
   * A foreign root is a stand-in for ANOTHER live run's root sitting in the shared
   * parent. It is created and registered by THIS fixture, and removed by THIS
   * fixture. The harness must neither delete it nor count it as this case's leak.
   */
  const foreign = join(OWNED_PARENT, `w44-foreign-${process.pid}-${randomUUID().slice(0, 8)}`);
  const foreignSentinel = join(foreign, 'sentinel.txt');
  const sentinelContent = 'a DIFFERENT run owns this root\n';
  mkdirSync(foreign, { recursive: true });
  writeFileSync(foreignSentinel, sentinelContent);

  try {
    const sentinelEnv: Record<string, string> = { ORCH_JOB_LAUNCHER: launcher, ORCH_KEEP_CONTROL: 'SENTINEL-KEEP' };
    // A fast, hermetic case: it throws during setup, before any agent starts.
    const checks = runInjectionCase('P1-A foreign w43 setup@root', 'w43-opencode-evidence.test.ts', 'root', sentinelEnv, 120_000);
    log.add(checks);

    log.check('foreign root still exists after the case', existsSync(foreign), `foreign=${foreign}`);
    log.check('foreign sentinel content is unchanged',
      existsSync(foreignSentinel) && readFileSync(foreignSentinel, 'utf8') === sentinelContent,
      'a foreign root was deleted or mutated — cleanup escaped ownership');
    // Read-only observation: the foreign root is VISIBLE but was never owned.
    log.check('foreign root is visible to read-only observation',
      observeOwnedRoots().some((r) => r === foreign), 'observation must not imply ownership');
  } finally {
    // The FIXTURE removes its own foreign root; the harness never did.
    const removed = removeOwnedRoot(foreign);
    log.check('fixture cleaned up its own foreign root', removed.ok, removed.ok ? '' : removed.error);
  }
}

console.log('\n== W4.4 P1-B: launcher unavailable + cleanup failure must propagate ==');
if (launcher === null) {
  console.log('  SKIP P1-B regression :: no deployed launcher on this machine (branch is real here)');
} else {
  // The launcher is made unavailable by an explicit non-existent override, and the
  // owned-root removal is made to fail. The cleanup failure must NOT be swallowed.
  log.add(runLauncherUnavailableCleanupFailureCase('W4H-P1B w43', 'w43-opencode-evidence.test.ts', 120_000));
}

console.log('\n== W4.4 §7 / W4H-6: a cleanup failure alone fails the test ==');
{
  const clean = finish([{ verdict: 'PASS' }], { allowEnvironmentBlocked: true, cleanupFailures: [] });
  log.check('no failures => exit 0', clean === 0, `code=${clean}`);

  const assertionFail = finish([{ verdict: 'FAIL' }], { allowEnvironmentBlocked: true, cleanupFailures: [] });
  log.check('assertion FAIL => non-zero', assertionFail !== 0, `code=${assertionFail}`);

  // All assertions passed, but cleanup failed: the test must STILL fail. Swallowing
  // this is how a suite reports success while leaking on disk.
  const cleanupFail = finish([{ verdict: 'PASS' }], {
    allowEnvironmentBlocked: true,
    cleanupFailures: [{ resource: 'root C:\\x', error: 'EBUSY' }],
  });
  log.check('cleanup failure alone => non-zero', cleanupFail !== 0, `code=${cleanupFail}`);
}

process.exitCode = log.report();
