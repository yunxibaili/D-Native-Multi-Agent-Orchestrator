# P0-1 BLOCKED — WIP development snapshot

Archived on 2026-10-16 (Asia/Shanghai) at Owner request. **NOT ACCEPTED. NOT E2E-READY. DO NOT MERGE OR RUN A PRODUCT ROUND FROM THIS SNAPSHOT.** This is preservation only, with no code fixes, new development delegation, tests, LAYA inference, product Worker or Native Review in this archival task.

Base: `e7edcd360814369f17125b91d869585067e8931f` (`codex/personal-mvp-readiness`, already published). The 18 P0-1 files are supplemented only by six required existing POST-budget/Worker-recon source/test files and five approved roadmap/reference documents from `c00e2d05c3672785a4b0cad954a3447b35096d3d`. These prerequisites are not new implementations or new stage approval. Main HEAD/index and dirty bytes are not changed. Text blobs use the existing Git text normalization; source workspace bytes are preserved locally.

## Six known blockers (remain OPEN)

1. **Missing coding contract bypass:** shared `applyVerification` checks only tasks carrying `completionContract`. Direct legitimate calls can complete `implementation`/`test` without a contract, RunResult or trusted tests; independently reproduced.
2. **Test writes escape allowedScope:** `buildCompletionEvidence` compares before-to-afterRun but omits test-command changes. A real contained exit-0 test wrote `unexpected.txt` outside allowedScope and the gate accepted; independently reproduced.
3. **Filesystem version/root validation:** >8 MiB same-size content changes can leave `manifestDigest` unchanged, and a Junction workspace root is marked safe; independently reproduced. These are completion-evidence limitations, not a replacement OS sandbox.
4. **Execution identity binding incomplete:** evidence does not bind the actual current Attempt/Session; generated `runFingerprint` is not checked at final pass. This is a source-review finding; no claim of an independently exercised full exploit.
5. **Test stop does not protect the claim:** the newly launched approved test stop result is not included in outer WRITE-claim release; prior Agent stop is insufficient proof about a later test process. Source-review finding; no dangerous live-stop-failure injection was performed.
6. **Compilation/fixture regressions:** `tests/b42-plan-file.test.ts:279` has encoding damage and an unterminated string, plus DEBUGSEQ residue; B43 fixtures are missing the new required contract. The snapshot staged diff also reports B42:755 new blank line at EOF (exit 2), deliberately preserved rather than repaired.

## Last independent verification (prior P0-1 review; NOT rerun for archiving)

| Check | Actual last result |
|---|---|
| npm run typecheck | exit 1; TS1005 / TS1002 at B42:279-280 |
| p01-completion-gate | 57 passed / 0 failed; source-copy negative control passes but does not cover the above bypasses |
| Independent contract counterexamples | four violation classes reproduced; rejecting assertions exit 1 |
| B42 plan-file | exit 1 before test body (syntax error) |
| B43 stage-material | 1 passed / 1 failed then missing-field fatal |
| Contract | 248 passed / 0 failed, 2 skipped |
| Workbench | 419 passed / 0 failed |
| CLI workflow | 182 passed / 0 failed |
| real-agent-isolation guard | 6 opt-in entries, 0 violations |
| handoff-production-round | before/after 388 passed / 26 failed; normalized failure names and main errors unchanged |

**26 pre-existing B5.1-WF failures remain open.** Their limited waiver does not cover P0-1 defects. The earlier working-tree `git diff --check=0` did not validate untracked files; the archival staged check now records the EOF issue explicitly. A green subset is not P0-1 PASS.

Two authorized OpenCode development sessions used `opencode-go/deepseek-v4.1-flash`; each ended after a native tool permission refusal, not a completed delivery. No third implementation round is authorized. P0-2/P0-3 and a fourth real E2E remain unauthorized; PARALLEL_WRITE=CLOSED, automaticPostRoundAction=NONE.

Local forensic evidence and raw before-bytes remain under the ignored `project-progress/p01-review-20261016T070858Z/`. That directory, `project-progress/audit/`, dashboards, credentials and native session exports are **not uploaded**. Historical private local evidence paths in baseline are references only, not files included here.

## Exact archived file manifest

| Path | Reason |
|---|---|
| `docs/NEXT_TASK.md` | P0-1 slice |
| `src/orchestration/completion-contract.ts` | P0-1 slice |
| `src/orchestration/completion-evidence.ts` | P0-1 slice |
| `src/orchestration/completion-gate.ts` | P0-1 slice |
| `src/orchestration/plan-file.ts` | P0-1 slice |
| `src/orchestration/workspace-manifest.ts` | P0-1 slice |
| `tests/b42-plan-file.test.ts` | P0-1 slice |
| `tests/p01-completion-gate.test.ts` | P0-1 slice |
| `docs/PROJECT_BASELINE.md` | P0-1 slice |
| `scripts/test-timed.mjs` | P0-1 slice |
| `src/cli/round-cli.ts` | P0-1 slice |
| `src/orchestration/execute.ts` | P0-1 slice |
| `src/orchestration/orchestrator.ts` | P0-1 slice |
| `src/orchestration/planner-wiring.ts` | P0-1 slice |
| `src/orchestration/planner.ts` | P0-1 slice |
| `src/orchestration/task.ts` | P0-1 slice |
| `src/orchestration/workbench-handoff.ts` | P0-1 slice |
| `src/orchestration/workbench.ts` | P0-1 slice |
| `src/decision/laya.ts` | required prior implementation/test |
| `src/orchestration/worker-execution-contract.ts` | required prior implementation/test |
| `tests/b40a-cli-workflow.test.ts` | required prior implementation/test |
| `tests/handoff-production-round.test.ts` | required prior implementation/test |
| `tests/laya-post-budget.test.ts` | required prior implementation/test |
| `tests/worker-execution-contract.test.ts` | required prior implementation/test |
| `docs/PRODUCT_DIRECTION.md` | approved route documentation |
| `docs/BACKEND_REQUIREMENTS.md` | approved route documentation |
| `docs/BACKEND_DELIVERY_PLAN.md` | approved route documentation |
| `docs/ENGINEERING_RESEARCH_REFERENCES.md` | approved route documentation |
| `docs/STAGE_ANALYSIS.md` | approved route documentation |
| `docs/P01_BLOCKED_SNAPSHOT.md` | Archive-only BLOCKED note and complete manifest |

Next: only a newly authorized, bounded P0-1 repair of these defects, followed by independent offline verification. No stage advancement or product execution is implied by this commit.
