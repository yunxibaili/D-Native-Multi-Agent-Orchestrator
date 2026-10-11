/**
 * tests/worker-identity.test.ts — TeamRun T1-b: Worker identity projection.
 *
 * WHAT IS FROZEN HERE
 * -------------------
 *   Agent Family  !=  Model  !=  Worker  !=  Session  !=  Attempt
 *
 * A Worker is one execution participant: a task, one Agent Family, one Model, one
 * Session. These tests drive the REAL `SessionRegistry` and the REAL `AttemptStore` — no
 * doubles — so the identity is proven against the authorities that actually hold the
 * facts it projects.
 *
 * WHAT IS NOT HERE
 * ----------------
 * No retry behaviour, no concurrency, no fan-out. T1-b freezes an identity relationship
 * only; the runtime that might eventually run two workers at once is T3's problem.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionRegistry } from '../src/orchestration/workbench-sessions.ts';
import { AttemptStore } from '../src/orchestration/attempt-store.ts';
import { validateAttemptRecord, executionAttempt } from '../src/orchestration/attempt-record.ts';
import {
  workerIdentity,
  workerKeyOf,
  sameWorker,
  distinctWorkers,
  workerIdentityOfSession,
  workerIdentityOfAttempt,
} from '../src/orchestration/worker-identity.ts';
import type { RunResult } from '../src/core/types.ts';
import type { WorkerIdentity } from '../src/orchestration/worker-identity.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed += 1;
    failures.push(name);
    process.stdout.write(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}\n`);
  }
}

const NOW = Date.parse('2026-01-01T00:00:00Z');
const dir = mkdtempSync(join(tmpdir(), 't1b-'));
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

const runResult = (agentId: string, state: RunResult['state'] = 'succeeded'): RunResult => ({
  taskId: 'X', threadId: 'th-1', agentId, state,
  startedAt: NOW, endedAt: NOW + 1, exitCode: 0, signal: null,
  output: '', outputTruncated: false, transcriptPath: null, usage: null,
  toolCalls: [], diagnostics: [],
  cleanup: { rootKilled: false, descendantsReaped: false, note: '' },
  error: null,
} as unknown as RunResult);

// ---------------------------------------------------------------------------
process.stdout.write('\n== W1: same agent, different models -> different Workers ==\n');
{
  const sessions = new SessionRegistry();
  const a = sessions.open({ agentId: 'opencode', modelId: 'model-a', sessionPolicy: 'fresh' }, 'C:/w', NOW, 'X');
  const b = sessions.open({ agentId: 'opencode', modelId: 'model-b', sessionPolicy: 'fresh' }, 'C:/w', NOW, 'X');

  const wa = workerIdentityOfSession(a)!;
  const wb = workerIdentityOfSession(b)!;

  check('W1: both are on the SAME agent family', wa.agentId === 'opencode' && wb.agentId === 'opencode');
  check('W1: they are DIFFERENT workers', sameWorker(wa, wb) === false);
  check('W1: the keys differ', workerKeyOf(wa) !== workerKeyOf(wb));
  check('W1: neither collapses to the agent name', workerKeyOf(wa) !== 'opencode' && workerKeyOf(wb) !== 'opencode');
  check('W1: both survive being held at once', distinctWorkers([wa, wb]).length === 2);
}

// ---------------------------------------------------------------------------
process.stdout.write('\n== W2: same agent, same model, different sessions -> different Workers ==\n');
{
  const sessions = new SessionRegistry();
  const a = sessions.open({ agentId: 'opencode', modelId: 'model-a', sessionPolicy: 'fresh' }, 'C:/w', NOW, 'X');
  const b = sessions.open({ agentId: 'opencode', modelId: 'model-a', sessionPolicy: 'fresh' }, 'C:/w', NOW, 'X');

  const wa = workerIdentityOfSession(a)!;
  const wb = workerIdentityOfSession(b)!;
  check('W2: agent and model are identical', wa.agentId === wb.agentId && wa.modelId === wb.modelId);
  check('W2: the sessions really differ', a.sessionId !== b.sessionId);
  check('W2: so they are DIFFERENT workers', sameWorker(wa, wb) === false);
}

// ---------------------------------------------------------------------------
process.stdout.write('\n== W3: identical identity -> identical key ==\n');
{
  const id: WorkerIdentity = workerIdentity({ taskId: 'X', agentId: 'opencode', modelId: 'model-a', sessionId: 'ws_1' });
  const same: WorkerIdentity = workerIdentity({ taskId: 'X', agentId: 'opencode', modelId: 'model-a', sessionId: 'ws_1' });
  check('W3: sameWorker is true', sameWorker(id, same) === true);
  check('W3: the projection key is byte-identical', workerKeyOf(id) === workerKeyOf(same));
  check('W3: the key is stable across separate constructions', workerKeyOf(workerIdentity({ taskId: 'X', agentId: 'opencode', modelId: 'model-a', sessionId: 'ws_1' })) === workerKeyOf(id));
  // Deterministic, and no global id authority was invented.
  check('W3: the key carries no database-style id', !/worker_\d+/.test(workerKeyOf(id)));
  // null model must not collide with the string "null".
  const noModel = workerIdentity({ taskId: 'X', agentId: 'opencode', modelId: null, sessionId: 'ws_1' });
  check('W3: a null model is distinct from a model literally named "null"',
    workerKeyOf(noModel) !== workerKeyOf(workerIdentity({ taskId: 'X', agentId: 'opencode', modelId: 'null', sessionId: 'ws_1' })));
}

// ---------------------------------------------------------------------------
process.stdout.write('\n== W4: WorkBuddy CN != WorkBuddy Intl ==\n');
{
  const sessions = new SessionRegistry();
  // Same model id, same session naming shape — only the family differs.
  const cn = sessions.open({ agentId: 'workbuddy-cn', modelId: 'model-x', sessionPolicy: 'fresh' }, 'C:/w', NOW, 'X');
  const intl = sessions.open({ agentId: 'workbuddy-intl', modelId: 'model-x', sessionPolicy: 'fresh' }, 'C:/w', NOW, 'X');
  const wcn = workerIdentityOfSession(cn)!;
  const wintl = workerIdentityOfSession(intl)!;
  check('W4: same modelId on both', wcn.modelId === wintl.modelId);
  check('W4: they are DIFFERENT workers', sameWorker(wcn, wintl) === false);

  // SessionRegistry must not let one family's session be resumed as the other's.
  let refused = '';
  try {
    sessions.open({ agentId: 'workbuddy-intl', modelId: 'model-x', sessionId: cn.sessionId, sessionPolicy: 'resume' }, 'C:/w', NOW, 'X');
  } catch (e) {
    refused = (e as Error).message;
  }
  check('W4: the session authority REFUSES a cross-family resume', refused !== '', refused.slice(0, 120));
}

// ---------------------------------------------------------------------------
process.stdout.write('\n== W5: Attempt is not Worker ==\n');
{
  const store = new AttemptStore();
  const build = (sessionId: string | undefined) => store.append(executionAttempt({
    taskId: 'X', agentId: 'opencode', modelId: 'model-a',
    ...(sessionId === undefined ? {} : { sessionId }),
    result: runResult('opencode'),
  }));

  const first = build('ws_1');
  const second = build('ws_1');
  check('W5: both attempts were recorded', first.ok && second.ok);
  if (first.ok && second.ok) {
    check('W5: the ATTEMPT ids differ', first.record.attemptId !== second.record.attemptId);
    check('W5: the attempts are a chain (previousAttemptId links them)', second.record.previousAttemptId === first.record.attemptId);
    const w1 = workerIdentityOfAttempt(first.record)!;
    const w2 = workerIdentityOfAttempt(second.record)!;
    check('W5: but the WORKER identity is the SAME', sameWorker(w1, w2) === true);
    check('W5: the worker key is identical across attempts', workerKeyOf(w1) === workerKeyOf(w2));
    check('W5: neither worker key contains an attempt id', !workerKeyOf(w1).includes(first.record.attemptId));
  }
}

// ---------------------------------------------------------------------------
process.stdout.write('\n== W6: a handoff is a NEW Worker ==\n');
{
  const sessions = new SessionRegistry();
  // Same task. First attempt on OpenCode/model-a/session-a...
  const first = sessions.open({ agentId: 'opencode', modelId: 'model-a', sessionPolicy: 'fresh' }, 'C:/w', NOW, 'X');
  const wFirst = workerIdentityOfSession(first)!;
  // ...then handed off to a different agent: new session, new agent.
  const second = sessions.open({ agentId: 'workbuddy-intl', modelId: 'model-a', sessionPolicy: 'fresh' }, 'C:/w', NOW, 'X');
  const wSecond = workerIdentityOfSession(second)!;

  check('W6: the taskId is UNCHANGED across the handoff', wFirst.taskId === wSecond.taskId);
  check('W6: the agent changed', wFirst.agentId !== wSecond.agentId);
  check('W6: therefore it is a NEW worker, not the old identity reused', sameWorker(wFirst, wSecond) === false);

  // A model change on the same family is also a new worker, because the session changes.
  const third = sessions.open({ agentId: 'opencode', modelId: 'model-b', sessionPolicy: 'fresh' }, 'C:/w', NOW, 'X');
  check('W6: same family + different model is a new worker',
    sameWorker(wFirst, workerIdentityOfSession(third)!) === false);

  // A REUSE of the same session is the same worker — continuity, not a new participant.
  const reused = sessions.open({ agentId: 'opencode', modelId: 'model-a', sessionId: first.sessionId, sessionPolicy: 'resume' }, 'C:/w', NOW, 'X');
  check('W6: resuming the SAME session stays the SAME worker',
    sameWorker(wFirst, workerIdentityOfSession(reused)!) === true);
}

// ---------------------------------------------------------------------------
process.stdout.write('\n== W7: a legacy record without a session still works ==\n');
{
  // A record exactly as it was written before T1-b: no sessionId key at all.
  const legacy = {
    attemptId: 'att_legacy',
    taskId: 'X',
    kind: 'execution',
    agentId: 'opencode',
    modelId: 'model-a',
    taskType: 'implementation',
    startedAt: NOW,
    finishedAt: NOW + 1,
    outcome: 'success',
    previousAttemptId: null,
  };
  let validated: ReturnType<typeof validateAttemptRecord> | null = null;
  let error = '';
  try {
    validated = validateAttemptRecord(legacy);
  } catch (e) {
    error = (e as Error).message;
  }
  check('W7: a pre-T1-b record still validates', error === '' && validated !== null, error.slice(0, 140));
  check('W7: it simply has no sessionId', validated !== null && validated.sessionId === undefined);
  check('W7: and therefore projects to NO worker (rather than a fabricated one)',
    validated !== null && workerIdentityOfAttempt(validated) === null);

  // A record built the old way (no sessionId passed) must round-trip too.
  const store = new AttemptStore();
  const noSession = store.append(executionAttempt({
    taskId: 'X', agentId: 'opencode', modelId: 'model-a', result: runResult('opencode'),
  }));
  check('W7: recording without a session is still allowed', noSession.ok);
  if (noSession.ok) {
    check('W7: the field is absent, not empty-string or null', noSession.record.sessionId === undefined);
    check('W7: the record keeps every field it always had',
      noSession.record.taskId === 'X' && noSession.record.agentId === 'opencode' && noSession.record.modelId === 'model-a');
  }
}

// ---------------------------------------------------------------------------
process.stdout.write('\n== Codex review identity is expressible (not implementation-only) ==\n');
{
  // Codex is currently the Unified Reviewer. The projection must not be typed so that
  // only implementation workers fit: a reviewer is a worker too.
  const sessions = new SessionRegistry();
  const reviewer = sessions.open({ agentId: 'codex', modelId: 'gpt-5', sessionPolicy: 'fresh' }, 'C:/w', NOW, 'X');
  const w = workerIdentityOfSession(reviewer)!;
  check('a Codex REVIEW worker projects like any other worker',
    w.agentId === 'codex' && w.modelId === 'gpt-5' && w.sessionId === reviewer.sessionId);
  check('and it is distinct from the implementation worker on the same model id',
    sameWorker(w, workerIdentity({ taskId: 'X', agentId: 'opencode', modelId: 'gpt-5', sessionId: reviewer.sessionId })) === false);
}

// ---------------------------------------------------------------------------
process.stdout.write('\n== projection attributes are carried, not owned ==\n');
{
  // `mode`/`scope` ride along for a future view. They must not affect identity, and the
  // worker module must not claim a resource.
  const base: WorkerIdentity = workerIdentity({ taskId: 'X', agentId: 'opencode', modelId: 'model-a', sessionId: 'ws_1' });
  const asRead = { identity: base, mode: 'read' as const, scope: 'repo' as const };
  const asWrite = { identity: base, mode: 'write' as const, scope: 'repo' as const };
  check('mode/scope are NOT part of worker identity', workerKeyOf(asRead.identity) === workerKeyOf(asWrite.identity));
  check('a read and a write projection of one session are the same worker',
    sameWorker(asRead.identity, asWrite.identity) === true);
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length > 0) process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
process.stdout.write('\n');
process.exitCode = failed === 0 ? 0 : 1;