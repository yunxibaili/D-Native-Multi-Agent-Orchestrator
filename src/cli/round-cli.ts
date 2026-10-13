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
// TeamRun T2-a.3: the observation seam's snapshot type. Imported here only so the seam is
// typed against the DETACHED projection; `NativeWorkbench` itself must never appear in
// that signature again.
import type { RoundWorkbenchObservation } from './round-observation.ts';
import { observeRoundWorkbench } from './round-observation.ts';
import {
  NativeWorkbench,
  Orchestrator as MultiTaskOrchestrator,
  TaskScheduler,
  WorkspaceManager,
  normalizeScopeForWorkspace,
  runDecisionCycle,
  type AcceptanceMaterial,
  type AcceptanceMaterialEntry,
  // TeamRun T3-a.1: READ-only fan-out vocabulary.
  FANOUT_MEMBER_TASK_TYPE,
  FANOUT_MAX_MEMBERS,
  projectFanoutAggregation,
  type ResourceClaimMode,
  type WorkbenchTaskSpec,
} from '../orchestration/index.ts';
// TeamRun T3-a.1: Laya's execution-topology decision preset.
import {
  decideExecutionTopology,
  type RawExecutionTopology,
} from '../decision/execution-topology.ts';
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
import { WORKFLOW_PLAN_CHOICES, buildWorkflowCandidates, isWorkflowChoice, type HeterogeneousWorkflowChoice } from '../orchestration/workflow-plan.ts';
import { decideWorkflowPlan, type WorkflowPlanCandidate } from '../decision/plan-choice.ts';
import { buildDispatchReceipt } from '../orchestration/dispatch-receipt.ts';
import { projectDispatchTaskEvidence } from '../orchestration/dispatch-evidence.ts';
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
// R5-1.2C (§14): the floor and ceiling quoted in `--execution-timeout` help now come
// from the ONE validator's own constants, so the documented range can never drift from
// the enforced range again (it said 1000 while the real minimum is 50).
import {
  validateExecutionTimeoutMs,
  MIN_EXECUTION_TIMEOUT_MS,
  NODE_TIMER_MAX_MS,
} from '../orchestration/execute.ts';
import { createLayaDecisionProvider } from '../decision/laya.ts';
import type { DecisionProvider } from '../decision/types.ts';
import { classifyTask } from '../decision/routing.ts';
import type { TaskClassification } from '../decision/routing.ts';
import type { TaskType } from '../quota/types.ts';
// TeamRun T3-a.5: the current execution bundle names the result correlated to the current
// Attempt, so `RunResult` is part of the projection's own vocabulary here.
import type { RunResult, SelectionSpec } from '../core/types.ts';
import { resolveSelection, fixedPairOf } from '../core/types.ts';

const USAGE = `orchestrator round - ONE execution round: decide - execute - observe - report

USAGE
  orchestrator round "<objective>" [options]

The round ENDS when it reports. It is not a daemon: no loop, no auto-retry, no
auto-replan. Run it again yourself if you want another round.

OPTIONS
  --cwd <dir>            project directory the workers run in (default: cwd)
  --select auto|fixed    task-level Agent x Model selection mode (B1.4).
                         auto  = use the existing LAYA decision (overrides a project default)
                         fixed = require --agent <id> AND --model <full-id>; Assignment
                                 enforces the exact pair (accept or refuse, never substitute)
  --agent <id>           with --model: the FIXED agent; alone: prefer this agent
  --model <id>           with --agent: the FIXED full model id; alone: prefer this model
  --workflow sequential  opt-in heterogeneous workflow (B4.0): research -> implementation
                         -> test as independent tasks run in dependency order. Absent = legacy.
  --workflow-choice <c>  pin the workflow plan (full|lean); absent = LAYA picks among the
                         bounded candidates (requires --workflow sequential).
  --laya-url <url>       laya-serve base URL (default: http://127.0.0.1:8077)
  --laya-timeout <ms>    decision timeout (default: 60000)
  --execution-timeout <ms>
                         NATIVE AGENT execution deadline in MILLISECONDS, enforced
                         inside the runtime by the agent session itself (default:
                         1800000 = 30 minutes; allowed range ${MIN_EXECUTION_TIMEOUT_MS}..${NODE_TIMER_MAX_MS}).
                         This is NOT the decision timeout and NOT a result-wait
                         bound. 0 / negative / non-finite / oversized values are
                         rejected; unlimited execution is not supported.
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
  /** B1.4: task-level selection mode; `auto` or `fixed`. Absent = project/auto. */
  select?: string;
  /** B4.0: opt-in heterogeneous sequential workflow (`sequential`). Absent = legacy. */
  workflow?: string;
  /** B4.0: pin a single workflow plan choice (`full`/`lean`); absent = LAYA picks. */
  workflowChoice?: string;
  layaUrl: string;
  layaTimeoutMs: number;
  /** R5-1 (P1-A): native EXECUTION deadline (RunRequest.timeoutMs), not a wait bound. */
  executionTimeoutMs: number;
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

const VERBATIM = new Set(['laya-url', 'agent', 'model', 'select', 'workflow', 'workflow-choice', 'cwd', 'observe', 'review-agent']);

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

  // R5-1.1 (§6): validate the execution deadline BEFORE building the options, so a
  // bad value fails the parse with a readable message (never reaches `setTimeout`).
  const execTimeoutCheck = validateExecutionTimeoutMs(num('execution-timeout', 30 * 60_000));
  if (!execTimeoutCheck.ok) return { error: `--execution-timeout: ${execTimeoutCheck.reason}` };

  try {
    // B1.4: `--select` is the task-level selection MODE. `auto` explicitly restores the
    // LAYA decision (overriding a project default); `fixed` requires BOTH `--agent` and
    // `--model`. Absent, a COMPLETE `--agent`+`--model` pair is treated as fixed (the
    // repo's existing "complete pair = explicit choice" convention) and a lone
    // `--agent`/`--model` keeps the legacy preference semantics.
    const select = s('select');
    // A bare `--select` (no value) parses to boolean `true`; it must be a clear usage
    // error BEFORE discovery / LAYA / runtime — never silently treated as `auto`.
    if (flags.select === true) {
      return { error: '--select requires a value: "auto" or "fixed"' };
    }
    if (select !== undefined && select !== 'auto' && select !== 'fixed') {
      return { error: `--select must be "auto" or "fixed" (got "${select}")` };
    }
    // B4.0: opt-in heterogeneous sequential workflow. A bare flag is a usage error.
    const workflow = s('workflow');
    if (flags.workflow === true) return { error: '--workflow requires a value: "sequential"' };
    if (workflow !== undefined && workflow !== 'sequential') {
      return { error: `--workflow must be "sequential" (got "${workflow}")` };
    }
    const workflowChoice = s('workflow-choice');
    if (flags['workflow-choice'] === true) return { error: '--workflow-choice requires a value: "full" or "lean"' };
    if (workflowChoice !== undefined && !isWorkflowChoice(workflowChoice)) {
      return { error: `--workflow-choice must be one of full, lean (got "${workflowChoice}")` };
    }
    if (workflowChoice !== undefined && workflow === undefined) {
      return { error: '--workflow-choice requires --workflow sequential' };
    }
    const agentFlag = s('agent');
    const modelFlag = s('model');
    if (select === 'fixed' && (agentFlag === undefined || modelFlag === undefined)) {
      return { error: '--select fixed requires BOTH --agent <id> and --model <full-id>' };
    }
    if (select === 'auto' && (agentFlag !== undefined || modelFlag !== undefined)) {
      return { error: '--select auto cannot be combined with --agent/--model' };
    }
    return {
      objective,
      cwd,
      ...(agentFlag !== undefined ? { agent: agentFlag } : {}),
      ...(modelFlag !== undefined ? { model: modelFlag } : {}),
      ...(select !== undefined ? { select } : {}),
      ...(workflow !== undefined ? { workflow } : {}),
      ...(workflowChoice !== undefined ? { workflowChoice } : {}),
      layaUrl: s('laya-url') ?? 'http://127.0.0.1:8077',
      layaTimeoutMs: num('laya-timeout', 60_000),
      // R5-1.1 (§6/P1-A): the NATIVE EXECUTION deadline — a different thing from the
      // Laya decision timeout above. Enforced INSIDE the runtime by the agent session
      // (real `timed_out` terminal), validated above at the CLI boundary.
      executionTimeoutMs: execTimeoutCheck.value,
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
  /**
   * B4.0b: publish `round-result.json` HERE instead of at the production default
   * (`$ORCH_HOME/round-result.json`).
   *
   * The publish path already accepted a `dir`; nothing threaded it from here, so every
   * caller - including tests driving the real CLI - wrote to the user's own report
   * location. This is the SAME seam `provider`/`probes` use: the caller supplies the
   * fact, production decides nothing, and `index.ts` still passes nothing.
   *
   * Only the report PUBLISH location. It does not move `--observe`, the store, or any
   * other path, so it cannot quietly relocate a round's real artifacts.
   */
  readonly roundResultDir?: string;
  /**
   * TeamRun T2-a.3: a READ-ONLY observation seam, and an OBSERVATION seam only.
   *
   * T2-a.2 originally typed this `(wb: NativeWorkbench) => void`, which handed the
   * callback the live workbench: through it a test could call `assignChildren`,
   * `reassignTask`, `store.assignIdentity`, `sessions.open` or `spawnChild`, and so
   * change the pair the round actually dispatched on. Inspecting and controlling are
   * different capabilities, and only one of them is safe to expose to a test.
   *
   * The parameter is now a detached, frozen SNAPSHOT of plain values — never the
   * workbench, a store, a registry, an assignment or a runtime. There is therefore
   * nothing on it to call. Note this is not `Readonly<NativeWorkbench>`: that would
   * still leave every mutation method intact.
   *
   * The return value is ignored by contract (§6), and the call is failure-isolated (§1),
   * so an observer can neither steer the round nor break it by throwing.
   */
  readonly onWorkbenchSnapshot?: (snapshot: RoundWorkbenchObservation) => void;
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
    // R5-1 (P1-A): the execution deadline (enforced INSIDE the runtime by
    // `AgentSession` via `RunRequest.timeoutMs`), not a result-wait bound. Passing
    // the Laya decision timeout here used to make a long agent run get marked
    // failed with `runtime-result-failed` while the native process was still alive.
    executionTimeoutMs: o.executionTimeoutMs,
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
  // B1.4: the PROJECT default selection from config. Read defensively (a test/stub
  // runtime may not implement the accessor); absent => no project default.
  const projectSelection = (runtime as { projectSelection?: () => SelectionSpec | undefined }).projectSelection?.();
  const wb = new NativeWorkbench({
    orchestrator: coord,
    scheduler,
    registry,
    quotaRecords,
    cwd: o.cwd,
    // B1.4: the PROJECT default selection from orchestrator.json. The task-level
    // selection on the spec overrides it; `auto`/absent falls back to Laya.
    ...(projectSelection !== undefined ? { projectSelection } : {}),
    // TeamRun T2-a.1: the PRODUCTION initial path is Laya-controlled. The workbench
    // reuses the provider this command already builds for classification — no second
    // provider, no second planner. A round whose Laya selection cannot be obtained now
    // REFUSES its tasks explicitly instead of letting Assignment's scoring answer for
    // Laya and the output looking like a semantic judgement.
    decisionProvider: provider,
  });
  // TeamRun T2-a.3: the observation seam is a FAILURE-ISOLATED notifier over a detached,
  // frozen snapshot. It is deliberately NOT called here: at this point the workbench has
  // no root task and nothing has been planned or assigned, so a snapshot taken now would
  // be empty and could not show the Assignment-established binding the regressions need.
  //
  // It fires at the round's EXITS instead (the assignment-failure path and the final
  // return), where the authoritative state is complete. Being that late is also what makes
  // it safe: by then every dispatch is done, so an observer is not merely unable to steer
  // the round — there is nothing left to steer.
  const notifyWorkbenchSnapshot = (): void => {
    if (overrides.onWorkbenchSnapshot === undefined) return;
    try {
      overrides.onWorkbenchSnapshot(observeRoundWorkbench(wb));
    } catch {
      // An observer must never be able to fail a round it is only watching (§1/§8).
    }
  };

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
  // B1.4: the TASK-level selection. `--select auto` restores Laya explicitly (and
  // overrides a project default); a COMPLETE `--agent`+`--model` pair is a fixed pair.
  // A lone `--agent`/`--model` keeps the legacy preference semantics.
  const taskSelection: SelectionSpec | undefined =
    o.select === 'auto'
      ? { mode: 'auto' }
      : (o.agent !== undefined && o.model !== undefined
        ? { mode: 'fixed', agentId: o.agent, modelId: o.model }
        : undefined);
  const lonePreferredAgent = o.agent !== undefined && o.model === undefined ? o.agent : undefined;
  const lonePreferredModel = o.model !== undefined && o.agent === undefined ? o.model : undefined;
  const spec: WorkbenchTaskSpec = {
    taskId: rootId,
    objective: o.objective,
    taskType: taskTypeFor(classification),
    budgetUnits: o.budgetUnits,
    ...(taskSelection !== undefined ? { selection: taskSelection } : {}),
    ...(lonePreferredAgent !== undefined ? { preferredAgent: lonePreferredAgent } : {}),
    ...(lonePreferredModel !== undefined ? { preferredModel: lonePreferredModel } : {}),
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

  // B1.4: report the EFFECTIVE selection so an operator can see the mode, where it came
  // from (task / project / default), and the pair the user requested. The model passed to
  // the Runtime and the agent-confirmed ACTUAL model are reported per task after assignment
  // (an agent with no model evidence stays `unknown`, never a claimed provider model).
  {
    const effective = resolveSelection(taskSelection, projectSelection);
    const source: 'task' | 'project' | 'default' =
      taskSelection !== undefined ? 'task' : projectSelection !== undefined ? 'project' : 'default';
    report.selection = {
      mode: effective.mode,
      source,
      requested: fixedPairOf(effective) ?? null,
      note:
        effective.mode === 'auto'
          ? 'auto: the existing LAYA Agent x Model decision applies'
          : 'fixed: the user-pinned Agent x Model pair is enforced by Assignment (accept or refuse, never substitute)',
    };
  }

  // ---- STEP 4: plan + assign (Planner and Assignment, the only authorities) --
  let planned;
  let assigned;
  // B4.0: which bounded workflow plan ran, and how it was chosen (for the report).
  let workflowChoiceUsed: HeterogeneousWorkflowChoice | null = null;
  let workflowPlanSource = '';
  try {
    if (o.workflow === 'sequential') {
      /*
       * B4.0: a bounded heterogeneous plan (research -> implementation -> test). LAYA
       * picks among the OFFERED plans; it never invents a DAG. A pinned choice or a
       * single candidate is handled by the explicit rule and does NOT fake a LAYA
       * comparison. The chosen candidates go through the SAME commitPlan path.
       */
      const choices: WorkflowPlanCandidate[] = WORKFLOW_PLAN_CHOICES.map((c) => ({
        choice: c.choice, label: c.label, roles: c.steps.map((s) => s.role),
      }));
      if (o.workflowChoice !== undefined && isWorkflowChoice(o.workflowChoice)) {
        workflowChoiceUsed = o.workflowChoice;
        workflowPlanSource = 'pinned (--workflow-choice)';
      } else if (provider !== null && choices.length > 1) {
        workflowChoiceUsed = (await decideWorkflowPlan(provider, {
          task: { taskId: rootId, objective: o.objective },
          candidates: choices,
        })) as HeterogeneousWorkflowChoice;
        workflowPlanSource = 'Laya decision';
      } else {
        workflowChoiceUsed = WORKFLOW_PLAN_CHOICES[0]!.choice;
        workflowPlanSource = provider === null ? 'no provider: first bounded plan' : 'single candidate';
      }
      planned = wb.planWithCandidates(spec, buildWorkflowCandidates(workflowChoiceUsed, o.objective, rootId), [
        `B4.0 sequential workflow plan: ${workflowChoiceUsed} (${workflowPlanSource})`,
      ]);
    } else {
      planned = wb.plan(spec, classification);
    }
    // B4.0: report the workflow plan (mode, choice, how it was chosen, the steps).
    if (o.workflow === 'sequential' && workflowChoiceUsed !== null) {
      const plan = WORKFLOW_PLAN_CHOICES.find((c) => c.choice === workflowChoiceUsed);
      report.workflow = {
        enabled: true,
        choice: workflowChoiceUsed,
        source: workflowPlanSource,
        steps: (plan?.steps ?? []).map((s) => ({ role: s.role, taskType: s.taskType, deliverable: s.deliverable })),
        note: 'sequential: each step depends on the one before; PARALLEL_WRITE=CLOSED',
      };
    } else {
      report.workflow = { enabled: false };
    }
    // TeamRun T3-a.1: Laya decides the execution TOPOLOGY. SOLO is the existing path and
    // the default; PARALLEL_READ materializes N independent READ member Tasks. A transport
    // failure returns null (no topology opinion -> SOLO); a MALFORMED PARALLEL_READ throws
    // a schema error and refuses the round — it must never silently become SOLO.
    // B4.0: a workflow plan is already a sequential chain, so topology is left SOLO.
    let topology: RawExecutionTopology | null = null;
    if (o.workflow !== 'sequential' && provider !== null) {
      const readCandidates = registry.list()
        .filter((e) => e.modelId !== null && e.modelId !== '' && e.taskTypes.includes(FANOUT_MEMBER_TASK_TYPE))
        .map((e) => ({
          agentId: e.agentId,
          modelId: e.modelId as string,
          taskTypes: [...e.taskTypes],
          available: registry.isModelAvailable(e.agentId, e.modelId as string),
        }));
      try {
        topology = await decideExecutionTopology(provider, {
          task: { taskId: rootId, objective: o.objective, acceptanceCriteria: o.objective },
          candidates: readCandidates,
          maxMembers: FANOUT_MAX_MEMBERS,
        });
      } catch (e) {
        const msg = `${(e as Error).name}: ${(e as Error).message}`;
        report.stage = 'plan';
        report.error = `execution topology refused: ${msg}`;
        if (o.json) w(JSON.stringify(report, null, 2));
        else note(`execution topology refused: ${msg}`);
        notifyWorkbenchSnapshot();
        return 1;
      }
    }
    if (topology !== null && topology.kind === 'parallel_read') {
      const materialized = wb.materializeReadFanout(rootId, topology.membersRaw);
      if (!materialized.ok) {
        report.stage = 'plan';
        report.error = `fan-out topology refused: ${materialized.code}: ${materialized.reason}`;
        if (o.json) w(JSON.stringify(report, null, 2));
        else note(`fan-out topology refused: ${materialized.code}: ${materialized.reason}`);
        notifyWorkbenchSnapshot();
        return 1;
      }
    }
    // Every id that now exists under the root needs a task budget scope before it can be
    // assigned. Read from the STORE (not `planned.children`) so fan-out members are funded
    // too — `materializeReadFanout` replaced the planner's not-yet-started children.
    for (const child of wb.store.children(rootId)) budgets.task(child.taskId, o.budgetUnits);
    // TeamRun T2-a.1: Laya picks the INITIAL Agent x Model pair BEFORE Assignment runs.
    // Planner still only planned task decomposition and dependencies — it is not asked
    // for an agent, a model or a session. This call never dispatches, so the first
    // execution still happens only after Assignment has enforced the pair.
    await wb.selectInitialAssignment(rootId, spec.selection);
    assigned = wb.assignChildren(rootId, spec);
    // The gate needs THREE scopes to exist - global, task:<id> AND agent:<id> - and
    // `resolveBudgetHeadroom` deliberately refuses to auto-create a missing one
    // (touching `.task()`/`.agent()` to ASK would create it with zero allocation,
    // turning "unknown" into a real-but-empty ledger). So the agent scope for each
    // worker this round actually bound must be funded before dispatch, or every
    // execute is refused with `budget-scope-unavailable`.
    // TeamRun T2-a.2 (§1/§5): `agentId`/`modelId` are EXECUTION facts and are now read from
    // the AUTHORITATIVE post-assignment state, never from the planner-era snapshot. Reading
    // `planned.children` here funded the agent the Planner had named, so a round whose
    // Laya decision moved the task to another agent ended up with no budget scope for the
    // agent that would actually run it — and every execute was refused
    // `budget-scope-unavailable` for a ledger that was simply configured for the wrong
    // worker. `planned.children` keeps its planning uses (task ids, dependencies,
    // classification, shape); execution identity comes from TaskStore from here on.
    for (const child of wb.store.children(rootId)) {
      const outcome = assigned.find((a) => a.taskId === child.taskId);
      if (outcome?.ok !== true) continue;
      budgets.agent(child.agentId, o.budgetUnits);
    }
    // TeamRun T2-a.2 (§7/§8): there is deliberately NO session open here any more.
    // `assignChildren` already opened the authoritative session, bound to the ENFORCED
    // pair, and the line above this block already said so. Re-opening from the planning
    // snapshot created a SECOND session carrying the STALE agent/model — so a task could
    // hold a Worker identity and evidence for `agent-b/m1` while its session binding said
    // `agent-a/null`. The CLI owns no session decision (policy, model and agent all
    // belong to Assignment and SessionRegistry), so it now only CONSUMES the binding
    // instead of replacing it. The comment this block contradicts is preserved below.
    //
    // Assignment is the only thing that may bind a session to a task.
  } catch (e) {
    const msg = `${(e as Error).name}: ${(e as Error).message}`;
    report.stage = 'plan';
    report.error = msg;
    if (o.json) w(JSON.stringify(report, null, 2));
    else note(`planning/assignment failed: ${msg}`);
    // T2-a.3: the failure path is a legitimate observation point — a refused initial
    // selection is exactly the state T2A2-5/T2A3-6 need to inspect, and it must show NO
    // resurrected pair rather than the Planner's.
    notifyWorkbenchSnapshot();
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

  // TeamRun T3-a.3: the round's CURRENT execution evidence, captured from each dispatch.
  // A member's actual identity may ONLY come from here + AttemptStore — never from
  // `lastRunResult`/attempt HISTORY, which can describe a PREVIOUS execution. Each dispatch
  // OVERWRITES a task's entry, so a later refusal clears an earlier run.
  //
  // TeamRun T3-a.5: `attemptId` and `run` are ONE correlated pair, both read off the same
  // entry of `receipt.executionsByTask` — bound at the AttemptStore append that minted the id
  // from the very run that built the record. `wb.lastRunResult(taskId)` is GONE from this path
  // on purpose: a `taskId` can own Attempt A, B and C, so "newest result held for this task"
  // is a different question from "the current attempt's result" and can hand back A's result
  // while the current attempt is B.
  type CurrentExecution = {
    outcome: 'started' | 'dispatch-refused' | 'pending';
    attemptIds: string[];
    attemptId: string | null;
    refusalCode: string | null;
    refusalReason: string | null;
    /** THE result of `attemptId`. `null` when this attempt has no result yet — never an older
     * attempt's result. See `projectDispatchTaskEvidence` for why null is a real answer. */
    run: RunResult | null;
    writeBackAccepted: boolean;
  };
  const currentExecutions = new Map<string, CurrentExecution>();
  const captureDispatchFacts = (receipt: ReturnType<typeof buildDispatchReceipt>): void => {
    // The per-task resolution is a PURE projection (dispatch-evidence.ts), including the
    // correlated attempt/result pair; this only merges it (last dispatch wins per task).
    const projected = projectDispatchTaskEvidence({
      outcomes: receipt.outcomes.map((e) => ({ taskId: e.taskId, admitted: e.admitted })),
      waiting: receipt.waiting,
      skipped: receipt.skipped.map((sk) => ({ taskId: sk.taskId, code: sk.code, reason: sk.reason })),
      attemptIdsByTask: receipt.attemptIdsByTask,
      executionsByTask: receipt.executionsByTask,
    });
    for (const [taskId, evidence] of projected) {
      currentExecutions.set(taskId, {
        ...evidence,
        attemptIds: [...evidence.attemptIds],
      });
    }
  };

  // The ATOMIC actual execution bundle for the current dispatch: ONE AttemptRecord for the
  // identity, and the run correlated to that very attempt. T3-a.5 keeps them in one value so
  // no consumer can pair attempt B's identity with attempt A's result.
  const currentActualOf = (taskId: string): {
    attemptId: string;
    agentId: string;
    modelId: string | null;
    sessionId: string | null;
    run: RunResult | null;
  } | null => {
    const ce = currentExecutions.get(taskId);
    if (ce?.outcome !== 'started' || ce.attemptId === null) return null;
    const rec = wb.evidence.get(ce.attemptId);
    if (rec == null) return null;
    return {
      attemptId: rec.attemptId,
      agentId: rec.agentId,
      modelId: rec.modelId,
      sessionId: rec.sessionId ?? null,
      run: ce.run,
    };
  };

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
    // T3-a.3: capture the receipt the Decision Loop uses, so the round knows exactly which
    // members started an execution THIS round (and which were refused/pending).
    dispatch: async () => {
      const receipt = await decisionCapabilities.dispatch();
      captureDispatchFacts(receipt);
      return receipt;
    },
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

  /*
   * B4.0b: ACCEPTANCE MATERIAL for `complete`.
   *
   * Built here, once per cycle, ONLY when `--workflow sequential` opted in - every
   * other round sends the byte-identical request it always sent.
   *
   * Three properties are the whole point, so they are enforced by construction:
   *
   *   1. SAME TASK, SAME RUN. `currentActualOf` is the existing correlated pair
   *      (attempt record + the RunResult of THAT attempt). It returns `run: null`
   *      rather than an older attempt's result, so a task with no result reports
   *      `executionMissing` instead of inheriting a previous step's output.
   *   2. AWAITING VERIFICATION ONLY. A material entry exists for a `to_verify` task
   *      and nothing else, so this cannot grow into a context dump of the round.
   *   3. BOUNDED + HONEST. The tail is capped here and `boundedForRequest` says so;
   *      `outputTruncated` carries the runtime's own truncation. A reference
   *      (`transcriptPath`) is given instead of the transcript itself.
   */
  const ACCEPTANCE_OUTPUT_MAX_CHARS = 2000;
  const workflowAcceptanceMaterial = (): AcceptanceMaterial | undefined => {
    if (o.workflow !== 'sequential') return undefined;
    const entries: AcceptanceMaterialEntry[] = [];
    for (const id of (planned?.children.map((c) => c.taskId) ?? [])) {
      const task = wb.store.get(id);
      if (task === null || task.status !== 'to_verify') continue;
      const criteria = task.acceptanceCriteria;
      const actual = currentActualOf(id);
      const run = actual?.run ?? null;
      const bounded = run === null ? '' : run.output.slice(0, ACCEPTANCE_OUTPUT_MAX_CHARS);
      entries.push({
        taskId: id,
        taskType: task.taskType,
        acceptanceCriteria: criteria,
        attemptId: actual?.attemptId ?? null,
        agentId: actual?.agentId ?? null,
        modelId: actual?.modelId ?? null,
        output: bounded,
        outputTruncated: run?.outputTruncated === true || bounded.length < (run?.output.length ?? 0),
        boundedForRequest: run !== null && bounded.length < run.output.length,
        transcriptPath: run?.transcriptPath ?? null,
        artifacts: task.artifacts.map((a) => `${a.name} (${a.kind}) ${a.path}`),
        runState: run?.state ?? null,
        exitCode: run?.exitCode ?? null,
        runError: run?.error === null || run?.error === undefined ? null : { code: run.error.code, message: run.error.message },
        executionMissing: actual === null || run === null,
        acceptanceCriteriaMissing: criteria.trim() === '',
      });
    }
    return { objective: o.objective, entries };
  };

  const runOneCycle = (): Promise<Awaited<ReturnType<typeof runDecisionCycle>>> => {
    // Built ONCE per cycle: the material must describe the same store state the
    // observation this cycle is taken from, not a re-read taken a moment later.
    const acceptanceMaterial = workflowAcceptanceMaterial();
    return runDecisionCycle({
      store: wb.store,
      scheduler,
      provider,
      rootTaskId: rootId,
      instructions:
        'This is the first cycle of a single execution round. Choose the single next action ' +
        'that best advances the stated objective, and give an explicit target wherever the ' +
        'action requires one. Accepting a task with `complete` requires the acceptance ' +
        'material to show its own execution met its own criteria; if that material is ' +
        'missing or does not show that, choose `wait` rather than accepting it.',
      capabilities: handoffCapabilities,
      ...(acceptanceMaterial === undefined ? {} : { acceptanceMaterial }),
    });
  };

  let outcome: Awaited<ReturnType<typeof runDecisionCycle>> = await runOneCycle();
  let workflowCycles = 1;
  let workflowStop: string | null = null;
  if (o.workflow === 'sequential') {
    /*
     * B4.0a: BOUNDED sequential progression. Each cycle applies ONE action — dispatch a
     * ready step, or the EXISTING `complete` action (which goes through
     * `applyVerification`) for a `to_verify` step. The CLI never auto-verifies: a
     * downstream step runs only after LAYA's `complete` reaches the existing verification
     * authority, so a Runtime exit 0 is not treated as acceptance. The loop stops on
     * completion, terminal failure, NO state change, a non-ok cycle, or a hard cycle
     * bound — LAYA is never called unbounded.
     */
    const memberIds = planned.children.map((c) => c.taskId);
    const maxCycles = memberIds.length * 3 + 3;
    const sig = (): string => memberIds.map((id) => wb.store.get(id)?.status ?? 'missing').join(',');
    if (outcome.status !== 'ok') {
      workflowStop = `cycle-${outcome.status}`;
    } else {
      for (;;) {
        const members = memberIds.map((id) => wb.store.get(id));
        if (members.length > 0 && members.every((m) => m?.status === 'succeeded')) { workflowStop = 'all-succeeded'; break; }
        if (members.some((m) => m?.status === 'failed' || m?.status === 'cancelled')) { workflowStop = 'terminal-failure'; break; }
        if (workflowCycles >= maxCycles) { workflowStop = 'cycle-limit'; break; }
        const before = sig();
        outcome = await runOneCycle();
        workflowCycles++;
        if (outcome.status !== 'ok') { workflowStop = `cycle-${outcome.status}`; break; }
        if (sig() === before) { workflowStop = 'no-progress'; break; }
      }
    }
  }

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

  // -------------------------------------------------------------------- T3-b.1
  // The fan-out EXECUTION PHASE: a bounded drain of the requested READ members that
  // Scheduler capacity could not admit yet.
  //
  // WHY THIS EXISTS
  // A width > capacity fan-out parks the surplus members in `TickResult.waiting`. That is a
  // CAPACITY fact (the scheduler emits `waiting` from exactly one place: `free <= 0`), it is
  // not a refusal, and nothing in the round ever came back for those members. Worse, a member
  // that IS refused later keeps its `planned` status on purpose (the refusal deliberately does
  // not touch Task state), so a naive re-tick re-selects it forever and a healthy sibling
  // starves. Both defects are closed here by SCOPE, not by detection.
  //
  // WHY IT LIVES HERE AND NOT IN THE SCHEDULER
  // `Scheduler.tick` stays the sole Dispatch Authority and stays a single decision primitive.
  // The coordinator contributes exactly one thing: which task ids this bounded fan-out
  // execution phase may consider. It does no ordering, no capacity arithmetic, no gating and
  // never calls the orchestrator directly.
  //
  // THE SCOPE IS PER-ITERATION AND NEVER PERSISTED
  // A handoff continuation legitimately re-executes the SAME taskId in a LATER phase
  // (continuation.ts:15-16 - "the same taskId, with a second AttemptRecord appended"). A
  // remembered scope would suppress it, so the allowlist dies with the loop below.
  const fanoutGroups = wb.fanoutProvenance();
  const fanoutMemberByTask = new Map<string, {
    readonly agentId: string; readonly modelId: string; readonly scope: string;
    readonly accessMode: string; readonly memberIndex: number;
  }>();
  for (const group of fanoutGroups) for (const m of group.members) fanoutMemberByTask.set(m.taskId, m);
  const assignedByTask = new Map(assigned.map((a) => [a.taskId, a]));
  const fanoutFactsOf = (taskId: string) => {
    const live = wb.store.get(taskId);
    const assn = assignedByTask.get(taskId);
    const assignmentRefused = assn !== undefined && !assn.ok;
    const ce = currentExecutions.get(taskId);
    const actual = currentActualOf(taskId);
    let execution: 'started' | 'assignment-refused' | 'dispatch-refused' | 'pending';
    if (actual !== null) execution = 'started';
    else if (assignmentRefused) execution = 'assignment-refused';
    else if (ce?.outcome === 'dispatch-refused') execution = 'dispatch-refused';
    else execution = 'pending';
    return {
      taskStatus: live?.status ?? 'missing',
      execution,
      assignment: (assignmentRefused ? 'refused' : 'accepted') as 'accepted' | 'refused',
      assignmentRefusalReason: assignmentRefused ? (assn?.reason ?? null) : null,
      dispatchRefusalCode: execution === 'dispatch-refused' ? (ce?.refusalCode ?? null) : null,
      actual,
    };
  };
  /**
   * The requested members that have NOT yet reached an execution resolution.
   *
   * Derived from the SAME facts the report and the review packet consume
   * (`projectFanoutAggregation` -> `executionSettled`), never from a status heuristic, an
   * attempt count, or a Task.status guess. `executionSettled === true` covers assignment
   * refusal, pre-runtime dispatch refusal, post-runtime write-back refusal and any finished
   * run, which is exactly the T3-a settlement contract.
   */
  const unresolvedFanoutMemberIds = (): string[] => fanoutGroups
    .flatMap((p) => projectFanoutAggregation(p, fanoutFactsOf).members)
    .filter((m) => !m.executionSettled)
    .map((m) => m.taskId);

  const fanoutDrain = {
    iterations: 0,
    progressIterations: 0,
    complete: false,
    fixpoint: false,
    /** The members still unresolved when the loop stopped, for the report. */
    unresolvedAtStop: [] as string[],
  };
  if (fanoutGroups.length > 0) {
    // Defence in depth only: the loop is bounded by strict set shrink, so at most
    // `requestedWidth` iterations can make progress and one more observes the fixpoint.
    const safetyBound = fanoutGroups
      .reduce((n, g) => n + g.members.length, 0) + 1;
    for (;;) {
      const before = unresolvedFanoutMemberIds();
      if (before.length === 0) {
        fanoutDrain.complete = true;
        break;
      }
      if (fanoutDrain.iterations >= safetyBound) {
        // A safety bound must never be the correctness mechanism. Reaching it with unresolved
        // work left is an internal defect, reported as incomplete rather than looped on.
        fanoutDrain.unresolvedAtStop = before;
        break;
      }
      fanoutDrain.iterations += 1;
      // The ONE dispatch edge, scoped to the unresolved members. No scope is remembered.
      const dispatched = await wb.dispatch(undefined, undefined, { taskIds: new Set(before) });
      if (dispatched.tick !== null) {
        captureDispatchFacts(buildDispatchReceipt({
          tick: dispatched.tick,
          dispatchedAt: Date.now(),
          attemptIdsByTask: dispatched.attemptIdsByTask,
          executionsByTask: dispatched.executionsByTask,
        }));
      }
      const after = unresolvedFanoutMemberIds();
      if (after.length === 0) {
        fanoutDrain.complete = true;
        break;
      }
      if (after.length < before.length) {
        // The ONLY correctness progress signal: the requested set strictly shrank.
        // Never `tick.outcomes.length` — a repeated refusal of an unresolved-looking member
        // produces outcomes every tick while nothing progresses, and starved a healthy sibling.
        fanoutDrain.progressIterations += 1;
        continue;
      }
      // No member newly settled: bounded-round fixpoint. Stop the execution phase and let the
      // round report itself incomplete. Do NOT retry, hand off, reassign or replan here.
      fanoutDrain.fixpoint = true;
      fanoutDrain.unresolvedAtStop = after;
      break;
    }
  }

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
          // T3-a.3: the continuation is CURRENT-round execution evidence too.
          if (dispatched.tick !== null) {
            captureDispatchFacts(buildDispatchReceipt({
              tick: dispatched.tick,
              dispatchedAt: Date.now(),
              attemptIdsByTask: dispatched.attemptIdsByTask,
              // T3-a.5: carry the correlated attempt/result pairs, so a continuation that
              // restarted a task still reports the NEW attempt's result, not the old one.
              executionsByTask: dispatched.executionsByTask,
            }));
          }
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
  report.decision = decisionPart;
  report.tasks = tasks;
  // TeamRun T3-a.2: requested-vs-actual fan-out provenance. Three facts, three sources:
  //   REQUESTED  <- Laya's topology record (FanoutProvenance) — never the Planner seed
  //   ASSIGNMENT <- the real assignment outcomes (accepted / refused + reason)
  //   ACTUAL     <- only an execution that actually happened (run/Attempt)
  // TeamRun T3-b.1: `fanoutGroups` / `fanoutFactsOf` are declared with the fan-out EXECUTION
  // PHASE above, because the bounded drain loop needs the same facts. This aggregation is
  // therefore computed AFTER the drain, so `report.fanout` and the Round Completion Guard read
  // the same post-drain reality rather than a pre-drain snapshot.
  if (fanoutGroups.length > 0) {
    report.fanout = fanoutGroups.map((p) => projectFanoutAggregation(p, fanoutFactsOf));
  }

  // ---- TeamRun T3-b.1: Round Completion Guard inputs -----------------------
  // Computed from the SAME post-drain aggregation the report carries, so the report, the review
  // gate and the Human Gate cannot read three different points in time.
  //
  // `allSettled` is the fan-out completion contract: every REQUESTED member reached an execution
  // resolution (a run, or an assignment/dispatch/write-back refusal). It is deliberately NOT
  // `allSucceeded`, `allTerminal` or `dependencySatisfied` — a member that ran and failed is
  // settled and is reviewable.
  const finalFanout = (report.fanout ?? []) as ReadonlyArray<{ allSettled: boolean }>;
  const fanoutAllSettled = fanoutGroups.length === 0 || finalFanout.every((g) => g.allSettled);
  // B4.0a: a sequential workflow is complete only when EVERY member actually reached
  // `succeeded` (i.e. the existing verification accepted it). A member still `planned`
  // (never dispatched), `to_verify` (run but not verified) or missing makes the round
  // INCOMPLETE — running only research must never report the whole workflow as done.
  const workflowMemberIds: string[] = o.workflow === 'sequential' && planned !== undefined
    ? (planned.children as ReadonlyArray<{ taskId: string }>).map((c) => c.taskId)
    : [];
  const workflowPending = workflowMemberIds
    .map((id) => ({ taskId: id, status: wb.store.get(id)?.status ?? 'missing' }))
    .filter((m) => m.status !== 'succeeded');
  const workflowIncomplete = o.workflow === 'sequential' && workflowPending.length > 0;
  const executionIncomplete = (fanoutGroups.length > 0 && !fanoutAllSettled) || workflowIncomplete;

  report.fanoutDrain = {
    iterations: fanoutDrain.iterations,
    progressIterations: fanoutDrain.progressIterations,
    complete: fanoutDrain.complete,
    fixpoint: fanoutDrain.fixpoint,
    unresolvedAtStop: [...fanoutDrain.unresolvedAtStop],
  };
  if (o.workflow === 'sequential') {
    report.workflow = {
      ...(report.workflow as Record<string, unknown>),
      cycles: workflowCycles,
      stop: workflowStop,
      pending: workflowPending,
    };
  }

  // `report.ok` must not contradict the Human Gate. An incomplete execution set is not a failure
  // of anything that ran, but it is NOT a complete round, so it cannot be reported as ok. The
  // two facts are reported separately: `executionIncomplete` says the execution set is
  // unfinished, and `ok` says the round is not complete.
  report.ok = outcome.status === 'ok' && unassigned.length === 0 && !executionIncomplete;
  report.executionIncomplete = executionIncomplete;
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
    // T3-a.3 (§1/§2): a fan-out member's execution facts come ONLY from the CURRENT-round
    // dispatch receipt + AttemptStore. `runResults`/`history` are cumulative and can
    // describe a PREVIOUS execution, so they are NOT consulted for a member that did not
    // start THIS round. Non-fan-out tasks keep their existing derivation (§21).
    const fanMember = fanoutMemberByTask.get(t.taskId);
    const ce = currentExecutions.get(t.taskId);
    // T3-a.4: fan-out execution facts come from the SAME atomic projection the aggregation
    // uses — the current dispatch's AttemptRecord — never the Task binding or a latest-ever
    // run. A Task whose binding moved to a new worker still reports the worker that RAN.
    const fanActual = fanMember === undefined ? null : currentActualOf(t.taskId);
    const fanStarted = fanActual !== null;
    const currentAttemptIds = fanStarted ? ce!.attemptIds : [];
    // T3-a.5: for a fan-out member the result comes from the SAME bundle as the identity —
    // `fanActual.run`, which is the run correlated to `fanActual.attemptId` at the append site.
    // Never `wb.lastRunResult(taskId)`: that is newest-per-task and can return a PREVIOUS
    // attempt's result. Non-fan-out tasks keep their existing derivation (§21).
    const run = fanMember !== undefined
      ? (fanStarted ? fanActual.run : null)
      : (runResults.get(t.taskId) ?? null);
    const history = fanMember !== undefined
      ? currentAttemptIds.map((id) => wb.evidence.get(id)).filter((r): r is NonNullable<typeof r> => r !== null && r !== undefined)
      : wb.evidence.history(t.taskId);
    const lastAttempt = history.length > 0 ? history[history.length - 1]! : undefined;
    const refused = unassigned.find((a) => a.taskId === t.taskId);

    const identityAgentId = fanMember !== undefined
      ? (fanActual?.agentId ?? null)
      : (live.agentId ?? t.agentId ?? null);
    const identityModelId = fanMember !== undefined
      ? (fanActual?.modelId ?? null)
      : (live.modelId ?? t.modelId ?? null);

    const outcome = classifyExecutionOutcome({
      taskId: t.taskId,
      taskStatus: live.status,
      agentId: identityAgentId,
      modelId: identityModelId,
      run,
      // A task the gate refused before dispatch: the refusal CODE is the real reason.
      refusalCode: refused?.code ?? ce?.refusalCode ?? null,
      refusalReason: refused?.reason ?? ce?.refusalReason ?? null,
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
      // T3-a.2: the REQUESTED pair (Laya's) and Assignment's verdict, present only for fan-out
      // members. This is what lets the reviewer distinguish "never executed (refused)" from
      // "executed and failed", and see WHAT was asked for even when nothing ran.
      ...(fanMember === undefined ? {} : {
        requestedAgentId: fanMember.agentId,
        requestedModelId: fanMember.modelId,
        memberIndex: fanMember.memberIndex,
        assignmentStatus: refused === undefined ? 'accepted' as const : 'refused' as const,
        assignmentRefusalReason: refused?.reason ?? null,
      }),
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
  if (executionIncomplete) {
    // TeamRun T3-b.1 — Round Completion Guard. The review is WITHHELD, not failed.
    //
    // The Unified Reviewer is the component that decides whether the round's work is acceptable.
    // Running it over a fan-out whose requested members never all reached an execution resolution
    // would hand the reviewer a packet describing work that does not exist yet, and would let a
    // verdict be recorded for a round that is not finished. Before T3-b.1 the review ran
    // unconditionally (gated only by `--no-review`), so an incomplete round could be reported as
    // reviewed AND as ok at the same time.
    //
    // This is deliberately a DISTINCT status, not `failed` and not `not_requested`:
    //   - `failed`     would be a lie. The reviewer never ran, so it expressed no opinion.
    //   - `not_requested` would be indistinguishable from `--no-review`, hiding a real gap.
    // No verdict, no findings and no packet-derived opinion is synthesised for a skipped review.
    unifiedReview = {
      status: 'execution_incomplete',
      reviewer: o.reviewAgent,
      verdict: null,
      reason: `the fan-out execution set is incomplete (${fanoutDrain.unresolvedAtStop.length} requested member(s) never reached an execution resolution), so no review was run; the round is unfinished rather than reviewed`,
      findings: [],
      recommendations: [],
      outputTail: null,
      code: 'execution-incomplete',
      reviewedAt: null,
    };
  } else if (!o.review) {
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
  // R4 (P1-2): evidence is keyed by ATTEMPT ID, not by task id.
  //
  // The previous code walked `runResults()` — which holds ONE run per task, the latest —
  // and stored it under the task id. Every attempt of that task then received the SAME
  // evidence, so after an A->B handoff the report claimed attempt A wrote the files, ran
  // the tests and produced the transcript that belonged to attempt B.
  //
  // `wb.attemptEvidenceMap()` is populated inside `dispatch()` at the moment the real
  // `RunResult` and the attempt id `AttemptStore` minted for it are both in hand, so each
  // entry is that attempt's own. No re-derivation here, and no guessing which attempt a
  // run belonged to.
  const attemptEvidence: Record<string, TaskEvidenceInput> = wb.attemptEvidenceMap();

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
    evidence: attemptEvidence,
    evidenceNote,
    // TeamRun T3-b.1a: the SAME final execution-completeness fact that set `report.ok` and
    // withheld the Unified Review, so the Human Gate cannot report a round complete that the
    // report and the review already called incomplete. Consumed as a fact — the gate derives
    // nothing and gains no execution authority.
    executionIncomplete,
  });

  // Published for the dashboard to READ. It is a report artifact: a missing or failed
  // write changes nothing about the round, so the failure is reported and then ignored.
  report.roundResult = roundResult;
  report.roundResultReport = renderRoundResult(roundResult);
  const published = publishRoundResult(roundResult, {
    onError: (message) => note(message),
    // B4.0b: absent means the production default is used, unchanged.
    ...(overrides.roundResultDir === undefined ? {} : { dir: overrides.roundResultDir }),
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
  //
  // T2-a.3: observe last, so the snapshot describes the finished, authoritative state.
  notifyWorkbenchSnapshot();
  return report.ok ? 0 : 1;
}

export { USAGE as ROUND_CLI_USAGE };
