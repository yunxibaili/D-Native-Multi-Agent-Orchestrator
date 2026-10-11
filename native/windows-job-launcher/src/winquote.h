/*
 * native/windows-job-launcher/src/winquote.h
 *
 * Windows command-line quoting, ADAPTED from libuv v1.x, src/win/process.c.
 *
 *   Copyright Joyent, Inc. and other Node contributors.
 *   Licensed under the MIT License.
 *   https://github.com/libuv/libuv/blob/v1.x/src/win/process.c
 *
 * WHY ADAPTED RATHER THAN INVENTED
 *   libuv is the implementation Node itself uses to build a Windows child
 *   command line. Reusing its exact rules means a command line this project
 *   assembles is parsed by the target byte-identically to one Node assembled --
 *   which is precisely the compatibility property W2 will depend on. A
 *   hand-rolled "escape the quotes and hope" implementation is how spaces,
 *   trailing backslashes and empty arguments silently corrupt agent argv.
 *
 * Provenance notes:
 *   - `w1_quote_cmd_arg` is transcribed from libuv's `quote_cmd_arg`, including
 *     its documented input/output table.
 *   - `w1_build_command_line` follows libuv's `make_program_args` two-pass model
 *     (size pass, then encode pass).
 *   - The changes are: explicit WCHAR* return-buffer style instead of libuv's
 *     allocator/arena conventions; a bounded encoder; overflow-safe size
 *     arithmetic; and a whole-command-line length limit.
 *
 * W1.1 HARDENING (why this file is stricter than the W1 version)
 *   The W1 sizing rule was `need += 2*len + 2` per argument. That is wrong for
 *   an EMPTY argument: it emits `""` (2 units) AND is still followed by a
 *   separator space (1 unit) unless it is the last argument, so it can need 3
 *   units while only 2 were reserved. With N empty arguments the real
 *   requirement is 3N (separators + quoted empties + terminator) but only 2N+1
 *   was reserved, so the encode pass ran past the buffer and corrupted the heap
 *   (observed as 0xC0000374 = STATUS_HEAP_CORRUPTION at ~200 arguments).
 *
 *   Two independent defences now exist, so a sizing mistake can never again
 *   become memory corruption:
 *     1. a size pass built from checked_add/checked_mul that computes a proven
 *        upper bound, plus a hard limit against the Windows command-line limit;
 *     2. a BOUNDED encoder that refuses to write at or past the end of the
 *        buffer and reports failure instead of overrunning it.
 *
 * Reused by both the launcher (to build the target command line) and the test
 * fixture (to spawn its own descendants), so there is exactly ONE quoting
 * implementation under test.
 */

#ifndef W1_WINQUOTE_H
#define W1_WINQUOTE_H

#include <wchar.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>

/*
 * CreateProcessW accepts an lpCommandLine of at most 32767 UTF-16 code units,
 * INCLUDING the terminating NUL. A command line that cannot be represented
 * within that limit is a hard failure: this code fails closed and never
 * truncates, because a silently truncated command line would run a DIFFERENT
 * command than the caller asked for.
 */
#define W1_CMDLINE_MAX_WCHARS 32767

typedef enum {
    W1_CL_OK = 0,
    W1_CL_TOO_LONG,   /* would exceed W1_CMDLINE_MAX_WCHARS */
    W1_CL_OVERFLOW,   /* size_t arithmetic overflowed */
    W1_CL_OOM         /* allocation failed */
} w1_cl_status;

/* Overflow-checked size arithmetic. Return 1 on success, 0 on overflow. */
static int w1_checked_add(size_t a, size_t b, size_t* out) {
    if (a > SIZE_MAX - b) return 0;
    *out = a + b;
    return 1;
}

static int w1_checked_mul(size_t a, size_t b, size_t* out) {
    if (a != 0 && b > SIZE_MAX / a) return 0;
    *out = a * b;
    return 1;
}

/*
 * Quotes ONE command-line argument into [target, end).
 *
 * Returns a pointer to the next position to be written (one past the last
 * character written, no terminator), or NULL if the argument would not fit
 * before `end`. NULL is a hard failure, never a partial write: every character
 * is emitted through the bounds-checked W1_EMIT macro.
 *
 * Worst-case output for an argument of `len` UTF-16 code units is 2*len + 2:
 * two surrounding quotes plus, in the worst case, one escape before every
 * character. This is the bound the size pass in w1_build_command_line uses.
 */
static WCHAR* w1_quote_cmd_arg(const WCHAR* source, WCHAR* target, const WCHAR* end) {
    size_t len = wcslen(source);
    size_t i;
    int quote_hit;
    WCHAR* start;

#define W1_EMIT(ch) do { if (target >= end) return NULL; *target++ = (ch); } while (0)

    if (len == 0) {
        /* An empty argument must still be quoted, or it vanishes entirely. */
        W1_EMIT(L'"');
        W1_EMIT(L'"');
        return target;
    }

    if (NULL == wcspbrk(source, L" \t\"")) {
        /* No space, tab or quote: copy verbatim. */
        for (i = 0; i < len; i++) W1_EMIT(source[i]);
        return target;
    }

    if (NULL == wcspbrk(source, L"\"\\")) {
        /* Space/tab present but no quote or backslash: just wrap it. */
        W1_EMIT(L'"');
        for (i = 0; i < len; i++) W1_EMIT(source[i]);
        W1_EMIT(L'"');
        return target;
    }

    /*
     * The general case. From libuv's own documented table:
     *   input : hello"world     output: "hello\"world"
     *   input : hello""world    output: "hello\"\"world"
     *   input : hello\world     output: "hello\\world"
     *   input : hello\\world    output: "hello\\\\world"
     *   input : hello\"world    output: "hello\\\"world"
     *   input : hello\\"world   output: "hello\\\\\"world"
     *   input : hello world\    output: "hello world\\"
     *
     * The trailing-backslash case is the one naive quoting gets wrong: a
     * backslash run immediately before the closing quote must be doubled or it
     * escapes the quote and swallows the rest of the command line.
     */
    W1_EMIT(L'"');
    start = target;
    quote_hit = 1;

    for (i = len; i > 0; --i) {
        WCHAR c = source[i - 1];
        W1_EMIT(c);
        if (quote_hit && c == L'\\') {
            W1_EMIT(L'\\');
        } else if (c == L'"') {
            quote_hit = 1;
            W1_EMIT(L'\\');
        } else {
            quote_hit = 0;
        }
    }

    /* _wcsrev needs a sentinel; it is written into the slot the closing quote
     * then occupies, so it costs no extra space, but the slot must exist. */
    if (target >= end) return NULL;
    *target = L'\0';
    _wcsrev(start);
    W1_EMIT(L'"');
    return target;

#undef W1_EMIT
}

/*
 * Builds a complete NUL-terminated command line from argv[0..argc-1], each
 * argument quoted by w1_quote_cmd_arg and separated by a single space.
 *
 * Two passes, exactly as libuv does:
 *   pass 1  compute an upper bound with overflow-checked arithmetic
 *   pass 2  allocate once and encode through the bounded encoder
 *
 * Returns a malloc'ed buffer (caller frees) or NULL with *status set. NULL is
 * always a hard failure: the caller must NOT run the target.
 *
 * Per-argument upper bound: 2*len + 2 for the quoted content, +1 for the
 * separator that may precede the NEXT argument. argc-1 separators and one final
 * NUL are effectively covered, with slack, because the FIRST argument has no
 * separator and the last argument needs no trailing space.
 */
static WCHAR* w1_build_command_line(int argc, WCHAR** argv, w1_cl_status* status) {
    size_t need = 1;              /* final NUL */
    size_t bytes;
    WCHAR* cmd;
    WCHAR* pos;
    const WCHAR* end;
    int i;

    *status = W1_CL_OK;

    for (i = 0; i < argc; i++) {
        size_t len = wcslen(argv[i]);
        size_t content;           /* 2*len + 2 (quotes + worst-case escapes) */
        size_t slot;              /* content + 1 separator */

        if (!w1_checked_mul(len, 2, &content)) { *status = W1_CL_OVERFLOW; return NULL; }
        if (!w1_checked_add(content, 2, &content)) { *status = W1_CL_OVERFLOW; return NULL; }
        if (!w1_checked_add(content, 1, &slot)) { *status = W1_CL_OVERFLOW; return NULL; }
        if (!w1_checked_add(need, slot, &need)) { *status = W1_CL_OVERFLOW; return NULL; }
    }

    /* Windows cannot represent a longer command line. Fail closed; never truncate. */
    if (need > W1_CMDLINE_MAX_WCHARS) { *status = W1_CL_TOO_LONG; return NULL; }

    if (!w1_checked_mul(need, sizeof(WCHAR), &bytes)) { *status = W1_CL_OVERFLOW; return NULL; }

    cmd = (WCHAR*)malloc(bytes);
    if (cmd == NULL) { *status = W1_CL_OOM; return NULL; }

    end = cmd + need;   /* one past the last writable WCHAR */
    pos = cmd;
    for (i = 0; i < argc; i++) {
        if (i > 0) {
            if (pos >= end) { free(cmd); *status = W1_CL_OVERFLOW; return NULL; }
            *pos++ = L' ';
        }
        pos = w1_quote_cmd_arg(argv[i], pos, end);
        if (pos == NULL) { free(cmd); *status = W1_CL_OVERFLOW; return NULL; }
    }
    if (pos >= end) { free(cmd); *status = W1_CL_OVERFLOW; return NULL; }
    *pos = L'\0';       /* exactly one terminator for the whole command line */

    return cmd;
}

#endif /* W1_WINQUOTE_H */
