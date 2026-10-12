# Decision Loop 执行证据契约

更新日期：2026-10-12
状态：既有有效证据约束。完整历史设计在 Git 归档，不作为当前状态入口。
当前状态只在唯一 [PROJECT_BASELINE.md](PROJECT_BASELINE.md) 维护。

## 1. 证据链

LAYA decision → apply/dispatch → Scheduler tick → executeTask → Runtime
→ RunResult → Attempt append → DispatchExecutionRef/Receipt → Observation/Review/Result。

维持既有单一执行路径，不创建新的执行、结果或状态 authority。

## 2. 区分事实

- Requested：LAYA/用户请求了什么。
- Admitted：通过当前准入；不等于执行已经发生。
- Executed：实际启动/结果/Attempt 等事实，按具体字段定义记录。
- Applied：有效身份/fencing 下写回是否被接受。
- Verified：验收是否满足，独立于 Runtime exit=0。

准入拒绝不伪造执行。已经发生的执行不能因写回拒绝而被抹去。
启动失败、runtime.run throw、等待失败、取消、超时也必须保持真实归因和清理保护。
admitted-only 是可表达状态，不能直接视为成功或虚构 RunResult。

## 3. Attempt ↔ RunResult

DispatchExecutionRef = { attemptId, run }，在这份 RunResult 生成并 append
对应 Attempt 的位置建立关联，再随当前 receipt 传递。
taskId 可能有多个 Attempt，latest-ever-by-task 不能作为当前 Attempt 的结果证据。
禁止用 Attempt B 配 RunResult A，或拿旧 receipt 声称本次 dispatch 已执行。

Worker/session/model/thread attribution 来自同一冻结执行上下文。
Session 缺失时 Worker projection 可为 null，不能从 thread ID 猜 Session。
拒绝的请求不应出现虚假的 worker running、onStart 或执行终态钩子。

## 4. Fan-out

当前 READ fan-out 记录 requested members 与 actual executions。
请求的 Agent/Model、准入结果、拒绝原因和真实执行身份保持区分。
跳过、拒绝、依赖未满足不能沿用旧 evidence；
Review、聚合和 Observation 消费当前同一份 execution references。

### 4.1 异构任务与后续协作组证据

职责、预期交付物和允许文件范围属于 Requested；不能直接投影成已完成或已强制隔离。
上游报告与测试产物必须有 task/Attempt/同次结果来源；下游引用不能从旧 latest-by-task 拼接。
下游 brief 应消费相关交付引用或有界内容，不广播所有会话；外部内容保持不可信输入边界。
报告保留请求的 pair、实际派发 pair、Session、阻塞原因和现有验证结果；服务端实际模型未知则未知。
协作组全部 terminal 不等于验收通过；组员意见、机器测试和独立 Review 分层。
B4.0 实现时应覆盖真实 CLI/调度到受控 Runtime 的链路，而不只测试 DTO 或请求构造。
这些是新切片验收约束，不代表该闭环已经实现。

## 5. Append 与状态

AttemptStore append-only，是执行证据，不拥有 Task 状态。
迟到结果必须通过有效 Lease/fencing 检查；写回拒绝仍保留已发生事实。
声明完成、机器观察和 Review 分层，Runtime success 需经过现有 Verification。
结果摘要只派生这些事实，不新增存储/调度权威。

## 6. 停止证据

rootTerminalObserved、rootExitCode 和 treeStopConfirmed 只消费被验证的 control 事实。
INVALID control、partial lifecycle 字段或 launcher 退出不能认证终态。
root PID 的早期发现独立于 lifecycle facts。
详见 [架构契约](ARCHITECTURE_CONTRACTS.md) 与
[native launcher](../native/windows-job-launcher/README.md)。

源码入口：
../src/orchestration/dispatch-receipt.ts、
../src/orchestration/dispatch-evidence.ts、
../src/orchestration/attempt-integration.ts、
../src/orchestration/attempt-record.ts、
../src/orchestration/execute.ts、
../src/orchestration/orchestrator.ts。

状态枚举和字段含义以当前源码及对应测试为准，本轮未重跑证据封板测试。
