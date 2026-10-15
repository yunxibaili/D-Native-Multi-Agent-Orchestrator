# 下一候选 — LAYA-DECISION.2 修复后真实本地四项验收

更新日期：2026-10-15。唯一事实与阶段结论见 [PROJECT_BASELINE.md](PROJECT_BASELINE.md)。

## 已完成

LAYA-COMPAT.1由OpenCode（原生session ses_ec1f589bcffeXS1cuOTqhUA44l，实际opencode-go/deepseek-v4.1-flash）首轮实现，Codex独立PASS。只改src/decision/laya.ts与tests/decision.test.ts：可选action元数据在choice/score/noul共用边界校验，act_probability有限[0,1]；元数据不进入任务参数、不覆盖编排动作，raw保留；无action旧响应和字符串任务参数兼容，未知对象/数字任务参数仍拒绝。独立typecheck、decision429/0、initial-assignment-decision37/0、state-loop169/0通过。同一完整捕获JSON经修复前/后provider对照：前者DECISION_SCHEMA/action，后者正确分类、raw不变、无action参数；纯内存回放network=0。
这不是重跑真实推理；前轮LAYA-DECISION.1实际1/4后停仍保留历史BLOCKED。无新增产品Agent会话、无新服务启动、未改Python环境/权重。

## 下一有界候选（需另行授权真实本地推理）

建议明确授权最多4个新的本地POST（不是自动花前轮未用额度）：中文分类1次、英文分类1次、两个工作流候选选择1次、两个合成Agent×Model候选选择1次；每请求最多90秒，失败立即停止，不自动重试。只使用D:/AI/laya-cache现有固定revision55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851英语/多语言权重，HF离线；不发送现有仓库代码/凭据、不启动产品Agent/云模型、不新增费用、不调用真实Skill/MCP。
直接复用既有provider/routing/plan-choice/initial-assignment与contained服务/健康/退出确认。只针对修复后结果/metadata与实际checkpoint/健康revision取证，不新增框架/manager、不开常驻服务；输入候选available仅合成测试事实，不认证真实账户可用性/免费。完整记录成功/失败/未运行，停止服务并验证Job空/owned清理。不得直接跑完整live-decision-check（它超出四项范围）；typed API兼容不是最优选型质量/Token收益或整条生产CLI验收。

## 持续边界与收尾

产品原生Agent会话累计仍5/5，本地LAYA授权不自动追加产品额度；PARALLEL_WRITE=CLOSED，正式前端未进入。温度校准P2仍保留；真实工具、动态额度、完整批准/监督与更广接力仍待后续。工程估算68/100（100权重分母；界面约70/30为取整）不因修复或测试数量增加。
每任务先只读audit，完成后更新唯一基线/受影响文档与本机进度页、精确审核Git快照；project-progress/cache/audit不入Git，主HEAD/shared index/其他dirty文件保持。无需开发时不为运维取证启动worker。
