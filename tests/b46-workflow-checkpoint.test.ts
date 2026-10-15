/**
 * tests/b46-workflow-checkpoint.test.ts — B4.6a: the opt-in single-step USER checkpoint.
 *
 * WHAT IS REAL vs INJECTED
 * ------------------------
 * REAL: `runRoundCli` -> plan -> Assignment -> SessionRegistry -> TaskScheduler.tick ->
 * `executeTask` -> AttemptStore -> the decision loop -> `applyVerification` -> the report.
 * INJECTED, only these: LAYA's ANSWERS (the real laya-serve is external), the runtime's
 * per-agent outcome, and the USER'S checkpoint answer (through the `checkpointInput`
 * seam). No test calls `completeTask` itself.
 *
 * This suite covers the parts the sequential harness in b40a does not: a collaboration
 * group stop/continue, the usage refusals raised BEFORE anything is created, the
 * production reader's fail-closed behaviour, the detachment of the snapshot, and the
 * reader's natural process exit.
 *
 * Run: node tests/b46-workflow-checkpoint.test.ts
 */

import {
  existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';

import { runRoundCli } from '../src/cli/round-cli.ts';
import { Orchestrator as RuntimeOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { createFakeAdapter } from './helpers.ts';
import {
  createStdinCheckpointReader, parseCheckpointAnswer,
  type WorkflowCheckpointSnapshot,
} from '../src/cli/workflow-checkpoint.ts';
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
function ownDir(): string { const d = mkdtempSync(join(tmpdir(), 'b46-')); tmpDirs.push(d); return d; }
function removeOwnedDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); }
  catch (e) { cleanupFailures.push(`owned dir removal threw for ${dir}: ${(e as Error).message}`); return; }
  if (existsSync(dir)) cleanupFailures.push(`owned dir ${dir} still present after removal`);
}

/**
 * Spawn a Node child running `fixturePath` and resolve ONLY after the owned child has
 * REALLY exited.
 *
 * Cleanup contract (B4.6a): on timeout the child is killed and we then WAIT for its `exit`
 * event — we never resolve while it could still be running, and a kill that throws is
 * recorded instead of hidden. A hard fallback only resolves if the child refuses to die,
 * and it is reported as a cleanup error.
 */
function runOwnedChild(
  fixturePath: string,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string; timedOut: boolean; cleanupError: string | null }> {
  const child = spawn(process.execPath, [fixturePath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
  child.stderr.on('data', (d: Buffer) => { out += d.toString('utf8'); });
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let cleanupError: string | null = null;
    let fallback: NodeJS.Timeout | undefined;
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (fallback !== undefined) clearTimeout(fallback);
      resolve({ code, signal, out, timedOut, cleanupError });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); }
      catch (e) { cleanupError = `kill threw: ${(e as Error).message}`; settle(null, null); return; }
      // Do NOT settle here: wait for the owned child's real exit. The fallback reports a
      // child that will not die rather than pretending the cleanup succeeded.
      fallback = setTimeout(() => { cleanupError = cleanupError ?? 'child did not exit after kill'; settle(null, null); }, 5_000);
    }, timeoutMs);
    child.on('exit', (code, signal) => settle(code, signal));
    child.on('error', (e) => { cleanupError = cleanupError ?? `child error: ${e.message}`; settle(null, null); });
  });
}

const AGENT_A = 'agent-a';
const AGENT_B = 'agent-b';
const REVIEWER = 'codex';
const CAPS = { newTask: true, review: true, modelSelection: true, cwd: true, resume: true, workspaceModes: ['shared', 'isolated'] } as never;

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

function probeFor(agentId: string, modelId: string, status: 'available' | 'exhausted' | 'not_fetched' = 'available'): QuotaProbe {
  return {
    agentId, provider: agentId,
    records: [{ provider: agentId, agentId, modelId: null, source: 'locally_observed', usage: null, remaining: null, resetAt: null, period: 'day', status, usageClass: 'observed', confidence: 'high', observedAt: Date.now(), note: '' }],
    login: 'stubbed for test', version: '0.0.0-test', modelHint: modelId, providerHint: null, error: null,
  } as unknown as QuotaProbe;
}

interface CheckpointEntryReport {
  taskId: string; status: string; role: string | null; acceptanceCriteria: string;
  attemptId: string; agentId: string; modelId: string | null; sessionId: string | null;
  output: string; outputTruncated: boolean; treeStopConfirmed: boolean | null;
  choice: 'continue' | 'stop' | 'accept'; stopReason: string | null;
  acceptReason: string | null; acceptOutcome: 'applied' | 'refused' | null; acceptRefusal: string | null;
  source: 'user';
}
interface CheckpointsReport {
  enabled: boolean;
  prompts: number;
  entries: CheckpointEntryReport[];
  stop: { taskId: string; reason: string; blockedTaskIds: string[] } | null;
  note: string;
}
interface Round {
  report: Record<string, unknown>;
  requests: RunRequest[];
  reviewRequests: RunRequest[];
  decisionRequests: DecisionRequest[];
  cwd: string;
  exitCode: number;
}

function memberRoleOf(prompt: string): { kind: 'member'; index: number; role: string; scope: string } | { kind: 'integration'; token: string } | null {
  const m = /:: collaborator (\d+) \(([\w-]+)\) — file scope: (\S+) — deliverable:/.exec(prompt);
  if (m !== null) return { kind: 'member', index: Number(m[1]), role: m[2]!, scope: m[3]! };
  const i = /:: integration \(collaborator (\d+) carries integration responsibility\)/.exec(prompt);
  if (i !== null) return { kind: 'integration', token: `integration (collaborator ${i[1]} carries integration responsibility)` };
  return null;
}

/**
 * Run ONE real production round with `--workflow collaborate`, optionally opting in to
 * the checkpoint. The user's answer is controlled through `checkpointInput`; the CLI
 * validates it, so this fixture never claims a valid answer it did not supply.
 */
async function collabRound(opts: {
  checkpoint?: boolean;
  checkpointInput?: (snapshot: WorkflowCheckpointSnapshot) => string | Promise<string>;
} = {}): Promise<Round> {
  const cwd = ownDir();
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

  const drivable = {
    agentIds: () => [AGENT_A, AGENT_B],
    descriptors: () => [AGENT_A, AGENT_B].map((id) => ({ id, displayName: id, launcher: 'fake', transport: 'cli-jsonl', capabilities: { newTask: true, review: true, modelSelection: true, cwd: true, resume: true, workspaceModes: ['shared', 'isolated'] } } as never)),
    configFor: () => ({}),
    store: runtime.store,
    review: (req: Omit<RunRequest, 'mode'>) => { reviewRequests.push({ ...req, mode: 'review' } as RunRequest); return runtime.review(req); },
    run(req: RunRequest): RunHandle {
      requests.push(req);
      const runIdx = requests.length;
      const parsed = memberRoleOf(req.prompt);
      let changedFiles: string[] = [];
      let output: string;
      if (parsed !== null && parsed.kind === 'member') {
        const relPath = `${parsed.scope.replace(/\/?\*+$/, '')}/${parsed.role}.txt`;
        const abs = join(cwd, relPath);
        mkdirSync(join(abs, '..'), { recursive: true });
        writeFileSync(abs, `DELIVERY member=${parsed.index} role=${parsed.role} run=${runIdx}`, 'utf8');
        changedFiles = [relPath];
        output = `collaborator ${parsed.index} (${parsed.role}) wrote ${relPath}`;
      } else if (parsed !== null && parsed.kind === 'integration') {
        const combinedRel = 'src/integration/combined.txt';
        mkdirSync(join(cwd, 'src/integration'), { recursive: true });
        writeFileSync(join(cwd, combinedRel), `COMBINED objective=${String(opts)}`, 'utf8');
        changedFiles = [combinedRel];
        output = `${parsed.token}: integrated 2 member file(s) [src/provider/provider.txt, src/consumer/consumer.txt]`;
      } else {
        output = `run ${runIdx}: unrecognised task shape`;
      }
      const toolCalls: ToolCall[] = changedFiles.map((p, i) => ({ name: 'write', callId: `c${runIdx}-${i}`, status: 'ok', input: { filePath: p }, output: 'written' }));
      const result: RunResult = {
        taskId: `t${runIdx}`, threadId: null, agentId: req.agentId,
        state: 'succeeded', startedAt: Date.now(), endedAt: Date.now(),
        exitCode: 0, signal: null,
        output, outputTruncated: false, transcriptPath: null,
        usage: {}, toolCalls, error: null, diagnostics: [],
        cleanup: { rootKilled: false, descendantsReaped: false, note: '', treeStopConfirmed: true, processStart: 'started' },
      };
      return { result: async () => result } as unknown as RunHandle;
    },
  };

  let pairQuestion = 0;
  const pairs: readonly (readonly [string, string])[] = [['agent-a', 'agent-a/m1'], ['agent-a', 'agent-a/m2']];
  const provider: DecisionProvider = {
    name: 'laya-checkpoint-seam',
    async probe() { return { ok: true, endpoint: 'seam://laya', detail: 'test seam', warnings: [] }; },
    async decide(request) {
      const answers: Record<string, unknown> = {};
      for (const [key, question] of Object.entries(request.questions)) {
        const criteria = (question.criteria ?? {}) as Record<string, string>;
        const offered = Object.keys(criteria);
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
            const isIntegration = token.startsWith('integration (');
            const satisfies = entry !== undefined && material.objective.trim() !== '' && entry.acceptanceCriteria.trim() !== '' &&
              !entry.executionMissing && entry.output.trim() !== '' && entry.output.includes(token) &&
              (isIntegration ? /integrated [1-9]\d* member file/.test(entry.output) : true);
            if (satisfies && entry !== undefined) { action = 'complete'; parameters.taskId = entry.taskId; parameters.reason = 'its own material shows its own deliverable'; }
          } else if (toVerify === undefined && pending !== undefined) {
            action = 'continue';
          }
          answers[key] = { ...pick(action), parameters };
          continue;
        }
        if (key === WORKFLOW_PLAN_ID) { answers[key] = pick(offered.includes('duo') ? 'duo' : offered[0]!); continue; }
        if (key === INITIAL_AGENT_MODEL_ID) {
          const k = pairQuestion++;
          const want = initialCandidateKey(pairs[k]![0], pairs[k]![1]);
          answers[key] = pick(offered.includes(want) ? want : offered[k] ?? offered[0]!);
          continue;
        }
        answers[key] = answerFor(key, question as { type: string; criteria: unknown }, ROUTING_ANSWERS);
      }
      return { answers, provider: { name: 'laya-checkpoint-seam', details: 'stub Laya' }, raw: {} } as never;
    },
  };

  const argv = [
    'add a retry budget to the http client',
    '--json', '--cwd', cwd,
    '--max-children', '4', '--max-concurrent', '2',
    '--workflow', 'collaborate',
    ...(opts.checkpoint === true ? ['--checkpoint'] : []),
  ];
  const before = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => { captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true; }) as typeof process.stdout.write;
  let exitCode = -1;
  try {
    exitCode = await runRoundCli(drivable as never, argv, {
      provider,
      probes: [probeFor('agent-a', 'agent-a/m1'), probeFor('agent-a', 'agent-a/m2')],
      roundResultDir: reportDir,
      ...(opts.checkpointInput === undefined ? {} : { checkpointInput: opts.checkpointInput }),
    });
  } finally {
    process.stdout.write = before;
  }
  const jsonStart = captured.indexOf('{');
  let report: Record<string, unknown> = {};
  if (jsonStart !== -1) { try { report = JSON.parse(captured.slice(jsonStart)); } catch { report = {}; } }
  return { report, requests, reviewRequests, decisionRequests, cwd, exitCode };
}

const cpOf = (r: Round): CheckpointsReport | undefined => r.report.checkpoints as CheckpointsReport | undefined;
const workflowOf = (r: Round): Record<string, unknown> => (r.report.workflow ?? {}) as Record<string, unknown>;

/** A minimal drivable used ONLY for the pre-execution usage refusals. */
function refusalCase(argv: string[]): Promise<{ exitCode: number; runCalls: number; decideCalls: number }> {
  const dir = ownDir();
  let runCalls = 0;
  let decideCalls = 0;
  const runtime = new RuntimeOrchestrator({
    config: { agents: {} } as never,
    storeDir: join(dir, '.store'),
    replaceAdapters: [createFakeAdapter({ id: AGENT_A, capabilities: CAPS, script: [{ kind: 'exit', code: 0 }] })],
  });
  const drivable = {
    agentIds: () => [AGENT_A],
    descriptors: () => [{ id: AGENT_A, displayName: AGENT_A, launcher: 'fake', transport: 'cli-jsonl', capabilities: CAPS } as never],
    configFor: () => ({}),
    store: runtime.store,
    review: () => { throw new Error('review must not run'); },
    run: () => { runCalls += 1; throw new Error('run must not be reached'); },
  };
  const provider = { name: 'must-not-decide', async probe() { return { ok: true, endpoint: 'x', detail: '', warnings: [] }; }, async decide() { decideCalls += 1; throw new Error('decide must not be reached'); } } as unknown as DecisionProvider;
  const beforeErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  return (async () => {
    try {
      const exitCode = await runRoundCli(drivable as never, ['objective', '--json', ...argv], { provider, probes: [] });
      return { exitCode, runCalls, decideCalls };
    } finally { process.stderr.write = beforeErr; }
  })();
}

// =========================================================================
let fatal: unknown;
try {

// =========================================================================
section('collaboration continue: all members and integration proceed, one prompt each');

{
  const prompted: string[] = [];
  const r = await collabRound({ checkpoint: true, checkpointInput: (s) => { prompted.push(s.taskId); return 'continue'; } });
  const cp = cpOf(r)!;
  check('continue: one prompt per attempt (2 members + integration)', prompted.length === 3 && new Set(prompted).size === 3, JSON.stringify(prompted));
  check('continue: the group completes (3 runs, exit 0, ok)',
    r.requests.length === 3 && r.exitCode === 0 && r.report.ok === true, `n=${r.requests.length} exit=${r.exitCode} ok=${String(r.report.ok)}`);
  check('continue: every entry is a continue with no stop', cp.entries.every((e) => e.choice === 'continue' && e.stopReason === null) && cp.stop === null,
    JSON.stringify(cp.entries.map((e) => e.choice)));
  check('continue: the integration entry carries the integrator\'s own output',
    cp.entries.some((e) => /integration/.test(e.role ?? '') && e.output.includes('integrated')), JSON.stringify(cp.entries.map((e) => e.role)));
}

// =========================================================================
section('collaboration stop: the first member blocks the rest, and its file survives');

{
  const r = await collabRound({ checkpoint: true, checkpointInput: () => 'stop member 1 is not acceptable' });
  const cp = cpOf(r)!;
  const member1File = join(r.cwd, 'src/provider/provider.txt');
  check('stop: exactly ONE member ran', r.requests.length === 1, `n=${r.requests.length}`);
  check('stop: the first member\'s real file is preserved on disk', existsSync(member1File), member1File);
  check('stop: the second member never ran', !r.requests.some((q) => q.prompt.includes('collaborator 2 (')), r.requests.map((q) => q.prompt.slice(0, 30)).join(' | '));
  check('stop: the integration never ran', !r.requests.some((q) => q.prompt.includes('carries integration responsibility')) && !existsSync(join(r.cwd, 'src/integration/combined.txt')),
    `n=${r.requests.length}`);
  check('stop: the loop stopped on user-stop', workflowOf(r).stop === 'user-stop', String(workflowOf(r).stop));
  check('stop: the report records the reason and blocks the member + integration',
    cp.stop !== null && cp.stop.reason === 'member 1 is not acceptable' && cp.stop.blockedTaskIds.length >= 2 &&
      cp.stop.blockedTaskIds.some((id) => id.endsWith('-m2')) && cp.stop.blockedTaskIds.some((id) => id.endsWith('-int')),
    JSON.stringify(cp.stop));
  check('stop: the round is NOT ok, IS incomplete, and exits non-zero',
    r.report.ok === false && r.report.executionIncomplete === true && r.exitCode !== 0,
    `ok=${String(r.report.ok)} incomplete=${String(r.report.executionIncomplete)} exit=${r.exitCode}`);
  check('stop: the stopped attempt matches the real run',
    cp.entries[0]!.agentId === r.requests[0]!.agentId && cp.entries[0]!.output.includes('collaborator 1 ('), JSON.stringify(cp.entries[0]!.attemptId));
  const handoff = r.report.handoff as { enabled?: boolean; happened?: number; stopped?: { code?: string } } | undefined;
  check('stop: the handoff is withheld and says why (user-stop, not --no-handoff)',
    handoff?.happened === 0 && handoff.stopped?.code === 'user-stop', JSON.stringify(handoff));
}

// =========================================================================
section('collaboration accept: the user completes each DISPLAYED member, the group finishes');

{
  // The user accepts every member (and the integration). The checkpoint runs BEFORE LAYA can
  // choose `complete`, so the group finishes on the USER's verdicts through the EXISTING
  // verification authority, not a model completion.
  const r = await collabRound({ checkpoint: true, checkpointInput: () => 'accept: member output reviewed' });
  const cp = cpOf(r)!;
  check('collab-accept: one prompt per attempt, every one applied through verification',
    cp.entries.length === 3 && cp.entries.every((e) => e.choice === 'accept' && e.acceptOutcome === 'applied' && e.source === 'user' && e.acceptRefusal === null),
    JSON.stringify(cp.entries.map((e) => `${e.choice}:${e.acceptOutcome}`)));
  check('collab-accept: the group completes (3 runs, exit 0, ok)',
    r.requests.length === 3 && r.exitCode === 0 && r.report.ok === true,
    `n=${r.requests.length} exit=${r.exitCode} ok=${String(r.report.ok)}`);
  check('collab-accept: the non-empty reason and attempt are traceable per task',
    cp.entries.every((e) => e.acceptReason === 'member output reviewed' && e.attemptId.trim() !== '' && e.taskId.trim() !== '') &&
      cp.entries.some((e) => e.taskId.endsWith('-m1')) && cp.entries.some((e) => e.taskId.endsWith('-int')),
    JSON.stringify(cp.entries.map((e) => `${e.taskId}:${e.acceptReason}`)));
  check('collab-accept: the note distinguishes a USER acceptance from a read-only checkpoint',
    /ACCEPTED/i.test(cp.note) && /USER/.test(cp.note) && !/checkpoint itself verifies nothing/i.test(cp.note),
    cp.note);
}

// =========================================================================
section('detachment: the snapshot is frozen, plain, and reaches no authority');

{
  let captured: WorkflowCheckpointSnapshot | null = null;
  const r = await collabRound({
    checkpoint: true,
    checkpointInput: (s) => { if (captured === null) captured = s; return 'continue'; },
  });
  const s = captured as WorkflowCheckpointSnapshot | null;
  check('detach: the seam really received a snapshot', s !== null, 'null');
  check('detach: the snapshot is frozen', s !== null && Object.isFrozen(s), String(s === null ? 'null' : Object.isFrozen(s)));
  check('detach: only plain data is reachable (no function value)',
    s !== null && Object.values(s).every((v) => typeof v !== 'function'), JSON.stringify(s));
  check('detach: no store / runtime / workbench handle is present',
    s !== null && !('store' in s) && !('run' in s) && !('workbench' in s) && !('runtime' in s) && !('sessions' in s),
    JSON.stringify(Object.keys(s ?? {})));
  check('detach: the facts are this attempt\'s own',
    s !== null && s.status === 'to_verify' && s.attemptId.trim() !== '' && typeof s.agentId === 'string' &&
      s.agentId !== '' && s.acceptanceCriteria.includes('deliverable:') && s.outputTruncated === false &&
      s.treeStopConfirmed === true,
    JSON.stringify(s));
  check('detach: the continue still let the round finish', r.report.ok === true && r.requests.length === 3, `ok=${String(r.report.ok)} n=${r.requests.length}`);
}

// =========================================================================
section('usage: a checkpoint combination that cannot execute is refused before anything runs');

{
  const noWorkflow = await refusalCase(['--checkpoint']);
  check('usage: --checkpoint without --workflow is refused (exit 2)', noWorkflow.exitCode === 2, `exit=${noWorkflow.exitCode}`);
  check('usage: nothing was classified, planned, assigned or run',
    noWorkflow.runCalls === 0 && noWorkflow.decideCalls === 0, `run=${noWorkflow.runCalls} decide=${noWorkflow.decideCalls}`);

  const classifyOnly = await refusalCase(['--workflow', 'sequential', '--checkpoint', '--classify-only']);
  check('usage: --checkpoint with --classify-only is refused (exit 2)', classifyOnly.exitCode === 2, `exit=${classifyOnly.exitCode}`);
  check('usage: the refused combination still created/ran nothing',
    classifyOnly.runCalls === 0 && classifyOnly.decideCalls === 0, `run=${classifyOnly.runCalls} decide=${classifyOnly.decideCalls}`);

  const legacy = await refusalCase(['--checkpoint', '--agent', AGENT_A]);
  check('usage: --checkpoint on the legacy path is refused (exit 2)', legacy.exitCode === 2, `exit=${legacy.exitCode}`);
}

// =========================================================================
section('usage: a VALUE form of --checkpoint is refused before anything runs');

{
  // B4.6a (P1), via the real runRoundCli: `--checkpoint=true` and `--checkpoint continue`
  // parse to a STRING, so the old boolean test read them as OFF and the round ran with NO
  // supervision and no error. Every value / non-boolean form must exit 2 with nothing
  // classified, planned, assigned or run — never a silent unsupervised execution.
  const eqTrue = await refusalCase(['--workflow', 'sequential', '--checkpoint=true']);
  check('usage: --checkpoint=true is refused, not silently ignored (exit 2)', eqTrue.exitCode === 2, `exit=${eqTrue.exitCode}`);
  check('usage: --checkpoint=true created/decided/ran nothing',
    eqTrue.runCalls === 0 && eqTrue.decideCalls === 0, `run=${eqTrue.runCalls} decide=${eqTrue.decideCalls}`);

  const eqContinue = await refusalCase(['--workflow', 'sequential', '--checkpoint=continue']);
  check('usage: --checkpoint=continue is refused, not silently ignored (exit 2)', eqContinue.exitCode === 2, `exit=${eqContinue.exitCode}`);
  check('usage: --checkpoint=continue created/decided/ran nothing',
    eqContinue.runCalls === 0 && eqContinue.decideCalls === 0, `run=${eqContinue.runCalls} decide=${eqContinue.decideCalls}`);

  const spaceForm = await refusalCase(['--workflow', 'collaborate', '--checkpoint', 'continue']);
  check('usage: the space form "--checkpoint continue" is refused (exit 2)', spaceForm.exitCode === 2, `exit=${spaceForm.exitCode}`);
  check('usage: the refused space form created/decided/ran nothing',
    spaceForm.runCalls === 0 && spaceForm.decideCalls === 0, `run=${spaceForm.runCalls} decide=${spaceForm.decideCalls}`);
}

// =========================================================================
section('reader: fail-closed on non-TTY, and it releases so a child exits naturally');

{
  const snapshot: WorkflowCheckpointSnapshot = Object.freeze({
    taskId: 't', status: 'to_verify', role: 'r', acceptanceCriteria: 'c',
    attemptId: 'a', agentId: 'ag', modelId: null, sessionId: null,
    output: 'o', outputTruncated: false, treeStopConfirmed: true,
  });
  // A non-TTY input must be refused WITHOUT waiting, and the answer validator must never
  // turn it into a continue.
  const nonTty = new PassThrough();
  (nonTty as unknown as { isTTY?: boolean }).isTTY = false;
  const output = new PassThrough();
  let refused = false;
  try { await createStdinCheckpointReader({ input: nonTty, output, timeoutMs: 1000 })(snapshot); }
  catch { refused = true; }
  check('reader: a non-TTY stdin is refused (fail closed), never a default continue', refused === true, `refused=${refused}`);
  check('reader: the pure validator rejects an empty answer', parseCheckpointAnswer('').action === 'invalid', parseCheckpointAnswer('').action);
  check('reader: the pure validator rejects a bare stop', parseCheckpointAnswer('stop').action === 'invalid', parseCheckpointAnswer('stop').action);
  check('reader: the pure validator accepts continue and stop <reason>',
    parseCheckpointAnswer('continue').action === 'continue' && parseCheckpointAnswer('stop too risky').action === 'stop',
    JSON.stringify([parseCheckpointAnswer('continue'), parseCheckpointAnswer('stop too risky')]));
  // B4.6b: `accept <reason>` is a THIRD answer; a bare accept or a blank reason is invalid.
  check('reader: the pure validator accepts accept <reason> (case/colon tolerant)',
    parseCheckpointAnswer('accept looks good').action === 'accept' &&
      (parseCheckpointAnswer('accept looks good') as { reason?: string }).reason === 'looks good' &&
      parseCheckpointAnswer('ACCEPT: reviewed the deliverable').action === 'accept',
    JSON.stringify([parseCheckpointAnswer('accept looks good'), parseCheckpointAnswer('ACCEPT: reviewed the deliverable')]));
  check('reader: the pure validator rejects a bare accept and a blank accept reason',
    parseCheckpointAnswer('accept').action === 'invalid' && parseCheckpointAnswer('accept    ').action === 'invalid',
    JSON.stringify([parseCheckpointAnswer('accept'), parseCheckpointAnswer('accept    ')]));
  check('reader: continue/stop defaults are unchanged by the new grammar',
    parseCheckpointAnswer('continue').action === 'continue' && parseCheckpointAnswer('').action === 'invalid' &&
      parseCheckpointAnswer('stop').action === 'invalid' && parseCheckpointAnswer('maybe').action === 'invalid',
    JSON.stringify([parseCheckpointAnswer('continue'), parseCheckpointAnswer('')]));

  // A SEPARATE child that uses the reader and never calls process.exit: it can only exit
  // naturally if the readline/timer/listeners were really released.
  const moduleUrl = pathToFileURL(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'cli', 'workflow-checkpoint.ts')).href;
  const fixtureDir = ownDir();
  const fixturePath = join(fixtureDir, 'checkpoint-child.ts');
  writeFileSync(fixturePath, [
    `import { createStdinCheckpointReader } from ${JSON.stringify(moduleUrl)};`,
    `import { PassThrough } from 'node:stream';`,
    `const input = new PassThrough();`,
    `(input as unknown as { isTTY?: boolean }).isTTY = true;`,
    `const output = new PassThrough();`,
    `const read = createStdinCheckpointReader({ input, output, timeoutMs: 5000 });`,
    `input.write('continue\\n');`,
    `const snapshot = { taskId: 't', status: 'to_verify', role: 'r', acceptanceCriteria: 'c', attemptId: 'a', agentId: 'ag', modelId: null, output: 'o', outputTruncated: false, treeStopConfirmed: true };`,
    `const answer = await read(snapshot);`,
    `process.stdout.write('ANSWER:' + JSON.stringify(answer) + '\\n');`,
    `// deliberately no process.exit: the process must exit on its own`,
  ].join('\n'), 'utf8');

  const childOutcome = await runOwnedChild(fixturePath, 15_000);
  check('reader: the child read the answer and exited NATURALLY (no process.exit)',
    !childOutcome.timedOut && childOutcome.cleanupError === null && childOutcome.code === 0,
    `exit=${String(childOutcome.code)} timedOut=${childOutcome.timedOut} cleanup=${String(childOutcome.cleanupError)}`);
  check('reader: the child saw the continue answer', /ANSWER:"continue"/.test(childOutcome.out), childOutcome.out.trim());
}

// =========================================================================
section('reader: a TTY input that ends (EOF) rejects, never a default continue');

{
  const snapshot: WorkflowCheckpointSnapshot = Object.freeze({
    taskId: 't', status: 'to_verify', role: 'r', acceptanceCriteria: 'c',
    attemptId: 'a', agentId: 'ag', modelId: null, sessionId: null,
    output: 'o', outputTruncated: false, treeStopConfirmed: true,
  });
  // A ref'd guard (setTimeout) keeps the process referenced while we await, so a reader
  // that never settles is reported as 'hung' instead of silently ending the process with an
  // unsettled top-level await (which would fake a pass). It is cleared once the await settles.
  const outcome = async (run: () => Promise<string>): Promise<'resolved' | 'rejected' | 'hung'> => {
    let guard: NodeJS.Timeout | undefined;
    const guardPromise = new Promise<'hung'>((res) => { guard = setTimeout(() => res('hung'), 4_000); });
    const result = await Promise.race([
      run().then(() => 'resolved' as const, () => 'rejected' as const),
      guardPromise,
    ]);
    if (guard !== undefined) clearTimeout(guard);
    return result;
  };
  const tty = (): PassThrough => { const p = new PassThrough(); (p as unknown as { isTTY?: boolean }).isTTY = true; return p; };

  const eofInput = tty();
  setTimeout(() => eofInput.end(), 10);
  const eof = await outcome(() => createStdinCheckpointReader({ input: eofInput, output: new PassThrough(), timeoutMs: 4_000 })(snapshot));
  check('reader: EOF on a TTY input rejects (fail closed), never a default continue', eof === 'rejected', eof);

  const started = Date.now();
  const shortTimeout = await outcome(() => createStdinCheckpointReader({ input: tty(), output: new PassThrough(), timeoutMs: 40 })(snapshot));
  const elapsed = Date.now() - started;
  check('reader: a short timeout rejects (fail closed)', shortTimeout === 'rejected', shortTimeout);
  check('reader: the wait is bounded by deps.timeoutMs, not the 60s default', elapsed < 2_000, `elapsed=${elapsed}ms`);

  const errInput = tty();
  const errored = await outcome(() => {
    setTimeout(() => errInput.emit('error', new Error('input exploded')), 10);
    return createStdinCheckpointReader({ input: errInput, output: new PassThrough(), timeoutMs: 4_000 })(snapshot);
  });
  check('reader: an input error rejects (fail closed), never a default continue', errored === 'rejected', errored);
}

// =========================================================================
section('reader: a failing reader still releases everything so a bounded child exits naturally');

{
  const moduleUrl = pathToFileURL(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'cli', 'workflow-checkpoint.ts')).href;
  const fixtureDir = ownDir();
  const fixturePath = join(fixtureDir, 'checkpoint-fail-child.ts');
  // The child exercises ALL THREE failing paths (EOF, short timeout, input error) and then
  // simply returns: it can only exit naturally (code 0) if every read released its
  // readline interface, listeners and timer. It never calls process.exit.
  writeFileSync(fixturePath, [
    `import { createStdinCheckpointReader } from ${JSON.stringify(moduleUrl)};`,
    `import { PassThrough } from 'node:stream';`,
    `const snapshot = { taskId: 't', status: 'to_verify', role: 'r', acceptanceCriteria: 'c', attemptId: 'a', agentId: 'ag', modelId: null, output: 'o', outputTruncated: false, treeStopConfirmed: true };`,
    `function tty(): PassThrough { const p = new PassThrough(); (p as unknown as { isTTY?: boolean }).isTTY = true; return p; }`,
    `async function attempt(setup: (i: PassThrough) => void, timeoutMs: number): Promise<string> {`,
    `  const input = tty();`,
    `  const output = new PassThrough();`,
    `  const read = createStdinCheckpointReader({ input, output, timeoutMs });`,
    `  setup(input);`,
    `  try { const a = await read(snapshot); return 'RESOLVED:' + a; }`,
    `  catch (e) { return 'REJECTED:' + (e as Error).name; }`,
    `}`,
    `// A short REF'd guard keeps the event loop alive across the awaits, so a reader that`,
    `// never settles is observed as a hang instead of the process exiting early with an`,
    `// unsettled top-level await (which would fake a pass). It is cleared afterwards, so the`,
    `// child can STILL only exit naturally if every reader really released its handles.`,
    `const guard = setInterval(() => {}, 1000);`,
    `let results: string[];`,
    `try {`,
    `  results = [`,
    `    await attempt((i) => i.end(), 3000),`,
    `    await attempt(() => {}, 40),`,
    `    await attempt((i) => setTimeout(() => i.emit('error', new Error('boom')), 10), 3000),`,
    `  ];`,
    `} finally {`,
    `  clearInterval(guard);`,
    `}`,
    `process.stdout.write('FAILCHILD:' + JSON.stringify(results) + '\\n');`,
    `// deliberately no process.exit: the process must exit on its own`,
  ].join('\n'), 'utf8');

  const childOutcome = await runOwnedChild(fixturePath, 15_000);
  check('reader: the failing child exited NATURALLY with code 0 (readline/timer/listeners released)',
    !childOutcome.timedOut && childOutcome.cleanupError === null && childOutcome.code === 0,
    `exit=${String(childOutcome.code)} timedOut=${childOutcome.timedOut} cleanup=${String(childOutcome.cleanupError)}`);
  check('reader: every failing path in the child rejected (EOF, timeout, input error)',
    /FAILCHILD:\["REJECTED:[^"]*","REJECTED:[^"]*","REJECTED:[^"]*"\]/.test(childOutcome.out), childOutcome.out.trim());
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
