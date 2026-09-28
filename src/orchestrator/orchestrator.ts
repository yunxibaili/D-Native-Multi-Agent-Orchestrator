/**
 * orchestrator/orchestrator.ts — the only entry point callers need.
 *
 * Narrow by design (the "model-free kernel" from native-agent-router): resolve
 * an adapter, validate the request, build a transport, run it, persist the
 * outcome. It makes NO decision about which agent should handle what — the
 * caller always names `agentId` explicitly.
 *
 * It does NOT: call any provider API, read agent credentials, or implement
 * retry / review policy (Phase 2, deliberately absent so the policy can be
 * built on a runtime that is already correct).
 *
 * Hardened this round:
 *  - bootstrap iterates a FACTORY TABLE, not a hard-coded opencode/codex pair,
 *    so adding an agent does not touch core/ or this file's logic;
 *  - resume is OWNERSHIP-CHECKED (agent + cwd + existence) before the adapter
 *    is allowed to build a native invocation;
 *  - request validation is delegated to the adapter, so an unsupported option
 *    is rejected instead of silently dropped.
 */

import { createAdapter, knownAgentIds } from '../adapters/index.ts';
import {
  CapabilityError,
  InvalidRequestError,
  ThreadNotFoundError,
  ThreadOwnershipError,
} from '../core/errors.ts';
import { log } from '../core/log.ts';
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentDescriptor,
  DoctorAgentReport,
  ProbeResult,
  RunHandle,
  RunRequest,
  RunResult,
  TransportKind,
} from '../core/types.ts';
import { AdapterRegistry } from '../runtime/registry.ts';
import { AgentSession, type SessionLimits } from '../runtime/session.ts';
import { SessionStore, type TaskSummary, type ThreadRecord } from '../runtime/store.ts';
import { loadConfig, type AgentConfig, type OrchestratorConfig } from './config.ts';

export interface OrchestratorOptions {
  config?: OrchestratorConfig;
  configPath?: string;
  storeDir?: string;
  sessionLimits?: SessionLimits;
  /**
   * Explicit extra adapters, registered after the factory table. This is the
   * extension seam Phase 2 uses (and the one tests use to drive the runtime
   * without a real binary): adding a file plus one table line is enough for a
   * real agent, and a caller can also register something directly.
   */
  extraAdapters?: readonly AgentAdapter[];
}

export class Orchestrator {
  readonly registry: AdapterRegistry;
  readonly store: SessionStore;
  readonly configSource: string | null;

  private readonly configs: Record<string, AgentConfig>;
  private readonly sessionLimits: SessionLimits;
  /** Bounded: finished sessions are dropped, so this cannot grow forever. */
  private readonly active = new Map<string, AgentSession>();

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
    this.sessionLimits = options.sessionLimits ?? {};
    this.store = new SessionStore(options.storeDir ?? config.storeDir);
    this.registry = new AdapterRegistry();
    this.bootstrapAdapters();
    for (const a of options.extraAdapters ?? []) {
      if (!this.registry.has(a.descriptor.id)) this.registry.register(a);
    }
  }

  /**
   * Register every agent we have a factory for. A missing binary must NOT
   * crash startup — `doctor` is where that gets reported — and an agent that is
   * configured but has no factory is reported too, so adding ZCode later does
   * not require touching this file.
   */
  private bootstrapAdapters(): void {
    const ids = new Set<string>([...knownAgentIds(), ...Object.keys(this.configs)]);
    for (const id of ids) {
      const cfg = this.configs[id] ?? {};
      try {
        const adapter = createAdapter(id, { command: cfg.command });
        if (!adapter) {
          log.warn('no factory for configured agent', { agent: id });
          continue;
        }
        this.registry.register(adapter);
      } catch (e) {
        // Discovery/launcher failure. Not fatal: doctor explains it.
        log.warn('agent not registered', { agent: id, error: (e as Error).message });
      }
    }
  }

  agentIds(): string[] {
    return this.registry.ids();
  }

  descriptors(): AgentDescriptor[] {
    return this.registry.descriptors();
  }

  adapter(agentId: string) {
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
    const caps = adapter.descriptor.capabilities;

    if (!caps.newTask && !req.threadId) throw new CapabilityError(req.agentId, 'newTask');

    // `review` and `resume` are mutually exclusive entrypoints. A review is a
    // one-shot judgement over a diff; it has no conversation to continue. The
    // agents cannot express "review and continue thread 123", so combining them
    // would mean the threadId is silently ignored. Refuse instead.
    if (req.mode === 'review' && req.threadId) {
      throw new InvalidRequestError(
        req.agentId,
        'mode=review together with threadId',
        `A review is a one-shot judgement and has no conversation to continue. ` +
          `Drop threadId to run a review, or use mode=default with threadId to resume.`,
      );
    }

    // Resume ownership: a threadId is not a global key.
    const effective = req.threadId ? this.resolveResumeTarget(req, caps.resume) : undefined;

    if (req.mode === 'review' && !caps.review) {
      // The adapter's own validateRequest gives a better message; this is the
      // generic guard for adapters that do not implement it.
      throw new CapabilityError(req.agentId, 'review');
    }

    // A configured sandbox applies to ORDINARY FRESH RUNS only.
    //
    // `codex exec review` and `codex exec resume` both reject `--sandbox`
    // (verified: exit 2), and a review/resume entrypoint is not something we
    // get to constrain anyway. Injecting our own default there would make the
    // adapter refuse every review and every resume, which is our bug, not the
    // caller's. An EXPLICIT `--sandbox` on review/resume is still REFUSED by the
    // adapter — that is a caller error and must be reported, not absorbed.
    const sandboxApplies = !req.threadId && req.mode !== 'review';
    const sandboxDefault = sandboxApplies ? cfg.sandbox : undefined;

    const merged: RunRequest = {
      ...req,
      threadId: effective,
      model: req.model ?? cfg.model,
      role: req.role ?? cfg.role,
      sandbox: req.sandbox ?? sandboxDefault,
      timeoutMs: req.timeoutMs ?? cfg.timeoutMs,
    };

    // Adapter-owned validation. Throws for anything it cannot honour, so no
    // option is ever silently dropped on the way to the native CLI.
    adapter.validateRequest(merged);

    const transport = adapter.createTransport(merged);
    const session = new AgentSession(adapter, this.store, merged, transport, {
      ...this.sessionLimits,
      onSettled: (s) => this.active.delete(s.taskId),
    });
    this.active.set(session.taskId, session);
    session.start();
    return session;
  }

  /**
   * Validate a resume request against the persisted thread record.
   *
   * A thread belongs to the (agentId, cwd) pair that created it. The storage
   * lookup is agent-scoped, so a guessable native id from one agent cannot
   * reach another agent's conversation at all; the ownership checks below then
   * enforce cwd on top. Resuming across cwd would hand the agent a session whose
   * file context belongs to a different checkout, so it is REFUSED. Any override
   * must be requested explicitly, never assumed.
   */
  private resolveResumeTarget(req: RunRequest, supportsResume: boolean): string {
    if (!supportsResume) throw new CapabilityError(req.agentId, 'resume');
    const threadId = req.threadId!;

    // Explicit operator override: crossing the agent namespace is the point, so
    // this is the ONLY path that consults other agents' records. Always logged.
    if (req.allowForeignThread) {
      const anywhere = this.store.findThreadAnyAgent(threadId);
      if (!anywhere) throw new ThreadNotFoundError(threadId, req.agentId);
      log.warn('resuming a thread by explicit cross-agent override', {
        threadId,
        requestedAgent: req.agentId,
        ownerAgent: anywhere.agentId,
        requestedCwd: req.cwd,
        ownerCwd: anywhere.cwd,
      });
      return threadId;
    }

    // Agent-scoped: another agent's record is not addressable.
    const record = this.store.getThread(req.agentId, threadId);
    if (!record) throw new ThreadNotFoundError(threadId, req.agentId);

    if (record.agentId !== req.agentId) {
      throw new ThreadOwnershipError(threadId, 'agentId', record.agentId, req.agentId);
    }
    if (normPath(record.cwd) !== normPath(req.cwd)) {
      throw new ThreadOwnershipError(threadId, 'cwd', record.cwd, req.cwd);
    }
    return threadId;
  }

  /**
   * Review entrypoint. Phase 1 provides the plumbing only — no automatic
   * review policy, no gate, no retry loop. The caller decides whether and when
   * to ask for a review.
   */
  review(req: Omit<RunRequest, 'mode'>): RunHandle {
    return this.run({ ...req, mode: 'review' });
  }

  /** Live sessions only. Terminal sessions are removed on completion. */
  activeSessions(): AgentSession[] {
    return [...this.active.values()];
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
    const agents: DoctorAgentReport[] = [];
    for (const id of this.registry.ids()) {
      const adapter = this.registry.get(id);
      let probe: ProbeResult;
      try {
        probe = await adapter.probe();
      } catch (e) {
        probe = {
          ok: false,
          launcher: adapter.descriptor.launcher,
          version: null,
          detail: (e as Error).message,
          warnings: [],
        };
      }
      const d = adapter.descriptor;
      agents.push({
        id,
        displayName: d.displayName,
        launcher: `${d.launcher.command}${d.launcher.prefixArgs.length ? ' ' + d.launcher.prefixArgs.join(' ') : ''} -> ${d.launcher.target} [${d.launcher.kind}]`,
        version: probe.version,
        ok: probe.ok,
        detail: probe.detail,
        warnings: probe.warnings,
        capabilities: d.capabilities,
        transport: d.transport as TransportKind,
        credentialsHint: d.credentialsHint ?? null,
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
  agents: DoctorAgentReport[];
}

/** Windows paths are case-insensitive; normalise before comparing ownership. */
function normPath(p: string): string {
  const t = p.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? t.toLowerCase() : t;
}

export type { AgentCapabilities };
