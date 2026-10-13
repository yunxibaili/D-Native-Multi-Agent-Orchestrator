# 下一任务 — B4.2a 合法依赖与顺序执行收口

更新日期：2026-10-13
执行对象：OpenCode 开发；Codex 独立审核。
状态：已整理的下一任务，待用户下发实施；本轮仅创建任务文档，不启动后端修复。
唯一当前状态见 [PROJECT_BASELINE.md](PROJECT_BASELINE.md)，完整路线见 [BACKEND_DELIVERY_PLAN.md](BACKEND_DELIVERY_PLAN.md)。

## 问题及独立证据

B4.2 的默认链式 sequential/duo/trio 测试通过，但以下合法文件可以解析、提交和分配，随后无运行：

```json
{
  "kind": "sequential",
  "plans": [{
    "id": "independent", "label": "two independent writes",
    "steps": [
      {"role":"one","taskType":"implementation","fileScope":"src/one","deliverable":"one file","dependencies":[]},
      {"role":"two","taskType":"implementation","fileScope":"src/two","deliverable":"two file","dependencies":[]}
    ]
  }]
}
```

真实 CLI/Workbench/Assignment/Scheduler + 受控执行端独立 probe：两任务已分配，runtime requests=0、exit=1、
workflow.stop=no-progress。Scheduler 的实际结果均为 resource-unavailable：共享非 Git 目录不能为可同时运行的写者建立隔离。
最终 decision.note 却称没有 free slot/ready task、没有被 gate 拒绝，丢失了关键拒绝事实。
collaborate 的两个成员同样使用 dependencies:[] 时可复现。未发生真实并行写，保护有效。
独立对照仅将既有 max-concurrent 改为 1 仍未通过，不能把“改默认并发”未经验证当成充分修复。

## 先调查，后最小修复

1. 沿 plan-file 的默认/显式依赖 → 候选 → commit → 工作区/资源准入 → Scheduler → dispatch receipt → CLI 报告核对。
2. 检查现有 scope、顺序推进和资源门的复用方式；本地修复不必重新调研一套开源编排器。
3. 优先在本工作流入口落实顺序写执行，保留用户业务依赖；不能通过去掉 resource gate 或伪造 dependencies 来过测。
4. 当前若无法支持某类依赖，必须在写任务前具体拒绝该形状；不得解析接受、分配后再默默停住。
5. 报告保留实际 gate 拒绝码、任务及原因，区分等待依赖/容量与拒绝；不要只改文本假装执行已恢复。

选择一种最小实现，不建设调度器、通用 DAG、merge engine、manager 或新状态机。Codex 不代替本轮开发。

## 验收

- 默认链式计划继续通过；explicit [] 的多入口写任务顺序完成，或有明确的启动前未支持拒绝。
- 如果支持：同一 CLI 链真实写出 owned 文件，max effective writers=1，协作集成消费所有成员实际字节。
- 成员失败/无交付仍阻止集成；fixed、Assignment、停止未确认保护不能绕过。
- 前向合法依赖能正确处理或预先明确拒绝；显式与默认依赖混合形成的环在写前拒绝，无部分任务。
- 实际 resource-unavailable 不再被最终结果描述为“没有任何 gate 拒绝”。
- 通过真实 runRoundCli 的 hermetic 回归取证，不在 CLI 外手工 completeTask；负控只针对本次承重分支。

## 验证与交付

typecheck、b42-plan-file、b41-collab-group、b40a-cli-workflow，以及实际受影响的 planner/workbench/资源/报告定向回归；git diff --check。
不 full suite、不调用真实模型、不读凭据、不改本机配置、不开放 PARALLEL_WRITE。
owned 清理失败进入非零退出；不触碰 foreign 文件或进程。
更新既有文档与唯一基线，运行本机 `node project-progress/refresh.mjs`；页面保持 ignored。
最终报告原因、复用、改动、真实验收与残留，标 READY FOR CODEX INDEPENDENT REVIEW。
不自行封板、不 commit/push/stash/reset/clean；结束后停止。
