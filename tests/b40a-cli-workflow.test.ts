/**
 * tests/b40a-cli-workflow.test.ts — B4.0a: the PRODUCTION round CLI drives the
 * sequential heterogeneous workflow to completion.
 *
 * WHAT IS REAL vs INJECTED
 * ------------------------
 * REAL: `runRoundCli` -> plan (commitPlan) -> Assignment -> SessionRegistry ->
 * TaskScheduler.tick -> Orchestrator.executeTask -> AttemptStore -> the decision loop
 * -> `applyVerification` -> the report. INJECTED, and only these: LAYA's ANSWER (the
 * real laya-serve is external) and the runtime's per-agent terminal outcome (the
 * `RuntimeRunner` seam). No test calls `completeTask` itself — verification happens
 * through LAYA's `complete` action inside the CLI loop.
 *
 * Run: node tests/b40a-cli-workflow.test.ts
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runRoundCli } from '../src/cli/round-cli.ts';
import { Orchestrator as RuntimeOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { createFakeAdapter } from './helpers.ts';
import type { RunHandle, RunRequest, RunResult } from '../src/core/types.ts';
import type { DecisionProvider } from '../src/decision/types.ts';
import { INITIAL_AGENT_MODEL_ID, initialCandidateKey } from '../src/decision/initial-assignment.ts';
import { EXECUTION_TOPOLOGY_ID, TOPOLOGY_SOLO } from '../src/decision/execution-topology.ts';
import { WORKFLOW_PLAN_ID } from '../src/decision/plan-choice.ts';
import type { QuotaProbe } from '../src/quota/index.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];
const tmpDirs: string[] = [];
const cleanupFailures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; process.stdout.write(`  ok   ${name}\n`); }
  else { failed++; failures.push(name); process.stdout.write(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}\n`); }
}
function section(t: string): void { process.stdout.write(`\n== ${t} ==\n`); }
function ownDir(): string { const d = mkdtempSync(join(tmpdir(), 'b40a-')); tmpDirs.push(d); return d; }
function removeOwnedDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); }
  catch (e) { cleanupFailures.push(`owned dir removal threw for ${dir}: ${(e as Error).message}`); return; }
  if (existsSync(dir)) cleanupFailures.push(`owned dir ${dir} still present after removal`);
}

const AGENT_A = 'agent-a';

const ROUTING_ANSWERS: Record<string, string> = { work_kind: 'implementation', complexity: 'small' };

function answerFor(id: string, question: { type: string; criteria: unknown }, overrides: Record<string, string> = ROUTING_ANSWERS): Record<string, unknown> {
  if (question.type === 'choice') {
    const offered = Object.keys(question.criteria as Record<string, string>);
    const pick = offered.includes(overrides[id] ?? '') ? overrides[id]! : offered[0]!;
    const probabilities: Record<string, number> = {};
    for (const o of offered) probabilities[o] = o === pick ? 1 : 0;
    return { type: 'choice', choice: pick, probabilities, confidence: 1 };
  }
  if (question.type === 'score') {
    const levels = question.criteria as string[];
    const index = Math.max(0, levels.indexOf(overrides[id] ?? 'small'));
    const probabilities: Record<string, number> = {};
    for (let i = 0; i < levels.length; i++) probabilities[String(i)] = i === index ? 1 : 0;
    const legend: Record<string, string> = {};
    for (let i = 0; i < levels.length; i++) legend[String(i)] = levels[i]!;
    return { type: 'score', score: index, level: levels[index]!, levels: [...levels], probabilities, legend, confidence: 1 };
  }
  if (question.type === 'noul') return { type: 'noul', noul: 1 };
  return { type: question.type };
}

function probeFor(agentId: string, status: 'available' | 'exhausted' | 'not_fetched' = 'available', modelId = `${agentId}/m1`): QuotaProbe {
  return {
    agentId, provider: agentId,
    records: [{ provider: agentId, agentId, modelId: null, source: 'locally_observed', usage: null, remaining: null, resetAt: null, period: 'day', status, usageClass: 'observed', confidence: 'high', observedAt: Date.now(), note: '' }],
    login: 'stubbed for test', version: '0.0.0-test', modelHint: modelId, providerHint: null, error: null,
  } as unknown as QuotaProbe;
}

interface Round { report: Record<string, unknown>; requests: RunRequest[]; reviewRequests: RunRequest[] }

/**
 * Run ONE real production round with `--workflow sequential`.
 *
 * `planChoice` is what LAYA answers for the workflow-plan question; `autoVerify` makes
 * the provider emit the EXISTING `complete` action for a `to_verify` task (verification
 * through the real authority). `failFirst` makes the FIRST run return `failed`.
 */
async function workflowRound(opts: {
  planChoice?: string;
  autoVerify?: boolean;
  failFirst?: boolean;
  workflowChoice?: string;
  fixed?: { agentId: string; modelId: string };
  objective?: string;
} = {}): Promise<Round> {
  const dir = ownDir();
  const requests: RunRequest[] = [];
  const reviewRequests: RunRequest[] = [];

  const REVIEW_VERDICT_JSON = JSON.stringify({ verdict: 'pass', reason: 'fixture reviewer: recorded evidence satisfies the task', reviewer: 'fixture-codex' });
  const runtime = new RuntimeOrchestrator({
    config: { agents: {} } as never,
    storeDir: join(dir, '.store'),
    replaceAdapters: [
      createFakeAdapter({ id: AGENT_A, capabilities: { newTask: true, review: true, modelSelection: true, cwd: true, resume: true } as never, script: [{ kind: 'exit', code: 0 }] }),
      createFakeAdapter({ id: 'codex', capabilities: { newTask: true, review: true, modelSelection: true, cwd: true, resume: true } as never, script: [{ kind: 'frame', text: REVIEW_VERDICT_JSON }, { kind: 'exit', code: 0 }] }),
    ],
  });
  const store = runtime.store;
  let runN = 0;
  const drivable = {
    agentIds: () => [AGENT_A],
    descriptors: () => [AGENT_A].map((id) => ({ id, displayName: id, launcher: 'fake', transport: 'cli-jsonl', capabilities: { newTask: true, review: true, modelSelection: true, cwd: true, resume: true } } as never)),
    configFor: () => ({}),
    store,
    review: (req: Omit<RunRequest, 'mode'>) => { reviewRequests.push({ ...req, mode: 'review' } as RunRequest); return runtime.review(req); },
    run(req: RunRequest): RunHandle {
      requests.push(req);
      runN += 1;
      const marker = `STEP_OUT_${runN}`;
      const failedRun = opts.failFirst === true && runN === 1;
      const result: RunResult = {
        taskId: `t${runN}`, threadId: null, agentId: req.agentId,
        state: failedRun ? 'failed' : 'succeeded',
        startedAt: Date.now(), endedAt: Date.now(),
        exitCode: failedRun ? 1 : 0, signal: null,
        output: marker, outputTruncated: false, transcriptPath: null,
        usage: {}, toolCalls: [],
        error: failedRun ? { code: 'NONZERO_EXIT', message: 'fixture failure' } : null,
        diagnostics: [], cleanup: { rootKilled: false, descendantsReaped: false, note: '', treeStopConfirmed: true, processStart: 'started' },
      };
      return { result: async () => result } as unknown as RunHandle;
    },
  };

  const provider: DecisionProvider = {
    name: 'laya-workflow-seam',
    async probe() { return { ok: true, endpoint: 'seam://laya', detail: 'test seam', warnings: [] }; },
    async decide(request) {
      const answers: Record<string, unknown> = {};
      for (const [key, question] of Object.entries(request.questions)) {
        if (key === 'next_action') {
          const stateJson = (request.state as Record<string, string> | undefined)?.['next_action'];
          const state = JSON.parse(String(stateJson ?? '{}')) as { tasks?: Array<{ taskId: string; status: string }> };
          const tasks = state.tasks ?? [];
          const toVerify = tasks.find((t) => t.status === 'to_verify');
          const planned = tasks.find((t) => t.status === 'planned' || t.status === 'queued');
          let action = 'wait';
          const parameters: Record<string, string> = {};
          if (toVerify !== undefined && opts.autoVerify !== false) {
            action = 'complete'; parameters.taskId = toVerify.taskId; parameters.reason = 'verified by the existing verification authority';
          } else if (planned !== undefined) {
            action = 'continue';
          }
          const criteria = question.criteria as Record<string, string>;
          const offered = Object.keys(criteria);
          const probabilities: Record<string, number> = {};
          for (const o of offered) probabilities[o] = o === action ? 1 : 0;
          answers[key] = { type: 'choice', choice: action, probabilities, confidence: 1, parameters };
          continue;
        }
        if (key === WORKFLOW_PLAN_ID) {
          const criteria = question.criteria as Record<string, string>;
          const offered = Object.keys(criteria);
          const pick = opts.planChoice !== undefined && offered.includes(opts.planChoice) ? opts.planChoice : offered[0]!;
          const probabilities: Record<string, number> = {};
          for (const o of offered) probabilities[o] = o === pick ? 1 : 0;
          answers[key] = { type: 'choice', choice: pick, probabilities, confidence: 1 };
          continue;
        }
        if (key === INITIAL_AGENT_MODEL_ID) {
          const criteria = question.criteria as Record<string, string>;
          const offered = Object.keys(criteria);
          const wanted = opts.fixed === undefined ? null : initialCandidateKey(opts.fixed.agentId, opts.fixed.modelId);
          const pick = wanted !== null && offered.includes(wanted) ? wanted : offered[0]!;
          const probabilities: Record<string, number> = {};
          for (const o of offered) probabilities[o] = o === pick ? 1 : 0;
          answers[key] = { type: 'choice', choice: pick, probabilities, confidence: 1, criteria };
          continue;
        }
        if (key === EXECUTION_TOPOLOGY_ID) {
          answers[key] = { type: 'choice', choice: TOPOLOGY_SOLO, probabilities: { [TOPOLOGY_SOLO]: 1 }, confidence: 1 };
          continue;
        }
        answers[key] = answerFor(key, question as { type: string; criteria: unknown }, ROUTING_ANSWERS);
      }
      return { answers, provider: { name: 'laya-workflow-seam', details: 'stub Laya: classification + workflow plan + scripted action' }, raw: {} } as never;
    },
  };

  const argv = [
    opts.objective ?? 'add a retry to the http client',
    '--json', '--cwd', dir,
    '--agent', AGENT_A,
    '--max-children', '1', '--max-concurrent', '1',
    '--workflow', 'sequential',
    ...(opts.workflowChoice !== undefined ? ['--workflow-choice', opts.workflowChoice] : []),
    ...(opts.fixed !== undefined ? ['--select', 'fixed', '--agent', opts.fixed.agentId, '--model', opts.fixed.modelId] : []),
  ];
  const before = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => { captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true; }) as typeof process.stdout.write;
  try {
    await runRoundCli(drivable as never, argv, { provider, probes: [probeFor(AGENT_A, 'available', `${AGENT_A}/m1`)] });
  } finally {
    process.stdout.write = before;
  }
  const jsonStart = captured.indexOf('{');
  let report: Record<string, unknown> = {};
  if (jsonStart !== -1) { try { report = JSON.parse(captured.slice(jsonStart)); } catch { report = {}; } }
  return { report, requests, reviewRequests };
}

const workflowOf = (r: Round): Record<string, unknown> => (r.report.workflow ?? {}) as Record<string, unknown>;
const taskStatusW = (r: Round, n: number): string => {
  const tasks = (r.report.tasks ?? []) as Array<{ taskId: string; status: string }>;
  return tasks.find((t) => t.taskId.endsWith(`-w${n}`))?.status ?? 'missing';
};

// =========================================================================
let fatal: unknown;
try {
section('full: the CLI drives research -> implementation -> test to completion');

{
  const r = await workflowRound({ planChoice: 'full', autoVerify: true });
  check('full: the workflow plan is reported as full', workflowOf(r).choice === 'full', JSON.stringify(workflowOf(r)));
  check('full: exactly three runs (research, implementation, test)', r.requests.length === 3, `n=${r.requests.length}`);
  check('full: the three steps ran in order and each saw a DIFFERENT upstream marker',
    r.requests.length === 3 &&
      r.requests[0]!.prompt.includes('research') &&
      r.requests[1]!.prompt.includes('implementation — deliverable') && r.requests[1]!.prompt.includes('STEP_OUT_1') &&
      r.requests[2]!.prompt.includes('test — deliverable') && r.requests[2]!.prompt.includes('STEP_OUT_2'),
    r.requests.map((q) => q.prompt.slice(0, 60)).join(' | '));
  check('full: the loop stopped at all-succeeded', workflowOf(r).stop === 'all-succeeded', JSON.stringify(workflowOf(r).stop));
  check('full: report.ok is true and executionIncomplete is false',
    r.report.ok === true && r.report.executionIncomplete === false, `ok=${String(r.report.ok)} incomplete=${String(r.report.executionIncomplete)}`);
  check('full: every workflow member is succeeded',
    taskStatusW(r, 1) === 'succeeded' && taskStatusW(r, 2) === 'succeeded' && taskStatusW(r, 3) === 'succeeded',
    `w1=${taskStatusW(r, 1)} w2=${taskStatusW(r, 2)} w3=${taskStatusW(r, 3)}`);
  check('full: the review ran over the real attempts', r.reviewRequests.length >= 1, `reviews=${r.reviewRequests.length}`);
  const evidence = (r.report.evidence ?? []) as Array<{ taskId: string; attempts: number }>;
  check('full: the report evidence shows an attempt for every executed step',
    [1, 2, 3].every((n) => (evidence.find((e) => e.taskId.endsWith(`-w${n}`))?.attempts ?? 0) >= 1),
    JSON.stringify(evidence));
}

// =========================================================================
section('lean: implementation -> test (research skipped)');

{
  const r = await workflowRound({ planChoice: 'lean', autoVerify: true });
  check('lean: the workflow plan is reported as lean', workflowOf(r).choice === 'lean', JSON.stringify(workflowOf(r).choice));
  check('lean: two runs (implementation, test)', r.requests.length === 2, `n=${r.requests.length}`);
  check('lean: the test brief carries the implementation marker', r.requests[1]!.prompt.includes('STEP_OUT_1'), r.requests[1]!.prompt.slice(0, 200));
  check('lean: all members succeeded and the round is complete',
    r.report.ok === true && r.report.executionIncomplete === false, `ok=${String(r.report.ok)}`);
}

// =========================================================================
section('upstream failure: downstream is never started');

{
  const r = await workflowRound({ planChoice: 'full', autoVerify: true, failFirst: true });
  check('failure: only the research step ran', r.requests.length === 1, `n=${r.requests.length}`);
  check('failure: the loop stopped on the terminal failure', workflowOf(r).stop === 'terminal-failure', String(workflowOf(r).stop));
  check('failure: the round is NOT ok and IS incomplete',
    r.report.ok === false && r.report.executionIncomplete === true, `ok=${String(r.report.ok)} incomplete=${String(r.report.executionIncomplete)}`);
}

// =========================================================================
section('missing verification: a run alone does not let downstream start');

{
  const r = await workflowRound({ planChoice: 'full', autoVerify: false });
  check('no-verify: research ran but was never verified', r.requests.length === 1, `n=${r.requests.length}`);
  check('no-verify: research is left to_verify (not succeeded)', taskStatusW(r, 1) === 'to_verify', taskStatusW(r, 1));
  check('no-verify: the loop stopped (no progress), never looping unbounded', workflowOf(r).stop === 'no-progress', String(workflowOf(r).stop));
  check('no-verify: the round is incomplete and not ok',
    r.report.ok === false && r.report.executionIncomplete === true, `ok=${String(r.report.ok)} incomplete=${String(r.report.executionIncomplete)}`);
  check('no-verify: the pending member is reported with its status',
    JSON.stringify(workflowOf(r).pending).includes('to_verify'), JSON.stringify(workflowOf(r).pending));
}

// =========================================================================
section('fixed selection survives the CLI workflow');

{
  const r = await workflowRound({ planChoice: 'lean', autoVerify: true, fixed: { agentId: AGENT_A, modelId: `${AGENT_A}/m1` } });
  check('fixed: every request used the pinned pair', r.requests.every((q) => q.agentId === AGENT_A && q.model === `${AGENT_A}/m1`),
    r.requests.map((q) => `${q.agentId}/${q.model}`).join(','));
  check('fixed: the round completed', r.report.ok === true, String(r.report.ok));
}

// =========================================================================

} catch (e) {
  fatal = e;
  process.stdout.write(`fatal: ${String((e as Error).message)}\n`);
}

for (const d of tmpDirs) removeOwnedDir(d);

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
if (cleanupFailures.length) process.stdout.write(`cleanup failures (must fail the test):\n  ${cleanupFailures.map((f) => `- ${f}`).join('\n  ')}\n`);
if (fatal !== undefined) process.stdout.write(`fatal (must fail the test): ${String((fatal as Error).message)}\n`);
process.stdout.write('\n');
process.exitCode = failed === 0 && cleanupFailures.length === 0 && fatal === undefined ? 0 : 1;
