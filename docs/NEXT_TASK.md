# 下一候选 — LAYA-CONTEXT.1 决策输入可见性收口

更新日期：2026-10-15；当前事实只见 [PROJECT_BASELINE.md](PROJECT_BASELINE.md)。

## 本轮结论

LAYA-ACTION.2 本轮真实3/3本地请求均选择continue，生产provider/decision loop解析和受控拒绝通过，未调用complete、任务状态未变；因此明确目标的正向验收NOT OBSERVED，整体BLOCKED。离线同tokenizer/build_sequence复算确认双目标state701 tokens只保留318、丢383，acceptance_material整段不在模型输入；五个选项marker和token span仍各自独立。此为证据可见性P1，不能仅据此断言三次continue的根因。服务已停/Job空/owned清理通过，固定缓存10文件摘要不变；无产品Agent/云模型/新增费用/生产修改。

## 建议的最小切片（尚未授权实施）

下一候选LAYA-CONTEXT.1：先调查本机0.3.21实际编码预算与已有有界上下文能力，限定最小workflow输入压缩和超限拒绝方案；确保每个可完成候选的同任务criteria/output可进入实际输入，不能只把材料移到前面而截掉另一目标，也不靠放大checkpoint max_len、改温度、换模型或新建框架求通过。实施及新真实推理另行授权；本轮3次已耗尽、产品原生仍5/5，失败不重试。

先只读本机0.3.21的_encode_state/build_sequence、固定配置、生产decision-loop/toDecisionState/material投影及所有workflow调用者，再核对官方同版本处理方法，复用已有有界材料/候选工具。明确每个候选最小必要字段和被保留的字节/token；不能只检查请求JSON有材料，不能把客户端字符上限当模型上限，不按完整marker就推断完整证据可见。

如需实施，由OpenCode限定修改共享workflow请求构造与必要hermetic回归，Codex独立检查原生编码预算、同目标材料、未知/超限fail-closed以及旧通用参数入口兼容；不新建Tokenizer服务/manager/第二调度，不强制模型选择complete，不以fixture代替下一轮真实选择。具体方案和允许文件先调查后确定；新真实推理仍需单独明确次数。

## 保留边界

本轮3次许可已全部使用；累计本地真实8次（1失败+4通过+3本轮），产品会话5/5未增加。旧目标桥接代码和四预设独立PASS保持，动作正向选择仍待验证；B45旧负控与校准P2保留。PARALLEL_WRITE=CLOSED，正式前端未进入，工程估算68/100。

仅文档/本机验收产物更新，无产品实现、配置或依赖变更；不跑fullsuite。每轮只读audit，刷新ignored本机页后精确审核上传；页面/cache/audit/本机证据不进Git，主HEAD/index/dirty保留。
