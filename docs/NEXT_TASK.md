# 下一项 — MVP-E2E.1：明确新调用范围后的一次真实最短闭环

更新日期：2026-10-15；事实与授权仅见[唯一基线](PROJECT_BASELINE.md)。

## 本片已完成

LAYA-HEALTH.1独立PASS（无推理、非常驻）：Windows监听查询成功且8077无listener，生产Node TCP立即ECONNREFUSED、provider健康探测ok=false。因此当前就绪缺口是没有服务在该端口监听；前轮Python的2秒超时保留为当时观察，不作为服务卡死或模型故障的证明，也未追定Python观察差异的原因。无需据此改协议、重装或换权重。

按已说明范围仅启动一次owned contained服务，复用现有LAYA0.3.21及D:/AI/laya-cache固定revision55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851；离线预加载english/multilingual，startup等待上限90秒，唯一进入本轮服务的请求是GET /health，无POST/推理。生产provider.probe返回ok=true；两checkpoint实际cuda、device_is_preference=false、两revision正确、CPU fallback计数0。该健康结果不证明真实决策质量或完整round。

检查后主动协同停止：validated Job记录terminated/ActiveProcessesFinal=0、stopConfirmed=true；owned根已删、cleanupFailures0；随后独立Node连接为ECONNREFUSED。服务未保留常驻，这是本片预定清理，不是健康恢复又失败。10个已下载权重/tokenizer/config文件size/SHA256前后不变，209可版本文件在文档维护前raw hash不变；无安装/升级/全局或Agent配置修改、无foreign进程终止。

## 下一项的必要输入

下一项是MVP-E2E.1：在新增明确调用授权后，用新建隔离demo验证一次真实CLI最短“实现→测试→显式用户验收→原生Review→HumanGate”。先冻结worker具体Agent×Model、reviewer入口/模型与费用、用户输入方式、本地POST/原生会话上限及失败即停条件；不能把两次worker算成全部调用，也不能自动返回accept冒充用户看过产物。当前产品5/5已用完，未开放任何新推理；模型免费资格/Review费用未知就停止，不通过删Review或伪造available跑通。需要服务时复用本次已验证的owned启动/结束路径，不建设新的常驻机制。

最小候选仍是README的两步计划，优先保留既有固定pair、阶段digest、用户checkpoint与最终Review。须明确实际用户如何在看到各步证据后给accept/stop，不能用fixture预设答案冒充真实人工验收。成功路径至少两次worker加一次Review；本地LAYA与原生Agent各自有独立计数/时限，health GET不是推理。准备不得读取凭据内容或写本机Agent配置。

本轮本地LAYA推理0、产品Agent会话0，累计本地12/产品5/5不变，旧fail-stop余次不重用。B4.6b人工兜底受控PASS、历史QUALITY.2真实wait/BLOCKED及完整自动质量缺口保持；健康成功不增加工程信用。PARALLEL_WRITE=CLOSED，正式前端未进入，估算68/100。未跑typecheck/fullsuite/旧真实推理脚本；源码/测试/native/runner未改。

本轮停止于健康路径独立验证与文档/页面上传；不自动调用真实模型，不把此文档当新增费用授权。
