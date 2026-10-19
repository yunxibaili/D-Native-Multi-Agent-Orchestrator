/**
 * src/runtime/preflight.ts — the runtime-owned launch preflight.
 *
 * ============================================================================
 * WHY THIS LIVES IN src/runtime AND NOT IN THE CALLER
 * ============================================================================
 *
 * Everything in this module is guaranteed to happen BEFORE a transport, a child, or
 * any OS process exists. That makes it part of the runtime's PROCESS-START TRUTH, and
 * only the runtime may certify process-start truth.
 *
 * The failure it fixes is concrete: `timeoutMs=0`, or an adapter rejecting an
 * unsupported launch option, used to surface as a plain unbranded error. The execution
 * edge could not tell "nothing was ever created" from "something may be running", so it
 * kept the WRITE claim forever — a configuration typo poisoned the workspace until the
 * process restarted, even after the typo was fixed.
 *
 * The proof is produced HERE, inside the trust boundary, and never handed back as a
 * capability. The caller receives either a validated launch or a branded error; it can
 * never obtain the ability to brand one itself.
 *
 * SCOPE DISCIPLINE. This function performs ONLY validation that is guaranteed to
 * precede process creation. It deliberately does NOT wrap `createTransport`,
 * `AgentSession` construction, `session.start()` or anything downstream: a `try` around
 * the whole execution would re-create the very bug this closes, by branding errors that
 * arrive after a writer is already running.
 */

import { CapabilityError, InvalidRequestError } from '../core/errors.ts';
import { validateExecutionTimeout } from '../core/types.ts';
import type { LauncherSpec, RunRequest } from '../core/types.ts';
import { brandProvenNotStarted } from './internal/start-proof.ts';
import { evaluateOfflineSpawn, describeOfflineDenial } from './offline-policy.ts';

/** The capability subset the preflight gates on. */
export interface LaunchCapabilities {
  readonly newTask: boolean;
  readonly review: boolean;
  readonly resume: boolean;
}

/** The configured values the preflight folds into the request. */
export interface LaunchConfig {
  readonly model: string | undefined;
  readonly role: string | undefined;
  readonly sandbox: string | undefined;
  readonly timeoutMs: number | undefined;
}

export interface RuntimeLaunchPreflightInput {
  readonly req: RunRequest;
  readonly capabilities: LaunchCapabilities;
  readonly config: LaunchConfig;
  /**
   * The adapter's own launch-option validation. It throws whatever it throws; this
   * module does not inspect the class, only that it threw while still pre-process.
   */
  readonly validateAdapterRequest: (req: RunRequest) => void;
  /**
   * Resolve a resume target against persisted ownership, or throw. Supplied by the
   * runtime implementation because it owns the thread store; it carries no brand.
   */
  readonly resolveResumeTarget: (req: RunRequest, supportsResume: boolean) => string;
  /**
   * The adapter's launcher, when known at preflight time. OFFLINE TEST ISOLATION
   * consults it here so a frozen test process refuses a real agent BEFORE an
   * `AgentSession` (and therefore a transport / child) is ever constructed. Optional
   * so existing direct callers that only exercise request validation stay valid; the
   * `ManagedProcess` edge re-checks unconditionally.
   */
  readonly launcher?: LauncherSpec;
}

export interface RuntimeLaunchPreflightResult {
  readonly merged: RunRequest;
  readonly effectiveThreadId: string | undefined;
  readonly sandboxDefault: string | undefined;
}

/**
 * Validate a launch and fold configured defaults into the request.
 *
 * On ANY failure the original error is branded in place — identity, class and message
 * all preserved — because the failure provably happened before any process could exist.
 * The classification is by EXECUTION PHASE, never by error type: a new validation added
 * to this region is covered automatically, and the identical error thrown later (past
 * the process boundary) is not, because it never enters this function.
 */
export function validateRuntimeLaunchPreflight(
  input: RuntimeLaunchPreflightInput,
): RuntimeLaunchPreflightResult {
  const { req, capabilities, config } = input;
  try {
    /*
     * OFFLINE TEST ISOLATION. When the offline policy is frozen and the adapter's own
     * launcher is a real agent executable, refuse HERE — before any transport, child or
     * OS process exists. The refusal is thrown inside this region, so it is branded as
     * proven-not-started exactly like the other pre-process validations below, and the
     * WRITE-claim release contract is preserved.
     */
    if (input.launcher !== undefined) {
      const offline = evaluateOfflineSpawn({ launcher: input.launcher, args: [], cwd: req.cwd });
      if (!offline.allowed) {
        throw new InvalidRequestError(req.agentId, 'offline-policy', describeOfflineDenial(offline));
      }
    }

    if (!capabilities.newTask && !req.threadId) throw new CapabilityError(req.agentId, 'newTask');

    // `review` and `resume` are mutually exclusive entrypoints. A review is a one-shot
    // judgement over a diff; it has no conversation to continue, so combining them would
    // mean the threadId is silently ignored.
    if (req.mode === 'review' && req.threadId) {
      throw new InvalidRequestError(
        req.agentId,
        'mode=review together with threadId',
        'A review is a one-shot judgement and has no conversation to continue. ' +
          'Drop threadId to run a review, or use mode=default with threadId to resume.',
      );
    }

    // Resume ownership: a threadId is not a global key.
    const effectiveThreadId = req.threadId
      ? input.resolveResumeTarget(req, capabilities.resume)
      : undefined;

    if (req.mode === 'review' && !capabilities.review) {
      throw new CapabilityError(req.agentId, 'review');
    }

    // A configured sandbox applies to ORDINARY FRESH RUNS only. Review/resume
    // entrypoints reject `--sandbox`, so injecting a default there would make the
    // adapter refuse every review.
    const sandboxApplies = !req.threadId && req.mode !== 'review';
    const sandboxDefault = sandboxApplies ? config.sandbox : undefined;

    const merged: RunRequest = {
      ...req,
      threadId: effectiveThreadId,
      model: req.model ?? config.model,
      role: req.role ?? config.role,
      sandbox: req.sandbox ?? sandboxDefault,
      timeoutMs: req.timeoutMs ?? config.timeoutMs,
    };

    // The ONE timeout validator. A configured or per-request deadline of 0 / negative /
    // oversized can never reach the AgentSession.
    if (merged.timeoutMs !== undefined) {
      const check = validateExecutionTimeout(merged.timeoutMs);
      if (!check.ok) throw new InvalidRequestError(req.agentId, 'timeoutMs', check.reason);
    }

    // Adapter-owned validation. Throws for anything it cannot honour, so no option is
    // silently dropped on the way to the native CLI.
    input.validateAdapterRequest(merged);

    return { merged, effectiveThreadId, sandboxDefault };
  } catch (e) {
    // Still inside the guaranteed pre-process region: no transport, no child, no OS
    // process. Brand the ORIGINAL error so the execution edge can release the WRITE
    // claim without losing the error's identity for every other caller.
    throw brandProvenNotStarted(
      e,
      'request-rejected-before-spawn',
      `request validation for agent "${req.agentId}"`,
    );
  }
}