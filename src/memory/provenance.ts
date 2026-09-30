/**
 * memory/provenance.ts — every memory carries where it came from.
 *
 * The PoC showed Hindsight preserves a caller-supplied `metadata` object
 * verbatim through retain and recall, so provenance can ride along without any
 * backend change. This module builds that metadata and reads it back.
 *
 * Two rules:
 *
 *   1. Never invent an identity. An unattributable write is `agentId: 'unknown'`
 *      and `sourceType: 'unknown'` — not a guess about which agent it was.
 *   2. Round-trip. `toProvenance` must be able to rebuild a complete record from
 *      what the backend returned, because a memory whose provenance cannot be
 *      reconstructed is a memory nobody can audit later.
 */

import type {
  MemoryConfidence,
  MemoryKind,
  MemoryProvenance,
  MemorySourceType,
  DecisionStatus,
} from './types.ts';

/** Metadata keys are namespaced so they cannot collide with backend fields. */
export const PROVENANCE_PREFIX = 'p4m';

export interface ProvenanceInput {
  projectMemoryId: string;
  kind: MemoryKind;
  agentId?: string | undefined;
  taskId?: string | null | undefined;
  sessionId?: string | null | undefined;
  source?: string | undefined;
  sourceType?: MemorySourceType | undefined;
  confidence?: MemoryConfidence | undefined;
  createdAt?: number | undefined;
  observedAt?: number | undefined;
}

function str(v: string | null | undefined): string {
  return v === undefined || v === null || v === '' ? 'unknown' : v;
}

function nullableStr(v: string | null | undefined): string | null {
  return v === undefined || v === null || v === '' ? null : v;
}

/**
 * Build a provenance record. `now` is passed in rather than read from the clock
 * so the function stays pure and testable.
 */
export function buildProvenance(input: ProvenanceInput, now: number): MemoryProvenance {
  return {
    memoryId: null,
    projectMemoryId: input.projectMemoryId,
    agentId: str(input.agentId),
    taskId: nullableStr(input.taskId),
    sessionId: nullableStr(input.sessionId),
    source: str(input.source),
    sourceType: input.sourceType ?? 'unknown',
    createdAt: input.createdAt ?? now,
    observedAt: input.observedAt ?? now,
    kind: input.kind,
    confidence: input.confidence ?? 'unknown',
    status: 'active',
  };
}

/**
 * The metadata object sent alongside a retain. Provenance is flattened into a
 * namespaced object so the backend stores it opaquely and we can rebuild it.
 *
 * Null-valued fields are OMITTED rather than sent as null, and every value is
 * serialised as a STRING: the backend's metadata schema is string-typed and
 * rejects both nulls and numbers with HTTP 422, which the ADAPT PoC hit on its
 * first two real writes. `fromBackendMetadata` parses the strings back, and
 * absence is still represented by a missing key.
 */
export function toBackendMetadata(
  provenance: MemoryProvenance,
  decision: { decisionKey: string; version: number; status: DecisionStatus; supersedes: number | null } | null,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    [`${PROVENANCE_PREFIX}_project`]: provenance.projectMemoryId,
    [`${PROVENANCE_PREFIX}_agent`]: provenance.agentId,
    [`${PROVENANCE_PREFIX}_source`]: provenance.source,
    [`${PROVENANCE_PREFIX}_source_type`]: provenance.sourceType,
    [`${PROVENANCE_PREFIX}_kind`]: provenance.kind,
    [`${PROVENANCE_PREFIX}_confidence`]: provenance.confidence,
    [`${PROVENANCE_PREFIX}_created_at`]: String(provenance.createdAt),
    [`${PROVENANCE_PREFIX}_observed_at`]: String(provenance.observedAt),
  };
  if (provenance.taskId !== null) metadata[`${PROVENANCE_PREFIX}_task`] = provenance.taskId;
  if (provenance.sessionId !== null) metadata[`${PROVENANCE_PREFIX}_session`] = provenance.sessionId;
  if (provenance.memoryId !== null) metadata[`${PROVENANCE_PREFIX}_memory_id`] = provenance.memoryId;
  if (decision !== null) {
    metadata[`${PROVENANCE_PREFIX}_decision_key`] = decision.decisionKey;
    metadata[`${PROVENANCE_PREFIX}_decision_version`] = String(decision.version);
    metadata[`${PROVENANCE_PREFIX}_decision_status`] = decision.status;
    if (decision.supersedes !== null) metadata[`${PROVENANCE_PREFIX}_supersedes`] = String(decision.supersedes);
  }
  return metadata;
}

function readString(meta: Record<string, unknown>, key: string): string | null {
  const v = meta[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

function readNumber(meta: Record<string, unknown>, key: string): number | null {
  const v = meta[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  // We serialise numerics as strings because the backend schema is string-typed.
  if (typeof v === 'string' && v.trim() !== '') {
    const parsed = Number(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

const KINDS = new Set<MemoryKind>(['fact', 'decision', 'experience', 'observation', 'artifact_reference']);
const SOURCE_TYPES = new Set<MemorySourceType>([
  'agent_retain',
  'orchestrator',
  'human',
  'git',
  'artifact',
  'import',
  'unknown',
]);
const CONFIDENCES = new Set<MemoryConfidence>(['high', 'normal', 'low', 'unknown']);

/**
 * Minimal, explicit confidence policy — deliberately NOT a scoring system.
 *
 * It answers exactly one question: how directly was this memory's origin
 * observed? It never claims a memory is *true*.
 *
 *   human / orchestrator / git  -> high    a named, direct source recorded it
 *   agent_retain / artifact    -> normal   an agent summarised or inferred it
 *   import                     -> low      third-party / bulk data of unclear age
 *   unknown                    -> unknown  we cannot say where it came from
 *
 * A memory that is missing provenance therefore never lands in `high` by
 * default: absence of provenance is itself the strongest argument against
 * treating a memory as a high-trust architecture fact.
 */
export function confidenceFor(sourceType: MemorySourceType): MemoryConfidence {
  switch (sourceType) {
    case 'human':
    case 'orchestrator':
    case 'git':
      return 'high';
    case 'agent_retain':
    case 'artifact':
      return 'normal';
    case 'import':
      return 'low';
    case 'unknown':
      return 'unknown';
  }
}

/**
 * Read a confidence back from backend metadata, tolerating the pre-4M-8
 * `medium` label written by earlier runs. An unrecognised or missing value is
 * `unknown`, never a guess.
 */
function resolveRecordedConfidence(raw: string | null): MemoryConfidence {
  if (raw === 'medium') return 'normal';
  return raw !== null && CONFIDENCES.has(raw as MemoryConfidence) ? (raw as MemoryConfidence) : 'unknown';
}
const STATUSES = new Set<DecisionStatus>(['active', 'superseded', 'invalidated']);

/**
 * Rebuild provenance from a backend record. Anything missing or malformed
 * degrades to 'unknown' rather than being invented, and `kind` falls back to
 * 'observation' only when the decision metadata is absent AND no kind was
 * recorded — an unlabelled memory is not a fact.
 */
export function fromBackendMetadata(
  memoryId: string,
  metadata: Record<string, unknown>,
  now: number,
): {
  provenance: MemoryProvenance;
  decision: { decisionKey: string; version: number; status: DecisionStatus; supersedes: number | null } | null;
} {
  const kindRaw = readString(metadata, `${PROVENANCE_PREFIX}_kind`);
  const kind: MemoryKind = kindRaw !== null && KINDS.has(kindRaw as MemoryKind)
    ? (kindRaw as MemoryKind)
    : 'observation';

  const sourceTypeRaw = readString(metadata, `${PROVENANCE_PREFIX}_source_type`);
  const sourceType: MemorySourceType = sourceTypeRaw !== null && SOURCE_TYPES.has(sourceTypeRaw as MemorySourceType)
    ? (sourceTypeRaw as MemorySourceType)
    : 'unknown';

  const confidenceRaw = readString(metadata, `${PROVENANCE_PREFIX}_confidence`);
  const confidence: MemoryConfidence = resolveRecordedConfidence(confidenceRaw);

  const createdAt = readNumber(metadata, `${PROVENANCE_PREFIX}_created_at`);
  const observedAt = readNumber(metadata, `${PROVENANCE_PREFIX}_observed_at`);

  const decisionKey = readString(metadata, `${PROVENANCE_PREFIX}_decision_key`);
  const decisionVersion = readNumber(metadata, `${PROVENANCE_PREFIX}_decision_version`);
  const decisionStatusRaw = readString(metadata, `${PROVENANCE_PREFIX}_decision_status`);
  const supersedes = readNumber(metadata, `${PROVENANCE_PREFIX}_supersedes`);

  const decision =
    decisionKey !== null && decisionVersion !== null
      ? {
          decisionKey,
          version: decisionVersion,
          status:
            decisionStatusRaw !== null && STATUSES.has(decisionStatusRaw as DecisionStatus)
              ? (decisionStatusRaw as DecisionStatus)
              : 'active',
          supersedes,
        }
      : null;

  return {
    provenance: {
      memoryId,
      projectMemoryId: readString(metadata, `${PROVENANCE_PREFIX}_project`) ?? 'unknown',
      agentId: readString(metadata, `${PROVENANCE_PREFIX}_agent`) ?? 'unknown',
      taskId: readString(metadata, `${PROVENANCE_PREFIX}_task`),
      sessionId: readString(metadata, `${PROVENANCE_PREFIX}_session`),
      source: readString(metadata, `${PROVENANCE_PREFIX}_source`) ?? 'unknown',
      sourceType,
      createdAt: createdAt ?? now,
      observedAt: observedAt ?? now,
      // A decision is a decision because its metadata says so.
      kind: decision !== null ? 'decision' : kind,
      confidence,
      status: decision?.status ?? 'active',
    },
    decision,
  };
}
