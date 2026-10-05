> **[Historical — Phase 4 审计]** quota 观测事实仍准确；R1-1 后的 observation policy 见 docs/EXECUTION_ROUND_SEMANTICS.md §2。当前基线见 docs/PROJECT_BASELINE.md。

# Phase 4A — Provider / Quota Source Audit

Audit date: 2026-09-29. All facts below were measured on this machine by running
the agents' own CLIs. Nothing here is copied from marketing pages, and no
quota/remaining/reset figure is invented: where an agent exposes no quota
endpoint, the record says so.

Every row records `source`, `observed_at`, `confidence` per the Phase 4 rule.

## 1. OpenCode

| Field | Value |
| --- | --- |
| CLI | `%APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe` (PATH shim is `.ps1`, not directly executable) |
| version | reported by `opencode --version` (see `orchestrator quota` runtime output) |
| Login state | `opencode providers list` → 3 credentials: OpenCode Go (api), DeepSeek (api), Ollama Cloud (api) at `~\.local\share\opencode\auth.json` |
| Usage / cost | `opencode stats` → local aggregate from OpenCode's own DB (`opencode db path` → `~\.local\share\opencode\opencode.db`): Sessions 276, Messages 45,745+, Total Cost $19.69, Input 280.3M, Output 18.0M, Cache Read 9,139.6M; `--models` adds a per-model breakdown (messages/tokens/cost) |
| Quota (remaining / reset / period) | **NOT EXPOSED.** No CLI subcommand reports provider rate limits or remaining balance; provider billing sits behind the provider APIs. |
| Model catalog | `opencode models` → full provider/model id list (e.g. `opencode/mimo-v2.6-flash-free`, `opencode-go/deepseek-v4.1-flash`, …) |

- source: `cli_reported` (stats/models/providers are OpenCode's own output)
- observed_at: 2026-09-29
- confidence: high for usage/login/model list; **quota remaining = unavailable**

## 2. Codex

| Field | Value |
| --- | --- |
| CLI | `C:\Users\Admin\.codex\plugins\.plugin-appserver\codex.exe` (NOT on PATH); also `~\.codex\bin\codex.exe`, `%LOCALAPPDATA%\OpenAI\Codex\bin\codex.exe` |
| version | `0.158.0-alpha.2.1` (from `codex doctor --json` → `codexVersion`) |
| Login state | `codex login status` → logged in **using an API key** (key itself masked by the CLI and never recorded here); `codex doctor --json` → `auth.credentials`: auth mode `api_key`, stored API key `true`, stored ChatGPT tokens `false` |
| Model in use | `codex doctor --json` → `config.load.model` = `deepseek-v4.1-flash`, `model provider` = `custom` |
| Model catalog | `codex debug models` → raw model catalog as JSON (≈313 KB on this machine) |
| Quota (remaining / reset / period) | **NOT EXPOSED.** API-key auth with a custom provider: no ChatGPT plan means no 4h/week plan limits exist locally, and no CLI subcommand queries provider rate limits. |

- source: `cli_reported` (`doctor --json` is explicitly a "redacted machine-readable report")
- observed_at: 2026-09-29
- confidence: high for login/model; **quota remaining = unavailable** (no ChatGPT tokens ⇒ no plan quota to read, provider-side billing not readable from CLI)

## 3. WorkBuddy CN (`workbuddy-cn`)

| Field | Value |
| --- | --- |
| CLI | `node "D:\workbuddy\resources\app.asar.unpacked\cli\bin\codebuddy"` (bare `codebuddy` cannot activate) |
| version | `2.137.1` |
| Login state | Not authenticated — Phase 3 measurement: sidecar runs returned HTTP 401 until the user logs in; no `~\.codebuddy\auth.json` present (existence checked, contents never read) |
| Subcommands | `config`, `mcp`, `sandbox`, `plugin`, `doctor` (updater health), `update`, `install`, `daemon` — **no quota/usage/login-status command** |
| Usage | Only via `--output-format stream-json` token fields during a run; `total_cost_usd` from the CLI is not billing-reliable (Phase 3 finding) |
| Quota | **NOT EXPOSED.** |

- source: `locally_observed` (Phase 3 run evidence) + `cli_reported` (--help surface)
- observed_at: 2026-09-29
- confidence: medium for login (last observed in Phase 3 smoke), high for "no quota endpoint"

## 4. WorkBuddy Intl (`workbuddy-intl`)

| Field | Value |
| --- | --- |
| CLI | `node "D:\workbuddy ai\WorkBuddyAI\resources\app.asar.unpacked\cli\bin\codebuddy"` |
| Login state | Authenticated (Phase 3: apiKeySource = www.workbuddy.ai reported by the sidecar) |
| Model list | `--help` `--model` enum enumerates supported models (e.g. `deepseek-v4.1-flash`, `gpt-5.6-sol`, `kimi-k3`, `glm-5.3`, `grok-4.7`, `gemini-3.5-flash`) |
| Usage | stream-json token fields; `total_cost_usd` unreliable (Phase 3 finding) |
| Quota | **NOT EXPOSED.** |

- source: `locally_observed` (Phase 3) + `cli_reported` (--help)
- observed_at: 2026-09-29
- confidence: medium for login, high for "no quota endpoint"

## 5. Cline (verified Phase 3, not in active set)

| Field | Value |
| --- | --- |
| Entry point | `D:\Cline\code-sidecar.exe` (WebSocket app-server; no CLI surface) |
| Login state | Authenticated — a full run + resume completed in Phase 3 (sidecar accepted chat) |
| Quota | **NOT EXPOSED.** Model is `cline-free/mimo-v2.6-flash` (free tier enforced provider-side) |

## 6. Conclusions

1. **No agent on this machine exposes provider quota (remaining / reset time /
   period) through any local command.** Every `QuotaRecord` for remaining/reset
   is therefore `status = unavailable`, `remaining = null`, `resetAt = null` —
   never `0`.
2. What IS locally readable:
   - **usage (tokens/cost aggregates)**: OpenCode (`opencode stats`, reported),
     orchestrator store (locally observed runs).
   - **login state**: OpenCode (`providers list`), Codex (`doctor --json`),
     WorkBuddy/Cline from Phase 3 run evidence.
   - **model catalogs**: `opencode models`, `codex debug models`, WorkBuddy
     `--model` enum, Cline default model constant.
3. Free-credit / promotions: no verified promotion endpoint exists on any of
   the four agents. OpenCode does publish `*-free` model ids (`opencode models`)
   — that is free *model availability*, recorded as such with its source, NOT
   as a promotion with an expiry.
4. Cost figures: WorkBuddy `total_cost_usd` (unreliable) and OpenCode's own
   computed cost (locally reported, not an invoice) are both classified
   `reported` — never used as billing truth. Where a run reported no cost,
   cost is `null`, never `$0.00`.

---

> **R1-1 forward note (2026-10-02).** 本文件记录的 `status = unavailable, remaining = null` 事实仍然成立。R1-1 之后的 observation policy（`unavailable` 不再单独阻断 spawn；`exhausted`/`unknown`/`not_fetched`/`not_connected` 仍 fail-closed）见 **`docs/EXECUTION_ROUND_SEMANTICS.md` §2**。本文件其余内容为 Phase 4 历史审计，与该 policy 冲突处以后者为准。
