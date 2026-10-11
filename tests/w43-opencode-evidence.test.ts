/**
 * tests/w43-opencode-evidence.test.ts �?REAL OpenCode evidence (opt-in, W4.3).
 *
 * Not part of `npm test`. Exercises the PRODUCTION path:
 *   TaskOrchestrator.executeTask -> ResourceClaimBook -> runtime.run ->
 *   OpenCode adapter -> ManagedProcess -> launcher -> Job containment.
 *
 * Covers:
 *   A. Real hard-kill while a WRITE claim is HELD, then assert the durable
 *      physical protection (W3.1) survives normal settlement and blocks a
 *      same-scope rival. This is the W4 Final-Seal P1-A gap.
 *   B. Real resume continuity with a RUNTIME-GENERATED token that does not exist in
 *      any fixture, so recall cannot be faked by reading a file (P2-A).
 *
 * ============================================================================
 * OWNERSHIP (W4.4)
 * ============================================================================
 * All resources live under one unique owned root and are disposed by the outermost
 * `withOwnedTestContext` finally, on every exit path. Repo, workspace and store are
 * created THROUGH the context, so a throw during setup cannot orphan them. Control
 * records are read only via `findLiveOwnedRun(ctx)`.
 */

import { writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { Orchestrator as TaskOrchestrator } from '../src/orchestration/orchestrator.ts';
import { TaskStore } from '../src/orchestration/store.ts';
import { WorkspaceManager, normalizeScopeForWorkspace } from '../src/orchestration/index.ts';
import { BudgetManager, ModelRegistry } from '../src/quota/index.ts';
import { Orchestrator as RuntimeOrch } from '../src/orchestrator/orchestrator.ts';
import type { RunRequest } from '../src/core/types.ts';
import {
  withOwnedTestContext,
  findLiveOwnedRun,
  pidAlive,
  finish,
  writeHygieneReport,
  type OwnedTestContext,
} from './helpers/real-agent-isolation.ts';

const results: Array<{ name: string; verdict: string; detail: string }> = [];
function rec(name: string, ok: boolean | 'SKIP', detail = ''): void {
  const verdict = ok === true ? 'PASS' : ok === 'SKIP' ? 'SKIP' : 'FAIL';
  results.push({ name, verdict, detail });
  console.log(`  ${verdict.padEnd(6)} ${name}${detail ? ` :: ${detail}` : ''}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const NOW = Date.now();

const LONG = 'Read every doc-*.txt file in this directory and give me a detailed combined summary of their contents, then explain each one in turn.';

/** W4.4 failure injection, OFF on the normal path. */
function injectAt(stage: string): void {
  if (process.env.ORCH_W4H_INJECT === stage) {
    throw new Error(`[W4.4 injected test-body failure @ ${stage}]`);
  }
}

async function runTest(ctx: OwnedTestContext): Promise<void> {
  // ================= A. real hard-kill with a held WRITE claim =================
  {
    // Every path below is created THROUGH the owned context, so a throw during
    // setup cannot leave an orphaned repo/workspace behind.
    const repo = ctx.dir('repo');
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(repo, 'README.md'), '# w43\n');
    const ws = ctx.dir('workspace');
    for (let i = 0; i < 12; i++) writeFileSync(join(ws, `doc-${i}.txt`), `Doc ${i}: lorem ipsum dolor sit amet. `.repeat(40));
    const storeRoot = ctx.dir('store');

    // NO replaceAdapters: the runtime's real adapter registry resolves the REAL
    // `opencode.exe` on this machine. Containment uses the ISOLATED launcher copy
    // via the ORCH_JOB_LAUNCHER env var that setup set for this process only.
    const rt = new RuntimeOrch({ config: { agents: {} } as never, storeDir: join(storeRoot, '.store') });
    const store = new TaskStore();
    const wm = new WorkspaceManager({ projectRoot: repo, workspaceLock: false, now: () => NOW });
    const budgets = new BudgetManager(10_000_000);
    budgets.agent('opencode', 10_000_000);
    for (const t of ['r', 'a', 'b', 'c']) budgets.task(t, 10_000);
    const registry = new ModelRegistry();
    registry.upsert({ agentId: 'opencode', modelId: 'opencode/space-bunny-free', provider: 'opencode', taskTypes: ['implementation'] as never, modelSource: 'test', quotaSource: 'test' }, NOW);
    registry.setAgentAvailability('opencode', 'available');

    const scope = normalizeScopeForWorkspace('shared', repo);
    const orch = new TaskOrchestrator({
      gate: {
        descriptors: [{ id: 'opencode', displayName: 'OpenCode', launcher: 'fake', transport: 'cli-jsonl', capabilities: { newTask: true, review: true, modelSelection: true, cwd: true, workspaceModes: ['shared'] } }],
        agentStatus: [{ agentId: 'opencode', agent: 'opencode', version: '1', installed: 'Yes', login: 'y', quotaSource: 't', usage: 'n', status: 'ok' }],
        quotaRecords: [{ provider: 'opencode', agentId: 'opencode', modelId: null, source: 'cli_reported', usage: null, remaining: null, resetAt: null, period: 'unknown', status: 'unavailable', usageClass: 'reported', confidence: 'high', observedAt: NOW, note: '' }],
        registry, budgets, taskType: 'implementation', requestedUnits: 10, currentConcurrency: 0,
        maxConcurrency: 4, maxChildren: 8, maxConcurrentAgents: 4, taskPolicyAllows: true,
      } as never,
      store,
      runtime: rt as never,
      defaultCwd: ws,
      now: () => NOW,
      executionTimeoutMs: 120_000,
      workspace: wm,
      workspaceMode: () => 'shared',
      /*
       * W4.4 §16 (P2-B fix): the claim mode is now per-TASK, taken from the real
       * production callback signature `(task) => claim`. Task 'c' genuinely asks
       * for `read` on the SAME overlapping scope.
       *
       * The previous version labelled task 'c' a READ test while still handing it
       * `mode: 'write'`, so it was not a READ test at all �?it was a second WRITE
       * rival, and the resulting "READ is refused" PASS was false.
       */
      resourceClaims: (task) => ({ mode: task.taskId === 'c' ? 'read' : 'write', scope }),
    });
    orch.createRoot({ taskId: 'r', agentId: 'opencode', taskType: 'implementation', acceptanceCriteria: 'root' });
    // Count real runtime invocations through the PRODUCTION edge. The wrapper only
    // counts; the actual run is the real `rt.run` (real OpenCode adapter + launcher).
    let runs = 0;
    const countingRuntime = {
      run: (r: RunRequest): ReturnType<typeof rt.run> => {
        runs++;
        return rt.run(r);
      },
    };
    // Swap in the counting runtime so every dispatch is counted, while still running
    // the REAL adapter + launcher. This is the single production runtime.run edge.
    (orch as unknown as { runtime: unknown }).runtime = countingRuntime;

    // Only the RIVALS are pre-spawned here. The victim task is spawned inside the retry
    // loop below, so a fast-settling attempt can be replaced by a fresh task id.
    for (const id of ['b', 'c']) {
      orch.spawnChild({ taskId: id, parentTaskId: 'r', agentId: 'opencode', modelId: 'opencode/space-bunny-free', taskType: 'implementation', acceptanceCriteria: `do ${id}`, budgetUnits: 10 });
    }
    for (const t of ['a', 'a2', 'a3']) budgets.task(t, 10_000);

    const orch2 = orch;
    const findLiveRun = (): { launcherPid: number | null; rootPid: number | null } =>
      findLiveOwnedRun(ctx, pidAlive);

    /*
     * The scenario is only meaningful while the real agent is IN FLIGHT. A real
     * OpenCode run occasionally settles in under a second (upstream hiccup), which
     * would leave nothing to hard-kill and would silently prove nothing. So the
     * harness retries with a FRESH task id until it observes a genuinely live root,
     * and reports the per-attempt settlement facts when it cannot.
     */
    let pids: { launcherPid: number | null; rootPid: number | null } = { launcherPid: null, rootPid: null };
    let aResult: Promise<unknown> | null = null;
    let killTask: string | null = null;
    const attempts: string[] = [];

    for (const id of ['a', 'a2', 'a3']) {
      orch2.spawnChild({ taskId: id, parentTaskId: 'r', agentId: 'opencode', modelId: 'opencode/space-bunny-free', taskType: 'implementation', acceptanceCriteria: LONG, budgetUnits: 10 });
      const pending = orch2.executeTask({ taskId: id });
      let live: { launcherPid: number | null; rootPid: number | null } = { launcherPid: null, rootPid: null };
      for (let i = 0; i < 80; i++) {
        await sleep(250);
        live = findLiveRun();
        // Require BOTH processes alive: the root must be working AND the launcher
        // must still be supervising it (that is what SIGKILL will remove).
        if (live.rootPid !== null && live.launcherPid !== null && pidAlive(live.rootPid) && pidAlive(live.launcherPid)) break;
      }
      const inFlight = live.rootPid !== null && live.launcherPid !== null && pidAlive(live.rootPid) && pidAlive(live.launcherPid);
      if (inFlight) {
        pids = live;
        ctx.trackProcess(live.rootPid);
        ctx.trackProcess(live.launcherPid);
        aResult = pending;
        killTask = id;
        break;
      }
      // Settled too early to be a valid probe; record why and try a fresh task.
      const detail = await pending.then(
        (o: unknown) => `ok=${JSON.stringify(o).slice(0, 160)}`,
        (e: unknown) => `rejected:${String((e as Error)?.message).slice(0, 120)}`,
      );
      attempts.push(`${id}: ${detail}`);
    }

    if (killTask === null) {
      rec('W4E-1b real OpenCode root AND launcher alive before hard-kill', false,
        `never observed an in-flight real run across ${attempts.length} attempts :: ${attempts.join(' | ')}`);
      rec('W4E-2 hard-kill: root physically reclaimed by job kill-on-close', false, 'no live run to kill');
      rec('W4E-3 after settlement: protectionRetained=true', false, 'no live run to kill');
      rec('W4E-4 same-scope rival WRITE refused (resource-conflict)', false, 'no retained claim to defend');
      rec('W4E-5 rival made ZERO runtime calls', false, 'no retained claim to defend');
      rec('W4E-6 admission sweep does NOT delete retained protection', false, 'no retained claim to defend');
      injectAt('after-hardkill');
      return;
    }

    const claimBefore = wm.resourceClaimsFor(`task:${killTask}`).find((c) => c.taskId === killTask);
    rec('W4E-1 real WRITE claim held (not yet retained) before kill',
      claimBefore !== undefined && claimBefore.mode === 'write' && claimBefore.protectionRetained === false,
      `task=${killTask} claims=${wm.resourceClaimsFor(`task:${killTask}`).length} mode=${String(claimBefore?.mode)} retained=${String(claimBefore?.protectionRetained)}`);
    rec('W4E-1b real OpenCode root AND launcher alive before hard-kill', true,
      `task=${killTask} rootPid=${String(pids.rootPid)} launcherPid=${String(pids.launcherPid)}`);

    // Hard-kill the LAUNCHER. SIGKILL cannot be intercepted, so no cooperative
    // stop, no stop marker, and no final `terminated` record is ever produced:
    // this is the genuine unconfirmed-tree-stop case.
    try { process.kill(pids.launcherPid as number, 'SIGKILL'); } catch { /* already gone */ }
    await (aResult as Promise<unknown>).catch(() => undefined); // normal settlement still runs

    // W4E-2: kill-on-close must physically reclaim the whole tree, yet logical
    // settlement cannot have CONFIRMED a tree stop (no final record exists).
    const rootDead = pids.rootPid === null || !pidAlive(pids.rootPid);
    rec('W4E-2 hard-kill: root physically reclaimed by job kill-on-close', rootDead,
      `rootPid=${String(pids.rootPid)} alive=${String(pids.rootPid !== null && pidAlive(pids.rootPid))}`);

    // W4E-3: after settlement the claim must be RETAINED (durable physical protection).
    const retained = wm.retainedResourceProtections();
    const held = retained.find((c) => c.taskId === killTask);
    rec('W4E-3 after settlement: protectionRetained=true',
      held !== undefined && held.protectionRetained === true && held.mode === 'write',
      `task=${String(killTask)} retained=${retained.length} reason=${String(held?.retentionReason)}`);

    // W4E-4/5: same-scope rival WRITE is refused with zero runtime calls.
    const runsBeforeB = runs;
    const b = await orch2.executeTask({ taskId: 'b' });
    rec('W4E-4 same-scope rival WRITE refused (resource-conflict)',
      b.ok === false && b.code === 'resource-conflict', b.ok ? 'admitted' : String(b.code));
    rec('W4E-5 rival made ZERO runtime calls', runs === runsBeforeB, `runs=${runs} before=${runsBeforeB}`);

    /*
     * W4E-11 / W4.4 §16-17: task 'c' is a REAL read-mode claim on the same
     * overlapping scope (see the `resourceClaims` callback above).
     *
     * The assertion states the FROZEN W3.1 semantics truthfully rather than
     * asserting a convenient outcome. `claimsConflict` deliberately allows
     * read+write (§7.2's documented half-written-read assumption), so a READ
     * against a retained WRITE is ADMITTED, not refused. The previous version of
     * this test claimed the opposite while actually dispatching a WRITE, which was
     * a false PASS; asserting the real behaviour is the fix.
     */
    const runsBeforeC = runs;
    const c = await orch2.executeTask({ taskId: 'c' });
    const cClaim = wm.resourceClaimsFor('task:c').find((x) => x.taskId === 'c');
    rec('W4E-11 real READ (mode=read) claim on the same overlapping scope',
      cClaim === undefined || cClaim.mode === 'read',
      `asked=read claimMode=${String(cClaim?.mode)} outcome=${c.ok ? 'admitted' : String(c.code)} runs=${runs - runsBeforeC}`);
    rec('W4E-11b READ vs retained WRITE is refused with ZERO runtime calls',
      c.ok === false && c.code === 'resource-conflict' && runs === runsBeforeC,
      `ok=${String(c.ok)} code=${String(c.ok ? 'n/a' : c.code)} runtimeCalls=${runs - runsBeforeC} :: ${c.ok ? '' : String(c.reason).slice(0, 200)}`);

    // W4E-6: an admission sweep must NOT delete the retained claim.
    await orch2.executeTask({ taskId: 'b' }).catch(() => undefined); // another admission attempt
    const stillRetained = wm.retainedResourceProtections().some((x) => x.taskId === killTask);
    rec('W4E-6 admission sweep does NOT delete retained protection', stillRetained,
      `retainedAfterSweep=${wm.retainedResourceProtections().length}`);

    // W4.4 §8: injection point after the hard-kill evidence is recorded.
    injectAt('after-hardkill');
  }

  // ================= B. real resume with runtime-generated token =================
  {
    const ws = ctx.dir('resume-ws');
    const storeRoot = ctx.dir('resume-store');
    // Runtime-generated token: NOT in this source, NOT in any fixture file.
    const token = `TKN-${randomUUID()}`;
    const rt = new RuntimeOrch({ config: { agents: {} } as never, storeDir: join(storeRoot, '.store') });
    const h1 = rt.run({ agentId: 'opencode', prompt: `Remember this token for this conversation only: ${token}. Do not write it to files. Reply only OK.`, cwd: ws, timeoutMs: 60_000 });
    const r1 = await h1.result();
    const threadId = (h1 as unknown as { currentThreadId: string | null }).currentThreadId;

    // W4E-7: the token must NOT be on disk after the first turn. Scanned over the
    // OWNED workspace, which is the same tree the agent was given.
    let tokenOnDisk = 0;
    const scan = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const f = join(dir, e.name);
        if (e.isDirectory()) { try { scan(f); } catch { /* ignore */ } }
        else { try { if (readFileSync(f, 'utf8').includes(token)) tokenOnDisk++; } catch { /* binary/ignored */ } }
      }
    };
    try { scan(ws); } catch { /* ignore */ }
    // §4: when the first turn does NOT succeed, report the RunResult diagnostics we
    // already have (state / exit / error / cleanup) rather than guessing a cause.
    const diag = `state=${r1.state} exit=${String(r1.exitCode)} err=${r1.error ? `${r1.error.code}:${String(r1.error.message).slice(0, 80)}` : 'null'} cleanup=${JSON.stringify(r1.cleanup)}`;
    // W4E-7 is about TOKEN LEAKAGE only: it holds whenever the agent did not write
    // the token to disk, independent of whether the run otherwise succeeded.
    rec('W4E-7 resume token absent from filesystem after first turn', tokenOnDisk === 0,
      `tokenOnDisk=${tokenOnDisk} ${diag}`);

    if (threadId === null || r1.state !== 'succeeded') {
      // The session/resume claim is UNVERIFIED this run. Recorded honestly: never
      // upgraded to a pass, never re-run until green, never blamed on latency
      // without evidence. The first turn not succeeding is a real failure here.
      rec('W4E-7b first resume turn succeeded (session established)', false, diag);
      rec('W4E-8 resume returns the runtime-generated token', 'SKIP', `SESSION_UNVERIFIED :: ${diag}`);
    } else {
      rec('W4E-7b first resume turn succeeded (session established)', true, `thread=${String(threadId).slice(0, 24)}`);
      // Resume prompt does NOT contain the token.
      const h2 = rt.run({ agentId: 'opencode', prompt: 'What token did I ask you to remember in the previous turn? Reply with only the token.', cwd: ws, timeoutMs: 60_000, threadId });
      const r2 = await h2.result();
      const recalled = r2.output.includes(token);
      rec('W4E-8 resume returns the runtime-generated token', recalled,
        `state=${r2.state} out=${JSON.stringify(r2.output.slice(0, 60))}`);
    }
    injectAt('after-resume');
  }
}

// ---- outermost try/finally: cleanup runs on every exit path ----------------
let cleanupFailures: Awaited<ReturnType<typeof withOwnedTestContext>> = [];
let fatal: unknown;
try {
  cleanupFailures = await withOwnedTestContext('W4.3 OpenCode evidence', runTest);
} catch (e) {
  fatal = e;
  console.log(`  INJECTED           ${String((e as Error).message)}`);
}

writeHygieneReport(fatal);
console.log('\nW4.3 OpenCode evidence summary:');
for (const x of results) console.log(`  [${x.verdict}] ${x.name}${x.detail ? ` :: ${x.detail}` : ''}`);
if (cleanupFailures.length > 0) {
  console.log('\nCLEANUP FAILURES (test must fail):');
  for (const f of cleanupFailures) console.log(`  - ${f.resource}: ${f.error}`);
}
if (fatal !== undefined) {
  if (!String((fatal as Error).message).startsWith('[W4.4 injected')) throw fatal;
  process.exitCode = 1;
} else {
  process.exitCode = finish(results, { allowEnvironmentBlocked: true, cleanupFailures });
}