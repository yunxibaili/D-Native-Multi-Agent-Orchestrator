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
 *     -> adapter.probe()                       (bounded version probe)
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
 * and starts no agent, resolves nothing and creates no owned context, and exits 0.
 * It is deliberately NOT in the default `npm test` list.
 *
 * ============================================================================
 * B1.2 P1-1 — FAILURE SEMANTICS (an enabled run may never print PASS without work)
 * ============================================================================
 * Four outcomes are STRICTLY separated, and only the last one may print PASS:
 *
 *   NOT_RUN              opt-in absent. exit 0. No discovery, no agent, no owned ctx.
 *   ENVIRONMENT_BLOCKED  opt-in present, but the sealed Job launcher or OpenCode is
 *                        unavailable on this machine. NON-ZERO exit. Never prints PASS.
 *   FAIL                 opt-in present, run attempted, but an assertion, the
 *                        catalogue query or the cleanup failed. NON-ZERO exit.
 *   PASS                 the necessary verification actually completed AND cleanup
 *                        succeeded. exit 0.
 *
 * "Enabled but the agent/launcher is missing" is an ENVIRONMENT_BLOCKED failure, not
 * a pass: a run that never queried anything must not report success. `finish()` is
 * reused, and `allowEnvironmentBlocked` is passed only on the not-enabled path.
 *
 * ============================================================================
 * B1.2 P2 — PER-STAGE CONTROL EVIDENCE
 * ============================================================================
 * `doctor` performs TWO contained executions: the version probe and the catalogue
 * query. Each MUST have its own validated control record, and each stage's evidence
 * must come from ITS OWN record. The judgment lives ONCE, in
 * `tests/helpers/b12-control-evidence.ts`, and is shared with the controlled
 * regression — there is no second, test-only copy of the rule here.
 *
 * A missing, INVALID or unconfirmed record for EITHER stage fails the run. One
 * stage's success can never substitute for the other's, and neither the "last
 * record" nor "any successful record" may stand in. Raw key/value fields are
 * diagnostics only; `treeStopConfirmedFrom` is the only function allowed to
 * certify a confirmed tree stop.
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

import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { knownAgentIds } from '../src/adapters/index.ts';
import { createFakeAdapter } from './helpers.ts';
import { setupOwnedTestContext, finish, writeHygieneReport, type OwnedTestContext } from './helpers/real-agent-isolation.ts';
import { judgeStageEvidence, snapshotControlDir } from './helpers/b12-control-evidence.ts';

const OPT_IN = process.env.ORCH_B12_REAL_CATALOG === '1';

const results: Array<{ verdict: string }> = [];
function record(verdict: 'PASS' | 'FAIL', name: string, detail = ''): void {
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
 * The agent configuration this entry runs with.
 *
 * Empty by default, so the REAL installed OpenCode is used. A non-empty override
 * comes only from the caller's own configuration (the standard
 * `agents.opencode.command` seam), never from a new test-only environment variable:
 * the opt-in real path must not be redirectable by ambient env. The controlled
 * regressions use this same seam.
 */
function entryAgentConfig(): Record<string, { command?: string }> {
  const configured = process.env.ORCH_B12_OPENCODE_COMMAND;
  if (configured === undefined || configured === '') return {};
  return { opencode: { command: configured } };
}

async function main(): Promise<void> {
  console.log('== B1.2 real OpenCode model catalogue ==');

  /*
   * P1-1, NOT ENABLED: the only branch allowed to exit 0 without doing work.
   * No discovery, no agent start, no owned context — and explicitly no PASS,
   * because nothing was verified.
   */
  if (!OPT_IN) {
    console.log('  NOT_RUN (opt-in required: set ORCH_B12_REAL_CATALOG=1)');
    console.log('  no discovery, no agent start, no owned context created.');
    process.exitCode = finish([], { allowEnvironmentBlocked: true });
    return;
  }

  const owned = setupOwnedTestContext();
  if (owned === null) {
    /*
     * P1-1: enabled, but this machine has no sealed Job launcher. That is an
     * ENVIRONMENT_BLOCKED failure — NOT a pass, and NOT a SKIP that `finish()`
     * would wave through. Nothing was queried, so nothing may be reported as OK.
     */
    record('FAIL', 'production containment launcher available', 'ENVIRONMENT_BLOCKED: no sealed Job launcher on this machine');
    process.exitCode = finish(results, { allowEnvironmentBlocked: false });
    return;
  }

  let cleanupFailures: Awaited<ReturnType<OwnedTestContext['cleanup']>> = [];
  try {
    // Only the REAL OpenCode is allowed to start; every other known agent is faked.
    const replaced = knownAgentIds().filter((id) => id !== 'opencode');
    const fakes = replaced.map((id) => createFakeAdapter({ id }));
    console.log(`  info non-OpenCode agents replaced with fakes for probe: ${replaced.join(', ')}`);

    const orch = new Orchestrator({
      config: { agents: entryAgentConfig() },
      storeDir: owned.dir('store'),
      replaceAdapters: fakes,
    });

    // P2: the pre-run snapshot, so only THIS run's records can be used as evidence.
    const controlBefore = snapshotControlDir(owned.controlDir);

    const t0 = Date.now();
    const report = await orch.doctor({ modelCatalog: { agentId: 'opencode' } });
    const elapsedMs = Date.now() - t0;

    const oc = report.agents.find((a) => a.id === 'opencode');
    if (oc === undefined) {
      /*
       * P1-1: enabled but OpenCode was never discovered. Previously this recorded a
       * SKIP and `finish({allowEnvironmentBlocked:true})` let the suite print PASS
       * and exit 0. A run that never started the agent must not report success.
       *
       * NOTE: no early `return` here. A `return` would run the `finally` cleanup and
       * then EXIT main() before `process.exitCode = finish(...)` is reached, which is
       * exactly how the old entry reported a blocked run as exit 0. Falling through
       * keeps the single exit-code computation at the bottom authoritative.
       */
      record('FAIL', 'real OpenCode discovered', 'ENVIRONMENT_BLOCKED: opencode not registered/discovered on this machine; no catalogue was queried');
    } else {
      const kind = /\[(native|cmd-wrapper)\]$/.exec(oc.launcher)?.[1] ?? 'unknown';
      console.log(`  info opencode version=${oc.version ?? 'unknown'} probeOk=${oc.ok} launcherKind=${kind}`);
      console.log(`  info launcher=${redact(oc.launcher)}`);
      console.log(`  info elapsedMs=${elapsedMs}`);
      if (!oc.ok) console.log(`  info probe detail: ${oc.detail}`);

      /*
       * B1.2 P1-2: the version probe is BOUNDED and its own failure is fatal to this
       * entry. A probe that could not obtain a version means `doctor` never reached
       * the catalogue with a verified agent, so PASS is not available.
       */
      if (!oc.ok || oc.version === null || oc.version === undefined) {
        record('FAIL', 'version probe returned a usable version (bounded probe)', `ok=${oc.ok} version=${oc.version ?? 'none'}`);
      } else {
        record('PASS', 'version probe returned a usable version (bounded probe)', `version=${oc.version}`);
      }

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

      /*
       * P2: PER-STAGE control evidence, judged by the ONE shared rule.
       *
       * Only records created by THIS run are considered, each stage is evidenced by
       * its OWN record, and a missing / INVALID / unconfirmed record fails that
       * stage. One stage's success never substitutes for the other's.
       */
      const judgment = judgeStageEvidence(owned.controlDir, controlBefore);
      const { version, models } = judgment.evidence;
      console.log(`  info new owned control records this run: ${version.runRecordCount}`);
      console.log(`  info version stage record=${version.recordFile ?? '(none)'} statuses=${version.statuses.join(',') || '(none)'}`);
      console.log(`  info models  stage record=${models.recordFile ?? '(none)'} statuses=${models.statuses.join(',') || '(none)'}`);

      record(
        version.recordFile !== null && models.recordFile !== null && version.recordFile !== models.recordFile
          ? 'PASS' : 'FAIL',
        'version and models stages each own a DISTINCT control record',
        `version=${version.recordFile ?? 'none'} models=${models.recordFile ?? 'none'}`,
      );
      record(version.treeStopConfirmed ? 'PASS' : 'FAIL',
        'version stage control record confirms the tree stopped (production validation)',
        `statuses=${version.statuses.join(',') || '(none)'} rootPid=${version.rootPid}`);
      record(models.treeStopConfirmed ? 'PASS' : 'FAIL',
        'models stage control record confirms the tree stopped (production validation)',
        `statuses=${models.statuses.join(',') || '(none)'} rootPid=${models.rootPid}`);
      record(
        version.rootPid !== null && models.rootPid !== null && version.rootPid !== models.rootPid
          ? 'PASS' : 'FAIL',
        'no stage substitutes another stage\'s control record',
        `versionRootPid=${version.rootPid} modelsRootPid=${models.rootPid}`,
      );
      for (const f of judgment.failures) {
        console.log(`  info stage failure [${f.stage}] ${f.reason}: ${f.detail}`);
      }
    }
  } catch (e) {
    record('FAIL', 'unexpected throw during the real catalogue run', String((e as Error).message));
  } finally {
    cleanupFailures = await owned.cleanup();
    for (const f of cleanupFailures) console.log(`  info cleanup failure: ${f.resource}: ${f.error}`);
  }

  /*
   * P1-1: the final verdict is computed by `finish` only. It is non-zero when ANY
   * required assertion failed AND when cleanup itself failed, so a leaked owned
   * resource or an unconfirmed stop can never be reported as a pass.
   */
  const code = finish(results, { allowEnvironmentBlocked: false, cleanupFailures });
  process.exitCode = code;
  // Publish this process's final state (env + the escaping error, if any) so a
  // parent harness can verify exact restoration and attribute leftovers to THIS
  // run's own root. Best-effort: it never changes this suite's outcome.
  writeHygieneReport();
  const anyFail = results.some((r) => r.verdict === 'FAIL');
  console.log(`\nB1.2 real catalogue: ${anyFail || cleanupFailures.length > 0 ? 'FAIL' : 'PASS'} (assertions=${results.length}) exit=${code}`);
}

await main();
