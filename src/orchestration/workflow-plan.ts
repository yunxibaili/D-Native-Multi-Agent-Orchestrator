/**
 * src/orchestration/workflow-plan.ts — B4.0 bounded heterogeneous workflow plans.
 *
 * ============================================================================
 * WHAT THIS IS
 * ============================================================================
 * A SMALL, fixed set of candidate plans for the sequential heterogeneous workflow
 * (research → implementation → test). Each plan is a chain of candidate tasks with
 * DIFFERENT `taskType`s and REAL dependencies, expressed in the EXISTING
 * `CandidateTask` shape so it flows through the SAME `validateCandidateDag` /
 * `commitPlan` write path as every other plan.
 *
 * It is deliberately NOT a planner, a router, a template engine or a second DAG
 * authority: it is a pure value module. LAYA picks WHICH bounded plan (see
 * `decision/plan-choice.ts`); the existing Planner/TaskStore/Assignment/Scheduler
 * do the rest. Nothing here names an agent or a model.
 *
 * WHY A FIXED SET (and not free-form generation)
 * ----------------------------------------------
 * The round rule is "offer a few valid candidates, do not ask a model to emit an
 * arbitrary JSON DAG". Two bounded plans keep the choice real while every candidate
 * is provably valid before it is offered.
 *
 * WRITE SCOPE: the plan is SEQUENTIAL (each step depends on the one before), which is
 * exactly what `PARALLEL_WRITE=CLOSED` requires for writing work. Nothing here opens
 * parallel writes.
 */

import type { TaskType } from '../quota/types.ts';
import type { CandidateTask } from './planner.ts';
// B4.2: the ONE candidate-formatting rule, shared with the user's plan file so a built-in
// plan and a file plan produce byte-identical task descriptions.
import { buildSequentialStepCandidates } from './plan-file.ts';

export const HETEROGENEOUS_WORKFLOW_CHOICES = ['full', 'lean'] as const;
export type HeterogeneousWorkflowChoice = (typeof HETEROGENEOUS_WORKFLOW_CHOICES)[number];

export interface WorkflowStep {
  /** The responsibility label. A TAG only — it never selects an agent or grants rights. */
  readonly role: string;
  /** The EXISTING task type the step runs as. */
  readonly taskType: TaskType;
  /** What this step must produce, rendered into its acceptance criteria. */
  readonly deliverable: string;
}

export interface WorkflowPlanChoice {
  readonly choice: HeterogeneousWorkflowChoice;
  /** One-line description shown to LAYA when it picks among the candidates. */
  readonly label: string;
  readonly steps: readonly WorkflowStep[];
}

/**
 * The bounded candidate plans. Order is stable so a single-candidate fallback and a
 * LAYA choice are both deterministic.
 */
export const WORKFLOW_PLAN_CHOICES: readonly WorkflowPlanChoice[] = Object.freeze([
  Object.freeze({
    choice: 'full',
    label: 'research, then implementation, then test',
    steps: Object.freeze([
      Object.freeze({ role: 'research', taskType: 'research', deliverable: 'a bounded findings note (sources kept)' }),
      Object.freeze({ role: 'implementation', taskType: 'implementation', deliverable: 'the change, with the files it touched' }),
      Object.freeze({ role: 'test', taskType: 'test', deliverable: 'the tests run and their outcome' }),
    ]),
  }),
  Object.freeze({
    choice: 'lean',
    label: 'implementation, then test (research skipped)',
    steps: Object.freeze([
      Object.freeze({ role: 'implementation', taskType: 'implementation', deliverable: 'the change, with the files it touched' }),
      Object.freeze({ role: 'test', taskType: 'test', deliverable: 'the tests run and their outcome' }),
    ]),
  }),
]);

export function isWorkflowChoice(value: string): value is HeterogeneousWorkflowChoice {
  return (HETEROGENEOUS_WORKFLOW_CHOICES as readonly string[]).includes(value);
}

/** The bounded plan for a choice, or a refusal — never a silent default. */
export function workflowPlanFor(choice: string): WorkflowPlanChoice {
  const plan = WORKFLOW_PLAN_CHOICES.find((c) => c.choice === choice);
  if (plan === undefined) {
    throw new Error(`unknown workflow plan "${choice}"; known: ${HETEROGENEOUS_WORKFLOW_CHOICES.join(', ')}`);
  }
  return plan;
}

/**
 * Build the candidate tasks for one bounded plan.
 *
 * A strict CHAIN: step N depends on step N-1, so the existing scheduler admits a
 * downstream step only after the upstream one is a satisfied dependency. Task ids are
 * derived from the root (never a clock), so the same plan for the same root is
 * reproducible.
 */
export function buildWorkflowCandidates(
  choice: HeterogeneousWorkflowChoice,
  objective: string,
  rootTaskId: string,
  generation = 0,
): CandidateTask[] {
  const plan = workflowPlanFor(choice);
  void generation;
  // B4.2: delegate to the shared builder so a built-in plan and a user plan file cannot
  // drift apart. The built-in steps carry no `fileScope`, so the rendered description is
  // byte-identical to before.
  return buildSequentialStepCandidates(
    plan.steps.map((s) => ({ role: s.role, taskType: s.taskType, deliverable: s.deliverable })),
    objective,
    rootTaskId,
  );
}
