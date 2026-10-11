# 后端阶段分析

更新日期：2026-10-11
性质：需求与源码差距分析、建议顺序；不是自动启动开发的指令，也不改变已封板状态。

## 1. 当前所在阶段

执行底座已有大量可复用能力；当前先完成 W5 最终证据范围与封板裁定，
再按用户另行授权扩展后端产品能力。PARALLEL_WRITE=CLOSED。
不能继续把项目描述为“T2-b.1 / T3 未开始”，也不能直接宣称 W5 已通过。

最新 W5.1d 独立审核结论为 PASS WITH P2。历史 stress 失败传播、pid-only fallback
及 observer 异步 EPIPE P1 均已在当前路径收口。
独立 observer 边界 probe、3-round 与 50-round 通过，两次均 EXIT=0、140/0，stress 失败计数全 0。
详见 [项目基线](PROJECT_BASELINE.md#6-w51d-独立审核与上传说明)。
剩余非阻断 P2 是新增冗余死亡断言把 OBSERVATION_ERROR 打印为退出证明；
已有同一原句柄的强断言保障该 case 的核心结论。
下一步整理 W5 最终证据与适用范围，最多简化这一测试断言，不重新实现清理框架，
不进入 B1 实现，不开放并行写。

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
| REQ-09 接力 | 同 Task 新 Attempt/Lease、handoff | 完整检查点和切换约束，不能冒充原生会话迁移 |
| REQ-10 节省消耗 | 原生工具、上下文、memory/evidence | 去重、按需上下文、真实对照数据 |
| REQ-11 状态与交付 | Attempt/Result/Review/Observation | 对外稳定事实契约；前端设计以后确认 |
| REQ-12 范围 | Native CLI 架构 | 保持 Agent-native；不自动引入网关/直接 API |

这些是当前检查范围内的差距，非完整代码审计结论。
例如“接口能选模型”与“完整用户选择产品已验收”必须分开。

### 必须显式评审的契约扩展

现有 AgentCapabilities.skills 仅表示能否请求原生 Skill，不是目录或分配筛选事实。
新需求将 Skill/MCP 纳入选择，因此 B1/B3 必须先定义必要的新事实与兼容行为，
不能直接反转旧 boolean 的含义。完整用户固定规则、动态费用、跨入口接力也需
保留当前 T3-M0 身份/路由边界，不能把新需求默认为现有实现。

## 3. 建议阶段

B 编号仅用于新需求分析，不重命名或重开已封板的 T/W 阶段。
每个 B 阶段均为 PLANNED / NOT AUTHORIZED，不得因本文自行开工。

| 阶段 | 最小目标 | 依赖与退出条件 |
|---|---|---|
| B0 执行证据收口 | W5.1d P1 已关闭；整理 W5 最终范围与非阻断 P2 | 最终独立封板裁定；已通过路径不回退；开写权限另行裁定 |
| B1 可用能力与用户规则 | 复用 registry/adapter 表，明确 Agent/Model/Skill/MCP 事实和用户约束 | 区分目录与可用；固定/禁用/费用冲突可验证 |
| B2 费用与候选约束 | 入口/账户归属、免费依据、有效期、共享额度和预算 | 每次分配/接力均校验；未知不伪造；全部不可用安全停止 |
| B3 LAYA 能力选择 | 联合选择 Agent/Model 与 Skill/MCP，提供必要角色能力事实 | 只选合格候选，复用原生执行，实际能力可核对 |
| B4 异构任务闭环 | 候选内容生成 → LAYA 选择 → 调研/实现/测试/审核 | 同 Agent 多模型独立会话；工作区隔离和材料交接有实证 |
| B5 成本与恢复验收 | 有界接力、总消耗统计和代表性任务对照 | 质量合格、无隐藏付费、无双写者，结果到 Human Gate 停止 |
| F 前端需求 | 提醒用户并单独梳理前端 | 后端契约稳定后再讨论；本轮不设计界面、不选前端框架 |

B1 只收集必要事实；B2 决定哪些候选可进入预算范围；B3 才做完整智能选择。
在 B3 前不另造路由服务，在 B4 前不先做通用工作流引擎。
Skill/MCP 的最小调用与费用观察可在其所属阶段验证，不必等待最终前端。

## 4. W5 已有证据与剩余裁定（尚未整体封板）

- 已验证：两个 writer 经 TaskOrchestrator → executeTask → Runtime → 测试适配器
  → 真实 Transport/Contained ManagedProcess，并在不同 worktree 执行。
- 已验证：A/B 一侧启动失败时另一侧对称回收；停止失败/超时/抛错进入共享判定与最终结果。
- 已验证：owned fixture 根目录删除失败使同一 finalizer 的 child 非零退出，foreign sentinel 保留。
- 已验证核心路径：观测失败/超时为 OBSERVATION_ERROR，不被认作死亡；
  保持原进程句柄，避免 PID 重用导致错误归因。
- 已验证：root-first、hardkill、stop-order swap、跨运行隔离和 50-round stress 有真实证据。
- 已验证：测试适配器替换生效，未调用本机真实收费 Agent。
- 测试通过不自动开 PARALLEL_WRITE；后续是否开放需独立明确裁定。

W5.1d 独立审核已运行 typecheck、diff check、三个 observer 边界 probe、3-round 与 50-round。
共享清理判定、原句柄终止、同一 finalizer 及 typed channel failure 已有实际路径证据；
不可继续沿用已关闭的 W5.1b/W5.1c P1。
当前只保留冗余死亡断言的 P2；不得以 OBSERVATION_ERROR 为死亡证据，也不必新建观测框架。
W5 最终证据包应区分 production admission case、底层 stress、受控失败注入和真实 Agent 历史证据，
逐项明确已证实的结论、未重新运行的历史结果及环境限制。
W4 真实 Agent 兼容性/环境限制与旧 full-suite parity 不能由 fixture stress 自动提升为通过。
不要求再次重跑已通过 50-round，除非后续修改触及它的执行/清理路径或暴露异常。

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

Codex 独立 typecheck、三个 observer 边界 probe、W51_ROUNDS=3/50 与 diff check 通过。
两次 suite 都为 EXIT=0、140/0，打印的 stress 失败计数为 0；已知 owned 根目录及 observer 无残留。
Codex 仅更新审核说明，没有修复 OpenCode 实现；实现文件提交前按 blob hash 核对。
上传审核分支，不合并 main，不开放 PARALLEL_WRITE，不授权 B1–B5。
未运行 full suite、真实 Agent 或重新审核已封板阶段；W5 整体封板仍待最终裁定。
