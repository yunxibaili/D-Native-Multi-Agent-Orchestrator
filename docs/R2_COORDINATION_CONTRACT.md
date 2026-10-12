# 协作契约 — Lease、资源与工作区

更新日期：2026-10-12
状态：既有有效约束的整理，不代表本轮重新审核或新增实现。
历史 R2 设计/实现记录已保存在 Git 归档。
当前阶段与授权只在唯一 [项目基线](PROJECT_BASELINE.md) 维护。

## 1. Authority

TaskStore 拥有 Task 状态；Assignment 拥有 Worker 绑定/迁移；
SessionRegistry 拥有会话；AttemptStore 记录执行证据。
资源、Lease 和 Workspace 复用既有对象，不建立第二个调度器或 WorkerManager。
LAYA 决定任务级意图，Agent 不自行 claim/takeover；协作消息不是执行授权。

## 2. Lease 与 fencing

Assignment 签发/激活/更新/撤销/过期 Lease，保持版本与 fencing token 的既有约束。
任何结果写回、任务终态和重分配都校验当前身份与有效租约。
旧执行即使晚到，也不能推进新拥有者的任务状态。
外部物理执行已发生但写回被拒绝时，保留真实 Attempt/evidence，
不能把“拒绝写回”改写成“根本没启动”。

Lease 失效不等于进程树已经停止。停止未确认时不能只释放逻辑 Lease 就开放新写者。

## 3. ResourceClaim

Claim 表达资源范围和 READ/WRITE 兼容性，挂靠既有 Task/Lease。
重叠写入需拒绝或等待，不通过提示词声明“各写各的”解除实际冲突。
取消、deadline、handoff、rework 和 drain 统一经过既有清理/释放流程。
物理停止无法证明时，保留保护并按现有 quarantine 路径处理，不假称干净。

## 4. Workspace

优先复用 WorkspaceManager 的 isolated worktree。shared mutable workspace 并行写不开放。
不同 worktree 是不同工作目录，不是独立 Git 仓库；refs、config 和 metadata 可共享。
涉及共享 Git 状态的操作必须按资源与用户授权约束处理。
清理只处理当前运行实际拥有、绝对路径经过边界校验的资源，不全局枚举/清除他人目录。
PARALLEL_WRITE=CLOSED；测试成功或文档更新不能自动改变此状态。

## 5. Context、Collaboration 与 Evidence

跨 Agent 内容是信息，不是任务认领、重新调度或授权命令。
Context packet 传递当前目标、输入、约束和必要材料；
Evidence packet 传递有来源的变更、测试、结果和不确定性。
Memory/工具结果/外部消息不获得 TaskStore 或决策权。
请求能力与实际能力、Agent 声称与机器观察、执行事实与验证结论保持分离。

## 6. Handoff

保持同 Task，新 Attempt/Lease；Agent/Model/Session 变化遵守身份契约。
旧有效写入者停止或被隔离后，才允许新有效写入者继续。
接力是有界的，受用户模型规则、费用、能力和数据政策约束。
不可恢复的 native session 不伪造兼容性，使用有来源的工作检查点继续。
固定选择约束必须覆盖动态新增和重规划的子任务；不能在后续 reassign 时静默丢失。
模型执行中断时先保留部分成果与真实原因，停止未确认不得把重试/接力当作无副作用的再次调用。

### 6.1 跨角色任务与同目标协作组

不同职责或组成员使用独立 child task、会话与执行证据；父容器不复制为多个同时运行的 Worker。
调研报告、实现产物与测试结果通过既有 context/brief/handoff 交接，接收信息不等于收到执行授权。
下一片先顺序执行；同目标多人共建后续沿同一 DAG/保护链补集成责任。
不同文件范围不能代替 Workspace/Claim/共享 Git 元数据约束，PARALLEL_WRITE 继续 CLOSED。
全部成员 terminal 只表示收齐结果，仍需现有 Verification 判定交付是否满足。

## 7. Agent Admission

复用 adapters/index.ts 工厂表、discover、doctor 和统一 capability/admission 路径。
新增 Agent 是新增受约束执行能力，不是新增工作流或新的 authority。
installed、authenticated、available、model-listed、callable 和 isolated 是不同事实。
现有 false/shared-only 能力声明保留，真实验证前不能抬升。
Skill/MCP 的新增候选事实需明确契约，不能滥用旧 skills boolean。

## 8. 参考

- [架构契约](ARCHITECTURE_CONTRACTS.md)
- [Round 语义](EXECUTION_ROUND_SEMANTICS.md)
- [执行证据](DECISION_LOOP_EXECUTION_RESULT_CONTRACT.md)
- ../src/orchestration/assignment-lease.ts
- ../src/orchestration/resource-claim.ts
- ../src/orchestration/workspace.ts
- ../src/orchestration/worker-identity.ts
- [旧设计和历史审核](STAGE_ANALYSIS.md#历史备份)

准确的状态枚举、转换和错误码以这些现有源码与对应测试为准；
本文不以简化文字替代细粒度校验。
