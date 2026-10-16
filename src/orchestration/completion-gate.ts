/**
 * src/orchestration/completion-gate.ts — P0-1: the shared completion decision.
 *
 * ============================================================================
 * WHY THIS IS ITS OWN, IMPORT-FREE MODULE
 * ============================================================================
 * This is a PURE decision over already-gathered facts. It deliberately has NO imports
 * (not even type-only ones), so:
 *
 *   - it cannot reach the store, the runtime, the filesystem or the network, which is
 *     what makes "the gate is a value, not an authority" a structural fact;
 *   - a test can load an ISOLATED COPY of this module (with a key condition disabled)
 *     and prove the suite DETECTS a bypass, without touching the real file.
 *
 * The impure work — capturing before/after manifests, running the approved test,
 * reading the current task/lease — happens in the orchestrator, which then calls this
 * function. `applyVerification('pass')` is the single caller on the production path, so
 * every reachable pass (decision `complete`, manual accept, review loop) is subject to
 * the SAME rule and cannot forge one.
 *
 * WHAT IS CHECKED (all must hold; the first failure is named)
 * ---------------------------------------------------------
 *   1. no contract  -> pass through (pre-P0-1 behaviour; the plan-file path refuses to
 *                      build a coding task without one, so this is never a governed coding task)
 *   2. evidence present
 *   3. contract digest matches the task's current contract
 *   4. evidence belongs to THIS task
 *   5. same lease version (a reassign advances it and invalidates the proof)
 *   6. same Agent × Model identity
 *   7. current workspace digest matches the post-run digest (a later edit invalidates it)
 *   8. the approved test really exited 0
 *   9. the approved test did not time out
 *  10. the process tree stop was positively confirmed
 *  11. every expected artifact is present
 *  12. every changed path is inside allowedScope
 */

export interface CompletionGateEvidenceView {
  /** Digest of the contract the evidence was gathered against. */
  readonly contractDigest: string;
  readonly taskId: string;
  readonly leaseVersion: number;
  readonly agentId: string;
  readonly modelId: string | null;
  /** Digest of the workspace AFTER the approved test; null when unavailable/unsafe. */
  readonly workspaceDigest: string | null;
  /** True when a link/reparse point made the workspace manifest unsafe. */
  readonly unsafeWorkspace: boolean;
  readonly testCode: number | null;
  readonly testTimedOut: boolean;
  readonly testTreeStopConfirmed: boolean;
  /** Expected artifacts that were absent at the real root. */
  readonly missingArtifacts: readonly string[];
  /** Changed paths that fell outside allowedScope. */
  readonly outOfScope: readonly string[];
}

export interface CompletionGateTaskView {
  readonly taskId: string;
  readonly leaseVersion: number;
  readonly agentId: string;
  readonly modelId: string | null;
  /** Digest of the task's CURRENT contract; null when none is attached. */
  readonly contractDigest: string | null;
}

export type CompletionGateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly reason: string };

export interface CompletionGateInput {
  /** Whether the task carries a completion contract at all. */
  readonly contractPresent: boolean;
  readonly task: CompletionGateTaskView;
  readonly evidence: CompletionGateEvidenceView | null;
  /** Digest of the workspace re-read at the synchronous commit point. */
  readonly currentWorkspaceDigest: string | null;
}

export function evaluateCompletionGate(input: CompletionGateInput): CompletionGateResult {
  if (!input.contractPresent) {
    // No contract => not a governed coding task. Legacy behaviour exactly, so a
    // research/review task and every pre-P0-1 fixture are untouched.
    return { ok: true };
  }
  const evidence = input.evidence;
  if (evidence === null || evidence === undefined) {
    // CRITICAL BYPASS POINT (see the negative control): missing evidence must never
    // become success.
    return {
      ok: false,
      code: 'completion-evidence-missing',
      reason:
        `task "${input.task.taskId}" declares a completion contract, but no completion ` +
        `evidence was produced by its actual execution; a coding task is never completed without one`,
    };
  }
  if (input.task.contractDigest === null || evidence.contractDigest !== input.task.contractDigest) {
    return {
      ok: false,
      code: 'completion-contract-mismatch',
      reason: `the completion evidence was gathered against a different contract than the task currently carries`,
    };
  }
  if (evidence.taskId !== input.task.taskId) {
    return {
      ok: false,
      code: 'completion-evidence-foreign-task',
      reason: `evidence for task "${evidence.taskId}" cannot complete task "${input.task.taskId}"`,
    };
  }
  if (evidence.leaseVersion !== input.task.leaseVersion) {
    return {
      ok: false,
      code: 'completion-evidence-stale-lease',
      reason:
        `the completion evidence belongs to lease ${evidence.leaseVersion}, but the task is now lease ` +
        `${input.task.leaseVersion}; a reassignment invalidates the proof`,
    };
  }
  if (evidence.agentId !== input.task.agentId || evidence.modelId !== input.task.modelId) {
    return {
      ok: false,
      code: 'completion-evidence-identity-mismatch',
      reason:
        `the completion evidence was produced by ${evidence.agentId}/${evidence.modelId ?? 'default'}, but the task ` +
        `is now ${input.task.agentId}/${input.task.modelId ?? 'default'}`,
    };
  }
  if (evidence.unsafeWorkspace) {
    return {
      ok: false,
      code: 'completion-workspace-unsafe',
      reason: `the workspace contained a symbolic link/reparse point, so its artifact set cannot be trusted`,
    };
  }
  if (evidence.workspaceDigest === null || input.currentWorkspaceDigest === null) {
    return {
      ok: false,
      code: 'completion-workspace-unavailable',
      reason: `the confirmed workspace could not be re-read at completion time, so no artifact version can be trusted`,
    };
  }
  if (evidence.workspaceDigest !== input.currentWorkspaceDigest) {
    return {
      ok: false,
      code: 'completion-evidence-stale-workspace',
      reason:
        `the workspace changed after the approved test ran (verified version ${evidence.workspaceDigest.slice(0, 12)}…, ` +
        `current ${input.currentWorkspaceDigest.slice(0, 12)}…); the earlier proof does not describe the current artifacts`,
    };
  }
  if (evidence.testTimedOut) {
    return { ok: false, code: 'completion-test-timeout', reason: `the approved test timed out and is not valid evidence` };
  }
  if (evidence.testCode !== 0) {
    return {
      ok: false,
      code: 'completion-test-nonzero',
      reason: `the approved test exited ${evidence.testCode === null ? 'without a code' : evidence.testCode} (not 0)`,
    };
  }
  if (!evidence.testTreeStopConfirmed) {
    return {
      ok: false,
      code: 'completion-test-tree-unconfirmed',
      reason: `the approved test's process-tree stop was NOT positively confirmed, so its result cannot be trusted`,
    };
  }
  if (evidence.missingArtifacts.length > 0) {
    return {
      ok: false,
      code: 'completion-artifact-missing',
      reason: `expected artifact(s) are absent at the workspace root: ${evidence.missingArtifacts.join(', ')}`,
    };
  }
  if (evidence.outOfScope.length > 0) {
    return {
      ok: false,
      code: 'completion-scope-violation',
      reason: `change(s) fell outside allowedScope: ${evidence.outOfScope.join(', ')}`,
    };
  }
  return { ok: true };
}
