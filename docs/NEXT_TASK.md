# 唯一下一任务 — P0-3c 自动模式异常的待人工汇总（待Owner授权）

当前事实见PROJECT_BASELINE.md §7.43。P0-1/P0-2/P0-3a保留原范围PASS；P0-3b检查点异常报告投影离线PASS（单文件一次92/0，typecheck一次PASS）。P0-3整体及真实MVP仍未封板。

## 唯一下一片建议

先映射默认machine-auto的machineStop、授权撤销、LAYA wait/预算耗尽与Review未完成等实际返回路径：哪些需要用户决定、哪些只是有界等待，保留真实原因。复用P0-3b已有round-result交付与同源pendingUser材料；无执行身份时保持null，不捏造Attempt或停止事实。

- 材料是报告，不是Task状态、用户accept或恢复授权；resumeSupported=false。
- Worker树停止不能冒充批准测试/整轮安全；停止未知保留原WRITE保护，不启动新写者。
- 必要时先交Gemini官方机制检索单；不照搬LangGraph/Temporal持久化，不承诺exactly-once或隔天恢复。
- 后续实施、新增/修改测试及真实模型调用尚未授权，不自动运行真实E2E。

## 已完成片的边界

P0-3b仅检查点非显式user-stop异常。真实reader四种故障已验证实际材料落盘；正常继续与明确stop不新增待人工材料。Codex实施与源码复核，不称OpenCode委派或第三方独立审计。默认自动异常统一交付尚未完成，不能把本片PASS等同P0-3整体。

阶段完成后按Owner授权推送独立审核分支，不合并main。OpenCode Free403及Desktop接入旁支保持暂停；不调用产品Agent/LAYA/Native Review。原9/26失败边界与68/100规划信用保留；主HEAD/index/范围外dirty保持，audit只读，进度页ignored，正式前端未授权。
