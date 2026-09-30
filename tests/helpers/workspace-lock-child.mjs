/**
 * Child process used by the 5C-8 multi-process tests.
 *
 * Modes
 *   prepare <projectRoot> <worktreeRoot> <taskId>  -> acquire, prepare, print JSON
 *   hold    <lockDir> <key> <ms>                    -> acquire, print LOCKED, then idle
 *   crash   <lockDir> <key>                         -> acquire, print LOCKED, then die
 *                                                    WITHOUT releasing (stale-lock test)
 *
 * Everything is printed as a single JSON line prefixed with a tag so the parent
 * can assert on it without parsing noise.
 */
import { WorkspaceManager } from '../../src/orchestration/index.ts';
import { WorkspaceLock } from '../../src/orchestration/workspace-lock.ts';

const [mode, ...rest] = process.argv.slice(2);
const say = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

if (mode === 'prepare') {
  const [projectRoot, worktreeRoot, taskId, lockDir] = rest;
  const started = Date.now();
  const dbg = (m) => { if (process.env.P8_DEBUG) say({ debug: m, pid: process.pid, at: Date.now() - started }); };
  dbg(`start lockDir=${lockDir ?? '(default)'}`);
  const wm = new WorkspaceManager({ projectRoot, worktreeRoot, workspaceLockTimeoutMs: 60_000, ...(lockDir ? { lockDir } : {}) });
  // Report what git already has, BEFORE prepare, so we can tell "another process
  // already created it" from "nobody has".
  const before = wm.list().length;
  dbg(`pre-prepare in-memory handles=${before}`);
  try {
    const h = await wm.prepare({ taskId, mode: 'isolated' });
    dbg(`prepared cwd=${h.cwd}`);
    say({ ok: true, pid: process.pid, taskId, cwd: h.cwd, branch: h.branch, ms: Date.now() - started });
  } catch (e) {
    dbg(`threw ${e?.code}: ${String(e?.message ?? e).slice(0, 160)}`);
    say({ ok: false, pid: process.pid, taskId, code: e?.code ?? 'unknown', reason: String(e?.message ?? e), ms: Date.now() - started });
  }
  process.exit(0);
}

if (mode === 'hold' || mode === 'crash') {
  const [lockDir, key, msText] = rest;
  const lock = new WorkspaceLock({ lockDir, timeoutMs: 30_000 });
  try {
    const lease = await lock.acquire(key, `child:${process.pid}`);
    say({ ok: true, pid: process.pid, key, state: 'locked' });
    if (mode === 'crash') {
      // Die WITHOUT releasing: this is the process-crash scenario. No finally,
      // no cleanup, no exit handler - exactly like a killed process.
      process.kill(process.pid, 'SIGKILL');
    } else {
      const ms = Number(msText ?? 5000);
      await new Promise((r) => setTimeout(r, ms));
      lock.tryRelease(lease);
      say({ ok: true, pid: process.pid, key, state: 'released' });
    }
  } catch (e) {
    say({ ok: false, pid: process.pid, key, reason: String(e?.message ?? e) });
  }
  process.exit(0);
}

say({ ok: false, reason: `unknown mode "${mode}"` });
process.exit(2);