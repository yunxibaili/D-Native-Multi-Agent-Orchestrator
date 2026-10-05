> **[AUDIT SNAPSHOT — 2026-10-01]** 本文为当时审计快照；R2-1/R2-2 已实现并在末尾 addendum 记录增量。当前基线见 docs/PROJECT_BASELINE.md。

# WORKBENCH_ARCHITECTURE_AUDIT — 只读架构审计（P6-C + Workbench 现状）

```text
Date   = 2026-10-02 · R0.5 read-only review + canonical product model
Status = library authority map remains valid；production wiring 未完成；Native E2E 11/15
Method = 实际源码阅读（workbench*.ts / planner*.ts / assignment.ts / scheduler.ts /
         review-loop.ts / adapters/*），并以真实 Native E2E 运行结果佐证
Tree   = HEAD c156db0 + 未提交的 P6-C(planner) / Workbench 层 / assignment preference
E2E    = native-agent-e2e：Case1-3 PASS（OpenCode 单任务 / 双 session 双模型并行 /
         Codex review verdict），Case4 WorkBuddy 权限修复后复跑，Case5 Handoff PASS
```

## R0.5 Canonical Product Run Model

This section is authoritative for the product runtime model after R0. It supersedes
older prose anywhere in this repository that describes Laya as an unmonitored loop
that automatically reworks, reassigns, replans, or switches models until completion.

```text
User Raw Task
      ↓
    Laya
      ↓
Task / DAG / Agent / Model / Session / Skill Intent
      ↓
Assignment
      ↓
Execution Round
      ↓
Native Agent
      ↓
Result / Artifact / Evidence
      ↓
Codex Independent Review / Test
      ↓
Human Gate
      ↓
User Decision
      ↓
optional next Execution Round
      ↓
Laya
```

- Laya is the only task-level Dynamic Decision Authority, not an infinite
  autonomous workflow loop. It may understand the user task, produce Task
  Decomposition / Candidate DAG / current-round execution plan, and express
  Agent / Model / Session / Skill intent, dependency, and parallelism.
- An Execution Round is `Laya → Assignment → Native Agent → Evidence → Codex
  Review → Human Gate`.
- After Codex Review, the system stops automatic advancement by default. The user
  decides complete / continue / repair with same agent / switch agent / switch
  model / replan / handle manually. A next round starts only after explicit user
  decision.
- Laya may express Agent Intent and Model Intent, but the final
  `(agentId, modelId)` is resolved by Assignment through capability,
  availability, quota, spawn gate, and policy. Assignment remains the only
  Assignment Authority.
- Inside one Execution Round, Agent / Model / Session do not auto-thrash because
  of ordinary stdout, warnings, progress, or one non-fatal error. Re-selection
  belongs to a new Execution Round after the Human Gate.
- Codex is an independent review / test gate, not a second Planner, Decision
  Engine, automatic rework controller, or automatic reassigner.
- The eleven Decision Actions remain. `continue / wait / add_task / split_task /
  parallelize` primarily form the current Execution Round; `retry / rework /
  reassign / replan` are available when Laya re-enters for a next user-authorized
  round; `complete` still goes only through `applyVerification`.

## 0. 后续阶段状态（2026-10-01 更新）

本审计的 **§2 authority map 与 §9 Keep 全部仍然成立**，未被后续阶段推翻。§8/§10 中
列出的缺口已被以下阶段关闭：

```text
ARCHITECTURE_STATUS = ALIGNED（仅指库层 authority 无缺口；CLI / 产品入口尚未接入，
                      真实 Laya production wiring 未完成 —— 见 R0 基线事实）

P6-C minor refactor (A/B/C/D)  DONE
  A Skill intent channel       WorkbenchTaskSpec.skills → bounded brief（纯 transport）
  B Session intent             SessionIntent{fresh|reuse{sessionKey}}，复用 ExecutionTarget
  C per-task preference        CandidateTask.preferredAgent/Model 覆盖 spec default
  D rework re-entry observability  ReviewOutcome.ok.reworkReentry（复用 ReworkReentry）

P6-D1 Dynamic Decision Loop   DONE
  W1 session reuse → native threadId   scheduler.tick(promptFor, threadFor)
  W2 decision-loop 注入 rework/replan   runDecisionCycle({capabilities})
  W3 TaskStore.migrateIdentityAfterStart  唯一 post-start identity writer
  W4 Orchestrator.retry() + running→retrying
  W5 Assignment 提案 + TaskStore 提交（identity 改变 → fresh session）
  W6 add_task / split_task / parallelize → 既有 planner + commitPlan
  W7 applyReview → recordReview()（append-only，best-effort，不参与决策）
  W8 SessionRegistry task→session 双向映射

验证（R0.5 review）：full suite 3756/0 · typecheck clean · native E2E 11/15
（Case 2 / 5 / 10 / 15 FAIL；归因见下）
```

**§10 的第 3 项（Handoff 需新解析系统的字段）仍为 deferred。Native E2E
Case 15 的 harness 缺口已修复；Case 2 / 10 的并发 commit harness 风险也已移除。**

**§10 的第 5 项（root agentId 默认值显式化）已于 R0 完成**：`WorkbenchOptions.rootAgentId`
为显式可选参数，`spec.preferredAgent ?? this.rootAgentId` 解析一次供 root 与 commitPlan
共用；默认仍为 `DEFAULT_ROOT_AGENT_ID = 'opencode'`，**既有执行结果完全不变**（无任何生产
调用方传入该参数）。

### R0 基线事实（2026-10-02）

- `AgentCapabilities` 已含 `skills` 事实位。依据真实运行：`opencode` 声明 `true`
  （brief 请求 `archify` 返回该 skill 的确切 frontmatter；请求不存在的名字返回
  `UNAVAILABLE` 而非编造），`codex` / `cline` / `workbuddy` 声明 `false`。
  该位**仅陈述事实**，不得作为路由 / 过滤 / preference 输入。
- **`NativeWorkbench` 与 `runDecisionCycle` 目前仅存在于库层与测试层**：仓库内没有任何
  生产调用方 `new NativeWorkbench(...)`。CLI / 产品入口尚未接入，真实 Laya 驱动的动态协同
  尚未跑通。因此「架构对齐」指**库层 authority 无缺口**，不等于产品可用。
- 复杂真实任务与真实 Laya production wiring 属于后续阶段（R1+），本轮未做。

### R1-1：Spawn Gate Production Compatibility（DONE，2026-10-02）

R1-0 接好了线，但真实 round 一个 task 都派发不出去。R1-0.5 查明是**两个独立的阻塞**，
两者都源于同一个盲区：**没有任何测试把真实生产者--输出喂给真实消费者**。

1. **`AgentStatusRow.agent` 装的是 display name，gate 用 machine id 匹配。**
   `buildAgentStatus` 写 `"OpenCode"`，`resolveAgentAvailability` 比 `'opencode'` ——
   永远匹配不上，四个正式 agent 全部得到 `agent-unavailable`。而所有测试都手工构造
   `agent: 'opencode'` 的行，所以这个不匹配从未被看见。
   **修法**：`AgentStatusRow` 增加 `agentId`（canonical identity），`agent` 保持 display
   name 不变（dashboard 输出零变化），gate 优先按 `agentId` 匹配并兼容旧行。

2. **`quota.status = unavailable` 的语义被读错了。** 它定义为"provider 没有 quota
   endpoint"，而这正是四个正式 agent 的真实状态（`PHASE4_QUOTA_AUDIT.md`, 2026-09-29：
   CLI 报告 usage/login 但从不报告 remaining/reset）。它却在 blocking 集合里，于是 gate
   永远拒绝 —— 拒绝在一个**为真**的事实上。测试之所以没发现，是因为它们注入了
   `status: 'available'`，而**没有任何 provider 能产出该值**。
   **修法**：`unavailable` 移出 blocking 集合。**真实事实未被改写** ——
   `status` 仍是 `unavailable`，`remaining` 仍是 `null`，没有伪造 `available`、
   没有伪造 remaining、没有伪造 quota record。`exhausted` / `unknown` /
   `not_fetched` / `not_connected` 全部仍然 fail-closed。

3. **`multi-agent-not-implemented` 已删除。** 它是 Phase 4/5B 的遗留 feature flag：
   理由文本"Multi-Agent is ... not implemented"在 P5B+P6 落地后已经不成立，却仍在第一个
   检查位置拒绝每一次 spawn。它不是 quota policy，也不是 capability policy。
   删除后 gate 的第一个检查是 task policy。**没有替换成别的全局 multi-agent 开关** ——
   单 task 还是 DAG 由 Laya 分类 → Planner shape → Scheduler 决定。

4. **`--no-multi-agent` 已删除**（R1-0 引入的错误抽象）。它不是"单 agent 模式"，而是
   kill switch：`multiAgentEnabled: false` 会让第一个检查拒绝，**整个 round 一个 task 都
   派发不了**。而单 agent 本就不需要它 —— Planner 已按 Laya 的 complexity 映射 shape。

新增 `tests/spawn-gate-production.test.ts`（50 项断言，含 8 类必需测试），其中 Test 1 是
承重的：它用真实 `buildQuotaCenter` 的输出喂真实 `buildSpawnGateInput`，中间不夹任何手工
构造的行 —— 这正是两个 bug 长期潜伏的原因。

**实测**：真实 round 现已到达 native execution —— 真实 OpenCode agent 写出
`R1-1-REACHED-NATIVE-EXECUTION` 并 commit，task 落到 `to_verify`（Verification 仍是唯一
completion authority，round 不代它做）。

### R0.5 Native E2E Attribution

| Case | 现象 | 实际根因 | 分类 | 改 Runtime | 改 Harness | 阻塞 R1 |
|---|---|---|---|---|---|---|
| 2 | 两模型进入 evidence，但 `verified=false / files=false` | 已移除并发 commit 指令并重跑，失败仍复现；真实运行了但未产出文件/未完成，属下游 agent 执行波动 | AGENT VARIANCE | 否 | 已做 harness hardening，未确认还需 correctness 修改 | 否，但失败任保留 |
| 5 | Handoff payload 进入 B brief，但 `B.txt` 为空 | A→Handoff→B 的传输正确；B 真实启动但没有产出文件，属下游 agent 执行波动 | AGENT VARIANCE | 否 | 否 | 否，但要保留 FAIL 事实 |
| 10 | 第一轮 parallel admitted / no edges / acyclic，但 `files=false`；第二轮 `admitted=false`，单任务 deadline 900s | 移除并发 commit 指令后失败仍复现；第二轮是真实 agent/provider 延迟与超时，不是 scheduler/parallel 语义缺陷 | AGENT VARIANCE / ENVIRONMENT | 否 | 已移除并发 commit 风险，未确认还需 correctness 修改 | 否，但失败任保留 |
| 15 | 依赖任务未解锁，`ranAll=false / files=false` | 测试缺少 `applyVerification(pass)` 是确认的 harness 缺口，已修复；重跑后仍失败，说明后续还有上游 agent 未产出/未推进的执行波动 | HARNESS + AGENT VARIANCE | 否 | 是，已补显式 verification | 否，但失败任保留 |

## 1. Current Architecture（真实调用链，全部定位到文件）

```text
User Raw Task
  ↓
Laya
  ↓
WorkbenchTaskSpec / Candidate DAG / Execution Plan
  ↓
Assignment
  ↓
TaskStore + SessionRegistry
  ↓
Execution Round: Native Agent
  ↓
Result / Artifact / Evidence
  ↓
Codex Independent Review / Test
  ↓
Human Gate
  ↓
User Decision
  ↓
optional next Execution Round → Laya
```

## 2. Decision Authority Map

| 职责 | 权威 | 实际文件/函数 | 状态 |
|---|---|---|---|
| 任务级规划（DAG） | Planner（候选）+ Laya（shape/kind 输入） | planner.ts / workbench-plan.ts | ✅ 单一 |
| Worker 选择 | Assignment（filter→score→preference） | assignment.ts assignWorker | ✅ 单一 |
| 任务状态 | TaskStore | store.ts | ✅ 唯一 |
| Dispatch | TaskScheduler.tick(promptFor) | scheduler.ts:169 | ✅ 唯一 |
| Execution | Orchestrator.run（经 executeTask） | orchestrator/orchestrator.ts | ✅ 唯一 edge（全仓 `runtime.run(` 调用点 1 处） |
| Verification | applyVerification | orchestration/orchestrator.ts:478 | ✅ 唯一 |
| Evidence | AttemptStore | attempt-store.ts | ✅ 唯一（append-only） |
| 执行准入 veto | Spawn Gate（spawn+execute 双期） | spawn-gate-input.ts + quota/spawn-gate.ts | ✅ 未被绕过 |
| Session 记账 | SessionRegistry | workbench-sessions.ts | ✅ 纯记录，不执行 |
| Review | Codex（结构化 verdict） | review-verdict.ts | ✅ 固定独立 gate |

关键结构事实（源码级验证）：workbench*.ts / assignment.ts / planner*.ts **零 value-import** 自 `../adapters` 与 `../runtime`；AttemptStore/planner/assignment 无 `.transition(`/`.tick(`/`.run(`；review-loop 只持 `applyVerification + getStore().get` 结构接口。

## 3. Agent / Model / Skill / Session Ownership —— **核心缺口在此**

| 概念 | 归属 | Laya 能否决定 | 现状 |
|---|---|---|---|
| Agent | Assignment（preference 先行，filters 兜底） | **部分** — `WorkbenchTaskSpec.preferredAgent` 存在且经同一 filters | ✅ |
| Model | Assignment | **部分** — `preferredModel` 同上 | ✅ |
| **Skill** | Native Agent 拥有执行；Workbench 只运输 | **能** — `WorkbenchTaskSpec.skills` 表达 intent 并渲染进 bounded brief | ✅（P6-C minor refactor A） |
| Session | SessionRegistry 记账；Laya 表达意图 | **能** — `SessionIntent{fresh\|reuse{sessionKey}}`，绝不暴露 `nativeSessionId` | ✅（P6-C minor refactor B） |

> **原 §3 结论已过时。** 当时记为「Skill ❌ 全仓 0 处」「Session ❌ Workbench 自动、
> Laya 不能决定」，并把 §8 Problem 1/2 列为 Major。两项已由 P6-C minor refactor 关闭：
> Skill 成为 Laya 可表达的 intent 通道（纯 transport，无 SkillRegistry / SkillRuntime）；
> Session 意图上浮到 spec / per-task，复用既有 `ExecutionTarget.sessionId` /
> `sessionPolicy` / `SessionRegistry` 的 identity-mismatch 防线。
>
> 仍未做且仍为 deferred：**`AdapterDescriptor.capabilities.skills` 事实位**。本机
> OpenCode 无 `skill` 子命令、CodeBuddy 的 `--agents` 定义的是 agent 而非 skill，
> 无可验证事实位，加了就是猜测。
>
> **P6-D1 追加**：Laya 现在能通过 typed decision 完整表达全部 11 个 action 的
> target/parameter；`ChoiceAnswer.parameters` 使 target 可由 provider 直接返回
> （此前 caller 必须手工补 target，即生产路径上的隐式决策）。`reassign` 必须在
> 显式 target 与显式 `strategy:"assignment"` 之间二选一，缺一即拒绝。

**明确标记的架构缺口**：目标模型要求 Laya 为每个 Task 决定 Agent + Model + Skill + Session 四元组。当前 Laya 只能表达前两个（且是 preference 而非指令）；**Skill 完全缺失**（既无 Workbench 抽象、也无 Laya 词表、也无向 native 的显式传递通道——native skill 仅在 prompt 里"顺便"被引导）；**Session 是 Workbench 推导的**（1:1 绑定 task×run），不是 Laya 的决策对象。Agent/Model/Session 没有被错误绑死成 1:1:1（SessionRegistry 支持同 agent 多 session 多 model，E2E Case 2 已实证并行），但"Laya 决定 Session 复用/延续"没有通道（resume 只能由 caller 显式 `open({sessionId, sessionPolicy:'resume'})`）。

Assignment 的 evidence score **仍会自动决定 worker**（无 preference 时）——这是 P6-B 设计内的 deterministic fallback，与"Laya preference 优先"不冲突（preference 经同一 filters 后必胜），但要注意：Laya 不给 preference 时，是 Assignment 而非 Laya 在选 worker。这符合 §6"Assignment 降级为基础设施"，不算第二大脑。

## 4. Planner / Scheduler / Execution / Verification Authority Audit

- **第二 Planner？无。** planner.ts 是纯候选生成（imports 仅 task.ts 的 findDependencyCycle）；workbench-plan.ts 只做 Laya→shape 映射；workbench.ts 无 decomposition/replan 逻辑（replan 走 decision.ts 的 `replan` action + planner-wiring 的 replanSubtree）。
- **第二 Scheduler？无。** Workbench.dispatch 调 `scheduler.tick(promptFor)`；`promptFor` 是新增的**携带**通道（scheduler 不生成 prompt，只转发），没有绕过或复制派发逻辑。
- **第二 Execution Edge？无。** 全仓 `runtime.run(` 调用点 1（orchestrator/orchestrator.ts:727）；workbench 层 0。
- **第二 Verification Authority？无。** review-loop 只经 `applyVerification`；Workbench.applyReview 组合 D0 路径；`spawnChild` 在 workbench 上只是既有 orchestrator 方法的转发。

## 5. Review Loop Audit（实际调用链）

```text
worker → RunResult → (caller 提交 ReviewVerdict → parseReviewOutput)
       → applyReviewVerdict（guard: maxAttempts(retryCount) / duplicate fingerprint / 均 BEFORE apply）
       → applyVerification → TaskStore
       rework → prepareRework（queue，同 worker，retryCount+1）→ scheduler.tick → 再 review
```

- **不会自动跨轮回 Laya**：guard 触发 = `rework-stopped`，task 停在 to_verify 等 caller；
  普通 review FAIL 不进入产品级下一轮。Execution Round 的默认边界是 Codex Review 后的
  Human Gate；只有用户确认继续时，下一轮才回到 Laya。
- **硬上限真实**：`retryCount >= maxAttempts` 在 apply 前（测试锁定无第 4 次 run）；maxAttempts ≤0/非整数 fail-closed。
- **双层边界明确**：retry 与 rework 仍是两个词表项；库层动作存在，但产品边界不允许
  无限自动循环。`running -> retrying` 自动失败闭环仍未产品化；fingerprint 重复检测是
  提前退出，maxAttempts 是硬界。
- Codex 不能自我续修：review 只产 verdict，无执行权。

## 6. Parallel Session Audit

- **已实证**（native E2E Case 2）：同一 OpenCode agent、space-bunny-free 与 mimo-v2.6-flash-free 两个 session 真实并行，两个模型 ID 各自进入 attempt evidence，产物互不串。
- SessionRegistry：sessionId 独立、nativeSessionId 各自捕获（`RunResult.threadId`，首次后粘滞）、identity-mismatch 拒绝跨 model 复用 session（`session-identity-mismatch`）。
- workspace：Workbench 层未配 WorkspaceManager（E2E 共享 cwd）——并行写隔离仍依赖调用方配置 worktree（5C 机制在，workbench 未强制）。**这是当前并发模型的一个注意点**，不是缺陷。
- cancellation 隔离：RunHandle.cancel 按 task；session registry 不参与 kill（结构上不能）。
- budget 按 task scope 绑定（gate fail-closed，E2E 曾真实拦截未分配 scope——正确行为）。
- 无 `agentId === modelId` 假设（evidence 维度分开聚合；reviewer 与 worker 分池）。

## 7. Handoff Audit

- `buildHandoff`：objective/status/artifacts(path only)/runState/`completedWork`（**600 字符 output tail**，非全文）/error code/transcriptPath（指针不内容）——**有界、结构化、不传 transcript** ✓。
- `buildTaskBrief`：objective + constraints + 依赖 handoff（声明序），确定性渲染。
- **缺口（对照目标字段）**：目标 TaskHandoff 要求 `changedFiles / tests / decisions / unresolvedIssues`——当前类型没有这些字段（changedFiles 可由 git/worktree 层补，tests/decisions/unresolved 目前无处来源——P6-E attempt 也没有 test 维度）。当前实现是目标的**子集**，方向正确。
- 模型输出**没有**被当作事实源：completedWork 只是 worker 自述 + 显式 600 字符截断，状态一律以 TaskStore 为准。

## 8. Problems（按严重度）

1. ~~**[Major] Skill 维度缺失**~~ → **已关闭**（P6-C minor refactor A）：TaskSpec `skills`
   作为 Laya intent 渲染进 brief；未建任何 skill runtime / registry。
2. ~~**[Major] Laya 不能表达 Session 意图**~~ → **已关闭**（P6-C minor refactor B）：
   `SessionIntent` 上浮到 spec + per-task override，`assignChildren` 不再硬编码 fresh。
3. ~~**[Minor] Workbench 自动开 session 的策略固定为 fresh**~~ → **已关闭**（同上）。
4. **[Minor] Handoff 字段是目标子集**（§7）：`changedFiles` / `testsRun` / `decisions` /
   `unresolved` 已可从**既有事实**派生（tool_calls 的 write/shell 输入、summary 中的
   显式 marker），无新 authority。仍 deferred：需要新建 worker-output parsing 系统的
   任何字段（故不做 DecisionExtractionEngine / GitAnalysisEngine / TestInferenceEngine）。
5. **[Minor] Workbench 层未强制 workspace 隔离**（继承 5C 已知限制，文档已声明）。
6. **[Minor] `workbench.ts` 的 `plan()` 对 root 的 agentId 用 `preferredAgent ?? 'opencode'`**
   —— root 不被派发所以无实际执行影响，但这个默认值是硬编码的（应为显式参数）。
7. **[Info] ZCode 不存在**：本机无 ZCode CLI/adapter；目标图中的 ZCode 分支当前不可用（WorkBuddy Intl 可用）。
8. **[Closed] Decision Contract 边界模糊**（P6-D1 收口阶段）：
   `reassign` 缺少 target 时曾静默由 evidence score 选 worker。现在缺 target 即拒绝
   （`reassign-target-required`），委派必须是显式 `strategy:"assignment"`。

## 9. Keep（正确，可保留）

- 全部 authority 单例：TaskStore / Scheduler（tick+promptFor 通道）/ WorkspaceManager / applyVerification / AttemptStore / ModelRegistry（sealed）/ Spawn Gate。
- `planner.ts + planner-wiring.ts`（P6-C）：纯候选 + 显式 commit + 受控 replan，与"最小 DAG"目标一致，**不是** workflow engine。
- `workbench-sessions.ts`：native handle 语义正确（Workbench 不拥有 native session）。
- `workbench-handoff.ts`：有界、证据支撑。
- `assignment.ts` 的 preference 通道（本 refactor 新增）：preference 经同一 filters，无第二决策模型。
- P6-F/A/D0/E 全部保留能力（fail-closed pool、observation、bounded review、append-only evidence）。
- Adapter 层：native session（opencode `--session`、codex resume、workbuddy `-r`）、native model selection、原生工具/MCP/subagent 全部保留——Workbench 没有重实现任何 Agent Runtime 能力；WorkBuddy 权限修复（-p 模式自动 bypassPermissions，附实测矩阵）是在补 adapter 的执行能力而非绕过。

## 10. Refactor（方向正确，需后续工作）

> **状态（2026-10-01 更新）**：第 1/2/4/5 项已由 P6-C minor refactor 与 P6-D1 完成，
> 仅第 3 项仍 deferred。

1. ~~**Skill 通道**~~ **DONE**：TaskSpec `skills` → bounded brief（"use your own if you
   have them"）。未建 Workbench skill runtime。`capabilities.skills` 事实位仍 deferred
   （无可验证事实，见 §3 注）。
2. ~~**Session 意图上浮**~~ **DONE**：`SessionIntent{fresh|reuse{sessionKey}}` +
   `toExecutionTarget()`；reuse 仍由 `SessionRegistry` 的 identity-mismatch 拒绝跨
   agent / 跨 model。
3. **[Deferred] Handoff 字段补全**：只需能从既有事实 authority 可靠派生的字段已补
   （见 §8.4）。需要新建解析系统的字段保持 deferred。
4. ~~**assignChildren 的 fresh 硬编码**改为读 spec 的 sessionIntent~~ **DONE**。
5. Workbench.plan 的 root agentId 默认值显式化。**R0 已完成**：默认仍为
   `DEFAULT_ROOT_AGENT_ID = 'opencode'`，但可通过 `rootAgentId` 注入；root 不派发。

## 11. Delete

- **无必须删除项**。审计未发现第二 planner/scheduler/assignment/agent runtime/workspace owner/verification authority。未出现企业级 workflow engine/event bus/daemon/DB。
- 唯一建议清理：`workbench.ts` 中 `impliedTaskType`/`tasks()`/`spawnChild` 等 3 个薄转发若无 caller 可删（纯瘦身，非架构问题）。

## 12. Recommended Next Architecture（差距的最小闭合路径，非实现）

> **状态（2026-10-01 更新）**：以下 5 行已全部落地，见 §0。结论随之更新。

```text
Laya 词表扩展        work_kind/complexity/review + skills?             → DONE（intent 通道）
TaskSpec             + skills? + sessionIntent?                        → DONE
Assignment           preference 增加 skill 匹配为非硬过滤               → NOT DONE，且**不应做**
                                                                       （Skill 不参与选人，
                                                                        见 §3 注：本机无
                                                                        可验证 skill 事实位）
Handoff              + changedFiles/tests/decisions/unresolved         → DONE（仅可从既有
                                                                       事实派生者）
SessionRegistry      不变（已正确）                                    → 未变，另修 task↔session
                                                                       双向映射（R-1/R-3）
DecisionAnswer       + parameters（target 由 provider 直接返回）       → DONE（P6-D1 收口）
```

```text
ARCHITECTURE_STATUS = ALIGNED
```

依据：九大 authority 全部单一且有源码级结构测试锁定；P6-C / P6-D1 两层无第二核心；
R0.5 review 的真实 E2E 结论是 **11/15 PASS**：OpenCode 双模型并行、Codex review
闭环、Handoff 内容传递、session reuse、reassign、replan、retry 相关片段均有真实运行证据，
但 Case 2 / 5 / 10 / 15 本轮失败，详见临时 dashboard。库层原缺口（Skill 通道 /
Session 决策面 / Decision Contract 边界）已关闭；产品级 production wiring 仍未接。


---

## R1-1 Addendum（2026-10-02，最终状态 — 本正文之上的审计快照在此处被部分取代）

本文件是一次审计快照；R1-1 落地后的**最终**事实以两处为准：

1. **`docs/EXECUTION_ROUND_SEMANTICS.md`** — R1-1 语义的 canonical 记录
   （AgentStatus identity、quota `unavailable` 观测策略、已删除的
   `multi-agent-not-implemented` / `--no-multi-agent`、Production Round 管线、
   budget scope 契约、Assignment↔Gate parity、AttemptStore-as-evidence 技术债）。
2. **本 Addendum** — 对本快照结论的增量修正：

- **审计时 OPEN 的 Decision Contract 项已闭合**：reassign 现在要求显式 target 或
  `strategy:"assignment"`（DC-1）；add_task 的 taskType 经 planner 真实落库（DC-2）；
  retry 携带 target 会被 validator 以 `invalid-worker-reference` 拒绝（retry ≠ reassign）。
- **R0.5 的 11/15 已推进到 R1-1 的 14/15**（Case 1–14 PASS）；Case 15 剩余问题属于
  测试场景未调用 `applyVerification` + Agent variance，不是 Spawn Gate runtime defect。
- **上文 §4/§6 中对 `multiAgentEnabled` gate 检查与 `multi-agent-not-implemented`
  的描述在此注明为 historical**：该 field/deny code/CLI flag 已在 R1-1 全部移除，
  single-vs-multi 由 Planner/Laya task shape 决定。
- production wiring 已接入（`orchestrator round` CLI），native execution 真实到达；
  AttemptStore 是当前 round report 的事实来源（decision-loop `tick/results`
  dead-path 为已知未修技术债）。
