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

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';

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
  // B4.5a: the SAME scope-overlap arithmetic the claim book uses, so a RUNTIME retained
  // ResourceClaim is matched against the group's REAL physical workspace/scope — never by
  // owner task id alone and never "any retained claim blocks every group".
  scopesOverlap,
  type ResourceClaim,
  type ResourceScope,
  // B4.5 (P1-2): the SAME path-identity normalisation the workspace lock uses, so a
  // nested `--cwd` is detected regardless of case/separator on any platform.
  normalizeIdentityPath,
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
  type WorkerRef,
} from '../orchestration/continuation.ts';
import { buildHandoff } from '../orchestration/workbench-handoff.ts';
import { WORKFLOW_PLAN_CHOICES, isWorkflowChoice } from '../orchestration/workflow-plan.ts';
// B4.2: the user-adaptable structured plan file, and the ONE shared candidate builder.
import {
  PLAN_FILE_MAX_BYTES,
  buildCollaborationMemberCandidates,
  buildSequentialStepCandidates,
  collaborationTaskIds as planFileCollaborationTaskIds,
  isCollaborationPlan,
  isSequentialPlan,
  parsePlanFile,
  type PlanFile,
  type PlanFileStep,
} from '../orchestration/plan-file.ts';
import {
  COLLABORATION_MAX_MEMBERS,
  COLLABORATION_MIN_MEMBERS,
  COLLABORATION_PLAN_CHOICES,
  collaborationPlanFor,
  isCollaborationChoice,
} from '../orchestration/collab-plan.ts';
// B4.3: the current stage's material + the user-only confirmation rule.
import {
  STAGE_MATERIAL_MAX_BYTES,
  StageMaterialError,
  parseStageMaterial,
  stageBindingDigest,
  stageMaterialEmbed,
  stageMaterialRef,
  type StageMaterial,
} from '../orchestration/stage-material.ts';
import { decideWorkflowPlan, type WorkflowPlanCandidate } from '../decision/plan-choice.ts';
// B3.1: the advisory native-skill choice preset + the bounded user-declared catalogue and
// the ONE honest projection of a native skill-tool observation.
import { decideSkillChoice, type SkillChoiceCandidate } from '../decision/skill-choice.ts';
import {
  SKILL_CATALOG_MAX_BYTES,
  isSkillCatalogError,
  parseSkillCatalog,
  projectSkillReport,
  type SkillCatalog,
  type SkillReportEntry,
} from '../orchestration/skill-catalog.ts';
// B3.2: the advisory native-MCP-tool choice preset + the bounded user-declared catalogue and
// the ONE honest projection of a catalog-name-matched native tool observation.
import { decideMcpChoice, type McpChoiceCandidate } from '../decision/mcp-choice.ts';
import {
  MCP_CATALOG_MAX_BYTES,
  isMcpCatalogError,
  mcpToolIntentLabel,
  parseMcpCatalog,
  projectMcpReport,
  type McpCatalog,
  type McpReportEntry,
  type McpToolTuple,
} from '../orchestration/mcp-catalog.ts';
// B2.1: the bounded user-declared no-additional-charge model pool, its ONE pure
// admission predicate (shared with Assignment and the Spawn Gate), and its reader.
import {
  USER_MODEL_POOL_MAX_BYTES,
  UserModelPoolError,
  admitUserModelPoolPair,
  isUserModelPoolError,
  parseUserModelPoolText,
  type UserModelPool,
} from '../orchestration/model-pool.ts';
import {
  CHECKPOINT_OUTPUT_MAX_CHARS,
  createStdinCheckpointReader,
  parseCheckpointAnswer,
  type WorkflowCheckpointSnapshot,
} from './workflow-checkpoint.ts';
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
  renderRoundDelivery,
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
  --workflow collaborate
                         opt-in collaboration group (B4.1): LAYA picks a bounded 2-3 model
                         division, each member runs its own child task and session, and the
                         designated integrator member runs a separate integration task that
                         consumes every member's delivery. Sequential; PARALLEL_WRITE=CLOSED.
  --workflow-choice <c>  pin the plan: full|lean (with --workflow sequential) or duo|trio
                         (with --workflow collaborate); absent = LAYA picks among the
                         bounded candidates.
  --workflow-plan <file>
                         a JSON file declaring your OWN bounded candidate plans (roles,
                         taskTypes, file scopes, deliverables, dependencies, and the
                         integrator for a collaboration group). Replaces the built-in
                         plans; plan ids are then the valid --workflow-choice values.
                         Requires --workflow sequential|collaborate.
  --skill-catalog <file>
                         opt-in advisory NATIVE SKILL candidates (B3.1). A JSON file
                         {agentId, skills:[{name, description}]} you declare for ONE agent.
                         After Assignment, LAYA may pick AT MOST ONE of these per initially
                         assigned task (or explicitly none); the pick is bound into the
                         task's advisory brief as a REQUEST only. It never reroutes an
                         agent/model and is not an enforceable tool authorization, proof the
                          skill is installed, or a guarantee it loaded. Requires --workflow
                          sequential|collaborate; absent = byte-identical behaviour to before.
  --mcp-catalog <file>
                         opt-in advisory NATIVE MCP tool candidates (B3.2). A JSON file
                         {agentId:"opencode", tools:[{server, tool, description}]} you
                         declare for the ONE agent this version supports. After Assignment,
                         LAYA may pick AT MOST ONE of these per matching initially assigned
                         task (or explicitly none); the pick is bound into the task's advisory
                         brief as a REQUEST only. It never connects/installs/authorizes an MCP
                         server, never reroutes an agent/model, and is not proof the tool
                         exists, is MCP, or ran. Requires --workflow sequential|collaborate;
                         absent = byte-identical behaviour to before.
  --model-pool <file>
                         opt-in USER-DECLARED model pool (B2.1). A JSON file
                         {policy:"no-additional-charge", models:[{agentId, modelId,
                         billing:"free"|"included"|"paid"|"unknown", source, observedAt,
                         expiresAt}]} you declare. Around every initially selected task the
                         pool is the ONLY thing offered and enforced: a pair not declared, or
                         expired, or future-dated, or paid/unknown, is refused (never
                         substituted). The declaration is YOUR statement with provenance and
                         an expiry — it is NOT verified free entitlement, pricing or account
                         eligibility, and it authorizes NO paid use (paid stays refused).
                         It constrains only the orchestrator-managed runs of THIS round; it
                         does not constrain a native agent's own internal/auxiliary calls,
                         the reviewer, or any model the orchestrator did not select, and it
                         never promises the whole workflow is free. Requires --workflow
                         sequential|collaborate; cannot combine with --classify-only;
                         absent = byte-identical behaviour to before.
  --stage <file>         opt-in stage gate (B4.3): a JSON file describing the CURRENT
                         stage's material — stageId, scope, requirement, acceptance, and an
                         optional planRef. REQUIRES --workflow sequential|collaborate, because
                         the confirmation binds the plan that actually runs and the legacy
                         shape-based plan cannot be bound. The round REFUSES to start (no
                         tasks, no model call) unless the material is present AND the user
                         confirms it with --confirm <digest>. The material file cannot approve
                         itself.
  --confirm <digest>     the user's confirmation, bound to the stage material. It is the
                         material's digest (shown by --stage-check, and by the refusal
                         message). A changed stage/scope/requirement/acceptance invalidates
                         it. This is a deliberate LOCAL user act, not identity or auth.
  --stage-check          with --stage: validate the material and print its status + digest
                         (and the exact --confirm value) WITHOUT creating or running
                         anything, then stop.
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
  --checkpoint           OPT-IN single-step USER checkpoint (B4.6a/B4.6b). Requires --workflow
                         sequential|collaborate. After each member really runs, and before it
                         is handed to LAYA's 'complete'/downstream dispatch, the round shows
                         that task's OWN attempt (role, criteria, bounded output, attemptId,
                         session, requested pair, tree-stop fact) on stderr and asks you to
                         'continue', 'stop <reason>' or 'accept <reason>'.
                         'continue' only lets the EXISTING verification and scheduling proceed -
                         it sets no success and skips no fixed/model-pool/stage/resource gate.
                         'stop' records the reason, leaves the task in to_verify and starts
                         nothing further. 'accept <reason>' is YOUR explicit verdict that the
                         DISPLAYED task is done: it is applied through the existing verification
                         authority (never a direct write), after re-reading the live task and its
                         atomic current attempt so a changed status/attempt/worker/stop fact is
                         refused. It is NOT a LAYA decision, an independent review, or proof a
                         test passed or an artifact exists. Non-TTY / EOF / error / invalid
                         answer / 60s timeout all STOP. No supervisor model is called.
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
  /** B4.0/B4.1: pin a single plan choice; absent = LAYA picks among the bounded candidates. */
  workflowChoice?: string;
  /** B4.2: a structured plan file whose bounded plans replace the built-in ones. */
  workflowPlan?: string;
  /** B3.1: opt-in, user-declared skill CANDIDATES for ONE agent (`--skill-catalog`). */
  skillCatalog?: string;
  /** B3.2: opt-in, user-declared native MCP tool CANDIDATES for ONE agent (`--mcp-catalog`). */
  mcpCatalog?: string;
  /** B2.1: opt-in, user-declared no-additional-charge model pool (`--model-pool`). */
  modelPool?: string;
  /** B4.3: the current stage's material file (opt-in stage gate). */
  stage?: string;
  /** B4.3: the user's confirmation, bound to the stage material's digest. */
  confirm?: string;
  /** B4.3: validate + report the stage material (and its digest), then stop. */
  stageCheck?: boolean;
  /**
   * B4.6a: opt-in single-step USER checkpoint (`--checkpoint`). Only meaningful with
   * `--workflow sequential|collaborate`; the parser refuses every other combination
   * before any task exists. Absent = byte-identical behaviour to before.
   */
  checkpoint?: boolean;
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

/**
 * B4.6a: extract a human-readable message from ANY thrown value.
 *
 * The checkpoint input seam (and, in principle, any injected reader) may throw a
 * NON-Error: a bare string, `null`, `undefined` or a plain object. The obvious
 * `(e as Error).message` throws a TypeError on `null`/`undefined`, which would turn a
 * fail-closed STOP into a crashed round. This is total: it never throws.
 */
function thrownMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (e === null || e === undefined) return String(e);
  try { return JSON.stringify(e); } catch { return typeof e; }
}

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
    if (flags.workflow === true) return { error: '--workflow requires a value: "sequential" or "collaborate"' };
    if (workflow !== undefined && workflow !== 'sequential' && workflow !== 'collaborate') {
      return { error: `--workflow must be "sequential" or "collaborate" (got "${workflow}")` };
    }
    const workflowChoice = s('workflow-choice');
    if (flags['workflow-choice'] === true) return { error: '--workflow-choice requires a value' };
    // B4.2: a structured plan file. Its plan ids are unknown until the file is read, so a
    // pinned `--workflow-choice` is only shape-checked here and validated against the file
    // later; without a plan file the built-in choice space is enforced exactly as before.
    const workflowPlan = s('workflow-plan');
    if (flags['workflow-plan'] === true) return { error: '--workflow-plan requires a file path' };
    if (workflowPlan !== undefined && workflow === undefined) {
      return { error: '--workflow-plan requires --workflow sequential or --workflow collaborate' };
    }
    // B3.1: the advisory skill catalogue is only meaningful where the initial Assignment
    // path runs. The legacy shape-based plan and `--classify-only` have no initially
    // assigned task to choose for, so the combination is a usage error raised HERE, before
    // any file read, provider call or task write.
    const skillCatalog = s('skill-catalog');
    if (flags['skill-catalog'] === true) return { error: '--skill-catalog requires a file path' };
    if (skillCatalog !== undefined && workflow !== 'sequential' && workflow !== 'collaborate') {
      return { error: '--skill-catalog requires --workflow sequential or --workflow collaborate' };
    }
    if (skillCatalog !== undefined && flags['classify-only'] === true) {
      return { error: '--skill-catalog cannot be combined with --classify-only' };
    }
    // B3.2: the advisory MCP catalogue is only meaningful where the initial Assignment path
    // runs, exactly like the skill catalogue. The same combinations are usage errors raised
    // HERE, before any file read, provider call or task write.
    const mcpCatalog = s('mcp-catalog');
    if (flags['mcp-catalog'] === true) return { error: '--mcp-catalog requires a file path' };
    if (mcpCatalog !== undefined && workflow !== 'sequential' && workflow !== 'collaborate') {
      return { error: '--mcp-catalog requires --workflow sequential or --workflow collaborate' };
    }
    if (mcpCatalog !== undefined && flags['classify-only'] === true) {
      return { error: '--mcp-catalog cannot be combined with --classify-only' };
    }
    // B2.1: the user-declared model pool is only meaningful where the initial Assignment
    // path runs. The legacy shape-based plan and `--classify-only` have no initially
    // assigned task, so the combination is a usage error raised HERE — before any file
    // read, provider call, quota probe or task write. A bare flag is likewise a usage error.
    const modelPool = s('model-pool');
    if (flags['model-pool'] === true) return { error: '--model-pool requires a file path' };
    if (modelPool !== undefined && workflow !== 'sequential' && workflow !== 'collaborate') {
      return { error: '--model-pool requires --workflow sequential or --workflow collaborate' };
    }
    if (modelPool !== undefined && flags['classify-only'] === true) {
      return { error: '--model-pool cannot be combined with --classify-only' };
    }
    // B4.1: the answer space is the MODE's own bounded list, so `--workflow-choice duo`
    // with `--workflow sequential` is a usage error rather than a silent fallback.
    const choiceSpace = workflow === 'collaborate'
      ? { ok: isCollaborationChoice, known: 'duo, trio' }
      : { ok: isWorkflowChoice, known: 'full, lean' };
    if (workflowPlan === undefined && workflowChoice !== undefined && !choiceSpace.ok(workflowChoice)) {
      return { error: `--workflow-choice must be one of ${choiceSpace.known} for --workflow ${String(workflow)} (got "${workflowChoice}")` };
    }
    if (workflowChoice !== undefined && workflow === undefined) {
      return { error: '--workflow-choice requires --workflow sequential or --workflow collaborate' };
    }
    // B4.3: the opt-in stage gate. Material + confirmation are validated later (the file
    // must be read first), but the flag SHAPE is a usage error here so nothing starts.
    const stage = s('stage');
    if (flags.stage === true) return { error: '--stage requires a file path' };
    const confirm = s('confirm');
    if (flags.confirm === true) return { error: '--confirm requires a value: the material digest' };
    const stageCheck = flags['stage-check'] === true;
    if (confirm !== undefined && stage === undefined) {
      return { error: '--confirm requires --stage <file>: a confirmation is bound to a material, and there is none' };
    }
    if (stageCheck && stage === undefined) {
      return { error: '--stage-check requires --stage <file>' };
    }
    // B4.6a: the opt-in single-step USER checkpoint only makes sense where the bounded
    // workflow loop actually runs. The legacy path has no workflow members, and
    // `--classify-only` / `--stage-check` never reach the loop, so every other
    // combination is a usage error raised HERE - before any file read, provider call,
    // quota probe or task write.
    // B4.6a: `--checkpoint` is a BARE boolean flag and accepts NO value. Both
    // `--checkpoint=true` (the `=` form) and `--checkpoint true` (the space form) parse to
    // a STRING here, so the old `flags.checkpoint === true` test silently read them as
    // "off" — the user explicitly asked for supervision and got an unsupervised run
    // instead. A value form is therefore a usage error raised HERE, before any file read,
    // provider call, quota probe or task write; it must never be silently ignored. This
    // does NOT extend the accepted syntax: a bare `--checkpoint` is the only accepted form.
    if (flags.checkpoint !== undefined && flags.checkpoint !== true) {
      return { error: `--checkpoint takes no value: use the bare flag --checkpoint (got "${String(flags.checkpoint)}")` };
    }
    const checkpoint = flags.checkpoint === true;
    if (checkpoint && workflow !== 'sequential' && workflow !== 'collaborate') {
      return { error: '--checkpoint requires --workflow sequential or --workflow collaborate' };
    }
    if (checkpoint && flags['classify-only'] === true) {
      return { error: '--checkpoint cannot be combined with --classify-only' };
    }
    if (checkpoint && stageCheck) {
      return { error: '--checkpoint cannot be combined with --stage-check: nothing is executed to checkpoint' };
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
      ...(workflowPlan !== undefined ? { workflowPlan } : {}),
      ...(skillCatalog !== undefined ? { skillCatalog } : {}),
      ...(mcpCatalog !== undefined ? { mcpCatalog } : {}),
      ...(modelPool !== undefined ? { modelPool } : {}),
      ...(stage !== undefined ? { stage } : {}),
      ...(confirm !== undefined ? { confirm } : {}),
      ...(stageCheck ? { stageCheck } : {}),
      ...(checkpoint ? { checkpoint } : {}),
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
  /**
   * B4.6a/B4.6b: an OPT-IN USER-INPUT seam for the workflow checkpoint.
   *
   * It receives a detached, frozen snapshot of plain values - never the Workbench, a
   * store, a registry, an assignment, a runtime or any callable - and returns the
   * user's RAW answer, which the CLI validates through `parseCheckpointAnswer`. A typed
   * return is NOT trusted: a non-string, a wrong word or an empty line fails closed to a
   * STOP. Absent, the production terminal reader is used. It is only ever called when
   * `--checkpoint` was given, so a round without the flag reads no input and adds no
   * report field.
   *
   * The seam itself is still READ-ONLY: it cannot reach an authority, and its return is
   * only a raw string. It is the CLI's gate - not this callback - that decides whether
   * the answer is understood, re-reads the live task/attempt, and (for `accept`) applies
   * the verdict through `wb.completeTask`. A callback cannot accept anything by claiming
   * to; a changed/absent live fact is refused regardless of what it returns.
   */
  readonly checkpointInput?: (snapshot: WorkflowCheckpointSnapshot) => string | Promise<string>;
}

/**
 * B4.3a (P1-1): a NORMALIZED, plain-data projection of the plan(s) a round may run.
 *
 * It is the CONTENT that a stage confirmation binds — roles, task types, file scopes,
 * deliverables, dependencies and integration responsibility — not a file name or a plan id.
 * A plan whose id stays the same but whose deliverable changes therefore produces a
 * different scope and invalidates an old confirmation. Built-ins and plan files are
 * projected into the SAME shape, so a user plan and a built-in cannot be confused.
 *
 * It is derived from the ALREADY-TYPED plan modules (`WORKFLOW_PLAN_CHOICES`,
 * `COLLABORATION_PLAN_CHOICES`, `parsePlanFile`), so there is no second plan parser and no
 * re-parse of the file after it is frozen.
 */
export function normalizedPlanScope(mode: string | undefined, planFile: PlanFile | null): unknown {
  const stepScope = (s: { role: string; taskType: string; fileScope?: string; deliverable: string; dependencies?: readonly string[] }) => ({
    role: s.role, taskType: s.taskType, fileScope: s.fileScope ?? null,
    deliverable: s.deliverable, dependencies: [...(s.dependencies ?? [])],
  });
  if (mode === 'sequential') {
    return planFile !== null
      ? planFile.plans.filter(isSequentialPlan).map((p) => ({ id: p.id, label: p.label, steps: p.steps.map(stepScope) }))
      : WORKFLOW_PLAN_CHOICES.map((c) => ({ id: c.choice, label: c.label, steps: c.steps.map((s) => stepScope({ role: s.role, taskType: s.taskType, deliverable: s.deliverable })) }));
  }
  if (mode === 'collaborate') {
    return planFile !== null
      ? planFile.plans.filter(isCollaborationPlan).map((p) => ({ id: p.id, label: p.label, integratorMember: p.integratorMember, members: p.members.map(stepScope) }))
      : COLLABORATION_PLAN_CHOICES.map((c) => ({ id: c.choice, label: c.label, integratorMember: c.integratorMember, members: c.members.map((m) => stepScope({ role: m.role, taskType: m.taskType, fileScope: m.fileScope, deliverable: m.deliverable })) }));
  }
  // The legacy (shape-based) path has no explicit plan; the objective + workflow still bind.
  return null;
}

/** The plan ids a stage's `planRef` may name for the effective plan source. */
function offeredPlanIds(mode: string | undefined, planFile: PlanFile | null): readonly string[] {
  if (mode === 'sequential') return planFile !== null ? planFile.plans.filter(isSequentialPlan).map((p) => p.id) : WORKFLOW_PLAN_CHOICES.map((c) => c.choice);
  if (mode === 'collaborate') return planFile !== null ? planFile.plans.filter(isCollaborationPlan).map((p) => p.id) : COLLABORATION_PLAN_CHOICES.map((c) => c.choice);
  return [];
}

/**
 * Read + validate a plan file. The ONE reader, used both by the stage gate (so the
 * confirmation binds the ACTUAL plan) and by the plan block (so the file is not re-read
 * between the two — a confirmation must not cover a file that then changes on disk).
 */
function readPlanFileForRound(cwd: string, workflowPlan: string, workflow: string | undefined): PlanFile {
  const planPath = resolve(cwd, workflowPlan);
  if (!existsSync(planPath) || !statSync(planPath).isFile()) {
    throw new Error(`--workflow-plan "${workflowPlan}" is not a readable file (resolved to "${planPath}")`);
  }
  const size = statSync(planPath).size;
  if (size > PLAN_FILE_MAX_BYTES) {
    throw new Error(`--workflow-plan "${workflowPlan}" is ${size} bytes, over the ${PLAN_FILE_MAX_BYTES} byte limit`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(planPath, 'utf8'));
  } catch (e) {
    throw new Error(`--workflow-plan "${workflowPlan}" is not valid JSON: ${(e as Error).message}`);
  }
  const planFile = parsePlanFile(raw);
  if (planFile.kind !== workflow) {
    throw new Error(`--workflow-plan declares kind "${planFile.kind}" but --workflow is "${String(workflow)}"; they must match`);
  }
  return planFile;
}

/**
 * Read + validate the B3.1 skill catalogue. The ONE reader, run ONCE before any external
 * call or task write; a missing, unreadable, oversized or malformed file is a clear refusal
 * (never a silent empty catalogue).
 */
function readSkillCatalogForRound(cwd: string, file: string): SkillCatalog {
  const path = resolve(cwd, file);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`--skill-catalog "${file}" is not a readable file (resolved to "${path}")`);
  }
  const size = statSync(path).size;
  if (size > SKILL_CATALOG_MAX_BYTES) {
    throw new Error(`--skill-catalog "${file}" is ${size} bytes, over the ${SKILL_CATALOG_MAX_BYTES} byte limit`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`--skill-catalog "${file}" is not valid JSON: ${(e as Error).message}`);
  }
  return parseSkillCatalog(raw);
}

/**
 * Read + validate the B3.2 MCP catalogue. The ONE reader, run ONCE before any external call
 * or task write; a missing, unreadable, oversized or malformed file is a clear refusal (never
 * a silent empty catalogue). It connects to nothing.
 */
function readMcpCatalogForRound(cwd: string, file: string): McpCatalog {
  const path = resolve(cwd, file);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`--mcp-catalog "${file}" is not a readable file (resolved to "${path}")`);
  }
  const size = statSync(path).size;
  if (size > MCP_CATALOG_MAX_BYTES) {
    throw new Error(`--mcp-catalog "${file}" is ${size} bytes, over the ${MCP_CATALOG_MAX_BYTES} byte limit`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`--mcp-catalog "${file}" is not valid JSON: ${(e as Error).message}`);
  }
  return parseMcpCatalog(raw);
}

/**
 * B2.1: read + validate the user-declared model pool. The ONE reader, run ONCE before
 * the stage gate, before the provider is configured, and before any quota probe,
 * classification or task write. A missing / unreadable / oversized / malformed file is
 * a clear refusal (never a silent empty pool). The returned pool is frozen.
 */
function readUserModelPoolForRound(cwd: string, file: string): UserModelPool {
  const path = resolve(cwd, file);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new UserModelPoolError('user-pool-file-unreadable', `--model-pool "${file}" is not a readable file (resolved to "${path}")`);
  }
  const size = statSync(path).size;
  if (size > USER_MODEL_POOL_MAX_BYTES) {
    throw new UserModelPoolError('user-pool-raw-too-large', `--model-pool "${file}" is ${size} bytes, over the ${USER_MODEL_POOL_MAX_BYTES} byte limit`);
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new UserModelPoolError('user-pool-file-unreadable', `--model-pool "${file}" could not be read: ${(e as Error).message}`);
  }
  const parsed = parseUserModelPoolText(text);
  if (!parsed.ok) throw new UserModelPoolError(parsed.code, parsed.detail);
  return parsed.pool;
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

  /*
   * B3.1: the OPT-IN skill catalogue is read + validated ONCE here, before the stage gate,
   * before the provider is configured, before any quota probe, classification or task. A
   * missing / unreadable / oversized / malformed file is a clear refusal (exit 2) and
   * creates nothing and calls nothing.
   */
  let skillCatalog: SkillCatalog | null = null;
  if (o.skillCatalog !== undefined) {
    try {
      skillCatalog = readSkillCatalogForRound(o.cwd, o.skillCatalog);
    } catch (e) {
      const detail = isSkillCatalogError(e) ? `[${e.code}] ${e.detail}` : (e as Error).message;
      if (o.json) w(JSON.stringify({ ok: false, stage: 'skill-catalog', error: detail }, null, 2));
      else {
        note(`skill catalog refused: ${detail}`);
        note('nothing was created or run.');
      }
      return 2;
    }
  }

  /*
   * B3.2: the OPT-IN MCP catalogue is read + validated ONCE here, alongside the skill
   * catalogue, before the stage gate, before the provider is configured, before any quota
   * probe, classification or task. A missing / unreadable / oversized / malformed file is a
   * clear refusal (exit 2); nothing is created, called or connected.
   */
  let mcpCatalog: McpCatalog | null = null;
  if (o.mcpCatalog !== undefined) {
    try {
      mcpCatalog = readMcpCatalogForRound(o.cwd, o.mcpCatalog);
    } catch (e) {
      const detail = isMcpCatalogError(e) ? `[${e.code}] ${e.detail}` : (e as Error).message;
      if (o.json) w(JSON.stringify({ ok: false, stage: 'mcp-catalog', error: detail }, null, 2));
      else {
        note(`mcp catalog refused: ${detail}`);
        note('nothing was created or run.');
      }
      return 2;
    }
  }

  /*
   * B2.1: the OPT-IN user-declared model pool is read + validated ONCE here, alongside
   * the skill / MCP catalogues, before the stage gate, the provider, any quota probe,
   * classification or task. A missing / unreadable / oversized / malformed file is a
   * clear refusal (exit 2); nothing is created, called or connected. Reading it here
   * (before the provider) is what makes a bad file cost ZERO external calls.
   */
  let modelPool: UserModelPool | null = null;
  if (o.modelPool !== undefined) {
    try {
      modelPool = readUserModelPoolForRound(o.cwd, o.modelPool);
    } catch (e) {
      const detail = isUserModelPoolError(e) ? `[${e.code}] ${e.detail}` : (e as Error).message;
      if (o.json) w(JSON.stringify({ ok: false, stage: 'model-pool', error: detail }, null, 2));
      else {
        note(`model pool refused: ${detail}`);
        note('nothing was created or run.');
      }
      return 2;
    }
  }

  /*
   * B4.3/B4.3a: the OPT-IN stage gate. It is purely LOCAL — files plus a flag — and it runs
   * BEFORE the quota probes, before LAYA classification and before any task exists, so a
   * missing or unconfirmed stage costs NO external call and creates NOTHING.
   *
   * The material is DATA and cannot approve itself (see `parseStageMaterial`); approval is
   * the user's own `--confirm <digest>`, BOUND to the material AND to the plan that will
   * actually run (see `stageBindingDigest`). That is a deliberate LOCAL act, not identity or
   * authentication, and it does not constrain a native agent's own internal actions — it only
   * decides whether THIS entry starts the stage at all.
   */
  let stage: { material: StageMaterial; digest: string; ref: string; context: string } | null = null;
  // B4.3a: the plan file is read + FROZEN here (once) when a stage is confirmed, so the
  // confirmation covers the ACTUAL plan and the plan block below cannot see a different file.
  let frozenPlanFile: PlanFile | null = null;
  let planFileFrozen = false;
  if (o.stage !== undefined) {
    const stagePath = resolve(o.cwd, o.stage);
    const refuse = (error: string, pending: readonly string[]): number => {
      if (o.json) w(JSON.stringify({ ok: false, stage: 'stage-gate', error, pending }, null, 2));
      else {
        note(`stage gate refused: ${error}`);
        for (const p of pending) note(`  - ${p}`);
      }
      return 2;
    };
    // B4.3a: --stage requires an explicit supported --workflow because the legacy plan is
    // chosen after confirmation and cannot yet be bound.
    if (o.workflow !== 'sequential' && o.workflow !== 'collaborate') {
      return refuse(
        `--stage requires --workflow sequential or --workflow collaborate (got ${o.workflow === undefined ? 'none' : `"${o.workflow}"`}); a stage confirmation binds the plan that actually runs, and the legacy plan is not bound`,
        ['re-run with --workflow sequential or --workflow collaborate'],
      );
    }
    if (!existsSync(stagePath) || !statSync(stagePath).isFile()) {
      return refuse(`--stage "${o.stage}" is not a readable file (resolved to "${stagePath}")`, ['provide an existing stage material file']);
    }
    const size = statSync(stagePath).size;
    if (size > STAGE_MATERIAL_MAX_BYTES) {
      return refuse(`--stage "${o.stage}" is ${size} bytes, over the ${STAGE_MATERIAL_MAX_BYTES} byte limit`, ['shrink the material or split it']);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(stagePath, 'utf8'));
    } catch (e) {
      return refuse(`--stage "${o.stage}" is not valid JSON: ${(e as Error).message}`, ['fix the JSON']);
    }
    let material: StageMaterial;
    try {
      material = parseStageMaterial(raw);
    } catch (e) {
      const detail = e instanceof StageMaterialError ? `${e.code}: ${e.detail}` : (e as Error).message;
      return refuse(detail, ['fix the material; a material file cannot approve itself']);
    }
    // Freeze the ACTUAL plan (if any) before binding the confirmation to it.
    if (o.workflowPlan !== undefined) {
      try {
        frozenPlanFile = readPlanFileForRound(o.cwd, o.workflowPlan, o.workflow);
        planFileFrozen = true;
      } catch (e) {
        return refuse((e as Error).message, ['fix the plan file; a stage confirmation must cover the plan it runs']);
      }
    } else {
      planFileFrozen = true; // frozen as "no plan file" — the built-in candidates apply
    }
    // The material must be deliverable IN FULL into the brief/acceptance. A material too
    // large to embed is refused HERE, before any write — never silently truncated.
    let context: string;
    const ref = stageMaterialRef(material, o.stage);
    try {
      context = stageMaterialEmbed(material, ref);
    } catch (e) {
      const detail = e instanceof StageMaterialError ? `${e.code}: ${e.detail}` : (e as Error).message;
      return refuse(detail, ['shorten the material or split the stage; long-material delivery is not supported yet']);
    }
    // planRef must name the EFFECTIVE plan: an offered plan id, or the plan file itself.
    const planRef = material.planRef ?? null;
    if (planRef !== null) {
      const ids = offeredPlanIds(o.workflow, frozenPlanFile);
      const matchesId = ids.includes(planRef);
      const matchesFile = o.workflowPlan !== undefined && (planRef === o.workflowPlan || planRef === basename(o.workflowPlan));
      if (!matchesId && !matchesFile) {
        return refuse(`the material's planRef "${planRef}" does not match the effective plan`, [
          `offered plan ids: [${ids.join(', ')}]`,
          ...(o.workflowPlan === undefined ? [] : [`or the plan file "${o.workflowPlan}"`]),
        ]);
      }
    }
    // The confirmation binds the material AND the actual objective / workflow / plan content.
    const digest = stageBindingDigest({
      material,
      objective: o.objective,
      workflow: o.workflow ?? 'legacy',
      planRef,
      planScope: normalizedPlanScope(o.workflow, frozenPlanFile),
    });
    const confirmHint = `--confirm ${digest}`;
    const planSummary = {
      workflow: o.workflow ?? 'legacy',
      planFile: o.workflowPlan ?? null,
      offeredPlanIds: offeredPlanIds(o.workflow, frozenPlanFile),
      planRef,
    };
    if (o.stageCheck === true) {
      if (o.json) {
        w(JSON.stringify({ ok: true, stage: 'stage-check', stageId: material.stageId, digest, ref, plan: planSummary, pending: [`to run this stage, pass ${confirmHint}`] }, null, 2));
      } else {
        w(`stage material OK: ${material.stageId} (${ref})`);
        w(`  plan          ${planSummary.workflow}; file=${planSummary.planFile ?? '(built-in)'}; ids=[${planSummary.offeredPlanIds.join(', ')}]; planRef=${planSummary.planRef ?? '(none)'}`);
        w(`  confirm with: ${confirmHint}`);
        w('  nothing was created or run');
      }
      return 0;
    }
    if (o.confirm === undefined) {
      return refuse('the stage material is present but NOT confirmed by the user', [
        `run again with ${confirmHint} (a material file, a model, or memory cannot approve it)`,
      ]);
    }
    if (o.confirm !== digest) {
      return refuse('the confirmation does not match this material AND plan', [
        `the material is stage "${material.stageId}"; re-confirm with ${confirmHint}`,
        'a changed stage/scope/requirement/acceptance/planRef, a changed plan (id or content), or a changed objective/workflow invalidates an old confirmation',
      ]);
    }
    stage = { material, digest, ref, context };
  }
  // The objective that ACTUALLY reaches classification, the plan and every task's
  // acceptance criteria / brief. Without a confirmed stage it is the user's own text,
  // byte-identical to before this entry existed.
  const roundObjective = stage === null ? o.objective : `${o.objective}\n${stage.context}`;

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
  // B2.2: an explicit `--model-pool` is threaded into the SAME `seedRegistry` the normal
  // round uses, so its admitted user-declared (Agent x Model) pairs become exact
  // declaration-only registry candidates (honest provenance, availability `unknown`).
  // Absent, the options object is byte-identical to before.
  const registry: ModelRegistry = seedRegistry(
    {
      store: runtime.store,
      configs,
      descriptors,
      ...(modelPool !== null ? { userModelPool: modelPool } : {}),
    },
    probes,
    now,
  );
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
    classification = await classifyTask(provider, { task: roundObjective });
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
    // B2.1: the FROZEN user pool is carried on the gate sources, so the SAME value is
    // re-evaluated at the REAL dispatch time (buildSpawnGateInput uses `Date.now()`),
    // not just at assignment. Absent, the field is not added at all.
    ...(modelPool !== null ? { userModelPool: modelPool } : {}),
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

  /*
   * B4.5: the collaboration group's PHYSICAL workspace owner.
   *
   * Declared here because the Orchestrator resolvers below are built before the planner
   * knows the group's shape. Execution happens AFTER planning, so by the time a member
   * dispatches these holders are set; a legacy / sequential round leaves them null and
   * every resolver is a no-op that preserves the previous behaviour exactly.
   *
   * Only a git project has a physical worktree to share, so `groupOwnerFor` is a no-op
   * when `workspace === null` — a non-git collaborate round is byte-identical to before.
   */
  let collaborationGroupIds: ReadonlySet<string> | null = null;
  let collaborationGroupOwner: string | null = null;
  const groupOwnerFor = (taskId: string): string | null =>
    workspace !== null && collaborationGroupIds !== null && collaborationGroupIds.has(taskId)
      ? collaborationGroupOwner
      : null;

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
    // B4.5: a collaboration group's tasks share ONE physical worktree, owned by the
    // round's root task. Each member still keeps its own task / session / pair; only
    // the directory is shared. A non-group task resolves to null and is unchanged.
    workspaceOwner: (task) => groupOwnerFor(task.taskId),
    workspaceMode: (task) => {
      // No workspace manager configured (not a git repo): every task runs in the
      // caller's cwd, which is exactly the pre-R2-1 behaviour and is reported.
      if (workspace === null) return 'none';
      // B4.5: a group task ALWAYS gets the group's isolated worktree — never the
      // user's checkout — so every member, and the integrator that reads them, see
      // the SAME physical bytes. A read-only member would otherwise be handed the
      // main tree by the share rule below.
      if (groupOwnerFor(task.taskId) !== null) return 'isolated';
      const parallel = hasParallelSibling(task.taskId);
      return WorkspaceManager.mayShareWorkspace(claimModeFor(task.taskType), parallel) ? 'shared' : 'isolated';
    },
    // What each task claims. Whole-workspace scope on purpose: a task that says "I
    // write here" must conflict with every other writer here without having to
    // predict which files it will touch.
    resourceClaims: (task) => {
      // B4.5: a group task claims the SHARED owner workspace, so the existing
      // stop-unconfirmed retained claim on that ONE physical resource blocks a later
      // member (read included) exactly as it blocks any other writer. Handing each
      // member its own workspaceId would let it bypass that retention.
      const owner = groupOwnerFor(task.taskId);
      return {
        mode: claimModeFor(task.taskType),
        // The scope names the task's own workspace (or the group's shared owner), so
        // two isolated writers are two different resources and do not contend
        // (R2-1.1 P1-a). The root lets a path claim be tested for containment; the
        // ORCHESTRATOR refines it to the prepared workspace's real cwd before comparing.
        scope: normalizeScopeForWorkspace(`task:${owner ?? task.taskId}`, o.cwd),
      };
    },
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
    // B2.1: the SAME frozen user pool drives the initial candidate question and the
    // Assignment intersection. Absent, the workbench is byte-identical to before.
    ...(modelPool !== null ? { modelPool } : {}),
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
    objective: roundObjective,
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
      // B4.5 (P2): a collaboration group never gets per-writing-task worktrees, so it must
      // not be described that way even before the group's report block runs. The group's real
      // handle (owner/path/branch) is filled in below once execution has happened; this value
      // is overwritten there and, on a pre-execution refusal, stays path-agnostic and claims
      // no directory.
      isolation: workspace === null
        ? 'unavailable (not a git repository)'
        : (o.workflow === 'collaborate'
          ? 'one shared git worktree for the collaboration group; the user checkout is never the cwd'
          : 'git worktree per writing task'),
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
  // B4.2: the id is a plain string because a plan file can name its own plan ids.
  let workflowChoiceUsed: string | null = null;
  let workflowPlanSource = '';
  /** The chosen sequential plan's steps, kept so the report renders the REAL plan. */
  let sequentialSteps: readonly PlanFileStep[] = [];
  // B4.1: the collaboration group's shape, kept for the pair step and the report.
  let collaborationIds: { memberIds: readonly string[]; integratorId: string; integratorIndex: number } | null = null;
  let collaborationPlanUsed: string | null = null;
  /** The chosen collaboration plan's members + integrator, for the pair step and report. */
  let collaborationMembers: readonly PlanFileStep[] = [];
  let collaborationIntegratorMember = 0;
  /**
   * B4.5 (P2): the ONE description of the group's physical workspace, built from the real
   * WorkspaceManager handle. Reused by the top-level `report.workspace`, the review's resource
   * signals and the non-JSON output, so they cannot drift from `report.collaboration.workspace`.
   * `null` until a collaboration group's report block runs.
   */
  let collaborationWorkspaceDescription: string | null = null;
  try {
    /*
     * B4.2: read + validate the structured plan file BEFORE anything is planned. A missing,
     * oversized, malformed or wrong-kind file is a REFUSAL with a reason — never a silent
     * fallback to a built-in plan, and never a partial write. The file names no task ids and
     * no agents/models; it only describes bounded candidate plans.
     *
     * B4.3a: when a stage was confirmed, the file was already read and FROZEN by the gate, and
     * this block REUSES that exact object — so the plan a confirmation covered and the plan
     * that actually runs cannot differ (no re-read between the gate and here).
     */
    let planFile: PlanFile | null = null;
    if (planFileFrozen) {
      planFile = frozenPlanFile;
    } else if (o.workflowPlan !== undefined) {
      planFile = readPlanFileForRound(o.cwd, o.workflowPlan, o.workflow);
    }

    /*
     * The ONE choice rule, shared by every plan source: a pinned id is used only if it was
     * actually offered; a single candidate is recorded WITHOUT asking LAYA (a one-option
     * question carries no information and the real provider refuses it); otherwise LAYA
     * chooses among the offered plans. It never invents a plan and never falls back.
     */
    const choosePlan = async (choices: readonly WorkflowPlanCandidate[], pinned?: string): Promise<{ id: string; source: string }> => {
      if (pinned !== undefined) {
        if (!choices.some((c) => c.choice === pinned)) {
          throw new Error(`pinned plan "${pinned}" is not one of the offered plans [${choices.map((c) => c.choice).join(', ')}]`);
        }
        return { id: pinned, source: 'pinned (--workflow-choice)' };
      }
      if (provider !== null && choices.length > 1) {
        const id = await decideWorkflowPlan(provider, {
          task: { taskId: rootId, objective: roundObjective },
          candidates: choices,
        });
        return { id, source: 'Laya decision' };
      }
      return { id: choices[0]!.choice, source: provider === null ? 'no provider: first bounded plan' : 'single candidate' };
    };
    // Recorded on the report so a run says WHERE its plan came from.
    const planFileLabel = o.workflowPlan === undefined ? null : o.workflowPlan;

    if (o.workflow === 'collaborate') {
      /*
       * B4.1 (功能 B): ONE goal, 2–3 models, each with its own child task, and a
       * designated integrator member. Every precondition below is a REFUSAL raised
       * BEFORE the root or any child exists, because each of them is a fact that must
       * not be papered over by silently degrading into a 1-model round.
       */
      // B4.5 (P1-2): in a git repository the group works in ONE shared worktree whose
      // root is a SIBLING of the project root (see `WorkspaceManager`). A NESTED `--cwd`
      // (a subdirectory of the repo) would silently create that worktree INSIDE the user's
      // checkout and drop the subdirectory the user asked for, so it is refused HERE —
      // before any task, worktree, runtime call or review — and the user is told to start
      // from the repository root. Non-git collaboration (workspace === null) is unchanged.
      // The comparison uses the workspace lock's own path identity so case and separator
      // differences cannot turn the repo root into a false positive.
      if (workspace !== null && repoRoot !== null &&
        normalizeIdentityPath(repoRoot) !== normalizeIdentityPath(o.cwd)) {
        throw new Error(
          'a git collaboration group must be started from the REPOSITORY ROOT: ' +
            `--cwd is "${o.cwd}" but the repository root is "${repoRoot}". Running from a ` +
            'subdirectory is not supported yet — it would create worktrees inside your checkout ' +
            'and lose the subdirectory you asked for. Re-run from the repository root.',
        );
      }
      const effective = resolveSelection(taskSelection, projectSelection);
      if (fixedPairOf(effective) !== undefined) {
        throw new Error(
          'a FIXED Agent x Model selection pins ONE pair for the whole round, which cannot be a ' +
            '2-3 model collaboration group; the fixed pair is not swapped, relaxed or widened — ' +
            'run the round with --select auto (or without --select) to let Laya choose the members',
        );
      }
      // B4.5: in a git repository the group runs in ONE shared, isolated worktree —
      // not per-member worktrees (which the integrator could not see) and NOT the
      // user's checkout. The worktree is created lazily by the existing
      // WorkspaceManager on the group's first execution, keyed by the round's root
      // task as its physical OWNER (see `groupOwnerFor` above). The user's checkout is
      // never the cwd, is never merged into, and keeps its dirty files untouched: the
      // worktree starts from the committed base. This replaces the old blanket
      // refusal; non-git collaboration is unchanged (workspace === null).
      // B4.2: the plan spec comes from the user's file when one was given, else the
      // built-in duo/trio. Both produce the SAME `members` + `integratorMember` shape, and
      // both go through the SAME candidate builder, so they cannot drift apart.
      const collabPlans = planFile === null ? null : planFile.plans.filter(isCollaborationPlan);
      if (collabPlans !== null && collabPlans.length === 0) {
        throw new Error('the plan file declares no collaboration plans for --workflow collaborate');
      }
      const collabChoices: WorkflowPlanCandidate[] = planFile === null
        ? COLLABORATION_PLAN_CHOICES.map((c) => ({
            choice: c.choice, label: c.label,
            roles: [...c.members.map((m) => m.role), `integration by collaborator ${c.integratorMember}`],
          }))
        : collabPlans!.map((p) => ({
            choice: p.id, label: p.label,
            roles: [...p.members.map((m) => m.role), `integration by collaborator ${p.integratorMember}`],
          }));
      const collabPinned = o.workflowChoice !== undefined && (planFile !== null || isCollaborationChoice(o.workflowChoice))
        ? o.workflowChoice : undefined;
      const collabChosen = await choosePlan(collabChoices, collabPinned);
      collaborationPlanUsed = collabChosen.id;
      workflowPlanSource = collabChosen.source;
      const collabSpec = planFile === null
        ? collaborationPlanFor(collabChosen.id)
        : collabPlans!.find((p) => p.id === collabChosen.id)!;
      collaborationMembers = collabSpec.members as readonly PlanFileStep[];
      collaborationIntegratorMember = collabSpec.integratorMember;
      collaborationIds = planFileCollaborationTaskIds(rootId, collaborationMembers.length, collaborationIntegratorMember);
      // B4.5: bind the PHYSICAL workspace owner now that the group's shape is known.
      // The root owns the shared worktree; every member and the integration task
      // resolves to it through the resolvers handed to the Orchestrator at construction.
      collaborationGroupOwner = rootId;
      collaborationGroupIds = new Set([...collaborationIds.memberIds, collaborationIds.integratorId]);
      // REQ-14's own bound, asserted against the plan itself rather than assumed: a plan
      // outside 2-3 members is not a collaboration group and is refused, not run. (A file
      // plan is already bounded by `parsePlanFile`; this keeps the built-ins honest too.)
      if (collaborationMembers.length < COLLABORATION_MIN_MEMBERS || collaborationMembers.length > COLLABORATION_MAX_MEMBERS) {
        throw new Error(
          `collaboration plan "${collaborationPlanUsed}" declares ${collaborationMembers.length} members, outside the ` +
            `${COLLABORATION_MIN_MEMBERS}-${COLLABORATION_MAX_MEMBERS} a collaboration group may have`,
        );
      }
      // A group of 2–3 needs 2–3 DIFFERENT usable pairs. Checked here, before the root
      // exists, so "there is only one model" is an upfront refusal and never a group
      // that quietly reuses one pair twice (which would be function A wearing B's name).
      const usablePairs = registry.list()
        .filter((e) => (e.taskTypes.includes('implementation') || e.taskTypes.includes('test')) &&
          e.modelId !== null && e.modelId !== '' && registry.isModelAvailable(e.agentId, e.modelId))
        // B2.1: when the user supplied a pool, only pairs it admits can fill a seat, so
        // "there are not enough distinct pairs" is an UPFRONT refusal rather than a group
        // whose later members cannot be assigned. Absent, this filter is a no-op.
        .filter((e) => modelPool === null ||
          admitUserModelPoolPair(modelPool, { agentId: e.agentId, modelId: e.modelId }, Date.now()).allowed)
        .map((e) => `${e.agentId}/${e.modelId}`);
      const distinctPairs = [...new Set(usablePairs)];
      if (distinctPairs.length < collaborationMembers.length) {
        throw new Error(
          `a "${collaborationPlanUsed}" collaboration group needs ${collaborationMembers.length} distinct available ` +
            `Agent x Model pairs, but only ${distinctPairs.length} is registered and available ` +
            `(${distinctPairs.length === 0 ? 'none' : distinctPairs.join(', ')}); no pair is duplicated to fill a seat`,
        );
      }
      planned = wb.planWithCandidates(spec, buildCollaborationMemberCandidates(collaborationMembers, collaborationIntegratorMember, roundObjective, rootId), [
        `${planFile === null ? 'B4.1' : 'B4.2 file'} collaboration group: ${collaborationPlanUsed} (${workflowPlanSource}); ` +
          `${collaborationMembers.length} members + 1 integration task by collaborator ${collaborationIntegratorMember}`,
      ]);
      report.workflow = {
        enabled: true,
        mode: 'collaborate',
        choice: collaborationPlanUsed,
        source: workflowPlanSource,
        ...(planFileLabel === null ? {} : { planFile: planFileLabel }),
        members: collaborationMembers.map((m, i) => ({
          index: i + 1,
          taskId: collaborationIds!.memberIds[i]!,
          role: m.role,
          taskType: m.taskType,
          fileScope: m.fileScope ?? null,
          deliverable: m.deliverable,
        })),
        integrator: {
          index: collaborationIntegratorMember,
          taskId: collaborationIds.integratorId,
          memberTaskId: collaborationIds.memberIds[collaborationIntegratorMember - 1]!,
          note: 'a selected member, reused pair: no fourth collaboration model is added for integration',
        },
        note: 'sequential: members run in order; integration depends on EVERY member and starts only when all are succeeded',
      };
    } else if (o.workflow === 'sequential') {
      /*
       * B4.0/B4.2: a bounded heterogeneous plan (research -> implementation -> test, or a
       * user's own steps). LAYA picks among the OFFERED plans; it never invents a DAG. A
       * pinned choice or a single candidate is handled by the explicit rule and does NOT
       * fake a LAYA comparison. The chosen candidates go through the SAME commitPlan path.
       */
      const seqPlans = planFile === null ? null : planFile.plans.filter(isSequentialPlan);
      if (seqPlans !== null && seqPlans.length === 0) {
        throw new Error('the plan file declares no sequential plans for --workflow sequential');
      }
      const choices: WorkflowPlanCandidate[] = planFile === null
        ? WORKFLOW_PLAN_CHOICES.map((c) => ({ choice: c.choice, label: c.label, roles: c.steps.map((s) => s.role) }))
        : seqPlans!.map((p) => ({ choice: p.id, label: p.label, roles: p.steps.map((s) => s.role) }));
      const pinned = o.workflowChoice !== undefined && (planFile !== null || isWorkflowChoice(o.workflowChoice))
        ? o.workflowChoice : undefined;
      const chosen = await choosePlan(choices, pinned);
      workflowChoiceUsed = chosen.id;
      workflowPlanSource = chosen.source;
      sequentialSteps = planFile === null
        ? (WORKFLOW_PLAN_CHOICES.find((c) => c.choice === chosen.id)?.steps ?? [])
            .map((s) => ({ role: s.role, taskType: s.taskType, deliverable: s.deliverable }))
        : seqPlans!.find((p) => p.id === chosen.id)!.steps;
      planned = wb.planWithCandidates(spec, buildSequentialStepCandidates(sequentialSteps, roundObjective, rootId), [
        `${planFile === null ? 'B4.0' : 'B4.2 file'} sequential workflow plan: ${workflowChoiceUsed} (${workflowPlanSource})`,
      ]);
    } else {
      planned = wb.plan(spec, classification);
    }
    // B4.0: report the workflow plan (mode, choice, how it was chosen, the steps).
    if (o.workflow === 'sequential' && workflowChoiceUsed !== null) {
      report.workflow = {
        enabled: true,
        mode: 'sequential',
        choice: workflowChoiceUsed,
        source: workflowPlanSource,
        ...(planFileLabel === null ? {} : { planFile: planFileLabel }),
        steps: sequentialSteps.map((s) => ({
          role: s.role,
          taskType: s.taskType,
          deliverable: s.deliverable,
          fileScope: s.fileScope ?? null,
        })),
        note: 'sequential: each step depends on the one before; PARALLEL_WRITE=CLOSED',
      };
    } else if (o.workflow !== 'collaborate') {
      report.workflow = { enabled: false };
    }
    // TeamRun T3-a.1: Laya decides the execution TOPOLOGY. SOLO is the existing path and
    // the default; PARALLEL_READ materializes N independent READ member Tasks. A transport
    // failure returns null (no topology opinion -> SOLO); a MALFORMED PARALLEL_READ throws
    // a schema error and refuses the round — it must never silently become SOLO.
    // B4.0/B4.1: a workflow plan is already a sequential chain, so topology is left SOLO.
    let topology: RawExecutionTopology | null = null;
    if (o.workflow === undefined && provider !== null) {
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
          task: { taskId: rootId, objective: roundObjective, acceptanceCriteria: roundObjective },
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
    // B4.1: a collaboration group asks for a pair PER MEMBER and the pairs must be
    // DIFFERENT, so the already-taken pairs are removed from what LAYA is offered and
    // the integration task is excluded entirely — it reuses its integrator member's own
    // pair through `inheritInitialSelection`, which is how the group stays at 2–3 models
    // instead of quietly becoming 2–3 models PLUS a fourth one chosen for integration.
    if (collaborationIds !== null) {
      await wb.selectInitialAssignment(rootId, spec.selection, {
        distinctPairs: true,
        skipTaskIds: [collaborationIds.integratorId],
      });
      const memberTaskId = collaborationIds.memberIds[collaborationIds.integratorIndex - 1]!;
      const inherited = wb.inheritInitialSelection(memberTaskId, collaborationIds.integratorId);
      if (!inherited.ok) {
        throw new Error(
          `collaboration integration is refused: ${inherited.reason} (blocked by member "${memberTaskId}")`,
        );
      }
    } else {
      await wb.selectInitialAssignment(rootId, spec.selection);
    }
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

  /*
   * B3.1: the ADVISORY skill choice. It runs AFTER the authoritative initial Assignment
   * (so the real Agent x Model is known and is reported/validated) and BEFORE the first
   * dispatch (so a provider failure can stop the round with nothing executed).
   *
   * For each initially assigned task, AT MOST ONE skill is chosen from the user-declared
   * candidates — and ONLY when the task's assigned agent is the catalogue's agent AND that
   * agent advertises native skill support (`capabilities.skills === true`). Otherwise the
   * rule says "explicit none" and the provider is NOT asked (a one-option question carries
   * no information and the real provider refuses it).
   *
   * This never reroutes an agent or a model, never touches the fixed pair, quota, budget or
   * resources, and adds no scheduler/router/manager. The choice is recorded through the
   * EXISTING `setTaskIntent`, preserving every unrelated intent field.
   */
  interface SkillSelection {
    /** The skill LAYA selected (or null for an explicit/rule none). */
    readonly requestedName: string | null;
    /** The name BOUND into the advisory brief at selection time (equal to `requestedName`
     * when a skill was selected; never re-read from a possibly-pruned intent later). */
    readonly admittedName: string | null;
    readonly source: 'laya' | 'rule';
    readonly reason: string;
    readonly agentId: string;
    readonly modelId: string | null;
  }
  const skillSelections = new Map<string, SkillSelection>();
  if (skillCatalog !== null) {
    const skillsCapable = new Map<string, boolean>();
    for (const d of descriptors) skillsCapable.set(d.id, d.capabilities?.skills === true);
    for (const a of assigned) {
      if (!a.ok) continue;
      const task = wb.store.get(a.taskId);
      if (task === null) continue;
      const agentId = task.agentId;
      const modelId = task.modelId ?? null;
      const matching = agentId === skillCatalog.agentId;
      const capable = skillsCapable.get(agentId) === true;
      const offered: SkillChoiceCandidate[] = matching
        ? skillCatalog.skills.map((s) => ({ name: s.name, description: s.description }))
        : [];
      const ruleReason = !matching
        ? `the catalogue is declared for agent "${skillCatalog.agentId}", not the assigned agent "${agentId}"`
        : !capable
          ? `agent "${agentId}" does not advertise native skill support (capabilities.skills !== true)`
          : offered.length === 0
            ? 'the catalogue declares no skills for this agent'
            : provider === null
              ? 'no decision provider is available, so no skill is requested'
              : '';
      if (ruleReason !== '') {
        skillSelections.set(a.taskId, { requestedName: null, admittedName: null, source: 'rule', reason: ruleReason, agentId, modelId });
        continue;
      }
      const roleMatch = /:: ([\w-]+) — deliverable:/.exec(task.acceptanceCriteria);
      let chosen: string | null;
      try {
        chosen = await decideSkillChoice(provider, {
          task: {
            taskId: task.taskId,
            objective: task.acceptanceCriteria,
            ...(roleMatch === null ? {} : { role: roleMatch[1]! }),
            taskType: task.taskType,
            acceptanceCriteria: task.acceptanceCriteria,
            agentId,
            modelId,
          },
          candidates: offered,
        });
      } catch (e) {
        const msg = `${(e as Error).name}: ${(e as Error).message}`;
        report.stage = 'skill-choice';
        report.error = `skill choice refused: ${msg}`;
        if (o.json) w(JSON.stringify(report, null, 2));
        else note(`skill choice refused: ${msg}; nothing was executed.`);
        notifyWorkbenchSnapshot();
        return 1;
      }
      if (chosen === null) {
        skillSelections.set(a.taskId, {
          requestedName: null,
          admittedName: null,
          source: 'laya',
          reason: 'the decision provider chose the explicit no-skill option',
          agentId,
          modelId,
        });
      } else {
        const existing = wb.intentFor(a.taskId) ?? {};
        wb.setTaskIntent(a.taskId, { ...existing, skills: [chosen] });
        skillSelections.set(a.taskId, {
          requestedName: chosen,
          admittedName: chosen,
          source: 'laya',
          reason: 'the decision provider selected this skill from the offered candidates',
          agentId,
          modelId,
        });
      }
    }
  }

  /**
   * B3.2: the ADVISORY native MCP tool choice. It has the SAME placement as the skill choice —
   * AFTER the authoritative initial Assignment (so the real Agent x Model is known) and BEFORE
   * the first dispatch (so a provider failure stops the round with nothing executed).
   *
   * For each initially assigned task, AT MOST ONE native tool is chosen from the user-declared
   * candidates — and ONLY when the task's assigned agent is the catalogue's supported agent
   * ("opencode"). Otherwise the rule says "explicit none" and the provider is NOT asked.
   *
   * This never connects/installs/authorizes an MCP server, never reroutes an agent or a model,
   * never touches the fixed pair, quota or resources, and adds no scheduler/router/manager.
   * The choice is recorded through the EXISTING `setTaskIntent`, preserving every unrelated
   * intent field (including a skill already recorded for the same task).
   */
  interface McpSelection {
    /** The tool tuple LAYA selected (or null for an explicit/rule none). */
    readonly requested: McpToolTuple | null;
    /** The tuple BOUND into the advisory brief at selection time (equal to `requested` when a
     * tool was selected; never re-read from a possibly-pruned intent later). */
    readonly admitted: McpToolTuple | null;
    readonly source: 'laya' | 'rule';
    readonly reason: string;
    readonly agentId: string;
    readonly modelId: string | null;
  }
  const mcpSelections = new Map<string, McpSelection>();
  if (mcpCatalog !== null) {
    for (const a of assigned) {
      if (!a.ok) continue;
      const task = wb.store.get(a.taskId);
      if (task === null) continue;
      const agentId = task.agentId;
      const modelId = task.modelId ?? null;
      // The catalogue is declared for the ONE supported agent, so "matching" is exact. MCP
      // support is NOT inferred from `capabilities.skills` or any other capability.
      const matching = agentId === mcpCatalog.agentId;
      const offered = mcpCatalog.tools;
      const ruleReason = !matching
        ? `the MCP catalogue is declared for agent "${mcpCatalog.agentId}", not the assigned agent "${agentId}"`
        : offered.length === 0
          ? 'the MCP catalogue declares no tools for this agent'
          : provider === null
            ? 'no decision provider is available, so no MCP tool is requested'
            : '';
      if (ruleReason !== '') {
        mcpSelections.set(a.taskId, { requested: null, admitted: null, source: 'rule', reason: ruleReason, agentId, modelId });
        continue;
      }
      const roleMatch = /:: ([\w-]+) — deliverable:/.exec(task.acceptanceCriteria);
      let chosen: McpChoiceCandidate | null;
      try {
        chosen = await decideMcpChoice(provider, {
          task: {
            taskId: task.taskId,
            objective: task.acceptanceCriteria,
            ...(roleMatch === null ? {} : { role: roleMatch[1]! }),
            taskType: task.taskType,
            agentId,
            modelId,
          },
          candidates: offered.map((t) => ({ nativeName: t.nativeName, server: t.server, tool: t.tool, description: t.description })),
        });
      } catch (e) {
        const msg = `${(e as Error).name}: ${(e as Error).message}`;
        report.stage = 'mcp-choice';
        report.error = `mcp tool choice refused: ${msg}`;
        if (o.json) w(JSON.stringify(report, null, 2));
        else note(`mcp tool choice refused: ${msg}; nothing was executed.`);
        notifyWorkbenchSnapshot();
        return 1;
      }
      if (chosen === null) {
        mcpSelections.set(a.taskId, {
          requested: null,
          admitted: null,
          source: 'laya',
          reason: 'the decision provider chose the explicit no-tool option',
          agentId,
          modelId,
        });
      } else {
        const tuple: McpToolTuple = { server: chosen.server, tool: chosen.tool, nativeName: chosen.nativeName };
        const existing = wb.intentFor(a.taskId) ?? {};
        wb.setTaskIntent(a.taskId, { ...existing, mcpTools: [mcpToolIntentLabel(tuple)] });
        mcpSelections.set(a.taskId, {
          requested: tuple,
          admitted: tuple,
          source: 'laya',
          reason: 'the decision provider selected this native MCP tool from the offered candidates',
          agentId,
          modelId,
        });
      }
    }
  }

  /**
   * B3.1/B3.2: the ONE shared advisory brief composer for an initially assigned task that has
   * NO dependencies and at least one SELECTED advisory pick (a native skill and/or an MCP
   * tool).
   *
   * `NativeWorkbench.dispatch` auto-composes a brief (which already renders the recorded
   * skill/mcpTools intent) for tasks that HAVE dependencies, but a no-dependency first step
   * gets the bare prompt instead. This reuses the SAME `briefFor`/`buildTaskBrief` and hands
   * the result to the SAME `dispatch(promptFor)` seam the continuation path already uses, so
   * both advisory picks reach EVERY task's brief rather than only the later steps. It returns
   * undefined (and changes nothing) whenever no advisory pick was made.
   */
  const advisoryBriefPrompts = (): ReadonlyMap<string, string> | undefined => {
    if (skillCatalog === null && mcpCatalog === null) return undefined;
    // The UNION of the task ids that got a selected skill and/or a selected MCP tool. A task
    // with neither is absent, so a round with only rule-none picks changes nothing.
    const ids = new Set<string>();
    for (const [taskId, sel] of skillSelections) if (sel.requestedName !== null) ids.add(taskId);
    for (const [taskId, sel] of mcpSelections) if (sel.requested !== null) ids.add(taskId);
    const prompts = new Map<string, string>();
    for (const taskId of ids) {
      const task = wb.store.get(taskId);
      if (task === null || task.dependencies.length > 0) continue;
      if (task.status !== 'planned' && task.status !== 'queued') continue;
      const brief = wb.briefFor(taskId, wb.runResults());
      if (brief !== null) prompts.set(taskId, brief);
    }
    return prompts.size > 0 ? prompts : undefined;
  };

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
   * B5.1: the concrete Agent × Model pairs each task has already used in this chain.
   *
   * Kept BESIDE `handoffAgentChain` (which is preserved for compatibility) and populated
   * from the SAME `HandoffRecord` facts, so the pre-reassign guard can tell a same-agent
   * DIFFERENT model (a new worker, allowed) from returning to a used pair (refused). It is
   * a second copy of the driver's own pair chain, not a new selector: both use the same
   * `evaluateHandoffBudget` field-by-field comparison.
   */
  const handoffWorkerChain = new Map<string, WorkerRef[]>();

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

  // B5.1: the handoff budget, initialized HERE (before `handoffCapabilities`) on purpose.
  // Its FIRST possible use is the `reassign` capability below, which the workflow loop can
  // invoke before the continuation-driver section of this function is reached. Declaring
  // it later left it in the temporal dead zone and threw a real `ReferenceError` on the
  // first workflow reassign.
  const handoffPolicy = { maxAutomaticHandoffsPerTask: o.handoffMax };

  /**
   * B5.1: the STOP-safety fact for a task whose CURRENT attempt ended in an EXECUTED
   * session failure.
   *
   * Reads ONLY the atomic `currentActualOf` bundle (the AttemptRecord and the RunResult of
   * that very attempt) and reuses the SAME classifier the continuation driver uses, so the
   * workflow's reassign path and the canonical driver cannot disagree about whether a task
   * stands at a handoff boundary. Returns `null` for anything else: no current attempt, a
   * success, a non-transport failure, or a pure admission refusal.
   *
   * `confirmed` is a literal `true` only when the run's OWN `cleanup.treeStopConfirmed` is
   * `true`; false/absent is "not stopped", never inferred from exit code or error name.
   */
  const sessionFailureBoundary = (taskId: string): { readonly confirmed: boolean } | null => {
    const actual = currentActualOf(taskId);
    if (actual === null || actual.run === null) return null;
    const outcome = classifyExecutionOutcome({
      taskId,
      taskStatus: wb.store.get(taskId)?.status ?? 'running',
      agentId: actual.agentId,
      modelId: actual.modelId,
      run: actual.run,
      refusalCode: null,
      refusalReason: null,
      attemptIds: [actual.attemptId],
    });
    const classification = classifyHandoffReason(outcome);
    if (!classification.handoff || classification.reason !== 'session_failure') return null;
    return { confirmed: actual.run.cleanup?.treeStopConfirmed === true };
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
      // B3.1/B3.2: when a skill and/or MCP tool was selected for a no-dependency task, its
      // advisory brief is handed to the SAME `dispatch(promptFor)` seam (exactly as the
      // continuation path does). Absent that, this is `decisionCapabilities.dispatch()`
      // byte-for-byte.
      const advisoryPrompts = advisoryBriefPrompts();
      const receipt = advisoryPrompts === undefined
        ? await decisionCapabilities.dispatch()
        : await wb.dispatchReceipt(advisoryPrompts);
      captureDispatchFacts(receipt);
      return receipt;
    },
    reassign: async (req: { taskId: string; agentId?: string; modelId?: string; strategy?: 'explicit' | 'assignment'; reason?: string }) => {
      // B5.1: the STOP gate is enforced at EVERY reassign entry, not only inside the
      // canonical continuation driver. A task whose current attempt is an EXECUTED session
      // failure with an UNCONFIRMED process-tree stop must not be migrated by any caller
      // (a workflow's generic reassign included): the previous tree may still hold a
      // writer, and migrating then dispatching would start a second session/runtime before
      // the old one is proven stopped. Only a literal `treeStopConfirmed === true` clears
      // this; absent/false never does. A CONFIRMED boundary is deliberately allowed here,
      // because the canonical driver performs its legitimate handoff through this same
      // capability.
      const stop = sessionFailureBoundary(req.taskId);
      if (stop !== null && !stop.confirmed) {
        return {
          ok: false,
          code: 'handoff-stop-unconfirmed',
          reason: `task ${req.taskId} ended in a session failure but its process-tree stop is NOT ` +
            'confirmed; the old execution must be proven stopped before another worker may continue it, ' +
            'so no reassign was applied',
        };
      }
      if (req.agentId !== undefined) {
        const used = handoffAgentChain.get(req.taskId) ?? [];
        const usedWorkers = handoffWorkerChain.get(req.taskId) ?? [];
        const verdict = evaluateHandoffBudget({
          policy: handoffPolicy,
          used: used.length,
          agentsUsed: used,
          targetAgentId: req.agentId,
          // B5.1: compare the concrete pair when the decision names a model, so
          // same-agent m1 -> m2 -> m3 is a real series of new workers rather than an
          // agent-only oscillation. A decision naming only an agent keeps the original
          // agent-only, conservative semantics (modelId null -> treated as the same pair).
          workersUsed: usedWorkers,
          target: { agentId: req.agentId, modelId: req.modelId ?? null },
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
    if (o.workflow === undefined) return undefined;
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
    return { objective: roundObjective, entries };
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

  /*
   * B4.6a/B4.6b: the OPT-IN single-step USER checkpoint state. Every value below is empty
   * and unused unless `--checkpoint` was given, so a round without the flag behaves exactly
   * as before: no input is read and no report field is added.
   *
   * `checkpointStop` is the ONE fact the rest of the round reads: when it is non-null a
   * stop (or a refused accept) ended the bounded loop, so the later handoff/continuation
   * is not started. It is a report fact, never a second state authority: it does not touch
   * a Task, a lease or the store. A successful `accept`, by contrast, goes through the
   * EXISTING `wb.completeTask` -> `applyVerification` edge; the checkpoint holds no state
   * authority of its own.
   */
  interface CheckpointEntry {
    readonly taskId: string;
    readonly status: string;
    readonly role: string | null;
    readonly acceptanceCriteria: string;
    readonly attemptId: string;
    readonly agentId: string;
    readonly modelId: string | null;
    readonly sessionId: string | null;
    readonly output: string;
    readonly outputTruncated: boolean;
    readonly treeStopConfirmed: boolean | null;
    readonly choice: 'continue' | 'stop' | 'accept';
    /** For a `stop`, why; for a refused `accept`, the refusal; else null. */
    readonly stopReason: string | null;
    /** B4.6b: the user's non-empty acceptance reason, when they chose accept. */
    readonly acceptReason: string | null;
    /** B4.6b: the ACTUAL outcome through the existing verification authority. */
    readonly acceptOutcome: 'applied' | 'refused' | null;
    /** B4.6b: which live re-check refused the accept, when it did. */
    readonly acceptRefusal: string | null;
    /** B4.6b: the provenance of the verdict - always the USER, never a model. */
    readonly source: 'user';
  }
  const checkpointEntries: CheckpointEntry[] = [];
  const checkpointedAttempts = new Set<string>();
  let checkpointStop: { taskId: string; reason: string; blockedTaskIds: string[] } | null = null;

  let outcome: Awaited<ReturnType<typeof runDecisionCycle>> = await runOneCycle();
  let workflowCycles = 1;
  let workflowStop: string | null = null;
  if (o.workflow === 'sequential' || o.workflow === 'collaborate') {
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

    // B4.6a: task id -> declared role, read from the ACTUAL plan (never a regex guess).
    const roleByTaskId = new Map<string, string>();
    if (collaborationIds !== null) {
      collaborationIds.memberIds.forEach((id, i) => roleByTaskId.set(id, collaborationMembers[i]?.role ?? 'unknown'));
      roleByTaskId.set(collaborationIds.integratorId, `integration (collaborator ${collaborationIntegratorMember})`);
    } else {
      memberIds.forEach((id, i) => roleByTaskId.set(id, sequentialSteps[i]?.role ?? 'unknown'));
    }

    /**
     * The workflow members a STOP leaves un-run or un-verified: everything that is not
     * terminal. Reported so the user can see WHAT the stop withheld. It names facts from
     * the TaskStore and changes nothing.
     */
    const blockedByStop = (): string[] => memberIds.filter((id) => {
      const status = wb.store.get(id)?.status;
      return status !== undefined && status !== 'succeeded' && status !== 'failed' && status !== 'cancelled';
    });

    /**
     * B4.6a/B4.6b: the single-step user checkpoint.
     *
     * It runs at the TOP of each loop iteration — after a member really ran (so it is
     * `to_verify` with a real `RunResult` correlated to the CURRENT attempt) and BEFORE
     * the next cycle can hand it to LAYA's `complete` or dispatch a downstream step.
     * Each attempt is offered AT MOST ONCE: the set above is keyed by `attemptId`, so a
     * no-progress re-read never re-prompts, and a task with no real run is skipped
     * rather than faked.
     *
     * THREE answers, and only three:
     *   `continue` changes NOTHING about the round's gates; it only lets the existing
     *              verification/scheduling proceed.
     *   `stop`     ends the loop with a reason (as do any unreadable, errored,
     *              timed-out or invalid answer).
     *   `accept`   is an EXPLICIT USER VERDICT on the task SHOWN. It is applied ONLY
     *              through the EXISTING completion authority (`wb.completeTask` ->
     *              `applyVerification`), never by a direct store transition, and only
     *              AFTER a synchronous re-read of the live facts.
     *
     * B4.6b RE-CHECK (the security-critical part). The displayed snapshot is DATA, never
     * a trusted grant: a `checkpointInput` callback cannot accept anything merely by
     * returning the word. AFTER the answer is read and BEFORE any pass is applied, the
     * CURRENT Task and the atomic `currentActualOf` bundle are re-read, and the accept is
     * refused unless the task still exists, is still `to_verify`, still carries the SAME
     * acceptance criteria, still has the SAME current attempt / agent / model / session,
     * still has that attempt's own RunResult, and reports a CONFIRMED process-tree stop.
     * No latest-by-task join, no session guessed from a thread. All refusal paths STOP
     * VISIBLY and never default to continue or success; there is deliberately NO await
     * between the final check and `wb.completeTask`.
     */
    const checkpointGate = async (): Promise<
      { kind: 'stop'; taskId: string; reason: string } | { kind: 'accept' } | null
    > => {
      if (o.checkpoint !== true) return null;
      for (const id of memberIds) {
        const task = wb.store.get(id);
        if (task === null || task.status !== 'to_verify') continue;
        const actual = currentActualOf(id);
        if (actual === null || actual.run === null) continue;
        if (checkpointedAttempts.has(actual.attemptId)) continue;
        checkpointedAttempts.add(actual.attemptId);

        const run = actual.run;
        // The task's DECLARED worker as DISPLAYED, captured as primitives BEFORE the await,
        // so a mutation of the live task while the user is deciding is detectable (the
        // attempt record itself is frozen, so only the task-side identity can move).
        const displayedTaskAgentId = task.agentId;
        const displayedTaskModelId = task.modelId;
        const bounded = run.output.slice(0, CHECKPOINT_OUTPUT_MAX_CHARS);
        const snapshot: WorkflowCheckpointSnapshot = Object.freeze({
          taskId: id,
          status: task.status,
          role: roleByTaskId.get(id) ?? null,
          acceptanceCriteria: task.acceptanceCriteria,
          attemptId: actual.attemptId,
          agentId: actual.agentId,
          modelId: actual.modelId,
          sessionId: actual.sessionId,
          output: bounded,
          outputTruncated: run.outputTruncated === true || bounded.length < run.output.length,
          treeStopConfirmed: run.cleanup?.treeStopConfirmed ?? null,
        });
        const record = (
          choice: 'continue' | 'stop' | 'accept',
          extra: {
            stopReason?: string | null;
            acceptReason?: string | null;
            acceptOutcome?: 'applied' | 'refused' | null;
            acceptRefusal?: string | null;
          } = {},
        ): void => {
          checkpointEntries.push({
            ...snapshot,
            choice,
            stopReason: extra.stopReason ?? null,
            acceptReason: extra.acceptReason ?? null,
            acceptOutcome: extra.acceptOutcome ?? null,
            acceptRefusal: extra.acceptRefusal ?? null,
            source: 'user',
          });
        };

        let raw: unknown;
        try {
          // The seam is only consulted when the flag opted in, and it is not called at all
          // without the flag. Its typed return is NOT trusted: `parseCheckpointAnswer`
          // validates the actual value, and a non-string fails closed.
          raw = overrides.checkpointInput !== undefined
            ? await overrides.checkpointInput(snapshot)
            : await createStdinCheckpointReader()(snapshot);
        } catch (e) {
          const reason = `the checkpoint answer could not be read (${thrownMessage(e)}); stopping this round`;
          record('stop', { stopReason: reason });
          return { kind: 'stop', taskId: id, reason };
        }
        const decision = parseCheckpointAnswer(typeof raw === 'string' ? raw : '');
        if (decision.action === 'continue') { record('continue'); continue; }
        if (decision.action === 'stop') {
          record('stop', { stopReason: decision.reason });
          return { kind: 'stop', taskId: id, reason: decision.reason };
        }
        if (decision.action === 'invalid') {
          const reason = `the checkpoint answer was not understood (${decision.detail}); stopping this round`;
          record('stop', { stopReason: reason });
          return { kind: 'stop', taskId: id, reason };
        }

        /*
         * decision.action === 'accept'. Re-read the LIVE facts synchronously, AFTER the
         * awaited answer, BEFORE applying anything. The snapshot above is only what the
         * user was SHOWN; it authorises nothing on its own.
         */
        const refuseAccept = (detail: string): { kind: 'stop'; taskId: string; reason: string } => {
          const reason = `the user's accept was refused: ${detail}; stopping this round (no task was marked done)`;
          record('accept', {
            acceptReason: decision.reason,
            acceptOutcome: 'refused',
            acceptRefusal: detail,
            stopReason: reason,
          });
          return { kind: 'stop', taskId: id, reason };
        };
        const freshTask = wb.store.get(id);
        if (freshTask === null) return refuseAccept(`task ${id} no longer exists`);
        if (freshTask.status !== 'to_verify') {
          return refuseAccept(`task ${id} is now ${freshTask.status}, not awaiting verification`);
        }
        if (freshTask.acceptanceCriteria !== snapshot.acceptanceCriteria) {
          return refuseAccept(`the task's acceptance criteria changed while the answer was being read`);
        }
        if (freshTask.agentId !== displayedTaskAgentId || freshTask.modelId !== displayedTaskModelId) {
          return refuseAccept(`the task's declared worker identity changed while the answer was being read`);
        }
        const freshActual = currentActualOf(id);
        if (freshActual === null) return refuseAccept(`task ${id} has no current execution to verify`);
        if (freshActual.attemptId !== snapshot.attemptId) {
          return refuseAccept(`the current attempt changed (was ${snapshot.attemptId}, now ${freshActual.attemptId})`);
        }
        if (freshActual.run === null) {
          return refuseAccept(`the current attempt ${freshActual.attemptId} has no RunResult`);
        }
        if (freshActual.agentId !== snapshot.agentId || freshActual.modelId !== snapshot.modelId ||
          freshActual.sessionId !== snapshot.sessionId) {
          return refuseAccept(`the current attempt's worker identity changed while the answer was being read`);
        }
        if (freshActual.run.cleanup?.treeStopConfirmed !== true) {
          return refuseAccept(`the current attempt's process-tree stop is not confirmed`);
        }
        // The SOLE completion edge, and the EXISTING one: no direct TaskStore write, no
        // await between the checks above and this call, and an explicit user reason.
        const applied = wb.completeTask(
          id,
          `user accepted at the workflow checkpoint: ${decision.reason}`,
        );
        if (!applied.ok) {
          return refuseAccept(`the existing verification authority refused (${applied.code}: ${applied.reason})`);
        }
        record('accept', { acceptReason: decision.reason, acceptOutcome: 'applied' });
        return { kind: 'accept' };
      }
      return null;
    };

    if (outcome.status !== 'ok') {
      workflowStop = `cycle-${outcome.status}`;
    } else {
      for (;;) {
        const members = memberIds.map((id) => wb.store.get(id));
        if (members.length > 0 && members.every((m) => m?.status === 'succeeded')) { workflowStop = 'all-succeeded'; break; }
        if (members.some((m) => m?.status === 'failed' || m?.status === 'cancelled')) { workflowStop = 'terminal-failure'; break; }
        if (workflowCycles >= maxCycles) { workflowStop = 'cycle-limit'; break; }
        // B5.1: a member that ended in an EXECUTED session failure is a HANDOFF boundary,
        // not workflow progress. Recovery for it belongs to the ONE canonical bounded
        // continuation below, which reads the atomic Attempt/RunResult stop fact. The
        // workflow loop must NOT let Laya's generic `reassign` migrate the task first:
        // for an UNCONFIRMED stop that would start a second writer before the old tree is
        // proven stopped, and for a confirmed one it would pre-migrate the Task and make
        // the driver record a `fromModel` read off the already-changed Task instead of the
        // attempt that actually ran. Yielding here hands the boundary over untouched.
        if (memberIds.some((id) => sessionFailureBoundary(id) !== null)) {
          workflowStop = 'handoff-boundary';
          break;
        }
        // B4.6a/B4.6b: the USER checkpoint sits between "a member really ran" and "LAYA
        // may verify it and schedule downstream work". A stop ends the loop here; an
        // ACCEPT is applied through the existing verification authority, and then the
        // loop re-checks the bounded workflow's OWN completion at the TOP before any
        // further model decision (so a final member that just succeeded ends as
        // all-succeeded WITHOUT an extra, actionless LAYA call).
        if (o.checkpoint === true) {
          const result = await checkpointGate();
          if (result !== null) {
            if (result.kind === 'stop') {
              workflowStop = 'user-stop';
              checkpointStop = { taskId: result.taskId, reason: result.reason, blockedTaskIds: blockedByStop() };
              break;
            }
            // A real user acceptance was applied. If downstream remains, the existing
            // scheduler/decision path below still controls the next dispatch.
            continue;
          }
        }
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
      // B5.1: prefer the CURRENT dispatch's atomic {attemptId, run} bundle over the
      // per-task "latest run" lookup. `currentActualOf` returns null when this task has no
      // current started attempt, and only THEN do we fall back to `runResults`; when it is
      // present, its OWN `run` is used even if null, so a pending attempt never inherits an
      // older attempt's result.
      const actual = currentActualOf(t.taskId);
      const run = actual !== null ? actual.run : (runResults.get(t.taskId) ?? null);
      const refusal = refusals.get(t.taskId) ?? null;
      // No evidence AND no refusal means nothing happened yet; there is no outcome to
      // report, and inventing one would put a fiction in front of the decision brain.
      if (history.length === 0 && run === null && refusal === null) continue;
      found.push(classifyExecutionOutcome({
        taskId: t.taskId,
        taskStatus: live.status,
        agentId: actual?.agentId ?? live.agentId,
        modelId: actual?.modelId ?? live.modelId,
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
  // B4.6a: a user STOP ends the round's work. A handoff/continuation exists to start a
  // NEW attempt on another agent, which is exactly "further work", so it is not started
  // when the user stopped at a checkpoint. Existing failure/protection paths are
  // unchanged: this only withholds the continuation the stop already ended.
  if (o.handoff && checkpointStop === null) {
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
          // B5.1: keep the concrete pair chain in step with the agent chain, from the SAME
          // record facts, so the pre-reassign guard sees a same-agent different model.
          handoffWorkerChain.set(
            record.taskId,
            [
              ...(handoffWorkerChain.get(record.taskId) ?? []),
              { agentId: record.fromAgentId ?? 'unknown', modelId: record.fromModelId ?? null },
            ],
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
          // B5.1: the Attempt AND its RunResult come from the SAME `currentActualOf` atomic
          // bundle, so the packet's evidence, cleanup and stop fact always describe the
          // CURRENT attempt. `lastRunResult` + last history could pair attempt A's identity
          // with attempt B's result. A pure admission refusal has no current attempt, which
          // yields a null attempt/evidence exactly as before.
          const actual = currentActualOf(taskId);
          const run = actual === null ? null : actual.run;
          const rec = actual === null ? null : wb.evidence.get(actual.attemptId);
          return buildContinuationPacket({
            task,
            reason: classification.reason,
            outcome,
            evidence: run === null ? null : buildHandoff(task, run),
            attempt: rec === null ? null : {
              attemptId: rec.attemptId,
              agentId: rec.agentId,
              modelId: rec.modelId,
              leaseVersion: rec.leaseVersion,
              errorCode: rec.errorCode,
              errorMessage: rec.errorMessage,
            },
            // B5.1: the run's OWN cleanup, from the same bundle. Only treeStopConfirmed is read.
            cleanup: run === null ? null : run.cleanup,
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
            targetModelId: decision !== null && decision.action === 'reassign' ? (decision.modelId ?? null) : null,
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
          // B4.2a: an APPLIED `continue` that admitted nothing still carries the
          // scheduler/gate refusal code, so it is read here instead of dropped.
          code: outcome.application.applied ? (outcome.application.code ?? null) : outcome.application.code,
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
  const workflowMemberIds: string[] = o.workflow !== undefined && planned !== undefined
    ? (planned.children as ReadonlyArray<{ taskId: string }>).map((c) => c.taskId)
    : [];
  const workflowPending = workflowMemberIds
    .map((id) => ({ taskId: id, status: wb.store.get(id)?.status ?? 'missing' }))
    .filter((m) => m.status !== 'succeeded');
  const workflowIncomplete = o.workflow !== undefined && workflowPending.length > 0;

  // ---- B4.5a: the RUNTIME retained-protection check, scoped to THIS group --------
  //
  // The Git-CREATION check at the review below (`unconfirmedProtections`) covers the
  // worktree-creation phase only. It does NOT see a ResourceClaim the ORCHESTRATOR
  // retained AFTER an Agent execution whose tree stop was never confirmed
  // (`WorkspaceManager.retainResourceProtection`). Those claims are keyed by the member /
  // integrator task id — the actual holder, not the round root — and carry the SHARED owner
  // workspace's `workspaceId` and scope.
  //
  // So they are matched here against the group's REAL physical workspace (the owner handle
  // the report already reads), by `workspaceId` OR scope overlap. That is deliberately NOT
  // "owner task id" (a runtime claim is never keyed by the root) and NOT "any retained claim
  // blocks every group": an unrelated group's retention names a different workspaceId/root,
  // so it does not match and cannot withhold an innocent group.
  //
  // The fact is folded into `executionIncomplete` — the SAME completion fact that already
  // drives `report.ok`, the withheld review and the Human Gate — rather than a new status
  // authority. A retained runtime protection means the round's physical workspace may still
  // hold a writer, so the round is not a clean completion.
  const groupRuntimeRetained: ResourceClaim | null = (() => {
    if (o.workflow !== 'collaborate' || workspace === null) return null;
    const owner = collaborationGroupOwner;
    if (owner === null) return null;
    const handle = workspace.get(owner);
    if (handle === null) return null;
    // The group's ONE physical workspace, as the claim book describes it for a group task.
    // Built through the SAME normalizer the claim book itself uses, so the root is a
    // canonical (separator/case-normalized) path and a scope-only `file` claim inside the
    // worktree really overlaps it. Hand-building `{ root: handle.cwd }` left a native
    // `C:\...` root, which `scopesOverlap`/`isUnder` could never match against the
    // normalized `c:/...` paths the claims actually carry.
    const groupScope: ResourceScope = normalizeScopeForWorkspace(handle.workspaceId, handle.cwd);
    return workspace.retainedResourceProtections().find((c) =>
      c.workspaceId === handle.workspaceId || scopesOverlap(c.scope, groupScope)) ?? null;
  })();
  const groupRuntimeIncomplete = groupRuntimeRetained !== null;

  // B5.1: a session_failure whose process-tree stop was never confirmed is NOT a finished
  // round. The driver refused the handoff (`stop-unconfirmed`) rather than start a second
  // writer, so the work is unfinished. Folded into the SAME completion fact that already
  // drives `report.ok`, the withheld review and the Human Gate — no new status authority.
  const handoffStopUnconfirmed = continuation !== null && continuation.stopped.code === 'stop-unconfirmed';

  const executionIncomplete =
    (fanoutGroups.length > 0 && !fanoutAllSettled) || workflowIncomplete || groupRuntimeIncomplete ||
    handoffStopUnconfirmed;

  report.fanoutDrain = {
    iterations: fanoutDrain.iterations,
    progressIterations: fanoutDrain.progressIterations,
    complete: fanoutDrain.complete,
    fixpoint: fanoutDrain.fixpoint,
    unresolvedAtStop: [...fanoutDrain.unresolvedAtStop],
  };
  if (o.workflow !== undefined) {
    report.workflow = {
      ...(report.workflow as Record<string, unknown>),
      cycles: workflowCycles,
      stop: workflowStop,
      pending: workflowPending,
    };
    /*
     * B4.6a/B4.6b: the USER checkpoint record - OPT-IN, so it exists ONLY when
     * `--checkpoint` was given and a round without the flag is byte-identical to before.
     * It holds what was shown, what the user chose (continue / stop / accept), the accept
     * reason and its ACTUAL applied/refused outcome, and the tasks a stop withheld. It is
     * a REPORT fact only: it is not a second task state, and it never certifies that an
     * artifact exists or that a test passed.
     */
    if (o.checkpoint === true) {
      report.checkpoints = {
        enabled: true,
        prompts: checkpointEntries.length,
        entries: checkpointEntries,
        stop: checkpointStop,
        /*
         * B4.6a (P2)/B4.6b: the note must state the REAL effect, and must not describe an
         * `accept` as read-only. Three distinguishable cases are worded separately:
         *   - a stop (as before): the awaiting step is left UNVERIFIED, prior verdicts kept;
         *   - a real user ACCEPT: that task became succeeded on the USER's verdict, which
         *     is not a LAYA decision, a model review, or proof of a test/artifact;
         *   - continue-only: the checkpoint itself verified nothing.
         */
        note: (() => {
          if (checkpointStop !== null) {
            const refusedAccept = checkpointEntries.some((e) => e.acceptOutcome === 'refused');
            return 'OPT-IN user supervision only: no supervisor model was called. The user STOPPED at a checkpoint'
              + (refusedAccept ? ' (an accept was refused by a checkpoint recheck or the existing verification authority)' : '')
              + ': the step awaiting verification is left UNVERIFIED, tasks verified BEFORE the stop keep their verdict, and nothing further runs. A stop is not a certification that any artifact exists or any test passed.';
          }
          if (checkpointEntries.some((e) => e.acceptOutcome === 'applied')) {
            return 'OPT-IN user verification by the human: the user explicitly ACCEPTED the displayed task(s) through the existing verification authority, so that task became succeeded on the USER\'s verdict - NOT a LAYA decision, a model review, or proof that a test passed or an artifact exists. "continue" choices verify nothing themselves, and no supervisor model was called by the checkpoint.';
          }
          return 'OPT-IN user supervision only: no supervisor model was called. The checkpoint itself verifies nothing: "continue" only let the existing LAYA verification/scheduling proceed, and no task became succeeded because of it. It is not a certification that any artifact exists or any test passed.';
        })(),
      };
    }
    /*
     * B4.1: the collaboration group's identity is reported FROM THE AUTHORITIES, after
     * Assignment and execution. B4.1a (P2) fixes what this projection may CLAIM:
     *
     *   - an unassigned member is still LISTED (the plan's headcount is never hidden),
     *     with its real status, and it is NOT counted as a selected pair — the plan-era
     *     `agentId` on a task that Assignment refused is not a chosen Agent x Model, and
     *     an `agent/null` placeholder is not a pair;
     *   - `distinctPairs` counts only KNOWN, ASSIGNED pairs, and `pairIsDistinct` is only
     *     true when every member is assigned and those pairs are actually distinct;
     *   - what the MODE supports and what ACTUALLY RAN are separate fields, so an
     *     integration task that never ran cannot be read as "it wrote a file / read the
     *     deliveries / integrated them".
     *
     * Every fact here comes from the existing `assigned` outcomes, the TaskStore and the
     * AttemptStore — no report-side state store and no fact inference is introduced.
     */
    if (collaborationIds !== null) {
      const assignedOk = (taskId: string): boolean => assigned.find((a) => a.taskId === taskId)?.ok === true;
      const ran = (taskId: string): boolean => wb.evidence.history(taskId).length > 0;
      // B4.1a: the RECORDED provenance of each pair, from the existing `initialSelections`
      // authority — so a pair bound by the collaboration constraint rule is auditable and
      // can never be read as a LAYA comparison, a probability, or a user-fixed pair.
      const selectionProvider = (taskId: string): string | null =>
        wb.initialSelectionRecords().find((s) => s.taskId === taskId)?.provider ?? null;
      const knownPair = (agentId: string | null, modelId: string | null): string | null =>
        typeof agentId === 'string' && agentId !== '' && typeof modelId === 'string' && modelId !== ''
          ? `${agentId}/${modelId}`
          : null;
      const memberRows = collaborationIds.memberIds.map((taskId, i) => {
        const task = wb.store.get(taskId);
        const session = wb.sessionForTask(taskId);
        const planSpecMember = collaborationMembers[i];
        const isAssigned = assignedOk(taskId);
        const agentId = task?.agentId ?? null;
        const modelId = task?.modelId ?? null;
        return {
          index: i + 1,
          taskId,
          role: planSpecMember?.role ?? 'unknown',
          fileScope: planSpecMember?.fileScope ?? 'unknown',
          status: task?.status ?? 'missing',
          assigned: isAssigned,
          ran: ran(taskId),
          agentId,
          modelId,
          // Only an ASSIGNED member can carry a known pair; an unassigned task keeps its
          // plan-era agentId but that is intent, not a selected pair.
          pair: isAssigned ? knownPair(agentId, modelId) : null,
          selectionProvider: selectionProvider(taskId),
          sessionId: session?.sessionId ?? null,
        };
      });
      const integratorTask = wb.store.get(collaborationIds.integratorId);
      const integratorSession = wb.sessionForTask(collaborationIds.integratorId);
      const integratorMemberTaskId = collaborationIds.memberIds[collaborationIds.integratorIndex - 1]!;
      const integratorAssigned = assignedOk(collaborationIds.integratorId);
      const integratorMember = memberRows.find((m) => m.taskId === integratorMemberTaskId);
      const knownPairs = memberRows.map((m) => m.pair).filter((p): p is string => p !== null);
      const distinctKnown = new Set(knownPairs).size;
      const everyMemberAssigned = memberRows.every((m) => m.assigned);
      // B4.5 (P2): the ONE physical-workspace projection, read from the real WorkspaceManager
      // handle after execution. `path: null` means no group worktree was created this round
      // (e.g. worktree creation failed or every member was refused before dispatch) — it is
      // NEVER the user's cwd. `collaborationWorkspaceDescription` and `report.workspace` are
      // derived from this SAME object, so no report field can claim a directory that does not
      // exist or describe per-writing-task worktrees for a shared group.
      const collabWorkspace: { owner: string | null; path: string | null; branch: string | null; baseSha: string | null; note: string } = (() => {
        if (workspace === null) {
          return {
            owner: collaborationGroupOwner,
            path: null, branch: null, baseSha: null,
            note: 'non-git cwd: members share the caller\'s working directory in order (unchanged mode)',
          };
        }
        const handle = collaborationGroupOwner === null ? null : workspace.get(collaborationGroupOwner);
        if (handle === null) {
          return {
            owner: collaborationGroupOwner,
            path: null, branch: null, baseSha: null,
            note: 'no group worktree was created this round (no member reached dispatch)',
          };
        }
        return {
          owner: handle.taskId,
          path: handle.cwd,
          branch: handle.branch,
          baseSha: handle.baseSha,
          note:
            'the worktree starts from the committed base; uncommitted files in your checkout are NOT copied in, ' +
            'so commit or stash them first (or bring them in another way) if the group needs them',
        };
      })();
      report.collaboration = {
        enabled: true,
        choice: collaborationPlanUsed,
        members: memberRows,
        integrator: {
          index: collaborationIds.integratorIndex,
          memberTaskId: integratorMemberTaskId,
          taskId: collaborationIds.integratorId,
          status: integratorTask?.status ?? 'missing',
          assigned: integratorAssigned,
          ran: ran(collaborationIds.integratorId),
          agentId: integratorTask?.agentId ?? null,
          modelId: integratorTask?.modelId ?? null,
          pair: integratorAssigned ? knownPair(integratorTask?.agentId ?? null, integratorTask?.modelId ?? null) : null,
          selectionProvider: selectionProvider(collaborationIds.integratorId),
          sessionId: integratorSession?.sessionId ?? null,
        },
        // Only KNOWN, ASSIGNED pairs are counted; an agent/null placeholder is not a pair.
        distinctPairs: distinctKnown,
        pairIsDistinct: everyMemberAssigned && knownPairs.length === memberRows.length && distinctKnown === memberRows.length,
        integratorReusesMemberPair:
          integratorAssigned && integratorMember !== undefined && integratorMember.assigned &&
          integratorMember.agentId === (integratorTask?.agentId ?? null) &&
          integratorMember.modelId === (integratorTask?.modelId ?? null),
        // WHAT THE MODE SUPPORTS — a property of the plan, not a claim about this run.
        supportedWorkspace:
          workspace === null
            ? 'shared sequential workspace (non-git cwd): members write into the same working directory in order, ' +
              'so the integration task can read their files'
            : 'one shared git worktree owned by the round root: members run sequentially in the SAME worktree so the ' +
              'integration task reads their real files; the user\'s own checkout is never the cwd and is never merged into',
        // WHAT ACTUALLY HAPPENED — the physical workspace, read from the real
        // WorkspaceManager after execution. `null` path means no group worktree was
        // created (e.g. every member was refused before dispatch), never the user cwd.
        workspace: collabWorkspace,
        // WHAT ACTUALLY HAPPENED — derived from the Assignment outcomes and the AttemptStore.
        execution: {
          membersAssigned: memberRows.filter((m) => m.assigned).length,
          membersRan: memberRows.filter((m) => m.ran).length,
          integrationAssigned: integratorAssigned,
          integrationRan: ran(collaborationIds.integratorId),
          allMembersSucceeded: memberRows.every((m) => m.status === 'succeeded'),
        },
      };
      // B4.5 (P2): ONE description, derived from `collabWorkspace`, reused by the top-level
      // `report.workspace`, the review's resource signals and the non-JSON output. A group that
      // created NO worktree says exactly that rather than claiming a directory. `owner` is the
      // physical owner the handle is keyed by (the round root); `path`/`branch` are the real
      // handle's, so this can never disagree with `report.collaboration.workspace`.
      collaborationWorkspaceDescription = workspace === null
        ? 'shared sequential workspace (non-git cwd): the collaboration group writes into the caller\'s working directory in order'
        : (collabWorkspace.path === null
          ? `the collaboration group created NO worktree this round (owner ${String(collabWorkspace.owner)}); no shared directory is claimed`
          : `one SHARED git worktree for the collaboration group at ${String(collabWorkspace.path)} ` +
            `(owner ${String(collabWorkspace.owner)}, branch ${String(collabWorkspace.branch)})`);
      report.workspace = {
        isolation: workspace === null
          ? 'shared sequential workspace (non-git cwd): the collaboration group shares the caller\'s working directory in order'
          : (collabWorkspace.path === null
            ? 'git repository, but the collaboration group created NO worktree this round; no shared directory is claimed'
            : `one SHARED git worktree for the collaboration group (owner ${String(collabWorkspace.owner)}, ` +
              `path ${String(collabWorkspace.path)})`),
        repoRoot,
        // The group writes in ONE worktree, sequentially, so parallel writing stays CLOSED.
        parallelWriteIsolated: workspace !== null,
        group: collabWorkspace,
      };
    }
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
  /*
   * B3.1: the skill report is OPT-IN and truthful per task. It is built ONLY when
   * `--skill-catalog` was given, so a round without the flag has a byte-identical report.
   *
   * Each entry keeps the REQUEST (what LAYA chose, and where), the ADMISSION (the name SAVED
   * and bound into the advisory brief at selection time — a saved binding, not a later
   * re-read and not proof the task ran) and the OBSERVATION (completed native `skill` tool
   * events from THIS task's OWN latest run result only) in separate fields, so a late run by
   * a DIFFERENT agent can never be read as the request having been honoured. A call is
   * labelled `equalsRequested` only when the SAME assigned agent emitted it. An absent run is
   * `observation: null`, never a fabricated success.
   */
  if (skillCatalog !== null) {
    const skillRuns = wb.runResults();
    report.skillCatalog = {
      agentId: skillCatalog.agentId,
      offered: skillCatalog.skills.map((s) => s.name),
      note: 'USER-DECLARED candidates only; not discovered by the orchestrator and not proven installed',
    };
    report.skills = assigned
      .filter((a) => a.ok && skillSelections.has(a.taskId))
      .map((a) => {
        const sel = skillSelections.get(a.taskId)!;
        return projectSkillReport({
          taskId: a.taskId,
          requested: sel.requestedName,
          admitted: sel.admittedName,
          source: sel.source,
          reason: sel.reason,
          assignedAgentId: sel.agentId,
          assignedModelId: sel.modelId,
          run: skillRuns.get(a.taskId) ?? null,
        });
      });
  }
  /*
   * B3.2: the MCP report is OPT-IN and truthful per task. It is built ONLY when
   * `--mcp-catalog` was given, so a round without the flag has a byte-identical report.
   *
   * Each entry keeps the REQUEST (what LAYA chose, and where), the ADMISSION (the tuple SAVED
   * and bound into the advisory brief at selection time — a saved binding, not a later re-read
   * and not proof the task ran) and the OBSERVATION (completed native tool events from THIS
   * task's OWN latest run result whose EXACT name matches an offered declaration). A run by a
   * DIFFERENT agent can never be read as the request having been honoured. An absent run is
   * `observation: null`, never a fabricated success. The observation asserts a NAME MATCH
   * against a user declaration — never verified MCP protocol/server identity.
   */
  if (mcpCatalog !== null) {
    const mcpRuns = wb.runResults();
    report.mcpCatalog = {
      agentId: mcpCatalog.agentId,
      offered: mcpCatalog.tools.map((t) => ({ server: t.server, tool: t.tool, nativeName: t.nativeName })),
      note: 'USER-DECLARED candidates only; not discovered by the orchestrator, not a connected or authorized MCP server, and not proven installed',
    };
    report.mcpTools = assigned
      .filter((a) => a.ok && mcpSelections.has(a.taskId))
      .map((a) => {
        const sel = mcpSelections.get(a.taskId)!;
        return projectMcpReport({
          taskId: a.taskId,
          requested: sel.requested,
          admitted: sel.admitted,
          source: sel.source,
          reason: sel.reason,
          assignedAgentId: sel.agentId,
          assignedModelId: sel.modelId,
          offered: mcpCatalog!.tools,
          run: mcpRuns.get(a.taskId) ?? null,
        });
      });
  }
  /*
   * B2.1: the user model pool report is OPT-IN and truthful. It is built ONLY when
   * `--model-pool` was given, so a round without the flag has a byte-identical report.
   *
   * It states the POLICY, the SCOPE (orchestrator-managed runs of THIS round only) and
   * the guarantees this slice does NOT make (no verified free/account eligibility, no
   * USD budget, no paid authorization), plus each declaration's provenance, timestamps
   * and its CURRENT eligibility with the exact predicate reason code. A declaration is
   * NEVER reported as "free" — only as the user's `billing` claim, judged admissibly.
   */
  if (modelPool !== null) {
    const poolNow = Date.now();
    report.modelPool = {
      policy: modelPool.policy,
      source: o.modelPool,
      scope: 'constrains only the orchestrator-managed execution requests of THIS round; it does not constrain a native agent\'s own internal/auxiliary calls, the reviewer, or any model the orchestrator did not select',
      unsupported: {
        paid: 'this flag authorizes NO paid use: a `paid` (or `unknown`) declaration is refused, and a self-declared approval cannot buy one',
        cost: 'a `free`/`included` declaration is the USER\'s statement with provenance and an expiry, NOT verified free entitlement, pricing or account eligibility; no USD budget or pricing check exists here',
        wholeWorkflow: 'this says nothing about native auxiliary spend (e.g. a small_model) or the reviewer, so it must never be read as "the whole workflow is free"',
      },
      entries: modelPool.models.map((e) => {
        const verdict = admitUserModelPoolPair(modelPool!, { agentId: e.agentId, modelId: e.modelId }, poolNow);
        return {
          agentId: e.agentId,
          modelId: e.modelId,
          billing: e.billing,
          source: e.source,
          observedAt: e.observedAt,
          expiresAt: e.expiresAt,
          eligibility: verdict.allowed
            ? { allowed: true, code: null, detail: null }
            : { allowed: false, code: verdict.code, detail: verdict.detail },
        };
      }),
      note: 'USER DECLARATIONS only; not verified free/account eligibility, and not a paid authorization',
    };
  }
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
    // B4.5 (P2): a collaboration group does NOT get per-writing-task worktrees, so it must not
    // be described that way. Reuse the ONE group-workspace description built from the real
    // handle; other (non-group) modes keep their previous wording unchanged.
    o.workflow === 'collaborate' && collaborationWorkspaceDescription !== null
      ? `collaboration group workspace: ${collaborationWorkspaceDescription}`
      : workspace === null
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

  // B4.5 (P1-1): WHERE the round review must read.
  //
  // A git collaboration group's members and integrator write into ONE shared worktree, so
  // that worktree is the ONLY directory holding this round's real bytes. Reviewing the user's
  // checkout would show an empty round (and could mistake unrelated user files for this
  // round's result). The cwd is read from the SAME WorkspaceManager owner handle
  // `report.collaboration.workspace` reports, so the two cannot disagree.
  //
  // It is NEVER borrowed from the user's cwd: if the group's worktree was not created, or a
  // git operation left a RETAINED protection because its stop was never confirmed, the review
  // is WITHHELD (a non-PASS status) instead of being run against the checkout. Every other
  // mode keeps `o.cwd` exactly as before.
  let reviewCwd: string = o.cwd;
  let groupReviewWithheld: string | null = null;
  if (o.workflow === 'collaborate' && workspace !== null) {
    const owner = collaborationGroupOwner;
    const retained = owner !== null && workspace.unconfirmedProtections().some((p) => p.taskId === owner);
    const handle = owner === null ? null : workspace.get(owner);
    if (retained) {
      groupReviewWithheld =
        `the collaboration group's shared worktree (owner "${String(owner)}") still holds a RETAINED protection ` +
        'because a git operation\'s descendant stop was never confirmed, so the worktree is not safe to read; ' +
        'the review is withheld rather than pointed at your checkout';
    } else if (handle === null) {
      groupReviewWithheld =
        'the collaboration group\'s shared worktree was never created this round, so there is no group result to ' +
        'review; the review is withheld rather than pointed at your checkout';
    } else {
      reviewCwd = handle.cwd;
    }
  }

  let unifiedReview: UnifiedReviewResult;
  if (groupReviewWithheld !== null) {
    // B4.5 (P1-1): the group's physical workspace is not usable, so no read review is run.
    // This is the existing WITHHELD shape (the reviewer never ran, holds no opinion), reused
    // rather than inventing a new status or a fabricated verdict.
    unifiedReview = {
      status: 'execution_incomplete',
      reviewer: o.reviewAgent,
      verdict: null,
      reason: groupReviewWithheld,
      findings: [],
      recommendations: [],
      outputTail: null,
      code: 'group-workspace-unavailable',
      reviewedAt: null,
    };
  } else if (executionIncomplete) {
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
    // B4.5a: when the incomplete fact is a RUNTIME retained resource protection on THIS
    // collaboration group's physical workspace (not a fan-out member that never ran), the
    // reason says so. The WITHHELD status, code and "no review was run" outcome are the
    // SAME existing shape — this only names the actual cause honestly.
    unifiedReview = {
      status: 'execution_incomplete',
      reviewer: o.reviewAgent,
      verdict: null,
      reason: groupRuntimeRetained !== null
        ? `the collaboration group's shared worktree still holds a RETAINED runtime resource protection ` +
          `(task "${groupRuntimeRetained.taskId}" ${groupRuntimeRetained.mode}` +
          `${groupRuntimeRetained.retentionReason === null ? '' : `: ${groupRuntimeRetained.retentionReason}`}), ` +
          'because an execution entered the edge and its tree stop was never confirmed, so no review was run; ' +
          'the round is unfinished rather than reviewed'
        // B5.1: a known session failure whose process-tree stop was never confirmed is its
        // OWN cause, named as such — never reported as a fan-out of zero members.
        : handoffStopUnconfirmed
          ? `a known session failure left an execution whose process-tree stop was never confirmed ` +
            `(${continuation?.stopped.code ?? 'stop-unconfirmed'}), so no second writer was started and no ` +
            'review was run; the round is unfinished rather than reviewed'
          // B4.6a (P2): a real user STOP is named as a checkpoint stop, not as a fan-out.
          : checkpointStop !== null
            ? `the user stopped at a checkpoint on ${checkpointStop.taskId}: ${checkpointStop.reason}; ` +
              `${checkpointStop.blockedTaskIds.length} task(s) were withheld` +
              `${checkpointStop.blockedTaskIds.length === 0 ? '' : ` (${checkpointStop.blockedTaskIds.join(', ')})`}, ` +
              'so no review was run; the round is unfinished rather than reviewed'
            // B4.6a (P2): a sequential/collaborate workflow that did not complete is a
            // WORKFLOW gap, not a fan-out (which has zero requested members here).
            : workflowIncomplete
              ? `the workflow is incomplete: ${workflowPending.length} member(s) did not reach succeeded ` +
                `(${workflowPending.map((m) => `${m.taskId}=${m.status}`).join(', ')}), so no review was run; ` +
                'the round is unfinished rather than reviewed'
              : `the fan-out execution set is incomplete (${fanoutDrain.unresolvedAtStop.length} requested member(s) never reached an execution resolution), so no review was run; the round is unfinished rather than reviewed`,
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
        // B4.5 (P1-1): the GROUP worktree for a git collaboration group, `o.cwd` otherwise.
        cwd: reviewCwd,
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
  // B4.1: `ok` is part of this shape in BOTH states. The placeholder used to carry only
  // `recorded`, so a reader that checked `reviewEvidence.ok` on a round that never got
  // that far saw `undefined` (falsy, but for the wrong reason) while a successful append
  // replaced the whole object with the `{ok, attemptId, code, reason}` shape from
  // `recordReviewEvidence`. Both keys are now always present, so "was it accepted?" has
  // one answer rather than two shapes to remember.
  report.reviewEvidence = { ok: false, recorded: false, attemptId: null, code: null, reason: null };
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
  // B5.1: the concrete pair chain, additive beside `handoffAgentChain`. The pair chain is
  // what proves a same-agent different model was a REAL change; `handoffAgentChain` is kept
  // for compatibility and must not be read as authenticating an actual model.
  report.handoffWorkerChain = Object.fromEntries(
    [...handoffWorkerChain.entries()].map(([k, v]) => [k, v.map((w) => ({ ...w }))]),
  );

  // R2-3: handoff visibility in the round report. Recorded as a FACT (who, why, which
  // task, which attempt) rather than as a narrative, so the stop reason is always visible
  // — including when no handoff happened, which must not read as "everything was fine".
  report.handoff = checkpointStop !== null
    // B4.6a: the user stopped at a checkpoint, so the continuation was deliberately not
    // started. Reported as such — NEVER as "--no-handoff", which would be a false reason.
    ? {
        enabled: o.handoff, happened: 0, limit: o.handoffMax, handoffs: [],
        stopped: {
          code: 'user-stop',
          reason: `the user stopped at a checkpoint on ${checkpointStop.taskId}: ${checkpointStop.reason}`,
        },
      }
    : continuation === null
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
          // B5.1: the REQUESTED/ASSIGNED models, shown so two models of the same agent are
          // visible as a real change. These are not an authentication of the model that
          // actually ran.
          fromModelId: hd.fromModelId,
          toModelId: hd.toModelId,
          previousAttemptId: hd.previousAttemptId,
          decision: hd.decisionAction,
          decisionApplied: hd.decisionApplied,
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
    w(`  workspace     ${
      o.workflow === 'collaborate' && collaborationWorkspaceDescription !== null
        ? collaborationWorkspaceDescription
        : workspace === null
          ? 'SHARED cwd - isolation unavailable (not a git repository)'
          : `isolated worktrees (repo ${repoRoot})`
    }`);
    if (collaborationIds !== null) {
      w(`  collaboration ${collaborationPlanUsed} (${workflowPlanSource}); integration by collaborator ${collaborationIntegratorMember}`);
      for (const id of collaborationIds.memberIds) {
        const t = wb.store.get(id);
        w(`    member      ${id} (${t?.taskType ?? '?'}) ${t?.agentId ?? '?'}/${t?.modelId ?? '?'} session=${wb.sessionForTask(id)?.sessionId ?? 'none'}`);
      }
      const intTask = wb.store.get(collaborationIds.integratorId);
      w(`    integrator  ${collaborationIds.integratorId} (reuses ${collaborationIds.memberIds[collaborationIds.integratorIndex - 1]}) ${intTask?.agentId ?? '?'}/${intTask?.modelId ?? '?'} session=${wb.sessionForTask(collaborationIds.integratorId)?.sessionId ?? 'none'}`);
    }
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
    // B3.1: the advisory skill projection, printed only when the flag opted in.
    if (o.skillCatalog !== undefined) {
      const skillRows = (report.skills ?? []) as SkillReportEntry[];
      w();
      w('SKILLS (advisory request only; not an enforceable tool authorization)');
      if (skillRows.length === 0) w('  (no initially assigned task was considered)');
      for (const s of skillRows) {
        w(`  ${s.taskId}  requested=${s.requested ?? '(none)'}  admitted=${s.admitted ?? '(none)'}  source=${s.selectionSource}`);
        if (s.observation === null) {
          w('      observed tool-events: none (no run result)');
        } else {
          const calls = s.observation.skillCalls.length === 0
            ? 'none'
            : s.observation.skillCalls.map((c) => `${c.name}${c.equalsRequested ? '' : ' (unrequested)'}`).join(', ');
          w(`      observed tool-events: ${calls}  (runtime task ${s.observation.runtime.taskId ?? '-'}, agent ${s.observation.runtime.agentId ?? '-'})`);
          // A run by a DIFFERENT agent is shown as an origin mismatch, so a same-named call
          // can never read as this request being honoured by the wrong worker.
          if (!s.observation.agentMatchesAssignment) {
            w(`      ORIGIN MISMATCH: the observed run is agent ${s.observation.runtime.agentId ?? '(unknown)'}, but this request was assigned to ${s.assignedAgentId}; the observation is NOT this request being honoured`);
          }
        }
      }
    }
    // B3.2: the advisory MCP tool projection, printed only when the flag opted in.
    if (o.mcpCatalog !== undefined) {
      const mcpRows = (report.mcpTools ?? []) as McpReportEntry[];
      w();
      w('MCP TOOLS (advisory request only; CATALOG-NAME-MATCHED native events; not verified MCP identity, connection or authorization)');
      if (mcpRows.length === 0) w('  (no initially assigned task was considered)');
      for (const s of mcpRows) {
        const fmt = (t: McpToolTuple | null): string => (t === null ? '(none)' : `${t.server}/${t.tool} [native ${t.nativeName}]`);
        w(`  ${s.taskId}  requested=${fmt(s.requested)}  admitted=${fmt(s.admitted)}  source=${s.selectionSource}`);
        if (s.observation === null) {
          w('      observed catalog-name-matched tool-events: none (no run result)');
        } else {
          const calls = s.observation.toolCalls.length === 0
            ? 'none'
            : s.observation.toolCalls.map((c) => `${c.nativeName}${c.equalsRequested ? '' : ' (unrequested)'}`).join(', ');
          w(`      observed catalog-name-matched tool-events: ${calls}  (runtime task ${s.observation.runtime.taskId ?? '-'}, agent ${s.observation.runtime.agentId ?? '-'})`);
          // A run by a DIFFERENT agent is shown as an origin mismatch, so a same-named call
          // can never read as this request being honoured by the wrong worker.
          if (!s.observation.agentMatchesAssignment) {
            w(`      ORIGIN MISMATCH: the observed run is agent ${s.observation.runtime.agentId ?? '(unknown)'}, but this request was assigned to ${s.assignedAgentId}; the observation is NOT this request being honoured`);
          }
        }
      }
    }
    // B2.1: the user model pool projection, printed only when the flag opted in. It is
    // deliberately explicit that a declaration is NOT verified and does NOT authorize
    // paid use, and that it covers only this round's orchestrator-managed runs.
    if (o.modelPool !== undefined) {
      const pool = report.modelPool as {
        policy: string;
        scope: string;
        unsupported: Record<string, string>;
        entries: Array<{ agentId: string; modelId: string; billing: string; source: string; observedAt: number; expiresAt: number; eligibility: { allowed: boolean; code: string | null } }>;
      };
      w();
      w('MODEL POOL (user declaration only; NOT verified free/account eligibility; authorizes NO paid use)');
      w(`  policy       ${pool.policy}`);
      w(`  scope        ${pool.scope}`);
      w(`  paid         ${pool.unsupported.paid}`);
      w(`  cost         ${pool.unsupported.cost}`);
      if (pool.entries.length === 0) {
        w('  (no model declared: the pool is deny-all)');
      }
      for (const e of pool.entries) {
        w(`  ${e.agentId}/${e.modelId}  billing=${e.billing}  eligibility=${e.eligibility.allowed ? 'allowed' : `refused (${e.eligibility.code})`}`);
        w(`      source=${e.source}  observedAt=${e.observedAt}  expiresAt=${e.expiresAt}`);
      }
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
      handoffs: Array<{ taskId: string; reason: string; fromAgentId: string | null; toAgentId: string | null; fromModelId?: string | null; toModelId?: string | null; previousAttemptId: string | null }>;
      stopped: { code: string; reason: string };
    };
    w('接力（Agent Handoff）');
    if (!handoffInfo.enabled || handoffInfo.happened === 0) {
      w(`  未发生接力 — ${handoffInfo.stopped.reason}`);
    } else {
      w(`  ${handoffInfo.happened} / ${handoffInfo.limit}`);
      for (const hd of handoffInfo.handoffs) {
        // B5.1: show the REQUESTED pair (agent AND model) so a same-agent model change is
        // visible; these are requested/assigned models, not proof of what actually ran.
        const from = `${hd.fromAgentId ?? '?'}/${hd.fromModelId ?? 'default'}`;
        const to = `${hd.toAgentId ?? '?'}/${hd.toModelId ?? 'default'}`;
        w(`  ${hd.taskId}  ${from} → ${to}  原因=${hd.reason}`);
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
    // B4.4: the user DELIVERY view. It is the SAME pure renderer the published
    // `roundResultReport` embeds, so the terminal and the JSON cannot disagree about
    // what each task delivered. It reads nothing and starts nothing.
    w();
    w(renderRoundDelivery(roundResult));
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
