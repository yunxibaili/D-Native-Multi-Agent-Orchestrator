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

B5.1仅覆盖已有明确TRANSPORT_ERROR/session_failure的受控安全接力；真实流/额度/认证/服务故障分类和完整恢复仍后续，静默不直接判死亡。
有界重试考虑部分写入和重复工具调用；fixed 失效不自动换 pair，缺合格免费候选不转付费。

## 5. Review、结果与用户

Review 消费当前执行证据，通过统一 verification 契约给出结论。
原生普通返工与任务级 replan 不同；不能把 Review 变成第二个 Scheduler。
CLI Round 汇总报告并停止，新要求由用户发起。
Observation 与结果摘要是只读派生，不新增 ReportAuthority/ResultStore。

## 6. 有界工作流与显式用户检查点

sequential/collaborate及计划文件复用既有任务/验证/调度链，按真实依赖顺序执行。成功退出不自动等于业务验收；未交付/未验收/失败阻止下游。最终仍到Human Gate停止，无跨Round自动执行。
可显式加独立 `--checkpoint`（不接受值、仅执行工作流），在真实成员to_verify与LAYA验收之间展示同Attempt材料；`continue`仍走原验收/准入，`stop <reason>`结束后续执行/接力并保留之前的成功及实际证据。非TTY/EOF/错误/60秒超时或无效答案停止，不默认放行。无flag不读取输入，stderr控制提示不污染JSON stdout。
检查点不是任务完成、真实模型身份/费用认证、强制原地暂停或跨进程恢复；当前覆盖范围和独立证据只见唯一基线。PARALLEL_WRITE保持CLOSED。

相关入口：
[项目基线](PROJECT_BASELINE.md)、
[协作契约](R2_COORDINATION_CONTRACT.md)、
[执行证据](DECISION_LOOP_EXECUTION_RESULT_CONTRACT.md)。
历史 R1/R2 状态和测试数只在 [归档](https://github.com/yunxibaili/D-Native-Multi-Agent-Orchestrator/tree/3f2b8a8d95374f60adbf666364f7b2180cdd84dd/docs) 保留。

## 7. 已知session_failure的有界接力

旧执行cleanup.treeStopConfirmed必须明确true，false/缺失先停止接力选择与身份迁移，并保持incomplete/非零。workflow失败边界交给同一个continuation driver，同Task新Attempt/fresh Session，保留部分输出、工具观察、截断/停止事实，提示核对现状，不能盲重放副作用。Agent×Model逐字段比较、unknown保守，handoff-max绝对上限与既有原因例外/重复守卫保留；fixed/用户池/最终准入不放宽。workflow恢复任务成功仍to_verify，整轮待原验证/下游，不自动resume全workflow。Review未完成原因如实区分保留资源/停止未知/用户stop/workflow/fan-out。


## 2026-10-16 路线补充（尚未实施，不改变上述现有契约）

Owner已批准首尾确认+异常中断与确定性产物/测试验收方向。当前每步checkpoint和completeTask行为尚未改变，系统超时被记user-stop仍是待修缺陷；不能把未来策略当当前事实。最小改造复用既有Verification、同Attempt与原生Review，不新增状态/调度权威，不放宽Job/权限/费用门。准确事实见[唯一基线](PROJECT_BASELINE.md)，下一有界任务见[NEXT_TASK](NEXT_TASK.md)。
