/**
 * src/orchestration/planner.ts — P6-C: a candidate DAG producer, and nothing else.
 *
 * WHAT A PLANNER IS HERE
 * ---------------------
 * A pure function from a task description to CANDIDATE TASKS. Its output is data.
 * That is the whole contract, and the narrowness is the design:
 *
 *   plan(input) -> { candidates: CandidateTask[], notes: string[] }
 *
 * WHY IT HAS NO REFERENCES
 * -----------------------
 * This module imports no `TaskStore`, no `TaskScheduler`, no `Orchestrator`, no
 * `WorkspaceManager`, no `RuntimeRunner`, and no assignment engine. Not "careful
 * with them" — structurally unable to reach them. So the answer to "can the planner
 * execute, dispatch, or assign a worker?" is "there is no path", which is a
 * different and much stronger claim than "it currently chooses not to".
 *
 * A planner that could execute would be a second execution edge within one stage.
 * One that could assign would duplicate P6-B's capability routing. Both are the
 * exact failure modes P6 exists to prevent.
 *
 * WHY THE OUTPUT IS ONLY A CANDIDATE
 * ---------------------------------
 * A candidate DAG is not a task graph. It is a PROPOSAL, and proposals are
 * routinely invalid: the planner may name a dependency that does not exist, or
 * close a loop by accident. `validateCandidateDag` is what decides, and
 * `commitPlan` is what writes. Keeping those separate is what lets an invalid plan
 * be rejected while leaving the authoritative `TaskStore` untouched — if the
 * planner could write directly, "validated" would be a claim about timing rather
 * than a property.
 *
 * PLANNER vs LAYA
 * ----------------
 * The planner answers "what work would satisfy this?". Laya answers "what should
 * the orchestrator do next?". A planner that emitted continue / wait / abort /
 * retry / reassign would be a second decision system, so those actions do not
 * appear anywhere in this file. `replan` is the one exception, and it is reached
 * through P6-A's existing `OrchestrationDecision`, not invented here.
 */

import type { TaskType } from '../quota/types.ts';
import { TASK_TYPES } from '../quota/types.ts';
import { findDependencyCycle } from './task.ts';
// TYPE-ONLY. `SessionIntent` is data the planner passes through; importing it as a
// type keeps the planner's runtime imports to `task.ts` alone, so the structural
// "planner reaches nothing" test still holds.
import type { SessionIntent } from './workbench-sessions.ts';

// ---------------------------------------------------------------------------
// The output type
// ---------------------------------------------------------------------------

/**
 * One proposed task. Deliberately NOT a `TaskSpec`.
 *
 * A `TaskSpec` is what `TaskStore.create` accepts, and it carries `agentId` — so a
 * planner that emitted TaskSpecs would be choosing workers, which is P6-B's job.
 * `CandidateTask` has no agent, no model, and no status: it is a proposal about
 * WORK, and identity is assigned afterwards by the existing assignment engine.
 */
export interface CandidateTask {
  readonly taskId: string;
  /** Relative to the root being planned. The committer resolves it to a real parent. */
  readonly parentTaskId: string | null;
  readonly taskType: TaskType;
  /** What this task is for. Carried into `acceptanceCriteria` on commit. */
  readonly description: string;
  /** Task ids this candidate depends on. Validated; a dangling one is refused. */
  readonly dependencies: readonly string[];
  /**
   * Types this task also needs, beyond its own `taskType`.
   *
   * PLANNING INTENT ONLY. It is carried through to the caller and read by P6-B
   * assignment; it is NOT a second capability registry and the planner never
   * resolves it to an agent.
   */
  readonly requiredTaskTypes: readonly TaskType[];
  /** Budget units to request. Optional; the committer falls back to its default. */
  readonly budgetUnits?: number;
  /**
   * Laya's SKILL INTENT for THIS candidate, when it differs from its siblings.
   *
   * The same rule as `requiredTaskTypes` above, and for the same reason: this is a
   * REQUEST carried to the native agent, never a selector. Nothing in this file, in
   * assignment, or in the scheduler reads it to choose a worker — the planner could
   * not even, having no registry. It exists so one branch of a DAG can ask for a
   * different skill than its neighbours.
   */
  readonly skills?: readonly string[];
  /**
   * Laya's per-candidate worker PREFERENCE. Overrides any spec-level default for
   * this candidate only, which is what lets one DAG run OpenCode/Model A next to
   * WorkBuddy/Model C.
   *
   * A PREFERENCE, not an assignment, exactly like the spec-level one: assignment
   * still runs capability → availability → quota → score and only promotes a
   * preferred pair that survived all of them. So this can express intent and can
   * never bypass a filter or the spawn gate.
   */
  readonly preferredAgent?: string;
  readonly preferredModel?: string;
}

export interface PlannerInput {
  /** What to plan for. */
  readonly objective: string;
  /** id of the root the candidates hang from. Must already exist. */
  readonly rootTaskId: string;
  /**
   * Free-form shape hint: `chain`, `parallel`, `diamond`, or `levels:N`.
   *
   * This is how decomposition is expressed WITHOUT giving the planner a model. A
   * caller that wants a diamond says so; the planner expands it deterministically.
   * It is a shape vocabulary, not an instruction language, and there is no
   * "do X then Y" escape hatch — that is the long-text control protocol P6-A
   * exists to prevent.
   *
   * Typed as a template plus a parser-side check rather than as the literal string
   * `'levels:N'`, because a literal type would REJECT `'levels:3'` at compile time
   * and make the one dynamic shape unreachable from a type-checked caller. The
   * narrowing to `${number}` happens here, so a malformed `levels:abc` is still a
   * runtime `PlannerError` rather than a compile error.
   */
  readonly shape?: 'chain' | 'parallel' | 'diamond' | 'single' | `levels:${string}`;
  /** For `levels:N`, how many parallel tasks per level. Defaults to 2. */
  readonly width?: number;
  /** Which planner generation these candidates belong to. Carried, not decided here. */
  readonly generation?: number;
  /**
   * Laya's skill intent, applied to every candidate the shape produces.
   *
   * NOT a selector. Nothing here resolves a skill to an agent or filters on it;
   * the names ride through to the brief, where the native agent interprets them
   * against the skills it actually has. An empty/absent list means "say nothing",
   * which is why it is not defaulted to a plausible set.
   */
  readonly skills?: readonly string[];
  /**
   * The task type every candidate this shape produces should carry.
   *
   * DEFAULT `implementation`, which is why it is optional — and that default is exactly
   * why `add_task`'s `taskType` used to be decorative: the planner hard-coded
   * implementation work and a decision's requested type could only be reported as a
   * note. Making it an input keeps the planner the ONLY place a candidate's type is
   * decided, which is what stops `Workbench.addTask` from becoming a second task
   * creation path that constructs a type by hand.
   *
   * The shape vocabulary still cannot vary the type PER NODE: `chain` and `diamond`
   * describe topology, not work kind. A DAG needing mixed types expresses that with
   * separate `planTasks` calls, each with its own `taskType`.
   */
  readonly taskType?: TaskType;
  /**
   * Laya's session intent for this plan, carried to the caller unchanged.
   *
   * It is on the INPUT and echoed on the OUTPUT, and deliberately NOT copied onto
   * each candidate: continuity is a property of dispatching a run, not a durable
   * fact about a task. Writing it into TaskStore would make a session key
   * indistinguishable from task state, and TaskStore has no business knowing what a
   * session is.
   */
  readonly sessionIntent?: SessionIntent;
}

export interface PlannerOutput {
  readonly candidates: readonly CandidateTask[];
  /** Human-readable trace of how the shape was expanded. Not an instruction. */
  readonly notes: readonly string[];
  /** Always the input generation; a planner cannot silently move generations. */
  readonly generation: number;
  /** The input's session intent, or undefined. Echoed, never reinterpreted. */
  readonly sessionIntent?: SessionIntent;
}

export class PlannerError extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(code: string, detail: string) {
    super(`Planner refused to produce a DAG [${code}]: ${detail}`);
    this.name = 'PlannerError';
    this.code = code;
    this.detail = detail;
  }
}

export function isPlannerError(value: unknown): value is PlannerError {
  return value instanceof PlannerError;
}

// ---------------------------------------------------------------------------
// Decomposition
// ---------------------------------------------------------------------------

const WIDE_DEFAULT = 2;

const candidate = (
  taskId: string,
    parentTaskId: string,
    taskType: TaskType,
    description: string,
    dependencies: readonly string[],
    requiredTaskTypes: readonly TaskType[] = [],
    /** Optional per-candidate extras: skills and worker preference. */
    extras?: Pick<CandidateTask, 'skills' | 'preferredAgent' | 'preferredModel'>,
  ): CandidateTask => Object.freeze({
    taskId, parentTaskId, taskType, description,
    dependencies: Object.freeze([...dependencies]),
    requiredTaskTypes: Object.freeze([...requiredTaskTypes]),
    // Only set when actually supplied, so an untouched candidate stays
    // byte-identical to the pre-P6-C shape and no `skills: undefined` key appears
    // in a snapshot comparison for reasons that mean nothing.
    ...(extras?.skills !== undefined ? { skills: Object.freeze([...extras.skills]) } : {}),
    ...(extras?.preferredAgent !== undefined ? { preferredAgent: extras.preferredAgent } : {}),
    ...(extras?.preferredModel !== undefined ? { preferredModel: extras.preferredModel } : {}),
  });

/**
 * Expand an objective into a candidate DAG.
 *
 * Total and deterministic: the same input always yields byte-identical output, and
 * ids are derived from the ROOT id, never from a clock or a counter — so two plans
 * of the same objective cannot collide, and re-planning the same root is a
 * recognisable repeat rather than a mystery.
 *
 * Refuses rather than guessing. An unknown shape is an error, because silently
 * defaulting it would mean the caller asked for one topology and received another.
 */
export function planTasks(input: PlannerInput): PlannerOutput {
  if (input.objective.trim() === '') {
    throw new PlannerError('empty-objective', 'an objective must be a non-empty string');
  }
  if (input.rootTaskId.trim() === '') {
    throw new PlannerError('empty-root', 'rootTaskId must be a non-empty string');
  }
  const generation = input.generation ?? 0;
  const root = input.rootTaskId;
  const shape = input.shape ?? 'parallel';
  const width = input.width ?? WIDE_DEFAULT;
  const notes: string[] = [];

  // Fail-closed on an unknown task type rather than defaulting it. `implementation` is
  // the default only when the caller said NOTHING; a caller that said something wrong
  // has a bug, and silently planning implementation work for it would hide that bug
  // until a capability filter silently dropped the task much later.
  if (input.taskType !== undefined && !(TASK_TYPES as readonly string[]).includes(input.taskType)) {
    throw new PlannerError(
      'invalid-task-type',
      `taskType must be one of ${TASK_TYPES.join(', ')}, got ${JSON.stringify(input.taskType)}`,
    );
  }

  if (shape !== 'levels:N' && !Number.isInteger(width) || width < 1) {
    // Only meaningful for `levels:N`, but validated up front so a bad width is
    // reported as a bad width rather than as a silently different DAG.
    throw new PlannerError('invalid-width', `width must be an integer >= 1, got ${String(input.width)}`);
  }

  const impl: TaskType = input.taskType ?? 'implementation';
  // Spec-level skills apply to every candidate; a per-candidate `skills` on the
  // input would win. Since the shape vocabulary has no per-node table, the input
  // carries the shared set and this is the single place the default is applied.
  const skills = input.skills;
  const build = (id: string, desc: string, deps: readonly string[]): CandidateTask =>
    candidate(id, root, impl, `${input.objective} :: ${desc}`, deps, [],
      skills !== undefined && skills.length > 0 ? { skills } : undefined);
  // Every shape below returns through here, so the session intent is echoed
  // identically by all of them instead of each `return` having to remember it.
  const done = (candidates: readonly CandidateTask[]): PlannerOutput => ({
    candidates,
    notes,
    generation,
    ...(input.sessionIntent !== undefined ? { sessionIntent: input.sessionIntent } : {}),
  });

  switch (shape) {
    case 'single': {
      notes.push('one candidate task, no dependencies');
      return done([build(`${root}-s1`, 'single task', [])]);
    }
    case 'chain': {
      // One dependency each: nothing can run in parallel until the previous finishes.
      notes.push('serial chain: each task depends on the one before it');
      const ids = [`${root}-c1`, `${root}-c2`, `${root}-c3`];
return done([
          build(ids[0], 'step 1', []),
          build(ids[1], 'step 2', [ids[0]]),
          build(ids[2], 'step 3', [ids[1]]),
        ]);
      }
    case 'parallel': {
      // Independent: the whole point is that a single tick can admit all of them.
      notes.push('independent siblings: no dependencies between them');
return done([
          build(`${root}-p1`, 'branch 1', []),
          build(`${root}-p2`, 'branch 2', []),
          build(`${root}-p3`, 'branch 3', []),
        ]);
      }
    case 'diamond': {
      // A, B independent; C depends on BOTH. This is the multi-dependency shape
      // that the 5C-1 cycle walker used to miss, so it is the interesting case.
      const a = `${root}-d1`;
      const b = `${root}-d2`;
      const c = `${root}-d3`;
      notes.push(`diamond: ${a} and ${b} run in parallel; ${c} waits for both`);
      return done([build(a, 'left branch', []), build(b, 'right branch', []), build(c, 'join', [a, b])]);
    }
    default: {
      if (!shape.startsWith('levels:')) {
        throw new PlannerError('unknown-shape', `"${shape}" is not a known shape [chain, parallel, diamond, levels:N, single]`);
      }
      const n = Number(shape.slice('levels:'.length));
      if (!Number.isInteger(n) || n < 1) {
        throw new PlannerError('unknown-shape', `levels:N needs a positive integer, got "${shape}"`);
      }
      // Each level depends on EVERY task in the level above: a genuine fan-in/fan-out.
      notes.push(`${n} levels x ${width} tasks, each level depending on the whole level above`);
      const out: CandidateTask[] = [];
      let previous: string[] = [];
      for (let level = 0; level < n; level++) {
        const ids: string[] = [];
        for (let w = 0; w < width; w++) ids.push(`${root}-l${level + 1}t${w + 1}`);
        for (const id of ids) out.push(build(id, `level ${level + 1} item ${id.split('t').pop()}`, previous));
        previous = ids;
      }
      return done(out);
    }
  }
}

// ---------------------------------------------------------------------------
// Validation — the WHOLE candidate graph, before anything is written
// ---------------------------------------------------------------------------

export type CandidateRejection =
  | { readonly code: 'duplicate-task-id'; readonly detail: string }
  | { readonly code: 'empty-candidate-set'; readonly detail: string }
  | { readonly code: 'unknown-dependency'; readonly detail: string }
  | { readonly code: 'self-dependency'; readonly detail: string }
  | { readonly code: 'dependency-cycle'; readonly detail: string }
  | { readonly code: 'unknown-parent'; readonly detail: string };

export type DagValidation =
  | { readonly ok: true; readonly candidates: readonly CandidateTask[] }
  | { readonly ok: false; readonly rejections: readonly CandidateRejection[] };

/**
 * The minimal shape a dependency graph needs for cycle detection.
 *
 * Structurally compatible with `Task`, which is how the EXISTING
 * `findDependencyCycle` can be reused instead of a second cycle algorithm being
 * written here. Only the two fields that function reads are required.
 */
export interface CycleProbe {
  readonly taskId: string;
  readonly dependencies: readonly string[];
}

/**
 * Validate a candidate DAG in full, before a single task exists.
 *
 * The order is what makes "fail-closed with no partial write" true rather than
 * aspirational: the caller runs this on the COMPLETE candidate set first, and only
 * a clean result is passed to `commitPlan`. Validating task-by-task while writing
 * would mean a cycle discovered at the last task leaves the first N already in the
 * store.
 *
 * `findDependencyCycle` is the sealed implementation, imported from `task.ts`, and
 * it is given a synthetic map covering BOTH the existing tasks and the candidates —
 * so a candidate that closes a loop through an EXISTING task is caught too, which a
 * candidate-only check would miss.
 */
export function validateCandidateDag(
  candidates: readonly CandidateTask[],
  existing: ReadonlyMap<string, CycleProbe> = new Map(),
): DagValidation {
  const rejections: CandidateRejection[] = [];

  if (candidates.length === 0) {
    return { ok: false, rejections: [{ code: 'empty-candidate-set', detail: 'a plan must propose at least one task' }] };
  }

  const seen = new Set<string>();
  for (const c of candidates) {
    if (c.taskId.trim() === '') {
      rejections.push({ code: 'duplicate-task-id', detail: 'a candidate has an empty taskId' });
      continue;
    }
    if (seen.has(c.taskId)) {
      rejections.push({ code: 'duplicate-task-id', detail: `"${c.taskId}" is proposed more than once` });
    }
    seen.add(c.taskId);
  }
  if (rejections.length > 0) return { ok: false, rejections };

  for (const c of candidates) {
    for (const dep of c.dependencies) {
      // A dependency may name another CANDIDATE or an EXISTING task; anything else
      // is a dangling edge the committer would refuse one-at-a-time.
      if (!seen.has(dep) && !existing.has(dep)) {
        rejections.push({
          code: 'unknown-dependency',
          detail: `"${c.taskId}" depends on "${dep}", which is neither a candidate nor a known task`,
        });
      }
      if (dep === c.taskId) {
        rejections.push({ code: 'self-dependency', detail: `"${c.taskId}" depends on itself` });
      }
    }
  }
  if (rejections.length > 0) return { ok: false, rejections };

  // Parents: a candidate may hang off the root (null -> the caller's root) or off
  // another candidate, but not off a task that does not exist.
  for (const c of candidates) {
    if (c.parentTaskId !== null && !seen.has(c.parentTaskId) && !existing.has(c.parentTaskId)) {
      rejections.push({
        code: 'unknown-parent',
        detail: `"${c.taskId}" names parent "${c.parentTaskId}", which is neither a candidate nor a known task`,
      });
    }
  }
  if (rejections.length > 0) return { ok: false, rejections };

  const probe = new Map<string, CycleProbe>(existing);
  for (const c of candidates) probe.set(c.taskId, { taskId: c.taskId, dependencies: [...c.dependencies] });
  const cycle = findDependencyCycle(probe);
  if (cycle !== null) {
    return { ok: false, rejections: [{ code: 'dependency-cycle', detail: `cycle: ${cycle.join(' -> ')}` }] };
  }

  return { ok: true, candidates };
}