# 项目基线 — 唯一当前状态入口

更新日期：2026-10-12
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
| 下一任务 B4.0 | 提示词与范围已整理，尚未启动实现；只做异构任务顺序闭环 |
| B2 / B3 / B4 其余切片 / B5 | PLANNED；本轮未授权启动实现 |
| PARALLEL_WRITE | CLOSED |
| 本产品前端 | 需求未确认；进入前端前提醒用户单独梳理 |

B4.0 是在现有底座上提前交付最小工作流，不自动授权整个 B4，也不把 B2/B3 的缺口宣称已实现。
本轮只维护技术文档并交付下一任务提示词，没有改源码、测试或调用模型。
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

Planner/CandidateTask/commitPlan、TaskStore、Assignment、Scheduler 与依赖材料交接已经存在。
当前 planFromSpec 主要按 shape 生成同类候选；不能据此称已完成调研/实现/测试异构角色闭环。
READ fan-out 使用父容器与独立 child task；成员有各自 Lease/Session/Attempt。
ALL-terminal 是聚合事实，不是通过验收；PARALLEL_WRITE=CLOSED。

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
2. 完整角色计划、同目标分工/集成与实际下游交付消费尚缺；B4.0 先做顺序异构任务。
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
本轮文档整合以 098279e 为父，提交至 codex/backend-docs-next-b40 分支；
只改现有 10 份 Markdown，不改代码/测试/配置，不合入 main；上传后的准确 commit 见会话交付。
