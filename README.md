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
  orchestrator/  orchestrator.ts config.ts
  cli/           index.ts
tests/           unit.test.ts  contract.test.ts  cancel.test.ts  smoke.ts  helpers.ts
docs/            REUSE_ANALYSIS.md
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
- late-subscriber semantics are explicit: nothing by default, or the retained
  recent window with `{ replay: 'replay' }`;
- every buffer is bounded, and `close()` at terminal completes all subscribers
  and frees all buffers.

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

### Transport seam

```
Transport { start, events, wait, cancel, dispose }   -> TransportFrame { channel, text, data }
```

A transport knows how to **reach** an agent and **frame** its output. It knows
nothing about events, sessions, retries or review policy — so `AgentSession`
has no CLI assumptions. `CliJsonlTransport` is the first implementation.
`acp` and `app-server` are declared transport kinds with **no implementation
yet**: the seam is reserved, not half-built. No ACP protocol is hand-written here.

### Capabilities are enforced, not decorative

A capability is `true` only if the adapter honours the option end to end.
Otherwise `validateRequest()` **throws** `UnsupportedOptionError` naming the
offending option. Nothing is silently dropped.

`steering`, `worktree`, `fork` and `stdinPrompt` are `false` for both agents
because none is implemented. OpenCode refuses `--sandbox` and refuses native
review. Codex accepts `--sandbox` on a fresh run but refuses `sandbox` combined
with `resume` or `review`, because those subcommands reject `-s` (verified).

### Resume ownership

A thread id is **not** a global key. Before any native invocation, the
orchestrator verifies the persisted `ThreadRecord` (agentId, threadId, cwd):

1. the thread exists → else `ThreadNotFoundError`
2. `agentId` matches → else `ThreadOwnershipError`
3. `cwd` matches → else `ThreadOwnershipError`
4. the adapter supports resume → else `CapabilityError`
5. only then is the native CLI invoked

Cross-agent and cross-directory resumes are **refused by default**. An override
must be requested explicitly with `allowForeignThread: true`, and is logged.

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
| normal exit | reap **attempted and awaited**, outcome reported |

On normal exit the root has already gone, so `taskkill /T` has no live root to
walk. A Windows **Job Object** is the only fully reliable mechanism and we
deliberately do not take a native dependency for it. The contract is therefore
"attempted, awaited, and observable" rather than "guaranteed": a leaking agent
shows up as a surviving process rather than being silently tolerated. Native
review found this; the smoke and cancel suites now assert it.

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

- **Descendant cleanup on normal exit is best-effort, not guaranteed** — see
  the contract table above. Cancel/timeout/failure are guaranteed.
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
- ACP / app-server transports are **declared but unimplemented**.
- The two adapters are the only registered ones; a third agent needs a new
  adapter file plus one table line, and no change to core.

## Testing

```powershell
npm run typecheck      # 0 errors, strict + erasableSyntaxOnly
npm test               # unit + contract; NO real agents required
npm run smoke          # real agents, end to end
npm run test:cancel    # real cancellation + process-tree behaviour
```

`npm test` is **machine-independent**: adapters are constructed with a stub
launcher and discovery is exercised with filesystem fixtures, so the suite
passes whether or not OpenCode and Codex are installed (verified by running it
with a scrubbed `USERPROFILE`/`APPDATA`/`LOCALAPPDATA`: 146 passed, 0 failed,
2 skipped). Only real-binary *availability* is allowed to skip, never to fail.

---

## Next step

Add the **policy layer** over this runtime: a `Decision` input (Phase 2: local
Laya via `laya.Router` returning a `RouteDecision`), a retry/review gate, and
then ACP + more agents. The runtime contract — `Thread`/`Task`, the capability
matrix, `RunHandle`, and the 8 events — is what that layer should consume.
