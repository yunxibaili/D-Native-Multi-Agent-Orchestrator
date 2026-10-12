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
| B4.0 待收口 / 下一任务 B4.0a | 有界候选与 Workbench 显式推进已接线；补真实 CLI 的 Verification/顺序推进/未完成状态/最终 Review/Result，并修正非法计划残留 | 不新增工作流引擎，不把 exit=0 自动当业务验收，不开放并行写 |
| 后续 B4.1 | 同目标 2–3 模型按职责共建、交付与集成；写任务先顺序，READ 协作沿已有 fan-out | 不把 READ fan-out 改名成 WRITE，不复制 taskId 并发执行 |
| B3 小片 | Skill/MCP 只读目录、任务级选择、原生执行核对，按需上下文 | 不新增工具大脑或通用 MCP 网关 |
| B2 小片 | 免费依据与未知事实、预算授权、共享额度约束 | 不根据模型名猜免费，不静默新增支出 |
| B5 小片 | 模型中断/额度耗尽的有界恢复、检查点、接力和代表性验收 | 不盲重放写操作，不靠无输出判死亡 |
| 后续真实兼容性 | 支持选模型的实际 Agent/Model、会话隔离、最小用户授权任务 | fixture 不算真实模型证据 |
| F | 用户确认前端需求后再设计与实现 | 本轮不进入前端 |

**B4.0 独立审核 BLOCKED；下一建议范围仅 B4.0a 收口，具体以用户下发任务为授权。B4.1/B2/B3/B5 未授权。**
费用/工具能力未完成不妨碍 hermetic 工作流接线验证，但不能放宽真实运行准入。

## 3. B4.0 整合任务范围

**状态：部分实现，CLI 闭环独立验证未通过，见 [项目基线 §5.4](PROJECT_BASELINE.md) 与 §8 证据。**
以下为原始范围与下一片验收依据，不是完成声明。

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

### 3.1 下一建议任务 B4.0a：只补缺失的 CLI 闭环

先读 round-cli 的单次 decision cycle、既有 complete/Verification、依赖准入、结果和 Human Gate，
复用已有有界推进/停止模式；本地小范围接线修复无需重新调查或安装通用编排框架。

1. 仅 workflow opt-in 有界推进：已有 Verification 正向接受后再调度下游，完成、失败、拒绝、待人确认或无进展时明确停止。
   不能自动 complete 所有 exit=0，也不能无限调用 LAYA；旧非 opt-in 单轮语义保留。
2. 计划成员尚未执行/验证不能被 report.executionIncomplete=false 掩盖；通过既有结果/Human Gate 表达原因。
   最终独立 Review 看到实际各步 Attempt/RunResult，不能在只完成 research 时宣称整个 workflow 完成。
3. 非法候选在创建根前用既有 validator/commit 约定校验；不建新事务层。测试实际调用 planWithCandidates，
   比较失败前后 store，确认修正后同 ID 可重试；不要只测纯 validator。
4. 补真实 CLI hermetic 成功 full/lean、上游失败/Verification 拒绝或缺失、无进展的回归；
   fixture 输出不同材料标记，下游断言实际内容；不能由测试在 CLI 外手动 complete 来代替闭环。
5. 非 Git 的顺序写准入限制须有明确结果；如果适配既有资源门，只依据真实依赖/存活执行事实，
   保留对独立或仍存活并行工作的拒绝。不能一律关闭资源门或假称 PARALLEL_WRITE 已开放。

只运行 typecheck、b40-workflow 与受影响的现有定向回归及 diff check，不跑 full suite/真实模型。
更新现有基线/阶段分析并区分本轮、历史和未验证证据，不新增报告 MD；实现方仍不 commit/push。
这是一片可独立验证的修复，不扩展角色平台、Skill/MCP、费用、恢复或功能 B。

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
