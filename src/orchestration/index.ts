/**
 * src/orchestration/index.ts - the 5C-1 public surface.
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
  resolveFreeModelPoolAdmission,
  MODEL_POOL_ERROR_CODES,
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
  AVAILABILITY_ERROR_CODES,
  translateRunResult,
  translateVerification,
  type RunTranslation,
  type TranslateOptions,
  type VerificationOutcome,
} from './translate.ts';

export {
  buildRunRequest,
  buildTaskPrompt,
  isExecutable,
  EXECUTABLE_STATUSES,
  type RuntimeRunner,
  type ProcessStartDisposition,
  type RunRequestMapping,
  type BuildRunRequestInput,
  type ExecuteOutcome,
} from './execute.ts';

// TeamRun T3-a.1: the READ-only fan-out topology vocabulary + deterministic aggregation
// projection. Pure values/helpers; the materialization runs on NativeWorkbench.
export {
  FANOUT_ACCESS_MODE,
  FANOUT_MEMBER_TASK_TYPE,
  FANOUT_MAX_MEMBERS,
  FANOUT_MIN_MEMBERS,
  validateFanoutMembers,
  projectFanoutAggregation,
  type ExecutionTopology,
  type FanoutMemberSpec,
  type FanoutProvenance,
  type FanoutAggregation,
  type FanoutMemberState,
  type FanoutValidation,
} from './fanout.ts';

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

// R2-1: Workspace / Resource Safety. The claims are arbitrated BY WorkspaceManager
// (exported above); what is exported here is the pure vocabulary it uses, so a
// caller can normalize a scope or read the conflict matrix without reaching into
// the workspace implementation.
export {
  ResourceClaimBook,
  modeRequiresIsolation,
  claimsConflict,
  scopesOverlap,
  normalizeScope,
  normalizeScopeForWorkspace,
  normalizeScopeForRepository,
  scopeKey,
  describeScope,
  type ResourceClaim,
  type ResourceClaimMode,
  type ResourceScope,
  type ClaimRequest,
  type ClaimOutcome,
  type NormalizeScopeInput,
} from './resource-claim.ts';

// P6-B: deterministic, evidence-aware worker/model selection.
// The engine is a PURE function of a snapshot. It writes identity and nothing
// else; the existing spawn gate keeps the final veto, and TaskStore remains the
// only lifecycle authority.
export {
  ASSIGNMENT_FAILURE_CODES,
  ASSIGNABLE_STATUSES,
  assignWorker,
  scoreCandidate,
  isAssignable,
  requestModelSwitch,
  type AssignmentInput,
  type AssignmentOutcome,
  type AssignmentCandidate,
  type AssignmentFailureCode,
  type CandidateRejection,
  type ScoreBreakdown,
  type ScoredCandidate,
} from './assignment.ts';

export {
  applyAssignment,
  recordDispatchedExecutions,
  recordReworkExecution,
  type DispatchEvidenceResult,
} from './assignment-wiring.ts';

// P6-C: the planner produces candidate DAGs; the wiring is the only path from a
// validated plan into the existing TaskStore. Neither can execute, dispatch or
// assign - see the module headers for why that is structural, not a convention.
export {
  planTasks,
  validateCandidateDag,
  PlannerError,
  isPlannerError,
  type PlannerInput,
  type PlannerOutput,
  type CandidateTask,
  type DagValidation,
  type CycleProbe,
} from './planner.ts';

export {
  commitPlan,
  replanSubtree,
  staleTasks,
  type CommitOptions,
  type CommitOutcome,
  type CommitFailure,
  type ReplanOutcome,
} from './planner-wiring.ts';

// P6-E: structured attempt evidence.
// AttemptRecord is history ONLY: it never transitions a task, never dispatches,
// and never becomes a second status authority. Read-only aggregation lives in
// AttemptStore; nothing here ranks, scores or chooses.
export {
  ATTEMPT_KINDS,
  ATTEMPT_OUTCOMES,
  AttemptRecordError,
  isAttemptRecordError,
  validateAttemptRecord,
  executionAttempt,
  reworkAttempt,
  reviewAttempt,
  type AttemptKind,
  type AttemptOutcome,
  type AttemptRecord,
  type AttemptVerification,
} from './attempt-record.ts';

export {
  AttemptStore,
  type AttemptAppendOutcome,
  type AttemptEvidence,
  type AttemptStoreOptions,
} from './attempt-store.ts';

export {
  recordExecution,
  recordExecutions,
  recordReview,
  type ExecutionEvidenceInput,
} from './attempt-integration.ts';

// P6-D0: structured review verdict + bounded same-agent rework.
// The verdict is evidence; task state still moves only through applyVerification.
export {
  REVIEW_VERDICTS,
  RECOMMENDED_ACTIONS,
  D0_EXECUTABLE_ACTIONS,
  SEVERITIES,
  REVIEW_OUTPUT_CONTRACT,
  ReviewVerdictError,
  isReviewVerdictError,
  validateReviewVerdict,
  fingerprintVerdict,
  normalizeReviewOutput,
  parseReviewOutput,
  reviewInstructions,
  toReviewEvidence,
  type ReviewVerdict,
  type ReviewVerdictValue,
  type ReviewFinding,
  type ReviewEvidence,
  type RecommendedAction,
  type Severity,
} from './review-verdict.ts';

export {
  DEFAULT_REWORK_POLICY,
  applyReviewVerdict,
  prepareRework,
  toVerificationOutcome,
  toReworkDecision,
  validateReworkDecision,
  type ReviewOutcome,
  type ReworkPolicy,
  type ReworkStop,
  type ReworkReentry,
  type ReworkAuthority,
  type VerificationAuthority,
  type TaskSchedulerLike,
} from './review-loop.ts';

export {
  EXECUTION_OUTCOMES,
  DEFAULT_TEXT_TAIL_CHARS,
  REVIEW_STATUSES,
  buildReviewPacket,
  buildUnifiedRoundReport,
  classifyExecutionOutcome,
  renderReviewPacket,
  renderUnifiedRoundReport,
  runUnifiedReview,
  tailText,
  type BoundedText,
  type BuildPacketInput,
  type ClassifyInput,
  type ExecutionOutcome,
  type ExecutionOutcomeKind,
  type NativeReviewer,
  type ReviewPacket,
  type ReviewPacketTask,
  type RunUnifiedReviewOptions,
  type UnifiedReviewResult,
  type UnifiedReviewStatus,
  type UnifiedRoundReport,
} from './unified-review.ts';

// R4 — Result Aggregation + Human Gate. A pure READ/DERIVE projection: it exports no
// authority and no way to dispatch, decide or move a task.
export {
  HUMAN_GATE_STATUSES,
  IN_FLIGHT_STATUSES,
  TASK_LIFECYCLE_CLASS,
  buildRoundResult,
  classifyTaskLifecycle,
  deriveHumanGate,
  gateWithUserDecision,
  isBlockingStatus,
  isExecutableTask,
  renderRoundResult,
  sealNextRoundInput,
  type AttemptEvidenceInput,
  type AttemptSummary,
  type BuildRoundResultInput,
  type DeriveHumanGateInput,
  type HandoffSummary,
  type HumanGate,
  type HumanGateOption,
  type HumanGateStatus,
  type NextRoundInput,
  type NextRoundMode,
  type NextRoundTaskLineage,
  type ReviewSummary,
  type RoundIdentity,
  type RoundPlanSummary,
  type RoundResult,
  type SealNextRoundInputOptions,
  type TaskEvidenceInput,
  type TaskLifecycleClass,
  type TaskSummary,
} from './round-result.ts';

export {
  defaultRoundResultPath,
  publishRoundResult,
  readRoundResult,
  type PublishRoundResultOutcome,
} from './round-observation.ts';

export {
  DEFAULT_HANDOFF_POLICY,
  HANDOFF_REASONS,
  buildContinuationPacket,
  classifyHandoffReason,
  evaluateHandoffBudget,
  renderContinuationPacket,
  runHandoffContinuation,
  type ContinuationCycleResult,
  type ContinuationDeps,
  type ContinuationPacket,
  type ContinuationResult,
  type ContinuationWork,
  type HandoffClassification,
  type HandoffPolicy,
  type HandoffReason,
  type HandoffRecord,
  type HandoffStopCode,
  type WorkSource,
} from './continuation.ts';

// P6-A: the orchestration state loop.
// Observation is a read-only view over TaskStore; the decision union is frozen
// here with only continue/wait/abort implemented; validation throws rather than
// guessing. Nothing in this group writes task state or starts an agent.
export {
  observeTasks,
  toDecisionState,
  type TaskObservation,
  type ObservedTask,
  type ObservedResult,
  type ObserveOptions,
} from './observation.ts';

export {
  IMPLEMENTED_ACTIONS,
  DEFERRED_ACTIONS,
  ALL_ACTIONS,
  DecisionValidationError,
  isDecisionValidationError,
  validateDecision,
  applyDecision,
  type DecisionAction,
  type ImplementedAction,
  type DeferredAction,
  type OrchestrationDecision,
  type DecisionApplication,
  type DecisionApplicationContext,
} from './decision.ts';

export {
  ORCHESTRATION_ACTION_ID,
  CYCLE_IMPLEMENTED_ACTIONS,
  orchestrationDecisionRequest,
  extractAction,
  runDecisionCycle,
  // P6-D1: the full eleven-action answer space, offered to the provider as criteria.
  ACTION_CRITERIA,
  type DecisionOutcome,
  type DecisionLoopOptions,
  type OrchestrationDecisionRequestOptions,
} from './decision-loop.ts';

// P6-F: the code-level free model pool.
export {
  ACTIVE_FREE_MODEL_POOL,
  DEFAULT_REVIEWER,
  EXCLUDED_FROM_FREE_POOL,
  isAllowedModel,
  isInFreeModelPool,
  intersectWithFreePool,
  listFreeModelPool,
  type FreeModelPoolEntry,
  type FreeEvidence,
  type ModelPoolVerdict,
} from './model-pool.ts';

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

// Workbench refactor: sessions, handoffs, planning and the coordinator.
export {
  SessionRegistry,
  SessionRegistryError,
  toExecutionTarget,
  DEFAULT_SESSION_INTENT,
  type ExecutionTarget,
  type SessionIntent,
  type WorkbenchSession,
} from './workbench-sessions.ts';

// TeamRun T1-b: Worker identity is a PROJECTION over the authorities above — the pair
// Assignment chose plus the session SessionRegistry resolved. Exported next to them so a
// consumer is never tempted to treat it as an authority of its own.
export {
  workerIdentity,
  workerKeyOf,
  sameWorker,
  distinctWorkers,
  workerIdentityOfSession,
  workerIdentityOfAttempt,
  type WorkerIdentity,
  type WorkerProjection,
} from './worker-identity.ts';

// P6-D1: the dynamic decision loop, and the migration path it uses. Both are
// compositions of authorities that already existed - nothing here is a new engine.
// P6-D1 adds `ACTION_CRITERIA` to the loop's own export block below - the loop
// exports were already re-exported here by P6-A, so only the new constant is added
// there rather than declaring a second block for the same module.
export {
  applyMigration,
  type MigrationApplied,
} from './assignment-wiring.ts';

export {
  buildHandoff,
  buildTaskBrief,
  type TaskHandoff,
} from './workbench-handoff.ts';

export {
  planFromSpec,
  shapeForComplexity,
  workKindToTaskType,
  type WorkbenchTaskSpec,
  type PlanFromSpecResult,
} from './workbench-plan.ts';

export {
  NativeWorkbench,
  type WorkbenchOptions,
  type PlanOutcome,
  type AssignOutcome,
  type DispatchOutcome,
  type TaskIntent,
  type DecisionWiringOptions,
  type DecisionCapabilities,
} from './workbench.ts';
