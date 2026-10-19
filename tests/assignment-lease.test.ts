/**
 * tests/assignment-lease.test.ts - R2-2 §6: the Assignment Lease lifecycle, fencing,
 * and the F5 guarantee that a refused execution still leaves evidence.
 *
 * THE CLAIMS UNDER TEST
 * ---------------------
 *   L1  a lease is minted FROM the task's own record, never independently
 *   L2  identity change / migration / terminal each revoke and re-issue
 *   L3  renewal is explicit, bounded, and can never resurrect a revoked lease
 *   L4  fencing is fail-closed, and each rejection is separately attributable
 *   L5  a revoked or expired lease cannot authorise a write-back
 *   F1  a refused execution's attempt id reaches `attemptIdsByTask`
 *   F5  "the runtime never started" and "it ran and the write-back was refused" are
 *       different facts, recorded differently, and never conflated
 *   RC  a resource claim is bound to a live lease and dies with it
 *
 * WHY THE INTEGRATION CASES ARE PRODUCTION-SHAPED
 * ----------------------------------------------
 * Every Case A-D below goes through the REAL `Orchestrator.executeTask` -> real spawn
 * gate -> real `TaskStore` -> real `AttemptStore` path. A test that only exercised
 * `checkFencing` in isolation would pass while the production wiring dropped the lease
 * on the floor, which is exactly the class of bug this contract exists to prevent. The
 * pure-function section above is therefore deliberately kept small and is not treated
 * as evidence for the lifecycle claims.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  claimLeaseVersionOf,
  validateWriteback,
  checkFencing,
  DEFAULT_RENEW_POLICY,
  isLeaseLive,
  issueLease,
  activateLease,
  mintFencingToken,
  modelKeyOf,
  renewLease,
  revokeLease,
  FENCING_REJECT_CODES,
} from '../src/orchestration/assignment-lease.ts';
import { claimIsLeaseCurrent, ResourceClaimBook, type ResourceClaim } from '../src/orchestration/resource-claim.ts';
import { Orchestrator } from '../src/orchestration/orchestrator.ts';
import { TaskStore } from '../src/orchestration/store.ts';
import { AttemptStore } from '../src/orchestration/attempt-store.ts';
import { recordExecutions } from '../src/orchestration/attempt-integration.ts';
import { recordAndBindOutcome } from './helpers/p01-binding.ts';
import { validateAttemptRecord } from '../src/orchestration/attempt-record.ts';
import { modelKey } from '../src/quota/registry.ts';
import { BudgetManager } from '../src/quota/budget.ts';
import { ModelRegistry } from '../src/quota/registry.ts';
import type { AgentDescriptor, RunHandle, RunRequest, RunResult } from '../src/core/types.ts';
import type { RuntimeRunner } from '../src/orchestration/execute.ts';
import type { TickResult } from '../src/orchestration/scheduler.ts';
import type { QuotaRecord, TaskType } from '../src/quota/types.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` - ${detail}` : ''}`);
    process.stdout.write(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}\n`);
  }
}
function section(t: string): void {
  process.stdout.write(`\n== ${t} ==\n`);
}

const NOW = 1_700_000_000_000;
const now = () => NOW;
const AGENT = 'opencode';
const OTHER = 'workbuddy-intl';
const SB = 'opencode/space-bunny-free';
const impl: TaskType = 'implementation';

// ---------------------------------------------------------------------------
// Gate harness - the same shape production uses (mirrors attempt-record.test.ts)
// ---------------------------------------------------------------------------

const descriptor = (id: string): AgentDescriptor => ({
  id, displayName: id, launcher: { command: 'x', args: [], shell: false } as never,
  transport: 'cli-jsonl',
  capabilities: {
    newTask: true, resume: true, review: false, modelSelection: true, roleSelection: true,
    sandbox: false, streamEvents: true, costReporting: false, extraArgs: true, cwd: true,
    skills: false, steering: false, worktree: false, fork: false, stdinPrompt: false,
    workspaceModes: ['shared'],
  } as AgentDescriptor['capabilities'],
});

const quotaRecord = (a: string, s: QuotaRecord['status']): QuotaRecord => ({
  provider: a, agentId: a, modelId: null, source: 'locally_observed', usage: null,
  remaining: null, resetAt: null, period: 'day', status: s,
  usageClass: 'observed', confidence: 'high', observedAt: NOW, note: '',
});

const gateSources = (taskIds: readonly string[], agents: readonly string[] = [AGENT]) => {
  const budgets = new BudgetManager(100_000);
  for (const t of taskIds) budgets.task(t, 10_000);
  for (const a of agents) budgets.agent(a, 10_000);
  const registry = new ModelRegistry();
  for (const a of agents) {
    const modelId = a === AGENT ? SB : 'hy3';
    registry.upsert({ agentId: a, modelId, provider: 'test', taskTypes: [impl] as never, modelSource: 'test', quotaSource: 'test' }, NOW);
    registry.setAgentAvailability(a, 'available');
  }
  return {
    descriptors: agents.map(descriptor),
    agentStatus: agents.map((a) => ({ agentId: a, agent: a, version: '1', installed: 'Yes', login: 'n', quotaSource: 't', usage: 'n', status: 'ok' } as never)),
    quotaRecords: agents.map((a) => quotaRecord(a, 'available')),
    registry,
    budgets,
    taskType: impl, requestedUnits: 100, currentConcurrency: 0,
    maxConcurrency: 4, maxChildren: 8, maxConcurrentAgents: 4,
  } as never;
};

/** A run result that reports success, attributed to whichever agent ran it. */
const okResult = (agentId: string, i = 1): RunResult => ({
  taskId: `rt-${i}`, agentId, state: 'succeeded',
  error: null, startedAt: 100, endedAt: 200 + i, exitCode: 0, signal: null,
  output: '', outputTruncated: false, transcriptPath: null,
  usage: { costUsd: 0 }, toolCalls: [], diagnostics: [],
  cleanup: { killed: false, orphans: 0, method: 'none' },
} as unknown as RunResult);

/**
 * P0-1: the approved completion contract these coding fixtures carry. The immediate
 * runtime REALLY writes the named artifact into the run cwd, so a coding task the
 * fixture dispatches is genuinely completable (a controlled fake-runtime delivery).
 */
const COMPLETION = {
  expectedArtifacts: ['out.txt'],
  allowedScope: ['out.txt'],
  test: { executable: 'node', argv: ['-e', 'process.exit(0)'], cwd: '.' },
};

/** An immediate runtime: the run is over before `executeTask` can be interrupted. */
function immediateRuntime(agentId = AGENT): { runtime: RuntimeRunner; requests: RunRequest[] } {
  const requests: RunRequest[] = [];
  let i = 0;
  const runtime: RuntimeRunner = {
    run(req: RunRequest): RunHandle {
      requests.push(req);
      i++;
      try { writeFileSync(join(req.cwd, 'out.txt'), 'ok\n', 'utf8'); } catch { /* synthetic cwd in non-completion tests */ }
      const result = okResult(agentId, i);
      return { result: async () => result, cancel: async () => {}, dispose: async () => {} } as unknown as RunHandle;
    },
  };
  return { runtime, requests };
}

/**
 * A runtime whose result resolves only when the test says so.
 *
 * This is what makes the races reachable at all: the reassignment / revocation has to
 * happen while the run is genuinely in flight, and a runtime that returns instantly
 * leaves no window to do it in.
 */
function deferredRuntime(): {
  runtime: RuntimeRunner;
  requests: RunRequest[];
  settle: (r: RunResult) => void;
} {
  const requests: RunRequest[] = [];
  let release: (r: RunResult) => void = () => {};
  const gate = new Promise<RunResult>((resolve) => { release = resolve; });
  const runtime: RuntimeRunner = {
    run(req: RunRequest): RunHandle {
      requests.push(req);
      return { result: async () => gate, cancel: async () => {}, dispose: async () => {} } as unknown as RunHandle;
    },
  };
  return { runtime, requests, settle: (r) => release(r) };
}

const tmpDir = (): string => mkdtempSync(join(tmpdir(), 'r22-lease-'));

/** Read a `src/**` file, for the source-level assertions. */
const read = (rel: string): string => readFileSync(join('src', ...rel.split('/')), 'utf8');

/**
 * Source with comments and string literals removed.
 *
 * These assertions ask whether a capability or a fallback is ABSENT, and every one of
 * them would otherwise match this file's own explanatory prose ("no heartbeat", "was
 * dispatched under agent ..."). Stripping literals makes them test code rather than
 * comments.
 */
const codeOf = (text: string): string => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '')
  .replace(/`(?:[^`\\]|\\.)*`/g, '``')
  .replace(/'(?:[^'\\]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\]|\\.)*"/g, '""');

/** Every `src/**\/*.ts` file, for the source-level topology assertions. */
const sourceFiles: string[] = (() => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) out.push(p);
    }
  };
  walk('src');
  return out;
})();

// ===========================================================================
section('R2-2 L1: the lease is minted FROM the task, never independently');
// ===========================================================================
{
  const nonce = 'fixed-nonce-for-test';
  const token = mintFencingToken({ taskId: 't1', leaseVersion: 3, agentId: AGENT, modelKey: modelKeyOf(AGENT, SB), nonce });
  check('a token is bound to the version it names', token.startsWith('fence-3-'), token.slice(0, 20));
  check('minting is deterministic for a fixed nonce',
    token === mintFencingToken({ taskId: 't1', leaseVersion: 3, agentId: AGENT, modelKey: modelKeyOf(AGENT, SB), nonce }));
  check('a different version yields a different token',
    token !== mintFencingToken({ taskId: 't1', leaseVersion: 4, agentId: AGENT, modelKey: modelKeyOf(AGENT, SB), nonce }));
  check('a different agent yields a different token',
    token !== mintFencingToken({ taskId: 't1', leaseVersion: 3, agentId: OTHER, modelKey: modelKeyOf(OTHER, 'hy3'), nonce }));
  check('the digest is NUL-separated, so fields cannot be re-partitioned',
    token !== mintFencingToken({ taskId: 't1x', leaseVersion: 3, agentId: AGENT, modelKey: modelKeyOf(AGENT, SB), nonce }));

  // §6.1: the model key is the sealed registry's, not a second spelling.
  check('modelKeyOf reuses the registry format', modelKeyOf(AGENT, SB) === modelKey(AGENT, SB), modelKeyOf(AGENT, SB));
  check('a task with no model is spelled explicitly, not faked',
    modelKeyOf(AGENT, null) === `${AGENT}::default`, modelKeyOf(AGENT, null));

  const store = new TaskStore();
  const created = store.create({ taskId: 't1', parentTaskId: null, agentId: AGENT, modelId: SB, taskType: impl, acceptanceCriteria: 'x' }, NOW);
  check('a created task has a lease', created.ok && store.leaseOf('t1') !== null);
  const lease = store.leaseOf('t1')!;
  const task = store.get('t1')!;
  check('L1: the lease carries the TASK\'s token, not one of its own',
    lease.fencingToken === task.fencingToken, `${lease.fencingToken} vs ${task.fencingToken}`);
  check('L1: the lease carries the task\'s version', lease.leaseVersion === task.leaseVersion);
  check('L1: the lease binds task + agent identity',
    lease.taskId === 't1' && lease.agentId === AGENT);
  check('L1: the lease binds the (agent, model) identity', lease.modelKey === modelKey(AGENT, SB), lease.modelKey);
  check('a fresh lease is issued, not active', lease.status === 'issued');
  check('the lease expires within the round ttl', lease.expiresAt === NOW + DEFAULT_RENEW_POLICY.ttlMs);

  // A lease minted independently could never fence-match its own task. Prove the
  // record and the task agree by running the real check with the lease's own values.
  const verdict = checkFencing(
    { agentId: task.agentId, modelId: task.modelId, leaseVersion: task.leaseVersion, fencingToken: task.fencingToken },
    { agentId: lease.agentId, leaseVersion: lease.leaseVersion, fencingToken: lease.fencingToken },
  );
  check('L1: a lease presented from its own task is ACCEPTED (the two agree)', verdict.accepted === true,
    verdict.accepted === false ? verdict.reason : '');
}

// ===========================================================================
section('R2-2 L3: explicit, bounded renewal');
// ===========================================================================
{
  const lease = issueLease({
    taskId: 't1', agentId: AGENT, modelId: SB, leaseVersion: 1,
    fencingToken: 'fence-1-abc', now: NOW,
  });
  check('activateLease moves issued -> active', activateLease(lease, NOW).status === 'active');
  check('activateLease RE-ANCHORS the deadline to the execution window',
    activateLease(lease, NOW + 10 * 60_000).expiresAt === NOW + 10 * 60_000 + DEFAULT_RENEW_POLICY.ttlMs);
  check('activateLease is a no-op once renewed (once per lease, so it cannot heartbeat)',
    activateLease({ ...lease, status: 'renewed' }, NOW).status === 'renewed');
  check('activateLease never resurrects a revoked lease',
    activateLease(revokeLease(lease, 'x'), NOW).status === 'revoked');

  const r1 = renewLease(lease, NOW + 1000);
  check('a live lease renews', r1.ok === true);
  if (r1.ok) {
    check('a renewal EXTENDS the deadline', r1.lease.expiresAt === NOW + 1000 + DEFAULT_RENEW_POLICY.ttlMs);
    check('a renewal is not a new grant: same token', r1.lease.fencingToken === lease.fencingToken);
    check('a renewal is not a new grant: same version', r1.lease.leaseVersion === lease.leaseVersion);
    check('the renewal is counted', r1.lease.renewals === 1);
    // Exhausting the bound is what keeps this a bounded round rather than a worker.
    const r2 = renewLease(r1.lease, NOW + 2000);
    const r3 = r2.ok ? renewLease(r2.lease, NOW + 3000) : r2;
    check('renewal is BOUNDED and then refuses', r3.ok === false && r3.code === 'renewal-budget-exhausted',
      r3.ok ? 'still renewable' : r3.code);
    check('the refusal explains it would be a persistent worker',
      r3.ok === false && /persistent worker/i.test(r3.reason));
  }

  const expired = renewLease(lease, NOW + DEFAULT_RENEW_POLICY.ttlMs + 1);
  check('an expired lease cannot be renewed', expired.ok === false && expired.code === 'lease-expired',
    expired.ok ? 'renewed' : expired.code);

  const revoked = renewLease(revokeLease(lease, 'reassigned'), NOW + 1);
  check('a revoked lease cannot be renewed', revoked.ok === false && revoked.code === 'lease-not-renewable',
    revoked.ok ? 'renewed' : revoked.code);
}

// ===========================================================================
section('R2-2 L2: revoke is final (Race 3: renew cannot rescue it)');
// ===========================================================================
{
  const lease = issueLease({ taskId: 't1', agentId: AGENT, modelId: SB, leaseVersion: 1, fencingToken: 'fence-1-a', now: NOW });
  const revoked = revokeLease(lease, 'reassigned to workbuddy-intl');
  check('revoke records why', revoked.status === 'revoked' && /workbuddy/.test(revoked.revokedReason ?? ''));
  check('a revoked lease is not live', isLeaseLive(revoked, NOW) === false);

  const again = revokeLease(revoked, 'a vaguer later reason');
  check('revoke is idempotent', again.status === 'revoked');
  check('the FIRST reason is kept, so the audit trail cannot be overwritten',
    again.revokedReason === revoked.revokedReason, again.revokedReason);

  // The race itself: a renewal computed from a pre-revoke lease, applied after revoke.
  const storeBased = renewLease(lease, NOW + 10);
  check('pre-revoke lease would have renewed', storeBased.ok === true);
  const raced = storeBased.ok ? { ...revokeLease(storeBased.lease, 'raced'), } : null;
  check('and revoke applied afterwards still wins', raced !== null && raced.status === 'revoked');
  check('the store refuses to renew a revoked lease',
    (() => { const s = new TaskStore(); s.create({ taskId: 'x', parentTaskId: null, agentId: AGENT, taskType: impl, acceptanceCriteria: 'x' }, NOW);
      s.revokeLeaseFor('x', 'manual');
      return s.renewLeaseFor('x', NOW + 1).ok === false; })());
}

// ===========================================================================
section('R2-2 L2: identity change / migration / terminal each revoke + re-issue');
// ===========================================================================
{
  const store = new TaskStore();
  store.create({ taskId: 't', parentTaskId: null, agentId: AGENT, modelId: SB, taskType: impl, acceptanceCriteria: 'x' }, NOW);
  const v1 = store.leaseOf('t')!;

  const reassigned = store.assignIdentity('t', OTHER, 'hy3', NOW + 10);
  check('a reassignment is accepted', reassigned.ok);
  const v2 = store.leaseOf('t')!;
  check('the reassignment advanced the lease version', v2.leaseVersion === v1.leaseVersion + 1, `${v1.leaseVersion} -> ${v2.leaseVersion}`);
  check('the reassignment re-minted the credential', v2.fencingToken !== v1.fencingToken);
  check('the reassigned lease names the NEW agent', v2.agentId === OTHER && v2.modelKey === modelKey(OTHER, 'hy3'));
  check('the new lease is bound to the task\'s new token', v2.fencingToken === store.get('t')!.fencingToken);
  check('re-issuing does NOT leave the old holder live', isLeaseLive(v1, NOW + 10) === false || v1.status !== 'active');

  // Same identity is idempotent and must NOT churn the lease.
  const same = store.assignIdentity('t', OTHER, 'hy3', NOW + 20);
  check('re-assigning the same identity is idempotent', same.ok && store.leaseOf('t')!.leaseVersion === v2.leaseVersion);

  store.transition('t', 'queued', NOW + 30);
  store.transition('t', 'running', NOW + 40);
  const migrated = store.migrateIdentityAfterStart('t', { agentId: AGENT, modelId: SB, reason: 'better worker' }, NOW + 50);
  check('a migration is accepted', migrated.ok);
  const v3 = store.leaseOf('t')!;
  check('the migration advanced the lease version', v3.leaseVersion === v2.leaseVersion + 1);
  check('the migration re-minted the credential', v3.fencingToken !== v2.fencingToken);

  // Terminal revoke, via the ONLY place status is written.
  const toVerify = store.transition('t', 'to_verify', NOW + 60);
  check('the task can still reach to_verify', toVerify.ok);
  check('to_verify does NOT revoke: the work is not finished', store.leaseOf('t')!.status !== 'revoked');
  store.transition('t', 'succeeded', NOW + 70);
  const finalLease = store.leaseOf('t')!;
  check('a terminal task revokes its lease (Race 5)', finalLease.status === 'revoked', finalLease.status);
  check('the revoke names the terminal status', /terminal status succeeded/.test(finalLease.revokedReason ?? ''), finalLease.revokedReason);
  check('a terminal lease is not live', isLeaseLive(finalLease, NOW + 70) === false);
  check('liveLeases excludes it', store.liveLeases(NOW + 70).every((l) => l.taskId !== 't'));
}

// ===========================================================================
section('R2-2 §4.1: session audit linkage stays with SessionRegistry');
// ===========================================================================
{
  const store = new TaskStore();
  store.create({ taskId: 't', parentTaskId: null, agentId: AGENT, taskType: impl, acceptanceCriteria: 'x' }, NOW);
  check('a lease starts with no session', store.leaseOf('t')!.sessionId === null);
  const attached = store.attachLeaseSession('t', 'ws_0007');
  check('the lease records the session id for audit', attached?.sessionId === 'ws_0007');
  check('attaching a session does not change the credential', store.leaseOf('t')!.fencingToken === store.get('t')!.fencingToken);
  check('attaching a session does not change the version', store.leaseOf('t')!.leaseVersion === store.get('t')!.leaseVersion);
  check('an unknown task has no lease to attach to', store.attachLeaseSession('nope', 'ws_1') === null);
}

// ===========================================================================
section('R2-2 L4: fencing is fail-closed, each rejection separately attributable');
// ===========================================================================
{
  const CURRENT = { agentId: AGENT, modelId: SB, leaseVersion: 4, fencingToken: 'fence-4-current' };
  const ok = checkFencing(CURRENT, { agentId: AGENT, leaseVersion: 4, fencingToken: 'fence-4-current' });
  check('a current holder is accepted', ok.accepted === true);

  const noAgent = checkFencing({ ...CURRENT, agentId: '' }, { agentId: AGENT, leaseVersion: 4, fencingToken: 'fence-4-current' });
  check('agent-mismatch: the task names no agent',
    noAgent.accepted === false && noAgent.code === 'agent-mismatch', noAgent.accepted ? 'accepted' : noAgent.code);

  const wrongPresenter = checkFencing(CURRENT, { agentId: OTHER, leaseVersion: 4, fencingToken: 'fence-4-current' });
  check('agent-mismatch: the presenter is not the current holder',
    wrongPresenter.accepted === false && wrongPresenter.code === 'agent-mismatch', wrongPresenter.accepted ? 'accepted' : wrongPresenter.code);
  check('the agent-mismatch reason names BOTH agents',
    wrongPresenter.accepted === false && wrongPresenter.reason.includes(AGENT) && wrongPresenter.reason.includes(OTHER));

  const noLeaseOnRecord = checkFencing({ ...CURRENT, leaseVersion: undefined, fencingToken: undefined },
    { agentId: AGENT, leaseVersion: 4, fencingToken: 'fence-4-current' });
  check('fencing-token-missing: the record has no lease at all',
    noLeaseOnRecord.accepted === false && noLeaseOnRecord.code === 'fencing-token-missing',
    noLeaseOnRecord.accepted ? 'accepted' : noLeaseOnRecord.code);

  const presentedNothing = checkFencing(CURRENT, undefined);
  check('fencing-token-missing: the caller presented nothing',
    presentedNothing.accepted === false && presentedNothing.code === 'fencing-token-missing',
    presentedNothing.accepted ? 'accepted' : presentedNothing.code);

  const stale = checkFencing(CURRENT, { agentId: AGENT, leaseVersion: 3, fencingToken: 'fence-3-old' });
  check('stale-lease-version: an older version is refused',
    stale.accepted === false && stale.code === 'stale-lease-version', stale.accepted ? 'accepted' : stale.code);

  const future = checkFencing(CURRENT, { agentId: AGENT, leaseVersion: 5, fencingToken: 'fence-5-ahead' });
  check('a version NEWER than the record is also refused',
    future.accepted === false && future.code === 'stale-lease-version', future.accepted ? 'accepted' : future.code);

  const badToken = checkFencing(CURRENT, { agentId: AGENT, leaseVersion: 4, fencingToken: 'fence-4-impostor' });
  check('fencing-token-mismatch: right version, wrong token',
    badToken.accepted === false && badToken.code === 'fencing-token-mismatch', badToken.accepted ? 'accepted' : badToken.code);

  check('the reject-code set is exactly the four documented codes',
    JSON.stringify([...FENCING_REJECT_CODES].sort()) ===
    JSON.stringify(['agent-mismatch', 'fencing-token-mismatch', 'fencing-token-missing', 'stale-lease-version']),
    JSON.stringify([...FENCING_REJECT_CODES]));
}

// ===========================================================================
section('R2-2 RC: a resource claim is bound to a live lease and dies with it');
// ===========================================================================
{
  const book = new ResourceClaimBook(now);
  const taken = book.claim({ taskId: 'a', workspaceId: 'ws1', mode: 'write', scope: { kind: 'directory', path: '/repo' }, leaseVersion: 2 });
  check('a claim is taken with the lease version it was bound to',
    taken.ok && taken.claim.leaseVersion === 2, taken.ok ? String(taken.claim.leaseVersion) : taken.code);
  const claim = taken.ok ? taken.claim : ({} as ResourceClaim);

  check('a claim matching the current lease is current', claimIsLeaseCurrent(claim, 2) === true);
  check('a claim whose lease has advanced is NOT current', claimIsLeaseCurrent(claim, 3) === false);
  check('an unbound claim cannot be shown to hold a live lease', claimIsLeaseCurrent({ ...claim, leaseVersion: null }, 2) === false);
  check('and there is no current version to match against', claimIsLeaseCurrent(claim, null) === false);

  // Race 4: the held set is voided before it is consulted, so a stale claim stops
  // blocking AND stops conferring write eligibility.
  const voided = book.voidClaimsWhere((c) => !claimIsLeaseCurrent(c, 3));
  check('a superseded claim is voided', voided === 1, String(voided));
  check('the voided claim is gone from the book', book.all().length === 0);
  check('and it no longer conflicts with anyone', book.wouldConflict({
    taskId: 'b', workspaceId: 'ws1', mode: 'write', scope: { kind: 'directory', path: '/repo' }, leaseVersion: 3,
  }).length === 0);

  // claimLeaseVersionOf is the binding gate: a dead lease cannot be bound at all.
  const live = issueLease({ taskId: 'a', agentId: AGENT, modelId: SB, leaseVersion: 2, fencingToken: 'f2', now: NOW });
  const dead = revokeLease(live, 'terminal');
  check('claimLeaseVersionOf binds a live lease', claimLeaseVersionOf(live, NOW) === 2);
  check('claimLeaseVersionOf refuses a revoked lease', claimLeaseVersionOf(dead, NOW) === null);
  check('claimLeaseVersionOf refuses an expired lease',
    claimLeaseVersionOf(live, live.expiresAt + 1) === null);
  check('claimLeaseVersionOf of no lease is null', claimLeaseVersionOf(null, NOW) === null);
}

// ===========================================================================
section('R2-2 F1/F5 + L5: production-shaped execution, reassigned mid-run (Race 1)');
// ===========================================================================
{
  const dir = tmpDir();
  const store = new TaskStore();
  const evidence = new AttemptStore();
  const { runtime, requests, settle } = deferredRuntime();
  const orch = new Orchestrator({ store, gate: gateSources(['c1'], [AGENT, OTHER]), runtime, now, defaultCwd: dir });
  orch.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' });
  const spawned = orch.spawnChild({ taskId: 'c1', parentTaskId: 'r', agentId: AGENT, modelId: SB, taskType: impl, acceptanceCriteria: 'child', budgetUnits: 10 });
  check('the child was admitted through the real spawn gate', spawned.ok, spawned.ok ? '' : `${spawned.code} ${spawned.reason}`);

  const leaseBefore = store.leaseOf('c1')!;
  check('the assignment issued a lease at version 1', leaseBefore.leaseVersion === 1, String(leaseBefore.leaseVersion));

  const inflight = orch.executeTask({ taskId: 'c1' });
  // Let executeTask reach the runtime before the world changes underneath it.
  await new Promise((r) => setTimeout(r, 20));
  check('the runtime was actually asked to run', requests.length === 1, `requests=${requests.length}`);

  // Race 1: the task is reassigned WHILE the run is in flight.
  const migrated = store.migrateIdentityAfterStart('c1', { agentId: OTHER, modelId: 'hy3', reason: 'moved to a free worker' }, NOW + 10);
  check('the mid-run reassignment is accepted', migrated.ok);
  const leaseAfter = store.leaseOf('c1')!;
  check('the new assignment holds a NEW lease version', leaseAfter.leaseVersion === 2, String(leaseAfter.leaseVersion));
  check('the previous holder can no longer write back',
    checkFencing(
      { agentId: OTHER, modelId: 'hy3', leaseVersion: store.get('c1')!.leaseVersion, fencingToken: store.get('c1')!.fencingToken },
      { agentId: AGENT, leaseVersion: leaseBefore.leaseVersion, fencingToken: leaseBefore.fencingToken },
    ).accepted === false);

  // The old run finishes normally. Its result is simply no longer authoritative.
  settle(okResult(AGENT, 1));
  const outcome = await inflight;
  check('Case B: the stale write-back is REFUSED', outcome.ok === false, outcome.ok ? 'accepted' : '');
  check('Case B: refused as a stale lease version', !outcome.ok && outcome.code === 'stale-lease-version', outcome.ok ? '' : outcome.code);
  check('Case B: the run really happened, so runRejected is set', !outcome.ok && outcome.runRejected === true);
  check('Case B: the real RunResult is carried for evidence', !outcome.ok && outcome.run !== undefined);
  check('Case B: the outcome reports the STALE version the work ran under',
    !outcome.ok && outcome.leaseVersion === 1, String(outcome.ok ? '' : outcome.leaseVersion));

  check('Race 1: the old result did NOT move the task', store.get('c1')!.status === 'running', store.get('c1')!.status);
  check('Race 1: the task still belongs to the NEW holder', store.get('c1')!.agentId === OTHER, store.get('c1')!.agentId);

  // F1 + F5: the evidence path, through the real recorder.
  const tick: TickResult = {
    admitted: ['c1'], waiting: [], skipped: [], freeSlots: 1,
    outcomes: [{ taskId: 'c1', outcome: outcome as never }],
  };
  const recorded = recordExecutions(evidence, tick, (taskId) => {
    const t = store.get(taskId);
    return t === null ? null : { agentId: t.agentId, modelId: t.modelId, taskType: impl };
  });
  check('F5: the refused execution IS recorded as evidence', recorded.recorded.includes('c1'), JSON.stringify(recorded));
  check('F5: it is NOT reported as unrecorded', recorded.notRecorded.includes('c1') === false);

  const history = evidence.history('c1');
  const attempt = history[0];
  check('Case B: an AttemptRecord exists', attempt !== undefined);
  check('Case B: it records the AGENT THAT ACTUALLY RAN, not the current holder',
    attempt?.agentId === AGENT, String(attempt?.agentId));
  check('Case B: it does NOT attribute the work to the new holder', attempt?.agentId !== OTHER);
  check('Case B: it records the STALE lease version the run held',
    attempt?.leaseVersion === 1, String(attempt?.leaseVersion));
  check('F5: the current lease has moved on, and the record was NOT rewritten',
    store.get('c1')!.leaseVersion === 2 && attempt?.leaseVersion === 1);

  // F1: the receipt must be able to POINT at that attempt.
  const attemptIds = recorded.attemptIdsByTask['c1'] ?? [];
  check('F1: the refused attempt id reaches attemptIdsByTask', attemptIds.length === 1, JSON.stringify(attemptIds));
  check('F1: and it is the real attempt id from the store', attemptIds[0] === attempt?.attemptId, `${attemptIds[0]} vs ${attempt?.attemptId}`);

  rmSync(dir, { recursive: true, force: true });
}

// ===========================================================================
section('R2-2 Case A: the runtime never starts -> NO execution evidence');
// ===========================================================================
{
  const dir = tmpDir();
  const store = new TaskStore();
  const evidence = new AttemptStore();
  const { runtime, requests } = immediateRuntime(AGENT);
  const orch = new Orchestrator({ store, gate: gateSources(['c1']), runtime, now, defaultCwd: dir });
  orch.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' });
  const spawned = orch.spawnChild({ taskId: 'c1', parentTaskId: 'r', agentId: AGENT, modelId: SB, taskType: impl, acceptanceCriteria: 'child', budgetUnits: 10 });
  check('the child was admitted', spawned.ok, spawned.ok ? '' : `${spawned.code} ${spawned.reason}`);

  // A `blocked` task is not executable, so execution is refused at the very first
  // gate - before the workspace, before the claim, before the runtime seam. Nothing
  // ran, so there is nothing to describe.
  const blocked = store.block('c1', 'waiting on an upstream decision', NOW + 1);
  check('the task can be blocked', blocked.ok);

  const outcome = await orch.executeTask({ taskId: 'c1' });
  check('Case A: execution is refused', outcome.ok === false, outcome.ok ? 'ran' : outcome.code);
  check('Case A: refused as not executable', !outcome.ok && outcome.code === 'task-not-executable', outcome.ok ? '' : outcome.code);
  check('Case A: the runtime was NEVER called', requests.length === 0, `requests=${requests.length}`);
  check('Case A: no run is reported', !outcome.ok && outcome.run === undefined);
  check('Case A: runRejected is NOT set, because nothing ran',
    !outcome.ok && outcome.runRejected !== true, String(outcome.ok ? '' : outcome.runRejected));
  check('Case A: no lease version is claimed for a run that never happened',
    !outcome.ok && outcome.leaseVersion === undefined);
  check('Case A: the task keeps its status - a refusal is not a failure',
    store.get('c1')!.status === 'blocked', store.get('c1')!.status);
  check('Case A: and its lease is untouched, because no work was attempted',
    store.leaseOf('c1')!.status === 'issued', store.leaseOf('c1')!.status);

  const recorded = recordExecutions(evidence, {
    admitted: ['c1'], waiting: [], skipped: [], freeSlots: 1,
    outcomes: [{ taskId: 'c1', outcome: outcome as never }],
  }, (taskId) => {
    const t = store.get(taskId);
    return t === null ? null : { agentId: t.agentId, modelId: t.modelId, taskType: impl };
  });
  check('Case A: NO AttemptRecord is fabricated for a run that never happened',
    evidence.history('c1').length === 0, String(evidence.history('c1').length));
  check('Case A: it is reported as not-recorded, which is honest', recorded.notRecorded.includes('c1'));
  check('Case A: and no attempt id is invented', (recorded.attemptIdsByTask['c1'] ?? []).length === 0);

  // A2: the runtime REFUSING the run is also "no execution happened" - it throws, so
  // there is no RunResult to keep. This branch mutates the task to `failed`, which is
  // correct: something did go wrong, and it is not an agent failure.
  // `blocked -> queued` is the documented unblock path (blocked is retryable).
  store.transition('c1', 'queued', NOW + 2);
  const throwing: RuntimeRunner = {
    run(): RunHandle { throw new Error('adapter binary is missing'); },
  };
  const orch2 = new Orchestrator({ store, gate: gateSources(['c1']), runtime: throwing, now, defaultCwd: dir });
  const outcome2 = await orch2.executeTask({ taskId: 'c1' });
  check('Case A2: a runtime that throws produces no run', !outcome2.ok && outcome2.run === undefined);
  check('Case A2: refused as runtime-rejected-run', !outcome2.ok && outcome2.code === 'runtime-rejected-run', outcome2.ok ? '' : outcome2.code);
  check('Case A2: no runRejected, because no run exists', !outcome2.ok && outcome2.runRejected !== true);
  check('Case A2: the task IS failed, because the run genuinely did not start',
    store.get('c1')!.status === 'failed', store.get('c1')!.status);

  rmSync(dir, { recursive: true, force: true });
}

// ===========================================================================
section('R2-2 Case C: agent mismatch -> evidence kept, task not migrated');
// ===========================================================================
{
  const dir = tmpDir();
  const store = new TaskStore();
  const evidence = new AttemptStore();
  const { runtime } = immediateRuntime(OTHER);
  const orch = new Orchestrator({ store, gate: gateSources(['c1'], [AGENT, OTHER]), runtime, now, defaultCwd: dir });
  orch.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' });
  orch.spawnChild({ taskId: 'c1', parentTaskId: 'r', agentId: AGENT, modelId: SB, taskType: impl, acceptanceCriteria: 'child', budgetUnits: 10 });

  // The dispatched agent (`agentId` in the request) is AGENT, but the RUNTIME reports a
  // result from OTHER: the result did not come from the worker we dispatched to.
  const appliedRaw = orch.applyRunResult('c1', okResult(OTHER), {
    agentId: AGENT, leaseVersion: store.get('c1')!.leaseVersion, fencingToken: store.get('c1')!.fencingToken,
  });
  // Narrowed up front: `MutateOutcome` only carries `code`/`reason` on the refusal arm.
  const applied = appliedRaw.ok ? { ok: true as const, code: '', reason: '' } : appliedRaw;
  check('Case C: a result from a different agent is refused', appliedRaw.ok === false, appliedRaw.ok ? 'accepted' : '');
  check('Case C: refused as agent-mismatch', appliedRaw.ok === false && appliedRaw.code === 'agent-mismatch', appliedRaw.ok ? '' : appliedRaw.code);
  check('Case C: the task did NOT move', store.get('c1')!.status === 'planned', store.get('c1')!.status);
  check('Case C: the task was NOT migrated to the reporting agent', store.get('c1')!.agentId === AGENT);

  const owner = store.get('c1')!;
  const outcome = { ok: false as const, code: applied.code, reason: applied.reason, run: okResult(OTHER), runRejected: true, leaseVersion: owner.leaseVersion };
  const recorded = recordExecutions(evidence, {
    admitted: ['c1'], waiting: [], skipped: [], freeSlots: 1,
    outcomes: [{ taskId: 'c1', outcome: outcome as never }],
  }, (taskId) => {
    const t = store.get(taskId);
    return t === null ? null : { agentId: t.agentId, modelId: t.modelId, taskType: impl };
  });
  check('Case C: the execution evidence is KEPT', recorded.recorded.includes('c1'));
  check('Case C: the record names the agent that actually produced it',
    evidence.history('c1')[0]?.agentId === OTHER, String(evidence.history('c1')[0]?.agentId));
  check('Case C: and the task still belongs to the dispatched agent', store.get('c1')!.agentId === AGENT);

  rmSync(dir, { recursive: true, force: true });
}

// ===========================================================================
section('R2-2 Case D + L5: a valid current lease writes through to to_verify');
// ===========================================================================
{
  const dir = tmpDir();
  const store = new TaskStore();
  const evidence = new AttemptStore();
  const { runtime, requests } = immediateRuntime(AGENT);
  const orch = new Orchestrator({ store, gate: gateSources(['c1']), runtime, now, defaultCwd: dir });
  orch.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' });
  // P0-1: c1 must carry an approved contract so verification can complete it; the store
  // is the only channel (`spawnChild` has no contract field).
  orch.getStore().create({ taskId: 'c1', parentTaskId: 'r', agentId: AGENT, modelId: SB, taskType: impl, acceptanceCriteria: 'child', budgetUnits: 10, completionContract: COMPLETION }, NOW);

  const outcome = await orch.executeTask({ taskId: 'c1' });
  check('Case D: the run was accepted', outcome.ok === true, outcome.ok ? '' : `${outcome.code} ${outcome.reason}`);
  check('Case D: the runtime ran exactly once', requests.length === 1);
  check('Case D: a successful run lands in to_verify, never succeeded', store.get('c1')!.status === 'to_verify', store.get('c1')!.status);
  check('Case D: the outcome reports the lease it ran under', outcome.ok && outcome.leaseVersion === 1);
  check('Case D: the lease is marked active because it was used', store.leaseOf('c1')!.status === 'active', store.leaseOf('c1')!.status);
  check('L5: to_verify has NOT revoked the lease - the work is not finished', store.leaseOf('c1')!.status !== 'revoked');

  const recorded = recordExecutions(evidence, {
    admitted: ['c1'], waiting: [], skipped: [], freeSlots: 1,
    outcomes: [{ taskId: 'c1', outcome: outcome as never }],
  }, (taskId) => {
    const t = store.get(taskId);
    return t === null ? null : { agentId: t.agentId, modelId: t.modelId, taskType: impl };
  });
  // P0-1: a lower caller correlates the accepted execution to the attempt it produced.
  orch.attachAttemptStore(evidence);
  for (const ref of recorded.executionsByTask['c1'] ?? []) {
    orch.recordAttemptBinding('c1', { attemptId: ref.attemptId, sessionId: null, run: ref.run });
  }
  const attempt = evidence.history('c1')[0];
  check('Case D: evidence is recorded', recorded.recorded.includes('c1') && attempt !== undefined);
  check('Case D: the record names the agent that ran', attempt?.agentId === AGENT);
  check('Case D: the record carries the lease version of the execution', attempt?.leaseVersion === 1, String(attempt?.leaseVersion));
  check('Case D: the receipt points at the attempt', (recorded.attemptIdsByTask['c1'] ?? [])[0] === attempt?.attemptId);

  // Verification is still the only route to succeeded, and it revokes the lease.
  const verified = orch.applyVerification('c1', { verdict: 'pass', reason: 'criteria met' });
  check('Case D: verification completes the task', verified.ok && store.get('c1')!.status === 'succeeded', store.get('c1')!.status);
  check('L5: the terminal task revoked its lease', store.leaseOf('c1')!.status === 'revoked', store.leaseOf('c1')!.status);

  rmSync(dir, { recursive: true, force: true });
}

// ===========================================================================
section('R2-2 Race 5: a late result after terminal only becomes evidence');
// ===========================================================================
{
  const dir = tmpDir();
  const store = new TaskStore();
  const evidence = new AttemptStore();
  const { runtime } = immediateRuntime(AGENT);
  const orch = new Orchestrator({ store, gate: gateSources(['c1']), runtime, now, defaultCwd: dir });
  orch.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' });
  // P0-1: c1 carries an approved contract and is driven through the REAL execution edge,
  // because a hand-written `applyRunResult` can never produce completion evidence.
  orch.getStore().create({ taskId: 'c1', parentTaskId: 'r', agentId: AGENT, modelId: SB, taskType: impl, acceptanceCriteria: 'child', budgetUnits: 10, completionContract: COMPLETION }, NOW);

  const owner = store.get('c1')!;
  const presented = { agentId: AGENT, leaseVersion: owner.leaseVersion, fencingToken: owner.fencingToken };

  // The run completes and is written back normally, through the real execution edge.
  const applied = await orch.executeTask({ taskId: 'c1' });
  check('Race 5: the first result is accepted', applied.ok === true, applied.ok ? '' : applied.code);
  check('Race 5: the task is now in to_verify', store.get('c1')!.status === 'to_verify', store.get('c1')!.status);

  // P0-1: correlate the accepted execution to the attempt it produced BEFORE verification,
  // exactly as the Workbench does (this lower caller has no Workbench).
  recordAndBindOutcome(orch, evidence, 'c1', applied, (taskId) => {
    const t = store.get(taskId);
    return t === null ? null : { agentId: t.agentId, modelId: t.modelId, taskType: impl };
  });

  // ...verification finishes it, which is the ONLY route to succeeded and revokes...
  const verified = orch.applyVerification('c1', { verdict: 'pass', reason: 'ok' });
  check('Race 5: the task reached succeeded', verified.ok && store.get('c1')!.status === 'succeeded', store.get('c1')!.status);
  check('Race 5: its lease is revoked', store.leaseOf('c1')!.status === 'revoked');

  // ...and only THEN does a SECOND result from that same run arrive, carrying a
  // still-matching version and token. Only lease LIVENESS can catch this.
  const lateRaw = orch.applyRunResult('c1', okResult(AGENT, 9), presented);
  const late = lateRaw.ok ? { ok: true as const, code: '', reason: '' } : lateRaw;
  check('Race 5: the late write-back is refused', lateRaw.ok === false, lateRaw.ok ? 'accepted' : '');
  check('Race 5: refused because the lease was revoked', lateRaw.ok === false && lateRaw.code === 'lease-revoked', lateRaw.ok ? '' : lateRaw.code);
  check('Race 5: the task is NOT reopened', store.get('c1')!.status === 'succeeded', store.get('c1')!.status);
  check('Race 5: no replan / reassign / retry was invented', store.get('c1')!.retryCount === 0 && store.get('c1')!.generation === 0);

  const outcome = { ok: false as const, code: late.code, reason: late.reason, run: okResult(AGENT, 9), runRejected: true, leaseVersion: presented.leaseVersion };
  const recorded = recordExecutions(evidence, {
    admitted: ['c1'], waiting: [], skipped: [], freeSlots: 1,
    outcomes: [{ taskId: 'c1', outcome: outcome as never }],
  }, (taskId) => {
    const t = store.get(taskId);
    return t === null ? null : { agentId: t.agentId, modelId: t.modelId, taskType: impl };
  });
  check('Race 5: the late execution is still recorded as evidence', recorded.recorded.includes('c1'));
  check('Race 5: and it is still attributed to the agent that ran', evidence.history('c1')[0]?.agentId === AGENT);

  rmSync(dir, { recursive: true, force: true });
}

// ===========================================================================
section('R2-2: an attempt record validates its lease version');
// ===========================================================================
{
  const base = {
    taskId: 't1', kind: 'execution', agentId: AGENT, modelId: SB, taskType: impl,
    startedAt: 100, finishedAt: 200, outcome: 'success',
  };
  let ok = true;
  try { validateAttemptRecord({ ...base, leaseVersion: 3 }); } catch { ok = false; }
  check('a valid lease version is accepted', ok);
  ok = true;
  try { validateAttemptRecord(base); } catch { ok = false; }
  check('an absent lease version stays absent (optional, like budgetUnits)', ok);
  ok = true;
  try { validateAttemptRecord({ ...base, leaseVersion: 0 }); } catch { ok = false; }
  check('leaseVersion 0 is refused - "no lease" must not wear a number', ok === false);
  ok = true;
  try { validateAttemptRecord({ ...base, leaseVersion: 'three' }); } catch { ok = false; }
  check('a non-numeric lease version is refused', ok === false);
}

// ===========================================================================
section('R2-2 topology: the lifecycle added no authority');
// ===========================================================================
{
// The repository-wide authority counts (one TaskStore / TaskScheduler /
  // WorkspaceManager / runtime.run) are asserted by `state-loop.test.ts` §12, which is
  // their canonical home. What belongs HERE is only what R2-2 could have broken: that
  // adding a lease lifecycle did not create a second writer, a dispatcher, or a place
  // where lease state quietly became authoritative.

  // 1. The lease module stays PURE: no class, no module-level mutable state, no clock.
  const leaseRaw = read('orchestration/assignment-lease.ts');
  const leaseSrc = codeOf(leaseRaw);
  check('assignment-lease.ts exports no class (it is pure functions)',
    !/export class /.test(leaseSrc));
  check('assignment-lease.ts holds no module-level mutable Map/Set',
    !/^const \w+ = new (Map|Set)/m.test(leaseSrc));
  check('assignment-lease.ts has no timer / heartbeat / interval',
    !/setInterval|setTimeout|heartbeat/i.test(leaseSrc));
  check('assignment-lease.ts cannot dispatch or reach a runtime',
    !/\bruntime\b|\bscheduler\b|\.tick\(|\bdispatch\s*\(/.test(leaseSrc));

  // 2. Exactly ONE issuer of leases: the pure function plus the store that owns identity.
  const issuers = sourceFiles
    .flatMap((f) => readFileSync(f, 'utf8').split(/\r?\n/)
      .map((l, i) => ({ f, i, l }))
      .filter(({ l }) => /\bissueLease\(/.test(l) && !/^\s*(\*|\/\/)/.test(l))
      .map(({ f, i }) => `${f}:${i + 1}`));
  check('lease issuance happens in exactly two places: the pure fn + the store',
    issuers.length === 2, issuers.join(', '));
  check('and the store is one of them', issuers.some((x) => x.includes('store.ts')), issuers.join(', '));
  check('no orchestrator / workbench / scheduler issues a lease',
    !issuers.some((x) => /orchestrator|workbench|scheduler/.test(x)), issuers.join(', '));

  // 3. TaskStore gained bookkeeping, not capability.
  const storeSrc = codeOf(read('orchestration/store.ts'));
  check('TaskStore gained no dispatch capability for the lease',
    !/\.tick\(|\bdispatch\s*\(|\bruntime\b/.test(storeSrc));
  check('revoking a lease triggers no task transition of its own',
    !/revokeLeaseFor[\s\S]{0,400}?this\.transition\(/.test(storeSrc));

  // 4. ResourceClaimBook still cannot know what a lease is - it is handed a predicate.
  const claimSrc = codeOf(read('orchestration/resource-claim.ts'));
  check('ResourceClaimBook imports no lease module (it cannot become lease authority)',
    !/assignment-lease/.test(claimSrc));
  check('and it exposes no lease-deciding method',
    !/\b(isLeaseLive|renewLease|revokeLease|issueLease)\b/.test(claimSrc));
}

// ===========================================================================
section('R2-2 integration: renew keeps the SAME right, so a write-back still lands');
// ===========================================================================
{
  const dir = tmpDir();
  const store = new TaskStore({ renewPolicy: { maxRenewals: 2, ttlMs: 60_000 } });
  const evidence = new AttemptStore();
  const { runtime, requests } = immediateRuntime(AGENT);
  const orch = new Orchestrator({ store, gate: gateSources(['c1']), runtime, now, defaultCwd: dir });
  orch.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' });
  orch.spawnChild({ taskId: 'c1', parentTaskId: 'r', agentId: AGENT, modelId: SB, taskType: impl, acceptanceCriteria: 'child', budgetUnits: 10 });

  const before = store.leaseOf('c1')!;
  const renewed = store.renewLeaseFor('c1', NOW + 1_000);
  check('the lease renews', renewed.ok === true, renewed.ok ? '' : renewed.code);
  check('the renewal did NOT change the credential',
    renewed.ok && renewed.lease.fencingToken === before.fencingToken);
  check('the renewal did NOT change the version',
    renewed.ok && renewed.lease.leaseVersion === before.leaseVersion);
  check('the task record itself is untouched by a renewal',
    store.get('c1')!.leaseVersion === before.leaseVersion && store.get('c1')!.fencingToken === before.fencingToken);

  const outcome = await orch.executeTask({ taskId: 'c1' });
  check('a run under a renewed lease still writes back', outcome.ok === true, outcome.ok ? '' : `${outcome.code} ${outcome.reason}`);
  check('the run happened exactly once', requests.length === 1);
  check('the task reached to_verify', store.get('c1')!.status === 'to_verify', store.get('c1')!.status);
  check('the outcome still reports the ORIGINAL lease version', outcome.ok && outcome.leaseVersion === before.leaseVersion);

  const recorded = recordExecutions(evidence, {
    admitted: ['c1'], waiting: [], skipped: [], freeSlots: 1,
    outcomes: [{ taskId: 'c1', outcome: outcome as never }],
  }, (taskId) => {
    const t = store.get(taskId);
    return t === null ? null : { agentId: t.agentId, modelId: t.modelId, taskType: impl };
  });
  check('the evidence records that lease version', evidence.history('c1')[0]?.leaseVersion === before.leaseVersion);
  check('and the receipt points at the attempt', recorded.attemptIdsByTask['c1']?.length === 1);

  // The bound really is a bound.
  const exhausted1 = store.renewLeaseFor('c1', NOW + 2_000);
  const exhausted2 = exhausted1.ok ? store.renewLeaseFor('c1', NOW + 3_000) : exhausted1;
  check('the renewal budget is enforced through the store', exhausted2.ok === false && exhausted2.code === 'renewal-budget-exhausted',
    exhausted2.ok ? 'renewed' : exhausted2.code);

  rmSync(dir, { recursive: true, force: true });
}

// ===========================================================================
section('R2-2 integration: a resource claim needs a LIVE lease (Race 4)');
// ===========================================================================
{
  const dir = tmpDir();
  const writeIntent = () => ({ mode: 'write' as const, scope: { kind: 'directory' as const, path: dir } });

  // Live lease: the claim gate lets the request through to the later workspace checks.
  {
    const store = new TaskStore();
    const { runtime, requests } = immediateRuntime(AGENT);
    const orch = new Orchestrator({ store, gate: gateSources(['c1']), runtime, now, defaultCwd: dir, resourceClaims: writeIntent });
    orch.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' });
    orch.spawnChild({ taskId: 'c1', parentTaskId: 'r', agentId: AGENT, modelId: SB, taskType: impl, acceptanceCriteria: 'child', budgetUnits: 10 });
    const outcome = await orch.executeTask({ taskId: 'c1' });
    check('a live lease passes the claim gate', outcome.ok === true || outcome.code !== 'lease-not-live',
      outcome.ok ? '' : outcome.code);
    check('the run happened', requests.length === 1, `requests=${requests.length}`);
  }

  // Revoked lease: refused BEFORE any claim is registered, with no runtime call.
  {
    const store = new TaskStore();
    const { runtime, requests } = immediateRuntime(AGENT);
    const orch = new Orchestrator({ store, gate: gateSources(['c1']), runtime, now, defaultCwd: dir, resourceClaims: writeIntent });
    orch.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' });
    orch.spawnChild({ taskId: 'c1', parentTaskId: 'r', agentId: AGENT, modelId: SB, taskType: impl, acceptanceCriteria: 'child', budgetUnits: 10 });
    store.revokeLeaseFor('c1', 'assignment withdrawn');

    const outcome = await orch.executeTask({ taskId: 'c1' });
    check('a revoked lease refuses the claim at admission', !outcome.ok && outcome.code === 'lease-not-live', outcome.ok ? 'ran' : outcome.code);
    check('no runtime call was made', requests.length === 0, `requests=${requests.length}`);
    check('the reason cites section 7.3', !outcome.ok && outcome.reason.includes('7.3'), outcome.ok ? '' : outcome.reason.slice(0, 60));
    check('no agent is blamed', !outcome.ok && /no agent blamed/.test(outcome.reason));
    check('the task keeps its status', store.get('c1')!.status === 'planned', store.get('c1')!.status);
  }

  // Expired lease: the same refusal, for the same reason.
  {
    const store = new TaskStore();
    const { runtime, requests } = immediateRuntime(AGENT);
    const orch = new Orchestrator({ store, gate: gateSources(['c1']), runtime, now, defaultCwd: dir, resourceClaims: writeIntent });
    orch.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' });
    orch.spawnChild({ taskId: 'c1', parentTaskId: 'r', agentId: AGENT, modelId: SB, taskType: impl, acceptanceCriteria: 'child', budgetUnits: 10 });
    // Push the orchestrator's clock past the lease deadline without touching the lease.
    const late = new Orchestrator({ store, gate: gateSources(['c1']), runtime, now: () => NOW + DEFAULT_RENEW_POLICY.ttlMs + 1, defaultCwd: dir, resourceClaims: writeIntent });
    const outcome = await late.executeTask({ taskId: 'c1' });
    check('an expired lease refuses the claim at admission', !outcome.ok && outcome.code === 'lease-not-live', outcome.ok ? 'ran' : outcome.code);
    check('no runtime call was made', requests.length === 0, `requests=${requests.length}`);
  }

  rmSync(dir, { recursive: true, force: true });
}

// ===========================================================================
section('R2-2 FINAL: P1-1 liveness — a task that outlives the assignment window');
// ===========================================================================
{
  // The livelock this closes, stated as the sequence that produced it:
  //   assigned at T0 -> queued -> waits LONGER than the 15 min lease window
  //   -> dispatched -> the lease is already expired
  //   -> a live lease cannot be renewed (§6.3), so renewing does NOT help
  //   -> admission refuses with lease-not-live, forever.
  // With a SHORT ttl the same shape is reproducible in a test.
  const dir = tmpDir();
  const store = new TaskStore({ renewPolicy: { maxRenewals: 2, ttlMs: 1_000 } });
  const { runtime, requests } = immediateRuntime(AGENT);
  const orch = new Orchestrator({ store, gate: gateSources(['c1']), runtime, now: () => NOW, defaultCwd: dir });
  orch.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' });
  orch.spawnChild({ taskId: 'c1', parentTaskId: 'r', agentId: AGENT, modelId: SB, taskType: impl, acceptanceCriteria: 'child', budgetUnits: 10 });

  const issued = store.leaseOf('c1')!;
  check('the lease is issued with the configured window', issued.expiresAt === NOW + 1_000);
  // The waiting period: far beyond the assignment window.
  const afterWait = NOW + 10 * 60_000;
  check('the assignment window really has passed', issued.expiresAt < afterWait);
  check('and the lease is expired as a pure function of that clock', isLeaseLive(issued, afterWait) === false);

  // Now dispatch it, on a clock past the window - exactly what the scheduler does.
  const late = new Orchestrator({ store, gate: gateSources(['c1']), runtime, now: () => afterWait, defaultCwd: dir });
  const outcome = await late.executeTask({ taskId: 'c1' });
  check('P1-1: the task is NOT livelocked — it dispatches anyway', outcome.ok === true,
    outcome.ok ? '' : `${outcome.code} ${String(outcome.reason).slice(0, 110)}`);
  check('P1-1: the runtime really ran', requests.length === 1, `requests=${requests.length}`);
  check('P1-1: and the task reached to_verify', store.get('c1')!.status === 'to_verify', store.get('c1')!.status);

  const active = store.leaseOf('c1')!;
  check('P1-1: the lease became ACTIVE at dispatch', active.status === 'active', active.status);
  check('P1-1: the execution window was anchored at dispatch, not at issue',
    active.expiresAt === afterWait + 1_000, String(active.expiresAt - afterWait));
  check('P1-1: and it is now live', isLeaseLive(active, afterWait) === true);
  check('P1-1: activation is once-per-lease, so it cannot become a heartbeat',
    activateLease(active, afterWait + 1).status === 'active');

  rmSync(dir, { recursive: true, force: true });
}

// ===========================================================================
section('R2-2 FINAL: P1-1 production renew — a run that outlives the window');
// ===========================================================================
{
  const dir = tmpDir();
  const store = new TaskStore({ renewPolicy: { maxRenewals: 2, ttlMs: 1_000 } });
  const { runtime, requests, settle } = deferredRuntime();
  // A MUTABLE clock, because this scenario has to observe time actually passing: with a
  // frozen clock the lease can never expire and the "late result after the budget" half
  // of the test would be vacuous. Advancing one variable also proves the issuer and the
  // reader really are on the same clock.
  let clockAt = NOW;
  const orch = new Orchestrator({ store, gate: gateSources(['c1']), runtime, now: () => clockAt, defaultCwd: dir });
  orch.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' });
  orch.spawnChild({ taskId: 'c1', parentTaskId: 'r', agentId: AGENT, modelId: SB, taskType: impl, acceptanceCriteria: 'child', budgetUnits: 10 });

  const inflight = orch.executeTask({ taskId: 'c1' });
  await new Promise((r) => setTimeout(r, 20));
  check('the run really started', requests.length === 1);
  check('the task is running', store.get('c1')!.status === 'running', store.get('c1')!.status);

  // A run that outlives the execution window: renew on a tick that observes it.
  //
  // Renewed BEFORE the deadline, not after, and that is the contract rather than a
  // convenience: §6.3 makes an expired lease non-renewable, so renewal is PREVENTIVE.
  // The first attempt at this test waited 5 s against a 1 s window, was correctly refused
  // with `lease-expired`, and wrongly looked like a broken renew. It is also why the
  // production call site runs on a tick: ticks are frequent relative to the window.
  const laterTick = NOW + 500;
  check('renew happens while the lease is still live', laterTick < store.leaseOf('c1')!.expiresAt);
  const renewed = store.renewRunningLeases(laterTick);
  check('P1-1: production renew extends the RUNNING task\'s lease', renewed.renewed.includes('c1'), JSON.stringify(renewed));
  const afterRenew = store.leaseOf('c1')!;
  check('P1-1: the deadline moved out', afterRenew.expiresAt === laterTick + 1_000);
  check('P1-1: the renewal counted against the budget', afterRenew.renewals === 1);
  check('P1-1: it is still the SAME right (same version and token)', afterRenew.leaseVersion === 1 && afterRenew.fencingToken === store.get('c1')!.fencingToken);

  // The budget is the designed bound. Two renewals are allowed (maxRenewals: 2), each
  // strictly inside the live window, and then the refusal stands.
  clockAt = NOW + 1_000;
  const second = store.renewRunningLeases(clockAt);
  check('P1-1: a second renewal is allowed', second.renewed.includes('c1'), JSON.stringify(second));
  clockAt = NOW + 1_400;
  const spent = store.renewRunningLeases(clockAt);
  check('P1-1: the renewal budget is bounded and then refuses',
    spent.renewed.includes('c1') === false && spent.refused['c1'] === 'renewal-budget-exhausted',
    JSON.stringify(spent));
  check('P1-1: exhaustion is reported, not silently swallowed', spent.refused['c1'] !== undefined);

  // The run is still in flight and now outlives its window. A result arriving after the
  // budget is gone is refused — but the EVIDENCE survives (F5), and the task is not reopened.
  clockAt = NOW + 10_000;
  check('P1-1: the lease is genuinely expired at this point', isLeaseLive(store.leaseOf('c1')!, clockAt) === false);
  settle(okResult(AGENT, 1));
  const outcome = await inflight;
  check('P1-1: a result arriving after the budget is refused', outcome.ok === false, outcome.ok ? 'accepted' : '');
  check('P1-1: refused for the right reason (expired, not stale version)',
    !outcome.ok && outcome.code === 'lease-expired', outcome.ok ? '' : outcome.code);
  check('P1-1: and the execution is still kept as evidence', !outcome.ok && outcome.runRejected === true && outcome.run !== undefined);
  check('P1-1: the task was NOT reopened by the refused result', store.get('c1')!.status === 'running', store.get('c1')!.status);

  rmSync(dir, { recursive: true, force: true });
}

// ===========================================================================
section('R2-2 FINAL: P1-1 renew only touches RUNNING tasks, and never a stale one');
// ===========================================================================
{
  const store = new TaskStore({ renewPolicy: { maxRenewals: 3, ttlMs: 1_000 } });
  store.create({ taskId: 'queued', parentTaskId: null, agentId: AGENT, taskType: impl, acceptanceCriteria: 'x' }, NOW);
  store.create({ taskId: 'live', parentTaskId: null, agentId: AGENT, taskType: impl, acceptanceCriteria: 'x' }, NOW);
  store.create({ taskId: 'done', parentTaskId: null, agentId: AGENT, taskType: impl, acceptanceCriteria: 'x' }, NOW);
  store.transition('live', 'queued', NOW); store.transition('live', 'running', NOW);
  store.transition('done', 'queued', NOW); store.transition('done', 'running', NOW);
  store.transition('done', 'to_verify', NOW); store.transition('done', 'succeeded', NOW);

  const out = store.renewRunningLeases(NOW + 10);
  check('only the RUNNING task is renewed', JSON.stringify(out.renewed) === '["live"]', JSON.stringify(out.renewed));
  check('a queued task is not renewed', store.leaseOf('queued')!.renewals === 0);
  check('a terminal task is not renewed', store.leaseOf('done')!.renewals === 0);
  check('a terminal task\'s lease stays revoked', store.leaseOf('done')!.status === 'revoked');

  // A reassignment mid-run means the lease on file is the NEW one; the old version is
  // never extended, so a stale holder cannot buy time with a renewal.
  store.migrateIdentityAfterStart('live', { agentId: OTHER, modelId: 'hy3', reason: 'moved' }, NOW + 20);
  const afterMove = store.renewRunningLeases(NOW + 30);
  check('the current lease is renewed after a migration', afterMove.renewed.includes('live'));
  check('and it is the NEW version that got the renewal', store.leaseOf('live')!.leaseVersion === 2);
  check('the superseded version cannot be renewed into validity',
    store.leaseOf('live')!.fencingToken === store.get('live')!.fencingToken);
}

// ===========================================================================
section('R2-2 FINAL: P1-2 one lifecycle-aware write-back primitive');
// ===========================================================================
{
  const lease = issueLease({
    taskId: 't', agentId: AGENT, modelId: SB, leaseVersion: 4,
    fencingToken: 'fence-4-x', now: NOW,
  });
  const authority = {
    lease,
    agentId: AGENT, modelId: SB,
    leaseVersion: 4, fencingToken: 'fence-4-x',
    producedBy: AGENT,
  };
  const presented = { agentId: AGENT, leaseVersion: 4, fencingToken: 'fence-4-x' };

  check('P1-2: a live lease with a matching holder is accepted',
    validateWriteback(authority, presented, NOW).accepted === true);

  // The whole point: version and token STILL MATCH, so pure fencing would accept.
  const revokedVerdict = validateWriteback(
    { ...authority, lease: revokeLease(lease, 'reassigned') },
    presented,
    NOW,
  );
  check('P1-2: a REVOKED lease is rejected even though version and token match',
    revokedVerdict.accepted === false && revokedVerdict.code === 'lease-revoked',
    revokedVerdict.accepted ? 'ACCEPTED' : revokedVerdict.code);
  check('P1-2: and the reason says the task is not reopened',
    revokedVerdict.accepted === false && /not reopened/.test(revokedVerdict.reason));

  const expiredVerdict = validateWriteback(authority, presented, lease.expiresAt + 1);
  check('P1-2: an EXPIRED lease is rejected even though version and token match',
    expiredVerdict.accepted === false && expiredVerdict.code === 'lease-expired',
    expiredVerdict.accepted ? 'ACCEPTED' : expiredVerdict.code);

  // Attribution still works, and is NOT the same question as ownership.
  const wrongAgent = validateWriteback({ ...authority, producedBy: OTHER }, presented, NOW);
  check('P1-2: evidence integrity still refuses a result from a different agent',
    wrongAgent.accepted === false && wrongAgent.code === 'agent-mismatch',
    wrongAgent.accepted ? 'accepted' : wrongAgent.code);
  const stale = validateWriteback(authority, { ...presented, leaseVersion: 3 }, NOW);
  check('P1-2: a stale version is still refused',
    stale.accepted === false && stale.code === 'stale-lease-version', stale.accepted ? 'accepted' : stale.code);
  const noCred = validateWriteback(authority, undefined, NOW);
  check('P1-2: a missing credential is still refused',
    noCred.accepted === false && noCred.code === 'fencing-token-missing', noCred.accepted ? 'accepted' : noCred.code);

  // P2: both mutation sites must use the SAME primitive, or the two failure branches
  // and the success path drift apart again. Asserted from the source.
  const orchSrc = read('orchestration/orchestrator.ts');
  const validationCalls = (codeOf(orchSrc).match(/validateWriteback\(/g) ?? []).length;
  check('P1-2: BOTH write-back sites call the one primitive (applyRunResult + stillHoldsLease)',
    validationCalls === 2, `validateWriteback called ${validationCalls}x`);
  check('P1-2: no hand-written lifecycle gate is left in the orchestrator',
    !/code: lease\.status === 'revoked' \? 'lease-revoked'/.test(codeOf(orchSrc)));
  check('P1-2: applyVerification is NOT gated on an execution lease',
    !/applyVerification[\s\S]{0,400}validateWriteback/.test(codeOf(orchSrc)));
}

// ===========================================================================
section('R2-2 FINAL: P1-3 a claim dies with its lease, not just its version');
// ===========================================================================
{
  const book = new ResourceClaimBook(now);
  const lease = issueLease({ taskId: 'a', agentId: AGENT, modelId: SB, leaseVersion: 2, fencingToken: 'f2', now: NOW });
  const taken = book.claim({ taskId: 'a', workspaceId: 'ws', mode: 'write', scope: { kind: 'directory', path: '/r' }, leaseVersion: 2 });
  check('P1-3: the claim is bound to the live lease version', taken.ok && taken.claim.leaseVersion === 2);
  const claim = taken.ok ? taken.claim : ({} as ResourceClaim);

  // `revokeLease` deliberately KEEPS the version, so version equality alone cannot tell
  // a live lease from a revoked one. The caller must pass `claimLeaseVersionOf`, which
  // returns null for anything not live.
  const liveVersion = claimLeaseVersionOf(lease, NOW);
  const revokedVersion = claimLeaseVersionOf(revokeLease(lease, 'terminal'), NOW);
  const expiredVersion = claimLeaseVersionOf(lease, lease.expiresAt + 1);

  check('P1-3: a live lease yields a bindable version', liveVersion === 2);
  check('P1-3: a REVOKED lease yields NONE, even though its version is unchanged', revokedVersion === null, String(revokedVersion));
  check('P1-3: an EXPIRED lease yields none', expiredVersion === null, String(expiredVersion));

  check('P1-3: the claim is current only while its lease is live', claimIsLeaseCurrent(claim, liveVersion) === true);
  check('P1-3: revoking the lease invalidates the claim', claimIsLeaseCurrent(claim, revokedVersion) === false);
  check('P1-3: so does expiry', claimIsLeaseCurrent(claim, expiredVersion) === false);
  check('P1-3: and a NEW lease (version advanced) invalidates it too', claimIsLeaseCurrent(claim, 3) === false);

  // The end-to-end consequence: a revoked lease's claim must stop blocking.
  const voided = book.voidClaimsWhere((c) => !claimIsLeaseCurrent(c, revokedVersion));
  check('P1-3: the stale claim is voided', voided === 1, String(voided));
  check('P1-3: so a new writer is no longer blocked by it',
    book.wouldConflict({ taskId: 'b', workspaceId: 'ws', mode: 'write', scope: { kind: 'directory', path: '/r' }, leaseVersion: 1 }).length === 0);

  // Integration: revoke the real lease, then confirm the production path stops
  // conferring write eligibility (P1-3 through the orchestrator, not just the predicate).
  const dir = tmpDir();
  const store = new TaskStore();
  const scope = () => ({ mode: 'write' as const, scope: { kind: 'directory' as const, path: dir } });
  const liveOrch = new Orchestrator({ store, gate: gateSources(['c1']), runtime: immediateRuntime(AGENT).runtime, now, defaultCwd: dir, resourceClaims: scope });
  liveOrch.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' });
  liveOrch.spawnChild({ taskId: 'c1', parentTaskId: 'r', agentId: AGENT, modelId: SB, taskType: impl, acceptanceCriteria: 'child', budgetUnits: 10 });
  const liveRun = await liveOrch.executeTask({ taskId: 'c1' });
  check('P1-3: with a live lease the claim gate admits execution', liveRun.ok, liveRun.ok ? '' : liveRun.code);

  const revokedStore = new TaskStore();
  const revOrch = new Orchestrator({ store: revokedStore, gate: gateSources(['c1']), runtime: immediateRuntime(AGENT).runtime, now, defaultCwd: dir, resourceClaims: scope });
  revOrch.createRoot({ taskId: 'r', agentId: AGENT, taskType: impl, acceptanceCriteria: 'root' });
  revOrch.spawnChild({ taskId: 'c1', parentTaskId: 'r', agentId: AGENT, modelId: SB, taskType: impl, acceptanceCriteria: 'child', budgetUnits: 10 });
  revokedStore.revokeLeaseFor('c1', 'assignment withdrawn');
  const revRun = await revOrch.executeTask({ taskId: 'c1' });
  check('P1-3: a revoked lease cannot take a write claim',
    revRun.ok === false && revRun.code === 'lease-not-live', revRun.ok ? 'ran' : revRun.code);

  rmSync(dir, { recursive: true, force: true });
}

// ===========================================================================
section('R2-2 FINAL: P2 terminal guard + clock discipline');
// ===========================================================================
{
  const store = new TaskStore();
  store.create({ taskId: 't', parentTaskId: null, agentId: AGENT, taskType: impl, acceptanceCriteria: 'x' }, NOW);
  // Cancelled BEFORE it ever ran: `startedAt` is still null, which is exactly the hole
  // the startedAt-only guard left open.
  store.transition('t', 'cancelled', NOW);
  const before = store.leaseOf('t')!;
  check('a terminal task\'s lease is revoked', before.status === 'revoked');

  const attempt = store.assignIdentity('t', OTHER, 'hy3', NOW + 1);
  check('P2: a TERMINAL task cannot be re-assigned', attempt.ok === false, attempt.ok ? 'accepted' : String(attempt.code));
  check('P2: refused with a named reason', !attempt.ok && attempt.code === 'assignment-after-terminal', attempt.ok ? '' : String(attempt.code));
  check('P2: no new lease was issued', store.leaseOf('t')!.leaseVersion === before.leaseVersion);
  check('P2: the lease stays revoked', store.leaseOf('t')!.status === 'revoked');
  check('P2: the task status is unchanged (nothing reopened it)', store.get('t')!.status === 'cancelled', store.get('t')!.status);
  check('P2: its identity is unchanged', store.get('t')!.agentId === AGENT);

  const termStore = new TaskStore();
  termStore.create({ taskId: 't', parentTaskId: null, agentId: AGENT, taskType: impl, acceptanceCriteria: 'x' }, NOW);
  termStore.transition('t', 'queued', NOW); termStore.transition('t', 'running', NOW);
  termStore.transition('t', 'failed', NOW);
  const beforeFailed = termStore.leaseOf('t')!;
  const failedAssign = termStore.assignIdentity('t', OTHER, null, NOW + 1);
  check('P2: a FAILED task cannot be re-assigned either', failedAssign.ok === false, failedAssign.ok ? 'accepted' : String(failedAssign.code));
  check('P2: and it gets no new lease', termStore.leaseOf('t')!.leaseVersion === beforeFailed.leaseVersion);
  check('P2: its status is untouched', termStore.get('t')!.status === 'failed', termStore.get('t')!.status);

  // Clock: no hidden Date.now() fallback on any production lease path.
  const storeSrc = codeOf(read('orchestration/store.ts'));
  check('P2: assignIdentity has NO Date.now() fallback', !/assignIdentity\([^)]*Date\.now\(\)/.test(storeSrc));
  // The identity write path is assignment-wiring -> workbench; the orchestrator does not
  // call assignIdentity at all, so the clock assertion belongs there.
  const wiringSrc = codeOf(read('orchestration/assignment-wiring.ts'));
  const wbSrc = codeOf(read('orchestration/workbench.ts'));
  check('P2: applyAssignment requires an explicit clock from its caller',
    /export function applyAssignment\([\s\S]*?now: number,/.test(wiringSrc));
  check('P2: and it forwards it to assignIdentity rather than defaulting',
    /assignIdentity\(input\.taskId, agentId, modelId, now\)/.test(wiringSrc));
  check('P2: the workbench writes identity with its injected clock',
    /assignIdentity\([^)]*this\.nowFn\(\)/.test(wbSrc));
  check('P2: the workbench stamps lease/session facts with the same clock', !/sessions\.open\([^)]*Date\.now\(\)/.test(wbSrc));
  check('P2: production renew is driven by the injected clock too',
    /renewRunningLeases\(this\.clock\(\)\)/.test(wbSrc));
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) {
  process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
}
process.stdout.write('\n');
process.exitCode = failed === 0 ? 0 : 1;
