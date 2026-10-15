# 下一候选 — B4.6b：已有检查点的显式人工验收

更新日期：2026-10-15；当前事实只见[PROJECT_BASELINE.md](PROJECT_BASELINE.md)。

## 只读审核结论

LAYA-BOUNDARY.1只读职责审核完成：Verification是唯一状态写入权威，但不是自动测试/产物核验器；Workbench.completeTask把调用者的完成判断转成pass，原生LAYA选择complete的质量判断因此仍由模型承担。候选中有材料、状态可迁移，不等于质量已独立验证。历史QUALITY.2的安全wait与目标完成未验收保持，不能将状态权威误说成独立内容裁判。

当前真实调用链：LAYA动作→同次候选目标映射→decisionCapabilities.complete→NativeWorkbench.completeTask→Orchestrator.applyVerification→translateVerification/TaskStore。独立整轮Review在workflow所有成员succeeded之前被executionIncomplete挡住，且runUnifiedReview只产报告不写Task；它不能倒过来解决第一个to_verify任务的验收。任务级applyReview/review-loop已有，可供显式调用，但当前CLI该路径没有自动接线；不需要另造ReviewManager。HumanGate是结果/选项投影，automaticPostRoundAction恒none，不是stdin执行器。

既有--checkpoint只接受continue与stop <reason>：continue保持任务状态，继续让LAYA决定；stop保留成果并停止。没有显式人工accept入口，不能把continue暗改为验收或把安全wait默认为complete。这是个人工作台可用性/职责接线缺口，不是新发现的TaskStore安全绕过。

本轮受控离线探针复用QUALITY.2捕获wait，经真实provider/decision loop/NativeWorkbench后，任务不变、complete0/runtime0；当前accept语法实际invalid；可信调用者显式completeTask可使唯一指定to_verify任务succeeded，而planned任务仍被not-awaiting-verification拒绝。此探针没有真实执行/质量认证，不证明生产CLI可绕过材料门。独立b46检查点42/0、review-loop169/0、round-result346/0、unified-review130/0、workbench419/0均exit0，209版本文件前后hash不变。

## 最小方案与取舍

下一候选B4.6b是最小显式人工验收检查点：复用--checkpoint/readline/同Attempt只读快照及wb.completeTask，不新建验证器、调度器或状态权威。新增accept <非空reason>仅在原检查点显式启用时生效；等待输入后重读当前Task及原子Attempt→RunResult，要求task/attempt身份一致、仍to_verify、实际执行及停止确认完整。缺失/更换/未知停止均拒绝，不用旧快照或latest-by-task拼接。记录来源user、taskId/attemptId和理由，不冒充LAYA决定、模型Review或实际测试事实；continue/stop及默认入口不改。accept后先重算原循环完成/就绪，末步已完成时不再多问LAYA，后续派发仍走原调度/配对/额度/资源/阶段门。

保留LAYA分类、计划、具体Agent×Model与任务级工具选择目标。新路径仅是用户明确使用检查点时的人工兜底，不将模型的wait/abort改写为完成，不绕过任何业务门。直接加一个自动step reviewer会增加真实模型调用/费用并需新授权；plan-file任意测试命令验证器还涉及执行/授权范围，本片不做。现成状态入口可复用，不再造轮子。

## 建议实施范围（需下发本片后才开始）

- 允许产品文件仅src/cli/workflow-checkpoint.ts、src/cli/round-cli.ts；优先复用wb.completeTask，Workbench等底座不应需要改动。
- 测试复用tests/b46-workflow-checkpoint.test.ts；仅在CLI邻接验证确需时补tests/b40a-cli-workflow.test.ts。既有套件已注册，不新建runner。
- Codex调研/任务范围/独立审核；OpenCode指定DeepSeek V4.1 Flash bounded实现，最多首次+一次返工。worker不改文档阶段、不Git写、不读取凭据/配置、不调用真实产品Agent或LAYA、不加依赖。
- 先查本机相关实现，核对[官方LAYA职责边界](https://github.com/NandhaKishorM/laya/blob/6ab71fb4ce6bfd6f189e9b689eaadd67103ed9b6/docs/staged-adoption.md)，再接现有入口；文档是方法依据，不是新质量结果。

## 必需验收

1. parser仅新增明确accept加非空理由；continue/stop保持，裸accept/EOF/非TTY/超时/错误不默认通过；无--checkpoint仍不读输入。
2. 真实runRoundCli受控链：用户accept只完成其看到的当前任务/Attempt，另一任务保持；使用真实wb.completeTask/applyVerification，runtime exit0本身不完成。
3. 用户输入期间任务或当前Attempt改变、RunResult缺失、停止未知/false均拒绝且不变更状态/不派发；不能将用户文本当文件产物/测试已验证事实。
4. 最后一个任务accept后按原循环重算all-succeeded，不额外发送一次无可行动作的LAYA请求；若仍有后续任务，原Assignment/固定pair/额度及最终同步准入保护照常生效。
5. 来源user和非空理由可追溯taskId/attemptId；不打印成LAYA决定/Agent review/实际测试通过，不自动付费、merge或打开parallel write。
6. 保留既有检查点/模型wait/材料缺失/阶段绑定/协作回归；定向typecheck、b46、b40a、state-loop、round-result、workbench，其他测试按影响；不跑fullsuite或真实推理。

## 保留范围

B4.6b只是个人MVP的显式人工兜底，不替代用户要求的完整自动编排与独立质量验收；默认LAYA路线保持，不能把人工通过宣传为真实LAYA自动验收通过。本轮只读审核/文档，无产品源码或测试改动、无新推理/服务/worker/依赖；本地累计12、产品5/5不变，PARALLEL_WRITE=CLOSED，估算68/100不因方案增加信用。B4.6b尚未实施；当前已有授权只完成本片职责核对。
