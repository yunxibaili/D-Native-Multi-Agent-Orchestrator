/**
 * runtime/registry.ts — a narrow selection seam.
 *
 * Deliberately tiny, per agent-native's "the seam stays narrow, the consumer
 * never changes" rule: this file only resolves an id to an adapter. It contains
 * no orchestration logic and no decisions.
 *
 * There is intentionally NO `selectDefaultAgent()`. native-agent-router's rule
 * is explicit: no global "selected backend" that another call could silently
 * change. Every run names its agent.
 */

import type { AgentAdapter, AgentDescriptor } from '../core/types.ts';
import { AdapterNotFoundError } from '../core/errors.ts';
import { log } from '../core/log.ts';

export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): this {
    if (this.adapters.has(adapter.descriptor.id)) {
      throw new Error(`Adapter "${adapter.descriptor.id}" is already registered.`);
    }
    this.adapters.set(adapter.descriptor.id, adapter);
    log.debug('adapter registered', { id: adapter.descriptor.id });
    return this;
  }

  registerAll(list: readonly AgentAdapter[]): this {
    for (const a of list) this.register(a);
    return this;
  }

  /**
   * Register an adapter, REPLACING any existing one with the same id.
   *
   * Deliberately not folded into `register`. `register` refusing a duplicate is what
   * stops two implementations of the same agent from silently coexisting, and a caller
   * that means to override has to say so. The one production use today is a test or
   * embedding supplying its own adapter for an agent id that also exists locally,
   * where `register`'s refusal would otherwise leave the real one in place.
   */
  replace(adapter: AgentAdapter): this {
    const id = adapter.descriptor.id;
    const previous = this.adapters.get(id);
    this.adapters.set(id, adapter);
    log.debug('adapter replaced', { id, hadPrevious: previous !== undefined });
    return this;
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  ids(): string[] {
    return [...this.adapters.keys()];
  }

  /** Throws an actionable error listing what IS available. */
  get(id: string): AgentAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new AdapterNotFoundError(id, this.ids());
    return a;
  }

  descriptors(): AgentDescriptor[] {
    return [...this.adapters.values()].map((a) => a.descriptor);
  }
}
