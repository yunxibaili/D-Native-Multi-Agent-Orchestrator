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
OpenCode 主要负责开发，Codex 负责独立审核；本次上传归档 W5.1c 测试修订及独立审核说明，不修复实现代码。
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
| W5.1c | 独立审核 BLOCKED：observer 终止命令管道的异步 EPIPE 未处理 |
| PARALLEL_WRITE | CLOSED |
| 新后端需求 | 已整理；差距阶段尚未授权实现 |
| 前端 | 需求待讨论；开始前提醒用户 |

W5.1c 已进行最新源码、独立 3-round 与 observer 退出竞态复核。
普通路径通过不等于所有故障路径已关闭。当前 P1 及独立验证见下节；上传不等于封板或开放并行写。

## 5. 当前主要差距

异构角色任务拆分、完整模型枚举与手动规则、动态费用/额度归属、
同 Agent 多模型真实隔离、模型能力证据、LAYA Skill/MCP 决策与执行核对、
端到端预算以及 token 节省对比，均未完成整体验收。
新能力不能绕过既有 Spawn Gate 或为了调度可用而放宽未知事实语义。

## 6. W5.1c 独立审核与上传说明

日期：2026-10-11。结论：BLOCKED，W5 NOT SEALED，PARALLEL_WRITE=CLOSED。

W5.1c 已审核范围为 OpenCode 的三个测试文件修订：
`tests/w51-real-descendant-isolation.test.ts`、`tests/helpers/process-observer.ts`、
`native/windows-job-launcher/src/w1fixture.c`。`src/**` 与生产 `w1joblauncher.c` 无改动。
本次上传包括上述三个测试文件及项目基线、阶段说明，分支为 `codex/w51c-review-blocked`。
源码内容在独立审核与提交前经 blob hash 核对；当前版本仍有下述 P1，不作为可封板版本。

已确认收口：共享 cleanupRun/decideCleanup 将停止、观测及 observer 回收失败传播到实际 stress
统计与最终结果；pid-only reap 已删除，终止命令通过原 observer 所持有的进程句柄执行。
删除失败 child 与主流程共享 finalizeSuite；root-first 保持显式释放握手。

仍需关闭：

- P1：terminateAndVerify 向 child.stdin 写入 T，但只捕获同步异常，未处理 Writable 的异步 error。
  observer 已自然超时、Node 尚未处理其 exit 通知时，写管道会触发未处理的 EPIPE，
  Node 直接退出，无法保证 typed OBSERVER_LOST、共享 ledger 与 finalizer 正常完成。
- 同一边界问题：close 后 holdsIdentity 为 false，terminateAndVerify 仍可能写入 T；
  native observer 返回 WAIT_TIMEOUT 并退出后，holdsIdentity 仍为 true。须区分历史取证与当前命令通道，
  保留有效的缓存 EXITED 证据，禁止对已关闭/丢失通道发送终止命令。

Codex 本次独立执行：npm run typecheck PASS；git diff --check PASS；
W51_ROUNDS=3 EXIT=0，121 passed / 0 failed，所有打印的 stress 失败计数为 0。
实际用例覆盖了每代 held-handle 退出、root-first、hardkill、双写者停止顺序、
一侧启动失败回收、生产调用链以及同一 finalizer 删除失败传播与 foreign sentinel 保留。

最小独立 native probe：holdMs=60，ACK 后延迟 JS 退出通知处理 250ms，再调用 terminateAndVerify；
未调用 close，子进程仍因 Unhandled 'error' / write EPIPE 以 status=1 退出。
另复现 close 后请求终止的相同错误；bounded observer 返回 ALIVE 后 holdsIdentity 仍为 true。
probe 的受控 target 由独立父进程在 finally 回收；未操作其他运行的进程。
本轮已知 W5 fixture 根目录不存在，检查时 w1fixture observer 进程为 0。

新边界 probe 未通过，因此没有追加 50-round 或重复完整回归；未跑 full suite 或真实 Agent/模型调用。
实现方 50-round 与其他回归数量不作为本次独立运行结果。
后续仅做 observer 管道错误/生命周期的最小修复及同一路径回归，不重新实现清理框架。

依据：[Node Writable error 事件](https://nodejs.org/api/stream.html#event-error)
与 [write 异步回调](https://nodejs.org/api/stream.html#writablewritechunk-encoding-callback)。

历史报告已从当前树移除；备份标签和恢复说明见 [阶段分析](STAGE_ANALYSIS.md#历史备份)。
