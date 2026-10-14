# LAYA Native Multi-Agent Orchestrator

更新日期：2026-10-13

个人 Windows 工作台的本机多 Agent 编排后端。用户提交目标，LAYA 决定任务分工、具体 Agent × Model 与需要的能力，既有执行链负责准入、调度、隔离、证据和验证。

## 唯一当前状态入口

**[docs/PROJECT_BASELINE.md](docs/PROJECT_BASELINE.md) 是唯一当前项目状态与阶段基准。**
其他文档不另设一套封板状态、授权状态或测试成绩；历史审核在 Git 查看。

| 文档 | 负责内容 |
|---|---|
| [后端需求](docs/BACKEND_REQUIREMENTS.md) | 用户目标与验收要求，区分已交付和未来需求 |
| [项目基线](docs/PROJECT_BASELINE.md) | 唯一当前事实、阶段状态、限制与证据入口 |
| [阶段分析](docs/STAGE_ANALYSIS.md) | 推进分析与历史备份 |
| [交付计划](docs/BACKEND_DELIVERY_PLAN.md) | 新草案对应的任务路线和验收边界 |
| [下一任务](docs/NEXT_TASK.md) | 当前最小实施切片与独立复现 |
| [架构契约](docs/ARCHITECTURE_CONTRACTS.md) | 身份、执行入口、停止与结果权威 |
| [LAYA 接口](docs/DECISION_PROVIDER.md) | typed decision、候选选择与失败语义 |
| [协作契约](docs/R2_COORDINATION_CONTRACT.md) | Lease、资源、工作区和协作边界 |
| [Round 语义](docs/EXECUTION_ROUND_SEMANTICS.md) | 有界执行、配额事实、Human Gate |
| [执行证据](docs/DECISION_LOOP_EXECUTION_RESULT_CONTRACT.md) | Requested/Admitted/Executed/Verified 与 Attempt 关联 |
| [Windows launcher](native/windows-job-launcher/README.md) | native 构建、Job control 与 containment |

用户明确指令优先。需求是目标，基线是现状，契约定义不可绕过的行为；文档不能覆盖源码与真实证据。

## 两个核心功能

- **功能 A：跨角色独立分工。** LAYA 为调研、实现、测试、审核等具体任务选择 Agent 内的具体模型及独立会话，传递依赖材料与交付物。角色随任务变化。
- **功能 B：同目标模型协作组。** 一个目标由 2–3 个模型按职责共建，成员有独立 child task、会话、文件范围和交付物，指定集成责任。多人结束不等于验收通过。

同 Agent 多模型、多会话属于后端需求；“前端实现任务”只是业务角色示例，不表示本工作台已进入前端阶段。
LAYA 还需要任务级 Skill/MCP 选择与按需上下文、免费优先和有界接力；这些尚未完成整体验收。

## 当前可用与限制

已审核的最小能力包括：OpenCode opt-in 模型目录、DSH 基础 headless 接入与输出保真、项目/任务 auto/fixed 选择及动态子任务固定约束。
W5 与 B1.4a 的准确状态见唯一基线；B1 整体未封板，PARALLEL_WRITE=CLOSED。
DSH 当前不支持逐请求指定模型或 native session 恢复，不能声称已经通过 DSH 实现多模型调度。
listed ≠ connected ≠ callable ≠ free；严格零新增费用尚未端到端验收。

当前 **B4.5/B4.5a独立PASS（受控最小Git顺序协作范围）**：组内单worktree交付、脏文件保护和实际成果审核已通过；
停止未确认、no-review或scope重叠均阻止误报成功。B1/B4整体仍未封板。
B3.1任务级原生Skill有界闭环独立PASS：显式 `--skill-catalog skills.json` 配合sequential/collaborate，LAYA至多选一个advisory请求或none，报告分开请求/绑定/工具观察。候选不证明已安装，绑定不证明已加载；MCP和真实加载/token收益未认证。B3.2亦已独立PASS（具体Server/Tool的advisory选择与名称匹配观察）：`--mcp-catalog mcp-tools.json`，只支持OpenCode目录声明，不自动连接/配置MCP，也不裁剪原生工具定义。B2.1/B2.1a用户声明池与最终同步启动准入已受控独立PASS；下一候选B4.6检查点监督待下发。
新草案要求的需求确认、阶段批准、监督、交付与恢复已重排；见 [交付计划](docs/BACKEND_DELIVERY_PLAN.md) 和 [下一任务](docs/NEXT_TASK.md)。
完整后端目标粗估完成约60%、剩约40%（工程估算，不含正式前端）；权重、证据和不确定区间见唯一基线，不能按测试数量计算进度。

本机独立进度页：`project-progress/index.html`，不进入 Git，不接 Runtime 控制。
本机存在时用 `node project-progress/refresh.mjs` 刷新，或加 `--serve` 只读实时预览；每次任务推进必须同步。
旧 temporary-dashboard 已保留本机源码备份；递归删除被工具安全策略拒绝，待用户手动删除；正式工作台前端需求仍待单独确认。

## 本地使用

需要 Node >=22.6 和已安装的项目依赖；具体 Agent 安装、登录与能力以本机事实为准。

    node src/cli/index.ts doctor
    node src/cli/index.ts doctor --models opencode
    npm run typecheck

doctor 默认不查询模型目录；目录查询不是推理可调用或免费资格证明。
启动已有本机 LAYA 服务后可仅分类：

    laya-serve
    node src/cli/index.ts round "分析目标" --classify-only

以下示例会调用真实 Agent，费用与数据边界仍受其配置影响，不是零费用承诺：

    node src/cli/index.ts round "<目标>" --select fixed --agent <agent> --model <full-model-id>
    node src/cli/index.ts round "<目标>" --select auto

项目默认 selection 配置为 auto 或完整 fixed pair。task > project > default auto。
同时给 --agent 与 --model 解释为 fixed；单轴沿用偏好。缺值 --select 是用法错误。
角色默认、完整 prefer、运行中改选和暂停交互尚未实现。
配置查询：--config → ORCH_CONFIG → 当前目录 orchestrator.json → 用户配置 → 内置发现。
不要把凭据放进仓库，也不通过修改 Agent 全局默认模型实现并发模型选择。

## 执行与验证边界

用户目标 → LAYA/候选计划 → Planner/TaskStore → Assignment/Lease → Scheduler/executeTask
→ Spawn Gate/Workspace/ResourceClaim → Native Runtime → Attempt/Result → Verification/Review → Human Gate。
Human Gate 后 automaticPostRoundAction=NONE。停止未确认不提前释放保护，root 退出不等于树停止。
代码与测试通过不代表所有真实 Agent 兼容或真实费用已核验。

文档维护只检查差异、链接和一致性；运行验证结果统一记录在项目基线，并标明执行日期与证据范围。
真实 Agent 测试保持 opt-in，默认测试不得消费真实模型额度。
旧需求、规划和审核明细保留在 [Git 历史](docs/STAGE_ANALYSIS.md#历史备份)，当前目录不复制报告。

B2.1：`--model-pool <file>` 为显式用户声明策略，限制编排执行pair；并非实际免费或全流程费用保证，付费声明继续拒绝。最终启动检查P1已在B2.1a独立关闭：prepare后实际pair与当前声明再准入，拒绝不启动、不记虚假Attempt、不遗留pre-start claim。它仍不是实际账户免费、USD硬预算或全流程费用保证。状态/证据及下一片见唯一基线和NEXT_TASK。
