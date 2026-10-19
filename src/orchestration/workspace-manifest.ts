/**
 * src/orchestration/workspace-manifest.ts — P0-1: a deterministic before/after view
 * of a real workspace directory.
 *
 * ============================================================================
 * WHAT THIS IS
 * ============================================================================
 * A bounded, synchronous walk of one directory tree that records, for every regular
 * file and directory, its kind, size and a CONTENT HASH. Comparing two such snapshots
 * yields exactly the files an attempt ADDED, MODIFIED or DELETED — including files
 * that are `.gitignore`d, untracked, or were already dirty before the attempt.
 *
 * WHY NOT GIT
 * -----------
 * `git status`/`HEAD` cannot see ignored output, cannot see a file an agent created
 * and deleted mid-run, and cannot describe a workspace that is not a repo at all
 * (a `mode:'none'` round). This walks the actual bytes. It is NOT a sandbox and it
 * does not claim a transient outside write never happened; it reports the durable
 * before/after difference, which is what a completion decision needs.
 *
 * SAFETY RULES (fail-closed)
 * --------------------------
 *   - symbolic links and NTFS junctions/reparse points are DETECTED and make the
 *     manifest `safe: false`; they are never followed, so no walk escapes the root;
 *   - the ROOT itself is `lstat`ed and a link/junction root is refused rather than
 *     followed, so the reported artifacts cannot be an alias for another directory;
 *   - EVERY ANCESTOR of the root is `lstat`ed too (metadata only — no parent listing,
 *     no content read), so a root reached THROUGH a junction/symlink is refused rather
 *     than silently reported as the aliased directory;
 *   - every regular file is content-hashed, in bounded chunks, however large it is.
 *     A file that cannot be read/hashed makes the manifest UNSAFE rather than being
 *     reported as unchanged from its size alone — there is no size/mtime-only
 *     certificate;
 *   - the canonical PHYSICAL identity of the root is part of the digest, so two
 *     manifests of different physical directories can never compare equal;
 *   - the walk never ascends or scans a parent/sibling directory;
 *   - NOTHING is excluded by name. A top-level `.git` is not assumed to be
 *     orchestrator-owned: an unapproved write inside it is a change like any other.
 */

import { createHash } from 'node:crypto';
import {
  closeSync, lstatSync, openSync, readSync, readdirSync, readlinkSync, realpathSync,
} from 'node:fs';
import { join, parse, resolve } from 'node:path';

export type ManifestKind = 'file' | 'dir' | 'symlink' | 'other';

export interface ManifestEntry {
  readonly kind: ManifestKind;
  readonly size: number;
  readonly mtimeMs: number;
  /** Content digest for a regular file. Always populated for a safe manifest. */
  readonly hash: string;
}

export interface WorkspaceManifest {
  readonly root: string;
  /**
   * The canonical PHYSICAL directory the walk actually visited, from `realpath`.
   * Part of the digest. Null when the root could not be resolved (unsafe).
   */
  readonly physicalRoot: string | null;
  readonly entries: ReadonlyMap<string, ManifestEntry>;
  /** False when a link/reparse point was found (or the root itself was unusable). */
  readonly safe: boolean;
  /** Why the manifest is not safe, or null. */
  readonly reason: string | null;
  /** Files only, relative paths with forward slashes, in the walk's stable order. */
  readonly files: readonly string[];
}

export interface ManifestOptions {
  /**
   * Top-level names to skip. The caller owns the boundary; the default is EMPTY. A
   * name-only `.git` exclusion would hide an unapproved write inside `.git` (including
   * in a workspace that is not a repo), so nothing is excluded by default.
   */
  readonly excludeTopLevel?: readonly string[];
  /** @deprecated retained for callers; content hashing is no longer size-capped. */
  readonly hashMaxBytes?: number;
  /** Read chunk size for content hashing (bounded memory). Default 1 MiB. */
  readonly hashChunkBytes?: number;
}

const DEFAULT_EXCLUDE: readonly string[] = [];
const DEFAULT_HASH_CHUNK = 1024 * 1024;

/**
 * Is `full` a reparse point (symlink or junction)? Never throws; an unreadable entry
 * is reported as a link rather than silently treated as an ordinary file.
 *
 * `isDir` selects the junction probe: on Windows a directory junction is not an
 * `isSymbolicLink()` but IS readable by `readlink`, so a directory is probed both ways.
 */
function isLink(full: string, _isDir: boolean): boolean {
  try {
    const st = lstatSync(full);
    if (st.isSymbolicLink()) return true;
  } catch {
    return true;
  }
  try {
    readlinkSync(full);
    return true;
  } catch {
    return false;
  }
}

/** True when a path is itself a reparse point (symlink or Windows junction). */
function isReparsePoint(full: string): boolean {
  try {
    if (lstatSync(full).isSymbolicLink()) return true;
  } catch {
    return true;
  }
  try {
    readlinkSync(full);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hash a regular file's ACTUAL contents in bounded chunks. Returns null on any read
 * failure so the caller can fail closed instead of trusting a size.
 */
function hashFileContents(full: string, chunkBytes: number): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(full, 'r');
    const hash = createHash('sha256');
    const buf = Buffer.allocUnsafe(Math.max(1, chunkBytes));
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
    }
    return hash.digest('hex');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

/**
 * Walk `root` upward through its RELATIVE segments, `lstat`ing every prefix, and
 * report true as soon as a link/junction is found. This is how a caller proves that
 * a path (e.g. an approved test's cwd) does not traverse a reparse point before it is
 * used, rather than assuming "safe" after a stat that FOLLOWED the link.
 */
export function relativePathCrossesLink(root: string, relative: string): boolean {
  const segments = relative.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
  let cur = root;
  for (const seg of segments) {
    cur = join(cur, seg);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      // Missing is not "crosses a link", but it is not safe to claim a path either;
      // the caller validates existence separately.
      return false;
    }
    if (st.isSymbolicLink()) return true;
    try { readlinkSync(cur); return true; } catch { /* ordinary entry */ }
  }
  return false;
}

/**
 * The first ANCESTOR prefix of `root` (strictly above the root itself) that is a
 * symbolic link or NTFS junction/reparse point, or null when every ancestor is an
 * ordinary directory.
 *
 * `lstatSync(root)` alone misses this: the OS resolves INTERMEDIATE components while
 * walking to the final one, so a root such as `alias/child`, where `alias` is a
 * junction, stats as an ordinary directory. Only metadata (`lstat`) is read for each
 * prefix — no directory is listed and no file content is touched.
 */
export function firstReparseAncestor(root: string): string | null {
  const absolute = resolve(root);
  const parsed = parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(/[\\/]+/).filter((s) => s !== '');
  let current = parsed.root;
  for (let i = 0; i < segments.length - 1; i++) {
    current = join(current, segments[i]!);
    if (isReparsePoint(current)) return current;
  }
  return null;
}

/**
 * Capture a manifest. Synchronous so it can be taken inside the orchestrator's
 * pre-runtime baseline step and re-taken at the synchronous completion commit without
 * introducing a new await into either region.
 */
export function captureWorkspaceManifest(root: string, options: ManifestOptions = {}): WorkspaceManifest {
  const exclude = new Set(options.excludeTopLevel ?? DEFAULT_EXCLUDE);
  const chunkBytes = options.hashChunkBytes ?? DEFAULT_HASH_CHUNK;
  const entries = new Map<string, ManifestEntry>();
  const files: string[] = [];
  let safe = true;
  let reason: string | null = null;
  let physicalRoot: string | null = null;

  const fail = (r: string): void => {
    safe = false;
    if (reason === null) reason = r;
  };

  const walk = (dir: string, relPrefix: string, topLevel: boolean): void => {
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      fail(`could not read "${relPrefix || '.'}": ${(e as Error).message}`);
      return;
    }
    // Stable, case-insensitive order so two captures of the same tree agree.
    dirents.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));
    for (const d of dirents) {
      if (topLevel && exclude.has(d.name)) continue;
      const full = join(dir, d.name);
      const rel = relPrefix === '' ? d.name : `${relPrefix}/${d.name}`;
      let st;
      try {
        st = lstatSync(full);
      } catch (e) {
        fail(`could not stat "${rel}": ${(e as Error).message}`);
        continue;
      }
      const isDir = st.isDirectory();
      if (isLink(full, isDir)) {
        entries.set(rel, { kind: 'symlink', size: st.size, mtimeMs: st.mtimeMs, hash: '' });
        fail(`"${rel}" is a symbolic link or reparse point and is not followed`);
        continue;
      }
      if (isDir) {
        entries.set(rel, { kind: 'dir', size: 0, mtimeMs: st.mtimeMs, hash: '' });
        walk(full, rel, false);
      } else if (st.isFile()) {
        const hash = hashFileContents(full, chunkBytes);
        if (hash === null) {
          // FAIL CLOSED: a file we cannot hash cannot be certified as unchanged.
          entries.set(rel, { kind: 'file', size: st.size, mtimeMs: st.mtimeMs, hash: '' });
          files.push(rel);
          fail(`could not read/hash "${rel}"; the artifact set cannot be certified`);
        } else {
          entries.set(rel, { kind: 'file', size: st.size, mtimeMs: st.mtimeMs, hash });
          files.push(rel);
        }
      } else {
        entries.set(rel, { kind: 'other', size: st.size, mtimeMs: st.mtimeMs, hash: '' });
      }
    }
  };

  // The ROOT is lstat'ed first (never followed through a stat): a link/junction root
  // would make every relative path an alias for a directory that was never given.
  let rootStat: ReturnType<typeof lstatSync> | undefined;
  try {
    rootStat = lstatSync(root);
  } catch (e) {
    fail(`workspace root "${root}" is unreadable: ${(e as Error).message}`);
  }
  if (safe && rootStat !== undefined) {
    if (isReparsePoint(root)) {
      fail(`workspace root "${root}" is a symbolic link or reparse point; its artifacts cannot be trusted`);
    } else if (!rootStat.isDirectory()) {
      fail(`workspace root "${root}" is not a directory`);
    }
  }
  // An ancestor reparse point aliases the ROOT itself, which a root-only `lstat`
  // cannot see. Refuse before walking or resolving the physical identity.
  if (safe) {
    const badAncestor = firstReparseAncestor(root);
    if (badAncestor !== null) {
      fail(`workspace root "${root}" is reached through symbolic link/reparse point "${badAncestor}"; its artifacts cannot be trusted`);
    }
  }
  if (safe) {
    try {
      physicalRoot = realpathSync(root);
    } catch (e) {
      fail(`could not resolve the physical workspace root "${root}": ${(e as Error).message}`);
    }
  }
  if (safe) walk(root, '', true);

  return Object.freeze({
    root,
    physicalRoot,
    entries,
    safe,
    reason,
    files: Object.freeze([...files]),
  });
}

export interface ManifestDiff {
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
}

/**
 * The durable FILE-level difference between two manifests.
 *
 * Directories are structural and are deliberately NOT reported: adding `src/server/x.ts`
 * necessarily creates the `src` and `src/server` directories too, and reporting those as
 * "changes" would make every scoped write outside its own directory prefix. Only regular
 * files are compared — by their content hash.
 */
export function diffWorkspaceManifest(before: WorkspaceManifest, after: WorkspaceManifest): ManifestDiff {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [rel, a] of after.entries) {
    if (a.kind !== 'file') continue;
    const b = before.entries.get(rel);
    if (b === undefined || b.kind !== 'file') added.push(rel);
    else if (b.hash !== a.hash) modified.push(rel);
  }
  for (const [rel, b] of before.entries) {
    if (b.kind !== 'file') continue;
    const a = after.entries.get(rel);
    if (a === undefined || a.kind !== 'file') deleted.push(rel);
  }
  return {
    added: Object.freeze(added.sort()),
    modified: Object.freeze(modified.sort()),
    deleted: Object.freeze(deleted.sort()),
  };
}

/**
 * A stable digest of the whole manifest (safe manifests only).
 *
 * The PHYSICAL root identity and every file's CONTENT hash are included, so a
 * same-size rewrite always changes the digest and two different directories can
 * never produce the same value. An unsafe manifest has NO digest (null).
 */
export function manifestDigest(manifest: WorkspaceManifest): string | null {
  if (!manifest.safe || manifest.physicalRoot === null) return null;
  const lines: string[] = [`root\u0000${manifest.physicalRoot.replace(/\\/g, '/').toLowerCase()}`];
  for (const [rel, e] of [...manifest.entries.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    // Directories/symlinks/other carry no content hash; their kind is enough. Files
    // must have a hash to reach here (unsafe otherwise), so this is never size-only.
    lines.push(`${rel}\u0000${e.kind}\u0000${e.size}\u0000${e.hash}`);
  }
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}
