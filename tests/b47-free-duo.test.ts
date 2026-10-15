/**
 * tests/b47-free-duo.test.ts — B4.7.1 opt-in REAL OpenCode free-duo acceptance ENTRY.
 *
 * ============================================================================
 * WHAT THIS IS (and what it deliberately is NOT)
 * ============================================================================
 * A single, bounded, opt-in ENTRY for a real OpenCode "free duo" acceptance run:
 * two fixed free models build one small goal together, one of them integrates, and
 * the run is only ever accepted from NATIVE evidence (execution / artifact / identity /
 * confirmed stop) — never from a fake reviewer.
 *
 * It is NOT part of `npm test` / `npm run test:timed` (the suite lists are explicit).
 * Importing this module starts NOTHING: `main()` runs only when this file is the entry
 * point, so a hermetic test may import the gate without any real execution.
 *
 * ============================================================================
 * THE THREE OUTCOMES, STRICTLY SEPARATED
 * ============================================================================
 *   NOT_RUN  `ORCH_B47_REAL_FREE_DUO` is not EXACTLY "1". exit 0, no discovery, no
 *            owned directory, no Agent, no provider. The only branch that may exit 0
 *            without doing work.
 *   REFUSED  opted in, but the entitlement gate is not satisfied: the user fee
 *            declaration is missing / malformed / oversize / not admitted for BOTH
 *            fixed candidate pairs, or the demo-only scope is missing / not
 *            `demo-only` / expired. exit NON-ZERO, never PASS, and BEFORE any owned
 *            directory or Agent.
 *   ENABLED  opted in AND the declaration + demo-only scope are valid. The entry then
 *            runs the pre-launch auxiliary-model containment check (see below). When
 *            the installed version is not the one this interface was verified against,
 *            it REFUSES honestly rather than launching an unconstrained aux model.
 *
 * ============================================================================
 * AUXILIARY-MODEL CONTAINMENT (this round's concrete fix)
 * ============================================================================
 * The installed OpenCode loads a PER-PROCESS config from `OPENCODE_CONFIG` (a bounded
 * file path) and from `OPENCODE_CONFIG_CONTENT` (inline JSON). For the exact
 * interface-verified version (`1.18.35`) this entry writes a small owned config that
 * pins BOTH `model` and `small_model` to the allowed full free ids, sets
 * `share: "disabled"`, and denies task delegation via `tools.task: false`. The owned
 * config file is delivered to the child through `OPENCODE_CONFIG`, which this repo's
 * process env allowlist DOES forward; `OPENCODE_CONFIG_CONTENT` is also set (the
 * upstream-verified inline mechanism) and is honest about the allowlist gap.
 *
 * RETAINED UNKNOWNS (never claimed away): this does NOT prove pricing, entitlement,
 * or a USD hard budget, and internal/plugin/usage costs the CLI may incur outside the
 * orchestrator-managed run are not observed here.
 *
 * Run: ORCH_B47_REAL_FREE_DUO=1 ORCH_B47_FEE_DECLARATION=<file> \
 *      ORCH_B47_OPENCODE_VERSION=1.18.35 ORCH_B47_EVIDENCE=<file> \
 *      node tests/b47-free-duo.test.ts
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  setupOwnedTestContext,
  finish,
  writeHygieneReport,
  type CleanupFailure,
  type OwnedTestContext,
} from './helpers/real-agent-isolation.ts';
import { ManagedProcess } from '../src/runtime/spawn.ts';
import { launcherFor } from '../src/runtime/launcher.ts';
import { readControlRecord, treeStopConfirmedFrom } from '../src/runtime/containment.ts';
import type { ProcessStartDisposition } from '../src/core/types.ts';
import {
  USER_MODEL_POOL_MAX_BYTES,
  admitUserModelPoolPair,
  parseUserModelPool,
  type UserModelPool,
} from '../src/orchestration/model-pool.ts';

// ---- production wiring, used ONLY on the verified ENABLED path ---------------
import { NativeWorkbench, type DispatchOutcome } from '../src/orchestration/workbench.ts';
import type { WorkbenchTaskSpec } from '../src/orchestration/workbench-plan.ts';
import type { CandidateTask } from '../src/orchestration/planner.ts';
import type { RuntimeRunner } from '../src/orchestration/execute.ts';
import { Orchestrator } from '../src/orchestration/orchestrator.ts';
import { TaskScheduler } from '../src/orchestration/scheduler.ts';
import { Orchestrator as RuntimeOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { ModelRegistry } from '../src/quota/registry.ts';
import { BudgetManager } from '../src/quota/budget.ts';
import { createOpenCodeAdapter } from '../src/adapters/opencode.ts';
import { knownAgentIds } from '../src/adapters/index.ts';
import { createFakeAdapter } from './helpers.ts';
import { buildCollaborationCandidates, collaborationTaskIds } from '../src/orchestration/collab-plan.ts';
import { INITIAL_AGENT_MODEL_ID, initialCandidateKey } from '../src/decision/initial-assignment.ts';
import type { QuotaRecord } from '../src/quota/types.ts';
import type { AgentDescriptor, RunRequest } from '../src/core/types.ts';
import type { DecisionProvider } from '../src/decision/types.ts';

export const B47_OPT_IN_ENV = 'ORCH_B47_REAL_FREE_DUO';
export const B47_DECLARATION_ENV = 'ORCH_B47_FEE_DECLARATION';
export const B47_REPORT_ENV = 'ORCH_B47_REPORT';
/** Explicit output path for the deliverable/command evidence copy (finding 2). */
export const B47_EVIDENCE_ENV = 'ORCH_B47_EVIDENCE';
/** The installed OpenCode version, operator-declared. Unset/unsupported => refusal. */
export const B47_OPENCODE_VERSION_ENV = 'ORCH_B47_OPENCODE_VERSION';
/** Controlled command seam (same shape as the B1.2 entry's). Never a real agent. */
export const B47_OPENCODE_COMMAND_ENV = 'ORCH_B47_OPENCODE_COMMAND';
/** The ONE literal demo-only scope this ENTRY accepts. */
export const B47_DEMO_SCOPE = 'demo-only';

export const B47_AGENT_ID = 'opencode';
/** Fixed for THIS representative harness. No other/paid/Go/DSH model may substitute. */
export const B47_CANDIDATE_PAIRS: readonly Readonly<{ agentId: string; modelId: string }>[] = Object.freeze([
  Object.freeze({ agentId: B47_AGENT_ID, modelId: 'opencode/space-bunny-free' }),
  Object.freeze({ agentId: B47_AGENT_ID, modelId: 'opencode/mimo-v2.6-flash-free' }),
]);

/** The bounded native-execution budget: exactly the two members plus the integrator. */
export const B47_MAX_NATIVE_EXECUTIONS = 3;

/**
 * The concrete deliverable paths of the B4.7.1 demo (finding B4.7.1b).
 *
 * They MUST agree with the built-in `duo` plan's `fileScope` (member 1 `src/provider/**`,
 * member 2 `src/consumer/**`, both `src/integration/**`): the candidates render that scope
 * into the acceptance criteria a real agent reads, so if the verifier looks anywhere else
 * a real agent that correctly follows its scope is failed. That mismatch — a real run wrote
 * `src/provider/add.mjs` and the verifier checked a root `add.mjs` — was the proven defect.
 */
export const B47_PROVIDER_DIR = 'src/provider';
export const B47_CONSUMER_DIR = 'src/consumer';
export const B47_INTEGRATION_DIR = 'src/integration';
/** Member 1's module, inside its `src/provider/**` scope. */
export const B47_PROVIDER_ADD = `${B47_PROVIDER_DIR}/add.mjs`;
/** Member 2's test, inside its `src/consumer/**` scope; it imports member 1's module. */
export const B47_CONSUMER_TEST = `${B47_CONSUMER_DIR}/add.test.mjs`;
/** The relative specifier member 2's test uses to consume member 1's scoped module. */
export const B47_CONSUMER_IMPORT = '../provider/add.mjs';

/**
 * The demo's intentionally-fresh guidance, shared VERBATIM by the demo README and the task
 * objective/brief. It is guidance for the real model, NOT a permission boundary or a
 * guaranteed behaviour: an agent that ignores it is still verified only by native evidence.
 */
export const B47_DEMO_GUIDANCE: readonly string[] = Object.freeze([
  'This directory is an intentionally fresh, empty STANDALONE demo, not a repository that is missing files.',
  `Roles and exact paths: member 1 (provider) creates ${B47_PROVIDER_ADD}; member 2 (consumer) creates ${B47_CONSUMER_TEST} importing ${B47_CONSUMER_IMPORT}; the integrator writes ONE artifact under ${B47_INTEGRATION_DIR}/.`,
  'This demo needs NO API, NO settings and NO repository; do all work inside the current working directory.',
  'Stay in the current working directory. Do not inspect the parent, aux, store or sibling directories.',
  'If a required permission is denied, report it rather than probing alternate paths.',
]);

/** The ONE guidance file written into a prepared demo (same text as the task objective). */
export const B47_DEMO_README = 'README.md';

/** The ONE deterministic objective the fixed duo plan is built from (with the demo guidance). */
export const B47_DEMO_OBJECTIVE =
  `B4.7.1 demo: member 1 (provider) creates ${B47_PROVIDER_ADD} (a small add(a,b) module); ` +
  `member 2 (consumer) creates ${B47_CONSUMER_TEST} that imports ${B47_CONSUMER_IMPORT} ` +
  `and checks add(a,b); the designated integrator validates both files and writes ONE small ` +
  `integration artifact under ${B47_INTEGRATION_DIR}/. ` +
  B47_DEMO_GUIDANCE.join(' ');

/** The declared Workbench task budget for the root AND every committed child. */
export const B47_BUDGET_UNITS = 1_000_000;

/** The exact installed OpenCode versions whose config interface this entry was verified against. */
export const B47_SUPPORTED_OPENCODE_VERSIONS: readonly string[] = Object.freeze(['1.18.35']);

/** The env var the bounded config file is delivered through (allowlisted by the runtime). */
export const B47_AUX_CONFIG_ENV = 'OPENCODE_CONFIG';
/** The upstream-verified inline config mechanism (set, but NOT forwarded by the current allowlist). */
export const B47_AUX_CONFIG_CONTENT_ENV = 'OPENCODE_CONFIG_CONTENT';

/** Retained unknowns. These are NOT claims: they name what this entry does not prove. */
export const B47_AUX_UNKNOWNS: readonly string[] = Object.freeze([
  'the bounded config pins main/small_model and disables share + task delegation, but it does NOT prove pricing, entitlement, or a USD hard budget',
  'internal/plugin/usage costs the OpenCode CLI may incur outside the orchestrator-managed run are NOT observed here',
  `the installed version and ${B47_AUX_CONFIG_ENV}/${B47_AUX_CONFIG_CONTENT_ENV} delivery are operator-declared; this entry does not independently attest the binary`,
]);

// ===========================================================================
// The entitlement / scope GATE — pure, total, no I/O of its own
// ===========================================================================

export type B47GateResult =
  | { readonly status: 'NOT_RUN' }
  | { readonly status: 'REFUSED'; readonly code: string; readonly detail: string }
  | { readonly status: 'ENABLED'; readonly pool: UserModelPool; readonly scopeExpiresAt: number };

interface B47Declaration {
  readonly pool: UserModelPool;
  readonly scopeExpiresAt: number;
}

/**
 * Parse the bounded declaration. Shape:
 *
 *   {
 *     "fee":   { "policy": "no-additional-charge", "models": [ <user model pool entry> ] },
 *     "scope": { "kind": "demo-only", "expiresAt": <safe integer epochMs> }
 *   }
 *
 * `fee` is parsed by the EXISTING `parseUserModelPool`; this envelope adds only the
 * explicit demo-only scope. Unknown fields at either level are refused.
 */
function parseB47Declaration(text: string): { ok: true; value: B47Declaration } | { ok: false; code: string; detail: string } {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > USER_MODEL_POOL_MAX_BYTES) {
    return { ok: false, code: 'b47-fee-declaration-oversize', detail: `the declaration is ${bytes} bytes, over the ${USER_MODEL_POOL_MAX_BYTES} byte limit` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, code: 'b47-fee-declaration-malformed', detail: `the declaration is not valid JSON: ${(e as Error).message}` };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, code: 'b47-declaration-shape', detail: 'the declaration must be a JSON object with exactly "fee" and "scope"' };
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'fee' && key !== 'scope') {
      return { ok: false, code: 'b47-declaration-shape', detail: `unknown top-level field "${key}"; only "fee" and "scope" are accepted` };
    }
  }
  if (record.scope === undefined) {
    return { ok: false, code: 'b47-scope-missing', detail: 'no "scope" object is declared; an explicit demo-only scope is required' };
  }
  if (typeof record.scope !== 'object' || record.scope === null || Array.isArray(record.scope)) {
    return { ok: false, code: 'b47-scope-invalid', detail: 'the "scope" declaration must be an object' };
  }
  const scope = record.scope as Record<string, unknown>;
  for (const key of Object.keys(scope)) {
    if (key !== 'kind' && key !== 'expiresAt') {
      return { ok: false, code: 'b47-scope-invalid', detail: `unknown scope field "${key}"; only "kind" and "expiresAt" are accepted` };
    }
  }
  if (scope.kind !== B47_DEMO_SCOPE) {
    return { ok: false, code: 'b47-scope-not-demo-only', detail: `scope.kind must be exactly "${B47_DEMO_SCOPE}", got ${JSON.stringify(scope.kind)}` };
  }
  if (typeof scope.expiresAt !== 'number' || !Number.isSafeInteger(scope.expiresAt) || scope.expiresAt < 0) {
    return { ok: false, code: 'b47-scope-invalid', detail: 'scope.expiresAt must be a safe integer epochMs >= 0' };
  }
  if (record.fee === undefined) {
    return { ok: false, code: 'b47-fee-declaration-invalid', detail: 'no "fee" declaration is present' };
  }
  const parsed = parseUserModelPool(record.fee);
  if (!parsed.ok) {
    return { ok: false, code: 'b47-fee-declaration-invalid', detail: `${parsed.code}: ${parsed.detail}` };
  }
  return { ok: true, value: { pool: parsed.pool, scopeExpiresAt: scope.expiresAt } };
}

/**
 * Evaluate the ENTRY gate. Reads a declaration file ONLY when opted in; a NOT_RUN
 * decision therefore touches no file, no owned directory, no Agent and no provider.
 */
export function evaluateB47Entry(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: number;
  readonly readText: (path: string) => string;
}): B47GateResult {
  if (input.env[B47_OPT_IN_ENV] !== '1') {
    return { status: 'NOT_RUN' };
  }
  const declared = input.env[B47_DECLARATION_ENV];
  if (declared === undefined || declared.trim() === '') {
    return { status: 'REFUSED', code: 'b47-fee-declaration-missing', detail: `opt-in is set but ${B47_DECLARATION_ENV} does not name a declaration file` };
  }
  let text: string;
  try {
    text = input.readText(declared);
  } catch (e) {
    return { status: 'REFUSED', code: 'b47-fee-declaration-unreadable', detail: `the declaration at "${declared}" could not be read: ${(e as Error).message}` };
  }
  const parsed = parseB47Declaration(text);
  if (!parsed.ok) {
    return { status: 'REFUSED', code: parsed.code, detail: parsed.detail };
  }
  if (parsed.value.scopeExpiresAt <= input.now) {
    return { status: 'REFUSED', code: 'b47-scope-expired', detail: `the demo-only scope expired at ${parsed.value.scopeExpiresAt}, which is not after now (${input.now})` };
  }
  // Every FIXED candidate must be admitted by the SAME predicate production uses.
  for (const pair of B47_CANDIDATE_PAIRS) {
    const verdict = admitUserModelPoolPair(parsed.value.pool, { agentId: pair.agentId, modelId: pair.modelId }, input.now);
    if (!verdict.allowed) {
      return { status: 'REFUSED', code: 'b47-candidate-not-admitted', detail: `fixed candidate ${pair.agentId}/${pair.modelId} is not admitted: ${verdict.code}: ${verdict.detail}` };
    }
  }
  return { status: 'ENABLED', pool: parsed.value.pool, scopeExpiresAt: parsed.value.scopeExpiresAt };
}

// ===========================================================================
// Auxiliary-model containment — version-matched, bounded, honest about unknowns
// ===========================================================================

/** The bounded per-process OpenCode config this entry delivers. */
export interface B47AuxConfig {
  /** The exact JSON text written to the owned config file. */
  readonly content: string;
  readonly mainModel: string;
  readonly smallModel: string;
  readonly share: 'disabled';
  readonly taskDelegation: 'denied';
}

/**
 * Build the bounded aux config. Main and small_model are BOTH allowed full free ids
 * from the SAME fixed candidate list; share is disabled; task delegation is denied.
 */
export function buildB47AuxConfig(pairs: readonly Readonly<{ agentId: string; modelId: string }>[] = B47_CANDIDATE_PAIRS): B47AuxConfig {
  const mainModel = pairs[0]?.modelId ?? '';
  const smallModel = pairs[1]?.modelId ?? mainModel;
  const value = {
    $schema: 'https://opencode.ai/config.json',
    model: mainModel,
    small_model: smallModel,
    share: 'disabled',
    tools: { task: false },
  };
  return {
    content: JSON.stringify(value),
    mainModel,
    smallModel,
    share: 'disabled',
    taskDelegation: 'denied',
  };
}

export type B47AuxContainment =
  | { readonly ok: true; readonly code: 'b47-aux-contained'; readonly version: string; readonly config: B47AuxConfig }
  | { readonly ok: false; readonly code: 'b47-aux-version-unknown' | 'b47-aux-version-unsupported'; readonly detail: string };

/**
 * Pre-launch auxiliary-model containment check.
 *
 * It is a pure function of the operator-declared installed version: the config mechanism
 * is a version-matched INTERFACE fact, so an unknown or unsupported version is an honest
 * refusal, never an optimistic pass. It never invents a zero-network / zero-cost proof.
 */
export function verifyAuxiliaryModelContainment(installedVersion: string | null | undefined): B47AuxContainment {
  const version = typeof installedVersion === 'string' ? installedVersion.trim() : '';
  if (version === '') {
    return {
      ok: false,
      code: 'b47-aux-version-unknown',
      detail: `no installed OpenCode version was declared (set ${B47_OPENCODE_VERSION_ENV}); refusing to launch an unconstrained auxiliary model`,
    };
  }
  if (!B47_SUPPORTED_OPENCODE_VERSIONS.includes(version)) {
    return {
      ok: false,
      code: 'b47-aux-version-unsupported',
      detail: `installed OpenCode ${version} is not one of the interface-verified versions [${B47_SUPPORTED_OPENCODE_VERSIONS.join(', ')}]; the per-process small_model/share containment interface is not proven for it, so this entry refuses`,
    };
  }
  return { ok: true, code: 'b47-aux-contained', version, config: buildB47AuxConfig() };
}

// ===========================================================================
// Cleanup eligibility — exported pure decision for hermetic regression
// ===========================================================================

/** One OWN command (a native agent run or a contained Node check) and its stop facts. */
export interface B47OwnCommandFact {
  readonly label: string;
  readonly kind: 'native' | 'node-check';
  readonly disposition: ProcessStartDisposition;
  /** Positively confirmed tree stop (containment evidence), never inferred. */
  readonly stopConfirmed: boolean;
}

export interface B47CleanupEligibility {
  readonly eligible: boolean;
  readonly reasons: readonly string[];
}

/**
 * Derive cleanup eligibility FAIL-CLOSED.
 *
 * A command that never started needs no stop proof. Every command that may have started
 * must have a POSITIVELY confirmed stop, and the owned control-record count must match
 * the number of positively-started commands. Any uncertainty makes the whole cleanup
 * ineligible, so the caller retains the owned root instead of deleting evidence.
 */
export function decideCleanupEligibility(input: {
  readonly commands: readonly B47OwnCommandFact[];
  readonly observedControlRecords: number;
}): B47CleanupEligibility {
  const reasons: string[] = [];
  const started = input.commands.filter((c) => c.disposition !== 'not-started');
  for (const c of started) {
    if (!c.stopConfirmed) reasons.push(`unconfirmed-stop:${c.kind}:${c.label}`);
  }
  if (!Number.isSafeInteger(input.observedControlRecords) || input.observedControlRecords < 0) {
    reasons.push(`control-record-count-invalid:${String(input.observedControlRecords)}`);
  } else if (input.observedControlRecords !== started.length) {
    reasons.push(`control-record-mismatch:expected=${started.length}:observed=${input.observedControlRecords}`);
  }
  return { eligible: reasons.length === 0, reasons };
}

// ===========================================================================
// The REAL harness
// ===========================================================================

interface B47TaskRow {
  readonly taskId: string;
  readonly role: 'member' | 'integration';
  readonly agentId: string | null;
  readonly modelId: string | null;
  readonly sessionId: string | null;
  readonly status: string;
  readonly attemptId: string | null;
  readonly transcriptPath: string | null;
}

interface B47NativeRecord {
  readonly file: string;
  readonly launcherStatus: string;
  readonly treeStopConfirmed: boolean;
  readonly activeProcessesFinal: number | null;
  readonly rootPid: number | null;
}

export interface B47DeliverableEvidence {
  readonly taskId: string;
  readonly deliverable: 'add.mjs' | 'add.test.mjs' | 'integration';
  readonly accepted: boolean;
  readonly detail: string;
  readonly command: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly artifactText: string | null;
}

interface B47HarnessOutcome {
  readonly ok: boolean;
  readonly failureCode: string | null;
  readonly failureDetail: string | null;
  readonly nativeExecutions: number;
  readonly requestedModels: readonly string[];
  /** Never invented from the requested ids: the native model is UNKNOWN without feedback. */
  readonly nativeActualModel: null;
  /** Local orchestration identity: the Workbench session ids for THIS run's tasks. */
  readonly orchestrationSessionIds: readonly string[];
  /** Native thread ids taken ONLY from the same runs' RunResult.threadId; never invented. */
  readonly nativeThreadIds: readonly string[];
  readonly tasks: readonly B47TaskRow[];
  readonly integrationArtifactExists: boolean;
  readonly deliverables: readonly B47DeliverableEvidence[];
  readonly nativeRecords: readonly B47NativeRecord[];
  /** B4.7.1a (#2): each step's REAL scheduler tick cause, retained in the evidence. */
  readonly dispatch: readonly B47DispatchObservation[];
  readonly cleanup: B47CleanupEligibility;
  readonly notes: readonly string[];
}

/**
 * A deterministic coordinator seam — explicitly NOT a real LAYA. It binds the EXACT
 * requested pair in order and THROWS (a refusal) rather than silently falling back to
 * the first offered pair.
 */
function fixedDuoProvider(order: readonly Readonly<{ agentId: string; modelId: string }>[]): DecisionProvider {
  let index = 0;
  return {
    name: 'b47-free-duo-coordinator-seam',
    async probe() {
      return { ok: true, endpoint: 'seam://b47', detail: 'deterministic coordinator seam (NOT a real LAYA)', warnings: [] };
    },
    async decide(request) {
      const offered = Object.keys(request.questions[INITIAL_AGENT_MODEL_ID]?.criteria ?? {});
      const want = order[Math.min(index, order.length - 1)]!;
      const key = initialCandidateKey(want.agentId, want.modelId);
      if (!offered.includes(key)) {
        // No silent fallback: a missing requested pair is a refusal, never offered[0].
        throw new Error(`the requested pair "${want.agentId}/${want.modelId}" is not among the offered candidates`);
      }
      index += 1;
      const probabilities: Record<string, number> = {};
      for (const o of offered) probabilities[o] = o === key ? 1 : 0;
      return {
        answers: { [INITIAL_AGENT_MODEL_ID]: { type: 'choice', choice: key, probabilities, confidence: 1 } },
        provider: { name: 'b47-free-duo-coordinator-seam', details: 'deterministic coordinator seam' },
        raw: {},
      } as never;
    },
  };
}

function snapshotControlNames(controlDir: string): Set<string> {
  try {
    return new Set(existsSync(controlDir) ? readdirSync(controlDir).filter((n) => n.endsWith('.txt')) : []);
  } catch {
    return new Set();
  }
}

/** Native records THIS run created, each validated by the PRODUCTION readControlRecord. */
function judgeNativeRecords(controlDir: string, before: ReadonlySet<string>): B47NativeRecord[] {
  if (!existsSync(controlDir)) return [];
  const out: B47NativeRecord[] = [];
  for (const name of readdirSync(controlDir).filter((n) => n.endsWith('.txt')).sort()) {
    if (before.has(name)) continue;
    const v = readControlRecord(join(controlDir, name));
    if (!v.ok) {
      out.push({ file: name, launcherStatus: `<invalid:${v.reason}>`, treeStopConfirmed: false, activeProcessesFinal: null, rootPid: null });
      continue;
    }
    out.push({
      file: name,
      launcherStatus: v.record.launcherStatus,
      treeStopConfirmed: treeStopConfirmedFrom(v.record),
      activeProcessesFinal: v.record.activeProcessesFinal,
      rootPid: v.record.rootPid,
    });
  }
  return out;
}

/** The integration artifact's bytes, when ONE small file exists under src/integration/. */
function integrationArtifactText(demo: string): string | null {
  const dir = join(demo, B47_INTEGRATION_DIR);
  try {
    if (!existsSync(dir)) return null;
    const file = readdirSync(dir).find((n) => statSync(join(dir, n)).isFile());
    return file === undefined ? null : readFileSync(join(dir, file), 'utf8');
  } catch {
    return null;
  }
}

function anyIntegrationArtifact(demo: string): boolean {
  return integrationArtifactText(demo) !== null;
}

interface B47NodeCheck {
  readonly ok: boolean;
  readonly command: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderrTail: string;
  readonly fact: B47OwnCommandFact;
}

/** `isTreeStopConfirmed` must never throw from a `finally`/cleanup path. */
function safeTreeStopConfirmed(proc: ManagedProcess): boolean {
  try {
    return proc.isTreeStopConfirmed();
  } catch {
    return false;
  }
}

/**
 * Run ONE bounded Node command through the EXISTING contained `ManagedProcess`. This is
 * a deterministic test-driver check (NOT a model, NOT a reviewer, NOT a LAYA PASS).
 *
 * `record` is the SAME sink the real loop feeds its cleanup ledger with. The fact is
 * emitted from a `finally` derived from THIS very `ManagedProcess`, so a check whose
 * awaited path THROWS after a possible start still contributes an unconfirmed fact
 * instead of silently leaving the ledger empty (which would look safe).
 */
async function runNodeCheck(
  demo: string,
  label: string,
  args: readonly string[],
  record?: (fact: B47OwnCommandFact) => void,
  timeoutMs = 60_000,
): Promise<B47NodeCheck> {
  const resolved = launcherFor(process.execPath);
  if (!resolved.ok) {
    // A proven pre-start failure: no OS process exists, so there is no stop to account
    // for and no fact to record.
    throw new Error(`b47 node launcher unavailable: ${resolved.reason}`);
  }
  const out: string[] = [];
  const proc = new ManagedProcess({
    launcher: resolved.launcher,
    args,
    cwd: demo,
    onStdoutLine: (l) => out.push(l),
  });
  let fact: B47OwnCommandFact | null = null;
  try {
    let deadline: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((res) => {
      deadline = setTimeout(() => res('timeout'), timeoutMs);
      if (typeof deadline.unref === 'function') deadline.unref();
    });
    const settled = await Promise.race([proc.exited.then(() => 'exited' as const), timedOut])
      .finally(() => { if (deadline !== undefined) clearTimeout(deadline); });
    let exitCode: number | null;
    if (settled === 'timeout') {
      await proc.cancel('b47 node check deadline').catch(() => false);
      await proc.settleCleanup().catch(() => false);
      exitCode = null;
    } else {
      await proc.settleCleanup().catch(() => false);
      exitCode = (await proc.exited).code;
    }
    const stopConfirmed = proc.isTreeStopConfirmed();
    const disposition = proc.processStartDisposition;
    const stdout = out.join('\n');
    fact = { label, kind: 'node-check', disposition, stopConfirmed };
    return {
      ok: settled === 'exited' && exitCode === 0 && stopConfirmed,
      command: [process.execPath, ...args].join(' '),
      exitCode,
      stdout,
      stderrTail: proc.stderrTail.toString(),
      fact,
    };
  } finally {
    // NEVER let an exception produce an empty/safe-looking ledger: record the exact
    // fact of this run, taken from the same ManagedProcess, even when the awaited path
    // threw after a possible start (an unconfirmed fact if the stop is unknown).
    if (record !== undefined) {
      record(fact ?? {
        label,
        kind: 'node-check',
        disposition: proc.processStartDisposition,
        stopConfirmed: safeTreeStopConfirmed(proc),
      });
    }
  }
}

/** Does the node test output show at least one passing test? */
function showsPassingTest(stdout: string): boolean {
  return /\bpass [1-9][0-9]*\b/.test(stdout) || /\bpass\s+1\b/.test(stdout) || /# pass [1-9]/.test(stdout);
}

/**
 * Deterministic acceptance for THIS test-driver harness only: the deliverable is RUN,
 * not merely looked at. A zero-byte or wrong module fails the actual Node checks.
 */
export async function verifyDeliverable(
  demo: string,
  step: { readonly taskId: string; readonly deliverable: 'add.mjs' | 'add.test.mjs' | 'integration' },
  record?: (fact: B47OwnCommandFact) => void,
): Promise<B47DeliverableEvidence> {
  if (step.deliverable === 'add.mjs') {
    const addUrl = pathToFileURL(join(demo, B47_PROVIDER_ADD)).href;
    const script =
      `const m = await import(${JSON.stringify(addUrl)});` +
      `const add = (typeof m.add === 'function') ? m.add : (typeof m.default === 'function' ? m.default : null);` +
      `if (!add) { throw new Error('B47_NO_ADD_EXPORT'); }` +
      `const cases = [[2,3,5],[-2,3,1],[0,0,0],[-1,-1,-2],[7,-10,-3]];` +
      `for (const [a,b,want] of cases) { const got = add(a,b); if (got !== want) { throw new Error('B47_ADD_MISMATCH ' + a + ',' + b + '=' + got + ' want ' + want); } }` +
      `console.log('B47_ADD_OK');`;
    const check = await runNodeCheck(demo, `${step.taskId}:add`, ['--input-type=module', '-e', script], record);
    const accepted = check.ok && /B47_ADD_OK/.test(check.stdout);
    return {
      taskId: step.taskId, deliverable: step.deliverable, accepted,
      detail: accepted ? 'add(a,b) passed positive/negative/zero cases under real Node' : `actual Node add check failed (exit=${String(check.exitCode)}): ${check.stdout.slice(-300)} ${check.stderrTail.slice(-300)}`,
      command: check.command, exitCode: check.exitCode, stdout: check.stdout.slice(0, 2000), artifactText: null,
    };
  }
  if (step.deliverable === 'add.test.mjs') {
    const testPath = join(demo, B47_CONSUMER_TEST);
    const testText = existsSync(testPath) ? readFileSync(testPath, 'utf8') : '';
    const consumes = /add\.mjs/.test(testText) && testText.includes(B47_CONSUMER_IMPORT);
    const check = await runNodeCheck(demo, `${step.taskId}:test`, ['--test', B47_CONSUMER_TEST], record);
    const accepted = consumes && check.ok && showsPassingTest(check.stdout);
    return {
      taskId: step.taskId, deliverable: step.deliverable, accepted,
      detail: accepted
        ? `member2 imports ${B47_CONSUMER_IMPORT} and its real node --test assertions pass`
        : `member2 check failed (consumes=${consumes} exit=${String(check.exitCode)} passing=${showsPassingTest(check.stdout)}): ${check.stdout.slice(-300)} ${check.stderrTail.slice(-300)}`,
      command: check.command, exitCode: check.exitCode, stdout: check.stdout.slice(0, 2000), artifactText: null,
    };
  }
  const artifact = integrationArtifactText(demo);
  const references = artifact !== null && /add\.mjs/.test(artifact) && /add\.test\.mjs/.test(artifact) && /\badd\s*\(/.test(artifact);
  const check = await runNodeCheck(demo, `${step.taskId}:final-tests`, ['--test', B47_CONSUMER_TEST], record);
  const testsPass = check.ok && showsPassingTest(check.stdout);
  const accepted = references && testsPass;
  return {
    taskId: step.taskId, deliverable: step.deliverable, accepted,
    detail: accepted
      ? 'integration artifact references and consumes both members and the final independent tests pass'
      : `integration check failed (references=${references} testsPass=${testsPass} exit=${String(check.exitCode)}): ${check.stdout.slice(-300)} ${check.stderrTail.slice(-300)}`,
    command: check.command, exitCode: check.exitCode, stdout: check.stdout.slice(0, 2000), artifactText: artifact === null ? null : artifact.slice(0, 2000),
  };
}

/**
 * Cancel ONLY the handles THIS runtime owns, through the existing contained path, and
 * REPORT whether every one was positively stopped. It never merely appends a note: the
 * caller propagates an unconfirmed stop as FAILURE.
 */
async function stopOwnedHandles(rt: RuntimeOrchestrator): Promise<{ allStopped: boolean; failures: string[] }> {
  const failures: string[] = [];
  let allStopped = true;
  for (const session of rt.activeSessions()) {
    try {
      await session.cancel('b47 free-duo owned stop');
      const run = await session.result(30_000);
      if (run.cleanup.treeStopConfirmed !== true) {
        allStopped = false;
        failures.push(`session ${session.taskId}: contained stop not positively confirmed`);
      }
    } catch (e) {
      allStopped = false;
      failures.push(`session ${session.taskId}: ${(e as Error).message}`);
    }
  }
  return { allStopped, failures };
}

/** Write the exact deliverable texts + command results. A failure here is REQUIRED to fail the run. */
function writeEvidenceFile(path: string, evidence: unknown): void {
  writeFileSync(path, redact(JSON.stringify(evidence, null, 2)), 'utf8');
}

// ===========================================================================
// B4.7.1a: task-scope budget seeding + the ONE shared free-duo stack
// ===========================================================================

/**
 * Seed the TASK-scope budget ledgers the spawn gate requires, using the SAME method
 * production uses (`round-cli.ts` funds the root before planning and every COMMITTED
 * child before dispatch). The gate is fail-closed on a missing scope, so a harness that
 * only funds agent scopes is refused `budget-scope-unavailable` BEFORE any runtime
 * request — the exact B4.7.1a setup defect. This calls `BudgetManager.task` directly
 * (NOT a mocked predicate, NOT a bypass) and is a single call per id, so it never
 * allocates additively when a caller re-seeds.
 */
export function seedB47TaskScopeBudgets(
  budgets: BudgetManager,
  taskIds: readonly string[],
  budgetUnits: number = B47_BUDGET_UNITS,
): void {
  for (const id of taskIds) budgets.task(id, budgetUnits);
}

/** A structured, reusable view of ONE dispatch attempt's REAL scheduler tick. */
export interface B47DispatchObservation {
  readonly taskId: string;
  readonly tickPresent: boolean;
  readonly admitted: readonly string[];
  readonly waiting: readonly string[];
  readonly skipped: readonly { readonly taskId: string; readonly code: string; readonly reason: string }[];
  readonly outcomes: readonly { readonly taskId: string; readonly code: string; readonly reason: string }[];
  /** The ACTUAL cause, so a budget/resource/selection denial is never masked. */
  readonly cause: string;
}

/**
 * B4.7.1a (#2): derive the ACTUAL cause a task produced no run straight from the
 * scheduler tick, preferring the task's own `skipped`/`waiting`/refused-outcome entry
 * over a generic "missing run" message. A missing run must never hide WHY the tick
 * declined (budget, resource, selection or otherwise).
 */
export function describeDispatchCause(taskId: string, dispatched: DispatchOutcome): string {
  const tick = dispatched.tick;
  if (tick === null) return 'no scheduler tick was produced; the scheduler declined to run';
  const parts: string[] = [];
  if (tick.waiting.includes(taskId)) parts.push('waiting: ready but no free execution slot this tick');
  for (const s of tick.skipped.filter((s) => s.taskId === taskId)) parts.push(`skipped ${s.code}: ${s.reason}`);
  const refused = tick.outcomes.find((o) => o.taskId === taskId && !o.outcome.ok);
  if (refused !== undefined && !refused.outcome.ok) parts.push(`refused ${refused.outcome.code}: ${refused.outcome.reason}`);
  if (parts.length > 0) return parts.join('; ');
  return `no cause recorded for ${taskId} (admitted=[${tick.admitted.join(', ')}], waiting=[${tick.waiting.join(', ')}], skipped=[${tick.skipped.map((s) => `${s.taskId}:${s.code}`).join(', ')}])`;
}

/** One dispatch observation bound to its task id, for the failure detail AND evidence. */
export function observeDispatch(taskId: string, dispatched: DispatchOutcome): B47DispatchObservation {
  const tick = dispatched.tick;
  return {
    taskId,
    tickPresent: tick !== null,
    admitted: tick?.admitted ?? [],
    waiting: tick?.waiting ?? [],
    skipped: (tick?.skipped ?? []).map((s) => ({ taskId: s.taskId, code: s.code, reason: s.reason })),
    outcomes: (tick?.outcomes ?? []).map((o) => ({
      taskId: o.taskId,
      code: o.outcome.ok ? '' : o.outcome.code,
      reason: o.outcome.ok ? '' : o.outcome.reason,
    })),
    cause: describeDispatchCause(taskId, dispatched),
  };
}

/** A probe-only user model pool, built through the EXISTING predicate (no bypass). */
export function b47ProbeUserModelPool(now: number = Date.now()): UserModelPool {
  const parsed = parseUserModelPool({
    policy: 'no-additional-charge',
    models: B47_CANDIDATE_PAIRS.map((p) => ({
      agentId: p.agentId,
      modelId: p.modelId,
      billing: 'free',
      source: 'b47 admission probe fixture',
      observedAt: now - 1_000,
      expiresAt: now + 3_600_000,
    })),
  });
  if (!parsed.ok) throw new Error(`b47 admission probe pool is invalid: ${parsed.code}: ${parsed.detail}`);
  return parsed.pool;
}

/** The production-shaped free-duo stack, with the executable runtime seam injected. */
export interface B47FreeDuoStack {
  readonly rt: RuntimeOrchestrator;
  readonly budgets: BudgetManager;
  readonly registry: ModelRegistry;
  readonly orchestrator: Orchestrator;
  readonly scheduler: TaskScheduler;
  readonly workbench: NativeWorkbench;
  readonly rootId: string;
  readonly objective: string;
  readonly spec: WorkbenchTaskSpec;
  readonly candidates: readonly CandidateTask[];
  readonly ids: ReturnType<typeof collaborationTaskIds>;
}

/**
 * Prepare the SAME intentional demo for the controlled probe and the real harness, so the
 * two paths cannot drift. Creates the scoped directories and writes the shared guidance
 * ONCE. It never creates a deliverable, never copies repo code, and never overwrites an
 * existing file (so a probe that reuses a demo cannot clobber a member's output).
 */
export function prepareB47Demo(demo: string): void {
  for (const dir of [B47_PROVIDER_DIR, B47_CONSUMER_DIR, B47_INTEGRATION_DIR]) {
    mkdirSync(join(demo, dir), { recursive: true });
  }
  const readme = join(demo, B47_DEMO_README);
  if (!existsSync(readme)) writeFileSync(readme, `${B47_DEMO_GUIDANCE.join('\n')}\n`, 'utf8');
}

/**
 * Build the SAME stack the real harness runs: the real planner candidates, the real
 * Assignment/Session/Scheduler and the real Workbench over an injected runtime seam.
 * The runtime seam is the ONLY thing a caller swaps, so the admission path the hermetic
 * regression exercises is the production path rather than a re-implementation.
 */
export function createB47FreeDuoStack(options: {
  readonly demo: string;
  readonly storeDir: string;
  readonly command: string;
  readonly userModelPool: UserModelPool;
  readonly makeRuntime: (rt: RuntimeOrchestrator) => RuntimeRunner;
}): B47FreeDuoStack {
  // Preparation happens HERE, before the first runtime launch, on the one shared path so
  // the controlled probe and the real harness see an identical intentional demo.
  prepareB47Demo(options.demo);
  const rootId = 'b47-duo';
  const objective = B47_DEMO_OBJECTIVE;
  const spec: WorkbenchTaskSpec = { taskId: rootId, objective, taskType: 'implementation', budgetUnits: B47_BUDGET_UNITS };
  const candidates = buildCollaborationCandidates('duo', objective, rootId);
  const ids = collaborationTaskIds('duo', rootId);

  const rt = new RuntimeOrchestrator({
    config: { agents: { [B47_AGENT_ID]: { command: options.command } } } as never,
    storeDir: options.storeDir,
    replaceAdapters: [
      createOpenCodeAdapter({ command: options.command }),
      ...knownAgentIds().filter((id) => id !== B47_AGENT_ID).map((id) => createFakeAdapter({ id })),
    ],
  });
  const runtime = options.makeRuntime(rt);
  const budgets = new BudgetManager(4_000_000);
  for (const pair of B47_CANDIDATE_PAIRS) budgets.agent(pair.agentId, 1_000_000);
  const registry = new ModelRegistry();
  for (const pair of B47_CANDIDATE_PAIRS) {
    registry.upsert({
      agentId: pair.agentId,
      modelId: pair.modelId,
      provider: 'opencode',
      taskTypes: ['implementation', 'test'] as never,
      modelSource: 'b47-synthetic',
      quotaSource: 'b47-synthetic',
    }, Date.now());
    registry.setAgentAvailability(pair.agentId, 'available');
  }
  const descriptor = {
    id: B47_AGENT_ID, displayName: B47_AGENT_ID, launcher: 'opencode', transport: 'cli-jsonl',
    capabilities: { newTask: true, review: false, modelSelection: true, resume: true },
  } as unknown as AgentDescriptor;
  const statusRow = {
    agent: B47_AGENT_ID, agentId: B47_AGENT_ID, version: 'synthetic-b47-not-probed', installed: 'Yes',
    login: 'synthetic-not-a-login-check', quotaSource: 'synthetic-b47', usage: 'synthetic-b47', status: 'synthetic-b47',
  };
  const quotaRecord = (agentId: string): QuotaRecord => ({
    provider: agentId, agentId, modelId: null, source: 'estimated', usage: null, remaining: null,
    resetAt: null, period: 'day', status: 'available', usageClass: 'estimated', confidence: 'low',
    observedAt: Date.now(), note: 'synthetic B47 fixture; NOT an observation',
  });
  const orchestrator = new Orchestrator({
    gate: {
      descriptors: [descriptor],
      agentStatus: [statusRow],
      quotaRecords: [quotaRecord(B47_AGENT_ID)],
      registry,
      budgets,
      // B2.1a: the SAME user model pool the Workbench uses, so the production gate
      // re-checks admission at the real pre-start time of EACH native run (no second policy).
      userModelPool: options.userModelPool,
      taskType: 'implementation',
      requestedUnits: 1_000,
      currentConcurrency: 0,
      maxConcurrency: 1,
      maxChildren: 8,
      maxConcurrentAgents: 1,
    } as never,
    now: () => Date.now(),
    runtime,
    defaultCwd: options.demo,
    executionTimeoutMs: 90_000,
  });
  const scheduler = new TaskScheduler({ orchestrator, cwd: options.demo });
  const workbench = new NativeWorkbench({
    orchestrator, scheduler, registry, quotaRecords: [quotaRecord(B47_AGENT_ID)],
    cwd: options.demo, now: () => Date.now(), decisionProvider: fixedDuoProvider(B47_CANDIDATE_PAIRS),
    modelPool: options.userModelPool,
  });
  return { rt, budgets, registry, orchestrator, scheduler, workbench, rootId, objective, spec, candidates, ids };
}

/** The label of the controlled fail-before-start runtime seam (NOT an Agent). */
export const B47_ADMISSION_SEAM_LABEL = 'b47-admission-probe-runtime-seam (fail-before-start; NOT an Agent)';

/**
 * B4.7.2a: the intentional demo's scaffold state as observed AT the first runtime seam,
 * captured inside `run(r)` BEFORE it throws. A probe driven against a directory that was
 * NEVER manually prepared therefore exposes a removed `prepareB47Demo` inside the shared
 * stack builder, instead of being masked by an earlier manual preparation of the same dir.
 */
export interface B47FirstSeamObservation {
  readonly readmeExists: boolean;
  readonly readmeText: string | null;
  readonly providerDirExists: boolean;
  readonly consumerDirExists: boolean;
  readonly integrationDirExists: boolean;
  readonly providerAddExists: boolean;
  readonly consumerTestExists: boolean;
  readonly integrationArtifactCount: number;
}

/** Read the scaffold state ONLY through the existing fs primitives (no new harness). */
function observeB47FirstSeam(demo: string): B47FirstSeamObservation {
  const readme = join(demo, B47_DEMO_README);
  let integrationArtifactCount = 0;
  try {
    const dir = join(demo, B47_INTEGRATION_DIR);
    if (existsSync(dir)) integrationArtifactCount = readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile()).length;
  } catch {
    integrationArtifactCount = 0;
  }
  return {
    readmeExists: existsSync(readme),
    readmeText: existsSync(readme) ? readFileSync(readme, 'utf8') : null,
    providerDirExists: existsSync(join(demo, B47_PROVIDER_DIR)),
    consumerDirExists: existsSync(join(demo, B47_CONSUMER_DIR)),
    integrationDirExists: existsSync(join(demo, B47_INTEGRATION_DIR)),
    providerAddExists: existsSync(join(demo, B47_PROVIDER_ADD)),
    consumerTestExists: existsSync(join(demo, B47_CONSUMER_TEST)),
    integrationArtifactCount,
  };
}

export interface B47AdmissionProbe {
  readonly withTaskBudgets: boolean;
  readonly childIds: readonly string[];
  readonly assignedCount: number;
  readonly runtimeSeamReached: boolean;
  readonly presentedModel: string | null;
  /** The ACTUAL prompt of the FIRST intended RunRequest the seam received. */
  readonly presentedPrompt: string | null;
  readonly firstTaskId: string;
  readonly dispatch: B47DispatchObservation;
  /** B4.7.2a: scaffold state at the ACTUAL first runtime seam, BEFORE the seam throws. */
  readonly firstSeamObservation: B47FirstSeamObservation | null;
}

/**
 * B4.7.1a (#3): a hermetic admission regression that drives the REAL plan → Assignment →
 * Scheduler path with a runtime seam that THROWS before any Agent can start. It proves
 * both halves of the fix on the SAME setup path the real harness uses:
 *
 *   - WITHOUT the root/child task ledgers: the tick's real `budget-insufficient`
 *     (`budget-scope-unavailable`) refusal, and the seam is NEVER reached;
 *   - WITH the root/child task ledgers (via `seedB47TaskScopeBudgets`): the FIRST
 *     intended runtime request is made, labelled, and stopped before any Agent.
 *
 * No network, no model, no launcher: the labelled seam is the ONLY execution edge.
 */
export async function runB47AdmissionProbe(options: {
  readonly demo: string;
  readonly storeDir: string;
  readonly command: string;
  readonly withTaskBudgets: boolean;
}): Promise<B47AdmissionProbe> {
  let runtimeSeamReached = false;
  let presentedModel: string | null = null;
  let presentedPrompt: string | null = null;
  let firstSeamObservation: B47FirstSeamObservation | null = null;
  const stack = createB47FreeDuoStack({
    demo: options.demo,
    storeDir: options.storeDir,
    command: options.command,
    userModelPool: b47ProbeUserModelPool(),
    makeRuntime: () => ({
      run: (r) => {
        runtimeSeamReached = true;
        presentedModel = r.model ?? null;
        presentedPrompt = r.prompt ?? null;
        // Capture the scaffold state AT this seam, before throwing: if the shared stack
        // builder's preparation was removed, an UNPREPARED demo is visible HERE.
        firstSeamObservation = observeB47FirstSeam(options.demo);
        throw new Error(`${B47_ADMISSION_SEAM_LABEL}: refusing to start any Agent`);
      },
    }),
  });
  const { workbench: wb, budgets, spec, rootId, ids } = stack;
  // Same order as production: fund the root before planning, then every committed child.
  if (options.withTaskBudgets) seedB47TaskScopeBudgets(budgets, [rootId], spec.budgetUnits);
  wb.planWithCandidates(spec, stack.candidates);
  if (options.withTaskBudgets) {
    seedB47TaskScopeBudgets(budgets, wb.store.children(rootId).map((t) => t.taskId), spec.budgetUnits);
  }
  await wb.selectInitialAssignment(rootId, spec.selection, { distinctPairs: true, skipTaskIds: [ids.integratorId] });
  wb.inheritInitialSelection(ids.memberIds[0]!, ids.integratorId);
  const assigned = wb.assignChildren(rootId, spec);
  const firstTaskId = ids.memberIds[0]!;
  const dispatched = await wb.dispatch(undefined, undefined, { taskIds: new Set([firstTaskId]) });
  return {
    withTaskBudgets: options.withTaskBudgets,
    childIds: wb.store.children(rootId).map((t) => t.taskId),
    assignedCount: assigned.filter((a) => a.ok).length,
    runtimeSeamReached,
    presentedModel,
    presentedPrompt,
    firstTaskId,
    dispatch: observeDispatch(firstTaskId, dispatched),
    firstSeamObservation,
  };
}

/**
 * The bounded REAL run. Three execution tasks max, strictly sequential writers, two
 * distinct member pairs, the integrator reusing a member pair with its OWN task/session.
 * Every awaited run is bounded by the orchestrator's `executionTimeoutMs` (<= 90 s).
 */
async function runRealDuo(
  owned: OwnedTestContext,
  command: string,
  gate: Extract<B47GateResult, { status: 'ENABLED' }>,
  aux: Extract<B47AuxContainment, { ok: true }>,
  declarationText: string,
  evidencePath: string | null,
): Promise<B47HarnessOutcome> {
  const notes: string[] = [
    'harness: deterministic coordinator seam (labelled); NO real LAYA/quota/review is claimed',
    `aux containment: version=${aux.version}; ${B47_AUX_CONFIG_ENV} file + ${B47_AUX_CONFIG_CONTENT_ENV} inline; share=${aux.config.share}; task delegation ${aux.config.taskDelegation}`,
    'availability/quota inputs are SYNTHETIC labelled fixtures — NOT a login check and NOT a quota observation',
  ];
  const commands: B47OwnCommandFact[] = [];
  const demo = owned.dir('demo');

  const requests: RunRequest[] = [];
  const requestedModels: string[] = [];
  let nativeLaunched = 0;
  const stack = createB47FreeDuoStack({
    demo,
    storeDir: owned.dir('store'),
    command,
    userModelPool: gate.pool,
    makeRuntime: (rt) => ({
      run: (r: RunRequest) => {
        // fail-before-start if the budget would be exceeded, and re-check the SAME pool
        // and the exact requested pair synchronously before any launch.
        if (nativeLaunched >= B47_MAX_NATIVE_EXECUTIONS) {
          throw new Error(`b47-native-execution-budget-exceeded: refusing to start more than ${B47_MAX_NATIVE_EXECUTIONS}`);
        }
        const wanted = B47_CANDIDATE_PAIRS.find((p) => p.modelId === r.model);
        if (r.model === undefined || r.model === null || wanted === undefined) {
          throw new Error(`b47-unrequested-model: "${r.model ?? '(none)'}" is not one of the fixed allowed pairs`);
        }
        const recheck = evaluateB47Entry({ env: process.env, now: Date.now(), readText: () => declarationText });
        if (recheck.status !== 'ENABLED') {
          throw new Error(`b47-launch-recheck-refused: ${recheck.status}${recheck.status === 'REFUSED' ? ` (${recheck.code})` : ''}`);
        }
        nativeLaunched += 1;
        requestedModels.push(r.model);
        requests.push(r);
        return rt.run(r);
      },
    }),
  });
  const { rt, budgets, workbench: wb, rootId, spec, candidates, ids } = stack;

  const orchestrationSessionIds: string[] = [];
  const nativeThreadIds: string[] = [];
  const attemptIds = new Map<string, string | null>();
  let ok = true;
  let failureCode: string | null = null;
  let failureDetail: string | null = null;
  let nativeExecutions = 0;
  const deliverables: B47DeliverableEvidence[] = [];
  const dispatches: B47DispatchObservation[] = [];
  const controlBefore = snapshotControlNames(owned.controlDir);

  try {
    // B4.7.1a: fund the root and every COMMITTED child the same way production does
    // (`round-cli.ts` seeds the root before planning and the children before dispatch)
    // through the EXISTING BudgetManager.task. Without these task-scope ledgers the
    // spawn gate refuses `budget-scope-unavailable` before any runtime request.
    seedB47TaskScopeBudgets(budgets, [rootId], spec.budgetUnits);
    const planned = wb.planWithCandidates(spec, candidates);
    notes.push(`planned ${planned.children.length} task(s) from the built-in collab-plan duo`);
    seedB47TaskScopeBudgets(budgets, wb.store.children(rootId).map((t) => t.taskId), spec.budgetUnits);

    await wb.selectInitialAssignment(rootId, spec.selection, { distinctPairs: true, skipTaskIds: [ids.integratorId] });
    const inherited = wb.inheritInitialSelection(ids.memberIds[0]!, ids.integratorId);
    notes.push(inherited.ok
      ? `integrator ${ids.integratorId} inherits member ${ids.memberIds[0]}'s pair (own task/session)`
      : `integrator inheritance refused: ${inherited.code} ${inherited.reason}`);
    const assigned = wb.assignChildren(rootId, spec);
    notes.push(`assigned ${assigned.filter((a) => a.ok).length}/${assigned.length} task(s)`);

    const steps: ReadonlyArray<{ taskId: string; deliverable: 'add.mjs' | 'add.test.mjs' | 'integration' }> = [
      { taskId: ids.memberIds[0]!, deliverable: 'add.mjs' },
      { taskId: ids.memberIds[1]!, deliverable: 'add.test.mjs' },
      { taskId: ids.integratorId, deliverable: 'integration' },
    ];

    for (const step of steps) {
      if (!ok) break;
      const dispatched = await wb.dispatch(undefined, undefined, { taskIds: new Set([step.taskId]) });
      const observation = observeDispatch(step.taskId, dispatched);
      dispatches.push(observation);
      const refs = dispatched.executionsByTask[step.taskId] ?? [];
      const admitted = dispatched.tick?.admitted.includes(step.taskId) ?? false;
      if (dispatched.tick === null || !admitted || refs.length !== 1) {
        ok = false;
        failureCode = 'b47-dispatch-missing-run';
        // B4.7.1a (#2): surface the ACTUAL tick cause (budget / resource / selection
        // denial) instead of a generic "missing run" that hides the refusal reason.
        failureDetail = `task ${step.taskId} produced ${refs.length} execution(s) and admitted=${admitted} :: ${observation.cause}`;
        break;
      }
      const ref = refs[0]!;
      const run = ref.run;
      attemptIds.set(step.taskId, ref.attemptId);
      // Native identity comes ONLY from THIS run's RunResult.threadId (real native
      // feedback when the adapter supplies it); unknown stays absent, never invented.
      if (run.threadId !== null && !nativeThreadIds.includes(run.threadId)) nativeThreadIds.push(run.threadId);
      commands.push({ label: step.taskId, kind: 'native', disposition: run.cleanup.processStart, stopConfirmed: run.cleanup.treeStopConfirmed === true });
      if (run.state !== 'succeeded') {
        ok = false;
        failureCode = 'b47-native-not-succeeded';
        failureDetail = `task ${step.taskId} run state=${run.state} exit=${String(run.exitCode)} error=${run.error?.code ?? 'none'}`;
        break;
      }
      if (run.cleanup.treeStopConfirmed !== true) {
        ok = false;
        failureCode = 'b47-native-stop-unconfirmed';
        failureDetail = `task ${step.taskId} did not confirm its process-tree stop`;
        break;
      }
      nativeExecutions += 1;
      const session = wb.sessionForTask(step.taskId);
      if (session !== null && !orchestrationSessionIds.includes(session.sessionId)) orchestrationSessionIds.push(session.sessionId);

      // The contained Node check records its OWN command fact into the EXACT same
      // ledger the native runs use, so owner-command count matches owned control
      // records and a failed check is retained without faking a success.
      const check = await verifyDeliverable(demo, step, (f) => commands.push(f));
      deliverables.push(check);
      notes.push(`test-driver Node verification (NOT a review/LAYA PASS): ${step.taskId} => ${check.accepted ? 'accepted' : 'rejected'}`);
      if (!check.accepted) {
        ok = false;
        failureCode = 'b47-deliverable-rejected';
        failureDetail = check.detail;
        break;
      }
      const completed = wb.completeTask(step.taskId, 'test-driver Node verification: concrete deliverable produced and checked');
      if (!completed.ok) {
        ok = false;
        failureCode = 'b47-complete-task-refused';
        failureDetail = `${completed.code}: ${completed.reason}`;
        break;
      }
    }
  } catch (e) {
    ok = false;
    failureCode = 'b47-harness-exception';
    failureDetail = (e as Error).message;
  }

  // Cancel ONLY the handles THIS runtime owns, through the existing contained path.
  const stop = await stopOwnedHandles(rt);
  for (const f of stop.failures) notes.push(`owned handle stop failure: ${f}`);
  if (!stop.allStopped) {
    ok = false;
    failureCode ??= 'b47-owned-stop-unconfirmed';
    failureDetail ??= stop.failures.join('; ');
  }

  const nativeRecords = judgeNativeRecords(owned.controlDir, controlBefore);
  const observedControlRecords = nativeRecords.filter((r) => !r.launcherStatus.startsWith('<invalid')).length;
  const cleanup = decideCleanupEligibility({ commands, observedControlRecords });
  if (!cleanup.eligible) {
    ok = false;
    failureCode ??= 'b47-cleanup-unconfirmed';
    failureDetail ??= cleanup.reasons.join('; ');
  }

  const tasks: B47TaskRow[] = wb.store.children(rootId).map((t) => ({
    taskId: t.taskId,
    role: t.taskId === ids.integratorId ? 'integration' : 'member',
    agentId: t.agentId ?? null,
    modelId: t.modelId ?? null,
    sessionId: wb.sessionForTask(t.taskId)?.sessionId ?? null,
    status: t.status,
    attemptId: attemptIds.get(t.taskId) ?? null,
    transcriptPath: wb.lastRunResult(t.taskId)?.transcriptPath ?? null,
  }));

  const outcome: B47HarnessOutcome = {
    ok,
    failureCode,
    failureDetail,
    nativeExecutions,
    requestedModels,
    nativeActualModel: null,
    orchestrationSessionIds,
    nativeThreadIds,
    tasks,
    integrationArtifactExists: anyIntegrationArtifact(demo),
    deliverables,
    nativeRecords,
    dispatch: dispatches,
    cleanup,
    notes,
  };

  // Evidence is copied BEFORE the owned workspace is removed. A required write failure
  // must fail the run (never swallowed).
  if (evidencePath === null || evidencePath === '') {
    return {
      ...outcome,
      ok: false,
      failureCode: outcome.failureCode ?? 'b47-evidence-path-missing',
      failureDetail: outcome.failureDetail ?? `no evidence output path was supplied (set ${B47_EVIDENCE_ENV}); deliverable evidence cannot be handed to review`,
    };
  }
  try {
    writeEvidenceFile(evidencePath, {
      schema: 'b47-free-duo-evidence/1',
      generatedAt: Date.now(),
      aux: { version: aux.version, mainModel: aux.config.mainModel, smallModel: aux.config.smallModel, share: aux.config.share, taskDelegation: aux.config.taskDelegation, configEnv: [B47_AUX_CONFIG_ENV, B47_AUX_CONFIG_CONTENT_ENV] },
      ok,
      failureCode,
      failureDetail,
      nativeExecutions,
      requestedModels,
      nativeActualModel: null,
      orchestrationSessionIds,
      nativeThreadIds,
      deliverables,
      tasks,
      nativeRecords,
      dispatch: dispatches,
      cleanup,
      notes,
      unknowns: B47_AUX_UNKNOWNS,
    });
  } catch (e) {
    return {
      ...outcome,
      ok: false,
      failureCode: 'b47-evidence-write-failed',
      failureDetail: `the required evidence write to "${evidencePath}" failed: ${(e as Error).message}`,
    };
  }
  return outcome;
}

// ===========================================================================
// Report (only to an explicit parent-provided path, sanitized)
// ===========================================================================

function redact(text: string): string {
  let s = text;
  for (const env of ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE'] as const) {
    const v = process.env[env];
    if (v !== undefined && v !== '') s = s.split(v).join(`%${env}%`);
  }
  return s;
}

interface B47Report {
  schema: 'b47-free-duo-entry/1';
  optIn: string | null;
  status: 'NOT_RUN' | 'REFUSED' | 'ENABLED_REFUSED' | 'RUN';
  code: string | null;
  detail: string | null;
  candidates: readonly Readonly<{ agentId: string; modelId: string }>[];
  limitations: readonly string[];
  ownedRoot: string | null;
  cleanupFailures: readonly CleanupFailure[];
  outcome: B47HarnessOutcome | null;
}

function writeReport(report: B47Report): void {
  const target = process.env[B47_REPORT_ENV];
  if (target === undefined || target === '') return;
  try {
    writeFileSync(target, redact(JSON.stringify(report, null, 2)), 'utf8');
  } catch {
    // A report is diagnostic; its own write failure never changes this suite's verdict.
  }
}

// ===========================================================================
// main
// ===========================================================================

const results: Array<{ verdict: 'PASS' | 'FAIL' }> = [];
function record(verdict: 'PASS' | 'FAIL', name: string, detail = ''): void {
  results.push({ verdict });
  process.stdout.write(`  ${verdict} ${name}${detail ? ` - ${detail}` : ''}\n`);
}

async function main(): Promise<void> {
  process.stdout.write('== B4.7.1 real OpenCode free-duo acceptance ENTRY ==\n');

  const gate = evaluateB47Entry({ env: process.env, now: Date.now(), readText: (p) => readFileSync(p, 'utf8') });

  if (gate.status === 'NOT_RUN') {
    process.stdout.write(`  NOT_RUN (opt-in required: set ${B47_OPT_IN_ENV}=1)\n`);
    process.stdout.write('  no discovery, no agent start, no owned context created.\n');
    writeReport({ schema: 'b47-free-duo-entry/1', optIn: process.env[B47_OPT_IN_ENV] ?? null, status: 'NOT_RUN', code: null, detail: null, candidates: B47_CANDIDATE_PAIRS, limitations: [], ownedRoot: null, cleanupFailures: [], outcome: null });
    writeHygieneReport();
    process.exitCode = finish([], { allowEnvironmentBlocked: true });
    return;
  }

  if (gate.status === 'REFUSED') {
    process.stdout.write(`  REFUSED ${gate.code}: ${gate.detail}\n`);
    record('FAIL', `entitlement gate: ${gate.code}`, gate.detail);
    writeReport({ schema: 'b47-free-duo-entry/1', optIn: '1', status: 'REFUSED', code: gate.code, detail: gate.detail, candidates: B47_CANDIDATE_PAIRS, limitations: [], ownedRoot: null, cleanupFailures: [], outcome: null });
    writeHygieneReport();
    process.exitCode = finish(results, { allowEnvironmentBlocked: false });
    return;
  }

  // ENABLED: the entitlement + demo-only scope are valid. Refuse BEFORE launch unless the
  // auxiliary-model containment is version-matched and verified.
  const aux = verifyAuxiliaryModelContainment(process.env[B47_OPENCODE_VERSION_ENV]);
  if (!aux.ok) {
    process.stdout.write(`  ENABLED but REFUSED pre-launch ${aux.code}: ${aux.detail}\n`);
    record('FAIL', `pre-launch auxiliary containment: ${aux.code}`, aux.detail);
    writeReport({ schema: 'b47-free-duo-entry/1', optIn: '1', status: 'ENABLED_REFUSED', code: aux.code, detail: aux.detail, candidates: B47_CANDIDATE_PAIRS, limitations: [aux.detail, ...B47_AUX_UNKNOWNS], ownedRoot: null, cleanupFailures: [], outcome: null });
    writeHygieneReport();
    process.exitCode = finish(results, { allowEnvironmentBlocked: false });
    return;
  }

  const owned = setupOwnedTestContext();
  if (owned === null) {
    record('FAIL', 'production containment launcher available', 'ENVIRONMENT_BLOCKED: no sealed Job launcher on this machine');
    writeReport({ schema: 'b47-free-duo-entry/1', optIn: '1', status: 'RUN', code: 'environment-blocked', detail: 'no sealed Job launcher', candidates: B47_CANDIDATE_PAIRS, limitations: B47_AUX_UNKNOWNS, ownedRoot: null, cleanupFailures: [], outcome: null });
    writeHygieneReport();
    process.exitCode = finish(results, { allowEnvironmentBlocked: false });
    return;
  }

  // Deliver the bounded per-process aux config to the child BEFORE any launch. The config
  // file is owned; the inline content is also set (upstream-verified mechanism).
  const configFile = join(owned.dir('aux'), 'opencode-config.json');
  writeFileSync(configFile, aux.config.content, 'utf8');
  owned.setEnv(B47_AUX_CONFIG_ENV, configFile);
  owned.setEnv(B47_AUX_CONFIG_CONTENT_ENV, aux.config.content);
  // Record the owned root IMMEDIATELY, before any launch: if this process dies later,
  // the operator still knows exactly which owned directory holds the evidence.
  process.stdout.write(`  owned root: ${owned.root}\n`);

  const declaration = process.env[B47_DECLARATION_ENV]!;
  const declarationText = readFileSync(declaration, 'utf8');
  const command = process.env[B47_OPENCODE_COMMAND_ENV];
  const evidencePath = process.env[B47_EVIDENCE_ENV] ?? null;

  let outcome: B47HarnessOutcome | null = null;
  let cleanupFailures: CleanupFailure[] = [];
  let retainOwned = false;
  try {
    outcome = await runRealDuo(owned, command ?? 'opencode', gate, aux, declarationText, evidencePath);
  } catch (e) {
    record('FAIL', 'real duo harness completed without throwing', String((e as Error).message));
    // Fail-closed retention: an exception escaping the harness may have happened AFTER a
    // possible launch, so the owned ledger cannot prove every stop. Never infer safety
    // from an exception — retain the owned evidence instead of cleaning it up.
    retainOwned = true;
  }

  try {
    if (outcome !== null) {
      const distinctMembers = outcome.tasks.length === 3 &&
        new Set(outcome.tasks.map((t) => `${t.agentId}/${t.modelId}`)).size === 2;
      const memberPairs = outcome.tasks.filter((t) => t.role === 'member').map((t) => `${t.agentId}/${t.modelId}`);
      const integrator = outcome.tasks.find((t) => t.role === 'integration');
      const integratorMatchesFirstMember = integrator !== undefined && memberPairs.length === 2 && `${integrator.agentId}/${integrator.modelId}` === memberPairs[0];
      const threeTasks = new Set(outcome.tasks.map((t) => t.taskId)).size === 3;
      const threeSessions = new Set(outcome.tasks.map((t) => t.sessionId).filter((s) => s !== null)).size === 3;

      record(outcome.ok ? 'PASS' : 'FAIL', 'the bounded real duo completed every step successfully', outcome.failureCode ? `${outcome.failureCode}: ${outcome.failureDetail ?? ''}` : '');
      record(outcome.nativeExecutions === B47_MAX_NATIVE_EXECUTIONS ? 'PASS' : 'FAIL', `native executions === ${B47_MAX_NATIVE_EXECUTIONS}`, `n=${outcome.nativeExecutions}`);
      record(distinctMembers ? 'PASS' : 'FAIL', 'exactly 3 tasks on 3 distinct (member) / inherited (integrator) pairs', JSON.stringify(outcome.tasks.map((t) => `${t.taskId}:${t.agentId}/${t.modelId}`)));
      record(threeTasks ? 'PASS' : 'FAIL', '3 distinct task ids', JSON.stringify(outcome.tasks.map((t) => t.taskId)));
      record(threeSessions ? 'PASS' : 'FAIL', '3 distinct observed sessions', JSON.stringify(outcome.tasks.map((t) => t.sessionId)));
      record(integratorMatchesFirstMember ? 'PASS' : 'FAIL', 'the integrator pair matches member 1 (no fourth model)', JSON.stringify(outcome.tasks));
      record(outcome.integrationArtifactExists ? 'PASS' : 'FAIL', 'a concrete integration artifact exists');
      record(outcome.cleanup.eligible ? 'PASS' : 'FAIL', 'cleanup eligibility is fail-closed positive', outcome.cleanup.reasons.join('; '));
      const nativesConfirmed = outcome.nativeRecords.length > 0 &&
        outcome.nativeRecords.every((r) => r.treeStopConfirmed && r.activeProcessesFinal === 0);
      record(nativesConfirmed ? 'PASS' : 'FAIL', 'every native control record confirms a tree stop with activeProcessesFinal=0', JSON.stringify(outcome.nativeRecords));
      if (!outcome.cleanup.eligible || !nativesConfirmed || !outcome.ok) retainOwned = true;
    }
  } finally {
    if (retainOwned) {
      process.stdout.write(`  RETAINED owned evidence (unconfirmed stop or failed run) at ${owned.root}\n`);
    } else {
      cleanupFailures = await owned.cleanup();
      for (const f of cleanupFailures) process.stdout.write(`  cleanup failure: ${f.resource}: ${f.error}\n`);
    }
  }

  writeReport({
    schema: 'b47-free-duo-entry/1', optIn: '1', status: 'RUN', code: null, detail: null,
    candidates: B47_CANDIDATE_PAIRS, limitations: B47_AUX_UNKNOWNS, ownedRoot: retainOwned ? owned.root : null,
    cleanupFailures, outcome,
  });
  writeHygieneReport();
  process.exitCode = finish(results, { allowEnvironmentBlocked: false, cleanupFailures });
  const anyFail = results.some((r) => r.verdict === 'FAIL');
  process.stdout.write(`\nB4.7.1 free-duo ENTRY: ${anyFail || cleanupFailures.length > 0 ? 'FAIL' : 'PASS'}\n`);
}

// Importing this module must not run anything. `main()` runs ONLY when this file is the
// process entry point, so a hermetic test may import the gate without real execution.
const isEntryPoint = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntryPoint) {
  await main();
}
