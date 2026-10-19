# P0-3b — Checkpoint exception attention report

Verdict: **PASS, bounded offline report projection only**, 2026-10-19.

## Implementation and review

- `src/cli/round-cli.ts`: checkpoint failures other than an explicit user stop add a detached attention memo to the existing final report. It records the real cause, displayed/current Attempt, current Session, approved stage digest, current Worker stop fact and reported retained protection task ids.
- `src/orchestration/round-result.ts`: additive optional `pendingUser` input/output and the same delivery renderer, persisted through the existing `publishRoundResult`. Per-task deliveries, per-Attempt evidence, unfinished tasks and Human Gate remain authoritative projections from their original sources.
- No new task state, persistence engine, scheduler, completion authority or execution edge. No auto-accept, restart, retry, model change or resource release.
- `resumeSupported=false` and `stopSafetyCertified=false` are explicit. A Worker stop is not proof of all approved-test or round processes stopping. This is inspection material, not a safe paused/resumable workflow. Publication failure remains visible in the existing publication result, not silently treated as saved.

## Verification

- Typecheck: one run, exit 0.
- Existing `tests/b46-workflow-checkpoint.test.ts`: one authorized offline run, **92 passed / 0 failed**, exit 0, 3817 ms.
- Test SHA256: `843a5e597b9b4e8fb3fd49ad1cfeb2a730d2ed10aa32fa0a70431c14085d3a69`.
- Real reader EOF/timeout/non-TTY/error cases run through the real CLI with controlled execution/provider seams. Tests read the actual published JSON, correlate identities, preserve delivery/unfinished facts and verify the same text renderer. An unconfirmed Worker-stop fixture remains false, makes no safety/recovery claim, and dispatches no downstream or Review.
- Outer contained Job `activeProcessesFinal=0`, `treeStopConfirmed=true`. Real product Agent/LAYA/Native Review calls: 0. Existing fake-worker assertions are not real model or Owner input evidence.
- Codex implementation and static review under Owner direct-work authorization; not an OpenCode delegation or third-party independent audit. No other suite was run. Existing 9/26 debt scope remains unchanged.

## Scope and next step

This slice covers checkpoint exceptions. Explicit user stop is not turned into pending input; successful rounds retain their old output shape. Default machine-auto failure/revocation/wait and Review outcomes are not yet unified into this memo. P0-3 overall and the real MVP remain incomplete.

Next proposed slice: P0-3c, map real automatic-mode stop reasons and reuse the report for minimal attention material, without new recovery semantics. It needs Owner authorization.

Review branch: `codex/p03b-attention-report-20261019`, parent `b900c88802e3adbaa76737887b76dc67fcbee33d`. Only this slice's two production files, one authorized test, baseline, next task and this report are included. Main is not merged or checked out; progress/audit/evidence, credentials and unrelated dirty files are excluded. Actual remote SHA verification and owned-index cleanup are reported after push.
