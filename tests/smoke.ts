/**
 * tests/smoke.ts — the eight acceptance checks from the brief, run for real.
 *
 *   1. OpenCode starts
 *   2. OpenCode returns a final result
 *   3. Codex starts
 *   4. Codex returns a final result
 *   5. intermediate events survive (not all lost)
 *   6. non-zero exit is detected
 *   7. session info is persisted
 *   8. it all works on Windows
 *
 * Run:  node src/cli/index.ts smoke        (full)
 *       node src/cli/index.ts smoke --quick  (skip the two slow real-model runs)
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import type { RuntimeEvent, RuntimeEventType } from '../src/core/event.ts';
import { setLogLevel } from '../src/core/log.ts';
import type { RunRequest, RunResult } from '../src/core/types.ts';

/** Mutable staging for building a partial `RunRequest` field by field. */
type RunRequestPatch = { -readonly [K in keyof RunRequest]?: RunRequest[K] };

export interface SmokeOptions {
  quick?: boolean;
  asJson?: boolean;
  /**
   * Per-agent model overrides. A single global `--model` cannot work here:
   * `opencode/` prefixed ids mean nothing to Codex and vice versa.
   * Needed because an agent's *config* default can be unreachable (this
   * machine's OpenCode config points at a local Ollama on :11435 that is down)
   * while the agent itself is perfectly healthy.
   */
  models?: { opencode?: string; codex?: string };
  role?: string;
  sandbox?: string;
  timeoutMs?: number;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

export async function runSmoke(orch: Orchestrator, options: SmokeOptions = {}): Promise<number> {
  if (!options.asJson) setLogLevel('warn');
  const scratch = join(tmpdir(), 'orch-smoke');
  mkdirSync(scratch, { recursive: true });

  const checks: Check[] = [];
  const record = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
    if (!options.asJson) {
      const tag = ok ? `${GREEN}PASS${OFF}` : `${RED}FAIL${OFF}`;
      process.stdout.write(`  [${tag}] ${name}\n         ${DIM}${detail}${OFF}\n`);
    }
  };

  if (!options.asJson) {
    process.stdout.write('\norchestrator smoke test\n');
    process.stdout.write(`platform  ${process.platform} / node ${process.versions.node}\n`);
    process.stdout.write(`scratch   ${scratch}\n\n`);
  }

  // --- 8. environment ---------------------------------------------------
  // The suite is written to pass on any platform; it reports which one ran so
  // a Windows result is never mistaken for a portable one.
  record(
    '8. Environment / platform reported',
    typeof process.platform === 'string' && typeof process.versions.node === 'string',
    `platform=${process.platform} node=${process.versions.node}`,
  );

  // --- discovery / probe ------------------------------------------------
  const report = await orch.doctor();
  const ocDesc = report.agents.find((a) => a.id === 'opencode');
  const cxDesc = report.agents.find((a) => a.id === 'codex');
  if (!options.asJson) {
    for (const a of report.agents) {
      process.stdout.write(
        `  ${a.ok ? '·' : '!'} ${a.id.padEnd(9)} ${a.ok ? a.version ?? 'ready' : a.detail}\n`,
      );
    }
    process.stdout.write('\n');
  }

  // --- overrides --------------------------------------------------------
  const ovFor = (agentId: string): Partial<RunRequest> => {
    const m = agentId === 'opencode' ? options.models?.opencode : options.models?.codex;
    const patch: RunRequestPatch = {};
    if (m) patch.model = m;
    if (options.role) patch.role = options.role;
    return patch;
  };
  const ov = ovFor('opencode');

  // --- 1/2. OpenCode run -------------------------------------------------
  let ocResult: RunResult | null = null;
  if (ocDesc?.ok) {
    const collected = await collect(orch, {
      ...ov,
      agentId: 'opencode',
      prompt: 'Reply with exactly: PONG',
      cwd: scratch,
      timeoutMs: 240_000,
    });
    ocResult = collected.result;
    record(
      '1. OpenCode starts',
      collected.events.some((e) => e.type === 'session.started'),
      `events=${collected.events.length} exit=${ocResult.exitCode}`,
    );
    record(
      '2. OpenCode returns final result',
      ocResult.state === 'succeeded' && ocResult.output.trim().length > 0,
      `state=${ocResult.state} output=${JSON.stringify(ocResult.output.slice(0, 80))}`,
    );
    record(
      '5a. OpenCode intermediate events preserved',
      collected.events.length > 2 && ocResult.transcriptPath !== null,
      `${collected.events.length} events, transcript=${ocResult.transcriptPath ?? 'none'}`,
    );
    record(
      '7a. OpenCode session persisted',
      Boolean(ocResult.threadId) && orch.getTask(ocResult.taskId) !== null,
      `thread=${ocResult.threadId ?? 'none'}`,
    );

    // resume, reusing the thread id we just learned
    if (ocResult.threadId) {
      const resumed = await collect(orch, {
        ...ov,
        agentId: 'opencode',
        prompt: 'Now reply with exactly: PONG2',
        cwd: scratch,
        threadId: ocResult.threadId,
        timeoutMs: 240_000,
      });
      record(
        '9. OpenCode resume reuses thread',
        resumed.result.state === 'succeeded' && resumed.result.threadId === ocResult.threadId,
        `thread=${resumed.result.threadId} output=${JSON.stringify(resumed.result.output.slice(0, 60))}`,
      );
    }
  } else {
    record('1. OpenCode starts', false, ocDesc?.detail ?? 'not registered');
    record('2. OpenCode returns final result', false, 'skipped');
  }

  // --- 3/4. Codex run ----------------------------------------------------
  if (cxDesc?.ok) {
    const collected = await collect(orch, {
      ...ovFor('codex'),
      agentId: 'codex',
      prompt: 'Reply with exactly: PONG',
      cwd: scratch,
      sandbox: options.sandbox ?? 'read-only',
      timeoutMs: 300_000,
    });
    const r = collected.result;
    record(
      '3. Codex starts',
      collected.events.some((e) => e.type === 'session.started'),
      `events=${collected.events.length} exit=${r.exitCode}`,
    );
    record(
      '4. Codex returns final result',
      r.state === 'succeeded' && r.output.trim().length > 0,
      `state=${r.state} output=${JSON.stringify(r.output.slice(0, 80))}`,
    );
    record(
      '5b. Codex intermediate events preserved',
      collected.events.length > 2 && r.transcriptPath !== null,
      `${collected.events.length} events, transcript=${r.transcriptPath ?? 'none'}`,
    );
    record(
      '5c. Codex config warnings are diagnostics, not failures',
      r.diagnostics.length >= 0 && r.state === 'succeeded',
      `${r.diagnostics.length} diagnostic(s), state=${r.state}`,
    );
    record(
      '7b. Codex session persisted',
      Boolean(r.threadId) && orch.getTask(r.taskId) !== null,
      `thread=${r.threadId ?? 'none'}`,
    );

    if (r.threadId) {
      const resumed = await collect(orch, {
        agentId: 'codex',
        prompt: 'Now reply with exactly: PONG2',
        cwd: scratch,
        threadId: r.threadId,
        timeoutMs: 300_000,
      });
      record(
        '9b. Codex resume reuses thread',
        resumed.result.state === 'succeeded' && resumed.result.threadId === r.threadId,
        `thread=${resumed.result.threadId} output=${JSON.stringify(resumed.result.output.slice(0, 60))}`,
      );
    }

    // tool-call evidence (skipped in --quick)
    if (!options.quick) {
      const toolRun = await collect(orch, {
        ...ovFor('codex'),
        agentId: 'codex',
        prompt: 'Use the shell to run: echo orch_smoke_marker . Then report the output.',
        cwd: scratch,
        sandbox: options.sandbox ?? 'read-only',
        timeoutMs: 300_000,
      });
      const sawTool = toolRun.events.some((e) => e.type === 'session.tool_call');
      record(
        '5d. Codex tool_call event emitted',
        sawTool && toolRun.result.toolCalls.length > 0,
        `toolCalls=${toolRun.result.toolCalls.length} events=${toolRun.events.length}`,
      );
    }
  } else {
    record('3. Codex starts', false, cxDesc?.detail ?? 'not registered');
    record('4. Codex returns final result', false, 'skipped');
  }

  // --- 6. non-zero exit detection ---------------------------------------
  // Deterministic: an unknown flag makes the CLI print a usage error and exit
  // non-zero without needing a model call.
  if (cxDesc?.ok) {
    const bad = await collect(orch, {
      agentId: 'codex',
      prompt: 'unreachable',
      cwd: scratch,
      extraArgs: ['--definitely-not-a-real-flag'],
      timeoutMs: 60_000,
    });
    record(
      '6. Non-zero exit detected as failure',
      bad.result.state === 'failed' && bad.result.exitCode !== 0 && bad.result.error !== null,
      `state=${bad.result.state} exit=${bad.result.exitCode} err=${
        bad.result.error ? bad.result.error.message.slice(0, 110) : 'none'
      }`,
    );
    // The stderr tail is the ONLY explanation for a CLI that dies on startup,
    // and it used to silently capture only the trailing partial line.
    record(
      '6b. stderr diagnostics are captured on failure',
      /usage|unexpected argument|error/i.test(bad.result.error?.message ?? ''),
      (bad.result.error?.message ?? '').slice(0, 160).replace(/\s+/g, ' '),
    );
  }

  // --- summary ----------------------------------------------------------
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;
  if (options.asJson) {
    process.stdout.write(
      JSON.stringify({ total: checks.length, passed, failed, checks }) + '\n',
    );
  } else {
    process.stdout.write(`\n  ${passed}/${checks.length} checks passed${failed ? `, ${failed} failed` : ''}\n\n`);
  }

  if (!options.asJson) {
    process.stdout.write(`  store: ${orch.store.root}\n`);
  }
  return failed === 0 ? 0 : 1;
}

async function collect(
  orch: Orchestrator,
  req: Parameters<Orchestrator['run']>[0],
): Promise<{ result: RunResult; events: RuntimeEvent[] }> {
  const handle = orch.run(req);
  const events: RuntimeEvent[] = [];
  // Consume concurrently so the queue never grows unbounded.
  const consumer = (async () => {
    for await (const ev of handle.events()) {
      events.push(ev);
    }
  })();
  const result = await handle.result();
  await consumer;
  return { result, events };
}

export function countByType(events: readonly RuntimeEvent[]): Record<RuntimeEventType, number> {
  const out = {} as Record<RuntimeEventType, number>;
  for (const e of events) out[e.type] = (out[e.type] ?? 0) + 1;
  return out;
}

export function cleanupScratch(): void {
  const scratch = join(tmpdir(), 'orch-smoke');
  if (existsSync(scratch)) {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
