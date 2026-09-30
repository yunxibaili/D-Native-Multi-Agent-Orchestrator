/**
 * quota/collector.ts — Quota Providers: translate local CLI output into
 * QuotaRecords without ever inventing a number.
 *
 * Audit result (docs/PHASE4_QUOTA_AUDIT.md, 2026-09-29): none of the four
 * agents exposes provider quota (remaining / reset) through any local command.
 * So the parsers here extract what DOES exist — usage aggregates, login state,
 * model hints — and every quota record stays `remaining: null` with an honest
 * status. A failed read is `unknown`, an unqueried provider is `not_fetched`,
 * missing credentials are `not_connected`. Never 0.
 *
 * Parsing is kept pure (text/JSON in, data out) so tests never spawn a CLI;
 * `execRunner` is the only impure edge and is injectable.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LauncherResolutionError } from '../core/errors.ts';
import { resolveCommand } from '../runtime/discover.ts';
import type { Confidence, QuotaPeriod, QuotaRecord, QuotaStatus } from './types.ts';

const execFileAsync = promisify(execFile);

// ---- runner seam ---------------------------------------------------------

export interface RunOutcome {
  stdout: string;
  stderr: string;
  code: number | null;
}

export type CmdRunner = (command: string, args: readonly string[], timeoutMs?: number) => Promise<RunOutcome>;

/** The real edge. Never uses a shell; stdout/stderr captured as utf8. */
export const execRunner: CmdRunner = async (command, args, timeoutMs = 20000) => {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number | string; message?: string };
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message ?? String(e),
      code: typeof err.code === 'number' ? err.code : null,
    };
  }
};

// ---- probe shape ---------------------------------------------------------

export interface QuotaProbe {
  /** Filled by collectAll when a provider omits it; records always carry it. */
  agentId?: string;
  provider?: string;
  records: QuotaRecord[];
  /** Human login state, e.g. "logged in (api_key)". */
  login: string;
  version: string | null;
  /** Model id learned from the CLI, if any (feeds the Model Registry). */
  modelHint: string | null;
  /** Provider label learned from the CLI (e.g. codex "custom"). */
  providerHint: string | null;
  /** Non-fatal error text; record status carries the consequence. */
  error: string | null;
}

export interface QuotaProvider {
  readonly agentId: string;
  readonly provider: string;
  probe(): Promise<QuotaProbe>;
}

function baseRecord(partial: Partial<QuotaRecord> & Pick<QuotaRecord, 'provider' | 'agentId' | 'status' | 'note'>): QuotaRecord {
  return {
    modelId: null,
    source: 'none',
    usage: null,
    remaining: null,
    resetAt: null,
    period: 'unknown',
    usageClass: 'reported',
    confidence: 'high',
    observedAt: Date.now(),
    ...partial,
  };
}

// ---- pure parsers --------------------------------------------------------

/** Strip ANSI so table output parses the same piped or interactive. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/** First non-empty line, trimmed — for bare `--version` output. */
function firstLine(text: string): string | null {
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    const t = line.trim();
    if (t) return t;
  }
  return null;
}

/** "280.3M" -> 280300000, "45,745" -> 45745, "0" -> 0. null when unparseable. */
export function parseCount(raw: string): number | null {
  const clean = stripAnsi(raw).trim().replace(/,/g, '');
  const m = /^(-?\d+(?:\.\d+)?)\s*([KMBGT])?$/i.exec(clean);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, G: 1e9 };
  const suffix = m[2] ? mult[m[2].toUpperCase()] : 1;
  return Math.round(n * (suffix ?? 1));
}

/** "$19.69" -> 19.69. null when unparseable. */
export function parseMoney(raw: string): number | null {
  const clean = stripAnsi(raw).trim().replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(clean)) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

export interface OpenCodeStats {
  sessions: number | null;
  messages: number | null;
  totalCostUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
}

/** Parse `opencode stats` OVERVIEW + COST & TOKENS tables. */
export function parseOpenCodeStats(text: string): OpenCodeStats | null {
  const rows = new Map<string, string>();
  const re = /│\s*([^│]+?)\s{2,}([^│]+?)\s*│/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripAnsi(text))) !== null) {
    rows.set(m[1].trim(), m[2].trim());
  }
  if (rows.size === 0) return null;
  const pick = (label: string): number | null => {
    const v = rows.get(label);
    return v === undefined ? null : parseCount(v);
  };
  const costRaw = rows.get('Total Cost');
  return {
    sessions: pick('Sessions'),
    messages: pick('Messages'),
    totalCostUsd: costRaw === undefined ? null : parseMoney(costRaw),
    inputTokens: pick('Input'),
    outputTokens: pick('Output'),
    cacheReadTokens: pick('Cache Read'),
  };
}

/** `opencode providers list` -> credential count (the table prints no tokens). */
export function parseOpenCodeCredentialCount(text: string): number | null {
  const m = /(\d+)\s+credentials?/i.exec(stripAnsi(text));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export interface CodexDoctorInfo {
  version: string | null;
  authConfigured: boolean;
  authMode: string | null;
  model: string | null;
  modelProvider: string | null;
  overallStatus: string | null;
}

/** Parse `codex doctor --json` (explicitly a redacted report — no secrets). */
export function parseCodexDoctor(raw: string): CodexDoctorInfo | null {
  let json: unknown;
  try {
    json = JSON.parse(stripAnsi(raw));
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;
  const doc = json as Record<string, unknown>;
  const checks = (doc.checks ?? {}) as Record<string, unknown>;

  const authCheck = checks['auth.credentials'] as { status?: unknown; details?: Record<string, unknown> } | undefined;
  const configCheck = checks['config.load'] as { details?: Record<string, unknown> } | undefined;
  const authDetails = authCheck?.details ?? {};
  const configDetails = configCheck?.details ?? {};

  const authConfigured =
    authCheck?.status === 'ok' && typeof authDetails['stored API key'] === 'string'
      ? authDetails['stored API key'] === 'true' || authDetails['stored ChatGPT tokens'] === 'true'
      : false;

  const authModeRaw = authDetails['stored auth mode'] ?? authDetails['auth mode'];
  return {
    version: typeof doc.codexVersion === 'string' ? doc.codexVersion : null,
    authConfigured,
    authMode: typeof authModeRaw === 'string' ? authModeRaw : null,
    model: typeof configDetails.model === 'string' ? (configDetails.model as string) : null,
    modelProvider: typeof configDetails['model provider'] === 'string' ? (configDetails['model provider'] as string) : null,
    overallStatus: typeof doc.overallStatus === 'string' ? (doc.overallStatus as string) : null,
  };
}

// ---- providers -----------------------------------------------------------

const NO_QUOTA_NOTE =
  'No local quota endpoint: the CLI reports usage/login but never remaining/reset (audited docs/PHASE4_QUOTA_AUDIT.md, 2026-09-29).';

/** Resolve an agent's launcher, or record why it could not be queried. */
async function runViaAgent(
  agentId: string,
  configured: string | undefined,
  argv: readonly string[],
  runner: CmdRunner,
  timeoutMs?: number,
): Promise<{ ok: true; outcome: RunOutcome } | { ok: false; reason: string }> {
  try {
    const { launcher } = resolveCommand(agentId, configured);
    const outcome = await runner(launcher.command, [...launcher.prefixArgs, ...argv], timeoutMs);
    return { ok: true, outcome };
  } catch (e) {
    const reason =
      e instanceof LauncherResolutionError ? e.message : (e as Error).message;
    return { ok: false, reason };
  }
}

export class OpenCodeQuotaProvider implements QuotaProvider {
  readonly agentId = 'opencode';
  readonly provider = 'opencode';
  private readonly runner: CmdRunner;
  private readonly command?: string;

  constructor(opts: { runner?: CmdRunner; command?: string } = {}) {
    this.runner = opts.runner ?? execRunner;
    this.command = opts.command;
  }

  async probe(): Promise<QuotaProbe> {
    const stats = await runViaAgent(this.agentId, this.command, ['stats'], this.runner);
    if (!stats.ok) {
      return {
        records: [
          baseRecord({
            provider: this.provider,
            agentId: this.agentId,
            status: 'not_fetched',
            note: `OpenCode CLI not queried: ${stats.reason}`,
          }),
        ],
        login: 'Not Fetched',
        version: null,
        modelHint: null,
        providerHint: null,
        error: stats.reason,
      };
    }

    const creds = await runViaAgent(this.agentId, this.command, ['providers', 'list'], this.runner);
    const credentialCount = creds.ok ? parseOpenCodeCredentialCount(creds.outcome.stdout) : null;
    const loggedIn = credentialCount !== null && credentialCount > 0;

    const versionRun = await runViaAgent(this.agentId, this.command, ['--version'], this.runner);
    const version = versionRun.ok ? firstLine(versionRun.outcome.stdout) : null;

    const parsed = parseOpenCodeStats(stats.ok ? stats.outcome.stdout : '');
    const usage =
      parsed === null
        ? null
        : {
            inputTokens: parsed.inputTokens ?? undefined,
            outputTokens: parsed.outputTokens ?? undefined,
            cachedInputTokens: parsed.cacheReadTokens ?? undefined,
            costUsd: parsed.totalCostUsd,
            runs: parsed.sessions ?? undefined,
          };

    return {
      records: [
        baseRecord({
          provider: this.provider,
          agentId: this.agentId,
          source: 'cli_reported',
          status: loggedIn ? 'unavailable' : 'not_connected',
          usage,
          usageClass: 'reported',
          confidence: parsed ? 'high' : 'medium',
          note: loggedIn
            ? `${NO_QUOTA_NOTE} Usage is OpenCode's own local accounting (opencode stats), not a provider invoice.`
            : 'No OpenCode credentials found; no quota can exist to read.',
        }),
      ],
      login: credentialCount === null ? 'Unknown' : loggedIn ? `logged in (${credentialCount} credentials)` : 'not connected',
      version,
      modelHint: null,
      providerHint: null,
      error: parsed ? null : 'could not parse `opencode stats` output',
    };
  }
}

export class CodexQuotaProvider implements QuotaProvider {
  readonly agentId = 'codex';
  readonly provider: string;
  private readonly runner: CmdRunner;
  private readonly command?: string;

  constructor(opts: { runner?: CmdRunner; command?: string; provider?: string } = {}) {
    this.runner = opts.runner ?? execRunner;
    this.command = opts.command;
    this.provider = opts.provider ?? 'codex';
  }

  async probe(): Promise<QuotaProbe> {
    const res = await runViaAgent(this.agentId, this.command, ['doctor', '--json'], this.runner);
    if (!res.ok) {
      return {
        records: [
          baseRecord({
            provider: this.provider,
            agentId: this.agentId,
            status: 'not_fetched',
            note: `Codex CLI not queried: ${res.reason}`,
          }),
        ],
        login: 'Not Fetched',
        version: null,
        modelHint: null,
        providerHint: null,
        error: res.reason,
      };
    }
    const info = parseCodexDoctor(res.outcome.stdout);
    if (!info) {
      return {
        records: [
          baseRecord({
            provider: this.provider,
            agentId: this.agentId,
            status: 'unknown',
            note: 'Could not parse `codex doctor --json` output.',
          }),
        ],
        login: 'Unknown',
        version: null,
        modelHint: null,
        providerHint: null,
        error: 'unparseable codex doctor output',
      };
    }

    return {
      records: [
        baseRecord({
          provider: info.modelProvider ?? this.provider,
          agentId: this.agentId,
          source: 'cli_reported',
          status: info.authConfigured ? 'unavailable' : 'not_connected',
          note: info.authConfigured
            ? `${NO_QUOTA_NOTE} API-key login with a custom provider: no plan quota exists locally to read.`
            : 'Codex has no stored credentials; no quota can exist to read.',
        }),
      ],
      login: info.authConfigured ? `logged in (${info.authMode ?? 'unknown mode'})` : 'not authenticated',
      version: info.version,
      modelHint: info.model,
      providerHint: info.modelProvider,
      error: null,
    };
  }
}

export interface StaticQuotaEvidence {
  login: string;
  version: string | null;
  modelHint: string | null;
  /** Phase-3 observed login evidence, quoted with its date. */
  loginSource: string;
}

/**
 * WorkBuddy (CN/Intl) and Cline have no quota surface at all — audited, not
 * assumed. Their provider returns the audited facts and runs nothing.
 */
export class StaticQuotaProvider implements QuotaProvider {
  readonly agentId: string;
  readonly provider: string;
  private readonly evidence: StaticQuotaEvidence;
  private readonly note: string;

  constructor(agentId: string, provider: string, evidence: StaticQuotaEvidence, note: string) {
    this.agentId = agentId;
    this.provider = provider;
    this.evidence = evidence;
    this.note = note;
  }

  async probe(): Promise<QuotaProbe> {
    const connected = !/not authenticated|not connected|401/i.test(this.evidence.login);
    return {
      records: [
        baseRecord({
          provider: this.provider,
          agentId: this.agentId,
          source: 'none',
          status: connected ? 'unavailable' : 'not_connected',
          note: `${this.note} Login evidence: ${this.evidence.loginSource}`,
        }),
      ],
      login: this.evidence.login,
      version: this.evidence.version,
      modelHint: this.evidence.modelHint,
      providerHint: null,
      error: null,
    };
  }
}

// ---- aggregation ---------------------------------------------------------

export const DEFAULT_PROVIDERS: readonly QuotaProvider[] = [
  new OpenCodeQuotaProvider(),
  new CodexQuotaProvider(),
  new StaticQuotaProvider(
    'workbuddy-cn',
    'workbuddy',
    {
      login: 'not authenticated (HTTP 401, last observed 2026-09-29)',
      version: '2.137.1',
      modelHint: null,
      loginSource: 'Phase 3 sidecar run evidence (2026-09-29)',
    },
    'CodeBuddy CLI has no quota/usage command (audited --help surface 2026-09-29).',
  ),
  new StaticQuotaProvider(
    'workbuddy-intl',
    'workbuddy',
    {
      login: 'authenticated (apiKeySource www.workbuddy.ai, observed 2026-09-29)',
      version: null,
      modelHint: null,
      loginSource: 'Phase 3 sidecar run evidence (2026-09-29)',
    },
    'CodeBuddy CLI has no quota/usage command (audited --help surface 2026-09-29).',
  ),
  new StaticQuotaProvider(
    'cline',
    'cline',
    {
      login: 'authenticated (sidecar chat accepted, Phase 3 verified)',
      version: null,
      modelHint: 'cline-free/mimo-v2.6-flash',
      loginSource: 'Phase 3 real run + resume evidence (2026-09-29)',
    },
    'Cline sidecar exposes no CLI/quota surface; free-tier limits are provider-side.',
  ),
];

/** Run every provider. A provider that throws degrades to an `unknown` record. */
export async function collectAll(
  providers: readonly QuotaProvider[] = DEFAULT_PROVIDERS,
): Promise<{ probes: QuotaProbe[]; records: QuotaRecord[] }> {
  const probes: QuotaProbe[] = [];
  for (const p of providers) {
    try {
      const result = await p.probe();
      probes.push({
        ...result,
        agentId: result.agentId ?? p.agentId,
        provider: result.provider ?? p.provider,
      });
    } catch (e) {
      probes.push({
        agentId: p.agentId,
        provider: p.provider,
        records: [
          baseRecord({
            provider: p.provider,
            agentId: p.agentId,
            status: 'unknown',
            note: `provider probe failed: ${(e as Error).message}`,
          }),
        ],
        login: 'Unknown',
        version: null,
        modelHint: null,
        providerHint: null,
        error: (e as Error).message,
      });
    }
  }
  return { probes, records: probes.flatMap((p) => p.records) };
}

/** Formatting helpers shared by CLI + dashboard rows. */
export function formatReset(resetAt: number | null): string {
  if (resetAt === null) return 'Not Fetched';
  return new Date(resetAt).toISOString();
}

export function formatRemaining(remaining: number | null, status: QuotaStatus): string {
  if (remaining !== null) return String(remaining);
  // Explicit text, never "0": a null remaining is UNKNOWN, not exhausted.
  if (status === 'not_connected') return 'Not Connected';
  if (status === 'not_fetched') return 'Not Fetched';
  if (status === 'unknown') return 'Unknown';
  return 'Unavailable';
}

export type { Confidence, QuotaPeriod };
