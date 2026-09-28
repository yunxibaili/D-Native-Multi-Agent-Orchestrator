/**
 * tests/unit.test.ts — offline checks. No model calls, no network.
 *
 * These lock in the decisions that were expensive to learn the hard way:
 * the two Windows binary problems, the two flag-set asymmetries, and the
 * "config warnings are not failures" rule.
 *
 * Run: node tests/unit.test.ts
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sanitize, RUNTIME_EVENT_TYPES, type RuntimeEvent } from '../src/core/event.ts';
import { isTerminal, type AgentAdapter, type MapContext, type RunRequest } from '../src/core/types.ts';
import { AdapterNotFoundError, CapabilityError } from '../src/core/errors.ts';
import { AdapterRegistry } from '../src/runtime/registry.ts';
import { resolveCommand } from '../src/runtime/discover.ts';
import { buildEnv } from '../src/runtime/spawn.ts';
import { createOpenCodeAdapter } from '../src/adapters/opencode.ts';
import { createCodexAdapter } from '../src/adapters/codex.ts';
import { collectSmokeStubs } from './helpers.ts';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, `got ${a}, want ${b}`);
}

function section(title: string): void {
  process.stdout.write(`\n${title}\n`);
}

// A sink that records what an adapter reported, standing in for the runtime.
function makeSink() {
  const texts: string[] = [];
  const tools: string[] = [];
  const diags: string[] = [];
  const terminal: string[] = [];
  let thread: string | null = null;
  const usage: unknown[] = [];
  const ctx: MapContext = {
    taskId: 'tsk_test',
    agentId: 'test',
    threadId: null,
    sink: {
      noteThreadId: (id) => {
        if (!thread) thread = id;
      },
      noteText: (t) => texts.push(t),
      noteToolCall: (c) => tools.push(c.name),
      noteUsage: (u) => usage.push(u),
      noteDiagnostic: (d) => diags.push(d),
      noteNativeTerminal: (s) => terminal.push(s.reason),
    },
  };
  return { ctx, texts, tools, diags, terminal, usage, getThread: () => thread };
}

const REQ: RunRequest = {
  agentId: 'x',
  prompt: 'hello',
  cwd: process.cwd(),
};

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
  const out = sanitize(circular) as Record<string, unknown>;
  check('circular refs do not throw', out.self === '[circular]');
  check('BigInt survives as string', (sanitize({ n: 10n }) as { n: string }).n === '10');
  check('NaN/Infinity survive as string', (sanitize({ n: NaN }) as { n: string }).n === 'NaN');
  check('undefined becomes null (JSON-safe)', (sanitize({ a: undefined }) as { a: unknown }).a === null);
  {
    // MAX_DEPTH is 12. Values inside the limit survive intact; anything past
    // it is marked, so a consumer can tell "truncated" from "absent".
    const nearLimit: unknown = 'kept';
    let deep = nearLimit;
    for (let i = 0; i < 9; i++) deep = { nested: deep };
    check('value inside the depth limit survives', JSON.stringify(sanitize(deep)).includes('kept'));

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
      const ev = {
        type: t,
        taskId: 'a',
        agentId: 'b',
        threadId: null,
        at: 1,
        raw: { x: 1 },
      } as RuntimeEvent;
      return JSON.parse(JSON.stringify(ev)).type === t;
    }),
  );
}

// ---- 2. terminal states -------------------------------------------------

section('terminal states');
{
  check('running is not terminal', !isTerminal('running'));
  check('succeeded is terminal', isTerminal('succeeded'));
  check('failed is terminal', isTerminal('failed'));
  check('cancelled is terminal', isTerminal('cancelled'));
  check('timeout is terminal', isTerminal('timeout'));
}

// ---- 3. OpenCode adapter, against real captured events -------------------

section('opencode adapter');
{
  const adapter = createOpenCodeAdapter({
    executable: join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
  });

  eq('capability matrix', { ...adapter.descriptor.capabilities }, {
    newTask: true,
    resume: true,
    fork: true,
    review: false,
    worktree: false,
    stdinPrompt: false,
    sandbox: false,
    streamEvents: true,
    roleSelection: true,
    costReporting: true,
    steering: false,
  });

  const inv = adapter.buildInvocation({
    ...REQ,
    agentId: 'opencode',
    prompt: 'do the thing',
    model: 'opencode/space-bunny-free',
    role: 'build',
    threadId: 'ses_abc',
  });
  eq('argv shape', inv.args, [
    'run',
    'do the thing',
    '--format',
    'json',
    '--dir',
    process.cwd(),
    '--model',
    'opencode/space-bunny-free',
    '--agent',
    'build',
    '--session',
    'ses_abc',
  ]);
  check('prompt goes on argv, not stdin', inv.promptVia === 'argv');

  // Real captured: text event
  {
    const s = makeSink();
    const evs = adapter.mapEvent(
      {
        type: 'text',
        timestamp: 1,
        sessionID: 'ses_f19bb7780ffe9Hakwo40h2udDg',
        part: { type: 'text', text: 'PONG' },
      },
      s.ctx,
    );
    eq('text -> one output event', evs.map((e) => e.type), ['session.output']);
    eq('text is accumulated for the final result', s.texts, ['PONG']);
    eq('thread id learned from any event', s.getThread(), 'ses_f19bb7780ffe9Hakwo40h2udDg');
    check('raw payload is preserved verbatim', evs[0]!.raw !== undefined);
  }

  // Real captured: tool_use event
  {
    const s = makeSink();
    const evs = adapter.mapEvent(
      {
        type: 'tool_use',
        timestamp: 2,
        sessionID: 'ses_x',
        part: {
          type: 'tool',
          tool: 'bash',
          callID: 'call_function_f1f7',
          state: {
            status: 'completed',
            input: { command: 'echo hi_from_tool' },
            output: 'hi_from_tool\r\n',
            metadata: { output: 'hi_from_tool\r\n', exit: 0, truncated: false },
            title: 'echo hi_from_tool',
          },
        },
      },
      s.ctx,
    );
    eq('tool_use -> tool_call event', evs.map((e) => e.type), ['session.tool_call']);
    eq('tool name extracted', s.tools, ['bash']);
    const tool = (evs[0]!.data as { tool: { input: unknown; exitCode: number } }).tool;
    eq('tool input preserved', tool.input, { command: 'echo hi_from_tool' });
    eq('tool exit code preserved', tool.exitCode, 0);
  }

  // Real captured: step_finish with usage
  {
    const s = makeSink();
    adapter.mapEvent(
      {
        type: 'step_finish',
        timestamp: 3,
        sessionID: 'ses_x',
        part: {
          reason: 'stop',
          tokens: { total: 37036, input: 35093, output: 3, reasoning: 0, cache: { write: 0, read: 1940 } },
          cost: 0,
        },
      },
      s.ctx,
    );
    check('usage extracted from step_finish', s.usage.length === 1);
  }

  // Real captured: the APIError that made the default model fail
  {
    const s = makeSink();
    const evs = adapter.mapEvent(
      {
        type: 'error',
        timestamp: 4,
        sessionID: 'ses_x',
        error: {
          name: 'APIError',
          data: {
            message: 'Cannot connect to API: Unable to connect.',
            isRetryable: true,
            metadata: { url: 'http://127.0.0.1:11435/v1/chat/completions' },
          },
        },
      },
      s.ctx,
    );
    eq('native error -> diagnostic (not session.failed)', evs.map((e) => e.type), ['session.diagnostic']);
    eq('diagnostic recorded', s.diags.length, 1);
    eq('native terminal marked unsuccessful', s.terminal.length, 1);
    check('failing URL appears in the diagnostic', s.diags[0]!.includes('11435'));
  }

  // reasoning must not pollute the answer
  {
    const s = makeSink();
    const evs = adapter.mapEvent(
      { type: 'reasoning', sessionID: 'ses_x', part: { type: 'reasoning', text: 'thinking hard' } },
      s.ctx,
    );
    eq('reasoning -> progress', evs.map((e) => e.type), ['session.progress']);
    eq('reasoning is NOT added to final output', s.texts.length, 0);
  }

  // unknown native type must be surfaced, not swallowed
  {
    const s = makeSink();
    const evs = adapter.mapEvent({ type: 'brand_new_event', sessionID: 'ses_x' }, s.ctx);
    eq('unknown native type still emits an event', evs.map((e) => e.type), ['session.progress']);
    check(
      'unknown type is labelled, not dropped',
      (evs[0]!.data as { nativeType: string }).nativeType === 'brand_new_event',
    );
  }
}

// ---- 4. Codex adapter, against real captured events ---------------------

section('codex adapter');
{
  const adapter = createCodexAdapter({
    executable: join(homedir(), '.codex', 'plugins', '.plugin-appserver', 'codex.exe'),
  });

  eq('capability matrix', { ...adapter.descriptor.capabilities }, {
    newTask: true,
    resume: true,
    fork: true,
    review: true,
    worktree: true,
    stdinPrompt: true,
    sandbox: true,
    streamEvents: true,
    roleSelection: true,
    costReporting: false,
    steering: false,
  });

  // argv asymmetry: `exec`, `exec resume` and `exec review` each accept a
  // DIFFERENT flag set. Passing an unsupported flag is a clap error, exit 2.
  {
    const fresh = adapter.buildInvocation({ ...REQ, agentId: 'codex', prompt: 'hi', sandbox: 'read-only' });
    check('fresh run uses --color never', fresh.args.includes('--color') && fresh.args.includes('never'));
    check('fresh run accepts -s sandbox', fresh.args.includes('--sandbox'));
    check('fresh run passes -C', fresh.args.includes('-C'));
    check('fresh run always asks for JSONL', fresh.args.includes('--json'));
    // Regression guard: an empty placeholder subcommand once became the prompt
    // and made the real prompt an "unexpected argument" (exit 2).
    check('fresh run has no empty-string argument', !fresh.args.includes(''), JSON.stringify(fresh.args));
    check('fresh run puts the prompt immediately after "exec"', fresh.args[1] === 'hi', fresh.args[1] ?? 'undefined');
    check('fresh run does not use a subcommand', fresh.args[1] !== 'resume' && fresh.args[1] !== 'review');
  }
  {
    const resumed = adapter.buildInvocation({
      ...REQ,
      agentId: 'codex',
      prompt: 'continue',
      threadId: '01a0e644-d1f6-7d32-ba53-812ae684b6eb',
      sandbox: 'read-only',
    });
    check('resume uses the resume subcommand', resumed.args[1] === 'resume');
    check('resume passes the thread id', resumed.args[2] === '01a0e644-d1f6-7d32-ba53-812ae684b6eb');
    check('resume does NOT pass --color (clap exits 2)', !resumed.args.includes('--color'));
    check('resume does NOT pass --sandbox (clap exits 2)', !resumed.args.includes('--sandbox'));
    check('resume does NOT pass -C (clap exits 2)', !resumed.args.includes('-C'));
    check('resume still asks for JSONL', resumed.args.includes('--json'));
  }
  {
    const rev = adapter.buildInvocation({
      ...REQ,
      agentId: 'codex',
      prompt: 'look at this',
      mode: 'review',
      sandbox: 'read-only',
    });
    check('review uses the review subcommand', rev.args[1] === 'review');
    check('review puts the prompt after the subcommand', rev.args[2] === 'look at this', rev.args[2] ?? 'undefined');
    check('review does NOT pass --color (clap exits 2)', !rev.args.includes('--color'));
    check('review does NOT pass --sandbox (clap exits 2)', !rev.args.includes('--sandbox'));
    check('review does NOT pass -C (clap exits 2)', !rev.args.includes('-C'));
    check('review still asks for JSONL', rev.args.includes('--json'));
  }
  {
    // A resume request must not be silently downgraded to a fresh run.
    const both = adapter.buildInvocation({
      ...REQ,
      agentId: 'codex',
      prompt: 'x',
      mode: 'review',
      threadId: 'abc',
    });
    check('review wins over resume when both are requested', both.args[1] === 'review');
  }

  // Real captured: thread.started
  {
    const s = makeSink();
    const evs = adapter.mapEvent({ type: 'thread.started', thread_id: '01a0e644-d1f6-7d32-ba53-812ae684b6eb' }, s.ctx);
    eq('thread.started -> progress', evs.map((e) => e.type), ['session.progress']);
    eq('thread_id becomes the thread', s.getThread(), '01a0e644-d1f6-7d32-ba53-812ae684b6eb');
  }

  // THE trap: item.type === 'error' on a SUCCESSFUL run.
  {
    const s = makeSink();
    const evs = adapter.mapEvent(
      {
        type: 'item.completed',
        item: {
          id: 'item_0',
          type: 'error',
          message:
            'Codex is ignoring 1 unrecognized configuration setting. Check for typos or deprecated settings.\n  user (C:\\Users\\Admin\\.codex\\config.toml): `disable_response_storage` is ignored.',
        },
      },
      s.ctx,
    );
    eq('config warning is a DIAGNOSTIC, never session.failed', evs.map((e) => e.type), ['session.diagnostic']);
    eq('config warning is recorded as a diagnostic', s.diags.length, 1);
    check('config warning does not mark the run unsuccessful', s.terminal.length === 0);
  }

  // Real captured: agent_message
  {
    const s = makeSink();
    const evs = adapter.mapEvent(
      { type: 'item.completed', item: { id: 'item_5', type: 'agent_message', text: 'PONG' } },
      s.ctx,
    );
    eq('agent_message -> output', evs.map((e) => e.type), ['session.output']);
    eq('agent_message text accumulated', s.texts, ['PONG']);
  }

  // Real captured: command_execution, both started and completed
  {
    const s1 = makeSink();
    adapter.mapEvent(
      {
        type: 'item.started',
        item: {
          id: 'item_5',
          type: 'command_execution',
          command: "powershell.exe -Command 'echo hi'",
          aggregated_output: '',
          exit_code: null,
          status: 'in_progress',
        },
      },
      s1.ctx,
    );
    eq('item.started does not register a tool call', s1.tools.length, 0);

    const s2 = makeSink();
    const evs = adapter.mapEvent(
      {
        type: 'item.completed',
        item: {
          id: 'item_5',
          type: 'command_execution',
          command: "powershell.exe -Command 'echo hi'",
          aggregated_output: 'hi_from_codex_tool\r\n',
          exit_code: 0,
          status: 'completed',
        },
      },
      s2.ctx,
    );
    eq('command_execution -> tool_call', evs.map((e) => e.type), ['session.tool_call']);
    eq('shell tool named', s2.tools, ['shell']);
    const tool = (evs[0]!.data as { tool: { exitCode: number; output: string } }).tool;
    eq('shell exit code preserved', tool.exitCode, 0);
    check('shell output preserved with CRLF', tool.output.includes('hi_from_codex_tool'));
  }

  // Real captured: turn.completed usage. Codex reports NO cost.
  {
    const s = makeSink();
    adapter.mapEvent(
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 20209,
          cached_input_tokens: 18176,
          cache_write_input_tokens: 0,
          output_tokens: 109,
          reasoning_output_tokens: 16,
        },
      },
      s.ctx,
    );
    const u = s.usage[0] as { inputTokens: number; costUsd?: number };
    check('usage extracted', s.usage.length === 1);
    eq('input tokens', u.inputTokens, 20209);
    check('no cost is invented for codex', u.costUsd === undefined);
  }

  // reasoning must not become a tool call
  {
    const s = makeSink();
    const evs = adapter.mapEvent(
      { type: 'item.completed', item: { id: 'item_4', type: 'reasoning', text: 'Need answer exactly PONG.' } },
      s.ctx,
    );
    eq('reasoning -> progress', evs.map((e) => e.type), ['session.progress']);
    eq('reasoning is not a tool call', s.tools.length, 0);
    eq('reasoning is not final output', s.texts.length, 0);
  }
}

// ---- 5. discovery (the two Windows traps) -------------------------------

section('binary discovery');
{
  // Trap 1: `opencode` on PATH is a .ps1 shim Node cannot exec.
  const shim = join(process.env.APPDATA ?? '', 'npm', 'opencode.ps1');
  if (existsSync(shim)) {
    check('the opencode.ps1 shim really exists (premise holds)', true, shim);
    const found = resolveCommand('opencode');
    check(
      'resolution returns an executable, not a script',
      /\.(exe|cmd|bat|com)$/i.test(found.command),
      found.command,
    );
    check('resolution explains how it found it', found.via.length > 0, found.via);
  } else {
    check('opencode.ps1 shim not present on this machine (skipped)', true);
  }

  // Trap 2: codex is not on PATH.
  const onPath = (process.env.PATH ?? '')
    .split(';')
    .some((d) => d && existsSync(join(d, 'codex.exe')));
  check('premise: codex is genuinely absent from PATH', !onPath);
  const cx = resolveCommand('codex');
  check('codex resolves even though it is not on PATH', existsSync(cx.command), cx.command);
  check('codex resolution path is absolute', cx.command.includes(':') || cx.command.startsWith('/'));

  let threw = false;
  try {
    resolveCommand('definitely-not-an-agent-xyz');
  } catch (e) {
    threw = true;
    check('unknown agent throws an actionable error', (e as Error).message.includes('orchestrator.json'));
  }
  check('unknown agent did throw', threw);
}

// ---- 6. env hygiene -----------------------------------------------------

section('env hygiene');
{
  const env = buildEnv();
  check('PATH is forwarded (Windows child would break without it)', env.PATH !== undefined);
  check('SystemRoot is forwarded', env.SYSTEMROOT !== undefined);
  check('TEMP is forwarded', env.TEMP !== undefined);
  check('NO_COLOR defaults to 1', env.NO_COLOR === '1');
  check('an OpenAI key is not force-injected', env.OPENAI_API_KEY === undefined);
  const withExtra = buildEnv({ MY_FLAG: '1' });
  check('explicit extra env is merged', withExtra.MY_FLAG === '1');
}

// ---- 7. registry / capability gate --------------------------------------

section('registry and capability gate');
{
  const reg = new AdapterRegistry();
  const stub: AgentAdapter = collectSmokeStubs();
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

  check('CapabilityError is actionable', new CapabilityError('codex', 'review').message.includes('doctor'));
}

// ---- summary ------------------------------------------------------------

process.stdout.write(`\n${passed} passed, ${failed} failed\n\n`);
process.exitCode = failed === 0 ? 0 : 1;
