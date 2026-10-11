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
OpenCode 主要负责开发，Codex 负责独立审核；OpenCode 删除冗余断言，Codex 独立复核并更新封板与上传说明，不修改实现代码。
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
| W5 | SEALED WITH P2：执行证据收口与 readiness 裁定完成；PARALLEL_WRITE 仍 CLOSED |
| W5.1 | 实现方曾报告完成；不能覆盖独立审核所指出的证据问题 |
| W5.1a | 独立审核 BLOCKED；后续修订为 W5.1b |
| W5.1b | 历史独立审核 BLOCKED；原有两个 P1 已在 W5.1c 当前路径收口 |
| W5.1c | 历史独立审核 BLOCKED；异步 EPIPE P1 已在 W5.1d 关闭 |
| W5.1d | closure PASS；observer 通道边界与冗余断言 P2 均已独立确认关闭 |
| PARALLEL_WRITE | CLOSED |
| 新后端需求 | 已整理；差距阶段尚未授权实现 |
| 前端 | 需求待讨论；开始前提醒用户 |

W5.1d 已进行最新源码、独立边界 probe、3-round 和 50-round 复核。
冗余断言 P2 已独立确认关闭；本轮执行/清理范围内无未关闭 P0/P1。
W5 封板保留下述兼容性及证据时效 P2，不代表全部 Agent 或新后端需求已验收，不开放并行写。

## 5. 当前主要差距

异构角色任务拆分、完整模型枚举与手动规则、动态费用/额度归属、
同 Agent 多模型真实隔离、模型能力证据、LAYA Skill/MCP 决策与执行核对、
端到端预算以及 token 节省对比，均未完成整体验收。
新能力不能绕过既有 Spawn Gate 或为了调度可用而放宽未知事实语义。

## 6. W5 最终证据包与上传说明

日期：2026-10-11。Codex 最终裁定：W5.1d closure PASS；**W5 SEALED WITH P2**。
封板确认现有准入/清理/观测证据与 readiness 评估完成；并行写仍未获生产授权。
PARALLEL_WRITE=CLOSED，B1–B5 未授权，全部 Agent 兼容性与新后端产品验收均不在本次封板内。

本轮实现差异仅为 `tests/w51-real-descendant-isolation.test.ts`：删除 W5.1d §2 第二个 case 中
重新按 PID 观测的冗余断言 `gone.state !== 'ALIVE'`。该断言会让 OBSERVATION_ERROR 通过并
打印“controlled target really exited”；同一 case 前面的原句柄 `EXIT_CONFIRMED` 与缓存
`EXITED` 强断言已证明退出，故直接删除而不新建观测/清理框架。
`tests/helpers/process-observer.ts` 与 `native/windows-job-launcher/src/w1fixture.c` 保留 W5.1d/W5.1c
已审核版本，本轮未再次变化。`src/**` 与生产 `w1joblauncher.c` 无改动；
runtime.run 生产调用边仍为 1，新增生产 authority 为 0。

### 6.1 证据分层（必须分开阅读，不能互相提升）

**(a) production admission case 与底层 stress 分开**

| 层 | 内容 | 证据边界 |
|---|---|---|
| production admission | TaskOrchestrator → executeTask → Runtime → replaceAdapters 测试适配器 → 真实 CliJsonlTransport → 真实 contained ManagedProcess，两个任务在各自 isolated worktree | 证明“真实生产准入链 + 适配器替换生效 + 未调用本机真实收费 Agent”，不等于真实 Agent 兼容性 |
| 底层 stress | 直接 contained root（cmd/PowerShell/git descendant、root-first、hardkill、stop-order swap、并发非干扰、50-round） | 证明 contained descendant 的停止/回收物理事实，不是完整产品验收 |

**(b) 受控失败注入与 OS 物理事实分开**

| 类别 | 内容 | 说明 |
|---|---|---|
| OS 物理事实 | 真实 cmd/PowerShell/git descendant 退出、原句柄 WAIT_OBJECT_0、root-first 后 descendant 存活、hardkill、ActiveProcesses==0 | 由真实进程与原生等待产生 |
| 受控失败注入 | cancel=false/TIMEOUT/THREW、observer.reaped=false、最终 OBSERVATION_ERROR、身份缺失/不匹配、COMMAND_CHANNEL_LOST、删除失败 | 共享 `decideCleanup` 输入回归证明失败判定/计数；源码确认实际清理将失败写入 ledger/finalizer。cancel=false + 无退出事实、删除失败另有真实 child 非零退出证据；不将所有纯输入回归描述为真实 OS 故障或 child 非零运行 |

**(c) 本轮实跑、Codex 已独立验证、历史未重跑分开**

| 来源 | 结果 |
|---|---|
| 本轮实跑（OpenCode） | `npm run typecheck` PASS；`W51_ROUNDS=3` → EXIT=0，139 passed / 0 failed，attempted=3/completed=3，stress 失败计数全 0；`git diff --check` clean。断言数由 140 降为 139 仅因删除 1 条冗余断言 |
| 本轮独立实跑（Codex 最终审核） | typecheck PASS；`W51_ROUNDS=3` EXIT=0、139/0，attempted=3/completed=3，stress 失败计数全 0；READ fan-out 121/0；resource-claim 192/0；diff check PASS；已知 suite/删除失败 child 根目录及 observer 无残留 |
| Codex 已独立验证（W5.1d 审核） | typecheck PASS；三个 observer 边界 probe（自然超时/重复终止/close 后终止）；`W51_ROUNDS=3` 与 `W51_ROUNDS=50` 均 EXIT=0、140/0；stress 计数全 0；删除失败 child status=1/signal=null；foreign sentinel 保留；diff check PASS |
| 历史未重跑 | W5.1/W5.1a/W5.1b/W5.1c 历史结论、W4 真实 Agent、其他已封板 T/W 阶段、full suite 本轮均未重跑；旧测试数量不作为本轮结果 |

**(d) fixture 不提升为真实 Agent 兼容性证据**

cmd/PowerShell/git/受控 node 与 observer fixture 只证明 OS 级 contained 行为与测试链路；
不能据此宣称 OpenCode/Codex/WorkBuddy 的模型、会话、费用或隔离兼容性。

### 6.2 已确认收口（当前路径）

- stdin/stdout/stderr error 进入 channelError；write 回调捕获异步 EPIPE，避免未处理异常退出。
- closed/lost 命令通道返回 typed failure；历史 held-handle EXITED 独立保留，
  管道失败本身不能生成 EXIT_CONFIRMED，reaped 仍确认 observer 自身退出。
- COMMAND_CHANNEL_LOST 进入既有 decideCleanup/ledger；有效 EXITED 不被改写成缺失退出证据，
  无事实仍计入 observationErrors。原停止、观测、身份及回收失败的 fail-closed 路径保留。
- 删除失败 child 与主流程仍共享 finalizeSuite；root-first、原句柄终止和对称回收未回退。

### 6.3 最终裁定、保留 P2 与适用范围

- 原冗余死亡断言 P2 已关闭；代码增量仅删除 3 行，原句柄 EXIT_CONFIRMED 与缓存 EXITED 强断言保留。
  未改变 stress 或共享清理路径，因此复用上一轮独立 50-round，不再次重复执行。
- 保留兼容性 P2：W4 的 Codex `MODEL/SERVICE_LATENCY`、WorkBuddy CN/Intl `ENVIRONMENT_BLOCKED`
  及尚未证实的真实 adapter pipeline/hardkill 范围。fixture 通过不提升这些历史状态。
- 保留证据时效 P2：本轮 READ/resource 定向回归通过，但未重新运行 full-suite parity。
  这不是默认 suite 已全绿的声明，也不能据此放开生产并行写。
- 纠正文档 259 语义：句柄 NONSIGNALED 且退出查询为 259 时才是 STILL_ACTIVE；
  WAIT_OBJECT_0 已证明进程终止时，259 可以是合法实际 DWORD 退出码，不能仅按数值拒绝。
  poll 分支先检查 WAIT_OBJECT_0；现有 final reconciliation 分支仍有 `reconciled != STILL_ACTIVE`
  过滤，可能拒绝已经 signaled 的真实 259。此为生产 launcher 的既有可用性 P2，非环境事实；
  本轮仅源码记录，未重新运行 259 probe 或修改 launcher，不宣称该分支已符合上述数值无关契约。
- W5 SEALED WITH P2 确认的是执行证据收口和 readiness 评估，不是全部 Agent 验收或生产开写许可。
  READ fan-out 仍拒绝 WRITE member，资源冲突/保护保留规则不变，runtime.run 生产边为 1，新增 authority 为 0。
- 未重跑 full suite、真实 Agent/模型调用、其他已封板 T/W 阶段；未复刻实现方全部回归数量。
- 复用既有 observer、cleanupRun、decideCleanup、finalizeSuite 与 Node Writable 能力，无新依赖。

### 6.4 上传说明

审核分支：`codex/w5-final-evidence-seal`，父提交为已上传 W5.1d 审核提交
`874075f805fa93ab267345e8f786629165b5c32c`。
本次增量仅包含一个测试文件的 3 行删除与两个审核文档；原 helper/fixture 修订沿父提交保留。
Codex 仅编辑文档，提交前核对三个测试/fixture 文件 blob hash。
使用独立临时 Git index，保留 main、共享工作树和原索引，不创建 PR、不合并 main。

依据：[Node Writable error 事件](https://nodejs.org/api/stream.html#event-error)、
[write 异步回调](https://nodejs.org/api/stream.html#writablewritechunk-encoding-callback)、
[Node EPIPE 回归](https://github.com/nodejs/node/blob/main/test/parallel/test-stdout-close-catch.js)、
[Microsoft GetExitCodeProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getexitcodeprocess)、
[Microsoft WaitForSingleObject](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject)。

历史报告已从当前树移除；备份标签和恢复说明见 [阶段分析](STAGE_ANALYSIS.md#历史备份)。
