# 项目协作与进度维护

用户全局规则继续适用；OpenCode 主要开发，Codex 独立审核。未经用户明确实现授权，不由审核者接管后端开发。
个人工作台优先最小可用闭环、现有代码复用，不新建第二套调度/状态权威。

## 每个任务先调研

- 按用户全局 `$research-before-work` 执行；本机入口为 `~/.codex/skills/research-before-work/SKILL.md`。Codex 在每个新切片规划/委派/审核前先查本地实现和相关官方在线来源，再验证现成结论在本项目是否适用。
- OpenCode 收到任务后先复核提供的来源及相关实现，优先复用，不凭猜测扩写；同任务有效资料可复用，不重复试模型求通过。既有模型、权限、最多一次返工和真实推理 opt-in 边界不变。

## 唯一基准与任务结束动作

- 当前事实、阶段状态、证据及进度快照只在 `docs/PROJECT_BASELINE.md` 维护。
- 需求见 `docs/BACKEND_REQUIREMENTS.md`；路线见 `docs/BACKEND_DELIVERY_PLAN.md`；下一任务见 `docs/NEXT_TASK.md`。
- 每次实施、审核或用户决策推进任务后，先更新基线中受影响事实及 `project-progress` JSON 快照的当前任务、阻塞、来源和更新时间。
- 不把实现方自述提升为独立 PASS，不把 fixture 当真实 Agent 证据；完成比例是带权重与分母说明的规划估算，不能靠测试数自动增加。
- 更新受影响文档后，如果本机 `project-progress/refresh.mjs` 存在，运行 `node project-progress/refresh.mjs`，检查页面数据与基线一致，再提交报告。
- `project-progress/` 是用户要求的本机独立进度页，全部源文件/数据/预览脚本/备份禁止加入 Git，不能 force-add。缺失时报告本机页面未更新，不为此宣称后端失败。
- 页面只展示计划和审核事实，不能调用 Agent、读取凭据、派工或作为用户批准。

## 边界

PARALLEL_WRITE 保持 CLOSED，真实 Agent/模型测试必须遵守 opt-in 和用户费用授权。
用户仅授权了本机进度页；正式工作台前端需求仍需单独确认。本地静态页面不需要引入 React、Vite 或新依赖。
