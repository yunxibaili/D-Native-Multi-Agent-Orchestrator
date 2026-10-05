/**
 * src/orchestration/workbench-sessions.ts — the Workbench session model.
 *
 * THE CONCEPT THE OLD ARCHITECTURE LACKED
 * ---------------------------------------
 * Until now a run was anonymous: `executeTask` started a process, a result came
 * back, and the only durable identity was the native agent's own `threadId` —
 * recorded in a transcript, but never first-class. The Workbench model makes the
 * SESSION the unit of work:
 *
 *   Agent   = a runtime environment (OpenCode, Codex, WorkBuddy, …)
 *   Model   = what one session is pointed at
 *   Session = one working context on one agent, with one model
 *
 * One agent can hold MANY sessions on DIFFERENT models at the same time. That is
 * why `nativeSessionId` exists and is never conflated with our own `sessionId`:
 * the Workbench does not own the agent's internal conversation state, it only
 * remembers the handle (`RunResult.threadId`) that lets a later run RESUME it.
 *
 * WHAT THIS REGISTRY IS NOT
 * -------------------------
 * Not a second task store (tasks live in `TaskStore`), not a scheduler, not an
 * execution edge. It records which session a task ran in; it never starts one.
 * Execution still goes through `TaskScheduler.tick()` → `executeTask` → the ONE
 * `runtime execution edge, and resumption is expressed the only way the runtime
 * already accepts it: `RunRequest.threadId`.
 */

import type { RunResult } from '../core/types.ts';

/** Where a run should happen. Everything assignment produces, plus the session. */
export interface ExecutionTarget {
  readonly agentId: string;
  readonly modelId: string | null;
  /** An existing workbench session to reuse, when the caller wants continuity. */
  readonly sessionId?: string;
  /**
   * `fresh`  — a new native conversation (default).
   * `resume` — continue `nativeSessionId` of the named session via `threadId`.
   */
  readonly sessionPolicy?: 'fresh' | 'resume';
}

/**
 * Laya's SESSION INTENT: continue existing work, or start clean.
 *
 * WHY IT NEVER NAMES A `nativeSessionId`
 * -------------------------------------
 * The native handle is the AGENT's internal conversation id. Exposing it to Laya
 * would invite Laya to reason about agent internals it cannot own, and would make
 * the reuse key a fact the Workbench cannot validate. So intent names OUR session
 * (`sessionKey`), and this registry — the only authority that knows what that key
 * maps to — resolves it.
 *
 * `reuse` is a REQUEST, not a guarantee. `SessionRegistry.open` still refuses it
 * when the named session belongs to a different agent or model, which is exactly
 * what stops this from becoming model switching through the session channel.
 *
 * There is deliberately no third kind. `previous` ("the last session for this
 * agent") was considered and rejected: it needs an ordering rule nobody asked for,
 * and that rule would silently pick a session Laya never chose.
 */
export type SessionIntent =
  | { readonly kind: 'fresh' }
  /** Continue the session named by `sessionKey`. Refused on identity mismatch. */
  | { readonly kind: 'reuse'; readonly sessionKey: string };

/** The intent assumed when a caller expresses none. Unchanged from before. */
export const DEFAULT_SESSION_INTENT: SessionIntent = Object.freeze({ kind: 'fresh' });

/**
 * Project a session intent onto the `ExecutionTarget` this registry already accepts.
 *
 * A pure function rather than logic inside `assignChildren`, so "what Laya asked
 * for" -> "what the registry is told" is stated once and testable with no registry.
 */
export function toExecutionTarget(
  intent: SessionIntent | undefined,
  identity: { readonly agentId: string; readonly modelId: string | null },
): ExecutionTarget {
  const resolved = intent ?? DEFAULT_SESSION_INTENT;
  return resolved.kind === 'reuse'
    ? { agentId: identity.agentId, modelId: identity.modelId, sessionId: resolved.sessionKey, sessionPolicy: 'resume' }
    : { agentId: identity.agentId, modelId: identity.modelId, sessionPolicy: 'fresh' };
}

/** One working context on one native agent. */
export interface WorkbenchSession {
  readonly sessionId: string;
  readonly agentId: string;
  readonly modelId: string | null;
  /**
   * The NATIVE agent's own conversation id (`RunResult.threadId`), null until the
   * first run on this session actually reported one. Never a workbench invention.
   */
  readonly nativeSessionId: string | null;
  readonly taskId: string | null;
  readonly cwd: string;
  readonly status: 'open' | 'running' | 'closed';
  readonly startedAt: number;
  readonly lastEventAt: number | null;
}

export class SessionRegistryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SessionRegistryError';
    this.code = code;
  }
}

/**
 * The one registry of workbench sessions. Append-and-update-in-place is fine
 * here: a session is a LIVE OBJECT (status changes as work happens), not
 * evidence — history belongs to `AttemptStore`, which stays append-only.
 */
export class SessionRegistry {
  private readonly byId = new Map<string, WorkbenchSession>();
  private counter = 0;
  private readonly newId: () => string;

  constructor(newId?: () => string) {
    // Monotonic readable ids: a session's position in the registry should be
    // visible by eye, the same reasoning AttemptStore uses for attempt ids.
    this.newId = newId ?? (() => `ws_${(++this.counter).toString(36).padStart(4, '0')}`);
  }

  /**
   * WHICH TASK is using each session.
   *
   * WHY THIS EXISTS (P6-D1)
   * ----------------------
   * `WorkbenchSession.taskId` records the CURRENT owner, so opening the same session
   * for a second task overwrote the first task's claim. Two tasks could then share
   * one native conversation while only the last one was recorded — and a caller
   * resolving "the session for task X" got the wrong answer or none.
   *
   * The fact being lost is that one native session legitimately serves SEVERAL tasks
   * in sequence. So the task -> session direction is recorded here, separately from
   * the session's single current owner, and both are kept. This is a mapping, not a
   * manager: sessions are still created, validated and closed exactly as before.
   */
  private readonly sessionByTask = new Map<string, string>();
  /** Which tasks have ever used each session, oldest first. */
  private readonly tasksBySession = new Map<string, string[]>();

  /** The session a task is bound to, or null. */
  sessionForTask(taskId: string): WorkbenchSession | null {
    const id = this.sessionByTask.get(taskId);
    return id === undefined ? null : (this.byId.get(id) ?? null);
  }

  /**
   * The native handle a RESUMING task must be given, or null.
   *
   * Null is a real answer and means "there is no native conversation to continue",
   * which the caller must treat as start-fresh. It never falls back to another
   * task's handle: resuming someone else's conversation would be a cross-task leak,
   * and the identity guard downstream would refuse it anyway.
   */
  nativeHandleForTask(taskId: string): string | null {
    return this.sessionForTask(taskId)?.nativeSessionId ?? null;
  }

  /** Every task that has used a session, in order. */
  tasksForSession(sessionId: string): readonly string[] {
    return [...(this.tasksBySession.get(sessionId) ?? [])];
  }

  /** Open a session for a target. `sessionId` of the target must exist if given. */
  open(target: ExecutionTarget, cwd: string, now: number, taskId?: string): WorkbenchSession {
    const existing = target.sessionId !== undefined ? this.byId.get(target.sessionId) : undefined;
    if (target.sessionId !== undefined && existing === undefined) {
      throw new SessionRegistryError('session-not-found', `no session "${target.sessionId}"`);
    }
    if (existing !== undefined) {
      // Resuming an existing session keeps ITS id and native handle; only the
      // bookkeeping moves. The target's agent/model must agree with the session's
      // — a session belongs to one (agent, model) pair, and silently re-pointing
      // it would be model switching through the back door.
      if (existing.agentId !== target.agentId || (existing.modelId ?? null) !== (target.modelId ?? null)) {
        throw new SessionRegistryError(
          'session-identity-mismatch',
          `session "${existing.sessionId}" belongs to ${existing.agentId}/${existing.modelId ?? 'default'}, ` +
            `not ${target.agentId}/${target.modelId ?? 'default'}`,
        );
      }
      const updated: WorkbenchSession = {
        ...existing,
        status: 'open',
        // The CURRENT owner, which is what it always meant. The full set of tasks
        // that used this session is kept separately above, so overwriting this no
        // longer loses the earlier task.
        taskId: taskId ?? existing.taskId,
      };
      this.byId.set(updated.sessionId, updated);
      this.recordUse(updated.sessionId, taskId);
      return updated;
    }
    const session: WorkbenchSession = Object.freeze({
      sessionId: this.newId(),
      agentId: target.agentId,
      modelId: target.modelId,
      nativeSessionId: null,
      taskId: taskId ?? null,
      cwd,
      status: 'open',
      startedAt: now,
      lastEventAt: null,
    });
    this.byId.set(session.sessionId, session);
    this.recordUse(session.sessionId, taskId);
    return session;
  }

  /** Record that `taskId` is bound to `sessionId`, keeping both directions. */
  private recordUse(sessionId: string, taskId: string | undefined): void {
    if (taskId === undefined || taskId === '') return;
    this.sessionByTask.set(taskId, sessionId);
    const users = this.tasksBySession.get(sessionId) ?? [];
    // Idempotent: re-binding the same task (a retry, a rework, a repeat dispatch)
    // must not make the list grow without bound or imply two parallel users.
    if (!users.includes(taskId)) {
      users.push(taskId);
      this.tasksBySession.set(sessionId, users);
    }
  }

  /**
   * Mark a session as running a task.
   *
   * Also records the task→session binding, because this is how a task that REUSES an
   * existing session becomes findable at all. Before this, `session.taskId` was the only
   * link, and overwriting it on reuse meant `nativeHandleForTask(B)` returned null — so
   * a resume silently never happened while still looking successful.
   */
  markRunning(sessionId: string, taskId: string): WorkbenchSession {
    const updated = this.update(sessionId, (s) => ({ ...s, status: 'running', taskId, lastEventAt: null })) ??
      this.fail(sessionId);
    this.recordUse(sessionId, taskId);
    return updated;
  }

  /**
   * Record what a completed run reported. `RunResult.threadId` is the NATIVE
   * session handle.
   *
   * The handle is updated to the LATEST reported value, not kept at the first. That
   * changed because of a measured consequence: a re-run that starts a FRESH native
   * conversation reports a NEW id, and "first wins" left the registry advertising a
   * handle for a conversation that no longer existed. A stale handle is worse than a
   * missing one — a missing handle makes a resume fail visibly, whereas a stale one
   * resumes somebody's old conversation.
   *
   * For an actual RESUME the id is expected to be unchanged, so this is a no-op there.
   */
  recordRun(sessionId: string, result: RunResult, now: number): WorkbenchSession {
    const updated = this.update(sessionId, (s) => ({
      ...s,
      nativeSessionId: result.threadId ?? s.nativeSessionId,
      status: 'open',
      lastEventAt: now,
    }));
    return updated ?? this.fail(sessionId);
  }

  /** Attach a session to the task that consumed it (retrospectively is fine). */
  attach(sessionId: string, taskId: string): WorkbenchSession {
    const updated = this.update(sessionId, (s) => ({ ...s, taskId })) ?? this.fail(sessionId);
    this.recordUse(sessionId, taskId);
    return updated;
  }

  close(sessionId: string): WorkbenchSession {
    return this.update(sessionId, (s) => ({ ...s, status: 'closed' })) ?? this.fail(sessionId);
  }

  get(sessionId: string): WorkbenchSession | null {
    return this.byId.get(sessionId) ?? null;
  }

  /** All sessions for one agent — the workbench's "what is OpenCode doing" view. */
  sessionsForAgent(agentId: string): readonly WorkbenchSession[] {
    return [...this.byId.values()].filter((s) => s.agentId === agentId);
  }

  /** Every session, oldest first. The dashboard view. */
  all(): readonly WorkbenchSession[] {
    return [...this.byId.values()].sort((a, b) =>
      (a.startedAt - b.startedAt) || (a.sessionId < b.sessionId ? -1 : 1));
  }

  /** The threadId a resume on this session must pass, or null. */
  nativeHandleFor(sessionId: string): string | null {
    return this.byId.get(sessionId)?.nativeSessionId ?? null;
  }

  private update(sessionId: string, f: (s: WorkbenchSession) => WorkbenchSession): WorkbenchSession | null {
    const s = this.byId.get(sessionId);
    if (s === undefined) return null;
    const updated = f(s);
    this.byId.set(sessionId, updated);
    return updated;
  }

  private fail(sessionId: string): never {
    throw new SessionRegistryError('session-not-found', `no session "${sessionId}"`);
  }
}
