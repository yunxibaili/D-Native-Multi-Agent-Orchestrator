/**
 * src/orchestration/index.ts 鈥?the 5C-1 public surface.
 *
 * Deliberately small. Everything exported here is implemented and tested in
 * 5C-1; everything deferred is listed in the Phase 5C-1 boundary section of
 * docs/PHASE5B_MULTI_AGENT_ARCHITECTURE.md rather than stubbed out here.
 */

export {
  TASK_STATUSES,
  TERMINAL_STATUSES,
  RESERVED_STATUSES,
  TASK_TRANSITIONS,
  isTerminal,
  canTransition,
  createTask,
  validateDependencies,
  unmetDependencies,
  findDependencyCycle,
  type Task,
  type TaskSpec,
  type TaskStatus,
  type ArtifactRef,
  type CreateTaskResult,
  type DependencyCheckInput,
} from './task.ts';

export { TaskStore, type TransitionResult } from './store.ts';

export {
  buildSpawnGateInput,
  resolveTaskPolicy,
  resolveAgentAvailability,
  resolveCapability,
  resolveWorkspaceModeCapability,
  WORKSPACE_CAPABILITY_MISSING,
  resolveModelAvailability,
  resolveQuotaStatus,
  resolveBudgetHeadroom,
  resolveConcurrency,
  resolveRequestedUnits,
  resolveCap,
  resolveMaxChildren,
  resolveMaxConcurrentAgents,
  type SpawnGateSources,
  type SpawnGateDecision,
  type BuildSpawnGateInput,
  type MissingSignal,
  type Signal,
} from './spawn-gate-input.ts';

export {
  translateRunResult,
  translateVerification,
  type RunTranslation,
  type VerificationOutcome,
} from './translate.ts';

export {
  buildRunRequest,
  buildTaskPrompt,
  isExecutable,
  EXECUTABLE_STATUSES,
  type RuntimeRunner,
  type RunRequestMapping,
  type BuildRunRequestInput,
  type ExecuteOutcome,
} from './execute.ts';

export {
  WorkspaceManager,
  WorkspaceError,
  WORKSPACE_ERROR_CODES,
  defaultWorkspaceMode,
  branchForTask,
  resolveGitPath,
  type WorkspaceHandle,
  type WorkspaceMode,
  type WorkspaceErrorCode,
  type WorkspaceCleanupPolicy,
  type WorkspaceManagerOptions,
} from './workspace.ts';

// 5C-9: inspect + explicit merge.
export {
  summarizeTask,
  mergeTaskBranch,
  discoverWorkspaceByTask,
  listTaskBranches,
  type TaskResultSummary,
  type MergeOutcome,
  type ChangedFile,
  type DiffStat,
  type GitContext,
} from './task-result.ts';

// 5C-9: the single git execution path (shared by workspace, inspect and merge).
export { runGit, stderrIsFatal, type GitResult } from './git.ts';

// 5C-8: cross-process workspace creation lock.
export {
  WorkspaceLock,
  WorkspaceLockError,
  WORKSPACE_LOCK_ERROR_CODES,
  workspaceLockKey,
  normalizeIdentityPath,
  identityDigest,
  isProcessAlive,
  type WorkspaceLockOwner,
  type WorkspaceLockLease,
  type WorkspaceLockOptions,
  type WorkspaceLockErrorCode,
} from './workspace-lock.ts';

export {
  OrchestrationController,
  type ControllerOptions,
  type OrchestrationChildSpec,
  type ChildRequestResult,
  type RunPlanResult,
} from './controller.ts';

export {
  TaskScheduler,
  type TaskSchedulerOptions,
  type TickResult,
  type SchedulerSkip,
  type SchedulerStatus,
} from './scheduler.ts';

export {
  Orchestrator,
  DEFAULT_LIMITS,
  MVP_MAX_DEPTH,
  MVP_MAX_CHILDREN,
  MVP_MAX_CONCURRENT_CHILDREN,
  type OrchestrationOptions,
  type OrchestrationLimits,
  type SpawnChildRequest,
  type ExecuteTaskRequest,
  type SpawnOutcome,
  type MutateOutcome,
} from './orchestrator.ts';
