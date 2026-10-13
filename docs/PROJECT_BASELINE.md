# 项目基线 — 唯一当前状态入口

更新日期：2026-10-14
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
| B4.2 / B4.2a | 独立 PASS WITH P2；项目计划与多入口顺序执行受控闭环封板，保留等待/拒绝分类 P2 |
| B4.3 | 最小 opt-in 阶段确认入口独立 PASS；仅显式 sequential/collaborate 工作流，不等于完整需求批准链 |
| B4.3a | 独立 PASS；剩余 legacy 绑定 P1 已通过写前拒绝关闭，受控范围封板 |
| B4 overall | NOT SEALED；功能 A/B 最小闭环 + 项目适配 + 阶段确认入口均已实现，真实模型兼容性未验收 |
| B4.4 | 独立 PASS；最小有出处的交接/用户交付视图，声明/观察/未知分开，不等于产物或测试结果认证 |
| B4.5+ / B2 / B3 / B5 | PLANNED；本轮未授权启动实现 |
| PARALLEL_WRITE | CLOSED |
| 本产品前端 | 本机独立进度页已授权且禁止入 Git；正式工作台 UI 需求仍待确认 |

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

B4.2 新增显式 opt-in 的结构化**计划文件入口** `--workflow-plan <file>`，让用户按自己的项目表达候选计划，
替换内置的写死模板（内置 `full/lean/duo/trio` 保持不变）：
- 文件是 JSON，`kind` 为 `sequential` 或 `collaborate`，含少量有界候选；每个步骤/成员声明
  `role`、既有 `taskType`、可选 `fileScope`、`deliverable`、可选 `dependencies`（角色名，缺省为链）；
  协作计划另声明 1-based `integratorMember`。`parsePlanFile` 在写入任何任务前拒绝未知 kind、非法
  taskType、重复角色/计划 id、悬空依赖、自依赖、依赖环、越界集成者、超出成员/步骤/计划数量与字段长度。
- 任务 id 由系统从本轮 root 生成（sequential `-wN`、collaborate `-mN`+`-int`），文件**不能**命名 taskId，
  因此外部计划无法覆盖既有任务，也不会与内置计划冲突。
- 计划来源统一走既有 `decideWorkflowPlan`：多候选问 LAYA；单候选按规则记录来源、不发单选问题；
  `--workflow-choice` 必须命中文件实际提供的 plan id，否则拒绝、不替换。文件里的 role/fileScope/deliverable/
  dependencies 进入真实任务的验收条件、执行 brief、验收材料与报告，不只停在配置对象。
- 复用同一 `validateCandidateDag`/`commitPlan`/Assignment/Session/Scheduler/Verification/Review；
  协作成员仍 2–3 个、集成者属成员且复用其 pair、集成任务独立 task/session，不新增第四个模型；
  每任务 Agent×Model 仍由既有 LAYA + Assignment 决定，不绕过 fixed/能力/额度/费用准入。
- 内置与文件计划共用同一候选构造规则（`plan-file.ts` 的 builder），所以二者不会漂移；顺序执行、
  最大有效写执行数=1、文件范围只是声明、成员未交付时集成不运行等边界不变。未补 Git 隔离合并，保留拒绝。

B4.2a 独立审核确认原多入口 P1 关闭，原资源拒绝报告主场景关闭；保留非阻断 skipped 分类 P2，不重写调度/工作区/合并：
- P1：文件计划里显式 `dependencies: []` 的多个写步骤（或协作成员）曾被解析、提交、分配，但同一 tick 都就绪，
  共享非 Git 工作区无法隔离两个写者 → 全部 `resource-unavailable`、runtime 请求=0、no-progress。
  现把计划文件的步骤按**顺序链**执行（这是 sequential 工作流的既定契约，`PARALLEL_WRITE=CLOSED`）：
  用户声明的 `dependencies` 作为**额外前向边**保留，链边在**校验前**加入，所以“显式依赖 + 默认链”形成的环
  在写前按 `dependency-cycle` 拒绝、无部分任务。这样同一 CLI 链真实写出 owned 文件、最大有效写者=1、
  协作集成消费所有成员实际字节；不是靠去掉 resource gate 或伪造 dependencies 过测。
- P2：`continue` 未准入任何任务时，`decision.note` 曾无条件称“没有 free slot/ready task，没有被 gate 拒绝”，
  把真实 `resource-unavailable` 抹掉。现从 receipt 的 `skipped`/`waiting` 如实投影：拒绝显示任务+码+原因
  （`report.decision.code` 也带上），并区分“等依赖/容量”与“被 gate 拒绝”；只有确实没有被拒时才说没被拒。
- 附带：`decision.ts` 是遗留 CRLF 文件（其 blob 早于 `* text=auto`），编辑它会让 `git diff --check` 把每个新增行
  的 CR 误报为行尾空白；在 `.gitattributes` 为**该文件**声明 `whitespace=cr-at-eol`，只让真正的空白错误被报告，
  不改变行尾、不做全仓 renormalize。

B4.3/B4.3a 最小 opt-in 阶段确认入口已独立 PASS，封板限以下显式工作流与受控链路，不等于完整需求批准流程或真实模型验收。
入口为 `--workflow sequential|collaborate` + `--stage <file>` + `--confirm <digest>`（`--stage-check` 为只读预检）：
- 阶段材料是 JSON，声明 `stageId`、`scope`、`requirement`、`acceptance`，可选 `planRef`；`parseStageMaterial`
  在写任务前拒绝缺字段、超长、超大小，并拒绝任何自我批准字段（`approved`/`confirmed`/…）。
- 确认只来自用户本次调用 `--confirm <digest>`，digest 绑定材料、实际目标及显式工作流候选内容：改 stage/scope/requirement/
  acceptance/planRef、显式计划内容或目标即失效；--stage 无受支持 --workflow 在写前拒绝（包括带 confirm/stage-check），不再允许 null 计划绑定。文件自写 approved、模型输出或历史记忆都不能批准——gate 在**任何外部调用之前**（探测、
  LAYA 分类、建任务之前）本地判定，失败时 `{ok:false, stage:'stage-gate', error, pending}`、runtime=0、无部分任务。
- 信任边界如实声明：`--confirm` 是本地用户行为，不是身份认证，也不约束原生 Agent 进程内的动作。
- 确认后，材料经**完整嵌入 + 来源标签**（`ref <file>@<digest12>`）拼入本轮 objective，超过 6000 字符的嵌入上限写前拒绝，从而进入既有 plan builder →
  每个任务的验收条件、执行 brief、验收材料；不是只加配置/报告字段。
- 复用同一 plan-file/planWithCandidates/Assignment/Scheduler/Verification/Review；结束仍 `automaticPostRoundAction=NONE`，
  不自动进入下一阶段；已批准范围内的普通任务无需重复确认；旧入口（full/lean/duo/trio、plan file、fixed）不变。
- 附带 P2 修复：`applyDecision` 区分 Scheduler 的 `dependency-unmet`（等待）与真实准入拒绝；混合 receipt 主码取
  真实拒绝、并保留全部原因与等待项；`PlanFileStep.dependencies` 注释改为“显式 `[]` 不声明业务依赖、执行仍追加顺序链”。

B4.3a 独立复核 PASS：显式工作流绑定、材料交付与 legacy 入口单点均已关闭：
- P1-1：确认曾只绑定材料字段，`planRef` 未与实际计划核对，改计划 id 或同 id 改交付仍沿用旧确认。现确认 digest 由
  `stageBindingDigest` 覆盖**材料 + 目标 objective + 工作流模式 + 有效计划内容（role/taskType/fileScope/deliverable/
  dependencies/集成责任）+ planRef**；计划文件在 gate 处**读取并冻结一次**，plan 块复用同一对象（不再二次读取）；
  `planRef` 必须命中有效计划的 id 或计划文件本身，否则写前拒绝；`stage-check` 显示有效计划/范围摘要与 digest。
  在 sequential/collaborate 显式工作流中，计划内容或目标变化使旧确认失效；仅改 JSON 键序/空白不改变标准化对象。
  对于无 --workflow 的阶段入口，新增 guard 复用现有 refuse，任何外部调用/任务创建之前拒绝；
  无 --stage 的旧 legacy 执行保持，未建设 legacy 计划审批平台。
- P1-2：材料摘要曾按字段截断（长 requirement 的关键尾部被截掉），且隔离 worktree 中相对引用不可达。现材料
  **完整嵌入**（`stageMaterialEmbed`，不再截断）进入 objective → 任务验收条件/brief/验收材料；超出可交付上限
  （`STAGE_EMBED_MAX_CHARS`）时在任何写执行前**明确拒绝**（`too-large-to-embed`），不静默截断；不依赖文件引用可达性，
  也不建设 ArtifactStore。
完整角色计划、prefer/角色默认、运行中改选、真实模型兼容性、Skill/MCP、费用与掉线恢复保持后续范围。

### 5.5 B4.4：有出处的交接和用户交付视图

最小受控范围独立 PASS。复用既有 TaskStore/AttemptStore、Workbench 的同次 Attempt→RunResult 证据映射与 RoundResult，
没有新增状态权威、ArtifactStore、报告平台、执行器或依赖。

- TaskSummary 增加可选 stale/staleReason/blockedReason，直接读取 Task；AttemptSummary 增加可选 evidenceState，
  区分本 Attempt 有空记录、无记录与旧报告未知。旧持久化字段缺失保持 unknown。
- renderRoundDelivery 是既有 round-result.ts 的纯渲染函数，既被完整 RoundResult 报告复用，也进入真实非 JSON CLI。
  每项可执行任务显示完整验收目标、任务/Attempt 来源、声明产物、观察到的写路径/命令、日志引用与过期/阻塞事实。
  root 是容器；声明路径不证明已产出，观察到的 write/edit 也不证明文件当前存在或内容已验收。
- 历史与最新工作 Attempt 分开；execution/rework 均保留各自文件/命令/日志并计入实际工作次数，review 不继承工作证据。
  缺少后一次证据不从前次回填；缺少执行分类确认不被写成“从未执行”。task lifecycle、review verdict 与测试结果分开。
- 兼容保留 testsRun 字段名，但交接 brief、机器报告和用户摘要均改称观察到的 shell 命令，不从名称/文本/exit 0 推断测试通过。
  结构化测试结果未提供时明确 UNREPORTED；不新增测试识别器或产物文件系统校验。
- gate、退出语义、调度、Assignment、Workspace/停止链不变；automaticPostRoundAction=NONE，PARALLEL_WRITE=CLOSED。
  真实模型、工具原生观测覆盖、产物物理认证与完整需求批准链不属于本片 PASS。

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
   B4.2 提供项目适配的结构化计划文件入口（自定义 sequential/collaborate 候选）；B4.2a 收口合法多入口写计划的
   顺序执行与 `decision.note` 的真实 gate 拒绝投影；B4.3/B4.3a 提供 opt-in 阶段材料 + 用户确认入口，
   显式工作流确认绑定与材料完整交付已验证；--stage + legacy 的未绑定入口写前拒绝，当前受控阶段已完成。
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

2026-10-14 本机页面与上传维护（不推进阶段）：磁盘快照此前已是 B4.4，但实时预览服务未运行，先前仅核对数据不能证明用户看到的页面已同步。本轮恢复受控终端中的只读预览 http://127.0.0.1:4318，并实际打开浏览器核对 B4.4 done / B4.5 待授权。服务停止后自动刷新停止；离线文件须重新生成并重新加载。后台常驻启动被自动安全检查拒绝（blocked by policy），未绕过该拒绝。此前 GitHub 上传确实漏做；本轮核对相对 777702f 的 13 文件差异和已审核代码哈希，但 Git TLS 握手及 GitHub MCP 连接均失败，上传仍未完成。拟保存本地 codex/b44-review-pass 快照等待续传，不宣称远程成功；不修改 main/共享暂存区，project-progress/ 全部不入 Git。

2026-10-13 B4.4：**Codex 独立 PASS（最小交付视图范围），本轮停止，B4.5 未启动**。

- 调查：先读既有 round-result/workbench-handoff、CLI、Attempt→RunResult 与 Task 的过期/阻塞来源。
  GitHub MCP repository search 本轮实际请求因传输错误失败；公开读取 [Spec Kit 官方 README](https://github.com/github/spec-kit)
  核对结构化需求/成果的方法，仅参考方法，未安装/复制框架，未宣称 MCP 成功或完成第三方 Windows/安全审计。
- 真实 wrapper 委派：C:/Users/Admin/.codex/bin/opencode-agent，role=implement，actual model
  opencode-go/deepseek-v4.1-flash。首次 session ses_eca7b22f4ffe2wm6REL4rMVicJ 的 54 条 assistant 元数据确认模型；
  该次运行在验证阶段被中断，末尾 finish=tool-calls，没有完整最终报告，不计为正常完成。
  唯一 bounded rework session ses_eca184726ffeeaT49TOHX7Wa0N 的 29 条 assistant 同模型，最终 finish=stop、wrapper exit=0。
- 中断后从首次 session step-start 的原树 cda409553eed744b3732a5763366b83aca516024 恢复审核对照，只读比较，不 checkout/reset。
  worker 改动严格为 6 个既有文件：round-result.ts、workbench-handoff.ts、round-cli.ts 及 round-result/workbench/b43 测试。
  其余源码、native、配置、依赖及先前 model-catalog smoke 保持字节/规范化 blob 不变。
- 首次独立 probe 复现两处实质错误：W(kind=rework) 有 new.ts/cmd-new/new-log，却被过滤为空，仍标 evidence=available；
  有实际 Attempt 但分类无确认的任务被写为 succeeded (never executed)。仅发放一次返工，在共享投影修正 execution/rework
  的来源与工作次数，并把分类缺失写成未确认。最终独立 probe 验证 W 自己的文件/命令/日志保留，E 是历史，V(review)
  不替代最新工作；W 缺失时不借 E，未分类不声称从未执行。
- 最终 Codex 实跑：typecheck PASS；round-result 346/0、workbench 419/0、b43-stage-material 47/0、
  b40a-cli-workflow 42/0、handoff-production-round 312/0、b42-plan-file 61/0、real-agent-isolation 5 opt-in / 0 违规，
  全部 exit=0；git diff --check PASS。真实 CLI fixture 写 owned 文件并校对文件→任务→Attempt 与完整目标；
  非 JSON CLI 确实输出同一交付视图、保持两次计划执行与最终 Human Gate NONE。
- Codex 只维护 6 份既有文档与 ignored 本机派生/审核元数据，不代写生产代码或测试。无 commit/push/stash/reset/clean，
  HEAD/共享暂存区不变；应用 turn-diffs 元数据与人工 Git 写流程分开。历史清理 P3 未绕过拒绝或冒称已清理。
- 未跑 full suite/产品真实 Agent 推理；worker 委派推理单独记录。观察到的路径不认证磁盘现状，
  命令列表不认证测试结果；未进 B4.5/B2/B3/B5/正式前端，B1/B4 overall 仍未封板。

2026-10-13 B4.3a 剩余单点：**Codex 独立 PASS，受控范围封板**。用户明确选择当前下一任务，限定逐阶段推进；本轮到此停止，B4.4 未启动。

- 真实委派：C:/Users/Admin/.codex/bin/opencode-agent，role=implement；首次 session
  ses_eca909bd0ffetOHeg245V41no1 与唯一返工 session ses_eca8b8b92ffesoLk1d0zE9o8wb 均从本地 session assistant
  元数据核实 provider/model 为 opencode-go/deepseek-v4.1-flash，分别 16/7 条 assistant，最终 finish=stop、进程 exit=0。
  模型证据不只来自环境变量；Codex 自身模型不变。
- OpenCode 只修改 src/cli/round-cli.ts 与 tests/b43-stage-material.test.ts。阶段门使用现有 refuse：
  --stage 未配 sequential/collaborate 时，exit=2、stage=stage-gate、provider/runtime/review=0、无任务列表；
  无确认、正确旧 legacy digest、stage-check 三类均拒绝，位置在文件读取与外部调用/任务创建之前。
- 首次独立审核发现新兼容断言只证明 provider 被调用，未证明派发；仅发放一次 bounded rework。
  最终断言要求无 --stage/--workflow 的旧入口 report.stage=complete、实际 requests=1、exit=0、prompt 无阶段上下文。
  未扩建 planner/审批系统、未重写 B4.2，不新增 authority/依赖。
- 独立内存负控（首次审核版本，未改磁盘代码）：关闭新增 guard 后，三个拒绝回归稳定失败，33/3、exit=1；
  其中旧合法 digest 实际进入 complete、runtime=1，stage-check 错误产出成功 digest，证明回归承重。
- 独立 helper probe：无阶段材料的 legacy 实际 requests=1、provider=4、exit=0；受支持 collaborate 的 stage-check
  exit=0、provider/runtime=0。临时根按实际返回路径逐个验证边界后清理，无新 Git worktree。
- 唯一返工后 Codex 实跑：typecheck PASS；b43-stage-material 36/0、b42-plan-file 61/0、b40a-cli-workflow 42/0、
  b14-selection 46/0、round-result 293/0、real-agent-isolation 5 opt-in / 0 违规，全部 exit=0；git diff --check PASS。
  原 model-catalog smoke 测试保留原字节；native/其他生产模块、配置、安装与凭据均未修改。
- Codex 只维护 6 份既有文档和 ignored 本机派生快照，不代替 worker 改生产/测试。未 commit/push/stash/reset/clean；
  HEAD、业务 refs 与共享暂存区保持；应用自身 turn-diffs 元数据更新与人工 Git 写流程分开。
- 未跑 full suite、未通过产品调用真实 Agent 推理；worker 自身委派推理与产品真机验收分开。历史 reviewer worktree
  的工具清理 P3 不在本轮删除。PARALLEL_WRITE=CLOSED，B1/B4 overall 仍 NOT SEALED。

历史：上轮 Codex B4.3a 独立审核 **BLOCKED**；下列保留当时复现与修复建议，剩余单点已由上方本轮关闭。

- 已关闭原显式计划复现：经真实 CLI stage-check 获取 digest 后，同 ID 改交付、改变 objective 均写前拒绝
  （exit=2、provider=0、runtime=0）；gate 后在受控 provider 首次调用时替换磁盘计划，执行仍用冻结的原计划
  （2 次执行、exit=0、RunRequest 无替换标记）。仅格式/键序的归一化不改变有效内容。
- 已关闭原材料截断复现：完整长 requirement 与关键尾部进入每个 RunRequest、尾部进入验收材料请求；
  超上限在 stage-check 拒绝（exit=2、provider=0、runtime=0）。关键内容直接内联，不依赖隔离 cwd 的源文件路径。
- **剩余 P1（确认绑定的同一要求）**：允许 --stage 不带 --workflow；normalizedPlanScope(undefined,null)
  返回 null，确认先通过，后续才分类并生成 legacy 计划。独立受控 CLI probe 对同一材料/目标/确认
  （digest 前缀 c755d2f84ff3），small 接受 root+s1，moderate 接受 root+c1+c2+c3；两次 exit=0，均实际派发
  1 次。未声称三步骤全部执行；事实是同一确认覆盖不同的已提交实际计划。
- 最小下一步建议：暂在阶段门拒绝 --stage 与无 --workflow 的组合，保持无 --stage 旧入口；
  或真正展示、冻结并绑定 legacy 的有效范围。优先前者，不建设审批平台、不重写 planner，不自动委派第三轮实现。
- 本轮独立实跑：typecheck PASS；b43-stage-material 32/0、b42-plan-file 61/0、b40a-cli-workflow 42/0、
  b14-selection 46/0、round-result 293/0、real-agent-isolation 5 opt-in / 0 违规，全部 exit=0；
  加上述独立确认/冻结/长材料/legacy probes。常规 suite 通过不能覆盖剩余 P1。
- 本轮 probe 记录的临时根已逐个清理，无新建 Git worktree；此前 B4.3 reviewer worktree 的工具清理限制
  仍是历史 P3，不提升为本轮残留 0。未跑 full suite/真实模型、不读凭据、不改本机配置。
- 生产 runtime.run 调用边仍为 1，无新增调度 authority；PARALLEL_WRITE=CLOSED。

本轮 B4.3a（2026-10-13，实现方实跑，hermetic）：`b43-stage-material` **32/0**（经真实 `runRoundCli` +
真实 `parseStageMaterial`/`stageBindingDigest`/`normalizedPlanScope` + 受控 provider/runtime，运行时真实读写 owned 文件）；
`b42-plan-file` 61/0、`b41-collab-group` 91/0、`b40a-cli-workflow` 42/0、`b40-workflow` 41/0、b14-selection 46/0、
round-result 293/0、decision 397/0、state-loop 169/0、workbench 413/0、handoff-production-round 312/0、
assignment 235/0、contract 248/0（2 skipped）、unit 92/0；isolation 守卫 5 opt-in/0 违规；typecheck PASS、
`git diff --check` clean；生产 `runtime.run` 调用边=1、新增调度 authority=0、owned 残留 0。
- P1-1：确认别的 plan id、同 id 改交付、改 objective、无 planRef 换计划，均在写前拒绝（`stage-gate`、runtime=0、
  provider=0、exit=2）；正确计划正常运行；键序/空白变化不改变 digest；`stage-check` 显示有效计划摘要与 digest。
- P1-2：~1000 字 requirement 的尾部 `CRITICAL_DO_NOT_CHANGE_DATABASE_SCHEMA` 完整出现在每个任务 brief 与验收材料请求；
  超可交付上限的材料在写前以 `too-large-to-embed` 拒绝（runtime=0）。
- 缺材料/缺确认/别阶段/自我批准仍拒绝、provider 从不被调用；无 `--stage` 旧入口不变；fixed 仍强制。
上述为本轮 hermetic 证据；未跑 full suite、未调用真实模型、未读凭据、未改本机配置、未开放并行写。
（注：fixture 只证明材料进入 RunRequest/验收链，不证明真实 Agent 已加载或遵守材料；不把源目录写入冒充隔离目录开发。）

历史：2026-10-13 Codex B4.3 独立审核 **BLOCKED**；下列为修复前事实，当前状态以上方 B4.3a 独立结论为准。
独立实跑：typecheck PASS；b43-stage-material 21/0、b42-plan-file 61/0、b40a-cli-workflow 42/0、
b14-selection 46/0、state-loop 169/0、round-result 293/0；isolation 守卫 5 opt-in/0 违规，均 exit=0。

- P1-1：stageMaterialDigest 只绑定材料字段，不绑定实际 objective、workflow 及计划内容；planRef 没有与所选计划核对。
  独立真实 CLI/编排链 + 受控 provider/runtime：材料 planRef=stage-flow，沿用 digest 换成 unapproved-plan，仍 requests=2/exit=0；
  改后的交付要求进入实际 RunRequest。保留 stage-flow ID 但修改计划交付要求，旧确认同样被接受。
  确认材料存在不代表实际计划/范围被该确认覆盖；先绑定有效执行输入，再允许执行，不用模型判断自然语言是否相似。
- P1-2：boundedStageContext 把每个字段截到 600 字符，却只提供 stage.json@digest12 的相对标签。
  独立 owned Git repo + 实际 WorkspaceManager + 声明 isolated 能力的受控适配器：首个写任务 cwd 是真实隔离 worktree，
  stage.json 留在源目录未提交，worktree 中不存在该相对材料；1028 字需求末尾的 CRITICAL_DO_NOT_CHANGE_DATABASE_SCHEMA
  不在任何 runtime prompt，且首任务无法按相对引用获得全文，执行仍被接受。该 probe 只认证引用可达性与 prompt 内容，
  不把 fixture 写入源目录的行为认证为真实 Agent 在隔离目录完成开发。
  必要关键约束必须完整可用；全文/已批准快照无法可靠交付时先明确拒绝。不能把这项已有 B4.3 验收要求全部推迟到 B4.4。

原 B4.2a 分类 P2 已关闭：独立 receipt probe 的 dependency-only 为等待，混合项主码为 resource-unavailable，并保留两任务。
round-cli.ts 恢复核对：与父快照比较，排除明确的 B4.3 插入及 objective 替换后，TypeScript token 序列完全相等，
包括字符串/模板字符串内部空白；没有仅凭 normalizeWhitespace 相等认证恢复，也未发现额外 baseline token 改变。
生产 runtime.run 调用边保持 1，新增调度 authority=0；Codex 本轮不修改生产代码/测试。

本轮 reviewer-owned probe：源临时目录按记录逐个清理；剩余 1 个真实 Git worktree（仅 .git/README.md 两个 fixture 文件），
路径为 %TEMP%/.p4m-worktrees/b43-mlqsLd-round-mv6mspa4-w1。对确切目录的非递归清理亦被自动安全检查拒绝，
返回 blocked by policy；未改用其他方式绕过。该工具限制记 P3，不能宣称本轮 reviewer 残留为 0，不属于生产 B4.3 根因。
未跑 full suite/真实模型，未读取凭据/改本机配置。该轮提出的两项修复及后续 legacy 单点均已独立复核关闭；本轮不启动 B4.4 或正式前端。


B4.3 实现方报告（独立结果以上文为准，2026-10-13，hermetic）：`b43-stage-material` **21/0**（经真实 `runRoundCli` +
真实 `parseStageMaterial`/digest + 受控 provider/runtime，运行时真实读写 owned 工作区文件）；`b42-plan-file` 61/0、
`b41-collab-group` 91/0、`b40a-cli-workflow` 42/0、`b40-workflow` 41/0、decision 397/0、state-loop 169/0、
round-result 293/0、workbench 413/0、handoff-production-round 312/0、b14-selection 46/0、contract 248/0（2 skipped）、
unit 92/0；isolation 守卫 5 opt-in/0 违规；typecheck PASS、`git diff --check` clean；生产 `runtime.run` 调用边=1、
新增调度 authority=0、owned 残留 0。
- 缺材料 / 缺确认 / 确认别阶段：均在 gate 处拒绝（`stage:'stage-gate'`、exit=2），runtime=0、无 tasks、provider 从未被调用。
- 自我批准：材料带 `approved` 被拒（`self-approval`）；provider 在 gate 失败时从不被调用，模型/工具输出无法批准。
- `--stage-check`：只读预检，打印 digest 与待办，runtime=0、exit=0。
- 确认后：plan-file 走真实链、写出 owned 文件、`ok/exit=0`；任务 brief 与验收材料请求均含阶段 requirement/acceptance
  与 `ref <file>@<digest12>`；Review completed；`automaticPostRoundAction=NONE`；一个 `--confirm` 覆盖整轮、无需逐任务重复确认。
- scope 变更后旧确认失效（`does not match`、runtime=0）；无 `--stage` 时旧入口不变；fixed 仍被强制。
- P2：`applyDecision` 的 dependency-only 记为等待、mixed receipt 主码取真实 `resource-unavailable` 并保留等待项、
  容量仍为 `no-free-slot`。
上述为本轮 hermetic 证据；未跑 full suite、未调用真实模型、未读凭据、未改本机配置、未开放并行写。

2026-10-13 Codex B4.2a 独立审核：**PASS WITH P2**。受控顺序计划/协作组范围封板，B4 整体仍未封板。
独立实跑：typecheck PASS；b42-plan-file 61/0、b41-collab-group 91/0、b40a-cli-workflow 42/0、
resource-claim 192/0、decision 397/0、planner 189/0、state-loop 169/0；isolation 守卫 5 opt-in/0 违规，均 exit=0。
独立 CLI probe（真实编排链、受控 provider/runtime）：显式 [] 两步骤执行 2 次、duo 执行 3 次，max effective writers=1；
集成消费两成员实际字节、复用成员 2 的 pair 且 session 独立；混合依赖环写前拒绝，requests=0、无部分 tasks。
内存负控仅退回旧依赖规则，复现 requests=0/exit=1/no-progress；新 report.decision.code=resource-unavailable 且 note 保留实际拒绝。
CRLF 属性负控使用临时独立 index：真正尾部空格仍被 git diff --check 检出，共享 index/生产源码未变。

剩余 P2（不阻断后续）：decision.ts 把所有 taskId!='*' 的 skipped 都当 gate refusal；真实 Scheduler 的 dependency-unmet
只是等待前置。独立 receipt probe：只有依赖等待也显示 gate refused；[dependency-unmet,resource-unavailable] 混合时主 code
取 dependency-unmet，虽然 note 仍列出实际资源拒绝。这是报告分类/主码问题，不影响准入、停止或顺序执行。
随 B4.3 接线附带修正并补两个小回归，不另开 P2-only 封板轮次。PlanFileStep 的 [] 注释仍是旧语义，随同维护；
实际生效规则为声明依赖加顺序链，后项依赖更后项形成的环写前拒绝，不承诺任意顺序 DAG 自动重排。

Codex 本轮只更新文档和本机派生快照，未改生产代码/测试。下一任务 B4.3 材料与阶段确认待用户下发，不自动开始。
未跑 full suite、未调用真实 Agent 推理；Git 协作合并、费用/工具/恢复和正式前端继续保持未验证/未实现边界。


本轮 B4.2a（2026-10-13，实现方实跑，hermetic）：`b42-plan-file` **61/0**（经真实 `runRoundCli` + 真实
`parsePlanFile`/链式候选构造 + 受控 provider/runtime，运行时真实读写 owned 工作区文件）；`b41-collab-group` 91/0、
`b40a-cli-workflow` 42/0、`b40-workflow` 41/0、planner 189/0、workbench 413/0、resource-claim 192/0、
decision 397/0、state-loop 169/0、handoff-production-round 312/0、b14-selection 46/0、assignment 235/0、
initial-assignment-decision 37/0、contract 248/0（2 skipped）、unit 92/0；isolation 守卫 5 opt-in/0 违规；
typecheck PASS、`git diff --check` clean；生产 `runtime.run` 调用边=1、新增调度 authority=0、owned 残留 0。
- P1 关闭：显式 `dependencies: []` 的多入口写计划（sequential 两写步骤 / collaborate 两成员）现在**按序执行**：
  同一 CLI 链真实写出各自 owned 文件、最大有效写者=1、协作集成消费所有成员实际字节、ok/exit=0。
  链规则（`chainDependencies`）已直接断言：声明 `[]` 保留、执行顺序以链边加入；前向合法依赖（step3 额外依赖 step1）
  正常完成；显式后向边 + 默认链形成的环在**写前**按 `dependency-cycle` 拒绝、requests=0、无 tasks。
- P2 关闭：`applyDecision` 的 `continue` 未准入时从 receipt 的 `skipped`/`waiting` 如实投影——真实 gate 拒绝
  （任务+`resource-unavailable`+原因）被命名，`report.decision.code` 带上码；"waiting for capacity" 与"被拒"分开；
  旧的 "nothing was denied by the gate" 措辞在确有拒绝时不再出现（负控断言）。
- 附带：`.gitattributes` 为遗留 CRLF 文件 `decision.ts` 声明 `whitespace=cr-at-eol`，使 `git diff --check` 只报真实空白错误。
上述为本轮 hermetic 证据；未跑 full suite、未调用真实模型、未读凭据、未改本机配置、未开放并行写。

上一轮 B4.2 独立审核（已由本轮关闭原 P1）：typecheck PASS；b42-plan-file 44/0、b41-collab-group 91/0、b40a-cli-workflow 42/0。
独立 CLI probe 使用真实编排链 + 受控 provider/runtime：多候选选中 second 且只问一次；显式/默认依赖混合的环写前拒绝、requests=0。
新 P1：合法 sequential 的两个写步骤均 dependencies:[]（collaborate 成员亦同）被接受和分配，
但 Scheduler 实际两项均 resource-unavailable，runtime requests=0、exit=1、workflow.stop=no-progress。
最终 decision.note 却描述为没有 free slot/ready task、没有 gate 拒绝。保护有效，未发生并行写逃逸；这是可用性与拒绝报告收口。
仅把测试入口 max-concurrent 从 2 调为 1 的独立对照也未成功，不能宣称 cap=1 是充分修复。
本轮不修改生产源码/测试；新增路线、任务文档与本机页面，不把默认链式 44/0 提升为所有合法输入封板。
后续先 B4.2a，再接需求/阶段材料确认。完整新目标尚未真机验收；未跑 full suite/真实模型。


本轮 B4.2（2026-10-13，实现方实跑，hermetic）：`b42-plan-file` **44/0**（经真实 `runRoundCli` +
真实 `parsePlanFile`/共享候选构造 + 受控 provider/runtime，运行时真实读写 owned 工作区文件）；
`b41-collab-group` 91/0、`b40a-cli-workflow` 42/0、`b40-workflow` 41/0、b14-selection 46/0、
initial-assignment-decision 37/0、assignment 235/0、workbench 413/0、planner 189/0、decision 397/0、
handoff-production-round 312/0、state-loop 169/0、contract 248/0（2 skipped）、unit 92/0；
isolation 守卫 5 opt-in/0 违规；typecheck PASS、`git diff --check` clean；生产 `runtime.run` 调用边=1、
新增调度 authority=0、owned 残留 0。
- 自定义顺序计划：文件声明的 role/路径（如 `api-research`/`docs/api/**`）与内置模板不同，按序执行、
  下游 brief 含上游**实际输出**、每步写各自声明范围文件、ok/exit=0；单候选不发 LAYA 问题、来源按规则记录。
- 自定义双成员协作：成员写真实文件、集成任务读取并组合**实际字节**成 `combined.txt`、集成者复用成员 1 pair
  且拥有独立 task/session、整轮仅 2 个 pair、最终 Review completed/pass。
- 自定义三成员 sanity：三个不同 pair、独立 task/session、集成者为文件指定的成员 2、集成产物含三者字节。
- 非法输入无部分提交：悬空依赖、依赖环、重复角色、越界集成者、四成员、超步骤/超计划/超长字段、未知 taskType、
  重复 plan id、kind 与 `--workflow` 不匹配，均在写入前拒绝；端到端拒绝时 requests=0、无 tasks、非零退出。
- 未交付负例：成员运行但不写文件/空输出 → 停 `to_verify`，集成从不运行、无 `combined.txt`、非零退出并列出阻塞成员。
- 兼容：内置 full/lean/duo/trio 行为不变；文件 plan id 可被 `--workflow-choice` 固定；未知固定 id 被拒绝不替换。
上述为本轮 hermetic 证据；未跑 full suite、未调用真实模型、未读凭据、未改本机配置。

上一轮 B4.1a 独立审核（2026-10-13）：**PASS**。Codex 仅更新文档，未修改生产代码或测试。
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

## 新草案重排与本机进度页

用户本轮授权根据草案整理计划、任务和独立进度页；没有授权实施新后端切片。
路线见 [BACKEND_DELIVERY_PLAN.md](BACKEND_DELIVERY_PLAN.md)，下一任务见 [NEXT_TASK.md](NEXT_TASK.md)。
进度页位于被 Git 忽略的 project-progress/，只派生下面的维护快照；不读取 Runtime 或凭据，不作为第二状态权威。
完成度以新草案后端目标为分母：十项权重共 100、当前已实现信用 56，按 5 点粒度报告约 55% 完成 / 约 45% 剩余。
阶段确认信用为 3/12；本轮最小交付视图独立通过，成果/交接信用由 5 调为 7/10。产物认证、结构化测试结果与完整批准链仍缺。
合理剩余区间 40–60%，属于工程规划估算，不是客观测试统计、承诺工时或正式前端完成度。
每次任务推进更新事实和快照后运行 node project-progress/refresh.mjs；实时预览从本文读取，不伪造任务推进。

<!-- project-progress:begin -->
```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-10-14T00:05:17+08:00",
  "title": "LAYA 个人工作台",
  "scope": "新草案对应的后端完整使用效果；不包含正式产品前端",
  "current": {
    "id": "B4.4",
    "name": "有出处的交接和用户交付视图",
    "status": "done",
    "summary": "Codex 独立 PASS：完整验收目标与同次任务/Attempt 证据进入 JSON 与实际命令行；声明、观察、未知/过期/阻塞分开，返工证据不丢失，命令不冒充测试结果。首次实现 + 一次返工后止于本阶段。"
  },
  "next": {
    "id": "B4.5",
    "name": "Git 项目中的顺序协作（待单独授权）",
    "authorized": false
  },
  "parallelWrite": "CLOSED",
  "frontend": "本机进度页已授权；正式工作台前端待需求确认",
  "estimate": {
    "method": "按十项能力加权的工程判断；不是测试数、工时或代码统计。不得用任务数直接计算。",
    "remainingRange": [
      40,
      60
    ],
    "capabilities": [
      {
        "name": "执行、身份与物理停止",
        "weight": 20,
        "earned": 20,
        "basis": "T/W 底座历史独立封板；保留环境 P2，未本轮全量重测"
      },
      {
        "name": "发现、模型池与用户选择",
        "weight": 12,
        "earned": 8,
        "basis": "目录、auto/fixed 已有；实际模型、角色默认和动态选择不足"
      },
      {
        "name": "功能 A/B 与项目计划",
        "weight": 18,
        "earned": 14,
        "basis": "B4.2/B4.2a 独立受控 PASS WITH P2；Git 协作、阶段材料和真实验收仍缺"
      },
      {
        "name": "需求与阶段确认",
        "weight": 12,
        "earned": 3,
        "basis": "最小 opt-in 阶段确认/绑定/完整内联已独立 PASS；完整需求/总体计划/阶段批准链未验收"
      },
      {
        "name": "成果、交接与真实验证报告",
        "weight": 10,
        "earned": 7,
        "basis": "B4.4 最小有出处交付视图独立 PASS；声明/观察/未知分开，同 Attempt 的返工证据保留；产物物理认证和结构化测试覆盖仍缺"
      },
      {
        "name": "监督与用户纠偏",
        "weight": 5,
        "earned": 0,
        "basis": "草案已明确方向，检查点接线尚未实施"
      },
      {
        "name": "Skill/MCP 与按需上下文",
        "weight": 8,
        "earned": 1,
        "basis": "部分 intent/原生能力，目录和调用核对未闭环"
      },
      {
        "name": "费用、额度与消耗覆盖",
        "weight": 5,
        "earned": 1,
        "basis": "既有 quota/预算底座，全流程费用策略未验收"
      },
      {
        "name": "中断接力与最小历史",
        "weight": 6,
        "earned": 1,
        "basis": "已有停止与 continuation；自动恢复边界未闭环"
      },
      {
        "name": "代表性真实用户验收",
        "weight": 4,
        "earned": 1,
        "basis": "有历史单 Agent 证据，新使用效果尚未完整真机验收"
      }
    ]
  },
  "blockers": [
    {
      "id": "B43-P3-CLEANUP",
      "severity": "P3",
      "title": "独立 probe 的两文件目录待手动清理",
      "detail": "1 个自有 Git worktree 仅含 .git / README.md；确切目录清理被工具安全检查以 blocked by policy 拒绝，不是生产代码缺陷。",
      "next": "用户手动删除已记录目录",
      "kind": "工具限制"
    },
    {
      "id": "GIT",
      "severity": "范围限制",
      "title": "Git 项目协作交付路径缺失",
      "detail": "现有 collaborate 主动拒绝 Git 隔离工作区；成员产物尚不能受控送入集成者工作区。",
      "next": "B4.5",
      "kind": "已有事实"
    },
    {
      "id": "APPROVAL",
      "severity": "产品缺口",
      "title": "需求到阶段确认仅最小入口",
      "detail": "最小阶段确认入口及有出处交付视图已通过；完整需求/总体计划/阶段批准链与用户流程未验收。",
      "next": "后续需求闭环 / B4.6",
      "kind": "部分实现"
    },
    {
      "id": "REAL",
      "severity": "验收缺口",
      "title": "真实多模型与成本证据不足",
      "detail": "fixture 不能认证真实可调用、身份、隔离或免费资格；DSH 仍不支持逐请求选模型。",
      "next": "B2.1 / B4.7",
      "kind": "未验证"
    },
    {
      "id": "LOCAL-UI",
      "severity": "本机维护",
      "title": "旧临时页面待手动删除",
      "detail": "temporary-dashboard/ 的 20 个源码文件已压缩并逐字节验证；递归删除被工具安全策略拒绝，目录尚在。这不阻塞后端开发。",
      "next": "用户手动删除旧目录",
      "kind": "工具限制"
    }
  ],
  "tasks": [
    {
      "id": "T/W",
      "title": "执行与 Windows containment 底座",
      "status": "done",
      "deliverable": "既有身份、停止和资源保护",
      "evidence": "历史独立审核；环境 P2 保留"
    },
    {
      "id": "B1",
      "title": "目录、基础接入和 auto/fixed",
      "status": "partial",
      "deliverable": "本机 Agent 与具体模型选择底座",
      "evidence": "已封板子片；B1 整体未封板"
    },
    {
      "id": "B4.0",
      "title": "功能 A · 跨角色顺序分工",
      "status": "done",
      "deliverable": "调研 → 实现 → 测试 → 审核",
      "evidence": "历史受控封板；本轮 b40a 42/0"
    },
    {
      "id": "B4.1a",
      "title": "功能 B · 2–3 模型分工集成",
      "status": "done",
      "deliverable": "独立任务/会话，指定成员集成",
      "evidence": "历史独立受控 PASS；本轮未重跑 b41"
    },
    {
      "id": "B4.2",
      "title": "项目适配的计划文件",
      "status": "done",
      "deliverable": "自定义职责、路径、交付和依赖",
      "evidence": "与 B4.2a 一起独立 PASS WITH P2；受控链路范围"
    },
    {
      "id": "B4.2a",
      "title": "合法依赖与顺序执行收口",
      "status": "done",
      "deliverable": "合法输入按序推进或写前明确拒绝，准确 gate 报告",
      "evidence": "原 P1 独立关闭；报告分类 P2 本轮亦关闭"
    },
    {
      "id": "B4.3",
      "title": "需求与阶段材料确认",
      "status": "done",
      "deliverable": "批准绑定材料、范围与阶段",
      "evidence": "最小 opt-in 入口独立 PASS；仅显式 sequential/collaborate，不等于完整批准链"
    },
    {
      "id": "B4.3a",
      "title": "阶段确认与材料交付收口",
      "status": "done",
      "deliverable": "实际计划/范围绑定；关键约束完整可达或写前明确拒绝",
      "evidence": "独立 36/0 + guard 负控 + 旧入口/协作预检 probes；一次返工补实际派发断言"
    },
    {
      "id": "B4.4",
      "title": "交接、成果与验证视图",
      "status": "done",
      "deliverable": "可读交付与真实测试，未知不冒充通过",
      "evidence": "独立 RoundResult 346/0、Workbench 419/0、阶段 CLI 47/0；两处证据问题经唯一返工关闭"
    },
    {
      "id": "B4.5",
      "title": "Git 项目顺序协作",
      "status": "planned",
      "deliverable": "成员真实差异可交集成，保护用户脏文件",
      "evidence": "下一候选，尚未启动；先比较现有工作区/合并路径再选最小路线"
    },
    {
      "id": "B3.1",
      "title": "Skill/MCP 最小闭环",
      "status": "planned",
      "deliverable": "目录 → 选择 → 实际加载/调用核对",
      "evidence": "从一个原生 Agent 接口开始"
    },
    {
      "id": "B2.1",
      "title": "模型池与费用策略",
      "status": "planned",
      "deliverable": "免费优先/已授权付费、共享额度与覆盖",
      "evidence": "未知费用不默认为零"
    },
    {
      "id": "B4.6",
      "title": "检查点监督与用户纠偏",
      "status": "planned",
      "deliverable": "异常阻止后续派工，用户决定纠偏",
      "evidence": "不增加第二个调度权威"
    },
    {
      "id": "B5.1",
      "title": "模型掉线的有界接力",
      "status": "planned",
      "deliverable": "保留部分成果，停旧执行后再接手",
      "evidence": "不盲重放写任务或自动跨阶段"
    },
    {
      "id": "B4.7",
      "title": "真实 Agent 代表验收",
      "status": "planned",
      "deliverable": "成功、受阻与真实成本/停止证据",
      "evidence": "需用户模型、费用与数据授权"
    },
    {
      "id": "F0",
      "title": "正式工作台前端需求确认",
      "status": "planned",
      "deliverable": "确认流程后再设计正式 UI",
      "evidence": "当前进度页只是本机状态展示"
    }
  ],
  "checks": [
    {
      "name": "typecheck",
      "result": "PASS",
      "source": "Codex 最终独立实跑"
    },
    {
      "name": "round-result / workbench",
      "result": "346 / 419 · 全通过",
      "source": "Codex 最终独立实跑"
    },
    {
      "name": "b43 / b40a / handoff / b42",
      "result": "47 / 42 / 312 / 61 · 全通过",
      "source": "Codex 最终独立实跑"
    },
    {
      "name": "real-agent-isolation",
      "result": "5 opt-in / 0 违规",
      "source": "Codex 本轮实跑"
    },
    {
      "name": "返工证据 / 缺失分类 / review 分离",
      "result": "PASS · 不丢失、不借用、不伪造未执行",
      "source": "独立真实聚合 helper probe"
    },
    {
      "name": "worker 模型 / 返工",
      "result": "DeepSeek V4.1 Flash · 仅一次返工",
      "source": "两次 session 元数据；首次验证中断，返工正常完成"
    },
    {
      "name": "git diff --check",
      "result": "PASS",
      "source": "Codex 本轮实跑"
    },
    {
      "name": "full suite / 产品真实模型",
      "result": "NOT RUN",
      "source": "worker 委派推理不提升为产品验收"
    },
    {
      "name": "本机实时进度页",
      "result": "已恢复 · B4.4 done / B4.5 待授权",
      "source": "实际浏览器显示核对；受控终端服务，停止后不自动刷新"
    },
    {
      "name": "GitHub 上传",
      "result": "PENDING · TLS / MCP 连接失败",
      "source": "本轮真实远程请求失败；本地快照待续传，不宣称上传成功"
    }
  ],
  "sources": [
    {
      "title": "唯一当前基准",
      "path": "docs/PROJECT_BASELINE.md"
    },
    {
      "title": "新交付计划",
      "path": "docs/BACKEND_DELIVERY_PLAN.md"
    },
    {
      "title": "下一任务",
      "path": "docs/NEXT_TASK.md"
    },
    {
      "title": "需求与效果草案",
      "path": "docs/DRAFT_STAGED_ROLE_WORKFLOW.md"
    }
  ]
}
```
<!-- project-progress:end -->

本机页面交付：无依赖静态文件 + 从本文刷新快照；桌面页面/筛选已核对，窄屏 DOM 无横向溢出。
旧 temporary-dashboard 源码 20 文件已压缩并逐字节验证，备份在 ignored 的 project-progress/legacy-dashboard-source.zip；
递归删除被工具安全策略拒绝（blocked by policy），旧目录尚在，未绕过拒绝；这项是本机维护限制，不是后端 P1。

本轮上传说明：计划重排与 B4.2 独立发现保存为 codex/b42-plan-realignment-blocked 快照，父提交 9980db2；
包含现有 B4.2 实现与审核事实、草案、计划、任务和维护规则，不宣称 B4.2 封板。
project-progress/ 全目录及旧 temporary-dashboard/ 均忽略、不进入快照；主分支与共享暂存区不动。准确提交见会话交付。

本轮 B4.2a 独立 PASS WITH P2 上传快照：父 b751ffe，分支 codex/b42a-review-pass-with-p2。
只保存当前修复与独立审核/下一任务文档；project-progress/ 不入 Git，主分支和共享暂存区不改。

本轮 B4.3 独立 BLOCKED 快照上传：父 9c3aa28，分支 codex/b43-review-blocked。
保存现有实现与独立事实，不自行修复、不封板；本机页面/备份/探测脚本不入 Git，main/共享暂存区不改。

本轮 B4.3a 独立 BLOCKED 快照：父 4f840ee，分支 codex/b43a-review-blocked。
保存开发方实现、独立结论与下一单点建议；不封板、不自动返工，project-progress/ 全部不入 Git，main/共享暂存区不改。
