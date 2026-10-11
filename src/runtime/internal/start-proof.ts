/**
 * src/runtime/internal/start-proof.ts — RUNTIME-INTERNAL trusted start proof.
 *
 * ============================================================================
 * THIS FILE IS THE TRUST BOUNDARY. DO NOT IMPORT IT FROM OUTSIDE src/runtime.
 * ============================================================================
 *
 * The question it certifies is a PHYSICAL one:
 *
 *   > Did an OS process definitely never get created for this execution?
 *
 * Only a layer that actually controls process creation can answer it. Orchestration
 * can CONSUME the answer; it can never PRODUCE one, because a caller that could
 * produce one could also produce one while a writer is happily running — which is
 * exactly the exploit this design exists to close.
 *
 * WHY A MODULE-PRIVATE BRAND, NOT `instanceof`
 * `instanceof` is forgeable by anyone who can construct the class, and a public
 * constructor is exactly the problem: an upper layer could start a real writer,
 * throw `new ProcessNotStartedError(...)`, and have the orchestrator believe the
 * scope was safe. The brand below lives in a `WeakSet` that nothing outside this
 * module can add to, so the ONLY way to obtain trusted proof is to call
 * `markProvenNotStarted` from inside `src/runtime/**`.
 *
 * The predicate deliberately consults ONLY the brand. It does not look at `name`,
 * `message`, `code`, `reason`, `instanceof`, or any plain boolean property, because
 * every one of those is trivially set by a caller that wants to lie.
 *
 * ENFORCEMENT: TypeScript cannot block a deep import, so `tests/resource-claim.test.ts`
 * and `tests/containment-production.test.ts` assert this boundary at the SOURCE level.
 * A new importer outside `src/runtime/**` fails the suite.
 */

const TRUSTED_NOT_STARTED = new WeakSet<object>();

/** Why the runtime believes no process was created. Recorded, never inferred from. */
export type NotStartedReason =
  | 'launcher-unavailable'
  | 'control-setup-failed'
  | 'request-rejected-before-spawn'
  | 'unsafe-arguments-rejected'
  | 'spawn-image-not-found';

/**
 * The error thrown across the execution boundary when the runtime can PROVE that no
 * OS process was created.
 *
 * It carries no public constructor of its own: the class is not exported at all.
 * Callers receive an already-marked instance from {@link markProvenNotStarted} and can
 * only read `reason` from it.
 */
class TrustedNotStarted extends Error {
  readonly reason: NotStartedReason;
  readonly detail: string;

  constructor(reason: NotStartedReason, detail: string) {
    super(`no process was created: ${detail}`);
    this.name = 'TrustedNotStarted';
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Build — and BRAND — a trusted "no process was created" error.
 *
 * RUNTIME-INTERNAL BY DESIGN. There is deliberately no exported factory for
 * orchestration: the capability is the call site inside `src/runtime/**`, and the
 * source-boundary test asserts nothing else imports it.
 *
 * @param reason  the classified cause. Never inferred; always a known pre-spawn step.
 * @param detail  human-readable context for the operator. Recorded, never parsed.
 */
export function markProvenNotStarted(reason: NotStartedReason, detail: string): Error {
  const e = new TrustedNotStarted(reason, detail);
  TRUSTED_NOT_STARTED.add(e);
  return e;
}

/** Does this error carry the runtime's trusted "no process was created" brand? */
export function hasTrustedNotStartedBrand(e: unknown): boolean {
  return typeof e === 'object' && e !== null && TRUSTED_NOT_STARTED.has(e);
}

/**
 * Re-throw `cause` as a trusted not-started error, preserving its message.
 *
 * Used where a REAL pre-spawn failure already exists (a `mkdirSync` that threw, an
 * `assertCmdSafe` refusal) and the runtime knows from its own control flow that no
 * process was created. The original error is kept as `detail` so nothing is lost.
 */
export function asProvenNotStarted(cause: unknown, reason: NotStartedReason, detail: string): Error {
  if (hasTrustedNotStartedBrand(cause)) return cause as Error;
  const message = cause instanceof Error ? cause.message : String(cause);
  return markProvenNotStarted(reason, `${detail}: ${message}`);
}

/**
 * BRAND `cause` in place, preserving its identity.
 *
 * W3.3 needs this for request validation. Those failures are thrown by the adapter and
 * by the timeout validator as their own specific classes (`InvalidRequestError`,
 * `UnsupportedOptionError`, ...), and callers legitimately depend on `instanceof` and
 * on the concrete message. Wrapping them in a fresh error would silently strip both.
 *
 * So the proof is attached to the ORIGINAL object instead of replacing it: the WeakSet
 * membership IS the proof, and the class, message and stack all survive untouched. A
 * caller that does not ask `isProvenNotStarted` cannot tell the difference.
 *
 * The capability to do this still lives only here, inside `src/runtime/**`.
 */
export function brandProvenNotStarted<T>(cause: T, reason: NotStartedReason, detail: string): T {
  if (typeof cause === 'object' && cause !== null) {
    TRUSTED_NOT_STARTED.add(cause);
    return cause;
  }
  // A non-object throw (a bare string, `undefined`) cannot be branded, so it is
  // upgraded to a real branded error rather than being left unrecognisable.
  return markProvenNotStarted(reason, `${detail}: ${String(cause)}`) as unknown as T;
}