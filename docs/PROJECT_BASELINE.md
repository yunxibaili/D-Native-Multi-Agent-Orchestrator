# 项目基线

更新日期：2026-10-12（B1.2 两个 P1 与一个 P2 收口更新）
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

### 5.1 B1.1 只读模型目录诊断（最小诊断切片 PASS；B1.2a 原发现关闭，新增测试 P1 导致 BLOCKED）

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
B1.2a 独立复核已确认原发现关闭，但新增默认测试隔离与清理失败传播 P1，当前 **BLOCKED**，详见 §8.12。
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
