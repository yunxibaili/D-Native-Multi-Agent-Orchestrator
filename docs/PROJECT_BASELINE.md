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
OpenCode 主要负责开发，Codex 负责独立审核；本次上传仅同步 W5.1b 独立审核说明，不修复生产代码。
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
| W5.1a | 独立审核 BLOCKED；后续修订为 W5.1b |
| W5.1b | 独立审核 BLOCKED：stress 失败传播及 fallback 进程身份仍有 P1 |
| W5.1c | 已提供最小收口任务提示词；尚未验证完成 |
| PARALLEL_WRITE | CLOSED |
| 新后端需求 | 已整理；差距阶段尚未授权实现 |
| 前端 | 需求待讨论；开始前提醒用户 |

W5.1b 已进行最新源码与定向分支复核，不能依据实现方的 82/82 或 child ledger=9
宣称所有失败路径已关闭。当前 P1 及独立验证见下节；上传不等于封板或开放并行写。

## 5. 当前主要差距

异构角色任务拆分、完整模型枚举与手动规则、动态费用/额度归属、
同 Agent 多模型真实隔离、模型能力证据、LAYA Skill/MCP 决策与执行核对、
端到端预算以及 token 节省对比，均未完成整体验收。
新能力不能绕过既有 Spawn Gate 或为了调度可用而放宽未知事实语义。

## 6. W5.1b 独立审核与上传说明

日期：2026-10-11。结论：BLOCKED，W5 NOT SEALED，PARALLEL_WRITE=CLOSED。

W5.1b 已审核范围为 OpenCode 的三个测试文件修订：
`tests/w51-real-descendant-isolation.test.ts`、`tests/helpers/process-observer.ts`、
`native/windows-job-launcher/src/w1fixture.c`。`src/**` 与生产 `w1joblauncher.c` 无改动。
本次上传仅含项目基线和阶段说明，分支为 `codex/w51b-review-blocked`，不作为可封板版本。
上传前校验发现 fixture/helper 内容继续变化，因此未把正在修改的测试代码纳入说明提交；
这些后续修改尚未独立审核，不能据此推断 W5.1c 结论。最新代码完成复核后再单独同步。

已确认修复：client wait 到期返回 OBSERVATION_ERROR，原生 WAIT_TIMEOUT 才提供 ALIVE；
持有原进程句柄可以证明真实退出；root-first 已使用显式释放握手；生产链用例已有 finally。

仍需关闭：

- P1：stress 最终清理丢弃 cancel/reaped 结果，最终 OBSERVATION_ERROR 不计失败，
  cleanupFailures 未更新；一侧启动失败后的检查仍以非 ALIVE 作为无残留证明。
- P1：fallback 在缺少原始 held handle 时仍按旧 PID 重新打开并终止进程，
  没有证明新句柄与原身份一致；生产链 fallback 也不能把 fresh observation 冒充原身份退出证明。
- 证据缺口：删除失败 child 使用另写的固定失败结果，未经过主流程同一 finalizer。
- native reap 忽略 WaitForSingleObject 返回值，发起异步终止后直接报告成功；须区分确认退出、超时和错误。

Codex 本次独立执行：npm run typecheck PASS；git diff --check PASS。
从当前源码提取实际 stress 函数并注入受控依赖，复现 cancel=false、observer.reaped=false、
最终 OBSERVATION_ERROR 时 observationErrors/surviving/cleanupFailures 仍全零。
另对实际 reclaim 分支确认：无原始句柄也会调用按 PID 的 fallback。
这些是实际函数的分支验证，不是生产 Job containment 失效的物理复现。

原生定向 probe 确认 client timeout/原生 WAIT_TIMEOUT/held-handle EXITED 的区分；
使用本次创建的受控 sentinel 确认 reap 只需 PID 即可终止，未强行制造 PID 重用，未操作其他运行的进程。
未重跑 W5 的 3/50-round、full suite 或真实 Agent/模型调用。
实现方报告的测试数量不作为本次独立运行结果。

历史报告已从当前树移除；备份标签和恢复说明见 [阶段分析](STAGE_ANALYSIS.md#历史备份)。
