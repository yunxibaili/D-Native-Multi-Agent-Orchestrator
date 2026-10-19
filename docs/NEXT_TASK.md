# 唯一下一任务 — P0-4.2 Owner声明入池与单次无推理stage-check（待Owner批准转交）

P0-4.1材料静态PASS，见PROJECT_BASELINE.md §7.51。Demo：D:/workbench-demo/p04-20261019T035918Z。真实产品调用仍关闭。

## 已有新事实，不重复询问

Owner本轮明确确认Worker opencode/space-bunny-free可用且本轮零新增收费，Reviewer codex/gpt-6.1-sol有足够订阅包含额度且不使用额外credits/API余额，答复明确“不授权调用”。记录见project-progress/p041-demo-review-20261019/owner-declaration.json。

记录时间为1792382724867（2026-10-19T04:05:24.867Z），不是新推理或账户测量。按既有30分钟声明窗口，expiresAt为1792384524867（04:35:24.867Z）。若执行时已过期，先停止并报告；不能用编辑时刻滚动延长，也不能改 source 冒充Provider实测。

## 允许范围

仅更新新Demo control/pool.json的两条observedAt/expiresAt/source，保留模型ID、billing及policy；保留旧文件备份且不改任何旧Demo、生产/测试文件、原生项目/全局配置。control/README可补本次事实，日志写control或新owned ignored目录；既有state目录仅允许当前CLI正常写入。

纯文件核对完成后仅运行control/README既有stage-check命令一次：相同objective/workflow/choice/config/cwd，显式POST3、LAYA/Worker/Review各90000、并发1、retry0、no-handoff。必须保留--stage-check，禁止--confirm/--live-agent。当前不启动LAYA，源码该路径在Provider/probes前返回，无需先启动服务。

保存实际命令、退出码、完整JSON与stderr、digest/authorization、配置哈希及workspace前后文件列表。非零立即停止，不重试、不回退真实Round；不要编写临时自检脚本或运行批准测试、typecheck/其他suite。digest因池声明/配置变化而变化，不能沿用旧值。

## 保留未知

stage-check通过只证明当前本地材料/声明满足预检，不证明真实模型、计费、原生effective main/small_model/provider/工具权限或E2E。不调用任何Agent模型/版本/模型目录探针，不读取凭据，不改权限。原生配置继承来源如仅能静态核对则列明；无法确定就保留unknown，不为此扩大任务。

机器批准测试仍默认120秒，Owner尚未授权该时限或真实调用；LAYA启停、原生内部重试及最终Human Gate预算仍需最终执行授权。不要把本次Owner费用声明扩展为真实调用许可。

## 返回

READY FOR CODEX REVIEW或BLOCKED，附精确diff、实际命令/退出码、stage-check JSON、声明来源时间、digest、零任务/零POST/零产品会话的可观察事实及未知项。完成后停止。Codex审核，不重复运行预检。

禁止Git提交/推送/合并；归档由Codex负责。
