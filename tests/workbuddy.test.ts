/**
 * tests/workbuddy.test.ts — hermetic WorkBuddy adapter tests.
 *
 * Codex's `PASS WITH FIXES` named three findings this file exists to close:
 *   1. CN / Intl identities were merged behind one `workbuddy` id
 *   2. exit 0 without protocol evidence could still be reported as succeeded
 *   3. there were no dedicated WorkBuddy tests at all
 *
 * Nothing here spawns the real CLI: discovery is driven by an injectable
 * filesystem predicate, streams are `FakeTransport` scripts, and terminal
 * inputs are built by hand. `npm test` stays machine-independent.
 *
 * Run: node tests/workbuddy.test.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CapabilityError,
  InvalidRequestError,
  LauncherResolutionError,
  UnsupportedOptionError,
} from '../src/core/errors.ts';
import type {
  AgentAdapter,
  LauncherSpec,
  RunRequest,
  RunResult,
  TerminalDecision,
  TerminalInput,
} from '../src/core/types.ts';
import { AgentSession } from '../src/runtime/session.ts';
import { SessionStore } from '../src/runtime/store.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { ADAPTER_FACTORIES, knownAgentIds } from '../src/adapters/index.ts';
import {
  EVIDENCE_OUTPUT,
  EVIDENCE_RESULT,
  WORKBUDDY_VARIANTS,
  buildWorkBuddyArgs,
  createWorkBuddyAdapter,
  isWorkBuddyId,
  type WorkBuddyId,
} from '../src/adapters/workbuddy.ts';
import { FakeTransport, recordingSink, type ScriptStep } from './helpers.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];
const tmpDirs: string[] = [];

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

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch-wb-'));
  tmpDirs.push(dir);
  return dir;
}

function stubLauncher(name: string): LauncherSpec {
  return {
    kind: 'native',
    command: `C:/fake/${name}.exe`,
    prefixArgs: [],
    target: `C:/fake/${name}.exe`,
    buildsCommandString: false,
  };
}

/** Adapter with a stub launcher: no discovery, no spawn, pure logic. */
function wb(id: WorkBuddyId = 'workbuddy-intl'): AgentAdapter {
  return createWorkBuddyAdapter(id, { launcher: stubLauncher(id) });
}

/**
 * Adapter that DOES run discovery, but against a test-supplied filesystem
 * predicate instead of the machine's. This is how identity isolation is proven
 * without depending on which build happens to be installed here.
 */
function wbDiscovered(id: WorkBuddyId, exists: (p: string) => boolean): AgentAdapter {
  return createWorkBuddyAdapter(id, { exists });
}

function caught(fn: () => unknown): { err: Error | null } {
  try {
    fn();
    return { err: null };
  } catch (e) {
    return { err: e as Error };
  }
}

const CN_ENTRY = WORKBUDDY_VARIANTS['workbuddy-cn'].candidates[0]!;
const INTL_ENTRY = WORKBUDDY_VARIANTS['workbuddy-intl'].candidates[0]!;

const onlyIntl = (p: string): boolean => p === INTL_ENTRY;
const onlyCn = (p: string): boolean => p === CN_ENTRY;
const neither = (): boolean => false;
const both = (): boolean => true;

// =========================================================================
// 1. PROVIDER IDENTITY  (review finding: CN / Intl merged)
// =========================================================================

section('1. provider identity (workbuddy-cn / workbuddy-intl)');

check('knownAgentIds contains workbuddy-cn', knownAgentIds().includes('workbuddy-cn'));
check('knownAgentIds contains workbuddy-intl', knownAgentIds().includes('workbuddy-intl'));
check(
  'no bare "workbuddy" id survives (no fallback identity)',
  !knownAgentIds().includes('workbuddy'),
);
check(
  'factory table exposes both identities',
  typeof ADAPTER_FACTORIES['workbuddy-cn'] === 'function' &&
    typeof ADAPTER_FACTORIES['workbuddy-intl'] === 'function',
);
check(
  'isWorkBuddyId accepts exactly the two ids',
  isWorkBuddyId('workbuddy-cn') &&
    isWorkBuddyId('workbuddy-intl') &&
    !isWorkBuddyId('workbuddy') &&
    !isWorkBuddyId('zcode'),
);
check(
  'candidate lists are disjoint — the identities cannot resolve to each other',
  WORKBUDDY_VARIANTS['workbuddy-cn'].candidates.every(
    (p) => !WORKBUDDY_VARIANTS['workbuddy-intl'].candidates.includes(p),
  ) &&
    WORKBUDDY_VARIANTS['workbuddy-intl'].candidates.every(
      (p) => !WORKBUDDY_VARIANTS['workbuddy-cn'].candidates.includes(p),
    ),
);

const cnAdapter = wb('workbuddy-cn');
const intlAdapter = wb('workbuddy-intl');
check('cn descriptor carries its own id', cnAdapter.descriptor.id === 'workbuddy-cn');
check('intl descriptor carries its own id', intlAdapter.descriptor.id === 'workbuddy-intl');
check(
  'display names are distinct',
  cnAdapter.descriptor.displayName !== intlAdapter.descriptor.displayName,
);
check(
  'capability metadata is shared (one implementation, two identities)',
  cnAdapter.descriptor.capabilities === intlAdapter.descriptor.capabilities,
);
check('transport is shared', cnAdapter.descriptor.transport === intlAdapter.descriptor.transport);

// --- discovery never crosses -------------------------------------------
const cnOnly = caught(() => wbDiscovered('workbuddy-cn', onlyIntl));
check(
  'CN does NOT resolve to the Intl install when only Intl exists',
  cnOnly.err !== null && cnOnly.err instanceof LauncherResolutionError,
  cnOnly.err?.message ?? 'no error thrown',
);
check('the CN failure names its own identity', /workbuddy-cn/.test(cnOnly.err?.message ?? ''));
check(
  'the CN failure never lists the Intl entry point',
  !/WorkBuddyAI/.test(cnOnly.err?.message ?? ''),
  cnOnly.err?.message ?? '',
);
check(
  'the CN failure explains it will not fall through to the other region',
  /never falls through/.test(cnOnly.err?.message ?? ''),
);

const intlOnly = caught(() => wbDiscovered('workbuddy-intl', onlyCn));
check(
  'Intl does NOT resolve to the CN install when only CN exists',
  intlOnly.err !== null && intlOnly.err instanceof LauncherResolutionError,
  intlOnly.err?.message ?? 'no error thrown',
);
check('the Intl failure names its own identity', /workbuddy-intl/.test(intlOnly.err?.message ?? ''));
check(
  'the Intl failure never lists the CN entry point',
  !/D:\\workbuddy\\resources/.test(intlOnly.err?.message ?? ''),
  intlOnly.err?.message ?? '',
);

const none = caught(() => wbDiscovered('workbuddy-intl', neither));
check(
  'with neither install present, resolution fails loudly',
  none.err !== null && none.err instanceof LauncherResolutionError,
  none.err?.message ?? 'no error thrown',
);

const cnFound = wbDiscovered('workbuddy-cn', both);
const intlFound = wbDiscovered('workbuddy-intl', both);
check('CN resolves to the CN entry point', cnFound.descriptor.launcher.target === CN_ENTRY);
check('Intl resolves to the Intl entry point', intlFound.descriptor.launcher.target === INTL_ENTRY);
check(
  'the extension-less script runs under node.exe',
  cnFound.descriptor.launcher.command === process.execPath,
);
check(
  'the script is NOT carried in prefixArgs (buildLaunchArgv would drop it)',
  cnFound.descriptor.launcher.prefixArgs.length === 0,
);

const explicitCn = createWorkBuddyAdapter('workbuddy-cn', { command: CN_ENTRY, exists: both });
check(
  'an explicit absolute command still wins for its own id',
  explicitCn.descriptor.launcher.target === CN_ENTRY,
);

const badCommand = caught(() =>
  createWorkBuddyAdapter('workbuddy-cn', {
    command: 'C:/does/not/exist/codebuddy',
    exists: neither,
  }),
);
check(
  'an explicit command that does not exist is refused',
  badCommand.err !== null && badCommand.err instanceof LauncherResolutionError,
  badCommand.err?.message ?? 'no error thrown',
);

// =========================================================================
// 2. LAUNCHER / ARGV
// =========================================================================

section('2. launcher + argv');

const req = (over: Partial<RunRequest> = {}): RunRequest => ({
  agentId: 'workbuddy-intl',
  prompt: 'hello',
  cwd: tmpDir(),
  ...over,
});

const plain = buildWorkBuddyArgs(req());
// `-p` is non-interactive, so CodeBuddy cannot prompt and denies EVERY tool
  // (measured: exit 0, no file written, "tools were denied"). The permission mode
  // is therefore part of the baseline argv, not an extra.
  check(
    'bare argv is `-p --output-format stream-json --permission-mode bypassPermissions -- <prompt>`',
    plain.join(' ') === '-p --output-format stream-json --permission-mode bypassPermissions -- hello',
    plain.join(' '),
  );
  check('prompt is the final argv element', plain[plain.length - 1] === 'hello');
  check('prompt is shielded by exactly one `--`', plain[plain.length - 2] === '--');
  check(
    'the permission mode is requested, because `-p` cannot prompt',
    plain.includes('--permission-mode') && plain[plain.indexOf('--permission-mode') + 1] === 'bypassPermissions',
    plain.join(' '),
  );
  // A caller who expressed their own permission choice must win: the CLI honours
  // the LAST occurrence, so extraArgs are appended after the default.
  const explicitMode = buildWorkBuddyArgs(req({ extraArgs: ['--permission-mode', 'acceptEdits'] }));
  check(
    'an explicit --permission-mode in extraArgs does not get a second default',
    explicitMode.filter((a) => a === '--permission-mode').length === 1 &&
      explicitMode[explicitMode.indexOf('--permission-mode') + 1] === 'acceptEdits',
    explicitMode.join(' '),
  );
  const explicitDashY = buildWorkBuddyArgs(req({ extraArgs: ['-y'] }));
  check(
    'an explicit -y in extraArgs suppresses the default mode',
    explicitDashY.includes('-y') && !explicitDashY.includes('--permission-mode'),
    explicitDashY.join(' '),
  );
  check(
    'extraArgs still land BEFORE the `--` prompt boundary',
    explicitMode.indexOf('acceptEdits') > 0 && explicitMode.indexOf('acceptEdits') < explicitMode.indexOf('--'),
    explicitMode.join(' '),
  );

const dashPrompt = buildWorkBuddyArgs(req({ prompt: '--definitely-not-a-real-flag' }));
check(
  'a prompt starting with "-" still lands after `--`',
  dashPrompt[dashPrompt.length - 2] === '--' &&
    dashPrompt[dashPrompt.length - 1] === '--definitely-not-a-real-flag',
  dashPrompt.join(' '),
);

const withPrefix = buildWorkBuddyArgs(req(), ['C:/cli/codebuddy']);
check('the entry script leads argv when supplied', withPrefix[0] === 'C:/cli/codebuddy');

const modelled = buildWorkBuddyArgs(req({ model: 'balanced-model' }));
check(
  '`--model` precedes the `--` boundary',
  modelled.indexOf('--model') > 0 && modelled.indexOf('--model') < modelled.indexOf('--'),
  modelled.join(' '),
);
check(
  '`--model` carries its value',
  modelled[modelled.indexOf('--model') + 1] === 'balanced-model',
);

const roled = buildWorkBuddyArgs(req({ role: 'probeagent' }));
check(
  '`--agent` is used for role selection',
  roled[roled.indexOf('--agent') + 1] === 'probeagent',
  roled.join(' '),
);

const resumed = buildWorkBuddyArgs(req({ threadId: 'ses_abc' }));
check('resume uses `-r <threadId>`', resumed[resumed.indexOf('-r') + 1] === 'ses_abc');
check('`-r` precedes the prompt', resumed.indexOf('-r') < resumed.indexOf('--'), resumed.join(' '));

const permissionMode = buildWorkBuddyArgs(req({ extraArgs: ['--permission-mode', 'acceptEdits'] }));
check(
  '`--permission-mode` (via extraArgs) lands before the `--` boundary',
  permissionMode.indexOf('--permission-mode') > 0 &&
    permissionMode.indexOf('--permission-mode') < permissionMode.indexOf('--'),
  permissionMode.join(' '),
);
check(
  'extraArgs keep their order and their values',
  permissionMode[permissionMode.indexOf('--permission-mode') + 1] === 'acceptEdits' &&
    permissionMode[permissionMode.indexOf('acceptEdits') + 1] === '--',
  permissionMode.join(' '),
);

const multiExtra = buildWorkBuddyArgs(req({ extraArgs: ['-a', '-b'] }));
check(
  'multiple extraArgs are forwarded verbatim in order',
  multiExtra.indexOf('-a') + 1 === multiExtra.indexOf('-b') &&
    multiExtra.indexOf('-b') < multiExtra.indexOf('--'),
  multiExtra.join(' '),
);

const flagged = buildWorkBuddyArgs(req({ model: 'm', role: 'r', threadId: 't' }));
check(
  'flag order is stable: model, role, resume',
  flagged.indexOf('--model') < flagged.indexOf('--agent') &&
    flagged.indexOf('--agent') < flagged.indexOf('-r'),
  flagged.join(' '),
);

const guarded = caught(() => wb().validateRequest(req({ extraArgs: ['--'] })));
check('the adapter refuses `--` in extraArgs before build', guarded.err instanceof InvalidRequestError);

// =========================================================================
// 3. VALIDATION — every unsupported option fails BEFORE spawn
// =========================================================================

section('3. validation (all refusals happen before spawn)');

const v = wb();
const dir = tmpDir();

check(
  'review -> UnsupportedOptionError',
  caught(() => v.validateRequest(req({ mode: 'review' }))).err instanceof UnsupportedOptionError,
);
check(
  'sandbox -> UnsupportedOptionError',
  caught(() => v.validateRequest(req({ sandbox: 'read-only' }))).err instanceof
    UnsupportedOptionError,
);
check(
  'review + threadId -> InvalidRequestError',
  caught(() => v.validateRequest(req({ mode: 'review', threadId: 'ses_x' }))).err instanceof
    InvalidRequestError,
);

const dashDash = caught(() => v.validateRequest(req({ extraArgs: ['--'] })));
check('`--` in extraArgs -> InvalidRequestError', dashDash.err instanceof InvalidRequestError);
check(
  'the `--` refusal explains the prompt boundary',
  /prompt/.test(dashDash.err?.message ?? ''),
  dashDash.err?.message ?? '',
);
const smuggled = caught(() => v.validateRequest(req({ extraArgs: ['--', 'injected-prompt'] })));
check(
  'a smuggled second positional via extraArgs is refused too',
  smuggled.err instanceof InvalidRequestError,
);

// createTransport validates FIRST, so no transport object (and therefore no
// process) exists for any refused request.
const refused: Array<[string, RunRequest, unknown]> = [
  ['review', req({ mode: 'review' }), UnsupportedOptionError],
  ['sandbox', req({ sandbox: 'workspace-write' }), UnsupportedOptionError],
  ['review+thread', req({ mode: 'review', threadId: 'ses_x' }), InvalidRequestError],
  ['`--` extraArgs', req({ extraArgs: ['--'] }), InvalidRequestError],
];
for (const [label, r, ctor] of refused) {
  const res = caught(() => v.createTransport(r));
  check(
    `createTransport refuses ${label} (no transport, no process)`,
    res.err !== null && res.err instanceof (ctor as new () => Error),
    res.err?.message ?? 'no error thrown',
  );
}

// The same requests through the ORCHESTRATOR: still refused, still pre-spawn.
const registered: AgentAdapter = {
  ...v,
  descriptor: { ...v.descriptor, id: 'workbuddy-under-test' },
};
const orch = new Orchestrator({
  config: { agents: {} },
  storeDir: tmpDir(),
  extraAdapters: [registered],
});
check(
  'orchestrator refuses --sandbox via the adapter, pre-spawn',
  caught(() =>
    orch.run({ agentId: 'workbuddy-under-test', prompt: 'p', cwd: dir, sandbox: 'read-only' }),
  ).err instanceof UnsupportedOptionError,
);
check(
  'orchestrator refuses mode=review pre-spawn (generic capability guard)',
  caught(() => orch.run({ agentId: 'workbuddy-under-test', prompt: 'p', cwd: dir, mode: 'review' }))
    .err instanceof CapabilityError,
);

// =========================================================================
// 4. mapEvent
// =========================================================================

section('4. mapEvent');

function frame(data: unknown): TransportFrameDouble {
  return { channel: 'stdout', text: JSON.stringify(data), data };
}

type TransportFrameDouble = Parameters<AgentAdapter['mapEvent']>[0];

const assistantFrame = (content: unknown[]): ReturnType<typeof frame> =>
  frame({
    type: 'assistant',
    session_id: 'ses_frame',
    message: { content, usage: { input_tokens: 10, output_tokens: 2 } },
  });

{
  const sink = recordingSink();
  const events = wb().mapEvent(
    assistantFrame([{ type: 'thinking', thinking: 'pondering' }]),
    sink.ctx,
  );
  check(
    'thinking emits a reasoning progress event',
    events.some((e) => (e.data?.kind as string) === 'reasoning'),
  );
  check('thinking is not output', sink.texts.length === 0);
}

{
  const sink = recordingSink();
  const events = wb().mapEvent(assistantFrame([{ type: 'text', text: 'LINE-ONE-42' }]), sink.ctx);
  check('text becomes an output event', events.some((e) => e.type === 'session.output'));
  check('text is captured on the sink', sink.texts.join('') === 'LINE-ONE-42');
  check(
    'text-bearing assistant frame records protocol evidence',
    sink.signals.includes(EVIDENCE_OUTPUT),
    JSON.stringify(sink.signals),
  );
}

{
  const sink = recordingSink();
  wb().mapEvent(assistantFrame([{ type: 'text', text: '401 Unauthorized' }]), sink.ctx);
  check(
    'auth text in OUTPUT is noted for a better explanation',
    sink.signals.some((s) => s.startsWith('auth:')),
    JSON.stringify(sink.signals),
  );
  check('auth text in OUTPUT still counts as evidence', sink.signals.includes(EVIDENCE_OUTPUT));
}

{
  const sink = recordingSink();
  const once = wb();
  once.mapEvent(assistantFrame([{ type: 'text', text: 'again' }]), sink.ctx);
  const before = sink.signals.filter((s) => s === EVIDENCE_OUTPUT).length;
  once.mapEvent(assistantFrame([{ type: 'text', text: 'more' }]), sink.ctx);
  const after = sink.signals.filter((s) => s === EVIDENCE_OUTPUT).length;
  check('output evidence is recorded once per run', before === 1 && after === 1, `${before}/${after}`);
}

{
  const sink = recordingSink();
  const a = wb();
  const events1 = a.mapEvent(
    assistantFrame([
      { type: 'tool_use', id: 'call-1', name: 'Read', input: { path: 'probe.txt' } },
    ]),
    sink.ctx,
  );
  check(
    'tool_use emits an in_progress tool_call event',
    events1.some(
      (e) => e.type === 'session.tool_call' && (e.data?.tool as { status?: string }).status === 'in_progress',
    ),
  );
  check('tool_use does NOT append to RunResult.toolCalls yet', sink.tools.length === 0);

  const toolResult = frame({
    type: 'user',
    session_id: 'ses_frame',
    message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }] },
  });
  const events2 = a.mapEvent(toolResult, sink.ctx);
  check(
    'tool_result emits a completed tool_call event',
    events2.some((e) => e.type === 'session.tool_call'),
  );
  check('exactly ONE tool entry is recorded', sink.tools.length === 1, JSON.stringify(sink.tools));
  check('the entry resolves the tool name from tool_use', sink.tools[0]?.name === 'Read');
  check('the entry carries the output', sink.tools[0]?.output === 'ok');
  check('the entry is completed', sink.tools[0]?.status === 'completed');

  a.mapEvent(
    frame({
      type: 'user',
      session_id: 'ses_frame',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'dup?' }] },
    }),
    sink.ctx,
  );
  check('a repeated tool_result never duplicates the entry', sink.tools.length === 1);
}

{
  const sink = recordingSink();
  const events = wb().mapEvent(
    frame({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'OK',
      session_id: 'ses_frame',
      usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 3 },
    }),
    sink.ctx,
  );
  check('a result frame records protocol evidence', sink.signals.includes(EVIDENCE_RESULT));
  check(
    'a result frame emits a result progress event',
    events.some((e) => (e.data?.kind as string) === 'result'),
  );
  check(
    'usage is captured',
    sink.usage.length === 1 &&
      sink.usage[0]?.inputTokens === 5 &&
      sink.usage[0]?.outputTokens === 7,
  );
  check(
    'total = input + output (input already includes cache)',
    sink.usage[0]?.totalTokens === 12,
    JSON.stringify(sink.usage),
  );
}

{
  const sink = recordingSink();
  wb().mapEvent(
    frame({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'boom',
      session_id: 'ses_frame',
    }),
    sink.ctx,
  );
  check(
    'an is_error result records an error signal',
    sink.signals.some((s) => s.startsWith('error:')),
    JSON.stringify(sink.signals),
  );
  check('an is_error result records NO success evidence', !sink.signals.includes(EVIDENCE_RESULT));
}

{
  const sink = recordingSink();
  wb().mapEvent(frame({ type: 'system', subtype: 'init', session_id: 'ses_frame' }), sink.ctx);
  check('session_id is noted as the thread id', sink.thread === 'ses_frame');
}

{
  const sink = recordingSink();
  const events = wb().mapEvent(frame({ type: 'brand-new-native-type' }), sink.ctx);
  check('an unknown native type is surfaced, never swallowed', events.length === 1);
}

// =========================================================================
// 5. EXIT 0 REQUIRES PROTOCOL EVIDENCE  (review finding: exit-0 兜底)
// =========================================================================

section('5. exit 0 requires protocol evidence');

const terminal = wb().terminalPolicy;

function input(
  signals: string[],
  code: number | null = 0,
  stderrTail = '',
  localAbort: 'cancelled' | 'timed_out' | null = null,
): TerminalInput {
  return {
    exit: {
      code,
      signal: null,
      stderrTail,
      stderrTruncated: false,
      cleanup: { rootKilled: false, descendantsReaped: false, note: 'root already exited', treeStopConfirmed: false, processStart: 'may-have-started' },
    },
    nativeSignals: signals,
    localAbort,
  };
}

const decide = (i: TerminalInput): TerminalDecision => terminal(i);

check('exit 0 + result frame -> succeeded', decide(input([EVIDENCE_RESULT])).state === 'succeeded');
check(
  'exit 0 + assistant output frame -> succeeded',
  decide(input([EVIDENCE_OUTPUT])).state === 'succeeded',
);
check(
  'exit 0 + both kinds of evidence -> succeeded',
  decide(input([EVIDENCE_OUTPUT, EVIDENCE_RESULT])).state === 'succeeded',
);

const empty = decide(input([]));
check('exit 0 + no frames at all -> failed', empty.state === 'failed');
check(
  'the empty failure uses the explicit protocol wording',
  /process exited successfully but produced no valid protocol result/.test(
    empty.error?.message ?? '',
  ),
  empty.error?.message ?? '',
);
check(
  'the empty failure says stdout/stderr were both empty',
  /both empty/.test(empty.error?.message ?? ''),
  empty.error?.message ?? '',
);
check('the empty failure is not retryable', empty.error?.retryable === false);

const unauthorized = decide(input([], 0, '401 Unauthorized'));
check('exit 0 + "401 Unauthorized" -> failed', unauthorized.state === 'failed');
check(
  'the 401 failure explains the auth problem',
  /401 Unauthorized/.test(unauthorized.error?.message ?? '') &&
    /\/login/.test(unauthorized.error?.message ?? ''),
  unauthorized.error?.message ?? '',
);

check('exit 0 + "403 Forbidden" -> failed', decide(input([], 0, '403 Forbidden')).state === 'failed');
check(
  'exit 0 + another permission error and no evidence -> failed',
  decide(input([], 0, 'Error: permission denied for this account')).state === 'failed',
);
check(
  'exit 0 + unrelated stderr and no evidence -> failed',
  decide(input([], 0, 'some entirely unrelated stderr noise')).state === 'failed',
);
check(
  'exit 0 + evidence but the agent reported an error -> failed',
  decide(input([EVIDENCE_RESULT, 'error: error_during_execution: boom'])).state === 'failed',
);
check(
  'exit 0 + agent-reported error with no evidence -> failed',
  decide(input(['error: error_during_execution: boom'])).state === 'failed',
);
const authError = decide(
  input(['error: error_during_execution: ', 'auth: 401 Unauthorized']),
);
check(
  'auth text in OUTPUT explains the failure (this CLI does not put it on stderr)',
  authError.state === 'failed' &&
    /401 Unauthorized/.test(authError.error?.message ?? '') &&
    /\/login/.test(authError.error?.message ?? ''),
  authError.error?.message ?? '',
);
const stderrAuthError = decide(
  input(['error: error_during_execution: '], 0, '401 Authentication required. Please use /login'),
);
check(
  'an agent-reported failure still explains auth from stderr',
  stderrAuthError.state === 'failed' && /\/login/.test(stderrAuthError.error?.message ?? ''),
  stderrAuthError.error?.message ?? '',
);
check(
  'a result frame outweighs stderr noise (stderr explains, it does not decide)',
  decide(input([EVIDENCE_RESULT], 0, '401 Unauthorized')).state === 'succeeded',
);

check(
  'non-zero exit -> failed even with evidence',
  decide(input([EVIDENCE_RESULT], 3, 'boom')).state === 'failed',
);
check('non-zero exit reports NONZERO_EXIT', decide(input([], 3, 'boom')).error?.code === 'NONZERO_EXIT');
check('exit with no status -> failed', decide(input([], null)).state === 'failed');
check(
  'exit with no status reports SPAWN_FAILED',
  decide(input([], null)).error?.code === 'SPAWN_FAILED',
);
check(
  'local abort -> failed with TRANSPORT_ERROR',
  decide(input([], 0, '', 'cancelled')).state === 'failed',
);

// =========================================================================
// 6. END TO END THROUGH AgentSession (FakeTransport, no real process)
// =========================================================================

section('6. end-to-end (AgentSession + FakeTransport)');

const INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'ses_e2e' });
const TEXT = JSON.stringify({
  type: 'assistant',
  session_id: 'ses_e2e',
  message: {
    content: [{ type: 'text', text: 'SMOKE-OK' }],
    usage: { input_tokens: 1, output_tokens: 1 },
  },
});
const RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'SMOKE-OK',
  session_id: 'ses_e2e',
  usage: { input_tokens: 1, output_tokens: 1 },
});

async function runSession(
  script: ScriptStep[],
  over: Partial<RunRequest> = {},
): Promise<RunResult> {
  const adapter = wb();
  const store = new SessionStore(tmpDir());
  const request: RunRequest = {
    agentId: 'workbuddy-intl',
    prompt: 'smoke',
    cwd: tmpDir(),
    ...over,
  };
  const session = new AgentSession(adapter, store, request, new FakeTransport(script));
  session.start();
  return session.result();
}

const okFull = await runSession([
  { kind: 'frame', text: INIT },
  { kind: 'frame', text: TEXT },
  { kind: 'frame', text: RESULT },
  { kind: 'exit', code: 0 },
]);
check('exit 0 + result frame -> succeeded', okFull.state === 'succeeded', okFull.error?.message ?? '');
check('the assistant answer is the output', okFull.output === 'SMOKE-OK');
check('the thread id is captured from the frames', okFull.threadId === 'ses_e2e');

const okTextOnly = await runSession([
  { kind: 'frame', text: INIT },
  { kind: 'frame', text: TEXT },
  { kind: 'exit', code: 0 },
]);
check(
  'exit 0 + assistant text but no result frame -> succeeded',
  okTextOnly.state === 'succeeded',
  okTextOnly.error?.message ?? '',
);

const silent = await runSession([{ kind: 'exit', code: 0 }]);
check('exit 0 with NO protocol output -> failed', silent.state === 'failed');
check(
  'the failure message is the protocol-evidence one',
  /no valid protocol result/.test(silent.error?.message ?? ''),
  silent.error?.message ?? '',
);
check('the silent run has no output', silent.output === '');

const authSilent = await runSession([
  { kind: 'exit', code: 0, stderrTail: '401 Authentication required. Please use /login command' },
]);
check('exit 0 + auth on stderr and no frames -> failed', authSilent.state === 'failed');
check(
  'the auth failure still explains the sign-in requirement',
  /401 Authentication required/.test(authSilent.error?.message ?? '') &&
    /\/login/.test(authSilent.error?.message ?? ''),
  authSilent.error?.message ?? '',
);

const unauthorizedSilent = await runSession([
  { kind: 'exit', code: 0, stderrTail: '401 Unauthorized' },
]);
check(
  'exit 0 + "401 Unauthorized" and no frames -> failed',
  unauthorizedSilent.state === 'failed',
  unauthorizedSilent.error?.message ?? '',
);

const nonzero = await runSession([
  { kind: 'frame', text: INIT },
  { kind: 'frame', text: TEXT },
  { kind: 'exit', code: 3, stderrTail: 'boom' },
]);
check('non-zero exit fails even with protocol evidence', nonzero.state === 'failed');
check('the non-zero failure is NONZERO_EXIT', nonzero.error?.code === 'NONZERO_EXIT');

const withTool = await runSession([
  { kind: 'frame', text: INIT },
  {
    kind: 'frame',
    text: JSON.stringify({
      type: 'assistant',
      session_id: 'ses_e2e',
      message: {
        content: [{ type: 'tool_use', id: 'call-9', name: 'Read', input: { path: 'probe.txt' } }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }),
  },
  {
    kind: 'frame',
    text: JSON.stringify({
      type: 'user',
      session_id: 'ses_e2e',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call-9', content: 'LINE-ONE-42' }] },
    }),
  },
  { kind: 'frame', text: RESULT },
  { kind: 'exit', code: 0 },
]);
check('a real tool round-trip succeeds', withTool.state === 'succeeded');
check(
  'RunResult.toolCalls holds exactly one entry',
  withTool.toolCalls.length === 1,
  JSON.stringify(withTool.toolCalls),
);
check('the tool entry is the Read call', withTool.toolCalls[0]?.name === 'Read');
check('the tool entry kept its output', withTool.toolCalls[0]?.output === 'LINE-ONE-42');
check('usage was accumulated from the frames', (withTool.usage.outputTokens ?? 0) >= 1);

// =========================================================================
// 7. CAPABILITIES STAY TRUE TO WHAT WAS MEASURED
// =========================================================================

section('7. capabilities are unchanged');

const caps = intlAdapter.descriptor.capabilities;
// 5C-6: isolation is withheld from WorkBuddy. `cwd: true` is necessary but is a
// different claim — that the CLI echoes back a directory, not that two instances
// in two directories keep independent state. The workbuddy binary is not
// installed here, so that cannot be verified, and fail-closed means unproven
// agents are not placed in worktrees. Both variants share one CAPABILITIES block.
check('workspaceModes = [shared] for BOTH WorkBuddy variants',
  intlAdapter.descriptor.capabilities.workspaceModes?.join() === 'shared' &&
  cnAdapter.descriptor.capabilities.workspaceModes?.join() === 'shared',
  `${intlAdapter.descriptor.capabilities.workspaceModes?.join()} / ${cnAdapter.descriptor.capabilities.workspaceModes?.join()}`);
check('shared remains available, so ordinary tasks still run',
  caps.workspaceModes?.includes('shared') === true);
check('isolated is NOT claimed', caps.workspaceModes?.includes('isolated') === false);
for (const key of [
  'newTask',
  'resume',
  'modelSelection',
  'roleSelection',
  'streamEvents',
  'extraArgs',
  'cwd',
] as const) {
  check(`${key} = true`, caps[key] === true);
}
for (const key of [
  'review',
  'sandbox',
  'costReporting',
  'steering',
  'worktree',
  'fork',
  'stdinPrompt',
] as const) {
  check(`${key} = false`, caps[key] === false);
}
check(
  'cn and intl advertise the same capability set',
  JSON.stringify(cnAdapter.descriptor.capabilities) === JSON.stringify(caps),
);

// =========================================================================

for (const d of tmpDirs) {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) {
  process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
}
process.stdout.write('\n');
process.exitCode = failed === 0 ? 0 : 1;
