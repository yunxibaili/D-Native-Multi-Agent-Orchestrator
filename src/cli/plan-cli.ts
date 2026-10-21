/**
 * cli/plan-cli.ts — prepare an UNAPPROVED plan-file draft.
 *
 * This is a narrow preparation entry, not a round, a planner and not a second
 * execution authority. It asks ONE explicitly requested native agent for 2–3
 * short sequential candidates, validates the COMPLETE response through the
 * existing external PlanFile parser, and returns the draft. It never selects a
 * plan, commits a task, calls LAYA, executes a proposed test, writes a plan or
 * source file, or creates approval / confirmation / stage material.
 *
 * The generated test commands and scopes are proposals only. They are not
 * approved and are never run here. Agent tool use remains governed by the
 * existing native permissions; this command is not an OS read-only sandbox.
 */

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RunHandle, RunRequest, RunResult } from '../core/types.ts';
import {
  isPlanFileError,
  isSequentialPlan,
  parsePlanFile,
  PLAN_FILE_MAX_BYTES,
  PLAN_FILE_MAX_STEPS,
  PLAN_FILE_MAX_TEXT,
  type PlanFile,
  type PlanFileStep,
} from '../orchestration/plan-file.ts';

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_TIMEOUT_MS = 90_000;
const MIN_CANDIDATE_PLANS = 2;
const MAX_CANDIDATE_PLANS = 3;

const ALLOWED_FLAGS = new Set(['json', 'model', 'cwd', 'timeout', 'config', 'log-level', 'help']);

const PROVENANCE =
  'A "draft" result means one native run returned complete JSON that the existing PlanFile parser ' +
  'accepted; a "rejected" result means no valid draft was accepted and the native attempt may ' +
  'still have run and produced no usable output. Either way this CLI itself does not dispatch plan ' +
  'tasks, write plan or source files, or run proposed tests. Native tool use remains under the ' +
  'existing agent permissions (this is a cooperative instruction, not an OS read-only sandbox), ' +
  'and native side effects are not independently verified or certified here. The requested model ' +
  'is not independently verified, absent usage is not cost=0, and this is not a Round PASS or ' +
  'Owner approval.';

export type PlanFlagValue = string | boolean | string[];

export interface PlanPrepareRuntime {
  /** The agent's configured model, reused only when `--model` is omitted. */
  readonly configuredModel?: string;
  /** The agent's configured cwd, reused only when `--cwd` is omitted. */
  readonly configuredCwd?: string;
  /** The EXISTING runtime.run seam. Called exactly once, with one fresh session. */
  readonly run: (req: RunRequest) => RunHandle;
}

export interface PlanPrepareInput {
  readonly agent: string;
  readonly objective: string;
  /** Parsed flags, including their raw shapes, so ambiguous values can be refused. */
  readonly flags: Readonly<Record<string, PlanFlagValue>>;
  /** Any positionals after the objective. The command accepts exactly two. */
  readonly extraPositionals?: readonly string[];
}

export interface PlanRuntimeEvidence {
  readonly taskId: string;
  readonly threadId: string | null;
  readonly state: RunResult['state'];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly outputTruncated: boolean;
  readonly cleanup: {
    readonly rootKilled: boolean;
    readonly descendantsReaped: boolean;
    readonly treeStopConfirmed: boolean;
    readonly processStart: RunResult['cleanup']['processStart'];
    readonly note: string;
  };
}

export interface PlanDraftStep {
  readonly role: string;
  readonly taskType: PlanFileStep['taskType'];
  readonly fileScope?: string;
  readonly deliverable: string;
  readonly dependencies?: readonly string[];
  readonly expectedArtifacts?: readonly string[];
  readonly allowedScope?: readonly string[];
  readonly test?: {
    readonly executable: string;
    readonly argv: readonly string[];
    readonly cwd: string;
  };
}

export interface PlanDraftPlan {
  readonly id: string;
  readonly label: string;
  readonly steps: readonly PlanDraftStep[];
}

export interface PlanDraftFile {
  readonly kind: 'sequential';
  readonly plans: readonly PlanDraftPlan[];
}

export interface PlanReport {
  readonly command: 'plan';
  readonly status: 'draft' | 'rejected';
  readonly source: 'model-generated';
  readonly requested: {
    readonly agent: string;
    readonly model: string | null;
  };
  readonly provenance: string;
  readonly runtime: PlanRuntimeEvidence | null;
  readonly planFile: PlanDraftFile | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly automaticPostRoundAction: 'none';
}

export interface PlanCliResult {
  readonly exitCode: number;
  readonly report: PlanReport;
}

class PlanRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PlanRefusal';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new PlanRefusal(code, message);
}

function requestedModel(
  flags: Readonly<Record<string, PlanFlagValue>>,
  configured: string | undefined,
): string | null {
  const raw = flags.model;
  if (typeof raw === 'string' && raw.trim() !== '') return raw;
  if (typeof configured === 'string' && configured.trim() !== '') return configured;
  return null;
}

function validateFlags(flags: Readonly<Record<string, PlanFlagValue>>): void {
  for (const key of Object.keys(flags)) {
    if (!ALLOWED_FLAGS.has(key)) {
      fail('plan-unsupported-flag', `--${key} is not supported by the plan preparation command`);
    }
  }
  const model = flags.model;
  if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) {
    fail('plan-invocation-invalid', '--model requires one non-empty value');
  }
  const cwd = flags.cwd;
  if (cwd !== undefined && (typeof cwd !== 'string' || cwd.trim() === '')) {
    fail('plan-invocation-invalid', '--cwd requires one non-empty directory value');
  }
  if (flags.timeout !== undefined && typeof flags.timeout !== 'string') {
    fail('plan-invocation-invalid', '--timeout requires one integer value');
  }
  if (flags.config !== undefined && (typeof flags.config !== 'string' || flags.config.trim() === '')) {
    fail('plan-invocation-invalid', '--config requires one non-empty path value');
  }
  if (flags['log-level'] !== undefined && (typeof flags['log-level'] !== 'string' || flags['log-level'].trim() === '')) {
    fail('plan-invocation-invalid', '--log-level requires one non-empty value');
  }
  if (flags.json !== undefined && flags.json !== true) {
    fail('plan-invocation-invalid', '--json is a flag and does not take a value');
  }
  if (flags.help !== undefined && flags.help !== true) {
    fail('plan-invocation-invalid', '--help is a flag and does not take a value');
  }
}

function resolveTimeout(raw: PlanFlagValue | undefined): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw.trim())) {
    fail('plan-invocation-invalid', `--timeout must be a positive integer in 1..${MAX_TIMEOUT_MS} ms`);
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    fail('plan-invocation-invalid', `--timeout must be a positive integer in 1..${MAX_TIMEOUT_MS} ms`);
  }
  return value;
}

function resolveCwd(raw: PlanFlagValue | undefined, configured: string | undefined): string {
  if (raw !== undefined && (typeof raw !== 'string' || raw.trim() === '')) {
    fail('plan-invocation-invalid', '--cwd requires one non-empty directory value');
  }
  const chosen =
    typeof raw === 'string'
      ? raw
      : typeof configured === 'string' && configured.trim() !== ''
        ? configured
        : process.cwd();
  const cwd = resolve(chosen);
  if (!existsSync(cwd)) fail('plan-invocation-invalid', `--cwd directory does not exist: ${cwd}`);
  let directory: boolean;
  try {
    directory = statSync(cwd).isDirectory();
  } catch (e) {
    fail('plan-invocation-invalid', `--cwd could not be inspected: ${(e as Error).message}`);
  }
  if (!directory) fail('plan-invocation-invalid', `--cwd is not a directory: ${cwd}`);
  return cwd;
}

function resolveModel(raw: PlanFlagValue | undefined, configured: string | undefined): string {
  if (raw !== undefined && (typeof raw !== 'string' || raw.trim() === '')) {
    fail('plan-invocation-invalid', '--model requires one non-empty value');
  }
  const effective = typeof raw === 'string' ? raw : configured;
  if (typeof effective !== 'string' || effective.trim() === '') {
    fail(
      'plan-invocation-invalid',
      '--model is required when the requested agent has no configured model; no provider is selected silently',
    );
  }
  return effective;
}

function buildPrompt(objective: string): string {
  return [
    'You generate candidate execution plans. Reply with EXACTLY ONE JSON object and nothing else.',
    'No markdown fences, no prose before or after it, no commentary.',
    'This is PROPOSAL GENERATION ONLY: do not use tools, do not read or modify workspace files, ' +
      'and do not execute commands or tests. Output the JSON only. (This is a cooperative ' +
      'instruction, not an enforced sandbox.)',
    '',
    'Required external shape:',
    '{"kind":"sequential","plans":[{"id":"...","label":"...","steps":[{"role":"...","taskType":"implementation|test|research|review","fileScope":"optional relative path","deliverable":"...","dependencies":["optional earlier role"],"expectedArtifacts":["relative/path"],"allowedScope":["relative/or/dir"],"test":{"executable":"...","argv":["..."],"cwd":"."}}]}]}',
    '',
    'Rules:',
    `- Produce ${MIN_CANDIDATE_PLANS} or ${MAX_CANDIDATE_PLANS} DISTINCT candidate plans under "plans"; use unique plan ids.`,
    `- Every plan is sequential and has 1-${PLAN_FILE_MAX_STEPS} steps. Keep the plans short and realistic.`,
    '- A role is a short responsibility label only; it does not select an agent or grant permission.',
    '- Include fileScope only when useful. dependencies may list earlier roles; omitted means no extra business dependency.',
    '- Every implementation or test step MUST include the COMPLETE actual completion contract: non-empty expectedArtifacts, non-empty allowedScope, and test with executable, argv and cwd.',
    '- Use real workspace-relative paths and real test commands implied by the objective. Never invent placeholders or fake filenames.',
    '- A test step may use explicit empty expectedArtifacts and allowedScope only when its command writes nothing durable. Otherwise both must be non-empty.',
    '- Research and review steps may omit completion fields. If any completion field is present, all three must be complete.',
    `- Keep every text value at or under ${PLAN_FILE_MAX_TEXT} characters. Use relative paths only: no drive letters, no leading slash, no "..", no reserved characters.`,
    '- The proposed test commands and scopes are UNAPPROVED. Do not claim they were approved or executed.',
    '- Do not include agent ids, model ids, credentials, approvals, confirmations, task ids, or any field not shown above.',
    `- The complete JSON must be valid UTF-8 and at most ${PLAN_FILE_MAX_BYTES} bytes.`,
    '',
    'Objective:',
    objective,
  ].join('\n');
}

function runtimeEvidence(result: RunResult): PlanRuntimeEvidence {
  return {
    taskId: result.taskId,
    threadId: result.threadId,
    state: result.state,
    exitCode: result.exitCode,
    signal: result.signal,
    outputTruncated: result.outputTruncated,
    cleanup: {
      rootKilled: result.cleanup.rootKilled,
      descendantsReaped: result.cleanup.descendantsReaped,
      treeStopConfirmed: result.cleanup.treeStopConfirmed,
      processStart: result.cleanup.processStart,
      note: result.cleanup.note,
    },
  };
}

function runRefusal(result: RunResult): string | null {
  if (result.state !== 'succeeded') return `the native run ended in state "${result.state}"`;
  if (result.exitCode !== 0) return `the native run did not exit 0 (exitCode=${String(result.exitCode)})`;
  if (result.signal !== null) return `the native run reported signal "${result.signal}"`;
  if (result.error !== null) return `the native run reported ${result.error.code}: ${result.error.message}`;
  if (result.outputTruncated) return 'the native output was truncated; a partial draft is refused';
  if (result.cleanup === undefined || result.cleanup.treeStopConfirmed !== true) {
    return 'the process-tree stop was not confirmed; the draft is not treated as complete';
  }
  return null;
}

/**
 * The parser turns the external flat completion fields into `step.completion`.
 * Never serialise that internal shape back out: rebuild the EXTERNAL PlanFile
 * vocabulary from the parser-approved values and detach it as a JSON value.
 */
function externalPlanFile(plan: PlanFile): PlanDraftFile {
  const plans: PlanDraftPlan[] = [];
  for (const candidate of plan.plans) {
    if (!isSequentialPlan(candidate)) fail('plan-kind-invalid', 'every candidate must be a sequential plan');
    const steps: PlanDraftStep[] = candidate.steps.map((step) => {
      const out: Record<string, unknown> = {
        role: step.role,
        taskType: step.taskType,
      };
      if (step.fileScope !== undefined) out.fileScope = step.fileScope;
      out.deliverable = step.deliverable;
      if (step.dependencies !== undefined) out.dependencies = [...step.dependencies];
      if (step.completion !== undefined) {
        out.expectedArtifacts = [...step.completion.expectedArtifacts];
        out.allowedScope = [...step.completion.allowedScope];
        out.test = {
          executable: step.completion.test.executable,
          argv: [...step.completion.test.argv],
          cwd: step.completion.test.cwd,
        };
      }
      return out as unknown as PlanDraftStep;
    });
    plans.push({ id: candidate.id, label: candidate.label, steps });
  }
  // A detached JSON value, built only from parser-approved external fields.
  return JSON.parse(JSON.stringify({ kind: 'sequential', plans })) as PlanDraftFile;
}

function rejected(
  code: string,
  message: string,
  requested: { readonly agent: string; readonly model: string | null },
  runtime: PlanRuntimeEvidence | null = null,
): PlanCliResult {
  return {
    exitCode: 1,
    report: {
      command: 'plan',
      status: 'rejected',
      source: 'model-generated',
      requested,
      provenance: PROVENANCE,
      runtime,
      planFile: null,
      error: { code, message },
      automaticPostRoundAction: 'none',
    },
  };
}

/**
 * Validate the invocation, ask ONE fresh native session for candidates, then
 * validate the COMPLETE output through the existing PlanFile parser.
 *
 * Nothing here can dispatch the draft, choose a plan, create stage material,
 * or execute a proposed test. Exit 0 only means a parser-valid draft exists.
 */
export async function runPlanPrepare(
  runtime: PlanPrepareRuntime,
  input: PlanPrepareInput,
): Promise<PlanCliResult> {
  const requested = {
    agent: input.agent.trim(),
    model: requestedModel(input.flags, runtime.configuredModel),
  };
  try {
    validateFlags(input.flags);
    if (input.extraPositionals !== undefined && input.extraPositionals.length > 0) {
      fail('plan-invocation-invalid', 'plan accepts exactly one agent and one objective');
    }
    if (requested.agent === '') fail('plan-invocation-invalid', 'plan requires a non-empty agent');
    const objective = input.objective.trim();
    if (objective === '') fail('plan-invocation-invalid', 'plan requires a non-empty objective');

    const effectiveModel = resolveModel(input.flags.model, runtime.configuredModel);
    requested.model = effectiveModel;
    const cwd = resolveCwd(input.flags.cwd, runtime.configuredCwd);
    const timeoutMs = resolveTimeout(input.flags.timeout);

    const req: RunRequest = {
      agentId: requested.agent,
      prompt: buildPrompt(objective),
      cwd,
      model: effectiveModel,
      mode: 'default',
      timeoutMs,
    };

    // ONE run, ONE fresh session: no threadId, retry, fallback or secondary model.
    let handle: RunHandle;
    try {
      handle = runtime.run(req);
    } catch (e) {
      return rejected('plan-run-refused', `the runtime refused the request: ${(e as Error).message}`, requested);
    }

    let result: RunResult;
    try {
      result = await handle.result();
    } catch (e) {
      return rejected('plan-run-threw', `the native run threw: ${(e as Error).message}`, requested);
    }

    const evidence = runtimeEvidence(result);
    const refusal = runRefusal(result);
    if (refusal !== null) return rejected('plan-run-failed', refusal, requested, evidence);

    const outputBytes = Buffer.byteLength(result.output, 'utf8');
    if (outputBytes > PLAN_FILE_MAX_BYTES) {
      return rejected(
        'plan-output-too-large',
        `the native output is ${outputBytes} bytes, over the ${PLAN_FILE_MAX_BYTES}-byte limit`,
        requested,
        evidence,
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(result.output);
    } catch (e) {
      return rejected(
        'plan-json-invalid',
        `the COMPLETE native output is not one JSON value: ${(e as Error).message}`,
        requested,
        evidence,
      );
    }

    let parsed: PlanFile;
    try {
      parsed = parsePlanFile(raw);
    } catch (e) {
      if (isPlanFileError(e)) {
        return rejected('plan-file-refused', `${e.code}: ${e.detail}`, requested, evidence);
      }
      return rejected('plan-file-refused', (e as Error).message, requested, evidence);
    }

    if (parsed.kind !== 'sequential') {
      return rejected('plan-kind-invalid', `the draft must be "sequential", got "${parsed.kind}"`, requested, evidence);
    }
    if (parsed.plans.length < MIN_CANDIDATE_PLANS || parsed.plans.length > MAX_CANDIDATE_PLANS) {
      return rejected(
        'plan-candidate-count',
        `expected ${MIN_CANDIDATE_PLANS}-${MAX_CANDIDATE_PLANS} candidates, got ${parsed.plans.length}`,
        requested,
        evidence,
      );
    }

    return {
      exitCode: 0,
      report: {
        command: 'plan',
        status: 'draft',
        source: 'model-generated',
        requested,
        provenance: PROVENANCE,
        runtime: evidence,
        planFile: externalPlanFile(parsed),
        error: null,
        automaticPostRoundAction: 'none',
      },
    };
  } catch (e) {
    if (e instanceof PlanRefusal) return rejected(e.code, e.message, requested);
    return rejected('plan-invocation-invalid', (e as Error).message, requested);
  }
}

export function formatPlanReport(report: PlanReport, asJson: boolean): string {
  if (asJson) return JSON.stringify(report, null, 2);

  const lines: string[] = [];
  lines.push(
    report.status === 'draft'
      ? 'plan DRAFT — model-generated, UNAPPROVED, not dispatched'
      : 'plan REJECTED — no valid draft accepted (a native attempt may still have run)',
  );
  lines.push(`  agent    ${report.requested.agent || '(missing)'}`);
  lines.push(`  model    ${report.requested.model ?? '(missing)'}`);
  if (report.runtime !== null) {
    lines.push(`  task     ${report.runtime.taskId}`);
    lines.push(
      `  runtime  state=${report.runtime.state} exit=${String(report.runtime.exitCode)} ` +
        `signal=${report.runtime.signal ?? 'none'} treeStopConfirmed=${report.runtime.cleanup.treeStopConfirmed}`,
    );
  }
  if (report.error !== null) lines.push(`  error    ${report.error.code}: ${report.error.message}`);
  if (report.planFile !== null) {
    lines.push(`  plans    ${report.planFile.plans.length}`);
    for (const plan of report.planFile.plans) {
      lines.push(`  - ${plan.id}  ${plan.label}  steps=${plan.steps.length}`);
    }
    lines.push('');
    lines.push('--- draft planFile (unapproved, not executed) ---');
    lines.push(JSON.stringify(report.planFile, null, 2));
  }
  lines.push('');
  lines.push(`next     ${report.automaticPostRoundAction} (this CLI selected, committed and dispatched nothing)`);
  lines.push(report.provenance);
  return lines.join('\n');
}
