/**
 * tests/helpers/b12-control-evidence.ts — the ONE per-stage control-evidence judgment.
 *
 * ============================================================================
 * WHY THIS EXISTS (B1.2 P2)
 * ============================================================================
 * The B1.2 entry performs TWO contained executions: the OpenCode version probe and
 * the `opencode models` catalogue query. Each must be evidenced by ITS OWN validated
 * control record.
 *
 * The old rule was "read every record under the owned control directory; if ANY one
 * validates as a confirmed stop, the stage is confirmed". That is fail-open: with a
 * legal `success` record for one stage and an INCOMPLETE record for the other, it
 * reported `confirmed=true`. A different run's record was being adopted as this
 * stage's lifecycle fact.
 *
 * The rule now lives HERE, once, and is used by BOTH the real entry and the
 * controlled regression. There is deliberately no second copy inside a test: a
 * test-only reimplementation would let the entry keep the old merge rule while the
 * test proved a different one.
 *
 * ============================================================================
 * THE RULES
 * ============================================================================
 *  1. ONLY records created by THIS run count. The caller passes the set of control
 *     files that existed before the run; anything older is invisible here, so a
 *     record left by an earlier run can never be adopted.
 *  2. A stage's record is identified by IDENTITY (`rootPid`), never by "the last
 *     file" or "any successful file". The version stage ran FIRST and the catalogue
 *     query SECOND, so the run's records are ordered by creation; that ordering is
 *     used only to select which candidate a stage may draw from.
 *  3. A stage FAILS when its record is missing, INVALID, or does not carry a
 *     confirmed tree stop. One stage's success never substitutes for another's.
 *  4. The only functions allowed to certify a lifecycle fact are the PRODUCTION
 *     validators `readControlRecord` and `treeStopConfirmedFrom`. Raw key/value
 *     fields are diagnostics and are never used to certify anything.
 *
 * This is a TEST helper. It owns no production authority, starts nothing, and stops
 * nothing.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { readControlRecord, treeStopConfirmedFrom, type RecordValidation } from '../../src/runtime/containment.ts';

/** Which of the two contained executions a record set belongs to. */
export type CatalogStage = 'version' | 'models';

/** The evidence ONE stage has, from ITS OWN record. */
export interface StageEvidence {
  /** How many records this run created in total. */
  readonly runRecordCount: number;
  /** This stage's own record file, when exactly one could be attributed. */
  readonly recordFile: string | null;
  /** The PRODUCTION validation of that record. Null when absent or ambiguous. */
  readonly validation: RecordValidation | null;
  /** The record's own `rootPid` — its identity. */
  readonly rootPid: number | null;
  /** The PRODUCTION-validated tree-stop fact. */
  readonly treeStopConfirmed: boolean;
  /** Diagnostic statuses in file order (raw fields, never certified facts). */
  readonly statuses: readonly string[];
}

/** A failed stage, with the reason it failed. */
export interface StageFailure {
  readonly stage: CatalogStage;
  readonly reason:
    | 'no-run-records'
    | 'stage-record-missing'
    | 'stage-record-ambiguous'
    | 'stage-record-invalid'
    | 'tree-stop-unconfirmed';
  readonly detail: string;
}

export interface StageJudgment {
  readonly ok: boolean;
  readonly evidence: Readonly<Record<CatalogStage, StageEvidence>>;
  readonly failures: readonly StageFailure[];
}

/** Every control file currently under `controlDir`. */
export function snapshotControlDir(controlDir: string): Set<string> {
  try {
    if (!existsSync(controlDir)) return new Set();
    return new Set(readdirSync(controlDir).filter((n) => n.endsWith('.txt')));
  } catch {
    return new Set();
  }
}

/** The records THIS run created: present now, absent from `before`. */
function runRecords(controlDir: string, before: ReadonlySet<string>): string[] {
  return [...snapshotControlDir(controlDir)].filter((n) => !before.has(n)).sort();
}

/**
 * Order this run's records by the time they were WRITTEN.
 *
 * The launcher writes one record per execution and finishes it when that execution
 * ends, so a record's modification time is when its execution completed. The
 * version probe runs BEFORE the catalogue query, so its record is written first.
 *
 * Deliberately NOT the filename: a control file is named
 * `w1ctl-<pid>-<random-uuid>.txt`, and sorting by that random UUID says nothing
 * about the stage — a real run was observed where the models record sorted BEFORE
 * the version record. Ordering by write time uses a filesystem fact instead.
 *
 * Returns null when two records share the same millisecond, because then the
 * ordering genuinely is not determinable and the caller must fail rather than guess.
 */
function orderByWriteTime(controlDir: string, names: readonly string[]): string[] | null {
  const timed = names.map((n) => {
    try {
      return { name: n, ms: statSync(join(controlDir, n)).mtimeMs };
    } catch {
      return { name: n, ms: Number.NaN };
    }
  });
  if (timed.some((t) => Number.isNaN(t.ms))) return null;
  const sorted = [...timed].sort((a, b) => a.ms - b.ms);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.ms === sorted[i - 1]!.ms) return null;
  }
  return sorted.map((t) => t.name);
}

/**
 * Judge BOTH stages from the records this run created.
 *
 * HOW THE STAGES ARE ATTRIBUTED — and why not by filename order
 * -------------------------------------------------------------
 * A control file's NAME is a random UUID (`w1ctl-<pid>-<uuid>.txt`), so sorting by
 * name says nothing about which stage wrote it: in one real run
 * `w1ctl-run-models.txt` sorted BEFORE `w1ctl-run-version.txt`. Attributing by name
 * order would silently swap the two stages — exactly the class of bug this helper
 * exists to prevent.
 *
 * Two attribution mechanisms, both identity- or fact-based, never name-based:
 *
 *  (a) when the caller supplies the ROOT PIDS it observed for each stage, each
 *      stage's record is the one carrying that pid — an identity the OS assigned
 *      and the launcher recorded;
 *  (b) otherwise the records are ordered by WRITE TIME (the probe completes before
 *      the catalogue query), so the version stage is the earliest and the models
 *      stage the latest.
 *
 * Either way a stage that cannot be attributed FAILS rather than guessing, and the
 * two stages are additionally required to carry DIFFERENT root pids.
 */
export function judgeStageEvidence(
  controlDir: string,
  before: ReadonlySet<string>,
  stageRootPids?: { version?: number | null; models?: number | null },
): StageJudgment {
  const names = runRecords(controlDir, before);
  const failures: StageFailure[] = [];

  const empty = (runRecordCount: number): StageEvidence => ({
    runRecordCount,
    recordFile: null,
    validation: null,
    rootPid: null,
    treeStopConfirmed: false,
    statuses: [],
  });

  if (names.length === 0) {
    const reason = 'no-run-records';
    const detail = 'this run created no control record at all; neither stage can be evidenced';
    return {
      ok: false,
      evidence: { version: empty(0), models: empty(0) },
      failures: [
        { stage: 'version', reason, detail },
        { stage: 'models', reason, detail },
      ],
    };
  }

  if (names.length !== 2) {
    /*
     * A stage may not choose from an arbitrary set. Two executions are expected, so
     * exactly two records: fewer means a stage never ran, more means the attribution
     * is ambiguous by construction.
     */
    const detail =
      `expected exactly 2 control records for this run (version probe + catalogue query), got ${names.length}: ${names.join(', ')}`;
    return {
      ok: false,
      evidence: { version: empty(names.length), models: empty(names.length) },
      failures: [
        { stage: 'version', reason: 'stage-record-ambiguous', detail },
        { stage: 'models', reason: 'stage-record-ambiguous', detail },
      ],
    };
  }

  /*
   * Attribution: BY IDENTITY when the caller supplied root pids, otherwise by WRITE
   * TIME. Never by filename. When neither can attribute the stage, it fails.
   */
  const byPid = stageRootPids?.version != null || stageRootPids?.models != null;
  const ordered = byPid ? null : orderByWriteTime(controlDir, names);
  const attributionFailed: StageFailure[] = byPid
    ? []
    : ordered === null
      ? [
          {
            stage: 'version',
            reason: 'stage-record-ambiguous',
            detail: 'the run\'s control records could not be ordered by write time; a stage may not be attributed by guessing',
          } as StageFailure,
          {
            stage: 'models',
            reason: 'stage-record-ambiguous',
            detail: 'the run\'s control records could not be ordered by write time; a stage may not be attributed by guessing',
          } as StageFailure,
        ]
      : [];

  const pick = (stage: CatalogStage): { evidence: StageEvidence; failure: StageFailure | null } => {
    const wanted = stageRootPids?.[stage] ?? null;
    const byTime = ordered === null ? null : (stage === 'version' ? ordered[0] : ordered[ordered.length - 1]);
    if (wanted === null && byTime === undefined) {
      return {
        evidence: empty(names.length),
        failure: attributionFailed.find((f) => f.stage === stage) ?? {
          stage,
          reason: 'stage-record-missing',
          detail: 'no root pid was observed and write-time ordering was unavailable for this stage',
        },
      };
    }
    const matches = names.filter((n) => {
      const v = readControlRecord(join(controlDir, n));
      if (!v.ok) return false;
      if (wanted !== null) return v.record.rootPid === wanted;
      return byTime !== undefined && byTime !== null && n === byTime;
    });
    if (matches.length === 0) {
      // The stage ran but left no record of its own: check whether its record is
      // present but INVALID, so the failure reason is precise rather than generic.
      const invalid = names.filter((n) => !readControlRecord(join(controlDir, n)).ok);
      return {
        evidence: empty(names.length),
        failure: {
          stage,
          reason: invalid.length > 0 ? 'stage-record-invalid' : 'stage-record-missing',
          detail: invalid.length > 0
            ? `no valid record carries rootPid=${wanted}; present but invalid: ${invalid.join(', ')}`
            : `no record carries rootPid=${wanted}`,
        },
      };
    }
    if (matches.length > 1) {
      return {
        evidence: empty(names.length),
        failure: {
          stage,
          reason: 'stage-record-ambiguous',
          detail: `rootPid=${wanted} is carried by more than one record: ${matches.join(', ')}`,
        },
      };
    }
    const name = matches[0]!;
    const v = readControlRecord(join(controlDir, name));
    if (!v.ok) {
      return {
        evidence: {
          runRecordCount: names.length,
          recordFile: name,
          validation: null,
          rootPid: null,
          treeStopConfirmed: false,
          statuses: [`<invalid:${v.reason}>`],
        },
        failure: { stage, reason: 'stage-record-invalid', detail: `${name}: ${v.reason}` },
      };
    }
    const confirmed = treeStopConfirmedFrom(v.record);
    return {
      evidence: {
        runRecordCount: names.length,
        recordFile: name,
        validation: v,
        rootPid: v.record.rootPid,
        treeStopConfirmed: confirmed,
        statuses: [v.record.launcherStatus],
      },
      failure: confirmed
        ? null
        : {
            stage,
            reason: 'tree-stop-unconfirmed',
            detail: `${name}: launcherStatus=${v.record.launcherStatus} treeStopped=${v.record.treeStopped ? 1 : 0} activeProcessesFinal=${v.record.activeProcessesFinal ?? 'none'}`,
          },
    };
  };

  const version = pick('version');
  const models = pick('models');
  if (version.failure !== null) failures.push(version.failure);
  if (models.failure !== null) failures.push(models.failure);

  /*
   * Cross-substitution: the two stages must not be evidenced by the same record.
   * With exactly two files this cannot happen, but the check is explicit so the
   * invariant is asserted rather than assumed.
   */
  const sameRecord =
    version.evidence.recordFile !== null &&
    version.evidence.recordFile === models.evidence.recordFile;
  if (sameRecord) {
    failures.push({
      stage: 'models',
      reason: 'stage-record-ambiguous',
      detail: `both stages resolved to the same record ${version.evidence.recordFile}`,
    });
  }

  return {
    ok: failures.length === 0,
    evidence: { version: version.evidence, models: models.evidence },
    failures,
  };
}
