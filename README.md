# Native Agent Orchestrator (Phase 1)

A local orchestrator that drives **already-installed, already-logged-in native
coding-agent CLIs** as subprocesses. It does **not** call provider APIs.

```
you -> Orchestrator -> native CLI subprocess -> unified event stream -> result
        (no model calls in the kernel)
```

Phase 1 ships two agents:

| Agent | Transport | Session resume | Native review | Binary |
|---|---|---|---|---|
| OpenCode 1.18.31 | `opencode run --format json` | yes (`--session`) | no (prompt-based) | `…\npm\node_modules\opencode-ai\bin\opencode.exe` |
| Codex 0.158.0-alpha.2.1 | `codex exec --json` | yes (`exec resume`) | yes (`exec review`) | `~\.codex\plugins\.plugin-appserver\codex.exe` |

Each agent keeps using **its own** login, model config and tools. This project
only ever passes arguments through; it never reads, copies or logs credentials.

---

## Quick start (Windows / PowerShell)

Requires **Node >= 22.6** (the code is TypeScript executed directly via native
type stripping — **no build step**). Verified on Node 24.18.1.

```powershell
cd "D:\yunxibaili\本地多 Coding Agent 编排器"

# 1. see what was found, and what each agent can do
node src\cli\index.ts doctor

# 2. run a task
node src\cli\index.ts run opencode "add a README section" --cwd .
node src\cli\index.ts run codex    "explain the event contract"

# 3. stream the unified event stream (NDJSON on stdout)
node src\cli\index.ts run codex "review the runtime" --json

# 4. native review via Codex
node src\cli\index.ts review codex "find any bugs" --cwd C:\path\to\repo

# 5. continue an earlier conversation
node src\cli\index.ts threads
node src\cli\index.ts resume codex <threadId> "now write the tests"

# 6. verification
npm run verify          # typecheck + unit tests + quick smoke
node src\cli\index.ts smoke      # full suite (calls real models)
node tests\cancel.test.ts        # cancellation / process-tree leak tests
```

No global install needed. `npm link` (or `npm install -g .`) makes
`orchestrator` available on PATH.

### Configuration

Config is optional — discovery works without it. Lookup order, following
native-agent-router:

```
--config flag  ->  $ORCH_CONFIG  ->  .\\orchestrator.json
                ->  ~\\.native-agent-orchestrator\\orchestrator.json
                ->  built-in defaults + auto-discovery
```

`node src\cli\index.ts init` writes a starter config. On this machine it is
**required in practice** for two reasons, both verified:

- `codex` is **not on PATH** (it ships with the OpenAI Codex desktop app);
- the OpenCode config default model points at a local Ollama on `:11435` that
  is not running, so a model must be named explicitly.

```json
{
  "agents": {
    "opencode": {
      "command": "C:\\Users\\Admin\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe",
      "model": "opencode/space-bunny-free",
      "timeoutMs": 900000
    },
    "codex": {
      "command": "C:\\Users\\Admin\\.codex\\plugins\\.plugin-appserver\\codex.exe",
      "sandbox": "workspace-write",
      "timeoutMs": 1200000
    }
  }
}
```

### Useful flags

```
--cwd <dir>        working directory for the agent
--model <id>       native model id, passed through verbatim
--role <id>        native role / agent / profile  (opencode --agent, codex -p)
--sandbox <mode>   codex: read-only | workspace-write | danger-full-access
--timeout <ms>     hard limit; cancels the task
--extra <flag>     raw flag appended to the agent argv (repeatable).
                   Works with a leading dash: --extra --some-agent-flag
--json             NDJSON event stream on stdout
--log-level <lvl>  silent|error|warn|info|debug
```

`stdout` carries data, `stderr` carries diagnostics, on every command.

---

## Layout

```
src/
  core/          types.ts   contracts: capabilities, TaskState, Thread/Task
                 event.ts    the 8 unified RuntimeEvents + JSON sanitizer
                 errors.ts   actionable errors
                 log.ts      stderr-only logger
  runtime/       spawn.ts    the ONLY child_process caller (Windows-correct)
                 discover.ts binary resolution for Windows
                 session.ts  one task = one execution: stream, wait, cancel
                 store.ts    thread/task records + full transcripts
                 registry.ts narrow adapter-selection seam
  adapters/      opencode.ts codex.ts
  orchestrator/  orchestrator.ts  config.ts
  cli/           index.ts
tests/           unit.test.ts  cancel.test.ts  smoke.ts  helpers.ts
docs/            REUSE_ANALYSIS.md
```

### Core model

- **Thread** — a resumable conversation identity. Outlives executions.
  `codex` → `thread_id`; `opencode` → `sessionID`.
- **Task** — exactly one subprocess execution, with a terminal
  `succeeded | failed | cancelled | timeout`.
- **RunRequest.agentId is always explicit.** There is no "current agent" global,
  so no other call can silently redirect a task.
- `run()` returns a **handle, not a result**. Await `handle.result()`.

### Unified events

`session.started` · `session.output` · `session.progress` · `session.tool_call`
· `session.diagnostic` · `session.completed` · `session.failed` ·
`session.cancelled`

Every event keeps the agent's **untouched payload** in `raw`, so normalization
is additive and never lossy. Every event is JSON-serializable (cycles, BigInt,
NaN, Errors and over-deep nesting are all handled explicitly rather than
crashing or silently dropping).

---

## Windows: the four things that actually broke

These were found by running the code on this machine, not by reading docs.

1. **`opencode` on PATH is `opencode.CMD`, and Node cannot exec it.**
   Since the CVE-2024-27980 fix, `spawn` refuses a batch file without a shell
   and throws `EINVAL`. Discovery resolves to the packaged `.exe` inside
   `node_modules`, and rejects `.cmd`/`.bat`/`.ps1` shims with an explanation.

2. **`codex` is not on PATH at all.** It ships with the desktop app. Discovery
   searches `~\.codex\plugins\.plugin-appserver`, the app's versioned `bin\`
   directories, and the npm layout.

3. **The three `codex exec` subcommands accept different flag sets.**
   `exec` takes `--color`/`-C`/`-s`; `exec resume` and `exec review` **reject**
   all three. Passing one is a clap usage error and exits 2. The adapter
   therefore selects an explicit flag profile per subcommand.

4. **Cancellation hung, then leaked.** Two separate bugs:
   - Node's `'close'` waits for *all* stdio. A grandchild inheriting the pipes
     keeps them open, so `'close'` never fired and every cancelled Codex task
     hung forever. Fixed by finalizing on `'exit'` with a short drain window.
   - `child.kill()` is `TerminateProcess` on the direct child only, and
     `taskkill /T` needs a **live** root. So "SIGINT then taskkill" cannot work:
     the root is already gone. On Windows the tree kill is therefore issued
     **first**, with no grace period. Cancellation on Windows is forceful by
     design — the git working tree is recoverable, a leaked process is not.

Also handled: UTF-8 decoding via `StringDecoder` (Node has no per-stream
encoding option), CRLF/LF/CR line splitting, an env **allowlist** so
credentials do not leak into an agent's environment, `windowsHide`, and
`taskkill /T /F` for child-process cleanup.

---

## What this deliberately does **not** do

Phase 1 is the runtime only. Absent on purpose:

- Laya / any local decision model
- automatic planning, task decomposition, retry or review *policy*
- multi-agent role routing (ZCode / WorkBuddy / DSH / Claude Code)
- ACP transport (OpenCode's `acp` and `codex app-server` both exist and work —
  see `REUSE_ANALYSIS.md` §6 for why it was deferred, and `transport: 'cli' |
  'acp'` is already reserved in the contract)
- worktree isolation, parallel execution, any server/daemon/frontend

The policy layer should be built **on top of** this runtime, not inside it.

---

## Known limitations

- **`capabilities.costReporting` is `false` for Codex** — it reports tokens
  only, so no cost figure is ever fabricated for it.
- **Codex reports `in=0 out=0` for `exec review`** in 0.158.0-alpha.2.1. Tool
  calls and the final review text still come through correctly.
- **No steering.** Neither CLI has a usable stdin channel mid-run
  (`codex exec` only reads stdin up front), so `capabilities.steering` is
  `false` for both and `cancel` is the only way to interrupt.
- **OpenCode cost is reported but may be `0`** depending on the provider.
- Windows cancellation is forceful (see above).
- `wait(timeoutMs)` throws `TimeoutError` **without** killing the process; call
  again or `cancel()`.
- Event consumption is a single shared queue per task; a very fast producer
  with no consumer buffers in memory (bounded by trimming, and the full
  transcript is always on disk).
- The two adapters are the only registered ones; a third agent needs a new
  adapter file, not a change to the runtime.

---

## Next step

Add the **policy layer** over this runtime: a `Decision` input (Phase 2: local
Laya via `laya.Router` returning a `RouteDecision`), a retry/review gate, and
then ACP + more agents. The runtime contract — `Thread`/`Task`, the capability
matrix, `RunHandle`, and the 8 events — is what that layer should consume.
