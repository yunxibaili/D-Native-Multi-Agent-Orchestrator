> **Docs baseline: 技术文档唯一基准 = [docs/PROJECT_BASELINE.md](docs/PROJECT_BASELINE.md)**
> 本 README 描述 Phase 1 runtime 起步状态；当前项目已是 Laya-driven Multi-Agent
> Orchestrator（4 个 Native Agent identity / bounded Execution Round / 11-action
> Decision Loop / Lease+Fencing / ResourceClaim / Codex Review）。架构与路线以
> baseline 为准。

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

# 5. continue an earlier conversation (same agent + same cwd, or it is refused)
node src\cli\index.ts threads
node src\cli\index.ts resume codex <threadId> "now write the tests"

# 6. verification
npm run verify          # typecheck + unit + contract + quick smoke
npm run smoke           # full suite (calls real models)
npm run test:cancel     # cancellation / process-tree leak tests
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
  core/          types.ts     contracts: capabilities, states, Transport seam
                 event.ts     the 8 unified RuntimeEvents + JSON sanitizer
                 event-hub.ts bounded multi-subscriber fan-out
                 buffer.ts    byte-bounded, code-point-safe tail retention
                 errors.ts    actionable errors
                 log.ts       stderr-only logger
  runtime/       spawn.ts         the ONLY child_process caller (Windows-correct)
                 launcher.ts      native vs cmd-wrapper, argv-safe
                 discover.ts      binary resolution
                 session.ts       outcome machine, hub, memory bounds
                 store.ts         thread/task records + full transcripts
                 registry.ts      narrow adapter-selection seam
                 transport/cli.ts the first Transport implementation
  adapters/      opencode.ts codex.ts index.ts (factory table)
  decision/      types.ts     the minimal DecisionProvider interface
                 errors.ts    unavailable/timeout/transport/schema/input failures
                 laya.ts      local laya-serve provider (validates request + response)
                 routing.ts   measured task-classification preset on top of it
                 check.ts     standalone dev entry point (not the orchestrator)
  orchestrator/  orchestrator.ts config.ts
  cli/           index.ts
tests/           unit.test.ts  contract.test.ts  decision.test.ts  cancel.test.ts
                 smoke.ts  helpers.ts  live-decision-check.ts
docs/            REUSE_ANALYSIS.md  DECISION_PROVIDER.md  SKILLS_EVALUATION.md
```

### CLI `--json` drain

The event stream is drained by **subscription completion**, not by a timer. The
hub closes when the outcome is frozen, so the loop ends exactly when the last
event has been delivered. The previous fixed 50 ms sleep raced the process and
could truncate the stream.

### Core model

- **Thread** — a resumable conversation identity. Outlives executions.
  `codex` → `thread_id`; `opencode` → `sessionID`.
- **Task** — exactly one subprocess execution, with a terminal
  `succeeded | failed | cancelled | timed_out`.
- **RunRequest.agentId is always explicit.** There is no "current agent" global,
  so no other call can silently redirect a task.
- `run()` returns a **handle, not a result**. Await `handle.result()`.

### Outcome state machine

```
running ──┬─ exit 0                    -> succeeded
          ├─ non-zero / spawn failure   -> failed
          ├─ cancel()                  -> cancelled
          └─ deadline exceeded         -> timed_out
```

A terminal outcome is computed **exactly once and frozen**. `result()` is
idempotent and concurrency-safe: every call returns the *same object*, and it
never constructs a state, so it cannot fabricate `succeeded` for a task that
failed. A `timeoutMs` on `result()` bounds only that call and never alters the
outcome. Every non-succeeded outcome carries a `RunErrorInfo`.

`timed_out` is deliberately distinct from `cancelled`: a deadline is not a user
abort, and retry policy treats them differently.

The decision is the **adapter's**, via `terminalPolicy`. The kernel never
hard-codes it, so an agent with its own notion of failure can express it.

### Event hub

One execution's events fan out to **any number of independent subscribers**
(policy, logger, frontend, CLI, future metrics):

- subscriber A **cannot** consume subscriber B's events — each owns its own ring
  buffer;
- a slow subscriber **never blocks the producer** and never stalls others;
  overflow is resolved per-subscriber (`drop-oldest` default, `drop-newest`,
  `close-subscriber`) and it is told how many events it lost;
- late-subscriber semantics are explicit: nothing by default, or a **snapshot**
  of the retained recent window with `{ replay: 'replay' }`. The snapshot is a
  copy, so two replay subscribers independently see the same history and one
  can never consume another's;
- every buffer is bounded, and `close()` at terminal completes all subscribers
  and frees all buffers.

`droppedCount()` means one thing under every policy: *events this subscriber
did not receive because of overflow*. `drop-oldest` counts the evicted event,
`drop-newest` the refused event, and `close-subscriber` the buffered remainder
(it ends the subscription, so its accounting closes at the capacity it held).

No external event bus — a hub is a single-process object, created per execution.

### Memory bounds

In-memory state is capped and released; files on disk are not.

| Buffer | Default | On terminal |
|---|---|---|
| assistant output tail | 64 KB, byte-exact, code-point safe | released |
| stderr tail | 8 KB | released |
| per-subscriber events | 1024 | released |
| replay window | 256 | released |
| tool calls / diagnostics | 500 / 200 | released |
| transcript | unbounded on disk | kept |

`Orchestrator`'s live-session map drops a session when it settles, so it cannot
grow without bound. Trimming never splits a code point or surrogate pair.

`RunResult.cleanup` records what process-tree cleanup achieved; it is
informational and never affects `state`.

### Transport seam

```
Transport { start, events, wait, cancel, dispose }   -> TransportFrame { channel, text, data }
```

A transport knows how to **reach** an agent and **frame** its output. It knows
nothing about events, sessions, retries or review policy — so `AgentSession`
has no CLI assumptions. `CliJsonlTransport` is the first implementation.
`acp` and `app-server` are declared transport kinds with **no implementation
yet**: the seam is reserved, not half-built. No ACP protocol is hand-written here.

**Frame resolution precedence: `data` wins over `text`.** `text` is the
CLI-JSONL convention — the payload arrives as text and is JSON-parsed. `data` is
the protocol convention — a natively-framing transport hands over a decoded
object and may produce no JSON text at all. Before this rule, a data-only frame
failed text parsing, was misreported as a diagnostic, and `mapEvent` never ran:
no real protocol transport could have worked.

### Capabilities are enforced, not decorative

A capability is `true` only if the adapter honours the option end to end.
Otherwise `validateRequest()` **throws** `UnsupportedOptionError` naming the
offending option. Nothing is silently dropped.

`steering`, `worktree`, `fork` and `stdinPrompt` are `false` for both agents
because none is implemented. OpenCode refuses `--sandbox` and refuses native
review. Codex accepts `--sandbox` on a fresh run but refuses `sandbox` combined
with `resume` or `review`, because those subcommands reject `-s` (verified).

`mode: 'review'` together with a `threadId` is an **`InvalidRequestError`**: a
review is a one-shot judgement with no conversation to continue, and no agent
can express the combination, so passing it would mean the `threadId` was
silently ignored.

### Resume ownership

**Thread identity is agent-scoped.** A native threadId is only unique within
one agent — agent A and agent B can both mint `123`, so keying storage on
threadId alone means the second write clobbers the first. Every thread lookup
therefore takes **both** `agentId` and `threadId`, and the on-disk filename is a
composite (`<agentId>__<threadId>.json`). This is a lookup-scope fix, not a
rename: a lookup physically cannot address another agent's record.

Consequence worth stating plainly: a cross-agent resume is not merely refused,
it is **not expressible** — asking agent A for `123` unambiguously means A's own
`123`. `allowForeignThread: true` is the only way to cross namespaces, and it is
always logged.

Before any native invocation the orchestrator verifies:

1. the thread exists (in this agent's namespace) → else `ThreadNotFoundError`
2. `agentId` matches → else `ThreadOwnershipError`
3. `cwd` matches → else `ThreadOwnershipError`
4. the adapter supports resume → else `CapabilityError`

Files written by earlier versions (`<threadId>.json`) are migrated on read: the
owning agent is taken from the record, or recovered from the task index, and the
file is renamed to the composite form. The old file is removed only after the
composite copy exists, so an interrupted migration is safe to repeat.

A resume also **seeds its thread id into the session before the transport
starts**. A native CLI can die before emitting its first frame; without the
seed such a run would report `threadId: null` and be uncorrelatable from the
thread it was continuing.

### Adapter registry

Bootstrap iterates a **factory table** (`src/adapters/index.ts`), not a
hard-coded opencode/codex pair. Adding ZCode / WorkBuddy / DSH means:

1. write `adapters/<name>.ts` exporting `create<Name>Adapter`
2. add one line to `ADAPTER_FACTORIES`
3. add known binary locations to `agentCandidates` in `runtime/discover.ts`

`core/` and `orchestrator/` do not change. Callers may also pass
`extraAdapters` for explicit registration. No plugin marketplace.

### Unified events

`session.started` · `session.output` · `session.progress` · `session.tool_call`
· `session.diagnostic` · `session.completed` · `session.failed` ·
`session.cancelled`

Every event keeps the agent's **untouched payload** in `raw`, so normalization
is additive and never lossy. Every event is JSON-serializable (cycles, BigInt,
NaN, Errors and over-deep nesting are all handled explicitly rather than
crashing or silently dropping).

---

## Windows: what actually breaks

Each of these was found by running the code on this machine.

1. **`opencode` on PATH is `opencode.CMD`, and Node cannot exec it.**
   Since the CVE-2024-27980 fix, `spawn` refuses a batch file without a shell
   and throws `EINVAL`. A `.cmd`/`.bat` now gets a `cmd-wrapper` launcher;
   `.ps1` is explicitly refused with a pointer to the real binary.

2. **`codex` is not on PATH at all** — it ships with the desktop app.

3. **The three `codex exec` subcommands accept different flag sets.**
   `exec` takes `--color`/`-C`/`-s`; `exec resume` and `exec review` **reject**
   all three. Passing one is a clap usage error and exits 2, so the adapter
   selects an explicit flag profile per subcommand — and refuses the impossible
   *combinations* (e.g. `sandbox` + `resume`) up front instead of building a
   doomed argv.

4. **Cancellation hung, then leaked.** Two separate bugs:
   - Node's `'close'` waits for *all* stdio. A grandchild inheriting the pipes
     keeps them open, so `'close'` never fired and every cancelled Codex task
     hung forever. Fixed by finalizing on `'exit'` with a short drain window.
   - `child.kill()` is `TerminateProcess` on the direct child only, and
     `taskkill /T` needs a **live** root. So "SIGINT then taskkill" cannot work:
     the root is already gone. On Windows the tree kill is therefore issued
     **first**, and `taskkill` is **awaited** and its result checked, not fired
     and forgotten.

Also handled: UTF-8 via `StringDecoder` (Node has no per-stream encoding
option), cross-chunk line reassembly, CRLF/LF/CR splitting, an env
**allowlist** so credentials do not leak into an agent's environment, and
`windowsHide`.

### Process-tree cleanup contract

| Path | Guarantee |
|---|---|
| cancel | `taskkill /T /F`, **awaited**, result checked — descendants are killed |
| timeout | same as cancel |
| failure | same, via the transport's exit path |
| normal exit | **no kill issued**; the result is recorded |

On a normal exit the root has already gone, so `taskkill /T` has no live root to
walk: the call would accomplish no descendant cleanup while carrying a real risk
of hitting an unrelated process if the OS had recycled that PID. A successful
run must never be able to trigger a stray force-kill, so the dead-root path is
skipped and a `CleanupResult` is reported instead
(`{ rootKilled, descendantsReaped, note }`), surfaced on `RunResult.cleanup`.

That result is informational and can **never** change the outcome — the outcome
is decided from the exit code alone, and frozen before cleanup is recorded.

True descendant reclamation after a normal exit needs a Windows **Job Object**,
which is deliberately not introduced (no native dependency). Native review
flagged this; the trade-off is stated rather than hidden.

---

## What this deliberately does **not** do

Phase 1 is the runtime only. Absent on purpose:

- automatic planning, task decomposition, retry or review *policy*
- multi-agent role routing (ZCode / WorkBuddy / DSH / Claude Code)
- ACP transport (OpenCode's `acp` and `codex app-server` both exist and work —
  see `REUSE_ANALYSIS.md` §6 for why it was deferred, and `transport: 'cli' |
  'acp'` is already reserved in the contract)
- worktree isolation, parallel execution, any server/daemon/frontend
- **installing any agent skill.** `docs/SKILLS_EVALUATION.md` recommends 5, but
  nothing is installed: a skill that can silently reshape an agent's judgement is
  an operator decision, not a build step.

`src/decision/` is the exception to "absent on purpose": the Laya provider is
implemented and tested but **not wired into `src/orchestrator/`**, so agent
selection still requires an explicit `--agent`. The policy layer should be built
**on top of** this runtime, not inside it.

---

## Known limitations

- **Descendant cleanup on a normal exit is not performed** (no Job Object) —
  see the contract table above. Cancel/timeout/failure are guaranteed.
- **Windows cancellation is forceful** (tree-kill first), by necessity.
- **`capabilities.costReporting` is `false` for Codex** — it reports tokens
  only, so no cost figure is ever fabricated for it.
- **Codex reports `in=0 out=0` for `exec review`** in 0.158.0-alpha.2.1. Tool
  calls and the final review text still come through correctly.
- **No steering.** Neither CLI has a usable stdin channel mid-run, so
  `capabilities.steering` is `false` for both and `cancel` is the only way to
  interrupt.
- A configured `sandbox` applies to **ordinary fresh runs only**; `review` and
  `resume` subcommands reject it. An explicit `--sandbox` there is still an
  error, not silently absorbed.
- `mode: 'review'` with a `threadId` is rejected, not supported.
- ACP / app-server transports are **declared but unimplemented**.
- The two adapters are the only registered ones; a third agent needs a new
  adapter file plus one table line, and no change to core.

## Testing

```powershell
npm run typecheck      # 0 errors, strict + erasableSyntaxOnly
npm test               # unit + contract + decision; NO real agents required
npm run smoke          # real agents, end to end
npm run test:cancel    # real cancellation + process-tree behaviour
```

`npm test` is **machine-independent**: adapters are constructed with a stub
launcher and discovery is exercised with filesystem fixtures, so the suite
passes whether or not OpenCode and Codex are installed (verified by running it
with a scrubbed `USERPROFILE`/`APPDATA`/`LOCALAPPDATA`: 90 + 242 passed, 0 failed).
The decision suite is hermetic too — a stub `node:http` server stands in for
`laya-serve`, including its 200-with-no-answer responses. Only real-binary
*availability* is allowed to skip, never to fail.

`node tests/live-decision-check.ts` is the one test that needs the Python side
(`laya-serve` on 127.0.0.1:8077); see `docs/DECISION_PROVIDER.md`.

---

## Next step

Add the **policy layer** over this runtime: a `Decision` input (Phase 2: the local
Laya provider in `src/decision/`, already implemented and verified — see
`docs/DECISION_PROVIDER.md`), a retry/review gate, and then ACP + more agents. The
runtime contract — `Thread`/`Task`, the capability matrix, `RunHandle`, and the 8
events — is what that layer should consume.

Note for that layer: `npm run doctor` shows **OpenCode `rejects: review`, Codex
`can: review`**. The implement→review split is enforced by the capability matrix,
not by convention.
