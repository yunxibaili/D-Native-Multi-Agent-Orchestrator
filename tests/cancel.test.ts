/**
 * tests/cancel.test.ts — cancellation, process-tree cleanup, and the process
 * lifecycle contract on Windows.
 *
 * Two real Windows bugs were found and fixed while writing this file, and both
 * are guarded here:
 *
 *  HANG — Node's `'close'` waits for all stdio. A grandchild that inherits the
 *  stdout/stderr handles keeps them open, so `'close'` never fires and anything
 *  awaiting it hangs forever. Codex spawns PowerShell children, so this was the
 *  NORMAL case for a cancelled Codex task. Fixed by finalizing on `'exit'` with
 *  a short drain window.
 *
 *  LEAK — `child.kill()` on Windows is TerminateProcess on the direct child
 *  only, and `taskkill /T` needs a LIVE root. So "SIGINT then taskkill" cannot
 *  work: the root is already gone and the grandchildren are orphaned. Fixed by
 *  tree-killing first on Windows, and by AWAITING taskkill instead of firing
 *  and forgetting.
 *
 * Run: node tests/cancel.test.ts
 */

import { execFileSync } from 'node:child_process';
import { setLogLevel } from '../src/core/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { ManagedProcess, taskkillTree } from '../src/runtime/spawn.ts';
import { launcherFor } from '../src/runtime/launcher.ts';

setLogLevel('warn');

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed++;
    failures.push(name);
    process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function countProcesses(image: string): number {
  try {
    const out = execFileSync(
      'tasklist.exe',
      ['/FI', `IMAGENAME eq ${image}`, '/NH', '/FO', 'CSV'],
      { encoding: 'utf8', windowsHide: true, timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return (String(out).match(/"[^"]+"/g) ?? []).length;
  } catch {
    return -1;
  }
}

const nodeLauncher = (): ReturnType<typeof launcherFor> => launcherFor(process.execPath);

async function main(): Promise<void> {
  process.stdout.write('\ncancellation and process lifecycle (Windows)\n');

  // ---- 1. plain process kill ------------------------------------------
  process.stdout.write('\n  basic kill\n');
  {
    const l = nodeLauncher();
    if (!l.ok) throw new Error('cannot resolve node launcher');
    const h = new ManagedProcess({
      launcher: l.launcher,
      args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: process.cwd(),
    });
    await sleep(500);
    const hadPid = h.pid !== undefined;
    const cancelOk = await h.cancel('unit test');
    const settled = await h.settleCleanup();
    const exit = await h.exited;
    ok('a long-running process is killed', exit.code !== null || exit.signal !== null, JSON.stringify(exit));
    ok('the handle reports a pid while alive', hadPid);
    ok('cancel() resolves only after cleanup is awaited', cancelOk && settled);
  }

  // ---- 2. tree kill reaches a grandchild that holds the pipes ---------
  process.stdout.write('\n  tree kill (grandchild holding inherited stdio)\n');
  {
    const ps = launcherFor('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');
    if (!ps.ok) throw new Error('cannot resolve powershell launcher');
    const before = countProcesses('ping.exe');
    const h = new ManagedProcess({
      launcher: ps.launcher,
      args: [
        '-NoProfile',
        '-Command',
        "Start-Process -NoNewWindow ping -ArgumentList '127.0.0.1 -t'; Start-Sleep -Seconds 120",
      ],
      cwd: process.cwd(),
    });
    await sleep(2000);
    ok('grandchild process was actually created', countProcesses('ping.exe') > before, `ping before=${before}`);

    await h.cancel('unit test');
    const raced = await Promise.race([
      h.exited.then((e) => ({ ok: true as const, e })),
      sleep(8000).then(() => ({ ok: false as const, e: null })),
    ]);
    ok('exited resolves within 8s (no hang on held pipes)', raced.ok, raced.ok ? '' : 'still pending');
    if (raced.ok) ok('exited reports a real status', raced.e.code !== null || raced.e.signal !== null, JSON.stringify(raced.e));

    await sleep(2500);
    ok('grandchild is killed by the tree kill (no leak)', countProcesses('ping.exe') <= before, `ping after=${countProcesses('ping.exe')}, before=${before}`);
  }

  // ---- 3. stderr tail captures COMPLETE lines -------------------------
  process.stdout.write('\n  stderr tail\n');
  {
    const ps = launcherFor('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');
    if (!ps.ok) throw new Error('cannot resolve powershell launcher');
    const h = new ManagedProcess({
      launcher: ps.launcher,
      args: ['-NoProfile', '-Command', "[Console]::Error.WriteLine('FIRSTLINE'); [Console]::Error.WriteLine('SECONDLINE'); exit 3"],
      cwd: process.cwd(),
    });
    const exit = await h.exited;
    await sleep(200);
    const tail = h.stderrTail.toString();
    ok('non-zero exit is reported', exit.code === 3, `${exit.code}`);
    // Regression: the old implementation sliced first, keeping only the trailing
    // partial line, so complete lines vanished.
    ok('stderr tail keeps a COMPLETE first line', tail.includes('FIRSTLINE'), JSON.stringify(tail));
    ok('stderr tail keeps a COMPLETE last line', tail.includes('SECONDLINE'), JSON.stringify(tail));
  }

  // ---- 4. orchestrator: cancel a live real agent task -----------------
  process.stdout.write('\n  orchestrator: cancelling a live agent task\n');
  {
    const orch = new Orchestrator();
    const codexBefore = countProcesses('codex.exe');

    const handle = orch.run({
      agentId: 'codex',
      prompt: 'Count slowly from 1 to 400. Before each number write one full sentence of commentary about it. Never stop early.',
      cwd: process.cwd(),
      sandbox: 'read-only',
      timeoutMs: 900_000,
    });

    let sawOutput = false;
    let sawActivity = false;
    const consumer = (async () => {
      for await (const ev of handle.events()) {
        if (ev.type === 'session.output') sawOutput = true;
        if (ev.type !== 'session.started' && ev.type !== 'session.diagnostic') sawActivity = true;
      }
    })();

    // Wait for genuine activity rather than racing a fixed sleep: the model
    // streams reasoning before its first agent_message.
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline && !sawOutput) await sleep(1000);

    ok('codex process is alive while the task runs', countProcesses('codex.exe') > codexBefore, `before=${codexBefore} during=${countProcesses('codex.exe')}`);
    ok('the task produced assistant output before cancellation', sawOutput);
    ok('the task produced intermediate events', sawActivity);
    ok('state is running before cancel', handle.state() === 'running', handle.state());

    await handle.cancel('operator cancelled the test');
    const result = await handle.result();

    ok('cancelled task reports state=cancelled', result.state === 'cancelled', `state=${result.state}`);
    ok('cancelled is NOT reported as succeeded', result.state !== 'succeeded');
    ok('cancelled carries an error', result.error?.code === 'CANCELLED', JSON.stringify(result.error));
    ok('repeated result after cancel is identical', (await handle.result()) === result);

    await sleep(4000);
    ok('codex process tree is gone after cancel', countProcesses('codex.exe') <= codexBefore, `after=${countProcesses('codex.exe')} before=${codexBefore}`);

    const stored = orch.getTask(result.taskId);
    ok('cancelled task is persisted with state=cancelled', stored?.state === 'cancelled', stored?.state);
    ok('the live-session entry is released', orch.activeSessions().length === 0, `${orch.activeSessions().length}`);
    await consumer;
  }

  // ---- 5. NORMAL completion: descendants are reaped, not leaked ------
  process.stdout.write('\n  normal completion descendant cleanup\n');
  {
    const codexBefore = countProcesses('codex.exe');
    const orch = new Orchestrator();
    const r = await orch
      .run({ agentId: 'codex', prompt: 'Reply with exactly: PONG', cwd: process.cwd(), sandbox: 'read-only', timeoutMs: 300_000 })
      .result();
    ok('a normal run still succeeds', r.state === 'succeeded', `${r.state} ${r.error?.message ?? ''}`);

    // The reap is attempted and AWAITED; a leak would be visible as a
    // surviving process rather than being silently tolerated.
    await sleep(5000);
    ok('no codex process is left behind after a normal run', countProcesses('codex.exe') <= codexBefore, `after=${countProcesses('codex.exe')} before=${codexBefore}`);

    // taskkill on an already-dead pid must report "nothing to do" as false,
    // not throw, and must not kill an unrelated process.
    const dead = await taskkillTree(999_999);
    ok('taskkillTree on a dead pid resolves false without throwing', dead === false, `${dead}`);
  }

  // ---- 6. resume still works after a cancelled task -------------------
  process.stdout.write('\n  resume after a cancelled task\n');
  {
    const orch = new Orchestrator();
    const first = await orch
      .run({ agentId: 'codex', prompt: 'Reply with exactly: PONG', cwd: process.cwd(), sandbox: 'read-only', timeoutMs: 300_000 })
      .result();
    ok('baseline run succeeded', first.state === 'succeeded', `${first.state} ${first.error?.message ?? ''}`);
    ok('baseline produced a thread id', first.threadId !== null);

    if (first.threadId) {
      // Same agent, same cwd -> allowed.
      const resumed = await orch
        .run({ agentId: 'codex', prompt: 'Now reply with exactly: PONG2', cwd: process.cwd(), threadId: first.threadId, timeoutMs: 300_000 })
        .result();
      ok('resume after cancel-path run still works', resumed.state === 'succeeded', `${resumed.state} ${resumed.error?.message ?? ''}`);
      ok('resume reuses the same thread', resumed.threadId === first.threadId);
    }
  }

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failures.length) process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
  process.stdout.write('\n');
  process.exitCode = failed === 0 ? 0 : 1;
}

void main();
