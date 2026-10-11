/**
 * tests/model-catalog.test.ts — B1.1 / B1.1a hermetic tests for the READ-ONLY
 * native model catalogue snapshot (`src/runtime/model-catalog.ts` + `doctor --models`).
 *
 * Two contracts are under test:
 *
 *  1. HERMETIC — no test depends on OpenCode being installed. The command seam is
 *     either an injected runner (pure parser/status tests) or a CONTROLLED fixture
 *     executable written into an owned temp dir. `resolveCommand` is always pointed
 *     at a path this test controls, so "installed" and "not installed" machines both
 *     pass. A real discovery FAILURE is still asserted independently.
 *
 *  2. CONTAINMENT — the DEFAULT execution path runs through `ManagedProcess` (the
 *     sealed Job launcher), not a bare `execFile`. A controlled fixture that leaves a
 *     live descendant proves that a timeout confirms the whole tree stopped; an
 *     unconfirmed stop is a FAILURE, never a collected catalogue.
 *
 * The frozen fact boundary is unchanged: listed != connected != callable != free;
 * nothing here writes the Model Registry or affects assignment / quota / spawn gate.
 *
 * Run: node tests/model-catalog.test.ts
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CATALOG_STATUSES,
  CATALOG_SUPPORTED_AGENTS,
  catalogSnapshotFromRun,
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
import { containmentEnabled, resolveContainmentLauncher } from '../src/runtime/containment.ts';
import { createFakeAdapter, sourceText } from './helpers.ts';
import { open as openObserver, livenessNative, type Observer } from './helpers/process-observer.ts';

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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function readNum(path: string): number {
  try {
    return Number(readFileSync(path, 'utf8').trim());
  } catch {
    return 0;
  }
}
const ownDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'mc-'));
  tmpDirs.push(d);
  return d;
};

// ---------------------------------------------------------------------------
// Injected runner (pure tests): records calls, returns a scripted outcome.
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

// A controlled, ALREADY-EXISTING command so injected tests never touch real discovery.
// Node is guaranteed present (this test runs under it).
const CONTROLLED_CMD = process.execPath;

const MODELS_FIXTURE = [
  '\u001b[32manthropic/claude-sonnet-4-5\u001b[0m',
  'openai/gpt-5.1-codex',
  'opencode/gpt-5.1-codex',
  'openrouter/anthropic/claude-sonnet-4.5',
  'anthropic/claude-sonnet-4-5',
  '',
  '   ',
].join('\n');

// =========================================================================
section('pure parser: provider/model identity, ANSI, dedupe, strictness');

{
  const parsed = parseOpenCodeModelList(MODELS_FIXTURE);
  check('parser keeps four unique models (dupes collapsed, blanks skipped)', parsed.models.length === 4, String(parsed.models.length));
  check('parser strips ANSI so piped output matches interactive', parsed.models[0]?.modelId === 'anthropic/claude-sonnet-4-5', parsed.models[0]?.modelId);
  check('parser splits provider at the FIRST slash', parsed.models[0]?.provider === 'anthropic', parsed.models[0]?.provider);
  check('parser preserves the FULL nested provider/model identity',
    parsed.models.some((m) => m.modelId === 'openrouter/anthropic/claude-sonnet-4.5' && m.provider === 'openrouter'));
  check('parser keeps the CLI order stable',
    parsed.models.map((m) => m.modelId).join(',') ===
      'anthropic/claude-sonnet-4-5,openai/gpt-5.1-codex,opencode/gpt-5.1-codex,openrouter/anthropic/claude-sonnet-4.5',
    parsed.models.map((m) => m.modelId).join(','));

  const verbose = parseOpenCodeModelList('anthropic/claude-sonnet-4-5  $3/$15 per 1M\nopenai/gpt-5.1-codex  $1.25/$10\n');
  check('parser rejects metadata/table lines instead of inventing models', verbose.models.length === 0 && verbose.rejected.length === 2,
    `models=${verbose.models.length} rejected=${verbose.rejected.length}`);
  const withHeader = parseOpenCodeModelList('Available models:\nopencode/gpt-5.1-codex\n');
  check('parser ignores a header when real entries follow', withHeader.models.length === 1, String(withHeader.models.length));
}

// =========================================================================
section('pure status decision (catalogSnapshotFromRun): fail-closed ordering');

{
  const src = 'opencode models';
  const at = 1;
  // An UNCONFIRMED tree stop is a failure even with exit 0 and valid output.
  const unconfirmed = catalogSnapshotFromRun({ stdout: MODELS_FIXTURE, stderr: '', code: 0, treeStopConfirmed: false }, 'opencode', src, at);
  check('unconfirmed tree stop => failed (never a collected catalogue)',
    unconfirmed.status === 'failed' && unconfirmed.models.length === 0, unconfirmed.status);
  check('unconfirmed tree stop note explains the refusal', /NOT confirmed/.test(unconfirmed.note), unconfirmed.note);

  const ok = catalogSnapshotFromRun({ stdout: MODELS_FIXTURE, stderr: '', code: 0, treeStopConfirmed: true }, 'opencode', src, at);
  check('confirmed + exit 0 + models => ok', ok.status === 'ok' && ok.models.length === 4, ok.status);

  const empty = catalogSnapshotFromRun({ stdout: '', stderr: '', code: 0, treeStopConfirmed: true }, 'opencode', src, at);
  check('confirmed + exit 0 + no output => empty (not failed)', empty.status === 'empty', empty.status);

  const nonzero = catalogSnapshotFromRun({ stdout: 'opencode/gpt-5.1-codex\n', stderr: 'boom', code: 1, treeStopConfirmed: true }, 'opencode', src, at);
  check('confirmed + non-zero exit => failed, partial stdout discarded', nonzero.status === 'failed' && nonzero.models.length === 0, nonzero.status);

  const timedOut = catalogSnapshotFromRun({ stdout: 'opencode/gpt-5.1-codex\n', stderr: '', code: null, treeStopConfirmed: true }, 'opencode', src, at);
  check('confirmed + null exit (timeout/killed) => failed, partial stdout discarded',
    timedOut.status === 'failed' && /timeout|killed/.test(timedOut.note), timedOut.note);

  const garbage = catalogSnapshotFromRun({ stdout: 'anthropic/claude-sonnet-4-5  $3/$15 per 1M\n', stderr: '', code: 0, treeStopConfirmed: true }, 'opencode', src, at);
  check('confirmed + exit 0 + unparseable output => failed', garbage.status === 'failed', garbage.status);
}

// =========================================================================
section('collect: each state is distinct and honest (injected runner, hermetic)');

{
  const now = (): number => 1_700_000_000_000;

  const ok = scriptedRunner({ stdout: MODELS_FIXTURE, stderr: '', code: 0 });
  const okSnap = await collectModelCatalog('opencode', { runner: ok.runner, command: CONTROLLED_CMD, now, timeoutMs: 1234 });
  check('ok: status is ok with the listed models', okSnap.status === 'ok' && okSnap.models.length === 4, okSnap.status);
  check('ok: full modelId + provider + agentId preserved',
    okSnap.models[0]!.modelId === 'anthropic/claude-sonnet-4-5' &&
      okSnap.models[0]!.provider === 'anthropic' && okSnap.models[0]!.agentId === 'opencode');
  check('ok: source names the exact command', okSnap.source.endsWith(' models'), okSnap.source);
  check('ok: listedAt comes from the clock seam', okSnap.listedAt === now());
  check('ok: runner received the catalogue argv + timeout',
    ok.calls.length === 1 && ok.calls[0]!.args.includes('models') && ok.calls[0]!.timeoutMs === 1234, JSON.stringify(ok.calls[0]));

  const empty = scriptedRunner({ stdout: '', stderr: '', code: 0 });
  const emptySnap = await collectModelCatalog('opencode', { runner: empty.runner, command: CONTROLLED_CMD, now });
  check('empty: status is empty, distinct from failed', emptySnap.status === 'empty' && emptySnap.models.length === 0, emptySnap.status);

  const nonzero = scriptedRunner({ stdout: 'opencode/gpt-5.1-codex\n', stderr: 'boom', code: 1 });
  const nonzeroSnap = await collectModelCatalog('opencode', { runner: nonzero.runner, command: CONTROLLED_CMD, now });
  check('failed: non-zero exit cannot be a catalogue success', nonzeroSnap.status === 'failed' && nonzeroSnap.models.length === 0, nonzeroSnap.status);
  check('failed: the non-zero reason is carried', /exited 1/.test(nonzeroSnap.note), nonzeroSnap.note);

  const timeout = scriptedRunner({ stdout: 'opencode/gpt-5.1-codex\n', stderr: '', code: null });
  const timeoutSnap = await collectModelCatalog('opencode', { runner: timeout.runner, command: CONTROLLED_CMD, now });
  check('failed: an injected null exit maps to failed (mapping only, not the real timeout proof)',
    timeoutSnap.status === 'failed' && /timeout|killed/.test(timeoutSnap.note), timeoutSnap.note);

  const garbage = scriptedRunner({ stdout: 'anthropic/claude-sonnet-4-5  $3/$15 per 1M\n', stderr: '', code: 0 });
  const garbageSnap = await collectModelCatalog('opencode', { runner: garbage.runner, command: CONTROLLED_CMD, now });
  check('failed: exit-0 unparseable output is failed, never empty/ok', garbageSnap.status === 'failed', garbageSnap.status);

  const unsupported = scriptedRunner({ stdout: MODELS_FIXTURE, stderr: '', code: 0 });
  const unsupportedSnap = await collectModelCatalog('codex', { runner: unsupported.runner, command: CONTROLLED_CMD, now });
  check('unsupported: a non-OpenCode agent is labelled unsupported', unsupportedSnap.status === 'unsupported', unsupportedSnap.status);
  check('unsupported: no process is started for it', unsupported.calls.length === 0, String(unsupported.calls.length));

  const off = scriptedRunner({ stdout: MODELS_FIXTURE, stderr: '', code: 0 });
  const offSnap = await collectModelCatalog('opencode', { runner: off.runner, enabled: false, now });
  check('not_collected: disabled collection runs the runner zero times', offSnap.status === 'not_collected' && off.calls.length === 0,
    `${offSnap.status}/${off.calls.length}`);

  check('the status set is the five required distinctions',
    [...CATALOG_STATUSES].sort().join(',') === ['ok', 'empty', 'unsupported', 'failed', 'not_collected'].sort().join(','),
    CATALOG_STATUSES.join(','));
  check('only opencode is a supported catalogue agent',
    CATALOG_SUPPORTED_AGENTS.length === 1 && CATALOG_SUPPORTED_AGENTS[0] === 'opencode' && isCatalogSupported('opencode') && !isCatalogSupported('codex'));
  check('notCollectedCatalog is a pure not_collected snapshot', notCollectedCatalog('opencode').status === 'not_collected');
}

// =========================================================================
section('discovery: a real resolution failure is an independent `failed`');

{
  // An EXPLICIT, non-existent absolute command forces a genuine resolveCommand
  // failure without depending on OpenCode being installed (or not).
  const bogus = join(tmpdir(), 'mc-definitely-not-here', 'opencode.exe');
  const { runner } = scriptedRunner({ stdout: MODELS_FIXTURE, stderr: '', code: 0 });
  const snap = await collectModelCatalog('opencode', { command: bogus, runner, now: () => 1 });
  check('a launcher that cannot be resolved => failed', snap.status === 'failed', snap.status);
  check('the resolution failure is explained', /could not resolve/.test(snap.note), snap.note);
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
  const snap: ModelCatalogSnapshot = await collectModelCatalog('opencode', { runner, command: CONTROLLED_CMD, now: () => 2 });

  check('registry facts are byte-identical before and after a catalogue query', before === JSON.stringify(reg.list()));
  check('a freshly listed model is NOT present in the registry', !reg.list().some((e) => e.modelId === 'anthropic/claude-sonnet-4-5'));
  check('the snapshot is the only place the listed models appear', snap.models.length === 4);
}

// =========================================================================
section('doctor: default runs ZERO catalogue queries; --models is explicit (hermetic)');

{
  const storeDir = ownDir();
  // Replace EVERY known adapter with a fake, and point the opencode config command at
  // a controlled path, so doctor never probes or discovers a real binary.
  const fakes = knownAgentIds().map((id) => createFakeAdapter({ id }));
  const orch = new Orchestrator({
    config: { agents: { opencode: { command: CONTROLLED_CMD } } },
    storeDir,
    replaceAdapters: fakes,
  });

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
  check('opt-in doctor: the snapshot preserves full model identity', d2.modelCatalog?.models[0]?.modelId === 'anthropic/claude-sonnet-4-5');
  check('opt-in doctor: the agent report itself is unchanged by the catalogue',
    d1.agents.length === d2.agents.length && d1.agents.every((a, i) => a.id === d2.agents[i]!.id));

  const d3 = await orch.doctor();
  check('default doctor again: still zero additional catalogue calls', d3.modelCatalog === undefined && calls.length === 1, String(calls.length));

  const d4 = await orch.doctor({ modelCatalog: { agentId: 'codex', runner } });
  check('opt-in for a non-OpenCode agent is unsupported and starts nothing new', d4.modelCatalog?.status === 'unsupported' && calls.length === 1,
    `${d4.modelCatalog?.status}/${calls.length}`);
}

// =========================================================================
section('B1.1a containment: the DEFAULT path really contains and confirms the tree');

async function containmentRegressions(): Promise<void> {
  const launcher = resolveContainmentLauncher();
  if (!containmentEnabled() || launcher === null) {
    // A missing containment capability is NOT a silent pass.
    check('containment launcher is available for the catalogue regression', false,
      'ENVIRONMENT_BLOCKED: no sealed Job launcher; build native/windows-job-launcher');
    return;
  }

  const dir = ownDir();
  const observers: Observer[] = [];
  try {
    // --- normal: a controlled command that prints models and exits 0 -------------
    const normalCjs = join(dir, 'normal.cjs');
    writeFileSync(normalCjs, "process.stdout.write('opencode/gpt-5.1-codex\\nanthropic/claude-sonnet-4-5\\n'); process.exit(0);\n");
    const normalCmd = join(dir, 'normal.cmd');
    writeFileSync(normalCmd, `@echo off\r\n"${process.execPath}" "${normalCjs}"\r\n`);

    const okSnap = await collectModelCatalog('opencode', { command: normalCmd, timeoutMs: 20_000 });
    check('contained default: a normal exit 0 collects stdout as a catalogue', okSnap.status === 'ok', `${okSnap.status} ${okSnap.note}`);
    check('contained default: the parsed models survive', okSnap.models.length === 2 && okSnap.models[0]!.modelId === 'opencode/gpt-5.1-codex',
      JSON.stringify(okSnap.models.map((m) => m.modelId)));

    // --- leak: a controlled command whose ROOT exits but leaves a live DESCENDANT -
    // The exact P1 shape: the root is gone while a descendant stays alive. Pure node
    // (same volume as the temp dir), so no cross-volume write limitation is involved.
    const childCjs = join(dir, 'child.cjs');
    writeFileSync(childCjs, [
      "const fs=require('fs'),path=require('path');",
      "fs.writeFileSync(path.join(__dirname,'child.pid'), String(process.pid));",
      'setInterval(()=>{},1000);',
    ].join('\n'));
    const leakCjs = join(dir, 'leak.cjs');
    writeFileSync(leakCjs, [
      "const {spawn}=require('child_process'),fs=require('fs'),path=require('path');",
      "fs.writeFileSync(path.join(__dirname,'root.pid'), String(process.pid));",
      // detached:true gives the descendant its own process GROUP so it outlives the
      // root; it does NOT break out of the Job (that would need BREAKAWAY, which the
      // launcher forbids), so the descendant is still a contained Job member.
      "const c=spawn(process.execPath,[path.join(__dirname,'child.cjs')],{stdio:'ignore',detached:true});",
      'c.unref();',
      'process.exit(0);',
    ].join('\n'));
    const leakCmd = join(dir, 'leak.cmd');
    writeFileSync(leakCmd, `@echo off\r\n"${process.execPath}" "${leakCjs}"\r\n`);

    // Start the catalogue through the REAL default path (NO injected runner), and
    // concurrently hold the descendant's ORIGINAL handle so its exit is proven.
    const pending = collectModelCatalog('opencode', { command: leakCmd, timeoutMs: 3_000 });

    let cpid = 0;
    for (let i = 0; i < 120 && cpid === 0; i++) {
      await sleep(50);
      cpid = readNum(join(dir, 'child.pid'));
    }
    const obs = cpid !== 0 ? openObserver(cpid) : null;
    const acquired = obs !== null ? await obs.acquired() : false;
    if (obs !== null) observers.push(obs);

    const leakSnap = await pending;
    check('contained default: a real timeout with a live descendant => failed', leakSnap.status === 'failed', `${leakSnap.status} ${leakSnap.note}`);
    check('contained default: timeout partial output is discarded (no models)', leakSnap.models.length === 0, String(leakSnap.models.length));
    check('contained default: the descendant was observable while the root was gone', acquired, `childPid=${cpid}`);

    // The descendant MUST be physically dead after the confirmed contained stop.
    const v = obs !== null ? await obs.verdict(12_000) : { state: 'OBSERVATION_ERROR' as const, why: 'no observer' };
    check('contained default: the descendant is EXITED after the contained stop (held handle)',
      v.state === 'EXITED', `verdict=${v.state}${v.state === 'OBSERVATION_ERROR' ? ` (${v.why})` : ''}`);

    // Belt-and-braces: a fresh observation of the same pid is not ALIVE.
    const fresh = await livenessNative(cpid, 700);
    check('contained default: no live descendant remains (fresh observation)', fresh.state !== 'ALIVE', `verdict=${fresh.state}`);
  } finally {
    // Owned cleanup: observers first (they hold handles), then the temp dir.
    for (const o of observers) {
      const gone = await o.reaped(5_000);
      if (!gone) failures.push(`observer for pid ${o.pid} did not exit`);
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

await containmentRegressions();

// =========================================================================
section('architecture: no new authority, no execution edge, no bare kill');

{
  const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const mc = strip(sourceText('src/runtime/model-catalog.ts'));

  check('model-catalog.ts never writes the Model Registry',
    !/ModelRegistry|setModelAvailability|setAgentAvailability|\.upsert\(/.test(mc));
  check('model-catalog.ts never touches assignment or the spawn gate',
    !/assignWorker|evaluateSpawnGate|spawn-gate|assignment\.ts/.test(mc));
  check('model-catalog.ts never calls runtime.run', !/runtime\s*\.\s*run\s*\(/.test(mc) && !/\.run\s*\(/.test(mc));
  check('model-catalog.ts never uses a shell', !/shell\s*:\s*true/.test(mc));
  // The DEFAULT execution reuses the production containment path, not the quota runner.
  check('model-catalog.ts runs the default command through ManagedProcess', /new ManagedProcess\(/.test(mc));
  check('model-catalog.ts does NOT import/reuse execRunner for execution', !/execRunner/.test(mc));
  check('model-catalog.ts uses no bare kill / taskkill', !/taskkill|process\.kill/.test(mc));

  const files: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
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
  check('...and it is the orchestration Orchestrator', sites.length === 1 && sites[0]!.endsWith('orchestration/orchestrator.ts'), JSON.stringify(sites));
}

// =========================================================================

for (const d of tmpDirs) {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) process.stdout.write(`failing:\n  ${failures.map((f) => `- ${f}`).join('\n  ')}\n`);
process.stdout.write('\n');
process.exitCode = failed === 0 ? 0 : 1;
