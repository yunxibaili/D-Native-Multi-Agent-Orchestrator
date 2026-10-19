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
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The ONE existing process-tree killer, reused rather than reimplemented here.
import { taskkillTree } from '../src/runtime/spawn.ts';

/**
 * P0-1 OFFLINE BOOTSTRAP. Every suite is launched with `--import` of the trusted
 * offline bootstrap, which FREEZES the offline deny policy BEFORE the suite module
 * (and any test code) executes. From that point no suite can discover, authenticate or
 * launch a real coding agent — regardless of env vars, config or a recreated runtime.
 */
const OFFLINE_BOOTSTRAP = pathToFileURL(
  fileURLToPath(new URL('../tests/helpers/offline-context.mjs', import.meta.url)),
).href;

/**
 * Real-agent suites that must NEVER be selected through `TEST_TIMED_SUITES`: they are
 * opt-in, need a real install and a real model, and the reviewed offline runner must
 * not be talked into running them.
 */
const LIVE_SUITE_DENYLIST = [
  'w41-opencode-natural-exit',
  'w42-opencode-lifecycle',
  'w42-codex-lifecycle',
  'w43-opencode-evidence',
  'real-agent-cleanup',
  'native-agent-e2e',
  'native-handoff-e2e',
  'b47-free-duo',
];

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
  // B1.2 P1-1: the opt-in real-catalogue ENTRY's failure semantics, proven by running
  // the real entry as a real child (not-enabled / agent missing / launcher missing /
  // query failure / cleanup failure). Hermetic — no real agent is started here.
  'b12-entry-failure-semantics',
  // B1.2 P2: the ONE per-stage control-evidence rule, shared with the real entry, so a
  // stage's success can never stand in for another stage's record.
  'b12-control-evidence-association',
  // B1.2 P1-2: the OpenCode version probe is BOUNDED and really stops what it started.
  // Drives a CONTROLLED resident fixture through the real contained path — no real
  // agent, no installed OpenCode dependency.
  'b12-version-probe-bounded',
  // B1.3: the DSH (DeepSeek Harness) headless adapter. Hermetic — driven by a
  // controlled fixture through the real Orchestrator/transport/contained process.
  'dsh-adapter',
  // B1.4: user Agent × Model selection (auto/fixed, project/task). Hermetic — a fake
  // runtime records the RunRequests; the real workbench/assignment path runs.
  'b14-selection',
  // B3.1: the opt-in, advisory per-task NATIVE SKILL choice. Hermetic — the real
  // runRoundCli + the real skill-catalogue reader/validator + the real decision preset,
  // with fake adapters; a provider failure stops the round before any execution.
  'b31-skill-choice',
  // B4.0: sequential heterogeneous workflow (research -> implementation -> test).
  // Hermetic — the real Workbench/Planner/Assignment/Scheduler chain with fake adapters.
  'b40-workflow',
  // B4.0a: the PRODUCTION round CLI drives the workflow to completion (bounded loop,
  // existing Verification via LAYA's `complete`, honest incomplete status). Hermetic.
  'b40a-cli-workflow',
  // MVP-E2E.1a: the per-ROUND cumulative hard POST budget (`--laya-post-max`) and the
  // WIRE guarantee that one reservation is one transmission (HTTP 421 is not replayed by
  // a one-shot stream body; 307/308 are refused). Offline: a controlled fetch plus real
  // loopback servers, no model and no product Agent.
  'laya-post-budget',
  // B4.1: same-goal 2–3 model collaboration groups (功能 B). Hermetic — the real
  // Workbench/Assignment/Session/Scheduler/Verification/Review chain with fake adapters,
  // and the integrator reads REAL member files written into the round's owned directory.
  'b41-collab-group',
  // B4.2: a user-adaptable STRUCTURED PLAN FILE drives the same chain. Hermetic — the real
  // runRoundCli + the real plan-file parser/validator, with fake adapters and real files.
  'b42-plan-file',
  // B4.3: the opt-in STAGE gate — material + user confirmation, bound by digest, checked
  // BEFORE any call or task. Hermetic — the real runRoundCli + the real stage-material
  // parser/digest, with fake adapters and real files.
  'b43-stage-material',
  // B4.5: sequential collaboration in a GIT project. Hermetic — the real runRoundCli +
  // WorkspaceManager create ONE real shared `git worktree` owned by the round root, the
  // controlled runtime writes into `req.cwd` and the integrator reads the members' real
  // bytes there; the user checkout is proven byte-unchanged.
  'b45-git-collaboration',
  // B4.6a: the opt-in single-step USER checkpoint. Hermetic — the real runRoundCli chain
  // with fake adapters; the user's answer is supplied through the injected `checkpointInput`
  // seam, and a separate child proves the terminal reader releases so the process exits.
  'b46-workflow-checkpoint',
  // B2.2: explicit `--model-pool` candidate-source wiring. Hermetic — the REAL
  // `seedRegistry`/`buildQuotaCenter`/`applyPolicy` and the REAL `runRoundCli` are driven
  // with fake adapters/probes and a fake provider; no real agent or model is started.
  'b22-model-pool-candidates',
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
  // P0-1: the deterministic completion gate — real plan-file -> workbench -> executeTask
  // chain with a REAL contained approved test; hermetic (fake agent, no model/network).
  'p01-completion-gate',
  // P0-1 isolation: the OFFLINE deny policy is frozen and enforced at the shared
  // process edge; controlled sentinels prove a real agent launcher is refused BEFORE
  // spawn while a benign OS child still runs. Hermetic.
  'p01-test-isolation',
  // P0-2: auto-advance acceptance — fake agents/fake LAYA with REAL contained approved tests (no real model).
  'p02-auto-advance',
  // Cancellation / process-tree cleanup on REAL contained ManagedProcess instances,
  // driven by a CONTROLLED Node fixture (offline — no real agent is discovered).
  'cancel',
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
// (';'-separated). P0-1 hardening: EVERY selector — the default list AND the override —
// is NORMALISED against the canonical workspace root and must resolve to a reviewed
// canonical offline suite INSIDE that root. Absolute paths, `..` escapes, unknown files
// and LIVE entries are all refused, fail-closed, so the offline runner cannot be talked
// into launching a real agent or a non-reviewed file.
const CANONICAL_FILES = new Set(SUITES.map((s) => `tests/${s}.test.ts`));

/** The canonical repository root, derived from THIS file's location (never ambient cwd). */
const WORKSPACE_ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * Normalise ONE suite selector to its canonical repo-relative manifest path.
 *
 * Exported so the isolation suite can prove the rejection rules WITHOUT spawning a
 * child. Pure: it inspects no state and starts no process.
 */
export function normalizeSuiteEntry(raw, workspaceRoot = WORKSPACE_ROOT) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, code: 'empty-entry', raw: String(raw) };
  }
  let resolved;
  try {
    resolved = resolve(workspaceRoot, raw);
  } catch {
    return { ok: false, code: 'unresolvable-entry', raw };
  }
  const rel = relative(workspaceRoot, resolved).replace(/\\/g, '/');
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, code: 'outside-workspace', raw };
  }
  const liveName = basename(rel).replace(/\.test\.ts$/, '');
  if (LIVE_SUITE_DENYLIST.includes(liveName)) return { ok: false, code: 'live-suite', raw };
  if (!CANONICAL_FILES.has(rel)) return { ok: false, code: 'non-canonical', raw };
  return { ok: true, file: rel, resolved };
}

/** Normalise a whole run's selectors (the default list, or TEST_TIMED_SUITES). */
function resolveSuiteFiles(overrideRaw) {
  const raw =
    overrideRaw !== undefined && overrideRaw !== ''
      ? overrideRaw.split(';').filter((f) => f !== '')
      : SUITES.map((s) => `tests/${s}.test.ts`);
  const files = [];
  for (const entry of raw) {
    const norm = normalizeSuiteEntry(entry);
    if (!norm.ok) {
      process.stdout.write(
        `-- refusing suite selector "${entry}" (${norm.code}); only reviewed canonical offline suites inside the workspace may be selected --\n`,
      );
      return { ok: false, exitCode: 3 };
    }
    files.push(norm.resolved);
  }
  return { ok: true, files };
}

// R5-1.2C: only RUN when invoked as the entry point. Importing this module (e.g. the
// isolation suite importing `normalizeSuiteEntry`) must NOT start any suite.
const isMain = (() => {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  try {
    const self = fileURLToPath(import.meta.url);
    const entryAbs = resolve(entry);
    return process.platform === 'win32'
      ? entryAbs.toLowerCase() === self.toLowerCase()
      : entryAbs === self;
  } catch {
    return false;
  }
})();

if (isMain) {
const results = [];
const totalStart = Date.now();
const resolvedSuites = resolveSuiteFiles(process.env.TEST_TIMED_SUITES);
if (!resolvedSuites.ok) process.exit(resolvedSuites.exitCode);
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
      child = spawn(process.execPath, ['--import', OFFLINE_BOOTSTRAP, file], { stdio: 'inherit' });
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

for (const file of resolvedSuites.files) {
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
}
