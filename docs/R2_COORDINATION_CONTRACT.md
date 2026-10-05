# R2-0 Coordination Contract — 跨 Agent 协作的设计契约（Design Only）

```text
Status     = DESIGN / CONTRACT · R2-1/R2-2 已按本契约实现（见 PROJECT_BASELINE §13）· 无第二 authority
Date       = 2026-10-02
Base       = R1-1（Production Orchestration Wiring）· HEAD c156db0 + R1-1 worktree
Authority  = 本文不新增任何 authority；全部对象挂靠既有 authority
Canonical  = 与 docs/EXECUTION_ROUND_SEMANTICS.md 并列；冲突以二者中更具体者为准。产品定位与路线基线 = docs/PROJECT_BASELINE.md
Baseline   = 3805 tests / 0 failed · native E2E 14/15 PASS
```

## 1. Purpose

R1-1 已确认 Task ownership 收口（Laya→Planner→Assignment→Scheduler→Native Agent，
Agent 无自主 claim/takeover）。尚未解决的是 **Resource ownership 与 Agent 间协作**：
多个并行 Agent 仍可能共享同一 mutable cwd（真实 write-collision 风险），且
Lease / fencing / Collaboration Protocol / Context Gate / ResourceClaim / Workspace
isolation 均未实现。

R2-0 把这些机制设计成一个 **Coordination Contract**：对象、identity、ownership、
lifecycle、authority、validation、failure modes、测试策略。**本轮只做设计与
技术文档，零 runtime 改动。**

## 2. Scope

- In：下列契约对象的设计；authority 归属；状态/转移；failure matrix；测试矩阵；
  与 A2A/ACP/MCP 的映射说明。
- Out：任何 runtime 实现（§23）；任何新 authority（§4）；always-on / 长期运行
  语义（§22）。

## 3. Canonical Principles

1. **Multi-Agent ≠ Multi-Chat。** Agent 可以交流信息，但 Agent 不拥有组织权。
2. **Task ownership / Resource ownership / Control authority 三者分离。**
3. **Agent-to-Agent message 默认是 informational/request，不是 control command。**
4. 所有正式 Task Control 仍只能经既有 authority（TaskStore / Assignment /
   Scheduler / applyVerification）。
5. **并行写入默认需要 Resource / Workspace isolation**；共享 mutable cwd 不是
   合法的并行写形态。
6. **Execution Round 是 bounded 的**：无 always-on、无 24/7、无 persistent
   autonomous goal、无无限 rework/replan/retry。Human Gate → END。

## 4. Authority Boundaries（不变量）

R2-0 对象全部**挂靠**既有 authority，不新建引擎：

| Contract 对象 | 挂靠的既有 authority | 说明 |
|---|---|---|
| Task / ownership mutation | TaskStore | 唯一 task-state authority |
| Assignment / Lease 签发 | Assignment（`assignWorker` + `TaskStore.assignIdentity/migrateIdentityAfterStart`） | Lease 是 Assignment 决定的**记录**，不是第二个分配者 |
| ResourceClaim / Workspace | WorkspaceManager（既有 workspace authority，`orchestration/workspace.ts`） | claim registry 是 WorkspaceManager 的新方法面，不是 Resource Scheduler |
| Session / native handle | SessionRegistry | 不变 |
| Message 投递 | Workbench（协调层）承担信使，**不解释内容** | 无 message daemon |
| Context 门控 | Workbench 的 brief 组成（`buildTaskBrief`）扩展 | Context Gate 是过滤契约，不是新 runtime |
| 验证 | applyVerification（不变） | EvidencePacket 不引入新 Verification Authority |

明确禁止的新对象：Collaboration Engine、Resource Scheduler、Message Planner、
Second Assignment Engine、Second Decision Engine、Parallel Executor、message daemon、
mailbox runtime。

## 5. Task Ownership Contract

### 5.1 Ownership 与 result ownership 的区别

```text
Task ownership     = 谁被指派执行（Assignment Authority 决定，TaskStore 记录）
Result ownership   = 谁产出了一条结果（AttemptStore 按 record.agentId 记录，不可改写）
```

一次 migration 之后：Task ownership 变更，**旧 agent 的 result ownership 不变**
（attempt 记录仍归旧 agent），且旧 result 被 `applyRunResult` 的 `agent-mismatch`
拒绝写回 task state。R2 的 fencingToken 是对该既有守卫的显式化（§7.4）。

### 5.2 Agent 可以说、不能做

Agent（经由其输出/message）可以发送：`request_help`、`suggest_reassign`、
`blocked`、`recommend_agent`——全部是 **proposal / observation**。

Agent 不能经 message 完成：`claim` / `takeover` / `reassign` / `override` /
`complete` / `approve` / `cancel` / `change_dependency` / `release_lock`。
这些是 Control Plane 操作，唯一路径：

```text
Agent 输出 → Observation → Laya decision → 既有 authority mutation
```

### 5.3 Validation rules

- ownership mutation 必须携带 Laya decision id（cycle 标识）或 Human Gate 动作；
  无来源的 owner 变更在 TaskStore 层拒绝（既有 `assignment-after-start` /
  `migration-after-terminal` / `migration-reason-required` 守卫保持）。

## 6. Assignment Lease

### 6.1 最小字段（从现有结构推导）

现有 identity 写入点：`TaskStore.assignIdentity` / `migrateIdentityAfterStart`；
现有可引用对象：Assignment 的 `(agentId, modelId)`、SessionRegistry 的
`sessionId`。Lease 是 identity 写入的**伴随记录**，签发即存在：

```text
AssignmentLease {
  leaseId          // 唯一；由签发方分配
  taskId           // 指向 TaskStore
  agentId          // canonical machine identity（R1-1 语义）
  modelKey         // 'agentId::modelId' —— 复用 sealed registry 的 modelKey
  sessionId        // SessionRegistry 的 session（可 null：session 尚未开）
  issuedAt
  expiresAt        // 本 round 内的软界（见 6.2）
  leaseVersion     // 每 task 单调递增；migrate/retry/rework 重发时 +1
  fencingToken     // = leaseVersion 的 nonce 化形式（见 6.4）
}
```

不引入的字段：worker heartbeat、persistent identity、跨 round 续约。

### 6.2 签发 / renew / revoke

- **签发者：Assignment Authority**（Assignment 计算出 candidate 之后、
  `TaskStore.assignIdentity / migrateIdentityAfterStart` 提交之时）。Agent 不能
  为自己签发 lease。
- **Renew：允许，但仅限当前 Execution Round 内**。语义是"防止一个仍在正常运行的
  短任务因超过 expiresAt 被误判失效"，不是 persistent worker heartbeat：renew
  次数有 policy 上限（默认建议 ≤2），renew 由 Workbench 在 tick 观察到任务仍在
  running 时发起，仍然由 Assignment authority 记录。
- **Revoke 发生在**：reassign（leaseVersion+1 新租约）、abort、task terminal、
  session migration。revoke 后旧 lease 作废，旧 fencingToken 失效。

### 6.2.1 Clock domain（唯一 authoritative clock）

Lease 的 **issue / activation / renew / validation 必须共享同一个 authoritative clock
domain**；`now` 必须显式传递，**不允许隐藏的 `Date.now()` fallback**。

理由不是风格：deadline 由签发方的时间戳生成、由读取方的时钟判定。两者混用会签出
**一出生就过期**的 lease——拒绝依然正确（fail-closed），但原因错误，会把排查引向
"版本/ token 不匹配"这条错误的路径。该缺陷在 Native E2E Case 17 的首次运行中实际触发
（用例传入了固定 epoch，而 orchestrator 读真实时钟）。

落地方式（已在 R2-2 final closure 强制，非仅文档化）：

- `TaskStore.assignIdentity` / `assignment-wiring.applyAssignment` 的 `now` 为**必填参数**
  → 传入不同时钟的调用方是**编译错误**，而不是潜伏的 bug。
- `Orchestrator` 与 `NativeWorkbench` 各持一个注入的 `now`，并在其写入的所有事实
  （identity、session、receipt、renew、liveness 判定）上统一使用。
- lease 路径文件中 `Date.now()` 在 code（剔除注释与字符串字面量）里的出现次数为 0，
  并由 `tests/assignment-lease.test.ts` 的 clock-discipline 断言担保。

### 6.3 Lifecycle

```text
issued → active → (renewed)* → released
                     ↘ revoked（reassign / abort / terminal / migration）
expired（expiresAt 已过且未 renew）→ 视为 stale：不可再派发、不可再 renew，
只可被 Laya 的 retry/reassign 决策处置
```

### 6.3.1 实现记录（2026-10-03，R2-2 收口）

| 契约动作 | 实际落点 | 说明 |
|---|---|---|
| 签发 | `TaskStore.create` / `assignIdentity` / `migrateIdentityAfterStart` | 三处都调用 `issueLeaseForTask`，`leaseVersion`/`fencingToken` **取自 Task** |
| `issued → active` | `TaskStore.markLeaseUsed`，由 `Orchestrator.executeTask` 在 dispatch 时调用 | 见 §6.3.2 |
| revoke（identity 变更） | `reissueLease`：先 revoke 旧 lease 再签发新 lease | 同一操作内完成，**不存在两个 holder 同时 live 的窗口** |
| revoke（terminal） | `TaskStore.transition` → `revokeLeaseFor` | `transition` 是全仓唯一写 `status` 的位置，因此 terminal revoke 无旁路 |
| renew | **生产调用点：`NativeWorkbench.dispatch()` 在 tick 之后调用 `TaskStore.renewRunningLeases(now)`** | 显式、tick 驱动、有界；**无 timer / daemon / heartbeat**；renew 不触发 tick |

### 6.3.2 为什么 deadline 在 dispatch 处重新锚定（`issued → active`）

这是一个**受约束的设计决定**，并且它偏离了 §6.3 字面读法中「expired 不可再 renew ⇒ 不可再
派发」的直接推论，因此在此显式记录理由。

**要消除的 livelock**：

```text
assigned(T0) → queued → 等待超过 15min → scheduler 仍然认为 ready → dispatch
    → lease（TTL 自 T0 起算 15min）已经 expired
    → live lease 不可 renew（§6.3），所以"提前 renew"救不了
    → 准入拒绝 lease-not-live → 该 task 永远无法执行
```

**为什么这是 bug 而不是"契约本来如此"**：在 lease 下**第一次执行开始之前，没有任何东西
需要一个 deadline 来保护**。fencing 存在的目的是阻止被 supersede 的执行回写，而此时没有
in-flight 的执行。因此真正有意义的 deadline 是**界定 execution window**的那个，它应当在
holder 真正开始工作处起算。

**它不是 heartbeat，也不无界**：

- 只作用于 `issued` 状态的 lease ⇒ **每个 lease version 最多一次**；reassign 产生新
  version，各自带一次。
- revoked 的 lease 永不被 activate ⇒ revoke 依然终局获胜。
- 无 timer、无后台线程：`Orchestrator.executeTask` 在准备执行的那一刻同步调用。

**长执行由 renew 覆盖**（§6.2 本来描述的就是这件事）：run 超出 execution window 后，
Workbench 在下一次 tick 调用 `renewRunningLeases`，最多 `maxRenewals` 次（默认 2），
用尽后拒绝——此时迟到的结果被拒（`lease-expired`），证据仍保留（F5）。

### 6.3.3 fencing 原语知道 lease 生命周期（P1-2）

`checkFencing` 只比较 identity / version / token，这是刻意的纯函数边界。但
`revokeLease` **刻意保留** `leaseVersion` 与 `fencingToken`（它们是"曾经授予过什么"的
证据），因此**同 version 同 token 的 revoked lease 会被纯 fencing 接受**。

为此新增**唯一**的生命周期感知写回校验原语 `validateWriteback(current, presented, now)`：
先判生命周期（revoked / expired），再委托 `checkFencing`。所有 execution 写回
（`applyRunResult` 与 `stillHoldsLease`）**必须**走它。不存在"caller 1 判生命周期、
caller 2 只判 token"的结构。

`lease-revoked` / `lease-expired` 不并入 `checkFencing` 的四个码：revocation 是 Assignment
的生命周期决策，不是 token 比较，并进去会破坏 version/token 各码的含义。

`applyVerification()` **不经过**该原语——verification 是另一个 authority，问的是另一个问题。

### 6.3.4 ResourceClaim 有效性依赖 lifecycle，而非仅 version（P1-3）

`claimIsLeaseCurrent(claim, currentLeaseVersion)` 是纯算术，**ResourceClaimBook 不知道
lease 是什么、不能查 lease**。因此调用方必须传 `claimLeaseVersionOf(lease, now)` 的结果
（对 revoked/expired 返回 `null`），而**不是**原始的 `lease.leaseVersion`。传原始 version
正是 P1-3：revoked lease 与 claim 同 version，于是被误判为 current。

### 6.3.5 时钟域（P2）

lease 的 deadline 由签发方时间戳生成、由读取方时钟判定。混用两个时钟会签出**一出生就
过期**的 lease（拒绝仍正确但原因错误，会误导排查——Native E2E Case 17 首次运行即撞上）。
现在**强制**而非仅记录：`assignIdentity` / `applyAssignment` 的 `now` 为**必填参数**，
任何传入不同时钟的调用方是编译错误；`Orchestrator` 与 `NativeWorkbench` 各持一个注入的
`now` 并在所有写入点使用。四个 lease 路径文件中 `Date.now()` 的 code 出现次数为 0。

**两个关键实现决定**

1. **`issueLease` 从 Task 取 `fencingToken`，不再自签。** 早期实现自己
   `mintFencingToken`，导致同一 (task, version) 下 lease 记录与 Task 上的凭证**永远不相等**，
   任何比较都会拒绝合法写回。这违反了本节"签发即存在、且不得与 task 冲突"的前提。
2. **lease 记录存放在 `TaskStore`（每 task 一条），不是新的 registry。**
   lease 不是关于 task 的新事实，而是 `Task.leaseVersion`/`fencingToken` 的生命周期记录；
   放在唯一写 identity 的权威旁边，才能保证两者不可能不一致。该 map **不能** dispatch、
   不能 transition、不能 retry/reassign、不能签发凭证。

**边界（本轮实测确认，非设计意图）**：lease 的 deadline 由签发方传入的时间戳生成，
由读取方的时钟判定。两者混用会签出**一出生就过期**的 lease —— 拒绝仍然正确，但原因错误，
会误导排查（首次在 Native E2E Case 17 中实际触发）。因此签发与判定必须使用同一时钟。

**`modelKey` 复用 sealed registry 的 `modelKey(agentId, modelId)`**，不再自造
`agentId/modelId` 拼法：同一 (agent, model) 对不应因来自哪个模块而有两个 key。

### 6.4 fencingToken 如何防 stale result

```text
old lease (version N, token T_N)
    ↓ migration → new lease (version N+1, token T_N+1)
late result（旧 run 迟到返回，携带 T_N）
    ↓ applyRunResult 校验 token == 当前 lease.fencingToken
    → REJECT（stale-result），attempt 记录仍归旧 agent（result ownership 不变）
```

**它解决**：late result 污染 task state、旧 run 抢占新 run 的验证路径。
**它不能解决**：旧 Agent 进程继续修改共享 filesystem——那是 ResourceClaim /
Workspace isolation 的领域（§8/§9）。本文档明确：**fencingToken ≠ 文件系统隔离**。

## 7. Resource Claims

### 7.1 契约

```text
ResourceClaim {
  claimId
  taskId
  leaseVersion        // 绑定当时有效的 lease；lease revoke ⇒ claim 作废
  workspaceId         // 指向 WorkspaceManager 的 WorkspaceHandle
  mode                // read | write | exclusive-write
  scope               // file(path) | directory(path) | repository | workspace
  createdAt
}
```

Authority：claims 由 **WorkspaceManager**（既有 workspace authority）登记与仲裁；
它不是新的 Resource Scheduler——只是 workspace 权威的一个登记面。

### 7.2 Read / Write 冲突矩阵

| 已持有 \ 新申请 | read | write | exclusive-write |
|---|---|---|---|
| **read** | allow | 同 scope 重叠时 depends（默认 allow，policy 可收紧） | conflict |
| **write** | 同 scope 重叠时 depends（默认 allow） | **conflict**（scope 重叠） | conflict |
| **exclusive-write** | conflict | conflict | conflict |

- "scope 重叠"：file=同路径；directory=路径前缀包含；repository/workspace=同 id。
- read+write 的默认 allow 依赖一个诚实前提：read 者接受读到中间态。需要一致性
  时应由 Laya 在 DAG 中表达依赖，而不是靠 claim 阻塞。

### 7.3 Validation / invalid cases

- claim 必须引用**当前有效 lease**；lease revoked/expired ⇒ claim 自动作废。
  ✅ **已实现（2026-10-03）**：
  - `claimLeaseVersionOf(lease, now)` 只对 **live** lease 返回版本；revoked/expired → `null`。
    作废因此发生在"**绑定做不出来**"这一步，而不是依赖某个必须被记得跑的清扫。
  - `claimIsLeaseCurrent(claim, currentVersion)` fail-closed：`leaseVersion: null` 的 claim
    无法证明自己持有 live lease，因此不算 current。
  - `ResourceClaimBook.voidClaimsWhere(predicate)`：predicate 由调用方（持有 TaskStore 的
    orchestrator）提供。**book 不知道 lease 是什么、不能查 lease、不能判定存活性**，
    所以它不可能变成 lease authority——这正是把判定留在外面所换来的东西。
  - dispatch 准入新增 `lease-not-live`：live lease 缺失时**在登记任何 claim 之前**拒绝，
    无 runtime 调用、无 agent 被归咎、task 状态不变。
  - write/exclusive-write 无 claim ⇒ `executeTask` 的 workspace 检查拒绝
    （Spawn Gate 后、runtime run 前，不新增 authority）。
  - 同一 task 重复 claim 同一 scope ⇒ 幂等返回既有 claim。

## 8. Workspace / Worktree Contract

现状（源码事实）：WorkspaceManager 已支持 `isolated`（每 task 一个 git worktree，
`orch/task/<id>` 分支）与 `shared`（显式目录）两种 mode；5C 已知限制是"shared cwd
并行写不安全"。R2 契约把该限制升级为**规则**：

```text
Task → Assignment → Workspace（WorkspaceManager.prepare）
  parallel read-only  → 可共享一个 workspace（mode=shared）
  parallel write      → 默认 isolated workspace / worktree（每 task 一个）
  integration         → 一个正式 Task（single writer），把 A/B/C workspace 的
                        产物合入 main workspace；不是 Scheduler 的隐式行为
```

- Integration Task 由 Planner 产生、走 Assignment/Gate/Scheduler 全流程；
  merge 冲突时走既有"conflict 保留 + Human/Laya 处置"语义。
- Workspace 在 round 结束后按既有 retain/cleanup 策略处理（有改动保留供审计）。

## 9. Collaboration Message

### 9.1 Envelope（跨四 Agent 统一；不假设共享模型/session/tool runtime/protocol）

```text
CollaborationMessage {
  messageId           // 去重键
  runId               // 本 Execution Round
  taskId              // 消息所属任务
  contextId           // 允许的上下文域（Context Gate 的键）
  senderAgentId       // canonical machine identity（R1-1）
  recipientAgentId    // 或 'orchestrator'
  type                // 见 9.2 的封闭词表
  authority           // 'informational'（唯一合法值；见 §11）
  assignmentId / leaseVersion   // 发送者当时持有的租约（staleness 检查用）
  inReplyTo           // messageId
  artifactRefs        // 指针，不内联内容
  evidenceRefs        // 指向 EvidencePacket（§13）
  createdAt
  payload             // type 决定的有界载荷
}
```

### 9.2 词表（封闭）

合法 type：`informational` / `request` / `evidence` / `progress` / `question` /
`blocker` / `handoff` / `review_finding` / `conflict` / `request_help` / `ack`。

非法（Control Plane，永远不是合法 message type）：`assign` / `reassign` /
`complete` / `approve` / `cancel` / `override` / `change_owner` /
`change_dependency` / `release_lock`。

### 9.3 投递与解释

- 投递由 **Workbench** 承担（信使）；Workbench 读取、过滤（Context Gate）、审计、
  转交 Observation——**不执行** message 的任何请求。
- `request_help` / `suggest_reassign` 类消息的处置路径：

```text
Agent → message（request）→ Observation → Laya / Assignment Authority → 真实 mutation
```

- 重复 message：messageId 去重；乱序：靠 `inReplyTo` + `createdAt` 排序呈现，
  不触发任何控制；task terminal 后到达的 message：仅归档。

## 10. Context Packet

**ContextPacket 是受控交接材料，不是 transcript mirror。**

```text
ContextPacket {
  contextId
  taskId
  goal / constraints          // 来自 TaskSpec（权威）
  relevantFiles               // 路径引用
  currentState                // worker 自述（有界）
  decisions[]                 // 已确认决策（须有来源）
  evidenceRefs[]              // 指向 EvidencePacket
  openQuestions[]             // 未解决问题（标记为 claim）
  expectedOutput              // 验收期望
  artifactRefs[]
  unverifiedClaims[]          // 显式标注：worker 声称但未被验证的事实
}
```

- **谁生成**：默认由 Workbench 在 handoff/brief 组成时生成（复用/扩展
  `buildTaskBrief`）；worker 可通过 message 贡献 `decisions/openQuestions`
  字段内容，但**必须落入 unverifiedClaims 直到验证**。
- **谁批准**：Workbench（协调层）按 Context Gate 规则过滤后交付；Laya 不读
  未过滤的 transcript。
- **谁能看到**：由 Context Gate（§16）按 task/context 域决定。
- **广播**：不允许向整个 Task DAG 默认广播；packet 的 `contextId` 决定可见域。
- **transcript 永远不出现在 packet 中**（延续现有 ≤600c bounded tail 规则）。

## 11. Evidence Packet

**Agent 的陈述不是系统事实；Evidence 才是可审计依据。**

```text
EvidencePacket {
  evidenceId
  taskId
  kind                // claim | measurement | artifact | test_result | review_finding
  statement           // 有界文本
  source              // agentId / AttemptStore record / file / command output
  verificationState   // unverified | corroborated | refuted
  artifactRefs[]
  createdAt
}
```

- `verificationState` 只能由**既有 Verification/Review 流程**（applyVerification /
  AttemptStore 事实）推进；EvidencePacket 自身没有验证 authority。
- 与 AttemptStore 的关系：EvidencePacket **引用** attempt/记录，不复制其内容，
  避免第二事实源。AttemptStore 仍是执行事实的 append-only 权威。

## 12. Handoff（增量设计，不另起炉灶）

现有 `TaskHandoff`（workbench-handoff.ts）已覆盖：taskId/objective/taskType/status/
runState/artifacts/completedWork(bounded)/error/transcriptPath。**提升为 R2 canonical
handoff contract**，仅补四个增量字段（来源已在此前 review 定义）：

```text
+ changedFiles[]      // 由 worktree/git diff 派生（Workspace 层）
+ tests               // { command, result }，来源 AttemptRecord 增维
+ decisions[]         // 引用 EvidencePacket（corroborated 状态）
+ unresolvedIssues[]  // 引用 EvidencePacket（unverified claim）
```

不建立 parallel handoff authority；HandoffPacket 就是 ContextPacket 在
"任务完成"场景的特化视图。

## 13. Conflict

```text
ConflictPacket {
  conflictId
  taskId
  subject              // 冲突主题（有界描述）
  alternatives[]       // 每项：proposerAgentId + 方案 + evidenceRefs
  evidenceRefs[]
  raisedBy
  severity             // info | minor | major | critical（沿用 ordinal）
  resolutionStatus     // open | routed_to_laya | routed_to_human | resolved
}
```

- 冲突**不进入 Agent 间辩论**：A/B 各自提交 alternatives，packet 交给
  Observation → Laya（task-level）或 Human Gate。
- ConflictPacket **不能自己触发** replan/rework/reassign；它只是 Observation 的
  输入。

## 14. Execution Graph vs Message Graph

两个图必须分开，且不能互相推断：

- **Execution Graph**：Task A/B/C、dependencies、parallelism——决定什么在何时
  被 Scheduler 执行（TaskStore 的依赖边）。
- **Message Graph**：谁能看到谁的什么信息——决定信息可见性（Context Gate 的
  contextId 域）。

关键规则：`Task B` 与 `Task A` 并行 ≠ `Task B` 自动看到 `Task A` 的全部
transcript。B 能看到的内容仅由 ContextPacket + Context Gate 决定。同理，message
graph 的边不能创造 execution graph 的边（"我看到了 B 的消息"不产生依赖）。

## 15. Context Gate

Contract only，不实现。四种可见性：

```text
message visibility    // 哪些 CollaborationMessage 进入某 agent 的 Observation
context visibility    // 哪些 ContextPacket 域可见
artifact visibility   // 哪些 artifact 路径出现在 brief
workspace visibility  // 哪些 workspace 路径可达（与 ResourceClaim 交叉）
```

示例：Task B allowed = 自身 context + shared project constraints + Task A 的
selected Evidence；denied = Task A 的 hidden transcript、private credentials、
无关任务上下文。

**Context isolation ≠ Security boundary**：真正的 filesystem / credential /
process isolation 仍属于底层执行环境（worktree、OS 权限、credential 注入策略）。
Context Gate 只治理**信息流**。

## 16. Cross-Vendor Interoperability

四个 identity（OpenCode / Codex / WorkBuddy CN / WorkBuddy Intl）是独立 Agent，
不假设共享模型/session/tool runtime/protocol。R2-0 定义的是 **Internal
Coordination Contract**；对外协议映射（未来，非现在采用）：

| 内部概念 | A2A（Google，Task/Message/Artifact 对象模型） | ACP（agent↔client session/cwd transport） | MCP（tool plane） |
|---|---|---|---|
| Task / dependencies | A2A Task lifecycle | ACP session 的工作单元 | MCP Tasks 的 async task state |
| CollaborationMessage | A2A Message + Parts | ACP 消息通道 | —（MCP 是 tool 平面，不承载协作） |
| artifactRefs | A2A Artifact（immutable output） | — | MCP resource 引用 |
| Session / cwd | — | ACP session + cwd 语义 | — |

映射原则：内部契约是**唯一权威**；对外协议只是传输/互操作适配层，一个概念不得
同时存在两份权威定义。

## 17. State / Lifecycle 总览

```text
Task        : 既有 11 态不变（TaskStore 权威）
Lease       : issued → active → (renewed)* → released | revoked | expired
Claim       : claimed → active → (released | invalidated-by-lease-revoke)
Message     : created → delivered → (read | expired | deduplicated)
Packet      : composed → gated(allowed|filtered) → consumed
Conflict    : open → routed_to_laya | routed_to_human → resolved
```

## 18. Coordination Failure Matrix

| # | 情形 | Detect | Authority | Allowed action | Reject 行为 | Observability | Retry? |
|---|---|---|---|---|---|---|---|
| 1 | 同一 Task 被双重 claim | claim registry 幂等检查 | WorkspaceManager | 第二 claim 幂等返回既有 | — | claim 记录 | no |
| 2 | 未授权 takeover（Agent 试图经 message） | 词表拒绝（message type 非法） | 无 mutation 发生 | message 归档 + 记录 | type 拒绝 | audit log | no |
| 3 | 未经 Assignment 的 reassign 请求 | capability 只从 Laya decision 可达 | Assignment | 拒绝（`*-not-available`/capability 缺失） | fail-closed | decision outcome | no |
| 4 | Stale assignment（旧 lease 的 message） | `leaseVersion` 不匹配当前 lease | Workbench 过滤 | 归档，不入 Observation | 静默标记 stale | message audit | no |
| 5 | Expired lease | tick 观察 expiresAt | Assignment（renew/refuse） | 不再派发；交 Laya retry/reassign | — | lease 状态 | via Laya |
| 6 | Late result（旧 run 迟到） | fencingToken ≠ 当前 | TaskStore.applyRunResult | 拒绝写回（stale-result） | attempt 保留归旧 agent | agent-mismatch 类错误 | no |
| 7 | Reassigned task + old agent alive | session-identity-mismatch + fencing | SessionRegistry/TaskStore | 旧 session 不可复用；late result 拒绝 | 见 #6 | 双重（session+result） | no |
| 8 | Two writers same file | ResourceClaim write-write 冲突 | WorkspaceManager | 第二 write claim 拒绝 → 任务保持 planned/等 Laya | claim 冲突码 | claim 冲突记录 | via Laya |
| 9 | Directory overlap | scope 前缀检查 | WorkspaceManager | 同 #8 | 同上 | 同上 | via Laya |
| 10 | Workspace deleted（外部删除） | prepare/exists 检查（既有 workspace-path-missing） | WorkspaceManager | 拒绝派发，task 保持原态 | 拒绝理由含路径 | 既有 | via Laya |
| 11 | Agent crashes（进程消失） | runtime outcome（failed/timed_out） | TaskStore | task → failed（既有） | — | RunResult | via Laya retry |
| 12 | Session disappears（native handle 失效） | resume 失败 → runtime error | SessionRegistry/Orchestrator | 降级 fresh 重试需 Laya 决策；不自动换 session | resume 错误如实报 | RunResult.error | via Laya |
| 13 | Message duplicated | messageId 去重 | Workbench 投递层 | 只投递一次 | — | 去重计数 | no |
| 14 | Message delayed（task terminal 后到达） | 任务终态检查 | Workbench | 仅归档 | 不入 Observation | 归档记录 | no |
| 15 | Message from wrong agent（identity 不符） | senderAgentId vs lease | Workbench | 拒投 + 标记 | 拒绝码 | audit | no |
| 16 | Message with stale assignment | leaseVersion 校验 | Workbench | 同 #4 | 同上 | 同上 | no |
| 17 | Invalid recipient | recipientAgentId 不在 topology | Workbench | 拒投 | 拒绝码 | audit | no |
| 18 | Conflicting evidence | EvidencePacket 的 verificationState 推进规则 | Verification/Review（既有） | 并列呈现给 Laya/Human | 不自动裁决 | packet 记录 | via Laya |
| 19 | Conflicting recommendations | ConflictPacket → Observation | Laya / Human Gate | 路由；不自动执行 | — | conflict 记录 | via Laya |

设计底线：**矩阵中没有任何一行引入自动无限恢复**；所有 retry 都经由 Laya 的
显式 decision（受既有 retry/rework 界约束）。

## 19. Security / Safety Boundaries

- Context Gate 治理信息流，**不是** security boundary（§15）。
- fencingToken 治理 result 写回，**不是** filesystem isolation（§6.4）。
- filesystem/credential/process isolation 属于：worktree（WorkspaceManager，已实现）
  + OS/credential 层（未实现，R2-1 范围）。
- Cross-vendor：一个 Agent 的 native protocol 漏洞不得成为另一 Agent 的入口——
  协作只经 Workbench 信使，从不 agent-direct-agent。

## 20. Test Matrix（R2 测试规划，fake providers 先行，真实 E2E 随后）

- **Ownership**：double claim（幂等）/ unauthorized takeover（message type 拒绝）/
  unauthorized reassign（capability 缺失拒绝）。
- **Lease**：stale lease / expired lease（不再派发）/ late result（fencing 拒绝）/
  migration（version+1、旧 token 失效、旧 session 不可复用）。
- **Resource**：same file write-write / overlapping directory / different workspace
  / read+read / read+write / write+write / exclusive-write vs anything。
- **Collaboration**：valid message / wrong recipient / wrong task / stale assignment
  message / control-like message（type 拒绝）/ duplicate / out-of-order /
  post-terminal message。
- **Cross-vendor**：OpenCode→WorkBuddy CN（预期 CN 401 的诚实路径）/ OpenCode→
  WorkBuddy Intl / WorkBuddy→Codex / Codex→OpenCode；先用 fake providers 验证
  contract，再扩展 `npm run e2e:native`。

## 21. External References（reuse first）

| 机制 | What exists | 解决什么 | 我们复用什么 | 不复制什么 |
|---|---|---|---|---|
| OpenAI Codex App | 多 Agent 并行 + 独立 thread/worktree | 并行改码的隔离 | worktree-per-task 形态确认（与 WorkspaceManager 现状一致） | 其闭源编排/云端会话管理 |
| OpenAI Agents API | 主 Agent 拆分独立 subagent、独立 context、并行执行 | context 隔离、并行 | ContextPacket 的"独立 context"原则 | 其 handoff-as-control 语义（本架构中 control 只属 Control Plane） |
| Claude Code Agent Teams | shared task list + dependency 自动解锁 + mailbox + lead agent | Agent 间任务协调 | mailbox 的**信息平面**设计；task list 的 dependency 解锁 | teammates 自主 claim task 的控制权模型（本架构中 claim 永远经 Assignment） |
| AutoGen GraphFlow | 显式 DiGraph 控制流 + message filtering | 信息过滤省 token | "Message Graph ≠ Execution Graph" 的过滤思想 | 把控制流放进了 message 图（本架构二者分离） |
| OpenHands | event-stream + workspace 隔离 + stuck 检测 | 执行隔离与可观测 | event-log 式审计思想 | 其 Python runtime / 事件即状态 |
| A2A (Google) | Task/Message/Artifact/AgentCard 五对象 + JSON-RPC | 跨厂商互操作 | §16 的映射表（Artifact=immutable output、Task lifecycle 分期） | 直接采用其传输层（未来适配，不混入内部契约） |
| ACP | agent↔client session/cwd transport | session/cwd 语义 | session/cwd 映射 | — |
| MCP | tool/context 平面 + Tasks 异步状态 | tool 平面 | "tool 平面与协作平面分离"的边界 | 把 MCP 当协作协议 |
| Fables | bounded handoff / advisor / compact context | 交接有界化 | compact-context 与 advisor 的思路 | 其 runtime |

## 22. Explicit Non-Goals

```text
always-on agents
24/7 execution
persistent autonomous goals
background autonomous task discovery
Agent self-management
Agent self-spawn (unlimited)
Agent-created organizational hierarchy
infinite auto-rework / auto-replan / auto-retry
Collaboration Bus / message daemon（R2-0 只定义 contract）
第二套 Assignment / Planner / Decision / Scheduler / Verification
```

本项目仍是：`User → Laya → DAG → Execution → Review → Human Gate → END`（bounded）。

## 23. R2 Implementation Sequence（建议，不在本轮执行）

1. **R2-1 Workspace / Resource Safety**：ResourceClaim registry（WorkspaceManager
   方法面）+ write 准入检查 + integration-task 语义 + changedFiles 派生。
2. **R2-2 Lease / Fencing**：AssignmentLease 记录 + fencingToken 进 RunResult 校验
   （挂 applyRunResult 的 agent-mismatch 旁）+ renew policy。
3. **R2-3 CollaborationMessage**：envelope 类型 + Workbench 信使 + Context Gate
   过滤 + audit（无 daemon；投递在 cycle 边界）。
4. **R2-4 Packets**：ContextPacket/EvidencePacket/ConflictPacket 类型 + Handoff v2
   字段（changedFiles/tests/decisions/unresolved）。
5. **R2-5 Cross-vendor E2E**：fake providers → 真实 4-agent 矩阵。


---

## 24. Agent Admission / Extension Contract（R2-0 Amendment）

### 24.1 Canonical Principle

> **Adding an Agent adds a worker identity, not a new workflow.**
>
> 新增 Agent 只能扩展 Worker Pool / Agent Capability，不得改变现有控制面、
> 工作流和 authority 边界。

### 24.2 Admission Pipeline（contract，非 onboarding runtime）

```text
New Agent
   ↓
Agent Admission
   ↓
Canonical Agent Identity
   ↓
Adapter / Capability registration
   ↓
Existing Spawn Gate
   ↓
Existing Assignment
   ↓
Existing Scheduler
   ↓
Existing Workspace / Resource Contract
   ↓
Existing Collaboration Contract
   ↓
Existing Execution Round
```

### 24.3 最低身份契约

每个新增 Agent 至少声明：`agentId`（canonical machine identity）、`displayName`
（presentation）、`adapter`、`capabilities`、model/session capabilities、workspace
capabilities、communication capabilities、availability/auth state。

继续沿用 R1-1：**`agentId ≠ displayName`**——不得用 display name 作为 machine
identity。

### 24.4 不获得新的 Control Authority

新增 Agent 默认只能是既有 capability consumer（Worker / Reviewer / Researcher /
Executor）。无论名字或模型能力多强，都不自动获得 Planner / TaskStore authority /
Assignment authority / Scheduler authority / Execution authority / Verification
authority / Decision authority——除非未来明确修订 canonical authority contract。

> **"模型更强" ≠ "控制权限更高"。**

### 24.5 必须进入现有任务链

```text
Laya → Planner/Task DAG → Assignment → Spawn Gate → Scheduler → Native Agent
```

禁止：New Agent → 自建 task list → 自建 dispatcher → 自己 claim → 自己 spawn。
不允许 Agent 因新增身份绕过 TaskStore / Assignment / Scheduler。

### 24.6 禁止平行 Authority

新增 Agent 不得附带或创建：Second Planner / Second Scheduler / Second Dispatcher /
Second Assignment Engine / Second Decision Engine / Parallel Executor /
Collaboration Engine / Resource Scheduler / Message Planner / Workflow Engine /
Message Daemon / Autonomous Agent Manager。

外部 Agent 原生提供这些能力的（native subagents、内部 planning、internal tool
routing、internal sessions、skills、internal worktree、model switching）：一律视为
**Native Agent internal implementation**——

> Native capability can execute inside the assigned boundary; it cannot escape the
> assigned boundary.

本项目不重新实现它们，也不把它们提升为 Orchestrator Control Authority。

### 24.7 Resource Contract 适用

新 Agent 默认不获得整个 repository / workspace / 所有 Task / 所有 context。必须走：

```text
Assignment + AssignmentLease + ResourceClaim + Workspace
```

规则：parallel read 按 claim；parallel write 默认 isolated workspace/worktree；
shared mutable workspace 除非显式 policy 允许，否则禁止。新 Agent 不能绕过
ResourceClaim 自行决定文件范围。

### 24.8 Collaboration Contract 适用

无论厂商（OpenCode / Codex / WorkBuddy CN / WorkBuddy Intl / Future Agent X/Y），
Agent→Agent 通信一律使用统一的 CollaborationMessage / ContextPacket /
EvidencePacket / HandoffPacket / ConflictPacket。禁止 Agent X proprietary mailbox /
proprietary control channel / direct takeover API / private reassignment protocol
——除非该能力完全封装在 Native Agent 内部且不改变 Orchestrator authority。

Agent message 仍只能表达 informational/request 类（R2-0 §9.2 词表）；
assign/reassign/complete/approve/cancel/override/change_owner/change_dependency/
release_lock 不能经 message 生效——新 Agent 同样适用。

### 24.9 Context Gate 适用

新 Agent 默认只见：own task context、shared project constraints、authorized
ContextPacket / EvidencePacket / HandoffPacket。**Capability elevation ≠ Context
elevation**——"高级 Agent"不会自动获得 all transcripts / all tasks / all sessions /
private context。可见性仍由 Context Gate / existing control contract 决定。

### 24.10 Bounded workflow 适用

新 Agent 加入后 workflow 保持：User → Laya → Task DAG → Assignment → Scheduler →
Native Agent Execution → Evidence → Codex Review → Human Gate → END。

禁止经新增 Agent 引入：always-on / 24/7 / persistent autonomous goal / background
autonomous task discovery / infinite rework / infinite replan / infinite retry /
Agent self-management / 无界 self-spawn。**新 Agent 的加入不能改变"Execution Round
是有界的"这一产品语义。**

### 24.11 Agent Capability Profile

区分七类声明：execution / review / research / workspace / session / communication /
model capabilities。声明用于 Laya routing、Assignment compatibility、Spawn Gate、
Resource policy、Context policy——但 capability 只是"能做什么"：

```text
can_edit_repository = true   ≠   can_reassign_tasks = true
```

### 24.12 统一 Admission 安全检查

新增 Agent 至少经过：Identity Check → Capability Check → Adapter Check →
Auth/Availability Check → Spawn Gate → Assignment → Workspace/Resource Claim →
Collaboration Contract compatibility。任一不满足：

```text
Agent may exist in registry, but cannot be dispatched.
```

不伪造 availability——**真实事实 ≠ 乐观假设**（R1-1 的 WorkBuddy CN 401 即先例）。

### 24.13 扩展不修改既有 Task DAG 语义

添加 `FutureAgentX` 不改变 Task / Dependency / Parallelism / Assignment / Terminal
states / Verification / Human Gate。它只是增加一个可选执行者：

```text
Task T101
 ├─ OpenCode
 ├─ Codex
 ├─ WorkBuddy CN
 ├─ WorkBuddy Intl
 └─ FutureAgentX
```

最终 assignment 仍由 Laya / Planner / Assignment / Scheduler 决定。

### 24.14 协议统一原则

不允许 "OpenCode 用 full coordination protocol，Future Agent 因为特殊而绕过"：

```text
Agent N = another worker identity
NOT     = Agent N = special privileged agent
```

除非用户明确要求并经架构设计与审查新增 authority。

### 24.15 Compatibility / Migration

未来新增 Agent 不得要求修改既有 Agent 的协议。优先做：Agent Adapter / Capability
Mapping / Protocol Mapping / Workspace Mapping / Session Mapping——而不是改全局
TaskStore / Scheduler / Assignment / Execution Round。目的：加一个 Agent 不应导致
整个 workflow 回归测试与架构边界一起变化。

### 24.16 Admission 生命周期（contract only）

```text
discovered → registered → capability-validated → available → dispatchable
           → assigned → executing → terminal
```

installed + authenticated 但不满足 capability / Spawn Gate / resource constraints
⇒ `not dispatchable`。**"存在"与"可以执行"是两个状态，不得混用。**

### 24.17 Architecture Invariant

> **N 个 Agent 仍然只有一套 Control Plane。**

```text
1 Control Plane
N Worker Identities
1 Execution Model
1 Assignment Model
1 Resource Contract
1 Collaboration Contract
```

而不是 `N Agents = N Task Managers / N Schedulers / N Workflows`。这是本项目未来
扩展 Agent 时必须保持的不变量。

### 24.18 Admission 测试契约（R2 测试矩阵增补）

新增 Agent 必须通过统一 admission/compatibility tests：

- **Identity**：agentId 唯一；display name 不作为 canonical identity。
- **Authority**：cannot self-claim / self-reassign / override TaskStore / bypass
  Scheduler。
- **Spawn**：必须通过 Spawn Gate。
- **Resource**：必须获得 ResourceClaim + Workspace；parallel writer isolation
  enforced。
- **Communication**：valid CollaborationMessage 投递；invalid control message
  拒绝；stale assignment 拒绝；wrong recipient 拒绝。
- **Context**：unauthorized context denied。
- **Lifecycle**：bounded execution → Human Gate → END。
- **Cross-vendor**：至少与一个现有不同厂商 Agent 完成 contract-level
  interoperability test。

### 24.19 External Reference

外部系统（OpenAI Codex App / OpenAI Agents API / Claude Agent Teams / AutoGen
GraphFlow / OpenHands / A2A / ACP / MCP / Fables）的引用沿用 §21；本 amendment 的
要点不是复制它们的扩展方式，而是明确：**它们的 Agent 扩展模式不能自动改变本项目的
Control Plane。**

### 24.20 Explicit Non-Goal（本 amendment）

本 Contract 不负责实现新 Agent。它负责确保：**未来无论新增多少 Agent，都必须进入
同一个受控协作框架，而不会产生平行工作流或 authority 分裂。**

---

## R2-1 Implementation Status（2026-10-02）

R2-0 是 design-only 契约。本节只记录 **R2-1 已实现的部分**，不重写上文任何契约。

### Implemented

| 契约条目 | 落点 | 状态 |
|---|---|---|
| §7 ResourceClaim 记录形状 | `src/orchestration/resource-claim.ts` `ResourceClaim` | DONE |
| §7.1 claim 由既有 workspace authority 持有 | `WorkspaceManager.claimResource` / `resourceConflicts` / `releaseResourceClaims` —— **既有 authority 的新方法** | DONE |
| §7.2 冲突矩阵（纯函数） | `claimsConflict()`，可交换、同 task 自我不冲突 | DONE |
| §7.3 dispatch 前准入检查 | `Orchestrator.executeTask`，**紧接 5C-6 workspace 检查、runtime.run 之前** | DONE |
| §7.3 同 task 同 scope 幂等 | `ResourceClaimBook.claim()` 返回既有 claim（`created: false`） | DONE |
| §8 parallel write 默认 isolated | `WorkspaceManager.mayShareWorkspace()` + `orchestrator round` 的 `workspaceMode` 解析器 | DONE |
| §8 parallel read-only 可共享 | 同上（`read` + parallel 允许 shared） | DONE |
| scope 归一化 | `normalizeScope()`：relative/absolute、`/` vs `\`、trailing sep、`.`/`..` | DONE |
| `resource-conflict` typed refusal | 新增于 `WORKSPACE_ERROR_CODES`，reason 明确「不是 agent failure」 | DONE |
| production 接线 | `orchestrator round` 构造真实 `WorkspaceManager`（此前**完全没有**） | DONE |

### 决策记录

- **Windows 大小写**：比较键在 win32 上折叠为小写，因为该平台文件系统默认大小写不敏感；
  POSIX 保留大小写，否则会把两个真实不同的路径误判为冲突。依据是本项目实际的
  filesystem 语义（CLI 自身 `normPath` 亦仅在 win32 折叠），不是假设 Linux 行为。
- **read+write 允许**：按 §7.2 原样实现，并**保留其诚实前提** —— reader 确实可能读到半写入状态；
  该一致性应由 Laya 在 DAG 中表达依赖，而不是靠 claim 阻塞。本层不假装提供它没有的保证。
- **claim 在 run 结束时释放**，而不是 task 进入 terminal 时：`to_verify` 的 task 已不再写入，
  继续持有会无谓阻塞其他 writer。释放不删除任何 artifact —— review 需要的是 workspace 与 evidence。
- **`leaseVersion` 仅预留**：`null` 表示「尚无 lease 系统」（R2-2）。字段形状与冻结契约一致，
  但**未实现** fencing，也未据此做任何校验。

### Not implemented（明确留到后续阶段）

- **R2-2 Lease / Fencing**：`AssignmentLease` / `leaseVersion` 递增 / `fencingToken` 运行时校验
- **R2-3 CollaborationMessage**：envelope 运行时、投递、Context Gate 过滤
- **R2-4 Packets**：`ContextPacket` / `EvidencePacket` / `ConflictPacket` 运行时
- **A2A / ACP transport**
- 隐式 merge engine：**Integration Task 是普通 Task**（Planner 产生，走 Assignment/Gate/Scheduler），
  本轮**未实现** integration 语义，只保证没有把它藏进 Scheduler / WorkspaceManager
- symlink policy（当前代码无相关机制，未自行引入）

### 权威影响

```text
new authority        = 0   （claim 由既有 WorkspaceManager 持有）
new scheduler        = 0
new dispatcher       = 0
new execution edge   = 0   （src/ 内 runtime.run( 仍只在 orchestrator.ts）
new Agent            = 0
```

TaskStore / Assignment / Scheduler / SessionRegistry / Execution Edge / Verification /
AttemptStore / Laya Decision 语义全部未改。

---

## R2-1 Final Implementation Note（R2-1.1，2026-10-02）

R2-1 的第一版实现经 Codex 独立 review 判定 `PASS WITH FINDINGS`（P0=0, P1=2, P2=2）。
本节记录 findings 的修复。**上文 R2-0 契约未做任何改动** —— 实现与契约冲突时改的是实现。

### P1-a：跨 workspace 的 whole-workspace 假冲突（已修）

`scopesOverlap()` 原先对 `workspace` / `repository` scope 无条件返回 overlap。
而 round 给每个 write task 声明 whole-workspace claim，于是 **workspace-A 与 workspace-B
也被判为冲突**，把本该并行的 isolated writers 错误串行化。

这不是理论问题：R2-1 的生产 round 实测 3 个 child、并发上限 2，却只调度了 1 个。

契约 §7.2 原文是 "match everything inside **themselves**" —— 作用域是 workspace 本身。
修复后：

```text
workspace vs workspace   -> overlap 当且仅当 workspaceId 相同
repository vs repository -> overlap 当且仅当 repoRoot 相同
whole-X vs path          -> overlap 当且仅当 path 位于 X 的 root 之下
whole-X vs whole-Y       -> 不同容器，永不 overlap
```

`workspace` scope 因此新增 `root` 字段：没有 root 就无法判断"在它里面"，而把无法证明的
重叠当成冲突，正是 P1-a 本身的错误。**Orchestrator 用 prepare 出来的 workspace.cwd 回填
root**，因为那是 agent 真正会收到的目录。

两个 worktree 是同一个 repo 的两个不同目录，所以它们**不是**同一个 repository scope。

### P1-b：non-Git + parallel write 的 admission 旁路（已修）

原实现：`if (this.workspace !== null && this.resourceClaims !== null)`。non-git 项目下
`workspace === null`，于是**整个 resource admission 被跳过**，parallel writer 直接在
shared cwd 执行 —— 正是本层要防的事。

修复后 admission **不再因缺少 workspace 而跳过**：

```text
read / 只读任务     + non-git -> 允许（共享目录读取是安全的）
write/exclusive    + non-git + 有并行工作 -> resource-unavailable，admission 拒绝
write/exclusive    + non-git + 无并行工作 -> 允许
write + git 隔离可用                        -> 允许（证明拒绝原因是缺少隔离，而非写入本身）
```

新错误码 `resource-unavailable` 与 `resource-conflict` 分开：前者是"没有安全容器"，
后者是"别人占着"，两者是不同事实。两者都是 **admission 拒绝，不是 agent failure**，
都**不触发** retry / reassign / replan / 换 Agent。

本轮**未**引入 `allow-shared-write` 之类的新配置开关。

### P2-1：claimId 覆盖（已修）

原 `claimId = claim:${taskId}:${workspaceId}` 不含 scope，同一 task/workspace 的第二个
scope 会产生**相同 id**，`Map.set` 直接**覆盖**第一个 —— 原 scope 的冲突保护静默失效。

claim identity 现在包含 mode 与 normalized scope：

```text
claim:${taskId}:${workspaceId}:${mode}:${scopeKey}
```

§7.3 幂等性保持不变（同 task/workspace/mode/scope 重复 claim 返回既有 claim）。
新增**按 scope 精确释放** `releaseClaimForScope()`：释放 A 不会连带删掉 B。

### P2-2：真实 Native E2E（已补）

`tests/native-agent-e2e.test.ts` 新增 **Case 16**，用真实 `WorkspaceManager` +
真实 OpenCode agent + 真实 git worktree 验证六项事实：

```text
1 真实 native agent 确实执行
2 RunRequest.cwd 是 isolated workspace（不是 project root）
3 agent 写入 R21-ISOLATION-PROOF.txt，内容恰为 R2-1-ISOLATED-WORKSPACE
4 proof file 存在于 isolated workspace 内
5 project root 没有出现该文件
6 workspaceId / branch / baseSha / mode 均与 root 不同（branch=orch/task/writer）
```

Case 16 **独立报告**，Case 15 的结果不能覆盖它。
agent 是否额外执行了 `git commit` 被记录但**不作为判定条件** —— 那是 agent variance，
与 workspace isolation 无关（Case 15 栽在同一处）。

### 权威影响（R2-1.1 后）

```text
new authority = 0   new scheduler = 0   new dispatcher = 0
new runtime execution edge = 0          new Agent = 0
```

### 仍未实现

R2-2 Lease/Fencing · R2-3 CollaborationMessage · R2-4 Packets · Context Gate ·
A2A/ACP · 隐式 merge engine · 长期持久 workspace

---

## Temporary Execution Monitor（Observability Only · 2026-10-02）

临时前端（`temporary-dashboard/`）在**同一个页面、同一个窗口、同一个启动方式**下增加了一块
Execution Monitor。它不是一个新系统；本节的目的是把边界写死，避免它以后被当成控制面。

```text
round 进程（持有 live TaskStore / WorkspaceManager / claims）
   │  WRITE ONLY   $ORCH_HOME/round-state.json + round-events.jsonl
   ↓
bridge（既有轮询 + SSE）
   ↓  READ ONLY
既有 temporary dashboard 页面（新增面板，其余不变）
```

| 属性 | 事实 |
|---|---|
| read-only | 页面无控制按钮；bridge 只有 `GET`（`/api/snapshot`、`/api/monitor`、`/health`），代码中不存在 assign / reassign / retry / cancel / spawn / approve |
| best-effort | round 每次发布都包在 try/catch 内，失败返回 `ok:false` 并被吞掉；`--observe` 默认 OFF，不给则该路径一行都不执行 |
| non-authoritative | 读模型 `execution-monitor.ts` 是**纯派生**：type-only import、零 I/O、不缓存、不 transition、不 claim、不 prepare、不 dispatch；任务状态原值来自 TaskStore |
| same dashboard | 未新增窗口 / dashboard server / 前端工程 / 端口 |
| no control capability | 观测单向：round 只写、页面只读，页面无法回调执行 |
| no runtime authority | `runtime.run(` 仍只有 1 处（`orchestration/orchestrator.ts`）；R2-1/R2-1.1 admission 块的位置与语义未动 |
| 缺失即如实 | 读不到的字段为 `null`/`unknown`（例：`to_verify` 阶段的 run duration，store 并未记录结束时刻），观测缺失时显示 `LIVE DATA DISCONNECTED`，不伪造成空任务板或 0ms |

失败隔离是硬要求：**dashboard 不可用 ≠ 执行失败**。观测缺省、写盘失败、解析失败都只能降级显示，
不得影响 Scheduler / Task / runtime / Native Agent。

这与 §24 的 Agent Admission 一致：新增 Agent 只会多出一个由 `agentId` 派生的 worker identity
（UI 不按 agent 名字分支），不产生新工作流。

---

## Decision Loop Execution Result Contract（指针 · 2026-10-02）

`runDecisionCycle` 的 `tick/results` 在 capability injection 下是 dead-path
（内部 `dispatch` closure 被 spread 进来的 `capabilities.dispatch` 覆盖，
`outcome.tick` 恒为 `null`）。R1-1 把它记为技术债；现在它已上升为一份正式契约：

> **`docs/DECISION_LOOP_EXECUTION_RESULT_CONTRACT.md`**

该契约定义了 Decision → Dispatch Receipt → Attempt → Execution Result → Observation 的唯一事实链，
并明确：`AttemptStore` 是 execution evidence 的唯一存储（**不得**新增
`ExecutionResultStore` / `DispatchResultStore` / `RoundResultStore` / `DecisionResultStore`）。

> **R2-2 Lease / Fencing implementation must follow this contract.**

具体地，R2-2 必须遵守该文件 §12 的接口前置条件，其中最关键的一条：

```text
fencing check should sit here:
  Orchestrator.applyRunResult（orchestrator.ts:575）
  + 覆盖 executeTask 内另两条同样会 mutate 的失败分支（orchestrator.ts:966 / :973 相邻路径）
```

理由（源码级）：`applyRunResult` 已经是唯一把 `RunResult` 变成 task 状态的入口
（全仓调用点 1 处），并且**已经**在做同类所有权校验（`agent-mismatch`，`orchestrator.ts:580`）。
fencing 是这条检查的延伸，不是新机制；拒绝形状复用 `MutateOutcome.ok=false` + `code`。

本指针不重写 R2 契约的任何既有条款；R2-1 / R2-1.1 的 workspace / claim 语义不受影响。


