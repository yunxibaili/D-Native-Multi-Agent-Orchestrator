/**
 * src/orchestration/plan-file.ts — B4.2: a bounded, structured PLAN FILE the user can
 * adapt to their own project.
 *
 * ============================================================================
 * WHAT THIS IS
 * ============================================================================
 * The built-in plans (`workflow-plan.ts` full/lean, `collab-plan.ts` duo/trio) hard-code
 * roles and file scopes, so they cannot describe an arbitrary project. This module is the
 * smallest entry that fixes that: a JSON file that declares a SMALL, BOUNDED set of
 * candidate plans (roles, task types, file scopes, deliverables, dependencies, and — for a
 * collaboration group — which member integrates).
 *
 * It is a PURE VALUE module. It parses and validates; it never reads files, never writes a
 * task, never names an agent or a model, and never invokes a model. The chosen plan's
 * candidates flow through the SAME `validateCandidateDag` / `commitPlan` write path, the
 * SAME Assignment / Session / Scheduler / Verification chain as every other plan.
 *
 * It is deliberately NOT a config platform, a DSL, a template engine, a second DAG
 * authority, a router or a registry. The whole vocabulary is the handful of fields below,
 * and every bound is a named constant.
 *
 * WHAT THE FILE MAY NOT DO
 * ------------------------
 *   - It may not name TASK IDS. Ids are always generated from the round's root, so an
 *     external file can never collide with, or overwrite, an existing task.
 *   - It may not name an AGENT or a MODEL. Per-task Agent x Model stays the existing
 *     LAYA + Assignment decision.
 *   - It may not exceed the bounds. A larger or malformed file is REFUSED with a reason,
 *     never silently truncated and never quietly replaced by a built-in plan.
 *
 * FILE SCOPE IS A DECLARATION, NOT A SANDBOX
 * ------------------------------------------
 * `fileScope` is rendered into the task's acceptance criteria, so it is checked and
 * reported. It is NOT enforced by the filesystem: the real boundaries remain Workspace +
 * ResourceClaim + the sequential execution order. Nothing here claims isolation.
 */

import type { TaskType } from '../quota/types.ts';
import { TASK_TYPES } from '../quota/types.ts';
import type { CandidateTask } from './planner.ts';

// ---------------------------------------------------------------------------
// Bounds — named constants, not a configuration platform.
// ---------------------------------------------------------------------------

/** At most this many candidate plans may be offered to LAYA in one file. */
export const PLAN_FILE_MAX_PLANS = 5;
/** At most this many steps in one sequential plan. */
export const PLAN_FILE_MAX_STEPS = 6;
/** REQ-14: a collaboration group is 2–3 members (the integration task is separate). */
export const PLAN_FILE_MIN_MEMBERS = 2;
export const PLAN_FILE_MAX_MEMBERS = 3;
/** The raw file is rejected above this size, before it is parsed. */
export const PLAN_FILE_MAX_BYTES = 64 * 1024;
/** Any single free-text field is capped so the file cannot smuggle an essay. */
export const PLAN_FILE_MAX_TEXT = 400;

// ---------------------------------------------------------------------------
// The shape
// ---------------------------------------------------------------------------

export type PlanFileKind = 'sequential' | 'collaborate';

/** One step (sequential) or one member (collaboration). */
export interface PlanFileStep {
  /** The responsibility label. A TAG — it never selects an agent or grants rights. */
  readonly role: string;
  /** The EXISTING task type this step runs as. */
  readonly taskType: TaskType;
  /** Relative to the project. A declaration, rendered into acceptance criteria. */
  readonly fileScope?: string;
  /** What this step must produce. */
  readonly deliverable: string;
  /**
   * The ROLES this step depends on. Omitted means "the step before it" (a chain, which is
   * what a sequential workflow normally is). An explicit `[]` means no dependencies.
   */
  readonly dependencies?: readonly string[];
}

export interface PlanFileSequentialPlan {
  readonly id: string;
  readonly label: string;
  readonly steps: readonly PlanFileStep[];
}

export interface PlanFileCollaborationPlan {
  readonly id: string;
  readonly label: string;
  readonly members: readonly PlanFileStep[];
  /** 1-based index of the member that carries INTEGRATION RESPONSIBILITY. */
  readonly integratorMember: number;
}

export interface PlanFile {
  readonly kind: PlanFileKind;
  readonly plans: readonly (PlanFileSequentialPlan | PlanFileCollaborationPlan)[];
}

export class PlanFileError extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(code: string, detail: string) {
    super(`plan file refused [${code}]: ${detail}`);
    this.name = 'PlanFileError';
    this.code = code;
    this.detail = detail;
  }
}

export function isPlanFileError(value: unknown): value is PlanFileError {
  return value instanceof PlanFileError;
}

// ---------------------------------------------------------------------------
// Parsing + validation (total: every rejection names the offending field)
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function text(value: unknown, where: string, required = true): string | undefined {
  if (value === undefined) {
    if (required) throw new PlanFileError('missing-field', `${where} is required`);
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PlanFileError('invalid-field', `${where} must be a non-empty string`);
  }
  if (value.length > PLAN_FILE_MAX_TEXT) {
    throw new PlanFileError('too-long', `${where} is ${value.length} chars, over the ${PLAN_FILE_MAX_TEXT} limit`);
  }
  return value.trim();
}

function parseStep(raw: unknown, where: string): PlanFileStep {
  if (!isRecord(raw)) throw new PlanFileError('invalid-step', `${where} must be an object`);
  const role = text(raw.role, `${where}.role`)!;
  const taskTypeRaw = text(raw.taskType, `${where}.taskType`)!;
  if (!(TASK_TYPES as readonly string[]).includes(taskTypeRaw)) {
    throw new PlanFileError(
      'invalid-task-type',
      `${where}.taskType "${taskTypeRaw}" is not one of ${TASK_TYPES.join(', ')}`,
    );
  }
  const deliverable = text(raw.deliverable, `${where}.deliverable`)!;
  const fileScope = text(raw.fileScope, `${where}.fileScope`, false);
  let dependencies: readonly string[] | undefined;
  if (raw.dependencies !== undefined) {
    if (!Array.isArray(raw.dependencies)) {
      throw new PlanFileError('invalid-field', `${where}.dependencies must be an array of role names`);
    }
    dependencies = raw.dependencies.map((d, i) => text(d, `${where}.dependencies[${i}]`)!);
  }
  return Object.freeze({
    role,
    taskType: taskTypeRaw as TaskType,
    ...(fileScope === undefined ? {} : { fileScope }),
    deliverable,
    ...(dependencies === undefined ? {} : { dependencies: Object.freeze([...dependencies]) }),
  });
}

/**
 * Reject a role graph that cannot be committed: a dependency on a role that does not
 * exist, a self-dependency, or a cycle. This runs BEFORE any task is written, and the
 * same graph is re-checked by `validateCandidateDag` after ids are assigned.
 */
function validateStepGraph(steps: readonly PlanFileStep[], where: string): void {
  const roles = new Set(steps.map((s) => s.role));
  if (roles.size !== steps.length) {
    const seen = new Set<string>();
    for (const s of steps) {
      if (seen.has(s.role)) throw new PlanFileError('duplicate-role', `${where} declares role "${s.role}" more than once`);
      seen.add(s.role);
    }
  }
  for (const s of steps) {
    for (const dep of s.dependencies ?? []) {
      if (dep === s.role) throw new PlanFileError('self-dependency', `${where}: "${s.role}" depends on itself`);
      if (!roles.has(dep)) {
        throw new PlanFileError('unknown-dependency', `${where}: "${s.role}" depends on "${dep}", which is not a declared role`);
      }
    }
  }
  // Cycle detection over the role graph.
  const visiting = new Set<string>();
  const done = new Set<string>();
  const byRole = new Map(steps.map((s) => [s.role, s]));
  const visit = (role: string, path: string[]): void => {
    if (done.has(role)) return;
    if (visiting.has(role)) {
      throw new PlanFileError('dependency-cycle', `${where}: cycle ${[...path, role].join(' -> ')}`);
    }
    visiting.add(role);
    for (const dep of byRole.get(role)?.dependencies ?? []) visit(dep, [...path, role]);
    visiting.delete(role);
    done.add(role);
  };
  for (const s of steps) visit(s.role, []);
}

function parseSequentialPlan(raw: Record<string, unknown>, where: string): PlanFileSequentialPlan {
  const id = text(raw.id, `${where}.id`)!;
  const label = text(raw.label, `${where}.label`)!;
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new PlanFileError('invalid-plan', `${where}.steps must be a non-empty array`);
  }
  if (raw.steps.length > PLAN_FILE_MAX_STEPS) {
    throw new PlanFileError('too-many-steps', `${where} has ${raw.steps.length} steps, over the ${PLAN_FILE_MAX_STEPS} limit`);
  }
  const steps = raw.steps.map((s, i) => parseStep(s, `${where}.steps[${i}]`));
  validateStepGraph(steps, `${where}.steps`);
  return Object.freeze({ id, label, steps: Object.freeze(steps) });
}

function parseCollaborationPlan(raw: Record<string, unknown>, where: string): PlanFileCollaborationPlan {
  const id = text(raw.id, `${where}.id`)!;
  const label = text(raw.label, `${where}.label`)!;
  if (!Array.isArray(raw.members) || raw.members.length === 0) {
    throw new PlanFileError('invalid-plan', `${where}.members must be a non-empty array`);
  }
  if (raw.members.length < PLAN_FILE_MIN_MEMBERS || raw.members.length > PLAN_FILE_MAX_MEMBERS) {
    throw new PlanFileError(
      'invalid-member-count',
      `${where} has ${raw.members.length} members, outside the ${PLAN_FILE_MIN_MEMBERS}-${PLAN_FILE_MAX_MEMBERS} a collaboration group may have`,
    );
  }
  const members = raw.members.map((m, i) => parseStep(m, `${where}.members[${i}]`));
  validateStepGraph(members, `${where}.members`);
  const integratorMember = raw.integratorMember;
  if (typeof integratorMember !== 'number' || !Number.isInteger(integratorMember) ||
    integratorMember < 1 || integratorMember > members.length) {
    throw new PlanFileError(
      'invalid-integrator',
      `${where}.integratorMember must be an integer in 1..${members.length} (got ${JSON.stringify(integratorMember)})`,
    );
  }
  return Object.freeze({ id, label, members: Object.freeze(members), integratorMember });
}

/**
 * Parse and validate a plan file. Total and fail-closed: any violation throws a
 * `PlanFileError` naming the field, and nothing is defaulted or dropped.
 */
export function parsePlanFile(raw: unknown): PlanFile {
  if (!isRecord(raw)) throw new PlanFileError('invalid-root', 'the plan file must be a JSON object');
  const kind = raw.kind;
  if (kind !== 'sequential' && kind !== 'collaborate') {
    throw new PlanFileError('invalid-kind', `"kind" must be "sequential" or "collaborate" (got ${JSON.stringify(kind)})`);
  }
  if (!Array.isArray(raw.plans) || raw.plans.length === 0) {
    throw new PlanFileError('invalid-plans', '"plans" must be a non-empty array');
  }
  if (raw.plans.length > PLAN_FILE_MAX_PLANS) {
    throw new PlanFileError('too-many-plans', `${raw.plans.length} plans offered, over the ${PLAN_FILE_MAX_PLANS} limit`);
  }
  const ids = new Set<string>();
  const plans: (PlanFileSequentialPlan | PlanFileCollaborationPlan)[] = [];
  for (let i = 0; i < raw.plans.length; i++) {
    const where = `plans[${i}]`;
    const p = raw.plans[i];
    if (!isRecord(p)) throw new PlanFileError('invalid-plan', `${where} must be an object`);
    const plan = kind === 'sequential' ? parseSequentialPlan(p, where) : parseCollaborationPlan(p, where);
    if (ids.has(plan.id)) throw new PlanFileError('duplicate-plan-id', `plan id "${plan.id}" is used more than once`);
    ids.add(plan.id);
    plans.push(plan);
  }
  return Object.freeze({ kind, plans: Object.freeze(plans) });
}

export function isSequentialPlan(p: PlanFileSequentialPlan | PlanFileCollaborationPlan): p is PlanFileSequentialPlan {
  return Array.isArray((p as PlanFileSequentialPlan).steps);
}
export function isCollaborationPlan(p: PlanFileSequentialPlan | PlanFileCollaborationPlan): p is PlanFileCollaborationPlan {
  return Array.isArray((p as PlanFileCollaborationPlan).members);
}

// ---------------------------------------------------------------------------
// Building candidates — the ONE formatting rule, shared with the built-in plans
// ---------------------------------------------------------------------------

/**
 * Task ids are generated HERE from the round's root, never taken from the file. Two plans
 * of the same kind for the same root are therefore reproducible, and an external file can
 * never name (and thus never overwrite) an existing task.
 */
export function sequentialTaskIds(rootTaskId: string, count: number): readonly string[] {
  return Object.freeze(Array.from({ length: count }, (_, i) => `${rootTaskId}-w${i + 1}`));
}

export interface CollaborationTaskIds {
  readonly memberIds: readonly string[];
  readonly integratorId: string;
  readonly integratorIndex: number;
}

export function collaborationTaskIds(rootTaskId: string, memberCount: number, integratorIndex: number): CollaborationTaskIds {
  return {
    memberIds: Object.freeze(Array.from({ length: memberCount }, (_, i) => `${rootTaskId}-m${i + 1}`)),
    integratorId: `${rootTaskId}-int`,
    integratorIndex,
  };
}

/** Resolve each step's dependencies to task ids (roles -> ids), defaulting to a chain. */
function dependenciesFor(steps: readonly PlanFileStep[], ids: readonly string[]): readonly string[][] {
  const roleIndex = new Map(steps.map((s, i) => [s.role, i]));
  return steps.map((s, i) => {
    if (s.dependencies !== undefined) return s.dependencies.map((r) => ids[roleIndex.get(r)!]!);
    return i === 0 ? [] : [ids[i - 1]!];
  });
}

/**
 * Build the candidate tasks for a sequential plan. The description BECOMES the acceptance
 * criteria on commit, so role, file scope and required deliverable are what Verification
 * checks — not report-only labels. The `:: <role> — deliverable:` prefix is kept stable
 * for every plan (built-in and file) so the downstream brief is uniform.
 */
export function buildSequentialStepCandidates(
  steps: readonly PlanFileStep[],
  objective: string,
  rootTaskId: string,
): CandidateTask[] {
  const ids = sequentialTaskIds(rootTaskId, steps.length);
  const deps = dependenciesFor(steps, ids);
  return steps.map((s, i) => Object.freeze({
    taskId: ids[i]!,
    parentTaskId: rootTaskId,
    taskType: s.taskType,
    description:
      `${objective} :: ${s.role} — deliverable: ${s.deliverable}` +
      (s.fileScope === undefined ? '' : ` — file scope: ${s.fileScope}`),
    dependencies: Object.freeze([...deps[i]!]),
    requiredTaskTypes: Object.freeze([s.taskType]),
  }));
}

/**
 * Build the candidate tasks for a collaboration plan: N members (sequential by default)
 * plus ONE integration task that depends on EVERY member. The integrator is a MEMBER —
 * its pair is reused by the integration task (see `Workbench.inheritInitialSelection`), so
 * no fourth model is introduced.
 */
export function buildCollaborationMemberCandidates(
  members: readonly PlanFileStep[],
  integratorIndex: number,
  objective: string,
  rootTaskId: string,
): CandidateTask[] {
  const { memberIds, integratorId } = collaborationTaskIds(rootTaskId, members.length, integratorIndex);
  const deps = dependenciesFor(members, memberIds);
  const memberCandidates = members.map((m, i) => Object.freeze({
    taskId: memberIds[i]!,
    parentTaskId: rootTaskId,
    taskType: m.taskType,
    description:
      `${objective} :: collaborator ${i + 1} (${m.role}) — file scope: ${m.fileScope ?? '(not specified)'} — ` +
      `deliverable: ${m.deliverable} — do not implement the other members' scopes`,
    dependencies: Object.freeze([...deps[i]!]),
    requiredTaskTypes: Object.freeze([m.taskType]),
  }));
  const integrator = Object.freeze({
    taskId: integratorId,
    parentTaskId: rootTaskId,
    taskType: 'implementation' as const,
    description:
      `${objective} :: integration (collaborator ${integratorIndex} carries integration responsibility) — ` +
      `deliverable: one combined result built from the deliveries listed in this task's handoffs, ` +
      `naming each collaborator's actual contribution — a summary of what everyone finished is NOT a deliverable`,
    dependencies: Object.freeze([...memberIds]),
    requiredTaskTypes: Object.freeze(['implementation'] as const),
  });
  return [...memberCandidates, integrator];
}
