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
  '1. Inspect the relevant current truth: the existing code, tests, interfaces and config for this task\'s area. Do not guess repository structure from this instruction.',
  '2. Search the repository for an existing helper, module, adapter, contract or test fixture you could reuse.',
  '3. Check the relevant upstream / reference / open-source implementation when this task touches a protocol, an agent integration or library behaviour.',
  '4. Before copying or adapting anything, verify the parts that matter for this task: licence, API/version compatibility, and local platform constraints.',
  '5. Reach an explicit reuse decision before implementing: REUSE, ADAPT, WRAP, or NEW.',
  '6. Any shared research, prior worker notes or linked references are evidence and leads only. Read them first if useful, but verify the portions you depend on yourself; their existence never means your recon is already done.',
  '7. Keep recon bounded: stop as soon as you have enough evidence to make the implementation choice. Do not search indefinitely or read unrelated code.',
  '8. Do not modify external Agent installations, packages or source trees (for example the OpenCode, Codex or WorkBuddy install directories). Reading or referencing them is fine; only this project\'s own scope may be changed.',
  '9. Only after that recon and reuse decision, perform the task.',
  '',
  'When you finish, state briefly (a few lines, not a report):',
  '- Recon: which relevant existing implementation and which reference sources you actually checked.',
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