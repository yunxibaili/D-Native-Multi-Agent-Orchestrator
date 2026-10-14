# 下一任务候选 — B2.1a 最终启动前费用声明检查

更新日期：2026-10-14
唯一事实见[PROJECT_BASELINE.md](PROJECT_BASELINE.md)。B2.1独立BLOCKED，下一片待用户下发，不自行继续第三轮产品改码。

## 只关闭一个已复现P1

当前模型池解析、候选/Assignment/reassign和tick前过期拒绝已有155条受控测试通过；不要重做。
execution gate先通过，再await工作区准备；声明若在prepare期间到期，runtime仍可启动。独立逻辑probe已复现runtime=1且启动时晚于expiry。

## 最小范围

OpenCode先读既有executeTask的gate、workspace.prepare和最终preRunTask/freeze区域，复用同一纯池谓词与既有门禁。
在最后预启动await之后、任何queued/running/lease/onStart/runtime状态提交之前检查实际将运行的pair和当前有效期；不得加新await、另造模型路由/费用平台或改T1 session/thread冻结语义。
预期允许src/orchestration/orchestrator.ts的最小接线与tests/b14-selection.test.ts的承重回归；如需另一文件先说明必要性。
回归需控制prepare期间时间推进，过期runtime/onStart/Attempt均0，拒绝理由带user-pool-expired；同时有效声明正常启动、absent旧行为和资源finally不泄漏。不得仅验证tick前过期。
Codex独立验证typecheck、155条旧覆盖+新回归、Workbench/执行生命周期/阶段/协作及diff check；不得full suite或真实模型/费用查询。

## 边界

不实现付费授权/USD硬预算/账户资格/共享额度/自动接力，不提高用户声明为真实免费事实。
PARALLEL_WRITE=CLOSED，overall未封板；进度页ignored。Codex审核、同步文档页面后上传明确状态的独立审核分支，main/index不改。
