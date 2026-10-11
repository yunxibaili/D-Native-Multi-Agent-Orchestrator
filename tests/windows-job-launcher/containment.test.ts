// ===========================================================================
// W1 / W1.1 - Windows Job Object containment primitive: real containment proof
//            and launcher-hardening regressions.
//
// Runs the REAL compiled `w1joblauncher.exe`. Liveness is decided by the
// fixture's own OpenProcess probe, never by `tasklist` text; every PID is
// published by the fixture itself.
//
// W1.1 contract changes exercised here:
//   - the launcher process EXIT CODE reports the LAUNCHER's outcome only;
//     the target's exit code is `rootExitCode` in the control file.
//   - stdout/stderr are silent by default (they belong to the target/transport);
//     `--debug` is the only thing that writes stderr.
//   - the control file uses camelCase keys and ends with `complete=1`.
//   - a requested-but-unopenable --diag is a hard failure (exit 8), never silent.
//
// NOT in scope: production runtime integration. `src/**` is untouched.
// ===========================================================================

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const BUILD = join(REPO, 'native', 'windows-job-launcher', 'build');
const LAUNCHER = join(BUILD, 'w1joblauncher.exe');
const FIXTURE = join(BUILD, 'w1fixture.exe');

/** Launcher protocol exit codes (the launcher's own outcome only). */
const LX = {
  OK: 0, USAGE: 1, JOB_CREATE: 2, JOB_CONFIG: 3, PROC_CREATE: 4,
  ASSIGN: 5, RESUME: 6, ACCOUNTING: 7, DIAG_OPEN: 8, CMDLINE: 9, INTERNAL: 10,
  // W3: the parent asked us to terminate the Job and we CONFIRMED it empty.
  TERMINATED: 11,
  // W3: we could not confirm it empty. Deliberately distinct from TERMINATED.
  STOP_UNCONFIRMED: 12,
} as const;

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; process.stdout.write(`  ok   ${name}\n`); }
  else { failed++; failures.push(name); process.stdout.write(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}\n`); }
}
function section(t: string): void { process.stdout.write(`\n== ${t} ==\n`); }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const UNICODE_VALUE = '值-ünïcode-✓';

// Scratch ON THE SAME DRIVE AS THE BINARIES. A process running from D: is denied
// write access to C: on this machine, so %TEMP% (C:) would silently break every
// pid file and diagnostic. build/ is git-ignored.
const TMP_PARENT = join(BUILD, '_w1-tmp');
rmSync(TMP_PARENT, { recursive: true, force: true });
mkdirSync(TMP_PARENT, { recursive: true });
const tmpRoot = mkdtempSync(join(TMP_PARENT, 'run-'));

function scratch(name: string): string {
  const d = join(tmpRoot, name);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
}

interface Launched {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  exited: Promise<{ code: number | null; signal: string | null }>;
  done: Promise<void>;
}

function launch(targetArgs: string[], opts: {
  diag?: string;
  /** W3: the per-run cooperative stop marker the launcher watches for. */
  stop?: string;
  cwd?: string;
  env?: Record<string, string>;
  debug?: boolean;
  stdin?: string;
  withStdin?: boolean;
} = {}): Launched {
  const args: string[] = [];
  if (opts.diag) args.push('--diag', opts.diag);
  // W3: BEFORE the `--` separator, so it obeys the sealed W1.2 grammar.
  if (opts.stop) args.push('--stop', opts.stop);
  if (opts.debug) args.push('--debug');
  args.push('--', FIXTURE, ...targetArgs);

  const child = spawn(LAUNCHER, args, {
    cwd: opts.cwd ?? REPO,
    env: opts.env ?? (process.env as Record<string, string>),
    shell: false,
    windowsHide: true,
    stdio: [opts.withStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
  child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });

  let doneResolve!: () => void;
  const done = new Promise<void>((r) => { doneResolve = r; });
  const exited = new Promise<{ code: number | null; signal: string | null }>((res) => {
    child.once('error', (e) => { stderr += `\nspawn error: ${e.message}`; doneResolve(); res({ code: null, signal: null }); });
    child.once('close', (code, signal) => { doneResolve(); res({ code, signal }); });
  });

  if (opts.withStdin && opts.stdin !== undefined) child.stdin?.end(opts.stdin, 'utf8');
  return { child, get stdout() { return stdout; }, get stderr() { return stderr; }, exited, done };
}

function readPid(path: string): number { return Number.parseInt(readFileSync(path, 'utf8').trim(), 10); }

/**
 * Spawn the launcher with a RAW argv, adding nothing. Needed for the CLI
 * grammar boundary tests, which must place tokens exactly where the grammar
 * says they go (before vs after the separator).
 */
function rawSpawn(argv: string[], cwd = REPO): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const p = spawn(LAUNCHER, argv, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = '';
    p.stdout?.on('data', (b: Buffer) => { o += b.toString('utf8'); });
    p.stderr?.on('data', (b: Buffer) => { e += b.toString('utf8'); });
    p.once('error', () => res({ code: null, stdout: o, stderr: e }));
    p.once('close', (c) => res({ code: c, stdout: o, stderr: e }));
  });
}

function probeAlive(pid: number): boolean {
  const r = spawnSync(FIXTURE, ['--role', 'probe', '--pid', String(pid)], {
    windowsHide: true, shell: false, stdio: 'ignore', timeout: 10_000,
  });
  return r.status === 0;
}

async function waitUntil(pred: () => boolean, timeoutMs: number, stepMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (pred()) return true; await sleep(stepMs); }
  return pred();
}

/** Parse the launcher control file (UTF-16LE, no BOM; detect by NUL density). */
function diagFacts(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  const raw = readFileSync(path);
  let text: string;
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) text = raw.toString('utf16le');
  else {
    let zeros = 0;
    for (let i = 0; i < raw.length; i++) if (raw[i] === 0) zeros++;
    text = zeros > raw.length / 4 ? raw.toString('utf16le') : raw.toString('utf8');
  }
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

async function waitPidFile(path: string, timeoutMs = 15_000): Promise<number | null> {
  const ok = await waitUntil(() => existsSync(path) && readFileSync(path, 'utf8').trim() !== '', timeoutMs);
  return ok ? readPid(path) : null;
}
function pidPath(dir: string, n: string): string { return join(dir, `${n}.pid`); }

async function killLauncher(child: ChildProcess): Promise<void> {
  child.kill();
  await waitUntil(() => !probeAlive(child.pid!), 15_000);
}

/**
 * Round-trip a batch of arguments through the real launcher and the fixture's
 * echo, and return exactly what the FIXTURE observed.
 *
 * The fixture prints every argv element, one byte-exact UTF-8 line each, so an
 * empty argument appears as an empty line. We therefore cannot filter empties:
 * the reconstruct drops only the single trailing "" produced by the final
 * newline, then removes the fixed `[exe, --role, echo]` prefix.
 */
async function roundTripAsync(args: string[], diag: string): Promise<{ received: string[]; code: number | null; facts: Record<string, string>; stdout: string }> {
  const r = launch(['--role', 'echo', ...args], { diag, withStdin: true, stdin: '' });
  const ex = await r.exited;
  const parts = r.stdout.split(/\r?\n/);
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  const received = parts.slice(3); // drop [exe, --role, echo]
  return { received, code: ex.code, facts: diagFacts(diag), stdout: r.stdout };
}

/** Deterministic PRNG so the stress is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ===========================================================================

section('W1H-0. prerequisites and Job configuration');

check('w1joblauncher.exe was built', existsSync(LAUNCHER), LAUNCHER);
check('w1fixture.exe was built', existsSync(FIXTURE), FIXTURE);

if (!existsSync(LAUNCHER) || !existsSync(FIXTURE)) {
  process.stdout.write('\nprerequisite missing: run native/windows-job-launcher/build.ps1\n');
  rmSync(TMP_PARENT, { recursive: true, force: true });
  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  process.exitCode = 1;
} else {

{
  const d = scratch('config');
  const diag = join(d, 'diag.txt');
  const r = launch(['--role', 'solo'], { diag });
  const ex = await r.exited;
  const f = diagFacts(diag);

  check('KILL_ON_JOB_CLOSE is set', f['killOnJobClose'] === '1', JSON.stringify(f));
  check('BREAKAWAY_OK is NOT set', f['breakawayOkSet'] === '0');
  check('SILENT_BREAKAWAY_OK is NOT set', f['silentBreakawayOkSet'] === '0');
  check('assignment provably precedes resume', f['assignedBeforeResume'] === '1');
  check('the target was resumed', f['resumed'] === '1');
  check('a clean run exits with the launcher success code', ex.code === LX.OK, `code=${ex.code}`);
  check('the control file is marked complete', f['complete'] === '1');
}

section('W1H-9. launcher failure never contaminates the target/transport streams');

{
  // A launcher-internal failure (target cannot be created). stdout/stderr are
  // NOT a control plane; nothing may be written to them by default.
  const r = spawn(LAUNCHER, ['--', join(tmpRoot, 'definitely-not-here.exe')], {
    cwd: REPO, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  r.stdout?.on('data', (b: Buffer) => { out += b.toString('utf8'); });
  r.stderr?.on('data', (b: Buffer) => { err += b.toString('utf8'); });
  const code = await new Promise<number | null>((res) => r.once('close', (c) => res(c)));

  check('a target that cannot start fails closed with a launcher failure code',
    code === LX.PROC_CREATE, `code=${code}`);
  check('W1H-9 launcher writes NOTHING to stdout on failure', out === '', out);
  check('W1H-9 launcher writes NOTHING to stderr on failure', err === '', err);
}

{
  // --debug is the ONLY thing allowed to write stderr, and it is opt-in.
  const bad = spawn(LAUNCHER, ['--debug', '--', join(tmpRoot, 'missing.exe')], {
    cwd: REPO, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  bad.stderr?.on('data', (b: Buffer) => { err += b.toString('utf8'); });
  await new Promise<void>((res) => bad.once('close', () => res()));
  check('W1H-9 with --debug the human explanation appears on stderr',
    /CreateProcessW failed/.test(err), err.trim());
}

section('W1H-10. a requested control channel cannot silently disappear');

{
  // --diag points into a directory that does not exist: the channel cannot be
  // opened and the launcher must fail closed rather than run without diagnostics.
  const missingDir = join(scratch('diagfail'), 'no-such-dir');
  const r = spawn(LAUNCHER, ['--diag', join(missingDir, 'diag.txt'), '--', FIXTURE, '--role', 'solo'], {
    cwd: REPO, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  r.stderr?.on('data', (b: Buffer) => { err += b.toString('utf8'); });
  const code = await new Promise<number | null>((res) => r.once('close', (c) => res(c)));
  check('W1H-10 an unopenable --diag is a hard failure, not silent', code === LX.DIAG_OPEN, `code=${code}`);
  check('W1H-10 and it is still silent by default (exit code is the signal)', err === '', err);
}

// ---------------------------------------------------------------------------
section('W1P. CLI option boundary - options after -- belong to the TARGET');

{
  const MISSING = join(tmpRoot, 'missing-target.exe');

  // W1P-1: --debug BEFORE the separator is a launcher option and is ON.
  {
    const r = await rawSpawn(['--debug', '--', MISSING]);
    check('W1P-1 --debug before -- enables launcher debug (stderr explains the failure)',
      /CreateProcessW failed/.test(r.stderr), r.stderr.trim());
    check('W1P-1 and it still fails closed with the launcher failure code',
      r.code === LX.PROC_CREATE, `code=${r.code}`);
  }

  // W1P-2: --debug AFTER the separator is a TARGET argument; launcher debug OFF.
  {
    const r = await rawSpawn(['--', MISSING, '--debug']);
    check('W1P-2 --debug after -- is NOT consumed by the launcher', r.stderr === '', r.stderr);
    check('W1P-2 launcher still runs (and fails on the missing target)', r.code === LX.PROC_CREATE, `code=${r.code}`);
  }

  // W1P-3: --diag AFTER the separator must not be consumed, so no file is created.
  {
    const d = scratch('boundary-diag');
    const fakeDiag = join(d, 'fake-diag.txt');
    const r = await rawSpawn(['--', MISSING, '--diag', fakeDiag]);
    check('W1P-3 --diag after -- is NOT consumed (no control file created)',
      !existsSync(fakeDiag), `unexpected file ${fakeDiag}`);
    check('W1P-3 launcher stderr stays empty', r.stderr === '', r.stderr);
    check('W1P-3 launcher fails only on the missing target', r.code === LX.PROC_CREATE, `code=${r.code}`);
  }

  // W1P-4: --log-argv AFTER the separator must not enable argv logging.
  {
    const r = await rawSpawn(['--', MISSING, '--log-argv']);
    check('W1P-4 --log-argv after -- does not change launcher behaviour',
      r.code === LX.PROC_CREATE && r.stderr === '', `code=${r.code} stderr=${r.stderr}`);

    // Observable form: a legit --diag BEFORE the separator must show NO argv dump.
    const d = scratch('boundary-logargv');
    const diag = join(d, 'diag.txt');
    const r2 = await rawSpawn(['--diag', diag, '--', FIXTURE, '--role', 'solo', '--log-argv']);
    const f = diagFacts(diag);
    check('W1P-4 --log-argv after -- is not enabled (control file has no argv dump)',
      f['targetArgc'] === undefined && f['argv[0]'] === undefined, JSON.stringify(f));
    check('W1P-4 the legit pre-separator --diag still worked', f['launcherStatus'] === 'success',
      `status=${f['launcherStatus']} code=${r2.code}`);
  }
}

{
  // The literal fixture form from the spec: the target receives EVERY token after
  // the separator, verbatim, including `--debug`, `--diag`, its value, `--log-argv`
  // and a second `--`. `--role echo` is added so the fixture reports what it got.
  const args = ['--debug', '--diag', 'abc', '--log-argv', '--'];
  const r = await rawSpawn(['--', FIXTURE, '--role', 'echo', ...args]);
  const parts = r.stdout.split(/\r?\n/);
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  const received = parts.slice(3); // drop [exe, --role, echo]

  check('W1P-5 target received every post-separator token verbatim',
    JSON.stringify(received) === JSON.stringify(args),
    `\n         expected ${JSON.stringify(args)}\n         received ${JSON.stringify(received)}`);
  check('W1P-5 launcher consumed none of them (stderr empty)', r.stderr === '', r.stderr);
  check('W1P-5 launcher exit is success', r.code === LX.OK, `code=${r.code}`);
}

{
  // The literal command from the spec, in an isolated cwd: the target is the
  // fixture itself (no --role), so it simply exits. The launcher must NOT create
  // a file called `abc`, and must stay silent.
  const cwd = scratch('boundary-literal');
  const r = await rawSpawn(['--', FIXTURE, '--debug', '--diag', 'abc', '--log-argv', '--'], cwd);
  check('W1P-6 the literal spec command succeeds', r.code === LX.OK, `code=${r.code}`);
  check('W1P-6 no launcher control file named "abc" was created', !existsSync(join(cwd, 'abc')));
  check('W1P-6 launcher stderr is empty (no options consumed)', r.stderr === '', r.stderr);
}

{
  // Transport silence on a NORMAL successful run: stdout/stderr both empty.
  const d = scratch('silent-normal');
  const r = await rawSpawn(['--diag', join(d, 'diag.txt'), '--', FIXTURE, '--role', 'solo']);
  check('W1P-7 a normal successful run writes nothing to stdout', r.stdout === '', r.stdout);
  check('W1P-7 a normal successful run writes nothing to stderr', r.stderr === '', r.stderr);
}

// ---------------------------------------------------------------------------
section('W1H-1/2/3. many empty arguments (the P1 heap-corruption boundary)');

for (const n of [50, 200, 400]) {
  const d = scratch(`empty-${n}`);
  const diag = join(d, 'diag.txt');
  const args = Array.from({ length: n }, () => '');
  const { received, code } = await roundTripAsync(args, diag);
  const f = diagFacts(diag);

  check(`W1H-${n === 50 ? 1 : n === 200 ? 2 : 3}: ${n} empty args round-trip exactly`,
    JSON.stringify(received) === JSON.stringify(args),
    `expected ${args.length} empties, received ${received.length}`);
  check(`W1H ${n} empty args: launcher does NOT crash (no 0xC0000374)`,
    code === LX.OK, `code=${code}`);
  check(`W1H ${n} empty args: containment still completed`,
    f['launcherStatus'] === 'success' && f['treeStopped'] === '1',
    `status=${f['launcherStatus']} treeStopped=${f['treeStopped']}`);
}

// ---------------------------------------------------------------------------
section('W1H-4/5/6. high-count normal / quoted / Unicode arguments');

{
  const d = scratch('normal');
  const args = Array.from({ length: 300 }, (_, i) => 'x'.repeat((i % 7) + 1) + i);
  const { received, code } = await roundTripAsync(args, join(d, 'diag.txt'));
  check('W1H-4 300 normal args round-trip exactly',
    JSON.stringify(received) === JSON.stringify(args), `n=${received.length}`);
  check('W1H-4 launcher exit is success', code === LX.OK, `code=${code}`);
}

{
  const d = scratch('quoted');
  const pool = ['a"b', 'a\\b', 'trail\\', 'mix\\"x', 'end\\\\', '\\\\\\"', 'q"q"q', ' \\ ', 'tab\there'];
  const args = Array.from({ length: 200 }, (_, i) => pool[i % pool.length]);
  const { received, code } = await roundTripAsync(args, join(d, 'diag.txt'));
  check('W1H-5 200 quoted/backslash args round-trip exactly',
    JSON.stringify(received) === JSON.stringify(args),
    `\n         expected ${JSON.stringify(args.slice(0, 9))}\n         received ${JSON.stringify(received.slice(0, 9))}`);
  check('W1H-5 launcher exit is success', code === LX.OK, `code=${code}`);
}

{
  const d = scratch('unicode');
  const pool = ['unicode-值-ünïcode-✓-日本語', '空白 空格', '"引号"', 'path\\到\\文件', '', '   ', '混合\\"引号-✓'];
  const args = Array.from({ length: 150 }, (_, i) => pool[i % pool.length]);
  const { received, code } = await roundTripAsync(args, join(d, 'diag.txt'));
  check('W1H-6 150 Unicode/mixed args round-trip exactly',
    JSON.stringify(received) === JSON.stringify(args),
    `\n         expected ${JSON.stringify(args.slice(0, 7))}\n         received ${JSON.stringify(received.slice(0, 7))}`);
  check('W1H-6 launcher exit is success', code === LX.OK, `code=${code}`);
}

// ---------------------------------------------------------------------------
section('W1H-6b. cwd / env inheritance (Unicode) is untouched');

{
  const unicodeCwd = join(tmpRoot, '目录 with spaces');
  mkdirSync(unicodeCwd, { recursive: true });
  const r = launch(['--role', 'envinfo', '--name', 'W1_UNICODE_VAR'], {
    cwd: unicodeCwd,
    env: { ...process.env, W1_UNICODE_VAR: UNICODE_VALUE } as Record<string, string>,
  });
  await r.exited;
  const shown = r.stdout.replace(/\n/g, ' | ');
  check('target inherits the cwd (Unicode + spaces)', r.stdout.includes(`cwd=${unicodeCwd}`), shown);
  check('target inherits a Unicode env var verbatim',
    r.stdout.includes(`env.W1_UNICODE_VAR=${UNICODE_VALUE}`), shown);
}

// ---------------------------------------------------------------------------
section('W1H-7. deterministic generated argv stress (allocation == encoder)');

{
  // Fixed seed, 1000 generated arguments, batched so each launch stays well
  // under the Windows command-line limit. The point is not one special count:
  // it is that the size pass and the encoder agree for every shape.
  const rand = mulberry32(0xC0FFEE);
  const atoms = [
    '', 'a', 'Z', ' ', '\t', '   ', '"', '\\', '\\\\"', 'hi', 'a b', 'a"b',
    'a\\b', 'trail\\', '\\"', '\\\\', 'x\\ y', 'q"q', '值', 'ünïcode', '✓',
    '日本語', '  spaced  ', 'mid"quote\\end',
  ];
  const pick = (): string => atoms[Math.floor(rand() * atoms.length)];
  const cases: string[] = [];
  for (let i = 0; i < 1000; i++) cases.push(pick());

  let mismatches = 0;
  const BATCH = 100;
  for (let b = 0; b < cases.length; b += BATCH) {
    const chunk = cases.slice(b, b + BATCH);
    const d = scratch(`fuzz-${b}`);
    const { received, code } = await roundTripAsync(chunk, join(d, 'diag.txt'));
    if (code !== LX.OK || JSON.stringify(received) !== JSON.stringify(chunk)) {
      mismatches++;
      if (mismatches === 1) {
        process.stdout.write(`       first mismatch in batch ${b}:\n         expected ${JSON.stringify(chunk)}\n         received ${JSON.stringify(received)}\n`);
      }
    }
  }
  check('W1H-7 all 1000 generated argv cases round-trip exactly', mismatches === 0, `${mismatches} batch(es) mismatched`);
}

// ---------------------------------------------------------------------------
section('W1H-8. root exit code is distinct from the launcher failure namespace');

{
  const d = scratch('exitns');
  const diag = join(d, 'diag.txt');
  // A target that legitimately exits with a value that the OLD design used as a
  // launcher failure code (103).
  const r = launch(['--role', 'solo', '--exitcode', '103'], { diag });
  const ex = await r.exited;
  const f = diagFacts(diag);

  check('W1H-8 the launcher exits 0 (its own success), NOT 103', ex.code === LX.OK, `code=${ex.code}`);
  check('W1H-8 the target exit code 103 is reported in the control channel',
    f['rootExitCode'] === '103', f['rootExitCode']);
  check('W1H-8 launcherStatus is success for that case', f['launcherStatus'] === 'success');

  // And a genuine launcher failure is fully distinguishable: it uses a
  // different exit code and reports no rootExitCode at all.
  const d2 = scratch('exitns-fail');
  const r2 = spawn(LAUNCHER, ['--diag', join(d2, 'diag.txt'), '--', join(tmpRoot, 'nope.exe')], {
    cwd: REPO, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const c2 = await new Promise<number | null>((res) => r2.once('close', (c) => res(c)));
  const f2 = diagFacts(join(d2, 'diag.txt'));
  check('W1H-8 a real launcher failure uses a launcher code, not a root code',
    c2 === LX.PROC_CREATE, `code=${c2}`);
  check('W1H-8 and it reports NO rootExitCode', f2['rootExitCode'] === undefined, JSON.stringify(f2));
  check('W1H-8 and its launcherStatus names the failure', f2['launcherStatus'] === 'create-process-failed', f2['launcherStatus']);
}

// ---------------------------------------------------------------------------
section('W1H-11. root PID is available through the control channel');

{
  const d = scratch('rootpid');
  const diag = join(d, 'diag.txt');
  const root = pidPath(d, 'root');
  const r = launch(['--role', 'solo', '--pidfile', root], { diag });
  const rootPid = await waitPidFile(root);
  await r.exited;
  const f = diagFacts(diag);

  check('W1H-11 the control file carries rootPid', Number.isFinite(Number(f['rootPid'])) && Number(f['rootPid']) > 0);
  check('W1H-11 rootPid matches the PID the fixture published itself',
    Number(f['rootPid']) === rootPid, `diag=${f['rootPid']} fixture=${rootPid}`);
  check('W1H-11 launcherPid != rootPid (PID semantics recorded, not solved)',
    Number(f['launcherPid']) !== Number(f['rootPid']),
    `launcher=${f['launcherPid']} root=${f['rootPid']}`);
  check("W1H-11 Node's child.pid is the launcher, not the target root",
    r.child.pid === Number(f['launcherPid']));
  process.stdout.write(`       launcherPid=${f['launcherPid']} rootPid=${f['rootPid']} nodeChildPid=${r.child.pid}\n`);
}

// ---------------------------------------------------------------------------
section('W1H-12. root exits first: rootExited != workerTreeStopped');

let rootFirst: { child: ChildProcess; grandPid: number; childPid: number } | null = null;
{
  const d = scratch('rootfirst');
  const diag = join(d, 'diag.txt');
  const root = pidPath(d, 'root');
  const child = pidPath(d, 'child');
  const grand = pidPath(d, 'grand');

  const r = launch(['--role', 'root', '--pidfile', root, '--child-pidfile', child,
    '--grandchild-pidfile', grand, '--spawn', '1'], { diag });

  const rootPid = await waitPidFile(root);
  const childPid = await waitPidFile(child);
  const grandPid = await waitPidFile(grand, 20_000);
  check('W1H-12 the grandchild came into existence', grandPid !== null);
  rootFirst = { child: r.child, grandPid: grandPid!, childPid: childPid! };

  check('W1H-12 the ROOT has exited', await waitUntil(() => !probeAlive(rootPid!), 20_000));
  check('W1H-12 the GRANDCHILD is still alive after the root exited', probeAlive(grandPid!));
  check('W1H-12 the LAUNCHER is still alive while a descendant runs', probeAlive(r.child.pid!));
  const f = diagFacts(diag);
  check('W1H-12 nothing is claimed complete yet',
    f['complete'] === undefined && f['launcherStatus'] === undefined, JSON.stringify(f));
}

// ---------------------------------------------------------------------------
section('W1H-13. terminating the launcher kills the contained tree');

{
  const d = scratch('hardkill');
  const root = pidPath(d, 'root');
  const child = pidPath(d, 'child');
  const grand = pidPath(d, 'grand');
  const r = launch(['--role', 'root', '--pidfile', root, '--child-pidfile', child,
    '--grandchild-pidfile', grand, '--spawn', '1']);
  const rootPid = await waitPidFile(root);
  const childPid = await waitPidFile(child);
  const grandPid = await waitPidFile(grand, 20_000);
  await waitUntil(() => !probeAlive(rootPid!), 20_000);
  await sleep(200);

  check('W1H-13 preconditions: launcher and grandchild alive',
    probeAlive(grandPid!) && probeAlive(r.child.pid!));
  await killLauncher(r.child);
  check('W1H-13 the launcher is gone', !probeAlive(r.child.pid!));
  check('W1H-13 KILL_ON_JOB_CLOSE killed the grandchild that outlived the root',
    await waitUntil(() => !probeAlive(grandPid!), 20_000));
  check('W1H-13 the child is dead too', await waitUntil(() => !probeAlive(childPid!), 20_000));
  await r.done;
}

// Reclaim the W1H-12 tree (its grandchild never exits on its own).
if (rootFirst !== null) {
  await killLauncher(rootFirst.child);
  check('W1H-12/13 the W1H-12 tree is reclaimed, not abandoned',
    await waitUntil(() => !probeAlive(rootFirst!.grandPid), 20_000) &&
    await waitUntil(() => !probeAlive(rootFirst!.childPid), 20_000));
}

// ---------------------------------------------------------------------------
section('W1H-14. natural completion waits for ActiveProcesses == 0');

{
  const d = scratch('natural');
  const diag = join(d, 'diag.txt');
  const root = pidPath(d, 'root');
  const child = pidPath(d, 'child');
  const grand = pidPath(d, 'grand');
  const r = launch(['--role', 'root', '--pidfile', root, '--child-pidfile', child,
    '--grandchild-pidfile', grand, '--spawn', '1', '--iterations', '2'], { diag });
  const rootPid = await waitPidFile(root);
  const childPid = await waitPidFile(child);
  const grandPid = await waitPidFile(grand);
  const ex = await r.exited;
  const f = diagFacts(diag);

  check('W1H-14 all three generations published a PID',
    rootPid !== null && childPid !== null && grandPid !== null);
  check('W1H-14 the launcher exits success', ex.code === LX.OK, `code=${ex.code}`);
  check('W1H-14 ActiveProcesses reached 0 before success',
    f['activeProcessesFinal'] === '0' && f['treeStopped'] === '1', JSON.stringify(f));
  check('W1H-14 success only after containment stopped', f['launcherStatus'] === 'success');
  check('W1H-14 all three generations are dead afterwards',
    [rootPid, childPid, grandPid].every((p) => p !== null && !probeAlive(p)));
}

// ---------------------------------------------------------------------------
section('W1H-15. containment stress: 50 rounds, zero leaks');

{
  const STRESS = Number(process.env.W1_STRESS ?? '50');
  let leaked = 0, built = 0;
  const durations: number[] = [];
  for (let i = 0; i < STRESS; i++) {
    const d = scratch(`stress-${i}`);
    const root = pidPath(d, 'root'), child = pidPath(d, 'child'), grand = pidPath(d, 'grand');
    const started = Date.now();
    const r = launch(['--role', 'root', '--pidfile', root, '--child-pidfile', child,
      '--grandchild-pidfile', grand, '--spawn', '1']);
    const rootPid = await waitPidFile(root, 10_000);
    const childPid = await waitPidFile(child, 10_000);
    const grandPid = await waitPidFile(grand, 10_000);
    if (rootPid === null || childPid === null || grandPid === null) { leaked++; continue; }
    built++;
    await sleep(120);
    await killLauncher(r.child);
    await r.done;
    durations.push(Date.now() - started);
    const survivors = [rootPid, childPid, grandPid].filter((p) => probeAlive(p));
    if (survivors.length > 0) { leaked++; process.stdout.write(`       round ${i}: survivors ${survivors.join(',')}\n`); }
  }
  check(`W1H-15 all ${STRESS} rounds built a full three-generation chain`, built === STRESS, `${built}/${STRESS}`);
  check(`W1H-15 zero leaked descendants across ${STRESS} rounds`, leaked === 0, `${leaked} leak(s)`);
  durations.sort((a, b) => a - b);
  if (durations.length > 0) {
    const median = durations[Math.floor(durations.length / 2)];
    const p95 = durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))];
    process.stdout.write(`\n  [perf] full cycle (3-gen launch -> terminate -> confirm dead): median ${median} ms, p95 ${p95} ms over ${durations.length}\n`);
    check('W1H-15 no pathological multi-second cycle (p95 < 3000 ms)', p95 < 3000, `p95=${p95}`);
  }
}

// ---------------------------------------------------------------------------
section('W1H-16. immediate-spawn race: 12 rounds, zero escapes');

{
  const ROUNDS = Number(process.env.W1_RACE_ROUNDS ?? '12');
  let escaped = 0, built = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const d = scratch(`race-${i}`);
    const root = pidPath(d, 'root'), child = pidPath(d, 'child'), grand = pidPath(d, 'grand');
    const r = launch(['--role', 'root', '--pidfile', root, '--child-pidfile', child,
      '--grandchild-pidfile', grand, '--spawn', '1']);
    const rootPid = await waitPidFile(root, 10_000);
    const childPid = await waitPidFile(child, 10_000);
    const grandPid = await waitPidFile(grand, 10_000);
    if (rootPid === null || childPid === null || grandPid === null) { escaped++; continue; }
    built++;
    await sleep(150);
    await killLauncher(r.child);
    await r.done;
    const survivors = [rootPid, childPid, grandPid].filter((p) => probeAlive(p));
    if (survivors.length > 0) { escaped++; process.stdout.write(`       round ${i}: survivors ${survivors.join(',')}\n`); }
  }
  check(`W1H-16 zero escapes across ${ROUNDS} immediate-spawn rounds`, escaped === 0, `${escaped} leak(s)`);
  check('W1H-16 every round built the full chain', built === ROUNDS, `${built}/${ROUNDS}`);
}

// ---------------------------------------------------------------------------
// W3 (launcher level). The cooperative stop primitive, proven against the native
// producer directly rather than through the Node runtime.
// ---------------------------------------------------------------------------
section('W1W3. cooperative stop: TerminateJobObject, then CONFIRM empty');

{
  // The marker exists -> the launcher terminates the JOB and reports `terminated`
  // with positive Job-empty evidence. This is the behaviour that lets a parent
  // confirm a stop instead of assuming one.
  // A short chain can empty BEFORE the marker is sampled, in which case the run is
  // honestly `success`. That is correct behaviour but proves nothing about stopping,
  // so this block only asserts what holds either way, and the live-tree case below
  // is where the stop semantics are actually proven.
  const dir = scratch('w3-stop');
  const diag = join(dir, 'ctl.txt');
  const stop = join(dir, 'stop.signal');
  const L = launch(['--role', 'chain'], { diag, stop });
  await sleep(400);
  // The request is the file's existence. Nothing else is written to it.
  writeFileSync(stop, 'stop\n');
  const ex = await L.exited;
  const f = diagFacts(diag);
  check('W3N-0 a stopped chain ends with a complete, empty-tree record',
    f['complete'] === '1' && f['treeStopped'] === '1' && f['activeProcessesFinal'] === '0',
    JSON.stringify(f));
  // Either outcome is legitimate here; what must never happen is `terminated`
  // WITHOUT the Job-empty evidence.
  if (f['launcherStatus'] === 'terminated') {
    check('W3N-0 `terminated` is never reported without positive Job-empty evidence',
      ex.code === LX.TERMINATED && f['treeStopped'] === '1' && f['activeProcessesFinal'] === '0');
  } else {
    check('W3N-0 a chain that emptied on its own is honestly `success`',
      f['launcherStatus'] === 'success' && ex.code === LX.OK,
      `status=${f['launcherStatus']} code=${ex.code}`);
  }
  // The root-exit pair must obey the sealed W2 invariant either way.
  const pairOk = (f['rootExitObserved'] === '1') === (f['rootExitCode'] !== undefined);
  check('W3N-0 the root-exit pair stays consistent', pairOk,
    `observed=${f['rootExitObserved']} code=${f['rootExitCode']}`);
}

{
  // The COOPERATIVE case: the request arrives WHILE the tree is still alive.
  //
  // This is the assertion that matters and the one the sibling block above cannot
  // make. When the fixture's chain has already emptied on its own, the loop can exit
  // with `active == 0` before it ever samples the marker, so the run is honestly
  // `success` — nothing is wrong with that, it simply proves nothing about stopping.
  //
  // Here the marker is created while the tree is definitely still running, so the
  // launcher MUST see it, MUST terminate the Job, and MUST report `terminated`.
  const dir = scratch('w3-stop-live');
  const diag = join(dir, 'ctl.txt');
  const stop = join(dir, 'stop.signal');
  // A long-lived solo fixture: `--iterations` + `--hold-ms` keeps it alive long enough
  // for the marker to be observed while the Job is definitely non-empty.
  const L = launch(['--role', 'solo', '--iterations', '1000000', '--hold-ms', '1'], { diag, stop });
  await sleep(400);
  // Confirm the tree is genuinely alive before requesting anything, so this test
  // cannot pass by accident.
  const mid = diagFacts(diag);
  check('W3N-1h the tree is still live when the stop is requested',
    mid['complete'] === undefined && mid['phase'] === 'wait', JSON.stringify(mid));
  writeFileSync(stop, 'stop\n');
  const ex = await L.exited;
  const f = diagFacts(diag);
  check('W3N-1 the launcher exits with the TERMINATED code', ex.code === LX.TERMINATED, `code=${ex.code}`);
  check('W3N-1 launcherStatus is `terminated`, NOT `success`', f['launcherStatus'] === 'terminated', f['launcherStatus']);
  check('W3N-1 it observed the stop request', f['stopRequested'] === '1', f['stopRequested']);
  check('W3N-1 it is a COMPLETE record', f['complete'] === '1');
  check('W3N-1 and it positively reports an empty tree',
    f['treeStopped'] === '1' && f['activeProcessesFinal'] === '0',
    `treeStopped=${f['treeStopped']} active=${f['activeProcessesFinal']}`);
  check('W3N-1 the whole tree is dead after the confirmed stop',
    f['treeStopped'] === '1');
  // The root-exit pair must still obey the sealed W2 invariant.
  const pairOk = (f['rootExitObserved'] === '1') === (f['rootExitCode'] !== undefined);
  check('W3N-1 the root-exit pair stays consistent', pairOk,
    `observed=${f['rootExitObserved']} code=${f['rootExitCode']}`);
}

{
  // No marker, ever -> a normal run is UNCHANGED. This is the W1 delta regression:
  // the new stop seam must not alter an ordinary completion by a single bit.
  const dir = scratch('w3-nostop');
  const diag = join(dir, 'ctl.txt');
  const L = launch(['--role', 'echo'], { diag });
  const ex = await L.exited;
  const f = diagFacts(diag);
  check('W3N-2 an un-stopped run still exits OK', ex.code === LX.OK, `code=${ex.code}`);
  check('W3N-2 and still reports `success`', f['launcherStatus'] === 'success', f['launcherStatus']);
  check('W3N-2 with the real root exit code', f['rootExitCode'] === '0', f['rootExitCode']);
  check('W3N-2 and a confirmed empty tree', f['treeStopped'] === '1' && f['activeProcessesFinal'] === '0');
  check('W3N-2 and never mentions a stop request', f['stopRequested'] === undefined);
}

{
  // A stop marker that is a DIRECTORY, not a file: GetFileAttributes still succeeds,
  // so the launcher must terminate the Job rather than treating this as "no request".
  // The request is the PATH's existence, deliberately, so it cannot be half-parsed.
  const dir = scratch('w3-stopdir');
  const diag = join(dir, 'ctl.txt');
  const stop = join(dir, 'stopdir.signal');
  mkdirSync(stop, { recursive: true });
  const L = launch(['--role', 'chain'], { diag, stop });
  const ex = await L.exited;
  const f = diagFacts(diag);
  check('W3N-3 an existing marker path is honoured regardless of its kind',
    ex.code === LX.TERMINATED && f['launcherStatus'] === 'terminated',
    `code=${ex.code} status=${f['launcherStatus']}`);
}

{
  // `--stop` obeys the sealed W1.2 grammar: after `--` it belongs to the TARGET.
  const dir = scratch('w3-grammar');
  const diag = join(dir, 'ctl.txt');
  const stop = join(dir, 'stop.signal');
  writeFileSync(stop, 'stop\n');
  // Run with NO `--stop` before the separator: the launcher must not be watching
  // that path, and `--stop <path>` AFTER `--` must reach the fixture verbatim.
  const r = await rawSpawn(['--diag', diag, '--', FIXTURE, '--role', 'echo', '--stop', stop]);
  const f = diagFacts(diag);
  check('W3N-4 a post-separator --stop is NOT consumed by the launcher',
    f['stopRequested'] === undefined && f['launcherStatus'] === 'success',
    `stopRequested=${f['stopRequested']} status=${f['launcherStatus']}`);
  check('W3N-4 and the launcher completed normally', r.code === LX.OK, `code=${r.code}`);
}

{
  // A `--stop` with no value is a usage error, exactly like `--diag`.
  const r = await rawSpawn(['--stop', '--', FIXTURE, '--role', 'echo']);
  check('W3N-5 a valueless --stop is a usage error', r.code === LX.USAGE, `code=${r.code}`);
}

{
  // The launcher must never write to the target's stdio, even when stopping.
  const dir = scratch('w3-silence');
  const diag = join(dir, 'ctl.txt');
  const stop = join(dir, 'stop.signal');
  const L = launch(['--role', 'chain'], { diag, stop });
  await sleep(300);
  writeFileSync(stop, 'stop\n');
  await L.exited;
  check('W3N-6 the stop protocol writes nothing to stdout', L.stdout === '', L.stdout.slice(0, 120));
  check('W3N-6 nor to stderr (debug is off)', L.stderr === '', L.stderr.slice(0, 120));
}

// ---------------------------------------------------------------------------
// W4.1 (launcher). Natural-exit root-exit pair is UNCONDITIONAL.
//
// The defect this closes: `QueryInformationJobObject` can report ActiveProcesses
// == 0 in a tick where the root process handle has not yet signalled. The loop
// broke on Job-empty, the exit code was captured afterwards but never serialized,
// so a genuine natural success was emitted WITHOUT `rootExitObserved`/`rootExitCode`
// and the W2 consumer (correctly) rejected it as invalid.
//
// A launcher exit code of 0 is NOT sufficient evidence — the assertions below are
// about the CONTROL RECORD's contents.
// ---------------------------------------------------------------------------
section('W4.1. natural-exit stress: success always carries the root-exit pair');

{
  const ROUNDS = 120;
  let nonSuccess = 0;
  let missingPair = 0;
  let wrongCode = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const dir = scratch(`w41-${i}`);
    const diag = join(dir, 'ctl.txt');
    await rawSpawn(['--diag', diag, '--', process.execPath, '-e', 'process.exit(0)'], dir);
    const f = diagFacts(diag);
    if (f['launcherStatus'] !== 'success') { nonSuccess++; continue; }
    if (f['rootExitObserved'] !== '1' || f['rootExitCode'] === undefined ||
        f['treeStopped'] !== '1' || f['activeProcessesFinal'] !== '0') {
      missingPair++;
      continue;
    }
    if (f['rootExitCode'] !== '0') wrongCode++;
  }
  check(`W4.1 ${ROUNDS} rounds: every natural exit is a valid success`,
    nonSuccess === 0, `nonSuccess=${nonSuccess}`);
  check(`W4.1 ${ROUNDS} rounds: every success carries the full root-exit pair`,
    missingPair === 0, `missingPair=${missingPair}`);
  check(`W4.1 ${ROUNDS} rounds: every success reports the real exit code 0`,
    wrongCode === 0, `wrongCode=${wrongCode}`);
}

{
  // Exit-code FIDELITY, not mere field presence.
  for (const code of [0, 37, 103]) {
    const dir = scratch(`w41-code-${code}`);
    const diag = join(dir, 'ctl.txt');
    const r = await rawSpawn(['--diag', diag, '--', process.execPath, '-e', `process.exit(${code})`], dir);
    const f = diagFacts(diag);
    check(`W4.1 root exit ${code}: record reports exactly ${code}`,
      f['rootExitCode'] === String(code), `got ${f['rootExitCode']}`);
    check(`W4.1 root exit ${code}: launcher success + complete record`,
      f['launcherStatus'] === 'success' && f['complete'] === '1' && r.code === LX.OK,
      `status=${f['launcherStatus']} code=${r.code}`);
  }
}

// ---------------------------------------------------------------------------
section('W1H-17. generated binaries are not tracked source');

{
  let tracked = '';
  try { tracked = execFileSync('git', ['ls-files', 'native/windows-job-launcher'], { cwd: REPO, encoding: 'utf8' }); } catch { tracked = ''; }
  const lines = tracked.split(/\r?\n/).filter((s) => s !== '');
  check('W1H-17 no generated binary is tracked', !lines.some((f) => /\.(exe|obj|pdb|o|ilk)$/i.test(f)), lines.join(', '));
  let ignored = '';
  try { ignored = execFileSync('git', ['status', '--porcelain', 'native/windows-job-launcher/build'], { cwd: REPO, encoding: 'utf8' }); } catch { ignored = ''; }
  check('W1H-17 git reports no untracked build artefacts', ignored.trim() === '', ignored.trim());
}

} // end gate

rmSync(TMP_PARENT, { recursive: true, force: true });

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length > 0) process.stdout.write(`failing:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
process.exitCode = failed === 0 ? 0 : 1;
