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
  'workspace-unknown',
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