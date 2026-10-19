# P0-3a — Checkpoint input provenance closure

Verdict: **PASS, bounded offline scope only** (2026-10-19).

## Change

- `src/cli/workflow-checkpoint.ts`: typed input failure codes for non-TTY, timeout, EOF and read errors. The existing 60-second wait and cleanup remain.
- `src/cli/round-cli.ts`: preserve input provenance separately from a system safety stop. Only an explicit valid stop yields `user-stop`. Invalid answers retain a bounded 2000-character raw value and truncation flag; rejected acceptance retains the user's accept intent. Workflow, checkpoint, handoff and withheld Review reasons carry the actual cause.
- `tests/b46-workflow-checkpoint.test.ts`: existing cases preserved; real reader errors flow through the real CLI with fake execution/provider boundaries. Invalid input and missing-artifact acceptance refusal cannot be reported as user stop or dispatch downstream.

## Verification

- Typecheck: first failed because the test report interface lacked the new choice variants; corrected that interface, second typecheck exit 0. No repeated test run.
- Authorized single-file offline verification: **77 passed / 0 failed**, actual exit 0, 3778 ms. Source SHA256: `95596cc6e49d10fa1d0f52a9412ba9e1548113a12d69fcda5e9ee0ad0fc93e47`.
- Existing offline bootstrap freezes native Agent denial before suite evaluation. Outer Windows Job confirmed stopped, `activeProcessesFinal=0`; real product Agent/LAYA/Native Review calls: 0.
- Codex performed implementation and source/diff review under the Owner's direct-work authorization; this is not an OpenCode delegation or third-party independent audit.
- No new Task state, scheduler, verification authority, execution edge, retry, model fallback, automatic acceptance or cross-process resume.

## Review snapshot scope

Branch: `codex/p03a-checkpoint-source-20261019`, based on archived P0-1 WIP `12e21bb6c2d52ef88f2795ed9a5b394ec5b09726`.

The first snapshot commit carries the existing accepted P0-1/P0-2 prerequisites, compatible fixtures and offline runner protections. Those changes predate this slice and retain their original validation limits. The following commit isolates the P0-3a implementation, authorized test, baseline, next task and this review record. The branch is an accumulated review snapshot, not a claim that every historical test or the full backend is green. `docs/P01_BLOCKED_SNAPSHOT.md` remains historical context for the parent archive, not the current verdict.

Ignored progress/audit/evidence directories, credentials, installed Agents, local accounts and unrelated local-only configuration are excluded. Main is not merged or checked out. The main index and preexisting dirty files are preserved through a separate temporary index. Actual push SHA/file-list confirmation is reported only after querying the remote.

## Remaining

P0-3 overall and the real MVP are not sealed. The next proposed slice is P0-3b: minimal pending-user delivery material and confirmed-stop facts, explicitly without cross-process resume; it needs Owner authorization. Existing 9/26 historical failures remain open in their original scope. External model free eligibility and OpenCode's 403 are not fixed by this change.
