/**
 * src/orchestration/skill-catalog.ts — B3.1: the bounded, USER-DECLARED native skill
 * CANDIDATE list, plus the ONE honest projection of a native skill-tool observation.
 *
 * ============================================================================
 * WHAT THIS IS
 * ============================================================================
 * A small JSON file in which the user declares, for ONE agent, a bounded list of skill
 * names and one-line descriptions the round MAY offer to the decision provider when it
 * picks at most one advisory skill per initially assigned task.
 *
 * It is a PURE VALUE module. It parses and validates; it never reads files, never writes a
 * task, never names a model, never invokes a model and never talks to an agent. It is
 * deliberately NOT a filesystem scanner, a YAML parser, a second registry, a config
 * platform, or a permission/authorization system.
 *
 * WHAT THE FILE MAY NOT DO
 * ------------------------
 *   - It may not carry paths, file content, shell commands, or permission/permission-like
 *     grants. Those are simply UNKNOWN KEYS and are rejected.
 *   - It may not exceed the bounds. A larger, malformed or wrong-typed file is REFUSED with
 *     a reason, never silently truncated or repaired.
 *
 * THE CANDIDATES ARE A DECLARATION, NOT PROOF
 * -------------------------------------------
 * A name here means "the user believes this skill may exist for the agent". It is NOT
 * discovery, and it is NOT proof the skill is installed. The agent owns its own discovery
 * and invocation; the round only ASKS. Every consumer must render it as a request.
 */

import type { RunResult, ToolCall } from '../core/types.ts';

// ---------------------------------------------------------------------------
// Bounds — named constants, not a configuration platform.
// ---------------------------------------------------------------------------

/** The raw file is rejected above this size, before it is parsed. */
export const SKILL_CATALOG_MAX_BYTES = 32 * 1024;
/** At most this many skill candidates may be declared for one agent. */
export const SKILL_CATALOG_MAX_ENTRIES = 16;
/** A skill name is capped; the native vocabulary is short. */
export const SKILL_CATALOG_MAX_NAME = 64;
/** A description is metadata for the selection question, capped so it cannot be an essay. */
export const SKILL_CATALOG_MAX_DESCRIPTION = 1024;
/** The agent id is an identifier, not free text. */
export const SKILL_CATALOG_MAX_AGENT_ID = 128;

/** The native skill-name shape: lowercase alphanumerics joined by single hyphens. */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ---------------------------------------------------------------------------
// The shape
// ---------------------------------------------------------------------------

export interface SkillCatalogEntry {
  readonly name: string;
  readonly description: string;
}

export interface SkillCatalog {
  /** The ONE agent these candidates are declared for. */
  readonly agentId: string;
  /** The offered candidates. An empty list is legal and means "offer nothing". */
  readonly skills: readonly SkillCatalogEntry[];
}

export class SkillCatalogError extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(code: string, detail: string) {
    super(`skill catalog refused [${code}]: ${detail}`);
    this.name = 'SkillCatalogError';
    this.code = code;
    this.detail = detail;
  }
}

export function isSkillCatalogError(value: unknown): value is SkillCatalogError {
  return value instanceof SkillCatalogError;
}

// ---------------------------------------------------------------------------
// Parsing + validation (total: every rejection names the offending field)
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function rejectUnknownKeys(raw: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new SkillCatalogError('unknown-key', `${where} has unknown key "${key}" (allowed: ${allowed.join(', ')})`);
    }
  }
}

function parseEntry(raw: unknown, where: string, seen: Set<string>): SkillCatalogEntry {
  if (!isRecord(raw)) throw new SkillCatalogError('invalid-entry', `${where} must be an object`);
  rejectUnknownKeys(raw, ['name', 'description'], where);
  const name = raw.name;
  if (typeof name !== 'string' || name === '') {
    throw new SkillCatalogError('invalid-name', `${where}.name must be a non-empty string`);
  }
  if (name.length > SKILL_CATALOG_MAX_NAME) {
    throw new SkillCatalogError('name-too-long', `${where}.name is ${name.length} chars, over the ${SKILL_CATALOG_MAX_NAME} limit`);
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new SkillCatalogError(
      'invalid-name-format',
      `${where}.name "${name}" is not a native skill name (lowercase letters, digits and single hyphens only)`,
    );
  }
  if (seen.has(name)) throw new SkillCatalogError('duplicate-name', `skill "${name}" is declared more than once`);
  seen.add(name);
  const description = raw.description;
  if (typeof description !== 'string') {
    throw new SkillCatalogError('invalid-description', `${where}.description must be a string`);
  }
  if (description.length > SKILL_CATALOG_MAX_DESCRIPTION) {
    throw new SkillCatalogError(
      'description-too-long',
      `${where}.description is ${description.length} chars, over the ${SKILL_CATALOG_MAX_DESCRIPTION} limit`,
    );
  }
  return Object.freeze({ name, description });
}

/**
 * Parse and validate a skill catalogue. Total and fail-closed: any violation throws a
 * `SkillCatalogError` naming the field, and nothing is defaulted or dropped.
 */
export function parseSkillCatalog(raw: unknown): SkillCatalog {
  if (!isRecord(raw)) throw new SkillCatalogError('invalid-root', 'the skill catalog must be a JSON object');
  rejectUnknownKeys(raw, ['agentId', 'skills'], 'skill catalog');
  const agentId = raw.agentId;
  if (typeof agentId !== 'string' || agentId.trim() === '') {
    throw new SkillCatalogError('invalid-agent-id', '"agentId" must be a non-empty string');
  }
  if (agentId.length > SKILL_CATALOG_MAX_AGENT_ID) {
    throw new SkillCatalogError('agent-id-too-long', `"agentId" is ${agentId.length} chars, over the ${SKILL_CATALOG_MAX_AGENT_ID} limit`);
  }
  if (!Array.isArray(raw.skills)) {
    throw new SkillCatalogError('invalid-skills', '"skills" must be an array');
  }
  if (raw.skills.length > SKILL_CATALOG_MAX_ENTRIES) {
    throw new SkillCatalogError('too-many-entries', `"skills" declares ${raw.skills.length} entries, over the ${SKILL_CATALOG_MAX_ENTRIES} limit`);
  }
  const seen = new Set<string>();
  const skills = raw.skills.map((entry, i) => parseEntry(entry, `skills[${i}]`, seen));
  return Object.freeze({ agentId, skills: Object.freeze(skills) });
}

// ---------------------------------------------------------------------------
// Native skill-tool observation — the only evidence this slice reads
// ---------------------------------------------------------------------------

/**
 * A completed native `skill` tool call, projected to the two facts worth reporting.
 *
 * The native call is accepted ONLY when all three hold: the tool NAME is exactly `skill`,
 * the structured `input` is an object carrying a string `name`, and the status is
 * `completed`. Text output, a pending/failed status, a malformed input, or any other tool
 * name is NOT a skill observation and is never upgraded into one.
 */
export interface NativeSkillCallObservation {
  /** The skill name the agent asked to load, from `input.name`. */
  readonly name: string;
  readonly callId: string | null;
}

export function observeNativeSkillCalls(toolCalls: readonly ToolCall[]): NativeSkillCallObservation[] {
  const out: NativeSkillCallObservation[] = [];
  for (const call of toolCalls) {
    if (call.name !== 'skill') continue;
    if (call.status !== 'completed') continue;
    const input = call.input;
    if (typeof input !== 'object' || input === null || Array.isArray(input)) continue;
    const name = (input as Record<string, unknown>).name;
    if (typeof name !== 'string' || name === '') continue;
    out.push({ name, callId: typeof call.callId === 'string' ? call.callId : null });
  }
  return out;
}

/** Where an observation came from: the task's OWN latest run result, tool events only. */
export interface SkillObservationProjection {
  readonly source: 'latest-run tool-event observation';
  readonly note: string;
  readonly runtime: {
    readonly taskId: string | null;
    readonly threadId: string | null;
    readonly agentId: string | null;
  };
  /** True only when the observed run's agent is the one the request was made for. */
  readonly agentMatchesAssignment: boolean;
  /**
   * The completed native skill calls this task's OWN latest run emitted, each labelled.
   * `equalsRequested` is true ONLY when BOTH hold: the observed run came from the SAME
   * agent the request was assigned to, AND the call's name is exactly the requested skill.
   * A same-named call on a run by any OTHER agent is therefore false — it can never be
   * read as this task's request having been honoured by the wrong worker.
   */
  readonly skillCalls: readonly (NativeSkillCallObservation & { readonly equalsRequested: boolean })[];
}

export interface SkillReportEntry {
  readonly taskId: string;
  /** The selected skill, or null (explicit none / rule none). */
  readonly requested: string | null;
  /**
   * The name SAVED and bound as a REQUEST into the advisory brief at selection time. It is
   * a saved selection-time binding, NOT a later re-read of a possibly-pruned intent and NOT
   * proof the task ran or that the agent loaded the skill.
   */
  readonly admitted: string | null;
  readonly admittedMeaning: string;
  readonly selectionSource: 'laya' | 'rule';
  readonly selectionReason: string;
  readonly assignedAgentId: string;
  readonly assignedModelId: string | null;
  /** null when the task produced no run result — never a fabricated success. */
  readonly observation: SkillObservationProjection | null;
}

const ADMITTED_MEANING =
  'bound into the advisory task brief as a REQUEST only, saved at selection time; not ' +
  'proof the task ran, not an enforceable tool authorization, and not a guarantee that the ' +
  'agent loaded it';

const OBSERVATION_NOTE =
  'tool-event observation from this task\'s own latest run result ONLY; NOT verified skill ' +
  'content, permission, sandbox or token saving, and NOT proof the requested skill was used';

/**
 * The ONE per-task projection. Pure: it reads only the values handed to it, so the report
 * cannot attribute another task's run, another agent's run, or a request to a run that
 * belongs to a different worker.
 */
export function projectSkillReport(input: {
  readonly taskId: string;
  readonly requested: string | null;
  readonly admitted: string | null;
  readonly source: 'laya' | 'rule';
  readonly reason: string;
  readonly assignedAgentId: string;
  readonly assignedModelId: string | null;
  readonly run: RunResult | null;
}): SkillReportEntry {
  const run = input.run;
  const observation: SkillObservationProjection | null = run === null
    ? null
    : {
        source: 'latest-run tool-event observation',
        note: OBSERVATION_NOTE,
        runtime: {
          taskId: run.taskId ?? null,
          threadId: run.threadId ?? null,
          agentId: run.agentId ?? null,
        },
        agentMatchesAssignment: run.agentId === input.assignedAgentId,
        // A call only "equals the request" when the SAME agent the request was assigned
        // to emitted it AND the name is exact. A same-named call by a foreign run is NOT
        // this request honoured, and is never labelled as such.
        skillCalls: observeNativeSkillCalls(run.toolCalls).map((c) => ({
          ...c,
          equalsRequested:
            run.agentId === input.assignedAgentId && input.requested !== null && c.name === input.requested,
        })),
      };
  return {
    taskId: input.taskId,
    requested: input.requested,
    admitted: input.admitted,
    admittedMeaning: ADMITTED_MEANING,
    selectionSource: input.source,
    selectionReason: input.reason,
    assignedAgentId: input.assignedAgentId,
    assignedModelId: input.assignedModelId,
    observation,
  };
}
