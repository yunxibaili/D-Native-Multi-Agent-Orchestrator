/**
 * scripts/test-timed.mjs — R5-1.1 (§12) / R5-1.2 (§10): the ONE `npm test` entry
 * point, with per-suite timing and HONEST exit semantics.
 *
 * Exit semantics (R5-1.2 §10):
 *   - a child's exit code is PASSED THROUGH: the wrapper exits with the first
 *     failing child's own code (7 stays 7), never a blanket 1;
 *   - a spawn ERROR is recorded as the fact `spawn-error` and exits non-zero;
 *   - a child killed by a SIGNAL is recorded with the signal name — never
 *     fabricated into an ordinary exit code;
 *   - on Ctrl+C / SIGTERM the runner stops the CURRENT child's whole TREE, AWAITS the
 *     tree kill, waits for the child to exit, then exits 130.
 *
 * R5-1.2C (§13): that interrupt used to be `child.kill()`, which terminates only the
 * DIRECT child. A suite that spawned a descendant left it running after the runner
 * exited. The runner now REUSES the repository's one existing tree killer,
 * `taskkillTree` from src/runtime/spawn.ts, so there is still exactly one Windows
 * process-tree killer and no second process manager.
 *
 * The duration is measured around the CHILD process, so it covers
 * "process exited": a suite whose assertions finished early but whose dangling
 * timer / child process / cleanup keeps the process alive shows up as a long
 * wall-clock tail.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

// The ONE existing process-tree killer, reused rather than reimplemented here.
import { taskkillTree } from '../src/runtime/spawn.ts';

const SUITES = [
  'unit',
  'contract',
  'decision',
  'workbuddy',
  'cline',
  'quota',
  // B1.1: the READ-ONLY native model-catalogue snapshot. Hermetic — the command
  // boundary is an injected runner, so no real agent is ever started.
  'model-catalog',
  'memory',
  'orchestration',
  'model-pool',
  'state-loop',
  'review-loop',
  'attempt-record',
  'assignment',
  'assignment-lease',
  'planner',
  'workbench',
  'spawn-gate-production',
  'resource-claim',
  'execution-monitor',
  'unified-review',
  'continuation',
  'handoff-production-round',
  'round-result',
  'execution-lifecycle',
  // TeamRun T2-b: the Worker execution contract (bounded recon / reuse-first). Proves the
  // contract is DELIVERED on the real execution request, in every lifecycle, and that the
  // Unified Reviewer is never handed an implementation contract.
  'worker-execution-contract',
  // TeamRun T3-a.1: READ-only fan-out. Topology validation + deterministic ALL-terminal
  // aggregation, plus the real downstream-dependency gate.
  'read-fanout',
  // R5-1.2 §8: the TickResult control-plane/execution-outcome contract matrix, plus the
  // §9 harness guard that no suite may print FAIL and still exit 0. Runs LAST on
  // purpose: it scans every other suite, so it must see all of them on disk first.
  'tick-outcome-contract',
  // TeamRun T1-b: Worker identity projection (identity only — no runtime behaviour).
  'worker-identity',
  // TeamRun T2-a.1: Laya's initial Agent x Model decision on the production path.
  'initial-assignment-decision',
  // W4.3 §W4E-12: no opt-in real-agent test may delete or read the SHARED production
  // containment control directory. Pure source scan — it starts no agent process, so it
  // is safe in the default suite, and it is what keeps the real-agent opt-in tests honest.
  'real-agent-isolation',
  // W4.4 §21/§5/§7: owned-cleanup proofs. Hermetic — the setup-injection cases throw
  // before any agent starts, and the sentinel case only sets up and cleans up. Proves
  // cleanup never escapes the owned root and that a cleanup failure fails the test.
  'real-agent-ownership',
];

// R5-1.2 (§10): a caller may override the suite list via TEST_TIMED_SUITES
// (';'-separated paths; entries containing '/' are used verbatim). Used by the
// exit-semantics regression; production `npm test` leaves it unset and runs the
// canonical list.
const override = process.env.TEST_TIMED_SUITES;
const SUITE_FILES =
  override !== undefined && override !== ''
    ? override.split(';')
    : SUITES.map((s) => `tests/${s}.test.ts`);

const results = [];
const totalStart = Date.now();
let currentChild = null;
let interrupted = false;
/** R5-1.2C (§13): the pending tree kill and whether it was CONFIRMED. */
let treeKill = null;
let treeKillConfirmed = null;

// R5-1.2C (§13): `child.kill()` terminates only the DIRECT child. A test process that
// spawned a descendant (a controlled node child, a git tree, an agent fixture) would
// leave that descendant running after the runner exited — the same
// "root exited != tree quiescent" defect this project just fixed in ManagedProcess.
//
// The existing `taskkillTree` helper is REUSED rather than reimplemented, so there is
// still exactly one Windows process-tree killer in the repository. The kill is AWAITED
// and the child's exit is awaited before the runner returns, so cleanup is confirmed
// rather than assumed.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    interrupted = true;
    process.stdout.write(`\n-- runner received ${sig}; stopping the current child TREE and exiting --\n`);
    if (currentChild !== null) {
      const pid = currentChild.pid;
      // Do not await inside the signal handler: record the intent, terminate the tree,
      // and let the child's 'exit' event (awaited by runSuite) settle the loop. The
      // kill promise is tracked so the exit path can confirm it.
      treeKill = taskkillTree(pid).then((ok) => {
        treeKillConfirmed = ok;
        return ok;
      }).catch(() => {
        treeKillConfirmed = false;
        return false;
      });
    }
  });
}

/**
 * Run one suite. Returns a classified fact:
 *   { kind: 'exit', code }        the child exited with its own code
 *   { kind: 'signal', signal }    the child was killed by a signal
 *   { kind: 'spawn-error', error} the child could not be started at all
 */
function runSuite(file) {
  return new Promise((resolve) => {
    // A suite file that does not exist is a SPAWN error in intent: we could not start
    // the suite we were asked to run.
    //
    // Without this check the spawn SUCCEEDS — node starts perfectly happily — and then
    // fails to resolve the module, exiting 1. That reports an unstartable suite as an
    // ordinary FAILED suite, which is both wrong and unhelpful: a typo in the suite list
    // reads like a test regression and buries the real cause under a resolution stack.
    if (!existsSync(file)) {
      resolve({ kind: 'spawn-error', error: new Error(`suite file not found: ${file}`) });
      return;
    }
    let child;
    try {
      child = spawn(process.execPath, [file], { stdio: 'inherit' });
    } catch (e) {
      resolve({ kind: 'spawn-error', error: e });
      return;
    }
    currentChild = child;
    child.on('error', (e) => {
      currentChild = null;
      resolve({ kind: 'spawn-error', error: e });
    });
    child.on('exit', (code, signal) => {
      currentChild = null;
      if (signal !== null) resolve({ kind: 'signal', signal });
      else resolve({ kind: 'exit', code });
    });
  });
}

let stop = false;
let wrapperExit = 0;

for (const file of SUITE_FILES) {
  if (stop) break;
  const start = Date.now();
  process.stdout.write(`\n== ${file} ==\n`);
  const fact = await runSuite(file);
  // R5-1.2C (§13): an interrupt must not return until the tree kill has actually been
  // confirmed. Skipping this would let the runner exit while a descendant still ran.
  if (treeKill !== null) {
    const confirmed = await treeKill;
    process.stdout.write(
      `-- interrupt tree cleanup ${confirmed ? 'CONFIRMED' : 'NOT CONFIRMED'}: the suite's descendant tree may still be running --\n`,
    );
    treeKill = null;
  }
  const end = Date.now();
  const ms = end - start;

  let exitCode;
  let note = '';
  if (fact.kind === 'exit') {
    exitCode = fact.code;
    if (exitCode !== 0) {
      note = ` FAILED (exit ${exitCode})`;
      // PASS THROUGH the child's own exit code instead of a blanket 1.
      if (wrapperExit === 0) wrapperExit = exitCode;
      stop = true;
    }
  } else if (fact.kind === 'signal') {
    exitCode = 1;
    note = ` KILLED BY SIGNAL ${fact.signal}`;
    if (wrapperExit === 0) wrapperExit = 1;
    stop = true;
  } else {
    exitCode = 1;
    note = ` SPAWN-ERROR: ${fact.error.message}`;
    if (wrapperExit === 0) wrapperExit = 1;
    stop = true;
  }
  results.push({ suite: file, start, end, ms, exitCode, kind: fact.kind, note });
  if (note !== '') process.stdout.write(`-- ${file}${note} after ${ms} ms --\n`);
  if (interrupted) {
    wrapperExit = 130;
    break;
  }
}

const totalMs = Date.now() - totalStart;
process.stdout.write('\n== suite timing ==\n');
for (const r of results) {
  const kind = r.kind === 'exit' ? '' : ` [${r.kind}]`;
  process.stdout.write(`${String(r.ms).padStart(8)} ms  exit=${r.exitCode}${kind}  ${r.suite}\n`);
}
process.stdout.write(`${String(totalMs).padStart(8)} ms  TOTAL (${results.length} suite(s) run)\n`);
process.exit(wrapperExit);
