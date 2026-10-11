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

### 5.1 B1.1 只读模型目录诊断（实现待修，独立审核 BLOCKED）

本轮实现一个**最小、只读**的切片：用户显式请求时，`doctor --models <agent>` 返回该 Agent
原生 CLI 列出的模型目录快照。仅支持 **OpenCode**（`opencode models`，官方命令）；其他 Agent
明确返回 `unsupported`，其输出格式不被套用。实现复用既有 discover/launcher/`CmdRunner`
与 `execRunner`，无新依赖、无 `shell:true`、无 MCP SDK、无通用采集框架。
但既有 `execRunner` 不等于 W2/W3 contained ManagedProcess：Codex 实测超时后后代仍存活。
另一个 P1 为新增测试仍依赖本机安装 OpenCode。**B1.1 尚未通过独立审核**，详见 §8。

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

日期：2026-10-11。**BLOCKED：两个 P1 未关闭**。§7 是上一轮入口审计历史，
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
