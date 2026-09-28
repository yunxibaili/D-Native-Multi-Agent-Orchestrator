/**
 * tests/helpers.ts — a minimal, dependency-free adapter stub.
 *
 * Its `mapEvent` understands nothing about OpenCode or Codex; it exists so
 * the registry can be tested without a real binary.
 */

import type {
  AgentAdapter,
  AgentCapabilities,
  AgentDescriptor,
  Invocation,
  MapContext,
  ProbeResult,
  RunRequest,
  TerminalSignal,
  ToolCall,
  Usage,
} from '../src/core/types.ts';
import * as E from '../src/core/event.ts';

const CAPS: AgentCapabilities = {
  newTask: true,
  resume: false,
  fork: false,
  review: false,
  worktree: false,
  stdinPrompt: false,
  sandbox: false,
  streamEvents: true,
  roleSelection: false,
  costReporting: false,
  steering: false,
};

export function collectSmokeStubs(): AgentAdapter {
  const descriptor: AgentDescriptor = {
    id: 'stub-agent',
    displayName: 'Stub Agent',
    executable: 'stub',
    version: '0.0.0',
    transport: 'cli',
    capabilities: CAPS,
  };

  return {
    descriptor,
    async probe(): Promise<ProbeResult> {
      return { ok: true, executable: 'stub', version: '0.0.0', detail: 'stub', warnings: [] };
    },
    buildInvocation(req: RunRequest): Invocation {
      return { command: 'stub', args: ['run', req.prompt], promptVia: 'argv' };
    },
    mapEvent(native: unknown, ctx: MapContext) {
      const n = native as { text?: string; session?: string };
      if (n.text) {
        ctx.sink.noteText(n.text);
        return [E.output({ taskId: ctx.taskId, agentId: ctx.agentId, threadId: n.session ?? null }, native, n.text)];
      }
      return [];
    },
    detectTerminal(): TerminalSignal | null {
      return null;
    },
    extractText(native: unknown): string | null {
      return (native as { text?: string }).text ?? null;
    },
    extractToolCall(): ToolCall | null {
      return null;
    },
    extractUsage(): Partial<Usage> | null {
      return null;
    },
  };
}
