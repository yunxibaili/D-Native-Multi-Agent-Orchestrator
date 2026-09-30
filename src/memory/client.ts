/**
 * memory/client.ts — the only module that touches the network, and it never throws.
 *
 * §21 makes memory failure non-fatal by contract: a memory error may not change
 * RunResult, Session, Thread, Adapter or agent execution. The way that is
 * guaranteed is structural rather than by convention — this client converts
 * EVERY failure mode into a `MemoryResult` with `status: 'degraded'`, so a
 * caller cannot be forced to handle an exception:
 *
 *   - backend down / connection refused -> memory-backend-unavailable
 *   - slow backend                      -> memory-timeout
 *   - non-2xx from a real backend       -> memory-backend-error
 *   - bank missing                      -> memory-bank-unavailable
 *   - unparseable or unexpected body    -> memory-malformed-response
 *
 * A malformed response is treated as failure rather than coerced into an empty
 * success, because "no memories" and "we could not parse the answer" are
 * different facts and the second must never masquerade as the first.
 */

import type { MemoryErrorCode, MemoryResult, RawMemory, MemoryUsageObservation } from './types.ts';
import { UNLABELLED_SCOPE, type ScopedCounters } from './usage.ts';

export interface HindsightClientOptions {
  apiUrl: string;
  bankId: string;
  timeoutMs: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch | undefined;
  /** Injected clock for deterministic usage timestamps. */
  now?: (() => number) | undefined;
}

export interface RetainPayload {
  content: string;
  metadata: Record<string, unknown>;
  tags: string[];
}

export interface RecallPayload {
  query: string;
  maxTokens: number;
}

interface CallOutcome {
  status: number;
  body: unknown;
  latencyMs: number;
  timedOut: boolean;
  transportError: string | null;
}

/**
 * Transport-level access to the Hindsight REST API. Every method resolves to a
 * MemoryResult; there is no code path that rejects.
 */
export class HindsightClient {
  private readonly apiUrl: string;
  private readonly bankId: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /**
   * A one-shot CLI must not leave undici's keep-alive socket pool alive, or the
   * process lingers after the memory op and its exit status is unreliable. The
   * memory layer is not a throughput path, so we close the connection per call.
   */
  private readonly connection: 'close';

  constructor(options: HindsightClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.bankId = options.bankId;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.connection = 'close';
  }

  getBankId(): string {
    return this.bankId;
  }

  /** One HTTP round-trip, fully guarded. Never throws. */
  private async call(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<CallOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = this.now();
    try {
      const response = await this.fetchImpl(`${this.apiUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json', connection: this.connection },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        // keep the raw text; the caller decides whether it is usable
      }
      return { status: response.status, body: parsed, latencyMs: this.now() - started, timedOut: false, transportError: null };
    } catch (error) {
      const aborted = controller.signal.aborted;
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: 0,
        body: null,
        latencyMs: this.now() - started,
        timedOut: aborted,
        transportError: aborted ? `timeout after ${this.timeoutMs}ms` : message,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private degraded(
    code: MemoryErrorCode,
    reason: string,
    retryable: boolean,
    usage: MemoryUsageObservation | null,
  ): MemoryResult<never> {
    return { ok: false, status: 'degraded', value: null, degraded: { code, reason, retryable }, usage };
  }

  /** `op` is a label for the message; it is not restricted to MemoryOperation. */
  private transportFailure(outcome: CallOutcome, op: string): MemoryResult<never> {
    if (outcome.timedOut) {
      return this.degraded('memory-timeout', `${op} timed out after ${this.timeoutMs}ms`, true, null);
    }
    return this.degraded(
      'memory-backend-unavailable',
      `${op} could not reach the memory backend at ${this.apiUrl}: ${outcome.transportError ?? 'unknown transport error'}`,
      true,
      null,
    );
  }

  private bankUnavailable(detail: string): MemoryResult<never> {
    return this.degraded('memory-bank-unavailable', detail, false, null);
  }

  /** Retain one memory. Usage tokens are unknown here; the metrics pass fills them. */
  async retain(payload: RetainPayload): Promise<MemoryResult<{ memoryId: string | null; operationId: string | null }>> {
    const outcome = await this.call('POST', `/v1/default/banks/${encodeURIComponent(this.bankId)}/memories`, {
      items: [{ content: payload.content, metadata: payload.metadata, tags: payload.tags }],
    });

    if (outcome.status === 0) return this.transportFailure(outcome, 'retain');
    if (outcome.status === 404) return this.bankUnavailable(`bank "${this.bankId}" not found on the memory backend`);
    if (outcome.status < 200 || outcome.status >= 300) {
      return this.degraded(
        'memory-backend-error',
        `retain failed with HTTP ${outcome.status}: ${JSON.stringify(outcome.body).slice(0, 200)}`,
        outcome.status >= 500,
        null,
      );
    }
    if (typeof outcome.body !== 'object' || outcome.body === null) {
      return this.degraded('memory-malformed-response', 'retain returned a non-object body', true, null);
    }
    const record = outcome.body as Record<string, unknown>;
    return {
      ok: true,
      status: 'ok',
      degraded: null,
      usage: null,
      value: {
        memoryId: typeof record.memory_id === 'string' ? record.memory_id : null,
        operationId: typeof record.operation_id === 'string' ? record.operation_id : null,
      },
    };
  }

  /**
   * Recall memories. A body that is not the documented shape is a FAILURE, not
   * an empty result — see the module header.
   */
  async recall(payload: RecallPayload): Promise<MemoryResult<RawMemory[]>> {
    const outcome = await this.call('POST', `/v1/default/banks/${encodeURIComponent(this.bankId)}/memories/recall`, {
      query: payload.query,
      max_tokens: payload.maxTokens,
    });

    if (outcome.status === 0) return this.transportFailure(outcome, 'recall');
    if (outcome.status === 404) return this.bankUnavailable(`bank "${this.bankId}" not found on the memory backend`);
    if (outcome.status < 200 || outcome.status >= 300) {
      return this.degraded(
        'memory-backend-error',
        `recall failed with HTTP ${outcome.status}: ${JSON.stringify(outcome.body).slice(0, 200)}`,
        outcome.status >= 500,
        null,
      );
    }
    if (typeof outcome.body !== 'object' || outcome.body === null || Array.isArray(outcome.body)) {
      return this.degraded('memory-malformed-response', 'recall returned a body that is not an object', true, null);
    }
    const results = (outcome.body as Record<string, unknown>).results;
    if (results !== undefined && !Array.isArray(results)) {
      return this.degraded('memory-malformed-response', 'recall "results" field is not an array', true, null);
    }
    const list = (results ?? []) as unknown[];
    const parsed: RawMemory[] = [];
    for (const item of list) {
      if (typeof item !== 'object' || item === null) {
        return this.degraded('memory-malformed-response', 'recall returned a non-object memory entry', true, null);
      }
      const row = item as Record<string, unknown>;
      if (typeof row.id !== 'string' || typeof row.text !== 'string') {
        return this.degraded('memory-malformed-response', 'recall memory entry lacks id or text', true, null);
      }
      parsed.push({
        id: row.id,
        text: row.text,
        type: typeof row.type === 'string' ? row.type : null,
        mentionedAt: typeof row.mentioned_at === 'string' ? row.mentioned_at : null,
        metadata:
          typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata)
            ? (row.metadata as Record<string, unknown>)
            : {},
        tags: Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === 'string') : [],
        scores:
          typeof row.scores === 'object' && row.scores !== null && !Array.isArray(row.scores)
            ? (row.scores as Record<string, number>)
            : null,
      });
    }
    return { ok: true, status: 'ok', value: parsed, degraded: null, usage: null };
  }

  /** Soft-retire a memory (PoC: state=invalidated removes it from recall). */
  async invalidate(memoryId: string, reason: string): Promise<MemoryResult<{ memoryId: string; state: string }>> {
    const outcome = await this.call(
      'PATCH',
      `/v1/default/banks/${encodeURIComponent(this.bankId)}/memories/${encodeURIComponent(memoryId)}`,
      { state: 'invalidated', reason },
    );
    if (outcome.status === 0) return this.transportFailure(outcome, 'invalidate');
    if (outcome.status === 404) return this.bankUnavailable(`bank or memory "${memoryId}" not found`);
    if (outcome.status < 200 || outcome.status >= 300) {
      return this.degraded(
        'memory-backend-error',
        `invalidate failed with HTTP ${outcome.status}: ${JSON.stringify(outcome.body).slice(0, 200)}`,
        outcome.status >= 500,
        null,
      );
    }
    const record = (typeof outcome.body === 'object' && outcome.body !== null ? outcome.body : {}) as Record<string, unknown>;
    return {
      ok: true,
      status: 'ok',
      value: { memoryId, state: typeof record.state === 'string' ? record.state : 'invalidated' },
      degraded: null,
      usage: null,
    };
  }

  /**
   * Ask the backend to synthesise an answer over stored memories. Reflect is an
   * LLM-bound operation (an agentic tool-calling loop, unlike recall), so it is
   * costed as its own scope rather than folded into recall.
   */
  async reflect(query: string, maxTokens: number): Promise<MemoryResult<{ text: string }>> {
    const outcome = await this.call('POST', `/v1/default/banks/${encodeURIComponent(this.bankId)}/reflect`, {
      query,
      max_tokens: maxTokens,
    });
    if (outcome.status === 0) return this.transportFailure(outcome, 'reflect');
    if (outcome.status === 404) return this.bankUnavailable(`bank "${this.bankId}" not found on the memory backend`);
    if (outcome.status < 200 || outcome.status >= 300) {
      return this.degraded(
        'memory-backend-error',
        `reflect failed with HTTP ${outcome.status}: ${JSON.stringify(outcome.body).slice(0, 200)}`,
        outcome.status >= 500,
        null,
      );
    }
    if (typeof outcome.body !== 'object' || outcome.body === null) {
      return this.degraded('memory-malformed-response', 'reflect returned a non-object body', true, null);
    }
    const record = outcome.body as Record<string, unknown>;
    return {
      ok: true,
      status: 'ok',
      value: { text: typeof record.text === 'string' ? record.text : '' },
      degraded: null,
      usage: null,
    };
  }

  /**
   * Read the backend's LLM counters, GROUPED BY SCOPE.
   *
   * The backend exposes Prometheus CUMULATIVE counters (`# TYPE ... counter`)
   * labelled with the scope that incremented them, e.g.
   *   hindsight_llm_tokens_input_tokens_total{scope="retain_extract_facts",token_bucket="0-100"} 11505
   *   hindsight_llm_tokens_input_tokens_total{scope="verification",token_bucket="0-100"} 33
   * Two label dimensions matter and BOTH are honoured here:
   *   - `scope`      : which operation incremented it. Summing across scopes
   *                   would mix retain + consolidation + verification into one
   *                   un-attributable number.
   *   - `token_bucket`: one logical counter is split into buckets, so buckets
   *                   ARE summed — but only within the same scope.
   *
   * A line with no `scope=` label is filed under UNLABELLED_SCOPE so the caller
   * can refuse to charge it to a specific operation.
   */
  async readTokenCounters(): Promise<MemoryResult<ScopedCounters | null>> {
    const outcome = await this.call('GET', '/metrics');
    if (outcome.status === 0) return this.transportFailure(outcome, 'usage');
    if (outcome.status < 200 || outcome.status >= 300) {
      return this.degraded('memory-backend-error', `metrics unavailable (HTTP ${outcome.status})`, true, null);
    }
    if (typeof outcome.body !== 'string') {
      return { ok: true, status: 'ok', value: null, degraded: null, usage: null };
    }
    const text = outcome.body;
    const scopes: ScopedCounters = new Map();
    const add = (scope: string, field: 'input' | 'output' | 'calls', value: number): void => {
      const row = scopes.get(scope) ?? { input: 0, output: 0, calls: 0 };
      row[field] += value;
      scopes.set(scope, row);
    };
    const parse = (prefix: string, field: 'input' | 'output' | 'calls'): void => {
      for (const line of text.split('\n')) {
        if (!line.startsWith(prefix)) continue;
        const open = line.indexOf('{');
        const close = line.indexOf('}');
        const value = Number(line.slice(line.lastIndexOf(' ') + 1));
        if (!Number.isFinite(value)) continue;
        const labels = open > -1 && close > open ? line.slice(open + 1, close) : '';
        const scopeMatch = labels.match(/scope="([^"]*)"/);
        add(scopeMatch !== null && scopeMatch[1] !== '' ? scopeMatch[1] : UNLABELLED_SCOPE, field, value);
      }
    };
    parse('hindsight_llm_tokens_input_tokens_total', 'input');
    parse('hindsight_llm_tokens_output_tokens_total', 'output');
    parse('hindsight_llm_calls_total', 'calls');
    if (scopes.size === 0) return { ok: true, status: 'ok', value: null, degraded: null, usage: null };
    return { ok: true, status: 'ok', value: scopes, degraded: null, usage: null };
  }
}
