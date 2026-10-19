/**
 * tests/helpers/native-agent-policy.ts — controllable adapter + fixtures for the
 * OFFLINE cancel / isolation suites.
 *
 * The adapter below runs a CONTROLLED Node fixture through the REAL runtime chain
 * (`Orchestrator` -> `AgentSession` -> `CliJsonlTransport` -> contained
 * `ManagedProcess`). It is registered by `replaceAdapters`, and its launcher is a
 * plain `node` launcher whose target is a fixture script — so the offline policy
 * (which matches real AGENT identities, not arbitrary node scripts) lets it run while
 * every real agent stays refused.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { installOfflinePolicy } from '../../src/runtime/offline-policy.ts';
import * as E from '../../src/core/event.ts';
import type { RuntimeEvent } from '../../src/core/event.ts';
import { CliJsonlTransport } from '../../src/runtime/transport/cli.ts';
import { launcherFor } from '../../src/runtime/launcher.ts';
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentDescriptor,
  LauncherSpec,
  MapContext,
  ProbeResult,
  RunRequest,
  TerminalDecision,
  TerminalInput,
  TerminalPolicy,
  Transport,
  TransportFrame,
} from '../../src/core/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The controlled fixture script, run by `node`. */
export const FIXTURE_PATH = join(HERE, 'cancel-fixture.cjs');

/** The launcher for a plain `node` process (never a real agent). */
export function nodeLauncher(): LauncherSpec {
  const res = launcherFor(process.execPath);
  if (!res.ok) throw new Error(`cannot build a node launcher: ${res.reason}`);
  return res.launcher;
}

export interface FixtureScenario {
  readonly mode: 'exit' | 'session' | 'stderr' | 'hang' | 'tree' | 'heartbeat' | 'stream';
  readonly text?: string;
  readonly code?: number;
  readonly session?: string;
  readonly lines?: readonly string[];
  readonly heartbeatMs?: number;
  readonly childHeartbeat?: string;
}

/**
 * REFUSE an unauthorized REAL-agent suite entry.
 *
 * Every native Live entry calls this as its FIRST statement, BEFORE any setup,
 * discovery or model transport. It freezes the offline deny policy and reports
 * NOT_RUN honestly.
 *
 * Declared `void`, NOT `never`, on purpose: an inlined top-level `process.exit(0)`
 * makes TypeScript treat the rest of the module as unreachable and narrow every
 * fixture to `never` (the P0-1 rework's static errors). Routing the refusal through
 * a `void` function keeps the caller's remaining code reachable to the checker while
 * still refusing at runtime. There is deliberately NO promote-to-live API / env flag.
 */
export function refuseLiveEntry(label: string): void {
  installOfflinePolicy();
  process.stdout.write(`${label}: NOT_RUN (real-agent execution not authorized; offline policy frozen)\n`);
  process.exit(0);
}

/**
 * Write the per-run fixture scenario into the run's cwd, creating the owned
 * directory first so a caller that names a not-yet-created subdirectory does not
 * get ENOENT.
 */
export function writeScenario(cwd: string, scenario: FixtureScenario): void {
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'fixture-mode.json'), JSON.stringify(scenario), 'utf8');
}

const CAPABILITIES: AgentCapabilities = {
  newTask: true,
  resume: true,
  review: false,
  modelSelection: false,
  roleSelection: false,
  sandbox: false,
  streamEvents: true,
  costReporting: false,
  extraArgs: false,
  cwd: true,
  skills: false,
  steering: false,
  worktree: false,
  fork: false,
  stdinPrompt: false,
  workspaceModes: ['shared'],
};

/**
 * A controlled adapter for the offline cancel/lifecycle suites.
 *
 * It supports resume (threadId) so the runtime's resume ownership path can be
 * exercised without any real agent.
 */
export function createOfflineFixtureAdapter(config?: { id?: string }): AgentAdapter {
  const launcher = nodeLauncher();
  const id = config?.id ?? 'offline-fixture';

  const descriptor: AgentDescriptor = {
    id,
    displayName: 'Offline Fixture Agent',
    launcher,
    transport: 'cli-jsonl',
    capabilities: CAPABILITIES,
  };

  const terminalPolicy: TerminalPolicy = (input: TerminalInput): TerminalDecision => {
    if (input.localAbort) {
      return { state: 'failed', error: { code: 'TRANSPORT_ERROR', message: `local abort: ${input.localAbort}` } };
    }
    if (input.exit.code === 0) return { state: 'succeeded', error: null };
    return {
      state: 'failed',
      error: {
        code: input.exit.code === null ? 'TRANSPORT_ERROR' : 'NONZERO_EXIT',
        message: `fixture exit ${input.exit.code}${input.exit.stderrTail ? `: ${input.exit.stderrTail.slice(0, 200)}` : ''}`,
      },
    };
  };

  return {
    descriptor,
    terminalPolicy,

    validateRequest(_req: RunRequest): void {
      // Resume and default mode are both supported; nothing to refuse.
    },

    async probe(): Promise<ProbeResult> {
      return { ok: true, launcher, version: '0.0.0-fixture', detail: 'offline fixture adapter', warnings: [] };
    },

    createTransport(req: RunRequest): Transport {
      return new CliJsonlTransport({ launcher, args: [FIXTURE_PATH], cwd: req.cwd });
    },

    mapEvent(frame: TransportFrame, ctx: MapContext): RuntimeEvent[] {
      if (frame.channel === 'stderr') {
        ctx.sink.noteDiagnostic(`stderr: ${frame.text}`);
        return [E.diagnostic({ taskId: ctx.taskId, agentId: ctx.agentId, threadId: ctx.threadId }, frame, frame.text)];
      }
      if (frame.channel !== 'stdout') return [];
      const data = frame.data as { session?: string; text?: string } | undefined;
      if (typeof data?.session === 'string' && data.session !== '') ctx.sink.noteThreadId(data.session);
      const threadId = data?.session ?? ctx.threadId;
      const text = typeof data?.text === 'string' ? data.text : frame.text;
      if (text === '') return [];
      ctx.sink.noteText(text);
      return [E.output({ taskId: ctx.taskId, agentId: ctx.agentId, threadId }, frame, text)];
    },
  };
}
