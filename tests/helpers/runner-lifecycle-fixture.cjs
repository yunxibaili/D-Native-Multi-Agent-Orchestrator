/**
 * tests/helpers/runner-lifecycle-fixture.cjs — the CONTROLLED child used by the
 * execution-lifecycle runner cases (R5-1.2 Case 24 / R5-1.2C Case 32).
 *
 * It plays two fixed roles, selected by FIXED inputs only — never by an arbitrary
 * command/eval payload from the environment:
 *
 *   1. PRELOAD (`node --require <this file> scripts/test-timed.mjs`), selected by
 *      RUNNER_LIFECYCLE_PRELOAD_MODE:
 *        - 'spawn-error': redirect the runner's own `process.execPath` to a
 *          deliberately nonexistent executable under the OWNED temp root, so the
 *          runner's real `spawn()` call fails with a real OS ENOENT and the runner
 *          classifies the fact as `spawn-error`.
 *        - 'interrupt': arm a bounded, unref'ed polling timer that emits a real
 *          SIGINT INSIDE the runner once the parent's GO marker appears. The GO
 *          marker is written only after the parent has PROVEN the controlled
 *          suite/descendant really started.
 *      An unknown mode fails closed (exit 2).
 *
 *   2. WRITER (`node <this file> writer`), selected by being the MAIN module with a
 *      fixed `writer` argv: append a bounded heartbeat under the owned temp root.
 *      No code is ever supplied through the environment.
 *
 * It imports no product API and owns no authority: it only injects a controlled
 * ENOENT / signal, or writes fixed files.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** The ONLY owned temp roots this fixture will ever read/write. */
const OWNED_ROOT_PREFIXES = ['r512-case24-', 'r512c-case32-'];

/**
 * Resolve and VALIDATE the owned temp root BEFORE any file is written.
 *
 * A missing / empty / relative value must fail closed rather than resolving to
 * the process's CURRENT DIRECTORY, and the root must be the absolute, EXISTING
 * directory the parent created directly under the OS temp dir, named with one of
 * the fixed owned-root prefixes. No global scan is performed; nothing is killed.
 */
function ownedRoot() {
  const t = process.env.RUNNER_LIFECYCLE_TMP;
  if (typeof t !== 'string' || t === '') {
    throw new Error('runner-lifecycle-fixture: RUNNER_LIFECYCLE_TMP is required');
  }
  if (!path.isAbsolute(t)) {
    throw new Error(`runner-lifecycle-fixture: RUNNER_LIFECYCLE_TMP must be absolute: "${t}"`);
  }
  let st;
  try {
    st = fs.statSync(t);
  } catch {
    throw new Error(`runner-lifecycle-fixture: RUNNER_LIFECYCLE_TMP does not exist: "${t}"`);
  }
  if (!st.isDirectory()) {
    throw new Error(`runner-lifecycle-fixture: RUNNER_LIFECYCLE_TMP is not a directory: "${t}"`);
  }
  const parent = path.dirname(t);
  const tmp = path.resolve(os.tmpdir());
  const sameParent =
    process.platform === 'win32'
      ? parent.toLowerCase() === tmp.toLowerCase()
      : parent === tmp;
  if (!sameParent || !OWNED_ROOT_PREFIXES.some((p) => path.basename(t).startsWith(p))) {
    throw new Error(`runner-lifecycle-fixture: RUNNER_LIFECYCLE_TMP is not an owned test root: "${t}"`);
  }
  return t;
}

/** WRITER role: heartbeat forever. The file paths are the parent's owned root. */
function runWriter() {
  const beat = path.join(ownedRoot(), 'writer-heartbeat.txt');
  setInterval(() => {
    try {
      fs.appendFileSync(beat, `${Date.now()}\n`);
    } catch {
      /* a heartbeat must never crash the writer */
    }
  }, 40);
}

/** PRELOAD 'spawn-error': make the runner's real spawn() fail with a real ENOENT. */
function armSpawnError() {
  const missing = path.join(ownedRoot(), 'missing-runner-executable.exe');
  process.execPath = missing;
  if (process.execPath !== missing) {
    // A plain assignment was refused; try redefining the (configurable) property
    // rather than silently spawning the real node.
    try {
      Object.defineProperty(process, 'execPath', { value: missing, writable: true, configurable: true });
    } catch {
      /* fall through to the loud report below */
    }
  }
  if (process.execPath !== missing) {
    process.stderr.write('runner-lifecycle-fixture: could not redirect process.execPath\n');
  }
}

/** PRELOAD 'interrupt': emit SIGINT inside the runner once the GO marker exists. */
function armInterrupt() {
  const go = process.env.RUNNER_LIFECYCLE_GO;
  if (typeof go !== 'string' || go === '') return;
  const deadline = Date.now() + 60_000;
  const timer = setInterval(() => {
    if (Date.now() > deadline) {
      clearInterval(timer);
      return;
    }
    if (fs.existsSync(go)) {
      clearInterval(timer);
      // Raise the interrupt the way the platform delivers Ctrl+C: INSIDE the
      // runner's own process, so the runner's REAL SIGINT handler runs.
      process.emit('SIGINT');
    }
  }, 100);
  if (typeof timer.unref === 'function') timer.unref();
}

if (require.main === module && process.argv[2] === 'writer') {
  runWriter();
} else {
  const mode = process.env.RUNNER_LIFECYCLE_PRELOAD_MODE;
  if (mode === 'spawn-error') {
    armSpawnError();
  } else if (mode === 'interrupt') {
    armInterrupt();
  } else if (mode !== undefined && mode !== '') {
    process.stderr.write(`runner-lifecycle-fixture: unknown preload mode "${mode}"\n`);
    process.exit(2);
  }
}
