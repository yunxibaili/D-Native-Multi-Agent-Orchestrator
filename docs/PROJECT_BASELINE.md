# 项目基线

更新日期：2026-10-12（B1.4 独立审核 BLOCKED：动态新增任务丢失 fixed 约束，见 §10.6）
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

### 5.1 B1.1 只读模型目录诊断（最小诊断切片 PASS；B1.2c 剩余 P1/P2 独立收口 PASS）

用户显式请求时，`doctor --models <agent>` 返回该 Agent 原生 CLI 列出的模型目录快照。
仅支持 **OpenCode**（`opencode models`，官方命令）；其他 Agent 明确返回 `unsupported`，
其输出格式不被套用。无新依赖、无 `shell:true`、无 MCP SDK、无通用采集框架。

B1.1a 收口（详见 §8.5）：默认执行路径改为复用生产 contained `ManagedProcess`
（Job launcher + 协同停止 + tree-stop 确认），不再使用 quota `execRunner`；
超时若无法确认进程树已停止即判 `failed`，绝不用 root exit 冒充 tree stopped。
测试改用受控 command/fixture，不依赖本机安装 OpenCode。
Codex 已独立确认这两个 P1 关闭。

B1.1b 收口（详见 §8.7）：测试清理失败（检查失败、observer 回收失败、owned 目录删除失败）
统一进入最终退出码；deadline timer 在 `finally` 释放；删除冗余 fresh-PID 断言。
Codex 本轮独立复核 PASS：上述一个 P1 与两个 P2 均关闭，B1.1 最小只读诊断切片通过。
封板仅限受控 fixture 与测试链路验证的诊断切片；未提升为真实 Agent 目录兼容性验收，详见 §8.8。
B1 整体尚未封板；本片不含选择层级、pause、付费授权、动态额度、Skill/MCP 或 LAYA 联合决策。

B1.2a 收口（2026-10-12，详见 §8.11）：上一轮 BLOCKED 的两个 P1 与一个 P2 均已在当前路径收口，
B1.2a 独立复核已确认原发现关闭，但新增默认测试隔离与清理失败传播 P1（§8.12）。

B1.2b 实现方收口报告（2026-10-12，详见 §8.13）；独立结论见 §8.14：**BLOCKED**。
默认真实 Agent 隔离 P1 与弱 PID 证据 P2 已关闭；version 套件清理失败仍可被吞掉，另有 opt-in 继承 P2。
以下保留实现方说明，不能覆盖 §8.14 的独立证据。
**P1-1**（默认测试必须 hermetic）：`b12-entry-failure-semantics` 每个 child 都显式获得本套件自写的
controlled fixture（`--version` 与 `models` 均成功），不存在省略 controlled command 的 case；
NOT_ENABLED case 显式关闭 opt-in；所有 child env 用副本。新增反证 case：OpenCode command 指向不存在
绝对路径、`APPDATA` 空目录、`PATH` 只含 node 与系统目录时，套件仍 **37/0、exit=0**。
**P1-2**（cleanup 失败进入真实退出码）：三个新套件统一沿用 `model-catalog.test.ts` 已验证 ledger，
检查失败与 owned 删除失败共同决定退出码；fallback 后成功清理也不抹去最初失败；
各新增最小独立 child 回归，断言真实 status 非零并分别检查 signal/error。
**P2**（删除弱 PID 死亡断言）：删除 `pidAlive`、resident 存活观测与轮询断言，
死亡证据只用本轮已有的生产验证 Job `terminated` 与 `activeProcessesFinal=0` 记录，
未新建 observer 或第二套死亡证明。
**P1-1**（启用后未执行不得 PASS）：入口区分 NOT_RUN / ENVIRONMENT_BLOCKED / FAIL / PASS 四种结果，
启用后未发现 OpenCode、缺 launcher、查询失败、清理失败均非零退出且不打印 PASS；
旧代码里“未发现分支提前 return”会绕过最终退出码计算，已改为统一走 `finish()`。
**P1-2**（版本探测有界）：OpenCode probe 增加自身 deadline（15s），
成功/异常/超时均在 `finally` 释放 timer，超时调用该次原始 `ManagedProcess.cancel` 并等待清理，
停止未确认不得认证成功，超时前的部分版本输出不得令 `probe.ok=true`。
**P2**（逐次关联 control 证据）：新增 `tests/helpers/b12-control-evidence.ts` 唯一判定函数，
入口与受控回归共用同一实现；version 与 models 各自按本轮创建/新增的记录关联，
记录缺失、INVALID、停止未确认即失败，任一阶段成功不能替代另一阶段。
本轮只修该 probe 与本入口，未重写其他 adapter、未新增依赖、未新建 ProcessManager/ProbeManager/authority。

B1.2c 收口（2026-10-12，详见 §8.15）：§8.14 剩余的一个清理 P1 与一个 opt-in P2 已在当前路径收口，
B1.2c 已独立确认 **PASS**（§8.16）：仅认证剩余清理 P1 与 opt-in P2 关闭，B1 整体仍 NOT SEALED。
**P1**（version 套件旧清理循环吞掉首次删除失败）：删除该套件中旧的 `tmpDirs` 删除循环、
旧结果汇总与仅依赖 `failed` 的旧退出码块，只保留唯一 cleanup ledger finalizer；
本轮 owned 目录只经统一清理路径处理，首次删除失败进入 `cleanupFailures`，
后续成功不抹去该失败，最终结果只汇总一次。
**P2**（unreachable 用例继承 ambient opt-in）：该期待 NOT_RUN 的 child 显式设 `ORCH_B12_REAL_CATALOG: '0'`，
并保留后面显式 opt-in=1 的失败对照；文案更正为实际运行对象是目录入口（`b12-opencode-model-catalog.test.ts`），
不是整个套件。

冻结事实边界（不因本片改变）：

- `listed ≠ connected ≠ callable ≠ free`。目录查询**不**写 `ModelRegistry`
  （不 `upsert` / `setAgentAvailability` / `setModelAvailability`），不改变 `assignWorker`、
  Spawn Gate、quota、预算、费用授权或用户选择；新列出的模型不会进入调度候选。
- 状态严格区分：`ok` / `empty`（成功空目录）/ `unsupported` / `failed`（非零退出、超时、
  启动失败或输出无法解析）；未采集即 `doctor` 默认不查询。非零/超时/坏输出的部分 stdout
  一律不得认证为成功目录。
- 缺真实证据的连接/可调用状态保持 UNKNOWN；目录失败只影响本次诊断，不禁用模型或整个 Agent。

仍未实现（不在本片）：项目/角色/任务选择层级、pause、付费授权、动态额度、
Skill/MCP 目录或 LAYA 联合决策，以及除 OpenCode 外 Agent 的目录枚举。B1 整体仍未实现或封板。

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

## 7. B1 只读审计独立复核

日期：2026-10-11。审计可作为缺口依据，原实现建议须收窄；B1 尚未实现或封板。
本轮 Codex 仅检查源码、官方接口及报告，不运行模型任务、不读取凭据、不修改实现。

已核实：模型种子来自配置、CLI probe hint 和 thread store，尚无完整模型目录采集；
`setModelAvailability` 在 src 中仅有定义；选择已有 preferred/explicit pair 机制，
项目/角色默认层尚未实现；Skill boolean 不是目录/授权/实际调用证明；生产未默认启用免费池限制。
bootstrap 失败有 warn 日志，并非完全静默；doctor 只遍历已注册 adapter，因此诊断行确有缺失风险。

实现建议必须修正的边界（尚未发生生产变更）：

- 目录列出不能调用 `setModelAvailability` 认证可调用。该 setter 写入 pairSpecific 与 availability，
  `effectiveAvailability` 被 assignWorker/准入读取，成功或失败写入都会改变后续分配行为。
- 目录新增项也不能自动 upsert 到调度 ModelRegistry；它会改变候选集合，且现有 family 可用性
  会传播到未持有 pair-specific fact 的条目。只读目录快照必须与准入事实分开。
- 缺少 `setModelAvailability` 生产调用者是事实，不是必须立即补调用的验收要求。
  目录、连接、单次调用成功、免费/额度是不同证据；历史成功不保证现在有权限或余额。
- SelectionMode/Scope、ConnectionState、paidAuthorized、Skill/MCP 执行授权属于后续具体切片，
  不在第一片一次性加类型或无消费者字段；不把多层解析后未被调度采用描述为选择功能已完成。
- OpenCode 原生 `models [provider]` 与 Codex 上游 `debug models` 均有官方源码依据，
  但上游命令不代表本机版本支持。MCP SDK 可作未来候选，运行于 Node 不等于本机 Windows 已验证。

建议第一片：opt-in OpenCode 模型目录诊断，复用现有 doctor 与进程能力，
返回有来源/时间/结果状态的只读快照；未采集、失败、成功空目录分开。
listed 不提升为 connected/callable/free，不写调度 registry、quota、预算或账户状态。
默认 doctor 不触发新目录请求；不新增 manager/router/authority，不引入 MCP SDK。
仅采用现有启动/超时/停止边界，不能为目录查询新增不受控的进程路径。
下一片建议不是本会话已经启动实现的事实；W5 SEALED WITH P2、PARALLEL_WRITE=CLOSED 保持不变。

复用调研：本会话 GitHub MCP 检索/读取成功；不据此推翻 OpenCode 当时不可用的环境报告。
核实了 [OpenCode CLI 模型目录](https://opencode.ai/docs/cli/#models)、
[Codex CLI debug models](https://github.com/openai/codex/blob/main/codex-rs/cli/src/main.rs) 与
[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)。
OpenAI 官方 app-server 页面已打开，但后续段落检索/特定页面请求连接失败；
本轮不据此增加 app-server 集成，也未验证本机 Codex 目录命令。

本次仅上传两份现有文档的审核增量至 `codex/b1-audit-review`，父提交为 W5 最终审核提交
`a1a499e08f27450e4ad978a4aa0fd7fb500ca361`。测试/fixture blob 与父提交相同。
未运行测试 suite；本轮无实现变更，检查 diff 与文档链接。保留 main 与共享索引。

## 8. B1.1 独立审核与上传说明

日期：2026-10-11。**上一轮结论 BLOCKED：当时两个 P1 未关闭**；现已在 §8.6 独立确认关闭。
§7 是上一轮入口审计历史，
§5.1 的实现已存在，但不能据此描述为通过审核。W5 SEALED WITH P2 不变；
PARALLEL_WRITE=CLOSED；B1 未封板；B2–B5 未授权。

### 8.1 P1：目录默认 runner 绕过 contained 进程停止契约

`collectModelCatalog` 默认调用 `quota/collector.ts` 的 `execRunner`；该 runner 使用
`execFile` 的 timeout，不经过 W2/W3 `ManagedProcess` 与 Job control 确认。
复用一个既有 runner 并不自动继承另一条 contained 启动/停止路径的保证。

Codex 独立物理 probe：临时 native 可执行文件在收到 `models` 后创建一个存活 15 秒的
native child，自身也存活 15 秒并打印部分目录；默认 collector 配置 timeout=2200ms。
在 timeout 前，两个进程均由既有 observer 获取并持有原始 handle。
约 2239ms 时 collector 返回 `failed`、models=[]，直接进程的原句柄为 `EXITED`，
但 child 的原生 `WAIT_TIMEOUT` 仍为 `ALIVE`。因此诚实的 failed 状态不等于进程树已回收。
随后仅通过持有的原始 handle 终止 child，结果 `EXIT_CONFIRMED`；root 的缓存
`EXITED` 证据保留；两个 observer 均 reaped，临时目录已删除。未运行真实 Agent。

修复应在目录真实执行路径复用既有 contained 启动、timeout、stop 和确认能力；
不重写 quota runner，不新增 manager/authority，不用 shell:true 或 PID/name 扫描清理。

### 8.2 P1：注册为 hermetic 的测试仍依赖本机 OpenCode

`tests/model-catalog.test.ts` 注入 runner，但查询前仍调用真实 `resolveCommand`；
各 collector case 未配置受控 command，doctor case 的 config.agents 也为空。
fake adapter 不会替代这次独立 discovery。

Codex 在独立 Node 子进程内暂时隐藏所有含 opencode 的 existsSync 结果，再运行原测试。
纯 parser 通过后，首个 collector case 得到 `failed`，下一条对 models[0].modelId 的访问
抛 TypeError，进程 exit=1。无本机配置或环境变量的原地修改。
该 suite 已被加入默认 timed runner，因此“机器无关”的验收未满足。
应优先使用已有 command/config seam 指向受控可执行文件，并保持 runner 注入；
不能以 skip 缺失安装、捕获 TypeError 或削弱断言代替隔离。

### 8.3 已确认的范围与实跑证据

- typecheck PASS；现有安装环境下 model-catalog **42/0**、quota **184/0**、
  assignment **235/0**、contract **246/0，2 skipped**，均为本轮 Codex 实跑。
- CLI 缺少 --models 值：独立临时 config 下 exit=2、signal=null、stdout 空、输出 usage。
- 默认 doctor 不新增目录调用、opt-in 才查询；非零/null code 丢弃部分 stdout；
  unsupported 不执行目录 runner，完整 provider/model 标识保留。
- 源码无目录写 registry/assignment/Spawn Gate 的路径；生产 runtime.run 调用边仍为 1，
  新增 authority=0。独立 registry 字节不变断言不冒充真实分配端到端证明。
- git diff --check PASS；probe.exe / w1fixture.exe 及本轮 scratch 无残留。
- 未跑 full suite、真实 opencode models、真实模型任务；未读凭据、改 Agent 配置或实现代码。

复用调研：本轮 GitHub MCP search_code 因 transport/HTTP 请求失败，不计为可用验证；
改查 [Node.js child_process 官方文档](https://nodejs.org/api/child_process.html) 与
[libuv Windows process 实现](https://github.com/libuv/libuv/blob/v1.x/src/win/process.c)。
实际 blocker 以本机原句柄/原生等待 probe 为依据，优先复用本项目已存在的 contained 能力。

### 8.4 上传范围

独立审核分支 `codex/b11-review-blocked`，父提交为
`39d9c27db14866d2f8a17bceb571105bfe51cb44`（B1 入口审计）。
上传 B1.1 的五个代码/测试/脚本文件及两份现有文档；保留实现快照以供修复，**不表示通过验收**。
主分支、共享索引与 W5 已审核三文件保持原状；不上传临时 probe、二进制、日志、凭据或新报告文件。
下一片仅建议关闭上述两个 P1，不进入 B2–B5、不开放并行写。

### 8.5 B1.1a 实现方收口报告（独立裁定见 §8.6）

日期：2026-10-11。实现方（OpenCode）仅关闭 §8.1/§8.2 两个 P1，不扩展 B1 功能。
W5 SEALED WITH P2 不变；PARALLEL_WRITE=CLOSED；B1 未封板；B2–B5 未授权。

**P1-1（contained runner）**：`collectModelCatalog` 默认执行改为复用生产 contained
`ManagedProcess`（`src/runtime/spawn.ts`），经 `LauncherSpec` + sealed Job launcher 启动；
timeout 时调用协同 `cancel()` 并要求 launcher 确认 `ActiveProcesses == 0`。
`catalogSnapshotFromRun` 把「tree stop 未确认」判为 `failed`，绝不因 root exit 或
部分 stdout 报告成功。未重写 quota runner、未新增 manager/authority、无 `shell:true`、
无 PID/name 扫描清理；quota `execRunner` 不再用于目录执行。

物理验证（受控 fixture，非注入 `code=null`）：一个 node root 用 `detached:true` 派生一个
存活后代后立即退出（root EXITED、后代 ALIVE 的 P1 形态）。默认路径 timeout=3000ms
→ 结果 `failed`、models=[]；被持有原句柄的后代在 contained 停止后为 `EXITED`，
fresh 观测非 ALIVE。另有正常 fixture：exit 0 且 Job 确认空 → 正确收集 stdout 为 `ok`。
「未确认清理必须保留失败」由 `catalogSnapshotFromRun` 的纯函数分支独立覆盖。

**P1-2（hermetic）**：测试全部经受控 command seam —— 注入 runner 的用例传
`command=process.execPath`；真实路径用例写受控 `.cmd`/`.cjs` 到 owned 临时目录；
doctor 用例的 `config.agents.opencode.command` 指向受控路径并用 fake adapter 替换全部已知 adapter。
不再依赖本机 OpenCode 是否安装；未安装机器同样通过。保留真实 discovery 失败（显式不存在
的绝对 command）返回 `failed` 的独立断言；不 skip、不捕获 TypeError、不削弱断言。

实跑证据（实现方）：`npm run typecheck` PASS；model-catalog **59/0**；quota 184/0、
assignment 235/0、contract 246/0（2 skipped）；`git diff --check` clean。
结束时 owned 临时目录、observer、后代进程与 fixture 均无残留。
`runtime.run` 生产调用边仍为 1，新增 authority=0。未跑 full suite、未调用真实 Agent/模型、
未读凭据、未改本机配置、无 Git 写操作。

上述为**受控 fixture 物理验证**与**纯函数失败注入**，须与真实 Agent 兼容性证据分开；
两个 P1 的关闭仍待独立复核。

### 8.6 B1.1a 历史独立复核：原两个 P1 关闭，当时整体 BLOCKED

日期：2026-10-11。**原 P1-1/P1-2 均已独立确认关闭**；不继续沿用旧 blocker。
本节新增的一个 P1 与两个 P2 已在 §8.8 确认关闭，以下保留当时证据。
新的 P1 是本片 containment 测试的清理失败不进入最终退出码。W5 SEALED WITH P2 不变，
PARALLEL_WRITE=CLOSED，B1 未封板，B2–B5 未授权。

#### 原 P1 的独立证据

- 本轮 typecheck PASS；model-catalog **59/0，exit=0**；quota **184/0**、assignment **235/0**、
  contract **246/0，2 skipped**，三个回归 exit 均为 0。
- 独立 Node 子进程隐藏 opencode filesystem candidates，再运行原 suite：**59/0，exit=0**。
  测试使用已有 command/config seam，原机器安装依赖反例不再成立。
- 另编译临时 native root/child fixture，走真实默认 collector，timeout=2200ms。
  超时前 root 原句柄 **EXITED**、child 原生等待 **ALIVE**；约 **2328ms** collector 返回
  `failed`、models=[]；随后 child 原句柄 **EXITED**。这不是注入 code=null，也不是根据 PID 消失猜死亡。
  两 observer 均 reaped，临时 native 源码、二进制与目录已删除；未调用真实 Agent。
- Windows 的 containmentEnabled 固定由平台决定，生产无环境 opt-out；本轮未修改该既有契约。
  非 Windows 未测试，不将本次 Windows probe 外推为跨平台证明。

#### 新 P1：清理失败可报告全绿并 exit=0

`tests/model-catalog.test.ts` 的 observer.reaped=false 只 push 到 failures，
未增加 failed；最后退出码仅看 failed。目录删除异常在内层 finally 和最终循环均被吞掉。

Codex 两个独立、仅在子进程内生效的失败注入（未改磁盘源码）：

1. 实际先回收 observer，再把回收返回值替换为 false：报告同时出现
   `59 passed, 0 failed`、`observer for pid ... did not exit`，**真实进程 exit=0**。
   这是失败传播反例，不冒充真实 OS 回收失败；实际 observer 已回收。
2. 只对本次 suite 的 owned mc-* 临时根目录注入 rmSync 失败：报告仍 **59/0、exit=0**，
   **两个 owned 目录仍存在**。审核 probe 随后仅按记录的本次 owned 绝对路径清理，剩余 0。

修复应让检查失败、observer 回收失败、owned 目录删除失败共同决定退出码；
保留原始失败，fallback 成功不能抹去失败。异常分支应先使用仍持有的原句柄回收 owned target，
再关闭 observer，不增加 PID/name 扫描或新清理框架。

#### P2：成功后 deadline timer 继续阻止进程退出

`runContainedCatalog` 的 Promise.race 创建 sleep(timeoutMs)，正常结束后未清除 timer。
独立正常 fixture 设置 timeout=6000ms：**88ms** 返回 `ok`，active resources 仍含 Timeout，
Node 到 **6014ms** 才 beforeExit。默认 timeout 为 20000ms，成功查询也会留下对应 deadline。
应按现有 session/spawn timer 清理惯例释放 timer，保持真实超时路径的停止语义。
无需新依赖；[Node 官方 timers 文档](https://nodejs.org/api/timers.html#class-timeout) 说明默认 timer 保持事件循环活跃。

#### P2：fresh-PID 不确定事实仍可通过冗余断言

新增 `fresh.state !== 'ALIVE'` 会让 OBSERVATION_ERROR 满足“no live descendant remains”。
此前同一 case 的 held-handle EXITED 强断言已通过，故该项不推翻真实 containment 证据；
最小处理是删除冗余 fresh-PID 断言及其无用调用，不放宽原句柄强断言。

#### 范围、复用与上传

本轮 GitHub MCP 只读检索已返回成功响应；Node timers 源码检索有匹配。
复用现有 ManagedProcess、observer、command/config seam 与 Node 原生 timer 即可；
未引入新实现、依赖、manager/authority。runtime.run 生产调用边仍为 1，目录不写准入事实。
git diff --check PASS；本轮 probe/observer/fixture 和 owned scratch 无残留。
未运行 full suite 或真实 Agent/模型，未读凭据、改 Agent 配置或生产实现。

审核分支 `codex/b11a-review-blocked`，父提交
`1ba50c130edd7d24975acb9e71079b3d50dcfca8`。上传目录模块、目录测试及两份现有文档的增量，
记录“原两个 P1 已关闭；新增测试清理 P1 与两个 P2 未关闭”，不表示 B1.1 验收通过。
main、共享索引及 W5 已审核文件不变；不上传临时 probes/binaries/logs 或新增报告文件。
下一片仅收口这三个 finding，不扩展 B1 功能、不进入 B2–B5、不开放并行写。

### 8.7 B1.1b 实现方收口报告（独立裁定见 §8.8）

日期：2026-10-11。实现方（OpenCode）仅收口 §8.6 的一个 P1 与两个 P2，不重审已关闭的
原两个 P1，不扩展 B1 功能。W5 SEALED WITH P2 不变；PARALLEL_WRITE=CLOSED；B1 未封板；B2–B5 未授权。

**P1（清理失败必须非零退出）**：`tests/model-catalog.test.ts` 统一失败判定 —— 检查失败、
observer 回收失败、owned 目录删除失败共同决定 `finalizeExitCode()` 与退出码。
失败分支先经**仍持有的原句柄**回收 owned target，再 `reaped()` 关闭 observer；fallback 成功不抹去原始失败。
无 PID/name 扫描、无新清理框架。

受控 child 回归（父进程断言 child 的**真实退出状态**，非仅匹配文本）：
- `MC_FAIL_CHILD=reap`：注入 observer 回收失败 → child `status=1`、`signal=null`、report 记录失败。
- `MC_FAIL_CHILD=rm`：注入 owned 目录删除失败 → child `status=1`、`signal=null`、目录残留由父进程按名清理。
两例的注入失败传播与 OS 物理事实分开报告。

**P2（deadline timer）**：`runContainedCatalog` 在 `finally` 中 `clearTimeout` 释放 deadline，
并 `unref()` 兜底（对齐 `spawn.ts` 的 `waitBounded` 惯例）；成功/超时/异常均释放，真实 timeout→cancel→确认语义不变。
独立 Node child 以 `timeoutMs=30000` 查询正常 fixture，**不调用 `process.exit()`**；实测自然提前退出（<12s 阈值内），
证明无 timer 泄漏。

**P2（冗余断言）**：删除 `fresh.state !== 'ALIVE'` 及其 `livenessNative` 调用/import；
保留 held-handle `EXITED` 强断言，未把 `OBSERVATION_ERROR` 改写为 `EXITED`。

实跑证据（实现方）：`npm run typecheck` PASS；model-catalog **68/0**；quota 184/0、
assignment 235/0、contract 246/0（2 skipped）；`git diff --check` clean。
两组负控确认承重：移除 timer 清理 → timer child 挂起（status=null、SIGTERM@20016ms）失败；
令退出码忽略 cleanupFailures → 两个 fail-child 得到 `status=0` 并失败。
结束时 owned 临时目录、observer、后代进程与 fixture 均无残留。
`runtime.run` 生产调用边仍为 1，新增 authority=0；默认 doctor 不查询；不写 registry/availability/
assignment/quota/费用事实。未跑 full suite、未调用真实 Agent/模型、未读凭据、未改本机配置、无 Git 写操作。

上述为**受控 child 物理退出状态**与**纯函数/注入失败传播**，须与真实 Agent 兼容性证据分开；
本片关闭仍待独立复核。

### 8.8 B1.1b 独立审核 PASS 与上传说明

日期：2026-10-11。**PASS：§8.6 的一个 P1 与两个 P2 均已关闭**。
B1.1 最小只读模型目录诊断切片通过；B1 整体仍未封板，真实 Agent 目录查询兼容性未验收。
W5 SEALED WITH P2 不变；PARALLEL_WRITE=CLOSED；B2–B5 未授权。本轮不自行启动下一片实现。

#### 独立验证

- typecheck PASS；正常 model-catalog **68/0、exit=0**；quota **184/0**、assignment **235/0**、
  contract **246/0、2 skipped**，全部为本轮 Codex 实跑，三个回归 exit 均为 0。
- 正常 suite 内的两个 fail child 经过同一 cleanupObservers/removeOwnedDir 与 finalizeExitCode，
  父进程核验真实非零退出、无 signal、ledger 有条目，并只删除本轮 named root。
- Codex 另在独立子进程内，将实际 reaped 成功后的返回值替换为 false，不使用内置 inject 选项。
  原 suite 的检查仍 **68/0**，但 cleanup failure 被记录，**真实进程 exit=1**。
  实际 observer 已回收；这是失败传播验证，不冒充 OS 回收失败。
- Codex 另对本次 owned mc-* 根目录的真实 rmSync 调用注入异常，不使用内置 inject 选项。
  removeOwnedDir catch 将异常记录到 cleanup ledger；父级 owned-root 检查两项失败，
  总计 **66/2、真实 exit=1**，五个 named owned 根目录仍存在。
  审核 probe 随后仅按本次记录的绝对路径删除，最终目录剩余 **0**。
- 独立正常 contained fixture 配置 **timeout=30000ms**：约 **249ms** 返回 `ok`，
  active resources 无 Timeout，约 **251ms** 自然 beforeExit；未调用 process.exit()。
  源码 finally 中 clearTimeout；Windows timeout 的 cancel/确认路径未被改写。
- fresh-PID 不确定事实通过的冗余调用/断言已删除；原句柄 EXITED 强断言保留且本轮通过。
- 默认 doctor 的目录调用仍为 0；目录不写 registry/availability/assignment/quota/费用事实；
  runtime.run 生产调用边=1，新增 authority=0。共用进程底座及 W5 已审核三文件 blob 不变。
- git diff --check PASS；本轮 owned fixture/observer/目录无残留。

正常 suite、内置 fail-child、独立异常注入与正常进程自然退出是不同证据层；
故意注入时的 exit=1 是预期失败传播，不是正常回归失败。
上一轮无 OpenCode 安装模拟与独立 native containment probe 不在本轮重复计数。
实现方负控报告保留在 §8.7，本轮未重复修改源码运行负控。

#### 上传与限制

审核分支 `codex/b11b-review-pass`，父提交
`186f103ef8d858b07763f7dc8c4777db71e889bb`。上传目录模块、目录测试和两份现有文档的四文件增量；
提交说明记录关闭证据、正常/注入退出码及封板范围。Codex 只修改文档，不接管实现修复。
main、共享索引、其他生产源码及 W5 已审核文件保持原状；不上传临时脚本、二进制、日志或凭据。
未跑 full suite、真实 Agent/模型、非 Windows 路径，未读取凭据或修改本机配置。
本轮确认小切片闭环，不将其提升为完整模型选择、费用管理或 LAYA Skill/MCP 联合决策已完成。

### 8.9 B1.2 真实 OpenCode 目录兼容性（实现方实跑，待独立复核）

以下保留实现方报告；2026-10-12 的独立结论见 §8.10。正常真实查询通过不等于入口失败语义与有界性通过。

日期：2026-10-11。新增一个**显式 opt-in** 的真实目录测试入口
`tests/b12-opencode-model-catalog.test.ts`（`ORCH_B12_REAL_CATALOG=1` 才运行；不在默认 `npm test`
清单内，已登记进 `real-agent-isolation.test.ts` 的 ownership 守卫，且守卫的自动发现已覆盖 `bN-` 入口）。
不进入 B2–B5，不开放并行写；W5 SEALED WITH P2 不变。

**本机事实（只读探测）**：解析到的真实 launcher 为 native
`%APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe`；版本 **1.18.35**；
`opencode models [provider]` 帮助确认存在（另有 `--verbose/--refresh/--pure/--log-level`）。
未使用 `--verbose`/`--refresh`。

**真实调用链**：`Orchestrator.doctor({ modelCatalog: { agentId: 'opencode' } })` →
`collectModelCatalog` → 默认 contained `ManagedProcess`（sealed Job launcher）→ 真实 OpenCode →
原生 `opencode models`。**未注入 runner、未用 fixture 替代、未用包装脚本伪造模型列表。**
只有真实 OpenCode 被允许启动；其他已注册 Agent 用既有 `replaceAdapters` seam 替换为 fake，
因此 doctor 不会 probe 真实 Codex/WorkBuddy/Cline（**测试边界**：不代表整条 doctor CLI 的全部真实 Agent 已验证）。

**快照结果**：`status=ok`、**42** 个模型、耗时约 **2068ms**；
完整 `provider/model` 标识全部保留（`bad=0`），样例 `opencode/big-pickle`、`opencode/exo-free`、
`opencode/ling-3.0-flash-fin-free`。未硬编码模型名/数量/免费集合。

**containment 证据**：本轮 owned control 记录为 `success, success`（version probe + models），
经生产验证函数 `treeStopConfirmedFrom` 确认为已停止（`ActiveProcesses==0`）；
raw 字段仅作诊断，生命周期事实只由生产验证函数认证。退出仅接受既有契约。

**隔离与副作用边界**：未添加 `--standalone`/`--pure`/环境变量（禁止凭猜测）。1.18.35 二进制含
`ServerConnection`/`standalone`/`serve`/`attach` 字符串，但实测 `opencode models` 为**单次短生命周期进程**，
运行期间与结束后均无 CLI 残留进程、无监听端口；本机另有 7 个 OpenCode **桌面应用**进程（Electron，
非 CLI 服务），本轮未读取/停止/修改。未证明“目录命令零网络/零缓存/零插件初始化”，
也未声称原生程序绝不访问认证信息（其可能使用自身已有配置）。仅查询目录，未发送推理请求。

**未启用行为**：`ORCH_B12_REAL_CATALOG` 未设时输出 `NOT_RUN (opt-in required)`，
不做 discovery、不启动 Agent、不建立 owned 目录、不写成 PASS。

**实跑证据（实现方）**：`npm run typecheck` PASS；`node tests/model-catalog.test.ts` **68/0**；
`node tests/real-agent-isolation.test.ts` ownership 守卫 PASSED（5 个 opt-in，0 违规）；
`node tests/real-agent-ownership.test.ts` **60/0**；新入口未启用 EXIT=0、启用后真实查询 **PASS（EXIT=0）**；
`git diff --check` clean。真实运行结束后 owned root/observer/CLI 进程残留 **0**，桌面应用仍为 7。

**未证明的事实**：目录列出 ≠ 已连接 ≠ 可调用 ≠ 免费；未验证任何模型实际可调用、账户额度、免费资格、
角色适配或真实推理兼容性；未跑 full suite、未调用真实模型任务、未读凭据、未改本机配置。
不将本轮完成解释为 B1 整体封板。详见 [阶段分析](STAGE_ANALYSIS.md)。

### 8.10 B1.2 独立审核 BLOCKED 与上传说明

日期：2026-10-12。**BLOCKED：两个 P1、一个 P2 待关闭**。
B1.1 最小诊断切片 PASS 不变；B1.2 正常真实目录路径已独立跑通，但新测试入口尚不能封板。
B1 整体 NOT SEALED；W5 SEALED WITH P2；PARALLEL_WRITE=CLOSED；B2–B5 未授权。

#### 独立实跑与边界

- typecheck PASS；model-catalog **68/0、exit=0**；ownership guard **5 个 opt-in、0 违规、exit=0**；
  real-agent-ownership **60/0、exit=0**；新入口未启用 **NOT_RUN、exit=0**；diff check PASS。
- 新入口真实运行一次：native OpenCode **1.18.35**，约 **2020ms**，快照 **ok、42 models、bad=0**，
  owned control 为 **success, success**，检查 **3 PASS、exit=0**。未注入目录 runner；其他 Agent probe 为 fake。
- 未调用模型推理任务、未运行 full suite、未读取凭据内容或修改本机 Agent 配置。
  本轮未重复实现方 help、端口和运行中进程采样，不能将其报告写成本轮独立实测。
- GitHub MCP 本轮代码搜索请求成功但无匹配，未作为本机 1.18.35 内部机制的证明。
  继续复用既有目录、ManagedProcess、owned context 与生产 control 验证函数，无依赖引入。

#### 当前发现

**P1-1：显式启用但没有 OpenCode，仍返回成功。**
新测试的未发现分支记录 SKIP，finish 允许 environment blocked，最终输出只检查 FAIL，
因此会打印 PASS 并退出 0。独立 load-hook 仅令 OpenCode discovery 失败：真实子进程
**status=0、signal=null**，输出 **SKIP / ENVIRONMENT_BLOCKED → PASS(assertions=1)**，没有启动真实 Agent。
另将 owned setup 的 launcher 结果置空：输出 SKIP、exit=0，没有真正查询。
最小修复：区分未启用 NOT_RUN、启用但环境阻塞、实际通过；启用后未查询不能打印 PASS，
自动验证入口应以失败退出或明确的非成功环境状态传播，保留 cleanup failure 的优先级。

**P1-2：version probe 无 deadline，新增入口并非端到端有界。**
测试直接 await doctor；doctor 先 await adapter.probe，OpenCode probe 直接 await proc.exited，
没有超时。collectModelCatalog 的 20s 计时器在此后才创建，不能覆盖 --version。
独立受控 probe 将版本进程替换为常驻 Node，沿既有 contained ManagedProcess 启动；
650ms 时仍在等待，只有审核 watchdog 调用该原始 ManagedProcess.cancel 才继续，
取消确认 true，随后测试完成并清理。650ms 是审核观察/清理时点，不是现有产品 deadline。
源码无 deadline 与常驻输入共同证明挂起路径；未声称本机真实 --version 曾挂起。
最小修复：为该 opt-in 入口提供覆盖版本与目录的真实有界执行/取消/停止确认，
单独 Promise.race 后丢弃仍运行的进程不满足要求；不必借机重写所有 adapter。

**P2-1：control 证据按任意一条成功归并，无法逐次证明。**
ownedTreeStopConfirmed 对任意成功记录置 true，其他 INVALID/缺失记录不使其失败。
独立合成 owned 目录：version 为生产验证合法 success，models 为 incomplete INVALID；
实际读取/验证函数返回 **confirmed=true、statuses=[INVALID,success]**。
这是证据归并反例，不是复现生产 catalog 将未停止进程认证成功；生产目录仍自行校验停止事实。
最小修复：明确覆盖 version 与 models 的本轮记录，逐条验证所需事实，不能用另一条成功记录替代。

#### 上传与剩余范围

审核分支 **codex/b12-review-blocked**，父提交 **098f926fb8d48ddce4a605733643a8dc6f560830**。
四文件增量：新 B1.2 测试、isolation guard 登记与发现范围、两份现有文档。
Codex 仅修改文档，未修复实现；main、共享索引及既有生产源码保持不变。
提交说明区分正常真实路径通过与入口 BLOCKED，不将上传解释为验收通过或开放后续阶段。
审核 load hook 仅在独立进程内生效，不写源码；合成 control 临时目录已删除，
受控版本进程经原 ManagedProcess 取消确认后结束；结束时 owned root/fixture/CLI 残留为 0。
既有 OpenCode 桌面应用不属于本轮资源，未停止或修改；未用进程数量证明无服务连接。
listed≠connected≠callable≠free 仍冻结，真实模型调用、额度、免费、角色与内部服务机制尚未验证。

### 8.11 B1.2a 两个 P1 与一个 P2 收口（实现方实跑，待独立复核）

以下保留实现方报告。当前独立裁定见 §8.12；本节的 hermetic 与清理失败传播声明未全部通过独立验证。

日期：2026-10-12。范围仅限上一轮 §8.10 BLOCKED 的两个 P1 与一个 P2。
不重新实现模型目录，不扩展用户选择/免费策略/Skill/MCP，不进入 B2，不自行封板 B1。

#### 修复范围与复用依据

| 文件 | 改动 | 复用依据 |
|---|---|---|
| `src/adapters/opencode.ts` | 仅版本 probe：加自身 deadline、`finally` clearTimeout、超时走原 `ManagedProcess.cancel` + `settleCleanup`、部分输出不升级为版本 | 复用 `ManagedProcess` 与 `runContainedCatalog` 既有 deadline/`finally` 模式，未新增执行框架 |
| `tests/b12-opencode-model-catalog.test.ts` | 重写失败语义与逐次 control 关联；移除“未发现分支提前 return” | 复用 `finish`、`setupOwnedTestContext`、生产 `readControlRecord`/`treeStopConfirmedFrom` |
| `tests/helpers/b12-control-evidence.ts`（新） | 唯一逐次关联判定函数，入口与回归共用 | 不新增 control registry 或第二套身份系统；raw 字段仅诊断 |
| `tests/b12-entry-failure-semantics.test.ts`（新） | 五个受控 child 回归，断言真实 status/signal/最终输出 | 沿用既有真实 child 断言方式，不测脱离入口的纯退出码函数 |
| `tests/b12-version-probe-bounded.test.ts`（新） | 常驻版本进程回归 + 正常/非零/无法解析 + timer 不阻止自然退出 | watchdog 仅兜底，触发即失败 |
| `tests/b12-control-evidence-association.test.ts`（新） | 四种 control 证据组合 + 入口共用同一判定函数 | 不私写只供测试通过的副本 |
| `scripts/test-timed.mjs` | 三个 hermetic suite 登记进默认清单 | 新入口仍 opt-in，真实执行不进默认清单 |
| `docs/PROJECT_BASELINE.md`、`docs/STAGE_ANALYSIS.md` | 仅更新现有基线/阶段文档 | 不新建报告 MD |

#### deadline 与停止确认结果（本轮实测）

- 版本探测 deadline：**15s**（`VERSION_PROBE_TIMEOUT_MS`，本 probe 自身）。
- 目录 deadline：`collectModelCatalog` 默认 **20s**，只覆盖 `opencode models`。
- 停止等待：`ManagedProcess.cancel()` 内 `CONTAINED_STOP_WAIT_MS` **35s**。
  三者范围互不相同，不可互相替代；“查询 deadline 到期”不等于“当时已确认退出”。
- 常驻版本进程回归：实现自身 deadline 触发，`cancel` 返回 true，
  launcher 记录 `launcherStatus=terminated`（`treeStopped=1`、`activeProcessesFinal=0`），
  受控 fixture 进程随后确实消失，测试自身有界结束，watchdog 未触发。

#### 本机真实 OpenCode 目录结果（本轮实跑一次）

native launcher `%APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe`，
版本 **1.18.35**，`status=ok`、**42** 个模型、约 **2.7s**、完整 `provider/model` 保留（bad=0）。
未注入目录 runner、未用 fixture 替代真实 CLI；其他 Agent probe 仍为 fake（测试边界）。
本机版本与模型数以本轮探测为准，未硬编码。

#### control 关联方式

执行前快照 owned control 目录，只认本轮新增记录；version 与 models 各自按
**自身记录的 rootPid** 关联（也可按写入时间在无 pid 时排序，但不用文件名排序——
实测随机 UUID 命名会使 models 记录排在 version 之前）。任一阶段记录缺失、INVALID 或
停止未确认即失败；两阶段不得共用同一记录。

#### 实跑证据（实现方）

`npm run typecheck` PASS。
`node tests/model-catalog.test.ts` **68/0**；
`node tests/contract.test.ts` **246/0（2 skipped）**；
`node tests/real-agent-isolation.test.ts` ownership 守卫 **5 个 opt-in、0 违规**；
`node tests/real-agent-ownership.test.ts` **60/0**；
`node tests/b12-entry-failure-semantics.test.ts` **26/0**；
`node tests/b12-version-probe-bounded.test.ts` **29/0**；
`node tests/b12-control-evidence-association.test.ts` **26/0**；
B1.2 未启用 **NOT_RUN、exit=0**；显式启用真实目录查询 **PASS、exit=0（7 断言）**；
`git diff --check` clean。
真实查询只运行一次，未重复直到偶然通过。

#### 隔离与残留

新入口仍 opt-in，未进入默认 `npm test` 的真实执行清单；三个新增 hermetic suite 进入默认清单。
未启动真实 Agent 的 hermetic 回归按既有测试组织方式登记。
未读取/删除共享 production control directory；owned launcher copy 与清理失败传播未退化。
本轮 owned root/observer/CLI 进程残留 **0**（temp 下另有本轮之前历史遗留空目录 1 个，
其中记录对应的 launcher/root pid 均已退出，无存活进程）。
既有 OpenCode 桌面应用不属于本轮资源，未停止或修改。

#### 未验证事项

目录列出 ≠ 已连接 ≠ 可调用 ≠ 免费；未验证任何模型实际可调用、账户额度、免费资格、
角色适配或真实推理兼容性；未跑 full suite、未调用真实模型任务、未读凭据、未改本机配置。
未证明“目录命令零网络/零缓存/零插件初始化”，也未声称原生程序绝不访问认证信息。
本轮受控失败传播、真实进程超时/停止事实、真实目录结果、历史独立证据必须分开阅读。
B1.2 仅标 READY FOR INDEPENDENT REVIEW；B1 整体 NOT SEALED，PARALLEL_WRITE=CLOSED，B2–B5 未授权。

### 8.12 B1.2a 独立复核：原发现关闭，新增 P1 导致 BLOCKED

日期：2026-10-12。**BLOCKED：新增两个 P1；另有一个非阻断 P2 证据问题**。
§8.10 的原两个 P1 与一个 P2 在当前路径关闭，不重复列为未关闭问题。
B1.1 最小诊断切片 PASS、W5 SEALED WITH P2 保持；B1.2 不封板，B1 整体 NOT SEALED，
PARALLEL_WRITE=CLOSED，B2–B5 未授权。

#### 独立证据

- typecheck PASS；model-catalog PASS/exit=0；contract **246/0、2 skipped、exit=0**；
  ownership guard **5 个入口、0 违规、exit=0**；ownership **60/0、exit=0**；diff check PASS。
- bounded-version **29/0、exit=0**：受控常驻版本进程触发实现自身 15s deadline，
  probe 返回失败、部分版本未提升为成功，生产验证的 Job record 为 terminated 且确认空；
  watchdog 未触发，正常版本子进程自然退出。此结果不声称真实 OpenCode 曾挂起。
- control-evidence association **26/0、exit=0**：共享判定拒绝所需记录缺失/INVALID、旧记录和多记录歧义，
  成功路径要求两条本轮记录。真实入口目前使用 write-time fallback，未提供独立观察的 stageRootPids。
- entry-failure suite 通过标准 command seam 模拟 OpenCode 不可用：**25/1、真实 exit=1、signal=null**。
  旧的缺 Agent、缺 launcher、查询失败及非零退出断言通过；唯一失败为 case 5 仍要求目录查询成功，
  证明它没有使用受控成功 fixture。本轮没有因此启动本机真实 OpenCode。
- 对 association suite 的本轮 owned b12ce-* 目录删除调用独立注入 rmSync 异常：
  **26/0、真实 exit=0、signal=null**，8 个 named owned 根目录仍存在。
  审核 probe 校验绝对路径位于本次 temp 根且名称归属本轮后，逐一删除，最终 **0**。
  这是清理失败传播反例，不冒充 containment 失效；注入仅在独立进程中生效，不修改源码。

#### 新增发现与最小修复

**P1-1：默认 hermetic suite 实际会调用真实 OpenCode，并依赖本机安装。**
`b12-entry-failure-semantics` 已进入 test-timed 默认清单，但 case 5 强制 opt-in 且不传受控 command。
entryAgentConfig 默认空配置，故该 case 使用本机原生 OpenCode；机器不可用时上述 25/1 可复现。
case 1 也继承父进程 opt-in，而不是显式关闭。最小修复：成功+清理失败 case 指向合法、受控的
version/models 成功 fixture；未启用 case 显式关闭 opt-in，其他环境状态采用 child env 副本。
禁止以 skip、依赖安装或删断言掩盖这个默认测试边界。

**P1-2：新增测试自己的 owned 目录清理异常被吞掉，仍可全绿退出。**
三个新增 hermetic suite 都在最终 tmpDirs 删除处 catch 后 best effort，最终退出码只检查 failed。
association 的独立异常注入已证明实际 false-green，留下 8 个 owned 根目录。
最小修复：让这些 suite 的删除失败进入已有检查/cleanup ledger 与最终非零退出码，
保留按明确 named owned 路径清理，不新增框架，不以审核 probe 的后续回收覆盖原始失败。

**P2：版本回归中的 PID 探测不能作原句柄退出证明。**
pidAlive 用 process.kill(pid,0)，除 EPERM 外所有错误都映射 false；另一个 child 观测把所有异常映射 false。
这些 fresh-PID 检查不满足旧冻结的身份/未知事实边界，且与文件头的 ORIGINAL handle 声明不符。
本次版本收口采用已验证的 contained Job terminated/空事实，不采信这些 PID 布尔值；
可删除冗余弱断言并更正措辞，或确需额外身份观测时复用已有 held-handle observer。

#### 上传与范围

审核分支 `codex/b12a-review-blocked`，父提交 `5d6bf571dcc25da22e051ce3a624bf37a73f89a1`。
九文件增量：OpenCode probe、默认清单、B1.2 入口、一个 helper、三个回归与两份现有文档。
Codex 只更新文档，没有接管实现修复；main、共享索引和 W5/其他生产源码保持原状。
上传记录原发现关闭及新增阻塞，不代表 B1.2 封板；真实目录 7 PASS 为实现方报告，本轮未重复查询。
未跑 full suite、模型推理、DSH 适配或 ClawChat 集成，未读取凭据或修改本机配置。
结束时本轮 fixture/observer/CLI 无残留；历史目录 `w44-INgj3j` 保留，未按旧 PID 推断其进程身份。
本次仍是 OpenCode 诊断收口，不能据此声称 DSH 已接入编排后端。

### 8.13 B1.2b hermetic 测试与清理退出收口（实现方实跑，待独立复核）

日期：2026-10-12。范围仅限 §8.12 新增的两个 P1 与一个非阻断 P2。
不修改 `src/**`、`native/**`、production containment/launcher、模型目录业务逻辑、调度、费用、额度或用户选择。
不新增通用清理框架、manager、authority 或依赖；不实现 DSH adapter、ClawChat 集成或 RTK 接入；不进入前端。

#### 修改文件与复用依据

| 文件 | 改动 | 复用依据 |
|---|---|---|
| `tests/b12-entry-failure-semantics.test.ts` | case 5 改为受控成功 fixture；case 1 显式关闭 opt-in；全部 child env 用副本；新增 hermeticity 反证 case；新增清理失败 child 回归；owned/report 删除进入 ledger | 复用既有 `agents.opencode.command` seam、`ORCH_W4H_FAIL_ROOT_RM`/`ORCH_W4H_REPORT` 注入 seam、`model-catalog.test.ts` 的 ledger 与 `MC_FAIL_CHILD` 模式 |
| `tests/b12-version-probe-bounded.test.ts` | 删除 PID 死亡断言与 `pidAlive`/resident 存活观测；owned 删除进入 ledger；新增清理失败 child 回归 | 死亡证据改用本轮已有的生产验证 Job `terminated`/空记录，不新建 observer 或第二套死亡证明 |
| `tests/b12-control-evidence-association.test.ts` | owned 删除进入 ledger；新增清理失败 child 回归 | 同上 ledger 模式 |
| `docs/PROJECT_BASELINE.md`、`docs/STAGE_ANALYSIS.md` | 仅更新现有文档 | 不新建报告 MD |

#### P1-1（默认测试必须 hermetic）证据

`b12-entry-failure-semantics` 已进入默认清单，但原 case 5 启用入口却不指定 controlled command，
会查询本机安装的 OpenCode；case 1 也继承父进程 opt-in。现已：

- 每个 child 都显式获得本套件自写的 fixture 命令（`--version` 与 `models` 均返回符合现有契约的结果），
  不存在省略 controlled command 的 case，因此不会 fallback 到真实 Agent；
- case 1 显式设 `ORCH_B12_REAL_CATALOG: '0'`，不依赖外部环境恰好未设置；
- 所有 child env 均为副本，`process.env` 不被原地修改；
- 新增反证 case：把 OpenCode command 指向明确不存在的绝对路径、`APPDATA` 指向空目录、
  `PATH` 重建为只含 node 与 Windows 系统目录——此时本机 OpenCode 完全不可达，套件仍 **37 passed / 0 failed / exit=0**；
  同一环境下显式启用则非零退出且不打印 PASS。
- case 5 保留“查询成功后 owned root 删除失败导致非零退出”的原始验收目的，并新增断言证明成功来自
  fixture（`version=9.9.9-fixture`、`fixture/one-model`），不是真实 Agent。
未使用 skip、未降低断言、未放宽成功条件。

#### P1-2（cleanup 失败必须进入真实退出码）证据

三个新套件原来都在最终 `tmpDirs` 删除处 best effort，最终退出码只取决于检查失败数。
现统一沿用 `model-catalog.test.ts` 已验证模式：

- `cleanupFailures` 独立 ledger；`finalizeExitCode()` 同时考虑检查失败与清理失败；
- `removeOwnedDir()` 对删除抛错与删除后仍存在都记录失败；fallback 成功后不抹去已记录的失败；
- 本轮明确创建的 report 文件同样删除并验证，失败也记录
  （entry-failure 套件的 `reportFiles` 列表；另两个套件本轮不创建 report 文件）；
- 只清理本轮记录的 owned 路径，并校验路径边界（父进程断言 child root 位于本轮 temp 前缀下）；
- 不扫描/终止其他进程，不清理历史或 foreign 目录；
- 每个套件都新增最小独立 child 回归：注入 owned 删除失败，断言真实 status 非零，
  分别检查 `signal`/`error`，父进程最终清理 child 明确报告的 owned 路径。

#### P2（删除弱 PID 死亡断言）证据

`b12-version-probe-bounded` 原有 `pidAlive()` 用 `process.kill(pid, 0)`，
除 EPERM 外所有错误都映射为已死，且 recycled pid 会误判为存活，两个方向都不是死亡事实。
已删除该 helper、resident 存活观测字段与轮询断言；保留：
deadline 确实触发、probe 返回失败、部分 version 不被接受、tree stop 已确认、
Job 最终为空（`activeProcessesFinal` 全为 0）、child 未被外层 watchdog 杀掉。
未为此新建 observer 或另一套死亡证明。

#### 实跑证据（实现方）

`npm run typecheck` PASS。
`node tests/b12-entry-failure-semantics.test.ts` **37/0、exit=0**；
`node tests/b12-version-probe-bounded.test.ts` **35/0、exit=0**；
`node tests/b12-control-evidence-association.test.ts` **32/0、exit=0**；
`node tests/model-catalog.test.ts` **68/0、exit=0**；
`node tests/real-agent-isolation.test.ts` 守卫 **5 个 opt-in、0 违规、exit=0**；
`node tests/real-agent-ownership.test.ts` **60/0、exit=0**；
`git diff --check` clean、exit=0。
OpenCode 完全不可达环境下，上述三个 hermetic 套件加 model-catalog 与 ownership 守卫均 **exit=0**。
未跑 full suite，未启用真实 Agent opt-in，未调用真实模型、未读凭据、未安装依赖、未改本机 Agent 配置。

#### 负控结果

把 `finalizeExitCode()` 临时改为忽略 cleanup 失败（三份副本，未改工作树），
三个套件分别 **36/1、34/1、31/1**，唯一失败均为 `cleanup-failure child: exits NON-ZERO - status=0`，
真实 exit=1。证明该回归确实能发现缺陷。负控文件已在验证后删除，工作树无残留。

#### 本轮残留

b12* 临时目录 **0**、b12ef report 文件 **0**、opencode CLI 进程 **0**。
`%TEMP%\orchestrator-real-agent\w44-INgj3j` 为历史遗留（12:43，早于本轮），
其中记录对应的 4 个 launcher/root pid 均已退出，无存活进程；未按枚举删除。

#### 未验证事实

本机 DSH 版本与实际 headless 协议、每任务模型选择、会话恢复与隔离、cancel/deadline 与 contained 进程停止、
终态事件与退出码失败传播一致性，均未验证；本轮未实现这些能力。
B1.2 标 **READY FOR CODEX INDEPENDENT REVIEW**；B1 整体 NOT SEALED，PARALLEL_WRITE=CLOSED，B2–B5 未授权。


### 8.14 B1.2b 独立复核：清理 P1 未关闭（BLOCKED）

日期：2026-10-12。范围仅为三个测试的两个 P1 与一个 P2 收口；未修改实现。
B1.1 最小诊断切片 PASS、W5 SEALED WITH P2 保持；B1 整体 NOT SEALED，
PARALLEL_WRITE=CLOSED，B2–B5 未授权。DSH 仅为开发工具，本轮没有产品 DSH adapter。

**已关闭**：case 5 明确使用 controlled command，成功来源断言为 fixture version/model，
默认执行不再依赖本机真实 OpenCode；弱 fresh-PID 死亡断言已删除，保留生产验证 Job 停止及空 Job 事实。
entry 与 association 主清理循环已接入 cleanup ledger，不能把 version 的遗漏扩大为三者均未修复。

**P1：version 套件仍保留旧吞错清理循环**。
文件 tests/b12-version-probe-bounded.test.ts:452–458 先逐个 rmSync、catch best effort、打印 29/0，
然后才运行新增回归及 :493 的 removeOwnedDir 清理。首次删除失败被吞掉，后续删除成功后
cleanupFailures 仍为空，最终退出 0。最小修复是删除旧清理/旧汇总/旧退出码块，保留唯一 ledger finalizer。
独立 probe 未修改源文件，仅在隔离 Node 中拦截本套件直接创建的 b12vp owned 根目录第一次 rmSync：
3 次实际调用被注入异常；第二轮删除成功；真实 status=0、signal=null、error=null，最终 35/0、
exitCode=0，remaining=[]。这直接反证“fallback 成功仍保留首次失败”。现有注入 child 只调用新 helper，
负控只修改 finalizeExitCode，二者都不能覆盖此前的旧吞错循环。

**P2：新增 unreachable 用例继承 ambient opt-in**。
文件 tests/b12-entry-failure-semantics.test.ts:461 的 childEnv 未指定 ORCH_B12_REAL_CATALOG，
实际运行的是 ENTRY，并不是整个套件。外部 opt-in=1 时该 child 被启用，missing command 导致非零，
与用例期待 exit=0 冲突。独立 child 环境副本设置 opt-in=1、明确不存在 command、空 APPDATA、
仅 Node/Windows 的 PATH，实际 35/2、status=1、signal=null、error=null。
没有启动真实 Agent。最小修复是该 NOT_RUN 用例显式 opt-in=0，并将“整套套件通过”的措辞
改为实际验证内容；如保留整套不可达证据，应在外层有界 child 运行整个套件，避免递归。

**本轮独立常规验证**（全部真实 exit=0）：typecheck；entry 37/0；version 35/0（此前还打印一次 29/0）；
association 32/0；model-catalog 68/0；real-agent-isolation 5 opt-in/0 违规；ownership 60/0；git diff --check。
常规通过不覆盖上述两个独立边界 probe。未重复实现方负控副本，未重复真实 OpenCode models，
未跑 full suite、未调用模型、未读取凭据、未安装依赖或修改本机 Agent 配置。

残留只读检查：b12 owned 临时目录及 b12ef report 文件为 0；w1fixture/w1joblauncher/受控 b12 Node
及 OpenCode CLI 查询无匹配。历史 w44-INgj3j 不作本轮所有权或退出证据，也未删除。
PID 列表仅用于残留观察，不提升为 held-handle 死亡证明。

**上传说明**：依用户既有授权上传 BLOCKED 审核快照，分支 codex/b12b-review-blocked，
父快照 5d43b191956186a3d8c876338ef4ff3598c120b7；仅包含三个测试及两份既有文档的五文件增量。
不上传凭据或机器配置；不创建 PR、不合并 main、不开放并行写。采用隔离 Git index 生成提交，
当前 main/HEAD/共享索引保持不变。Codex 仅修改上述两份文档，没有修复测试或生产代码。

结论：BLOCKED。P0 无；P1 一个（清理失败传播未闭合）；P2 一个（ambient opt-in）；P3 无新增。

### 8.15 B1.2c 清理 finalizer 与 opt-in 显式化收口（实现方实跑，待独立复核）

日期：2026-10-12。范围仅限 §8.14 剩余的一个 P1 与一个 P2。
不改 `src/**`、`native/**`、helper、`scripts/test-timed.mjs`，也不改已通过的 association/model-catalog 实现。
不新增报告 MD、依赖、框架或产品配置；不实现 DSH adapter、ClawChat、RTK 或前端。

#### 修改文件

| 文件 | 改动 |
|---|---|
| `tests/b12-version-probe-bounded.test.ts` | 删除旧 `tmpDirs` 删除循环、旧结果汇总与仅依赖 `failed` 的旧退出码块（原约 451–458 行）；只保留唯一 cleanup ledger finalizer |
| `tests/b12-entry-failure-semantics.test.ts` | unreachable 用例显式设 `ORCH_B12_REAL_CATALOG: '0'`；保留显式 opt-in=1 失败对照；文案更正为目录入口而非整个套件 |
| `docs/PROJECT_BASELINE.md`、`docs/STAGE_ANALYSIS.md` | 仅更新现有文档 |

#### P1：删除旧的重复 finalizer

修改位置：`tests/b12-version-probe-bounded.test.ts`（删除原约 451–458 行）。
修复前该文件同时存在：旧 `for (const d of tmpDirs) { try { rmSync(...) } catch { best effort } }` +
旧汇总 + `process.exitCode = failed === 0 ? 0 : 1`，位于新增 ledger finalizer 之前。
旧循环先把 owned 目录删成功，后面的 `removeOwnedDir` 再次调用自然成功，`cleanupFailures` 仍为空，最终 exit 0。
修复后只保留一个 `for (const d of tmpDirs) removeOwnedDir(d)`、一个汇总、一个 `finalizeExitCode()`。

**边界 A 独立注入（真实套件主清理路径）**：未修改工作树，仅在隔离 Node 中用 `--require` 标注
`fs.rmSync`，对本套件直接创建的 `b12vp-` owned 目录（排除 `b12vp-failchild-`）第一次调用抛 EBUSY，
后续放行；hook 只加载在顶层 suite 进程，其 spawn 的 child 不受影响。

- 注入目标：`C:\Users\Admin\AppData\Local\Temp\b12vp-I1TS52`（本轮 `mkdtempSync` 创建）。
- 真实结果：**35 passed / 0 failed**，但 `exit=1`；`signal`/`error` 不适用（suite 自身非零退出）。
- ledger 保留原始失败：`owned dir removal threw for …b12vp-I1TS52: injected: first owned removal failed (EBUSY)`。
- 仅本轮已记录的路径被处理：该路径由 `removeOwnedDir` 记录后保留；其余 owned 目录后续删除成功。
- probe 结束后仅清理本轮记录的该路径，未按枚举删除。

#### P2：明确关闭 NOT_RUN child 的 opt-in

修改位置：`tests/b12-entry-failure-semantics.test.ts` unreachable 用例。
该 child 运行的是**目录入口** `tests/b12-opencode-model-catalog.test.ts`，不是整个套件；
修改前未指定 opt-in，外部 `ORCH_B12_REAL_CATALOG=1` 时该 child 被启用，missing command 导致非零，与期待 exit=0 冲突。
现显式 `ORCH_B12_REAL_CATALOG: '0'`，环境仍为 `childEnv()` 副本；保留后面显式 opt-in=1 的失败对照；
检查名与注释改为“目录入口（ENTRY）”，不再写成整套套件在不可达环境通过。

**边界 B 独立验证（ambient opt-in）**：以 child env 副本运行整个 entry-failure 套件，
外部设 `ORCH_B12_REAL_CATALOG=1`、`ORCH_B12_OPENCODE_COMMAND` 指向明确不存在的绝对路径、
`APPDATA` 指向本轮空目录、`PATH` 仅保留 Node 与 Windows 系统目录：

- 修复后整个套件 **38 passed / 0 failed / exit=0**（修复前可复现 35/2、exit=1）。
- 同环境下显式 opt-in=1 的入口对照仍非零：直接运行目录入口得 `FAIL (assertions=1) exit=1`；
  opt-in=0 同环境得 `NOT_RUN … exit=0`。
- 未启动真实 Agent（command 明确不存在，discovery 直接失败）。

#### 常规验证（本轮实跑）

`npm run typecheck` PASS。
`node tests/b12-entry-failure-semantics.test.ts` **38/0、exit=0**；
`node tests/b12-version-probe-bounded.test.ts` **35/0、exit=0**；
`node tests/b12-control-evidence-association.test.ts` **32/0、exit=0**；
`node tests/real-agent-isolation.test.ts` 守卫 **5 个 opt-in、0 违规、exit=0**；
`git diff --check` clean、exit=0。
未跑 full suite，未调用真实 Agent/模型，未读凭据，未安装依赖，未改本机 Agent 配置。

#### 本轮残留

b12 owned 临时目录 **0**、b12 report 文件 **0**、opencode CLI 进程 **0**、临时 probe 目录 **0**。
边界 A 注入遗留的 `b12vp-I1TS52` 由 probe 自身按记录的路径清理，未按枚举删除。
历史 `w44-INgj3j` 不作本轮所有权或退出证据，也未删除；PID 列表仅用于残留观察。

#### 尚未验证事项

本机 DSH 版本与实际 headless 协议、每任务模型选择、会话恢复与隔离、cancel/deadline 与 contained 进程停止、
终态事件与退出码失败传播一致性，均未验证；本轮未实现这些能力。
B1.2 标 **READY FOR CODEX INDEPENDENT REVIEW**；B1 整体 NOT SEALED，PARALLEL_WRITE=CLOSED，B2–B5 未授权。


### 8.16 B1.2c 独立收口 PASS 与上传说明

日期：2026-10-12。仅复核 §8.14 剩余的清理 P1 与 opt-in P2，结论 **PASS**。
B1 整体仍 NOT SEALED、W5 SEALED WITH P2、PARALLEL_WRITE=CLOSED、B2–B5 未授权。
未把测试收口升级为所有 Agent/模型可调用、免费额度或 DSH 产品适配的证明。

范围与源码：相对审核快照 645e5b536de1b0499d0d50d251710c0b7412a42e，
仅两个测试与两份既有文档变化；src/**、native/**、helper、association/model-catalog 套件、
scripts/test-timed.mjs 均保持上一快照。version 旧吞错清理/旧汇总/旧退出码块确实删除，
只保留一处 tmpDirs 清理、一处最终汇总与 finalizeExitCode。entry 的 NOT_RUN child 显式 opt-in=0，
保留 opt-in=1 失败对照，措辞已区分实际目录 ENTRY 与整个 suite。

**独立边界 A**：未修改源码，在隔离 Node 中拦截真实 version 套件主流程创建的 b12vp 目录
首次 rmSync，仅匹配本轮直接位于 tmpdir 的 owned 路径，排除 failchild 路径，子进程不加载拦截器。
三个 owned 根目录第一次删除均抛 INDEPENDENT_FIRST_REMOVAL_FAILED；实际检查 35/0，
cleanup ledger 保留三个原始失败；真实 status=1、signal=null、error=null。
probe 根据自身记录、核验路径边界后重试清理三个目录，remaining 3→0，exitCode 仍为 1。
原始失败未被后续成功清理抹去，且最终检查汇总只出现一次。不是只调用注入 helper 的证明。

**独立边界 B**：child env 副本设 ambient opt-in=1、明确不存在的绝对 command、
本轮空 APPDATA、仅 Node/Windows 系统 PATH，实际运行整个 entry-failure suite：
38/0、status=0、signal=null、error=null。同环境直接运行目录 ENTRY，
opt-in=1 为 FAIL/assertions=1、status=1；opt-in=0 为 NOT_RUN、status=0；signal/error 均 null。
未启动真实 Agent，未原地修改父环境变量。

**本轮独立常规验证**：typecheck PASS；entry 38/0；version 35/0；association 32/0；
real-agent-isolation 守卫 5 opt-in/0 违规；git diff --check PASS，实际 exit 均 0。
model-catalog 68/0、ownership 60/0 为上一轮独立结果，本轮未重跑；真实目录结果为历史证据，
本轮未重复。未跑 full suite、真实 Agent/模型任务、DSH/ClawChat 集成；未读凭据、装依赖或改本机配置。

本轮 b12 临时目录/report 无残留，受控 Node、launcher、fixture 与 OpenCode CLI 未发现残留。
只读列表中的 OpenCode 桌面应用属于用户运行的 foreign 进程，未清理、不作为本轮 owned 对象。
历史 w44-INgj3j 未触碰；PID 残留观察不提升为原始 handle 死亡证明。

**上传说明**：沿用用户既有上传授权，四文件 PASS 增量快照分支 codex/b12c-review-pass，
父提交 645e5b536de1b0499d0d50d251710c0b7412a42e。仅两个测试与两份文档，
Codex 本轮只更新文档、未修改测试实现。隔离 Git index 生成提交；不 checkout/合并 main，
不改变共享索引、不创建 PR；不上传凭据、机器配置、临时 probe 或报告文件。

本次审核范围无未关闭 P0/P1/P2，P3 无新增。B1.2c closure PASS；B1 整体不封板、不开放并行写。

## 9. DSH 基础接入与两层任务分配复用映射（实现方实跑，待独立复核）

日期：2026-10-12。B1.2c closure 独立 PASS 不变；B1 整体 NOT SEALED；W5 SEALED WITH P2；
PARALLEL_WRITE=CLOSED；B2–B5 未授权。本轮把用户确认的两层任务分配写入需求/阶段文档，
并完成 DSH 最小 headless 接入切片；不实现完整 B3/B4。

### 9.1 交接状态

工作树含 DSH 接入（`src/adapters/dsh.ts` 及 `adapters/index.ts` / `runtime/discover.ts` 的注册）
与 B1.2c 收口改动。DSH 写入已停止（本轮开始时 >30 分钟无写入），本轮在其基础上完成最小切片与验证，
**未重新生成第二份 adapter，未同时修改相同文件**。

### 9.2 本机协议（已核实，非猜测）

- 安装 `@deepseek-ai/dsh@0.1.5-rc.2`；launcher 解析为 **`cmd-wrapper`**（`%APPDATA%\npm\dsh.CMD`），
  contained `--version` 探测返回 `0.1.5-rc.2`。
- 一次性入口 `dsh --profile headless "<task>"`（`dsh-headless` bundle，无 Host/HTTP/浏览器层）。
- 由**安装包** `lib/index.js` / `lib/startup.js` / README 核实：任务为**位置参数**并按空格连接；
  **stdout 为最终回答**；**stderr 为 `dsh: reasoning:` 下的推理**，失败为 `dsh: <code>: <message>`
  （直接驱动失败为 `dsh: <message>`）；退出码 `reason.kind === 'completed' ? 0 : 1`；
  native `session-<uuid>` **不打印**；本版本**无 `--json`**、**无逐请求模型参数**（模型取自 `agentDefaultModel`）。
- 未据上游 dev 文档硬写本机不存在的参数。

### 9.3 已实现能力（最小切片）与如实限制

新建一次 headless 执行、`cwd`、与真实协议一致的输出映射（stdout→最终回答；stderr→推理/错误诊断）、
正常/非零/启动失败、cancel/deadline、**启动前拒绝**不支持选项
（`model`/`role`/`sandbox`/`threadId`/`extraArgs`/`review`/前导 `-` 的任务）。
capabilities 如实：`resume`/`review`/`modelSelection`/`roleSelection`/`sandbox`/`extraArgs`/
`skills`/`steering`/`worktree`/`fork`/`stdinPrompt` 均为 **false**；`workspaceModes: ['shared']`（隔离未验证，fail-closed）。
无 native sessionId → `threadId` 保持 `null`；无 usage/cost → 不伪造。

**协议适配的关键点（B1.3a 修正）**：`AgentSession` 对 stderr 直接记为诊断、对无法解析的 stdout 记为 `unparsed`，
不会调用 adapter 的 `mapEvent`。因此 DSH 纯文本 stdout 必须由**传输层交付为已解码 `data`**
（会话对 `frame.data` 优先于 JSON 解析 `frame.text`）才能进入 `mapEvent`。
B1.3 初版的 `plainTextLines` 走的是 `ManagedProcess` 的**行拆分**路径，行结束符与空行已被 `emitCompleteLines`
丢弃，故内容不保真（见 §9.7 P1）。B1.3a 改为：`ManagedProcess` 新增**可选** `onStdoutText`
（原始解码 chunk，`StringDecoder` 保证跨 chunk UTF-8 完整），`CliJsonlTransport` 用**可选**
`rawStdoutText`（默认关）交付逐字 chunk；保留原始 `text`、不发明 JSON、**未新增 transport**、默认 JSONL 行为不变。

### 9.4 两层分配复用映射（用户能力 → 已有模块 → 实际缺口 → 后续阶段）

| 用户能力 | 已有模块 | 实际缺口 | 后续阶段 |
|---|---|---|---|
| 功能 A：目标→工作流拆分 | `planner.ts` / `planner-wiring.ts` | 角色→候选任务的接口/输入材料/交付物契约 | B3/B4 |
| 功能 A：每任务选 Agent×Model | `decision/initial-assignment.ts`（`explicitPair`）、`assignment.ts` | 项目/角色/任务选择层级与 pause | B1/B3 |
| 功能 A：每任务独立会话 | `SessionRegistry`、`WorkerIdentity`、`workbench-sessions.ts` | 无（已具备） | — |
| 功能 A：依赖顺序 | `scheduler.ts`、`task.ts` | 无（已具备） | — |
| 功能 A：Skill/MCP 任务级选择 | Skill intent（`planner`/`workbench-plan`） | **MCP 全缺**；Skill 无目录/授权/实际调用核对 | B1/B3 |
| 功能 B：协作组成员 Agent×Model×范围 | `fanout.ts`（`FanoutMemberSpec`/`validateFanoutMembers`） | 仅有 `scope`；缺职责/文件范围/交付物/验收/成员依赖 | B3/B4 |
| 功能 B：分组证据 | `fanout.ts`（`FanoutProvenance`） | 无“集成责任”字段 | B4 |
| 功能 B：受控汇总 | `fanout.ts`（`projectFanoutAggregation`，ALL-terminal） | 无集成/汇总/验收判定；**不把 all-terminal 当验收通过** | B4 |
| 功能 B：写并行 | `ResourceClaim`/`Workspace`；topology 拒绝 WRITE member | `PARALLEL_WRITE=CLOSED` | 独立裁定 |
| DSH 接入 | `adapters/dsh.ts` + `CliJsonlTransport` + `ManagedProcess` | 逐请求模型/会话恢复/隔离未验证 | B1/B3 |

约束核对：既有 fan-out 已用**父容器任务 + 独立 child task**，同一个 `taskId` 不会被复制成多个同时执行的
Worker；本轮**未**新建 TeamStore / WorkerManager / 第二套 DAG 或任务状态机。

### 9.5 实跑证据与残留（实现方）

`npm run typecheck` PASS；`node tests/dsh-adapter.test.ts` **41/0、exit=0**（受控 fixture 经
`Orchestrator → AgentSession → CliJsonlTransport → contained ManagedProcess`，含成功/非零/启动失败/cancel/deadline）；
受影响的 contract **248/0（2 skipped）**、unit **92/0**、orchestration **968/0**、workbuddy **137/0**、
cline **88/0**、containment-production **233/0**、execution-lifecycle **136/0**、ownership 守卫 **5 opt-in/0 违规**；
`git diff --check` clean。DSH 本机 `--version` 为**受控无推理探测**；未调用真实模型、未读凭据、未改本机配置。
本轮 owned 临时目录/observer/CLI 进程残留 **0**；`%TEMP%` 下的 `dsh-*` 目录为 DSH 自身运行时产物
（`acl-skill`/`subprocess`/`spill`/`workspace-changes`，时间早于本轮），非本切片 owned 资源，未删除。

### 9.6 边界与未验证

DSH 基础接入 ≠ 逐模型选择 ≠ B1 完成。两层分配（功能 A/B）为正式后端需求，但**执行闭环仍按 B3/B4 授权推进**。
`listed ≠ connected ≠ callable ≠ free`；未验证任何模型实际可调用、账户额度、免费资格、角色适配或真实推理兼容性；
未跑 full suite、未调用真实模型任务、未开放并行写、未进入前端或群聊平台。
本轮标 **READY FOR CODEX INDEPENDENT REVIEW**。

### 9.7 B1.3 Codex 独立审核 BLOCKED 与上传说明

日期：2026-10-12。§9.1–§9.6 为实现方报告；本节为独立结论，**BLOCKED**。
B1.2c closure PASS 不变；B1 整体 NOT SEALED、W5 SEALED WITH P2、PARALLEL_WRITE=CLOSED、B2–B5 未授权。
两层任务分配需求已落档，但不是两层执行闭环已实现的证据。

**P1：多行最终回答被破坏。** `ManagedProcess.emitCompleteLines` 去掉行结束符并跳过空行，
`CliJsonlTransport.plainTextLines` 只把已拆行的文本交付为 data；DSH `mapEvent` 随后直接 `noteText(text)`。
因此纯文本绕过 JSON 解析并不等于内容保真。本轮独立受控 fixture 经实际
`Orchestrator → AgentSession → CliJsonlTransport → contained ManagedProcess` 输出
`const a = 1;\n\nconst b = 2;\n`，实际 result.output 为 `const a = 1;const b = 2;`，
state=succeeded、treeStopConfirmed=true。损失包含内部空行，不能只在 adapter 为每个已保留行补换行。
现有 41 项用单行答案检查 includes，未发现此问题。必须修复并增加真实链路多行/空行保真断言后再审核；
Codex 本轮不修改生产实现或测试，不建议另建 transport/执行器，也不改变默认 JSONL 行为。

**P2：stderr 分支测试与真实调用链不一致。** `AgentSession.handleFrame` 在 stderr 分支直接记诊断并 return，
不会调用 DSH adapter 的 stderr `mapEvent`。独立 fixture 发出 reasoning 标题和正文，实际 progressCount=0，
diagnostics 为两条 stderr 诊断；直接调用 mapEvent 的单元断言不能证明真实 reasoning/progress/native-signal 映射。
非零 exit 仍由 terminalPolicy 判失败，此发现不表示错误退出被认证成功。应按既有会话契约修正文档/测试声明，
删除无效分支或用最小明确的 opt-in 接线并验证；不为此全局放开其他 adapter 的 stderr 路由。

**协议与复用调查**：独立读取安装包确认 `@deepseek-ai/dsh@0.1.5-rc.2`，headless startup 仅位置参数任务，
最终 stdout 写 `outcome.text + "\n"`，退出按 completed 判 0/1。当前版本没有逐请求模型/JSON/session 输出能力。
本轮 GitHub MCP 实际成功读取 deepseek-ai/deepseek-harness 的 headless README，固定上游提交
d743267388641bc76f17c45ce8b4c231aed1d32c；上游存在与本机不同的协议参数，不将其反推为本机能力。
继续复用现有 adapter、ManagedProcess、transport、Session 和 fan-out；未新增依赖或第二套 authority。

**本轮独立实跑**：typecheck PASS；dsh-adapter 41/0；contract 248/0（2 skipped）；unit 92/0；
containment-production 233/0；execution-lifecycle 136/0；real-agent-isolation 5 opt-in/0 违规；
`git diff --check` PASS，实际退出均为 0。上述多行 probe 单独报告，不被这些 PASS 覆盖。
runtime.run 生产调用边仍为 1。实现方 orchestration/workbuddy/cline 数量与真实 DSH version probe 未在本轮重复。
未跑 full suite、真实模型推理或真实 DSH 任务，未读取凭据、装依赖或改本机 Agent 配置。

**P3：历史 flake 观察。** 实现方报告一次 containment-production 间歇失败，本轮一次独立运行未复现。
没有具体失败 assertion，不能证明与 DSH 无关，也不据此认证 containment 失效；保留后续观察项。
本轮多行 probe 的唯一 owned 根目录已清理，cleanupFailures=[]、rootRemains=false；不清理历史/foreign 资源。

**上传说明**：按用户既有授权上传九文件 BLOCKED 增量快照，分支 `codex/b13-review-blocked`，
父提交 dde5c7c0acc50d9d2e16aea131a02282085a376e。范围为三个既有文档、test-timed、adapter 工厂、
discovery、CLI transport、新 DSH adapter 与新 DSH 测试；Codex 仅更新两份现有审核文档。
使用隔离 Git index，不 checkout/合并 main、不改变共享索引、不创建 PR；不上传临时 probe、机器配置或凭据。
该上传是可复核快照，不代表 DSH 接入或 B1 封板通过。

### 9.8 B1.3a 纯文本保真与 stderr 契约收口（实现方实跑，待独立复核）

日期：2026-10-12。仅关闭 §9.7 的一个 P1 与一个 P2；不重开 DSH adapter，不重审整个 B1。
B1.2c closure PASS 不变；B1 整体 NOT SEALED、W5 SEALED WITH P2、PARALLEL_WRITE=CLOSED、B2–B5 未授权。

#### P1 根因与复用方案

`ManagedProcess.attach` 的默认 stdout 路径用 `emitCompleteLines` **去掉行结束符并跳过空行**；
B1.3 的 `plainTextLines` 交付的是这份已拆行的文本，DSH `mapEvent` 再直接 `noteText` 拼接，于是
`const a = 1;\n\nconst b = 2;\n` 变成 `const a = 1;const b = 2;`（内部空行与末尾换行丢失）。
**复用入口**：`StringDecoder` 已保证跨 chunk 的 UTF-8 完整；只需一个**原始 chunk** 入口。
**方案**：`ManagedProcess` 新增可选 `onStdoutText`（逐字解码 chunk，非行拆分），
`CliJsonlTransport` 新增可选 `rawStdoutText`（默认关）据此交付逐字 `data`；DSH `createTransport` 打开它。
未新增 transport/执行器/manager/authority；默认 JSONL 行拆分路径**字节不变**。

#### P1 精确输入/输出（真实链路，受控 fixture）

| 用例 | stdout（精确） | `result.output`（精确断言） | 输出事件拼接 |
|---|---|---|---|
| 多行含首/中/尾空行 | `\nconst a = 1;\n\nconst b = 2;\n` | 相等 | 相等 |
| CRLF | `a\r\nb\r\n\r\nc\r\n` | 相等 | 相等 |
| 1 字节分批 + 多字节 UTF-8 | `中1\n\né2\n` | 相等 | 相等 |
| 末尾无换行 | `no trailing newline` | 相等（不补换行） | 相等 |
| 形似 JSON 的普通答案 | `{"a":1,"b":[2,3]}\n` | 相等（不解析为协议事件） | 相等 |

`result.output` 与 `session.output` 事件 text 拼接**均用精确相等**断言，非 `includes`。

#### P1 负控（证明回归承重）

在**隔离副本**上临时将 `createTransport` 改回不带 `rawStdoutText`（修复前路径），命令
`node tests/dsh-adapter.test.ts`：**exit=1、44 passed / 11 failed**，失败均为上述保真断言
（多行/CRLF/UTF-8/末尾换行/JSON 形态与 P2 答案），例如
`FAIL P1 multi-line: output is EXACTLY the stdout bytes - ""`。恢复后 55/0；工作树未被覆盖或重置。

#### P2 stderr 契约收口

`AgentSession.handleFrame` 对 stderr 直接记诊断并 `return`，**不会**调用 adapter 的 stderr `mapEvent`。
故删除 DSH `mapEvent` 中不可达的 stderr 分支与“映射为 progress/native signal”的声明；
`mapEvent` 仅处理 stdout 且逐字交付。保留 `parseDshErrorLine`/`firstDshError`/`describeDshFailure`
供 `terminalPolicy` 的失败详情使用，退出码仍权威。
真实链路断言：reasoning/error 出现在 `RunResult.diagnostics`（形如 `stderr: dsh: reasoning:`），
**不出现在最终答案**，非零退出仍 `failed`（`NONZERO_EXIT`）。单元 parser 测试与真实链路证据分开表述。

#### 本轮实跑（实现方）

`npm run typecheck` PASS；`node tests/dsh-adapter.test.ts` **55/0、exit=0**；
`contract` **248/0（2 skipped）**、`unit` **92/0**、`execution-lifecycle` **136/0**、
`real-agent-isolation` 守卫 **5 opt-in/0 违规**，exit 均为 0；`git diff --check` clean。
`runtime.run` 生产调用边 = 1；新增 authority = 0；默认 JSONL 行为兼容。
本轮 owned 临时目录/observer/CLI 进程残留 **0**（`dsh-*` 历史目录为 DSH 自身运行时产物，未删除）。
未跑 full suite、未调用真实模型、未读凭据、未改本机配置。

#### 观察项：containment-production 间歇失败（保留证据，不循环重试）

一次批量运行 `node tests/containment-production.test.ts` 出现 **232 passed / 1 failed、exit=1**，
失败 assertion：`W3-9 and the writer had genuinely been active before it :: 1170->1170`
（源码 `tests/containment-production.test.ts:969`，判定 `atStop > before`，是 200ms 窗口内的
心跳增长比较）。同一命令随后**单独运行一次**为 **233/0、exit=0**。证据：(a) 该失败为时间竞态断言；
(b) 本切片只新增**可选** `onStdoutText`，默认行拆分路径字节不变（diff 显示原逻辑整体移入新 `else`）；
(c) 未连续重试到全绿，也不据此认证 containment 失效，保留为后续观察项。

本切片标 **READY FOR CODEX INDEPENDENT REVIEW**；不得据此宣布 B1 封板或开放并行写。

### 9.9 B1.3a Codex 独立收口 PASS WITH P2 与上传说明

日期：2026-10-12。§9.7 为历史 BLOCKED；原多行输出 P1 与 stderr 契约 P2 已独立确认关闭。
本次切片结论 **PASS WITH P2**，限纯文本保真与 stderr 契约收口，不代表真实 DSH 推理兼容性或 B1 整体验收。
B1 NOT SEALED、W5 SEALED WITH P2、PARALLEL_WRITE=CLOSED、B2–B5 未授权保持不变。

**源码复核**：新增可选 `ManagedProcess.onStdoutText` 使用既有 StringDecoder 解码后直接交付 chunk，
end 时刷新 decoder；仅 stdout 显式启用，默认 line framing 与 stderr 路由保留。
CLI transport 的 rawStdoutText 默认关闭，DSH 显式启用并给出 data，Session 不再 JSON 解析答案。
DSH mapEvent 的不可达 stderr 分支已删除；错误解析仍供 terminalPolicy 使用。
未新建 transport/manager/authority/依赖，仍复用现有进程、会话和输出容量限制。

**独立真实链路 probe**：使用 owned launcher copy 与受控 fixture，不启动真实 DSH。
target 按 1 字节、间隔 8ms 写入 `\n中\r\n\n{"a":1}\r\n\nEND`，最后无换行；
实际 output 精确相等，18 个 session.output 事件的 text 拼接也精确相等，state=succeeded、
treeStopConfirmed=true。reasoning stderr 出现在 diagnostics、不在答案中。
probe cleanupFailures=[]、owned root 不再存在，未扫描清理 foreign 资源。

**独立负控**：隔离 Node loader 在内存中仅替换 DSH mapEvent 的文本取值为去换行版本，未改工作树文件。
运行真实 DSH suite，真实 status=1、signal=null、error=null，44/11；多行、CRLF、UTF-8 等精确断言失败，
其中多行实际退化为 `const a = 1;const b = 2;`。证明回归能发现内容丢失，而非仅检查进程成功退出。

**本轮独立实跑**：typecheck PASS；dsh 55/0；contract 248/0（2 skipped）；unit 92/0；
containment-production 233/0（一次）；execution-lifecycle 136/0；isolation 守卫 5 opt-in/0 违规；
git diff --check PASS，正常运行实际 exit 均 0。runtime.run 生产调用边仍为 1，未新增 authority。
DSH --version、本机目录及其他历史结果未重复；未跑 full suite、真实模型任务、读取凭据、安装依赖或改本机配置。

**保留 P2-A：测试异常路径缺少 finally。** `tests/dsh-adapter.test.ts` 的 realChain 创建 owned 目录后，
fixture 写入、运行与等待均未被 finally 包住；末尾清理只在正常流程到达时执行。
本轮在隔离 child 拦截本套件 owned `fixture.cjs` 首次写入并抛 INDEPENDENT_SETUP_WRITE_FAILED：
真实 status=1、signal=null、error=null，汇总未执行，owned root 仍存在。
审核 probe 仅按它记录并核验边界的路径清理，remaining=false。
此例在启动任何 fixture 前失败，证明目录清理缺口，不证明进程泄漏；退出已非零，不构成假 PASS，列非阻断 P2。
最小修复是在既有 ledger 下保证 finally 清理，不另建框架，并用独立 child 证明异常后的清理和退出码。

**保留 P2-B：既有 W3-9 断言可能误报及时停止。** 实现方提供的 1170→1170 失败来自 atStop>before。
源码先取 before，再立即 cancel，等待停止后才 sleep(200) 并取 atStop；这不是停止前 200ms 的心跳采样。
若 cancel 在下个 50ms 写入 tick 前停止 writer，before>0 与 after===atStop 可以同时成立，但 atStop>before 失败。
因此该断言不足以证明 containment correctness failure；本轮一次独立 suite 233/0，未循环重试。
该历史测试修订未纳入本次六文件修复；后续应在取消前独立确认增长，保留停止确认后不再写入的强断言。

**上传说明**：按既有授权上传六文件 PASS WITH P2 增量快照，分支 `codex/b13a-review-pass-with-p2`，
父提交 4b89534e01e5bba3f1afdddce17ff7eb433e1e52。包含 spawn、CLI transport、DSH adapter、DSH 测试和两份现有文档。
Codex 本轮仅更新两份文档，未修改实现或测试；使用隔离 Git index，不 checkout/合并 main、不改共享暂存区、不创建 PR。
不上传临时注入器、probe、凭据或本机配置。两个 P2 保留，不扩大为 B1 封板或并行写授权。

## 10. B1.4 用户 Agent × Model 选择最小闭环（实现方实跑，待独立复核）

日期：2026-10-12。B1.3a 独立审核 PASS WITH P2 不变；B1 整体 NOT SEALED；W5 SEALED WITH P2；
PARALLEL_WRITE=CLOSED；B2–B5 未授权。本轮实现**自动 / 固定**与**项目 / 任务**两层的用户
Agent × Model 选择，并顺手关闭 B1.3a 的两个测试 P2。不重写选择器、不复制评分算法、不新增
SelectionManager / ModelRouter / PolicyEngine / 第二套 registry/scheduler/DAG / 依赖。

### 10.1 复用了什么、补了什么

**复用（已完整可用，直接接线）**：`AgentModelIntent` + `validateAgentModelIntent`（原子 pair 校验）、
`assignWorker` 的 `explicitPair` 强制（限制候选池、accept-or-refuse、**从不替换**）、
`WorkbenchTaskSpec.explicitPair` / `TaskIntent`、`assignIdentity`（pair → Task 身份）、
`buildRunRequest`（`task.modelId` → `RunRequest.model`）、`reassignTask`（单一 reassign 入口）、
`resolveContainedStop` 等既有进程契约、`BadConfigError`。

**新增（最小）**：
- `core/types.ts`：`SelectionSpec = {mode:'auto'} | {mode:'fixed';agentId;modelId}` +
  `resolveSelection`（task > project > auto）+ `fixedPairOf`（纯值，无 manager）。
- `orchestrator/config.ts`：`OrchestratorConfig.selection` + 原子校验（partial/未知 mode 拒绝）；
  `Orchestrator` 暴露 `projectSelection()`。
- `workbench-plan.ts`：`WorkbenchTaskSpec.selection`。
- `workbench.ts`：`WorkbenchOptions.projectSelection`；`selectInitialAssignment(rootId, taskSelection?)`
  对 **fixed** 记录 `provider:'user-fixed'` 并**不再询问 Laya**；`assignChildren` 对 fixed 用用户 pair
  作权威（不被 Laya/偏好覆盖）并登记 `fixedSelections` 锁；`reassignTask` 对已锁任务拒绝换 pair
  （`fixed-selection-locked`）。
- `round-cli.ts`：`--select auto|fixed`；`--agent`+`--model`（完整 pair）视为 fixed，单轴仍是偏好；
  report 增加 `selection{mode,source,requested,note}`。

### 10.2 用户可执行的配置 / 命令例子

项目默认（`orchestrator.json`）：
```json
{ "agents": { "opencode": { "command": "…\\opencode.exe" } },
  "selection": { "mode": "fixed", "agentId": "opencode", "modelId": "opencode/space-bunny-free" } }
```
任务级固定（覆盖项目）：`orchestrator round "add a retry" --select fixed --agent opencode --model opencode/space-bunny-free`
任务级自动（覆盖项目 fixed，恢复 LAYA）：`orchestrator round "…" --select auto`
单轴偏好（沿用既有语义）：`orchestrator round "…" --agent opencode`

### 10.3 选择→分配→RunRequest 构造证据（实现方测试，hermetic）

`tests/b14-selection.test.ts` 经真实 `NativeWorkbench` 验证 task selection fixed → `selectInitialAssignment` 记录
`provider='user-fixed'`（Laya 未被询问）→ `assignChildren` 把 pair 写入 Task 身份 →
`buildRunRequest` 的 `RunRequest.agentId/model` = 该 pair（完整 model id，未加 provider）。
该套件未调用 round CLI 或 dispatch，fake runtime 的 requests 未被实际使用；不能据此称为执行与结果闭环。
Codex 补充的 production round probe 及其边界见 §10.6。
项目 fixed 在任务未选择时生效；任务 fixed 覆盖项目；任务 auto 覆盖项目 fixed 并回到 Laya。
不可用/未注册 pair → `no-model-available` **拒绝且不替换**；固定 DSH+model 在 **preflight 前**被拒（无进程）；
对固定任务 `reassignTask` 换 pair → `fixed-selection-locked`（防自动 handoff 偷换）。
用户请求的模型（selection）、传给 Runtime 的模型（`RunRequest.model`）可见；Agent 自身确认的**实际模型**
无证据时保持 unknown（不据请求参数宣称）。

### 10.4 两项 P2 处理

- **A（DSH 测试清理）**：`tests/dsh-adapter.test.ts` 的真实链路包在 `try/finally`；finally 对仍
  running 的 handle 用既有 `cancel` + contained 停止确认，再删除 owned 目录；删除失败进入同一
  cleanup ledger 与非零退出。新增独立 child 回归：注入清理失败 → 真实 `status` 非零、无 signal、ledger 有条目。
- **B（W3-9）**：`tests/containment-production.test.ts` W3-9 改为**取消前**有界确认 writer 增长
  （≤5s，50ms 轮询），**取消后**保留“确认停止 + Job 为空（ActiveProcesses==0）+ 不再产生字节”强断言；
  删除会误报的 `atStop > before`；不新增固定长 sleep、不无限轮询。

### 10.5 实跑证据（实现方）与边界

`npm run typecheck` PASS；`b14-selection` **28/0**；`assignment` 235/0、`workbench` 413/0、
`initial-assignment-decision` 37/0、`continuation` 138/0、`handoff-production-round` 312/0、
`state-loop` 169/0、`round-result` 293/0、`planner` 189/0、`contract` 248/0（2 skipped）、`unit` 92/0；
`dsh-adapter` 59/0、`containment-production` 234/0；ownership 守卫 5 opt-in/0 违规；`git diff --check` clean。
`runtime.run` 生产调用边 = 1；新增调度 authority = 0；PARALLEL_WRITE=CLOSED。
未跑 full suite、未调用真实模型、未读凭据、未改本机配置；本轮 owned 临时目录残留 0。

**未实现（文档明确）**：角色默认层、偏好（prefer）模式、运行中改选、完整交互式暂停；两层协作组、
Skill/MCP 目录、动态额度、免费自动接力、并行写。`listed ≠ connected ≠ callable ≠ free` 仍冻结。
以上为实现方交接状态；当前独立裁定见 §10.6，不自行宣布 B1 封板。

### 10.6 B1.4 独立审核 BLOCKED（2026-10-12）

**P1：动态新增子任务丢失用户 fixed 约束。** 初始选择与分配只把已有 child 的 taskId 写入
`fixedSelections`；`addTask` 继承父任务的 agentId/modelId，却未继承选择约束，随后 `reassignTask`
仅查该 map。独立 probe 通过既有 `decisionCapabilities().addTask/reassign`：项目 fixed 为
agent-a/agent-a/model-1，新增 r-s1-s1 初始继承该 pair；请求换为 agent-b/agent-b/model-2 后
返回 `ok=true, code=migrated`，Task 身份确实变为 B pair，且准备了新 session。
probe 未 dispatch（runtime requests=0）；证明固定选择可被接力接口绕过，不宣称真实模型已执行。
最小收口是在现有任务创建/重规划与重分配路径保留有效选择约束，并覆盖新增 child 的接力回归；无需新增 manager。

**初次分配正常路径独立通过。** 复用 handoff-production-round 的 production round harness，
在内存 loader 中导出 harness 并注入 projectSelection（未改仓库文件），实际经过 scheduler/executeTask
到受控 RuntimeRunner，执行和 reviewer 都为测试替身：任务 fixed A→RunRequest A；项目 fixed B→B；
任务 auto 覆盖项目 fixed B→LAYA 选 A。三者 report.selection 与派发 pair 一致、stage=complete。
这些是 CLI/调度接线证据，不是 OpenCode/DSH 真实推理兼容性或实际服务端模型证据。

**P2：缺值 --select 被忽略。** `round "objective" --select` 的 parse 返回无 error、select 未定义；
同 production round probe 实际按 default auto 派发 B 并完成，而不是用法错误。缺值应在启动前拒绝。
另：未写 --select 时同时给 --agent/--model 已由旧偏好语义变为 fixed，这是兼容性变更，需保留明确说明。

**旧 P2-A 未完全关闭。** DSH realChain 的 finally 仍晚于 owned 目录创建和 fixture 写入。
独立 child 拦截实际 fixture.cjs 写入并抛错：status=1、signal=null、error=null，owned 目录仍存在；
审核 probe 仅清理本次记录且核验边界的目录，remaining=false。没有启动 target，不据此声称进程泄漏。
新增 fail-child 是另一条受控分支，不能证明 realChain setup 异常已受 finally 保护；列非阻断 P2。
**旧 P2-B 已关闭。** W3-9 取消前有界观测增长，取消后保留停止确认、Job 空与不再写入断言；独立 234/0。

**本轮独立实跑（全部 exit=0）**：typecheck；b14-selection 28/0；assignment 235/0；workbench 413/0；
initial-assignment-decision 37/0；handoff-production-round 312/0；dsh-adapter 59/0；
containment-production 234/0；contract 248/0（2 skipped）；isolation 守卫 5 opt-in/0 违规；diff check PASS。
runtime.run 生产调用边=1，未新增调度 authority。其他实现方列出的 suite 未在本轮重复。
独立 probe 的 owned 目录均已按名清理；未跑 full suite、真实模型任务或读取凭据/改本机配置。

**上传说明**：以 bcceed2683854da7e0f30e673fbb080812c89dd6 为父，上传到 codex/b14-review-blocked 审核分支。
差异为 13 个文件：实现方 12 文件与用户先前授权的模型中断计划所在 BACKEND_REQUIREMENTS.md；
Codex 本轮仅修订现有基线/阶段分析的审核事实。此快照用于复核，不代表验收或合入 main。
B1 overall NOT SEALED、PARALLEL_WRITE=CLOSED、B2–B5 未授权；模型中断仅列后续计划，本轮未实现。
