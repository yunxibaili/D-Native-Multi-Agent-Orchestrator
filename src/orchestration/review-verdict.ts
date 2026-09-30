/**
 * src/orchestration/review-verdict.ts — P6-D0: the structured review contract.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A reviewer today speaks in prose. `codex exec review` returns a text tail on
 * `RunResult.output`, and `docs/PHASE4M_HINDSIGHT_DECISION.md` records that this
 * was already identified as the weak link: a review nobody can act on
 * deterministically is a review whose verdict is re-derived by whoever reads it
 * next. Turning that text into a typed verdict is the whole point of D0.
 *
 * `RunResult.output` IS NOT the contract, and this file is careful not to pretend
 * it is. `output` is documented in `core/types.ts` as a "byte-bounded tail",
 * `outputTruncated` may be true, and the transcript is the real record. So the
 * boundary here is explicit: raw reviewer text goes IN through
 * `normalizeReviewOutput`, and a `ReviewVerdict` comes OUT. Everything past the
 * verdict is typed and needs no text.
 *
 * WHAT A REVIEWER MAY AND MAY NOT SAY
 * ----------------------------------
 * A reviewer judges quality. It does not steer the orchestrator. The sharpest
 * version of that rule is the one this contract has to get right: a reviewer that
 * says "let MiMo fix the parser" has written an instruction, not a judgement.
 *
 * So `recommendedAction` exists, and `assign` is a RECOGNISED value that D0
 * REFUSES to execute. That is the deliberate design: the request is recorded as
 * evidence (a human or a later stage can read why the reviewer wanted it), and
 * the loop still does not reassign anyone. Turning a reviewer's suggestion into
 * an assignment automatically is P6-B's job, and doing it here would smuggle
 * dynamic assignment into a stage that promised not to.
 *
 * EVIDENCE, NOT INSTRUCTION
 * -------------------------
 * `findings[]` describe what was observed. They are deliberately NOT merged into
 * `TaskObservation` (P6-A): the observation is a snapshot of task state, and a
 * reviewer's opinion is neither state nor a fact about the run. Widening P6-A to
 * carry it would give the decision brain prose it cannot act on — exactly the
 * failure P6-A was scoped to avoid. `reviewEvidence` keeps it separate and
 * readable.
 *
 * SEVERITY WITHOUT A SCORE
 * ------------------------
 * Severity is an ordinal, not a number. A number invites comparing 0.7 with 0.9
 * across reviews and inferring that the reviewer was more confident, which no
 * calibrated confidence value is available to justify. An ordinal is honest
 * about the only comparison it supports: relative ordering within one review.
 */

import { isDecisionValidationError } from './decision.ts';

// ---------------------------------------------------------------------------
// The verdict vocabulary
// ---------------------------------------------------------------------------

/** What a review concluded. Frozen; the same three the verification layer has. */
export const REVIEW_VERDICTS = ['pass', 'rework', 'reject'] as const;
export type ReviewVerdictValue = (typeof REVIEW_VERDICTS)[number];

/**
 * What the reviewer suggested be done about it.
 *
 * Only `rework` is executable by D0, and even that only via the normal
 * verification path. The other two are recognised precisely so that refusing them
 * can be an explicit, reportable refusal rather than an "unknown action" shrug.
 */
export const RECOMMENDED_ACTIONS = ['none', 'rework', 'assign'] as const;
export type RecommendedAction = (typeof RECOMMENDED_ACTIONS)[number];

/** Actions D0 will actually execute. Deliberately one. */
export const D0_EXECUTABLE_ACTIONS: ReadonlySet<RecommendedAction> = new Set<RecommendedAction>(['none', 'rework']);

export const SEVERITIES = ['info', 'minor', 'major', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** One thing the reviewer observed. Evidence, never instruction. */
export interface ReviewFinding {
  /** Where the problem is, in the reviewer's own words. Scoped, not a command. */
  readonly location: string;
  readonly severity: Severity;
  readonly message: string;
  /**
   * What the reviewer pointed at: a file path, a line, a snippet. Kept as an
   * opaque string so this layer defines no path or diff format of its own.
   */
  readonly evidence?: string;
}

/**
 * A structured verdict. Fully typed: everything downstream of this point can be
 * handled without reading a single character of reviewer prose.
 */
export interface ReviewVerdict {
  readonly verdict: ReviewVerdictValue;
  /** Why. Required and non-empty — a verdict with no reason cannot be reviewed. */
  readonly reason: string;
  readonly findings: readonly ReviewFinding[];
  /** What the reviewer wanted done. Recorded; executed only if D0 can do it. */
  readonly recommendedAction: RecommendedAction;
  /** Who reviewed. Evidence about the verdict's provenance. */
  readonly reviewer: string;
  /** When. From the caller's clock. */
  readonly reviewedAt: number;
  /**
   * A stable fingerprint of (verdict, findings). Used to detect a review that
   * says the same thing twice, which is how a rework loop terminates instead of
   * spinning. Computed in `validateReviewVerdict`, never hand-supplied.
   */
  readonly fingerprint?: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Every way a verdict fails to be trustworthy.
 *
 * Mirrors `DecisionValidationError` (P6-A) rather than reusing it: a review that
 * cannot be understood and a decision that cannot be acted on are different
 * failures, and a single error type would make one mask the other in a log.
 */
export class ReviewVerdictError extends Error {
  readonly code: string;
  readonly detail: string;

  constructor(code: string, detail: string) {
    super(`Review verdict rejected [${code}]: ${detail}. ` +
      `The task is NOT changed and nothing is dispatched: a review that cannot be ` +
      `understood is never treated as a pass.`);
    this.name = 'ReviewVerdictError';
    this.code = code;
    this.detail = detail;
  }
}

export function isReviewVerdictError(value: unknown): value is ReviewVerdictError {
  return value instanceof ReviewVerdictError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A fingerprint over exactly what identifies a verdict for duplicate detection.
 *
 *   duplicate fingerprint  ==  same verdict
 *                          &&  the same SORTED set of
 *                              (severity | location | message | evidence)
 *
 * What this deliberately does NOT do:
 *
 *   - `reason` is EXCLUDED. It is free prose attached to the findings, so
 *     including it would make a reworded reason look like a new verdict.
 *   - `reviewedAt` is EXCLUDED, so the same findings reviewed twice collide.
 *
 * What this equally deliberately does NOT do:
 *
 *   - It is NOT fuzzy and NOT semantic. A reviewer that changes the WORDING of a
 *     message produces a different fingerprint, and this loop will treat that as a
 *     new verdict. That is a known, accepted limitation, not a bug to be papered
 *     over: any similarity measure would have to guess which rewording still
 *     means "the same complaint", and a false merge stops a legitimate rework.
 *
 * The hard bound is `maxAttempts` (see review-loop.ts), which terminates the loop
 * regardless of how the verdicts compare. Duplicate detection is an early exit for
 * the common case, never the only line of defence.
 */
export function fingerprintVerdict(input: {
  verdict: ReviewVerdictValue;
  findings: readonly ReviewFinding[];
}): string {
  const parts = [
    input.verdict,
    ...[...input.findings]
      .map((f) => [f.severity, f.location.trim(), f.message.trim(), f.evidence?.trim() ?? ''].join('|'))
      .sort(),
  ];
  // A small, stable, non-cryptographic hash. This is an equality key for loop
  // termination, not a security boundary, so FNV-1a is the right size and cost.
  let h = 0x811c9dc5;
  for (const c of parts.join('\n')) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Validate a raw verdict object into a normalised `ReviewVerdict`.
 *
 * Pure: it inspects and returns, and it has no reference to the store, the
 * orchestrator, or the runtime. Ordering is fundamental-first (shape → verdict →
 * reason → findings → action), so a caller fixing a problem is told the root
 * cause rather than a downstream symptom.
 */
export function validateReviewVerdict(raw: unknown): ReviewVerdict {
  if (!isRecord(raw)) {
    throw new ReviewVerdictError('malformed-verdict', `expected an object, got ${Array.isArray(raw) ? 'an array' : typeof raw}`);
  }

  const verdict = raw.verdict;
  if (typeof verdict !== 'string') {
    throw new ReviewVerdictError('malformed-verdict', `"verdict" must be a string, got ${JSON.stringify(verdict)}`);
  }
  if (!(REVIEW_VERDICTS as readonly string[]).includes(verdict)) {
    throw new ReviewVerdictError(
      'unknown-verdict',
      `"${verdict}" is not a verdict [${REVIEW_VERDICTS.join(', ')}]`,
    );
  }

  const reason = raw.reason;
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new ReviewVerdictError('missing-reason', `"reason" must be a non-empty string, got ${JSON.stringify(reason)}`);
  }

  // `reviewer` is required: a verdict with no attributed reviewer cannot be
  // audited, and "somebody reviewed this and said so" is the minimum evidence
  // this contract is for.
  const reviewer = raw.reviewer;
  if (typeof reviewer !== 'string' || reviewer.trim() === '') {
    throw new ReviewVerdictError('missing-reviewer', `"reviewer" must name who reviewed, got ${JSON.stringify(reviewer)}`);
  }

  const reviewedAt = raw.reviewedAt;
  if (typeof reviewedAt !== 'number' || !Number.isFinite(reviewedAt)) {
    throw new ReviewVerdictError('malformed-verdict', `"reviewedAt" must be a finite number, got ${JSON.stringify(reviewedAt)}`);
  }

  const findingsRaw = raw.findings;
  if (findingsRaw === undefined) {
    throw new ReviewVerdictError('malformed-verdict', `"findings" is required (use [] for none)`);
  }
  if (!Array.isArray(findingsRaw)) {
    throw new ReviewVerdictError('malformed-verdict', `"findings" must be an array, got ${typeof findingsRaw}`);
  }
  const findings = findingsRaw.map((f, i) => validateFinding(f, i));

  const actionRaw = raw.recommendedAction;
  if (actionRaw === undefined) {
    throw new ReviewVerdictError('malformed-verdict', `"recommendedAction" is required (use "none" if the reviewer has no preference)`);
  }
  if (typeof actionRaw !== 'string' || !(RECOMMENDED_ACTIONS as readonly string[]).includes(actionRaw)) {
    throw new ReviewVerdictError(
      'unsupported-action',
      `"recommendedAction" ${JSON.stringify(actionRaw)} is outside [${RECOMMENDED_ACTIONS.join(', ')}]`,
    );
  }

  const recommendedAction = actionRaw as RecommendedAction;

  return Object.freeze({
    verdict: verdict as ReviewVerdictValue,
    reason,
    findings: Object.freeze(findings),
    recommendedAction,
    reviewer,
    reviewedAt,
    fingerprint: fingerprintVerdict({ verdict: verdict as ReviewVerdictValue, findings }),
  });
}

function validateFinding(raw: unknown, index: number): ReviewFinding {
  const where = `findings[${index}]`;
  if (!isRecord(raw)) {
    throw new ReviewVerdictError('malformed-finding', `${where} must be an object, got ${Array.isArray(raw) ? 'an array' : typeof raw}`);
  }
  const location = raw.location;
  if (typeof location !== 'string' || location.trim() === '') {
    throw new ReviewVerdictError('malformed-finding', `${where}.location must be a non-empty string, got ${JSON.stringify(location)}`);
  }
  const message = raw.message;
  if (typeof message !== 'string' || message.trim() === '') {
    throw new ReviewVerdictError('malformed-finding', `${where}.message must be a non-empty string, got ${JSON.stringify(message)}`);
  }
  const severity = raw.severity;
  if (typeof severity !== 'string' || !(SEVERITIES as readonly string[]).includes(severity)) {
    throw new ReviewVerdictError(
      'malformed-finding',
      `${where}.severity ${JSON.stringify(severity)} is outside [${SEVERITIES.join(', ')}]`,
    );
  }
  if (raw.evidence !== undefined && typeof raw.evidence !== 'string') {
    throw new ReviewVerdictError('malformed-finding', `${where}.evidence must be a string when present, got ${typeof raw.evidence}`);
  }
  return Object.freeze({
    location,
    severity: severity as Severity,
    message,
    ...(typeof raw.evidence === 'string' ? { evidence: raw.evidence } : {}),
  });
}

// ---------------------------------------------------------------------------
// Normalization: raw reviewer output -> ReviewVerdict
// ---------------------------------------------------------------------------

/**
 * The shape a reviewer is ASKED to emit.
 *
 * Declared here rather than in a prompt string so the two cannot drift: the
 * instruction text below is generated from this same object, and the parser below
 * accepts this shape and nothing else.
 */
export const REVIEW_OUTPUT_CONTRACT: Readonly<Record<string, string>> = Object.freeze({
  verdict: 'Exactly one of: pass, rework, reject.',
  reason: 'One or two sentences explaining the verdict.',
  findings: 'A JSON array of {location, severity, message, evidence?}. Use [] if there are none.',
  recommendedAction: 'Exactly one of: none, rework, assign. Use "none" unless you have a preference.',
});

/** The instruction handed to the reviewer. Derived from the contract above. */
export function reviewInstructions(subject: string): string {
  const schema = JSON.stringify({
    verdict: '<pass|rework|reject>',
    reason: '<string>',
    findings: [{ location: '<string>', severity: '<info|minor|major|critical>', message: '<string>', evidence: '<optional string>' }],
    recommendedAction: '<none|rework|assign>',
  });
  const fieldDocs = Object.entries(REVIEW_OUTPUT_CONTRACT).map(([k, v]) => `  ${k}: ${v}`).join('\n');
  return [
    `Review the following and reply with ONE JSON object, nothing else.`,
    ``,
    `Subject:`,
    subject,
    ``,
    `Schema:`,
    schema,
    ``,
    `Fields:`,
    fieldDocs,
    ``,
    `Rules:`,
    `  - Report what you observed. Do not instruct another agent to do anything.`,
    `  - "assign" is recorded but never executed; it means you would prefer a different worker.`,
    `  - No prose outside the JSON object.`,
  ].join('\n');
}

/** A code fence the reviewer may wrap its JSON in. Stripped, never parsed. */
const FENCE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/;

/**
 * Pull a JSON object out of a reviewer's raw output.
 *
 * Deliberately NOT regex-guessing a verdict out of prose. The only thing
 * stripped is a markdown code fence, which is a formatting wrapper rather than
 * content. Everything else must parse as JSON, because "the reviewer seemed to
 * say pass somewhere in that paragraph" is exactly the guess this layer exists to
 * refuse.
 */
export function normalizeReviewOutput(raw: unknown): unknown {
  if (typeof raw !== 'string') {
    throw new ReviewVerdictError('malformed-output', `reviewer output must be a string, got ${raw === null ? 'null' : typeof raw}`);
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new ReviewVerdictError('malformed-output', 'reviewer output was empty');
  }
  const unfenced = FENCE.exec(trimmed);
  const body = unfenced !== null && unfenced[1] !== undefined ? unfenced[1] : trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new ReviewVerdictError(
      'unparseable-output',
      `reviewer output is not JSON (${e instanceof Error ? e.message : String(e)}). ` +
        `First 120 chars: ${JSON.stringify(body.slice(0, 120))}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new ReviewVerdictError('malformed-output', `reviewer output parsed to ${Array.isArray(parsed) ? 'an array' : typeof parsed}, expected an object`);
  }
  return parsed;
}

/**
 * The full path: raw reviewer text -> validated, fingerprinted verdict.
 *
 * Two distinct failure codes, deliberately: `unparseable-output` means the
 * reviewer did not follow the contract (a model/instruction problem), while
 * `unknown-verdict`/`missing-reason` mean it followed the shape but said something
 * untrustworthy (an evidence problem). They are logged differently and fixed
 * differently, so they must not share a code.
 */
export function parseReviewOutput(raw: unknown): ReviewVerdict {
  return validateReviewVerdict(normalizeReviewOutput(raw));
}

/**
 * Review evidence: what a verdict said, kept apart from task state.
 *
 * A record, not a counter and not a store. Rework accounting (D0's bounded loop)
 * reads the task's own `retryCount`, and this type never becomes a status source
 * — which is why it is `readonly` and carries no way to mutate a task.
 */
export interface ReviewEvidence {
  readonly taskId: string;
  readonly verdict: ReviewVerdict;
  /** True when this verdict repeated one already seen for this task. */
  readonly duplicateOfPrevious: boolean;
}

/** Build the evidence record for a verdict applied to a task. */
export function toReviewEvidence(
  taskId: string,
  verdict: ReviewVerdict,
  previous: readonly ReviewEvidence[] = [],
): ReviewEvidence {
  return Object.freeze({
    taskId,
    verdict,
    duplicateOfPrevious:
      previous.length > 0 && previous.some((p) => p.verdict.fingerprint === verdict.fingerprint),
  });
}

/** Re-exported so a caller can distinguish the two error families in one catch. */
export { isDecisionValidationError };
