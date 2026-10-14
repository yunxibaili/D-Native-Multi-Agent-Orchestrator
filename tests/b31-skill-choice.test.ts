/**
 * tests/b31-skill-choice.test.ts — B3.1: the opt-in, advisory per-task NATIVE SKILL choice.
 *
 * WHAT IS REAL vs INJECTED
 * ------------------------
 * REAL: `runRoundCli` -> the skill-catalogue reader/validator -> the plan -> LAYA's initial
 * Agent x Model question -> Assignment -> the skill choice preset (`decideSkillChoice`) over
 * the SAME DecisionProvider -> `setTaskIntent` -> the decision loop -> `applyVerification`
 * -> the unified review -> the published round result -> the `report.skills` projection.
 *
 * INJECTED, and only these two: LAYA's ANSWERS, and the RUNTIME side of each run. The runtime
 * stub writes REAL FILES into the round's OWN working directory and emits real tool-call
 * records, so the skill OBSERVATION is exercised end to end (not asserted in the abstract).
 *
 * Run: node tests/b31-skill-choice.test.ts
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { runRoundCli } from '../src/cli/round-cli.ts';
import { Orchestrator as RuntimeOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { createFakeAdapter } from './helpers.ts';
import type { RunHandle, RunRequest, RunResult, ToolCall } from '../src/core/types.ts';
import type { DecisionProvider, DecisionRequest } from '../src/decision/types.ts';
import { INITIAL_AGENT_MODEL_ID, initialCandidateKey } from '../src/decision/initial-assignment.ts';
import { WORKFLOW_PLAN_ID } from '../src/decision/plan-choice.ts';
import { SKILL_CHOICE_ID, SKILL_NONE_KEY } from '../src/decision/skill-choice.ts';
import { ACCEPTANCE_MATERIAL_FIELD, ORCHESTRATION_ACTION_ID } from '../src/orchestration/decision-loop.ts';
import { observeNativeSkillCalls, parseSkillCatalog, projectSkillReport, SkillCatalogError } from '../src/orchestration/skill-catalog.ts';
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
function ownDir(): string { const d = mkdtempSync(join(tmpdir(), 'b31-')); tmpDirs.push(d); return d; }
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

const SKILL_REVIEW = { name: 'api-review', description: 'Review API contracts' };
const SKILL_PERF = { name: 'perf-tune', description: 'Tune hot paths' };
const TWO_SKILLS = [SKILL_REVIEW, SKILL_PERF];

const SEQUENTIAL_PLAN = {
  kind: 'sequential',
  plans: [{
    id: 'skill-flow', label: 'research then implement',
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
/** The skill the brief ASKED for, read from the rendered advisory section. */
function requestedSkillInPrompt(prompt: string): string | null {
  const m = /Requested skills[^\n]*\n(?:- ([a-z0-9-]+))/.exec(prompt);
  return m === null ? null : m[1]!;
}
/**
 * The collaboration prompt shape (same regexes b41 uses): a member carries its own role +
 * file scope, the integration task names which member's pair it reuses. Returns null for the
 * sequential/legacy prompts, so the two shapes never collide.
 */
function collaboratorOf(prompt: string): { kind: 'member'; index: number; role: string; scope: string } | { kind: 'integration'; token: string } | null {
  const m = /:: collaborator (\d+) \(([\w-]+)\) — file scope: (\S+) — deliverable:/.exec(prompt);
  if (m !== null) return { kind: 'member', index: Number(m[1]), role: m[2]!, scope: m[3]! };
  const i = /:: integration \(collaborator (\d+) carries integration responsibility\)/.exec(prompt);
  if (i !== null) return { kind: 'integration', token: `integration (collaborator ${i[1]} carries integration responsibility)` };
  return null;
}

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

interface Round {
  report: Record<string, unknown>;
  requests: RunRequest[];
  reviewRequests: RunRequest[];
  decisionRequests: DecisionRequest[];
  skillRequests: DecisionRequest[];
  reportDir: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  providerCalls: number;
}

const OBJECTIVE = 'add authentication to the users API';

async function skillRound(opts: {
  catalog?: unknown;
  rawCatalogText?: string;
  writeCatalog?: boolean;
  catalogArg?: string;
  noCatalogFlag?: boolean;
  workflow?: string | false;
  planFile?: unknown;
  noPlanFile?: boolean;
  /** B4.1: pin the built-in collaboration plan when `workflow: 'collaborate'`. */
  workflowChoice?: string;
  skillAnswer?: 'auto' | 'none' | 'throw' | 'missing' | 'invented' | string;
  skillsCapable?: boolean;
  catalogAgentId?: string;
  catalogSkills?: Array<{ name: string; description: string }>;
  native?: 'completed' | 'pending' | 'failed' | 'malformed' | 'text-only' | 'unrequested' | 'none';
  foreignRunIndex?: number;
  fixed?: { agentId: string; modelId: string };
  classifyOnly?: boolean;
  stageCheck?: boolean;
  stage?: unknown;
  confirm?: string;
  json?: boolean;
} = {}): Promise<Round> {
  const cwd = ownDir();
  const reportDir = join(ownDir(), 'reports');
  const writingCatalog = opts.noCatalogFlag !== true && opts.writeCatalog !== false;
  if (writingCatalog) {
    const catalogObj = opts.catalog !== undefined
      ? opts.catalog
      : { agentId: opts.catalogAgentId ?? AGENT_A, skills: opts.catalogSkills ?? TWO_SKILLS };
    writeFileSync(join(cwd, opts.catalogArg ?? 'catalog.json'), opts.rawCatalogText ?? JSON.stringify(catalogObj), 'utf8');
  }
  if (opts.noPlanFile !== true) {
    writeFileSync(join(cwd, 'plans.json'), JSON.stringify(opts.planFile ?? SEQUENTIAL_PLAN), 'utf8');
  }

  const requests: RunRequest[] = [];
  const reviewRequests: RunRequest[] = [];
  const decisionRequests: DecisionRequest[] = [];
  const skillRequests: DecisionRequest[] = [];
  const VERDICT = JSON.stringify({ verdict: 'pass', reason: 'fixture reviewer: deliveries meet the recorded runs', findings: [], recommendedAction: 'none', reviewer: 'fixture-codex', reviewedAt: 1 });
  const descriptors = [{
    id: AGENT_A, displayName: AGENT_A, launcher: 'fake', transport: 'cli-jsonl',
    capabilities: { newTask: true, review: true, modelSelection: true, cwd: true, resume: true, skills: opts.skillsCapable !== false },
  }];
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
    descriptors: () => descriptors as never,
    configFor: () => ({}),
    store: runtime.store,
    review: (req: Omit<RunRequest, 'mode'>) => { reviewRequests.push({ ...req, mode: 'review' } as RunRequest); return runtime.review(req); },
    run(req: RunRequest): RunHandle {
      requests.push(req);
      const runIdx = requests.length;
      const role = roleOf(req.prompt);
      const requestedSkill = requestedSkillInPrompt(req.prompt);
      let changedFiles: string[] = [];
      let output: string;
      const collab = collaboratorOf(req.prompt);
      if (collab !== null && collab.kind === 'member') {
        const relPath = `${collab.scope.replace(/\/?\*+$/, '')}/${collab.role}.txt`;
        mkdirSync(join(cwd, relPath, '..'), { recursive: true });
        writeFileSync(join(cwd, relPath), `DELIVERY ${collab.role} run=${runIdx}`, 'utf8');
        changedFiles = [relPath];
        output = `collaborator ${collab.index} (${collab.role}) wrote ${relPath}`;
      } else if (collab !== null && collab.kind === 'integration') {
        // The integrator READS the members' real files on disk and writes one combined
        // artifact whose output names the exact integration token its acceptance expects.
        const found = filesUnder(cwd).filter((f) => f.endsWith('.txt') && !f.startsWith('src/integration/'));
        const contents = found.map((f) => ({ file: f, text: readFileSync(join(cwd, f), 'utf8').trim() }));
        const combinedRel = 'src/integration/combined.txt';
        const combined = [`COMBINED RESULT objective=${OBJECTIVE}`, ...contents.map((c) => `from ${c.file}: ${c.text}`)].join('\n');
        mkdirSync(join(cwd, 'src/integration'), { recursive: true });
        writeFileSync(join(cwd, combinedRel), combined, 'utf8');
        changedFiles = [combinedRel, ...found];
        output = `${collab.token}: integrated ${contents.length} member file(s) [${found.join(', ')}]`;
      } else if (role !== null) {
        const spec = ROLES.find((r) => r.role === role);
        const relPath = `${(spec?.scope ?? 'out')}/${role}.txt`;
        mkdirSync(join(cwd, relPath, '..'), { recursive: true });
        writeFileSync(join(cwd, relPath), `DELIVERY ${role} run=${runIdx}`, 'utf8');
        changedFiles = [relPath];
        output = `OUT_${role}: wrote ${relPath}`;
      } else { output = `run ${runIdx}: unknown shape`; }

      const native = opts.native ?? 'completed';
      let skillTools: ToolCall[] = [];
      if (requestedSkill !== null) {
        if (native === 'completed') skillTools = [{ name: 'skill', callId: `sk${runIdx}`, status: 'completed', input: { name: requestedSkill }, output: 'loaded' }];
        else if (native === 'pending') skillTools = [{ name: 'skill', callId: `sk${runIdx}`, status: 'pending', input: { name: requestedSkill } }];
        else if (native === 'failed') skillTools = [{ name: 'skill', callId: `sk${runIdx}`, status: 'failed', input: { name: requestedSkill } }];
        else if (native === 'malformed') skillTools = [{ name: 'skill', callId: `sk${runIdx}`, status: 'completed', input: 'not-an-object' }];
        else if (native === 'unrequested') skillTools = [{ name: 'skill', callId: `sk${runIdx}`, status: 'completed', input: { name: 'totally-other' } }];
        else if (native === 'text-only') { output += `\nI used skill ${requestedSkill} (unstructured mention only)`; skillTools = []; }
        // 'none': no call
      } else if (native === 'unrequested') {
        skillTools = [{ name: 'skill', callId: `sk${runIdx}`, status: 'completed', input: { name: 'totally-other' } }];
      }
      const toolCalls: ToolCall[] = [
        ...changedFiles.map((p, i) => ({ name: 'write', callId: `c${runIdx}-${i}`, status: 'ok', input: { filePath: p }, output: 'written' })),
        ...skillTools,
      ];
      const result: RunResult = {
        taskId: `t${runIdx}`, threadId: null,
        agentId: runIdx === opts.foreignRunIndex ? 'foreign-agent' : req.agentId,
        state: 'succeeded',
        startedAt: Date.now(), endedAt: Date.now(), exitCode: 0, signal: null,
        output, outputTruncated: false, transcriptPath: null, usage: {}, toolCalls, error: null, diagnostics: [],
        cleanup: { rootKilled: false, descendantsReaped: false, note: '', treeStopConfirmed: true, processStart: 'started' },
      };
      return { result: async () => result } as unknown as RunHandle;
    },
  };

  let pairQuestion = 0;
  let skillPickCount = 0;
  let providerCalls = 0;
  const answerMode = opts.skillAnswer ?? 'auto';
  const provider: DecisionProvider = {
    name: 'laya-skill-seam',
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
        if (key === SKILL_CHOICE_ID) {
          skillRequests.push(request);
          if (answerMode === 'throw') throw new Error('skill provider exploded');
          if (answerMode === 'missing') continue;
          if (answerMode === 'invented') { answers[key] = { type: 'choice', choice: 'never-offered-skill', probabilities: {}, confidence: 1 }; continue; }
          if (answerMode === 'none') { answers[key] = pick(SKILL_NONE_KEY); continue; }
          if (answerMode !== 'auto') { answers[key] = pick(offered.includes(answerMode) ? answerMode : offered[0]!); continue; }
          const skillKeys = offered.filter((k) => k !== SKILL_NONE_KEY);
          const choice = skillKeys[Math.min(skillPickCount, skillKeys.length - 1)] ?? SKILL_NONE_KEY;
          skillPickCount += 1;
          answers[key] = pick(choice);
          continue;
        }
        answers[key] = answerFor(key, question as { type: string; criteria: unknown });
      }
      return { answers, provider: { name: 'laya-skill-seam', details: 'stub Laya' }, raw: {} } as never;
    },
  };

  const argv = [
    OBJECTIVE,
    ...(opts.json === false ? [] : ['--json']), '--cwd', cwd,
    '--max-children', '4', '--max-concurrent', '2',
    ...(opts.workflow === false ? [] : ['--workflow', opts.workflow ?? 'sequential']),
    ...(opts.workflowChoice !== undefined ? ['--workflow-choice', opts.workflowChoice] : []),
    ...(opts.noPlanFile === true ? [] : ['--workflow-plan', 'plans.json']),
    ...(opts.noCatalogFlag === true ? [] : ['--skill-catalog', opts.catalogArg ?? 'catalog.json']),
    ...(opts.classifyOnly === true ? ['--classify-only'] : []),
    ...(opts.stage !== undefined ? ['--stage', 'stage.json'] : []),
    ...(opts.confirm !== undefined ? ['--confirm', opts.confirm] : []),
    ...(opts.stageCheck === true ? ['--stage-check'] : []),
    ...(opts.fixed !== undefined ? ['--select', 'fixed', '--agent', opts.fixed.agentId, '--model', opts.fixed.modelId] : []),
  ];
  if (opts.stage !== undefined) writeFileSync(join(cwd, 'stage.json'), JSON.stringify(opts.stage), 'utf8');

  const beforeOut = process.stdout.write.bind(process.stdout);
  const beforeErr = process.stderr.write.bind(process.stderr);
  let captured = ''; let capturedErr = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => { captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => { capturedErr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true; }) as typeof process.stderr.write;
  let exitCode = -1;
  try {
    exitCode = await runRoundCli(drivable as never, argv, { provider, probes: [probeFor(AGENT_A, 'agent-a/m1'), probeFor(AGENT_A, 'agent-a/m2')], roundResultDir: reportDir });
  } finally {
    process.stdout.write = beforeOut;
    process.stderr.write = beforeErr;
  }
  const jsonStart = captured.indexOf('{');
  let report: Record<string, unknown> = {};
  if (jsonStart !== -1) { try { report = JSON.parse(captured.slice(jsonStart)); } catch { report = {}; } }
  return { report, requests, reviewRequests, decisionRequests, skillRequests, reportDir, cwd, exitCode, stdout: captured, stderr: capturedErr, providerCalls };
}

interface SkillEntry {
  taskId: string;
  requested: string | null;
  admitted: string | null;
  admittedMeaning: string;
  selectionSource: string;
  assignedAgentId: string;
  assignedModelId: string | null;
  observation: null | {
    source: string; note: string;
    runtime: { taskId: string | null; threadId: string | null; agentId: string | null };
    agentMatchesAssignment: boolean;
    skillCalls: Array<{ name: string; callId: string | null; equalsRequested: boolean }>;
  };
}

// =========================================================================
let fatal: unknown;
try {

// =========================================================================
section('0: the parser is total — bounds, unknown keys, duplicates, wrong types, empty legal');

{
  // The catalogue's agent id here is the SAME fake id the round uses. This section calls
  // `parseSkillCatalog` DIRECTLY — a pure parser, no runtime, no launch — so the value is
  // deliberately a fake identifier rather than a real executable name.
  const ok = parseSkillCatalog({ agentId: AGENT_A, skills: [SKILL_REVIEW] });
  check('valid catalogue parses', ok.agentId === AGENT_A && ok.skills.length === 1 && ok.skills[0]!.name === 'api-review');

  const empty = parseSkillCatalog({ agentId: AGENT_A, skills: [] });
  check('an empty skill array is legal', empty.skills.length === 0);

  const rejects = (raw: unknown, code: string): boolean => {
    try { parseSkillCatalog(raw); return false; } catch (e) { return e instanceof SkillCatalogError && e.code === code; }
  };
  check('unknown root key rejected', rejects({ agentId: 'a', skills: [], permissions: 'x' }, 'unknown-key'));
  check('unknown entry key (path) rejected', rejects({ agentId: 'a', skills: [{ name: 'x', description: 'd', path: 'p' }] }, 'unknown-key'));
  check('duplicate names rejected', rejects({ agentId: 'a', skills: [SKILL_REVIEW, SKILL_REVIEW] }, 'duplicate-name'));
  check('wrong description type rejected', rejects({ agentId: 'a', skills: [{ name: 'x', description: 5 }] }, 'invalid-description'));
  check('invalid name format rejected', rejects({ agentId: 'a', skills: [{ name: 'Bad_Name', description: 'd' }] }, 'invalid-name-format'));
  check('too many entries rejected', rejects({ agentId: 'a', skills: Array.from({ length: 17 }, (_, i) => ({ name: `s-${i}`, description: 'd' })) }, 'too-many-entries'));
  check('over-long description rejected', rejects({ agentId: 'a', skills: [{ name: 'x', description: 'd'.repeat(1025) }] }, 'description-too-long'));

  // observeNativeSkillCalls — only an exact, completed, structured call is an observation.
  const obs = observeNativeSkillCalls([
    { name: 'skill', status: 'completed', input: { name: 'api-review' } },
    { name: 'skill', status: 'pending', input: { name: 'api-review' } },
    { name: 'skill', status: 'failed', input: { name: 'api-review' } },
    { name: 'skill', status: 'completed', input: 'not-an-object' },
    { name: 'skill', status: 'completed', input: { name: 7 } },
    { name: 'read', status: 'completed', input: { name: 'api-review' } },
  ]);
  check('only an exact completed structured skill call is observed', obs.length === 1 && obs[0]!.name === 'api-review');
}

// =========================================================================
section('1: opt-in — without the flag no skill question is asked and no skill report exists');

{
  const plain = await skillRound({ noCatalogFlag: true });
  check('no flag: the round still completes normally', plain.report.stage === 'complete' && plain.exitCode === 0, `stage=${String(plain.report.stage)} exit=${plain.exitCode}`);
  check('no flag: the provider is NEVER asked a skill question', plain.skillRequests.length === 0, `skill=${plain.skillRequests.length}`);
  check('no flag: no task brief carries a Requested-skills section', plain.requests.every((q) => !q.prompt.includes('Requested skills')), plain.requests.map((q) => q.prompt.includes('Requested skills')).join(','));
  check('no flag: report.skills is absent', plain.report.skills === undefined && plain.report.skillCatalog === undefined);
}

// =========================================================================
section('2: a malformed / unreadable catalogue fails BEFORE any provider call or run');

{
  const missing = await skillRound({ writeCatalog: false });
  check('missing file: refused exit 2, nothing ran, provider never called',
    missing.report.stage === 'skill-catalog' && missing.exitCode === 2 && missing.requests.length === 0 && missing.providerCalls === 0 && missing.reviewRequests.length === 0,
    `stage=${String(missing.report.stage)} exit=${missing.exitCode} provider=${missing.providerCalls} req=${missing.requests.length}`);

  const badJson = await skillRound({ rawCatalogText: '{ this is not json' });
  check('invalid JSON: refused exit 2 before anything',
    badJson.report.stage === 'skill-catalog' && badJson.exitCode === 2 && badJson.providerCalls === 0 && badJson.requests.length === 0,
    `stage=${String(badJson.report.stage)} exit=${badJson.exitCode}`);

  const oversize = await skillRound({ rawCatalogText: JSON.stringify({ agentId: 'a', skills: [{ name: 'x', description: 'd'.repeat(33 * 1024) }] }) });
  check('oversize file: refused exit 2 before anything',
    oversize.report.stage === 'skill-catalog' && oversize.exitCode === 2 && oversize.providerCalls === 0,
    `stage=${String(oversize.report.stage)} exit=${oversize.exitCode}`);

  const unknownKey = await skillRound({ catalog: { agentId: 'a', skills: [], commands: ['rm -rf /'] } });
  check('unknown key (a command field): refused with a named reason, nothing ran',
    unknownKey.report.stage === 'skill-catalog' && unknownKey.exitCode === 2 && /unknown-key/.test(String(unknownKey.report.error)) && unknownKey.requests.length === 0,
    String(unknownKey.report.error));

  const legacy = await skillRound({ workflow: false });
  check('legacy (no workflow): the flag is rejected as a usage error before any call',
    legacy.exitCode === 2 && legacy.providerCalls === 0 && legacy.requests.length === 0,
    `exit=${legacy.exitCode} provider=${legacy.providerCalls}`);

  const classifyOnly = await skillRound({ classifyOnly: true });
  check('--classify-only + --skill-catalog: rejected before any call',
    classifyOnly.exitCode === 2 && classifyOnly.providerCalls === 0 && classifyOnly.requests.length === 0,
    `exit=${classifyOnly.exitCode} provider=${classifyOnly.providerCalls}`);
}

// =========================================================================
section('3: LAYA selects an offered skill; the brief carries the NAME, not the description or content');

{
  const r = await skillRound();
  const rows = (r.report.skills ?? []) as SkillEntry[];
  check('two initially assigned tasks each got exactly one skill question', r.skillRequests.length === 2, `skill=${r.skillRequests.length}`);
  check('the offered answer space is the explicit none PLUS both catalogue skills',
    r.skillRequests.every((q) => {
      const criteria = Object.keys((q.questions[SKILL_CHOICE_ID] as { criteria: Record<string, string> }).criteria);
      return criteria.includes(SKILL_NONE_KEY) && criteria.includes(SKILL_REVIEW.name) && criteria.includes(SKILL_PERF.name);
    }));
  check('the skill question carries the task identity + actual agent/model as context',
    r.skillRequests.every((q) => {
      const c = q.context as Record<string, string> | undefined;
      return c !== undefined && typeof c.taskId === 'string' && c.agentId === AGENT_A && typeof c.modelId === 'string';
    }), JSON.stringify(r.skillRequests[0]?.context));
  check('report.skills has one truthful row per task, chosen by LAYA and admitted to the brief',
    rows.length === 2 && rows.every((s) => s.selectionSource === 'laya' && s.requested !== null && s.admitted === s.requested),
    JSON.stringify(rows.map((s) => ({ req: s.requested, adm: s.admitted, src: s.selectionSource }))));
  // The brief of each task names ITS selected skill and nothing else from the catalogue.
  const t1 = r.requests.find((q) => requestedSkillInPrompt(q.prompt) === SKILL_REVIEW.name);
  const t2 = r.requests.find((q) => requestedSkillInPrompt(q.prompt) === SKILL_PERF.name);
  check('each brief carries the selected skill name in the advisory section', t1 !== undefined && t2 !== undefined,
    r.requests.map((q) => requestedSkillInPrompt(q.prompt)).join(','));
  check('the brief does NOT copy the catalogue description or the other skill name',
    t1 !== undefined && !t1.prompt.includes(SKILL_REVIEW.description) && !t1.prompt.includes(SKILL_PERF.name) && !t1.prompt.includes('Tune hot paths'),
    t1 === undefined ? 'no t1' : t1.prompt.slice(0, 400));
  check('report.skillCatalog records the candidates as USER-DECLARED, not discovered',
    (r.report.skillCatalog as { note?: string })?.note?.includes('USER-DECLARED') === true,
    JSON.stringify(r.report.skillCatalog));
  check('the runtime really wrote both task deliveries into the round\'s own directory',
    filesUnder(r.cwd).includes('docs/api/api-research.txt') && filesUnder(r.cwd).includes('src/server/server.txt'),
    filesUnder(r.cwd).join(','));
}

// =========================================================================
section('4: "explicit none" is honoured — no forced skill, no brief section');

{
  const r = await skillRound({ skillAnswer: 'none' });
  const rows = (r.report.skills ?? []) as SkillEntry[];
  check('provider chose none: the question was asked twice', r.skillRequests.length === 2, `skill=${r.skillRequests.length}`);
  check('provider chose none: requested AND admitted are null, source=laya',
    rows.length === 2 && rows.every((s) => s.requested === null && s.admitted === null && s.selectionSource === 'laya'),
    JSON.stringify(rows.map((s) => ({ req: s.requested, adm: s.admitted }))));
  check('provider chose none: no brief carries a Requested-skills section',
    r.requests.every((q) => !q.prompt.includes('Requested skills')));
  check('provider chose none: the round still completes', r.exitCode === 0, `exit=${r.exitCode}`);
}

// =========================================================================
section('5: a non-matching agent, an unsupported capability or an empty catalogue never route a skill');

{
  const otherAgent = await skillRound({ catalogAgentId: 'agent-b' });
  const otherRows = (otherAgent.report.skills ?? []) as SkillEntry[];
  check('catalogue for another agent: no skill question, explicit none by rule',
    otherAgent.skillRequests.length === 0 && otherRows.length === 2 && otherRows.every((s) => s.requested === null && s.selectionSource === 'rule'),
    `skill=${otherAgent.skillRequests.length}`);

  const noCap = await skillRound({ skillsCapable: false });
  const noCapRows = (noCap.report.skills ?? []) as SkillEntry[];
  check('agent without skills capability: no skill question, explicit none by rule',
    noCap.skillRequests.length === 0 && noCapRows.every((s) => s.requested === null && s.selectionSource === 'rule'),
    `skill=${noCap.skillRequests.length}`);

  const emptyCat = await skillRound({ catalogSkills: [] });
  const emptyRows = (emptyCat.report.skills ?? []) as SkillEntry[];
  check('empty catalogue: no skill question, explicit none by rule',
    emptyCat.skillRequests.length === 0 && emptyRows.every((s) => s.requested === null && s.selectionSource === 'rule'),
    `skill=${emptyCat.skillRequests.length}`);
}

// =========================================================================
section('6: a forged / missing / failed skill decision STOPS before any execution');

{
  for (const [label, mode] of [['forged (invented key)', 'invented'], ['missing answer', 'missing'], ['provider failure', 'throw']] as const) {
    const r = await skillRound({ skillAnswer: mode });
    check(`${label}: exit 1, stage skill-choice, nothing dispatched`,
      r.exitCode === 1 && r.report.stage === 'skill-choice' && r.requests.length === 0 && r.reviewRequests.length === 0,
      `exit=${r.exitCode} stage=${String(r.report.stage)} req=${r.requests.length}`);
  }
}

// =========================================================================
section('7: only a completed native skill tool-event is observed; nothing else is upgraded');

{
  const completed = await skillRound({ native: 'completed' });
  const rows = (completed.report.skills ?? []) as SkillEntry[];
  check('completed: the task\'s own run carries a completed skill observation',
    rows.length === 2 && rows.every((s) => s.observation !== null && s.observation!.skillCalls.length === 1 && s.observation!.skillCalls[0]!.equalsRequested === true),
    JSON.stringify(rows.map((s) => s.observation?.skillCalls)));
  check('completed: the observation names its runtime origin and is labelled a tool-event observation',
    rows.every((s) => s.observation!.source === 'latest-run tool-event observation' && s.observation!.runtime.taskId !== null && s.observation!.runtime.agentId === AGENT_A && /tool-event observation/.test(s.observation!.note)));

  for (const mode of ['pending', 'failed', 'malformed', 'text-only'] as const) {
    const r = await skillRound({ native: mode });
    const rrows = (r.report.skills ?? []) as SkillEntry[];
    check(`${mode}: NOT observed (no upgrade to a success)`,
      rrows.length === 2 && rrows.every((s) => s.observation !== null && s.observation!.skillCalls.length === 0),
      `mode=${mode} calls=${JSON.stringify(rrows.map((s) => s.observation?.skillCalls))}`);
  }

  const unreq = await skillRound({ native: 'unrequested' });
  const urRows = (unreq.report.skills ?? []) as SkillEntry[];
  check('an unrequested native skill call is reported as observed, never as requested',
    urRows.length === 2 && urRows.every((s) => s.observation!.skillCalls.length === 1 && s.observation!.skillCalls[0]!.name === 'totally-other' && s.observation!.skillCalls[0]!.equalsRequested === false && s.requested === s.admitted),
    JSON.stringify(urRows.map((s) => ({ requested: s.requested, calls: s.observation?.skillCalls }))));
}

// =========================================================================
section('8: per-task isolation; a foreign latest run is not attributed to the request');

{
  const r = await skillRound();
  const rows = (r.report.skills ?? []) as SkillEntry[];
  const first = rows[0]!;
  const second = rows[1]!;
  check('per-task isolation: each task observes ONLY its own selected skill',
    first.observation!.skillCalls[0]!.name === first.requested &&
    second.observation!.skillCalls[0]!.name === second.requested &&
    first.requested !== second.requested,
    JSON.stringify(rows.map((s) => ({ req: s.requested, obs: s.observation?.skillCalls[0]?.name }))));

  // A late run owned by a DIFFERENT agent: the request lives on the assignment, the
  // observation lives on the run, and the projection says the two do not match.
  const foreign = await skillRound({ foreignRunIndex: 2 });
  const fRows = (foreign.report.skills ?? []) as SkillEntry[];
  const foreignRow = fRows.find((s) => s.observation !== null && s.observation.runtime.agentId === 'foreign-agent');
  check('a foreign latest run is reported with its OWN agent and agentMatchesAssignment=false',
    foreignRow !== undefined && foreignRow.assignedAgentId === AGENT_A && foreignRow.observation!.agentMatchesAssignment === false,
    JSON.stringify(fRows.map((s) => ({ assigned: s.assignedAgentId, run: s.observation?.runtime.agentId, match: s.observation?.agentMatchesAssignment }))));
  check('a foreign latest run still keeps the REQUEST on its assigned agent (not attributed to the foreign run)',
    foreignRow !== undefined && foreignRow.requested === foreignRow.admitted && foreignRow.selectionSource === 'laya',
    JSON.stringify(foreignRow));
  // The cross-agent trap: a same-named call on the foreign run must NOT be labelled as the
  // request honoured, or the equality would read as "the wrong worker did the old request".
  check('a foreign latest run: its same-named skill call is NOT labelled equalsRequested',
    foreignRow !== undefined && foreignRow.observation!.skillCalls.length === 1 &&
      foreignRow.observation!.skillCalls[0]!.name === foreignRow.requested &&
      foreignRow.observation!.skillCalls[0]!.equalsRequested === false,
    JSON.stringify(foreignRow?.observation?.skillCalls));
  // ...and the NON-JSON output says so, naming the actual foreign runtime identity.
  const foreignHuman = await skillRound({ foreignRunIndex: 2, json: false });
  check('a foreign latest run: the non-JSON report prints an ORIGIN MISMATCH with the actual runtime agent',
    /ORIGIN MISMATCH/.test(foreignHuman.stdout) && /foreign-agent/.test(foreignHuman.stdout) &&
      /assigned to agent-a/.test(foreignHuman.stdout),
    foreignHuman.stdout.split('\n').filter((l) => /observed tool-events|ORIGIN MISMATCH/.test(l)).join(' | '));

  // The pure projection is the SAME code the CLI uses: prove the cross-agent honesty directly.
  const projected = projectSkillReport({
    taskId: 'x', requested: 'api-review', admitted: 'api-review', source: 'laya', reason: 'test',
    assignedAgentId: 'agent-a', assignedModelId: 'm1',
    run: {
      taskId: 'rt', threadId: 'th', agentId: 'agent-b', state: 'succeeded', startedAt: 0, endedAt: 0,
      exitCode: 0, signal: null, output: '', outputTruncated: false, transcriptPath: null, usage: {},
      toolCalls: [{ name: 'skill', status: 'completed', input: { name: 'api-review' } }], error: null, diagnostics: [],
      cleanup: { rootKilled: false, descendantsReaped: false, note: '', treeStopConfirmed: true, processStart: 'started' },
    },
  });
  check('direct projection: a different run agent is not attributed to the assignment',
    projected.observation !== null && projected.observation.agentMatchesAssignment === false && projected.observation.runtime.agentId === 'agent-b' && projected.requested === 'api-review');
  check('direct projection: a same-named call on the wrong agent is NOT equalsRequested',
    projected.observation!.skillCalls.length === 1 && projected.observation!.skillCalls[0]!.equalsRequested === false,
    JSON.stringify(projected.observation!.skillCalls));
}

// =========================================================================
section('9: existing protections stay intact — fixed selection + a confirmed stage still work');

{
  const fixed = await skillRound({ fixed: { agentId: AGENT_A, modelId: 'agent-a/m1' } });
  check('fixed selection: every run is on the pinned pair, and a skill was still chosen advisably',
    fixed.requests.length === 2 && fixed.requests.every((q) => q.agentId === AGENT_A && q.model === 'agent-a/m1') &&
      ((fixed.report.skills ?? []) as SkillEntry[]).every((s) => s.assignedAgentId === AGENT_A && s.assignedModelId === 'agent-a/m1'),
    fixed.requests.map((q) => `${q.agentId}/${q.model}`).join(','));

  // --stage-check is local: it must remain a zero-external-call path even with the flag.
  const { parseStageMaterial, stageBindingDigest } = await import('../src/orchestration/stage-material.ts');
  const { normalizedPlanScope } = await import('../src/cli/round-cli.ts');
  const stage = { stageId: 'stage-1', scope: 'the api', requirement: 'authenticate', acceptance: '401 without token', planRef: 'skill-flow' };
  const digest = stageBindingDigest({
    material: parseStageMaterial(stage), objective: OBJECTIVE, workflow: 'sequential',
    planRef: 'skill-flow', planScope: normalizedPlanScope('sequential', null),
  });
  const sc = await skillRound({ stage, confirm: digest, stageCheck: true });
  check('--stage-check with --skill-catalog: still zero provider calls and zero runs',
    sc.exitCode === 0 && sc.providerCalls === 0 && sc.requests.length === 0 && sc.reviewRequests.length === 0,
    `exit=${sc.exitCode} provider=${sc.providerCalls} req=${sc.requests.length}`);
}

// =========================================================================
section('10: collaborate duo — members AND the integrator each get their own advisory skill');

{
  // ONE hermetic duo through the REAL runRoundCli: two distinct member pairs, own sessions,
  // and the integrator reuses a designated member's pair. The catalogue is declared for the
  // single agent family, so EVERY initially assigned execution task (both members AND the
  // integrator) is offered the choice. Nothing here is a real model or a network call.
  const r = await skillRound({ workflow: 'collaborate', noPlanFile: true, workflowChoice: 'duo' });
  const rows = (r.report.skills ?? []) as SkillEntry[];
  const collab = r.report.collaboration as {
    choice: string;
    members: Array<{ taskId: string; agentId: string | null; modelId: string | null; sessionId: string | null }>;
    integrator: { index: number; taskId: string; memberTaskId: string; agentId: string | null; modelId: string | null; sessionId: string | null };
    integratorReusesMemberPair: boolean;
  };
  const integratorMember = collab.members[collab.integrator.index - 1]!;
  const memberIds = collab.members.map((m) => m.taskId);

  check('collab: the duo round completed normally (exit 0, stage complete, choice duo)',
    r.exitCode === 0 && r.report.stage === 'complete' && collab.choice === 'duo',
    `exit=${r.exitCode} stage=${String(r.report.stage)} choice=${collab.choice}`);

  // Every initially assigned EXECUTION task — both members AND the integrator — has a row.
  check('collab: one skill row per initially assigned execution task (2 members + the integrator)',
    rows.length === 3 && memberIds.every((id) => rows.some((s) => s.taskId === id)) &&
      rows.some((s) => s.taskId === collab.integrator.taskId),
    JSON.stringify(rows.map((s) => s.taskId)));
  check('collab: every row is a LAYA pick from the offered candidates, admitted to that task\'s brief',
    rows.every((s) => s.selectionSource === 'laya' && s.requested !== null && s.admitted === s.requested),
    JSON.stringify(rows.map((s) => ({ t: s.taskId, req: s.requested, src: s.selectionSource }))));
  check('collab: the provider was asked a skill question for all 3 execution tasks',
    r.skillRequests.length === 3, `skill=${r.skillRequests.length}`);

  // Each task's brief carries ITS OWN selected skill (member 1 from the no-dependency brief
  // override; member 2 and the integrator from the dispatch auto-brief).
  check('collab: every task brief names its own selected skill',
    r.requests.length === 3 && r.requests.every((q) => requestedSkillInPrompt(q.prompt) !== null),
    r.requests.map((q) => requestedSkillInPrompt(q.prompt)).join(','));

  // Origin is per task: each row observes the run of its OWN task, on its OWN assigned agent.
  check('collab: each skill row observes its own task\'s run and the runtime agent matches the assignment',
    rows.every((s) => s.observation !== null && s.observation!.agentMatchesAssignment === true &&
      s.observation!.runtime.agentId === s.assignedAgentId &&
      s.observation!.skillCalls.length === 1 && s.observation!.skillCalls[0]!.equalsRequested === true),
    JSON.stringify(rows.map((s) => ({ t: s.taskId, run: s.observation?.runtime.agentId, assigned: s.assignedAgentId }))));
  check('collab: the three observations come from three DIFFERENT runs (no cross-task attribution)',
    new Set(rows.map((s) => s.observation?.runtime.taskId)).size === 3,
    JSON.stringify(rows.map((s) => s.observation?.runtime.taskId)));

  // The integrator is NOT an extra worker: its pair is a selected member's own pair.
  check('collab: the integrator reuses a selected member\'s pair and gets its own task+session',
    collab.integratorReusesMemberPair === true &&
      collab.integrator.agentId === integratorMember.agentId && collab.integrator.modelId === integratorMember.modelId &&
      collab.integrator.taskId !== integratorMember.taskId && collab.integrator.sessionId !== integratorMember.sessionId,
    JSON.stringify({ integrator: collab.integrator, member: integratorMember }));
  check('collab: exactly 2 distinct assigned pairs across all 3 execution tasks (no fourth model)',
    new Set(rows.map((s) => `${s.assignedAgentId}/${s.assignedModelId}`)).size === 2,
    JSON.stringify(rows.map((s) => `${s.assignedAgentId}/${s.assignedModelId}`)));
  check('collab: exactly 3 runs, all on those 2 pairs',
    r.requests.length === 3 && new Set(r.requests.map((q) => `${q.agentId}/${q.model}`)).size === 2,
    r.requests.map((q) => `${q.agentId}/${q.model}`).join(','));
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
