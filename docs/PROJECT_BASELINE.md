# 项目基线 — 唯一当前状态入口

更新日期：2026-10-16
性质：当前事实、阶段状态、授权边界与证据索引；不是未来能力承诺。

## 1. 文档权责

**本文是唯一当前项目状态与阶段基准。**
[后端需求](BACKEND_REQUIREMENTS.md) 管目标及验收，[阶段分析](STAGE_ANALYSIS.md) 管建议顺序和下一任务范围。
架构、LAYA、协作、Round、执行证据与 native 文档只细化相应契约，不另行宣布阶段封板。
README 是导航。本机 `project-progress/audit/` 是用户指定的只读第三方观察日志；每任务开始读取一次，不修改、不上传，不强制采纳，也不取代本基准或独立证据。用户明确指令优先；发现源码、证据与基线不一致时核验并修正，不能以文档覆盖事实。

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
| B4.5 / B4.5a | 独立 PASS；Git根目录/committed base/单组隔离worktree顺序协作与审核保护的受控最小范围 |
| B3.1 | 独立 PASS：用户声明候选→LAYA任务级原生Skill请求→有来源的工具观察；仅受控最小范围 |
| B3.2 | 独立 PASS：仅OpenCode用户声明Server/Tool候选→advisory请求→名称匹配事件观察；非真实MCP调用认证 |
| B3 overall | 整体未封板；真实工具调用、强制限制与Skill加载尚未验收 |
| B2.1 / B2.1a | 独立 PASS：用户声明池的候选/分配/最终同步启动准入受控闭环；两个历史P1已关闭 |
| B2.2 | 候选来源接线代码独立PASS；整体PASS WITH P2（worker末尾报告未完成）；新增声明pair保持unknown，非可调用/额度证据 |
| LAYA-ENV.1 | 既有0.3.21环境/固定缓存恢复及真实离线CUDA加载+health独立PASS；无推理，检查后已停止，不是常驻服务或决策验收 |
| LAYA-DECISION.1 | BLOCKED：授权4次，首个中文分类因官方action对象被误当字符串任务参数而拒绝，1/4后停；Job空/清理通过，余3项未运行 |
| LAYA-COMPAT.1 | 独立PASS：官方action元数据兼容/任务参数隔离/非法输入拒绝；捕获响应离线回放通过，无新增真实推理 |
| LAYA-DECISION.2 | 独立真实PASS：4/4本地typed调用，中英文分类/计划/pair均经生产provider校验；无产品Agent，非完整round，Job空/清理通过 |
| LAYA-ROUND.1 | 只读审核BLOCKED：原生动作输出缺complete必需taskId，协议反例复现；四预设PASS保持，无新推理/修复 |
| LAYA-ACTION.1 | 代码独立PASS；整体PASS WITH P2（既有B45负控定位）。workflow候选明确绑定complete目标，原生形状CLI回归通过，无真实推理 |
| LAYA-ACTION.2 | BLOCKED：真实3/3均continue；协议安全通过但正向目标未被选择，离线编码证明双目标验收材料被512-token预算截掉；无追加调用 |
| LAYA-CONTEXT.1 | 代码独立PASS；统一保守512限制保留，原容量文案P2在QUALITY.1关闭。双目标实际编码全量可见，超限/未知响应在动作应用前拒绝，无新增真实推理 |
| LAYA-ACTION.3 | BLOCKED：修复后真实3/3仍continue；494/278/276 tokens均无state截断，协议/安全通过，正向目标完成仍未观察；不追加重试 |
| LAYA-QUALITY.1 | 候选资格过滤独立PASS：无ready不提供continue、wait/abort及明确complete保留；历史回放/负控/定向测试通过，无新增推理；真实模型质量仍待验收 |
| LAYA-QUALITY.2 | 真实BLOCKED：首例wait、任务不变，465 tokens零截断；1/2后fail-stop，第二例未运行；Job空/清理通过，未追加重试 |
| LAYA-BOUNDARY.1 | 只读职责审核完成；状态Verification不等于内容核验，整轮Review仍在workflow完成后运行；显式人工兜底随后由B4.6b实现 |
| B2 overall | NOT SEALED；账户资格/硬金额预算/付费与全流程费用未验收 |
| B4.6a | 最小同进程用户检查点独立通过；原报告文案P2在B5.1关闭，不等于完整监督/纠偏恢复 |
| B4.6b | 独立PASS：同进程显式人工accept，等待后同步重读当前Task/Attempt/RunResult/停止事实，经同一Verification；非LAYA自动质量验收 |
| MVP-READINESS.1 | 只读收敛PASS；真实CLI三个本地预检/门规则核对通过，最短执行仍需LAYA健康和新调用范围；非完整真实round验收 |
| MVP-E2E.1a | 独立PASS：显式Round累计POST发送前硬限、失败不退还、并发/跨入口/421与重定向离线验证通过；非真实E2E授权 |
| MVP-E2E.1 | 三次真实均PARTIAL；第三次NEW→write→test2/0但产物加demo/，POST2、Worker1、accept0/Review0；Job空/清理通过，真实调用关闭 |
| MVP-E2E.1b | CONDITIONALLY ACCEPTED：Recon修复有限准入；26 pre-existing B5.1-WF failures remain open，仅豁免固定pair/顺序/无接力MVP，不封板整个handoff；真实调用关闭 |
| MVP-E2E.1c | 离线核对完成 / FIX_REQUIRED：cwd与交接路径无重写；Demo需明确路径/职责，checkpoint超时被误归user-stop需最小生产修复；本轮未实施 |
| LAYA-HEALTH.1 | 独立PASS：无监听/生产Node ECONNREFUSED定位，一次owned离线双checkpoint CUDA加载+health+停止；非推理验收、非默认常驻 |
| B5.1 | 独立 PASS WITH P2：已知session_failure的停止安全/具体model有界接力；仅受控当前链 |
| B5 overall | NOT SEALED；真实协议掉线、完整工作流恢复及更广错误分类未验收 |
| B4.7 | B4.7.3固定free duo代表样本独立PASS：两个真实模型、三个独立任务/会话、共享顺序demo；整体仍NOT SEALED（真实LAYA/工具/全流程费用未验）；累计产品会话5/5、剩0 |
| B4.6 后续 / B2 后续 / B3 后续 / B5 后续 | PLANNED；未授权扩大 |
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
B4.1 原最小范围为非 Git 共享顺序工作区。B4.5/B4.5a 的 Git 单组隔离worktree顺序主链与审核保护现已独立 PASS（受控最小范围）；子目录明确拒绝，真实多模型兼容性仍未认证。
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

### 5.6 B4.5 / B4.5a：Git 单组隔离 worktree（受控最小范围独立 PASS）

复用 WorkspaceManager.prepare/get、WorkspaceLock/ResourceClaim 和唯一 executeTask：组root只拥有物理workspace，
成员/集成者仍有独立Task/Session/Agent×Model；所有成员顺序共用同一真实worktree，集成与审核读取该处实际产物。
报告给出owner/path/branch/baseSha；从committed base开始，不自动复制staged/unstaged/untracked，不改用户原检出HEAD/index/内容。
工作区默认保留，最终人工集成；不自动commit/merge/reclaim，不开放并行写。Git子目录启动写前明确拒绝。

B4.5a在审核前读取既有retainedResourceProtections，用实际workspaceId或规范化scope重叠匹配，
fold进同一executionIncomplete事实，统一控制report.ok/退出码、review与RoundResult/Human Gate。
停止未确认时，即使最后集成者逻辑成功/文件完整，或给出--no-review，仍review0、非ok/非零、Human Gate未完成；
无关组不误伤。scope比较复用normalizeScopeForWorkspace，不能用原生Windows路径去比较规范化文件路径。
Git创建期保护和worktree缺失门保留，非Git/sequential/正常no-review原语义保持。

仅证受控CLI/Git/文件与失败传播链路，不证明产品真实Agent兼容性、费用/Skill/MCP/自动接力。
B1/B4整体仍未封板，PARALLEL_WRITE=CLOSED；B3.1原生Skill有界切片现已独立通过，B3.2原生MCP选择与观察有界切片亦已独立通过；B2.1/B2.1a有界用户声明池与最终同步启动准入已独立PASS；下一候选B4.6检查点监督待单独下发，不等同付费预算或真实免费资格验收。

### 5.7 B3.1 任务级原生 Skill 最小闭环

用户明确授权本轮推进后，由OpenCode实施、Codex独立审核，结论为受控有界范围PASS；B3整体未封板。
显式 `--skill-catalog <file>` 只用于 `--workflow sequential|collaborate`，目录在外部调用/任务写入前一次读取校验；缺值/不可读/坏JSON/超限/未知字段/重复名称明确拒绝。默认未提供标志时不读目录、不增加Skill问题或报告字段。
目录是用户声明的 `{agentId, skills:[{name,description}]}` 元数据，最多16项/32KiB，名称最多64字符、描述最多1024字符。它不是自动发现、已安装或已授权证明；不读取凭据、全局Agent配置或Skill正文。
已分配任务的Agent与目录匹配且原生skills能力为true时，LAYA在候选和显式none中至多选一个；其他情况按规则none，不改变Agent×Model、fixed、quota或资源准入。非法/缺失/失败的选择在执行前拒绝。
经既有 `setTaskIntent`/`briefFor` 交付advisory请求，首个无依赖任务使用既有 `dispatchReceipt(promptFor)` 入口，其余沿既有自动brief；无新执行器/调度权威。协作成员和集成任务均有各自请求，集成者仍复用指定成员pair。
`report.skills` 分开requested、选择时保存的admitted-to-advisory-brief、latest-run观察；admitted不证明任务运行。仅同任务RunResult里的exact `skill`、`status=completed`、结构化 `input.name` 计入原生工具事件观察，标注runtime task/thread/agent。失败/pending/文本自述不升级。不同Agent的同名调用仍展示实际来源，但不匹配旧请求，文本报告明确ORIGIN MISMATCH。该视图只覆盖初始分配任务和其latest run，不代替完整Attempt历史。

用法（文件中的技能名由用户确认自己的Agent候选，示例不保证已安装）：
```json
{"agentId":"opencode","skills":[{"name":"api-review","description":"Review API contracts"}]}
```
```shell
orchestrator round "review the API" --cwd . --workflow sequential --skill-catalog skills.json
```
尚未验证真实Agent加载、Skill正文/版本、MCP连接/调用或token节省；没有新增强制工具权限、安装/配置变更、费用授权或并行写。

### 5.8 B3.2 原生 MCP 任务级选择与观察

用户授权后由OpenCode实施，Codex独立PASS，限受控最小范围，B3整体不封板。
显式 `--mcp-catalog <file>` 配合 `--workflow sequential|collaborate`；只接收 `agentId=opencode` 的用户声明元数据，非自动配置发现。文件最多32KiB/16项，Server/Tool各1–128字符且无控制换行，description为1–1024字符；坏文件、未知字段、类型错误、其他Agent或名称碰撞在外部调用/任务写入前拒绝。
原生名称依据OpenCode1.18.35同版本源码：各段替换非 `[a-zA-Z0-9_-]` 字符为 `_`，再用 `_` 拼接；只前向映射，绝不反拆猜Server。`a_b/c`与`a/b_c`以及标点归一化碰撞均拒绝。候选键使用安全字典，none含原生名称不可能产生的冒号。
每个匹配的初始分配执行任务，包括协作集成者，LAYA至多选择一个具体工具或none。其他Agent/空目录按规则none，不重选Worker，不以skills能力推断MCP支持；非法/缺失/失败选择时不派发。选中内容沿既有TaskIntent.mcpTools/briefFor/buildTaskBrief交付，Skill与MCP共用一个首任务prompt composer及同一dispatchReceipt入口。
`report.mcpTools` 分开requested、选择时admitted-to-advisory绑定、latest-run来源；仅completed且结构化输入、exact原生名称匹配目录的工具事件进入新视图。目录中的Server/Tool只是声明，事件匹配不证明实际MCP协议/服务身份、连接、权限或业务成功。未选中的匹配事件可见；目录外工具不分类。跨Agent同名调用不匹配旧请求，文本显示ORIGIN MISMATCH。新报告不复制工具参数/返回正文，不改原始工具记录或Attempt历史。

示例目录（不保证本机已有该工具）：
```json
{"agentId":"opencode","tools":[{"server":"docs","tool":"search","description":"Search the local docs"}]}
```
```shell
orchestrator round "review the API" --cwd . --workflow sequential --mcp-catalog mcp-tools.json
```
默认无标志保持旧路径；未连接/安装MCP，未读取或改写Agent配置/凭据，未新增SDK/网关/执行器。此advisory请求不会裁剪原生工具定义，也不构成调用或费用授权；真实MCP与Skill加载/Token收益留后续opt-in验收。

### 5.9 B2.1 / B2.1a 用户模型池与费用声明（受控最小闭环独立 PASS）

显式 `--model-pool <file>` 只配合sequential/collaborate，不支持legacy/classify-only；无标志不启用新费用限制。B2.2补入候选来源：显式冻结池通过同一admitUserModelPoolPair后，为既有seedRegistry补入精确Agent×Model（来源user model pool + declaration source）；不覆盖配置/probe/thread已有记录。新增声明pair以pair-specific unknown保持，即使Agent family available也不提升为可调用；不伪造quota。无--model-pool保持旧路径。保留旧静态池作兼容，历史名字带free/一次cost0不作为当前免费资格。
文件最多32KiB/32项，空池deny-all；格式为 `policy="no-additional-charge"` 与 `models` 数组，每项仅有agentId/modelId/billing/source/observedAt/expiresAt。billing可声明free/included/paid/unknown；source与期限随声明保留，paid/unknown/未来观察/过期/错Agent/未列pair拒绝。free/included仍只是用户声明，不认证账户额度、价格或免费资格，不承诺全流程零费用。Agent内部辅助模型、LAYA/审核及付费工具没有被本片完整约束；USD硬预算与付费授权未实现。
同一纯值谓词用于初始候选、Assignment、reassign和既有Spawn Gate，fixed不替换且不构成支出授权；单候选按规则绑定，不向真实provider发单选问题。原始复合键碰撞可误放行不同pair的P1已修为逐项精确比较，registry身份定义未全局改写。
**最终启动检查P1已在B2.1a独立关闭**：最后workspace.prepare await之后，取得实际preRunTask，再复用既有buildSpawnGateInput检查当前pair、费用声明有效期及原有条件；发生在session/thread解析和queued/running/lease/onStart/runtime状态提交之前。无新await或第二权威；拒绝携带真正denying gate，任务/issued lease不假运行，既有finally释放已取的pre-start claim。有效声明正常启动；无池旧入口不启用额外检查。该有效期是最终准入时的声明判断，不认证真实账户资格/实际费用，不做运行中到期杀停。
报告中的eligibility是报告时对声明的判断，不是实际费用或过去启动时有效性的认证。默认入口仍不保证免费；新增无池provenance诊断行也意味着不能宣称所有输出字节完全不变。

### 5.10 B4.6a：同进程用户检查点（原文案P2已收口）

`round "目标" --workflow sequential|collaborate --checkpoint` 在成员本次真实运行进入to_verify后、原有LAYA验收/下一次派工前展示只读材料。仅独立开关有效，带值写法写前exit2；legacy/classify-only/stage-check不支持。默认不读取stdin、不添加checkpoints字段。生产输入要求TTY，60秒无答复、EOF、输入错误或非法答复都停止，不默认继续；提示走stderr，JSON stdout完整。

- 输入 `continue` 只允许原有Verification/Scheduler继续，不直接标记成功或豁免费用/fixed/stage/resource门；空/不满足验收输出继续保持to_verify。检查点期间声明过期的独立probe：第一步已验收、第二步model-unavailable/user-pool-expired且无新Attempt。
- 输入 `stop <reason>` 留下当前to_verify、停止后续任务/集成/接力，本轮incomplete/非零；此前succeeded状态与已有文件/证据保留。snapshot是冻结平值，本次Attempt与RunResult关联，声明角色/验收/请求pair与有界输出、截断/停止事实分别呈现，非实际模型或产物认证。
- 同一Attempt只询问一次；仅覆盖有界workflow循环中的检查点，不给后续continuation新Attempt承诺检查点。无额外监督模型；运行中强制暂停、改计划/改选、跨进程恢复和完整自动监督均未实现。新的范围仍须现有阶段确认，不能拿旧用户continue批准新范围。
- 原P2已在B5.1关闭：Review原因按保留资源、停止未确认、用户检查点停止、workflow未完成、fan-out分支如实投影；实际first/second checkpoint-stop独立probe确认原因，不放宽任何完成门。

### 5.11 B5.1：已知会话失败的停止安全与具体模型接力

仅对已有 `TRANSPORT_ERROR → session_failure` 分支补当前链路：已执行的旧Attempt必须有同次RunResult的 `cleanup.treeStopConfirmed === true`；false/absent在请求接力选择及reassign迁移之前拒绝，报告stop-unconfirmed、incomplete和非零。纯准入拒绝沿用旧语义，不按文本或静默猜死亡，不把NONZERO_EXIT、timeout、cancel纳入新接力类别。
同Agent不同已知model是新请求worker；pair逐字段比较、未知model保守，保留绝对handoff-max和已有显式原因/重复规则。沿唯一reassign/Assignment/dispatch执行，同Task新Attempt/新Session，来源取关联的Attempt与RunResult；保留部分输出/工具事实、截断与停止事实，提示核对已有成果，不保证外部副作用可重放。请求pair不认证Agent内部实际model，也不构成付费授权。
workflow在该失败边界让出给既有canonical continuation，避免generic reassign预迁移/假来源；恢复成功仅进入to_verify，整个workflow仍待原Verification与下游，保持incomplete/非零，不自动完成或跨进程续跑。fixed、用户声明池、最终启动、stage及资源门继续适用。B5整体不封板，PARALLEL_WRITE=CLOSED。

### 5.12 本机 LAYA 环境（2026-10-15）

从历史Git da17f61找回并实际核对既有C:/Users/Admin/laya-venv：LAYA0.3.21、Torch2.11.0+cu128、Python3.12；无需重装。用户指定并批准D:/AI/laya-cache恢复英语/多语言固定revision55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851，10个必需文件1,524,397,210 bytes（约1.52GB），均通过大小与官方LFS SHA256或Git blob校验；不含typed-decisions。复用已安装huggingface_hub断点下载器，未新增依赖或自制传输协议。缓存与本机证据不入Git。
真实0.3.21服务经既有contained ManagedProcess启动在127.0.0.1:8077、HF离线、LAYA_PRELOAD=1/MODELS=english,multilingual；实际provider GET /health通过：两个checkpoint均loaded、实际device均cuda（device_is_preference=false）、revision均匹配。仅健康GET，无POST/forward pass/真实Agent推理；未认证决策质量、Token收益或完整LAYA编排。服务为有界检查，结束已停止；重新运行前须按DECISION_PROVIDER中的显式进程级启动说明启动，不是已配置开机常驻。
加载器对部分temperature给出钳制警告，受影响confidence未经校准；不据CUDA/health通过绕过验证。用户只授权缓存恢复与离线加载/health，后续本地真实决策仍需有界授权。PARALLEL_WRITE=CLOSED、产品原生会话仍5/5。

### 5.13 本地 LAYA 真实决策协议阻塞（2026-10-15）

LAYA-DECISION.1已获最多4次离线本地推理授权；首个中文分类真实POST返回后，现有客户端把0.3.21标准action:{act_probability:1}元数据误当任务参数，DECISION_SCHEMA拒绝。raw答案不是已验证结果，英文/计划/Agent×Model三项未运行，失败后无重试。服务已停止，validated Job ActiveProcessesFinal=0、owned根移除、cleanupFailures=0。安装包与官方v0.3.21源码及捕获响应离线回放共同确认；不是缓存或CUDA未加载。仅定位缺口，未改生产代码；下一候选LAYA-COMPAT.1需另行授权最小兼容修复与hermetic回归。产品会话5/5、PARALLEL_WRITE=CLOSED、68/100估算不变；温度校准P2保留。

### 5.14 LAYA action兼容单点已修复（2026-10-15）

LAYA-COMPAT.1由OpenCode指定DeepSeek V4.1 Flash首轮实现，Codex独立PASS：官方可选action元数据在三类型答案统一校验，act_probability为有限[0,1]数值；元数据不进入choice任务参数，raw保留。缺字段旧响应和真正字符串参数保持，未知对象/数字参数仍拒绝。独立typecheck、decision429/0、initial-assignment37/0、state-loop169/0及上轮捕获JSON的修复前/后离线对照回放均符合预期。无新真实推理或产品Agent调用；本片不是LAYA-DECISION.1重跑通过。下一候选LAYA-DECISION.2为另行授权的4项真实本地typed验收，置信度P2/产品5/5/并行写CLOSED/68分估算保留。

### 5.15 四项真实本地 LAYA 决策验收通过（2026-10-15）

LAYA-DECISION.2在用户新授权4次后实际完成4/4：中文multilingual、英文english均分类implementation；计划选lean；具体pair选所列demo-code-agent×demo-code-model。实际耗时734/52/73/59ms仅为本次各1样本；中文complexity=moderate、英文small均保留，不作主观质量/速度保证。生产provider均完成答案空间、概率与action元数据校验，无重试。每响应routing提供实际checkpoint；revision缺失不补写，由同服务health确认两个固定revision及actual cuda。服务已停，validated Job ActiveProcessesFinal=0、owned清理无失败。
仅真实决策接口与四个预设可用，不代表完整生产round/真实Skill-MCP/免费额度/接力全部验收；候选Agent×Model为合成输入，没有执行Agent。前轮1/4失败记录保持，当前4/4新验收PASS。置信度P2、产品原生5/5、PARALLEL_WRITE=CLOSED与68/100工程估算保留。下一候选LAYA-ROUND.1先只读核对既有整链与预算，不额外新增执行器或推理。

### 5.16 完整round动作目标协议缺口（2026-10-15只读审核）

四预设真实PASS不代表next_action带目标动作已打通。当前next_action只向0.3.21提供动作名，其choice decoder不生成taskId兄弟字段；输入action_parameters说明不能代替输出。extractAction依赖参数、complete要求taskId，受控官方响应形状经真实provider/decision loop导致malformed-decision，任务保持to_verify/无派发。现有fixture补taskId的成功链仅为受控证据。此为独立P1，未修改生产代码；下一候选LAYA-ACTION.1需授权后最小有界动作+目标选择映射，继续复用现有验证/状态权威，不凭空默认任务或换生成大脑。
两步顺序理想8次本地决策、2次产品执行，默认审核另1；具体带假设预算见下方最新审核记录及ignored laya-round-budget.json，8不是硬cap（条件对应上界13）。quota辅助CLI和原生内部辅助调用另算。当前unknown可用性/真实免费资格及已用完产品5/5授权仍需处理，不绕过gate、不新增实跑；68/100估算、并行写CLOSED、校准P2与正式前端边界保持。

### 5.17 workflow动作目标桥接已独立通过（2026-10-15）

LAYA-ACTION.1复用acceptanceMaterial边界与有限候选映射，解决最小workflow的complete明确目标：同次请求/候选表按membership还原，单目标描述绑定、多目标键区分；不从响应补猜参数。未知key、矛盾/额外目标参数拒绝，缺执行/criteria或空输出无完成候选；这是存在门，质量仍须模型判断及原Verification。旧无material的11动作参数路径保持；复杂参数动作在bounded workflow不提供，不宣称全部原生可用。
OpenCode指定模型首轮实现、正常完成，Codex独立diff/8项定向检查与first-target内存负控通过；P1在本片最小completion范围关闭，无新增真实LAYA/Agent调用。整体保留既有B45负控定位失效P2（父快照已存在，CLI未动）及temperature校准P2；不将受控provider/Runtime链提升为真实推理整链。下一候选为重新授权后的少量本地next_action/目标验收；产品5/5、并行写CLOSED和68/100估算不变。

### 5.18 真实动作验收与编码可见性阻塞（2026-10-15）

LAYA-ACTION.2 本轮真实3/3本地请求均选择continue，生产provider/decision loop解析和受控拒绝通过，未调用complete、任务状态未变；因此明确目标的正向验收NOT OBSERVED，整体BLOCKED。离线同tokenizer/build_sequence复算确认双目标state701 tokens只保留318、丢383，acceptance_material整段不在模型输入；五个选项marker和token span仍各自独立。此为证据可见性P1，不能仅据此断言三次continue的根因。服务已停/Job空/owned清理通过，固定缓存10文件摘要不变；无产品Agent/云模型/新增费用/生产修改。
下一候选LAYA-CONTEXT.1：先调查本机0.3.21实际编码预算与已有有界上下文能力，限定最小workflow输入压缩和超限拒绝方案；确保每个可完成候选的同任务criteria/output可进入实际输入，不能只把材料移到前面而截掉另一目标，也不靠放大checkpoint max_len、改温度、换模型或新建框架求通过。实施及新真实推理另行授权；本轮3次已耗尽、产品原生仍5/5，失败不重试。

### 5.19 决策输入压缩与响应后可见性保护（2026-10-15）

LAYA-CONTEXT.1代码独立PASS，整体PASS WITH P2：bounded workflow状态/材料只去掉重复元数据，同任务objective/criteria/output及缺失/截断标记完整保留；原生响应后、任何动作应用前检查checkpoint与token信息，缺失/非正/非有限/未知checkpoint或达到保守512线拒绝，不重试。无material旧11动作与非LAYA通用seam保持。离线实际tokenizer验证双目标原样本由丢383 tokens变为全量可见：English300状态tokens、完整序列494；multilingual完整序列442。中英文/Unicode/长材料共8回放，长材料确认超限；不是模型forward或真实选择验收。
守卫在响应后生效，仍消耗一次决策调用，不是发请求前精确计数。实际固定english配置512/192，multilingual为1024/256；代码统一以512保守拒绝，多语言可能在本可容纳时被拒。源码注释和worker报告误把两者容量都写512，独立审核保留P2并在文档纠正，不把它提升为事实；后续限定维护纠正文案，当前不扩大预算。仅已固定配置假设内的有界保护，不认证任意服务配置/模型判断质量或完整round。
下一候选LAYA-ACTION.3：使用修复后的生产provider/loop，准备最多3次新的本地合成动作/目标验收（双目标、缺交付、ready各一次），每次90秒，失败即停、不重试；目前未获新增推理授权。继续只用固定离线缓存，不调用产品Agent/云模型、不发送仓库代码、不新增付费。已有本地8次与产品5/5均保持；wait/abort/continue如实记，不改答案或自动追试。

### 5.20 修复后真实动作样本与领域验收边界（2026-10-15）

LAYA-ACTION.3 实际3/3本地请求仍选择continue，原生输入分别494/278/276 tokens；同一实际tokenizer回放确认三例状态均完整可见、材料字段存在、候选可区分，零state截断。生产provider/loop与守卫正确接收合法答案，complete调用0、Task状态未变，受控dispatch均拒绝真实执行；协议/安全/输入可见性通过，正向目标完成仍NOT OBSERVED，因此本片整体BLOCKED。不能据三例断言模型普遍不可用或确定其选择根因；也不能再以本轮材料缺失解释结果。
同owned服务固定revision55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851、English/multilingual实际CUDA、CPU fallback0；结束validated Job ActiveProcessesFinal0、owned根已删、cleanupFailures0、health端口不再监听。3次许可已耗尽，不追试；累计本地真实11次（历史1+4+3+本轮3），产品Agent仍5/5，本轮产品/云模型调用0，源码/测试/安装/配置改动0。
只读GitHub MCP成功核对官方同版本README Honest limits、staged-adoption与evals：官方自述基础权重在其typed-decisions任务域表现有限，建议shadow/审定标签/独立留出评估后再放行；这些上游结论不是本项目准确率，也不证明本次continue的因果原因。本机evals是已存在的模块文件，不是目录；原生JSONL校验/评价可复用，不安装新依赖。CrewAI quickstart含_DemoAgent关键词/mock回退，未执行、不能当真实模型成功证据。
下一候选LAYA-QUALITY.1：复用本机已安装laya.evals.py及原生validate/compare能力，先限定一小组领域验收样本和可独立核对的标签；多合理答案/保守行为或证据不足单列unknown，不把两个都可完成的任务硬指定其中一个当唯一真值。先调查/冻结输入、问题含义和接受标准，离线验证格式及已有捕获记录；不新建评测框架，不自动增加推理、调温度/阈值、下载新checkpoint、微调、改决策脑或用规则偷偷代替LAYA。若需新调用或实现，另行明确范围授权。

### 5.21 先调研再验证动作资格（2026-10-15）

调研结论采用“按当前状态过滤模型可见动作”，只参考[官方动态工具方法](https://docs.langchain.com/oss/python/langchain/agents#dynamic-tools)，不引入LangChain或第二套调度。GitHub MCP成功核对[同版本LAYA基准边界](https://github.com/NandhaKishorM/laya/blob/6ab71fb4ce6bfd6f189e9b689eaadd67103ed9b6/docs/benchmarks.md)与官方evals；typed-decisions专用权重面向四种合成业务流程，不据发布方成绩推断Coding验收可用，不下载或切换权重。

复用boundActionCandidates与现有observation.ready：仅在有ready子任务时提供continue，始终保留wait/abort及每个有材料的明确complete目标。请求构造与候选表同次冻结，provider等待期间的状态变化不能补授未提供的key；最终资源/quota/fixed/session/停止门保持。无acceptanceMaterial的旧11动作路径不变，不强迫模型完成任务，也不把ready当实际准入。

Codex独立typecheck及decision429/0、state-loop276/0、CLI98/0、workbench419/0、协作96/0、计划61/0、阶段材料47/0全部exit0，三份源码/测试在验证前后hash稳定。内存负控撤去ready条件后264/12、exit1，未修改源文件；三份历史真实响应离线回放：两个ready为空的旧continue被拒且dispatch0，有ready的旧continue仍可进入受控dispatch；不是新模型选择或准确率。

官方同版本Apache-2.0公开12行fixture，经本机已安装laya.evals_cli validate实际exit0（4个question id）；只校验schema，不启动模型、不给项目Coding判断打分。第三方研究只作为适用域/顺序敏感性提醒，未采用代码、数据、阈值或模型；无新依赖、下载或框架。

本轮LAYA/产品Agent推理均0，未启动服务；累计本地11次与产品会话5/5不变。历史LAYA-ACTION.3仍BLOCKED（正向目标完成NOT OBSERVED），本片仅候选资格/受控闭环独立PASS；真实判断质量、完整round/工具/费用未认证。english512/192、multilingual1024/256的文案P2已纠正，统一保守512拒绝逻辑不变，保留支持范围限制、温度校准P2及旧B45负控维护P2。估算68/100、PARALLEL_WRITE=CLOSED，正式前端未进入。

下一候选LAYA-QUALITY.2：只在新增明确推理授权后，运行一次冻结的最小资格过滤验证，不重复大组试验。不改阈值/温度/模型，不用强制complete求通过；多个合理目标以接受集合记录，wait/abort如实保留，缺材料不得完成，有ready才允许continue。先离线检查请求与材料可见性，再提出精确次数/每次时限/失败即停范围；当前不启动任何新推理。

### 5.22 候选过滤后真实选择仍为安全等待（2026-10-15）

LAYA-QUALITY.2真实验收BLOCKED（安全弃权，非错误完成）：用户明确新增最多2次本地调用后，首例实际选择wait，两个任务均保持to_verify、complete/dispatch各0。原生English输入465 tokens，与固定tokenizer预检一致且材料零截断；正向目标完成仍NOT OBSERVED。按fail-stop仅用1/2即停止，矛盾材料第二例NOT RUN，未重试、未改答案；不能据此断言LAYA普遍不可用、候选过滤无效或确定等待根因。

同owned服务健康事实为固定revision55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851、English/multilingual实际CUDA、CPU fallback0；raw响应自身无revision，不补造。唯一validated Job记录ActiveProcessesFinal0、stopConfirmed=true、owned根已删除、cleanupFailures0。独立blocking connect明确ECONNREFUSED；最初connect_ex返回10035（WSAEWOULDBLOCK），未作为端口关闭证据，随后仅修正观察方法，没有重启服务或新增推理。10个缓存文件size/SHA256及209个可版本文件在维护文档前均不变。

本轮真实1POST+同服务1次健康GET；本地累计12次（历史11+本次1），产品Agent仍5/5，本轮产品/云模型/新增付费0。实际harness exit1是正向完成未观察后的fail-stop，非协议异常；provider/loop合法接收wait，未调complete或派发。首例未完成后本次授权关闭，未消耗的1次不自动重用。无生产实现/测试/native/安装/配置改动，不为本片重复typecheck/fullsuite；并行写CLOSED，工程估算68/100保持。温度校准警告保留，confidence不作质量或硬门保证。

下一候选LAYA-BOUNDARY.1为只读职责收敛：基于官方“typed decision不等于执行许可”和shadow/unknown方法，保留四项已真实通过的分类/计划/具体pair接口，沿既有Verification/Review/HumanGate核对完成事实由谁认证、当前请求含义是否与模型适用范围一致。先提出复用现有证据权威的最小方案，不新增大脑/框架、不让wait默认变complete、不改模型或温度，也不再盲目追加同类推理。此为建议，尚未实施；如需改生产行为另行限定任务，任何真实新调用另行明确范围。

### 5.23 决策/验收职责与显式人工兜底（2026-10-15）

Verification只应用可信verdict，不自动测试内容；整轮Review后置且不改TaskStore，不能倒过来解决首个to_verify任务。LAYA-BOUNDARY.1已完成该职责核对，历史探针结果见§8。

B4.6b已独立通过：仅在既有`--checkpoint`中新增`accept <非空理由>`。等待输入后同步重读当前Task和原子Attempt→RunResult；状态、任务/Attempt/Worker身份、展示条件变化、执行证据缺失或停止未确认均拒绝。只有同一当前任务仍to_verify且树停止明确为true，才通过既有completeTask/applyVerification应用用户verdict；不直接写TaskStore、不新增authority。记录source=user、taskId/attemptId、理由及applied/refused，不把用户判断当LAYA决定、独立Review、产物或测试证明。末步accept后先重算all-succeeded，不额外问模型；后续派发仍走原固定pair/声明池/额度/资源/阶段门。continue/stop和无flag默认路径保持。

本片是个人MVP同进程人工兜底，不是完整自动验收。历史LAYA-QUALITY.2真实wait/正向目标完成未观察的BLOCKED保持；不改答案、模型、温度或权重，不追加试跑。新增产品Agent/本地LAYA推理均0，累计本地12、产品5/5不变；开发worker两轮真实使用指定DeepSeek V4.1 Flash，不能把开发调用说成零模型调用。PARALLEL_WRITE=CLOSED，正式前端未进入，估算68/100保持。

### 5.24 最短个人使用链与当前就绪边界（2026-10-15）

MVP-READINESS.1只读收敛完成；不是完整真实round已通过。最短路径是两个sequential步骤（实现→测试），固定一个已核验Agent×Model，显式计划/阶段确认，逐步用户accept，最后保留现有原生Review和HumanGate。无需新增调度器、平台或前端。`--workflow-choice`只固定计划，`--select fixed`只固定pair，`--checkpoint`只接管单步验收；三者均不能替代LAYA分类及派发决策。

前轮MVP-READINESS.1只观察到Python短超时；现已由LAYA-HEALTH.1完成生产Node/OS监听定位及一次owned恢复验证，详见下一节。

正式round会先collectAll(DEFAULT_PROVIDERS)，再分类/计划/配对和动作；不是只查询选中pair的纯本地预检。quota unavailable仅表示无接口，本身不阻断；unknown/not_fetched/not_connected/exhausted按原门拒绝。声明新pair仍为pair-specific unknown，不能通过Agent安装事实或用户池声明伪造可调用。默认原生Review也是一次独立执行，用户模型池不替其保证免费；不关闭Review来宣称真实整链成功。

本片新增本地LAYA推理/产品Agent会话均0，累计本地12、产品5/5不变；旧fail-stop未用调用不自动重用。B4.6b受控PASS及历史QUALITY.2的真实wait/BLOCKED保持。全流程费用/当前free资格、原生Review及模型内部辅助调用未认证；声明池不约束Review/原生内部调用，budget-units不是美元上限。PARALLEL_WRITE=CLOSED，正式前端未进入，工程估算68/100保持。

下一项是MVP-E2E.1：在新增明确调用授权后，用新建隔离demo验证一次真实CLI最短“实现→测试→显式用户验收→原生Review→HumanGate”。先冻结worker具体Agent×Model、reviewer入口/模型与费用、用户输入方式、本地POST/原生会话上限及失败即停条件；不能把两次worker算成全部调用，也不能自动返回accept冒充用户看过产物。当前产品5/5已用完，未开放任何新推理；模型免费资格/Review费用未知就停止，不通过删Review或伪造available跑通。需要服务时复用本次已验证的owned启动/结束路径，不建设新的常驻机制。

### 5.25 当前LAYA健康与服务生命周期（2026-10-15）

LAYA-HEALTH.1独立PASS（无推理、非常驻）：Windows监听查询成功且8077无listener，生产Node TCP立即ECONNREFUSED、provider健康探测ok=false。因此当前就绪缺口是没有服务在该端口监听；前轮Python的2秒超时保留为当时观察，不作为服务卡死或模型故障的证明，也未追定Python观察差异的原因。无需据此改协议、重装或换权重。

按已说明范围仅启动一次owned contained服务，复用现有LAYA0.3.21及D:/AI/laya-cache固定revision55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851；离线预加载english/multilingual，startup等待上限90秒，唯一进入本轮服务的请求是GET /health，无POST/推理。生产provider.probe返回ok=true；两checkpoint实际cuda、device_is_preference=false、两revision正确、CPU fallback计数0。该健康结果不证明真实决策质量或完整round。

检查后主动协同停止：validated Job记录terminated/ActiveProcessesFinal=0、stopConfirmed=true；owned根已删、cleanupFailures0；随后独立Node连接为ECONNREFUSED。服务未保留常驻，这是本片预定清理，不是健康恢复又失败。10个已下载权重/tokenizer/config文件size/SHA256前后不变，209可版本文件在文档维护前raw hash不变；无安装/升级/全局或Agent配置修改、无foreign进程终止。

本轮本地LAYA推理0、产品Agent会话0，累计本地12/产品5/5不变，旧fail-stop余次不重用。B4.6b人工兜底受控PASS、历史QUALITY.2真实wait/BLOCKED及完整自动质量缺口保持；健康成功不增加工程信用。PARALLEL_WRITE=CLOSED，正式前端未进入，估算68/100。未跑typecheck/fullsuite/旧真实推理脚本；源码/测试/native/runner未改。

### 5.26 MVP-E2E.1 本轮授权与执行硬门（2026-10-15）

Owner已明确授权一次：Worker opencode × opencode/space-bunny-free两任务；Reviewer codex × gpt-6.1-sol一次；原生会话最多3、本地LAYA POST最多3，各90秒、服务启动90秒、新增实际收费0，失败不重试/不接力，必须真实Owner终端accept。该授权不允许生产源码修改。

本轮实际创建D:/workbench-demo的orchestrator.json/pool.json/plans.json/stage.json，Reviewer配置model=gpt-6.1-sol及timeoutMs=90000。真实产品CLI --stage-check exit0，digest=aa05369e49064c11a8e6ebdb0eb41207a551b3466958ed1b3a83f648ba263e5d；未执行--confirm round。OpenCode1.18.35当前原生目录包含指定模型，cost input/output/cache均0、API base为https://opencode.ai/inference/v1；官方当前价格表亦列Free，但目录不是推理可调用或内部辅助费用认证。auth list仅报告OpenCode Go api，不能把Go凭据当作free入口资格。Codex login status=ChatGPT；当前账户Plus、包含额度未耗尽、额外credits余额0；没有读取凭据内容，没有启动Native Review。

本轮BLOCKED于LAYA累计POST硬门：Provider支持fetchImpl、既有独立验收harness有发送前计数；产品index.ts→runRoundCli未接入该计数，CLI只有laya-timeout/url及workflow循环上限。现有LAYA0.3.21服务限制并发/token，不是累计POST限额。不能将顺利路径预计3次或循环上限当作硬保证。因此在真实推理前安全停止；不注入答案、不填accept、不改源码、不新建代理/调度框架。

实际LAYA POST0、Worker会话0、Native Review0、人工checkpoint0、任务测试0、LAYA服务启动0；历史累计本地12/产品5不变。3次contained元数据命令均exit0且生产validated treeStopConfirmed=true（其判定要求Job ActiveProcessesFinal0）；不是本次任务Job成功的证据。没有模型执行Job或服务需要取消，cleanupFailures0；demo配置/证据刻意保留，不删除用户文件。结果见本机D:/workbench-demo/mvp-e2e1-result.json，不入仓库。新增调用权限不自动跨轮复用。

唯一建议下一步MVP-E2E.1a：另行限定最小预算接线，复用既有Provider发送边界，在第4个POST发出前拒绝，覆盖失败/超时也计数的hermetic回归；不改模型/权重/参数，不新增执行权威，不在修复任务中启动真实推理。完整MVP-E2E仍未通过，其他阶段不变、PARALLEL_WRITE=CLOSED、工程信用不增加。

### 5.27 MVP-E2E.1a：LAYA POST 硬预算独立 PASS（2026-10-16）

Owner 已授权本最小修复；OpenCode 开发、Codex 独立核验完成。仅本切片 PASS，不等于 MVP-E2E.1 真实闭环通过。真实 LAYA 推理、产品 Worker、产品 Native Review、人工 accept 均为 0；旧真实调用授权不继承。

产品 round 显式 `--laya-post-max 3`：每次 runRoundCli 创建一个预算对象，分类、计划、分配、动作及 Skill/MCP 选择共用该 Provider 的唯一 POST 边界；即使多个 Provider 显式共用同一对象也不能重置。比较/预留之间无 await，第4次以 `DECISION_POST_BUDGET_EXHAUSTED` 在 fetch 前拒绝；HTTP错误、超时、连接失败、取消、非法响应不退还。0 表示禁止所有推理 POST；不传参数保持旧行为（无此硬限）；health GET 不计。运行 JSON 的 `layaPostBudget` 含 max/reserved/used/remaining/exhausted/rejected。reserved 是保守预留，used 是进入 fetch 的尝试数，不是已到达服务端或已计费的证明；预留后序列化/大小校验失败也可消耗名额。预算不是 Token、费用或 Worker/Reviewer 会话上限。

仅预算分支采用一次性 ReadableStream JSON body、duplex=half、redirect=error，防止 Node 内置 Fetch 对421重放及307/308重定向产生未计数POST；未启用时保持旧 string body。依据 WHATWG Fetch 与 Node Fetch/本机内置Undici源码，实测环境 Node24.18.1 / Undici7.29.0；不认证任意自定义重试dispatcher或第三方fetch。无新依赖、调度层、状态权威、自动重试或第二执行边。

实际实现文件：src/decision/laya.ts、src/cli/round-cli.ts、tests/laya-post-budget.test.ts、tests/b40a-cli-workflow.test.ts、scripts/test-timed.mjs。开发两轮均实际指定 opencode-go/deepseek-v4.1-flash：首次 ses_ec03da6e3ffeQVuNBp4TptJYhx 因外部读权限停止、无实现；唯一返工 ses_ec03b09b4ffedNN5NgxhyEfU17 留下实现。返工外层进程退出码未恢复，最新原生导出有 assistant finish=stop/完成时间，但末尾文本已redact，不能声称已读到完整Worker报告；结论来自Codex独立diff/源码/测试，不采信wrapper状态。未启动第三轮。

Codex独立运行：typecheck exit0；laya-post-budget 125/0、b40a-cli-workflow 182/0、decision 429/0、b14-selection 179/0、state-loop 276/0、round-result 346/0，均exit0。内存负控仅跳过预算门，原套件94通过/31失败、exit1（预期），磁盘源码未改。独立loopback原生Fetch验证3次正常+3次真实超时，6份中文/多字节JSON载荷完整；两组第4次均未发送、health GET不计，服务已关闭。固定pair的CLI中途耗尽探针仅首个任务运行，下游仍planned、ok=false/exit1、Review为execution_incomplete；含附加探针套件185/0。最初探针漏设fixed导致分配先耗尽，错误预期日志保留，修正仅探针配置、未改生产代码。

本轮离线模拟/受控任务不作真实Agent或LAYA质量证明；未跑full suite。开工209版本文件哈希核对仅上述4个旧文件变化及1个新测试，维护文档前HEAD及共享index哈希未变。PARALLEL_WRITE=CLOSED、automaticPostRoundAction=NONE、其他阶段及工程估算68/100保持；audit只读，证据和本机页面仅在ignored project-progress。未commit/push/merge/stash/reset/clean。

证据：project-progress/mvp-e2e1a-review-state.json，independent-*.log/json、negative.log及两份native-export.json。下一步仅重新核实固定Worker/Reviewer的模型、账户/零新增费用、真实终端checkpoint和owned服务启动/停止，并申请一次新的受限MVP-E2E.1真实执行授权；本轮结束时全部产品真实调用关闭。

### 5.28 MVP-E2E.1 最终非推理准入：BLOCKED（2026-10-16）

本轮只授权非推理预检，未重开1a或委派开发。1a独立PASS保持；LAYA POST/产品Worker/Native Review/人工accept/服务启动均0，当前真实调用仍关闭，不继承旧次数。唯一直接阻塞：现有 `--retry-max 0` 限制编排器retry动作，但同版本OpenCode1.18.35的processor启用SessionRetry.policy，retry.ts固定RETRY_MAX_RETRIES=5，当前run帮助未暴露关闭开关。尚不能承诺Owner要求的“禁止所有重试”；这一结论来自同版本源码/当前CLI帮助，不冒充真实错误注入结果。不修改外部Agent、生产源码或偷偷改成允许重试。

当前非推理事实：OpenCode1.18.35实际目录含opencode/space-bunny-free，input/output/cache全0，官方当前仍标Free；auth list仅OpenCode Go api，未读取/打印凭据。GitHub MCP成功核对v1.18.35 provider（SHA97f83bb5…）支持无opencode key的公共免费路由。原全局model/small_model均指向opencode-go/deepseek-v4.1-flash；仅新建D:/workbench-demo/opencode.json，将main/small_model固定至本次免费pair并只启用opencode，未改全局。没有以目录存在声称推理成功。

Codex实际二进制0.162.0-alpha.17.2：login status为ChatGPT；同一CLI的只读app-server account/read(refreshToken=false)/account/rateLimits/read/model/list返回Plus、额外credits0、包含窗口使用6%/35%、精确gpt-6.1-sol。没有thread/start/turn/start或推理；API Key环境与自定义provider未发现，既有全局MCP配置名node_repl/github未改/未作本轮工具调用。Reviewer model及timeoutMs=90000已配置；源码证明review→run→preflight合并配置deadline→AgentSession.start定时取消，区别于Review结果等待90秒。当前help仍支持原生exec review的model/json/skip-git标记；真实独立Review会话/verdict尚未执行。

Demo的orchestrator.json/plans.json/stage.json字节保持，CLI stage-check再次exit0，digest仍aa05369e49064c11a8e6ebdb0eb41207a551b3466958ed1b3a83f648ba263e5d。旧pool声明过期，仅按本次元数据/官方资料刷新30分钟声明并保留ignored旧备份，公开parse/admit纯函数校验通过；这不是执行授权，实际运行前仍须检查未过期及当前资格。LAYA现有0.3.21和固定revision缓存10文件存在/大小匹配，未重算大文件SHA、未加载模型或启动服务；1a预算只做源码/既有证据复用，未重跑整套测试。

Owner在真实底部PowerShell亲自运行Node命令，stdin.isTTY返回true，Codex读到实际终端输出；两条命令被拼接，因此不声称stdout.isTTY单独测试。生产checkpoint仅要求stdin TTY，现有输出可见，60秒超时/EOF/非法回答fail-closed。前两次格式错误不作产品故障；没有脚本代填accept，也未把TTY检查当Owner验收。真实两次checkpoint与最终Review/Human Gate仍待正式执行。

预检14个owned metadata Job均确认ActiveProcessesFinal=0、owned目录删除、cleanupFailures0。第一次app-server静态stdin因EOF没取到回复，未采信；随后在同一Job内保持stdio等待，取得合法元数据后退出。第一次auth摘要未去ANSI，随Demo修正后用既有stripAnsi核对；一次误导入private helper在执行前失败，改用现有公开纯函数，无生产修改。全部先于文档维护的版本文件raw hash保持，Demo仅新增opencode.json、更新pool.json；旧数据/dirty tree保留。未commit/push/merge/stash/reset/clean。

唯一最小下一步：Owner明确禁止重试是否仅指编排器任务重试，并是否接受原生会话既有最多5次错误重试（仍不换模型、最多90秒、免费公共路由/订阅包含额度、原生会话总数不增加）；如仍要求连原生HTTP重试也为0，当前入口不满足，本轮不擅自补代码或改安装。边界明确后才提交新的完整执行授权，最多Worker2+Review1、LAYA POST3、各90秒、并发1、新增收费0、仅Demo、Owner两次亲自accept/stop、失败即停及owned Job清理。候选真实命令只保存在ignored mvp-e2e1-admission-command.txt，未执行。

证据：project-progress/mvp-e2e1-admission-review.json及metadata/cli-help/codex-current/pool-validation；旁路audit只读。PARALLEL_WRITE=CLOSED、automaticPostRoundAction=NONE，工程估算68/100及其他阶段不变。这里只裁定准入BLOCKED，不推翻1a，也不宣称完整后端或真实E2E通过。

### 5.29 MVP-E2E.1：两次真实 Round 均 PARTIAL（2026-10-16）

Owner后续明确允许OpenCode1.18.35同一原生会话内既有SessionRetry.policy，仍禁止编排器任务重试/换模型/接力；此前§5.28仅是当时准入记录，不再是当前重试授权结论。两次受限Round分别执行：每次真实LAYA POST 2/3、固定opencode/space-bunny-free Worker 1/2、Reviewer 0/1，均未生成add.js、未派发测试任务；没有真实add测试结果或原生Review verdict。第二次采用干净workspace与旁置evidence仍未交付，不能仅归因旧文件混杂。

两个native session分别为ses_ebdb029f5ffeKitPJM2i5e5aAR和ses_ebd9e70fdffes8Uwl110NpNq3A，版本1.18.35、build模式、实际指定模型、进程exit0、所有assistant finish为tool-calls，均在external_directory自动拒绝后结束，未发生写文件调用。原生费用报告均0 USD，未观察retry事件，不把未暴露HTTP重试数记为0，不把usage当账单。每次一个真实checkpoint超时60秒而fail-closed；Owner accept与明确stop均0，不能把报告source=user或The user STOPPED当作人工输入。该来源标记失真留作单独观察，本片不修。

两次均HumanGate=not_ready、automaticPostRoundAction=none；owned Job验证ActiveProcessesFinal=0、cleanupFailures=0，LAYA及本轮窗口已退出。未改仓库、未commit/push，证据只在隔离Demo。原报告D:/workbench-demo/.mvp-e2e1-20261016T011705Z/final-review.json与D:/workbench-demo/mvp-20261016T014238Z/evidence/final-review.json保留。失败即停后剩余调用不自动继承。

### 5.30 MVP-E2E.1b：Recon 指令修复离线通过，整体 PARTIAL（2026-10-16）

本轮授权有限源码/离线验收，不授权真实LAYA、产品Worker、Native Review或第三次E2E。Codex先读取两个原生export、最终任务、实际argv/cwd、RunResult与只读旁路审计，并通过GitHub MCP核对OpenCode v1.18.35 instruction/agent/processor/system/default prompt；官方规则与权限说明亦实际打开。当前两个Demo有效debug config/build无自定义instructions/build prompt、插件或MCP，检查到的本地/全局规则文件不存在，build允许编辑，不是plan只读。历史完整system消息未被export序列化，当前配置不能证明历史所有字节。已确认直接相关缺陷：统一模板要求搜索仓库/共享研究并宽泛允许读外部安装，缺空项目NEW出口、cwd边界、运行材料排除与实际交付要求；原生默认continue_loop_on_deny=false，RejectedError后blocked→stop可解释本次退出链。证据支持贡献路径，不证明模板是唯一模型根因。

OpenCode首次实现及一次定向返工均通过既有opencode-agent implement；原生session ses_ebd8cf94affeoHDibVDo8kY1oH / ses_ebd88b28cffeYVR3bPxqWvB6uz均核对opencode-go/deepseek-v4.1-flash、finish=stop、wrapper exit0。生产仅改src/orchestration/worker-execution-contract.ts的纯值文本；compose/buildRunRequest/Task语义不变。新指令只调查cwd内相关文件、已有模块优先复用；空项目有限检查后可NEW并实际交付；禁止父/兄弟目录、控制/审计材料和跨工具绕过；只读不写、测试消费真实上游材料、冲突报阻塞。原生已停则不能靠提示词继续，不启用continue_loop_on_deny或放宽权限。无add.js特例，无第二调度/权限/模型系统。

Codex独立结果：typecheck PASS；worker-execution-contract 96/0（含实际OpenCode transport argv、cwd/model、原任务字节保持及不加权限绕过）；CLI b40a 182/0；contract 248/0（2 skipped）；handoff-production-round 388/26。先前原样源码/测试经内存registerHooks重放为386/26，26个B5.1-WF失败名称与本片最终完全一致，新增两项实际runtime request断言通过，未删除/跳过/掩盖旧失败。负控只在内存加载旧模板，新测试62/34、exit1，证明能检出旧缺陷；磁盘源码未为负控改写。没有用假Worker产物证明模型交付，未重新证明真实模型遵守新指令。

裁定PARTIAL：所需指令修复与最终发送接线已独立通过，但指定handoff回归尚有26项既有失败，不能声称所有定向回归全绿。唯一下一步是另行裁定/收口这组既有B5.1-WF失败后，才决定是否重新申请新的受限MVP-E2E.1；当前不自动开发该缺口、不发起第三次E2E。PARALLEL_WRITE=CLOSED、automaticPostRoundAction=NONE及68/100工程估算保持。证据：project-progress/mvp-e2e1b-20261016T020219Z/，audit只读；HEAD/index及范围外dirty成果保留，未commit/push。

### 5.31 MVP-E2E.1b：26项既有失败的有限准入裁定（2026-10-16）

Owner授权仅调查/离线验证，不要求无条件修完历史失败。裁定MVP-E2E.1b — CONDITIONALLY ACCEPTED，26 pre-existing B5.1-WF failures remain open。该豁免仅适用于下一次固定Agent×Model、sequential、并发1、retry-max0、no-handoff、真实Owner checkpoint及原生独立Review/Human Gate的受限MVP；不是原handoff套件PASS，不封板B5.1-WF，不自动开放真实调用。

根因已逐项取证，而非只比名称：A(7)、B false/absent(各5)、C(2)、D(6)共25项由测试Provider给targetless continue自动附加taskId造成，生产extractAction按bounded候选快照以contradictory-target写前拒绝；E(1)脚本期待bounded workflow接受未提供的reassign，按unoffered-action-key拒绝。均为当前测试夹具/契约适配债务，不是本片模板或环境导致；没有Worker运行，不存在执行后才丢Attempt/Session的证据。旧源码+旧测试内存重放386/26，当前388/26；26项名称、规范化断言细节、错误code/message及extractAction→runDecisionCycle→runRoundCli主要生产堆栈一致。随机roundId与新增测试造成的行号偏移单独保留。完整历史非本片变更来源未重审，不把历史已PASS文字当当前套件通过。

仅作因果诊断：内存中停止夹具给bounded continue自动附加taskId，不改生产代码、任何断言或磁盘测试后为417/1；确认停止后m1→m2、false/absent停止未知不迁移/不再run、fixed拒绝替换、m1→m2→m3来源与循环拒绝均触达并满足原断言。E仍被合法拒绝，原26项在原套件中全部保留；诊断不是把改过输入的结果冒充原套件绿。真实LAYA Provider不含该夹具的taskId自动补写逻辑，两次历史真实continue也均实际派发过Worker。共享校验依旧拒绝非法输入，不为MVP放宽。

本轮直接相关实跑：worker-execution-contract96/0、CLI工作流182/0、execution-lifecycle136/0、resource-claim192/0。另复用现有workflowRound测试入口做受控fetch/Worker/Reviewer/checkpoint的两步固定pair/no-handoff/预算3 probe：成功例run2、不同Task/Attempt/Session、两次模拟accept、受控Review1且合法pass、上游实际fixture输出进入下游brief、POST3、HumanGate=waiting_for_user且roundComplete=true、自动动作none；停止未知例run1、accept拒绝、Review0、下游未运行、gate=not_ready。以上均为离线模拟，不是Owner亲自accept、真实模型交付或真实Codex Review。首个自有probe曾误期待gate=ready，实际契约是waiting_for_user，已查源码修正诊断断言并保留初次失败记录；未修改产品以迎合期望。owned probe目录全部定点清理、cleanupFailures0。

风险/边界：原26项仍欠正式测试夹具维护，通用bounded workflow reassign不在当前候选能力内；未来启用接力/auto重选/并行写必须重新裁定，不继承本豁免。Recon提示词不是沙箱，不证明模型今后遵守，默认原生权限拒绝仍可结束会话；checkpoint超时source=user的报告观察仍保留，不能冒充Owner输入。下一步只等待Owner对新的真实MVP-E2E.1调用范围另行授权并复核当时账户/零费用/材料/TTY，无新实现任务。当前真实LAYA POST、产品Worker、Native Review、第三次E2E与开发委派均0。

证据：project-progress/mvp-e2e1b-admission-20261016T022628Z/的failure-signatures.json（26项位置/细节/堆栈）、before/after-detailed日志、fixture-input-diagnostic、shared-path-probe与各定向日志。无生产或测试磁盘修改，HEAD/index与dirty成果保留；仅更新本基线、NEXT_TASK和ignored进度页，audit只读。工程估算68/100、PARALLEL_WRITE=CLOSED、automaticPostRoundAction=NONE保持，未commit/push。

### 5.32 MVP-E2E.1c：交付路径、职责和 Checkpoint 离线核对（2026-10-16）

裁定 FIX_REQUIRED。本轮只读源码/原生证据、非推理定向核验及方案制定；真实 LAYA POST、产品 Worker、Native Review、开发委派和第四次 Round 均为0，未改 src/tests/native 或 Demo，未重开26项历史失败。第三次真实 Round 为 PARTIAL，证据保留在 D:/workbench-demo/third-20261016T024431Z/evidence/。其实际 POST2/3、Worker1/2、Review0/1、Owner accept0/stop0，Job ActiveProcessesFinal=0、cleanupFailures=0；本节不把旧本地页面的“两次失败”继续当最新事实。

路径三方核对：用户和计划要求 workspace/add.js；实际 Task/原生用户正文仍含 deliverable:add.js 与 file scope:add.js，未指定 demo/；原生 export 的 directory 是正确 workspace。write 工具实际显式写入 workspace/demo/add.js 和 demo/add.test.js，磁盘一致。直接偏移发生在 Worker 选择写路径，并非 cwd 解析把目录改到 demo。没有保存独立的历史 OS argv 全量捕获；本轮只离线重建现有 adapter，确认 run <原文> --format json --dir <同cwd> --model <固定模型>，transport 同样传 cwd，无额外 demo/ 拼接。不能据此声称知道模型自行加目录的内部原因。Demo 的“new demo”措辞和未明确 cwd 根相对路径可澄清；不自动搬文件、不新增 add.js 特例。

职责更正：Implementation 必须实现，允许必要自测；提前编写测试本身不天然违反职责。当前第一步仅声明 add.js，新增持久测试需在允许范围中说明；第二步独立检查/运行/必要时补充测试，不能复述前者 PASS。现有 fileScope 是声明文本而非文件系统沙箱（plan-file.ts 已明确）；artifact 列表为空不等于无真实文件。buildHandoff 从实际 write 工具保留两个绝对 changedFiles，buildTaskBrief 能将它们和观察到的命令交给依赖测试任务；本轮用真实 RunResult 离线投影核对路径完整，没有声称第二个真实 Worker 已消费。新 Demo 可仅在原 stage/plans 字段中明确精确 cwd 根路径、自测权限和独立测试职责，不需新增交接引擎。

已定位的生产缺陷：workflow-checkpoint.ts 默认60秒（CHECKPOINT_TIMEOUT_MS）；reader deps.timeoutMs 仅编程/测试入口，round CLI 未暴露独立人工等待参数。timeout/EOF/读取失败抛错后，round-cli.ts 的 catch 调用 record('stop')，record 恒写 source:'user'；workflow.stop=user-stop，checkpoint/review/handoff 摘要亦泛称用户停止。安全停止和未验证保护正确，事件归属错误。实际 Owner-ready 及继承TTY证明有可操作终端；提示直接镜像到该窗口，不依赖 Codex 聊天才能输入。Codex 上次转达延迟是协作问题，不证明TTY故障；未输入不能归责为用户决定。Node readline 官方说明与当前生产实现一致：输入来自指定 input、提示经 output，60秒是本项目策略而非 readline 强制。

唯一最小修复建议（待授权，尚未实施）：仅在现有 checkpoint reader/CLI 记录与报告链保留类型化停止原因，区分 timeout/input-unavailable（system、无用户choice）、真实 user_stop 和 user_accept；同步各摘要措辞，保留原 fail-closed、同Attempt重查和唯一 completeTask/Verification/Human Gate。无需修改 Recon、LAYA、权限、模型或调度，不把扩大人工等待时长作为本片必要修复。验证用短时受控 reader + 真实CLI/fake执行端覆盖 timeout/EOF/error/用户stop/accept/非法输入，确认无假人工决定、无额外派发、无假完成。仅调整Demo不能修复该证据来源缺陷，故尚不具备下一次真实E2E准入条件。

本轮实际离线验证：checkpoint套件49/0、CLI工作流182/0，均exit0；额外内存probe验证10ms timeout拒绝、原生cwd/目标正文/当前adapter传参无重写、真实write路径在handoff中保留。既有套件绿不表示source归属已正确（旧断言只检查停止）。参考 https://opencode.ai/docs/cli/#run 和 https://nodejs.org/api/readline.html；Node当前网页为v26，通用readline行为只作说明，本机行为由现有Node24生产reader离线核验。HEAD/index/既有dirty成果及audit保持；仅维护本基线、NEXT_TASK和ignored进度快照，不commit/push。工程估算保持68/100，PARALLEL_WRITE=CLOSED；完成核对后停止，所有真实调用关闭。

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
3. B3.1/B3.2已补用户声明Skill/MCP候选、任务级advisory选择和有来源的事件观察。MCP只按OpenCode同版本规则前向映射/拒绝碰撞，事件名称匹配不认证MCP协议或服务身份。自动发现、真实加载/调用、权限限制、工具定义裁剪和Token收益仍缺。
4. 动态免费资格、账户共享额度和全流程费用授权未验收；预算 units 不是 token/货币。
5. B5.1只完成已有明确session_failure的停止安全/pair接力受控链；真实服务掉线如何上报、限流/认证/崩溃分类、跨进程和完整workflow续跑仍待验证。静默不等于死亡，固定模型不偷换，无合格声明池不转付费。
6. 多 Agent 真实兼容性、同 Agent 多模型隔离、总 token 收益需各自实证；fixture 不替代这些证据。
7. W4 真实 Agent 环境限制、旧 full-suite 证据时效与 native reconciliation 无法取得退出事实时的
   fail-closed 可用性限制继续保留；本轮未重测或解除这些历史 P2，细节见既有审核快照。

这些不是要求下一片一次实现全部能力；真实执行仍遵守现有准入，缺必要事实就明确拒绝。
不新增 provider 网关、群聊平台、第二个调度器或通用工作流引擎来掩盖协议缺口。

## 8. 最近独立证据与上传记录

2026-10-15 LAYA-HEALTH.1运行与Codex独立核对：LAYA-HEALTH.1独立PASS（无推理、非常驻）：Windows监听查询成功且8077无listener，生产Node TCP立即ECONNREFUSED、provider健康探测ok=false。因此当前就绪缺口是没有服务在该端口监听；前轮Python的2秒超时保留为当时观察，不作为服务卡死或模型故障的证明，也未追定Python观察差异的原因。无需据此改协议、重装或换权重。
research-before-work已先核对本机serve.py/已有ManagedProcess健康harness与正式provider。GitHub MCP成功读取固定官方serve.py（blob ed08d39a…），核对GET health仅访问resident状态、不Router.load或推理，preload发生在create_app构造前；Microsoft Get-NetTCPConnection官方文档用于区分本地Listen及OwningProcess。仅复用既有Job launcher、owned helper、取消/validated控制记录及离线缓存，不新建manager/服务框架，也无产品开发缺口需委派worker。
按已说明范围仅启动一次owned contained服务，复用现有LAYA0.3.21及D:/AI/laya-cache固定revision55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851；离线预加载english/multilingual，startup等待上限90秒，唯一进入本轮服务的请求是GET /health，无POST/推理。生产provider.probe返回ok=true；两checkpoint实际cuda、device_is_preference=false、两revision正确、CPU fallback计数0。该健康结果不证明真实决策质量或完整round。
检查后主动协同停止：validated Job记录terminated/ActiveProcessesFinal=0、stopConfirmed=true；owned根已删、cleanupFailures0；随后独立Node连接为ECONNREFUSED。服务未保留常驻，这是本片预定清理，不是健康恢复又失败。10个已下载权重/tokenizer/config文件size/SHA256前后不变，209可版本文件在文档维护前raw hash不变；无安装/升级/全局或Agent配置修改、无foreign进程终止。
本轮本地LAYA推理0、产品Agent会话0，累计本地12/产品5/5不变，旧fail-stop余次不重用。B4.6b人工兜底受控PASS、历史QUALITY.2真实wait/BLOCKED及完整自动质量缺口保持；健康成功不增加工程信用。PARALLEL_WRITE=CLOSED，正式前端未进入，估算68/100。未跑typecheck/fullsuite/旧真实推理脚本；源码/测试/native/runner未改。
下一项是MVP-E2E.1：在新增明确调用授权后，用新建隔离demo验证一次真实CLI最短“实现→测试→显式用户验收→原生Review→HumanGate”。先冻结worker具体Agent×Model、reviewer入口/模型与费用、用户输入方式、本地POST/原生会话上限及失败即停条件；不能把两次worker算成全部调用，也不能自动返回accept冒充用户看过产物。当前产品5/5已用完，未开放任何新推理；模型免费资格/Review费用未知就停止，不通过删Review或伪造available跑通。需要服务时复用本次已验证的owned启动/结束路径，不建设新的常驻机制。
证据laya-health1-listeners/connect/cache-before/loaded/independent-verification/review-state与logs仅ignored；audit严格只读。只有六份受影响文档与本机页更新，页面/缓存/服务探针/审计日志不入Git；精确上传当前审核文档，主HEAD/共享index/其他dirty文件保持。

2026-10-15 MVP-READINESS.1只读审核：MVP-READINESS.1只读收敛完成；不是完整真实round已通过。最短路径是两个sequential步骤（实现→测试），固定一个已核验Agent×Model，显式计划/阶段确认，逐步用户accept，最后保留现有原生Review和HumanGate。无需新增调度器、平台或前端。`--workflow-choice`只固定计划，`--select fixed`只固定pair，`--checkpoint`只接管单步验收；三者均不能替代LAYA分类及派发决策。
Codex实际核对CLI构造/阶段门/provider/quota/Assignment/最终Review与报告调用链，并通过GitHub MCP读取固定LAYA0.3.21 staged-adoption（SHA 9f3bed9a…）；沿用应用掌握执行和显式Review、限定切片的方法，不复制上游示例fallback或引入依赖。Node官方readline只作既有TTY/close边界核对（在线页v26，本机v24.18.1，不采用新版API）。无实施缺口需要本轮改源码，故没有开发worker；不把只读调查包装成委派开发。
独立真实CLI预检三例：有效计划/材料--stage-check exit0；缺--confirm exit2；改计划后旧digest exit2。每例child_process调用0、fetch调用0、Task文件/执行transcript0；仅本轮owned临时配置/目录，SessionStore创建的空目录随后一并回收，owned root已删除。未调用真实Agent/额度查询或读取用户配置/凭据内容。纯值Spawn Gate六状态核对：available和unavailable在其他合成准入事实成立时可过，unknown/not_fetched/not_connected拒绝、exhausted拒绝；不是实际额度/价格验证。
本轮健康观察未通过：初次默认HTTP客户端GET超时；随后仅纠正观察路径，用无代理的直连http.client访问127.0.0.1:8077/health，2秒同样TimeoutError。没有POST、没有启动/停止服务，不能由此断言端口关闭、无进程或确定根因；当前健康状态未确认。既往服务已停止记录仍仅是当时事实，不冒充当前新观测。
本片新增本地LAYA推理/产品Agent会话均0，累计本地12、产品5/5不变；旧fail-stop未用调用不自动重用。B4.6b受控PASS及历史QUALITY.2的真实wait/BLOCKED保持。全流程费用/当前free资格、原生Review及模型内部辅助调用未认证；声明池不约束Review/原生内部调用，budget-units不是美元上限。PARALLEL_WRITE=CLOSED，正式前端未进入，工程估算68/100保持。
下一候选LAYA-HEALTH.1先只读定位本机健康超时，再按明确owned边界判断最小恢复。复用现有venv/固定缓存/Job launcher；不换模型、温度或权重，不重装，不新增框架，不碰不属于本轮的listener/进程。此候选不授权推理或产品Agent调用；如需启动服务，应先给出具体启动/时限/清理范围，执行后以validated Job空和owned清理证明结束。健康就绪后，新的真实个人demo仍须明确worker/reviewer模型、费用、会话和本地POST上限。
证据mvp-readiness1-precheck/gate/review-state/start-files及logs仅ignored。所有209可版本文件在文档维护前raw hash不变；audit只读。新增/改动仅六份受影响文档，本机页刷新并与JSON比对；无产品源码/测试/runner/native/配置修改，不重跑typecheck/fullsuite或旧模型脚本。页面/demo探针/audit/缓存不入Git，精确上传当前六文档审核快照，保留主HEAD/共享index及原dirty tree。

2026-10-15 B4.6b实际实现与Codex独立审核：B4.6b已独立通过：仅在既有`--checkpoint`中新增`accept <非空理由>`。等待输入后同步重读当前Task和原子Attempt→RunResult；状态、任务/Attempt/Worker身份、展示条件变化、执行证据缺失或停止未确认均拒绝。只有同一当前任务仍to_verify且树停止明确为true，才通过既有completeTask/applyVerification应用用户verdict；不直接写TaskStore、不新增authority。记录source=user、taskId/attemptId、理由及applied/refused，不把用户判断当LAYA决定、独立Review、产物或测试证明。末步accept后先重算all-succeeded，不额外问模型；后续派发仍走原固定pair/声明池/额度/资源/阶段门。continue/stop和无flag默认路径保持。
Codex先核对仓内调用链，并成功用GitHub MCP读取固定LAYA0.3.21 staged-adoption（typed decision不等于执行许可），Node readline生命周期沿用本机既有API，不引入依赖。OpenCode implement首次+一次限定返工，原生session导出确认全部assistant为opencode-go/deepseek-v4.1-flash且最终finish=stop；Codex独立读实际diff和连接源码后重跑：typecheck: typecheck PASS；b46-workflow-checkpoint: 49 passed, 0 failed；b40a-cli-workflow: 159 passed, 0 failed；state-loop: 276 passed, 0 failed；round-result: 346 passed, 0 failed；workbench: 419 passed, 0 failed；b41-collab-group: 96 passed, 0 failed；b43-stage-material: 47 passed, 0 failed；b14-selection: 179 passed, 0 failed；b22-model-pool-candidates: 33 passed, 0 failed，全部exit0；内存负控屏蔽人工completeTask调用后真实CLI套件非零，未修改工作树。缺失ce.run分支如无可达测试入口仅作源码核对，不冒称物理测试。
本片是个人MVP同进程人工兜底，不是完整自动验收。历史LAYA-QUALITY.2真实wait/正向目标完成未观察的BLOCKED保持；不改答案、模型、温度或权重，不追加试跑。新增产品Agent/本地LAYA推理均0，累计本地12、产品5/5不变；开发worker两轮真实使用指定DeepSeek V4.1 Flash，不能把开发调用说成零模型调用。PARALLEL_WRITE=CLOSED，正式前端未进入，估算68/100保持。
下一候选MVP-READINESS.1仅做最短个人使用链的只读收敛：复用当前CLI、阶段/模型池/检查点和交付视图，明确可执行命令、必要本机条件、尚缺真实证据与下一项硬阻塞；不再重建已完成模块，不自动新增推理或完整平台。后续真实整链调用仍需明确次数/费用/数据授权。
本机证据b46b-implement/rework.jsonl、两次native-export、independent-tests、negctl-result及review-state仅ignored；audit严格只读。产品改动限定两个CLI文件和两个既有hermetic套件，无native/生产配置/依赖/安装修改。受影响文档与本机页同步后仅精确上传审核快照，主HEAD/共享index/其他dirty文件保留，未合入main。以下BOUNDARY记录为当时历史，不代表当前仍无accept。

2026-10-15 LAYA-BOUNDARY.1只读审核：LAYA-BOUNDARY.1只读职责审核完成：Verification是唯一状态写入权威，但不是自动测试/产物核验器；Workbench.completeTask把调用者的完成判断转成pass，原生LAYA选择complete的质量判断因此仍由模型承担。候选中有材料、状态可迁移，不等于质量已独立验证。历史QUALITY.2的安全wait与目标完成未验收保持，不能将状态权威误说成独立内容裁判。
先读当前基准/调用者/audit，再经GitHub MCP成功读取官方固定v0.3.21 staged-adoption：typed decision不等于执行许可，应用保有执行/审核边界，shadow对照允许unknown；结合当前源码采用方法，不复制框架或调整权重。OpenCode官方agents文档仅核对角色与权限可分工，不视为本机新原生review能力已实测；未调用其他Agent。
当前真实调用链：LAYA动作→同次候选目标映射→decisionCapabilities.complete→NativeWorkbench.completeTask→Orchestrator.applyVerification→translateVerification/TaskStore。独立整轮Review在workflow所有成员succeeded之前被executionIncomplete挡住，且runUnifiedReview只产报告不写Task；它不能倒过来解决第一个to_verify任务的验收。任务级applyReview/review-loop已有，可供显式调用，但当前CLI该路径没有自动接线；不需要另造ReviewManager。HumanGate是结果/选项投影，automaticPostRoundAction恒none，不是stdin执行器。
既有--checkpoint只接受continue与stop <reason>：continue保持任务状态，继续让LAYA决定；stop保留成果并停止。没有显式人工accept入口，不能把continue暗改为验收或把安全wait默认为complete。这是个人工作台可用性/职责接线缺口，不是新发现的TaskStore安全绕过。
本轮受控离线探针复用QUALITY.2捕获wait，经真实provider/decision loop/NativeWorkbench后，任务不变、complete0/runtime0；当前accept语法实际invalid；可信调用者显式completeTask可使唯一指定to_verify任务succeeded，而planned任务仍被not-awaiting-verification拒绝。此探针没有真实执行/质量认证，不证明生产CLI可绕过材料门。独立b46检查点42/0、review-loop169/0、round-result346/0、unified-review130/0、workbench419/0均exit0，209版本文件前后hash不变。
下一候选B4.6b是最小显式人工验收检查点：复用--checkpoint/readline/同Attempt只读快照及wb.completeTask，不新建验证器、调度器或状态权威。新增accept <非空reason>仅在原检查点显式启用时生效；等待输入后重读当前Task及原子Attempt→RunResult，要求task/attempt身份一致、仍to_verify、实际执行及停止确认完整。缺失/更换/未知停止均拒绝，不用旧快照或latest-by-task拼接。记录来源user、taskId/attemptId和理由，不冒充LAYA决定、模型Review或实际测试事实；continue/stop及默认入口不改。accept后先重算原循环完成/就绪，末步已完成时不再多问LAYA，后续派发仍走原调度/配对/额度/资源/阶段门。
B4.6b只是个人MVP的显式人工兜底，不替代用户要求的完整自动编排与独立质量验收；默认LAYA路线保持，不能把人工通过宣传为真实LAYA自动验收通过。本轮只读审核/文档，无产品源码或测试改动、无新推理/服务/worker/依赖；本地累计12、产品5/5不变，PARALLEL_WRITE=CLOSED，估算68/100不因方案增加信用。B4.6b尚未实施；当前已有授权只完成本片职责核对。
本机证据laya-boundary-probe.json/tests.json/review-state.json及logs仅ignored，audit只读；本片没有产品实现，未启动OpenCode开发。文档维护后刷新本机页并对比，精确上传审核文档，不合main/改变共享index；不将受控probe升为真实质量或新模型结果。

2026-10-15 LAYA-QUALITY.2真实运行与Codex独立裁定：LAYA-QUALITY.2真实验收BLOCKED（安全弃权，非错误完成）：用户明确新增最多2次本地调用后，首例实际选择wait，两个任务均保持to_verify、complete/dispatch各0。原生English输入465 tokens，与固定tokenizer预检一致且材料零截断；正向目标完成仍NOT OBSERVED。按fail-stop仅用1/2即停止，矛盾材料第二例NOT RUN，未重试、未改答案；不能据此断言LAYA普遍不可用、候选过滤无效或确定等待根因。
同owned服务健康事实为固定revision55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851、English/multilingual实际CUDA、CPU fallback0；raw响应自身无revision，不补造。唯一validated Job记录ActiveProcessesFinal0、stopConfirmed=true、owned根已删除、cleanupFailures0。独立blocking connect明确ECONNREFUSED；最初connect_ex返回10035（WSAEWOULDBLOCK），未作为端口关闭证据，随后仅修正观察方法，没有重启服务或新增推理。10个缓存文件size/SHA256及209个可版本文件在维护文档前均不变。
本轮真实1POST+同服务1次健康GET；本地累计12次（历史11+本次1），产品Agent仍5/5，本轮产品/云模型/新增付费0。实际harness exit1是正向完成未观察后的fail-stop，非协议异常；provider/loop合法接收wait，未调complete或派发。首例未完成后本次授权关闭，未消耗的1次不自动重用。无生产实现/测试/native/安装/配置改动，不为本片重复typecheck/fullsuite；并行写CLOSED，工程估算68/100保持。温度校准警告保留，confidence不作质量或硬门保证。
下一候选LAYA-BOUNDARY.1为只读职责收敛：基于官方“typed decision不等于执行许可”和shadow/unknown方法，保留四项已真实通过的分类/计划/具体pair接口，沿既有Verification/Review/HumanGate核对完成事实由谁认证、当前请求含义是否与模型适用范围一致。先提出复用现有证据权威的最小方案，不新增大脑/框架、不让wait默认变complete、不改模型或温度，也不再盲目追加同类推理。此为建议，尚未实施；如需改生产行为另行限定任务，任何真实新调用另行明确范围。
复用同任务已核实的官方资料/冻结请求/现有contained服务入口；未启动开发worker，因为本片没有产品代码缺口。两个冻结请求与4项tokenizer核对属于离线准备；本轮只有首例是真实模型证据，不能把未运行的第二例写成拒绝通过。本机laya-quality2-evidence.json、independent-facts.json、review-state.json、token-audit.json、run.log和plan/check/cases仅ignored；audit只读。只同步6份受影响文档及本机页，精确上传独立BLOCKED快照，不合入main/改变共享index。

2026-10-15 LAYA-QUALITY.2离线准备：LAYA-QUALITY.2离线准备已通过，真实推理NOT RUN：只冻结两个最小案例，正确材料任一明确目标可完成、明显矛盾材料应拒绝；不指定必须选择第二目标，不改问题含义或强制complete。复用既有TaskStore/生产请求构造/provider/decision loop/Verification和owned contained服务清理，不新增生产实现或评测框架。
本轮先按research-before-work读取当前实现与audit；GitHub MCP成功读取官方固定v0.3.21 staged-adoption，核对shadow记录、审定标签、歧义/unknown及有限放行边界；网页GitHub抓取404未当作MCP失败。参考LangChain官方动态工具过滤方法，不引入框架、换权重、拟合阈值或调温度。上游方法只指导验证，不证明本机模型会作正确选择。
固定请求SHA256分别ee850d7e2b66f6e9447e478128f7f6779240d3ce9887480706d2e002a8439e83与69daf004d9ec39212083c94bb3857b58b4af8028b4a9ef03a25c6b716996fa3c，重复构造一致。实际固定tokenizer/build_sequence离线核对：English465/324、multilingual412/290 tokens，4项均无state截断、候选marker齐全且可区分，低于当前保守512线。未运行forward pass、未启动服务或产品Agent。入口在未授权时真实非零退出，位于服务/控制目录创建之前，状态与证据文件未改。
拟申请新增最多2次本地LAYA POST，每次90秒，只用现有离线缓存/合成内存材料；首例未完成或任何错误立即停止、不重试，次例仅在首例实际完成后运行。首例wait/abort是安全但正向完成未观察，不能写PASS；次例错误complete必须BLOCKED且由shadow边界阻止错误状态变更。结束必须验证owned Job空/清理。当前仅已提出具体授权选项，尚未收到新增调用答复，inferenceAllowed=false；旧11次本地额度与产品5/5不重置，产品/云模型/新增付费均不允许。
所有209个可版本文件在离线准备后hash未变；本轮仅维护现有基线/下一任务/路线/阶段文档与ignored页面。未启OpenCode worker，因为当前只需冻结合成请求和复用既有验收入口，没有产品代码缺口；没有用fixture冒充真实模型。本机证据laya-quality2-plan.json/cases.mjs/token-audit.json/review-state.json/check.mjs均ignored，audit只读。工程估算仍68/100，不因准备/测试数增加，历史ACTION.3真实完成缺口保留。

2026-10-15 WORKFLOW-RESEARCH.1：按用户明确要求，将每个技术任务先调研固化为个人Skill research-before-work，并在全局AGENTS.md明确要求加载；项目AGENTS保留同一工作前置说明。实际先读本机skill-creator与官方Skills/AGENTS发现文档，GitHub MCP成功读取openai/skills对应实现；复用原生SKILL.md、agents/openai.yaml（自动选择开启）和现有全局指令，不加hook/服务/依赖。每个新任务先核对当前实现与至少一个相关在线一手来源，选型时查成熟实现；同任务有效证据复用，测试验证已发表方法在本机是否成立，不猜参数、不重复试模型求绿。委派带来源/复用入口/范围/验收与停止条件，保持OpenCode开发、Codex独立审核及指定模型。
个人文件位于C:/Users/Admin/.codex/skills/research-before-work/与全局AGENTS.md，不属于本项目Git上传；官方quick_validate实际通过，元数据/唯一规则标记/既有路由逐字不变均已检查。没有另启Codex/OpenCode会话测试未来自动匹配，不能承诺所有未来会话已实测；当前会话已收到包含新全局规则的指令。无src/tests/native/scripts改动，无新推理/模型安装/全局服务配置修改；不消耗剩余额度，也不增加后端完成信用。基线/下一任务及本机页面同步后，仅上传受影响项目指令和文档，个人Skill与页面/audit仍不入项目Git。当前下一候选仍LAYA-QUALITY.2，真实调用未新增授权，估算68/100、PARALLEL_WRITE=CLOSED。

2026-10-15 LAYA-QUALITY.1 候选资格过滤独立PASS：用户要求先上网调查、减少实验、验证现成方法。GitHub MCP实际可用，核对官方固定v0.3.21资料/许可/公开fixture，结合LangChain动态工具状态过滤法；仅方法适配，不迁移框架。实际opencode-agent implement首轮session ses_ec14f0146ffe02gzwXPa9l5DDE，native导出50条assistant均opencode-go/deepseek-v4.1-flash、末条finish=stop、wrapper exit0且完整报告；未返工。worker精确修改decision-loop.ts/state-loop.test.ts/b40a-cli-workflow.test.ts三文件，无新增文件，其他206个版本化文件逐字节未变。
复用boundActionCandidates与现有observation.ready：仅在有ready子任务时提供continue，始终保留wait/abort及每个有材料的明确complete目标。请求构造与候选表同次冻结，provider等待期间的状态变化不能补授未提供的key；最终资源/quota/fixed/session/停止门保持。无acceptanceMaterial的旧11动作路径不变，不强迫模型完成任务，也不把ready当实际准入。
Codex独立typecheck及decision429/0、state-loop276/0、CLI98/0、workbench419/0、协作96/0、计划61/0、阶段材料47/0全部exit0，三份源码/测试在验证前后hash稳定。内存负控撤去ready条件后264/12、exit1，未修改源文件；三份历史真实响应离线回放：两个ready为空的旧continue被拒且dispatch0，有ready的旧continue仍可进入受控dispatch；不是新模型选择或准确率。
本轮LAYA/产品Agent推理均0，未启动服务；累计本地11次与产品会话5/5不变。历史LAYA-ACTION.3仍BLOCKED（正向目标完成NOT OBSERVED），本片仅候选资格/受控闭环独立PASS；真实判断质量、完整round/工具/费用未认证。english512/192、multilingual1024/256的文案P2已纠正，统一保守512拒绝逻辑不变，保留支持范围限制、温度校准P2及旧B45负控维护P2。估算68/100、PARALLEL_WRITE=CLOSED，正式前端未进入。
本机证据为project-progress/laya-quality-research.json、native-validate.json、native-export.json、review-state.json、independent-tests.json、captured-replay.json、negative-result.json及logs，全部ignored，不上传；audit只读。只上传三份已独立审核代码/测试与六份受影响文档；main/共享index/其他dirty保留。刷新本机页面并对比数据，不声称浏览器视觉验收。远端快照hash以上传后核验为准。

2026-10-15 LAYA-ACTION.3 修复后真实动作验收独立BLOCKED（协议/安全/可见性通过，正向目标未观察）：用户新批准最多3次本地推理、每次90秒、失败即停不重试，仅离线缓存/合成内存任务，不运行产品Agent/云模型或发送仓库代码。执行前核对CONTEXT.1已审核三文件hash一致，使用一次性phase守卫，保留前轮证据。无worker/新实现。
LAYA-ACTION.3 实际3/3本地请求仍选择continue，原生输入分别494/278/276 tokens；同一实际tokenizer回放确认三例状态均完整可见、材料字段存在、候选可区分，零state截断。生产provider/loop与守卫正确接收合法答案，complete调用0、Task状态未变，受控dispatch均拒绝真实执行；协议/安全/输入可见性通过，正向目标完成仍NOT OBSERVED，因此本片整体BLOCKED。不能据三例断言模型普遍不可用或确定其选择根因；也不能再以本轮材料缺失解释结果。
实际单次elapsed575/63/45ms，仅为本轮观察，不作性能基准；双目标choice分布continue0.3569、wait0.2047、abort0.1517、complete-A0.1691、complete-B0.1177，confidence0.0489；未按未校准分数引入新阈值或强制改选。缺交付/ready原生仍continue，missing案例没有complete候选，不会伪造验收。正常脚本exit0/其PASS WITH P2文本仅表明受控分支断言通过，Codex没有将其提升为目标完成PASS。
同owned服务固定revision55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851、English/multilingual实际CUDA、CPU fallback0；结束validated Job ActiveProcessesFinal0、owned根已删、cleanupFailures0、health端口不再监听。3次许可已耗尽，不追试；累计本地真实11次（历史1+4+3+本轮3），产品Agent仍5/5，本轮产品/云模型调用0，源码/测试/安装/配置改动0。
只读GitHub MCP成功核对官方同版本README Honest limits、staged-adoption与evals：官方自述基础权重在其typed-decisions任务域表现有限，建议shadow/审定标签/独立留出评估后再放行；这些上游结论不是本项目准确率，也不证明本次continue的因果原因。本机evals是已存在的模块文件，不是目录；原生JSONL校验/评价可复用，不安装新依赖。CrewAI quickstart含_DemoAgent关键词/mock回退，未执行、不能当真实模型成功证据。
证据project-progress/laya-action3-evidence.json、token-audit.json、review-state.json、official-research.json及logs均ignored；3POST+1GET、缓存10文件size/SHA256未变，维护文档前209个版本文件hash全相同，main/共享index保持。无新代码，不重复typecheck/fullsuite，diff check通过；本机页按基线刷新。整体后端与并行写边界不变，估算68/100不加分。下一候选LAYA-QUALITY.1仅建议范围，未授权额外推理/微调/下载；本片只上传6份已审核文档快照。

2026-10-15 LAYA-CONTEXT.1 最小输入可见性修复独立PASS WITH P2：用户要求继续快速推进，授权本片开发但没有新增真实推理授权。Codex只读audit，GitHub MCP实际读取官方固定6ab71fb4的common.py（blob e533932001d3b328f705c8b0d5c3b4003df17010），核对dict右截断与head/state预算；当前搜索结果仅作线索，不据新版本增大max_len。不存在的docs/production.md读取失败不冒充MCP认证失败。
实际opencode-agent implement两轮，均实际opencode-go/deepseek-v4.1-flash：首轮ses_ec18e65f0ffe5g5RB0iyhI1hdo因项目外安装源码read权限拒绝提前结束，wrapper0但native finish=tool-calls、零改动，未当完成；最后一次限定重派只用仓内证据，ses_ec18bdc16ffeRCNpGwTAI7MPx0正常finish=stop、49条assistant消息模型一致、完整报告。无第三轮/权限覆盖。worker仅改decision-loop.ts、state-loop.test.ts、b40a-cli-workflow.test.ts；未改CLI/配置/安装包/其他源码/依赖。
LAYA-CONTEXT.1代码独立PASS，整体PASS WITH P2：bounded workflow状态/材料只去掉重复元数据，同任务objective/criteria/output及缺失/截断标记完整保留；原生响应后、任何动作应用前检查checkpoint与token信息，缺失/非正/非有限/未知checkpoint或达到保守512线拒绝，不重试。无material旧11动作与非LAYA通用seam保持。离线实际tokenizer验证双目标原样本由丢383 tokens变为全量可见：English300状态tokens、完整序列494；multilingual完整序列442。中英文/Unicode/长材料共8回放，长材料确认超限；不是模型forward或真实选择验收。
独立typecheck、decision429/0、state-loop236/0、CLI93/0、workbench419/0、协作96/0、计划61/0、阶段材料47/0，全部实际exit0，前后源码hash稳定。内存load hook只移除assertBoundedNativeVisibility调用，state-loop变211/25、exit1，证明新守卫承重，源文件未改，hook按名删除。独立5个真实provider+受控fetch的continue探针：512/900/null/0均无dispatch，511仅到受控dispatch；不是网络/模型推理。
守卫在响应后生效，仍消耗一次决策调用，不是发请求前精确计数。实际固定english配置512/192，multilingual为1024/256；代码统一以512保守拒绝，多语言可能在本可容纳时被拒。源码注释和worker报告误把两者容量都写512，独立审核保留P2并在文档纠正，不把它提升为事实；后续限定维护纠正文案，当前不扩大预算。仅已固定配置假设内的有界保护，不认证任意服务配置/模型判断质量或完整round。
本轮实际LAYA/产品Agent调用0，服务未启动；8个tokenizer回放无forward，保留历史LAYA-ACTION.2的BLOCKED，不把本片代码通过改成其真实完成PASS。下一候选新真实验收尚未授权；68/100与PARALLEL_WRITE=CLOSED保持。证据laya-context-research.json、review-state/两个native-export、independent-tests/token-audit/continue-probe/negative-guard日志均本机ignored；audit只读，页面不入Git。更新基线和受影响路线后刷新页面，精确审核上传独立分支，main/共享index不动。

2026-10-15 LAYA-ACTION.2 独立裁定BLOCKED（安全路径通过，正向完成未验收，发现材料截断P1）：用户明确批准最多3次新本地推理，每次90秒、失败即停不重试、仅离线缓存和合成内存任务。复用既有contained Python服务与生产provider/runDecisionCycle；未启动worker、未修改任何src/tests/native/scripts或Agent配置。三个实际选择依次continue/continue/continue，elapsed724/55/46ms为单次观察，不是性能基准；第一例5候选含2个明确目标，后两例仅3基本动作且无complete。原生response通过客户端校验，受控dispatch回执均拒绝真实执行，所有Task状态保持、complete能力0次；不以正常exit0/协议通过提升为目标完成PASS。
离线使用实际固定english tokenizer及已安装common.build_sequence，无模型forward/POST，重现max_len512/head192：双目标state701仅保留318，丢383，acceptance_material整个字段未进入最终输入；另两例state432/431分别保留416，丢16/15。全部选项marker/span仍可区分；模型未选择complete不能单独归因于截断，但模型未收到交付output已足以阻止材料驱动验收认证。不得改答案或重试到绿。
同一owned服务GET健康实际english/multilingual CUDA、固定revision55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851、CPU fallback0，响应自身无revision不补造。3POST+1GET，累计本地真实请求8（历史失败1+通过4+本轮3）；本轮许可已用尽，产品Agent仍5/5。本轮Job唯一validated control ActiveProcessesFinal=0、stopConfirmed=true、owned root删除/cleanupFailures0，结束health端口ECONNREFUSED；缓存10文件size/SHA256与既有验证相同。校准P2保留。
本轮实现改动0，维护文档前209个可版本文件hash全未变；无需重跑typecheck/套件或fullsuite。证据project-progress/laya-action2-evidence.json、laya-action2-token-audit.json、laya-action2-review-state.json及日志均ignored，本机audit只读。最小下一候选LAYA-CONTEXT.1尚未授权实施/推理；68/100估算与PARALLEL_WRITE=CLOSED保持。仅更新6份受影响文档/本机页，审核快照上传后以远端hash为准；不合并main、不改共享index。

2026-10-15 LAYA-ACTION.1 目标桥接代码独立PASS，整体PASS WITH P2（既有B45负控定位失效）：用户继续推进授权本片，Codex先读audit/调用者与官方已核实0.3.21协议。实际opencode-agent implement，原生session ses_ec1c29b31ffe8q90kxh7SMjS03；导出所有assistant消息均opencode-go/deepseek-v4.1-flash，wrapper0、末条finish=stop、有完整报告；首轮完成，无返工。worker仅改decision-loop.ts、state-loop.test.ts、b40a-cli-workflow.test.ts，round-cli.ts不需改动。
已有acceptanceMaterial作为workflow边界：请求与候选表同次构造，基本continue/wait/abort加每个满足当前to_verify、同taskId/type、执行/criteria非missing且criteria/output非空的complete候选；这是材料存在检查，不是质量或物理文件认证。单目标complete键的描述/表明确绑定唯一任务，多目标complete\0taskId分别绑定，按同次表membership还原，不解析任意目标/默认首任务。拒绝未知key、不一致taskId和意外动作/目标参数；兼容匹配目标重述及reason/rationale，但不合并它们来改变payload。参数化复杂动作在此模式不提供；无material的通用11动作/参数旧路径保留。状态变化仍由现有validateDecision/applyVerification权威拒绝，不新建状态/调度权威。
独立typecheck、decision429/0、state-loop198/0、b40a CLI93/0、workbench419/0、b41协作96/0、b42计划61/0、b43材料47/0全部exit0，验证期间及结束hash一致。state-loop真实provider+原生形状fixture选两个任务中的第二个，只有该目标验收；越界/缺材料/矛盾参数/状态变化拒绝与legacy兼容均覆盖。b40a整个CLI链改走真实provider/fetch seam，响应不注入taskId或parameters，旧成功/未交付/审核断言保留；配置两对合成pair避免单选伪决策。它仍是受控执行端/受控答案，不是真实LAYA推理或真实Agent兼容验收。
独立内存负控仅将所选目标换成候选表第一个目标，state-loop真实exit1且3项新承重断言失败；源文件未改。worker额外报告B45为103/1，唯一旧负控寻找'|| groupRuntimeIncomplete;'；Codex核对本片父def22fb已无该定位串，原测试仍引用、CLI逐字未变，确认为既有测试维护P2，不回退安全门或修改无关源码求绿。worker自建两个b45nc临时hook按创建时间/内容确认归属，按准确名称清理、目录为空后移除；不清理foreign/historical文件。
本轮真实LAYA/产品Agent调用0、未跑full suite，未改模型/安装/缓存/用户配置；产品会话仍5/5、并行写CLOSED、估算68/100不因修复/测试计数增加。LAYA-ROUND.1的旧P1在最小workflow completion范围关闭；复杂自由参数动作与修复后真实next_action/完整round仍未验收，temperature P2保留。下一候选先准备/明确有界本地next_action验收（不消耗产品Agent），获得新推理授权后才实跑；B45负控定位另行小任务，不强塞本轮。证据：ignored laya-action-review-state.json、implement.jsonl/native-export、independent-tests/negative-control/owned-probe-cleanup与差异记录；audit只读，页面/缓存/证据不入Git。

2026-10-15 LAYA-ROUND.1 既有整链只读审核BLOCKED（新P1动作目标桥接缺口；四接口PASS保持）：用户要求继续审核，未授权实现/新增推理。先只读audit，沿runRoundCli、Workbench、Assignment/Session/Scheduler、decision-loop及验收/Review追踪；GitHub MCP成功读取官方v0.3.21固定tag6ab71fb4的agent.py/serve.py/router.py，并与本机0.3.21解码形状核对。没有启动worker/服务或模型任务。
独立发现P1：orchestrationDecisionRequest的next_action只提供动作名，ACTION_PARAMETERS_FIELD只是输入说明；本机/官方0.3.21非生成式choice decoder只输出所列choice、分布、confidence、answer_confidence、action元数据，不生成taskId等新兄弟字段。serve/router转交预测并补routing，不补任务参数。extractAction依赖answer.parameters附加任务目标，而validateDecision对complete强制taskId（无默认目标）。因此选择complete也不能完成真实验收；reassign/rework等需参数动作同样有协议桥接缺口。不是action元数据修复回归，也不取消四预设真实PASS。
受控协议反例（不是新真实推理）：真实TaskStore建合成to_verify状态，经真实provider（fetch seam按官方0.3.21协议形状返回complete）→runDecisionCycle，得status=invalid/code=malformed-decision/缺taskId，任务保持to_verify、dispatches=0；正控在fixture明确提供taskId后现有validateDecision可接受。官方源码静态证据与反例结合定位当前实现缺口，未宣称新模型实测complete。现有b40a fixture在233行主动补parameters.taskId/reason，所以其成功链不能提升为原生LAYA整链证明。独立现跑decision429/0、state-loop169/0、b40a-cli-workflow93/0全exit0；全绿与此协议缺口并不矛盾。所有209个版本化文件在调查/探针/测试后均逐字节未变；后续仅维护6文档/ignored页面。
调用预算是带前提估算，不是新增授权：两步顺序、两份等步数候选计划、每任务>=2可用pair、Skill/MCP关、无handoff/retry/动态操作时，分类1+选计划1+选pair2+派发/验收cycle4=理想8次本地POST，现有cycle上限9使对应总上界13；两个成员duo且两份duo候选计划、恰好两pair时，分类1+计划1+成员pair1（最后成员唯一候选约束规则、集成继承不提问）+6cycle=理想9，上界15（cycle上限12），产品执行分别2/3次。默认原生Review在具备能力且允许审核时至多额外1次执行（withheld/不支持可为0）；--no-review省此调用但必须记录not_requested，不当Review PASS。普通collectAll还可能尝试OpenCode stats/providers list/--version与Codex doctor --json共至多4条CLI命令（正常非抛错分支；三个静态provider不启动CLI），命令次数不等于进程数或模型调用。原生内部辅助模型费用/次数未知，不能给虚假全流程零费用硬保证。
另外两类运行前边界：普通registry对用户新声明pair显式unknown，catalogue/用户免费声明不证明callable；OpenCodeQuotaProvider本地accounting也不给真实额度，未知/unavailable需Assignment/Spawn Gate照常拒绝，不因准备实跑而伪造available/probe。产品原生会话仍5/5、本地4次已用完，无新增真实调用许可。先修动作目标桥接，再谈实际验收预算/资格；不对已封T/W阶段、完整后端或正式前端擅自裁定。工程估算68/100、PARALLEL_WRITE=CLOSED，temperature校准P2保留。
最小下一候选LAYA-ACTION.1需实施授权：复用现有有限choice候选与initial-assignment的精确候选映射模式，让LAYA选择包含具体任务目标的有界动作候选，再映射为预先校验payload送同一validateDecision/applyVerification；先收口workflow必需complete+明确target，不靠调用者默认首任务/拼入猜测参数、不换生成模型/新建manager或第二调度。其他复杂参数动作如尚不支持必须明确标注，不冒充全部打通。证据：ignored laya-round-parameter-probe.json、laya-round-budget.json、laya-round-tests.json、laya-round-review-state.json；audit只读，无生产修复。

2026-10-15 LAYA-DECISION.2 修复后四项真实本地typed决策独立PASS（不是完整生产round）：用户重新明确授权最多4个本地合成POST、每个90秒、失败即停/不重试，现有D:/AI/laya-cache固定权重、无云模型/产品Agent/仓库代码/新增费用。直接复用既有provider/routing/plan-choice/initial-assignment及已验证contained服务生命周期，无开发改动或worker。ignored验收脚本增加一次性授权phase守卫，运行后不能重用同一许可记录，不覆盖前轮失败证据。
真实结果与客户端校验：中文classifyTask→implementation/moderate/review=false，multilingual，734ms；英文→implementation/small/review=false，english，52ms；decideWorkflowPlan在full/lean中选lean，english，73ms；decideInitialAssignment返回所列demo-code-agent×demo-code-model，english，59ms。正好GET health1次+POST4次，4个validatedResponse，raw action元数据保留且未进入parameters，未改变提示词/候选或重试。候选availability为明确合成事实，不冒充真实Agent/账户/免费资格。一次样本的语言间复杂度判断不同如实保留，单次耗时不是性能基准/最优选型证明；usage output_tokens=0符合非生成式接口，不声称节省外部Agent token。
实际response routing证明各checkpoint，response metadata revisions为空，不虚构服务端逐响应revision；同一个owned服务health loaded=[english,multilingual]、两个actual device=cuda、device_is_preference=false、health revisions均55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851，CPU fallback计数0。置信度温度钳制RuntimeWarning仍有，保留P2。独立检查每个实际request/validatedResponse/metadata/候选及计数，确认PASS而非只信脚本summary。结束cancel/真实退出/validated Job ActiveProcessesFinal=0/owned根删除/cleanupFailures=0，服务不常驻。
本轮本地LAYA POST4/4、产品Agent与云模型调用0；前轮1次失败+本轮4次成功合计5次本地验收，不等于产品原生Agent5/5额度。源码/测试/native/scripts未改，不重跑typecheck/full suite；不封整个B1/B4或后端，不进入前端，不打开并行写。工程估算68/100不增加，因为尚未补齐既有round整链真实LAYA与执行/Review/工具的耦合验收。下一候选LAYA-ROUND.1先只读复核既有接线与请求预算、再另行明确模型/费用/次数/数据范围，不自动新增真实调用或新框架。证据：ignored laya-decision2-evidence.json、laya-decision2-review-state.json、laya-decision2-check.mjs；旧laya-decision-evidence.json等原记录不变，audit只读。页面与缓存均不入Git。

2026-10-15 LAYA-COMPAT.1 最小客户端协议修复独立PASS（仅hermetic兼容；真实决策未重跑）：用户继续推进授权本片。Codex先只读audit与当前差异、追踪readChoiceParameters及decision-loop的参数合并消费者；GitHub MCP成功读取NandhaKishorM/laya官方v0.3.21固定tag6ab71fb4，确认agent.py:892/902/913/922的action元数据。复用原provider/isRecord/requireProbability/withServer，无新框架/依赖/安装包改动。
实际通过C:/Users/Admin/.codex/bin/opencode-agent implement委派，原生session ses_ec1f589bcffeXS1cuOTqhUA44l；导出的所有assistant消息providerID=opencode-go、modelID=deepseek-v4.1-flash，wrapper exit0且原生末条finish=stop、有完整报告。首轮完成，无返工；worker仅改src/decision/laya.ts与tests/decision.test.ts。现有validateAnswer对choice/score/noul共同校验可选action为非数组对象且act_probability为有限[0,1]数值；choice保留键排除action，不将其投影为任务参数或覆盖真正编排动作；raw保留。缺action旧响应兼容，未知对象/数字任务参数仍拒绝，原选择/概率/分数校验不变。action内部额外字段只留raw，不扩展通用API或决策权威。
Codex独立审查实际两文件差异与消费者；独立typecheck exit0、decision429/0、initial-assignment-decision37/0、state-loop169/0均exit0。新suite沿用既有loopback stub，无Python/真实模型依赖；捕获协议回归、元数据与字符串参数共存、三类型非法概率、NaN/Infinity的明确fetch seam和非字符串参数拒绝均有覆盖。额外独立取上轮完整捕获JSON，用修复前源码备份provider与当前provider对比回放：旧版DECISION_SCHEMA/action，当前正确implementation/moderate/review=false、raw逐结构相等、parameters无action；仅2次本地内存回放，network=0/真实推理=0/产品Agent=0。不得把回放当新真实调用或选型质量证明。
本轮真实LAYA/产品模型调用均0，不启动server、不跑live/full suite，不改Python/缓存/配置；产品原生会话仍5/5、PARALLEL_WRITE=CLOSED、工程估算68/100。前轮LAYA-DECISION.1的1/4后停止保持历史事实；修复后中文/英文/计划/pair的真实验收仍未完成，下一候选LAYA-DECISION.2须另行确认最多4次本地合成请求、每次90秒、失败即停/无自动重试，不能擅自花剩余额度。Codex仅更新6份受影响文档与ignored页面，audit只读。证据见ignored laya-compat-review-state.json、laya-compat-implement.jsonl、laya-compat-native-export.json、laya-compat-independent-tests.json、laya-compat-independent-replay.json。

2026-10-15 LAYA-DECISION.1 真实本地typed决策验收BLOCKED（1/4后停止，无重试）：用户单独明确允许最多4次本地推理、每次90秒、合成demo、失败即停，不启动产品Agent/云模型、不发送仓库代码、不新增费用。复用既有0.3.21服务、固定缓存与contained ManagedProcess，GET health确认english/multilingual实际cuda、固定revision55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851。第一条中文分类经真实classifyTask→provider POST /v1/systemone返回合法JSON与multilingual路由，raw work_kind=implementation；但客户端readChoiceParameters把官方答案元数据action:{act_probability:1}误当string参数，以DECISION_SCHEMA拒绝。没有validated classification，更不能用raw标签宣称分类通过。英文/计划/pair三项未发送，不自动重用剩余调用额度。
根因取证：本机已安装laya/agent.py:892/902及GitHub MCP读取官方v0.3.21（tag解析6ab71fb4ce6bfd6f189e9b689eaadd67103ed9b6）的同位置均确认action为协议元数据；src/decision/laya.ts的RESERVED缺action，拒绝对象。离线捕获响应回放经真实provider/classifyTask稳定复现DECISION_SCHEMA，network=0；不放宽校验、不删响应字段造PASS。这里只定位兼容缺口，未修改生产实现、未启动开发worker。待用户授权LAYA-COMPAT.1再由OpenCode最小实现，Codex独立审查；保留未知对象/数字任务参数拒绝，不新增调度/manager或改安装包。官方源码：https://github.com/NandhaKishorM/laya/blob/6ab71fb4ce6bfd6f189e9b689eaadd67103ed9b6/laya/agent.py#L892 。
本轮实际POST=1、validated结果=0、无自动重试、其余3项NOT RUN。finally确认cancel/真实退出/validated Job ActiveProcessesFinal=0/owned根删除/cleanupFailures=0，服务未保留常驻。0.3.21加载器置信度温度警告P2仍保留。源码/测试/native/scripts未改，不重跑typecheck/full suite；离线回放不是新增模型调用。本机证据与网页不入Git；产品Agent累计仍5/5、PARALLEL_WRITE=CLOSED、工程估算68/100不增加。证据：ignored laya-decision-evidence.json/laya-decision-review-state.json。旧LAYA-ENV.1的无推理结论仍只描述其历史范围。

2026-10-15 LAYA-ENV.1 现有环境找回、固定缓存恢复与离线加载/health独立PASS（无推理，不封后端）：用户继续推进后从历史Git da17f61的DECISION_PROVIDER找回C:/Users/Admin/laya-venv，实际解释器/metadata确认laya0.3.21、torch2.11.0+cu128；当前默认C:/Users/Admin/.cache/huggingface/hub不存在。不能把此前只查base/Python312未找到升级成全机未安装。初次真实lazy服务（LAYA_PRELOAD=0、离线、127.0.0.1:8077）经现有provider GET健康通过、loaded=[]且警告无checkpoint；结束Job空/owned清理通过，不当作可推理证据。
用户明确授权恢复固定版本英语/多语言、网络上限3GB/临时磁盘6GB、只离线加载和health无推理，并最终指定D:/AI/laya-cache。官方固定revision55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851公开metadata确认精确10文件、合计1,524,397,210 bytes；实际仅下载这些文件（typed-decisions未下载），复用现有huggingface_hub1.33.0/snapshot_download、token=False/禁隐式token/禁telemetry/禁XET，受控Job总30分钟与payload/磁盘预算，未安装/升级依赖。当前本机huggingface.co metadata和下载实际可达，不沿用历史网络受阻推断。下载payload计数1,524,397,210 bytes，缓存总1,524,403,676 bytes；全部10文件大小及官方LFS SHA256或Git blob哈希匹配。Windows无symlink支持只警告降级缓存，未开启开发者模式或管理员改系统。
固定缓存离线预加载：真实已安装laya.serve，无fake Router或服务响应；进程级HF_HOME=D:/AI/laya-cache、HF_HUB_OFFLINE=1、TRANSFORMERS_OFFLINE=1、LAYA_MODELS=english,multilingual、LAYA_REVISION固定，provider唯一GET /health返回ok=true、两checkpoint实际cuda、device_is_preference=false、revision均固定值，cpu_fallback计数0、provider warnings=[]。stderr仍有受影响choice温度钳制/置信度未校准RuntimeWarning，列P2，不扩展到调参或包升级。加载后独立再次核对10个缓存文件均仍匹配官方摘要，未发生tokenizer配置改写。
三次contained Job（lazy服务、下载、离线loaded服务）分别positive stop、ActiveProcessesFinal=0、owned根已删、cleanupFailures0。服务cancel后rootExitCode1属于协同终止事实，不伪称服务启动或推理失败；当前服务未保留常驻。诊断artifact初版stopped字段保持初始化false，与已确认stopConfirmed/validated Job0不一致，已在ignored helper及记录中按正面证据统一，不重跑服务制造通过。所有探针/缓存不入Git，audit只读，src/tests/native/scripts未改，不需开发worker；本轮仅事实/运行说明文档上传，不调用Agent/模型推理、不读既有凭据/改全局或Agent配置、不跑full suite。工程估算保持68/100，正式前端未进入。下一候选只在新有界授权后做本地LAYA typed决策兼容验收，不消耗或重置已用完的产品Agent5/5额度。证据见ignored laya-env-health.json、laya-cache-manifest.json、laya-cache-download-state/control.json、laya-env-loaded-health.json、laya-cache-post-load-verification.json、laya-env-review-state.json。

2026-10-15 B2.2 显式用户模型池→普通CLI候选来源接线代码独立PASS，整体PASS WITH P2（仅委派报告收尾问题，不是生产正确性发现）。用户“继续推进”授权此有界片，不扩大真实推理/安装范围。复用seedRegistry/ModelRegistry、冻结池及admitUserModelPoolPair、buildQuotaCenter、现有Assignment/最终准入；仅改src/quota/index.ts、src/cli/round-cli.ts，新增hermetic tests/b22-model-pool-candidates.test.ts并登记既有test-timed runner。当前admitted free/included声明才补新entry，完整id/source保留，已有配置/probe/thread记录不覆盖。新增pair-specific unknown防止Agent安装/可用事实将声明模型自动提升；真实普通CLI测试确认声明进入initial selection但Assignment以no-available-agent拒绝、runtime0。未知quota仍quota-blocked/runtime0；已有probed固定pair与无池旧入口均完成原顺序链，pair不换。
先本地核对全部调用者，再通过GitHub MCP检索/读取anomalyco/opencode固定revision37df62f4a1b6d89187a1169187a6cef10557c0ca配置文档与MIT License：显式允许/禁用候选方法可参考，仓库未归档、维护活跃；只采方法不复制/安装代码，Windows既有contained launcher不变，不引入manager/registry/路由器/依赖。
真实委派opencode-agent implement首次+一次有界test-only返工；原生session分别ses_ec247e7d2ffebD6rlZDGaMHaC1（44 assistant）与ses_ec23bd28affe9FEsVzTDYb8171（17 assistant），sanitize export逐条确认provider=opencode-go/model=deepseek-v4.1-flash。首次原生进程由持有原句柄的监视确认exit0，返工wrapper exit0；两次native末尾均finish=tool-calls而非stop，未收到完整最终报告。首次临时原地mutation命令、返工共享TEMP固定名日志命令被worker工具权限拒绝（错误仅记录The user rejected permission to use this specific tool call，不能据此推断用户亲自拒绝或具体内控原因）。未重试这些写入、未放宽权限；Codex以只改内存的registerHooks负控完成必要验证，不把exit0当交付PASS。报告完整性列P2，不发第三轮worker，不改变模型路由。
首版测试缺异常finally：Codex在首次runRoundCli注入异常，子进程exit1且2个owned目录残留，已按记录确切路径回收。一次返工仅test：改用SessionStore移除不必要真实Agent factory discovery；整套catch/finally统一清理，唯一exit同时读取fatal/failed/cleanupFailures。相同异常注入后exit1、原错保留、2目录均已自行删除。删除失败注入时33/0仍exit1、ledger保留，父只清理1个记录根目录。所有故障注入均独立child/内存钩子，不改工作树或扫描/终止foreign进程。
Codex独立实跑typecheck exit0；新套件33/0；quota184/0、assignment235/0、b41-collab-group96/0、spawn-gate-production50/0、model-pool95/0；real-agent-isolation 6 opt-in/0违规，ownership60/0。另有独立seedRegistry+buildQuotaCenter 9断言通过；去掉pair unknown保护时assert真实失败exit1；去掉normal CLI传池接线时31/2、exit1（两条真实wiring断言失败）。负控初次匹配两处由自身guard在测试前拒绝，已限定seed调用后命中，不当生产finding。AST确认runtime.run生产边1（orchestration/orchestrator.ts:1403），新增authority0，diff check通过。运行中与结束均保持主HEAD/index/其他dirty文件；audit只读，本机证据/page不入Git。
LAYA仅运行已有decision/check.ts --probe健康GET，exit1、ok=false/fetch failed；未调用推理、未启动/安装服务、未读凭据/改用户或Agent配置。已授权产品会话仍5/5，本轮产品新增0，不跑full suite。新声明pair已能进registry不等于已能执行，真正的pair可用性/账户资格/动态额度/真实LAYA仍需独立证据。工程估算保持68/100，PARALLEL_WRITE=CLOSED，B2/B4/完整后端不封板，正式前端未开始。证据见本机ignored b22-task/rework-task、两轮jsonl/model-evidence、process-completion、independent-*.json/log、setup-fault-before/after、negative-availability/cli、architecture及review-state。

2026-10-15 B4.7.4 后端CLI接线只读核对完成（不是新增产品阶段封板）：直接复用createLayaDecisionProvider.probe，只向本机/health发送GET（共3次：provider健康检查及两次有界原因核对），无任务文本/认证/POST；ok=false、fetch failed，进一步有界GET确认ECONNREFUSED。当前PATH未找到laya-serve；miniconda3与Python312的distribution元数据未找到laya，只能说明这两个环境，不能推断全机未安装。未启动/安装服务、下载权重、读凭据或改用户配置。
源码核对：round-cli已有真实LAYA分类、计划、pair和Skill/MCP选择入口；健康诊断已有decision/check.ts --probe，无需再造doctor/manager。seedRegistry仅从配置默认model、quota probe的modelHint及真实历史thread取模型；--model-pool是过滤与最终启动限制，不会为普通CLI注册声明中的新模型。独立纯值探针使用真实seedRegistry/parseUserModelPool/admitUserModelPoolPair和受控配置/线程输入，6项断言通过：同一2模型声明下空配置/空历史候选0、单配置1、双历史2。该证据不代表完整round、真实可用性或额度；首次探针对列表顺序误作假设而失败，改为比较精确集合后通过，未改生产代码。
GitHub MCP成功读取NandhaKishorM/laya官方README（blob b1e4b90f4ba260ff7dc6bb5482cb39bdca37bb0a）与serve.py（blob c5eb2860d985118f90c1ff19ff78807505a5dd6c）：上游/health使用side-effect-free已加载agent accessor，非推理入口；上游默认端口8000与项目8077不同，不能将上游版本当本机安装或据此乱启服务。仅参考接口/运行方式，不引入依赖或迁移框架。
本轮仅维护文档及ignored诊断/页面，src/tests/native/scripts原始hash保持；不需新开发worker，不跑full suite/真实模型，已有5次产品会话不重置。结论为“只读调查完成，真实LAYA接线就绪性受环境阻塞”；优先定位/恢复已有LAYA环境，代码侧下一候选B2.2只补显式用户声明池到既有registry的来源接线，仍保留unknown可用性/费用及全部Assignment/Spawn Gate拒绝。不得把目录枚举升级为授权或为跑通硬塞available quota。工程估算保持68/100，PARALLEL_WRITE=CLOSED，正式前端未开始。证据project-progress/b474-health-probe.json、b474-health-cause.json、b474-registry-probe.json及本轮审核状态仅本机ignored。已修正文档中Skill/MCP“未实现”的过时表述，实际仍仅advisory/观察，不认证真实工具调用。

2026-10-15 B4.7.3 固定free duo代表性真实样本独立PASS（不封整个B4.7或后端）：用户明确追加1个产品原生会话，累计上限5、此前已用2，本轮一次新样本实际用3、累计5/5剩0。官方当日模型表仍列两个候选为Free，已审核工作快照与92e3ba5逐项一致，安装包公开元数据1.18.35。直接复用已审核entry及生产Workbench→Assignment→Session→Scheduler→Runtime→真实OpenCode，未注入fake执行器；协调选择与可用性/额度输入仍为明确标记的确定性测试驱动，不声称真实LAYA、账户额度或独立Review已运行。无源码实现缺口，未另开开发worker或改默认模型。

实际按序3次任务/3个Workbench session/3个独立native session/3个Attempt，组内只有2个pair，集成复用成员1的Space Bunny：m1 ses_ec26d049affeoflO9TGh9cyyGi＝opencode/space-bunny-free（5个assistant）；m2 ses_ec26cafe3ffeopsMG8IAbr8aJs＝opencode/mimo-v2.6-flash-free（5个assistant）；integration ses_ec26ba625ffeLfxzoqb27Lrss7＝opencode/space-bunny-free（11个assistant）。独立sanitize export全部finish=stop、相应消息cost均0；费用只作原生报告，不证明账户账单或覆盖不可观察的内部调用。原生任务耗时21798/67900/55326ms，均<90秒且时间区间无重叠，无第四模型、额外LAYA/Review或自动重试。

三个真实任务均read本次demo/README.md，成员2read真实provider模块并写src/consumer/add.test.mjs，集成read两者并写可执行src/integration/integration.mjs；本次无external_directory拒绝。原生工具直接write/edit均在本次隔离demo中，不携带当前仓库代码，PARALLEL_WRITE仍CLOSED。entry真实exit0/PASS：3任务均succeeded、全部交付通过，6个本次owned controls（3 native+3 Node检查）均经生产验证函数认证Job空、activeProcessesFinal=0，commands/controls匹配，cleanupFailures=[]，本次原owned root w44-p9x9VB已被原cleanup删除。历史失败样本仍保留，不用本次成功抹去；本次无权限放宽，说明改善仅在此样本获得支持，不保证将来必定服从。

Codex未直接接受entry PASS：取证hook只在同次evidence落盘后、原cleanup前，保存有界demo文件/同次transcript/control及选定RunResult身份/时长字段；不改变判断、执行或清理。逐字hash核对副本后，独立运行原始生成模块8个案例、原始模型node:test及原始集成程序（实际spawn Node消费该测试）；三者exit0。只在独立owned副本把add改成减法，原模型测试与原集成程序均真实exit1（2负控），再恢复副本原字节。5个独立contained Node命令均确认停止、同次5个控制记录Job空，独立owned上下文清理完成。未修补模型产物冒充其成功。独立模型信息/身份/顺序/时长/6个原controls/5个复核controls/源文件未变均通过；本次入口exit0与独立复核exit0，不重跑full suite或历史125/0（本轮无代码改动）。一次本地证据读取默认GBK失败在任何export调用前退出，明确UTF-8后通过，不是模型重试。

源码/测试/helper/runner/配置均与启动快照raw hash一致；主HEAD/index保留。本轮只上传本次结论及受影响文档；页面、audit、原生exports/transcript、生成demo副本全部留ignored本机区域。已使用全部5个产品会话，下一调用必须明确新范围与上限，不自动续费或重置。工程估算仅代表性真实验收能力由1/4加到2/4（新证据为真实两个模型协作+实际可执行交付），总计67→68/100，其余能力不变；不是按测试数加分，也不代表后端完成。真实LAYA选择/Skill-MCP执行/动态额度/完整需求批准与用户监督仍有缺口，整体B4.7及B1/B2/B3/B4/B5不自行封板，正式前端未进入。下一步先确认这些剩余后端验收/最小使用闭环的范围，不自动开始前端或新模型测试。

证据见project-progress/b473-authorization.json、b473-real-evidence.json、b473-capture-manifest.json、b473-native-model-evidence.json、b473-native-read-evidence.json、b473-independent-review.json、b473-review-state.json及原始logs（均不入Git）；官方价格来源https://opencode.ai/v2/docs/console/models/只支持当日公开Free条件。

2026-10-15 B4.7.2a Demo内最小准备与承重回归独立PASS：用户“继续推进”授权该test-only切片。复用既有createB47FreeDuoStack、候选builder、Workbench brief、Assignment/Scheduler及verifyDeliverable；OpenCode由opencode-agent implement首次+一次返工完成，两次wrapper均exit0、原生finish=stop。独立sanitize export确认首次ses_ec282815affeYr2hzWAIg1yfTc的30个assistant、返工ses_ec27eb41dffekLGjSJ0WD86g50的12个assistant均opencode-go/deepseek-v4.1-flash；无子代理，本轮产品模型调用新增0。

仅改既有tests/b47-free-duo.test.ts和tests/b47-free-duo-entry.test.ts：prepareB47Demo在同一stack构造入口、首runtime前创建provider/consumer/integration目录，并仅在不存在时写一次README；同一5条说明进入objective→候选→真实RunRequest.prompt：新建空demo为预期、各自准确路径、无需API/settings/repo、限cwd不探查parent/aux/store/sibling、权限拒绝应报告。未预写add、测试或集成产物，重复准备不改既有模块/README。未复制仓库代码、未改任何权限、费用/次数/模型或生产执行配置；这是advisory说明，不是权限强制或保证真实模型服从。

首次121/0未作为最终PASS：Codex内存hook断开真实stack的prepare调用，原测试仍121/0 exit0，因测试提前手工准备同一目录。唯一返工改用全新未手工准备的seam目录，观察同一个首RunRequest到达时的README/目录/产物缺失状态。最终Codex独立typecheck exit0、入口125/0 exit0、ownership60/0 exit0、isolation6 opt-in/0违规exit0、default NOT_RUN exit0；同一未改负控现123/2、exit1，两项失败准确命中未接线的README/三目录。额外独立实际请求/Node探针确认完整说明进入全部候选和首prompt、产物未预写、缺失模块被实际contained Node拒绝、同次Job空/ledger匹配、重复准备保留原模块字节，cleanupFailures0。没有恢复旧代码、没有第三轮实现、没有重试真实产品任务。

源码src/native/scripts/helper与已有dirty树保持；本片只上传已审核两个测试文件及受影响文档，主HEAD/index不动；audit只读、取证export/本机页面均不入Git。B4.7.2真实失败证据及旧保留目录不删除、不据125/0认证真实多模型可用或免费。累计产品会话仍2/4、剩2，工程估算保持67/100、PARALLEL_WRITE=CLOSED、正式前端未进入。下一候选B4.7.3一次全新3会话duo需要额外允许1个、累计上限5后才可启动；保留原free pair/隔离demo/各90秒/无独立LAYA-Review/失败停止范围，不以本片“继续”重置计数或自动重试。证据：project-progress/b472a-model-evidence.json、b472a-rework-model-evidence.json、b472a-independent-probe.json、b472a-negative-wiring-first.log、b472a-negative-wiring-final.log、b472a-review-state.json和独立定向logs。

2026-10-15 B4.7.2 一次完整真实free duo样本独立BLOCKED：用户明确允许新增1个产品原生执行会话，累计上限由3改4，历史已用1，本次剩余3；原两个free pair/新建隔离demo/每会话90秒/不收费或另启LAYA-Review/失败不自动重试继续有效。开始只读读取audit，核对工作快照与已上传db7aae4逐项一致、本机公开安装包仍1.18.35。官方模型表本次仍列Space Bunny Free及MiMo-V2.6-Flash Free为Free（https://opencode.ai/v2/docs/console/models/）；只作为当前公开价格，不作账户资格、额度或全流程费用证明。

实际直接复用已审核的tests/b47-free-duo.test.ts，生产Workbench→Assignment→Session→Scheduler→Runtime→真实OpenCode；没有注入fake执行器。确定性协调/可用性与额度输入仍是明确标记的测试驱动，不声称真实LAYA或Reviewer。原入口每次最多3个原生执行任务；Codex从已用1到累计上限4只启动本次一次driver，未重试。为避免成功清理丢失产物，Codex使用ignored只读取证hook：原evidence写入后、原cleanup前复制本次有限demo文件/owned transcript/controls；没有改变执行、验收、权限、退出码或清理逻辑，缺产物记录为missing而非补造。没有源码实现缺口，本轮未启动开发worker、未更换其默认路由。

实际首会话ses_ec48220ebffewUviKFfpwueqQ2耗时9740ms，原生sanitize export的5个assistant均opencode/space-bunny-free、消息cost均0；最后finish=tool-calls，不是stop。实际tool trace：在空demo内查目录后，尝试read本轮aux/opencode-config.json（demo外）触发external_directory权限询问，OpenCode非交互CLI自动reject，工具返回permission rejection，随后idle退出。未出现目标src/provider/add.mjs，demo无文件；第二成员MiMo独立任务与集成从未派发。不将辅助small_model调用情况提升为独立成员执行证据，也不把消息cost0视为账户费用或全部内部调用已覆盖。

独立GitHub MCP读取成功：anomalyco/opencode v1.18.35 的packages/opencode/src/cli/cmd/run.ts，blob cccc2550179f87bb74763004910028f79ade60c9；非交互loop在permission.asked且无auto时reply reject，session.status idle时退出，finish只在session.error存在时置非零。因此实际native exit0与任务没有交付可以并存。现有adapter的runtime state=succeeded来自该exit0；Workbench task仍to_verify，独立Node检测真实目标缺失得到exit1，整轮entry exit1/BLOCKED，fail-closed阻断下游，没有把该状态当产品完成。

本轮两个owned controls（OpenCode与独立Node check）均经readControlRecord/treeStopConfirmedFrom验证Job空、activeProcessesFinal=0；各自rootExitCode=0/1，commands/control计数匹配、cleanup eligible=true、cleanupFailures=[]。失败entry按原策略保留确切owned root w44-gpwXqv，含本次证据，不声称owned目录残留0；无进程树未停止事实、不按PID/name扫描终止、不删除foreign目录。源文件/tests/helpers/runner全部raw hash与启动快照一致。执行1次entry exit1、一次原生sanitize export exit0、独立facts探针exit0；本次没有代码修改，未重复typecheck/96/0回归（它们是B4.7.1b历史证据），未跑full suite。

产品会话本次用1，累计2/4，剩2；没有消费完剩余3、没有重置或自动重试。B4.7/B整体仍未封板、PARALLEL_WRITE=CLOSED；估算保持67/100。下一建议B4.7.2a只补隔离demo内最小任务说明/目录骨架和hermetic材料交付回归，明确空目录为预期、只在cwd内完成、不读aux/store/兄弟目录；这只是降低无必要探查的最小建议，尚未实现，不能保证模型将遵守。不得添加--auto/--yolo/dangerously-skip-permissions或改系统/用户配置；若以后再跑3会话完整duo，须另行追加原生次数，不因“继续”触发本次失败重试。证据：project-progress/b472-authorization.json、b472-real-evidence.json、b472-native-model-evidence.json、b472-capture-manifest.json、b472-independent-facts.json及logs，原生export/本机页面/audit全部不入Git；本轮只上传已独立确认的裁定及路线文档。

2026-10-15 B4.7.1b Demo路径收口独立PASS（仅测试入口，不封整个B4.7）：按用户“继续推进”下发bounded任务，OpenCode经opencode-agent implement实际执行一次、wrapper exit0、session ses_ec48dcd77ffeosAdfpVJzmwlTp。Codex读取sanitize原生export，25个assistant消息均为opencode-go/deepseek-v4.1-flash、finish=stop；无子代理、无需返工。worker只改既有tests/b47-free-duo.test.ts与tests/b47-free-duo-entry.test.ts，生产src/native/scripts、helper与已有dirty内容保持不变。

保留同一内置duo builder与真实Workbench/Assignment/Session/Scheduler路径；具体目标和验证统一为src/provider/add.mjs、src/consumer/add.test.mjs（导入../provider/add.mjs）、src/integration/。没有根目录fallback/猜测搜索/挪动真实模型产物，也没有新增DAG/执行器。旧Node台账、身份分层、task-budget、pair/费用/期限、3native/90秒、unknown停止保护均保留。

Codex独立实跑typecheck exit0、b47-free-duo-entry 96/0 exit0、ownership60/0 exit0、isolation6 opt-in/0违规exit0、default entry NOT_RUN exit0、git diff --check PASS。额外独立Node探针走同一verifyDeliverable+fact sink，检查根目录decoy拒绝、历史真实Space Bunny模块在正确scope通过、错误scope模块失败、consumer真实导入/运行、最终测试、失败consumer与集成拒绝，共7个contained Node命令；全部同次validated Job空、facts/control匹配、cleanupFailures0。集成断言仍是既有artifact引用+最终consumer测试，不能据此声称真实集成模型运行或其artifact被执行。内存hook仅将provider读取恢复旧根路径，不修改工作树：91/5、exit1，5个失败证明回归承重；不是重试至偶然成功。

本轮产品推理/原生执行会话新增0；开发worker与Node验收不是产品模型会话。上轮Space Bunny实跑1次与元数据cost0/5案例为历史证据，MiMo独立任务及完整duo仍未验证。原授权总3已用1剩2；完整新duo需要3，下一B4.7.2须额外批准1个会话（总上限4）后，才能启动一次新的完整3会话样本。免费pair/隔离demo/各90秒/不收费或另启LAYA-Review的原范围保留；未重置次数、未自动重试，未开放PARALLEL_WRITE、未进入正式前端。工程估算保持67/100，不用测试数增加完成度。

独立探针初次用不存在command在createOpenCodeAdapter发现阶段抛LAUNCHER_UNSUPPORTED，任何Node/Agent启动前停止；已改受控Node command且7检查通过。其初次owned目录w44-eM6GD9（无control记录）按保守策略保留；自动审批拒绝其确切递归删除，返回blocked by policy，未换工具绕过。仅该已记录目录留作用户手动清理，不能声称本轮所有temp残留0；不影响产品代码或contained停止正确性。audit仅只读。证据见project-progress/b471b-model-evidence.json、b471b-independent-probe.json、b471b-negative-control.log、b471b-review-state.json及定向logs，均不入Git。审核通过的3个测试文件（含既有ownership入口登记）与受影响文档可上传前向快照，未上传页面/audit/原生session export；主HEAD/index保持不变。

2026-10-15 B4.7.1a单点关闭，真实双模型验收仍BLOCKED：经真实opencode-agent implement首次+唯一返工，wrapper均0、native finish stop，32/51条assistant元数据均opencode-go/deepseek-v4.1-flash；本片没有worker子agent。只改既有两测试文件。独立typecheck、b47-free-duo-entry83/0、ownership60/0、6-entry isolation guard通过。原Node事实丢失修复：同一ManagedProcess finally把fact送进real commands sink；独立实际Node成功/错误模块/启动后停止读取抛错probe证明成功事实与control对齐、失败验收不抹去、未知stop不可清理。nativeSessions改为orchestrationSessionIds，真正nativeThreadIds只取同次RunResult.threadId。未新增生产manager/authority/依赖。

首次启用入口在runtime前被budget-scope-unavailable拒绝，0个模型启动；Codex禁止Agent启动的诊断复现真实gate原因，发现test harness漏task预算。唯一返工复用现有BudgetManager.task，像production round-cli一样初始化root和实际committed children一次，保存skipped/waiting原因；同构hermetic admission证明无预算不进runtime、有预算到受控fail-before-start钩子。此为测试setup问题，不放宽生产gate。两个pre-runtime失败根和诊断根均按精确自有路径清理，不扫描外部目录。

之后按已批准范围真正执行了一次：仅opencode/space-bunny-free原生会话启动，任务RunResult succeeded、原生thread ses_ec49e8720ffenXx375gf3FE4qS、att_0001、当地session ws_0001；独立sanitize export有9条assistant，provider/model均opencode/space-bunny-free，finish stop，9条消息报告cost均0（仅该原生元数据，不证明账户账单/所有辅助调用）。实际生成src/provider/add.mjs，add(a,b)返回a+b；Codex在同次owned Job下独立执行5个正/负/零案例全通过，module源码和同Attempt transcript已复制到ignored本机证据后清理。native+入口Node失败检查+独立正确路径Node检查共3条validated control均success/ActiveProcessesFinal0，精确自有根删除、无PID/name kill。

双模型失败原因是验收输入/路径不一致：内置duo member1的fileScope为src/provider/**，模型如实写src/provider/add.mjs，入口却验根add.mjs而得ERR_MODULE_NOT_FOUND，立即阻止后续。MiMo未执行独立任务、集成未运行，不能称整个duo通过；辅助small_model是否产生内部请求仍unknown。P1为任务fileScope/交付与实际验收路径矛盾，非模型不可调用/生产DAG或Job缺陷。B4.7.1a的Node台账/身份/预算接线范围PASS；B4.7 overall及整个真实验收BLOCKED。没有第三轮修改/自动模型重试。此前批准最多3个原生执行会话，本轮实际用1，剩2；新完整duo仍要3，不能擅自超过原总上限，需要明确追加范围或选择2会话内的不同验收目标。已有免费/数据授权不重问，无付费/独立LAYA/Review授权。

本轮未独立通过的整体entry仍保留本地，Git只上传裁定文档；src/native/scripts及所有其他既有文件hash未变，shared HEAD/index不动，PARALLEL_WRITE=CLOSED。2026-10-15官方价格页仍列两候选Free；仅原生Space Bunny当前调用已证明，MiMo完整任务/两模型协作仍未验证。估算保持67/100，不以83测试或重复单Agent事实增加能力信用。记录：project-progress/b471a-independent-node-probe.json、b471a-real-native-model-evidence.json、b471a-real-artifact-verification.json、b471a-final-owned-cleanup.json及两个worker model evidence；所有本机记录/网页/audit不进Git。Codex独立模块探针第一次导入路径错误，在任何进程启动前失败，已纠正后检查通过；不隐瞒为生产缺陷。

2026-10-14 B4.7.1免费双模型验收入口独立BLOCKED（首次+唯一返工已结束）：真实opencode-agent implement两次，wrapper均exit0、原生session均finish=stop；独立export确认首次58条assistant与返工46条assistant均opencode-go/deepseek-v4.1-flash，返工2个只读探索session的11/14条亦同模型。首次独立拒绝硬编码辅助模型不可达及文件存在弱验收；返工已补版本1.18.35的OPENCODE_CONFIG临时配置、真实Node检查、3次启动前约束与来源分层，但主执行台账仍未接Node命令事实。

独立typecheck exit0；b47-free-duo-entry实跑68/0、exit0；real-agent-isolation为6个opt-in/0违规、exit0；ownership60/0、exit0；diff check通过。测试绿不能覆盖实际success loop：runNodeCheck形成fact，verifyDeliverable返回值丢掉fact，runRealDuo仅commands.push(kind=native)却统计native+Node的全部owned control。独立Node-only最小探针（未调用任何模型）：实际add正/负/零检查成功、node exit0、一个validated Job已空，返回结果无fact，实际cleanup decision报control-record-mismatch:expected=0:observed=1，探针exit1；自有根目录已安全删除、cleanupFailures0。完整3native+3Node成功链会账目不匹配并保留根目录，不能认证入口通过。不伪称生产Job containment失效。证据project-progress/b47-entry-node-ledger-probe.json、b47-entry-model-evidence.json及独立测试logs仅本机ignored。

新增/修改只在tests/b47-free-duo.test.ts、tests/b47-free-duo-entry.test.ts、tests/real-agent-isolation.test.ts登记；生产src/native及其他已有代码hash未变，shared HEAD/index未变。未独立通过的3个测试改动保留本地、不上传到审核分支；本次只上传基准/下一任务裁定。P1为Node事实没有进入真实共享清理台账；P2：报告nativeSessions目前来自Workbench本地sessionId，须区分本地Session与真正native thread；异常导致outcome=null时清理保护还需针对实际路径复核，不把已确认Node成功探针扩成物理逃逸证据。不得新建管理器或框架，下一片只补返回并fold同次fact、相同执行路径回归与身份命名。

用户已明确允许小样本：仅新建隔离demo、Space Bunny Free+MiMoV2.6FlashFree、最多3个原生执行会话/各90秒、不调用收费/独立LAYA或Review、免费条件未知就停止。授权保留，因入口P1本次真实产品推理0、额度未使用，不要求用户再次批准同一范围。下一候选B4.7.1a只做承重台账接线，需新任务下发后继续；不可用改任务名绕过本片两轮上限。不封B4.7/B整体，不开放PARALLEL_WRITE，估算仍67/100。

2026-10-14 B4.7本机免费候选目录核对完成：用户要求继续后，直接复用collectModelCatalog默认contained路径，无runner注入；只运行原生OpenCode models一次，不运行doctor其他Agent/probe或任何推理。owned launcher copy+隔离cwd，20秒上限，1170ms完成，status=ok、共43项；opencode/space-bunny-free与opencode/mimo-v2.6-flash-free完整ID均存在。当前原生目录还列cat-jam-free、exo-free、ling-3.0-flash-fin-free、ling-3.1-flash-free、longcat-2.5-preview-free、muse-spark-1.3-contributor-free、nemotron-3-ultra-free、nemotron-3.5-lightning-free、step-5-preview-free；不将名称当当前免费资格/模型效果。只读本轮唯一owned control，经readControlRecord/treeStopConfirmedFrom认证success及ActiveProcessesFinal=0；cleanupFailures=0、owned root已删除、进程退出0。保存project-progress/b47-native-free-catalog.json，不进Git；不读/删除共享control，不扫描终止foreign进程。真实模型推理0、当前callable仍unknown；源码/配置/模型路由未改。目录核对不提高真实验收完成信用。

2026-10-14 B4.7免费池与成熟实现调查（用户要求先网上调查，不随机试跑）：源码旧ACTIVE_FREE_MODEL_POOL为opencode/space-bunny-free、opencode/mimo-v2.6-flash-free、workbuddy-intl/hy3，来自9月30日历史证据；B2.1已明确旧池不是当前免费账户事实，用户声明池独立准入。GitHub MCP本轮可用：9Router公开provider registry动态读取OpenCode官方models目录，accountFallback实现模型/账户冷却、有界退避，executor说明会话标识需保持；MIT、未归档、活跃，但不把README无限免费承诺当事实。不复制其协议指纹/工具注入，不引入第二网关。CLIProxyAPI亦MIT、未归档、release workflow明确windows-amd64/arm64；config.example已有路由/会话亲和/重试/冷却，适合作为以后统一API的可选外部能力，不负责现有Task/Session/Job/Verification。无需现在安装任何项目。

官方公开目录GET及models.dev元数据首次读取成功（不登录、不读凭据、不发推理），后一次补齐保存请求15秒超时如实保留，不循环重试。优先首组候选opencode/space-bunny-free + opencode/mimo-v2.6-flash-free：项目已有pair，官方当前价格页仍列Free；额外公开候选cat-jam-free、step-5-preview-free、longcat-2.5-preview-free、ling-3.1-flash-free、nemotron-3.5-lightning-free、muse-spark-1.3-contributor-free仅为目录/价格研究，不写registry或放宽池。官方部分促销模型可能收集数据，Space Bunny/Step5/LongCat标明零留存；使用效果/角色适配不靠模型名推断。OpenCode价目中GLM5.3Flash及DeepSeekV4.1Flash为付费路线，不将其价格迁移到WorkBuddy或Go订阅；x0.06不是免费证明。

最小建议路线：保留用户DSH GLM目标为独立绑定待办，先复用已有OpenCode多模型、--model-pool、Assignment和B5.1停止安全接力做首个免费代表验收；无新selector/router/manager/service。不能绕过用户fixed锁；自动模式才在合格池内选下一pair，停止未知不接力、额度尽或无免费候选就等待，不转收费。OpenRouter官方已有优先models fallback及openrouter/free随机路由，前者可参考，但后者不适用于要求特定模型的任务；API回退不等于已执行工具任务的安全重放。尚未授权真实模型运行，不声称本机当前callable或全流程零费；开发worker仍DeepSeekV4.1Flash。未跑任何测试或真实Agent，本轮仅研究和文档，估算保持67/100。

来源：[OpenCode官方当前价格/免费与数据政策](https://opencode.ai/v2/docs/console/models/)、[公开模型目录](https://opencode.ai/zen/v1/models)、[9Router provider源码](https://github.com/decolua/9router/blob/ce4460ef79382bfddb4aa5fc0ff9f3cb0d5f95a8/open-sse/providers/registry/opencode.js)、[9Router冷却源码](https://github.com/decolua/9router/blob/ce4460ef79382bfddb4aa5fc0ff9f3cb0d5f95a8/open-sse/services/accountFallback.js)、[CLIProxyAPI配置](https://github.com/router-for-me/CLIProxyAPI/blob/main/config.example.yaml)、[OpenRouter模型回退](https://openrouter.ai/docs/guides/routing/model-fallbacks)。详细只读研究产物project-progress/b47-free-pool-research.json保持ignored；不用它作为调度权威。

2026-10-14 B4.7 GLM离线接入验证完成（未接通真实模型）：用户进一步指定截图WorkBuddy组的`GLM-5.3-Flash · x0.06`，并明确本轮只做不调用模型的验证。x0.06是界面倍率，不能解释为货币价格或免费证明。独立执行9项断言：真实生产adapter validateRequest拒绝指定GLM；直接调用本机0.1.5-rc.2 headless启动解析器（未挂载runner）确认普通任务可解析、--model被拒；直接实例化已安装默认模型服务，以受控settings source证明其可覆盖composition selection。此项为真实安装代码+受控服务边界证据，不证明真实provider可调用、桌面与CLI配置同源或GLM实际机器ID。定向`node tests/dsh-adapter.test.ts`实跑64/0、exit=0；不调用真实Agent/模型、不读取现有凭据/用户设置、不改src/tests/native/安装配置。官方GitHub MCP读取provider文档成功，SHA 773ff6722a8558720a458f7574940972cf976958；不将上游master能力提升为本机能力。离线产物`project-progress/b47-glm-offline-contract.json`含安装源码hash，保持ignored。当前仍需内部provider/model ID及可验证的任务绑定，B4.7真实验收NOT RUN，PARALLEL_WRITE仍CLOSED，完成估算不增加。

2026-10-14 用户更新B4.7第二目标：DSH改用`GLM-5.3-FLASH`，替代下述Hy3限免目标；OpenCode仍为`opencode-go/deepseek-v4.1-flash`。这是验收目标选择更新，不是实际Agent默认配置变更或真实推理验收。GLM显示名不证明内部provider/model ID、可调用或免费；Hy3截图限免信息不沿用。开发委派worker仍使用DeepSeek V4.1 Flash。

2026-10-14 B4.7模型目标补充（只读可行性核对，真实推理0）：用户选OpenCode DeepSeek V4.1 Flash及DSH里WorkBuddy分组的“Hy3 · x0.00 · 限时免费”；不能替换成截图另列的Hy3 x0.05。现有OpenCode实例完整请求ID为`opencode-go/deepseek-v4.1-flash`，B5.1原生委派元数据105/90条已验证，属于开发委派历史证据，不是产品B4.7真实验收。

本机npm DSH安装包0.1.5-rc.2的headless启动语法只有任务位置参数，runner读取`agentDefaultModel.currentSelection()`；现有项目adapter modelSelection=false，独立直接调用生产validateRequest确认model=hy3以UNSUPPORTED_OPTION拒绝，未创建transport/未启动Agent。发现桌面应用公开app.asar根包为`@deepseek-ai/dsh-desktop@0.2.0-rc.2`，其中headless已含JSON/session选项，仍从默认model服务取selection；它与当前npm CLI、desktop/headless profile不是同一已验证配置。未读取用户profile/settings/凭据，只读安装包公开源码及asar清单。

GitHub MCP本轮实际检索/读取官方headless README成功（e7776f059198c60d206962c2deecbbb26d510df2），路径apps/headless失败是路径不存在，不称服务不可用。[官方provider文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md)允许配置第三方/自定义模型，profile分开；不能据master已支持JSON/session宣称当前npm CLI拥有该能力。本机launcher确有--patch overlay入口，但default model服务可被settings层覆盖，仅加patch不能认证实际选中Hy3。

最小接入方向是复用现有DSH adapter，先确认免费档的真实provider ID/model ID及headless可达性，再验证不可被settings覆盖的任务级绑定/原生反馈；无充分协议证据不打开modelSelection、不重建adapter/网关、不改DSH安装、桌面默认或凭据。截图是用户所指档位的证据，没有内部ID、优惠截止或当前账户资格；不把x0.00当永久免费或硬费用保证。当前待确认的是机器ID/绑定和费用范围，不是要求重新选择全部模型。无真实推理/新实现/阶段封板，PARALLEL_WRITE=CLOSED，估算不增。


2026-10-14 B4.7：**仅真实验收准备完成；尚未运行真实产品模型，不作验收PASS。**

- 用户授权继续；开始只读读取audit观察资料、当前基准/下一任务、真实与hermetic入口。核对OpenCode adapter的逐请求model、cwd、JSONL/sessionID、工具/usage事件与终态；复用runRoundCli、计划文件、Assignment/Session/Scheduler、原子Attempt/RunResult及owned isolation，不新建执行/测试框架。旧native e2e包含硬编码历史模型、隐式真实review/较长运行，不能直接当本次有界入口启动。
- GitHub MCP实际搜索当前官方run.ts无结果；按dev旧路径读取失败后目录读取成功，确认上游目录布局不同。随后明确v1.18.35 tag取得旧路径run.ts（SHA cccc2550179f87bb74763004910028f79ade60c9）。不是认证/服务不可用，不据dev推断本机行为。本机安装包package.json标识1.18.35/MIT/win32与native exe入口；这不是本轮二进制version实测。
- 官方[CLI](https://opencode.ai/docs/cli/#run)核实--model provider/model、--dir、--format json、session续接；官方[Go](https://opencode.ai/v2/docs/console/go/#usage-beyond-limits)明确Use balance启用时可超额扣余额。因此目录、订阅名称或旧cost0均不认证本次零费用；本轮未读取账户/凭据/余额或更改设置。
- 已准备最小验收：仅本轮owned隔离demo，实现与测试两步；若只获一个pair，先验功能A顺序/材料链；若明确两个pair，再验功能B duo（三次执行含集成）。不发送现有项目源码，不启动真实推理直至范围明确；最大次数指原生会话，不是Agent内部LLM请求次数或USD硬上限。最终产物由当前Codex独立检查/实跑，本机已有自动review若需新真实调用必须另计授权，不用fakeReviewer PASS冒充真实审核。
- 核对真实执行请求、same Attempt输出/工具事实、Session/thread、native反馈模型（取不到则unknown）、实际文件字节/测试结果、validated tree-stop及owned清理。若决策provider只用既有受控seam，须明示，不认证真实LAYA判断。旧硬杀/账号额度注入不作为本小样本必选项，不重跑W/T全部阶段。
- 所有src/native/tests/config与安装保持原字节，未调用产品Agent/模型、未查询凭据或账户，未委派worker（无实现缺口需写代码）。git diff --check通过；尚不为只读准备跑typecheck/fullsuite或加信用，能力估算仍67/100。页面仅更新B4.7等待范围；视觉检查仍未获准，不绕浏览器策略。
- 唯一待补：用户给出实际pair、费用/包含额度与超额扣费范围、原生会话上限和可发送数据。async问题已提交，未把等待超时当作授权。真实调用未执行，B4.7/B5整体不封板，PARALLEL_WRITE=CLOSED。


- 准备记录已上传且远端hash确认：`codex/b47-real-agent-preflight`，[c09f12b](https://github.com/yunxibaili/D-Native-Multi-Agent-Orchestrator/commit/c09f12b0065010d6e00b541af39451e794cb1df2)；仅3份文档，src/native/tests/config不变。初次脚本命名置换误沿用上一任务的safe-model-handoff-review-pass后缀，已另建明确preflight分支；初始同commit别名保留，不代表真实验收PASS。不删除远端分支，main/index/dirty树保持，页面及audit排除。

2026-10-14 B5.1：**Codex独立 PASS WITH P2，仅已知session_failure的停止安全/具体model有界接力。**

- 开始只读读取audit三文件；调查现有continuation、唯一reassign、Runtime错误分类和原子执行证据。GitHub MCP实际检索BerriAI/litellm并核对MIT范围、活跃未归档及官方reliability方法；只参考有限模型fallback，不引入Python/Rust网关、manager、依赖或第二执行权威。
- 实际opencode-agent implement首次+唯一返工，session分别 `ses_ec631e473ffev5CQsndWBGV2th` / `ses_ec618341affeAHF042Z4KfvjOq`；原生export的105/90条assistant元数据全部 `opencode-go/deepseek-v4.1-flash`，finish=stop。两次外层exec提前exit1且wrapperExit未知，未据此重复派工或宣称wrapper成功；确认首次原生进程不在、会话完成；返工持原process handle确认原生退出exit0。这是委派监测P2，原因未确定，不能将原生完成冒充wrapper exit0。
- 首版绿测试遗漏workflow路径：独立复现handoffPolicy TDZ；仅内存hoist后暴露stop未确认提前迁移、实际requests=[m1,m3]却fromModel=m2/previousAttempt=att1的P1。返工已初始化policy、全CLI reassign检查同次停止事实、workflow失败边界转交canonical driver，并从packet关联Attempt取fromModel；独立原探针现requests=[m1,m2,m3]、来源对应，未停确认探针仅m1且身份保持。
- 独立实跑全部exit0：typecheck、continuation **170/0**、handoff-production-round **416/0**、b14-selection **179/0**、b40a-cli-workflow **93/0**、b46-workflow-checkpoint **42/0**、execution-lifecycle **136/0**、resource-claim **192/0**、isolation守卫5 opt-in/0违规、diff check。Codex验证脚本曾把b46套件名称误替换为不存在的b51，真实命令exit1后立即更正；不是产品失败，也未称该错误命令通过。
- 独立CLI池接力probe：有效声明m1→m2为runtime2；paid/unknown/expired/池外/未注册target均runtime1、旧m1不迁移、非零。first/second checkpoint-stop probe原因明确用户停止、不泛称fan-out。实际owned部分文件字节保留/新会话/停止未知时仍活着的受控Node writer由suite验证；fixture不提升为真实Agent/Job逃逸证据。
- 两内存负控不改源码：退回Agent-only move→391/22、exit1；去workflow boundary→399/13、exit1。AST确认原continuation120和handoff312个check条件全部保留。production runtime.run边1、新authority0。OpenCode只修改4个限定源/测试文件；native/runtime/adapters/config及其它源码保持。Codex更新文档与ignored派生页；审核及首次上传前audit三文件hash与起始相同。末尾复核时README/audit-log已追加B5.1旁路观察记录，hash改变；本任务写操作均未触及audit，未覆盖其内容，不依据hash变化反推作者身份。
- P0/P1：本片已关闭。P2：外层委派监测异常；真实Agent的服务故障分类、停止事实取得与实际model未证明，恢复后workflow仍待验证/下游。原B4.6a报告文案P2已关闭。P3：Codex最初两个TDZ探针在返回owner前抛错，未记录创建的temp目录路径，不能证明其残留为0或安全定点删除；没有扫描批删。后续所有独立probe记录精确owned路径并finally清理；harness异常路径也走同一清理ledger。两份before JSON曾被复跑覆盖为after，不作为不可变修复前证据；首次工具输出/hoisted日志与报告分开。
- 本机进度数据已刷新并与唯一基准比对；浏览器安全策略此前拒绝本地视觉检查，未换通道绕过，不能宣称页面视觉核验通过。后端能力估算65→67/100，来自安全接力信用1→3/6；页面按5%档仍显示65%完成/35%剩余，分母不含产品前端，不是测试数或工时比例。完整后端仍有真实模型/费用、工具和用户需求闭环缺口。
- 本轮不跑fullsuite，不调用产品真实Agent/模型或查账户，不读凭据/改配置；Codex不代写产品实现。下一候选B4.7先明确模型、费用和数据范围，再做小型真实验收；尚未授权推理。审核快照上传事实以远端hash核对后追加，main/共享index/dirty树保留，project-progress全部excluded。


- 已上传并核验远端：`codex/b51-safe-model-handoff-review-pass`，源码/审核快照 [5adc537](https://github.com/yunxibaili/D-Native-Multi-Agent-Orchestrator/commit/5adc5377a392c58f25b9e3619ad86118bd1c4fe2)，父e30e899f0183181741c2a9d1754500e64c737a58；12个精确文件、206个完整版本化文件tree与当前规范化字节一致。main/共享index/dirty树保持，页面与只读audit全部排除。此上传事实同步为单独文档提交，不改源码或结论。

2026-10-14 B4.6a：**Codex独立 PASS WITH P2，仅同进程任务边界用户检查点。**
- 先调查HumanGate/NextRoundInput、RoundResult、既有Verification/continue、CLI有界循环、fixed/stage/model-pool与资源保护。GitHub MCP成功查阅[LangGraph仓库](https://github.com/langchain-ai/langgraph)与MIT LICENSE（未归档、活跃）；[官方interrupt说明](https://docs.langchain.com/oss/python/langgraph/interrupts)明确持久化与节点重启/副作用重放依赖。只参考外部输入与验收分离，不引入Python框架/检查器/新状态权威。
- 实现只改round-cli、新增workflow-checkpoint小模块、扩展b40a测试、新增b46 reader/协作测试、登记既有test-timed；Codex不代写产品实现。一次实现+一次有界返工：首session ses_ec67066feffe26lYX2Ep2AyQAT导出78条assistant全部opencode-go/deepseek-v4.1-flash、finish=stop；返工session ses_ec65f3f4bffe5lXi49ZaK4dTjx的44条全部同模型、最后finish=tool-calls。两个wrapper exit0；返工改动已落盘，但测试工具调用权限被拒，未产出最终报告。工具仅给permission rejected，无更详细原因，不能把exit0/实现方自述当验证通过；不追发第三开发轮，下面结果均Codex独立执行。
- 首轮独立65/0、30/0仍复现带值开关被忽略、第二步停止却声称全未验收；返工收口为写前exit2/正确保留此前验收，并补非Error抛出、非法输入、空/不满足输出继续、生产默认非TTY和EOF/短timeout/error回归。最终独立：typecheck exit0；b40a **93/0**，b46 **42/0**，协作 **96/0**，选择 **179/0**，阶段 **47/0**，Workbench **419/0**，lifecycle **136/0**，resource **192/0**，isolation守卫5 opt-in/0违规，diff-check均exit0。旧42个check调用点及条件（归一EOL后）保留；runtime.run边1、authority0。
- 同进程真实CLI链+受控provider/runtime：首步stop仅runtime1/to_verify、下游/集成未运行；第二步stop保留第一步succeeded；continue仍走原验收；snapshot脱离权威且冻结。collaboration停止保留成员实际文件；此b46 fixture的集成输出不另作真实Agent或真实多模型集成能力证据，既有b41直接验证另列。
- 两个内存负控（无工作树改动）：跳过用户检查点→47 passed/10 failed且fatal/exit1，原停止路径错误整轮成功；跳过带值flag校验→36/6、exit1，实际提前拒绝断言承重。独立检查点等待期间clock推进probe：用户continue后下一任务拒绝user-pool-expired，runtime仅首步1、下游无Attempt。非实际账户费用查询。
- 最终reader在真实Windows PTY stdin.isTTY=true，收到continue后自然exit0；只证明标准stdin读取，不证明真实Agent执行。EOF/短timeout/input error用实际readline+受控流；成功和失败child不调用process.exit，独立实跑正常退出。
- P2仅既有未完成Review原因泛称fan-out(0成员)；不改变真实阻断/退出/状态。P3工具限制：本轮本地URL被浏览器安全策略拒绝，已运行refresh并核对本地快照，但不声称完成视觉验收。未绕过浏览器策略。
- 测试owned b40a/b46目录0；实现方3个外部readerprobe脚本按写入记录+当前内容哈希逐项确认后仅删除对应文件，未删共享目录/foreign文件。没有真实产品Agent/账号/网络任务、full suite、安装/依赖/系统配置变更；保留PARALLEL_WRITE=CLOSED与整体未封板。
- 规划估算固定100分母：监督/用户输入信用0→2（5权重），总65/100、展示约65%完成/35%剩余，区间30–50%，不含正式前端，不由测试数计算。完整监督/实际纠偏恢复仍不足。下一候选B5.1先调查已有中断/停止/continuation的一个实际缺口，未启动。
- Git上传已核验：`codex/b46a-user-checkpoint-review-pass`，代码/独立审核证据提交 [fec5d18](https://github.com/yunxibaili/D-Native-Multi-Agent-Orchestrator/commit/fec5d18ebc9baa142ecd5b61c1036da80da3f002)。main/共享index/原dirty tree保持；本机页excluded且仅核验数据，视觉访问受策略限制。此上传事实随后单独同步，不改变产品代码或结论。

2026-10-14 B2.1a：**Codex独立 PASS（用户声明池最终启动准入的受控最小范围）**。B2.1两个历史P1已关闭，B2 overall未封板。
- 本地确定性单点修复，沿用前轮已核验的ModelPool/Assignment/Spawn Gate/Workspace/最终freeze，不重复安装或引入第三方系统。本轮只改orchestration/orchestrator.ts与既有b14测试；生产增38行含注释，无新模块/依赖/manager/authority，未改runtime/adapters/native/费用配置。
- 实际opencode-agent implement首轮完成，无返工。原生session `ses_ec7240877ffeYX9AaojoDK8odN` 的44条assistant元数据全部opencode-go/deepseek-v4.1-flash，finish=stop、wrapper exit0；Codex模型不变。
- Codex独立typecheck、选择 **179/0**、Workbench **419/0**、execution-lifecycle **136/0**、阶段 **47/0**、协作 **96/0**、Git协作 **104/0**、resource-claim **192/0**、isolation守卫5 opt-in/0违规、diff check全部exit0。原120个check调用点/条件完整保留（对应原155条运行覆盖）；AST生产runtime.run边仍1，位置orchestration/orchestrator.ts:1403，新增authority0。
- 四个新增路径经真实Workbench→Assignment→Scheduler/executeTask、真实共享WorkspaceManager/claim book、受控Runtime：prepare期间到期拒绝且runtime/onStart/Attempt=0、status不动/lease issued/claim0；声明一直有效正常1次执行；无池旧入口正常；prepare期间actual pair迁至已注册未列pair时拒绝，不冒充旧session归属。migration只为测试控制race，不授权生产绕过WB约束。
- 原Codex阻塞probe独立重跑（保留旧失败记录，新记录单列）：runtime从1变0、skipped=模型不可用且missing user-pool-expired。探针为真实executeTask+受控prepare/time/runtime，不代表实际Git耗时或真实Agent收费。
- 两组内存负控：跳过最终检查→168/11，跳过实际claim释放→176/3，均exit1；分别证明到期/actual pair的阻断和真实claim释放断言承重，工作树代码/测试原始哈希不变。未为演示制造bug或强行返工。
- 无full suite、产品真实模型/账户/费用查询；free/included仍是用户声明，paid/unknown仍拒绝，默认无池不承诺免费。PARALLEL_WRITE=CLOSED，B1/B4/B3/B2整体不封板，正式前端未启动。
- 后端规划估算固定100分母：发现/用户模型池信用8→9，费用声明准入信用1→2，合计63/100，展示约65%完成/35%剩余（区间30–50%）；增量来自已交付的约束闭环，不来自测试数量。真实资格/硬预算/共享额度/内部辅助费用仍不足。
- 本轮独立审核快照已上传并核验远端：`codex/b21a-final-admission-review-pass`，代码/审核证据提交 [580dbc4](https://github.com/yunxibaili/D-Native-Multi-Agent-Orchestrator/commit/580dbc48f7555fea8b328422408e7034d8a5d742)。main/共享index/dirty tree保持，project-progress全部excluded。本上传事实随后单独同步，产品代码不变。下一候选B4.6待用户下发。


2026-10-14 B2.1：**Codex独立 BLOCKED，1个最终启动检查P1未关闭；测试全绿不等于费用准入完整。**
- 调查复用仓内ModelPool/modelKey、SelectionSpec、Assignment、Workbench和Spawn Gate。GitHub MCP成功读取[LiteLLM allowed-model admission](https://github.com/BerriAI/litellm/blob/main/litellm/proxy/auth/auth_checks.py)与LICENSE/维护状态；非enterprise代码MIT，Python/Rust网关不符合本地最小接线成本，未复制/安装。只参考白名单+拒绝方法。OpenCode[模型身份](https://opencode.ai/docs/models/)与[small_model官方说明](https://opencode.ai/docs/config/#models)核对后，不把主模型选择当内部所有费用限制。
- 实际调用opencode-agent implement：首调用仅调查/部分基线测试，项目外日志重定向遭工具权限拒绝，无实现；下一调用写入限定源代码后被中断，无完成报告；随后有界续作/一次代码返工关闭配对碰撞并补测试。最终session `ses_ec7470ebcffetc5C6suVmZJzlE` 导出81条assistant元数据，全部opencode-go/deepseek-v4.1-flash、finish=stop、wrapper exit0。未换Codex模型，Codex未代写产品实现。
- 独立实跑：typecheck、b14-selection **155/0**、model-pool **95/0**、Assignment **235/0**、Spawn Gate **50/0**、Workbench **419/0**、协作 **96/0**、Skill/MCP **119/0**、阶段 **47/0**、contract **248/0（2 skipped）**、isolation守卫5 opt-in/0违规、diff check均exit0。AST确认原46个check条件全保留，生产runtime.run边1（orchestration/orchestrator.ts:1365）、新增authority0。
- 两个独立内存负控：恢复复合键查找→153/2、忽略expiresAt→147/8，均exit1。后者实际进入runtime=1/onStart/sessionTouched=1/Attempt=1，证明新启动门断言承重；源码/测试哈希未改。
- 受控逻辑race补充probe：声明有效时分配并通过既有execution gate；真实executeTask随后await工作区准备，受控prepare将时钟推进5s（expiry在1s后）；runtime请求仍1、无skipped。这是生产调用链+受控workspace/runtime/时间的逻辑证据，不是真实Git耗时、Agent收费或Job物理证据。原suite只覆盖tick前过期，未覆盖这个窗口。P1必须下一片关闭。
- 仅5个既有产品源文件+既有测试1文件变化；无新模块/runner/依赖/manager，runtime/adapters/native/生产配置不改；无full suite、产品真实模型/费用/账户查询。开发worker推理单列。PARALLEL_WRITE=CLOSED，B2及其他overall不封板。
- 本轮审核快照已上传并核验远端：`codex/b21-model-pool-review-blocked`，源代码/审核证据提交 [2486869](https://github.com/yunxibaili/D-Native-Multi-Agent-Orchestrator/commit/2486869171b31fd9ea5f5bdd8e5e2fc0cb6e781d)。明确包含未关闭P1，不合入main。共享index、HEAD、dirty tree保持；本机进度页全部排除。本行上传事实记录随后单独同步，代码不变。


2026-10-14 B3.2：**Codex独立PASS；具体Server/Tool的advisory请求与名称匹配观察闭环，不是原生MCP实际调用认证**。
- 先调查仓内B3.1、TaskIntent/brief、DecisionProvider及OpenCode adapter既有tool_use映射；GitHub MCP本轮成功读取[同版本MCP catalog](https://github.com/anomalyco/opencode/blob/v1.18.35/packages/opencode/src/mcp/catalog.ts)和MCP index。已安装包metadata仍为1.18.35；源码tag不冒充本机MCP实跑。该源码的isError结果抛错；[官方MCP说明](https://opencode.ai/docs/mcp-servers/)明确启用工具会增加上下文，因此本轮不声称prompt选择能裁剪定义或节省Token。沿用上轮已核实MIT/活跃/Windows分发的OpenCode，不安装/迁移框架。
- 实际委派 `opencode-agent implement` 一轮，无返工；原生session `ses_ec7719f67ffesMJJb1Lab9ljTl` 导出98条assistant元数据，全部providerID=opencode-go/modelID=deepseek-v4.1-flash，finish=stop、wrapper exit0。Codex未代替worker写产品代码。
- 独立实跑typecheck与扩展现有B3.1/B3.2套件 **119/0**；AST核对原有59个check调用点及条件全保留（对应原64条运行断言），没有克隆新suite/runner/测试框架。Workbench **419/0**、handoff-production-round **312/0**、阶段 **47/0**、协作 **96/0**、Git协作 **104/0**、contract **248/0（2 skipped）**，isolation守卫5 opt-in/0违规；均exit0。diff check PASS。
- 新套件用真实createOpenCodeAdapter.mapEvent（launcher seam、不启进程）把native tool_use frame映射到ToolCall再投影；这是原有adapter代码与受控frame证据，不是真实MCP服务调用。
- 独立真实CLI/受控Runtime probes：MCP-only duo两成员+集成者三次执行/三条各自请求与观察、仅两个pair、集成者复用成员pair；碰撞目录在provider/runtime均0时exit2；跨Agent同名事件保留来源但equalsRequested=false。
- 两组独立内存负控：忽略名称碰撞→118/1，接受未完成事件→116/3，均exit1。源码/测试原始哈希不变。AST生产runtime.run边1，新增authority0；首轮无需为了演示返工制造缺陷。
- 本轮仅5个产品源文件（2新纯值/preset、CLI、既有TaskIntent/brief接线）和既有测试1文件；未改runtime/adapters/native/runner/依赖/生产配置。测试/定向probes均hermetic，开发worker推理单列；未跑full suite或产品真实Agent/MCP，owned b31临时目录0。PARALLEL_WRITE=CLOSED，B1/B4/B3整体未封板。
- 审后精确快照拟上传独立 `codex/b32-mcp-review-pass` 分支；只在远端hash核对成功后报告上传完成，保留main/共享index/dirty tree。project-progress全部excluded。


2026-10-14 B3.1：**Codex独立PASS，限任务级原生Skill受控最小闭环；MCP与B3整体不封板**。
- 调研实际使用GitHub MCP，核对[OpenCode仓库](https://github.com/anomalyco/opencode)为MIT、未归档且活跃；本机已安装包metadata为1.18.35。源码以[同版本Skill工具](https://github.com/anomalyco/opencode/blob/v1.18.35/packages/opencode/src/tool/skill.ts)及[官方Skills说明](https://opencode.ai/docs/skills/)为依据，不用dev代码推断已安装版本。直接复用仓内intent/brief/DecisionProvider/Assignment/RunResult工具记录；未复制上游框架、安装SDK或新增服务。
- 通过 `C:\Users\Admin\.codex\bin\opencode-agent implement` 首轮+唯一返工。实际session分别为 `ses_ec79bc71affej88yCJT3rASw2d` / `ses_ec78b6765ffesmnsB5H0b1bZIK`，原生export中92/60条assistant元数据均为 `opencode-go/deepseek-v4.1-flash`，两次finish=stop、wrapper exit=0；不是仅据环境变量推断。
- Codex首轮独立发现ownership守卫被纯parser样例误触发（真实exit1），以及跨Agent同名调用的文本关联不清楚。唯一返工只改新测试/观察投影/CLI；守卫本身未改，未加allowlist或削弱断言。补JSON+文本跨Agent回归和duo成员/集成者Skill接线。
- 最终独立实跑：typecheck；B3.1 **64/0**、阶段 **47/0**、协作 **96/0**、Git协作 **104/0**、Workbench **419/0**、decision **397/0**、ownership **60/0**、tick-outcome-contract **33/0**，真实Agent隔离守卫5 opt-in/0违规；全部exit0。`git diff --check` PASS。
- 独立真实CLI/受控Runtime的跨Agentprobe：同名外来调用保留actual agent，但 `agentMatchesAssignment=false`、`equalsRequested=false`，文本明确来源不匹配；这是受控证据，并非真实handoff测试。
- 两组独立内存负控：去掉intent交付 / 接受未完成工具事件，都使实际suite出现3条失败并exit1；前者随后因缺少预期证据触发fatal，不能当作完整64条负控遍历。源码/测试原始哈希未变，无临时回退工作树。AST生产runtime.run调用边1，新authority0。
- 本轮改动范围为3个生产文件（2新纯值/决策preset+CLI接线）、1新测试、既有测试runner登记与受影响文档；runtime/adapters/native/依赖/生产配置未改，owned b31临时目录0。未跑full suite、未调用产品真实模型、未读凭据/改本机Agent配置，PARALLEL_WRITE=CLOSED。
- 已核对并上传首份源码/文档快照 `8ee75251b730a9a92ee6cf874b795b30dce13600` 至独立 `codex/b31-skill-review-pass` 分支（远端hash已验证）；页面复核后再补文档展示字段的前向快照，保留main/共享暂存区/dirty tree。本机project-progress全部excluded。


2026-10-14 B4.5a：**Codex独立PASS；B4.5受控最小Git顺序协作范围可封板，本轮停止，B3.1未启动**。

- 本次为既有API的小型缺失接线，直接复用WorkspaceManager/ResourceClaim/scopesOverlap/路径normalizer与同一完成门，不新增外部框架、依赖或authority；未重复完整第三方调研。
- 实际wrapper C:/Users/Admin/.codex/bin/opencode-agent，role=implement。首轮ses_ec9d044eaffestdBVNBFQK6iqg的61条assistant、唯一返工ses_ec9c26caaffezPv0zSbg28gmpy的39条assistant元数据均为opencode-go/deepseek-v4.1-flash；两次finish=stop、wrapper exit0。有完整报告，仍以Codex独立核验裁定。
- worker严格改2文件：src/cli/round-cli.ts、tests/b45-git-collaboration.test.ts。CLI把当前组运行期保留声明fold进executionIncomplete，复用同一完成事实控制ok/exit、review和Human Gate；不按root taskId误匹配成员claim，不全局阻断无关组。
- 首轮独立确认原P1已关闭（有无no-review均exit1/review0/ok=false/incomplete=true/gateComplete=false）；另复现scope-only声明已规范化而groupScope原生Windows路径未规范化，仍误报成功。唯一返工复用normalizeScopeForWorkspace(handle.workspaceId,handle.cwd)并补回归，未新造路径处理。
- 最终独立3个probe：最后集成者stop-unconfirmed、同场景加no-review、不同workspaceId但真实scope重叠；全部retained>=1、exit1/reviews0/ok=false/incomplete=true/gateComplete=false。声明通过真实生产资源API保留；是受控故障注入，不是OS活进程/逃逸证明。正常duo/trio、非重叠声明、脏文件、创建失败、nested拒绝仍通过。
- Codex本轮独立实跑全部exit0：typecheck；b45-git-collaboration 104/0（原74保留）；b41-collab-group 96/0；b43-stage-material 47/0；b40a-cli-workflow 42/0；resource-claim 192/0；unified-review 130/0；real-agent-isolation 5 opt-in/0违规。旧orchestration 968/0、execution-lifecycle 136/0为B4.5上一轮证据，本轮未重复计作实跑。
- Codex独立内存loader负控：删完成保护→94通过/10失败、真实exit1；恢复原始groupScope→100通过/4失败、真实exit1。跑的是实际suite断言；两次源码/测试原始哈希前后一致，未修改工作树。生产AST runtime.run边仍1、新增authority/依赖0；diff check独立PASS，测试cleanup ledger无失败且当前b45前缀temp目录0。
- 过程偏差如实记录：worker返工负控曾短暂把允许的CLI文件改回旧表达式后恢复，违反了本任务“负控不改工作树”的要求；最终恢复内容已独立核对、无额外差异。Codex没有接管修代码，最终负控证据采用自己的内存loader重新验证，不用该偏差冒称流程完全合规；不作为残留源码blocker。
- 未跑full suite/产品真实Agent推理，worker推理单独记录；未读取凭据/安装依赖/改本机配置，不启动B3.1/B2/B5或正式前端。Git仅支持root启动和committed base的最小路线，最终集成由用户显式处理。
- 规划估算：功能A/B与项目计划信用14→16/18（Git受控交付闭环补齐），整体56→58/100；页面按5%档显示完成约60%、剩约40%，合理剩余35–55%。这是按原100权重分母的工程判断，不是测试数量/工时/真实模型可用率。
- 上传目标codex/b45a-review-pass，父b9b59e8ae4c78a8870a219a89d5c6fa64fc5c69e；准确commit/上传结果以本轮远程核对及会话交付为准。保留main、共享暂存区与dirty树；project-progress/全部不入Git。

2026-10-14 B4.5a：用户明确授权继续审核前运行期保护单点。Codex重新核对现有retainedResourceProtections、物理workspaceId/scope、report.ok及executionIncomplete向RoundResult/Human Gate的传递；此为已有API的小型缺失接线，不重做外部框架调研。只委派CLI和本阶段测试改动，不推进其他阶段；当前实施中，不是PASS。

2026-10-14 B4.5：**Codex 独立 BLOCKED，未封板；唯一返工已用完，本轮停止**。

- 调研：本轮 GitHub MCP 成功查询 [openai/symphony](https://github.com/openai/symphony) metadata（Apache-2.0、未归档，pushed 2026-09-15）；读取其 [SPEC §9](https://github.com/openai/symphony/blob/main/SPEC.md) 的同工作单元复用工作区，以及 [Git worktree 官方文档](https://git-scm.com/docs/git-worktree)。仅方法参考，未复制/安装其服务、未完成其全部 Windows/安全审计；直接实现复用仓内 WorkspaceManager/Git/Claim/executeTask。
- 实际 wrapper：C:/Users/Admin/.codex/bin/opencode-agent，role=implement。首轮 ses_ec9f5cc5fffeBz70e2XDPMZOuA 的 84 条 assistant、唯一返工 ses_ec9e5d301ffe8I094YCSFDNNOQ 的 61 条 assistant 元数据均为 opencode-go/deepseek-v4.1-flash。首轮 finish=stop、wrapper exit0。返工 wrapper exit0，但最后把 diff 写入固定 TEMP/rc.diff 的工具调用被拒绝，finish=tool-calls、无完整最终报告；不把 exit0 当作完整正常完成。Codex未重试该固定路径写入，以实际磁盘/只读 diff 和独立验证接续审核。
- Worker 改动仅 6 个文件：src/cli/round-cli.ts、src/orchestration/orchestrator.ts、src/orchestration/workspace.ts、tests/b41-collab-group.test.ts、tests/b45-git-collaboration.test.ts、scripts/test-timed.mjs。未改 runtime/adapters/native/依赖/生产配置；Codex未代写实现。
- 主链独立实跑：duo/trio 的真实临时 Git worktree/文件字节/组 owner 与独立 task/session/pair、最大写并发1、脏文件 HEAD/index/内容不变、创建失败不回退、同组保留声明阻止后续读写及不同组隔离均通过。fixture 证明接线与 Git/文件行为，不证明真实 Agent 多模型兼容。
- 首次独立 probe 复现审核 cwd=用户检出和 nested cwd 被静默改到 worktree 根；唯一返工后再独立确认 reviewUsesGroup=true，以及 nested 拒绝 exit1/runtime0/review0/no tasks/用户检出不变。
- **剩余 P1 的实际独立 probe**：真实 runRoundCli/临时Git repo，把最后集成者的 frozen RunResult.cleanup.treeStopConfirmed 注入 false；生产日志确认 task round-mv6wpgld-int 的 claimsRetained=1，仍 requests=3/reviews=1、review completed/pass、executionIncomplete=false、ok=true、exit0。根因是 round-cli.ts 的 review guard 仅使用 workspace.unconfirmedProtections（Git创建保护），未检查 workspace.retainedResourceProtections（运行期Claim）；后者的taskId是成员/集成者，不能只匹配root owner。不是物理存活/逃逸证明，不将受控注入升级为 OS containment 失效。
- Codex 最终独立执行全部 exit0：typecheck；b45-git-collaboration 74/0；b41-collab-group 96/0；b42-plan-file 61/0；b43-stage-material 47/0；b40a-cli-workflow 42/0；resource-claim 192/0；execution-lifecycle 136/0；orchestration 968/0；unified-review 130/0；real-agent-isolation 5 opt-in/0违规。现有 suite 绿不能覆盖独立 probe 的 P1。unified-review 出现 owned 临时目录 ENOENT warning，未升级为本阶段根因。
- AST 生产 runtime.run 边=1（orchestration/orchestrator.ts）；新增 authority/依赖=0；本轮测试 cleanup ledger 无失败，owned b45 临时目录已回收；git diff --check 再独立核对。
- 不跑 full suite/产品真实 Agent 推理，不读凭据/改本机配置，不开启 PARALLEL_WRITE，不推进 B3.1/B2/B5/正式前端。完成估算信用保持56/100（展示55%，剩余约45%，区间40–60%）；存在部分实现不等于阶段完成。
- 上传目标 codex/b45-review-blocked，父 c83f6bc5067055f740e2847a74b036a13b430342；保存实现与独立 BLOCKED 事实，不并入main。准确上传结果/commit以本轮远程核对和会话交付为准；共享暂存区和 dirty 树保留，project-progress/ 全部不入Git。

B4.5 首轮独立复核：worker wrapper 正常 exit0，改动限3份生产接线/2份测试/runner登记；Codex未代写生产代码。独立 in-memory probe 通过真实runRoundCli/临时Git repo复现：最终review仍在用户原检出（reviewUsesGroup=false）；--cwd repo/nested 仍exit0而实际运行在worktree根，且worktree建在原repo内部（preservedSubdir=false）。因此暂不PASS；仅发放一次 bounded rework，修审核目标与子目录写前拒绝，并要求报告反映组工作区事实。

2026-10-14 B4.5：用户明确授权继续下一阶段。Codex 先核对 WorkspaceManager/ResourceClaim/mergeTaskBranch 及协作拒绝路径；GitHub MCP 本轮成功检索 openai/symphony（Apache-2.0、未归档），结合其 SPEC 的同一工作单元复用工作区与 Git 官方 worktree 文档，仅参考方法、不引入 Elixir/服务/依赖。选择协作组共用一个隔离 Git worktree、成员顺序执行的最小路线；用户原检出目录不作为写入目标，最终人工集成，PARALLEL_WRITE=CLOSED。当前为实施中，不是 PASS；其他阶段未授权。

2026-10-14 本机页面与上传维护（不推进阶段）：磁盘快照此前已是 B4.4，但实时预览服务未运行，先前仅核对数据不能证明用户看到的页面已同步。本轮恢复受控终端中的只读预览 http://127.0.0.1:4318，并实际打开浏览器核对 B4.4 done / B4.5 待授权。服务停止后自动刷新停止；离线文件须重新生成并重新加载。后台常驻启动被自动安全检查拒绝（blocked by policy），未绕过该拒绝。此前 GitHub 上传确实漏做；本轮核对相对 777702f 的 13 文件差异和已审核代码哈希。初次 Git TLS 握手及 GitHub MCP 连接失败，随后 Git 连接恢复，实际 push 成功：codex/b44-review-pass 的代码快照 b5137113041f5a290c05f84df23715fa81ceac50，远程 ls-remote 已确认。快照包含 B4.3a 收口、model-catalog smoke、B4.4 及审核文档；后续仅补此上传记录。不修改 main/共享暂存区，远程 main 仍为 8b8add4250d64d2c9c78fe47ded208e7bc285aaf，project-progress/ 全部不入 Git。

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
  "updatedAt": "2026-10-16T03:00:51.659Z",
  "title": "LAYA 个人工作台",
  "scope": "新草案对应的后端完整使用效果；不包含正式产品前端",
  "current": {
    "id": "MVP-E2E.1c",
    "name": "路径、任务职责与Checkpoint核对完成：FIX_REQUIRED",
    "status": "blocked",
    "summary": "第三次模型已真实写文件但自行增加demo/；实现自测不天然违规，handoff保留真实路径。生产timeout被归为source=user已定位；待限定来源修复，真实调用关闭。"
  },
  "next": {
    "id": "MVP-E2E.1c-FIX",
    "name": "待Owner授权：仅修Checkpoint超时/输入失败与真实人工决定的记录及摘要",
    "authorized": false
  },
  "parallelWrite": "CLOSED",
  "frontend": "本机进度页已授权；正式工作台前端待需求确认",
  "estimate": {
    "method": "按十项能力加权的工程判断；不是测试数、工时或代码统计。不得用任务数直接计算。",
    "remainingRange": [
      30,
      50
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
        "earned": 9,
        "basis": "目录、auto/fixed、用户声明允许池与实际pair准入已有；真实目录入调度、实际模型、角色默认和动态选择不足"
      },
      {
        "name": "功能 A/B 与项目计划",
        "weight": 18,
        "earned": 16,
        "basis": "B4.0–B4.5a受控顺序计划、协作组和Git交付闭环独立通过；更广使用方式和真实模型验收仍缺"
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
        "earned": 2,
        "basis": "同进程单步用户只读检查与继续/停止受控通过；完整监督、实际改任务纠偏和跨进程恢复不足"
      },
      {
        "name": "Skill/MCP 与按需上下文",
        "weight": 8,
        "earned": 4,
        "basis": "B3.1/B3.2用户声明候选、任务选择/brief/有来源事件观察受控通过；自动发现、真实工具调用、权限/定义裁剪/Token收益未验收"
      },
      {
        "name": "费用、额度与消耗覆盖",
        "weight": 5,
        "earned": 2,
        "basis": "B2.1/B2.1a显式无新增费用声明、来源/期限与最终启动拒绝受控通过；真实资格/共享额度/USD硬预算/内部费用未验收"
      },
      {
        "name": "中断接力与最小历史",
        "weight": 6,
        "earned": 3,
        "basis": "B5.1已知session_failure停止安全、具体pair/fresh session/部分成果接力受控通过；真实协议分类、全workflow及跨进程恢复未验收"
      },
      {
        "name": "代表性真实用户验收",
        "weight": 4,
        "earned": 2,
        "basis": "固定free duo两个真实模型/3会话样本及真实LAYA四项typed预设分别通过；尚未耦合完整round/工具与更广场景，不把usage当账单"
      }
    ]
  },
  "blockers": [
    {
      "id": "MVP-E2E1B-REGRESSION",
      "severity": "既有测试债务 / 本MVP有限豁免",
      "title": "26 pre-existing B5.1-WF failures remain open",
      "detail": "25项旧测试Provider给continue附加矛盾taskId，1项期待未提供的reassign；错误code/message/生产堆栈前后一致。原套件388/26不改报PASS。",
      "next": "仅本次fixed/sequential/no-handoff准入豁免；未来接力或重选需单独维护与验收。",
      "kind": "CONDITIONALLY ACCEPTED有限边界"
    },
    {
      "id": "MVP-E2E1-WORKER-DELIVERY",
      "severity": "真实验收缺口",
      "title": "第三次已真实写文件，但精确路径与完整闭环未验收",
      "detail": "当前固定模型NEW→write→test；实际在workspace/demo/写出两文件、2/0；计划要求根目录。第二任务未跑、accept0、Review0，不能完整PASS。",
      "next": "用既有stage/plans明确cwd根路径、自测范围与独立测试职责；先修checkpoint证据来源，不自动实跑。",
      "kind": "真实E2E仍PARTIAL"
    },
    {
      "id": "CHECKPOINT-TIMEOUT-SOURCE",
      "severity": "已定位生产缺陷 / 本次准入阻塞",
      "title": "timeout/input error被误记为用户主动stop",
      "detail": "reader超时抛错→record(stop)，source恒user；第三次同样无人工决定，却出现user-stop/用户停止摘要。安全停止成立，证据归属错误。",
      "next": "有限修复reader错误原因、CLI entry及摘要；离线证明timeout、user_stop、user_accept可区分，不改Verification/Human Gate。",
      "kind": "FIX_REQUIRED / 尚未修复"
    },
    {
      "id": "LAYA-ACTION-DOMAIN",
      "severity": "实测受阻",
      "title": "资格过滤后仍未观察真实目标完成",
      "detail": "QUALITY.2首例实际wait，输入465 tokens全量可见；安全弃权而非错误完成，不能认证完成能力或推断普遍准确率。第二例未运行。",
      "next": "人工accept兜底及最短使用链已收敛；真实LAYA自动质量缺口保留，不追加同类试跑。",
      "kind": "领域适配/正向验收缺口，不是新接线或containment故障"
    },
    {
      "id": "LAYA-INTEGRATED-ROUND",
      "severity": "证据缺口",
      "title": "真实LAYA四预设通过，完整round尚未耦合验收",
      "detail": "第三次实际LAYA分类/continue、POST2/3并启动固定Worker写文件；路径偏差且checkpoint超时，accept0/Review0，完整闭环未通过。",
      "next": "不重做LAYA预算；先完成本片已定位checkpoint归属最小修复。",
      "kind": "验收边界 / 四项接口缺口已关闭"
    },
    {
      "id": "LAYA-CALIBRATION",
      "severity": "P2",
      "title": "部分checkpoint置信度温度未校准",
      "detail": "0.3.21加载器对choice:11+温度0.10058钳到0.5并提示confidence未经校准；health warnings=[]不覆盖该stderr事实。",
      "next": "置信度只作提示，不作为硬门/可靠性保证；后续决策验收观察，不擅自调参或升级。",
      "kind": "已安装加载器警告 / 非本片阻断"
    },
    {
      "id": "MODEL-CALLABILITY",
      "severity": "真实使用边界",
      "title": "声明pair已注册，但不等于可调用/额度可用",
      "detail": "B2.2独立证明新pair进入候选链后保持unknown、Assignment拒绝；已有合法probed pair可继续执行。没有从名称、声明或Agent安装态伪造证据。",
      "next": "复用现有配置/真实probe/观察证据；后续真实pair验证须明确新费用/次数范围，不为跑通改成available。",
      "kind": "非P1 / 不放宽保护"
    },
    {
      "id": "B47-REPRESENTATIVE-SCOPE",
      "severity": "范围限制",
      "title": "真实固定free duo已过；LAYA/工具及完整使用效果未验",
      "detail": "本次新README与目录准备下两个真实模型交付/测试/集成均通过，无权限拒绝；这是非Git共享顺序demo、确定性协调与合成可用性/额度输入。真实LAYA/Skill-MCP/全费用/其他Agent不因此通过。累计会话5/5、剩0。",
      "next": "先确认剩余后端最小闭环与验收范围；任何新真实调用须明确次数/模型/费用，不自动进入正式前端。",
      "kind": "代表样本边界 / 无本次阻断P1"
    },
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
      "title": "Git协作的支持范围",
      "detail": "只支持仓库根目录启动、从committed base开始、组内单worktree顺序执行；未提交内容不自动带入，最终人工集成。",
      "next": "使用反馈后再扩展，不阻塞模型池/费用准备",
      "kind": "最小已验收"
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
      "title": "真实证据已扩展到固定OpenCode双模型；广度仍不足",
      "detail": "Space Bunny/MiMo固定pair的共享顺序demo已真实交付与集成，通过独立执行；其他Agent、真实LAYA自动选型与更广隔离/费用尚未验收。",
      "next": "B4.7后续范围确认",
      "kind": "部分真实验收"
    },
    {
      "id": "LOCAL-UI",
      "severity": "本机维护",
      "title": "旧临时页面待手动删除",
      "detail": "temporary-dashboard/ 的 20 个源码文件已压缩并逐字节验证；递归删除被工具安全策略拒绝，目录尚在。这不阻塞后端开发。",
      "next": "用户手动删除旧目录",
      "kind": "工具限制"
    },
    {
      "title": "原生工具真实验收与按需工具定义",
      "severity": "产品缺口",
      "detail": "Skill/MCP选择与请求/事件观察已有受控闭环；实际安装、MCP服务身份/连接/权限/调用、工具定义裁剪与Token收益仍缺。",
      "next": "模型/费用明确后按范围opt-in验收 / B4.7",
      "id": "native-mcp",
      "kind": "部分实现 / 待验证"
    },
    {
      "id": "actual-fee-boundary",
      "severity": "验收缺口",
      "title": "费用声明不等于账户真实免费或硬预算",
      "detail": "显式池的最终准入已受控通过；真实资格/共享余额、付费授权/USD硬预算、LAYA/审核/工具及原生辅助费用仍未完整覆盖。",
      "next": "真实模型验收前按用户账户/费用/数据授权补证；不建复杂计费平台",
      "kind": "部分实现 / 未验收"
    },
    {
      "id": "B51-WRAPPER",
      "severity": "P2",
      "title": "委派外层监测提前返回",
      "detail": "两次outer exec exit1，wrapperExit未知；原生会话正确模型且完成，返工持handle证exit0。原因未确定，未重复并发派工。",
      "next": "下一次相关委派定位监测问题，保留原生事实",
      "kind": "工具观察"
    },
    {
      "id": "B51-RECOVERY",
      "severity": "范围限制",
      "title": "有界接力不等于完整工作流恢复",
      "detail": "仅现有TRANSPORT_ERROR/session_failure受控通过；恢复任务to_verify，全workflow未完成；真实Agent协议和实际模型未知。",
      "next": "真实模型范围明确后B4.7补代表证据",
      "kind": "部分实现 / 未验证"
    },
    {
      "id": "B51-PROBE-OWNERSHIP",
      "severity": "P3",
      "title": "最初两个异常探针的临时路径未记录",
      "detail": "owner返回前TDZ抛错；不具备可靠定点清理路径，未扫描批删，不能称零残留。后续probe和harness已补异常清理。",
      "next": "保留观察，不影响生产正确性；不按前缀删除foreign目录",
      "kind": "独立探针卫生"
    },
    {
      "id": "B471B-PROBE-DIR",
      "severity": "P3",
      "title": "启动前失败探针目录待手动清理",
      "detail": "自有w44-eM6GD9无进程启动；其确切递归删除被自动审批blocked by policy拒绝，未绕过。",
      "next": "用户手动清理已记录目录；不阻塞路径修复或后端",
      "kind": "工具限制"
    },
    {
      "id": "WORKER-REPORT-P2",
      "severity": "P2",
      "title": "开发worker末尾工具拒绝导致报告未收尾",
      "detail": "两轮实际DeepSeek模型已核验、所需代码已落盘；尾部共享TEMP/原地mutation命令被拒绝，native finish=tool-calls，无完整最终报告。代码结论来自Codex独立diff/tests。",
      "next": "后续任务仅用任务owned日志或直接命令输出；不重试被拒绝写入，不再发第三轮、不扩建委派框架。",
      "kind": "委派报告局限 / 非生产功能阻断"
    },
    {
      "id": "B45-OLD-NEGATIVE-CONTROL",
      "severity": "P2",
      "title": "旧B45负控源码定位串已失效",
      "detail": "worker报告103/1；父def22fb的CLI已不含旧marker，原测试仍引用，当前CLI未改。不是本片回归。",
      "next": "另行限定测试维护任务修正定位/反证，不为求绿改变生产安全门。",
      "kind": "既有测试维护"
    },
    {
      "id": "LAYA-CONSERVATIVE-WINDOW-P2",
      "severity": "支持范围",
      "title": "多语言仍使用保守512拒绝线（容量文案已纠正）",
      "detail": "QUALITY.1已准确写明english512/192与multilingual1024/256，原文案P2关闭。统一512策略保持，可能拒绝多语言本可容纳的请求；不宣称任意服务配置被检测。",
      "next": "扩大预算需单独验证；当前保留更保守支持范围，不阻断候选资格修复。",
      "kind": "文案P2已关闭 / 有意的保守限制"
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
      "evidence": "历史受控封板；本轮未重跑b40a，不能作本轮结果"
    },
    {
      "id": "B4.1a",
      "title": "功能 B · 2–3 模型分工集成",
      "status": "done",
      "deliverable": "独立任务/会话，指定成员集成",
      "evidence": "历史受控封板；本轮独立96/0，非产品真实模型验收"
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
      "status": "done",
      "deliverable": "单组隔离worktree顺序共建与实际成果审核",
      "evidence": "与B4.5a一起独立PASS：真实Git/产物/脏文件保护/顺序写，限定root+committed base"
    },
    {
      "id": "B4.5a",
      "title": "审核前资源保护收口",
      "status": "done",
      "deliverable": "同组运行期声明仍保留时不审核、不成功交付",
      "evidence": "独立104/0 + 三故障probe + 两内存负控；审核与完成保护闭环"
    },
    {
      "id": "B3.1",
      "title": "任务级原生 Skill 最小闭环",
      "status": "done",
      "deliverable": "用户声明候选 → LAYA选择 → advisory brief → 工具事件观察（受控）",
      "evidence": "独立64/0 + ownership守卫 + 2内存负控；初次+唯一返工"
    },
    {
      "id": "B3.2",
      "title": "原生 MCP 选择与观察",
      "status": "done",
      "evidence": "独立119/0（含原64条）+ duo/碰撞/跨Agent probes + 2内存负控；首轮完成",
      "deliverable": "声明Server/Tool → advisory选择 → 名称匹配事件观察（受控）"
    },
    {
      "id": "B2.1",
      "title": "模型池与费用声明准入",
      "status": "done",
      "deliverable": "用户限定pair，未知/付费拒绝，声明有来源和期限",
      "evidence": "与B2.1a一起独立179/0；配对碰撞及最终启动检查P1已关闭，仅用户声明准入范围"
    },
    {
      "id": "B2.1a",
      "title": "最终同步启动检查收口",
      "deliverable": "prepare后再检查实际pair与声明有效期，拒绝时不启动/不泄漏claim",
      "status": "done",
      "evidence": "独立179/0 + 原阻塞probe runtime0 + 两内存负控；原155覆盖保留，首轮无需返工"
    },
    {
      "id": "B4.6",
      "title": "检查点监督与用户纠偏",
      "status": "planned",
      "deliverable": "异常阻止后续派工，用户决定纠偏",
      "evidence": "B4.6a最小用户检查点已交付；完整监督和实际纠偏恢复未验收"
    },
    {
      "id": "B5.1",
      "title": "模型掉线的有界接力",
      "status": "done",
      "deliverable": "保留部分成果，停旧执行后再接手",
      "evidence": "独立170/416+CLI原探针/6池接力/2负控/AST；只受控known session_failure，保留P2/P3"
    },
    {
      "id": "B4.7",
      "title": "真实 Agent 代表验收",
      "status": "partial",
      "deliverable": "成功、受阻与真实成本/停止证据",
      "evidence": "B4.7.3固定双模型代表样本真实PASS：3独立任务/会话、独立可执行产物与负控、Job空；LAYA/工具/更广场景未验收，累计5/5。"
    },
    {
      "id": "F0",
      "title": "正式工作台前端需求确认",
      "status": "planned",
      "deliverable": "确认流程后再设计正式 UI",
      "evidence": "当前进度页只是本机状态展示"
    },
    {
      "id": "B4.6a",
      "title": "同进程单步用户检查点",
      "deliverable": "显式任务结果检查与继续/停止；不做跨进程恢复",
      "status": "done",
      "evidence": "独立93/42及历史TTY证据；原Review文案P2在B5.1经两次真实CLI停止probe关闭"
    },
    {
      "id": "B2.2",
      "title": "显式模型池候选来源",
      "status": "done",
      "deliverable": "普通CLI使用冻结声明补现有registry；声明unknown不提升为可调用",
      "evidence": "33/0+9独立断言+双负控+异常/清理失败传播；委派末尾报告P2保留"
    },
    {
      "id": "LAYA-ENV.1",
      "title": "本机LAYA环境/缓存与离线加载",
      "status": "done",
      "deliverable": "复用既有venv恢复固定英语/多语言缓存并验证真实health",
      "evidence": "10/10摘要；实际CUDA两checkpoint；三Job空/清理；0推理"
    },
    {
      "id": "LAYA-DECISION.1",
      "title": "本地LAYA真实typed决策验收",
      "status": "blocked",
      "deliverable": "最多4次合成任务本地调用，不启动产品Agent",
      "evidence": "1/4请求后因action协议兼容失败停止；余3项NOT RUN；Job空、owned清理通过"
    },
    {
      "id": "LAYA-COMPAT.1",
      "title": "官方action元数据兼容与参数隔离",
      "status": "done",
      "deliverable": "最小客户端修复+hermetic回归",
      "evidence": "独立typecheck、429/0、37/0、169/0；捕获JSON修复前拒绝/后通过；无新增真实推理"
    },
    {
      "id": "LAYA-DECISION.2",
      "title": "四项真实本地LAYA typed决策验收",
      "status": "done",
      "deliverable": "中英文分类+二选一计划+二选一具体pair",
      "evidence": "实际4/4POST校验通过；multilingual/english实际routing；同服务health固定revision/cuda；Job空清理"
    },
    {
      "id": "LAYA-ROUND.1",
      "title": "完整round接线与调用预算只读审核",
      "status": "blocked",
      "deliverable": "定位真实动作参数缺口、预算及准入前提",
      "evidence": "官方0.3.21解码形状+真实provider/loop反例；现跑429/0、169/0、93/0；无模型调用"
    },
    {
      "id": "LAYA-ACTION.1",
      "title": "workflow完成动作与明确目标候选桥接",
      "status": "done",
      "deliverable": "同次候选表映射、拒绝路径与原生形状CLI回归",
      "evidence": "独立8项检查全绿、第一目标负控exit1/3失败；正常指定模型委派；无真实推理；保留既有P2"
    },
    {
      "id": "LAYA-ACTION.2",
      "title": "真实本地动作目标验收",
      "status": "blocked",
      "deliverable": "真实选择和应用、无交付保护、ready动作；最多3POST",
      "evidence": "3/3真实continue；协议/状态安全通过，完成目标NOT OBSERVED；双目标材料截断已离线复现；Job空/清理通过"
    },
    {
      "id": "LAYA-CONTEXT.1",
      "title": "决策输入压缩与动作前可见性保护",
      "status": "done",
      "deliverable": "保留同任务材料/拒绝不明与饱和native响应/旧入口兼容",
      "evidence": "独立8项全绿+8实际tokenizer回放+5continue探针+负控25失败；第二轮指定模型正常完成；无新增真实推理；P2容量注释保留"
    },
    {
      "id": "LAYA-ACTION.3",
      "title": "修复后真实本地动作验收",
      "status": "blocked",
      "deliverable": "最多3次真实选择+状态效果+输入可见性与Job停止",
      "evidence": "实际3/3 continue，494/278/276 tokens零state截断；complete0/状态不变；Job空清理通过；累计本地11/产品5"
    },
    {
      "id": "LAYA-QUALITY.1",
      "title": "按现有ready事实过滤模型可见动作",
      "status": "done",
      "deliverable": "无ready不提供continue；wait/abort/明确目标及既有保护保持",
      "evidence": "独立8项exit0，state-loop276/0、CLI98/0；3历史回放、负控12失败；原生evals validate12条仅格式；无新增推理"
    },
    {
      "id": "WORKFLOW-RESEARCH.1",
      "title": "先调研再动手的个人Skill",
      "status": "done",
      "deliverable": "原生Skill+全局规则+项目研究前置；无新框架",
      "evidence": "官方在线资料与GitHub MCP核对；quick_validate通过、metadata校验、既有路由不变；未实测未来新会话自动匹配"
    },
    {
      "id": "LAYA-QUALITY.2",
      "title": "最小真实资格过滤验收",
      "status": "blocked",
      "deliverable": "固定正确/矛盾材料，真实目标与安全拒绝分别验证",
      "evidence": "真实1POST选择wait，465 tokens零截断，complete0/任务不变；第二例NOT RUN；Job空/清理，累计本地12/产品5"
    },
    {
      "id": "LAYA-BOUNDARY.1",
      "title": "收敛LAYA/Verification/Review/HumanGate职责",
      "status": "done",
      "deliverable": "真实调用链、缺口与3文件内的最小显式人工验收建议",
      "evidence": "受控捕获wait回放/可信状态入口/当前accept无效；42/169/346/130/419均0失败；无新模型调用"
    },
    {
      "id": "B4.6b",
      "title": "显式人工验收检查点",
      "status": "done",
      "deliverable": "同Attempt用户accept→同步复查→既有Verification，末步无额外模型决策",
      "evidence": "typecheck: typecheck PASS；b46-workflow-checkpoint: 49 passed, 0 failed；b40a-cli-workflow: 159 passed, 0 failed；state-loop: 276 passed, 0 failed；round-result: 346 passed, 0 failed；workbench: 419 passed, 0 failed；b41-collab-group: 96 passed, 0 failed；b43-stage-material: 47 passed, 0 failed；b14-selection: 179 passed, 0 failed；b22-model-pool-candidates: 33 passed, 0 failed；内存负控非零、模型/session证据与scope独立核对；非真实LAYA自动质量验收"
    },
    {
      "id": "MVP-READINESS.1",
      "title": "最短个人使用链与阻塞收敛",
      "status": "done",
      "deliverable": "README示例/预检/受限执行模板；LAYA/quota/Review/新调用授权分别说明",
      "evidence": "真实CLI 3例0/2/2，child/fetch/task/transcript均0；6状态门纯值核对；直连health超时；源码未变、无推理"
    },
    {
      "id": "LAYA-HEALTH.1",
      "title": "无推理健康定位与owned恢复",
      "status": "done",
      "deliverable": "现有离线固定缓存/生产provider/Job启动-健康-停止路径",
      "evidence": "OS无listener/Node ECONNREFUSED；一次双checkpoint实际CUDA health ok；Job Active0/owned删除/cleanup0；缓存10和版本文件209不变，推理0"
    },
    {
      "id": "MVP-E2E.1",
      "title": "一次真实最短闭环验收",
      "status": "blocked",
      "deliverable": "固定Worker、用户两次accept、原生Review与HumanGate",
      "evidence": "三次真实PARTIAL；第三次POST2、Worker1、NEW→write→test2/0但路径加demo/；accept0/Review0，Job空/清理通过，调用关闭。"
    },
    {
      "id": "MVP-E2E.1a",
      "title": "LAYA POST发送前Round硬预算",
      "status": "done",
      "deliverable": "--laya-post-max；累计共享预留/无退款/机器报告/预算耗尽安全停止",
      "evidence": "Codex typecheck exit0；预算125/0、CLI182/0、decision429/0、selection179/0、state-loop276/0、round-result346/0；负控94/31 exit1预期；真实loopback超时与UTF8/421/重定向；固定pair中途耗尽附加探针185/0；产品真实推理0。"
    },
    {
      "id": "MVP-E2E.1b",
      "title": "Worker-local Recon范围与交付指令收口",
      "status": "done",
      "deliverable": "Recon指令离线通过；26项历史失败经根因及共享路径取证后有限准入，整体handoff不封板",
      "evidence": "当前388/26与旧386/26名称/错误原因/主堆栈一致；96/0、CLI182/0、lifecycle136/0、resource192/0；精确固定两步无接力受控成功与停止未知负例通过；真实调用0。"
    },
    {
      "id": "MVP-E2E.1c",
      "title": "路径、职责与Checkpoint核对",
      "status": "blocked",
      "deliverable": "离线核对完成；FIX_REQUIRED，待授权最小checkpoint归属修复",
      "evidence": "原生正文/目录/工具/磁盘三方一致；真实RunResult handoff保留两路径；49/0、CLI182/0；超时system事实却source=user，未修生产。"
    }
  ],
  "checks": [
    "MVP-E2E.1c FIX_REQUIRED：只完成离线调查和最小方案，无开发委派/真实推理/第四次Round",
    "第三次原生cwd正确；Worker自行加入demo/；实现自测不是天然职责缺陷，计划需明确路径和独立测试",
    "真实RunResult→handoff保留实际写入绝对路径；第二真实Worker尚未消费，不伪造成功",
    "本轮checkpoint49/0、CLI182/0；内存短timeout/argv重建/实际handoff核对通过，既有套件不覆盖错误source归属",
    "26项既有失败豁免保留；HEAD/index/audit和生产测试字节保留，工程估算68/100不增加"
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
    },
    {
      "title": "现有LAYA接口与运行边界",
      "path": "docs/DECISION_PROVIDER.md"
    }
  ]
}
```
<!-- project-progress:end -->
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
