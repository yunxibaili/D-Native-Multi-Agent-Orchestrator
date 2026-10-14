/**
 * src/orchestration/mcp-catalog.ts — B3.2: the bounded, USER-DECLARED native MCP tool
 * CANDIDATE list, plus the ONE honest projection of a catalog-name-matched tool observation.
 *
 * WHAT THIS IS
 * ------------
 * A small JSON file in which the user declares, for ONE agent, a bounded list of
 * `{server, tool, description}` triples the round MAY offer to the decision provider when it
 * picks at most one advisory native tool per matching initially-assigned task.
 *
 * It is a PURE VALUE module. It parses and validates; it never reads files, never connects to
 * an MCP server, never writes a task, never names a model, never invokes a model and never
 * talks to an agent. It is deliberately NOT a filesystem config scanner, a YAML parser, a
 * second registry, a gateway, an SDK, or a permission/authorization system.
 *
 * THE DECLARATION IS NOT AN INVENTORY
 * -----------------------------------
 * A name here means "the user believes the agent may have this native tool configured". It is
 * NOT discovery, NOT proof the tool is installed, connected or authorized, and NOT proof the
 * name refers to an MCP server at all. The native OpenCode mapping is a pure forward mapping
 * (sanitize each segment, join with "_"); it may COLLIDE, and a custom tool could carry the
 * same name. Every consumer must render it as a request over a NAME-MATCHED native event.
 */

import type { RunResult, ToolCall } from '../core/types.ts';

// ---------------------------------------------------------------------------
// Bounds — named constants, not a configuration platform.
// ---------------------------------------------------------------------------

/** The raw file is rejected above this size, before it is parsed. */
export const MCP_CATALOG_MAX_BYTES = 32 * 1024;
/** At most this many tool candidates may be declared for one agent. */
export const MCP_CATALOG_MAX_ENTRIES = 16;
/** A server or tool segment is capped; the native vocabulary is short. */
export const MCP_CATALOG_MAX_FIELD = 128;
/** A description is metadata for the selection question, capped so it cannot be an essay. */
export const MCP_CATALOG_MAX_DESCRIPTION = 1024;
/** The agent id is an identifier, not free text. */
export const MCP_CATALOG_MAX_AGENT_ID = 128;
/**
 * The ONE agent supported by this slice at the installed OpenCode version. The native
 * tool-name mapping below is that version's own forward mapping, so a catalogue declared for
 * any other agent is refused as unsupported rather than silently offered.
 */
export const MCP_CATALOG_AGENT_ID = 'opencode';

// ---------------------------------------------------------------------------
// Forward native-name mapping (EXACT installed-version behaviour)
// ---------------------------------------------------------------------------

/**
 * The native name mapping, reproduced from the installed OpenCode version:
 *   sanitize(value) = value.replace(/[^a-zA-Z0-9_-]/g, "_")
 *   toolName(clientName, name) = sanitize(clientName) + "_" + sanitize(name)
 *
 * It is a FORWARD mapping only. It is deliberately never reversed: a native name does not
 * prove a server exists, and splitting on "_" would invent a client name that was never
 * declared.
 */
export function sanitizeNativeNameSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** The exact `server` + "_" + `tool` forward mapping. */
export function nativeToolName(server: string, tool: string): string {
  return `${sanitizeNativeNameSegment(server)}_${sanitizeNativeNameSegment(tool)}`;
}

// ---------------------------------------------------------------------------
// The shape
// ---------------------------------------------------------------------------

export interface McpCatalogEntry {
  readonly server: string;
  readonly tool: string;
  readonly description: string;
  /** The native name this declaration maps to, by the EXACT forward mapping above. */
  readonly nativeName: string;
}

export interface McpCatalog {
  /** The ONE agent these candidates are declared for. Enforced to the supported id. */
  readonly agentId: string;
  /** The offered candidates. An empty list is legal and means "offer nothing". */
  readonly tools: readonly McpCatalogEntry[];
}

export class McpCatalogError extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(code: string, detail: string) {
    super(`mcp catalog refused [${code}]: ${detail}`);
    this.name = 'McpCatalogError';
    this.code = code;
    this.detail = detail;
  }
}

export function isMcpCatalogError(value: unknown): value is McpCatalogError {
  return value instanceof McpCatalogError;
}

// ---------------------------------------------------------------------------
// Parsing + validation (total: every rejection names the offending field)
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function rejectUnknownKeys(raw: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new McpCatalogError('unknown-key', `${where} has unknown key "${key}" (allowed: ${allowed.join(', ')})`);
    }
  }
}

/** A control character or newline may never appear in a server/tool segment. */
function hasControlOrNewline(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function parseServerOrTool(raw: unknown, field: 'server' | 'tool', where: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new McpCatalogError(`invalid-${field}`, `${where}.${field} must be a non-blank string`);
  }
  if (raw.length > MCP_CATALOG_MAX_FIELD) {
    throw new McpCatalogError(`${field}-too-long`, `${where}.${field} is ${raw.length} chars, over the ${MCP_CATALOG_MAX_FIELD} limit`);
  }
  if (hasControlOrNewline(raw)) {
    throw new McpCatalogError(`invalid-${field}`, `${where}.${field} must not contain control characters or newlines`);
  }
  return raw;
}

function parseEntry(raw: unknown, where: string, seen: Map<string, McpCatalogEntry>): McpCatalogEntry {
  if (!isRecord(raw)) throw new McpCatalogError('invalid-entry', `${where} must be an object`);
  rejectUnknownKeys(raw, ['server', 'tool', 'description'], where);
  const server = parseServerOrTool(raw.server, 'server', where);
  const tool = parseServerOrTool(raw.tool, 'tool', where);
  const description = raw.description;
  if (typeof description !== 'string' || description.length === 0) {
    throw new McpCatalogError('invalid-description', `${where}.description must be a non-empty string`);
  }
  if (description.length > MCP_CATALOG_MAX_DESCRIPTION) {
    throw new McpCatalogError(
      'description-too-long',
      `${where}.description is ${description.length} chars, over the ${MCP_CATALOG_MAX_DESCRIPTION} limit`,
    );
  }
  const nativeName = nativeToolName(server, tool);
  const collision = seen.get(nativeName);
  if (collision !== undefined) {
    throw new McpCatalogError(
      'native-name-collision',
      `${where} maps to native tool name "${nativeName}", already declared by ${collision.server}/${collision.tool}`,
    );
  }
  const entry: McpCatalogEntry = Object.freeze({ server, tool, description, nativeName });
  seen.set(nativeName, entry);
  return entry;
}

/**
 * Parse and validate an MCP tool catalogue. Total and fail-closed: any violation throws an
 * `McpCatalogError` naming the field, and nothing is defaulted, truncated or dropped.
 */
export function parseMcpCatalog(raw: unknown): McpCatalog {
  if (!isRecord(raw)) throw new McpCatalogError('invalid-root', 'the mcp catalog must be a JSON object');
  rejectUnknownKeys(raw, ['agentId', 'tools'], 'mcp catalog');
  const agentId = raw.agentId;
  if (typeof agentId !== 'string' || agentId.trim() === '') {
    throw new McpCatalogError('invalid-agent-id', '"agentId" must be a non-empty string');
  }
  if (agentId.length > MCP_CATALOG_MAX_AGENT_ID) {
    throw new McpCatalogError('agent-id-too-long', `"agentId" is ${agentId.length} chars, over the ${MCP_CATALOG_MAX_AGENT_ID} limit`);
  }
  if (agentId !== MCP_CATALOG_AGENT_ID) {
    throw new McpCatalogError(
      'unsupported-agent',
      `this version supports the MCP catalogue for agent "${MCP_CATALOG_AGENT_ID}" only (got "${agentId}")`,
    );
  }
  if (!Array.isArray(raw.tools)) {
    throw new McpCatalogError('invalid-tools', '"tools" must be an array');
  }
  if (raw.tools.length > MCP_CATALOG_MAX_ENTRIES) {
    throw new McpCatalogError('too-many-entries', `"tools" declares ${raw.tools.length} entries, over the ${MCP_CATALOG_MAX_ENTRIES} limit`);
  }
  const seen = new Map<string, McpCatalogEntry>();
  const tools = raw.tools.map((entry, i) => parseEntry(entry, `tools[${i}]`, seen));
  return Object.freeze({ agentId, tools: Object.freeze(tools) });
}

/** The advisory prompt binding for one selected tool: the native name WITH its declaration. */
export function mcpToolIntentLabel(entry: { readonly server: string; readonly tool: string; readonly nativeName: string }): string {
  return `${entry.server}/${entry.tool} (native tool "${entry.nativeName}")`;
}

// ---------------------------------------------------------------------------
// Catalog-name-matched native tool observation — the only evidence this slice reads
// ---------------------------------------------------------------------------

/**
 * A completed native tool call whose name EXACTLY matches an offered catalogue entry,
 * projected to the facts worth reporting.
 *
 * Accepted ONLY when the status is `completed`, the structured `input` is an object, and the
 * name exactly equals a declared native name. A pending/failed call, a malformed input, a
 * text self-report (which produces no tool event at all), or a name that matches NO entry is
 * NOT an observation and is never upgraded into one. This says the NAME matched a declaration;
 * it never asserts MCP protocol origin, a connected server, or business success.
 */
export interface NativeCatalogToolCallObservation {
  readonly nativeName: string;
  readonly callId: string | null;
  /** The declared tuple this native name maps to, or null when it matched no entry. */
  readonly declared: { readonly server: string; readonly tool: string } | null;
}

function isStructuredInput(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

export function observeCatalogToolCalls(
  toolCalls: readonly ToolCall[],
  offered: readonly McpCatalogEntry[],
): NativeCatalogToolCallObservation[] {
  const byNative = new Map(offered.map((e) => [e.nativeName, e]));
  const out: NativeCatalogToolCallObservation[] = [];
  for (const call of toolCalls) {
    if (call.status !== 'completed') continue;
    if (!isStructuredInput(call.input)) continue;
    const entry = byNative.get(call.name);
    if (entry === undefined) continue;
    out.push({
      nativeName: call.name,
      callId: typeof call.callId === 'string' ? call.callId : null,
      declared: { server: entry.server, tool: entry.tool },
    });
  }
  return out;
}

export interface McpToolTuple {
  readonly server: string;
  readonly tool: string;
  readonly nativeName: string;
}

/** Where an observation came from: the task's OWN latest run result, tool events only. */
export interface McpObservationProjection {
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
   * The completed catalog-name-matched native calls this task's OWN latest run emitted, each
   * labelled. `equalsRequested` is true ONLY when BOTH hold: the observed run came from the
   * SAME agent the request was assigned to, AND the call's native name is exactly the
   * requested one. A same-named call on a run by any OTHER agent is therefore false.
   */
  readonly toolCalls: readonly (NativeCatalogToolCallObservation & { readonly equalsRequested: boolean })[];
}

export interface McpReportEntry {
  readonly taskId: string;
  /** The selected tool tuple, or null (explicit none / rule none). */
  readonly requested: McpToolTuple | null;
  /**
   * The tuple SAVED and bound as a REQUEST into the advisory brief at selection time. It is
   * a saved selection-time binding, NOT a later re-read of a possibly-pruned intent and NOT
   * proof the task ran or that the native tool existed.
   */
  readonly admitted: McpToolTuple | null;
  readonly admittedMeaning: string;
  readonly selectionSource: 'laya' | 'rule';
  readonly selectionReason: string;
  readonly assignedAgentId: string;
  readonly assignedModelId: string | null;
  /** null when the task produced no run result — never a fabricated success. */
  readonly observation: McpObservationProjection | null;
}

const ADMITTED_MEANING =
  'bound into the advisory task brief as a REQUEST only, saved at selection time; not ' +
  'proof the task ran, not an enforceable tool authorization, and not proof an MCP server ' +
  'is declared, connected or authorized';

const OBSERVATION_NOTE =
  'CATALOG-NAME-MATCHED native tool events from this task\'s own latest run result ONLY; the ' +
  'tool NAME matched a user declaration, which is NOT verified MCP protocol/server identity, ' +
  'NOT a connected or authorized server, and NOT business success. Native tools that match no ' +
  'declaration remain unclassified';

/**
 * The ONE per-task projection. Pure: it reads only the values handed to it, so the report
 * cannot attribute another task's run, another agent's run, or a request to a run that belongs
 * to a different worker.
 */
export function projectMcpReport(input: {
  readonly taskId: string;
  readonly requested: McpToolTuple | null;
  readonly admitted: McpToolTuple | null;
  readonly source: 'laya' | 'rule';
  readonly reason: string;
  readonly assignedAgentId: string;
  readonly assignedModelId: string | null;
  readonly offered: readonly McpCatalogEntry[];
  readonly run: RunResult | null;
}): McpReportEntry {
  const run = input.run;
  const observation: McpObservationProjection | null = run === null
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
        toolCalls: observeCatalogToolCalls(run.toolCalls, input.offered).map((c) => ({
          ...c,
          equalsRequested:
            run.agentId === input.assignedAgentId && input.requested !== null && c.nativeName === input.requested.nativeName,
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
