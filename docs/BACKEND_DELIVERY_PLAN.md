# 后端交付路线 — 机器完成门禁优先

更新：2026-10-21。原路线批准日期：2026-10-16。P0-1/2/3已取得有界离线验收；P0-4完整真实闭环仍未通过。以下保留原依赖顺序，具体事实只见[唯一基线](PROJECT_BASELINE.md)，需求见[BACKEND_REQUIREMENTS](BACKEND_REQUIREMENTS.md)，唯一下一项见[NEXT_TASK](NEXT_TASK.md)。本文不授权新开发或真实调用。

## 1. 正式默认产品契约

默认采用 **Round-level Preauthorization + Exception-driven Human Intervention**：
Owner开始前批准绑定的短计划、文件范围、具体Agent×Model或合格候选池、费用上限和工具权限；
每个任务通过确定性门禁后，原范围内自动进入下一任务；正常Task1→Task2不再要求人工accept。
异常停止并交人工；所有任务完成后真实Codex Native Review，再最终Human Gate，由Owner决定。
自动推进记录为预授权策略下的系统验证结果，不伪造user_accept。旧--checkpoint保留严格监督/调试用途。

这是已批准的产品方向；当前代码在确认stage且未指定--checkpoint时进入机器自动模式，无stage时保留旧入口。P0-1/2/3的有界离线范围已通过，完整真实验收另列，不把当前实现描述成“尚未改变”，也不将其扩展为所有入口无条件自动。

## 2. P0实施顺序与准入

| 顺序 | 有界交付 | 依赖 | 最小验收及停止条件 |
|---|---|---|---|
| **P0-1：确定性完成门禁** | PlanFile交付路径/允许范围/可信测试要求；实际Workspace与同Attempt证据；completeTask/applyVerification统一约束 | 已有界独立PASS（基线§7.10） | 精确路径、真实增删改归属、真实测试exit0；缺失/过期/错误Attempt/停止未知/越界均拒绝完成和下游；有效任务可完成；不等于完整E2E |
| **P0-2：授权范围内自动推进** | 复用stage/冻结计划，绑定模型/候选池、费用、工具及P0-1要求；机器通过后推进 | P0-1独立通过 | 开始前真实Owner批准；Task1→Task2无需人工accept；任何边界变化立即停；旧checkpoint可用、不重跑成功Worker，不新增执行边 |
| **P0-3：异常等待与最终Human Gate** | 区分系统/用户来源；安全释放活动执行资源、保存待人工材料；原生Review后交付 | P0-1、P0-2通过；可提前设计事件字段但不提前开默认 | timeout/断线不是user_stop；默认不因60秒未答而丢失待办；验证Job停止/费用deadline继续有效；保存pending结果不等于跨进程恢复；最终动作NONE |
| **P0-4：一次新的真实闭环** | Owner预授权→LAYA决策→Worker1实现→机器验证→Worker2独立测试→机器验证→Codex Native Review→Human Gate | 前三项独立通过，且Owner**另行授权**本次模型、次数、费用、数据和时限 | 固定/候选约束、实际模型/任务/Attempt/Session对应，真实代码/测试/Review verdict、最终交付和Job空；异常即停，无额外Round或付费补救 |

旧MVP-E2E.1d“两项一起修”的建议已被此依赖顺序取代。P0-2已有限离线PASS（§7.41），P0-3已有限离线PASS（§7.49）；§7.85真实独立Reviewer pass与P0-4整轮验收分开记录。P0-4.23启动受阻时可按Owner本次指示做独立离线准备，不自动执行下一阶段或复用过期真实调用授权。

## 3. P0-1的完成必要条件

| 门禁 | 必须证明 | 禁止替代 |
|---|---|---|
| Expected Artifacts | 文件在确认的实际Workspace根内、精确相对路径存在；同名不同目录不通过 | demo/add.js代根add.js、自动搬移、仅有声明/工具事件 |
| Allowed Scope | 任务开始前基线与结束后真实新增/修改/删除可归属；包括已有dirty/untracked、shell写入，处理Windows大小写/链接/Junction | 普通git status、只对HEAD比较、只看Agent write事件、字符串前缀判断 |
| Trusted Test Execution | 已批准的准确命令、实际cwd、执行来源、结束原因和真实退出码0，关联当前Attempt/产物版本 | Agent说PASS、输出含PASS、总session exit0、旧测试或被截断/缺失的记录 |

编码/文件交付任务缺可信测试或缺任一必要证据，不能自动通过。其他任务必须显式定义适用的验收契约，不通过“测试可选”暗放编码任务。
实现Worker允许必要自测；第二个Test Worker独立读取实际成果、运行并补充测试，不能复述前序结果。三门是必要条件，非代码质量充分证明；最终Review仍必要。

范围核验复用现有Workspace/ResourceClaim；用任务前后文件事实，不把历史dirty都算本任务，也不忽略本任务对原dirty文件的新改动。保留原内容，不自动清理或回滚。
链接或Junction越界、物理根不明、外部并发写入使归属不明时失败关闭。前后清单只能证明观察区间净变化，不证明没有瞬时外写；仍需原生权限，不能宣称新沙箱或扫描全磁盘。

## 4. 源码接点与安全边界

| 2026-10-16初次定位入口（历史行号） | 当时提出的接线 | 当时缺口（不代表当前未实现） |
|---|---|---|
| plan-file.ts:66/169/284；round-cli.normalizedPlanScope；stage-material.stageBindingDigest | 在既有JSON增加必要交付/范围/测试字段，传播到Task/brief与同一计划绑定 | 当前仅fileScope/deliverable声明，没有三门 |
| workspace.ts:96/432，既有dispatch/executeTask | 以实际WorkspaceHandle.cwd采集每次执行前基线/执行后证据 | 当前没有完整dirty增量归属/重解析点核验；Node/Win32资料仅方法，不是实现证明 |
| workbench.completeTask:1436→applyVerification:1445；orchestration/orchestrator.ts:786 | 异步检查可预先做，最终提交同步重读Task/Attempt/RunResult/工作区、授权及证据版本；所有可达pass入口服从同一约束 | review-loop.ts:281也调applyVerification，不能只在CLI加检查 |
| opencode.toolFromPart:418/427；AgentSession.noteToolCall:641；RunResult.toolCalls | 复用原生事件和同Attempt记录，核验准确测试命令/cwd/exit来源 | 当前exit可能null，toolCalls有上限；不匹配/缺证拒绝，不能把模型文字提升为可信事实；若现有事件不足需最小可信执行接线，不另造测试引擎 |
| round-cli.currentActualOf:2358；runOneCycle/complete分支；runUnifiedReview:4047 | 机器结果经同一Verification；缺证不能靠LAYA complete或手动accept绕过 | P0-1先门禁，P0-2后默认流转；Review保留独立会话和verdict |
| workflow-checkpoint.ts:103/191/214；round-cli:2734/2746 | P0-3类型化原因、系统/用户来源及pending投影 | 当前仍60秒异常→stop/source=user；不将target语义直接加成第二TaskState |

上表保留初次路线的映射历史，相关P0门禁/自动推进/来源修复已按基线有界验收，不能再将表中“当前没有”解读为今日状态。当前统一完成入口为orchestration/orchestrator.ts的applyVerification（约897行），stage自动模式在round-cli.ts约1473行；进一步实施前仍须重定位。TaskStore/Assignment/Scheduler.tick/Orchestrator/AttemptStore/SessionRegistry/Job/Human Gate不新建替代。
LAYA保留合法任务决策，但不能越过门禁；不把wait改complete。停止未知不释放保护，不放宽Worker/Reviewer/LAYA执行deadline或费用预算，PARALLEL_WRITE=CLOSED。

## 5. P0-3恢复边界

当前TaskStore、AttemptStore为内存对象；磁盘session/transcript/round-result不是可恢复的权威编排快照。
最小P0-3可保存待人工决定的结果、原因、身份/授权引用及成果位置，释放已确认停止的活动资源，并明确resumeSupported=false（具体字段复用既有报告）。
若进程退出，不声称次日能原地继续；需要恢复时，最小缺口是可信恢复Task/Attempt/授权关联、重新核验工作区和费用/停止事实，以及防重复派发。
本轮不实施该恢复能力，不建设通用跨进程恢复引擎。停止未确认时不能宣称已安全进入pending_user或释放保护。

## 6. P0之后的顺序保持

| 级别 | 后续目标 | 复用方式 |
|---|---|---|
| P1 | 自然语言需求生成2–3个候选短计划 | 独立准备步骤调用已适配Agent→parsePlanFile→草案/人工核对→既有stage冻结候选与digest→Round内plan-choice/LAYA选择；生成调用另计授权，不让stage-check暗中推理 |
| P2 | 模型与Skill/MCP配置、角色标签预过滤 | 现有Registry、用户费用池、Skill/MCP目录/intent和原生加载；不建models.yaml/第二网关；列出不等于可调用/免费 |
| P3 | 正式Windows桌面UI | 桌面路线保持，先与Owner单独确认前端需求；本机ignored进度页不是产品UI |

原需求中的功能A/B、多会话、免费优先、动态额度、模型掉线接力、长材料、用户纠偏/恢复全部保留，按使用反馈小片补齐。26项B5.1-WF既有失败及固定pair/顺序/无接力有限准入不因新契约消失；新代码触及其共享路径时重新评估相关风险，不扩大豁免或强行修全部历史债务。

## 7. 研究与维护

[研究索引](ENGINEERING_RESEARCH_REFERENCES.md)保留原20项，新增Owner本次明确给出的Agentless、A2A、OpenAI Agents SDK；明确论文事实、官方机制与项目推导。只借鉴机制，不移植框架/服务。
每片先调查→有界委派→独立验收→更新基线/NEXT/进度页。文档更新不增实现信用；历史68/100保持，不等于MVP成功率。此前离线文档准备未调用模型；后续P1.0开发会话单独获准并记录于基线§7.88，不与产品生成或真实Round混写，不追改历史实验。

### P1准备入口（P1.0已静态接线，行为未验收）

生成必须发生在round-cli.ts的stage冻结（约1323行）之前，不能在确认后的choosePlan（约2185行）临时生成或改写计划。P1.0新增独立的plan CLI，复用现有runtime.run、RunRequest/RunResult和parsePlanFile，生成后只输出未批准草案并退出，随后由用户核对并走原stage-check/confirm。仅typecheck和源码静态审核通过，尚无功能、stage-check往返或真实生成验收。既有解析器上限为5个计划、6步、64KiB、单文本400字符；新入口只允许2–3候选。草案不是授权，不自动执行草案里的测试命令，不新建Planner或第二套工作流。

多候选选择会额外消耗一次LAYA决策请求。沿现有两任务成功路径，分类1+选计划1+推进2在当前接线下需要4次POST，而原固定单计划实验为3次；这是静态调用数推导，不是新增实测。不得暗增原授权的3次上限，生成Agent会话也不计入原Worker≤2的既有预算。P1.0仅有界静态实现获准并完成；剩余行为测试及真实生成仍待另行批准，正式UI需求仍未开始。
