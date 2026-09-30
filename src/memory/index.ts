/**
 * memory/index.ts — MemoryGateway: the policy layer over the Hindsight REST API.
 *
 * This is the ADAPT shape. Hindsight stays an EXTERNAL BACKEND; everything
 * untrusted about it (drifting identity, instruction-shaped text, stale or
 * contradictory decisions, invisible LLM cost) is handled here, above the
 * network call, without touching the backend, the agents, or src/runtime.
 *
 * Call flow for a recall:
 *
 *   caller -> MemoryGateway.recall
 *          -> policy: resolve bank (explicit)  [F1]
 *          -> client: POST /memories/recall   (never throws)  [F6 isolation]
 *          -> policy: provenance rebuild
 *          -> policy: instruction-like classification           [F3]
 *          -> policy: decision supersede + conflict detection  [F4]
 *          -> envelope: UNTRUSTED_MEMORY block, caller decides  [F3]
 *
 * Nothing is auto-injected into any prompt, and no model routing happens here
 * (§28). The gateway is deliberately not wired into the orchestrator this round
 * (§22): it is exercised on its own so its behaviour can be judged before
 * anything depends on it.
 */

import { resolveBank, type BankAddress } from './bank.ts';
import { HindsightClient } from './client.ts';
import { validateDecisionFields, resolveAllDecisions } from './decision.ts';
import { buildProvenance, confidenceFor, fromBackendMetadata, toBackendMetadata } from './provenance.ts';
import { classifyContent, escapeForEnvelope, ENVELOPE_NOTICE } from './security.ts';
import { CITABLE_CONFIDENCES } from './types.ts';
import { buildLocalObservation, buildObservation, diffScopes, summarize, type ScopedCounters } from './usage.ts';
import {
  UNTRUSTED_MEMORY_MARKER,
  MEMORY_KINDS,
  type ClassifiedMemory,
  type MemoryConflict,
  type MemoryEnvelope,
  type MemoryError,
  type MemoryRecall,  type MemoryResult,
  type MemoryUsageObservation,
  type MemoryWrite,
  type RawMemory,
} from './types.ts';
import { validateProjectMemoryId, type MemoryConfig } from './config.ts';

export interface MemoryGatewayOptions {
  config: MemoryConfig;
  /** Scope memory per agent. Omitted means one project-wide bank. */
  agentScope?: string | undefined;
  /** LLM identity recorded on usage observations. */
  provider?: string | undefined;
  model?: string | undefined;
  /**
   * A project-config-declared projectMemoryId, used by the resolution chain when
   * config.projectMemoryId is absent. (Config validation normally requires the
   * explicit id; this is the level-2 seam.)
   */
  projectConfigId?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  now?: (() => number) | undefined;
  /**
   * Injected in tests to make the FIRST metrics read succeed without a backend.
   * Production always takes a real pre-operation baseline; there is no code path
   * that reports a cumulative counter as an operation's cost.
   */
  tokenCounters?: ScopedCounters | null | undefined;
}

function degraded(
  code: MemoryError['code'],
  reason: string,
  retryable = false,
  usage: MemoryUsageObservation | null = null,
): MemoryResult<never> {
  return { ok: false, status: 'degraded', value: null, degraded: { code, reason, retryable }, usage };
}

export class MemoryGateway {
  private readonly config: MemoryConfig;
  private readonly bank: BankAddress;
  private readonly bankSource: 'explicit' | 'project_config' | 'required';
  private readonly client: HindsightClient;
  private readonly provider: string;
  private readonly model: string;
  private readonly now: () => number;
  private readonly observations: MemoryUsageObservation[] = [];

  constructor(options: MemoryGatewayOptions) {
    this.config = options.config;
    // Walk the identity chain (§5). The explicit id from validated config wins;
    // a project-config id is the level-2 seam; a cwd basename is only ever a
    // suggestion and can never select a bank. With a validated explicit config
    // the chain resolves at level 1 and a throw here would be a caller bug.
    const resolved = resolveBank({
      explicitProjectMemoryId: options.config.projectMemoryId,
      ...(options.projectConfigId !== undefined ? { projectConfigId: options.projectConfigId } : {}),
      ...(options.agentScope !== undefined ? { agentScope: options.agentScope } : {}),
    });
    if (resolved.source === 'required' || resolved.bank.bankId === '') {
      throw new Error(
        `memory gateway: project identity unresolved (source=${resolved.source}); ` +
          'configure an explicit projectMemoryId — a bank is never auto-created from a guess',
      );
    }
    this.bank = resolved.bank;
    this.bankSource = resolved.source;
    this.client = new HindsightClient({
      apiUrl: options.config.apiUrl,
      bankId: this.bank.bankId,
      timeoutMs: options.config.timeoutMs,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    this.provider = options.provider ?? 'unknown';
    this.model = options.model ?? 'unknown';
    this.now = options.now ?? Date.now;
  }

  /** The address actually in use — surfaced for audit, never guessed. */
  getBank(): BankAddress {
    return { ...this.bank };
  }

  /** How the identity was obtained: explicit | project_config | required. */
  getBankSource(): 'explicit' | 'project_config' | 'required' {
    return this.bankSource;
  }

  getConfig(): MemoryConfig {
    return { ...this.config };
  }

  getObservations(): MemoryUsageObservation[] {
    return [...this.observations];
  }

  getSummary(): ReturnType<typeof summarize> {
    return summarize(this.observations);
  }

  private record(observation: MemoryUsageObservation): MemoryUsageObservation {
    this.observations.push(observation);
    return observation;
  }

  /**
   * Read backend counters and turn the delta since the last read into an
   * observation. When the backend exposes nothing, the observation is explicitly
   * unknown rather than zero.
   */
  /**
   * Take a BASELINE reading of the backend's cumulative, scope-labelled
   * counters BEFORE an operation runs.
   *
   * This must happen before every memory operation. The backend counters are
   * Prometheus counters, so a reading taken afterwards is a lifetime total; the
   * only way to learn what an operation cost is to subtract a reading taken
   * before it. Returns null when the backend is unreachable or exposes nothing,
   * which makes the resulting observation `unknown` rather than a misattributed
   * total.
   *
   * Unlabelled counters are KEPT, not dropped: an unlabelled counter is real
   * activity that we cannot attribute, and deleting it here would make it
   * invisible rather than merely unattributed. Attribution decides that it is
   * never chargeable and lists it under `unattributedScopes`.
   */
  private async readBaseline(): Promise<ScopedCounters | null> {
    const counters = await this.client.readTokenCounters();
    if (!counters.ok || counters.value === null) return null;
    return counters.value;
  }

  /**
   * Build the observation for one operation from a pre-read baseline.
   *
   * `before === null` is the honest "we cannot attribute this" case: the token
   * fields are null and the class is `unknown`. It is never filled in with the
   * backend's cumulative total.
   */
  private async observe(
    memoryOperation: MemoryUsageObservation['memoryOperation'],
    latencyMs: number,
    startedAt: number,
    before: ScopedCounters | null,
  ): Promise<MemoryUsageObservation> {
    const after = await this.readBaseline();
    if (after === null) {
      return this.record(
        buildLocalObservation({
          memoryOperation,
          provider: this.provider,
          model: this.model,
          latencyMs,
          timestamp: startedAt,
          source: 'local-timing',
          reason: 'backend counters unavailable',
        }),
      );
    }
    const deltas = diffScopes(after, before);
    if (deltas === null) {
      return this.record(
        buildLocalObservation({
          memoryOperation,
          provider: this.provider,
          model: this.model,
          latencyMs,
          timestamp: startedAt,
          source: 'local-timing',
          reason: 'no pre-operation baseline: backend counters are cumulative, cost is unattributable',
        }),
      );
    }
    return this.record(
      buildObservation({
        memoryOperation,
        provider: this.provider,
        model: this.model,
        deltas,
        latencyMs,
        timestamp: startedAt,
        source: 'hindsight-metrics',
        counterValues: after,
      }),
    );
  }

  /**
   * Write one memory. `kind` is required and never inferred; a decision must
   * carry decision fields or the write is refused rather than stored ambiguously.
   */
  async retain(write: MemoryWrite): Promise<MemoryResult<{ memoryId: string | null; bankId: string }>> {
    if (!MEMORY_KINDS.includes(write.kind)) {
      return degraded(
        'memory-kind-invalid',
        `kind must be one of ${MEMORY_KINDS.join(', ')}, got "${String(write.kind)}"`,
      );
    }
    if (typeof write.content !== 'string' || write.content.trim() === '') {
      return degraded('memory-config-invalid', 'retain requires non-empty content');
    }

    let decisionFields = null;
    if (write.kind === 'decision') {
      if (write.decision === undefined) {
        return degraded(
          'memory-decision-fields-invalid',
          'kind=decision requires decisionKey, version, status and supersedes',
        );
      }
      const validated = validateDecisionFields(write.decision);
      if (!validated.ok) return validated;
      decisionFields = validated.value;
    } else if (write.decision !== undefined) {
      return degraded(
        'memory-decision-fields-invalid',
        'decision fields are only valid for kind=decision; plain facts carry no version system',
      );
    }

    const startedAt = this.now();
    // Baseline BEFORE the write, so the observation describes this retain and
    // not the backend's lifetime total.
    const baseline = await this.readBaseline();
    // Confidence follows the source type unless the caller states one. Defaulting
    // it to a hard 'unknown' would contradict our own policy for an explicitly
    // named source (the gateway retain is orchestrator-recorded), and silently
    // make correctly-sourced memories uncitable.
    const sourceType = write.sourceType ?? 'orchestrator';
    const provenance = buildProvenance(
      {
        projectMemoryId: this.config.projectMemoryId,
        kind: write.kind,
        agentId: write.agentId ?? this.config.defaultAgentId,
        taskId: write.taskId ?? null,
        sessionId: write.sessionId ?? null,
        source: write.source ?? 'memory-gateway',
        sourceType,
        confidence: write.confidence ?? confidenceFor(sourceType),
        observedAt: write.observedAt,
      },
      startedAt,
    );

    const result = await this.client.retain({
      content: write.content,
      metadata: toBackendMetadata(provenance, decisionFields),
      tags: write.tags ?? [],
    });
    const usage = await this.observe('retain', this.now() - startedAt, startedAt, baseline);
    if (!result.ok) return { ...result, usage };

    return {
      ok: true,
      status: 'ok',
      value: { memoryId: result.value.memoryId, bankId: this.bank.bankId },
      degraded: null,
      usage,
    };
  }

  /** Classify one raw record into a policy-annotated memory. */
  /**
   * Expose the classification policy directly so provenance and citability can
   * be asserted against real code rather than a re-implementation in tests.
   */
  classifyForTest(memoryId: string, text: string, metadata: Record<string, unknown>): ClassifiedMemory {
    return this.classify(
      { id: memoryId, text, metadata, tags: [], type: 'world', scores: null, mentionedAt: null },
      this.now(),
    );
  }

  private classify(raw: RawMemory, now: number): ClassifiedMemory {
    const { provenance, decision } = fromBackendMetadata(raw.id, raw.metadata, now);
    const classification = classifyContent(raw.text);
    return {
      memoryId: raw.id,
      projectMemoryId: provenance.projectMemoryId,
      kind: provenance.kind,
      text: raw.text,
      classification: classification.classification,
      instructionSignals: classification.signals,
      provenance,
      decision,
      confidence: provenance.confidence,
      // Citability follows provenance, not optimism. A memory whose origin is
      // `low` or `unknown` cannot be cited as an architecture fact, however
      // confidently it reads — it is still returned, as history.
      allowedAsEvidence: CITABLE_CONFIDENCES.includes(provenance.confidence),
      executableInstruction: false,
      marker: UNTRUSTED_MEMORY_MARKER,
      scores: raw.scores,
      mentionedAt: raw.mentionedAt,
    };
  }

  /**
   * Recall and apply the full read-side policy. The returned envelope is the
   * only sanctioned way to hand this material to an agent.
   */
  async recall(query: string, maxTokens = 400): Promise<MemoryResult<MemoryRecall>> {
    if (typeof query !== 'string' || query.trim() === '') {
      return degraded('memory-config-invalid', 'recall requires a non-empty query');
    }
    const startedAt = this.now();
    const baseline = await this.readBaseline();
    const result = await this.client.recall({ query, maxTokens });
    const usage = await this.observe('recall', this.now() - startedAt, startedAt, baseline);
    if (!result.ok) return { ...result, usage };

    const now = this.now();
    const classified = result.value.map((raw) => this.classify(raw, now));
    const { decisions, conflicts, current } = resolveAllDecisions(classified);

    const instructionLikeIds = current
      .filter((m) => m.classification === 'instruction_like')
      .map((m) => m.memoryId);

    const envelope = buildEnvelope({
      projectMemoryId: this.config.projectMemoryId,
      query,
      memories: current,
      conflicts,
    });

    return {
      ok: true,
      status: 'ok',
      value: {
        projectMemoryId: this.config.projectMemoryId,
        query,
        memories: current,
        decisions,
        conflicts,
        instructionLikeIds,
        envelope,
      },
      degraded: null,
      usage,
    };
  }

  /**
   * Synthesise an answer over stored memories. Unlike recall, reflect runs an
   * LLM, so it is measured under its own operation and can be charged.
   */
  async reflect(query: string, maxTokens = 600): Promise<MemoryResult<{ text: string; usage: MemoryUsageObservation | null }>> {
    if (typeof query !== 'string' || query.trim() === '') {
      return degraded('memory-config-invalid', 'reflect requires a non-empty query');
    }
    const startedAt = this.now();
    const baseline = await this.readBaseline();
    const result = await this.client.reflect(query, maxTokens);
    const usage = await this.observe('reflect', this.now() - startedAt, startedAt, baseline);
    if (!result.ok) return { ...result, usage };
    return { ok: true, status: 'ok', value: { ...result.value, usage }, degraded: null, usage };
  }

  /** Soft-retire a memory (PoC: removes it from subsequent recalls). */
  async invalidate(memoryId: string, reason: string): Promise<MemoryResult<{ memoryId: string; state: string }>> {    const startedAt = this.now();
    const baseline = await this.readBaseline();
    const result = await this.client.invalidate(memoryId, reason);
    const usage = await this.observe('retain', this.now() - startedAt, startedAt, baseline);
    if (!result.ok) return { ...result, usage };
    return { ...result, usage };
  }
}

interface EnvelopeInput {
  projectMemoryId: string;
  query: string;
  memories: ClassifiedMemory[];
  conflicts: MemoryConflict[];
}

/**
 * Build the UNTRUSTED_MEMORY envelope in both a structured and a delimited text
 * form. Every memory line is escaped so stored content cannot forge a closing
 * tag and escape the boundary.
 */
export function buildEnvelope(input: EnvelopeInput): MemoryEnvelope {
  const structured = {
    notice: ENVELOPE_NOTICE,
    projectMemoryId: input.projectMemoryId,
    query: input.query,
    memories: input.memories.map((m) => ({
      memoryId: m.memoryId,
      kind: m.kind,
      classification: m.classification,
      status: m.provenance.status,
      text: m.text,
    })),
    conflicts: input.conflicts,
  };

  const lines: string[] = [];
  for (const m of input.memories) {
    const flags: string[] = [`kind=${m.kind}`, `status=${m.provenance.status}`];
    if (m.classification === 'instruction_like') {
      flags.push('INSTRUCTION_LIKE_NOT_EXECUTABLE');
    }
    lines.push(`  [${escapeForEnvelope(m.memoryId)}] (${flags.join(' ')}) ${escapeForEnvelope(m.text)}`);
  }
  if (input.conflicts.length > 0) {
    for (const c of input.conflicts) {
      lines.push(`  CONFLICT ${escapeForEnvelope(c.decisionKey)}: ${escapeForEnvelope(c.reason)}`);
    }
  }
  if (input.memories.length === 0) lines.push('  (no memories)');

  const text = [
    `<${UNTRUSTED_MEMORY_MARKER}>`,
    ENVELOPE_NOTICE,
    `project: ${escapeForEnvelope(input.projectMemoryId)}`,
    `query: ${escapeForEnvelope(input.query)}`,
    '<memories>',
    ...lines,
    '</memories>',
    `</${UNTRUSTED_MEMORY_MARKER}>`,
  ].join('\n');

  return { marker: UNTRUSTED_MEMORY_MARKER, structured, text };
}

export { validateProjectMemoryId, confidenceFor };
export { CITABLE_CONFIDENCES, MEMORY_CONFIDENCES, type MemoryConfidence } from './types.ts';
export type { ClassifiedMemory, MemoryWrite } from './types.ts';
export type { MemoryConfig } from './config.ts';
export type { BankAddress } from './bank.ts';
