/**
 * src/orchestration/workbench-handoff.ts — structured handoff between tasks.
 *
 * THE RULE THE OLD ARCHITECTURE VIOLATED BY OMISSION
 * --------------------------------------------------
 * Dependent tasks used to receive only the dependency's artifact PATHS in their
 * prompt. Everything else the worker knew lived in a transcript nobody passes.
 * The result: task B re-derived task A's outcome by re-reading the repository.
 *
 * A `TaskHandoff` is the fix, and it is deliberately SMALL and EVIDENCE-BACKED:
 *   - it is built from things that really happened (the task's own status, its
 *     recorded artifacts, and the REAL `RunResult` of its latest attempt),
 *   - it carries NO transcript and NO model output verbatim — at most a bounded
 *     tail of the worker's own summary,
 *   - it is data the NEXT task can act on, not conversation to catch up on.
 *
 * This is the Workbench's answer to "how do tasks share context": a worker reads
 * a structured brief composed from its dependencies' handoffs, and the native
 * agent's own memory/subagents stay entirely inside the native session.
 */

import type { Task } from './task.ts';
import type { RunResult } from '../core/types.ts';

export interface TaskHandoff {
  readonly taskId: string;
  readonly objective: string;
  readonly taskType: Task['taskType'];
  /** The task's lifecycle status at handoff time. */
  readonly status: Task['status'];
  /** The run's own terminal state, when one exists. */
  readonly runState: RunResult['state'] | null;
  /** Files/artifacts the task declared. Paths only — content stays on disk. */
  readonly artifacts: readonly { readonly name: string; readonly path: string }[];
  /**
   * The worker's summary of what it did — a bounded tail of `RunResult.output`,
   * because that tail is the one place a worker states its own outcome. Never a
   * full transcript.
   */
  readonly completedWork: string | null;
  /** Exit-level error, when the run reported one. */
  readonly error: { readonly code: string; readonly message: string } | null;
  /** Where a reviewer can find the real conversation, if one exists. */
  readonly transcriptPath: string | null;

  // ---- the sections a dependant needs in order to act ------------------------
  //
  // Each one is derived from evidence that REALLY happened, and is `null`/`[]` when
  // the evidence does not support it. The alternative — a prompt asking a worker to
  // "fill in the handoff template" — produces a plausible-looking document that
  // says nothing, which is worse than an explicit "not reported": a dependant can
  // trust an absence it can see.

  /**
   * Files this run actually WROTE, from its own write/edit tool calls.
   *
   * Not the artifact list: artifacts are what a task DECLARED, this is what the
   * worker touched. Dependants need the second to reason about the first.
   */
  readonly changedFiles: readonly string[];
  /**
   * Shell commands this run actually EXECUTED, from its own shell tool calls.
   *
   * The field keeps its historical name, and every shell command lands here. It is an
   * OBSERVED COMMAND LIST, never test verdicts: no command is classified as a passing
   * or failing test from its name, its prose, or an exit code.
   */
  readonly testsRun: readonly string[];
  /**
   * Decisions the worker explicitly stated, when it stated any.
   *
   * Derived from an explicit marker in the bounded summary tail, not from guessing
   * at prose. A worker that said nothing about a decision yields null, which the
   * brief renders as "none reported" — never as an empty list, which would read as
   * "there were no decisions" when the truth is "we do not know".
   */
  readonly decisions: string | null;
  /**
   * Things the worker explicitly flagged as unfinished.
   *
   * Same derivation rule as `decisions`: an explicit marker in the summary tail.
   */
  readonly unresolved: readonly string[];
  /**
   * Constraints the dependant must respect. Carried from the dependency's own
   * prompt tail only when the worker restated them; otherwise null.
   */
  readonly constraints: string | null;
}

/**
 * Explicit markers a worker can emit in its own summary, so the sections above are
 * lifted from what was actually said rather than inferred from tone.
 *
 * Format: a line beginning with the marker. Kept deliberately narrow — a looser
 * pattern would start inventing decisions out of ordinary prose, which is exactly
 * the fabrication this handoff is meant to eliminate.
 */
const DECISION_LINE = /^\s*(?:decision|decided)\s*[:\-]\s*(.+)$/gim;
const UNRESOLVED_LINE = /^\s*(?:unresolved|left to do|todo|not done)\s*[:\-]\s*(.+)$/gim;

/** Collect the values of every `marker: value` line, trimmed and bounded. */
function markedLines(text: string | null, pattern: RegExp): string[] {
  if (text === null) return [];
  const out: string[] = [];
  // A fresh RegExp per call: `g` regexes carry `lastIndex`, so a shared instance
  // would resume mid-string and silently drop lines.
  for (const m of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
    const v = (m[1] ?? '').trim();
    if (v !== '') out.push(v.slice(0, 200));
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * Tool names that write or edit a file, and the argv key each one uses.
 *
 * LOOKUPS ARE CASE-INSENSITIVE, and that is measured rather than defensive: the
 * same logical tool arrives spelled differently by different natives — CodeBuddy
 * sends `Write`/`Bash`/`PowerShell`, OpenCode sends `write`/`bash`. A
 * case-sensitive map matches one agent perfectly and silently yields an EMPTY
 * handoff for the other, which reads as "this run changed nothing" when it
 * changed everything. Both spellings are real; neither adapter is wrong.
 */
const WRITE_TOOLS = new Map<string, readonly string[]>([
  ['write', ['filePath', 'file_path', 'path', 'notebook_path', 'notebookPath']],
  ['edit', ['filePath', 'file_path', 'path']],
  ['multiedit', ['filePath', 'file_path', 'path']],
  ['notebookedit', ['notebookPath', 'notebook_path', 'path']],
  ['apply_patch', ['path', 'filePath']],
  ['str_replace_editor', ['path', 'filePath']],
  // WorkBuddy/CodeBuddy's own write-tool spellings.
  ['create_file', ['file_path', 'path', 'filePath']],
]);
/**
 * Tool names that run a command, i.e. where an observed shell command appears. Includes
 * the `execute_*` family several agents use for the same thing. A command is recorded
 * as OBSERVED, never labelled a test: nothing here can tell a test from any other command.
 */
const SHELL_TOOLS = new Set([
  'bash', 'shell', 'powershell', 'run_terminal_cmd', 'execute_command',
  'run_command', 'terminal', 'sh', 'cmd',
]);

const WRITE_TOOL_LOOKUP = new Map([...WRITE_TOOLS].map(([k, v]) => [k.toLowerCase(), v]));

/** Pull the first string-ish value out of a tool input without trusting its shape. */
function inputPath(input: unknown, keys: readonly string[]): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const rec = input as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}

/** A command string out of whichever shell field the adapter used. */
function shellCommand(input: unknown): string | null {
  return inputPath(input, ['command', 'cmd', 'script', 'input', 'shell_command', 'commandLine']);
}

const uniq = (xs: readonly string[]): string[] => [...new Set(xs)];

/** The bound on quoted worker output. Enough to steer, not enough to be a transcript. */
const OUTPUT_TAIL_CHARS = 600;

/** Build a handoff from the task's own authoritative data. Pure. */
export function buildHandoff(task: Task, result: RunResult | null): TaskHandoff {
  const output = result?.output ?? null;
  const completedWork =
    output === null || output.trim() === ''
      ? null
      : output.length <= OUTPUT_TAIL_CHARS
        ? output
        : `…${output.slice(-OUTPUT_TAIL_CHARS)}`;
  // Derived from the run's OWN tool calls. When there is no run there is no evidence,
  // so these are empty rather than invented.
  const changedFiles: string[] = [];
  const testsRun: string[] = [];
  for (const call of result?.toolCalls ?? []) {
    const name = call.name.toLowerCase();
    const writeKeys = WRITE_TOOL_LOOKUP.get(name);
    if (writeKeys !== undefined) {
      const p = inputPath(call.input, writeKeys);
      if (p !== null) changedFiles.push(p);
      continue;
    }
    if (SHELL_TOOLS.has(name)) {
      const cmd = shellCommand(call.input);
      if (cmd !== null) testsRun.push(cmd);
    }
  }
  const decisions = markedLines(completedWork, DECISION_LINE);
  const unresolved = markedLines(completedWork, UNRESOLVED_LINE);
  return Object.freeze({
    taskId: task.taskId,
    objective: task.acceptanceCriteria,
    taskType: task.taskType,
    status: task.status,
    runState: result?.state ?? null,
    artifacts: Object.freeze(task.artifacts.map((a) => Object.freeze({ name: a.name, path: a.path }))),
    completedWork,
    error: result?.error ?? null,
    transcriptPath: result?.transcriptPath ?? null,
    changedFiles: Object.freeze(uniq(changedFiles)),
    testsRun: Object.freeze(uniq(testsRun)),
    decisions: decisions.length > 0 ? decisions.join('; ') : null,
    unresolved: Object.freeze(unresolved),
    // No invented constraint list. Only what the worker itself said, and only from
    // the bounded tail already quoted above.
    constraints: null,
  });
}

/**
 * Compose the brief a worker actually receives: its own objective and
 * constraints, plus the handoff of every dependency it waits on.
 *
 * Deterministic and bounded: sections render in a fixed order, handoffs appear
 * in dependency-declaration order, and nothing here can grow with the size of a
 * conversation. The native agent's prompt is built ONCE here — the Workbench's
 * job, not Laya's (Laya decides WHAT, this renders it).
 */
export function buildTaskBrief(input: {
  objective: string;
  constraints?: readonly string[];
  handoffs?: readonly TaskHandoff[];
  /**
   * Laya's skill INTENT, rendered verbatim.
   *
   * This is the entire skill mechanism, and its smallness is the design: the
   * orchestrator has no skill catalogue, does not check that these names exist, and
   * cannot tell whether the assigned agent has them. The native agent already has
   * its own skill runtime, its own discovery and its own invocation rules, so the
   * only thing missing was a way to ASK. This is that way — and an agent that does
   * not recognise a name is expected to say so and continue, not to fail.
   *
   * Worded as a request rather than an instruction precisely so it cannot be read
   * as a hard requirement: a missing skill should degrade the work, not stop it.
   */
  skills?: readonly string[];
}): string {
  const lines: string[] = [
    'Work:',
    input.objective.trim(),
  ];
  if (input.skills !== undefined && input.skills.length > 0) {
    lines.push('', 'Requested skills (use your own if you have them; otherwise continue without):');
    for (const s of input.skills) lines.push(`- ${s}`);
  }
  if (input.constraints !== undefined && input.constraints.length > 0) {
    lines.push('', 'Constraints:');
    for (const c of input.constraints) lines.push(`- ${c}`);
  }
  for (const h of input.handoffs ?? []) {
    lines.push('', `Handoff from task ${h.taskId} (${h.taskType}, status: ${h.status}):`);
    // `objective` is the section label itself, and it is always present: it is the
    // dependant's own definition of what upstream was for.
    if (h.runState !== null) lines.push(`- result: ${h.runState}`);
    if (h.artifacts.length > 0) {
      lines.push('- artifacts:');
      for (const a of h.artifacts) lines.push(`    ${a.name}: ${a.path}`);
    }
    if (h.changedFiles.length > 0) {
      lines.push('- changedFiles:');
      for (const f of h.changedFiles) lines.push(`    ${f}`);
    }
    if (h.testsRun.length > 0) {
      // OBSERVED COMMANDS, not test verdicts: this list is every shell command the run
      // executed, and nothing here is a pass/fail claim about a test.
      lines.push('- observed commands (NOT test verdicts):');
      for (const t of h.testsRun) lines.push(`    ${t}`);
    }
    if (h.completedWork !== null) lines.push(`- completedWork: ${h.completedWork}`);
    // These three are rendered even when empty. An absent section reads as "not
    // applicable"; a section that says "none reported" is information, and it is the
    // difference between a dependant that knows and one that assumes.
    lines.push(`- decisions: ${h.decisions ?? 'none reported'}`);
    lines.push(`- unresolved: ${h.unresolved.length > 0 ? h.unresolved.join('; ') : 'none reported'}`);
    lines.push(`- constraints: ${h.constraints ?? 'none reported'}`);
    if (h.error !== null) lines.push(`- reported error: ${h.error.code}: ${h.error.message}`);
  }
  return lines.join('\n');
}
