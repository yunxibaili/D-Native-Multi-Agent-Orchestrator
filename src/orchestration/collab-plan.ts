/**
 * src/orchestration/collab-plan.ts — B4.1 bounded collaboration-group plans (功能 B).
 *
 * ============================================================================
 * WHAT THIS IS
 * ============================================================================
 * A SMALL, fixed set of candidate plans for "one goal, 2–3 models building it
 * together" (BACKEND_REQUIREMENTS §16.2). Each plan is a set of candidate tasks in
 * the EXISTING `CandidateTask` shape, so it flows through the SAME
 * `validateCandidateDag` / `commitPlan` write path, the SAME Assignment, the SAME
 * SessionRegistry / WorkerIdentity / Attempt / Verification chain as every other
 * plan in this project.
 *
 * It is NOT a TeamStore, a WorkerManager, a second DAG, a scheduler, a runtime or a
 * task state machine — none of those exist here. It is a pure value module, exactly
 * like `workflow-plan.ts`, and it names NO agent and NO model: LAYA picks the plan
 * (`decision/plan-choice.ts`) and then picks each member's concrete Agent × Model
 * through the EXISTING `decision/initial-assignment.ts` seam.
 *
 * TOPOLOGY — WHY IT IS A CHAIN PLUS ONE INTEGRATION TASK
 * ------------------------------------------------------
 * `PARALLEL_WRITE` is CLOSED. Members do writing work, so they are ordered: member
 * N depends on member N-1. The integration task depends on ALL members, which is
 * what makes the handoff real — `workbench.briefFor` builds a brief from the
 * DIRECT dependencies' own RunResults, so an integration task with every member as
 * a dependency receives every member's delivery, and is admissible only once every
 * one of them is `succeeded` (i.e. explicitly accepted by the existing
 * Verification authority). A member that failed, is unverified or produced no
 * delivery therefore blocks integration structurally, not by a special case.
 *
 * THE INTEGRATOR IS A MEMBER, NOT A FOURTH MODEL
 * ----------------------------------------------
 * `integratorMember` is a 1-based index into `members`. The integration task is a
 * separate child task (so it gets its own session, attempt and evidence) but the
 * pair it runs on is the INTEGRATOR MEMBER'S OWN pair, recorded through the same
 * `initialSelections` authority that member used. No collaboration plan can
 * therefore quietly add a model nobody chose.
 *
 * FILE SCOPE IS A SCOPE STATEMENT, NOT ISOLATION
 * ----------------------------------------------
 * `fileScope` is rendered into each member's acceptance criteria so the division
 * of labour is part of what Verification checks and what the report shows. It is
 * NOT an enforced boundary: the enforced boundary remains Workspace +
 * ResourceClaim + the sequential execution order. Nothing here claims isolation.
 */

import type { TaskType } from '../quota/types.ts';
import type { CandidateTask } from './planner.ts';

export const COLLABORATION_CHOICES = ['duo', 'trio'] as const;
export type CollaborationChoice = (typeof COLLABORATION_CHOICES)[number];

/** REQ-14: 2–3 models. A "1" or a "4" is not a collaboration group. */
export const COLLABORATION_MIN_MEMBERS = 2;
export const COLLABORATION_MAX_MEMBERS = 3;

export interface CollaborationMemberSpec {
  /** The responsibility label. A TAG only — it never selects an agent or grants rights. */
  readonly role: string;
  /** The EXISTING task type this member runs as. */
  readonly taskType: TaskType;
  /**
   * The files this member owns. Rendered into its acceptance criteria, so it is
   * checked and reported; it is NOT a sandbox and NOT a resource claim.
   */
  readonly fileScope: string;
  /** What this member must produce, and what downstream may rely on. */
  readonly deliverable: string;
}

export interface CollaborationPlanChoice {
  readonly choice: CollaborationChoice;
  /** One-line description shown to LAYA when it picks among the candidates. */
  readonly label: string;
  readonly members: readonly CollaborationMemberSpec[];
  /**
   * Which member (1-based) carries INTEGRATION RESPONSIBILITY. Its pair is reused
   * by the integration task; no fourth model is introduced for it.
   */
  readonly integratorMember: number;
}

/**
 * The bounded candidate plans. Order is stable so a single-candidate fallback and a
 * LAYA choice are both deterministic. `duo` and `trio` are the whole answer space
 * for this slice — the round rule is "offer valid candidates, do not ask a model to
 * emit an arbitrary DAG".
 */
export const COLLABORATION_PLAN_CHOICES: readonly CollaborationPlanChoice[] = Object.freeze([
  Object.freeze({
    choice: 'duo',
    label: 'two models build the goal together, one of them integrates',
    members: Object.freeze([
      Object.freeze({
        role: 'provider',
        taskType: 'implementation',
        fileScope: 'src/provider/**',
        deliverable: 'the provider-side change, with the files it touched',
      }),
      Object.freeze({
        role: 'consumer',
        taskType: 'implementation',
        fileScope: 'src/consumer/**',
        deliverable: 'the consumer-side change, with the files it touched',
      }),
    ]),
    integratorMember: 1,
  }),
  Object.freeze({
    choice: 'trio',
    label: 'three models build the goal together, the middle one integrates',
    members: Object.freeze([
      Object.freeze({
        role: 'core',
        taskType: 'implementation',
        fileScope: 'src/core/**',
        deliverable: 'the core change, with the files it touched',
      }),
      Object.freeze({
        role: 'cli',
        taskType: 'implementation',
        fileScope: 'src/cli/**',
        deliverable: 'the CLI change, with the files it touched',
      }),
      Object.freeze({
        role: 'checks',
        taskType: 'test',
        fileScope: 'tests/**',
        deliverable: 'the tests that cover the other members\' scopes, and their outcome',
      }),
    ]),
    integratorMember: 2,
  }),
]);

export function isCollaborationChoice(value: string): value is CollaborationChoice {
  return (COLLABORATION_CHOICES as readonly string[]).includes(value);
}

/** The bounded plan for a choice, or a refusal — never a silent default. */
export function collaborationPlanFor(choice: string): CollaborationPlanChoice {
  const plan = COLLABORATION_PLAN_CHOICES.find((c) => c.choice === choice);
  if (plan === undefined) {
    throw new Error(`unknown collaboration plan "${choice}"; known: ${COLLABORATION_CHOICES.join(', ')}`);
  }
  return plan;
}

/** The task ids a plan produces, in execution order (members, then the integrator). */
export interface CollaborationTaskIds {
  readonly memberIds: readonly string[];
  readonly integratorId: string;
  /** Which member's pair the integration task reuses (1-based index into `memberIds`). */
  readonly integratorIndex: number;
}

export function collaborationTaskIds(choice: CollaborationChoice, rootTaskId: string): CollaborationTaskIds {
  const plan = collaborationPlanFor(choice);
  const memberIds = plan.members.map((_, i) => `${rootTaskId}-m${i + 1}`);
  return {
    memberIds: Object.freeze([...memberIds]),
    integratorId: `${rootTaskId}-int`,
    integratorIndex: plan.integratorMember,
  };
}

/**
 * Build the candidate tasks for one bounded collaboration plan.
 *
 * Task ids derive from the root (never a clock), so the same plan for the same root
 * is reproducible. Members are a CHAIN (sequential writes); the integration task
 * depends on every member, which is what makes "integration actually consumed the
 * deliveries" a property of the graph rather than a claim about the report.
 */
export function buildCollaborationCandidates(
  choice: CollaborationChoice,
  objective: string,
  rootTaskId: string,
): CandidateTask[] {
  const plan = collaborationPlanFor(choice);
  const { memberIds, integratorId, integratorIndex } = collaborationTaskIds(choice, rootTaskId);
  const members = plan.members.map((spec, i) => Object.freeze({
    taskId: memberIds[i]!,
    parentTaskId: rootTaskId,
    taskType: spec.taskType,
    // The description BECOMES the acceptance criteria on commit, so role, file scope
    // and required deliverable are what Verification checks — not report-only labels.
    description:
      `${objective} :: collaborator ${i + 1} (${spec.role}) — file scope: ${spec.fileScope} — ` +
      `deliverable: ${spec.deliverable} — do not implement the other members' scopes`,
    // Sequential write order: PARALLEL_WRITE=CLOSED, so N waits for N-1.
    dependencies: Object.freeze(i === 0 ? [] : [memberIds[i - 1]!]),
    requiredTaskTypes: Object.freeze([spec.taskType]),
  }));
  const integrator = Object.freeze({
    taskId: integratorId,
    parentTaskId: rootTaskId,
    taskType: 'implementation' as const,
    description:
      `${objective} :: integration (collaborator ${integratorIndex} carries integration responsibility) — ` +
      `deliverable: one combined result built from the deliveries listed in this task's handoffs, ` +
      `naming each collaborator's actual contribution — a summary of what everyone finished is NOT a deliverable`,
    // EVERY member, so the brief carries every delivery and every member must be
    // `succeeded` before this task is even admissible.
    dependencies: Object.freeze([...memberIds]),
    requiredTaskTypes: Object.freeze(['implementation'] as const),
  });
  return [...members, integrator];
}
