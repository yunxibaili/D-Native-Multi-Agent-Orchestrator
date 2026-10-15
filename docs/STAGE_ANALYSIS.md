# 后端阶段分析与下一任务

更新日期：2026-10-15
状态的唯一入口是 [项目基线](PROJECT_BASELINE.md)；本文描述差距与推进顺序，不另行封板。

当前路线的最新范围：B4.7.3固定free duo代表样本已独立真实PASS（两模型/三任务/可执行产物/独立负控/Job空），累计产品会话5/5用尽。该样本不是整个后端验收，真实LAYA/Skill-MCP/动态额度等仍有缺口；B2.2显式候选接线代码已独立PASS（委派报告P2保留）；随后LAYA-ENV.1找回既有0.3.21并恢复固定缓存，真实离线CUDA加载/health独立通过，检查后服务已停止。随后LAYA-DECISION.1已获4次本地调用授权，首个中文分类因action协议元数据被客户端误作参数而拒绝，1/4后停止，余3项未跑；服务已停止/Job空。LAYA-COMPAT.1现已由OpenCode首轮修复并获Codex独立hermetic/捕获回放PASS；随后LAYA-DECISION.2经用户新授权真实4/4本地typed验收独立PASS，服务已停/Job空；随后LAYA-ROUND.1只读审核发现P1：原生next_action缺complete必需taskId，受控协议反例拒绝；下一候选LAYA-ACTION.1需授权最小目标桥接。估算仍68/100，不自动修复/推理或进入F0。事实/证据只见 [PROJECT_BASELINE.md](PROJECT_BASELINE.md)，建议范围见 [NEXT_TASK.md](NEXT_TASK.md)。下文旧说明不能覆盖最新边界。

## 1. 推进原则

这是个人 Windows 工作台。先完成用户能使用的短闭环，再补边界和能力广度。
B 编号是能力分区，不是必须全部按数字顺序完成的瀑布流程。
P0/P1 按实际影响处理；非阻断 P2 登记，不反复重审所有历史 T/W 阶段。
现有模型选择、身份、执行、保护和证据入口直接复用，不建设企业级权限平台或新的 manager。

两个产品功能不能混淆：
- A：跨角色独立任务，例如调研、实现、测试，各自具体 Agent × Model。
- B：同一目标 2–3 模型分工共建，各自 child task/会话，最终受控集成与验证。
正式工作台前端需求尚未确认；本机独立进度页本轮已授权，页面不接执行控制。

## 2. 依新草案重排

当前状态仍只在唯一基线维护；完整任务顺序见 [后端交付计划](BACKEND_DELIVERY_PLAN.md)，
B4.2/B4.2a 已独立 PASS WITH P2；B4.3a 最小阶段确认入口已独立 PASS：剩余 legacy 单点通过写前拒绝关闭（见[下一任务](NEXT_TASK.md)；B4.4随后已独立通过，当前B4.5/B4.5a受控最小范围已独立通过）。旧“先真实多模型/角色默认”的宽泛 B4.3 建议由本计划替代。

B4.2a 合法依赖收口（独立 PASS WITH P2）→ B4.3 需求/阶段确认（已实现）→ B4.3a 确认绑定/材料可达收口（已实现）→ B4.4 有据交付 → B4.5 Git 顺序协作 →
B3.1 原生Skill（有界完成）→ B3.2 原生MCP选择/观察（有界完成）→ B2.1 模型池/费用 → B4.6 检查点监督 → B5.1 中断接力 → B4.7 代表性真实验收。
F0 正式前端需求另行确认；本机进度页已授权，不表示正式前端已开始。

B4.3a/B4.4保持独立通过；B4.5/B4.5a受控最小Git协作与审核保护已通过。B3.1原生Skill有界切片现已独立通过，B3.2原生MCP选择与观察有界切片已独立通过，当前B2.1/B2.1a用户声明池与最终启动准入已独立PASS，B4.6a最小同进程检查点亦已独立通过（该文案P2在B5.1关闭），B5.1有界接力已交付，下一候选B4.7待模型/费用/数据确认；角色默认/prefer、运行中改选和全面实时监督后置。
草案新增目标纳入路线，具体实施仍逐阶段确认；不以整份草案作为全部代码实现授权。

## 3. B4.0 整合任务范围

**状态：独立 PASS WITH P2，具体适用范围和证据见 [项目基线 §5.4](PROJECT_BASELINE.md) 与 §8。**
以下保留原始范围与收口依据，不扩展封板范围。

目标：让当前“按 shape 复制同类任务”迈向“职责不同、依赖真实、成果实际消费”的最小工作流。

先调查并复用：
- WorkbenchTaskSpec、CandidateTask、planFromSpec、planTasks、validateCandidateDag、commitPlan。
- initial-assignment、explicitPair、auto/fixed、Assignment、SessionRegistry、scheduler/dispatch。
- briefFor/buildTaskBrief、handoff/执行证据、统一 Review 与 Human Gate。
- fanout 仅用于理解已有容器/child 身份，不改其 READ-only 契约。

实现最小点：
1. 在既有入口 opt-in 提交/选择少量有界候选计划；可先用人工输入或明确模板，不新增规划 Agent 调用。
   LAYA 从合法候选中选计划；它不生成自由文本 DAG，不编造不存在的模型/工具。
2. 调研、实现、测试形成独立候选任务，taskType 用现有 research/implementation/test。
   前后端是角色标签，均映射 implementation；不扩建整套角色权限系统。
3. 各任务带目标、依赖、输入引用、交付物/验收与允许写入范围。复用字段，只有缺失时加必要元数据。
   文件范围的提示声明不是强隔离证据，不改变现有资源/工作区保护。
4. 每任务由现有 LAYA pair 选择与 Assignment 准入落实到具体模型；用户 fixed 仍优先，DSH 不支持的选项拒绝。
5. 本片按依赖顺序执行；没有真实完成前置任务不得执行下游，也不能引用其他任务/旧 Attempt 伪造交付。
   复用已有成功/依赖/verification 条件，不私自把 Runtime exit=0 改成业务验收。
6. 下游 brief 实际包含上游相关交付引用/有界内容；报告列任务、pair、依赖、交付及失败阻塞。
7. 最后进入既有独立 Review/Verification 与 Human Gate；全部终态不直接等于通过验收。
   旧入口未 opt-in 时保持兼容。

退出证据必须经过当前 CLI/Workbench → Planner/TaskStore → Assignment → Scheduler/executeTask
→ 受控 Runtime → Attempt/下游 brief → 现有 Review/Result，不能仅测 DTO 或 buildRunRequest。
先做最小成功链和一个前置失败阻止下游的回归，另覆盖 fixed 不被计划改写与非法 DAG 无部分提交。
不跑 full suite，不调用真实模型，不改本机 Agent/API 配置。
DSH 缺逐请求模型支持、Skill/MCP 未闭环与费用未知必须列明，不能伪造已支持来通过此片。

### 3.1 B4.0b 收口记录

有界循环、无进展停止、状态门、下游交接和非 Git 顺序写已通过定向验证，不重写。
先读 runOneCycle、orchestrationDecisionRequest、completeTask、已有 handoff/Attempt 与 reviewer fixture。
本地小范围接线修复无需重新调查或安装通用编排框架。

1. 给 workflow 的现有 DecisionRequest 接入目标、待验证任务验收条件、同次执行有界输出/材料引用。
   优先复用 handoff/brief 与既有证据来源，缺事实保持未知；不广播完整历史、不造第二套证据或验证 authority。
   complete 仍由 LAYA 显式决定并通过既有 applyVerification；不能靠看见 to_verify 就盲目 complete。
2. 用受控 provider 检查实际请求材料，再作接受/拒绝或 wait；缺材料不得 complete，下游不启动。
   保留 full/lean 成功链、上游失败、fixed、无进展/硬上限，检查最终 Review 请求含每步实际材料。
3. 补 candidate.taskId==spec.taskId、首 candidate.parentTaskId==null 写前拒绝，复用既有校验/commit 约定。
   真实调用 planWithCandidates 比较拒绝前后 store，并验证修正后同 ID 可重试；无需事务框架。
4. 修正新套件 reviewer fixture 的 frame.data.text 与必需 verdict 字段，断言 completed/pass 与真实 review Attempt；
   另保留无效 verdict 为失败的对照，不能只断言 review 被调用。
5. 默认 hermetic suite 隔离 ORCH_HOME/round-result 发布目录。复用已有 owned 环境/路径 seam；
   不原地修改共享环境，不清理 foreign 目录；验证调用者报告目录未被覆盖。

只运行 typecheck、b40a-cli-workflow、b40-workflow 与受影响的现有定向回归及 diff check，不跑 full suite/真实模型。
更新现有基线/阶段分析并区分本轮、历史和未验证证据，不新增报告 MD；实现方仍不 commit/push。
这是一片可独立验证的修复，不扩展角色平台、Skill/MCP、费用、恢复或功能 B。

2026-10-13 独立审核确认上述原定主 P1 和三个 P2 已关闭。
剩余测试 P2：review Attempt 断言没有真正检查记录，负控不追加时仍 39/0；正常记录由独立 probe 确认。
已在 B4.1 测试中补强；本轮独立负控不追加时 38/4、exit=1，旧 P2 关闭，不再单开封板轮次。
据此进入 B4.1 功能 B 的顺序执行切片；当前独立收口范围见 §3.2，不开放并行写。

### 3.2 B4.1a 独立 PASS：provider 输入契约、报告事实与未交付负例收口

**状态：独立 PASS（`b41-collab-group` 91/0）。** 以下保留收口范围；证据和封板边界见唯一基线。

1. 复用已有约束选择规则：0 个合法候选拒绝，多个才问 LAYA；唯一剩余合法候选用明确规则（`collaboration-constraint`）
   记录来源，再经同一 intent 校验和 Assignment 准入，不伪造 LAYA 比较/概率，也不放宽 provider 的单选拒绝。
2. 正式回归覆盖恰好 2 个 pair 的 duo、恰好 3 个 pair 的 trio；使用真实 provider 的本地输入校验或等价承重校验
   （`createLayaDecisionProvider` + `fetchImpl` seam），HTTP/模型侧用受控 seam，不调用真实模型。
   保留重复/编造/不足/fixed/Git 拒绝。
3. report.collaboration 不把 agent/null 占位算作已选 pair；失败/未执行不能宣称已写入或已集成。
4. 正式负例确实制造成员无文件/无交付/不接受，断言集成从不运行；不再只用正常成功 case 配失败标题。

分工计划、会话、材料交接、顺序执行和真实文件集成继续复用，未重写；只跑本片与受影响定向回归。
独立真实 provider + 受控 fetch 的 CLI probe：exact-2/3 问题候选数分别 [2]/[3,2]，完整成功。
退回旧单选提问路径的内存负控 73/18、exit=1；报告与真实缺交付负例均确认关闭。
不再追加封板轮次；后续真实兼容性、角色选择层级、Git 交付、工具/费用/恢复仍按小片明确授权。

### 3.3 B4.2 已实现；B4.2a 收口合法多入口与拒绝报告

**状态：B4.2 已实现（`b42-plan-file` 44/0）；B4.2a 收口后 61/0，交独立审核。**

问题：内置计划的职责和文件范围写死，不能适配不同项目。最小修复是让用户用一个 JSON 计划文件表达有界候选，
经既有 CLI/执行链完成任务，不新增配置平台、DSL、框架或第二次规划模型调用。

- 入口：`--workflow-plan <file>`（配合 `--workflow sequential|collaborate`）。文件 `kind` 必须与 `--workflow`
  一致；`plans` 为有界候选（`sequential` 步骤链或 `collaborate` 成员 + 1-based `integratorMember`）。
- 字段：`role`、既有 `taskType`、可选 `fileScope`、`deliverable`、可选 `dependencies`（角色名，缺省为链）。
- 边界：`plan-file.ts` 在写入前拒绝未知 kind/taskType、重复角色/plan id、悬空/自/环依赖、越界集成者、
  超成员/步骤/计划数、超长字段与超大文件；taskId 由系统从 root 生成，文件不能命名 taskId。
- 选择：多候选走既有 `decideWorkflowPlan`；单候选按规则记录来源、不发单选问题；`--workflow-choice` 必须命中
  文件实际提供的 id，否则拒绝不替换。内置 full/lean/duo/trio 行为不变。
- 复用：同一 `validateCandidateDag`/`commitPlan`/Assignment/Session/Scheduler/Verification/Review；
  协作成员仍 2–3、集成者属成员且复用其 pair、集成任务独立 task/session；顺序执行、写并发=1、文件范围仅声明。
- B4.2a 收口：计划文件的步骤**恒为顺序链**（sequential 工作流契约，`PARALLEL_WRITE=CLOSED`）；用户声明的
  `dependencies` 是**额外前向边**并保留，链边在校验前加入，因此显式 `[]` 的多入口写任务按序完成、最大有效写者=1，
  而“显式依赖 + 默认链”形成的环在写前按 `dependency-cycle` 拒绝、无部分任务；`continue` 未准入时
  `decision.note`/`report.decision.code` 从 receipt 如实投影真实 gate 拒绝（任务+码+原因），区分等容量与被拒。
- 未包含：Git 隔离合并、真实模型兼容性、角色默认/prefer/运行中改选、Skill/MCP、费用与掉线恢复。

### 3.4 B4.3/B4.3a：阶段确认入口与绑定收口

**状态：B4.3/B4.3a 最小 opt-in 阶段入口独立 PASS；legacy 单点已关闭，b43 36/0。完整产品批准链及真实模型未验收。**

问题：用户需要一个入口说明“当前确认的需求/预期效果、当前阶段范围与验收材料”，只执行本阶段；材料存在、
JSON 可解析、LAYA 选中计划都不能代替用户确认。最小修复是显式 opt-in 的材料 + 用户确认入口，复用既有链。

- 入口：`--stage <file>`（JSON：`stageId`/`scope`/`requirement`/`acceptance`，可选 `planRef`）+ `--confirm <digest>`；
  `--stage-check` 为只读预检（打印有效计划/范围摘要与 digest，不建任务、不调用）；阶段入口必须带受支持的 --workflow。
- 自我批准拒绝：`parseStageMaterial` 拒绝任何 `approved`/`confirmed`/… 字段；确认只来自用户本次调用；
  gate 在任何外部调用前本地判定。
- B4.3a 绑定：确认 digest（`stageBindingDigest`）覆盖材料 + objective + 工作流模式 + **有效计划内容**
  （role/taskType/fileScope/deliverable/dependencies/集成责任）+ planRef；计划文件在 gate 处读取并冻结一次，
  plan 块复用同一对象；`planRef` 必须命中有效计划 id 或计划文件本身。计划内容/目标/范围变化使旧确认失效；
  仅键序/空白变化不改变标准化对象。此结论限显式 sequential/collaborate；无受支持 workflow 的 stage 入口写前拒绝，无 stage 的旧入口实际执行保持。
- B4.3a 材料交付：材料**完整嵌入**（`stageMaterialEmbed`，不截断）进入 objective → 任务验收条件/brief/验收材料；
  超出 `STAGE_EMBED_MAX_CHARS` 时写前明确拒绝（`too-large-to-embed`），不静默截断、不依赖引用可达性。
- 复用同一 plan-file/planWithCandidates/Assignment/Scheduler/Verification/Review；结束 `automaticPostRoundAction=NONE`；
  旧入口不变；附带关闭 B4.2a 的等待/拒绝分类 P2。
- 未包含：完整需求访谈/审批平台、跨阶段自主规划、真实模型、实时监督、Git 合并、角色默认/prefer、Skill/MCP、
  费用、掉线恢复、前端、并行写。

### 3.5 B4.4：有出处的交接和用户交付视图

最小受控范围独立 PASS。复用现有 RoundResult、Task/Attempt 和 Workbench 的同次 RunResult 映射。
同一纯 renderRoundDelivery 进入完整报告与实际非 JSON CLI，不新建报告/材料仓库或状态权威。
任务完整验收目标、声明产物、观察到的写入/命令、日志与未知/过期/阻塞各有来源；命令不被当作测试 verdict。
首次独立审查发现 rework 证据被剔除、分类缺失被写成从未执行；唯一返工在共享投影修正，独立 probe 和定向回归通过。
具体数量/真实模型/中断与完成证据只在唯一基线维护；不把 fixture 提升为产品真实 Agent 或产物物理认证。
B4.4保持通过；B4.5及B4.5a随后在2026-10-14完成受控最小Git协作收口，准确状态只见唯一基线。

## 4. 两层功能、免费与能力的后续连接

B4.1 复用同一套任务、选择与交付，不新增 TeamStore/WorkerManager/第二个 DAG。
组内写任务先顺序；将来开放并行写需独立范围、隔离、集成与停止证据及明确授权。
角色默认与 prefer 可在出现实际使用需求时扩展现有 SelectionSpec，不作为 B4.0 前置框架。
Skill/MCP 请求、实际加载、调用证据分开；原生 Agent 不能强制限制时如实拒绝必要硬约束。
费用覆盖研究/实现/审核/辅助模型和收费工具；固定付费模型不构成授权。

## 5. 模型中途掉线后续计划

见 [后端需求 §10.1](BACKEND_REQUIREMENTS.md#101-执行中模型中断后续边界收口项尚未实现验收)。
流断开、限流、额度/认证/服务错误、Agent 崩溃和未知分别记录；静默不直接证明死亡。
重试受总时限/次数/预算限制，考虑已发生写入；旧执行停止未确认时不允许第二个有效写者。
保留已完成工作与证据，fixed 不偷换，无合格免费候选不转付费，不承诺原生隐藏上下文迁移。
这些在恢复切片统一实现和验收，不要求 B4.0 提前完成全套故障恢复。

## 6. 调研与采用结论

2026-10-13 B4.1 实现方报告：其环境未暴露 GitHub MCP，改用公开检索，参考
coordinated-agent-team、garelier、ChatDev/MACOG/MOSAICO 等分工、交付与集成方法。
未提供完整仓库链接、版本与许可核验记录；本轮独立审核未核实这些项目的成熟度或可直接采用性，
不把实现方检索描述提升为独立核实事实，也不把其环境的 MCP 状态推广为所有会话的工具状态。
本片实际复用经源码确认的是当前仓库 CandidateTask/Assignment/Session/Scheduler/Verification/Review，
没有复制上述项目代码、引入框架或迁移服务/UI。外部方法参考不替代本地 provider 契约验证。

2026-10-12 已通过 GitHub MCP 核实 OrchestratorInc/agent-orchestrator 的公开仓库与 README：
项目 Apache-2.0、未归档，描述每任务独立 agent/workspace、选模型与规划分工，提供 Windows 安装包。
这里只参考任务/上下文/工作区划分；未安装、未证明它的 Windows containment 与本项目等价，不迁移其服务/UI。
许可证与 README 不构成安全审计或可直接替换的结论。

[Anthropic workflow 方法](https://www.anthropic.com/engineering/building-effective-agents) 与
[LangGraph workflow 文档](https://docs.langchain.com/oss/python/langgraph/workflows-agents) 可参考顺序交付、
orchestrator-workers 和聚合模式；采用方法，不引入框架或 Python 运行时。
ClawChat 存在多个同名公开仓库，当前没有唯一确认的目标地址；不将搜索命中擅自当作用户指定项目，
也不采用许可与后端适用性未核实的代码。最直接可复用能力仍在当前仓库。

## 历史备份

本轮把基线和阶段分析中的重复审核流水精简为当前事实与证据索引；没有删除代码、测试或有效契约。
完整整理前文档已在远端 [098279e](https://github.com/yunxibaili/D-Native-Multi-Agent-Orchestrator/commit/098279e6da454554469c581e6c6482c6445f53cf)。
更早备份标签 archive/pre-backend-requirements-2026-10-11，内容提交
[9f12a3b](https://github.com/yunxibaili/D-Native-Multi-Agent-Orchestrator/commit/9f12a3bf475ac47e4e6b2b2dd407ed09811610b5)。

只读查看：

    git show 098279e6da454554469c581e6c6482c6445f53cf:docs/PROJECT_BASELINE.md
    git show archive/pre-backend-requirements-2026-10-11:docs/PHASE5B_MULTI_AGENT_ARCHITECTURE.md

忽略的依赖、编译产物、本机凭据与临时资源不在 Git 备份范围；本轮不操作这些内容。

## 本机页面维护

每次推进后更新唯一基线事实和 project-progress JSON 快照，运行 `node project-progress/refresh.mjs`。
页面、数据、预览脚本和旧 UI 本地备份均禁止入 Git；旧 temporary-dashboard 的 20 个源码文件已本机备份；递归删除被工具安全策略拒绝，目录仍在，待用户手动删除。
页面是静态/只读维护视图，刷新不调用 Agent、不重新探测额度、不自动推进任务。

## 本轮 B4.2a 独立结论

合法空依赖计划顺序执行、成员文件实际集成、混合环写前拒绝和资源拒绝报告主场景已确认。
原 P1 关闭；非阻断 P2 为 skipped 的 dependency-unmet 分类与混合 receipt 主码选择，随 B4.3 小修，不再单独封板。
当前下一任务是显式需求/阶段材料和用户确认，不自动开始真实模型验收或正式前端。
定向验证、独立 probe 与未检查范围只在唯一基线记录；本机页面已按基线刷新，仍不入 Git。

## 本轮 B4.3a 独立结论

Codex 先确定范围，再以 opencode-agent implement 委派；两次 worker 的真实 session 元数据均确认
opencode-go/deepseek-v4.1-flash。首次实现 guard 正确；一次 bounded rework 加强旧入口兼容断言到实际 requests=1/exit=0。
独立最终 typecheck PASS，b43 36/0、b42 61/0、b40a 42/0、b14 46/0、round-result 293/0、isolation 守卫通过。
独立内存负控关闭 guard 时 3 项新拒绝回归失败（33/3、exit=1），未改磁盘源码。
最小阶段确认入口受控范围独立 PASS；B4.4 仅下一候选，不自动开始。
源码/测试由 OpenCode 修改，Codex 只维护既有文档和本机进度页；未 Git 写流程、full suite 或产品真实模型调用。
历史 B4.3 reviewer worktree 清理限制保留，不为本片绕过工具拒绝。

## 本轮 B4.4 独立结论

最小有出处交付视图独立 PASS；首次实现验证中断后核对现有 patch，没有重复启动整个任务。
仅一次 bounded rework 关闭两处已复现投影问题；最终独立 typecheck、全部选定定向 suite 与 diff check 通过。
PARALLEL_WRITE=CLOSED，未进入 B4.5 或正式前端；本机进度页与唯一基线同步。

## 历史 B4.5 / B4.5a 收口与当时下一候选

单组隔离worktree复用既有权威实现；审核cwd/子目录语义、运行期Claim保护和Windows scope归一化均已独立关闭。
只保证Git根目录、committed base、组内顺序写的受控最小范围；不将fixture提升为真实Agent兼容性。
B4.5a结束时的下一候选B3.1：先调查一个本机Agent原生Skill/MCP入口，复用现有intent/capability/证据链，完成目录→选择→实际加载/调用核对。
不先建设通用MCP网关，不由目录推断授权或已调用；具体有界任务在用户下发后形成。
PARALLEL_WRITE=CLOSED，B1/B4整体未封板；B4.5a当时没有启动B3.1或正式前端；随后B3.1已获用户授权并独立通过，当前事实与估算只见唯一基线。

## B3.1 本轮推进与下一切片

用户授权后已交付原生Skill最小闭环，复用现有DecisionProvider、TaskIntent/brief、Assignment、dispatch与RunResult工具事件；独立64/0及相关定向回归通过，唯一返工关闭ownership守卫误触发和跨Agent文本关联问题。详细证据只见唯一基线，不宣称真实Agent加载或token收益。
原生Skill候选是用户声明元数据，不是自动扫描；已选择请求为advisory，非权限控制。B3整体不封板。B3.1结束时下一候选为B3.2，随后已获用户授权并独立通过；不新增通用网关或Agent配置管理平台。PARALLEL_WRITE保持CLOSED。

## B3.2 本轮独立结论与下一候选

原生MCP具体工具的用户声明候选、LAYA选择、TaskIntent/brief与同任务latest-run名称匹配观察受控闭环独立PASS。直接复用B3.1测试入口，旧check调用点和条件未变，扩展套件119/0；同版本adapter.mapEvent受控frame与独立CLI duo/碰撞/跨Agent probes均通过。首轮无需返工，两个独立内存负控有真实失败。
目录不是连接/授权；同名事件不是协议身份认证，advisory选择也不能裁剪工具定义。真实MCP/Skill调用和Token收益留范围明确后的opt-in验收。B3整体未封板；下一候选B2.1先调查用户模型池/费用准入复用点，再做最小策略闭环，尚未授权。具体证据与估算只见唯一基线。

## B2.1 本轮独立结论与最小下一片

独立BLOCKED：限定实现与155/0等定向验证完成，复合键误放行P1已关闭；补充逻辑probe复现准备工作区后到期仍启动。B2.1a只补已有最终同步启动区域的准入，优先于B4.6，不重写模型池/费用平台。P1关闭前不提升能力信用或宣称费用规则完整；固定分母估算保持原值，详见唯一基线。后续角色默认、硬费用预算、恢复和真实验收仍分片授权。

## B2.1a 本轮独立结论

原最终启动检查P1已关闭：原阻塞probe变为runtime0，179/0覆盖保留原155条，两内存负控证明最终gate和实际claim释放承重。首轮无需返工，2文件范围；B2.1/B2.1a受控最小准入闭环独立PASS，B2 overall不封板。
下一候选B4.6先看已有检查点和用户纠偏入口，只补实际缺口；不把用户声明池提升为真实免费、USD硬预算、全流程费用或自动接力。固定100分母估算只增加已交付的模型池约束和费用声明准入能力，具体63/100及边界见唯一基线。

## B4.6a 最小检查点的边界与下一切片

同进程显式用户检查点复用既有RunResult/Attempt、CLI有界循环、Verification/Assignment/Scheduler；不做常驻监督Agent、持久化审批/恢复框架。continue不是验收或费用豁免；stop保留已有状态/文件并阻止后续执行。原有未完成Review原因泛称fan-out的P2不影响阻断，独立状态/证据只见唯一基线。
下一候选B5.1先调查断流/限流/额度/认证/崩溃和已有deadline/cancel/continuation的真实差距，选择一个受控有界场景；旧执行树停止未确认时绝不接力，fixed不擅自换模型，缺合格声明池不转付费。既有历史材料直接复用，不先建设恢复数据库。真实模型授权与正式前端仍单独确认。

## B5.1 本轮独立结论与最小下一片

首版定向绿但workflow有TDZ/提前迁移/错误fromModel；唯一返工收口，独立170/416及原CLI探针、6池接力、2内存负控通过，旧120/312条件保留。仅已知session_failure的停止安全/具体pair子集PASS WITH P2；外层委派监测提前返回与最初两个探针owner路径未记录如实列入唯一基线。原B4.6a Review文案P2关闭。恢复任务to_verify不自动完成全workflow，真实协议分类/实际模型/跨进程续跑后续。下一候选B4.7先明确真实模型、调用上限、费用和数据再小样本验收；本片不提前执行，不进入正式前端。

## B4.7 调用前准备

现有接口和owned测试入口已只读核对；先做新建隔离demo的实现→测试两步，单pair亦可部分验收，两个pair后再duo。等用户明确实际模型/费用/次数/数据才调用真实Agent；自动review和真实LAYA单列证据与费用，不用fake补PASS。官方Go可启用超额余额，不能由列出/订阅推出零费用。只读准备不加完成信用，不因B4.7等待参数重开已完成代码或建新框架。当前事实仅见唯一基线。
