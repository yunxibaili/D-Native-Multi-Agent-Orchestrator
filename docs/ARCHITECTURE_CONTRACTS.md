# 当前架构契约

更新日期：2026-10-12
用途：保留既有有效约束，并标明新需求的扩展边界；不因整理文档改变运行行为。
事实与阶段见 [项目基线](PROJECT_BASELINE.md)，目标能力见 [后端需求](BACKEND_REQUIREMENTS.md)。
项目基线是唯一当前状态入口；本文定义契约，不独立宣布阶段完成或授权。

## 1. 权威与复用

- LAYA：唯一任务级语义决策者；只在提供的候选/封闭词表内决策。
- Planner：生成/校验候选 DAG，不执行任务或选择未获授权的 Worker。
- TaskStore：任务生命周期权威；Assignment：绑定与迁移准入。
- Scheduler：每个运行范围唯一 dispatch loop；不新增并行调度器。
- Lease/fencing、ResourceClaim、Workspace：复用既有保护和挂靠关系。
- SessionRegistry：真实工作台会话与 native thread 绑定的权威。
- AttemptStore：append-only 执行证据；不是 Task 状态权威。
- Verification：完成判定统一入口；Review 结果不直接调度。
- Observation/Result Aggregation：只读或派生；不成为状态、结果或调度权威。
- 任务编排的生产 runtime.run 调用点保留一个；不为模型、Skill、MCP 另开执行捷径。

候选生成/硬约束校验不是第二个智能大脑，不能自行替换 LAYA 选择。
具体对象和生命周期以源代码类型及已有测试为准。

## 2. 身份

Agent Family ≠ Model ≠ Worker ≠ Session ≠ Attempt。
WorkerIdentity = { taskId, agentId, modelId, sessionId }。
保持 modelId 的现有 nullable 兼容性，不为历史未知值编造模型。

同 Agent 不同模型或不同 Session 是不同 Worker。
Worker 生命周期内模型/会话绑定稳定；模型切换不能偷偷修改旧 Session。
TaskId 在接力中稳定，真实执行产生新的 Attempt；原证据归属不可重写。

调用入口/账户归属是候选配置和来源维度，不进入已冻结 WorkerIdentity。
当前生产模型调用仍为 agent-native；gateway/provider-api/local model route 是未来范围，
不能因为架构允许表达就声称已支持。

## 3. Dispatch 的冻结点

resolveSessionForDispatch → resolveDispatchContext → mapping/RunRequest → runtime.run。

此冻结区不能增加 await、yield 或重新查询可变 Task/Session，造成线程、模型和归属拼接。
显式 thread 与已解析 Session 的 native thread 冲突时，必须在 runtime 前拒绝：
无 runtime 启动、无 onStart/terminal 执行钩子、无虚假 running 或 Attempt 归属。
显式 thread 与 Session 匹配时正常执行；未显式给 thread 时使用 Session 的真实 thread。
Sessionless explicit thread 保留现有契约，不反向猜 Session/Worker。

当前执行证据必须同时绑定当次 Attempt 与同次 RunResult，不能从 latest-by-task 拼接。
详见 [执行证据](DECISION_LOOP_EXECUTION_RESULT_CONTRACT.md)。

## 4. 协作保护

Lease、fencing、ResourceClaim、Workspace 和停止/释放顺序不因多模型或工具选择放宽。
工作目录隔离不等于独立 Git 仓库；worktree 的 refs/config/metadata 可能共享。
重写历史、切换共享配置等操作不能仅凭不同 cwd 判为无冲突。
多实例能力逐 Agent 验证，当前 PARALLEL_WRITE=CLOSED。
详见 [协作契约](R2_COORDINATION_CONTRACT.md)。

## 5. Windows containment

- CreateProcessW(CREATE_SUSPENDED) → AssignProcessToJobObject → ResumeThread。
- JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE 开启，BREAKAWAY_OK/SILENT_BREAKAWAY_OK 关闭。
- setup/assign 失败不得 Resume suspended target；失败关闭。
- root 退出不是 tree stopped；rootProcessPid 与 launcherPid 不混同。
- 正常成功前确认 Job ActiveProcesses==0；取消/超时不能提前释放保护。
- raw/partial/INVALID control 不得提供 root terminal、root exit code 或 treeStopConfirmed。
- 早期只允许严格完整行解析的正整数 rootPid，不能提前投影生命周期事实。
- rootExitObserved/rootExitCode 成对一致；合法 DWORD 不因数值为 103 或 259 被排除。
- 只有 process handle signaled（WAIT_OBJECT_0）且 GetExitCodeProcess 成功，
  才能接受实际 root exit；非 signaled 的 259 是 STILL_ACTIVE，不是 terminal。
- reconciliation 超时/失败不能 success；停止未确认时保护进入现有隔离/保留路径。
- launcher control 与 Agent stdout/stderr/stdin 分离；第一个独立 -- 后全部为 target argv。

这些是不变量，不是本轮重新验证的结论。详细源码、构建和协议入口见
[native launcher](../native/windows-job-launcher/README.md)。

## 6. LAYA、Skill 和 MCP

本地 DecisionProvider 回答 typed choice/score/noul，不直接启动 Agent 或 MCP 调用。
当前 Skill boolean 只表达“适配器能否请求原生 Agent 加载自己的 Skill”，
不是完整目录、强制授权边界或可直接用于能力排序的事实。

B3.1已经增加显式用户声明Skill候选与逐任务advisory选择；只匹配已分配Agent的原生能力，不参与Worker路由。
首个无依赖任务使用既有dispatchReceipt(promptFor)，其余沿自动brief；没有新执行边或调度权威。
报告保存选择时绑定与同任务latest-run工具观察；跨Agent同名调用不匹配旧请求，admitted不证明运行。
B3.2已增加OpenCode原生MCP用户声明候选及advisory选择，Server/Tool前向映射并拒绝名称碰撞；
仅目录名称匹配的completed工具事件进入新视图，不证明MCP协议或服务身份。首任务与Skill共用同一prompt composer，后续沿TaskIntent/brief。
MCP支持不从skills boolean推断；不自动连接/授权/改配置，不复制工具参数/输出到新报告，不裁剪原生工具定义。
真实加载/调用/强制限制尚未验收；扩展前仍须明确候选事实和能力契约，
不能把现有 boolean 静默改成“已加载、已授权或一定可调用”。
复用原生 Skill/MCP 机制和既有执行入口；LAYA 表达选择和意图，
Session/Adapter/权限校验继续落实真实执行，工具结果保留来源。

未暴露逐任务工具限制的 Agent，不能仅靠 prompt 宣称强制限制。
不得引入第二 MCP 决策器、Skill 调度器或读取/搬运原生凭据。

## 7. 费用、失败和接力

每次选择/接力重新校验费用、授权、模型能力和数据政策。
free 是实际入口/账户资格，不是模型全局属性；单次 cost=0 不等于长期免费。
quota-unavailable（不提供数值）与 unknown（读取失败）、not_fetched、not_connected
按现有不同语义处理，不为可用性擅自统一放行。
共享额度不能因多 Session 而复制。

Gateway 同模型重试与跨模型/跨入口重选是不同边界；后者若将来引入，必须重新准入，
不能以“fallback”名义绕过免费模式、预算和用户固定选择。
Native Agent 自己的内部 fallback 只能按可观测事实记录，不能虚构实际模型和费用。

项目/任务 auto/fixed 复用现有 SelectionSpec 与 Assignment；fixed 约束覆盖动态新增/重规划后代，
不能只继承 pair 而遗漏用户选择锁。task auto 覆盖项目 fixed 时不得误锁。
角色默认与运行中改选未实现；后续协作组也必须遵守用户允许的成员选择范围。

接力先确认旧执行不能继续写，再产生新有效写入者。
安全停止无法证实时，不释放保护或假称干净；保持既有隔离/保留行为。

## 8. 结果、记忆与结束

Agent 声称、机器观察和 Review 结论分层记录。
记忆/报告/工具输出是不可信材料，有来源和有效期；不作为授权或任务状态。
结果摘要只派生既有权威事实，不创造 ResultStore/ReportAuthority。
Human Gate 后自动动作=NONE，新工作由用户或未来另行授权的契约启动。
前端只在用户确认需求后进入；当前文档不选择 UI 技术栈。

## 9. 两层工作流的最小扩展

跨角色独立任务与同目标 2–3 模型共建均复用现有候选 DAG、TaskStore、Assignment 与 Scheduler。
职责、依赖、交付与集成责任是任务意图/数据，不获得新的状态或执行权威。
B4.0 顺序执行异构职责沿既有路径；B4.1 候选计划产生 N 个成员 child task
（顺序写）+ 1 个集成任务，集成任务复用指定成员的具体 pair（不新增第四个模型），成员 pair 由既有
`initial-assignment` 逐个选择且组内两两不同（同一 pair 不能重复占位）。集成任务以全部成员为依赖，
成员未被既有 Verification 接受时集成不可准入。候选集合必须满足 DecisionProvider 的真实输入契约；
只剩一个候选不能直接发送被其拒绝的单选 choice。当前审核状态只见唯一基线，旧入口保持兼容。
前后端角色仍属 implementation，不为业务标签新增并行生命周期。
文件范围写进提示词不等于强隔离；必要限制仍由既有 Workspace/Claim/准入保证。
非Git协作组沿用共享顺序工作区。B4.5将Git协作组映射到由组root物理owner持有的单一隔离worktree，
成员/集成者的task/session/pair不变；同物理workspaceId/scope继续由既有ResourceClaim准入与保留，
不新造合并引擎、不自动并入用户检出。最终review也必须检查运行期retainedResourceProtections，
不能只检查Git创建期unconfirmedProtections。workspaceId或规范化scope命中保留声明时，
同一executionIncomplete事实必须阻断review、ok/exit0及Human Gate完成；no-review不豁免。当前独立验收范围只见唯一基线。
仓库子目录启动明确拒绝，用户脏文件不自动复制；最终人工集成保留。
模型中断恢复后续复用停止确认与 handoff，不能借重试产生两个有效写入者。

旧设计细节和历史审核在 [归档提交](STAGE_ANALYSIS.md#历史备份) 按原路径可查。

## B2.1 用户声明池的准入边界（实施，待单点收口）

用户池是冻结纯值，复用ModelRegistry身份与同一admitUserModelPoolPair；不建立第二registry/路由器。不同字段组合的复合键文本可能碰撞，声明准入须逐项精确匹配agentId/modelId。Assignment仍accept-or-refuse，不替换fixed，不越过quota或资源门。
B2.1a已在最后workspace.prepare之后、取得preRunTask之后、resolveSession/thread及状态提交/runtime之前复用同一buildSpawnGateInput进行同步检查；独立probe与内存负控确认到期/未列actual pair均无runtime/Attempt，原资源finally释放pre-start claim。无新增await或执行边；session解析到runtime之间没有新增Task/Session lookup，不破坏T1冻结。此为最终准入时的声明有效性判断，非真实账户/全流程费用保证。当前provenance会新增无池诊断行，默认不启用新限制不等于所有报告字节完全相同。
