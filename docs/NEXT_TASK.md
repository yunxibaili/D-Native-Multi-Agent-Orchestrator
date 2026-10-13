# 下一任务候选 — B4.5 Git 项目中的顺序协作

更新日期：2026-10-13
当前 B4.4 最小有出处的交接/用户交付视图已由 OpenCode 实现、一次 bounded rework、Codex 独立验证 PASS。
本轮到此停止。B4.5 未启动、未授权实现；不以本文件自动跨阶段。
唯一当前状态见 [PROJECT_BASELINE.md](PROJECT_BASELINE.md)，路线见 [BACKEND_DELIVERY_PLAN.md](BACKEND_DELIVERY_PLAN.md)。

## 已完成，不重做

B4.2/B4.2a 计划与顺序执行、B4.3/B4.3a 最小确认与材料交付保持通过。
B4.4 复用 RoundResult/同次 Attempt 证据，JSON 和实际命令行显示完整目标、声明产物、观察到的写入/命令、日志、未知/过期/阻塞。
返工保留自己的证据，missing 不借 sibling，分类未确认不被说成从未执行；shell 命令不冒充测试通过。
完整产品/真实模型/物理产物和结构化测试结果认证未因本片通过而完成。

## 下一阶段准备方向

用户单独授权后，先读取 WorkspaceManager、ResourceClaim、工作区 scope、现有 summarizeTask/mergeTaskBranch、
协作计划与 Git cwd 拒绝分支，复用已有 Git 执行/超时与用户脏文件保护。
比较“协作组共享受控工作副本顺序执行”与“隔离成员实际差异送入集成者工作区”，只选一条最小路线；
先明确真实交付、来源绑定、冲突和用户脏文件保护验收，再决定允许修改文件。
不新建 merge engine/第二 DAG/并行写权威，不把复制到非 Git 目录当成熟 Git 支持。
具体实施任务在该阶段授权时形成；本轮不提前写 B4.5 生产代码。

## 保持边界

PARALLEL_WRITE=CLOSED；B1/B4 overall 未封板。真实模型/费用另行授权。
project-progress/ 全部 ignored、不入 Git，temporary-dashboard 不触碰，正式工作台前端待需求确认。
