/**
 * memory/config.ts — F1: make the backend address EXPLICIT or refuse to start.
 *
 * The PoC's worst finding was silent. Hindsight's own default is
 * `DEFAULT_DATABASE_URL = "pg0"`, an embedded database whose name is derived
 * from the URL. Launch the API without pinning the URL and you get a
 * DIFFERENT, EMPTY database on a different port — while the old one still sits
 * on disk holding your memories. Nothing errors. Recall just 404s, and
 * previously-written banks "vanish".
 *
 * That is the exact failure this module exists to make impossible. Rules:
 *
 *   1. `databaseUrl` is REQUIRED. Absent -> configuration error. There is no
 *      fallback, no default, and no "figure it out at runtime".
 *   2. `apiUrl` is REQUIRED, and must be an explicit loopback/http(s) URL.
 *   3. The database URL must be visibly non-default. A bare `pg0` is rejected
 *      with a pointed message, because that is the value that caused F1.
 *   4. `projectMemoryId` is REQUIRED (see bank.ts) — identity is never guessed.
 *   5. Nothing here reaches the network. Validation is total and synchronous so
 *      a misconfiguration is caught before any process is launched.
 *
 * Config resolution order is explicit file -> environment -> nothing. There is
 * no "derive it from the current directory": the PoC proved basename-derived
 * identity collides.
 */

import type { MemoryError, MemoryResult } from './types.ts';

export interface MemoryConfig {
  /** Full base URL of the Hindsight API, e.g. http://127.0.0.1:8889. */
  apiUrl: string;
  /**
   * Full database URL INCLUDING the instance name, e.g.
   * pg0://hindsight-embed-local-coding-orchestrator. Must be explicit.
   */
  databaseUrl: string;
  /**
   * Stable project identity. Must be identical for every worktree of one
   * project, and different across projects. Never a directory basename.
   */
  projectMemoryId: string;
  /**
   * Where the memory BACKEND's application/runtime lives, e.g. D:\AI\hindsight.
   * Recorded, not used by this layer: the layer never launches the backend, but
   * the ADAPT deployment keeps it here so the location is explicit rather than
   * implied by wherever something happened to be installed.
   */
  appDir: string | null;
  /**
   * Where the memory DATABASE data lives, e.g. D:\AI\hindsight-data. Optional
   * (the backend may manage its own storage), but when given it is validated:
   * a memory database must never live inside a Git repository, because that
   * would put memory data under version control.
   */
  dataDir: string | null;
  /** Optional agent label recorded on writes; 'unknown' when absent. */
  defaultAgentId?: string;
  /** Wall-clock budget for one backend call. */
  timeoutMs: number;
  /** Which environment variable set the database URL (for auditability). */
  databaseUrlSource: string;
  configSource: string;
}

export interface MemoryConfigInput {
  apiUrl?: string | undefined;
  databaseUrl?: string | undefined;
  projectMemoryId?: string | undefined;
  appDir?: string | undefined;
  dataDir?: string | undefined;
  defaultAgentId?: string | undefined;
  timeoutMs?: number | undefined;
  configSource?: string | undefined;
  databaseUrlSource?: string | undefined;
}

/** The literal that causes F1 when left implicit. */
export const IMPLICIT_DATABASE_URL = 'pg0';

/**
 * A project id must survive path separators, be stable, and stay legible. This
 * is intentionally narrower than "any string": a value containing a path
 * separator or a drive letter is almost always a cwd that leaked in.
 */
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,62}$/;

function fail(code: MemoryError['code'], reason: string, retryable = false): MemoryError {
  return { code, reason, retryable };
}

/**
 * Validate an explicit database URL. We do not verify it is reachable — that is
 * a runtime concern producing `memory-backend-unavailable` — but we do refuse
 * the implicit default that caused F1.
 */
export function validateDatabaseUrl(raw: string | undefined): MemoryError | null {
  if (raw === undefined || raw.trim() === '') {
    return fail(
      'memory-config-invalid',
      'database URL is required: Hindsight would otherwise fall back to its implicit default ' +
        `"${IMPLICIT_DATABASE_URL}" and open a DIFFERENT, empty embedded database, silently orphaning existing memory`,
    );
  }
  const value = raw.trim();
  if (value === IMPLICIT_DATABASE_URL) {
    return fail(
      'memory-config-invalid',
      `database URL "${IMPLICIT_DATABASE_URL}" is Hindsight's implicit default and is rejected: ` +
        'it names no instance, so a restart can silently point at a different database. ' +
        'Pin an explicit instance URL, e.g. pg0://hindsight-embed-<projectMemoryId>',
    );
  }
  if (!/^[a-z0-9+.-]+:\/\/.+/.test(value)) {
    return fail(
      'memory-config-invalid',
      `database URL "${value}" must be a full URL with scheme and instance, e.g. pg0://hindsight-embed-myproject`,
    );
  }
  // A pg0 URL with no instance segment is the same defect wearing a scheme.
  if (value.startsWith('pg0://')) {
    const instance = value.slice('pg0://'.length).replace(/^.*@/, '').split(':')[0];
    if (instance === '' || instance === undefined) {
      return fail(
        'memory-config-invalid',
        `database URL "${value}" names no pg0 instance; add one, e.g. pg0://hindsight-embed-${'myproject'}`,
      );
    }
  }
  return null;
}

export function validateApiUrl(raw: string | undefined): MemoryError | null {
  if (raw === undefined || raw.trim() === '') {
    return fail('memory-config-invalid', 'API URL is required: the memory backend address must be explicit');
  }
  const value = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail('memory-config-invalid', `API URL "${value}" is not a valid absolute URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return fail('memory-config-invalid', `API URL "${value}" must use http or https, got "${parsed.protocol}"`);
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    return fail(
      'memory-config-invalid',
      `API URL "${value}" must be a bare origin; put any base path in HINDSIGHT_API_BASE_PATH instead`,
    );
  }
  return null;
}

export function validateProjectMemoryId(raw: string | undefined): MemoryError | null {
  if (raw === undefined || raw.trim() === '') {
    return fail(
      'memory-project-id-required',
      'projectMemoryId is required: memory identity must never be derived from a directory name, ' +
        'because two unrelated projects with the same basename would share one bank',
    );
  }
  const value = raw.trim();
  if (value !== value.toLowerCase()) {
    return fail('memory-config-invalid', `projectMemoryId "${value}" must be lowercase for stable bank ids`);
  }
  if (!PROJECT_ID_PATTERN.test(value)) {
    return fail(
      'memory-config-invalid',
      `projectMemoryId "${value}" must match ${PROJECT_ID_PATTERN} (3-63 chars, lowercase letters, digits, . _ -); ` +
        'no spaces, no path separators, no drive letters',
    );
  }
  return null;
}

/**
 * Validate an explicit data/database directory (§3). We do not create anything
 * here — the layer records where memory data lives and refuses one unsafe
 * placement: a memory DATABASE inside a Git repository would be committed to
 * version control. A non-system path is RECOMMENDED, not forced, because the
 * backend may legitimately own its own storage; the hard rule is the Git guard
 * and "never hardcoded into Runtime" (i.e. config, not a literal in code).
 */
export function validateDataDir(raw: string | undefined): MemoryError | null {
  if (raw === undefined || raw.trim() === '') return null; // optional
  const value = raw.trim();
  if (!/^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(value)) {
    return fail(
      'memory-config-invalid',
      `dataDir "${value}" must be an absolute path (e.g. D:\\AI\\hindsight-data)`,
    );
  }
  const normalized = value.replace(/[\\/]+$/, '').toLowerCase();
  const segments = normalized.split(/[\\/]/).filter((s) => s.length > 0);
  if (segments.includes('.git')) {
    return fail(
      'memory-config-invalid',
      `dataDir "${value}" is inside a Git repository (.git in path): memory data must never be committed to version control`,
    );
  }
  return null;
}

/**
 * Build a validated config, or return the FIRST configuration error. Errors are
 * returned rather than thrown so a caller can degrade instead of crashing a run.
 */
export function resolveConfig(input: MemoryConfigInput): MemoryResult<MemoryConfig> {
  const apiErr = validateApiUrl(input.apiUrl);
  if (apiErr) return { ok: false, status: 'degraded', value: null, degraded: apiErr, usage: null };

  const dbErr = validateDatabaseUrl(input.databaseUrl);
  if (dbErr) return { ok: false, status: 'degraded', value: null, degraded: dbErr, usage: null };

  const projectErr = validateProjectMemoryId(input.projectMemoryId);
  if (projectErr) return { ok: false, status: 'degraded', value: null, degraded: projectErr, usage: null };

  const dataDirErr = validateDataDir(input.dataDir);
  if (dataDirErr) return { ok: false, status: 'degraded', value: null, degraded: dataDirErr, usage: null };

  const timeoutMs = input.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return {
      ok: false,
      status: 'degraded',
      value: null,
      degraded: fail('memory-config-invalid', `timeoutMs must be a positive number, got ${String(input.timeoutMs)}`),
      usage: null,
    };
  }

  return {
    ok: true,
    status: 'ok',
    degraded: null,
    usage: null,
    value: {
      apiUrl: (input.apiUrl as string).trim().replace(/\/+$/, ''),
      databaseUrl: (input.databaseUrl as string).trim(),
      projectMemoryId: (input.projectMemoryId as string).trim(),
      appDir: input.appDir === undefined || input.appDir.trim() === '' ? null : input.appDir.trim(),
      dataDir: input.dataDir === undefined || input.dataDir.trim() === '' ? null : input.dataDir.trim(),
      ...(input.defaultAgentId !== undefined ? { defaultAgentId: input.defaultAgentId } : {}),
      timeoutMs,
      databaseUrlSource: input.databaseUrlSource ?? 'explicit',
      configSource: input.configSource ?? 'explicit',
    },
  };
}

/** Env var names the ADAPT layer reads. Each is required unless noted. */
export const MEMORY_ENV = {
  apiUrl: 'HINDSIGHT_API_URL',
  databaseUrl: 'HINDSIGHT_DATABASE_URL',
  projectMemoryId: 'HINDSIGHT_PROJECT_MEMORY_ID',
  agentId: 'HINDSIGHT_AGENT_ID',
  timeoutMs: 'HINDSIGHT_TIMEOUT_MS',
  /** Optional: where the backend's application/runtime lives. */
  appDir: 'HINDSIGHT_APP_DIR',
  /** Optional: where the memory database data lives. Non-system recommended. */
  dataDir: 'HINDSIGHT_DATA_DIR',
} as const;

/**
 * Resolve config from an environment map. Every value is explicit; the layer
 * never falls back to a default, and reports which variable was missing.
 */
export function resolveConfigFromEnv(
  env: Record<string, string | undefined>,
): MemoryResult<MemoryConfig> {
  const databaseUrl = env[MEMORY_ENV.databaseUrl];
  const missing: string[] = [];
  if (databaseUrl === undefined) missing.push(MEMORY_ENV.databaseUrl);
  if (env[MEMORY_ENV.apiUrl] === undefined) missing.push(MEMORY_ENV.apiUrl);
  if (env[MEMORY_ENV.projectMemoryId] === undefined) missing.push(MEMORY_ENV.projectMemoryId);

  if (missing.length > 0) {
    return {
      ok: false,
      status: 'degraded',
      value: null,
      degraded: fail(
        'memory-config-invalid',
        `missing required environment: ${missing.join(', ')} — the memory layer refuses to start rather than ` +
          'fall back to an implicit database or a guessed project identity',
      ),
      usage: null,
    };
  }

  const timeoutRaw = env[MEMORY_ENV.timeoutMs];
  return resolveConfig({
    apiUrl: env[MEMORY_ENV.apiUrl],
    databaseUrl,
    projectMemoryId: env[MEMORY_ENV.projectMemoryId],
    ...(env[MEMORY_ENV.appDir] !== undefined ? { appDir: env[MEMORY_ENV.appDir] } : {}),
    ...(env[MEMORY_ENV.dataDir] !== undefined ? { dataDir: env[MEMORY_ENV.dataDir] } : {}),
    ...(env[MEMORY_ENV.agentId] !== undefined ? { defaultAgentId: env[MEMORY_ENV.agentId] } : {}),
    ...(timeoutRaw !== undefined ? { timeoutMs: Number(timeoutRaw) } : {}),
    databaseUrlSource: `env:${MEMORY_ENV.databaseUrl}`,
    configSource: 'env',
  });
}
