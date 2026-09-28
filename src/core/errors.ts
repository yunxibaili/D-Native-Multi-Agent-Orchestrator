/**
 * core/errors.ts — errors an operator can act on.
 *
 * Every message is written to be pasted into a search box. Silent fallbacks are
 * deliberately NOT modelled anywhere: the orchestrator and the adapters fail
 * fast rather than degrading a task into something the caller did not ask for.
 */

import type { ErrorCode } from './types.ts';

export class OrchestratorError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class AdapterNotFoundError extends OrchestratorError {
  readonly available: readonly string[];

  constructor(requested: string, available: readonly string[]) {
    const list = available.length ? available.join(', ') : '(none registered)';
    super(
      'ADAPTER_NOT_FOUND',
      `No agent adapter registered for "${requested}". Registered agents: ${list}. ` +
        `Register it in orchestrator.json, or pass a valid --agent.`,
    );
    this.available = available;
  }
}

/**
 * Thrown when a request carries an option the agent cannot honour. This is the
 * mechanism that guarantees nothing is silently dropped: an adapter declares
 * a capability as false and then REFUSES the option rather than ignoring it.
 */
export class UnsupportedOptionError extends OrchestratorError {
  readonly option: string;
  readonly agentId: string;

  constructor(agentId: string, option: string, hint: string) {
    super(
      'UNSUPPORTED_OPTION',
      `Agent "${agentId}" does not support ${option}. ${hint}`,
    );
    this.agentId = agentId;
    this.option = option;
  }
}

export class CapabilityError extends OrchestratorError {
  readonly capability: string;

  constructor(agentId: string, capability: string) {
    super(
      'CAPABILITY_UNSUPPORTED',
      `Agent "${agentId}" does not support "${capability}". ` +
        `Run "orchestrator doctor" to see each agent's capability matrix.`,
    );
    this.capability = capability;
  }
}

export class ThreadNotFoundError extends OrchestratorError {
  constructor(threadId: string, agentId?: string) {
    super(
      'THREAD_NOT_FOUND',
      `No stored thread ${JSON.stringify(threadId)}${agentId ? ` for agent ${JSON.stringify(agentId)}` : ''}. ` +
        `Thread identity is agent-scoped, so a thread belonging to another agent is ` +
        `not visible here. List this agent's threads with "orchestrator threads <agent>", ` +
        `or drop --thread to start a new conversation.`,
    );
  }
}

/**
 * A request that is internally contradictory, independent of any agent's
 * capabilities. Used for semantic conflicts such as `mode=review` with a
 * `threadId`, where no agent can honour the combination.
 */
export class InvalidRequestError extends OrchestratorError {
  readonly detail: string;

  constructor(agentId: string, detail: string, hint: string) {
    super('INVALID_REQUEST', `Agent "${agentId}": ${detail}. ${hint}`);
    this.detail = detail;
  }
}

/**
 * Resume ownership violation. A thread id is not a global key: it is only
 * meaningful together with the agent and directory that created it.
 */
export class ThreadOwnershipError extends OrchestratorError {
  constructor(
    threadId: string,
    field: 'agentId' | 'cwd',
    expected: string,
    actual: string,
  ) {
    super(
      'THREAD_OWNERSHIP',
      `Thread "${threadId}" was created with ${field}=${JSON.stringify(expected)}, ` +
        `but this run has ${field}=${JSON.stringify(actual)}. ` +
        `Resuming across ${field} is refused because the agent's own session ` +
        `state and file context belong to the original run. ` +
        `Pass an explicit override if you really mean it, or start a new thread.`,
    );
  }
}

export class LauncherResolutionError extends OrchestratorError {
  constructor(detail: string) {
    super('LAUNCHER_UNSUPPORTED', detail);
  }
}

export class NotInstalledError extends OrchestratorError {
  constructor(agentId: string, tried: readonly string[]) {
    super(
      'AGENT_NOT_INSTALLED',
      `Could not locate the "${agentId}" binary. Tried:\n  ${tried.join('\n  ')}\n` +
        `Set an explicit path with {"agents":{"${agentId}":{"command":"<abs path>"}}} in orchestrator.json.`,
    );
  }
}

export class BadConfigError extends OrchestratorError {
  constructor(detail: string) {
    super('BAD_CONFIG', `Invalid orchestrator config: ${detail}`);
  }
}

/** Wraps a transport-level failure as a RunErrorInfo. */
export function transportError(message: string): { code: ErrorCode; message: string; retryable: boolean } {
  return { code: 'TRANSPORT_ERROR', message, retryable: true };
}
