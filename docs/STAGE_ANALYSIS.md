# 后端阶段分析

更新日期：2026-10-12（B1.4 独立审核 BLOCKED）
性质：需求与源码差距分析、建议顺序；不是自动启动开发的指令，也不改变已封板状态。

## 1. 当前所在阶段

执行底座已有大量可复用能力；W5 执行证据收口与 readiness 裁定已完成，状态为 SEALED WITH P2。
新后端能力仍按用户另行授权推进，PARALLEL_WRITE=CLOSED。
不能继续把项目描述为“T2-b.1 / T3 未开始”，也不能将 W5 封板解释为全部 Agent 或新需求已验收。

最新 W5.1d closure 独立审核结论为 PASS。历史 stress 失败传播、pid-only fallback
及 observer 异步 EPIPE P1 均已在当前路径收口。
上一轮独立 observer 边界 probe、3-round 与 50-round 通过，两次均 EXIT=0、140/0，stress 失败计数全 0。
详见 [项目基线](PROJECT_BASELINE.md#6-w5-最终证据包与上传说明)。
本轮已删除唯一剩余的非阻断 P2：新增冗余死亡断言把 OBSERVATION_ERROR 打印为退出证明；
同一 case 的原句柄 EXIT_CONFIRMED/EXITED 强断言保留，未新建观测或清理框架。
Codex 本轮独立 3-round 为 139/0，补充 READ 121/0、resource-claim 192/0，typecheck/diff check 通过。
保留真实 Agent 兼容性、full-suite 时效及现有 259 reconciliation 可用性 P2；不开放并行写。

B1 只读入口审计及 Codex 复核已完成；B1.1a 原两个 P1、B1.1b 新增清理 P1 与两个 P2 均已独立确认关闭。
主要缺口成立，但目录采集不得调用 setModelAvailability 或自动 upsert 调度 registry；
这些写入会改变候选/准入，并非只读。第一片建议缩为 opt-in OpenCode 模型目录诊断，
通过现有 doctor 展示独立快照，listed/connected/callable/free 分开。
项目/角色/任务选择层级、付费授权、Skill/MCP 目录与执行闭环留在后续对应切片。
详情见 [B1 审计复核](PROJECT_BASELINE.md#7-b1-只读审计独立复核)。

**B1.1 最小只读诊断切片 PASS**：`doctor --models opencode` 通过既有 doctor
返回 OpenCode 原生 `opencode models` 的只读目录快照（`src/runtime/model-catalog.ts`）。不写 ModelRegistry、
不改变 assignWorker/准入/quota/费用，listed≠connected≠callable≠free；其他 Agent 返回 `unsupported`。
未采集/成功有模型/成功空目录/不支持/失败（非零、超时、无法解析）严格区分，部分 stdout 不认证成功。
B1.1a 收口：默认执行改为复用生产 contained `ManagedProcess`（Job 启动 + 协同停止 + tree-stop 确认），
未确认清理即判 `failed`；测试改用受控 command/fixture，不再依赖本机安装 OpenCode。
B1.1b 收口：检查/observer 回收/owned 目录删除失败统一进入退出码；deadline timer 在 `finally` 释放；
删除冗余 fresh-PID 断言。B1 整体仍未封板；本片不含选择层级、pause、付费授权、动态额度、Skill/MCP 或 LAYA 联合决策。
封板限受控 fixture 与测试链路。

**B1.2 真实 OpenCode 目录兼容性（历史正常路径独立通过；B1.2c 入口收口独立 PASS）**：新增
`tests/b12-opencode-model-catalog.test.ts`（`ORCH_B12_REAL_CATALOG=1` 才运行，不在默认 suite，
已登记进 ownership 守卫）。本机 launcher native、版本 **1.18.35**、`opencode models` 帮助确认；
经 `doctor → collectModelCatalog → contained ManagedProcess → 真实 OpenCode` 得到 `ok`、**42** 个模型、
约 **2068ms**、完整 `provider/model` 保留；owned control 记录经生产验证为已停止。
仅真实 OpenCode 启动，其他 Agent 用 `replaceAdapters` 替换为 fake（测试边界）。
未加 `--standalone/--pure/环境变量`；未证明零网络/零缓存/零插件初始化，未触碰 7 个桌面应用进程。
未验证模型可调用/额度/免费/角色适配。详见 [项目基线 §8.9](PROJECT_BASELINE.md#89-b12-真实-opencode-目录兼容性实现方实跑待独立复核)。
Codex 2026-10-12 独立真实查询同样得到 1.18.35 / ok / 42 models / 3 PASS，但发现两个 P1：
启用后 OpenCode 缺失仍 SKIP→PASS/exit=0；version probe 无 deadline，目录 timeout 不覆盖它。
另有 P2：任意一条 control 成功可掩盖另一条 INVALID 的证据缺口。
本片不得封板，详见 [项目基线 §8.10](PROJECT_BASELINE.md#810-b12-独立审核-blocked-与上传说明)。

B1.2a（2026-10-12）原两个 P1 与一个 P2 已独立确认关闭；新增默认测试隔离与清理失败传播两个 P1，
当前仍 BLOCKED，另有一个非阻断 PID 退出证据 P2。详见 [项目基线 §8.12](PROJECT_BASELINE.md#812-b12a-独立复核原发现关闭新增-p1-导致-blocked)。

B1.2b/B1.2c（2026-10-12）为上述测试收口；B1.2c closure 已独立 PASS（快照 dde5c7c0）。

B1.3（2026-10-12）：把用户确认的**两层任务分配**写入需求（功能 A 跨角色独立任务分配、功能 B 同目标模型协作组），
并完成 **DSH 最小 headless 接入切片**。DSH 本机 `0.1.5-rc.2`，launcher 为 `cmd-wrapper`；
已核实位置参数任务、stdout 最终回答、stderr `dsh: reasoning:`/错误、退出码 `completed?0:1`、
**无 `--json`、无逐请求模型、native sessionId 不打印**。适配纯文本需让传输层交付已解码 `data`
（既有 `CliJsonlTransport` 新增默认关闭的 `plainTextLines`，未新增 transport）。
未验证逐请求选模型、会话恢复、隔离；DSH 基础接入 ≠ 逐模型选择 ≠ B1 完成。
详见 [项目基线 §9](PROJECT_BASELINE.md#9-dsh-基础接入与两层任务分配复用映射实现方实跑待独立复核)。

**B1.3a 独立结论 PASS WITH P2**：§6.8 的历史输出保真 P1 与 stderr 契约 P2 已关闭，详见 §6.10。
仍保留测试异常路径清理与既有 W3-9 时序断言 P2；两层需求落档不代表执行闭环或真实 DSH 推理已验收。

**B1.4 当前独立结论 BLOCKED**：初次任务 fixed / 项目 fixed / 任务 auto 的 production round 接线通过，
但动态 addTask 新 child 未继承 fixed 约束，随后 reassign 实测接受另一 pair，违反用户固定选择（P1）。
最小下一步为补齐既有任务创建与接力路径的约束传递及回归；无需另建选择器或阻塞于企业级设计。
W3-9 P2 已关闭；DSH setup 写入异常清理与 --select 缺值各保留非阻断 P2。详见 §6.12 / 基线 §10.6。

## 2. 需求与实现差距

| 需求 | 可复用实现 | 仍需确认或补齐 |
|---|---|---|
| REQ-01 有界任务 | round-cli、决策循环、Human Gate | 更高层工作流与用户约束的明确契约；不自动跨 Round |
| REQ-02 发现 | runtime/discover、adapters、doctor、quota registry | 模型目录/连接/可调用区分及能力新鲜度 |
| REQ-03 用户选模型 | 配置/RunRequest、assignment intent | 项目/角色/任务优先级、偏好/固定和不可用行为 |
| REQ-04 同 Agent 多模型 | WorkerIdentity、SessionRegistry、Task/Workspace | 每种 Agent 的真实隔离和并发额度约束 |
| REQ-05 能力分配 | LAYA Agent × Model 候选选择 | 角色能力事实、实际表现、选择理由和版本 |
| REQ-06 Skill/MCP | Skill intent、部分 adapter skills/native tools | 目录、授权、选择、按需加载、实际调用核对 |
| REQ-07 异构工作流 | planner DAG 模板、依赖和提交 | 不同角色的具体候选任务、接口和交付物 |
| REQ-08 免费/预算 | 静态免费池、quota policy、Spawn Gate | 入口/账户共享额度、时效、全费用边界 |
| REQ-09 接力 | 同 Task 新 Attempt/Lease、handoff | 完整检查点、切换约束与执行中模型中断处理（见 §3.1），不能冒充原生会话迁移 |
| REQ-10 节省消耗 | 原生工具、上下文、memory/evidence | 去重、按需上下文、真实对照数据 |
| REQ-11 状态与交付 | Attempt/Result/Review/Observation | 对外稳定事实契约；前端设计以后确认 |
| REQ-12 范围 | Native CLI 架构 | 保持 Agent-native；不自动引入网关/直接 API |
| REQ-13 功能 A：跨角色独立任务分配 | planner、assignment、scheduler、SessionRegistry、WorkerIdentity | 每任务的 Skill/MCP 任务级选择与输入/交付契约；项目/角色/任务选择层级 |
| REQ-14 功能 B：同目标模型协作组 | `fanout.ts`（容器任务 + 独立 child task、`FanoutMemberSpec`、READ-only 门、ALL-terminal 投影） | 每成员职责/文件范围/交付物/验收/依赖与集成责任；受控汇总与验收判定（不得把 all-terminal 当验收） |

这些是当前检查范围内的差距，非完整代码审计结论。
例如“接口能选模型”与“完整用户选择产品已验收”必须分开。

### 必须显式评审的契约扩展

现有 AgentCapabilities.skills 仅表示能否请求原生 Skill，不是目录或分配筛选事实。
新需求将 Skill/MCP 纳入选择，因此 B1/B3 必须先定义必要的新事实与兼容行为，
不能直接反转旧 boolean 的含义。完整用户固定规则、动态费用、跨入口接力也需
保留当前 T3-M0 身份/路由边界，不能把新需求默认为现有实现。

## 3. 建议阶段

B 编号仅用于新需求分析，不重命名或重开已封板的 T/W 阶段。
B0 为执行证据收口标签，现已完成。B1 仅最小只读诊断切片 B1.1 通过审核，其余需求尚未完成；
B2–B5 仍为 PLANNED / NOT AUTHORIZED，不得因本文自行开工。

| 阶段 | 最小目标 | 依赖与退出条件 |
|---|---|---|
| B0 执行证据收口 | COMPLETE：W5 SEALED WITH P2；观测/清理 P0/P1 与冗余断言 P2 已关闭 | 兼容性和证据时效限制保留；PARALLEL_WRITE=CLOSED |
| B1 可用能力与用户规则 | 复用 registry/adapter 表，明确 Agent/Model/Skill/MCP 事实和用户约束 | **B1.1 最小只读诊断切片 PASS；B1.2c 剩余清理 P1 与 opt-in P2 独立收口 PASS**；**B1.3 完成 DSH 最小 headless 接入 + 两层分配需求落档**；B1 整体 NOT SEALED，其余（选择层级、Skill/MCP、逐请求模型）未实现 |
| B2 费用与候选约束 | 入口/账户归属、免费依据、有效期、共享额度和预算 | 每次分配/接力均校验；未知不伪造；全部不可用安全停止 |
| B3 LAYA 能力选择 | 联合选择 Agent/Model 与 Skill/MCP，提供必要角色能力事实 | 只选合格候选，复用原生执行，实际能力可核对 |
| B4 异构任务闭环 | 候选内容生成 → LAYA 选择 → 调研/实现/测试/审核 | 同 Agent 多模型独立会话；工作区隔离和材料交接有实证 |
| B5 成本与恢复验收 | 有界接力、总消耗统计和代表性任务对照 | 质量合格、无隐藏付费、无双写者，结果到 Human Gate 停止 |
| F 前端需求 | 提醒用户并单独梳理前端 | 后端契约稳定后再讨论；本轮不设计界面、不选前端框架 |

B1 只收集必要事实；B2 决定哪些候选可进入预算范围；B3 才做完整智能选择。
在 B3 前不另造路由服务，在 B4 前不先做通用工作流引擎。
Skill/MCP 的最小调用与费用观察可在其所属阶段验证，不必等待最终前端。

### 3.1 后续边界收口：任务执行途中模型中断

2026-10-12 用户新增计划项，需求见 BACKEND_REQUIREMENTS.md §10.1。
本条只登记后续工作，不扩大当前 B1.4 用户选择切片，不改变 B2–B5 未授权或 PARALLEL_WRITE=CLOSED。
在接力能力实施与 B5 恢复验收时统一补齐，不单独建设监控平台、恢复服务或新的调度 authority。

复用现有错误/活动观测、deadline/cancel、停止确认、Assignment、Attempt/Lease 与 handoff：
区分失联、限流、额度/认证/服务错误与未知；无输出不直接判死亡。
有界重试必须考虑重复工具调用及部分写入；确认旧执行停止后才接力，未确认则保持保护并受阻。
保留部分文件和交付物，固定模型失效不自动换 pair，无合格免费候选不静默转付费。
现有 B1.4 固定规则应为后续恢复复用，避免实现第二套用户选择逻辑。

待统一验证：流中断；静默但存活；429/额度/认证失败；停止未确认；写入一半后重试；
固定选择与无候选；接力再次失败后达到总时限/次数上限。使用受控 fixture 优先，真实 Agent 证据单独记录。
当前仅列入计划，尚未实现或验收；该待办不阻塞当前最小选择闭环。

## 4. W5 封板证据与保留限制

证据分层（详见 [项目基线 §6](PROJECT_BASELINE.md#6-w5-最终证据包与上传说明)），
下列四类必须分开阅读，不能互相提升：

- **production admission**：两个 writer 经 TaskOrchestrator → executeTask → Runtime → 测试适配器
  → 真实 Transport/Contained ManagedProcess，并在不同 worktree 执行；证明真实生产准入链与适配器替换生效。
- **底层 stress**：cmd/PowerShell/git descendant、root-first、hardkill、stop-order swap、跨运行隔离、
  50-round；证明 contained descendant 的停止/回收物理事实。
- **受控失败注入**：cancel=false/TIMEOUT/THREW、observer.reaped=false、最终 OBSERVATION_ERROR、
  身份缺失/不匹配、COMMAND_CHANNEL_LOST 验证共享判定/计数；源码确认 ledger/finalizer 接线。
  cancel=false + 无退出事实、删除失败另有真实 child 非零退出证据，不把所有纯输入回归称为真实 OS 故障。
- **真实 Agent 历史证据**：W4 真实 Agent 兼容性与环境限制、旧 full-suite parity；本轮未重跑，
  不能由 fixture stress 自动提升为通过。

已确认收口：一侧启动失败时另一侧对称回收；停止失败/超时/抛错进入共享判定与最终结果；
owned fixture 根目录删除失败使同一 finalizer 的 child 非零退出且 foreign sentinel 保留；
观测失败/超时为 OBSERVATION_ERROR，不被认作死亡，保持原进程句柄避免 PID 重用错误归因；
测试适配器替换生效，未调用本机真实收费 Agent。
测试通过不自动开 PARALLEL_WRITE；后续是否开放需独立明确裁定。

W5.1d 独立审核已运行 typecheck、diff check、三个 observer 边界 probe、3-round 与 50-round。
本轮删除 P2 冗余断言后，OpenCode 与 Codex 各自实跑 `W51_ROUNDS=3`，均 EXIT=0、139/0
（少 1 条冗余断言），stress 失败计数全 0；
未重跑 50-round（本轮只删除冗余断言，未触及执行/清理路径）。
不可继续沿用已关闭的 W5.1b/W5.1c/W5.1d P1；当前执行/观测/清理范围内无未关闭 P0/P1。
Codex 裁定 W5 SEALED WITH P2；真实 Agent 兼容性、full-suite parity 时效及现有 259 reconciliation
可用性限制继续记录，不因 fixture 或定向 READ 通过而提升。PARALLEL_WRITE 仍 CLOSED。

## 5. 复用与删减

保留现有 TaskStore、Assignment、Scheduler、SessionRegistry、AttemptStore、
ResourceClaim、Runtime、Adapter 和 Verification 权威。
使用既有候选/Skill intent/Transport 扩展点，避免新增 SkillManager/MCPRouter 等
独立调度或决策系统。外部实现只作为明确缺口的复用候选。

优先评估项目已有实现、系统能力及已安装依赖。
Agent Orchestrator 可参考执行/工作区协作，RouteLLM 可参考评估方法；
未完成替换、依赖引入或 Windows 迁移的成本评估，不能据此宣布采用。
所有第三方候选需检查许可、维护、Windows、数据权限和维护成本。

本轮从当前目录移除历史审核、调研和旧阶段规划。
仍有效的契约整理为当前版本；不保留第二份本地历史文档副本。

## 历史备份

备份提交：9f12a3bf475ac47e4e6b2b2dd407ed09811610b5
备份标签：archive/pre-backend-requirements-2026-10-11
该标签已推送远程，包含本轮整理前全部可入库源码、测试和 25 份 docs 文档。
归档提交保存既有工作，不代表 W5 或新增需求通过审核。

- [全部旧文档](https://github.com/yunxibaili/D-Native-Multi-Agent-Orchestrator/tree/9f12a3bf475ac47e4e6b2b2dd407ed09811610b5/docs)
- [归档提交](https://github.com/yunxibaili/D-Native-Multi-Agent-Orchestrator/commit/9f12a3bf475ac47e4e6b2b2dd407ed09811610b5)

当前源码中的部分旧文档路径是历史来源注释，可在上述提交按原路径查阅；
本轮不为改注释而修改生产源码。当前规范以基线和架构契约为准。

只读查看示例：

    git show archive/pre-backend-requirements-2026-10-11:docs/PHASE5B_MULTI_AGENT_ARCHITECTURE.md

忽略的 node_modules、编译产物、临时 dashboard、锁/工作区和本机凭据不在该 Git 备份范围；
本轮未删除这些内容，也未将其上传。

## 6. 本轮检查与限制

### 6.1 B1.2b 实现方报告（2026-10-12；独立结论见 §6.4）

`npm run typecheck` PASS。
`node tests/b12-entry-failure-semantics.test.ts` **37/0、exit=0**；
`node tests/b12-version-probe-bounded.test.ts` **35/0、exit=0**；
`node tests/b12-control-evidence-association.test.ts` **32/0、exit=0**；
`node tests/model-catalog.test.ts` **68/0、exit=0**；
`node tests/real-agent-isolation.test.ts` 守卫 **5 个 opt-in、0 违规、exit=0**；
`node tests/real-agent-ownership.test.ts` **60/0、exit=0**；`git diff --check` clean、exit=0。
OpenCode 完全不可达（command 指向不存在绝对路径、`APPDATA` 空目录、`PATH` 只含 node 与系统目录）时，
三个 hermetic 套件加 model-catalog、ownership 守卫均 exit=0。
负控：`finalizeExitCode()` 临时忽略 cleanup 失败时，三个套件分别 **36/1、34/1、31/1**、真实 exit=1；
负控副本已删除，工作树无残留。
b12* 临时目录 **0**、b12ef report 文件 **0**、opencode CLI 进程 **0**；
历史目录 `w44-INgj3j`（12:43，早于本轮）保留，其中 4 个 launcher/root pid 均已退出。
未跑 full suite、未启用真实 Agent opt-in、未调用真实模型、未读凭据、未安装依赖、未改本机 Agent 配置。
### 6.2 B1.2a 本轮（2026-10-12）检查与限制

typecheck PASS；model-catalog **68/0**；contract **246/0（2 skipped）**；ownership 守卫 **5 个 opt-in、0 违规**；
real-agent-ownership **60/0**；三个新增 hermetic suite 分别 **26/0、29/0、26/0**，均 exit=0；
B1.2 未启用 NOT_RUN、exit=0；显式启用真实目录查询 **PASS、exit=0（7 断言）**；`git diff --check` clean。
真实目录查询只运行一次：1.18.35、`ok`、42 个模型、约 2.7s、bad=0，两阶段 control 记录各自 `success` 且 rootPid 不同。
常驻版本进程回归实现自身 deadline 触发、`cancel` 确认 true、launcher 记录 `terminated`，watchdog 未触发。
本轮 owned root/observer/CLI 进程残留 0；temp 下另有本轮之前历史遗留空目录 1 个（对应 pid 均已退出）。
未跑 full suite、未调用真实模型任务、未读凭据、未改本机配置；未重复实现方 help/端口采样。

### 6.3 上一轮（B1.2）检查与限制

上一轮（B1.2）OpenCode 实跑：`npm run typecheck` PASS；`tests/model-catalog.test.ts` **68/0**；
`tests/real-agent-isolation.test.ts` ownership 守卫 PASSED（5 个 opt-in，0 违规）；
`tests/real-agent-ownership.test.ts` **60/0**；`git diff --check` clean。
新入口 `tests/b12-opencode-model-catalog.test.ts` 未启用时 EXIT=0（NOT_RUN，不发现/不启动）；
启用后真实查询 **PASS（EXIT=0）**：版本 **1.18.35**、native launcher、`status=ok`、**42** 个模型、
约 **2068ms**、完整 `provider/model` 保留（bad=0）；owned control 记录 `success, success`
经生产验证确认为已停止。仅真实 OpenCode 启动，其他 Agent 用 `replaceAdapters` 替换为 fake（测试边界）。
未加 `--standalone/--pure/环境变量`；实测为单次短生命周期进程，无 CLI 残留、无监听端口；未触碰 7 个桌面应用进程。
真实运行后 owned root/observer/CLI 进程残留 **0**。
未证明零网络/零缓存/零插件初始化；未验证模型可调用/额度/免费/角色适配。

Codex 本轮独立实跑：typecheck、model-catalog **68/0**、ownership guard **5 个入口/0 违规**、
ownership **60/0**、未启用 NOT_RUN、diff check 均通过；真实目录一次 **2020ms / ok / 42 models / 3 PASS / exit=0**。
受控缺失 OpenCode：**SKIP→PASS(assertions=1)、真实 exit=0**；缺 launcher：SKIP、exit=0。
受控常驻 version 进程需审核 watchdog 经原 ManagedProcess.cancel 才结束（确认 true），
测试自身没有版本 deadline。合成合法 version + INVALID models 记录仍 confirmed=true。
以上异常输入经独立进程内 load hook 或合成 owned 文件构造，未修改实现，未冒充真实 OpenCode 故障。
正常真实兼容性证据与入口失败语义/有界性问题分开：本轮 **BLOCKED，两个 P1、一个 P2**。
未重复作者 help/端口采样；未调用真实模型任务。审核结果与上传说明见基线 §8.10。

Codex 上一轮独立实跑（B1.1b PASS）：typecheck PASS；model-catalog 68/0、quota 184/0、assignment 235/0、
contract 246/0（2 skipped），均 exit=0；独立 reaped=false 与真实 rmSync 抛错注入均真实 exit=1；
正常 contained fixture（timeout=30000ms）约 249ms 自然退出，active resources 无 Timeout；diff check PASS。
异常注入不冒充 OS 物理失败，预期 exit=1 不计正常回归失败；冗余 fresh-PID 断言已删除，原句柄 EXITED 强断言保留。
B1.1b 片范围内无未关闭 P0/P1/P2；上一轮 GitHub MCP/官方资料复用调查仍有效，本轮只做窄收口，不新增依赖或框架。

上一轮 W5 实跑：`npm run typecheck` PASS；`W51_ROUNDS=3` EXIT=0、139 passed / 0 failed，
attempted=3/completed=3，readiness/observation/containment/surviving/cleanup 全 0；`git diff --check` clean。
断言数由 140 降为 139 仅因删除 1 条 P2 冗余断言；上一轮未重跑 50-round。
Codex 独立验证：typecheck、W51_ROUNDS=3（139/0）、READ fan-out（121/0）、resource-claim（192/0）、diff check 通过。
Codex 上轮独立验证（W5.1d）：三个 observer 边界 probe、W51_ROUNDS=3/50（均 140/0）通过；
已知 owned 根目录及 observer 无残留。
未运行 full suite、真实 Agent 或重新审核已封板阶段。
环境限制仍在：Codex `MODEL/SERVICE_LATENCY`、WorkBuddy `ENVIRONMENT_BLOCKED`。
259 需按 handle 是否 signaled 判断，不能一概视为非 terminal。final reconciliation 的现有数值过滤
属于既有 launcher 可用性限制，非环境事实；未修改或重新探测该路径，详情见项目基线 §6.3。
最终 W5 SEALED WITH P2，PARALLEL_WRITE=CLOSED；B1.1 最小诊断切片 PASS、B1.2 正常真实路径通过但入口审核 BLOCKED、B1 未封板，B2–B5 未授权。

**B1.2a 实现方收口报告（2026-10-12，独立结果见基线 §8.12）**：上一轮三个问题已在当前路径收口，
但独立审核因新增默认测试隔离与清理失败传播 P1 裁定 BLOCKED，B1.2 不封板。
P1-1 启用后未执行不得 PASS：入口区分 NOT_RUN / ENVIRONMENT_BLOCKED / FAIL / PASS；
未发现 OpenCode、缺 launcher、查询失败、清理失败均非零退出且不打印 PASS；
同时修复“未发现分支提前 return 绕过最终退出码计算”的次级缺陷。
P1-2 版本探测有界：probe 增加自身 15s deadline，`finally` 释放 timer，
超时调用该次原始 `ManagedProcess.cancel` 并等待清理；停止未确认不认证成功，
超时前部分版本输出不令 `probe.ok=true`。
P2 逐次关联 control 证据：新增唯一判定函数 `tests/helpers/b12-control-evidence.ts`，
入口与受控回归共用同一实现；任一阶段记录缺失、INVALID、停止未确认即失败，
不得用另一阶段成功替代，也不按“最后一条/任意一条成功”归并。
三个新增 hermetic suite 进入默认清单，新真实入口仍 opt-in。
本机真实目录本轮实跑一次：1.18.35、`ok`、42 个模型、约 2.7s、bad=0。
详见 [项目基线 §8.11](PROJECT_BASELINE.md#811-b12a-两个-p1-与一个-p2-收口实现方实跑待独立复核)。
listed≠connected≠callable≠free 仍冻结；B1 整体 NOT SEALED，PARALLEL_WRITE=CLOSED，B2–B5 未授权。

### 6.4 B1.2a 当前独立审核结论

原两个 P1 与一个 P2 关闭；typecheck、model-catalog、contract（246/0、2 skipped）、
bounded-version（29/0）、control association（26/0）、ownership（60/0）、guard 和 diff check 均通过。
新默认 entry-failure suite 的 case 5 未设置受控 command，会调用真实 OpenCode；
以 command seam 模拟不可用，实得 25/1、exit=1。这不是旧的“缺失环境仍 exit=0”回归。
另对 association suite 的 owned 删除调用注入异常，实得 26/0、exit=0，却留下 8 个目录，
随后审核 probe 仅按本轮记录的路径回收，剩余 0。两个新 P1 都必须关闭。
PID-only 退出断言为非阻断 P2，本轮采用 Job validated terminated/空事实作为版本停止证据。
作者 7 PASS 真实目录查询未在本轮重跑；未跑 full suite、模型推理或 DSH/ClawChat 接入。
此报告对应 OpenCode 专项收口，DSH 作为开发工具与 DSH 已接入产品是不同事实。
审核快照分支 codex/b12a-review-blocked；main 和共享索引保持原状，详见基线 §8.12。

**B1.2b 实现方收口报告（2026-10-12；独立结论 BLOCKED，见 §6.4 与基线 §8.14）**：以下为实现方结果，不能据此认证清理 P1 已关闭。
P1-1 默认测试 hermetic：`b12-entry-failure-semantics` 每个 child 都显式获得本套件自写的 controlled fixture
（`--version` 与 `models` 均成功），不存在省略 controlled command 的 case，不会 fallback 到真实 Agent；
NOT_ENABLED case 显式关闭 opt-in；所有 child env 用副本。新增反证 case：OpenCode command 指向不存在绝对路径、
`APPDATA` 空目录、`PATH` 只含 node 与系统目录时，套件仍 37/0、exit=0。
P1-2 cleanup 失败进入退出码：三个新套件统一沿用 `model-catalog.test.ts` 已验证 ledger，
检查失败与 owned 删除失败共同决定退出码；各新增最小独立 child 回归，断言真实 status 非零并分别检查 signal/error。
P2 删除弱 PID 死亡断言：`pidAlive`/resident 存活观测/轮询全部移除，死亡证据只用本轮已有的
生产验证 Job `terminated` 与 `activeProcessesFinal=0` 记录，不新建 observer 或第二套死亡证明。
负控：把 `finalizeExitCode()` 临时改为忽略 cleanup 失败，三个套件分别 36/1、34/1、31/1、真实 exit=1，
证明回归有效；负控副本已删除，工作树无残留。
详见 [项目基线 §8.13](PROJECT_BASELINE.md#813-b12b-hermetic-测试与清理退出收口实现方实跑待独立复核)。
B1.2 标 READY FOR CODEX INDEPENDENT REVIEW；B1 整体 NOT SEALED，PARALLEL_WRITE=CLOSED，B2–B5 未授权。


### 6.4 B1.2b Codex 独立复核与上传（2026-10-12）

**BLOCKED**：真实 Agent 隔离 P1 与弱 PID 证据 P2 已关闭；清理 P1 未关闭。
version 套件 :452 保留旧 rmSync/catch best effort，随后才执行新 ledger 清理；
独立注入三个 owned 目录首次删除失败、后续成功，仍 35/0、真实 exit=0，失败未保留。
另有 P2：entry-failure :461 的 unreachable child 继承 opt-in；外部 opt-in=1 时独立实跑 35/2、exit=1。
前者删除旧重复 finalizer 即可；后者显式关闭该 NOT_RUN child 的 opt-in，并修正文案证据范围。

本轮独立验证：typecheck；entry 37/0；version 35/0；association 32/0；model-catalog 68/0；
isolation 5 opt-in/0 违规；ownership 60/0；diff check，常规全部 exit=0。
两个边界 probe 与常规结果分开记录；实现方负控/历史真实目录不算本轮重复验证。
本轮 owned b12 目录、report 及受控进程残留未发现；历史 foreign root 不删除、不按旧 PID 认证死亡。

仅更新现有两份文档，上传三个测试加两份文档的五文件 BLOCKED 增量，
分支 codex/b12b-review-blocked，父快照 5d43b19；main 和共享索引保持不变，不创建 PR。
详见项目基线 §8.14。B1 NOT SEALED、PARALLEL_WRITE=CLOSED、B2–B5 未授权不变。
未跑 full suite、真实 Agent/模型任务或 DSH/ClawChat 集成；未改生产实现。

### 6.5 B1.2c 实现方收口（2026-10-12，待独立复核）

P1（version 套件旧清理循环吞掉首次删除失败）：删除 `tests/b12-version-probe-bounded.test.ts` 中旧的
`tmpDirs` 删除循环、旧结果汇总与仅依赖 `failed` 的旧退出码块，只保留唯一 cleanup ledger finalizer；
本轮 owned 目录只经统一清理路径处理，首次删除失败进入 `cleanupFailures`，后续成功不抹去该失败，结果只汇总一次。
边界 A：未改工作树，隔离 `--require` 注入本套件自建 `b12vp` owned 目录第一次 `rmSync` 抛 EBUSY、后续放行；
真实套件 **35/0 但 exit=1**，ledger 保留原始失败（`…b12vp-I1TS52: injected…`），注入目标为唯一被保留的路径。
P2（unreachable 用例继承 ambient opt-in）：该 NOT_RUN child 显式设 `ORCH_B12_REAL_CATALOG: '0'`，
保留显式 opt-in=1 的失败对照，文案更正为目录入口而非整个套件；环境仍用 `childEnv()` 副本。
边界 B：外部 opt-in=1 + 不存在 command + 空 APPDATA + 仅 Node/Windows 的 PATH 下运行整个 entry-failure 套件，
修复后 **38/0、exit=0**（修复前 35/2、exit=1）；同环境显式 opt-in=1 的入口对照仍 `exit=1`，opt-in=0 为 `NOT_RUN exit=0`；未启动真实 Agent。
常规验证：typecheck PASS；entry 38/0；version 35/0；association 32/0；isolation 5 opt-in/0 违规；均 exit=0；`git diff --check` clean。
本轮 b12 owned 目录/report/受控进程残留 0；边界 A 遗留路径由 probe 按记录清理，未按枚举删除。
详见 [项目基线 §8.15](PROJECT_BASELINE.md#815-b12c-清理-finalizer-与-opt-in-显式化收口实现方实跑待独立复核)。
B1.2 标 READY FOR CODEX INDEPENDENT REVIEW；B1 整体 NOT SEALED，PARALLEL_WRITE=CLOSED，B2–B5 未授权。


### 6.6 B1.2c Codex 独立收口 PASS（2026-10-12）

剩余清理 P1 与 opt-in P2 均已独立确认关闭；§6.4 为历史 BLOCKED，当前结论为 PASS。
只删除 version 的旧重复 finalizer，并显式关闭 entry 的 NOT_RUN child opt-in，未修改生产实现。

独立主清理路径注入三个 owned 目录首次删除异常：检查 35/0，但 ledger 记三条原始失败，
真实 status=1、signal=null、error=null；probe 后续仅按记录路径清理，remaining 3→0，exitCode 仍 1。
独立 ambient opt-in=1/command 不存在/空 APPDATA/最小 PATH 下，整个 entry suite 38/0、status=0；
直接 ENTRY 显式 opt-in=1 仍 status=1，opt-in=0 为 NOT_RUN/status=0，signal/error 均 null。

本轮常规：typecheck；entry 38/0；version 35/0；association 32/0；isolation 5 opt-in/0 违规；
diff check，均 exit=0。上一轮 model-catalog/ownership 与历史真实目录不作本轮重跑结果。
本轮 owned b12 目录/report/受控进程无残留；foreign 桌面进程及历史目录未清理。

四文件增量上传分支 codex/b12c-review-pass，父提交 645e5b5；main/共享索引保持不变。
上传仅含两个测试、两份现有文档；Codex 没有修复实现或新建报告 MD。详见项目基线 §8.16。
B1 整体 NOT SEALED、PARALLEL_WRITE=CLOSED、B2–B5 未授权保持；DSH 产品适配未实现。
本轮未跑 full suite、真实 Agent/模型任务或 DSH/ClawChat 集成。

### 6.7 B1.3 DSH 接入 + 两层分配落档（实现方实跑，2026-10-12）

`npm run typecheck` PASS；`node tests/dsh-adapter.test.ts` **41/0、exit=0**（受控 fixture 经
`Orchestrator → AgentSession → CliJsonlTransport → contained ManagedProcess`，覆盖成功/非零/启动失败/cancel/deadline）；
受影响的 contract **248/0（2 skipped）**、unit **92/0**、orchestration **968/0**、workbuddy **137/0**、
cline **88/0**、containment-production **233/0**、execution-lifecycle **136/0**、ownership 守卫 **5 opt-in/0 违规**；
`git diff --check` clean。
DSH 本机 `--version` 为受控无推理探测（`cmd-wrapper`、0.1.5-rc.2）；未调用真实模型、未读凭据、未改本机配置。
本轮 owned 临时目录/observer/CLI 进程残留 **0**；`%TEMP%` 下 `dsh-*` 为 DSH 自身运行时产物（早于本轮），未删除。
两层分配为正式需求（功能 A/B），执行闭环仍按 B3/B4 授权推进；DSH 基础接入 ≠ 逐模型选择 ≠ B1 完成。
DSH 适配关键点：会话对 stderr 与不可解析 stdout 不走 `mapEvent`，故纯文本需由既有传输的
可选 `plainTextLines`（默认关）交付已解码 `data`，未新增 transport、未发明 JSON。
`containment-production` 在一次性批量运行中出现过 **1 次不可复现的间歇失败**（其后 16+ 次含组合运行均通过），
与 DSH 切片无关（`plainTextLines` 默认关闭），按“不重复重试直到偶然成功”未强行复现。
B1 整体 NOT SEALED、PARALLEL_WRITE=CLOSED、B2–B5 未授权。

### 6.8 B1.3 Codex 独立审核 BLOCKED（2026-10-12）

**P1**：DSH 最终 stdout 多行/空行丢失。独立 fixture 经实际 Orchestrator/Session/CLI transport/contained
ManagedProcess 输出 `const a = 1;\n\nconst b = 2;\n`，实际 result.output=`const a = 1;const b = 2;`，
仍为 succeeded、treeStopConfirmed=true。进程层已去掉换行并过滤空行，adapter 直接拼接，
所以只给现存行补换行不足以恢复原文。需最小修改保真路径并补真实链路回归；不新建执行器/transport，
不改变默认 JSONL 行为。Codex 本轮未修复实现或测试。

**P2**：Session 对 stderr 提前诊断并 return，DSH adapter 的 stderr mapEvent 实际不可达。
独立 reasoning fixture 为 progressCount=0、两条 stderr diagnostics；直接 mapEvent 单元测试不证明真实接线。
按既有诊断契约修正文档/测试声明或做最小明确接线；非零退出失败判定仍正常。

本轮独立：typecheck；dsh 41/0；contract 248/0（2 skipped）；unit 92/0；containment-production 233/0；
execution-lifecycle 136/0；isolation 5 opt-in/0 违规；diff check，实际 exit 均 0。
多行 probe 的 owned 根目录清理无失败且不再存在。实现方其他套件/真实 version 为历史报告，未重跑。
GitHub MCP 本轮成功读取上游固定提交 d743267 的 headless README；安装版本 0.1.5-rc.2 的协议以本机包为准，
不使用上游新参数猜测本机能力。

**P3**：实现方 containment 间歇失败本轮未复现；无具体 assertion，暂无法归因，保留观察。
未跑 full suite、真实模型/DSH 推理任务、读取凭据或改本机配置。
九文件快照上传 `codex/b13-review-blocked`，父 dde5c7c0；main/共享索引保持原状，不创建 PR。
详见基线 §9.7。B1 NOT SEALED、PARALLEL_WRITE=CLOSED、B2–B5 未授权；未进入前端。

### 6.9 B1.3a 纯文本保真与 stderr 契约收口（实现方实跑，2026-10-12）

仅关闭 §6.8 的一个 P1 与一个 P2。**P1 根因**：`emitCompleteLines` 去换行并跳空行，初版
`plainTextLines` 交付的是已拆行文本。**修复**：`ManagedProcess` 新增可选 `onStdoutText`
（逐字解码 chunk，`StringDecoder` 保 UTF-8 跨 chunk 完整），`CliJsonlTransport` 新增可选
`rawStdoutText`（默认关）交付逐字 `data`；默认 JSONL 路径字节不变，未新增 transport/authority。
真实链路精确相等断言覆盖：多行含首/中/尾空行、CRLF、1 字节分批 + 多字节 UTF-8、末尾无换行、
形似 JSON 的普通答案；`result.output` 与 `session.output` 事件拼接均精确相等。
**P2**：删除 DSH `mapEvent` 中不可达的 stderr 分支与 progress/native-signal 声明，保留
`parseDshErrorLine` 供 terminalPolicy；真实链路断言 reasoning/error 进 diagnostics、不入答案、非零仍 failed。

**负控**：隔离副本改回修复前路径（不覆盖工作树），`node tests/dsh-adapter.test.ts`
→ **exit=1、44/11**，失败即上述保真断言；恢复后 **55/0、exit=0**。

本轮实跑：typecheck PASS；dsh-adapter 55/0；contract 248/0（2 skipped）；unit 92/0；
execution-lifecycle 136/0；isolation 守卫 5 opt-in/0 违规；`git diff --check` clean。
`runtime.run`=1、新增 authority=0、默认 JSONL 兼容。**观察项**：一次批量 containment-production
出现 **232/1、exit=1**，失败 assertion `W3-9 and the writer had genuinely been active before it :: 1170->1170`
（`tests/containment-production.test.ts:969` 的 200ms 心跳增长比较）；同命令单独运行一次为 **233/0、exit=0**；
未循环重试，也不据此认证 containment 失效。
标 **READY FOR CODEX INDEPENDENT REVIEW**；B1 NOT SEALED、PARALLEL_WRITE=CLOSED、B2–B5 未授权。

### 6.10 B1.3a Codex 独立收口 PASS WITH P2（2026-10-12）

原输出保真 P1 与 stderr 契约 P2 已关闭。raw stdout 使用既有 StringDecoder，显式启用才绕过行拆分，
默认 JSONL/stderr 路径保持；无新增 transport/manager/authority/依赖。
独立 contained fixture 每字节间隔 8ms 输出 `\n中\r\n\n{"a":1}\r\n\nEND`，
result.output 与 18 个输出事件拼接均精确相等，treeStopConfirmed=true，stderr 仅作 diagnostic。
owned probe root 已删除、cleanup 无失败。
隔离内存 loader 负控去掉 DSH 文本换行，真实 suite 44/11、status=1、signal/error=null，工作树未改。

本轮独立：typecheck；dsh 55/0；contract 248/0（2 skipped）；unit 92/0；containment-production 233/0（一次）；
execution-lifecycle 136/0；isolation 5 opt-in/0 违规；diff check，正常 exit 均 0。
未跑 full suite、真实 DSH/model 推理任务或重复历史 version/目录探测，未读凭据或改本机配置。

保留非阻断 P2-A：DSH 测试 realChain 缺少异常路径 finally。
独立 child 在 owned fixture 首次写入时抛错，status=1、signal/error=null，汇总未执行且 owned root 残留；
审核 probe 仅按记录路径清理。此例没有启动进程，不据此宣称进程泄漏或假 PASS。
应复用既有 ledger 用 finally 清理并补异常 child 回归，不另建框架。

保留 P2-B：W3-9 在 before 之后立即 cancel，却要求停止后的 atStop>before。
及时停止可合法没有新增字节；200ms sleep 位于确认停止之后，不能当停止前的活跃采样窗口。
该失败不等于 confirmed Job 后代仍存活。本轮未复现，也未改此历史测试；后续应在取消前确认增长，
保留停止后无写入与 Job 停止确认断言。详见基线 §9.9。

六文件快照上传 codex/b13a-review-pass-with-p2，父 4b89534e；Codex 仅更新现有两份文档，
main 与共享索引保持原状。B1 NOT SEALED、PARALLEL_WRITE=CLOSED、B2–B5 未授权，未进入前端。

### 6.11 B1.4 用户 Agent × Model 选择最小闭环（实现方实跑，2026-10-12）

实现**自动 / 固定**与**项目 / 任务**两层选择，复用既有 `explicitPair`/`assignWorker`/`WorkbenchTaskSpec`/
`buildRunRequest`/`reassignTask`，新增 `SelectionSpec` + `resolveSelection` + config `selection` +
`--select` CLI + report `selection`。优先级 task > project > auto；fixed 由 Assignment 精确强制
（accept-or-refuse，不替换），不写调度 registry、不改费用授权；DSH+model 在 preflight 前拒绝；
固定任务被 `reassignTask` 锁（`fixed-selection-locked`）防自动 handoff 偷换。
**尚未实现**：角色默认、偏好模式、运行中改选、完整交互式暂停、两层协作组、Skill/MCP、动态额度、并行写。

实跑：typecheck PASS；`b14-selection` **28/0**；assignment 235/0、workbench 413/0、
initial-assignment-decision 37/0、continuation 138/0、handoff-production-round 312/0、
state-loop 169/0、round-result 293/0、planner 189/0、contract 248/0（2 skipped）、unit 92/0；
`dsh-adapter` 59/0、`containment-production` 234/0；ownership 守卫 5 opt-in/0 违规；`git diff --check` clean。
`runtime.run`=1、新增 authority=0、PARALLEL_WRITE=CLOSED。
实现方报告两项测试 P2 已关闭：DSH 真实链路 `finally` 清理 + child 清理失败回归；W3-9 改为取消前有界确认增长、
取消后保留停止/Job 空/不再写入强断言。该交接结论经独立复核有所修正，当前裁定见 §6.12。

### 6.12 B1.4 独立审核与下一步边界（2026-10-12）

**BLOCKED，唯一阻断项 P1**：项目 fixed A/MA → 动态 addTask 创建 r-s1-s1（继承 A/MA）→
decisionCapabilities.reassign 指定 B/MB → ok/migrated，Task 身份变成 B/MB。固定约束只登记初次 child，
没有随后续任务创建传播。独立 probe 未 dispatch；这是接力准入与身份约束失败，不是真实模型故障证明。
沿用现有选择/任务创建/reassign 路径修复并覆盖动态 child；不扩大为新框架。

独立 production round probe（受控 RuntimeRunner/reviewer）确认任务 fixed、项目 fixed、任务 auto 覆盖
三条正常路径已到实际派发与 complete。作者 b14-selection 28/0 仅覆盖到 buildRunRequest，不能单独称执行闭环。
P2：缺值 --select 被按默认 auto 执行；DSH fixture 写入在 finally 前，独立注入 status=1 后仍留目录（已按名清理）。
原 W3-9 P2 已关闭，强停止证据保留。P2 不单独阻断下一步；无需重新审核完整 W1–W5。

本轮独立：typecheck；b14 28/0、assignment 235/0、workbench 413/0、initial-assignment 37/0、
handoff-production-round 312/0、DSH 59/0、containment-production 234/0、contract 248/0（2 skipped）、
isolation 5 opt-in/0 违规、diff check PASS；正常命令 exit 均 0。未跑 full suite 或真实模型任务。
13 文件审核快照上传 codex/b14-review-blocked，父 bcceed2683854da7e0f30e673fbb080812c89dd6；
包含先前登记的模型执行中断计划，不代表实现接力恢复或费用授权。
B1 NOT SEALED、PARALLEL_WRITE=CLOSED、B2–B5 未授权；未进入前端。
