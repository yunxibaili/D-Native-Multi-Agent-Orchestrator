/**
 * tests/cline.test.ts — hermetic Cline adapter tests.
 *
 * Nothing here spawns the real sidecar: discovery is observed as a machine
 * fact (skip when absent), the protocol is exercised against an in-memory
 * WebSocket double, and stream/terminal behaviour is asserted through pure
 * `mapEvent` / `terminalPolicy` calls with a recording sink. `npm test` stays
 * machine-independent.
 *
 * Run: node tests/cline.test.ts
 */

import {
  InvalidRequestError,
  UnsupportedOptionError,
} from '../src/core/errors.ts';
import type {
  AgentAdapter,
  LauncherSpec,
  RunRequest,
  TerminalInput,
  TransportFrame,
} from '../src/core/types.ts';
import { resolveCommand } from '../src/runtime/discover.ts';
import {
  EVIDENCE_DONE,
  EVIDENCE_OUTPUT,
  createClineAdapter,
} from '../src/adapters/cline.ts';
import { ADAPTER_FACTORIES, knownAgentIds } from '../src/adapters/index.ts';
import { CLINE_TRUSTED_ORIGIN, ClineSocket, parseClineReady } from '../src/runtime/transport/cline.ts';
import { recordingSink } from './helpers.ts';

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

function section(t: string): void {
  process.stdout.write(`\n${t}\n`);
}

function skip(name: string, why: string): void {
  process.stdout.write(`  skip ${name} -- ${why}\n`);
}

function stubLauncher(): LauncherSpec {
  return {
    kind: 'native',
    command: 'C:/fake/code-sidecar.exe',
    prefixArgs: [],
    target: 'C:/fake/code-sidecar.exe',
    buildsCommandString: false,
  };
}

/** Adapter with a stub launcher: no discovery, no spawn, pure logic. */
function cl(): AgentAdapter {
  return createClineAdapter({ launcher: stubLauncher() });
}

function caught(fn: () => unknown): { err: Error | null } {
  try {
    fn();
    return { err: null };
  } catch (e) {
    return { err: e as Error };
  }
}

/** A WS frame exactly as the sidecar pushes it. */
function eventFrame(name: string, payload: Record<string, unknown>): TransportFrame {
  const msg = { type: 'event', event: { name, payload } };
  return { channel: 'protocol', text: JSON.stringify(msg), data: msg };
}

function chatFrame(stream: string, chunk: unknown, sessionId = 'sid_1'): TransportFrame {
  return eventFrame('chat_event', { stream, chunk, sessionId, environmentId: 'local' });
}

const EXIT_NONE = {
  code: null,
  signal: 'SIGTERM',
  stderrTail: '',
  stderrTruncated: false,
  cleanup: { rootKilled: false, descendantsReaped: false, note: 'tree kill after turn' },
} as const;

function tin(over: Partial<TerminalInput>): TerminalInput {
  return {
    exit: { ...EXIT_NONE, cleanup: { ...EXIT_NONE.cleanup } },
    nativeSignals: [],
    localAbort: null,
    ...over,
  };
}

function req(over: Partial<RunRequest> = {}): RunRequest {
  return { agentId: 'cline', prompt: 'p', cwd: 'C:/ws', ...over };
}

const adapter = cl();

// =========================================================================
// 1. REGISTRY / IDENTITY
// =========================================================================

section('1. registry and identity');

check('knownAgentIds contains cline', knownAgentIds().includes('cline'));
check('factory table exposes cline', typeof ADAPTER_FACTORIES['cline'] === 'function');
check('descriptor id is cline', adapter.descriptor.id === 'cline');
check(
  'descriptor uses the app-server transport (first one in the fleet)',
  adapter.descriptor.transport === 'app-server',
);
check('credentialsHint is reference-only', /never reads/i.test(adapter.descriptor.credentialsHint ?? ''));

// Discovery is a machine fact: skip when the sidecar is not installed here.
try {
  const { launcher } = resolveCommand('cline');
  check(
    'discovery resolves the real sidecar path',
    /code-sidecar\.exe$/i.test(launcher.command),
    launcher.command,
  );
  check('discovery launches it natively', launcher.kind === 'native');
} catch (e) {
  skip('cline binary is installed', (e as Error).message.split('\n')[0] ?? 'not installed');
}

// =========================================================================
// 2. CAPABILITIES MATCH WHAT WAS MEASURED
// =========================================================================

section('2. capabilities (measured, not assumed)');

const caps = adapter.descriptor.capabilities;
for (const key of ['newTask', 'resume', 'modelSelection', 'streamEvents', 'cwd'] as const) {
  check(`${key} = true`, caps[key] === true);
}
for (const key of [
  'review',
  'roleSelection',
  'sandbox',
  'costReporting',
  'extraArgs',
  'steering',
  'worktree',
  'fork',
  'stdinPrompt',
] as const) {
  check(`${key} = false`, caps[key] === false);
}

// =========================================================================
// 3. VALIDATE: unsupported options are REFUSED, never dropped
// =========================================================================

section('3. validateRequest refuses what Cline cannot honour');

let e = caught(() => adapter.validateRequest(req({ mode: 'review' })));
check('mode=review is refused', e.err instanceof UnsupportedOptionError, e.err?.message);

e = caught(() => adapter.validateRequest(req({ mode: 'review', threadId: 't1' })));
check('review + threadId is a request conflict', e.err instanceof InvalidRequestError, e.err?.message);

e = caught(() => adapter.validateRequest(req({ sandbox: 'read-only' })));
check('a sandbox setting is refused', e.err instanceof UnsupportedOptionError, e.err?.message);

e = caught(() => adapter.validateRequest(req({ role: 'reviewer' })));
check('a role selection is refused', e.err instanceof UnsupportedOptionError, e.err?.message);

e = caught(() => adapter.validateRequest(req({ extraArgs: ['--foo'] })));
check('extra argv flags are refused (argv is swallowed by the sidecar)', e.err instanceof UnsupportedOptionError, e.err?.message);

e = caught(() => adapter.validateRequest(req()));
check('a plain request passes', e.err === null, e.err?.message);

e = caught(() => adapter.validateRequest(req({ threadId: '1790651009237_ya0qi' })));
check('resume via threadId passes', e.err === null, e.err?.message);

e = caught(() => adapter.validateRequest(req({ model: 'cline-free/mimo-v2.6-flash' })));
check('model selection passes', e.err === null, e.err?.message);

const tr = caught(() => adapter.createTransport(req({ sandbox: 'read-only' })));
check('createTransport validates before building (sandbox throws)', tr.err instanceof UnsupportedOptionError);

const okTransport = adapter.createTransport(req());
check('createTransport yields an app-server transport', okTransport.kind === 'app-server');
check('commandLine names the sidecar', /code-sidecar/.test(okTransport.commandLine));

// =========================================================================
// 4. mapEvent: the measured chat_event streams
// =========================================================================

section('4. mapEvent (chat_event streams)');

{
  const sink = recordingSink();
  const out = adapter.mapEvent(chatFrame('chat_text', 'ORCHESTRATOR-CLINE-SMOKE-OK'), sink.ctx);
  check('chat_text produces an output event', out.length === 1 && out[0]!.type === 'session.output');
  check('chat_text is accumulated as the answer', sink.texts.join('') === 'ORCHESTRATOR-CLINE-SMOKE-OK');
  check('chat_text records assistant-output evidence', sink.signals.includes(EVIDENCE_OUTPUT));
  check('thread id noted from payload.sessionId', sink.thread === 'sid_1');
}
{
  const sink = recordingSink();
  const out = adapter.mapEvent(chatFrame('chat_reasoning', { text: 'The user wants…' }), sink.ctx);
  check('reasoning is progress, not output', out[0]?.type === 'session.progress' && out[0]?.data?.kind === 'reasoning');
  check('reasoning never pollutes the answer', sink.texts.length === 0);
}
{
  const sink = recordingSink();
  // Per-request counter first, then cumulative totals — last write wins in the
  // sink, so the cumulative figure must be preferred when present.
  adapter.mapEvent(chatFrame('chat_usage', { inputTokens: 6994, outputTokens: 58, cost: 0 }), sink.ctx);
  adapter.mapEvent(
    chatFrame('chat_usage', { inputTokens: 7655, outputTokens: 45, totalInputTokens: 14649, totalOutputTokens: 103, cacheReadTokens: 6976, cost: 0 }),
    sink.ctx,
  );
  const last = sink.usage.at(-1)!;
  check('usage prefers the cumulative totals', last.inputTokens === 14649 && last.outputTokens === 103, JSON.stringify(last));
  check('cache reads are captured', last.cachedInputTokens === 6976);
  check('totalTokens is the run total', last.totalTokens === 14752);
  check('a 0 cost figure is NOT reported as costUsd', last.costUsd === undefined);
}
{
  const sink = recordingSink();
  const out = adapter.mapEvent(
    chatFrame('chat_done', { reason: 'completed', text: 'answer', iterations: 1, usage: { inputTokens: 4668, outputTokens: 21, cacheReadTokens: 4608, cost: 0 } }),
    sink.ctx,
  );
  check('chat_done completed records completion evidence', sink.signals.includes(EVIDENCE_DONE));
  check('chat_done is a turn_done progress event', out[0]?.data?.kind === 'turn_done' && out[0]?.data?.reason === 'completed');
  check('chat_done usage lands in the accumulator', sink.usage.at(-1)?.inputTokens === 4668);
}
{
  const sink = recordingSink();
  adapter.mapEvent(chatFrame('chat_done', { reason: 'aborted', text: '', iterations: 1 }), sink.ctx);
  check('an aborted turn records its reason', sink.signals.includes('cline:turn:aborted'));
  check('an aborted turn records NO completion evidence', !sink.signals.includes(EVIDENCE_DONE));
}
{
  const sink = recordingSink();
  adapter.mapEvent(
    chatFrame('chat_tool_call_start', { toolCallId: 'call_1', toolName: 'read_files', input: { files: ['package.json'] } }),
    sink.ctx,
  );
  adapter.mapEvent(
    chatFrame('chat_tool_call_end', { toolCallId: 'call_1', toolName: 'read_files', output: [{ query: 'package.json', result: '{ "name": … }' }] }),
    sink.ctx,
  );
  adapter.mapEvent(
    chatFrame('chat_tool_call_end', { toolCallId: 'call_1', toolName: 'read_files', output: [{ query: 'package.json', result: '{ "name": … }' }] }),
    sink.ctx,
  );
  const started = sink.tools.length;
  check('tool start+end yield tool_call events', started === 1, `sink.tools=${started}`);
  check('the tool call carries its name', sink.tools[0]?.name === 'read_files');
  check('the tool output is flattened to text', (sink.tools[0]?.output ?? '').includes('name'));
  const events = adapter.mapEvent(
    chatFrame('chat_tool_call_end', { toolCallId: 'call_2', toolName: 'run_command', output: 'ok' }),
    sink.ctx,
  );
  check('a second call id is accumulated too', sink.tools.length === 2);
  check('tool end maps to a tool_call event', events[0]?.type === 'session.tool_call');
}
{
  const sink = recordingSink();
  adapter.mapEvent(eventFrame('chat_session_status', { sessionId: 'sid_9', status: 'running' }), sink.ctx);
  check('session status notes the thread id', sink.thread === 'sid_9');
  const out = adapter.mapEvent(eventFrame('chat_session_status', { sessionId: 'sid_9', status: 'running' }), sink.ctx);
  check('session status maps to progress', out[0]?.data?.kind === 'session_status');
}

// =========================================================================
// 5. TRANSPORT-LEVEL FRAMES
// =========================================================================

section('5. synthetic error frames and unknown frames');

{
  const sink = recordingSink();
  const frame: TransportFrame = {
    channel: 'protocol',
    text: '',
    data: { type: 'cline_error', error: 'cline sidecar exited before completing the turn (code 127, signal none)' },
  };
  const out = adapter.mapEvent(frame, sink.ctx);
  check('a cline_error frame becomes an error signal', sink.signals.some((s) => s.startsWith('error:')));
  check('a cline_error frame is surfaced as progress', out[0]?.data?.kind === 'error');
  check('the error text is kept for the terminal policy', sink.signals[0]!.includes('code 127'));
}
{
  const sink = recordingSink();
  const out = adapter.mapEvent(eventFrame('ask_question_requested', { sessionId: 'sid_1', question: 'Which one?' }), sink.ctx);
  check('an ask_question event is surfaced, not swallowed', out[0]?.data?.nativeType === 'cline:ask_question_requested');
}
{
  const sink = recordingSink();
  const out = adapter.mapEvent({ channel: 'stdout', text: 'not json at all' }, sink.ctx);
  check('a non-object frame maps to nothing (no throw)', out.length === 0);
}

// =========================================================================
// 6. TERMINAL POLICY — the exit code never decides
// =========================================================================

section('6. terminal policy (chat_done decides, not the exit code)');

{
  const d = adapter.terminalPolicy(tin({ nativeSignals: [EVIDENCE_DONE] }));
  check('measured success shape: exit null + chat_done -> succeeded', d.state === 'succeeded' && d.error === null);
}
{
  const d = adapter.terminalPolicy(tin({ exit: { ...EXIT_NONE, code: 0, signal: null, cleanup: { ...EXIT_NONE.cleanup } }, nativeSignals: [EVIDENCE_DONE] }));
  check('exit 0 + chat_done -> succeeded', d.state === 'succeeded');
}
{
  const d = adapter.terminalPolicy(tin({ nativeSignals: [] }));
  check('no completion signal -> failed', d.state === 'failed');
  check('the failure names the missing chat_done', /no chat_done frame arrived/.test(d.error?.message ?? ''), d.error?.message);
}
{
  const d = adapter.terminalPolicy(tin({ exit: { ...EXIT_NONE, code: 0, signal: null, cleanup: { ...EXIT_NONE.cleanup } }, nativeSignals: [] }));
  check('exit 0 alone is NOT success', d.state === 'failed');
  check('the exit-0 failure says the exit code does not decide', /exited 0, which is not success/.test(d.error?.message ?? ''), d.error?.message);
}
{
  const d = adapter.terminalPolicy(tin({ nativeSignals: [EVIDENCE_OUTPUT] }));
  check('text without chat_done -> failed', d.state === 'failed');
  check('that failure explains the stream stopped early', /never reported completion/.test(d.error?.message ?? ''));
}
{
  const d = adapter.terminalPolicy(tin({ nativeSignals: ['cline:turn:aborted'] }));
  check('an agent-side aborted turn -> failed', d.state === 'failed');
  check('the aborted reason is quoted', /"aborted"/.test(d.error?.message ?? ''));
}
{
  const d = adapter.terminalPolicy(tin({ nativeSignals: ['error: cline turn failed: timeout waiting for chat_session_command'] }));
  check('an error signal -> failed', d.state === 'failed');
  check('a timeout-flavoured error is retryable', d.error?.retryable === true, d.error?.message);
}
{
  const d = adapter.terminalPolicy(tin({ exit: { ...EXIT_NONE, code: 3, signal: null, stderrTail: 'boom', cleanup: { ...EXIT_NONE.cleanup } }, nativeSignals: [] }));
  check('a nonzero exit -> failed NONZERO_EXIT', d.state === 'failed' && d.error?.code === 'NONZERO_EXIT');
}
{
  const d = adapter.terminalPolicy(tin({ localAbort: 'cancelled' }));
  check('local abort: cancelled', d.state === 'failed' && d.error?.code === 'CANCELLED');
  const t = adapter.terminalPolicy(tin({ localAbort: 'timed_out' }));
  check('local abort: timed_out stays distinct', t.error?.code === 'TIMED_OUT');
}
{
  // Evidence beats a teardown noise signal: the transport kills the sidecar
  // after a completed turn, and that must never fail a finished run.
  const d = adapter.terminalPolicy(tin({ nativeSignals: [EVIDENCE_DONE, 'error: cline WebSocket closed unexpectedly (code 1006)'] }));
  check('completion evidence wins over teardown noise', d.state === 'succeeded');
}

// =========================================================================
// 7. PROTOCOL — ClineSocket against an in-memory WebSocket double
// =========================================================================

section('7. protocol (ClineSocket against a WebSocket double)');

interface FakeListener {
  (ev: unknown): void;
}

class FakeWs {
  static last: FakeWs | null = null;
  readyState = 0;
  readonly sent: Array<{ id: number; command: string; args: unknown }> = [];
  closeCode: number | null = null;
  readonly url: string;
  readonly options: { headers?: Record<string, string> } | undefined;
  private readonly listeners = new Map<string, FakeListener[]>();

  constructor(url: string, options?: { headers?: Record<string, string> }) {
    this.url = url;
    this.options = options;
    FakeWs.last = this;
    setTimeout(() => {
      this.readyState = 1;
      this.emit('open', {});
    }, 0);
  }

  addEventListener(type: string, listener: FakeListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    const msg = JSON.parse(data) as { id: number; command: string; args: unknown };
    this.sent.push(msg);
    if (msg.command === 'hang') return; // never answers: for close-during-pending
    setTimeout(() => {
      if (this.readyState !== 1) return;
      if (msg.command.startsWith('fail:')) {
        this.emit('message', { data: JSON.stringify({ type: 'response', id: msg.id, ok: false, error: 'boom: ' + msg.command }) });
      } else {
        this.emit('message', { data: JSON.stringify({ type: 'response', id: msg.id, ok: true, result: { command: msg.command, args: msg.args } }) });
      }
    }, 0);
  }

  close(code?: number): void {
    this.closeCode = code ?? 1000;
    this.readyState = 3;
    this.emit('close', { code: this.closeCode });
  }

  /** The server dropping us: close without this side asking. */
  serverClose(code: number): void {
    this.readyState = 3;
    this.emit('close', { code });
  }

  push(name: string, payload: Record<string, unknown>): void {
    this.emit('message', { data: JSON.stringify({ type: 'event', event: { name, payload } }) });
  }

  private emit(type: string, ev: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
}

const g = globalThis as { WebSocket?: unknown };
const originalWs = g.WebSocket;
g.WebSocket = FakeWs;

void (async () => {
  try {
    const events: string[] = [];
    let closedCode: number | null | undefined = -1;
    const sock = await ClineSocket.open('ws://127.0.0.1:42111/transport?approval_token=secret', {
      onEvent: (m) => events.push(m.event?.name ?? '?'),
      onClose: (code) => {
        closedCode = code;
      },
    });
    const ws = FakeWs.last!;
    check('the trusted Origin header is sent', ws.options?.headers?.Origin === CLINE_TRUSTED_ORIGIN, JSON.stringify(ws.options));
    check('the endpoint URL is used verbatim', ws.url.includes('approval_token=secret'));

    const res = (await sock.rpc('chat_session_command', { request: { action: 'start' } })) as {
      command?: string;
      args?: { request?: { action?: string } };
    };
    check('rpc resolves with the correlated result', res.command === 'chat_session_command');
    check('rpc forwards args untouched', res.args?.request?.action === 'start');

    let rpcErr: Error | null = null;
    try {
      await sock.rpc('fail:nope', {});
    } catch (err) {
      rpcErr = err as Error;
    }
    check(
      'an ok:false response rejects with the error text',
      rpcErr !== null && /boom: fail:nope/.test(rpcErr.message),
      rpcErr?.message ?? 'resolved instead of rejecting',
    );

    ws.push('chat_session_status', { sessionId: 'sid_1', status: 'idle' });
    await new Promise((r) => setTimeout(r, 5));
    check('server events reach the onEvent callback', events.includes('chat_session_status'));

    const pending = sock.rpc('hang', {});
    let pendingRejected = false;
    const pendingTrack = pending.then(
      () => 'resolved',
      (err: Error) => {
        pendingRejected = true;
        return err.message;
      },
    );

    // Our own close: no onClose (expected, not a failure).
    sock.close(1000, 'run finished');
    check('our close is recorded on the socket', ws.closeCode === 1000);
    let afterCloseErr: Error | null = null;
    try {
      await sock.rpc('x', {});
    } catch (err) {
      afterCloseErr = err as Error;
    }
    check(
      'rpc after close rejects instead of hanging',
      afterCloseErr !== null && /not open/.test(afterCloseErr.message),
      afterCloseErr?.message ?? 'resolved instead of rejecting',
    );

    const trackResult = await pendingTrack;
    check('an in-flight rpc is rejected when the connection closes', pendingRejected, String(trackResult));
    await new Promise((r) => setTimeout(r, 5));
    check('a close we initiated does NOT fire onClose', closedCode === -1, String(closedCode));

    // Unexpected server close: onClose fires with the code.
    const sock2 = await ClineSocket.open('ws://127.0.0.1:42112/transport', { onClose: (code) => { closedCode = code; } });
    FakeWs.last!.serverClose(1006);
    await new Promise((r) => setTimeout(r, 5));
    check('an unexpected close fires onClose with the code', closedCode === 1006, String(closedCode));
    sock2.close();

    // parseClineReady — the ONLY place the approval_token may be read.
    check(
      'the ready line parses to its wsEndpoint',
      parseClineReady('{"type":"ready","endpoint":"http://127.0.0.1:42111","wsEndpoint":"ws://127.0.0.1:42111/transport?approval_token=x","pid":9,"mode":"sidecar"}') !== null,
    );
    check('a non-JSON stdout line is not a ready line', parseClineReady('some log line') === null);
    check('JSON without wsEndpoint is not a ready line', parseClineReady('{"type":"other"}') === null);
    check('broken JSON is not a ready line', parseClineReady('{"wsEndpoint":') === null);
  } finally {
    g.WebSocket = originalWs;
  }

  // =========================================================================

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failures.length) {
    process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
  }
  process.stdout.write('\n');
  process.exitCode = failed === 0 ? 0 : 1;
})();
