# 唯一下一任务 — P0-4.7 唯一一次定向返工：可信Review元数据接线

先读PROJECT_BASELINE.md §7.61。首次+3/-1接线正确，但整片仍BLOCKED；parseReviewOutput不补reviewer/reviewedAt，按helper四字段输出仍失败。P0-4.6保持PARTIAL，无新的真实调用授权。

## 唯一允许修改

仍只改src/orchestration/unified-review.ts，保留已接入的reviewInstructions及原subject。不得修改review-verdict.ts或parser/schema实现，不新增helper/模块。

在run成功后的既有try/catch中，复用normalizeReviewOutput严格解析模型输出，再用调用方options.reviewer和一次options.now()提供可信元数据，调用原validateReviewVerdict。只补reviewer/reviewedAt，不填任何verdict/reason/findings/recommendedAction默认值。组合时用对象展开，可信字段放最后，不允许模型伪造/覆盖来源；normalizer已保证JSON对象，必要的类型收窄限该已检查值。不得从自然语言提取或猜verdict。

成功UnifiedReviewResult.reviewedAt复用已验证verdict.reviewedAt，不再次读时钟产生两份不一致时间。其他状态、单次调用、超时、invalid-output失败关闭、Human Gate和任务状态行为全部保留。不重跑Review。

## 轻量验收

只由Worker运行一次现有typecheck和git diff --check，保存脱敏输出日志到现有ignored记录区，不编写验证脚本或新增/修改/运行测试。Codex审核diff/日志，不重复运行检查。

静态逐项说明：四判断字段的合法JSON可由框架补可信元数据后进入原严格验证；prose/缺字段/非法枚举仍失败；模型自报reviewer/时间不能覆盖真实调用者；成功结果复用单次时间。不能把静态走查说成已实测或真实模型通过。

这是本片唯一一次返工。失败或权限阻断就停止，不扩大到helper/parser/适配器或第三轮实现。禁止模型/LAYA/Native Review/真实Round；禁止源码范围外修改、历史证据修补、commit/push/reset/clean/stash。测试证据投影、父任务呈现和UTF-8记录问题仍开放。本次完成READY FOR CODEX REVIEW或BLOCKED即停止。
