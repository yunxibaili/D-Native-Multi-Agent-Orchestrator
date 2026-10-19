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
 * Step 3 does not apply to an agent whose entry point `launcherFor()` refuses
 * to run: WorkBuddy's CLI is an extension-less `#!/usr/bin/env node` script, so
 * that adapter resolves its own launcher instead — and it registers TWO ids
 * (`workbuddy-cn` / `workbuddy-intl`) from one implementation, because the two
 * installs are separate provider identities. Everything else still holds —
 * `core/` and `orchestrator/` do not change. No plugin marketplace, no dynamic
 * loading, no code generation — just a table.
 */

import { createClineAdapter } from './cline.ts';
import { createCodexAdapter } from './codex.ts';
import { createDshAdapter } from './dsh.ts';
import { createOpenCodeAdapter } from './opencode.ts';
import { createWorkBuddyAdapter } from './workbuddy.ts';
import type { WorkBuddyId } from './workbuddy.ts';
import { denyExecutableBasename } from '../runtime/offline-policy.ts';
import type { AgentAdapter } from '../core/types.ts';

/*
 * OFFLINE DENIAL REGISTRATION. The real native launch targets whose basename is
 * NOT the agent id are registered here, at the SHARED factory table, so the
 * offline deny set knows them before any discovery runs. Registration is
 * monotonic and deny-only (no unmark/grant API), so it cannot promote an agent
 * to live. See src/runtime/offline-policy.ts.
 */
denyExecutableBasename('code-sidecar'); // Cline
denyExecutableBasename('codebuddy'); // WorkBuddy (CN + Intl), extension-less script

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
 *
 * WorkBuddy contributes TWO ids from ONE implementation: `workbuddy-cn` and
 * `workbuddy-intl` are independent provider identities, each resolving only its
 * own install (see adapters/workbuddy.ts). There is deliberately no bare
 * `workbuddy` id — that would reintroduce "whichever exists first".
 */
const WORKBUDDY_FACTORIES: Record<WorkBuddyId, AdapterFactory> = {
  'workbuddy-cn': (ctx) => createWorkBuddyAdapter('workbuddy-cn', { command: ctx.command }),
  'workbuddy-intl': (ctx) => createWorkBuddyAdapter('workbuddy-intl', { command: ctx.command }),
};

export const ADAPTER_FACTORIES: Readonly<Record<string, AdapterFactory>> = Object.freeze({
  opencode: createOpenCodeAdapter,
  codex: createCodexAdapter,
  // DSH (DeepSeek Harness) headless one-shot surface (see adapters/dsh.ts).
  dsh: createDshAdapter,
  // Cline has no CLI at all: its sidecar is reached over WebSocket, so it is
  // this table's first `app-server` transport (see adapters/cline.ts).
  cline: createClineAdapter,
  ...WORKBUDDY_FACTORIES,
});

export function knownAgentIds(): string[] {
  return Object.keys(ADAPTER_FACTORIES);
}

export function createAdapter(id: string, ctx: AdapterFactoryContext): AgentAdapter | null {
  const factory = ADAPTER_FACTORIES[id];
  return factory ? factory(ctx) : null;
}
