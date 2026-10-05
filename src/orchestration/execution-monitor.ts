/**
 * src/orchestration/execution-monitor.ts — R2 Observability: a READ MODEL, not an authority.
 *
 * WHAT THIS IS
 * ------------
 *   existing authorities (TaskStore / WorkspaceManager / SessionRegistry / AttemptStore)
 *         ↓  READ ONLY
 *   ExecutionMonitorSnapshot        ← data, for a human looking at a dashboard
 *
 * It answers one question: "what is happening in this round RIGHT NOW?"
 *
 * WHAT THIS IS NOT
 * ----------------
 *   - not a TaskStore: it owns no task state, and deleting it changes nothing
 *   - not a scheduler/dispatcher: it has no reference to a runtime and cannot dispatch
 *   - not a second state machine: every task status it reports is the STORE's own
 *     `TaskStatus`, passed through verbatim. The dashboard's vocabulary
 *     (`assigned` / `review` / `completed`) is NOT a second status set — those words
 *     live only in the UI layer, which maps them onto real fields.
 *   - not a source of truth for anything. Every field is derived on every call; two
 *     calls with the same inputs produce the same output. Nothing is cached.
 *
 * FAILURE ISOLATION
 * -----------------
 * `buildExecutionSnapshot` never throws for absent data: a missing workspace manager,
 * an empty store, an unknown task all degrade to `null` / `[]` / `'unknown'`. That is
 * deliberate — this module is called from a CLI that is also executing real agents,
 * and an observability helper must not be able to take the run down with it.
 */

import type { Task, TaskStatus } from './task.ts';
import type { TaskStore } from './store.ts';
import type { WorkspaceManager, WorkspaceHandle } from './workspace.ts';
import type { ResourceClaim, ResourceClaimMode, ResourceScope } from './resource-claim.ts';
import type { WorkbenchSession } from './workbench-sessions.ts';

// ---------------------------------------------------------------------------
// The snapshot shape (the UI's contract)
// ---------------------------------------------------------------------------

/** Where a task is in the executor's own terms, without inventing a new status. */
export type TaskDerivedStage = 'not-assigned' | 'assigned' | 'waiting' | 'reviewable' | 'settled';

export interface BlockerMonitorEntry {
  taskId: string;
  /** `resource-*` / `dependency-wait` / `agent-not-connected` / `quota-blocked` / `unknown`. */
  code: string;
  reason: string;
  /** The distinction the UI must not flatten into "ERROR". */
  kind: 'waiting' | 'blocked' | 'failed' | 'unavailable';
}

export interface TaskMonitorEntry {
  taskId: string;
  /** The task's acceptance criteria, trimmed. Never a generated description. */
  title: string;
  /** The STORE's status, verbatim. No new status vocabulary. */
  status: TaskStatus;
  /** How the UI should read that status. Derived, not stored. */
  derivedStage: TaskDerivedStage;
  agentId: string | null;
  modelId: string | null;
  sessionId: string | null;
  /** Native session handle, when the agent reported one. */
  nativeSessionId: string | null;
  workspaceId: string | null;
  workspaceMode: string;
  workspacePath: string | null;
  dependencies: string[];
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
  elapsedMs: number | null;
  retryCount: number;
  lastEvent: string | null;
  blocker: BlockerMonitorEntry | null;
}

export interface AgentMonitorEntry {
  agentId: string;
  /** The UI label. `agentId` stays the machine identity; this is never the key. */
  displayName: string;
  status: string;
  currentTaskId: string | null;
  modelId: string | null;
  sessionId: string | null;
  workspaceId: string | null;
  workspacePath: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  elapsedMs: number | null;
  lastEvent: string | null;
}

export interface WorkspaceMonitorEntry {
  workspaceId: string;
  taskId: string;
  agentId: string;
  mode: string;
  path: string;
  branch: string | null;
  createdAt: number;
  /** How many R2-1 resource claims this workspace currently holds. */
  claimCount: number;
  /** Compact human summary of the claimed scopes. */
  scopes: string[];
  status: 'active' | 'released';
}

export interface MonitorEvent {
  at: number;
  source: string;
  message: string;
  tone: 'normal' | 'success' | 'warning' | 'error';
}

export interface ExecutionMonitorCounts {
  tasks: {
    total: number;
    completed: number;
    running: number;
    waiting: number;
    blocked: number;
    failed: number;
    /** `to_verify` — ran, but Verification has not judged it. Not "completed". */
    reviewable: number;
    notAssigned: number;
  };
  agents: { total: number; active: number; idle: number; unavailable: number };
  workspaces: { total: number; isolated: number; shared: number; unavailable: number };
  claims: number;
}

export interface ExecutionMonitorSnapshot {
  /** The round's root task id, or null when nothing is being observed. */
  runId: string | null;
  objective: string | null;
  /** True when a round is knowable at all (a root exists in the store). */
  observed: boolean;
  startedAt: number | null;
  updatedAt: number;
  /** `not-observed` is the honest answer when there is nothing to watch. */
  overallStatus:
    | 'not-observed'
    | 'planned'
    | 'running'
    | 'awaiting-verification'
    | 'completed'
    | 'failed'
    | 'blocked';
  currentStage: string;
  tasks: TaskMonitorEntry[];
  agents: AgentMonitorEntry[];
  workspaces: WorkspaceMonitorEntry[];
  events: MonitorEvent[];
  blockers: BlockerMonitorEntry[];
  counts: ExecutionMonitorCounts;
}

// ---------------------------------------------------------------------------
// Inputs — all of them existing authorities, all read-only
// ---------------------------------------------------------------------------

export interface ExecutionMonitorInput {
  /** The one task-state authority. Read only. */
  readonly store: TaskStore;
  /** The one workspace authority. Read only; `null` when none is configured. */
  readonly workspace?: WorkspaceManager | null;
  /** The session registry. Read only. */
  readonly sessions?: {
    all(): readonly WorkbenchSession[];
    sessionForTask(taskId: string): WorkbenchSession | null;
  } | null;
  /** Scope to one round. Omitted means "every task in the store". */
  readonly rootTaskId?: string | null;
  /** Clock reading, supplied rather than read, so a snapshot is reproducible. */
  readonly now: number;
  /** Optional human labels for agent ids. Absent ids fall back to the id itself. */
  readonly agentNames?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Derivation helpers — pure, total, no I/O
// ---------------------------------------------------------------------------

/** Statuses we are willing to call "finished and accepted". Only the store's own. */
const SUCCEEDED: TaskStatus = 'succeeded';
const FAILED: TaskStatus = 'failed';
const CANCELLED: TaskStatus = 'cancelled';
const RUNNING: TaskStatus = 'running';
const REVIEW: TaskStatus = 'to_verify';
const BLOCKED: TaskStatus = 'blocked';
const REWORK: TaskStatus = 'rework';

function label(agentId: string | null, names: Readonly<Record<string, string>> | undefined): string {
  if (agentId === null) return 'unassigned';
  return names?.[agentId] ?? agentId;
}

/**
 * Project the store's status onto the UI's reading of it.
 *
 * This is where the spec's words (`assigned`, `waiting`, `review`, `completed`) are
 * resolved — ONCE, here, and never as a stored status. Each one is a statement about
 * a real field:
 *   assigned   → an identity was written, the task has not started
 *   waiting    → an unmet dependency (the scheduler's own readiness rule)
 *   review     → `to_verify`, i.e. a run landed and Verification has not judged it
 *   completed  → `succeeded`, which only `applyVerification` can produce
 */
export function deriveStage(task: Task, unmetDependencies: readonly string[]): TaskDerivedStage {
  if (task.status === SUCCEEDED || task.status === FAILED || task.status === CANCELLED) return 'settled';
  if (task.status === REVIEW || task.status === REWORK) return 'reviewable';
  if (unmetDependencies.length > 0) return 'waiting';
  if (task.startedAt !== null || task.status === RUNNING) return 'assigned';
  return 'not-assigned';
}

/** Unmet dependencies, using the SAME rule the scheduler and `executeTask` use. */
function unmetFor(task: Task, all: ReadonlyMap<string, Task>): string[] {
  const unmet: string[] = [];
  for (const dep of task.dependencies) {
    const upstream = all.get(dep);
    if (upstream === undefined || upstream.status !== SUCCEEDED) unmet.push(dep);
  }
  return unmet;
}

function scopeSummary(scope: ResourceScope): string {
  switch (scope.kind) {
    case 'workspace':
      return `workspace:${scope.workspaceId}`;
    case 'repository':
      return `repo:${scope.repoRoot}`;
    case 'file':
      return `file:${scope.path}`;
    default:
      return `dir:${scope.path}`;
  }
}

/**
 * Classify a refusal into the distinction the UI must keep.
 *
 * `resource-conflict` is NOT a failure — it is admission control saying "someone else
 * holds this", which is the normal, expected outcome of two writers wanting one tree.
 * Flattening it to "ERROR" would tell an operator an agent broke when nothing did.
 */
function blockerKindFor(code: string): BlockerMonitorEntry['kind'] {
  if (code === 'resource-conflict' || code === 'resource-unavailable') return 'blocked';
  if (code === 'dependency-wait' || code === 'dependency-unmet') return 'waiting';
  if (code === 'agent-not-connected' || code === 'quota-blocked') return 'unavailable';
  if (code === 'failed' || code === 'run-failed') return 'failed';
  return 'blocked';
}

/** Build the derived blockers from the store's own recorded reasons. */
function blockersFrom(tasks: readonly TaskMonitorEntry[]): BlockerMonitorEntry[] {
  const out: BlockerMonitorEntry[] = [];
  for (const t of tasks) {
    if (t.blocker !== null) out.push(t.blocker);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

/**
 * Derive one snapshot. Pure with respect to its inputs: it reads, it does not write,
 * and it cannot dispatch, no matter what the caller passes in.
 */
export function buildExecutionSnapshot(input: ExecutionMonitorInput): ExecutionMonitorSnapshot {
  const { store, now } = input;
  const names = input.agentNames;

  // A root that does not exist is not an error: it is "nothing observed".
  const root = input.rootTaskId != null && input.rootTaskId !== '' ? store.get(input.rootTaskId) : null;
  const scoped: Task[] = root !== null ? store.descendants(root.taskId) : store.all();
  const all = new Map(store.all().map((t) => [t.taskId, t]));

  const workspaceManager = input.workspace ?? null;
  const sessions = input.sessions ?? null;

  // ---- workspaces + claims (from the existing authority, read only) ----------
  const handles: WorkspaceHandle[] = workspaceManager === null ? [] : workspaceManager.list();
  const handleByTask = new Map<string, WorkspaceHandle>();
  for (const h of handles) handleByTask.set(h.taskId, h);

  const workspaces: WorkspaceMonitorEntry[] = handles.map((h) => {
    let claims: readonly ResourceClaim[] = [];
    try {
      claims = workspaceManager === null ? [] : workspaceManager.resourceClaimsFor(h.workspaceId);
    } catch {
      // A claim read must never be able to break the snapshot.
      claims = [];
    }
    const task = all.get(h.taskId);
    return {
      workspaceId: h.workspaceId,
      taskId: h.taskId,
      agentId: task?.agentId ?? 'unknown',
      mode: h.mode,
      path: h.cwd,
      branch: h.branch,
      createdAt: h.createdAt,
      claimCount: claims.length,
      scopes: claims.map((c) => `${c.mode}:${scopeSummary(c.scope)}`),
      status: h.released ? 'released' : 'active',
    };
  });

  // ---- tasks ---------------------------------------------------------------
  const tasks: TaskMonitorEntry[] = scoped.map((task) => {
    const unmet = unmetFor(task, all);
    const handle = handleByTask.get(task.taskId) ?? null;
    // Guarded: a session registry that throws must degrade the ROW, not the snapshot.
    // This module is called from a process that is executing real agents, so no read
    // it performs is allowed to propagate.
    let session: WorkbenchSession | null = null;
    if (sessions !== null) {
      try {
        session = sessions.sessionForTask(task.taskId);
      } catch {
        session = null;
      }
    }
    const derivedStage = deriveStage(task, unmet);

    // The blocker, from the store's OWN recorded facts — never invented.
    let blocker: BlockerMonitorEntry | null = null;
    const blockedReason = task.blockedReason;
    if (blockedReason !== null && blockedReason.trim() !== '') {
      const codeLike = /^([a-z][a-z0-9-]*):/.exec(blockedReason.trim());
      const code = codeLike?.[1] ?? 'blocked';
      blocker = { taskId: task.taskId, code, reason: blockedReason, kind: blockerKindFor(code) };
    } else if (unmet.length > 0) {
      blocker = {
        taskId: task.taskId,
        code: 'dependency-wait',
        reason: `waiting on ${unmet.join(', ')}`,
        kind: 'waiting',
      };
    } else if (task.status === FAILED) {
      blocker = { taskId: task.taskId, code: 'failed', reason: 'the run failed', kind: 'failed' };
    }

    const startedAt = task.startedAt;
    const finishedAt = task.finishedAt;
    // WHICH run duration can honestly be reported.
    //
    // `finishedAt` is only stamped for a TERMINAL status. So:
    //   terminal (succeeded/failed/cancelled) → finishedAt - startedAt, exact.
    //   running                              → now - startedAt, advancing.
    //   to_verify / rework                   → **null**.
    //
    // The last case is the one worth stating. A task in `to_verify` really has finished
    // its run, but the STORE DOES NOT RECORD WHEN: `finishedAt` stays null until a
    // terminal transition, and `updatedAt` is a `finishedAt ?? startedAt ?? createdAt`
    // fallback, so it is not an observation either. Reporting `startedAt` as the end
    // would print "0ms" for a task that ran for ten minutes, and reporting `now` would
    // report Codex/human REVIEW latency as execution time. Both are fabrications, and
    // the module's rule is that an unobservable value is `null`, which the UI renders
    // as "not observed" rather than as a number nobody measured.
    const runEnded: number | null = finishedAt ?? (task.status === 'running' ? now : null);
    const elapsedMs = startedAt === null || runEnded === null ? null : Math.max(0, runEnded - startedAt);

    return {
      taskId: task.taskId,
      title: task.acceptanceCriteria.trim().split('\n')[0]?.slice(0, 160) ?? '',
      status: task.status,
      derivedStage,
      agentId: task.agentId.trim() === '' ? null : task.agentId,
      modelId: task.modelId,
      sessionId: session?.sessionId ?? null,
      nativeSessionId: session?.nativeSessionId ?? null,
      workspaceId: handle?.workspaceId ?? null,
      workspaceMode: handle?.mode ?? (workspaceManager === null ? 'none (no workspace manager)' : 'not-prepared'),
      workspacePath: handle?.cwd ?? null,
      dependencies: [...task.dependencies],
      createdAt: task.createdAt,
      startedAt,
      finishedAt,
      updatedAt: finishedAt ?? startedAt ?? task.createdAt,
      elapsedMs,
      retryCount: task.retryCount,
      lastEvent: null,
      blocker,
    };
  });

  // ---- agents --------------------------------------------------------------
  // Derived from the tasks actually in scope, so a NEW agent appears without any
  // edit here. Nothing is hard-coded per agent id.
  const byAgent = new Map<string, TaskMonitorEntry[]>();
  for (const t of tasks) {
    if (t.agentId === null) continue;
    const list = byAgent.get(t.agentId) ?? [];
    list.push(t);
    byAgent.set(t.agentId, list);
  }

  const agents: AgentMonitorEntry[] = [...byAgent.entries()].map(([agentId, agentTasks]) => {
    const active = agentTasks.find((t) => t.status === RUNNING) ?? null;
    const latest = [...agentTasks].sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
    const settled = agentTasks.filter((t) => t.derivedStage === 'settled').length;
    const failed = agentTasks.filter((t) => t.status === FAILED).length;
    const status = active !== null
      ? 'running'
      : agentTasks.some((t) => t.derivedStage === 'reviewable')
        ? 'awaiting-verification'
        : agentTasks.some((t) => t.derivedStage === 'waiting')
          ? 'waiting'
          : settled > 0 && failed === agentTasks.length
            ? 'failed'
            : settled === agentTasks.length
              ? 'idle'
              : 'assigned';

    const session = sessions === null || latest === null
      ? null
      : (() => { try { return sessions.sessionForTask(latest.taskId); } catch { return null; } })();
    return {
      agentId,
      displayName: label(agentId, names),
      status,
      currentTaskId: active?.taskId ?? null,
      modelId: active?.modelId ?? latest?.modelId ?? null,
      sessionId: session?.sessionId ?? latest?.sessionId ?? null,
      workspaceId: active?.workspaceId ?? latest?.workspaceId ?? null,
      workspacePath: active?.workspacePath ?? latest?.workspacePath ?? null,
      startedAt: active?.startedAt ?? latest?.startedAt ?? null,
      updatedAt: latest?.updatedAt ?? null,
      elapsedMs: active?.elapsedMs ?? latest?.elapsedMs ?? null,
      lastEvent: active?.lastEvent ?? latest?.lastEvent ?? null,
    };
  });

  // ---- counts --------------------------------------------------------------
  const count = (pred: (t: TaskMonitorEntry) => boolean): number => tasks.filter(pred).length;
  const counts: ExecutionMonitorCounts = {
    tasks: {
      total: tasks.length,
      completed: count((t) => t.status === SUCCEEDED),
      running: count((t) => t.status === RUNNING),
      waiting: count((t) => t.derivedStage === 'waiting'),
      blocked: count((t) => t.status === BLOCKED),
      failed: count((t) => t.status === FAILED),
      reviewable: count((t) => t.status === REVIEW || t.status === REWORK),
      notAssigned: count((t) => t.derivedStage === 'not-assigned'),
    },
    agents: {
      total: agents.length,
      active: agents.filter((a) => a.status === 'running').length,
      idle: agents.filter((a) => a.status === 'idle' || a.status === 'assigned' || a.status === 'waiting').length,
      unavailable: agents.filter((a) => a.status === 'failed').length,
    },
    workspaces: {
      total: workspaces.length,
      isolated: workspaces.filter((w) => w.mode === 'isolated').length,
      shared: workspaces.filter((w) => w.mode === 'shared').length,
      unavailable: 0,
    },
    claims: workspaces.reduce((sum, w) => sum + w.claimCount, 0),
  };

  // ---- overall status / stage ---------------------------------------------
  const children = tasks.filter((t) => t.taskId !== root?.taskId);
  const anyRunning = counts.tasks.running > 0;
  const anyBlocked = counts.tasks.blocked > 0;
  const allSettled = children.length > 0 && children.every((t) => t.derivedStage === 'settled');
  const allFailed = children.length > 0 && children.every((t) => t.status === FAILED || t.status === CANCELLED);

  const overallStatus: ExecutionMonitorSnapshot['overallStatus'] =
    root === null || tasks.length === 0
      ? 'not-observed'
      : allSettled
        ? allFailed ? 'failed' : 'completed'
        : anyRunning
          ? 'running'
          : anyBlocked
            ? 'blocked'
            : counts.tasks.reviewable > 0
              ? 'awaiting-verification'
              : 'planned';

  const currentStage =
    overallStatus === 'not-observed'
      ? 'no execution round observed'
      : overallStatus === 'running'
        ? 'EXECUTION'
        : overallStatus === 'awaiting-verification'
          ? 'AWAITING VERIFICATION (to_verify — this round does not verify)'
          : overallStatus === 'completed'
            ? 'ROUND SETTLED (verification still owns completion)'
            : overallStatus === 'failed'
              ? 'ROUND FAILED'
              : overallStatus === 'blocked'
                ? 'BLOCKED ON RESOURCE / DEPENDENCY'
                : 'PLANNED';

  const events: MonitorEvent[] = [
    ...tasks.map((t) => ({
      at: t.updatedAt,
      source: label(t.agentId, names),
      message: `${t.taskId} ${t.status}${t.retryCount > 0 ? ` (retry ${t.retryCount})` : ''}`,
      tone: (t.status === SUCCEEDED ? 'success' : t.status === FAILED ? 'error' : 'normal') as MonitorEvent['tone'],
    })),
    ...workspaces.map((w) => ({
      at: w.createdAt,
      source: 'Workspace',
      message: `${w.taskId} → ${w.mode} ${w.path} (${w.claimCount} claim${w.claimCount === 1 ? '' : 's'})`,
      tone: 'normal' as const,
    })),
    ...blockersFrom(tasks).map((b) => ({
      at: now,
      source: 'Admission',
      message: `${b.taskId} ${b.code}: ${b.reason}`,
      tone: (b.kind === 'waiting' ? 'warning' : b.kind === 'failed' ? 'error' : 'warning') as MonitorEvent['tone'],
    })),
  ].sort((a, b) => a.at - b.at);

  return Object.freeze({
    runId: root?.taskId ?? null,
    objective: root?.acceptanceCriteria ?? null,
    observed: root !== null && tasks.length > 0,
    startedAt: root?.createdAt ?? (scoped.length > 0 ? Math.min(...scoped.map((t) => t.createdAt)) : null),
    updatedAt: now,
    overallStatus,
    currentStage,
    tasks,
    agents,
    workspaces,
    events,
    blockers: blockersFrom(tasks),
    counts,
  }) as ExecutionMonitorSnapshot;
}

/** Every mode a claim may use, re-exported so a consumer need not reach the module. */
export type { ResourceClaimMode };
