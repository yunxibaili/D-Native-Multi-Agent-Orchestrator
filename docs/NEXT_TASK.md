# 唯一下一任务 — P0-3a checkpoint系统/用户来源分离（待Owner授权）

当前唯一事实见docs/PROJECT_BASELINE.md §7.41。

## 当前裁定

P0-1沿用PASS；P0-2已完成有限离线收口PASS。范围是已确认stage、冻结文件计划、完整任务完成契约、声明free/included池、并发1、retry0、no-handoff、有限POST和显式checkpoint优先；不等于真实模型、原生权限/费用或完整后端封板。

最终静态审核复核源码及A–F日志，当前CLI/测试哈希匹配75/0记录，其他生产代码未漂移。本轮未运行测试/typecheck或模型；未改生产代码。详细矩阵：project-progress/p02-final-static-review-20261019/closure.md。

## 唯一下一片建议

批准P0-3a，仅修复现有checkpoint报告的来源归属：

- Owner明确输入stop，才记录为用户主动停止。
- 输入EOF、读取异常、超时等系统失败不得伪记user_stop/source=user；非法答复应保留输入事实与解析失败事实，不伪造用户停止意图。
- 复用workflow-checkpoint.ts、round-cli checkpointGate和现有结果形状，保持停止、deadline及资源保护；不新建TaskStore/状态机/恢复引擎。
- 同步报告和面向用户的原因，不能一处改source但文案仍声称用户主动停止。

实施前确认最小字段/兼容性范围；必要时只向Gemini索取Node24输入结束/错误/超时及事件归属的官方依据，不移植框架。当前尚未授权修改生产或新增测试，不自动实施。

## 本片不包含

不实现跨进程恢复、隔天继续、完整pending持久化；不开放并行写，不调用真实产品Agent/LAYA/Native Review，不启动下一次真实E2E。

P0-3完整异常等待与最终Human Gate仍未通过；后续真实闭环需新调用/费用/数据范围授权。OpenCode路由保留但当前Free 403，Desktop固定环境密码方案未通过源码准入；接入旁支暂停，不拖住本地来源问题的调查。

9/26历史失败边界保留，历史规划信用68/100不因测试数自动增加。HEAD/index/范围外dirty保持，无commit/push/merge；audit只读，本机进度页ignored；正式前端未授权。
