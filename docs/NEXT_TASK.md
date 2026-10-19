# 唯一下一任务 — P0-3b 异常待人工材料与安全停止事实（待Owner授权）

当前事实见PROJECT_BASELINE.md §7.42。P0-1、P0-2保留原范围PASS；P0-3a来源归属修复离线PASS，既有checkpoint单文件一次77/0，typecheck最终通过。P0-3整体、真实MVP及正式前端未封板。

## 唯一下一片建议

仅准备异常后的最小用户交付：复用现有checkpoint/round-result及观察文件，把真实停止原因、Task/Attempt/Session、已有产物、未完成事项和停止确认事实形成可读待办。系统失败不是Owner stop；没有真实输入就没有user_accept。

- 活动执行资源先按既有机制停止；停止未确认保留保护，不允许新写者。
- 不新建TaskStore、恢复引擎或第二套状态机；材料落盘不表示跨进程恢复。
- 明确resumeSupported=false，不承诺隔天继续；不扩大60秒之外的Worker/Reviewer/LAYA执行deadline或费用预算。
- 尚未授权实施或新增测试。若涉及新的pending/恢复语义，先给Gemini具体资料单，Owner确认最小契约后实施。

## 当前边界

本轮P0-3a由Codex依既有直接推进授权实施；并非OpenCode交付或第三方独立审计。OpenCode Free403与Desktop配对旁支保持暂停。真实产品Agent/LAYA/Native Review调用关闭，不自动运行第四次真实E2E，不开放并行写。

Owner已授权阶段完成后归档独立审核分支；不合并main。9/26历史失败保持原边界，规划信用68/100；主HEAD/index/范围外dirty保持，audit只读，project-progress ignored。
