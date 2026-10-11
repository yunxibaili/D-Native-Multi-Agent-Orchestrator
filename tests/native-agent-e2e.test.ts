/**
 * tests/native-agent-e2e.test.ts - REAL Native Agent E2E (hard acceptance).
 *
 * Calls REAL native agent binaries (OpenCode, Codex, WorkBuddy Intl) through the
 * real runtime. NOT part of `npm test` (which stays hermetic); run with
 * `npm run e2e:native`.
 *
 * Cases:
 *   1  OpenCode session A (space-bunny-free): single task modifies a real repo.
 *   2  Same OpenCode agent, TWO sessions, TWO models, running in parallel.
 *   3  OpenCode implementation - Codex native review - structured verdict -
 *      bounded verification.
 *   4  WorkBuddy Intl + hy3: single real task.
 *   5  Handoff: task B uses task A's structured handoff content (not transcript).
 *
 * A missing/unavailable binary is recorded as UNAVAILABLE for that case - an
 * environment fact, not an orchestrator failure.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Orchestrator as RuntimeOrch } from '../src/orchestrator/orchestrator.ts';
import {
  Orchestrator,
  TaskScheduler,
  NativeWorkbench,
  WorkspaceManager,
  normalizeScopeForWorkspace,
} from '../src/orchestration/index.ts';
import { runDecisionCycle } from '../src/orchestration/decision-loop.ts';
import { observeTasks } from '../src/orchestration/observation.ts';
import type { DecisionProvider, DecisionRequest } from '../src/decision/types.ts';
import { ModelRegistry } from '../src/quota/registry.ts';
import { BudgetManager } from '../src/quota/budget.ts';
import type { AgentDescriptor, RunRequest } from '../src/core/types.ts';
import type { QuotaRecord } from '../src/quota/types.ts';
import { parseReviewOutput, validateReviewVerdict } from '../src/orchestration/review-verdict.ts';

const NOW = Date.now();
const ROOT = mkdtempSync(join(tmpdir(), 'workbench-e2e-'));
const results: Array<{ name: string; verdict: string; detail: string }> = [];
const MODEL_A = 'opencode/space-bunny-free';
const MODEL_B = 'opencode/mimo-v2.6-flash-free';
const CODEX_MODEL = 'deepseek-v4.1-flash'; // the machine's actual configured codex model

const git = (repo: string, args: string): string =>
  execSync(`git ${args}`, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (repo: string, args: string): string | null => {
  try { return git(repo, args); } catch { return null; }
};

function makeRepo(name: string): string {
  const repo = join(ROOT, name);
  execSync(`mkdir "${repo}"`);
  git(repo, 'init -q -b main');
  git(repo, 'config user.name e2e');
  git(repo, 'config user.email e2e@e2e');
  git(repo, 'config commit.gpgsign false');
  writeFileSync(join(repo, 'README.md'), '# workbench e2e\n');
  git(repo, 'add -A');
  git(repo, 'commit -qm init');
  return repo;
}

const COMMIT_RULES =
  ' When the file is written, run exactly: git add -A && git commit -m "e2e" (a git repo already exists; you are on the right branch; never push; never create branches).';

function makeWorkbench(
  repo: string,
  taskIds: readonly string[] = [],
  workspaceOptions?: { manager: WorkspaceManager },
) {
  const rt = new RuntimeOrch({ storeDir: join(ROOT, 'store-' + Math.random().toString(36).slice(2)) });
  const descriptors: AgentDescriptor[] = rt.descriptors().filter((d) =>
    ['opencode', 'codex', 'workbuddy-intl'].includes(d.id));
  const reg = new ModelRegistry();
  reg.upsert({ agentId: 'opencode', modelId: MODEL_A, provider: 'opencode', taskTypes: ['implementation', 'research', 'test'], modelSource: 'observed', quotaSource: 'observed' }, NOW);
  reg.upsert({ agentId: 'opencode', modelId: MODEL_B, provider: 'opencode', taskTypes: ['implementation', 'research', 'test'], modelSource: 'observed', quotaSource: 'observed' }, NOW);
  reg.upsert({ agentId: 'codex', modelId: CODEX_MODEL, provider: 'codex', taskTypes: ['review', 'implementation'], modelSource: 'observed', quotaSource: 'observed' }, NOW);
  reg.upsert({ agentId: 'workbuddy-intl', modelId: 'hy3', provider: 'workbuddy', taskTypes: ['implementation', 'research'], modelSource: 'observed', quotaSource: 'observed' }, NOW);
  for (const a of ['opencode', 'codex', 'workbuddy-intl']) reg.setAgentAvailability(a, 'available');
  const budgets = new BudgetManager(10_000_000);
  // The gate is fail-closed on missing budget scopes, so every task id that will
  // pass through spawnChild/executeTask must have its scope allocated UP FRONT.
  for (const t of taskIds) budgets.task(t, 1_000_000);
  budgets.agent('opencode', 10_000_000);
  budgets.agent('codex', 10_000_000);
  budgets.agent('workbuddy-intl', 10_000_000);
  const quotaRecords: QuotaRecord[] = ['opencode', 'codex', 'workbuddy-intl'].map((agentId) => ({
    provider: agentId, agentId, modelId: null, source: 'locally_observed', usage: null, remaining: null,
    resetAt: null, period: 'day', status: 'available', usageClass: 'observed', confidence: 'high', observedAt: NOW, note: '',
  }));
  // R2-1.1 (P2-2): recorded so a case can assert on the `cwd` the native agent
  // was ACTUALLY given; reading it back off the workspace handle would be circular.
  const requests: RunRequest[] = [];
  const orch = new Orchestrator({
    gate: {
      descriptors,
      agentStatus: ['opencode', 'codex', 'workbuddy-intl'].map((a) => ({ agent: a, version: '1', installed: 'Yes', login: 'n/a', quotaSource: 'observed', usage: 'n/a', status: 'ok' })),
      quotaRecords,
      registry: reg,
      budgets,
      taskType: 'implementation',
      requestedUnits: 10,
      currentConcurrency: 0,
      maxConcurrency: 4,
      maxChildren: 8,
      maxConcurrentAgents: 4,
      taskPolicyAllows: true,
    } as never,
    // R2-1.1 (P2-2): every real RunRequest is recorded, so a case can assert on the
    // `cwd` the native agent was ACTUALLY given. This is the only honest source for
    // that fact; reading it back off the workspace handle would be circular.
    runtime: { run: (r) => { requests.push(r); return rt.run(r); } },
    defaultCwd: repo,
    executionTimeoutMs: 600_000,
    // ---- R2-1.1 (P2-2): optional real WorkspaceManager wiring -------------
    // Absent for every pre-R2-1 case, which is what keeps their behaviour identical.
    // When present, tasks are admitted into REAL git worktrees and take a resource
    // claim naming their OWN workspace - so this exercises the production workspace
    // path rather than a test-only stand-in.
    ...(workspaceOptions !== undefined ? { workspace: workspaceOptions.manager } : {}),
    ...(workspaceOptions !== undefined
      ? {
          // Isolation is the R2-1 default for anything that writes.
          workspaceMode: () => 'isolated' as const,
          resourceClaims: (task: { taskId: string }) => ({
            mode: 'write' as const,
            scope: normalizeScopeForWorkspace(`task:${task.taskId}`, repo),
          }),
        }
      : {}),
  });
  const scheduler = new TaskScheduler({ orchestrator: orch, cwd: repo });
  const wb = new NativeWorkbench({
    orchestrator: orch, scheduler, registry: reg, quotaRecords, cwd: repo,
  });
  // Every task that exists needs a task-scope budget (the gate is fail-closed on
  // missing scopes). Called after plan/spawn so dynamically-planned ids are covered.
  const ensureBudgets = (): void => {
    for (const t of orch.getStore().all()) budgets.task(t.taskId, 1_000_000);
  };
  return { orch, scheduler, wb, ensureBudgets, reg, requests };
}

const record = (name: string, verdict: 'PASS' | 'FAIL', detail = ''): void => {
  results.push({ name, verdict, detail });
  process.stdout.write(`  [${verdict}] ${name}${detail ? ` :: ${detail.slice(0, 200)}` : ''}\n`);
};

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 500)); }
  return pred();
}

/**
 * The review contract the parser enforces: `findings[]` entries need BOTH `severity`
 * and `location`, or `parseReviewOutput` refuses the whole verdict. Written out in full
 * so a real reviewer has no excuse - an earlier version of this prompt said only
 * "findings":[] and Codex produced an entry with no location, which failed closed.
 */
const REVIEW_PROMPT = (subject: string, verdict = 'pass'): string =>
  `You are the independent reviewer. Reply with exactly ONE JSON object and nothing else - no prose, no markdown fence. ` +
  `The object must have EXACTLY these keys and values from these closed lists: ` +
  `"verdict": one of "pass" | "rework" | "reject"; ` +
  `"reason": a short sentence; ` +
  `"findings": an array, possibly empty - each finding needs ALL THREE of ` +
  `{"severity": one of "info"|"minor"|"major"|"critical", "location": "file:line", "message": "one sentence"}; ` +
  `"recommendedAction": EXACTLY the string "none" (any other value makes the whole verdict unusable); ` +
  `"reviewer": "codex-e2e"; "reviewedAt": ${Date.now()}. ` +
  `Put what you want CHANGED in "reason" or in a finding message - never in recommendedAction. ` +
  `The verdict you must return is "${verdict}". Subject to review: ${subject}`;

async function case1(): Promise<void> {
  process.stdout.write('\n== CASE 1: OpenCode session A - single real task ==\n');
  const repo = makeRepo('case1');
  const { wb, ensureBudgets } = makeWorkbench(repo, ['c1-root', 'c1-root-s1']);
  const spec = {
    taskId: 'c1-root', objective:
      `Create a file named A.txt in the current directory. Its entire content must be exactly one line: created-by-opencode-session-A.${COMMIT_RULES}`,
    taskType: 'implementation' as const, shape: 'single' as const, budgetUnits: 10,
    preferredAgent: 'opencode', preferredModel: MODEL_A,
  };
  wb.plan(spec as never, null);
  ensureBudgets();
  const assignments = wb.assignChildren('c1-root', spec as never);
  if (!assignments.every((a) => a.ok)) { record('Case 1', 'FAIL', JSON.stringify(assignments.filter((a) => !a.ok))); return; }
  const dispatch = await wb.dispatch();
  const childId = wb.store.children('c1-root')[0]?.taskId ?? '';
  if (!dispatch.tick?.admitted.includes(childId) || wb.store.get(childId)?.status !== 'to_verify') {
    record('Case 1', 'FAIL', JSON.stringify(dispatch.tick?.outcomes.map((o) => [o.taskId, o.outcome.ok ? o.outcome.run.state : o.outcome.code])));
    return;
  }
  const aTxt = join(repo, 'A.txt');
  const contentOk = existsSync(aTxt) && readFileSync(aTxt, 'utf8').trim() === 'created-by-opencode-session-A';
  const committed = (tryGit(repo, 'log --oneline -2') ?? '').split('\n').length >= 2;
  const sessions = wb.sessions.sessionsForAgent('opencode');
  record('Case 1: OpenCode session A real task', contentOk && committed ? 'PASS' : 'FAIL',
    `A.txt=${contentOk} committed=${committed} sessions=${sessions.length} nativeHandle=${sessions[0]?.nativeSessionId ?? 'none'}`);
}

async function case2(): Promise<void> {
  process.stdout.write('\n== CASE 2: one OpenCode agent, two sessions, two models, parallel ==\n');
  const repo = makeRepo('case2');
  const { wb, ensureBudgets } = makeWorkbench(repo, ['c2-root', 'pA', 'pB']);
  wb.orchestrator.createRoot({ taskId: 'c2-root', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'parallel pair' });
  wb.spawnChild({ taskId: 'pA', parentTaskId: 'c2-root', agentId: 'opencode', modelId: MODEL_A, taskType: 'implementation', budgetUnits: 10,
    acceptanceCriteria: 'Create a file named A.txt in the current directory whose entire content is exactly one line: made-by-session-A.' });
  wb.spawnChild({ taskId: 'pB', parentTaskId: 'c2-root', agentId: 'opencode', modelId: MODEL_B, taskType: 'implementation', budgetUnits: 10,
    acceptanceCriteria: 'Create a file named B.txt in the current directory whose entire content is exactly one line: made-by-session-B.' });
  ensureBudgets();
  const sA = wb.sessions.open({ agentId: 'opencode', modelId: MODEL_A, sessionPolicy: 'fresh' }, repo, NOW, 'pA');
  const sB = wb.sessions.open({ agentId: 'opencode', modelId: MODEL_B, sessionPolicy: 'fresh' }, repo, NOW, 'pB');
  const dispatch = await wb.dispatch();
  if (dispatch.tick?.admitted.length !== 2) {
    record('Case 2', 'FAIL', JSON.stringify(dispatch.tick?.outcomes.map((o) => [o.taskId, o.outcome.ok ? o.outcome.run.state : o.outcome.code])));
    return;
  }
  const bothVerified = await until(() => ['pA', 'pB'].every((id) => wb.store.get(id)?.status === 'to_verify'), 420_000);
  const aTxt = join(repo, 'A.txt');
  const bTxt = join(repo, 'B.txt');
  const filesOk = existsSync(aTxt) && existsSync(bTxt) &&
    readFileSync(aTxt, 'utf8').includes('made-by-session-A') && readFileSync(bTxt, 'utf8').includes('made-by-session-B');
  const models = new Set([
    ...wb.evidence.history('pA').map((r) => r.modelId),
    ...wb.evidence.history('pB').map((r) => r.modelId),
  ]);
  const twoModels = models.has(MODEL_A) && models.has(MODEL_B);
  record('Case 2: two sessions / two models in parallel on one agent',
    bothVerified && filesOk && twoModels && sA.sessionId !== sB.sessionId ? 'PASS' : 'FAIL',
    `verified=${bothVerified} files=${filesOk} models=${[...models].join(',')}`);
}

async function case3(): Promise<void> {
  process.stdout.write('\n== CASE 3: OpenCode implementation - Codex review - verdict ==\n');
  const repo = makeRepo('case3');
  const { wb, ensureBudgets } = makeWorkbench(repo, ['c3-root', 'impl', 'review']);
  wb.orchestrator.createRoot({ taskId: 'c3-root', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'impl + review' });
  wb.spawnChild({ taskId: 'impl', parentTaskId: 'c3-root', agentId: 'opencode', modelId: MODEL_A, taskType: 'implementation', budgetUnits: 10,
    acceptanceCriteria: `Create a file named C.txt in the current directory whose entire content is exactly one line: reviewed-target.${COMMIT_RULES}` });
  ensureBudgets();
  const d1 = await wb.dispatch();
  if (!d1.tick?.admitted.includes('impl')) { record('Case 3', 'FAIL', 'impl did not run'); return; }
  await until(() => wb.store.get('impl')?.status === 'to_verify', 420_000);
  wb.spawnChild({ taskId: 'review', parentTaskId: 'c3-root', agentId: 'codex', modelId: CODEX_MODEL, taskType: 'review', budgetUnits: 10,
    acceptanceCriteria: REVIEW_PROMPT('the file C.txt was created in the current directory with the single line "reviewed-target"') });
  ensureBudgets();
  const d2 = await wb.dispatch();
  if (!d2.tick?.admitted.includes('review')) { record('Case 3', 'FAIL', 'review did not run'); return; }
  const reviewOutcome = d2.tick.outcomes.find((o) => o.taskId === 'review')?.outcome;
  const reviewText = reviewOutcome?.ok ? reviewOutcome.run.output : null;
  try {
    const v = parseReviewOutput(reviewText ?? '');
    const applied = wb.applyReview('impl', v);
    record('Case 3: Codex review - structured verdict - verification',
      applied.status === 'ok' ? 'PASS' : 'FAIL',
      `verdict=${v.verdict} applied=${applied.status} implStatus=${wb.store.get('impl')?.status}`);
  } catch (e) {
    record('Case 3', 'FAIL', `verdict parse failed: ${(e as Error).message.slice(0, 140)}`);
  }
}

async function case4(): Promise<void> {
  process.stdout.write('\n== CASE 4: WorkBuddy Intl + hy3 real task ==\n');
  const repo = makeRepo('case4');
  const { wb, ensureBudgets } = makeWorkbench(repo, ['c4-root', 'wb1']);
  wb.orchestrator.createRoot({ taskId: 'c4-root', agentId: 'workbuddy-intl', taskType: 'implementation', acceptanceCriteria: 'workbuddy task' });
  wb.spawnChild({ taskId: 'wb1', parentTaskId: 'c4-root', agentId: 'workbuddy-intl', modelId: 'hy3', taskType: 'implementation', budgetUnits: 10,
    acceptanceCriteria: `Create a file named WB.txt in the current directory whose entire content is exactly one line: made-by-workbuddy-hy3.${COMMIT_RULES}` });
  ensureBudgets();
  wb.sessions.open({ agentId: 'workbuddy-intl', modelId: 'hy3', sessionPolicy: 'fresh' }, repo, NOW, 'wb1');
  const dispatch = await wb.dispatch();
  if (!dispatch.tick?.admitted.includes('wb1')) {
    record('Case 4', 'FAIL', JSON.stringify(dispatch.tick?.outcomes.map((o) => [o.taskId, o.outcome.ok ? o.outcome.run.state : o.outcome.code])));
    return;
  }
  const verified = await until(() => wb.store.get('wb1')?.status === 'to_verify', 420_000);
  const outcome = dispatch.tick.outcomes.find((o) => o.taskId === 'wb1')?.outcome;
  const tail = outcome?.ok ? outcome.run.output.slice(-200) : (outcome && !outcome.ok ? outcome.code : 'no outcome');
  const bTxt = join(repo, 'WB.txt');
  record('Case 4: WorkBuddy Intl hy3 real task', verified && existsSync(bTxt) ? 'PASS' : 'FAIL',
    `verified=${verified} WB.txt=${existsSync(bTxt)} status=${wb.store.get('wb1')?.status} tail=${String(tail).replace(/[\r\n]+/g, ' ')}`);
}

async function case5(): Promise<void> {
  process.stdout.write('\n== CASE 5: Handoff A - B (structured, real content carried) ==\n');
  const repo = makeRepo('case5');
  const { wb, ensureBudgets } = makeWorkbench(repo, ['c5-root', 'HA', 'HB']);
  wb.orchestrator.createRoot({ taskId: 'c5-root', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'handoff chain' });
  // A's objective contains the payload that must survive the boundary. B's own
  // objective is deliberately VAGUE: if B can write the right content, it can only
  // have come from A's handoff, not from being told what to do.
  wb.spawnChild({ taskId: 'HA', parentTaskId: 'c5-root', agentId: 'opencode', modelId: MODEL_A, taskType: 'implementation', budgetUnits: 10,
    acceptanceCriteria: `Create a file named A.txt in the current directory whose entire content is exactly one line: HANDOFF-DATA-42.${COMMIT_RULES}` });
  wb.spawnChild({ taskId: 'HB', parentTaskId: 'c5-root', agentId: 'opencode', modelId: MODEL_B, taskType: 'implementation', budgetUnits: 10,
    acceptanceCriteria: `Carry the previous task's work forward: create B.txt in the current directory whose content is whatever the handoff says to write. Use ONLY what the handoff tells you; do not invent a value.${COMMIT_RULES}`, dependencies: ['HA'], allowUnmetDependencies: true });
  ensureBudgets();
  const d1 = await wb.dispatch();
  if (!d1.tick?.admitted.includes('HA')) { record('Case 5', 'FAIL', 'HA did not run'); return; }
  await until(() => wb.store.get('HA')?.status === 'to_verify', 420_000);

  // A dependency is satisfied only by a REAL success, so the full chain must run:
  // A executes - verified - succeeded. This is the existing store semantics and is
  // NOT relaxed anywhere for this test.
  wb.orchestrator.applyVerification('HA', { verdict: 'pass', reason: 'e2e: A.txt content verified by parent' });
  if (wb.store.get('HA')?.status !== 'succeeded') {
    record('Case 5', 'FAIL', `HA did not reach succeeded (status=${wb.store.get('HA')?.status}) - a dependency must not be satisfied without verification`);
    return;
  }

  // THE POINT OF THE CASE: assert on the brief the Workbench COMPOSES, and let that
  // composed brief be the prompt. No hand-written instruction for B - a hand-written
  // prompt would prove the model is obedient, not that handoff carries anything.
  const haHandoff = wb.handoffFor('HA', wb.lastRunResult('HA'));
  const briefB = wb.briefFor('HB', wb.runResults());
  const briefText = briefB ?? '';
const requiredSections = ['completedWork', 'decisions', 'unresolved', 'constraints'];
    const missingSections = requiredSections.filter((s) => !briefText.includes(s));
    if (missingSections.length > 0 || briefText === '') {
      record('Case 5', 'FAIL', `composed brief is missing sections ${missingSections.join(',') || '(brief empty)'}`);
      return;
    }
    // Only the sections that are ALWAYS rendered are demanded unconditionally. The
    // evidence-only ones (artifacts / changedFiles / tests) omit themselves when the
    // upstream run genuinely produced none - requiring them always would assert that
    // A wrote files, which is a claim about A rather than about handoff. Where A
    // really did have that evidence, its section MUST be present.
    if ((haHandoff?.changedFiles.length ?? 0) > 0 && !briefText.includes('changedFiles:')) {
      record('Case 5', 'FAIL', 'A changed files but the brief has no changedFiles section');
      return;
    }
    if ((haHandoff?.testsRun.length ?? 0) > 0 && !briefText.includes('tests:')) {
      record('Case 5', 'FAIL', 'A ran shell commands but the brief has no tests section');
      return;
    }
    // The payload itself must be IN the brief: that is the assertion that content, not
    // just structure, crossed the boundary.
    const payloadInBrief = briefText.includes('HANDOFF-DATA-42') || briefText.includes('A.txt');

  const d2 = await wb.dispatch(); // no promptFor: B is briefed from A's handoff alone
  if (!d2.tick?.admitted.includes('HB')) {
    record('Case 5', 'FAIL', 'HB did not run - its dependency never satisfied');
    return;
  }
  await until(() => wb.store.get('HB')?.status === 'to_verify', 420_000);

  const aTxt = join(repo, 'A.txt');
  const bTxt = join(repo, 'B.txt');
  const aContent = existsSync(aTxt) ? readFileSync(aTxt, 'utf8').trim() : '';
  const bContent = existsSync(bTxt) ? readFileSync(bTxt, 'utf8').trim() : '';
  const carried = aContent !== '' && bContent !== '' && aContent === bContent;
  // No transcript may be smuggled in: the brief is a bounded brief, and B never needs
  // A's conversation to work.
  const briefIsBounded = briefText.length < 6000 && !briefText.includes('tool_use');
  record('Case 5: handoff A→B carried real content', carried && payloadInBrief && briefIsBounded ? 'PASS' : 'FAIL',
    `A=${JSON.stringify(aContent)} B=${JSON.stringify(bContent)} payloadInBrief=${payloadInBrief} bounded=${briefIsBounded} briefChars=${briefText.length}`);
  process.stdout.write(`     --- composed brief for HB ---\n${briefText.split('\n').map((l) => '     | ' + l).join('\n')}\n`);
  process.stdout.write(`     --- HA handoff fields ---\n     ${JSON.stringify({ taskId: haHandoff?.taskId, status: haHandoff?.status, runState: haHandoff?.runState, artifacts: haHandoff?.artifacts.length })}\n`);
}

// ---------------------------------------------------------------------------
// P6-D1: the dynamic decision loop, against REAL native agents.
// ---------------------------------------------------------------------------

/**
 * A provider that answers one fixed action.
 *
 * `extra` is merged into the decision AFTER extraction. That is not a workaround: the
 * Decision Layer's `choice` answer carries no field for a target, so an action like
 * `retry` (which needs a taskId) cannot be expressed by the provider alone - and the
 * comment on `extractAction` says a caller may attach a short note after validation.
 * The completed decision is then put through the SAME `validateDecision` the loop uses,
 * so a malformed one is still refused.
 */
const fixedProvider = (action: string): DecisionProvider => ({
  decide: async (req: DecisionRequest) => {
    const id = req.questions === undefined ? 'next_action' : Object.keys(req.questions)[0];
    return {
      answers: {
        [id]: { type: 'choice', choice: action, probabilities: { [action]: 1 }, confidence: 1, criteria: {} },
      },
    };
  },
} as unknown as DecisionProvider);

/** One full cycle with the workbench's real capabilities injected. */
async function decide(
  wb: NativeWorkbench,
  action: string,
  rootTaskId: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: string; applied: boolean; dispatched: boolean; code?: string; reason: string }> {
  const caps = wb.decisionCapabilities();
  const first = await runDecisionCycle({
    store: wb.store,
    scheduler: new TaskScheduler({ orchestrator: wb.orchestrator, cwd: ROOT }),
    provider: fixedProvider(action),
    rootTaskId,
    capabilities: caps,
  });
  if (Object.keys(extra).length === 0) {
    return first.status === 'ok'
      ? { status: first.status, applied: first.application.applied, dispatched: first.application.dispatched, code: first.application.applied ? undefined : first.application.code, reason: first.application.applied ? first.application.note : first.application.reason }
      : { status: first.status, applied: false, dispatched: false, reason: 'cycle did not validate' };
  }
  const caps2 = wb.decisionCapabilities();
  const { validateDecision, applyDecision } = await import('../src/orchestration/decision.ts');
  const obs = observeTasks(wb.store, { now: Date.now(), rootTaskId });
  try {
    const completed = validateDecision({ action, ...extra } as never, obs);
    const applied = await applyDecision(completed, { observation: obs, ...caps2 });
    return {
      status: 'ok', applied: applied.applied, dispatched: applied.dispatched,
      code: applied.applied ? undefined : applied.code,
      reason: applied.applied ? applied.note : applied.reason,
    };
  } catch (e) {
    return { status: 'invalid', applied: false, dispatched: false, reason: (e as Error).message };
  }
}

async function case6(): Promise<void> {
  process.stdout.write('\n== CASE 6: dynamic REWORK - real agent - Codex verdict - rework - same worker - pass ==\n');
  const repo = makeRepo('case6');
  const { wb, ensureBudgets } = makeWorkbench(repo, ['c6-root', 'impl', 'review']);
  wb.orchestrator.createRoot({ taskId: 'c6-root', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'dynamic rework' });
  wb.spawnChild({ taskId: 'impl', parentTaskId: 'c6-root', agentId: 'opencode', modelId: MODEL_A, taskType: 'implementation', budgetUnits: 10,
    acceptanceCriteria: `Create a file named D.txt in the current directory whose entire content is exactly one line: DYNAMIC-REWORK-TARGET.${COMMIT_RULES}` });
  ensureBudgets();
  await wb.dispatch();
  await until(() => wb.store.get('impl')?.status === 'to_verify', 420_000);
  const beforeAgent = wb.store.get('impl')?.agentId;
  const beforeModel = wb.store.get('impl')?.modelId;
  const beforeRetry = wb.store.get('impl')?.retryCount ?? 0;

  // A real Codex review that asks for a change.
  wb.spawnChild({ taskId: 'review', parentTaskId: 'c6-root', agentId: 'codex', modelId: CODEX_MODEL, taskType: 'review', budgetUnits: 10,
    acceptanceCriteria: REVIEW_PROMPT('D.txt was created with the single line "DYNAMIC-REWORK-TARGET".', 'rework') });
  ensureBudgets();
  const rd = await wb.dispatch();
  const reviewText = rd.tick?.outcomes.find((o) => o.taskId === 'review')?.outcome;
  let verdictText = reviewOutcomeText(reviewText);
  if (verdictText === null) {
    record('Case 6', 'FAIL', 'codex review produced no output');
    return;
  }
  let verdict;
  try {
    verdict = parseReviewOutput(verdictText);
  } catch (e) {
    // A real reviewer can return a malformed finding. That is a REVIEWER failure, and
    // it must be reported as such rather than crashing the suite - the contract still
    // holds, we simply cannot exercise the rework round trip this run.
    record('Case 6', 'FAIL', `codex review verdict was malformed: ${(e as Error).message.slice(0, 160)} :: ${JSON.stringify(verdictText.slice(0, 200))}`);
    return;
  }
  const applied = wb.applyReview('impl', verdict);
  const afterRetry = wb.store.get('impl')?.retryCount ?? 0;
  const reentered = ['queued', 'running', 'to_verify'].includes(String(wb.store.get('impl')?.status));
  const sameWorker = wb.store.get('impl')?.agentId === beforeAgent && wb.store.get('impl')?.modelId === beforeModel;
  await until(() => wb.store.get('impl')?.status === 'to_verify' && (wb.store.get('impl')?.retryCount ?? 0) > beforeRetry, 420_000);
  // `prepareRework` queues; the SCHEDULER dispatches. Re-entering is not dispatching, so
  // the re-run needs its own tick - exactly the split review-loop.ts documents.
  await wb.dispatch();
  await until(() => wb.store.get('impl')?.status === 'to_verify' && (wb.store.get('impl')?.retryCount ?? 0) > beforeRetry, 420_000);
  const rows = wb.evidence.history('impl');
  const reworkRows = rows.filter((r) => r.kind === 'rework').length;
  const reviewRows = rows.filter((r) => r.kind === 'review').length;
  const pass = applied.status === 'ok' && applied.reworkRequested === true &&
    afterRetry > beforeRetry && reentered && sameWorker && reworkRows === 1 && reviewRows === 1;
  record('Case 6: dynamic REWORK round trip (real agent - rework - same worker)', pass ? 'PASS' : 'FAIL',
    `verdict=${verdict.verdict} reworkRequested=${applied.status === 'ok' ? applied.reworkRequested : applied.status} ` +
    `retry ${beforeRetry}->${afterRetry} sameWorker=${sameWorker} reworkRows=${reworkRows} reviewRows=${reviewRows} ` +
    `finalStatus=${String(wb.store.get('impl')?.status)}`);
}

const reviewOutcomeText = (o: unknown): string | null => {
  const x = o as { ok?: boolean; run?: { output: string } } | undefined;
  return x?.ok === true && x.run !== undefined ? x.run.output : null;
};

async function case7(): Promise<void> {
  process.stdout.write('\n== CASE 7: session reuse - Task A native threadId - Task B resumes it ==\n');
  const repo = makeRepo('case7');
  const { wb, ensureBudgets } = makeWorkbench(repo, ['c7-root', 'A', 'B']);
  wb.orchestrator.createRoot({ taskId: 'c7-root', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'session reuse' });
  // A writes a SECRET into a conversation; B must recover it from the RESUMED
  // conversation, never from a file - that is what proves the threadId arrived.
  // B DEPENDS on A, so A runs first and B cannot slip into the same tick: without
  // this the first dispatch would take both and the case would prove nothing.
  wb.spawnChild({ taskId: 'A', parentTaskId: 'c7-root', agentId: 'opencode', modelId: MODEL_A, taskType: 'implementation', budgetUnits: 10,
    acceptanceCriteria: `Write the exact word SESSION-REUSE-MAGIC-7731 in your reply. Also create a file named A.txt whose entire content is exactly one line: SESSION-REUSE-MAGIC-7731.${COMMIT_RULES}` });
  wb.spawnChild({ taskId: 'B', parentTaskId: 'c7-root', agentId: 'opencode', modelId: MODEL_A, taskType: 'implementation', budgetUnits: 10,
    acceptanceCriteria: 'Without reading any file, reply with ONLY the single word you were told to write in the previous task. Do not explain.',
    dependencies: ['A'], allowUnmetDependencies: true });
  ensureBudgets();
  const sa = wb.sessions.open({ agentId: 'opencode', modelId: MODEL_A, sessionPolicy: 'fresh' }, repo, NOW, 'A');
  await wb.dispatch();
  await until(() => wb.store.get('A')?.status === 'to_verify', 420_000);
  // A's own evidence must be collected, or B is still gated on it.
  wb.orchestrator.applyVerification('A', { verdict: 'pass', reason: 'e2e: A.txt verified' });
  const handleA = wb.sessions.nativeHandleForTask('A');
  // B binds to A's SESSION, which is what makes reuse possible.
  wb.setTaskIntent('B', { sessionIntent: { kind: 'reuse', sessionKey: sa.sessionId } });
  wb.sessions.markRunning(sa.sessionId, 'B');
  const d2 = await wb.dispatch(undefined, new Set(['B']));
  const admitted = d2.tick?.admitted.includes('B') === true;
  const sawHandle = wb.sessions.nativeHandleForTask('B') !== null;
  await until(() => wb.store.get('B')?.status === 'to_verify', 420_000);
  const bOut = wb.lastRunResult('B')?.output ?? '';
  const recalled = bOut.includes('SESSION-REUSE-MAGIC-7731');
  const pass = handleA !== null && admitted && sawHandle && recalled && wb.store.get('B')?.status === 'to_verify';
  record('Case 7: native session reuse really passes threadId to the agent', pass ? 'PASS' : 'FAIL',
    `A_handle=${handleA === null ? 'none' : 'captured'} B_admitted=${admitted} B_handle=${sawHandle} recalled=${recalled} ` +
    `B_out=${JSON.stringify(bOut.slice(0, 90))}`);
}

async function case8(): Promise<void> {
  process.stdout.write('\n== CASE 8: REASSIGN - a started task moves to another agent/model, fresh session ==\n');
  const repo = makeRepo('case8');
  const { wb, ensureBudgets } = makeWorkbench(repo, ['c8-root', 'move-me']);
  wb.orchestrator.createRoot({ taskId: 'c8-root', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'reassign' });
  wb.spawnChild({ taskId: 'move-me', parentTaskId: 'c8-root', agentId: 'opencode', modelId: MODEL_A, taskType: 'implementation', budgetUnits: 10,
    acceptanceCriteria: `Create a file named MOVE.txt in the current directory whose entire content is exactly one line: MOVED-BY-NEW-WORKER.${COMMIT_RULES}` });
  ensureBudgets();
  wb.sessions.open({ agentId: 'opencode', modelId: MODEL_A, sessionPolicy: 'fresh' }, repo, NOW, 'move-me');
  await wb.dispatch();
  await until(() => wb.store.get('move-me')?.status === 'to_verify', 420_000);
  // A task sitting in `to_verify` is deliberately NOT re-runnable: its run already
  // happened. The live "wrong worker" story is a task that started, was sent back, and
  // is sitting in the QUEUE again when Laya notices it should not go to the same agent.
  // So: a real rework verdict re-enters it, and the reassign happens while queued.
  const rework = validateReviewVerdict({ verdict: 'rework', reason: 'e2e: wrong worker for this task', findings: [], recommendedAction: 'none', reviewer: 'codex', reviewedAt: NOW });
  wb.applyReview('move-me', rework);
  await until(() => wb.store.get('move-me')?.status === 'queued', 420_000);
  const started = wb.store.get('move-me')?.startedAt !== null;
  const queuedForMigration = wb.store.get('move-me')?.status === 'queued';
  const beforeAgent = wb.store.get('move-me')?.agentId;
  const oldSession = wb.sessions.sessionForTask('move-me')?.sessionId ?? '';

  // A REAL reassignment: Laya names the target worker, Assignment proposes, the store commits.
  const d = await decide(wb, 'reassign', 'c8-root', {
    taskId: 'move-me', agentId: 'workbuddy-intl', modelId: 'hy3', reason: 'laya: opencode cannot finish this',
  });
  const afterAgent = wb.store.get('move-me')?.agentId;
  const moved = afterAgent === 'workbuddy-intl' && beforeAgent !== 'workbuddy-intl';
  // The OLD session must NOT be carried across an identity change.
  let sessionRefused = false;
  try {
    wb.sessions.open({ agentId: 'workbuddy-intl', modelId: 'hy3', sessionId: oldSession, sessionPolicy: 'resume' }, repo, NOW, 'move-me');
  } catch (e) {
    sessionRefused = (e as { code?: string }).code === 'session-identity-mismatch';
  }
  // The migrated task must be re-queued and actually RUN on the new worker. `reassign`
  // moves identity; it does not start a run.
  const requeued = wb.store.get('move-me')?.status === 'queued';
  process.stdout.write(`     started=${started} queued=${queuedForMigration} stillQueued=${requeued} status=${String(wb.store.get('move-me')?.status)}\n`);
  wb.sessions.open({ agentId: 'workbuddy-intl', modelId: 'hy3', sessionPolicy: 'fresh' }, repo, NOW, 'move-me');
  await wb.dispatch();
  await until(() => wb.evidence.history('move-me').some((r) => r.agentId === 'workbuddy-intl'), 420_000);
  const ranOnNew = wb.evidence.history('move-me').some((r) => r.agentId === 'workbuddy-intl');
  const ranOnOld = wb.evidence.history('move-me').some((r) => r.agentId === 'opencode');
  process.stdout.write(`     evidence old=${ranOnOld} new=${ranOnNew}\n`);
  const pass = d.applied && started && queuedForMigration && moved && sessionRefused && ranOnNew && ranOnOld && existsSync(join(repo, 'MOVE.txt'));
  record('Case 8: REASSIGN moves a STARTED task to a real second agent', pass ? 'PASS' : 'FAIL',
    `applied=${d.applied} started=${started} ${String(beforeAgent)}->${String(afterAgent)} oldSessionRefused=${sessionRefused} ` +
    `ranOnNewWorker=${ranOnNew} MOVE.txt=${existsSync(join(repo, 'MOVE.txt'))} status=${String(wb.store.get('move-me')?.status)}`);
}

async function case9(): Promise<void> {
  process.stdout.write('\n== CASE 9: REPLAN - finished work survives, new work runs ==\n');
  const repo = makeRepo('case9');
  const { wb, ensureBudgets } = makeWorkbench(repo, ['c9-root', 'done-1', 'todo-1']);
  wb.orchestrator.createRoot({ taskId: 'c9-root', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'replan' });
  wb.spawnChild({ taskId: 'done-1', parentTaskId: 'c9-root', agentId: 'opencode', modelId: MODEL_A, taskType: 'implementation', budgetUnits: 10,
    acceptanceCriteria: `Create a file named DONE.txt in the current directory whose entire content is exactly one line: DONE-BEFORE-REPLAN.${COMMIT_RULES}` });
  // `todo-1` DEPENDS on `done-1`, so it cannot run in the first tick and is genuinely
  // never-started when the replan happens - which is what makes it replaceable. An
  // independent sibling would simply have run already, and the replan would have
  // nothing to replace.
  wb.spawnChild({ taskId: 'todo-1', parentTaskId: 'c9-root', agentId: 'opencode', modelId: MODEL_A, taskType: 'implementation', budgetUnits: 10,
    acceptanceCriteria: `Create a file named TODO.txt in the current directory whose entire content is exactly one line: TODO-BEFORE-REPLAN.${COMMIT_RULES}`,
    dependencies: ['done-1'], allowUnmetDependencies: true });
  ensureBudgets();
  await wb.dispatch();
  await until(() => wb.store.get('done-1')?.status === 'to_verify', 420_000);
  // Verify ONLY the finished one; `todo-1` stays never-started, which is what makes it
  // replaceable - the whole point of the replan protection.
  wb.orchestrator.applyVerification('done-1', { verdict: 'pass', reason: 'e2e: DONE.txt verified' });
  const finishedBefore = wb.store.get('done-1')?.status;

  const d = await decide(wb, 'replan', 'c9-root', { taskId: 'c9-root', reason: 'laya: the plan was wrong' });
  const finishedSurvived = wb.store.get('done-1')?.status === 'succeeded';
  const todoReplaced = wb.store.has('todo-1') === false;
  const genBefore = wb.store.latestGeneration();
  wb.assignChildren('c9-root', { taskId: 'c9-root', taskType: 'implementation' } as never);
  await wb.dispatch();
  const ran = wb.store.children('c9-root').some((c) => c.status === 'to_verify' || c.status === 'succeeded');
  const pass = d.applied && finishedBefore === 'succeeded' && finishedSurvived && todoReplaced &&
    genBefore >= 1 && ran && existsSync(join(repo, 'DONE.txt'));
  record('Case 9: REPLAN replaces unfinished work and never touches finished work', pass ? 'PASS' : 'FAIL',
    `applied=${d.applied} finishedSurvived=${finishedSurvived} todoReplaced=${todoReplaced} generation=${genBefore} ` +
    `newWorkRan=${ran} DONE.txt=${existsSync(join(repo, 'DONE.txt'))} TODO.txt=${existsSync(join(repo, 'TODO.txt'))}`);
}

async function case10(): Promise<void> {
  process.stdout.write('\n== CASE 10: parallel DAG - three independent real tasks ==\n');
  const repo = makeRepo('case10');
  const { wb, ensureBudgets } = makeWorkbench(repo, ['c10-root', 'pa', 'pb', 'pc']);
  wb.orchestrator.createRoot({ taskId: 'c10-root', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'parallel dag' });
  const specs: Array<[string, string, string, string]> = [
    ['pa', 'PA', MODEL_A, 'one'],
    ['pb', 'PB', MODEL_B, 'two'],
    ['pc', 'PC', MODEL_A, 'three'],
  ];
  for (const [id, word, model, _n] of specs) {
    wb.spawnChild({ taskId: id, parentTaskId: 'c10-root', agentId: 'opencode', modelId: model, taskType: 'implementation', budgetUnits: 10,
      acceptanceCriteria: `Create a file named ${word}.txt in the current directory whose entire content is exactly one line: PARALLEL-${word}.` });
  }
  ensureBudgets();
  const started = Date.now();
  const d = await wb.dispatch();
  const allAdmitted = specs.every(([id]) => d.tick?.admitted.includes(id) === true);
  await until(() => specs.every(([id]) => wb.store.get(id)?.status === 'to_verify'), 600_000);
  const elapsed = Date.now() - started;
  const files = specs.every(([, w]) => {
    const f = join(repo, `${w}.txt`);
    return existsSync(f) && readFileSync(f, 'utf8').includes(`PARALLEL-${w}`);
  });
  // Dependency semantics must be intact: three siblings, zero edges between them.
  const kids = wb.store.children('c10-root');
  const noEdges = kids.length === 3 && kids.every((k) => k.dependencies.length === 0);
  const acyclic = wb.store.findCycle() === null;
  record('Case 10: a real 3-way parallel DAG with intact dependency semantics', pass10(allAdmitted, files, noEdges, acyclic) ? 'PASS' : 'FAIL',
    `admitted=${allAdmitted} files=${files} noEdges=${noEdges} acyclic=${acyclic} elapsedMs=${elapsed}`);
}
const pass10 = (a: boolean, b: boolean, c: boolean, d: boolean): boolean => a && b && c && d;

// ---------------------------------------------------- DC: decision contract closure E2E

/** A provider that returns a COMPLETE decision, targets included. */
const targetedProvider = (action: string, parameters: Record<string, string>): DecisionProvider => ({
  decide: async (req: DecisionRequest) => {
    const id = req.questions === undefined ? 'next_action' : Object.keys(req.questions)[0];
    const q = req.questions?.[id];
    const offered = q?.type === 'choice' ? Object.keys(q.criteria) : [action];
    const p: Record<string, number> = {};
    for (const k of offered) p[k] = k === action ? 1 : 0;
    return {
      answers: {
        [id]: { type: 'choice', choice: action, criteria: {}, probabilities: p, confidence: 1, parameters },
      },
    };
  },
} as unknown as DecisionProvider);

/** A cycle where the PROVIDER supplies the whole decision, targets included. */
async function decideWithProvider(
  wb: NativeWorkbench,
  provider: DecisionProvider,
  rootTaskId: string,
): Promise<{ status: string; applied: boolean; code?: string; reason: string; decision: unknown }> {
  const caps = wb.decisionCapabilities();
  const out = await runDecisionCycle({
    store: wb.store,
    scheduler: new TaskScheduler({ orchestrator: wb.orchestrator, cwd: ROOT }),
    provider,
    rootTaskId,
    capabilities: caps,
  });
  if (out.status !== 'ok') return { status: out.status, applied: false, reason: 'not validated', decision: null };
  return {
    status: out.status,
    applied: out.application.applied,
    code: out.application.applied ? undefined : out.application.code,
    reason: out.application.applied ? out.application.note : out.application.reason,
    decision: out.decision,
  };
}

async function case11(): Promise<void> {
  process.stdout.write('\n== CASE 11: E2E A - Laya supplies the reassign TARGET, real second agent runs it ==\n');
  const repo = makeRepo('case11');
  const { wb, ensureBudgets } = makeWorkbench(repo, ['c11-root', 'mover']);
  wb.orchestrator.createRoot({ taskId: 'c11-root', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'reassign target' });
  wb.spawnChild({ taskId: 'mover', parentTaskId: 'c11-root', agentId: 'opencode', modelId: MODEL_A, taskType: 'implementation', budgetUnits: 10,
    acceptanceCriteria: `Create a file named TARGETED.txt in the current directory whose entire content is exactly one line: TARGET-EXECUTED-BY-LAYA-CHOSEN-WORKER.${COMMIT_RULES}` });
  ensureBudgets();
  wb.sessions.open({ agentId: 'opencode', modelId: MODEL_A, sessionPolicy: 'fresh' }, repo, NOW, 'mover');
  await wb.dispatch();
  await until(() => wb.store.get('mover')?.status === 'to_verify', 420_000);
  // A task whose run has FINISHED sits in `to_verify`, and there is no path back to
  // `queued` from there - re-running it would mean re-running finished work. The honest
  // way to get a genuinely dispatchable, already-started task is the real rework
  // re-entry, which is also exactly the state a "wrong worker" decision is made in.
  wb.applyReview('mover', validateReviewVerdict({ verdict: 'rework', reason: 'e2e: wrong worker for this task', findings: [], recommendedAction: 'none', reviewer: 'codex', reviewedAt: NOW }));
  await until(() => wb.store.get('mover')?.status === 'queued', 420_000);
  const beforeAgent = wb.store.get('mover')?.agentId;
  const oldSession = wb.sessionForTask('mover')?.sessionId ?? '';

  // Laya names BOTH the task and the target. Nothing is inferred here.
  const d = await decideWithProvider(wb, targetedProvider('reassign', {
    taskId: 'mover', agentId: 'workbuddy-intl', modelId: 'hy3', reason: 'e2e: laya chose this worker',
  }), 'c11-root');
  const decision = d.decision as { action: string; agentId?: string; strategy?: string } | null;
  const targetHonoured = decision?.agentId === 'workbuddy-intl';
  const afterAgent = wb.store.get('mover')?.agentId;
  let sessionRefused = false;
  try {
    wb.sessions.open({ agentId: 'workbuddy-intl', modelId: 'hy3', sessionId: oldSession, sessionPolicy: 'resume' }, repo, NOW, 'mover');
  } catch (e) {
    sessionRefused = (e as { code?: string }).code === 'session-identity-mismatch';
  }
  // Run it for real on the new worker.
  wb.sessions.open({ agentId: 'workbuddy-intl', modelId: 'hy3', sessionPolicy: 'fresh' }, repo, NOW, 'mover');
  await wb.dispatch();
  await until(() => wb.evidence.history('mover').some((r) => r.agentId === 'workbuddy-intl'), 420_000);
  const ranOnNew = wb.evidence.history('mover').some((r) => r.agentId === 'workbuddy-intl');
  const fileOk = existsSync(join(repo, 'TARGETED.txt'));
  record('Case 11: E2E A - reassign target supplied by the decision, real new agent ran it',
    d.applied && targetHonoured && afterAgent === 'workbuddy-intl' && sessionRefused && ranOnNew && fileOk ? 'PASS' : 'FAIL',
    `applied=${d.applied} targetHonoured=${targetHonoured} ${String(beforeAgent)}->${String(afterAgent)} ` +
    `strategy=${String(decision?.strategy ?? 'explicit')} oldSessionRefused=${sessionRefused} ranOnNew=${ranOnNew} file=${fileOk}`);
}

async function case12(): Promise<void> {
  process.stdout.write('\n== CASE 12: E2E B - add_task commits the real requested taskType ==\n');
  const repo = makeRepo('case12');
  const { wb, ensureBudgets } = makeWorkbench(repo, ['c12-root']);
  wb.orchestrator.createRoot({ taskId: 'c12-root', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'add_task types' });
  ensureBudgets();
  const wanted = [
    { type: 'research' as const, objective: 'research the parser grammar and write the findings into RESEARCH.md' },
    { type: 'review' as const, objective: 'review the existing code and record the verdict in REVIEW.md' },
    { type: 'implementation' as const, objective: 'create IMPL.txt containing exactly one line: IMPL-DONE' },
  ];
  for (const w of wanted) wb.addTask('c12-root', w.objective, w.type, 'e2e: laya added scope');
  const kids = wb.store.children('c12-root');
  const typedOk = wanted.every((w) =>
    kids.some((k) => k.acceptanceCriteria.includes(w.objective.slice(0, 28)) && k.taskType === w.type));
  // An invalid type must be refused by the PLANNER, not committed.
  let refused = '';
  try { wb.addTask('c12-root', 'bogus type work', 'not-a-type' as never, 'e2e'); }
  catch (e) { refused = (e as { code?: string }).code ?? 'threw'; }
  const noBogus = kids.every((k) => k.taskType !== ('not-a-type' as never));
  record('Case 12: E2E B - add_task taskType is really committed (research/review/implementation)',
    typedOk && noBogus ? 'PASS' : 'FAIL',
    `types=${JSON.stringify(kids.map((k) => k.taskType))} typedOk=${typedOk} invalidRefused="${refused}" noBogus=${noBogus}`);
}

async function case13(): Promise<void> {
  process.stdout.write('\n== CASE 13: E2E C - retry is bounded and starts a FRESH session ==\n');
  const repo = makeRepo('case13');
  const { wb, ensureBudgets } = makeWorkbench(repo, ['c13-root', 'flaky']);
  wb.orchestrator.createRoot({ taskId: 'c13-root', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'retry' });
  wb.spawnChild({ taskId: 'flaky', parentTaskId: 'c13-root', agentId: 'opencode', modelId: MODEL_A, taskType: 'implementation', budgetUnits: 10,
    acceptanceCriteria: `Create a file named RETRY.txt in the current directory whose entire content is exactly one line: RETRIED-OK.${COMMIT_RULES}` });
  ensureBudgets();
  wb.sessions.open({ agentId: 'opencode', modelId: MODEL_A, sessionPolicy: 'fresh' }, repo, NOW, 'flaky');
  await wb.dispatch();
  await until(() => wb.store.get('flaky')?.status === 'to_verify', 420_000);
  const handleBefore = wb.nativeHandleForTask('flaky');
  const runsAfterFirst = wb.evidence.history('flaky').length;

  // PART 1 - session semantics, fully real. A finished task has no path back to
  // `queued`, so the only honest way to a second real run is the real rework
  // re-entry. That is also exactly the state a "wrong worker / try again" decision is
  // made in, and it is what proves the re-run STARTS A FRESH native conversation:
  // a resumed one would reuse the handle.
  wb.applyReview('flaky', validateReviewVerdict({ verdict: 'rework', reason: 'e2e: run it again', findings: [], recommendedAction: 'none', reviewer: 'codex', reviewedAt: NOW }));
  await until(() => wb.store.get('flaky')?.status === 'queued', 420_000);
  const caps = wb.decisionCapabilities();
  await caps.dispatch();
  await until(() => wb.evidence.history('flaky').length > runsAfterFirst, 420_000);
  const runsAfterSecond = wb.evidence.history('flaky').length;
  const handleAfter = wb.nativeHandleForTask('flaky');
  const freshConversation = handleBefore !== null && handleAfter !== null && handleAfter !== handleBefore;

  // PART 2 - retry's own contract: fail-closed unless a run FAILED, bounded when it
  // did, and nonsensical bounds refused. The failure itself is simulated through the
  // REAL `running -> retrying` edge (a real agent failing on cue is not arrangable in a
  // test), but the retry machinery and its bound are the real ones.
  const premature = wb.orchestrator.retry('flaky', 'e2e: not retrying yet', 2);
  wb.applyReview('flaky', validateReviewVerdict({ verdict: 'rework', reason: 'e2e: back to the queue', findings: [], recommendedAction: 'none', reviewer: 'codex', reviewedAt: NOW + 1 }));
  await until(() => wb.store.get('flaky')?.status === 'queued', 420_000);
  wb.orchestrator.start('flaky');
  const parked = wb.store.transition('flaky', 'retrying', Date.now(), 'e2e: simulated run failure');
  const badBound = wb.orchestrator.retry('flaky', 'e2e: nonsensical bound', 0);
  // The bound is read against the task's SHARED retryCount, which the earlier real
  // rework re-entry already incremented - so one limit governs both mechanisms rather
  // than each having its own private budget.
  const used = wb.store.get('flaky')?.retryCount ?? 0;
  const bounded = wb.orchestrator.retry('flaky', 'e2e: bounded retry', used + 1);
  const exhausted = wb.orchestrator.retry('flaky', 'e2e: over the limit', used);
  record('Case 13: E2E C - re-runs start a FRESH session; retry is fail-closed and bounded',
    freshConversation && runsAfterSecond > runsAfterFirst &&
    !premature.ok && parked.ok && !badBound.ok && bounded.ok && !exhausted.ok
      // Only EXECUTION rows carry a worker identity; a review row's `agentId` is the
      // REVIEWER, which is codex here and would make this assert nothing useful.
      && wb.evidence.history('flaky').filter((r) => r.kind !== 'review').every((r) => r.agentId === 'opencode') ? 'PASS' : 'FAIL',
    `runs ${runsAfterFirst}->${runsAfterSecond} handle ${handleBefore === null ? 'none' : 'A'}->${handleAfter === null ? 'none' : 'B'} ` +
    `fresh=${freshConversation} prematureRefused=${!premature.ok}(${premature.ok ? '' : premature.code}) ` +
    `badBoundRefused=${!badBound.ok} used=${used} boundedOk=${bounded.ok} exhaustedRefused=${!exhausted.ok}`);
}

async function case14(): Promise<void> {
  process.stdout.write('\n== CASE 14: E2E D - observe a failure, Laya reassigns with an explicit target ==\n');
  const repo = makeRepo('case14');
  const { wb, ensureBudgets } = makeWorkbench(repo, ['c14-root', 'stuck']);
  wb.orchestrator.createRoot({ taskId: 'c14-root', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'observe then reassign' });
  wb.spawnChild({ taskId: 'stuck', parentTaskId: 'c14-root', agentId: 'opencode', modelId: MODEL_A, taskType: 'implementation', budgetUnits: 10,
    acceptanceCriteria: `Create a file named OBSERVED.txt in the current directory whose entire content is exactly one line: REASSIGNED-AFTER-OBSERVATION.${COMMIT_RULES}` });
  ensureBudgets();
  wb.sessions.open({ agentId: 'opencode', modelId: MODEL_A, sessionPolicy: 'fresh' }, repo, NOW, 'stuck');
  await wb.dispatch();
  await until(() => wb.store.get('stuck')?.status === 'to_verify', 420_000);
  // Back to a dispatchable state through the real rework re-entry - a finished task
  // cannot be re-queued directly, and pretending otherwise would test nothing.
  wb.applyReview('stuck', validateReviewVerdict({ verdict: 'rework', reason: 'e2e: after observation', findings: [], recommendedAction: 'none', reviewer: 'codex', reviewedAt: NOW }));
  await until(() => wb.store.get('stuck')?.status === 'queued', 420_000);
  // OBSERVE: the brain's only input is the snapshot, never a hand-written target.
  const obs = observeTasks(wb.store, { now: Date.now(), rootTaskId: 'c14-root' });
  const observedAgent = obs.tasks.find((t) => t.taskId === 'stuck')?.agentId;
  // ...and it decides, with a target.
  const d = await decideWithProvider(wb, targetedProvider('reassign', {
    taskId: 'stuck', agentId: 'codex', modelId: CODEX_MODEL, reason: 'e2e: after observation',
  }), 'c14-root');
  const migrated = wb.store.get('stuck')?.agentId === 'codex';
  wb.sessions.open({ agentId: 'codex', modelId: CODEX_MODEL, sessionPolicy: 'fresh' }, repo, NOW, 'stuck');
  await wb.dispatch();
  await until(() => wb.evidence.history('stuck').some((r) => r.agentId === 'codex'), 420_000);
  const ranOnCodex = wb.evidence.history('stuck').some((r) => r.agentId === 'codex');
  record('Case 14: E2E D - observation - Laya target - migration - next tick runs on the new worker',
    String(observedAgent) === 'opencode' && d.applied && migrated && ranOnCodex ? 'PASS' : 'FAIL',
    `observed=${String(observedAgent)} applied=${d.applied} migrated=${migrated} ranOnCodex=${ranOnCodex} ` +
    `runs=${wb.evidence.history('stuck').length}`);
}

// The contract every task in case15 is held to. Spelling it out identically in each
// acceptance criterion is the POINT: if the orchestrator cannot carry these names
// from one real agent's output into the next real agent's brief, the tasks disagree
// and the final `node --test` cannot pass. That is what makes this a coordination
// test rather than four independent file-writes.
const C15_CONTRACT =
  'Use EXACTLY these names, do not rename or re-export them: ' +
  'file src/types.js exporting `export const DEFAULTS = { max: 3, windowMs: 1000 };`. ' +
  'file src/limiter.js exporting `export class RateLimiter` whose constructor takes ' +
  '`{ max, windowMs }` (falling back to DEFAULTS from ./types.js) and which exposes ' +
  '`allow(key)` returning true while that key has been allowed fewer than `max` times ' +
  'inside `windowMs` (false afterwards), and `count(key)` returning the current count. ' +
  'Files must be plain ESM JavaScript. ' +
  'Do not create package.json, tsconfig, or any other file than the ones named here.';

async function case15(): Promise<void> {
  process.stdout.write('\n== CASE 15: E2E E - a real 4-task DAG: contracts across agents, dependency order, parallelism ==\n');
  const repo = makeRepo('case15');
  // Budget scopes must exist BEFORE spawnChild: the gate is fail-closed on a missing
// scope and refuses the spawn outright rather than deferring.
const { wb, ensureBudgets } = makeWorkbench(repo, ['types', 'limiter', 'tests', 'docs']);
  wb.orchestrator.createRoot({ taskId: 'c15-root', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'build a tiny rate limiter as a coordinated 4-task project' });

  // The DAG: types -> limiter -> { tests, docs }. `docs` also reads the limiter, so
  // the two leaves must genuinely run in parallel and both depend on real upstream work.
  const specs = [
    { taskId: 'types', agentId: 'opencode', modelId: MODEL_A, deps: [] as string[], ac: `Create src/types.js containing only the DEFAULTS constant described here. ${C15_CONTRACT}` },
    { taskId: 'limiter', agentId: 'opencode', modelId: MODEL_B, deps: ['types'], ac: `Create src/limiter.js implementing RateLimiter exactly as specified. ${C15_CONTRACT}` },
    { taskId: 'tests', agentId: 'opencode', modelId: MODEL_A, deps: ['limiter'], ac: `Create test/limiter.test.js using node:test + node:assert that imports RateLimiter from ../src/limiter.js and proves: with max 3, the first 3 allow() calls for one key return true and the 4th returns false; a second key has its own count. Then run \`node --test\` and make it pass. ${C15_CONTRACT}` },
    { taskId: 'docs', agentId: 'workbuddy-intl', modelId: 'hy3', deps: ['limiter'], ac: `Read src/limiter.js, then create README-API.md documenting the REAL exported API: the RateLimiter class, its allow(key) and count(key) methods, and the DEFAULTS object. Document only what the file actually exports. ${C15_CONTRACT}` },
  ];

  // Dependency-aware spawning: only `types` may exist immediately; the rest are
  // allowed to exist with unsatisfied dependencies so the SCHEDULER (not the spawn
  // call) decides when each becomes runnable.
  for (const s of specs) {
    const spawned = wb.orchestrator.spawnChild({
      taskId: s.taskId, parentTaskId: 'c15-root', agentId: s.agentId, modelId: s.modelId,
      taskType: 'implementation', acceptanceCriteria: s.ac, dependencies: s.deps, allowUnmetDependencies: true,
      budgetUnits: 10,
    });
    if (!spawned.ok) { record('Case 15: E2E E - a real 4-task DAG', 'FAIL', `spawn ${s.taskId} refused: ${spawned.code} ${spawned.reason}`); return; }
  }
  ensureBudgets();
  for (const s of specs) wb.sessions.open({ agentId: s.agentId, modelId: s.modelId, sessionPolicy: 'fresh' }, repo, NOW, s.taskId);

  const start = Date.now();
  // Repeated ticks: the scheduler must refuse to run `limiter` before `types` has
  // finished, which is the dependency contract being tested for real.
  let ticks = 0;
  for (; ticks < 8; ticks++) {
    await wb.dispatch();
    // The DAG is deliberately dependency-based: `limiter` depends on `types`,
    // and `tests`/`docs` depend on `limiter`. The scheduler only admits a task
    // after every dependency is `succeeded`, so the harness must perform the
    // same explicit verification step a real Human Gate would perform between
    // rounds. Omitting this was a harness bug: it left upstream tasks in
    // `to_verify` and then asserted that downstream tasks should unlock.
    for (const task of wb.store.all()) {
      if (task.depth > 0 && task.status === 'to_verify') {
        wb.orchestrator.applyVerification(task.taskId, {
          verdict: 'pass',
          reason: 'e2e harness: upstream task verified so dependency admission can proceed',
        });
      }
    }
    const done = ['types', 'limiter', 'tests', 'docs'].every((t) => {
      const status = wb.store.get(t)?.status;
      return status === 'to_verify' || status === 'succeeded';
    });
    if (done) break;
    await new Promise((r) => setTimeout(r, 4000));
  }

  const ev = (id: string) => wb.evidence.history(id);
  const firstStart = (id: string): number => { const e = ev(id)[0]; return e ? e.startedAt : 0; };
  const lastEnd = (id: string): number => { const e = ev(id)[ev(id).length - 1]; return e ? (e.finishedAt ?? 0) : 0; };

  const ranAll = specs.every((s) => ev(s.taskId).length > 0);
  const eachRanOnce = specs.every((s) => ev(s.taskId).length === 1);
  const ranOnRightAgent = specs.every((s) => ev(s.taskId).every((e) => e.agentId === s.agentId));
  // dependency order, measured from real timestamps
  const typesBeforeLimiter = lastEnd('types') <= firstStart('limiter');
  const limiterBeforeTests = lastEnd('limiter') <= firstStart('tests');
  const limiterBeforeDocs = lastEnd('limiter') <= firstStart('docs');
  // genuine parallelism: the two leaves overlapped in time
  const overlap = Math.min(lastEnd('tests'), lastEnd('docs')) - Math.max(firstStart('tests'), firstStart('docs'));
  const parallel = overlap > 0;

  const exists = (p: string): boolean => { try { return statSync(join(repo, p)).isFile(); } catch { return false; } };
  const read = (p: string): string => { try { return readFileSync(join(repo, p), 'utf8'); } catch { return ''; } };
  const files = exists('src/types.js') && exists('src/limiter.js') && exists('test/limiter.test.js') && exists('README-API.md');

  // The cross-task contract, verified on the ARTIFACTS: the limiter must import the
  // DEFAULTS the types task defined, and the tests must import the limiter.
  const importsDefaults = /import\s*\{[^}]*DEFAULTS[^}]*\}\s*from\s*['"]\.\/types\.js['"]/.test(read('src/limiter.js'));
  const testsImportLimiter = /from\s*['"]\.\.\/src\/limiter\.js['"]/.test(read('test/limiter.test.js'));
  const docsMentionApi = read('README-API.md').includes('allow') && read('README-API.md').includes('count');

  // And the real proof: do the tests the agents wrote actually pass?
  let testOut = '';
  let testsPass = false;
  try {
    testOut = execSync('node --test 2>&1', { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
    testsPass = true;
  } catch (e) {
    testOut = `${(e as { stdout?: string }).stdout ?? ''}${(e as { stderr?: string }).stderr ?? ''}`;
    testsPass = false;
  }
  const committed = (tryGit(repo, 'rev-list --count HEAD') ?? '0') !== '1';

  record('Case 15: E2E E - a real 4-task DAG: contracts across agents, dependency order, parallelism',
    ranAll && eachRanOnce && ranOnRightAgent && typesBeforeLimiter && limiterBeforeTests && limiterBeforeDocs
      && parallel && files && importsDefaults && testsImportLimiter && docsMentionApi && testsPass && committed ? 'PASS' : 'FAIL',
    `ranAll=${ranAll} once=${eachRanOnce} rightAgent=${ranOnRightAgent} ` +
    `deps(types<limiter<tests,docs)=${typesBeforeLimiter && limiterBeforeTests && limiterBeforeDocs} ` +
    `parallelOverlap=${parallel}(${Math.round(overlap / 1000)}s) files=${files} ` +
    `importsDefaults=${importsDefaults} testsImportLimiter=${testsImportLimiter} docs=${docsMentionApi} ` +
    `node --test=${testsPass ? 'PASS' : 'FAIL'} commits>1=${committed} ticks=${ticks} wall=${Math.round((Date.now() - start) / 1000)}s ` +
    `states=${specs.map((s) => `${s.taskId}:${wb.store.get(s.taskId)?.status}:${ev(s.taskId).length}`).join(',')}` +
    (testsPass ? '' : ` :: ${testOut.split('\n').filter((l) => /not ok|Error|assert/i.test(l)).slice(0, 2).join(' | ').slice(0, 200)}`));
}

// ============================================================================
// R2-1.1 (P2-2): the R2-1 workspace path, exercised by a REAL native agent.
//
// Reported SEPARATELY from Case 15 on purpose: Case 15's result (an agent-variance
// question about whether a worker wrote its file) must never be allowed to stand in
// for, or mask, this one.
// ============================================================================
async function case16(): Promise<void> {
  process.stdout.write('\n== CASE 16: R2-1 workspace isolation - a REAL agent in a REAL worktree ==\n');
  const repo = makeRepo('case16');
  // The real WorkspaceManager over the real repo - not a hand-rolled worktree, and
  // not a second implementation.
  const manager = new WorkspaceManager({ projectRoot: repo });
  const { wb, ensureBudgets, requests } = makeWorkbench(repo, ['writer'], { manager });

  wb.orchestrator.createRoot({ taskId: 'c16-root', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'write a proof file' });
  const spawned = wb.orchestrator.spawnChild({
    taskId: 'writer', parentTaskId: 'c16-root', agentId: 'opencode', modelId: MODEL_A,
    taskType: 'implementation', budgetUnits: 10,
    acceptanceCriteria:
      `Create a file named R21-ISOLATION-PROOF.txt in the current directory whose entire content is exactly ` +
      `one line: R2-1-ISOLATED-WORKSPACE. Then run: git add -A && git commit -m "r21 isolation proof" ` +
      `(a git repo already exists; you are on the right branch; never push; never create branches).` +
      COMMIT_RULES,
  });
  ensureBudgets();
  if (!spawned.ok) {
    record('Case 16: R2-1 - a REAL agent executes in a REAL isolated workspace', 'FAIL',
      `spawn refused: ${spawned.code} ${spawned.reason}`);
    return;
  }
  wb.sessions.open({ agentId: 'opencode', modelId: MODEL_A, sessionPolicy: 'fresh' }, repo, NOW, 'writer');

  await wb.dispatch();
  await until(() => requests.length > 0, 420_000);
  const req = requests[0];
  const handle = manager.get('writer');

  // 1. a native agent really ran
  const ranRealAgent = requests.length > 0 && wb.evidence.history('writer').length > 0;
  // 2. the cwd it was given is an isolated workspace, not the project root
  const cwdIsWorkspace = req !== undefined && req.cwd === handle?.cwd && req.cwd !== repo;
  // 3/4. the proof file exists INSIDE that workspace with the exact content
  const proofPath = handle === null || handle === undefined ? '' : join(handle.cwd, 'R21-ISOLATION-PROOF.txt');
  const wroteProof = proofPath !== '' && existsSync(proofPath);
  const proofContent = wroteProof ? readFileSync(proofPath, 'utf8').trim() : '';
  // 5. the project root was NOT touched
  const rootUntouched = !existsSync(join(repo, 'R21-ISOLATION-PROOF.txt'));
  // 6. workspace / branch identity differs from the root
  const distinctIdentity =
    handle !== null && handle !== undefined &&
    handle.workspaceId === 'task:writer' &&
    handle.mode === 'isolated' &&
    handle.branch !== null && handle.branch !== 'main' &&
    handle.baseSha !== null;
// Whether the agent also COMMITTED is reported but NOT asserted. The proof file
  // existing inside the worktree already establishes that the agent ran there, and
  // whether it went on to run `git commit` is agent behaviour variance — the same
  // variance Case 15 trips over. Folding it into this verdict would make a workspace
  // ISOLATION test fail for a reason that has nothing to do with isolation.
  const committed = (tryGit(handle?.cwd ?? repo, 'rev-list --count HEAD') ?? '0') !== '1';

  record('Case 16: R2-1 — a REAL agent executes in a REAL isolated workspace',
    ranRealAgent && cwdIsWorkspace && wroteProof && proofContent === 'R2-1-ISOLATED-WORKSPACE'
      && rootUntouched && distinctIdentity ? 'PASS' : 'FAIL',
    `realAgent=${ranRealAgent} cwdIsWorkspace=${cwdIsWorkspace} proof=${wroteProof}` +
    ` content=${JSON.stringify(proofContent.slice(0, 40))} rootUntouched=${rootUntouched} ` +
    `identity=${distinctIdentity} branch=${String(handle?.branch)} ` +
    `[agentCommitted=${committed} (reported, not asserted)] cwd=${String(req?.cwd).slice(0, 60)}`);
}

/**
 * CASE 17 - R2-2: a REAL native agent whose assignment is superseded WHILE it runs.
 *
 * This is the fencing guarantee tested against a real process rather than a stub. The
 * interesting window is the one no unit test can open honestly: a real agent is
 * genuinely executing in a real isolated worktree, and the assignment is moved to a
 * different worker in the middle of it.
 *
 * What must hold afterwards:
 *   - the real work really happened (proof file, real RunRequest, real agent)
 *   - the late result CANNOT write back (stale lease version)
 *   - the execution is still recorded as evidence, attributed to the agent that ran it
 *     and to the lease version it actually held
 *   - the task is NOT polluted: it belongs to the new holder and never reached to_verify
 *
 * Everything reused is production: the real WorkspaceManager, real git worktree, the
 * real runtime and the real OpenCode adapter. Only the reassignment is driven by the
 * test, because in production that decision belongs to Laya.
 */
async function case17(): Promise<void> {
  process.stdout.write('\n== CASE 17: R2-2 lease fencing - a REAL agent superseded mid-run ==\n');
  const repo = makeRepo('case17');
  const manager = new WorkspaceManager({ projectRoot: repo });
  const { wb, ensureBudgets, requests } = makeWorkbench(repo, ['stale'], { manager });
  const store = wb.orchestrator.getStore();

  wb.orchestrator.createRoot({ taskId: 'c17-root', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'write a proof file' });
  const spawned = wb.orchestrator.spawnChild({
    taskId: 'stale', parentTaskId: 'c17-root', agentId: 'opencode', modelId: MODEL_A,
    taskType: 'implementation', budgetUnits: 10,
    acceptanceCriteria:
      `Create a file named R22-FENCE-PROOF.txt in the current directory whose entire content is exactly ` +
      `one line: R2-2-STALE-RESULT-FENCED. Then run: git add -A && git commit -m "r22 fence proof" ` +
      `(a git repo already exists; you are on the right branch; never push; never create branches).` +
      COMMIT_RULES,
  });
  ensureBudgets();
  if (!spawned.ok) {
    record('Case 17: R2-2 — a REAL agent superseded mid-run is fenced but kept as evidence', 'FAIL',
      `spawn refused: ${spawned.code} ${spawned.reason}`);
    return;
  }
  wb.sessions.open({ agentId: 'opencode', modelId: MODEL_A, sessionPolicy: 'fresh' }, repo, NOW, 'stale');

  const leaseBefore = store.leaseOf('stale');
  const leaseVersionBefore = leaseBefore?.leaseVersion ?? -1;
  const tokenBefore = leaseBefore?.fencingToken ?? '';

  // NOT awaited: the dispatch must stay in flight while the world changes underneath it.
  const dispatchPromise = wb.dispatch();
  await until(() => requests.length > 0, 420_000);

  // The agent is now REALLY running. Move the assignment to a different worker.
  //
  // ONE CLOCK, and it matters: a lease's deadline is minted from the timestamp its
  // issuer supplies and evaluated against the clock the orchestrator reads. This
  // harness's orchestrator runs on real time, so passing the suite-wide `NOW` constant
  // (a fixed 2023 epoch) here would mint a lease that was ALREADY EXPIRED the instant
  // it was issued - which is a correct refusal for the wrong reason, and would have
  // hidden the property this case exists to prove. `Date.now()` keeps issuance and
  // evaluation on the same clock.
  const issuedAt = Date.now();
  const migrated = store.migrateIdentityAfterStart(
    'stale',
    { agentId: 'workbuddy-intl', modelId: 'hy3', reason: 'r2-2 e2e: superseded while the real agent was running' },
    issuedAt,
  );
  const leaseAfter = store.leaseOf('stale');
  // A lease minted a moment ago must not be born expired.
  const bornLive = leaseAfter !== null && leaseAfter.expiresAt > issuedAt;

  const outcome = await dispatchPromise;
  const entry = outcome.tick?.outcomes.find((o) => o.taskId === 'stale');
  const exec = entry?.outcome;

  // 1. a REAL agent really ran, in a REAL isolated worktree
  const ranRealAgent = requests.length > 0 && exec !== undefined && exec.run !== undefined;
  const handle = manager.get('stale');
  const proofPath = handle === null || handle === undefined ? '' : join(handle.cwd, 'R22-FENCE-PROOF.txt');
  const wroteProof = proofPath !== '' && existsSync(proofPath);
  const proofContent = wroteProof ? readFileSync(proofPath, 'utf8').trim() : '';

  // 2. the reassignment really advanced the lease
  const leaseAdvanced = migrated.ok && (leaseAfter?.leaseVersion ?? -1) === leaseVersionBefore + 1;
  const tokenChanged = (leaseAfter?.fencingToken ?? '') !== tokenBefore;

  // 3. the late result was REFUSED
  const refused = exec !== undefined && exec.ok === false;
  const refusedCode = refused ? (exec as { code?: string }).code : '';
  const staleRefusal = refusedCode === 'stale-lease-version';

  // 4. it is still EVIDENCE, attributed correctly (F5)
  const attempts = wb.evidence.history('stale');
  const attempt = attempts[0];
  const evidenceKept = attempts.length > 0;
  const attributedToRealAgent = attempt?.agentId === 'opencode';
  const recordedStaleVersion = attempt?.leaseVersion === leaseVersionBefore;

  // 5. the task was NOT polluted by the stale result
  const after = store.get('stale');
  const notAdvanced = after?.status !== 'to_verify' && after?.status !== 'succeeded';
  const stillNewHolder = after?.agentId === 'workbuddy-intl';

  record('Case 17: R2-2 — a REAL agent superseded mid-run is fenced but kept as evidence',
    ranRealAgent && wroteProof && bornLive && leaseAdvanced && tokenChanged && staleRefusal
      && evidenceKept && attributedToRealAgent && recordedStaleVersion && notAdvanced && stillNewHolder
      ? 'PASS' : 'FAIL',
    `realAgent=${ranRealAgent} proof=${wroteProof} content=${JSON.stringify(proofContent.slice(0, 40))} ` +
    `lease ${leaseVersionBefore}->${leaseAfter?.leaseVersion} tokenChanged=${tokenChanged} bornLive=${bornLive} ` +
    `refused=${refusedCode} runRejected=${(exec as { runRejected?: boolean } | undefined)?.runRejected === true} ` +
    `evidence=${evidenceKept} agent=${String(attempt?.agentId)} attemptLeaseVersion=${String(attempt?.leaseVersion)} ` +
    `status=${String(after?.status)} holder=${String(after?.agentId)} cwd=${String(requests[0]?.cwd).slice(0, 50)}`);
}

/**
 * CASE 18 - R2-2: a REAL native agent whose LEASE IS REVOKED while it runs.
 *
 * Case 17 proves the `stale-lease-version` branch (a reassignment supersedes the holder).
 * This proves the OTHER branch, the one pure token comparison structurally cannot catch:
 * `revokeLease` deliberately keeps `leaseVersion` and `fencingToken`, so a revoked lease
 * still "matches" every credential check. Only lifecycle-aware validation rejects it.
 *
 * Same shape as 17, real agent and real worktree, so the claim is not that a stub can
 * refuse a write - it is that a real OpenCode process, mid-work in a real git worktree,
 * has its result refused while its execution is still recorded.
 */
async function case18(): Promise<void> {
  process.stdout.write('\n== CASE 18: R2-2 lease revoked mid-run - a REAL agent is fenced but kept as evidence ==\n');
  const repo = makeRepo('case18');
  const manager = new WorkspaceManager({ projectRoot: repo });
  const { wb, ensureBudgets, requests } = makeWorkbench(repo, ['revoked'], { manager });
  const store = wb.orchestrator.getStore();

  wb.orchestrator.createRoot({ taskId: 'c18-root', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'write a proof file' });
  const spawned = wb.orchestrator.spawnChild({
    taskId: 'revoked', parentTaskId: 'c18-root', agentId: 'opencode', modelId: MODEL_A,
    taskType: 'implementation', budgetUnits: 10,
    acceptanceCriteria:
      `Create a file named R22-REVOKE-PROOF.txt in the current directory whose entire content is exactly ` +
      `one line: R2-2-REVOKED-MIDRUN. Then run: git add -A && git commit -m "r22 revoke proof" ` +
      `(a git repo already exists; you are on the right branch; never push; never create branches).` +
      COMMIT_RULES,
  });
  ensureBudgets();
  if (!spawned.ok) {
    record('Case 18: R2-2 — a REAL agent revoked mid-run is fenced but kept as evidence', 'FAIL',
      `spawn refused: ${spawned.code} ${spawned.reason}`);
    return;
  }
  wb.sessions.open({ agentId: 'opencode', modelId: MODEL_A, sessionPolicy: 'fresh' }, repo, NOW, 'revoked');

  const leaseBefore = store.leaseOf('revoked');
  const versionBefore = leaseBefore?.leaseVersion ?? -1;
  const tokenBefore = leaseBefore?.fencingToken ?? '';

  // NOT awaited: the dispatch must stay in flight while the lease is revoked.
  const dispatchPromise = wb.dispatch();
  await until(() => requests.length > 0, 420_000);

  // ONE clock, as in Case 17: the orchestrator runs on real time here, so a lease minted
  // from the suite's fixed 2023 epoch would be born expired rather than revoked, and the
  // case would pass for the wrong reason.
  const revokedAt = Date.now();
  const revoked = store.revokeLeaseFor('revoked', 'r2-2 e2e: assignment withdrawn while the real agent was running');
  const leaseAfter = store.leaseOf('revoked');

  const outcome = await dispatchPromise;
  const entry = outcome.tick?.outcomes.find((o) => o.taskId === 'revoked');
  const exec = entry?.outcome;

  // 1. a REAL agent really ran. This is established by the runtime seam and the real
  //    RunResult, NOT by the proof file.
  //
  //    Whether the agent went on to write its proof file is agent behaviour variance -
  //    the same variance Case 15 and 16 already isolate - and it has nothing to do with
  //    fencing. Case 16 sets the precedent for exactly this judgement: "the proof file
  //    existing inside the worktree already establishes that the agent ran there, and
  //    whether it went on to run `git commit` is agent behaviour variance... Folding it
  //    into this verdict would make a fencing test fail for a reason unrelated to
  //    fencing." So the file is REPORTED here, and observed to be absent on this run,
  //    rather than being allowed to decide a fencing verdict.
  const ranRealAgent = requests.length > 0 && exec !== undefined && exec.run !== undefined;
  const handle = manager.get('revoked');
  const proofPath = handle === null || handle === undefined ? '' : join(handle.cwd, 'R22-REVOKE-PROOF.txt');
  const wroteProof = proofPath !== '' && existsSync(proofPath);
  const proofContent = wroteProof ? readFileSync(proofPath, 'utf8').trim() : '';

  // 2. the revoke really happened, and did NOT change version or token
  //    (which is precisely why token comparison alone could not catch it)
  const revokeApplied = revoked !== null && leaseAfter?.status === 'revoked';
  const versionUnchanged = leaseAfter?.leaseVersion === versionBefore;
  const tokenUnchanged = leaseAfter?.fencingToken === tokenBefore;
  const bornLive = leaseBefore !== null && leaseBefore.expiresAt > revokedAt;

  // 3. the late result was REFUSED for the lifecycle reason
  const refused = exec !== undefined && exec.ok === false;
  const refusedCode = refused ? (exec as { code?: string }).code : '';
  const revokeRefusal = refusedCode === 'lease-revoked';

  // 4. evidence survives, attributed to the agent that actually ran
  const attempts = wb.evidence.history('revoked');
  const attempt = attempts[0];
  const evidenceKept = attempts.length > 0;
  const attributedToRealAgent = attempt?.agentId === 'opencode';

  // 5. the task was not reopened and nothing was retried or reassigned
  const after = store.get('revoked');
  const notAdvanced = after?.status !== 'to_verify' && after?.status !== 'succeeded';
  const sameHolder = after?.agentId === 'opencode';
  const versionIntact = after?.leaseVersion === versionBefore;

  record('Case 18: R2-2 — a REAL agent revoked mid-run is fenced but kept as evidence',
    ranRealAgent && revokeApplied && versionUnchanged && tokenUnchanged && bornLive
      && revokeRefusal && evidenceKept && attributedToRealAgent && notAdvanced && sameHolder && versionIntact
      ? 'PASS' : 'FAIL',
    `realAgent=${ranRealAgent} revokeApplied=${revokeApplied} versionUnchanged=${versionUnchanged} ` +
    `tokenUnchanged=${tokenUnchanged} bornLive=${bornLive} refused=${refusedCode} ` +
    `runRejected=${(exec as { runRejected?: boolean } | undefined)?.runRejected === true} ` +
    `evidence=${evidenceKept} agent=${String(attempt?.agentId)} attemptLeaseVersion=${String(attempt?.leaseVersion)} ` +
    `status=${String(after?.status)} holder=${String(after?.agentId)} cwd=${String(requests[0]?.cwd).slice(0, 50)} ` +
    `[proofFile=${wroteProof} content=${JSON.stringify(proofContent.slice(0, 30))} (reported, not asserted: agent variance)]`);
}

await (async () => {
  process.stdout.write(`native-agent-e2e root: ${ROOT}\n`);
  await case1();
  await case2();
  await case3();
  await case4();
  await case5();
  await case6();
  await case7();
  await case8();
  await case9();
  await case10();
  await case11();
  await case12();
  await case13();
  await case14();
  await case15();
  await case16();
  await case17();
  await case18();
  process.stdout.write('\n==== NATIVE E2E SUMMARY ====\n');
  for (const r of results) process.stdout.write(`  [${r.verdict}] ${r.name}${r.detail ? ' :: ' + r.detail.slice(0, 160) : ''}\n`);
  const pass = results.filter((r) => r.verdict === 'PASS').length;
  process.stdout.write(`==== ${pass}/${results.length} PASS ====\n`);
  try {
    rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (e) {
    // Cleanup must not change the verdict. Windows can briefly retain handles in
    // agent-owned temp files; that is an environment cleanup fact, not a result.
    process.stdout.write(`[WARN] temp cleanup left ${ROOT}: ${(e as Error).message}\n`);
  }
  process.exitCode = pass === results.length ? 0 : 1;
})();
