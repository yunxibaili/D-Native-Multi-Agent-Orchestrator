/*
 * native/windows-job-launcher/src/w1joblauncher.c
 *
 * W1/W1.1: Windows Job Object containment primitive (hardened).
 *
 * NOT production runtime code, and NOT wired into the orchestrator. It exists to
 * independently PROVE that a target process can be placed into a no-breakaway
 * Job Object before it executes its first user instruction, and that Job-level
 * ActiveProcesses == 0 is a sound physical statement that the descendant tree
 * is gone.
 *
 * ---------------------------------------------------------------------------
 * CONTAINMENT PROPERTY
 * ---------------------------------------------------------------------------
 *   CreateJobObjectW
 *     -> set KILL_ON_JOB_CLOSE, and NO breakaway flags
 *   CreateProcessW(CREATE_SUSPENDED)
 *     -> AssignProcessToJobObject   <-- target is in the Job, still frozen
 *     -> ResumeThread               <-- target's first instruction ever runs
 *
 * Per Microsoft "Nested Jobs", when the immediate job does not allow breakaway a
 * child does not break away even if jobs higher in the chain allow it. We never
 * set BREAKAWAY_OK / SILENT_BREAKAWAY_OK, which is what holds the whole tree
 * regardless of the permissive job libuv puts our own process in.
 *
 * ---------------------------------------------------------------------------
 * W1.1: CONTROL-PLANE / TRANSPORT SEPARATION
 * ---------------------------------------------------------------------------
 * stdout and stderr belong to the TARGET (and, in production, to the agent's
 * JSONL transport). The launcher therefore writes NOTHING to them by default --
 * not even on failure. All launcher-owned status goes to the control file given
 * by --diag, which is the machine-readable control channel.
 *
 * The launcher's process EXIT CODE reports the LAUNCHER'S OWN outcome only
 * (0 = success; 1..10 = a specific launcher failure). The target's exit code is
 * NEVER encoded there; it is reported as `rootExitCode` in the control file.
 * This removes the collision where a target that legitimately exited 103 was
 * indistinguishable from a launcher create-process failure that also used 103.
 *
 * `--debug` turns on human-readable stderr text for manual CLI debugging. It is
 * OFF by default, and is the ONLY thing that may write to stderr.
 *
 * ---------------------------------------------------------------------------
 * W3: COOPERATIVE STOP
 * ---------------------------------------------------------------------------
 * `--stop <marker>` gives the launcher one extra per-run file, in the same control
 * directory as `--diag`. Its mere EXISTENCE asks the launcher to TerminateJobObject
 * the WHOLE Job. The launcher then KEEPS RUNNING, polling the Job's accounting until
 * ActiveProcesses == 0, and only then writes `launcherStatus=terminated` together
 * with `treeStopped=1` / `activeProcessesFinal=0` / `complete=1`.
 *
 * This is the whole reason a cancellation can be trusted: a launcher that was itself
 * killed could never write that final record, so the parent has positive evidence
 * rather than an assumption. It is also why the stop is JOB-scoped and not
 * root-pid-scoped: by the time a cancel arrives the root may already be gone, and a
 * remembered pid may already belong to somebody else.
 *
 * If the Job does not empty, the launcher reports `stop-unconfirmed` and writes NO
 * tree-stop fact, so the caller keeps write protection instead of guessing.
 *
 * ---------------------------------------------------------------------------
 * Usage:
 *   w1joblauncher.exe [--diag <file>] [--stop <marker>] [--log-argv] [--debug] -- <exe> [args...]
 *
 * Control file: key=value lines, UTF-16LE, terminated by `complete=1`. A reader
 * must treat the file as final only when `complete=1` is present.
 */

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>
#include <wchar.h>

#include "winquote.h"

/* Launcher protocol exit codes. These are the LAUNCHER'S outcome, never the
 * target's. Kept deliberately small so they can never be confused with a target
 * exit code (which lives in the control file instead). */
#define LX_OK               0
#define LX_USAGE            1
#define LX_JOB_CREATE       2
#define LX_JOB_CONFIG       3
#define LX_PROC_CREATE      4
#define LX_ASSIGN           5
#define LX_RESUME           6
#define LX_ACCOUNTING       7
#define LX_DIAG_OPEN        8
#define LX_CMDLINE          9
#define LX_INTERNAL         10
/* W3: the parent asked us to terminate the Job and we CONFIRMED it empty.
 * Still the launcher's own outcome, never the target's. */
#define LX_TERMINATED       11
/* W3: the parent asked us to terminate the Job and we could NOT confirm it
 * empty within the bounded window. A distinct outcome so the caller can never
 * mistake it for a confirmed stop. */
#define LX_STOP_UNCONFIRMED 12

/* Adaptive polling: tight at first, backing off so a long-running agent costs
 * ~20 queries/second instead of spinning. */
#define POLL_FIRST_MS       1
#define POLL_MAX_MS         50

/* W3: how long we wait for the Job to report ActiveProcesses == 0 AFTER a
 * cooperative termination request. TerminateJobObject is asynchronous with
 * respect to the accounting reading, so the wait is real. It is BOUNDED: a tree
 * that will not empty must produce `stop-unconfirmed`, never a hang and never a
 * fabricated `treeStopped=1`. */
#define STOP_EMPTY_TIMEOUT_MS 30000

/*
 * W4.1: how long to wait for the ROOT process HANDLE to signal once the Job is
 * already empty.
 *
 * The two facts are observed through different APIs and are not guaranteed to
 * become true in the same poll: `QueryInformationJobObject` can report
 * ActiveProcesses == 0 in a tick where `WaitForSingleObject(rootHandle)` has not
 * yet returned WAIT_OBJECT_0. The old code broke out of the loop on Job-empty and
 * captured the exit code afterwards but never serialized it, so a real natural
 * success could be emitted WITHOUT the root-exit pair the contract requires.
 *
 * A root whose Job is empty is already terminating, so this wait is normally
 * satisfied in microseconds; the bound exists only so a pathological handle can
 * never hang the launcher. On expiry the launcher FAILS CLOSED rather than
 * fabricating a code.
 */
#define ROOT_EXIT_RECONCILE_MS 5000

/* ------------------------------------------------------------------------ */
/* Control file (the machine control channel)                                */
/* ------------------------------------------------------------------------ */

typedef struct {
    FILE* f;
    int   debug;   /* human stderr text; OFF unless --debug was given */
} diag_t;

/* Returns 1 when there is no requested channel, or the requested channel was
 * opened; 0 when a requested channel could NOT be opened (caller fails closed). */
static int diag_open(diag_t* d, const WCHAR* path) {
    d->f = NULL;
    if (path == NULL) return 1;   /* no channel requested: acceptable */
    d->f = _wfopen(path, L"wb");
    return d->f != NULL;
}

static void diag_line(diag_t* d, const WCHAR* fmt, ...) {
    va_list ap;
    if (d->f == NULL) return;
    va_start(ap, fmt);
    vfwprintf(d->f, fmt, ap);
    va_end(ap);
    fputwc(L'\n', d->f);
    fflush(d->f);
}

/* Human-readable text, ONLY when --debug was requested. Never used for machine
 * signals; the control file and the exit code carry those. */
static void dbg(diag_t* d, const WCHAR* fmt, ...) {
    va_list ap;
    if (!d->debug) return;
    va_start(ap, fmt);
    vfwprintf(stderr, fmt, ap);
    va_end(ap);
    fputwc(L'\n', stderr);
    fflush(stderr);
}

static void diag_close(diag_t* d) {
    if (d->f != NULL) { fclose(d->f); d->f = NULL; }
}

/* ------------------------------------------------------------------------ */
/* Containment state                                                          */
/* ------------------------------------------------------------------------ */

typedef struct {
    HANDLE job;
    HANDLE process;
    HANDLE thread;
    DWORD  root_pid;
    int    job_limit_flags;
    int    tree_stopped;
    int    terminate_failed;
} containment_t;

/* The single internal termination primitive. Everything that stops the tree goes
 * through here, so there is one implementation of "kill it", not several. */
static int terminate_job(containment_t* c, unsigned int exit_code) {
    if (c->job == NULL) return 0;
    return TerminateJobObject(c->job, exit_code) ? 1 : 0;
}

static DWORD job_active_processes(HANDLE job, int* ok) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
    *ok = 0;
    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                                   &info, sizeof(info), NULL)) {
        return 0;
    }
    *ok = 1;
    return info.ActiveProcesses;
}

/*
 * ---------------------------------------------------------------------------
 * W3: the cooperative stop request
 * ---------------------------------------------------------------------------
 *
 * The parent asks us to stop the tree by CREATING a per-run marker file; the
 * mere EXISTENCE of that file is the request. This is deliberately NOT stdin,
 * stdout or stderr: those three belong to the target agent's transport and are
 * never touched by the launcher.
 *
 * WHY A FILE, and why it matters that it is JOB-scoped rather than root-pid
 * scoped:
 *   - the root may already have exited when a cancel arrives (the classic
 *     "root died, grandchild still writing" case), so there may be no root pid
 *     left to stop at all;
 *   - a pid can be RECYCLED between publication and cancellation, so killing a
 *     remembered pid risks force-killing an unrelated process.
 * The Job handle is the one thing that is unambiguously ours, which is why the
 * stop is a JOB operation rather than a root-pid operation.
 *
 * A marker we cannot read at all is treated as "no request yet" and NEVER as
 * "the tree stopped": absence of evidence is not evidence of absence here.
 */
static int stop_signal_seen(const WCHAR* path) {
    DWORD attr;
    if (path == NULL || path[0] == L'\0') return 0;
    attr = GetFileAttributesW(path);
    if (attr == INVALID_FILE_ATTRIBUTES) return 0;
    return 1;
}

int wmain(int argc, WCHAR** argv) {
    const WCHAR* diag_path = NULL;
    const WCHAR* stop_path = NULL;
    int log_argv = 0;
    int debug = 0;
    int raw = 0;
    int stop_seen = 0;
    const WCHAR* app = NULL;
    int sep = -1;
    int i;
    WCHAR* cmdline = NULL;
    w1_cl_status cl_status = W1_CL_OK;
    containment_t c;
    SECURITY_ATTRIBUTES sa;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
    STARTUPINFOEXW siex;
    PROCESS_INFORMATION pi;
    DWORD err;
    DWORD exit_code = 0;
    int have_exit_code = 0;
    /* W4.1: whether the root-exit pair has already been serialized (mid-loop). */
    int root_exit_emitted = 0;
    DWORD poll_ms = POLL_FIRST_MS;
    unsigned long long queries = 0;
    ULONGLONG t0 = 0;
    diag_t diag;

    ZeroMemory(&c, sizeof(c));
    diag.f = NULL;
    diag.debug = 0;

    /*
     * CLI grammar, strictly:
     *
     *   w1joblauncher [launcher-options...] -- <target-exe> [target-args...]
     *
     * Launcher options are parsed ONLY before the FIRST standalone "--".
     * From that "--" onward, option parsing STOPS PERMANENTLY: every remaining
     * token belongs to the target, verbatim.
     *
     * There is deliberately NO pre-scan of argv. Doing so (the W1.1 bug) let a
     * `--debug` / `--diag` / `--log-argv` that appeared AFTER the separator be
     * consumed by the launcher, silently changing launcher behaviour based on
     * tokens that belong to the target. A target agent's own `--debug`,
     * `--diag` or `--log-argv` flags are its business, not ours.
     */
    for (i = 1; i < argc; i++) {
        if (wcscmp(argv[i], L"--") == 0) { sep = i; break; }
        if (wcscmp(argv[i], L"--debug") == 0) {
            debug = 1;
            diag.debug = 1;
        } else if (wcscmp(argv[i], L"--log-argv") == 0) {
            log_argv = 1;
        } else if (wcscmp(argv[i], L"--raw") == 0) {
            raw = 1;
        } else if (wcscmp(argv[i], L"--diag") == 0 && i + 1 < argc) {
            diag_path = argv[++i];
        } else if (wcscmp(argv[i], L"--stop") == 0 && i + 1 < argc) {
            /* W3: per-run cooperative stop marker, in the same per-run control
             * directory as --diag. Parsed here, BEFORE the "--" separator, so it
             * obeys the same sealed W1.2 grammar: a target's own `--stop` after
             * the separator is the target's business. */
            stop_path = argv[++i];
        } else {
            dbg(&diag, L"w1joblauncher: unexpected argument before --");
            return LX_USAGE;
        }
    }
    if (sep < 0 || sep + 1 >= argc) {
        dbg(&diag, L"usage: w1joblauncher [--diag <file>] [--stop <marker>] [--log-argv] [--debug] -- <exe> [args...]");
        return LX_USAGE;
    }

    /*
     * A requested control channel that cannot be opened is a HARD FAILURE, not a
     * silent degradation: losing the control file would lose rootPid,
     * rootExitCode and the containment evidence the caller depends on. We cannot
     * report that through the file itself, so the exit code is the signal.
     */
    if (!diag_open(&diag, diag_path)) {
        dbg(&diag, L"w1joblauncher: cannot open the requested --diag control file");
        return LX_DIAG_OPEN;
    }

    diag_line(&diag, L"launcherPid=%lu", GetCurrentProcessId());
    diag_line(&diag, L"phase=create-job");
    if (stop_path != NULL) diag_line(&diag, L"stopMarker=1");

    if (log_argv) {
        diag_line(&diag, L"targetArgc=%d", argc - sep - 1);
        for (i = sep + 1; i < argc; i++) {
            diag_line(&diag, L"argv[%d]=%ls", i - sep - 1, argv[i]);
        }
    }

    /* ---- build the target command line (checked, bounded, length-limited) -- */
    if (raw) {
        /*
         * RAW / VERBATIM mode. The caller has already built the exact Windows
         * command line -- for example a `cmd.exe /d /s /c "..."` line whose
         * quoting cannot survive per-argument re-quoting (libuv/CRT rules escape
         * `"` as `\"`, which cmd.exe takes literally). The grammar is EXACT:
         *
         *   ... --raw -- <application> <raw-command-line>
         *
         * exactly two values after `--`. Extra values are a HARD ERROR, never
         * silently dropped: silently ignoring them while still reporting success
         * would run a different command than the caller asked for.
         */
        size_t n = 0, n1 = 0, bytes = 0;
        if (argc - sep - 1 != 2) {
            dbg(&diag, L"w1joblauncher: --raw requires exactly <application> <command-line> after --");
            diag_line(&diag, L"launcherStatus=usage-error");
            diag_line(&diag, L"complete=1");
            diag_close(&diag);
            return LX_USAGE;
        }
        app = argv[sep + 1];
        n = wcslen(argv[sep + 2]);
        if (app[0] == L'\0' || n == 0) {
            dbg(&diag, L"w1joblauncher: --raw application and command line must be non-empty");
            diag_line(&diag, L"launcherStatus=usage-error");
            diag_line(&diag, L"complete=1");
            diag_close(&diag);
            return LX_USAGE;
        }
        /* Same explicit Windows limit and overflow-safe sizing as normal mode. */
        if (!w1_checked_add(n, 1, &n1) || n1 > W1_CMDLINE_MAX_WCHARS) {
            dbg(&diag, L"w1joblauncher: raw command line exceeds the Windows command-line limit");
            diag_line(&diag, L"launcherStatus=cmdline-too-long");
            diag_line(&diag, L"complete=1");
            diag_close(&diag);
            return LX_CMDLINE;
        }
        if (!w1_checked_mul(n1, sizeof(WCHAR), &bytes)) {
            diag_line(&diag, L"launcherStatus=internal-error");
            diag_line(&diag, L"complete=1");
            diag_close(&diag);
            return LX_INTERNAL;
        }
        cmdline = (WCHAR*)malloc(bytes);
        if (cmdline == NULL) {
            diag_line(&diag, L"launcherStatus=internal-error");
            diag_line(&diag, L"complete=1");
            diag_close(&diag);
            return LX_INTERNAL;
        }
        wmemcpy(cmdline, argv[sep + 2], n1);
    } else {
        app = argv[sep + 1];
        cmdline = w1_build_command_line(argc - sep - 1, &argv[sep + 1], &cl_status);
        if (cmdline == NULL) {
            const WCHAR* why = (cl_status == W1_CL_TOO_LONG)
                ? L"cmdline-too-long"
                : (cl_status == W1_CL_OVERFLOW ? L"cmdline-overflow" : L"cmdline-oom");
            dbg(&diag, L"w1joblauncher: cannot build the target command line (%ls)", why);
            diag_line(&diag, L"launcherStatus=%ls", why);
            diag_line(&diag, L"complete=1");
            diag_close(&diag);
            return LX_CMDLINE;
        }
    }
    if (log_argv) diag_line(&diag, L"commandLine=%ls", cmdline);

    /* ---- 1. create the Job ------------------------------------------------ */
    ZeroMemory(&sa, sizeof(sa));
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = FALSE;

    /* Unnamed: a named Job could be opened by another process and closed out
     * from under us. We want exactly one owner. */
    c.job = CreateJobObjectW(&sa, NULL);
    if (c.job == NULL) {
        err = GetLastError();
        dbg(&diag, L"w1joblauncher: CreateJobObjectW failed (%lu)", err);
        diag_line(&diag, L"phase=create-job");
        diag_line(&diag, L"launcherStatus=job-create-failed");
        diag_line(&diag, L"win32Error=%lu", err);
        diag_line(&diag, L"complete=1");
        diag_close(&diag);
        return LX_JOB_CREATE;
    }

    /* ---- 2. configure the Job -------------------------------------------- */
    ZeroMemory(&limits, sizeof(limits));
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    /*
     * DELIBERATELY NOT SET:
     *   JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK
     *     these are exactly what would let a descendant leave the Job.
     *   JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
     *     would kill the whole tree when one descendant died of an unhandled
     *     exception, destroying crash evidence; ActiveProcesses==0 already
     *     accounts for lingering siblings, observably.
     */
    c.job_limit_flags = (int)limits.BasicLimitInformation.LimitFlags;

    diag_line(&diag, L"phase=configure-job");
    if (!SetInformationJobObject(c.job, JobObjectExtendedLimitInformation,
                                 &limits, sizeof(limits))) {
        err = GetLastError();
        dbg(&diag, L"w1joblauncher: SetInformationJobObject failed (%lu)", err);
        diag_line(&diag, L"launcherStatus=job-configure-failed");
        diag_line(&diag, L"win32Error=%lu", err);
        diag_line(&diag, L"complete=1");
        CloseHandle(c.job);
        free(cmdline);
        diag_close(&diag);
        return LX_JOB_CONFIG;
    }

    diag_line(&diag, L"killOnJobClose=%d",
              (c.job_limit_flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) ? 1 : 0);
    diag_line(&diag, L"breakawayOkSet=%d",
              (c.job_limit_flags & JOB_OBJECT_LIMIT_BREAKAWAY_OK) ? 1 : 0);
    diag_line(&diag, L"silentBreakawayOkSet=%d",
              (c.job_limit_flags & JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK) ? 1 : 0);

    /* ---- 3. create the target SUSPENDED ---------------------------------- */
    diag_line(&diag, L"phase=create-process");
    ZeroMemory(&siex, sizeof(siex));
    siex.StartupInfo.cb = sizeof(siex);
    siex.StartupInfo.dwFlags = STARTF_USESTDHANDLES;

    /*
     * Inherit EXACTLY the three standard handles, via
     * PROC_THREAD_ATTRIBUTE_HANDLE_LIST (as libuv does) rather than a blanket
     * bInheritHandles=TRUE, which would leak every other inheritable handle in
     * this process into the target and race with any concurrent spawn.
     */
    {
        HANDLE std_h[3];
        HANDLE nul_h[3];
        HANDLE inherit[3];
        LPPROC_THREAD_ATTRIBUTE_LIST attr_list = NULL;
        SIZE_T attr_size = 0;

        for (i = 0; i < 3; i++) {
            std_h[i] = nul_h[i] = NULL;
            DWORD which = (i == 0) ? STD_INPUT_HANDLE
                       : (i == 1) ? STD_OUTPUT_HANDLE : STD_ERROR_HANDLE;
            HANDLE h = GetStdHandle(which);
            if (h != NULL && h != INVALID_HANDLE_VALUE) {
                /* The inherited handle may be non-inheritable (Node and most
                 * pipe creators do not set HANDLE_FLAG_INHERIT), so mark it
                 * inheritable or the target inherits nothing and its output
                 * silently disappears. */
                SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
                std_h[i] = h;
            } else {
                DWORD access = (i == 0) ? GENERIC_READ : (GENERIC_READ | GENERIC_WRITE);
                nul_h[i] = CreateFileW(L"NUL", access,
                                       FILE_SHARE_READ | FILE_SHARE_WRITE,
                                       NULL, OPEN_EXISTING, 0, NULL);
            }
            inherit[i] = (std_h[i] != NULL) ? std_h[i] : nul_h[i];
        }
        siex.StartupInfo.hStdInput  = inherit[0];
        siex.StartupInfo.hStdOutput = inherit[1];
        siex.StartupInfo.hStdError  = inherit[2];

        InitializeProcThreadAttributeList(NULL, 1, 0, &attr_size);
        attr_list = (LPPROC_THREAD_ATTRIBUTE_LIST)malloc(attr_size);
        if (attr_list == NULL ||
            !InitializeProcThreadAttributeList(attr_list, 1, 0, &attr_size) ||
            !UpdateProcThreadAttribute(attr_list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                       inherit, sizeof(inherit), NULL, NULL)) {
            err = GetLastError();
            dbg(&diag, L"w1joblauncher: handle list setup failed (%lu)", err);
            diag_line(&diag, L"launcherStatus=internal-error");
            diag_line(&diag, L"win32Error=%lu", err);
            diag_line(&diag, L"complete=1");
            if (attr_list != NULL) free(attr_list);
            for (i = 0; i < 3; i++) if (nul_h[i] != NULL) CloseHandle(nul_h[i]);
            CloseHandle(c.job);
            free(cmdline);
            diag_close(&diag);
            return LX_INTERNAL;
        }
        siex.lpAttributeList = attr_list;

        t0 = GetTickCount64();
        {
            WCHAR* env_block = GetEnvironmentStringsW();
            BOOL ok = CreateProcessW(
                app,             /* lpApplicationName: exact path, no guessing */
                cmdline,         /* raw lpCommandLine (verbatim in --raw mode) */
                NULL, NULL,
                TRUE,            /* bInheritHandles, constrained by the list */
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                env_block,       /* pass-through, not reconstructed */
                NULL,            /* lpCurrentDirectory: inherit ours */
                &siex.StartupInfo, &pi);
            if (env_block != NULL) FreeEnvironmentStringsW(env_block);
            err = ok ? 0 : GetLastError();
        }

        DeleteProcThreadAttributeList(attr_list);
        free(attr_list);
        for (i = 0; i < 3; i++) if (nul_h[i] != NULL) CloseHandle(nul_h[i]);

        if (err != 0) {
            dbg(&diag, L"w1joblauncher: CreateProcessW failed (%lu)", err);
            diag_line(&diag, L"launcherStatus=create-process-failed");
            diag_line(&diag, L"win32Error=%lu", err);
            diag_line(&diag, L"complete=1");
            CloseHandle(c.job);
            free(cmdline);
            diag_close(&diag);
            return LX_PROC_CREATE;
        }
    }

    c.process = pi.hProcess;
    c.thread  = pi.hThread;
    c.root_pid = pi.dwProcessId;
    diag_line(&diag, L"rootPid=%lu", c.root_pid);
    diag_line(&diag, L"createToAssignMs=%llu", (unsigned long long)(GetTickCount64() - t0));

    /* ---- 4. assign to the Job BEFORE the target ever runs ----------------- */
    diag_line(&diag, L"phase=assign");
    if (!AssignProcessToJobObject(c.job, c.process)) {
        err = GetLastError();
        /* FAIL CLOSED. The target is still suspended and has run nothing.
         * Terminate it rather than resuming it uncontained, and CHECK that the
         * cleanup actually worked -- a failed cleanup is itself recorded, never
         * silently assumed. */
        int term_failed = 0, wait_failed = 0;
        if (!TerminateProcess(c.process, 1)) { term_failed = 1; }
        if (WaitForSingleObject(c.process, 5000) != WAIT_OBJECT_0) { wait_failed = 1; }
        dbg(&diag, L"w1joblauncher: AssignProcessToJobObject failed (%lu); target "
                   L"terminated, NOT resumed", err);
        diag_line(&diag, L"launcherStatus=assign-failed");
        diag_line(&diag, L"win32Error=%lu", err);
        diag_line(&diag, L"assignedBeforeResume=0");
        diag_line(&diag, L"cleanupTerminateFailed=%d", term_failed);
        diag_line(&diag, L"cleanupWaitFailed=%d", wait_failed);
        diag_line(&diag, L"complete=1");
        CloseHandle(c.thread);
        CloseHandle(c.process);
        CloseHandle(c.job);
        free(cmdline);
        diag_close(&diag);
        return LX_ASSIGN;
    }
    diag_line(&diag, L"assignedBeforeResume=1");

    /* ---- 5. resume: the target's first instruction now runs -------------- */
    diag_line(&diag, L"phase=resume");
    if (ResumeThread(c.thread) == (DWORD)-1) {
        err = GetLastError();
        int term_failed = 0, wait_failed = 0;
        dbg(&diag, L"w1joblauncher: ResumeThread failed (%lu); target terminated", err);
        if (!terminate_job(&c, 1)) { term_failed = 1; }
        TerminateProcess(c.process, 1);
        if (WaitForSingleObject(c.process, 5000) != WAIT_OBJECT_0) { wait_failed = 1; }
        diag_line(&diag, L"launcherStatus=resume-failed");
        diag_line(&diag, L"win32Error=%lu", err);
        diag_line(&diag, L"cleanupTerminateFailed=%d", term_failed);
        diag_line(&diag, L"cleanupWaitFailed=%d", wait_failed);
        diag_line(&diag, L"complete=1");
        CloseHandle(c.thread);
        CloseHandle(c.process);
        CloseHandle(c.job);
        free(cmdline);
        diag_close(&diag);
        return LX_RESUME;
    }
    CloseHandle(c.thread);
    c.thread = NULL;
    diag_line(&diag, L"resumed=1");

    /* ---- 6. wait for the JOB to empty, not merely for the root to exit ---- */
    diag_line(&diag, L"phase=wait");
    {
        int accounting_failed = 0;
        int terminate_failed = 0;
        ULONGLONG stop_deadline = 0;
        for (;;) {
            int ok = 0;
            DWORD active = job_active_processes(c.job, &ok);
            queries++;

            if (!ok) {
                err = GetLastError();
                dbg(&diag, L"w1joblauncher: QueryInformationJobObject failed (%lu)", err);
                diag_line(&diag, L"launcherStatus=accounting-failed");
                diag_line(&diag, L"win32Error=%lu", err);
                accounting_failed = 1;
                break;
            }

            if (!have_exit_code && WaitForSingleObject(c.process, 0) == WAIT_OBJECT_0) {
                if (GetExitCodeProcess(c.process, &exit_code)) {
                    have_exit_code = 1;
                    root_exit_emitted = 1;
                    diag_line(&diag, L"rootExitObserved=1");
                    diag_line(&diag, L"rootExitCode=%lu", exit_code);
                    diag_line(&diag, L"activeProcessesAtRootExit=%lu", active);
                }
            }

            /*
             * W3: COOPERATIVE STOP. The parent asked (by creating the marker); we
             * terminate the WHOLE JOB, then KEEP POLLING until the Job's own
             * accounting says ActiveProcesses == 0. We deliberately do NOT exit
             * after requesting termination: the whole point is that the launcher
             * SURVIVES long enough to positively confirm the tree is empty and
             * then write that fact into the control record. A launcher that was
             * itself killed could never produce that evidence, which is exactly
             * why cancelling by killing the launcher is not trustworthy.
             */
            if (!stop_seen && stop_signal_seen(stop_path)) {
                stop_seen = 1;
                diag_line(&diag, L"stopRequested=1");
                if (!terminate_job(&c, 1)) {
                    terminate_failed = 1;
                    err = GetLastError();
                    diag_line(&diag, L"terminateJobFailed=1");
                    diag_line(&diag, L"terminateWin32Error=%lu", err);
                    dbg(&diag, L"w1joblauncher: TerminateJobObject failed (%lu)", err);
                }
                stop_deadline = GetTickCount64() + STOP_EMPTY_TIMEOUT_MS;
            }

            if (active == 0) {
                /*
                 * W4.1: record the FACT here, but do NOT serialize the tree-stop
                 * fields yet. The root-exit pair may still be unresolved, and the
                 * final record must be serialized only after reconciliation — see
                 * the post-loop block. Emitting `treeStopped=1` now would leave a
                 * record that claims a stop without the exit pair, which is exactly
                 * the invalid success this round closes.
                 */
                c.tree_stopped = 1;
                break;
            }

            /* Bounded wait. A tree that does not empty after a termination
             * request is an UNCONFIRMED stop, and must be reported as such
             * rather than claimed. */
            if (stop_seen && stop_deadline != 0 && GetTickCount64() > stop_deadline) {
                diag_line(&diag, L"stopEmptyTimeout=1");
                diag_line(&diag, L"activeProcessesAtStopTimeout=%lu", active);
                break;
            }

            Sleep(poll_ms);
            poll_ms += poll_ms / 2 + 1;
            if (poll_ms > POLL_MAX_MS) poll_ms = POLL_MAX_MS;
        }

        if (!accounting_failed) {
            /*
             * W4.1: ROOT-HANDLE FINAL RECONCILIATION.
             *
             * Job-empty proves the tree is gone, but it does NOT by itself prove we
             * have the root's exit code: the two are read through different APIs and
             * the Job can read 0 in a tick where the process handle has not yet
             * signalled. The old code captured the code here but never wrote it into
             * the record, so a genuine natural success could be serialized without
             * `rootExitObserved`/`rootExitCode` and be (correctly) rejected by the
             * consumer as an invalid success.
             *
             * So: if the pair is still unknown, wait — BOUNDED — for the handle, then
             * read the code. `STILL_ACTIVE` is NOT an exit code and is rejected; a
             * fabricated 0 is never written. If it still cannot be obtained, the
             * finalization below fails closed instead of emitting `success`.
             */
            if (!have_exit_code) {
                DWORD wr = WaitForSingleObject(c.process, ROOT_EXIT_RECONCILE_MS);
                if (wr == WAIT_OBJECT_0) {
                    DWORD reconciled = 0;
                    if (GetExitCodeProcess(c.process, &reconciled) && reconciled != STILL_ACTIVE) {
                        exit_code = reconciled;
                        have_exit_code = 1;
                        diag_line(&diag, L"rootExitReconciled=1");
                    }
                }
            }
            diag_line(&diag, L"jobQueries=%llu", queries);
        }
        if (terminate_failed) c.terminate_failed = 1;
    }

    /* ---- 7. release everything -------------------------------------------- */
    if (c.thread != NULL) CloseHandle(c.thread);
    if (c.process != NULL) CloseHandle(c.process);
    if (c.job != NULL) CloseHandle(c.job);
    free(cmdline);

    diag_line(&diag, L"phase=done");
    if (c.tree_stopped) {
        int cooperative = stop_seen && !c.terminate_failed;

        /*
         * Emit the root-exit pair once, if it is known and was not already emitted
         * mid-loop. Ordering is irrelevant to the consumer (it parses key=value
         * lines into a map), and this keeps the "final serialization after
         * reconciliation" property: every branch below runs after the post-loop
         * reconciliation.
         */
        if (have_exit_code && !root_exit_emitted) {
            diag_line(&diag, L"rootExitObserved=1");
            diag_line(&diag, L"rootExitCode=%lu", exit_code);
            root_exit_emitted = 1;
        }

        if (cooperative) {
            /*
             * W3 unchanged. A tree terminated ON REQUEST and then confirmed empty is
             * `terminated`, not `success`. The root-exit pair is OPTIONAL here: a
             * cooperative stop may kill the tree before the root's own exit was ever
             * observed, and demanding one would invite a fabrication.
             */
            diag_line(&diag, L"treeStopped=1");
            diag_line(&diag, L"activeProcessesFinal=0");
            diag_line(&diag, L"launcherStatus=terminated");
            diag_line(&diag, L"complete=1");
            diag_close(&diag);
            return LX_TERMINATED;
        }

        /*
         * W4.1: NATURAL completion. `success` is emitted ONLY with the mandatory
         * root-exit pair. This is the invariant that used to be violated ~4/5 times
         * for a real OpenCode run.
         */
        if (have_exit_code) {
            diag_line(&diag, L"treeStopped=1");
            diag_line(&diag, L"activeProcessesFinal=0");
            diag_line(&diag, L"launcherStatus=success");
            diag_line(&diag, L"complete=1");
            diag_close(&diag);
            return LX_OK;
        }

        /*
         * The Job is empty, but the root's exit code could not be obtained even after
         * bounded reconciliation. FAIL CLOSED: never emit a `success` without the pair,
         * never fabricate a code, and emit NO tree-stop fact — the consumer must read
         * this as "no evidence", not as a completed run. `accounting-failed` is the
         * existing status for "the accounting/exit facts could not be established".
         */
        diag_line(&diag, L"rootExitUnavailable=1");
        diag_line(&diag, L"launcherStatus=accounting-failed");
        diag_line(&diag, L"complete=1");
        diag_close(&diag);
        return LX_ACCOUNTING;
    }
    /*
     * W3: the parent asked us to stop the tree and we could NOT confirm the Job
     * empty (termination failed, the accounting query failed, or the bounded wait
     * expired). Report NO tree-stop fact at all. The consumer then fails closed and
     * KEEPS write protection, which is the only safe reading: a descendant may
     * still be writing.
     */
    if (stop_seen) {
        diag_line(&diag, L"launcherStatus=stop-unconfirmed");
        diag_line(&diag, L"complete=1");
        diag_close(&diag);
        return LX_STOP_UNCONFIRMED;
    }
    /* Reaching here means accounting failed (treeStopped never set). */
    diag_line(&diag, L"complete=1");
    diag_close(&diag);
    return LX_ACCOUNTING;
}
