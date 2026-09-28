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
