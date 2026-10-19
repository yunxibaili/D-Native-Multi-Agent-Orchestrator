# P0-3 overall static closure — BLOCKED

Date: 2026-10-19. Scope: source/contracts/existing evidence only. No production edits, tests, typechecks, model calls or live probes in this review.

## Verdict

**BLOCKED for overall P0-3 closure.** Existing P0-3a/b/c bounded offline results remain historical evidence, not proof that every final failure reaches the persisted attention material. One direct projection gap remains; this review does not authorize a repair or real E2E.

## Contract mapping

| Contract | Current source | Evidence / finding |
|---|---|---|
| Distinguish explicit stop from system EOF/timeout/read errors | workflow-checkpoint typed errors; round-cli checkpointGate:3291-3327 | 92/0 historical reader/CLI tests; current test hash matches. Raw invalid input is an input fact, not a user stop verdict. |
| Preserve valid accept and the unique completion authority | round-cli live identity recheck -> workbench.completeTask:1448 -> applyVerification:1457 | Existing normal/invalid/refused acceptance cases and source inspection. No automatic Owner input. |
| Preserve machine failure, wait and budget refusal | round-cli machineGate, publishEarlyAttention:1671, automaticAttention:4963 | 104/0 historical controlled cases include test exit1, wait, budget0/2 and early authorization revocation. |
| Preserve identity and actual saved attention | attentionMemo + round-result PendingUserSummary/renderer + publishRoundResult:255 | Unknown execution identity stays null; saved-file comparisons in both suites. Attention-only early files are distinct from full RoundResult. |
| Review must produce a passing verdict for auto success | round-cli reviewRequestedNotClean:4814 | 104/0 includes completed reject/rework and a withheld Review child physically exiting1. No real Native Review proof. |
| Keep existing stop protection | orchestration/orchestrator:2056,2180-2195 | Worker/test stop is ANDed before claim release; unknown stop retains protection. Inherited source, not newly exercised in this review. Memo does not certify all processes stopped. |
| No recovery or second state authority | PendingUserSummary source/system, resumeSupported=false, stopSafetyCertified=false | Read-only report only; TaskStore/AttemptStore remain in-memory. No safe paused/resumable state is claimed. |
| Final gate starts nothing | round-result automaticPostRoundAction=none:1172/1193/1201; CLI last output/return | Source inspection. No actual Owner final acceptance or full real E2E claimed. |
| Final authorization invalidation reaches durable user delivery | finalDrift:4803-4820 versus automaticAttention:4963-4975 and publication:5043 | **BLOCKER P03-F1**, below. |

## P03-F1 — Late approval drift is absent from persisted attention

Source-reachable scenario, not a newly executed experiment:

1. Both tasks reach succeeded and the Reviewer is admitted while the declared pool is still valid.
2. The pool expires (or approved material changes) during the independent Review; the Review itself completes with pass.
3. `finalDrift = approvalDrift()` detects that change. `report.ok=false` and `machineSupervision.finalFailures` are correct.
4. The later attention selector checks send refusals, POST budget, machineStop, workflow completion and Review status/verdict. It never consumes that finalDrift/finalFailures fact. All other conditions may be clean, so it returns null.
5. `publishRoundResult` persists only the constructed RoundResult, not the outer machineSupervision failure. With no pendingUser attached, the saved user delivery can omit the very authorization failure that made the CLI exit nonzero.

This is a failure-projection/persistence omission, not proof of another Worker dispatch or a bypass of the POST/Task safety gate. Current existing tests cover early revocation, not this late path. Do not relabel historical 104/0 as failure or as coverage of P03-F1.

## Only proposed repair

Promote the already-computed final authorization verdict to one round-scoped fact and let the existing attention selector consume it before its clean workflow/Review branches. Preserve the actual Reviewer verdict, completed Task states and null execution identity when no specific Attempt caused the drift. Do not re-run approval checks to invent a different fact or add an approval manager.

One bounded regression in existing p02-auto-advance: revoke stage/pool only in the fake Review callback, after both Workers and their approved tests completed. Require nonzero CLI/ok=false, original Review pass, no extra execution, and matching approval-revoked material in the actual saved JSON. Retain clean case A as the positive control. This is a proposal; no test/source modification or run is authorized by this read-only closure task.

## Evidence limits and archive

Current CLI/checkpoint/result/test blobs match archived `1e3315dfb1cd84f540e96e868f8dedb318ada886`; both test files match historical raw SHA256. Other 121 production/native files checked against the preceding verified snapshot have no drift. Historic suites: 92/0 and104/0, actual exits0, outer Jobs0. This review ran none of them and does not constitute a third-party audit of Codex-authored code.

Only baseline, NEXT_TASK and this closure report are changed. Review branch `codex/p03-closure-blocked-20261019`, parent the P0-3c archive above; remote SHA/manifest and main HEAD/index preservation are verified after push. No main merge, source repair, Agent/account change, progress/audit upload or real E2E. Existing 9/26 debt and 68/100 planning estimate remain unchanged.
