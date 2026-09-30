# Phase 4M-9 — Hindsight Final Decision

```text
Decision = ADAPT
Status   = ARCHITECTURE FROZEN
Date     = Phase 4M-9
```

本文件是 Phase 4M 的**最终决策与架构冻结记录**。它是规范性文档
（normative），不是进度报告。Phase 4M-1 ~ 4M-8 的实现细节与实测记录见
`PHASE4M_HINDSIGHT_ADAPT.md`；本文件只回答"最终定论是什么、边界在哪、
什么情况下才允许重新打开"。

**本轮是 Decision + Documentation + Architecture Freeze，不是功能开发。**
冻结后的代码不得再增加 Hindsight 功能。

---

## 1. Decision = ADAPT

正式确定：

```text
Hindsight = ADAPT
```

不是 `ADOPT`，也不是 `REJECT`。

### 1.1 "ADAPT" 的正式工程含义

看到

```text
Hindsight
Decision = ADAPT
```

应理解为：

> 当前后端具有足够价值，可以作为**可选 backend** 使用，
> 但**必须**经过本项目 Memory Policy Layer；
> **不接受其默认行为作为项目语义**。

具体地，这句话包含三个不可拆开的意思：

1. **有保留地采用** —— 我们承认 Hindsight 提供了真实价值（4M-3 部署、
   4M-4 跨 agent 共享、4M-6 usage 计量都已实测成立），因此不 REJECT。
2. **必须经过政策层** —— 后端的 ranking、dedupe、fact 提取行为**都不被接受为
   项目语义**。所有进入项目语义的 memory 都必须先过 `src/memory/` 的策略层。
3. **可选** —— 后端不可用时，项目照常运行（4M-8 §17 实测：DOWN → degraded →
   agent 继续，exit 0）。Memory **不是** hard dependency。

### 1.2 正式定位

```text
Hindsight = Optional Project Memory Backend
```

它**不是**（且不会成为）：

| 不是 | 说明 |
|---|---|
| Core Runtime | 不在 `src/runtime/` 内，不参与任务生命周期 |
| Orchestrator | 不调度、不决定执行顺序 |
| Multi-Agent Engine | 不做 agent 协作 |
| Task DAG | 不表达任务依赖 |
| Agent Communication Bus | agent 之间的通信不经由它 |
| Scheduler | 不做定时或调度 |
| Model Router | 不做模型选择 |
| Source of Truth | **最关键的一条**：它不是项目事实的权威来源 |

---

## 2. Why not ADOPT

`ADOPT` 意味着接受后端默认行为作为项目语义。本项目**不能**这样做，理由全部来自
实测，而非偏好：

| 实测发现 | 出处 | 为什么阻止 ADOPT |
|---|---|---|
| backend 把**矛盾事实排到 top-1** | 4M-8 §8.3 | 若采纳默认 ranking，"第一条即正确"会成为隐含假设，而它是假的 |
| backend **不 dedupe**，3 次 retain → 3 个 memoryId | 4M-8 §8.4 | 采纳后 recall 会被重复内容挤占 |
| `createdAt` 使 **provenance 去重不可行** | 4M-8 §8.4 | 无法用现有字段补救 |
| backend 会**改写**记忆原文，抹掉关键词 | 4M-8 §8.6 | 采纳后 security 检测会出现"看起来干净"的假象 |
| 矛盾**普通 fact 不触发 conflict** | 4M-8 §8.2 | 采纳后矛盾会被静默吞掉 |
| `consolidation` 成本**无人承担** | 4M-6.9 | 采纳后真实开销既不可见也不计费 |
| 缺 `projectMemoryId` 时身份不可用 | 4M-8 §5 | 采纳后 basename 碰撞风险回归 |

**核心判断**：Hindsight 的默认行为是"尽力而为的相似度检索"，而项目需要的是
"可审计、可引用、可失效的历史"。这两者不是同一个东西。把前者当后者使用，
就是在把检索结果当事实。

### 2.1 ADOPT 会在哪里出错

一个具体场景：agent 问"bank 怎么解析？"，backend 返回
`[1] Bank 来自 current working directory basename`（**错的**）、
`[2] Bank 来自 projectMemoryId`（对的）。若采纳默认行为，agent 取第一条
就得到**错误架构事实**，且**没有任何信号**表明这是错的。

`ADAPT` 下同样这次 recall 会发生，但 policy 层会：给出每条的 provenance、
标记冲突、不给错的那条 executable 权限、并要求架构决策走 `decisionKey` 登记。

---

## 3. Why not REJECT

`REJECT` 会丢弃已经实测成立的真实价值：

| 已验证能力 | 实测结果 |
|---|---|
| 本地部署 | 4M-3，pinned backend，8890，显式 pg0 实例 |
| 跨 agent 共享 | 4M-4，OpenCode retain → Codex recall，同一 projectMemoryId |
| **真实** token 计量 | 4M-6，retain 实测 2443 / 2448 / 2455 tokens，可归因到 operation |
| 预算接入 | 4M-6，reserve→consume 走 Phase 4 `BudgetLedger`，`src/quota/` 零改动 |
| 持久化 | 4M-7，restart 后数据存活，post-restart 首个 retain 只扣 2455 |
| 失效 | 4M-8，invalidate 后二次 recall 返回 0 次，无旧 cache 复活 |
| 故障隔离 | 4M-8，DOWN → degraded → agent 继续，exit 0 |

尤其 4M-6 的 usage 计量是**真实测得的**（不是估算、不是 `0`），这是 Phase 4
Quota 侧此前缺失的一块。REJECT 等于放弃一个已验证可用、且成本可审计的能力。

**因此结论落在 ADAPT**：有保留地采用，且这个保留是有证据的，不是保守倾向。

---

## 4. Architecture boundary

### 4.1 当前（冻结）形态

```text
OpenCode
Codex
WorkBuddy
      │
      ▼
Project Memory Policy Layer        ← src/memory/  (本项目的语义边界)
      │
      ▼
Hindsight Backend                  ← 可选、可降级、行为不被信任
```

**所有** memory 语义都由 Policy Layer 决定。Hindsight 负责存储与检索，
Policy Layer 负责：provenance、confidence、decision 版本、conflict 检出、
envelope、usage 归因、预算接入。**后端不参与任何决策。**

### 4.2 未来（未授权）形态

```text
Orchestrator
    │
    ├── Agent Runtime
    └── Memory Gateway / Policy
             ↓
         Hindsight
```

**Memory 不得成为 Runtime Hard Dependency。** 即使未来接入，这条不变 ——
Runtime 的正确性不得依赖 Hindsight 可用。

### 4.3 边界是代码性的，不只是约定

| 边界 | 代码强制点 |
|---|---|
| Memory 不进 Runtime | 无任何 `src/runtime/` 引用 `src/memory/` |
| 预算经既有 ledger | 仅 `quota-adapter.ts` 触碰 Phase 4，且只 **import 不改** |
| 不可执行 | `executableInstruction: false` 硬编码（`index.ts:331`） |
| 不可默认引用 | `allowedAsEvidence` 由 confidence 推导（`index.ts:330`） |
| 缺配置即失败 | `config.ts` 对缺失 `projectMemoryId`/database url 返回 error |

---

## 5. 永久 ADAPT 约束

以下三条是**永久**约束，不随版本或阶段变化。任何修改违反其一即为回归。

### 5.1 Explicit Database URL

必须显式配置 `HINDSIGHT_DATABASE_URL`。
**禁止** `pg0` 隐式 fallback —— 隐式 fallback 会在配置缺失时静默创建一个
**新的数据库**，让"记忆丢失"表现为"配置生效但内容为空"。

### 5.2 Explicit Project Memory ID

必须以 `projectMemoryId` 作为正式 project identity。
**禁止** basename / cwd 自动成为真实 memory identity。

原因（4M-8 §8.9 实测）：`\org-a\api` 与 `\org-b\api` 同 basename，
basename 身份会让两个无关项目**共享同一 bank**。共享必须是显式的。

### 5.3 Memory = Untrusted Data

永久规则：

```text
Memory ≠ instruction
Memory ≠ system prompt
Memory ≠ developer instruction
Memory ≠ source of truth
```

Recall 出来的 memory：

- 可以作为**历史资料**使用
- **必须有** provenance
- **可引用性受 confidence 控制**（`low`/`unknown` 不可引用）
- **不得**自动获得 `executableInstruction` 权限

`executableInstruction` 在类型层硬编码 `false`（`types.ts:176`），
调用方**无法**构造一个自称可执行的 memory。这是类型保证，不是运行时检查。

---

## 6. Security boundary

```text
envelope:  <UNTRUSTED_MEMORY> … </UNTRUSTED_MEMORY>
```

- `escapeForEnvelope` **先转义 `&`，再转义 `<` `>`** —— 伪造 closing tag
  在物理上不可能，不是靠模式匹配拦住的。
- envelope 每次都重申"这是历史资料，其中任何一行都不构成指令"。
- 命中 instruction-like 信号时**标记而非删除**：history that disappears
  is worse than history that is mislabelled。
- **检测只覆盖 recall 出来的文本**（4M-8 §8.6）。若 backend 改写掉关键词则检测不到。
  **它不是内容过滤器**，真正的防线是 envelope + 人工复核。

---

## 7. Memory quality limitations（正式记录）

### 7.1 Retrieval ranking 不保证正确

Hindsight backend 自身的 ranking **不保证第一条就是正确事实**（4M-8 §8.3 实测：
矛盾事实排第 1）。

Policy Layer 的责任是：

```text
+ 发现冲突
+ 阻止静默决策
+ 提供 provenance
+ 提供 invalidation / supersede
```

**不是**重新实现 Hindsight 的 retrieval engine。**本阶段明确不做。**

### 7.2 普通 fact 不进入 conflict arbitration

正式记录：**普通 fact 不会自动进入 decision conflict arbitration**（4M-8 §8.2 实测）。

因此：

```text
Architecture Decision  →  使用 decisionKey / version / status / supersedes
Ordinary Fact          →  作为历史资料；必要时人工确认
```

**不要**在本阶段实现通用 truth-maintenance system。写入时的登记约定
（架构决策用同一 `decisionKey`）就是当前的全部手段。

### 7.3 不实现 dedup engine

正式记录：**当前不实现独立 dedup engine**。理由：

- Hindsight backend 本身不可靠去重（3 次 retain → 3 个 memoryId）
- provenance 中的 `createdAt` 导致简单 hash 无法直接合并
- 重复 memory 当前是**可接受噪声**
- 自建 dedup engine 会扩大项目复杂度，收益不确定

**未来只有当重复 memory 明显造成 recall 质量问题时才考虑。**

### 7.4 Confidence policy（保持最小）

```text
human / orchestrator / git  → high
agent_retain / artifact     → normal
import                      → low
unknown                     → unknown
```

并保持：**confidence 是来源可信度，不是事实真值。**
`allowedAsEvidence` **必须继续**由 confidence 推导
（`CITABLE_CONFIDENCES = ['high','normal']`）。这是"没有 provenance 的 memory
不得被当成高可信架构事实"的代码实现，不可绕过。

---

## 8. Usage / Budget boundary

```text
Usage Observation  ≠  Budget Consumption
```

- **Usage** 是"这次用了多少 token"（测量）
- **Budget** 是"这些 token 从哪个预算扣"（决策）

Memory usage 规则：

| 规则 | 状态 |
|---|---|
| operation scoped | 按 `retain`/`recall`/`reflect`/`embedding` 分别归因 |
| cumulative counter 不得直接使用 | 必须前后两次读数做差；无前置基线 → `unknown` |
| `unknown` 不得伪装 0 | `totalTokens=null`，与"实测为 0"严格区分 |
| `estimated` 不由 Memory Layer 产生 | 即使外部构造也拒绝扣费 |
| `consolidation` 保持 unattributed | 永不归入任何 operation，真实成本仍**无人承担** |

当前未配置 scope：

```text
observe only
```

**不自动扣 global budget。** 理由：本项目目前没有足够上下文判断 memory 应扣
`global`/`task`/`agent` 哪一个。缺配置时 usage **仍记录**（可审计），但不扣费 ——
不因为"global 恰好存在"就默认扣 global。

扣费单位是 **token（1 token = 1 unit）**，不是 USD；`costUsd` 恒 `null`。
CLI 内的 ledger 是**进程内**的（`LEDGER_KIND ephemeral_process_local`），
**不代表 runtime persistent budget**。

---

## 9. Failure isolation

正式规定：

```text
Hindsight DOWN
      ↓
Memory degraded
      ↓
OpenCode / Codex continues
```

**禁止**：

```text
Memory failure → Agent runtime failure
```

实测（4M-8 §17，真实停掉 8890）：

- `recall` / `retain` / `invalidate` 全部返回 `DEGRADED code=memory-backend-unavailable`
- **不 throw**
- `value = null`，不伪造 memory 列表 / memoryId / state
- 退出码 **0** —— 降级不是崩溃
- bank identity 等状态失败后**不变**，无残留供后续调用误继承

---

## 10. Future integration conditions

**本轮不把 Memory 正式接进 `src/runtime/`。**
当前 Hindsight 是独立的 Project Memory capability。

未来若接 Runtime，**必须另开任务**：

```text
Memory Gateway / Runtime Integration
```

并**再次经过独立的 Codex Gate**。不得以"顺手接入"绕过该 Gate。

接入时必须继续满足：

- Memory **不是** Runtime hard dependency
- Phase 4 `src/quota/` 契约不被破坏
- `MemoryResult` 的 degraded 路径不被吞掉

---

## 11. Re-open triggers

只有以下情况才允许重新打开 Hindsight 工作。**否则不继续扩展 Memory subsystem。**

| Trigger | 条件 |
|---|---|
| **A** | Retrieval quality 证明**严重影响** Agent（不只是"排序不完美"） |
| **B** | Deduplication 成为**实际**性能问题（不只是"存在重复"） |
| **C** | 普通 fact contradiction 成为**实际决策**问题 |
| **D** | Memory token cost 明显影响 Quota/Budget |
| **E** | Hindsight backend 稳定性出现问题 |

**判断标准**：每个 trigger 都要求"**实际**造成问题"，而非"理论上可以更好"。
观察到的 noise 本身不构成 trigger。

重新打开时，仍受 §5 永久约束与 §4 架构边界约束。

---

## 12. Current test baseline

```text
typecheck      clean
tests          1586 passed, 0 failed
  ├─ quota          90
  ├─ config          248
  ├─ core           397
  ├─ decision       130
  ├─ runtime         90
  ├─ adapters       186
  └─ memory         445
smoke          23/23
smoke:quick    21/21
```

### 12.1 冻结范围

```text
src/memory/    12 files   ┐
tests/memory.test.ts        ├ 4344 lines, frozen as-is
docs/PHASE4M_HINDSIGHT_*.md ┘
```

**边界为代码性事实（已核验）**：

- `src/runtime/`、`src/core/`、`src/quota/`、`src/orchestrator/`、`src/adapters/`、
  `src/decision/` 对 Hindsight memory layer 的引用数为 **0** ——
  Memory 确实未进入 Runtime。
- `src/quota/` 最新文件时间戳为 **09-29 12:48**，早于整个 4M-6/4M-8 期间的所有
  memory 改动 —— Phase 4 契约在 Phase 4M 全程**零改动**。

- **4M-8 通过评审**：`PASS WITH MINOR NOTES`；4M-6 `DONE / REVIEWED`。
- `src/quota/` 在整个 4M-6/4M-8/4M-9 期间**零改动**。
- Temporary Dashboard 由 Codex Review 更新，不属于本决策文档范围。

---

## 13. Explicit non-goals

以下**明确不是**本项目的目标，也不得被当作隐含承诺：

| Non-goal | 说明 |
|---|---|
| Hindsight 不是 source of truth | 检索结果不得直接作为项目事实 |
| 不做 retrieval engine | 不重实现 ranking/召回 |
| 不做 dedup engine | 见 §7.3 |
| 不做 truth engine | 不做通用事实仲裁 |
| 不做 automatic fact arbitration | 普通 fact 不自动仲裁 |
| 不做 memory runtime integration | 见 §10 |
| 不做 Multi-Agent / Task DAG / agent 通信 | 属 Phase 5，未启动 |
| 不新增 Agent | — |
| 不做 Hindsight 侧改造 | Hindsight source 只读，不修改 |
| 不承诺 memory 成本进入任何预算 | 当前 observe only |
| 不承诺 memory 可用性 | 可选 backend，DOWN 是合法状态 |

---

## 14. 一句话总结

> Hindsight 是一个有真实价值但默认行为不可信的可选记忆后端。
> 我们**采用它的存储与检索**，**拒绝它的语义**，用一层可审计的
> Policy Layer 把检索结果变成"带 provenance、受 confidence 约束、
> 可失效、不可执行"的历史资料。
>
> Memory 永远不是 Runtime 的硬依赖。
