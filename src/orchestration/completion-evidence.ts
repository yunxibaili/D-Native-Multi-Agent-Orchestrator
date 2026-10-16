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
 * WHAT THIS PROVES (and does not)
 * -------------------------------
 * It proves the durable before/after file difference and the real exit status of the
 * one approved command. It is NOT a sandbox: it does not claim a transient outside
 * write never happened, and it never treats the model's prose, a tool event, a
 * session's exit or a head-only git status as proof.
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
  readonly outputDigest: string;
  readonly note: string;
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
): Promise<CompletionTestOutcome> {
  const cwd = test.cwd === '.' ? workspaceRoot : join(workspaceRoot, test.cwd);
  let launcher;
  try {
    launcher = resolveCommand(test.executable).launcher;
  } catch (e) {
    return {
      executable: test.executable,
      argv: [...test.argv],
      cwd,
      code: null,
      signal: null,
      timedOut: false,
      treeStopConfirmed: false,
      outputDigest: digestText(`launcher-unresolved:${(e as Error).message}`),
      note: `could not resolve the approved test executable "${test.executable}": ${(e as Error).message}`,
    };
  }

  let stdout = '';
  let stderr = '';
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
      outputDigest: digestText(`${stdout}\u0000${stderr}`),
      note: `timed out after ${timeoutMs}ms (tree stop ${treeStopConfirmed ? 'confirmed' : 'NOT confirmed'})`,
    };
  }

  const e = await proc.exited;
  const treeStopConfirmed = contained ? proc.isTreeStopConfirmed() : true;
  return {
    executable: test.executable,
    argv: [...test.argv],
    cwd,
    code: e.code,
    signal: e.signal,
    timedOut: false,
    treeStopConfirmed,
    outputDigest: digestText(`${stdout}\u0000${stderr}`),
    note: treeStopConfirmed ? '' : 'process tree stop was NOT confirmed',
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
  readonly runFingerprint: string;
  readonly contractDigest: string;
  readonly workspaceRoot: string;
  readonly workspaceDigest: string | null;
  readonly unsafeWorkspace: boolean;
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
 * `afterRun` is taken AFTER the agent run but BEFORE the approved test, so the test's
 * own (pre-approved) writes are not attributed to the worker. The staleness digest is
 * taken AFTER the approved test, so ANY later change — including to an allowed path —
 * invalidates the proof.
 */
export async function buildCompletionEvidence(input: {
  taskId: string;
  leaseVersion: number;
  agentId: string;
  modelId: string | null;
  contract: CompletionContract;
  workspaceRoot: string;
  before: WorkspaceManifest;
  afterRun: WorkspaceManifest;
  runFingerprint: string;
  timeoutMs: number;
  now: number;
}): Promise<CompletionEvidence> {
  const diff = diffWorkspaceManifest(input.before, input.afterRun);
  const changedFiles = [...new Set([...diff.added, ...diff.modified, ...diff.deleted])].sort();
  const outOfScope = changedFiles.filter((p) => !isPathAllowed(p, input.contract.allowedScope));

  const test = await runApprovedTest(input.contract.test, input.workspaceRoot, input.timeoutMs);
  const afterTest = captureWorkspaceManifest(input.workspaceRoot);
  const workspaceDigest = manifestDigest(afterTest);

  const present = new Set(afterTest.files.map(artifactKey));
  const missingArtifacts = input.contract.expectedArtifacts.filter((a) => !present.has(artifactKey(a)));
  const artifactsPresent = input.contract.expectedArtifacts.filter((a) => present.has(artifactKey(a)));

  return Object.freeze({
    taskId: input.taskId,
    leaseVersion: input.leaseVersion,
    agentId: input.agentId,
    modelId: input.modelId,
    runFingerprint: input.runFingerprint,
    contractDigest: completionContractDigest(input.contract),
    workspaceRoot: input.workspaceRoot,
    workspaceDigest,
    unsafeWorkspace: !input.afterRun.safe || !afterTest.safe,
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
