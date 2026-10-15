# 下一候选 — LAYA-BOUNDARY.1：收敛决策与验收职责

更新日期：2026-10-15；当前事实只见[PROJECT_BASELINE.md](PROJECT_BASELINE.md)。

## 当前独立结论

LAYA-QUALITY.2真实验收BLOCKED（安全弃权，非错误完成）：用户明确新增最多2次本地调用后，首例实际选择wait，两个任务均保持to_verify、complete/dispatch各0。原生English输入465 tokens，与固定tokenizer预检一致且材料零截断；正向目标完成仍NOT OBSERVED。按fail-stop仅用1/2即停止，矛盾材料第二例NOT RUN，未重试、未改答案；不能据此断言LAYA普遍不可用、候选过滤无效或确定等待根因。

同owned服务健康事实为固定revision55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851、English/multilingual实际CUDA、CPU fallback0；raw响应自身无revision，不补造。唯一validated Job记录ActiveProcessesFinal0、stopConfirmed=true、owned根已删除、cleanupFailures0。独立blocking connect明确ECONNREFUSED；最初connect_ex返回10035（WSAEWOULDBLOCK），未作为端口关闭证据，随后仅修正观察方法，没有重启服务或新增推理。10个缓存文件size/SHA256及209个可版本文件在维护文档前均不变。

本轮真实1POST+同服务1次健康GET；本地累计12次（历史11+本次1），产品Agent仍5/5，本轮产品/云模型/新增付费0。实际harness exit1是正向完成未观察后的fail-stop，非协议异常；provider/loop合法接收wait，未调complete或派发。首例未完成后本次授权关闭，未消耗的1次不自动重用。无生产实现/测试/native/安装/配置改动，不为本片重复typecheck/fullsuite；并行写CLOSED，工程估算68/100保持。温度校准警告保留，confidence不作质量或硬门保证。

## 最小下一片（只读建议，尚未实施）

下一候选LAYA-BOUNDARY.1为只读职责收敛：基于官方“typed decision不等于执行许可”和shadow/unknown方法，保留四项已真实通过的分类/计划/具体pair接口，沿既有Verification/Review/HumanGate核对完成事实由谁认证、当前请求含义是否与模型适用范围一致。先提出复用现有证据权威的最小方案，不新增大脑/框架、不让wait默认变complete、不改模型或温度，也不再盲目追加同类推理。此为建议，尚未实施；如需改生产行为另行限定任务，任何真实新调用另行明确范围。

先回答三个实际问题：已有Verification/Review/HumanGate掌握哪些可验证事实；LAYA在哪些任务只负责候选动作而不充当测试裁判；能否复用已有路径让安全等待停在明确用户检查点，避免自动误报成功或新增模型实验。引用官方同版本职责边界，沿真实调用链给出最小改动建议与现有可复用入口；不先写新manager/selector/评测框架。

尚未证明矛盾材料会被真实拒绝；不将受控测试或第二例离线准备提升为真实证据。新的真实调用需要明确授权，当前不申请继续重跑相同样本。不授权新Agent/云模型/收费/下载、并行写或正式前端。
