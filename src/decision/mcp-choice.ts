/**
 * decision/mcp-choice.ts — B3.2: LAYA picks AT MOST ONE advisory native MCP tool for a task.
 *
 * REUSE, NOT A SECOND BRAIN
 * -------------------------
 * Exactly like `skill-choice.ts` is a preset over the existing Decision Layer, this is a
 * preset over the SAME `DecisionProvider` / `DecisionRequest` / `DecisionQuestion` /
 * `DecisionResponse`. It adds no provider, no planner and no router. The bounded candidates
 * come from the user-declared MCP catalogue, and LAYA only chooses among them — or says
 * explicitly that no tool is requested.
 *
 * THE ANSWER SPACE IS THE OFFERED LIST, PLUS AN EXPLICIT NONE
 * ----------------------------------------------------------
 * The offered keys are a reserved no-tool key plus every candidate's native name, and the
 * answer is checked against that same list on the way back, so a provider cannot name a tool
 * that was never on the table. The no-tool key contains ":", a character the native
 * sanitized mapping can never produce, so a declared tool can never collide with it.
 *
 * The criteria map is built on a NULL prototype, because a native name may be a
 * prototype-like string such as "constructor" or "__proto__".
 *
 * A tool choice is ADVISORY. It never connects/installs/authorizes a server, never selects,
 * reroutes or authorizes an agent or a model, and it never limits the agent's native tools.
 */

import { DecisionInputError, DecisionSchemaError } from './errors.ts';
import type { DecisionProvider, DecisionQuestion, DecisionRequest, DecisionResponse } from './types.ts';

/** The one question id this preset asks, and reads its answer back under. */
export const MCP_CHOICE_ID = 'mcp_tool_choice';

/**
 * The explicit "request no MCP tool" choice key.
 *
 * It contains ":", which the native `[a-zA-Z0-9_-]` sanitized vocabulary cannot produce, so a
 * declared native tool name can never share this key.
 */
export const MCP_NONE_KEY = '::none::';

/** One advisory MCP tool candidate, as the decision layer sees it. */
export interface McpChoiceCandidate {
  /** The native tool name, used as the choice key. Unique within one catalogue. */
  readonly nativeName: string;
  readonly server: string;
  readonly tool: string;
  /** One-line description, used as the choice criterion text. */
  readonly description: string;
}

/** What LAYA is told about the task it is choosing a tool for. */
export interface McpChoiceTaskFacts {
  readonly taskId: string;
  readonly objective: string;
  readonly role?: string;
  readonly taskType?: string;
  /** The agent/model the tool would be requested for — context, never a reroute. */
  readonly agentId: string;
  readonly modelId: string | null;
}

export interface McpChoiceRequestInput {
  readonly task: McpChoiceTaskFacts;
  readonly candidates: readonly McpChoiceCandidate[];
}

/** Every key the answer may name: the explicit none plus each candidate's native name. */
export function offeredMcpChoiceKeys(candidates: readonly McpChoiceCandidate[]): readonly string[] {
  return [MCP_NONE_KEY, ...candidates.map((c) => c.nativeName)];
}

export function mcpChoiceQuestions(
  candidates: readonly McpChoiceCandidate[],
): Readonly<Record<string, DecisionQuestion>> {
  // A NULL prototype, so a candidate named "constructor"/"__proto__" is an ordinary own key
  // rather than a prototype accessor.
  const criteria: Record<string, string> = Object.create(null) as Record<string, string>;
  criteria[MCP_NONE_KEY] = 'No MCP tool: proceed without requesting any native MCP tool.';
  for (const c of candidates) criteria[c.nativeName] = `${c.server}/${c.tool}: ${c.description}`;
  return {
    [MCP_CHOICE_ID]: {
      type: 'choice',
      instructions:
        'Choose AT MOST ONE advisory native MCP tool to request for this task, or choose the ' +
        'explicit no-tool option. Answer with exactly one offered option: you are choosing among ' +
        'the offered tools, not inventing one, and the request is advisory only.',
      criteria,
    },
  };
}

export function buildMcpChoiceRequest(input: McpChoiceRequestInput): DecisionRequest {
  const { task } = input;
  // The full acceptance criteria is carried ONCE, as the task text; it is not repeated in
  // every context field.
  return {
    questions: mcpChoiceQuestions(input.candidates),
    task: task.objective,
    context: {
      phase: 'mcp-choice',
      taskId: task.taskId,
      ...(task.role === undefined ? {} : { role: task.role }),
      ...(task.taskType === undefined ? {} : { taskType: task.taskType }),
      agentId: task.agentId,
      modelId: task.modelId ?? '',
    },
    state: {
      phase: 'mcp-choice',
      candidates: input.candidates.map((c) => c.nativeName).join('\n'),
    },
  };
}

/**
 * Ask the provider which native MCP tool to request.
 *
 * REUSES the seam, including its rule that a provider which cannot decide MUST throw: this
 * never invents a tool and never falls back to a default when the provider fails. The caller
 * handles a throw or an unusable answer as a refusal and MUST NOT dispatch.
 */
export async function decideMcpChoice(
  provider: DecisionProvider,
  input: McpChoiceRequestInput,
): Promise<McpChoiceCandidate | null> {
  if (input.candidates.length === 0) {
    throw new DecisionInputError('an mcp tool choice needs at least one offered candidate');
  }
  const response: DecisionResponse = await provider.decide(buildMcpChoiceRequest(input));
  return readMcpChoice(response, input.candidates);
}

/**
 * Map the provider's answer back to a candidate (or `null` for the explicit none), proving it
 * names something that was offered.
 */
export function readMcpChoice(
  response: DecisionResponse,
  candidates: readonly McpChoiceCandidate[],
): McpChoiceCandidate | null {
  const answer = response.answers[MCP_CHOICE_ID];
  if (answer === undefined) {
    throw new DecisionSchemaError(`the mcp-choice answer did not include "${MCP_CHOICE_ID}"`);
  }
  if (answer.type !== 'choice') {
    throw new DecisionSchemaError(`the mcp-choice answer must be a "choice", got "${answer.type}"`);
  }
  const choice = answer.choice;
  if (typeof choice !== 'string' || choice.trim() === '') {
    throw new DecisionSchemaError(`the mcp-choice answer must be one choice key, got ${JSON.stringify(choice)}`);
  }
  if (choice === MCP_NONE_KEY) return null;
  const found = candidates.find((c) => c.nativeName === choice);
  if (found === undefined) {
    throw new DecisionSchemaError(`the mcp-choice answer "${choice}" is not one of the offered tools`);
  }
  return found;
}
