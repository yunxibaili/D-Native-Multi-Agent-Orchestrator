# 下一候选 — LAYA-ROUND.1 既有整链验收准备

更新日期：2026-10-15。唯一事实与证据只见 [PROJECT_BASELINE.md](PROJECT_BASELINE.md)。

## 当前已通过

LAYA-COMPAT.1代码/定向回归及捕获响应回放独立PASS；之后用户明确新增4次本地推理授权，LAYA-DECISION.2真实POST4/4通过：中文分类（multilingual）、英文分类（english）、full/lean计划选lean、具体合成pair选demo-code-agent×demo-code-model。复用真实0.3.21服务、既有provider和三个预设API，无fixture响应/worker/云模型或产品Agent执行。每次734/52/73/59ms仅单样本，语言间复杂度差异如实记录，不作准确率/性能基准。元数据revision未返回；同服务GET health确认两checkpoint实际cuda/固定revision。服务停止/Job空/owned清理通过。前轮1/4失败记录未覆盖；真实本地验收总请求5（前轮失败1+本轮成功4），与产品原生Agent累计5/5额度无关。

## 下一候选范围：先只读，不启动新调用

核对已有runRoundCli→真实provider→计划选择/具体pair→Assignment/Session/Scheduler→验收材料/Review路径，列出一次最小顺序或协作demo会发送的LAYA请求和原生Agent/内部辅助调用数量；优先复用现有入口、用户模型池与owned验收工具，不为已存在功能新增runner、manager、DAG或状态权威。
区分已分别通过的两类证据：真实free duo代表样本与真实LAYA四接口；尚未证明二者在同一完整round耦合。不把合成候选available或目录listed当真实callable/free；明确当前主链可能被unknown额度/可用性拒绝的实际位置，不删gate换取通过。先输出最小验收方案与具体阻塞，再由用户确定新增模型/费用/调用次数/数据范围；本任务准备阶段不发送POST、不启动Agent，不扩展到产品功能开发或正式前端。

## 持续边界

产品原生Agent会话仍5/5，本地4次授权本轮已用完，不自动追加或重用；温度confidence未经校准P2保留，typed接口通过非完整round/工具/动态额度/全场景接力验收。工程估算仍68/100（界面70/30是取整），不按测试数增加；PARALLEL_WRITE=CLOSED，正式前端未进入。
每任务先只读audit，完成后更新基线/受影响文档和本机进度页，精确审核上传；project-progress/cache/audit不入Git，主HEAD/shared index/其他dirty内容保持。运维/只读准备不需要启动开发worker；真正授权的产品实现继续OpenCode开发、Codex独立审核。
