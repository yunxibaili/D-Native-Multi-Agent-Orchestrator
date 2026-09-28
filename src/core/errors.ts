/**
 * core/errors.ts — errors an operator can act on.
 *
 * Every message here is written to be pasted into a search box. Silent
 * fallbacks are deliberately NOT modelled: the orchestrator fails fast
 * (see REUSE_ANALYSIS §4).
 */

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

export class CapabilityError extends OrchestratorError {
  constructor(agentId: string, capability: string) {
    super(
      'CAPABILITY_UNSUPPORTED',
      `Agent "${agentId}" does not support "${capability}". ` +
        `Run "orchestrator doctor" to see each agent's capability matrix.`,
    );
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

export class TimeoutError extends OrchestratorError {
  readonly taskId: string;

  constructor(taskId: string, ms: number) {
    super(
      'TASK_TIMEOUT',
      `Task ${taskId} exceeded ${ms}ms. The process is still running — ` +
        `call wait() again or cancel().`,
    );
    this.taskId = taskId;
  }
}

export class CancelledError extends OrchestratorError {
  readonly taskId: string;

  constructor(taskId: string, reason: string) {
    super('TASK_CANCELLED', `Task ${taskId} was cancelled: ${reason}`);
    this.taskId = taskId;
  }
}

export class BadConfigError extends OrchestratorError {
  constructor(detail: string) {
    super('BAD_CONFIG', `Invalid orchestrator config: ${detail}`);
  }
}
