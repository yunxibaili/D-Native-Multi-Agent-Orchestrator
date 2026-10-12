# Execution Round 当前语义

更新日期：2026-10-12
状态：现有执行边界参考；新需求的目标能力另见 BACKEND_REQUIREMENTS.md。
阶段与授权的唯一基准是 [PROJECT_BASELINE.md](PROJECT_BASELINE.md)。

## 1. 有界执行

用户目标进入一次 Round；已有 LAYA 决策、执行、观察、证据、统一 Review 和结果汇总。
一次 Round 内的重试/返工/接力受现有预算、次数、身份和安全停止条件限制。
Human Gate 后 automaticPostRoundAction=NONE，不自动开始下一 Round。
新需求中的工作流自动推进应先利用 Round 内的依赖调度；
如需跨 Round，必须单独明确契约并获得授权。

## 2. 准入与配额观察

使用 canonical agentId，不用展示名称拼接身份。
安装、登录、模型可用性、quota 数量和免费资格是不同事实。

现有 quota policy 与 Spawn Gate 语义不能混为一谈：
registry policy 只将已知 exhausted 视为配额阻断；
Spawn Gate 对 unknown、not_fetched、not_connected 等缺失/失败事实按现有代码拒绝。
unavailable 在当前 quota 类型中表达供应商不提供剩余/重置数值，
不是自动等于额度耗尽，也不被改写为零。
具体规则以 ../src/quota/policy.ts、../src/quota/spawn-gate.ts 为准。

静态免费池不是动态额度系统。严格零新增费用是新需求，
不表示当前所有运行路径默认执行该模式，也不授权放宽 Gate。
orchestration budget units 不等于 token 或货币预算。

## 3. 执行与完成

TaskId 是逻辑身份；Runtime 的运行结果、Attempt 和 Task 终态分别记录。
一次成功 Runtime 执行不直接等于业务完成；验证结论通过既有入口应用。
admitted 不等于 executed，rootExited 不等于 workerTreeStopped。
真实执行的身份和结果来自冻结上下文与同次 evidence bundle，
不能用可变最新 Task/Session 状态重新拼接。

## 4. 停止与释放

cancel/deadline 先触发既有停止协议，等物理停止事实得到确认再安全释放。
进程树停止不可确认时不能仅凭 launcher/root 退出释放保护。
保留已有 quarantine/retention；后续是否重派由现有决策与准入链处理。
用户暂停应区分停止后续调度、协作保存检查点和取消；
现状不承诺任意进程原地暂停恢复。

执行中模型掉线恢复为后续计划：静默不直接判死亡，真实流/额度/认证/服务故障与未知分开。
有界重试考虑部分写入和重复工具调用；fixed 失效不自动换 pair，缺合格免费候选不转付费。

## 5. Review、结果与用户

Review 消费当前执行证据，通过统一 verification 契约给出结论。
原生普通返工与任务级 replan 不同；不能把 Review 变成第二个 Scheduler。
CLI Round 汇总报告并停止，新要求由用户发起。
Observation 与结果摘要是只读派生，不新增 ReportAuthority/ResultStore。

## 6. 下一工作流切片的兼容边界

B4.0 拟通过既有入口 opt-in 选择调研→实现→测试候选计划，默认入口保持兼容。
角色用现有 taskType 与必要职责标签表达；各任务独立分配具体 Agent × Model。
先按依赖顺序执行，沿已有完成/verification 条件，不私自改成功状态语义来推进下游。
前置任务失败或证据不可用时下游保持阻塞，报告真实原因；报告存在不等于业务通过。
组内 2–3 模型共建是后续切片，不改变 READ topology 或 PARALLEL_WRITE 的限制。
所有阶段仍到现有 Human Gate 停止；本轮仅更新文档，没有实现新 Round 自动循环。

相关入口：
[项目基线](PROJECT_BASELINE.md)、
[协作契约](R2_COORDINATION_CONTRACT.md)、
[执行证据](DECISION_LOOP_EXECUTION_RESULT_CONTRACT.md)。
历史 R1/R2 状态和测试数只在 [归档](STAGE_ANALYSIS.md#历史备份) 保留。
