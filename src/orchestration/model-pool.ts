/**
 * src/orchestration/model-pool.ts — P6-F. The code-level free model pool.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `docs/PHASE6A_FREE_MODEL_POOL.md` froze a verified list of locally-free models,
 * but until now that list existed only as prose. The Phase 6A audit named the
 * consequence plainly (CURRENT_STATE_AUDIT.md):
 *
 *   > 代码级免费池白名单不存在
 *
 * so nothing structurally prevented an assignment from picking a paid model. This
 * module turns the document into the single code-level source of truth.
 *
 * Reuse, not reinvention
 * ----------------------
 * Model identity is `(agentId, modelId)`, which is EXACTLY the composite key the
 * existing `ModelRegistry` already uses. This module imports that `modelKey`
 * rather than defining a second notion of provider/model identity. It imports
 * nothing else from `src/quota` — notably it does not extend, wrap or shadow
 * the registry, the availability model, or the quota semantics.
 *
 * Three outcomes, deliberately distinguishable
 * --------------------------------------------
 * The Phase 6 acceptance criterion is that a refusal can be told apart from an
 * availability problem. So:
 *
 *   allowed              — the pair is an ACTIVE pool entry
 *   not-in-pool          — never verified as free; fail-closed
 *   identity-mismatch    — the modelId IS a pool model, but paired with the wrong
 *                          agent. This is a caller bug, and saying "not in pool"
 *                          would hide it.
 *
 * Pure and side-effect free
 * -------------------------
 * This module never spawns an agent, never touches git, never calls the network,
 * and never mutates the registry. It answers one question with a lookup.
 */

/**
 * The single definition of model identity, imported read-only from the sealed
 * quota registry. Importing it here is the whole point: one notion of identity,
 * no second registry, and no change to `src/quota`.
 */
import { modelKey } from '../quota/registry.ts';

/** How confident we are that a model costs nothing. Mirrors the source doc. */
export type FreeEvidence =
  /** `-free` model id plus a real local run reporting `costUsd: 0`. */
  | 'confirmed-free'
  /** A real call reported `total_cost_usd: 0`; ceilings/time limits unknown. */
  | 'zero-at-call-time';

export interface FreeModelPoolEntry {
  /** Registry agent id — the same identity `ModelRegistry` keys on. */
  readonly agentId: string;
  /** Model id as passed to the adapter, e.g. `opencode/<model>` or bare `hy3`. */
  readonly modelId: string;
  /** Provider label, mirroring `ModelEntry.provider`. Documentation only. */
  readonly provider: string;
  /** Why this is considered free. Never widened without real evidence. */
  readonly evidence: FreeEvidence;
  /** One-line note on what was actually executed locally to confirm it. */
  readonly note: string;
}

/**
 * The frozen ACTIVE execution pool.
 *
 * Source of truth: `docs/PHASE6A_FREE_MODEL_POOL.md` (verified 2026-09-30 on this
 * machine by real CLI calls, not by reading pricing pages).
 *
 * Adding an entry here is a deliberate act that requires fresh local evidence.
 * Removing one is how a model that stops being free gets fenced off.
 */
export const ACTIVE_FREE_MODEL_POOL: readonly FreeModelPoolEntry[] = Object.freeze([
  Object.freeze({
    agentId: 'opencode',
    modelId: 'opencode/space-bunny-free',
    provider: 'opencode',
    evidence: 'confirmed-free',
    note: 'id contains "-free"; real run exit 0 with costUsd 0',
  }),
  Object.freeze({
    agentId: 'opencode',
    modelId: 'opencode/mimo-v2.6-flash-free',
    provider: 'opencode',
    evidence: 'confirmed-free',
    note: 'id contains "-free"; real run exit 0 with costUsd 0',
  }),
  Object.freeze({
    agentId: 'workbuddy-intl',
    modelId: 'hy3',
    provider: 'workbuddy',
    evidence: 'zero-at-call-time',
    note: 'real run exit 0, result frame total_cost_usd 0; ceiling unknown',
  }),
]);

/**
 * The default REVIEWER. Deliberately not an execution candidate: review happens
 * after execution and never competes for the free-worker pool.
 */
export const DEFAULT_REVIEWER: Readonly<{ agentId: string }> = Object.freeze({ agentId: 'codex' });

/**
 * Models that were explicitly ruled out, kept so the reason survives.
 *
 * This is documentation with teeth: `mimo-v4-flash-free` is a name that appears
 * in older notes, and it does not exist on this machine. Without this record, a
 * future reader could "restore" it from a stale reference.
 */
export const EXCLUDED_FROM_FREE_POOL: ReadonlyArray<Readonly<{ agentId?: string; modelId?: string; reason: string }>> =
  Object.freeze([
    Object.freeze({ agentId: 'opencode', modelId: 'opencode/mimo-v4-flash-free', reason: 'does not exist; real call exits 1 with UnknownError' }),
    Object.freeze({ agentId: 'opencode', modelId: 'opencode-go/*', reason: 'not in the free pool; not enabled this phase' }),
    Object.freeze({ agentId: 'workbuddy-cn', modelId: 'hy3', reason: 'build is unauthenticated ("Authentication required"), so the model is not callable there' }),
  ]);

export type ModelPoolVerdict =
  | { readonly allowed: true; readonly entry: FreeModelPoolEntry }
  /** Fail-closed: never verified as a free model. */
  | { readonly allowed: false; readonly reason: 'not-in-pool'; readonly detail: string }
  /** The modelId exists in the pool, but under a different agent. */
  | { readonly allowed: false; readonly reason: 'identity-mismatch'; readonly detail: string };

/**
 * Every ACTIVE entry, keyed by canonical identity.
 *
 * Keyed with the sealed registry's own `modelKey` so the codebase has exactly one
 * definition of model identity. If `modelKey` ever changes its separator, the pool
 * keys follow automatically instead of silently diverging into a second identity
 * space that would fail closed for every model.
 */
const POOL_BY_KEY: ReadonlyMap<string, FreeModelPoolEntry> = new Map(
  ACTIVE_FREE_MODEL_POOL.map((e) => [modelKey(e.agentId, e.modelId), e]),
);

/** Model ids that are in the pool for SOME agent. Used to spot a mismatched pair. */
const POOLED_MODEL_IDS: ReadonlySet<string> = new Set(ACTIVE_FREE_MODEL_POOL.map((e) => e.modelId));

/**
 * Is `(agentId, modelId)` an ACTIVE free model?
 *
 * Pure, total, and fail-closed: anything not positively listed is refused.
 */
export function isAllowedModel(input: { agentId: string; modelId: string | null | undefined }): ModelPoolVerdict {
  const { agentId } = input;
  const modelId = input.modelId ?? '';
  if (modelId === '') {
    return {
      allowed: false,
      reason: 'not-in-pool',
      detail: `no model was selected for agent "${agentId}"; the free pool is fail-closed, so an empty selection is not a pass`,
    };
  }
  const entry = POOL_BY_KEY.get(modelKey(agentId, modelId));
  if (entry !== undefined) {
    return { allowed: true, entry };
  }
  // Distinguish "wrong agent for a known pool model" from "not a pool model at all".
  if (POOLED_MODEL_IDS.has(modelId)) {
    const owner = ACTIVE_FREE_MODEL_POOL.find((e) => e.modelId === modelId);
    return {
      allowed: false,
      reason: 'identity-mismatch',
      detail: `model "${modelId}" is a pool model for agent "${owner?.agentId ?? '?'}", not for "${agentId}"; ` +
        `refusing rather than silently using another agent's model`,
    };
  }
  return {
    allowed: false,
    reason: 'not-in-pool',
    detail: `"${modelId}" is not in the ACTIVE free model pool for agent "${agentId}"; ` +
      `pool = [${[...POOL_BY_KEY.keys()].join(', ')}]`,
  };
}

/** True when the pair is an ACTIVE free model. Convenience over `isAllowedModel`. */
export function isInFreeModelPool(input: { agentId: string; modelId: string | null | undefined }): boolean {
  return isAllowedModel(input).allowed;
}

/**
 * Filter free-worker candidates to the pool. This is the intersection that
 * P6-B assignment must use; provided now so the intersection has one definition.
 *
 * Pure: it narrows a candidate list and never invents a candidate. An empty
 * result is a legitimate outcome, not an error to be papered over.
 */
export function intersectWithFreePool<T extends { agentId: string; modelId: string | null | undefined }>(
  candidates: readonly T[],
): T[] {
  return candidates.filter((c) => isAllowedModel(c).allowed);
}

/** The pool, for diagnostics and for a future `/models`-style surface. */
export function listFreeModelPool(): readonly FreeModelPoolEntry[] {
  return ACTIVE_FREE_MODEL_POOL;
}