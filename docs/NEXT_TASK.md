# 下一任务 — B4.3 需求与当前阶段材料确认

更新日期：2026-10-13
执行对象：OpenCode 开发；Codex 独立审核。
状态：计划任务，待用户下发实施；本文不自动授权开始开发。
前置 B4.2/B4.2a 已在受控顺序执行范围独立 PASS WITH P2。唯一当前状态见 [PROJECT_BASELINE.md](PROJECT_BASELINE.md)。
完整路线见 [BACKEND_DELIVERY_PLAN.md](BACKEND_DELIVERY_PLAN.md)，需求见 [BACKEND_REQUIREMENTS.md](BACKEND_REQUIREMENTS.md)。

## 本片用户效果

用户能明确告诉后端：这是当前确认的需求、预期效果、当前阶段范围和验收材料；只执行本阶段。
需求材料存在、JSON 可解析、LAYA 选中计划，都不能代替用户确认。没有相应确认时，新阶段入口不得启动实现任务。
先支持用户显式提供材料和确认，不实现一整套自动需求访谈、审批平台或跨阶段自主规划。

## 先调查与复用

先读现有 plan-file/planWithCandidates、Selection/Assignment、Round/NextRoundInput、Human Gate、brief/handoff 和结果发布。
核对哪些值可直接传递，哪些确认目前只在轮末；不要把轮末 Human Gate 当成已有开发前批准。
第三方方法可简短核对草案中 Spec Kit/OpenSpec 的当前官方材料；不安装、不复制调度框架。
复用同一 Planner/TaskStore/Assignment/Scheduler/Runtime，不新增 ApprovalManager/StageEngine/第二套任务状态机。

## 最小实现范围

1. 沿既有 CLI/配置风格提供显式 opt-in 阶段材料入口，至少明确需求/预期效果、当前阶段标识与范围、验收、计划引用。
   优先使用普通文件和既有结构，不强迫每个短材料落盘或建立数据库。
2. 用户确认来自明确用户入口/本次调用，绑定当前材料和阶段；文件自写 approved=true、模型输出或历史记忆不能自行批准。
   说明本地信任边界，不宣称 CLI 参数是身份认证或能约束任意原生 Agent 的内部动作。
3. 新入口在创建任务、分配、启动实现和不必要的外部模型调用前核对必需材料与确认。
   材料缺失、阶段不符、关键范围改变时拒绝并说明待决事项，不无限等待或自动批准。
4. 已确认材料通过现有 brief/验收材料/结果引用进入实际执行，不只新增配置/报告字段。
   大材料使用有界摘要加可读取引用；用户要求、允许修改范围和必要验收不能在交接中丢失。
5. 通过 B4.2 计划走完整受控顺序闭环，结束仍 automaticPostRoundAction=NONE。
   不自动进入下一阶段，不要求每个已授权小任务重复确认。旧入口保持兼容，不追溯性篡改历史任务状态。

## 附带非阻断 P2 小修

B4.2a 的 applyDecision 把所有非 '*' skipped 都称为 gate refused。
真实 Scheduler 的 dependency-unmet 是等待前置；混合 receipt 的第一条等待项还会盖住实际资源拒绝的主 code。
复用 receipt 分类，区分依赖/容量/重入等待与真实准入拒绝；混合场景保留全部原因，主码反映实际拒绝。
补 dependency-only 和 dependency-unmet + resource-unavailable 两个小回归，不建设全局错误分类框架。
同时修正 PlanFileStep.dependencies 旧注释：[] 不声明业务依赖，执行仍追加列表顺序链。
这是伴随接线的小修，不再次单开 P2-only 封板流程。

## 必须证明的验收

- opt-in 入口缺材料/缺确认/确认别阶段：实现 runtime=0，无部分创建/分配，错误具体。
- 材料自写 approved=true 或工具/模型输出宣称批准：不能启动实现。
- 用户确认当前材料与阶段：真实 CLI/Workbench/Assignment/Scheduler + 受控 runtime 写出 owned 成果并经过 Review。
- actual brief 和验收请求含本阶段需求、关键约束、验收及材料引用；旧材料或关键范围变化不沿用旧确认。
- 拒绝/失败不删除用户成果，报告区分未批准、执行失败和未验收；准备材料不标作产品已完成。
- 本阶段完成后下一阶段不启动；已批准范围内的普通任务无需反复确认。
- 原 full/lean/duo/trio、项目计划文件与 fixed 保持；P2 的依赖/容量等待、资源拒绝和混合 receipt 分类正确。

## 不包含

真实模型推理、自动需求生成、实时监督、Git 协作合并、角色默认/prefer、Skill/MCP 实际执行、费用平台、掉线恢复、正式前端和并行写。
不读凭据、不改本机 Agent/API 配置、不安装依赖。以上未实现能力不阻止本片 hermetic 接线验证。

## 验证、文档与停止

typecheck、本片 hermetic suite、b42/b41/b40a、受影响的 decision/state-loop/round-result 定向回归、isolation 守卫、git diff --check。
不 full suite；不以旧成绩当本轮成绩。owned 清理失败进入退出码，不扫描删除 foreign 资源。
更新唯一基线、受影响需求/阶段文档及 progress JSON，运行 `node project-progress/refresh.mjs`；页面仍 ignored、禁止 force-add。
输出调查/复用、修改、可执行示例、真实调用链和材料证据、测试退出码、阻塞与残留。
完成后标 READY FOR CODEX INDEPENDENT REVIEW，不自行封板、不 commit/push/stash/reset/clean，停止。

历史 B4.2a 任务与独立复现保留在 Git 提交 b751ffe 的 docs/NEXT_TASK.md；当前目录不重复保留旧任务副本。
