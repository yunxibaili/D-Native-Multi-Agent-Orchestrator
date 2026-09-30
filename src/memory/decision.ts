/**
 * memory/decision.ts — F4: decisions supersede, and contradictions are REPORTED.
 *
 * The PoC left two real defects:
 *
 *   STALE      a decision changed from "port 4317" to "port 4318", and the OLD
 *              one still ranked first. Nothing in Hindsight knows one memory
 *              replaced another.
 *   CONTRADICT  "Python 3.11" and "Python 3.12" were both returned, side by
 *              side, with no arbitration and no signal that they conflict.
 *
 * Both are structural, not retrieval bugs, so they are fixed here — above the
 * backend, in the policy layer.
 *
 * Rules, in evaluation order:
 *
 *   1. Only `kind: 'decision'` participates. Plain facts get NO version system
 *      (§16 of the mandate): a fact is not a revision of itself.
 *   2. `superseded` and `invalidated` decisions are EXCLUDED from the active
 *      set — they are reported, not returned as current truth.
 *   3. A `supersedes` link is honoured even if the older version still claims
 *      `active`: writing v2 means v1 is no longer current, otherwise the stale
 *      defect returns through the back door.
 *   4. If two or more versions remain active for one `decisionKey`, that is a
 *      CONFLICT. We never pick a winner, never merge, and never drop one
 *      silently. The conflict carries its candidates and a reason, and the
 *      caller decides.
 */

import type {
  ClassifiedMemory,
  DecisionResolution,
  DecisionStatus,
  MemoryConflict,
  MemoryDecisionFields,
  MemoryError,
  MemoryResult,
} from './types.ts';

function fail(code: MemoryError['code'], reason: string): MemoryError {
  return { code, reason, retryable: false };
}

/**
 * Validate the decision fields a caller supplied. A decision without a
 * decisionKey or a positive integer version is a configuration mistake, and
 * rejecting it at write time is the only place we can catch it cheaply.
 */
export function validateDecisionFields(fields: MemoryDecisionFields): MemoryResult<MemoryDecisionFields> {
  if (typeof fields.decisionKey !== 'string' || fields.decisionKey.trim() === '') {
    return {
      ok: false,
      status: 'degraded',
      value: null,
      degraded: fail('memory-decision-fields-invalid', 'decisionKey is required for kind=decision'),
      usage: null,
    };
  }
  if (!Number.isInteger(fields.version) || fields.version < 1) {
    return {
      ok: false,
      status: 'degraded',
      value: null,
      degraded: fail(
        'memory-decision-fields-invalid',
        `decision version must be an integer >= 1, got ${String(fields.version)}`,
      ),
      usage: null,
    };
  }
  const status: DecisionStatus = fields.status;
  if (status !== 'active' && status !== 'superseded' && status !== 'invalidated') {
    return {
      ok: false,
      status: 'degraded',
      value: null,
      degraded: fail(
        'memory-decision-fields-invalid',
        `decision status must be active | superseded | invalidated, got "${String(status)}"`,
      ),
      usage: null,
    };
  }
  if (fields.supersedes !== null) {
    if (!Number.isInteger(fields.supersedes) || fields.supersedes < 1) {
      return {
        ok: false,
        status: 'degraded',
        value: null,
        degraded: fail(
          'memory-decision-fields-invalid',
          `supersedes must be a version integer >= 1 or null, got ${String(fields.supersedes)}`,
        ),
        usage: null,
      };
    }
    if (fields.supersedes >= fields.version) {
      return {
        ok: false,
        status: 'degraded',
        value: null,
        degraded: fail(
          'memory-decision-fields-invalid',
          `version ${fields.version} cannot supersede ${fields.supersedes} (must be a lower version)`,
        ),
        usage: null,
      };
    }
  }
  return { ok: true, status: 'ok', value: { ...fields, decisionKey: fields.decisionKey.trim() }, degraded: null, usage: null };
}

type DecisionMemory = ClassifiedMemory & { decision: MemoryDecisionFields };

function isDecision(m: ClassifiedMemory): m is DecisionMemory {
  return m.kind === 'decision' && m.decision !== null;
}

/** Group decisions by key. Non-decisions are ignored entirely. */
export function groupDecisions(memories: readonly ClassifiedMemory[]): Map<string, ClassifiedMemory[]> {
  const grouped = new Map<string, ClassifiedMemory[]>();
  for (const m of memories) {
    if (!isDecision(m)) continue;
    const list = grouped.get(m.decision.decisionKey) ?? [];
    list.push(m);
    grouped.set(m.decision.decisionKey, list);
  }
  return grouped;
}

/**
 * Resolve one decisionKey into its active decision, the versions it excluded,
 * and any conflict. Pure: the caller supplies the candidates.
 */
export function resolveDecision(decisionKey: string, candidates: readonly ClassifiedMemory[]): DecisionResolution {
  const withDecision: DecisionMemory[] = candidates.filter(isDecision);
  const excluded: DecisionResolution['excluded'] = [];

  // Explicitly retired versions drop out immediately.
  const stillActive: DecisionMemory[] = [];
  for (const m of withDecision) {
    if (m.decision.status === 'invalidated' || m.decision.status === 'superseded') {
      excluded.push({ memoryId: m.memoryId, version: m.decision.version, status: m.decision.status });
    } else {
      stillActive.push(m);
    }
  }

  // A supersedes link retires the named version even if it still says active.
  const supersededVersions = new Set<number>();
  for (const m of stillActive) {
    if (m.decision.supersedes !== null) supersededVersions.add(m.decision.supersedes);
  }

  // A retired record does NOT silently reinstate its predecessor. If v2 was
  // explicitly invalidated, quietly promoting v1 back to "the current decision"
  // would be the policy layer guessing at intent: the operator retired
  // something here, and what they now want is a human decision, not a fallback
  // to history. The predecessor stays visible and auditable as excluded.
  const notRestored = new Set<number>();
  for (const m of withDecision) {
    if (m.decision.status === 'invalidated' && m.decision.supersedes !== null) {
      notRestored.add(m.decision.supersedes);
    }
  }

  const active: DecisionMemory[] = [];
  for (const m of stillActive) {
    if (supersededVersions.has(m.decision.version)) {
      excluded.push({ memoryId: m.memoryId, version: m.decision.version, status: 'superseded' });
    } else if (notRestored.has(m.decision.version)) {
      excluded.push({ memoryId: m.memoryId, version: m.decision.version, status: 'superseded' });
    } else {
      active.push(m);
    }
  }

  active.sort((a, b) => b.decision.version - a.decision.version);

  let conflict: MemoryConflict | null = null;
  if (active.length > 1) {
    conflict = {
      decisionKey,
      reason:
        `${active.length} versions of decision "${decisionKey}" are simultaneously active ` +
        `(${active.map((m) => `v${m.decision.version}`).join(', ')}); the policy layer does not choose a winner`,
      candidates: active.map((m) => ({ memoryId: m.memoryId, version: m.decision.version, text: m.text })),
    };
  }

  return {
    decisionKey,
    // With a conflict there is no single active decision to hand back.
    active: conflict === null ? (active[0] ?? null) : null,
    excluded,
    conflict,
  };
}

/**
 * Resolve every decisionKey present in a recall. Returns one resolution per key
 * plus the flat conflict list the caller must arbitrate.
 */
export function resolveAllDecisions(memories: readonly ClassifiedMemory[]): {
  decisions: DecisionResolution[];
  conflicts: MemoryConflict[];
  /** The memories that are current: non-decisions plus the active decision. */
  current: ClassifiedMemory[];
} {
  const grouped = groupDecisions(memories);
  const decisions: DecisionResolution[] = [];
  const conflicts: MemoryConflict[] = [];
  const current: ClassifiedMemory[] = [];

  for (const m of memories) {
    if (!isDecision(m)) current.push(m);
  }

  for (const [key, candidates] of grouped) {
    const resolution = resolveDecision(key, candidates);
    decisions.push(resolution);
    if (resolution.conflict !== null) conflicts.push(resolution.conflict);
    if (resolution.active !== null) current.push(resolution.active);
  }

  return { decisions, conflicts, current };
}
