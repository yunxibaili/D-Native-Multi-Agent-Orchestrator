# 唯一下一任务 — P0-3c.1 最终授权失效的持久化投影（待Owner授权）

当前事实见PROJECT_BASELINE.md §7.46与P03_FINAL_CLOSURE_REVIEW.md。整体P0-3静态收口BLOCKED；a/b/c原有有限离线结果保留。本轮没有生产/测试修改、任何测试/typecheck或真实模型调用。

## 唯一直接缺口 P03-F1

round-cli在Review后finalDrift可令report.ok=false，但automaticAttention没有消费该最终事实；当任务全成功、Review pass且其他拒绝为空时，不生成pendingUser。现有publishRoundResult只保存RoundResult，外层machineSupervision.finalFailures没有进入该持久化视图。

这是源码可达场景，尚未新实跑，不是已证明发生越权派发。模型池在Review期间过期或阶段材料同期变更即可满足分析条件。

## 建议的最小实施范围

- 只把现有最终approvalDrift结果作为Round范围唯一事实传给原attention选择，确保实际落盘approval-revoked原因；不重新建立授权系统，不改Task成功状态或原Reviewer pass，不自动重试或新增调用。
- 只在既有tests/p02-auto-advance.test.ts补一项受控Review回调撤销负例。保留A成功正控，核对两Worker/批准测试已完成、Review原结果保留、外层非零、实际保存原因、无新派发；未知任务身份保持null。
- 源码/测试修改、单文件一次运行和必要typecheck均待Owner明确批准；当前只读审核授权不自动扩大成修复授权。不跑其他suite，不运行真实模型。

缺口是本地数据流接线，暂无必须向Gemini核实的外部机制。后续真实E2E仍需新的模型/费用/数据/次数授权；OpenCode403旁支暂停，不借此再试模型。

阶段审核记录按Owner既有授权推送独立分支，不合并main；主HEAD/index/范围外dirty保留，9/26历史边界与68/100规划信用不变。audit只读、进度页ignored、正式前端未授权。
