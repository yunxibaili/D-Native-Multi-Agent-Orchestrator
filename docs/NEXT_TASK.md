# 下一任务建议 — B4.3a 剩余计划绑定单点

更新日期：2026-10-13
执行对象：用户授权后由 OpenCode 开发，Codex 独立审核。
状态：B4.3a 独立 BLOCKED；本文件是最小返工建议，不自动启动实现/worker，不进入 B4.4。
唯一当前状态见 [PROJECT_BASELINE.md](PROJECT_BASELINE.md)，路线见 [BACKEND_DELIVERY_PLAN.md](BACKEND_DELIVERY_PLAN.md)。

## 已通过，不重做

显式 sequential/collaborate 的绑定 digest、gate 单次读取冻结、完整材料内联、超限写前拒绝，已独立验证。
B4.2a 资源/依赖报告分类、fixed、Assignment、Review、停止/资源门保持原约束。
不重复实现 planner、审批系统、材料仓库或调度器；不重审全部历史阶段。

## 剩余 P1 与最小方向

当前允许 --stage 不带 --workflow，normalizedPlanScope 返回 null；确认通过后才分类生成 legacy 计划。
独立真实 CLI + 受控 provider/runtime probe 用同一材料/目标/确认，small 接受单任务、moderate 接受三步骤计划，
两次均实际派发 1 次、exit=0。确认尚未绑定实际计划，常规 b43 32/0 未覆盖这一入口。

建议最小实现：在阶段门拒绝 --stage 与未指定受支持 --workflow 的组合（包括 --stage-check），
任何外部调用、任务创建之前返回明确错误和非零退出。无 --stage 的 legacy 旧行为不变；
显式 sequential/collaborate 的已验证正常确认链不变。不必扩建 legacy 计划审批能力。
如选择支持 legacy，则必须先展示/冻结/绑定它真正生效的计划范围，不接受继续用 null 冒充计划。

## 验收与范围

- --stage 无 --workflow，不论有无 --confirm 或 --stage-check，均明确写前拒绝，provider=0、runtime=0、无 tasks。
- 无 --stage 的旧入口兼容；显式 workflow 的 stage-check 仍只读，正确确认后可运行，改计划/目标旧确认失效。
- b43-stage-material 补同一实际 CLI 入口回归；typecheck、b43、b40a 与实际受影响的最小定向回归、diff check。
- 不 full suite、真实模型、凭据、本机 Agent/API 配置、依赖、Git 写操作；PARALLEL_WRITE=CLOSED。
- 只允许触及 stage gate、必要定向测试与既有技术文档；不修改已通过的调度/停止/材料框架。
- 更新唯一基线和 project-progress 快照，运行本机 refresh；整个 project-progress/ 仍 ignored。
- 报告本轮真实链路、退出码、owned 残留和未验证项；标 READY FOR CODEX INDEPENDENT REVIEW 后停止。

当前尚未获得本单点的新增实施授权；不以本文件或模型决定替代用户下发。
