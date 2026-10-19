# 唯一下一任务 — P0-4.7 Native Review输出契约最小接线（待Owner批准）

P0-4.6独立结论PARTIAL，见PROJECT_BASELINE.md §7.60。真实2Worker/1Reviewer/3LAYA POST已用完，无新的真实调用授权。Human Gate仍由Owner决定；不追加Review、诊断或Round。

## 已定位缺陷与最小复用

runUnifiedReview拼装自然语言审计请求，却未复用review-verdict.ts已有reviewInstructions(subject)，随后parseReviewOutput又严格要求JSON。本次原生Review原文确为自然语言。唯一优先修复该请求/解析契约失配，不改parser、不猜测prose verdict。

## 拟允许实现范围

仅src/orchestration/unified-review.ts：导入并调用现有reviewInstructions，将现有完整审核subject包装为严格JSON输出要求。保留原Review packet、独立审核、报告不重跑、单次调用、超时/失败关闭及Human Gate语义。新增helper/schema/provider/router均不需要。不写Demo特例、不强制pass、不增模型调用或重试。

先读该文件和review-verdict.ts及已有其他调用者，仅做本地调查；不需要新外部检索。保持开发由OpenCode实施、Codex审核，Owner手动转交；此文档不是源码实施授权。

## 轻量验收与停止

不得新增/修改测试文件或验证脚本，不运行测试套件或真实模型。Worker仅一次现有typecheck及git diff --check，并以静态调用链说明最终传入reviewer.review的prompt含现成schema和无JSON外文本规则；提供真实日志。Codex审核diff及日志，不重复执行同一检查。最多一次实现加一次明确返工，连续两次检查失败停止。

禁止改review-verdict parser、adapter、TaskStore、Verification、LAYA、调度/资源/身份、Review自动重试；禁止修改或修补原Round证据、全局配置、凭据/安装目录；不commit/push/reset/clean/stash。

返回READY FOR CODEX REVIEW或BLOCKED后停止。静态接线完成不等于真实Review通过；批准测试结构化证据、planned父任务呈现歧义与观察端UTF-8记录问题仍保留，不能把这些一起标成PASS或自动授权新E2E。
