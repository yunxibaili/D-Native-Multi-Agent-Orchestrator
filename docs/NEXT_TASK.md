# 唯一下一任务 — P0-4.16 最终答复与原生退出机制离线核对（待有界授权）

依据PROJECT_BASELINE.md §7.76，P0-4.15为PARTIAL：模型82.074s输出JSON pass、82.168s发出turn.completed，但实际运行90.108s超时，accepted verdict=null。此前及本次连续两次Reviewer超时，停止真实验证；费用窗口和单次额度均已结束。旧Round/Human Gate保持PARTIAL/待人工，不回填结果。

## 唯一优先范围

仅复用保存的原始JSONL、安装版/固定官方源码和现有adapter/runtime调用链，定位两项直接缺口：

1. 最终答复的可信采集：当前Codex JSONL agent_message无phase，所有消息进入noteText/TailBuffer，过程说明与最终JSON混合。核对官方--output-last-message的实际版本支持、写出时机、唯一owned文件和生命周期，以及与RunResult身份/退出状态的关联。不得用正则抽JSON、抓最后花括号、读取私有rollout作生产通道或放宽严格normalize/validate。
2. turn.completed后的退出：本次回合完成后7939ms仍未自然退出。核对native exec终止、后台任务/连接关闭、stdin/流读取与Runtime等待路径。不能仅凭turn.completed、文件存在或模型pass将timed_out改为succeeded，也不能跳过Job安全停止确认。

不开展第三次同条件Reviewer试跑，不增加90s、不换模型/effort、不改prompt碰运气，不启动Worker/LAYA/Round/开发Agent。当前不授权实现或新增测试；若源码核对确定最小修复，再由Owner批准范围，沿既有OpenCode开发/Codex审核分工，并核实新的开发模型费用事实。

## 本轮已知证据

Task tsk_53fc5683131b44e1b7dc；Session 01a15839-274a-7083-9e9c-d337b003d6c5；gpt-6.1-sol/high/read-only。进程局部-c关闭Apps/node_repl/github，MCP诊断0，目录刷新超时1；单样本不作因果归因。原始事件、最终消息诊断、调用参数、时间线及两层Job证据见project-progress/p0415-review-local-connections-20261020/。全部Job final0、cleanupFailures0；旧产物/默认latest结果/全局配置未动。任何后续修改都不能覆盖这些失败事实。

官方最终消息出口参考（本轮沿用已读资料）：https://learn.chatgpt.com/docs/developer-commands?surface=cli 。具体安装版退出原因仍未知，必要时按既有协同规则给Gemini精确检索单；不采用无依据配置开关。
