/**
 * tests/b12-opencode-model-catalog.test.ts — B1.2 opt-in REAL OpenCode catalogue.
 *
 * ============================================================================
 * WHAT THIS PROVES (and what it does NOT)
 * ============================================================================
 * When explicitly opted in, this runs the REAL installed OpenCode CLI through the
 * PRODUCTION catalogue path and records what its native `models` command returns:
 *
 *   Orchestrator.doctor({ modelCatalog: { agentId: 'opencode' } })
 *     -> collectModelCatalog
 *     -> contained ManagedProcess (sealed Job launcher)
 *     -> the installed `opencode` binary
 *     -> `opencode models`
 *     -> a read-only snapshot
 *
 * It proves only that THIS version/environment can LIST its catalogue. It does NOT
 * prove that any model is connected, callable, free, or fit for a role — the frozen
 * boundary is `listed != connected != callable != free`. Nothing here writes the
 * Model Registry, availability, assignment, quota, budget, cost authorization or
 * user selection, and the default `doctor` still never queries a catalogue.
 *
 * ============================================================================
 * OPT-IN ONLY
 * ============================================================================
 * It runs ONLY when `ORCH_B12_REAL_CATALOG=1`. Without it the suite prints NOT_RUN
 * and starts no agent, resolves nothing and creates no owned context. It is
 * deliberately NOT in the default `npm test` list.
 *
 * ============================================================================
 * ISOLATION BOUNDARY
 * ============================================================================
 * Only the REAL OpenCode may start. Every OTHER registered agent is replaced with a
 * hermetic fake via the existing `replaceAdapters` seam, so doctor never probes a
 * real Codex / WorkBuddy / Cline. This is a TEST boundary: it does not claim that a
 * whole `doctor` CLI run with every real agent was verified.
 *
 * All containment artifacts live under this run's OWNED root (via the owned launcher
 * copy + ORCH_JOB_LAUNCHER). The shared production control directory is never read
 * or deleted, no process is stopped by PID/name scan, and the user's existing
 * OpenCode desktop sessions/services are never touched.
 *
 * Run: ORCH_B12_REAL_CATALOG=1 node tests/b12-opencode-model-catalog.test.ts
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { knownAgentIds } from '../src/adapters/index.ts';
import { createFakeAdapter } from './helpers.ts';
import { setupOwnedTestContext, finish, type OwnedTestContext } from './helpers/real-agent-isolation.ts';
import { readControlRecord, treeStopConfirmedFrom } from '../src/runtime/containment.ts';

const OPT_IN = process.env.ORCH_B12_REAL_CATALOG === '1';

const results: Array<{ verdict: string }> = [];
function record(verdict: 'PASS' | 'FAIL' | 'SKIP', name: string, detail = ''): void {
  results.push({ verdict });
  console.log(`  ${verdict} ${name}${detail ? ` - ${detail}` : ''}`);
}

/** Redact the local user profile prefix so no account path is printed verbatim. */
function redact(p: string): string {
  let s = p;
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['APPDATA', '%APPDATA%'],
    ['LOCALAPPDATA', '%LOCALAPPDATA%'],
    ['USERPROFILE', '%USERPROFILE%'],
  ];
  for (const [env, token] of pairs) {
    const v = process.env[env];
    if (v !== undefined && v !== '') s = s.split(v).join(token);
  }
  return s;
}

/**
 * Validate THIS run's OWNED control records with the PRODUCTION validator.
 *
 * Raw key/value fields are diagnostics only; `treeStopConfirmedFrom` is the one
 * function allowed to certify a confirmed tree stop, and it only ever reads records
 * under the owned control directory.
 */
function ownedTreeStopConfirmed(ctx: OwnedTestContext): { confirmed: boolean; statuses: string[] } {
  const statuses: string[] = [];
  let confirmed = false;
  let names: string[] = [];
  try {
    names = readdirSync(ctx.controlDir).filter((n) => n.endsWith('.txt'));
  } catch {
    return { confirmed: false, statuses };
  }
  for (const n of names) {
    const v = readControlRecord(join(ctx.controlDir, n));
    if (v.ok) {
      statuses.push(v.record.launcherStatus);
      if (treeStopConfirmedFrom(v.record)) confirmed = true;
    } else {
      statuses.push(`<invalid:${v.reason}>`);
    }
  }
  return { confirmed, statuses };
}

async function main(): Promise<void> {
  console.log('== B1.2 real OpenCode model catalogue ==');

  if (!OPT_IN) {
    console.log('  NOT_RUN (opt-in required: set ORCH_B12_REAL_CATALOG=1)');
    console.log('  no discovery, no agent start, no owned context created.');
    process.exitCode = finish(results, { allowEnvironmentBlocked: true });
    return;
  }

  const owned = setupOwnedTestContext();
  if (owned === null) {
    record('SKIP', 'production containment launcher available', 'ENVIRONMENT_BLOCKED: no sealed Job launcher on this machine');
    process.exitCode = finish(results, { allowEnvironmentBlocked: true });
    return;
  }

  let cleanupFailures: Awaited<ReturnType<OwnedTestContext['cleanup']>> = [];
  try {
    // Only the REAL OpenCode is allowed to start; every other known agent is faked.
    const replaced = knownAgentIds().filter((id) => id !== 'opencode');
    const fakes = replaced.map((id) => createFakeAdapter({ id }));
    console.log(`  info non-OpenCode agents replaced with fakes for probe: ${replaced.join(', ')}`);

    const orch = new Orchestrator({
      config: { agents: {} },
      storeDir: owned.dir('store'),
      replaceAdapters: fakes,
    });

    const t0 = Date.now();
    const report = await orch.doctor({ modelCatalog: { agentId: 'opencode' } });
    const elapsedMs = Date.now() - t0;

    const oc = report.agents.find((a) => a.id === 'opencode');
    if (oc === undefined) {
      record('SKIP', 'real OpenCode discovered', 'ENVIRONMENT_BLOCKED: opencode not registered/discovered on this machine');
    } else {
      const kind = /\[(native|cmd-wrapper)\]$/.exec(oc.launcher)?.[1] ?? 'unknown';
      console.log(`  info opencode version=${oc.version ?? 'unknown'} probeOk=${oc.ok} launcherKind=${kind}`);
      console.log(`  info launcher=${redact(oc.launcher)}`);
      console.log(`  info elapsedMs=${elapsedMs}`);

      const snap = report.modelCatalog;
      if (snap === undefined) {
        record('FAIL', 'catalogue snapshot present');
      } else {
        console.log(`  info snapshot status=${snap.status} source=${redact(snap.source)} models=${snap.models.length}`);
        if (snap.note) console.log(`  info note=${snap.note}`);

        // `empty` is a genuine real result (a catalogue may legitimately be empty);
        // only `failed` is a compatibility failure.
        record(snap.status === 'ok' || snap.status === 'empty' ? 'PASS' : 'FAIL',
          'real catalogue query completed (ok, or a genuine empty list)', `status=${snap.status}`);

        if (snap.status === 'ok') {
          // Full provider/model identity must survive: provider is the first segment.
          const bad = snap.models.filter(
            (m) => !/^[^/\s]+\/.+$/.test(m.modelId) || m.provider !== m.modelId.slice(0, m.modelId.indexOf('/')),
          );
          record(bad.length === 0 ? 'PASS' : 'FAIL', 'every listed model keeps its full provider/model identity', `bad=${bad.length}`);
          console.log(`  info samples: ${snap.models.slice(0, 3).map((m) => m.modelId).join(', ')}`);
        } else if (snap.status === 'empty') {
          console.log('  info the CLI genuinely listed no models (allowed real result)');
        }
      }

      // Containment evidence: THIS run's owned control record, production-validated.
      const { confirmed, statuses } = ownedTreeStopConfirmed(owned);
      console.log(`  info owned control statuses: ${statuses.join(', ') || '(none)'}`);
      record(confirmed ? 'PASS' : 'FAIL', 'owned control record confirms the process tree stopped (production validation)',
        `statuses=${statuses.join(',')}`);
    }
  } catch (e) {
    record('FAIL', 'unexpected throw during the real catalogue run', String((e as Error).message));
  } finally {
    cleanupFailures = await owned.cleanup();
    for (const f of cleanupFailures) console.log(`  info cleanup failure: ${f.resource}: ${f.error}`);
  }

  const anyFail = results.some((r) => r.verdict === 'FAIL');
  process.exitCode = finish(results, { allowEnvironmentBlocked: true, cleanupFailures });
  console.log(`\nB1.2 real catalogue: ${anyFail || cleanupFailures.length > 0 ? 'FAIL' : 'PASS'} (assertions=${results.length})`);
}

await main();
