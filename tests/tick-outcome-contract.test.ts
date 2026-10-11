/**
 * tests/tick-outcome-contract.test.ts — R5-1.2 §1/§4/§5/§6/§8 contract matrix.
 *
 * WHAT IS PROVEN HERE
 * -------------------
 * `ExecuteOutcome.ok` is the CONTROL-PLANE outcome, never the execution outcome:
 *
 *   A  success            ok=true   task to_verify   run succeeded
 *   B  ordinary failure   ok=true   task failed      run failed (NONZERO_EXIT)
 *   C  refused write-back ok=false  task untouched   run RETAINED + refusal code
 *   D  refused admission  ok=false  task untouched   run ABSENT
 *
 * This file pins the CONSUMER contract, because that is the part that is easy to get
 * wrong and was previously untested: every consumer that needs to know "did it really
 * run?" must read the presence of `run`, never `ok`. A consumer that gates on `ok`
 * silently erases real execution evidence whenever the control plane refuses a
 * write-back (R4 F5).
 *
 * The deep orchestrator-level races (a real stale-lease write-back, a real admission
 * refusal) are already proven in `assignment-lease.test.ts`; the classifier's own
 * table is proven in `unified-review.test.ts`. What follows is the small cross-cutting
 * matrix that none of those files covers.
 *
 * No second outcome vocabulary is introduced: these are the existing `TickResult`,
 * `RunResult`, `AttemptRecord` and `classifyExecutionOutcome` types.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildDispatchReceipt } from '../src/orchestration/dispatch-receipt.ts';
import { recordExecutions } from '../src/orchestration/attempt-integration.ts';
import { AttemptStore } from '../src/orchestration/attempt-store.ts';
import { classifyExecutionOutcome } from '../src/orchestration/unified-review.ts';
import { HANDOFF_REASONS } from '../src/orchestration/continuation.ts';
import type { RunResult, TerminalState } from '../src/core/types.ts';
import type { TickResult } from '../src/orchestration/scheduler.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = 1_700_000_000_000;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed += 1;
    failures.push(name);
    process.stdout.write(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}\n`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures: the four control-plane outcomes, plus the run vocabulary.
// ---------------------------------------------------------------------------

function run(state: TerminalState, exitCode: number | null, code: string | null): RunResult {
  return {
    taskId: 't1',
    threadId: null,
    agentId: 'a1',
    state,
    startedAt: NOW,
    endedAt: NOW + 10,
    exitCode,
    signal: null,
    output: '',
    outputTruncated: false,
    transcriptPath: null,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costUsd: 0 } as never,
    toolCalls: [],
    error: code === null ? null : { code: code as never, message: `synthetic ${code}` },
    diagnostics: [],
  } as unknown as RunResult;
}

/** A. Dispatched, succeeded, write-back accepted. */
const CASE_A = { ok: true, task: { status: 'to_verify' }, run: run('succeeded', 0, null) };
/** B. Dispatched, native exit 3, write-back accepted -> the task FAILED, the tick did not. */
const CASE_B = { ok: true, task: { status: 'failed' }, run: run('failed', 3, 'NONZERO_EXIT') };
/** C. Dispatched, native exit 3, but the write-back was refused: run still real. */
const CASE_C = { ok: false, code: 'stale-lease-version', reason: 'lease moved on', status: 'running', run: run('failed', 3, 'NONZERO_EXIT'), runRejected: true };
/** D. Never dispatched: no run exists. */
const CASE_D = { ok: false, code: 'resource-unavailable', reason: 'no free slot', status: 'planned' };

function tickFor(outcome: Record<string, unknown>): TickResult {
  const admitted = outcome.ok === true;
  return {
    admitted: admitted ? ['t1'] : [],
    waiting: [],
    skipped: admitted ? [] : [{ taskId: 't1', code: outcome.code as string, reason: outcome.reason as string }],
    freeSlots: 1,
    outcomes: [{ taskId: 't1', outcome: outcome as never }],
  };
}

const RESOLVE = (): { agentId: string; modelId: string | null; budgetUnits: number; taskType: 'implementation' } => ({
  agentId: 'a1',
  modelId: null,
  budgetUnits: 10,
  taskType: 'implementation',
});

// ---------------------------------------------------------------------------
// 1. The matrix: what each consumer must derive from each case.
// ---------------------------------------------------------------------------

process.stdout.write('\n== CONTRACT 1. control-plane outcome != execution outcome ==\n');

for (const [label, c, expect] of [
  ['A success', CASE_A, { ok: true, status: 'to_verify', executed: true }],
  ['B ordinary failure', CASE_B, { ok: true, status: 'failed', executed: true }],
  ['C refused write-back', CASE_C, { ok: false, status: 'running', executed: true }],
  ['D refused admission', CASE_D, { ok: false, status: 'planned', executed: false }],
] as const) {
  const outcome = c as unknown as Record<string, unknown>;
  const tick = tickFor(outcome);

  // (1) `admitted` means "accepted for dispatch/execution", NOT "succeeded" (§4).
  check(`${label}: admitted iff the control plane applied the outcome`,
    tick.admitted.includes('t1') === expect.ok, `admitted=${JSON.stringify(tick.admitted)}`);

  // (2) A refused outcome keeps its refusal code (§1 Case C/D, §6).
  if (!expect.ok) {
    check(`${label}: refusal code is retained`,
      tick.skipped[0]?.code === outcome.code, String(tick.skipped[0]?.code));
  }

  // (3) The receipt must report "a terminal run was observed" from the RUN, not `ok`.
  //     This is the regression that Case C would trip.
  const receipt = buildDispatchReceipt({ tick, dispatchedAt: NOW });
  const entry = receipt.outcomes[0]!;
  check(`${label}: receipt.finished reflects a REAL run, not ok`,
    entry.finished === expect.executed, `finished=${entry.finished} ok=${String(outcome.ok)}`);
  check(`${label}: receipt.terminalState present iff a run exists`,
    (entry.terminalState !== undefined) === expect.executed, String(entry.terminalState));

  // (4) Evidence: a real run is recorded, an absent run is honestly reported as not
  //     recorded (§6 — F5 must not be reintroduced).
  const store = new AttemptStore();
  const recorded = recordExecutions(store, tick, RESOLVE);
  check(`${label}: evidence recorded iff a real run exists`,
    recorded.recorded.length === (expect.executed ? 1 : 0) && recorded.notRecorded.length === (expect.executed ? 0 : 1),
    JSON.stringify(recorded));
}

// ---------------------------------------------------------------------------
// 2. Execution success is represented by task status + run, never by `ok`.
// ---------------------------------------------------------------------------

process.stdout.write('\n== CONTRACT 2. success lives in status/run, not in ok ==\n');
{
  const ok = classifyExecutionOutcome({
    taskId: 't1', taskStatus: 'to_verify', agentId: 'a1', modelId: null,
    run: run('succeeded', 0, null), refusalCode: null, refusalReason: null, attemptIds: [],
  });
  check('A classifies as success', ok.outcome === 'success' && ok.executed === true, JSON.stringify(ok));
  check('A hands off nothing', ok.outcome !== 'quota_exhausted' && ok.outcome !== 'agent_unavailable' && ok.outcome !== 'session_failure');

  const failed = classifyExecutionOutcome({
    taskId: 't1', taskStatus: 'failed', agentId: 'a1', modelId: null,
    run: run('failed', 3, 'NONZERO_EXIT'), refusalCode: null, refusalReason: null, attemptIds: [],
  });
  check('B classifies as failed', failed.outcome === 'failed', failed.outcome);
  check('B is NOT a control-plane refusal', failed.refused === false, String(failed.refused));
  check('B keeps the real code NONZERO_EXIT', failed.code === 'NONZERO_EXIT', String(failed.code));
  check('B is still `executed` — the agent ran', failed.executed === true, String(failed.executed));

  // §5: an ordinary non-zero exit must NEVER trigger an automatic handoff.
  const timedOut = classifyExecutionOutcome({
    taskId: 't1', taskStatus: 'failed', agentId: 'a1', modelId: null,
    run: run('timed_out', null, 'TIMED_OUT'), refusalCode: null, refusalReason: null, attemptIds: [],
  });
  check('timed_out classifies as timeout', timedOut.outcome === 'timeout', timedOut.outcome);
  check('timed_out is executed but not a handoff trigger',
    timedOut.executed === true && !HANDOFF_REASONS.includes(timedOut.outcome as never), timedOut.outcome);
}

// ---------------------------------------------------------------------------
// 3. Handoff triggers are unchanged and availability-derived (§5).
// ---------------------------------------------------------------------------

process.stdout.write('\n== CONTRACT 3. handoff triggers unchanged ==\n');
{
  check('exactly three automatic handoff triggers exist',
    HANDOFF_REASONS.length === 3
    && HANDOFF_REASONS.includes('quota_exhausted' as never)
    && HANDOFF_REASONS.includes('agent_unavailable' as never)
    && HANDOFF_REASONS.includes('session_failure' as never),
    JSON.stringify(HANDOFF_REASONS));

  for (const [code, expected] of [
    ['quota-exhausted', 'quota_exhausted'],
    ['agent-unavailable', 'agent_unavailable'],
  ] as const) {
    const o = classifyExecutionOutcome({
      taskId: 't1', taskStatus: 'running', agentId: 'a1', modelId: null,
      run: null, refusalCode: code, refusalReason: 'availability', attemptIds: [],
    });
    check(`${code} still hands off as ${expected}`, o.outcome === expected, o.outcome);
  }

  const transport = classifyExecutionOutcome({
    taskId: 't1', taskStatus: 'failed', agentId: 'a1', modelId: null,
    run: run('failed', null, 'TRANSPORT_ERROR'), refusalCode: null, refusalReason: null, attemptIds: [],
  });
  check('TRANSPORT_ERROR still hands off as session_failure', transport.outcome === 'session_failure', transport.outcome);

  // The misnaming trap from §1 Case B: `runtime-rejected-run` means "the agent could
  // not be STARTED", which IS an availability fact. An ordinary non-zero exit must
  // therefore never be reported under that code, or it would hand off spuriously.
  const misnamed = classifyExecutionOutcome({
    taskId: 't1', taskStatus: 'failed', agentId: 'a1', modelId: null,
    run: null, refusalCode: 'runtime-rejected-run', refusalReason: 'could not start', attemptIds: [],
  });
  check('runtime-rejected-run is reserved for "agent could not start"',
    misnamed.outcome === 'agent_unavailable', misnamed.outcome);
  const realExit = classifyExecutionOutcome({
    taskId: 't1', taskStatus: 'failed', agentId: 'a1', modelId: null,
    run: run('failed', 3, 'NONZERO_EXIT'), refusalCode: null, refusalReason: null, attemptIds: [],
  });
  check('an ordinary NONZERO_EXIT is NOT agent_unavailable (no spurious handoff)',
    realExit.outcome !== 'agent_unavailable', realExit.outcome);
}

// ---------------------------------------------------------------------------
// 4. Harness guard (§9): a suite that prints FAIL must not exit 0.
// ---------------------------------------------------------------------------

process.stdout.write('\n== CONTRACT 4. no suite can mask a failure with exit code 0 ==\n');
{
  const dir = join(HERE);
  const suites = readdirSync(dir).filter((f) => f.endsWith('.test.ts'));
  // Either mechanism is legitimate: set `process.exitCode` from the failure count, or
  // call `process.exit(1)` when failures exist. What is NOT legitimate is a suite that
  // prints FAIL and still exits 0, because that hides the failure from the runner and
  // from `npm test` alike — the defect this guard exists to prevent.
  const missing = suites.filter((f) => {
    const src = readFileSync(join(dir, f), 'utf8');
    return !/process\.exitCode\s*=/.test(src) && !/process\.exit\(\s*[1-9]/.test(src);
  });
  check(`all ${suites.length} suites propagate failure to the exit code`, missing.length === 0, missing.join(', '));
}

// ---------------------------------------------------------------------------

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length > 0) process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
process.stdout.write('\n');
process.exitCode = failed === 0 ? 0 : 1;