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
import { createLayaDecisionProvider } from '../src/decision/laya.ts';
import type { RunHandle, RunRequest, RunResult } from '../src/core/types.ts';
import type { DecisionProvider, DecisionRequest } from '../src/decision/types.ts';
import { INITIAL_AGENT_MODEL_ID, initialCandidateKey } from '../src/decision/initial-assignment.ts';
import { EXECUTION_TOPOLOGY_ID, TOPOLOGY_SOLO } from '../src/decision/execution-topology.ts';
import { WORKFLOW_PLAN_ID } from '../src/decision/plan-choice.ts';
import { ACCEPTANCE_MATERIAL_FIELD, ORCHESTRATION_ACTION_ID } from '../src/orchestration/decision-loop.ts';
import type { QuotaProbe } from '../src/quota/index.ts';
import type { WorkflowCheckpointSnapshot } from '../src/cli/workflow-checkpoint.ts';

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
    return { type: 'choice', choice: pick, probabilities, confidence: 1, answer_confidence: 1, action: { act_probability: 1 } };
  }
  if (question.type === 'score') {
    const levels = question.criteria as string[];
    const index = Math.max(0, levels.indexOf(overrides[id] ?? 'small'));
    const probabilities: Record<string, number> = {};
    for (let i = 0; i < levels.length; i++) probabilities[String(i)] = i === index ? 1 : 0;
    const legend: Record<string, string> = {};
    for (let i = 0; i < levels.length; i++) legend[String(i)] = levels[i]!;
    return { type: 'score', score: index, level: levels[index]!, levels: [...levels], probabilities, legend, confidence: 1, answer_confidence: 1 };
  }
  if (question.type === 'noul') return { type: 'noul', noul: 1, answer_confidence: 1 };
  return { type: question.type };
}

function probeFor(agentId: string, status: 'available' | 'exhausted' | 'not_fetched' = 'available', modelId = `${agentId}/m1`): QuotaProbe {
  return {
    agentId, provider: agentId,
    records: [{ provider: agentId, agentId, modelId: null, source: 'locally_observed', usage: null, remaining: null, resetAt: null, period: 'day', status, usageClass: 'observed', confidence: 'high', observedAt: Date.now(), note: '' }],
    login: 'stubbed for test', version: '0.0.0-test', modelHint: modelId, providerHint: null, error: null,
  } as unknown as QuotaProbe;
}

interface Round { report: Record<string, unknown>; requests: RunRequest[]; reviewRequests: RunRequest[]; decisionRequests: DecisionRequest[]; reportDir: string; exitCode: number }

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
  /** B4.6a: opt in to the single-step USER checkpoint. */
  checkpoint?: boolean;
  /** B4.6a: control the user's raw answer (the CLI validates it, not this fixture). */
  checkpointInput?: (snapshot: WorkflowCheckpointSnapshot) => string | Promise<string>;
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

  /*
   * The REAL production provider, driven through a fetch seam that answers with ONLY
   * the native 0.3.21 response shape: `{ type, choice, probabilities, confidence,
   * answer_confidence, action? }`. There is deliberately NO sibling `taskId`/`reason`
   * and NO `DecisionResponse.parameters`: the offered choice keys are the only way a
   * target can be named, which is the whole point of LAYA-ACTION.1.
   */
  const overrides: Record<string, string> = { ...ROUTING_ANSWERS };
  if (opts.planChoice !== undefined) overrides[WORKFLOW_PLAN_ID] = opts.planChoice;
  if (opts.fixed !== undefined) overrides[INITIAL_AGENT_MODEL_ID] = initialCandidateKey(opts.fixed.agentId, opts.fixed.modelId);
  overrides[EXECUTION_TOPOLOGY_ID] = TOPOLOGY_SOLO;

  /**
   * The material-driven action choice, mapped onto an ACTUALLY OFFERED key.
   *
   * The offered space is the bounded workflow space: continue/wait/abort plus one
   * key per eligible to_verify task. `complete` is offered under the bare key when
   * it binds a single task, otherwise under a key that names the task — so this
   * fixture must pick the offered key, never inject a sibling target.
   */
  const nativeActionAnswer = (criteria: Record<string, string>, state: Record<string, string>): Record<string, unknown> => {
    const offered = Object.keys(criteria);
    const parsed = JSON.parse(String(state[ORCHESTRATION_ACTION_ID] ?? '{}')) as { tasks?: Array<{ taskId: string; status: string }> };
    const tasks = parsed.tasks ?? [];
    const toVerify = tasks.find((t) => t.status === 'to_verify');
    const planned = tasks.find((t) => t.status === 'planned' || t.status === 'queued');

    /*
     * MATERIAL-DRIVEN, not status-driven. This is the whole point of B4.0b: the
     * fixture accepts a task only when the material for THAT task shows its own
     * execution met its own criteria. Seeing `to_verify` is never sufficient, and
     * a missing/empty material can never be read as a pass.
     */
    let action = 'wait';
    let target: string | null = null;
    const rawMaterial = state[ACCEPTANCE_MATERIAL_FIELD];
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
      if (satisfies && entry !== undefined) { action = 'complete'; target = entry.taskId; }
    } else if (toVerify === undefined && planned !== undefined) {
      action = 'continue';
    }
    let chosen: string;
    if (action === 'complete') {
      chosen = offered.find((k) => k === 'complete')
        ?? offered.find((k) => target !== null && k.endsWith(target))
        ?? 'wait';
    } else {
      chosen = offered.includes(action) ? action : 'wait';
    }
    if (!offered.includes(chosen)) chosen = offered.includes('wait') ? 'wait' : offered[0]!;
    const probabilities: Record<string, number> = {};
    for (const o of offered) probabilities[o] = o === chosen ? 1 : 0;
    return { type: 'choice', choice: chosen, probabilities, confidence: 1, answer_confidence: 1, action: { act_probability: 1 } };
  };

  const provider: DecisionProvider = createLayaDecisionProvider({
    fetchImpl: (async (url: string, init?: { method?: string; body?: string }) => {
      const u = String(url);
      if (u.endsWith('/health')) {
        return new Response(JSON.stringify({ status: 'ok', device: 'cuda', loaded: ['english'], cpu_fallbacks: {} }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        state?: Record<string, string>;
        questions?: Record<string, { type: string; criteria?: unknown }>;
      };
      const questions = body.questions ?? {};
      const state = body.state ?? {};
      const answers: Record<string, unknown> = {};
      for (const [key, q] of Object.entries(questions)) {
        if (key === ORCHESTRATION_ACTION_ID) {
          decisionRequests.push({ questions, state } as unknown as DecisionRequest);
          answers[key] = nativeActionAnswer((q.criteria ?? {}) as Record<string, string>, state);
          continue;
        }
        answers[key] = answerFor(key, q as { type: string; criteria: unknown }, overrides);
      }
      /*
       * LAYA-CONTEXT.1: the real provider always reports routing/usage, and the
       * bounded visibility guard reads checkpoint + input tokens from it. The
       * fixture must therefore send a supported checkpoint and an UNDER-budget token
       * count, or every bounded cycle would (correctly) be refused. This is
       * explicitly CONTROLLED fixture metadata, not a real tokenizer measurement.
       */
      return new Response(JSON.stringify({
        model: 'laya-fixture',
        answers,
        routing: { model: 'english', reason: 'controlled fixture metadata', detection: { script: 'latin', language: 'en' }, revisions: {} },
        usage: { input_tokens: 128, output_tokens: 0 },
      }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch,
  });

  const argv = [
    opts.objective ?? 'add a retry to the http client',
    '--json', '--cwd', dir,
    '--agent', AGENT_A,
    '--max-children', '1', '--max-concurrent', '1',
    '--workflow', 'sequential',
    ...(opts.workflowChoice !== undefined ? ['--workflow-choice', opts.workflowChoice] : []),
    ...(opts.fixed !== undefined ? ['--select', 'fixed', '--agent', opts.fixed.agentId, '--model', opts.fixed.modelId] : []),
    ...(opts.checkpoint === true ? ['--checkpoint'] : []),
  ];
  const before = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => { captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true; }) as typeof process.stdout.write;
  let exitCode = -1;
  try {
    exitCode = await runRoundCli(drivable as never, argv, {
      provider,
      /*
       * TWO available pairs for the one agent. The REAL production provider refuses a
       * one-option `choice` (it would answer the same for every input), and a single
       * registered pair makes the initial Agent x Model question exactly that. Two pairs
       * keep the assignment question a real decision; the fixture then picks among the
       * offered keys, exactly as a native Laya answer would.
       */
      probes: [probeFor(AGENT_A, 'available', `${AGENT_A}/m1`), probeFor(AGENT_A, 'available', `${AGENT_A}/m2`)],
      // B4.0b P2-C: publish into the OWNED dir, never the caller's default report.
      roundResultDir: reportDir,
      ...(opts.checkpointInput === undefined ? {} : { checkpointInput: opts.checkpointInput }),
    });
  } finally {
    process.stdout.write = before;
  }
  const jsonStart = captured.indexOf('{');
  let report: Record<string, unknown> = {};
  if (jsonStart !== -1) { try { report = JSON.parse(captured.slice(jsonStart)); } catch { report = {}; } }
  return { report, requests, reviewRequests, decisionRequests, reportDir, exitCode };
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
  /*
   * B4.0b left-off P2 (closed here): the previous assertion read
   * `(report.reviewEvidence ?? []) !== undefined`, which is CONSTANTLY TRUE — `[]`
   * is not `undefined`, and so is any value. It therefore proved nothing about the
   * review evidence and only the call count carried the check. These three
   * assertions are the real ones:
   *   1. `reviewEvidence.ok` is actually true (the append was accepted);
   *   2. `attemptId` is a NON-EMPTY string (an id, not a null placeholder);
   *   3. that exact id resolves to a REAL record in the published round result,
   *      and that record's `kind` is `review` — not an execution attempt that
   *      merely happens to sit at the same index.
   */
  const re = r.report.reviewEvidence as { recorded?: boolean; ok?: boolean; attemptId?: string | null } | undefined;
  check('full: the review evidence append was ACCEPTED (reviewEvidence.ok)',
    re?.ok === true,
    `ok=${String(re?.ok)} recorded=${String(re?.recorded)}`);
  check('full: the review evidence carries a NON-EMPTY attempt id',
    typeof re?.attemptId === 'string' && re.attemptId.trim() !== '',
    `attemptId=${JSON.stringify(re?.attemptId)}`);
  const publishedAttempts = (((r.report.roundResult as Record<string, unknown> | undefined)?.machine as Record<string, unknown> | undefined)?.attempts ?? []) as Array<Record<string, unknown>>;
  const reviewRecord = publishedAttempts.find((a) => a.attemptId === re?.attemptId);
  check('full: that attempt id resolves to a REAL kind=review record in the round result',
    reviewRecord !== undefined && reviewRecord.kind === 'review',
    `found=${reviewRecord === undefined ? 'none' : JSON.stringify(reviewRecord)} total=${publishedAttempts.length}`);
  // And the same record survives into the PUBLISHED artifact on disk, not just the
  // in-memory object: the published JSON is what a later reader or the dashboard reads.
  const publishedPath = (r.report.roundResultPublished as { path?: string } | undefined)?.path;
  let publishedKinds: string[] = [];
  if (typeof publishedPath === 'string' && existsSync(publishedPath)) {
    const onDisk = JSON.parse(readFileSync(publishedPath, 'utf8')) as { machine?: { attempts?: Array<{ attemptId?: string; kind?: string }> } };
    publishedKinds = (onDisk.machine?.attempts ?? []).map((a) => `${String(a.attemptId)}:${String(a.kind)}`);
  }
  check('full: the published report file really contains that kind=review attempt',
    publishedKinds.includes(`${String(re?.attemptId)}:review`),
    `path=${String(publishedPath)} kinds=${publishedKinds.join(',')}`);
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
section('action eligibility: LAYA is offered continue only when a step is dispatchable');

{
  // The REAL production request builder over a REAL round: every bounded LAYA cycle is
  // captured with the exact offered keys, and the fixture answers only an OFFERED key.
  const r = await workflowRound({ planChoice: 'full', outputMode: 'unsatisfying' });
  const offeredPerCycle = r.decisionRequests.map((req) =>
    Object.keys(((req.questions[ORCHESTRATION_ACTION_ID] as { criteria?: Record<string, string> } | undefined)?.criteria) ?? {}));

  // Cycle 1 runs while step 1 is planned and READY, so continue is on the table, and the
  // offered continue really dispatched the first step.
  check('eligibility: the first cycle (a ready planned step) offered continue',
    offeredPerCycle.length >= 1 && offeredPerCycle[0]!.includes('continue'), JSON.stringify(offeredPerCycle));
  // Once step 1 is to_verify, NOTHING is dispatchable: continue is gone, wait/abort stay,
  // and the completion target the material can be judged against is still offered.
  check('eligibility: a no-ready cycle never offers continue',
    offeredPerCycle.length >= 2 && offeredPerCycle.slice(1).every((o) => !o.includes('continue')),
    JSON.stringify(offeredPerCycle));
  check('eligibility: a no-ready cycle still offers wait and abort',
    offeredPerCycle.slice(1).every((o) => o.includes('wait') && o.includes('abort')), JSON.stringify(offeredPerCycle));
  check('eligibility: a no-ready cycle still offers the exact completion target it can judge',
    offeredPerCycle.slice(1).every((o) => o.some((k) => k !== 'continue' && k !== 'wait' && k !== 'abort')),
    JSON.stringify(offeredPerCycle));
  check('eligibility: the ready step really dispatched through the CLI loop',
    r.requests.length === 1 && taskStatusW(r, 1) === 'to_verify' && r.report.ok === false,
    `n=${r.requests.length} w1=${taskStatusW(r, 1)} ok=${String(r.report.ok)}`);
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
// B4.6a: the opt-in single-step USER checkpoint.
//
// The REAL runRoundCli / Workbench / Assignment / Scheduler / Verification chain runs
// here; only LAYA's answers and the runtime's per-agent outcome are injected. The user's
// answer is controlled through the `checkpointInput` seam, and the CLI validates it.
// =========================================================================

interface CheckpointsReport {
  enabled: boolean;
  prompts: number;
  entries: Array<{ taskId: string; status: string; role: string | null; acceptanceCriteria: string; attemptId: string; agentId: string; modelId: string | null; output: string; outputTruncated: boolean; treeStopConfirmed: boolean | null; choice: 'continue' | 'stop'; stopReason: string | null }>;
  stop: { taskId: string; reason: string; blockedTaskIds: string[] } | null;
  note: string;
}
const checkpointsOf = (r: Round): CheckpointsReport | undefined => r.report.checkpoints as CheckpointsReport | undefined;

section('checkpoint off: the seam is never called and no field is added');

{
  let calls = 0;
  const r = await workflowRound({ planChoice: 'lean', checkpointInput: () => { calls += 1; return 'continue'; } });
  check('off: the input seam is never called without --checkpoint', calls === 0, `calls=${calls}`);
  check('off: no checkpoints field is added to the report', r.report.checkpoints === undefined, JSON.stringify(r.report.checkpoints));
  check('off: the lean round still completes', r.report.ok === true && r.requests.length === 2 && taskStatusW(r, 2) === 'succeeded',
    `ok=${String(r.report.ok)} n=${r.requests.length} w2=${taskStatusW(r, 2)}`);
}

section('checkpoint continue: the existing acceptance still succeeds, one prompt per attempt');

{
  const prompted: string[] = [];
  const r = await workflowRound({
    planChoice: 'full',
    checkpoint: true,
    checkpointInput: (s) => { prompted.push(s.taskId); return 'continue'; },
  });
  const cp = checkpointsOf(r)!;
  check('continue: one prompt per step (three attempts, three prompts)',
    prompted.length === 3 && new Set(prompted).size === 3, JSON.stringify(prompted));
  check('continue: the same attempt is never prompted twice', new Set(prompted).size === prompted.length, JSON.stringify(prompted));
  check('continue: the round still completes all three steps',
    r.report.ok === true && r.requests.length === 3 && taskStatusW(r, 3) === 'succeeded' && r.exitCode === 0,
    `ok=${String(r.report.ok)} n=${r.requests.length} w3=${taskStatusW(r, 3)} exit=${r.exitCode}`);
  check('continue: every entry records the continue choice and no stop',
    cp.entries.length === 3 && cp.entries.every((e) => e.choice === 'continue' && e.stopReason === null) && cp.stop === null,
    JSON.stringify(cp.entries.map((e) => e.choice)));
  // The snapshot facts are this attempt's own — role, a real attemptId, its own marker.
  check('continue: each entry carries the task\'s own role, attemptId and output',
    cp.entries.every((e) => e.attemptId.trim() !== '' && typeof e.role === 'string' && e.role !== '' && e.output.includes('STEP_OUT_')) &&
      cp.entries.some((e) => e.output.includes('STEP_OUT_1')) && cp.entries.some((e) => e.output.includes('STEP_OUT_3')),
    JSON.stringify(cp.entries.map((e) => `${e.role}:${e.output.slice(0, 12)}`)));
}

section('checkpoint stop: only the first member RUNS, downstream never starts, round is incomplete');

{
  const r = await workflowRound({
    planChoice: 'full',
    checkpoint: true,
    checkpointInput: () => 'stop the first step does not look right',
  });
  const cp = checkpointsOf(r)!;
  check('stop: exactly ONE runtime run happened', r.requests.length === 1, `n=${r.requests.length}`);
  check('stop: the first step is left to_verify (unverified)', taskStatusW(r, 1) === 'to_verify', taskStatusW(r, 1));
  check('stop: downstream steps never ran', r.requests.every((q) => !q.prompt.includes('implementation — deliverable') && !q.prompt.includes('test — deliverable')),
    r.requests.map((q) => q.prompt.slice(0, 40)).join(' | '));
  check('stop: the loop stopped on user-stop', workflowOf(r).stop === 'user-stop', String(workflowOf(r).stop));
  check('stop: the report records the stop reason and task', cp.stop !== null && cp.stop.reason === 'the first step does not look right' &&
    cp.entries[0]!.choice === 'stop' && cp.entries[0]!.stopReason === 'the first step does not look right',
    JSON.stringify(cp.stop));
  check('stop: the report names the blocked downstream tasks', cp.stop !== null && cp.stop.blockedTaskIds.length >= 2 &&
    cp.stop.blockedTaskIds.some((id) => id.endsWith('-w3')), JSON.stringify(cp.stop?.blockedTaskIds));
  check('stop: the round is NOT ok, IS incomplete, and exits non-zero',
    r.report.ok === false && r.report.executionIncomplete === true && r.exitCode !== 0,
    `ok=${String(r.report.ok)} incomplete=${String(r.report.executionIncomplete)} exit=${r.exitCode}`);
  // The checkpoint's correlated attempt/pair matches the run the report recorded.
  check('stop: the checkpoint attempt/pair matches the real run',
    cp.entries[0]!.agentId === r.requests[0]!.agentId && cp.entries[0]!.attemptId.trim() !== '' &&
      cp.entries[0]!.output.includes('STEP_OUT_1'),
    JSON.stringify({ entry: cp.entries[0]!.attemptId, req: r.requests[0]!.agentId }));
  // Even with handoff ON by default, a stop starts no second execution.
  const handoff = r.report.handoff as { enabled?: boolean; happened?: number } | undefined;
  check('stop: handoff stays enabled by default yet no further work started',
    handoff?.enabled === true && handoff.happened === 0 && r.requests.length === 1,
    JSON.stringify(handoff));
  // The run's evidence is not discarded by the stop.
  const ev = (r.report.evidence ?? []) as Array<{ taskId: string; attempts: number }>;
  check('stop: the completed run\'s evidence is preserved', ev.some((e) => e.taskId.endsWith('-w1') && e.attempts >= 1),
    JSON.stringify(ev));
}

section('checkpoint fail-closed: an illegal or unreadable answer stops');

{
  const illegal = await workflowRound({ planChoice: 'lean', checkpoint: true, checkpointInput: () => 'maybe later' });
  const cp = checkpointsOf(illegal)!;
  check('illegal: an unrecognised answer stops the round', workflowOf(illegal).stop === 'user-stop' && illegal.requests.length === 1,
    `stop=${String(workflowOf(illegal).stop)} n=${illegal.requests.length}`);
  check('illegal: the report says the answer was not understood',
    cp.entries[0]!.choice === 'stop' && /not understood|invalid/i.test(cp.entries[0]!.stopReason ?? '') && cp.stop !== null,
    JSON.stringify(cp.entries[0]!.stopReason));
  check('illegal: the round is incomplete and non-zero', illegal.report.ok === false && illegal.report.executionIncomplete === true && illegal.exitCode !== 0,
    `ok=${String(illegal.report.ok)} exit=${illegal.exitCode}`);

  const threw = await workflowRound({ planChoice: 'lean', checkpoint: true, checkpointInput: () => { throw new Error('stdin exploded'); } });
  const cp2 = checkpointsOf(threw)!;
  check('throw: a reader error stops the round (fail closed)', workflowOf(threw).stop === 'user-stop' && threw.requests.length === 1,
    `stop=${String(workflowOf(threw).stop)} n=${threw.requests.length}`);
  check('throw: the report records the unreadable answer',
    cp2.entries[0]!.choice === 'stop' && /could not be read/.test(cp2.entries[0]!.stopReason ?? ''),
    JSON.stringify(cp2.entries[0]!.stopReason));
}

// =========================================================================
section('checkpoint stop AFTER a verified step: prior verdicts are kept, only the pending step is unverified');

{
  // Real path: step 1 runs, "continue" lets LAYA VERIFY it (succeeded), step 2 then runs and
  // the user stops. The old note claimed "a stop leaves every task unverified", which is
  // FALSE here — step 1 was already verified and must keep its verdict. The task states are
  // read from the real TaskStore projection.
  let prompts = 0;
  const r = await workflowRound({
    planChoice: 'full',
    checkpoint: true,
    checkpointInput: () => { prompts += 1; return prompts === 1 ? 'continue' : 'stop step two is not acceptable'; },
  });
  const cp = checkpointsOf(r)!;
  check('stop-after-success: exactly two runs (step 1 verified, step 2 stopped)', r.requests.length === 2, `n=${r.requests.length}`);
  check('stop-after-success: step 1 keeps its VERIFIED status (not retracted by the stop)', taskStatusW(r, 1) === 'succeeded', taskStatusW(r, 1));
  check('stop-after-success: step 2 is left to_verify and step 3 is still planned',
    taskStatusW(r, 2) === 'to_verify' && taskStatusW(r, 3) === 'planned', `w2=${taskStatusW(r, 2)} w3=${taskStatusW(r, 3)}`);
  check('stop-after-success: the loop stopped on user-stop', workflowOf(r).stop === 'user-stop', String(workflowOf(r).stop));
  check('stop-after-success: the note says only the AWAITING step is unverified and prior work is kept',
    /awaiting verification is left UNVERIFIED/i.test(String(cp.note)) && /verified BEFORE the stop keep their verdict/i.test(String(cp.note)),
    String(cp.note));
  check('stop-after-success: the note no longer claims every task is unverified',
    !/every task unverified/i.test(String(cp.note)), String(cp.note));
  check('stop-after-success: the round is incomplete and non-zero',
    r.report.ok === false && r.report.executionIncomplete === true && r.exitCode !== 0,
    `ok=${String(r.report.ok)} incomplete=${String(r.report.executionIncomplete)} exit=${r.exitCode}`);
}

// =========================================================================
section('checkpoint continue: an empty or unsatisfying output is still NOT accepted');

{
  // "continue" must only let the EXISTING verification proceed. When the step's own output
  // is empty or does not show its deliverable, LAYA must not accept it: the task stays
  // to_verify, only ONE run happened, the round is incomplete and exits non-zero.
  for (const mode of ['unsatisfying', 'empty'] as const) {
    const r = await workflowRound({
      planChoice: 'full',
      outputMode: mode,
      checkpoint: true,
      checkpointInput: () => 'continue',
    });
    const cp = checkpointsOf(r)!;
    check(`continue+${mode}: only the first step ran`, r.requests.length === 1, `n=${r.requests.length}`);
    check(`continue+${mode}: the step stays to_verify (never accepted)`, taskStatusW(r, 1) === 'to_verify', taskStatusW(r, 1));
    check(`continue+${mode}: the checkpoint choice was a real continue`, cp.entries.length === 1 && cp.entries[0]!.choice === 'continue', JSON.stringify(cp.entries.map((e) => e.choice)));
    check(`continue+${mode}: the round is not ok, IS incomplete, and exits non-zero`,
      r.report.ok === false && r.report.executionIncomplete === true && r.exitCode !== 0,
      `ok=${String(r.report.ok)} incomplete=${String(r.report.executionIncomplete)} exit=${r.exitCode}`);
  }
}

// =========================================================================
section('checkpoint fail-closed: a non-string answer and a NON-Error throw stop safely');

{
  // A typed seam return is NOT trusted: a non-string must be validated (and rejected) by
  // the SAME parseCheckpointAnswer, never read as a default continue.
  const nonString = await workflowRound({
    planChoice: 'lean',
    checkpoint: true,
    checkpointInput: (() => 42) as unknown as () => string,
  });
  const cp = checkpointsOf(nonString)!;
  check('non-string: a numeric answer stops and is not treated as continue',
    workflowOf(nonString).stop === 'user-stop' && nonString.requests.length === 1 && cp.entries[0]!.choice === 'stop',
    `stop=${String(workflowOf(nonString).stop)} n=${nonString.requests.length} choice=${cp.entries[0]!.choice}`);
  check('non-string: the report says the answer was not understood',
    /not understood|invalid/i.test(cp.entries[0]!.stopReason ?? ''), JSON.stringify(cp.entries[0]!.stopReason));
  check('non-string: a COMPLETE report is still produced and the round exits non-zero',
    nonString.report.ok === false && nonString.report.checkpoints !== undefined && nonString.exitCode !== 0,
    `ok=${String(nonString.report.ok)} exit=${nonString.exitCode}`);

  // A seam that throws a NON-Error (null / a bare string) must NOT crash the round:
  // `(e as Error).message` would itself throw on null. The stop must still be recorded and
  // the report must still be produced, then the round exits non-zero.
  for (const thrown of [null, 'reader exploded'] as const) {
    const label = thrown === null ? 'null' : 'string';
    const r = await workflowRound({
      planChoice: 'lean',
      checkpoint: true,
      checkpointInput: (() => { throw thrown; }) as unknown as () => string,
    });
    const cpThrow = checkpointsOf(r)!;
    check(`non-Error(${label}): stops safely (fail closed)`, workflowOf(r).stop === 'user-stop' && r.requests.length === 1,
      `stop=${String(workflowOf(r).stop)} n=${r.requests.length}`);
    check(`non-Error(${label}): the report names the unreadable answer`,
      cpThrow.entries[0]!.choice === 'stop' && /could not be read/.test(cpThrow.entries[0]!.stopReason ?? ''),
      JSON.stringify(cpThrow.entries[0]!.stopReason));
    check(`non-Error(${label}): a COMPLETE report is produced, not a crash`, r.report.ok === false && r.report.checkpoints !== undefined && r.exitCode !== 0,
      `ok=${String(r.report.ok)} exit=${r.exitCode}`);
  }
}

// =========================================================================
section('checkpoint production reader: a real non-TTY stdin stops after the first run');

{
  // The PRODUCTION default reader (no `checkpointInput` seam) reads `process.stdin`. In a
  // real non-interactive invocation stdin is not a TTY, so the reader refuses WITHOUT
  // waiting and the round must stop after the first member ran: runtime=1, no downstream
  // run, a COMPLETE JSON report, and a non-zero exit. `isTTY` is forced off so the
  // assertion is deterministic regardless of the ambient terminal; the reader is still the
  // real one, and no seam is passed.
  const stdin = process.stdin as unknown as { isTTY?: boolean };
  const own = Object.getOwnPropertyDescriptor(stdin, 'isTTY');
  Object.defineProperty(stdin, 'isTTY', { value: false, configurable: true });
  let r: Round;
  try {
    r = await workflowRound({ planChoice: 'full', checkpoint: true });
  } finally {
    if (own !== undefined) Object.defineProperty(stdin, 'isTTY', own);
    else delete stdin.isTTY;
  }
  const cp = checkpointsOf(r)!;
  check('non-TTY: exactly ONE runtime run happened', r.requests.length === 1, `n=${r.requests.length}`);
  check('non-TTY: the stop reason names the non-terminal stdin',
    cp.stop !== null && /not a terminal/.test(cp.stop.reason), JSON.stringify(cp.stop?.reason));
  check('non-TTY: no downstream step ever ran', r.requests.every((q) => !q.prompt.includes('implementation — deliverable') && !q.prompt.includes('test — deliverable')),
    r.requests.map((q) => q.prompt.slice(0, 40)).join(' | '));
  check('non-TTY: the JSON report is complete and the round exits non-zero',
    r.report.ok === false && r.report.executionIncomplete === true && r.report.checkpoints !== undefined &&
      r.report.roundResult !== undefined && r.exitCode !== 0,
    `ok=${String(r.report.ok)} incomplete=${String(r.report.executionIncomplete)} exit=${r.exitCode}`);
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
