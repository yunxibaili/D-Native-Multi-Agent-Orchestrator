/**
 * memory/bank.ts — F1: bank identity is EXPLICIT, never derived from a path.
 *
 * The PoC proved the default is unsafe. Hindsight's OpenCode plugin builds the
 * bank id from `basename(cwd)` (or the main worktree's basename) with no path
 * and no hash. Two unrelated projects that happen to share a directory name
 * therefore share one memory bank:
 *
 *   C:\...\alpha\svc  -> opencode::svc
 *   C:\...\beta\svc   -> opencode::svc      <- collision, silent cross-project leak
 *
 * and the same project run from two subdirectories splits into two banks:
 *
 *   <repo>\            -> opencode::svc
 *   <repo>\src\deep\   -> opencode::deep     <- fragmentation
 *
 * This module makes that impossible by construction. A bank id is built ONLY
 * from an explicit `projectMemoryId`, optionally scoped per agent. The
 * identity is:
 *
 *   - stable      : same config -> same id, forever, across restarts
 *   - cwd-free    : changing directory cannot change the id
 *   - worktree-agnostic: every worktree of a project passes the SAME id
 *   - collision-resistant: caller-chosen, not derived from a filesystem name
 *
 * `suggestProjectMemoryId` exists to make configuring less annoying, but it is
 * advisory only and is deliberately NOT wired into the identity path: guessing
 * must never be able to select a bank.
 */

import type { MemoryError, MemoryResult } from './types.ts';

export interface BankAddress {
  /** The exact string sent to the backend as bank_id. */
  bankId: string;
  projectMemoryId: string;
  /** Present only when the caller scopes memory per agent. */
  agentScope: string | null;
}

/** Prefix makes our banks self-identifying in a shared backend. */
export const BANK_NAMESPACE = 'p4m';

export interface BuildBankOptions {
  projectMemoryId: string;
  /** Set to keep one agent's memories out of another's view. */
  agentScope?: string | undefined;
  namespace?: string | undefined;
}

function fail(code: MemoryError['code'], reason: string): MemoryError {
  return { code, reason, retryable: false };
}

/**
 * Build the bank address for a project. Deterministic and total: the same
 * inputs always produce the same bankId, and no filesystem state is consulted.
 */
export function buildBankId(options: BuildBankOptions): MemoryResult<BankAddress> {
  const projectMemoryId = options.projectMemoryId?.trim() ?? '';
  if (projectMemoryId === '') {
    return {
      ok: false,
      status: 'degraded',
      value: null,
      degraded: fail(
        'memory-project-id-required',
        'projectMemoryId is required to address a bank; it is never derived from the working directory',
      ),
      usage: null,
    };
  }
  if (/[/\\]/.test(projectMemoryId) || /^[a-zA-Z]:/.test(projectMemoryId)) {
    return {
      ok: false,
      status: 'degraded',
      value: null,
      degraded: fail(
        'memory-config-invalid',
        `projectMemoryId "${projectMemoryId}" looks like a path; use a stable slug, not a directory`,
      ),
      usage: null,
    };
  }

  const namespace = options.namespace ?? BANK_NAMESPACE;
  const agentScope = options.agentScope?.trim() || null;
  if (agentScope !== null && /::/.test(agentScope)) {
    return {
      ok: false,
      status: 'degraded',
      value: null,
      degraded: fail('memory-config-invalid', `agentScope "${agentScope}" must not contain "::"`),
      usage: null,
    };
  }

  const bankId = agentScope === null
    ? `${namespace}::${projectMemoryId}`
    : `${namespace}::${projectMemoryId}::${agentScope}`;

  return {
    ok: true,
    status: 'ok',
    value: { bankId, projectMemoryId, agentScope },
    degraded: null,
    usage: null,
  };
}

/**
 * Advisory helper for humans filling in config. Returns a candidate slug and an
 * explicit warning that it is only a suggestion.
 *
 * It is NOT used by buildBankId, and callers must not auto-apply it: the whole
 * point of F1 is that a guess may be offered but may not decide.
 */
export function suggestProjectMemoryId(cwdBasename: string): {
  suggestion: string;
  reason: string;
  requiresConfirmation: true;
} {
  const slug = cwdBasename
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 63);
  return {
    suggestion: slug,
    reason:
      'derived from a directory name for convenience only — it is NOT unique across machines or projects, ' +
      'and the same basename collision proven in the PoC applies. Confirm or replace it explicitly.',
    requiresConfirmation: true,
  };
}

/**
 * How a projectMemoryId was obtained, in resolution order (§5):
 *   1. explicit  — passed directly (env / config file / arg)
 *   2. project_config — read from a checked-in project config (not yet auto-read here)
 *   3. suggestion — offered, never used to select a bank
 *   4. required  — nothing determinate; the caller must configure it
 */
export type BankIdSource = 'explicit' | 'project_config' | 'required';

export interface ResolveBankInput {
  /** Level 1: an explicit id supplied by the caller. */
  explicitProjectMemoryId?: string | undefined;
  /** Level 2: an id read from a project config file, if one declared it. */
  projectConfigId?: string | undefined;
  /** Level 3: a directory basename, used ONLY to offer a suggestion. */
  cwdBasename?: string | undefined;
  agentScope?: string | undefined;
}

export interface ResolvedBank {
  bank: BankAddress;
  source: BankIdSource;
  /** Present when source is 'required' so the operator can act on it. */
  suggestion: string | null;
  /** True only when a suggestion was offered and NOT auto-applied. */
  requiresConfirmation: boolean;
}

/**
 * Resolve the project identity through the priority chain, then build the bank.
 *
 * A suggestion is never promoted to an identity: if neither an explicit id nor a
 * project-config id is present, the result is `source: 'required'` and NO bank is
 * produced, so a caller physically cannot auto-create a bank from a guess.
 */
export function resolveBank(input: ResolveBankInput): ResolvedBank {
  const build = (id: string, source: BankIdSource, suggestion: string | null): ResolvedBank => {
    const built = buildBankId({
      projectMemoryId: id,
      ...(input.agentScope !== undefined ? { agentScope: input.agentScope } : {}),
    });
    if (!built.ok || built.value === null) {
      // An explicit/project value that fails validation is a hard stop, not a
      // reason to fall through to a guess.
      return {
        bank: { bankId: '', projectMemoryId: id, agentScope: input.agentScope ?? null },
        source: 'required',
        suggestion,
        requiresConfirmation: suggestion !== null,
      };
    }
    return { bank: built.value, source, suggestion, requiresConfirmation: false };
  };

  const explicit = input.explicitProjectMemoryId?.trim();
  if (explicit !== undefined && explicit !== '') {
    return build(explicit, 'explicit', null);
  }
  const fromConfig = input.projectConfigId?.trim();
  if (fromConfig !== undefined && fromConfig !== '') {
    return build(fromConfig, 'project_config', null);
  }
  const suggestion = input.cwdBasename !== undefined && input.cwdBasename !== ''
    ? suggestProjectMemoryId(input.cwdBasename).suggestion
    : null;
  return {
    bank: { bankId: '', projectMemoryId: '', agentScope: input.agentScope ?? null },
    source: 'required',
    suggestion,
    requiresConfirmation: suggestion !== null,
  };
}

/** True when two bank addresses denote the same project (any agent scope). */
export function sameProject(a: BankAddress, b: BankAddress): boolean {
  return a.projectMemoryId === b.projectMemoryId;
}

/** True when two addresses are the same bank, scope included. */
export function sameBank(a: BankAddress, b: BankAddress): boolean {
  return a.bankId === b.bankId;
}
