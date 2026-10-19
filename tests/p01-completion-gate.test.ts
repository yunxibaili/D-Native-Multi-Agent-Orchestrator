/**
 * tests/p01-completion-gate.test.ts — P0-1: the deterministic completion gate.
 *
 * ============================================================================
 * WHAT IS REAL vs INJECTED
 * ============================================================================
 * REAL: the plan-file parser/validator, the shared candidate builder,
 * `NativeWorkbench.planWithCandidates` (`commitPlan`), Assignment, the Session
 * registry, the Scheduler, `Orchestrator.executeTask`, the completion-contract
 * manifest helpers, and the APPROVED TEST which is a REAL contained `node` process
 * launched through the existing `ManagedProcess` path.
 *
 * INJECTED, and only this: the native agent's own process. A fake adapter exits 0 and
 * a wrapper writes the deliverables the scenario calls for.
 *
 * HERMETIC: no real Agent, no network, no credentials, no model call.
 *
 * Run: node tests/p01-completion-gate.test.ts
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BudgetManager } from '../src/quota/budget.ts';
import { ModelRegistry } from '../src/quota/registry.ts';
import type { AgentDescriptor, RunRequest } from '../src/core/types.ts';
import type { QuotaRecord } from '../src/quota/types.ts';
import type { RuntimeRunner } from '../src/orchestration/execute.ts';
import { Orchestrator as RuntimeOrch } from '../src/orchestrator/orchestrator.ts';
import { Orchestrator } from '../src/orchestration/orchestrator.ts';
import { TaskScheduler } from '../src/orchestration/scheduler.ts';
import { NativeWorkbench } from '../src/orchestration/workbench.ts';
import { createFakeAdapter } from './helpers.ts';
import { parsePlanFile, buildSequentialStepCandidates, PlanFileError, isSequentialPlan } from '../src/orchestration/plan-file.ts';
import { evaluateCompletionGate, type CompletionGateResult } from '../src/orchestration/completion-gate.ts';
import {
  isPathAllowed,
  pathWithinScope,
  isSafeRelativePath,
  parseCompletionContract,
  CompletionContractError,
} from '../src/orchestration/completion-contract.ts';
import { captureWorkspaceManifest, diffWorkspaceManifest, manifestDigest, relativePathCrossesLink, firstReparseAncestor } from '../src/orchestration/workspace-manifest.ts';
import { runApprovedTest } from '../src/orchestration/completion-evidence.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];
const ownedDirs: string[] = [];
const cleanupFailures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; process.stdout.write(`  ok   ${name}\n`); }
  else { failed++; failures.push(name); process.stdout.write(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}\n`); }
}
function section(t: string): void { process.stdout.write(`\n== ${t} ==\n`); }
function ownDir(tag: string): string { const d = mkdtempSync(join(tmpdir(), `p01-${tag}-`)); ownedDirs.push(d); return d; }

const AGENT = 'p01-agent';
const impl = 'implementation' as const;

const descriptor = (id: string): AgentDescriptor => ({
  id, displayName: id, launcher: 'fake', transport: 'cli-jsonl',
  capabilities: { newTask: true, review: true, modelSelection: true, resume: true, cwd: true },
} as unknown as AgentDescriptor);
const statusRow = (agent: string) => ({ agent, version: '1', installed: 'Yes', login: 'n/a', quotaSource: 't', usage: 'n/a', status: 'ok' });
const quotaRecord = (agentId: string): QuotaRecord => ({
  provider: agentId, agentId, modelId: null, source: 'locally_observed', usage: null, remaining: null,
  resetAt: null, period: 'day', status: 'available', usageClass: 'observed', confidence: 'high', observedAt: Date.now(), note: '',
});
const registryWith = (taskTypes: string[]): ModelRegistry => {
  const reg = new ModelRegistry();
  reg.upsert({ agentId: AGENT, modelId: 'm1', provider: 'test', taskTypes: taskTypes as never, modelSource: 'test', quotaSource: 'test' }, Date.now());
  reg.setAgentAvailability(AGENT, 'available');
  return reg;
};

interface Rig {
  wb: NativeWorkbench;
  orch: Orchestrator;
  budgets: BudgetManager;
  requests: RunRequest[];
  dir: string;
  cleanup: () => void;
}
function makeRig(opts: {
  onRun?: (req: RunRequest, index: number) => void;
  completionTimeoutMs?: number;
  completionTestStopProbe?: () => boolean;
  workspace?: unknown;
  resourceClaims?: unknown;
  workspaceMode?: unknown;
} = {}): Rig {
  const dir = ownDir('rig');
  // The runtime's own bookkeeping store lives OUTSIDE the workspace root, so it can
  // never be mistaken for a change the worker made.
  const storeDir = ownDir('store');
  const requests: RunRequest[] = [];
  const inner = new RuntimeOrch({
    config: { agents: {} } as never,
    storeDir,
    extraAdapters: [
      createFakeAdapter({ id: AGENT, script: [{ kind: 'exit', code: 0 }], capabilities: { newTask: true, review: true, modelSelection: true, cwd: true } }),
    ],
  });
  let index = 0;
  const runtime: RuntimeRunner = { run: (r: RunRequest) => { requests.push(r); opts.onRun?.(r, index++); return inner.run(r); } };
  const budgets = new BudgetManager(1_000_000);
  budgets.agent(AGENT, 1_000_000);
  const reg = registryWith(['implementation', 'test', 'research', 'review']);
  const orch = new Orchestrator({
    gate: {
      descriptors: [descriptor(AGENT)],
      agentStatus: [statusRow(AGENT)],
      quotaRecords: [quotaRecord(AGENT)],
      registry: reg,
      budgets,
      taskType: impl,
      requestedUnits: 10,
      currentConcurrency: 0,
      maxConcurrency: 4,
      maxChildren: 8,
      maxConcurrentAgents: 4,
    } as never,
    now: () => Date.now(),
    runtime,
    defaultCwd: dir,
    ...(opts.completionTimeoutMs !== undefined ? { completionTimeoutMs: opts.completionTimeoutMs } : {}),
    ...(opts.completionTestStopProbe !== undefined ? { completionTestStopProbe: opts.completionTestStopProbe } : {}),
    ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}),
    ...(opts.resourceClaims !== undefined ? { resourceClaims: opts.resourceClaims } : {}),
    ...(opts.workspaceMode !== undefined ? { workspaceMode: opts.workspaceMode } : {}),
  } as never);
  const scheduler = new TaskScheduler({ orchestrator: orch, cwd: dir });
  const wb = new NativeWorkbench({ orchestrator: orch, scheduler, registry: reg, quotaRecords: [quotaRecord(AGENT)], cwd: dir });
  return {
    wb, orch, budgets, requests, dir,
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch (e) { cleanupFailures.push(`cleanup ${dir}: ${(e as Error).message}`); } },
  };
}



/** A sequential plan-file whose coding steps carry an approved completion contract. */
function planWith(rig: Rig, steps: unknown[]): { rootId: string; candidates: ReturnType<typeof buildSequentialStepCandidates>; plan: ReturnType<typeof parsePlanFile> } {
  const plan = parsePlanFile({ kind: 'sequential', plans: [{ id: 'p', label: 'p', steps }] });
  const first = plan.plans[0]!;
  if (!isSequentialPlan(first)) throw new Error('unreachable');
  const rootId = `r${ownedDirs.length}`;
  const candidates = buildSequentialStepCandidates(first.steps, 'P0-1 scenario', rootId);
  // planWithCandidates bypasses the spawn gate; executeTask re-checks it, so the gate
  // needs a task-scope budget for every id that will actually be dispatched.
  for (const c of candidates) rig.budgets.task(c.taskId, 100_000);
  return { rootId, candidates, plan };
}

function specFor(rootId: string) {
  return { taskId: rootId, objective: 'P0-1 scenario', taskType: impl, preferredAgent: AGENT, budgetUnits: 100_000 } as never;
}

// ===========================================================================
section('P0-1.1 pure path/scope comparison');
// ===========================================================================
check('a plain relative path is safe', isSafeRelativePath('add.js'));
check('a nested relative path is safe', isSafeRelativePath('demo/add.js'));
check('a drive path is refused', !isSafeRelativePath('C:/add.js'));
check('a leading slash is refused', !isSafeRelativePath('/add.js'));
check('a parent traversal is refused', !isSafeRelativePath('../add.js'));
check('an embedded parent traversal is refused', !isSafeRelativePath('a/../../add.js'));
check('a NUL byte is refused', !isSafeRelativePath('a\u0000b'));
check('scope matches the exact path', pathWithinScope('add.js', 'add.js'));
check('scope matches a child of a directory scope', pathWithinScope('lib/a.js', 'lib'));
check('a sibling-prefix is NOT inside the scope', !pathWithinScope('add.js.sibling', 'add.js'));
check('a same-prefix directory is NOT inside a file scope', !pathWithinScope('demo/add.js', 'add.js'));
check('case is handled (Windows): Demo/Add.js under demo', isPathAllowed('Demo/Add.js', ['demo']));
check('nothing outside the list is allowed', !isPathAllowed('other.js', ['add.js']));
check('a trailing-dot alias segment is refused', !isSafeRelativePath('demo./add.js'));
check('a trailing-space alias segment is refused', !isSafeRelativePath('demo /add.js'));
check('a windows device name is refused', !isSafeRelativePath('CON'));
check('a reserved name with an extension is refused', !isSafeRelativePath('nul.txt'));
check('a trailing-dot alias resolves to the SAME scope (no bypass)', pathWithinScope('demo./add.js', 'demo'));
check('a trailing-dot scope is normalised, not a bypass', pathWithinScope('demo/add.js', 'demo.'));

// ===========================================================================
section('P0-1.2 the pure gate decision matrix');
// ===========================================================================
const taskView = (over: Partial<Parameters<typeof evaluateCompletionGate>[0]['task']> = {}) => ({
  taskId: 'T', leaseVersion: 1, agentId: 'a', modelId: 'm', contractDigest: 'd', ...over,
});
const evView = (over: Partial<NonNullable<Parameters<typeof evaluateCompletionGate>[0]['evidence']>> = {}) => ({
  contractDigest: 'd', taskId: 'T', leaseVersion: 1, agentId: 'a', modelId: 'm',
  runFingerprint: 'rf', sessionId: 's1',
  workspaceDigest: 'w', unsafeWorkspace: false, testCode: 0, testTimedOut: false,
  testTreeStopConfirmed: true, missingArtifacts: [] as string[], outOfScope: [] as string[], ...over,
});
const gate = (over: Partial<Parameters<typeof evaluateCompletionGate>[0]>): CompletionGateResult =>
  evaluateCompletionGate({
    contractPresent: true, task: taskView(), evidence: evView(), currentWorkspaceDigest: 'w',
    currentRunFingerprint: 'rf', currentSessionId: 's1', ...over,
  });

check('no contract => pass through', evaluateCompletionGate({ contractPresent: false, task: taskView({ contractDigest: null }), evidence: null, currentWorkspaceDigest: null, currentRunFingerprint: null, currentSessionId: null }).ok);
check('valid evidence => ok', gate({}).ok);
check('missing evidence => refused', gate({ evidence: null }).ok === false && (gate({ evidence: null }) as { code: string }).code === 'completion-evidence-missing');
check('contract digest mismatch => refused', (gate({ task: taskView({ contractDigest: 'other' }) }) as { code: string }).code === 'completion-contract-mismatch');
check('foreign task evidence => refused', (gate({ evidence: evView({ taskId: 'OTHER' }) }) as { code: string }).code === 'completion-evidence-foreign-task');
check('stale lease => refused', (gate({ task: taskView({ leaseVersion: 2 }) }) as { code: string }).code === 'completion-evidence-stale-lease');
check('identity mismatch => refused', (gate({ task: taskView({ agentId: 'b' }) }) as { code: string }).code === 'completion-evidence-identity-mismatch');
check('missing run proof => refused', (gate({ currentRunFingerprint: null }) as { code: string }).code === 'completion-run-proof-missing');
check('WRONG RunResult (fingerprint) => refused', (gate({ currentRunFingerprint: 'rf-other' }) as { code: string }).code === 'completion-run-proof-stale');
check('WRONG dispatch Session => refused', (gate({ currentSessionId: 's2' }) as { code: string }).code === 'completion-session-mismatch');
check('unsafe workspace => refused', (gate({ evidence: evView({ unsafeWorkspace: true }) }) as { code: string }).code === 'completion-workspace-unsafe');
check('workspace changed after proof => refused', (gate({ currentWorkspaceDigest: 'W2' }) as { code: string }).code === 'completion-evidence-stale-workspace');
check('test timeout => refused', (gate({ evidence: evView({ testTimedOut: true }) }) as { code: string }).code === 'completion-test-timeout');
check('test nonzero => refused', (gate({ evidence: evView({ testCode: 3 }) }) as { code: string }).code === 'completion-test-nonzero');
check('missing test exit => refused', (gate({ evidence: evView({ testCode: null }) }) as { code: string }).code === 'completion-test-nonzero');
check('test tree stop unconfirmed => refused', (gate({ evidence: evView({ testTreeStopConfirmed: false }) }) as { code: string }).code === 'completion-test-tree-unconfirmed');
check('missing artifact => refused', (gate({ evidence: evView({ missingArtifacts: ['add.js'] }) }) as { code: string }).code === 'completion-artifact-missing');
check('out-of-scope change => refused', (gate({ evidence: evView({ outOfScope: ['other.js'] }) }) as { code: string }).code === 'completion-scope-violation');

// ===========================================================================
section('P0-1.3 manifest: real add/modify/delete incl. dirty and ignored');
// ===========================================================================
{
  const dir = ownDir('manifest');
  writeFileSync(join(dir, 'dirty.txt'), 'old', 'utf8');
  writeFileSync(join(dir, 'keep.txt'), 'keep', 'utf8');
  writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n', 'utf8');
  const before = captureWorkspaceManifest(dir);
  writeFileSync(join(dir, 'dirty.txt'), 'old + this attempt', 'utf8'); // edit a preexisting dirty file
  writeFileSync(join(dir, 'ignored.txt'), 'new ignored output', 'utf8'); // ignored by .gitignore, still seen
  writeFileSync(join(dir, 'added.txt'), 'new', 'utf8');
  rmSync(join(dir, 'keep.txt'));
  const after = captureWorkspaceManifest(dir);
  const diff = diffWorkspaceManifest(before, after);
  check('an unchanged file is not reported', !diff.added.includes('keep.txt') && !diff.modified.includes('keep.txt'));
  check('an edit to a preexisting dirty file IS this attempt', diff.modified.includes('dirty.txt'));
  check('an ignored file still appears', diff.added.includes('ignored.txt'));
  check('a new file is added', diff.added.includes('added.txt'));
  check('a deleted file is reported', diff.deleted.includes('keep.txt'));
  check('a clean second capture diffs to nothing', diffWorkspaceManifest(after, captureWorkspaceManifest(dir)).modified.length === 0);
}

// ===========================================================================
section('P0-1.3a manifest: a >8MiB SAME-SIZE rewrite changes the digest');
// ===========================================================================
{
  const dir = ownDir('bigfile');
  const bigA = Buffer.alloc(9 * 1024 * 1024, 0x41); // 9 MiB of 'A'
  const bigB = Buffer.alloc(9 * 1024 * 1024, 0x42); // same size, all 'B'
  writeFileSync(join(dir, 'large.bin'), bigA);
  const before = captureWorkspaceManifest(dir);
  const digestBefore = manifestDigest(before);
  writeFileSync(join(dir, 'large.bin'), bigB);
  const after = captureWorkspaceManifest(dir);
  const digestAfter = manifestDigest(after);
  const diff = diffWorkspaceManifest(before, after);
  check('a same-size large rewrite is detected as modified', diff.modified.includes('large.bin'), JSON.stringify(diff.modified));
  check('a same-size large rewrite CHANGES the manifest digest', digestBefore !== null && digestAfter !== null && digestBefore !== digestAfter);
  check('the large file was content-hashed, not size-only', before.entries.get('large.bin')?.hash !== '' && after.entries.get('large.bin')?.hash !== '');
}

// ===========================================================================
section('P0-1.3b manifest: a Junction ROOT is refused, never followed');
// ===========================================================================
{
  const outside = ownDir('root-target');
  writeFileSync(join(outside, 'secret.txt'), 'outside', 'utf8');
  const linkParent = ownDir('root-link');
  const linkRoot = join(linkParent, 'junction-root');
  let made = false;
  try { symlinkSync(outside, linkRoot, 'junction'); made = true; }
  catch (e) { process.stdout.write(`  (junction root not creatable here: ${(e as Error).message})\n`); }
  if (made) {
    const m = captureWorkspaceManifest(linkRoot);
    check('a Junction ROOT makes the manifest unsafe', m.safe === false, m.reason ?? '');
    check('a Junction ROOT yields NO digest', manifestDigest(m) === null);
  } else {
    check('Junction ROOT subcase SKIPPED (privilege)', true);
  }
}

// ===========================================================================
section('P0-1.3c a linked approved cwd is detected before any test runs');
// ===========================================================================
{
  const root = ownDir('cwd-link-root');
  const outsideTarget = ownDir('cwd-link-target');
  writeFileSync(join(outsideTarget, 'x.txt'), 'x', 'utf8');
  let made = false;
  try { symlinkSync(outsideTarget, join(root, 'sub'), 'junction'); made = true; }
  catch (e) { process.stdout.write(`  (cwd junction not creatable here: ${(e as Error).message})\n`); }
  if (made) {
    check('a cwd that traverses a junction is detected', relativePathCrossesLink(root, 'sub'));
    check('a missing relative path is not reported as crossing a link', !relativePathCrossesLink(root, 'nope/deep'));
    check('the root itself is not reported as crossing a link', !relativePathCrossesLink(root, '.'));
  } else {
    check('linked-cwd subcase SKIPPED (privilege)', true);
  }
}

// ===========================================================================
section('P0-1.4 plan-file: a coding step without a contract is refused before write');
// ===========================================================================
{
  let code = '';
  try {
    parsePlanFile({ kind: 'sequential', plans: [{ id: 'p', label: 'p', steps: [{ role: 'w', taskType: 'implementation', deliverable: 'write add.js', fileScope: 'add.js' }] }] });
  } catch (e) { code = e instanceof PlanFileError ? e.code : 'not-planfile-error'; }
  check('an implementation step with no contract is refused', code !== '' && code !== 'not-planfile-error', code);

  let researchOk = true;
  try {
    const p = parsePlanFile({ kind: 'sequential', plans: [{ id: 'p', label: 'p', steps: [{ role: 'r', taskType: 'research', deliverable: 'read the code' }] }] });
    void p;
  } catch { researchOk = false; }
  check('a research step needs no contract (original compatibility)', researchOk);

  const parsed = parsePlanFile({
    kind: 'sequential',
    plans: [{ id: 'p', label: 'p', steps: [{ role: 'w', taskType: 'implementation', deliverable: 'write add.js', expectedArtifacts: ['add.js'], allowedScope: ['add.js'], test: { executable: 'node', argv: ['-e', 'process.exit(0)'], cwd: '.' } }] }],
  });
  const parsedFirst = parsed.plans[0]!;
  if (!isSequentialPlan(parsedFirst)) throw new Error('unreachable');
  const cands = buildSequentialStepCandidates(parsedFirst.steps, 'obj', 'root');
  check('a coding contract propagates onto the candidate', (cands[0] as { completion?: unknown }).completion !== undefined);
}

// ===========================================================================
section('P0-1.5 END-TO-END: valid add.js + approved test exit0 completes');
// ===========================================================================
{
  const rig = makeRig({ onRun: (req) => { writeFileSync(join(req.cwd, 'add.js'), 'console.log(1)\n', 'utf8'); } });
  const { rootId, candidates } = planWith(rig, [{ role: 'writer', taskType: 'implementation', fileScope: 'add.js', deliverable: 'add.js', expectedArtifacts: ['add.js'], allowedScope: ['add.js'], test: { executable: 'node', argv: ['-e', 'process.exit(0)'], cwd: '.' } }]);
  rig.wb.planWithCandidates(specFor(rootId), candidates);
  rig.wb.assignChildren(rootId, specFor(rootId));
  await rig.wb.dispatch();
  const child = rig.wb.store.get(`${rootId}-w1`);
  check('the contracted child reached to_verify', child?.status === 'to_verify', child?.status);
  const done = rig.wb.completeTask(`${rootId}-w1`, 'valid artifact + approved test passed');
  check('the contracted child COMPLETED through the gate', done.ok, `${done.code}: ${done.reason}`);
  check('the task is succeeded', rig.wb.store.get(`${rootId}-w1`)?.status === 'succeeded');
  rig.cleanup();
}

// ===========================================================================
section('P0-1.6 wrong path (demo/add.js) is refused and no downstream run');
// ===========================================================================
{
  const rig = makeRig({ onRun: (req) => {
    mkdirSync(join(req.cwd, 'demo'), { recursive: true });
    writeFileSync(join(req.cwd, 'demo', 'add.js'), 'wrong place\n', 'utf8');
  } });
  const { rootId, candidates } = planWith(rig, [
    { role: 'writer', taskType: 'implementation', fileScope: 'add.js', deliverable: 'add.js', expectedArtifacts: ['add.js'], allowedScope: ['add.js'], test: { executable: 'node', argv: ['-e', 'process.exit(0)'], cwd: '.' } },
    { role: 'next', taskType: 'implementation', fileScope: 'b.js', deliverable: 'b.js', expectedArtifacts: ['b.js'], allowedScope: ['b.js'], test: { executable: 'node', argv: ['-e', 'process.exit(0)'], cwd: '.' } },
  ]);
  rig.wb.planWithCandidates(specFor(rootId), candidates);
  rig.wb.assignChildren(rootId, specFor(rootId));
  await rig.wb.dispatch();
  const done = rig.wb.completeTask(`${rootId}-w1`, 'should fail');
  check('the wrong-path delivery is REFUSED', !done.ok, done.code);
  check('the artifact-missing refusal is named', !done.ok && (done.code === 'completion-artifact-missing' || done.code === 'completion-scope-violation'), done.code);
  check('the task did NOT succeed', rig.wb.store.get(`${rootId}-w1`)?.status === 'to_verify');
  check('the downstream task never ran', rig.requests.length === 1);
  check('the downstream task is not succeeded', rig.wb.store.get(`${rootId}-w2`)?.status !== 'succeeded');
  check('no file was auto-moved to the root', !existsSync(join(rig.dir, 'add.js')));
  rig.cleanup();
}

// ===========================================================================
section('P0-1.7 out-of-scope / dirty edit / nonzero test / timeout / post-edit');
// ===========================================================================
{
  // Out-of-scope extra file.
  const rig = makeRig({ onRun: (req) => {
    writeFileSync(join(req.cwd, 'add.js'), 'ok\n', 'utf8');
    writeFileSync(join(req.cwd, 'sneaky.txt'), 'out of scope\n', 'utf8');
  } });
  const { rootId, candidates } = planWith(rig, [{ role: 'w', taskType: 'implementation', fileScope: 'add.js', deliverable: 'add.js', expectedArtifacts: ['add.js'], allowedScope: ['add.js'], test: { executable: 'node', argv: ['-e', 'process.exit(0)'], cwd: '.' } }]);
  rig.wb.planWithCandidates(specFor(rootId), candidates);
  rig.wb.assignChildren(rootId, specFor(rootId));
  await rig.wb.dispatch();
  const done = rig.wb.completeTask(`${rootId}-w1`, 'x');
  check('an out-of-scope addition is refused', !done.ok && done.code === 'completion-scope-violation', done.code);
  rig.cleanup();
}
{
  // Nonzero approved test.
  const rig = makeRig({ onRun: (req) => { writeFileSync(join(req.cwd, 'add.js'), 'ok\n', 'utf8'); } });
  const { rootId, candidates } = planWith(rig, [{ role: 'w', taskType: 'implementation', fileScope: 'add.js', deliverable: 'add.js', expectedArtifacts: ['add.js'], allowedScope: ['add.js'], test: { executable: 'node', argv: ['-e', 'process.exit(3)'], cwd: '.' } }]);
  rig.wb.planWithCandidates(specFor(rootId), candidates);
  rig.wb.assignChildren(rootId, specFor(rootId));
  await rig.wb.dispatch();
  const done = rig.wb.completeTask(`${rootId}-w1`, 'x');
  check('a nonzero approved test is refused', !done.ok && done.code === 'completion-test-nonzero', done.code);
  rig.cleanup();
}
{
  // Timeout approved test.
  const rig = makeRig({ completionTimeoutMs: 700, onRun: (req) => { writeFileSync(join(req.cwd, 'add.js'), 'ok\n', 'utf8'); } });
  const { rootId, candidates } = planWith(rig, [{ role: 'w', taskType: 'implementation', fileScope: 'add.js', deliverable: 'add.js', expectedArtifacts: ['add.js'], allowedScope: ['add.js'], test: { executable: 'node', argv: ['-e', 'setTimeout(() => {}, 60000)'], cwd: '.' } }]);
  rig.wb.planWithCandidates(specFor(rootId), candidates);
  rig.wb.assignChildren(rootId, specFor(rootId));
  await rig.wb.dispatch();
  const done = rig.wb.completeTask(`${rootId}-w1`, 'x');
  check('a timed-out approved test is refused', !done.ok && done.code === 'completion-test-timeout', done.code);
  rig.cleanup();
}
{
  // Post-validation edit.
  const rig = makeRig({ onRun: (req) => { writeFileSync(join(req.cwd, 'add.js'), 'ok\n', 'utf8'); } });
  const { rootId, candidates } = planWith(rig, [{ role: 'w', taskType: 'implementation', fileScope: 'add.js', deliverable: 'add.js', expectedArtifacts: ['add.js'], allowedScope: ['add.js'], test: { executable: 'node', argv: ['-e', 'process.exit(0)'], cwd: '.' } }]);
  rig.wb.planWithCandidates(specFor(rootId), candidates);
  rig.wb.assignChildren(rootId, specFor(rootId));
  await rig.wb.dispatch();
  writeFileSync(join(rig.dir, 'add.js'), 'edited after the proof\n', 'utf8');
  const done = rig.wb.completeTask(`${rootId}-w1`, 'x');
  check('an edit after validation invalidates the proof', !done.ok && done.code === 'completion-evidence-stale-workspace', done.code);
  rig.cleanup();
}

// ===========================================================================
section('P0-1.8 noncoding research compatibility');
// ===========================================================================
{
  const rig = makeRig();
  rig.budgets.task('res-r-w1', 100_000);
  const candidates = [{ taskId: 'res-r-w1', parentTaskId: 'res-r', taskType: 'research' as const, description: 'research the code', dependencies: [] as string[], requiredTaskTypes: ['research' as const] }];
  rig.wb.planWithCandidates({ taskId: 'res-r', objective: 'research', taskType: 'research', preferredAgent: AGENT, budgetUnits: 100_000 } as never, candidates);
  rig.wb.assignChildren('res-r', { taskId: 'res-r', objective: 'research', taskType: 'research', preferredAgent: AGENT, budgetUnits: 100_000 } as never);
  await rig.wb.dispatch();
  const done = rig.wb.completeTask('res-r-w1', 'research accepted');
  check('a research task with no contract still completes (compatibility)', done.ok, `${done.code}: ${done.reason}`);
  rig.cleanup();
}

// ===========================================================================
section('P0-1.9 Windows junction in the workspace => conservative refusal');
// ===========================================================================
{
  const rig = makeRig({ onRun: (req) => { writeFileSync(join(req.cwd, 'add.js'), 'ok\n', 'utf8'); } });
  const outside = ownDir('junction-target');
  writeFileSync(join(outside, 'secret.txt'), 'outside', 'utf8');
  let junctionMade = false;
  try { symlinkSync(outside, join(rig.dir, 'linkdir'), 'junction'); junctionMade = true; }
  catch (e) { process.stdout.write(`  (junction not creatable here: ${(e as Error).message})\n`); }
  if (junctionMade) {
    const { rootId, candidates } = planWith(rig, [{ role: 'w', taskType: 'implementation', fileScope: 'add.js', deliverable: 'add.js', expectedArtifacts: ['add.js'], allowedScope: ['add.js'], test: { executable: 'node', argv: ['-e', 'process.exit(0)'], cwd: '.' } }]);
    rig.wb.planWithCandidates(specFor(rootId), candidates);
    rig.wb.assignChildren(rootId, specFor(rootId));
    await rig.wb.dispatch();
    const done = rig.wb.completeTask(`${rootId}-w1`, 'x');
    check('a junction makes the workspace unsafe and refuses', !done.ok && done.code === 'completion-workspace-unsafe', done.code);
    check('the outside sentinel was not traversed/modified', readFileSync(join(outside, 'secret.txt'), 'utf8') === 'outside');
  } else {
    check('junction conservative-refusal subcase SKIPPED (privilege)', true);
  }
  rig.cleanup();
}

// ===========================================================================
section('P0-1.9a a TEST-induced out-of-scope write is rejected');
// ===========================================================================
{
  // The worker writes ONLY add.js (allowed). The APPROVED TEST then writes a file
  // outside allowedScope; the total baseline→afterTest difference must catch it.
  const rig = makeRig({ onRun: (req) => { writeFileSync(join(req.cwd, 'add.js'), 'ok\n', 'utf8'); } });
  const { rootId, candidates } = planWith(rig, [{ role: 'w', taskType: 'implementation', fileScope: 'add.js', deliverable: 'add.js', expectedArtifacts: ['add.js'], allowedScope: ['add.js'], test: { executable: 'node', argv: ['-e', "require('fs').writeFileSync('test-out.txt','sneaky')"], cwd: '.' } }]);
  rig.wb.planWithCandidates(specFor(rootId), candidates);
  rig.wb.assignChildren(rootId, specFor(rootId));
  await rig.wb.dispatch();
  const done = rig.wb.completeTask(`${rootId}-w1`, 'x');
  check('a file written by the approved TEST outside scope is refused', !done.ok && done.code === 'completion-scope-violation', done.code);
  check('the test really did write the out-of-scope file', existsSync(join(rig.dir, 'test-out.txt')));
  rig.cleanup();
}

// ===========================================================================
section('P0-1.9b a coding leaf with NO contract and NO execution is refused');
// ===========================================================================
{
  // A real Workbench/TaskStore boundary: the task is hand-driven to `to_verify`
  // WITHOUT ever running, exactly the bypass Codex reproduced. No contract, no proof.
  const rig = makeRig();
  rig.budgets.task('nc-r-w1', 100_000);
  const candidates = [{ taskId: 'nc-r-w1', parentTaskId: 'nc-r', taskType: 'implementation' as const, description: 'write a file', dependencies: [] as string[], requiredTaskTypes: ['implementation' as const] }];
  rig.wb.planWithCandidates({ taskId: 'nc-r', objective: 'nc', taskType: impl, preferredAgent: AGENT, budgetUnits: 100_000 } as never, candidates);
  rig.wb.assignChildren('nc-r', { taskId: 'nc-r', objective: 'nc', taskType: impl, preferredAgent: AGENT, budgetUnits: 100_000 } as never);
  // Hand-set the finished state: planned -> queued -> running -> to_verify, no run.
  rig.orch.queue('nc-r-w1'); rig.orch.start('nc-r-w1');
  rig.wb.store.transition('nc-r-w1', 'to_verify', Date.now());
  const done = rig.wb.completeTask('nc-r-w1', 'should be refused');
  check('a coding leaf with no contract/no run is REFUSED', !done.ok && done.code === 'completion-contract-missing', done.code);
  check('the hand-set task did NOT succeed', rig.wb.store.get('nc-r-w1')?.status === 'to_verify');
  check('no runtime run was spent on the refusal', rig.requests.length === 0);
  rig.cleanup();
}

// ===========================================================================
section('P0-1.9c an unconfirmed TEST tree-stop is refused AND retains the WRITE claim');
// ===========================================================================
{
  // A narrow injected stop-error seam: the approved test exits 0 but its tree stop is
  // reported UNCONFIRMED (no real orphan is created). The gate must refuse, and the
  // outer shared WRITE-claim release decision must RETAIN protection.
  const retainCalls: Array<{ taskId: string; mode: string }> = [];
  const releaseCalls: string[] = [];
  const preparedCwd = { dir: '' };
  const workspaceStub = {
    prepare: async () => ({ workspaceId: 'ws-1', mode: 'shared', taskId: 'ws-1', cwd: preparedCwd.dir, branch: null, baseSha: null, repoRoot: preparedCwd.dir, createdAt: Date.now(), released: false }),
    getProjectRoot: () => preparedCwd.dir,
    resourceConflicts: () => [],
    claimResource: () => ({ ok: true }),
    voidStaleResourceClaims: () => [],
    releaseClaimForScope: (taskId: string) => { releaseCalls.push(taskId); return 0; },
    retainResourceProtection: (taskId: string, mode: string) => { retainCalls.push({ taskId, mode }); return 1; },
  };
  const rig = makeRig({
    onRun: (req) => { writeFileSync(join(req.cwd, 'add.js'), 'ok\n', 'utf8'); },
    completionTestStopProbe: () => false,
    workspace: workspaceStub,
    workspaceMode: () => 'shared',
    resourceClaims: () => ({ mode: 'exclusive-write', scope: { kind: 'workspace', workspaceId: 'ws-1' } }),
  });
  preparedCwd.dir = rig.dir;
  const { rootId, candidates } = planWith(rig, [{ role: 'w', taskType: 'implementation', fileScope: 'add.js', deliverable: 'add.js', expectedArtifacts: ['add.js'], allowedScope: ['add.js'], test: { executable: 'node', argv: ['-e', 'process.exit(0)'], cwd: '.' } }]);
  rig.wb.planWithCandidates(specFor(rootId), candidates);
  rig.wb.assignChildren(rootId, specFor(rootId));
  await rig.wb.dispatch();
  const done = rig.wb.completeTask(`${rootId}-w1`, 'x');
  check('an unconfirmed test tree-stop is REFUSED', !done.ok && done.code === 'completion-test-tree-unconfirmed', done.code);
  check('the task stayed to_verify (never succeeded)', rig.wb.store.get(`${rootId}-w1`)?.status === 'to_verify');
  check('the outer WRITE claim was RETAINED, not released', retainCalls.length >= 1 && releaseCalls.length === 0,
    `retain=${JSON.stringify(retainCalls)} release=${JSON.stringify(releaseCalls)}`);
  rig.cleanup();
}

// ===========================================================================
section('P0-1.11 an ACTUAL dispatched coding task with NO contract is refused');
// ===========================================================================
{
  // Codex counterexample #1: an implementation child is really dispatched (the fake
  // runtime writes add.js) but declares NO completion contract. A real `RunResult` is
  // not a completion contract, so `completeTask` must refuse.
  const rig = makeRig({ onRun: (req) => { writeFileSync(join(req.cwd, 'add.js'), 'ok\n', 'utf8'); } });
  const rootId = 'nc-actual';
  const childId = `${rootId}-w1`;
  rig.budgets.task(childId, 100_000);
  rig.wb.planWithCandidates(specFor(rootId), [
    { taskId: childId, parentTaskId: rootId, budgetUnits: 10_000, requiredTaskTypes: ['implementation'], taskType: 'implementation', description: 'write add.js', dependencies: [] },
  ] as never);
  rig.wb.assignChildren(rootId, specFor(rootId));
  await rig.wb.dispatch();
  check('the uncontracted child really ran', rig.requests.length === 1);
  check('the uncontracted child reached to_verify', rig.wb.store.get(childId)?.status === 'to_verify', rig.wb.store.get(childId)?.status);
  const done = rig.wb.completeTask(childId, 'no contract');
  check('a real run with no contract is REFUSED', !done.ok && done.code === 'completion-contract-missing', `${done.code}: ${done.reason}`);
  check('the task did NOT succeed', rig.wb.store.get(childId)?.status === 'to_verify');
  // The SAME refusal holds when the entry point is `applyVerification` directly.
  const direct = rig.orch.applyVerification(childId, { verdict: 'pass', reason: 'direct' });
  check('direct applyVerification uses the same gate', direct.ok === false && direct.code === 'completion-contract-missing', direct.ok === false ? direct.code : 'ok');
  rig.cleanup();
}

// ===========================================================================
section('P0-1.12 a FOREIGN / wrong attempt, session or run binding is refused');
// ===========================================================================
{
  const approvedTest = { executable: 'node', argv: ['-e', 'process.exit(0)'], cwd: '.' };
  const dispatchContracted = async (): Promise<{ rig: Rig; childId: string }> => {
    const rig = makeRig({ onRun: (req) => { writeFileSync(join(req.cwd, 'add.js'), 'ok\n', 'utf8'); } });
    const { rootId, candidates } = planWith(rig, [{ role: 'w', taskType: 'implementation', fileScope: 'add.js', deliverable: 'add.js', expectedArtifacts: ['add.js'], allowedScope: ['add.js'], test: approvedTest }]);
    rig.wb.planWithCandidates(specFor(rootId), candidates);
    rig.wb.assignChildren(rootId, specFor(rootId));
    await rig.wb.dispatch();
    return { rig, childId: `${rootId}-w1` };
  };

  // --- foreign (nonexistent) attempt id ---
  {
    const { rig, childId } = await dispatchContracted();
    const history = rig.wb.evidence.history(childId);
    const rec = history[history.length - 1];
    check('the real dispatch recorded an attempt with a session', rec !== undefined && rec.sessionId !== undefined);
    rig.orch.recordAttemptBinding(childId, { attemptId: 'FOREIGN_NONEXISTENT_ATTEMPT', sessionId: rec?.sessionId ?? null });
    const done = rig.wb.completeTask(childId, 'foreign attempt');
    check('a FOREIGN attempt binding is REFUSED', !done.ok && done.code === 'completion-attempt-foreign', `${done.code}: ${done.reason}`);
    check('the task did NOT succeed after a foreign attempt', rig.wb.store.get(childId)?.status === 'to_verify');
    rig.cleanup();
  }
  // --- real attempt id, WRONG session ---
  {
    const { rig, childId } = await dispatchContracted();
    const history = rig.wb.evidence.history(childId);
    const rec = history[history.length - 1]!;
    rig.orch.recordAttemptBinding(childId, { attemptId: rec.attemptId, sessionId: 'ws_WRONG' });
    const done = rig.wb.completeTask(childId, 'wrong session');
    check('a WRONG session binding is REFUSED', !done.ok && done.code === 'completion-attempt-session-mismatch', `${done.code}: ${done.reason}`);
    rig.cleanup();
  }
  // --- real attempt id/session, a DIFFERENT run ---
  {
    const { rig, childId } = await dispatchContracted();
    const history = rig.wb.evidence.history(childId);
    const rec = history[history.length - 1]!;
    const otherRun = { agentId: AGENT, modelId: 'm1', state: 'succeeded', startedAt: 1, endedAt: 2, exitCode: 0 } as never;
    rig.orch.recordAttemptBinding(childId, { attemptId: rec.attemptId, sessionId: rec.sessionId ?? null, run: otherRun });
    const done = rig.wb.completeTask(childId, 'wrong run');
    check('a binding for a DIFFERENT run is REFUSED', !done.ok && done.code === 'completion-attempt-run-mismatch', `${done.code}: ${done.reason}`);
    rig.cleanup();
  }
  // --- control: the untouched legitimate binding still completes ---
  {
    const { rig, childId } = await dispatchContracted();
    const done = rig.wb.completeTask(childId, 'legit');
    check('the untouched legitimate binding still COMPLETES', done.ok, `${done.code}: ${done.reason}`);
    rig.cleanup();
  }
}

// ===========================================================================
section('P0-1.14 an ANCESTOR junction makes the manifest unsafe (REAL owned test)');
// ===========================================================================
{
  // Codex counterexample #3: the root's OWN lstat is clean, but it is reached THROUGH a
  // junction ancestor. Junctions work on this machine, so this is not skipped.
  const physical = ownDir('anc-physical');
  mkdirSync(join(physical, 'child'), { recursive: true });
  writeFileSync(join(physical, 'child', 'x.txt'), 'x', 'utf8');
  const holder = ownDir('anc-holder');
  const alias = join(holder, 'alias');
  let made = false;
  try { symlinkSync(physical, alias, 'junction'); made = true; }
  catch (e) { process.stdout.write(`  (ancestor junction not creatable: ${(e as Error).message})\n`); }
  check('the ancestor junction fixture was created (junctions work on this machine)', made);
  if (made) {
    const viaAlias = join(alias, 'child');
    check('the ancestor junction prefix is identified', firstReparseAncestor(viaAlias) === alias, String(firstReparseAncestor(viaAlias)));
    const m = captureWorkspaceManifest(viaAlias);
    check('a root reached through an ancestor junction is UNSAFE', m.safe === false, m.reason ?? '');
    check('an ancestor-junction manifest yields NO digest', manifestDigest(m) === null);
    check('the direct (non-aliased) path is still safe', captureWorkspaceManifest(join(physical, 'child')).safe === true);
    unlinkSync(alias);
  }
}

// ===========================================================================
section('P0-1.15 an unapproved .git write by the TEST is refused');
// ===========================================================================
{
  // Codex counterexample #4: the approved test writes .git/forbidden.txt while only
  // add.js is allowed. A name-only .git exclusion must not hide it.
  const rig = makeRig({ onRun: (req) => { writeFileSync(join(req.cwd, 'add.js'), 'ok\n', 'utf8'); } });
  const { rootId, candidates } = planWith(rig, [{
    role: 'w', taskType: 'implementation', fileScope: 'add.js', deliverable: 'add.js',
    expectedArtifacts: ['add.js'], allowedScope: ['add.js'],
    test: { executable: 'node', argv: ['-e', "const fs=require('node:fs');fs.mkdirSync('.git',{recursive:true});fs.writeFileSync('.git/forbidden.txt','unapproved')"], cwd: '.' },
  }]);
  rig.wb.planWithCandidates(specFor(rootId), candidates);
  rig.wb.assignChildren(rootId, specFor(rootId));
  await rig.wb.dispatch();
  const done = rig.wb.completeTask(`${rootId}-w1`, 'x');
  check('an unapproved .git write is REFUSED', !done.ok && done.code === 'completion-scope-violation', `${done.code}: ${done.reason}`);
  check('the .git/forbidden.txt really existed (not silently ignored)', existsSync(join(rig.dir, '.git', 'forbidden.txt')));
  check('the task did NOT succeed', rig.wb.store.get(`${rootId}-w1`)?.status === 'to_verify');
  rig.cleanup();
}

// ===========================================================================
section('P0-1.16 the stop probe can only DOWNGRADE the launcher verdict');
// ===========================================================================
{
  const dir = ownDir('stop-probe');
  const cmd = { executable: 'node', argv: ['-e', 'process.exit(0)'], cwd: '.' };
  const base = await runApprovedTest(cmd, dir, 30_000);
  const withTrue = await runApprovedTest(cmd, dir, 30_000, { stopVerdictProbe: () => true });
  const withFalse = await runApprovedTest(cmd, dir, 30_000, { stopVerdictProbe: () => false });
  check('a probe returning true never manufactures a confirmed stop', withTrue.treeStopConfirmed === base.treeStopConfirmed,
    `base=${base.treeStopConfirmed} withTrue=${withTrue.treeStopConfirmed}`);
  check('a probe returning false downgrades the launcher verdict', withFalse.treeStopConfirmed === false);
  check('the approved test really exited 0', base.code === 0 && base.timedOut === false);
}

// ===========================================================================
section('P0-1.10 NEGATIVE CONTROL: a disabled gate copy would be caught');
// ===========================================================================
{
  const realSrc = readFileSync(join(process.cwd(), 'src', 'orchestration', 'completion-gate.ts'), 'utf8');
  const disabledSrc = realSrc.replace(
    '  const evidence = input.evidence;',
    '  const evidence = input.evidence;\n  return { ok: true };',
  );
  check('the negative-control edit actually changed the source', disabledSrc !== realSrc);
  const negDir = join(process.cwd(), `p01-negative-control-${process.pid}.tmp`);
  mkdirSync(negDir, { recursive: true });
  const negFile = join(negDir, 'gate.ts');
  writeFileSync(negFile, disabledSrc, 'utf8');
  try {
    const mod = await import(pathToFileURL(negFile).href) as { evaluateCompletionGate: typeof evaluateCompletionGate };
    const disabled = mod.evaluateCompletionGate({ contractPresent: true, task: taskView(), evidence: null, currentWorkspaceDigest: 'w', currentRunFingerprint: 'rf', currentSessionId: 's1' });
    // The REAL gate refuses a missing proof; the DISABLED copy accepts it. A suite that
    // asserted only the disabled behaviour would look green while the gate is off — the
    // check below is what makes the test detect that regression.
    check('the real gate REFUSES missing evidence', !gate({ evidence: null }).ok);
    check('the disabled copy ACCEPTS missing evidence (bypass detected)', disabled.ok === true);
  } finally {
    try { rmSync(negDir, { recursive: true, force: true }); } catch (e) { cleanupFailures.push(`neg control cleanup: ${(e as Error).message}`); }
  }
  check('the negative-control copy was removed', !existsSync(negFile));
}

// ===========================================================================
section('P0-1.17 CLOSURE: exact-run provenance defeats an attempt relabel');
// ===========================================================================
{
  // Codex counterexample #1: a REAL contracted dispatch produced att_...; an attacker
  // appends a SECOND success execution for the SAME task/pair/session/lease (different
  // times) and relabels the proof to it — WITHOUT a run, so no caller-filled field is
  // even needed. The append-site provenance must refuse it, and the SAME task, left with
  // its real binding, must still complete.
  const rig = makeRig({ onRun: (req) => { writeFileSync(join(req.cwd, 'add.js'), 'ok\n', 'utf8'); } });
  const { rootId, candidates } = planWith(rig, [{ role: 'w', taskType: 'implementation', fileScope: 'add.js', deliverable: 'add.js', expectedArtifacts: ['add.js'], allowedScope: ['add.js'], test: { executable: 'node', argv: ['-e', 'process.exit(0)'], cwd: '.' } }]);
  rig.wb.planWithCandidates(specFor(rootId), candidates);
  rig.wb.assignChildren(rootId, specFor(rootId));
  await rig.wb.dispatch();
  const childId = `${rootId}-w1`;
  const history = rig.wb.evidence.history(childId);
  const rec = history[history.length - 1]!;
  const raw: Record<string, unknown> = { ...rec, startedAt: rec.startedAt - 2000, finishedAt: (rec.finishedAt ?? rec.startedAt) - 1000 };
  delete raw.attemptId;
  const other = rig.wb.evidence.append(raw);
  check('a second, DIFFERENT run record was appended for the same task', other.ok);
  if (other.ok) {
    // (a) relabel WITHOUT a run — the exact demonstrated bypass.
    rig.orch.recordAttemptBinding(childId, { attemptId: other.record.attemptId, sessionId: rec.sessionId ?? null });
    const relabel = rig.wb.completeTask(childId, 'relabel');
    check('a relabel to another run attempt (no run) is REFUSED',
      !relabel.ok && relabel.code === 'completion-attempt-provenance-mismatch', `${relabel.code}: ${relabel.reason}`);
    check('the task did NOT succeed after the relabel', rig.wb.store.get(childId)?.status === 'to_verify');
    // (b) relabel WITH a fabricated clone carrying matching-looking fields.
    const realRun = rig.wb.lastRunResult(childId)!;
    rig.orch.recordAttemptBinding(childId, { attemptId: other.record.attemptId, sessionId: rec.sessionId ?? null, run: { ...realRun } as never });
    const cloned = rig.wb.completeTask(childId, 'cloned run');
    check('a relabel with a CLONED run object is REFUSED', !cloned.ok, `${cloned.code}: ${cloned.reason}`);
    // (c) restore the legitimate binding (exact accepted run) -> it completes.
    rig.orch.recordAttemptBinding(childId, { attemptId: rec.attemptId, sessionId: rec.sessionId ?? null, run: realRun });
    const restored = rig.wb.completeTask(childId, 'restored');
    check('the restored EXACT binding still COMPLETES', restored.ok, `${restored.code}: ${restored.reason}`);
  }
  rig.cleanup();
}

// ===========================================================================
section('P0-1.18 CLOSURE: a direct candidate with an EMPTY contract is refused');
// ===========================================================================
{
  // Codex counterexample #2: `planWithCandidates` handed a raw candidate with an EMPTY
  // expectedArtifacts — which the plan-file parser rejects but the direct path used to
  // accept verbatim. The common commit boundary must validate + freeze it.
  const rig = makeRig();
  rig.budgets.task('nc2-w1', 100_000);
  let refused: unknown = null;
  try {
    rig.wb.planWithCandidates({ taskId: 'nc2', objective: 'nc2', taskType: impl, preferredAgent: AGENT, budgetUnits: 100_000 } as never, [
      {
        taskId: 'nc2-w1', parentTaskId: 'nc2', taskType: 'implementation' as const, description: 'write add.js',
        dependencies: [] as string[], requiredTaskTypes: ['implementation' as const],
        completion: { expectedArtifacts: [], allowedScope: ['add.js'], test: { executable: 'node', argv: ['-e', 'process.exit(0)'], cwd: '.' } },
      },
    ] as never);
  } catch (e) { refused = e; }
  check('a direct candidate with EMPTY expectedArtifacts is REFUSED before any task is written',
    refused !== null && /completion-refused|empty-expected-artifacts/.test((refused as Error).message), String(refused instanceof Error ? refused.message : refused));
  check('the refused candidate created NO task and NO root', !rig.wb.store.has('nc2-w1') && !rig.wb.store.has('nc2'));
  check('no runtime run was spent on the refusal', rig.requests.length === 0);
  rig.cleanup();
}

// ===========================================================================
section('P0-1.19 CLOSURE: the pure read-only TEST contract distinction is exact');
// ===========================================================================
{
  const testCmd = { executable: 'node', argv: ['-e', 'process.exit(0)'], cwd: '.' };
  // The ONE permitted empty contract: a `test` task with EXPLICIT empty artifacts AND
  // empty scope (a read-only, test-only execution). Any durable write would fail scope.
  let readOnlyOk = false;
  try { parseCompletionContract({ expectedArtifacts: [], allowedScope: [], test: testCmd }, 't', { taskType: 'test' }); readOnlyOk = true; } catch { readOnlyOk = false; }
  check('a read-only TEST task may declare empty artifacts + empty scope', readOnlyOk);
  const refuses = (input: { expectedArtifacts: unknown; allowedScope: unknown; test: unknown }, taskType: 'implementation' | 'test'): string => {
    try { parseCompletionContract(input, 't', { taskType }); return ''; }
    catch (e) { return e instanceof CompletionContractError ? e.code : 'other'; }
  };
  check('an IMPLEMENTATION with empty artifacts is refused', refuses({ expectedArtifacts: [], allowedScope: ['src'], test: testCmd }, 'implementation') === 'empty-expected-artifacts');
  check('a TEST with empty artifacts but a NON-empty scope (file-writing test) is refused',
    refuses({ expectedArtifacts: [], allowedScope: ['tests'], test: testCmd }, 'test') === 'empty-expected-artifacts');
  check('a TEST with artifacts but an EMPTY scope is refused',
    refuses({ expectedArtifacts: ['tests/x.txt'], allowedScope: [], test: testCmd }, 'test') === 'empty-allowed-scope');
  check('a TEST with a real artifact + scope is accepted',
    refuses({ expectedArtifacts: ['tests/x.txt'], allowedScope: ['tests'], test: testCmd }, 'test') === '');
}

// ===========================================================================
section('cleanup');
// ===========================================================================
for (const d of ownedDirs) {
  try { if (existsSync(d)) rmSync(d, { recursive: true, force: true }); } catch (e) { cleanupFailures.push(`owned dir ${d}: ${(e as Error).message}`); }
}
for (const f of cleanupFailures) { failed++; failures.push(f); process.stdout.write(`  FAIL cleanup :: ${f}\n`); }
check('every owned directory was cleaned up', cleanupFailures.length === 0);

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) { process.stdout.write(`failures:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`); }
process.exit(failed > 0 ? 1 : 0);
