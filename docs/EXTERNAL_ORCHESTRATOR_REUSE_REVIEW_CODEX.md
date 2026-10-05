> **[Historical — 2026-09-30 Codex 复核]** 复核结论已被后续实现阶段吸收（ACRouter license 更正等见 P6_ORCHESTRATION_PLAN §12）。当前基线见 docs/PROJECT_BASELINE.md。

# EXTERNAL ORCHESTRATOR REUSE AUDIT — 独立复核（Codex Reviewer）

```text
Reviewer  = Codex（独立，只读）
Date      = 2026-09-30
Subject   = docs/EXTERNAL_ORCHESTRATOR_REUSE_AUDIT.md
Baseline  = 本项目 commit 1ae782e（2559 tests / typecheck clean —— 按任务给定基线，本轮未重跑）
Method    = 10 个上游仓库全部存在于 D:/yunxibaili/orchestrator-research/（depth 1），
            逐条以源码/LICENCE/HEAD 核对；另对 5 个候选仓库做网络抽查（git ls-remote + raw LICENSE）
Boundary  = 只读复核；未修改 src/tests/config/runtime；只新增本文件
```

## 0. 复核方法

- 复核对象是**那份尽调报告**是否可靠，不是重新做一遍尽调。
- 每条报告结论都用源码定位：文件是否存在、行数、符号、LICENCE、HEAD SHA。
- 无法本地验证的（网络仓库星数、issue 数）不重复断言；新增候选只用可复核证据（`git ls-remote` + raw `LICENSE`）。
- 复核证据均给出路径与行号；`D:/yunxibaili/orchestrator-research/<repo>/...` 为只读来源。

### 14 个提问的独立判定（速览）

| # | 问题 | 判定 |
|---|---|---|
| 1 | DIRECT_REUSE 是否成立 | **不成立**——矩阵里没有一条真正的 DIRECT_REUSE，唯一标 `DIRECT` 的是“DIRECT 概念”，属分类错误 |
| 2 | ADAPT_REUSE 是否有证据 | **多数有**（见 §1）；个别低估（loom）或高估（pi revival） |
| 3 | License 判断 | **一处错误**（agent-as-a-router 实为 MIT）、一处遗漏（claude-squad 为 AGPL） |
| 4 | README 与源码一致性 | 大体诚实；对 AO 的 `DOC_CODE_MISMATCH` 定性**过强** |
| 5 | Dynamic DAG / Replan 是否真实 | **真实**（loom 1–50 轮、pi revival 深度 16） |
| 6 | Review verdict 是否回 Task State | 部分：NAR/AO 真实写状态；pi 是“注入 parent 上下文”而非状态迁移；cezar 是人工 gate |
| 7 | Retry/Rework 是否改变后续决策 | **真实**（NAR repair directive、cezar autoResumeAttempts、pi revival chain） |
| 8 | Routing 是否用 capability/history | 各家均**无自动选择**；NAR 只产出分数供调用方（README 明文） |
| 9 | “Routing 是空白市场”是否证据充分 | **方向成立**，但表述不严（NAR 有评分、ACRouter 有 observe 环、loom 有 hop router） |
| 10 | loom `orchestra.ts` 是否值得重点复用 | **不应作为“移植”对象**，降为 REFERENCE（LLM planner + 自持 git/worktree） |
| 11 | Cezar 是否遗漏重要模块 | 遗漏 `core/agent-model-policy.ts`（models-locked 开关）等 |
| 12 | NAR `stats.py`/repair 是否值得移植 | `stats.py` 是**评分函数**不是 router；repair 流程真实，值得 ADAPT |
| 13 | 是否遗漏更接近需求的项目 | **是**（vibe-kanban 最接近；claude-squad 为 AGPL 陷阱；agentapi/claude-flow/task-master） |
| 14 | 哪些机制会破坏当前项目 | 见 §5、§6（第二 TaskStore / 第二 planner / 自持 worktree / 第二执行边） |

---

## 1. Confirmed（有源码证据支持）

**仓库与版本**：10 个仓库全部存在且 HEAD 与报告一致。
`agent-as-a-router e43839e` · `agent-orchestrator 8de638a` · `cezar ab2c35d` · `dagents d850b38` ·
`loom eab14c3` · `native-agent-router d65bd49` · `orca f9efbb4` · `pi-subagents 0958598` ·
`superpowers 8ca22db` · `symphony be10a1b`。

**symphony**
- `@failure_retry_base_ms 10_000`：`elixir/lib/symphony_elixir/orchestrator.ex:14`（退避在 :1242）。
- `reconcile_running_issues` / `reconcile_blocked_issues`：同文件 `:310` / `:335`（tick 中 `:259-260`）。
- `workspace.ex` 确为 `File.rm_rf!` + `mkdir_p!`，**不是 git worktree**（`:46,:63,:88-89,:109,:161,:310`）。
- `LICENSE` + `NOTICE`（`NOTICE` 554 bytes，OpenAI Apache-2.0）→ 报告的 “Apache-2.0 + NOTICE” 正确。

**agent-orchestrator (AO)**
- `service/session/delegation.go`：`DelegateTask` 一次性派工（`PrepareTask :49`、`DelegateTask :67`）→ “无 DAG 调度核心”成立。
- `autoreview/coordinator.go`：`DefaultIdleThreshold`、`autoReviewFailedRetryLimit = 3`、周期性 sweep → 报告的 “idle 触发 / 3 次上限”正确。
- `review/review.go`：`UpdateReviewRunResult(..., domain.ReviewVerdict)` → verdict 持久化正确。
- `service/usage/collector.go`（73KB）、`internal/adapters/agent/` 共 **45** 个 adapter → “40+ adapters / usage collector”正确。

**loom**
- `src/core/orchestra.ts`：`dependsOn`、`maxParallel`、`TaskHold{kind:"decide"|"wait"|"zone"|"capacity"}`、`maxRounds` 被 `clamp(...,1,50)`、`waiting_human`、`budgetUsd`+`budgetWarned` → 报告的 DAG/准入门/多轮 replan/预算暂停**均真实**。
- `src/core/worktree-merge.ts` 存在（6572 bytes ≈ 153 行）。

**cezar**
- `workflows/run.ts`(5449) / `runs/store.ts`(1626) / `dispatch/engine.ts`(211，纯函数：`DISPATCH_MAX_IN_FLIGHT`、`MAX_PENDING_REPORTS=20`、`budgetUsd − costUsd − Σ children.budgetUsd`) / `dispatch/prompts.ts`(57) / `runs/review-gate.ts`(**22 行，人工 gate**) / `workspace/semaphore.ts`(284) / `git-worktree.ts`(555) / `runs/retention.ts`(120) —— 报告点名模块全部存在且职责吻合。
- `.test.`/`.spec.` 文件 **515** 个 → 报告的 “515 个测试文件”正确。

**native-agent-router (NAR)**
- `kernel/kernel.py`(641)、`kernel/store.py`(219)、`kernel/stats.py`(101)、`adapters/zcode_native.py`(561)。
- `compute_score(...)` 全部由客观信号构成（verify/repair/out_of_scope/git baseline/blocked/cancel/usage），**零模型调用** → 报告 “确定性评分”正确。
- 修复闭环真实：`_compose_prompt(..., repair_note)` 会写 `REPAIR DIRECTIVE`（`kernel.py:320-321`），`repair_allowed` 是显式设置（`:115`）。
- README `:125-126` 明文：**每个任务必须显式给 `agent_id`，不存在全局选择** → “stats 供调用方决策、kernel 不选 agent”成立。

**dagents**
- `packages/workflow/src/engine/executor.ts`(745)、`utils/validate-topology.ts`(169)、`packages/agent-adapters/src/stream-backend.ts`(522)；`agent-adapters/src` 29 个文件。
- `tiers.ts` 是**静态维护分级**（core/community + verified/docs-only），不是能力路由 → 报告正确。

**superpowers**：`index.js` 恰为 9 行，仅注册 OpenCode v2 目录形态插件 → “无编排代码”正确。

**orca**：根目录**无 LICENSE**；README `:9,:27,:39` 确为 git worktree + tmux → 报告正确。

**pi-subagents**
- `src/watchdog/review.ts`(334)：`WatchdogWarnParams` = `severity` + `importance` + `evidence` + `recommendedAction`（TypeBox schema）→ 报告 schema 正确。
- 回流真实：high 级告警被注入 parent 内容（`src/runs/foreground/subagent-executor.ts:3109`），`notify.ts:722` 另处理 `severity==="blocker"`。
- `src/workflows/workflow-revival.ts`：`MAX_REVIVAL_DEPTH = 16`，且以 depth 校验链式复活 → 正确。
- 大文件：`src/runs/foreground/subagent-executor.ts` 446,559 bytes（≈7963 行）；`src/runs/background/scheduled-runs.ts` 50,899 bytes（≈1012 行）；`src/runs/shared/worktree.ts` 1434 行 → 报告尺寸基本正确。
- `src/agents/agent-selection.ts` 仅 21 行且确非路由 → “DOC_CODE_MISMATCH”正确。

**本项目缺口（对照当前 src 实证）**
- `applyVerification(` 在 `src/` 内**只有定义、没有调用者**（`src/orchestration/orchestrator.ts:478`）→ “review verdict 未回流”成立。
- `rework` 仍返回 `rework-not-implemented`（`orchestrator.ts:480-484`），scheduler 头注释明写 “never implements retry, rework, replan, or review” → 成立。
- `src/orchestration/*` 不 import `src/decision/`（只有 `SpawnGateDecision` 命名撞词）→ “Laya 未接 orchestration”成立。
- `src/orchestration/store.ts` 仍是内存 `Map`（`:61,:63`）→ “无持久化”成立。

---

## 2. Downgraded（应从更高档位下调）

1. **loom `orchestra.ts`：`ADAPT_REUSE` / “最值得移植的单件” → `REFERENCE_ONLY`。**
   它**自带 LLM planner**（`orchestratorTurn(run, "Plan the goal into tasks and spawn them now.")`，`src/core/orchestra.ts:1067`），并且**自己跑 git**（`execFile("git", ...)`，`:710`；`gh` 在 `:766`）来完成 worktree/merge。
   若按报告“移植到 src/orchestration/ 作为 Parent Planner 层”，等于同时引入**第二个 planner** 与**第二个 workspace 生命周期所有者**——正是报告 §10 自己禁止的 “绕过唯一执行边 / 第二 TaskStore”。
   可取的只有**思想**：TaskHold 准入门（decide/wait/zone/capacity）、有界 rounds、JSON action 协议。

2. **pi-subagents `workflow-revival`：“DIRECT 概念” → `REFERENCE_ONLY/ADAPT`。**
   `DIRECT 概念` 是自相矛盾的标签（概念不可能 “direct reuse”）。该模块绑定 pi 的 run/agent 与扩展宿主（`peerDependencies: @earendil-works/pi-agent-core|pi-ai|pi-coding-agent|pi-tui`），不是可搬的独立实现。

3. **NAR `stats.py`：读作“路由实现” → 读作“评分函数”。**
   证据：NAR README 明令每任务显式 `agent_id`，`kernel.py` 无任何选择函数（`def .*select|choose|pick` 无命中，仅 zcode 内部的 provider option 选择）。它是**给调用方的特征输出**，不是 router。

4. **ACRouter：`ADAPT_REUSE（重写，不可复制）` → `ADAPT_REUSE（MIT，可复制+署名）`。**（依据见 §3.1）

5. **AO “scheduler/DAG → NOT_USEFUL / 不存在” → “无 task-graph 调度，但有可研读的 tick+lease 调度器”。**
   `backend/internal/service/automation/scheduler.go`(11065 bytes) 与 `schedule.go`(6439) 实现了 RRULE/cron 定义 → `Tick()` 物化 → `ClaimNextAutomationRun` → `MarkAutomationRunRunning/Complete/Fail`，含 `spawnLease=2min`、`catchupLimit/dueScanLimit`。
   这与本项目 `TaskScheduler.tick`、symphony 的 reconcile-on-tick 属同一族模式，**值得读**，只是不是 DAG 调度。

6. **AO 的 `DOC_CODE_MISMATCH` 定性过强。**
   README `:16-18,:31-35` 描述的是“每个任务一个 agent/workspace/反馈环 + 本地桌面工作台 + Kanban 追踪”，并未宣称 DAG 调度器；代码正是如此。准确说法是 “AO 是 session/workspace 级编排器，不是任务图调度器”。

7. **pi-subagents watchdog（局部）**：应从“直接可用”收窄为“**schema + policy** 可用”。模块本身 `import` pi SDK（`src/watchdog/review.ts:1-3`），不可整体搬运；报告正文已写 “(schema+policy)”，但 §9 第 2 条措辞容易被读成搬模块。

---

## 3. Incorrect（判断错误）

### 3.1 `agent-as-a-router` 的 License —— **错误，且改变法律结论**
报告原文：*“无 LICENSE 文件”*、`LICENSE 缺失 = 默认版权保留，代码不可复制，只可重写概念`，§11 又列为 “唯二例外”。

实测：
- 仓库根存在 `LICENSE`（**MIT**，1077 bytes，`Copyright (c) 2026`）；另有 `cc-switch/LICENSE`、`claude-code-router/LICENSE` 各 1087/1088 bytes（两个 fork 各自许可）。
- 目标文件 `src/acrouter_repro/inference.py`（204 行）为该仓库自有复现代码，`ACRouter.route` / `run_with_verifier` / `observe` 都在其中。

结论：**MIT 允许复制、修改、再分发（保留版权与许可声明）**。因此
(a) “只能重写概念” 不成立；
(b) §11 “唯二例外（ACRouter 与 orca 无 LICENSE）” 只剩 orca 一例。

### 3.2 cezar “恢复套件” 引用的是**测试文件**
报告 §3.4/§4 写 `workflows/recover-{dispatch,autonomous,followups,session-failure,no-session}.ts` 为可复用 “恢复套件”。
实测：这五个精确文件名**全部是 `.test.ts`**（`recover-dispatch.test.ts` 等）。真正的实现位于 `packages/cezar/src/workflows/run.ts`（`AUTO_RESUME_GRACE_MS=30_000`、`MAX_AUTO_RESUMES=12`、`AUTO_RESUME_MISSED_WINDOW_MS`、`resumeInFlight()`、`AUTO_RESUME_PROMPT`）与 `workflows/continuation-context.ts`。
→ 把测试当模块引用，会让读者找错文件。

### 3.3 行数/规模数字误差（不致命，但多处）
- `symphony/…/orchestrator.ex` 报告 1990 行，实际 **1632** 行。
- `loom/src/core/orchestra.ts` 报告 2421 行，实际 **2294** 行 / **108 KB**；且它所在仓库有 **915 个文件**（daemon、web UI、team 模块、自有 provider adapters），报告 “8★ 单作者、成熟度低” 的叙述掩盖了耦合规模。
- `pi-subagents/agents/agent-selection.ts` 报告 25 行，实际 **21** 行（结论不变）。
- `superpowers/skills` 报告 16 个目录，实际 **15** 个。
- `AO process/command_windows.go` 被描述为 “Windows spawn 特判”，实际仅 267 bytes 的 `CREATE_NO_WINDOW` + `HideWindow`（隐藏窗口，不是 spawn 策略）。

---

## 4. Missing（漏掉的重要项目 / 模块 / 问题）

### 4.1 漏掉的候选项目（均已网络抽查存在性 + License）
| 项目 | License | 与当前需求的相关性 |
|---|---|---|
| **BloopAI/vibe-kanban** | **Apache-2.0**（raw `LICENSE` 实测） | 最接近：README 首屏即 “Get 10X more out of Claude Code, Gemini CLI, Codex, Amp and other coding agents”，多 agent 并行 + 每任务 worktree + 看板 + 逐次尝试会话。**报告完全未提。** |
| **smtg-ai/claude-squad** | **AGPL-3.0**（`LICENSE.md` 实测为 GNU Affero） | 终端多 agent（Claude Code/Codex/Gemini/Aider）+ 独立 git workspace。**这是 License 陷阱**，报告本应像当年对 Chorus 那样点名，却完全没有 |
| **coder/agentapi** | MIT（`Copyright (c) 2025 Coder Technologies`） | 把 Claude Code / Codex / Goose 包成 HTTP+WS API —— 对应本项目 “native CLI → 稳定本地接口” 的选型参考 |
| **ruvnet/claude-flow** | MIT | Claude Code 多 agent swarm 编排；主张夸张，但代码可读 |
| **eyaltoledano/claude-task-master** | **自定义 “Task Master License”**（MIT 正文外加自定头） | PRD→任务树/依赖分解，对应本项目 “任务分解” 缺口；License 头需逐条读，不可当纯 MIT |

### 4.2 漏掉的上游模块
- **AO `service/automation/{scheduler,schedule}.go`**：durable tick + lease + catchup 的调度器（见 §2.5）。
- **cezar `core/agent-model-policy.ts`**：`CEZ_AGENT_MODELS_LOCKED` / `modelsLocked` 的**模型锁定开关**（“agent 不得随意选模型” 的一个现成形态）。报告矩阵只提 cezar 的 RunStore/dispatch/recovery，漏了这一条与本项目 Model Policy 直接相关的小模块。
- **NAR `adapters/acp_generic.py`（13KB）+ `adapters/jsonrpc.py`**：报告只提 `zcode_native.py`，但通用 ACP 适配层对 “未来接 ACP/ app-server” 的参考价值不低于 ZCode 专用层。

### 4.3 被“顺带提及却未入矩阵”的对象
`LangGraph Command(goto)`、`Temporal`、`OpenHands`、`ADaPT(archiki/ADaPT)` 在 §6/§8 被用来支撑结论，但**既无源码定位也无 License 行**。要么补进矩阵（含 License + 证据路径），要么不要用它们支撑结论。

---

## 5. Reuse Corrections（最终确认）

### 5.1 可以直接研究 / 移植的代码（License 干净，且不与现有权威冲突）
| 来源 | 可搬的部分 | License | 前置条件 |
|---|---|---|---|
| pi-subagents `src/watchdog/review.ts` | **warn payload 的字段与取值域**（severity/importance/evidence/recommendedAction）+ 严重度策略；建议只重写类型，不搬模块 | MIT | 模块本身依赖 pi SDK；只取 schema/policy |
| NAR `kernel/stats.py` | `compute_score()` 的**减分因子表**（verify/repair/out-of-scope/git baseline/blocked/cancel/usage）作为 feature 源 | MIT | 它是评分函数，不是 router |
| NAR `kernel/kernel.py` 的 verify→repair→re-verify | “一次预授权修复 + 固定 verify 命令 + 取尾部日志” 的**最小闭环形态** | MIT | 不取其执行器/存储 |
| ACRouter `src/acrouter_repro/inference.py` | `route → run_with_verifier → escalate → observe` 循环（204 行，无重依赖） | **MIT（本轮更正）** | 需自备 task→dimension 分类；不搬其训练型 router |
| cezar `dispatch/engine.ts` | **纯函数**预算/在飞/报告算术（`budgetUsd − costUsd − Σ children.budgetUsd`、`MAX_PENDING_REPORTS`） | MIT | 只取算术，不取 RunManager/Store |
| AO `service/automation/{scheduler,schedule}.go` | tick + lease + catchup 的**调度形态**（含 RRULE/cron 时区锚点） | Apache-2.0 | Elixir/Go 语义需重写为 TS |
| AO `autoreview/coordinator.go` | “空闲阈值 + 同一 PR head 重试上限 + 只读第二 agent” 的**策略参数** | Apache-2.0 | 只取策略 |
| dagents `validate-topology.ts` / `stream-backend.ts` | 拓扑校验与 NDJSON 行解析/kill 升级的**交叉验证素材** | Apache-2.0 | 仅作对照，不引入其 DB 栈 |
| superpowers `skills/*/SKILL.md` | implementer / reviewer / re-review 的 **prompt 文本** | MIT | POSIX bash 工具不可用 |

### 5.2 只能参考的实现（可读、可描摹，不可整体搬）
- **loom `orchestra.ts`**（LLM planner + 自持 git/worktree；与本项目 WorkspaceManager / 唯一执行边冲突）。
- **AO 的 session/Kanban 模型**（项目定位是工作台，不是任务图）。
- **cezar 的 cockpit（web/desktop/tracker）** 与 `workflows/run.ts`（5449 行，抽算术即可，别搬状态机）。
- **symphony 的 Elixir 代码**（仅状态机与退避逻辑；`orchestrator.ex` 1632 行）。
- **pi-subagents 的 missions / scheduled-runs / subagent-executor**（宿主绑定 + 8000 行）。

### 5.3 不应该碰的实现
- **orca**：无 LICENSE（默认保留版权），tmux/Unix-only。
- **smtg-ai/claude-squad**：**AGPL-3.0**，复制进本项目会触发网络服务 copyleft。
- **任何替代 `TaskStore` 单权威的设计**：loom 的 per-run JSON、cezar RunStore、AO 的 SQLite 会话事实模型——它们各自是**另一套 task authority**，只能作为“状态字段该有什么”的参考。
- **任何自持 worktree/merge 的模块**：loom `orchestra.ts` 的 `execFile("git")`、cezar `git-worktree.ts` 属于**第二 workspace 所有者**。
- **任何自建执行内核**：NAR `kernel` 的执行/取消部分、dagents 的 DB+gateway、pi 的 executor。

---

## 6. P6 Implication（只说明缺口）

对照当前 `src/`（1ae782e）实证，报告列的缺口**方向正确**，只是“去哪读”需要按 §2/§3 修正：

1. **Review verdict 回流缺失**——`applyVerification()` 在 `src/` 内无任何调用者；`to_verify` 之后没有自动/半自动的裁决写入路径。外部只有“策略与 schema”可借（pi watchdog schema、AO autoreview 参数、NAR 一次修复），**没有**可直接嵌入本项目 TaskStore 的现成实现。
2. **retry / rework / replan 缺失**——`rework` 仍是保留态并返回 `rework-not-implemented`；scheduler 与 controller 头注释都明示不实现。NAR（一次预授权修复）、cezar（autoResumeAttempts/grace）、pi（revival depth 16）是三种**互补形态**，都需按本项目状态机重写。
3. **任务分解 / planner 交接缺失**——Laya（`src/decision/`）未被 `src/orchestration/*` 引用；外部 loom 的“LLM 规划轮次”与本项目“Laya 决定、Agent 不自行选型”的取向相冲突，只能取“有界轮次 + 准入门”的形，不能取 planner 本体。
4. **持久化 / attempt history 缺失**——`TaskStore` 仍是内存 `Map`；Temporal/LangGraph/OpenHands 只作事件账本与 checkpoint 的**概念**参考（报告已如此说，但未给源码证据）。
5. **capability / history 路由输入缺失**——没有任何上游实现了“能力 + 历史 + 配额”驱动的自动选择（本轮复核确认该结论）；可用的只有 NAR 的评分函数与 ACRouter 的 observe 反馈环，均属**特征来源**而非选择器。

本轮复核**不提出实现方案**，以上仅为缺口定位；复核未改动任何实现文件。

---

## 7. 复核结论

这份尽调**主体可靠**：10 个仓库、版本、多数模块、行数量级、以及“本项目的 6 项缺口”都能由源码复现，且它对 “不用 AO 的 orchestrator / 不用 orca / 不引入 dagents 重栈 / 别搬 pi 大文件” 的判断是正确的。

需要修正的是三件会直接影响决策的事：

1. **`agent-as-a-router` 是 MIT，不是无 License** —— “只能重写” 与 “唯二例外” 都必须改；这打开了它 204 行 inference 循环的**可复制**选项。
2. **loom `orchestra.ts` 不应作为“移植”目标** —— 它自带 LLM planner 与 git/worktree 所有权，直接搬会同时破坏 `Orchestrator.run` 唯一执行边与 `WorkspaceManager` 单一所有者；应降为 REFERENCE，只取其准入门/有界轮次/action 协议。
3. **候选池漏了最接近的项目与一个 AGPL 陷阱** —— `BloopAI/vibe-kanban`（Apache-2.0，多 agent + worktree + 看板）与 `smtg-ai/claude-squad`（**AGPL-3.0**）都应进入下一次尽调的首屏；`coder/agentapi`、`ruvnet/claude-flow`、`claude-task-master`（自定义 License 头）次之。

另外两处应顺手修：cezar “恢复套件” 引用的是 `.test.ts`（实现其实在 `workflows/run.ts`），以及 AO 被标 `DOC_CODE_MISMATCH` 属定性过强（它确实有一个可读的 tick+lease 自动化调度器，只是不是 DAG 调度器）。
