/**
 * cli/index.ts — the smoke-test surface.
 *
 * Design rule: stdout carries DATA, stderr carries DIAGNOSTICS. With `--json`
 * every runtime event is written to stdout as one NDJSON object, so
 * `orchestrator run codex "..." --json | jq` works identically on Windows.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setLogLevel, type LogLevel } from '../core/log.ts';
import { Orchestrator } from '../orchestrator/orchestrator.ts';
import { writeStarterConfig, type AgentConfig } from '../orchestrator/config.ts';
import { runTaskCli } from './task-cli.ts';
import { buildQuotaCenter, type BuildQuotaCenterOptions, type QuotaCenterView } from '../quota/index.ts';
import type { RunRequest, RunResult } from '../core/types.ts';

const USAGE = `
orchestrator — local multi-agent runtime (native CLI adapters)

USAGE
  orchestrator <command> [options]

COMMANDS
  doctor [--models <agent>]       report agent availability + capabilities
                                  --models: opt-in, READ-ONLY native model catalogue
                                  (OpenCode only this slice; listed != callable != free)
  run <agent> <prompt>            run a new task on a native agent
  resume <agent> <threadId> <prompt>   continue an existing thread
  review <agent> <prompt>         native review entrypoint (codex)
  threads [agent]                 list resumable threads
  tasks [limit]                   list recent tasks
  show <taskId>                   print a stored task result
  quota [--json] [--offline]      quota / model registry / budget / spawn gate snapshot
  task list|inspect|diff|merge   workspace loop: see a child's work, merge it into your repo
  round "<objective>"            ONE execution round: Laya decides → tasks execute → report
  init                            write a starter orchestrator.json
  smoke [--quick]                 end-to-end verification suite

OPTIONS
  --cwd <dir>        working directory for the agent (default: config, else cwd)
  --model <id>       native model id, passed through verbatim
  --role <id>        native role / agent / profile
  --sandbox <mode>   codex sandbox: read-only | workspace-write | danger-full-access
  --timeout <ms>     hard wall-clock limit; cancels the task
  --extra <arg>      append a raw flag to the agent argv (repeatable)
  --json             emit every runtime event as NDJSON on stdout
  --quiet            suppress the human-readable result
  --log-level <lvl>  silent|error|warn|info|debug   (default: warn)
  --config <path>    explicit orchestrator.json

AGENTS (Phase 1)
  opencode   opencode run --format json    (session resume: yes, review: no)
  codex      codex exec --json             (session resume: yes, review: yes)

EXAMPLES
  orchestrator run opencode "add a README section" --cwd .
  orchestrator run codex "review src/agent.ts" --mode review
  orchestrator run codex "explain the event contract" --json
  orchestrator resume codex <threadId> "now write the tests"
`;

interface Parsed {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
}

/**
 * Flags whose value must be consumed verbatim, even when it starts with `--`.
 *
 * `--extra` exists to pass raw agent flags such as `--definitely-not-a-flag`
 * or `-p some-profile`; without this, the leading dashes make the generic
 * parser treat the value as another flag and the escape hatch silently does
 * nothing. `--extra=<value>` always worked; this makes the spaced form work too.
 */
const VERBATIM_VALUE_FLAGS = new Set(['extra']);

function parseArgs(argv: readonly string[]): Parsed {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        i++;
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      const wantsVerbatim = VERBATIM_VALUE_FLAGS.has(key);
      if (next !== undefined && (wantsVerbatim || !next.startsWith('--'))) {
        if (key === 'extra') {
          const prev = flags[key];
          flags[key] = Array.isArray(prev)
            ? [...prev, next]
            : typeof prev === 'string'
              ? [prev, next]
              : [next];
        } else {
          flags[key] = next;
        }
        i += 2;
        continue;
      }
      flags[key] = true;
      i++;
      continue;
    }
    positionals.push(a);
    i++;
  }
  return { command: positionals[0] ?? 'help', positionals: positionals.slice(1), flags };
}

function str(flags: Parsed['flags'], key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

function num(flags: Parsed['flags'], key: string): number | undefined {
  const v = str(flags, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function strList(flags: Parsed['flags'], key: string): string[] | undefined {
  const v = flags[key];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return [v];
  return undefined;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  // 5C-9: `task` owns its own flags. The generic parser below splits argv into
  // positionals and flags and would silently swallow --verified / --json before
  // the subcommand ever saw them, which made `task merge A --verified` refuse for
  // the wrong reason. So `task` is dispatched BEFORE generic parsing, with the
  // rest of argv handed over verbatim.
  const taskAt = argv.indexOf('task');
  if (taskAt >= 0) {
    const cwdIdx = argv.indexOf('--cwd');
    const cwd = cwdIdx >= 0 && argv[cwdIdx + 1] !== undefined ? resolve(argv[cwdIdx + 1]!) : process.cwd();
    const rest = argv.filter((a, i) => {
      if (i === cwdIdx || i === cwdIdx + 1) return false;
      return a !== '--cwd';
    }).slice(taskAt + 1);
    return runTaskCli(rest, cwd);
  }

  // R1-0: `round` is dispatched before generic parsing for the same reason `task` is —
  // it owns its own flags, and the generic parser would swallow the objective and the
  // --laya-* values before the round ever saw them. It needs the runtime Orchestrator
  // for its descriptors/configs/runner, so it builds one here exactly as below does.
  if (argv[0] === 'round') {
    const configAt = argv.findIndex((a) => a === '--config' || a.startsWith('--config='));
    const configPath =
      configAt >= 0
        ? argv[configAt]!.includes('=')
          ? argv[configAt]!.slice(argv[configAt]!.indexOf('=') + 1)
          : argv[configAt + 1]
        : undefined;
    const { runRoundCli } = await import('./round-cli.ts');
    return runRoundCli(new Orchestrator({ configPath }), argv.slice(1));
  }

  const parsed = parseArgs(argv);

  setLogLevel((str(parsed.flags, 'log-level') as LogLevel) ?? 'warn');

  if (parsed.command === 'help' || parsed.flags.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const orch = new Orchestrator({ configPath: str(parsed.flags, 'config') });

  switch (parsed.command) {
    case 'doctor':
      return cmdDoctor(orch, parsed);
    case 'init':
      return cmdInit();
    case 'run':
      return cmdRun(orch, parsed, 'run');
    case 'review':
      return cmdRun(orch, parsed, 'review');
    case 'resume':
      return cmdRun(orch, parsed, 'resume');
    case 'threads':
      return cmdThreads(orch, parsed);
    case 'tasks':
      return cmdTasks(orch, parsed);
    case 'show':
      return cmdShow(orch, parsed);
    case 'quota':
      return cmdQuota(orch, parsed);
    case 'smoke':
      return cmdSmoke(orch, parsed);
    default:
      process.stderr.write(`Unknown command "${parsed.command}".\n${USAGE}`);
      return 2;
  }
}

function buildRequest(orch: Orchestrator, parsed: Parsed, mode: 'run' | 'review' | 'resume'): {
  req: RunRequest;
} {
  const pos = parsed.positionals;
  if (mode === 'resume') {
    const [agentId, threadId, ...rest] = pos;
    if (!agentId || !threadId) {
      throw new Error('Usage: orchestrator resume <agent> <threadId> <prompt...>');
    }
    return { req: makeRequest(orch, parsed, agentId, rest.join(' '), threadId) };
  }
  const [agentId, ...rest] = pos;
  if (!agentId || rest.length === 0) {
    throw new Error(`Usage: orchestrator ${mode} <agent> <prompt...>`);
  }
  return { req: makeRequest(orch, parsed, agentId, rest.join(' '), undefined) };
}

function makeRequest(
  orch: Orchestrator,
  parsed: Parsed,
  agentId: string,
  prompt: string,
  threadId: string | undefined,
): RunRequest {
  const cfg = orch.configFor(agentId);
  const cwdFlag = str(parsed.flags, 'cwd');
  const cwd = resolve(cwdFlag ?? cfg.cwd ?? process.cwd());
  if (!existsSync(cwd)) {
    throw new Error(`Working directory does not exist: ${cwd}`);
  }
  return {
    agentId,
    prompt,
    cwd,
    threadId,
    model: str(parsed.flags, 'model'),
    role: str(parsed.flags, 'role'),
    sandbox: str(parsed.flags, 'sandbox'),
    mode: parsed.command === 'review' ? 'review' : 'default',
    extraArgs: strList(parsed.flags, 'extra'),
    timeoutMs: num(parsed.flags, 'timeout'),
  };
}

async function cmdRun(
  orch: Orchestrator,
  parsed: Parsed,
  mode: 'run' | 'review' | 'resume',
): Promise<number> {
  const { req } = buildRequest(orch, parsed, mode);
  const asJson = parsed.flags.json === true;
  const quiet = parsed.flags.quiet === true;

  const handle = orch.run(req);

  // Drain by SUBSCRIPTION COMPLETION, not by sleeping. The event hub is closed
  // when the outcome is frozen, so the loop ends exactly when the last event
  // has been delivered. The previous fixed 50ms sleep raced the process and
  // could truncate the stream.
  const drained: Promise<void> = asJson
    ? (async () => {
        for await (const ev of handle.events()) {
          process.stdout.write(JSON.stringify(ev) + '\n');
        }
      })()
    : Promise.resolve();

  let result: RunResult;
  try {
    result = await handle.result();
  } catch (e) {
    process.stderr.write(`\n${(e as Error).message}\n`);
    return 1;
  }

  if (asJson) {
    // Awaiting the consumer, not a timer, is the guarantee that every event
    // reached stdout before we exit.
    await drained;
  }

  if (!quiet && !asJson) {
    printResult(result);
  }
  return result.state === 'succeeded' ? 0 : 1;
}

function printResult(r: RunResult): void {
  // Block body: `process.stdout.write` returns boolean, and a concise arrow
  // would make this helper return boolean instead of void.
  const w = (s = ''): void => {
    process.stdout.write(s + '\n');
  };
  w(`task    ${r.taskId}`);
  w(`agent   ${r.agentId}`);
  w(`state   ${r.state}${r.exitCode !== null ? ` (exit ${r.exitCode})` : ''}`);
  w(`thread  ${r.threadId ?? '(none)'}`);
  if (r.usage.inputTokens !== undefined || r.usage.outputTokens !== undefined) {
    w(
      `tokens  in=${r.usage.inputTokens ?? '-'} out=${r.usage.outputTokens ?? '-'}` +
        (r.usage.costUsd !== undefined ? ` cost=$${r.usage.costUsd.toFixed(4)}` : ''),
    );
  }
  if (r.toolCalls.length) {
    w(`tools   ${r.toolCalls.length}`);
    for (const t of r.toolCalls.slice(0, 8)) {
      w(`        - ${t.name}${t.status ? ` [${t.status}]` : ''}${t.exitCode !== null && t.exitCode !== undefined ? ` exit=${t.exitCode}` : ''}`);
    }
    if (r.toolCalls.length > 8) w(`        … ${r.toolCalls.length - 8} more`);
  }
  if (r.error) w(`error   ${r.error.code}: ${r.error.message}`);
  if (r.diagnostics.length) {
    w(`notes   ${r.diagnostics.length} agent diagnostic(s)`);
    for (const d of r.diagnostics.slice(0, 3)) w(`        - ${d.slice(0, 160)}`);
  }
  if (r.transcriptPath) w(`log     ${r.transcriptPath}`);
  w();
  w('--- output ---');
  w(r.output || '(empty)');
}

async function cmdDoctor(orch: Orchestrator, parsed: Parsed): Promise<number> {
  const modelsFlag = parsed.flags.models;
  if (modelsFlag === true) {
    process.stderr.write('Usage: orchestrator doctor [--models <agent>] [--json]\n');
    return 2;
  }
  const modelsAgent = typeof modelsFlag === 'string' ? modelsFlag : undefined;

  // B1.1: the catalogue query is EXPLICIT. Without `--models`, `doctor` behaves
  // exactly as before and starts no catalogue process.
  const report =
    modelsAgent !== undefined
      ? await orch.doctor({ modelCatalog: { agentId: modelsAgent } })
      : await orch.doctor();

  // `--json` with `--models` emits ONLY the read-only snapshot (data on stdout).
  if (modelsAgent !== undefined && parsed.flags.json === true) {
    process.stdout.write(JSON.stringify(report.modelCatalog, null, 2) + '\n');
    return report.modelCatalog?.status === 'failed' ? 1 : 0;
  }

  const w = (s = ''): void => {
    process.stdout.write(s + '\n');
  };
  w('orchestrator doctor');
  w(`  config   ${report.configSource ?? '(none found — using discovery + defaults)'}`);
  w(`  store    ${report.storeDir}`);
  w(`  agents   ${report.agents.length} registered`);
  w();
  for (const a of report.agents) {
    w(`  [${a.ok ? 'ok' : 'FAIL'}] ${a.id} (${a.displayName})`);
    w(`        launcher ${a.launcher}`);
    w(`        version  ${a.version ?? 'unknown'}`);
    w(`        detail   ${a.detail}`);
    if (a.warnings.length) for (const x of a.warnings) w(`        warn     ${x}`);
    w(`        auth     ${a.credentialsHint ?? '(agent-managed)'}`);
    w(`        transport ${a.transport}`);
    const caps = Object.entries(a.capabilities)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(', ');
    w(`        can      ${caps}`);
    const cannot = Object.entries(a.capabilities)
      .filter(([, v]) => !v)
      .map(([k]) => k)
      .join(', ');
    if (cannot) w(`        rejects  ${cannot}`);
    w();
  }

  const cat = report.modelCatalog;
  if (cat !== undefined) {
    w(`  MODEL CATALOGUE (${cat.agentId}) — read-only; listed != connected != callable != free`);
    w(`        status   ${cat.status}`);
    w(`        source   ${cat.source}`);
    w(`        listedAt ${cat.listedAt ? new Date(cat.listedAt).toISOString() : '(not collected)'}`);
    if (cat.note) w(`        note     ${cat.note}`);
    if (cat.models.length > 0) {
      w(`        models   ${cat.models.length}`);
      for (const m of cat.models) w(`          - ${m.modelId}`);
    }
    w();
  }

  const agentsOk = report.agents.every((a) => a.ok);
  // A FAILED catalogue query is a diagnostic failure (non-zero). `unsupported`,
  // `empty` and `not_collected` are honest answers, not failures, and never disable
  // a model or an agent.
  return agentsOk && cat?.status !== 'failed' ? 0 : 1;
}

function cmdInit(): number {
  const p = writeStarterConfig();
  process.stdout.write(`Config written to ${p}\nReview the paths, then run: orchestrator doctor\n`);
  return 0;
}

function cmdThreads(orch: Orchestrator, parsed: Parsed): number {
  const list = orch.listThreads(parsed.positionals[0]);
  if (!list.length) {
    process.stdout.write('No threads yet. Run a task first.\n');
    return 0;
  }
  for (const t of list) {
    process.stdout.write(
      `${t.threadId}  ${t.agentId}  ${new Date(t.lastUsedAt).toISOString()}  tasks=${t.taskIds.length}  ${t.cwd}\n`,
    );
  }
  return 0;
}

function cmdTasks(orch: Orchestrator, parsed: Parsed): number {
  const limit = Number(parsed.positionals[0] ?? '20') || 20;
  const list = orch.listTasks(limit);
  if (!list.length) {
    process.stdout.write('No tasks yet.\n');
    return 0;
  }
  for (const t of list) {
    process.stdout.write(
      `${t.taskId}  ${t.agentId.padEnd(9)} ${t.state.padEnd(10)} exit=${String(t.exitCode)}  thread=${t.threadId ?? '-'}  ${new Date(t.endedAt).toISOString()}\n`,
    );
  }
  return 0;
}

function cmdShow(orch: Orchestrator, parsed: Parsed): number {
  const id = parsed.positionals[0];
  if (!id) {
    process.stderr.write('Usage: orchestrator show <taskId>\n');
    return 2;
  }
  const r = orch.getTask(id);
  if (!r) {
    process.stderr.write(`No stored task "${id}".\n`);
    return 1;
  }
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  return 0;
}

async function cmdQuota(orch: Orchestrator, parsed: Parsed): Promise<number> {
  const configs: Record<string, AgentConfig> = {};
  for (const id of orch.agentIds()) configs[id] = orch.configFor(id);
  const opts: BuildQuotaCenterOptions = {
    store: orch.store,
    configs,
    descriptors: orch.descriptors(),
  };
  // --offline: no CLI probing at all; store-derived rows only, and every
  // unprobed value says "Unknown"/"Not Fetched" rather than pretending.
  if (parsed.flags.offline === true) opts.probes = [];

  const center = await buildQuotaCenter(opts);
  if (parsed.flags.json === true) {
    process.stdout.write(JSON.stringify(center, null, 2) + '\n');
    return 0;
  }
  printQuotaCenter(center);
  return 0;
}

function printQuotaCenter(c: QuotaCenterView): void {
  const w = (s = ''): void => {
    process.stdout.write(s + '\n');
  };
  const table = (header: string[], rows: string[][]): void => {
    const widths = header.map((h, i) => Math.max(len(h), ...rows.map((r) => len(r[i] ?? ''))));
    w(header.map((h, i) => pad(h, widths[i]!)).join('  '));
    w(widths.map((n) => '-'.repeat(n)).join('  '));
    for (const r of rows) w(header.map((_, i) => pad(r[i] ?? '', widths[i]!)).join('  '));
    w();
  };

  w(`orchestrator quota — ${c.generatedAt}`);
  w();
  w('AGENT STATUS');
  table(
    ['Agent', 'Version', 'Installed', 'Login', 'QuotaSource', 'Usage', 'Status'],
    c.agentStatus.map((r) => [r.agent, r.version, r.installed, r.login, r.quotaSource, r.usage, r.status]),
  );

  w('MODEL REGISTRY');
  table(
    ['Agent', 'Model', 'Capability', 'Avail', 'Policy', 'Reason'],
    c.modelRegistry.map((r) => [r.agent, r.model, r.capability, r.availability, r.policy, r.reason]),
  );

  w('QUOTA');
  table(
    ['Provider', 'Model', 'Period', 'Used', 'Remaining', 'Reset', 'Source', 'Confidence', 'Status'],
    c.quota.map((r) => [r.provider, r.model, r.period, r.used, r.remaining, r.reset, r.source, r.confidence, r.status]),
  );

  w('FREE CREDIT / PROMOTIONS');
  w(`  ${c.freeCredit.status}`);
  for (const m of c.freeCredit.freeModels) {
    w(`  free model: ${m.modelId}  (${m.agent}, source: ${m.source}, observed ${m.observedAt})`);
  }
  w();

  w('BUDGET (orchestration budget — NOT provider billing)');
  table(
    ['Scope', 'Id', 'Allocated', 'Reserved', 'Consumed', 'Remaining'],
    c.budgets.map((b) => [b.scope, b.id, String(b.allocated), String(b.reserved), String(b.consumed), String(b.remaining)]),
  );

  w('SPAWN GATE (decision only — nothing was spawned)');
  w(`  ${c.spawnGate.allowed ? 'allowed' : 'denied'} [${c.spawnGate.code}] ${c.spawnGate.reason}`);
  w();
  w(c.classificationNote);
}

function len(s: string): number {
  return [...s].length;
}

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - len(s)));
}

async function cmdSmoke(orch: Orchestrator, parsed: Parsed): Promise<number> {
  const { runSmoke } = await import('../../tests/smoke.ts');
  // Per-agent model overrides. A single --model cannot work: `opencode/…` ids
  // are meaningless to Codex and vice versa.
  const models: { opencode?: string; codex?: string } = {};
  const oc = str(parsed.flags, 'opencode-model');
  const cx = str(parsed.flags, 'codex-model');
  if (oc) models.opencode = oc;
  if (cx) models.codex = cx;
  return runSmoke(orch, {
    quick: parsed.flags.quick === true,
    asJson: parsed.flags.json === true,
    models,
    role: str(parsed.flags, 'role'),
    sandbox: str(parsed.flags, 'sandbox'),
    timeoutMs: num(parsed.flags, 'timeout'),
  });
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    const err = e as Error;
    process.stderr.write(`\n${err.name}: ${err.message}\n`);
    if (process.env.ORCH_DEBUG) process.stderr.write(String(err.stack) + '\n');
    process.exitCode = 1;
  });
