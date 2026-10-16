# 工程研究参考索引（原20项 + Owner新增3项）

核对日期：2026-10-16。用途：支撑 [产品方向](PRODUCT_DIRECTION.md) 和 [最小交付路线](BACKEND_DELIVERY_PLAN.md)，不是依赖安装清单、项目效果证明或引入授权。

上轮Owner明确给出#1、#11、#18–#20；原#2–#10、#12–#17清单未提供，其补选标记保留，并非还原未知清单。上轮“新增四份”只实际列三个编号，原20项没有虚构条目。本次2026-10-16新授权明确补充Agentless、OpenAI Agents SDK、A2A，新增为#21–#23，**不是声称它们已在上轮索引里**。

分类由本索引定义：A 需求/计划/角色协作；B 模型/资源/成本准入；C 执行/产物/测试/审核；D 人工监督/停止/恢复；E 上下文/工具/复用。

核验说明：实际打开原始论文摘要页、官方项目/文档，必要时通过 GitHub MCP 读取正文；“摘要已核验”不代表逐页读完论文。持续文档标明 n.d.，不猜初版年份。只借鉴明确机制，不比较未测效果，不移植代码；因此本轮不以许可证/Windows 兼容性已全面审核为由宣称可直接采用。若未来引入代码，须另外核对许可证、版本、维护与本机兼容性。

## 索引

| # | 资料 | 年份/版本 | 类别 | 核验状态 |
|---|---|---|---|---|
| 1 | MetaGPT | 2023 论文 | A | 官方仓库及原始摘要已取得 |
| 2 | ChatDev（补选） | 2023 论文 | A | 原始摘要及官方仓库已取得 |
| 3 | AutoGen（补选） | 2023 论文 | A | 原始摘要及官方仓库已取得 |
| 4 | Magentic-One（补选） | 2024 论文 | A | 原始摘要与官方使用文档已取得 |
| 5 | MAST（补选） | 2025 论文 | A/C | 原始摘要已取得；不声称通读全文 |
| 6 | RouteLLM（补选） | 2024 论文 | B | 原始摘要及官方仓库已取得 |
| 7 | FrugalGPT（补选） | 2023 论文 | B | 原始摘要已取得；不声称通读全文 |
| 8 | MCP Tools（补选） | 2025-06-18 规范 | B/E | 官方规范正文已取得 |
| 9 | Spec Kit（补选） | n.d.，持续维护页面 | A | GitHub 官方仓库 README 已取得 |
| 10 | OpenSpec（补选） | n.d.，持续维护页面 | A | 项目官方仓库 README 已取得 |
| 11 | LangGraph Interrupts | n.d.，持续文档 | D | 当前官方正文已取得；历史页未取得实质正文 |
| 12 | SWE-agent（补选） | 2024 论文 | C | 原始摘要及官方轨迹文档已取得 |
| 13 | Anthropic 多 Agent 研究系统（补选） | 2025 | A/E | 官方工程文章正文已取得 |
| 14 | Building effective agents（补选） | 2024 | A/D | 官方文章正文已取得 |
| 15 | OpenCode CLI / Skills（补选） | n.d.，持续文档 | E | 官方正文已取得；不等于本机版本所有参数均已验证 |
| 16 | Windows Job Objects（补选） | n.d.，持续文档 | C/D | Microsoft 官方正文已取得 |
| 17 | LAYA（补选） | 0.3.21 对应固定源码 | B/E | 网页返回 404；GitHub MCP 固定 ref 正文取得 |
| 18 | OpenHands | 2024 论文，2025 修订 | C/E | 原始摘要、仓库重定向、官方架构及 Skills 正文取得 |
| 19 | SWE-bench | 2023 论文 | C | 原始摘要、官方 harness 文档及 grading 源码取得 |
| 20 | Aider Repository Map | 2023 介绍；持续文档 | A/E | 官方介绍与文档正文取得 |
| 21 | Agentless（本次Owner新增） | 2024论文 | C | 原始摘要取得；未通读PDF |
| 22 | OpenAI Agents SDK HITL（本次Owner新增） | n.d.，持续文档；本次固定源码ref | D | Owner给出的官方页与OpenAI官方说明已取得；GitHub MCP正文成功 |
| 23 | A2A Task Lifecycle（本次Owner新增） | 固定v1.0.1，页面未标年份 | D/C | 官方指定版本正文取得，不冒称本项目接入协议 |

## 1. MetaGPT（Owner 指定）

原始来源：[论文](https://arxiv.org/abs/2308.00352)；修正后的 [官方仓库](https://github.com/FoundationAgents/MetaGPT)。年份：2023。

借鉴机制：把职责和阶段产物写清，再交下游消费。适用：现有角色任务、deliverable、handoff。不能用角色名称代替实际验收。

不采用：完整 Agent 框架、另一套 SOP 调度或状态存储。核验状态：官方仓库与论文摘要已核验，未逐页复核论文 PDF；论文实验不代表本项目效果。

## 2. ChatDev（本轮补选）

原始来源：[论文](https://arxiv.org/abs/2307.07924)、[官方仓库](https://github.com/OpenBMB/ChatDev)。年份：2023。

借鉴机制：开发、测试等角色分工并交接材料。适用：功能 A 的短顺序计划。当前仓库演进版本不能直接当成 2023 论文实现。

不采用：聊天驱动的第二工作流平台。核验状态：论文摘要和官方仓库正文取得，未通读论文；不声称可直接兼容本项目 Windows/Native Agent。

## 3. AutoGen（本轮补选）

原始来源：[论文](https://arxiv.org/abs/2308.08155)、[官方仓库](https://github.com/microsoft/autogen)。年份：2023。

借鉴机制：角色间通信与工具执行分开表达。适用：现有 RuntimeEvent、brief、handoff 的职责界定。

不采用：其运行时、群聊调度或模型客户端。核验状态：摘要及仓库正文取得；当前 API 与论文版本存在演进，未做安装兼容性验收。

## 4. Magentic-One（本轮补选）

原始来源：[论文](https://arxiv.org/abs/2411.04468)、[官方文档](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/magentic-one.html)。年份：2024。

借鉴机制：显式进度/剩余工作与有界停止。适用：当前报告和阻塞呈现，防止只聊天不交付。

不采用：新的 Orchestrator Agent 或自治重规划系统。核验状态：原始摘要及官方文档正文取得；不继承其性能、安全或成本结论。

## 5. MAST（本轮补选）

原始来源：[Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657)。年份：2025。

借鉴机制：用失败分类检查任务设计、协作和验证是否脱节。适用：区分未交付、错误交接、误验收与模型不可用。

不采用：对本项目套用论文失败率或新增通用监督平台。核验状态：原始摘要取得；这里只引用研究主题，不将未逐条复核的分类细节写成已验证本机根因。

## 6. RouteLLM（本轮补选）

原始来源：[论文](https://arxiv.org/abs/2406.18665)、[官方仓库](https://github.com/lm-sys/RouteLLM)。年份：2024。

借鉴机制：在质量和成本约束内选择模型。适用：LAYA 对合法候选的选择；先保留用户 fixed、能力和费用准入。

不采用：独立路由服务、训练路由器或替代 ModelRegistry。不将论文省费结果当免费资格、实时额度或本项目收益。核验状态：摘要及官方仓库正文取得。

## 7. FrugalGPT（本轮补选）

原始来源：[论文](https://arxiv.org/abs/2305.05176)。年份：2023。

借鉴机制：成本约束下的调用分配和级联思路。适用：后续免费优先与有界接力的方案比较。

不采用：立即建设级联推理系统或静默付费降级；省成本不能覆盖用户固定选择和失败即停。核验状态：原始摘要取得，未通读全文，不声称本地节省比例。

## 8. MCP Tools 规范（本轮补选）

原始来源：[2025-06-18 server/tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)。年份/版本：2025-06-18。

借鉴机制：工具有名称、输入 schema 与明确结果；调用需受用户控制。适用：既有 MCP 候选、任务 intent、实际调用观察的区分。

不采用：MCP Hub、SDK 或第二工具网关；规范能力不证明 Native Agent 真正加载。核验状态：固定版本官方正文取得，不冒称最新规范已逐项实现。

## 9. Spec Kit（本轮补选）

原始来源：[GitHub 官方仓库](https://github.com/github/spec-kit)。年份：n.d.，持续页面，2026-10-16 核对。

借鉴机制：需求、计划、可执行任务分层。适用：现有 stage、plan-file 与确认 digest。

不采用：完整命令体系、生成目录或新规范引擎。核验状态：官方 README 取得；不将上游模板作为本项目批准或当前实现。

## 10. OpenSpec（本轮补选）

原始来源：[项目官方仓库](https://github.com/Fission-AI/OpenSpec)。年份：n.d.，持续页面，2026-10-16 核对。

借鉴机制：将变更目标、任务与规格关系表达清楚。适用：小切片范围、验收材料和变更记录。

不采用：新的审批平台或持久化工作流。核验状态：官方 README 正文取得；未安装，未核实其完整 Windows 路径行为。

## 11. LangGraph Human-in-the-loop / Interrupts（Owner 指定）

保留原始 [历史概念页](https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/)；补充 [当前官方 Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)。年份：n.d.，持续文档。

借鉴机制：Checkpoint 保存进度，Interrupt 中断，Resume 带回人工输入；**恢复时节点可能从头重执行，先前副作用可能重复**。适用：明确用户接受、用户停止和系统超时的不同来源；未来恢复要考虑幂等或将副作用放在中断后。

不采用：LangGraph 引擎、checkpointer 或另一状态机；当前项目同进程 checkpoint 不因此获得持久恢复。核验状态：当前官方正文及重复执行警告已取得；历史 URL 只取得重定向入口，未获取原正文，保留为历史来源，不引用未取得内容。

## 12. SWE-agent（本轮补选）

原始来源：[论文](https://arxiv.org/abs/2405.15793)、[官方输出轨迹文档](https://swe-agent.com/latest/usage/trajectories/)。年份：2024。

借鉴机制：轨迹关联输入、工具动作、观察和环境状态。适用：Task/Attempt/Session 关联的工具证据，检查最终 Worker 指令与真实产物。

不采用：其 Agent、容器环境或完整轨迹平台。核验状态：摘要及官方文档正文取得；文档示例有明确旧版本标签，不强套其字段格式。

## 13. Anthropic 多 Agent 研究系统（本轮补选）

原始来源：[How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)。年份：2025。

借鉴机制：按任务委派，传递必要材料并整合结果。适用：功能 A/B 的职责和上下文边界。

不采用：其内部系统或更高 Token 消耗的默认并行策略；研究型任务经验不能直接证明代码写协作有效。核验状态：官方文章正文取得；未验证本项目收益。

## 14. Building effective agents（本轮补选）

原始来源：[官方文章](https://www.anthropic.com/research/building-effective-agents)。年份：2024。

借鉴机制：优先简单、可组合工作流，再按实际必要性增加自治。适用：个人项目先实现两个任务和独立审核的闭环。

不采用：增加编排层、无限评估循环或为了示范而增加 Agent。核验状态：官方正文取得；设计建议不是本项目测试结果。

## 15. OpenCode 原生 CLI 与 Skills（本轮补选）

原始来源：[CLI](https://opencode.ai/docs/cli/)、[Agent Skills](https://opencode.ai/docs/skills/)。年份：n.d.，持续文档。

借鉴机制：使用原生入口、显式模型及按需 Skill 加载。适用：既有 adapter、目录查询、Worker 请求。执行参数以实际安装版本和源码为准，在线文档不证明本机支持所有选项。

不采用：修改安装目录、绕过权限、自动安装或开放额外模型。核验状态：官方正文取得；本轮未运行 OpenCode 或读取账户凭据。

## 16. Windows Job Objects（本轮补选）

原始来源：[Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)。年份：n.d.，持续文档。

借鉴机制：以 Job 管理关联进程生命周期。适用：保留本项目已有 assign-before-resume、kill-on-close、Job 空确认和身份保持，不把 root 退出当树停止。

不采用：重写 launcher 或新增进程管理器。核验状态：官方正文取得；本项目具体物理证据来自既有封板，不是此次文档任务重测。

## 17. LAYA 固定版本基准边界（本轮补选）

原始来源：[官方 benchmarks.md 固定 ref](https://github.com/NandhaKishorM/laya/blob/6ab71fb4ce6bfd6f189e9b689eaadd67103ed9b6/docs/benchmarks.md)。版本：现有 0.3.21 对应资料；核对日期 2026-10-16。

借鉴机制：有界 typed choice 与领域验证；不能把结构化输出或上游合成基准当代码质量判定。适用：保留 LAYA 的计划、具体 pair 和工具选择，移出确定性产物/测试验收。

不采用：换权重、升级、训练或增加试跑。核验状态：网页本次 404；GitHub MCP 已读取同一固定 ref 正文（资源 repo://NandhaKishorM/laya/sha/6ab71fb4ce6bfd6f189e9b689eaadd67103ed9b6/contents/docs/benchmarks.md），不是未拉取全文。基准不能证明本项目任务级 complete 的质量。

## 18. OpenHands（Owner 指定）

原始来源：[论文](https://arxiv.org/abs/2407.16741)（2024，2025 修订）；[原官方仓库地址](https://github.com/All-Hands-AI/OpenHands)；[当前重定向仓库](https://github.com/OpenHands/OpenHands)；[官方后端架构](https://github.com/OpenHands/docs/blob/main/openhands/usage/architecture/backend.mdx)。

机制出处分开记录：EventStream 的 Action/Observation 关联来自后端架构正文（本次 MCP 固定到 b918604b96b43485fe5db4d92df704e04fb0207c）；按需 Microagents 的上下文组织查 [历史入口](https://docs.openhands.dev/openhands/usage/microagents/microagents-overview)，现重定向至 [Skills Overview](https://docs.openhands.dev/overview/skills)，再以 [Skills/Context 官方指南](https://docs.openhands.dev/sdk/guides/skill) 核对按需披露。当前已采用 Skills 命名，不能把旧 Microagents 与当前 SDK 全部等同，更不能将两机制都归给论文。

适用：现有 RuntimeEvent/Attempt 的行动与观察关联，按需交付上下文。**不引入整套运行时、Docker 沙箱或执行系统。** 核验状态：论文摘要、重定向及上述官方正文已取得；旧架构是版本相关材料，不代表当前 SDK 全部架构。

## 19. SWE-bench（Owner 指定）

原始来源：[论文](https://arxiv.org/abs/2310.06770)（2023）；补充 [官方 harness](https://www.swebench.com/SWE-bench/api/harness/) 和 [grading.py](https://github.com/SWE-bench/SWE-bench/blob/02e7a74ffd0b707aab73d203fe87bdc7c76afc8e/swebench/harness/grading.py)。

借鉴机制：FAIL_TO_PASS 检查目标失败测试转为通过；PASS_TO_PASS 检查原有正确功能保持正确。执行测试与解析结果分别取证，解析规则不能替代真正运行。

适用：在现有 Verification 内关联真实测试与回归材料；新 Demo 没有先前失败测试时如实记录，不伪造 FAIL_TO_PASS。**不引入评测集群，不把 benchmark 成绩当项目效果。** 核验状态：原始摘要、官方文档与 MCP 固定源码已取得，细节归因 harness，而非只归论文。

## 20. Aider Repository Map（Owner 指定）

原始来源：[官方文档](https://aider.chat/docs/repomap.html)、[2023 年介绍](https://aider.chat/2023/10/22/repomap.html)。

借鉴机制：按代码关联提供相关文件/接口签名，控制仓库上下文规模。适用：下游 Worker 获得关键接口和必要内容，减少无关材料。

Repository Map **不等于自动提供完整 Diff**。目标文件的实际改动仍用本项目 Git/Workspace 获取；不能用 git diff --stat 代替必需代码内容。不引入新的仓库索引平台。核验状态：官方文档与介绍正文已取得；未测本项目 Token 节省，不承诺固定比例。

## 21. Agentless（本次Owner明确新增）

原始来源：[Agentless: Demystifying LLM-based Software Engineering Agents](https://arxiv.org/abs/2407.01489)。年份：2024。

论文摘要事实：采用定位、修复、补丁验证三个阶段的简单流程，而非让模型自由决定复杂工具工作流。项目推导：复用已有执行链，将确定性验证做在共享完成入口，先完成最小闭环；这不是论文直接规定本项目三类门禁，更不是保证本项目效果。

不采用：重建Agentless修复系统、benchmark集群或据论文费用/成绩推断本机结果。核验状态：原始摘要已实际取得，未逐页核验PDF，无本机安装/测试。

## 22. OpenAI Agents SDK Human-in-the-loop（本次Owner明确新增）

原始来源：[Owner指定官方SDK指南](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)；补充[OpenAI官方Guardrails and human review](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)。年份：n.d.，持续文档，2026-10-16访问。

官方机制：需要批准的调用先返回interruption与state，由应用approve/reject，再从同一state继续；RunState可序列化以支持该SDK后续恢复。自动校验与人工批准是不同控制；实际副作用附近仍需要对应检查。

项目推导：整轮预授权下系统验证与真实user_accept分开记，异常待人工不等于成功；任务完成最终提交前重验当前身份/证据。这些是结合本地调用链的选择，不代表SDK替我们提供TaskStore持久化，也不把政策自动判断伪记Owner输入。

不采用：SDK包、Runner、RunState存储或第二审批系统。核验状态：上述官方正文均取得；GitHub MCP成功读取[固定源码](https://github.com/openai/openai-agents-js/blob/9687b544c8c873080e6ff7e7d294c0b353cd9ab6/docs/src/content/docs/guides/human-in-the-loop.mdx)，blob084ccd2dddb282b27085474e8a406e25e0ac5e98。未运行SDK或模型，不能据其resume能力宣称本项目可隔天恢复。

## 23. A2A Task Lifecycle（本次Owner明确新增）

原始来源：[Life of a Task v1.0.1](https://a2a-protocol.org/v1.0.1/topics/life-of-a-task/)。年份：官方页面未标，保留固定协议版本，2026-10-16访问。

官方机制：Task有生命周期和身份；input-required/auth-required等中断与completed/failed/canceled等终态分开；上下文与任务/产物引用有关联，模糊产物可要求澄清。

项目推导：system_timeout/input_disconnected/verification_failed/pending_user与真实用户accept/stop分开，复用当前事件/报告，不复制A2A状态为第二TaskStore。协议状态命名不是本机已实现字段，不把“等待输入”当“已完成”。

不采用：A2A server/client、协议迁移或新的任务生命周期引擎。核验状态：指定官方正文已取得；本项目尚未实现或测试其协议。

## 新产品契约的依据与工程推导（2026-10-16）

新契约状态：**Owner approved / Not yet implemented / Not yet tested**。

| 资料事实/官方机制 | 本项目工程选择 | 不可据此声称 |
|---|---|---|
| #1 MetaGPT、#2 ChatDev的角色/阶段交付思想 | 保留短计划、角色、真实交接，不让群聊替代执行 | 上游框架已接入或生成内容天然正确 |
| #11 LangGraph中断恢复可重跑节点；#22 SDK有明确批准/恢复状态 | 系统等待与人工决定分开；不重复成功Worker；恢复前检查副作用 | 取消60秒计时器就有持久恢复 |
| #23 A2A中断状态与终态不同 | pending_user只作安全待办结果，非任务成功、非第二状态权威 | 协议状态自动等于本项目Task枚举 |
| #12 SWE-agent行动/观察轨迹；#19 SWE-bench执行与解析区分 | 批准测试命令的真实退出事实和同Attempt绑定；目标测试/保留回归各自核验 | Agent的PASS自述或Session0就是目标测试通过 |
| #21 Agentless小阶段验证；#5 MAST多Agent失败研究 | P0-1机器门先于P0-2默认流转，P0-3再异常等待 | 论文证明本项目三门充分或保证准确率/省费 |

P0-1文件边界的补充一手依据：[Node 24.x fs.realpath/lstat](https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromisesrealpathpath-options)、[Win32 Reparse Points](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points)，本次正文取得。它们说明路径解析与重解析点是物理文件语义；“不能只用字符串前缀/Git状态认证范围”是项目推导。未因此宣称已解决竞态、硬链接、并发外写或实现新沙箱；无法可靠确认时保守拒绝，实施时按实际Node/Windows版本核验。

## 核验限制与采用规则

本轮没有因单个 URL 失败阻塞更新。已知权威来源若后续受网络限制无法取得正文，应原样标记：`核验状态：权威来源记录（本机网络受限未在线拉取全文）`；权威性也不能确定则标为待核验。不得把这两个标签替换成“技术机制已验证”。本轮 #17 已由 MCP 取得正文，#11 保留历史入口但以当前正文为依据。

资料 → 本地调用链映射 → 最小实现 → 离线负控 → 独立审核 → 单独授权真实验收。没有安装、迁移、源码抄用、模型推理或新阶段执行授权由此自动产生。
