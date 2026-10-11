/**
 * decision/execution-topology.ts — TeamRun T3-a.1: Laya's execution TOPOLOGY choice.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * T2 made Laya name the Agent × Model for a task. T3 needs Laya to say HOW the logical task
 * is executed: by ONE worker (SOLO) or by SEVERAL independent READ workers
 * (PARALLEL_READ). That is an execution decision, so it belongs to Laya — not to the
 * Planner (which owns decomposition) and not to Assignment (which only answers
 * "is this pair admissible?").
 *
 * REUSE, NOT A SECOND BRAIN
 * -------------------------
 * This is a PRESET over the existing Decision Layer, exactly like `routing.ts` and
 * `initial-assignment.ts`. It reuses `DecisionProvider`, `DecisionRequest`,
 * `DecisionQuestion` and `DecisionResponse`; it adds no provider and no router. It returns
 * the RAW member list; the orchestration side runs the typed validation
 * (`validateFanoutMembers` in `orchestration/fanout.ts`) so the dependency direction
 * (decision must not import orchestration) is preserved.
 *
 * NO TOPOLOGY MEANS SOLO
 * ----------------------
 * SOLO is the existing T2 shape and the default: a provider that has no topology opinion
 * (or an old provider that does not answer this question) must keep the single-worker path
 * byte-identical. Only an EXPLICIT `PARALLEL_READ` is validated strictly, and a malformed
 * PARALLEL_READ is refused — it must never silently degrade to SOLO.
 */

import { DecisionSchemaError } from './errors.ts';
import type { DecisionProvider, DecisionQuestion, DecisionRequest, DecisionResponse } from './types.ts';

/** The one question id this phase asks, and reads its answer back under. */
export const EXECUTION_TOPOLOGY_ID = 'execution_topology';

export const TOPOLOGY_SOLO = 'SOLO';
export const TOPOLOGY_PARALLEL_READ = 'PARALLEL_READ';

/** An offered READ candidate, so a real Laya chooses from what actually exists. */
export interface TopologyCandidate {
  readonly agentId: string;
  readonly modelId: string;
  readonly taskTypes: readonly string[];
  readonly available: boolean;
}

export interface TopologyRequestInput {
  readonly task: {
    readonly taskId: string;
    readonly objective: string;
    readonly taskType?: string;
    readonly acceptanceCriteria?: string;
  };
  /** READ-capable pairs offered to Laya for member selection. */
  readonly candidates: readonly TopologyCandidate[];
  /** Bounded width the caller will admit. */
  readonly maxMembers: number;
}

/** The RAW topology the provider named; members are validated orchestration-side. */
export type RawExecutionTopology =
  | { readonly kind: 'solo' }
  | { readonly kind: 'parallel_read'; readonly membersRaw: unknown };

export function executionTopologyQuestions(maxMembers: number): Readonly<Record<string, DecisionQuestion>> {
  return {
    [EXECUTION_TOPOLOGY_ID]: {
      type: 'choice',
      instructions:
        'Decide the execution topology for this task. SOLO = one worker does it (name the pair ' +
        'through the Agent x Model decision). PARALLEL_READ = several independent READ-only workers ' +
        `investigate it concurrently (2..${maxMembers} members, each an agentId+modelId+scope, ` +
        'supplied as JSON in parameters.members). READ only: no member may write.',
      criteria: {
        [TOPOLOGY_SOLO]: 'one worker executes this task (the existing single-worker path)',
        [TOPOLOGY_PARALLEL_READ]:
          `2..${maxMembers} independent READ-only workers investigate this task in parallel, each with its own pair and scope`,
      },
    },
  };
}

export function buildExecutionTopologyRequest(input: TopologyRequestInput): DecisionRequest {
  return {
    questions: executionTopologyQuestions(input.maxMembers),
    task: input.task.objective,
    context: {
      phase: 'execution-topology',
      taskId: input.task.taskId,
      ...(input.task.taskType === undefined ? {} : { taskType: input.task.taskType }),
    },
    state: {
      phase: 'execution-topology',
      maxMembers: String(input.maxMembers),
      readCandidates: input.candidates
        .map((c) => `${c.agentId}/${c.modelId}|${c.available ? 'available' : 'unavailable'}|${c.taskTypes.join(',')}`)
        .join('\n'),
    },
  };
}

/**
 * Ask the provider for the topology.
 *
 * Throws only for a TRANSPORT/contract failure (no answer, wrong answer type) — the caller
 * treats that as "no topology opinion" and keeps the SOLO path. A present but UNKNOWN choice,
 * or a malformed PARALLEL_READ, is a hard schema error the caller must NOT swallow into SOLO.
 */
export async function decideExecutionTopology(
  provider: DecisionProvider,
  input: TopologyRequestInput,
): Promise<RawExecutionTopology | null> {
  let response: DecisionResponse;
  try {
    response = await provider.decide(buildExecutionTopologyRequest(input));
  } catch {
    // No topology opinion; the caller keeps SOLO. This is the additive-seam case.
    return null;
  }
  const answer = response.answers[EXECUTION_TOPOLOGY_ID];
  if (answer === undefined) return null;
  if (answer.type !== 'choice') {
    throw new DecisionSchemaError(
      `the execution-topology answer must be a "choice", got "${answer.type}"`,
    );
  }
  const choice = answer.choice;
  if (choice === TOPOLOGY_SOLO) return { kind: 'solo' };
  if (choice === TOPOLOGY_PARALLEL_READ) {
    const raw = answer.parameters?.members;
    if (typeof raw !== 'string') {
      throw new DecisionSchemaError(
        'a PARALLEL_READ answer must carry parameters.members as a JSON string; it did not',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new DecisionSchemaError(`PARALLEL_READ parameters.members is not valid JSON: ${(e as Error).message}`);
    }
    return { kind: 'parallel_read', membersRaw: parsed };
  }
  throw new DecisionSchemaError(
    `unknown execution topology ${JSON.stringify(choice)}; expected ${TOPOLOGY_SOLO} or ${TOPOLOGY_PARALLEL_READ}`,
  );
}