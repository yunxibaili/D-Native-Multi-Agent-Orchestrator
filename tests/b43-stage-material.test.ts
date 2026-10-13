/**
 * tests/b43-stage-material.test.ts — B4.3: the opt-in STAGE gate.
 *
 * WHAT IS REAL vs INJECTED
 * ------------------------
 * REAL: `runRoundCli` -> the stage gate (file read + `parseStageMaterial` + digest binding)
 * -> the plan (built-in or a B4.2 plan file) -> `planWithCandidates` -> LAYA's initial
 * Agent x Model question -> Assignment -> Scheduler -> `executeTask` -> AttemptStore -> the
 * decision loop -> `applyVerification` -> the unified review -> the published round result.
 *
 * INJECTED, and only these two: LAYA's ANSWERS, and the RUNTIME side of each run. The
 * runtime stub writes REAL FILES into the round's OWN working directory.
 *
 * Run: node tests/b43-stage-material.test.ts
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { runRoundCli, normalizedPlanScope } from '../src/cli/round-cli.ts';
import { Orchestrator as RuntimeOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { createFakeAdapter } from './helpers.ts';
import type { RunHandle, RunRequest, RunResult, ToolCall } from '../src/core/types.ts';
import type { DecisionProvider, DecisionRequest } from '../src/decision/types.ts';
import { INITIAL_AGENT_MODEL_ID, initialCandidateKey } from '../src/decision/initial-assignment.ts';
import { WORKFLOW_PLAN_ID } from '../src/decision/plan-choice.ts';
import { ACCEPTANCE_MATERIAL_FIELD, ORCHESTRATION_ACTION_ID } from '../src/orchestration/decision-loop.ts';
import { parsePlanFile } from '../src/orchestration/plan-file.ts';
import { parseStageMaterial, stageBindingDigest } from '../src/orchestration/stage-material.ts';
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
function ownDir(): string { const d = mkdtempSync(join(tmpdir(), 'b43-')); tmpDirs.push(d); return d; }
function removeOwnedDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); }
  catch (e) { cleanupFailures.push(`owned dir removal threw for ${dir}: ${(e as Error).message}`); return; }
  if (existsSync(dir)) cleanupFailures.push(`owned dir ${dir} still present after removal`);
}
function filesUnder(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const child = rel === '' ? entry.name : `${rel}${sep}${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnder(root, child));
    else out.push(child.split(sep).join('/'));
  }
  return out;
}

const AGENT_A = 'agent-a';
const REVIEWER = 'codex';
const CAPS = { newTask: true, review: true, modelSelection: true, cwd: true, resume: true } as never;
const ROUTING: Record<string, string> = { work_kind: 'implementation', complexity: 'small' };

function answerFor(id: string, question: { type: string; criteria: unknown }): Record<string, unknown> {
  if (question.type === 'choice') {
    const offered = Object.keys(question.criteria as Record<string, string>);
    const pick = offered[0]!;
    const probabilities: Record<string, number> = {};
    for (const o of offered) probabilities[o] = o === pick ? 1 : 0;
    return { type: 'choice', choice: pick, probabilities, confidence: 1 };
  }
  if (question.type === 'score') {
    const levels = question.criteria as string[];
    const index = Math.max(0, levels.indexOf(ROUTING[id] ?? 'small'));
    const probabilities: Record<string, number> = {};
    for (let i = 0; i < levels.length; i++) probabilities[String(i)] = i === index ? 1 : 0;
    const legend: Record<string, string> = {};
    for (let i = 0; i < levels.length; i++) legend[String(i)] = levels[i]!;
    return { type: 'score', score: index, level: levels[index]!, levels: [...levels], probabilities, legend, confidence: 1 };
  }
  if (question.type === 'noul') return { type: 'noul', noul: 1 };
  return { type: question.type };
}

function probeFor(agentId: string, modelId: string): QuotaProbe {
  return {
    agentId, provider: agentId,
    records: [{ provider: agentId, agentId, modelId: null, source: 'locally_observed', usage: null, remaining: null, resetAt: null, period: 'day', status: 'available', usageClass: 'observed', confidence: 'high', observedAt: Date.now(), note: '' }],
    login: 'stubbed for test', version: '0.0.0-test', modelHint: modelId, providerHint: null, error: null,
  } as unknown as QuotaProbe;
}

const SEQUENTIAL_PLAN = {
  kind: 'sequential',
  plans: [{
    id: 'stage-flow', label: 'research then implement',
    steps: [
      { role: 'api-research', taskType: 'research', fileScope: 'docs/api', deliverable: 'the api findings note' },
      { role: 'server', taskType: 'implementation', fileScope: 'src/server', deliverable: 'the server change' },
    ],
  }],
};
const ROLES = [{ role: 'api-research', scope: 'docs/api' }, { role: 'server', scope: 'src/server' }];

function roleOf(prompt: string): string | null {
  const m = /:: ([\w-]+) — deliverable:/.exec(prompt);
  return m === null ? null : m[1]!;
}

interface Round {
  report: Record<string, unknown>;
  requests: RunRequest[];
  reviewRequests: RunRequest[];
  decisionRequests: DecisionRequest[];
  reportDir: string;
  cwd: string;
  exitCode: number;
  /** How many times the decision provider was asked ANYTHING (0 = never called). */
  providerCalls: number;
}

const STAGE = { stageId: 'stage-1-api', scope: 'only the users API', requirement: 'the API must authenticate requests', acceptance: 'a request without a token is 401', planRef: 'stage-flow' };
const OBJECTIVE = 'add authentication to the users API';
/** The digest the user would pass: bound to the material AND the plan that actually runs. */
const digestOf = (material: unknown, planFileJson?: unknown): string => {
  const m = parseStageMaterial(material);
  return stageBindingDigest({
    material: m,
    objective: OBJECTIVE,
    workflow: 'sequential',
    planRef: m.planRef ?? null,
    planScope: normalizedPlanScope('sequential', planFileJson === undefined ? null : parsePlanFile(planFileJson)),
  });
};

async function stageRound(opts: {
  material?: unknown;
  rawMaterialText?: string;
  writeMaterial?: boolean;
  stageArg?: string;
  noStage?: boolean;
  confirm?: string;
  stageCheck?: boolean;
  planFile?: unknown;
  objective?: string;
  fixed?: { agentId: string; modelId: string };
} = {}): Promise<Round> {
  const cwd = ownDir();
  const reportDir = join(ownDir(), 'reports');
  if (opts.writeMaterial !== false) {
    writeFileSync(join(cwd, 'stage.json'), opts.rawMaterialText ?? JSON.stringify(opts.material ?? STAGE), 'utf8');
  }
  if (opts.planFile !== undefined) writeFileSync(join(cwd, 'plans.json'), JSON.stringify(opts.planFile), 'utf8');

  const requests: RunRequest[] = [];
  const reviewRequests: RunRequest[] = [];
  const decisionRequests: DecisionRequest[] = [];
  const VERDICT = JSON.stringify({ verdict: 'pass', reason: 'fixture reviewer: the stage deliveries meet the recorded runs', findings: [], recommendedAction: 'none', reviewer: 'fixture-codex', reviewedAt: 1 });
  const runtime = new RuntimeOrchestrator({
    config: { agents: {} } as never,
    storeDir: join(cwd, '.store'),
    replaceAdapters: [
      createFakeAdapter({ id: AGENT_A, capabilities: CAPS, script: [{ kind: 'exit', code: 0 }] }),
      createFakeAdapter({ id: REVIEWER, capabilities: CAPS, script: [{ kind: 'frame', text: VERDICT, data: { text: VERDICT } }, { kind: 'exit', code: 0 }] }),
    ],
  });
  const drivable = {
    agentIds: () => [AGENT_A],
    descriptors: () => [AGENT_A].map((id) => ({ id, displayName: id, launcher: 'fake', transport: 'cli-jsonl', capabilities: { newTask: true, review: true, modelSelection: true, cwd: true, resume: true } } as never)),
    configFor: () => ({}),
    store: runtime.store,
    review: (req: Omit<RunRequest, 'mode'>) => { reviewRequests.push({ ...req, mode: 'review' } as RunRequest); return runtime.review(req); },
    run(req: RunRequest): RunHandle {
      requests.push(req);
      const runIdx = requests.length;
      const role = roleOf(req.prompt);
      let changedFiles: string[] = [];
      let output: string;
      if (role !== null) {
        const spec = ROLES.find((r) => r.role === role);
        const relPath = `${(spec?.scope ?? 'out')}/${role}.txt`;
        mkdirSync(join(cwd, relPath, '..'), { recursive: true });
        writeFileSync(join(cwd, relPath), `DELIVERY ${role} run=${runIdx}`, 'utf8');
        changedFiles = [relPath];
        output = `OUT_${role}: wrote ${relPath}`;
      } else { output = `run ${runIdx}: unknown shape`; }
      const toolCalls: ToolCall[] = changedFiles.map((p, i) => ({ name: 'write', callId: `c${runIdx}-${i}`, status: 'ok', input: { filePath: p }, output: 'written' }));
      const result: RunResult = {
        taskId: `t${runIdx}`, threadId: null, agentId: req.agentId, state: 'succeeded',
        startedAt: Date.now(), endedAt: Date.now(), exitCode: 0, signal: null,
        output, outputTruncated: false, transcriptPath: null, usage: {}, toolCalls, error: null, diagnostics: [],
        cleanup: { rootKilled: false, descendantsReaped: false, note: '', treeStopConfirmed: true, processStart: 'started' },
      };
      return { result: async () => result } as unknown as RunHandle;
    },
  };

  let pairQuestion = 0;
  let providerCalls = 0;
  const provider: DecisionProvider = {
    name: 'laya-stage-seam',
    async probe() { return { ok: true, endpoint: 'seam://laya', detail: 'test seam', warnings: [] }; },
    async decide(request) {
      providerCalls += 1;
      const answers: Record<string, unknown> = {};
      for (const [key, question] of Object.entries(request.questions)) {
        const criteria = (question.criteria ?? {}) as Record<string, string>;
        const offered = Object.keys(criteria);
        if (question.type === 'choice' && offered.length < 2) throw new Error(`question "${key}" offers exactly one choice`);
        const probabilities: Record<string, number> = {};
        const pick = (value: string) => { for (const o of offered) probabilities[o] = o === value ? 1 : 0; return { type: 'choice', choice: value, probabilities, confidence: 1 }; };
        if (key === ORCHESTRATION_ACTION_ID) {
          decisionRequests.push(request);
          const state = JSON.parse(String((request.state as Record<string, string> | undefined)?.[ORCHESTRATION_ACTION_ID] ?? '{}')) as { tasks?: Array<{ taskId: string; status: string }> };
          const tasks = state.tasks ?? [];
          const toVerify = tasks.find((t) => t.status === 'to_verify');
          const pending = tasks.find((t) => t.status === 'planned' || t.status === 'queued');
          let action = 'wait';
          const parameters: Record<string, string> = {};
          const rawMaterial = (request.state as Record<string, string> | undefined)?.[ACCEPTANCE_MATERIAL_FIELD];
          if (toVerify !== undefined && rawMaterial !== undefined) {
            const material = JSON.parse(rawMaterial) as { objective: string; entries: Array<{ taskId: string; acceptanceCriteria: string; output: string; executionMissing: boolean }> };
            const entry = material.entries.find((e) => e.taskId === toVerify.taskId);
            const token = entry === undefined ? '' : (entry.acceptanceCriteria.split(':: ')[1] ?? '').split(' —')[0] ?? '';
            const satisfies = entry !== undefined && material.objective.trim() !== '' && entry.acceptanceCriteria.trim() !== '' &&
              !entry.executionMissing && entry.output.trim() !== '' && entry.output.includes(token);
            if (satisfies && entry !== undefined) { action = 'complete'; parameters.taskId = entry.taskId; parameters.reason = 'material shows its own deliverable'; }
          } else if (toVerify === undefined && pending !== undefined) { action = 'continue'; }
          answers[key] = { ...pick(action), parameters };
          continue;
        }
        if (key === WORKFLOW_PLAN_ID) { answers[key] = pick(offered[0]!); continue; }
        if (key === INITIAL_AGENT_MODEL_ID) {
          const k = pairQuestion++;
          const order = [['agent-a', 'agent-a/m1'], ['agent-a', 'agent-a/m2']];
          const want = initialCandidateKey(order[k]![0], order[k]![1]);
          answers[key] = pick(offered.includes(want) ? want : offered[0]!);
          continue;
        }
        answers[key] = answerFor(key, question as { type: string; criteria: unknown });
      }
      return { answers, provider: { name: 'laya-stage-seam', details: 'stub Laya' }, raw: {} } as never;
    },
  };

  const argv = [
    opts.objective ?? 'add authentication to the users API',
    '--json', '--cwd', cwd,
    '--max-children', '4', '--max-concurrent', '2',
    '--workflow', 'sequential',
    ...(opts.planFile !== undefined ? ['--workflow-plan', 'plans.json'] : []),
    ...(opts.noStage === true ? [] : ['--stage', opts.stageArg ?? 'stage.json']),
    ...(opts.confirm !== undefined ? ['--confirm', opts.confirm] : []),
    ...(opts.stageCheck === true ? ['--stage-check'] : []),
    ...(opts.fixed !== undefined ? ['--select', 'fixed', '--agent', opts.fixed.agentId, '--model', opts.fixed.modelId] : []),
  ];
  const before = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => { captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true; }) as typeof process.stdout.write;
  let exitCode = -1;
  try {
    exitCode = await runRoundCli(drivable as never, argv, { provider, probes: [probeFor(AGENT_A, 'agent-a/m1'), probeFor(AGENT_A, 'agent-a/m2')], roundResultDir: reportDir });
  } finally {
    process.stdout.write = before;
  }
  const jsonStart = captured.indexOf('{');
  let report: Record<string, unknown> = {};
  if (jsonStart !== -1) { try { report = JSON.parse(captured.slice(jsonStart)); } catch { report = {}; } }
  return { report, requests, reviewRequests, decisionRequests, reportDir, cwd, exitCode, providerCalls };
}

const materialsOf = (r: Round): Array<{ objective: string }> => r.decisionRequests.map((req) => {
  const raw = (req.state as Record<string, string> | undefined)?.[ACCEPTANCE_MATERIAL_FIELD];
  return JSON.parse(String(raw ?? '{"objective":""}')) as { objective: string };
});

// =========================================================================
let fatal: unknown;
try {

// =========================================================================
section('1: the gate refuses BEFORE any call or task — missing material / confirmation / wrong stage');

{
  const noMaterial = await stageRound({ writeMaterial: false });
  check('missing material: refused at the stage gate, nothing ran, provider never called',
    noMaterial.report.stage === 'stage-gate' && noMaterial.requests.length === 0 && noMaterial.providerCalls === 0 && noMaterial.exitCode === 2,
    `stage=${String(noMaterial.report.stage)} req=${noMaterial.requests.length} provider=${noMaterial.providerCalls} exit=${noMaterial.exitCode}`);

  const noConfirm = await stageRound({ material: STAGE, planFile: SEQUENTIAL_PLAN });
  check('missing confirmation: refused, nothing ran, provider never called',
    noConfirm.report.stage === 'stage-gate' && /NOT confirmed/.test(String(noConfirm.report.error)) &&
      noConfirm.requests.length === 0 && noConfirm.providerCalls === 0 && noConfirm.exitCode === 2,
    `error=${String(noConfirm.report.error)} provider=${noConfirm.providerCalls}`);
  check('missing confirmation: the refusal names the pending item (the exact --confirm)',
    JSON.stringify(noConfirm.report.pending).includes(`--confirm ${digestOf(STAGE, SEQUENTIAL_PLAN)}`), JSON.stringify(noConfirm.report.pending));

  const wrongConfirm = await stageRound({ material: STAGE, confirm: digestOf({ ...STAGE, stageId: 'stage-2-other' }, SEQUENTIAL_PLAN), planFile: SEQUENTIAL_PLAN });
  check('confirmation for a DIFFERENT stage: refused, nothing ran',
    wrongConfirm.report.stage === 'stage-gate' && /does not match/.test(String(wrongConfirm.report.error)) &&
      wrongConfirm.requests.length === 0 && wrongConfirm.providerCalls === 0 && wrongConfirm.exitCode === 2,
    `error=${String(wrongConfirm.report.error)}`);

  const noTasks = await stageRound({ material: STAGE, planFile: SEQUENTIAL_PLAN });
  check('refusal creates NO task list and does not mark the product complete',
    noTasks.report.tasks === undefined && noTasks.report.ok !== true, `tasks=${String(noTasks.report.tasks)} ok=${String(noTasks.report.ok)}`);
}

// =========================================================================
section('2: a material cannot approve itself, and a model cannot approve it');

{
  const selfApproved = await stageRound({ material: { ...STAGE, approved: true }, confirm: digestOf(STAGE, SEQUENTIAL_PLAN), planFile: SEQUENTIAL_PLAN });
  check('self-approval: a material carrying "approved" is refused with a specific reason',
    selfApproved.report.stage === 'stage-gate' && /self-approval/.test(String(selfApproved.report.error)) &&
      selfApproved.requests.length === 0 && selfApproved.providerCalls === 0,
    String(selfApproved.report.error));

  // The provider is a MODEL stand-in; it is never consulted when the gate fails, so a model
  // (or any tool output) cannot grant approval.
  const modelClaim = await stageRound({ material: STAGE, planFile: SEQUENTIAL_PLAN });
  check('a model/tool cannot approve: the provider is never called without a user confirmation',
    modelClaim.providerCalls === 0 && modelClaim.requests.length === 0, `provider=${modelClaim.providerCalls}`);
}

// =========================================================================
section('3: --stage-check validates and prints the digest WITHOUT running anything');

{
  const r = await stageRound({ material: STAGE, planFile: SEQUENTIAL_PLAN, stageCheck: true });
  check('stage-check: reports ok + the digest, and runs nothing',
    r.report.stage === 'stage-check' && r.report.ok === true && r.report.digest === digestOf(STAGE, SEQUENTIAL_PLAN) &&
      r.requests.length === 0 && r.providerCalls === 0 && r.exitCode === 0,
    `stage=${String(r.report.stage)} digest=${String(r.report.digest)} exit=${r.exitCode}`);
}

// =========================================================================
section('4: a confirmed stage runs the REAL chain, and the material reaches the brief + acceptance');

{
  const r = await stageRound({ material: STAGE, confirm: digestOf(STAGE, SEQUENTIAL_PLAN), planFile: SEQUENTIAL_PLAN });
  check('confirmed: the plan executed and the round completed ok',
    r.requests.length === 2 && r.report.ok === true && r.report.executionIncomplete === false && r.exitCode === 0,
    `req=${r.requests.length} ok=${String(r.report.ok)} exit=${r.exitCode}`);
  check('confirmed: the stage steps wrote real owned files',
    existsSync(join(r.cwd, 'docs/api/api-research.txt')) && existsSync(join(r.cwd, 'src/server/server.txt')), filesUnder(r.cwd).join(','));
  // The stage requirement/scope/acceptance reach the ACTUAL task brief (via the objective).
  check('confirmed: the task brief carries the stage requirement + acceptance + material ref',
    r.requests.every((q) => q.prompt.includes('[stage stage-1-api') && q.prompt.includes('the API must authenticate requests') && q.prompt.includes('a request without a token is 401')),
    r.requests[0]!.prompt.slice(0, 300));
  // And the acceptance material request carries the same stage context.
  const materials = materialsOf(r).filter((m) => m.objective !== '');
  check('confirmed: the acceptance-material request carries the stage context too',
    materials.length > 0 && materials.every((m) => m.objective.includes('[stage stage-1-api')),
    JSON.stringify(materials.map((m) => m.objective.slice(0, 80))));
  check('confirmed: the round reached a real Review',
    r.reviewRequests.length === 1 && (r.report.unifiedReview as { status?: string } | undefined)?.status === 'completed',
    String((r.report.unifiedReview as { status?: string } | undefined)?.status));
}

// =========================================================================
section('5: a changed scope invalidates an old confirmation; the next stage does not auto-start');

{
  const oldDigest = digestOf(STAGE, SEQUENTIAL_PLAN);
  const changed = await stageRound({ material: { ...STAGE, scope: 'the whole service, not just the API' }, confirm: oldDigest });
  check('scope change: the OLD confirmation no longer matches the new material',
    changed.report.stage === 'stage-gate' && /does not match/.test(String(changed.report.error)) && changed.requests.length === 0,
    String(changed.report.error));

  const ok = await stageRound({ material: STAGE, confirm: oldDigest, planFile: SEQUENTIAL_PLAN });
  const gate = (ok.report.roundResult as { gate?: { automaticPostRoundAction?: string } } | undefined)?.gate;
  check('after the stage completes, automaticPostRoundAction is still NONE (no next stage)',
    ok.report.ok === true && gate?.automaticPostRoundAction === 'none', JSON.stringify(gate));
  check('a confirmed stage needs NO repeated per-task confirmation (one --confirm runs the whole plan)',
    ok.requests.length === 2 && ok.exitCode === 0, `req=${ok.requests.length}`);
}

// =========================================================================
section('6: the stage gate is opt-in — the built-in entry and fixed stay compatible');

{
  // Without --stage the round is byte-identical to before: the built-in full plan runs.
  const plain = await stageRound({ noStage: true, writeMaterial: false, planFile: SEQUENTIAL_PLAN });
  check('opt-in: without --stage the built-in/plan-file entry runs unchanged (no stage context)',
    plain.report.stage === 'complete' && plain.requests.length === 2 && plain.report.ok === true && plain.exitCode === 0 &&
      plain.requests.every((q) => !q.prompt.includes('[stage ')),
    `stage=${String(plain.report.stage)} req=${plain.requests.length} exit=${plain.exitCode}`);

  const fixed = await stageRound({ material: STAGE, confirm: digestOf(STAGE, SEQUENTIAL_PLAN), planFile: SEQUENTIAL_PLAN, fixed: { agentId: AGENT_A, modelId: 'agent-a/m1' } });
  check('fixed selection still enforced alongside a confirmed stage',
    fixed.requests.length === 2 && fixed.requests.every((q) => q.agentId === AGENT_A && q.model === 'agent-a/m1') && fixed.report.ok === true,
    fixed.requests.map((q) => `${q.agentId}/${q.model}`).join(','));
}

// =========================================================================
section('7: P2 — the decision note keeps dependency-waiting, capacity and refusals apart');

{
  const { applyDecision } = await import('../src/orchestration/decision.ts');
  const { buildDispatchReceipt } = await import('../src/orchestration/dispatch-receipt.ts');
  const apply = async (tick: { admitted: string[]; waiting: string[]; skipped: Array<{ taskId: string; code: string; reason: string }> }) =>
    applyDecision({ action: 'continue' }, {
      observation: { allTerminal: false } as never,
      dispatch: async () => buildDispatchReceipt({ tick: { ...tick, outcomes: [] }, dispatchedAt: Date.now() }),
    });

  const depOnly = await apply({ admitted: [], waiting: [], skipped: [{ taskId: 'w2', code: 'dependency-unmet', reason: 'waiting on w1' }] });
  check('P2 dependency-only: reported as WAITING, not as a gate refusal',
    (depOnly as { code?: string }).code === 'dependency-unmet' && /waiting on dependencies/.test((depOnly as { note: string }).note) &&
      !/gate refused/.test((depOnly as { note: string }).note),
    JSON.stringify(depOnly));

  const mixed = await apply({ admitted: [], waiting: [], skipped: [
    { taskId: 'w2', code: 'dependency-unmet', reason: 'waiting on w1' },
    { taskId: 'w3', code: 'resource-unavailable', reason: 'no isolated workspace for a second writer' },
  ] });
  check('P2 mixed: the MAIN code is the real refusal, and BOTH reasons are preserved',
    (mixed as { code?: string }).code === 'resource-unavailable' &&
      /gate refused/.test((mixed as { note: string }).note) && /w3/.test((mixed as { note: string }).note) &&
      /also waiting on dependencies/.test((mixed as { note: string }).note) && /w2/.test((mixed as { note: string }).note),
    JSON.stringify(mixed));

  const capacity = await apply({ admitted: [], waiting: ['w4'], skipped: [] });
  check('P2 capacity: still distinguished from a refusal',
    (capacity as { code?: string }).code === 'no-free-slot' && /no free slot/.test((capacity as { note: string }).note),
    JSON.stringify(capacity));
}

// =========================================================================
section('8: P1-1 — a confirmation is bound to the ACTUAL plan and scope');

{
  const digestA = digestOf(STAGE, SEQUENTIAL_PLAN);
  const otherPlan = {
    kind: 'sequential',
    plans: [{ id: 'unapproved-plan', label: 'research then implement', steps: SEQUENTIAL_PLAN.plans[0]!.steps }],
  };
  const changedDeliverable = {
    kind: 'sequential',
    plans: [{ id: 'stage-flow', label: 'research then implement', steps: [SEQUENTIAL_PLAN.plans[0]!.steps[0], { ...SEQUENTIAL_PLAN.plans[0]!.steps[1]!, deliverable: 'a DIFFERENT server change' }] }],
  };

  const otherId = await stageRound({ material: STAGE, confirm: digestA, planFile: otherPlan });
  check('P1-1: a confirmation for plan A does not run a DIFFERENT plan id',
    otherId.report.stage === 'stage-gate' && otherId.requests.length === 0 && otherId.exitCode === 2,
    `stage=${String(otherId.report.stage)} req=${otherId.requests.length}`);

  const changed = await stageRound({ material: STAGE, confirm: digestA, planFile: changedDeliverable });
  check('P1-1: the SAME plan id with a changed deliverable invalidates the old confirmation',
    changed.report.stage === 'stage-gate' && changed.requests.length === 0 && changed.exitCode === 2,
    `error=${String(changed.report.error)}`);

  const changedObjective = await stageRound({ material: STAGE, confirm: digestA, planFile: SEQUENTIAL_PLAN, objective: 'a DIFFERENT objective' });
  check('P1-1: a changed objective invalidates the old confirmation',
    changedObjective.report.stage === 'stage-gate' && changedObjective.requests.length === 0,
    String(changedObjective.report.error));

  // No planRef: the digest alone must still reject a different plan.
  const noRefMaterial = { stageId: 'stage-1-api', scope: STAGE.scope, requirement: STAGE.requirement, acceptance: STAGE.acceptance };
  const noRefDigest = digestOf(noRefMaterial, SEQUENTIAL_PLAN);
  const noRefOther = await stageRound({ material: noRefMaterial, confirm: noRefDigest, planFile: otherPlan });
  check('P1-1: without a planRef, the plan content is still bound by the digest',
    noRefOther.report.stage === 'stage-gate' && noRefOther.requests.length === 0, String(noRefOther.report.error));

  const ok = await stageRound({ material: STAGE, confirm: digestA, planFile: SEQUENTIAL_PLAN });
  check('P1-1: the CONFIRMED plan A runs normally', ok.requests.length === 2 && ok.report.ok === true && ok.exitCode === 0,
    `req=${ok.requests.length} ok=${String(ok.report.ok)}`);
}

// =========================================================================
section('9: P1-1 — a non-semantic format change does NOT change the confirmation object');

{
  // Key order and whitespace are irrelevant: both are parsed into the SAME typed plan.
  const reordered = { plans: SEQUENTIAL_PLAN.plans, kind: 'sequential' };
  check('P1-1: reordering JSON keys keeps the same digest',
    digestOf(STAGE, reordered) === digestOf(STAGE, SEQUENTIAL_PLAN), 'digest changed on key reorder');
  // stage-check shows the plan/scope summary and the same digest.
  const sc = await stageRound({ material: STAGE, planFile: SEQUENTIAL_PLAN, stageCheck: true });
  check('P1-1: stage-check shows the effective plan/scope and the binding digest',
    sc.report.stage === 'stage-check' && sc.report.digest === digestOf(STAGE, SEQUENTIAL_PLAN) &&
      JSON.stringify(sc.report.plan).includes('stage-flow') && sc.requests.length === 0,
    JSON.stringify(sc.report.plan));
}

// =========================================================================
section('10: P1-2 — a long material is delivered IN FULL (its critical tail is not truncated)');

{
  const CRITICAL = 'CRITICAL_DO_NOT_CHANGE_DATABASE_SCHEMA';
  const longRequirement = `${'preamble '.repeat(120)}${CRITICAL}`; // ~1000+ chars, tail is the constraint
  const material = { ...STAGE, requirement: longRequirement };
  const r = await stageRound({ material, confirm: digestOf(material, SEQUENTIAL_PLAN), planFile: SEQUENTIAL_PLAN });
  check('P1-2: the FULL requirement (including its tail) reaches every task brief',
    r.requests.length === 2 && r.requests.every((q) => q.prompt.includes(CRITICAL)),
    r.requests.map((q) => q.prompt.includes(CRITICAL)).join(','));
  check('P1-2: the full requirement also reaches the acceptance-material request',
    materialsOf(r).some((m) => m.objective.includes(CRITICAL)), 'tail missing from acceptance material');
  check('P1-2: the long material still completed the round', r.report.ok === true && r.exitCode === 0, `ok=${String(r.report.ok)}`);
}

// =========================================================================
section('11: P1-2 — a material too large to deliver is REFUSED before any write (no silent truncation)');

{
  // Each field is within the per-field limit, but the total exceeds what can be embedded.
  const big = { ...STAGE, requirement: 'a'.repeat(3500), acceptance: 'b'.repeat(3500) };
  const r = await stageRound({ material: big, confirm: 'irrelevant', planFile: SEQUENTIAL_PLAN });
  check('P1-2: an oversized material is refused with a specific reason and runtime=0',
    r.report.stage === 'stage-gate' && /too-large-to-embed/.test(String(r.report.error)) &&
      r.requests.length === 0 && r.providerCalls === 0 && r.exitCode === 2,
    `error=${String(r.report.error)} req=${r.requests.length}`);
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
