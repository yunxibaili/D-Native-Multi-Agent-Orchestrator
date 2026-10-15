# 下一候选 — 本地 LAYA 有界 typed 决策验收

更新日期：2026-10-15
当前状态、事实/证据与估算只见 [PROJECT_BASELINE.md](PROJECT_BASELINE.md)。本片LAYA-ENV.1仅缓存恢复、离线加载与真实GET健康检查独立通过，不封整个后端。

## 已完成

无需重装：既有C:/Users/Admin/laya-venv为LAYA0.3.21/Torch2.11.0+cu128。用户已明确D:/AI/laya-cache，英语与多语言固定revision55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851的10文件约1.52GB已下载并全部官方摘要校验通过；缓存加载前后均匹配。真实offline server+现有provider健康GET确认两checkpoint实际cuda、revision匹配、非device preference。三次contained Job均空/owned清理，检查后服务已停止，不是常驻启动或开机自启。
启动配置见[DECISION_PROVIDER §3](DECISION_PROVIDER.md#3-本地服务)，复用现有Python/服务/客户端，不引入manager/服务安装器/框架。typed-decisions未下载；不要默认预加载全部checkpoint或重装依赖。

## 下一有界候选（需另行授权推理）

最多4次本地LAYA请求：中文/英文分类各1次、从2个明确工作流选择1次、从2个明确Agent×Model候选选择1次。只使用新建合成demo文本，不发送既有仓库代码/凭据，不运行真实Agent/云端模型、不调用Skill/MCP、不改用户配置。复用现有routing/plan-choice/initial-assignment及响应校验；输入输出、实际checkpoint/revision、错误与耗时分开记录，不造任意DAG或第二大脑。
授权之前只读/GET，不发送POST或forward pass。当前缓存恢复授权明确“不发推理请求”，不得由已通过health延伸授权。产品原生执行会话累计仍5/5，不能用LAYA本地测试重置或追加该额度。仅typed API兼容通过也不等于主观选型质量/完整生产CLI已验收。

## 保留边界

已安装加载器报告部分choice temperature被钳制、confidence未经校准（P2）；置信度只作提示，不当硬可靠性保证，不擅自升级/调参。真实Skill/MCP、动态账户额度、完整批准/监督与更广掉线恢复仍留后续；工程估算68/100不增加。PARALLEL_WRITE=CLOSED，正式前端未进入。
本片是运维取证，不需要开发worker；授权的产品实现仍由OpenCode开发、Codex独立审核。每任务开始只读audit，结束更新唯一基线/受影响文档、本机进度页及精确Git审核快照。缓存不入Git，project-progress/audit/本机记录/页面均excluded；主HEAD/index与其他dirty文件保持。
