# 唯一下一任务 — P0-4.21 现有 review CLI 的统一审核最小接线（待批准）

当前P0-4.20启动前BLOCKED，唯一基线§7.83。Owner已经批准单次Reviewer及费用事实；阻塞来自入口适用性，不再索要相同授权。现有`review`只返回原生RunResult；`runUnifiedReview`仅由Round执行后的分支调用。不得为使用已批额度临时新建脚本、手工验证输出或重跑Round。

## 唯一最小建议

在现有review CLI增加一个显式消费既有ReviewPacket的有界分支，复用现有Orchestrator、runUnifiedReview及其唯一owned最终文件、严格JSON、身份/实际退出/Job停止/清理门禁；保留原始review调用兼容。先核对已有ReviewPacket字段与可追溯证据来源，再限定输入校验和输出，不新增Runtime、Scheduler、TaskStore或第二套verdict解析。

实施前需Owner批准这一小片生产修改与必要的单文件离线验收；保持OpenCode实现、Codex独立审查。当前尚未授权实现、开发调用或测试，不自动启动。无新增外部机制问题，现有源码/固定版本资料足够，暂不需Gemini检索。

## 安全与真实验证边界

固定codex/gpt-6.1-sol，实际进程deadline90000ms；超时/非零退出/身份不一致/停止未确认/最终文件不合法均失败关闭，无重试或模型替换。原始review入口不得被误称为已通过统一Review。

本片实现只做离线接线验证；不启动真实Reviewer、Worker、LAYA、Round，不改旧Round结果/Human Gate，不使用fixture冒充真实审核。后续单次真实Reviewer需在入口离线验收后另用明确授权及有效费用窗口；P0-4.20未用调用不自动结转。

P0-4.19有限离线PASS保持118/0，不回填整个MVP PASS；9/26历史债务不扩大。P0-2新功能、前端、接力继续不启动。

保留主HEAD/index/范围外dirty；阶段文档可按Owner既有授权精确归档至独立codex分支，仓库外隔离索引，核对远端SHA/文件清单并清理自有临时资源，不合并main、不强推，不上传project-progress/audit/凭据。
