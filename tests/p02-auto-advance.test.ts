/**
 * tests/p02-auto-advance.test.ts — P0-2 TEST-ONLY acceptance: the BOUNDED machine
 * auto-advance success chain plus bounded authorization/review/test-failure negatives.
 *
 * ============================================================================
 * WHAT IS REAL vs INJECTED (one success chain)
 * ============================================================================
 * REAL: `runRoundCli` -> the P0-2 stage gate (file reads + `parseStageMaterial` + the
 * bounded `buildApprovalAuthorization` binding) -> the plan-file parser -> Assignment ->
 * the spawn gate -> the Scheduler -> `executeTask` -> AttemptStore -> the P0-2 machine
 * auto-advance gate -> the EXISTING completion authority (`wb.completeTask`) -> the P0-1
 * completion contract -> the two APPROVED TESTS (REAL contained `node` processes through
 * production `completion-evidence.runApprovedTest`/`ManagedProcess`) -> the bounded
 * workflow loop -> the machine-auto review projection.
 *
 * INJECTED, and only these:
 *   - LAYA's ANSWERS, through an `layaFetchImpl` transport seam BELOW the real
 *     `createLayaDecisionProvider` (auto mode refuses an opaque `provider` override).
 *   - The runtime PROBES (a full, valid `QuotaProbe`).
 *   - The native agents' own processes: fake adapters that exit 0 while a wrapper writes
 *     the files the scenario calls for. Clearly marked as a fixture, not an Agent.
 *
 * The fake fetch NEVER uses `globalThis.fetch`; that is replaced with a thrower, and the
 * offline policy is explicitly installed + frozen.
 * No real Agent, no real LAYA/Native Review, no credentials, no network.
 *
 * SCOPE: A success, B approval revoked during async preparation before transport,
 * C withheld Review after successful tasks, including a real contained child exit,
 * D failed approved test blocks downstream, E wait preserves zero dispatch,
 * F a confirmed stage with explicit checkpoint respects the fixture's stop,
 * I (P03-F1) approval revoked DURING the controlled Review, after both Workers and
 * their approved tests completed; the late revocation must reach the saved attention.
 * Other rejected draft cases remain unverified.
 *
 * Run: the registered offline Runner (TEST_TIMED_SUITES=tests/p02-auto-advance.test.ts),
 * not a direct node invocation.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runRoundCli, type RoundCliOverrides } from '../src/cli/round-cli.ts';
import { Orchestrator as RuntimeOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { createFakeAdapter } from './helpers.ts';
import { ORCHESTRATION_ACTION_ID } from '../src/orchestration/decision-loop.ts';
import { installOfflinePolicy, isOfflineFrozen } from '../src/runtime/offline-policy.ts';
import { ManagedProcess } from '../src/runtime/spawn.ts';
import { launcherFor } from '../src/runtime/launcher.ts';
import type { RunHandle, RunRequest, RunResult, ToolCall } from '../src/core/types.ts';
import type { QuotaProbe } from '../src/quota/index.ts';
import type { WorkflowCheckpointSnapshot } from '../src/cli/workflow-checkpoint.ts';
import type { PendingUserSummary } from '../src/orchestration/round-result.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];
const ownedDirs: string[] = [];
const cleanupFailures: string[] = [];
const REVIEW_CHILD = process.argv.includes('--p02-review-withheld-child') && process.env.P02_REVIEW_WITHHELD_CHILD === '1';
let reviewChildReport: Record<string, unknown> | undefined;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; process.stdout.write(`  ok   ${name}\n`); }
  else { failed++; failures.push(name); process.stdout.write(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}\n`); }
}
function section(t: string): void { process.stdout.write(`\n== ${t} ==\n`); }
function ownDir(tag: string): string { const d = mkdtempSync(join(tmpdir(), `p02-${tag}-`)); ownedDirs.push(d); return d; }
function removeOwnedDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); }
  catch (e) { cleanupFailures.push(`owned dir removal threw for ${dir}: ${(e as Error).message}`); return; }
  if (existsSync(dir)) cleanupFailures.push(`owned dir ${dir} still present after removal`);
}
function filesUnder(root: string, rel = ''): string[] {
  const out: string[] = [];
  const entries = existsSync(join(root, rel)) ? readdirSync(join(root, rel), { withFileTypes: true }) : [];
  for (const entry of entries) {
    const child = rel === '' ? entry.name : `${rel}${sep}${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnder(root, child));
    else out.push(child.split(sep).join('/'));
  }
  return out;
}

// ============================================================================
// shared fixture
// ============================================================================

const AGENT_A = 'p02-worker';
const REVIEWER = 'codex';
const WORKER_MODEL = 'p02-worker/free-model';
const REVIEWER_MODEL = 'codex/review-model';
const PLAN_ID = 'add-flow';
const OBJECTIVE = 'implement and test an add module';
const CAPS = { newTask: true, review: true, modelSelection: true, cwd: true, resume: true };
const REVIEWER_CAPS = { ...CAPS, extraArgs: true, sandbox: true };

const ADD_JS = "module.exports = { add: (a, b) => a + b };\n";
const WRONG_ADD_JS = "module.exports = { add: (a, b) => a - b };\n";
const ADD_TEST_JS =
  "const assert = require('assert');\n" +
  "const { add } = require('./add.cjs');\n" +
  "assert.strictEqual(add(2, 3), 5);\n" +
  "assert.strictEqual(add(-2, -3), -5);\n" +
  "assert.strictEqual(add(0, 0), 0);\n" +
  "require('fs').writeFileSync('approved-tester.txt', 'STEP2_TEST_RAN');\n" +
  "console.log('P02_STEP2_TEST_RAN');\n";

const MARKER_CODER = 'approved-coder.txt';
const MARKER_TESTER = 'approved-tester.txt';

const STAGE = {
  stageId: 'stage-add',
  scope: 'a tiny add module and its test',
  requirement: 'add.cjs must export add(a,b) = a+b and add.test.cjs must consume it',
  acceptance: 'the approved node assertions pass',
  planRef: PLAN_ID,
};

const NOW = Date.now();

function probeFor(agentId: string, modelId: string): QuotaProbe {
  return {
    agentId, provider: agentId,
    records: [{ provider: agentId, agentId, modelId: null, source: 'locally_observed', usage: null, remaining: null, resetAt: null, period: 'day', status: 'available', usageClass: 'observed', confidence: 'high', observedAt: NOW, note: '' }],
    login: 'stubbed for test', version: '0.0.0-test', modelHint: modelId, providerHint: null, error: null,
  } as unknown as QuotaProbe;
}

function poolJson() {
  return {
    policy: 'no-additional-charge',
    models: [
      { agentId: AGENT_A, modelId: WORKER_MODEL, billing: 'free', source: 'p02 fixture', observedAt: NOW - 60_000, expiresAt: NOW + 3_600_000 },
      { agentId: REVIEWER, modelId: REVIEWER_MODEL, billing: 'included', source: 'p02 fixture', observedAt: NOW - 60_000, expiresAt: NOW + 3_600_000 },
    ],
  };
}

/** The step-1 APPROVED test: a REAL node process that asserts against the delivered add.cjs. */
function approvedCoderTestArgv(): string[] {
  const script =
    "const assert = require('assert');" +
    "const m = require('./add.cjs');" +
    'assert.strictEqual(m.add(2, 3), 5);' +
    'assert.strictEqual(m.add(-2, -3), -5);' +
    `require('fs').writeFileSync(${JSON.stringify(MARKER_CODER)}, 'STEP1_TEST_RAN');` +
    "console.log('P02_STEP1_TEST_RAN');";
  return ['-e', script];
}

function planFile(): unknown {
  return {
    kind: 'sequential',
    plans: [{
      id: PLAN_ID, label: 'add flow',
      steps: [
        {
          role: 'coder', taskType: 'implementation', fileScope: 'add.cjs', deliverable: 'add.cjs exporting add(a,b)',
          expectedArtifacts: ['add.cjs'], allowedScope: ['add.cjs', MARKER_CODER],
          test: { executable: 'node', argv: approvedCoderTestArgv(), cwd: '.' },
        },
        {
          role: 'tester', taskType: 'test', fileScope: 'add.test.cjs', deliverable: 'add.test.cjs consuming add.cjs',
          expectedArtifacts: ['add.test.cjs'], allowedScope: ['add.test.cjs', MARKER_TESTER],
          test: { executable: 'node', argv: ['add.test.cjs'], cwd: '.' },
        },
      ],
    }],
  };
}

function roleOf(prompt: string): string | null {
  const m = /:: ([\w-]+) — deliverable:/.exec(prompt);
  return m === null ? null : m[1]!;
}

interface FetchRecord { method: string; url: string; body: string | null }
interface Fetcher { impl: typeof fetch; records: FetchRecord[]; posts: () => FetchRecord[]; gets: () => FetchRecord[] }

function envelope(answers: Record<string, unknown>): unknown {
  return {
    model: 'laya-fixture',
    answers,
    routing: { model: 'english', reason: 'controlled fixture', detection: { script: 'latin', language: 'en' }, revisions: {} },
    usage: { input_tokens: 12, output_tokens: 0 },
  };
}

/**
 * Builds one strictly-valid answer for the EXACT question asked. Only the four expected
 * keys are ever answered; an unknown question, or an expected question that does not
 * offer the required option, THROWS. There is deliberately no fallback to offered[0].
 */
function answerFor(key: string, q: { type: string; criteria: unknown }, nextAction: string): Record<string, unknown> {
  if (q.type === 'choice') {
    const offered = Object.keys(q.criteria as Record<string, string>);
    let pick: string;
    if (key === ORCHESTRATION_ACTION_ID) {
      if (!offered.includes(nextAction)) throw new Error(`next_action "${nextAction}" was not offered [${offered.join(', ')}]`);
      pick = nextAction;
    } else if (key === 'work_kind') {
      if (!offered.includes('implementation')) throw new Error(`work_kind did not offer implementation [${offered.join(', ')}]`);
      pick = 'implementation';
    } else {
      throw new Error(`unexpected choice question "${key}" [${offered.join(', ')}]`);
    }
    const probabilities: Record<string, number> = {};
    for (const o of offered) probabilities[o] = o === pick ? 1 : 0;
    return { type: 'choice', choice: pick, probabilities, confidence: 1, answer_confidence: 1, action: { act_probability: 1 } };
  }
  if (q.type === 'score') {
    if (key !== 'complexity') throw new Error(`unexpected score question "${key}"`);
    const levels = q.criteria as string[];
    if (!levels.includes('small')) throw new Error(`complexity did not offer "small" [${levels.join(', ')}]`);
    const index = levels.indexOf('small');
    const probabilities: Record<string, number> = {};
    for (let i = 0; i < levels.length; i++) probabilities[String(i)] = i === index ? 1 : 0;
    const legend: Record<string, string> = {};
    for (let i = 0; i < levels.length; i++) legend[String(i)] = levels[i]!;
    return { type: 'score', score: index, level: levels[index]!, levels: [...levels], probabilities, legend, confidence: 1, answer_confidence: 1, action: { act_probability: 1 } };
  }
  if (q.type === 'noul') {
    if (key !== 'review_required') throw new Error(`unexpected noul question "${key}"`);
    return { type: 'noul', noul: 0, answer_confidence: 1, action: { act_probability: 1 } };
  }
  throw new Error(`unexpected question type "${q.type}" for question "${key}"`);
}

/**
 * A controlled fetch BELOW the real provider. GET is answered ONLY for the explicit
 * `/health` endpoint; POST ONLY for the existing decision endpoint. Anything else throws.
 */
function makeLayaFetch(nextAction: string): Fetcher {
  const records: FetchRecord[] = [];
  const impl = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const method = String(init?.method ?? 'GET');
    const url = String(input);
    let body: string | null = null;
    if (init?.body !== undefined && init.body !== null) {
      const b = init.body as unknown;
      body = typeof b === 'string' ? b : b instanceof ReadableStream ? await new Response(b).text() : String(b);
    }
    records.push({ method, url, body });
    if (method === 'GET') {
      if (!url.endsWith('/health')) throw new Error(`P02: unexpected GET "${url}" (only /health is served)`);
      return new Response(JSON.stringify({ status: 'ok', device: 'cpu', loaded: ['english'], cpu_fallbacks: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (method === 'POST') {
      if (!url.endsWith('/v1/systemone')) throw new Error(`P02: unexpected POST "${url}" (only the decision endpoint is served)`);
      const payload = JSON.parse(body!) as { questions: Record<string, { type: string; criteria: unknown }> };
      const answers: Record<string, unknown> = {};
      for (const [key, q] of Object.entries(payload.questions)) answers[key] = answerFor(key, q, nextAction);
      return new Response(JSON.stringify(envelope(answers)), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`P02: unexpected method "${method}"`);
  }) as unknown as typeof fetch;
  return { impl, records, posts: () => records.filter((r) => r.method === 'POST'), gets: () => records.filter((r) => r.method === 'GET') };
}

interface CaseResult {
  exitCode: number;
  confirmed: boolean;
  stageCheckExit: number;
  stageCheckReport: Record<string, unknown>;
  stageCheckPosts: number;
  stageCheckRequests: number;
  stageCheckReviews: number;
  report: Record<string, unknown>;
  requests: RunRequest[];
  reviewRequests: RunRequest[];
  cwd: string;
  storeDir: string;
  reportDir: string;
  fetchPosts: number;
  fetchGets: number;
  probesRead: number;
  checkpointCalls: number;
  revocationTrace: string[];
  reviewOutputDirectory?: string;
  modeMismatch?: {
    autoMode: unknown; autoDigest: unknown; checkpointDigest: unknown;
    exitCode: number; report: Record<string, unknown>;
    posts: number; workerRuns: number; reviewRuns: number; checkpointCalls: number; probesRead: number;
  };
}

async function runCli(drivable: unknown, argv: readonly string[], overrides: RoundCliOverrides): Promise<{ exit: number; stdout: string; report: Record<string, unknown> }> {
  const before = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => { captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true; }) as typeof process.stdout.write;
  let exit = -1;
  try {
    exit = await runRoundCli(drivable as never, argv, overrides);
  } finally {
    process.stdout.write = before;
  }
  const i = captured.indexOf('{');
  let report: Record<string, unknown> = {};
  if (i !== -1) { try { report = JSON.parse(captured.slice(i)) as Record<string, unknown>; } catch { report = {}; } }
  return { exit, stdout: captured, report };
}

// Only paths offered to this synthetic reviewer belong to the fixture. Production
// deliberately retains them when stop/identity cannot be confirmed.
function fixtureFinalOutputPath(req: Omit<RunRequest, 'mode'>): string | null {
  const args = req.extraArgs ?? [];
  const index = args.indexOf('--output-last-message');
  if (index < 0) return null;
  const file = args[index + 1];
  if (!file || basename(file) !== 'final-message.json' ||
      dirname(dirname(resolve(file))) !== resolve(tmpdir()) ||
      !basename(dirname(file)).startsWith('native-agent-review-')) {
    throw new Error('fixture received an unexpected owned output path');
  }
  return resolve(file);
}

/**
 * The shared real CLI chain:
 *   1. stage-check with the SAME runtime/config/args obtains the digest, and is proven to
 *      have made ZERO probe-driven POSTs, dispatched ZERO workers and run ZERO reviews.
 *   2. the confirm run.
 *
 * This function NEVER deletes its owned directories: the caller asserts against the real
 * on-disk files first, then the top-level finally cleans up.
 */
async function harness(options: { revokeBeforeSend?: boolean; revokeDuringReview?: boolean; withholdReview?: boolean; wrongImplementation?: boolean; wait?: boolean; checkpointInput?: (snapshot: WorkflowCheckpointSnapshot) => string; maxLayaPosts?: number; reviewVerdict?: 'reject' | 'rework' } = {}): Promise<CaseResult> {
  const cwd = ownDir('cwd');
  const storeDir = ownDir('store');
  const reportDir = join(ownDir('reports'), 'reports');

  writeFileSync(join(cwd, 'stage.json'), JSON.stringify(STAGE), 'utf8');
  writeFileSync(join(cwd, 'plans.json'), JSON.stringify(planFile()), 'utf8');
  const pool = poolJson();
  if (options.withholdReview) pool.models = pool.models.filter((entry) => entry.agentId !== REVIEWER);
  writeFileSync(join(cwd, 'pool.json'), JSON.stringify(pool), 'utf8');

  const requests: RunRequest[] = [];
  const reviewRequests: RunRequest[] = [];
  let reviewOutputDirectory: string | undefined;
  const VERDICT = JSON.stringify({ verdict: options.reviewVerdict ?? 'pass', reason: 'fixture reviewer: the deliveries meet the recorded runs', findings: [], recommendedAction: 'none', reviewer: 'fixture-codex', reviewedAt: 1 });
  const runtime = new RuntimeOrchestrator({
    config: { agents: {} } as never,
    storeDir,
    replaceAdapters: [
      createFakeAdapter({ id: AGENT_A, capabilities: CAPS, script: [{ kind: 'exit', code: 0 }] }),
      createFakeAdapter({ id: REVIEWER, capabilities: REVIEWER_CAPS, script: [{ kind: 'frame', text: VERDICT, data: { text: VERDICT } }, { kind: 'exit', code: 0 }] }),
    ],
  });
  const drivable = {
    agentIds: () => [AGENT_A],
    descriptors: () => [AGENT_A].map((id) => ({ id, displayName: id, launcher: 'fake', transport: 'cli-jsonl', capabilities: { newTask: true, review: true, modelSelection: true, cwd: true, resume: true } } as never)),
    configFor: (id: string) => ({ command: 'fake-fixture', model: id === REVIEWER ? REVIEWER_MODEL : WORKER_MODEL } as never),
    store: runtime.store,
    review: (req: Omit<RunRequest, 'mode'>) => {
      reviewRequests.push({ ...req, mode: 'review' } as RunRequest);
      // P0-3c.1: a DETERMINISTIC late revocation. The controlled reviewer is admitted while the
      // approved material is still valid, and the material is changed only HERE, inside the
      // review callback — after both Workers and both REAL approved tests already succeeded and
      // after the auto-review blockers were evaluated. The reviewer still answers its own legal
      // pass; only the LATER final approval check can observe the change.
      if (options.revokeDuringReview) {
        writeFileSync(join(cwd, 'stage.json'), JSON.stringify({ ...STAGE, acceptance: 'Owner revoked the approved acceptance during the independent Review' }), 'utf8');
      }
      const file = fixtureFinalOutputPath(req);
      if (file === null) throw new Error('fixture reviewer received no owned output-last-message path');
      reviewOutputDirectory = dirname(file);
      ownedDirs.push(reviewOutputDirectory);
      writeFileSync(file, VERDICT, { encoding: 'utf8', flag: 'wx' });
      return runtime.review(req);
    },
    run(req: RunRequest): RunHandle {
      requests.push(req);
      const runIdx = requests.length;
      const role = roleOf(req.prompt);
      let changedFiles: string[] = [];
      let output: string;
      if (role === 'coder') {
        writeFileSync(join(cwd, 'add.cjs'), options.wrongImplementation ? WRONG_ADD_JS : ADD_JS, 'utf8');
        changedFiles = ['add.cjs'];
        output = `OUT_coder: wrote add.cjs`;
      } else if (role === 'tester') {
        writeFileSync(join(cwd, 'add.test.cjs'), ADD_TEST_JS, 'utf8');
        changedFiles = ['add.test.cjs'];
        output = `OUT_tester: wrote add.test.cjs`;
      } else { throw new Error(`fixture worker saw an unexpected role: ${String(role)} in prompt`); }
      const toolCalls: ToolCall[] = changedFiles.map((p, i) => ({ name: 'write', callId: `c${runIdx}-${i}`, status: 'ok', input: { filePath: p }, output: 'written' }));
      const result: RunResult = {
        taskId: `t${runIdx}`, threadId: null, agentId: req.agentId, state: 'succeeded',
        startedAt: Date.now(), endedAt: Date.now(), exitCode: 0, signal: null,
        output, outputTruncated: false, transcriptPath: null, usage: {}, toolCalls, error: null, diagnostics: [],
        cleanup: { rootKilled: false, descendantsReaped: false, note: '', treeStopConfirmed: true, processStart: 'started' },
      };
      return { result: async () => result } as unknown as RunHandle;
    },
  };

  const fetchImpl = makeLayaFetch(options.wait ? 'wait' : 'continue');
  const probesRead = { n: 0 };
  const checkpointCalls = { n: 0 };
  const revocationTrace: string[] = [];
  let revocationScheduled = false;

  const overrides: Record<string, unknown> = {
    roundResultDir: reportDir, layaFetchImpl: fetchImpl.impl,
    checkpointInput: (snapshot: WorkflowCheckpointSnapshot) => {
      checkpointCalls.n += 1;
      if (options.checkpointInput !== undefined) return options.checkpointInput(snapshot);
      throw new Error('unexpected checkpoint input in machine-auto stage');
    },
  };
  const baseProbes = [probeFor(AGENT_A, WORKER_MODEL)];
  Object.defineProperty(overrides, 'probes', { enumerable: true, configurable: true, get() {
    probesRead.n += 1;
    if (options.revokeBeforeSend && !revocationScheduled) {
      revocationScheduled = true;
      revocationTrace.push('probe-read');
      // Cross the existing buildQuotaCenter await before the classification send.
      queueMicrotask(() => {
        writeFileSync(join(cwd, 'stage.json'), JSON.stringify({ ...STAGE, acceptance: 'Owner revoked the approved acceptance during async preparation' }), 'utf8');
        revocationTrace.push('revoked-after-yield');
      });
    }
    return baseProbes;
  } });

  const argv: string[] = [
    OBJECTIVE, '--json', '--cwd', cwd, '--max-children', '4', '--max-concurrent', '1', '--retry-max', '0',
    '--workflow', 'sequential', '--workflow-plan', 'plans.json', '--workflow-choice', PLAN_ID,
    '--stage', 'stage.json', '--select', 'fixed', '--agent', AGENT_A, '--model', WORKER_MODEL,
    '--no-handoff', '--laya-post-max', String(options.maxLayaPosts ?? 3), '--model-pool', 'pool.json',
    ...(options.checkpointInput === undefined ? [] : ['--checkpoint']),
  ];

  const sc = await runCli(drivable, [...argv, '--stage-check'], overrides as unknown as RoundCliOverrides);
  const stageCheckPosts = fetchImpl.posts().length;
  const stageCheckRequests = requests.length;
  const stageCheckReviews = reviewRequests.length;
  if (sc.exit !== 0) {
    return { exitCode: sc.exit, confirmed: false, stageCheckExit: sc.exit, stageCheckReport: sc.report, stageCheckPosts, stageCheckRequests, stageCheckReviews, report: sc.report, requests, reviewRequests, cwd, storeDir, reportDir, fetchPosts: stageCheckPosts, fetchGets: fetchImpl.gets().length, probesRead: probesRead.n, checkpointCalls: checkpointCalls.n, revocationTrace };
  }
  const digest = String(sc.report.digest);
  let modeMismatch: CaseResult['modeMismatch'];
  if (options.checkpointInput !== undefined) {
    const auto = await runCli(drivable, [...argv.filter((arg) => arg !== '--checkpoint'), '--stage-check'], overrides as unknown as RoundCliOverrides);
    if (auto.exit !== 0) throw new Error(`machine-mode stage-check failed: ${auto.stdout}`);
    const bad = await runCli(drivable, [...argv, '--confirm', String(auto.report.digest)], overrides as unknown as RoundCliOverrides);
    modeMismatch = {
      autoMode: (auto.report.authorization as { mode: string }).mode,
      autoDigest: auto.report.digest, checkpointDigest: sc.report.digest,
      exitCode: bad.exit, report: bad.report,
      posts: fetchImpl.posts().length, workerRuns: requests.length, reviewRuns: reviewRequests.length,
      checkpointCalls: checkpointCalls.n, probesRead: probesRead.n,
    };
  }
  const r = await runCli(drivable, [...argv, '--confirm', digest], overrides as unknown as RoundCliOverrides);
  return {
    exitCode: r.exit, confirmed: true, stageCheckExit: sc.exit, stageCheckReport: sc.report,
    stageCheckPosts, stageCheckRequests, stageCheckReviews,
    report: r.report, requests, reviewRequests, cwd, storeDir, reportDir,
    fetchPosts: fetchImpl.posts().length, fetchGets: fetchImpl.gets().length, probesRead: probesRead.n, checkpointCalls: checkpointCalls.n, revocationTrace, modeMismatch, reviewOutputDirectory,
  };
}

function machineOf(r: CaseResult): {
  source?: unknown; enabled?: unknown; digest?: unknown; workflowStop?: unknown;
  completed?: Array<{ taskId: string; attemptId: string | null; sessionId: string | null; agentId: string; modelId: string | null; source: string; outcome: string; code: string }>;
  refused?: unknown[]; stop?: unknown;
} {
  return (r.report.machineSupervision ?? {}) as never;
}

function diag(r: CaseResult): string {
  return JSON.stringify({
    exit: r.exitCode, stage: r.report.stage ?? null, error: r.report.error ?? null,
    pending: r.report.pending ?? null, decision: r.report.decision ?? null,
    unassigned: r.report.unassigned ?? null, executionIncomplete: r.report.executionIncomplete ?? null,
    machineSupervision: r.report.machineSupervision ?? null,
  });
}

function savedAttentionMatches(report: Record<string, unknown>): boolean {
  const published = report.roundResultPublished as { ok: boolean; path: string } | undefined;
  if (published?.ok !== true || !existsSync(published.path)) return false;
  const saved = JSON.parse(readFileSync(published.path, 'utf8')) as { kind?: string; pendingUser?: PendingUserSummary };
  return saved.pendingUser !== undefined && JSON.stringify(saved.pendingUser) === JSON.stringify(report.pendingUser) &&
    (report.roundResult !== undefined || saved.kind === 'pre-execution-attention');
}

function checkAttention(label: string, report: Record<string, unknown>, code: string): void {
  const memo = report.pendingUser as PendingUserSummary | undefined;
  check(`${label}: attention preserves system cause without inventing acceptance or recovery`,
    memo?.source === 'system' && memo.attentionRequired === true && memo.code === code &&
    memo.resumeSupported === false && memo.stopSafetyCertified === false && typeof memo.stageDigest === 'string', JSON.stringify(memo));
  check(`${label}: the existing publisher really saved the same attention material`, savedAttentionMatches(report),
    JSON.stringify(report.roundResultPublished));
}

// ============================================================================
// suite — success and bounded negatives
// ============================================================================

async function caseA(): Promise<void> {
  section('A: two independent tasks auto-advance; two REAL approved tests ran; review passes');
  const r = await harness();
  const ms = machineOf(r);

  check('A: the CLI returned 0', r.exitCode === 0, diag(r));
  check('A: stage-check succeeded with no POST/worker/review', r.stageCheckExit === 0 && r.confirmed === true && r.stageCheckPosts === 0 && r.stageCheckRequests === 0 && r.stageCheckReviews === 0, `stageCheckExit=${r.stageCheckExit} posts=${r.stageCheckPosts} req=${r.stageCheckRequests} rev=${r.stageCheckReviews}`);
  check('A: ok=true and executionIncomplete=false', r.report.ok === true && r.report.executionIncomplete === false, diag(r));
  check('A: exactly two worker runs (one per step)', r.requests.length === 2, diag(r));
  check('A: one fake Review was dispatched exactly once', r.reviewRequests.length === 1, `rev=${r.reviewRequests.length}`);
  check('A: the unified review completed and passed', (r.report.unifiedReview as { status?: string } | undefined)?.status === 'completed' && (r.report.unifiedReview as { verdict?: string } | undefined)?.verdict === 'pass', JSON.stringify(r.report.unifiedReview));
  const reviewReq = r.reviewRequests[0];
  const reviewExtraArgs = reviewReq?.extraArgs ?? [];
  check('A: the actual Review request carries output schema/last-message and a read-only sandbox',
    reviewExtraArgs.includes('--output-schema') && reviewExtraArgs.includes('--output-last-message') && reviewReq?.sandbox === 'read-only',
    JSON.stringify({ extraArgs: reviewExtraArgs, sandbox: reviewReq?.sandbox }));
  check('A: the production Review owned its output directory and removed it after completing',
    typeof r.reviewOutputDirectory === 'string' && !existsSync(r.reviewOutputDirectory),
    JSON.stringify({ outputDirectory: r.reviewOutputDirectory }));
  check('A: exactly three LAYA POSTs (classify + two continue), no fourth', r.fetchPosts === 3, `posts=${r.fetchPosts}`);
  check('A: the probes getter was read at the pre-classify seam', r.probesRead >= 1, `probesRead=${r.probesRead}`);
  check('A: no checkpoint input was consumed and report.checkpoints is absent', r.checkpointCalls === 0 && !Object.prototype.hasOwnProperty.call(r.report, 'checkpoints'), `calls=${r.checkpointCalls} hasCheckpoints=${Object.prototype.hasOwnProperty.call(r.report, 'checkpoints')}`);

  // ---- the REAL on-disk bytes (not the fake worker's prose) ----
  const addText = existsSync(join(r.cwd, 'add.cjs')) ? readFileSync(join(r.cwd, 'add.cjs'), 'utf8') : '';
  const testText = existsSync(join(r.cwd, 'add.test.cjs')) ? readFileSync(join(r.cwd, 'add.test.cjs'), 'utf8') : '';
  check('A: add.cjs on disk is EXACTLY the delivered bytes', addText === ADD_JS, filesUnder(r.cwd).join(','));
  check('A: add.test.cjs on disk is EXACTLY the alone-written test bytes', testText === ADD_TEST_JS, filesUnder(r.cwd).join(','));

  // ---- the two approved tests' OWN run facts (markers the fake worker never writes) ----
  const coderMarker = existsSync(join(r.cwd, MARKER_CODER)) ? readFileSync(join(r.cwd, MARKER_CODER), 'utf8') : '';
  const testerMarker = existsSync(join(r.cwd, MARKER_TESTER)) ? readFileSync(join(r.cwd, MARKER_TESTER), 'utf8') : '';
  check('A: the step-1 approved node test REALLY ran (marker content exact)', coderMarker === 'STEP1_TEST_RAN', `marker=${JSON.stringify(coderMarker)}`);
  check('A: the step-2 approved node test REALLY ran (marker content exact)', testerMarker === 'STEP2_TEST_RAN', `marker=${JSON.stringify(testerMarker)}`);

  // ---- the machine supervision record, as direct field facts ----
  check('A: machine supervision source=system and enabled', ms.source === 'system' && ms.enabled === true, JSON.stringify({ source: ms.source, enabled: ms.enabled }));
  check('A: machine supervision binds the confirmed digest', ms.digest === r.stageCheckReport.digest && typeof ms.digest === 'string', JSON.stringify({ digest: ms.digest, stageDigest: r.stageCheckReport.digest }));
  const completed = ms.completed ?? [];
  check('A: exactly two machine-completed entries', completed.length === 2, JSON.stringify(completed));
  check('A: every completion is a system-source completion', completed.every((e) => e.source === 'system' && e.outcome === 'completed' && e.code === 'completed'), JSON.stringify(completed));
  check('A: the fixed worker pair is named on both completions', completed.every((e) => e.agentId === AGENT_A && e.modelId === WORKER_MODEL), JSON.stringify(completed.map((e) => `${e.agentId}/${e.modelId}`)));
  check('A: two DIFFERENT non-null task ids', completed.length === 2 && completed.every((e) => typeof e.taskId === 'string' && e.taskId !== '') && new Set(completed.map((e) => e.taskId)).size === 2, JSON.stringify(completed.map((e) => e.taskId)));
  check('A: two DIFFERENT non-null attempt ids', completed.length === 2 && completed.every((e) => e.attemptId !== null && e.attemptId !== '') && new Set(completed.map((e) => String(e.attemptId))).size === 2, JSON.stringify(completed.map((e) => e.attemptId)));
  check('A: two DIFFERENT non-null session ids', completed.length === 2 && completed.every((e) => e.sessionId !== null && e.sessionId !== '') && new Set(completed.map((e) => String(e.sessionId))).size === 2, JSON.stringify(completed.map((e) => e.sessionId)));
  check('A: no machine refusal was recorded', (ms.refused ?? []).length === 0 && ms.stop === null, JSON.stringify({ refused: ms.refused, stop: ms.stop }));
  check('A: workflowStop is all-succeeded', ms.workflowStop === 'all-succeeded', `workflowStop=${String(ms.workflowStop)}`);

  // ---- no fabricated human accept (a direct field fact, not a string scan) ----
  const anyUserSource = completed.some((e) => (e as { source?: string }).source === 'user') || (ms.refused ?? []).some((e) => (e as { source?: string }).source === 'user');
  check('A: no completion was fabricated as a human acceptance', !anyUserSource && !Object.prototype.hasOwnProperty.call(r.report, 'checkpoints'), JSON.stringify({ anyUserSource, hasCheckpoints: Object.prototype.hasOwnProperty.call(r.report, 'checkpoints') }));
  check('A: a clean successful round has no pending-user memo', !Object.prototype.hasOwnProperty.call(r.report, 'pendingUser'));
}

async function caseB(): Promise<void> {
  section('B: approval revoked after async preparation, before the real transport');
  const r = await harness({ revokeBeforeSend: true });
  const gate = r.report.layaSendGate as { enabled?: boolean; attempts?: number; refusals?: string[] } | undefined;
  const budget = r.report.layaPostBudget as { reserved?: number; used?: number } | undefined;
  check('B: stage-check really succeeded before revocation', r.confirmed && r.stageCheckExit === 0 && r.stageCheckPosts === 0 && r.stageCheckRequests === 0 && r.stageCheckReviews === 0, diag(r));
  check('B: revocation happened in the queued preparation microtask', r.revocationTrace.join(',') === 'probe-read,revoked-after-yield', JSON.stringify(r.revocationTrace));
  check('B: the rejection came from the real pre-send gate', r.exitCode === 1 && r.report.ok === false && r.report.stage === 'classify' && gate?.enabled === true && gate.attempts === 0 && gate.refusals?.length === 1 && gate.refusals[0]!.includes('approval-revoked: the stage material file changed'), diag(r));
  check('B: classification reserved its request before the gate refused it', budget?.reserved === 1 && budget.used === 1, JSON.stringify(budget));
  check('B: the underlying fetch received ZERO POSTs', r.fetchPosts === 0, `posts=${r.fetchPosts}`);
  check('B: no Worker or Reviewer was dispatched', r.requests.length === 0 && r.reviewRequests.length === 0, diag(r));
  check('B: no task report or implementation artifact was manufactured', !Object.prototype.hasOwnProperty.call(r.report, 'tasks') && !existsSync(join(r.cwd, 'add.cjs')) && !existsSync(join(r.cwd, 'add.test.cjs')), filesUnder(r.cwd).join(','));
  check('B: no checkpoint input or human acceptance was consumed', r.checkpointCalls === 0 && !Object.prototype.hasOwnProperty.call(r.report, 'checkpoints'), diag(r));
  checkAttention('B', r.report, 'approval-revoked');
  const memo = r.report.pendingUser as PendingUserSummary;
  check('B: pre-execution refusal keeps task/Attempt/Session/stop identity unknown', memo.taskId === null &&
    memo.currentAttemptId === null && memo.currentSessionId === null && memo.workerTreeStopConfirmed === null &&
    !Object.prototype.hasOwnProperty.call(r.report, 'roundResult'), JSON.stringify(memo));
}

async function caseC(): Promise<void> {
  section('C: two successful tasks, requested Review denied, real child exits NONZERO');
  const launcher = launcherFor(process.execPath);
  if (!launcher.ok) throw new Error(launcher.reason);
  const lines: string[] = [];
  const proc = new ManagedProcess({
    launcher: launcher.launcher,
    args: ['--import', pathToFileURL(fileURLToPath(new URL('./helpers/offline-context.mjs', import.meta.url))).href, fileURLToPath(import.meta.url), '--p02-review-withheld-child'],
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { P02_REVIEW_WITHHELD_CHILD: '1' },
    onStdoutLine: (line) => lines.push(line),
  });
  const timer = setTimeout(() => { void proc.cancel('P02 withheld-review child deadline'); }, 30000);
  let exit;
  try { exit = await proc.exited; await proc.settleCleanup(); }
  finally {
    clearTimeout(timer);
    if (!proc.isTreeStopConfirmed()) { await proc.cancel('P02 withheld-review child cleanup'); await proc.settleCleanup(); }
  }
  const line = lines.find((text) => text.startsWith('P02_REVIEW_CHILD '));
  const payload = line === undefined ? undefined : JSON.parse(line.slice('P02_REVIEW_CHILD '.length)) as {
    exitCode: number; report: Record<string, unknown>; workerRuns: number; reviewRuns: number;
    coderMarker: string; testerMarker: string; checkpointCalls: number; posts: number;
    cleanupFailures: string[]; fatal: string | null; attentionSaved: boolean;
  };
  check('C: real child exited 1 without a terminating signal', exit?.code === 1 && exit.signal === null, JSON.stringify({ exit, stderr: proc.stderrTail.toString() }));
  check('C: child reached the real CLI result, without an unrelated crash', payload !== undefined && payload.exitCode === 1 && payload.fatal === null && payload.cleanupFailures.length === 0, JSON.stringify(payload));
  if (payload !== undefined) {
    const report = payload.report;
    const machine = report.machineSupervision as { workflowStop?: string; completed?: unknown[]; reviewNotClean?: boolean };
    const review = report.unifiedReview as { status?: string; code?: string; verdict?: unknown; reason?: string };
    check('C: both real machine verifications succeeded before Review was withheld', payload.workerRuns === 2 && machine.workflowStop === 'all-succeeded' && machine.completed?.length === 2 && report.executionIncomplete === false, JSON.stringify(machine));
    check('C: both approved Node tests REALLY executed', payload.coderMarker === 'STEP1_TEST_RAN' && payload.testerMarker === 'STEP2_TEST_RAN', JSON.stringify({ coder: payload.coderMarker, tester: payload.testerMarker }));
    check('C: requested Review was refused specifically by model-pool admission', payload.reviewRuns === 0 && review.status === 'execution_incomplete' && review.code === 'machine-supervision-not-run' && review.verdict === null && review.reason?.includes('not currently admitted by the user model pool') === true, JSON.stringify(review));
    const memo = report.pendingUser as PendingUserSummary | undefined;
    check('C: withheld Review has a saved attention memo, not a borrowed Worker identity', payload.attentionSaved &&
      memo?.code === 'machine-supervision-not-run' && memo.taskId === null && memo.currentAttemptId === null &&
      memo.currentSessionId === null && memo.resumeSupported === false, JSON.stringify(memo));
    check('C: printed JSON failure agrees with returned and actual child exit', report.ok === false && machine.reviewNotClean === true && payload.exitCode === exit?.code, JSON.stringify({ ok: report.ok, returned: payload.exitCode, actual: exit?.code }));
    check('C: no extra decision or checkpoint was consumed', payload.posts === 3 && payload.checkpointCalls === 0 && !Object.prototype.hasOwnProperty.call(report, 'checkpoints'), JSON.stringify({ posts: payload.posts, checkpointCalls: payload.checkpointCalls }));
  }
  check('C: contained child tree was confirmed stopped with an empty Job', proc.isTreeStopConfirmed() && proc.containment?.activeProcessesFinal === 0, JSON.stringify(proc.containment));
}

// ============================================================================
// D: the fake Worker succeeds, but the REAL approved test rejects its calculation.
// ============================================================================

async function caseD(): Promise<void> {
  section('D: first approved test exits 1; machine gate blocks the next task');
  const r = await harness({ wrongImplementation: true });
  const ms = machineOf(r);
  const tasks = r.report.tasks as Array<{ taskId: string; type: string; status: string }>;
  const dispatched = (r.report.decision as { dispatchedTasks: string[] }).dispatchedTasks;
  const coder = tasks.find((task) => task.type === 'implementation' && dispatched.includes(task.taskId));
  const tester = tasks.find((task) => task.type === 'test');
  const refused = ms.refused as Array<{ taskId: string; attemptId: string | null; sessionId: string | null; source: string; code: string; reason: string }>;
  const stop = ms.stop as { taskId: string; code: string; blockedTaskIds: string[] } | null;
  const review = r.report.unifiedReview as { status: string; verdict: unknown };

  check('D: stage-check succeeded without executing anything', r.confirmed && r.stageCheckExit === 0 && r.stageCheckPosts === 0 && r.stageCheckRequests === 0 && r.stageCheckReviews === 0, diag(r));
  check('D: only the implementation Worker ran', r.requests.length === 1 && roleOf(r.requests[0]!.prompt) === 'coder', diag(r));
  check('D: the wrong calculation was really delivered at the correct path', existsSync(join(r.cwd, 'add.cjs')) && readFileSync(join(r.cwd, 'add.cjs'), 'utf8') === WRONG_ADD_JS, filesUnder(r.cwd).join(','));
  check('D: the real completion authority rejected the approved test exit 1', refused.length === 1 && refused[0]!.code === 'completion-test-nonzero' && refused[0]!.reason === 'the approved test exited 1 (not 0)', JSON.stringify(refused));
  check('D: the refusal binds the executed task, Attempt and Session', coder !== undefined && refused[0]?.taskId === coder.taskId && typeof refused[0]?.attemptId === 'string' && refused[0].attemptId.length > 0 && typeof refused[0]?.sessionId === 'string' && refused[0].sessionId.length > 0 && refused[0].source === 'system', JSON.stringify(refused));
  check('D: machine verification stopped before a downstream dispatch', ms.workflowStop === 'machine-verification-stop' && (ms.completed ?? []).length === 0 && stop?.taskId === coder?.taskId && stop?.code === 'completion-test-nonzero' && tester !== undefined && stop.blockedTaskIds.includes(tester.taskId), diag(r));
  check('D: neither task was marked succeeded', coder !== undefined && tester !== undefined && coder.status !== 'succeeded' && tester.status !== 'succeeded', JSON.stringify(tasks));
  check('D: no downstream test file or success marker was manufactured', !existsSync(join(r.cwd, 'add.test.cjs')) && !existsSync(join(r.cwd, MARKER_CODER)) && !existsSync(join(r.cwd, MARKER_TESTER)), filesUnder(r.cwd).join(','));
  check('D: no Reviewer was run or assigned a verdict', r.reviewRequests.length === 0 && review.status === 'execution_incomplete' && review.verdict === null, JSON.stringify(review));
  check('D: the round reports failure and incomplete execution', r.exitCode === 1 && r.report.ok === false && r.report.executionIncomplete === true, diag(r));
  check('D: failure caused no further decision or human-input fallback', r.fetchPosts === 2 && r.checkpointCalls === 0 && !Object.prototype.hasOwnProperty.call(r.report, 'checkpoints'), diag(r));
  checkAttention('D', r.report, 'completion-test-nonzero');
  const memo = r.report.pendingUser as PendingUserSummary;
  check('D: test refusal memo belongs to the actually dispatched coder Attempt/Session',
    memo.taskId === coder?.taskId && memo.currentAttemptId !== null && memo.currentSessionId !== null &&
    memo.workerTreeStopConfirmed === true && memo.displayedAttemptId === null, JSON.stringify(memo));
}

// ============================================================================
// E: wait crosses the real Provider and CLI, never a fabricated final report.
// ============================================================================

async function caseE(): Promise<void> {
  section('E: typed wait is preserved; no Worker, Review or human acceptance');
  const r = await harness({ wait: true });
  const ms = machineOf(r);
  const decision = r.report.decision as { action: string; via: string; code: string; applied: boolean; dispatched: boolean; dispatchedTasks: string[] };
  const tasks = r.report.tasks as Array<{ status: string }>;
  const review = r.report.unifiedReview as { status: string; verdict: unknown };
  const budget = r.report.layaPostBudget as { max: number; used: number; rejected: boolean };
  const gate = r.report.layaSendGate as { refusals: string[] };

  check('E: stage-check passed without POST, Worker or Review', r.confirmed && r.stageCheckExit === 0 && r.stageCheckPosts === 0 && r.stageCheckRequests === 0 && r.stageCheckReviews === 0, diag(r));
  check('E: the real typed decision and application both preserve wait', decision.action === 'wait' && decision.via === 'wait' && decision.code === 'decision-wait' && decision.applied === false && decision.dispatched === false, JSON.stringify(decision));
  check('E: the bounded workflow stopped for no progress, not an unrelated failure', r.report.stage === 'complete' && ms.workflowStop === 'no-progress', diag(r));
  check('E: neither Worker nor Reviewer was dispatched', r.requests.length === 0 && r.reviewRequests.length === 0, diag(r));
  check('E: actual Attempt history reports no dispatched task', decision.dispatchedTasks.length === 0, JSON.stringify(decision));
  check('E: no task or machine completion was fabricated', tasks.length > 0 && tasks.every((task) => task.status !== 'succeeded') && (ms.completed ?? []).length === 0, JSON.stringify({ tasks, machine: ms }));
  check('E: no implementation, test or approved-test success marker exists', ['add.cjs', 'add.test.cjs', MARKER_CODER, MARKER_TESTER].every((file) => !existsSync(join(r.cwd, file))), filesUnder(r.cwd).join(','));
  check('E: no checkpoint input or user acceptance was invented', r.checkpointCalls === 0 && !Object.prototype.hasOwnProperty.call(r.report, 'checkpoints') && ms.source === 'system', diag(r));
  check('E: unexecuted Review holds no verdict', review.status === 'execution_incomplete' && review.verdict === null, JSON.stringify(review));
  check('E: unfinished wait is reported as failure, not completion', r.exitCode === 1 && r.report.ok === false && r.report.executionIncomplete === true, diag(r));
  check('E: decisions stay within budget without a budget or send-gate refusal', r.fetchPosts > 0 && r.fetchPosts <= 3 && budget.max === 3 && budget.used === r.fetchPosts && budget.rejected === false && gate.refusals.length === 0, JSON.stringify({ posts: r.fetchPosts, budget, gate }));
  checkAttention('E', r.report, 'decision-wait');
  const memo = r.report.pendingUser as PendingUserSummary;
  check('E: wait remains a bounded stop with no invented execution identity', memo.taskId === null && memo.currentAttemptId === null &&
    memo.currentSessionId === null && memo.workerTreeStopConfirmed === null &&
    String(r.report.roundResultReport).includes('OWNER ATTENTION REQUIRED'), JSON.stringify(memo));
}

async function caseG(): Promise<void> {
  section('G: zero/mid-round POST budget refusals preserve attention and real dispatch limits');
  for (const max of [0, 2]) {
    const r = await harness({ maxLayaPosts: max });
    const budget = r.report.layaPostBudget as { max: number; used: number; rejected: boolean };
    checkAttention(`G${max}`, r.report, 'DECISION_POST_BUDGET_EXHAUSTED');
    check(`G${max}: no over-budget POST, Review, retry or human input`, r.exitCode === 1 && r.report.ok === false &&
      budget.max === max && budget.used === max && budget.rejected === true && r.fetchPosts === max &&
      r.requests.length === (max === 0 ? 0 : 1) && r.reviewRequests.length === 0 && r.checkpointCalls === 0, diag(r));
    const memo = r.report.pendingUser as PendingUserSummary;
    check(`G${max}: budget refusal borrows no previous execution identity`, memo.taskId === null &&
      memo.currentAttemptId === null && memo.currentSessionId === null && memo.workerTreeStopConfirmed === null, JSON.stringify(memo));
    check(`G${max}: only actually delivered work remains`, max === 0
      ? !Object.prototype.hasOwnProperty.call(r.report, 'tasks') && !existsSync(join(r.cwd, 'add.cjs'))
      : existsSync(join(r.cwd, 'add.cjs')) && existsSync(join(r.cwd, MARKER_CODER)) && !existsSync(join(r.cwd, 'add.test.cjs')),
    filesUnder(r.cwd).join(','));
  }
}

async function caseH(): Promise<void> {
  section('H: completed Review with reject/rework is never a successful round');
  for (const verdict of ['reject', 'rework'] as const) {
    const r = await harness({ reviewVerdict: verdict });
    const review = r.report.unifiedReview as { status: string; verdict: string };
    checkAttention(`H-${verdict}`, r.report, `review-${verdict}`);
    check(`H-${verdict}: the real Review result is preserved and fails the outer result`,
      review.status === 'completed' && review.verdict === verdict && r.report.ok === false && r.exitCode === 1 &&
      (r.report.machineSupervision as { reviewNotClean: boolean }).reviewNotClean === true, JSON.stringify(review));
    check(`H-${verdict}: exactly two Workers and one Review, with no extra execution`, r.requests.length === 2 &&
      r.reviewRequests.length === 1 && r.fetchPosts === 3 && r.checkpointCalls === 0, diag(r));
  }
}

// ============================================================================
// F: a controlled stop answer proves flag precedence, not a genuine Owner acceptance.
// ============================================================================

async function caseF(): Promise<void> {
  section('F: confirmed stage plus explicit checkpoint consumes a stop, never auto-completes');
  const snapshots: WorkflowCheckpointSnapshot[] = [];
  const reason = 'fixture requests inspection before the next task';
  const r = await harness({ checkpointInput: (snapshot) => { snapshots.push(snapshot); return `stop ${reason}`; } });
  check('F: stage-check binds checkpoint mode without any execution', r.confirmed && r.stageCheckExit === 0 && r.stageCheckPosts === 0 && r.stageCheckRequests === 0 && r.stageCheckReviews === 0 && (r.stageCheckReport.authorization as { mode?: string } | undefined)?.mode === 'checkpoint', JSON.stringify(r.stageCheckReport));
  if (!r.confirmed) return;
  const ms = machineOf(r);
  const cp = r.report.checkpoints as {
    prompts: number;
    entries: Array<WorkflowCheckpointSnapshot & { source: string; choice: string; stopReason: string; acceptOutcome: unknown }>;
    stop: { taskId: string; reason: string; blockedTaskIds: string[] } | null;
  };
  const shown = snapshots[0];
  const entry = cp.entries[0];
  const tasks = r.report.tasks as Array<{ taskId: string; type: string; status: string }>;
  const coder = tasks.find((task) => task.taskId === shown?.taskId);
  const tester = tasks.find((task) => task.type === 'test');
  const review = r.report.unifiedReview as { status: string; verdict: unknown };

  const mismatch = r.modeMismatch;
  check('F: otherwise identical supervision modes have different approval digests', mismatch?.autoMode === 'machine-auto' && typeof mismatch.autoDigest === 'string' && typeof mismatch.checkpointDigest === 'string' && mismatch.autoDigest !== mismatch.checkpointDigest, JSON.stringify(mismatch));
  check('F: a machine-mode digest is refused before any checkpoint-mode execution', mismatch?.exitCode === 2 && mismatch.report.stage === 'stage-gate' && String(mismatch.report.error).includes('confirmation does not match this material AND plan') && mismatch.posts === 0 && mismatch.workerRuns === 0 && mismatch.reviewRuns === 0 && mismatch.checkpointCalls === 0 && mismatch.probesRead === 0, JSON.stringify(mismatch));
  check('F: the real checkpoint callback was consumed exactly once', r.checkpointCalls === 1 && snapshots.length === 1 && cp.prompts === 1 && cp.entries.length === 1, JSON.stringify({ calls: r.checkpointCalls, cp }));
  check('F: only the implementation Worker executed', r.requests.length === 1 && roleOf(r.requests[0]!.prompt) === 'coder', diag(r));
  check('F: displayed identity matches the recorded task, Attempt and Session', shown !== undefined && shown.role === 'coder' && shown.status === 'to_verify' && shown.attemptId.length > 0 && typeof shown.sessionId === 'string' && shown.sessionId.length > 0 && shown.agentId === AGENT_A && shown.modelId === WORKER_MODEL && entry?.taskId === shown.taskId && entry.attemptId === shown.attemptId && entry.sessionId === shown.sessionId, JSON.stringify({ shown, entry }));
  check('F: the explicit stop reason is preserved without an accept', entry?.choice === 'stop' && entry.source === 'user' && entry.stopReason === reason && entry.acceptOutcome === null && cp.stop?.reason === reason && cp.stop.taskId === shown?.taskId, JSON.stringify(cp));
  check('F: explicit checkpoint disables machine auto-completion', ms.enabled === false && (ms.completed ?? []).length === 0 && ms.workflowStop === 'user-stop', diag(r));
  check('F: the displayed task remains unverified and the next task is blocked', coder?.status === 'to_verify' && tester !== undefined && tester.status !== 'succeeded' && cp.stop?.blockedTaskIds.includes(coder.taskId) === true && cp.stop.blockedTaskIds.includes(tester.taskId), JSON.stringify({ tasks, stop: cp.stop }));
  check('F: real implementation bytes survive, with no downstream artifact', existsSync(join(r.cwd, 'add.cjs')) && readFileSync(join(r.cwd, 'add.cjs'), 'utf8') === ADD_JS && !existsSync(join(r.cwd, 'add.test.cjs')) && !existsSync(join(r.cwd, MARKER_TESTER)), filesUnder(r.cwd).join(','));
  check('F: Review was withheld and has no verdict', r.reviewRequests.length === 0 && review.status === 'execution_incomplete' && review.verdict === null, JSON.stringify(review));
  check('F: stop reports incomplete failure without another decision', r.exitCode === 1 && r.report.ok === false && r.report.executionIncomplete === true && r.fetchPosts === 2, diag(r));
}

// ============================================================================
// P03-F1: a revocation that ONLY the post-Review FINAL approval check can catch must
// still reach the persisted user delivery. The stage material is changed inside the
// controlled Review callback, after both Workers and both REAL approved tests completed.
// ============================================================================

async function caseI(): Promise<void> {
  section('P03-F1: late approval revocation during Review still lands in the saved attention');
  const r = await harness({ revokeDuringReview: true });
  const ms = machineOf(r);
  const review = r.report.unifiedReview as { status?: string; verdict?: string | null; code?: string | null };
  const tasks = r.report.tasks as Array<{ taskId: string; type: string; status: string }>;

  check('P03-F1: stage-check succeeded with no POST/worker/review', r.confirmed && r.stageCheckExit === 0 && r.stageCheckPosts === 0 && r.stageCheckRequests === 0 && r.stageCheckReviews === 0, diag(r));
  check('P03-F1: both Workers really ran and both REAL approved tests executed', r.requests.length === 2 &&
    existsSync(join(r.cwd, MARKER_CODER)) && readFileSync(join(r.cwd, MARKER_CODER), 'utf8') === 'STEP1_TEST_RAN' &&
    existsSync(join(r.cwd, MARKER_TESTER)) && readFileSync(join(r.cwd, MARKER_TESTER), 'utf8') === 'STEP2_TEST_RAN', filesUnder(r.cwd).join(','));
  check('P03-F1: the machine workflow completed all-succeeded before the final check', ms.workflowStop === 'all-succeeded' && (ms.completed ?? []).length === 2 && ms.stop === null, JSON.stringify(ms));
  check('P03-F1: exactly one controlled Review ran and its legal pass is preserved', r.reviewRequests.length === 1 &&
    review.status === 'completed' && review.verdict === 'pass', JSON.stringify(review));
  const completedTaskIds = new Set((ms.completed ?? []).map((e) => e.taskId));
  check('P03-F1: the two completed Worker tasks keep their real succeeded state', completedTaskIds.size === 2 &&
    tasks.filter((t) => completedTaskIds.has(t.taskId)).every((t) => t.status === 'succeeded'), JSON.stringify(tasks));
  check('P03-F1: the round is nonzero and ok=false', r.exitCode === 1 && r.report.ok === false, diag(r));
  check('P03-F1: the final machine verdict names the late revocation', (r.report.machineSupervision as { finalOk?: boolean }).finalOk === false &&
    ((r.report.machineSupervision as { finalFailures?: string[] }).finalFailures ?? []).some((f) => f.includes('the stage material file changed')), JSON.stringify((r.report.machineSupervision as { finalFailures?: string[] }).finalFailures));
  checkAttention('P03-F1', r.report, 'approval-revoked');
  const memo = r.report.pendingUser as PendingUserSummary;
  check('P03-F1: a Round-level revocation keeps Task/Attempt/Session identity null', memo.taskId === null &&
    memo.currentAttemptId === null && memo.currentSessionId === null && memo.displayedAttemptId === null &&
    memo.workerTreeStopConfirmed === null, JSON.stringify(memo));
  check('P03-F1: the ORIGINAL approved stage digest is retained', memo.stageDigest === r.stageCheckReport.digest && typeof memo.stageDigest === 'string', JSON.stringify({ memoDigest: memo.stageDigest, approved: r.stageCheckReport.digest }));
  check('P03-F1: no extra dispatch, retry or human input', r.requests.length === 2 && r.reviewRequests.length === 1 &&
    r.fetchPosts === 3 && r.checkpointCalls === 0 && !Object.prototype.hasOwnProperty.call(r.report, 'checkpoints'), diag(r));
}

// ============================================================================
// entry
// ============================================================================

let fatal: unknown;

async function main(): Promise<void> {
  installOfflinePolicy();
  check('offline policy is frozen', isOfflineFrozen() === true);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('P02: the real global fetch is forbidden in this offline test'); }) as typeof fetch;
  try {
    if (REVIEW_CHILD) {
      const r = await harness({ withholdReview: true });
      reviewChildReport = {
        exitCode: r.exitCode, report: r.report, workerRuns: r.requests.length, reviewRuns: r.reviewRequests.length,
        coderMarker: existsSync(join(r.cwd, MARKER_CODER)) ? readFileSync(join(r.cwd, MARKER_CODER), 'utf8') : '',
        testerMarker: existsSync(join(r.cwd, MARKER_TESTER)) ? readFileSync(join(r.cwd, MARKER_TESTER), 'utf8') : '',
        checkpointCalls: r.checkpointCalls, posts: r.fetchPosts,
        attentionSaved: savedAttentionMatches(r.report),
      };
      process.exitCode = r.exitCode;
    } else {
      await caseA();
      await caseB();
      await caseC();
      await caseD();
      await caseE();
      await caseF();
      await caseG();
      await caseH();
      await caseI();
    }
  } catch (e) {
    fatal = e;
    process.stdout.write(`fatal: ${String((e as Error).message)}\n`);
  } finally {
    // Every owned dir is removed ONLY here, AFTER the assertions read the real files.
    globalThis.fetch = originalFetch;
  }
}

await main();

for (const d of ownedDirs) if (existsSync(d)) removeOwnedDir(d);

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
if (cleanupFailures.length) process.stdout.write(`cleanup failures (must fail the test):\n  ${cleanupFailures.map((f) => `- ${f}`).join('\n  ')}\n`);
if (fatal !== undefined) process.stdout.write(`fatal (must fail the test): ${String((fatal as Error).message)}\n`);
process.stdout.write('\n');
process.exitCode = failed === 0 && cleanupFailures.length === 0 && fatal === undefined ? (process.exitCode ?? 0) : 1;
if (REVIEW_CHILD) process.stdout.write(`P02_REVIEW_CHILD ${JSON.stringify({ ...reviewChildReport, cleanupFailures, fatal: fatal === undefined ? null : String((fatal as Error).message) })}\n`);
