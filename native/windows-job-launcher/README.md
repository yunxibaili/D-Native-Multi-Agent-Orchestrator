# windows-job-launcher (W1 / W1.1)

A minimal, self-contained Windows launcher that places a target process into a
**no-breakaway Job Object before it executes its first instruction**, and reports
the tree as stopped only when the Job's `ActiveProcesses` reaches `0`.

This is **W1/W1.1, a prototype**. It is deliberately **not** wired into the
orchestrator runtime: `src/**` is untouched. See
`docs/WINDOWS_PROCESS_CONTAINMENT_ARCHITECTURE_AUDIT.md` for why this primitive
is the right answer and what W2-W5 still owe.

---

## Why this exists

`taskkill /T /F` walks a *live* process tree. Once an agent's root process has
exited, there is no live root to walk and any descendant it left behind keeps
running — and keeps writing the workspace. That is `rootExited != workerTreeStopped`,
and it is why `PARALLEL_WRITE` is closed.

A Job Object closes the gap. From Microsoft's *Nested Jobs* documentation:

> If the immediate job object does not allow breakaway, the child process does
> not break away even if jobs in its parent job chain allow it.

libuv (Node's process layer) already puts every non-detached child into a Job —
but it sets `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`, so anything the agent spawns
silently leaves that Job. By owning a Job that is *closer to the work* and that
**never** permits breakaway, the entire descendant tree is retained regardless
of libuv's permissive parent Job.

---

## Layout

```
native/windows-job-launcher/
  src/w1joblauncher.c   the launcher (Job ownership + lifecycle + control file)
  src/w1fixture.c       test fixture: root -> child -> grandchild chain + probe
  src/winquote.h        Windows argv quoting, adapted from libuv (MIT)
  build.ps1             builds both binaries into ./build
  .gitignore            keeps generated binaries out of git
```

`build/` is generated and **never tracked**.

---

## Build

Requires `gcc` on `PATH` (MSYS2 UCRT64 / mingw-w64).

```powershell
powershell -File native/windows-job-launcher/build.ps1
# -> build/w1joblauncher.exe (~123 KB), build/w1fixture.exe (~116 KB)
```

Flags: `-static` (self-contained PE; imports only OS-provided `api-ms-win-crt-*`),
`-municode`, `-O2 -Wall -Wextra -std=c99`.

## Run

```
w1joblauncher.exe [--diag <file>] [--log-argv] [--debug] -- <exe> [args...]
```

- Everything after `--` is the target command line.
- **CLI grammar is strict:** `w1joblauncher [launcher-options...] -- <exe> [target-args...]`.
  Launcher options are parsed **only before the first standalone `--`**. From that
  `--` onward option parsing stops permanently, so a target's own `--debug`,
  `--diag` or `--log-argv` is passed through verbatim and never consumed by the
  launcher. There is no argv pre-scan.
- **`stdout`/`stderr` belong to the target** (and, in production, to the agent's
  JSONL transport). The launcher writes **nothing** to them by default — not even
  on failure. `--debug` is the only switch that emits human-readable text on
  stderr, and it is off unless explicitly requested.
- **`--diag <file>`** is the machine-readable control channel. If it is requested
  and cannot be created/opened, the launcher **fails closed** (exit 8) rather
  than run without diagnostics.
- `--log-argv` additionally records the target argv. **Off by default**:
  an agent CLI can carry credentials on its command line.

### Exit status vs target exit code (W1.1)

The launcher's process exit code reports **the launcher's own outcome only**. It
is a small fixed set and it is *never* the target's exit code:

| Code | Meaning |
|---|---|
| `0` | **success** — containment completed, `ActiveProcesses == 0` |
| `1` | usage error |
| `2` | `CreateJobObjectW` failed |
| `3` | `SetInformationJobObject` failed |
| `4` | `CreateProcessW` failed |
| `5` | `AssignProcessToJobObject` failed (target terminated, not resumed) |
| `6` | `ResumeThread` failed (target terminated) |
| `7` | Job accounting query failed |
| `8` | the requested `--diag` control file could not be opened |
| `9` | the target command line cannot be represented (too long / overflow) |
| `10` | internal error (handle-list setup) |

The **target's** exit code is `rootExitCode` in the control file. This removes
the collision where a target that legitimately exited `103` was indistinguishable
from a launcher failure that also used `103` (W1.1 P2).

### Control file

`key=value` lines, UTF-16LE, no BOM, terminated by `complete=1`. A reader must
treat the file as final only when `complete=1` is present.

| Key | Meaning |
|---|---|
| `launcherStatus` | `success` \| `job-create-failed` \| `job-configure-failed` \| `create-process-failed` \| `assign-failed` \| `resume-failed` \| `accounting-failed` \| `internal-error` \| `cmdline-too-long` \| `cmdline-overflow` \| `cmdline-oom` |
| `phase` | last lifecycle phase reached (`create-job` … `done`) |
| `win32Error` | the Win32 error code for a failure |
| `launcherPid` | the launcher process id |
| `rootPid` | the target ROOT process id |
| `rootExitCode` | the target's own exit code (absent if the target never ran) |
| `treeStopped` | `1` once `ActiveProcesses` reached `0` |
| `activeProcessesFinal` | the final Job active-process count |
| `assignedBeforeResume` | `1` proves the race-free ordering |
| `resumed` | `1` once the target was resumed |
| `killOnJobClose` | `1` (must be set) |
| `breakawayOkSet` / `silentBreakawayOkSet` | `0` (must NOT be set) |
| `cleanupTerminateFailed` / `cleanupWaitFailed` | `1` if the fail-closed cleanup of a suspended target itself failed |
| `complete` | `1` when the record is final |

---

## Hardening notes (W1.1)

### P1: command-line allocation underflow (fixed)

The W1 sizing rule was `need += 2*len + 2` per argument. That under-reserves an
**empty** argument, which emits `""` (2 units) *and* is followed by a separator
space (1 unit): the real requirement is `3N` for N empty arguments but only
`2N+1` was reserved, so the encode pass ran past the buffer. This was reproduced
as `0xC0000374` (STATUS_HEAP_CORRUPTION) at 200 and 400 empty arguments.

Two independent defences now prevent a sizing mistake from ever being memory
corruption:

1. **Exact size pass** with `w1_checked_add` / `w1_checked_mul` (overflow-safe),
   computing `2*len + 2` for the quoted content plus a separator slot per
   argument, and a hard check against the Windows limit
   (`W1_CMDLINE_MAX_WCHARS`, 32767, the `CreateProcessW` `lpCommandLine` maximum
   including the NUL). A command line that cannot be represented **fails closed**
   (exit 9); it is never truncated.
2. **Bounded encoder** — `w1_quote_cmd_arg` refuses to write at or past the
   buffer end and returns `NULL` instead of overrunning.

### P2: control-plane / transport separation

Launcher-owned status (setup/Job/CreateProcess/assign/resume/internal failures)
goes to the **control file** and the **exit code**, never to the target's
stdout/stderr.

### W1.2: strict CLI option boundary

Option parsing stops at the first standalone `--`. An earlier pre-scan of argv
(let in by W1.1) meant a `--debug` / `--diag` / `--log-argv` appearing **after**
the separator could be consumed by the launcher, silently changing launcher
behaviour based on tokens that belong to the target. The pre-scan is removed:
post-separator tokens are the target's, always.

### P2: exit-code namespace collision

See "Exit status vs target exit code" above.

### P2: diagnostic open failure

A requested `--diag` that cannot be opened is a hard failure (exit 8), never a
silent degradation, because losing it would lose `rootPid`, `rootExitCode` and
the containment evidence.

### Assign/resume cleanup is checked

On assign/resume failure the suspended target is terminated and both
`TerminateProcess` and `WaitForSingleObject` results are inspected; a failed
cleanup is recorded (`cleanupTerminateFailed` / `cleanupWaitFailed`), not assumed.

---

## Test

```powershell
node tests/windows-job-launcher/containment.test.ts
```

Environment overrides: `W1_STRESS` (default 50), `W1_RACE_ROUNDS` (default 12).

Covers the containment physics plus the W1.1 hardening regressions (W1H-1…17)
and the W1.2 CLI-boundary regressions (W1P-1…7): empty-argument boundaries
(50/200/400), high-count normal/quoted/Unicode argv, 1000 deterministic
generated argv cases, the exit-code namespace split, stream non-contamination,
fail-closed control-file handling, the option-vs-target separator boundary, and
the 50-round tree stress / 12-round race with zero leaks/escapes.

> **Drive note.** The suite places its scratch directory under `build/` rather
> than the OS temp directory **on purpose**. On this workstation a process running
> from `D:` is denied write access to `C:`, so using `%TEMP%` would make every
> pid file and diagnostic silently unwritable and every assertion would fail for
> a reason unrelated to containment. The launcher likewise never assumes
> `%TEMP%` is writable; the caller chooses the control-file location.

---

## Provenance

`src/winquote.h` is adapted from libuv `src/win/process.c`
(`quote_cmd_arg` / `make_program_args`), MIT licensed, Copyright Joyent, Inc. and
other Node contributors. libuv is the implementation Node itself uses to build a
Windows child command line, so reusing its rules makes a command line assembled
here parse identically in the target.
