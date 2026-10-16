/**
 * tests/p01-completion-gate.test.ts �?P0-1: the deterministic completion gate.
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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
} from '../src/orchestration/completion-contract.ts';
import { captureWorkspaceManifest, diffWorkspaceManifest } from '../src/orchestration/workspace-manifest.ts';

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
function makeRig(opts: { onRun?: (req: RunRequest, index: number) => void; completionTimeoutMs?: number } = {}): Rig {
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
  });
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

// ===========================================================================
section('P0-1.2 the pure gate decision matrix');
// ===========================================================================
const taskView = (over: Partial<Parameters<typeof evaluateCompletionGate>[0]['task']> = {}) => ({
  taskId: 'T', leaseVersion: 1, agentId: 'a', modelId: 'm', contractDigest: 'd', ...over,
});
const evView = (over: Partial<NonNullable<Parameters<typeof evaluateCompletionGate>[0]['evidence']>> = {}) => ({
  contractDigest: 'd', taskId: 'T', leaseVersion: 1, agentId: 'a', modelId: 'm',
  workspaceDigest: 'w', unsafeWorkspace: false, testCode: 0, testTimedOut: false,
  testTreeStopConfirmed: true, missingArtifacts: [] as string[], outOfScope: [] as string[], ...over,
});
const gate = (over: Partial<Parameters<typeof evaluateCompletionGate>[0]>): CompletionGateResult =>
  evaluateCompletionGate({ contractPresent: true, task: taskView(), evidence: evView(), currentWorkspaceDigest: 'w', ...over });

check('no contract => pass through', evaluateCompletionGate({ contractPresent: false, task: taskView({ contractDigest: null }), evidence: null, currentWorkspaceDigest: null }).ok);
check('valid evidence => ok', gate({}).ok);
check('missing evidence => refused', gate({ evidence: null }).ok === false && (gate({ evidence: null }) as { code: string }).code === 'completion-evidence-missing');
check('contract digest mismatch => refused', (gate({ task: taskView({ contractDigest: 'other' }) }) as { code: string }).code === 'completion-contract-mismatch');
check('foreign task evidence => refused', (gate({ evidence: evView({ taskId: 'OTHER' }) }) as { code: string }).code === 'completion-evidence-foreign-task');
check('stale lease => refused', (gate({ task: taskView({ leaseVersion: 2 }) }) as { code: string }).code === 'completion-evidence-stale-lease');
check('identity mismatch => refused', (gate({ task: taskView({ agentId: 'b' }) }) as { code: string }).code === 'completion-evidence-identity-mismatch');
check('unsafe workspace => refused', (gate({ evidence: evView({ unsafeWorkspace: true }) }) as { code: string }).code === 'completion-workspace-unsafe');
check('workspace changed after proof => refused', (gate({ currentWorkspaceDigest: 'W2' }) as { code: string }).code === 'completion-evidence-stale-workspace');
check('test timeout => refused', (gate({ evidence: evView({ testTimedOut: true }) }) as { code: string }).code === 'completion-test-timeout');
check('test nonzero => refused', (gate({ evidence: evView({ testCode: 3 }) }) as { code: string }).code === 'completion-test-nonzero');
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
    const disabled = mod.evaluateCompletionGate({ contractPresent: true, task: taskView(), evidence: null, currentWorkspaceDigest: 'w' });
    // The REAL gate refuses a missing proof; the DISABLED copy accepts it. A suite that
    // asserted only the disabled behaviour would look green while the gate is off �?the
    // check below is what makes the test detect that regression.
    check('the real gate REFUSES missing evidence', !gate({ evidence: null }).ok);
    check('the disabled copy ACCEPTS missing evidence (bypass detected)', disabled.ok === true);
  } finally {
    try { rmSync(negDir, { recursive: true, force: true }); } catch (e) { cleanupFailures.push(`neg control cleanup: ${(e as Error).message}`); }
  }
  check('the negative-control copy was removed', !existsSync(negFile));
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
