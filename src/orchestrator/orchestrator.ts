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
  ThreadNotFoundError,
  ThreadOwnershipError,
} from '../core/errors.ts';
import { log } from '../core/log.ts';
import { validateRuntimeLaunchPreflight } from '../runtime/preflight.ts';
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentDescriptor,
  DoctorAgentReport,
  ProbeResult,
  RunHandle,
  RunRequest,
  RunResult,
  SelectionSpec,
  TransportKind,
} from '../core/types.ts';
import { AdapterRegistry } from '../runtime/registry.ts';
import { AgentSession, type SessionLimits } from '../runtime/session.ts';
import { SessionStore, type TaskSummary, type ThreadRecord } from '../runtime/store.ts';
import { collectModelCatalog, type ModelCatalogSnapshot } from '../runtime/model-catalog.ts';
import type { CmdRunner } from '../quota/collector.ts';
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
  /**
   * Adapters that REPLACE any same-id adapter, including one bootstrapped from a real
   * installed agent. Optional and separate from `extraAdapters` on purpose.
   *
   * WHY THIS IS NEEDED (a broken seam, found by a hanging test)
   * ----------------------------------------------------------
   * `extraAdapters` only registers an adapter whose id is not already present, and
   * `bootstrapAdapters()` registers a REAL adapter for every agent installed on the
   * machine. So on any developer machine that has the agent installed, `extraAdapters`
   * silently does nothing and the run launches the real CLI. The `extraAdapters`
   * docstring claimed it was "the one tests use to drive the runtime without a real
   * binary", and that was false whenever the binary existed - which is exactly when a
   * test most needs the double. The symptom was a test whose fake agent was never
   * used: minutes-long "unit" runs, results that varied with machine load, and timeouts
   * that looked like flakiness but were a real subprocess.
   *
   * `extraAdapters` keeps its existing non-overriding behaviour, because silently
   * replacing a real adapter is the wrong default for a production caller. Use this
   * only where the adapter IS meant to be authoritative - tests, or an embedding that
   * genuinely supplies its own implementation for an agent id.
   */
  replaceAdapters?: readonly AgentAdapter[];
}

export class Orchestrator {
  readonly registry: AdapterRegistry;
  readonly store: SessionStore;
  readonly configSource: string | null;

  private readonly configs: Record<string, AgentConfig>;
  /**
   * B1.4: the PROJECT's default Agent × Model selection from `orchestrator.json`.
   * `undefined` means "no project default" — the task-level selection or the
   * existing auto behaviour applies. Read-only; never mutated at runtime.
   */
  private readonly selectionValue: SelectionSpec | undefined;
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
    this.selectionValue = config.selection;
    this.sessionLimits = options.sessionLimits ?? {};
    this.store = new SessionStore(options.storeDir ?? config.storeDir);
    this.registry = new AdapterRegistry();
    this.bootstrapAdapters();
    for (const a of options.extraAdapters ?? []) {
      if (!this.registry.has(a.descriptor.id)) this.registry.register(a);
    }
    // Applied last, and deliberately able to replace: a same-id adapter may already
    // have been bootstrapped from a real installed agent, and `register` throws on a
    // duplicate. See the option's doc for why this is a separate seam.
    for (const a of options.replaceAdapters ?? []) {
      this.registry.replace(a);
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
   * B1.4: the PROJECT default Agent × Model selection from config, or undefined.
   * A caller (the round CLI) passes this to the Workbench so a task-level selection
   * can override it and `auto` falls back to the existing LAYA decision.
   */
  projectSelection(): SelectionSpec | undefined {
    return this.selectionValue;
  }

  /**
   * Dispatch a task. Returns IMMEDIATELY with a handle — `run` returning never
   * means "done". Await `handle.result()` for the outcome.
   */
  run(req: RunRequest): RunHandle {
    const adapter = this.registry.get(req.agentId);
    const cfg = this.configFor(req.agentId);
    const caps = adapter.descriptor.capabilities;

    /*
     * W3.3: ALL pre-process validation is delegated to the runtime-owned preflight.
     *
     * Everything below this point — capability gates, resume ownership, the timeout
     * validator, the adapter's own option validation — is guaranteed to happen before a
     * transport, a child, or any OS process exists. That makes it part of the runtime's
     * process-start truth, so the runtime certifies it: on failure the preflight brands
     * the ORIGINAL error (identity preserved) and the execution edge can release its
     * WRITE claim.
     *
     * The boundary is drawn HERE, deliberately. `createTransport`, `AgentSession` and
     * `session.start()` stay OUTSIDE the preflight, because from `session.start()` on a
     * process may exist and no failure past that line may be certified as "nothing ran".
     *
     * This layer never inspects an error class to decide any of this — the phase the
     * error occurred in is the only evidence, and the phase is structural.
     */
    const preflight = validateRuntimeLaunchPreflight({
      req,
      capabilities: { newTask: caps.newTask, review: caps.review, resume: caps.resume },
      config: {
        model: cfg.model,
        role: cfg.role,
        sandbox: cfg.sandbox,
        timeoutMs: cfg.timeoutMs,
      },
      validateAdapterRequest: (r) => adapter.validateRequest(r),
      resolveResumeTarget: (r, supportsResume) => this.resolveResumeTarget(r, supportsResume),
    });
    const merged = preflight.merged;

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

  /**
   * Availability + capability report. Never prints credentials.
   *
   * B1.1: an EXPLICIT, opt-in model-catalogue query. When `opts.modelCatalog` is
   * absent the method behaves exactly as before and runs NO catalogue process.
   * When present, a read-only snapshot of the named agent's OWN CLI listing is
   * attached. That snapshot changes nothing: it is not written to any registry and
   * does not affect assignment, quota, or the spawn gate.
   */
  async doctor(opts: { modelCatalog?: { agentId: string; runner?: CmdRunner; timeoutMs?: number } } = {}): Promise<DoctorReport> {
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
    const report: DoctorReport = {
      configSource: this.configSource,
      storeDir: this.store.root,
      agents,
    };
    if (opts.modelCatalog !== undefined) {
      report.modelCatalog = await collectModelCatalog(opts.modelCatalog.agentId, {
        runner: opts.modelCatalog.runner,
        command: this.configFor(opts.modelCatalog.agentId).command,
        timeoutMs: opts.modelCatalog.timeoutMs,
      });
    }
    return report;
  }
}

export interface DoctorReport {
  configSource: string | null;
  storeDir: string;
  agents: DoctorAgentReport[];
  /**
   * B1.1: present ONLY when a catalogue query was explicitly requested. Its
   * absence is the "not collected" state; its presence is a read-only snapshot.
   */
  modelCatalog?: ModelCatalogSnapshot;
}

/** Windows paths are case-insensitive; normalise before comparing ownership. */
function normPath(p: string): string {
  const t = p.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? t.toLowerCase() : t;
}

export type { AgentCapabilities };
