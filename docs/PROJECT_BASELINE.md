# 项目基线

更新日期：2026-10-11
范围：当前代码事实、已有封板状态和执行边界。未来需求不自动转为实现事实。

## 文档入口与优先关系

| 文档 | 管什么 |
|---|---|
| [后端需求](BACKEND_REQUIREMENTS.md) | 用户要求的目标能力和验收标准 |
| 本文 | 当前状态、既有能力及尚未实现的边界 |
| [阶段分析](STAGE_ANALYSIS.md) | 差距、依赖、建议推进顺序、历史备份 |
| [架构契约](ARCHITECTURE_CONTRACTS.md) | 当前不可绕过的身份、执行、证据和安全约束 |
| [LAYA 接口](DECISION_PROVIDER.md) | 本地结构化决策接口及失败语义 |
| [协作契约](R2_COORDINATION_CONTRACT.md) | Lease、fencing、资源和工作区 |
| [Round 语义](EXECUTION_ROUND_SEMANTICS.md) | 有界执行、配额观测和 Human Gate |
| [执行证据](DECISION_LOOP_EXECUTION_RESULT_CONTRACT.md) | Dispatch、Attempt 和结果归因 |

用户明确指令优先。需求描述目标，基线描述现状；有差距时记录差距，不静默改写已封板行为。

## 1. 定位与分工

这是运行在个人 Windows 工作站上的本机 Native Coding Agent 编排后端。
Agent 使用自身登录、模型入口和工具；内核不直接调用模型供应商 API。
OpenCode 主要负责开发，Codex 负责独立审核；本轮只有文档整理和版本归档。
正式前端需求未确认，临时观察工具不是最终前端方案。

## 2. 当前执行链

用户目标 → LAYA typed decision → 候选 DAG/校验/TaskStore → Assignment/Lease
→ Scheduler → executeTask/Spawn Gate/工作区与资源保护 → Native Runtime
→ RunResult/Attempt evidence → 统一验证与 Codex Review → Result Aggregation → Human Gate。

现有 CLI Round 到 Human Gate 停止，automaticPostRoundAction=NONE。
一次 Round 内已有有界 rework/handoff 等机制；不能外推为无限自主任务循环。

## 3. 当前可复用基础（源码检查，不是本轮重新封板）

- discover、doctor、适配器工厂和 Runtime/Transport；支持集合以代码与本机探测为准。
- 模型 registry/policy 与静态免费池；不等于动态账户额度或严格零费用保证。
- LAYA 结构化分类、Agent × Model 选择、任务级决策和 READ fan-out 选择。
- Task/DAG、Assignment、Scheduler、Lease/fencing、ResourceClaim 和 Workspace。
- SessionRegistry 与 WorkerIdentity；同 Agent 的不同模型/会话有不同 Worker 身份。
- DispatchReceipt、冻结执行上下文、Attempt、统一结果和审核/接力证据。
- Windows Job Launcher 与生产 containment/control 校验、停止与释放保护。
- Skill intent 基础和部分适配器支持；统一 Skill/MCP 发现和 LAYA 选择闭环尚未完成。
- 可选 memory 层；记忆是有来源的不可信材料，不能获得任务状态/决策权。

代码允许表达多个模型/会话，不代表每种 Agent 的真实并发隔离都已验收。
适配器中的能力 false 或 shared-only 声明不能被需求文字提升为 true。

## 4. 阶段状态

以下封板状态沿用当前会话的有效基线，本轮未重新跑完整封板测试：

| 阶段 | 状态 |
|---|---|
| T1 / T2 / T3-a / T3-M0 / T3-b | SEALED |
| W0 | CLOSED |
| W1 / W2 / W3 | SEALED |
| W4.1 | RE-SEALED |
| W4 | SEALED WITH P2 / ENVIRONMENT BLOCKERS |
| W5 | NOT SEALED |
| W5.1 | 实现方曾报告完成；不能覆盖独立审核所指出的证据问题 |
| W5.1a | 修订代码已存在；本轮只读到修订，未进行独立验收 |
| PARALLEL_WRITE | CLOSED |
| 新后端需求 | 已整理；差距阶段尚未授权实现 |
| 前端 | 需求待讨论；开始前提醒用户 |

W5 的既往四个 P1 需针对最新 W5.1a 重新核查。
不能声称旧问题仍然存在，也不能仅根据测试源码或作者注释声称已关闭。

## 5. 当前主要差距

异构角色任务拆分、完整模型枚举与手动规则、动态费用/额度归属、
同 Agent 多模型真实隔离、模型能力证据、LAYA Skill/MCP 决策与执行核对、
端到端预算以及 token 节省对比，均未完成整体验收。
新能力不能绕过既有 Spawn Gate 或为了调度可用而放宽未知事实语义。

## 6. 本轮验证范围

2026-10-11：npm run typecheck 已通过；文档整理后检查 Git 差异和当前文档链接。
未运行 full suite、W5 stress、真实 Agent/模型调用或新的封板审核。
旧文档的历史测试数量不作为本轮测试结果保留。

历史报告已从当前树移除；备份标签和恢复说明见 [阶段分析](STAGE_ANALYSIS.md#历史备份)。
