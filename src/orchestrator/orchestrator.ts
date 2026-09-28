/**
 * orchestrator/orchestrator.ts — the only entry point callers need.
 *
 * Responsibilities are intentionally narrow (this is the "model-free kernel"
 * from native-agent-router): resolve an adapter, build a task, stream it, and
 * persist the outcome. It makes NO decisions about which agent should handle
 * what — the caller always names `agentId` explicitly.
 *
 * It does NOT:
 *   - call any provider API
 *   - read or copy agent credentials
 *   - implement retry / review policy (Phase 2, and deliberately absent so the
 *     policy can be built on top of a runtime that is already correct)
 */

import type {
  AgentAdapter,
  AgentCapabilities,
  AgentDescriptor,
  ProbeResult,
  RunHandle,
  RunRequest,
  RunResult,
  Transport,
} from '../core/types.ts';
import { CapabilityError } from '../core/errors.ts';
import { log } from '../core/log.ts';
import { AdapterRegistry } from '../runtime/registry.ts';
import { AgentSession } from '../runtime/session.ts';
import { SessionStore, type TaskSummary, type ThreadRecord } from '../runtime/store.ts';
import { createOpenCodeAdapter } from '../adapters/opencode.ts';
import { createCodexAdapter } from '../adapters/codex.ts';
import { loadConfig, type OrchestratorConfig, type AgentConfig } from './config.ts';

export interface OrchestratorOptions {
  config?: OrchestratorConfig;
  configPath?: string;
  storeDir?: string;
}

export class Orchestrator {
  readonly registry: AdapterRegistry;
  readonly store: SessionStore;
  readonly configSource: string | null;

  private readonly configs: Record<string, AgentConfig>;
  private readonly sessions = new Map<string, AgentSession>();

  constructor(options: OrchestratorOptions = {}) {
    let config = options.config;
    let source: string | null = null;
    if (!config) {
      const loaded = loadConfig(options.configPath);
      config = loaded.config;
      source = loaded.source;
    }
    this.configSource = source;
    this.configs = config.agents ?? {};
    this.store = new SessionStore(options.storeDir ?? config.storeDir);
    this.registry = new AdapterRegistry();
    this.registerBuiltins();
  }

  /**
   * Agents ship in code (they are part of the product) but their binary
   * locations come from config, and a missing binary must NOT crash startup —
   * `doctor` is the place that reports it.
   */
  private registerBuiltins(): void {
    for (const id of ['opencode', 'codex']) {
      const cfg = this.configs[id];
      try {
        const adapter =
          id === 'opencode'
            ? createOpenCodeAdapter({ command: cfg?.command })
            : createCodexAdapter({ command: cfg?.command });
        this.registry.register(adapter);
      } catch (e) {
        log.warn('agent not registered', { agent: id, error: (e as Error).message });
      }
    }
    // Explicitly configured extras are allowed to register, but Phase 1 has
    // no adapter factories for them yet. Surfaced by `doctor`, not guessed at.
  }

  agentIds(): string[] {
    return this.registry.ids();
  }

  descriptors(): AgentDescriptor[] {
    return this.registry.descriptors();
  }

  adapter(agentId: string): AgentAdapter {
    return this.registry.get(agentId);
  }

  configFor(agentId: string): AgentConfig {
    return this.configs[agentId] ?? {};
  }

  /**
   * Dispatch a task. Returns IMMEDIATELY with a handle — `run` returning never
   * means "done". Await `handle.result()` for the outcome.
   */
  run(req: RunRequest): RunHandle {
    const adapter = this.registry.get(req.agentId);
    const cfg = this.configFor(req.agentId);

    if (req.threadId && !adapter.descriptor.capabilities.resume) {
      throw new CapabilityError(req.agentId, 'resume');
    }
    if (req.mode === 'review' && !adapter.descriptor.capabilities.review) {
      throw new CapabilityError(req.agentId, 'review');
    }
    if (req.sandbox && !adapter.descriptor.capabilities.sandbox) {
      throw new CapabilityError(req.agentId, 'sandbox');
    }
    if (req.role && !adapter.descriptor.capabilities.roleSelection) {
      throw new CapabilityError(req.agentId, 'roleSelection');
    }

    const effective: RunRequest = {
      ...req,
      model: req.model ?? cfg.model,
      role: req.role ?? cfg.role,
      sandbox: req.sandbox ?? cfg.sandbox,
      timeoutMs: req.timeoutMs ?? cfg.timeoutMs,
    };

    const session = new AgentSession(adapter, this.store, effective);
    this.sessions.set(session.taskId, session);
    session.start();
    return session;
  }

  /**
   * Review entrypoint. Phase 1 provides the plumbing only — there is no
   * automatic review policy, no gate, no retry loop. The caller decides
   * whether and when to ask for a review.
   */
  review(req: Omit<RunRequest, 'mode'>): RunHandle {
    return this.run({ ...req, mode: 'review' });
  }

  activeSessions(): AgentSession[] {
    return [...this.sessions.values()];
  }

  getTask(taskId: string): RunResult | null {
    return this.store.getTask(taskId);
  }

  listTasks(limit = 20): TaskSummary[] {
    return this.store.listTasks(limit);
  }

  listThreads(agentId?: string): ThreadRecord[] {
    return this.store.listThreads(agentId);
  }

  /** Availability + capability report. Never prints credentials. */
  async doctor(): Promise<DoctorReport> {
    const agents: DoctorReport['agents'][number][] = [];
    for (const id of this.registry.ids()) {
      const adapter = this.registry.get(id);
      let probe: ProbeResult;
      try {
        probe = await adapter.probe();
      } catch (e) {
        probe = {
          ok: false,
          executable: adapter.descriptor.executable,
          version: null,
          detail: (e as Error).message,
          warnings: [],
        };
      }
      agents.push({
        id,
        displayName: adapter.descriptor.displayName,
        executable: probe.executable,
        version: probe.version,
        ok: probe.ok,
        detail: probe.detail,
        warnings: probe.warnings,
        capabilities: adapter.descriptor.capabilities,
        transport: adapter.descriptor.transport,
        credentialsHint: adapter.descriptor.credentialsHint ?? null,
      });
    }
    return {
      configSource: this.configSource,
      storeDir: this.store.root,
      agents,
    };
  }
}

export interface DoctorReport {
  configSource: string | null;
  storeDir: string;
  agents: Array<{
    id: string;
    displayName: string;
    executable: string;
    version: string | null;
    ok: boolean;
    detail: string;
    warnings: readonly string[];
    capabilities: AgentCapabilities;
    transport: Transport;
    credentialsHint: string | null;
  }>;
}
