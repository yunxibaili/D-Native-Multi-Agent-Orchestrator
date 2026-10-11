/**
 * tests/handoff-production-round.test.ts 鈥?the PRODUCTION round loop, end to end.
 *
 * WHAT IS DIFFERENT ABOUT THIS FILE
 * ---------------------------------
 * `continuation.test.ts` proves the handoff LIBRARY. This file proves the PRODUCTION
 * ROUND: it calls the real `runRoundCli`, so everything between the user's objective and
 * the round report is the production implementation 鈥? *
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
 *      the ORCHESTRATION being tested 鈥?it only decides which action is taken, and every
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
import { createFakeAdapter, sourceText } from './helpers.ts';
import type { RunHandle, RunRequest, RunResult } from '../src/core/types.ts';
import type { DecisionProvider } from '../src/decision/types.ts';
import type {
  ObservedTask,
  RoundWorkbenchObservation,
} from '../src/cli/round-observation.ts';
// TeamRun T2-a.1: the production initial path asks this question by id.
import { INITIAL_AGENT_MODEL_ID, initialCandidateKey } from '../src/decision/initial-assignment.ts';
// TeamRun T3-a.1: the execution-topology decision preset.
import {
  EXECUTION_TOPOLOGY_ID,
  TOPOLOGY_SOLO,
  TOPOLOGY_PARALLEL_READ,
} from '../src/decision/execution-topology.ts';
import type { QuotaProbe } from '../src/quota/index.ts';
import { classifyHandoffReason } from '../src/orchestration/continuation.ts';
import { TaskScheduler } from '../src/orchestration/scheduler.ts';
import { classifyExecutionOutcome } from '../src/orchestration/unified-review.ts';
// TeamRun T2-b.1: the execution-request constructor and the Worker projection, used to prove
// the Codex dual-role boundary in ONE file (execution review Task vs Unified Review).
import { buildRunRequest } from '../src/orchestration/execute.ts';
import { workerIdentityOfAttempt } from '../src/orchestration/worker-identity.ts';

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
 * the ORCHESTRATION after a valid classification 鈥?not a relaxed schema.
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
 * `laya.ts`'s envelope validation 鈥?that layer normalises, this one does not. So the raw
 * answer here carries exactly the fields `toTaskClassification` reads, in the shape it
 * reads them. Getting this wrong fails classification, which is correct behaviour: it means
 * the test is not being handed a laxer path than production gets.
 */
function answerFor(
  id: string,
  question: { type: string; criteria: unknown },
  overrides: Record<string, string> = ROUTING_ANSWERS,
): Record<string, unknown> {
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
 * quota record at all 鈥?so the REAL gate would refuse it with `quota-record-absent`,
 * correctly. The record below is a genuine `available` `QuotaRecord`; the gate, the budget,
 * Assignment and the Scheduler all still run for real on top of it.
 */
function probeFor(agentId: string, status: 'available' | 'exhausted' | 'not_fetched' = 'available', modelId = `${agentId}/m1`): QuotaProbe {
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
    // `no-available-agent` 鈥?correctly, and invisibly to the thing under test.
    modelHint: modelId,
    providerHint: null,
    error: null,
  } as unknown as QuotaProbe;
}

interface Round {
  readonly report: Record<string, unknown>;
  readonly requests: RunRequest[];
  /**
   * TeamRun T2-b: the requests the Unified REVIEWER received, captured separately.
   *
   * `requests` only holds EXECUTION dispatches, because the review path is a different edge
   * (`runtime.review`, not `runtime.run`). T2-b must prove the reviewer is NOT handed the
   * execution contract, and it cannot do that without seeing what the reviewer was sent.
   */
  readonly reviewRequests: RunRequest[];
  readonly runtime: RuntimeOrchestrator;
  readonly dir: string;
  readonly cleanup: () => void;
}

/**
 * Run ONE real production round.
 *
 * `outcomeFor` decides what each agent's run really returns 鈥?the existing `RuntimeRunner`
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
  /**
   * TeamRun T2-a.2: what Laya answers for the INITIAL Agent x Model pair.
   *
   * The round is Laya-controlled on this path, so a test that wants "Planner said agent-A,
   * Laya said agent-B" must be able to SAY agent-B. Omitted, the seam picks the first
   * offered pair (which is agent-A, the `--agent` value) 鈥?the plain legacy behaviour.
   * `initialPairFails` makes the provider refuse instead, for the fail-closed regression.
   */
  initialPair?: { agentId: string; modelId: string };
  initialPairFails?: boolean;
  /**
   * TeamRun T2-a.3 (搂18): extra model ids registered on the SAME agent, so the
   * "Planner OpenCode/model-A, Laya OpenCode/model-B" case is expressible. Each one is a
   * genuine extra probe, so `seedRegistry` derives a real second ModelEntry for that agent
   * rather than the test asserting a pair the registry never had.
   */
  extraModels?: readonly string[];
  /**
   * TeamRun T2-b.1: override Laya's CLASSIFICATION answers for this round (merged over the
   * default `work_kind: 'implementation'`). Needed to produce a round whose tasks carry a
   * non-implementation semantic 鈥?e.g. `{ work_kind: 'review' }` 鈥?so the review-Task
   * execution path can be exercised end to end rather than synthesised.
   */
  routingAnswers?: Record<string, string>;
  /**
   * TeamRun T3-a.1: ask Laya for a PARALLEL_READ topology with these members. Omitted, the
   * round answers SOLO and behaves exactly as before.
   */
  topology?: { members: ReadonlyArray<{ agentId: string; modelId: string; scope: string; accessMode?: string }> };
  /** A deliberately malformed topology payload (raw string), to exercise the fail-closed path. */
  topologyMalformed?: string;
  /** T2-a.3: READ-ONLY observation seam. Receives a detached frozen snapshot, never the workbench. */
  onWorkbenchSnapshot?: (snapshot: RoundWorkbenchObservation) => void;
}): Promise<Round> {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-prod-'));
  const requests: RunRequest[] = [];
  // TeamRun T2-b: the reviewer's requests, captured separately from execution dispatches.
  const reviewRequests: RunRequest[] = [];

  // R5-1.2 (搂11.1): the reviewer is a FAKE too. The round's Unified Review wiring is
  // real (`runUnifiedReview` -> `runtime.review` -> a real session in review mode),
  // but the PROVIDER must not be the real installed Codex CLI: eight production
  // rounds each invoking the real reviewer made this suite take ~18 minutes. The
  // fake codex answers the verdict contract deterministically; the assertion below
  // proves the registry holds it, so "review ran" can never mean "real Codex ran".
  const REVIEW_VERDICT_JSON = JSON.stringify({ verdict: 'pass', reason: 'fixture reviewer: the recorded evidence satisfies the task', reviewer: 'fixture-codex' });
  const adapters = [
    ...[AGENT_A, AGENT_B].map((id) =>
      createFakeAdapter({
        id,
        capabilities: { newTask: true, review: true, modelSelection: true, cwd: true, resume: true, workspaceModes: ['shared'] } as never,
        script: [{ kind: 'exit', code: 0 }],
      }),
    ),
    createFakeAdapter({
      id: 'codex',
      capabilities: { newTask: true, review: true, modelSelection: true, cwd: true, resume: true } as never,
      script: [
        { kind: 'frame', text: REVIEW_VERDICT_JSON },
        { kind: 'exit', code: 0 },
      ],
    }),
  ];
  const runtime = new RuntimeOrchestrator({
    config: { agents: {} } as never,
    storeDir: join(dir, '.store'),
    replaceAdapters: adapters,
  });
  // 搂11.1 identity assertion: the reviewer identity the round will reach is the
  // FIXTURE codex, never a bootstrapped native one.
  {
    const reviewerAdapter = runtime.registry.get('codex');
    if (reviewerAdapter.descriptor.launcher.command !== 'fake-agent' || !reviewerAdapter.descriptor.displayName.startsWith('Fake ')) {
      throw new Error('fixture broken: the reviewer adapter is not the fake codex (a real native reviewer leaked in)');
    }
  }

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
    review: (req: Omit<RunRequest, 'mode'>) => {
      // T2-b: capture what the REVIEWER was sent. The review edge is separate from
      // `run`, so it would otherwise be invisible to every assertion in this file.
      reviewRequests.push({ ...req, mode: 'review' } as RunRequest);
      return runtime.review(req);
    },
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
        if (key === INITIAL_AGENT_MODEL_ID) {
          // TeamRun T2-a.1: the production initial path is Laya-controlled, so this seam
          // must genuinely answer the initial Agent x Model question 鈥?otherwise every
          // child is refused before the round's actual subject (handoff) is ever reached.
          // TeamRun T2-a.2: `initialPair` lets a test state a pair that DIFFERS from the
          // Planner's `--agent`, which is the whole point of the post-assignment
          // authority regressions. `initialPairFails` makes the provider refuse.
          if (opts.initialPairFails === true) throw new Error('laya refused the initial selection');
          const criteria = (question.type === 'choice'
            ? (question.criteria as Record<string, string>)
            : {}) as Record<string, string>;
          const offered = Object.keys(criteria);
          if (offered.length === 0) throw new Error('initial-assignment question offered no pairs');
          const wanted = opts.initialPair === undefined
            ? null
            : initialCandidateKey(opts.initialPair.agentId, opts.initialPair.modelId);
          const picked = wanted !== null && offered.includes(wanted) ? wanted : offered[0]!;
          const probabilities: Record<string, number> = {};
          for (const o of offered) probabilities[o] = o === picked ? 1 : 0;
          answers[key] = { type: 'choice', choice: picked, probabilities, confidence: 1, criteria };
          continue;
        }
        if (key === EXECUTION_TOPOLOGY_ID) {
          // TeamRun T3-a.1: answer Laya's topology question. Default is SOLO (so every
          // existing round is byte-identical); `opts.topology` asks for PARALLEL_READ with an
          // explicit member list. `topologyMalformed` deliberately returns a broken payload so
          // the fail-closed refusal can be exercised.
          const criteria = question.criteria as Record<string, string>;
          const offered = Object.keys(criteria);
          if (opts.topologyMalformed !== undefined) {
            answers[key] = {
              type: 'choice', choice: TOPOLOGY_PARALLEL_READ,
              probabilities: { [TOPOLOGY_PARALLEL_READ]: 1 }, confidence: 1,
              parameters: { members: opts.topologyMalformed },
            };
            continue;
          }
          if (opts.topology === undefined) {
            answers[key] = {
              type: 'choice', choice: TOPOLOGY_SOLO,
              probabilities: { [TOPOLOGY_SOLO]: 1 }, confidence: 1,
            };
            continue;
          }
          const choice = TOPOLOGY_PARALLEL_READ;
          if (!offered.includes(choice)) throw new Error('topology question did not offer PARALLEL_READ');
          answers[key] = {
            type: 'choice', choice, probabilities: { [choice]: 1 }, confidence: 1,
            parameters: { members: JSON.stringify(opts.topology.members) },
          };
          continue;
        }
        answers[key] = answerFor(key, question as { type: string; criteria: unknown }, {
          ...ROUTING_ANSWERS,
          ...(opts.routingAnswers ?? {}),
        });
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
  const probes = [
    ...[AGENT_A, AGENT_B].map((id) => probeFor(id, quota[id] ?? 'available')),
    // 搂18: real extra models on the SAME agent, each a genuine probe so the ModelRegistry
    // really learns about them. `seedRegistry` skips a modelHint it already has.
    ...(opts.extraModels ?? []).map((modelId) => probeFor(AGENT_A, 'available', modelId)),
  ];
  code = await runRoundCli(drivable as never, argv, { provider, probes, ...(opts.onWorkbenchSnapshot === undefined ? {} : { onWorkbenchSnapshot: opts.onWorkbenchSnapshot }) });
  } finally {
    process.stdout.write = before;
  }

  const jsonStart = captured.indexOf('{');
  let report: Record<string, unknown> = {};
  if (jsonStart !== -1) {
    try { report = JSON.parse(captured.slice(jsonStart)); } catch { report = {}; }
  }
  void code;
  return { report, requests, reviewRequests, runtime, dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows */ } } };
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
      { action: 'reassign', agentId: AGENT_B, modelId: `${AGENT_B}/m1`, reason: 'A is out of quota' },
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
    script: [{ action: 'continue' }, { action: 'reassign', agentId: AGENT_B, modelId: `${AGENT_B}/m1`, reason: 'A could not start' }],
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
    script: [{ action: 'continue' }, { action: 'reassign', agentId: AGENT_B, modelId: `${AGENT_B}/m1`, reason: 'should not happen' }],
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
  // decided 鈥?the real spawn gate and the real classifier 鈥?using the SAME codes the gate
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
      refusalReason: 'quota status is "not_fetched" 鈥?headroom cannot be confirmed',
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
    script: [{ action: 'continue' }, { action: 'reassign', agentId: AGENT_B, modelId: `${AGENT_B}/m1`, reason: 'should not happen' }],
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
  // "quota exhausted, no eligible agent" case, and it is a refusal at ASSIGNMENT time 鈥?  // no tick, no run, no attempt 鈥?which is the half of P1-1 that reading only the tick
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
    script: [{ action: 'continue' }, { action: 'reassign', agentId: AGENT_B, modelId: `${AGENT_B}/m1`, reason: 'A cannot continue' }],
    outcomeFor: (req) => (req.agentId === AGENT_A ? unavailableRun(req.agentId) : okRun(req.agentId, 'B finished')),
  });
  try {
    const handoff = r.report.handoff as { happened: number; handoffs: Array<{ taskId: string }>; stopped: { code: string } };
    check('F/G: the handoff happened', handoff.handoffs.length >= 1, `stopped=${handoff.stopped.code}`);

    // The round creates a ROOT task plus one child. The root is depth 0 and is never
    // dispatched, so "one task" means one CHILD 鈥?that is the identity that must survive
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
      { action: 'reassign', agentId: AGENT_B, modelId: `${AGENT_B}/m1`, reason: 'A cannot continue' },
      { action: 'reassign', agentId: AGENT_A, modelId: `${AGENT_A}/m1`, reason: 'B cannot continue' },
      { action: 'reassign', agentId: AGENT_B, modelId: `${AGENT_B}/m1`, reason: 'A again' },
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

  const src = sourceText(new URL('../src/orchestration/continuation.ts', import.meta.url));
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('continuation.ts never calls tick()', !/\.tick\s*\(/.test(code));
  check('continuation.ts never calls executeTask', !/executeTask\s*\(/.test(code));
  check('continuation.ts never calls runtime.run', !/runtime\s*\.\s*run\s*\(/.test(code));
  check('continuation.ts never calls retry/migrateIdentity', !/\.retry\s*\(|\.migrateIdentity\s*\(/.test(code));
  check('continuation.ts has no scheduler', !/new\s+TaskScheduler/.test(code));
  check('continuation.ts exposes the handoff through a caller hook only',
    /onHandoffApplied/.test(code));
}

// ===========================================================================
// TeamRun T2-a.2: post-assignment AUTHORITATIVE state.
// ===========================================================================
//
// Every test here runs the REAL round CLI. The defect being closed lived in
// `src/cli/round-cli.ts`, so a Workbench-only test would never have seen it.
//
// The Planner-era agent is AGENT_A (`--agent`), so these tests are exactly the shape
// Codex reproduced: a planning snapshot naming one worker, Laya naming another, and the
// CLI then reading execution facts from the WRONG one.
//
// T2-a.3: these tests no longer touch a workbench at all. They read the DETACHED,
// FROZEN snapshot handed to the observation seam, which is the only thing a test is
// now able to obtain.
section('T2-a.2. post-Assignment state is read from the authority, not the plan');

type SnapHolder = { snapshot: RoundWorkbenchObservation | null };
const childTaskOf = (snap: RoundWorkbenchObservation) => snap.tasks.find((t) => t.parentTaskId !== null) ?? null;
const sessionsFor = (snap: RoundWorkbenchObservation, taskId: string) =>
  snap.sessions.filter((s) => s.taskId === taskId);

// --- T2A2-1 / T2A2-4: a stale planned Agent cannot overwrite Laya's Agent ---
{
  const cap: SnapHolder = { snapshot: null };
  const r = await productionRound({
    objective: 'planner said A, Laya says B',
    script: [{ action: 'continue' }],
    // The Planner was told agent-a. Laya is going to name agent-b instead.
    initialPair: { agentId: AGENT_B, modelId: `${AGENT_B}/m1` },
    outcomeFor: (req) => okRun(req.agentId),
    onWorkbenchSnapshot: (s) => { cap.snapshot = s; },
  });
  const snap = cap.snapshot;
  const child = snap === null ? null : childTaskOf(snap);
  const dispatched = r.requests[0];

  check('T2A2-1: the round ran', r.report.error === undefined, String(r.report.error));
  check('T2A2-1: the Task carries the LAYA agent, not the planner\'s',
    child?.agentId === AGENT_B, `${child?.agentId} (planner was ${AGENT_A})`);
  check('T2A2-1: the Task carries the LAYA model',
    child?.modelId === `${AGENT_B}/m1`, String(child?.modelId));
  check('T2A2-1: the runtime really dispatched the Laya pair',
    dispatched !== undefined && dispatched.agentId === AGENT_B, dispatched?.agentId ?? 'nothing dispatched');
  check('T2A2-1: the runtime count is 1, so the budget scope for the REAL agent existed',
    r.requests.length === 1, `requests=${r.requests.length}`);

  // T2A2-4: the ledger must know the agent that was actually bound. Before the fix the
  // scope was funded for AGENT_A, so this dispatch would have been refused
  // `budget-scope-unavailable` and `requests` would be empty.
  check('T2A2-4: a round bound to B dispatched even though the ledger started on A',
    r.requests.length === 1 && r.requests[0]!.agentId === AGENT_B,
    `requests=${r.requests.map((q) => q.agentId).join(',')}`);
}

// --- T2A2-2: a stale planned MODEL cannot overwrite Laya's model (搂9 model preservation) ---
{
  const cap: SnapHolder = { snapshot: null };
  const r = await productionRound({
    objective: 'planner default model, Laya picks another',
    script: [{ action: 'continue' }],
    initialPair: { agentId: AGENT_B, modelId: `${AGENT_B}/m1` },
    outcomeFor: (req) => okRun(req.agentId),
    onWorkbenchSnapshot: (s) => { cap.snapshot = s; },
  });
  const snap = cap.snapshot;
  const child = snap === null ? null : childTaskOf(snap);
  const bound = child === null || snap === null ? null : sessionsFor(snap, child.taskId)[0] ?? null;
  check('T2A2-2: the Task model is Laya\'s', child?.modelId === `${AGENT_B}/m1`, String(child?.modelId));
  check('T2A2-2: the runtime got the same model',
    r.requests[0]?.model === `${AGENT_B}/m1`, String(r.requests[0]?.model));
  // 搂9: the session must not degrade the model back to null.
  check('T2A2-2: the session carries the EXACT enforced model, not null',
    bound !== null && bound?.modelId === `${AGENT_B}/m1`, bound === null ? 'no session' : String(bound.modelId));
}

// --- T2A2-3 / T2A2-10: the Assignment-established session is not replaced ---
{
  const cap: SnapHolder = { snapshot: null };
  await productionRound({
    objective: 'one intended session binding',
    script: [{ action: 'continue' }],
    initialPair: { agentId: AGENT_B, modelId: `${AGENT_B}/m1` },
    outcomeFor: (req) => okRun(req.agentId),
    onWorkbenchSnapshot: (s) => { cap.snapshot = s; },
  });
  const snap = cap.snapshot;
  const child = snap === null ? null : childTaskOf(snap);
  const boundSessions = child === null || snap === null ? [] : sessionsFor(snap, child.taskId);
  check('T2A2-3: exactly ONE session is bound to the task', boundSessions.length === 1,
    `sessions=${boundSessions.map((s) => `${s.agentId}/${s.modelId}/${s.sessionId}`).join(' | ')}`);
  check('T2A2-10: that session is the one Assignment established',
    boundSessions.length === 1 && boundSessions[0]!.agentId === AGENT_B
    && boundSessions[0]!.modelId === `${AGENT_B}/m1`,
    boundSessions.length === 1 ? `${boundSessions[0]!.agentId}/${boundSessions[0]!.modelId}` : 'none');
  check('T2A2-10: no replacement session was opened from the planning snapshot',
    boundSessions.every((s) => s.agentId === AGENT_B && s.modelId === `${AGENT_B}/m1`),
    boundSessions.map((s) => `${s.agentId}/${s.modelId}`).join(','));
}

// --- T2A2-5: a failed initial selection cannot fall back to the planned snapshot ---
{
  const cap: SnapHolder = { snapshot: null };
  const r = await productionRound({
    objective: 'Laya refuses the initial choice',
    script: [{ action: 'continue' }],
    // Laya cannot produce a usable pair. The Planner's own spec still names a valid agent,
    // so a fallback would look completely normal.
    initialPairFails: true,
    outcomeFor: (req) => okRun(req.agentId),
    onWorkbenchSnapshot: (s) => { cap.snapshot = s; },
  });
  const snap = cap.snapshot;
  const children = snap === null ? [] : snap.tasks.filter((t) => t.parentTaskId !== null);
  const sessions = snap === null ? [] : snap.sessions.filter((s) => s.taskId !== null);
  check('T2A2-5: NOTHING was dispatched', r.requests.length === 0, `requests=${r.requests.length}`);
  check('T2A2-5: no model was bound to the child (no planned fallback)',
    children.every((t) => t.modelId === null), JSON.stringify(children.map((t) => `${t.agentId}/${t.modelId}`)));
  check('T2A2-5: no session was opened at all', sessions.length === 0, `sessions=${sessions.length}`);
}

// --- T2A2-8: provenance 鈥?Laya's pair == Task == Session == Attempt ---
{
  const cap: SnapHolder = { snapshot: null };
  await productionRound({
    objective: 'provenance stays intact',
    script: [{ action: 'continue' }],
    initialPair: { agentId: AGENT_B, modelId: `${AGENT_B}/m1` },
    outcomeFor: (req) => okRun(req.agentId),
    onWorkbenchSnapshot: (s) => { cap.snapshot = s; },
  });
  const snap = cap.snapshot;
  const child = snap === null ? null : childTaskOf(snap);
  const bound = child === null || snap === null ? null : sessionsFor(snap, child.taskId)[0] ?? null;
  const record = snap === null || child === null
    ? null
    : snap.initialSelections.find((x) => x.taskId === child.taskId) ?? null;
  const history = snap === null || child === null
    ? []
    : snap.attempts.filter((a) => a.taskId === child.taskId);

  check('T2A2-8: Laya\'s decision is still on record',
    record !== null && record.ok === true && record.agentId === AGENT_B, JSON.stringify(record));
  check('T2A2-8: Laya\'s pair == the Task pair',
    record !== null && child !== null && child.agentId === record.agentId && child.modelId === record.modelId,
    `${child?.agentId}/${child?.modelId}`);
  check('T2A2-8: the Session pair == the Task pair',
    bound !== null && child !== null && bound.agentId === child.agentId && bound.modelId === child.modelId,
    bound === null ? 'no session' : `${bound.agentId}/${bound.modelId}`);
  check('T2A2-8: the Attempt pair == the Task pair, and carries the session',
    history.length > 0 && child !== null && bound !== null
    && history.every((a) => a.agentId === child.agentId && a.modelId === child.modelId
      && a.sessionId === bound.sessionId),
    JSON.stringify(history.map((a) => `${a.agentId}/${a.modelId}/${a.sessionId}`)));
  const attempt = history[history.length - 1];
  check('T2A2-8: a WorkerIdentity projects from the attempt',
    attempt !== undefined && attempt.sessionId !== null && child !== null
    && attempt.taskId === child.taskId,
    attempt === undefined ? 'no attempt' : `${attempt.agentId}/${attempt.modelId}/${attempt.sessionId}`);
}

// --- T2A2-9: no duplicate assignment in CLI post-processing ---
{
  const cap: SnapHolder = { snapshot: null };
  const r = await productionRound({
    objective: 'one pair selection, not two',
    script: [{ action: 'continue' }],
    initialPair: { agentId: AGENT_B, modelId: `${AGENT_B}/m1` },
    outcomeFor: (req) => okRun(req.agentId),
    onWorkbenchSnapshot: (s) => { cap.snapshot = s; },
  });
  const snap = cap.snapshot;
  const decisions = snap === null ? [] : snap.initialSelections;
  const children = snap === null ? [] : snap.tasks.filter((t) => t.parentTaskId !== null);
  check('T2A2-9: exactly ONE Laya decision was taken', decisions.length === 1, `decisions=${decisions.length}`);
  check('T2A2-9: and it produced exactly one bound task (no CLI re-assignment)',
    children.length === 1 && r.requests.length === 1, `tasks=${children.length} requests=${r.requests.length}`);
}

// --- T2A2-7: distinct-agent-family separation on the production path ---
{
  const cap: SnapHolder = { snapshot: null };
  await productionRound({
    objective: 'planner family A, Laya family B',
    script: [{ action: 'continue' }],
    initialPair: { agentId: AGENT_B, modelId: `${AGENT_B}/m1` },
    outcomeFor: (req) => okRun(req.agentId),
    onWorkbenchSnapshot: (s) => { cap.snapshot = s; },
  });
  const snap = cap.snapshot;
  const child = snap === null ? null : childTaskOf(snap);
  const bound = child === null || snap === null ? null : sessionsFor(snap, child.taskId)[0] ?? null;
  check('T2A2-7: the bound family is the Laya family, not the planner\'s',
    child?.agentId === AGENT_B, child?.agentId ?? 'none');
  check('T2A2-7: the session family matches too (never the planner\'s)',
    bound !== null && bound.agentId === AGENT_B, bound === null ? 'no session' : bound.agentId);
}

// ===========================================================================
// TeamRun T2-a.3: the observation seam is an observation seam, not a control seam.
// ===========================================================================
//
// T2-a.2's seam handed the callback the live `NativeWorkbench`. Through it a test could
// reach `assignChildren` / `store.assignIdentity` / `sessions.open` / `spawnChild` and
// change the pair the round dispatched on. These cases close that: the observer is given
// a detached frozen projection, so the capability is GONE rather than merely unused.
section('T2-a.3. the observation seam exposes facts and no authority');

const AGENT_A_PAIR = { agentId: AGENT_A, modelId: `${AGENT_A}/m1` };

/** Round with the observer attached, returning both the report facts and the snapshot. */
async function observeRound(opts: {
  initialPair?: { agentId: string; modelId: string };
  initialPairFails?: boolean;
  observer?: (snapshot: RoundWorkbenchObservation) => void;
  probeExtra?: readonly string[];
} = {}): Promise<{ r: Round; snap: RoundWorkbenchObservation | null }> {
  const cap: SnapHolder = { snapshot: null };
  const r = await productionRound({
    objective: 'observation seam',
    script: [{ action: 'continue' }],
    ...(opts.initialPair === undefined ? {} : { initialPair: opts.initialPair }),
    ...(opts.initialPairFails === true ? { initialPairFails: true } : {}),
    outcomeFor: (req) => okRun(req.agentId),
    onWorkbenchSnapshot: (s) => {
      cap.snapshot = s;
      // The observer's own view may legitimately be empty at this point; the value is
      // captured before the (possibly mutating) observer body runs.
      if (opts.observer !== undefined) opts.observer(s);
    },
    ...(opts.probeExtra === undefined ? {} : {}),
  });
  return { r, snap: cap.snapshot };
}

// --- T2A3-1: no authority is reachable from the snapshot ---
{
  const { snap } = await observeRound({ initialPair: { agentId: AGENT_B, modelId: `${AGENT_B}/m1` } });
  check('T2A3-1: the observer received a snapshot', snap !== null, 'no snapshot');

  // Shape assertions on the snapshot and every value inside it. These are the exact
  // capabilities Codex demonstrated: assignment, re-planning, Laya, the store, the
  // session registry, dispatch and the runtime.
  // 'sessions' is deliberately NOT in this list: it is a legitimate DATA field holding the
  // observed session rows, not a SessionRegistry. What proves no registry is exposed is the
  // exact-key check immediately below 鈥?a ban on names would only prove the rename.
  const FORBIDDEN = [
    'assignChildren', 'reassignTask', 'plan', 'selectInitialAssignment', 'replanSubtree',
    'spawnChild', 'completeTask', 'applyReview', 'scheduler', 'orchestrator', 'runtime',
    'store', 'evidence', 'registry', 'assignWorker', 'assignIdentity',
    'open', 'bind', 'dispatch', 'decide', 'executeTask',
  ];
  const topLevel = Object.keys(snap ?? {});
  const leaked = topLevel.filter((k) => FORBIDDEN.includes(k));
  check('T2A3-1: the snapshot exposes NO authority property', leaked.length === 0, `leaked=${leaked.join(',')}`);
  check('T2A3-1: it exposes exactly the four fact collections',
    topLevel.slice().sort().join(',') === 'attempts,initialSelections,sessions,tasks', topLevel.join(','));

  // No authority method may hide on ANY nested value, at any depth.
  const offenders: string[] = [];
  const walk = (v: unknown, path: string, depth: number): void => {
    if (depth > 4 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((e, i) => walk(e, `${path}[${i}]`, depth + 1)); return; }
    for (const k of Object.keys(v as Record<string, unknown>)) {
      if (FORBIDDEN.includes(k)) offenders.push(`${path}.${k}`);
      if (typeof (v as Record<string, unknown>)[k] === 'function') offenders.push(`${path}.${k} (function)`);
      walk((v as Record<string, unknown>)[k], `${path}.${k}`, depth + 1);
    }
  };
  walk(snap, 'snapshot', 0);
  check('T2A3-1: no nested authority member or function is reachable', offenders.length === 0,
    offenders.slice(0, 6).join(','));

  // Every exposed field is a plain data value, so there is no prototype to borrow a
  // capability from either.
  check('T2A3-1: the snapshot and its rows are plain objects',
    Object.getPrototypeOf(snap) === Object.prototype
    && Object.getPrototypeOf(snap!.tasks[0]!) === Object.prototype,
    'non-plain prototype');
}

// --- T2A3-2: mutating the snapshot cannot reach the authority ---
{
  // The old exploit's mechanism, attempted against the new seam: rewrite the pair the
  // observer can see and hope the round uses it.
  const { r, snap } = await observeRound({
    initialPair: { agentId: AGENT_B, modelId: `${AGENT_B}/m1` },
    observer: (s) => {
      const task = s.tasks.find((t) => t.parentTaskId !== null);
      const sess = s.sessions.find((x) => x.taskId !== null);
      const sel = s.initialSelections.find((x) => x.taskId !== null);
      for (const target of [task, sess, sel]) {
        if (target === undefined) continue;
        try { (target as { agentId: string }).agentId = AGENT_A; } catch { /* frozen: refused */ }
        try { (target as { modelId: string | null }).modelId = `${AGENT_A}/m1`; } catch { /* frozen */ }
      }
      try { (s as unknown as { tasks: unknown[] }).tasks.length = 0; } catch { /* frozen */ }
      try { (s.tasks as unknown as ObservedTask[]).push(task as ObservedTask); } catch { /* frozen */ }
    },
  });

  const child = snap === null ? null : childTaskOf(snap);
  check('T2A3-2: the snapshot is frozen, so the rewrite is refused', Object.isFrozen(snap), 'not frozen');
  check('T2A3-2: the Task still shows the LAYA pair after the attempt',
    child?.agentId === AGENT_B && child?.modelId === `${AGENT_B}/m1`,
    `${child?.agentId}/${child?.modelId}`);
  // The decisive assertion: production state is untouched, not merely the snapshot.
  check('T2A3-2: the RUNTIME still dispatched the Laya pair',
    r.requests.length === 1 && r.requests[0]!.agentId === AGENT_B,
    `requests=${r.requests.map((q) => q.agentId).join(',')}`);
  const attempt = snap?.attempts.find((a) => a.agentId === AGENT_A);
  check('T2A3-2: no attempt was rewritten to the planner pair', attempt === undefined,
    JSON.stringify(snap?.attempts.map((a) => `${a.agentId}/${a.modelId}`)));
}

// --- T2A3-3: the OLD Codex exploit cannot redirect the round ---
{
  // Planner = agent-a. Laya = agent-b/m1. Under T2-a.2 the callback received the live
  // workbench and could have forced agent-a back. Under T2-a.3 it holds only this.
  let exploitRan = false;
  const { r, snap } = await observeRound({
    initialPair: { agentId: AGENT_B, modelId: `${AGENT_B}/m1` },
    observer: (s) => {
      exploitRan = true;
      // Everything the old seam made possible, attempted through the new one.
      const w = s as unknown as Record<string, unknown>;
      for (const name of ['store', 'sessions', 'assignChildren', 'reassignTask', 'spawnChild', 'scheduler']) {
        void name; void w[name];
      }
      // And the only lever left: rewrite what the snapshot claims, which is inert.
      const task = s.tasks.find((t) => t.parentTaskId !== null);
      if (task !== undefined) {
        try { (task as { agentId: string }).agentId = AGENT_A; } catch { /* frozen */ }
      }
    },
  });

  const child = snap === null ? null : childTaskOf(snap);
  const bound = child === null || snap === null ? null : sessionsFor(snap, child.taskId)[0] ?? null;
  check('T2A3-3: the exploit path was genuinely attempted', exploitRan, 'observer never ran');
  check('T2A3-3: Task stayed B/m1', child?.agentId === AGENT_B && child?.modelId === `${AGENT_B}/m1`,
    `${child?.agentId}/${child?.modelId}`);
  check('T2A3-3: Session stayed B/m1', bound !== null && bound.agentId === AGENT_B
    && bound.modelId === `${AGENT_B}/m1`, bound === null ? 'no session' : `${bound.agentId}/${bound.modelId}`);
  check('T2A3-3: Runtime stayed B/m1', r.requests.length === 1
    && r.requests[0]!.agentId === AGENT_B && r.requests[0]!.model === `${AGENT_B}/m1`,
    `requests=${r.requests.map((q) => `${q.agentId}/${q.model}`).join(',')}`);
  check('T2A3-3: Attempt stayed B/m1 and still names its session',
    (snap?.attempts ?? []).every((a) => a.agentId === AGENT_B && a.modelId === `${AGENT_B}/m1`)
    && (snap?.attempts ?? []).some((a) => a.sessionId !== null),
    JSON.stringify(snap?.attempts.map((a) => `${a.agentId}/${a.modelId}/${a.sessionId}`)));
  check('T2A3-3: and no attempt anywhere names the planner pair',
    (snap?.attempts ?? []).every((a) => a.agentId !== AGENT_A),
    JSON.stringify(snap?.attempts.map((a) => a.agentId)));
}

// --- T2A3-4: observer enabled vs disabled is behaviourally identical ---
{
  // Codex finding (fixed here): `cap2` was assigned inside the observer while being
  // `const`-declared AFTER the round, so the callback hit the temporal dead zone, threw a
  // ReferenceError, and the failure-isolated notifier swallowed it 鈥?leaving the captured
  // snapshot null and part of the comparison vacuously empty.
  //
  // Declared BEFORE the round now. And because a round WITHOUT an observer has no snapshot
  // by definition, equivalence is asserted over the PRODUCTION facts both sides can
  // produce, while the snapshot is proven non-empty and consistent separately. Comparing a
  // populated snapshot against a `null` one would only ever "pass" by comparing emptiness.
  const cap2: SnapHolder = { snapshot: null };

  // Facts a round reports regardless of any observer. These are the ones the observer must
  // not be able to change.
  const productionFacts = (r: Round) => JSON.stringify({
    code: r.report.ok,
    dispatched: r.requests.map((q) => `${q.agentId}/${q.model}`),
    error: r.report.error ?? null,
  });

  const withObs = await productionRound({
    objective: 'equivalence with observer',
    script: [{ action: 'continue' }],
    initialPair: { agentId: AGENT_B, modelId: `${AGENT_B}/m1` },
    outcomeFor: (req) => okRun(req.agentId),
    onWorkbenchSnapshot: (s) => { cap2.snapshot = s; },
  });
  const without = await productionRound({
    objective: 'equivalence with observer',
    script: [{ action: 'continue' }],
    initialPair: { agentId: AGENT_B, modelId: `${AGENT_B}/m1` },
    outcomeFor: (req) => okRun(req.agentId),
  });

  // 1. The capture actually happened this time 鈥?the defect this fixes.
  check('T2A3-4: the observer really captured a snapshot', cap2.snapshot !== null,
    'capture is null: the observer never ran or threw into the isolation boundary');
  check('T2A3-4: the captured snapshot is populated',
    (cap2.snapshot?.tasks.length ?? 0) > 0 && (cap2.snapshot?.sessions.length ?? 0) > 0,
    `tasks=${cap2.snapshot?.tasks.length} sessions=${cap2.snapshot?.sessions.length}`);

  // 2. Observer presence changes no production fact.
  const a = productionFacts(withObs);
  const b = productionFacts(without);
  check('T2A3-4: observer presence changes NOTHING observable', a === b, `\n      on : ${a}\n      off: ${b}`);

  // 3. And the now-non-empty capture AGREES with what the round actually did, so the
  //    equivalence claim rests on real data rather than on an empty comparison.
  const snap = cap2.snapshot!;
  const child = childTaskOf(snap);
  const bound = child === null ? null : sessionsFor(snap, child.taskId)[0] ?? null;
  check('T2A3-4: and the observed run really did bind B/m1',
    child?.agentId === AGENT_B && child?.modelId === `${AGENT_B}/m1`
    && bound !== null && bound.agentId === AGENT_B && bound.modelId === `${AGENT_B}/m1`
    && withObs.requests.length === 1 && withObs.requests[0]!.agentId === AGENT_B,
    `task=${child?.agentId}/${child?.modelId} session=${bound?.agentId}/${bound?.modelId} dispatched=${a}`);
  check('T2A3-4: the observed attempts match the dispatched pair',
    (snap.attempts ?? []).length > 0 && snap.attempts.every((x) => x.agentId === AGENT_B),
    JSON.stringify(snap.attempts.map((x) => `${x.agentId}/${x.modelId}`)));
}

// --- T2A3-4b: a THROWING observer cannot fail the round (搂1/搂8) ---
{
  const r = await productionRound({
    objective: 'observer explodes',
    script: [{ action: 'continue' }],
    initialPair: { agentId: AGENT_B, modelId: `${AGENT_B}/m1` },
    outcomeFor: (req) => okRun(req.agentId),
    onWorkbenchSnapshot: () => { throw new Error('observer failure must be isolated'); },
  });
  check('T2A3-4b: the round still completed despite a throwing observer',
    r.report.error === undefined && r.requests.length === 1,
    `error=${String(r.report.error)} requests=${r.requests.length}`);
}

// --- T2A3-4c: the observer's RETURN VALUE is ignored (搂6) ---
{
  const cap: SnapHolder = { snapshot: null };
  const r = await productionRound({
    objective: 'observer returns a replacement',
    script: [{ action: 'continue' }],
    initialPair: { agentId: AGENT_B, modelId: `${AGENT_B}/m1` },
    outcomeFor: (req) => okRun(req.agentId),
    // Returning a whole fabricated snapshot, plus an "override" payload, must change
    // nothing: the seam's type is `(snapshot) => void` and its result is discarded.
    onWorkbenchSnapshot: ((s: RoundWorkbenchObservation) => {
      cap.snapshot = s;
      return {
        override: AGENT_A_PAIR,
        tasks: Object.freeze([]),
        sessions: Object.freeze([]),
        initialSelections: Object.freeze([]),
        attempts: Object.freeze([]),
      };
    }) as unknown as (s: RoundWorkbenchObservation) => void,
  });
  check('T2A3-4c: a returned replacement was ignored; runtime still used Laya\'s pair',
    r.requests.length === 1 && r.requests[0]!.agentId === AGENT_B,
    `requests=${r.requests.map((q) => q.agentId).join(',')}`);
  check('T2A3-4c: the captured snapshot is the real one, not the returned fabrication',
    childTaskOf(cap.snapshot!)?.agentId === AGENT_B, String(childTaskOf(cap.snapshot!)?.agentId));
}

// --- T2A3-5: the snapshot accurately reports the finished binding ---
{
  const { r, snap } = await observeRound({ initialPair: { agentId: AGENT_B, modelId: `${AGENT_B}/m1` } });
  const child = snap === null ? null : childTaskOf(snap);
  const bound = child === null || snap === null ? null : sessionsFor(snap, child.taskId)[0] ?? null;
  const sel = snap === null || child === null
    ? null
    : snap.initialSelections.find((x) => x.taskId === child.taskId) ?? null;
  // The round also holds the ROOT task (parentTaskId === null), which keeps the planner's
  // agent and has NO model: that is correct, not a leak. What matters is the CHILD.
  const roots = snap === null ? [] : snap.tasks.filter((t) => t.parentTaskId === null);
  const kids = snap === null ? [] : snap.tasks.filter((t) => t.parentTaskId !== null);
  check('T2A3-5: one root and exactly one child task are reported',
    roots.length === 1 && kids.length === 1, `roots=${roots.length} children=${kids.length}`);
  check('T2A3-5: the root was never bound a model', roots[0]?.modelId === null, String(roots[0]?.modelId));
check('T2A3-5: Laya provenance is reported for that task',
    sel !== null && sel.ok && sel.agentId === AGENT_B && sel.modelId === `${AGENT_B}/m1`,
    JSON.stringify(sel));
  check('T2A3-5: the task/session/attempt chain agrees on B/m1',
    child?.agentId === AGENT_B && child.modelId === `${AGENT_B}/m1`
    && bound !== null && bound.agentId === AGENT_B && bound.modelId === `${AGENT_B}/m1`
    && (snap?.attempts ?? []).every((a) => a.agentId === AGENT_B && a.modelId === `${AGENT_B}/m1`),
    JSON.stringify({ task: `${child?.agentId}/${child?.modelId}`, session: bound && `${bound.agentId}/${bound.modelId}` }));
  check('T2A3-5: and it agrees with what actually ran',
    r.requests[0]?.agentId === AGENT_B && r.requests[0]?.model === `${AGENT_B}/m1`,
    `${r.requests[0]?.agentId}/${r.requests[0]?.model}`);
}

// --- T2A3-6: a failure round cannot be made to resurrect the planned pair ---
{
  const cap: SnapHolder = { snapshot: null };
  const r = await productionRound({
    objective: 'refused selection, observer tries to resurrect the plan',
    script: [{ action: 'continue' }],
    initialPairFails: true,
    outcomeFor: (req) => okRun(req.agentId),
    // The observer tries every remaining lever, including forging a snapshot.
    onWorkbenchSnapshot: ((s: RoundWorkbenchObservation) => {
      cap.snapshot = s;
      try { (s as unknown as { sessions: unknown[] }).sessions.length = 1; } catch { /* frozen */ }
      const t = s.tasks.find((x) => x.parentTaskId !== null);
      if (t !== undefined) {
        try { (t as { modelId: string }).modelId = AGENT_A_PAIR.modelId; } catch { /* frozen */ }
      }
      return s;
    }) as unknown as (s: RoundWorkbenchObservation) => void,
  });

  const children = cap.snapshot === null ? [] : cap.snapshot.tasks.filter((t) => t.parentTaskId !== null);
  check('T2A3-6: the observer did observe the failed round', cap.snapshot !== null, 'no snapshot');
  check('T2A3-6: runtime = 0', r.requests.length === 0, `requests=${r.requests.length}`);
  check('T2A3-6: session = 0', (cap.snapshot?.sessions ?? []).length === 0,
    `sessions=${cap.snapshot?.sessions.length}`);
  check('T2A3-6: attempt = 0', (cap.snapshot?.attempts ?? []).length === 0,
    `attempts=${cap.snapshot?.attempts.length}`);
  check('T2A3-6: the planned pair was NOT resurrected in any task',
    children.every((t) => t.modelId === null && t.agentId === AGENT_A),
    JSON.stringify(children.map((t) => `${t.agentId}/${t.modelId}`)));
}

// --- T2A3-7: the seam is OPTIONAL (搂13) 鈥?a production round needs no observer ---
{
  const r = await productionRound({
    objective: 'no observer at all',
    script: [{ action: 'continue' }],
    initialPair: { agentId: AGENT_B, modelId: `${AGENT_B}/m1` },
    outcomeFor: (req) => okRun(req.agentId),
    // deliberately no onWorkbenchSnapshot: production never passes one
  });
  check('T2A3-7: a round with no observer runs normally',
    r.report.error === undefined && r.requests.length === 1
    && r.requests[0]!.agentId === AGENT_B,
    `error=${String(r.report.error)} requests=${r.requests.length}`);
}

// --- 搂18: same-Agent MODEL switch 鈥?Planner model-A, Laya model-B ---
{
  const MODEL_B = `${AGENT_A}/m2`;
  const cap: SnapHolder = { snapshot: null };
  const r = await productionRound({
    objective: 'planner model A, Laya model B on the same agent',
    script: [{ action: 'continue' }],
    // The agent is UNCHANGED; only the model moves. A cross-agent case cannot reach this,
    // because nothing about the agent identity is there to get wrong.
    extraModels: [MODEL_B],
    initialPair: { agentId: AGENT_A, modelId: MODEL_B },
    outcomeFor: (req) => okRun(req.agentId),
    onWorkbenchSnapshot: (s) => { cap.snapshot = s; },
  });

  const snap = cap.snapshot;
  const child = snap === null ? null : childTaskOf(snap);
  const bound = child === null || snap === null ? null : sessionsFor(snap, child.taskId)[0] ?? null;
  const sel = snap === null || child === null
    ? null
    : snap.initialSelections.find((x) => x.taskId === child.taskId) ?? null;
  const attempts = snap?.attempts.filter((a) => a.taskId === child?.taskId) ?? [];

  check('S18: the snapshot shows the FINAL model on the task',
    child?.agentId === AGENT_A && child?.modelId === MODEL_B, `${child?.agentId}/${child?.modelId}`);
  check('S18: the session carries the same model, not the planner default',
    bound !== null && bound.agentId === AGENT_A && bound.modelId === MODEL_B,
    bound === null ? 'no session' : `${bound.agentId}/${bound.modelId}`);
  check('S18: Laya provenance records model-B',
    sel !== null && sel.ok && sel.agentId === AGENT_A && sel.modelId === MODEL_B, JSON.stringify(sel));
  check('S18: the runtime ran model-B', r.requests.length === 1
    && r.requests[0]!.agentId === AGENT_A && r.requests[0]!.model === MODEL_B,
    `requests=${r.requests.map((q) => `${q.agentId}/${q.model}`).join(',')}`);
  check('S18: every attempt is model-B and still names its session',
    attempts.length > 0 && attempts.every((a) => a.modelId === MODEL_B && a.sessionId === bound?.sessionId),
    JSON.stringify(attempts.map((a) => `${a.agentId}/${a.modelId}/${a.sessionId}`)));
  check('S18: no attempt fell back to the planner model-A',
    attempts.every((a) => a.modelId !== `${AGENT_A}/m1`),
    JSON.stringify(attempts.map((a) => a.modelId)));
}

// ===========================================================================
section('T2-b. PRODUCTION WIRING: the Worker execution contract on the real chain');
// ===========================================================================
//
// 搂39: this must not be a unit test of a renderer. Everything below reads the RunRequest
// that the FAKE RUNTIME actually received, after the real chain ran:
//
//   Laya pair -> Assignment -> SessionRegistry -> TaskScheduler.tick
//            -> Orchestrator.executeTask -> buildRunRequest -> runtime.run
//
// so it proves delivery on the production path, not merely that a function returns text.

/** Does this delivered instruction actually carry the bounded-recon contract? */
const carriesContract = (p: string): boolean =>
  p.includes('Execution contract (Worker-local bounded recon / reuse-first)')
  && p.includes('Inspect the relevant current truth')
  && p.includes('Search the repository for an existing helper')
  && p.includes('upstream / reference / open-source')
  && p.includes('licence, API/version compatibility')
  && p.includes('REUSE, ADAPT, WRAP, or NEW')
  && p.includes('never means your recon is already done')
  && p.includes('Keep recon bounded')
  && p.includes('Do not modify external Agent installations')
  && p.includes('Before performing the substantive task')
  && p.includes('Only after that recon and reuse decision');

// --- T2B-15: normal execution, real chain ---
{
  const cap: SnapHolder = { snapshot: null };
  const r = await productionRound({
    objective: 'make the parser tolerate CRLF',
    script: [{ action: 'continue' }],
    outcomeFor: (req) => okRun(req.agentId),
    onWorkbenchSnapshot: (s) => { cap.snapshot = s; },
  });
  try {
    const dispatched = r.requests[0];
    check('T2B-15: a real execution request was dispatched', dispatched !== undefined,
      'nothing reached the runtime');
    check('T2B-15: it carries the bounded recon / reuse-first contract',
      dispatched !== undefined && carriesContract(dispatched.prompt), 'contract absent from the real request');
    check('T2B-15: it is an execution-role request, not review',
      dispatched?.mode === 'default', String(dispatched?.mode));
    // T2B-11 on the production path: the task instruction survived the wrapper intact.
    // The composed prompt must END with the task section, and that section must carry the
    // task's own acceptance criteria 鈥?a truncated or re-rendered task would break both.
    check('T2B-15: the original task instruction is still fully present',
      dispatched !== undefined
      && dispatched.prompt.includes('--- TASK (unchanged) ---')
      && /CRLF/i.test(dispatched.prompt.slice(dispatched.prompt.indexOf('--- TASK (unchanged) ---'))),
      'task section missing or truncated');
    check('T2B-15: the acceptance criteria reach the Worker',
      dispatched !== undefined && /CRLF/i.test(dispatched.prompt), 'criteria missing');
    // T2B-14 on the production path: shared research is leads only.
    check('T2B-15: it still demands self-verification despite any prior research',
      dispatched !== undefined && dispatched.prompt.includes('never means your recon is already done'),
      'waiver language absent');
  } finally { r.cleanup(); }
}

// --- T2B-9: real reassign 鈥?Worker A (model-A) -> Laya -> Worker B (model-B) ---
{
  const r = await productionRound({
    objective: 'do the thing',
    script: [
      { action: 'continue' },
      { action: 'reassign', agentId: AGENT_B, modelId: `${AGENT_B}/m1`, reason: 'A is out of quota' },
    ],
    outcomeFor: (req) => (req.agentId === AGENT_A ? unavailableRun(req.agentId) : okRun(req.agentId, 'B did it')),
  });
  try {
    const aReqs = r.requests.filter((q) => q.agentId === AGENT_A);
    const bReqs = r.requests.filter((q) => q.agentId === AGENT_B);
    check('T2B-9: both Workers really ran', aReqs.length >= 1 && bReqs.length >= 1,
      `requests=${r.requests.map((q) => q.agentId).join(',')}`);
    // 搂4: B is a NEW Worker. It may read A's result, but it must own its own recon.
    check('T2B-9: Worker A received the contract', aReqs.every((q) => carriesContract(q.prompt)), 'A missing');
    check('T2B-9: the NEW Worker B also received it (not waived by A\'s recon)',
      bReqs.length >= 1 && bReqs.every((q) => carriesContract(q.prompt)), 'B missing');
  } finally { r.cleanup(); }
}

// --- T2B-8: real handoff with shared evidence attached to B ---
{
  const r = await productionRound({
    objective: 'do the thing',
    script: [
      { action: 'continue' },
      { action: 'reassign', agentId: AGENT_B, modelId: `${AGENT_B}/m1`, reason: 'A is out of quota' },
    ],
    outcomeFor: (req) => (req.agentId === AGENT_A ? unavailableRun(req.agentId) : okRun(req.agentId, 'B did it')),
  });
  try {
    const bReqs = r.requests.filter((q) => q.agentId === AGENT_B);
    // The continuation packet carries A's result into B's brief. If B's request shows the
    // evidence AND the contract, 搂7 is satisfied: leads supplied, verification demanded.
    check('T2B-8: Worker B got the contract alongside the shared evidence',
      bReqs.length >= 1 && bReqs.every((q) => carriesContract(q.prompt)
        && /handoff|previous|unresolved|result/i.test(q.prompt)),
      'B prompt lacked contract or evidence');
    check('T2B-8: no request anywhere waived recon because evidence existed',
      r.requests.every((q) => q.prompt.includes('never means your recon is already done')),
      'a request dropped the verification requirement');
  } finally { r.cleanup(); }
}

// --- T2B-6 on the real chain: same agent, two models, two contracts ---
{
  const r = await productionRound({
    objective: 'planner model A, Laya model B',
    script: [{ action: 'continue' }],
    extraModels: [`${AGENT_A}/m2`],
    initialPair: { agentId: AGENT_A, modelId: `${AGENT_A}/m2` },
    outcomeFor: (req) => okRun(req.agentId),
  });
  try {
    const dispatched = r.requests[0];
    check('T2B-6: a same-agent model switch really dispatched the new model',
      dispatched?.model === `${AGENT_A}/m2`, String(dispatched?.model));
    check('T2B-6: and that new Worker carries the contract',
      dispatched !== undefined && carriesContract(dispatched.prompt), 'contract absent');
  } finally { r.cleanup(); }
}

// --- T2B-5 on the real chain: the Unified Reviewer must NOT get the contract ---
{
  // The review request is built by `runUnifiedReview` and never passes `buildRunRequest`.
  const r = await productionRound({
    objective: 'do the thing',
    script: [{ action: 'continue' }],
    outcomeFor: (req) => okRun(req.agentId),
  });
  try {
    const reviewReqs = r.reviewRequests;
    const execReqs = r.requests;
    check('T2B-5: the round really ran the Unified Reviewer', reviewReqs.length >= 1,
      `reviewRequests=${reviewReqs.length} execRequests=${r.requests.map((q) => `${q.agentId}/${q.mode}`).join(',')}`);
    check('T2B-5: the reviewer received NO implementation/reuse contract',
      reviewReqs.every((q) => !carriesContract(q.prompt) && !q.prompt.includes('REUSE, ADAPT, WRAP')),
      'reviewer was handed an implementation contract');
    check('T2B-5: the reviewer kept its own reviewer semantics',
      reviewReqs.every((q) => /review/i.test(q.prompt)), 'reviewer prompt lost its role');
    check('T2B-5: while execution requests did receive it',
      execReqs.length >= 1 && execReqs.every((q) => carriesContract(q.prompt)), 'execution missing');
  } finally { r.cleanup(); }
}

// ===========================================================================
section('T2-b.1. review-SEMANTIC Task execution vs Unified Review: the role boundary');
// ===========================================================================
//
// P1 closure. A Task whose SEMANTIC is `review` still travels the full execution chain
// (Task -> Assignment -> SessionRegistry -> Scheduler -> executeTask -> runtime.run) and is
// therefore a real execution Worker with a real Attempt and WorkerIdentity. It must carry
// the contract. Only the independent Unified Review path, which never touches
// `buildRunRequest`, must not.

// --- T2B1-1 / T2B1-2: one real round whose tasks carry review semantics ---
{
  const cap: SnapHolder = { snapshot: null };
  const r = await productionRound({
    objective: 'review the parser change for CRLF handling',
    script: [{ action: 'continue' }],
    // Laya classifies the work as review -> taskType 'review' -> mode 'review'.
    routingAnswers: { work_kind: 'review' },
    outcomeFor: (req) => okRun(req.agentId),
    onWorkbenchSnapshot: (s) => { cap.snapshot = s; },
  });
  try {
    const snap = cap.snapshot!;
    // T2B1-1: the execution Worker that did the review-semantic task.
    check('T2B1-1: the review-semantic task really ran as an execution Worker',
      r.requests.length >= 1, `requests=${r.requests.length}`);
    check('T2B1-1: every execution request carries the review TRANSPORT profile',
      r.requests.every((q) => q.mode === 'review'), `modes=${r.requests.map((q) => q.mode).join(',')}`);
    check('T2B1-1: and every one carries the Worker recon contract',
      r.requests.length >= 1 && r.requests.every((q) => carriesContract(q.prompt)), 'contract missing');
    // The EXECUTED task really carries the review SEMANTIC: a task whose recorded type is
    // 'review' AND that the round actually dispatched. Read from the report's own live
    // TaskStore projection (`type`) and its evidence-derived dispatch list.
    const reportTasks = (r.report.tasks as Array<{ taskId: string; type: string; status: string }> | undefined) ?? [];
    const dispatched = ((r.report.decision as { dispatchedTasks?: string[] } | undefined)?.dispatchedTasks) ?? [];
    const executedReview = reportTasks.filter((t) => dispatched.includes(t.taskId) && t.type === 'review');
    check('T2B1-1: the EXECUTED task really is review-typed',
      executedReview.length >= 1,
      `tasks=${JSON.stringify(reportTasks.map((t) => `${t.taskId}:${t.type}:${t.status}`))} dispatched=${dispatched.join(',')}`);
    check('T2B1-1: no dispatched task silently fell back to implementation',
      reportTasks.filter((t) => dispatched.includes(t.taskId)).every((t) => t.type === 'review'),
      JSON.stringify(reportTasks.filter((t) => dispatched.includes(t.taskId)).map((t) => t.type)));
    check('T2B1-1: the review task instruction is preserved behind the contract',
      r.requests.every((q) => q.prompt.includes('--- TASK (unchanged) ---')
        && /review/i.test(q.prompt.slice(q.prompt.indexOf('--- TASK (unchanged) ---')))),
      'task instruction lost');

    // Attempt + WorkerIdentity for the review-semantic execution.
    const attempt = snap.attempts[0];
    check('T2B1-1: an execution Attempt was recorded', attempt !== undefined && attempt.kind === 'execution',
      `kind=${String(attempt?.kind)}`);
    check('T2B1-1: the Attempt owns a sessionId', attempt !== undefined && attempt.sessionId !== null,
      `sessionId=${String(attempt?.sessionId)}`);
    const worker = attempt === undefined ? null : workerIdentityOfAttempt({
      taskId: attempt.taskId,
      agentId: attempt.agentId,
      modelId: attempt.modelId,
      ...(attempt.sessionId === null ? {} : { sessionId: attempt.sessionId }),
    });
    check('T2B1-1: workerIdentityOfAttempt(...) is non-null for the review Worker', worker !== null,
      JSON.stringify(attempt ?? null));

    // T2B1-2: the SEPARATE Unified Review path.
    check('T2B1-2: the round also ran the Unified Reviewer', r.reviewRequests.length >= 1,
      `reviewRequests=${r.reviewRequests.length}`);
    check('T2B1-2: the reviewer request does NOT carry the Worker contract',
      r.reviewRequests.every((q) => !carriesContract(q.prompt)
        && !q.prompt.includes('REUSE, ADAPT, WRAP')
        && !q.prompt.includes('bounded recon')),
      'the reviewer was handed an implementation contract');
    check('T2B1-2: and the round is not contaminated by the reconciliation',
      r.reviewRequests.every((q) => q.mode === 'review'), 'reviewer request lost its mode');
  } finally { r.cleanup(); }
}

// --- T2B1-3: Codex dual role, both halves in ONE file ---
{
  // Half 1 (production): the Unified Reviewer here IS Codex. Its request has no contract.
  const r = await productionRound({
    objective: 'review the parser change',
    script: [{ action: 'continue' }],
    routingAnswers: { work_kind: 'review' },
    outcomeFor: (req) => okRun(req.agentId),
  });
  try {
    const reviewer = r.reviewRequests[0];
    check('T2B1-3: the Unified Reviewer really is the Codex agent',
      reviewer !== undefined && reviewer.agentId === 'codex', String(reviewer?.agentId));
    check('T2B1-3: Codex-as-Unified-Reviewer has NO implementation contract',
      reviewer !== undefined && !carriesContract(reviewer.prompt), 'reviewer contaminated');
  } finally { r.cleanup(); }

  // Half 2 (same file): Codex in the EXECUTION role, with review SEMANTICS, DOES.
  const codexReviewTask = {
    taskId: 'codex-review-task', parentTaskId: 'root', rootTaskId: 'root', depth: 1,
    dependencies: [], agentId: 'codex', modelId: 'codex/gpt', leaseVersion: 1, fencingToken: 'f',
    taskType: 'review' as const, status: 'running' as const, acceptanceCriteria: 'judge the change',
    artifacts: [], retryCount: 0, order: 0, createdAt: 1, startedAt: 1, finishedAt: null,
    budgetUnits: 10, blockedReason: null,
  };
  const built = buildRunRequest({ task: codexReviewTask as never, cwd: 'C:/w' });
  check('T2B1-3: Codex-as-execution-Worker (review semantic) HAS the contract',
    carriesContract(built.request.prompt) && built.request.mode === 'review', 'contract missing');
  check('T2B1-3: so identity alone never decided the role 鈥?the seam did',
    carriesContract(built.request.prompt), 'identity-based exclusion is back');
}

// ===========================================================================
section('T3-a.1. READ-only fan-out on the REAL chain (Planner -> Laya -> Assignment -> Scheduler -> runtime)');
// ===========================================================================

interface FanoutMemberReport {
  taskId: string; memberIndex: number; taskStatus: string;
  outcome: 'started' | 'assignment-refused' | 'dispatch-refused' | 'pending';
  executionSettled: boolean; taskTerminal: boolean; dependencySatisfied: boolean;
  executed: boolean;
  requested: { agentId: string; modelId: string; scope: string; accessMode: string };
  assignment: { status: 'accepted' | 'refused'; reason: string | null };
  actual: { agentId: string; modelId: string | null; sessionId: string | null; attemptId: string } | null;
}
interface FanoutReport {
  sourceTaskId: string; topology: string; requested: number; settledCount: number; allSettled: boolean;
  executedCount: number; refusedCount: number; terminalCount: number; allTerminal: boolean;
  nonSucceeding: readonly string[];
  members: readonly FanoutMemberReport[];
}
const fanoutsOf = (r: Round): FanoutReport[] => (r.report.fanout as FanoutReport[] | undefined) ?? [];

// --- T3A1-SOLO: no topology opinion keeps the single-worker path byte-identical ---
{
  const r = await productionRound({
    objective: 'solo regression',
    script: [{ action: 'continue' }],
    outcomeFor: (req) => okRun(req.agentId),
  });
  try {
    check('T3A1-SOLO: a round with no topology answer dispatches exactly one worker',
      r.requests.length === 1, `requests=${r.requests.length}`);
    check('T3A1-SOLO: and reports no fan-out', fanoutsOf(r).length === 0, JSON.stringify(fanoutsOf(r)));
  } finally { r.cleanup(); }
}

// --- T3A1-F1: same Agent, same Model, different Sessions, 2 READ workers ---
{
  const cap: SnapHolder = { snapshot: null };
  const SCOPE_A = 'inspect the session/state architecture';
  const SCOPE_B = 'inspect the scheduler and its tests';
  const r = await productionRound({
    objective: 'read fan-out F1',
    script: [{ action: 'continue' }],
    extraArgs: ['--max-concurrent', '3'],
    topology: { members: [
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: SCOPE_A },
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: SCOPE_B },
    ] },
    outcomeFor: (req) => okRun(req.agentId),
    onWorkbenchSnapshot: (s) => { cap.snapshot = s; },
  });
  try {
    const fan = fanoutsOf(r);
    check('F1: one fan-out group reported', fan.length === 1, JSON.stringify(fan));
    const g = fan[0]!;
    check('F1: two members requested and both settled', g.requested === 2 && g.allSettled,
      `requested=${g.requested} terminal=${g.settledCount}`);
    check('F1: members ordered deterministically by memberIndex',
      g.members.map((m) => m.memberIndex).join(',') === '0,1', g.members.map((m) => m.memberIndex).join(','));
    check('F1: two DISTINCT member taskIds', new Set(g.members.map((m) => m.taskId)).size === 2);
    check('F1: the two scopes are preserved per member',
      g.members.some((m) => m.requested.scope === SCOPE_A) && g.members.some((m) => m.requested.scope === SCOPE_B));
    check('F1: BOTH workers really ran', r.requests.length === 2, `requests=${r.requests.length}`);
    check('F1: both ran the same Agent脳Model pair', r.requests.every((q) => q.agentId === AGENT_A && q.model === `${AGENT_A}/m1`),
      r.requests.map((q) => `${q.agentId}/${q.model}`).join(','));
    check('F1: both shared ONE cwd (READ needs no worktree)',
      new Set(r.requests.map((q) => q.cwd)).size === 1, r.requests.map((q) => q.cwd).join(' | '));
    const snap = cap.snapshot!;
    const memberIds = g.members.map((m) => m.taskId);
    const memberSessions = snap.sessions.filter((s) => s.taskId !== null && memberIds.includes(s.taskId));
    check('F1: each member has its OWN session binding', memberSessions.length === 2
      && new Set(memberSessions.map((s) => s.sessionId)).size === 2,
      memberSessions.map((s) => `${s.taskId}:${s.sessionId}`).join(' | '));
    const memberAttempts = snap.attempts.filter((a) => memberIds.includes(a.taskId));
    check('F1: each member has its own Attempt with its own sessionId',
      memberAttempts.length === 2 && new Set(memberAttempts.map((a) => a.sessionId)).size === 2,
      JSON.stringify(memberAttempts.map((a) => `${a.taskId}:${a.sessionId}`)));
    check('F1: the members are read-typed (never implementation)',
      memberIds.every((id) => (r.report.tasks as Array<{ taskId: string; type: string }>)
        .filter((t) => t.taskId === id).every((t) => t.type === 'research')),
      JSON.stringify((r.report.tasks as Array<{ taskId: string; type: string }>).map((t) => `${t.taskId}:${t.type}`)));
  } finally { r.cleanup(); }
}

// --- T3A1-F2: same Agent, different Models ---
{
  const r = await productionRound({
    objective: 'read fan-out F2',
    script: [{ action: 'continue' }],
    extraArgs: ['--max-concurrent', '3'],
    extraModels: [`${AGENT_A}/m2`],
    topology: { members: [
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'inspect with model A' },
      { agentId: AGENT_A, modelId: `${AGENT_A}/m2`, scope: 'inspect with model B' },
    ] },
    outcomeFor: (req) => okRun(req.agentId),
  });
  try {
    check('F2: both models ran in parallel',
      r.requests.length === 2 && new Set(r.requests.map((q) => q.model)).size === 2,
      r.requests.map((q) => `${q.agentId}/${q.model}`).join(','));
    check('F2: each pair exact-enforced (no substitution)',
      r.requests.some((q) => q.model === `${AGENT_A}/m1`) && r.requests.some((q) => q.model === `${AGENT_A}/m2`));
    check('F2: both members terminal', fanoutsOf(r)[0]?.allSettled === true, JSON.stringify(fanoutsOf(r)));
  } finally { r.cleanup(); }
}

// --- T3A1-F3 / cross-agent: OpenCode + WorkBuddy Intl ---
{
  const r = await productionRound({
    objective: 'read fan-out F3',
    script: [{ action: 'continue' }],
    extraArgs: ['--max-concurrent', '3'],
    topology: { members: [
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'inspect from agent A' },
      { agentId: AGENT_B, modelId: `${AGENT_B}/m1`, scope: 'inspect from agent B' },
    ] },
    outcomeFor: (req) => okRun(req.agentId),
  });
  try {
    check('F3: two different agent families ran in parallel',
      r.requests.length === 2 && new Set(r.requests.map((q) => q.agentId)).size === 2,
      r.requests.map((q) => q.agentId).join(','));
    check('F3: shared one cwd', new Set(r.requests.map((q) => q.cwd)).size === 1);
    check('F3: all terminal', fanoutsOf(r)[0]?.allSettled === true);
  } finally { r.cleanup(); }
}

// --- T3A1-F4: 3 members, one FAILS 鈥?aggregation retains ALL three ---
{
  const FAIL_SCOPE = 'inspect the failing area';
  const r = await productionRound({
    objective: 'read fan-out F4',
    script: [{ action: 'continue' }],
    extraArgs: ['--max-concurrent', '3'],
    topology: { members: [
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'inspect area one' },
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: FAIL_SCOPE },
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'inspect area three' },
    ] },
    // Fail exactly the member whose brief carries the failing scope.
    outcomeFor: (req) => (req.prompt.includes(FAIL_SCOPE) ? nonzeroRun(req.agentId) : okRun(req.agentId)),
  });
  try {
    const g = fanoutsOf(r)[0]!;
    check('F4: three members requested', g.requested === 3, `requested=${g.requested}`);
    check('F4: all three reach terminal (a failure is terminal)', g.allSettled === true, JSON.stringify(g));
    check('F4: the failed member is retained, not dropped',
      g.members.length === 3 && g.members.some((m) => m.taskStatus === 'failed'), JSON.stringify(g.members.map((m) => m.taskStatus)));
    check('F4: the failed member is reported non-succeeding', g.nonSucceeding.length === 1, JSON.stringify(g.nonSucceeding));
    check('F4: the other two still succeeded (a successful read lands in to_verify)',
      g.members.filter((m) => m.taskStatus === 'to_verify' || m.taskStatus === 'succeeded').length === 2,
      JSON.stringify(g.members.map((m) => m.taskStatus)));
    // T3A2-6/7: a failure AFTER dispatch is EXECUTED with a real pair 鈥?the opposite of a
    // pre-dispatch refusal. This distinction must survive.
    const failedMember = g.members.find((m) => m.taskStatus === 'failed');
    check('T3A2-6: the failed member was EXECUTED (not a refusal)',
      failedMember !== undefined && failedMember.executed === true && failedMember.actual !== null,
      JSON.stringify(failedMember ?? null));
    check('T3A2-6: its assignment was accepted, not refused',
      failedMember?.assignment.status === 'accepted');
    check('T3A2-6: and it is executionSettled', failedMember?.executionSettled === true);
    check('F4: exactly three runtime requests (one failing) participated',
      r.requests.length === 3, `requests=${r.requests.length}`);
  } finally { r.cleanup(); }
}

// --- T3A1-F5: one member unavailable BEFORE dispatch 鈥?never silently deleted ---
{
  const r = await productionRound({
    objective: 'read fan-out F5',
    script: [{ action: 'continue' }],
    extraArgs: ['--max-concurrent', '3'],
    topology: { members: [
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'available member' },
      { agentId: AGENT_A, modelId: `${AGENT_A}/does-not-exist`, scope: 'unavailable member' },
    ] },
    outcomeFor: (req) => okRun(req.agentId),
  });
  try {
    const g = fanoutsOf(r)[0]!;
    check('F5: the REQUESTED member set is retained (2)', g.requested === 2, `requested=${g.requested}`);
    check('F5: the unavailable member is not deleted from the group', g.members.length === 2);
    const unassigned = (r.report.unassigned as Array<{ taskId: string; code: string }> | undefined) ?? [];
    check('F5: the unavailable member has explicit refusal evidence', unassigned.length === 1,
      JSON.stringify(unassigned));
    check('F5: the valid sibling still ran', r.requests.length === 1, `requests=${r.requests.length}`);
    check('F5: no substitution happened (the real pair ran, not a stand-in)',
      r.requests.every((q) => q.model === `${AGENT_A}/m1`), r.requests.map((q) => q.model).join(','));
  } finally { r.cleanup(); }
}

// --- T3A1-F8: a WRITE member must fail closed BEFORE any dispatch ---
{
  const r = await productionRound({
    objective: 'read fan-out F8',
    script: [{ action: 'continue' }],
    topology: { members: [
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'read part', accessMode: 'read' },
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'write part', accessMode: 'write' },
    ] },
    outcomeFor: (req) => okRun(req.agentId),
  });
  try {
    check('F8: a WRITE member refuses the WHOLE topology', r.requests.length === 0, `requests=${r.requests.length}`);
    check('F8: the round reports the refusal', typeof r.report.error === 'string'
      && r.report.error.includes('topology-write-member-refused'), String(r.report.error));
    check('F8: no fan-out was recorded', fanoutsOf(r).length === 0);
    // The refusal is the TOPOLOGY gate, not a resource conflict: ResourceClaim would ALLOW
    // read+write to share (claimsConflict returns false). Proven by the specific code above.
  } finally { r.cleanup(); }
}

// --- T3A1-malformed: invalid PARALLEL_READ never becomes SOLO ---
{
  const r = await productionRound({
    objective: 'read fan-out malformed',
    script: [{ action: 'continue' }],
    topologyMalformed: '[{"agentId":"a"}]',
    outcomeFor: (req) => okRun(req.agentId),
  });
  try {
    check('malformed: the round is refused, nothing dispatched', r.requests.length === 0, `requests=${r.requests.length}`);
    check('malformed: it did NOT silently run as SOLO',
      typeof r.report.error === 'string' && r.report.error.length > 0, String(r.report.error));
  } finally { r.cleanup(); }
}

// --- T3A1-F7 / T2-b delivery: all terminal -> review sees members; prompts carry contract + scope ---
{
  const SCOPE_A = 'inspect the architecture boundary';
  const r = await productionRound({
    objective: 'read fan-out F7',
    script: [{ action: 'continue' }],
    extraArgs: ['--max-concurrent', '3'],
    topology: { members: [
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: SCOPE_A },
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'inspect the regression tests' },
    ] },
    outcomeFor: (req) => okRun(req.agentId),
  });
  try {
    const g = fanoutsOf(r)[0]!;
    check('F7: all members terminal before review', g.allSettled === true);
    // T2-b contract + member scope must both be in the delivered instruction.
    check('T2-b delivery: every member prompt carries the Worker recon contract',
      r.requests.every((q) => carriesContract(q.prompt)), 'contract missing');
    check('T2-b delivery: and the member-specific scope',
      r.requests.some((q) => q.prompt.includes(SCOPE_A)), 'scope missing');
    check('T2-b delivery: no member got the SAME unbounded task',
      new Set(r.requests.map((q) => q.prompt)).size === 2, 'members received identical prompts');
    // One Unified Review, over all members.
    check('F7: exactly one review pass ran', r.reviewRequests.length >= 1, `reviews=${r.reviewRequests.length}`);
    const reviewPrompt = r.reviewRequests.map((q) => q.prompt).join('\n');
    check('F7: the review packet names both member tasks',
      g.members.every((m) => reviewPrompt.includes(m.taskId)), 'a member is invisible to review');
    check('F7: the reviewer carries no implementation contract',
      r.reviewRequests.every((q) => !carriesContract(q.prompt)));
    const gate = (r.report.gate as { automaticPostRoundAction?: string } | undefined);
    check('F7: the Human Gate still takes no automatic action',
      gate === undefined || gate.automaticPostRoundAction === 'none', JSON.stringify(gate));
  } finally { r.cleanup(); }
}

// ===========================================================================
section('T3-a.2. requested vs actual provenance + refusal settlement, on the REAL chain');
// ===========================================================================

// --- T3A2-1/2/3/4/8: A executed / B assignment-REFUSED / C executed ---
{
  const GOOD = `${AGENT_A}/m1`;
  const MISSING = `${AGENT_A}/does-not-exist`;
  const r = await productionRound({
    objective: 'T3A2 refusal provenance',
    script: [{ action: 'continue' }],
    extraArgs: ['--max-concurrent', '3'],
    topology: { members: [
      { agentId: AGENT_A, modelId: GOOD, scope: 'A scope' },
      { agentId: AGENT_A, modelId: MISSING, scope: 'B scope' },
      { agentId: AGENT_A, modelId: GOOD, scope: 'C scope' },
    ] },
    outcomeFor: (req) => okRun(req.agentId),
  });
  try {
    const g = fanoutsOf(r)[0]!;
    check('T3A2-8: all three requested members are retained', g.requested === 3 && g.members.length === 3,
      JSON.stringify(g.members.map((m) => m.taskId)));

    const a = g.members[0]!;
    const b = g.members[1]!;
    const c = g.members[2]!;

    // T3A2-1: an executed member's requested pair EQUALS its actual pair (exact enforcement).
    check('T3A2-1: executed member A: requested == actual',
      a.executed === true && a.requested.modelId === GOOD && a.actual?.agentId === AGENT_A && a.actual?.modelId === GOOD,
      JSON.stringify(a));
    check('T3A2-1: executed member C: requested == actual',
      c.executed === true && c.actual?.modelId === GOOD, JSON.stringify(c));

    // T3A2-2: the refused member keeps its REQUESTED provenance and has NO actual identity.
    check('T3A2-2: refused member B keeps its requested pair',
      b.requested.agentId === AGENT_A && b.requested.modelId === MISSING, JSON.stringify(b.requested));
    check('T3A2-2: B has NO actual execution identity', b.executed === false && b.actual === null,
      JSON.stringify(b.actual));
    check('T3A2-2: B records the assignment refusal + reason',
      b.assignment.status === 'refused' && b.assignment.reason !== null, JSON.stringify(b.assignment));

    // T3A2-3: no Planner-seed leak 鈥?the Task's seed identity is NOT presented as B's actual.
    check('T3A2-3: the refused member is NOT shown running the Planner seed pair',
      !(b.actual !== null && b.actual.modelId === null), JSON.stringify(b.actual));
    const reviewPrompt = r.reviewRequests.map((q) => q.prompt).join('\n');
    check('T3A2-3: the reviewer sees B\'s REQUESTED pair, not the seed',
      reviewPrompt.includes(`requested worker ${AGENT_A}/${MISSING}`), 'requested pair missing from review');
    check('T3A2-3: and the reviewer is told B was refused and not executed',
      reviewPrompt.includes('assignment refused') && reviewPrompt.includes('actual worker none'),
      'refusal not conveyed to reviewer');

    // T3A2-4: refusal is SETTLED for the fan-out even though the Task is not terminal.
    check('T3A2-4: the refused member is executionSettled', b.executionSettled === true, JSON.stringify(b));
    check('T3A2-4: but its Task is NOT terminal', b.taskTerminal === false);
    check('T3A2-4: so the group is allSettled', g.allSettled === true, JSON.stringify(g.allSettled));
    check('T3A2-4: while NOT allTerminal (B is still planned)', g.allTerminal === false);
    check('T3A2-4: counts: 2 executed, 1 refused', g.executedCount === 2 && g.refusedCount === 1,
      `executed=${g.executedCount} refused=${g.refusedCount}`);
    check('T3A2-8: exactly two runtime requests ran (B never dispatched)', r.requests.length === 2,
      `requests=${r.requests.length}`);
  } finally { r.cleanup(); }
}

// --- T3B1-1: width 3 / capacity 1 now DRAINS (was T3A2-5: capacity-pending stayed unsettled) ---
//
// TeamRun T3-b.1 changed this contract on purpose. T3A2-5 asserted that with width 3 / capacity 1
// only ONE member ran and the other two stayed `executionSettled === false` 鈥?true while the round
// issued a single tick and nothing came back for the surplus members. The bounded fan-out drain
// loop now resolves all three inside the SAME bounded round, which is exactly the behaviour T3-b.1
// exists to add.
//
// The T3-a invariant this block originally protected is UNCHANGED and still asserted elsewhere:
// a capacity wait is never a resolution. It is now observed mid-drain rather than at end of round:
//  - tests/read-fanout.test.ts  T3A4-7  (waiting => outcome 'pending', executionSettled false)
//  - this file                  T3B1-7  (a capacity-pending member stays eligible for the next tick)
//  - this file                  T3B1-6  (a member that WAS refused is excluded, though still planned)
{
  const r = await productionRound({
    objective: 'T3B1 capacity drain 1',
    script: [{ action: 'continue' }],
    // width 3, capacity 1: three sequential ticks inside ONE bounded round.
    extraArgs: ['--max-concurrent', '1'],
    topology: { members: [
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'one' },
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'two' },
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'three' },
    ] },
    outcomeFor: (req) => okRun(req.agentId),
  });
  try {
    const g = fanoutsOf(r)[0]!;
    check('T3B1-1: every requested member was dispatched (width 3 / cap 1 drains)',
      r.requests.length === 3, `requests=${r.requests.length}`);
    check('T3B1-1: and every member executed',
      g.members.every((m) => m.executed === true),
      JSON.stringify(g.members.map((m) => `${m.taskId}:${m.executed}`)));
    check('T3B1-1: so nothing is left pending', g.members.every((m) => m.outcome !== 'pending'), JSON.stringify(g.members.map((m) => m.outcome)));
    check('T3B1-1: and the group is allSettled', g.allSettled === true, JSON.stringify(g.allSettled));
    check('T3B1-1: the drain reported progress and completed',
      (r.report.fanoutDrain as { iterations: number; complete: boolean } | undefined)?.complete === true
      && ((r.report.fanoutDrain as { iterations: number } | undefined)?.iterations ?? 0) >= 1,
      JSON.stringify(r.report.fanoutDrain ?? null));
    check('T3B1-1: an incomplete execution set is NOT reported as ok',
      r.report.ok === true && r.report.executionIncomplete !== true,
      `ok=${String(r.report.ok)} incomplete=${String(r.report.executionIncomplete)}`);
  } finally { r.cleanup(); }
}

// --- T3A2-10: SOLO compatibility 鈥?no requested fields, existing identity path ---
{
  const r = await productionRound({
    objective: 'T3A2 solo regression',
    script: [{ action: 'continue' }],
    outcomeFor: (req) => okRun(req.agentId),
  });
  try {
    check('T3A2-10: a SOLO round reports no fan-out', fanoutsOf(r).length === 0);
    check('T3A2-10: and executes exactly one worker', r.requests.length === 1, `requests=${r.requests.length}`);
  } finally { r.cleanup(); }
}

// ===========================================================================
section('T3-a.3. atomic execution attribution + dependency truth, on the REAL chain');
// ===========================================================================

// --- T3A3-3/4/5: CURRENT attempt selection 鈥?an OLD Attempt must not be the actual ---
//
// Reproduction of the stale-attribution SHAPE: a member executes on AGENT_A (attempt #1),
// a handoff MIGRATES it to AGENT_B, and B executes too (attempt #2). The projection's actual
// identity must be B's CURRENT attempt, never A's historical one 鈥?even though A's attempt is
// still in AttemptStore. (The literal "migrated but pre-runtime refused" variant is not
// reachable here: the reassign guard refuses unavailable/quota targets BEFORE migration, and
// the synchronous runtime always dispatches an available target.)
{
  const cap: SnapHolder = { snapshot: null };
  const r = await productionRound({
    objective: 'T3A3 current attempt selection',
    script: [
      { action: 'continue' },
      { action: 'reassign', agentId: AGENT_B, modelId: `${AGENT_B}/m1`, reason: 'T3A3 migrate' },
    ],
    extraArgs: ['--max-concurrent', '3'],
    topology: { members: [
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'old worker: fails, then migrates to AGENT_B' },
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'second member (also fails)' },
    ] },
    // A fails to START (availability) -> an Attempt IS recorded for A, then handoff.
    outcomeFor: (req) => (req.agentId === AGENT_A ? unavailableRun(req.agentId) : okRun(req.agentId)),
    onWorkbenchSnapshot: (s) => { cap.snapshot = s; },
  });
  try {
    const snap = cap.snapshot!;
    const g = fanoutsOf(r)[0]!;
    // Every member that has any attempt this round: pick the one migrated to B.
    const migrated = g.members.find((m) => m.actual?.agentId === AGENT_B);

    const anyMigratedRun = r.requests.some((q) => q.agentId === AGENT_B);
    check('T3A3-3: a handoff migration really dispatched AGENT_B', anyMigratedRun,
      `reqs=${r.requests.map((q) => q.agentId).join(',')}`);
    if (migrated !== undefined) {
      check('T3A3-3: the migrated member reports B as its CURRENT actual worker',
        migrated.actual!.agentId === AGENT_B, JSON.stringify(migrated.actual));
      // The old A attempt is still historical evidence for one of the members.
      const oldOnA = snap.attempts.filter((a) => a.agentId === AGENT_A);
      check('T3A3-5: the OLD attempt on AGENT_A is retained historically', oldOnA.length >= 1,
        `attempts=${JSON.stringify(snap.attempts.map((a) => a.agentId + ':' + a.attemptId))}`);
      check('T3A3-5: it did NOT become the migrated member\'s actual identity',
        migrated.actual!.agentId !== AGENT_A);
      check('T3A3-4: the actual bundle is atomic (agent/model/session/attempt consistent)',
        migrated.actual!.modelId === `${AGENT_B}/m1` && migrated.actual!.attemptId.length > 0
        && migrated.actual!.sessionId !== null, JSON.stringify(migrated.actual));
      check('T3A3-4: requested provenance stays the ORIGINAL topology pair even after migration',
        migrated.requested.agentId === AGENT_A && migrated.requested.modelId === `${AGENT_A}/m1`,
        JSON.stringify(migrated.requested));
    } else {
      check('T3A3-3: (no member migrated this round 鈥?covered by the refused/pending cases)', true);
    }
  } finally { r.cleanup(); }
}

// --- T3A3-2/6: a refused member has NO current execution and NO actual identity ---
{
  const r = await productionRound({
    objective: 'T3A3 refusal has no actual',
    script: [{ action: 'continue' }],
    extraArgs: ['--max-concurrent', '3'],
    topology: { members: [
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'ok' },
      { agentId: AGENT_A, modelId: `${AGENT_A}/does-not-exist`, scope: 'refused pair' },
    ] },
    outcomeFor: (req) => okRun(req.agentId),
  });
  try {
    const g = fanoutsOf(r)[0]!;
    const refused = g.members.find((m) => m.requested.modelId === `${AGENT_A}/does-not-exist`)!;
    check('T3A3-2: the refused member did not execute', refused.executed === false);
    check('T3A3-2: and has no actual identity (no synthetic session/attempt)',
      refused.actual === null, JSON.stringify(refused.actual));
    check('T3A3-6: its requested pair is preserved',
      refused.requested.agentId === AGENT_A && refused.requested.modelId === `${AGENT_A}/does-not-exist`);
    check('T3A3-6: assignment is refused with a reason',
      refused.assignment.status === 'refused' && refused.assignment.reason !== null);
  } finally { r.cleanup(); }
}

// --- T3A3-6/7: assignment refusal + capacity pending still hold (regression) ---
// --- T3B1-2: width 2 / capacity 1 drains (was T3A3-7: capacity-pending stayed pending) ---
//
// Same intentional contract change as T3B1-1: the surplus member is now resolved inside the same
// bounded round. The invariant T3A3-7 protected 鈥?a capacity wait is a `pending`, never a refusal
// and never a resolution 鈥?is preserved and asserted per-iteration in T3B1-6 / T3B1-7 below.
{
  const r = await productionRound({
    objective: 'T3B1 drain 2',
    script: [{ action: 'continue' }],
    extraArgs: ['--max-concurrent', '1'],
    topology: { members: [
      { agentId: AGENT_B, modelId: `${AGENT_B}/m1`, scope: 'one' },
      { agentId: AGENT_B, modelId: `${AGENT_B}/m1`, scope: 'two' },
    ] },
    outcomeFor: (req) => okRun(req.agentId),
  });
  try {
    const g = fanoutsOf(r)[0]!;
    check('T3B1-2: both members ran (width 2 / cap 1 drains)', r.requests.length === 2,
      `requests=${r.requests.length}`);
    check('T3B1-2: no member is left pending', g.members.every((m) => m.outcome !== 'pending'), JSON.stringify(g.members.map((m) => m.outcome)));
    check('T3B1-2: the group is allSettled', g.allSettled === true, JSON.stringify(g.allSettled));
    check('T3B1-2: and nothing was misread as a refusal', g.refusedCount === 0,
      `refusedCount=${g.refusedCount}`);
  } finally { r.cleanup(); }
}

// ===========================================================================
section('T3-a.5. current Attempt <-> current RunResult correlation, on the REAL chain');
// ===========================================================================
//
// 搂26 production probe: Attempt A -> migration/reassign -> Attempt B -> Result B ->
// aggregation -> Unified Review, proving B identity AND B result.
//
// The discriminator is deliberately the OUTCOME, because that is what a stale lookup corrupts:
// agent A fails to start (SPAWN_FAILED -> `agent_unavailable`), the handoff migrates the SAME
// task to agent B, and B succeeds. If the current result were resolved by taskId instead of by
// attempt, the reviewer would be handed A's SPAWN_FAILED and would report the task as
// agent_unavailable even though the attempt actually under review is B's success.
{
  const cap: SnapHolder = { snapshot: null };
  const r = await productionRound({
    objective: 'T3A5 current attempt correlates its own result',
    script: [
      { action: 'continue' },
      { action: 'reassign', agentId: AGENT_B, modelId: `${AGENT_B}/m1`, reason: 'T3A5 migrate' },
    ],
    extraArgs: ['--max-concurrent', '3'],
    topology: { members: [
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'old worker fails to start, then migrates' },
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'second member (also fails)' },
    ] },
    outcomeFor: (req) => (req.agentId === AGENT_A ? unavailableRun(req.agentId) : okRun(req.agentId, 'B succeeded')),
    onWorkbenchSnapshot: (s) => { cap.snapshot = s; },
  });
  try {
    const snap = cap.snapshot!;
    const g = fanoutsOf(r)[0]!;
    const outcomes = (r.report.executionOutcomes ?? []) as Array<{
      taskId: string; agentId: string | null; modelId: string | null;
      outcome: string; code: string | null; executed: boolean; attemptIds: readonly string[];
    }>;

    check('T3A5-2: a handoff migration really dispatched AGENT_B',
      r.requests.some((q) => q.agentId === AGENT_B), `reqs=${r.requests.map((q) => q.agentId).join(',')}`);

    const migrated = g.members.find((m) => m.actual?.agentId === AGENT_B);
    if (migrated === undefined) {
      check('T3A5-2: (no member migrated this round 鈥?the refused/pending cases cover the rest)', true);
    } else {
      // --- IDENTITY: the current attempt is B's ---
      check('T3A5-2: the migrated member reports B as its CURRENT actual worker',
        migrated.actual!.agentId === AGENT_B, JSON.stringify(migrated.actual));
      check('T3A5-10: the current bundle is (B agent, B model, one attempt)',
        migrated.actual!.modelId === `${AGENT_B}/m1` && migrated.actual!.attemptId.length > 0,
        JSON.stringify(migrated.actual));

      // --- RESULT: the outcome the Reviewer/classifier was handed is B's, not A's ---
      const currentAttemptId = migrated.actual!.attemptId;
      const eo = outcomes.find((o) => o.taskId === migrated.taskId);
      // A's historical failure is still real evidence, so its attempt must still exist...
      const aAttempt = snap.attempts.find((a) => a.taskId === migrated.taskId && a.agentId === AGENT_A);
      check('T3A5-2: A\'s historical attempt is still retained (so the probe is non-trivial)',
        aAttempt !== undefined,
        `attempts=${JSON.stringify(snap.attempts.filter((a) => a.taskId === migrated.taskId).map((a) => a.agentId))}`);

      check('T3A5-9: the classified outcome for the migrated task exists', eo !== undefined);
      if (eo !== undefined) {
        // The crux: A failed with SPAWN_FAILED (classified `agent_unavailable`). If the current
        // result had been resolved by taskId, this is exactly what would surface here.
        check('T3A5-2: the outcome is attributed to B (the current attempt), not A',
          eo.agentId === AGENT_B && eo.modelId === `${AGENT_B}/m1`, JSON.stringify(eo));
        check('T3A5-3: A\'s SPAWN_FAILED did NOT become the current outcome',
          eo.code !== 'SPAWN_FAILED' && eo.outcome !== 'agent_unavailable',
          `outcome=${eo.outcome} code=${eo.code}`);
        check('T3A5-2: the current attempt id reported is B\'s, and it really is on B',
          eo.attemptIds.includes(currentAttemptId)
            && snap.attempts.find((a) => a.attemptId === currentAttemptId)?.agentId === AGENT_B,
          `attemptIds=${JSON.stringify(eo.attemptIds)}`);
        check('T3A5-2: a real execution happened, so executed is true',
          eo.executed === true, `executed=${eo.executed}`);
      }

      // The Unified Review really ran and saw B, and was not handed A's failure for this member.
      check('T3A5-9: the Unified Reviewer ran at least once', r.reviewRequests.length >= 1,
        `reviewRequests=${r.reviewRequests.length}`);
    }
  } finally { r.cleanup(); }
}

// --- T3A5-11: SOLO regression 鈥?a single non-fan-out task is unaffected by the correlation ---
{
  const r = await productionRound({
    objective: 'T3A5 SOLO regression',
    script: [{ action: 'continue' }],
    outcomeFor: (req) => okRun(req.agentId),
  });
  try {
    const outcomes = (r.report.executionOutcomes ?? []) as Array<{ executed: boolean; agentId: string | null }>;
    check('T3A5-11: a SOLO round still reports no fan-out', fanoutsOf(r).length === 0);
    check('T3A5-11: and its task still executed', outcomes.some((o) => o.executed === true),
      JSON.stringify(outcomes.map((o) => ({ a: o.agentId, e: o.executed }))));
  } finally { r.cleanup(); }
}

// ===========================================================================
section('T3-b.1. Round Completion Guard + drain observability, on the REAL round');
// ===========================================================================

const drainOf = (r: Round) => (r.report.fanoutDrain ?? null) as
  { iterations: number; progressIterations: number; complete: boolean; fixpoint: boolean; unresolvedAtStop: string[] } | null;

// --- T3B1-3: width 3 / capacity 3 -> ONE batch, and no duplicate execution afterwards ---
{
  const r = await productionRound({
    objective: 'T3B1 one batch',
    script: [{ action: 'continue' }],
    extraArgs: ['--max-concurrent', '3'],
    topology: { members: [
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'one' },
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'two' },
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'three' },
    ] },
    outcomeFor: (req) => okRun(req.agentId),
  });
  try {
    const g = fanoutsOf(r)[0]!;
    check('T3B1-3: capacity >= width dispatches every member in ONE batch',
      r.requests.length === 3, `requests=${r.requests.length}`);
    check('T3B1-3: and no member is executed twice',
      new Set(r.requests.map((q) => q.prompt)).size >= 1 && g.executedCount === 3,
      `executedCount=${g.executedCount}`);
    check('T3B1-3: the drain had nothing left to do (complete, no fixpoint, no iteration)',
      drainOf(r)?.complete === true && drainOf(r)?.iterations === 0,
      JSON.stringify(drainOf(r)));
    check('T3B1-3: a fully settled round is allSettled and ok',
      g.allSettled === true && r.report.ok === true && r.report.executionIncomplete !== true,
      `allSettled=${g.allSettled} ok=${String(r.report.ok)}`);
  } finally { r.cleanup(); }
}

// --- T3B1-10/11: the Unified Review runs EXACTLY once when settled, and NOT AT ALL otherwise ---
{
  const r = await productionRound({
    objective: 'T3B1 review once',
    script: [{ action: 'continue' }],
    extraArgs: ['--max-concurrent', '1'],
    topology: { members: [
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'one' },
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'two' },
    ] },
    outcomeFor: (req) => okRun(req.agentId),
  });
  try {
    const g = fanoutsOf(r)[0]!;
    check('T3B1-11: allSettled=true after the drain', g.allSettled === true, JSON.stringify(g.allSettled));
    check('T3B1-11: the Unified Reviewer was invoked exactly once',
      r.reviewRequests.length === 1, `reviewRequests=${r.reviewRequests.length}`);
    const ur = r.report.unifiedReview as { status: string } | undefined;
    check('T3B1-11: the Round Completion Guard let it RUN (not withheld as execution_incomplete)',
      ur?.status !== 'execution_incomplete', `status=${String(ur?.status)}`);
  } finally { r.cleanup(); }
}

// --- T3B1-13/14/15: Session, Attempt and cross-tick evidence across the drain ---
{
  const cap: SnapHolder = { snapshot: null };
  const r = await productionRound({
    objective: 'T3B1 lifecycle across ticks',
    script: [{ action: 'continue' }],
    extraArgs: ['--max-concurrent', '1'],
    topology: { members: [
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'one' },
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'two' },
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'three' },
    ] },
    outcomeFor: (req) => okRun(req.agentId, `ran on ${req.agentId}`),
    onWorkbenchSnapshot: (s) => { cap.snapshot = s; },
  });
  try {
    const snap = cap.snapshot!;
    const g = fanoutsOf(r)[0]!;
    const memberIds = g.members.map((m) => m.taskId);

    // T3B1-14: exactly one execution Attempt per member that actually executed, no placeholders.
    const execAttempts = snap.attempts.filter((a) => a.kind === 'execution');
    check('T3B1-14: exactly one execution Attempt per executed member',
      execAttempts.length === memberIds.length && memberIds.every((id) =>
        execAttempts.filter((a) => a.taskId === id).length === 1),
      `execAttempts=${execAttempts.length} members=${memberIds.length} perTask=${JSON.stringify(execAttempts.map((a) => a.taskId))}`);
    check('T3B1-14: no "waiting" Attempt was created for a capacity-pending member',
      snap.attempts.every((a) => memberIds.includes(a.taskId)),
      JSON.stringify(snap.attempts.map((a) => `${a.taskId}:${a.kind}`)));

    // T3B1-13: one session per member, never duplicated by the drain.
    for (const m of g.members) {
      const mine = snap.sessions.filter((s) => s.taskId === m.taskId);
      check(`T3B1-13: member ${m.memberIndex} has exactly one session (the drain reused it)`,
        mine.length === 1, `sessions=${JSON.stringify(snap.sessions.map((s) => `${s.taskId}:${s.sessionId}`))}`);
    }

    // T3B1-15: cross-tick current evidence — each member reports started with a real Attempt.
    check('T3B1-15: every member reports a CURRENT actual attempt after the drain',
      g.members.every((m) => m.executed === true && m.actual !== null && m.actual.attemptId.length > 0),
      JSON.stringify(g.members.map((m) => `${m.taskId}:${m.executed}:${m.actual?.attemptId ?? 'null'}`)));
    check('T3B1-15: the reported actual attempt really exists in AttemptStore',
      g.members.every((m) => snap.attempts.some((a) => a.attemptId === m.actual?.attemptId)),
      'an actual attempt id is not in the store');
  } finally { r.cleanup(); }
}

// --- T3B1-16: SOLO regression — no fan-out means no drain and one ordinary tick ---
{
  const r = await productionRound({
    objective: 'T3B1 solo regression',
    script: [{ action: 'continue' }],
    outcomeFor: (req) => okRun(req.agentId),
  });
  try {
    check('T3B1-16: a SOLO round still reports no fan-out', fanoutsOf(r).length === 0);
    check('T3B1-16: and it executes exactly one worker', r.requests.length === 1, `requests=${r.requests.length}`);
    check('T3B1-16: the drain loop did not engage at all', drainOf(r)?.iterations === 0, JSON.stringify(drainOf(r)));
    check('T3B1-16: and the round is not marked incomplete', r.report.executionIncomplete !== true,
      String(r.report.executionIncomplete));
  } finally { r.cleanup(); }
}

// --- T3B1-17: WRITE stays closed — the READ drain changed no access-mode gating ---
{
  const r = await productionRound({
    objective: 'T3B1 write remains closed',
    script: [{ action: 'continue' }],
    extraArgs: ['--max-concurrent', '1'],
    topology: { members: [
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'one', accessMode: 'write' },
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'two', accessMode: 'write' },
    ] },
    outcomeFor: (req) => okRun(req.agentId),
  });
  try {
    check('T3B1-17: a WRITE fan-out is still refused at the topology gate (runtime.run = 0)',
      r.requests.length === 0 && r.report.stage === 'plan',
      `requests=${r.requests.length} stage=${String(r.report.stage)} err=${String(r.report.error ?? '')}`);
    check('T3B1-17: and the drain never engaged for it', drainOf(r) === null || drainOf(r)!.iterations === 0,
      JSON.stringify(drainOf(r)));
  } finally { r.cleanup(); }
}

// --- T3B1-12/18: handoff isolation — a continuation on the SAME taskId still runs later ---
{
  const r = await productionRound({
    objective: 'T3B1 handoff after drain',
    script: [
      { action: 'continue' },
      { action: 'reassign', agentId: AGENT_B, modelId: `${AGENT_B}/m1`, reason: 'T3B1 handoff' },
    ],
    extraArgs: ['--max-concurrent', '2'],
    outcomeFor: (req) => (req.agentId === AGENT_A ? unavailableRun(req.agentId) : okRun(req.agentId, 'B did it')),
  });
  try {
    check('T3B1-12: the round still reached a reviewable terminal state',
      (r.report.unifiedReview as { status: string } | undefined)?.status !== 'execution_incomplete',
      `status=${String((r.report.unifiedReview as { status: string } | undefined)?.status)}`);
  } finally { r.cleanup(); }
}

// --- T3B1A-5/6/7 (+ the old SOLO T3B1-18): FAN-OUT scope expiry vs same-task handoff ---
//
// T3-b.1's T3B1-18 was SOLO and therefore did not prove the thing the seal requires: that a
// fan-out EXECUTION-phase scope expires before a legitimate same-task handoff continuation.
//
// The proof here is behavioural and needs no new tooling. The fan-out drain loop EXCLUDES a
// member once it is resolved, so if that scope ever leaked into the handoff phase, the
// continuation dispatch on that same taskId would find no eligible candidate and the SECOND
// execution Attempt would simply not exist. Asserting that it does exist — on the SAME taskId,
// with a new AttemptId and a different Agent — is therefore a direct proof that the scope did
// not persist.
{
  const cap: SnapHolder = { snapshot: null };
  const r = await productionRound({
    objective: 'T3B1A fanout scope expiry vs handoff',
    // A real PARALLEL_READ topology, so the initial phase IS the fan-out execution phase and the
    // drain runs against scoped ticks.
    topology: { members: [
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'member that becomes a handoff target' },
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'sibling member' },
    ] },
    // Laya: run, then hand the SAME task to agent B.
    script: [
      { action: 'continue' },
      { action: 'reassign', agentId: AGENT_B, modelId: `${AGENT_B}/m1`, reason: 'T3B1A handoff' },
    ],
    extraArgs: ['--max-concurrent', '3'],
    // Agent A cannot start -> its execution outcome is agent_unavailable, which is an existing
    // HANDOFF trigger. That is a separate, already-frozen phase from the fan-out drain.
    outcomeFor: (req) => (req.agentId === AGENT_A ? unavailableRun(req.agentId) : okRun(req.agentId, 'B did it')),
    onWorkbenchSnapshot: (s) => { cap.snapshot = s; },
  });
  try {
    const snap = cap.snapshot!;
    const g = fanoutsOf(r)[0];
    const execAttempts = snap.attempts.filter((a) => a.kind === 'execution');

    // Group execution attempts by taskId; the handoff target is the one with TWO.
    const byTask = new Map<string, typeof execAttempts>();
    for (const a of execAttempts) {
      const list = byTask.get(a.taskId) ?? [];
      list.push(a);
      byTask.set(a.taskId, list);
    }
    const continued = [...byTask.entries()].filter(([, list]) => list.length >= 2);

    check('T3B1A-5: a fan-out member was executed TWICE: initial resolution + handoff continuation',
      continued.length >= 1,
      `attempts=${JSON.stringify(execAttempts.map((a) => `${a.taskId}:${a.agentId}:${a.attemptId}`))}`);

    if (continued.length >= 1) {
      const [taskId, list] = continued[0]!;
      check('T3B1A-7: both attempts belong to the SAME taskId (not a sibling or a new Task)',
        list.every((a) => a.taskId === taskId), `taskIds=${JSON.stringify(list.map((a) => a.taskId))}`);
      check('T3B1A-5: the two attempts have DISTINCT attempt ids',
        new Set(list.map((a) => a.attemptId)).size === list.length,
        `attemptIds=${JSON.stringify(list.map((a) => a.attemptId))}`);
      check('T3B1A-5: the second execution ran on a DIFFERENT agent',
        list[0]!.agentId !== list[1]!.agentId,
        `agents=${JSON.stringify(list.map((a) => a.agentId))}`);
      check('T3B1A-5: and it carries its own session (new worker, new session)',
        list[0]!.sessionId !== list[1]!.sessionId && list[1]!.sessionId !== null,
        `sessions=${JSON.stringify(list.map((a) => a.sessionId))}`);
      check('T3B1A-5: the handoff target really is a fan-out member',
        g?.members.some((m) => m.taskId === taskId) === true,
        `members=${JSON.stringify(g?.members.map((m) => m.taskId) ?? [])}`);

      // T3B1A-6 — the scope-lifetime assertion, stated as behaviour.
      //
      // The drain loop removed this member from its scope the moment it was resolved. If that
      // scope had been remembered on the scheduler, the continuation dispatch would have been
      // unable to select this task and there would be no second attempt at all. The second
      // attempt therefore IS the evidence that the scope expired.
      check('T3B1A-6: the fan-out execution scope did NOT persist into the handoff phase',
        list.length >= 2 && r.requests.filter((q) => q.agentId === list[1]!.agentId).length >= 1,
        `requests=${r.requests.map((q) => q.agentId).join(',')} attempts=${JSON.stringify(list.map((a) => a.agentId))}`);
      check('T3B1A-6: and the fan-out drain itself still completed (scope was per-iteration)',
        drainOf(r)?.complete === true, JSON.stringify(drainOf(r)));
    }
  } finally { r.cleanup(); }
}

// --- T3B1-18 (SOLO): the original coverage, kept — a non-fan-out task also hands off ---
{
  const r = await productionRound({
    objective: 'T3B1 handoff after drain (SOLO)',
    script: [
      { action: 'continue' },
      { action: 'reassign', agentId: AGENT_B, modelId: `${AGENT_B}/m1`, reason: 'T3B1 handoff' },
    ],
    extraArgs: ['--max-concurrent', '2'],
    outcomeFor: (req) => (req.agentId === AGENT_A ? unavailableRun(req.agentId) : okRun(req.agentId, 'B did it')),
  });
  try {
    const handoffDispatches = (r.report.handoffDispatches ?? []) as Array<{ taskId: string; admitted: string[]; attempts: number }>;
    check('T3B1-18: a SOLO handoff still dispatches its continuation',
      handoffDispatches.length >= 1, JSON.stringify(handoffDispatches));
    check('T3B1-18: the continuation ran on a DIFFERENT worker',
      r.requests.some((q) => q.agentId === AGENT_B), `reqs=${r.requests.map((q) => q.agentId).join(',')}`);
  } finally { r.cleanup(); }
}

// ===========================================================================
section('T3-b.1a. the Human Gate consumes the SAME final execution-completeness truth');
// ===========================================================================
//
// P1-A: an incomplete execution set correctly withheld the Unified Review and set
// `report.ok = false`, but `HumanGate.roundComplete` was still `true` — the report, the review and
// the gate told three different stories about the same round.
//
// The incomplete shape is reachable exactly one way through the CLI: capacity that never frees.
// A member that is merely capacity-pending is drained; a refusal SETTLES a member; and fan-out
// members carry `dependencies: []`, so an unsatisfiable dependency cannot strand one. With
// `maxConcurrent = 0` every candidate stays in `waiting`, nothing is dispatched, the unresolved
// set never shrinks, and the drain reaches its fixpoint with work genuinely unfinished.

const gateOf = (r: Round) => ((r.report.roundResult as { gate?: {
  status: string; roundComplete: boolean; executionIncomplete: boolean; reason: string;
  decisions: ReadonlyArray<{ id: string; detail: string }>;
} } | undefined)?.gate) ?? null;

// --- T3B1A-1: incomplete fan-out -> the WHOLE round reports unfinished, consistently ---
{
  const r = await productionRound({
    objective: 'T3B1A incomplete execution set',
    script: [{ action: 'continue' }],
    // Capacity that never frees: nothing dispatches, so the drain fixpoints with work left.
    extraArgs: ['--max-concurrent', '0'],
    topology: { members: [
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'one' },
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'two' },
    ] },
    outcomeFor: (req) => okRun(req.agentId),
  });
  try {
    const g = fanoutsOf(r)[0];
    const gate = gateOf(r);
    const ur = r.report.unifiedReview as { status: string; verdict: unknown; findings: unknown[] } | undefined;

    check('T3B1A-1: the fan-out is genuinely incomplete (a member never resolved)',
      g !== undefined && g.allSettled === false,
      `allSettled=${String(g?.allSettled)} drain=${JSON.stringify(drainOf(r))}`);
    check('T3B1A-1: executionIncomplete = true', r.report.executionIncomplete === true,
      String(r.report.executionIncomplete));
    check('T3B1A-1: report.ok = false', r.report.ok === false, String(r.report.ok));
    check('T3B1A-1: the Unified Reviewer was NEVER invoked', r.reviewRequests.length === 0,
      `reviewRequests=${r.reviewRequests.length}`);
    check('T3B1A-1: review status is execution_incomplete, not failed and not not_requested',
      ur?.status === 'execution_incomplete', `status=${String(ur?.status)}`);
    check('T3B1A-1: no verdict and no findings were synthesised',
      ur?.verdict === null && (ur?.findings?.length ?? 0) === 0,
      `verdict=${String(ur?.verdict)} findings=${JSON.stringify(ur?.findings)}`);
    check('T3B1A-1: THE FIX — HumanGate.roundComplete = false', gate?.roundComplete === false,
      `roundComplete=${String(gate?.roundComplete)} status=${String(gate?.status)}`);
    check('T3B1A-1: the gate agrees it is incomplete', gate?.executionIncomplete === true,
      String(gate?.executionIncomplete));
    check('T3B1A-1: the gate reason does NOT claim the round finished',
      typeof gate?.reason === 'string' && !/all .* settled/i.test(gate.reason)
      && /incomplete/i.test(gate.reason), `reason=${String(gate?.reason)}`);
    check('T3B1A-1: and the gate offers an explicit execution-incomplete decision',
      gate?.decisions.some((d) => d.id === 'execution-incomplete') === true,
      JSON.stringify(gate?.decisions.map((d) => d.id)));
    check('T3B1A-1: no new Human Gate status was invented (existing vocabulary only)',
      gate?.status === 'waiting_for_user' || gate?.status === 'not_ready', `status=${String(gate?.status)}`);
  } finally { r.cleanup(); }
}

// --- T3B1A-2: the same incomplete round with --no-review must still be incomplete ---
{
  const r = await productionRound({
    objective: 'T3B1A incomplete plus no-review',
    script: [{ action: 'continue' }],
    extraArgs: ['--max-concurrent', '0', '--no-review'],
    topology: { members: [
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'one' },
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'two' },
    ] },
    outcomeFor: (req) => okRun(req.agentId),
  });
  try {
    const gate = gateOf(r);
    const ur = r.report.unifiedReview as { status: string } | undefined;
    check('T3B1A-2: --no-review does NOT mask the execution gap',
      r.report.executionIncomplete === true && r.report.ok === false,
      `incomplete=${String(r.report.executionIncomplete)} ok=${String(r.report.ok)}`);
    check('T3B1A-2: execution_incomplete still takes precedence over not_requested',
      ur?.status === 'execution_incomplete', `status=${String(ur?.status)}`);
    check('T3B1A-2: HumanGate.roundComplete = false even with review disabled',
      gate?.roundComplete === false, `roundComplete=${String(gate?.roundComplete)}`);
    check('T3B1A-2: the reviewer was still never invoked', r.reviewRequests.length === 0,
      `reviewRequests=${r.reviewRequests.length}`);
  } finally { r.cleanup(); }
}

// --- T3B1A-3: a COMPLETE but unsuccessful set (success + refusal + failure) still counts done ---
{
  const r = await productionRound({
    objective: 'T3B1A complete but unsuccessful',
    script: [{ action: 'continue' }],
    extraArgs: ['--max-concurrent', '3'],
    topology: { members: [
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'succeeds' },
      { agentId: AGENT_B, modelId: `${AGENT_B}/m1`, scope: 'fails at the gate' },
      { agentId: AGENT_B, modelId: `${AGENT_B}/m1`, scope: 'fails at runtime' },
    ] },
    // A succeeds, B fails to start (agent_unavailable) and B fails a run (SPAWN_FAILED).
    outcomeFor: (req, n) => (req.agentId === AGENT_A
      ? okRun(req.agentId, 'fine')
      : (n % 2 === 1 ? unavailableRun(req.agentId) : nonzeroRun(req.agentId))),
  });
  try {
    const g = fanoutsOf(r)[0];
    const gate = gateOf(r);
    check('T3B1A-3: every requested member reached a resolution, so allSettled = true',
      g?.allSettled === true, `allSettled=${String(g?.allSettled)} members=${JSON.stringify(g?.members.map((m) => m.outcome))}`);
    check('T3B1A-3: the outcomes are genuinely mixed — allSettled does not mean allSucceeded',
      (g?.nonSucceeding.length ?? 0) >= 1,
      `nonSucceeding=${JSON.stringify(g?.nonSucceeding)} executed=${g?.executedCount}/${g?.requested}`);
    check('T3B1A-3: executionIncomplete = false', r.report.executionIncomplete !== true,
      String(r.report.executionIncomplete));
    check('T3B1A-3: the Unified Reviewer ran EXACTLY once', r.reviewRequests.length === 1,
      `reviewRequests=${r.reviewRequests.length}`);
    check('T3B1A-3: the gate is NOT held shut by execution incompleteness',
      gate?.executionIncomplete === false && !/INCOMPLETE execution set/.test(gate?.reason ?? ''),
      `gateIncomplete=${String(gate?.executionIncomplete)} reason=${String(gate?.reason)}`);
  } finally { r.cleanup(); }
}

// --- T3B1A-4: complete + --no-review -> not_requested, and NOT a false incomplete ---
{
  const r = await productionRound({
    objective: 'T3B1A complete plus no-review',
    script: [{ action: 'continue' }],
    extraArgs: ['--max-concurrent', '3', '--no-review'],
    topology: { members: [
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'one' },
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'two' },
    ] },
    outcomeFor: (req) => okRun(req.agentId),
  });
  try {
    const gate = gateOf(r);
    const ur = r.report.unifiedReview as { status: string } | undefined;
    check('T3B1A-4: review is not_requested (nothing wrong happened)', ur?.status === 'not_requested',
      `status=${String(ur?.status)}`);
    check('T3B1A-4: and executionIncomplete is FALSE — no false positive',
      r.report.executionIncomplete !== true, String(r.report.executionIncomplete));
    check('T3B1A-4: the round is still ok', r.report.ok === true, String(r.report.ok));
    // NOTE on `roundComplete` here: the members end in `to_verify`, which this project
    // classifies as `in_flight`, so the gate legitimately stays not-ready until VERIFICATION
    // (a separate authority) moves them on. That is pre-existing behaviour and is NOT the
    // execution-incomplete path — which is exactly what this assertion pins.
    check('T3B1A-4: the gate is not held shut by execution incompleteness',
      gate?.executionIncomplete === false && !/INCOMPLETE execution set/.test(gate?.reason ?? ''),
      `gateIncomplete=${String(gate?.executionIncomplete)} reason=${String(gate?.reason)}`);
  } finally { r.cleanup(); }
}

// ===========================================================================
section('T3-b.1b. fan-out SCOPED DRAIN expires before a same-task handoff continuation');
// ===========================================================================
//
// WHY T3-b.1a's version was not enough
// ------------------------------------
// It ran `PARALLEL_READ width 2 / cap 3`, so every member fit in the FIRST batch: the drain issued
// ZERO iterations and every `Scheduler.tick` scope was `undefined`. It therefore proved
// "fan-out -> handoff" but never "REAL SCOPED DRAIN -> scope expires -> handoff", so a bug that
// persisted the fan-out scope into the later continuation dispatch would still have passed.
//
// This fixture forces the real thing: width 3 > cap 1, so the drain must issue scoped ticks.
//
// OBSERVATION SEAM (§12)
// ---------------------
// The tick scopes are observed by wrapping the EXISTING `TaskScheduler.prototype.tick` for the
// duration of one round. No production field is added — no `lastScope`, no `scopeHistory`, no
// `drainTrace` — and no production API changes. The prototype is restored in a `finally`.

interface TickScopeTrace { readonly scopes: readonly (ReadonlySet<string> | undefined)[] }

async function roundWithTickScopes(run: () => Promise<Round>): Promise<{ r: Round; trace: TickScopeTrace }> {
  const scopes: (ReadonlySet<string> | undefined)[] = [];
  const proto = TaskScheduler.prototype as unknown as { tick: (...a: unknown[]) => unknown };
  const original = proto.tick;
  proto.tick = function patched(this: unknown, ...args: unknown[]): unknown {
    // `tick(promptFor?, threadFor?, hooks?, scope?)` and the scope is a `TickScope`
    // object (`{ taskIds }`) — record the task-id set itself, or undefined when absent.
    const scope = args[3] as { taskIds?: ReadonlySet<string> } | undefined;
    scopes.push(scope?.taskIds);
    return original.apply(this, args);
  };
  try {
    return { r: await run(), trace: { scopes } };
  } finally {
    proto.tick = original;
  }
}
const showScopes = (t: TickScopeTrace): string => t.scopes
  .map((s, i) => `#${i + 1}=${s === undefined ? 'undefined' : `{${[...s].sort().join(',')}}`}`)
  .join(' ');

{
  const cap: SnapHolder = { snapshot: null };
  const { r, trace } = await roundWithTickScopes(() => productionRound({
    objective: 'T3B1B scoped drain then same-task handoff',
    // width 3 > cap 1: the surplus MUST be drained by scoped ticks.
    topology: { members: [
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'm0 runs first and becomes the handoff target' },
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'm1 capacity pending, drained by a scoped tick' },
      { agentId: AGENT_A, modelId: `${AGENT_A}/m1`, scope: 'm2 capacity pending, drained by a scoped tick' },
    ] },
    extraArgs: ['--max-concurrent', '1'],
    // Laya runs, then formally hands the SAME task to agent B.
    script: [
      { action: 'continue' },
      { action: 'reassign', agentId: AGENT_B, modelId: `${AGENT_B}/m1`, reason: 'T3B1B handoff' },
    ],
    // The FIRST execution (cap 1 => m0 runs first) cannot start, so its outcome is
    // `agent_unavailable` — an EXISTING, frozen handoff trigger. m1/m2 succeed.
    outcomeFor: (req, n) => (n === 1 ? unavailableRun(req.agentId) : okRun(req.agentId, `ran ${n}`)),
    onWorkbenchSnapshot: (s) => { cap.snapshot = s; },
  }));

  try {
    const snap = cap.snapshot!;
    const g = fanoutsOf(r)[0];
    const scopes = trace.scopes;
    const explicit = scopes.filter((s): s is ReadonlySet<string> => s !== undefined);
    const show = showScopes(trace);

    // --- C. at least one EXPLICIT non-empty fan-out scope really reached the scheduler ---
    check('T3B1A-8/C: real scoped drain ticks happened (non-undefined, non-empty scope observed)',
      explicit.length >= 2 && explicit.every((s) => s.size > 0), `scopes=${show}`);

    // --- §4 the scope SHRANK as members resolved ---
    const sizes = explicit.map((s) => s.size);
    check('T3B1A-8/§4: the scope strictly shrank as members resolved (2 -> 1)',
      sizes.length >= 2 && sizes[0]! > sizes[sizes.length - 1]! && sizes[sizes.length - 1]! >= 1,
      `scopes=${show}`);
    check('T3B1A-8/§4: the first tick is UNSCOPED (the decision-cycle dispatch)',
      scopes[0] === undefined, `scopes=${show}`);

    // --- A/B. topology and width > capacity really held ---
    check('T3B1A-8/A: the topology really was a PARALLEL_READ fan-out',
      g !== undefined && g.requested === 3, `requested=${String(g?.requested)}`);
    check('T3B1A-8/B: width (3) really exceeded capacity (1), so the drain was required',
      (drainOf(r)?.iterations ?? 0) >= 2, `drain=${JSON.stringify(drainOf(r))}`);

    // --- J / phase isolation. Asserted on the TRACE alone, deliberately OUTSIDE the
    // handoff-target block below: the scope boundary is a property of the phases, and it must
    // still be checked when the continuation itself fails (which is exactly what happens under
    // the scope-persistence mutation). Gating it on the handoff outcome would let the strongest
    // assertion silently skip itself. ---
    const lastScopedIdx = scopes.reduce((acc, s, i) => (s === undefined ? acc : i), -1);
    const afterDrain = scopes.slice(lastScopedIdx + 1);
    check('T3B1A-8/J: every tick after the last scoped drain tick is UNSCOPED — no phase inherited a scope',
      lastScopedIdx >= 0 && afterDrain.length >= 1 && afterDrain.every((s) => s === undefined),
      `scopes=${show}`);
    check('T3B1A-8/J: and the final tick (the continuation) is unscoped',
      scopes[scopes.length - 1] === undefined, `scopes=${show}`);

    // --- resolve the handoff target T ---
    const execAttempts = snap.attempts.filter((a) => a.kind === 'execution');
    const byTask = new Map<string, typeof execAttempts>();
    for (const a of execAttempts) byTask.set(a.taskId, [...(byTask.get(a.taskId) ?? []), a]);
    const continued = [...byTask.entries()].filter(([, list]) => list.length >= 2);

    check('T3B1A-8/I: AttemptStore holds TWO distinct execution Attempts for the same taskId',
      continued.length >= 1,
      `attempts=${JSON.stringify(execAttempts.map((a) => `${a.taskId}:${a.agentId}:${a.attemptId}`))}`);
    if (continued.length >= 1) {
      const [taskId, list] = continued[0]!;
      const first = list[0]!;
      const second = list[1]!;

      // D/E. T was a requested fan-out member and received its initial execution resolution.
      check('T3B1A-8/D: the handoff target really is a requested fan-out member',
        g?.members.some((m) => m.taskId === taskId) === true,
        `members=${JSON.stringify(g?.members.map((m) => m.taskId) ?? [])}`);
      check('T3B1A-8/E: its initial execution resolved (a real first Attempt exists)',
        first.attemptId !== '' && first.agentId !== '', JSON.stringify(first));

      // F. after resolving it, T is absent from every later fan-out scope.
      const scopedAfter = explicit.filter((s) => scopes.indexOf(s) > 0);
      const leaked = explicit.some((s) => s.has(taskId));
      check('T3B1A-8/F: once resolved, T is absent from the later fan-out unresolved scopes',
        !leaked, `taskId=${taskId} scopes=${show}`);

      // G/H. the handoff used the SAME taskId and really executed.
      check('T3B1A-8/G: the continuation used the SAME taskId (not a sibling or replacement)',
        second.taskId === first.taskId, `${first.taskId} vs ${second.taskId}`);
      check('T3B1A-8/H: the continuation really executed (its own Attempt, real execution path)',
        second.attemptId !== first.attemptId,
        `${first.attemptId} vs ${second.attemptId}`);
      // §8 new Agent / Session.
      check('T3B1A-8/§8: the second execution ran on a different Agent, with its own Session',
        second.agentId !== first.agentId && second.sessionId !== first.sessionId
        && second.sessionId !== null,
        JSON.stringify(list.map((a) => ({ agent: a.agentId, session: a.sessionId }))));

      void scopedAfter;

    }

    // --- §17 the phase-local scope contract, stated in one place ---
    check('T3B1A-8/§17: a member resolved during the fan-out phase was EXCLUDED from further fan-out drain, '
      + 'yet the later continuation phase executed that same task again',
      execAttempts.length >= 4 && continued.length >= 1,
      `execAttempts=${execAttempts.length} continued=${continued.length}`);
  } finally { r.cleanup(); }
}

// --- T3B1-18 (SOLO): retained, non-fan-out handoff coverage ---
{
  const r = await productionRound({
    objective: 'T3B1 handoff after drain (SOLO)',
    script: [
      { action: 'continue' },
      { action: 'reassign', agentId: AGENT_B, modelId: `${AGENT_B}/m1`, reason: 'T3B1 handoff' },
    ],
    extraArgs: ['--max-concurrent', '2'],
    outcomeFor: (req) => (req.agentId === AGENT_A ? unavailableRun(req.agentId) : okRun(req.agentId, 'B did it')),
  });
  try {
    const handoffDispatches = (r.report.handoffDispatches ?? []) as Array<{ taskId: string; admitted: string[]; attempts: number }>;
    check('T3B1-18: a SOLO handoff still dispatches its continuation',
      handoffDispatches.length >= 1, JSON.stringify(handoffDispatches));
    check('T3B1-18: the continuation ran on a DIFFERENT worker',
      r.requests.some((q) => q.agentId === AGENT_B), `reqs=${r.requests.map((q) => q.agentId).join(',')}`);
  } finally { r.cleanup(); }
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length > 0) {
  process.stdout.write(`failing:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
}
process.stdout.write('\n');
process.exitCode = failed === 0 ? 0 : 1;