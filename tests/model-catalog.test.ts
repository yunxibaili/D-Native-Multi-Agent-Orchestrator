/**
 * tests/model-catalog.test.ts — B1.1 hermetic tests for the READ-ONLY native model
 * catalogue snapshot (`src/runtime/model-catalog.ts` + `doctor --models`).
 *
 * Nothing here spawns a real agent: the command boundary is an INJECTED runner, so
 * the tests are instant and machine-independent. The contract under test:
 *
 *   - the catalogue query is OPT-IN: default `doctor` runs the runner ZERO times;
 *   - listed != connected != callable != free: a catalogue entry never becomes a
 *     scheduling candidate, and the registry is untouched;
 *   - an empty catalogue, an unsupported agent, a non-zero exit, a timeout and
 *     unparseable output are all DIFFERENT, honest states;
 *   - partial / non-zero / timeout output can NEVER be promoted to `ok`.
 *
 * Run: node tests/model-catalog.test.ts
 */

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CATALOG_STATUSES,
  CATALOG_SUPPORTED_AGENTS,
  collectModelCatalog,
  isCatalogSupported,
  notCollectedCatalog,
  parseOpenCodeModelList,
  type ModelCatalogSnapshot,
} from '../src/runtime/model-catalog.ts';
import type { CmdRunner, RunOutcome } from '../src/quota/collector.ts';
import { ModelRegistry } from '../src/quota/registry.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { knownAgentIds } from '../src/adapters/index.ts';
import { createFakeAdapter, sourceText } from './helpers.ts';

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
    failures.push(name + (detail ? ` - ${detail}` : ''));
    process.stdout.write(`  FAIL ${name}${detail ? ` - ${detail}` : ''}\n`);
  }
}
function section(t: string): void {
  process.stdout.write(`\n== ${t}\n`);
}

// ---------------------------------------------------------------------------
// An injected runner that records every call and returns a scripted outcome.
// ---------------------------------------------------------------------------
interface Call {
  command: string;
  args: readonly string[];
  timeoutMs: number | undefined;
}
function scriptedRunner(outcome: RunOutcome): { runner: CmdRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: CmdRunner = async (command, args, timeoutMs) => {
    calls.push({ command, args, timeoutMs });
    return outcome;
  };
  return { runner, calls };
}

const MODELS_FIXTURE = [
  '\u001b[32manthropic/claude-sonnet-4-5\u001b[0m', // ANSI-wrapped
  'openai/gpt-5.1-codex',
  'opencode/gpt-5.1-codex',
  'openrouter/anthropic/claude-sonnet-4.5', // nested slash: provider is the first segment
  'anthropic/claude-sonnet-4-5', // duplicate of the first
  '',
  '   ', // whitespace-only line
].join('\n');

// =========================================================================
section('pure parser: provider/model identity, ANSI, dedupe, strictness');

{
  const parsed = parseOpenCodeModelList(MODELS_FIXTURE);
  check('parser keeps four unique models (dupes collapsed, blanks skipped)', parsed.models.length === 4,
    String(parsed.models.length));
  check('parser strips ANSI so piped output matches interactive',
    parsed.models[0]?.modelId === 'anthropic/claude-sonnet-4-5', parsed.models[0]?.modelId);
  check('parser splits provider at the FIRST slash',
    parsed.models[0]?.provider === 'anthropic', parsed.models[0]?.provider);
  check('parser preserves the FULL nested provider/model identity',
    parsed.models.some((m) => m.modelId === 'openrouter/anthropic/claude-sonnet-4.5' && m.provider === 'openrouter'));
  check('parser keeps the CLI order stable',
    parsed.models.map((m) => m.modelId).join(',') ===
      'anthropic/claude-sonnet-4-5,openai/gpt-5.1-codex,opencode/gpt-5.1-codex,openrouter/anthropic/claude-sonnet-4.5',
    parsed.models.map((m) => m.modelId).join(','));

  // A line with whitespace is not a bare `provider/model` token: it is rejected,
  // never guessed at (headers, tables, `--verbose` metadata columns).
  const verbose = parseOpenCodeModelList('anthropic/claude-sonnet-4-5  $3/$15 per 1M\nopenai/gpt-5.1-codex  $1.25/$10\n');
  check('parser rejects metadata/table lines instead of inventing models', verbose.models.length === 0 && verbose.rejected.length === 2,
    `models=${verbose.models.length} rejected=${verbose.rejected.length}`);

  // A header does not break a valid listing.
  const withHeader = parseOpenCodeModelList('Available models:\nopencode/gpt-5.1-codex\n');
  check('parser ignores a header when real entries follow', withHeader.models.length === 1, String(withHeader.models.length));
}

// =========================================================================
section('collect: each state is distinct and honest (injected runner)');

{
  const now = (): number => 1_700_000_000_000;

  // ok — preserves identity + source + time.
  const ok = scriptedRunner({ stdout: MODELS_FIXTURE, stderr: '', code: 0 });
  const okSnap = await collectModelCatalog('opencode', { runner: ok.runner, now, timeoutMs: 1234 });
  check('ok: status is ok with the listed models', okSnap.status === 'ok' && okSnap.models.length === 4, okSnap.status);
  check('ok: full modelId + provider + agentId preserved',
    okSnap.models[0]!.modelId === 'anthropic/claude-sonnet-4-5' &&
      okSnap.models[0]!.provider === 'anthropic' && okSnap.models[0]!.agentId === 'opencode');
  check('ok: source names the exact command', okSnap.source.endsWith(' models'), okSnap.source);
  check('ok: listedAt comes from the clock seam', okSnap.listedAt === now());
  check('ok: runner received the catalogue argv + timeout',
    ok.calls.length === 1 && ok.calls[0]!.args.includes('models') && ok.calls[0]!.timeoutMs === 1234,
    JSON.stringify(ok.calls[0]));

  // empty — exit 0, nothing listed: a REAL empty answer, not a failure.
  const empty = scriptedRunner({ stdout: '', stderr: '', code: 0 });
  const emptySnap = await collectModelCatalog('opencode', { runner: empty.runner, now });
  check('empty: status is empty, distinct from failed', emptySnap.status === 'empty' && emptySnap.models.length === 0, emptySnap.status);

  // failed — non-zero exit: partial stdout is DISCARDED, never parsed into success.
  const nonzero = scriptedRunner({ stdout: 'opencode/gpt-5.1-codex\n', stderr: 'boom', code: 1 });
  const nonzeroSnap = await collectModelCatalog('opencode', { runner: nonzero.runner, now });
  check('failed: non-zero exit cannot be a catalogue success',
    nonzeroSnap.status === 'failed' && nonzeroSnap.models.length === 0, nonzeroSnap.status);
  check('failed: the non-zero reason is carried', /exited 1/.test(nonzeroSnap.note), nonzeroSnap.note);

  // failed — timeout (code null): still failed, partial output discarded.
  const timeout = scriptedRunner({ stdout: 'opencode/gpt-5.1-codex\n', stderr: '', code: null });
  const timeoutSnap = await collectModelCatalog('opencode', { runner: timeout.runner, now });
  check('failed: a null exit (timeout/killed) is failed, not empty/ok',
    timeoutSnap.status === 'failed' && /timeout|killed/.test(timeoutSnap.note), timeoutSnap.note);

  // failed — exit 0 but unparseable output.
  const garbage = scriptedRunner({ stdout: 'anthropic/claude-sonnet-4-5  $3/$15 per 1M\n', stderr: '', code: 0 });
  const garbageSnap = await collectModelCatalog('opencode', { runner: garbage.runner, now });
  check('failed: exit-0 unparseable output is failed, never empty/ok', garbageSnap.status === 'failed', garbageSnap.status);

  // unsupported — the runner must NOT even be called for an unknown agent.
  const unsupported = scriptedRunner({ stdout: MODELS_FIXTURE, stderr: '', code: 0 });
  const unsupportedSnap = await collectModelCatalog('codex', { runner: unsupported.runner, now });
  check('unsupported: a non-OpenCode agent is labelled unsupported', unsupportedSnap.status === 'unsupported', unsupportedSnap.status);
  check('unsupported: no process is started for it', unsupported.calls.length === 0, String(unsupported.calls.length));

  // not_collected — explicit opt-out runs nothing.
  const off = scriptedRunner({ stdout: MODELS_FIXTURE, stderr: '', code: 0 });
  const offSnap = await collectModelCatalog('opencode', { runner: off.runner, enabled: false, now });
  check('not_collected: disabled collection runs the runner zero times', offSnap.status === 'not_collected' && off.calls.length === 0,
    `${offSnap.status}/${off.calls.length}`);

  // The state space is exactly the five required distinctions.
  check('the status set is the five required distinctions',
    [...CATALOG_STATUSES].sort().join(',') === ['ok', 'empty', 'unsupported', 'failed', 'not_collected'].sort().join(','),
    CATALOG_STATUSES.join(','));
  check('only opencode is a supported catalogue agent',
    CATALOG_SUPPORTED_AGENTS.length === 1 && CATALOG_SUPPORTED_AGENTS[0] === 'opencode' && isCatalogSupported('opencode') && !isCatalogSupported('codex'));
  check('notCollectedCatalog is a pure not_collected snapshot',
    notCollectedCatalog('opencode').status === 'not_collected');
}

// =========================================================================
section('fact boundary: listed is NOT a scheduling candidate; registry unchanged');

{
  const reg = new ModelRegistry();
  reg.upsert(
    { agentId: 'opencode', modelId: 'opencode/gpt-5.1-codex', provider: 'opencode', taskTypes: ['implementation'], modelSource: 'config' },
    1,
  );
  const before = JSON.stringify(reg.list());

  const { runner } = scriptedRunner({ stdout: MODELS_FIXTURE, stderr: '', code: 0 });
  const snap: ModelCatalogSnapshot = await collectModelCatalog('opencode', { runner, now: () => 2 });

  check('registry facts are byte-identical before and after a catalogue query', before === JSON.stringify(reg.list()));
  check('a freshly listed model is NOT present in the registry',
    !reg.list().some((e) => e.modelId === 'anthropic/claude-sonnet-4-5'));
  check('the snapshot is the only place the listed models appear', snap.models.length === 4);
}

// =========================================================================
section('doctor: default runs ZERO catalogue queries; --models is explicit');

{
  const storeDir = mkdtempSync(join(tmpdir(), 'mc-doctor-'));
  tmpDirs.push(storeDir);
  // Replace EVERY known adapter with a fake, so doctor never probes a real binary.
  const fakes = knownAgentIds().map((id) => createFakeAdapter({ id }));
  const orch = new Orchestrator({ config: { agents: {} }, storeDir, replaceAdapters: fakes });

  const calls: Call[] = [];
  const runner: CmdRunner = async (command, args, timeoutMs) => {
    calls.push({ command, args, timeoutMs });
    return { stdout: MODELS_FIXTURE, stderr: '', code: 0 };
  };

  const d1 = await orch.doctor();
  check('default doctor: no catalogue snapshot', d1.modelCatalog === undefined);
  check('default doctor: the catalogue runner was called ZERO times', calls.length === 0, String(calls.length));

  const d2 = await orch.doctor({ modelCatalog: { agentId: 'opencode', runner } });
  check('opt-in doctor: a read-only snapshot is attached', d2.modelCatalog?.status === 'ok', d2.modelCatalog?.status);
  check('opt-in doctor: the runner was called exactly once', calls.length === 1, String(calls.length));
  check('opt-in doctor: the snapshot preserves full model identity',
    d2.modelCatalog?.models[0]?.modelId === 'anthropic/claude-sonnet-4-5');
  check('opt-in doctor: the agent report itself is unchanged by the catalogue',
    d1.agents.length === d2.agents.length && d1.agents.every((a, i) => a.id === d2.agents[i]!.id));

  const d3 = await orch.doctor();
  check('default doctor again: still zero additional catalogue calls', d3.modelCatalog === undefined && calls.length === 1,
    String(calls.length));

  const d4 = await orch.doctor({ modelCatalog: { agentId: 'codex', runner } });
  check('opt-in for a non-OpenCode agent is unsupported and starts nothing new', d4.modelCatalog?.status === 'unsupported' && calls.length === 1,
    `${d4.modelCatalog?.status}/${calls.length}`);
}

// =========================================================================
section('architecture: no new authority, no execution edge, no shell');

{
  const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const mc = strip(sourceText('src/runtime/model-catalog.ts'));

  check('model-catalog.ts never writes the Model Registry',
    !/ModelRegistry|setModelAvailability|setAgentAvailability|\.upsert\(/.test(mc));
  check('model-catalog.ts never touches assignment or the spawn gate',
    !/assignWorker|evaluateSpawnGate|spawn-gate|assignment\.ts/.test(mc));
  check('model-catalog.ts never calls runtime.run', !/runtime\s*\.\s*run\s*\(/.test(mc) && !/\.run\s*\(/.test(mc));
  check('model-catalog.ts never uses a shell', !/shell\s*:\s*true/.test(mc));
  // It reuses the ONE existing bounded runner (timeout + kill) rather than opening
  // its own process edge, so the timeout/cleanup contract is inherited unchanged.
  check('model-catalog.ts defaults to the existing bounded execRunner', /opts\.runner\s*\?\?\s*execRunner/.test(mc));
  check('model-catalog.ts never spawns a process itself', !/child_process|execFile|spawn\s*\(/.test(mc));

  // The project invariant: exactly ONE real `runtime.run(` call site across src/.
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) files.push(p);
    }
  };
  walk(fileURLToPath(new URL('../src', import.meta.url)));
  const sites: string[] = [];
  for (const f of files) {
    if (/runtime\s*\.\s*run\s*\(/.test(strip(sourceText(f)))) sites.push(f);
  }
  check('src/ still has exactly ONE real runtime.run( call site', sites.length === 1, JSON.stringify(sites));
  check('...and it is the orchestration Orchestrator', sites.length === 1 && sites[0]!.endsWith('orchestration/orchestrator.ts'),
    JSON.stringify(sites));
}

// =========================================================================

for (const dir of tmpDirs) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
process.stdout.write('\n');
process.exitCode = failed === 0 ? 0 : 1;
