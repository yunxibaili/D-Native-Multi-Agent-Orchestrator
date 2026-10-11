/**
 * orchestration/worker-identity.ts — TeamRun T1-b: "which concrete Worker is this?".
 *
 * A Worker is one execution PARTICIPANT: a task, bound to one Agent Family, one Model,
 * and one native Session. It is not the agent family, not the model, not the session on
 * its own, and emphatically not an Attempt.
 *
 *   Agent Family  !=  Model  !=  Worker  !=  Session  !=  Attempt
 *
 * WHY THIS IS A PROJECTION AND NOT A STORE
 * ----------------------------------------
 * Every field here is already an authoritative fact owned by somebody else:
 *
 *   taskId     TaskStore / Assignment
 *   agentId    Assignment (candidate selection)
 *   modelId    Assignment
 *   sessionId  SessionRegistry — the ONLY authority that may create, resume, close or
 *              re-bind a session
 *
 * So this module reads and composes; it never decides. There is deliberately no
 * `WorkerStore`, no `WorkerManager` and no worker registry: a Worker becomes knowable at
 * the moment Assignment has chosen a pair AND SessionRegistry has resolved a session,
 * and it is knowable by projection from those facts alone. Assignment must NOT be
 * changed into a "worker chooser" to satisfy this file.
 *
 * `workerId = agentId` IS STRUCTURALLY IMPOSSIBLE
 * -----------------------------------------------
 * `sessionId` is required and is part of the key, so an identity can never collapse to a
 * family name. Two workers on the same agent with different models, or the same model in
 * different sessions, are different workers — which is the whole point.
 *
 * MODEL BINDING IS STABLE PER WORKER
 * ----------------------------------
 * A Worker pins one (agent, model, session) triple for its lifetime. Changing the model
 * on the same session would be model switching through the session channel, which
 * `SessionRegistry.open` already refuses on identity mismatch. A model change therefore
 * means a NEW session, which means a NEW worker — and that follows from the key rather
 * than from an extra rule.
 *
 * ATTEMPT IS NOT WORKER
 * ---------------------
 * `attemptId` is deliberately absent. One worker can carry attempt 1 and attempt 2; two
 * attempts of one worker project to the SAME worker key. See `workerIdentityOfAttempt`.
 */

import type { WorkbenchSession } from './workbench-sessions.ts';
import type { ResourceClaimMode, ResourceScope } from './resource-claim.ts';

/**
 * The minimum that makes one Worker distinguishable from every other Worker.
 *
 * `modelId` stays nullable because that is how the rest of the system records "no model
 * was selected" — inventing a placeholder model here would break candidate filtering.
 */
export interface WorkerIdentity {
  readonly taskId: string;
  readonly agentId: string;
  readonly modelId: string | null;
  /** The workbench session that owns the execution. Never the agent's own thread id. */
  readonly sessionId: string;
}

/**
 * A Worker plus the attributes a future TeamRun view would want to show.
 *
 * `mode` and `scope` are carried, not owned: they are supplied by the caller from the
 * resource claim it already holds. `ResourceClaimBook` remains the physical resource
 * authority; a Worker projection never claims, narrows or releases a scope, and mode is
 * NOT part of worker identity (a read worker and a write worker over the same session are
 * not two different people).
 */
export interface WorkerProjection {
  readonly identity: WorkerIdentity;
  readonly mode?: ResourceClaimMode;
  readonly scope?: ResourceScope;
}

export function workerIdentity(parts: WorkerIdentity): WorkerIdentity {
  return Object.freeze({
    taskId: parts.taskId,
    agentId: parts.agentId,
    modelId: parts.modelId,
    sessionId: parts.sessionId,
  });
}

/**
 * A deterministic key for equality / grouping in a Map or Set.
 *
 * Deliberately NOT a database-style `worker_000001`: no global id authority is created
 * here. The key is a pure function of the four facts, so the same worker always produces
 * the same key across processes and runs, and two workers never collide because the
 * tuple is encoded unambiguously (JSON, not a delimiter-joined string that `a::b` could
 * forge).
 */
export function workerKeyOf(identity: WorkerIdentity): string {
  return JSON.stringify([
    identity.taskId,
    identity.agentId,
    identity.modelId,
    identity.sessionId,
  ]);
}

/** The one comparison the rest of the system needs. */
export function sameWorker(a: WorkerIdentity | null, b: WorkerIdentity | null): boolean {
  if (a === null || b === null) return false;
  return workerKeyOf(a) === workerKeyOf(b);
}

/** Group workers without inventing a store — returns the distinct workers in `workers`. */
export function distinctWorkers(workers: readonly WorkerIdentity[]): WorkerIdentity[] {
  const seen = new Set<string>();
  const out: WorkerIdentity[] = [];
  for (const w of workers) {
    const k = workerKeyOf(w);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
  }
  return out;
}

/**
 * Project the Worker an execution participated in, from the SESSION authority.
 *
 * Returns null for a session that has no task owner yet: a session opened but not yet
 * attached to a task is not yet anybody's worker, and guessing a task for it would
 * fabricate identity. The session facts themselves are never copied or altered — this
 * only reads them.
 */
export function workerIdentityOfSession(session: WorkbenchSession): WorkerIdentity | null {
  if (session.taskId === null || session.taskId === '') return null;
  return workerIdentity({
    taskId: session.taskId,
    agentId: session.agentId,
    modelId: session.modelId,
    sessionId: session.sessionId,
  });
}

/**
 * Project the Worker behind an ATTEMPT.
 *
 * An attempt without a recorded session — evidence written before T1-b, or a review
 * attempt that never opened a worker session — cannot be resolved to a Worker, and
 * returns null rather than inventing one. `attemptId` plays no part: two attempts of one
 * worker resolve to the SAME identity, which is what keeps Attempt and Worker distinct.
 */
export function workerIdentityOfAttempt(attempt: {
  readonly taskId: string;
  readonly agentId: string;
  readonly modelId: string | null;
  readonly sessionId?: string;
}): WorkerIdentity | null {
  if (attempt.sessionId === undefined || attempt.sessionId === '') return null;
  return workerIdentity({
    taskId: attempt.taskId,
    agentId: attempt.agentId,
    modelId: attempt.modelId,
    sessionId: attempt.sessionId,
  });
}