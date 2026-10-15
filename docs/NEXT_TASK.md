# 下一候选 — LAYA-COMPAT.1 官方 action 元数据兼容单点

更新日期：2026-10-15。唯一事实与阶段结论见 [PROJECT_BASELINE.md](PROJECT_BASELINE.md)。当前LAYA-DECISION.1为BLOCKED，不重开已通过的缓存/health工作。

## 独立已证实

用户允许最多4次本地LAYA推理、每次90秒、仅合成demo、失败即停。实际POST=1，首个中文分类被现有provider以DECISION_SCHEMA拒绝：0.3.21返回action:{act_probability:1}，readChoiceParameters把该官方元数据当作必须为字符串的任务参数。真实raw work_kind=implementation不等于validated分类；英文/计划/pair余3项未运行，无重试。真实offline English/multilingual加载与GET通过，结束Job空/owned清理/服务停止。产品原生Agent会话累计仍5/5。
本机安装包laya/agent.py与GitHub MCP官方v0.3.21固定tag（6ab71fb4ce6bfd6f189e9b689eaadd67103ed9b6）确认元数据形状，捕获响应离线回放复现。证据保存在ignored project-progress/laya-decision-evidence.json，不进Git，不改audit。

## 最小实施候选（本轮尚未授权）

复用src/decision/laya.ts、既有DecisionAnswer与tests/decision.test.ts；先读所有参数消费者/测试，核对action与任务参数命名是否冲突，再按官方0.3.21协议最小接入元数据。保留未知对象/数值任务参数拒绝和现有答案空间/概率校验，不字符串化或跳过所有未知字段。若必要对action结构校验，仍限此边界；不新增provider/manager/router，不改Python包、权重或默认Agent。
由OpenCode bounded implement、Codex独立审查，默认首轮+最多一次返工。至少运行typecheck、decision与initial-assignment-decision定向套件；新增hermetic捕获协议回归与非法任务参数负例。修复不自动许可再发真实推理请求，需确认新的有界验收范围后执行；不重跑完整live-decision-check（其默认不止4条请求）。

## 状态与结束动作

工程估算保持68/100（100权重分母，非测试数；界面约70/30只是取整），PARALLEL_WRITE=CLOSED，正式前端未进入；temperature置信度校准P2保留。后续真实工具、动态额度与更广接力/完整用户链仍未验收。结束更新基线/受影响文档和本机进度页，精确审核后上传Git快照；project-progress、cache、audit不入Git，main/shared index/其他dirty内容保持。
