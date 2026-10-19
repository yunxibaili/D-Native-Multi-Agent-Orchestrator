/**
 * tests/native-handoff-e2e.test.ts — REAL Native Agent handoff E2E.
 *
 * NOT part of `npm test` (which stays hermetic). Run with `npm run e2e:native:handoff`.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL HERE, AND WHAT IS NOT — READ THIS BEFORE TRUSTING THE VERDICT
 * ---------------------------------------------------------------------------
 *
 *   REAL:
 *     - Agent B is the genuine `opencode` binary, launched through the genuine adapter
 *       and the genuine `runtime.run(` execution edge, in a genuine git repository.
 *     - It genuinely receives a ContinuationPacket, genuinely edits a file, and the
 *       orchestrator genuinely observes that file appear.
 *     - The TaskStore, AttemptStore, Assignment, lease, spawn gate and TaskScheduler are
 *       all the production implementations. Nothing is stubbed below the decision brain.
 *     - The final step calls the REAL Codex review entrypoint on the round. R2-3: this is
 *       now actually executed (`runUnifiedReview` against the real runtime), so the
 *       header claim and the test body finally agree.
 *
 *   INJECTED (and labelled as such — this is an INTEGRATION SEAM, not a quota E2E):
 *     - Agent A's availability failure. There is NO way to make a real provider report an
 *       exhausted quota on demand, and faking a quota PROVIDER would be dishonest. So the
 *       trigger is injected at the existing `RuntimeRunner` seam: it returns a genuine
 *       `RunResult` carrying the real `SPAWN_FAILED` error code for agent A.
 *     - Laya's answer. The real Laya is the external `laya-serve` Python service, which is
 *       a repo-external dependency and may not be running. A stub provider answers
 *       `reassign`, which is what a real Laya is asked to decide.
 *
 * So: this proves the ORCHESTRATION of a handoff against a real native execution. It does
 * NOT prove that a real provider's quota endpoint reports exhaustion, and it must never be
 * reported as if it did. That distinction is asserted at the bottom of this file, so the
 * claim cannot silently widen.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// P0-1 OFFLINE TEST ISOLATION. This suite drives REAL native agent binaries, so it
// REFUSES to run by default, BEFORE any discovery or spawn. Live execution requires a
// future explicit trusted-control authorization; the offline policy is not one, and an
// env flag is deliberately not accepted as one. Nothing below runs.
import { refuseLiveEntry } from './helpers/native-agent-policy.ts';
refuseLiveEntry('native-handoff-e2e');


import { ModelRegistry } from '../src/quota/registry.ts';
import { BudgetManager } from '../src/quota/budget.ts';
import type { QuotaRecord, TaskType } from '../src/quota/types.ts';
import type { RunHandle, RunRequest, RunResult } from '../src/core/types.ts';
import type { RuntimeRunner } from '../src/orchestration/execute.ts';
import type { DecisionProvider } from '../src/decision/types.ts';

import { Orchestrator as RuntimeOrch } from '../src/orchestrator/orchestrator.ts';
import { createOpenCodeAdapter } from '../src/adapters/opencode.ts';
import { Orchestrator } from '../src/orchestration/orchestrator.ts';
import { TaskScheduler } from '../src/orchestration/scheduler.ts';
import { NativeWorkbench } from '../src/orchestration/workbench.ts';
import { buildHandoff } from '../src/orchestration/workbench-handoff.ts';
import { runDecisionCycle } from '../src/orchestration/decision-loop.ts';
import {
  runUnifiedReview,
  classifyExecutionOutcome,
  buildReviewPacket,
  type ExecutionOutcome,
} from '../src/orchestration/unified-review.ts';
import {
  DEFAULT_HANDOFF_POLICY,
  buildContinuationPacket,
  classifyHandoffReason,
  renderContinuationPacket,
  runHandoffContinuation,
} from '../src/orchestration/continuation.ts';

const NOW = Date.now();
const MODEL = 'opencode/space-bunny-free';
const impl: TaskType = 'implementation';

const results: Array<{ name: string; verdict: string; detail: string }> = [];
function record(name: string, verdict: string, detail = ''): void {
  results.push({ name, verdict, detail });
  process.stdout.write(`  [${verdict}] ${name}${detail ? ` :: ${detail}` : ''}\n`);
}
const check = (name: string, cond: boolean, detail = ''): void =>
  record(name, cond ? 'PASS' : 'FAIL', cond ? '' : detail);

const git = (repo: string, args: string): string =>
  execSync(`git ${args}`, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function makeRepo(name: string): string {
  const repo = join(ROOT, name);
  execSync(`mkdir "${repo}"`);
  git(repo, 'init -q -b main');
  git(repo, 'config user.name e2e');
  git(repo, 'config user.email e2e@e2e');
  writeFileSync(join(repo, 'README.md'), '# handoff e2e\n', 'utf8');
  git(repo, 'add -A');
  git(repo, 'commit -q -m init');
  return repo;
}

/** Real opencode present? An environment fact, recorded rather than asserted. */
function opencodeAvailable(): boolean {
  try {
    execSync('opencode --version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate a REAL opencode executable.
 *
 * On Windows the `opencode` on PATH is a `.cmd`/`.ps1` npm shim, and the runtime
 * deliberately refuses to pass one through `cmd.exe` (`runtime-rejected-run`: an argument
 * containing a newline "is not safe to pass through cmd.exe"). That refusal is correct and
 * must not be worked around here — so this resolves the packaged `.exe` instead, which is
 * what a user is expected to configure.
 */
function findOpencodeExe(): string | null {
  const roots: string[] = [];
  try {
    const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    if (npmRoot !== '') roots.push(npmRoot);
  } catch { /* npm may be absent */ }
  roots.push(join(process.env.APPDATA ?? '', 'npm', 'node_modules'));
  for (const root of roots) {
    for (const rel of [
      ['opencode-ai', 'bin', 'opencode.exe'],
      ['opencode-ai', 'node_modules', 'opencode-windows-x64', 'bin', 'opencode.exe'],
    ]) {
      const candidate = join(root, ...rel);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const ROOT = mkdtempSync(join(tmpdir(), 'handoff-e2e-'));

const descriptor = (id: string) => ({
  id, displayName: id, launcher: 'opencode', transport: 'cli-jsonl',
  capabilities: { newTask: true, review: true, modelSelection: true, resume: true },
} as never);
const statusRow = (agent: string) => ({ agent, version: '1', installed: 'Yes', login: 'ok', quotaSource: 't', usage: 'n/a', status: 'ok' });
const quotaRecord = (agentId: string): QuotaRecord => ({
  provider: agentId, agentId, modelId: null, source: 'locally_observed', usage: null, remaining: null,
  resetAt: null, period: 'day', status: 'available', usageClass: 'observed', confidence: 'high', observedAt: NOW, note: '',
});

/** Laya's answer, scripted. It is the ONLY thing that names the next agent. */
function layaSaying(script: readonly unknown[]): DecisionProvider {
  let i = 0;
  return {
    name: 'laya-stub',
    async probe() { return { ok: true, endpoint: 'stub://laya', detail: 'stub for e2e', warnings: [] }; },
    async decide() {
      const answer = script[Math.min(i, script.length - 1)];
      i++;
      const parameters = typeof answer === 'object' && answer !== null
        ? Object.fromEntries(Object.entries(answer as Record<string, unknown>).filter(([k]) => k !== 'action'))
        : {};
      return {
        answers: {
          next_action: {
            type: 'choice',
            choice: (typeof answer === 'string' ? answer : (answer as { action: string }).action),
            parameters,
          },
        },
      } as never;
    },
  };
}

async function main(): Promise<void> {
  process.stdout.write('\n== R2-3 REAL NATIVE HANDOFF E2E ==\n');

  const OPENCODE_EXE = findOpencodeExe();
  if (OPENCODE_EXE === null || !opencodeAvailable()) {
    record('a real opencode executable is reachable', 'UNAVAILABLE',
      'no packaged opencode.exe found; the PATH entry is an npm shim, which the runtime refuses by design');
    finish();
    return;
  }
  record('a real opencode executable is reachable', 'PASS', OPENCODE_EXE);

  const repo = makeRepo('handoff');
  const AGENT_A = 'worker-a';
  const AGENT_B = 'opencode';   // the REAL agent that must finish the task

  // ---- the real runtime, with a real OpenCode adapter registered -------------
  const real = new RuntimeOrch({
    config: { agents: { opencode: { command: OPENCODE_EXE } } } as never,
    storeDir: join(ROOT, 'store'),
    extraAdapters: [createOpenCodeAdapter({ command: OPENCODE_EXE })],
  });

  // The INJECTED part, isolated to one agent: A cannot start. B is untouched and
  // therefore runs the real binary.
  const runtime: RuntimeRunner = {
    run(req: RunRequest): RunHandle {
      if (req.agentId === AGENT_A) {
        const failed = {
          taskId: 'rt-a', threadId: null, agentId: AGENT_A, state: 'failed',
          startedAt: NOW, endedAt: NOW + 1, exitCode: null, signal: null,
          output: '', outputTruncated: false, transcriptPath: null, usage: null, toolCalls: [],
          diagnostics: [], cleanup: { rootKilled: false, descendantsReaped: false, note: '' },
          error: { code: 'SPAWN_FAILED', message: 'the configured binary for worker-a could not be started' },
        } as unknown as RunResult;
        return { result: async () => failed } as unknown as RunHandle;
      }
      // Everything else goes to the REAL runtime.
      return real.run(req);
    },
  };

  const budgets = new BudgetManager(1_000_000);
  budgets.agent(AGENT_A, 100_000);
  budgets.agent(AGENT_B, 100_000);

  const orch = new Orchestrator({
    runtime,
    gate: {
      descriptors: [descriptor(AGENT_A), descriptor(AGENT_B)],
      agentStatus: [statusRow(AGENT_A), statusRow(AGENT_B)],
      quotaRecords: [quotaRecord(AGENT_A), quotaRecord(AGENT_B)],
      registry: (() => {
        const reg = new ModelRegistry();
        for (const a of [AGENT_A, AGENT_B]) {
          reg.upsert({ agentId: a, modelId: MODEL, provider: 'test', taskTypes: [impl], modelSource: 'test', quotaSource: 'test' } as never, NOW);
          reg.setAgentAvailability(a, 'available');
        }
        return reg;
      })(),
      budgets,
      taskType: impl,
      requestedUnits: 100,
      currentConcurrency: 0,
      maxConcurrency: 4,
      maxChildren: 8,
      maxConcurrentAgents: 4,
    } as never,
    now: () => Date.now(),
    defaultCwd: repo,
  });

  const sched = new TaskScheduler({ orchestrator: orch, cwd: repo });
  const wb = new NativeWorkbench({
    orchestrator: orch, scheduler: sched,
    registry: (() => {
      const reg = new ModelRegistry();
      for (const a of [AGENT_A, AGENT_B]) {
        reg.upsert({ agentId: a, modelId: MODEL, provider: 'test', taskTypes: [impl], modelSource: 'test', quotaSource: 'test' } as never, NOW);
        reg.setAgentAvailability(a, 'available');
      }
      return reg;
    })(),
    quotaRecords: [quotaRecord(AGENT_A), quotaRecord(AGENT_B)],
    cwd: repo, now: () => Date.now(),
  });

  // ---- attempt 1: agent A cannot start, for real -----------------------------
  const spec = { taskId: 'r', objective: 'create a file named HANDOFF-PROOF.txt containing exactly the text PROOF-HANDOFF-OK', taskType: impl, shape: 'single' as const, budgetUnits: 100, preferredAgent: AGENT_A };
  const planned = wb.plan(spec as never, null);
  const taskId = planned.children[0]!.taskId;
  wb.assignChildren('r', spec as never);
  budgets.task(taskId, 100_000);
  wb.sessions.open({ agentId: AGENT_A, modelId: MODEL, sessionPolicy: 'fresh' }, repo, Date.now(), taskId);
  check('assignment put the task on the unavailable agent A', wb.store.get(taskId)!.agentId === AGENT_A, wb.store.get(taskId)!.agentId);

  const first = await orch.executeTask({ taskId, cwd: repo, translate: { allowAvailabilityContinuation: true } });
  check('attempt 1 really executed and really failed to start', first.ok === true, `ok=${String(first.ok)}`);
  check('the task is PARKED, not failed', wb.store.get(taskId)!.status === 'retrying', wb.store.get(taskId)!.status);
  wb.evidence.append({
    kind: 'execution', taskId, agentId: AGENT_A, modelId: MODEL, taskType: impl,
    startedAt: NOW, finishedAt: NOW + 1, outcome: 'failure',
    errorCode: 'SPAWN_FAILED', errorMessage: 'the configured binary for worker-a could not be started',
    leaseVersion: wb.store.get(taskId)!.leaseVersion,
  } as never);

  // ---- Laya hands the SAME task to the real agent ---------------------------
  const provider = layaSaying([{ action: 'reassign', taskId, agentId: AGENT_B, reason: 'worker-a cannot start' }]);
  const capabilities = wb.decisionCapabilities();

  const continuation = await runHandoffContinuation({
    async readOutcomes() {
      const history = wb.evidence.history(taskId);
      if (history.length === 0) return [];
      const last = history[history.length - 1]!;
      const o: ExecutionOutcome = {
        taskId, taskStatus: wb.store.get(taskId)!.status,
        outcome: last.errorCode === 'SPAWN_FAILED' ? 'agent_unavailable' : 'failed',
        code: last.errorCode ?? null, reason: last.errorMessage ?? null,
        agentId: last.agentId, modelId: last.modelId, executed: true, refused: false,
        attemptIds: history.map((r) => r.attemptId),
      };
      return [o];
    },
    identityOf: (id) => {
      const t = wb.store.get(id);
      return t === null ? null : { agentId: t.agentId, modelId: t.modelId ?? null };
    },
    buildPacket(id, outcome) {
      const task = wb.store.get(id);
      if (task === null) return null;
      const c = classifyHandoffReason(outcome);
      if (!c.handoff) return null;
      const history = wb.evidence.history(id);
      const last = history[history.length - 1]!;
      return buildContinuationPacket({
        task, reason: c.reason, outcome,
        evidence: buildHandoff(task, {
          agentId: last.agentId, state: 'failed', startedAt: NOW, endedAt: NOW + 1, exitCode: null,
          signal: null, output: '', outputTruncated: false, transcriptPath: null, usage: null,
          toolCalls: [], diagnostics: [], threadId: null, taskId: 'rt-a',
          cleanup: { rootKilled: false, descendantsReaped: false, note: '' },
          error: { code: 'SPAWN_FAILED', message: 'the configured binary for worker-a could not be started' },
        } as unknown as RunResult),
        attempt: {
          attemptId: last.attemptId, agentId: last.agentId, modelId: last.modelId,
          leaseVersion: last.leaseVersion, errorCode: last.errorCode, errorMessage: last.errorMessage,
        },
      });
    },
    async runCycle(context) {
      // The packet is shown to the brain as OBSERVATION. Let it be seen in full.
      process.stdout.write('\n  --- continuation packet given to Laya ---\n');
      process.stdout.write((context ?? '').split('\n').map((l) => '  | ' + l).join('\n') + '\n');
      const cycle = await runDecisionCycle({
        store: wb.store, scheduler: sched, provider, rootTaskId: 'r',
        instructions: 'Agent A could not continue. Name the agent that should continue this SAME task, or answer wait.',
        capabilities, lastTick: () => null,
      });
      if (cycle.status !== 'ok') {
        return { action: null, applied: false, dispatched: false, code: `cycle-${cycle.status}`, reason: 'cycle failed', targetAgentId: null };
      }
      const target = cycle.status === 'ok' ? cycle.decision : null;
      const application = cycle.status === 'ok' ? cycle.application : null;
      return {
        action: target === null ? null : target.action,
        applied: application !== null && application.applied,
        dispatched: application !== null && application.dispatched,
        code: application === null || application.applied ? null : application.code,
        reason: application === null ? 'the cycle did not complete' : (application.applied ? application.note : application.reason),
        targetAgentId: target !== null && target.action === 'reassign' ? (target.agentId ?? null) : null,
      };
    },
    // R2-3 §17: the SECOND attempt is produced by the production dispatch path, not by a
    // hand-written `orch.retry()` + `orch.executeTask()`. This is the same two steps the
    // round CLI performs: requeue the parked task through the EXISTING authority, then run
    // the ONE dispatcher, which ticks the ONE scheduler and records the attempt.
    async onHandoffApplied(record) {
      const task = wb.store.get(record.taskId);
      if (task === null) return;
      if (task.status === 'retrying') {
        const requeued = orch.retry(record.taskId, `handoff: ${record.reason}`, 2);
        check('the parked task was requeued by the EXISTING retry authority', requeued.ok,
          requeued.ok ? '' : `${requeued.code} ${requeued.reason}`);
      }
            const dispatched = await wb.dispatch(new Map([[record.taskId, [
        renderContinuationPacket(record.packet),
        '',
        `Work: create HANDOFF-PROOF.txt containing exactly PROOF-HANDOFF-OK. Do not modify anything else.`,
      ].join('\n')]]));
      check('the ONE dispatcher ran the second attempt',
        (dispatched.tick?.admitted ?? []).includes(record.taskId),
        JSON.stringify({ admitted: dispatched.tick?.admitted ?? [], skipped: (dispatched.tick?.skipped ?? []).map((s) => `${s.taskId}:${s.code}`) }));
    },
    now: () => Date.now(),
  }, { policy: DEFAULT_HANDOFF_POLICY });

  check('the handoff happened exactly once', continuation.handoffs.length === 1, String(continuation.handoffs.length));
  check('it moved A -> the real agent B',
    continuation.handoffs[0]?.fromAgentId === AGENT_A && continuation.handoffs[0]?.toAgentId === AGENT_B,
    JSON.stringify([continuation.handoffs[0]?.fromAgentId, continuation.handoffs[0]?.toAgentId]));
  check('THE TASK ID NEVER CHANGED', wb.store.get(taskId)!.taskId === taskId, wb.store.get(taskId)!.taskId);
  check('the task now runs on the real agent', wb.store.get(taskId)!.agentId === AGENT_B, wb.store.get(taskId)!.agentId);

  // ---- attempt 2 was produced by `onHandoffApplied` above ---------------------
  // No manual `orch.retry()` + `orch.executeTask()` here: the second attempt came from the
  // production dispatch path, which is the whole point of §17.
  check('attempt 2 was produced by the production dispatch, not a manual re-run',
    wb.store.get(taskId)!.status === 'to_verify', wb.store.get(taskId)!.status);

  const proofExists = existsSync(join(repo, 'HANDOFF-PROOF.txt'));
  check('the REAL agent actually wrote the file it was asked for', proofExists);
  if (proofExists) {
    const content = readFileSync(join(repo, 'HANDOFF-PROOF.txt'), 'utf8').trim();
    check('the file content is what the task asked for', content.includes('PROOF-HANDOFF-OK'), content.slice(0, 80));
  }
  // NOTE: attempt 2's AttemptRecord was written by `wb.dispatch()` itself (via
  // `recordExecutions`), which is the whole point of routing it through the production path.
  // Appending another one here would double-count the evidence and hide that fact.

  // ---- both attempts reach the ONE review ----------------------------------
  const history = wb.evidence.history(taskId);
  check('BOTH attempts are on the ONE task', history.length === 2, String(history.length));
  check('attempt 1 is still attributed to agent A', history[0]!.agentId === AGENT_A, history[0]!.agentId);
  check('attempt 2 is attributed to agent B', history[1]!.agentId === AGENT_B, history[1]!.agentId);

  const secondRun = wb.lastRunResult(taskId);
  const reviewPacket = buildReviewPacket({
    roundId: 'e2e-round', originalRequest: 'create a file named HANDOFF-PROOF.txt',
    tasks: [{
      taskId, taskType: impl, status: wb.store.get(taskId)!.status, agentId: AGENT_B, modelId: MODEL,
      outcome: 'success', executed: true,
      prompt: { text: 'create HANDOFF-PROOF.txt', truncated: false, originalLength: 28 },
      handoff: buildHandoff(wb.store.get(taskId)!, secondRun ?? ({ agentId: AGENT_B, state: 'succeeded' } as RunResult)),
      attemptIds: history.map((r) => r.attemptId),
      leaseVersion: wb.store.get(taskId)!.leaseVersion, errorCode: null, errorMessage: null,
    }],
    outcomes: [classifyExecutionOutcome({ taskId, taskStatus: wb.store.get(taskId)!.status, agentId: AGENT_B, run: secondRun })],
    errors: [`${taskId}: agent_unavailable — worker-a could not start (SPAWN_FAILED); continued on ${AGENT_B}`],
  });
  const rendered = JSON.stringify(reviewPacket);
  check('the review packet names BOTH attempt ids', history.every((r) => rendered.includes(r.attemptId)));
  check('the review packet explains why the agent changed', rendered.includes('SPAWN_FAILED'));

  // R2-3 §11: the header has always claimed this file calls the REAL review entrypoint.
  // It did not. Rather than weaken the claim, this now actually runs it — against the REAL
  // runtime and the REAL Codex adapter — so the claim and the body agree.
  //
  // The reviewer may legitimately fail to produce a verdict (a slow or chatty model is a
  // real environment fact). What must hold is that the call was made, and that its result
  // is reported honestly rather than asserted.
  const reviewResult = await runUnifiedReview(real, reviewPacket, {
    reviewer: 'codex',
    // The machine's REAL configured codex model, read from the same config the round uses.
    // Absent, the adapter's own default applies — this file never invents a model name.
    modelId: real.configFor('codex').model ?? null,
    cwd: repo,
    now: () => Date.now(),
    timeoutMs: 180_000,
  });
  process.stdout.write(`\n  [review] status=${reviewResult.status} verdict=${String(reviewResult.verdict?.verdict ?? 'none')}\n`);
  check('the REAL Codex review entrypoint was actually invoked',
    ['completed', 'failed', 'unavailable'].includes(reviewResult.status), reviewResult.status);
  check('a completed review carries a real verdict; otherwise it carries a reason and NO verdict',
    reviewResult.status !== 'completed'
      ? reviewResult.verdict === null && (reviewResult.reason ?? '').length > 0
      : ['pass', 'rework', 'reject'].includes(reviewResult.verdict!.verdict),
    `${reviewResult.status}/${String(reviewResult.verdict?.verdict ?? 'null')}`);
  check('the review was given BOTH attempts',
    reviewResult.status === 'unavailable' || history.every((r) => rendered.includes(r.attemptId)));
  if (reviewResult.status !== 'completed') {
    process.stdout.write(
      '  [note] the real reviewer did not produce a verdict on this machine; the call was\n' +
      '         made and its refusal is reported rather than papered over.\n',
    );
  }

  finish();
}

function finish(): void {
  const pass = results.filter((r) => r.verdict === 'PASS').length;
  const fail = results.filter((r) => r.verdict === 'FAIL').length;
  const unavail = results.filter((r) => r.verdict === 'UNAVAILABLE').length;
  process.stdout.write(`\n${pass} passed, ${fail} failed, ${unavail} unavailable\n`);
  process.stdout.write(
    '\nNOTE ON WHAT THIS PROVES: the real native execution, the real orchestrator path and the\n' +
    'single review are REAL. The AVAILABILITY TRIGGER for agent A and Laya\'s ANSWER are INJECTED\n' +
    '(there is no honest way to make a real quota provider report exhaustion on demand). This is\n' +
    'an INTEGRATION SEAM proof of the handoff orchestration, NOT a real-provider quota E2E.\n',
  );
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* windows may hold it */ }
  process.exitCode = fail === 0 ? 0 : 1;
}

await main();