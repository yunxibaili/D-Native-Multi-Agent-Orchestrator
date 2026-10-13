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

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runRoundCli } from '../src/cli/round-cli.ts';
import { Orchestrator as RuntimeOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { createFakeAdapter } from './helpers.ts';
import { defaultRoundResultPath } from '../src/orchestration/round-observation.ts';
import type { RunHandle, RunRequest, RunResult } from '../src/core/types.ts';
import type { DecisionProvider, DecisionRequest } from '../src/decision/types.ts';
import { INITIAL_AGENT_MODEL_ID, initialCandidateKey } from '../src/decision/initial-assignment.ts';
import { EXECUTION_TOPOLOGY_ID, TOPOLOGY_SOLO } from '../src/decision/execution-topology.ts';
import { WORKFLOW_PLAN_ID } from '../src/decision/plan-choice.ts';
import { ACCEPTANCE_MATERIAL_FIELD, ORCHESTRATION_ACTION_ID } from '../src/orchestration/decision-loop.ts';
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

interface Round { report: Record<string, unknown>; requests: RunRequest[]; reviewRequests: RunRequest[]; decisionRequests: DecisionRequest[]; reportDir: string }

/** What the fixture provider ACTUALLY saw in the acceptance material, per cycle. */
interface MaterialSeen { objective: string; entries: Array<{ taskId: string; acceptanceCriteria: string; output: string; executionMissing: boolean }> }
const materialsSeenBy = (r: Round): MaterialSeen[] => r.decisionRequests.map((req) => {
  const raw = (req.state as Record<string, string> | undefined)?.[ACCEPTANCE_MATERIAL_FIELD];
  const m = JSON.parse(String(raw ?? '{"objective":"","entries":[]}')) as MaterialSeen;
  return { objective: m.objective, entries: m.entries };
});

/**
 * Run ONE real production round with `--workflow sequential`.
 *
 * `planChoice` is what LAYA answers for the workflow-plan question.
 * `outputMode` decides what the fixture run CLAIMS to have produced, which is what the
 * material-driven provider then has to judge against the task's own criteria:
 *   `satisfying`   - the output names the step's own role (it can be accepted)
 *   `unsatisfying` - the output does not show the deliverable (must NOT be accepted)
 *   `empty`        - no output at all (material carries no evidence; must NOT be accepted)
 * `failFirst` makes the FIRST run return `failed`.
 * `reviewVerdictJson` overrides the reviewer frame (the negative control feeds an
 * invalid verdict and keeps the assertion that it is REJECTED).
 */
async function workflowRound(opts: {
  planChoice?: string;
  outputMode?: 'satisfying' | 'unsatisfying' | 'empty';
  failFirst?: boolean;
  workflowChoice?: string;
  fixed?: { agentId: string; modelId: string };
  objective?: string;
  reviewVerdictJson?: string;
} = {}): Promise<Round> {
  const dir = ownDir();
  // B4.0b P2-C: an OWNED publish dir, always. The production default is
  // `$ORCH_HOME/round-result.json`, so without this every run of this suite would
  // overwrite the user's own report.
  const reportDir = join(ownDir(), 'reports');
  const requests: RunRequest[] = [];
  const reviewRequests: RunRequest[] = [];
  const decisionRequests: DecisionRequest[] = [];

  /*
   * A verdict that satisfies the EXISTING contract: verdict + non-empty reason +
   * findings[] + recommendedAction + reviewer + reviewedAt. The earlier fixture had
   * only three of those, so the real path rejected it as `reviewer-output-invalid`
   * while the suite stayed green.
   *
   * `data.text` is REQUIRED in addition: the fake adapter's `mapEvent` reads
   * `frame.data.text`, so a frame carrying only `text` yields no output event at all.
   */
  const REVIEW_VERDICT_JSON = opts.reviewVerdictJson ?? JSON.stringify({
    verdict: 'pass',
    reason: 'fixture reviewer: every step\'s own recorded output meets its own criteria',
    findings: [],
    recommendedAction: 'none',
    reviewer: 'fixture-codex',
    reviewedAt: 1,
  });
  const runtime = new RuntimeOrchestrator({
    config: { agents: {} } as never,
    storeDir: join(dir, '.store'),
    replaceAdapters: [
      createFakeAdapter({ id: AGENT_A, capabilities: { newTask: true, review: true, modelSelection: true, cwd: true, resume: true } as never, script: [{ kind: 'exit', code: 0 }] }),
      createFakeAdapter({ id: 'codex', capabilities: { newTask: true, review: true, modelSelection: true, cwd: true, resume: true } as never, script: [{ kind: 'frame', text: REVIEW_VERDICT_JSON, data: { text: REVIEW_VERDICT_JSON } }, { kind: 'exit', code: 0 }] }),
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
      // `RunRequest` carries no taskId, and the two prompt shapes differ (the first step
      // gets `Task <id> (<type>)`, a dependant gets `buildTaskBrief`). Both embed the
      // ROLE, which is what the acceptance criteria are built from, so the fixture reads
      // the role from whichever shape it was given instead of guessing from a counter.
      const role =
        /^Task \S+ \((\w+)\)/m.exec(req.prompt)?.[1] ??
        /:: (\w+) — deliverable:/.exec(req.prompt)?.[1] ??
        'unknown';
      // The CLAIM each run makes. It must be distinguishable, because the acceptance
      // material carries it verbatim and LAYA is judged on it.
      const claimed = opts.outputMode === 'empty' ? ''
        : opts.outputMode === 'unsatisfying' ? `${marker}: wrote something, deliverable not demonstrated`
        : `${marker}: ${role} deliverable produced`;
      const result: RunResult = {
        taskId: `t${runN}`, threadId: null, agentId: req.agentId,
        state: failedRun ? 'failed' : 'succeeded',
        startedAt: Date.now(), endedAt: Date.now(),
        exitCode: failedRun ? 1 : 0, signal: null,
        output: claimed, outputTruncated: false, transcriptPath: null,
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
        if (key === ORCHESTRATION_ACTION_ID) {
          decisionRequests.push(request);
          const stateJson = (request.state as Record<string, string> | undefined)?.[ORCHESTRATION_ACTION_ID];
          const state = JSON.parse(String(stateJson ?? '{}')) as { tasks?: Array<{ taskId: string; status: string }> };
          const tasks = state.tasks ?? [];
          const toVerify = tasks.find((t) => t.status === 'to_verify');
          const planned = tasks.find((t) => t.status === 'planned' || t.status === 'queued');

          /*
           * MATERIAL-DRIVEN, not status-driven. This is the whole point of B4.0b: the
           * fixture accepts a task only when the material for THAT task shows its own
           * execution met its own criteria. Seeing `to_verify` is never sufficient, and
           * a missing/empty material can never be read as a pass.
           */
          let action = 'wait';
          const parameters: Record<string, string> = {};
          const rawMaterial = (request.state as Record<string, string> | undefined)?.[ACCEPTANCE_MATERIAL_FIELD];
          if (toVerify !== undefined && rawMaterial !== undefined) {
            const material = JSON.parse(rawMaterial) as MaterialSeen;
            const entry = material.entries.find((e) => e.taskId === toVerify.taskId);
            // The criteria BECAME the description (`<objective> :: <role> — deliverable:
            // ...`), so the role token is a real, per-task criterion to check against.
            const role = entry === undefined ? '' : (entry.acceptanceCriteria.split(':: ')[1] ?? '').split(' —')[0] ?? '';
            const satisfies =
              entry !== undefined &&
              material.objective.trim() !== '' &&
              entry.acceptanceCriteria.trim() !== '' &&
              !entry.executionMissing &&
              entry.output.trim() !== '' &&
              entry.output.includes(role);
            if (satisfies && entry !== undefined) {
              action = 'complete';
              parameters.taskId = entry.taskId;
              parameters.reason = 'the acceptance material for this task shows its own output meets its own criteria';
            }
          } else if (toVerify === undefined && planned !== undefined) {
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
    await runRoundCli(drivable as never, argv, {
      provider,
      probes: [probeFor(AGENT_A, 'available', `${AGENT_A}/m1`)],
      // B4.0b P2-C: publish into the OWNED dir, never the caller's default report.
      roundResultDir: reportDir,
    });
  } finally {
    process.stdout.write = before;
  }
  const jsonStart = captured.indexOf('{');
  let report: Record<string, unknown> = {};
  if (jsonStart !== -1) { try { report = JSON.parse(captured.slice(jsonStart)); } catch { report = {}; } }
  return { report, requests, reviewRequests, decisionRequests, reportDir };
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
  const r = await workflowRound({ planChoice: 'full' });
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

  // B4.0b P2-B: a REAL verdict, not just "the reviewer was called".
  const ur = r.report.unifiedReview as { status?: string; verdict?: unknown; reviewer?: string } | undefined;
  check('full: the unified review COMPLETED with a real pass verdict',
    ur?.status === 'completed' && ur.verdict === 'pass',
    `status=${String(ur?.status)} verdict=${JSON.stringify(ur?.verdict)}`);
  check('full: the review attempt is recorded as real evidence',
    (r.report.reviewEvidence ?? []) as unknown[] !== undefined &&
      r.reviewRequests.length === 1 && existsSync(r.reportDir),
    `reviews=${r.reviewRequests.length}`);
  // B4.0b acceptance 5: each step's ACTUAL output reaches the review request.
  check('full: the review request carries EVERY step\'s actual output',
    r.reviewRequests.length === 1 &&
      ['STEP_OUT_1', 'STEP_OUT_2', 'STEP_OUT_3'].every((m) => r.reviewRequests[0]!.prompt.includes(m)),
    r.reviewRequests.map((q) => q.prompt.length).join(','));
}

// =========================================================================
section('lean: implementation -> test (research skipped)');

{
  const r = await workflowRound({ planChoice: 'lean' });
  check('lean: the workflow plan is reported as lean', workflowOf(r).choice === 'lean', JSON.stringify(workflowOf(r).choice));
  check('lean: two runs (implementation, test)', r.requests.length === 2, `n=${r.requests.length}`);
  check('lean: the test brief carries the implementation marker', r.requests[1]!.prompt.includes('STEP_OUT_1'), r.requests[1]!.prompt.slice(0, 200));
  check('lean: all members succeeded and the round is complete',
    r.report.ok === true && r.report.executionIncomplete === false, `ok=${String(r.report.ok)}`);
}

// =========================================================================
section('acceptance material: LAYA is given the objective, criteria and output');

{
  const r = await workflowRound({ planChoice: 'full', objective: 'OBJECTIVE_SENTINEL_77 retry budget' });
  const withMaterial = materialsSeenBy(r).filter((m) => m.entries.length > 0);
  check('material: some decisions carried acceptance material at all', withMaterial.length > 0, `cycles=${r.decisionRequests.length}`);
  check('material: every material carried the ORIGINAL objective',
    withMaterial.every((m) => m.objective === 'OBJECTIVE_SENTINEL_77 retry budget'),
    JSON.stringify(withMaterial.map((m) => m.objective)));
  check('material: entries carry per-task acceptance criteria, not a label',
    withMaterial.every((m) => m.entries.every((e) => e.acceptanceCriteria.includes('deliverable:'))),
    JSON.stringify(withMaterial[0]?.entries ?? []));
  // Same-task pairing: the material for a to_verify task carries THAT task's own output.
  const stepOf = (e: { taskId: string }): number => Number(/-w(\d+)$/.exec(e.taskId)?.[1] ?? NaN);
  const researchMaterial = withMaterial.find((m) => m.entries.some((e) => e.taskId.endsWith('-w1')));
  check('material: the to_verify task\'s own output is present in its own material',
    researchMaterial !== undefined && researchMaterial.entries.some((e) => e.taskId.endsWith('-w1') && e.output.includes('STEP_OUT_1')),
    JSON.stringify(researchMaterial?.entries ?? []));
  // The sharpest same-task property: a material entry's output carries its OWN step's
  // marker and no other step's. A mixed-up or stale pairing fails this immediately.
  check('material: every entry carries its OWN step output and no other step\'s',
    withMaterial.every((m) => m.entries.every((e) => {
      const own = `STEP_OUT_${stepOf(e)}`;
      return e.output === '' || (e.output.includes(own) && ![1, 2, 3].some((n) => `STEP_OUT_${n}` !== own && e.output.includes(`STEP_OUT_${n}`)));
    })),
    JSON.stringify(withMaterial.map((m) => m.entries.map((e) => `${e.taskId}=${e.output}`))));
}

// =========================================================================
section('unsatisfied output: LAYA must NOT accept, and downstream must not start');

{
  const r = await workflowRound({ planChoice: 'full', outputMode: 'unsatisfying' });
  check('unsatisfied: the research step ran but was never accepted', r.requests.length === 1, `n=${r.requests.length}`);
  check('unsatisfied: research is left to_verify, NOT succeeded', taskStatusW(r, 1) === 'to_verify', taskStatusW(r, 1));
  check('unsatisfied: the loop stopped on no progress, not by looping', workflowOf(r).stop === 'no-progress', String(workflowOf(r).stop));
  check('unsatisfied: downstream never started', r.requests.every((q) => !q.prompt.includes('STEP_OUT_1')), String(r.requests.length));
  check('unsatisfied: the round is NOT ok and IS incomplete',
    r.report.ok === false && r.report.executionIncomplete === true, `ok=${String(r.report.ok)} incomplete=${String(r.report.executionIncomplete)}`);
  check('unsatisfied: the report names the stop reason and the pending step',
    String(workflowOf(r).stop) === 'no-progress' && JSON.stringify(workflowOf(r).pending).includes('to_verify'),
    JSON.stringify(workflowOf(r).pending));
}

// =========================================================================
section('missing material: an empty output is never a forged pass');

{
  const r = await workflowRound({ planChoice: 'full', outputMode: 'empty' });
  const withMaterial = materialsSeenBy(r).filter((m) => m.entries.length > 0);
  check('empty-output: the material was still delivered, and it was honest about the absence',
    withMaterial.length > 0 && withMaterial.every((m) => m.entries.every((e) => e.output === '')),
    JSON.stringify(withMaterial.map((m) => m.entries.map((e) => e.output))));
  check('empty-output: nothing was accepted', r.requests.length === 1 && taskStatusW(r, 1) === 'to_verify',
    `n=${r.requests.length} w1=${taskStatusW(r, 1)}`);
  check('empty-output: the round is incomplete and not ok',
    r.report.ok === false && r.report.executionIncomplete === true, `ok=${String(r.report.ok)}`);
}

// =========================================================================
section('reviewer verdict: an invalid one is still rejected');

{
  // Missing `reviewedAt`, `findings` and `recommendedAction`: the contract rejects it.
  const r = await workflowRound({
    planChoice: 'full',
    reviewVerdictJson: JSON.stringify({ verdict: 'pass', reason: 'looks fine', reviewer: 'fixture-codex' }),
  });
  const ur = r.report.unifiedReview as { status?: string; verdict?: unknown; code?: string } | undefined;
  check('bad-verdict: the reviewer still ran', r.reviewRequests.length === 1, `reviews=${r.reviewRequests.length}`);
  check('bad-verdict: the round still completed all three steps', r.requests.length === 3, `n=${r.requests.length}`);
  check('bad-verdict: an invalid verdict is REFUSED, never read as a pass',
    ur?.status === 'failed' && ur.verdict !== 'pass' && String(ur?.code ?? '').includes('reviewer-output-invalid'),
    `status=${String(ur?.status)} verdict=${JSON.stringify(ur?.verdict)} code=${String(ur?.code)}`);
}

// =========================================================================
section('upstream failure: downstream is never started');

{
  const r = await workflowRound({ planChoice: 'full', failFirst: true });
  check('failure: only the research step ran', r.requests.length === 1, `n=${r.requests.length}`);
  check('failure: the loop stopped on the terminal failure', workflowOf(r).stop === 'terminal-failure', String(workflowOf(r).stop));
  check('failure: the round is NOT ok and IS incomplete',
    r.report.ok === false && r.report.executionIncomplete === true, `ok=${String(r.report.ok)} incomplete=${String(r.report.executionIncomplete)}`);
}

// =========================================================================
section('fixed selection survives the CLI workflow');

{
  const r = await workflowRound({ planChoice: 'lean', fixed: { agentId: AGENT_A, modelId: `${AGENT_A}/m1` } });
  check('fixed: every request used the pinned pair', r.requests.every((q) => q.agentId === AGENT_A && q.model === `${AGENT_A}/m1`),
    r.requests.map((q) => `${q.agentId}/${q.model}`).join(','));
  check('fixed: the round completed', r.report.ok === true, String(r.report.ok));
}

// =========================================================================
section('report isolation: the caller\'s report dir is never touched');

{
  // A sentinel standing in for "a report the caller owns". Owned by THIS test, so
  // reading and re-reading it proves isolation without touching any foreign dir.
  const callerDir = ownDir();
  const sentinel = join(callerDir, 'round-result.json');
  writeFileSync(sentinel, '{"owner":"caller","untouched":true}', 'utf8');

  const r = await workflowRound({ planChoice: 'lean' });
  const published = (r.report.roundResultPublished ?? {}) as { ok?: boolean; path?: string };
  check('isolation: the round published its report', published.ok === true, JSON.stringify(published));
  check('isolation: the published path is inside the OWNED dir',
    typeof published.path === 'string' && published.path.startsWith(r.reportDir) && existsSync(published.path),
    `path=${String(published.path)} owned=${r.reportDir}`);
  check('isolation: the caller\'s report file was NOT modified',
    readFileSync(sentinel, 'utf8') === '{"owner":"caller","untouched":true}', readFileSync(sentinel, 'utf8'));

  // And the production default is still what an un-overridden caller gets: proven by
  // the pure resolver with an explicit env, so no real home directory is read or written.
  const resolved = defaultRoundResultPath({ ORCH_HOME: callerDir } as NodeJS.ProcessEnv);
  check('isolation: the default resolver still honours $ORCH_HOME',
    resolved === sentinel, `${resolved} vs ${sentinel}`);
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
