# 唯一下一任务 — P0-4.19 P02集成假Reviewer契约迁移（待Owner授权）

P0-4.18有限离线PASS，见唯一基线§7.79：单文件补验185/0、typecheck最终0，两个contained Job final0。首次183/1和类型修正记录保留，之后未重跑suite；生产未改，真实Review/E2E仍PARTIAL。

## 归档已解除阻塞

§7.81定位：原PowerShell清理if把Get-ChildItem的-Force与普通Remove-Item放在同一启发式片段，被识别为强制删除；never审批模式因此直接拒绝整条命令。固定版源码与实际错误对应。归档阶段移除所有删除，独立owned普通清理，不改安全规则或账户；同一Git入口已成功推送094086e2f953814d19c718888d513cbe21bcf63f到codex/p0418-unified-review-offline-20261020，远端SHA及三文件manifest核对。后续文档跟进提交/临时资源清理/现场保护以archive-source-fix.json及最终记录为准。

## 唯一最小建议

仅迁移tests/p02-auto-advance.test.ts的假Codex：补extraArgs/sandbox能力，按本次--output-last-message写已有VERDICT，保留RuntimeOrch.review/RunResult身份与FakeTransport生命周期。保留A–I、批准测试与授权撤销断言，不删/skip，不放宽门禁，不改生产代码或Runner。

依据：CAPS缺extraArgs/sandbox，review只转发runtime.review(req)，VERDICT仅输出frame、未写-o。本片未运行P02，不预报失败数量；185/0不是P02集成通过。

获Owner明确测试/实施者授权后，才通过白名单Runner+offline bootstrap+外层Windows Job运行该单文件一次，保存原始流、suite/root退出码和final0。不direct node回退、不运行其他suite/全量，不调用真实Agent/LAYA/Review/Round；既有实施者例外和补验次数不自动延续，开发模型需当前费用事实。

实际90s Reviewer退出与合法verdict仍未证明；旧Round/Human Gate、9/26历史保持，不补用过期真实调用窗口。不开展新功能或前端；主HEAD/index/范围外dirty保持，不合并main。