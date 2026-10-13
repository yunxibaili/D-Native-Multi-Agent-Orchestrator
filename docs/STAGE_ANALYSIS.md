# 后端阶段分析与下一任务

更新日期：2026-10-13
状态的唯一入口是 [项目基线](PROJECT_BASELINE.md)；本文描述差距与推进顺序，不另行封板。

## 1. 推进原则

这是个人 Windows 工作台。先完成用户能使用的短闭环，再补边界和能力广度。
B 编号是能力分区，不是必须全部按数字顺序完成的瀑布流程。
P0/P1 按实际影响处理；非阻断 P2 登记，不反复重审所有历史 T/W 阶段。
现有模型选择、身份、执行、保护和证据入口直接复用，不建设企业级权限平台或新的 manager。

两个产品功能不能混淆：
- A：跨角色独立任务，例如调研、实现、测试，各自具体 Agent × Model。
- B：同一目标 2–3 模型分工共建，各自 child task/会话，最终受控集成与验证。
本产品前端需求尚未确认；前端开发角色仅为后端编排示例。

## 2. 按使用价值排列的切片

| 顺序/切片 | 最小交付 | 明确不包含 |
|---|---|---|
| 已完成 B1.4a | 项目/任务 auto/fixed、动态后代固定锁、CLI/测试收口 | 不等于 B1 整体封板 |
| 已完成 B4.0 / B4.0a / B4.0b（独立 PASS WITH P2） | 有界候选、异构 DAG、CLI 顺序推进、验收材料、下游交接、既有审核和报告隔离的受控闭环 | 不等于真实 LAYA 判断质量、真实模型兼容性或整个 B4 完成 |
| B4.1 独立 BLOCKED | 受控分工/文件集成可用；恰好 N 个 pair 的 N 人组最后单候选被真实 provider 拒绝 | 先收口输入契约；只支持共享顺序工作区，不扩展合并引擎 |
| 下一建议 B4.1a | 唯一剩余候选显式约束规则、真实 provider 输入契约回归、失败报告与无交付负例 | 不伪造第二候选，不放宽 provider 全局校验，不进入 B4.2 |
| B3 小片 | Skill/MCP 只读目录、任务级选择、原生执行核对，按需上下文 | 不新增工具大脑或通用 MCP 网关 |
| B2 小片 | 免费依据与未知事实、预算授权、共享额度约束 | 不根据模型名猜免费，不静默新增支出 |
| B5 小片 | 模型中断/额度耗尽的有界恢复、检查点、接力和代表性验收 | 不盲重放写操作，不靠无输出判死亡 |
| 后续真实兼容性 | 支持选模型的实际 Agent/Model、会话隔离、最小用户授权任务 | fixture 不算真实模型证据 |
| F | 用户确认前端需求后再设计与实现 | 本轮不进入前端 |

**B4.0 系列保持独立封板；B4.1 独立 BLOCKED。下一建议仅 B4.1a 收口，以用户下发任务为授权；B4.2/B2/B3/B5 未启动。**
费用/工具能力未完成不妨碍 hermetic 工作流接线验证，但不能放宽真实运行准入。

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

### 3.2 下一建议 B4.1a：只修 provider 输入契约

1. 复用已有约束选择规则：0 个合法候选拒绝，多个才问 LAYA；唯一剩余合法候选用明确规则记录来源，
   再经同一 intent 校验和 Assignment 准入，不伪造 LAYA 比较/概率，也不放宽 provider 的单选拒绝。
2. 正式回归覆盖恰好 2 个 pair 的 duo、恰好 3 个 pair 的 trio；使用真实 provider 的本地输入校验或等价承重校验，
   HTTP/模型侧用受控 seam，不调用真实模型。保留重复/编造/不足/fixed/Git 拒绝。
3. report.collaboration 不把 agent/null 占位算作已选 pair；失败/未执行不能宣称已写入或已集成。
4. 让正式负例确实制造成员无文件/无交付/不接受，断言集成从不运行；不再只用正常成功 case 配失败标题。

分工计划、会话、材料交接、顺序执行和真实文件集成继续复用，不重写；只跑本片与受影响定向回归。

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
