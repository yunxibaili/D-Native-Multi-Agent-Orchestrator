# 唯一下一任务 — P0-4.18 既有Review夹具迁移与单文件离线验收（待明确测试授权）

P0-4.17单文件实现与静态检查完成，当前PARTIAL（PROJECT_BASELINE.md §7.78）。Owner本轮仅批准Codex直接实现、一次typecheck/diff，不含测试；未启动OpenCode/Reviewer/LAYA/Round。不得将typecheck0或信任边界assert当行为负控通过。

## 已实现范围

仅src/orchestration/unified-review.ts：Codex结构化Review的唯一owned -o文件、进程局部analytics.enabled=false；同一handle/task/agent且succeeded/exit0/signalnull/Job停止后才读取，最多64KiB、UTF-8严格、路径与metadata检查，原normalize/validate及宿主字段保留。未知停止保留owned位置，cleanup失败拒绝完成；其他Reviewer保持原路径。

## 唯一最小待授权范围

在不修改/放宽生产门禁前提下，迁移既有tests/unified-review.test.ts中的假Reviewer，使其提供正确handle/RunResult身份，并按请求的--output-last-message确实写入本次文件。覆盖合法最终JSON与混合过程输出分离、缺失/空/错误/超量/非法UTF8文件、错误身份/失败退出/未确认停止不通过，以及非Codex兼容路径；可复用原有受控fixture，不新建测试框架或真实Agent入口。首片只改这一既有测试文件；其他suite中的fake适配另行静态定位，不自动扩大。

如获明确授权，只通过已登记的白名单Runner、offline bootstrap和外层contained机制运行该单文件一次，不direct node回退、不运行全量或其他suite、不重复验证；确认无真实Agent启动和owned Job final0。停止未确认的模拟必须由现有假Transport提供，不启动真实模型。缺白名单登记/安全入口时直接报告，不改Runner绕过限制。

当前仍遵守默认零新增/修改测试，须Owner明确授权上述单文件改动和一次运行后执行；本文件是建议，不是测试授权。若需要开发模型，另核对有效费用事实；OpenCode上次启动被自动审批拦截，不用替代启动方式绕过。本轮Codex实施者例外不自动延续。

真实Reviewer/Round仍无授权；P0-4.13/15超时、旧Round/Human Gate PARTIAL、9/26历史失败与全局模型保持。后续行为验收未完成前不宣称P0-4.17完整PASS或回归保持全绿。
