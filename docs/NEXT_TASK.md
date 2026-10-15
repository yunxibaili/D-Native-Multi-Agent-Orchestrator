# 下一候选 — LAYA-QUALITY.2 最小真实资格过滤验收

更新日期：2026-10-15；当前事实只见[PROJECT_BASELINE.md](PROJECT_BASELINE.md)。

## 本片已完成

LAYA-QUALITY.1已由OpenCode首轮实现并获Codex独立PASS：无ready任务时不再提供continue，复用现有候选/观察/验证入口；本轮只做hermetic与历史捕获回放，没有新增模型推理。历史ACTION.3的真实目标完成缺口仍保留，不能将候选过滤当作模型质量已改善。当前累计本地11次/产品5次，工程估算68/100，并行写CLOSED。

调研结论采用“按当前状态过滤模型可见动作”，只参考[官方动态工具方法](https://docs.langchain.com/oss/python/langchain/agents#dynamic-tools)，不引入LangChain或第二套调度。GitHub MCP成功核对[同版本LAYA基准边界](https://github.com/NandhaKishorM/laya/blob/6ab71fb4ce6bfd6f189e9b689eaadd67103ed9b6/docs/benchmarks.md)与官方evals；typed-decisions专用权重面向四种合成业务流程，不据发布方成绩推断Coding验收可用，不下载或切换权重。

复用boundActionCandidates与现有observation.ready：仅在有ready子任务时提供continue，始终保留wait/abort及每个有材料的明确complete目标。请求构造与候选表同次冻结，provider等待期间的状态变化不能补授未提供的key；最终资源/quota/fixed/session/停止门保持。无acceptanceMaterial的旧11动作路径不变，不强迫模型完成任务，也不把ready当实际准入。

Codex独立typecheck及decision429/0、state-loop276/0、CLI98/0、workbench419/0、协作96/0、计划61/0、阶段材料47/0全部exit0，三份源码/测试在验证前后hash稳定。内存负控撤去ready条件后264/12、exit1，未修改源文件；三份历史真实响应离线回放：两个ready为空的旧continue被拒且dispatch0，有ready的旧continue仍可进入受控dispatch；不是新模型选择或准确率。

原生laya.evals_cli validate通过官方同版本12行公开fixture（exit0）；仅证明格式/解析器复用，不是Coding样本标签、模型运行或准确率。没有建设新评测框架，没有用上游分数代替本项目结论。

## 最小下一任务（尚未授权真实调用）

下一候选LAYA-QUALITY.2：只在新增明确推理授权后，运行一次冻结的最小资格过滤验证，不重复大组试验。不改阈值/温度/模型，不用强制complete求通过；多个合理目标以接受集合记录，wait/abort如实保留，缺材料不得完成，有ready才允许continue。先离线检查请求与材料可见性，再提出精确次数/每次时限/失败即停范围；当前不启动任何新推理。

未来只验证必要事实：无ready时不能出现continue，无交付时不能完成；有材料时可选择的每个目标均明确绑定，选择任何合法目标只验证其自身，不指定“必须第二个”。完整材料可见与动作有效分开检查；wait/abort不是自动失败，不伪造唯一标签，不把受控答案当实际选择。不自动重跑原来三例；新调用前先给出可复核的固定输入和精确上限。

## 保留边界

本轮LAYA/产品Agent推理均0，未启动服务；累计本地11次与产品会话5/5不变。历史LAYA-ACTION.3仍BLOCKED（正向目标完成NOT OBSERVED），本片仅候选资格/受控闭环独立PASS；真实判断质量、完整round/工具/费用未认证。english512/192、multilingual1024/256的文案P2已纠正，统一保守512拒绝逻辑不变，保留支持范围限制、温度校准P2及旧B45负控维护P2。估算68/100、PARALLEL_WRITE=CLOSED，正式前端未进入。

每轮只读audit，维护唯一基线并刷新ignored页面，再精确审核上传；页面/cache/audit/本机证据不入Git，main/共享index/其他dirty保持。本片结束，不自动进入新阶段。
