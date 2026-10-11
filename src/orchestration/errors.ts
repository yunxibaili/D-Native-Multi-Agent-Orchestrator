/**
 * src/orchestration/errors.ts — the single typed error surface for workspace and
 * merge operations.
 *
 * Split out of `workspace.ts` (5C-9) so that the git runner can report a missing
 * git binary without importing `workspace.ts` and creating a cycle. Both modules
 * import from here, and `workspace.ts` re-exports for API compatibility.
 */

export const WORKSPACE_ERROR_CODES = [
  'workspace-git-missing',
  'workspace-project-root-missing',
  'workspace-not-a-git-repository',
  'workspace-invalid-task-id',
  'workspace-path-missing',
  'workspace-worktree-exists',
  'workspace-branch-exists',
  'workspace-worktree-add-failed',
  'workspace-branch-protected',
  'workspace-branch-not-owned',
  'workspace-branch-checked-out',
  'workspace-lock-timeout',
  // ---- R5-1.2C (§6): a git operation whose DESCENDANT TREE stop could not be
  // confirmed. The root exited, so nothing is "still running" as far as the root
  // goes, but a leaked descendant may still be writing the workspace. Physical
  // protection is therefore RETAINED, and the caller must resolve it explicitly
  // rather than have it released by a `finally`.
  'workspace-stop-unconfirmed',
  'workspace-unknown',
  // ---- R2-1: Workspace / Resource Safety. A resource conflict is an ADMISSION
  // refusal, deliberately NOT an agent failure: nothing ran, and blaming the worker
  // would be wrong (see R2_COORDINATION_CONTRACT §7.2/§13).
  'resource-conflict',
  // ---- R2-1.1 (P1-b): isolation is UNAVAILABLE (e.g. a non-git project, where no
  // worktree can exist), rather than merely contested. Distinct from
  // `resource-conflict` on purpose: "someone else holds it" and "nothing can hold it
  // safely" are different facts. Like the conflict code, this is an ADMISSION
  // refusal and never an agent failure.
  'resource-unavailable',
  // ---- 5C-9: inspect + merge. Every refusal is a named code, never a bare
  // string, so a caller can branch on the reason without parsing prose.
  'merge-task-not-found',
  'merge-no-workspace',
  'merge-workspace-not-isolated',
  'merge-task-not-verified',
  'merge-branch-not-owned',
  'merge-worktree-missing',
  'merge-child-dirty',
  'merge-nothing-to-merge',
  'merge-already-merged',
  'merge-root-dirty',
  'merge-conflict',
  'merge-failed',
] as const;
export type WorkspaceErrorCode = (typeof WORKSPACE_ERROR_CODES)[number];

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  constructor(code: WorkspaceErrorCode, message: string) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}