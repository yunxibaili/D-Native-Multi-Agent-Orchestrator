// ===========================================================================
// TeamRun T2-b — the Worker execution contract (bounded Recon / Reuse-first).
// ===========================================================================
//
// WHAT THIS IS
// Every Worker that actually EXECUTES a task must first, inside its own execution scope,
// do a bounded recon and reach an explicit reuse decision before it performs the
// substantive task. This module is that contract.
//
// WHAT THIS IS NOT
// It is not a new actor and not a new authority. There is no ResearchManager, no
// ReconManager, no scout, no recon scheduler, and nothing here chooses an Agent, a Model
// or a Session, dispatches anything, or holds mutable state. It is a pure value: a list of
// instruction lines plus a composer. `new authority = 0`.
//
// WHY A SHARED RESEARCH PASS IS NOT ENOUGH
// "A research agent looked once" and "every Worker verified its own scope" are different
// guarantees. A shared pass can supply evidence and leads, and Workers are told to prefer
// reading it, but the contract explicitly forbids treating its existence as proof that
// recon is done. That is the whole point of §7: shared research may be READ FIRST, never
// relied on unverified, and never allowed to waive Worker-local verification.
//
// WHY THE WORDING IS DELIBERATELY ROLE-NEUTRAL
// The contract says "before performing the substantive task" rather than "before editing
// files". T3 will add read-only Workers, and a contract that hard-codes a mutation trigger
// would be wrong for them the moment they exist — so the trigger is phrased as the
// substantive work itself, which a WRITE Worker reaches at its first edit and a READ Worker
// reaches at its analysis.
//
// SCOPE: EXECUTION ONLY — SEPARATED BY THE SEAM, NOT BY A GATE
// This contract is injected at `buildRunRequest`, which is the formal execution-request
// constructor and has exactly ONE call site (the orchestrator's executeTask edge). The
// injection is UNCONDITIONAL: there is no `mode`/taskType/agent gate, because the seam
// itself is the role boundary.
//
// The Unified Review path never reaches `buildRunRequest` at all — it calls
// `reviewer.review(...) -> Orchestrator.review -> run({...mode:'review'})` — so the reviewer
// cannot receive an implementation contract by construction.
//
// `RunRequest.mode` ('default' | 'review') is a TRANSPORT profile derived from
// `task.taskType`; it is NOT a role and must not be used to decide policy. A review-SEMANTIC
// Task dispatched through the scheduler is an ordinary execution Worker (real Attempt, real
// WorkerIdentity) and DOES receive this contract; only the separate review SEAM is excluded.
// Similarly the gate is never `agentId === 'codex'`: Codex is both a formal execution Agent
// family and the Unified Review role, so identity cannot decide the role either.
// ===========================================================================

/**
 * The canonical contract wording. ONE source, rendered once, injected once.
 *
 * Adapters must never restate any of this — they are transport only and have no policy
 * authority (§40). If a family needs different wording, the wording belongs here, not in
 * four adapter copies.
 */
export const WORKER_RECON_REUSE_CONTRACT: readonly string[] = Object.freeze([
  'Execution contract (Worker-local bounded recon / reuse-first). This is execution policy, not task content.',
  '',
  'Before performing the substantive task, and bounded to this task\'s own scope:',
  '1. Recon only the task-relevant files inside the actual process working directory (cwd / workspace). Honor any narrower scope the task itself states. Do not walk parent or sibling directories, unrelated workspaces, or harness, control, owned-root or launcher artifacts, and do not read historical audit logs or runtime evidence.',
  '2. An operational path or artifact reference is not permission to read it. Consume only the authorized, relevant handoff material that was explicitly supplied to this task. Check an external public reference only when the task needs it and is authorized to; an external check is never a mandatory prerequisite for an empty project, and no external Agent installation is read merely because it is installed.',
  '3. Existing project: inspect the directly relevant code, tests and interfaces, and prefer reusing a same-name module or an existing reusable module over writing a new one. Before adapting anything, verify what matters for this task: licence, API/version compatibility, and local platform constraints.',
  '4. Existing research, prior worker notes or linked references are evidence and leads only and never automatic proof of correctness. Read them first if useful, but verify the portions you depend on yourself; their existence never means your recon is already done.',
  '5. Reach an explicit reuse decision before implementing: REUSE, ADAPT, WRAP, or NEW. In an empty or new scope, after a bounded in-scope check finds no suitable implementation, choose NEW explicitly; you need not prove that nothing suitable exists anywhere else. Keep recon bounded: stop as soon as you have enough evidence and perform the requested task immediately.',
  '6. Denial: never bypass a denial through another tool and never repeat an irrelevant probe. If native execution is still available and the in-scope evidence is sufficient, continue the task. If the information you need is missing or native execution stops, report the precise blocker and never fabricate a delivery. Do not change native permission behaviour.',
  '7. Delivery: if the authorized task asks for writing, actually create or change the requested files in the declared scope, validate them as far as you can, and report the paths, command, output and exit. A plan or recon-only answer is not completion. If the task is read-only, do not mutate anything.',
  '8. A test task consumes the real supplied upstream artifacts within scope, runs the actual tests, and never invents a pass. A conflicting higher-priority native or task rule is a blocker to report, never a permission to override.',
  '9. Do not modify external Agent installations, packages or source trees (for example the OpenCode, Codex or WorkBuddy install directories); only this project\'s own scope may be changed.',
  '',
  'When you finish, state briefly (a few lines, not a report):',
  '- Recon: which task-relevant existing implementation and which authorized reference sources you actually checked inside scope.',
  '- Reuse decision: REUSE / ADAPT / WRAP / NEW, and why NEW if that is the choice.',
]);

/**
 * Compose the contract onto a task instruction.
 *
 * The contract is PREPENDED and the original instruction follows a fixed separator,
 * EMBEDDED UNCHANGED. Nothing is written back into the TaskStore, the Planner output or the
 * raw user prompt — this only affects the text of the execution request.
 *
 * The task instruction is inserted as an exact substring. It is deliberately NOT trimmed,
 * dedented, whitespace-normalised or otherwise rewritten: earlier this function called
 * `trim()`, which made the "unchanged / verbatim" claim in the docs untrue at the leading
 * and trailing whitespace boundaries. The only thing this function may touch is the fixed
 * contract-and-separator prefix it adds.
 *
 * `taskInstruction` may legitimately be any string, including one with significant
 * leading/trailing whitespace, and is passed through as given. An empty string is allowed
 * and simply embeds nothing after the separator.
 */
export function composeWorkerExecutionPrompt(taskInstruction: string): string {
  const contract = WORKER_RECON_REUSE_CONTRACT.join('\n');
  // The delimiter names the boundary explicitly, so nothing in the contract can be mistaken
  // for task content and nothing in the task content can be mistaken for policy.
  return `${contract}\n\n--- TASK (unchanged) ---\n\n${taskInstruction}`;
}