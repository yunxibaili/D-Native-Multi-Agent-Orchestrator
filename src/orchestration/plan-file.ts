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
import {
  CompletionContractError,
  hasAnyCompletionField,
  isCodingTaskType,
  parseCompletionContract,
  type CompletionContract,
} from './completion-contract.ts';

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
   * The ROLES this step depends on, as ADDITIONAL forward edges.
   *
   * B4.2a: an explicit `[]` does NOT declare a business dependency, but it does NOT mean
   * "no execution dependency" either — a plan-file step list is a sequential workflow, so
   * the ordered chain is always appended (see `chainDependencies`). Omitted means the same
   * as `[]`: only the chain applies.
   */
  readonly dependencies?: readonly string[];
  /**
   * P0-1: the typed COMPLETION CONTRACT this step's task must prove before `pass`.
   *
   * REQUIRED for a coding step (`implementation`/`test`) — the parser refuses one that
   * omits it, so a governed coding task can never be built without a contract. Optional
   * for `research`/`review`, which keep their original acceptance semantics.
   */
  readonly completion?: CompletionContract;
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

/**
 * The EFFECTIVE role dependencies of a plan, in step order.
 *
 * B4.2a: a plan-file step list is a SEQUENTIAL workflow, so every step after the first
 * carries the step before it as a dependency. This is what makes `PARALLEL_WRITE=CLOSED`
 * true for a user plan: two steps that declare `dependencies: []` (independent BUSINESS
 * work) are still ordered for EXECUTION, so only one writer is ever ready and the
 * resource gate can admit it. Without this, both steps are ready in the same tick, the
 * shared non-git workspace cannot isolate two writers, and both are refused with
 * `resource-unavailable` — parsed, committed and assigned, then nothing runs.
 *
 * A step's DECLARED `dependencies` are ADDITIONAL forward edges layered on top of the
 * chain; they are preserved, never removed. The chain edge is added to the graph BEFORE
 * validation, so a declared backward edge that would close a loop through the chain
 * (e.g. step 1 depending on step 2) is refused as a cycle before anything is written.
 */
export function chainDependencies(steps: readonly PlanFileStep[]): readonly (readonly string[])[] {
  const out: string[][] = [];
  for (let i = 0; i < steps.length; i++) {
    const declared = steps[i]!.dependencies ?? [];
    if (i === 0) { out.push([...declared]); continue; }
    // Deduplicate so a step that also declares the previous one explicitly does not
    // list it twice.
    out.push([...new Set([steps[i - 1]!.role, ...declared])]);
  }
  return out;
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
  // P0-1: the typed completion contract. A coding step MUST declare it (all three
  // fields); a partial declaration on any step is a refusal, never silently ignored.
  const taskType = taskTypeRaw as TaskType;
  let completion: CompletionContract | undefined;
  const declared = hasAnyCompletionField(raw);
  if (isCodingTaskType(taskType) || declared) {
    try {
      completion = parseCompletionContract(
        { expectedArtifacts: raw.expectedArtifacts, allowedScope: raw.allowedScope, test: raw.test },
        where,
      );
    } catch (e) {
      if (e instanceof CompletionContractError) throw new PlanFileError(e.code, e.detail);
      throw e;
    }
  }
  return Object.freeze({
    role,
    taskType,
    ...(fileScope === undefined ? {} : { fileScope }),
    deliverable,
    ...(dependencies === undefined ? {} : { dependencies: Object.freeze([...dependencies]) }),
    ...(completion === undefined ? {} : { completion }),
  });
}

/**
 * Reject a role graph that cannot be committed: a dependency on a role that does not
 * exist, a self-dependency, or a cycle. This runs BEFORE any task is written, and the
 * same graph is re-checked by `validateCandidateDag` after ids are assigned.
 *
 * B4.2a: the CYCLE check runs on the EFFECTIVE graph (`chainDependencies`), not on the
 * declared edges alone — otherwise an explicit backward edge that only loops once the
 * sequential chain is added would pass here and fail later (or, worse, be dispatched).
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
  // Cycle detection over the EFFECTIVE role graph (declared edges + the sequential chain).
  const effective = chainDependencies(steps);
  const byRole = new Map(steps.map((s, i) => [s.role, effective[i]!]));
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (role: string, path: string[]): void => {
    if (done.has(role)) return;
    if (visiting.has(role)) {
      throw new PlanFileError('dependency-cycle', `${where}: cycle ${[...path, role].join(' -> ')}`);
    }
    visiting.add(role);
    for (const dep of byRole.get(role) ?? []) visit(dep, [...path, role]);
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

/** Resolve each step's EFFECTIVE dependencies to task ids (roles -> ids). */
function dependenciesFor(steps: readonly PlanFileStep[], ids: readonly string[]): readonly string[][] {
  const roleIndex = new Map(steps.map((s, i) => [s.role, i]));
  const effective = chainDependencies(steps);
  return effective.map((deps) => deps.map((r) => ids[roleIndex.get(r)!]!));
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
      (s.fileScope === undefined ? '' : ` — file scope: ${s.fileScope}`) +
      (s.completion === undefined ? '' : ` — approved test: ${s.completion.test.executable} ${s.completion.test.argv.join(' ')} (cwd ${s.completion.test.cwd})`),
    dependencies: Object.freeze([...deps[i]!]),
    requiredTaskTypes: Object.freeze([s.taskType]),
    ...(s.completion === undefined ? {} : { completion: s.completion }),
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
      `deliverable: ${m.deliverable} — do not implement the other members' scopes` +
      (m.completion === undefined ? '' : ` — approved test: ${m.completion.test.executable} ${m.completion.test.argv.join(' ')} (cwd ${m.completion.test.cwd})`),
    dependencies: Object.freeze([...deps[i]!]),
    requiredTaskTypes: Object.freeze([m.taskType]),
    ...(m.completion === undefined ? {} : { completion: m.completion }),
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
