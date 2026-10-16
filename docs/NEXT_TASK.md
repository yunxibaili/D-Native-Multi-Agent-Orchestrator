# 唯一下一任务 — MVP-E2E.1d

更新：2026-10-16。当前事实只见 [PROJECT_BASELINE](PROJECT_BASELINE.md)；本文件是有界任务说明，**等待 Owner 下发实施，不构成真实调用授权**。

## 目标

一次补齐已经定位、直接阻挡第四次 MVP 的两个改动：
1. checkpoint 区分真实 user_accept/user_stop 与系统 timeout/EOF/input_error；显式采用“首尾确认 + 异常中断”实验策略，合规中间任务自动流转。
2. 在既有 Verification 链上加入确定性产物路径/允许范围/真实测试结果核验，避免 LAYA 以 complete 承担代码质量裁判；仍以真实 Codex Native Review 和 Human Gate 收尾。

第三次 MVP 为 PARTIAL：真实写入 workspace/demo/add.js、demo/add.test.js，测试2/0，计划要求根目录 add.js；Owner accept0/stop0，60秒系统超时却记 source=user；第二 Worker/Review 没运行。cwd 正确，路径偏移源于 Worker write 参数；不能只改 Demo 文案解决全部问题。

## 调查与复用

实施前复核 [研究索引 #11/#18/#19/#20](ENGINEERING_RESEARCH_REFERENCES.md) 和现有相关调用链；不用新增 Planner/Workflow/Verification authority。
- workflow-checkpoint.ts:103/191/214：60秒策略、标准输入及系统失败。
- round-cli.ts:2686/2734/2846：同 Attempt 检查点、恒 user 的错误归属、循环停止。
- plan-file.ts:66/169/284：扩展现有计划格式的最少验收字段，未知/非法路径写前拒绝。
- workbench.ts:1436/1445：completeTask 在 applyVerification 前的共享检查入口。
- round-cli.ts:2358/2559/4047：真实 Attempt/RunResult、推进循环、终审接线；unified-review.ts:566 保持。
- opencode.ts 的 toolFromPart / AgentSession.noteToolCall 保留原生 exitCode；不能用文本中的“测试通过”代替它。

## 实施与验收边界

使用项目现有函数组织最终事实检查；必要时增加一个小纯值 helper，不建设新质量平台。expectedArtifacts 必须定位到实际 workspace 相对路径；allowedScope 检查真实变更，包含 shell 写入；测试要求绑定真实命令/cwd/退出码/超时/同 Attempt。不把进程树停止、费用资格、文件权限视为质量检查的替代品。

通过检查后仍走同一 completeTask/applyVerification；不直接写 TaskStore。LAYA 保留合法候选内任务级决策，但不再决定文件/测试是否合格；wait 不改成假 PASS。现有逐步人工模式兼容；新策略显式启用，开始确认来自已绑定材料，末尾 Human Gate 保留，不能默认替 Owner 接受最终成果。

离线至少覆盖：路径正确/错加目录/缺文件、越界变更、真实测试0/非0/未运行/超时、模型伪报、旧 Attempt/停止未知拒绝、通过后第二任务可推进、系统超时不记用户选择、异常阻断、最终 Review 真正被调用且缺 verdict 不通过。使用现有 fake runtime/fetch/输入 seam；新旧模板/门禁负控必须能检出目标问题。仅运行受影响定向套件、typecheck、git diff --check，不要求 full suite。

Demo 配置明确“cwd根目录”与实现/独立测试职责，不预置目标文件，不搬旧产物。范围校验不是新沙箱；不能放宽目录外权限。保留26项既有失败及其固定/顺序/无接力豁免，不顺手修改接力架构。

## 分工与停止

授权实施后由 OpenCode 通过既有 opencode-agent implement，实际模型 opencode-go/deepseek-v4.1-flash；Codex 独立审核与复跑。最多首次实现+一次定向返工，不能因报告 PASS 就采信。当前文档任务没有启动该开发委派。

不修改 LAYA 权重/协议、原生 Agent 安装、Scheduler/Registry、Human Gate 或 Job containment；PARALLEL_WRITE=CLOSED，automaticPostRoundAction=NONE。涉及必须新增执行权威或大改权限时停止。

完成后更新唯一基线/NEXT_TASK/本机进度页并停止。**第四次真实 E2E 仍须单独核实模型/费用和重新授权；旧 POST/Worker/Review 额度不得继承。** 未来自然语言生成、角色工具过滤和正式桌面 UI 不纳入本任务。
