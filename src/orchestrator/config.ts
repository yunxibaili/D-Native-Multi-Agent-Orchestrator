/**
 * orchestrator/config.ts — config discovery, following native-agent-router's
 * four-step chain: explicit flag -> env var -> home file -> built-in defaults.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BadConfigError } from '../core/errors.ts';
import { log } from '../core/log.ts';
import type { SelectionSpec } from '../core/types.ts';

export interface AgentConfig {
  /** Absolute path OR a bare name to look up on PATH. */
  command?: string;
  /** Default model passed through verbatim. e.g. "opencode/space-bunny-free" */
  model?: string;
  /** Default native role/agent/profile. */
  role?: string;
  /** Default sandbox mode (Codex only). */
  sandbox?: string;
  /** Default cwd for runs. */
  cwd?: string;
  /** Default per-run timeout in ms. */
  timeoutMs?: number;
}

export interface OrchestratorConfig {
  agents: Record<string, AgentConfig>;
  /** Where transcripts are written. */
  storeDir?: string;
  /**
   * B1.4: the PROJECT's default Agent × Model selection. A task-level selection
   * overrides it; when neither is set the existing LAYA/auto behaviour applies.
   * A `fixed` pair is enforced by Assignment exactly like an explicit pair.
   */
  selection?: SelectionSpec;
}

export const DEFAULT_STORE_DIR = join(homedir(), '.native-agent-orchestrator');
export const CONFIG_FILENAME = 'orchestrator.json';

export function configSearchPaths(explicit?: string): string[] {
  const home = join(homedir(), '.native-agent-orchestrator');
  const paths: string[] = [];
  if (explicit) paths.push(explicit);
  if (process.env.ORCH_CONFIG) paths.push(process.env.ORCH_CONFIG);
  paths.push(join(process.cwd(), CONFIG_FILENAME));
  paths.push(join(home, CONFIG_FILENAME));
  paths.push(join(home, 'config.json'));
  return paths;
}

export function loadConfig(explicit?: string): { config: OrchestratorConfig; source: string | null } {
  for (const p of configSearchPaths(explicit)) {
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as unknown;
      return { config: validate(parsed, p), source: p };
    } catch (e) {
      if (e instanceof BadConfigError) throw e;
      throw new BadConfigError(`${p}: ${(e as Error).message}`);
    }
  }
  return { config: { agents: {} }, source: null };
}

function validate(raw: unknown, source: string): OrchestratorConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new BadConfigError(`${source}: top level must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.agents !== undefined && (typeof obj.agents !== 'object' || obj.agents === null)) {
    throw new BadConfigError(`${source}: "agents" must be an object`);
  }
  const agents: Record<string, AgentConfig> = {};
  for (const [id, value] of Object.entries((obj.agents ?? {}) as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) {
      throw new BadConfigError(`${source}: agents.${id} must be an object`);
    }
    agents[id] = value as AgentConfig;
  }
  const selection = validateSelection(obj.selection, source);
  if (typeof obj.storeDir === 'string') {
    return { agents, storeDir: obj.storeDir, ...(selection === undefined ? {} : { selection }) };
  }
  return { agents, ...(selection === undefined ? {} : { selection }) };
}

/**
 * B1.4: validate the project's default selection. A `fixed` pair is ATOMIC — both a
 * non-empty agentId and a non-empty modelId — and the model id is kept verbatim (no
 * provider is prepended, nothing is trimmed into a different id). An unknown mode is
 * refused rather than guessed.
 */
function validateSelection(raw: unknown, source: string): SelectionSpec | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BadConfigError(`${source}: "selection" must be an object`);
  }
  const sel = raw as Record<string, unknown>;
  if (sel.mode === 'auto') return { mode: 'auto' };
  if (sel.mode === 'fixed') {
    if (typeof sel.agentId !== 'string' || sel.agentId.trim() === '') {
      throw new BadConfigError(`${source}: selection.agentId must be a non-empty string`);
    }
    if (typeof sel.modelId !== 'string' || sel.modelId.trim() === '') {
      throw new BadConfigError(`${source}: selection.modelId must be a non-empty string (a fixed pair is atomic)`);
    }
    return { mode: 'fixed', agentId: sel.agentId, modelId: sel.modelId };
  }
  throw new BadConfigError(`${source}: selection.mode must be "auto" or "fixed", got ${JSON.stringify(sel.mode)}`);
}

/** Write a starter config. Never overwrites an existing one. */
export function writeStarterConfig(dir = DEFAULT_STORE_DIR): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, CONFIG_FILENAME);
  if (existsSync(p)) return p;
  const starter: OrchestratorConfig = {
    agents: {
      opencode: {
        // npm's PATH shim is opencode.CMD / opencode.ps1, which Node cannot
        // exec without a shell. Point at the packaged binary instead.
        command: join(
          process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
          'npm',
          'node_modules',
          'opencode-ai',
          'bin',
          'opencode.exe',
        ),
        // OpenCode's own config may point at a local provider that is not
        // running. Naming a model here makes `run` work regardless.
        model: 'opencode/space-bunny-free',
        cwd: process.cwd(),
        timeoutMs: 15 * 60 * 1000,
      },
      codex: {
        // Codex is NOT on PATH; it ships with the desktop app.
        command: join(homedir(), '.codex', 'plugins', '.plugin-appserver', 'codex.exe'),
        cwd: process.cwd(),
        sandbox: 'workspace-write',
        timeoutMs: 20 * 60 * 1000,
      },
    },
  };
  writeFileSync(p, JSON.stringify(starter, null, 2), 'utf8');
  log.info('wrote starter config', { path: p });
  return p;
}
