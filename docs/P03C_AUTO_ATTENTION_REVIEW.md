# P0-3c — Automatic-mode attention and non-pass Review

Verdict: **PASS, bounded offline scope only**, 2026-10-19.

## Change

- Reuse the P0-3b attention projection, existing publication and delivery renderer. A shared local factory keeps the same no-resume/no-safety-certification contract.
- Classification/plan/Skill/MCP early failures publish `kind=pre-execution-attention`, not a fabricated full RoundResult. Unknown task/Attempt/Session/Worker stop facts stay null. Existing publication failures remain explicit.
- Final automatic-mode attention follows actual send refusal, POST-budget rejection, machine verification refusal, original decision/workflow stop or missing/non-pass Review. Original wait, tasks, identity and Reviewer verdict remain unchanged.
- Found and fixed an existing result-projection omission: Review `completed` alone is insufficient. `reject`, `rework` or missing verdict now make machine-auto `ok=false` and CLI exit nonzero. This does not trigger rework or change TaskStore/Review authority.
- No new execution edge, runtime, queue, recovery store, task state, retry, model route or resource release. `resumeSupported=false`, `stopSafetyCertified=false`; a Worker stop is not whole-round/test stop proof.

## Evidence

- Three typechecks: first exposed a nullable Review reason; second passed after that correction; third passed after the Owner authorized the test edits. No consecutive repeated failures.
- Only `tests/p02-auto-advance.test.ts` was changed/run, **one run, 104 passed / 0 failed**, actual exit 0, 2636 ms. Test SHA256 `978ff6c4220a8c39279414ab07a91b5373524fc9e6ae4c2ab9ffb6c1a7887580`.
- Existing A–F retained. Added real-file attention checks for revocation, test refusal and wait; budget 0 and mid-round 2; completed `reject` and `rework` Review results with nonzero CLI outcome. Child Review-withheld case reads saved material before cleanup and still physically exits 1.
- Worker/Reviewer/fetch are controlled seams. Approved Node tests, saved JSON and contained process exits are real local actions. Product Agent/LAYA/Native Review calls: 0. Outer validated Job `activeProcessesFinal=0`, `treeStopConfirmed=true`.
- Codex implemented and reviewed actual source/diff under the existing direct-work authorization; not an OpenCode delegation or third-party audit. Other suites and 9/26 historical failures were not run or modified. Authorization-wait draft status and initial failed typecheck are preserved in local ignored evidence.

## Limits

This does not certify all initialization failures, native account costs/permissions, whole-round stop safety, cross-process resume, P0-3 overall or the real MVP. Next: one read-only P0-3 closure mapping, without more development/tests/models; then separately authorize any real E2E.

Review branch `codex/p03c-auto-attention-20261019`; parent P0-3b `294d31cc886fa78e14eec5a06dc71a01d200edb7`. Only two production files, the authorized test, baseline, next task and this report are included. No main merge or checkout. Progress/audit/evidence and credentials remain excluded; actual remote SHA and owned-index cleanup are confirmed after push.
