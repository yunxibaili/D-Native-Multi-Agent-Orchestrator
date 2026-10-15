# 下一候选 — LAYA-QUALITY.1 最小领域验收方案

更新日期：2026-10-15；当前事实只见 [PROJECT_BASELINE.md](PROJECT_BASELINE.md)。

## 当前实测结论

LAYA-ACTION.3 实际3/3本地请求仍选择continue，原生输入分别494/278/276 tokens；同一实际tokenizer回放确认三例状态均完整可见、材料字段存在、候选可区分，零state截断。生产provider/loop与守卫正确接收合法答案，complete调用0、Task状态未变，受控dispatch均拒绝真实执行；协议/安全/输入可见性通过，正向目标完成仍NOT OBSERVED，因此本片整体BLOCKED。不能据三例断言模型普遍不可用或确定其选择根因；也不能再以本轮材料缺失解释结果。
同owned服务固定revision55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851、English/multilingual实际CUDA、CPU fallback0；结束validated Job ActiveProcessesFinal0、owned根已删、cleanupFailures0、health端口不再监听。3次许可已耗尽，不追试；累计本地真实11次（历史1+4+3+本轮3），产品Agent仍5/5，本轮产品/云模型调用0，源码/测试/安装/配置改动0。
LAYA-CONTEXT.1代码独立PASS保持，不能把未完成真实目标验收理解成修复无效；这3次结果不足以认定LAYA整体不可用，也不能从confidence发明一个可靠阈值。

## 已调查的复用方向

只读GitHub MCP成功核对官方同版本README Honest limits、staged-adoption与evals：官方自述基础权重在其typed-decisions任务域表现有限，建议shadow/审定标签/独立留出评估后再放行；这些上游结论不是本项目准确率，也不证明本次continue的因果原因。本机evals是已存在的模块文件，不是目录；原生JSONL校验/评价可复用，不安装新依赖。CrewAI quickstart含_DemoAgent关键词/mock回退，未执行、不能当真实模型成功证据。
- [官方同版本分阶段接入](https://github.com/NandhaKishorM/laya/blob/6ab71fb4ce6bfd6f189e9b689eaadd67103ed9b6/docs/staged-adoption.md)
- [官方同版本evals格式与校验](https://github.com/NandhaKishorM/laya/blob/6ab71fb4ce6bfd6f189e9b689eaadd67103ed9b6/docs/evals.md)
- [官方基础权重限制](https://github.com/NandhaKishorM/laya/blob/6ab71fb4ce6bfd6f189e9b689eaadd67103ed9b6/README.md#honest-limits)

## 最小下一任务（候选，尚未实施）

下一候选LAYA-QUALITY.1：复用本机已安装laya.evals.py及原生validate/compare能力，先限定一小组领域验收样本和可独立核对的标签；多合理答案/保守行为或证据不足单列unknown，不把两个都可完成的任务硬指定其中一个当唯一真值。先调查/冻结输入、问题含义和接受标准，离线验证格式及已有捕获记录；不新建评测框架，不自动增加推理、调温度/阈值、下载新checkpoint、微调、改决策脑或用规则偷偷代替LAYA。若需新调用或实现，另行明确范围授权。
先选6–8个足够小、能由独立事实判断的代表样本，明确什么是材料充分、缺失、矛盾与待执行。只有存在唯一审定标签的样本进入原生单标签准确率；两个都可完成、wait/abort可合理保守等保留shadow记录和接受集合，不为凑分数指定目标。覆盖真实问题含义而不是暗示模型选择complete；冻结问题/候选/材料/评判规则，确认现有输入窗完整可见，原生validate只校验格式，不运行模型。

优先使用已有捕获响应做可复核比较，区分接口正确、材料可见、动作效果、模型判断质量。审定方案后才提出一次有明确调用上限的对比验收；不建设排行榜/新服务/监控平台，不以小数据校准或微调作为已授权工作。没有产品实现需求时不启动worker；如发现实际代码缺陷，再给OpenCode限定任务。

## 保留边界

统一512拒绝策略与多语言实际1024配置的注释P2、旧B45负控P2和温度P2保留。PARALLEL_WRITE=CLOSED，复杂参数动作、真实完整round与正式前端未验收，工程估算68/100不变。每轮只读audit，维护唯一基线并刷新ignored页面，再精确审核上传；页面/cache/audit/本机证据不入Git，main/共享index/其他dirty保持。
