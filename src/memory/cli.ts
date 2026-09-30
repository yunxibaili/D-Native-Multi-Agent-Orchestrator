/**
 * memory/cli.ts — a tiny agent-facing front door to the MemoryGateway.
 *
 * This is a standalone entry (`node src/memory/cli.ts ...`), deliberately NOT
 * part of src/cli/index.ts: the ADAPT layer is not wired into the orchestrator
 * this round, and the agents under test must reach memory only through the
 * policy layer — never by talking to Hindsight directly.
 *
 * Every value comes from the environment and is validated by resolveConfig, so a
 * missing or implicit database URL fails here exactly as it should (§4): a
 * configuration error, never a new empty database.
 *
 * Commands print one compact line (or a bounded block) that an agent can quote
 * verbatim. On ANY failure — including the backend being down — the exit code is
 * 0 and the output says DEGRADED with a machine code, because memory failure
 * must never be mistaken for a task failure (§21).
 */

import { readFileSync } from 'node:fs';
import { MemoryGateway } from './index.ts';
import { resolveConfigFromEnv, MEMORY_ENV } from './config.ts';
import { MemoryUsageLedger, resolveBudgetSource } from './budget.ts';
import { QuotaBudgetPort } from './quota-adapter.ts';
import type { MemoryKind, MemoryWrite } from './types.ts';

function out(line: string): void {
  process.stdout.write(line + '\n');
}

/**
 * Read retained content from a UTF-8 file when --contentFile is used. This lets
 * an agent pass the text through ONE shell (write the file, then call the CLI)
 * instead of quoting it through two, which is the quoting trap the PoC kept
 * hitting. `--content` still works for simple, space-free content.
 */
function readContent(flags: Record<string, string>): string {
  if (flags.contentFile !== undefined) {
    try {
      return readFileSync(flags.contentFile, 'utf8').trim();
    } catch (e) {
      return `<<could not read contentFile ${flags.contentFile}: ${e instanceof Error ? e.message : String(e)}>>`;
    }
  }
  return flags.content ?? '';
}

function parseArgs(argv: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[arg.slice(2)] = next;
          i++;
        } else {
          flags[arg.slice(2)] = 'true';
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    out('USAGE: memory <status|retain|recall|invalidate> [--flags]');
    out(`env: ${MEMORY_ENV.apiUrl} ${MEMORY_ENV.databaseUrl} ${MEMORY_ENV.projectMemoryId} (all required)`);
    return 0;
  }
  const { flags } = parseArgs(argv);
  const command = argv[0] as string;

  // F1: refuse to do anything without a fully explicit, valid configuration.
  const cfg = resolveConfigFromEnv(process.env as Record<string, string | undefined>);
  if (!cfg.ok) {
    out(`DEGRADED code=${cfg.degraded.code} reason=${cfg.degraded.reason}`);
    return 0;
  }

  const gateway = new MemoryGateway({
    config: cfg.value,
    // --scope opts into per-agent BANK isolation; --agent is only provenance.
    // Shared-memory agents (OpenCode + Codex) use the project-wide bank.
    ...(flags.scope ? { agentScope: flags.scope } : {}),
    provider: process.env.HINDSIGHT_LLM_PROVIDER ?? 'ollama',
    model: process.env.HINDSIGHT_LLM_MODEL ?? 'qwen2.5:7b',
  });

  /**
   * Build the optional budget ledger. The scope comes from configuration only;
   * with no scope the ledger records observations and charges nothing, which is
   * the honest default rather than a guess at whose budget memory belongs to.
   */
  function buildLedger(): { ledger: MemoryUsageLedger; port: QuotaBudgetPort | null } {
    const assignment = resolveBudgetSource({
      explicitScope: process.env.HINDSIGHT_MEMORY_BUDGET_SCOPE,
      explicitId: process.env.HINDSIGHT_MEMORY_BUDGET_ID,
    });
    if (!assignment.assigned) {
      return { ledger: new MemoryUsageLedger(null, assignment, { ephemeral: true }), port: null };
    }
    const allocatedRaw = process.env.HINDSIGHT_MEMORY_BUDGET_ALLOCATED;
    const port = new QuotaBudgetPort({
      source: assignment.source,
      ...(allocatedRaw !== undefined ? { allocated: Number(allocatedRaw) } : {}),
    });
    return { ledger: new MemoryUsageLedger(port, assignment, { ephemeral: true }), port };
  }

  function reportCharge(usage: ReturnType<MemoryGateway['getObservations']>[number], ledger: MemoryUsageLedger, port: QuotaBudgetPort | null): void {
    const charge = ledger.record(usage);
    out(
      `BUDGET obs=${charge.observationId} op=${charge.memoryOperation} ` +
        `chargeable=${charge.chargeable} charged_units=${charge.chargedUnits ?? 'none'} ` +
        `source=${charge.assignment.assigned ? `${charge.assignment.source.scope}:${charge.assignment.source.id}` : 'UNASSIGNED'} ` +
        `skip=${charge.skipReason ?? 'none'} reason="${charge.assignment.reason}" cost_usd=unknown`,
    );
    if (port !== null) {
      const s = port.snapshot();
      out(
        `LEDGER scope=${s.scope} id=${s.id} allocated=${s.allocated} consumed=${s.consumed} remaining=${s.remaining} (units=tokens)`,
      );
    }
    out(
      'LEDGER_KIND ephemeral_process_local · a fresh per-process view, NOT the runtime persistent budget',
    );
  }

  switch (command) {
    case 'status': {
      const bank = gateway.getBank();
      out(
        `MEMORY_STATUS bank=${bank.bankId} project=${bank.projectMemoryId} ` +
          `bank_source=${gateway.getBankSource()} db=${cfg.value.databaseUrl} ` +
          `db_source=${cfg.value.databaseUrlSource} config_source=${cfg.value.configSource} ` +
          `app_dir=${cfg.value.appDir ?? 'not-configured'} data_dir=${cfg.value.dataDir ?? 'backend-managed'}`,
      );
      return 0;
    }

    case 'retain': {
      const content = readContent(flags);
      if (content === '') {
        out('DEGRADED code=memory-config-invalid reason=retain requires --content or --contentFile');
        return 0;
      }
      const kind = (flags.kind ?? 'fact') as MemoryKind;
      const write: MemoryWrite = { content, kind };
      if (kind === 'decision') {
        write.decision = {
          decisionKey: flags.decisionKey ?? 'unknown',
          version: Number(flags.version ?? '1'),
          status: (flags.status ?? 'active') as 'active' | 'superseded' | 'invalidated',
          supersedes: flags.supersedes !== undefined && flags.supersedes !== 'null' ? Number(flags.supersedes) : null,
        };
      }
      if (flags.source) write.source = flags.source;
      if (flags.sourceType) write.sourceType = flags.sourceType as MemoryWrite['sourceType'];
      if (flags.taskId) write.taskId = flags.taskId;
      if (flags.sessionId) write.sessionId = flags.sessionId;
      if (flags.agent) write.agentId = flags.agent;
      if (flags.confidence) write.confidence = flags.confidence as MemoryWrite['confidence'];
      if (flags.tags) write.tags = flags.tags.split(',').map((t) => t.trim()).filter(Boolean);

      const result = await gateway.retain(write);
      if (!result.ok) {
        out(`DEGRADED code=${result.degraded.code} reason=${result.degraded.reason}`);
        // A failed write may still have consumed backend tokens; report them
        // rather than discarding the observation.
        if (result.usage !== null) {
          const { ledger, port } = buildLedger();
          reportCharge(result.usage, ledger, port);
        }
        return 0;
      }
      const usage = result.usage;
      out(
        `RETAIN_OK bank=${result.value.bankId} memory_id=${result.value.memoryId ?? 'pending'} kind=${kind} ` +
          `llm_tokens=${usage?.totalTokens ?? 'unknown'} llm_calls=${usage?.llmCalls ?? 'unknown'} ` +
          `attribution=${usage?.usageClass ?? 'unknown'}` +
          (usage !== null && usage.unattributedScopes.length > 0
            ? ` unattributed_scopes=${usage.unattributedScopes.join('|')}`
            : '') +
          ` latency_ms=${usage?.latencyMs ?? 'unknown'} cost_usd=unknown`,
      );
      if (usage !== null) {
        const { ledger, port } = buildLedger();
        reportCharge(usage, ledger, port);
      }
      return 0;
    }

    case 'recall': {
      let query = flags.query ?? '';
      if (flags.queryFile !== undefined) {
        try {
          query = readFileSync(flags.queryFile, 'utf8').trim();
        } catch (e) {
          out(`DEGRADED code=memory-config-invalid reason=could not read queryFile: ${e instanceof Error ? e.message : String(e)}`);
          return 0;
        }
      }
      if (query === '') {
        out('DEGRADED code=memory-config-invalid reason=recall requires --query or --queryFile');
        return 0;
      }
      const result = await gateway.recall(query, Number(flags.maxTokens ?? '400'));
      if (!result.ok) {
        out(`DEGRADED code=${result.degraded.code} reason=${result.degraded.reason}`);
        if (result.usage !== null) {
          const { ledger, port } = buildLedger();
          reportCharge(result.usage, ledger, port);
        }
        return 0;
      }
      const r = result.value;
      const usage = result.usage;
      out(
        `RECALL_COUNT bank=${gateway.getBank().bankId} n=${r.memories.length} ` +
          `conflicts=${r.conflicts.length} instruction_like=${r.instructionLikeIds.length} ` +
          `llm_tokens=${usage?.totalTokens ?? 'unknown'} llm_calls=${usage?.llmCalls ?? 'unknown'} ` +
          `attribution=${usage?.usageClass ?? 'unknown'} ` +
          `(0 means measured zero for THIS recall, not a backend total)` +
          ` latency_ms=${usage?.latencyMs ?? 'unknown'}`,
      );
      let i = 0;
      for (const m of r.memories) {
        i++;
        const flagsBits = [`kind=${m.kind}`];
        if (m.decision) flagsBits.push(`decision=${m.decision.decisionKey}@v${m.decision.version}/${m.provenance.status}`);
        if (m.classification === 'instruction_like') flagsBits.push(`INSTRUCTION_LIKE[${m.instructionSignals.join('|')}]`);
        out(`HIT[${i}] id=${m.memoryId} (${flagsBits.join(' ')}) text=${m.text}`);
        // Provenance is printed on request rather than by default: a human asked
        // to audit a memory must be able to see WHERE it came from, but routine
        // recalls should not be buried under it.
        if (flags.provenance !== undefined) {
          out(
            `  PROV id=${m.provenance.memoryId} project=${m.provenance.projectMemoryId} ` +
              `agent=${m.provenance.agentId} task=${m.provenance.taskId ?? 'none'} ` +
              `session=${m.provenance.sessionId ?? 'none'} source=${m.provenance.source} ` +
              `source_type=${m.provenance.sourceType} kind=${m.provenance.kind} ` +
              `confidence=${m.provenance.confidence} status=${m.provenance.status} ` +
              `citable=${m.allowedAsEvidence} created_at=${m.provenance.createdAt} ` +
              `observed_at=${m.provenance.observedAt}`,
          );
        }
      }
      for (const c of r.conflicts) {
        out(`CONFLICT key=${c.decisionKey} reason=${c.reason} candidates=${c.candidates.map((x) => `v${x.version}:${x.memoryId}`).join(',')}`);
      }
      if (r.memories.length === 0) out('HIT_NONE');
      if (result.usage !== null) {
        const { ledger, port } = buildLedger();
        reportCharge(result.usage, ledger, port);
      }
      return 0;
    }

    case 'invalidate': {
      const memoryId = flags.id ?? '';
      if (memoryId === '') {
        out('DEGRADED code=memory-config-invalid reason=invalidate requires --id');
        return 0;
      }
      const result = await gateway.invalidate(memoryId, flags.reason ?? 'invalidated via memory cli');
      if (!result.ok) {
        out(`DEGRADED code=${result.degraded.code} reason=${result.degraded.reason}`);
        return 0;
      }
      out(`INVALIDATED id=${result.value.memoryId} state=${result.value.state}`);
      return 0;
    }

    case 'reflect': {
      let query = flags.query ?? '';
      if (flags.queryFile !== undefined) {
        try {
          query = readFileSync(flags.queryFile, 'utf8').trim();
        } catch (e) {
          out(`DEGRADED code=memory-config-invalid reason=could not read queryFile: ${e instanceof Error ? e.message : String(e)}`);
          return 0;
        }
      }
      if (query === '') {
        out('DEGRADED code=memory-config-invalid reason=reflect requires --query or --queryFile');
        return 0;
      }
      const result = await gateway.reflect(query, Number(flags.maxTokens ?? '600'));
      if (!result.ok) {
        out(`DEGRADED code=${result.degraded.code} reason=${result.degraded.reason}`);
        // A failed operation may still have spent tokens before failing, so its
        // usage is reported (and chargeable) rather than discarded.
        if (result.usage !== null) {
          const { ledger, port } = buildLedger();
          reportCharge(result.usage, ledger, port);
        }
        return 0;
      }
      const usage = result.usage;
      out(
        `REFLECT_OK llm_tokens=${usage?.totalTokens ?? 'unknown'} llm_calls=${usage?.llmCalls ?? 'unknown'} ` +
          `attribution=${usage?.usageClass ?? 'unknown'} latency_ms=${usage?.latencyMs ?? 'unknown'} cost_usd=unknown`,
      );
      out(`REFLECT_TEXT ${result.value.text.replace(/\s+/g, ' ').slice(0, 300)}`);
      if (usage !== null) {
        const { ledger, port } = buildLedger();
        reportCharge(usage, ledger, port);
      }
      return 0;
    }

    case 'budget': {
      // Reports how memory usage WOULD be routed, without spending anything.
      const assignment = resolveBudgetSource({
        explicitScope: process.env.HINDSIGHT_MEMORY_BUDGET_SCOPE,
        explicitId: process.env.HINDSIGHT_MEMORY_BUDGET_ID,
      });
      out(
        `BUDGET_SOURCE assigned=${assignment.assigned} ` +
          `source=${assignment.assigned ? `${assignment.source.scope}:${assignment.source.id}` : 'UNASSIGNED'} ` +
          `reason=${assignment.reason}`,
      );
      out(
        'BUDGET_RULES unknown=never-charged,never-zero · estimated=never-produced,refused-if-seen · ' +
          'consolidation=never-charged · duplicate-observation=charged-once · counter-movement=charged-once · cost_usd=unknown',
      );
      return 0;
    }

    default:
      out(`UNKNOWN_COMMAND command=${command}`);
      out('USAGE: memory <status|retain|recall|invalidate|budget>');
      return 0;
  }
}

main().then(
  (code) => {
    // Match src/cli/index.ts: set exitCode and let Node exit naturally. An
    // explicit process.exit() races undici's socket teardown and, in this
    // environment, trips a libuv assertion that turns exit 0 into -1 — which a
    // caller would misread as a task failure rather than a degraded memory op.
    process.exitCode = code;
  },
  (error: unknown) => {
    // Top-level guard: even an unexpected throw becomes a non-fatal DEGRADED
    // line, because a memory CLI must never crash an agent turn.
    out(`DEGRADED code=memory-backend-error reason=${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 0;
  },
);
