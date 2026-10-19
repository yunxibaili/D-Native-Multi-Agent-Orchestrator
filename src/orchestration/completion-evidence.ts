/**
 * src/orchestration/completion-evidence.ts — P0-1: gathering the proof, and running
 * the approved test.
 *
 * ============================================================================
 * WHAT THIS IS
 * ============================================================================
 * The IMPURE half of the completion gate: it captures before/after manifests of the
 * real workspace, runs the contract's APPROVED test through the EXISTING contained
 * process path, and folds the result into a single immutable `CompletionEvidence`
 * value. The PURE decision over that value lives in `completion-gate.ts`.
 *
 * NO NAKED PROCESS EDGE
 * ---------------------
 * The approved test is launched exactly like an agent command: `resolveCommand` picks
 * the launcher, `ManagedProcess` runs it through the sealed containment path, and on
 * timeout the cooperative Job stop must CONFIRM the tree emptied. There is no
 * `execFile`, no `shell:true`, no bare `spawn`, and no second process manager. A run
 * whose tree stop is unconfirmed is NOT valid evidence.
 *
 * WHAT IT PROVES (and does not)
 * -------------------------------
 * It proves the DURABLE before→after-TEST file difference — the worker's writes AND
 * the approved test's own writes — and the real exit status of the one approved
 * command. It is NOT a sandbox: it does not claim a transient outside write never
 * happened, and it never treats the model's prose, a tool event, a session's exit or a
 * head-only git status as proof.
 *
 * SAFETY BEFORE RUNNING
 * ---------------------
 * An unsafe workspace (a link/junction in the tree, an unhashable file) or an approved
 * cwd that TRAVERSES a reparse point is refused BEFORE the test is started: a contained
 * test must never be launched into an aliased directory.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ManagedProcess } from '../runtime/spawn.ts';
import { containmentEnabled } from '../runtime/containment.ts';
import { resolveCommand } from '../runtime/discover.ts';
import {
  captureWorkspaceManifest,
  diffWorkspaceManifest,
  manifestDigest,
  relativePathCrossesLink,
  type WorkspaceManifest,
} from './workspace-manifest.ts';
import {
  completionContractDigest,
  isPathAllowed,
  type CompletionContract,
  type CompletionTestCommand,
} from './completion-contract.ts';

/** Default bound for the approved test. Callers may shrink it (tests do). */
export const DEFAULT_COMPLETION_TEST_TIMEOUT_MS = 120_000;

export interface CompletionTestOutcome {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly code: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly treeStopConfirmed: boolean;
  /** True once the process could have been created (so the caller must retain a claim). */
  readonly mayHaveStarted: boolean;
  readonly outputDigest: string;
  readonly note: string;
}

export interface RunApprovedTestHooks {
  /**
   * Invoked IMMEDIATELY BEFORE the `ManagedProcess` constructor, i.e. before the
   * execution edge is entered. The caller uses it to raise its own "may have started"
   * requirement so a throw cannot be misread as "nothing ran".
   */
  readonly onMayHaveStarted?: () => void;
  /**
   * A NARROW test-only seam for the unconfirmed-stop path. When provided it may only
   * DOWNGRADE the launcher's own tree-stop verdict, so a test can drive the "we asked
   * and could not confirm the tree emptied" branch WITHOUT leaving a real orphan
   * writer. `true` can never manufacture a confirmed stop the launcher did not observe.
   * Production never passes it.
   */
  readonly stopVerdictProbe?: () => boolean;
}

/**
 * Run one approved command through the contained `ManagedProcess` path.
 *
 * On timeout it requests the cooperative Job stop and reports the launcher's own
 * CONFIRMED tree-stop fact; a stop that cannot be confirmed is `treeStopConfirmed:
 * false`, which the gate turns into a refusal. The root's exit is never treated as
 * proof that the tree stopped.
 */
export async function runApprovedTest(
  test: CompletionTestCommand,
  workspaceRoot: string,
  timeoutMs: number,
  hooks: RunApprovedTestHooks = {},
): Promise<CompletionTestOutcome> {
  const cwd = test.cwd === '.' ? workspaceRoot : join(workspaceRoot, test.cwd);
  // A cwd that traverses a reparse point would make "the approved directory" an alias
  // for somewhere else. Refuse BEFORE starting a process.
  if (relativePathCrossesLink(workspaceRoot, test.cwd)) {
    return notRun(test, cwd, `approved cwd "${test.cwd}" traverses a symbolic link/reparse point`);
  }
  let launcher;
  try {
    launcher = resolveCommand(test.executable).launcher;
  } catch (e) {
    return notRun(test, cwd, `could not resolve the approved test executable "${test.executable}": ${(e as Error).message}`);
  }

  let stdout = '';
  let stderr = '';
  // The requirement is raised BEFORE the constructor/edge: `ManagedProcess` may create
  // an OS process, so from here on no generic failure may read as "nothing started".
  hooks.onMayHaveStarted?.();
  let proc: ManagedProcess;
  try {
    proc = new ManagedProcess({
      launcher,
      args: [...test.argv],
      cwd,
      onStdoutLine: (l) => { stdout += l + '\n'; },
      onStderrLine: (l) => { stderr += l + '\n'; },
    });
  } catch (e) {
    return {
      executable: test.executable,
      argv: [...test.argv],
      cwd,
      code: null,
      signal: null,
      timedOut: false,
      treeStopConfirmed: false,
      mayHaveStarted: true,
      outputDigest: digestText(`spawn-refused:${(e as Error).message}`),
      note: `the approved test could not be started: ${(e as Error).message}`,
    };
  }

  const contained = containmentEnabled();
  let deadline: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((res) => {
    deadline = setTimeout(() => res('timeout'), timeoutMs);
    if (typeof deadline.unref === 'function') deadline.unref();
  });

  let settled: 'exited' | 'timeout';
  try {
    settled = await Promise.race([proc.exited.then(() => 'exited' as const), timedOut]);
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }

  if (settled === 'timeout') {
    const confirmed = await proc.cancel('completion test timeout').catch(() => false);
    await proc.settleCleanup().catch(() => false);
    const treeStopConfirmed = confirmed === true && (contained ? proc.isTreeStopConfirmed() : true);
    return {
      executable: test.executable,
      argv: [...test.argv],
      cwd,
      code: null,
      signal: null,
      timedOut: true,
      treeStopConfirmed,
      mayHaveStarted: true,
      outputDigest: digestText(`${stdout}\u0000${stderr}`),
      note: `timed out after ${timeoutMs}ms (tree stop ${treeStopConfirmed ? 'confirmed' : 'NOT confirmed'})`,
    };
  }

  const e = await proc.exited;
  // The launcher's OWN confirmed tree-stop is the fact. The test-only probe may only
  // DOWNGRADE it (drive the "unconfirmed" branch without leaving a real orphan writer);
  // it can never MANUFACTURE `true` where the launcher did not confirm the stop.
  const actualTreeStopConfirmed = contained ? proc.isTreeStopConfirmed() : true;
  const treeStopConfirmed = hooks.stopVerdictProbe !== undefined
    ? (hooks.stopVerdictProbe() === true && actualTreeStopConfirmed)
    : actualTreeStopConfirmed;
  return {
    executable: test.executable,
    argv: [...test.argv],
    cwd,
    code: e.code,
    signal: e.signal,
    timedOut: false,
    treeStopConfirmed,
    mayHaveStarted: true,
    outputDigest: digestText(`${stdout}\u0000${stderr}`),
    note: treeStopConfirmed ? '' : 'process tree stop was NOT confirmed',
  };
}

function notRun(test: CompletionTestCommand, cwd: string, note: string): CompletionTestOutcome {
  return {
    executable: test.executable,
    argv: [...test.argv],
    cwd,
    code: null,
    signal: null,
    timedOut: false,
    treeStopConfirmed: false,
    mayHaveStarted: false,
    outputDigest: digestText(`not-run:${note}`),
    note,
  };
}

function digestText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface CompletionEvidence {
  readonly taskId: string;
  readonly leaseVersion: number;
  readonly agentId: string;
  readonly modelId: string | null;
  /**
   * The dispatch SESSION this execution ran in, from the freeze-point mapping. Null when
   * the execution ran sessionless; part of what the proof binds.
   */
  readonly sessionId: string | null;
  readonly runFingerprint: string;
  readonly contractDigest: string;
  readonly workspaceRoot: string;
  readonly workspaceDigest: string | null;
  readonly unsafeWorkspace: boolean;
  /** The TOTAL worker+test difference (baseline → after approved test). */
  readonly changedFiles: readonly string[];
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
  readonly artifactsPresent: readonly string[];
  readonly missingArtifacts: readonly string[];
  readonly outOfScope: readonly string[];
  readonly test: CompletionTestOutcome;
  readonly validatedAt: number;
}

/** A stable fingerprint of the run whose result the evidence describes. */
export function runFingerprintOf(input: {
  taskId: string;
  agentId: string;
  modelId: string | null;
  startedAt: number;
  endedAt: number;
  state: string;
  exitCode: number | null;
}): string {
  return digestText(
    `${input.taskId}\u0000${input.agentId}\u0000${input.modelId ?? ''}\u0000${input.startedAt}\u0000${input.endedAt}\u0000${input.state}\u0000${input.exitCode ?? ''}`,
  );
}

function artifactKey(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/**
 * Fold the manifests + the approved test run into one immutable evidence value.
 *
 * The scope comparison is `baseline (BEFORE the worker)` → `afterTest (AFTER the
 * approved test)`, so BOTH the worker's writes and the test's own writes are counted:
 * a test that touches a path outside `allowedScope` is refused, it is not silently
 * attributed to "the test, not the worker". An unchanged pre-existing dirty file
 * produces no diff entry, so it is never attributed to the attempt.
 */
export async function buildCompletionEvidence(input: {
  taskId: string;
  leaseVersion: number;
  agentId: string;
  modelId: string | null;
  sessionId: string | null;
  contract: CompletionContract;
  workspaceRoot: string;
  before: WorkspaceManifest;
  afterRun: WorkspaceManifest;
  runFingerprint: string;
  timeoutMs: number;
  now: number;
  hooks?: RunApprovedTestHooks;
}): Promise<CompletionEvidence> {
  // Unsafe BEFORE the test: do not launch a contained command into a workspace whose
  // artifact set cannot be certified.
  const cwdCrossesLink = relativePathCrossesLink(input.workspaceRoot, input.contract.test.cwd);
  const unsafeBefore = !input.before.safe || !input.afterRun.safe || cwdCrossesLink;
  const test = unsafeBefore
    ? notRun(
        input.contract.test,
        input.contract.test.cwd === '.' ? input.workspaceRoot : join(input.workspaceRoot, input.contract.test.cwd),
        !input.before.safe || !input.afterRun.safe
          ? 'not run: the workspace manifest is unsafe (link/reparse point or unhashable file)'
          : 'not run: the approved cwd traverses a symbolic link/reparse point',
      )
    : await runApprovedTest(input.contract.test, input.workspaceRoot, input.timeoutMs, input.hooks ?? {});

  const afterTest = captureWorkspaceManifest(input.workspaceRoot);
  const workspaceDigest = manifestDigest(afterTest);

  // TOTAL difference: baseline → after the approved test. Both the worker and the test
  // count. A path the test wrote outside the allowed scope therefore fails the gate.
  const diff = diffWorkspaceManifest(input.before, afterTest);
  const changedFiles = [...new Set([...diff.added, ...diff.modified, ...diff.deleted])].sort();
  const outOfScope = changedFiles.filter((p) => !isPathAllowed(p, input.contract.allowedScope));

  const present = new Set(afterTest.files.map(artifactKey));
  const missingArtifacts = input.contract.expectedArtifacts.filter((a) => !present.has(artifactKey(a)));
  const artifactsPresent = input.contract.expectedArtifacts.filter((a) => present.has(artifactKey(a)));

  return Object.freeze({
    taskId: input.taskId,
    leaseVersion: input.leaseVersion,
    agentId: input.agentId,
    modelId: input.modelId,
    sessionId: input.sessionId,
    runFingerprint: input.runFingerprint,
    contractDigest: completionContractDigest(input.contract),
    workspaceRoot: input.workspaceRoot,
    workspaceDigest,
    unsafeWorkspace: unsafeBefore || !afterTest.safe,
    changedFiles: Object.freeze(changedFiles),
    added: diff.added,
    modified: diff.modified,
    deleted: diff.deleted,
    artifactsPresent: Object.freeze(artifactsPresent),
    missingArtifacts: Object.freeze(missingArtifacts),
    outOfScope: Object.freeze(outOfScope),
    test,
    validatedAt: input.now,
  });
}
