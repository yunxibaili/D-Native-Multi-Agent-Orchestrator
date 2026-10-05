/**
 * src/orchestration/resource-claim.ts - R2-1, the PURE half of Workspace / Resource Safety.
 *
 * Implements §7 (Resource Claims) and §8 (Workspace Contract) of the frozen
 * `docs/R2_COORDINATION_CONTRACT.md`. Nothing in this file performs I/O, spawns an
 * agent, mutates a task, or resolves a workspace directory: it normalizes scopes and
 * answers "do these two claims conflict?". That is deliberate - the contract's
 * conflict matrix must be testable as arithmetic, not as a git worktree.
 *
 * WHO OWNS THE STATE
 * ------------------
 * Not this module. §4 of the contract assigns ResourceClaim to the EXISTING
 * `WorkspaceManager` ("既有 workspace authority"), and explicitly forbids a Resource
 * Scheduler. So `ResourceClaimBook` below is the bookkeeping half and it is held and
 * arbitrated BY `WorkspaceManager` (see workspace.ts), which exposes it as new
 * METHODS on an existing authority - never as a second scheduler, never as anything
 * that can dispatch.
 *
 * WHY THIS EXISTS AT ALL
 * ---------------------
 * Task ownership and Assignment are already safe (R2-0 §5). Resource ownership was
 * not: two parallel writable tasks could land in the same mutable cwd and edit the
 * same file. That is a real gap, not a theoretical one - the production round
 * constructed no `WorkspaceManager` at all, so every task inherited one directory.
 *
 * THE HONEST PART OF §7.2's READ+WRITE CELL
 * -----------------------------------------
 * The contract says read+write is allowed by default and rests on one assumption:
 * "reader 接受 read 命中半写入状-需要一致性时应该- Laya - DAG 中表达依-而不是靠
 * claim 阻塞". That assumption is IMPLEMENTED AS WRITTEN - read+write does not
 * conflict here - and it is NOT silently upgraded into a guarantee it cannot make.
 * A reader really can observe a half-written file here. Expressing that as a DAG
 * dependency is Laya's job (a later stage), and this module must not pretend to
 * enforce consistency it does not provide.
 */

import { isAbsolute, resolve as resolvePath } from 'node:path';

/** Access intent of a claim. Closed set - the contract's three modes. */
export type ResourceClaimMode = 'read' | 'write' | 'exclusive-write';

/**
 * What a claim covers.
 *
 * `workspace` and `repository` are WIDE: they match everything inside themselves.
 * R2-1.1 made that precise, because "everything inside" has to mean inside THIS one:
 *
 *   - `workspace` carries `root` as well as `workspaceId`. Without a root, a
 *     whole-workspace claim could not be compared with a path claim at all, and the
 *     only safe-looking shortcut - treating every workspace scope as overlapping
 *     every other - made two ISOLATED worktrees conflict with each other and
 *     silently serialized parallel writers. That was P1-a.
 *   - `repository` already carries its root, and two isolated worktrees of one repo
 *     are different directories, so they are correctly NOT the same scope.
 */
export type ResourceScope =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'workspace'; readonly workspaceId: string; readonly root?: string }
  | { readonly kind: 'repository'; readonly repoRoot: string };

/** A registered claim. Field set is §7.1 of the contract. */
export interface ResourceClaim {
  readonly claimId: string;
  readonly taskId: string;
  /**
   * §7.1: the lease version this claim was bound to. **R2-2 (Lease/Fencing) is
   * implemented**, so this is now a real binding rather than a reserved field:
   *
   *   - `null` means the claim could not be bound to a LIVE lease at the moment it was
   *     taken. That is not a neutral default - it means "this claim carries no proof of
   *     holding a current lease", and `claimIsLeaseCurrent` treats it as unproven.
   *   - a number means the claim was taken under that lease version. If the task's lease
   *     has since advanced, been revoked or expired, §7.3 makes the claim automatically
   *     void, which is implemented by dropping it (`ResourceClaimBook.voidClaimsWhere`)
   *     rather than by a sweep somebody has to remember to run.
   *
   * §7.3's "a claim must reference a currently valid lease" is therefore enforced at the
   * two ends: binding refuses to record a dead lease's version, and the held set is
   * pruned before it is ever consulted for a conflict.
   */
  readonly leaseVersion: number | null;
  readonly workspaceId: string;
  readonly mode: ResourceClaimMode;
  readonly scope: ResourceScope;
  readonly createdAt: number;
}

/**
 * §7.3: does this claim still prove it holds a CURRENT lease?
 *
 * `currentLeaseVersion` is supplied by whoever owns the lease (TaskStore, via the
 * orchestrator) - this function never looks a lease up, which is what keeps
 * `ResourceClaimBook` from becoming a second lease authority. It is handed a fact and
 * answers a question about arithmetic.
 *
 * Fail-closed by construction: a claim with no bound version cannot be shown to belong
 * to a live lease, so it does not count. That is stricter than "probably fine" and is
 * the only safe direction for a right that authorises writing.
 */
export function claimIsLeaseCurrent(
  claim: ResourceClaim,
  currentLeaseVersion: number | null | undefined,
): boolean {
  if (claim.leaseVersion === null) return false;
  if (currentLeaseVersion === null || currentLeaseVersion === undefined) return false;
  return claim.leaseVersion === currentLeaseVersion;
}

// ---------------------------------------------------------------------------
// §7 scope normalization
// ---------------------------------------------------------------------------

/**
 * Canonical comparison key for a path.
 *
 * Four things are normalized, because an adapter may hand us any of them:
 *   - separators: `\` and `/` are the same path on Windows, so both become `/`
 *   - trailing separators: `src/auth/` === `src/auth`
 *   - `.` / `..`: resolved away, so `src/auth/../api` === `src/api`
 *   - relative vs absolute: resolved against the workspace root, so `src/auth` and
 *     `D:\project\src\auth` are the SAME scope rather than two that never overlap
 *
 * CASE: Windows filesystems are case-INSENSITIVE by default, so `SRC/Auth.ts` and
 * `src/auth.ts` are one file there and two on Linux. This project runs on Windows
 * (`runtime/discover.ts` resolves `.exe` launchers; the CLI's own `normPath`
 * lowercases only on win32), so the comparison key follows the real platform rather
 * than an assumed Linux behaviour. A POSIX filesystem keeps its case, because
 * lowercasing there would MERGE two genuinely different paths into a false conflict.
 */
function canonicalPathKey(p: string, root: string): string {
  const absolute = isAbsolute(p) ? p : resolvePath(root, p);
  // `resolvePath` has already collapsed `.`/`..` and made it absolute; normalize the
  // separators next so Windows' `\` compares equal to a `/` from a prompt.
  const slashed = absolute.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/** Build the input for `normalizeScope`, naming the root a relative path resolves against. */
export interface NormalizeScopeInput {
  readonly path: string;
  /** Workspace root (or repo root) that a relative `path` is relative to. */
  readonly root: string;
  /** A path that exists as a FILE is scoped as `file`; a directory as `directory`. */
  readonly kind: 'file' | 'directory';
}

export function normalizeScope(input: NormalizeScopeInput): ResourceScope {
  const key = canonicalPathKey(input.path, input.root);
  return input.kind === 'file'
    ? { kind: 'file', path: key }
    : { kind: 'directory', path: key };
}

/** `workspace` / `repository` scopes need no path, so they normalize to themselves. */
export function normalizeScopeForWorkspace(workspaceId: string, root: string): ResourceScope {
  return { kind: 'workspace', workspaceId, root: canonicalPathKey(root, root) };
}

export function normalizeScopeForRepository(repoRoot: string): ResourceScope {
  return { kind: 'repository', repoRoot: canonicalPathKey(repoRoot, repoRoot) };
}

/**
 * A stable, printable identity for a scope, used to build claim ids (P2-1).
 *
 * Deterministic and collision-free for the four scope kinds: two scopes produce the
 * same key only when they denote the same resource.
 */
export function scopeKey(scope: ResourceScope): string {
  switch (scope.kind) {
    case 'file':
      return `file:${scope.path}`;
    case 'directory':
      return `dir:${scope.path}`;
    case 'workspace':
      return `ws:${scope.workspaceId}@${scope.root}`;
    case 'repository':
      return `repo:${scope.repoRoot}`;
  }
}

/** True when `child` is `parent` or lies beneath it, on SEGMENT boundaries. */
function isUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  const withSlash = parent.endsWith('/') ? parent : `${parent}/`;
  return child.startsWith(withSlash);
}

/**
 * §7.2: "scope 重叠" - file=同路径；directory=路径前缀包含；repository/workspace=全部
 * *inside themselves*.
 *
 * R2-1.1 (P1-a): that phrase is scoped, not global. "Everything inside" means
 * everything inside THAT workspace or repository, so:
 *
 *   workspace vs workspace  -> overlap iff the same workspace identity
 *   repository vs repository-> overlap iff the same repo root
 *   whole-X vs a path       -> overlap iff the path is under X's root
 *   whole-X vs whole-Y      -> NEVER overlap when X and Y are different
 *
 * The last line is the whole point. Two isolated worktrees are two different
 * workspaces; treating them as one made parallel writers conflict with each other
 * and serialized work that §8 explicitly wants isolated and concurrent.
 *
 * Segment-aware on paths, too. `src/auth` vs `src/authentic` shares a STRING prefix
 * but no path segment, so it must NOT overlap; a naive `startsWith` would refuse two
 * unrelated tasks forever.
 */
export function scopesOverlap(a: ResourceScope, b: ResourceScope): boolean {
  const wideA = a.kind === 'workspace' || a.kind === 'repository';
  const wideB = b.kind === 'workspace' || b.kind === 'repository';
  const rootA = a.kind === 'workspace' ? a.root : a.kind === 'repository' ? a.repoRoot : undefined;
  const rootB = b.kind === 'workspace' ? b.root : b.kind === 'repository' ? b.repoRoot : undefined;

  if (wideA && wideB) {
    // Two whole-workspace claims overlap only when they name the SAME container.
    if (a.kind === 'workspace' && b.kind === 'workspace') return a.workspaceId === b.workspaceId;
    if (a.kind === 'repository' && b.kind === 'repository') return a.repoRoot === b.repoRoot;
    // One names a workspace, the other a repository root: they overlap when the
    // workspace actually sits inside that repository. An unknown root proves nothing.
    return rootA !== undefined && rootB !== undefined && (isUnder(rootA, rootB) || isUnder(rootB, rootA));
  }

  // A wide scope against a path: containment needs the wide scope's root. Without one
  // there is nothing to compare, and claiming an overlap we cannot demonstrate would
  // be the same false-conflict bug P1-a is about - so it does NOT overlap.
  if (wideA) {
    const path = b.kind === 'file' || b.kind === 'directory' ? b.path : undefined;
    return path !== undefined && rootA !== undefined && isUnder(path, rootA);
  }
  if (wideB) {
    const path = a.kind === 'file' || a.kind === 'directory' ? a.path : undefined;
    return path !== undefined && rootB !== undefined && isUnder(path, rootB);
  }

  if (a.kind === 'file' && b.kind === 'file') return a.path === b.path;
  if (a.kind === 'file' && b.kind === 'directory') return isUnder(a.path, b.path);
  if (a.kind === 'directory' && b.kind === 'file') return isUnder(b.path, a.path);
  // directory vs directory
  return isUnder(a.path, b.path) || isUnder(b.path, a.path);
}

// ---------------------------------------------------------------------------
// §7.2 the conflict matrix
// ---------------------------------------------------------------------------

/**
 * The frozen matrix, as written:
 *
 *   held \ asked | read          | write                      | exclusive-write
 *   read         | allow         | allow if scopes overlap    | conflict
 *   write        | allow if overl.| CONFLICT if scopes overlap | conflict
 *   exclusive    | conflict      | conflict                   | conflict
 *
 * Commutative, so the order of the two arguments cannot change the answer.
 */
export function claimsConflict(held: ResourceClaim, asked: ResourceClaim): boolean {
  // A task never conflicts with itself: §7.3 makes re-claiming the same scope by the
  // same task IDEMPOTENT, so two claims owned by one task are not a contention.
  if (held.taskId === asked.taskId) return false;

  if (!scopesOverlap(held.scope, asked.scope)) return false;

  // exclusive-write conflicts with everything that overlaps.
  if (held.mode === 'exclusive-write' || asked.mode === 'exclusive-write') return true;

  // write + write is the conflict this whole layer exists to catch.
  if (held.mode === 'write' && asked.mode === 'write') return true;

  // read+read, and read+write (allowed by §7.2, resting on the documented
  // half-written-read assumption), fall through to allow.
  return false;
}

/** Which modes force isolation for a task that may run beside others. */
export function modeRequiresIsolation(mode: ResourceClaimMode): boolean {
  return mode === 'write' || mode === 'exclusive-write';
}

// ---------------------------------------------------------------------------
// The bookkeeping half - held BY WorkspaceManager, never by this module's users
// ---------------------------------------------------------------------------

export interface ClaimRequest {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly mode: ResourceClaimMode;
  readonly scope: ResourceScope;
  /**
   * §7.1: the CURRENT live lease version to bind this claim to.
   *
   * Omitted or null means no lease system is in play (a pre-R2-2 caller), which is
   * recorded honestly as `leaseVersion: null` and treated as unproven by
   * `claimIsLeaseCurrent` rather than being quietly upgraded to a valid binding.
   */
  readonly leaseVersion?: number | null;
}

export type ClaimOutcome =
  | { readonly ok: true; readonly claim: ResourceClaim; readonly created: boolean }
  | {
      readonly ok: false;
      readonly code: 'resource-conflict';
      readonly reason: string;
      /** The claims that already hold the contested scope. */
      readonly conflicts: readonly ResourceClaim[];
    };

/**
 * The claim registry. Pure bookkeeping: it never touches git, never resolves a
 * directory, and - critically - CANNOT DISPATCH. `WorkspaceManager` owns one of
 * these and exposes claim/release/check as methods on itself.
 */
export class ResourceClaimBook {
  private readonly byClaimId = new Map<string, ResourceClaim>();
  private readonly byWorkspace = new Map<string, Set<string>>();
  // Declared explicitly rather than as a constructor parameter property: this
  // project compiles with `erasableSyntaxOnly`, so a parameter property (which
  // requires a runtime emit) is not available.
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Register a claim, or report exactly which existing claims refuse it. */
  claim(request: ClaimRequest): ClaimOutcome {
    // §7.3 idempotence: the same task re-claiming the same scope returns the
    // EXISTING claim rather than conflicting with itself or making a duplicate.
    for (const existing of this.all()) {
      if (existing.taskId !== request.taskId) continue;
      if (existing.workspaceId !== request.workspaceId) continue;
      if (existing.mode !== request.mode) continue;
      if (scopesOverlap(existing.scope, request.scope)) {
        return { ok: true, claim: existing, created: false };
      }
    }

    const asked: ResourceClaim = {
      // P2-1: the id names the SCOPE and the MODE, not just the task and workspace.
      // It used to be `claim:${taskId}:${workspaceId}`, so a second scope on the
      // same task produced the SAME id and `Map.set` silently REPLACED the first
      // claim - losing its conflict protection while still looking registered. The
      // id is now the resource identity, so two scopes are two claims.
      claimId: `claim:${request.taskId}:${request.workspaceId}:${request.mode}:${scopeKey(request.scope)}`,
      taskId: request.taskId,
      leaseVersion: request.leaseVersion ?? null,
      workspaceId: request.workspaceId,
      mode: request.mode,
      scope: request.scope,
      createdAt: this.now(),
    };

    const conflicts = this.all().filter((held) => claimsConflict(held, asked));
    if (conflicts.length > 0) {
      return {
        ok: false,
        code: 'resource-conflict',
        reason:
          `task "${request.taskId}" asked for ${request.mode} on ${describeScope(request.scope)}, which overlaps ` +
          `${conflicts.length} existing claim(s): ` +
          conflicts.map((c) => `${c.taskId} (${c.mode} ${describeScope(c.scope)})`).join(', ') +
          '. This is a resource conflict, NOT an agent failure - nothing ran and no agent is blamed.',
        conflicts,
      };
    }

    this.byClaimId.set(asked.claimId, asked);
    const set = this.byWorkspace.get(request.workspaceId) ?? new Set<string>();
    set.add(asked.claimId);
    this.byWorkspace.set(request.workspaceId, set);
    return { ok: true, claim: asked, created: true };
  }

  /** Drop every claim a task holds. Called when the task reaches a terminal state. */
  releaseClaims(taskId: string): number {
    let released = 0;
    for (const [claimId, claim] of [...this.byClaimId]) {
      if (claim.taskId !== taskId) continue;
      this.byClaimId.delete(claimId);
      this.byWorkspace.get(claim.workspaceId)?.delete(claimId);
      released++;
    }
    this.pruneEmptyWorkspaces();
    return released;
  }

  /**
   * P2-1: release ONE scope of a task, leaving its other scopes held.
   *
   * Needed because a task may hold several claims, and dropping "the task's claims"
   * to free one scope would silently drop the rest - giving back protection the
   * caller still believes it has.
   */
  releaseClaimForScope(taskId: string, mode: ResourceClaimMode, scope: ResourceScope): number {
    const wanted = `claim:${taskId}:`;
    const key = `${mode}:${scopeKey(scope)}`;
    let released = 0;
    for (const [claimId, claim] of [...this.byClaimId]) {
      if (!claimId.startsWith(wanted) || !claimId.endsWith(key)) continue;
      this.byClaimId.delete(claimId);
      this.byWorkspace.get(claim.workspaceId)?.delete(claimId);
      released++;
    }
    this.pruneEmptyWorkspaces();
    return released;
  }

  private pruneEmptyWorkspaces(): void {
    for (const [workspaceId, set] of [...this.byWorkspace]) {
      if (set.size === 0) this.byWorkspace.delete(workspaceId);
    }
  }

  /**
   * §7.3: drop every claim whose lease is no longer current.
   *
   * The predicate is supplied by the caller, which is the ONLY way this stays honest:
   * the book has no idea what a lease is, cannot look one up, and cannot decide
   * liveness. The orchestrator - which already holds TaskStore, the lease authority -
   * passes in "is this claim's task still on its current lease?", and this simply
   * removes what the predicate rejects.
   *
   * Called before every conflict consultation, so a revoked or superseded claim can
   * never make a worker believe it still holds a writable resource (Race 4). Voiding
   * rather than ignoring is deliberate: an ignored stale claim would keep blocking
   * unrelated writers forever, which is the exact failure mode §7.3 exists to avoid.
   */
  voidClaimsWhere(isVoid: (claim: ResourceClaim) => boolean): number {
    let voided = 0;
    for (const [claimId, claim] of [...this.byClaimId]) {
      if (!isVoid(claim)) continue;
      this.byClaimId.delete(claimId);
      this.byWorkspace.get(claim.workspaceId)?.delete(claimId);
      voided++;
    }
    if (voided > 0) this.pruneEmptyWorkspaces();
    return voided;
  }

  /**
   * Would this request conflict right now? The read-only question the dispatch path
   * asks, so admission can be checked WITHOUT registering anything.
   */
  wouldConflict(request: ClaimRequest): readonly ResourceClaim[] {
    const probe: ResourceClaim = {
      claimId: `probe:${request.taskId}`,
      taskId: request.taskId,
      leaseVersion: request.leaseVersion ?? null,
      workspaceId: request.workspaceId,
      mode: request.mode,
      scope: request.scope,
      createdAt: 0,
    };
    return this.all().filter((held) => claimsConflict(held, probe));
  }

  all(): readonly ResourceClaim[] {
    return [...this.byClaimId.values()];
  }

  forWorkspace(workspaceId: string): readonly ResourceClaim[] {
    const ids = this.byWorkspace.get(workspaceId);
    if (ids === undefined) return [];
    return [...ids].map((id) => this.byClaimId.get(id)).filter((c): c is ResourceClaim => c !== undefined);
  }

  get size(): number {
    return this.byClaimId.size;
  }
}

export function describeScope(scope: ResourceScope): string {
  switch (scope.kind) {
    case 'file':
      return `file ${scope.path}`;
    case 'directory':
      return `dir ${scope.path}`;
    case 'workspace':
      return `workspace ${scope.workspaceId}`;
    case 'repository':
      return `repo ${scope.repoRoot}`;
  }
}