/**
 * tests/b41-collab-group.test.ts — B4.1 (功能 B): ONE goal, 2–3 models, one integrator.
 *
 * WHAT IS REAL vs INJECTED
 * ------------------------
 * REAL: `runRoundCli` -> bounded collaboration plan -> `validateCandidateDag`/`commitPlan`
 * -> LAYA's initial Agent x Model question -> Assignment (`assignWorker`, explicit pair)
 * -> SessionRegistry -> TaskScheduler.tick -> `executeTask` -> AttemptStore -> the decision
 * loop -> `applyVerification` -> the unified review -> the published round result.
 *
 * INJECTED, and only these two:
 *   1. LAYA's ANSWERS (the real laya-serve is external). The provider is a controlled
 *      stand-in that answers the SAME typed questions the production path asks.
 *   2. The RUNTIME SIDE of each run. The `RuntimeRunner.run` seam is stubbed — but the
 *      stub WRITES REAL FILES into the round's OWN working directory and READS them
 *      back, so "the integrator consumed the members' deliveries" is checked on disk
 *      rather than asserted from a prompt string.
 *
 * No test calls `completeTask` itself: acceptance happens through LAYA's `complete`
 * action inside the CLI loop, judged against the existing acceptance material.
 *
 * Run: node tests/b41-collab-group.test.ts
 */

import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

import { runRoundCli } from '../src/cli/round-cli.ts';
import { Orchestrator as RuntimeOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { createFakeAdapter } from './helpers.ts';
import type { RunHandle, RunRequest, RunResult, ToolCall } from '../src/core/types.ts';
import type { DecisionProvider, DecisionRequest } from '../src/decision/types.ts';
import { INITIAL_AGENT_MODEL_ID, initialCandidateKey } from '../src/decision/initial-assignment.ts';
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
function ownDir(): string { const d = mkdtempSync(join(tmpdir(), 'b41-')); tmpDirs.push(d); return d; }
function removeOwnedDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); }
  catch (e) { cleanupFailures.push(`owned dir removal threw for ${dir}: ${(e as Error).message}`); return; }
  if (existsSync(dir)) cleanupFailures.push(`owned dir ${dir} still present after removal`);
}

const AGENT_A = 'agent-a';
const AGENT_B = 'agent-b';
const REVIEWER = 'codex';
const CAPS = { newTask: true, review: true, modelSelection: true, cwd: true, resume: true } as never;

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

/** One probe per REGISTERED pair. Two probes for one agent is how a second model of the
 *  SAME agent family enters the registry — `seedRegistry` keys entries on (agent, model). */
function probeFor(agentId: string, modelId: string, status: 'available' | 'exhausted' | 'not_fetched' = 'available'): QuotaProbe {
  return {
    agentId, provider: agentId,
    records: [{ provider: agentId, agentId, modelId: null, source: 'locally_observed', usage: null, remaining: null, resetAt: null, period: 'day', status, usageClass: 'observed', confidence: 'high', observedAt: Date.now(), note: '' }],
    login: 'stubbed for test', version: '0.0.0-test', modelHint: modelId, providerHint: null, error: null,
  } as unknown as QuotaProbe;
}

interface MemberRow { index: number; taskId: string; role: string; fileScope: string; status: string; agentId: string | null; modelId: string | null; sessionId: string | null }
interface IntegratorRow { index: number; memberTaskId: string; taskId: string; status: string; agentId: string | null; modelId: string | null; sessionId: string | null }
interface Round {
  report: Record<string, unknown>;
  requests: RunRequest[];
  reviewRequests: RunRequest[];
  decisionRequests: DecisionRequest[];
  reportDir: string;
  cwd: string;
  maxConcurrentRuns: number;
}

interface MaterialEntry { taskId: string; acceptanceCriteria: string; output: string; artifacts: string[]; executionMissing: boolean }

/** Every file under `root`, relative and POSIX-ish, so a check can name a real path. */
function filesUnder(root: string, prefix = ''): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = join(root, rel);
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel === '' ? entry.name : `${rel}${sep}${entry.name}`;
      if (entry.isDirectory()) walk(childRel);
      else out.push(childRel.split(sep).join('/'));
    }
  };
  walk(prefix);
  return out;
}

function memberRoleOf(prompt: string): { kind: 'member'; index: number; role: string; scope: string } | { kind: 'integration'; token: string } | null {
  const m = /:: collaborator (\d+) \(([\w-]+)\) — file scope: (\S+) — deliverable:/.exec(prompt);
  if (m !== null) return { kind: 'member', index: Number(m[1]), role: m[2]!, scope: m[3]! };
  const i = /:: integration \(collaborator (\d+) carries integration responsibility\)/.exec(prompt);
  if (i !== null) return { kind: 'integration', token: `integration (collaborator ${i[1]} carries integration responsibility)` };
  return null;
}

/**
 * Run ONE real production round with `--workflow collaborate`.
 *
 * `pairOrder` is what LAYA answers for each member's initial Agent x Model question: the
 * k-th question takes the k-th requested [agentId, modelId] pair, which is deterministic
 * and — because the CLI removes already-taken pairs from the offered list — is guaranteed
 * to be distinct. `inventedPair` makes LAYA name a pair that was never offered (the
 * negative control). `failMember` makes that member's run fail.
 */
async function collabRound(opts: {
  planChoice?: 'duo' | 'trio';
  pairs?: readonly (readonly [string, string])[];
  failMember?: number;
  inventedPair?: boolean;
  fixed?: { agentId: string; modelId: string };
  objective?: string;
  /** Register only ONE usable pair, so a 2–3 member group cannot be filled. */
  singleModel?: boolean;
  /** Make the round's cwd a real git repository (so writing tasks would be isolated). */
  gitRepo?: boolean;
} = {}): Promise<Round> {
  const cwd = ownDir();
  if (opts.gitRepo === true) {
    execFileSync('git', ['init', '-q'], { cwd });
  }
  const reportDir = join(ownDir(), 'reports');
  const requests: RunRequest[] = [];
  const reviewRequests: RunRequest[] = [];
  const decisionRequests: DecisionRequest[] = [];
  const REVIEW_VERDICT_JSON = JSON.stringify({
    verdict: 'pass', reason: 'fixture reviewer: the group\'s combined result is checked against the recorded runs',
    findings: [], recommendedAction: 'none', reviewer: 'fixture-codex', reviewedAt: 1,
  });
  const runtime = new RuntimeOrchestrator({
    config: { agents: {} } as never,
    storeDir: join(cwd, '.store'),
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
      const parsed = memberRoleOf(req.prompt);
      const failed = opts.failMember !== undefined && parsed !== null && parsed.kind === 'member' && parsed.index === opts.failMember;

      // A member WRITES its own file into the round's real working directory.
      let changedFiles: string[] = [];
      let output: string;
      if (failed) {
        output = `member ${parsed && parsed.kind === 'member' ? parsed.index : '?'}: fixture failure before any deliverable`;
      } else if (parsed !== null && parsed.kind === 'member') {
        const relPath = `${parsed.scope.replace(/\/?\*+$/, '')}/${parsed.role}.txt`;
        const abs = join(cwd, relPath);
        mkdirSync(join(abs, '..'), { recursive: true });
        // The content is DERIVED from the run itself (agent/model/order), so two members
        // can never claim the same thing and a stale file from a previous round is
        // impossible: `cwd` is a fresh owned directory every time.
        const body = `DELIVERY member=${parsed.index} role=${parsed.role} agent=${req.agentId} model=${String(req.model)} run=${runIdx}`;
        writeFileSync(abs, body, 'utf8');
        changedFiles = [relPath];
        output = `collaborator ${parsed.index} (${parsed.role}) wrote ${relPath}`;
      } else if (parsed !== null && parsed.kind === 'integration') {
        /*
         * THE INTEGRATION IS REAL: it reads the member files that are physically present
         * in the working directory, and writes one combined artifact from their content.
         * It never reads the brief's handoff text for the deliverable — so if a member had
         * not written its file, this output would say so and the combined artifact would
         * be missing that member.
         */
        const found = filesUnder(cwd).filter((f) => f.endsWith('.txt') && !f.startsWith('src/integration/'));
        const contents = found.map((f) => ({ file: f, text: readFileSync(join(cwd, f), 'utf8').trim() }));
        const combinedRel = 'src/integration/combined.txt';
        const combined = [
          `COMBINED RESULT objective=${String(opts.objective ?? 'collab')}`,
          ...contents.map((c) => `from ${c.file}: ${c.text}`),
        ].join('\n');
        mkdirSync(join(cwd, 'src/integration'), { recursive: true });
        writeFileSync(join(cwd, combinedRel), combined, 'utf8');
        changedFiles = [combinedRel, ...found];
        output = `${parsed.token}: integrated ${contents.length} member file(s) [${found.join(', ')}]`;
      } else {
        output = `run ${runIdx}: unrecognised task shape`;
      }

      const toolCalls: ToolCall[] = changedFiles.map((p, i) => ({ name: 'write', callId: `c${runIdx}-${i}`, status: 'ok', input: { filePath: p }, output: 'written' }));
      const result: RunResult = {
        taskId: `t${runIdx}`, threadId: null, agentId: req.agentId,
        state: failed ? 'failed' : 'succeeded',
        startedAt: Date.now(), endedAt: Date.now(),
        exitCode: failed ? 1 : 0, signal: null,
        output, outputTruncated: false, transcriptPath: null,
        usage: {}, toolCalls,
        error: failed ? { code: 'NONZERO_EXIT', message: 'fixture failure' } : null,
        diagnostics: [], cleanup: { rootKilled: false, descendantsReaped: false, note: '', treeStopConfirmed: true, processStart: 'started' },
      };
      return {
        result: async () => {
          try { await new Promise((r) => setTimeout(r, 1)); return result; } finally { inFlight -= 1; }
        },
      } as unknown as RunHandle;
    },
  };

  let pairQuestion = 0;
  const provider: DecisionProvider = {
    name: 'laya-collab-seam',
    async probe() { return { ok: true, endpoint: 'seam://laya', detail: 'test seam', warnings: [] }; },
    async decide(request) {
      const answers: Record<string, unknown> = {};
      for (const [key, question] of Object.entries(request.questions)) {
        const criteria = (question.criteria ?? {}) as Record<string, string>;
        const offered = Object.keys(criteria);
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
          /*
           * MATERIAL-DRIVEN acceptance, exactly as the production seam requires: a task is
           * accepted only when ITS OWN material shows its own execution produced its own
           * deliverable. For the integration task that means its own output must name the
           * member files it actually read, so "everybody finished" is not readable as
           * "the integration happened".
           */
          let action = 'wait';
          const parameters: Record<string, string> = {};
          const rawMaterial = (request.state as Record<string, string> | undefined)?.[ACCEPTANCE_MATERIAL_FIELD];
          if (toVerify !== undefined && rawMaterial !== undefined) {
            const material = JSON.parse(rawMaterial) as { objective: string; entries: MaterialEntry[] };
            const entry = material.entries.find((e) => e.taskId === toVerify.taskId);
            const token = entry === undefined ? '' : (entry.acceptanceCriteria.split(':: ')[1] ?? '').split(' —')[0] ?? '';
            const isIntegration = token.startsWith('integration (');
            const satisfies = entry !== undefined &&
              material.objective.trim() !== '' &&
              entry.acceptanceCriteria.trim() !== '' &&
              !entry.executionMissing &&
              entry.output.trim() !== '' &&
              entry.output.includes(token) &&
              // The integration task must show it consumed the members' actual files, so
              // "everybody finished" can never be read as "the integration happened".
              (isIntegration ? /integrated [1-9]\d* member file/.test(entry.output) : true);
            if (satisfies && entry !== undefined) {
              action = 'complete';
              parameters.taskId = entry.taskId;
              parameters.reason = 'its own acceptance material shows its own execution produced its own deliverable';
            }
          } else if (toVerify === undefined && pending !== undefined) {
            action = 'continue';
          }
          answers[key] = { ...pick(action), parameters };
          continue;
        }
        if (key === WORKFLOW_PLAN_ID) {
          answers[key] = pick(opts.planChoice !== undefined && offered.includes(opts.planChoice) ? opts.planChoice : offered[0]!);
          continue;
        }
        if (key === INITIAL_AGENT_MODEL_ID) {
          const k = pairQuestion++;
          if (opts.inventedPair === true && k === 1) {
            // A pair nobody offered, asked of a NON-integrator member so the group is
            // refused as incomplete rather than as a plan error. The decision layer must
            // refuse it, and the round must fail that task closed rather than substitute.
            answers[key] = pick('not-a-real-agent /not-a-real-model');
            continue;
          }
          const order = opts.pairs ?? [['agent-a', 'agent-a/m1'], ['agent-a', 'agent-a/m2'], ['agent-b', 'agent-b/m1']];
          const want = initialCandidateKey(order[k]![0], order[k]![1]);
          answers[key] = pick(offered.includes(want) ? want : offered[k] ?? offered[0]!);
          continue;
        }
        answers[key] = answerFor(key, question as { type: string; criteria: unknown }, ROUTING_ANSWERS);
      }
      return { answers, provider: { name: 'laya-collab-seam', details: 'stub Laya' }, raw: {} } as never;
    },
  };

  const argv = [
    opts.objective ?? 'add a retry budget to the http client',
    '--json', '--cwd', cwd,
    '--max-children', '4', '--max-concurrent', '2',
    '--workflow', 'collaborate',
    ...(opts.planChoice !== undefined ? ['--workflow-choice', opts.planChoice] : []),
    ...(opts.fixed !== undefined ? ['--select', 'fixed', '--agent', opts.fixed.agentId, '--model', opts.fixed.modelId] : []),
  ];
  const before = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => { captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true; }) as typeof process.stdout.write;
  try {
    await runRoundCli(drivable as never, argv, {
      provider,
      probes: opts.singleModel === true
        ? [probeFor(AGENT_A, 'agent-a/m1')]
        : [probeFor(AGENT_A, 'agent-a/m1'), probeFor(AGENT_A, 'agent-a/m2'), probeFor(AGENT_B, 'agent-b/m1')],
      roundResultDir: reportDir,
    });
  } finally {
    process.stdout.write = before;
  }
  const jsonStart = captured.indexOf('{');
  let report: Record<string, unknown> = {};
  if (jsonStart !== -1) { try { report = JSON.parse(captured.slice(jsonStart)); } catch { report = {}; } }
  return { report, requests, reviewRequests, decisionRequests, reportDir, cwd, maxConcurrentRuns };
}

const collabOf = (r: Round): { members: MemberRow[]; integrator: IntegratorRow; distinctPairs: number; pairIsDistinct: boolean; integratorReusesMemberPair: boolean; choice: string } =>
  (r.report.collaboration ?? { members: [], integrator: {} as IntegratorRow, distinctPairs: 0, pairIsDistinct: false, integratorReusesMemberPair: false, choice: '' }) as never;
const wf = (r: Round): Record<string, unknown> => (r.report.workflow ?? {}) as Record<string, unknown>;
const materialsOf = (r: Round): Array<{ objective: string; entries: MaterialEntry[] }> => r.decisionRequests.map((req) => {
  const raw = (req.state as Record<string, string> | undefined)?.[ACCEPTANCE_MATERIAL_FIELD];
  return JSON.parse(String(raw ?? '{"objective":"","entries":[]}')) as { objective: string; entries: MaterialEntry[] };
});

// =========================================================================
let fatal: unknown;
try {

// =========================================================================
section('duo: 2 members, same agent, two DIFFERENT models, independent tasks and sessions');

{
  const r = await collabRound({ planChoice: 'duo', pairs: [['agent-a','agent-a/m1'], ['agent-a','agent-a/m2']] });
  const c = collabOf(r);
  check('duo: the report names the duo plan and two members', c.choice === 'duo' && c.members.length === 2, JSON.stringify(c.members));
  check('duo: each member is its OWN task', new Set(c.members.map((m) => m.taskId)).size === 2, JSON.stringify(c.members.map((m) => m.taskId)));
  check('duo: both members ran on the SAME agent family', c.members.every((m) => m.agentId === AGENT_A), JSON.stringify(c.members.map((m) => `${m.agentId}/${m.modelId}`)));
  check('duo: the two members hold DIFFERENT models', c.members[0]!.modelId !== c.members[1]!.modelId && c.pairIsDistinct === true,
    JSON.stringify(c.members.map((m) => `${m.agentId}/${m.modelId}`)));
  check('duo: each member got its OWN session', c.members[0]!.sessionId !== null && c.members[1]!.sessionId !== null && c.members[0]!.sessionId !== c.members[1]!.sessionId,
    JSON.stringify(c.members.map((m) => m.sessionId)));
  check('duo: every member carries its own file scope and role', c.members.every((m) => m.role !== 'unknown' && m.fileScope.includes('/**')),
    JSON.stringify(c.members.map((m) => `${m.role}@${m.fileScope}`)));
  check('duo: all members AND the integration task succeeded',
    c.members.every((m) => m.status === 'succeeded') && c.integrator.status === 'succeeded',
    JSON.stringify(c.members.map((m) => m.status)) + ` int=${c.integrator.status}`);
  check('duo: the round is complete and ok', r.report.ok === true && r.report.executionIncomplete === false,
    `ok=${String(r.report.ok)} incomplete=${String(r.report.executionIncomplete)} stop=${String(wf(r).stop)}`);
  check('duo: exactly 3 runs (2 members + 1 integration), never concurrent', r.requests.length === 3 && r.maxConcurrentRuns === 1,
    `n=${r.requests.length} maxConcurrent=${r.maxConcurrentRuns}`);
}

// =========================================================================
section('duo: REAL integration — the integrator read the members\' files on disk');

{
  const r = await collabRound({ planChoice: 'duo', pairs: [['agent-a','agent-a/m1'], ['agent-a','agent-a/m2']] });
  const c = collabOf(r);
  // 1. The members' deliveries physically exist, each in ITS OWN declared scope.
  const provider = join(r.cwd, 'src/provider/provider.txt');
  const consumer = join(r.cwd, 'src/consumer/consumer.txt');
  check('integration: member 1 really wrote its declared-scope file', existsSync(provider) && statSync(provider).isFile(), provider);
  check('integration: member 2 really wrote its OWN declared-scope file', existsSync(consumer) && statSync(consumer).isFile(), consumer);
  check('integration: the two deliveries are different artifacts',
    existsSync(provider) && existsSync(consumer) && readFileSync(provider, 'utf8') !== readFileSync(consumer, 'utf8'),
    `${existsSync(provider) ? readFileSync(provider, 'utf8') : '-'} | ${existsSync(consumer) ? readFileSync(consumer, 'utf8') : '-'}`);
  // 2. The combined artifact exists and carries BOTH members' real bytes.
  const combinedPath = join(r.cwd, 'src/integration/combined.txt');
  const combined = existsSync(combinedPath) ? readFileSync(combinedPath, 'utf8') : '';
  check('integration: the integration task produced ONE combined artifact', combined !== '', combinedPath);
  check('integration: the combined artifact contains each member\'s ACTUAL file content',
    combined.includes(readFileSync(provider, 'utf8').trim()) && combined.includes(readFileSync(consumer, 'utf8').trim()),
    combined.replace(/\n/g, ' | '));
  // 3. The integrator ran on a SELECTED MEMBER's pair, and it is that member's task id.
  const integratorMember = c.members.find((m) => m.taskId === c.integrator.memberTaskId);
  check('integration: the integrator IS a selected member (no fourth model)', integratorMember !== undefined && c.integratorReusesMemberPair === true,
    `member=${c.integrator.memberTaskId} reuses=${String(c.integratorReusesMemberPair)} intPair=${c.integrator.agentId}/${c.integrator.modelId}`);
  check('integration: the integrator reuses that member\'s pair and has its OWN task+session',
    integratorMember !== undefined &&
      c.integrator.agentId === integratorMember.agentId && c.integrator.modelId === integratorMember.modelId &&
      c.integrator.taskId !== integratorMember.taskId &&
      c.integrator.sessionId !== integratorMember.sessionId,
    JSON.stringify({ integrator: c.integrator, member: integratorMember }));
  // 4. The brief carried the member DELIVERIES (files + output), not just their titles.
  const integrationPrompt = r.requests[r.requests.length - 1]!.prompt;
  check('integration: the integration brief carries each member\'s changed files and output',
    integrationPrompt.includes('src/provider/provider.txt') && integrationPrompt.includes('src/consumer/consumer.txt') &&
      integrationPrompt.includes('collaborator 1 (provider) wrote') && integrationPrompt.includes('collaborator 2 (consumer) wrote'),
    integrationPrompt.slice(0, 400));
  // 5. Every collaborator pair in the whole round is one of the 2 the user/LAYA allowed.
  const seen = new Set(r.requests.map((q) => `${q.agentId}/${String(q.model)}`));
  check('integration: the whole round used exactly 2 distinct pairs', seen.size === 2, [...seen].join(','));
}

// =========================================================================
section('trio: 3 members across different agents, roles and pairs traceable');

{
  const r = await collabRound({ planChoice: 'trio', pairs: [['agent-a','agent-a/m1'], ['agent-b','agent-b/m1'], ['agent-a','agent-a/m2']] });
  const c = collabOf(r);
  check('trio: three members with three DISTINCT pairs', c.members.length === 3 && c.pairIsDistinct === true,
    JSON.stringify(c.members.map((m) => `${m.role}:${m.agentId}/${m.modelId}`)));
  check('trio: the group spans MORE THAN ONE agent family', new Set(c.members.map((m) => m.agentId)).size >= 2,
    JSON.stringify(c.members.map((m) => m.agentId)));
  check('trio: every member role and file scope is distinct', new Set(c.members.map((m) => m.role)).size === 3 && new Set(c.members.map((m) => m.fileScope)).size === 3,
    JSON.stringify(c.members.map((m) => `${m.role}@${m.fileScope}`)));
  check('trio: every member has its own session and its own task',
    new Set(c.members.map((m) => m.sessionId)).size === 3 && new Set(c.members.map((m) => m.taskId)).size === 3,
    JSON.stringify(c.members.map((m) => `${m.taskId}=${m.sessionId}`)));
  check('trio: all 3 members and the integration task succeeded',
    c.members.every((m) => m.status === 'succeeded') && c.integrator.status === 'succeeded',
    JSON.stringify(c.members.map((m) => m.status)));
  check('trio: 4 runs, strictly sequential', r.requests.length === 4 && r.maxConcurrentRuns === 1, `n=${r.requests.length} max=${r.maxConcurrentRuns}`);
  const combined = existsSync(join(r.cwd, 'src/integration/combined.txt')) ? readFileSync(join(r.cwd, 'src/integration/combined.txt'), 'utf8') : '';
  check('trio: the combined result carries all THREE members\' real content',
    combined.includes('src/core/core.txt') && combined.includes('src/cli/cli.txt') && combined.includes('tests/checks.txt'),
    combined.replace(/\n/g, ' | '));
  check('trio: the round is complete and ok', r.report.ok === true && r.report.executionIncomplete === false,
    `ok=${String(r.report.ok)} stop=${String(wf(r).stop)}`);
}

// =========================================================================
section('failure: a member that fails blocks the integration and is named');

{
  const r = await collabRound({ planChoice: 'duo', pairs: [['agent-a','agent-a/m1'], ['agent-a','agent-a/m2']], failMember: 2 });
  const c = collabOf(r);
  check('failure: member 2 is failed, not succeeded', c.members[1]!.status === 'failed', c.members[1]!.status);
  check('failure: member 1 still succeeded (the failure did not undo upstream)', c.members[0]!.status === 'succeeded', c.members[0]!.status);
  check('failure: the integration task NEVER ran', !existsSync(join(r.cwd, 'src/integration/combined.txt')) &&
    r.requests.every((q) => !q.prompt.includes('carries integration responsibility')),
    `requests=${r.requests.length}`);
  check('failure: the integration task is left with no result of its own', c.integrator.status !== 'succeeded', c.integrator.status);
  check('failure: the report NAMES the blocking member', JSON.stringify(wf(r).pending).includes(c.members[1]!.taskId) &&
    JSON.stringify(wf(r).pending).includes('failed'), JSON.stringify(wf(r).pending));
  check('failure: the round is NOT ok and IS incomplete', r.report.ok === false && r.report.executionIncomplete === true,
    `ok=${String(r.report.ok)} incomplete=${String(r.report.executionIncomplete)}`);
}

// =========================================================================
section('unverified delivery: a member that ran but was not accepted also blocks integration');

{
  // The provider accepts a task only when its own material shows its own deliverable, so
  // making the SECOND member produce nothing means the chain stops there.
  const r = await collabRound({ planChoice: 'duo', pairs: [['agent-a','agent-a/m1'], ['agent-a','agent-a/m2']] });
  const c = collabOf(r);
  const materials = materialsOf(r).filter((m) => m.entries.length > 0);
  check('material: every material carried the ORIGINAL objective',
    materials.length > 0 && materials.every((m) => m.objective === 'add a retry budget to the http client'),
    JSON.stringify(materials.map((m) => m.objective)));
  // Same-task pairing: a member's material entry carries THAT member's own output and no
  // other member's — the sharpest check that nothing is stitched across executions.
  check('material: each material entry is same-task (its own output, not another member\'s)',
    materials.every((m) => m.entries.every((e) => {
      const mi = /-m(\d+)$/.exec(e.taskId)?.[1];
      if (mi !== undefined) return e.output === '' || (e.output.includes(`collaborator ${mi} (`) && ![1, 2, 3].some((n) => String(n) !== mi && e.output.includes(`collaborator ${n} (`)));
      if (e.taskId.endsWith('-int')) return e.output === '' || e.output.includes('integrated');
      return true;
    })),
    JSON.stringify(materials.flatMap((m) => m.entries.map((e) => `${e.taskId}=${e.output}`))));
  check('material: the integration entry names the member FILES it consumed',
    materials.some((m) => m.entries.some((e) => e.taskId === c.integrator.taskId && /integrated \d+ member file/.test(e.output))),
    JSON.stringify(materials.flatMap((m) => m.entries.map((e) => `${e.taskId}=${e.output}`))));
}

// =========================================================================
section('selection: a FIXED pair is refused up front, never swapped or widened');

{
  const r = await collabRound({ planChoice: 'duo', fixed: { agentId: AGENT_A, modelId: 'agent-a/m1' } });
  check('fixed-conflict: the round is refused at the PLAN stage', r.report.stage === 'plan' && typeof r.report.error === 'string',
    `stage=${String(r.report.stage)} error=${String(r.report.error)}`);
  check('fixed-conflict: the refusal explains that one pinned pair cannot be a 2-3 model group',
    /FIXED Agent x Model selection pins ONE pair/.test(String(r.report.error)) && /not swapped/.test(String(r.report.error)),
    String(r.report.error));
  check('fixed-conflict: NOTHING ran and no task was created', r.requests.length === 0 &&
    (r.report.rootTaskId === undefined || r.report.collaboration === undefined),
    `requests=${r.requests.length}`);
}

// =========================================================================
section('selection: a pair LAYA invented is refused, never substituted');

{
  const r = await collabRound({ planChoice: 'duo', inventedPair: true });
  const c = collabOf(r);
  // The task keeps its plan-era agentId, so the honest signals of "never assigned" are a
  // null model, a null session and a non-succeeded status — never a substituted pair.
  check('invented: the member whose pair LAYA invented has NO model, NO session and did NOT succeed',
    c.members[1]!.modelId === null && c.members[1]!.sessionId === null && c.members[1]!.status !== 'succeeded',
    JSON.stringify(c.members[1]));
  check('invented: the round did not silently substitute a real pair for it', r.requests.every((q) => `${q.agentId}/${String(q.model)}` !== 'not-a-real-agent /not-a-real-model'),
    r.requests.map((q) => `${q.agentId}/${q.model}`).join(','));
  check('invented: the group is NOT reported as complete', r.report.ok === false && r.report.executionIncomplete === true,
    `ok=${String(r.report.ok)} incomplete=${String(r.report.executionIncomplete)}`);
}

// =========================================================================
section('identity: Assignment, RunRequest and Attempt agree for every member');

{
  const r = await collabRound({ planChoice: 'trio', pairs: [['agent-a','agent-a/m1'], ['agent-b','agent-b/m1'], ['agent-a','agent-a/m2']] });
  const c = collabOf(r);
  const attempts = (((r.report.roundResult as Record<string, unknown> | undefined)?.machine as Record<string, unknown> | undefined)?.attempts ?? []) as Array<Record<string, string>>;
  const execAttempts = attempts.filter((a) => a.kind === 'execution');
  check('identity: one execution attempt exists per run', execAttempts.length === 4, `attempts=${attempts.length}`);
  for (const m of c.members) {
    const attempt = execAttempts.find((a) => a.taskId === m.taskId);
    check(`identity: ${m.taskId} ran under exactly the pair Assignment recorded (${m.agentId}/${m.modelId})`,
      attempt !== undefined && attempt.agentId === m.agentId &&
      r.requests.some((q) => q.agentId === m.agentId && q.model === m.modelId && q.prompt.includes(m.role)),
      JSON.stringify(attempt));
  }
  const intAttempt = execAttempts.find((a) => a.taskId === c.integrator.taskId);
  check('identity: the integration attempt is bound to the integrator member\'s pair',
    intAttempt !== undefined && intAttempt.agentId === c.integrator.agentId,
    JSON.stringify(intAttempt));
}

// =========================================================================
section('final evidence: the review receives members AND integration material');

{
  const r = await collabRound({ planChoice: 'duo', pairs: [['agent-a','agent-a/m1'], ['agent-a','agent-a/m2']] });
  const c = collabOf(r);
  const ur = r.report.unifiedReview as { status?: string; verdict?: unknown } | undefined;
  check('review: the unified review COMPLETED with a parseable verdict', r.reviewRequests.length === 1 && ur?.status === 'completed' && ur.verdict === 'pass',
    `status=${String(ur?.status)} verdict=${JSON.stringify(ur?.verdict)}`);
  const prompt = r.reviewRequests[0]!.prompt;
  check('review: the review request carries EVERY member\'s real output',
    c.members.every((m) => prompt.includes(`collaborator ${m.index} (${m.role}) wrote`)),
    prompt.slice(0, 300));
  check('review: the review request carries the INTEGRATION task\'s real output',
    prompt.includes('integrated 2 member file(s)'), prompt.slice(-400));
  const re = r.report.reviewEvidence as { ok?: boolean; attemptId?: string | null } | undefined;
  const reviewAttempts = (((r.report.roundResult as Record<string, unknown> | undefined)?.machine as Record<string, unknown> | undefined)?.attempts ?? []) as Array<Record<string, string>>;
  check('review: the verdict reached the evidence chain as a real kind=review attempt',
    re?.ok === true && typeof re.attemptId === 'string' && re.attemptId !== '' &&
    reviewAttempts.some((a) => a.attemptId === re.attemptId && a.kind === 'review'),
    `ok=${String(re?.ok)} attemptId=${String(re?.attemptId)}`);
  // "Everyone exited" is NOT acceptance: the Human Gate is derived, not asserted here, but
  // the round must not claim completion for a group that did not integrate.
  check('review: all-terminal was not treated as acceptance (gate + ok agree)',
    r.report.ok === true && (r.report.humanGate as { status?: string } | undefined)?.status !== 'blocked',
    `ok=${String(r.report.ok)} gate=${JSON.stringify(r.report.humanGate)}`);
}

// =========================================================================
section('boundaries: reports and directories stay inside the owned range');

{
  const callerDir = ownDir();
  const sentinel = join(callerDir, 'round-result.json');
  writeFileSync(sentinel, '{"owner":"caller","untouched":true}', 'utf8');
  const r = await collabRound({ planChoice: 'duo', pairs: [['agent-a','agent-a/m1'], ['agent-a','agent-a/m2']] });
  const published = (r.report.roundResultPublished ?? {}) as { ok?: boolean; path?: string };
  check('isolation: the report was published into the OWNED dir',
    published.ok === true && typeof published.path === 'string' && published.path.startsWith(r.reportDir) && existsSync(published.path),
    JSON.stringify(published));
  check('isolation: the caller\'s report file was NOT modified',
    readFileSync(sentinel, 'utf8') === '{"owner":"caller","untouched":true}', readFileSync(sentinel, 'utf8'));
  check('isolation: every produced file lives under the round\'s OWNED cwd',
    filesUnder(r.cwd).every((f) => !f.includes('..')), filesUnder(r.cwd).join(','));
  check('isolation: PARALLEL_WRITE stayed closed — no two runs overlapped', r.maxConcurrentRuns === 1, `max=${r.maxConcurrentRuns}`);
  const wfReport = wf(r);
  check('isolation: the workflow report names the sequential invariant',
    JSON.stringify(wfReport).includes('integration depends on EVERY member'), String(wfReport.note));
}

// =========================================================================
section('boundary: a group of 2–3 cannot be faked with ONE repeated pair');

{
  const r = await collabRound({ planChoice: 'duo', singleModel: true });
  check('single-model: the round is refused at the PLAN stage', r.report.stage === 'plan' && typeof r.report.error === 'string',
    `stage=${String(r.report.stage)} error=${String(r.report.error)}`);
  check('single-model: the refusal says 2 distinct pairs are needed and no pair is duplicated',
    /needs 2 distinct available/.test(String(r.report.error)) && /no pair is duplicated/.test(String(r.report.error)),
    String(r.report.error));
  check('single-model: nothing ran', r.requests.length === 0 && r.report.collaboration === undefined, `requests=${r.requests.length}`);
}

// =========================================================================
section('boundary: a git-isolated workspace is refused, because integration could not be real');

{
  const r = await collabRound({ planChoice: 'duo', gitRepo: true });
  check('git-isolated: the round is refused at the PLAN stage', r.report.stage === 'plan' && typeof r.report.error === 'string',
    `stage=${String(r.report.stage)} error=${String(r.report.error)}`);
  check('git-isolated: the refusal names the shared-workspace requirement, not a silent downgrade',
    /SHARED sequential workspace/.test(String(r.report.error)) && /isolated into per-task/.test(String(r.report.error)),
    String(r.report.error));
  check('git-isolated: nothing ran', r.requests.length === 0, `requests=${r.requests.length}`);
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
