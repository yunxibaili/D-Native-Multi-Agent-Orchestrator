# 唯一下一任务 — P0-4.12 Native Review契约有限只读映射（待Owner决定）

当前事实见PROJECT_BASELINE.md §7.72。P0-4.11已真实运行一次，结论PARTIAL；本轮调用已用Worker2/2、Reviewer1/1、LAYA POST3/3，完成后停止。未用完的声明时间不构成追加调用授权。

## 已确认

- 产品Worker已由Owner明确切为opencode-go/deepseek-v4.1-flash。两原生Session实际一致，根add.js/add.test.js真实交付。
- 两个P0-1批准测试的结构化code=0、treeStopConfirmed及身份绑定均真实投影/发布，不再是旧UNREPORTED；新RoundResult已按身份复制、哈希核对。源码/全局/祖先配置未改。
- round-mvgba79g约91.2s，产品target退出1/CLI ok=false，外层launcher退出0；不可混同。Human Gate waiting_for_user，automaticPostRoundAction=none，所有owned Job final0、8077已关闭。
- 原生Review确实收到reviewInstructions JSON要求，但ExitedReviewMode输出原生{findings,overall_correctness,overall_explanation,overall_confidence_score}，最终agent_message为自然语言；产品parse拒绝，verdict=null。不能再归因为缺少prompt，也不能将patch is correct自动转为整轮pass。

## 唯一建议切片

有限只读核对src/adapters/codex.ts的review profile/mapEvent、NativeReview事件/RunResult输出及src/orchestration/unified-review.ts/review-verdict.ts既有契约，结合本轮保存的native-review-items.json确定最小适配位置及语义。区分“原生补丁判断”与“Round完成/模型身份/证据充分性”，保持fail-closed，不新增第二套Review权威；先给精确方案再申请必要源码实施授权。

本轮不自动启动此下一片，不运行新Review/Worker/LAYA/Round/测试，不扩大模型预算。需要核对外部Codex CLI契约时按OpenAI官方资料/本机当前版本，以Gemini资料辅助，不能照搬猜测。不得修复或转换历史结果追认PASS。

## 现场与证据

Demo D:/workbench-demo/p0411-20261020T040805Z保留；本轮目录project-progress/p0411-go-execution-20261020包含授权、开发wrapper、配置/stage、raw CLI、身份导出、批准测试、原生Review事件、留存哈希、全部Job停止及独立报告，禁止上传整个project-progress。开发准备wrapper90s超时安全停，与产品调用统计分开，不记委派PASS。

后续继续由OpenCode有限实现、Codex审核；当前Go开发/产品路由仅按Owner明确授权，不改用户环境默认Free。保持HEAD/index及范围外dirty，历史9/26项不动。阶段文档由Codex按已有隔离归档授权精确提交审核分支，不合并main。