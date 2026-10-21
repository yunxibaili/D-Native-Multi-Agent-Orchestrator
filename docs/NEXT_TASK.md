# 唯一下一任务 — 候选计划草案入口的有界离线实现（待Owner批准）

Owner允许先做不依赖真实调用的其他工作。§7.87的离线路线文档对齐与源码映射已经完成；本页提出下一实施片，不是已获开发/模型/测试授权。P0-4.23继续保持BLOCKED，旧真实调用窗口不复活，不绕过执行环境拒绝。

## 已完成的离线准备

PRODUCT_DIRECTION与BACKEND_DELIVERY_PLAN已纠正“P0-1仍未实施/自动推进尚未实现”的过时表述；P0-1/2/3仅继承基线的有界离线PASS，完整真实闭环不提升。原始需求、26项历史失败边界和Windows正式桌面路线保持。此次没有开发、测试、模型或前端工作。

## 下一片最小目标（提案，未实施）

给现有CLI增加一个独立、显式的候选计划准备入口：一句需求→已适配Agent返回2–3个短PlanFile JSON候选→既有解析器校验→输出待人工核对的草案后退出。该命令不派发草案任务、不调用LAYA、不生成批准/confirm，也不自动运行测试或进入Round。

未来调用生成Agent仍需独立的当前模型、费用、数据和时限授权；开发会话也不继承过期Go声明。OpenCode为主要实现者，Codex独立审核。此次只准备接点，尚未委派。

| 现有文件/入口 | 实际接点与最小复用 |
|---|---|
| src/cli/index.ts:169、src/cli/round-cli.ts:1075 | 准备步骤独立于runRoundCli；不能在Round已经确认后生成计划，stage-check保持无推理 |
| src/orchestrator/orchestrator.ts:180、src/core/types.ts:218 | 复用Orchestrator.run及RunRequest/RunResult、既有deadline/原生执行/contained清理；不新增运行时 |
| src/orchestration/plan-file.ts:55、194、357 | 复用parsePlanFile和CompletionContract；新入口只收2–3候选，保留5候选/6步/64KiB/单文本400字符既有上限；拒绝截断、非法或不完整结果 |
| src/cli/round-cli.ts:1323、1416、1431 | 草案定稿后才经既有计划冻结、stageBindingDigest、stage-check/confirm；草案不批准自身 |
| src/cli/round-cli.ts:2185、src/decision/plan-choice.ts:81 | 后续Round由现有choosePlan/decideWorkflowPlan在获批候选中选择，沿原planWithCandidates/TaskStore执行；不新增Planner |

两个直接注意点：

1. parseStep将原始expectedArtifacts/allowedScope/test变成内部completion。不能把内部解析对象直接序列化回外部plans.json；必须保持既有原始文件格式，并只消费校验结果，不把模型任意字段并入配置/授权。RunResult的outputTruncated、退出及停止事实也不能忽略。
2. 原两任务固定单计划流程为3次LAYA POST；多个候选再由LAYA选择会多一次，静态推导需要4次。不能暗增原3次上限，生成Agent会话另计。若未来获准真实实验，必须把这些新增调用列入授权和stage digest，不挪用旧预算。

## 实施和验证边界待确认

建议只接sequential草案，复用已有JSON结构，保持现有Round/Review/Verification/TaskStore及所有隔离保护。具体新增CLI名称/输出参数须实施前沿用代码风格，不将提案写成已存在功能。不新建models.yaml、工作流引擎、通用上下文平台或正式UI。

默认只做typecheck和diff审查；没有新增/修改/运行测试的授权，不新建临时验证脚本，也不调用真实生成模型验证。若后续需要定向测试，须先取得该单文件的明确范围。所有模型调用与外部工具写操作按各自授权，不以本页代替。

P0-4.23另行等待既有Issue54463反馈或执行环境支持的解决方式；已批准的单条评论已发，不自动重复发言、重试真实命令或修改安全规则。代码与文档阶段归档由Codex负责，主HEAD/index/范围外dirty保持，project-progress/audit不上载。
