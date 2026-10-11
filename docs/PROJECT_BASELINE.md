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
OpenCode 主要负责开发，Codex 负责独立审核；本次上传归档 W5.1d 测试修订及独立审核说明，不修复实现代码。
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
| W5.1b | 历史独立审核 BLOCKED；原有两个 P1 已在 W5.1c 当前路径收口 |
| W5.1c | 历史独立审核 BLOCKED；异步 EPIPE P1 已在 W5.1d 关闭 |
| W5.1d | 独立审核 PASS WITH P2；observer 通道边界收口，冗余退出断言仍需简化 |
| PARALLEL_WRITE | CLOSED |
| 新后端需求 | 已整理；差距阶段尚未授权实现 |
| 前端 | 需求待讨论；开始前提醒用户 |

W5.1d 已进行最新源码、独立边界 probe、3-round 和 50-round 复核。
本轮范围内无未关闭 P0/P1；独立验证及 P2 见下节。上传不等于 W5 整体封板或开放并行写。

## 5. 当前主要差距

异构角色任务拆分、完整模型枚举与手动规则、动态费用/额度归属、
同 Agent 多模型真实隔离、模型能力证据、LAYA Skill/MCP 决策与执行核对、
端到端预算以及 token 节省对比，均未完成整体验收。
新能力不能绕过既有 Spawn Gate 或为了调度可用而放宽未知事实语义。

## 6. W5.1d 独立审核与上传说明

日期：2026-10-11。结论：PASS WITH P2，仅确认 W5.1d closure；
W5 NOT SEALED，PARALLEL_WRITE=CLOSED，B1–B5 未授权。

相对上一份已上传 W5.1c 审核版本，本轮实现差异仅为
`tests/helpers/process-observer.ts` 与 `tests/w51-real-descendant-isolation.test.ts`。
`native/windows-job-launcher/src/w1fixture.c` 保留 W5.1c 已审核修改，未再次变化。
`src/**` 与生产 `w1joblauncher.c` 无改动；runtime.run 生产调用边仍为 1，新增生产 authority 为 0。
本次分支为 `codex/w51d-review-pass-with-p2`，上传两个测试文件和两个审核文档的增量，
分支累计保留原 fixture 修订。保留共享工作树和 main，不合并或覆盖 OpenCode 的本地修改。
提交前核对三个测试/fixture 文件 blob hash，避免上传未审核的新版本。

已确认收口：

- stdin/stdout/stderr error 进入 channelError；write 回调捕获异步 EPIPE，避免未处理异常退出。
- closed/lost 命令通道返回 typed failure；历史 held-handle EXITED 独立保留，
  管道失败本身不能生成 EXIT_CONFIRMED，reaped 仍确认 observer 自身退出。
- COMMAND_CHANNEL_LOST 进入既有 decideCleanup/ledger；有效 EXITED 不被改写成缺失退出证据，
  无事实仍计入 observationErrors。原停止、观测、身份及回收失败的 fail-closed 路径保留。
- 删除失败 child 与主流程仍共享 finalizeSuite；root-first、原句柄终止和对称回收未回退。

Codex 独立执行结果（不是转录实现方报告）：

| 检查 | 结果 |
|---|---|
| npm run typecheck | PASS |
| 独立自然超时 probe：holdMs=60，ACK 后阻断 JS 250ms | COMMAND_CHANNEL_LOST / ALIVE；无崩溃，target 仍存活 |
| 独立重复终止 probe | 首次 EXIT_CONFIRMED；再次 COMMAND_CHANNEL_LOST / EXITED，历史事实保留 |
| 独立 close 后终止 probe | COMMAND_CHANNEL_LOST；target 仍存活，observer reaped=true |
| W51_ROUNDS=3 | EXIT=0，140 passed / 0 failed；attempted=3，completed=3 |
| W51_ROUNDS=50 | EXIT=0，140 passed / 0 failed；attempted=50，completed=50 |
| 两次 stress 的 readiness/observation/containment/surviving/cleanup | 均为 0 |
| 删除失败注入 | child status=1，signal=null，error=undefined；foreign sentinel 保留 |
| git diff --check | PASS |

实际覆盖 cmd/PowerShell/git descendant、root-first、hardkill、双 writer stop-order swap、
一侧启动失败、生产准入链与测试 adapter 替换。fixture 不能替代真实 Agent 兼容性证据。
本轮两个已知 suite 根目录、两个已知删除失败 child 根目录均不存在；结束时 observer 为 0，
未发现归属于本轮 suite 的残留进程。独立 probe 的受控 target 均由 finally 等待退出。

P0/P1：本轮范围内无未关闭项。
P2：新增 §6 第二个 case 的冗余断言 `gone.state !== 'ALIVE'` 会让 OBSERVATION_ERROR
通过并打印“controlled target really exited”；本轮 3/50-round 都实际打印了该组合。
前面的同一原句柄 EXIT_CONFIRMED/EXITED 强断言已证明退出，因此不构成本轮 P1 或封板阻断。
最小处理为删除这个重新按 PID 观测的冗余检查，或复用既有原句柄/直接 ChildProcess 的正面退出证据；
不得把无法观测改成 EXITED。

未重跑 full suite、真实 Agent/模型调用、其他已封板 T/W 阶段；未复刻实现方全部回归数量。
W5 整体证据边界和授权仍需最终独立裁定，不新增生产开关或调度系统。
复用既有 observer、cleanupRun、decideCleanup、finalizeSuite 与 Node Writable 能力，无新依赖。
GitHub MCP 检索并读取了 Node 自身 EPIPE 回归作为参考，没有引入或复制第三方框架。

依据：[Node Writable error 事件](https://nodejs.org/api/stream.html#event-error)、
[write 异步回调](https://nodejs.org/api/stream.html#writablewritechunk-encoding-callback)、
[Node EPIPE 回归](https://github.com/nodejs/node/blob/main/test/parallel/test-stdout-close-catch.js)。

历史报告已从当前树移除；备份标签和恢复说明见 [阶段分析](STAGE_ANALYSIS.md#历史备份)。
