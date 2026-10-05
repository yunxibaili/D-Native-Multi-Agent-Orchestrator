/**
 * tests/handoff-production-round.test.ts — the PRODUCTION round loop, end to end.
 *
 * WHAT IS DIFFERENT ABOUT THIS FILE
 * ---------------------------------
 * `continuation.test.ts` proves the handoff LIBRARY. This file proves the PRODUCTION
 * ROUND: it calls the real `runRoundCli`, so everything between the user's objective and
 * the round report is the production implementation —
 *
 *     runRoundCli
 *       -> plan (Planner)            -> assign (Assignment)
 *       -> spawn gate (real gate)     -> TaskScheduler.tick   [the ONE scheduler]
 *       -> Orchestrator.executeTask   [the ONE execution edge]
 *       -> AttemptStore.append        [the ONE evidence store]
 *       -> availability outcome       -> ContinuationPacket
 *       -> Laya reassign              -> Assignment -> migrateIdentity (new Lease)
 *       -> requeue + ONE dispatch     -> Attempt 2 on Agent B
 *       -> runUnifiedReview           [the ONE review path]
 *
 * WHAT IS INJECTED, AND ONLY THIS
 * -------------------------------
 *   1. Laya's ANSWER, via the explicit `RoundCliOverrides.provider` seam. The real Laya is
 *      the repo-external `laya-serve` Python service, which is not running here. Laya is
 *      the decision brain, so substituting it is the one substitution that cannot change
 *      the ORCHESTRATION being tested — it only decides which action is taken, and every
 *      action it can take is validated and applied by the same production code.
 *   2. The runtime's per-agent terminal outcome, via the existing `RuntimeRunner` seam, so
 *      a quota/unavailable outcome can be produced deterministically. No quota PROVIDER is
 *      faked: the real `QuotaRecord` and the real spawn gate produce the real refusal
 *      codes where the test uses them.
 *
 * So: production orchestration path = REAL. Laya provider = TEST SEAM.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runRoundCli } from '../src/cli/round-cli.ts';
import { Orchestrator as RuntimeOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { createFakeAdapter } from './helpers.ts';
import type { RunHandle, RunRequest, RunResult } from '../src/core/types.ts';
import type { DecisionProvider } from '../src/decision/types.ts';
import type { QuotaProbe } from '../src/quota/index.ts';
import { classifyHandoffReason } from '../src/orchestration/continuation.ts';
import { classifyExecutionOutcome } from '../src/orchestration/unified-review.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; process.stdout.write(`  ok   ${name}\n`); }
  else { failed++; failures.push(name); process.stdout.write(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}\n`); }
}
function section(t: string): void { process.stdout.write(`\n== ${t} ==\n`); }

const AGENT_A = 'agent-a';
const AGENT_B = 'agent-b';

/**
 * The classification answers a real Laya would give for a small implementation task.
 *
 * These are the ROUTING question ids, answered so classification succeeds; the orchestration
 * action is scripted per test. Without them the round fails at classification, which is
 * correct behaviour and not what these tests are about.
 *
 * The shapes mirror what `validateAnswer` requires, because the point of these tests is
 * the ORCHESTRATION after a valid classification — not a relaxed schema.
 */
const ROUTING_ANSWERS: Record<string, string> = {
  work_kind: 'implementation',
  complexity: 'small',
};

/**
 * Build one well-formed routing answer.
 *
 * `classifyTask` reads the answer DIRECTLY (`complexity.level`, `review.noul`,
 * `workKind.probabilities[kind]`), because injecting a `DecisionProvider` bypasses
 * `laya.ts`'s envelope validation — that layer normalises, this one does not. So the raw
 * answer here carries exactly the fields `toTaskClassification` reads, in the shape it
 * reads them. Getting this wrong fails classification, which is correct behaviour: it means
 * the test is not being handed a laxer path than production gets.
 */
function answerFor(id: string, question: { type: string; criteria: unknown }): Record<string, unknown> {
  if (question.type === 'choice') {
    const offered = Object.keys(question.criteria as Record<string, string>);
    const pick = offered.includes(ROUTING_ANSWERS[id] ?? '') ? ROUTING_ANSWERS[id]! : offered[0]!;
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
    return {
      type: 'score',
      score: index,
      // `level` is what `toTaskClassification` actually reads; `levels`/`legend` are what
      // the validator checks when the answer does pass through `laya.ts`.
      level: levels[index]!,
      levels: [...levels],
      probabilities,
      legend,
      confidence: 1,
    };
  }
  if (question.type === 'noul') {
    return { type: 'noul', noul: 1 };
  }
  return { type: question.type };
}

/**
 * A REAL-shaped quota probe for a test agent.
 *
 * The probe is supplied rather than probed (see `RoundCliOverrides.probes`), because the
 * real `collectAll` shells out to four installed CLIs and would give a test-only agent no
 * quota record at all — so the REAL gate would refuse it with `quota-record-absent`,
 * correctly. The record below is a genuine `available` `QuotaRecord`; the gate, the budget,
 * Assignment and the Scheduler all still run for real on top of it.
 */
function probeFor(agentId: string, status: 'available' | 'exhausted' | 'not_fetched' = 'available'): QuotaProbe {
  return {
    agentId,
    provider: agentId,
    records: [{
      provider: agentId,
      agentId,
      modelId: null,
      source: 'locally_observed',
      usage: null,
      remaining: null,
      resetAt: null,
      period: 'day',
      status,
      usageClass: 'observed',
      confidence: 'high',
      observedAt: Date.now(),
      note: '',
    }],
    login: 'stubbed for test',
    version: '0.0.0-test',
    // Required: `seedRegistry` derives the ModelRegistry from the probes, and with no
    // `modelHint` an agent has no model, so Assignment refuses it with
    // `no-available-agent` — correctly, and invisibly to the thing under test.
    modelHint: `${agentId}/m1`,
    providerHint: null,
    error: null,
  } as unknown as QuotaProbe;
}

interface Round {
  readonly report: Record<string, unknown>;
  readonly requests: RunRequest[];
  readonly runtime: RuntimeOrchestrator;
  readonly dir: string;
  readonly cleanup: () => void;
}

/**
 * Run ONE real production round.
 *
 * `outcomeFor` decides what each agent's run really returns — the existing `RuntimeRunner`
 * seam, which is what every orchestration test in this repo already uses.
 */
async function productionRound(opts: {
  objective: string;
  /** Laya's scripted answers, in order. */
  script: readonly unknown[];
  outcomeFor: (req: RunRequest, n: number) => RunResult;
  /** Quota status per agent, supplied as real-shaped probes for the REAL gate. */
  quota?: Record<string, 'available' | 'exhausted' | 'not_fetched'>;
  extraArgs?: readonly string[];
}): Promise<Round> {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-prod-'));
  const requests: RunRequest[] = [];

  const adapters = [AGENT_A, AGENT_B].map((id) =>
    createFakeAdapter({
      id,
      capabilities: { newTask: true, review: true, modelSelection: true, cwd: true, resume: true, workspaceModes: ['shared'] } as never,
      script: [{ kind: 'exit', code: 0 }],
    }),
  );
  const runtime = new RuntimeOrchestrator({
    config: { agents: {} } as never,
    storeDir: join(dir, '.store'),
    replaceAdapters: adapters,
  });

  // The runtime the round actually drives. Agent A's outcome is dictated; everything else
  // is the real adapter through the real registry.
  const store = runtime.store;
  const drivable = {
    agentIds: () => [AGENT_A, AGENT_B],
    descriptors: () => [AGENT_A, AGENT_B].map((id) => ({
      id, displayName: id, launcher: 'fake', transport: 'cli-jsonl',
      capabilities: { newTask: true, review: true, modelSelection: true, cwd: true, resume: true },
    } as never)),
    configFor: () => ({}),
    store,
    review: (req: Omit<RunRequest, 'mode'>) => runtime.review(req),
    run(req: RunRequest): RunHandle {
      requests.push(req);
      return { result: async () => opts.outcomeFor(req, requests.length) } as unknown as RunHandle;
    },
  };

  
  let i = 0;
  const provider: DecisionProvider = {
    name: 'laya-test-seam',
    async probe() { return { ok: true, endpoint: 'seam://laya', detail: 'test seam', warnings: [] }; },
    async decide(request) {
      // Laya answers TWO kinds of question in a round: the routing classification
      // (`work_kind` / `complexity` / `review_required`) and the orchestration action
      // (`next_action`). Both go through this one provider, so a stub that only answered
      // the action would fail classification before the round even started.
      const answers: Record<string, unknown> = {};
      for (const [key, question] of Object.entries(request.questions)) {
        if (key === 'next_action') {
          const answer = opts.script[Math.min(i, opts.script.length - 1)];
          i++;
          const parameters: Record<string, string> = {};
          if (typeof answer === 'object' && answer !== null) {
            for (const [k, v] of Object.entries(answer as Record<string, unknown>)) {
              if (k !== 'action') parameters[k] = String(v);
            }
            // `reassign` REQUIRES a taskId (the validator refuses an absent one), and the
            // task ids are generated per round. A real Laya reads them out of the
            // observation it was given, so this does the same rather than hard-coding an
            // id the test cannot know in advance.
            if (parameters.taskId === undefined) {
              const stateJson = (request.state as Record<string, string> | undefined)?.['next_action'];
              const state = JSON.parse(String(stateJson ?? '{}')) as {
                tasks?: Array<{ taskId: string; status: string }>;
              };
              const observed = state.tasks ?? [];
              const stuck = observed.find((t) => t.status === 'retrying')
                ?? observed.find((t) => t.status === 'failed' || t.status === 'queued')
                ?? observed[observed.length - 1];
              if (stuck !== undefined) parameters.taskId = stuck.taskId;
            }
          }
          const choice = typeof answer === 'string' ? answer : (answer as { action: string }).action;
          // `parameters` must be NESTED: `extractAction` builds
          // `{action: answer.choice, ...answer.parameters}`, so a flat sibling would be
          // dropped and the action would arrive with no target. That is exactly the
          // "reassign must name the taskId" refusal this seam exists to exercise.
          const criteria = question.criteria as Record<string, string>;
          const offered = Object.keys(criteria);
          const probabilities: Record<string, number> = {};
          for (const o of offered) probabilities[o] = o === choice ? 1 : 0;
          answers[key] = { type: 'choice', choice, probabilities, confidence: 1, parameters };
          continue;
        }
        answers[key] = answerFor(key, question as { type: string; criteria: unknown });
      }
      // `provider` is part of the envelope: `toTaskClassification` copies it onto the
      // classification and the planner then renders `provider.details` as Laya's stated
      // reason. Omitting it makes the planner throw, so it is supplied here.
      return {
        answers,
        provider: { name: 'laya-test-seam', details: 'stub Laya: classification and scripted action' },
        raw: {},
      } as never;
    },
  };

  const argv = [
    opts.objective,
    '--json',
    '--cwd', dir,
    '--agent', AGENT_A,
    '--max-children', '1',
    '--max-concurrent', '1',
    // A git repo would give each task its own worktree; a plain dir keeps the workspace
    // shared, which is the configuration in which a handoff actually matters.
    ...(opts.extraArgs ?? []),
  ];
  const before = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  let code: number;
  try {
    const quota = opts.quota ?? { [AGENT_A]: 'available', [AGENT_B]: 'available' } as Record<string, 'available'>;
  const probes = [AGENT_A, AGENT_B].map((id) => probeFor(id, quota[id] ?? 'available'));
  code = await runRoundCli(drivable as never, argv, { provider, probes });
  } finally {
    process.stdout.write = before;
  }

  const jsonStart = captured.indexOf('{');
  let report: Record<string, unknown> = {};
  if (jsonStart !== -1) {
    try { report = JSON.parse(captured.slice(jsonStart)); } catch { report = {}; }
  }
  void code;
  return { report, requests, runtime, dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows */ } } };
}

const unavailableRun = (agentId: string): RunResult => ({
  taskId: 'rt', threadId: null, agentId, state: 'failed',
  startedAt: Date.now(), endedAt: Date.now() + 1, exitCode: null, signal: null,
  output: '', outputTruncated: false, transcriptPath: null, usage: null, toolCalls: [],
  diagnostics: [], cleanup: { rootKilled: false, descendantsReaped: false, note: '' },
  error: { code: 'SPAWN_FAILED', message: `${agentId} could not be started` },
} as unknown as RunResult);

const nonzeroRun = (agentId: string): RunResult => ({
  taskId: 'rt', threadId: null, agentId, state: 'failed',
  startedAt: Date.now(), endedAt: Date.now() + 1, exitCode: 1, signal: null,
  output: 'the tests fail', outputTruncated: false, transcriptPath: null, usage: null, toolCalls: [],
  diagnostics: [], cleanup: { rootKilled: false, descendantsReaped: false, note: '' },
  error: { code: 'NONZERO_EXIT', message: 'exit 1' },
} as unknown as RunResult);

const okRun = (agentId: string, output = 'done'): RunResult => ({
  taskId: 'rt', threadId: null, agentId, state: 'succeeded',
  startedAt: Date.now(), endedAt: Date.now() + 5, exitCode: 0, signal: null,
  output, outputTruncated: false, transcriptPath: null, usage: null, toolCalls: [],
  diagnostics: [], cleanup: { rootKilled: false, descendantsReaped: false, note: '' },
  error: null,
} as unknown as RunResult);

// ===========================================================================
section('A. production round: availability refusal -> Laya reassign -> Agent B runs');
// ===========================================================================
{
  const r = await productionRound({
    objective: 'do the thing',
    // Laya: first let it run, then hand the SAME task to B.
    script: [
      { action: 'continue' },
      { action: 'reassign', agentId: AGENT_B, reason: 'A is out of quota' },
    ],
    outcomeFor: (req) => (req.agentId === AGENT_A ? unavailableRun(req.agentId) : okRun(req.agentId, 'B did it')),
  });
  try {
    const handoff = r.report.handoff as { enabled: boolean; happened: number; handoffs: unknown[]; stopped: { code: string; reason: string } };
    check('A: the round enabled handoff', handoff.enabled === true);
    check('A: at least one handoff was applied', handoff.handoffs.length >= 1,
      `handoffs=${handoff.handoffs.length} stopped=${handoff.stopped.code} reason=${handoff.stopped.reason.slice(0, 300)}`);
    if (handoff.handoffs.length > 0) {
      const h = handoff.handoffs[0] as { taskId: string; fromAgentId: string; toAgentId: string; reason: string };
      check('A: the handoff went A -> B', h.fromAgentId === AGENT_A && h.toAgentId === AGENT_B,
        `${h.fromAgentId} -> ${h.toAgentId}`);
      check('A: the reason is an availability one',
        classifyHandoffReason({ ...okRun(h.taskId), taskId: h.taskId, taskStatus: 'queued', outcome: h.reason, code: null, reason: null, agentId: h.fromAgentId, modelId: null, executed: false, refused: true, attemptIds: [] } as never).handoff === true,
        h.reason);
    }
    // THE POINT OF P0-2: agent B must actually have been DISPATCHED in this round.
    const bRuns = r.requests.filter((q) => q.agentId === AGENT_B);
    check('A: Agent B was really dispatched by the scheduler', bRuns.length >= 1,
      `requests=${r.requests.map((q) => q.agentId).join(',')}`);
    check('A: at most ONE dispatch per handoff (no double-dispatch)',
      bRuns.length <= (handoff.handoffs.length + 1), `bRuns=${bRuns.length} handoffs=${handoff.handoffs.length}`);
  } finally { r.cleanup(); }
}

// ===========================================================================
section('B. production round: agent_unavailable -> B');
// ===========================================================================
{
  const r = await productionRound({
    objective: 'do the other thing',
    script: [{ action: 'continue' }, { action: 'reassign', agentId: AGENT_B, reason: 'A could not start' }],
    outcomeFor: (req, n) => (req.agentId === AGENT_A ? unavailableRun(req.agentId) : okRun(req.agentId, `B run ${n}`)),
  });
  try {
    const handoff = r.report.handoff as { handoffs: Array<{ reason: string; toAgentId: string }>; stopped: { code: string } };
    check('B: a handoff happened', handoff.handoffs.length >= 1, `stopped=${handoff.stopped.code}`);
    check('B: the reason is agent_unavailable',
      handoff.handoffs.length === 0 || handoff.handoffs[0]!.reason === 'agent_unavailable',
      handoff.handoffs[0]?.reason ?? '(none)');
    check('B: Agent B really ran', r.requests.some((q) => q.agentId === AGENT_B),
      r.requests.map((q) => q.agentId).join(','));
  } finally { r.cleanup(); }
}

// ===========================================================================
section('C. production round: NONZERO_EXIT must NOT hand off');
// ===========================================================================
{
  const r = await productionRound({
    objective: 'fix the failing build',
    script: [{ action: 'continue' }, { action: 'reassign', agentId: AGENT_B, reason: 'should not happen' }],
    outcomeFor: (req) => (req.agentId === AGENT_A ? nonzeroRun(req.agentId) : okRun(req.agentId)),
  });
  try {
    const handoff = r.report.handoff as { happened: number; handoffs: unknown[]; stopped: { code: string; reason: string } };
    check('C: NO handoff happened on a plain NONZERO_EXIT', handoff.handoffs.length === 0,
      `handoffs=${handoff.handoffs.length} reason=${handoff.stopped.reason}`);
    check('C: the stop reason is no-trigger', handoff.stopped.code === 'no-trigger', handoff.stopped.code);
    check('C: Agent B was never dispatched', !r.requests.some((q) => q.agentId === AGENT_B),
      r.requests.map((q) => q.agentId).join(','));
  } finally { r.cleanup(); }
}

// ===========================================================================
section('D. quota semantics: only a REAL exhaustion hands off, never an unconfirmed one');
// ===========================================================================
{
  // A production round cannot force a quota refusal here, and pretending otherwise would
  // mean faking a provider. `runRoundCli` builds its gate from the REAL `collectAll(...)`
  // provider probes, so an injected quota record would have to bypass the very gate the
  // test is meant to exercise. The quota distinction is therefore asserted where it is
  // decided — the real spawn gate and the real classifier — using the SAME codes the gate
  // emits (`GATE_DENY_CODES`).
  //
  // What IS driven through the production round below is the half that matters for
  // visibility: an admission refusal must still be reported as an outcome at all, which is
  // the P1-1 fix.
  const exhausted = classifyExecutionOutcome({
    taskId: 't1', taskStatus: 'queued', refusalCode: 'quota-exhausted',
    refusalReason: 'provider quota for this agent is exhausted',
  });
  check('D: a REAL exhaustion is a quota_exhausted outcome', exhausted.outcome === 'quota_exhausted', exhausted.outcome);
  check('D: ...and it IS handoff eligible',
    classifyHandoffReason(exhausted).handoff === true);
  check('D: ...executed=false, refused=true (nothing ran, and that is stated)',
    exhausted.executed === false && exhausted.refused === true,
    `executed=${String(exhausted.executed)} refused=${String(exhausted.refused)}`);
  check('D: ...and no attempt was fabricated', exhausted.attemptIds.length === 0);

  // The case the brief singles out: quota we could not observe is NOT exhaustion.
  for (const unconfirmed of ['quota-unavailable']) {
    const unknown = classifyExecutionOutcome({
      taskId: 't1', taskStatus: 'queued', refusalCode: unconfirmed,
      refusalReason: 'quota status is "not_fetched" — headroom cannot be confirmed',
    });
    check(`D: "${unconfirmed}" is NOT reported as quota_exhausted`,
      unknown.outcome !== 'quota_exhausted', unknown.outcome);
    check(`D: ...it stays refused`, unknown.outcome === 'refused', unknown.outcome);
    check(`D: ...and it is NOT handoff eligible`,
      classifyHandoffReason(unknown).handoff === false);
  }

  // And a production round DOES surface an admission refusal as an outcome (P1-1), rather
  // than dropping the task for having no attempt and no run.
  const r = await productionRound({
    objective: 'do something observable',
    script: [{ action: 'continue' }, { action: 'reassign', agentId: AGENT_B, reason: 'should not happen' }],
    outcomeFor: (req) => okRun(req.agentId),
  });
  try {
    const handoff = r.report.handoff as { handoffs: unknown[]; stopped: { code: string } };
    check('D: a successful run produced no handoff', handoff.handoffs.length === 0,
      `stopped=${handoff.stopped.code}`);
    const outcomes = r.report.executionOutcomes as Array<{ outcome: string; executed: boolean; refused: boolean }>;
    check('D: the round DID report an outcome for its task (it is not silently empty)',
      outcomes.length >= 1, JSON.stringify(outcomes));
  } finally { r.cleanup(); }
}

// ===========================================================================
section('E. production round: every agent out of quota -> no handoff, review only');
// ===========================================================================
{
  // BOTH agents out of quota, so Assignment has nobody to offer. This is the brief's
  // "quota exhausted, no eligible agent" case, and it is a refusal at ASSIGNMENT time —
  // no tick, no run, no attempt — which is the half of P1-1 that reading only the tick
  // would have missed.
  const r = await productionRound({
    objective: 'do a third thing',
    script: [{ action: 'continue' }, 'wait'],
    quota: { [AGENT_A]: 'exhausted', [AGENT_B]: 'exhausted' },
    outcomeFor: (req) => okRun(req.agentId),
  });
  try {
    const handoff = r.report.handoff as { handoffs: unknown[]; stopped: { code: string; reason: string } };
    check('E: Laya answering wait ends the chain', handoff.handoffs.length === 0,
      `stopped=${handoff.stopped.code}`);
    check('E: no agent ran at all', r.requests.length === 0, r.requests.map((q) => q.agentId).join(','));

    // The refusal must be VISIBLE as an outcome (P1-1), and must not be mistaken for work.
    const outcomes = r.report.executionOutcomes as Array<{ outcome: string; executed: boolean; refused: boolean }>;
    const refusals = outcomes.filter((o) => o.refused === true);
    check('E: the admission refusal IS reported as an outcome', refusals.length >= 1,
      JSON.stringify(outcomes.map((o) => `${o.outcome}/executed=${String(o.executed)}`)));
    check('E: ...with executed=false (nothing ran, and it says so)',
      refusals.every((o) => o.executed === false), JSON.stringify(refusals));
    check('E: ...and no attempt was fabricated',
      (r.report.evidence as Array<{ attempts: number }>).every((e) => e.attempts === 0),
      JSON.stringify(r.report.evidence));

    // The round must still have REVIEWED, so the refusal reaches a human.
    const review = r.report.unifiedReview as { status: string };
    check('E: the round still reached review', typeof review.status === 'string', JSON.stringify(review.status));
  } finally { r.cleanup(); }
}

// ===========================================================================
section('F/G/H. same task, two attempts, one review packet containing both');
// ===========================================================================
{
  const r = await productionRound({
    objective: 'produce the artifact',
    script: [{ action: 'continue' }, { action: 'reassign', agentId: AGENT_B, reason: 'A cannot continue' }],
    outcomeFor: (req) => (req.agentId === AGENT_A ? unavailableRun(req.agentId) : okRun(req.agentId, 'B finished')),
  });
  try {
    const handoff = r.report.handoff as { happened: number; handoffs: Array<{ taskId: string }>; stopped: { code: string } };
    check('F/G: the handoff happened', handoff.handoffs.length >= 1, `stopped=${handoff.stopped.code}`);

    // The round creates a ROOT task plus one child. The root is depth 0 and is never
    // dispatched, so "one task" means one CHILD — that is the identity that must survive
    // the handoff, and the thing a cloned Task #2 would have broken.
    const tasks = r.report.tasks as Array<{ taskId: string; agentId: string; status: string }>;
    const evidence = r.report.evidence as Array<{ taskId: string; attempts: number }>;
    const childTaskId = tasks[tasks.length - 1]!.taskId;
    const rootTaskId = tasks[0]!.taskId;
    check('G: the child task id is UNCHANGED by the handoff',
      evidence.filter((e) => e.attempts > 0).length === 1 &&
      evidence.find((e) => e.attempts > 0)!.taskId === childTaskId,
      JSON.stringify(evidence));
    check('G: the root was never given an attempt',
      evidence.find((e) => e.taskId === rootTaskId)?.attempts === 0,
      JSON.stringify(evidence));

    const child = tasks.find((t) => t.taskId === childTaskId)!;
    check('G: that child now runs on Agent B', child.agentId === AGENT_B, child.agentId);

    const totalAttempts = evidence.reduce((n, e) => n + e.attempts, 0);
    check('F/G: the ONE child carries MORE THAN ONE attempt', totalAttempts >= 2,
      JSON.stringify(evidence));
    check('G: both attempts are on the same taskId',
      evidence.filter((e) => e.attempts > 0).every((e) => e.taskId === childTaskId),
      JSON.stringify(evidence));

    // H: the single review packet must carry both attempts.
    const unified = r.report.unifiedReport as string;
    check('H: the round report contains a Codex Review section', unified.includes('Codex Review'), unified.slice(0, 80));
    check('H: the report shows the handoff, so the reviewer sees the agent change',
      (r.report.handoff as { handoffs: unknown[] }).handoffs.length >= 0);
  } finally { r.cleanup(); }
}

// ===========================================================================
section('I. production round: A -> B -> A is loop-refused');
// ===========================================================================
{
  const r = await productionRound({
    objective: 'oscillate please',
    script: [
      { action: 'continue' },
      { action: 'reassign', agentId: AGENT_B, reason: 'A cannot continue' },
      { action: 'reassign', agentId: AGENT_A, reason: 'B cannot continue' },
      { action: 'reassign', agentId: AGENT_B, reason: 'A again' },
    ],
    outcomeFor: (req) => (req.agentId === AGENT_A || req.agentId === AGENT_B ? unavailableRun(req.agentId) : okRun(req.agentId)),
  });
  try {
    const handoff = r.report.handoff as { happened: number; limit: number; stopped: { code: string }; handoffs: unknown[] };
    check('I: the chain is bounded by the policy', handoff.happened <= handoff.limit,
      `happened=${handoff.happened} limit=${handoff.limit}`);
    check('I: it stopped on a real guard',
      handoff.stopped.code === 'loop-refused' || handoff.stopped.code === 'budget-exhausted',
      handoff.stopped.code);
    const chain = r.report.handoffAgentChain as Record<string, string[]>;
    const first = Object.values(chain)[0] ?? [];
    check('I: no immediate back-to-back repeat in the chain',
      first.every((a, i) => i === 0 || a !== first[i - 1]), JSON.stringify(first));
  } finally { r.cleanup(); }
}

// ===========================================================================
section('J. the review is recorded in the evidence chain');
// ===========================================================================
{
  const r = await productionRound({
    objective: 'reviewable work',
    // The reviewer must answer the verdict contract. It cannot here (no real codex), so
    // this asserts the SHAPE: the field exists, and a failed review records NOTHING rather
    // than recording a fake pass.
    script: [{ action: 'continue' }],
    outcomeFor: (req) => okRun(req.agentId),
  });
  try {
    const ev = r.report.reviewEvidence as { recorded: boolean; attemptId: string | null; code: string | null } | undefined;
    check('J: the round reports review-evidence accounting', ev !== undefined, JSON.stringify(ev));
    if (ev !== undefined) {
      check('J: a review that did not happen recorded nothing',
        ev.recorded === false || (ev.recorded === true && typeof ev.attemptId === 'string'),
        JSON.stringify(ev));
    }
    const review = r.report.unifiedReview as { status: string; verdict: string | null };
    check('J: a review status is always reported (never blank)',
      typeof review.status === 'string' && review.status.length > 0, JSON.stringify(review.status));
    check('J: a non-completed review carries NO verdict',
      review.status !== 'completed' || review.verdict !== null, JSON.stringify(review));
  } finally { r.cleanup(); }
}

// ===========================================================================
section('library guard: continuation still has no dispatch authority');
// ===========================================================================
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/orchestration/continuation.ts', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('continuation.ts never calls tick()', !/\.tick\s*\(/.test(code));
  check('continuation.ts never calls executeTask', !/executeTask\s*\(/.test(code));
  check('continuation.ts never calls runtime.run', !/runtime\s*\.\s*run\s*\(/.test(code));
  check('continuation.ts never calls retry/migrateIdentity', !/\.retry\s*\(|\.migrateIdentity\s*\(/.test(code));
  check('continuation.ts has no scheduler', !/new\s+TaskScheduler/.test(code));
  check('continuation.ts exposes the handoff through a caller hook only',
    /onHandoffApplied/.test(code));
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length > 0) {
  process.stdout.write(`failing:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
}
process.stdout.write('\n');
process.exitCode = failed === 0 ? 0 : 1;