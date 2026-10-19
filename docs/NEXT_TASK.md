# 唯一下一任务 — P0-4.0 真实闭环执行范围准备（只读，待Owner转交）

P0-1/P0-2/P0-3按各自既定有界离线范围PASS，见PROJECT_BASELINE.md §7.49。P0-3c.1单次受控116/0、实际exit0、outer Job空；真实MVP仍PARTIAL，不能把离线fixture提升为产品原生验收。

## 唯一优先目标

由OpenCode辅助只读整理一次极小真实闭环的准确执行条件，Codex独立审核后由Owner另行授权。此步骤不开发、不测试、不启动服务或模型、不修改Demo。

读取README最短流程、当前round-cli参数与默认监督路径，以及D:/workbench-demo现有配置（如无该目录则报告，不创建）。提取当前指定Worker/Reviewer完整ID、LAYA配置、精确产物路径/allowedScope/批准测试命令、stage材料与计划绑定、Review真正执行deadline及最终Human Gate路径。旧文档状态陈述与当前源码冲突时列明，事实以唯一基线和当前实现为准，不开展文档翻新或生产修复。

## 必须返回

- 一条可复核的无推理stage-check命令和随后拟执行的完整Round命令；只写命令，本任务不执行。
- 有限两任务职责：实现允许必要自测，独立测试消费精确产物；经同一P0-1完成门禁和P0-2正常自动流转，异常交人工，原生Review后最终Human Gate，NONE保持。
- 一次性授权表：两个Worker和一个Reviewer的模型/原生会话数、LAYA POST硬限、执行/启动deadline、允许的原生内部重试、禁止任务级重试/换模/接力、数据范围、零新增付费证据及清理要求。预算是建议不是已经授权，无法由现有CLI可靠实施时写明具体缺口。
- 当前证据已知/未知/不可用分开。不得从free名称、目录存在、认证文件存在、旧模型调用或离线PASS声称当前可调用/免费；不读取凭据、账单文件或做试推理。缺账户事实只列最少Owner确认项。
- 如确需官方价格/外部工具契约更新，列出1–4个精确问题供Owner转交Gemini；不自行盲试或无限检索。

## 边界

不修改任何文件，不运行测试/typecheck/模型/Agent探针，不启动LAYA/Worker/Reviewer，不安装、升级、读密钥、改配置或执行Git写操作。保留dirty tree；audit只读，正式前端未授权。若发现必须修改生产代码，报告准确入口后停止，不自行返工。

最终仅交READY/BLOCKED准备报告、命令、一次性授权清单与未知项；READY不是真实E2E PASS，也不允许自行启动。Codex另行审核，不重复测试。
