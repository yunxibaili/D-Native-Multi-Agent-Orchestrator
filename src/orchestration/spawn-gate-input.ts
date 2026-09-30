/**
 * src/orchestration/spawn-gate-input.ts — real Spawn Gate wiring.
 *
 * Phase 5B §12.2 found that `src/quota/index.ts` fed `evaluateSpawnGate` eight
 * hardcoded fields, so every branch except `multiAgentEnabled` had never been
 * exercised by real data. This module replaces those fakes with values read
 * from actual sources.
 *
 * The governing rule, applied without exception:
 *
 *   > A missing signal is a DENIAL, never a default `true`.
 *
 * This is the same discipline 4M-6 used for budget ("no ledger" must not read
 * as "zero remaining") and the same discipline 4M-8 used for usage ("unknown"
 * must not read as "0"). Every helper below returns an explicit
 * `{ ok: false, code, reason }` when its source is absent, and the caller
 * builds a gate input that DENIES rather than one that assumes health.
 *
 * This module only READS state and assembles an input. It makes no business
 * decision beyond "is this signal present and usable" — the policy verdict
 * belongs to `evaluateSpawnGate`, which is unchanged.
 */

import { evaluateSpawnGate } from '../quota/spawn-gate.ts';
import type { ModelRegistry } from '../quota/registry.ts';
import type { BudgetManager } from '../quota/budget.ts';
import type {
  AgentStatusRow,
  QuotaRecord,
  SpawnGateInput,
  SpawnGateResult,
  TaskType,
} from '../quota/types.ts';
import type { AgentDescriptor, WorkspaceMode } from '../core/types.ts';
import { modelKey } from '../quota/registry.ts';
import { isAllowedModel } from './model-pool.ts';

/** A signal we could not read, with the reason it is unusable. */
export interface MissingSignal {
  code: string;
  reason: string;
}

export type Signal<T> = { ok: true; value: T } | { ok: false; missing: MissingSignal };

const ok = <T>(value: T): Signal<T> => ({ ok: true, value });
const missing = (code: string, reason: string): Signal<never> => ({ ok: false, missing: { code, reason } });

/**
 * Real sources the gate reads. Every one of them is a real object from the
 * existing project; none is a literal.
 */
export interface SpawnGateSources {
  /** Multi-Agent is opt-in. Absent means OFF, and off means denied. */
  multiAgentEnabled: boolean;
  /** Every agent the orchestrator knows about, with its capabilities. */
  descriptors: readonly AgentDescriptor[];
  /** Per-agent install/probe state. Omitted entries are NOT assumed present. */
  agentStatus: readonly AgentStatusRow[];
  /** Real quota records, as probed. */
  quotaRecords: readonly QuotaRecord[];
  /** The real model registry. */
  registry: ModelRegistry;
  /** The real budget ledger holder. */
  budgets: BudgetManager;
  /** The task type the spawn is for; policy is evaluated per task type. */
  taskType: TaskType;
  /** Budget units this spawn wants to hold. */
  requestedUnits: number;
  /** How many children are live right now, and the cap. */
  currentConcurrency: number;
  /**
   * LEGACY single limit. Kept so existing 5C-1/2/3 callers keep compiling and,
   * more importantly, keep their EXACT previous behaviour: when neither
   * `maxChildren` nor `maxConcurrentAgents` is given, both resolve to this value.
   *
   * Deprecating it without a replacement would silently change every existing
   * caller's meaning, so it stays as the documented fallback rather than being
   * removed. Prefer the two explicit fields.
   */
  maxConcurrency: number;
  /**
   * `maxChildren` — how many non-terminal children may EXIST. Enforced on the
   * spawn admission path (fan-out), per 5B §22 ("Root 最多 3 个 child").
   *
   * Falls back to `maxConcurrency` when omitted.
   */
  maxChildren?: number;
  /**
   * `maxConcurrentAgents` — how many children may be RUNNING at once. Enforced
   * on the execute admission path, per 5B §22 ("并发上限").
   *
   * Falls back to `maxConcurrency` when omitted. Keeping these separate is what
   * lets a real queue exist: more children may be WAITING than are RUNNING.
   */
  maxConcurrentAgents?: number;
  /**
   * Optional caller policy. A caller that has no opinion passes `true`; the
   * gate itself is what enforces the structural limits.
   */
  taskPolicyAllows?: boolean;
  /**
   * P6-F: apply the ACTIVE free model pool to this spawn.
   *
   * OFF by default, deliberately. Enforcing it always would deny every model
   * outside the pool — including ones a user paid for — which would change the
   * existing paid-model / quota semantics that P6 forbids changing. The pool is
   * still always QUERYABLE via `resolveFreeModelPoolAdmission` / `isAllowedModel`.
   * P6-B assignment turns this on for free-worker candidates.
   */
  enforceFreeModelPool?: boolean;
}

/** What the builder learned, whether or not the gate allowed the spawn. */
export interface SpawnGateDecision {
  input: SpawnGateInput;
  result: SpawnGateResult;
  /** Signals that were absent. Non-empty means the denial is a data problem. */
  missing: readonly MissingSignal[];
  /** Human-readable trace of where each input field came from. */
  provenance: readonly string[];
}

export interface BuildSpawnGateInput {
  /** The child task being created. */
  taskId: string;
  agentId: string;
  modelId: string | null;
  /**
   * Budget units THIS spawn wants. Falls back to `sources.requestedUnits` only
   * when omitted, because a single static figure cannot represent children
   * with different budgets — the orchestrator always passes the request's own
   * `budgetUnits` so one child's allowance can never gate another.
   */
  requestedUnits?: number;
  sources: SpawnGateSources;
}

/**
 * Validate the requested amount itself.
 *
 * A negative or non-finite request is a caller bug, and a silent `0` turns
 * "ask for nothing" into "no budget needed", which then fails open against a
 * missing scope. Zero itself is legitimate: some work genuinely costs no units,
 * but it is judged against a REAL budget, never against an absent one.
 */
export function resolveRequestedUnits(raw: number | undefined): Signal<number> {
  if (raw === undefined) {
    return missing('invalid-budget-request', 'requestedUnits was not provided');
  }
  if (typeof raw !== 'number' || Number.isNaN(raw)) {
    return missing('invalid-budget-request', `requestedUnits must be a number, got ${String(raw)}`);
  }
  if (!Number.isFinite(raw)) {
    return missing('invalid-budget-request', `requestedUnits must be finite, got ${raw}`);
  }
  if (raw < 0) {
    return missing('invalid-budget-request', `requestedUnits must not be negative, got ${raw}`);
  }
  return ok(raw);
}

/**
 * Derive a real `taskPolicyAllows`.
 *
 * A task type is allowed when the (agent, model) entry is registered AND
 * advertises that task type. That is a fact about the registry, not a policy
 * opinion, so it belongs here rather than in a literal.
 */
export function resolveTaskPolicy(
  sources: Pick<SpawnGateSources, 'registry'> & { agentId: string; modelId: string | null; taskType: TaskType },
): Signal<boolean> {
  if (sources.modelId === null || sources.modelId === '') {
    // No model chosen yet: the caller has not finished deciding. Not a denial
    // of policy — a missing decision.
    return ok(false);
  }
  const entry = sources.registry.get(sources.agentId, sources.modelId);
  if (entry === null) {
    return ok(false);
  }
  return ok(entry.taskTypes.includes(sources.taskType));
}

/**
 * Whether the agent binary itself is confirmed present.
 *
 * `AgentStatusRow.installed` is the string `'Yes' | 'No' | 'Unknown'`. Only
 * `'Yes'` counts as available: `'Unknown'` means the provider was not probed,
 * which is a missing signal, not a yes.
 */
export function resolveAgentAvailability(
  sources: Pick<SpawnGateSources, 'agentStatus'> & { agentId: string },
): Signal<boolean> {
  const row = sources.agentStatus.find((a) => a.agent === sources.agentId);
  if (row === undefined) {
    return missing('agent-status-unavailable', `no install/probe status recorded for agent "${sources.agentId}"`);
  }
  if (row.installed !== 'Yes') {
    return missing(
      'agent-status-indeterminate',
      `install status for agent "${sources.agentId}" is "${row.installed}", not a confirmed Yes`,
    );
  }
  return ok(true);
}

/**
 * Whether the agent can serve the required task type at all.
 *
 * This is the capability-matrix check the Phase 5B design calls for: a reviewer
 * slot must not be filled by an agent whose adapter has no `review`
 * capability, no matter what its quota looks like.
 */
export function resolveCapability(
  sources: Pick<SpawnGateSources, 'descriptors'> & { agentId: string; taskType: TaskType },
): Signal<boolean> {
  const descriptor = sources.descriptors.find((d) => d.id === sources.agentId);
  if (descriptor === undefined) {
    return missing('capability-matrix-unavailable', `no descriptor registered for agent "${sources.agentId}"`);
  }
  if (sources.taskType === 'review') return ok(descriptor.capabilities.review);
  // implementation / research / test all require a working task entrypoint.
  return ok(descriptor.capabilities.newTask);
}

/**
 * Whether the agent may be admitted into the workspace mode the task needs.
 *
 * Phase 5C-6. The workspace IMPLEMENTATION (git worktrees) already existed from
 * 5C-5; what was missing is the admission question "may THIS agent be put in
 * one?". These are different things — worktrees work whether or not any agent
 * is allowed to use them — so capability is kept separate from implementation.
 *
 * Deliberately fail-closed, by the same rule as every other signal in this file:
 *
 *   > A missing signal is a DENIAL, never a default `true`.
 *
 * An agent with no `workspaceModes` declaration, or one that never mentions
 * `isolated`, is not placed in a worktree. `shared` needs no declaration: any
 * agent can run in a directory the caller named, which is simply what the system
 * did before 5C-6.
 *
 * Returned through the same `Signal` channel as the rest of the capability layer,
 * so a caller can tell "agent cannot do isolated workspaces" apart from an
 * unrelated `capability-missing`, via the namespaced code.
 */
export const WORKSPACE_CAPABILITY_MISSING = 'capability-missing:workspace-isolation';

export function resolveWorkspaceModeCapability(
  sources: Pick<SpawnGateSources, 'descriptors'> & { agentId: string; mode: WorkspaceMode },
): Signal<boolean> {
  const descriptor = sources.descriptors.find((d) => d.id === sources.agentId);
  if (descriptor === undefined) {
    return missing('capability-matrix-unavailable', `no descriptor registered for agent "${sources.agentId}"`);
  }
  // Fail-closed: an absent declaration is `shared` only, never a wildcard.
  const declared = descriptor.capabilities.workspaceModes ?? (['shared'] as const);
  if (declared.includes(sources.mode)) return ok(true);
  return missing(
    WORKSPACE_CAPABILITY_MISSING,
    `agent "${sources.agentId}" is not admitted into ${sources.mode} workspaces ` +
      `(supports: ${declared.join(', ') || 'none'})`,
  );
}

/** Model availability, read from the registry rather than assumed. */
export function resolveModelAvailability(
  sources: Pick<SpawnGateSources, 'registry'> & { agentId: string; modelId: string | null },
): Signal<boolean> {
  if (sources.modelId === null || sources.modelId === '') {
    return missing('model-unselected', 'no model was selected for this spawn');
  }
  const entry = sources.registry.get(sources.agentId, sources.modelId);
  if (entry === null) {
    return missing('model-not-registered', `"${modelKey(sources.agentId, sources.modelId)}" is not in the model registry`);
  }
  // `unknown` is NOT available. An unconfirmed model is exactly the case the
  // gate must refuse, because spawning would spend against a guess.
  return ok(entry.availability === 'available');
}

/** Missing codes unique to the P6-F pool, so a refusal says WHICH rule fired. */
export const MODEL_POOL_ERROR_CODES = [
  'model-not-in-free-pool',
  'model-free-pool-identity-mismatch',
] as const;

/**
 * P6-F: is this model an ACTIVE member of the free model pool?
 *
 * Pure. It reads no registry, no quota and no network — the pool is the only
 * input — so it stays correct regardless of what the registry happens to say.
 *
 * Fail-closed by construction: a model that is not positively listed is refused,
 * and an EMPTY model id is a refusal rather than a wildcard pass.
 *
 * Its two refusal codes are intentionally distinct from the availability path:
 * `resolveModelAvailability` resolves availability to `ok(false)` for an unknown
 * model and emits NO missing code, so "not in the pool" is always attributable.
 */
export function resolveFreeModelPoolAdmission(
  sources: { agentId: string; modelId: string | null },
): Signal<boolean> {
  const verdict = isAllowedModel({ agentId: sources.agentId, modelId: sources.modelId });
  if (verdict.allowed) return ok(true);
  if (verdict.reason === 'identity-mismatch') {
    return missing('model-free-pool-identity-mismatch', verdict.detail);
  }
  return missing('model-not-in-free-pool', verdict.detail);
}

/**
 * The agent's real quota status.
 *
 * A quota record that exists but is `not_fetched` / `unavailable` / `unknown`
 * is passed through honestly — `evaluateSpawnGate` already denies those, and
 * hiding them behind `available` here would defeat the gate entirely.
 */
export function resolveQuotaStatus(
  sources: Pick<SpawnGateSources, 'quotaRecords'> & { agentId: string },
): Signal<QuotaRecord['status']> {
  const records = sources.quotaRecords.filter((r) => r.agentId === sources.agentId);
  if (records.length === 0) {
    return missing('quota-record-absent', `no quota record for agent "${sources.agentId}"`);
  }
  // Any definite exhaustion is decisive.
  if (records.some((r) => r.status === 'exhausted')) return ok('exhausted');
  // Otherwise take the most recent observation, preferring a real one.
  const usable = records.filter((r) => r.status !== 'not_fetched' && r.status !== 'unknown');
  const chosen = (usable.length > 0 ? usable : records).reduce((a, b) =>
    b.observedAt >= a.observedAt ? b : a,
  );
  return ok(chosen.status);
}

/**
 * Real budget headroom across every scope that exists.
 *
 * The ledger holds independent `global` / `task` / `agent` ledgers. 5C-1 does
 * NOT modify Phase 4's BudgetLedger, so this reports the TIGHTEST real
 * remaining across the scopes it was given. A scope that was never allocated
 * is reported as unavailable rather than as zero-success: per §6 of the 5C-1
 * mandate, we must not pretend all three levels hold.
 */
export function resolveBudgetHeadroom(
  sources: Pick<SpawnGateSources, 'budgets'> & { agentId: string; taskId: string },
): Signal<{ remaining: number; scopes: readonly string[]; unavailable: readonly string[] }> {
  const wanted = ['global', `task:${sources.taskId}`, `agent:${sources.agentId}`];
  const remaining: number[] = [];
  const present: string[] = [];
  const absent: string[] = [];

  // Snapshot FIRST. `BudgetManager.task()` / `.agent()` are `getOrCreate`, so
  // touching them to ask "does this scope exist?" would CREATE it — turning a
  // missing scope into a real one with zero allocation, which is exactly the
  // "missing reads as 0" mistake this module exists to prevent.
  const existing = sources.budgets.snapshotAll();

  for (const scope of wanted) {
    const [kind, ...rest] = scope.split(':');
    const id = rest.join(':');
    const known =
      kind === 'global'
        ? existing.some((s) => s.scope === 'global')
        : existing.some((s) => s.scope === kind && s.id === id);
    if (!known) {
      absent.push(scope);
      continue;
    }
    // Only now is it safe to ask for the ledger: it is known to exist.
    const ledger =
      kind === 'global' ? sources.budgets.global
      : kind === 'task' ? sources.budgets.task(id)
      : sources.budgets.agent(id);
    present.push(scope);
    remaining.push(ledger.remaining());
  }

  if (absent.length === 0) {
    return ok({ remaining: Math.min(...remaining), scopes: present, unavailable: [] });
  }
  // ANY absent scope denies. We do not evaluate against the scopes that happen
  // to exist, because "two of three budgets hold" is not the same as "this
  // spawn is within budget" — and the 5C-1 mandate is explicit: when the
  // existing ledger cannot speak for all required scopes, say so rather than
  // pretend. `BudgetManager` always constructs a `global` ledger, so the
  // realistic case is always partial, never total.
  return missing(
    'budget-scope-unavailable',
    `no budget ledger for ${absent.join(', ')}; refusing to evaluate a spawn against only ${present.join(', ')}`,
  );
}

/**
 * Validate one of the two structural caps.
 *
 * Fail-closed: `undefined`, `NaN`, `Infinity`, negative and fractional values
 * are all refused. A cap that is silently coerced to 0 would deny everything;
 * one coerced to `Infinity` would allow everything. Neither is acceptable for a
 * limit, so an unusable value is reported as a MISSING signal and the gate
 * denies.
 */
export function resolveCap(raw: number | undefined, legacy: number, label: string, provided: boolean): Signal<number> {
  // An EXPLICITLY provided cap is authoritative, including when it is
  // `undefined`: that is a caller bug and must not silently become the legacy
  // value. Omitting the key entirely is the documented way to use the legacy
  // fallback, so the two are told apart by key presence rather than by value.
  const value = provided ? raw : legacy;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return missing('invalid-limit', `${label} must be a number, got ${String(value)}`);
  }
  if (!Number.isFinite(value)) {
    return missing('invalid-limit', `${label} must be finite, got ${value}`);
  }
  if (value < 0) {
    return missing('invalid-limit', `${label} must not be negative, got ${value}`);
  }
  if (!Number.isInteger(value)) {
    return missing('invalid-limit', `${label} must be a whole number, got ${value}`);
  }
  return ok(value);
}

/** The child fan-out cap (how many non-terminal children may exist). */
export function resolveMaxChildren(sources: SpawnGateSources): Signal<number> {
  return resolveCap(sources.maxChildren, sources.maxConcurrency, 'maxChildren', 'maxChildren' in sources);
}

/** The execution cap (how many children may be RUNNING at once). */
export function resolveMaxConcurrentAgents(sources: SpawnGateSources): Signal<number> {
  return resolveCap(sources.maxConcurrentAgents, sources.maxConcurrency, 'maxConcurrentAgents', 'maxConcurrentAgents' in sources);
}

/** Live child count vs the cap. */
export function resolveConcurrency(
  sources: { currentConcurrency: number; maxConcurrency: number },
): Signal<{ current: number; limit: number }> {
  if (!Number.isFinite(sources.maxConcurrency) || sources.maxConcurrency < 0) {
    return missing('concurrency-limit-invalid', `maxConcurrency must be a non-negative number, got ${sources.maxConcurrency}`);
  }
  if (!Number.isFinite(sources.currentConcurrency) || sources.currentConcurrency < 0) {
    return missing('concurrency-count-invalid', `currentConcurrency must be a non-negative number, got ${sources.currentConcurrency}`);
  }
  return ok({ current: sources.currentConcurrency, limit: sources.maxConcurrency });
}

/**
 * Assemble a `SpawnGateInput` from real sources and evaluate it.
 *
 * When a signal is missing, the corresponding gate field is set to its
 * DENYING value — never to a permissive default. `provenance` records where
 * each value came from so a denial can be explained rather than guessed at
 * (Phase 5B §19: "why was this agent selected?").
 */
export function buildSpawnGateInput(req: BuildSpawnGateInput): SpawnGateDecision {
  const s = req.sources;
  const missingSignals: MissingSignal[] = [];
  const provenance: string[] = [];
  const collect = <T>(signal: Signal<T>, label: string): T | null => {
    if (signal.ok) {
      provenance.push(`${label}=ok`);
      return signal.value;
    }
    missingSignals.push(signal.missing);
    provenance.push(`${label}=MISSING(${signal.missing.code})`);
    return null;
  };

  // ---- capability + availability ----------------------------------------
  const capability = collect(
    resolveCapability({ descriptors: s.descriptors, agentId: req.agentId, taskType: s.taskType }),
    'capabilitySatisfied',
  );
  const agentAvailable = collect(
    resolveAgentAvailability({ agentStatus: s.agentStatus, agentId: req.agentId }),
    'agentAvailable',
  );
  const modelAvailable = collect(
    resolveModelAvailability({ registry: s.registry, agentId: req.agentId, modelId: req.modelId }),
    'modelAvailable',
  );
  const taskPolicyAllows = collect(
    resolveTaskPolicy({
      registry: s.registry,
      agentId: req.agentId,
      modelId: req.modelId,
      taskType: s.taskType,
    }),
    'taskPolicyAllows',
  );

  // ---- P6-F: free model pool (opt-in, fail-closed when enabled) ----------
  // The pool is ALWAYS queryable (`resolveFreeModelPoolAdmission` is exported and
  // side-effect free). Whether the gate APPLIES it is a caller decision, because
  // enforcing it by default would deny every non-pool model — including models a
  // user has deliberately paid for — which would change existing paid-model /
  // quota semantics, which P6 explicitly forbids. P6-B assignment is what turns
  // this on for free-worker candidates.
  //
  // `SpawnGateInput` is sealed (src/quota/types.ts), so the verdict is carried the
  // way this module already carries every unresolvable signal: a DISTINCT missing
  // code for the reason, plus a denying boolean on the existing model signal. That
  // keeps "not in the pool" distinguishable from "availability unknown" — the
  // latter resolves to ok(false) and therefore produces NO missing code at all.
  const freeModelPoolAllows = s.enforceFreeModelPool === true
    ? collect(resolveFreeModelPoolAdmission({ agentId: req.agentId, modelId: req.modelId }), 'freeModelPoolAllows')
    : ok(true);
  const poolDenied = freeModelPoolAllows === null;
  provenance.push(
    s.enforceFreeModelPool === true
      ? `freeModelPoolAllows=${freeModelPoolAllows ?? 'DENIED (missing -> denied)'}`
      : 'freeModelPoolAllows=true (pool consulted but NOT enforced for this spawn)',
  );

  // ---- quota -------------------------------------------------------------
  const quota = collect(resolveQuotaStatus({ quotaRecords: s.quotaRecords, agentId: req.agentId }), 'quota.status');
  provenance.push(`quota.status=${quota ?? 'unavailable (missing -> denied)'}`);

  // ---- the amount this specific spawn is asking for -----------------------
  // An EXPLICITLY provided `requestedUnits` is authoritative, including when it
  // is `undefined` — that is a caller bug and must be refused rather than
  // silently falling back. Omitting the key entirely is the documented way to
  // use the sources' default, so the two cases are distinguished by key
  // presence rather than by value.
  const requestedRaw = 'requestedUnits' in req ? req.requestedUnits : s.requestedUnits;
  const requested = collect(
    resolveRequestedUnits(requestedRaw),
    'budget.requested',
  );
  provenance.push(`budget.requested=${requested ?? 'invalid'}`);

  // ---- budget availability ------------------------------------------------
  const budget = collect(
    resolveBudgetHeadroom({ budgets: s.budgets, agentId: req.agentId, taskId: req.taskId }),
    'budget.remaining',
  );
  provenance.push(
    `budget.scopes=${budget?.scopes.join('+') ?? 'none'}` +
      (budget && budget.unavailable.length > 0 ? ` budget.unavailable=${budget.unavailable.join('+')}` : ''),
  );

  // ---- concurrency -------------------------------------------------------
  const concurrency = collect(
    resolveConcurrency({ currentConcurrency: s.currentConcurrency, maxConcurrency: s.maxConcurrency }),
    'concurrency',
  );
  provenance.push(`concurrency=${concurrency ? `${concurrency.current}/${concurrency.limit}` : 'missing'}`);

  // A budget we could not read, or a request we could not accept, is a
  // FAIL-CLOSED condition. Both are forced into a comparison that cannot pass,
  // and are then re-asserted on the verdict below.
  const budgetUnavailable = budget === null;
  const requestInvalid = requested === null;

  // Every absent signal collapses to its DENYING value. A gate that receives
  // `capabilitySatisfied: true` for an agent we could not look up would be
  // spending money on an assumption.
  const input: SpawnGateInput = {
    multiAgentEnabled: s.multiAgentEnabled,
    taskPolicyAllows: s.taskPolicyAllows ?? taskPolicyAllows ?? false,
    capabilitySatisfied: capability ?? false,
    agentAvailable: agentAvailable ?? false,
    // A pool denial forces the model signal false even when the registry says the
    // model is available: "available" and "allowed as a free worker" are different
    // questions, and only the second one is what this pool decides.
    modelAvailable: poolDenied ? false : modelAvailable ?? false,
    quota: { status: quota ?? 'unknown' },
    // `remaining: 0` with `requested: 0` would satisfy `requested > remaining`
    // as false and read as ALLOWED — that is the fail-open this guards. When the
    // budget cannot be read the request is floored at 1 so the comparison can
    // only fail, and the verdict is re-asserted immediately below.
    budget: {
      remaining: budget?.remaining ?? 0,
      requested: budgetUnavailable || requestInvalid ? Math.max(1, requested ?? 1) : (requested as number),
    },
    concurrency: concurrency ?? { current: Number.MAX_SAFE_INTEGER, limit: Number.MAX_SAFE_INTEGER },
  };

  const verdict = evaluateSpawnGate(input);

  // Method A: when the budget could not be read, or the request is not a usable
  // number, the honest verdict is produced HERE rather than by the gate's
  // `requested > remaining` comparison — that comparison cannot express "there
  // is no number to compare", and a floored request would report an ordinary
  // budget shortfall for what is actually an absent ledger.
  //
  // A denial that the gate reached EARLIER (multi-agent off, policy, capability,
  // agent, model, quota) is kept instead: it is the more fundamental reason, and
  // the budget problem is still listed in `missing`.
  const EARLIER_THAN_BUDGET: ReadonlySet<string> = new Set([
    'multi-agent-not-implemented',
    'task-policy-denied',
    'capability-missing',
    'agent-unavailable',
    'model-unavailable',
    'quota-unavailable',
    'quota-exhausted',
  ]);

  const budgetBlockReason = (() => {
    if (budgetUnavailable) {
      return 'budget-scope-unavailable: no ledger exists for every required scope, so this spawn cannot be shown to be within budget';
    }
    if (requestInvalid) {
      return 'invalid-budget-request: the requested amount is missing or not a usable number, so the request is refused rather than assumed free';
    }
    return null;
  })();

  const supersededByEarlierDenial =
    !verdict.allowed && EARLIER_THAN_BUDGET.has(verdict.code);

  if (budgetBlockReason !== null && !supersededByEarlierDenial) {
    return {
      input,
      result: { allowed: false, code: 'budget-insufficient', reason: budgetBlockReason },
      missing: missingSignals,
      provenance,
    };
  }

  return {
    input,
    result: verdict,
    missing: missingSignals,
    provenance,
  };
}
