/**
 * src/runtime/process-start.ts — the MONOTONIC process-start state machine.
 *
 * A pure value helper, not an authority: it owns no process, reads no OS state, and
 * cannot brand anything. It exists so the single most dangerous transition in this
 * subsystem is expressed once, explicitly, and cannot be undone by a stray assignment.
 *
 * THE INVARIANT
 *
 *   once `started`, the state can NEVER become `not-started`.
 *
 * That asymmetry is the whole point. `not-started` is permission to release a WRITE
 * scope without a tree-stop proof; `started` means a writer may exist. If a failure
 * arriving LATE could drag `started` back to `not-started`, a live writer would be
 * unlocked — which is exactly the class of bug this whole line of work keeps closing.
 *
 * The disposition values are the public ones from `core/types.ts`. The internal
 * distinction the design cares about — "spawn not attempted yet" versus "spawn
 * attempted, outcome unknown" — collapses to `may-have-started`, because both permit
 * exactly the same transitions: a proven image-not-found failure may still resolve them
 * to `not-started`, while a confirmed start may not.
 */

import type { ProcessStartDisposition } from '../core/types.ts';

/**
 * The things that can happen to a spawn attempt.
 *
 *   proven-pre-spawn-failure   the runtime proved, before calling `spawn`, that no
 *                              process exists (launcher absent, control setup refused,
 *                              request rejected in preflight).
 *   spawn-attempted            `spawn()` was called; the outcome is not yet known.
 *   spawn-confirmed            the OS reported a real child (a pid, or the `spawn`
 *                              event).
 *   spawn-error-image-not-found  the spawn failed with ENOENT/EACCES: the image was
 *                              not found or not executable, so `CreateProcess` never
 *                              ran.
 *   spawn-error-other          any other spawn failure. Not classifiable, therefore
 *                              NOT proof of absence.
 */
export type ProcessStartEvent =
  | 'proven-pre-spawn-failure'
  | 'spawn-attempted'
  | 'spawn-confirmed'
  | 'spawn-error-image-not-found'
  | 'spawn-error-other';

/** Is this disposition final (no further event may change it)? */
export function isTerminalStartState(state: ProcessStartDisposition): boolean {
  return state === 'started' || state === 'not-started';
}

/**
 * Advance the process-start state. Monotonic and total.
 *
 * A terminal state absorbs every event, so there is no code path — present or future —
 * that can express `started -> not-started`. That is enforced HERE rather than at each
 * call site, so adding a new event or a new caller cannot reopen the hole.
 */
export function advanceProcessStart(
  current: ProcessStartDisposition,
  event: ProcessStartEvent,
): ProcessStartDisposition {
  // Terminal states never move. `started` in particular can never be downgraded.
  if (isTerminalStartState(current)) return current;

  switch (event) {
    case 'proven-pre-spawn-failure':
      return 'not-started';
    case 'spawn-confirmed':
      return 'started';
    case 'spawn-error-image-not-found':
      // Only reachable from `may-have-started` (guarded above), i.e. a spawn that never
      // produced a child. A confirmed start is terminal and never reaches this line.
      return 'not-started';
    case 'spawn-error-other':
    case 'spawn-attempted':
      return 'may-have-started';
  }
}