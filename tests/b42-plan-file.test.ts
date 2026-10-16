/**
 * tests/b42-plan-file.test.ts â€?B4.2: the user-adaptable structured PLAN FILE drives the
 * EXISTING production chain, end to end.
 *
 * WHAT IS REAL vs INJECTED
 * ------------------------
 * REAL: `runRoundCli` -> `parsePlanFile` -> the shared candidate builder -> `planWithCandidates`
 * (`validateCandidateDag` + `commitPlan`) -> LAYA's initial Agent x Model question ->
 * Assignment -> SessionRegistry -> Scheduler -> `executeTask` -> AttemptStore -> the decision
 * loop -> `applyVerification` -> the unified review -> the published round result.
 *
 * INJECTED, and only these two: LAYA's ANSWERS (the real laya-serve is external), and the
 * RUNTIME side of each run. The runtime stub writes REAL FILES into the round's OWN working
 * directory and READS them back, so "the integrator consumed the members' deliveries" is a
 * disk fact, not a prompt string.
 *
 * Run: node tests/b42-plan-file.test.ts
 */

import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { runRoundCli } from '../src/cli/round-cli.ts';
import { Orchestrator as RuntimeOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { createFakeAdapter } from './helpers.ts';
import type { RunHandle, RunRequest, RunResult, ToolCall } from '../src/core/types.ts';
import type { DecisionProvider, DecisionRequest } from '../src/decision/types.ts';
import { INITIAL_AGENT_MODEL_ID, initialCandidateKey } from '../src/decision/initial-assignment.ts';
import { WORKFLOW_PLAN_ID } from '../src/decision/plan-choice.ts';
import { ACCEPTANCE_MATERIAL_FIELD, ORCHESTRATION_ACTION_ID } from '../src/orchestration/decision-loop.ts';
import {
  PLAN_FILE_MAX_PLANS, PLAN_FILE_MAX_STEPS, PLAN_FILE_MAX_TEXT,
  PlanFileError, chainDependencies, parsePlanFile,
} from '../src/orchestration/plan-file.ts';
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
function ownDir(): string { const d = mkdtempSync(join(tmpdir(), 'b42-')); tmpDirs.push(d); return d; }
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
const AGENT_B = 'agent-b';
const REVIEWER = 'codex';
const CAPS = { newTask: true, review: true, modelSelection: true, cwd: true, resume: true } as never;
const ROUTING_ANSWERS: Record<string, string> = { work_kind: 'implementation', complexity: 'small' };

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
    const index = Math.max(0, levels.indexOf(ROUTING_ANSWERS[id] ?? 'small'));
    const probabilities: Record<string, number> = {};
    for (let i = 0; i < levels.length; i++) probabilities[String(i)] = i === index ? 1 : 0;
    const legend: Record<string, string> = {};
    for (let i = 0; i < levels.length; i++) legend[String(i)] = levels[i]!;
    return { type: 'score', score: index, level: levels[index]!, levels: [...levels], probabilities, legend, confidence: 1 };
  }
  if (question.type === 'noul') return { type: 'noul', noul: 1 };
  return { type: question.type };
}

function probeFor(agentId: string, modelId: string, status: 'available' | 'not_fetched' = 'available'): QuotaProbe {
  return {
    agentId, provider: agentId,
    records: [{ provider: agentId, agentId, modelId: null, source: 'locally_observed', usage: null, remaining: null, resetAt: null, period: 'day', status, usageClass: 'observed', confidence: 'high', observedAt: Date.now(), note: '' }],
    login: 'stubbed for test', version: '0.0.0-test', modelHint: modelId, providerHint: null, error: null,
  } as unknown as QuotaProbe;
}

/** One role in the plan under test: its name and the file scope it must write into. */
interface RoleSpec { role: string; scope: string }

interface Round {
  report: Record<string, unknown>;
  requests: RunRequest[];
  reviewRequests: RunRequest[];
  decisionRequests: DecisionRequest[];
  reportDir: string;
  cwd: string;
  exitCode: number;
  maxConcurrentRuns: number;
  /** How many times LAYA was asked WHICH plan to use. */
  planQuestions: number;
  /** How many initial Agent x Model questions reached the provider. */
  initialQuestions: number;
}

/**
 * Identify which plan role a run belongs to, and whether it is the integration task.
 *
 * The prompt is `Work:\n<THIS task's criteria>\n...handoffs...`, so the CURRENT task's role
 * is the FIRST occurrence â€?a downstream brief echoes its dependencies' outputs (which may
 * themselves contain `collaborator N (role)`), so matching ANY occurrence would misattribute.
 */
function classifyPrompt(prompt: string, roles: readonly RoleSpec[]): { kind: 'step'; role: string; scope: string; collaborator: number | null } | { kind: 'integration'; token: string } | null {
  const integration = /:: integration \(collaborator (\d+) carries integration responsibility\)/.exec(prompt);
  if (integration !== null) return { kind: 'integration', token: `integration (collaborator ${integration[1]} carries integration responsibility)` };
  const collab = /:: collaborator (\d+) \(([\w-]+)\) â€?file scope:/.exec(prompt);
  if (collab !== null) {
    const role = collab[2]!;
    return { kind: 'step', role, collaborator: Number(collab[1]), scope: roles.find((r) => r.role === role)?.scope ?? role };
  }
  const seq = /:: ([\w-]+) â€?deliverable:/.exec(prompt);
  if (seq !== null) {
    const role = seq[1]!;
    return { kind: 'step', role, collaborator: null, scope: roles.find((r) => r.role === role)?.scope ?? role };
  }
  return null;
}

/**
 * Run ONE real production round with a plan file.
 *
 * `mode` selects `--workflow sequential|collaborate`; `planFile` is written verbatim into
 * the round's OWN cwd (so `--workflow-plan` resolves there). `roles` describes the steps so
 * the runtime stub knows which file each one writes. `planChoice` is what LAYA answers for
 * the plan question (or the pinned `--workflow-choice`).
 */
async function planRound(opts: {
  mode: 'sequential' | 'collaborate';
  planFile: unknown;
  roles: readonly RoleSpec[];
  planChoice?: string;
  pinChoice?: string;
  noDeliverableRole?: string;
  objective?: string;
  rawPlanFileText?: string;
  availablePairs?: readonly (readonly [string, string])[];
}): Promise<Round> {
  const cwd = ownDir();
  const reportDir = join(ownDir(), 'reports');
  const planPath = join(cwd, 'plans.json');
  writeFileSync(planPath, opts.rawPlanFileText ?? JSON.stringify(opts.planFile), 'utf8');

  const requests: RunRequest[] = [];
  const reviewRequests: RunRequest[] = [];
  const decisionRequests: DecisionRequest[] = [];
  const REVIEW_VERDICT_JSON = JSON.stringify({
    verdict: 'pass', reason: 'fixture reviewer: the plan file\'s deliveries meet the recorded runs',
    findings: [], recommendedAction: 'none', reviewer: 'fixture-codex', reviewedAt: 1,
  });
  const runtime = new RuntimeOrchestrator({
    config: { agents: {} } as never,
    // P0-1: the runtime's own store lives OUTSIDE the workspace, so its bookkeeping
    // files can never be mistaken for a change the worker made.
    storeDir: join(ownDir(), 'store'),
    replaceAdapters: [
      createFakeAdapter({ id: AGENT_A, capabilities: CAPS, script: [{ kind: 'exit', code: 0 }] }),
      createFakeAdapter({ id: AGENT_B, capabilities: CAPS, script: [{ kind: 'exit', code: 0 }] }),
      createFakeAdapter({ id: REVIEWER, capabilities: CAPS, script: [{ kind: 'frame', text: REVIEW_VERDICT_JSON, data: { text: REVIEW_VERDICT_JSON } }, { kind: 'exit', code: 0 }] }),
    ],
  });

  let inFlight = 0;
  let maxConcurrentRuns = 0;
  const drivable = {
    agentIds: () => [AGENT_A, AGENT_B],
    descriptors: () => [AGENT_A, AGENT_B].map((id) => ({ id, displayName: id, launcher: 'fake', transport: 'cli-jsonl', capabilities: { newTask: true, review: true, modelSelection: true, cwd: true, resume: true } } as never)),
    configFor: () => ({}),
    store: runtime.store,
    review: (req: Omit<RunRequest, 'mode'>) => { reviewRequests.push({ ...req, mode: 'review' } as RunRequest); return runtime.review(req); },
    run(req: RunRequest): RunHandle {
      requests.push(req);
      inFlight += 1;
      maxConcurrentRuns = Math.max(maxConcurrentRuns, inFlight);
      const runIdx = requests.length;
      const parsed = classifyPrompt(req.prompt, opts.roles);
      const noDeliverable = parsed !== null && parsed.kind === 'step' && parsed.role === opts.noDeliverableRole;

      let changedFiles: string[] = [];
      let output: string;
      if (noDeliverable) {
        // The REAL negative: the step RUNS and succeeds, but writes no file and no output.
        changedFiles = [];
        output = '';
      } else if (parsed !== null && parsed.kind === 'step') {
        const relPath = `${parsed.scope.replace(/\/+$/, '')}/${parsed.role}.txt`;
        mkdirSync(join(cwd, relPath, '..'), { recursive: true });
        const body = `DELIVERY role=${parsed.role} agent=${req.agentId} model=${String(req.model)} run=${runIdx}`;
        writeFileSync(join(cwd, relPath), body, 'utf8');
        changedFiles = [relPath];
        // The acceptance criteria are the task's OWN description. A collaboration member's
        // criteria token is `collaborator N (role)`, so the claimed output echoes it â€?this
        // is what the material-driven provider judges, exactly as in production.
        output = parsed.collaborator === null
          ? `OUT_${parsed.role}: wrote ${relPath}`
          : `collaborator ${parsed.collaborator} (${parsed.role}) wrote ${relPath}`;
      } else if (parsed !== null && parsed.kind === 'integration') {
        const found = filesUnder(cwd).filter((f) => f.endsWith('.txt') && !f.startsWith('src/integration/') && !f.endsWith('plans.json'));
        const contents = found.map((f) => ({ file: f, text: readFileSync(join(cwd, f), 'utf8').trim() }));
        const combinedRel = 'src/integration/combined.txt';
        mkdirSync(join(cwd, 'src/integration'), { recursive: true });
        writeFileSync(join(cwd, combinedRel), [
          `COMBINED objective=${String(opts.objective ?? 'b42')}`,
          ...contents.map((c) => `from ${c.file}: ${c.text}`),
        ].join('\n'), 'utf8');
        changedFiles = [combinedRel, ...found];
        output = `${parsed.token}: integrated ${contents.length} step file(s) [${found.join(', ')}]`;
      } else {
        output = `run ${runIdx}: unrecognised task shape`;
      }

      const toolCalls: ToolCall[] = changedFiles.map((p, i) => ({ name: 'write', callId: `c${runIdx}-${i}`, status: 'ok', input: { filePath: p }, output: 'written' }));
      const result: RunResult = {
        taskId: `t${runIdx}`, threadId: null, agentId: req.agentId,
        state: 'succeeded', startedAt: Date.now(), endedAt: Date.now(),
        exitCode: 0, signal: null, output, outputTruncated: false, transcriptPath: null,
        usage: {}, toolCalls, error: null, diagnostics: [],
        cleanup: { rootKilled: false, descendantsReaped: false, note: '', treeStopConfirmed: true, processStart: 'started' },
      };
      return { result: async () => { try { await new Promise((r) => setTimeout(r, 1)); return result; } finally { inFlight -= 1; } } } as unknown as RunHandle;
    },
  };

  let pairQuestion = 0;
  let planQuestions = 0;
  let initialQuestions = 0;
  const provider: DecisionProvider = {
    name: 'laya-planfile-seam',
    async probe() { return { ok: true, endpoint: 'seam://laya', detail: 'test seam', warnings: [] }; },
    async decide(request) {
      const answers: Record<string, unknown> = {};
      for (const [key, question] of Object.entries(request.questions)) {
        const criteria = (question.criteria ?? {}) as Record<string, string>;
        const offered = Object.keys(criteria);
        // The real provider refuses a single-option choice before sending; the fixture does too.
        if (question.type === 'choice' && offered.length < 2) {
          throw new Error(`question "${key}" offers exactly one choice, which a real provider refuses`);
        }
        const probabilities: Record<string, number> = {};
        const pick = (value: string) => {
          for (const o of offered) probabilities[o] = o === value ? 1 : 0;
          return { type: 'choice', choice: value, probabilities, confidence: 1 };
        };
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
            const token = entry === undefined ? '' : (entry.acceptanceCriteria.split(':: ')[1] ?? '').split(' â€?)[0] ?? '';
            const isIntegration = token.startsWith('integration (');
            const satisfies = entry !== undefined && material.objective.trim() !== '' &&
              entry.acceptanceCriteria.trim() !== '' && !entry.executionMissing && entry.output.trim() !== '' &&
              entry.output.includes(token) && (isIntegration ? /integrated [1-9]\d* step file/.test(entry.output) : true);
            if (satisfies && entry !== undefined) {
              action = 'complete';
              parameters.taskId = entry.taskId;
              parameters.reason = 'its own acceptance material shows its own deliverable';
            }
          } else if (toVerify === undefined && pending !== undefined) {
            action = 'continue';
          }
          answers[key] = { ...pick(action), parameters };
          continue;
        }
        if (key === WORKFLOW_PLAN_ID) {
          planQuestions += 1;
          answers[key] = pick(opts.planChoice !== undefined && offered.includes(opts.planChoice) ? opts.planChoice : offered[0]!);
          continue;
        }
        if (key === INITIAL_AGENT_MODEL_ID) {
          const k = pairQuestion++;
          initialQuestions += 1;
          const order = opts.availablePairs ?? [['agent-a', 'agent-a/m1'], ['agent-a', 'agent-a/m2'], ['agent-b', 'agent-b/m1']];
          const want = initialCandidateKey(order[k]![0], order[k]![1]);
          answers[key] = pick(offered.includes(want) ? want : offered[k] ?? offered[0]!);
          continue;
        }
        answers[key] = answerFor(key, question as { type: string; criteria: unknown });
      }
      return { answers, provider: { name: 'laya-planfile-seam', details: 'stub Laya' }, raw: {} } as never;
    },
  };

  const argv = [
    opts.objective ?? 'adapt the workflow to this project',
    '--json', '--cwd', cwd,
    '--max-children', '6', '--max-concurrent', '2',
    '--workflow', opts.mode,
    '--workflow-plan', 'plans.json',
    ...(opts.pinChoice !== undefined ? ['--workflow-choice', opts.pinChoice] : []),
  ];
  const before = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => { captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true; }) as typeof process.stdout.write;
  let exitCode = -1;
  try {
    exitCode = await runRoundCli(drivable as never, argv, {
      provider,
      probes: [probeFor(AGENT_A, 'agent-a/m1'), probeFor(AGENT_A, 'agent-a/m2'), probeFor(AGENT_B, 'agent-b/m1')],
      roundResultDir: reportDir,
    });
  } finally {
    process.stdout.write = before;
  }
  const jsonStart = captured.indexOf('{');
  let report: Record<string, unknown> = {};
  if (jsonStart !== -1) { try { report = JSON.parse(captured.slice(jsonStart)); } catch { report = {}; } }
  return { report, requests, reviewRequests, decisionRequests, reportDir, cwd, exitCode, maxConcurrentRuns, planQuestions, initialQuestions };
}

const wf = (r: Round): Record<string, unknown> => (r.report.workflow ?? {}) as Record<string, unknown>;
const collab = (r: Round): Record<string, unknown> => (r.report.collaboration ?? {}) as Record<string, unknown>;

/**
 * P0-1: a coding step must declare a completion contract. The fixture writes
 * `<scope>/<role>.txt` into the round's own directory, so the contract names exactly
 * that file, allows exactly that scope, and approves a trivial zero-exit command.
 */
function contractFor(role: string, fileScope: string) {
  const scope = fileScope.replace(/\/+$/, '');
  return {
    expectedArtifacts: [`${scope}/${role}.txt`],
    allowedScope: [scope],
    test: { executable: 'node', argv: ['-e', 'process.exit(0)'], cwd: '.' },
  };
}

const SEQUENTIAL_PLAN = {
  kind: 'sequential',
  plans: [{
    id: 'backend-flow',
    label: 'research the api, then implement the server, then run e2e',
    steps: [
      { role: 'api-research', taskType: 'research', fileScope: 'docs/api/**', deliverable: 'the api findings note' },
      { role: 'server', taskType: 'implementation', fileScope: 'src/server/**', deliverable: 'the server change', ...contractFor('server', 'src/server') },
      { role: 'e2e', taskType: 'test', fileScope: 'tests/e2e/**', deliverable: 'the e2e tests and their outcome', ...contractFor('e2e', 'tests/e2e') },
    ],
  }],
};
const SEQUENTIAL_ROLES: RoleSpec[] = [
  { role: 'api-research', scope: 'docs/api' },
  { role: 'server', scope: 'src/server' },
  { role: 'e2e', scope: 'tests/e2e' },
];

const DUO_PLAN = {
  kind: 'collaborate',
  plans: [{
    id: 'widget',
    label: 'build the component and the styles, the component integrates',
    members: [
      { role: 'component', taskType: 'implementation', fileScope: 'src/components/**', deliverable: 'the component', ...contractFor('component', 'src/components') },
      { role: 'styles', taskType: 'implementation', fileScope: 'src/styles/**', deliverable: 'the styles', ...contractFor('styles', 'src/styles') },
    ],
    integratorMember: 1,
  }],
};
const DUO_ROLES: RoleSpec[] = [
  { role: 'component', scope: 'src/components' },
  { role: 'styles', scope: 'src/styles' },
];

const TRIO_PLAN = {
  kind: 'collaborate',
  plans: [{
    id: 'service',
    label: 'interface + caller + tests, the caller integrates',
    members: [
      { role: 'iface', taskType: 'implementation', fileScope: 'src/iface/**', deliverable: 'the interface', ...contractFor('iface', 'src/iface') },
      { role: 'caller', taskType: 'implementation', fileScope: 'src/caller/**', deliverable: 'the caller', ...contractFor('caller', 'src/caller') },
      { role: 'specs', taskType: 'test', fileScope: 'tests/specs/**', deliverable: 'the specs and their outcome', ...contractFor('specs', 'tests/specs') },
    ],
    integratorMember: 2,
  }],
};
const TRIO_ROLES: RoleSpec[] = [
  { role: 'iface', scope: 'src/iface' },
  { role: 'caller', scope: 'src/caller' },
  { role: 'specs', scope: 'tests/specs' },
];

// =========================================================================
let fatal: unknown;
try {

// =========================================================================
section('1: a CUSTOM sequential plan runs in order and each step consumes the real upstream delivery');

{
  const r = await planRound({ mode: 'sequential', planFile: SEQUENTIAL_PLAN, roles: SEQUENTIAL_ROLES });
  const w = wf(r);
  check('seq: the report names the FILE plan and its mode',
    w.mode === 'sequential' && w.choice === 'backend-flow' && w.planFile === 'plans.json', JSON.stringify(w));
  check('seq: the report carries the plan\'s OWN roles/scopes/deliverables (not a built-in template)',
    Array.isArray(w.steps) &&
      (w.steps as Array<{ role: string; fileScope: string }>).map((s) => s.role).join(',') === 'api-research,server,e2e' &&
      (w.steps as Array<{ fileScope: string }>).every((s) => s.fileScope !== null),
    JSON.stringify(w.steps));
  process.stdout.write(`DEBUGSEQ report=${JSON.stringify(r.report)}\n`);
  check('seq: exactly three runs, in the declared order', r.requests.length === 3 &&
    r.requests[0]!.prompt.includes('api-research') && r.requests[1]!.prompt.includes('server') && r.requests[2]!.prompt.includes('e2e'),
    r.requests.map((q) => q.prompt.slice(0, 40)).join(' | '));
  check('seq: strictly sequential (max concurrency 1)', r.maxConcurrentRuns === 1, `max=${r.maxConcurrentRuns}`);
  check('seq: the downstream brief carries the UPSTREAM\'s actual output',
    r.requests[1]!.prompt.includes('OUT_api-research') && r.requests[2]!.prompt.includes('OUT_server'),
    `${r.requests[1]!.prompt.includes('OUT_api-research')} / ${r.requests[2]!.prompt.includes('OUT_server')}`);
  check('seq: the plan\'s file scope reached the acceptance criteria / brief',
    r.requests[1]!.prompt.includes('src/server/**'), r.requests[1]!.prompt.slice(0, 300));
  check('seq: every step wrote its OWN declared-scope file',
    existsSync(join(r.cwd, 'docs/api/api-research.txt')) && existsSync(join(r.cwd, 'src/server/server.txt')) && existsSync(join(r.cwd, 'tests/e2e/e2e.txt')),
    filesUnder(r.cwd).join(','));
  check('seq: the round completed and ok, exit 0', r.report.ok === true && r.report.executionIncomplete === false && r.exitCode === 0,
    `ok=${String(r.report.ok)} incomplete=${String(r.report.executionIncomplete)} exit=${r.exitCode}`);
  check('seq: a single offered plan is recorded by RULE â€?LAYA is never asked',
    r.planQuestions === 0 && String(w.source).includes('single candidate'), `planQuestions=${r.planQuestions} source=${String(w.source)}`);
}

// =========================================================================
section('2: a CUSTOM duo collaboration plan writes real files and integrates their actual bytes');

{
  const r = await planRound({ mode: 'collaborate', planFile: DUO_PLAN, roles: DUO_ROLES });
  const c = collab(r);
  const w = wf(r);
  check('duo: the report names the FILE plan and its two members',
    w.mode === 'collaborate' && w.choice === 'widget' && (c.members as unknown[]).length === 2, JSON.stringify(w.members));
  check('duo: the members are the plan\'s OWN roles', (c.members as Array<{ role: string }>).map((m) => m.role).join(',') === 'component,styles',
    JSON.stringify(c.members));
  const comp = join(r.cwd, 'src/components/component.txt');
  const styles = join(r.cwd, 'src/styles/styles.txt');
  check('duo: both members wrote their declared-scope files', existsSync(comp) && existsSync(styles), filesUnder(r.cwd).join(','));
  const combined = existsSync(join(r.cwd, 'src/integration/combined.txt')) ? readFileSync(join(r.cwd, 'src/integration/combined.txt'), 'utf8') : '';
  check('duo: the integration task combined the members\' ACTUAL bytes',
    combined.includes(readFileSync(comp, 'utf8').trim()) && combined.includes(readFileSync(styles, 'utf8').trim()),
    combined.replace(/\n/g, ' | '));
  const integrator = c.integrator as { memberTaskId: string; agentId: string; modelId: string; sessionId: string; taskId: string };
  const m1 = (c.members as Array<{ taskId: string; agentId: string; modelId: string; sessionId: string }>)[0]!;
  check('duo: the integrator reuses member 1\'s pair but has its OWN task + session',
    integrator.memberTaskId === m1.taskId && integrator.agentId === m1.agentId && integrator.modelId === m1.modelId &&
      integrator.taskId !== m1.taskId && integrator.sessionId !== m1.sessionId,
    JSON.stringify({ integrator, m1 }));
  check('duo: the whole round used exactly two distinct pairs',
    new Set(r.requests.map((q) => `${q.agentId}/${String(q.model)}`)).size === 2,
    r.requests.map((q) => `${q.agentId}/${q.model}`).join(','));
  const ur = r.report.unifiedReview as { status?: string; verdict?: unknown } | undefined;
  check('duo: the round reached a real Review and completed ok',
    r.reviewRequests.length === 1 && ur?.status === 'completed' && ur.verdict === 'pass' && r.report.ok === true && r.exitCode === 0,
    `status=${String(ur?.status)} ok=${String(r.report.ok)} exit=${r.exitCode}`);
  check('duo: a single offered plan is recorded by RULE (no LAYA question)', r.planQuestions === 0, `planQuestions=${r.planQuestions}`);
}

// =========================================================================
section('3: a CUSTOM trio sanity â€?distinct pairs, integrator inheritance, independent sessions');

{
  const r = await planRound({
    mode: 'collaborate', planFile: TRIO_PLAN, roles: TRIO_ROLES,
    availablePairs: [['agent-a', 'agent-a/m1'], ['agent-b', 'agent-b/m1'], ['agent-a', 'agent-a/m2']],
  });
  const c = collab(r);
  const members = c.members as Array<{ role: string; taskId: string; agentId: string; modelId: string; sessionId: string; status: string; pair: string }>;
  check('trio: three members with three DISTINCT pairs', members.length === 3 && c.pairIsDistinct === true,
    JSON.stringify(members.map((m) => `${m.role}:${m.pair}`)));
  check('trio: every member has its own task and session',
    new Set(members.map((m) => m.taskId)).size === 3 && new Set(members.map((m) => m.sessionId)).size === 3,
    JSON.stringify(members.map((m) => `${m.taskId}=${m.sessionId}`)));
  check('trio: all members + the integration task succeeded', members.every((m) => m.status === 'succeeded') && (c.integrator as { status: string }).status === 'succeeded',
    JSON.stringify(members.map((m) => m.status)));
  check('trio: the integrator is member 2 of the file plan', (c.integrator as { index: number }).index === 2, JSON.stringify(c.integrator));
  const combined = existsSync(join(r.cwd, 'src/integration/combined.txt')) ? readFileSync(join(r.cwd, 'src/integration/combined.txt'), 'utf8') : '';
  check('trio: the combined result carries all THREE members\' bytes',
    combined.includes('src/iface/iface.txt') && combined.includes('src/caller/caller.txt') && combined.includes('tests/specs/specs.txt'),
    combined.replace(/\n/g, ' | '));
  check('trio: 4 runs, sequential, ok, exit 0', r.requests.length === 4 && r.maxConcurrentRuns === 1 && r.report.ok === true && r.exitCode === 0,
    `n=${r.requests.length} ok=${String(r.report.ok)} exit=${r.exitCode}`);
}

// =========================================================================
section('4: illegal plan files are refused with NO partial commit');

{
  const reject = (raw: unknown, code: string, label: string): void => {
    let err: unknown = null;
    try { parsePlanFile(raw); } catch (e) { err = e; }
    check(`reject: ${label}`, err instanceof PlanFileError && err.code === code,
      err instanceof PlanFileError ? `${err.code}` : String(err));
  };
  const baseStep = (role: string) => ({
    role, taskType: 'implementation', deliverable: 'x',
    expectedArtifacts: ['s.txt'], allowedScope: ['s'], test: { executable: 'node', argv: ['-e', 'process.exit(0)'], cwd: '.' },
  });
  reject({ kind: 'sequential', plans: [{ id: 'a', label: 'a', steps: [baseStep('s1'), { ...baseStep('s2'), dependencies: ['ghost'] }] }] }, 'unknown-dependency', 'a dangling dependency');
  reject({ kind: 'sequential', plans: [{ id: 'a', label: 'a', steps: [{ ...baseStep('s1'), dependencies: ['s2'] }, { ...baseStep('s2'), dependencies: ['s1'] }] }] }, 'dependency-cycle', 'a dependency cycle');
  reject({ kind: 'sequential', plans: [{ id: 'a', label: 'a', steps: [baseStep('s1'), baseStep('s1')] }] }, 'duplicate-role', 'a duplicate role');
  reject({ kind: 'collaborate', plans: [{ id: 'a', label: 'a', members: [baseStep('m1'), baseStep('m2')], integratorMember: 3 }] }, 'invalid-integrator', 'an out-of-range integrator');
  reject({ kind: 'collaborate', plans: [{ id: 'a', label: 'a', members: [baseStep('m1'), baseStep('m2'), baseStep('m3'), baseStep('m4')], integratorMember: 1 }] }, 'invalid-member-count', 'four members');
  reject({ kind: 'sequential', plans: [{ id: 'a', label: 'a', steps: Array.from({ length: PLAN_FILE_MAX_STEPS + 1 }, (_, i) => baseStep(`s${i}`)) }] }, 'too-many-steps', 'too many steps');
  reject({ kind: 'sequential', plans: Array.from({ length: PLAN_FILE_MAX_PLANS + 1 }, (_, i) => ({ id: `p${i}`, label: 'l', steps: [baseStep('s')] })) }, 'too-many-plans', 'too many plans');
  reject({ kind: 'sequential', plans: [{ id: 'a', label: 'a', steps: [{ role: 's', taskType: 'deploy', deliverable: 'x' }] }] }, 'invalid-task-type', 'an unknown taskType');
  reject({ kind: 'sequential', plans: [{ id: 'a', label: 'a', steps: [baseStep('s')] }, { id: 'a', label: 'b', steps: [baseStep('s')] }] }, 'duplicate-plan-id', 'a duplicate plan id');
  reject({ kind: 'deploy', plans: [] }, 'invalid-kind', 'an unknown kind');
  reject({ kind: 'sequential', plans: [{ id: 'a', label: 'a', steps: [{ role: 's', taskType: 'implementation', deliverable: 'x'.repeat(PLAN_FILE_MAX_TEXT + 1) }] }] }, 'too-long', 'an over-long field');

  // End to end: a plan file with a dangling dependency is refused at the PLAN stage, and
  // NOTHING ran or was created.
  const bad = await planRound({
    mode: 'sequential', roles: SEQUENTIAL_ROLES,
    planFile: { kind: 'sequential', plans: [{ id: 'a', label: 'a', steps: [baseStep('s1'), { ...baseStep('s2'), dependencies: ['ghost'] }] }] },
  });
  check('reject: end-to-end the round is refused at the PLAN stage with a reason',
    bad.report.stage === 'plan' && /unknown-dependency/.test(String(bad.report.error)), `stage=${String(bad.report.stage)} error=${String(bad.report.error)}`);
  check('reject: NOTHING ran and no task list exists (no partial commit)',
    bad.requests.length === 0 && bad.report.tasks === undefined && bad.report.workflow === undefined,
    `requests=${bad.requests.length} tasks=${String(bad.report.tasks)}`);
  check('reject: the exit code is non-zero', bad.exitCode !== 0, `exit=${bad.exitCode}`);

  // A file whose kind does not match --workflow is refused too.
  const wrongKind = await planRound({ mode: 'sequential', roles: SEQUENTIAL_ROLES, planFile: DUO_PLAN });
  check('reject: a kind mismatch between the file and --workflow is refused, never swapped',
    wrongKind.report.stage === 'plan' && /kind "collaborate" but --workflow is "sequential"/.test(String(wrongKind.report.error)) && wrongKind.requests.length === 0,
    String(wrongKind.report.error));
}

// =========================================================================
section('5: a step that RAN but produced NO deliverable blocks integration (real negative)');

{
  const r = await planRound({ mode: 'collaborate', planFile: DUO_PLAN, roles: DUO_ROLES, noDeliverableRole: 'styles' });
  const c = collab(r);
  const members = c.members as Array<{ role: string; status: string; ran: boolean }>;
  const styles = members.find((m) => m.role === 'styles')!;
  check('negative: the styles member RAN but was never accepted', styles.ran === true && styles.status === 'to_verify',
    `ran=${String(styles.ran)} status=${styles.status}`);
  check('negative: it wrote NO delivery file', !existsSync(join(r.cwd, 'src/styles/styles.txt')), filesUnder(r.cwd).join(','));
  check('negative: the integration task NEVER ran and no combined file exists',
    (c.integrator as { ran: boolean }).ran === false && !existsSync(join(r.cwd, 'src/integration/combined.txt')),
    `ran=${String((c.integrator as { ran: boolean }).ran)}`);
  check('negative: the round is incomplete, non-zero exit, and names the blocker',
    r.report.ok === false && r.report.executionIncomplete === true && r.exitCode !== 0 &&
      JSON.stringify(wf(r).pending).includes((styles as unknown as { taskId: string }).taskId) &&
      JSON.stringify(wf(r).pending).includes('to_verify'),
    `ok=${String(r.report.ok)} exit=${r.exitCode} pending=${JSON.stringify(wf(r).pending)}`);
}

// =========================================================================
section('6: compatibility â€?the built-in entry and fixed constraints are untouched');

{
  // No plan file: the built-in full/lean plans still work (a custom file is OPT-IN).
  const builtIn = await planRound({
    mode: 'sequential', roles: [{ role: 'research', scope: 'x' }, { role: 'implementation', scope: 'y' }, { role: 'test', scope: 'z' }],
    planFile: { kind: 'sequential', plans: [{ id: 'only', label: 'only', steps: [
      { role: 'research', taskType: 'research', deliverable: 'd' },
      { role: 'implementation', taskType: 'implementation', deliverable: 'd', ...contractFor('implementation', 'y') },
      { role: 'test', taskType: 'test', deliverable: 'd', ...contractFor('test', 'z') },
    ] }] },
    pinChoice: 'only',
  });
  check('compat: a pinned FILE plan id is accepted and recorded as pinned',
    wf(builtIn).choice === 'only' && String(wf(builtIn).source).includes('pinned') && builtIn.planQuestions === 0,
    JSON.stringify({ choice: wf(builtIn).choice, source: wf(builtIn).source, q: builtIn.planQuestions }));

  // A pinned id that the file does NOT offer is a refusal, not a fallback.
  const badPin = await planRound({ mode: 'sequential', planFile: SEQUENTIAL_PLAN, roles: SEQUENTIAL_ROLES, pinChoice: 'duo' });
  check('compat: an unknown pinned id is refused, never silently replaced',
    badPin.report.stage === 'plan' && /is not one of the offered plans/.test(String(badPin.report.error)) && badPin.requests.length === 0,
    String(badPin.report.error));
}

// =========================================================================
section('7: explicit dependencies:[] is a SEQUENTIAL workflow â€?independent writes run, not stall');

{
  // B4.2a: the exact shape the audit found. Two steps with `dependencies: []` used to be
  // BOTH ready in one tick, so the shared non-git workspace could not isolate two writers
  // and both were refused `resource-unavailable` after being committed and assigned.
  const independent = {
    kind: 'sequential',
    plans: [{
      id: 'independent', label: 'two independent writes',
      steps: [
        { role: 'one', taskType: 'implementation', fileScope: 'src/one', deliverable: 'one file', dependencies: [], ...contractFor('one', 'src/one') },
        { role: 'two', taskType: 'implementation', fileScope: 'src/two', deliverable: 'two file', dependencies: [], ...contractFor('two', 'src/two') },
      ],
    }],
  };
  // The chain rule, checked directly: step 2 carries step 1 as an EXECUTION dependency even
  // though the user declared none. Business deps are preserved, execution order is added.
  const chained = chainDependencies((parsePlanFile(independent).plans[0] as unknown as { steps: never }).steps);
  check('indep: the effective graph chains step 2 behind step 1 (declared [] preserved, order added)',
    chained.length === 2 && chained[0]!.length === 0 && chained[1]!.length === 1 && chained[1]![0] === 'one',
    JSON.stringify(chained));

  const r = await planRound({
    mode: 'sequential', planFile: independent,
    roles: [{ role: 'one', scope: 'src/one' }, { role: 'two', scope: 'src/two' }],
  });
  check('indep: both independent writes RAN (no stall)', r.requests.length === 2, `n=${r.requests.length}`);
  check('indep: only ONE writer ran at a time (max effective writers=1)', r.maxConcurrentRuns === 1, `max=${r.maxConcurrentRuns}`);
  check('indep: step 2\'s brief carries step 1\'s ACTUAL output', r.requests[1]!.prompt.includes('OUT_one'), r.requests[1]!.prompt.slice(0, 200));
  check('indep: both owned files were written',
    existsSync(join(r.cwd, 'src/one/one.txt')) && existsSync(join(r.cwd, 'src/two/two.txt')), filesUnder(r.cwd).join(','));
  check('indep: the round completed, ok, exit 0', r.report.ok === true && r.report.executionIncomplete === false && r.exitCode === 0,
    `ok=${String(r.report.ok)} incomplete=${String(r.report.executionIncomplete)} exit=${r.exitCode} stop=${String(wf(r).stop)}`);
}

// =========================================================================
section('8: explicit dependencies:[] members in a collaboration plan also run in order');

{
  const indepDuo = {
    kind: 'collaborate',
    plans: [{
      id: 'indep-widget', label: 'two independent members, the first integrates',
      members: [
        { role: 'left', taskType: 'implementation', fileScope: 'src/left', deliverable: 'left', dependencies: [], ...contractFor('left', 'src/left') },
        { role: 'right', taskType: 'implementation', fileScope: 'src/right', deliverable: 'right', dependencies: [], ...contractFor('right', 'src/right') },
      ],
      integratorMember: 1,
    }],
  };
  const r = await planRound({
    mode: 'collaborate', planFile: indepDuo,
    roles: [{ role: 'left', scope: 'src/left' }, { role: 'right', scope: 'src/right' }],
  });
  const c = collab(r);
  check('indep-duo: both members ran and succeeded',
    (c.members as Array<{ status: string }>).every((m) => m.status === 'succeeded') && (c.integrator as { status: string }).status === 'succeeded',
    JSON.stringify((c.members as Array<{ status: string }>).map((m) => m.status)));
  const combined = existsSync(join(r.cwd, 'src/integration/combined.txt')) ? readFileSync(join(r.cwd, 'src/integration/combined.txt'), 'utf8') : '';
  check('indep-duo: the integration consumed BOTH members\' actual bytes',
    combined.includes(readFileSync(join(r.cwd, 'src/left/left.txt'), 'utf8').trim()) &&
      combined.includes(readFileSync(join(r.cwd, 'src/right/right.txt'), 'utf8').trim()),
    combined.replace(/\n/g, ' | '));
  check('indep-duo: sequential, ok, exit 0', r.maxConcurrentRuns === 1 && r.report.ok === true && r.exitCode === 0,
    `max=${r.maxConcurrentRuns} ok=${String(r.report.ok)} exit=${r.exitCode}`);
}

// =========================================================================
section('9: forward legal dependencies run; a mixed explicit+default cycle is refused before any write');

{
  // A forward edge (step 3 also depends on step 1) is legal and preserved on top of the chain.
  const forward = {
    kind: 'sequential',
    plans: [{
      id: 'forward', label: 'a -> b -> c, c also depends on a',
      steps: [
        { role: 'a', taskType: 'implementation', fileScope: 'src/a', deliverable: 'a', ...contractFor('a', 'src/a') },
        { role: 'b', taskType: 'implementation', fileScope: 'src/b', deliverable: 'b', ...contractFor('b', 'src/b') },
        { role: 'c', taskType: 'implementation', fileScope: 'src/c', deliverable: 'c', dependencies: ['a'], ...contractFor('c', 'src/c') },
      ],
    }],
  };
  const r = await planRound({ mode: 'sequential', planFile: forward, roles: [{ role: 'a', scope: 'src/a' }, { role: 'b', scope: 'src/b' }, { role: 'c', scope: 'src/c' }] });
  check('forward: a legal forward dependency is handled and the chain completes',
    r.requests.length === 3 && r.report.ok === true && r.exitCode === 0, `n=${r.requests.length} ok=${String(r.report.ok)}`);

  // A backward edge (step 1 depends on step 2) only closes a loop ONCE the chain is added.
  const mixedCycle = {
    kind: 'sequential',
    plans: [{
      id: 'loop', label: 'step 1 depends on step 2 (a cycle through the chain)',
      steps: [
        { role: 's1', taskType: 'implementation', fileScope: 'src/s1', deliverable: 's1', dependencies: ['s2'], ...contractFor('s1', 'src/s1') },
        { role: 's2', taskType: 'implementation', fileScope: 'src/s2', deliverable: 's2', ...contractFor('s2', 'src/s2') },
      ],
    }],
  };
  let cycleErr: unknown = null;
  try { parsePlanFile(mixedCycle); } catch (e) { cycleErr = e; }
  check('mixed-cycle: rejected as a cycle BEFORE write (chain-aware)',
    cycleErr instanceof PlanFileError && cycleErr.code === 'dependency-cycle', cycleErr instanceof PlanFileError ? cycleErr.code : String(cycleErr));
  const refused = await planRound({ mode: 'sequential', planFile: mixedCycle, roles: [{ role: 's1', scope: 'src/s1' }, { role: 's2', scope: 'src/s2' }] });
  check('mixed-cycle: end-to-end refusal with NO partial commit',
    refused.report.stage === 'plan' && refused.requests.length === 0 && refused.report.tasks === undefined && refused.exitCode !== 0,
    `stage=${String(refused.report.stage)} requests=${refused.requests.length} exit=${refused.exitCode}`);
}

// =========================================================================
section('10: the decision note preserves the ACTUAL gate refusal, not a generic claim');

{
  const { applyDecision } = await import('../src/orchestration/decision.ts');
  const { buildDispatchReceipt } = await import('../src/orchestration/dispatch-receipt.ts');
  const apply = async (tick: { admitted: string[]; waiting: string[]; skipped: Array<{ taskId: string; code: string; reason: string }> }) => {
    const receipt = buildDispatchReceipt({ tick: { ...tick, outcomes: [] }, dispatchedAt: Date.now() });
    return applyDecision({ action: 'continue' }, { observation: { allTerminal: false } as never, dispatch: async () => receipt });
  };

  const refused = await apply({ admitted: [], waiting: [], skipped: [{ taskId: 'round-x-w2', code: 'resource-unavailable', reason: 'no isolated workspace for a second writer' }] });
  check('note: a real gate refusal is NAMED (task + code + reason), never erased',
    refused.applied === true && (refused as { code?: string }).code === 'resource-unavailable' &&
      (refused as { note: string }).note.includes('resource-unavailable') && (refused as { note: string }).note.includes('round-x-w2'),
    JSON.stringify(refused));
  check('note: the old "nothing was denied by the gate" wording is GONE when something was denied',
    !(refused as { note: string }).note.includes('nothing was denied by the gate'), (refused as { note: string }).note);

  const waiting = await apply({ admitted: [], waiting: ['round-x-w3'], skipped: [] });
  check('note: "waiting for capacity" is distinguished from a refusal',
    (waiting as { code?: string }).code === 'no-free-slot' && (waiting as { note: string }).note.includes('no free slot'), JSON.stringify(waiting));

  const idle = await apply({ admitted: [], waiting: [], skipped: [] });
  check('note: only when NOTHING was denied does it say so',
    (idle as { code?: string }).code === undefined && (idle as { note: string }).note.includes('nothing was denied by the gate'), JSON.stringify(idle));

  const admitted = await apply({ admitted: ['round-x-w1'], waiting: [], skipped: [] });
  check('note: an admitted dispatch still reports a dispatch', (admitted as { dispatched: boolean }).dispatched === true, JSON.stringify(admitted));
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

