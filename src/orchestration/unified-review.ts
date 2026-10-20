/**
 * src/orchestration/unified-review.ts — the ONE review step every Execution Round ends with.
 *
 * WHAT CHANGED, AND WHY IT IS NOT OPTIONAL
 * ---------------------------------------
 * Before this, a round ended when execution ended: tasks reached `to_verify` or `failed`
 * and the report told the operator "next per the product model: Codex review, then a
 * human gate" — a note to a human. In practice the common paths just ended:
 *
 *     success  -> maybe a review, if a task happened to sit in to_verify
 *     failure  -> END
 *     quota    -> END
 *     refused  -> END
 *
 * That gap is what this closes. EVERY terminal outcome now flows through the same review,
 * so "the round finished" and "the round was reviewed" are one event. A failure is exactly
 * as worth reviewing as a success — often more so, because a failure is where a plausible
 * wrong answer is most likely.
 *
 * WHAT IT IS NOT (all four matter)
 * --------------------------------
 *   NOT a second decision brain. It cannot plan, assign, dispatch or transition a task.
 *   NOT a second scheduler. It runs once, after the round's own dispatch is over.
 *   NOT a completion authority. `Verification` remains the only thing that can write
 *     `succeeded`; a review verdict NEVER touches TaskStore.
 *   NOT a workflow engine. A `rework` verdict is a RECOMMENDATION to the user. There is
 *     deliberately no code path from a verdict to retry / reassign / replan, and
 *     `tests/unified-review.test.ts` asserts that absence rather than trusting it.
 *
 * ONE EXECUTION EDGE, NO NEW AUTHORITY
 * -------------------------------------
 * The review runs through the EXISTING native review seam (`RuntimeOrch.review`, which
 * forwards to `run({mode:'review'})`), injected as `NativeReviewer`. No second
 * `runtime.run(` call site is added, and no new adapter, registry or session authority:
 * Codex is reviewed by the same Codex adapter on the same edge as any other native agent.
 *
 * IT REUSES THE EVIDENCE PROJECTION THAT ALREADY EXISTS
 * ------------------------------------------------------
 * Per task the packet carries TWO things, both read from authorities that already own
 * them — neither is rebuilt here:
 *
 *   - the prompt, via `NativeWorkbench.briefFor()` — the ONE function that composes what
 *     a worker is told, so two callers cannot brief a task differently
 *   - the evidence, via `buildHandoff()` — the existing projection that already derives
 *     `changedFiles` / `testsRun` / `decisions` / `unresolved` / `completedWork` from a
 *     `RunResult`
 *
 * Inventing a second, parallel field list for "what the reviewer should see" would let
 * the review and the handoff chain drift apart, and a review that disagrees with the
 * handoff is worse than no review.
 *
 * EVIDENCE IS NEVER AT RISK FROM A REVIEW FAILURE
 * -----------------------------------------------
 * If Codex is unauthenticated, out of quota, slow or broken, the result is
 * `unavailable` / `failed` with a reason — never a fabricated verdict, never a retry loop.
 * The round's execution evidence is reported either way. A missing review must never look
 * like a successful one, and must never erase what actually ran.
 */

import { fileURLToPath } from 'node:url';
import type { RunHandle, RunRequest, RunResult, TaskState } from '../core/types.ts';
import type { TaskStatus } from './task.ts';
import type { TaskType } from '../quota/types.ts';
import type { TaskHandoff } from './workbench-handoff.ts';
import type { CompletionTestEvidenceView } from './completion-evidence.ts';
import {
  normalizeReviewOutput,
  reviewInstructions,
  validateReviewVerdict,
  type ReviewFinding,
  type ReviewVerdict,
  type ReviewVerdictValue,
} from './review-verdict.ts';

// ---------------------------------------------------------------------------
// 1. The unified terminal-outcome vocabulary
// ---------------------------------------------------------------------------

/**
 * Every terminal outcome a round can end a task in.
 *
 * `refused` is an eleventh member beyond the ten the product model names, and it is
 * deliberate: the real system refuses work at admission for reasons that are neither
 * resource nor lease nor quota (an unmet dependency, a task that is not executable, a
 * concurrency ceiling). Folding those into `failed` would report a refusal as an agent
 * failure, which is precisely the misattribution this project's admission layer exists to
 * prevent. `refused` keeps "nothing ran, nobody is to blame" visible.
 */
export const EXECUTION_OUTCOMES = [
  'success',
  'failed',
  'error',
  'timeout',
  'quota_exhausted',
  'agent_unavailable',
  'session_failure',
  'resource_refused',
  'lease_refused',
  'cancelled',
  'refused',
] as const;
export type ExecutionOutcomeKind = (typeof EXECUTION_OUTCOMES)[number];

/**
 * The real refusal codes this system produces, mapped to the unified vocabulary.
 *
 * Every key is a code that EXISTS in the tree, not an invented one. The code is never
 * discarded — it travels in `ExecutionOutcome.code` — so classifying a refusal as
 * `refused` loses no detail.
 */
const REFUSAL_CODE_MAP: Readonly<Record<string, ExecutionOutcomeKind>> = Object.freeze({
  // Resource admission (R2-1 / R2-1.1).
  'resource-conflict': 'resource_refused',
  'resource-unavailable': 'resource_refused',
  // Lease / fencing (R2-2). Each of these means "this result may not be written back".
  'lease-not-live': 'lease_refused',
  'lease-revoked': 'lease_refused',
  'lease-expired': 'lease_refused',
  'lease-not-renewable': 'lease_refused',
  'stale-lease-version': 'lease_refused',
  'fencing-token-missing': 'lease_refused',
  'fencing-token-mismatch': 'lease_refused',
  'agent-mismatch': 'lease_refused',
// Quota / budget admission.
  //
  // R2-3 NOTE: `quota-exhausted` and `agent-unavailable` are the codes the SPAWN GATE
  // actually denies with (`GATE_DENY_CODES`), which reach here verbatim because
  // `executeTask` returns `decision.result.code` unsmoothed. They are the real,
  // quota-driven refusals and are mapped as such.
  //
  // `quota-unavailable` is DELIBERATELY NOT `quota_exhausted`. It means the quota status
  // is `unknown` / `not_fetched` / `not_connected` — headroom could not be confirmed. The
  // gate refuses to spend blindly, which is correct; but reporting it as "exhausted"
  // would let an unknown quota look like a known-empty one, and (R2-3) would then let it
  // trigger an automatic agent switch. "We do not know" must never become "this worker
  // is out of quota", so it stays `refused`.
  'quota-exhausted': 'quota_exhausted',
  'agent-unavailable': 'agent_unavailable',
  'quota-unavailable': 'refused',
  'capability-missing': 'refused',
  'model-unavailable': 'refused',
  'task-policy-denied': 'refused',
  // A concurrency ceiling is a transient queue condition, not a worker availability fact.
  'concurrency-limit': 'refused',
  'quota-blocked': 'quota_exhausted',
  'budget-insufficient': 'quota_exhausted',
  'insufficient-remaining': 'quota_exhausted',
  'outside-free-pool': 'quota_exhausted',
  'reservation-exceeded': 'quota_exhausted',
  'policy-blocked': 'quota_exhausted',
  // The agent could not be started (adapter/launcher refused, policy said unavailable).
  'runtime-rejected-run': 'agent_unavailable',
  'not-capable': 'agent_unavailable',
  'availability-unknown': 'agent_unavailable',
  'create-refused': 'agent_unavailable',
  // Transport / process level failures.
  'runtime-result-failed': 'error',
  'dispatch-threw': 'error',
});

/** `RunResult.error.code` values, mapped. These are the real runtime error codes. */
const RUN_ERROR_CODE_MAP: Readonly<Record<string, ExecutionOutcomeKind>> = Object.freeze({
  NONZERO_EXIT: 'failed',
  TIMED_OUT: 'timeout',
  SPAWN_FAILED: 'agent_unavailable',
  TRANSPORT_ERROR: 'session_failure',
  CANCELLED: 'cancelled',
});

/** One task's terminal outcome, as the unified round sees it. */
export interface ExecutionOutcome {
  readonly taskId: string;
  readonly outcome: ExecutionOutcomeKind;
  /** Authoritative TaskStore status, kept beside the classification. */
  readonly taskStatus: TaskStatus;
  /** The REAL code, preserved. Never replaced by the unified name. */
  readonly code: string | null;
  readonly reason: string | null;
  readonly agentId: string | null;
  readonly modelId: string | null;
  /**
   * Did a native process actually run for this task?
   *
   * This is what separates "evidence exists" from "nothing ran", and it is why a task
   * whose write-back was REFUSED (R2-2 / F5) is still reviewable evidence rather than a
   * gap: the process ran even though the result was not allowed to land.
   */
  readonly executed: boolean;
  /**
   * R2-3: was this task stopped at ADMISSION, before any execution?
   *
   * Added because a pure admission refusal (`quota-exhausted`, `resource-conflict`,
   * `capability-missing`) is a real terminal outcome that produces NO `AttemptRecord` and
   * NO `RunResult`. Anything that only infers outcomes from evidence therefore cannot see
   * it at all — which is how a quota refusal could fail to reach the handoff that exists
   * precisely for it.
   *
   * `refused && executed === false` is the honest shape: the task has an outcome, and
   * nothing ran. It is explicitly NOT a synthesised execution — no attempt is fabricated,
   * and F5 is untouched (if a process really ran, an attempt must exist).
   */
  readonly refused: boolean;
  readonly attemptIds: readonly string[];
}

export interface ClassifyInput {
  readonly taskId: string;
  readonly taskStatus: TaskStatus;
  readonly agentId?: string | null;
  readonly modelId?: string | null;
  /** Present when a run actually happened, even if its write-back was refused (F5). */
  readonly run?: RunResult | null;
  /** Present when execution was refused before a run existed. */
  readonly refusalCode?: string | null;
  readonly refusalReason?: string | null;
  readonly attemptIds?: readonly string[];
}

/**
 * Classify one task into the unified vocabulary.
 *
 * Precedence is deliberate, and each branch is documented because getting it wrong is how
 * a refusal becomes a fabricated failure:
 *
 *   1. a real refusal CODE wins over the task status — a task refused at admission never
 *      ran, so its status says nothing useful about how the round ended
 *   2. otherwise the RUN decides — a `RunResult` is a fact about what actually happened
 *   3. otherwise the task STATUS decides — for a task that never reached execution
 */
export function classifyExecutionOutcome(input: ClassifyInput): ExecutionOutcome {
  const base = {
    taskId: input.taskId,
    taskStatus: input.taskStatus,
    agentId: input.agentId ?? input.run?.agentId ?? null,
    modelId: input.modelId ?? null,
    attemptIds: input.attemptIds ?? [],
  } as const;

  // 1. Refused at admission: the refusal code IS the real reason.
  //
  // R2-2 / F5 matters here and is easy to get wrong: a task can carry a refusal code AND
  // a real `RunResult`, because the process ran and only the write-back was refused (a
  // stale lease, an agent mismatch). `executed` therefore comes from the RUN, never from
  // the presence of a refusal code. Hardcoding `false` here would erase real evidence —
  // the exact thing F5 exists to prevent — and would present executed work as a gap.
  if (input.refusalCode !== undefined && input.refusalCode !== null) {
    return {
      ...base,
      outcome: REFUSAL_CODE_MAP[input.refusalCode] ?? 'refused',
      code: input.refusalCode,
      reason: input.refusalReason ?? null,
      executed: input.run !== undefined && input.run !== null,
      // R2-3: this branch IS a refusal, so it is always `refused: true`. `executed`
      // carries the separate fact of whether a process ran, so the pure admission
      // refusal (`refused && !executed`) stays distinguishable from F5 (`refused &&
      // executed`). Collapsing the two here is what made a quota refusal invisible.
      refused: true,
    };
  }

  // 2. A run exists: it is the authoritative account of what happened.
  if (input.run !== undefined && input.run !== null) {
    const runState: TaskState = input.run.state;
    const runCode = input.run.error?.code ?? null;
    const byState: ExecutionOutcomeKind =
      runState === 'succeeded' ? 'success'
        : runState === 'timed_out' ? 'timeout'
          : runState === 'cancelled' ? 'cancelled'
            : 'failed';
    return {
      ...base,
      // A failed run's error CODE refines the classification (SPAWN_FAILED is not the
      // same event as NONZERO_EXIT) but can never turn a success into a failure.
      outcome: runState === 'succeeded'
        ? 'success'
        : (RUN_ERROR_CODE_MAP[runCode ?? ''] ?? byState),
      code: runCode,
      reason: input.run.error?.message ?? null,
      executed: true,
      // A run exists, so this was never stopped at admission.
      refused: false,
    };
  }

  // 3. No run and no refusal code: read the task's own terminal state.
  const byStatus: ExecutionOutcomeKind =
    input.taskStatus === 'succeeded' || input.taskStatus === 'to_verify' ? 'success'
      : input.taskStatus === 'failed' ? 'failed'
        : input.taskStatus === 'cancelled' ? 'cancelled'
          : 'refused';
  return { ...base, outcome: byStatus, code: null, reason: null, executed: false, refused: true };
}

// ---------------------------------------------------------------------------
// 2. The Review Packet
// ---------------------------------------------------------------------------

/** How much of a blob of text the packet carries. Bounded on purpose. */
export interface BoundedText {
  readonly text: string;
  /** True when the text was cut, so a reader never mistakes a tail for the whole thing. */
  readonly truncated: boolean;
  readonly originalLength: number;
}

export const DEFAULT_TEXT_TAIL_CHARS = 2_000;

/**
 * Tail-bound a blob of text.
 *
 * The packet must be reviewable WITHOUT re-reading every transcript: a reviewer needing
 * the full conversation follows `transcriptPath`. Copying whole transcripts into a prompt
 * is how a review becomes an unbounded token bill, so every human-scale field is
 * explicitly tailed and marked when truncated.
 */
export function tailText(text: string, maxChars: number = DEFAULT_TEXT_TAIL_CHARS): BoundedText {
  if (text.length <= maxChars) return { text, truncated: false, originalLength: text.length };
  return {
    text: text.slice(text.length - maxChars),
    truncated: true,
    originalLength: text.length,
  };
}

/** One task as the reviewer sees it: request, evidence, and classified outcome. */
export interface ReviewPacketTask {
  readonly taskId: string;
  readonly taskType: TaskType;
  readonly status: TaskStatus;
  /**
   * ACTUAL execution identity. For a fan-out member this is null unless the member actually
   * executed; it is never the Planner seed or a refused pair (T3-a.2).
   */
  readonly agentId: string | null;
  readonly modelId: string | null;
  readonly outcome: ExecutionOutcomeKind;
  readonly executed: boolean;
  /** What the worker was ACTUALLY told, from the brief authority. Tailed. */
  readonly prompt: BoundedText | null;
  /** The existing evidence projection. Null when no run happened. */
  readonly handoff: TaskHandoff | null;
  readonly approvedTest?: CompletionTestEvidenceView | null;
  readonly attemptIds: readonly string[];
  /** The assignment lease version this evidence ran under (R2-2). */
  readonly leaseVersion: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  /**
   * TeamRun T3-a.2: fan-out member provenance. Present only for a PARALLEL_READ member.
   * `requestedAgentId`/`requestedModelId` are what LAYA asked for (never the Planner seed),
   * so a refused member still shows what was requested even though `agentId`/`modelId`
   * (actual) are null.
   */
  readonly requestedAgentId?: string | null;
  readonly requestedModelId?: string | null;
  readonly memberIndex?: number;
  readonly assignmentStatus?: 'accepted' | 'refused';
  readonly assignmentRefusalReason?: string | null;
}

/**
 * Everything ONE review of ONE round is given.
 *
 * Deliberately a list of REFERENCES plus bounded tails, never a copy of the round's raw
 * data: the reviewer follows `transcriptPath` / `attemptId` / `changedFiles` for anything
 * not carried inline.
 */
export interface ReviewPacket {
  readonly roundId: string;
  readonly originalRequest: string;
  /** Laya's plan — the ONE decision brain's own output. */
  readonly layaPlan: BoundedText | null;
  readonly tasks: readonly ReviewPacketTask[];
  readonly executionOutcomes: readonly ExecutionOutcome[];
  readonly errors: readonly string[];
  readonly quotaSignals: readonly string[];
  readonly resourceSignals: readonly string[];
  /** Where the full machine evidence lives, for a reviewer who wants more. */
  readonly evidenceNote: string;
}

export interface BuildPacketInput {
  readonly roundId: string;
  readonly originalRequest: string;
  readonly layaPlan?: string | null;
  readonly tasks: readonly ReviewPacketTask[];
  readonly outcomes: readonly ExecutionOutcome[];
  readonly quotaSignals?: readonly string[];
  readonly resourceSignals?: readonly string[];
  readonly errors?: readonly string[];
  readonly evidenceNote?: string;
}

export function buildReviewPacket(input: BuildPacketInput): ReviewPacket {
  // Errors are DERIVED from the outcomes rather than typed twice, so one path cannot
  // report a refusal as an error while another reports it as a clean outcome.
  const derived: string[] = [];
  for (const o of input.outcomes) {
    if (o.outcome === 'success') continue;
    derived.push(`${o.taskId}: ${o.code ?? o.outcome}${o.reason === null ? '' : ` — ${o.reason}`}`);
  }
  return {
    roundId: input.roundId,
    originalRequest: input.originalRequest,
    layaPlan: input.layaPlan === undefined || input.layaPlan === null
      ? null
      : tailText(input.layaPlan),
    tasks: input.tasks,
    executionOutcomes: input.outcomes,
    errors: [...(input.errors ?? []), ...derived],
    quotaSignals: [...(input.quotaSignals ?? [])],
    resourceSignals: [...(input.resourceSignals ?? [])],
    evidenceNote: input.evidenceNote ?? 'AttemptStore holds the full append-only execution evidence.',
  };
}

/** Render the packet as the bounded text a reviewer actually reads. */
export function renderReviewPacket(packet: ReviewPacket): string {
  const lines: string[] = [];
  lines.push(`# Execution Round ${packet.roundId}`);
  lines.push('');
  lines.push('## Original request');
  lines.push(packet.originalRequest);

  if (packet.layaPlan !== null) {
    lines.push('');
    lines.push('## Plan produced by Laya (the only decision brain)');
    lines.push(packet.layaPlan.text);
    if (packet.layaPlan.truncated) {
      lines.push(`[plan truncated: ${packet.layaPlan.originalLength} chars total]`);
    }
  }

  lines.push('');
  lines.push(`## Tasks (${packet.tasks.length})`);
  for (const t of packet.tasks) {
    lines.push('');
    lines.push(`### ${t.taskId} — ${t.outcome} (status=${t.status}, type=${t.taskType}, ` +
      `agent=${t.agentId ?? '-'}, model=${t.modelId ?? '-'}, executed=${t.executed})`);
    // TeamRun T3-a.2: for a fan-out member, state the REQUESTED pair and Assignment's verdict
    // explicitly, so the reviewer can never read a never-executed refusal as "the agent failed".
    if (t.requestedAgentId !== undefined) {
      const verdict = t.assignmentStatus ?? 'accepted';
      lines.push(`fan-out member ${t.memberIndex ?? '?'}: requested worker ${t.requestedAgentId}/` +
        `${t.requestedModelId ?? '-'}; assignment ${verdict}` +
        (verdict === 'refused' && t.assignmentRefusalReason ? ` (${t.assignmentRefusalReason})` : '') +
        `; actual worker ${t.agentId === null ? 'none' : `${t.agentId}/${t.modelId ?? '-'}`}`);
    }
    lines.push(`request given to the worker: ${t.prompt === null ? '(none recorded)' : t.prompt.text}`);
    if (t.prompt !== null && t.prompt.truncated) {
      lines.push(`[request truncated: ${t.prompt.originalLength} chars]`);
    }
    if (t.handoff === null) {
      lines.push('evidence: (no run — nothing executed for this task)');
    } else {
      const h = t.handoff;
      lines.push(`evidence: runState=${h.runState ?? 'none'}, changedFiles=${h.changedFiles.length}, ` +
        `testsRun=${h.testsRun.length}, artifacts=${h.artifacts.length}`);
      if (h.changedFiles.length > 0) lines.push(`  files it actually wrote: ${h.changedFiles.join(', ')}`);
      if (h.testsRun.length > 0) {
        lines.push(`  observed shell commands (NOT test verdicts): ${h.testsRun.join(' ; ')}`);
      }
      if (h.completedWork !== null) lines.push(`  what it says it did: ${h.completedWork}`);
      // Rendered even when empty, matching the handoff brief's own rule: "none reported"
      // is information, and an absent section reads as "not applicable".
      lines.push(`  decisions it stated: ${h.decisions ?? 'none reported'}`);
      lines.push(`  unresolved it stated: ${h.unresolved.length > 0 ? h.unresolved.join('; ') : 'none reported'}`);
      if (h.transcriptPath !== null) lines.push(`  transcript: ${h.transcriptPath}`);
    }
    if (t.approvedTest === undefined || t.approvedTest === null) {
      lines.push('approved completion test: UNREPORTED (no structured approved-test evidence for this execution)');
    } else {
      const at = t.approvedTest;
      const argv = tailText(at.test.argv.join(' '), 600);
      lines.push(`approved completion test: ${at.test.executable} ${argv.text}` +
        `${argv.truncated ? ` [argv truncated from ${argv.originalLength} chars]` : ''} (cwd=${at.test.cwd})`);
      lines.push(`  code=${at.test.code === null ? 'none' : at.test.code} signal=${at.test.signal ?? 'none'} ` +
        `timedOut=${at.test.timedOut} treeStopConfirmed=${at.test.treeStopConfirmed} mayHaveStarted=${at.test.mayHaveStarted}`);
      const note = tailText(at.test.note, 400);
      lines.push(`  outputDigest=${at.test.outputDigest}` +
        `${note.text === '' ? '' : ` note=${note.text}${note.truncated ? ' [truncated]' : ''}`}`);
      lines.push(`  bound: task=${at.taskId} attempt=${at.attemptId} session=${at.sessionId ?? 'none'} lease=${at.leaseVersion} ` +
        `agent=${at.agentId}/${at.modelId ?? 'default'} runFingerprint=${at.runFingerprint} ` +
        `contractDigest=${at.contractDigest} validatedAt=${at.validatedAt}`);
      lines.push('  this is a recorded test fact, NOT a task PASS; task status/outcome above is separate');
    }
    lines.push(`attempts recorded: ${t.attemptIds.length === 0 ? '(none)' : t.attemptIds.join(', ')}`);
    if (t.leaseVersion !== null) lines.push(`assignment lease version: ${t.leaseVersion}`);
    if (t.errorCode !== null) {
      lines.push(`reported error: ${t.errorCode}${t.errorMessage === null ? '' : ` — ${t.errorMessage}`}`);
    }
  }

  if (packet.quotaSignals.length > 0) {
    lines.push('');
    lines.push('## Quota signals');
    for (const s of packet.quotaSignals) lines.push(`- ${s}`);
  }
  if (packet.resourceSignals.length > 0) {
    lines.push('');
    lines.push('## Resource / workspace signals');
    for (const s of packet.resourceSignals) lines.push(`- ${s}`);
  }

  lines.push('');
  lines.push('## Errors and refusals');
  if (packet.errors.length === 0) lines.push('(none)');
  else for (const e of packet.errors) lines.push(`- ${e}`);

  lines.push('');
  lines.push('## Evidence note');
  lines.push(packet.evidenceNote);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 3. Running the review — the EXISTING native seam, once, no retry
// ---------------------------------------------------------------------------

/**
 * Static JSON Schema asset handed to `codex exec --output-schema` for the Codex
 * reviewer. It constrains only the model-owned fields; `reviewer`/`reviewedAt`
 * stay host-added after parsing. Resolved from this module so no cwd or global
 * path is assumed.
 */
const REVIEW_OUTPUT_SCHEMA_PATH = fileURLToPath(
  new URL('./round-review-output.schema.json', import.meta.url),
);

/** The one injected dependency: the existing native review entrypoint. */
export interface NativeReviewer {
  /**
   * Runs one native review. In production this is `RuntimeOrch.review`, which forwards to
   * the single `run({mode:'review'})` edge. It is injected rather than imported so this
   * module cannot become a second execution authority.
   */
  review(req: Omit<RunRequest, 'mode'>): RunHandle;
}

/**
 * Why a round has no review result, in four distinguishable ways — never two.
 *
 *   completed            the reviewer ran and expressed a verdict
 *   unavailable          the reviewer could not be reached
 *   failed               the reviewer ran and the attempt failed (or threw)
 *   not_requested        the operator disabled review (`--no-review`)
 *   execution_incomplete TeamRun T3-b.1: review was WITHHELD because the fan-out's requested
 *                        members did not all reach an execution resolution, so the round's work
 *                        is not finished and there is nothing complete to judge.
 *
 * The last one exists because it is NOT `failed` — the reviewer never ran and holds no opinion —
 * and it is NOT `not_requested` — nobody asked for that. Folding either of those in would let an
 * unfinished round read as reviewed.
 */
export const REVIEW_STATUSES = ['completed', 'unavailable', 'failed', 'not_requested', 'execution_incomplete'] as const;
export type UnifiedReviewStatus = (typeof REVIEW_STATUSES)[number];

export interface UnifiedReviewResult {
  readonly status: UnifiedReviewStatus;
  /** Which agent was asked to review, so "no review" is never confused with "Codex said nothing". */
  readonly reviewer: string;
  /** Present ONLY when the review genuinely completed. Never synthesised. */
  readonly verdict: ReviewVerdict | null;
  readonly reason: string | null;
  readonly findings: readonly ReviewFinding[];
  /**
   * What the user may choose to do next.
   *
   * A RECOMMENDATION, never an action. Nothing in this project reads it, and a test
   * asserts that: the product model is Codex -> user -> next round.
   */
  readonly recommendations: readonly string[];
  /** Raw reviewer output, tailed, so a human can audit the verdict it produced. */
  readonly outputTail: BoundedText | null;
  readonly code: string | null;
  readonly reviewedAt: number | null;
}

export interface RunUnifiedReviewOptions {
  readonly reviewer: string;
  readonly modelId: string | null;
  readonly cwd: string;
  readonly now: () => number;
  /** Bounds THIS call. On expiry the review is `failed`, never retried. */
  readonly timeoutMs?: number;
  readonly maxTextChars?: number;
}

/**
 * Run ONE native Codex review of a completed round.
 *
 * The failure handling IS the design here:
 *   - the reviewer is called EXACTLY ONCE. No retry loop, no backoff, no second attempt on
 *     a different model — an unauthenticated or out-of-quota Codex must not become an
 *     unbounded spend, and a flaky reviewer must not restart the round's work.
 *   - a throw, a timeout or an unparseable reply becomes `unavailable` / `failed` with a
 *     reason. Never a synthesised verdict, never `completed`.
 *   - it touches nothing else: no TaskStore write, no scheduler, no session registry.
 */
export async function runUnifiedReview(
  reviewer: NativeReviewer,
  packet: ReviewPacket,
  options: RunUnifiedReviewOptions,
): Promise<UnifiedReviewResult> {
  const base = {
    reviewer: options.reviewer,
    verdict: null,
    findings: [],
    recommendations: [],
    outputTail: null,
    reviewedAt: null,
  } as const;
  const maxChars = options.maxTextChars ?? DEFAULT_TEXT_TAIL_CHARS;

  const subject = [
    'You are reviewing ONE completed execution round of a multi-agent orchestrator.',
    'You did NOT produce this work. Audit it independently against the machine evidence below.',
    '',
    renderReviewPacket(packet),
    '',
    'Judge what was actually accomplished, whether each worker did what it was asked, and whether the',
    'machine evidence supports what it claims. Say so plainly when a claim is unsupported by the evidence.',
    'Report only. Do not ask for anything to be re-run: the user alone decides the next round.',
  ].join('\n');
  const prompt = reviewInstructions(subject);

  let handle: RunHandle;
  try {
    handle = reviewer.review({
      agentId: options.reviewer,
      prompt,
      cwd: options.cwd,
      ...(options.modelId === null ? {} : { model: options.modelId }),
      // Codex only: ask the CLI itself to constrain the reply to the static
      // schema. The adapter recognises this selector and takes its fresh exec
      // profile. Other reviewers' requests are unchanged.
      ...(options.reviewer === 'codex'
        ? { extraArgs: ['--output-schema', REVIEW_OUTPUT_SCHEMA_PATH], sandbox: 'read-only' }
        : {}),
    });
  } catch (e) {
    // Could not even START: adapter missing, agent unknown, capability refused.
    return {
      ...base,
      status: 'unavailable',
      reason: `the reviewer could not be started: ${(e as Error).message}`,
      code: 'reviewer-unavailable',
    };
  }

  let run: RunResult;
  try {
    run = await handle.result(options.timeoutMs);
  } catch (e) {
    return {
      ...base,
      status: 'unavailable',
      reason: `the reviewer did not produce a result: ${(e as Error).message}`,
      code: 'reviewer-no-result',
    };
  }

  if (run.state !== 'succeeded') {
    return {
      ...base,
      status: 'failed',
      reason: run.error?.message ?? `the reviewer ended ${run.state}`,
      code: run.error?.code ?? `reviewer-${run.state}`,
      outputTail: tailText(run.output ?? '', maxChars),
    };
  }

  // A succeeded review still has to produce a VALID verdict. Prose that does not satisfy
  // the contract is `failed`, not a pass — this is what stops "the reviewer was chatty"
  // from reading as approval.
  let verdict: ReviewVerdict;
  try {
    const parsed = normalizeReviewOutput(run.output) as Record<string, unknown>;
    const reviewedAt = options.now();
    verdict = validateReviewVerdict({
      ...parsed,
      reviewer: options.reviewer,
      reviewedAt,
    });
  } catch (e) {
    return {
      ...base,
      status: 'failed',
      reason: `the reviewer's reply did not satisfy the verdict contract: ${(e as Error).message}`,
      code: 'reviewer-output-invalid',
      outputTail: tailText(run.output ?? '', maxChars),
    };
  }

  return {
    status: 'completed',
    reviewer: options.reviewer,
    verdict,
    reason: verdict.reason,
    findings: verdict.findings,
    // Derived from the verdict, phrased as an OPTION the user may take.
    recommendations: verdict.recommendedAction === 'none'
      ? []
      : [`the reviewer suggests "${verdict.recommendedAction}" — a suggestion for YOUR next round; ` +
         'nothing was re-run automatically'],
    outputTail: tailText(run.output ?? '', maxChars),
    code: null,
    reviewedAt: verdict.reviewedAt,
  };
}

// ---------------------------------------------------------------------------
// 4. The Unified Round Report
// ---------------------------------------------------------------------------

/**
 * The round's final result: machine evidence, agent output, AND the review.
 *
 * All three layers are kept. A report carrying only the reviewer's prose would be worse
 * than useless in a system whose whole point is that claims are checkable; one carrying
 * only machine evidence would not say what the independent judgement was.
 */
export interface UnifiedRoundReport {
  readonly roundId: string;
  readonly originalRequest: string;
  readonly tasks: readonly {
    readonly taskId: string;
    readonly status: TaskStatus;
    readonly agentId: string | null;
    readonly outcome: ExecutionOutcomeKind;
    readonly executed: boolean;
    readonly attemptIds: readonly string[];
  }[];
  readonly prompts: readonly { readonly taskId: string; readonly prompt: BoundedText | null }[];
  readonly outputs: readonly {
    readonly taskId: string;
    readonly output: BoundedText | null;
    readonly changedFiles: readonly string[];
    readonly testsRun: readonly string[];
  }[];
  readonly errors: readonly string[];
  readonly quotaSignals: readonly string[];
  readonly resourceSignals: readonly string[];
  readonly review: {
    readonly status: UnifiedReviewStatus;
    readonly reviewer: string;
    readonly verdict: ReviewVerdictValue | null;
    readonly reason: string | null;
    readonly findings: readonly ReviewFinding[];
    readonly recommendations: readonly string[];
    readonly code: string | null;
  };
}

export function buildUnifiedRoundReport(
  packet: ReviewPacket,
  review: UnifiedReviewResult,
): UnifiedRoundReport {
  return {
    roundId: packet.roundId,
    originalRequest: packet.originalRequest,
    tasks: packet.executionOutcomes.map((o) => ({
      taskId: o.taskId,
      status: o.taskStatus,
      agentId: o.agentId,
      outcome: o.outcome,
      executed: o.executed,
      attemptIds: o.attemptIds,
    })),
    prompts: packet.tasks.map((t) => ({ taskId: t.taskId, prompt: t.prompt })),
    outputs: packet.tasks.map((t) => ({
      taskId: t.taskId,
      output: t.handoff === null || t.handoff.completedWork === null
        ? null
        : tailText(t.handoff.completedWork),
      changedFiles: t.handoff?.changedFiles ?? [],
      testsRun: t.handoff?.testsRun ?? [],
    })),
    errors: packet.errors,
    quotaSignals: packet.quotaSignals,
    resourceSignals: packet.resourceSignals,
    review: {
      status: review.status,
      reviewer: review.reviewer,
      // The verdict VALUE, kept deliberately distinct from every task's execution state
      // above. `rework` here does NOT mean any task is in `rework`.
      verdict: review.verdict === null ? null : review.verdict.verdict,
      reason: review.reason,
      findings: review.findings,
      recommendations: review.recommendations,
      code: review.code,
    },
  };
}

/**
 * Render the unified report for a human.
 *
 * The recommendation block says outright that nothing was re-run. That wording is the
 * whole difference between "Codex suggested rework" and "the system re-ran it", and only
 * the first is true.
 */
export function renderUnifiedRoundReport(report: UnifiedRoundReport): string {
  const lines: string[] = [];
  lines.push('# Round Result');
  lines.push('');
  lines.push('## Original Request');
  lines.push(report.originalRequest);
  lines.push('');
  lines.push(`## Tasks (${report.tasks.length})`);
  for (const t of report.tasks) {
    lines.push(`- ${t.taskId}: ${t.outcome} (status=${t.status}, executed=${t.executed}, ` +
      `attempts=${t.attemptIds.length}, agent=${t.agentId ?? '-'})`);
  }
  lines.push('');
  lines.push('## Execution');
  for (const p of report.prompts) {
    lines.push(`- request ${p.taskId}: ${p.prompt === null ? '(none recorded)' : oneLine(p.prompt.text)}`);
  }
  for (const o of report.outputs) {
    lines.push(`- output ${o.taskId}: ${o.output === null ? '(no output)' : oneLine(o.output.text)}`);
    if (o.changedFiles.length > 0) lines.push(`    wrote: ${o.changedFiles.join(', ')}`);
    if (o.testsRun.length > 0) lines.push(`    tests run: ${o.testsRun.join(' ; ')}`);
  }
  if (report.errors.length > 0) {
    lines.push('- errors and refusals:');
    for (const e of report.errors) lines.push(`    ${e}`);
  }
  for (const q of report.quotaSignals) lines.push(`- quota: ${q}`);
  for (const r of report.resourceSignals) lines.push(`- resource: ${r}`);
  lines.push('');
  lines.push('## Codex Review');
  lines.push(`- status: ${report.review.status}`);
  lines.push(`- reviewer: ${report.review.reviewer}`);
  if (report.review.verdict !== null) lines.push(`- verdict: ${report.review.verdict}`);
  if (report.review.reason !== null) lines.push(`- reason: ${report.review.reason}`);
  if (report.review.findings.length > 0) {
    lines.push('- findings:');
    for (const f of report.review.findings) lines.push(`    [${f.severity}] ${f.location}: ${f.message}`);
  }
  if (report.review.recommendations.length > 0) {
    lines.push('- next-round options (NOT executed automatically):');
    for (const r of report.review.recommendations) lines.push(`    ${r}`);
  }
  if (report.review.status !== 'completed') {
    lines.push('- note: the execution evidence above is complete and unaffected by the review outcome.');
  }
  return lines.join('\n');
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}