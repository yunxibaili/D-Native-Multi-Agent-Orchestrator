/**
 * adapters/index.ts — the adapter factory table.
 *
 * Bootstrap is no longer hard-coded in the orchestrator. Adding a new agent
 * (ZCode, WorkBuddy, DSH, Claude Code) means:
 *
 *   1. write `adapters/<name>.ts` exporting `create<Name>Adapter`
 *   2. add ONE line to ADAPTER_FACTORIES below
 *   3. add known binary locations to `agentCandidates` in runtime/discover.ts
 *
 * `core/` and `orchestrator/` do not change. No plugin marketplace, no dynamic
 * loading, no code generation — just a table.
 */

import { createCodexAdapter } from './codex.ts';
import { createOpenCodeAdapter } from './opencode.ts';
import type { AgentAdapter } from '../core/types.ts';

export interface AdapterFactoryContext {
  /** Configured binary path for this agent, if any. */
  command?: string;
  /** Configured model, applied by the orchestrator, not the adapter. */
  model?: string;
}

export type AdapterFactory = (ctx: AdapterFactoryContext) => AgentAdapter;

/**
 * Registry of known agents. Insertion order is the display order of
 * `orchestrator doctor`.
 */
export const ADAPTER_FACTORIES: Readonly<Record<string, AdapterFactory>> = Object.freeze({
  opencode: createOpenCodeAdapter,
  codex: createCodexAdapter,
});

export function knownAgentIds(): string[] {
  return Object.keys(ADAPTER_FACTORIES);
}

export function createAdapter(id: string, ctx: AdapterFactoryContext): AgentAdapter | null {
  const factory = ADAPTER_FACTORIES[id];
  return factory ? factory(ctx) : null;
}
