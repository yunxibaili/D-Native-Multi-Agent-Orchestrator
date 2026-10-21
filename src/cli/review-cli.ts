/**
 * src/cli/review-cli.ts - review ONE caller-supplied ReviewPacket.
 *
 * This is a narrow entry, not a second review runtime. It validates an imported
 * ReviewPacket JSON file, then calls the EXISTING `runUnifiedReview` exactly once
 * through the EXISTING `runtime.review` seam. No adapter, scheduler, TaskStore or
 * final-output logic lives here.
 *
 * The imported packet is caller-supplied HISTORICAL evidence. Validation proves its
 * shape and internal identity only; it does not authenticate who produced it and it
 * does not replay a round. The report says so, so an imported review can never read
 * as a fresh end-to-end execution.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from 'node:fs';
import { resolve } from 'node:path';
import type { RunHandle, RunRequest } from '../core/types.ts';
import type { CompletionTestEvidenceView } from '../orchestration/completion-evidence.ts';
import { TASK_STATUSES } from '../orchestration/task.ts';
import {
  EXECUTION_OUTCOMES,
  runUnifiedReview,
  type BoundedText,
  type ExecutionOutcome,
  type ExecutionOutcomeKind,
  type NativeReviewer,
  type ReviewPacket,
  type ReviewPacketTask,
  type UnifiedReviewResult,
  type UnifiedReviewStatus,
} from '../orchestration/unified-review.ts';
import type { TaskHandoff } from '../orchestration/workbench-handoff.ts';
import { TASK_TYPES } from '../quota/types.ts';

const REVIEW_AGENT = 'codex';
const REVIEW_MODEL = 'gpt-6.1-sol';
const MAX_PACKET_BYTES = 1024 * 1024;
const MAX_REVIEW_TIMEOUT_MS = 90_000;
const DEFAULT_REVIEW_TIMEOUT_MS = 90_000;

const RUN_RESULT_STATES = ['succeeded', 'failed', 'cancelled', 'timed_out'] as const;

const PROVENANCE =
  'This packet is caller-supplied historical evidence imported from the file named above. ' +
  'Only its shape and internal identity were validated; it was NOT independently authenticated, ' +
  'replayed, or correlated with any Round, Task, Attempt, or Human Gate store. This report is an ' +
  'independent Codex review of the supplied packet, not a fresh full end-to-end round and not a ' +
  'product PASS.';

type Rec = Record<string, unknown>;

export interface PacketReviewRuntime {
  /** The reviewer's configured model, reused when `--model` is omitted. */
  readonly configuredModel?: string;
  /** The EXISTING native review seam. */
  readonly review: (req: Omit<RunRequest, 'mode'>) => RunHandle;
}

export interface PacketReviewInput {
  readonly agent: string;
  readonly packetPath?: string;
  readonly cwd: string;
  /** Positionals after the agent; any prompt here is refused on the packet path. */
  readonly extraPositionals?: readonly string[];
  readonly extraArgProvided?: boolean;
  readonly roleProvided?: boolean;
  readonly sandboxProvided?: boolean;
  readonly model?: string | boolean;
  readonly timeout?: string | number | boolean;
  readonly now?: () => number;
}

export interface PacketReviewReport {
  readonly command: 'review --packet';
  readonly status: 'reviewed' | 'rejected';
  readonly source: 'imported-packet';
  readonly roundId: string | null;
  readonly input: { readonly path: string; readonly sha256: string | null };
  readonly provenance: string;
  readonly automaticPostRoundAction: 'none';
  readonly review: {
    readonly status: UnifiedReviewStatus;
    readonly reviewer: string;
    readonly verdict: string | null;
    readonly reason: string | null;
    readonly findings: UnifiedReviewResult['findings'];
    readonly recommendations: readonly string[];
    readonly code: string | null;
  } | null;
  readonly error: { readonly code: string; readonly message: string } | null;
}

export interface PacketReviewCliResult {
  readonly exitCode: number;
  readonly report: PacketReviewReport;
}

interface PacketSource {
  readonly path: string;
  sha256: string | null;
  roundId: string | null;
}

function fail(path: string, detail: string): never {
  throw new Error(`${path}: ${detail}`);
}

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function has(rec: Rec, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(rec, key);
}

function record(value: unknown, path: string): Rec {
  if (!isRecord(value)) fail(path, 'must be an object');
  return value;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  return value;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'must be a string');
  return value;
}

function nonEmptyText(value: unknown, path: string): string {
  const s = text(value, path);
  if (s.trim() === '') fail(path, 'must be a non-empty string');
  return s;
}

function nullableText(value: unknown, path: string): string | null {
  if (value === null) return null;
  return text(value, path);
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'must be a boolean');
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be a finite number');
  return value;
}

function integer(value: unknown, path: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    fail(path, `must be an integer >= ${minimum}`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(path, `must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function stringArray(value: unknown, path: string): string[] {
  const values = array(value, path);
  return values.map((entry, index) => text(entry, `${path}[${index}]`));
}

function boundedText(value: unknown, path: string): BoundedText {
  const rec = record(value, path);
  const body = text(rec.text, `${path}.text`);
  const truncated = boolean(rec.truncated, `${path}.truncated`);
  const originalLength = integer(rec.originalLength, `${path}.originalLength`, 0);
  if (truncated) {
    if (originalLength <= body.length) {
      fail(`${path}.originalLength`, 'a truncated text must be shorter than its original length');
    }
  } else if (originalLength !== body.length) {
    fail(`${path}.originalLength`, 'an untruncated text must report its exact length');
  }
  return { text: body, truncated, originalLength };
}

function nullableBoundedText(value: unknown, path: string): BoundedText | null {
  if (value === null) return null;
  return boundedText(value, path);
}

function expectArtifacts(value: unknown, path: string): readonly { name: string; path: string }[] {
  return array(value, path).map((entry, index) => {
    const rec = record(entry, `${path}[${index}]`);
    return {
      name: text(rec.name, `${path}[${index}].name`),
      path: text(rec.path, `${path}[${index}].path`),
    };
  });
}

function expectHandoff(
  value: unknown,
  path: string,
  taskId: string,
  taskType: string,
): TaskHandoff | null {
  if (value === null) return null;
  const rec = record(value, path);
  const handoffTaskId = nonEmptyText(rec.taskId, `${path}.taskId`);
  if (handoffTaskId !== taskId) {
    fail(`${path}.taskId`, `does not match the task identity ${taskId}`);
  }
  const handoffTaskType = enumValue(rec.taskType, TASK_TYPES, `${path}.taskType`);
  if (handoffTaskType !== taskType) {
    fail(`${path}.taskType`, `does not match the task type ${taskType}`);
  }
  text(rec.objective, `${path}.objective`);
  enumValue(rec.status, TASK_STATUSES, `${path}.status`);
  if (!has(rec, 'runState')) fail(`${path}.runState`, 'is required (null when no run exists)');
  if (rec.runState !== null) enumValue(rec.runState, RUN_RESULT_STATES, `${path}.runState`);
  expectArtifacts(rec.artifacts, `${path}.artifacts`);
  if (!has(rec, 'completedWork')) fail(`${path}.completedWork`, 'is required (null when absent)');
  nullableText(rec.completedWork, `${path}.completedWork`);
  if (rec.error !== null) {
    const error = record(rec.error, `${path}.error`);
    text(error.code, `${path}.error.code`);
    text(error.message, `${path}.error.message`);
  }
  if (!has(rec, 'transcriptPath')) fail(`${path}.transcriptPath`, 'is required (null when absent)');
  nullableText(rec.transcriptPath, `${path}.transcriptPath`);
  if (!has(rec, 'changedFiles')) fail(`${path}.changedFiles`, 'is required');
  stringArray(rec.changedFiles, `${path}.changedFiles`);
  if (!has(rec, 'testsRun')) fail(`${path}.testsRun`, 'is required');
  stringArray(rec.testsRun, `${path}.testsRun`);
  if (!has(rec, 'decisions')) fail(`${path}.decisions`, 'is required (null when absent)');
  nullableText(rec.decisions, `${path}.decisions`);
  if (!has(rec, 'unresolved')) fail(`${path}.unresolved`, 'is required');
  stringArray(rec.unresolved, `${path}.unresolved`);
  return rec as unknown as TaskHandoff;
}

function expectApprovedTest(
  value: unknown,
  path: string,
  task: {
    readonly taskId: string;
    readonly executed: boolean;
    readonly agentId: string | null;
    readonly modelId: string | null;
    readonly attemptIds: readonly string[];
    readonly leaseVersion: number | null;
  },
): CompletionTestEvidenceView {
  const rec = record(value, path);
  const taskId = nonEmptyText(rec.taskId, `${path}.taskId`);
  if (taskId !== task.taskId) fail(`${path}.taskId`, `does not match the task identity ${task.taskId}`);
  if (!task.executed) fail(path, 'an approved test cannot belong to a task that did not execute');
  const attemptId = nonEmptyText(rec.attemptId, `${path}.attemptId`);
  if (!task.attemptIds.includes(attemptId)) {
    fail(`${path}.attemptId`, `is not one of the task's recorded attempts`);
  }
  const leaseVersion = integer(rec.leaseVersion, `${path}.leaseVersion`, 0);
  if (task.leaseVersion !== null && leaseVersion !== task.leaseVersion) {
    fail(`${path}.leaseVersion`, `does not match the task lease version ${task.leaseVersion}`);
  }
  const agentId = nonEmptyText(rec.agentId, `${path}.agentId`);
  if (task.agentId === null) fail(`${path}.agentId`, 'requires an actual agent on the task');
  if (agentId !== task.agentId) fail(`${path}.agentId`, `does not match the task agent ${task.agentId}`);
  const modelId = nullableText(rec.modelId, `${path}.modelId`);
  if (task.modelId !== null && modelId !== task.modelId) {
    fail(`${path}.modelId`, `does not match the task model ${task.modelId}`);
  }
  nullableText(rec.sessionId, `${path}.sessionId`);
  nonEmptyText(rec.runFingerprint, `${path}.runFingerprint`);
  nonEmptyText(rec.contractDigest, `${path}.contractDigest`);
  finiteNumber(rec.validatedAt, `${path}.validatedAt`);
  const test = record(rec.test, `${path}.test`);
  nonEmptyText(test.executable, `${path}.test.executable`);
  stringArray(test.argv, `${path}.test.argv`);
  nonEmptyText(test.cwd, `${path}.test.cwd`);
  if (test.code !== null) integer(test.code, `${path}.test.code`, 0);
  nullableText(test.signal, `${path}.test.signal`);
  boolean(test.timedOut, `${path}.test.timedOut`);
  boolean(test.treeStopConfirmed, `${path}.test.treeStopConfirmed`);
  boolean(test.mayHaveStarted, `${path}.test.mayHaveStarted`);
  nonEmptyText(test.outputDigest, `${path}.test.outputDigest`);
  text(test.note, `${path}.test.note`);
  return rec as unknown as CompletionTestEvidenceView;
}

function expectTask(value: unknown, path: string): ReviewPacketTask {
  const rec = record(value, path);
  const taskId = nonEmptyText(rec.taskId, `${path}.taskId`);
  const taskType = enumValue(rec.taskType, TASK_TYPES, `${path}.taskType`);
  const status = enumValue(rec.status, TASK_STATUSES, `${path}.status`);
  const agentId = nullableText(rec.agentId, `${path}.agentId`);
  const modelId = nullableText(rec.modelId, `${path}.modelId`);
  const outcome = enumValue(rec.outcome, EXECUTION_OUTCOMES, `${path}.outcome`);
  const executed = boolean(rec.executed, `${path}.executed`);
  if (!has(rec, 'prompt')) fail(`${path}.prompt`, 'is required (null when none was recorded)');
  const prompt = nullableBoundedText(rec.prompt, `${path}.prompt`);
  if (!has(rec, 'handoff')) fail(`${path}.handoff`, 'is required (null when no run exists)');
  const handoff = expectHandoff(rec.handoff, `${path}.handoff`, taskId, taskType);
  const attemptIds = stringArray(rec.attemptIds, `${path}.attemptIds`);
  const leaseVersion = rec.leaseVersion === null
    ? null
    : integer(rec.leaseVersion, `${path}.leaseVersion`, 0);
  const errorCode = nullableText(rec.errorCode, `${path}.errorCode`);
  const errorMessage = nullableText(rec.errorMessage, `${path}.errorMessage`);

  const approvedTest = has(rec, 'approvedTest') && rec.approvedTest !== null
    ? expectApprovedTest(rec.approvedTest, `${path}.approvedTest`, {
      taskId, executed, agentId, modelId, attemptIds, leaseVersion,
    })
    : rec.approvedTest === null
      ? null
      : undefined;

  const requestedAgentId = has(rec, 'requestedAgentId')
    ? nullableText(rec.requestedAgentId, `${path}.requestedAgentId`)
    : undefined;
  const requestedModelId = has(rec, 'requestedModelId')
    ? nullableText(rec.requestedModelId, `${path}.requestedModelId`)
    : undefined;
  const memberIndex = has(rec, 'memberIndex')
    ? integer(rec.memberIndex, `${path}.memberIndex`, 0)
    : undefined;
  const assignmentStatus = has(rec, 'assignmentStatus')
    ? enumValue(rec.assignmentStatus, ['accepted', 'refused'] as const, `${path}.assignmentStatus`)
    : undefined;
  const assignmentRefusalReason = has(rec, 'assignmentRefusalReason')
    ? nullableText(rec.assignmentRefusalReason, `${path}.assignmentRefusalReason`)
    : undefined;

  return {
    taskId,
    taskType,
    status,
    agentId,
    modelId,
    outcome,
    executed,
    prompt,
    handoff,
    ...(approvedTest === undefined ? {} : { approvedTest }),
    attemptIds,
    leaseVersion,
    errorCode,
    errorMessage,
    ...(requestedAgentId === undefined ? {} : { requestedAgentId }),
    ...(requestedModelId === undefined ? {} : { requestedModelId }),
    ...(memberIndex === undefined ? {} : { memberIndex }),
    ...(assignmentStatus === undefined ? {} : { assignmentStatus }),
    ...(assignmentRefusalReason === undefined ? {} : { assignmentRefusalReason }),
  };
}

function expectOutcome(value: unknown, path: string): ExecutionOutcome {
  const rec = record(value, path);
  return {
    taskId: nonEmptyText(rec.taskId, `${path}.taskId`),
    outcome: enumValue<ExecutionOutcomeKind>(rec.outcome, EXECUTION_OUTCOMES, `${path}.outcome`),
    taskStatus: enumValue(rec.taskStatus, TASK_STATUSES, `${path}.taskStatus`),
    code: nullableText(rec.code, `${path}.code`),
    reason: nullableText(rec.reason, `${path}.reason`),
    agentId: nullableText(rec.agentId, `${path}.agentId`),
    modelId: nullableText(rec.modelId, `${path}.modelId`),
    executed: boolean(rec.executed, `${path}.executed`),
    refused: boolean(rec.refused, `${path}.refused`),
    attemptIds: stringArray(rec.attemptIds, `${path}.attemptIds`),
  };
}

function uniqueTaskIds(items: readonly { readonly taskId: string }[], path: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.taskId)) fail(path, `contains duplicate taskId ${item.taskId}`);
    seen.add(item.taskId);
  }
}

function validateReviewPacket(value: unknown): ReviewPacket {
  const rec = record(value, 'packet');
  const roundId = nonEmptyText(rec.roundId, 'packet.roundId');
  const originalRequest = nonEmptyText(rec.originalRequest, 'packet.originalRequest');
  if (!has(rec, 'layaPlan')) fail('packet.layaPlan', 'is required (null when no plan was recorded)');
  const layaPlan = nullableBoundedText(rec.layaPlan, 'packet.layaPlan');
  const tasks = array(rec.tasks, 'packet.tasks').map((entry, index) =>
    expectTask(entry, `packet.tasks[${index}]`));
  uniqueTaskIds(tasks, 'packet.tasks');
  const executionOutcomes = array(rec.executionOutcomes, 'packet.executionOutcomes').map((entry, index) =>
    expectOutcome(entry, `packet.executionOutcomes[${index}]`));
  uniqueTaskIds(executionOutcomes, 'packet.executionOutcomes');
  const errors = stringArray(rec.errors, 'packet.errors');
  const quotaSignals = stringArray(rec.quotaSignals, 'packet.quotaSignals');
  const resourceSignals = stringArray(rec.resourceSignals, 'packet.resourceSignals');
  const evidenceNote = nonEmptyText(rec.evidenceNote, 'packet.evidenceNote');
  return {
    roundId,
    originalRequest,
    layaPlan,
    tasks,
    executionOutcomes,
    errors,
    quotaSignals,
    resourceSignals,
    evidenceNote,
  };
}

function sameFileIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
}

function unchangedFile(a: BigIntStats, b: BigIntStats): boolean {
  return sameFileIdentity(a, b) && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/**
 * Read ONE caller-named packet file without ever allocating more than the cap.
 *
 * The size is checked on the OPENED descriptor before the buffer exists, and the
 * bytes come from a bounded `readSync` loop, so a file that grows between the
 * name check and the read cannot force an oversized allocation. The opened
 * descriptor's identity/size/mtime/ctime are compared before and after reading;
 * a replaced or mutated file is rejected instead of half-trusted.
 */
function readPacketBytes(packetPath: string): Buffer {
  const named = lstatSync(packetPath, { bigint: true });
  if (!named.isFile()) fail('--packet', `is not a regular file: ${packetPath}`);
  if (named.size <= 0) fail('--packet', `file is empty: ${packetPath}`);
  if (named.size > BigInt(MAX_PACKET_BYTES)) {
    fail('--packet', `file exceeds the ${MAX_PACKET_BYTES}-byte limit: ${packetPath}`);
  }
  const fd = openSync(packetPath, 'r');
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!unchangedFile(named, opened)) {
      fail('--packet', `file changed while opening it: ${packetPath}`);
    }
    if (opened.size <= 0) fail('--packet', `file is empty: ${packetPath}`);
    if (opened.size > BigInt(MAX_PACKET_BYTES)) {
      fail('--packet', `file exceeds the ${MAX_PACKET_BYTES}-byte limit: ${packetPath}`);
    }
    const bytes = Buffer.alloc(MAX_PACKET_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size <= 0 || size > MAX_PACKET_BYTES || BigInt(size) !== opened.size) {
      fail('--packet', `file is empty or exceeds the ${MAX_PACKET_BYTES}-byte limit: ${packetPath}`);
    }
    if (!unchangedFile(opened, fstatSync(fd, { bigint: true })) ||
        !unchangedFile(named, lstatSync(packetPath, { bigint: true }))) {
      fail('--packet', `file changed while reading it: ${packetPath}`);
    }
    return bytes.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}

function loadPacket(packetPath: string | undefined): {
  readonly source: PacketSource;
  readonly packet: ReviewPacket | null;
  readonly error: string | null;
} {
  const source: PacketSource = {
    path: typeof packetPath === 'string' ? resolve(packetPath) : '',
    sha256: null,
    roundId: null,
  };
  try {
    if (typeof packetPath !== 'string' || packetPath.trim() === '') {
      fail('--packet', 'requires an existing ReviewPacket JSON path');
    }
    if (!existsSync(source.path)) fail('--packet', `file does not exist: ${source.path}`);
    const bytes = readPacketBytes(source.path);
    source.sha256 = createHash('sha256').update(bytes).digest('hex');
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      fail('--packet', 'file is not valid UTF-8');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(decoded);
    } catch (e) {
      fail('--packet', `file is not valid JSON: ${(e as Error).message}`);
    }
    if (isRecord(raw) && typeof raw.roundId === 'string' && raw.roundId.trim() !== '') {
      source.roundId = raw.roundId;
    }
    const packet = validateReviewPacket(raw);
    source.roundId = packet.roundId;
    return { source, packet, error: null };
  } catch (e) {
    return { source, packet: null, error: (e as Error).message };
  }
}

function resolveModel(raw: string | boolean | undefined, configured: string | undefined): string {
  if (raw === true) fail('--model', 'requires a value');
  if (typeof raw === 'string' && raw !== REVIEW_MODEL) {
    fail('--model', `the packet path supports only ${REVIEW_MODEL}, got ${raw}`);
  }
  const effective = typeof raw === 'string' ? raw : configured ?? REVIEW_MODEL;
  if (effective !== REVIEW_MODEL) {
    fail('--model', `the configured reviewer model is ${effective}; the packet path supports only ${REVIEW_MODEL}`);
  }
  return effective;
}

function resolveTimeout(raw: string | number | boolean | undefined): number {
  if (raw === undefined) return DEFAULT_REVIEW_TIMEOUT_MS;
  if (raw === true) fail('--timeout', 'requires a value');
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > MAX_REVIEW_TIMEOUT_MS) {
    fail('--timeout', `must be an integer in 1..${MAX_REVIEW_TIMEOUT_MS} ms`);
  }
  return n;
}

function checkInvocation(input: PacketReviewInput): void {
  if (input.agent !== REVIEW_AGENT) {
    fail('review', `the packet path supports only agent ${REVIEW_AGENT}`);
  }
  if (input.extraPositionals !== undefined && input.extraPositionals.length > 0) {
    fail('review', 'a prompt is not accepted together with --packet');
  }
  if (input.extraArgProvided === true) fail('--extra', 'is not accepted with --packet');
  if (input.roleProvided === true) fail('--role', 'is not accepted with --packet');
  if (input.sandboxProvided === true) fail('--sandbox', 'is not accepted with --packet');
  if (typeof input.cwd !== 'string' || input.cwd.trim() === '') {
    fail('--cwd', 'requires a working directory');
  }
  if (!existsSync(input.cwd)) fail('--cwd', `directory does not exist: ${input.cwd}`);
  if (!lstatSync(input.cwd).isDirectory()) fail('--cwd', `is not a directory: ${input.cwd}`);
}

function baseReport(source: PacketSource): Omit<PacketReviewReport, 'status' | 'review' | 'error'> {
  return {
    command: 'review --packet',
    source: 'imported-packet',
    roundId: source.roundId,
    input: { path: source.path, sha256: source.sha256 },
    provenance: PROVENANCE,
    automaticPostRoundAction: 'none',
  };
}

function rejected(
  source: PacketSource,
  code: string,
  message: string,
): PacketReviewCliResult {
  return {
    exitCode: 1,
    report: {
      ...baseReport(source),
      status: 'rejected',
      review: null,
      error: { code, message },
    },
  };
}

/**
 * Validate the packet and its invocation, then run the ONE existing unified review.
 *
 * Everything that can reject the request happens before `runUnifiedReview`, so a
 * malformed packet or an unsafe override never reaches native dispatch.
 */
export async function runReviewPacket(
  runtime: PacketReviewRuntime,
  input: PacketReviewInput,
): Promise<PacketReviewCliResult> {
  const loaded = loadPacket(input.packetPath);
  const { source } = loaded;
  if (loaded.error !== null || loaded.packet === null) {
    return rejected(source, 'packet-invalid', loaded.error ?? 'the packet could not be loaded');
  }

  let effectiveModel: string;
  let timeoutMs: number;
  try {
    checkInvocation(input);
    effectiveModel = resolveModel(input.model, runtime.configuredModel);
    timeoutMs = resolveTimeout(input.timeout);
  } catch (e) {
    return rejected(source, 'review-invocation-invalid', (e as Error).message);
  }

  // Add the TRUSTED runtime timeout as the last request field. The `timeoutMs`
  // passed to runUnifiedReview below is only its wait deadline; without this the
  // native request would still carry whatever deadline the runtime defaults to.
  const reviewer: NativeReviewer = {
    review(req) {
      return runtime.review({ ...req, timeoutMs });
    },
  };

  let unified: UnifiedReviewResult;
  try {
    unified = await runUnifiedReview(reviewer, loaded.packet, {
      reviewer: REVIEW_AGENT,
      modelId: effectiveModel,
      cwd: input.cwd,
      now: input.now ?? (() => Date.now()),
      timeoutMs,
    });
  } catch (e) {
    return rejected(source, 'review-threw', `the review step threw: ${(e as Error).message}`);
  }

  const passed = unified.status === 'completed' && unified.verdict?.verdict === 'pass';
  return {
    exitCode: passed ? 0 : 1,
    report: {
      ...baseReport(source),
      status: 'reviewed',
      review: {
        status: unified.status,
        reviewer: unified.reviewer,
        verdict: unified.verdict === null ? null : unified.verdict.verdict,
        reason: unified.reason,
        findings: unified.findings,
        recommendations: unified.recommendations,
        code: unified.code,
      },
      error: null,
    },
  };
}

export function formatPacketReviewReport(report: PacketReviewReport, asJson: boolean): string {
  if (asJson) return JSON.stringify(report, null, 2);
  const lines: string[] = [];
  lines.push(`review --packet ${report.roundId ?? '(unknown round)'}`);
  lines.push(`  source   ${report.input.path}`);
  lines.push(`  sha256   ${report.input.sha256 ?? '(not read)'}`);
  lines.push(`  status   ${report.status}`);
  if (report.error !== null) lines.push(`  error    ${report.error.code}: ${report.error.message}`);
  if (report.review !== null) {
    lines.push(`  review   ${report.review.status} (${report.review.reviewer})`);
    if (report.review.verdict !== null) lines.push(`  verdict  ${report.review.verdict}`);
    if (report.review.reason !== null) lines.push(`  reason   ${report.review.reason}`);
    for (const f of report.review.findings) lines.push(`  finding  [${f.severity}] ${f.location}: ${f.message}`);
  }
  lines.push(`  next     ${report.automaticPostRoundAction} (nothing was re-run automatically)`);
  lines.push('');
  lines.push(report.provenance);
  return lines.join('\n');
}
