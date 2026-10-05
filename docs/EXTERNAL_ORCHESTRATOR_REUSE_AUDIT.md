> **[Historical — 2026-09-30 复用尽调]** 注意：文中 ACRouter/orca 的 "no LICENSE"
> 结论已被 R2-0 阶段的复核更正（ACRouter 复核为 MIT，见
> EXTERNAL_ORCHESTRATOR_REUSE_REVIEW_CODEX.md 与 P6_ORCHESTRATION_PLAN §12）。
> 当前基线见 docs/PROJECT_BASELINE.md。

# EXTERNAL ORCHESTRATOR REUSE AUDIT — 外部项目源码尽调（Reuse First）

```text
Date     = 2026-09-30 · 纯只读尽调，未修改任何生产代码
Method   = 全部 10 仓库 clone 到 D:/yunxibaili/orchestrator-research/（depth 1），
           源码级阅读 + LICENSE 实查 + GitHub API/issues 抽查；以源码为准
Baseline = 本项目 commit 1ae782e · 2559 tests / 0 failed
```

# 1. Executive Summary

**没有任何外部项目可以直接替代当前项目**——但有两个 TS/近亲仓库（cezar、loom）提供了本项目最大缺口（replan/review 回流/child 报告回流/预算暂停）的成熟可移植模块，且全部为 MIT/Apache-2.0。最接近本项目的是 **cezar**（真实 TS 多 agent 编排器，含 recovery/review-gate/dispatch 报告回流）。最值得移植的单件是 **loom 的 `orchestra.ts`（MIT，真 DAG + 动态 replan + JSON-action 协议）** 与 **NAR 的确定性 agent 评分 + 一次预授权修复流程**。`agent-as-a-router` 的推理期路由 API（route→verify→escalate→observe）是 Laya routing backend 的最佳概念蓝本，但其仓库 **无 LICENSE**，只能重写不能复制。symphony（Apache-2.0，Elixir）与本项目假设最一致：**单一权威状态 + reconcile-on-tick**，本项目的 TaskStore 已等价实现其核心。

# 2. Current Project Baseline（仓库代码事实）

- 已有：adapters（OpenCode/Codex/WorkBuddy CN+Intl/Cline，Windows native CLI，resume/review/cancel）、真实 spawn gate（7 信号双期重跑）、TaskStore 单权威（in-memory，11 态含 to_verify/rework 保留态）、bounded Scheduler（maxChildren/maxConcurrentAgents 解耦，确定性排队）、git-worktree 隔离（orch/task/*，冲突保留 merge）、RunResult→to_verify 生命周期、CLI inspect/diff/merge、CLI `task` dispatcher 一处已知 bug（无 --cwd 时吃子命令）、Decision Layer（Laya 本地分类：work_kind/complexity/review_required，**未接 orchestration**）。
- 缺口（前轮审计已定）：Laya→分配跳线、任务分解、review verdict 回流、retry/rework/replan、免费池白名单代码化、持久化。

# 3. Project-by-Project Audit

## 3.1 openai/symphony（Elixir，Apache-2.0 + NOTICE，27.5k★，HEAD be10a1b，2026-09-15 活跃）
- Orchestrator：`elixir/lib/symphony_elixir/orchestrator.ex`（1990 行 GenServer；State 单权威 `running/claimed/blocked/retry_attempts/codex_totals`；tick→poll→dispatch，每循环 `reconcile_running_issues`+`reconcile_blocked_issues`）。
- Retry：`@failure_retry_base_ms 10_000` 指数退避 + retry token 防过期重试 + stalled-run 重启（line 624）。
- Task model：`tracker/issue.ex` 平铺 issue 列表，**无 DAG**。Workspace：`workspace.ex` 是 rm_rf+mkdir **非 git worktree**；`path_safety.ex` 路径逃逸防护。Agent spawn：`agent_runner.ex`→`codex/app_server.ex`（JSON-RPC over stdio，approval/sandbox policy）。
- Persistence：**刻意无 DB**——重启从 tracker/文件系统恢复，SPEC §2.1 明示。Review：无代码内 review loop（人工 handoff）。Budget：仅 token 计数。
- Tests：`elixir/test/`（orchestrator/workspace/app_server/e2e）。**无 DOC_CODE_MISMATCH**（SPEC 诚实）。
- 已知 issues：仅 8 open。局限：无 DAG、无 review loop、无金额预算。

## 3.2 Untrivial-ai/agent-orchestrator（AO，Go+TS，Apache-2.0，12.6k★，HEAD 8de638a，当日活跃；685 open issues）
- **无 scheduler/DAG 核心**——"orchestration"= `service/session/delegation.go:49-67` 一次性派工。**DOC_CODE_MISMATCH**：README 宣称 "project-aware orchestrator"，实际是会话管理（Kanban 是会话事实的展示投影，`service/session/kanban.go`）。
- 真实强项：`adapters/workspace/gitworktree/`（worktree 全生命周期 + per-repo teardown 锁 + `ErrUnsafePath` 防护 + discard/repair）；`autoreview/coordinator.go`+`review/review.go`（**SHA-pinned review run、verdict 持久化、idle 触发、3 次上限、findings 自动注入 worker**——真实的 review 回流）；40+ CLI adapters（`adapters/agent/`）；usage collector + pricing catalog backfill（`service/usage/collector.go`）；Windows spawn 特判（`process/command_windows.go`）。
- 已知 issues 主题：session teardown 崩溃（#3875）、Windows npm-shim（#4401）、merge 即 terminate 策略（#3154）。Discussions 有。

## 3.3 nickthelegend/loom（TS，MIT，8★，HEAD eab14c3，2026-09-29）
- `src/core/orchestra.ts`（2421 行）：**真 DAG**（dependsOn + 前驱 done 才 ready）、orchestrator ```loom JSON action 协议（spawn/followup/question/finish）、`TaskHold`（decide/wait/zone/capacity 准入门）、maxParallel、rounds 1–50 的**真动态 replan**、`TaskStatus` 含 conflict/needs_input。
- `src/core/worktree-merge.ts`（153 行）：冲突保留式 merge + 一次 agent 修复尝试调度。Budget：`budgetUsd` 上限 → warn → `waiting_human` 暂停（1337-1368）。持久化：`.loom` JSON 文件，crash 恢复粗糙（非终态一律标 failed）。
- Tests：orchestra/worktree-merge/router/cli-orchestra 等。**核心 loop 无 mismatch**；成熟度低（单作者），JSON 持久化非事务。

## 3.4 open-mercato/cezar（TS monorepo，MIT，275★，HEAD ab2c35d，当日活跃；213 open issues；515 个测试文件）
- **真实生产级 TS 多 agent 编排器**（非 UI 壳）。`packages/cezar/src/`：
  - RunManager 5660 行（`workflows/run.ts`）+ RunStore 1715 行（`runs/store.ts`，状态机 queued|running|**waiting**|**review**|done|failed|cancelled）；
  - child dispatch 报告回流：`dispatch/engine.ts`（纯函数预算/排序）+ `dispatch/prompts.ts`（child 结果注入 parent 下一轮 prompt）；
  - 恢复套件 `workflows/recover-{dispatch,autonomous,followups,session-failure,no-session}.ts` + auto-resume；
  - worktree：`git-worktree.ts`（create/autosaveCommit/diff/remove）+ `runs/retention.ts` 重回收；
  - adapters：`core/{claude-cli,codex-app-server,cursor-agent,opencode-server,pi}-runner.ts` + 录制 fixtures；
  - semaphore 并发（`workspace/semaphore.ts`）、成本（`core/usage.ts` cache-weighted）；
  - review = **人工 gate**（`runs/review-gate.ts`，22 行），无自动 reviewer。
- 无 mismatch；大量 e2e。局限：重型 cockpit（web/Tauri/tracker），需抽模块而非整体采用。

## 3.5 BerineYang/native-agent-router（NAR，Python stdlib-only ~3.1k LOC，MIT，3★，HEAD d65bd49，2026-09-11，极新）
- 确定性执行内核（不是模型 router——"router" 是给调用方的数据）：`src/native_agent_router/kernel/kernel.py`（684 行：submit/取消确认/WorkspaceLock/孤儿对账 `mark_orphans_unknown`）；`kernel/store.py`（JSON store，`pid_alive` 崩溃检测→`unknown` 态）；**verify 失败→一次预授权修复（REPAIR_DIRECTIVE prompt）→re-verify**（kernel.py ~590-650）；**agent 零 token 评分** `kernel/stats.py`（成功率/修复率/越界编辑率→供 orchestrator 选 agent）；`adapters/zcode_native.py`（609 行 ZCode app-server 协议）；MCP server + CLI；9 个测试文件。Windows `CREATE_NO_WINDOW` 处理真实。
- README 诚实无夸大；风险仅是采纳度为零（3★）。

## 3.6 LanceZPF/agent-as-a-router（ACRouter，Python + 两个 forked app，**无 LICENSE 文件**，1284★，HEAD e43839e，2026-06-29 后不活跃）
- 论文复现 + CodeRouterBench benchmark。核心可运行件：`src/acrouter_repro/inference.py`（~220 行，无重依赖）：`ACRouter.route(task)` + **`run_with_verifier(task, call_model, verify)` = 廉价链→verify→升级→`observe()` 记忆更新**；训练型 router（LogReg/BERT-MLP/微调 Qwen 0.8B）带 torch/sklearn 重依赖且绑定其模型集。`demos/commercial_cli_router/router_mvp.py` 只是关键词匹配。
- **LICENSE 缺失 = 默认版权保留，代码不可复制，只可重写概念**。GitHub 语言标 TS 系 forked app 所致（误导）。
- "作为 Laya backend"实际要求：重写 route/observe 循环 + 自备 task→dimension 分类（Laya 可充当）+ 免费池映射。

## 3.7 obra/superpowers（Markdown skills 方法论，MIT，293k★，HEAD 8ca22db，2026-09-25）
- **无编排代码**：`superpowers/index.js` 9 行插件注册；`skills/` 16 目录 SKILL.md（dispatching-parallel-agents、subagent-driven-development、verification-before-completion、receiving-code-review 等）；唯一"代码"是小 bash 工具（`sdd-workspace` 计划级产物目录方案、task-start/done ledger 标记）。README 无过度宣称（它就是方法论）。
- 复用价值 = **prompt 模板**（implementer-prompt/task-reviewer-prompt/re-review-prompt 可直接充当本项目 reviewer/worker 提示词素材）；bash 不可用于 Windows。

## 3.8 dagents/dagents（TS monorepo，Apache-2.0，2★，HEAD d850b38，2026-09-12，低热度但内部精细）
- `packages/workflow/src/engine/executor.ts`（814 行）：Kahn 拓扑 + wave 并发（Promise.all）+ 条件分支/迭代节点/human-input；`utils/validate-topology.ts`。`packages/agent-adapters/src/`：~20 adapters（opencode/codex/claude/qwen/kimi…）共享 `stream-backend.ts`（spawn/NDJSON 行解析/超时/kill 升级/inactivity watchdog），argv 构造为纯函数且单测覆盖真实 `codex exec --json` 事件形状。
- 持久化：TypeORM+Postgres（重栈）。**crash 恢复：executor 内未找到 resume/recover**（mismatch 风险）；无性能历史路由（`tiers.ts` 是静态分层）。测试充分（executor/cancellation/pricing/dispatch-cancel）。

## 3.9 araa47/orca（Rust，**无 LICENSE**，5★，HEAD f9efbb4，2026-05-11 后休眠）
- tmux/Unix-only 的 spawn+watch+wake 工具：worktree 创建、**注入 lifecycle-report 契约**（worker 必须 `orca report --event done|blocked`）、daemon 卡死检测（报告事件+pane 存活+idle 启发式）、嵌套 3 层。约 40% 行数是测试。
- **无 LICENSE = 不可复制任何代码**；平台不符；无 scheduler/review/replan。

## 3.10 nicobailon/pi-subagents（TS，MIT，3793★，HEAD 0958598，当日活跃）
- **结构已整体重组**：5A/5B 时期适配的扁平文件全部迁移（worktree→`src/runs/shared/worktree.ts` 1543 行，含事务化 `withWorktreeTransaction()`、patch 校验、Worktrunk；并发→`runs/background/active-async-capacity.ts` fs-claim 池；schedule-store→`scheduled-runs.ts` 1012 行；硬 caps→byte-bounded lane metadata）。
- **新增且我们未取的**：`src/watchdog/`（**只读第二 agent 审查 + `watchdog_warn` 结构化 verdict**：severity/importance/evidence/recommendedAction，high 注入 parent 上下文——真实的 review→rework 回流）；`src/missions/`（跨会话目标层 + token 预算门控）；`src/workflows/workflow-revival.ts`（失败子任务复活链，`MAX_REVIVAL_DEPTH=16`）；`usage-reconciliation.ts`；`spawn-budget.ts` 授权追加模型。
- **`agents/agent-selection.ts` 不是 agent 选择**（25 行 scope 合并）——**该仓库没有任何动态 agent 路由实现**（DOC_CODE_MISMATCH 倾向标注）。无自动 retry（revival 由 supervisor 发起）。

# 4. Reuse Matrix

| Project | Module | Current Equivalent | Reuse | License | Evidence | Notes |
|---|---|---|---|---|---|---|
| symphony | reconcile-on-tick + retry token/backoff | Scheduler.tick（无 reconcile/retry） | REFERENCE_ONLY | Apache-2.0 | orchestrator.ex:83-126,1038 | Elixir；移植状态机逻辑即可 |
| symphony | codex app-server JSON-RPC client | codex CLI adapter | ADAPT_REUSE（若升级 transport） | Apache-2.0 | codex/app_server.ex | 可选，非必需 |
| symphony | 单权威状态 + 无 DB 恢复哲学 | TaskStore | REFERENCE_ONLY | Apache-2.0 | SPEC §2.1 | 验证现有设计 |
| AO | review run 持久化 + verdict 写回 + findings 注入 worker | to_verify（人工） | ADAPT_REUSE | Apache-2.0 | autoreview/coordinator.go, review/review.go | review 回流最佳蓝图 |
| AO | gitworktree teardown 锁/路径防护/repair | WorkspaceManager | ADAPT_REUSE（边界清单） | Apache-2.0 | adapters/workspace/gitworktree/* | 按失败模式 checklist |
| AO | usage/pricing backfill | usage collector（无成本） | ADAPT_REUSE（概念） | Apache-2.0 | service/usage/* | |
| AO | scheduler/DAG | — | NOT_USEFUL | — | 不存在 | DOC_CODE_MISMATCH |
| loom | orchestra.ts：DAG+ready 调度+JSON-action 协议+replan rounds | Scheduler（无 DAG 语义/replan） | **ADAPT_REUSE** | MIT | src/core/orchestra.ts:397,470,1337-1368 | 本轮最高价值单件 |
| loom | worktree-merge 冲突保留 + 一次修复尝试 | CLI merge | ADAPT_REUSE | MIT | src/core/worktree-merge.ts | 与现有行为互证 |
| loom | budgetUsd 上限→暂停 | 无 | ADAPT_REUSE | MIT | orchestra.ts:1337-1368 | ~50 行 |
| cezar | dispatch 报告回流（child→parent prompt） | 无 | **ADAPT_REUSE** | MIT | dispatch/engine.ts,prompts.ts | 修复 cross-task context 缺口 |
| cezar | recover-* / auto-resume 套件 | 无（recovery 缺失） | **ADAPT_REUSE** | MIT | workflows/recover-*.ts | retry/rework 直接参考 |
| cezar | RunStore 状态机（waiting/review 子态） | TaskStore 11 态 | ADAPT_REUSE | MIT | runs/store.ts | 对照补态 |
| cezar | agent CLI runners + 录制 fixtures | adapters | ADAPT_REUSE（测试素材） | MIT | core/*-runner.ts, __fixtures__/ | fixture 驱动测试法 |
| cezar | worktree retention/rematerialize | WorkspaceManager | ADAPT_REUSE | MIT | runs/retention.ts | 磁盘回收 |
| cezar | 人工 review gate | applyVerification | REFERENCE_ONLY | MIT | runs/review-gate.ts | 已有等价 |
| NAR | 确定性 agent 评分（stats.py） | 无 | **ADAPT_REUSE** | MIT | kernel/stats.py | Laya 特征源 |
| NAR | 一次预授权修复 + 固定 verify | 无 | **ADAPT_REUSE** | MIT | kernel/kernel.py:590-650 | retry/rework 最小闭环蓝本 |
| NAR | pid_alive 崩溃检测/孤儿对账 | 无（in-memory） | REFERENCE_ONLY | MIT | kernel/store.py | 持久化时用 |
| ACRouter | inference.py route/run_with_verifier/observe | 无 | ADAPT_REUSE（**重写**，不可复制） | **无 LICENSE** | src/acrouter_repro/inference.py | Laya routing 循环蓝本 |
| ACRouter | 训练型 routers/benchmark | — | NOT_USEFUL | 无 LICENSE | src/routing/ | 重依赖+绑定其模型集 |
| superpowers | implementer/reviewer/re-review prompt 模板 | prompt 生成 | ADAPT_REUSE（文本） | MIT | skills/subagent-driven-development/*.md | 直接素材 |
| superpowers | 其余全部 | — | NOT_USEFUL | MIT | 无运行时代码 | |
| dagents | opencode/codex argv+NDJSON 纯函数解析 + watchdog | adapters | ADAPT_REUSE | Apache-2.0 | packages/agent-adapters/src/*.ts | 事件形状互证；Windows kill 待验证 |
| dagents | wave executor + topology 校验 | Scheduler | ADAPT_REUSE | Apache-2.0 | packages/workflow/src/engine/executor.ts | 仅依赖 zod |
| dagents | TypeORM/Postgres/gateway/console | — | NOT_USEFUL | Apache-2.0 | packages/db | 重栈冲突 |
| orca | 全部代码 | — | NOT_USEFUL | **无 LICENSE** + tmux/Unix | src/** | 仅概念：lifecycle-report 契约、stuck 检测 |
| pi-subagents | watchdog_warn 结构化 verdict schema | 无 | **ADAPT_REUSE（schema+policy）** | MIT | src/watchdog/review.ts, turn-delta.ts | review 回流直接可用 |
| pi-subagents | workflow-revival 复活链 | 无 | DIRECT 概念（~140 行） | MIT | src/workflows/workflow-revival.ts | MAX_REVIVAL_DEPTH=16 模型 |
| pi-subagents | usage-reconciliation / spawn-budget / tool-budget | 部分 | ADAPT_REUSE | MIT | src/runs/shared/... | 纯函数易移植 |
| pi-subagents | agent-selection.ts | — | NOT_USEFUL | MIT | 25 行 scope 合并，非路由 | DOC_CODE_MISMATCH |

# 5. Capability / Routing Findings

| 机制 | 真实现 | 假/缺失 |
|---|---|---|
| Task requirement → capability 匹配 | **无一家真正实现动态匹配**；AO 有 40+ adapter 注册与 model catalog，但选择靠人 | loom router.ts 是路由/baton 顺序非模型选择；pi-subagents `agent-selection.ts` 名不副实 |
| Observed performance 参与选择 | **NAR stats.py 是唯一确定性实现**（成功率/修复率/越界率→JSON 统计供调用方决策）；ACRouter `observe()` 记忆更新是运行时反馈环 | dagents tiers=静态分层；AO/cezar/symphony 无 |
| Availability/Quota 参与路由 | 无一家（AO 有 usage 预算超限错误码但非路由输入） | — |
| Routing feedback 闭环 | ACRouter run_with_verifier→observe；NAR verify→repair→stats | 其余全是静态配置或人工选择 |

**结论**：`评分/记忆 → Laya 特征` 是空白市场——把 NAR 评分 + ACRouter observe 循环作为 Laya 输入特征，没有任何现成 TS 实现可整体照搬，需自写（量小）。

# 6. Dynamic DAG / Replan Findings

- 真动态 replan（orchestrator 依据结果 spawn 新任务/多轮）：**loom**（rounds 1–50 + JSON action 协议）唯一完整；**pi-subagents revival**（失败子任务复活链，深度 16 上限）是可靠的受限版本；cezar recovery 套件是失败恢复而非图重构。
- 静态 DAG + 条件/迭代：dagents executor（Kahn+wave）、AO 无、symphony 无（issue 平铺）。
- Selective retry / downstream invalidation：**没有任何项目实现下游失效传播**（本项目"上游 failed→dependant 永久等待"在业界同样普遍）；ADaPT（archiki/ADaPT，bench-harness only）的 decompose-on-failure 是唯一相关算法，~50 行伪代码级别，直接对 TaskStore 重写即可。
- LangGraph `Command(goto)`（MIT）= 运行时动态边的成熟语义参考；checkpoint 模型（pendingWrites staging）对本项目持久化设计最有参考价值。

# 7. Review Loop Findings

- **结构化 verdict → orchestrator → rework → re-review**：pi-subagents `watchdog_warn`（severity/importance/evidence/recommendedAction，high 注入 parent）= 最成熟实现；AO autoreview（SHA-pinned、3 次上限、findings 注入）= 最完整工程化；loom = conflict/needs_input 任务化 + 一次修复尝试；NAR = 固定 verify + 一次预授权修复（最小可信闭环）。
- review 只有文本无回流的：cezar（人工 gate）、symphony（无）、orca（done/blocked 事件）。
- max retries 语义：AO 3 次/PR；loom 共享 fix-attempt 预算；NAR repair_used<1；pi revival depth 16。
- **共同模式**：verdict 必须是结构化对象并写回持久状态，reviewer 只读、worker 收到注入的 findings——与本项目 `applyVerification` 唯一入口设计完全兼容。

# 8. Execution State Findings

| 项目 | 模型 | 超出本项目 TaskStore+RunResult+Artifact 的部分 |
|---|---|---|
| Temporal（MIT） | append-only event history，确定性 replay | attempt 历史作为一等事件；crash 后 replay 恢复（我们只存终态快照） |
| LangGraph（MIT） | superstep checkpoint + pendingWrites staging | 中断时 in-flight 写暂存；channel 合并策略 |
| OpenHands（MIT） | 事件流账本 + **stuck detector**（重复 action/observation n-gram 比对→abort/replan 信号） | 卡死检测便宜且高价值，可直接加进 Scheduler |
| NAR | pid_alive→unknown + 孤儿对账 | 进程崩溃态显式化 |
| AO | SQLite 会话事实 + review run 记录 | review 运行本身可持久化/审计 |

本项目已覆盖：任务状态机、结果绑定、artifact 引用、验证入口唯一。缺：attempt history、可 replay 事件、pendingWrites、stuck 检测、进程崩溃态。

# 9. Strongest Reusable Pieces（按优先级）

1. **loom `src/core/orchestra.ts`**（MIT）— DAG ready 调度 + orchestrator JSON-action 协议 + 多轮 replan + TaskHold 准入门 → 移植到 `src/orchestration/` 作为 Parent Planner 层；直接补"Laya 接管全局编排"的任务图与 replan 缺口。对应现有：Scheduler/TaskStore。
2. **pi-subagents `src/watchdog/review.ts` 的 warn-payload schema + severity policy**（MIT）— 结构化 review verdict → 填 `applyVerification`/rework 回流缺口。对应现有：`translate.ts`/`orchestrator.applyVerification`。
3. **NAR `kernel/stats.py` 评分 + `kernel.py` 一次预授权修复流程**（MIT，stdlib Python，易移植 TS）— Laya 的特征源 + retry/rework 最小闭环。对应现有：spawn gate 信号 / 新增 retry 层。
4. **cezar `dispatch/engine.ts`+`prompts.ts` 报告回流 与 `workflows/recover-*.ts`**（MIT）— cross-task context 与失败恢复的成熟 TS 实现。对应现有：orchestration/orchestrator。
5. **ACRouter `inference.py` route→verify→escalate→observe 循环**（无 LICENSE，**重写** ~200 行）— Laya routing backend 的执行形态。对应现有：`src/decision/`。
6. **dagents `agent-adapters` 的 argv/NDJSON 纯函数与测试**（Apache-2.0）— 交叉验证/加固现有 adapter 的事件解析与 kill 升级路径。
7. **superpowers 的 task-reviewer/re-review prompt 模板**（MIT）— reviewer worker 提示词素材，零机制成本。
8. **AO gitworktree 失败模式清单**（Apache-2.0）— 对 WorkspaceManager 做 checklist 加固（teardown 锁、路径防护、repair）。

# 10. What NOT to Reuse

- **AO 的"orchestrator"**：无 scheduler/DAG，且 DOC_CODE_MISMATCH——不要按 README 理解引入其架构。
- **ACRouter/orca 代码**：无 LICENSE（默认保留版权），只能重写概念；ACRouter 训练型 router 还带 torch 依赖与外部模型集。
- **orca 全部**：tmux/Unix-only，平台冲突。
- **dagents 的 DB/gateway/console**：TypeORM+Postgres+Hono 重栈，违背 local-first 最小依赖；仅取纯函数 adapters。
- **cezar 整体 cockpit**（web/Tauri/tracker）：抽模块（MIT 允许），不要搬应用。
- **symphony 代码**：Elixir，仅状态机逻辑参考。
- **superpowers bash 工具**：POSIX-only。
- **与现有 Runtime 重复/会破坏 Task Graph 的**：任何替代 TaskStore 单权威的 persistence（loom 的 JSON per-run 也因此 NOT_USEFUL）；任何绕过 `Orchestrator.run` 唯一执行边的执行内核（NAR kernel 概念仅取 verify/repair 循环，不取其执行器）。
- **pi-subagents 大文件**（`subagent-executor.ts` 7963 行）：pi-specific，不可移植。

# 11. Final Gap（只回答"还缺什么"）

1. **Parent Planner + 动态 replan**：把 Laya 分类接进"分解→分配→spawn"的循环（loom orchestra.ts 是最近的现成参考）。
2. **Review verdict 回流**：结构化 verdict（pi watchdog schema）写入 Task state 并触发 rework（AO/cezar/NAR 三种成熟形态可选）。
3. **Retry/rework/replan 语义**：目前 failed 即终止；NAR 一次预授权修复 + cezar recovery + revival 链是三个互补实现。
4. **免费池白名单的代码化**：所有外部项目都无此物（ACRouter 的候选模型常量是唯一形态类比），必须自建——这也是本项目的差异化点。
5. **持久化/attempt history**：in-memory TaskStore + 无尝试历史；Temporal/LangGraph 的事件账本与 checkpoint 是参考，不必整体引入。
6. **Laya 的执行反馈特征**：NAR 式确定性评分目前不存在于本项目，属新增小模块。

```text
回答两个最终问题：
Q1 今天已有本项目，还缺什么？ → 上 6 条（全部是"编排智能"层，执行/隔离/验证基座已完备）。
Q2 外面有没有写好的代码可直接拿进来？ → 有，且许可证干净：
   MIT：loom orchestra/worktree-merge/budget、cezar dispatch+recovery、NAR stats+repair、
        pi-subagents watchdog schema+revival、superpowers prompts；
   Apache-2.0：AO review-run/worktree-checklist、dagents adapter 纯函数、symphony 状态机参考。
   唯二例外：ACRouter 与 orca 无 LICENSE —— 只重写概念，不复制代码。
```

*研究克隆保留在 `D:/yunxibaili/orchestrator-research/`（项目外），未复制进本项目。*
