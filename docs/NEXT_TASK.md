# 唯一下一任务 — P0-4.10 现有UTF-8结果出口与下一轮观察方案（只读，待Owner转交）

P0-4.9有界静态实施/独立源码审核PASS，见PROJECT_BASELINE.md §7.64；P0-4.6真实E2E仍PARTIAL。当前不授权CLI/模型/服务/测试或新Round，也不修改生产源码、Demo、账户和观察脚本。本片先复用既有结果发布，不建立第二套观察/运行框架。

## 唯一目标

为下一轮真实闭环给出可执行的最小证据留存方案，避免把PowerShell损坏的stdout当唯一机器证据；只读确认路径与源码，不实际启动执行或宣称READY。

## 优先复用与阅读范围

- src/orchestration/round-observation.ts：defaultObservationDir/defaultRoundResultPath、publishRoundResult/readRoundResult；UTF-8写入、临时文件rename、覆盖及发布失败语义。
- src/cli/round-cli.ts：发布调用、roundResultPublished的ok/path/code、Round身份以及最终stdout差异；必要时只读src/cli/round-observation.ts。
- docs/PROJECT_BASELINE.md §7.60–7.64、本机project-progress/p046-independent-review-20261019与p049-static-review-20261019；已存在的D:/workbench-demo/p04-20261019T035918Z/evidence-p046材料仅用于确认原执行方式。不要重新解析、修补或覆盖已确认损坏的round-p046.stdout.json。

## 一页回答

1. 现有最终结果文件写到哪里，如何确定实际路径、roundId和本轮归属？与完整CLI report分别包含什么，批准测试事实是否随TaskSummary写入？仅源码事实和已存材料，不把静态接线说成真实落盘成功。
2. 该路径是单个latest文件还是不可变历史？后续Round/并行既有应用是否可能覆盖？如何用已有文件复制/哈希能力在下一轮结束后留存到该轮隔离evidence目录，不修改共享配置或新建框架？操作必须先核对发布ok、匹配roundId、完成时间及必要字段；失败/失配不能借旧文件。
3. 是否无需生产修改，仅采用现有UTF-8结果文件作为结构化任务/Review/Human Gate事实，再单列真实调用预算、退出/Job清理及服务日志，即可避开stdout中文解码问题？最终RoundResult未包含的事实明确列缺，不能声称替代整个CLI report。若仍需修观察端，指出原有入口及最小差异方案，只提方案不实施、不新建脚本。
4. 给出下一次执行前唯一最小待批准范围：是否有代码缺口、准确证据路径/操作与仍需新确认的模型/费用/时限/调用上限。旧授权和过期pool不复活；不运行stage-check或刷新时间戳，不生成新digest。

已有本机源码足够时不重复联网；确有外部API问题时只列1–2个问题交Owner/Gemini，不猜参数。不要合并父任务呈现、调度、权限或历史债务。不得运行检查/测试/CLI/探针/模型/服务，不新增或改动文件、不读凭据、不做Git写操作。报告READY FOR CODEX REVIEW或BLOCKED后停止，由Codex审核并决定是否需要实施或申请新的真实执行授权。
