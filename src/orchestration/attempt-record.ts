/**
 * src/orchestration/attempt-record.ts — P6-E: structured, queryable attempt evidence.
 *
 * WHAT THIS IS, PRECISELY
 * -----------------------
 * A factual record that one attempt happened and how it turned out. Append-only.
 * Derived from things that really occurred — a real `RunResult`, a real
 * `ReviewVerdict`, a real rework re-entry.
 *
 * WHAT THIS IS NOT, PRECISELY
 * ---------------------------
 *   NOT a task state machine   Task.status is the ONLY lifecycle truth.
 *   NOT a second TaskStore      nothing here transitions anything.
 *   NOT a scheduler             nothing here dispatches.
 *   NOT a verification authority nothing here verifies.
 *
 * `Task.retryCount` and this history are INDEPENDENT. Rework counters stay on the
 * task because they must gate a live decision; this history exists because a
 * decision made last month still has to be auditable. Deriving one from the other
 * would create exactly the second authority P6 forbids, so neither is ever
 * computed from the other.
 *
 * WHY NOT A TRANSCRIPT
 * --------------------
 * An `AttemptRecord` carries an error CODE, a duration, and a cost. It does not
 * carry the prompt, the model output, or a token log. Those belong in
 * `RunResult.transcriptPath` and the session store, where they are already kept
 * and where nobody mistakes them for structured evidence. The test that matters:
 * a record can be aggregated, compared and reasoned about WITHOUT reading prose —
 * and if a record ever needed prose to be interpreted, it would be a bug report
 * wearing a database row's clothes.
 *
 * ATTEMPT KINDS ARE NOT INTERCHANGEABLE
 * -------------------------------------
 *   execution  the agent did the work
 *   review     a reviewer judged the work
 *   rework     the agent re-did the work BECAUSE a reviewer asked
 *
 * A `rework` is not a retry and not a fresh execution. D0 established that
 * distinction and collapsing it here would erase the very thing P6-B needs to
 * measure: "how often does this agent produce work a reviewer rejects?" is a
 * different question from "how often does this agent crash?".
 */

import type { TaskType } from '../quota/types.ts';
import type { RunResult } from '../core/types.ts';
import type { ReviewVerdict } from './review-verdict.ts';
import type { VerificationOutcome } from './translate.ts';

/** What kind of attempt this was. */
export const ATTEMPT_KINDS = ['execution', 'review', 'rework'] as const;
export type AttemptKind = (typeof ATTEMPT_KINDS)[number];

/**
 * How an attempt ended.
 *
 * `success` means the work was done and, where a review followed, accepted — it is
 * deliberately NOT "the process exited 0". A clean exit that a reviewer rejects is
 * a `reject`, because for every consumer of this evidence the work did not
 * succeed. Process-level detail lives in the record's own fields.
 */
export const ATTEMPT_OUTCOMES = ['success', 'failure', 'rework', 'reject', 'aborted', 'error'] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/** Everything a review concluded, reduced to the part that is comparable. */
export interface AttemptVerification {
  readonly verdict: NonNullable<VerificationOutcome['verdict']>;
  /** D0's verdict fingerprint, so a repeated verdict is recognisable. */
  readonly fingerprint?: string;
  /** How many findings the verdict carried. A count, not the findings' text. */
  readonly findingCount: number;
}

/**
 * One attempt. Frozen on construction — an evidence record that could be edited
 * after the fact would stop being evidence.
 */
export interface AttemptRecord {
  readonly attemptId: string;
  readonly taskId: string;

  readonly kind: AttemptKind;
  /**
   * The worker this attempt ran against. For a `review`, the REVIEWER's id, which
   * is the whole point: review quality is per-reviewer evidence.
   */
  readonly agentId: string;
  readonly modelId: string | null;
  /** Carried so task-type × agent performance is computable without the store. */
  readonly taskType: TaskType;

  readonly startedAt: number;
  readonly finishedAt: number | null;

  readonly outcome: AttemptOutcome;
  readonly verification?: AttemptVerification;

  /** From `RunResult.error.code`. Absent means "reported no error code". */
  readonly errorCode?: string;
  /** Absent means "no message". Never truncated here — see the size note below. */
  readonly errorMessage?: string;

  /** Budget units this task was allocated, as `Task.budgetUnits` reported it. */
  readonly budgetUnits?: number;
  /**
   * R2-2 §6 / §7.1: the assignment lease version this attempt ran under.
   *
   * Recorded because it is a FACT ABOUT THE ATTEMPT, not about the task now. A task
   * reassigned after this attempt still reports the OLD version here, which is what
   * makes "which lease produced this evidence" answerable forever - and what stops a
   * superseded attempt from being laundered into the current holder's history.
   *
   * Optional, following the existing optional-field system: a `review` attempt is not
   * an execution under a lease, and an attempt recorded before R2-2 has no version.
   * Absent therefore means "not applicable / not known", never "version 0".
   */
  readonly leaseVersion?: number;
  /**
   * Reported cost. `null`/absent means the agent reported NO cost — which is a
   * different fact from zero, and this project already depends on that
   * distinction (see model-pool.ts, which refuses to read unreported as free).
   */
  readonly costUsd?: number;

  /**
   * The attempt before this one for the same task, or null for the first.
   *
   * This is what makes an attempt history a CHAIN rather than a bag of rows, and
   * it is set by the store on append. It is not derivable from the task's current
   * status, which is exactly why it belongs on the record.
   */
  readonly previousAttemptId: string | null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Why a record could not be trusted. */
export class AttemptRecordError extends Error {
  readonly code: string;
  readonly detail: string;

  constructor(code: string, detail: string) {
    super(`AttemptRecord rejected [${code}]: ${detail}. ` +
      `No record was stored: an attempt that cannot be described is not evidence.`);
    this.name = 'AttemptRecordError';
    this.code = code;
    this.detail = detail;
  }
}

export function isAttemptRecordError(value: unknown): value is AttemptRecordError {
  return value instanceof AttemptRecordError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** A caller-supplied id, if any, must not collide with one this store generated. */
function optionalId(raw: Record<string, unknown>, key: string): string | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (!nonEmpty(v)) throw new AttemptRecordError('malformed-record', `${key} must be a non-empty string, got ${JSON.stringify(v)}`);
  return v;
}

/**
 * Validate a raw record and freeze it.
 *
 * Pure and total over well-formed input. It does not check whether the task
 * EXISTS — this layer records evidence about attempts, and refusing to describe
 * an attempt because a task id is unknown would make a real run unreportable. Task
 * existence is `TaskStore`'s question, and answering it here would be a second
 * opinion about task state.
 */
export function validateAttemptRecord(raw: unknown): AttemptRecord {
  if (!isRecord(raw)) {
    throw new AttemptRecordError('malformed-record', `expected an object, got ${Array.isArray(raw) ? 'an array' : typeof raw}`);
  }

  if (!nonEmpty(raw.taskId)) {
    throw new AttemptRecordError('malformed-record', `"taskId" must be a non-empty string, got ${JSON.stringify(raw.taskId)}`);
  }
  if (!nonEmpty(raw.agentId)) {
    throw new AttemptRecordError('malformed-record', `"agentId" must be a non-empty string, got ${JSON.stringify(raw.agentId)}`);
  }
  if (typeof raw.kind !== 'string' || !(ATTEMPT_KINDS as readonly string[]).includes(raw.kind)) {
    throw new AttemptRecordError('malformed-record', `"kind" ${JSON.stringify(raw.kind)} is outside [${ATTEMPT_KINDS.join(', ')}]`);
  }
  if (typeof raw.outcome !== 'string' || !(ATTEMPT_OUTCOMES as readonly string[]).includes(raw.outcome)) {
    throw new AttemptRecordError('malformed-record', `"outcome" ${JSON.stringify(raw.outcome)} is outside [${ATTEMPT_OUTCOMES.join(', ')}]`);
  }
  if (typeof raw.startedAt !== 'number' || !Number.isFinite(raw.startedAt)) {
    throw new AttemptRecordError('malformed-record', `"startedAt" must be a finite number, got ${JSON.stringify(raw.startedAt)}`);
  }
  if (raw.finishedAt !== undefined && raw.finishedAt !== null &&
      (typeof raw.finishedAt !== 'number' || !Number.isFinite(raw.finishedAt))) {
    throw new AttemptRecordError('malformed-record', `"finishedAt" must be a finite number or null, got ${JSON.stringify(raw.finishedAt)}`);
  }
  if (raw.modelId !== undefined && raw.modelId !== null && !nonEmpty(raw.modelId)) {
    throw new AttemptRecordError('malformed-record', `"modelId" must be a non-empty string or null, got ${JSON.stringify(raw.modelId)}`);
  }
  if (raw.taskType !== undefined && typeof raw.taskType !== 'string') {
    throw new AttemptRecordError('malformed-record', `"taskType" must be a string when present, got ${typeof raw.taskType}`);
  }
  for (const key of ['errorCode', 'errorMessage'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') {
      throw new AttemptRecordError('malformed-record', `${key} must be a string when present, got ${typeof raw[key]}`);
    }
  }
  for (const key of ['budgetUnits', 'costUsd', 'leaseVersion'] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]))) {
      throw new AttemptRecordError('malformed-record', `${key} must be a finite number when present, got ${typeof raw[key]}`);
    }
  }
  // A lease version is a positive counter, so 0 or a negative value is not a version -
  // it is a missing value that arrived wearing a number's clothes, and accepting it
  // would let "no lease" masquerade as "lease 0".
  if (raw.leaseVersion !== undefined && (raw.leaseVersion as number) < 1) {
    throw new AttemptRecordError('malformed-record', `"leaseVersion" must be >= 1 when present, got ${raw.leaseVersion}`);
  }

  let verification: AttemptVerification | undefined;
  if (raw.verification !== undefined) {
    if (!isRecord(raw.verification)) {
      throw new AttemptRecordError('malformed-record', `"verification" must be an object when present, got ${typeof raw.verification}`);
    }
    const v = raw.verification.verdict;
    if (typeof v !== 'string' || !['pass', 'rework', 'reject'].includes(v)) {
      throw new AttemptRecordError('malformed-record', `verification.verdict ${JSON.stringify(v)} is outside [pass, rework, reject]`);
    }
    if (raw.verification.findingCount !== undefined &&
        (typeof raw.verification.findingCount !== 'number' || !Number.isFinite(raw.verification.findingCount))) {
      throw new AttemptRecordError('malformed-record', 'verification.findingCount must be a finite number when present');
    }
    verification = Object.freeze({
      verdict: v as AttemptVerification['verdict'],
      ...(typeof raw.verification.fingerprint === 'string' ? { fingerprint: raw.verification.fingerprint } : {}),
      findingCount: typeof raw.verification.findingCount === 'number' ? raw.verification.findingCount : 0,
    });
  }

  return Object.freeze({
    // `attemptId` may be supplied by the store (see AttemptStore.append) or by a
    // caller replaying a known run; validation only checks it when present.
    ...(optionalId(raw, 'attemptId') !== undefined ? { attemptId: optionalId(raw, 'attemptId') as string } : {}),
    taskId: raw.taskId,
    kind: raw.kind as AttemptKind,
    agentId: raw.agentId,
    modelId: (raw.modelId ?? null) as string | null,
    taskType: (raw.taskType ?? 'implementation') as TaskType,
    startedAt: raw.startedAt,
    finishedAt: (raw.finishedAt ?? null) as number | null,
    outcome: raw.outcome as AttemptOutcome,
    ...(verification !== undefined ? { verification } : {}),
    ...(typeof raw.errorCode === 'string' ? { errorCode: raw.errorCode } : {}),
    ...(typeof raw.errorMessage === 'string' ? { errorMessage: raw.errorMessage } : {}),
    ...(typeof raw.budgetUnits === 'number' ? { budgetUnits: raw.budgetUnits } : {}),
    ...(typeof raw.leaseVersion === 'number' ? { leaseVersion: raw.leaseVersion } : {}),
    ...(typeof raw.costUsd === 'number' ? { costUsd: raw.costUsd } : {}),
    previousAttemptId: (raw.previousAttemptId ?? null) as string | null,
  }) as AttemptRecord;
}

// ---------------------------------------------------------------------------
// Builders: evidence derived from things that REALLY happened
// ---------------------------------------------------------------------------

/**
 * Execution evidence from a real `RunResult`.
 *
 * The single most important property here is what it REFUSES to be called with.
 * There is no `RunResult`-shaped input that is not a real result, because a
 * scheduler that skipped a task produces no `RunResult` at all — so "no record"
 * is the honest outcome for a skipped task, and no signature exists to fake one.
 */
export function executionAttempt(input: {
  taskId: string;
  agentId: string;
  modelId: string | null;
  taskType?: TaskType;
  result: RunResult;
  budgetUnits?: number;
  startedAt?: number;
  /**
   * R2-2: the lease version this execution ran under.
   *
   * Passed in by the caller from the DISPATCH-time lease, never derived from the task
   * at record time. Deriving it here would silently relabel every attempt as belonging
   * to the newest lease, which is exactly the corruption that fencing prevents.
   */
  leaseVersion?: number;
}): Omit<AttemptRecord, 'attemptId' | 'previousAttemptId'> {
  const r = input.result;
  // `aborted` is separate from `failure`: a cancelled run is not a failed one,
  // and averaging them would make an agent look worse for work nobody asked it to
  // finish.
  const outcome: AttemptOutcome = r.state === 'succeeded'
    ? 'success'
    : r.state === 'cancelled'
      ? 'aborted'
      : r.state === 'failed'
        ? 'failure'
        : 'error';
  return {
    taskId: input.taskId,
    kind: 'execution',
    agentId: r.agentId,
    modelId: input.modelId,
    taskType: input.taskType ?? 'implementation',
    startedAt: input.startedAt ?? r.startedAt,
    finishedAt: r.endedAt,
    outcome,
    ...(r.error !== null ? { errorCode: r.error.code as string, errorMessage: r.error.message } : {}),
    ...(input.budgetUnits === undefined ? {} : { budgetUnits: input.budgetUnits }),
    ...(input.leaseVersion === undefined ? {} : { leaseVersion: input.leaseVersion }),
    // Absent (not zero) when the agent reported no usage at all.
    ...(r.usage?.costUsd === undefined || r.usage?.costUsd === null ? {} : { costUsd: r.usage.costUsd }),
  };
}

/** Rework execution evidence — same shape, different kind, so it is never conflated. */
export function reworkAttempt(input: {
  taskId: string;
  agentId: string;
  modelId: string | null;
  taskType?: TaskType;
  result: RunResult;
  budgetUnits?: number;
  startedAt?: number;
  leaseVersion?: number;
}): Omit<AttemptRecord, 'attemptId' | 'previousAttemptId'> {
  return { ...executionAttempt(input), kind: 'rework' };
}

/**
 * Review evidence from a real `ReviewVerdict` (D0's contract).
 *
 * `agentId` is the REVIEWER, and `modelId` is null unless the reviewer named one.
 * A verdict that was never applied is still worth recording — that it happened is
 * a fact — but the caller decides whether to record it; nothing here reaches into
 * the task to find out.
 */
export function reviewAttempt(input: {
  taskId: string;
  reviewer: string;
  reviewerModelId?: string | null;
  taskType?: TaskType;
  verdict: ReviewVerdict;
  startedAt?: number;
}): Omit<AttemptRecord, 'attemptId' | 'previousAttemptId'> {
  const v = input.verdict;
  // The verdict IS the outcome. A `pass` is a success, a `rework` request is a
  // rework, a `reject` is a reject — derived, not re-decided.
  const outcome: AttemptOutcome = v.verdict === 'pass' ? 'success' : v.verdict;
  return {
    taskId: input.taskId,
    kind: 'review',
    agentId: input.reviewer,
    modelId: input.reviewerModelId ?? null,
    taskType: input.taskType ?? 'implementation',
    startedAt: input.startedAt ?? v.reviewedAt,
    finishedAt: v.reviewedAt,
    outcome,
    verification: {
      verdict: v.verdict,
      ...(v.fingerprint === undefined ? {} : { fingerprint: v.fingerprint }),
      findingCount: v.findings.length,
    },
  };
}
