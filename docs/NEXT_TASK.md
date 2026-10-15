# 下一候选 — LAYA-ACTION.2 真实本地动作目标验收准备

更新日期：2026-10-15；事实/裁定只见 [PROJECT_BASELINE.md](PROJECT_BASELINE.md)。

## 已独立通过

LAYA-ACTION.1代码PASS，整体PASS WITH P2（既有B45负控定位失效）。OpenCode session ses_ec1c29b31ffe8q90kxh7SMjS03实际指定DeepSeek V4.1 Flash，首轮正常finish=stop；只改decision-loop/state-loop/b40a三文件，Codex独立审查与typecheck、decision429/0、state-loop198/0、CLI93/0、workbench419/0、协作96/0、计划61/0、阶段材料47/0通过。独立内存负控强制改为第一个目标，3个新断言失败/exit1，源文件未改。b40a的完整CLI链使用真实provider与原生形状受控响应，不再提供生成taskId/parameters；执行端/答案仍是fixture，不是真实模型验收。
workflow有acceptanceMaterial时基本continue/wait/abort与complete具体目标同次形成候选表，按membership映射，多个目标不同key、单目标描述/表明确绑定；不默认任务。未知key/矛盾与额外目标参数拒绝，缺执行/criteria或空输出无完成候选；材料存在不等于语义/文件物理认证。旧无material的11动作/参数契约保留。复杂自由参数动作未原生收口，不宣称已全部可用。

## 下一步先准备，不自动推理

复用当前provider/decision loop与D:/AI/laya-cache固定离线服务，为少量真实next_action选择准备明确合成状态/同任务材料（包括至少两个不同to_verify目标），检验实际所选key能够映射明确目标、缺交付不会被接受。只使用新的内存任务/demo，不提交现有仓库代码或凭据，不调用产品Agent/云模型、不新增付费；记录真实checkpoint、响应、结果和Job退出。模型选wait/abort应如实记录，不能强制改答案或重试到通过。此文不授权POST；实际请求数/90秒期限/失败即停须由用户新确认，现有本地4次已用完、产品原生仍5/5。
若要直接进入完整round，先按laya-round-budget.json复核预算：理想两步8次本地决策不是硬cap，条件对应上界13；产品执行/可支持Review/辅助CLI与原生内部费用另计，不绕过unknown availability/quota或伪造免费事实。无需新建runner/manager/第二大脑；没有新功能开发需要时不启动worker。

## 维护项与边界

B45旧负控匹配'|| groupRuntimeIncomplete;'，本片父快照def22fb已有不匹配且CLI未改；worker报告103/1，独立静态归因确认，列P2另行限定测试维护，不混入本片或回退安全门求绿。两个worker自建临时hook已按时间/内容确认后按名清理。历史foreign审计/临时文件未动。
温度校准P2、PARALLEL_WRITE=CLOSED与正式前端未进入保持；工程估算68/100（界面70/30取整）不按测试数量增加。每任务只读audit，结束更新唯一基线/受影响文档与本机页并精确审核上传；页面/cache/audit/本机证据不入Git，主HEAD/index/其他dirty内容保持。
