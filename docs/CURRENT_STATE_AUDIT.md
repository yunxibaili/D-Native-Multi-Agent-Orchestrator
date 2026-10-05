> **[Historical — Superseded by docs/PROJECT_BASELINE.md]**
> 本文件是 2026-09-30 的基线快照（2559 tests 基线，HEAD 1ae782e）。当前真实基线
> 见 **docs/PROJECT_BASELINE.md**（4225 tests，R2-2 已实现）。文中的 "当前缺口 /
> productionCaller=NONE / 未接 Laya" 等表述均为当时事实，不代表现状。

# CURRENT STATE AUDIT — 下一轮交接用代码事实审计

```text
Date     = 2026-09-30 · 以当日实际代码为准（commit 1ae782e），不依赖聊天摘要
方法     = 读 src/ + tests/ + docs/ + 本机 CLI 实测；未修改任何生产代码
Baseline = 全量 2559 tests / 0 failed · typecheck clean · smoke:quick 21/21
```

> Historical note: the numbers below are the 2026-09-30 baseline and are kept for
> provenance. Current R0.5 state is different: `npm test` is 3756/0/2 skipped,
> `typecheck` is clean, Native E2E is 11/15, Workbench and Decision Loop remain
> library-layer only with no production wiring, and the canonical product runtime
> model is `Execution Round + Codex Review + Human Gate` in
> `docs/WORKBENCH_ARCHITECTURE_AUDIT.md`.

## 1. Git / 工作区

- branch `main`，HEAD `1ae782e feat: Phase 5C personal coding workflow complete`
- remote `origin = github.com/yunxibaili/D-Native-Multi-Agent-Orchestrator`，**与远端同步**（ahead 0）
- 未提交：仅 `?? docs/PHASE6A_FREE_MODEL_POOL.md`（6A-0 产出）与本审计文件
- 关键 commit 链：`fd3fa4d` P1 runtime → `a34bca8` runtime hardening → `8ca1911` multi-agent identity → `da17f61`/`7f7c6f2`/`c7af018`/`e3a9802`/`a6745e7` Decision Layer(Laya) → `1ae782e` 5C personal coding workflow（含 orchestration 全套）
- 注：仓库根目录另有 C-Forge 截图 png/_vite.log 等历史遗留文件，已在 .gitignore

## 2. Phase 状态（逐项核实）

| Phase | 代码 | 测试 | 可运行 | 仅文档 | 未接生产 |
|---|---|---|---|---|---|
| P1 Native Runtime | `src/{core,runtime,adapters/{opencode,codex}}` | unit 92, contract 248 | run/resume/review、session、event stream、Windows taskkillTree | — | smoke 需真实 provider |
| P2 Laya/Decision | `src/decision/*` 1635 行 | decision 397 | `decision:check` CLI + laya-serve HTTP probe | — | **未接 orchestration（见 §5）** |
| P3 Expansion | `adapters/cline.ts`、`workbuddy.ts`（CN/Intl 变体） | cline 133, workbuddy 90 | cline/newTask、workbuddy-intl 已认证可用；**CN 未认证 401** | — | cline 无 review/本地未深度使用 |
| P4 Quota/Model Center | `src/quota/*` 8 文件 | quota 186 | doctor/quota CLI、BudgetManager、spawn gate、observed usage | — | budget **只读**，reserve/consume 未接执行路径 |
| P4M Hindsight | `src/memory/*` | memory 445 | 独立 PoC 通过；ADAPT 层实现 | — | **未接 orchestrator/runtime**（4M-9 冻结：memory≠task state） |
| P5A Research | `docs/PHASE5_MULTI_AGENT_RESEARCH.md` | — | — | 全部 | — |
| P5B Architecture | `docs/PHASE5B_*.md`（含 5C-1…5C-3 边界章节） | — | — | 全部 | — |
| P5C Execution | `src/orchestration/*` 14 文件 ~7300 行 | orchestration 968 | spawn→gate→worktree→agent→commit→verify→inspect→merge 全链路真实跑通（C-Forge E2E） | worktree 之外的 workspace 高级特性 | durable store、retry/rework、auto review |
| P6A-0 Free Pool | `docs/PHASE6A_FREE_MODEL_POOL.md` | — | 三执行候选 + Codex reviewer 本机 smoke PASS | 全部 | Laya 路由未开始 |

## 3. 当前 Runtime（src/orchestrator + src/runtime + src/adapters）

- **契约**：`RunRequest{agentId,prompt,cwd,model?,threadId?,mode,role?,sandbox?,extraArgs?,timeoutMs?}` → `RunHandle{events(),result(timeout),cancel()}` → `RunResult{state(succeeded/failed/cancelled/timed_out),exitCode,output,usage,toolCalls,threadId,transcriptPath,error,cleanup}`。terminal policy 由 exit code 决定；`cleanup` 不能改 state。
- **AgentRegistry/AgentSession/EventHub/SessionStore**：outcome machine + event hub 已 harden（a34bca8）；session resume 带 ownership check（agent+cwd+存在性）；cancel → `taskkillTree(pid)` Windows 进程树回收，实测有效（E2E 取消用例）。
- **modelId 链**：`RunRequest.model → adapter flag`（opencode `--model`、workbuddy `--model`、codex/`cline` 支持 modelSelection）；`model` 缺省时用 `orchestrator.json` 的 per-agent `model`（opencode 现为 `opencode/space-bunny-free`）。**无付费 fallback**：`--fallback-model` 仅是 codebuddy CLI 自身能力，adapter 未配置任何 fallback。
- **Adapter 实况**：OpenCode（cli-jsonl，resume/modelSelection/workspaceModes，rejects review/sandbox）· Codex（cli-jsonl，review+resume+sandbox）· WorkBuddy Intl（已认证，stream-json，modelSelection 实测 `hy3`）· WorkBuddy CN（**未认证，不可调用**）· Cline（app-server 0.0.32，无 review/modelSelection 之外能力，本地未深度使用——只记录事实）。

## 4. 当前模型池

- active pool 的**唯一正式表达是 `docs/PHASE6A_FREE_MODEL_POOL.md`**（6A-0 冻结）：执行 = `opencode/space-bunny-free`、`opencode/mimo-v2.6-flash-free`、`workbuddy-intl hy3`（三者均本机 smoke PASS，$0 实证）；**default reviewer = codex**。
- `ModelRegistry`（quota）按 agent→model→capability→availability 记录，availability 由 probe/观测填充；**"免费池"目前不是代码常量，registry 也不知道 free/paid 语义** —— 防 Laya 误调付费模型目前仅靠：(a) registry availability；(b) spawn gate 的 modelAvailable 检查；(c) 配置默认值即 free 模型。**缺一个代码级的 pool 白名单**（P6 缺口）。
- modelId 传递链：`Task.modelId → buildRunRequest → RunRequest.model → adapter flag`，5C 起不做默认替换（测试锁定）。

## 5. 当前 Laya / Decision Layer —— **不是**生产 orchestration 的控制脑

事实（`src/decision/` 1635 行）：

1. **输入**：`DecisionRequest` = 问题集（三类封闭答案：choice/score/noul）+ 任务文本；`routing.ts` 组装固定三问（work_kind ∈ {implementation,review,research,debugging}、complexity 5 级、review_required noul）。
2. **输出**：`TaskClassification{work_kind, work_kind_probabilities, complexity(+score), review_required(+noul), provider 元数据/checkpoint/reason}`。
3. **一次性**：单次 request→response；`classifyTask` 无循环、无会话。Provider 是本地 `laya-serve` HTTP（127.0.0.1 强制，`allowRemote=false`，双端校验，200≠有效决策）。
4. **Task decomposition：无**。
5. **Task assignment：无** —— `check.ts` 明示 "No agent was selected and nothing was run"。
6. **Capability 分配：无**（capability 检查在 orchestration 的 workspace/gate 层，与 Laya 无关）。
7. **进入 Scheduler/Execution Bridge：没有**。`src/orchestration/*` 与 `src/orchestrator/*` **零 import `src/decision`**（已 grep 核实）。
8. 未接线但已有：spawn gate 真实信号（spawn-gate-input）、ModelRegistry、budget 只读、TaskClassification。

**结论：Laya 当前是"可被调用的分类服务 + 稳定接口"，不是编排控制脑。**

## 6. Multi-Agent / Task System 实际数据流（全部实测跑通）

```text
createRoot/spawnChild
 → TaskStore(唯一权威, in-memory)
 → spawn gate（真实 7 信号, spawn 期 + execute 期各重跑一次, 不缓存）
 → TaskScheduler.tick()（候选=depth>0 且 planned/queued；确定性排序 createdAt→order→taskId；
    maxChildren（存在上限）/maxConcurrentAgents（运行上限）已解耦 → 真·排队）
 → WorkspaceManager（git worktree 隔离 orch/task/<id>，missing-signal=拒绝，绝不静默降级；
    review 类任务 shared 模式）
 → executeTask → buildRunRequest → 现有 Runtime（唯一执行边）
 → RunResult → translate（成功→to_verify，绝不 succeeded）
 → applyVerification（唯一 succeeded 入口；rework 保留态，返回 rework-not-implemented）
 → CLI task inspect/diff/merge --verified（跨进程经 git 重建；merge 不 auto-commit，
    冲突原地保留，already-merged/dirty 防护）
```

- store **in-memory**：重启丢状态；跨进程只能靠 git/branch + `--verified` 人验。
- artifacts：`addArtifact` 只记录引用；下游任务**不自动消费**。
- retry/rework/replan/failure propagation：**missing**（failed 保持 failed；上游 failed 时 dependant 永久 dependency-unmet 等待，有意行为）。

## 7. Agent 协作能力矩阵

| 能力 | 状态 |
|---|---|
| parent → child task | **implemented**（spawnChild，depth=1 硬上限） |
| child dependency（DAG） | **implemented**（显式声明；仅 succeeded 满足；环/自引用拒绝） |
| parallel tasks | **implemented**（真隔离 worktree 并行，实测） |
| isolated worktree | **implemented** |
| result passing | **partial**（RunResult→task lifecycle；文本不跨任务传递） |
| artifact passing | **partial**（记录引用；无消费/校验） |
| downstream task 启动 | **implemented**（依赖 succeeded 后下一 tick 派发） |
| failed task rework | **missing**（rework 保留态 not implemented） |
| reviewer → rework | **missing**（review verdict 需人工 applyVerification） |
| cross-task context | **missing**（无 message bus / 上下文注入；5B §10 仅设计） |

## 8. Reviewer 现状

`orchestrator review codex <prompt>`：走 `Orchestrator.run(mode='review')` → codex adapter `codex exec review` 独立 session（review/resume 互斥，显式 sandbox 被拒），复用全部 Runtime 基础设施（EventHub/SessionStore/taskkillTree）。**review 输出只是 RunResult 文本**：不会写回任何 Task state，FAIL 后不会回流 Laya/orchestration。orchestration 内 review 类 child（taskType='review'→mode review）同样只到 `to_verify`，verdict 靠人工 `applyVerification`。**缺**：review 结果→结构化 verdict→（FAIL 时）→重规划入口。这是 P6 的关键缺失环节。

## 9. Quota / Model Center

- `evaluateSpawnGate` 8 字段全真实信号（quota/status、model availability、agent installed、capability、policy、budget、concurrency）；missing-signal ≠ allow（6A-0 沿用）。
- Budget：BudgetManager 有 allocate/reserve/consume/release API，但执行路径**只读不扣**（E2E 实测 reserved=0/consumed=0）。
- **防误调付费模型**：现状只有间接机制（registry availability + gate modelAvailable + 默认配置即 free 模型）；**代码级免费池白名单不存在** —— P6 应把 `PHASE6A_FREE_MODEL_POOL.md` 的 active pool 变成代码/配置常量并让 Laya 只能从中选择。
- observed usage：collector 从 session/transcript 收集真实 token，`estimated/unknown` 不计费。

## 10. Dashboard / Frontend

`temporary-dashboard/`（vanilla JS + `data/project-status.json`）：**在 .gitignore 中，不进 Git**；由历轮 Codex Review 维护 `project-status.json`（phase 状态、gate verdict）。仅为状态展示，无 API。是否参与 P6：非必须；若参与应以只读渲染 TaskStore/snapshot，不得成为第二状态权威。

## 11. 测试基线（2026-09-30 实测）

| 套件 | 结果 |
|---|---|
| unit / contract / decision / cline / workbuddy / quota / memory / orchestration | 92 / 248 / 397 / 133 / 90 / 186 / 445 / 968 —— **合计 2559, 0 failed** |
| typecheck | clean |
| smoke:quick | 21/21（smoke 全量 23/23，需真实 provider） |
| 最近真实 E2E | C-Forge（算法项目）双 child 并行 worktree + merge + 浏览器回归 ALL PASS；模型 A/B + Orchestrator 集成（modelId 直传） |

- 已知失败：无。已知 flaky：无（全部 hermetic；依赖真实 provider 的 smoke 单独隔离）。
- 已知 CLI bug（**未修**）：`src/cli/index.ts` `task` dispatcher 在**无 `--cwd`** 时 `i===cwdIdx+1`（cwdIdx=-1）误删 'task' token，`slice` 再吃掉子命令 → `orchestrator task list` 打 USAGE exit 2；带 `--cwd` 一切正常。
- 旧披露 minor：TickResult.admitted 包含 cancelled/failed 终态的 dispatch（ExecuteOutcome.ok 语义 = lifecycle 回写成功）。

## 12. 已知技术债

**A. 影响 Phase 6 的**
1. Laya 未接 orchestration（无 import）——没有决策→spawn 的桥。
2. 免费池无代码表达（只有文档）；无付费模型防护白名单。
3. review verdict 无结构化回流（FAIL→replan/rework 入口缺失）。
4. TaskStore in-memory：重启丢在途任务；跨进程 merge 靠 `--verified` 人验。
5. retry/rework/replan、failure propagation 全 missing；decomposition 全 missing。
6. `task` CLI dispatcher bug（见 §11）。

**B. 不影响 Phase 6 的**
budget reserve/consume 未接执行路径（只读）；artifact 无消费；workspace 高级特性；opencode 默认模型写在用户级 orchestrator.json；dashboard 不进 Git。

**C. 暂时不要碰**
`src/quota/{spawn-gate,budget,policy,registry,types}.ts` sealed 契约；`src/core/` RunResult/EventHub 契约；Hindsight=非 task state（4M-9 冻结）；`maxDepth=1`；terminal policy"cleanup 不能改 state"；review/resume 互斥等 adapter 实测约束。

## 13. 给下一阶段的最重要结论

**已做好（可直接复用）**：稳定 DecisionProvider 接口 + 本地 Laya 分类（work_kind/complexity/review_required 三问即"该派谁"的原始信号）；真实 spawn gate；隔离 worktree + merge 工具链；有界 Scheduler（已解耦 maxChildren/maxConcurrentAgents，支持真排队）；RunResult→to_verify 生命周期；CLI inspect/merge；三个免费候选全部实测可调用。

**真正缺的**：① Laya 分类 → child 任务分配（agent+modelId 选择）的那一跳；② 任务分解（prompt→DAG）；③ review verdict 结构化回流 + FAIL→replan 循环；④ 免费池白名单的代码化；⑤ 跨进程/持久化（或接受单进程长驻）。

**最小修改入口**（只指位置，不给方案）：
- 分配跳线：`src/orchestration/spawn-gate-input.ts` / `SpawnChildRequest` 的调用方侧——在 Parent Planner 处消费 `classifyTask()`（`src/decision/routing.ts:177`）产出 agentId/modelId 后调用 `spawnChild`；**不需要改 decision 与 orchestration 的内部**。
- 池白名单：新增一个常量/配置模块（读 `PHASE6A_FREE_MODEL_POOL.md` 的 pool），在 Parent Planner 选择时过滤 + 让 spawn gate 的 model 信号引用它。
- verdict 回流：`Orchestrator.applyVerification`（`src/orchestration/orchestrator.ts`）已是唯一 verdict 入口——把 Codex review 的 RunResult 文本解析成 `VerificationOutcome` 并接回 rework/replan 是最小闭环点。
- CLI bug：`src/cli/index.ts:143-151` dispatcher 一行条件修复。
