/**
 * src/orchestration/completion-contract.ts — P0-1: the typed COMPLETION CONTRACT.
 *
 * ============================================================================
 * WHAT THIS IS
 * ============================================================================
 * The smallest typed agreement that makes a CODING task's completion VERIFIABLE
 * instead of a matter of the model's word:
 *
 *   expectedArtifacts  exact files that must exist at the confirmed real workspace root
 *   allowedScope       the paths whose add/modify/delete is allowed in this attempt
 *   test               the SPECIFIC approved command (executable + argv + cwd) to run
 *
 * It is a PURE VALUE module. It parses, validates, compares and digests; it never
 * reads a file, never runs a process, never writes a task and never names an agent.
 *
 * WHY IT IS TYPED AND NOT PROSE
 * -----------------------------
 * A model can print "PASS" and a session can exit 0 while nothing was built. Both are
 * statements, not evidence. This contract is what lets the EXISTING verification
 * boundary require a real artifact set, a real bounded diff against a before/after
 * manifest, and a real contained test run — facts the model does not author.
 *
 * WHAT IT IS NOT
 * --------------
 * Not a sandbox, not a test runner, not a second Verification authority, not a
 * build system. It describes what completion must prove; `Orchestrator` gathers the
 * proof and `applyVerification` refuses `pass` when it is absent, stale or forged.
 *
 * The gate KEY is the PRESENCE of a contract on the task. The governed plan-file
 * path REFUSES to build a coding step without one (see `plan-file.ts`), so a
 * production coding task always carries it; a task that never declared one keeps the
 * pre-P0-1 behaviour exactly.
 */

import { createHash } from 'node:crypto';
import type { TaskType } from '../quota/types.ts';

/** Bounds. Named constants, not a configuration platform. */
export const COMPLETION_MAX_ITEMS = 32;
export const COMPLETION_MAX_ARGV = 64;
export const COMPLETION_MAX_TEXT = 400;

/** The approved, bounded test command. Never a shell string, never `sh -c`. */
export interface CompletionTestCommand {
  /** Executable name or path, resolved through the existing `resolveCommand`. */
  readonly executable: string;
  /** Exact argv. No shell interpolation, no `&&`, no pipes. */
  readonly argv: readonly string[];
  /** cwd RELATIVE to the confirmed workspace root. `.` means the root itself. */
  readonly cwd: string;
}

export interface CompletionContract {
  /** Exact relative file paths that must exist at the workspace root. */
  readonly expectedArtifacts: readonly string[];
  /** Relative paths or directory prefixes where changes are allowed. */
  readonly allowedScope: readonly string[];
  /** The one approved test command. */
  readonly test: CompletionTestCommand;
}

export class CompletionContractError extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(code: string, detail: string) {
    super(`completion contract refused [${code}]: ${detail}`);
    this.name = 'CompletionContractError';
    this.code = code;
    this.detail = detail;
  }
}

/** Task types whose completion this contract governs. */
export function isCodingTaskType(taskType: TaskType): boolean {
  return taskType === 'implementation' || taskType === 'test';
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A path that may only be interpreted RELATIVE to a confirmed root.
 *
 * Refuses: empty, absolute (POSIX or drive), UNC / extended-length prefixes, a `..`
 * segment anywhere, `.` segments, empty segments, NUL/control bytes and the Windows
 * reserved characters. Deliberately conservative: a caller that needs `..` has a
 * modelling mistake, not a path.
 */
export function isSafeRelativePath(p: unknown): p is string {
  if (typeof p !== 'string') return false;
  if (p === '' || p.length > COMPLETION_MAX_TEXT) return false;
  if (/^[a-zA-Z]:/.test(p)) return false;
  if (p.startsWith('/') || p.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(p) || p.startsWith('\\\\')) return false;
  if (/[\u0000-\u001f<>:"|?*]/.test(p)) return false;
  const norm = p.replace(/\\/g, '/');
  const segments = norm.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

/** A workspace-relative DIRECTORY, `.` (the root itself) or a safe relative path. */
export function isSafeRelativeDir(p: unknown): p is string {
  if (p === '.') return true;
  return isSafeRelativePath(p);
}

function parseTextArray(raw: unknown, where: string, required: boolean): readonly string[] | undefined {
  if (raw === undefined) {
    if (required) throw new CompletionContractError('missing-field', `${where} is required`);
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new CompletionContractError('invalid-field', `${where} must be an array of relative paths`);
  }
  if (raw.length > COMPLETION_MAX_ITEMS) {
    throw new CompletionContractError('too-many-items', `${where} has ${raw.length} entries, over the ${COMPLETION_MAX_ITEMS} limit`);
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (!isSafeRelativePath(v)) {
      throw new CompletionContractError(
        'unsafe-path',
        `${where}[${i}] must be a plain relative path with no drive, no leading separator and no ".." segment (got ${JSON.stringify(v)})`,
      );
    }
    out.push(v.replace(/\\/g, '/'));
  }
  return out;
}

function parseTestCommand(raw: unknown, where: string): CompletionTestCommand {
  if (!isRecord(raw)) throw new CompletionContractError('invalid-test', `${where} must be an object with executable, argv and cwd`);
  const executable = raw.executable;
  if (typeof executable !== 'string' || executable.trim() === '' || executable.length > COMPLETION_MAX_TEXT) {
    throw new CompletionContractError('invalid-test-executable', `${where}.executable must be a non-empty string`);
  }
  if (/[\u0000-\u001f<>:"|?*]/.test(executable) || executable.includes('..')) {
    throw new CompletionContractError('invalid-test-executable', `${where}.executable contains reserved characters`);
  }
  let argv: readonly string[] = [];
  if (raw.argv !== undefined) {
    if (!Array.isArray(raw.argv)) throw new CompletionContractError('invalid-test-argv', `${where}.argv must be an array of strings`);
    if (raw.argv.length > COMPLETION_MAX_ARGV) {
      throw new CompletionContractError('too-many-items', `${where}.argv has ${raw.argv.length} entries, over the ${COMPLETION_MAX_ARGV} limit`);
    }
    const args: string[] = [];
    for (let i = 0; i < raw.argv.length; i++) {
      const a = raw.argv[i];
      if (typeof a !== 'string' || a.length > COMPLETION_MAX_TEXT*4) {
        throw new CompletionContractError('invalid-test-argv', `${where}.argv[${i}] must be a string`);
      }
      if (a.includes('\u0000')) throw new CompletionContractError('invalid-test-argv', `${where}.argv[${i}] contains a NUL byte`);
      args.push(a);
    }
    argv = args;
  }
  const cwd = raw.cwd === undefined ? '.' : raw.cwd;
  if (!isSafeRelativeDir(cwd)) {
    throw new CompletionContractError('invalid-test-cwd', `${where}.cwd must be "." or a safe relative directory (got ${JSON.stringify(raw.cwd)})`);
  }
  return Object.freeze({ executable, argv: Object.freeze([...argv]), cwd });
}

/**
 * Parse + validate the completion fields of a plan-file step. Total and fail-closed:
 * a violation names the offending field and nothing is defaulted.
 */
export function parseCompletionContract(input: {
  expectedArtifacts: unknown;
  allowedScope: unknown;
  test: unknown;
}, where: string): CompletionContract {
  const expectedArtifacts = parseTextArray(input.expectedArtifacts, `${where}.expectedArtifacts`, true)!;
  const allowedScope = parseTextArray(input.allowedScope, `${where}.allowedScope`, true)!;
  if (expectedArtifacts.length === 0) {
    throw new CompletionContractError('empty-expected-artifacts', `${where}.expectedArtifacts must name at least one file`);
  }
  if (allowedScope.length === 0) {
    throw new CompletionContractError('empty-allowed-scope', `${where}.allowedScope must name at least one path`);
  }
  const test = parseTestCommand(input.test, `${where}.test`);
  return Object.freeze({ expectedArtifacts: Object.freeze([...expectedArtifacts]), allowedScope: Object.freeze([...allowedScope]), test });
}

/** True when the step declared ANY completion field (so a partial one is a refusal, not silence). */
export function hasAnyCompletionField(step: Record<string, unknown>): boolean {
  return step.expectedArtifacts !== undefined || step.allowedScope !== undefined || step.test !== undefined;
}

/**
 * A stable digest over the FIELDS THAT MATTER. Expected artifacts and allowed scopes
 * are order-insensitive (sorted); argv order is significant (it is argv).
 */
export function completionContractDigest(contract: CompletionContract): string {
  const canonical = JSON.stringify({
    expectedArtifacts: [...contract.expectedArtifacts].sort(),
    allowedScope: [...contract.allowedScope].sort(),
    test: { executable: contract.test.executable, argv: [...contract.test.argv], cwd: contract.test.cwd },
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Is `candidate` (a workspace-relative path) inside `scope` (also relative)?
 *
 * Case-insensitive on Windows semantics (the filesystem is), and SEGMENT-BOUNDARY
 * aware: `add.js.sibling` is NOT inside `add.js`, and `demo/add.js` is not the same as
 * `add.js`. A directory scope matches everything under it.
 */
export function pathWithinScope(candidate: string, scope: string): boolean {
  const a = candidate.replace(/\\/g, '/').toLowerCase();
  const b = scope.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (a === b) return true;
  return a.startsWith(b + '/');
}

/** Any scope in the list contains the candidate. */
export function isPathAllowed(candidate: string, allowedScope: readonly string[]): boolean {
  return allowedScope.some((s) => pathWithinScope(candidate, s));
}
