/**
 * src/orchestration/stage-material.ts — B4.3: the CURRENT STAGE's material, and the rule
 * that only a USER entry may confirm it.
 *
 * ============================================================================
 * WHAT THIS IS
 * ============================================================================
 * A small, bounded description of the stage the user is currently asking for: what the
 * requirement/expected effect is, which stage this is and what its scope is, and how the
 * work is accepted. It is a PURE VALUE module: it parses, validates and digests; it never
 * reads a file, never creates a task, never calls a model, and never approves anything.
 *
 * THE ONE RULE THAT MATTERS
 * -------------------------
 * A material file is DATA. It cannot approve itself. If the file carries an approval-ish
 * field (`approved`, `confirmed`, `confirmation`, `status: "approved"`, …) it is REFUSED,
 * because "the JSON says approved" is exactly the self-approval this entry exists to stop.
 * Approval comes ONLY from the user's own entry (the CLI `--confirm <digest>`), and it is
 * BOUND to the material by its digest — so changing the stage, scope, requirement or
 * acceptance invalidates an old confirmation instead of silently reusing it.
 *
 * It also cannot be approved by a model or by memory: nothing in this module (or the round)
 * consults a model or a stored "approved" fact. The trust boundary is LOCAL and stated
 * plainly: `--confirm` is a deliberate user act, NOT an identity or authentication claim,
 * and it cannot constrain what an arbitrary native agent does inside its own process.
 *
 * BOUNDED BY CONSTRUCTION
 * -----------------------
 * The material is size- and field-bounded, and the text that actually reaches a task's
 * acceptance criteria / brief is a BOUNDED SUMMARY plus a readable reference to the file —
 * not the whole material. That keeps a large requirement from silently becoming a giant
 * prompt, while still letting a worker open the file for the full text.
 */

import { createHash } from 'node:crypto';

/** The raw material file is rejected above this size, before it is parsed. */
export const STAGE_MATERIAL_MAX_BYTES = 64 * 1024;
/** Any single free-text field is capped so the material cannot smuggle an essay. */
export const STAGE_MATERIAL_MAX_TEXT = 4000;
/** How much of the material can be delivered inline into task acceptance criteria / briefs. */
export const STAGE_EMBED_MAX_CHARS = 6000;

export interface StageMaterial {
  /** The current stage's identity. The confirmation is bound to it. */
  readonly stageId: string;
  /** What this stage covers — the boundary the round must stay inside. */
  readonly scope: string;
  /** The requirement and the expected effect. */
  readonly requirement: string;
  /** How the stage's work is accepted. */
  readonly acceptance: string;
  /** Optional reference to the plan this stage uses (a plan id or a plan-file path). */
  readonly planRef?: string;
}

export class StageMaterialError extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(code: string, detail: string) {
    super(`stage material refused [${code}]: ${detail}`);
    this.name = 'StageMaterialError';
    this.code = code;
    this.detail = detail;
  }
}

export function isStageMaterialError(value: unknown): value is StageMaterialError {
  return value instanceof StageMaterialError;
}

/**
 * Keys that would make the material approve itself. Their mere PRESENCE is refused — a
 * material that carries `approved: false` is still a material trying to speak for the
 * user, and guessing which spellings to ignore is how a self-approval slips through.
 */
const SELF_APPROVAL_KEYS = [
  'approved', 'approval', 'confirmed', 'confirmation', 'confirmedby', 'confirmedat',
  'approvedat', 'approvedby', 'accepted', 'signoff', 'sign_off', 'authorized',
] as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function text(value: unknown, where: string, required = true): string | undefined {
  if (value === undefined) {
    if (required) throw new StageMaterialError('missing-field', `${where} is required`);
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StageMaterialError('invalid-field', `${where} must be a non-empty string`);
  }
  if (value.length > STAGE_MATERIAL_MAX_TEXT) {
    throw new StageMaterialError('too-long', `${where} is ${value.length} chars, over the ${STAGE_MATERIAL_MAX_TEXT} limit`);
  }
  return value.trim();
}

/**
 * Parse and validate a stage material. Total and fail-closed: any violation throws a
 * `StageMaterialError` naming the field, and nothing is defaulted or dropped.
 */
export function parseStageMaterial(raw: unknown): StageMaterial {
  if (!isRecord(raw)) throw new StageMaterialError('invalid-root', 'the stage material must be a JSON object');
  // Refuse self-approval BEFORE anything else: the material is data, and data cannot vote.
  for (const key of Object.keys(raw)) {
    if ((SELF_APPROVAL_KEYS as readonly string[]).includes(key.toLowerCase())) {
      throw new StageMaterialError(
        'self-approval',
        `the material carries "${key}"; a material file cannot approve itself — approval comes only from the user's ` +
          'own entry (--confirm <digest>), bound to this material',
      );
    }
  }
  const stageId = text(raw.stageId, 'stageId')!;
  const scope = text(raw.scope, 'scope')!;
  const requirement = text(raw.requirement, 'requirement')!;
  const acceptance = text(raw.acceptance, 'acceptance')!;
  const planRef = text(raw.planRef, 'planRef', false);
  return Object.freeze({
    stageId, scope, requirement, acceptance,
    ...(planRef === undefined ? {} : { planRef }),
  });
}

/**
 * The digest a confirmation is bound to. Deterministic over the FIELDS THAT MATTER, so a
 * changed stage/scope/requirement/acceptance/planRef yields a different digest and an old
 * confirmation no longer matches. `notes`-style extras are deliberately not part of it.
 */
export function stageMaterialDigest(material: StageMaterial): string {
  const canonical = JSON.stringify({
    stageId: material.stageId,
    scope: material.scope,
    requirement: material.requirement,
    acceptance: material.acceptance,
    planRef: material.planRef ?? null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** A short, readable reference to the material: `<file>@<first 12 hex of the digest>`. */
export function stageMaterialRef(material: StageMaterial, fileName: string): string {
  return `${fileName}@${stageMaterialDigest(material).slice(0, 12)}`;
}

/**
 * B4.3a (P1-1): the digest the CONFIRMATION is actually bound to.
 *
 * The material alone is NOT enough. A confirmation must cover what will ACTUALLY run:
 * the objective, the workflow mode, the effective plan's CONTENT (roles, task types, file
 * scopes, deliverables, dependencies, integration responsibility), and the planRef. So a
 * confirmation made against one plan no longer matches a different plan id, a plan whose
 * content changed, or a changed objective/workflow scope — even if the material file is
 * byte-identical. `planScope` is a NORMALIZED, plain-data projection (built by the caller
 * from the existing typed plans), so reordering JSON keys or whitespace does not change it.
 */
export function stageBindingDigest(input: {
  readonly material: StageMaterial;
  readonly objective: string;
  readonly workflow: string;
  readonly planRef: string | null;
  readonly planScope: unknown;
  /**
   * P0-2: the bounded EFFECTIVE-EXECUTION-AUTHORIZATION projection (a plain value the
   * caller builds from the already-resolved selection, model pool, agent configs, skill/MCP
   * catalogue declarations, CLI limits, LAYA endpoint and review choice). When present it is
   * appended to the canonical payload, so approval of one execution surface no longer
   * authorizes a different one. When ABSENT the payload is byte-identical to before, so every
   * existing caller keeps its exact digest.
   */
  readonly authorization?: unknown;
}): string {
  const canonical = JSON.stringify({
    material: {
      stageId: input.material.stageId,
      scope: input.material.scope,
      requirement: input.material.requirement,
      acceptance: input.material.acceptance,
      planRef: input.material.planRef ?? null,
    },
    objective: input.objective,
    workflow: input.workflow,
    planRef: input.planRef,
    planScope: input.planScope,
    // Appended last and ONLY when supplied: the compatibility guarantee is that a call
    // without `authorization` produces the identical canonical string it always did.
    ...(input.authorization === undefined ? {} : { authorization: input.authorization }),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * B4.3a (P1-2): the material context embedded into the round objective, so the confirmed
 * requirement/acceptance reach the REAL acceptance criteria and brief.
 *
 * The material is embedded IN FULL — never truncated — because a summary that cuts off the
 * tail can drop a load-bearing constraint (the audit's `CRITICAL_DO_NOT_CHANGE_…` sat at the
 * end of a long requirement). When the material is too large to deliver this way, it is
 * REFUSED before any write rather than silently shortened; a reachable, content-bound
 * reference is future work, not a label pretending to be one.
 */
export function stageMaterialEmbed(material: StageMaterial, ref: string): string {
  const text =
    `[stage ${material.stageId} · ref ${ref}]\n` +
    `scope: ${material.scope}\n` +
    `requirement: ${material.requirement}\n` +
    `acceptance: ${material.acceptance}`;
  if (text.length > STAGE_EMBED_MAX_CHARS) {
    throw new StageMaterialError(
      'too-large-to-embed',
      `the stage material is ${text.length} chars, over the ${STAGE_EMBED_MAX_CHARS} that can be delivered in a ` +
        'task brief / acceptance; shorten it or split the stage. It is NOT silently truncated',
    );
  }
  return text;
}
