# 唯一下一任务 — P0-4.8 批准测试证据最小投影源码映射（只读，待Owner转交）

P0-4.7静态实施与独立审核PASS，见PROJECT_BASELINE.md §7.62。P0-4.6真实E2E仍PARTIAL，所有真实调用授权保持关闭。下一步先查清现有证据出口，不新增验证系统、不直接开始编码。

## 范围

只读src/orchestration/orchestrator.ts、completion-evidence.ts、completion-gate.ts、workbench.ts、unified-review.ts、round-result.ts、src/cli/round-cli.ts及必要直接调用者。可静态读取相关已有测试了解兼容约束，不修改/运行它们。复用本地源码已足够，不重复外部检索或试模型。

已知入口：Orchestrator私有completionEvidence Map，runApprovedTest/buildCompletionEvidence，原applyVerification身份/新鲜度门，CLI的buildReviewPacket/runUnifiedReview/buildRoundResult；不要从Worker testsRun/PASS字符串或control时长推导批准测试成功。

## 一页交付，回答四项

1. 权威批准测试事实已有字段和生产者在哪里？列命令/cwd/真实code/signal/timeout/treeStop/outputDigest及身份关联（Task/Attempt/Session/lease/runFingerprint）的实际来源，缺字段如实写缺。
2. 当前是否有安全可复用的只读出口？没有则指出最小插入位置。只提出脱离内部可变引用的事实副本，不允许返回可修改的原始证明使调用者影响Verification，不新建状态/验证权威。
3. ReviewPacket和RoundResult最少各需消费什么事实，才能区分真实批准测试、Worker观察命令和缺证据？列具体文件/函数/行号，缺证据继续UNREPORTED，不伪造PASS或回填P0-4.6历史结果。
4. 建议的最小实施文件清单、兼容影响与两项承重负例（只列，不写/跑测试）。内存证据可达性和退出后能否追溯必须区分；父任务呈现、观察端UTF-8不合并扩张。

仅返回简明表格及最小改动建议；如需落盘，只允许新建project-progress/p048-test-evidence-map-20261019/report.md（ignored），不要修改audit目录、源码、测试或基线。Codex根据映射裁定实施范围并维护项目文档。

不运行测试/typecheck/CLI/模型/LAYA/Review/Round，不新增脚本，不读凭据，不改Demo/全局/安装；不commit/push/reset/clean/stash。完成READY FOR CODEX REVIEW或BLOCKED后停止，不自行启动实施。
