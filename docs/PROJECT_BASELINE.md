# 项目基线 — 唯一当前事实入口

更新：2026-10-16。本次为 DOC-SUPERVISION.1 产品默认监督/机器完成契约文档更新，不是实现验收或真实调用授权。

## 1. 权责与当前结论

本文唯一维护当前事实、阶段状态、证据与进度快照。[产品方向](PRODUCT_DIRECTION.md)管已确认定位/取舍；[后端需求](BACKEND_REQUIREMENTS.md)保留全部目标；[路线](BACKEND_DELIVERY_PLAN.md)管顺序；[阶段分析](STAGE_ANALYSIS.md)解释新策略；[NEXT_TASK](NEXT_TASK.md)只列下一有界任务；[研究索引](ENGINEERING_RESEARCH_REFERENCES.md)管来源，不各自宣布封板。

**当前真实MVP为PARTIAL，MVP-E2E.1c为FIX_REQUIRED。** 检查点归属与确定性交付检查尚未修复；新策略方向已获Owner批准，但本轮只整理文档。唯一下一项P0-1确定性完成门禁等待下发实施；旧MVP-E2E.1d合并任务已被依赖顺序替代。产品LAYA POST、Worker、Native Review和开发委派均未在本轮启动，旧剩余额度不继承。

OpenCode主要开发、Codex独立审核；本轮文档由Codex整理，不代写生产实现。LAYA仍为任务级选择权威，TaskStore仍为任务状态权威。正式Windows桌面路线保持，具体UI需求/实现未开始。PARALLEL_WRITE=CLOSED、automaticPostRoundAction=NONE。

project-progress/audit/是Owner指定只读旁路观察：每次开工读取，不修改/上传，不强制采纳，不能替代原始事件或本次独立验证。当前文档不再次核验其全部历史结论。

## 2. 阶段状态（继承既有裁定，本轮不重新封板）

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
| B4.2 / B4.2a | 独立 PASS WITH P2（历史裁定）；项目计划与多入口顺序执行受控闭环，等待/拒绝分类P2已在B4.3关闭 |
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

表中受控PASS只适用原范围，整体B1–B5未完成。B4.7.3有真实双模型代表样本，不等于全自动LAYA+原生Review闭环；不能把“兼容性尚未全面验收”误读为从未运行任何真实模型。详尽历史与逐项来源保存在下述归档。

## 3. 现在实际有哪些能力

| 能力 | 已验证范围 | 不得提升成的结论 |
|---|---|---|
| 原生执行底座 | Assignment/Lease、Scheduler、Session/Attempt、Workspace/ResourceClaim、Windows Job containment；停止未知不提前释放 | root退出不是树停止；本轮未重跑物理测试 |
| 模型目录 | opt-in doctor --models opencode，contained ManagedProcess；历史1.18.35目录42项；默认doctor不查询 | listed ≠ connected ≠ callable ≠ free，不把旧数量/价格当当前资格 |
| 选择 | auto/fixed，task>project>auto；完整pair固定，动态后代约束；不可用拒绝不换模 | 角色默认/prefer/运行中改选尚未完整实现；fixed不构成支付授权 |
| 两层工作流 | 跨角色顺序任务，同目标duo/trio独立child/session，指定成员集成；自定义JSON计划、stage冻结/绑定digest、材料完整嵌入 | 不新建DAG；不开放并行写；fileScope是声明，不是沙箱或产物核验 |
| Git协作 | B4.5/B4.5a单组committed-base隔离worktree顺序集成与审核保护的受控范围 | 不是任意Git拓扑、并发写或恢复已验证 |
| Skill/MCP | 用户声明目录、LAYA任务级选择、intent/brief、工具名称观察的受控最小范围 | 非自动发现/强制工具集/真实加载成功或Token收益证明 |
| 费用池 | 用户声明带来源/期限、候选/分配/最终启动前准入；新pair保持unknown | 非真实账户资格、动态额度、原生辅助调用或金额硬预算 |
| DSH | 历史0.1.5-rc.2协议与受控raw stdout保真；modelSelection=false、resume不支持、shared-only | 不能将DSH桌面模型菜单当逐请求选模型或真实会话验证 |
| 接力 | 已知session_failure、同Attempt停止证据、fresh session与有界pair迁移的受控子集 | 26项WF失败仍open；无完整跨进程恢复/副作用重放保证 |
| Review/Human Gate | 原生独立Review入口已有，结果verdict与最终动作NONE分开；手动accept走既有Verification | HumanGate结果投影不是Owner亲自输入；Runtime成功不等于质量验收 |

任务编排生产Execution Edge维持既有单一runtime.run路径，当前未改代码；诊断沿已有ManagedProcess。内存TaskStore与磁盘执行记录不等于可跨进程恢复。

## 4. 关键真实证据与未完成项

### 4.1 第三次 MVP-E2E.1（PARTIAL）

- 只读证据：D:/workbench-demo/third-20261016T024431Z/evidence/，包括final-review.json及原生session导出；workspace为同级workspace/。
- Worker实际OpenCode1.18.35，模型opencode/space-bunny-free；native session ses_ebd649512ffeDDSKXahvJ0ezII；Task round-mvad9pwl-w1 / Attempt att_0001 / Session ws_0001。
- LAYA真实POST2/3：分类implementation、动作continue。Worker1/2，Reviewer0/1。NEW→write→test已发生，实际文件workspace/demo/add.js、demo/add.test.js，测试2 passed/0 failed。
- 用户要求/最终任务正文仍为cwd根目录add.js；实际write参数自行加入demo/。cwd正确；不能用离线重建argv冒充历史OS argv全量捕获。实现Worker自测或写测试不是天然职责错误，Demo应明确独立测试任务。
- Owner只确认ready，真实accept0、本人stop0；60秒系统timeout被误记source=user/user-stop。第二Worker与Native Review没有运行，Human Gate not_ready，自动动作none。
- native cost记录0、无可观察retry parts；不因此断言内部HTTP重试绝对0。owned Job ActiveProcessesFinal=0、cleanupFailures=0。前三次结果均不是完整闭环PASS。

### 4.2 MVP-E2E.1a 与 Recon 的有限证据

POST硬限已独立通过：--laya-post-max N显式启用，0拒绝POST，不传保持旧行为；同Round共享同步发送前预留、失败/超时/取消不退款，并发不超额，421不重放、307/308不跟随。JSON记录used与耗尽。统计是请求尝试，不是实际费用、Token或原生会话数。历史离线结果：预算125/0、CLI182/0、decision429/0、selection179/0、state-loop276/0、round-result346/0；本次文档未重跑。

Recon修复已CONDITIONALLY ACCEPTED；旧386/26与新388/26失败签名、原因、主堆栈已有限复核，Worker指令/argv96/0、CLI182/0、Contract248/0(2skipped)、typecheck PASS为历史证据。**26 pre-existing B5.1-WF failures remain open**。豁免只限固定pair/顺序/无接力最小MVP，不等于整个handoff通过。第三次真实写入证明NEW可工作，不证明Recon是此前唯一根因。

### 4.3 其他代表性证据

B4.7.3：Space Bunny Free+MiMo V2.6 Flash Free，三个真实独立任务/会话，顺序开发/测试/集成的代表样本；project-progress/b473-review-state.json、b473-native-model-evidence.json、b473-independent-review.json。此轮使用确定性协调及合成availability/quota，不是LAYA真实整轮或Codex Native Review已认证。旧会话上限已用完，不能自动再用。

LAYA：既有Python环境0.3.21，缓存D:/AI/laya-cache，固定权重revision55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851。历史离线CUDA加载和GET health通过；typed分类中英/计划/pair小样本通过。next_action的正向质量验收曾多次continue或wait，不能改成complete；置信度裁剪等原有限制不因文档更新消失。默认不常驻，不升级/下载/切权重。

## 5. Owner新裁定与现有代码的差距

Owner批准日期：2026-10-16。**Owner approved / Not yet implemented / Not yet tested**。正式未来默认覆盖旧“仅显式实验”建议，未改变当前生产或历史报告。

| 项目 | 已批准方向 | 当前实现事实 |
|---|---|---|
| 监督策略 | 产品默认Round-level Preauthorization + Exception-driven Human Intervention；整轮绑定计划/范围/pair或池/费用/工具，正常中间任务机器验收后自动流转 | 现有--checkpoint仍每步输入，默认60秒；timeout/EOF/error统记user-stop缺陷未修 |
| 质量验收 | 编码/文件交付必须精确expectedArtifacts、考虑原dirty/Windows重解析点的allowedScope、批准命令的真实test exit0；异步检查后完成提交复查身份/证据 | completeTask仍把调用者判断传为pass；未结构化校验expectedArtifacts/allowedScope/实际test exit |
| 候选生成 | 现有Agent生成2–3个JSON，再LAYA选 | 当前支持用户/内置候选；自然语言自动填计划尚未接入 |
| 资源工具 | 角色标签预过滤已有候选，再LAYA选择并原生加载 | 目录/intent已有最小接口，角色过滤与真实加载闭环未完成 |
| 产品界面 | 保持Windows正式桌面路线 | 本机ignored只读进度页不等于正式UI，具体UI需求待用户确认 |

共享最小修改接点：workflow-checkpoint.ts:103/191/214；round-cli.ts:2686/2734/2846；plan-file.ts:66/169/284；workbench.completeTask:1436→applyVerification:1445；currentActualOf:2358；最终Review调用round-cli:4047→unified-review:566。行号只用于本次映射，实施前重新定位。细化任务见NEXT_TASK，不在本轮开发。P0-1还须覆盖review-loop.ts:281等可达applyVerification pass入口；CLI侧验证不能替代共享完成约束。

整轮预授权不能代替最终Owner决定；正常Task1→Task2未来无需人工accept，自动验证记system而非伪造user_accept；异常必须停。确定性核验失败不得触发后续任务或Native Review成功；通过后仍须真实独立Review合法verdict。路径检查不是替代OS权限，write事件不是完整Diff，测试摘要不是实际退出码。

### 5.1 新语义与持久化缺口（未实施）

目标语义：user_accept/user_stop只记真实Owner输入；system_timeout/input_disconnected/verification_failed记系统事实；pending_user是活动资源已确认安全停止后的待人工结果投影，不新增第二Task状态权威。旧--checkpoint保留严格监督/调试；默认不再因60秒未答遗失待办，但当前代码仍按旧逻辑结束后续。不是删除Worker/Reviewer/LAYA执行deadline、POST/费用预算或停止保护。

源码复核：store.ts:11/119与attempt-store.ts头部声明内存存储；已有磁盘session/transcript/round-result不足以恢复权威Round。P0-3先保存待人工材料/引用并标明不支持跨进程恢复；真正恢复还缺Task/Attempt/授权关联恢复、工作区/预算/停止重验及防重复派发。不能把取消计时器说成次日恢复。

stageBindingDigest现绑定材料、objective、workflow、planRef/planScope；模型/pool、费用、工具和新增验收字段尚未完整绑定。P0-1随新增计划字段补当前内容绑定，P0-2再完善整轮授权，不建第二授权/工作流平台。原生ToolCall.exitCode可缺失且工具历史有上限；不能把现有字段存在当可信测试已认证。

新默认不改写第三次PARTIAL、accept0/stop0、Review0和历史source=user误记事实；26项B5.1-WF有限准入仍只适用原固定/顺序/无接力边界。

## 6. 唯一下一步与授权

**P0-1：确定性完成门禁，等待Owner下发实施。** 门禁独立通过后再P0-2授权范围内默认自动推进，再P0-3异常等待/最终交付，最后P0-4另行授权的真实闭环；不能在P0-1先开放新默认。 不自动委派，不自动第四次E2E，不修改模型或重新审计B1–B5。后续真实运行重新确认模型/免费或订阅资格、会话/POST/timeout/数据范围；free名称和pool声明不是当前账户事实。生产修改、开发委派、真实产品推理、正式前端本轮均未授权。P1自然语言计划、P2模型/Skill/MCP配置、P3正式桌面UI顺序保持。

## 7. 文档更新与历史

上轮DOC-ROUTE.1已独立同步至codex/product-route-docs-20261016，commite8290d13a3f3f3f039e57e6d4762c23988da2700。更早13份文档的完整字节（含dirty/untracked）在归档分支codex/docs-before-renewal-20261016，commit3f2b8a8d95374f60adbf666364f7b2180cdd84dd；[历史文档](https://github.com/yunxibaili/D-Native-Multi-Agent-Orchestrator/tree/3f2b8a8d95374f60adbf666364f7b2180cdd84dd/docs)只供追溯，不是当前事实。原三份旧规划/提示词在上轮移除。

本轮Owner明确要求重新建立STAGE_ANALYSIS，故同名文件仅保存当前P0依赖/监督语义理由，不恢复旧逐轮历史、不另立状态权威。更新需求§20、产品方向、P0-1→4路线、唯一P0-1任务和README。原20项研究保留，新增本次Owner给出的Agentless/A2A/OpenAI Agents SDK为#21–23，标明一手来源、版本、机制与项目推导。官方SDK资料本轮GitHub MCP读取成功，不引入SDK。

本轮Git以已核对的e8290d1为父提交，在同一文档审核分支追加新提交，不改写远端历史、不合并main；只收允许的需求/计划文档。主HEAD/index、源码/测试及其他原dirty内容保留，授权文档更新；临时独立索引在仓库外并须清理。准确新SHA、远端与清理检查见本轮交付报告。

本次只做源码/一手资料映射、文档一致性/链接/范围、diff --check、远端SHA与进度快照核验。**没有运行测试或任何模型，没有实现P0-1，没有第四次E2E，没有组件升级或新阶段封板。** 审核分支只同步文档，不能当全部dirty源码已经上传。

## 8. 规划估算与本机快照

沿用历史十项权重信用68/100（固定分母为完整后端需求，不含正式UI）；页面按5%档显示约70%、剩30%，旧合理剩余区间30–50%。这不是工时、可用率、自动化完成率或MVP成功概率。本轮文档不增分；下一真实E2E仍未成功，必须看具体阻塞和证据，不能用百分比代替它。

<!-- project-progress:begin -->
```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-10-16T06:49:27.007Z",
  "title": "LAYA 个人工作台",
  "scope": "原后端完整需求十项能力权重；不含正式桌面UI。68/100为历史规划信用，非真实MVP通过率",
  "current": {
    "id": "DOC-SUPERVISION.1",
    "name": "默认监督与机器完成契约更新",
    "status": "done",
    "summary": "Owner approved / Not yet implemented / Not yet tested。P0-1→P0-2→P0-3→P0-4已重排；唯一下一项P0-1待下发，第三次MVP仍PARTIAL，真实调用关闭。"
  },
  "next": {
    "id": "P0-1",
    "name": "确定性完成门禁最小切片",
    "authorized": false
  },
  "parallelWrite": "CLOSED",
  "frontend": "本机进度页已授权；正式工作台前端待需求确认",
  "estimate": {
    "method": "沿用历史十项能力权重，不按文档量或测试数增分；不是工时/可用率或真实闭环成功率。",
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
      "severity": "P1",
      "kind": "首要完成门槛",
      "title": "三类确定性门禁未实现",
      "detail": "缺精确产物/dirty增量范围/可信测试执行统一核验；当前completeTask仍传调用者pass。",
      "next": "仅实施P0-1；先门禁，不提前开放新默认流转。"
    },
    {
      "severity": "P1",
      "kind": "后续依赖",
      "title": "预授权绑定、异常等待与真实闭环尚未完成",
      "detail": "现有digest未全面绑定模型/费用/工具；系统超时仍误记user。默认自动流转须P0-1通过后分片实施，Task/Attempt内存不等于可恢复。",
      "next": "依次P0-2、P0-3通过，再另行授权P0-4真实E2E。"
    },
    {
      "severity": "P2",
      "kind": "历史风险保留",
      "title": "26项B5.1-WF失败仍open",
      "detail": "固定pair/顺序/无接力有限准入不扩大；历史PARTIAL和未完成Review不追认。",
      "next": "新切片触及共享路径时有限复核，不修无关债务求全绿。"
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
    },
    {
      "id": "DOC-ROUTE.1",
      "title": "定位/路线/20项研究与历史文档归档",
      "status": "done",
      "deliverable": "保留全部需求、桌面路线和有效技术契约；当前文档归一，独立审核分支同步",
      "evidence": "本次仅文档核对；旧文档完整含dirty版本归档commit3f2b8a8；不宣称后端新增能力或真实MVP通过。"
    },
    {
      "id": "DOC-SUPERVISION.1",
      "title": "正式默认监督/确定性完成契约与路线",
      "status": "done",
      "deliverable": "需求§20、P0依赖、唯一下一任务、当前阶段分析和资料追加",
      "evidence": "本轮只读源码/官方资料与文档检查；未实现或测试，历史68/100不变。"
    },
    {
      "id": "P0-1",
      "title": "确定性完成门禁",
      "status": "next",
      "deliverable": "Expected Artifacts + Allowed Scope + Trusted Test Execution→统一Verification",
      "evidence": "Owner approved / Not yet implemented / Not yet tested；待单独下发实施。"
    },
    {
      "id": "P0-2",
      "title": "授权范围内默认自动推进",
      "status": "planned",
      "deliverable": "整轮绑定计划/范围/模型/费用/工具，机器验证后Task1→2",
      "evidence": "依赖P0-1通过；不得伪造accept，不重复已成功Worker。"
    },
    {
      "id": "P0-3",
      "title": "异常等待与最终Human Gate",
      "status": "planned",
      "deliverable": "用户/系统来源区分，安全资源释放，pending结果与恢复限制",
      "evidence": "依赖前两片；当前内存状态不支持安全隔天恢复。"
    },
    {
      "id": "P0-4",
      "title": "新授权真实闭环",
      "status": "planned",
      "deliverable": "Owner预授权→真实实现/独立测试→机器门→Native Review→Human Gate",
      "evidence": "依赖前三片独立通过，模型/费用/次数/数据仍需新授权。"
    }
  ],
  "checks": [
    {
      "name": "Owner产品契约",
      "source": "2026-10-16新授权",
      "result": "Owner approved / Not yet implemented / Not yet tested"
    },
    {
      "name": "最近真实MVP",
      "source": "第三次历史Round原证据",
      "result": "PARTIAL不变，非本轮实跑"
    },
    {
      "name": "唯一下一实施任务",
      "source": "docs/NEXT_TASK.md",
      "result": "P0-1，未启动开发"
    },
    {
      "name": "状态与恢复",
      "source": "TaskStore/AttemptStore当前源码",
      "result": "内存；pending保存不等于可恢复"
    },
    {
      "name": "历史风险",
      "source": "26项既有B5.1-WF有限准入",
      "result": "open，不扩大豁免"
    }
  ],
  "sources": [
    {
      "title": "唯一当前事实",
      "path": "docs/PROJECT_BASELINE.md"
    },
    {
      "title": "默认产品契约",
      "path": "docs/BACKEND_REQUIREMENTS.md §20"
    },
    {
      "title": "P0依赖路线",
      "path": "docs/BACKEND_DELIVERY_PLAN.md"
    },
    {
      "title": "监督/恢复分析",
      "path": "docs/STAGE_ANALYSIS.md"
    },
    {
      "title": "唯一下一任务",
      "path": "docs/NEXT_TASK.md"
    },
    {
      "title": "原20+新增3项一手研究",
      "path": "docs/ENGINEERING_RESEARCH_REFERENCES.md"
    }
  ],
  "nativeFrontendRoute": "Windows正式桌面工作台；具体UI需求待单独确认，本机进度页不等于产品前端"
}
```
<!-- project-progress:end -->
