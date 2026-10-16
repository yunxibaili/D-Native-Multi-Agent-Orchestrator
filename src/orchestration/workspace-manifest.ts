/**
 * src/orchestration/workspace-manifest.ts — P0-1: a deterministic before/after view
 * of a real workspace directory.
 *
 * ============================================================================
 * WHAT THIS IS
 * ============================================================================
 * A bounded, synchronous walk of one directory tree that records, for every regular
 * file and directory, its kind, size and a content hash. Comparing two such snapshots
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
 *   - the walk never ascends or scans a parent/sibling directory;
 *   - only known orchestrator-owned metadata (default: the top-level `.git`) is
 *     excluded; nothing is skipped merely because it looks generated or ignored.
 */

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type ManifestKind = 'file' | 'dir' | 'symlink' | 'other';

export interface ManifestEntry {
  readonly kind: ManifestKind;
  readonly size: number;
  readonly mtimeMs: number;
  /** Content digest for a regular file within the hash cap; '' otherwise. */
  readonly hash: string;
}

export interface WorkspaceManifest {
  readonly root: string;
  readonly entries: ReadonlyMap<string, ManifestEntry>;
  /** False when a link/reparse point was found (or the root itself was unusable). */
  readonly safe: boolean;
  /** Why the manifest is not safe, or null. */
  readonly reason: string | null;
  /** Files only, relative paths with forward slashes, in the walk's stable order. */
  readonly files: readonly string[];
}

export interface ManifestOptions {
  /** Top-level names to skip. The caller owns the boundary; the default is `.git`. */
  readonly excludeTopLevel?: readonly string[];
  /** Files larger than this are recorded by size+mtime only (no content hash). */
  readonly hashMaxBytes?: number;
}

const DEFAULT_EXCLUDE = ['.git'];
const DEFAULT_HASH_MAX = 8 * 1024 * 1024;

/**
 * Is `full` a reparse point (symlink or junction)? Never throws; an unreadable entry
 * is reported as a link rather than silently treated as an ordinary file.
 */
function isLink(full: string, isDir: boolean): boolean {
  try {
    const st = lstatSync(full);
    if (st.isSymbolicLink()) return true;
  } catch {
    return true;
  }
  if (isDir) {
    // A directory junction / reparse point is readable by readlink on Windows even
    // though lstat does not report it as a symlink.
    try {
      readlinkSync(full);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function hashFile(full: string, maxBytes: number): string {
  try {
    const st = statSync(full);
    if (st.size > maxBytes) return '';
    const buf = readFileSync(full);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return '';
  }
}

/**
 * Capture a manifest. Synchronous so it can be taken inside the orchestrator's
 * pre-runtime baseline step and re-taken at the synchronous completion commit without
 * introducing a new await into either region.
 */
export function captureWorkspaceManifest(root: string, options: ManifestOptions = {}): WorkspaceManifest {
  const exclude = new Set(options.excludeTopLevel ?? DEFAULT_EXCLUDE);
  const hashMax = options.hashMaxBytes ?? DEFAULT_HASH_MAX;
  const entries = new Map<string, ManifestEntry>();
  const files: string[] = [];
  let safe = true;
  let reason: string | null = null;

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
        entries.set(rel, { kind: 'file', size: st.size, mtimeMs: st.mtimeMs, hash: hashFile(full, hashMax) });
        files.push(rel);
      } else {
        entries.set(rel, { kind: 'other', size: st.size, mtimeMs: st.mtimeMs, hash: '' });
      }
    }
  };

  try {
    const rootStat = statSync(root);
    if (!rootStat.isDirectory()) fail(`workspace root "${root}" is not a directory`);
  } catch (e) {
    fail(`workspace root "${root}" is unreadable: ${(e as Error).message}`);
  }
  if (safe) walk(root, '', true);

  return Object.freeze({
    root,
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

function entryChanged(before: ManifestEntry, after: ManifestEntry): boolean {
  if (before.kind !== after.kind) return true;
  if (before.kind === 'file') {
    // Prefer the content hash; fall back to size when a large file was not hashed.
    if (before.hash !== '' && after.hash !== '') return before.hash !== after.hash;
    return before.size !== after.size || before.mtimeMs !== after.mtimeMs;
  }
  return false;
}

/** The durable file-level difference between two manifests. */
export function diffWorkspaceManifest(before: WorkspaceManifest, after: WorkspaceManifest): ManifestDiff {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [rel, a] of after.entries) {
    const b = before.entries.get(rel);
    if (b === undefined) added.push(rel);
    else if (entryChanged(b, a)) modified.push(rel);
  }
  for (const [rel] of before.entries) {
    if (!after.entries.has(rel)) deleted.push(rel);
  }
  return {
    added: Object.freeze(added.sort()),
    modified: Object.freeze(modified.sort()),
    deleted: Object.freeze(deleted.sort()),
  };
}

/** A stable digest of the whole manifest (safe manifests only). */
export function manifestDigest(manifest: WorkspaceManifest): string | null {
  if (!manifest.safe) return null;
  const lines: string[] = [];
  for (const [rel, e] of [...manifest.entries.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    lines.push(`${rel}\u0000${e.kind}\u0000${e.size}\u0000${e.hash}`);
  }
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}
