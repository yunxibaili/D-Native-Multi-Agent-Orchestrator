# W0 — Windows Process Containment Architecture Audit

Status: **W0 COMPLETE (audit). W1 COMPLETE (prototype proven). W1.1 COMPLETE (hardened). W1.2 COMPLETE (CLI boundary). No production integration.**
Gate: `PARALLEL_WRITE` remains **CLOSED**. This document does not reopen it.

> **W1 result: PASS.** The recommended launcher was built and independently
> proven on this machine. `rootExited != workerTreeStopped` is now a measured
> fact, not an argument. See §10.
>
> **W1.1 result: PASS.** A post-W1 seal review found one memory-safety defect
> (P1) and three control-plane/contract defects (P2). All are fixed and
> regression-tested. See §11.
>
> **W1.2 result: PASS.** The CLI option boundary is now strict: launcher options
> stop at the first standalone `--`, so post-separator `--debug`/`--diag`/
> `--log-argv` belong to the target. See §12.

---

## 0. Purpose and the one question this audit answers

The orchestrator hands a coding-agent CLI a **write-capable workspace** and must be able to
guarantee two things:

1. when the orchestrator decides the execution is over, **no process belonging to it is still running**;
2. therefore **no process belonging to it can still write the workspace**.

This audit answers: *what mechanism can actually make that guarantee true on Windows, given that
the orchestrator's process layer is Node.js `child_process`?*

The short answer, established in §2–§4 and defended in §7:

> **Node cannot own a Windows Job Object, and libuv's own job — which already exists and is
> invisible to us — deliberately lets agent grandchildren escape it. Containment therefore
> requires a separate OS process that owns the job handle exclusively. A tiny launcher helper
> is the recommended mechanism; a Node native addon is rejected on this project's constraints.**

---

## 1. The defect, stated precisely

Three facts must never be conflated. The codebase already keeps two of them apart
(`src/runtime/spawn.ts:139-174`), which is good work and is preserved by this audit.

| Fact | Meaning | Can it release workspace protection? |
|---|---|---|
| `rootTerminalObserved` | The root process's exit was seen. | **No** |
| `treeStopConfirmed` | The entire descendant tree is confirmed dead. | **Yes — this and only this** |

The gap that keeps `PARALLEL_WRITE` closed: on a **natural exit** of the root,
`src/orchestration/git.ts:282-286` sets `treeStopConfirmed = true` unconditionally, and the
code says so itself:

> *"Full descendant quiescence after a natural exit is not provable without a Windows Job
> Object, which this codebase deliberately does not introduce."* — `src/orchestration/git.ts:275-280`

That is not a bug in the reporting. It is an **honest admission of a missing primitive**, and it
is the single thing W0 must supply. The same admission appears at
`src/runtime/spawn.ts:409-412` and `src/runtime/spawn.ts:144-148`.

### 1.1 Why the current mechanism cannot close the gap

`taskkill /T /F` walks a **live** process tree, rooted at a live parent:

- **Cancel path** (`src/runtime/spawn.ts:344-363`): usable only while the root is alive. If the
  root has already exited, the code correctly returns `false` (unconfirmed) rather than
  `true`. Honest, but it can never become `true`.
- **Reap path** (`src/runtime/spawn.ts:414-435`): after a natural exit there is no live root, so
  the call is deliberately skipped entirely and reports `descendantsReaped: false`. Correct, and
  permanently unconfirmed.

So `CleanupReport.descendantsReaped` is **not** a containment fact and must never be treated as
one. It is evidence of an *attempt*.

---

## 2. Finding: Node already has a Job Object, and it is deliberately leaky

This is the most important discovery in the audit, and it is not documented anywhere in this repo.

`node:child_process` does not create processes itself. It calls **libuv**, and libuv already
implements a containment layer (`deps/uv/src/win/process.c`, `uv__init_global_job_handle`):

```c
info.BasicLimitInformation.LimitFlags =
    JOB_OBJECT_LIMIT_BREAKAWAY_OK |
    JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK |
    JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION |
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

uv_global_job_handle_ = CreateJobObjectW(&attr, NULL);
```

and after every `CreateProcessW`:

```c
if (!(options->flags & UV_PROCESS_DETACHED)) {
  if (!AssignProcessToJobObject(uv_global_job_handle_, info.hProcess)) {
    /* ... swallow ERROR_ACCESS_DENIED and continue
       "without establishing a kill-child-on-parent-exit relationship" ... */
  }
}
```

Three consequences, each fatal to relying on it:

### 2.1 `SILENT_BREAKAWAY_OK` empties the job exactly where we need it

Per Microsoft's nested-job documentation:

> *"When processes are implicitly associated with a job during process creation, a child process
> is associated with every job in the job chain of its parent process. **If the immediate job
> object allows breakaway, the child process breaks away** from the immediate job object and from
> each job in the parent job chain…"*

The agent CLI we spawn **is** in libuv's job. Every process *it* spawns — the actual work:
`git`, shells, MCP servers, the grandchildren this project has repeatedly been bitten by —
**silently breaks away and is not in any job at all.** libuv sets that flag on purpose, to avoid
constraining child job control.

So the containment that "already exists" covers **only the single root process**, and structurally
cannot cover the tree. This is the documented mechanism behind every leak in §1.

### 2.2 The guarantee is best-effort, not fail-closed

`AssignProcessToJobObject` failure is **swallowed**. Under a parent job without
`SILENT_BREAKAWAY_OK` on Windows 7, or hostile job control, libuv deliberately proceeds with **no**
kill-on-parent-exit relationship rather than fail. Our protection would silently evaporate with no
error surfaced anywhere.

### 2.3 We cannot reach it

Node exposes no API to that job: no handle, no flags, no wait. `SpawnOptions` has
`detached`, `windowsHide`, `windowsVerbatimArguments` — and **no `creationFlags`**. Therefore
`CREATE_SUSPENDED` is unavailable, as are the native process/thread `HANDLE`s and
`AssignProcessToJobObject` itself.

**Conclusion: the job we would need to control is owned by a layer we cannot control.**

---

## 3. What the OS actually provides

Verified against Microsoft Learn, *Nested Jobs* and *Job Objects*.

| Capability | Availability | Note |
|---|---|---|
| Nested jobs | **Windows 8 / Server 2012+** | A process may be in a job *chain*; one job before Win8. |
| Job hierarchy validity | Order-dependent | *"If processes are assigned to jobs in random order… it will cause `AssignProcessToJobObject` to fail."* |
| Nesting blocked by | UI limits | Neither job may set `JobObjectBasicUIRestrictions`. |
| Breakaway override | Immediate job wins | *"If the immediate job object does not allow breakaway, the child process does not break away even if jobs in its parent job chain allow it."* |
| `TerminateJobObject` | All versions | Terminates the job and all child jobs, bottom-up. |
| `KILL_ON_JOB_CLOSE` | All versions | Closing the **last** handle kills every member. |
| Breakaway flags | All versions | `BREAKAWAY_OK` / `SILENT_BREAKAWAY_OK` — **must not be set by us.** |

### 3.1 The decisive fact

The breakaway-override rule is what makes containment achievable *on top of* libuv's leaky job:

> If **our** job is the **immediate** job of the agent CLI, and **our** job does **not** allow
> breakaway, then every descendant the agent CLI ever creates is retained — **regardless of
> libuv's `SILENT_BREAKAWAY_OK` further up the chain.**

We do not need to defeat libuv's job. We need a job that is *closer* to the work and that never
permits breakaway. That is a fully supported configuration, not a hack.

### 3.2 The confirmation primitive we are missing

`QueryInformationJobObject(JobObjectBasicAccountingInformation)` returns
`ActiveProcesses`. Polling it to `0` is a **direct, numeric, job-scoped statement that the tree is
dead** — the honest replacement for reading a `taskkill` exit code. It requires a job handle,
which again requires §2.3's missing capability.

---

## 4. Options considered

Evaluation axes are fixed by this project: local, small, debuggable, **zero runtime dependencies**,
no daemon, no service, no driver, no supervisor.

### 4.1 Node native addon (N-API / `node-addon-api`)

| Axis | Assessment |
|---|---|
| Capability | **Full.** Direct job + suspended spawn + `ActiveProcesses`. |
| `dependencies: {}` | **Breaks the invariant.** Would be the project's first and only native dep. |
| Build chain | Introduces node-gyp + VS Build Tools on a personal local machine. |
| Debuggability | Lowest of the viable options; C++ crash in the orchestrator process is fatal. |
| Crash isolation | **Poor** — an addon fault kills the orchestrator itself, taking the thing it protects. |

Rejected. It buys full capability by putting untrusted-bytes-adjacent native code inside the
process we are trying to protect. The capability can be had elsewhere without that.

### 4.2 `electron-job-addon` (the only mature npm Job Object package found)

Rejected on **API surface**, independent of license or trust:

- Electron-only (prebuilt ABI 41); this project is **not** Electron and ships `bin` as a TS CLI.
- Its documented API is `addProcessById(pid)` — **spawn-then-assign**, i.e. *precisely the race
  W0 exists to eliminate*. The root can spawn descendants before assignment.
- No `CREATE_SUSPENDED`, no native handle use, no `ActiveProcesses`/wait primitive — so **no
  confirmation**, which is the thing we are actually here for.
- Optional API (`addProcessById`) means partial assignment is silently possible.

An API that cannot express "suspended → assign → resume" and cannot express "prove the tree is
empty" cannot implement the guarantee. **Rejected.**

### 4.3 FFI wrappers (`koffi`, `ffi-napi`)

Rejected: brings in a foreign-function-call runtime and code-generation layer to reach five
syscalls. Adds a large dependency surface, an extra failure mode (the FFI layer itself), and buys
nothing a helper cannot do — while *still* leaving us inside the orchestrator process. Dominated by
4.4 on every axis.

### 4.4 Small Windows launcher helper — **RECOMMENDED**

A single small x64 executable that Node spawns instead of the agent CLI.

```
Node ─spawn─> launcher.exe ─CreateProcessW(CREATE_SUSPENDED)─> agent CLI
                │  job handle owned HERE, exclusively
                │  assign ─> resume ─> poll ActiveProcesses until 0
                └─ stdio inherited straight through ─> Node's existing pipes
```

Why it wins, decisively:

1. **Crash isolation.** The job handle lives in a disposable process. A launcher fault kills the
   *containment*, never the orchestrator — and `KILL_ON_JOB_CLOSE` makes that fault **fail-closed**
   (tree dies) rather than fail-open (tree leaks).
2. **It reaches primitives Node cannot** (`CREATE_SUSPENDED`, both handles, job APIs).
3. **Zero ABI coupling.** No node-gyp, no Electron, no prebuild matrix, no `NODE_MODULE_VERSION`.
   A static C/C++ binary has **no dependency at all** on the orchestrator's Node version.
4. **Transport is untouched.** With `bInheritHandles` + `STARTF_USESTDHANDLES`, the agent's stdout
   lands in the *same* pipes Node already reads. `src/runtime/transport/cli.ts` needs **no change**.
5. **It upgrades the exit signal.** The launcher exits only when `ActiveProcesses == 0`, so
   `ManagedProcess.exited` finally means *tree quiescent*, not *root gone*.

**Language choice.** Prefer a statically-linked C/C++ x64 binary (no runtime prerequisite).
.NET Framework 4.8 is universally present on Windows 10+ so a `net48` build is acceptable, but
PowerShell `Add-Type` per-invocation is **rejected**: it pays a C# compiler start (~1s+) on every
execution and is not fail-closed if compilation fails.

---

## 5. Recommended architecture

### 5.1 Ownership

**Exactly one** job handle, owned by exactly one launcher process. Node never holds a job handle
and never needs one. This is what makes §2.1 non-fatal: the orchestrator is not the authority for
containment; the launcher is.

### 5.2 Launch sequence (fail-closed at every step)

1. `CreateJobObject` (named, for diagnosability).
2. `SetInformationJobObject(JobObjectExtendedLimitInformation)`:
   - `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` ✅
   - `JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION` ✅
   - **breakaway flags deliberately NOT set** (§3.1) — this is what holds the tree.
3. `CreateProcessW(..., CREATE_SUSPENDED, ...)` with inherited stdio handles.
   *Suspended before assignment: the root cannot spawn anything yet. This closes the race that
   makes `addProcessById`-style approaches unsound.*
4. `AssignProcessToJobObject(job, pi.hProcess)`.
   - **On failure: `TerminateProcess(pi.hProcess)`, close the job, exit non-zero, report the error.**
     Never proceed uncontained, never report success.
5. `ResumeThread(pi.hThread)`.
6. Forward termination requests (`TerminateJobObject`), then poll `ActiveProcesses` to `0`.
7. Exit. Closing the job handle then kills anything that raced in.

Note step 3–5 ordering is also what satisfies nested-job validity: the job is created and the
process assigned at the root of the chain, before any children exist.

### 5.3 Interaction with libuv's job (the good news)

The launcher is spawned by Node with `detached: false`, so libuv places the *launcher* in its own
job. The launcher then creates the agent CLI, which — libuv's job allowing silent breakaway —
**leaves** libuv's job. Result:

- our job is the **immediate** job of the whole agent tree → §3.1 protects every descendant;
- we nest under (or beside) libuv's job legally, since neither sets UI limits;
- **two independent nets**: Node dies → libuv's job closes → launcher dies → our
  `KILL_ON_JOB_CLOSE` → tree dies. We do not depend on that path, but it is free.

### 5.4 Termination protocol

| Trigger | Launcher action | Node-visible result |
|---|---|---|
| Agent exits normally | poll `ActiveProcesses` → `0` | `exited` = **tree quiescent** |
| Deadline exceeded | `TerminateJobObject` → poll → `0` | `treeStopConfirmed = true` |
| User cancel | `TerminateJobObject` → poll → `0` | `treeStopConfirmed = true` |
| Launcher crashes | handle closes → `KILL_ON_JOB_CLOSE` | tree dead (fail-closed) |
| Assign failed | child terminated pre-resume, exit non-zero | **fail-closed, execution refused** |

`src/runtime/spawn.ts` keeps `isTreeStopConfirmed()` exactly as-is and simply stops consulting
`taskkillTree`. The R5-1.2C separation — the real achievement of the previous round — **survives
intact and finally becomes provable**.

### 5.5 Release ordering (the rule W0 exists to state)

> **WRITE protection may be released only on (a) a natural complete exit, or (b) containment
> termination confirmed by `ActiveProcesses == 0`. Never on root exit. Never on a timeout alone.**

This maps 1:1 onto the existing `treeStopConfirmed` field, so the change is a **producer**
substitution, not a contract rewrite. `src/orchestration/git.ts:275-286` — the place that today
hardcodes `true` for natural exits — becomes truthful with no signature change.

Authority split stays exactly as it is: `ResourceClaimBook` = physical resource exclusion;
`SessionRegistry` = logical session lifecycle; **containment = OS-level, owned by the launcher**.
A session may be logically settled while a job handle is still closing; both facts are reported
separately and neither is derived from the other.

### 5.6 Residual risks (stated, not hidden)

- **Compatibility risk — PID.** `ManagedProcess.pid` would become the *launcher's* pid, not the
  agent's. Anything keying on it (logs, diagnostics) shifts meaning. This is the single most
  likely source of W1 breakage and gets its own test (W-test-10).
- **`git`/short-lived utilities** may not need containment at all; routing every spawn through a
  launcher adds latency to the hot `runGit` path. Decide per-call-site rather than globally.
- **`KILL_ON_JOB_CLOSE` is unconditional.** It is correct here (we never want survivors) but means
  we cannot implement "detach and let it finish" — and we currently do not want to.

---

## 6. Recommended work slices

| Slice | Content | Gate |
|---|---|---|
| **W1** | `launcher.exe` + protocol spec; no production wiring | job holds `root + child + grandchild` |
| **W2** | `src/runtime/containment.ts` adapter; `spawn.ts` delegates, `taskkillTree` retired | READ suites unchanged |
| **W3** | Route agent spawns through containment | W-test-1…7 green |
| **W4** | Retire the natural-exit `treeStopConfirmed = true` shortcut | `git.ts` reports honestly |
| **W5** | Re-evaluate `PARALLEL_WRITE` | **only** after W-test-8/9/10 on real stress |

`PARALLEL_WRITE` stays **CLOSED** until W5. Nothing in this document is evidence that it can open.

---

## 7. Test obligations

| ID | Test |
|---|---|
| W-test-1 | root + child both dead after cancel |
| W-test-2 | root exits, grandchild loops → tree still confirmed dead |
| W-test-3 | nested descendants at arbitrary depth |
| W-test-4 | deadline fires **before** release; protection held until confirmed |
| W-test-5 | cancel before unlock; workspace not released early |
| W-test-6 | assign fails → **fail-closed**, execution refused, protection intact |
| W-test-7 | natural-exit cleanup leaves **zero** residual processes |
| W-test-8 | READ regression — full suite parity |
| W-test-9 | launcher crash → tree dies (fail-closed) |
| W-test-10 | adapter compatibility: PID/logging/pipeline-visible behaviour |
| W-test-11 | real descendant stress, incl. `git` and shells |

W-test-2 and W-test-7 are the two that the current `taskkill` design provably cannot pass.

---

## 8. What is preserved, superseded, unchanged

Honouring the R5 work already in the tree — nothing here reverts it.

**Preserved and reusable**
- `isTreeStopConfirmed()` / `rootTerminalObserved()` separation — `src/runtime/spawn.ts:139-174`
- Env allowlist, `StringDecoder`, CRLF/CR splitting, bounded stderr tail — `src/runtime/spawn.ts:64-111`
- `'exit'` + bounded drain instead of `'close'` — `src/runtime/spawn.ts:221-224`
- Frame parsing — `src/runtime/transport/cli.ts` (unchanged by design)
- `runGit` finalization, `bounded()`, unconfirmed-retry loop, `GIT_TIMEOUT_EXIT_CODE` — `src/orchestration/git.ts:159-264`
- Worktree/resource semantics — `src/orchestration/workspace.ts`, `resource-claim.ts`
- `RunRequestMapping`, dispatch-time identity, deadline fields — `src/orchestration/execute.ts`

**Superseded by the recommendation**
- `taskkillTree()` — `src/runtime/spawn.ts:442-474`
- `TREE_KILL_GRACE_MS` fallback ladder — `src/runtime/spawn.ts:365-377`
- `reapDescendants()` Windows no-op — `src/runtime/spawn.ts:414-435`
- `CleanupResult.descendantsReaped` as any kind of proof
- The natural-exit `treeStopConfirmed = true` shortcut — `src/orchestration/git.ts:282-286`
- `scripts/test-timed.mjs` reusing `taskkillTree` — `scripts/test-timed.mjs:110`

**Deliberately unchanged**
- `ResourceClaimBook` stays a resource ledger, not a containment authority.
- `SessionRegistry` stays the logical lifecycle authority.
- `PARALLEL_WRITE` stays **CLOSED**.

---

## 9. Verdict

1. The existing leak has a **documented OS-level mechanism** (§2.1), not an implementation slip.
   libuv's `SILENT_BREAKAWAY_OK` empties its job at exactly the depth where our work happens.
2. Node **cannot** fix this: no `creationFlags`, no handles, no job API — and libuv swallows
   assignment failures, so its containment is best-effort and silent (§2.2, §2.3).
3. Containment requires a **separate process owning the job handle exclusively**.
4. A **small launcher helper is recommended**: crash-isolated, fail-closed, zero ABI coupling,
   transport untouched, and it upgrades `exited` to mean *tree quiescent*.
5. The native addon and the one mature npm package are both **rejected on this project's actual
   constraints and API surface**, not on preference.
6. Every previously recorded compromise becomes **provable** without changing a single contract —
   `treeStopConfirmed` gains a real producer.

W0 is complete. **W1 is not authorised by this document.**

---

## 10. W1 result — the prototype, proven

**Verdict: PASS.** Implemented and independently verified on this machine. No
production integration: `src/**` and `tests/**` production code are untouched.

### 10.1 Implementation and toolchain

- **Language: C**, built with **gcc 16.2.0 (MSYS2 UCRT64 / mingw-w64)**.
  Chosen over Rust because `rustc` here defaults to `x86_64-pc-windows-msvc` and
  there is **no `link.exe`** on this machine, so Rust would only work via a
  cross-target linker override — added fragility for a 5-syscall program. C also
  gives direct Win32 fidelity and the smallest source surface.
- **Source:** `native/windows-job-launcher/src/` — `w1joblauncher.c` (launcher),
  `w1fixture.c` (test fixture), `winquote.h` (libuv-adapted quoting).
- **Binary:** `w1joblauncher.exe`, ~120 KB, `-static`, importing only OS-provided
  `api-ms-win-crt-*` (present on Windows 10+). No Node ABI coupling; no toolchain
  runtime; nothing needs to be installed for the binary to run.
- **Build:** `native/windows-job-launcher/build.ps1`; output goes to a git-ignored
  `build/` directory and is never tracked.

### 10.2 Helper contract

- **Input:** `w1joblauncher [--diag <file>] [--log-argv] -- <exe> [args...]`.
- **Stdio:** passed through to the target unchanged; the launcher never writes to
  stdout/stderr on the success path.
- **cwd/env:** inherited from the launcher (which inherits from Node). No
  environment reimplementation.
- **Exit:** the **root's** exit code; `100`-`107` reserved for helper failures.
- **Diagnostics:** opt-in file, UTF-16LE; **argv logging is off by default**
  because an agent CLI can carry credentials on its command line.

### 10.3 Job configuration (verified from the binary's own diagnostics)

| Property | Observed |
|---|---|
| `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` | **set** |
| `JOB_OBJECT_LIMIT_BREAKAWAY_OK` | **not set** |
| `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` | **not set** |
| full limit mask | `0x2000` (exactly KILL_ON_JOB_CLOSE) |
| suspended creation → assign → resume | **assigned_before_resume = 1** |

`DIE_ON_UNHANDLED_EXCEPTION` is deliberately **omitted** (§10.6).

### 10.4 Race closure

The target is created `CREATE_SUSPENDED`, assigned to the Job, and only then
resumed. Diagnostics record `assigned_before_resume=1`. In 12 dedicated
immediate-spawn rounds — the descendant spawning at the earliest possible instant
of target execution — **zero** escaped. A spawn-then-assign design (including the
`addProcessById` API rejected in §4.2) cannot make that statement.

### 10.5 Process tree and the two facts

Three generations, every PID self-published by the fixture and probed with
`OpenProcess`:

- **Natural completion:** root→child→grandchild all exit on their own; the
  launcher exits only after `active_processes_final=0`; all three confirmed dead.
- **Root exits first:** the root exiting did **not** end the launcher. Measured:
  `root_exited=1` while the launcher was still alive and the grandchild still
  ran, with no `outcome` recorded yet. `rootExited != workerTreeStopped` is now a
  measurement, not an inference.
- **Hard kill:** terminating the launcher caused `KILL_ON_JOB_CLOSE` to take the
  grandchild that had outlived the root, plus the child. Fail-closed verified.
- **Stress:** **50 rounds, zero leaked descendants**; a further 12-round race
  loop, also zero. No orphaned processes remained after the run.
- **Nonzero exit:** `3`, `7`, `42` all propagated by the launcher and reported as
  containment **success** (`target-nonzero-exit`), never as containment failure.

### 10.6 Recorded decisions (deliberate, not oversights)

- **`DIE_ON_UNHANDLED_EXCEPTION` omitted.** It would kill the entire tree when a
  single descendant died of an unhandled exception — destroying that crash's
  evidence and turning one tool's failure into a mass termination. Waiting for
  `ActiveProcesses == 0` already accounts for lingering siblings, and does so
  observably. Revisit at W2.
- **No control/termination protocol in W1.** Cancellation is W3. The launcher
  exposes a single internal `terminate_job()` primitive so termination is not
  scattered, but no external cancel channel is wired.
- **`--log-argv` off by default**, for credential safety.
- **No forced-failure injection flag.** As instructed, no `--fake-failure`
  production parameter was added just to test the assign-failure path; the
  fail-closed ordering is proven by `assigned_before_resume=1` plus the code path,
  and forced injection moves to a W2/W3 test seam.

### 10.7 PID semantics (the W0 risk, now measured)

`launcherPid != targetRootPid` — measured, and the fixture's independently
published PID equals the launcher's reported `target_root_pid`. Crucially:

> **Node's `child.pid` is the LAUNCHER's pid, not the agent root's.**

This is the concrete W1 finding that W2 must handle. `ManagedProcess.pid` would
silently change meaning. Recommended for W2 (naming to be reviewed): distinguish
`containmentPid` / `launcherPid` from `rootProcessPid`, and audit every consumer
of the current `pid` before delegating to containment.

### 10.8 Performance

Full cycle — launch a three-generation chain, terminate, confirm the tree dead —
over 50 rounds: **median 176 ms, p95 185 ms**. Launcher startup (`create to
assign`) was ~16 ms. No pathological startup; per the W1 scope, no further
optimization is warranted for agent tasks measured in seconds to minutes.

### 10.9 Environment finding (must be recorded)

On this workstation, **a process whose executable is on `D:` is denied write
access to `C:`** (`ERROR_ACCESS_DENIED` / `EACCES`). Verified by relocation:
copying a working helper to `D:` made its `C:` writes fail, and copying the
launcher to `C:` made them succeed. This is an OS/environment policy, not a
property of the helper.

Consequences: the W1 harness places its scratch directory on the **same volume as
the binaries** rather than in `%TEMP%` (which is on `C:`). This was the cause of
an initial total test failure and is documented in the suite and the README so it
is never re-diagnosed. **W2 must keep this in mind**: diagnostics and any launcher
side files should be written to a directory on the same volume as the target,
and W2 should not assume `%TEMP%` is writable from the launcher.

### 10.10 W1 completion criteria

| Criterion | Result |
|---|---|
| `CREATE_SUSPENDED` verified | PASS (`assigned_before_resume=1`) |
| assign before resume verified | PASS |
| no breakaway flags | PASS (`0x2000`) |
| `KILL_ON_JOB_CLOSE` active | PASS |
| root-exit-first grandchild remains contained | PASS |
| launcher termination kills the tree | PASS |
| `ActiveProcesses == 0` before success | PASS |
| stress: zero leaked descendants | PASS (50 + 12 rounds) |
| stdio unchanged | PASS |
| launcherPid/rootPid distinction measured | PASS |
| no production runtime integration | PASS |

No escaped descendant, no silently-ignored assign failure, and no exit while
`ActiveProcesses > 0` was observed. **W1 is not a WRITE unlock.**

### 10.11 What W1 does *not* change

- `PARALLEL_WRITE` remains **CLOSED**.
- No `src/**` or production `tests/**` file was modified. W1 lives entirely in
  `native/windows-job-launcher/` and `tests/windows-job-launcher/`.
- The W1 suite is **not** added to `scripts/test-timed.mjs`: it requires a C
  toolchain and built binaries, and wiring it into `npm test` would break a clean
  checkout. It runs explicitly via `node tests/windows-job-launcher/containment.test.ts`.

### 10.12 Remaining slices (unchanged)

- **W2** — `src/runtime/containment.ts` adapter; `spawn.ts` delegates;
  `taskkillTree` retired; **PID semantics resolved** (§10.7).
- **W3** — cancel / deadline / release ordering wired to production.
- **W4** — retire the natural-exit `treeStopConfirmed = true` shortcut.
- **W5** — `PARALLEL_WRITE` re-evaluation, **only** after real descendant stress
  including `git` and shells, on the real adapter path.

---

## 11. W1.1 result — launcher hardening closure

**Verdict: PASS.** A post-W1 seal review found one memory-safety defect (P1) and
three control-plane / contract defects (P2). All four are closed, with
regressions. Containment physics are unchanged. No production integration.

Scope: `native/windows-job-launcher/**`, `tests/windows-job-launcher/**`, this
document, and the dashboard status. `src/**` untouched.

### 11.1 P1 — command-line allocation underflow (memory safety)

**Root cause.** The W1 sizing rule was `need += 2*len + 2` per argument. For an
**empty** argument that is wrong: the encoder emits `""` (2 UTF-16 units) *and*
the caller writes a separator space before every argument after the first (1
unit). So N empty arguments require `3N` units but only `2N + 1` was reserved,
and the encode pass ran past the buffer.

**Reproduced independently**, not merely reported: a standalone reconstruction of
the old sizing + old unbounded encoder crashes with `0xC0000374`
(`STATUS_HEAP_CORRUPTION`) at **200** and **400** empty arguments — exactly the
Codex finding.

**Fix — two independent defences**, so a future sizing mistake can never again
become corruption:

1. **Exact size pass** using overflow-safe `w1_checked_add` / `w1_checked_mul`.
   Per argument it reserves `2*len + 2` (quotes plus a worst-case escape before
   every character) plus one separator slot, and one final NUL. It then enforces
   `W1_CMDLINE_MAX_WCHARS = 32767` — the documented `CreateProcessW`
   `lpCommandLine` maximum, including the terminator. A command line that cannot
   be represented **fails closed** (launcher exit `9`, `launcherStatus` =
   `cmdline-too-long` / `cmdline-overflow`); it is **never truncated**, because a
   truncated command line is a *different command*.
2. **Bounded encoder.** `w1_quote_cmd_arg` now takes the buffer end and refuses
   to write at or past it, returning `NULL` instead of overrunning.

**Boundary reproduction after the fix:** 50 / 200 / 400 empty arguments all
round-trip byte-for-byte, launcher exits `0`, containment still completes, no
crash.

### 11.2 P2 — control-plane / transport separation

The launcher's own setup/Job/CreateProcess/assign/resume/internal failures are
**control-plane** facts. They are now reported through the control file and the
launcher exit code, and the launcher writes **nothing** to the target's stdout or
stderr by default — those streams belong to the target and, in production, to the
agent JSONL transport. `--debug` (off by default) is the only thing that may
write stderr, for manual CLI use.

### 11.3 P2 — exit-code namespace collision

Previously the launcher propagated the root's exit code, so a target that
legitimately exited `103` was indistinguishable from a launcher create-process
failure that also used `103`. Now:

- the **launcher process exit code** reports only the launcher's own outcome
  (`0` success; `1`–`10` a specific launcher failure);
- the **target's** exit code is `rootExitCode` in the control file.

`rootExitCode=103` and `launcherStatus=create-process-failed` are fully
distinguishable; no numeric-range guessing remains.

### 11.4 P2 — diagnostic open failure was silent

A requested `--diag PATH` that cannot be created/opened is now a **hard failure**
(launcher exit `8`), never a silent degradation, because losing the control file
would lose `rootPid`, `rootExitCode` and the containment evidence. The exit code
is the signal (the file, by definition, could not be written).

### 11.5 Assign/resume cleanup is checked

On `AssignProcessToJobObject` / `ResumeThread` failure the still-suspended target
is terminated and **both** `TerminateProcess` and `WaitForSingleObject` results
are inspected; a failed cleanup is recorded (`cleanupTerminateFailed` /
`cleanupWaitFailed`) rather than assumed. Per the W1.1 scope, **no fake-failure
production switch** was added; the real fail-closed path is preserved as source.

### 11.6 Control channel

Reuses and converges the existing `--diag` seam — no new IPC. Fields:
`launcherStatus`, `phase`, `win32Error`, `launcherPid`, `rootPid`, `rootExitCode`,
`treeStopped`, `activeProcessesFinal`, `assignedBeforeResume`, `resumed`,
`killOnJobClose`, `breakawayOkSet`, `silentBreakawayOkSet`,
`cleanupTerminateFailed`, `cleanupWaitFailed`, and a final `complete=1` so a
reader never mistakes a partial record for a final one.

### 11.7 Containment physics — unchanged

`CREATE_SUSPENDED`, assign-before-resume, `KILL_ON_JOB_CLOSE`, no breakaway
flags, `ActiveProcesses == 0` before normal completion, sole Job-handle owner:
all re-verified (job limit mask is exactly `0x2000`; `breakawayOkSet=0`;
`silentBreakawayOkSet=0`). Root-exit-first still leaves the grandchild contained
while the launcher stays alive; killing the launcher still reaps the tree; the
50-round stress again found **zero leaked descendants** and the 12-round
immediate-spawn race **zero escapes**.

### 11.8 PID semantics

Unchanged and still recorded, not solved: `launcherPid != rootPid`, and Node's
`child.pid` is the launcher. The control file now reliably carries `rootPid` and
`rootExitCode`, which is what W2 will need. `ManagedProcess` is untouched.

### 11.9 Performance

Full cycle (launch three-generation chain → terminate → confirm dead): **median
172 ms, p95 196 ms** over 50 rounds — within the W1 baseline (~176 ms); no
pathological regression.

### 11.10 Cross-volume note (unchanged)

The helper does not assume `%TEMP%` or `C:`, and does not silently lose
diagnostics: the caller chooses the control-file path and a failure to open it is
loud. The exact root cause of the observed `D:`→`C:` write denial is out of
W1.1 scope; W2 decides production control-file placement.

### 11.11 Version control

No commit / push / stash / reset / clean. `git diff --check` passes.

---

## 12. W1.2 result — CLI option boundary closure

**Verdict: PASS.** One remaining W1 blocker, fixed.

**Root cause.** W1.1 added a pre-scan of the **whole** argv to find `--debug`.
That broke the CLI grammar: a `--debug`, `--diag` or `--log-argv` appearing
**after** the separator was still consumed by the launcher, silently changing
launcher behaviour based on tokens that belong to the target. A real agent's own
`--debug` / `--diag` / `--log-argv` would therefore be hijacked.

**Fix.** Option parsing is now strictly:

```
w1joblauncher [launcher-options...] -- <target-exe> [target-args...]
```

The pre-scan is **deleted**. The single parse loop stops permanently at the first
standalone `--`; from there every token is the target's, verbatim. There is no
longer any way for a post-separator token to reach launcher state.

**Boundary regressions (W1P-1…7), all asserting default stderr silence:**

| Test | Assertion |
|---|---|
| W1P-1 | `--debug -- missing.exe` → launcher debug ON (stderr explains), exit 4 |
| W1P-2 | `-- missing.exe --debug` → target arg; launcher stderr EMPTY |
| W1P-3 | `-- missing.exe --diag <path>` → target args; **no** control file created; stderr EMPTY |
| W1P-4 | `-- missing.exe --log-argv` → target arg; with a legit pre-separator `--diag`, the control file has **no** argv dump |
| W1P-5 | `-- fixture.exe --role echo --debug --diag abc --log-argv --` → target receives exactly `[--debug, --diag, abc, --log-argv, --]` |
| W1P-6 | the literal spec command creates no file named `abc`; stderr EMPTY |
| W1P-7 | a normal successful run writes nothing to stdout or stderr |

**Containment unchanged.** 50/200/400 empty arguments still round-trip exactly;
root-exit-first still leaves the grandchild contained while the launcher stays
alive; killing the launcher still reaps the tree; 50-round stress again zero
leaks; 12-round race again zero escapes. Job lifecycle, control schema,
`ManagedProcess`, `spawn.ts`, `AgentSession` and `Orchestrator` are untouched.
