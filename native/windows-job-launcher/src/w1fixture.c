/*
 * native/windows-job-launcher/src/w1fixture.c
 *
 * W1 test fixture: a deliberately multi-generation process tree, plus the
 * utilities the containment tests need.
 *
 * It exists to make three claims falsifiable:
 *   1. a descendant THREE generations deep is really contained;
 *   2. a root that exits first does NOT make the tree stop;
 *   3. a target that spawns at the earliest possible instant cannot escape a
 *      Job it was assigned to before it was resumed.
 *
 * Every node writes its own PID to its own file as its first action, so the test
 * knows the exact PID of every generation and probes liveness directly with
 * OpenProcess (via --role probe) rather than trusting tasklist text.
 *
 * Output encoding: stdout is written as explicit UTF-8 BYTES, not via wprintf.
 * mingw's wide stdio converts through the C locale, which turns non-ASCII into
 * '?', and that would make the Unicode inheritance and quoting tests fail for a
 * reason that has nothing to do with what is being tested.
 *
 * Usage:
 *   w1fixture --role <root|child|grandchild|solo|probe|echo|envinfo>
 *             --pidfile <path>          where I write my own PID
 *             --child-pidfile <path>    where my CHILD writes its PID
 *             --grandchild-pidfile <p>  where my GRANDCHILD writes its PID
 *             --spawn <0|1>             spawn the next generation immediately
 *             --hold-ms <n>             stay alive this long
 *             --iterations <n>          loop n times (~50ms each); 0 = forever
 *             --exitcode <n>            exit with this code
 *             --pid <n>                 (probe role) PID to test
 *             --name <s>                (envinfo role) env var to print
 */

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

#include "winquote.h"

/*
 * Default bound for the `observe` role's WaitForSingleObject. An observer is a
 * test helper and must be able to self-terminate: even if a caller forgets to close
 * it, it reports STILL_RUNNING and exits rather than lingering forever holding a
 * handle on a process the test has finished with.
 */
#define OBSERVE_DEFAULT_WAIT_MS 120000

/* ------------------------------------------------------------------------ */
/* Output: explicit UTF-8 bytes, so Unicode survives a pipe unchanged.        */
/* ------------------------------------------------------------------------ */

static void out_line_utf8(const WCHAR* s) {
    int need;
    char* buf;
    if (s == NULL) s = L"";
    need = WideCharToMultiByte(CP_UTF8, 0, s, -1, NULL, 0, NULL, NULL);
    if (need <= 0) return;
    buf = (char*)malloc((size_t)need);
    if (buf == NULL) return;
    if (WideCharToMultiByte(CP_UTF8, 0, s, -1, buf, need, NULL, NULL) > 0) {
        /* -1 includes the terminating NUL; do not write it. */
        fwrite(buf, 1, (size_t)(need - 1), stdout);
    }
    free(buf);
    fputc('\n', stdout);
    fflush(stdout);
}

/* Write our own PID. Done before anything that could block, so the test never
 * has to guess whether a node has come into existence. */
static void write_pid(const WCHAR* path) {
    FILE* f;
    if (path == NULL || path[0] == L'\0') return;
    f = _wfopen(path, L"wb");
    if (f == NULL) return;
    fprintf(f, "%lu\n", GetCurrentProcessId());
    fclose(f);
}

static void stay_alive(DWORD hold_ms, unsigned long iterations) {
    unsigned long i;
    if (iterations == 0) {
        /* Forever, but interruptible: the test terminates the launcher to end
         * the scenario, so a single hard Sleep would also block that. */
        for (;;) Sleep(50);
    }
    for (i = 0; i < iterations; i++) {
        if (hold_ms > 0 && (i + 1) >= iterations) Sleep(hold_ms);
        else Sleep(50);
    }
}

/*
 * Spawn the next generation with the SAME executable and INHERITED stdio.
 *
 * This is what makes the escape question real: the child is created by a process
 * already inside the Job, so it is implicitly associated with every Job in the
 * parent's chain. If breakaway were permitted, the child, and its own
 * descendants, would silently leave the Job and leak.
 *
 * We never wait on the child. A parent that exits while a descendant still runs
 * is the exact scenario W0 identified, so the fixture must be able to produce it.
 */
static void spawn_next(const WCHAR* self_exe,
                       const WCHAR* next_role,
                       const WCHAR* next_pidfile,
                       const WCHAR* grandchild_pidfile,
                       unsigned long iterations) {
    WCHAR numbuf[16];
    WCHAR* argv[16];
    int argc = 0;
    WCHAR* cmdline;
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    BOOL ok;

    ZeroMemory(&si, sizeof(si));
    ZeroMemory(&pi, sizeof(pi));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput  = GetStdHandle(STD_INPUT_HANDLE);
    si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    si.hStdError  = GetStdHandle(STD_ERROR_HANDLE);

    argv[argc++] = (WCHAR*)L"w1fixture";
    argv[argc++] = (WCHAR*)L"--role";
    argv[argc++] = (WCHAR*)next_role;
    if (next_pidfile != NULL && next_pidfile[0] != L'\0') {
        argv[argc++] = (WCHAR*)L"--pidfile";
        argv[argc++] = (WCHAR*)next_pidfile;
    }
    if (grandchild_pidfile != NULL && grandchild_pidfile[0] != L'\0') {
        /* Only an intermediate node needs the grandchild's file: it is the one
         * that will spawn it. */
        argv[argc++] = (WCHAR*)L"--grandchild-pidfile";
        argv[argc++] = (WCHAR*)grandchild_pidfile;
    }
    /* A node we spawn that is itself intermediate must spawn on, so one
     * invocation actually builds a three-generation chain. */
    if (wcscmp(next_role, L"grandchild") != 0) {
        argv[argc++] = (WCHAR*)L"--spawn";
        argv[argc++] = (WCHAR*)L"1";
    }
    if (iterations > 0) {
        argv[argc++] = (WCHAR*)L"--iterations";
        _snwprintf_s(numbuf, 16, _TRUNCATE, L"%lu", iterations);
        argv[argc++] = numbuf;
    }

    {
        w1_cl_status cl_status = W1_CL_OK;
        cmdline = w1_build_command_line(argc, argv, &cl_status);
    }
    if (cmdline == NULL) return;

    ok = CreateProcessW(self_exe, cmdline, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi);
    free(cmdline);
    if (!ok) return;
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
}

int wmain(int argc, WCHAR** argv) {
    const WCHAR* role = NULL;
    const WCHAR* pidfile = NULL;
    const WCHAR* child_pidfile = NULL;
    const WCHAR* grandchild_pidfile = NULL;
    const WCHAR* name = NULL;
    DWORD pid_to_probe = 0;
    int do_spawn = 0;
    DWORD hold_ms = 0;
    unsigned long iterations = 0;
    int exitcode = 0;
    int i;
    WCHAR self_exe[MAX_PATH];
    WCHAR cwd[MAX_PATH];
    WCHAR line[MAX_PATH + 64];

    for (i = 1; i < argc; i++) {
        if (wcscmp(argv[i], L"--role") == 0 && i + 1 < argc) role = argv[++i];
        else if (wcscmp(argv[i], L"--pidfile") == 0 && i + 1 < argc) pidfile = argv[++i];
        else if (wcscmp(argv[i], L"--child-pidfile") == 0 && i + 1 < argc) child_pidfile = argv[++i];
        else if (wcscmp(argv[i], L"--grandchild-pidfile") == 0 && i + 1 < argc) grandchild_pidfile = argv[++i];
        else if (wcscmp(argv[i], L"--spawn") == 0 && i + 1 < argc) do_spawn = (wcscmp(argv[++i], L"1") == 0);
        else if (wcscmp(argv[i], L"--hold-ms") == 0 && i + 1 < argc) hold_ms = (DWORD)_wtoi(argv[++i]);
        else if (wcscmp(argv[i], L"--iterations") == 0 && i + 1 < argc) iterations = wcstoul(argv[++i], NULL, 10);
        else if (wcscmp(argv[i], L"--exitcode") == 0 && i + 1 < argc) exitcode = _wtoi(argv[++i]);
        else if (wcscmp(argv[i], L"--pid") == 0 && i + 1 < argc) pid_to_probe = (DWORD)_wtoi(argv[++i]);
        else if (wcscmp(argv[i], L"--name") == 0 && i + 1 < argc) name = argv[++i];
    }

    if (role == NULL) role = L"solo";

    /*
     * ---- observe: SAME-PROCESS handle observation (W5.1a P1-4) -------------
     *
     * This is a NEW, test-only observation mode. It deliberately does NOT change
     * the `probe` role above: W1-W4 rely on `probe`'s exact contract, and `probe`
     * conflates "OpenProcess failed" with "target gone" (both -> 1). That
     * conflation is exactly what a liveness assertion must not do.
     *
     * `observe` is a LONG-LIVED observer OUTSIDE any test Job. It:
     *   1. opens the target ONCE and HOLDS that original handle for its lifetime,
     *      so a later PID reuse can never be mistaken for the original process;
     *   2. writes an ACK file only after the handle was successfully acquired
     *      (so a test may not trigger a stop before the handle exists);
     *   3. then waits on THAT HANDLE and reports the wait result as a DISTINCT
     *      exit code, so "still running" is never reported as "exited".
     *
     * Exit codes (distinct on purpose):
     *   0  WAIT_OBJECT_0      -> the HELD process terminated (same-process proof)
     *   10 WAIT_TIMEOUT       -> still running; observation is NOT a death
     *   11 WAIT_FAILED        -> observation failure; NOT a death
     *   12 OpenProcess failed -> could not observe; NOT a death
     *   13 bad args / no target
     *
     * The observer itself exiting or dying can therefore never masquerade as the
     * target's exit: the caller keys on the HELD HANDLE, not on this process.
     */
    if (wcscmp(role, L"observe") == 0) {
        HANDLE h;
        DWORD wr;
        if (pid_to_probe == 0) return 13;

        /* SYNCHRONIZE is what makes the later wait meaningful; query rights are
         * only for a start-time cross-check. */
        h = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                        FALSE, pid_to_probe);
        if (h == NULL) return 12;           /* cannot observe; explicitly NOT "exited" */

        /*
         * ACK: the handle is now HELD. Emitted on STDOUT and explicitly flushed,
         * because the test reads it as the readiness handshake that the handle was
         * acquired BEFORE any stop is triggered.
         *
         * Deliberately NOT written to a file: on this workstation a `D:` process
         * cannot write to `C:` (the W1 10.9 cross-volume finding), and the observer
         * must be able to ACK regardless of where the test's scratch lives. stdout
         * avoids that dependency entirely.
         */
        _snwprintf_s(line, MAX_PATH + 64, _TRUNCATE, L"handle=ok pid=%lu", pid_to_probe);
        out_line_utf8(line);
        fflush(stdout);

        /*
         * Wait on the ORIGINAL handle, not on a re-opened PID.
         *
         * The wait is BOUNDED on purpose: an observer must be able to outlive its
         * own test only as a self-terminating process, never as a permanent one. A
         * default bound (not INFINITE) guarantees that even if a caller forgets to
         * close the observer, it reports STILL_RUNNING and exits instead of
         * lingering and holding a handle.
         */
        wr = WaitForSingleObject(h, hold_ms > 0 ? hold_ms : OBSERVE_DEFAULT_WAIT_MS);
        CloseHandle(h);
        if (wr == WAIT_OBJECT_0) return 0;      /* terminated: same-process proof */
        if (wr == WAIT_TIMEOUT) return 10;       /* still running */
        if (wr == WAIT_FAILED) return 11;       /* observation failed */
        return 11;
    }

    /* ---- probe: OpenProcess liveness, NOT tasklist text ------------------ */
    if (wcscmp(role, L"probe") == 0) {
        HANDLE h;
        DWORD code = 0;
        if (pid_to_probe == 0) return 2;
        h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                        FALSE, pid_to_probe);
        if (h == NULL) {
            /* Cannot open == either gone or inaccessible. Report "not provably
             * alive" so an inaccessible process can never mask a leak. */
            return 1;
        }
        if (WaitForSingleObject(h, 0) == WAIT_OBJECT_0) { CloseHandle(h); return 1; }
        if (GetExitCodeProcess(h, &code) && code == STILL_ACTIVE) {
            CloseHandle(h);
            return 0; /* alive */
        }
        CloseHandle(h);
        return 1;
    }

    /* ---- echo: print argv exactly as received ---------------------------- */
    if (wcscmp(role, L"echo") == 0) {
        for (i = 0; i < argc; i++) out_line_utf8(argv[i]);
        return 0;
    }

    /* ---- envinfo: cwd + one env var --------------------------------------- */
    if (wcscmp(role, L"envinfo") == 0) {
        if (GetCurrentDirectoryW(MAX_PATH, cwd) == 0) wcscpy(cwd, L"<error>");
        _snwprintf_s(line, MAX_PATH + 64, _TRUNCATE, L"cwd=%ls", cwd);
        out_line_utf8(line);
        if (name != NULL) {
            const WCHAR* v = _wgetenv(name);
            _snwprintf_s(line, MAX_PATH + 64, _TRUNCATE, L"env.%ls=%ls", name,
                         v ? v : L"<unset>");
            out_line_utf8(line);
        }
        return 0;
    }

    /* ---- process-tree roles -----------------------------------------------
     * write_pid happens for every role, then a spawn of the next generation is
     * attempted IMMEDIATELY when asked. Between those two statements we do no
     * sleeping, no disk I/O and no diagnostics: the descendant spawn races the
     * launcher's ResumeThread about as tightly as a real agent's would.
     */
    GetModuleFileNameW(NULL, self_exe, MAX_PATH);
    write_pid(pidfile);

    if (do_spawn) {
        if (wcscmp(role, L"root") == 0) {
            /* root -> child (the child will itself spawn the grandchild) */
            spawn_next(self_exe, L"child", child_pidfile, grandchild_pidfile, iterations);
        } else {
            /* child -> grandchild */
            spawn_next(self_exe, L"grandchild", grandchild_pidfile, NULL, iterations);
        }
    }

    if (wcscmp(role, L"grandchild") == 0) {
        /* By default loop forever: this is the historical blocker, a process
         * that outlives its root and keeps holding the workspace open. */
        stay_alive(hold_ms, iterations);
        return exitcode;
    }

    if (wcscmp(role, L"child") == 0) {
        /* Hold briefly so the grandchild, not the child, is the long-lived one. */
        if (hold_ms == 0 && iterations == 0) hold_ms = 120;
        stay_alive(hold_ms, iterations);
        return exitcode;
    }

    if (wcscmp(role, L"root") == 0) {
        /* Exit IMMEDIATELY, leaving child + grandchild running. This is the
         * root-exits-first case that W0 says must not be read as tree-stopped. */
        return exitcode;
    }

    /* solo */
    if (hold_ms == 0 && iterations == 0) return exitcode;
    stay_alive(hold_ms, iterations);
    return exitcode;
}
