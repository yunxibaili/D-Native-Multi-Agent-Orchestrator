# 项目基线 — 唯一当前状态入口

更新日期：2026-10-13
性质：当前事实、阶段状态、授权边界与证据索引；不是未来能力承诺。

## 1. 文档权责

**本文是唯一当前项目状态与阶段基准。**
[后端需求](BACKEND_REQUIREMENTS.md) 管目标及验收，[阶段分析](STAGE_ANALYSIS.md) 管建议顺序和下一任务范围。
架构、LAYA、协作、Round、执行证据与 native 文档只细化相应契约，不另行宣布阶段封板。
README 是导航。用户明确指令优先；发现源码、证据与基线不一致时核验并修正，不能以文档覆盖事实。

工作流：OpenCode 主要开发，Codex 独立审核；没有明确实现授权时 Codex 不接管开发。
个人本地项目优先最小可用闭环与现有复用；不会因企业级框架、全面治理或轻微 P2 停止所有推进。

## 2. 唯一阶段状态表

| 阶段/边界 | 当前状态 |
|---|---|
| T1 / T2 / T3-a / T3-M0 / T3-b | SEALED |
| W0 | CLOSED |
| W1 / W2 / W3 | SEALED |
| W4.1 | RE-SEALED |
| W4 | SEALED WITH P2 / ENVIRONMENT BLOCKERS |
| W5 | SEALED WITH P2 |
| B1.1 / B1.2c | 最小目录与入口收口 PASS；不等于全部 Agent 已验证 |
| B1.3a | DSH 输出保真收口 PASS；其测试 P2 在 B1.4a 关闭 |
| B1.4a | 独立 PASS：动态 fixed 约束、CLI 缺值、DSH setup 清理收口 |
| B1 overall | NOT SEALED |
| B4.0 / B4.0a / B4.0b | 独立 PASS WITH P2；顺序工作流受控链路封板，非真实模型验收 |
| B4.1 / B4.1a | 独立 PASS；共享顺序工作区的协作组受控闭环封板，原 1 个 P1 + 2 个 P2 关闭 |
| B4 overall | NOT SEALED；功能 A/B 最小闭环均已实现，真实模型兼容性未验收 |
| B4.2+ / B2 / B3 / B5 | PLANNED；本轮未授权启动实现 |
| PARALLEL_WRITE | CLOSED |
| 本产品前端 | 需求未确认；进入前端前提醒用户单独梳理 |

B4.0 是在现有底座上提前交付最小工作流，不自动授权整个 B4，也不把 B2/B3 的缺口宣称已实现。
本次封板适用有界 full/lean、现有选择/调度/Verification/审核的 hermetic 生产调用链；
不认证真实 LAYA/Agent 的判断质量、真实多模型兼容性或全部后端完成。
P0/P1 由具体影响与证据裁定；非阻断 P2 进入计划，不重开所有历史封板。

## 3. 产品目标与当前差距

- 功能 A：LAYA 为跨角色独立任务选择具体 Agent × Model、会话、输入/交付物和依赖。
- 功能 B：LAYA 为同一目标分配 2–3 个模型分工共建，成员独立 child task/会话，明确集成责任。
- 任务级 Skill/MCP 决策、按需加载与上下文复用、免费优先与安全接力同属后端要求。
- “前端开发角色”不表示本工作台前端已开始。多开指独立会话，不承诺启动 GUI 窗口。
- 两层功能尚未完成整体执行验收；不得把 READ fan-out 改名后当作并行写协作。

## 4. 已有执行底座

用户目标 → LAYA typed decision/候选 → Planner 校验 → TaskStore → Assignment/Lease
→ Scheduler → executeTask/Spawn Gate/Workspace/ResourceClaim → Native Runtime
→ RunResult/Attempt → Verification/Review/Result → Human Gate。

复用 discover/doctor、adapter 工厂、ModelRegistry、quota policy、SessionRegistry、WorkerIdentity、
DispatchReceipt、AttemptStore、ResourceClaim、Workspace 与 Windows containment。
任务编排生产 runtime.run 调用边为 1；各只读诊断沿既有 ManagedProcess 执行，不新建调度 authority。
LAYA 作任务级决策；候选内容由已授权 Agent、用户输入或明确的有限模板提供，LAYA 不凭空编造模型/线程。
当前 Round 到 Human Gate 后 automaticPostRoundAction=NONE；跨 Round 自动推进尚未授权。

## 5. 当前已审核能力

### 5.1 模型目录

doctor 默认不采集；显式 doctor --models opencode 经生产 contained ManagedProcess 查询原生目录。
仅 OpenCode 支持目录枚举；其他 Agent 明确 unsupported。
成功有列表/成功空列表/失败区分，非零、超时、坏输出或树停止未确认均不认证成功。
目录不写调度 registry、availability、Assignment、Spawn Gate 或费用事实。
真实目录历史证据为本机 OpenCode 1.18.35、42 项；不是固定数量或永久版本承诺。
listed ≠ connected ≠ callable ≠ free；没有实际调用/额度证据的状态保持未知。

### 5.2 DSH

已有 DSH adapter、discover 注册及既有 CliJsonlTransport 的可选 rawStdoutText。
受控 fixture 验证 stdout 换行/空行/CRLF/分块 UTF-8/形似 JSON 的文本保真；
stderr 进入 diagnostics，不混入答案；正常/失败/cancel/deadline 沿既有运行时。
本机协议历史核实为 @deepseek-ai/dsh 0.1.5-rc.2、cmd-wrapper、位置参数任务与纯文本回答。
当前 modelSelection=false，无可核验 native sessionId，不支持逐请求模型或 resume，相关请求启动前拒绝。
usage/cost 缺失保持未知；shared-only 不被提升为已验证隔离。
真实 --version 与受控 fixture 不等于真实推理、多模型或会话恢复已验收。

### 5.3 用户选择

SelectionSpec 支持 auto/fixed；有效优先级 task > project > default auto。
项目配置 selection 与任务 --select 复用既有 explicitPair/assignWorker：
fixed 精确接受或拒绝，不替换；auto 可覆盖项目 fixed。
--agent 与 --model 同时提供视为 fixed（相对旧双轴偏好是兼容性变化）；单轴仍为偏好。
缺值 --select 返回用法错误 exit=2，外部调用前拒绝。
rootSelections 与 fixedLockFor 在现有 reassign 入口维护有效约束，动态 addTask/replan 的后代不能绕过 fixed。
角色默认、完整 prefer、运行中改选与交互式暂停未实现；固定付费模型不构成新增费用授权。

### 5.4 任务与协作

B4.0–B4.0b 的有界 full/lean 顺序工作流在受控生产调用链范围独立封板。
现有 CandidateTask/commitPlan、Assignment、SessionRegistry、Scheduler/executeTask、Attempt、
Verification/Review/Result/Human Gate 继续复用。当前 workflow（sequential/collaborate）请求
acceptance_material，携带目标、同任务验收条件、同次 Attempt 配对的有界 RunResult 材料；
缺执行关联保持 null/missing，不用 Runtime exit=0 代替验收。非法计划已核验的写前边界保持。
B4.0b 留下的 review Attempt 弱断言已在 B4.1 测试修改中补强，独立负控证明确实能发现记录丢失。

B4.1 新增 opt-in `--workflow collaborate`，duo/trio 纯值计划包含 2/3 个顺序成员 child task，
以及依赖全部成员的集成 task。计划指定组内成员承担集成，集成任务继承其初始 pair，独立 task/session。
目前仅共享顺序工作区（非 Git cwd）；Git 隔离交付缺既有送入集成者工作区的路径，启动前明确拒绝。
有效 fixed、可用 pair 不足也明确拒绝；文件范围只是声明，不等于强隔离。PARALLEL_WRITE=CLOSED。

受控 provider 下，duo/trio 实际生成不同成员文件，集成任务读取文件字节生成 combined.txt，
Assignment/RunRequest/Attempt/session 身份一致，最大执行并发=1；成员失败或缺交付时集成不运行。

B4.1 独立审核发现的 1 个 P1 + 2 个 P2 已由 B4.1a 修复，并经本轮独立审核确认关闭；分工/会话/集成未重写：
- P1：distinctPairs 逐次减去已选 pair，恰好 N 个可用 pair 的 N 人组最后只剩一个候选；旧代码仍调用
  `decideInitialAssignment` 发**单选** choice，真实 `createLayaDecisionProvider` 在发送前就拒绝
  （信息量为零），于是 exact-2 `duo`/exact-3 `trio` 的最后成员被拒。现改为**显式约束规则**记录该 pair：
  来源标为 `collaboration-constraint`（不伪造成 LAYA 比较/概率/置信度/用户 fixed，不虚构第二候选，不放宽
  provider 单选拒绝），仍经同一 `validateAgentModelIntent` → `initialSelections` → Assignment 准入，
  Assignment 再拒仍拒绝；0 候选走既有拒绝，多候选仍问 LAYA，其他入口语义不变。
- P2（报告）：`report.collaboration` 只投影已知事实——未分配成员仍列出但 `assigned=false`/`pair=null`，
  不计入 `distinctPairs`；`distinctPairs` 只数已分配且 agent/model 都非空的 pair；任一成员未分配则
  `pairIsDistinct=false`；新增 `selectionProvider` 来源记录；`supportedWorkspace`（模式支持什么）与
  `execution`（实际分配/运行/集成事实，来自 `assigned` 与 AttemptStore）分开，未运行任务不声称已写文件或已集成。
- P2（回归）：名为 unverified delivery 的用例原走正常成功路径；现改为真实受控负例——成员 2 运行但**不写文件、
  输出为空**，材料驱动 provider 不发 `complete`，成员 2 停 `to_verify`，集成从不运行、无 `combined.txt`、
  非零退出、报告 incomplete 并列出阻塞成员。
测试 fixture 现在也执行真实 provider 的 choice 输入契约（单选即拒），并新增真实 provider + `fetchImpl`
seam 的承重校验，所以“绕过输入校验”不再能通过本套件。报告投影和固定 note 问题已按事实收口。
完整角色计划、真实模型兼容性、Skill/MCP、费用与掉线恢复保持后续范围。

## 6. 不可绕过的契约

WorkerIdentity={taskId,agentId,modelId,sessionId}；不以模型品牌替代 Agent 能力事实。
resolveSessionForDispatch → resolveDispatchContext → mapping/RunRequest → runtime.run 的冻结区保持同步。
当前 Attempt 与同一次 RunResult 成对引用，不能 latest-by-task 拼接。
lease 失效或 root 退出不证明执行树已停；停止未确认时保留保护，不启动第二个有效写者。
native process handle signaled 后实际退出码 259 合法；nonsignaled 的 259 是 STILL_ACTIVE。
更多约束见 [架构](ARCHITECTURE_CONTRACTS.md)、[协作](R2_COORDINATION_CONTRACT.md)、
[Round](EXECUTION_ROUND_SEMANTICS.md)、[证据](DECISION_LOOP_EXECUTION_RESULT_CONTRACT.md)。

## 7. 真实缺口与后续边界

1. DSH 缺逐请求选模型与恢复协议；要用 DSH 做多模型调配，必须先取得受支持的真实接口证据。
2. B4.0–B4.1a 的顺序工作流与协作组受控链路已独立封板；B4.1 输入契约、报告事实投影与未交付负例已收口。
   完整角色计划、prefer/角色默认、运行中改选、真实模型多模型兼容性仍缺，留后续切片。
3. Skill/MCP 只有部分意图/原生支持，目录、授权、具体选择和实际调用核对未闭环。
4. 动态免费资格、账户共享额度和全流程费用授权未验收；预算 units 不是 token/货币。
5. 模型中途掉线恢复列后续计划：区分流中断、限流/额度/认证/崩溃与未知，静默不等于死亡；
   有界重试考虑重复写入，旧执行停止确认后才接力，fixed 不偷换，无免费候选不静默付费。
6. 多 Agent 真实兼容性、同 Agent 多模型隔离、总 token 收益需各自实证；fixture 不替代这些证据。
7. W4 真实 Agent 环境限制、旧 full-suite 证据时效与 native reconciliation 无法取得退出事实时的
   fail-closed 可用性限制继续保留；本轮未重测或解除这些历史 P2，细节见既有审核快照。

这些不是要求下一片一次实现全部能力；真实执行仍遵守现有准入，缺必要事实就明确拒绝。
不新增 provider 网关、群聊平台、第二个调度器或通用工作流引擎来掩盖协议缺口。

## 8. 最近独立证据与上传记录

本轮 B4.1a 独立审核（2026-10-13）：**PASS**。Codex 仅更新文档，未修改生产代码或测试。
独立实跑 typecheck PASS；b41-collab-group 91/0、b40a-cli-workflow 42/0、b40-workflow 41/0、
initial-assignment-decision 37/0、assignment 235/0、assignment-lease 251/0、workbench 413/0、
decision 397/0、b14-selection 46/0；isolation 守卫 5 opt-in/0 违规，命令 exit 均 0。
diff check PASS，生产 runtime.run 边=1，新增调度 authority=0。

- P1 关闭：独立 CLI probe 将每次成员 pair 问题交给真实 createLayaDecisionProvider，本地校验/答案解析
  均执行，HTTP 使用 fetchImpl 受控响应。exact-2 的问题候选数仅 [2]、受控 fetch=1；
  exact-3 仅 [3,2]、受控 fetch=2；最后成员没有被问单选问题，来源为 collaboration-constraint，
  仍经 Assignment 得到实际 session。两组分别执行 3/4 次，exit=0、completed/pass，文件集成含全部成员字节。
- 承重负控：仅在内存关闭唯一候选分支、退回旧提问路径，正式 suite 73 passed/18 failed、exit=1；
  多候选 provider 的全局单选拒绝保持，未通过放宽校验掩盖问题。
- 报告 P2 关闭：正式编造/重复/不可用 pair 负例保留未分配成员、assigned=false、pair=null，
  仅统计已知分配，pairIsDistinct=false；支持模式与实际 membersRan/integrationRan 分开。
- 未交付 P2 关闭：真实 fixture 成员 2 不写文件且输出为空；正式负例与独立 exact-2 probe 均显示
  m2=to_verify、integrator.ran=false、无 combined.txt、exit=1、incomplete，未宣称集成。
- 身份/审核：独立 duo/trio probe 的 task/agent/model/session 与 execution Attempt 一致；
  集成者分别继承成员 1/2 的 pair，独立 session；review Attempt 分别为 att_0004/att_0005，追加成功。
  原 B4.1 的分工、顺序、文件消费、fixed/Git 拒绝边界保持，不新增第四个协作模型或合并引擎。

本轮范围未发现未关闭 P0/P1/P2。封板仅适用共享顺序工作区的受控生产调用链，不认证真实 LAYA 判断质量、
真实 Agent 多模型兼容性、Git 隔离集成、免费资格或全部 B4。not_fetched 规划候选仍可能由 Assignment
quota-blocked 拒绝，这是已覆盖的既有 fail-closed 观察，不伪造可调用/免费事实。
probe 只内存导出/替换测试 seam，未覆盖工作树，命名 owned 目录均清理；未跑 full suite、未调用真实模型、
未读凭据、未安装依赖、未改本机 Agent 配置。PARALLEL_WRITE=CLOSED，B4.2/B2/B3/B5 未启动。

B4.1a 实现方报告（与上文独立实跑区分）：`b41-collab-group` **91/0**（经真实 `runRoundCli` +
受控 provider/runtime，集成任务真实读写 owned 工作区文件）；`b40a-cli-workflow` 42/0、`b40-workflow` 41/0、
initial-assignment-decision 37/0、assignment 235/0、assignment-lease 251/0、workbench 413/0、decision 397/0、
handoff-production-round 312/0、state-loop 169/0、b14-selection 46/0、contract 248/0（2 skipped）、unit 92/0；
isolation 守卫 5 opt-in/0 违规；typecheck PASS、`git diff --check` clean；生产 `runtime.run` 调用边=1、
新增调度 authority=0、owned 残留 0。
- P1 关闭：exact-2 `duo`（恰好 2 个可用 pair）与 exact-3 `trio`（恰好 3 个）完整成功、exit=0；
  只对第 1（trio 为前 2）名成员发 LAYA 问题，最后一名由**约束规则** `collaboration-constraint` 记录，
  仍经 intent 校验/initialSelections/Assignment 进入真实 session；未发单选 choice、未虚构比较记录。
- 真实 provider 输入契约（D）：`createLayaDecisionProvider` + `fetchImpl` seam 实测——单候选在发送前
  抛 `DecisionInputError`（fetch 0 次），双候选通过本地校验并真实发送 1 次，答案回填。
- 报告 P2 关闭（G）：未分配成员仍列出但 `assigned=false`/`pair=null`，`distinctPairs` 只数已分配且
  agent/model 非空的 pair，`pairIsDistinct=false`；`supportedWorkspace` 与 `execution` 分开，
  未运行任务不声称已写文件或已集成。零/不可用/重复/编造 pair 均 fail-closed，不替换。
- 真实未交付负例（H）：成员 2 运行但不写文件、输出为空 → 不 accepted、停 `to_verify`，
  集成从不运行、无 `combined.txt`、exit≠0、报告 incomplete 并列阻塞成员。
- fixed 冲突、Git 隔离工作区拒绝保持；正常文件集成、成员独立会话、集成者复用成员 pair、
  合法 Review 与实际 `kind=review` Attempt 保持（I）。
上述为本轮 hermetic 证据；未跑 full suite、未调用真实模型、未读凭据、未改本机配置。

上一轮 B4.1 独立审核（2026-10-13）：**BLOCKED**。Codex 未修改生产代码或测试。
独立实跑 typecheck PASS；b41-collab-group 62/0、b40a-cli-workflow 42/0、b40-workflow 41/0、
initial-assignment-decision 37/0、workbench 413/0、assignment 235/0、handoff-production-round 312/0、
state-loop 169/0、b14-selection 46/0、round-result 293/0；isolation 守卫 5 opt-in/0 违规，命令 exit 均 0。
diff check PASS，生产 runtime.run 边=1，新增调度 authority=0。

- P1：真实 CLI + 受控 runtime/provider，最后一个单候选问题交给实际 createLayaDecisionProvider 本地校验。
  trio 恰好三个 pair：候选数 3→2→1，m3 assignment-invalid，前两成员运行后停止，exit=1，无集成。
  duo 恰好两个 pair：2→1，m2 同样拒绝，exit=1。拒绝明确为 offers exactly one choice，未发送 HTTP/未调用模型。
  当前 fixture provider 未执行这条真实输入校验，因此 62/0 不能覆盖此阻塞。
- P2：上述 trio 仅两个成员有 model/session，报告却 distinctPairs=3、pairIsDistinct=true；
  duo 仅一个成员有 pair 却计 2。note 在集成从未运行时仍称读了文件。最小修复是仅投影已知 pair，
  全员未分配时不认证 distinct，并把支持模式与实际执行事实分开。
- P2（测试覆盖）：名为 unverified delivery 的 case 实际调用正常成功路径，没有制造未验证/无交付。
  独立内存注入 m2 不写文件且输出为空：2 次成员执行、m2=to_verify、集成 planned、无 combined.txt、exit=1。
  当前行为可用，但应把该最小负例加入正式回归，不用标题冒充失败证据。
- 正向：普通受控 duo=3 次执行、trio=4 次执行，最大并发=1；请求 cwd 与 owned cwd 一致，
  成员 task/pair/session 与实际 execution Attempt 一致，combined.txt 含全部不同成员文件的实际字节，最终审核 completed/pass。
  直接注入重复 pair 也被 offered-pair 校验拒绝，不替换、集成不运行。
- B4.0b 旧 P2 关闭：不追加 review Attempt 的内存负控现为 38 passed/4 failed、exit=1；正常为 42/0。
  断言覆盖 ok、attemptId、kind=review 和发布文件中的实际记录。

只修一项核心输入契约及相邻报告/回归收口，不重写分工/集成，不进入 B4.2/B2/B3/B5。
probe 仅内存导出/修改 fixture seam，工作树测试不变，命名 owned 目录均清理；未跑 full suite、未调用真实模型、
未读凭据、未改本机 Agent 配置。Git 工作区拒绝是本片已声明的支持边界，不追加合并引擎作为封板条件。

B4.1 实现方报告（非独立结论，不能覆盖上述阻塞）：`b41-collab-group` **62/0**（经真实 `runRoundCli` +
受控 provider/runtime，集成任务真实读写 owned 工作区文件）；`b40a-cli-workflow` 42/0、
`b40-workflow` 41/0、workbench 413/0、orchestration 968/0、handoff-production-round 312/0、
state-loop 169/0、planner 189/0、assignment 235/0、resource-claim 192/0、decision 397/0、
unified-review 130/0、review-loop 169/0、round-result 293/0、b14-selection 46/0、
initial-assignment-decision 37/0、memory 445/0、worker-identity 37/0、contract 248/0（2 skipped）、
unit 92/0；isolation 守卫 5 opt-in/0 违规；typecheck PASS、`git diff --check` clean；
生产 `runtime.run` 调用边=1、新增调度 authority=0、owned 残留 0。
- 2 成员（同 Agent、两个不同模型）：独立 task + 独立 session，pair 两两不同；3 成员跨不同 Agent，角色/
  文件范围/pair 可追溯；全程严格顺序（最大并发 run=1）。
- 真实集成：成员在各自声明范围写真实文件，集成任务读取这些文件并生成 `combined.txt`，其中含**每个成员
  的实际字节**；集成任务运行在指定成员 pair 上、复用其 pair 但拥有自己的 task/session。
- 失败阻断：成员失败 → 集成任务从不运行、报告列出阻塞成员、round 不 ok 且 incomplete。
- 选择/身份：fixed 冲突、Git 隔离工作区、可用 pair 不足均在启动前拒绝（无运行）；LAYA 编造 pair 不替换，
  该成员无 model/session 且不 succeeded；Assignment/RunRequest/Attempt 身份一致。
- 最终证据：Review 请求含每个成员与集成任务的真实输出；`reviewEvidence.ok=true` 且 attemptId 解析到
  实际 `kind=review` 记录（B4.0b 遗留弱断言已在本轮补强为 ok/attemptId/kind=review 实测）。
上述为本轮 hermetic 证据；未跑 full suite、未调用真实模型、未读凭据、未改本机配置。

上一轮 B4.0b 独立审核（2026-10-13）：**PASS WITH P2**。Codex 仅更新文档，未修改代码或测试。
独立实跑 typecheck PASS、b40a-cli-workflow 39/0、b40-workflow 41/0、decision 397/0、
unified-review 130/0、review-loop 169/0、workbench 413/0、state-loop 169/0、handoff-production-round 312/0；
isolation 守卫 5 opt-in/0 违规，命令 exit 均 0；diff check PASS，生产 runtime.run 边=1、新增 authority=0。

- 目标/材料：截获请求包含原始目标及当前 to_verify 任务验收条件，att_0001/2/3 分别对应 STEP_OUT_1/2/3，
  材料未混用其他步骤输出。成功 full=3 次执行、exit=0；不满足或空输出均仅 research 执行、exit=1、incomplete。
- 有界/缺事实：3000+ 字符 fixture 输出在请求中为 2000 字符，两个截断标记为 true；
  内存模拟缺当前执行关联时 attemptId=null、output=''、executionMissing=true，下游未启动，未挪用旧结果。
- 原子计划：真实 planWithCandidates 的根 ID 冲突/null parent 回归拒绝前后 store 不变，同 ID 修正可提交（41/0）。
- 审核：真实请求含三步材料，completed/pass，reviewEvidence.ok=true；att_0004 在 roundResult.machine.attempts 中
  实际存在且 kind=review。无效 verdict 的正常回归仍拒绝，未把 fixture 当真实模型。
- 隔离：独立 child 的 ORCH_HOME 指向本轮 owned sentinel，三种输出 case 都发布到各自 roundResultDir，
  sentinel 内容保持不变；不依赖未关联的旁路文件来宣称隔离。
- 非阻断 P2：tests/b40a-cli-workflow.test.ts 的 `(reviewEvidence ?? []) !== undefined` 恒真，
  “已记录 review Attempt”断言只剩调用次数与目录存在检查。内存负控让 recordReviewEvidence 返回失败并不追加，
  suite 仍 39/0、exit=0，证明该断言不承重。最小补强是断言 ok/attemptId，并解析到对应 kind=review 的实际记录。
  实际正常记录已独立验证，不阻断本片；放入下一次相关测试修改，不单开治理框架或封板轮次。

上述 probe 均受控，通过内存 hook 导出/替换测试 seam，未覆盖工作树；自身命名临时目录已清理。
未跑 full suite、未调用真实 LAYA/模型、未读凭据、未改本机 Agent 配置；历史能力限制保持。

B4.0b 实现方报告（与上文独立实跑区分）：`b40a-cli-workflow` **39/0**、`b40-workflow` **41/0**；
decision 397/0、unified-review 130/0、review-loop 169/0、round-result 293/0、workbench 413/0、planner 189/0、
orchestration 968/0、handoff-production-round 312/0、initial-assignment-decision 37/0、b14-selection 46/0、
state-loop 169/0、assignment 235/0、execution-lifecycle 136/0、contract 248/0（2 skipped）、unit 92/0、
resource-claim 192/0；isolation 守卫 5 opt-in/0 违规；以上命令 exit=0。
typecheck PASS、`git diff --check` clean、`runtime.run` 生产调用边=1、新增 authority=0、owned 残留 0。
清理失败负控实测：强制清理失败时 exit=1（39 passed/0 failed 也不放过），恢复后 exit=0。

- 主 P1 关闭证据：材料请求只出现在 workflow opt-in；每个材料都带原始目标 `OBJECTIVE_SENTINEL_77`；
  条目带自身 `deliverable:` 验收条件；待验证任务的材料含**自身** `STEP_OUT_n` 且不含其他步骤标记；
  输出的 deliverable 不满足时 LAYA 不接受、下游不启动、报告 `no-progress` 且 incomplete；
  输出为空时材料如实为空、不伪造通过。
- P2-A：根 ID 冲突与首个候选 parent=null 均在任何写入前拒绝，store 条数不变、无残留根/孤儿任务，
  修正后同一根 ID 可正常提交。
- P2-B：合法 verdict 得 `unifiedReview.status=completed`、`verdict=pass`，真实 review Attempt 已记录，
  审核请求含三步实际输出；缺 `reviewedAt`/`findings`/`recommendedAction` 的 verdict 被拒为
  `reviewer-output-invalid`，不再出现「只断言 reviewer 被调用」。
- P2-C：发布路径落在 owned 目录，调用者 sentinel 报告文件内容未变；默认解析器仍按 `$ORCH_HOME` 解析
  （用显式 env 调用纯函数验证，未读写真实 home）。

以上均为本轮 hermetic fixture 证据，不提升为真实模型兼容性证据；
未跑 full suite、未调用真实模型、未读凭据、未改本机配置。
本轮不扩展功能 B、Skill/MCP、费用或掉线恢复。新增非阻断 P2 记录后续，不扩成全面审核。

上一轮 B4.0a 独立审核（2026-10-13）：**BLOCKED**。未修改生产代码或测试。
独立实跑：typecheck PASS；b40a-cli-workflow 22/0、b40-workflow 31/0、resource-claim 192/0、
orchestration 968/0、workbench 413/0、handoff-production-round 312/0、b14-selection 46/0、
state-loop 169/0、planner 189/0、execution-lifecycle 136/0、contract 248/0（2 skipped）、unit 92/0；
isolation 守卫 5 opt-in/0 违规；以上命令 exit=0。diff check PASS，生产 runtime.run 边=1，新增 authority=0。

- 已关闭旧问题：状态驱动 full=3 次执行/6 个 cycle，lean=2 次执行；不同上游输出进入下游 brief。
  无 complete 时 no-progress 停止且 incomplete；非法 complete 目标被拒绝，后两步不运行。
  非 Git 顺序写成功；独立并行/存活写者保护的现有定向回归通过。
- P1：截获全部 3 次待验证状态的真实 DecisionRequest，任务目标标记和 STEP_OUT 输出均不存在，
  task/context 也未提供。要求有材料才 complete 的受控 provider 只能 wait；research 后 no-progress 停止。
  最小修复是向现有决策请求接线同任务验收条件/有界实际材料，不新建验证框架。
- P2：实际 planWithCandidates 的重复/悬空/环均拒绝且 store 不变；根 ID 冲突和 null parent 仍留下根，
  有效同 ID 重试失败。这两项不能继续归为已关闭。
- P2：新测试 reviewer frame 未按 fake adapter 契约提供 data.text，且 verdict 缺 reviewedAt/findings/recommendedAction；
  原套件全绿时实际 unifiedReview=failed、reviewer-output-invalid。其断言仅检查审核调用次数，不证明合法 verdict。
  仅在内存修正 fixture 后，独立 probe 得 completed/pass、review Attempt att_0004、审核请求含 3 步输出；生产审核路径可复用。
- P2：新默认套件没有隔离 ORCH_HOME；runRoundCli 按生产默认发布 round-result.json，存在覆盖用户报告的副作用。
  下一片复用 owned 子进程环境或既有路径 seam 隔离，不能把测试临时 cwd 当作报告目录隔离。

probe 复用既有测试 seam，以内存导出/受控 fixture 运行，不修改工作树测试；命名 probe 目录均已清理。
常规 suite 与 probe 证据分开；未跑 full suite、未调用真实模型、未读凭据、未改本机 Agent 配置。

B4.0a 实现方报告（历史描述，不能覆盖上述独立结论）：`b40a-cli-workflow` **22/0**（经真实 `runRoundCli` +
受控 provider/runtime）；`b40-workflow` 31/0、resource-claim 192/0、orchestration 968/0、workbench 413/0、
handoff-production-round 312/0、state-loop 169/0、planner 189/0、assignment 235/0、execution-lifecycle 136/0、
contract 248/0（2 skipped）、unit 92/0；isolation 守卫 5 opt-in/0 违规；typecheck PASS、`git diff --check` clean；
`runtime.run` 生产调用边=1、新增 authority=0、owned 残留 0。
- 成功链：CLI 有界循环驱动 full（research→implementation→test 三步各自运行，下游 brief 含**不同**上游
  `STEP_OUT_n` 实际标记）；lean 两步；全成员 `succeeded`、`report.ok=true`、`executionIncomplete=false`、
  Review 读真实 Attempt/RunResult。
- 前置失败：上游失败后仅 research 运行，循环 `terminal-failure` 停止，`ok=false`/`executionIncomplete=true`。
- 缺验证：provider 不发 `complete` 时 research 停 `to_verify`，`no-progress` 停止，下游不启动，pending 如实列出。
- 非法候选：实现方声明写前校验；独立核验的剩余边界见上文。
- 固定选择：整条 CLI workflow 用固定 pair，完成后 `ok=true`。
上述为本轮 hermetic 证据；未跑 full suite、未调用真实模型、未读凭据、未改本机配置。

上一轮 B4.0 独立审核（2026-10-13）：**BLOCKED**，不修改生产代码/测试。
独立实跑 `b40-workflow` 31/0、planner 189/0、workbench 413/0、b14-selection 46/0、
initial-assignment-decision 37/0、handoff-production-round 312/0、contract 248/0（2 skipped）、unit 92/0，
isolation 守卫 5 opt-in/0 违规；typecheck PASS、diff check PASS，以上命令 exit=0。
生产任务编排 runtime.run 调用边=1；新增调度 authority=0。

- P1：复用既有 productionRound 受控 runtime seam，真实 CLI full 仅有 1 次 research 请求，后两步未运行。
  `to_verify/planned/planned` 却 exit=0、ok=true、executionIncomplete=false；CLI 没有顺序完成/验证推进。
- P2：直接调用 planWithCandidates 提交重复候选，store 从空变成仅根 `r`；有效计划用同 ID 重试被 task-id-duplicate 拒绝。
- P2：同一 CLI seam 由 typed provider 选择 lean，非 Git 工作区中首步 resource-unavailable，runtime 请求=0；
  planned 的依赖下游被既有保护算作并行工作。需兼容既有门或如实声明支持范围，不绕过保护。
- 正向证据：Workbench 显式 completeTask 后，implementation brief 包含上游 `UPSTREAM_BODY_42` 实际内容。
  这是库级显式推进证据；不认证 CLI 自动推进或最终 Review 已通过。

probe 的 provider/runtime 均受控，生产 planning/assignment/scheduler/report 路径保留。
full 问题在默认请求审核与显式 no-review 下均出现；默认 probe 只证明审核被调用，不认证其 verdict。
NOT_RUN/fixture/真实模型证据不互相提升；未跑 full suite、未调用真实模型、未读凭据、未改本机配置。
独立 probe 的命名临时目录均已清理，无探测进程；历史残留不属于本轮所有权。

上一轮 B1.4a 独立审核（2026-10-12）：
typecheck；b14 46/0；workbench 413/0；initial-assignment 37/0；handoff-production-round 312/0；
DSH 64/0；isolation 5 opt-in/0 违规；diff check PASS，正常命令 exit 均 0。
三层动态 child probe：项目/任务 fixed 拒绝迁移，task auto 覆盖后实际迁移成功。
隔离内存负控退回旧查锁方式：40/6、exit=1。真实 fixture 写入异常：exit=1、原错误保留、owned 目录被清理。
开发期递归子进程事件为实现方报告；当前 setup-failure child guard 已核对，正常 suite 完成，不重演失控。
上述是上一轮证据，本轮文档维护未重跑，也不是全部后端或真实模型验收。

- [最近 PASS 审核快照 098279e](https://github.com/yunxibaili/D-Native-Multi-Agent-Orchestrator/commit/098279e6da454554469c581e6c6482c6445f53cf)，分支 codex/b14a-review-pass。
- [上一轮缺陷快照 6c58937](https://github.com/yunxibaili/D-Native-Multi-Agent-Orchestrator/commit/6c5893727e8ed144680f4a350fa10c06773370d3)，问题已在上述 PASS 收口。
- [更早整理前备份 9f12a3b](https://github.com/yunxibaili/D-Native-Multi-Agent-Orchestrator/commit/9f12a3bf475ac47e4e6b2b2dd407ed09811610b5)。

W5 的 production admission、底层 stress、受控失败注入与真实 Agent 历史证据分层保持。
不重新沿用已关闭历史 P1，不把旧 full suite 或 fixture 成绩写成本轮结果。
上一轮 10 份技术文档整合快照为 0b24cf93ba3b13e952e5c5a13322bb07161c09fc，分支 codex/backend-docs-next-b40。
B4.0 BLOCKED 审核快照为 baab39e92dc7e115d974b2ee904b14aa7931700d，分支 codex/b40-review-blocked。
B4.0a BLOCKED 快照为 c7adbdc08493c3e27f8ec3e53ffde6ddb3f67460，分支 codex/b40a-review-blocked。
B4.0b PASS WITH P2 快照为 270668a191eb0fc72ef17bcfaead82244e28df07，分支 codex/b40b-review-pass。
B4.1 BLOCKED 快照为 f82f8c17bb7c42a477a627877c8038c525da918d，分支 codex/b41-review-blocked。
本次 B4.1a PASS 快照以 f82f8c1 为父，分支 codex/b41a-review-pass，包含修复与两份独立审核文档；
不合入 main，不授权 B4.2/B2/B3/B5；上传后的准确 commit 见会话交付。
