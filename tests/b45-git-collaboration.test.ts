/**
 * tests/b45-git-collaboration.test.ts — B4.5: sequential collaboration in a GIT project.
 *
 * WHAT THIS PROVES (and what is real vs injected)
 * -----------------------------------------------
 * REAL: `runRoundCli` -> Workbench -> Assignment -> SessionRegistry -> TaskScheduler ->
 * `executeTask` -> WorkspaceManager (a REAL `git worktree`) -> the controlled runtime
 * and decision provider -> the existing Verification/review/report chain. A real git
 * repository is created under an owned temp directory for every scenario.
 *
 * INJECTED, and only these two:
 *   1. LAYA's ANSWERS (the real laya-serve is external). A controlled provider answers
 *      the same typed questions the production path asks, and accepts a task only when
 *      ITS OWN acceptance material shows its own execution produced its own deliverable.
 *   2. The RUNTIME side of each run. The `RuntimeRunner.run` seam is stubbed, but the
 *      stub WRITES into `req.cwd` — the REAL worktree path it was handed — and the
 *      integration stub READS the members' files back from that same worktree. So
 *      "the integrator consumed the members' deliveries" is checked on disk in the real
 *      worktree, not asserted from a prompt string.
 *
 * The suite is hermetic: it starts no real agent, and every directory it makes lives
 * under one owned parent (repo + default sibling worktrees + lock dir + store), which
 * is reclaimed at the end. A cleanup failure fails the suite.
 *
 * Run: node tests/b45-git-collaboration.test.ts
 */

import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

import { runRoundCli } from '../src/cli/round-cli.ts';
import { Orchestrator as RuntimeOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { Orchestrator as TaskOrchestrator } from '../src/orchestration/orchestrator.ts';
import {
  WorkspaceManager,
  normalizeScope,
  normalizeScopeForWorkspace,
  type ResourceClaim,
  type ResourceClaimMode,
  type ResourceScope,
} from '../src/orchestration/index.ts';
import { BudgetManager, ModelRegistry } from '../src/quota/index.ts';
import { createFakeAdapter } from './helpers.ts';
import type { RunHandle, RunRequest, RunResult, ToolCall, AgentDescriptor } from '../src/core/types.ts';
import type { DecisionProvider, DecisionRequest } from '../src/decision/types.ts';
import type { Task } from '../src/orchestration/task.ts';
import { INITIAL_AGENT_MODEL_ID, initialCandidateKey } from '../src/decision/initial-assignment.ts';
import { WORKFLOW_PLAN_ID } from '../src/decision/plan-choice.ts';
import { ACCEPTANCE_MATERIAL_FIELD, ORCHESTRATION_ACTION_ID } from '../src/orchestration/decision-loop.ts';
import type { QuotaProbe } from '../src/quota/index.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];
const tmpDirs: string[] = [];
const cleanupFailures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; process.stdout.write(`  ok   ${name}\n`); }
  else { failed++; failures.push(name); process.stdout.write(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}\n`); }
}
function section(t: string): void { process.stdout.write(`\n== ${t} ==\n`); }
function ownDir(): string { const d = mkdtempSync(join(tmpdir(), 'b45-')); tmpDirs.push(d); return d; }
function removeOwnedDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); }
  catch (e) { cleanupFailures.push(`owned dir removal threw for ${dir}: ${(e as Error).message}`); return; }
  if (existsSync(dir)) cleanupFailures.push(`owned dir ${dir} still present after removal`);
}

const AGENT_A = 'agent-a';
const AGENT_B = 'agent-b';
const REVIEWER = 'codex';
const CAPS = { newTask: true, review: true, modelSelection: true, cwd: true, resume: true, workspaceModes: ['shared', 'isolated'] } as never;

const ROUTING_ANSWERS: Record<string, string> = { work_kind: 'implementation', complexity: 'small' };

/** Run git, loudly, in `cwd`. */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/** A real committed git repo under an owned parent, plus its default worktree sibling. */
function makeCommittedRepo(): { parent: string; repo: string } {
  const parent = ownDir();
  const repo = join(parent, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'b45']);
  git(repo, ['config', 'user.email', 'b45@test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'base.txt'), 'base\n', 'utf8');
  writeFileSync(join(repo, 'tracked.txt'), 'committed\n', 'utf8');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'base']);
  return { parent, repo };
}

interface RepoState {
  head: string;
  status: string;
  diff: string;
  cached: string;
  indexSha: string;
  tracked: string;
  sentinel: string;
}

/** A byte-level snapshot of everything B4.5 must not disturb. */
function snapshotRepo(repo: string, sentinelRel: string): RepoState {
  return {
    head: git(repo, ['rev-parse', 'HEAD']).trim(),
    status: git(repo, ['status', '--porcelain=v1']),
    diff: git(repo, ['diff']),
    cached: git(repo, ['diff', '--cached']),
    indexSha: createHash('sha1').update(readFileSync(join(repo, '.git', 'index'))).digest('hex'),
    tracked: readFileSync(join(repo, 'tracked.txt'), 'utf8'),
    sentinel: readFileSync(join(repo, sentinelRel), 'utf8'),
  };
}

function answerFor(id: string, question: { type: string; criteria: unknown }, overrides: Record<string, string> = ROUTING_ANSWERS): Record<string, unknown> {
  if (question.type === 'choice') {
    const offered = Object.keys(question.criteria as Record<string, string>);
    const pick = offered.includes(overrides[id] ?? '') ? overrides[id]! : offered[0]!;
    const probabilities: Record<string, number> = {};
    for (const o of offered) probabilities[o] = o === pick ? 1 : 0;
    return { type: 'choice', choice: pick, probabilities, confidence: 1 };
  }
  if (question.type === 'score') {
    const levels = question.criteria as string[];
    const index = Math.max(0, levels.indexOf(overrides[id] ?? 'small'));
    const probabilities: Record<string, number> = {};
    for (let i = 0; i < levels.length; i++) probabilities[String(i)] = i === index ? 1 : 0;
    const legend: Record<string, string> = {};
    for (let i = 0; i < levels.length; i++) legend[String(i)] = levels[i]!;
    return { type: 'score', score: index, level: levels[index]!, levels: [...levels], probabilities, legend, confidence: 1 };
  }
  if (question.type === 'noul') return { type: 'noul', noul: 1 };
  return { type: question.type };
}

function probeFor(agentId: string, modelId: string): QuotaProbe {
  return {
    agentId, provider: agentId,
    records: [{ provider: agentId, agentId, modelId: null, source: 'locally_observed', usage: null, remaining: null, resetAt: null, period: 'day', status: 'available', usageClass: 'observed', confidence: 'high', observedAt: Date.now(), note: '' }],
    login: 'stubbed for test', version: '0.0.0-test', modelHint: modelId, providerHint: null, error: null,
  } as unknown as QuotaProbe;
}

interface MemberRow { index: number; taskId: string; role: string; fileScope: string; status: string; assigned: boolean; ran: boolean; agentId: string | null; modelId: string | null; pair: string | null; sessionId: string | null }
interface WorkspaceRow { owner?: string | null; path?: string | null; branch?: string | null; baseSha?: string | null; note?: string }
interface CollabView { members: MemberRow[]; integrator: { taskId: string; memberTaskId: string; status: string; agentId: string | null; modelId: string | null; sessionId: string | null }; distinctPairs: number; pairIsDistinct: boolean; integratorReusesMemberPair: boolean; choice: string; workspace?: WorkspaceRow }
interface Round {
  report: Record<string, unknown>;
  requests: RunRequest[];
  reviewRequests: RunRequest[];
  decisionRequests: DecisionRequest[];
  repo: string;
  parent: string;
  maxConcurrentRuns: number;
  exitCode: number;
  before: RepoState | null;
  after: RepoState | null;
  /**
   * B4.5a: the ResourceClaims the PRODUCTION WorkspaceManager actually RETAINED this round,
   * captured through its own `retainResourceProtection` / `retainedResourceProtections` API.
   * Empty unless the caller opted in with `captureRetained`. This is the real book's contents,
   * never a test-written flag.
   */
  retainedClaims: ResourceClaim[];
  /** B4.5a: the production WorkspaceManager instance, once `captureRetained` was used. */
  workspaceManager: WorkspaceManager | null;
}

function filesUnder(root: string, prefix = ''): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = join(root, rel);
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel === '' ? entry.name : `${rel}${sep}${entry.name}`;
      if (entry.isDirectory()) walk(childRel);
      else out.push(childRel.split(sep).join('/'));
    }
  };
  walk(prefix);
  return out;
}
const dirHas = (root: string): string => filesUnder(root).join(',') || '(empty)';

function memberRoleOf(prompt: string): { kind: 'member'; index: number; role: string; scope: string } | { kind: 'integration'; token: string } | null {
  const m = /:: collaborator (\d+) \(([\w-]+)\) — file scope: (\S+) — deliverable:/.exec(prompt);
  if (m !== null) return { kind: 'member', index: Number(m[1]), role: m[2]!, scope: m[3]! };
  const i = /:: integration \(collaborator (\d+) carries integration responsibility\)/.exec(prompt);
  if (i !== null) return { kind: 'integration', token: `integration (collaborator ${i[1]} carries integration responsibility)` };
  return null;
}

/**
 * P0-1: the built-in `duo`/`trio` groups now declare NO completion contract (the accepted
 * artifact set/scope/test are business acceptance only the USER can authorise). This
 * fixture supplies the SAME group shapes as an explicit user-approved plan FILE, with
 * contracts naming exactly the artifact the fixture runtime writes in the worktree
 * (`<scope>/<role>.txt`) plus the integration artifact.
 */
const member = (role: string, taskType: 'implementation' | 'test', scope: string) => ({
  role, taskType, fileScope: `${scope}/**`, deliverable: `the ${role} change, with the files it touched`,
  expectedArtifacts: [`${scope}/${role}.txt`], allowedScope: [scope],
  test: { executable: 'node', argv: ['-e', 'process.exit(0)'], cwd: '.' },
});
const B45_PLAN_FILE = {
  kind: 'collaborate',
  plans: [
    {
      id: 'duo', label: 'two models build the goal together, one of them integrates',
      members: [member('provider', 'implementation', 'src/provider'), member('consumer', 'implementation', 'src/consumer')],
      integratorMember: 1,
      integratorCompletion: { expectedArtifacts: ['src/integration/combined.txt'], allowedScope: ['src/integration'], test: { executable: 'node', argv: ['-e', 'process.exit(0)'], cwd: '.' } },
    },
    {
      id: 'trio', label: 'three models build the goal together, the middle one integrates',
      members: [member('core', 'implementation', 'src/core'), member('cli', 'implementation', 'src/cli'), member('checks', 'test', 'tests')],
      integratorMember: 2,
      integratorCompletion: { expectedArtifacts: ['src/integration/combined.txt'], allowedScope: ['src/integration'], test: { executable: 'node', argv: ['-e', 'process.exit(0)'], cwd: '.' } },
    },
  ],
};

/**
 * Run ONE real production round with `--workflow collaborate` against a REAL git repo.
 *
 * The runtime stub writes into `req.cwd` — the real worktree the WorkspaceManager handed
 * out — so the collaboration happens in the worktree, never the user checkout.
 */
async function collabRound(opts: {
  planChoice?: 'duo' | 'trio';
  pairs?: readonly (readonly [string, string])[];
  failMember?: number;
  /** Commit the base (needed for a worktree). `false` leaves an UNBORN repo. */
  committed?: boolean;
  /** Add staged + unstaged edits and an untracked sentinel to the user checkout. */
  dirty?: boolean;
  /**
   * Force worktree CREATION to fail deterministically: the default worktreeRoot is a
   * sibling of the repo, so making that path a FILE means `git worktree add` cannot
   * create the target directory. Used to prove "no fallback to the user cwd".
   */
  blockWorktreeRoot?: boolean;
  maxConcurrent?: number;
  objective?: string;
  /**
   * B4.5 (P1-2): run with `--cwd <repo>/<cwdSubdir>` — a REAL subdirectory of the repo,
   * NOT the repo root. Used to prove a nested cwd is refused before anything runs.
   */
  cwdSubdir?: string;
  /**
   * B4.5a: FAULT INJECTION. The integration (last) run reports an UNCONFIRMED tree stop
   * (`cleanup.treeStopConfirmed = false`); every earlier member reports a confirmed stop as
   * normal. Its logical output and the real combined file are still produced, so the failure
   * cannot be read as "the deliverable is missing" or "a prerequisite did not finish".
   */
  retainIntegratorStop?: boolean;
  /** B4.5a: pass `--no-review` (the physical-stop exemption is being exercised). */
  noReview?: boolean;
  /** B4.5a: capture the production WorkspaceManager's real retained claims via its own API. */
  captureRetained?: boolean;
} = {}): Promise<Round> {
  const parent = ownDir();
  const repo = join(parent, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'b45']);
  git(repo, ['config', 'user.email', 'b45@test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  if (opts.committed !== false) {
    writeFileSync(join(repo, 'base.txt'), 'base\n', 'utf8');
    writeFileSync(join(repo, 'tracked.txt'), 'committed\n', 'utf8');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'base']);
  }
  const sentinelRel = 'sentinel-untracked.txt';
  if (opts.dirty === true) {
    // staged AND unstaged changes on the SAME tracked file, plus an untracked file.
    writeFileSync(join(repo, 'tracked.txt'), 'staged\n', 'utf8');
    git(repo, ['add', 'tracked.txt']);
    writeFileSync(join(repo, 'tracked.txt'), 'unstaged\n', 'utf8');
    writeFileSync(join(repo, sentinelRel), 'SENTINEL\n', 'utf8');
  } else if (opts.cwdSubdir !== undefined) {
    // A nested scenario only needs a sentinel so snapshotRepo can read it back.
    writeFileSync(join(repo, sentinelRel), 'SENTINEL\n', 'utf8');
  }
  // B4.5 (P1-2): the real working directory. A nested subdir is created for real.
  const runCwd = opts.cwdSubdir === undefined ? repo : join(repo, opts.cwdSubdir);
  if (opts.cwdSubdir !== undefined) mkdirSync(runCwd, { recursive: true });
  const wantSnapshot = opts.dirty === true || opts.cwdSubdir !== undefined;
  const before = wantSnapshot ? snapshotRepo(repo, sentinelRel) : null;
  if (opts.blockWorktreeRoot === true) {
    // A FILE where the worktree directory must go -> `git worktree add` fails.
    writeFileSync(join(parent, '.p4m-worktrees'), 'not a directory\n', 'utf8');
  }

  const reportDir = join(ownDir(), 'reports');
  const requests: RunRequest[] = [];
  const reviewRequests: RunRequest[] = [];
  const decisionRequests: DecisionRequest[] = [];
  const REVIEW_VERDICT_JSON = JSON.stringify({
    verdict: 'pass', reason: 'fixture reviewer: the group\'s combined result is checked against the recorded runs',
    findings: [], recommendedAction: 'none', reviewer: 'fixture-codex', reviewedAt: 1,
  });
  const runtime = new RuntimeOrchestrator({
    config: { agents: {} } as never,
    storeDir: join(parent, 'store'),
    replaceAdapters: [
      createFakeAdapter({ id: AGENT_A, capabilities: CAPS, script: [{ kind: 'exit', code: 0 }] }),
      createFakeAdapter({ id: AGENT_B, capabilities: CAPS, script: [{ kind: 'exit', code: 0 }] }),
      createFakeAdapter({ id: REVIEWER, capabilities: CAPS, script: [{ kind: 'frame', text: REVIEW_VERDICT_JSON, data: { text: REVIEW_VERDICT_JSON } }, { kind: 'exit', code: 0 }] }),
    ],
  });

  let inFlight = 0;
  let maxConcurrentRuns = 0;
  const drivable = {
    agentIds: () => [AGENT_A, AGENT_B],
    descriptors: () => [AGENT_A, AGENT_B].map((id) => ({ id, displayName: id, launcher: 'fake', transport: 'cli-jsonl', capabilities: CAPS } as never)),
    configFor: () => ({}),
    store: runtime.store,
    review: (req: Omit<RunRequest, 'mode'>) => { reviewRequests.push({ ...req, mode: 'review' } as RunRequest); return runtime.review(req); },
    run(req: RunRequest): RunHandle {
      requests.push(req);
      inFlight += 1;
      maxConcurrentRuns = Math.max(maxConcurrentRuns, inFlight);
      const runIdx = requests.length;
      const parsed = memberRoleOf(req.prompt);
      const failed = opts.failMember !== undefined && parsed !== null && parsed.kind === 'member' && parsed.index === opts.failMember;

      const runCwd = req.cwd;
      let changedFiles: string[] = [];
      let output: string;
      if (failed) {
        output = `member ${parsed && parsed.kind === 'member' ? parsed.index : '?'}: fixture failure before any deliverable`;
      } else if (parsed !== null && parsed.kind === 'member') {
        const relPath = `${parsed.scope.replace(/\/?\*+$/, '')}/${parsed.role}.txt`;
        const abs = join(runCwd, relPath);
        mkdirSync(join(abs, '..'), { recursive: true });
        const body = `DELIVERY member=${parsed.index} role=${parsed.role} agent=${req.agentId} model=${String(req.model)} run=${runIdx}`;
        writeFileSync(abs, body, 'utf8');
        changedFiles = [relPath];
        output = `collaborator ${parsed.index} (${parsed.role}) wrote ${relPath}`;
      } else if (parsed !== null && parsed.kind === 'integration') {
        // Read the members' ACTUAL bytes from the SAME worktree the writers used.
        const found = filesUnder(runCwd)
          .filter((f) => f.endsWith('.txt') && !f.startsWith('src/integration/'))
          .map((f) => ({ file: f, text: readFileSync(join(runCwd, f), 'utf8') }))
          .filter((c) => c.text.includes('DELIVERY'));
        const combinedRel = 'src/integration/combined.txt';
        const combined = [
          `COMBINED RESULT objective=${String(opts.objective ?? 'collab')}`,
          ...found.map((c) => `from ${c.file}: ${c.text.trim()}`),
        ].join('\n');
        mkdirSync(join(runCwd, 'src/integration'), { recursive: true });
        writeFileSync(join(runCwd, combinedRel), combined, 'utf8');
        changedFiles = [combinedRel, ...found.map((c) => c.file)];
        output = `${parsed.token}: integrated ${found.length} member file(s) [${found.map((c) => c.file).join(', ')}]`;
      } else {
        output = `run ${runIdx}: unrecognised task shape`;
      }

      const toolCalls: ToolCall[] = changedFiles.map((p, i) => ({ name: 'write', callId: `c${runIdx}-${i}`, status: 'ok', input: { filePath: p }, output: 'written' }));
      // B4.5a: only the integration (last) run's physical stop is withheld when asked; every
      // other run keeps the normal confirmed stop. The run still writes the combined file.
      const integratorStopUnconfirmed =
        opts.retainIntegratorStop === true && parsed !== null && parsed.kind === 'integration';
      const result: RunResult = {
        taskId: `t${runIdx}`, threadId: null, agentId: req.agentId,
        state: failed ? 'failed' : 'succeeded',
        startedAt: Date.now(), endedAt: Date.now(),
        exitCode: failed ? 1 : 0, signal: null,
        output, outputTruncated: false, transcriptPath: null,
        usage: {}, toolCalls,
        error: failed ? { code: 'NONZERO_EXIT', message: 'fixture failure' } : null,
        diagnostics: [], cleanup: { rootKilled: false, descendantsReaped: false, note: '', treeStopConfirmed: !integratorStopUnconfirmed, processStart: 'started' },
      };
      return {
        result: async () => {
          try { await new Promise((r) => setTimeout(r, 1)); return result; } finally { inFlight -= 1; }
        },
      } as unknown as RunHandle;
    },
  };

  let pairQuestion = 0;
  const provider: DecisionProvider = {
    name: 'laya-b45-seam',
    async probe() { return { ok: true, endpoint: 'seam://laya', detail: 'test seam', warnings: [] }; },
    async decide(request) {
      const answers: Record<string, unknown> = {};
      for (const [key, question] of Object.entries(request.questions)) {
        const criteria = (question.criteria ?? {}) as Record<string, string>;
        const offered = Object.keys(criteria);
        if (question.type === 'choice' && offered.length < 2) {
          throw new Error(`question "${key}" offers exactly one choice, which a real provider refuses before sending`);
        }
        const probabilities: Record<string, number> = {};
        const pick = (value: string) => {
          for (const o of offered) probabilities[o] = o === value ? 1 : 0;
          return { type: 'choice', choice: value, probabilities, confidence: 1 };
        };
        if (key === ORCHESTRATION_ACTION_ID) {
          decisionRequests.push(request);
          const state = JSON.parse(String((request.state as Record<string, string> | undefined)?.[ORCHESTRATION_ACTION_ID] ?? '{}')) as { tasks?: Array<{ taskId: string; status: string }> };
          const tasks = state.tasks ?? [];
          const toVerify = tasks.find((t) => t.status === 'to_verify');
          const pending = tasks.find((t) => t.status === 'planned' || t.status === 'queued');
          let action = 'wait';
          const parameters: Record<string, string> = {};
          const rawMaterial = (request.state as Record<string, string> | undefined)?.[ACCEPTANCE_MATERIAL_FIELD];
          if (toVerify !== undefined && rawMaterial !== undefined) {
            const material = JSON.parse(rawMaterial) as { objective: string; entries: Array<{ taskId: string; acceptanceCriteria: string; output: string; executionMissing: boolean }> };
            const entry = material.entries.find((e) => e.taskId === toVerify.taskId);
            const token = entry === undefined ? '' : (entry.acceptanceCriteria.split(':: ')[1] ?? '').split(' —')[0] ?? '';
            const isIntegration = token.startsWith('integration (');
            const satisfies = entry !== undefined && material.objective.trim() !== '' && entry.acceptanceCriteria.trim() !== '' &&
              !entry.executionMissing && entry.output.trim() !== '' && entry.output.includes(token) &&
              (isIntegration ? /integrated [1-9]\d* member file/.test(entry.output) : true);
            if (satisfies && entry !== undefined) {
              action = 'complete';
              parameters.taskId = entry.taskId;
              parameters.reason = 'its own acceptance material shows its own execution produced its own deliverable';
            }
          } else if (toVerify === undefined && pending !== undefined) {
            action = 'continue';
          }
          answers[key] = { ...pick(action), parameters };
          continue;
        }
        if (key === WORKFLOW_PLAN_ID) {
          answers[key] = pick(opts.planChoice !== undefined && offered.includes(opts.planChoice) ? opts.planChoice : offered[0]!);
          continue;
        }
        if (key === INITIAL_AGENT_MODEL_ID) {
          const k = pairQuestion++;
          const order = opts.pairs ?? [['agent-a', 'agent-a/m1'], ['agent-a', 'agent-a/m2'], ['agent-b', 'agent-b/m1']];
          const want = initialCandidateKey(order[k]![0], order[k]![1]);
          answers[key] = pick(offered.includes(want) ? want : offered[k] ?? offered[0]!);
          continue;
        }
        answers[key] = answerFor(key, question as { type: string; criteria: unknown }, ROUTING_ANSWERS);
      }
      return { answers, provider: { name: 'laya-b45-seam', details: 'stub Laya' }, raw: {} } as never;
    },
  };

  // P0-1: drive the group from an explicit user-approved plan FILE (absolute path, OUTSIDE
  // the repo so the user checkout stays clean), never the contract-free built-in.
  const planFilePath = join(ownDir(), 'plans.json');
  writeFileSync(planFilePath, JSON.stringify(B45_PLAN_FILE), 'utf8');

  const argv = [
    opts.objective ?? 'add a retry budget to the http client',
    '--json', '--cwd', runCwd,
    '--max-children', '4', '--max-concurrent', String(opts.maxConcurrent ?? 4),
    '--workflow', 'collaborate',
    '--workflow-plan', planFilePath,
    ...(opts.planChoice !== undefined ? ['--workflow-choice', opts.planChoice] : []),
    ...(opts.noReview === true ? ['--no-review'] : []),
  ];
  const probes = [['agent-a', 'agent-a/m1'], ['agent-a', 'agent-a/m2'], ['agent-b', 'agent-b/m1']].map(([a, m]) => probeFor(a!, m!));

  // B4.5a: capture the PRODUCTION manager's real retained claims through its OWN API. This
  // wraps the existing method (calling the real implementation), reads the real book with
  // `retainedResourceProtections()`, and restores the prototype in `finally` — no fake flag.
  const retainedClaims: ResourceClaim[] = [];
  let workspaceManager: WorkspaceManager | null = null;
  const origRetain = WorkspaceManager.prototype.retainResourceProtection;
  let spied = false;
  if (opts.captureRetained === true) {
    spied = true;
    WorkspaceManager.prototype.retainResourceProtection = function (
      taskId: string, mode: ResourceClaimMode, scope: ResourceScope, reason: string,
    ): number {
      const n = origRetain.call(this, taskId, mode, scope, reason);
      workspaceManager = this;
      for (const cl of this.retainedResourceProtections()) {
        if (!retainedClaims.some((s) => s.claimId === cl.claimId)) retainedClaims.push(cl);
      }
      return n;
    };
  }

  const before_ = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => { captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true; }) as typeof process.stdout.write;
  let exitCode = -1;
  try {
    exitCode = await runRoundCli(drivable as never, argv, { provider, probes, roundResultDir: reportDir });
  } finally {
    process.stdout.write = before_;
    if (spied) WorkspaceManager.prototype.retainResourceProtection = origRetain;
  }
  const jsonStart = captured.indexOf('{');
  let report: Record<string, unknown> = {};
  if (jsonStart !== -1) { try { report = JSON.parse(captured.slice(jsonStart)); } catch { report = {}; } }
  const after = wantSnapshot ? snapshotRepo(repo, sentinelRel) : null;
  return { report, requests, reviewRequests, decisionRequests, repo, parent, maxConcurrentRuns, exitCode, before, after, retainedClaims, workspaceManager };
}

const collabOf = (r: Round): CollabView =>
  (r.report.collaboration ?? { members: [], integrator: {} as never, distinctPairs: 0, pairIsDistinct: false, integratorReusesMemberPair: false, choice: '' }) as never;
const wf = (r: Round): Record<string, unknown> => (r.report.workflow ?? {}) as Record<string, unknown>;

// =========================================================================
// B4.5a (E): NEGATIVE CONTROL entry point.
//
// The parent test spawns THIS file under a Node loader that removes the NEW runtime check
// from `src/cli/round-cli.ts` in an isolated in-memory copy — the working tree is never
// modified. Under that loader the same fault-injection scenario must DIVERGE: with the check
// gone the round becomes ok and a review runs, which is exactly what the regression asserts
// must NOT happen while the check is present.
if (process.env.B45_NEGATIVE_CONTROL === '1') {
  let diverged = false;
  let detail = '';
  try {
    const r = await collabRound({
      planChoice: 'duo',
      pairs: [['agent-a', 'agent-a/m1'], ['agent-a', 'agent-a/m2']],
      retainIntegratorStop: true,
    });
    diverged = r.report.ok === true && r.reviewRequests.length === 1;
    detail = `ok=${String(r.report.ok)} reviews=${r.reviewRequests.length} incomplete=${String(r.report.executionIncomplete)} exit=${r.exitCode}`;
  } catch (e) {
    detail = `threw: ${(e as Error).message}`;
  }
  for (const d of tmpDirs) removeOwnedDir(d);
  process.stdout.write(`NEGATIVE_CONTROL ${diverged ? 'DIVERGED' : 'STILL_BLOCKED'} ${detail}\n`);
  process.exit(diverged && cleanupFailures.length === 0 ? 0 : 1);
}

// =========================================================================
let fatal: unknown;
try {

// =========================================================================
section('A: duo in a REAL git repo — members write, integrator reads, one worktree');

{
  const r = await collabRound({
    planChoice: 'duo',
    pairs: [['agent-a', 'agent-a/m1'], ['agent-a', 'agent-a/m2']],
    maxConcurrent: 4,
  });
  const c = collabOf(r);
  const ws = c.workspace;

  check('A: the plan is duo with two members and an integrator', c.choice === 'duo' && c.members.length === 2, JSON.stringify(c.members));
  check('A: all members and the integration task succeeded, exit 0', c.members.every((m) => m.status === 'succeeded') && c.integrator.status === 'succeeded' && r.exitCode === 0,
    JSON.stringify(c.members.map((m) => m.status)) + ` int=${c.integrator.status} exit=${r.exitCode} stop=${String(wf(r).stop)}`);
  check('A: the round is complete and ok', r.report.ok === true && r.report.executionIncomplete === false,
    `ok=${String(r.report.ok)} incomplete=${String(r.report.executionIncomplete)}`);

  // ---- ONE PHYSICAL WORKTREE, NOT THE USER CHECKOUT ----------------------
  check('A: every RunRequest cwd is ONE real git worktree, distinct from the user cwd',
    r.requests.length === 3 && new Set(r.requests.map((q) => q.cwd)).size === 1 && r.requests[0]!.cwd !== r.repo,
    r.requests.map((q) => q.cwd).join(' | '));
  const wt = r.requests[0]!.cwd;
  check('A: the worktree directory really exists', existsSync(wt), wt);
  check('A: the worktree .git is a LINK FILE (real gitdir linkage), not a directory',
    existsSync(join(wt, '.git')) && statSync(join(wt, '.git')).isFile(), join(wt, '.git'));
  const gitdirText = readFileSync(join(wt, '.git'), 'utf8');
  const gitdirRaw = gitdirText.replace(/^gitdir:\s*/, '').trim();
  const gitdirAbs = isAbsolute(gitdirRaw) ? gitdirRaw : resolve(wt, gitdirRaw);
  check('A: the .git linkage points into the SOURCE repo\'s worktrees metadata',
    gitdirText.startsWith('gitdir: ') && existsSync(gitdirAbs) && resolve(gitdirAbs).toLowerCase().startsWith(resolve(r.repo).toLowerCase()),
    gitdirText.trim());
  const wtList = git(r.repo, ['worktree', 'list', '--porcelain']);
  const registeredPaths = wtList.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('worktree ')).map((l) => resolve(l.slice('worktree '.length)).toLowerCase());
  check('A: git itself registers a linked worktree at that path',
    registeredPaths.filter((p) => p === resolve(wt).toLowerCase()).length === 1, wtList);

  // ---- OWNER / BRANCH / BASE, ALL TRACEABLE -----------------------------
  const headBefore = git(r.repo, ['rev-parse', 'HEAD']).trim();
  check('A: the report names the PHYSICAL owner = the round root task', ws?.owner === r.report.rootTaskId, JSON.stringify(ws));
  check('A: the report branch is the root-owned task branch', ws?.branch === `orch/task/${String(r.report.rootTaskId)}`, JSON.stringify(ws));
  check('A: the reported baseSha is the user repo\'s committed base (from HEAD)',
    typeof ws?.baseSha === 'string' && ws.baseSha === headBefore, JSON.stringify(ws));

  // ---- THE DELIVERABLES LIVE IN THE WORKTREE, NOT THE CHECKOUT ----------
  const provider = join(wt, 'src/provider/provider.txt');
  const consumer = join(wt, 'src/consumer/consumer.txt');
  check('A: member 1 wrote its declared-scope file IN THE WORKTREE', existsSync(provider) && statSync(provider).isFile(), provider);
  check('A: member 2 wrote its OWN declared-scope file IN THE WORKTREE', existsSync(consumer) && statSync(consumer).isFile(), consumer);
  const combinedPath = join(wt, 'src/integration/combined.txt');
  const combined = existsSync(combinedPath) ? readFileSync(combinedPath, 'utf8') : '';
  check('A: the integration task produced ONE combined artifact in the worktree', combined !== '', dirHas(wt));
  check('A: the combined artifact contains each member\'s ACTUAL bytes',
    existsSync(provider) && existsSync(consumer) &&
      combined.includes(readFileSync(provider, 'utf8').trim()) && combined.includes(readFileSync(consumer, 'utf8').trim()),
    combined.replace(/\n/g, ' | '));
  check('A: nothing was written into the USER checkout',
    !existsSync(join(r.repo, 'src/provider/provider.txt')) && !existsSync(join(r.repo, 'src/integration/combined.txt')),
    dirHas(r.repo));

  // ---- B4.5 (P1-1): THE REVIEW READS THE GROUP WORKTREE, NOT THE CHECKOUT ---
  // Captured from the runtime REVIEW seam. It must be the SAME worktree the members wrote
  // into, and that directory must really hold this round's member + combined bytes — so
  // reverting the code to point the review at `o.cwd` fails on the filesystem, not just on
  // a string constant.
  const reviewCwd = r.reviewRequests.length === 1 ? r.reviewRequests[0]!.cwd : null;
  check('A: exactly one round review ran', r.reviewRequests.length === 1, `n=${r.reviewRequests.length}`);
  check('A: the round review cwd IS the group worktree (never the user checkout)',
    reviewCwd !== null && reviewCwd === wt && reviewCwd !== r.repo, `reviewCwd=${String(reviewCwd)} wt=${wt}`);
  const reviewCombined = reviewCwd !== null && existsSync(join(reviewCwd, 'src/integration/combined.txt'))
    ? readFileSync(join(reviewCwd, 'src/integration/combined.txt'), 'utf8') : '';
  check('A: the review cwd really holds this round\'s member + combined bytes (not just a string match)',
    reviewCwd !== null && existsSync(join(reviewCwd, 'src/provider/provider.txt')) &&
      reviewCombined.includes('DELIVERY member=1') && reviewCombined.includes('DELIVERY member=2'),
    reviewCwd === null ? '(no review)' : `combined="${reviewCombined.replace(/\n/g, ' | ').slice(0, 140)}"`);

  // ---- B4.5 (P2): the top-level workspace description is the GROUP's ----------
  const topWs = r.report.workspace as { isolation?: string; group?: { owner?: string | null; path?: string | null } } | undefined;
  check('A: report.workspace describes ONE shared group worktree (not per-writing-task), consistent with collaboration.workspace',
    topWs !== undefined && typeof topWs.isolation === 'string' &&
      /SHARED git worktree/i.test(topWs.isolation) && !/per writing task/i.test(topWs.isolation) &&
      topWs.group?.owner === ws?.owner && topWs.group?.path === ws?.path,
    JSON.stringify(topWs));

  // ---- IDENTITY: own task/session/pair; integrator reuses a member ---------
  check('A: each member is its own task', new Set(c.members.map((m) => m.taskId)).size === 2, JSON.stringify(c.members.map((m) => m.taskId)));
  check('A: each member got its OWN session', c.members[0]!.sessionId !== null && c.members[1]!.sessionId !== null && c.members[0]!.sessionId !== c.members[1]!.sessionId,
    JSON.stringify(c.members.map((m) => m.sessionId)));
  check('A: the two members hold DIFFERENT pairs', c.pairIsDistinct === true, JSON.stringify(c.members.map((m) => `${m.agentId}/${m.modelId}`)));
  check('A: the integrator reuses a selected member\'s pair (no fourth model)',
    c.integratorReusesMemberPair === true && c.members.some((m) => m.taskId === c.integrator.memberTaskId && m.agentId === c.integrator.agentId && m.modelId === c.integrator.modelId),
    JSON.stringify(c.integrator));
  check('A: the integrator has its OWN task and session (distinct from the member it reuses)',
    c.integrator.taskId !== c.integrator.memberTaskId && c.integrator.sessionId !== c.members.find((m) => m.taskId === c.integrator.memberTaskId)?.sessionId,
    JSON.stringify(c.integrator));

  // ---- CAPACITY: --max-concurrent 4, still one writer at a time -----------
  check('A: PARALLEL_WRITE stayed closed — max concurrent writer = 1 even with --max-concurrent 4',
    r.maxConcurrentRuns === 1, `maxConcurrent=${r.maxConcurrentRuns}`);
}

// =========================================================================
section('B: the USER checkout is byte-for-byte unchanged (staged/unstaged/untracked)');

{
  const r = await collabRound({
    planChoice: 'duo',
    pairs: [['agent-a', 'agent-a/m1'], ['agent-a', 'agent-a/m2']],
    dirty: true,
  });
  const before = r.before!;
  const after = r.after!;
  const sentinelRel = 'sentinel-untracked.txt';

  check('B: user repo HEAD is unchanged', before.head === after.head, `${before.head} -> ${after.head}`);
  check('B: user repo status (staged+unstaged+untracked) is unchanged', before.status === after.status, `"${before.status.replace(/\n/g, '|')}" -> "${after.status.replace(/\n/g, '|')}"`);
  check('B: user repo unstaged diff is unchanged', before.diff === after.diff);
  check('B: user repo STAGED diff is unchanged', before.cached === after.cached);
  check('B: user repo .git/index bytes are unchanged', before.indexSha === after.indexSha, `${before.indexSha} -> ${after.indexSha}`);
  check('B: the tracked (dirty) file content is unchanged', before.tracked === after.tracked, before.tracked);
  check('B: the untracked sentinel is unchanged', before.sentinel === after.sentinel);

  const c = collabOf(r);
  const wt = c.workspace?.path ?? null;
  check('B: the group worked in a worktree, not the user cwd', wt !== null && wt !== r.repo, String(wt));
  // `.trim()` absorbs the LF->CRLF checkout conversion this machine's git may apply.
  check('B: the dirty edits were NOT copied into the worktree (it starts from the committed base)',
    wt !== null && existsSync(wt) && readFileSync(join(wt, 'tracked.txt'), 'utf8').trim() === 'committed',
    wt === null ? '(no worktree)' : `${wt}/tracked.txt`);
  check('B: the untracked sentinel was NOT copied into the worktree',
    wt !== null && !existsSync(join(wt, sentinelRel)), wt ?? '(no worktree)');
  check('B: the round still completed ok despite the dirty user checkout', r.report.ok === true && r.exitCode === 0,
    `ok=${String(r.report.ok)} exit=${r.exitCode}`);
}

// =========================================================================
section('C: trio sanity — 4 sequential runs in the same shared worktree');

{
  const r = await collabRound({
    planChoice: 'trio',
    pairs: [['agent-a', 'agent-a/m1'], ['agent-b', 'agent-b/m1'], ['agent-a', 'agent-a/m2']],
    maxConcurrent: 4,
  });
  const c = collabOf(r);
  check('C: three distinct members and an integrator', c.members.length === 3 && c.pairIsDistinct === true,
    JSON.stringify(c.members.map((m) => `${m.role}:${m.agentId}/${m.modelId}`)));
  check('C: 4 runs, all in ONE worktree, never concurrent',
    r.requests.length === 4 && new Set(r.requests.map((q) => q.cwd)).size === 1 && r.maxConcurrentRuns === 1,
    `n=${r.requests.length} cwds=${new Set(r.requests.map((q) => q.cwd)).size} max=${r.maxConcurrentRuns}`);
  check('C: all 3 members and the integrator succeeded', c.members.every((m) => m.status === 'succeeded') && c.integrator.status === 'succeeded',
    JSON.stringify(c.members.map((m) => m.status)));
  const wt = r.requests[0]!.cwd;
  const combined = existsSync(join(wt, 'src/integration/combined.txt')) ? readFileSync(join(wt, 'src/integration/combined.txt'), 'utf8') : '';
  check('C: the combined artifact carries all THREE members\' real content',
    combined.includes('src/core/core.txt') && combined.includes('src/cli/cli.txt') && combined.includes('tests/checks.txt'),
    combined.replace(/\n/g, ' | '));
  check('C: the round is complete and ok', r.report.ok === true && r.report.executionIncomplete === false,
    `ok=${String(r.report.ok)} stop=${String(wf(r).stop)}`);
}

// =========================================================================
section('D: a member that FAILS leaves the integration unrun and the round not ok');

{
  const r = await collabRound({
    planChoice: 'duo',
    pairs: [['agent-a', 'agent-a/m1'], ['agent-a', 'agent-a/m2']],
    failMember: 2,
  });
  const c = collabOf(r);
  check('D: member 2 is failed, member 1 still succeeded', c.members[1]!.status === 'failed' && c.members[0]!.status === 'succeeded',
    JSON.stringify(c.members.map((m) => m.status)));
  check('D: the integration task NEVER ran', !r.requests.some((q) => memberRoleOf(q.prompt)?.kind === 'integration'), `requests=${r.requests.length}`);
  check('D: the integrator is not succeeded', c.integrator.status !== 'succeeded', c.integrator.status);
  check('D: the round is NOT ok and IS incomplete', r.report.ok === false && r.report.executionIncomplete === true && r.exitCode !== 0,
    `ok=${String(r.report.ok)} incomplete=${String(r.report.executionIncomplete)} exit=${r.exitCode}`);
  const wt = c.workspace?.path ?? null;
  check('D: no combined artifact exists in the worktree', wt === null || !existsSync(join(wt, 'src/integration/combined.txt')), wt ?? '(no worktree)');
  check('D: the report names the blocking member', JSON.stringify(wf(r).pending).includes(c.members[1]!.taskId), JSON.stringify(wf(r).pending));
}

// =========================================================================
section('E: a worktree that CANNOT be created → no fallback to the user cwd, runtime = 0');

{
  // A committed repo, but the worktree root cannot be created (its parent is a file),
  // so `git worktree add` fails. The group must NOT silently fall back to the user cwd.
  const r = await collabRound({
    planChoice: 'duo',
    pairs: [['agent-a', 'agent-a/m1'], ['agent-a', 'agent-a/m2']],
    blockWorktreeRoot: true,
  });
  const c = collabOf(r);
  check('E: NO agent was ever started (runtime = 0)', r.requests.length === 0, `requests=${r.requests.length}`);
  check('E: the group did NOT fall back to the user cwd — no group worktree was reported',
    c.workspace !== undefined && c.workspace.path === null, JSON.stringify(c.workspace));
  check('E: no member succeeded', c.members.every((m) => m.status !== 'succeeded'), JSON.stringify(c.members.map((m) => m.status)));
  check('E: the round is NOT ok, IS incomplete, and exits non-zero', r.report.ok === false && r.report.executionIncomplete === true && r.exitCode !== 0,
    `ok=${String(r.report.ok)} incomplete=${String(r.report.executionIncomplete)} exit=${r.exitCode}`);
  const topWsE = r.report.workspace as { isolation?: string } | undefined;
  check('E: report.workspace does NOT claim a created group directory (no worktree existed)',
    topWsE !== undefined && typeof topWsE.isolation === 'string' && /NO worktree/i.test(topWsE.isolation),
    JSON.stringify(topWsE));
  check('E: the review was WITHHELD (no read review against the missing workspace, non-PASS)',
    (r.report.unifiedReview as { status?: string } | undefined)?.status !== 'completed', JSON.stringify(r.report.unifiedReview));
}

// =========================================================================
section('F: the stop-unconfirmed RETAINED claim blocks later group members (read too), different groups isolated');

{
  const { parent, repo } = makeCommittedRepo();
  const mgr = new WorkspaceManager({ projectRoot: repo, workspaceLock: false });
  // Every task of ONE group resolves to the same PHYSICAL owner; another group's task
  // resolves to a different owner.
  const ownerOf = new Map<string, string>([
    ['grpA', 'grpA'], ['A', 'grpA'], ['B', 'grpA'], ['C', 'grpA'],
    ['grpB', 'grpB'], ['D', 'grpB'],
  ]);
  const requests: RunRequest[] = [];
  const budgets = new BudgetManager(10_000_000);
  budgets.agent(AGENT_A, 10_000_000);
  const registry = new ModelRegistry();
  registry.upsert({ agentId: AGENT_A, modelId: 'm1', provider: AGENT_A, taskTypes: ['implementation'] as never, modelSource: 'test', quotaSource: 'test' }, Date.now());
  registry.setAgentAvailability(AGENT_A, 'available');
  const gate = {
    descriptors: [{ id: AGENT_A, displayName: AGENT_A, launcher: 'fake', transport: 'cli-jsonl', capabilities: CAPS } as unknown as AgentDescriptor],
    agentStatus: [{ agentId: AGENT_A, agent: AGENT_A, version: '1', installed: 'Yes', login: 'y', quotaSource: 't', usage: 'n', status: 'ok' }],
    quotaRecords: [{ provider: AGENT_A, agentId: AGENT_A, modelId: null, source: 'cli_reported', usage: null, remaining: null, resetAt: null, period: 'unknown', status: 'unavailable' as const, usageClass: 'reported' as const, confidence: 'high' as const, observedAt: Date.now(), note: '' }],
    registry,
    budgets,
    taskType: 'implementation' as const,
    requestedUnits: 10, currentConcurrency: 0, maxConcurrency: 4, maxChildren: 8, maxConcurrentAgents: 4, taskPolicyAllows: true,
  };
  const resultOnce = (taskId: string, agentId: string, treeStopConfirmed: boolean): RunResult => ({
    taskId, threadId: null, agentId, state: 'succeeded',
    startedAt: Date.now(), endedAt: Date.now(), exitCode: 0, signal: null,
    output: 'ok', outputTruncated: false, transcriptPath: null, usage: {}, toolCalls: [],
    error: null, diagnostics: [],
    cleanup: { rootKilled: false, descendantsReaped: false, note: '', treeStopConfirmed, processStart: 'started' },
  });
  const orch = new TaskOrchestrator({
    gate: gate as never,
    now: Date.now,
    defaultCwd: repo,
    workspace: mgr,
    workspaceMode: () => 'isolated',
    workspaceOwner: (task: Task) => ownerOf.get(task.taskId) ?? null,
    resourceClaims: (task: Task) => ({
      mode: task.taskType === 'review' ? 'read' : 'write',
      scope: normalizeScopeForWorkspace(`task:${ownerOf.get(task.taskId) ?? task.taskId}`, repo),
    }),
    runtime: {
      run(req: RunRequest) {
        requests.push(req);
        // F's tasks are identified by their own id in the prompt ("Task <id> (type)").
        const taskId = /Task (\S+) \(/.exec(req.prompt)?.[1] ?? '';
        // A's run reports an UNCONFIRMED tree stop -> its write claim is RETAINED.
        const treeStop = taskId === 'A' ? false : true;
        return { result: async () => resultOnce(taskId, req.agentId, treeStop) } as unknown as RunHandle;
      },
    },
  });

  const mk = (taskId: string, parentTaskId: string, type: 'implementation' | 'review'): void => {
    budgets.task(taskId, 10_000);
    orch.spawnChild({ taskId, parentTaskId, agentId: AGENT_A, modelId: 'm1', taskType: type, acceptanceCriteria: taskId, budgetUnits: 10 });
  };
  orch.createRoot({ taskId: 'grpA', agentId: AGENT_A, taskType: 'implementation', acceptanceCriteria: 'root' });
  orch.createRoot({ taskId: 'grpB', agentId: AGENT_A, taskType: 'implementation', acceptanceCriteria: 'root' });
  mk('A', 'grpA', 'implementation');
  mk('B', 'grpA', 'implementation');
  mk('C', 'grpA', 'review');
  mk('D', 'grpB', 'implementation');

  const resA = await orch.executeTask({ taskId: 'A' });
  check('F: A ran (its effect on the tree leaves a retained claim)', resA.ok === true, resA.ok ? '' : `${resA.code} ${resA.reason}`);
  check('F: a PHYSICAL protection is retained after the unconfirmed stop', mgr.retainedResourceProtections().length >= 1,
    JSON.stringify(mgr.retainedResourceProtections().map((cl) => `${cl.taskId}/${cl.mode}`)));

  const resB = await orch.executeTask({ taskId: 'B' });
  check('F: a later WRITER in the SAME group is refused with resource-conflict', resB.ok === false && resB.code === 'resource-conflict',
    resB.ok ? 'it RAN' : `${resB.code} ${resB.reason.slice(0, 100)}`);
  const resC = await orch.executeTask({ taskId: 'C' });
  check('F: a later READER in the SAME group is ALSO refused (retained claim outranks read+write)',
    resC.ok === false && resC.code === 'resource-conflict', resC.ok ? 'it RAN' : `${resC.code} ${resC.reason.slice(0, 100)}`);

  const resD = await orch.executeTask({ taskId: 'D' });
  check('F: a task of a DIFFERENT group is NOT blocked (per-group isolation)', resD.ok === true, resD.ok ? '' : `${resD.code} ${resD.reason}`);
  const cwds = new Set(requests.map((q) => q.cwd));
  check('F: the two groups ran in DIFFERENT worktrees', cwds.size === 2, [...cwds].join(' | '));

  removeOwnedDir(parent);
}

// =========================================================================
section('G: a NESTED --cwd (a real subdirectory, not the repo root) is refused before anything runs');

{
  // A committed repo with a REAL nested directory. With `--cwd <repo>/nested`, the group's
  // worktree root would land INSIDE the repo (dirname(nested)/.p4m-worktrees) and the nested
  // relative directory the user asked for would be lost. It must be refused up front.
  const r = await collabRound({
    planChoice: 'duo',
    pairs: [['agent-a', 'agent-a/m1'], ['agent-a', 'agent-a/m2']],
    cwdSubdir: 'nested',
  });
  const before = r.before!;
  const after = r.after!;

  check('G: the nested cwd genuinely exists and is NOT the repo root',
    existsSync(join(r.repo, 'nested')) && statSync(join(r.repo, 'nested')).isDirectory(), join(r.repo, 'nested'));
  check('G: the round exits non-zero', r.exitCode !== 0, String(r.exitCode));
  check('G: the refusal is a plan-stage refusal naming the repository root',
    r.report.stage === 'plan' && String(r.report.error).includes('REPOSITORY ROOT'),
    `stage=${String(r.report.stage)} error=${String(r.report.error).slice(0, 160)}`);
  check('G: NO task was created',
    r.report.tasks === undefined || (Array.isArray(r.report.tasks) && (r.report.tasks as unknown[]).length === 0),
    JSON.stringify(r.report.tasks));
  check('G: the runtime was never started (requests = 0)', r.requests.length === 0, `requests=${r.requests.length}`);
  check('G: no review was requested (reviewRequests = 0)', r.reviewRequests.length === 0, `reviewRequests=${r.reviewRequests.length}`);
  check('G: no .p4m-worktrees was created INSIDE the repo', !existsSync(join(r.repo, '.p4m-worktrees')), join(r.repo, '.p4m-worktrees'));

  check('G: user repo HEAD is unchanged', before.head === after.head, `${before.head} -> ${after.head}`);
  check('G: user repo status is unchanged', before.status === after.status, `"${before.status.replace(/\n/g, '|')}" -> "${after.status.replace(/\n/g, '|')}"`);
  check('G: user repo unstaged diff is unchanged', before.diff === after.diff);
  check('G: user repo STAGED diff is unchanged', before.cached === after.cached);
  check('G: user repo .git/index bytes are unchanged', before.indexSha === after.indexSha, `${before.indexSha} -> ${after.indexSha}`);
  check('G: the tracked file content is unchanged', before.tracked === after.tracked, before.tracked);
  check('G: the untracked sentinel is unchanged', before.sentinel === after.sentinel);
}

// =========================================================================
section('A2 (B4.5a): a NORMAL duo is unaffected — no runtime protection is retained');

{
  const r = await collabRound({
    planChoice: 'duo',
    pairs: [['agent-a', 'agent-a/m1'], ['agent-a', 'agent-a/m2']],
    captureRetained: true,
  });
  const c = collabOf(r);
  check('A2: the round is complete and ok', r.report.ok === true && r.report.executionIncomplete === false && r.exitCode === 0,
    `ok=${String(r.report.ok)} incomplete=${String(r.report.executionIncomplete)} exit=${r.exitCode}`);
  check('A2: the production manager retained NO runtime claim in a normal round', r.retainedClaims.length === 0,
    JSON.stringify(r.retainedClaims.map((cl) => `${cl.taskId}/${cl.mode}`)));
  check('A2: the review still runs against the group worktree (never the user checkout)',
    r.reviewRequests.length === 1 && r.reviewRequests[0]!.cwd === c.workspace?.path && r.reviewRequests[0]!.cwd !== r.repo,
    `n=${r.reviewRequests.length} reviewCwd=${String(r.reviewRequests[0]?.cwd)} wt=${String(c.workspace?.path)}`);
}

// =========================================================================
section('B2 (B4.5a): the integration run\'s UNCONFIRMED stop retains a RUNTIME claim on the group workspace');

{
  const r = await collabRound({
    planChoice: 'duo',
    pairs: [['agent-a', 'agent-a/m1'], ['agent-a', 'agent-a/m2']],
    retainIntegratorStop: true,
    captureRetained: true,
  });
  const c = collabOf(r);
  const wt = c.workspace?.path ?? null;
  const rootId = String(r.report.rootTaskId);
  const groupWorkspaceId = `task:${rootId}`;

  // ---- the fault is a PHYSICAL stop, not a delivery gap ------------------
  check('B2: every member and the integrator logically SUCCEEDED (not a missing deliverable)',
    c.members.every((m) => m.status === 'succeeded') && c.integrator.status === 'succeeded',
    JSON.stringify(c.members.map((m) => m.status)) + ` int=${c.integrator.status}`);
  const combined = wt !== null && existsSync(join(wt, 'src/integration/combined.txt'))
    ? readFileSync(join(wt, 'src/integration/combined.txt'), 'utf8') : '';
  check('B2: the REAL combined file is complete on disk (the failure cannot be read as a missing artifact)',
    combined.includes('DELIVERY member=1') && combined.includes('DELIVERY member=2'),
    wt === null ? '(no worktree)' : combined.replace(/\n/g, ' | ').slice(0, 140));

  // ---- the PRODUCTION manager really retained a claim, read via its own API --
  check('B2: the production WorkspaceManager actually retained a runtime ResourceClaim',
    r.retainedClaims.length >= 1, JSON.stringify(r.retainedClaims.map((cl) => `${cl.taskId}/${cl.mode}`)));
  check('B2: the retained claim names THIS group\'s physical workspace (workspaceId), matched by workspace not by owner id',
    r.retainedClaims.some((cl) => cl.workspaceId === groupWorkspaceId && cl.protectionRetained === true),
    JSON.stringify(r.retainedClaims.map((cl) => `${cl.taskId}:${cl.workspaceId}`)));
  check('B2: the retained claim is held by the INTEGRATOR (the real holder), keyed by its own task id — not the round root',
    r.retainedClaims.some((cl) => cl.taskId === c.integrator.taskId && cl.taskId !== rootId && cl.protectionRetained === true),
    JSON.stringify(r.retainedClaims.map((cl) => cl.taskId)));

  // ---- the withheld review: zero calls, no fabricated pass ----------------
  check('B2: NO review was invoked (reviewRequests = 0)', r.reviewRequests.length === 0, `n=${r.reviewRequests.length}`);
  const ur = r.report.unifiedReview as { status?: string; verdict?: unknown } | undefined;
  check('B2: the review is NOT a pass and carries no verdict', ur?.status !== 'completed' && ur?.verdict === null,
    JSON.stringify(r.report.unifiedReview));

  // ---- nothing reports completion ----------------------------------------
  check('B2: report.ok is false and executionIncomplete is true',
    r.report.ok === false && r.report.executionIncomplete === true,
    `ok=${String(r.report.ok)} incomplete=${String(r.report.executionIncomplete)}`);
  check('B2: the round exits non-zero', r.exitCode !== 0, String(r.exitCode));
  const gate = (r.report.roundResult as { gate?: { roundComplete?: boolean; executionIncomplete?: boolean } } | undefined)?.gate;
  check('B2: the final RoundResult / Human Gate does NOT report the round complete',
    gate?.roundComplete === false && gate?.executionIncomplete === true, JSON.stringify(gate));
}

// =========================================================================
section('C2 (B4.5a): --no-review is NOT a physical-stop exemption; a normal skip is unchanged');

{
  // C2a: same fault injection, `--no-review` given. The physical stop is unconfirmed, so it
  // still may not be reported ok or exit 0 — `--no-review` is not an exemption.
  const bad = await collabRound({
    planChoice: 'duo',
    pairs: [['agent-a', 'agent-a/m1'], ['agent-a', 'agent-a/m2']],
    retainIntegratorStop: true,
    noReview: true,
  });
  check('C2: with --no-review the retained runtime claim still blocks ok/exit0',
    bad.report.ok === false && bad.report.executionIncomplete === true && bad.exitCode !== 0,
    `ok=${String(bad.report.ok)} incomplete=${String(bad.report.executionIncomplete)} exit=${bad.exitCode}`);
  check('C2: no review was requested either way', bad.reviewRequests.length === 0, `n=${bad.reviewRequests.length}`);

  // C2b: a NORMAL `--no-review` round keeps the existing semantics exactly (not falsely blocked).
  const ok = await collabRound({
    planChoice: 'duo',
    pairs: [['agent-a', 'agent-a/m1'], ['agent-a', 'agent-a/m2']],
    noReview: true,
  });
  check('C2: a normal --no-review round is NOT falsely blocked (ok, exit 0, not incomplete)',
    ok.report.ok === true && ok.report.executionIncomplete === false && ok.exitCode === 0,
    `ok=${String(ok.report.ok)} incomplete=${String(ok.report.executionIncomplete)} exit=${ok.exitCode}`);
  check('C2: a normal --no-review round reports not_requested (unchanged semantics)',
    (ok.report.unifiedReview as { status?: string } | undefined)?.status === 'not_requested',
    JSON.stringify(ok.report.unifiedReview));
}

// =========================================================================
section('D2 (B4.5a): an UNRELATED group\'s retained runtime claim does not block THIS group');

{
  // Use the REAL resource API on the production manager: after its first `prepare`, register
  // and RETAIN a claim on a DIFFERENT physical workspace (a different workspaceId/root). The
  // current group's check must not match it, so the round is not falsely blocked. The seam
  // wraps the existing `prepare` and is restored in `finally`.
  const origPrepare = WorkspaceManager.prototype.prepare;
  let mgr: WorkspaceManager | null = null;
  let injected = false;
  WorkspaceManager.prototype.prepare = async function (input: Parameters<WorkspaceManager['prepare']>[0]) {
    const h = await origPrepare.call(this, input);
    mgr = this;
    if (!injected) {
      injected = true;
      const otherScope = normalizeScopeForWorkspace('task:unrelated-group', join(tmpdir(), 'b45-unrelated-root'));
      this.claimResource({ taskId: 'unrelated-task', workspaceId: 'task:unrelated-group', mode: 'write', scope: otherScope });
      this.retainResourceProtection('unrelated-task', 'write', otherScope, 'fault-injected unrelated retention');
    }
    return h;
  };
  let r: Round | null = null;
  try {
    r = await collabRound({
      planChoice: 'duo',
      pairs: [['agent-a', 'agent-a/m1'], ['agent-a', 'agent-a/m2']],
    });
  } finally {
    WorkspaceManager.prototype.prepare = origPrepare;
  }

  const manager = mgr as WorkspaceManager | null;
  check('D2: the unrelated retention was really registered and retained via the production API',
    manager !== null && manager.retainedResourceProtections().some((cl) => cl.taskId === 'unrelated-task' && cl.protectionRetained === true),
    manager === null ? '(no manager captured)' : JSON.stringify(manager.retainedResourceProtections().map((cl) => `${cl.taskId}/${cl.workspaceId}`)));
  check('D2: the current group is NOT blocked — ok, exit 0, complete',
    r !== null && r.report.ok === true && r.report.executionIncomplete === false && r.exitCode === 0,
    r === null ? '(no round)' : `ok=${String(r.report.ok)} incomplete=${String(r.report.executionIncomplete)} exit=${r.exitCode}`);
  check('D2: the group review still ran against its own worktree',
    r !== null && r.reviewRequests.length === 1, `n=${String(r?.reviewRequests.length)}`);
  const rootId = r === null ? '' : String(r.report.rootTaskId);
  check('D2: NO retained claim names the current group\'s physical workspace',
    manager !== null && !manager.retainedResourceProtections().some((cl) => cl.workspaceId === `task:${rootId}`),
    manager === null ? '(no manager captured)' : JSON.stringify(manager.retainedResourceProtections().map((cl) => cl.workspaceId)));
}

// =========================================================================
section('D3 (B4.5a): a SCOPE-ONLY overlapping retained claim (different workspaceId) blocks the group');

{
  // The regression Codex reproduced: the group's retained-claim check built its workspace
  // scope by hand with a NATIVE root (`C:\...`), while a real retained claim carries a
  // NORMALIZED `file` path (`c:/...`). `scopesOverlap`/`isUnder` therefore never saw the
  // containment and an independent scope-only protection inside the group worktree was
  // ignored.
  //
  // The seam wraps the EXISTING production manager — never a second claim book. Once the
  // INTEGRATOR's own `releaseResourceClaimForScope` has run to completion (normal output on
  // disk, confirmed tree stop, main execution done), it registers + retains a claim with a
  // DIFFERENT workspaceId but a normalized `file` scope still inside the REAL worktree. Both
  // methods are restored in `finally`.
  const origPrepare = WorkspaceManager.prototype.prepare;
  const origRelease = WorkspaceManager.prototype.releaseResourceClaimForScope;
  const INJECTED_TASK_ID = 'independent-file-owner';
  const INJECTED_WORKSPACE_ID = 'task:independent-file-owner';
  const injectedScopes: ResourceScope[] = [];
  let mgr: WorkspaceManager | null = null;
  let groupCwd: string | null = null;
  let groupWorkspaceId: string | null = null;
  let injected = false;
  WorkspaceManager.prototype.prepare = async function (input: Parameters<WorkspaceManager['prepare']>[0]) {
    const h = await origPrepare.call(this, input);
    mgr = this;
    if (groupCwd === null) { groupCwd = h.cwd; groupWorkspaceId = h.workspaceId; }
    return h;
  };
  WorkspaceManager.prototype.releaseResourceClaimForScope = function (
    taskId: string, mode: ResourceClaimMode, scope: ResourceScope,
  ): number {
    const n = origRelease.call(this, taskId, mode, scope);
    if (!injected && groupCwd !== null && taskId.endsWith('-int')) {
      injected = true;
      const fileScope = normalizeScope({ path: join(groupCwd, 'src', 'integration', 'combined.txt'), root: groupCwd, kind: 'file' });
      injectedScopes.push(fileScope);
      this.claimResource({ taskId: INJECTED_TASK_ID, workspaceId: INJECTED_WORKSPACE_ID, mode: 'write', scope: fileScope });
      this.retainResourceProtection(INJECTED_TASK_ID, 'write', fileScope, 'fault-injected scope-only retention inside the group worktree');
    }
    return n;
  };
  let r: Round | null = null;
  try {
    r = await collabRound({
      planChoice: 'duo',
      pairs: [['agent-a', 'agent-a/m1'], ['agent-a', 'agent-a/m2']],
      captureRetained: true,
    });
  } finally {
    WorkspaceManager.prototype.prepare = origPrepare;
    WorkspaceManager.prototype.releaseResourceClaimForScope = origRelease;
  }

  const manager = mgr as WorkspaceManager | null;
  const round = r as Round | null;
  const c3 = round === null ? null : collabOf(round);
  const injectedScope = injectedScopes[0] ?? null;
  const wt3 = c3?.workspace?.path ?? null;
  const combined3 = wt3 !== null && existsSync(join(wt3, 'src/integration/combined.txt'))
    ? readFileSync(join(wt3, 'src/integration/combined.txt'), 'utf8') : '';
  const normGroup = groupCwd !== null && groupWorkspaceId !== null
    ? normalizeScopeForWorkspace(groupWorkspaceId, groupCwd) : null;
  const normGroupRoot = normGroup !== null && normGroup.kind === 'workspace' ? (normGroup.root ?? '') : '';

  check('D3: the scope-only claim was really registered AND retained via the production API',
    manager !== null && manager.retainedResourceProtections().some((cl) => cl.taskId === INJECTED_TASK_ID && cl.protectionRetained === true),
    manager === null ? '(no manager captured)' : JSON.stringify(manager.retainedResourceProtections().map((cl) => `${cl.taskId}:${cl.workspaceId}`)));
  check('D3: the retained claim\'s workspaceId is DIFFERENT from the group\'s physical workspace',
    groupWorkspaceId !== null && round !== null &&
      round.retainedClaims.some((cl) => cl.taskId === INJECTED_TASK_ID && cl.workspaceId === INJECTED_WORKSPACE_ID && cl.workspaceId !== groupWorkspaceId),
    JSON.stringify({ groupWorkspaceId, retained: round?.retainedClaims.map((cl) => `${cl.taskId}:${cl.workspaceId}`) }));
  check('D3: the injected file scope is NORMALIZED and really lies inside the REAL group worktree',
    injectedScope !== null && injectedScope.kind === 'file' && normGroupRoot !== '' &&
      injectedScope.path.startsWith(`${normGroupRoot}/`) && wt3 !== null && wt3 === groupCwd &&
      existsSync(join(wt3, 'src/integration/combined.txt')),
    JSON.stringify({ groupCwd, normGroupRoot, injectedScope }));
  check('D3: every member and the integrator logically SUCCEEDED and the combined file is on disk (NOT a delivery failure)',
    c3 !== null && c3.members.every((m) => m.status === 'succeeded') && c3.integrator.status === 'succeeded' && combined3.includes('COMBINED RESULT'),
    c3 === null ? '(no round)' : JSON.stringify(c3.members.map((m) => m.status)) + ` int=${c3.integrator.status}`);
  check('D3: the scope-only overlap BLOCKS the round — NOT ok and IS incomplete',
    round !== null && round.report.ok === false && round.report.executionIncomplete === true,
    round === null ? '(no round)' : `ok=${String(round.report.ok)} incomplete=${String(round.report.executionIncomplete)}`);
  check('D3: the round exits non-zero', round !== null && round.exitCode !== 0, String(round?.exitCode));
  check('D3: NO review ran (reviewRequests = 0)', round !== null && round.reviewRequests.length === 0, `n=${String(round?.reviewRequests.length)}`);
  const gate3 = (round?.report.roundResult as { gate?: { roundComplete?: boolean; executionIncomplete?: boolean } } | undefined)?.gate;
  check('D3: the final RoundResult / Human Gate does NOT report the round complete',
    gate3?.roundComplete === false && gate3?.executionIncomplete === true, JSON.stringify(gate3));
}

// =========================================================================
section('E2 (B4.5a): NEGATIVE CONTROL — removing the new check makes the same scenario ok + reviewed');

{
  const loaderDir = ownDir();
  const hookPath = join(loaderDir, 'strip-runtime-check-hook.mjs');
  const registerPath = join(loaderDir, 'register-strip-runtime-check.mjs');
  writeFileSync(hookPath, [
    'export async function load(url, context, nextLoad) {',
    '  const result = await nextLoad(url, context);',
    "  if (url.endsWith('/src/cli/round-cli.ts') && result.source != null) {",
    "    const src = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');",
    "    const patched = src.replace('|| groupRuntimeIncomplete;', ';');",
    "    if (patched === src) throw new Error('negative-control: runtime-completeness term not found');",
    '    return { ...result, source: patched };',
    '  }',
    '  return result;',
    '}',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(registerPath, [
    "import { register } from 'node:module';",
    "register('./strip-runtime-check-hook.mjs', import.meta.url);",
    '',
  ].join('\n'), 'utf8');

  // `--import` requires a file:// URL on Windows (a bare `D:\...` path is read as a scheme).
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(registerPath).href, fileURLToPath(import.meta.url)], {
    env: { ...process.env, B45_NEGATIVE_CONTROL: '1' },
    encoding: 'utf8',
    timeout: 180_000,
  });
  const out = `${child.stdout ?? ''}${child.stderr ?? ''}`;
  check('E2: with the new runtime check REMOVED the same scenario DIVERGES (ok + review) — the check is load-bearing',
    child.status === 0 && /NEGATIVE_CONTROL DIVERGED/.test(out),
    `status=${String(child.status)} tail=${out.slice(-300).replace(/\n/g, ' | ')}`);
}

// =========================================================================
} catch (e) {
  fatal = e;
  process.stdout.write(`fatal: ${String((e as Error).message)}\n`);
}

for (const d of tmpDirs) removeOwnedDir(d);

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
if (cleanupFailures.length) process.stdout.write(`cleanup failures (must fail the test):\n  ${cleanupFailures.map((f) => `- ${f}`).join('\n  ')}\n`);
if (fatal !== undefined) process.stdout.write(`fatal (must fail the test): ${String((fatal as Error).message)}\n`);
process.stdout.write('\n');
process.exitCode = failed === 0 && cleanupFailures.length === 0 && fatal === undefined ? 0 : 1;
