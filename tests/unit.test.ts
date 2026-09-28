/**
 * tests/unit.test.ts --adapter event mapping and env hygiene.
 *
 * Offline: no model calls, no network. Contract-level behaviour (state
 * machine, hub, resume ownership, capabilities) lives in contract.test.ts.
 *
 * Run: node tests/unit.test.ts
 */

import { sanitize, RUNTIME_EVENT_TYPES, type RuntimeEvent } from '../src/core/event.ts';
import {
  isTerminal,
  type AgentAdapter,
  type LauncherSpec,
  type RunRequest,
  type TransportFrame,
} from '../src/core/types.ts';
import { AdapterNotFoundError } from '../src/core/errors.ts';
import { AdapterRegistry } from '../src/runtime/registry.ts';
import { buildEnv } from '../src/runtime/spawn.ts';
import { createOpenCodeAdapter } from '../src/adapters/opencode.ts';
import { createCodexAdapter } from '../src/adapters/codex.ts';
import { recordingSink, createFakeAdapter } from './helpers.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed++;
    failures.push(name);
    process.stdout.write(`  FAIL ${name}${detail ? ` --${detail}` : ''}\n`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, `got ${a}, want ${b}`);
}

function section(t: string): void {
  process.stdout.write(`\n${t}\n`);
}

const OPENCODE_EXE = 'C:/fake/opencode.exe';
const CODEX_EXE = 'C:/fake/codex.exe';

/**
 * Tests below exercise pure event mapping and argv construction, so they use a
 * stub launcher and NEVER touch the filesystem. This is deliberate: `npm test`
 * must not depend on whether OpenCode or Codex happens to be installed. Real
 * binary resolution is covered by fixture-based discovery tests in
 * contract.test.ts, and end-to-end by the smoke suite.
 */
const OPENCODE_LAUNCHER: LauncherSpec = {
  kind: 'native',
  command: OPENCODE_EXE,
  prefixArgs: [],
  target: OPENCODE_EXE,
  buildsCommandString: false,
};
const CODEX_LAUNCHER: LauncherSpec = {
  kind: 'native',
  command: CODEX_EXE,
  prefixArgs: [],
  target: CODEX_EXE,
  buildsCommandString: false,
};

/** Wrap a native payload the way the CLI transport would. */
function frame(data: unknown, channel: 'stdout' | 'stderr' = 'stdout'): TransportFrame {
  return { channel, text: typeof data === 'string' ? data : JSON.stringify(data), data };
}

const REQ: RunRequest = { agentId: 'x', prompt: 'hello', cwd: '/tmp' };

// ---- 1. event model -----------------------------------------------------

section('event model');
{
  eq('event type list is the documented set', [...RUNTIME_EVENT_TYPES], [
    'session.started',
    'session.output',
    'session.progress',
    'session.tool_call',
    'session.diagnostic',
    'session.completed',
    'session.failed',
    'session.cancelled',
  ]);

  const circular: Record<string, unknown> = { a: 1 };
  circular.self = circular;
  check('circular refs do not throw', (sanitize(circular) as Record<string, unknown>).self === '[circular]');
  check('BigInt survives as string', (sanitize({ n: 10n }) as { n: string }).n === '10');
  check('NaN survives as string', (sanitize({ n: NaN }) as { n: string }).n === 'NaN');
  check('undefined becomes null (JSON-safe)', (sanitize({ a: undefined }) as { a: unknown }).a === null);
  {
    let near: unknown = 'kept';
    for (let i = 0; i < 9; i++) near = { nested: near };
    check('value inside the depth limit survives', JSON.stringify(sanitize(near)).includes('kept'));

    let tooDeep: unknown = 'dropped';
    for (let i = 0; i < 30; i++) tooDeep = { nested: tooDeep };
    const text = JSON.stringify(sanitize(tooDeep));
    check('over-deep nesting is marked as truncated', text.includes('max-depth'));
    check('over-deep value is honestly absent, not silently wrong', !text.includes('dropped'));
  }
  const err = sanitize({ e: new TypeError('boom') }) as { e: { name: string } };
  check('Error is serialized to name/message', err.e.name === 'TypeError');
  check(
    'every runtime event is JSON round-trippable',
    RUNTIME_EVENT_TYPES.every((t) => {
      const ev = { type: t, taskId: 'a', agentId: 'b', threadId: null, at: 1, raw: { x: 1 } } as RuntimeEvent;
      return JSON.parse(JSON.stringify(ev)).type === t;
    }),
  );
}

// ---- 2. terminal states -------------------------------------------------

section('terminal states');
{
  check('running is not terminal', !isTerminal('running'));
  for (const s of ['succeeded', 'failed', 'cancelled', 'timed_out'] as const) {
    check(`${s} is terminal`, isTerminal(s));
  }
}

// ---- 3. OpenCode adapter -------------------------------------------------

section('opencode adapter');
{
  const adapter = createOpenCodeAdapter({ launcher: OPENCODE_LAUNCHER });
  eq('capability matrix is honest', { ...adapter.descriptor.capabilities }, {
    newTask: true,
    resume: true,
    review: false,
    modelSelection: true,
    roleSelection: true,
    sandbox: false,
    streamEvents: true,
    costReporting: true,
    extraArgs: true,
    cwd: true,
    steering: false,
    worktree: false,
    fork: false,
    stdinPrompt: false,
  });

  // The transport is where argv lives now.
  const tr = adapter.createTransport({
    ...REQ,
    agentId: 'opencode',
    model: 'opencode/space-bunny-free',
    role: 'build',
    threadId: 'ses_abc',
  });
  check('transport kind is cli-jsonl', tr.kind === 'cli-jsonl', tr.kind);
  check('argv contains run + prompt + --format json',
    tr.commandLine.includes('run') && tr.commandLine.includes('hello') && tr.commandLine.includes('--format') && tr.commandLine.includes('json'),
    tr.commandLine);
  check('argv contains --session for a resume', tr.commandLine.includes('--session') && tr.commandLine.includes('ses_abc'));
  check('argv contains --dir and the cwd', tr.commandLine.includes('--dir') && tr.commandLine.includes('/tmp'));
  check('argv contains --model and --agent', tr.commandLine.includes('--model') && tr.commandLine.includes('--agent'));

  {
    const s = recordingSink();
    const evs = adapter.mapEvent(
      frame({ type: 'text', timestamp: 1, sessionID: 'ses_f19b', part: { type: 'text', text: 'PONG' } }),
      s.ctx,
    );
    eq('text -> one output event', evs.map((e) => e.type), ['session.output']);
    eq('text is accumulated', s.texts, ['PONG']);
    eq('thread id learned from any frame', s.thread, 'ses_f19b');
    check('raw payload preserved', evs[0]!.raw !== undefined);
  }

  {
    const s = recordingSink();
    const evs = adapter.mapEvent(
      frame({
        type: 'tool_use',
        sessionID: 'ses_x',
        part: {
          type: 'tool',
          tool: 'bash',
          callID: 'call_function_f1f7',
          state: { status: 'completed', input: { command: 'echo hi_from_tool' }, output: 'hi_from_tool\r\n', metadata: { exit: 0 } },
        },
      }),
      s.ctx,
    );
    eq('tool_use -> tool_call', evs.map((e) => e.type), ['session.tool_call']);
    eq('tool name extracted', s.tools.map((t) => t.name), ['bash']);
    const tool = (evs[0]!.data as { tool: { input: unknown; exitCode: number } }).tool;
    eq('tool input preserved', tool.input, { command: 'echo hi_from_tool' });
    eq('tool exit code preserved', tool.exitCode, 0);
  }

  {
    const s = recordingSink();
    adapter.mapEvent(
      frame({ type: 'step_finish', sessionID: 'ses_x', part: { reason: 'stop', tokens: { total: 37036, input: 35093, output: 3, reasoning: 0, cache: { read: 1940 } }, cost: 0 } }),
      s.ctx,
    );
    check('usage extracted from step_finish', s.usage.length === 1, `${s.usage.length}`);
  }

  {
    // The real failure that made the default model blow up.
    const s = recordingSink();
    const evs = adapter.mapEvent(
      frame({
        type: 'error',
        sessionID: 'ses_x',
        error: { name: 'APIError', data: { message: 'Cannot connect to API: Unable to connect.', metadata: { url: 'http://127.0.0.1:11435/v1/chat/completions' } } },
      }),
      s.ctx,
    );
    eq('native error -> diagnostic', evs.map((e) => e.type), ['session.diagnostic']);
    eq('error recorded as a diagnostic', s.diags.length, 1);
    eq('error recorded as a native signal for the policy', s.signals.length, 1);
    check('failing URL appears in the diagnostic', s.diags[0]!.includes('11435'));
  }

  {
    const s = recordingSink();
    const evs = adapter.mapEvent(frame({ type: 'reasoning', sessionID: 'ses_x', part: { type: 'reasoning', text: 'thinking hard' } }), s.ctx);
    eq('reasoning -> progress', evs.map((e) => e.type), ['session.progress']);
    eq('reasoning is NOT added to final output', s.texts.length, 0);
  }

  {
    const s = recordingSink();
    const evs = adapter.mapEvent(frame({ type: 'brand_new_event', sessionID: 'ses_x' }), s.ctx);
    eq('unknown native type still emits an event', evs.map((e) => e.type), ['session.progress']);
    check('unknown type is labelled, not dropped', (evs[0]!.data as { nativeType: string }).nativeType === 'brand_new_event');
  }

  // Terminal policy is the adapter's, not the runtime's.
  {
    const p = adapter.terminalPolicy;
    const ok = {
      code: 0,
      signal: null,
      stderrTail: '',
      stderrTruncated: false,
      cleanup: { rootKilled: false, descendantsReaped: false, note: 'root already exited' },
    };
    const bad = {
      code: 2,
      signal: null,
      stderrTail: 'boom',
      stderrTruncated: false,
      cleanup: { rootKilled: false, descendantsReaped: false, note: 'root already exited' },
    };
    eq('exit 0 => succeeded', p({ exit: ok, nativeSignals: [], localAbort: null }), { state: 'succeeded', error: null });
    const f = p({ exit: bad, nativeSignals: [], localAbort: null });
    check('non-zero => failed', f.state === 'failed');
    check('failure carries an error code', f.error?.code === 'NONZERO_EXIT', JSON.stringify(f.error));
    // An error frame with exit 0 stays successful: exit code is ground truth.
    const w = p({ exit: ok, nativeSignals: ['error: APIError: x'], localAbort: null });
    eq('error frame + exit 0 is still succeeded', w.state, 'succeeded');
    // Cleanup is informational and must never alter the outcome.
    const withCleanup = p({
      exit: { ...ok, cleanup: { rootKilled: true, descendantsReaped: true, note: 'killed' } },
      nativeSignals: [],
      localAbort: null,
    });
    eq('cleanup never changes a successful outcome', withCleanup.state, 'succeeded');
  }
}

// ---- 4. Codex adapter ---------------------------------------------------

section('codex adapter');
{
  const adapter = createCodexAdapter({ launcher: CODEX_LAUNCHER });
  eq('capability matrix is honest', { ...adapter.descriptor.capabilities }, {
    newTask: true,
    resume: true,
    review: true,
    modelSelection: true,
    roleSelection: true,
    sandbox: true,
    streamEvents: true,
    costReporting: false,
    extraArgs: true,
    cwd: true,
    steering: false,
    worktree: false,
    fork: false,
    stdinPrompt: false,
  });

  // The three flag profiles. Passing an unsupported flag is a clap error, exit 2.
  const line = (req: RunRequest): string => adapter.createTransport(req).commandLine;

  {
    const l = line({ ...REQ, agentId: 'codex', prompt: 'hi', sandbox: 'read-only' });
    check('fresh run passes --color never', l.includes('--color') && l.includes('never'), l);
    check('fresh run passes --sandbox', l.includes('--sandbox') && l.includes('read-only'));
    check('fresh run passes -C', l.includes('-C'));
    check('fresh run asks for JSONL', l.includes('--json'));
    check('fresh run has no subcommand', !/\bexec (resume|review)\b/.test(l), l);
    // Regression guard: an empty placeholder subcommand once became the prompt.
    check('fresh run has no stray empty argument', !/\s\s/.test(l), l);
  }
  {
    // No sandbox here: `exec resume` genuinely rejects -s, and the adapter now
    // refuses the combination up front instead of building a doomed argv.
    const l = line({ ...REQ, agentId: 'codex', prompt: 'x', threadId: '01a0e644-d1f6' });
    check('resume uses the resume subcommand', l.includes('resume'));
    check('resume passes the thread id', l.includes('01a0e644-d1f6'));
    check('resume does NOT pass --color', !l.includes('--color'), l);
    check('resume does NOT pass --sandbox', !l.includes('--sandbox'), l);
    check('resume does NOT pass -C', !l.includes(' -C'), l);
    check('resume still asks for JSONL', l.includes('--json'));
  }
  {
    const l = line({ ...REQ, agentId: 'codex', prompt: 'look', mode: 'review' });
    check('review uses the review subcommand', l.includes('review'));
    check('review does NOT pass --color', !l.includes('--color'), l);
    check('review does NOT pass --sandbox', !l.includes('--sandbox'), l);
    check('review does NOT pass -C', !l.includes(' -C'), l);
  }
  {
    // The capability guarantee, from the argv side.
    let refusedResume = false;
    try {
      adapter.createTransport({ ...REQ, agentId: 'codex', prompt: 'x', threadId: 't1', sandbox: 'read-only' });
    } catch (e) {
      refusedResume = (e as { name?: string }).name === 'UnsupportedOptionError';
    }
    check('sandbox+resume is refused before any argv is built', refusedResume);

    let refusedReview = false;
    try {
      adapter.createTransport({ ...REQ, agentId: 'codex', prompt: 'x', mode: 'review', sandbox: 'read-only' });
    } catch (e) {
      refusedReview = (e as { name?: string }).name === 'UnsupportedOptionError';
    }
    check('sandbox+review is refused before any argv is built', refusedReview);
  }

  // The regression: an empty placeholder subcommand became the prompt.
  {
    const l = line({ ...REQ, agentId: 'codex', prompt: 'hi' });
    check('fresh run puts the prompt directly after "exec"', /codex\.exe\s+exec\s+hi\s/.test(l), l);
  }

  {
    const s = recordingSink();
    adapter.mapEvent(frame({ type: 'thread.started', thread_id: '01a0e644-d1f6-7d32-ba53-812ae684b6eb' }), s.ctx);
    eq('thread.started records the thread id', s.thread, '01a0e644-d1f6-7d32-ba53-812ae684b6eb');
  }

  {
    // THE trap: item.type === 'error' on a SUCCESSFUL run.
    const s = recordingSink();
    const evs = adapter.mapEvent(
      frame({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Codex is ignoring 1 unrecognized configuration setting.' } }),
      s.ctx,
    );
    eq('config warning is a DIAGNOSTIC, never session.failed', evs.map((e) => e.type), ['session.diagnostic']);
    eq('config warning is recorded as a diagnostic', s.diags.length, 1);
    check('config warning does NOT mark the run unsuccessful', s.signals.length === 0);
  }

  {
    const s = recordingSink();
    const evs = adapter.mapEvent(frame({ type: 'item.completed', item: { id: 'item_5', type: 'agent_message', text: 'PONG' } }), s.ctx);
    eq('agent_message -> output', evs.map((e) => e.type), ['session.output']);
    eq('agent_message text accumulated', s.texts, ['PONG']);
  }

  {
    const s1 = recordingSink();
    adapter.mapEvent(
      frame({ type: 'item.started', item: { id: 'item_5', type: 'command_execution', command: "powershell.exe -Command 'echo hi'", aggregated_output: '', exit_code: null, status: 'in_progress' } }),
      s1.ctx,
    );
    eq('item.started does not register a tool call', s1.tools.length, 0);

    const s2 = recordingSink();
    const evs = adapter.mapEvent(
      frame({ type: 'item.completed', item: { id: 'item_5', type: 'command_execution', command: "powershell.exe -Command 'echo hi'", aggregated_output: 'hi\r\n', exit_code: 0, status: 'completed' } }),
      s2.ctx,
    );
    eq('command_execution -> tool_call', evs.map((e) => e.type), ['session.tool_call']);
    eq('shell tool named', s2.tools.map((t) => t.name), ['shell']);
    const tool = (evs[0]!.data as { tool: { exitCode: number; output: string } }).tool;
    eq('shell exit code preserved', tool.exitCode, 0);
    check('shell output preserved with CRLF', tool.output.includes('hi'));
  }

  {
    const s = recordingSink();
    adapter.mapEvent(
      frame({ type: 'turn.completed', usage: { input_tokens: 20209, cached_input_tokens: 18176, cache_write_input_tokens: 0, output_tokens: 109, reasoning_output_tokens: 16 } }),
      s.ctx,
    );
    const u = s.usage[0] as { inputTokens: number; costUsd?: number };
    check('usage extracted', s.usage.length === 1);
    eq('input tokens', u.inputTokens, 20209);
    check('no cost is invented for codex', u.costUsd === undefined);
  }

  {
    const s = recordingSink();
    const evs = adapter.mapEvent(frame({ type: 'item.completed', item: { id: 'item_4', type: 'reasoning', text: 'Need answer exactly PONG.' } }), s.ctx);
    eq('reasoning -> progress', evs.map((e) => e.type), ['session.progress']);
    eq('reasoning is not a tool call', s.tools.length, 0);
    eq('reasoning is not final output', s.texts.length, 0);
  }
}

// ---- 5. env hygiene -----------------------------------------------------

section('env hygiene');
{
  const env = buildEnv();
  check('PATH is forwarded', env.PATH !== undefined);
  check('SystemRoot is forwarded', env.SYSTEMROOT !== undefined);
  check('TEMP is forwarded', env.TEMP !== undefined);
  check('NO_COLOR defaults to 1', env.NO_COLOR === '1');
  check('an OpenAI key is not force-injected', env.OPENAI_API_KEY === undefined);
  check('explicit extra env is merged', buildEnv({ MY_FLAG: '1' }).MY_FLAG === '1');
}

// ---- 6. registry --------------------------------------------------------

section('registry');
{
  const reg = new AdapterRegistry();
  const stub: AgentAdapter = createFakeAdapter({ id: 'stub-agent' });
  reg.register(stub);
  check('registered ids are listed', reg.ids().includes('stub-agent'), reg.ids().join(','));
  let duplicate = false;
  try {
    reg.register(stub);
  } catch {
    duplicate = true;
  }
  check('double registration is rejected', duplicate);
  let notFound = false;
  try {
    reg.get('nope');
  } catch (e) {
    notFound = e instanceof AdapterNotFoundError;
    check('error lists the available agents', (e as Error).message.includes('stub-agent'));
  }
  check('unknown adapter throws AdapterNotFoundError', notFound);
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
process.stdout.write('\n');
process.exitCode = failed === 0 ? 0 : 1;
