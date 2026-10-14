# 下一任务候选 — B5.1 模型中断的有界接力

更新日期：2026-10-14
唯一状态与证据见[PROJECT_BASELINE.md](PROJECT_BASELINE.md)。B4.6a最小同进程用户检查点已独立PASS WITH P2；本轮结束，B5.1尚未启动。

## 先查实际缺口，再委派最小切片

核对已有RuntimeEvent/RunResult错误分类、TerminalPolicy、deadline/cancel/停止确认、ExecutionOutcome、continuation/唯一reassign、Attempt与brief/handoff及fixed/model-pool。用户已要求考虑执行中模型掉线，按真实协议区分断流、限流/额度、认证、进程崩溃和未知；无输出不直接等于死亡。
选一个可以hermetic重现且值得补的场景，先证明已有边界和缺口，不一次实现全自动恢复平台。旧执行仍可能写或treeStop未确认则保留保护、拒绝第二写者；停妥后沿同Task新Attempt和现有接力链，保留已有成果，不盲重放外部副作用。fixed不能静默换pair，费用声明过期/无合格候选不能转付费。
必要外部接口/开源方法先经GitHub MCP/官方资料调查；不得凭模型品牌猜接口，不新增恢复manager/数据库/第二调度器。真实模型/费用测试另行明确授权。

## 保留范围

B4.6a不是完整自动监督/纠偏恢复，原通用未完成Review原因泛称fan-out的P2后续边界中一并收口，不因此重开全部架构。正式前端需求未确认；本机进度页只读、ignored，无法视觉核验时如实标注。
OpenCode开发、Codex独立审核；worker维持DeepSeek V4.1 Flash。PARALLEL_WRITE=CLOSED。每片更新唯一基线/受影响文档和本机数据，按用户已有授权上传审核快照，保留main/index/dirty tree。
