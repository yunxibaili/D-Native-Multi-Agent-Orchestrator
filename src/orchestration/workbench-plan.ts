/**
 * src/orchestration/workbench-plan.ts — from a USER task to a committed task tree.
 *
 * THE CHAIN THIS FILE IMPLEMENTS
 * ------------------------------
 *   user objective
 *     → WorkbenchTaskSpec          (what the user/planner wants, structured)
 *     → Laya classification        (work_kind / complexity — the existing Decision Layer)
 *     → planner shape              (trivial→single, moderate→chain/parallel, …)
 *     → planTasks() candidates     (P6-C, pure, no execution references)
 *     → commitPlan()               (the only write, via the existing TaskStore)
 *
 * Laya does NOT emit prompts and does NOT pick workers here. It contributes the
 * two facts it is actually good at: what KIND of work this is, and how BIG it is.
 * The shape vocabulary does the decomposition without any free-text plan, and
 * worker identity is assigned later by the existing assignment engine — which is
 * why nothing in this file names an agent.
 *
 * LAYA IS OPTIONAL AT THE TYPE LEVEL, REQUIRED IN SPIRIT
 * ------------------------------------------------------
 * A caller may supply the real `classifyTask` provider (the local laya-serve) or
 * a stub. Without one, the spec's own taskType and shape are used. That keeps the
 * Workbench runnable on a machine where laya-serve is down — the honest fallback
 * is "the caller decided", never "the workbench guessed".
 */

import type { TaskType } from '../quota/types.ts';
import type { TaskClassification } from '../decision/routing.ts';
import type { PlannerError } from './planner.ts';
import { planTasks, type PlannerOutput } from './planner.ts';
import type { SessionIntent } from './workbench-sessions.ts';

/** The structured task a user (or Laya's replan) hands to the Workbench. */
export interface WorkbenchTaskSpec {
  /** Stable id for the ROOT of this request. */
  readonly taskId: string;
  /** What the user wants, in one paragraph. Never a system prompt. */
  readonly objective: string;
  /** Overrides Laya's work_kind when given. */
  readonly taskType?: TaskType;
  /** Hard limits the worker must respect. Rendered verbatim into the brief. */
  readonly constraints?: readonly string[];
  /** Extra task types the work needs beyond taskType. */
  readonly requiredTaskTypes?: readonly TaskType[];
  /**
   * Laya's session intent, as the DEFAULT for every child of this request.
   *
   * A per-child override rides on `planTasks({ sessionIntent })` and wins over this.
   * Either way this is an INTENT about continuity — never a `nativeSessionId`, and
   * never a session Laya picked by handle. `SessionRegistry` resolves the key and
   * enforces that a reuse cannot cross agents or models.
   */
  readonly sessionIntent?: SessionIntent;
  /** What "done" produces, in words. Verification checks against this. */
  readonly expectedArtifacts?: readonly string[];
  /** Laya/planner preference. Assignment honours it only if the filters pass. */
  readonly preferredAgent?: string;
  readonly preferredModel?: string;
  /**
   * Laya's SKILL INTENT — "this work needs these skills", as a request.
   *
   * THE WORKBENCH DOES NOT USE THIS FOR ANYTHING EXCEPT SAYING IT.
   *
   * It never resolves a skill to an agent, never filters on it, never checks it
   * exists, and never selects anything because of it. Selecting a worker by skill
   * name would make this a SECOND ROUTING ENGINE sitting beside Assignment, which
   * is precisely the authority this architecture refuses to duplicate.
   *
   * The names are carried verbatim into the bounded brief. Interpretation is the
   * native agent's own job: it already knows what skills it has, how to discover
   * them and how to invoke them, and it ignores a name it does not have. We state
   * the intent; the agent owns the capability. See `buildTaskBrief`.
   */
  readonly skills?: readonly string[];
  /** Planner shape override. Defaults to Laya's complexity mapping. */
  readonly shape?: 'chain' | 'parallel' | 'diamond' | 'single' | `levels:${string}`;
  /** Budget units per child. */
  readonly budgetUnits?: number;
}

/** Map Laya's complexity bands onto the planner's shape vocabulary. */
export function shapeForComplexity(complexity: TaskClassification['complexity']): NonNullable<WorkbenchTaskSpec['shape']> {
  switch (complexity) {
    case 'trivial':
      return 'single';
    case 'small':
      return 'single';
    case 'moderate':
      return 'chain';
    case 'large':
      return 'diamond';
    case 'very large':
      return 'parallel';
  }
}

export interface PlanFromSpecOptions {
  readonly classification?: TaskClassification | null;
  readonly now: number;
}

export interface PlanFromSpecResult {
  readonly taskType: TaskType;
  readonly shape: NonNullable<WorkbenchTaskSpec['shape']>;
  /** Laya's own reason, when a classification was supplied. */
  readonly classificationReason: string | null;
  readonly plan: PlannerOutput;
}

/**
 * Turn a spec into committed candidate tasks under the root named by the spec.
 * The root must ALREADY exist (`NativeWorkbench` creates it from the same spec);
 * this function only produces candidates and never writes.
 */
export function planFromSpec(spec: WorkbenchTaskSpec, options: PlanFromSpecOptions): PlanFromSpecResult {
  const taskType = spec.taskType ?? workKindToTaskType(options.classification?.work_kind);
  const shape = spec.shape ?? shapeForComplexity(options.classification?.complexity ?? 'trivial');
  const plan = planTasks({
    objective: renderObjective(spec),
    rootTaskId: spec.taskId,
    shape,
    generation: 0,
    // Skill intent is per SPEC here, not per candidate: the planner expands one
    // objective into siblings that all serve it. A DAG that needs genuinely
    // different skills per branch expresses that through the per-candidate
    // `skills` on `planTasks`, which is why this stays a default.
    skills: spec.skills,
    // Session intent rides on the PLAN, not on the task, because continuity is a
    // property of how a run is dispatched rather than a fact about the work itself.
    // It is therefore carried on `PlanFromSpecResult` for `assignChildren` to read,
    // and never written into TaskStore — which would make a session key look like
    // durable task state and let a later reader treat it as such.
    sessionIntent: spec.sessionIntent,
  });
  // The planner composes `objective :: description`; for a workbench spec the
  // constraint list is part of the contract, so it rides along in the objective
  // that becomes each candidate's acceptance criteria.
  return {
    taskType,
    shape,
    // `provider.details` is deliberately untyped in the Decision Layer; render it
    // read-only instead of guessing at its shape.
    classificationReason: renderClassificationReason(options.classification),
    plan,
  };
}

function renderObjective(spec: WorkbenchTaskSpec): string {
  const parts = [spec.objective.trim()];
  if (spec.expectedArtifacts !== undefined && spec.expectedArtifacts.length > 0) {
    parts.push(`Expected artifacts: ${spec.expectedArtifacts.join('; ')}`);
  }
  if (spec.constraints !== undefined && spec.constraints.length > 0) {
    parts.push(`Constraints: ${spec.constraints.join('; ')}`);
  }
  return parts.join('\n');
}

/**
 * Laya's work_kind and the quota layer's TaskType are two vocabularies that
 * almost agree. The one divergence is `debugging`: a debugging task is
 * implementation work as far as the capability matrix is concerned. The mapping
 * is explicit rather than a cast so a new WorkKind cannot silently fall through.
 */
export function workKindToTaskType(kind: TaskClassification['work_kind'] | undefined): TaskType {
  switch (kind) {
    case 'review': return 'review';
    case 'research': return 'research';
    case 'debugging': return 'implementation';
    case 'implementation': return 'implementation';
    default: return 'implementation';
  }
}

function renderClassificationReason(c: TaskClassification | null | undefined): string | null {
  if (c === null || c === undefined) return null;
  const d = c.provider.details;
  return typeof d === 'string' ? d : JSON.stringify(d) ?? null;
}

/** Re-exported so callers can catch planner refusals without importing planner.ts. */
export type { PlannerError };
