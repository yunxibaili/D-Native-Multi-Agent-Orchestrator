# 唯一下一任务 — P0-4.17 独立最终答复出口最小接线（待有界授权）

P0-4.16只读核对完成（PROJECT_BASELINE.md §7.77）。官方-o适合分离最终答复，但固定官方exec在thread/unsubscribe与client.shutdown后才写文件，不能单独解决退出超时。本机stdin无开放写管道证据，不加close补丁；TIME_WAIT/Job/socket或telemetry根因未确立。当前不授权源码实施/开发模型/真实Reviewer/新Round。

## 唯一候选实施范围

仅为现有结构化Codex Round Review接入官方--output-last-message，复用现有extraArgs、文件资产和严格normalizeReviewOutput/validateReviewVerdict：

- 宿主创建独立、唯一、owned的本次文件位置，绑定本次Review/Run身份，不接受预存/旧文件、越界/重解析路径、空/非法或超量内容；保留原始JSONL与过程说明作为事件证据。
- 只有现有运行实际succeeded、可信退出和Job停止均成立后读取该最终文件；读/写失败必须明确拒绝。文件存在、turn.completed、模型pass都不覆盖timed_out/failed。
- 禁止正则抽JSON、取最后花括号、生产读取私有rollout、放宽schema、回填旧Round或改变原生停止/任务状态权威。其他Agent和非结构化Review兼容路径保持。
- 有界实施时确认最小adapter/Review/资产生命周期接线位置，不新建通用输出平台、Runtime、Planner或Scheduler；不顺带修CLI重复--extra=解析或增加其他功能。

## 暂不实施的退出问题

保留P0-4.15最终JSON82.074s、turn.completed82.168s、运行90.108s超时及7939ms尾段事实。固定源码有unsubscribe/shutdown异步等待，内部常量45s，但不能与安装版字节对应，不能据此扩大90s或添加猜测grace。需版本对应源码/既有日志才能定位本机具体卡点；没有新模型试跑。

Owner批准有限实现范围及有效开发费用事实后，仍由OpenCode实施、Codex独立审核；最多一次实现加一次有据返工。遵守默认零新增测试和禁止重复验证规则，实施验收范围需与授权一致。当前不继承过期Go/Reviewer费用窗口，不启动第三次相同Reviewer验证、Worker/LAYA/Round。

资料与源代码行号：project-progress/p0416-final-output-source-review-20261020/assessment.json（ignored）；官方非交互文档https://learn.chatgpt.com/docs/non-interactive-mode 。P0-4.16只读核对完成不等于真实Review/E2E PASS，9/26项历史边界保持。
