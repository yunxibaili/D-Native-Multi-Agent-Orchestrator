/**
 * src/orchestration/planner-wiring.ts — P6-C: the ONLY place a plan reaches the store.
 *
 * THE ORDER, AND WHY IT IS THE ORDER
 * ----------------------------------
 *   validate the COMPLETE candidate DAG   (planner.ts, no store access)
 *        -> only then commit, one task at a time, through `TaskStore.create`
 *
 * Reversing it — writing as you validate — is how a planner produces a half-built
 * graph and only then discovers the cycle closing at the last node. Every task
 * written would need unwinding, and "unwound" means destroying tasks that may
 * already be running. So the whole graph is proven acyclic before anything exists.
 *
 * NO NEW GRAPH
 * -------------
 * This module holds no task list of its own. It reads a validated candidate array
 * as an argument, writes each candidate through the existing `TaskStore.create`,
 * and returns the resulting `Task`s. Between calls there is nothing here to drift
 * from the store, because there is nothing here.
 *
 * NO EXECUTION
 * -------------
 * It cannot spawn, tick, assign or verify. It writes identity-free tasks; P6-B
 * assigns the worker afterwards, and the existing `TaskScheduler.tick()` dispatches.
 */

import type { CandidateTask, CandidateRejection, DagValidation } from './planner.ts';
import { validateCandidateDag } from './planner.ts';
import type { TaskStore } from './store.ts';
import type { Task } from './task.ts';
import {
  CompletionContractError,
  parseCompletionContract,
  type CompletionContract,
} from './completion-contract.ts';

/** Why a commit was refused. Nothing is written in any of these cases. */
export type CommitFailure =
  | 'plan-invalid'
  | 'root-not-found'
  | 'task-already-exists'
  | 'parent-not-found'
  | 'create-refused'
  /** P0-1: a candidate carried a completion contract that is empty/partial/unsafe. */
  | 'completion-refused';

export type CommitOutcome =
  | {
      readonly ok: true;
      /** The tasks actually created, in creation order. */
      readonly created: readonly Task[];
      readonly generation: number;
    }
  | {
      readonly ok: false;
      readonly code: CommitFailure;
      readonly reason: string;
      /** Validation rejections, when the plan itself was the problem. */
      readonly rejections?: readonly CandidateRejection[];
    };

export interface CommitOptions {
  /**
   * Identity to seed each candidate with.
   *
   * P6-C does NOT choose this. A candidate has no agent, and the commit records a
   * provisional one so the existing `spawn gate` can evaluate it — after which P6-B
   * assignment replaces it through `TaskStore.assignIdentity`. That order is
   * deliberate: assignment needs a task to attach an identity to, and creating a
   * task is `spawnChild`'s precondition.
   */
  readonly agentId: string;
  readonly modelId?: string | null;
  readonly budgetUnits?: number;
  /** Planner generation stamped on every created task. */
  readonly generation?: number;
}

/**
 * P0-1: validate + freeze every PRESENT candidate completion contract with the ONE
 * parser, BEFORE any task is written.
 *
 * Exported so the workbench can run it before it creates the root (a `commitPlan`
 * refusal would otherwise leave a root behind), and reused by `commitPlan` for direct
 * callers. An absent contract is left absent (a coding candidate without one is refused
 * later, at completion, never silently given a default).
 */
export function validateCandidateCompletions(
  candidates: readonly CandidateTask[],
): { readonly ok: true; readonly contracts: Map<string, CompletionContract> } | { readonly ok: false; readonly reason: string } {
  const contracts = new Map<string, CompletionContract>();
  for (const c of candidates) {
    if (c.completion === undefined) continue;
    try {
      contracts.set(c.taskId, parseCompletionContract(
        { expectedArtifacts: c.completion.expectedArtifacts, allowedScope: c.completion.allowedScope, test: c.completion.test },
        `candidate "${c.taskId}"`,
        { taskType: c.taskType },
      ));
    } catch (e) {
      if (e instanceof CompletionContractError) return { ok: false, reason: `${c.taskId}: ${e.detail}` };
      throw e;
    }
  }
  return { ok: true, contracts };
}

/**
 * Write a validated candidate DAG into the EXISTING store.
 *
 * Validates first, commits second. On any refusal the store is untouched — which is
 * asserted by the tests comparing a full snapshot before and after, because
 * "we checked first" is easy to claim and easy to break.
 */
export function commitPlan(
  store: TaskStore,
  candidates: readonly CandidateTask[],
  options: CommitOptions,
): CommitOutcome {
  // Pre-flight FIRST, before validation, so each refusal gets the code that says
  // what actually went wrong. Validating first would report a missing root as
  // `unknown-parent` on every candidate — technically true, but it hides the one
  // fact the caller needs to fix. Cheap structural checks, then the expensive
  // whole-graph proof, then writes.
  if (candidates.length === 0) {
    // Handled by the shared validator rather than a bespoke message, so an empty
    // plan reports the SAME typed rejection a caller sees from validateCandidateDag
    // directly. Two vocabularies for one failure is how a caller ends up matching
    // the wrong one.
    const empty = validateCandidateDag([], new Map());
    return {
      ok: false,
      code: 'plan-invalid',
      reason: empty.ok ? 'a plan must propose at least one task' : 'a plan must propose at least one task',
      rejections: empty.ok ? [] : empty.rejections,
    };
  }
  const root = candidates[0].parentTaskId;
  if (root === null) {
    return { ok: false, code: 'root-not-found', reason: 'a candidate DAG must name a parent; null parentTaskId has nothing to hang from' };
  }
  const rootTask = store.get(root);
  if (rootTask === null) {
    return { ok: false, code: 'root-not-found', reason: `no task "${root}" to plan under` };
  }
  for (const c of candidates) {
    if (store.has(c.taskId)) {
      return { ok: false, code: 'task-already-exists', reason: `task "${c.taskId}" already exists` };
    }
    if (c.parentTaskId !== null && !store.has(c.parentTaskId) &&
        !candidates.some((x) => x.taskId === c.parentTaskId)) {
      return { ok: false, code: 'parent-not-found', reason: `"${c.taskId}" names parent "${c.parentTaskId}", which does not exist` };
    }
  }

  // P0-1: THE COMMON CONTRACT BOUNDARY. Every candidate — from the plan-file path, a
  // built-in plan, or a DIRECT `planWithCandidates` caller — reaches the store here. A
  // present contract is therefore re-validated and FROZEN with the ONE parser before it
  // is written, so a caller cannot smuggle an empty/partial contract (e.g. an empty
  // `expectedArtifacts`) past the parser that only the CLI path used to run, and the
  // task can never carry a mutable contract that is later edited into a bypass.
  const validated = validateCandidateCompletions(candidates);
  if (!validated.ok) return { ok: false, code: 'completion-refused', reason: validated.reason };
  const validatedCompletions = validated.contracts;

  const existing = new Map(store.all().map((t) => [t.taskId, { taskId: t.taskId, dependencies: t.dependencies } as const]));
  const validation: DagValidation = validateCandidateDag(candidates, existing);
  if (!validation.ok) {
    return {
      ok: false,
      code: 'plan-invalid',
      reason: `the candidate DAG is invalid: ${validation.rejections.map((r) => `${r.code} (${r.detail})`).join('; ')}`,
      rejections: validation.rejections,
    };
  }

  // Commit. Ordering is dependencies-first so a dependant is never created before
  // something it waits on, which keeps the store valid at every intermediate step
  // rather than only at the end.
  const ordered = [...candidates].sort((a, b) => {
    const da = a.dependencies.length;
    const db = b.dependencies.length;
    return da - db || (a.taskId < b.taskId ? -1 : 1);
  });

  const created: Task[] = [];
  for (const c of ordered) {
    const parentId = c.parentTaskId;
    const result = store.create(
      {
        taskId: c.taskId,
        parentTaskId: parentId,
        agentId: options.agentId,
        modelId: options.modelId ?? null,
        taskType: c.taskType,
        // The description BECOMES the acceptance criteria: that is what
        // verification later checks, so a task nobody can judge is not created.
        acceptanceCriteria: c.description,
        dependencies: [...c.dependencies],
        budgetUnits: c.budgetUnits ?? options.budgetUnits ?? 0,
        generation: options.generation ?? 0,
        // P0-1: the VALIDATED + FROZEN contract (never the caller's mutable object).
        ...(validatedCompletions.has(c.taskId) ? { completionContract: validatedCompletions.get(c.taskId)! } : {}),
      },
      Date.now(),
    );
    if (!result.ok || result.task === null) {
      // Should be unreachable given the pre-flight, but a store that refuses here
      // would leave a partial graph, so it is reported rather than swallowed.
      return {
        ok: false,
        code: 'create-refused',
        reason: `store refused "${c.taskId}": ${result.code ?? 'unknown'} ${result.reason ?? ''}`,
      };
    }
    created.push(result.task);
  }

  return { ok: true, created, generation: options.generation ?? 0 };
}

// ---------------------------------------------------------------------------
// Controlled replan
// ---------------------------------------------------------------------------

export interface ReplanOutcome {
  readonly status: 'applied' | 'noop' | 'refused';
  readonly generation: number;
  /** Tasks created by this replan. */
  readonly created: readonly Task[];
  /** Old tasks removed because they were never started and are superseded. */
  readonly removed: readonly string[];
  /** Old tasks kept but marked stale: their dependencies no longer describe the plan. */
  readonly markedStale: readonly string[];
  /** Tasks the planner was refused any authority over. Listed so it is visible. */
  readonly protected: readonly string[];
  readonly reason: string;
}

/**
 * Replan the INCOMPLETE part of a subtree. Never the completed part.
 *
 * The protection comes from `TaskStore.partitionForReplan`, which splits the
 * subtree by status and is the same rule `store.ts` uses to refuse a mutation on a
 * started task. So "a replan cannot delete completed work" is enforced by the
 * store, not by this caller remembering to be careful.
 *
 * A task that is merely STALE is not removed either: its record is what explains
 * how the current plan came to exist, and deleting it would erase the reason the
 * new plan looks different.
 */
export function replanSubtree(
  store: TaskStore,
  rootTaskId: string,
  candidates: readonly CandidateTask[],
  options: CommitOptions,
): ReplanOutcome {
  const generation = (store.latestGeneration() + 1);
  const { replaceable, staleOnly, untouchable } = store.partitionForReplan(rootTaskId);
  const protectedIds = [...untouchable.map((t) => t.taskId), ...staleOnly.map((t) => t.taskId)];
  const staleReason = `superseded by planner generation ${generation}`;

  // Validate the NEW graph before removing anything from the old one.
  const validation = validateCandidateDag(
    candidates,
    new Map(store.all().map((t) => [t.taskId, { taskId: t.taskId, dependencies: t.dependencies } as const])),
  );
  if (!validation.ok) {
    return {
      status: 'refused',
      generation,
      created: [],
      removed: [],
      markedStale: [],
      protected: protectedIds,
      reason: `replan refused, nothing changed: ${validation.rejections.map((r) => `${r.code} (${r.detail})`).join('; ')}`,
    };
  }

  // Queued tasks keep existing but are marked stale — a tick may already have
  // selected them. Removing one would be deleting admitted work.
  const markedStale: string[] = [];
  for (const t of staleOnly) {
    if (store.markStale(t.taskId, staleReason).ok) markedStale.push(t.taskId);
  }

  const removed: string[] = [];
  for (const t of replaceable) {
    if (store.removePlanned(t.taskId).ok) removed.push(t.taskId);
  }

  const commit = commitPlan(store, candidates, { ...options, generation });
  if (!commit.ok) {
    return {
      status: 'refused',
      generation,
      created: [],
      removed,
      markedStale,
      protected: protectedIds,
      reason: `replan commit refused after ${removed.length} removal(s): ${commit.reason}`,
    };
  }

  return {
    status: 'applied',
    generation,
    created: commit.created,
    removed,
    markedStale,
    protected: protectedIds,
    reason:
      `generation ${generation}: created ${commit.created.length}, removed ${removed.length} never-started, ` +
      `marked ${markedStale.length} stale, protected ${protectedIds.length} started-or-queued`,
  };
}

/** Read a task's staleness, for callers that must not reach into the store. */
export function staleTasks(store: TaskStore, rootTaskId?: string): Task[] {
  const all = rootTaskId === undefined
    ? store.all()
    : store.descendants(rootTaskId);
  return all.filter((t) => t.stale);
}

// NOTE: nothing is re-exported from `planner.ts` here on purpose. `CandidateRejection`
// is already a P6-B name in `assignment.ts` for a DIFFERENT concept, and duplicating
// it in the barrel would make an unqualified import silently mean either one. Both
// modules remain importable by path, where the name is unambiguous.