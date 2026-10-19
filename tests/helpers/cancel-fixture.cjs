/**
 * tests/helpers/cancel-fixture.cjs — a CONTROLLED child used by the offline cancel /
 * lifecycle suites.
 *
 * It is a plain CommonJS script run by `node`, so it exercises the REAL contained
 * `ManagedProcess` path without ever touching a real coding agent. The per-run
 * behaviour is read from `fixture-mode.json` in the process cwd, so one fixture serves
 * every scenario and no argv-sniffing is needed.
 *
 * Modes:
 *   { mode: 'exit',    text: '…', code: 0 }        print text, then exit code
 *   { mode: 'session', session: '…', text: '…' }   JSONL session line, then exit 0
 *   { mode: 'stderr',  lines: ['A','B'], code: 3 } complete stderr lines, then exit
 *   { mode: 'hang' }                               stay alive until cancelled
 *   { mode: 'tree',    heartbeatMs: 150 }          spawn a stdio-inheriting grandchild
 *                                                  that heartbeats, then stay alive
 *   { mode: 'heartbeat', heartbeatMs, file }       write a heartbeat file forever
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function readMode() {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'fixture-mode.json'), 'utf8'));
  } catch {
    return { mode: 'exit', text: 'default', code: 0 };
  }
}

function writeHeartbeat(file, intervalMs) {
  const target = path.join(process.cwd(), file || 'heartbeat.txt');
  let n = 0;
  setInterval(() => {
    n += 1;
    try {
      // APPEND-ONLY, and always a COMPLETE line. A truncating rewrite can be caught
      // mid-kill and leave an EMPTY file, which a liveness check ("did it stop changing?")
      // misreads as a failed observation. Appending a full line means the last complete
      // content always survives the kill.
      fs.appendFileSync(target, `${n} ${Date.now()}\n`);
    } catch {
      /* a heartbeat must never crash the fixture */
    }
  }, intervalMs || 150);
}

function main() {
  const cfg = readMode();
  const mode = cfg.mode || 'exit';

  if (mode === 'exit') {
    if (cfg.text !== undefined) process.stdout.write(String(cfg.text));
    process.exitCode = Number.isInteger(cfg.code) ? cfg.code : 0;
    return;
  }

  if (mode === 'session') {
    process.stdout.write(JSON.stringify({ session: cfg.session, text: cfg.text ?? '' }) + '\n');
    process.exitCode = 0;
    return;
  }

  if (mode === 'stderr') {
    for (const line of cfg.lines || []) process.stderr.write(`${line}\n`);
    process.exitCode = Number.isInteger(cfg.code) ? cfg.code : 1;
    return;
  }

  if (mode === 'hang') {
    setInterval(() => {}, 1000);
    return;
  }

  if (mode === 'stream') {
    // The consumer (`AgentSession` -> `CliJsonlTransport`) frames stdout as JSONL and
    // only turns a PARSED object into a `session.output` event; a plain `tick` line is
    // filed as an "unparsed" diagnostic and never counts as activity. So emit a COMPLETE
    // JSONL frame IMMEDIATELY (before any timer), then keep streaming JSONL frames so a
    // consumer can act on the FIRST evidence of activity and cancel a genuinely live run.
    const session = cfg.session || 'stream-session';
    const base = cfg.text ?? 'tick';
    let n = 0;
    const emit = (text) => {
      try {
        process.stdout.write(JSON.stringify({ session, text }) + '\n');
      } catch {
        /* ignore */
      }
    };
    emit(base);
    setInterval(() => {
      n += 1;
      emit(`${base}-${n}`);
    }, cfg.heartbeatMs || 200);
    return;
  }

  if (mode === 'heartbeat') {
    writeHeartbeat(cfg.file, cfg.heartbeatMs);
    return;
  }

  if (mode === 'tree') {
    // Write the grandchild's OWN mode file BEFORE spawning it. The grandchild reads it at
    // startup, so writing it AFTER `spawn` is a read/write race the child can lose — it
    // would then fall back to the default child mode. Ordering it first removes the race.
    try {
      fs.writeFileSync(
        path.join(process.cwd(), 'fixture-mode-child.json'),
        JSON.stringify({ mode: 'heartbeat', heartbeatMs: cfg.heartbeatMs || 150, file: cfg.childHeartbeat || 'grandchild-heartbeat.txt' }),
      );
    } catch {
      /* best effort */
    }
    // A grandchild that INHERITS stdio (so Node's 'close' would never fire if the tree
    // were not killed) and heartbeats so its death is observable without a process-name
    // scan.
    const grandchild = spawn(process.execPath, [__filename], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, FIXTURE_CHILD_MODE: 'heartbeat' },
      windowsHide: true,
    });
    try {
      fs.writeFileSync(path.join(process.cwd(), 'grandchild-pid.txt'), String(grandchild.pid));
    } catch {
      /* best effort */
    }
    setInterval(() => {}, 1000);
    return;
  }

  // Unknown mode: exit successfully so a typo is visible in the run, not a hang.
  process.exitCode = 0;
}

// A grandchild re-invocation uses a CHILD mode file when present.
if (process.env.FIXTURE_CHILD_MODE === 'heartbeat') {
  let childCfg = { mode: 'heartbeat', heartbeatMs: 150, file: 'grandchild-heartbeat.txt' };
  try {
    childCfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'fixture-mode-child.json'), 'utf8'));
  } catch {
    /* use the default child mode */
  }
  writeHeartbeat(childCfg.file, childCfg.heartbeatMs);
} else {
  main();
}
