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

// ===========================================================================
// B2.1 — USER-DECLARED NO-ADDITIONAL-CHARGE MODEL POOL (opt-in, minimum slice)
// ===========================================================================
//
// WHAT THIS IS, AND WHAT IT IS NOT
// --------------------------------
// A B2.1 declaration is the USER's own statement, in a bounded JSON file, that a
// concrete `(agentId, modelId)` pair should incur NO ADDITIONAL CHARGE for the
// orchestrator-managed runs of ONE round. It is ADMISSION, not evidence:
//
//   * it is NOT independently verified free entitlement, pricing, or account
//     eligibility, and no USD budget exists here to check it against;
//   * `source` is retained verbatim as provenance and is NEVER claimed to be
//     verified;
//   * `paid` and `unknown` declarations are FAIL-CLOSED — this slice performs NO
//     paid execution and a self-declared approval cannot authorize one;
//   * it constrains only the orchestrator-managed execution requests of the round
//     that supplied it. It does NOT constrain a native agent's own internal or
//     auxiliary calls (see the OpenCode `small_model`), the reviewer, or any model
//     the orchestrator did not select. It never promises a whole workflow is free.
//
// The legacy `ACTIVE_FREE_MODEL_POOL` above is a HISTORICAL static list. Its
// `-free` suffix and one old cost-0 run do NOT prove a CURRENT free entitlement, so
// the new declarations are a SEPARATE axis and deliberately do not promote, merge
// with, or re-derive from that list. `isAllowedModel` and its exports are unchanged
// and keep their exact previous meaning.

/** The one policy string this slice understands. Anything else is refused. */
export const USER_MODEL_POOL_POLICY = 'no-additional-charge';

/** The bounded byte size of the raw declaration file. */
export const USER_MODEL_POOL_MAX_BYTES = 32 * 1024;

/** The bounded number of declarations a pool may hold. */
export const USER_MODEL_POOL_MAX_ENTRIES = 32;

/** What the USER claims about a pair's billing. Never treated as verified. */
export type UserModelPoolBilling = 'free' | 'included' | 'paid' | 'unknown';

/** One user declaration. A frozen value; never mutated after parsing. */
export interface UserModelPoolEntry {
  /** Registry agent id — the same identity `modelKey` keys on. */
  readonly agentId: string;
  /** Exact model id, preserved byte-for-byte; never normalised or free-name-guessed. */
  readonly modelId: string;
  readonly billing: UserModelPoolBilling;
  /** Provenance text supplied by the user. NOT verified. */
  readonly source: string;
  /** Safe integer epoch ms the declaration was made. */
  readonly observedAt: number;
  /** Safe integer epoch ms the declaration stops applying. Must exceed `observedAt`. */
  readonly expiresAt: number;
}

/** A parsed, frozen user model pool. An empty `models` array is deny-all, not "no opinion". */
export interface UserModelPool {
  readonly policy: typeof USER_MODEL_POOL_POLICY;
  readonly models: readonly UserModelPoolEntry[];
}

/** A refusal from the parser or the reader, with a code that names the rule. */
export class UserModelPoolError extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'UserModelPoolError';
    this.code = code;
    this.detail = detail;
  }
}

export function isUserModelPoolError(e: unknown): e is UserModelPoolError {
  return e instanceof UserModelPoolError;
}

export type UserModelPoolParseResult =
  | { readonly ok: true; readonly pool: UserModelPool }
  | { readonly ok: false; readonly code: string; readonly detail: string };

/** Distinct, understandable predicate reason codes. */
export const USER_MODEL_POOL_REFUSAL_CODES = [
  'user-pool-now-invalid',
  'user-pool-model-unselected',
  'user-pool-empty',
  'user-pool-model-not-declared',
  'user-pool-agent-mismatch',
  'user-pool-billing-paid',
  'user-pool-billing-unknown',
  'user-pool-not-yet-observed',
  'user-pool-expired',
] as const;

const USER_POOL_ENTRY_KEYS: ReadonlySet<string> = new Set([
  'agentId', 'modelId', 'billing', 'source', 'observedAt', 'expiresAt',
]);
const USER_POOL_TOP_KEYS: ReadonlySet<string> = new Set(['policy', 'models']);
const USER_POOL_BILLING: ReadonlySet<string> = new Set(['free', 'included', 'paid', 'unknown']);
/** C0 controls and DEL, which no honest identifier needs. */
const C0_OR_DEL = /[\u0000-\u001f\u007f]/;

function safePoolId(value: unknown): value is string {
  // Nonblank, bounded, and free of C0/DEL. The EXACT string is preserved; nothing
  // here trims, lowercases, or guesses a suffix. `trim() !== ''` only rejects a
  // value that is nothing but whitespace.
  return typeof value === 'string'
    && value.length >= 1
    && value.trim() !== ''
    && !C0_OR_DEL.test(value);
}

function safePoolTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Parse an ALREADY-JSON-parsed declaration. Strict: unknown fields at either level
 * are refused (there is deliberately no place for `approved`, `allowPaid`, `cost0`
 * or URLs to ride along), as are wrong types, duplicates, and a bad expiry ordering.
 *
 * Pure and total: it never throws, never reads I/O, and never touches the registry.
 */
export function parseUserModelPool(raw: unknown): UserModelPoolParseResult {
  const fail = (code: string, detail: string): UserModelPoolParseResult => ({ ok: false, code, detail });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('user-pool-not-object', `the declaration must be a JSON object, got ${Array.isArray(raw) ? 'an array' : typeof raw}`);
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!USER_POOL_TOP_KEYS.has(key)) {
      return fail('user-pool-unknown-field', `unknown top-level field "${key}"; only "policy" and "models" are accepted`);
    }
  }
  if (record.policy !== USER_MODEL_POOL_POLICY) {
    return fail('user-pool-policy-invalid', `policy must be "${USER_MODEL_POOL_POLICY}", got ${JSON.stringify(record.policy)}`);
  }
  if (!Array.isArray(record.models)) {
    return fail('user-pool-models-invalid', `models must be an array, got ${typeof record.models}`);
  }
  if (record.models.length > USER_MODEL_POOL_MAX_ENTRIES) {
    return fail('user-pool-too-many-entries', `models declares ${record.models.length} entries, over the ${USER_MODEL_POOL_MAX_ENTRIES} limit`);
  }
  const seen = new Set<string>();
  const entries: UserModelPoolEntry[] = [];
  for (let i = 0; i < record.models.length; i++) {
    const rawEntry = record.models[i];
    if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) {
      return fail('user-pool-entry-not-object', `models[${i}] must be an object`);
    }
    const entry = rawEntry as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (!USER_POOL_ENTRY_KEYS.has(key)) {
        return fail('user-pool-entry-unknown-field', `models[${i}] has unknown field "${key}"`);
      }
    }
    if (!safePoolId(entry.agentId) || (entry.agentId as string).length > 256) {
      return fail('user-pool-agent-invalid', `models[${i}].agentId must be a non-blank string of 1..256 characters with no control characters`);
    }
    if (!safePoolId(entry.modelId) || (entry.modelId as string).length > 256) {
      return fail('user-pool-model-invalid', `models[${i}].modelId must be a non-blank string of 1..256 characters with no control characters`);
    }
    if (typeof entry.billing !== 'string' || !USER_POOL_BILLING.has(entry.billing)) {
      return fail('user-pool-billing-invalid', `models[${i}].billing must be one of free|included|paid|unknown, got ${JSON.stringify(entry.billing)}`);
    }
    if (!safePoolId(entry.source) || (entry.source as string).length > 512) {
      return fail('user-pool-source-invalid', `models[${i}].source must be a non-blank string of 1..512 characters with no control characters`);
    }
    if (!safePoolTimestamp(entry.observedAt)) {
      return fail('user-pool-observed-at-invalid', `models[${i}].observedAt must be a safe integer epochMs >= 0`);
    }
    if (!safePoolTimestamp(entry.expiresAt)) {
      return fail('user-pool-expires-at-invalid', `models[${i}].expiresAt must be a safe integer epochMs >= 0`);
    }
    if (entry.expiresAt <= entry.observedAt) {
      return fail('user-pool-expiry-not-after-observed', `models[${i}].expiresAt (${entry.expiresAt}) must be strictly after observedAt (${entry.observedAt})`);
    }
    const key = modelKey(entry.agentId as string, entry.modelId as string);
    if (seen.has(key)) {
      return fail('user-pool-duplicate-pair', `the pair "${key}" is declared more than once; a pair has one atomic declaration`);
    }
    seen.add(key);
    entries.push(Object.freeze({
      agentId: entry.agentId as string,
      modelId: entry.modelId as string,
      billing: entry.billing as UserModelPoolBilling,
      source: entry.source as string,
      observedAt: entry.observedAt,
      expiresAt: entry.expiresAt,
    }));
  }
  return { ok: true, pool: Object.freeze({ policy: USER_MODEL_POOL_POLICY, models: Object.freeze(entries) }) };
}

/**
 * Parse the RAW declaration TEXT. The byte bound is enforced BEFORE JSON.parse, so
 * an oversized file is refused without ever being decoded.
 */
export function parseUserModelPoolText(text: string): UserModelPoolParseResult {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > USER_MODEL_POOL_MAX_BYTES) {
    return {
      ok: false,
      code: 'user-pool-raw-too-large',
      detail: `the declaration is ${bytes} bytes, over the ${USER_MODEL_POOL_MAX_BYTES} byte limit`,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, code: 'user-pool-json-invalid', detail: `the declaration is not valid JSON: ${(e as Error).message}` };
  }
  return parseUserModelPool(raw);
}

export type UserModelPoolVerdict =
  | { readonly allowed: true; readonly entry: UserModelPoolEntry }
  | { readonly allowed: false; readonly code: string; readonly detail: string };

/**
 * The ONE pure admission predicate for the user model pool.
 *
 * Fail-closed and total. `now` is an EXPLICIT argument: there is no hidden clock
 * read, no I/O, and no registry mutation, so the same (pool, pair, now) always
 * yields the same verdict and a pair can never be admitted on a guess.
 */
export function admitUserModelPoolPair(
  pool: UserModelPool,
  input: { agentId: string; modelId: string | null | undefined },
  now: number,
): UserModelPoolVerdict {
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    return { allowed: false, code: 'user-pool-now-invalid', detail: `the evaluation time must be a finite number, got ${String(now)}` };
  }
  const modelId = input.modelId ?? '';
  if (modelId === '') {
    return {
      allowed: false,
      code: 'user-pool-model-unselected',
      detail: `no model was selected for agent "${input.agentId}"; the user model pool is fail-closed, so an empty selection is not a pass`,
    };
  }
  if (pool.models.length === 0) {
    return {
      allowed: false,
      code: 'user-pool-empty',
      detail: 'the user model pool declares no models, so every pair is refused (deny-all, not "no opinion")',
    };
  }
  // P1: compare BOTH fields EXACTLY. `modelKey` concatenates (`agent::model`), so a
  // declaration {agentId:'a::b', modelId:'m'} and a request {agentId:'a', modelId:'b::m'}
  // share the SAME modelKey text and would otherwise be admitted as if identical. Model
  // ids MAY contain ':' (they are preserved verbatim), so the identity of a declaration
  // is the PAIR of its two fields, never the concatenation. `modelKey` is still the
  // registry's identity and is untouched; only this admission lookup stops trusting it.
  const key = modelKey(input.agentId, modelId);
  const entry = pool.models.find((e) => e.agentId === input.agentId && e.modelId === modelId);
  if (entry === undefined) {
    const other = pool.models.find((e) => e.modelId === modelId && e.agentId !== input.agentId);
    if (other !== undefined) {
      return {
        allowed: false,
        code: 'user-pool-agent-mismatch',
        detail: `model "${modelId}" is declared for agent "${other.agentId}", not for "${input.agentId}"; refusing rather than using another agent's declaration`,
      };
    }
    return { allowed: false, code: 'user-pool-model-not-declared', detail: `"${input.agentId}/${modelId}" is not declared in the user model pool` };
  }
  if (entry.billing === 'paid') {
    return {
      allowed: false,
      code: 'user-pool-billing-paid',
      detail: `"${key}" is declared billing "paid"; this slice performs no paid execution and never authorizes it`,
    };
  }
  if (entry.billing === 'unknown') {
    return {
      allowed: false,
      code: 'user-pool-billing-unknown',
      detail: `"${key}" is declared billing "unknown"; only free/included declarations are admitted`,
    };
  }
  if (entry.observedAt > now) {
    return {
      allowed: false,
      code: 'user-pool-not-yet-observed',
      detail: `"${key}" was declared observedAt ${entry.observedAt}, which is after now (${now}); a future observation is not evidence`,
    };
  }
  if (entry.expiresAt <= now) {
    return {
      allowed: false,
      code: 'user-pool-expired',
      detail: `"${key}" expires at ${entry.expiresAt}, which is not after now (${now}); an expired declaration no longer applies`,
    };
  }
  return { allowed: true, entry };
}

/** Convenience over `admitUserModelPoolPair`. */
export function isUserModelPoolAllowed(
  pool: UserModelPool,
  input: { agentId: string; modelId: string | null | undefined },
  now: number,
): boolean {
  return admitUserModelPoolPair(pool, input, now).allowed;
}

/**
 * Filter candidates to those the user pool admits at `now`. Pure: it narrows a
 * list and never invents a candidate. An empty result is a legitimate refusal.
 */
export function filterWithUserModelPool<T extends { agentId: string; modelId: string | null | undefined }>(
  pool: UserModelPool,
  candidates: readonly T[],
  now: number,
): T[] {
  return candidates.filter((c) => admitUserModelPoolPair(pool, c, now).allowed);
}