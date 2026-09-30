/**
 * memory/types.ts — contracts for the Project Memory Policy Layer.
 *
 * This layer wraps Hindsight as an EXTERNAL MEMORY BACKEND. It changes no
 * Hindsight code, no agent config, and nothing under src/runtime. Its whole job
 * is to stop the four PoC defects from leaking into the orchestrator:
 *
 *   F1  a database/bank that silently drifts (Hindsight's own default
 *       DATABASE_URL="pg0" opens a DIFFERENT embedded database than the one
 *       already holding memory — observed in the PoC as memories vanishing)
 *   F3  memory that reads as an instruction instead of as history
 *   F4  decisions that never supersede and contradictions nobody arbitrates
 *   F6  retain/consolidation LLM cost nobody accounts for
 *
 * Three rules run through every type below:
 *
 *   1. ABSENCE IS NOT ZERO. An unreadable token count is `null`, an unreadable
 *      bank is `unavailable`, an unclassified risk is `unknown`. `0` is a real
 *      measurement and is never used as a stand-in for "we did not look".
 *   2. MEMORY IS DATA, NOT INSTRUCTION. Everything that comes back from
 *      recall carries `UNTRUSTED_MEMORY` and travels inside a delimited
 *      envelope so a caller cannot mistake it for the current task's orders.
 *   3. THE CALLER DECIDES. This layer classifies, versions, detects conflict
 *      and reports; it never silently picks a winner and never auto-injects
 *      anything into a prompt.
 */

/** Where a memory came from. `unknown` is a valid answer, not a failure. */
export type MemorySourceType =
  | 'agent_retain'
  | 'orchestrator'
  | 'human'
  | 'git'
  | 'artifact'
  | 'import'
  | 'unknown';

/**
 * What a memory IS, not how it was phrased. `decision` is the only kind that
 * carries versioning (see MemoryDecisionFields) — plain facts deliberately have
 * no version system, because most facts do not have one.
 */
export const MEMORY_KINDS = [
  'fact',
  'decision',
  'experience',
  'observation',
  'artifact_reference',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** How much we trust the CONTENT of a record (never its importance). */
/**
 * How much a memory's own record supports citing it as an architecture fact.
 *
 * NOTE: confidence describes ORIGIN, not truth. `high` means "this was directly
 * observed from a named source", never "this is correct". Nothing in this layer
 * can prove a memory true, so confidence must never be promoted into a proof of
 * correctness by a caller.
 */
export type MemoryConfidence = 'high' | 'normal' | 'low' | 'unknown';

export const MEMORY_CONFIDENCES: readonly MemoryConfidence[] = ['high', 'normal', 'low', 'unknown'];

/** Confidences usable when citing a memory as an architecture fact. */
export const CITABLE_CONFIDENCES: readonly MemoryConfidence[] = ['high', 'normal'];

/** Lifecycle of a decision. Facts use `active` unless explicitly retired. */
export const DECISION_STATUSES = ['active', 'superseded', 'invalidated'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/**
 * Instruction-like detection outcome. `instruction_like` is NOT a deletion
 * verdict: the content is still returned as evidence, only marked so a caller
 * can never treat it as an order.
 */
export type MemoryClassification = 'benign' | 'instruction_like' | 'unknown';

/** Every memory leaves the layer carrying this marker, always. */
export const UNTRUSTED_MEMORY_MARKER = 'UNTRUSTED_MEMORY';

// ---- provenance -----------------------------------------------------------

/**
 * The provenance we attach to everything entering the layer. Backend-assigned
 * fields (memoryId) may be null until the backend confirms the write.
 */
export interface MemoryProvenance {
  /** Backend-assigned id; null until the backend confirms the write. */
  memoryId: string | null;
  /** The explicit project identity this memory belongs to (never a basename). */
  projectMemoryId: string;
  /** Which agent wrote it — 'unknown' when not attributable. */
  agentId: string;
  taskId: string | null;
  sessionId: string | null;
  /** Free-form origin label, e.g. a transcript path or a commit ref. */
  source: string;
  sourceType: MemorySourceType;
  createdAt: number;
  observedAt: number;
  kind: MemoryKind;
  confidence: MemoryConfidence;
  status: DecisionStatus;
}

// ---- decision versioning ---------------------------------------------------

/**
 * Present only on `kind: 'decision'`. `version` is a positive integer and
 * `supersedes` names the version it replaces; keeping this on a separate
 * interface is what stops the version system from spreading to plain facts.
 */
export interface MemoryDecisionFields {
  decisionKey: string;
  version: number;
  status: DecisionStatus;
  /** Version this decision replaces, e.g. 1 when this is version 2. */
  supersedes: number | null;
}

// ---- write side ------------------------------------------------------------

/** What the caller wants to remember. `kind` is required; nothing is inferred. */
export interface MemoryWrite {
  content: string;
  kind: MemoryKind;
  /** Required for `kind: 'decision'`; ignored (and rejected) otherwise. */
  decision?: MemoryDecisionFields;
  agentId?: string;
  taskId?: string | null;
  sessionId?: string | null;
  source?: string;
  sourceType?: MemorySourceType;
  confidence?: MemoryConfidence;
  tags?: string[];
  /** Caller-controlled observation time; defaults to now when omitted. */
  observedAt?: number;
}

// ---- read side -------------------------------------------------------------

/** One memory as the backend returned it, before policy is applied. */
export interface RawMemory {
  id: string;
  text: string;
  type: string | null;
  mentionedAt: string | null;
  metadata: Record<string, unknown>;
  tags: string[];
  scores: Record<string, number> | null;
}

/**
 * A memory after the policy layer has seen it. The content is UNCHANGED — the
 * layer annotates and classifies, it never rewrites or drops content silently.
 */
export interface ClassifiedMemory {
  memoryId: string;
  projectMemoryId: string;
  kind: MemoryKind;
  text: string;
  classification: MemoryClassification;
  /** Patterns that tripped instruction-like detection, empty when benign. */
  instructionSignals: string[];
  provenance: MemoryProvenance;
  decision: MemoryDecisionFields | null;
  confidence: MemoryConfidence;
  /**
   * Whether the caller may cite this memory as an evidence-backed architecture
   * fact. Derived from provenance: a memory whose origin is `low`/`unknown` is
   * NOT citable, because nothing in this layer can vouch for it. It is still
   * returned by recall — as history, not as fact.
   */
  allowedAsEvidence: boolean;
  /** Always false. A memory is never executable instruction. */
  executableInstruction: false;
  marker: typeof UNTRUSTED_MEMORY_MARKER;
  scores: Record<string, number> | null;
  mentionedAt: string | null;
}

// ---- conflicts -------------------------------------------------------------

/**
 * A `decisionKey` that has more than one `active` version. The layer reports
 * the conflict and its candidates; choosing a winner is the caller's job.
 */
export interface MemoryConflict {
  decisionKey: string;
  reason: string;
  candidates: Array<{ memoryId: string; version: number; text: string }>;
}

/** Decisions of one key after supersede/status filtering. */
export interface DecisionResolution {
  decisionKey: string;
  /** The single active decision, or null when none is active. */
  active: ClassifiedMemory | null;
  /** Version numbers excluded because they were superseded or invalidated. */
  excluded: Array<{ memoryId: string; version: number; status: DecisionStatus }>;
  conflict: MemoryConflict | null;
}

// ---- usage accounting (F6) -----------------------------------------------

/**
 * The operations whose LLM cost is real. `recall` and `embedding` are listed
 * because they are operations too — measured, not assumed: in the PoC recall
 * made ZERO LLM calls and embedding used a local CPU model.
 */
export const MEMORY_OPERATIONS = ['retain', 'reflect', 'recall', 'embedding'] as const;
export type MemoryOperation = (typeof MEMORY_OPERATIONS)[number];

/**
 * How the numbers were obtained. Aligned with Phase 4's `UsageClass`
 * (`observed | reported | estimated`) so a memory observation and a quota
 * observation mean the same thing to the same consumer.
 *
 * The layer NEVER produces `estimated` (§18): a guess must not enter a budget
 * wearing a measurement's clothes. The value exists in the type only so the
 * vocabulary matches Phase 4, and so a future adapter that legitimately estimates
 * cannot silently invent a fourth class. When no figure is measurable the class
 * is `unknown` and the token fields are `null`.
 */
export type MemoryUsageClass = 'observed' | 'reported' | 'estimated' | 'unknown';

/**
 * One memory operation's cost. Token fields are `null` when the backend does
 * not expose them, or when the figure cannot be attributed to THIS operation —
 * a null is a fact, a 0 would be a fabrication, and neither is a licence to
 * report a cumulative backend total as if it were this call's cost.
 */
export interface MemoryUsageObservation {
  /** Stable identity for this measurement; the budget ledger charges it at most once. */
  observationId: string;
  memoryOperation: MemoryOperation;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  /** LLM calls attributable to this operation; null when unattributable. */
  llmCalls: number | null;
  /**
   * Real USD cost. Phase 4 forbids inventing a cost without a cost source, and
   * the memory layer has none, so this is null — explicitly NOT 0.00. Deriving
   * a dollar figure from tokens would be a provider billing model, not a
   * measurement, and would silently disagree with the provider's invoice.
   */
  costUsd: number | null;
  /** Where costUsd came from; 'unavailable' whenever costUsd is null. */
  costSource: string;
  latencyMs: number;
  timestamp: number;
  source: string;
  usageClass: MemoryUsageClass;
  confidence: MemoryConfidence;
  /**
   * Backend scopes whose counter movement was attributed to this operation
   * (e.g. ['retain_extract_facts']). Empty when nothing could be attributed.
   */
  attributedScopes: string[];
  /**
   * Backend scopes that moved during the window but are NOT attributable to
   * this operation (e.g. background 'consolidation'). Reported so a reader can
   * see that activity happened and was deliberately excluded.
   */
  unattributedScopes: string[];
  /**
   * The backend's CUMULATIVE total-token counter per scope as of this
   * observation. Carried so the budget ledger can guarantee each counter
   * increment is charged at most once across overlapping operation windows.
   */
  scopeCounterValues: Record<string, number>;
  /**
   * This operation's measured total-token movement per ATTRIBUTED scope. The
   * ledger charges these (not the cumulative values), capped by whatever part of
   * the counter has not already been charged.
   */
  scopeDeltas: Record<string, number>;
}

// ---- results ---------------------------------------------------------------

/** Machine-readable failure codes. Memory failure is ALWAYS non-fatal. */
export const MEMORY_ERROR_CODES = [
  'memory-config-invalid',
  'memory-project-id-required',
  'memory-bank-unavailable',
  'memory-backend-unavailable',
  'memory-backend-error',
  'memory-timeout',
  'memory-malformed-response',
  'memory-decision-fields-invalid',
  'memory-kind-invalid',
] as const;
export type MemoryErrorCode = (typeof MEMORY_ERROR_CODES)[number];

/** Degraded-mode is the only "failure" shape the caller ever sees. */
export type MemoryStatus = 'ok' | 'degraded';

export interface MemoryError {
  code: MemoryErrorCode;
  reason: string;
  /** True when the caller may retry; false for configuration problems. */
  retryable: boolean;
}

export type MemoryResult<T> =
  | { ok: true; status: 'ok'; value: T; degraded: null; usage: MemoryUsageObservation | null }
  | { ok: false; status: 'degraded'; value: null; degraded: MemoryError; usage: MemoryUsageObservation | null };

// ---- recall output ---------------------------------------------------------

/**
 * A recall result, always carrying the envelope the caller must present. The
 * envelope is data with delimiters, not prose: it says what it is in its first
 * line, and it never merges with the caller's own instructions.
 */
export interface MemoryRecall {
  projectMemoryId: string;
  query: string;
  /** Decided ordering after policy filtering. */
  memories: ClassifiedMemory[];
  /** Decisions whose active version was resolved. */
  decisions: DecisionResolution[];
  /** Every unresolved contradiction, for the caller to arbitrate. */
  conflicts: MemoryConflict[];
  /** Instruction-like memories are listed here so the caller can refuse them. */
  instructionLikeIds: string[];
  /** The only sanctioned way to hand this to an agent. */
  envelope: MemoryEnvelope;
}

export interface MemoryEnvelope {
  /** Always UNTRUSTED_MEMORY — this is what makes the block self-describing. */
  marker: typeof UNTRUSTED_MEMORY_MARKER;
  /** Machine-readable body; prefer this over the text form. */
  structured: {
    notice: string;
    projectMemoryId: string;
    query: string;
    memories: Array<{ memoryId: string; kind: MemoryKind; classification: MemoryClassification; status: DecisionStatus; text: string }>;
    conflicts: MemoryConflict[];
  };
  /** Delimited text rendering, still carrying the marker on its first line. */
  text: string;
}
