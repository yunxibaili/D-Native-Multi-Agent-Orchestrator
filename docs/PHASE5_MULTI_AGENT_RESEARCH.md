> **[Historical — Superseded by docs/PROJECT_BASELINE.md]**
> 本文件是 Phase 5A 调研（2026-09-29）。文中 "Phase 8 AI Work Control Center" 等
> 路线为当时设想，已被 Bounded Execution Round + Human Gate 模型取代（见
> PROJECT_BASELINE §5/§11）；"Multi-Agent 必须 opt-in、单 Agent 默认"已被 R1-1
> 删除 multi-agent flag 的决策取代（single-vs-multi 由 Planner/Laya task shape
> 决定）。当前路线以 PROJECT_BASELINE §16 为准。

# Phase 5A — Multi-Agent 调研 / 风险清单 / 实施计划

调查日期：2026-09-29 · 机器：Windows 11 / PowerShell / Node v24.18.1 / RTX 5070 12GB / 32GB RAM

> **本轮只做 Research + Planning + Dashboard。未修改任何 Runtime / Orchestrator /
> Adapter / CLI / Decision / 外部 Agent 安装目录，未实现任何 Multi-Agent 能力。**
>
> 结论先行：**Multi-Agent 必须是 opt-in 的可选能力，Single Agent 永远是默认。**
> 当前项目的 Runtime 已经具备"无全局 current agent、每次 run 显式指定 agentId、
> 每次执行只产生一个 task + 一个 thread"的良好基础，但**尚不具备** Multi-Agent 所需的
> 任务 DAG、父/子任务关系、预算、消息或隔离写。进入实现前，必须先过 Phase 4。

---

## 0. 现状盘点（本项目已有资产）

### 0.1 运行时分层（已实现、已通过 Gate 审计）

```text
CLI (src/cli) ──→ Orchestrator (src/orchestrator) ──→ AgentSession (src/runtime/session.ts)
                          │                                   │
                          │                                   ├─ Transport (src/runtime/transport/cli.ts)
                          │                                   ├─ EventHub (src/core/event-hub.ts)
                          │                                   └─ SessionStore (src/runtime/store.ts)
                          └─ AdapterRegistry (src/runtime/registry.ts) ──→ Adapters (src/adapters/*)
```

- **一切都是"显式 agentId"驱动。** `RunRequest.agentId` 必填；`AdapterRegistry` 明确
  **没有** `selectDefaultAgent()`。这是 Multi-Agent 的好基础：调度器将来必须
  自己显式指定每个 child 的 agentId，而不是依赖任何全局状态。
- **task / thread 已分离。** `TaskSummary`（一次执行）与 `ThreadRecord`（agent+cwd 归属，
  用于 resume）是两份数据，resume 有 agentId+cwd 归属校验。
- **终态是冻结的、独立的：** `running | succeeded | failed | cancelled | timed_out`。
  `result()` 可重复调用且不可二次改写。Multi-Agent 的父任务聚合可直接复用这个语义。
- **事件是 multi-subscriber 的有界 EventHub**，late subscriber 语义明确。
  未来 Task Tree 视图可作为订阅者接入，而无需改 Runtime。
- **能力矩阵是 boolean 真值**，`validateRequest` 在 spawn 前拒绝不支持选项。
  Multi-Agent 的调度器必须**先读 capability 再派发**，而不是运行时崩溃。
- **Decision Layer 独立**（`src/decision/` 无 `../core` 依赖），且**尚未接入 agent selection**。
  Laya 目前只是"描述任务的分类器"，没有路由权。Multi-Agent 的 Model Policy / 调度
  必须显式建立在这之上，而不是让 Laya 偷偷决定开几个 agent。

### 0.2 当前各 Agent 能力矩阵（以 Dashboard / 代码为准，本机实测）

| 能力 | OpenCode | Codex | WorkBuddy CN | WorkBuddy Intl | DSH | ZCode | TRAE | Cline |
|---|---|---|---|---|---|---|---|---|
| newTask | ✅ | ✅ | ✅ | ✅ | ? | — | ? | ? |
| resume | ✅ | ✅ | ✅ | ✅ | ✅（ACP，On Hold） | ? | ? | ? |
| review（原生） | ❌ | ✅ | ❌ | ❌ | ❌ | ? | ? | ? |
| modelSelection | ✅ | ✅ | ✅ | ✅ | ✅ | ? | ? | ? |
| roleSelection | ✅ | ✅ | ✅ | ✅ | ❌ | ? | ? | ? |
| sandbox | ✅ | ✅ | ❌ | ❌ | ❌ | ? | ? | ? |
| streamEvents | ✅ | ✅ | ✅ | ✅ | ✅ | ? | ? | ? |
| costReporting | ✅ | ❌（只有 token） | ❌ | ❌ | ? | ? | ? | ? |
| steering | ❌ | ❌ | ❌ | ❌ | ❌ | ? | ? | ? |
| worktree | 未知 | 未知 | 未知 | 未知 | ❌ | ? | ? | ? |
| stdinPrompt | 按约定 false | false | false | false | false | ? | ? | ? |
| 认证状态 | 已登录 | 已配置 key | **401，需用户 /login** | 已登录 | 无凭据（On Hold） | provider 配置错配 | 调查中 | 调查中 |

**关键事实（直接决定 Multi-Agent 设计）：**

1. **没有任何 Agent 声明 `worktree` 支持，`steering` 全部为 false。**
   → 并行写同一 checkout 现在**不可能安全**。并发 worker 的写必须靠
   "多个 checkout / 手工 worktree"或"串行"，详见 §7。
2. **只有 Codex 有原生 `review`。** OpenCode、WorkBuddy 都无原生 review。
   → "OpenCode 实现 → Codex 独立审查"是能力矩阵强制的，不是偏好。
   Multi-Agent 的 Review 阶段必须以 Codex 为一等 reviewer。
3. **costReporting 大多不可信**（Codex 只有 token；WorkBuddy `total_cost_usd` 恒 0
   却真实扣 credit）。→ 预算控制**不能只依赖 Agent 自报成本**，必须用
   token 计数 + 外部 onboarding 配额（Phase 4）双轨。
4. **认证状态是每 identity 独立的**（CN vs Intl 已拆成两个 agentId）。
   → 调度器不能假设"同一 provider 的另一个 identity 一定可用"。
5. **Windows 进程树取消**是 best-effort（cancellation forceful、normal exit 只做
   best-effort 子孙回收，见 Runtime Hardening）。→ 多 Agent 会放大孤儿风险，
   父任务取消必须有明确的传播与回收策略（见 §11、§13）。

### 0.3 Roadmap 现状

```text
Phase 1 Core Runtime             DONE
Phase 2 Decision Layer / Laya    DONE
Phase 3 Native Agent Expansion   ACTIVE / near sealed
Phase 4 Quota / Model Center     NEXT（尚未实现）
Phase 5 Multi-Agent              RESEARCH FIRST（本文件）
Phase 6 Policy / Agent Routing
Phase 7 Collaboration / Review
Phase 8 AI Work Control Center
```

**本轮只做 5A Research。** 5B~5I 全部仅列为计划。

---

## 1. Multi-Agent 调研报告

### 1.1 为什么（以及为什么常常不该）用 Multi-Agent

Multi-Agent 唯一站得住脚的理由是：**把一个任务拆成可并行、可独立验证的子任务，
从而减少 wall time 或提高结果可信度**。它不是"更聪明"，只是"更多独立执行单元"。

它天然带来四类成本：

| 成本 | 来源 | 本项目为什么敏感 |
|---|---|---|
| Token overhead | 每个子 Agent 都要重新获得上下文、产出、被 review | 本机 Agent 大多按 credit/配额计费，成本不可见 |
| 协调 overhead | 任务拆分、依赖、消息、聚合、冲突合并 | 当前 Runtime **没有** DAG / 消息 / 父任务概念 |
| 质量风险 | 子结果冲突、上下文漂移、竞争者互相覆盖文件 | 当前 **没有** worktree 支持，写冲突是真实风险 |
| 资源风险 | 多个本地重模型同时跑 → VRAM/RAM 抖动 | RTX 5070 12GB，Qwen3.8-27B + Laya checkpoint 争 GPU |

**因此本项目的第一条原则：Single Agent = 默认，Multi-Agent = 用户主动开启，
Auto Mode 必须独立设计、独立审批，永不由"任务复杂"自动触发。**

### 1.2 什么任务适合 / 不适合

**适合（收益 > 协调成本）：**

- 天然可切分且互相独立的调查/实现：如"分别调研 A、B、C 三个库"。
- 需要独立验证的实现：一个 worker 实现、一个独立 reviewer 审查。
- 大范围只读扫描（多个目录/模块的 review、测试缺口排查）。
- 有清晰 acceptance criteria、可机械判定的子任务。

**不适合（协调成本 > 收益）：**

- 强顺序依赖、小规模的单点修改（拆了反而更慢）。
- 需要频繁共享可变状态或同一文件的任务。
- 需求本身还不清楚的探索（先单一 Agent + 澄清，别急着 fan-out）。
- 高度上下文耦合、难以切片的任务。
- 预算/配额紧张时（此时 Multi-Agent 是负债）。

**默认建议：除非用户显式开启，否则一个任务最多一个 Agent 顺序跑完。**

### 1.3 Token overhead 来自哪里（回答第 4 问）

1. **上下文重放**：每个子 Agent 需要自己的任务描述、约束、验收标准。
   如果直接把 Root Conversation 复制给 N 个子 Agent，成本约为 `N × 上下文长度`。
2. **指令/框架开销**：每个子 Agent 的 system/prompt 包装。
3. **结果与聚合**：子结果要回到父任务并被理解。
4. **Review 往返**：review 发现 → rework → re-review，每轮都重新计费。
5. **协调消息**：Agent 之间的 typed messages（若设计成自由 chat，成本爆炸）。

**控制原则：优先传"结构化结果 + artifact reference"，绝不默认复制完整 transcript（见 §6）。**

### 1.4 谁创建子 Agent / 能否无限嵌套（回答第 5~7 问）

- **只有 Root Orchestrator（本项目的调度层）可以创建子 Agent。**
  子 Agent **不能**自行 spawn 孙 Agent —— 至少 MVP 阶段必须禁止。
- 理由：本项目调用的是**原生 CLI Agent**，它们各自的"subagent"能力互不统一
  （能力矩阵里 `roleSelection` 有、`steering` 全无、`worktree` 未知）。
  允许 Agent 自行 spawn，会绕开本项目的预算/权限/取消控制。
- 限制：`maxDepth = 1`（MVP 只允许 Root → Workers/Reviewer），`maxChildren`、
  `maxFanOut` 全部设硬上限。深度 >1 只在 Future 讨论（见 §10）。

### 1.5 关键问题逐条简答（对应第 8~30 问）

| # | 问题 | 本项目立场（MVP） |
|---|---|---|
| 8 | Agent 间通信 | **typed messages**（见 §6），禁止无限制自由 chat |
| 9 | 如何避免无限对话 | 消息类型封闭 + 每任务消息上限 + 无 ack 超时 + 禁止 agent→agent 直接对话 |
| 10 | 上下文传递 | parent→child 传结构化 brief；predecessor→successor 传结果摘要，不传 transcript |
| 11 | artifact 传递 | 传 **reference（路径 + hash + 摘要）**，不内联大内容 |
| 12 | 共享文件 | **MVP 禁止共享写**；只读可共享；写必须隔离或串行 |
| 13 | 代码冲突 | MVP 靠"每 worker 独立 checkout 或串行"避免；集成阶段由人/单一 Agent 合并 |
| 14 | review | 独立 Codex reviewer；review 有明确终点（见 §12） |
| 15 | 结果冲突 | 不自动合错；标记 conflict → 交人 / 交单一仲裁 Agent 做聚合判断 |
| 16 | 子任务失败 | 按类型分级（见 §11），默认失败不上抛为整个父任务失败，而是可重试/可隔离 |
| 17 | retry/re-execute/rework/replan 区分 | 定义见 §11.2，四者是不同语义、不同计数 |
| 18 | timeout | 每 task 有 deadline；超时→`timed_out`，可 retry，但计入 maxRetries |
| 19 | quota 耗尽 | **必须等 Phase 4**；MVP 只做"预留 + 释放"接口占位，不真接 |
| 20 | 父任务取消 | 传播到所有在跑 child；每个 child 走现有 cancel 路径 |
| 21 | 孤儿回收 | 依赖现有 Windows 进程清理 + 未来 lease/heartbeat（见 §13） |
| 22 | orchestrator 崩溃恢复 | MVP：不承诺；Future：持久化 task state + lease 重建（见 §13） |
| 23 | 预算控制 | global / perTask / perAgent 三级 + maxConcurrent/fanOut/depth/retries/turns/TTL |
| 24 | 并发控制 | 全局并发上限（按 Agent 与资源分别计数） |
| 25 | 资源调度 | 本地重模型按 VRAM/RAM 串行化（见 §9） |
| 26 | 权限隔离 | child ≤ root 权限；危险动作需 human approval（见 §12） |
| 27 | Agent Tree 观测 | Dashboard 展示树 + blocked/retry/messages/artifacts（见 §14） |
| 28 | token/cost 统计 | token 来自 Runtime usage；cost 由 Phase 4 补；不可信时**如实标记不可得** |
| 29 | 为什么选这个 Agent | 所有派发必须记录 selection reason（显式或将来 Policy 给出） |
| 30 | 何时退回 Single Agent | fan-out 无收益、预算不足、写冲突、任务不可切分、依赖强顺序时 |

---

## 2. 项目问题 / 风险完整清单（Risk Matrix）

每条给出：**Problem / Why it matters / MVP handling / Future handling / Status**。
本矩阵同时写入 Dashboard（`multiAgentDesign.riskMatrix`）。

| # | Problem | Why it matters | MVP handling | Future handling | Status |
|---|---|---|---|---|---|
| 1 | Token Explosion | N 个 Agent × 上下文重放 → 成本非线性增长 | 硬上限 maxFanOut/maxConcurrent + 预算预留 + 每次 spawn 记录理由 | 自适应预算分配 + 按收益回收 | Open |
| 2 | Agent Coordination | 无 DAG/依赖 → 乱序、重复、空转 | MVP 只允许一层、无环、显式依赖列表 | 完整 DAG 调度 + 关键路径优化 | Open |
| 3 | Context Explosion | 复制整个 root conversation 给所有 child | 结构化 brief + 摘要 + artifact ref，禁止整份复制 | 自动 context compaction + 按需检索 | Open |
| 4 | Shared File Conflict | 多 worker 写同一 checkout 互相覆盖 | **MVP 禁止共享写**：只读并行 or 独立 checkout or 串行 | worktree 隔离 + 自动 integration | Open |
| 5 | DAG Deadlock | 循环依赖 / 相互等待 | MVP 无环校验 + 无嵌套 spawn，结构上消除环 | 运行时环检测 + 超时打破 | Open |
| 6 | Infinite Spawn | Agent 递归创建子 Agent | **禁止 child spawn child**（maxDepth=1） | 受控多级 + 配额/深度双重限制 | Open |
| 7 | Infinite Conversation | Agent 之间自由对话不收敛 | 封闭 typed messages + 无 agent↔agent 直聊 + 消息上限 | 对话轮次预算 + 仲裁者 | Open |
| 8 | Retry Loop | 失败无限重试 | maxRetries 硬上限 + 指数退避 + 分类可重试性 | 预算感知重试 | Open |
| 9 | Reviewer Loop | review→rework→review 永不收敛 | review 有明确终点：最多 N 轮，超限升级人工 | 收敛性度量 + 自动放弃 | Open |
| 10 | Quota Exhaustion | 配额耗尽导致中途失败 | **等 Phase 4**；MVP 先做预留/释放接口占位 | 真配额预留 + 降级/串行化 | Blocked by Phase 4 |
| 11 | Resource Exhaustion | 多个本地重模型抢 VRAM/RAM | 资源感知并发限制（本地重模型默认串行） | 动态资源调度 | Open |
| 12 | Authentication Failure | CN 401 类失败被误判 | 复用现有 `exit 0 需协议证据`（WorkBuddy 已实现） | 统一 auth 探针 + 派发前检查 | **Partially handled** |
| 13 | Process Orphan | 父取消/崩溃后子进程残留 | 复用现有 cancel/taskkill 路径 + child 绑定父生命周期 | Job Object + lease/heartbeat 回收 | Open |
| 14 | Crash Recovery | orchestrator 崩溃后状态丢失 | MVP 不承诺跨崩溃恢复 | 持久化 task state + lease 重建 | Open |
| 15 | Permission Escalation | child 拿到比 root 更高权限 | child 权限 ≤ root；危险动作需批准 | 能力令牌 + 最小权限派生 | Open |
| 16 | Model Selection | Agent 随意换模型 → 成本/质量失控 | **Agent 不得自选模型**；model 由调用方/Policy 显式给 | Phase 4 Model Policy | Blocked by Phase 4 |
| 17 | Agent Capability Mismatch | 把一个任务派给不支持的 Agent | 派发前读 capability matrix 并拒绝 | 能力协商 + 自动降级候选 | **Partially handled** |
| 18 | Result Conflict | 多个子结果互相矛盾 | 标记 conflict，不静默合错 | 仲裁 Agent + 置信度聚合 | Open |
| 19 | Artifact Loss | 产物丢失/覆盖 | artifact 落盘 + reference + hash | 版本化 artifact store | Open |
| 20 | Stale Context | 子 Agent 用过期上下文 | brief 带 taskId/revision，变更即失效 | 版本化上下文 + 失效传播 | Open |
| 21 | Human Approval | 昂贵 fan-out / 危险动作未经批准 | 昂贵 fan-out 需显式确认（先设计） | 策略驱动的审批流 | Open |
| 22 | Observability | 看不到 Agent Tree 状态 | Dashboard 展示树/状态/阻塞/重试 | 完整 trace + 时序 | Open |
| 23 | Cost Attribution | 无法归因到任务/Agent/模型 | token 如实记录；cost 标注不可得 | Phase 4 配额 + 成本归因 | Blocked by Phase 4 |

**"Partially handled" 说明：** 认证失败（#12）与能力不匹配（#17）在**单 Agent**层面
已被 Runtime 正确覆盖；Multi-Agent 需要把它们**从单次执行提升为派发前/聚合层检查**。

---

## 3. 参考项目及其可复用设计

来源与验证深度见 `docs/REUSE_ANALYSIS.md`。本轮补充 Multi-Agent 相关的判断：

| 参考 | 可复用的设计（不是代码） | 用在哪里 |
|---|---|---|
| **OpenAI Codex Multi-Agent / subagents** | 子任务作为独立可寻址执行单元；父任务聚合子结果；显式 review 阶段 | Task/DAG 模型、Review 阶段 |
| **OpenAI Agents / orchestration patterns** | "handoff vs orchestration" 二分的清晰词汇；有界循环 | 通信类型、终止条件 |
| **Chorus / Fifony** | 多 Agent 协作的编排骨架与角色分工 | Agent Hierarchy 参考（对比，不照搬） |
| **Magentic-One** | Orchestrator + 专用 agent 分工 + 任务台账（ledger）思想 | Task ledger / 进度台账 |
| **MetaGPT** | SOP 化的角色流水线（PM/架构/工程/QA） | 阶段化（研究→实现→测试→审查）参考 |
| **OpenHands** | 事件流驱动 + 运行时可观测 | 复用本项目已有 EventHub 观测模型 |
| **AG2 (AutoGen)** | 多 Agent 对话/群聊模式与其失控风险 | **反面参考**：正是要避免的无限制 chat |
| **Temporal** | 持久化工作流、activity 重试、幂等、信号 | Future Recovery 参考（本轮**不引入**重量级框架） |
| **Symphony** | 并行任务/编排调度 | 调度层对比参考 |
| **本项目既有 NAR / pi-subagents 借鉴** | model-free kernel、显式 agentId、capability gate、task/thread 分离 | **直接地基**（已在 Phase 1 落地） |

**结论：** 现有项目已经在 Phase 1 吸收了最接近的 NAR / pi-subagents / agents-mcp-gateway
的契约设计。Multi-Agent 阶段最值得补的是 **task ledger（Magentic-One）、有界编排
（Agents patterns）、显式 review 阶段（Codex）**，以及从 Temporal 借来的
**幂等/lease/恢复思想**（但 MVP 不引入其框架）。**没有任何上游项目的代码会被直接复制。**

---

## 4. 当前项目与参考项目的差距

| 维度 | 成熟 Multi-Agent 项目 | 本项目现状 | 差距等级 |
|---|---|---|---|
| 任务模型 | parent/child + DAG + 状态机 | 单 task，无父子、无依赖 | **大** |
| 调度 | 依赖感知并行、资源调度 | 一次一个 run，无调度器 | **大** |
| 通信 | typed messages / message bus | 无 | **大** |
| 隔离 | worktree / sandbox / 容器 | 无 worktree，sandbox 多数不支持 | **大** |
| 预算/配额 | 预算预留 + 实际用量 + 释放 | 无配额后端（Phase 4） | **大（依赖 Phase 4）** |
| 恢复 | 持久化工作流 + lease | store 有 task/thread，但无 lease/心跳 | 中 |
| 可观测 | 完整 trace + 树 | EventHub + Dashboard（单任务） | 中 |
| 身份/能力 | 能力协商 | **已具备 capability matrix + 显式 agentId** | **小（已领先）** |
| 失败语义 | 分级 + 幂等 | 单次执行终态已冻结正确 | 小 |

**最大差距是"任务模型 + 调度 + 隔离 + 预算"四件套。**
其中**预算必须等 Phase 4**；**隔离需要先解决 worktree 能力缺口**。

---

## 5. MVP 建议（5A 之后的最小可行路径）

MVP 的目标是**用最小改动验证"Multi-Agent 是否值得"**，而不是造完整引擎。

**MVP 形态（Root → 一层 Workers + 一个 Reviewer）：**

```text
Root Orchestrator（本项目，唯一能派发者）
       │
       ├── Worker A  (只读或独立 checkout)
       ├── Worker B  (只读或独立 checkout)
       └── Reviewer  (Codex，独立审查)
                 │
            Parent 聚合（不自动合错）
```

**MVP 硬约束：**

- `maxDepth = 1`，`maxChildren` 硬上限，`maxConcurrentAgents` 硬上限。
- 无环、无嵌套 spawn，child 不能创建孙 Agent。
- 通信只用封闭 typed messages，无自由 chat。
- **写任务必须隔离**（独立 checkout/目录）或**串行**；只读任务才可并行共享。
- 每个 task 有 `parentTaskId`、`dependencies`、`assignee`、`acceptanceCriteria`、`retryCount`。
- 每任务必须带 token 预算与 TTL；无证据不得判成功（沿用现有 exit-0 纪律）。
- reviewer 只有 Codex；review 有明确终点（最多 N 轮）。
- Multi-Agent 由用户显式开启，UI/CLI 上默认关闭。

**MVP 明确不做：** 自动任务分解、自动 agent 选择、多层嵌套、自由对话、
自动合并冲突、自动配额预留。

---

## 6. Future Architecture（分层愿景）

```text
                 ┌─────────────────────────────────────────────┐
                 │             User Control (Q)                │
                 │  Multi-Agent 开关 / 审批 / pause / cancel    │
                 └───────────────┬─────────────────────────────┘
                                 │
        ┌────────────────────────▼─────────────────────────┐
        │           Orchestration Layer (新)                │
        │  Task Graph · Scheduler · Budget · Policy Hook    │
        └───────┬─────────────────────┬─────────────────────┘
                │                     │
   ┌────────────▼───────┐   ┌─────────▼────────────────────┐
   │  Task/DAG Store     │   │  Communication (typed msgs)  │
   │  parent/child/deps  │   └──────────────────────────────┘
   └────────────────────┘
                │
   ┌────────────▼─────────────────────────────────────────┐
   │   Existing Runtime: AgentSession / Transport /        │
   │   EventHub / SessionStore  （保持不变，逐次执行）      │
   └──────────────────────────────────────────────────────┘
                │
   ┌────────────▼───────────────┐   ┌──────────────────────┐
   │  Adapters (opencode/codex/  │   │  Decision Layer       │
   │  workbuddy-cn/intl/…)       │   │  (Laya, 独立)         │
   └────────────────────────────┘   └──────────────────────┘
```

**关键原则：Orchestration Layer 是"执行多次单 Agent run 并管理其关系"的新层，
不是把现有 Runtime 改成 Multi-Agent。** 现有 Runtime 继续只负责"一次执行"，
Orchestration 负责"多次执行之间的关系、预算、隔离与聚合"。
这样 Phase 1 的硬化成果不被推翻。

---

## 7. Token / Quota 控制方案

### 7.1 预算维度（H）

```text
globalBudget            整个 orchestrator 生命周期
perTaskBudget           单个 parent/child task
perAgentBudget          单个 agent identity
maxConcurrentAgents     并发上限
maxFanOut               一次 fan-out 的子节点上限
maxDepth                Agent 层级上限（MVP = 1）
maxRetries              每任务重试上限
maxTurns                每 Agent 对话/工具轮次上限
TTL                     任务最长存活
idleTimeout             无进展判定
```

**Spawn 前的强制问题：** "为什么值得额外消耗这些 token？"
派发必须记录 selection reason（显式或 Policy 给出的理由），否则不派发。

### 7.2 Quota（I）—— 必须先有 Phase 4

Multi-Agent 的配额控制**不能在 Phase 4 之前实现**，因为：

- 当前 `costReporting` 大多不可信（Codex 只有 token，WorkBuddy 恒 0）。
- 没有 remaining/used/reset/free credit/source 的统一来源。

**因此 MVP 只定义接口占位：** `reserveBudget()` / `commitUsage()` / `releaseUnused()`，
实现留空并在 Phase 4 接线。**明确标记"Blocked by Phase 4"。**

---

## 8. Agent Hierarchy 方案（C）

**MVP：只有 Root 能派发，`maxDepth = 1`。**

```text
Root Orchestrator
       ├── Worker A
       ├── Worker B
       └── Reviewer
```

**Future（明确暂不做）：**

```text
Root
 └─ Agent A
     └─ Agent B   ← 需要 maxDepth>1 + 每层预算 + 每层审批
         └─ ...
```

规则：

- `spawn permission` 只属于 Root Orchestrator。
- `child budget` 从 parent 预算分配，child 不得超 parent。
- `child capability` 必须由调度器按 capability matrix 校验后再派发。
- `child cancellation propagation`：父取消 → 所有在跑 child 取消。

---

## 9. Communication 方案（E / F）

**只做 typed communication，禁止无限制 Agent Chat。**

```text
task_assigned    父 → 子：任务、验收标准、上下文 brief、预算
progress         子 → 父：进度
question         子 → 父：需要澄清（有超时，不得卡死）
blocked          子 → 父：阻塞原因
artifact_ready   子 → 父：artifact reference（路径+hash+摘要）
review_request   父 → reviewer
review_result    reviewer → 父：findings 分级
handoff          父 → 子：接力
cancel           父 → 子
heartbeat        子 → 父：存活/lease
```

必须考虑：message routing、ack、timeout、correlation id、parent/child 关系、
持久化、重复消息、过期消息、消息环路、context size。

**Context Management（F）：**

- parent→child：只传结构化 brief（任务 + 约束 + 验收 + 相关 artifact ref）。
- predecessor→successor：传**结果摘要**，不传 transcript。
- sibling isolation：兄弟互不可见，除非显式通过父任务转发。
- **禁止默认把整份 Root Conversation 复制给所有子 Agent。**

---

## 10. DAG 方案（B）

Task 记录字段：

```text
parentTaskId · taskId · dependencies[] · assignee · status
artifacts[] · acceptanceCriteria · retryCount · parent/child relationship
```

**状态机（建议）：**

```text
planned → queued → running → blocked ─┐
              │            │          ├→ to_verify → succeeded
              │            └→ failed ──┼→ retrying → running
              │                        ├→ rework   → running
              └─────────────────────── └→ replanning → planned
cancelled（任意状态可达）
```

必须处理：DAG、cycle detection、deadlock、orphan task、dependency failure、partial completion。
**MVP 用"无嵌套 + 显式依赖列表 + 无环校验"从结构上消除大部分死锁。**

---

## 11. Failure / Recovery 方案（J / O）

### 11.1 失败分类（必须区分）

```text
execution failure · timeout · blocked · quota exhausted
authentication failure · review rejected · external dependency failure
```

### 11.2 retry / re-execute / rework / replan 的区别

| 术语 | 含义 | 是否重复副作用 |
|---|---|---|
| retry | 同一任务、同一 Agent、原样再来一次（幂等前提） | 仅当任务幂等 |
| re-execute | 同任务、可能换 Agent/参数再跑 | 同上 |
| rework | review 拒绝后，带 findings 重做 | 通常会改文件 |
| replan | 任务模型本身重规划（拆解/依赖变化） | 不直接产生副作用 |

**幂等性：** 写文件类任务必须有"是否已产生副作用"的记录，避免 retry 重复写入。

### 11.3 Recovery（O）—— MVP / Future 两级

- **MVP：** 不承诺跨 orchestrator 崩溃恢复。只保证单进程内 task 状态正确、
  取消传播、孤儿尽量回收（复用现有 Windows 进程清理）。
- **Future：** 持久化 task state + heartbeat/lease + orphan reclaim + event dedup + idempotency。
  **本轮明确不引入 Temporal 等重量级工作流框架**，先形成设计再决定。

---

## 12. Security / Permission 方案（N / L）

- **child 权限 ≤ root 权限**，绝不无条件提升。
- 凭证隔离：child 复用已登录身份，但**不读取、不复述凭证**（沿用现有 adapter 纪律）。
- filesystem scope：child 只能访问其任务声明的目录；默认不共享写。
- network / destructive / merge / publish / account 操作：需要 human approval。
- **Review（L）：** OpenCode → implementation，Codex → independent review。
  **不得把 Codex 自动变成普通 implementation worker。** review 有明确终点
  （最多 N 轮，超限升级人工），避免 reviewer loop。

---

## 13. Observability 方案（P）

Dashboard 后续展示 Agent Tree：

```text
Task
 ├─ Agent A → Model / Status / Token / Artifact
 ├─ Agent B → ...
 └─ Reviewer → findings
```

并展示：current stage、blockers、retries、messages、artifacts、token、cost、
quota、selected Agent、selected Model、selection reason。

**本轮 Dashboard 只加"设计态"面板（Research/Not Implemented + Risk Matrix），
不接入任何 Multi-Agent 运行数据**（因为还没有运行数据）。

---

## 14. User Control 方案（Q）

```text
Multi-Agent 开关 · spawn confirmation · pause · resume
cancel child · cancel whole tree · manual Agent override
manual Model override · expensive fan-out approval
```

**用户始终拥有最终控制权。** 昂贵 fan-out 必须显式确认。

---

## 15. Evaluation 方案（R）

未来必须做 A/B 对比：

```text
Single Agent  vs  Multi-Agent
指标：token / cost / wall time / success rate / rework
      / review findings / failure rate / resource usage
```

**Multi-Agent 不是因为"看起来高级"就默认使用。若指标不优，退回 Single Agent。**

---

## 16. Roadmap 细化（Phase 5）

```text
Phase 5A Research              ← 本轮（DONE after this doc）
Phase 5B Architecture
Phase 5C Cost / Safety Gate
Phase 5D Task DAG
Phase 5E Agent Hierarchy
Phase 5F Communication
Phase 5G Execution
Phase 5H Review / Integration
Phase 5I Recovery / Observability
```

**但现在是 5A 状态，只调研，不实现。**

---

## 17. 明确"暂时不解决"与"必须等 Phase 4"

### 17.1 暂时不解决（MVP 之外，先记录）

- 多层嵌套 Agent（depth > 1）。
- 自动任务分解 / 自动 Agent 选择 / Auto Mode。
- 自由 Agent 对话（只做 typed messages）。
- 自动合并代码冲突 / 自动仲裁冲突结果。
- 跨 orchestrator 崩溃的完整恢复。
- 完整资源调度器（GPU 感知的复杂调度）。
- 版本化上下文 / 自动 context compaction。

### 17.2 必须等 Phase 4 Quota / Model Center 才能实现

- 真配额预留 / 实际用量 / 未用释放（#10 Quota Exhaustion）。
- Model Policy 约束"Agent 不得随意选模型"（#16 Model Selection）。
- 可信的成本归因（#23 Cost Attribution）。
- 配额耗尽时的降级 / 串行化策略。
- 预算感知的 retry / fan-out 决策。

### 17.3 必须等隔离能力解决才能实现

- 写任务的真正并行（需要每 worker 独立 checkout / worktree）。
- 自动 integration / 冲突合并。

---

## 18. 结论

- **Multi-Agent 是本项目的可选能力，Single Agent 是默认。**
- 当前 Runtime 的地基（显式 agentId、capability matrix、task/thread 分离、
  冻结终态、EventHub）**适合承载** Multi-Agent，不需要推翻。
- 但 Multi-Agent 所需的 **Task/DAG、调度、通信、隔离、预算** 五件套**尚不存在**，
  且**预算与 Model Policy 必须等 Phase 4**。
- **建议：先完成 Phase 4，再进入 Phase 5B Architecture。**
  本轮只封存 5A Research，不实现。
