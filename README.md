# LAYA Native Multi-Agent Orchestrator

面向个人 Windows 工作站的本机多 Agent 编排后端。
复用已安装、已授权的 Native Agent 及其模型、会话和工具，
由 LAYA（laya）组织任务级决策，经现有准入与执行链完成工作。

## 当前文档

| 文档 | 内容 |
|---|---|
| [后端需求](docs/BACKEND_REQUIREMENTS.md) | Agent/模型/多会话、Skill/MCP 选择、免费优先、接力及验收 |
| [项目基线](docs/PROJECT_BASELINE.md) | 已有能力、封板状态与当前边界 |
| [阶段分析](docs/STAGE_ANALYSIS.md) | 源码差距、建议阶段、前端需求提醒和 Git 历史备份 |
| [架构契约](docs/ARCHITECTURE_CONTRACTS.md) | 身份、单一权威、执行证据、停止与隔离 |
| [LAYA 接口](docs/DECISION_PROVIDER.md) | 本地 typed decision 和错误语义 |
| [协作契约](docs/R2_COORDINATION_CONTRACT.md) | Lease/fencing、ResourceClaim、工作区与接力 |
| [Round 语义](docs/EXECUTION_ROUND_SEMANTICS.md) | 有界执行、quota 事实和 Human Gate |
| [执行证据](docs/DECISION_LOOP_EXECUTION_RESULT_CONTRACT.md) | 当前 Attempt 与 RunResult 关联 |
| [Windows launcher](native/windows-job-launcher/README.md) | 构建、control 协议与生产 containment 边界 |

需求描述目标能力，不代表全部已实现。当前 W5 未封板，
PARALLEL_WRITE=CLOSED；新增后端阶段未授权实现，前端需求留到进入前端阶段单独确认。
OpenCode 主要开发，Codex 独立审核。

## 目标与现状

目标：LAYA 为每个任务选择具体 Agent、Model、所需 Skill 和 MCP 工具；
同一 Agent 可通过独立会话运行多个模型；优先合格免费资源，必要时安全接力。

现有内核已有 Agent × Model 选择、Task/DAG、Session/Worker 身份、Lease/fencing、
工作区/资源保护、Windows containment、Attempt evidence、有界 handoff 和统一 Review。
完整模型目录与用户固定规则、LAYA Skill/MCP 选择、动态费用额度、
各 Agent 多模型真实并发和总 token 收益，仍需按阶段补齐/验收。
当前生产只编排 native Agent；不直接调用供应商模型 API，不读取或搬运凭据。

## 执行边界

用户目标 → LAYA → 候选 DAG → Assignment/Lease → Scheduler/executeTask
→ Spawn Gate/Workspace/ResourceClaim → Native Runtime
→ Attempt/Result → Verification/Codex Review → Human Gate → END。

TaskId 在接力时稳定，真实执行产生新 Attempt。
当前 Round 在 Human Gate 后 automaticPostRoundAction=NONE。
停止未确认不提前释放保护；root 退出不等于整棵执行树停止。
Observation/临时 dashboard 只读，不是新的命令或调度 authority。

## 本地使用

需要 Node >=22.6（直接执行 TypeScript）和已安装的项目依赖。
Agent 的具体版本、安装、登录及模型可用性以本机 doctor/官方接口为准；
不把旧环境快照写成永久可用列表。

    npm ci
    node src/cli/index.ts doctor
    npm run typecheck

启动本机已安装的 LAYA 服务后，可以先仅分类：

    laya-serve
    node src/cli/index.ts round "分析当前项目需要完成的任务" --classify-only

以下命令会实际调用 Agent，使用其账户、模型和工具，费用受其配置影响：

    node src/cli/index.ts run opencode "解释项目结构" --cwd .
    node src/cli/index.ts run opencode "解释项目结构" --model <provider/model> --cwd .
    node src/cli/index.ts round "<目标>" --cwd <项目目录>

配置查询顺序：
--config → ORCH_CONFIG → 当前目录 orchestrator.json
→ 用户 .native-agent-orchestrator/orchestrator.json → 内置发现。

配置中的 Agent command/model 仅作为本机入口；不要将凭据放进项目仓库。
CLI --agent/--model 的现有 preference 行为不等于新需求中的完整“固定选择”产品。
现有 orchestration budget units 不等于真实 token/货币预算；
严格免费模式尚未完成端到端验收。

## 验证

本轮文档整理已运行 npm run typecheck，并在提交前检查差异与文档链接。
未运行 full suite、真实 Agent 或 W5 stress；备份提交不是封板结论。

可按明确验证任务选择已有定向入口：

    node tests/decision.test.ts
    node tests/initial-assignment-decision.test.ts
    node tests/containment-production.test.ts
    node tests/execution-lifecycle.test.ts

真实 Agent 测试和 W5 证据测试保持 opt-in，不因阅读本文自动运行。
Windows launcher 构建与测试前提见其 [README](native/windows-job-launcher/README.md)。

## 历史备份

旧需求、阶段规划、审核与调研报告已从当前目录移除。
整理前全部可入库源码与旧文档已推送标签：

    archive/pre-backend-requirements-2026-10-11

[查看历史快照](https://github.com/yunxibaili/D-Native-Multi-Agent-Orchestrator/tree/9f12a3bf475ac47e4e6b2b2dd407ed09811610b5)

备份范围和只读查看方法见 [阶段分析](docs/STAGE_ANALYSIS.md#历史备份)。
