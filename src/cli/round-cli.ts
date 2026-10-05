/**
 * src/cli/round-cli.ts - ONE Execution Round, wired to the existing authority layer.
 *
 *   orchestrator round "<objective>" [options]
 *
 * WHAT THIS IS
 * ------------
 * The production path that was missing. Until now `NativeWorkbench` and
 * `runDecisionCycle` were reachable only from tests: nothing in `src/` outside
 * `task-cli.ts` ever imported the orchestration layer, and `task-cli.ts` used it
 * for `WorkspaceManager` and git only. The decision brain (`src/decision/`) and the
 * authority layer (`src/orchestration/`) had never been joined in production.
 *
 * This joins them, and adds NOTHING to either side:
 *
 *   user objective
 *     -> Laya classifies it            (existing: createLayaDecisionProvider + classifyTask)
 *     -> Workbench plans it            (existing: Planner, the only candidate generator)
 *     -> Assignment binds each child   (existing: the only identity authority)
 *     -> ONE runDecisionCycle          (existing: observe -> decide -> validate -> apply)
 *     -> report, and the process ends
 *
 * THE RUNTIME MODEL IS ONE ROUND, NOT A LOOP
 * -----------------------------------------
 * Decision -> Execute -> Observe -> Report -> END. There is deliberately no
 * `while (true)`, no `setInterval`, no auto-retry and no auto-replan here. A round
 * that needs another round says so in its report and exits; the human decides
 * whether to run another. That is what keeps "unbounded" from being a default that
 * nobody chose.
 *
 * THE AUTHORITIES ARE UNCHANGED
 * -----------------------------
 *   TaskStore      still the only task state (in-memory by design, 5C-1)
 *   TaskScheduler  still the only dispatch
 *   Orchestrator   still the only native execution edge
 *   Verification   still the only completion authority - and it is NOT called here
 *   AttemptStore   still only records evidence
 *   Assignment     still the only identity authority
 *
 * Note the consequence, stated rather than hidden: after a round the tasks sit in
 * `to_verify`. This command does NOT verify them. Per the documented product model
 * (`Execution Round + Codex Review + Human Gate`) the human gate is the last word:
 * inventing an auto-verify step here would quietly make this command a second
 * completion authority.
 *
 * THE ROUND IS REVIEWED, ONCE, BEFORE IT REPORTS
 * ----------------------------------------------
 * The product model's review step used to be a sentence in the operator-facing report —
 * "next: Codex review, then a human gate" — and in practice the failure, quota and
 * refusal paths just ended without one. Now the round closes with a single native review
 * of the WHOLE round (`orchestration/unified-review.ts`), for every terminal outcome:
 * success, failure, timeout, quota exhaustion, agent unavailability, lease or resource
 * refusal alike.
 *
 * It runs through the EXISTING native review seam, `RuntimeOrch.review`, so there is
 * still exactly one `runtime.run(` edge in this system, and it adds no second scheduler,
 * decision brain, verdict store or completion authority. A review verdict NEVER writes
 * TaskStore, and it NEVER triggers a retry, reassign or replan: `rework` is a
 * recommendation the user may act on when they choose the next round.
 *
 * A review that cannot happen is REPORTED as `unavailable` / `failed` with a reason. It
 * is never retried, never faked, and it never erases the execution evidence.
 *
 * PROVENANCE OF THE GATE INPUTS
 * -----------------------------
 * Every signal the spawn gate reads is a REAL observation, and none of it is
 * invented in this file:
 *
 *   descriptors   runtime Orchestrator.descriptors()      (capability + launcher truth)
 *   agentStatus   buildQuotaCenter(...)                   (the real probe assembler)
 *   quotaRecords  collectAll(DEFAULT_PROVIDERS)           (the real probes)
 *   registry      seedRegistry(configs, probes, now)      (the existing derivation)
 *   budgets       BudgetManager, allocated per round      (orchestration budget, not billing)
 *
 * An agent that could not be probed simply has no quota record, and the gate then
 * denies it with `quota-record-absent`. That is the gate working, not a bug to be
 * papered over with a fabricated `available` row.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { Orchestrator as RuntimeOrchestrator } from '../orchestrator/orchestrator.ts';
import type { AgentConfig } from '../orchestrator/config.ts';
import {
  BudgetManager,
  ModelRegistry,
  buildQuotaCenter,
  collectAll,
  collectObservedUsage,
  seedRegistry,
  DEFAULT_PROVIDERS,
  type QuotaProbe,
} from '../quota/index.ts';
import type { QuotaRecord } from '../quota/types.ts';
import {
  NativeWorkbench,
  Orchestrator as MultiTaskOrchestrator,
  TaskScheduler,
  WorkspaceManager,
  normalizeScopeForWorkspace,
  runDecisionCycle,
  type ResourceClaimMode,
  type WorkbenchTaskSpec,
} from '../orchestration/index.ts';
import type { TaskStatus } from '../orchestration/task.ts';
import type { TaskStore } from '../orchestration/store.ts';
import {
  buildReviewPacket,
  buildUnifiedRoundReport,
  classifyExecutionOutcome,
  renderUnifiedRoundReport,
  runUnifiedReview,
  tailText,
  type ExecutionOutcome,
  type ReviewPacketTask,
  type UnifiedReviewResult,
} from '../orchestration/unified-review.ts';
import {
  DEFAULT_HANDOFF_POLICY,
  HANDOFF_LOOP_REFUSED,
  buildContinuationPacket,
  classifyHandoffReason,
  evaluateHandoffBudget,
  renderContinuationPacket,
  runHandoffContinuation,
  type ContinuationResult,
} from '../orchestration/continuation.ts';
import { buildHandoff } from '../orchestration/workbench-handoff.ts';
import { buildExecutionSnapshot } from '../orchestration/execution-monitor.ts';
import {
  createRoundObserver,
  publishRoundResult,
  type RoundObserver,
} from '../orchestration/round-observation.ts';
// R4: aggregation + human gate. Both are PURE projections — this file composes them and
// then stops. Nothing here gives them a way to dispatch, decide, or move a task.
import {
  buildRoundResult,
  renderRoundResult,
  type RoundResult,
  type TaskEvidenceInput,
} from '../orchestration/round-result.ts';
import { createLayaDecisionProvider } from '../decision/laya.ts';
import type { DecisionProvider } from '../decision/types.ts';
import { classifyTask } from '../decision/routing.ts';
import type { TaskClassification } from '../decision/routing.ts';
import type { TaskType } from '../quota/types.ts';

const USAGE = `orchestrator round - ONE execution round: decide - execute - observe - report

USAGE
  orchestrator round "<objective>" [options]

The round ENDS when it reports. It is not a daemon: no loop, no auto-retry, no
auto-replan. Run it again yourself if you want another round.

OPTIONS
  --cwd <dir>            project directory the workers run in (default: cwd)
  --agent <id>           prefer this agent (Assignment still applies its filters)
  --model <id>           prefer this model for the preferred agent
  --laya-url <url>       laya-serve base URL (default: http://127.0.0.1:8077)
  --laya-timeout <ms>    decision timeout (default: 60000)
  --allow-remote-laya    permit a non-loopback laya-serve (default: refuse)
  --max-children <n>     how many children may EXIST (default: 3)
  --max-concurrent <n>   how many children may RUN at once (default: 2)
  --budget-units <n>     orchestration budget units per child (default: 1000)
  --retry-max <n>         bound for the 'retry' action (default: 0 = capability OFF)
  --observe <dir|file>   ALSO publish a read-only snapshot for the temporary dashboard
                         (default: OFF = byte-identical behaviour to before)
  --classify-only        ask Laya to classify, print it, and stop without executing
  --review-agent <id>    who performs the round review (default: codex)
  --review-timeout <ms>  bound the round review (default: 300000)
  --no-review            skip the round review (offline runs only; reports not_requested)
  --handoff-max <n>      automatic agent switches allowed per task when an agent is out
                         of quota / unavailable (default: 2; 0 disables handoff)
  --no-handoff           make exactly one attempt per task (default: handoff is ON)
  --json                 machine-readable report on stdout
  --log-level <lvl>      silent|error|warn|info|debug   (default: warn)

WHAT HAPPENS
  1. Laya classifies the objective (work kind / complexity / review need).
  2. The planner turns that into a task DAG; Assignment binds each child.
  3. ONE decision cycle runs: Laya is shown the real observation and picks an
     action, which the validator checks before anything may move.
  4. Whatever the decision dispatched, really executed on the named agents.
  5. R2-3 SAME-TASK CONTINUATION: if an agent ended in quota_exhausted / agent_unavailable /
     session_failure, one bounded handoff is offered to Laya, which alone may name the next
     agent. The task keeps its id; only a new attempt, lease and identity appear.
  6. ONE native review of the WHOLE round runs against the collected evidence -
     for success, failure, refusal and quota alike. It sees every attempt.
  7. The round reports and exits.

OBSERVATION (read-only, opt-in)
  --observe publishes $ORCH_HOME/round-state.json + round-events.jsonl while the round
  runs, so the temporary dashboard can show live tasks / agents / workspaces. It is
  WRITE-ONLY from here: nothing is read back, and the dashboard cannot dispatch,
  reassign or cancel anything. A failed publish is swallowed — an unavailable
  dashboard must never become a failed round.

AFTER THE ROUND
  Tasks sit in 'to_verify'. This command does not verify them: Verification stays the
  only completion authority. The round has ALREADY been reviewed by Codex - its verdict
  is in the report - and a 'rework' verdict is a suggestion for YOUR next round.
  Nothing is retried, reassigned or replanned automatically.

EXAMPLES
  orchestrator round "add a retry to the http client" --agent opencode
  orchestrator round "audit the auth module" --classify-only --json
`;

interface RoundOptions {
  objective: string;
  cwd: string;
  agent?: string;
  model?: string;
  layaUrl: string;
  layaTimeoutMs: number;
  allowRemoteLaya: boolean;
  maxChildren: number;
  maxConcurrent: number;
  budgetUnits: number;
  retryMax: number;
  classifyOnly: boolean;
  json: boolean;
  /** `--observe <dir|file>`. Absent = no observation published at all. */
  observe?: string;
  /**
   * The unified Codex review. ON by default and not optional in spirit: a round that
   * ends without one is a round whose result nobody independently examined. `--no-review`
   * exists for genuinely offline runs, and it records `not_requested` rather than
   * pretending a review happened.
   */
  review: boolean;
  reviewAgent: string;
  reviewTimeoutMs: number;
  /**
   * R2-3: same-task continuation when an agent runs out of quota or turns out to be
   * unavailable. ON by default; `--no-handoff` turns it off for a round that must make
   * exactly one attempt per task.
   */
  handoff: boolean;
  /** R2-3: hard ceiling on automatic agent switches per task. Must be finite. */
  handoffMax: number;
}

/**
 * How often a RUNNING round re-publishes its observation.
 *
 * Not a poll interval for the dashboard (the bridge polls on its own); this is the
 * round's own heartbeat, and it exists only so a long-running task's `elapsed` keeps
 * advancing. An idle round publishes nothing.
 */
const OBSERVE_HEARTBEAT_MS = 5_000;

const VERBATIM = new Set(['laya-url', 'agent', 'model', 'cwd', 'observe', 'review-agent']);

function parse(argv: readonly string[]): RoundOptions | { error: string } {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && (VERBATIM.has(key) || !next.startsWith('--'))) {
        flags[key] = next;
        i++;
        continue;
      }
      flags[key] = true;
      continue;
    }
    positionals.push(a);
  }

  const objective = positionals.join(' ').trim();
  if (objective === '') return { error: 'Usage: orchestrator round "<objective>" [options]' };

  const num = (key: string, fallback: number): number => {
    const raw = flags[key];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--${key} must be a non-negative number (got "${String(raw)}")`);
    return n;
  };
  const s = (key: string): string | undefined => (typeof flags[key] === 'string' ? (flags[key] as string) : undefined);

  const cwdRaw = s('cwd');
  const cwd = resolve(cwdRaw ?? process.cwd());
  if (!existsSync(cwd)) return { error: `Working directory does not exist: ${cwd}` };

  try {
    return {
      objective,
      cwd,
      ...(s('agent') !== undefined ? { agent: s('agent') } : {}),
      ...(s('model') !== undefined ? { model: s('model') } : {}),
      layaUrl: s('laya-url') ?? 'http://127.0.0.1:8077',
      layaTimeoutMs: num('laya-timeout', 60_000),
      allowRemoteLaya: flags['allow-remote-laya'] === true,
      maxChildren: num('max-children', 3),
      maxConcurrent: num('max-concurrent', 2),
      budgetUnits: num('budget-units', 1_000),
      retryMax: num('retry-max', 0),
      classifyOnly: flags['classify-only'] === true,
      json: flags.json === true,
      review: flags['no-review'] !== true,
      reviewAgent: s('review-agent') ?? 'codex',
      reviewTimeoutMs: num('review-timeout', 300_000),
      handoff: flags['no-handoff'] !== true,
      handoffMax: num('handoff-max', DEFAULT_HANDOFF_POLICY.maxAutomaticHandoffsPerTask),
      ...(s('observe') !== undefined ? { observe: s('observe') as string } : {}),
    };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** Which task type the round's ROOT is, from Laya's classification. */
function taskTypeFor(c: TaskClassification): TaskType {
  switch (c.work_kind) {
    case 'review':
      return 'review';
    case 'research':
      return 'research';
    case 'debugging':
      return 'implementation';
    case 'implementation':
      return 'implementation';
    default:
      return 'implementation';
  }
}

/**
 * R2-3: an explicit override for the decision brain.
 *
 * Exists so the PRODUCTION round path — plan, assign, gate, scheduler, executeTask,
 * handoff, re-dispatch, unified review — can be driven in a test without the repo-external
 * `laya-serve` Python service. Everything else in this command stays real: the real
 * `NativeWorkbench`, the real `TaskScheduler`, the real spawn gate, the real
 * `Orchestrator.executeTask`, the real AttemptStore and the real review entrypoint.
 *
 * Only Laya's ANSWER is substituted, and a caller passing this is responsible for saying
 * so. `index.ts` passes nothing, so the CLI always uses the real provider.
 */
export interface RoundCliOverrides {
  readonly provider?: DecisionProvider;
  /**
   * R2-3: the provider PROBES, instead of running the real ones.
   *
   * The real `collectAll(DEFAULT_PROVIDERS)` shells out to four installed CLIs, which
   * makes two things untestable: an agent identity that exists only in a test (it gets no
   * quota record, so the REAL gate refuses it with `quota-record-absent` — correctly), and
   * a deterministic quota state.
   *
   * This replaces the probe RESULT only. Everything that decides anything still runs for
   * real: `seedRegistry`, `buildQuotaCenter`, the spawn gate, `BudgetManager`, Assignment,
   * the Scheduler and `executeTask`. A caller passing this is responsible for saying the
   * quota facts were supplied rather than observed — which is why the report already marks
   * the probe source. `index.ts` passes nothing.
   */
  readonly probes?: QuotaProbe[];
}

export async function runRoundCli(
  runtime: RuntimeOrchestrator,
  argv: readonly string[],
  overrides: RoundCliOverrides = {},
): Promise<number> {
  let o: RoundOptions | { error: string };
  try {
    o = parse(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if ('error' in o) {
    process.stderr.write(`${o.error}\n\n${USAGE}`);
    return 2;
  }

  const w = (s = ''): void => {
    process.stdout.write(s + '\n');
  };
  const note = (s: string): void => {
    process.stderr.write(s + '\n');
  };

  // R4: the round's own clock, read ONCE here so the reported window spans everything the
  // round did. Deliberately not `Date.now()` at report time: a round timeline that
  // disagreed with its own attempt records would be a second, worse version of the truth.
  const startedAt = Date.now();

  // ---- the decision brain, constructed for real ----------------------------
  // A non-loopback base URL throws here (a configuration error, not a decision
  // failure), so it surfaces before anything is created rather than mid-round.
  //
  // R2-3: an override replaces only Laya's ANSWER. It is checked first so a test can
  // drive the real round without `laya-serve`; the CLI never passes one.
  let provider;
  try {
    provider = overrides.provider ?? createLayaDecisionProvider({
      baseUrl: o.layaUrl,
      allowRemote: o.allowRemoteLaya,
      timeoutMs: o.layaTimeoutMs,
    });
  } catch (e) {
    process.stderr.write(`Laya provider could not be configured: ${(e as Error).message}\n`);
    return 2;
  }

  // ---- real observations, collected ONCE and shared -------------------------
  const descriptors = runtime.descriptors();
  const configs: Record<string, AgentConfig> = {};
  for (const id of runtime.agentIds()) configs[id] = runtime.configFor(id);
  const now = Date.now();

  let probes;
  try {
    // R2-3: a supplied probe set replaces the external CLI probes ONLY. Everything that
    // decides — registry seeding, quota centre, gate, budgets, assignment, scheduling —
    // still runs below, so the gate verdicts under test are the production ones.
    probes = overrides.probes ?? (await collectAll(DEFAULT_PROVIDERS)).probes;
  } catch (e) {
    process.stderr.write(`quota probe failed: ${(e as Error).message}\n`);
    return 1;
  }
  const registry: ModelRegistry = seedRegistry({ store: runtime.store, configs, descriptors }, probes, now);
  const center = await buildQuotaCenter({
    store: runtime.store,
    configs,
    descriptors,
    probes,
    registry,
    installed: Object.fromEntries(descriptors.map((d) => [d.id, true])),
  });
  // Only REAL probed records. An agent that did not answer has none, and the gate
  // will deny it with `quota-record-absent` - which is the gate doing its job.
  const quotaRecords: QuotaRecord[] = probes.flatMap((p) => p.records);
  const observedUsage = collectObservedUsage(runtime.store);

  // ---- STEP 1: Laya classifies the objective -------------------------------
  let classification: TaskClassification;
  try {
    classification = await classifyTask(provider, { task: o.objective });
  } catch (e) {
    const msg = `${(e as Error).name}: ${(e as Error).message}`;
    if (o.json) {
      w(JSON.stringify({ ok: false, stage: 'classify', error: msg }, null, 2));
    } else {
      note(`Laya classification failed: ${msg}`);
      note('Start laya-serve (default http://127.0.0.1:8077) and try again. Nothing was created or run.');
    }
    return 1;
  }

  if (o.classifyOnly) {
    if (o.json) {
      w(JSON.stringify({ ok: true, stage: 'classify-only', objective: o.objective, classification }, null, 2));
    } else {
      w('Laya classification (nothing was planned, assigned or run)');
      w(`  work_kind        ${classification.work_kind}`);
      w(`  complexity       ${classification.complexity} (score ${classification.complexity_score ?? '-'})`);
      w(`  review_required  ${classification.review_required}`);
      w(`  provider         ${classification.provider ?? '-'}`);
      w(`  raw              ${JSON.stringify(classification.raw).slice(0, 200)}`);
    }
    return 0;
  }

  // ---- STEP 2/3: the existing authority layer, unchanged --------------------
  const budgetTotal = Math.max(1, o.budgetUnits) * 64;
  const budgets = new BudgetManager(budgetTotal);
  const gateSources = {
    descriptors,
    agentStatus: center.agentStatus,
    quotaRecords,
    registry,
    budgets,
    taskType: taskTypeFor(classification) as TaskType,
    requestedUnits: o.budgetUnits,
    currentConcurrency: 0,
    maxConcurrency: o.maxConcurrent,
    maxChildren: o.maxChildren,
    maxConcurrentAgents: o.maxConcurrent,
    taskPolicyAllows: true,
  };

  // ---- R2-1: Workspace / Resource Safety -----------------------------------
  //
  // THE REAL GAP. Until now this round built NO `WorkspaceManager`, so every task -  // including parallel ones - inherited `defaultCwd`. Two agents editing one
  // checkout is exactly the failure R2-1 exists to prevent.
  //
  // Isolation needs a git repository (an isolated workspace IS a worktree). When
  // there is none, the honest move is to run exactly as before with NO workspace
  // manager and SAY SO, rather than requesting isolation that would fail every task
  // or silently downgrading a claim we cannot honour.
  const workspaceProbe = new WorkspaceManager({ projectRoot: o.cwd });
  const repoRoot = await workspaceProbe.repoRootFor(o.cwd);
  const workspace: WorkspaceManager | null = repoRoot === null ? null : workspaceProbe;

  /**
   * §8's rule, expressed over the live store rather than a static task-type guess.
   *
   * A task that WRITES and has work running beside it must not share a mutable
   * workspace; read-only work may share, which is why a review can still point at
   * the main tree. Determined by the task's own work (its type), never by `agentId`
   * - so this holds for the four current agents and for any agent admitted under the
   * same contract.
   */
  const claimModeFor = (taskType: TaskType): ResourceClaimMode =>
    taskType === 'review' || taskType === 'research' ? 'read' : 'write';

  // Filled immediately after construction, because the resolvers below are handed to
  // the constructor and need to read the store it owns.
  let liveStore: TaskStore | null = null;
  const hasParallelSibling = (selfTaskId: string): boolean => {
    const store = liveStore;
    if (store === null) return false;
    const runnable = new Set<TaskStatus>(['planned', 'queued', 'running']);
    return store
      .all()
      .some((t) => t.depth > 0 && t.taskId !== selfTaskId && runnable.has(t.status));
  };

  const coord = new MultiTaskOrchestrator({
    gate: gateSources as never,
    // The runtime Orchestrator IS the `RuntimeRunner` (structurally:
    // `run(req: RunRequest): RunHandle`), and `execute.ts` says outright that
    // "production injects the real thing and tests inject a stub". So it is passed
    // as-is - NOT wrapped in a closure. A wrapper would be a second thing holding a
    // reference to the execution seam, which is exactly what the topology guard
    // (`RuntimeRunner.run is called in exactly one place`) exists to prevent.
    runtime,
    defaultCwd: o.cwd,
    resultTimeoutMs: o.layaTimeoutMs,
    // ---- R2-1: workspace admission --------------------------------------
    // Present only when the project really is a git repository; see the probe above.
    ...(workspace !== null ? { workspace } : {}),
    workspaceMode: (task) => {
      // No workspace manager configured (not a git repo): every task runs in the
      // caller's cwd, which is exactly the pre-R2-1 behaviour and is reported.
      if (workspace === null) return 'none';
      const parallel = hasParallelSibling(task.taskId);
      return WorkspaceManager.mayShareWorkspace(claimModeFor(task.taskType), parallel) ? 'shared' : 'isolated';
    },
    // What each task claims. Whole-workspace scope on purpose: a task that says "I
    // write here" must conflict with every other writer here without having to
    // predict which files it will touch.
    resourceClaims: (task) => ({
      mode: claimModeFor(task.taskType),
      // The scope names THIS task's own workspace, so two isolated writers are two
      // different resources and do not contend (R2-1.1 P1-a). The root lets a path
      // claim be tested for containment; the ORCHESTRATOR refines it to the prepared
      // workspace's real cwd before comparing.
      scope: normalizeScopeForWorkspace(`task:${task.taskId}`, o.cwd),
    }),
  });
  liveStore = coord.getStore();
  // R2-3 P0-1: the scheduler carries the availability-continuation policy, so EVERY
  // dispatch in this round records `SPAWN_FAILED` / `TRANSPORT_ERROR` as a continuable
  // parked state instead of a terminal failure. Setting it HERE, on the one scheduler,
  // rather than at each executeTask call site is deliberate: a policy that must be
  // remembered per call is a policy that gets forgotten on the call that matters.
  //
  // `NONZERO_EXIT` and a timeout are untouched by this flag — a real work failure is
  // still a real work failure, and must not become "try another agent".
  const scheduler = new TaskScheduler({
    orchestrator: coord,
    cwd: o.cwd,
    ...(o.handoff ? { translate: { allowAvailabilityContinuation: true } } : {}),
  });
  const wb = new NativeWorkbench({
    orchestrator: coord,
    scheduler,
    registry,
    quotaRecords,
    cwd: o.cwd,
  });

  const rootId = `round-${now.toString(36)}`;

  // ---- R2 observability: ONE-WAY, OPT-IN, FAILURE-ISOLATED -------------------
  //
  // Absent `--observe`, `observer` stays null and not a single line below runs, so a
  // round behaves EXACTLY as before. Present, it writes a read model for the
  // temporary dashboard and nothing else: no reads back, no request path, no
  // acknowledgement, and every error swallowed at the source.
  const observer: RoundObserver | null = o.observe === undefined
    ? null
    : createRoundObserver({
        // `.json` means the caller named a file; anything else is a directory. Both
        // forms are accepted because an operator should not have to remember which.
        ...(/\.json$/i.test(o.observe)
          ? { stateFile: resolve(o.observe) }
          : { dir: resolve(o.observe) }),
        // A missing dashboard is expected. Say so once at most, and never as a throw.
        onError: (m) => note(`observation degraded (the round is unaffected): ${m}`),
      });

  const observationPaths = observer === null ? null : observer.paths;
  let lastStateKey = '';

  const observe = (at: number): void => {
    if (observer === null) return;
    try {
      const snapshot = buildExecutionSnapshot({
        store: wb.store,
        workspace,
        sessions: wb.sessions,
        rootTaskId: rootId,
        now: at,
      });
      // What counts as "a real change".
      //
      // The state fields alone are NOT enough: a task's `updatedAt` is
      // `finishedAt ?? startedAt ?? createdAt`, so while a task is RUNNING none of
      // them move. The key would be identical for the whole run, nothing would be
      // republished, and the dashboard's `elapsed` / "updated Ns ago" would freeze —
      // the exact opposite of a live monitor.
      //
      // So while anything is running, a coarse time bucket joins the key. The bucket
      // is what keeps the published `elapsedMs` (computed against the publish clock)
      // moving, while an idle round still writes nothing.
      const anyRunning = snapshot.tasks.some((t) => t.status === 'running');
      const bucket = anyRunning ? `@${Math.floor(at / OBSERVE_HEARTBEAT_MS)}` : '';
      const key = snapshot.tasks
        .map((t) => `${t.taskId}:${t.status}:${t.retryCount}:${t.updatedAt}`)
        .join('|') + bucket;
      // Only publish on a real change. The dashboard polls independently, so a
      // duplicate write would tell it nothing new.
      if (key === lastStateKey) return;
      lastStateKey = key;
      observer.publish({
        snapshot,
        stateKey: key,
        // Derived from the store's OWN state changes — one event per real transition,
        // deduped by (task, status, updatedAt). The `at` is the OBSERVATION time, not
        // the task's `updatedAt`: a transition is seen now, and mixing task-clock and
        // wall-clock in one timeline would order it wrongly.
        events: snapshot.tasks.map((t) => ({
          key: `task:${t.taskId}:${t.status}:${t.updatedAt}`,
          at,
          source: t.agentId ?? 'unassigned',
          message: `${t.taskId} ${t.status}`,
          tone: t.status === 'succeeded' ? 'success' : t.status === 'failed' ? 'error' : 'normal',
        })),
      });
    } catch {
      // Observability must never be able to fail the run it is watching — not even
      // through a bug in the derivation above.
    }
  };
  const spec: WorkbenchTaskSpec = {
    taskId: rootId,
    objective: o.objective,
    taskType: taskTypeFor(classification),
    budgetUnits: o.budgetUnits,
    ...(o.agent !== undefined ? { preferredAgent: o.agent } : {}),
    ...(o.model !== undefined ? { preferredModel: o.model } : {}),
  };

  // Budget scopes must exist BEFORE the planner commits, because the gate is
  // fail-closed on a missing scope and would refuse the spawn outright.
  budgets.task(rootId, o.budgetUnits);

  const quotaProbed = [...new Set(quotaRecords.map((r) => r.agentId))];
  const report: Record<string, unknown> = {
    ok: false,
    objective: o.objective,
    cwd: o.cwd,
    rootTaskId: rootId,
    classification,
    agents: descriptors.map((d) => d.id),
    quotaProbed,
    observedUsage: observedUsage.length,
    // R2-1: reported so an operator can tell ISOLATION APART from "everything just
    // happened to share one directory". `null` means no git repository, so isolation
    // is impossible and every task ran in the shared cwd.
    workspace: {
      isolation: workspace === null ? 'unavailable (not a git repository)' : 'git worktree per writing task',
      repoRoot,
      parallelWriteIsolated: workspace !== null,
    },
  };

  // ---- STEP 4: plan + assign (Planner and Assignment, the only authorities) --
  let planned;
  let assigned;
  try {
    planned = wb.plan(spec, classification);
    // Every id the planner produced needs a scope before it can be assigned.
    for (const child of planned.children) budgets.task(child.taskId, o.budgetUnits);
    assigned = wb.assignChildren(rootId, spec);
    // The gate needs THREE scopes to exist - global, task:<id> AND agent:<id> - and
    // `resolveBudgetHeadroom` deliberately refuses to auto-create a missing one
    // (touching `.task()`/`.agent()` to ASK would create it with zero allocation,
    // turning "unknown" into a real-but-empty ledger). So the agent scope for each
    // worker this round actually bound must be funded before dispatch, or every
    // execute is refused with `budget-scope-unavailable`.
    for (const child of planned.children) {
      if (assigned.find((a) => a.taskId === child.taskId)?.ok !== true) continue;
      budgets.agent(child.agentId, o.budgetUnits);
    }
    // Assignment is the only thing that may bind a session to a task.
    for (const child of planned.children) {
      const outcome = assigned.find((a) => a.taskId === child.taskId);
      if (outcome?.ok !== true) continue;
      wb.sessions.open(
        { agentId: child.agentId, modelId: child.modelId, sessionPolicy: 'fresh' },
        o.cwd,
        now,
        child.taskId,
      );
    }
  } catch (e) {
    const msg = `${(e as Error).name}: ${(e as Error).message}`;
    report.stage = 'plan';
    report.error = msg;
    if (o.json) w(JSON.stringify(report, null, 2));
    else note(`planning/assignment failed: ${msg}`);
    return 1;
  }

  const unassigned = assigned.filter((a) => !a.ok);

  // The first real state: every child now has an identity, a session and a workspace.
  observe(Date.now());

  // While the decision cycle runs, keep the picture fresh. A TICK, not a daemon: the
  // timer is `unref`'d and cleared below, and it can only ever READ the store.
  const observeTimer = observer === null
    ? null
    : setInterval(() => observe(Date.now()), 1_200);
  (observeTimer as unknown as { unref?: () => void } | null)?.unref?.();

  // ---- STEP 5: ONE decision cycle ------------------------------------------
  // Exactly one call. Not a loop, not a retry: a round that needs a second round
  // says so in the report and the human decides.
// The EXISTING authorities, injected once and SHARED by the first cycle and by every
  // continuation cycle. Sharing the object is deliberate: a continuation that built its
  // own capability set would be a second control plane wearing the same interface.
  //
  // `retry` stays OFF unless a bound is given, because an invented attempt limit would
  // make an unbounded loop look deliberate. The bound is the CALLER's to state, so this
  // wires the real Orchestrator.retry with the number the human typed - not a default
  // this file picked.
  // R2-3 P1-3: the agents each task has already used in this continuation chain.
  //
  // Tracked HERE, at the round, because the guard has to be applied where a target first
  // exists: Laya's `reassign` answer. The driver cannot do it — by the time the driver
  // learns the target, `applyDecision` has already migrated the task.
  const handoffAgentChain = new Map<string, string[]>();

  /**
   * R2-3: what each handoff's single dispatch actually did.
   *
   * Recorded so "one handoff produces at most one new dispatch" is a MEASUREMENT in the
   * round report rather than a claim — the exact failure mode being prevented being a
   * reassign that ticks, followed by a driver that ticks again.
   */
  const handoffDispatches: Array<{ taskId: string; admitted: string[]; attempts: number }> = [];

  const decisionCapabilities =
    o.retryMax > 0
      ? wb.decisionCapabilities({
          retry: async (req) => {
            // `Orchestrator.retry` answers in `MutateOutcome` terms (it hands back
            // the task on success); the capability contract wants a plain
            // ok/code/reason. Projected here rather than widened at either end.
            const r = wb.orchestrator.retry(
              req.taskId,
              req.reason ?? 'the decision brain asked for a retry',
              o.retryMax,
            );
            return r.ok
              ? { ok: true, code: 'retried', reason: `task ${req.taskId} was re-queued for another attempt` }
              : { ok: false, code: r.code, reason: r.reason };
          },
        })
      : wb.decisionCapabilities();

  // R2-3 P1-3: guard the REASSIGN TARGET before the migration happens.
  //
  // Wrapping the EXISTING reassign capability is the only seam where both facts exist:
  // the decision names a target AND nothing has been written yet. Refusing here makes
  // Laya's decision visible, keeps the task on its current agent, and reports a refusal
  // through the normal capability channel — no second scheduler, no post-hoc undo.
  //
  // The count bound is absolute and is checked FIRST, so no `layaReason` can unlock a
  // target the budget has already spent.
  const handoffCapabilities = {
    ...decisionCapabilities,
    reassign: async (req: { taskId: string; agentId?: string; modelId?: string; strategy?: 'explicit' | 'assignment'; reason?: string }) => {
      if (req.agentId !== undefined) {
        const used = handoffAgentChain.get(req.taskId) ?? [];
        const verdict = evaluateHandoffBudget({
          policy: handoffPolicy,
          used: used.length,
          agentsUsed: used,
          targetAgentId: req.agentId,
          ...(req.reason === undefined ? {} : { layaReason: req.reason }),
        });
        if (!verdict.allowed) {
          return {
            ok: false,
            code: verdict.code === 'loop-refused' ? HANDOFF_LOOP_REFUSED : verdict.code ?? 'handoff-budget-exhausted',
            reason: verdict.reason,
          };
        }
      }
      return decisionCapabilities.reassign!(req);
    },
  };

  const outcome = await runDecisionCycle({
    store: wb.store,
    scheduler,
    provider,
    rootTaskId: rootId,
    instructions:
      'This is the first cycle of a single execution round. Choose the single next action ' +
      'that best advances the stated objective, and give an explicit target wherever the ' +
      'action requires one.',
    capabilities: handoffCapabilities,
  });

  // ---- R2-3: bounded SAME-TASK CONTINUATION, then ONE review of everything -----
  //
  // Two things happen here, in this order, and the order matters.
  //
  // 1. CONTINUATION. An agent that ran out of quota, or that turned out to be
  //    unavailable, is an AVAILABILITY fact — not a verdict on the work. So the same task
  //    may continue on another agent. What this block must NOT do is decide anything:
  //    it reads real outcomes from the AttemptStore, builds a ContinuationPacket, and
  //    asks the SAME Laya provider to choose the next agent through the SAME `reassign`
  //    action. If Laya does not reassign, the chain stops and the task stays visible.
  //
  //    The bound is real and finite (`--handoff-max`, default 2), plus a guard that
  //    refuses to return to an agent already in the chain. There is no unbounded loop,
  //    and no automatic rework or replan anywhere on this path.
  //
  // 2. THEN the review, over every attempt the round produced. Attempt 1 and attempt 2
  //    both reach the same single Codex review; there is no second review system.
  const handoffPolicy = { maxAutomaticHandoffsPerTask: o.handoffMax };

  /**
   * Every task's terminal outcome, including the ones that produced NO evidence.
   *
   * R2-3 P1-1: this used to `continue` past any task with neither an AttemptRecord nor a
   * RunResult — which is EXACTLY the shape of a pure admission refusal
   * (`quota-exhausted`, `resource-conflict`, `capability-missing`). So the most important
   * handoff trigger in the system was the one trigger this reader structurally could not
   * see. It is now read from the scheduler's own last tick, which is where the real refusal
   * code lives.
   *
   * `executed: false` / `refused: true` is the honest shape and F5 is untouched: nothing
   * here fabricates a run or an attempt. A refusal is reported as "nothing ran, and here
   * is the code", never as an execution.
   */
  const readRoundOutcomes = (): ExecutionOutcome[] => {
    const runResults = wb.runResults();
    const lastTick = wb.lastTick();
    // The real refusal codes the ONE scheduler produced, keyed by task.
    const refusals = new Map<string, { code: string; reason: string }>();
    for (const skip of lastTick?.skipped ?? []) {
      if (skip.taskId === '*') continue;
      refusals.set(skip.taskId, { code: skip.code, reason: skip.reason });
    }
    // R2-3 P1-1 (second half): a refusal can also happen at ASSIGNMENT time, before any
    // dispatch exists — an agent with no usable quota is filtered out by Assignment and the
    // task is never given a worker. That refusal produced no tick entry, no run and no
    // attempt, so reading only the tick made it invisible to exactly the handoff that
    // exists to handle it. The real `AssignOutcome` codes are read here instead.
    for (const a of assigned) {
      if (a.ok) continue;
      if (refusals.has(a.taskId)) continue;
      refusals.set(a.taskId, { code: a.code ?? 'assignment-refused', reason: a.reason ?? 'assignment refused' });
    }
    const found: ExecutionOutcome[] = [];
    for (const t of wb.store.all()) {
      if (t.depth === 0) continue;
      const live = wb.store.get(t.taskId);
      if (live === null) continue;
      const history = wb.evidence.history(t.taskId);
      const run = runResults.get(t.taskId) ?? null;
      const refusal = refusals.get(t.taskId) ?? null;
      // No evidence AND no refusal means nothing happened yet; there is no outcome to
      // report, and inventing one would put a fiction in front of the decision brain.
      if (history.length === 0 && run === null && refusal === null) continue;
      found.push(classifyExecutionOutcome({
        taskId: t.taskId,
        taskStatus: live.status,
        agentId: live.agentId,
        modelId: live.modelId,
        run,
        refusalCode: refusal === null ? null : refusal.code,
        refusalReason: refusal === null ? null : refusal.reason,
        attemptIds: history.map((a) => a.attemptId),
      }));
    }
    return found;
  };

  let continuation: ContinuationResult | null = null;
  if (o.handoff) {
    try {
      continuation = await runHandoffContinuation({
        async readOutcomes() { return readRoundOutcomes(); },
        identityOf(taskId) {
          const t = wb.store.get(taskId);
          return t === null ? null : { agentId: t.agentId, modelId: t.modelId ?? null };
        },
        // R2-3 P0-2: Laya's reassign has been APPLIED; the new agent now needs its turn.
        //
        // `reassign` deliberately does not dispatch (applyDecision applies the migration
        // and stops, so the next run belongs to a LATER tick). Without this the round
        // would migrate an agent and then stop — the new agent would have an identity and
        // never run, which is what Codex called P0-2.
        //
        // Two existing steps, in this order, and NO new authority:
        //   1. `retrying -> queued` via the EXISTING `Orchestrator.retry`, which is the only
        //      way out of `retrying` and carries a real bound (`--retry-max`). This is not
        //      Laya asking for a retry and not an automatic retry loop: the task was parked
        //      because the worker could not continue, and it now has a worker who can.
        //   2. `NativeWorkbench.dispatch()` — the ONE dispatch path, which ticks the ONE
        //      scheduler and runs `executeTask`. Evidence for the new attempt is recorded
        //      by that same call, so the driver reads a REAL second attempt next pass.
        //
        // Exactly one dispatch per handoff, so a handoff can never produce two runs.
        async onHandoffApplied(record) {
          handoffAgentChain.set(
            record.taskId,
            [...(handoffAgentChain.get(record.taskId) ?? []), record.fromAgentId ?? 'unknown'],
          );
          const task = wb.store.get(record.taskId);
          if (task === null) return;

          // R2-3: fund the CONTINUATION attempt before dispatching it.
          //
          // Found by running the loop rather than by reading it: a task funded for ONE
          // attempt is fully consumed by that attempt, so the real gate refused the second
          // dispatch with `budget-insufficient` and the handoff silently produced no work.
          // The new worker also needs its OWN `agent:<id>` scope — the gate requires all
          // three (global, task, agent) and will not create a missing one.
          //
          // Both calls are ADDITIVE (`getOrCreate` allocates when the ledger exists), and
          // both go through the same `BudgetManager` authority the round already uses. One
          // extra allocation per handoff, so the total stays bounded by `--handoff-max`.
          if (o.budgetUnits > 0) {
            budgets.task(record.taskId, o.budgetUnits);
            const nextAgent = record.toAgentId ?? wb.store.get(record.taskId)?.agentId;
            if (nextAgent !== null && nextAgent !== undefined) budgets.agent(nextAgent, o.budgetUnits);
          }
          if (task.status === 'retrying') {
            const requeued = wb.orchestrator.retry(
              record.taskId,
              `handoff: ${record.fromAgentId ?? 'the previous agent'} could not continue (${record.reason}), ` +
              `so the same task continues on ${record.toAgentId ?? 'another agent'}`,
              o.retryMax > 0 ? o.retryMax : o.handoffMax,
            );
            if (!requeued.ok) {
              process.stderr.write(
                `handoff: ${record.taskId} could not be requeued (${requeued.code}): ${requeued.reason}\n`,
              );
              return;
            }
          }
          // The NEW agent must be told what the previous one did. `dispatch()` composes its
          // own brief from the task's objective and its dependencies, which does NOT
          // include this handoff — so without passing the packet explicitly the new
          // worker would start with no idea the task had already been attempted, and the
          // whole continuation context would stop at Laya.
          //
          // `dispatch(promptFor)` merges caller prompts OVER the auto-brief, so this is
          // still the one dispatch path and one execution edge.
          const brief = wb.briefFor(record.taskId, wb.runResults());
          const continuationBrief = [
            renderContinuationPacket(record.packet),
            '',
            brief === null ? '' : brief,
          ].join('\n').trim();
          const dispatched = await wb.dispatch(new Map([[record.taskId, continuationBrief]]));
          handoffDispatches.push({
            taskId: record.taskId,
            admitted: [...(dispatched.tick?.admitted ?? [])],
            attempts: dispatched.evidenceRecorded.length,
          });
        },
        buildPacket(taskId, outcome) {
          const task = wb.store.get(taskId);
          if (task === null) return null;
          const classification = classifyHandoffReason(outcome);
          if (!classification.handoff) return null;
          const history = wb.evidence.history(taskId);
          const last = history.length > 0 ? history[history.length - 1]! : undefined;
          const run = wb.lastRunResult(taskId);
          return buildContinuationPacket({
            task,
            reason: classification.reason,
            outcome,
            evidence: run === null ? null : buildHandoff(task, run),
            attempt: last === undefined ? null : {
              attemptId: last.attemptId,
              agentId: last.agentId,
              modelId: last.modelId,
              leaseVersion: last.leaseVersion,
              errorCode: last.errorCode,
              errorMessage: last.errorMessage,
            },
          });
        },
        async runCycle(context) {
          // The SAME decision cycle the round already runs, with the continuation packet
          // as its context. Laya answers in the same closed vocabulary as always; the
          // packet is OBSERVATION, never an instruction to override its judgement.
          const cycle = await runDecisionCycle({
            store: wb.store,
            scheduler,
            provider,
            rootTaskId: rootId,
            instructions:
              'An earlier agent could not continue a task (quota exhausted or unavailable). ' +
              'The continuation packet below is what really happened and what evidence exists. ' +
              'Choose the single next action. If a different agent should continue the SAME task, answer ' +
              '"reassign" and name that agent. If no agent is suitable, answer "wait" and the task stays ' +
              'as it is for the human to see.\n\n' + context,
            capabilities: handoffCapabilities,
            lastTick: () => wb.lastTick(),
          });
          if (cycle.status !== 'ok') {
            // R2-3: a refused continuation decision must be DIAGNOSABLE. "the cycle did
            // not complete" is not actionable; the validator's own message and the raw
            // answer are, and the round report is where an operator will look.
            const detail = cycle.status === 'invalid'
              ? `${cycle.error.message} (raw answer: ${JSON.stringify(cycle.rawAction)})`
              : cycle.status === 'provider-unavailable'
                ? cycle.error.message
                : 'no detail available';
            return {
              action: null, applied: false, dispatched: false,
              code: `cycle-${cycle.status}`, reason: `the continuation decision cycle did not complete: ${detail}`,
              targetAgentId: null,
            };
          }
          const decision = cycle.decision;
          const application = cycle.application;
          return {
            action: decision === null ? null : decision.action,
            applied: application.applied,
            dispatched: application.dispatched,
            code: application.applied ? null : application.code,
            reason: application.applied ? application.note : application.reason,
            targetAgentId: decision !== null && decision.action === 'reassign' ? (decision.agentId ?? null) : null,
          };
        },
        now: () => Date.now(),
      }, { policy: handoffPolicy });
    } catch (e) {
      // A continuation failure must never fail the round: the tasks keep whatever state
      // they reached, and the review still sees every attempt.
      process.stderr.write(`continuation could not run: ${(e as Error).message}\n`);
    }
  }

  // After any handoff, the round's own view is stale. Re-read it from the authorities so
  // the report and the review describe what actually happened, including the new attempt.
  const tasks = wb.store.all().map((t) => ({
    taskId: t.taskId,
    type: t.taskType,
    agentId: t.agentId,
    modelId: t.modelId,
    status: t.status,
    retries: t.retryCount,
  }));

  // "What actually ran" is read from the EVIDENCE store, not from the cycle's tick.
  //
  // `runDecisionCycle` builds its own `dispatch` closure to capture the tick, but it
  // spreads `capabilities` AFTER it - so the Workbench's capability `dispatch`
  // overrides that closure, `outcome.tick` stays null, and reporting from it would
  // claim nothing ran while a real agent was mid-flight. The AttemptStore is the
  // authority for "a run happened", so that is what this reads.
  const ranTasks = tasks.filter((t) => wb.evidence.history(t.taskId).length > 0).map((t) => t.taskId);
  const evidence = tasks.map((t) => ({ taskId: t.taskId, attempts: wb.evidence.history(t.taskId).length }));

  const decisionPart: {
    status: string;
    action: string | null;
    rationale: string | null;
    applied: boolean;
    dispatched: boolean;
    via: string | null;
    code: string | null;
    note: string | null;
    dispatchedTasks: string[];
  } =
    outcome.status === 'ok'
      ? {
          status: outcome.status,
          action: outcome.decision?.action ?? null,
          rationale:
            outcome.decision !== null && 'rationale' in outcome.decision
              ? (outcome.decision.rationale ?? null)
              : null,
          applied: outcome.application.applied,
          dispatched: outcome.application.dispatched,
          via: outcome.application.via ?? null,
          // `note` on success, `reason` on a refusal - the union names them
          // differently on purpose, so both are read rather than guessed.
          code: outcome.application.applied ? null : outcome.application.code,
          note: outcome.application.applied ? outcome.application.note : outcome.application.reason,
          dispatchedTasks: ranTasks,
        }
      : {
          status: outcome.status,
          action: null,
          rationale: null,
          applied: false,
          dispatched: false,
          via: null,
          code: outcome.status === 'invalid' ? outcome.error.code : 'provider-unavailable',
          note: outcome.error.message,
          dispatchedTasks: [],
        };

  const succeeded = tasks.filter((t) => t.status === 'succeeded').length;
  const toVerify = tasks.filter((t) => t.status === 'to_verify').length;
  const ranSomething = decisionPart.dispatchedTasks.length > 0;

  // ---- the round is over: stop observing, then publish the FINAL state -------
  // Order matters. The timer is cleared before the last publish so no in-flight tick
  // can land after the terminal snapshot.
  if (observeTimer !== null) clearInterval(observeTimer);
  observe(Date.now());
  // Read the round's own final summary back out of the read model, so the report can
  // show what an operator would actually have seen on the dashboard.
  const observedFinal = observer === null
    ? null
    : buildExecutionSnapshot({
        store: wb.store,
        workspace,
        sessions: wb.sessions,
        rootTaskId: rootId,
        now: Date.now(),
      });

  report.stage = 'complete';
  report.ok = outcome.status === 'ok' && unassigned.length === 0;
  report.decision = decisionPart;
  report.tasks = tasks;
  report.evidence = evidence;
  report.unassigned = unassigned.map((a) => ({ taskId: a.taskId, code: a.code, reason: a.reason }));
  report.summary = {
    total: tasks.length,
    succeeded,
    toVerify,
    dispatched: decisionPart.dispatchedTasks.length,
  };
  // Null unless `--observe` was given. This reports WHERE the observation went and
  // what the dashboard would have shown, not an instruction to read it.
  report.observation = observationPaths === null || observedFinal === null
    ? null
    : {
        stateFile: observationPaths.state,
        eventsFile: observationPaths.events,
        overallStatus: observedFinal.overallStatus,
        currentStage: observedFinal.currentStage,
        counts: observedFinal.counts,
        workspaces: observedFinal.workspaces.map((ws) => ({
          taskId: ws.taskId,
          mode: ws.mode,
          path: ws.path,
          claimCount: ws.claimCount,
        })),
      };
  // ---- ONE unified review of the WHOLE round, for EVERY terminal outcome -------
  //
  // Placement is load-bearing. This runs:
  //   - AFTER the decision cycle, so every terminal outcome already exists
  //   - AFTER `observeTimer` is cleared, so the review is the round's CLOSING step and
  //     cannot mutate the round while it is still being observed
  //
  // Every field below is read from an authority that already owns it. Nothing is
  // reconstructed and nothing is invented:
  //
  //   prompt     wb.briefFor()      the ONE function that composes what a worker is told
  //   evidence   wb.handoffFor()    the existing projection of a real RunResult
  //   outcomes   classifyExecutionOutcome(run | refusalCode | status)
  //   attempts   wb.evidence        the AttemptStore, the one evidence store
  //
  // A task refused at admission has no RunResult and no handoff; it still appears, with
  // its refusal code as its outcome, because "the gate refused this" is exactly the kind
  // of outcome a round needs reviewed.
  const runResults = wb.runResults();
  const executionOutcomes: ExecutionOutcome[] = [];
  const packetTasks: ReviewPacketTask[] = [];

  for (const t of tasks) {
    const live = wb.store.get(t.taskId);
    if (live === null) continue;
    const run = runResults.get(t.taskId) ?? null;
    const history = wb.evidence.history(t.taskId);
    const lastAttempt = history.length > 0 ? history[history.length - 1]! : undefined;
    const refused = unassigned.find((a) => a.taskId === t.taskId);

    const outcome = classifyExecutionOutcome({
      taskId: t.taskId,
      taskStatus: live.status,
      agentId: live.agentId ?? t.agentId ?? null,
      modelId: live.modelId ?? t.modelId ?? null,
      run,
      // A task the gate refused before dispatch: the refusal CODE is the real reason.
      refusalCode: refused?.code ?? null,
      refusalReason: refused?.reason ?? null,
      attemptIds: history.map((a) => a.attemptId),
    });
    executionOutcomes.push(outcome);

    const brief = wb.briefFor(t.taskId, runResults);
    packetTasks.push({
      taskId: t.taskId,
      taskType: live.taskType,
      status: live.status,
      agentId: outcome.agentId,
      modelId: outcome.modelId,
      outcome: outcome.outcome,
      executed: outcome.executed,
      prompt: brief === null ? null : tailText(brief),
      // `null` when nothing ran: no run means no evidence, and inventing an empty handoff
      // would read as "ran and changed nothing".
      handoff: run === null ? null : wb.handoffFor(t.taskId, run),
      attemptIds: outcome.attemptIds,
      leaseVersion: lastAttempt?.leaseVersion ?? null,
      errorCode: outcome.code,
      errorMessage: outcome.reason,
    });
  }

  // Quota and resource signals are the REAL observations the round already made, not a
  // summary written after the fact. An agent with no usable quota record is named.
  const quotaSignals = [
    ...quotaRecords
      .filter((r: QuotaRecord) => r.status !== 'available')
      .map((r: QuotaRecord) => `${r.agentId}: quota ${String(r.status)}`),
    ...(quotaProbed.length === 0 ? ['no agent produced a usable quota record this round'] : []),
  ];
  const resourceSignals = [
    ...unassigned.map((a) => `${a.taskId}: refused ${a.code}${a.reason === null ? '' : ` — ${a.reason}`}`),
    workspace === null
      ? 'workspace isolation UNAVAILABLE (not a git repository); every task shared one directory'
      : `isolated worktrees under ${repoRoot}`,
  ];

  // Laya's own words, built once and used by BOTH the review packet and the round
  // result. Two copies of this text would be two chances for the report and the review
  // to disagree about what the plan was.
  const layaPlanText = [
    `classification: work_kind=${classification.work_kind} complexity=${classification.complexity} ` +
      `review_required=${classification.review_required}`,
    planned.planned.classificationReason === null
      ? 'Laya gave no reason for the classification.'
      : `Laya's reason: ${planned.planned.classificationReason}`,
    `plan shape: ${planned.planned.shape}`,
    `decision cycle: ${decisionPart.status}${decisionPart.action === null ? '' : ` -> ${decisionPart.action}`}` +
      `${decisionPart.rationale === null ? '' : ` (${decisionPart.rationale})`}`,
  ].join('\n');

  const evidenceNote = `AttemptStore holds ${wb.evidence.size} attempt record(s) for this round; ` +
    'each attemptId above resolves there, and each transcriptPath resolves to the full conversation.';

  const reviewPacket = buildReviewPacket({
    roundId: rootId,
    originalRequest: o.objective,
    layaPlan: layaPlanText,
    tasks: packetTasks,
    outcomes: executionOutcomes,
    quotaSignals,
    resourceSignals,
    evidenceNote,
  });

  let unifiedReview: UnifiedReviewResult;
  if (!o.review) {
    // Said as "not requested", never as a pass. An offline round that skipped its review
    // must not be readable as one that passed review.
    unifiedReview = {
      status: 'not_requested',
      reviewer: o.reviewAgent,
      verdict: null,
      reason: '--no-review was given, so nothing reviewed this round',
      findings: [],
      recommendations: [],
      outputTail: null,
      code: null,
      reviewedAt: null,
    };
  } else {
    try {
      unifiedReview = await runUnifiedReview(runtime, reviewPacket, {
        reviewer: o.reviewAgent,
        // The reviewer's REAL configured model, or none: this file does not pick a model.
        modelId: runtime.configFor(o.reviewAgent).model ?? null,
        cwd: o.cwd,
        now: () => Date.now(),
        timeoutMs: o.reviewTimeoutMs,
      });
    } catch (e) {
      // Defensive: a review must never be able to fail the round it is reviewing.
      unifiedReview = {
        status: 'failed',
        reviewer: o.reviewAgent,
        verdict: null,
        reason: `the review step threw: ${(e as Error).message}`,
        findings: [],
        recommendations: [],
        outputTail: null,
        code: 'review-threw',
        reviewedAt: null,
      };
    }
  }

  const unified = buildUnifiedRoundReport(reviewPacket, unifiedReview);
  report.unifiedReview = unified.review;
  report.executionOutcomes = executionOutcomes;
  report.unifiedReport = renderUnifiedRoundReport(unified);

  // R2-3 P1-2: put the review INTO the evidence chain.
  //
  // The verdict used to exist only in the round report, so the append-only AttemptStore
  // held executions with no review beside them and `attempt -> review` was not walkable.
  //
  // `recordReviewEvidence` is the EXISTING writer (`recordReview`), reused; it deliberately
  // does NOT apply the verdict, because a unified verdict is a recommendation to the user
  // and applying it would make review a second authority over task state. No ReviewStore
  // and no ReportAuthority is introduced.
  //
  // This ADDS to execution evidence, never replaces it: a task whose review fails to
  // record keeps every execution attempt it already had.
  report.reviewEvidence = { recorded: false, attemptId: null, code: null, reason: null };
  // Typed local, because `report` is an untyped record: the round result below must not
  // have to re-read its own evidence outcome through `unknown`.
  let reviewEvidenceRecorded = false;
  let reviewEvidenceAttemptId: string | null = null;
  if (unifiedReview.status === 'completed' && unifiedReview.verdict !== null) {
    const recordedReview = wb.recordReviewEvidence(rootId, unifiedReview.verdict);
    report.reviewEvidence = recordedReview;
    reviewEvidenceRecorded = recordedReview.ok;
    reviewEvidenceAttemptId = recordedReview.attemptId;
    // Best-effort: a refused evidence append must never fail the round, and must be
    // visible rather than silent.
    if (!recordedReview.ok) {
      process.stderr.write(
        `review evidence was not recorded (${recordedReview.code}): ${recordedReview.reason ?? ''}\n`,
      );
    }
  }

  // R2-3: the dispatch accounting, so double-dispatch is measurable in the report.
  report.handoffDispatches = handoffDispatches;
  report.handoffAgentChain = Object.fromEntries(
    [...handoffAgentChain.entries()].map(([k, v]) => [k, [...v]]),
  );

  // R2-3: handoff visibility in the round report. Recorded as a FACT (who, why, which
  // task, which attempt) rather than as a narrative, so the stop reason is always visible
  // — including when no handoff happened, which must not read as "everything was fine".
  report.handoff = continuation === null
    ? { enabled: false, happened: 0, limit: o.handoffMax, handoffs: [], stopped: { code: 'not-attempted', reason: '--no-handoff was given, so every task got exactly one attempt' } }
    : {
        enabled: true,
        happened: continuation.handoffs.length,
        limit: continuation.policy.maxAutomaticHandoffsPerTask,
        handoffs: continuation.handoffs.map((hd) => ({
          taskId: hd.taskId,
          reason: hd.reason,
          fromAgentId: hd.fromAgentId,
          toAgentId: hd.toAgentId,
          previousAttemptId: hd.previousAttemptId,
          decision: hd.decisionAction,
          note: hd.decisionNote,
        })),
        stopped: continuation.stopped,
        cyclesUsed: continuation.cyclesUsed,
      };

  // Said out loud, because it is the most misreadable thing about this command.
  report.nextStep =
    unifiedReview.status === 'completed'
      ? `The round was reviewed by ${o.reviewAgent}: ${unifiedReview.verdict?.verdict ?? 'unknown'}. ` +
        `${toVerify > 0 ? `${toVerify} task(s) sit in to_verify and are NOT verified - Verification is the only ` +
          'completion authority. ' : ''}` +
        'Any next-round suggestion was NOT executed. Run this again yourself to act on it.'
      : `The round could NOT be reviewed (${unifiedReview.status}: ${unifiedReview.reason ?? 'no reason given'}). ` +
        'The execution evidence above is unaffected, but no independent judgement of this round exists yet.';

  // ---- R4: RESULT AGGREGATION + HUMAN GATE ----------------------------------
  //
  // Placement is the whole point of this block:
  //   - AFTER continuation, dispatch, and the review, so every terminal outcome,
  //     attempt, and handoff already exists in the authorities
  //   - AFTER `report.reviewEvidence` is written, so the report knows whether the
  //     verdict reached the evidence chain
  //   - AFTER `report.nextStep`, and this is where the round ENDS
  //
  // `buildRoundResult` is pure and this block performs NO action. From here to the
  // `return` there is no dispatch, no retry, no reassign, no replan and no second
  // decision cycle. The gate's whole job is to make that absence explicit rather than
  // incidental.
  const taskEvidence: Record<string, TaskEvidenceInput> = {};
  for (const t of wb.store.all()) {
    const run = runResults.get(t.taskId);
    if (run === undefined) continue;
    const handoff = wb.handoffFor(t.taskId, run);
    taskEvidence[t.taskId] = {
      changedFiles: handoff?.changedFiles ?? [],
      testsRun: handoff?.testsRun ?? [],
      artifacts: (handoff?.artifacts ?? []).map((a) => ({ name: a.name, path: a.path })),
      transcriptPath: handoff?.transcriptPath ?? null,
      errorCode: handoff?.error?.code ?? null,
      errorMessage: handoff?.error?.message ?? null,
    };
  }

  const roundResult: RoundResult = buildRoundResult({
    identity: {
      roundId: rootId,
      startedAt,
      completedAt: Date.now(),
      complete: true,
    },
    originalRequest: o.objective,
    layaPlan: layaPlanText,
    // Straight from the authorities: the TaskStore for state, the AttemptStore for
    // evidence. Nothing is re-listed from the plan.
    tasks: wb.store.all(),
    attempts: wb.evidence.all(),
    unified,
    reviewOutputSummary: unifiedReview.outputTail === null ? null : unifiedReview.outputTail.text,
    reviewRequested: o.review,
    reviewEvidence: {
      recorded: reviewEvidenceRecorded,
      attemptId: reviewEvidenceAttemptId,
    },
    continuation: continuation === null
      ? null
      : {
          happened: continuation.handoffs.length,
          limit: continuation.policy.maxAutomaticHandoffsPerTask,
          handoffs: continuation.handoffs.map((hd) => ({
            taskId: hd.taskId,
            reason: hd.reason,
            fromAgentId: hd.fromAgentId,
            toAgentId: hd.toAgentId,
            previousAttemptId: hd.previousAttemptId,
            decisionAction: hd.decisionAction,
            decisionApplied: hd.decisionApplied,
            at: hd.at,
          })),
          stopped: continuation.stopped,
          agentChain: continuation.agentChain,
        },
    evidence: taskEvidence,
    evidenceNote,
  });

  // Published for the dashboard to READ. It is a report artifact: a missing or failed
  // write changes nothing about the round, so the failure is reported and then ignored.
  report.roundResult = roundResult;
  report.roundResultReport = renderRoundResult(roundResult);
  const published = publishRoundResult(roundResult, {
    onError: (message) => note(message),
  });
  report.roundResultPublished = { ok: published.ok, path: published.path, code: published.code };

  if (o.json) {
    w(JSON.stringify(report, null, 2));
  } else {
    w('EXECUTION ROUND');
    w(`  objective     ${o.objective}`);
    w(`  root          ${rootId}`);
    w(`  laya          work_kind=${classification.work_kind} complexity=${classification.complexity} review=${classification.review_required}`);
    w(`  probed        ${quotaProbed.length} agent(s) with real quota records`);
    w(`  workspace     ${workspace === null ? 'SHARED cwd - isolation unavailable (not a git repository)' : `isolated worktrees (repo ${repoRoot})`}`);
    w();
    w(`DECISION  ${decisionPart.status}${decisionPart.action ? ` -> ${decisionPart.action}` : ''}`);
    w(`  applied      ${decisionPart.applied}`);
    w(`  dispatched   ${decisionPart.dispatched}`);
    if (decisionPart.code) w(`  code         ${decisionPart.code}`);
    if (decisionPart.note) w(`  note         ${decisionPart.note}`);
    if (decisionPart.dispatchedTasks.length > 0) w(`  ran          ${decisionPart.dispatchedTasks.join(', ')}`);
    w();
    w('TASKS');
    for (const t of tasks) {
      w(`  ${t.taskId.padEnd(18)} ${String(t.type).padEnd(15)} ${t.agentId}/${t.modelId ?? '-'}  ${t.status}`);
    }
    w();
    if (unassigned.length > 0) {
      w('UNASSIGNED (the gate refused; nothing ran for these)');
      for (const a of unassigned) w(`  ${a.taskId}  ${a.code}  ${a.reason ?? ''}`);
      w();
    }
    // Every outcome, so a refusal is visibly an outcome rather than a silent gap.
    if (executionOutcomes.length > 0) {
      w('OUTCOMES');
      for (const e of executionOutcomes) {
        w(`  ${e.taskId.padEnd(18)} ${String(e.outcome).padEnd(20)} executed=${e.executed}${e.code === null ? '' : `  code=${e.code}`}`);
      }
      w();
    }
    // R2-3 handoff block. Deliberately names the agents, the unchanged task, and why the
    // chain stopped — including when no handoff happened, which must never read as
    // "everything was fine".
    const handoffInfo = report.handoff as {
      enabled: boolean; happened: number; limit: number;
      handoffs: Array<{ taskId: string; reason: string; fromAgentId: string | null; toAgentId: string | null; previousAttemptId: string | null }>;
      stopped: { code: string; reason: string };
    };
    w('接力（Agent Handoff）');
    if (!handoffInfo.enabled || handoffInfo.happened === 0) {
      w(`  未发生接力 — ${handoffInfo.stopped.reason}`);
    } else {
      w(`  ${handoffInfo.happened} / ${handoffInfo.limit}`);
      for (const hd of handoffInfo.handoffs) {
        w(`  ${hd.taskId}  ${hd.fromAgentId ?? '?'} → ${hd.toAgentId ?? '?'}  原因=${hd.reason}`);
        w(`      Task 保持不变；上一 Attempt=${hd.previousAttemptId ?? '(none)'}`);
      }
      w(`  停止原因：${handoffInfo.stopped.code} — ${handoffInfo.stopped.reason}`);
    }
    w();
    w('CODEX REVIEW');
    w(`  status       ${unifiedReview.status}`);
    w(`  reviewer     ${o.reviewAgent}`);
    if (unifiedReview.verdict !== null) w(`  verdict      ${unifiedReview.verdict.verdict}`);
    if (unifiedReview.reason !== null) w(`  reason       ${unifiedReview.reason}`);
    if (unifiedReview.findings.length > 0) {
      for (const f of unifiedReview.findings) w(`  finding      [${f.severity}] ${f.location}: ${f.message}`);
    }
    for (const r of unifiedReview.recommendations) w(`  next round   ${r}`);
    if (unifiedReview.status !== 'completed') {
      w('  note         the execution evidence above is complete and unaffected by this.');
    }
    w();
    w('NEXT');
    w(`  ${report.nextStep}`);
    if (ranSomething) w('  The round is over. Run it again yourself if you want another round.');
    // R4: the gate is printed LAST on purpose. It is the last thing this process does,
    // and the report says so rather than implying there is more round to come.
    w();
    w('HUMAN GATE');
    w(`  status       ${roundResult.gate.status}`);
    w(`  round done   ${roundResult.gate.roundComplete}`);
    w(`  reason       ${roundResult.gate.reason}`);
    w(`  tasks        ${roundResult.gate.taskTally.succeeded} succeeded, ${roundResult.gate.taskTally.failed} failed, ` +
      `${roundResult.gate.taskTally.cancelled} cancelled, ${roundResult.gate.taskTally.other} other`);
    if (roundResult.gate.nonTerminalTasks.length > 0) {
      w(`  not terminal ${roundResult.gate.nonTerminalTasks.join(', ')}`);
    }
    if (roundResult.gate.reviewOutstanding) w('  review       requested but not completed');
    for (const d of roundResult.gate.decisions) {
      w(`  to decide    [${d.id}] ${d.label}`);
      w(`               ${d.detail}`);
    }
    w(`  auto action  ${roundResult.gate.automaticPostRoundAction.toUpperCase()}`);
    w('               Nothing was retried, reassigned, replanned, split, parallelized,');
    w('               reworked or handed off after the gate. Start the next round yourself.');
  }

  // R4: from here the round is over. There is intentionally no code path between the
  // human gate and this return that dispatches, retries, reassigns, replans, splits,
  // parallelizes, reworks or hands off.
  return report.ok ? 0 : 1;
}

export { USAGE as ROUND_CLI_USAGE };
