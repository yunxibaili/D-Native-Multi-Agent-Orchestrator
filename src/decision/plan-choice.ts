/**
 * decision/plan-choice.ts — B4.0: LAYA picks WHICH bounded workflow plan to run.
 *
 * REUSE, NOT A SECOND BRAIN
 * -------------------------
 * Exactly like `initial-assignment.ts` is a preset over the existing Decision Layer,
 * this is a preset over the SAME `DecisionProvider` / `DecisionRequest` /
 * `DecisionQuestion` / `DecisionResponse`. It adds no provider, no planner and no
 * router, and it does not build a DAG — the bounded candidate plans come from
 * `orchestration/workflow-plan.ts` and LAYA only chooses among them.
 *
 * THE ANSWER SPACE IS THE OFFERED PLAN LIST
 * -----------------------------------------
 * The choice keys are the offered plan choices, and the answer is checked against
 * that same list on the way back, so a provider cannot name a plan that was never on
 * the table. Whether a chosen plan is runnable is not decided here.
 */

import { DecisionSchemaError } from './errors.ts';
import type { DecisionProvider, DecisionQuestion, DecisionRequest, DecisionResponse } from './types.ts';

/** The one question id this preset asks, and reads its answer back under. */
export const WORKFLOW_PLAN_ID = 'workflow_plan';

/** One bounded plan LAYA may choose, as the decision layer sees it. */
export interface WorkflowPlanCandidate {
  readonly choice: string;
  /** One-line description of the plan, used as the choice criterion text. */
  readonly label: string;
  /** The step roles, in order, for the criterion text. */
  readonly roles: readonly string[];
}

/** What LAYA is told about the goal it is choosing a plan for. */
export interface WorkflowPlanTaskFacts {
  readonly taskId: string;
  readonly objective: string;
}

export function workflowPlanQuestions(
  candidates: readonly WorkflowPlanCandidate[],
): Readonly<Record<string, DecisionQuestion>> {
  const criteria: Record<string, string> = {};
  for (const c of candidates) {
    criteria[c.choice] = `${c.label} (steps: ${c.roles.join(' -> ')})`;
  }
  return {
    [WORKFLOW_PLAN_ID]: {
      type: 'choice',
      instructions:
        'Choose ONE bounded workflow plan for this goal. Answer with exactly one option: ' +
        'you are selecting among the offered plans, not inventing a new one.',
      criteria,
    },
  };
}

export function buildWorkflowPlanRequest(input: {
  task: WorkflowPlanTaskFacts;
  candidates: readonly WorkflowPlanCandidate[];
}): DecisionRequest {
  return {
    questions: workflowPlanQuestions(input.candidates),
    task: input.task.objective,
    context: { phase: 'workflow-plan', taskId: input.task.taskId },
    state: {
      phase: 'workflow-plan',
      candidates: input.candidates.map((c) => c.choice).join('\n'),
    },
  };
}

/**
 * Ask the provider which plan to use.
 *
 * REUSES the seam, including its rule that a provider which cannot decide MUST
 * throw: this never invents a plan and never falls back to a default when the
 * provider fails. (The caller handles a single offered candidate WITHOUT asking —
 * see `readWorkflowPlan`'s use in the round CLI.)
 */
export async function decideWorkflowPlan(
  provider: DecisionProvider,
  input: { task: WorkflowPlanTaskFacts; candidates: readonly WorkflowPlanCandidate[] },
): Promise<string> {
  const response: DecisionResponse = await provider.decide(buildWorkflowPlanRequest(input));
  return readWorkflowPlan(response, input.candidates);
}

/** Map the provider's answer back to a choice, proving it names something offered. */
export function readWorkflowPlan(
  response: DecisionResponse,
  candidates: readonly WorkflowPlanCandidate[],
): string {
  const answer = response.answers[WORKFLOW_PLAN_ID];
  if (answer === undefined) {
    throw new DecisionSchemaError(`the workflow-plan answer did not include "${WORKFLOW_PLAN_ID}"`);
  }
  if (answer.type !== 'choice') {
    throw new DecisionSchemaError(`the workflow-plan answer must be a "choice", got "${answer.type}"`);
  }
  const choice = answer.choice;
  if (typeof choice !== 'string' || choice.trim() === '') {
    throw new DecisionSchemaError(`the workflow-plan answer must be one choice key, got ${JSON.stringify(choice)}`);
  }
  if (!candidates.some((c) => c.choice === choice)) {
    throw new DecisionSchemaError(`the workflow-plan answer "${choice}" is not one of the offered plans`);
  }
  return choice;
}
