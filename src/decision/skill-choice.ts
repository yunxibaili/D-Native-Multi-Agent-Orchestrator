/**
 * decision/skill-choice.ts — B3.1: LAYA picks AT MOST ONE advisory skill for a task.
 *
 * REUSE, NOT A SECOND BRAIN
 * -------------------------
 * Exactly like `plan-choice.ts` is a preset over the existing Decision Layer, this is a
 * preset over the SAME `DecisionProvider` / `DecisionRequest` / `DecisionQuestion` /
 * `DecisionResponse`. It adds no provider, no planner and no router. The bounded candidates
 * come from the user-declared skill catalogue, and LAYA only chooses among them — or says
 * explicitly that no skill is requested.
 *
 * THE ANSWER SPACE IS THE OFFERED LIST, PLUS AN EXPLICIT NONE
 * ----------------------------------------------------------
 * The offered keys are a reserved no-skill key plus every candidate name, and the answer is
 * checked against that same list on the way back, so a provider cannot name a skill that was
 * never on the table. The no-skill key uses a character that a native skill name can never
 * contain, so a declared skill can never collide with it.
 *
 * A skill choice is ADVISORY. It never selects, reroutes or authorizes an agent or a model,
 * and it is never a required-skill semantic.
 */

import { DecisionInputError, DecisionSchemaError } from './errors.ts';
import type { DecisionProvider, DecisionQuestion, DecisionRequest, DecisionResponse } from './types.ts';

/** The one question id this preset asks, and reads its answer back under. */
export const SKILL_CHOICE_ID = 'skill_choice';

/**
 * The explicit "request no skill" choice key.
 *
 * It deliberately contains underscores, which the native lowercase-alnum-hyphen skill-name
 * vocabulary cannot contain, so a declared skill can never share this key.
 */
export const SKILL_NONE_KEY = '__no_skill__';

/** One advisory skill candidate, as the decision layer sees it. */
export interface SkillChoiceCandidate {
  readonly name: string;
  /** One-line description, used as the choice criterion text. */
  readonly description: string;
}

/** What LAYA is told about the task it is choosing a skill for. */
export interface SkillChoiceTaskFacts {
  readonly taskId: string;
  readonly objective: string;
  readonly role?: string;
  readonly taskType?: string;
  readonly acceptanceCriteria?: string;
  /** The agent/model the skill would be requested for — context, never a reroute. */
  readonly agentId: string;
  readonly modelId: string | null;
}

export interface SkillChoiceRequestInput {
  readonly task: SkillChoiceTaskFacts;
  readonly candidates: readonly SkillChoiceCandidate[];
}

/** Every key the answer may name: the explicit none plus each candidate. */
export function offeredSkillChoiceKeys(candidates: readonly SkillChoiceCandidate[]): readonly string[] {
  return [SKILL_NONE_KEY, ...candidates.map((c) => c.name)];
}

export function skillChoiceQuestions(
  candidates: readonly SkillChoiceCandidate[],
): Readonly<Record<string, DecisionQuestion>> {
  const criteria: Record<string, string> = {
    [SKILL_NONE_KEY]: 'No skill: proceed without requesting any skill.',
  };
  for (const c of candidates) criteria[c.name] = c.description;
  return {
    [SKILL_CHOICE_ID]: {
      type: 'choice',
      instructions:
        'Choose AT MOST ONE advisory skill to request for this task, or choose the explicit ' +
        'no-skill option. Answer with exactly one offered option: you are choosing among the ' +
        'offered skills, not inventing one, and the request is advisory only.',
      criteria,
    },
  };
}

export function buildSkillChoiceRequest(input: SkillChoiceRequestInput): DecisionRequest {
  const { task } = input;
  return {
    questions: skillChoiceQuestions(input.candidates),
    task: task.objective,
    context: {
      phase: 'skill-choice',
      taskId: task.taskId,
      ...(task.role === undefined ? {} : { role: task.role }),
      ...(task.taskType === undefined ? {} : { taskType: task.taskType }),
      ...(task.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: task.acceptanceCriteria }),
      agentId: task.agentId,
      modelId: task.modelId ?? '',
    },
    state: {
      phase: 'skill-choice',
      candidates: input.candidates.map((c) => c.name).join('\n'),
    },
  };
}

/**
 * Ask the provider which skill to request.
 *
 * REUSES the seam, including its rule that a provider which cannot decide MUST throw: this
 * never invents a skill and never falls back to a default when the provider fails. The
 * caller handles a throw or an unusable answer as a refusal and MUST NOT dispatch.
 */
export async function decideSkillChoice(
  provider: DecisionProvider,
  input: SkillChoiceRequestInput,
): Promise<string | null> {
  if (input.candidates.length === 0) {
    throw new DecisionInputError('a skill choice needs at least one offered candidate');
  }
  const response: DecisionResponse = await provider.decide(buildSkillChoiceRequest(input));
  return readSkillChoice(response, input.candidates);
}

/**
 * Map the provider's answer back to a skill name (or `null` for the explicit none), proving
 * it names something that was offered.
 */
export function readSkillChoice(
  response: DecisionResponse,
  candidates: readonly SkillChoiceCandidate[],
): string | null {
  const answer = response.answers[SKILL_CHOICE_ID];
  if (answer === undefined) {
    throw new DecisionSchemaError(`the skill-choice answer did not include "${SKILL_CHOICE_ID}"`);
  }
  if (answer.type !== 'choice') {
    throw new DecisionSchemaError(`the skill-choice answer must be a "choice", got "${answer.type}"`);
  }
  const choice = answer.choice;
  if (typeof choice !== 'string' || choice.trim() === '') {
    throw new DecisionSchemaError(`the skill-choice answer must be one choice key, got ${JSON.stringify(choice)}`);
  }
  if (choice === SKILL_NONE_KEY) return null;
  if (!candidates.some((c) => c.name === choice)) {
    throw new DecisionSchemaError(`the skill-choice answer "${choice}" is not one of the offered skills`);
  }
  return choice;
}
