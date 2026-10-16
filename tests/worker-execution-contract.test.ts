// ===========================================================================
// TeamRun T2-b — Worker-local bounded Recon / Reuse-first execution contract.
// ===========================================================================
//
// Every formal EXECUTION Worker must own a bounded recon and an explicit reuse decision
// before it performs the substantive task. This suite proves the contract is DELIVERED on
// the real execution request — not merely that a rendering function returns text.
//
// The production-wiring proof (T2B-15) lives at the bottom and goes through the real
// Laya pair -> Assignment -> SessionRegistry -> Scheduler -> Orchestrator -> buildRunRequest
// -> runtime chain, reading the request the fake runtime actually received.

import { readFileSync } from 'node:fs';
import { buildRunRequest, buildTaskPrompt } from '../src/orchestration/execute.ts';
import type { Task } from '../src/orchestration/task.ts';
import {
  WORKER_RECON_REUSE_CONTRACT,
  composeWorkerExecutionPrompt,
} from '../src/orchestration/worker-execution-contract.ts';
import { buildWorkBuddyArgs } from '../src/adapters/workbuddy.ts';
// MVP-E2E.1b round 2: the recorded product failures were OpenCode runs, so the REAL
// OpenCode transport is inspected (offline) rather than only the WorkBuddy argv builder.
import { createOpenCodeAdapter } from '../src/adapters/opencode.ts';
import type { LauncherSpec } from '../src/core/types.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; process.stdout.write(`  ok   ${name}\n`); }
  else { failed++; failures.push(name); process.stdout.write(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}\n`); }
}
function section(t: string): void { process.stdout.write(`\n== ${t} ==\n`); }

const CONTRACT_TEXT = WORKER_RECON_REUSE_CONTRACT.join('\n');

// The semantic points §21 requires. Each is probed with several phrasings so the test is
// checking MEANING is present, not one exact string (which would make it a brittle
// string-snapshot test, the thing §36 warns against).
const SEMANTICS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['inspect local repo truth in-scope', ['directly relevant code, tests and interfaces']],
  ['internal reuse search first', ['prefer reusing a same-name module', 'reuse']],
  ['external reference only when authorized', ['external public reference', 'never a mandatory prerequisite']],
  ['licence / compatibility verification', ['licence, API/version compatibility']],
  ['REUSE/ADAPT/WRAP/NEW decision', ['REUSE, ADAPT, WRAP, or NEW']],
  ['shared research does not waive recon', ['never means your recon is already done', 'evidence and leads only']],
  ['bounded recon', ['Keep recon bounded', 'stop as soon as']],
  ['external agent installs protected', ['Do not modify external Agent installations']],
  ['external installs not read just because installed', ['merely because it is installed']],
  ['recon precedes substantive work', ['perform the requested task immediately']],
  ['role-neutral trigger (not "before editing files")', ['Before performing the substantive task']],
  ['scoped to actual cwd/workspace only', ['actual process working directory', 'cwd / workspace']],
  ['parents/siblings and control artifacts excluded', ['parent or sibling', 'harness, control, owned-root or launcher']],
  ['audit logs / runtime evidence excluded', ['historical audit logs or runtime evidence']],
  ['operational reference is not permission', ['operational path or artifact reference is not permission']],
  ['NEW chosen explicitly when empty', ['choose NEW explicitly', 'need not prove']],
  ['denial cannot be bypassed', ['never bypass a denial through another tool', 'never repeat an irrelevant probe']],
  ['native stop -> precise blocker', ['report the precise blocker', 'never fabricate a delivery']],
  ['native permission behaviour unchanged', ['Do not change native permission behaviour']],
  ['real delivery required', ['actually create or change the requested files', 'paths, command, output and exit']],
  ['plan/recon-only is not completion', ['plan or recon-only answer is not completion']],
  ['read-only tasks not mutated', ['If the task is read-only, do not mutate']],
  ['test task consumes real upstream artifacts', ['supplied upstream artifacts', 'runs the actual tests', 'never invents a pass']],
  ['conflicting rule is a blocker not an override', ['conflicting higher-priority native or task rule', 'never a permission to override']],
  ['final reuse evidence requested', ['Reuse decision: REUSE / ADAPT / WRAP / NEW']],
];

const hasAllSemantics = (prompt: string): readonly string[] =>
  SEMANTICS.filter(([, needles]) => !needles.some((n) => prompt.includes(n))).map(([label]) => label);

const baseTask = (over: Partial<Task> = {}): Task => ({
  taskId: 't2b-1',
  parentTaskId: 'root',
  rootTaskId: 'root',
  depth: 1,
  dependencies: [],
  agentId: 'opencode',
  modelId: 'opencode/gpt',
  leaseVersion: 1,
  fencingToken: 'f-1',
  taskType: 'implementation',
  status: 'running',
  acceptanceCriteria: 'the widget renders exactly once',
  artifacts: [],
  retryCount: 0,
  order: 0,
  createdAt: 1,
  startedAt: 1,
  finishedAt: null,
  budgetUnits: 10,
  blockedReason: null,
  ...over,
} as Task);

// --- T2B-1: a normal OpenCode execution request carries the contract ---
section('T2B. the execution contract reaches every execution Worker, and only Workers');

{
  const built = buildRunRequest({ task: baseTask(), cwd: 'C:/w' });
  const missing = hasAllSemantics(built.request.prompt);
  check('T2B-1: OpenCode execution request carries the full contract',
    missing.length === 0, `missing: ${missing.join(', ')}`);
  check('T2B-1: it is an EXECUTION request', built.request.mode === 'default', built.request.mode);
}

// --- T2B-2 / T2B-3: WorkBuddy CN and Intl come from the SAME composer ---
{
  for (const [id, label] of [['workbuddy-cn', 'T2B-2'], ['workbuddy-intl', 'T2B-3']] as const) {
    const built = buildRunRequest({ task: baseTask({ agentId: id }), cwd: 'C:/w' });
    const missing = hasAllSemantics(built.request.prompt);
    check(`${label}: ${id} execution request carries the contract`, missing.length === 0,
      `missing: ${missing.join(', ')}`);
    // And the adapter is TRANSPORT only: it forwards req.prompt untouched, contributing no
    // policy of its own.
    const args = buildWorkBuddyArgs({ ...built.request });
    const promptArg = args[args.length - 1];
    check(`${label}: the adapter passes the composed prompt through verbatim`,
      promptArg === built.request.prompt, 'adapter altered the prompt');
    check(`${label}: the adapter adds no recon policy of its own`,
      !args.some((a) => /reuse-first|REUSE, ADAPT|recon\b/i.test(a) && a !== built.request.prompt),
      'adapter appended policy');
  }
}

// --- T2B-4: Codex as an EXECUTION Worker must receive it (identity is not the gate) ---
{
  // Codex is both a formal execution family and the Unified Review role, so this case
  // proves the gate is the ROLE and never `agentId === 'codex'`.
  const built = buildRunRequest({ task: baseTask({ agentId: 'codex', modelId: 'codex/gpt' }), cwd: 'C:/w' });
  check('T2B-4: Codex in the EXECUTION role receives the contract',
    hasAllSemantics(built.request.prompt).length === 0,
    `missing: ${hasAllSemantics(built.request.prompt).join(', ')}`);
  check('T2B-4: the request really is mode=default, not review',
    built.request.mode === 'default', built.request.mode);
}

// --- T2B-5 / T2-b.1: task SEMANTIC is not a role; a review TASK is still a Worker ---
//
// SUPERSEDED ASSUMPTION: this block used to assert that a `taskType:'review'` request
// carried NO contract, on the theory that `mode === 'review'` meant "review role". That was
// the P1 defect: a review-typed Task dispatched through Task -> Assignment ->
// SessionRegistry -> Scheduler -> executeTask -> runtime.run is an ordinary execution
// Worker (real Attempt, real WorkerIdentity), so it must receive the contract. The
// reviewer that must NOT receive it is the UNIFIED REVIEW path, which is a different seam
// entirely and is proven in the production-wiring test, not here.
{
  const reviewTask = baseTask({ agentId: 'codex', taskType: 'review', modelId: 'codex/gpt' });
  const built = buildRunRequest({ task: reviewTask, cwd: 'C:/w' });
  check('T2B-5: a review TASK still selects the review TRANSPORT profile',
    built.request.mode === 'review', built.request.mode);
  check('T2B-5: but its SEMANTIC does not strip the Worker contract',
    hasAllSemantics(built.request.prompt).length === 0,
    `missing: ${hasAllSemantics(built.request.prompt).join(', ')}`);
  check('T2B-5: and the same is true for every other execution semantic',
    (['implementation', 'research', 'test'] as const).every((t) =>
      buildRunRequest({ task: baseTask({ agentId: 'codex', taskType: t }), cwd: 'C:/w' })
        .request.prompt.includes('REUSE, ADAPT, WRAP, or NEW')),
    'an execution semantic lost the contract');
}

// --- T2B-6 / T2B-7: lifecycle — the contract is per EXECUTION, not per agent or session ---
{
  // Same agent, different model: a NEW Worker under T1's identity rule.
  const a = buildRunRequest({ task: baseTask({ modelId: 'opencode/gpt' }), cwd: 'C:/w', threadId: 'sess-1' });
  const b = buildRunRequest({ task: baseTask({ modelId: 'opencode/o3' }), cwd: 'C:/w', threadId: 'sess-2' });
  check('T2B-6: model-A execution carries the contract', a.request.prompt.includes('REUSE'), 'missing');
  check('T2B-6: model-B execution ALSO carries it (not once per agent)',
    b.request.prompt.includes('REUSE'), 'missing');
  check('T2B-6: each keeps its own model', a.request.model === 'opencode/gpt' && b.request.model === 'opencode/o3',
    `${a.request.model}/${b.request.model}`);
  // §14: a resumed/new session must NOT silently drop the recon requirement.
  const resumed = buildRunRequest({ task: baseTask(), cwd: 'C:/w', threadId: 'sess-resumed' });
  check('T2B-7: a new/resumed session still receives the contract',
    resumed.request.prompt.includes('Keep recon bounded') && resumed.request.threadId === 'sess-resumed',
    `threadId=${String(resumed.request.threadId)}`);
}

// --- T2B-11: original task semantics are preserved, not replaced ---
{
  const task = baseTask({
    acceptanceCriteria: 'the widget renders exactly once',
    dependencies: ['dep-1', 'dep-2'],
    artifacts: [{ name: 'patch', path: 'C:/x.diff', kind: 'diff' } as never],
  });
  const built = buildRunRequest({ task, cwd: 'C:/w' });
  const p = built.request.prompt;
  check('T2B-11: the acceptance criteria survive verbatim', p.includes('the widget renders exactly once'), 'lost');
  check('T2B-11: dependencies survive', p.includes('dep-1, dep-2'), 'lost');
  check('T2B-11: artifacts survive', p.includes('C:/x.diff'), 'lost');
  check('T2B-11: the task id and type survive', p.includes('t2b-1') && p.includes('implementation'), 'lost');
  // The task instruction is carried through UNCHANGED, not re-rendered.
  const derived = buildTaskPrompt(task);
  check('T2B-11: the derived task instruction is carried verbatim after the contract',
    p.endsWith(derived) && p.includes('--- TASK (unchanged) ---'), 'task instruction was rewritten');
  // And nothing was written back into task semantics.
  check('T2B-11: the Task record itself is untouched by the injection',
    task.acceptanceCriteria === 'the widget renders exactly once' && !task.acceptanceCriteria.includes('reuse-first'),
    'task semantics were contaminated');
  check('T2B-11: the mapping still records the task, not the policy',
    built.mapping.taskType === 'implementation' && built.mapping.taskId === 't2b-1', 'mapping drifted');
}

// --- T2B-12: exactly ONE canonical source; adapters own no policy (§11, §40) ---
{
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const contractSrc = read('../src/orchestration/worker-execution-contract.ts');
  const executeSrc = read('../src/orchestration/execute.ts');

  // A distinctive full line that exists ONLY in the canonical source module.
  const CANON = 'Execution contract (Worker-local bounded recon / reuse-first)';
  check('T2B-12: the canonical wording lives in exactly one module',
    contractSrc.includes(CANON) && !executeSrc.includes(CANON), 'canonical text is duplicated or absent');

  // No adapter restates any contract phrase (§40: adapters are transport only).
  const ADAPTERS = [
    '../src/adapters/opencode.ts',
    '../src/adapters/codex.ts',
    '../src/adapters/workbuddy.ts',
    '../src/adapters/cline.ts',
  ];
  const needles = ['REUSE, ADAPT, WRAP', 'reuse-first', 'reuse decision', 'bounded recon'];
  const offenders = ADAPTERS.filter((p) => needles.some((n) => read(p).includes(n)));
  check('T2B-12: NO adapter contains contract policy text', offenders.length === 0,
    offenders.map((p) => p.split('/').pop()).join(', '));

  // Exactly one constant, one composer, one injection site.
  const constants = (contractSrc.match(/export const WORKER_RECON_REUSE_CONTRACT/g) ?? []).length;
  check('T2B-12: there is exactly ONE canonical contract constant', constants === 1, `constants=${constants}`);
  // The `(` matters: the import site has no call paren, so this counts real call sites only.
  const injections = executeSrc.split('composeWorkerExecutionPrompt(').length - 1;
  check('T2B-12: the contract is injected from exactly ONE call site', injections === 1,
    `composeWorkerExecutionPrompt call sites=${injections}`);
  // T2-b.1: the injection is now UNCONDITIONAL. There is no `mode`/taskType/agent gate to
// accidentally exclude a review-typed execution Worker, because the seam itself IS the
// execution role: `buildRunRequest` is the formal execution request constructor and has
// exactly one call site. The Unified Review path is separated by the seam, not by a flag.
  check('T2B-12: the injection line is unconditional (no ternary on mode/taskType)',
    /(^|\n)\s*prompt: composeWorkerExecutionPrompt\(taskInstruction\),(\n|$)/.test(executeSrc),
    'the injection line is not the expected unconditional form');
  check('T2B-12: the exported constant and the composer agree',
    CONTRACT_TEXT === WORKER_RECON_REUSE_CONTRACT.join('\n')
    && composeWorkerExecutionPrompt('TASK BODY').endsWith('TASK BODY'), 'composer drifted');
  check('T2B-12: the injected value owns no authority and no mutable state',
    !/choose|dispatch|registry|session|modelId\s*=/i.test(
      contractSrc.split('export function composeWorkerExecutionPrompt')[1] ?? ''),
    'composer does something other than compose');
}

// --- T2B-13: external Agent installs stay protected in the delivered instruction ---
{
  const p = buildRunRequest({ task: baseTask(), cwd: 'C:/w' }).request.prompt;
  check('T2B-13: the delivered instruction forbids modifying external Agent installs',
    p.includes('Do not modify external Agent installations'), 'rule absent');
  check('T2B-13: and refuses to read an external install merely because it is installed',
    p.includes('merely because it is installed'), 'over-permissive');
  check('T2B-13: and scopes changes to the project only',
    p.includes("only this project's own scope may be changed"), 'scope rule absent');
}

// --- T2B-14: shared research is leads only, never a waiver ---
{
  // A Worker that arrives with shared research already attached still gets the contract.
  const withResearch = buildRunRequest({
    task: baseTask(),
    cwd: 'C:/w',
    // The workbench attaches prior notes / upstream links through the same instruction slot.
    prompt: [
      'Work:', 'the widget renders exactly once', '',
      'Shared research (from a prior worker):',
      '- upstream: https://example.invalid/widget',
      '- prior notes: the old helper at src/lib/old-widget.ts may be reusable',
    ].join('\n'),
  });
  const p = withResearch.request.prompt;
  check('T2B-14: the contract still arrives when shared research is present',
    p.includes('Keep recon bounded') && p.includes('perform the requested task immediately'), 'contract missing');
  check('T2B-14: and it states research is evidence/leads, not completion',
    p.includes('never means your recon is already done'), 'waiver semantics absent');
  check('T2B-14: the shared research itself is preserved for the Worker to read',
    p.includes('https://example.invalid/widget') && p.includes('src/lib/old-widget.ts'), 'research lost');
  check('T2B-14: there is no research-exists -> recon-waived branch in the composer',
    !/research[\s\S]{0,80}(skip|waiv|complete)/i.test(
      (readFileSync(new URL('../src/orchestration/worker-execution-contract.ts', import.meta.url), 'utf8'))
        .split('export function composeWorkerExecutionPrompt')[1] ?? ''),
    'composer branches on research presence');
}

// --- T2B-8 / T2B-9 / T2B-10: handoff, reassign and rework are all EXECUTIONS ---
section('T2B. handoff / reassign / rework each start a new Worker execution');

{
  // All three re-enter the SAME execution path, so the contract is delivered by
  // construction rather than by three separate injections. Asserted structurally: one
  // constant, one composer, one role-gated call site — no per-lifecycle variants.
  const execSrc = readFileSync(new URL('../src/orchestration/execute.ts', import.meta.url), 'utf8');
  const contractSrc2 = readFileSync(new URL('../src/orchestration/worker-execution-contract.ts', import.meta.url), 'utf8');
  check('T2B-8/9/10: handoff, reassign and rework all route through the one injection seam',
    (execSrc.split('composeWorkerExecutionPrompt(').length - 1) === 1
    && (contractSrc2.match(/export const WORKER_RECON_REUSE_CONTRACT/g) ?? []).length === 1,
    'contract has per-lifecycle variants');

  // Whatever brief text a handoff/rework carries, the execution request still leads with
  // the contract — including a continuation packet, which is the shared-evidence case.
  const continuationBrief = [
    'Handoff from a previous worker:',
    'previous worker result: partially implemented',
    'review findings: missing null guard',
    '', 'Work:', 'finish the widget',
  ].join('\n');
  const built = buildRunRequest({ task: baseTask({ status: 'to_verify' }), cwd: 'C:/w', prompt: continuationBrief });
  check('T2B-8: a handoff/continuation brief still receives the contract',
    built.request.prompt.includes('reuse-first') && built.request.prompt.includes('evidence and leads only'),
    'contract missing');
  check('T2B-8: the previous worker\'s evidence is carried through',
    built.request.prompt.includes('missing null guard'), 'evidence lost');
  check('T2B-10: rework execution receives it too',
    buildRunRequest({ task: baseTask({ retryCount: 1, status: 'queued' }), cwd: 'C:/w' })
      .request.prompt.includes('reuse-first'),
    'contract missing on rework');
}

// ===========================================================================
// TeamRun T2-b.1: task SEMANTIC is not an execution ROLE.
// ===========================================================================
//
// `mode` is a TRANSPORT profile derived from the task type (the adapters pick a native
// review profile from it). It is NOT a role. A review-semantic Task that goes through the
// execution seam is an ordinary execution Worker, so it carries the contract — exactly like
// implementation, research and test tasks.
section('T2-b.1. every execution SEMANTIC carries the contract; only the review SEAM does not');

{
  // T2B1-4/5/6/7: semantics are uniform. Note T2B1-4 uses a NON-Codex family so the
  // policy is proven to be about the execution role, not the agent family.
  const semantics = [
    ['T2B1-7', 'implementation', 'opencode'],
    ['T2B1-4', 'review', 'opencode'],
    ['T2B1-5', 'research', 'opencode'],
    ['T2B1-6', 'test', 'opencode'],
  ] as const;
  for (const [label, taskType, agentId] of semantics) {
    const built = buildRunRequest({ task: baseTask({ taskType, agentId }), cwd: 'C:/w' });
    check(`${label}: a ${taskType} execution task carries the contract`,
      hasAllSemantics(built.request.prompt).length === 0,
      `missing: ${hasAllSemantics(built.request.prompt).join(', ')}`);
  }
  // And the review TASK still selects the review TRANSPORT profile — semantic preserved,
  // policy unchanged.
  check('T2B1-4: the review SEMANTIC is not erased by the fix',
    buildRunRequest({ task: baseTask({ taskType: 'review' }), cwd: 'C:/w' }).request.mode === 'review',
    'review transport profile lost');
  check('T2B1-4: while a non-review task keeps the default profile',
    buildRunRequest({ task: baseTask({ taskType: 'research' }), cwd: 'C:/w' }).request.mode === 'default',
    'research unexpectedly maps to review');
}

{
  // T2B1-8: VERBATIM preservation with meaningful leading/trailing whitespace.
  const exact = '  \nORIGINAL_TASK_MARKER_123\nbody\n  ';
  const built = buildRunRequest({ task: baseTask(), cwd: 'C:/w', prompt: exact });
  const p = built.request.prompt;
  check('T2B1-8: the exact task instruction substring is present, byte for byte',
    p.includes(exact), JSON.stringify(p.slice(-40)));
  check('T2B1-8: it is not trimmed at the tail', p.endsWith(exact), JSON.stringify(p.slice(-8)));
  check('T2B1-8: the leading whitespace survived too', p.includes(`\n\n${exact}`),
    JSON.stringify(p.slice(p.indexOf('--- TASK (unchanged) ---'))));
  // A trim() regression would drop the surrounding spaces/newlines; prove it did not.
  check('T2B1-8: a trimmed copy would differ (the assertion is not vacuous)',
    p.includes(`\n\n${exact}`) && !p.endsWith(exact.trim()), 'the composer trimmed');

  // T2B1-9: no TaskStore mutation — the Task VALUE is untouched.
  const task = baseTask();
  const before = JSON.stringify(task);
  buildRunRequest({ task, cwd: 'C:/w' });
  check('T2B1-9: the Task record is not mutated by composition',
    JSON.stringify(task) === before, 'the Task was mutated');
  check('T2B1-9: the contract lives only on the request, never the task',
    !task.acceptanceCriteria.includes('reuse') && task.taskType === 'implementation',
    'task semantics contaminated');
  check('T2B1-9: the request prompt is the only location carrying the contract',
    built.request.prompt.includes('reuse-first') && built.request.prompt !== task.acceptanceCriteria,
    'contract location unexpected');
}

{
  // T2B1-10: the composer is idempotent-safe about the SEPARATOR — the contract appears
  // exactly once, and adding it never duplicates it.
  const built = buildRunRequest({ task: baseTask(), cwd: 'C:/w' });
  const occurrences = built.request.prompt.split('Execution contract (Worker-local bounded recon / reuse-first)').length - 1;
  check('T2B1-10: the contract is injected exactly ONCE', occurrences === 1, `occurrences=${occurrences}`);
  check('T2B1-10: there is exactly one task delimiter',
    (built.request.prompt.split('--- TASK (unchanged) ---').length - 1) === 1,
    'task delimiter duplicated');
}

// --- T2B-22/§24 honesty: delivery is provable, compliance is not claimed ---
section('T2B. what is actually proven (delivery, not model compliance)');
{
  const p = buildRunRequest({ task: baseTask(), cwd: 'C:/w' }).request.prompt;
  check('T2B-22: delivery is provable — the instruction text is on the request',
    p.includes('REUSE, ADAPT, WRAP, or NEW'), 'not delivered');
  check('T2B-24: no brittle compliance gate exists in production code',
    !/REUSE:\s*['"]|includes\(['"]REUSE/.test(
      readFileSync(new URL('../src/orchestration/worker-execution-contract.ts', import.meta.url), 'utf8')),
    'composer parses output text');
  check('T2B-23: the Worker is asked for brief reuse evidence, not a report',
    p.includes('a few lines, not a report'), 'over-demanding wording');
}

// ===========================================================================
// MVP-E2E.1b — bounded scope, explicit NEW, denial and real delivery.
// ===========================================================================
//
// The recorded product failures shared ONE instruction defect: the delivered contract told a
// Worker to "search the repository" and treated reading external installs as "fine", never
// bounding recon to the actual cwd, never making an empty-project NEW decision explicit,
// never forbidding denial-bypass, and never demanding real filesystem delivery. Every check
// below reads the FINAL outgoing production RunRequest (and, where relevant, the adapter
// argv), not the source template. They prove the WORDING is delivered; a fake Worker cannot
// prove model compliance and none is pretended here.
section('MVP-E2E.1b. delivered scope, NEW, denial and delivery wording');

/** The FINAL prompt the production request constructor emits for a task. */
const deliveredPrompt = (over: Partial<Task> = {}, prompt?: string): string =>
  buildRunRequest({
    task: baseTask(over),
    cwd: 'C:/workspace',
    ...(prompt === undefined ? {} : { prompt }),
  }).request.prompt;

// --- scope is the actual cwd, never parents/siblings/control artifacts/runtime evidence ---
{
  const p = deliveredPrompt();
  check('E2E1b-1: recon is bounded to the actual cwd/workspace',
    p.includes('actual process working directory') && p.includes('cwd / workspace'), 'cwd scope absent');
  check('E2E1b-2: parents/siblings and harness/control/owned-root/launcher artifacts are excluded',
    p.includes('parent or sibling') && p.includes('harness, control, owned-root or launcher'), 'exclusions absent');
  check('E2E1b-3: historical audit logs and runtime evidence are excluded',
    p.includes('historical audit logs or runtime evidence'), 'evidence exclusion absent');
  check('E2E1b-4: an operational path/artifact reference is not permission',
    p.includes('operational path or artifact reference is not permission'), 'permission caveat absent');
  check('E2E1b-4: external checks are never a mandatory empty-project prerequisite',
    p.includes('never a mandatory prerequisite') && p.includes('external public reference'), 'prerequisite rule absent');
}

// --- empty workspace: a different new filename must be choosable as NEW without proving absence ---
{
  const p = deliveredPrompt({}, 'Create src/feature/brand-new-widget.ts, a widget that does not exist yet.');
  check('E2E1b-5: an empty-scope new file can be chosen NEW explicitly',
    p.includes('choose NEW explicitly') && p.includes('need not prove'), 'NEW guidance absent');
  check('E2E1b-5: and recon stops so the requested task is performed immediately',
    p.includes('perform the requested task immediately'), 'stop-and-work absent');
  check('E2E1b-5: the original new-file task body survives behind the delimiter',
    p.includes('--- TASK (unchanged) ---') && p.includes('src/feature/brand-new-widget.ts'), 'task body lost');
}

// --- existing project: same-name / reusable module, research is evidence only ---
{
  const p = deliveredPrompt();
  check('E2E1b-6: a same-name or reusable module is preferred before writing new code',
    p.includes('same-name module or an existing reusable module'), 'reuse-first absent');
  check('E2E1b-7: existing research is evidence, never automatic proof of correctness',
    p.includes('never automatic proof of correctness') && p.includes('evidence and leads only'), 'proof caveat absent');
}

// --- denial: no bypass, no irrelevant repeats, native permissions untouched ---
{
  const p = deliveredPrompt();
  check('E2E1b-8: denial-bypass and irrelevant repeats are forbidden',
    p.includes('never bypass a denial through another tool') && p.includes('never repeat an irrelevant probe'),
    'bypass rule absent');
  check('E2E1b-9: a native stop yields a precise blocker, never fabrication',
    p.includes('report the precise blocker') && p.includes('never fabricate a delivery'), 'blocker rule absent');
  check('E2E1b-10: native permission behaviour must not be changed',
    p.includes('Do not change native permission behaviour'), 'permission tampering rule absent');
}

// --- delivery: real writes with evidence; read-only tasks untouched ---
{
  const p = deliveredPrompt();
  check('E2E1b-11: writing tasks require real filesystem delivery with evidence',
    p.includes('actually create or change the requested files') && p.includes('paths, command, output and exit'),
    'delivery rule absent');
  check('E2E1b-12: a plan/recon-only answer is not completion',
    p.includes('plan or recon-only answer is not completion'), 'completion rule absent');
  check('E2E1b-13: read-only tasks must not be mutated',
    p.includes('If the task is read-only, do not mutate'), 'read-only guard absent');
}

// --- readonly/research/review semantics stay protected; review transport profile preserved ---
{
  for (const taskType of ['research', 'review', 'test'] as const) {
    const built = buildRunRequest({ task: baseTask({ taskType }), cwd: 'C:/workspace' });
    check(`E2E1b-14: a ${taskType} execution still carries the read-only guard`,
      built.request.prompt.includes('If the task is read-only, do not mutate'), 'guard missing');
  }
  check('E2E1b-14: the review TRANSPORT profile is preserved for a review task',
    buildRunRequest({ task: baseTask({ taskType: 'review' }), cwd: 'C:/workspace' }).request.mode === 'review',
    'review transport profile lost');
}

// --- test task: real upstream artifacts, actual tests, and rule conflicts are blockers ---
{
  const upstream = 'Upstream handoff: real artifacts at artifacts/tokenizer.json (produced by task t0).';
  const p = deliveredPrompt({ taskType: 'test' }, upstream);
  check('E2E1b-15: a test task must consume the real supplied upstream artifacts',
    p.includes('supplied upstream artifacts') && p.includes('runs the actual tests'), 'test-task rule absent');
  check('E2E1b-15: and never invent a pass',
    p.includes('never invents a pass'), 'fake-pass rule absent');
  check('E2E1b-15: the upstream handoff artifact reference is preserved for the Worker',
    p.includes('artifacts/tokenizer.json'), 'upstream artifact lost');
  check('E2E1b-16: a conflicting higher-priority rule is a blocker, not an override',
    p.includes('conflicting higher-priority native or task rule') && p.includes('never a permission to override'),
    'conflict rule absent');
}

// --- the FINAL outgoing adapter argv, byte-for-byte, including the new wording ---
{
  const body = 'ORIGINAL_BODY_MARKER\n  keep my whitespace  \n';
  const built = buildRunRequest({ task: baseTask(), cwd: 'C:/workspace', prompt: body });
  const args = buildWorkBuddyArgs({ ...built.request });
  const promptArg = args[args.length - 1]!;
  check('E2E1b-17: the adapter argv carries the FINAL composed prompt verbatim',
    promptArg === built.request.prompt, 'argv altered the prompt');
  check('E2E1b-17: the original task body is byte-preserved in the outgoing argv',
    promptArg.includes(body) && promptArg.endsWith(body), 'task body changed in argv');
  check('E2E1b-17: the outgoing argv carries the new bounded-scope / NEW wording',
    promptArg.includes('actual process working directory') && promptArg.includes('choose NEW explicitly'),
    'new wording absent from outgoing argv');
  check('E2E1b-17: exactly ONE argv element carries the contract (no adapter policy copy)',
    args.filter((a) => a.includes('choose NEW explicitly')).length === 1, 'adapter duplicated policy');
}

// --- honesty: wording delivery is proved; no Worker output is parsed for compliance ---
{
  const src = readFileSync(new URL('../src/orchestration/worker-execution-contract.ts', import.meta.url), 'utf8');
  check('E2E1b-18: compliance is never inferred by parsing Worker output in production code',
    !/REUSE:\s*['"]|includes\(['"]REUSE/.test(src), 'composer parses output');
}

// --- the REAL OpenCode transport argv is the true boundary (offline, no spawn) ---
//
// E2E1b-17 above proves the WorkBuddy argv builder forwards the composed prompt. But the
// recorded product failures were actual OpenCode runs, and `buildWorkBuddyArgs` is a
// different family's builder, so it is only a proxy. Here the REAL OpenCode transport is
// built through the existing `createOpenCodeAdapter` with an INERT `LauncherSpec`: no
// discovery, and `createTransport` never calls `start()` and never spawns anything. Its
// stored options are read through a narrow test-only cast — `opts` is a TypeScript
// `private` field (not a `#` field), so the real argv boundaries are observable without a
// mock builder and without adding a production export. `commandLine` alone would be a
// lossy joined string; `opts.args` preserves each argv element.
{
  const inert: LauncherSpec = {
    kind: 'native',
    command: 'C:/inert/opencode.exe',
    prefixArgs: [],
    target: 'C:/inert/opencode.exe',
    buildsCommandString: false,
  };
  const adapter = createOpenCodeAdapter({ launcher: inert });
  const body = 'ORIGINAL_OPENCODE_BODY_MARKER\n  keep my whitespace  \n';
  const built = buildRunRequest({
    task: baseTask({ agentId: 'opencode', modelId: 'opencode/space-bunny-free' }),
    cwd: 'C:/actual-cwd',
    prompt: body,
  });
  // The REAL transport is built; it is never started and nothing is spawned.
  const transport = adapter.createTransport(built.request);
  check('E2E1b-19: the OpenCode transport is the real CliJsonlTransport',
    transport.kind === 'cli-jsonl', transport.kind);
  const { args, cwd } = (transport as unknown as {
    opts: { args: readonly string[]; cwd: string };
  }).opts;

  check('E2E1b-19: argv[1] is the EXACT composed prompt (run subcommand unchanged)',
    args[0] === 'run' && args[1] === built.request.prompt, `run=${args[0]} promptMatch=${args[1] === built.request.prompt}`);
  const dirArg = args[args.indexOf('--dir') + 1];
  check('E2E1b-19: --dir carries the ACTUAL cwd (and the transport spawns there)',
    dirArg === 'C:/actual-cwd' && cwd === 'C:/actual-cwd', `--dir=${String(dirArg)} cwd=${cwd}`);
  const modelArg = args[args.indexOf('--model') + 1];
  check('E2E1b-19: the fixed model arg is passed through unchanged',
    modelArg === 'opencode/space-bunny-free', String(modelArg));
  check('E2E1b-19: the original task body is byte-preserved at the prompt boundary',
    args[1]!.includes(body) && args[1]!.endsWith(body), 'task body changed in argv');

  // No scope-widening or permission-bypass switch was appended by any layer. Proving the
  // flag set is EXACTLY the expected one is stronger than a denylist alone; the denylist
  // then names the specific plan/read-only/bypass/continue-loop classes this defect was
  // about, so a future addition is a red test rather than a silent widening.
  const flags = args.filter((a) => a.startsWith('--'));
  const unexpected = flags.filter((f) => !['--format', '--dir', '--model'].includes(f));
  check('E2E1b-19: the argv carries NO extra switch beyond format/dir/model',
    unexpected.length === 0, `unexpected flags: ${unexpected.join(', ')}`);
  check('E2E1b-19: no plan/read-only/permission-bypass/continue-loop switch was added',
    !args.some((a) => /^--(plan|read-only|permission|dangerously|bypass|yolo|continue|loop|sandbox|fork|auto)/i.test(a)),
    args.filter((a) => a.startsWith('--')).join(' '));
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length > 0) {
  process.stdout.write(`failing:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
}
process.exitCode = failed === 0 ? 0 : 1;