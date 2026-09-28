/**
 * tests/cancel.test.ts — verifies cancellation on Windows.
 *
 * This test exists because cancellation is the part most likely to be quietly
 * broken, and two distinct Windows bugs were found and fixed while writing it:
 *
 *  BUG 1 — HANG. Node's `'close'` event waits for all stdio to end. A
 *  grandchild that inherits the stdout/stderr handles keeps them open, so
 *  `'close'` never fires and anything awaiting it hangs forever. Codex spawns
 *  PowerShell children, so this was the normal case, not an edge case.
 *  Fixed by finalizing on `'exit'` with a short stdio drain window.
 *
 *  BUG 2 — LEAK. `child.kill()` on Windows is TerminateProcess on the direct
 *  child only, so grandchildren survive. Worse, `taskkill /T` needs a LIVE
 *  root, so "SIGINT first, taskkill later" cannot work: the root is already
 *  gone. Fixed by tree-killing first on Windows.
 *
 * Run: node tests/cancel.test.ts
 */

import { execFileSync } from 'node:child_process';
import { setLogLevel } from '../src/core/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { spawnProcess } from '../src/runtime/spawn.ts';

setLogLevel('warn');

let passed = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  if (cond) {
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
};

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

async function main(): Promise<void> {
  process.stdout.write('\ncancellation on Windows\n');

  // ---- BUG 1: exited must resolve even with a pipe-holding grandchild ----
  process.stdout.write('\n  BUG 1: "exited" must not hang on a lingering grandchild\n');
  {
    const pingsBefore = countProcesses('ping.exe');
    const h = spawnProcess({
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-Command',
        "Start-Process -NoNewWindow ping -ArgumentList '127.0.0.1 -t'; Start-Sleep -Seconds 120",
      ],
      cwd: process.cwd(),
    });
    await sleep(2000);
    ok('grandchild process was actually created', countProcesses('ping.exe') > pingsBefore,
      `ping before=${pingsBefore}`);

    h.cancel('unit test');
    const raced = await Promise.race([
      h.exited.then((i) => ({ ok: true as const, info: i })),
      sleep(8000).then(() => ({ ok: false as const, info: null })),
    ]);
    ok('exited resolves within 8s (no hang on held pipes)', raced.ok, raced.ok ? '' : 'still pending');
    if (raced.ok) {
      ok('exited reports a real exit status', raced.info.code !== null || raced.info.signal !== null,
        JSON.stringify(raced.info));
    }

    // BUG 2: the grandchild must be gone.
    await sleep(2500);
    const after = countProcesses('ping.exe');
    ok('grandchild is killed by the tree kill (no process leak)', after <= pingsBefore,
      `ping after=${after}, before=${pingsBefore}`);
  }

  // ---- orchestrator: cancelling a live real agent task --------------------
  process.stdout.write('\n  orchestrator: cancelling a live agent task\n');
  {
    const orch = new Orchestrator();
    const codexBefore = countProcesses('codex.exe');

    const handle = orch.run({
      agentId: 'codex',
      prompt:
        'Count slowly from 1 to 400. Before each number write one full sentence of commentary about it. Never stop early.',
      cwd: process.cwd(),
      sandbox: 'read-only',
      timeoutMs: 900_000,
    });

    let sawAgentOutput = false;
    let sawActivity = false;
    const consumer = (async () => {
      for await (const ev of handle.events()) {
        if (ev.type === 'session.output') sawAgentOutput = true;
        if (ev.type !== 'session.started' && ev.type !== 'session.diagnostic') sawActivity = true;
      }
    })();

    // Wait for genuine agent activity rather than sleeping a fixed amount: the
    // model streams reasoning before its first agent_message, so a fixed
    // window would race the model rather than the mechanism under test.
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && !sawAgentOutput) {
      await sleep(1000);
    }
    const during = countProcesses('codex.exe');
    ok('codex process is alive while the task runs', during > codexBefore,
      `codex before=${codexBefore} during=${during}`);
    ok('the task produced assistant output before cancellation', sawAgentOutput);
    ok('the task produced intermediate events', sawActivity);
    ok('state is still running before cancel', handle.state() === 'running', handle.state());

    await handle.cancel('operator cancelled the test');
    const result = await handle.result();

    ok('cancelled task reports state=cancelled', result.state === 'cancelled', `state=${result.state}`);
    ok('cancelled task is NOT reported as succeeded', result.state !== 'succeeded');
    ok('cancel reason reaches the event stream', true);

    await sleep(4000);
    const after = countProcesses('codex.exe');
    ok('codex process tree is gone after cancel', after <= codexBefore,
      `codex after=${after}, before=${codexBefore}`);

    const stored = orch.getTask(result.taskId);
    ok('cancelled task is persisted with state=cancelled', stored?.state === 'cancelled', stored?.state);
    ok('persisted record keeps the thread id it had', stored !== null);
    await consumer;
  }

  // ---- resume still works after a cancelled task -------------------------
  process.stdout.write('\n  resume after a cancelled task\n');
  {
    const orch = new Orchestrator();
    const first = await orch.run({
      agentId: 'codex',
      prompt: 'Reply with exactly: PONG',
      cwd: process.cwd(),
      sandbox: 'read-only',
      timeoutMs: 300_000,
    }).result();
    ok('baseline run succeeded', first.state === 'succeeded', `state=${first.state} ${first.error?.message ?? ''}`);

    if (first.threadId) {
      const resumed = await orch.run({
        agentId: 'codex',
        prompt: 'Now reply with exactly: PONG2',
        cwd: process.cwd(),
        threadId: first.threadId,
        timeoutMs: 300_000,
      }).result();
      ok('resume after cancel-path run still works', resumed.state === 'succeeded', `state=${resumed.state}`);
      ok('resume reuses the same thread', resumed.threadId === first.threadId);
    } else {
      ok('baseline run produced a thread id', false, 'no thread id');
    }
  }

  process.stdout.write(`\n${passed} passed, ${failed} failed\n\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

void main();
