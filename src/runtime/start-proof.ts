/**
 * src/runtime/start-proof.ts — the PUBLIC face of the trusted start proof.
 *
 * This module exports a PREDICATE and nothing else. It cannot mark an error, cannot
 * brand one, and cannot certify that a process was never created — because certifying
 * that requires knowing the OS process lifecycle, and that knowledge lives in
 * `src/runtime/**` only (see `./internal/start-proof.ts` for the full rationale).
 *
 * Orchestration CONSUMES the answer here:
 *
 *   > the execution edge was entered, but the runtime PROVED nothing was created
 *
 * That is the ONLY evidence that may let a WRITE claim be released without a
 * tree-stop proof. Everything else — including a generic throw, an ambiguous spawn
 * failure, or a fast exception right after a successful spawn — stays "may have
 * started" and retains protection.
 */

export { hasTrustedNotStartedBrand as isProvenNotStarted } from './internal/start-proof.ts';