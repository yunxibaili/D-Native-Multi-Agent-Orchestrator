# 后端交付路线 — 先完成一个真实闭环

更新：2026-10-16。定位见 [产品方向](PRODUCT_DIRECTION.md)，全部需求见 [需求全集](BACKEND_REQUIREMENTS.md)，当前事实只在 [唯一基线](PROJECT_BASELINE.md)，唯一下一任务见 [NEXT_TASK](NEXT_TASK.md)。

## 当前路线裁定

保留全部原始需求、Windows 正式桌面工作台路线和已有编排内核；不新建 Planner/Workflow engine、models.yaml、Registry 或模型网关。本轮只更新文档；下表是实施顺序，不能据此启动模型、开发或自动跨阶段。

| 顺序 | 有界交付 | 复用入口 | 进入/完成条件 |
|---|---|---|---|
| **1 / MVP-E2E.1d（待下发实施）** | 检查点来源修复；首尾确认+异常中断策略；确定性路径/产物/真实测试检查 | workflow-checkpoint、round-cli、plan-file、completeTask/applyVerification | 离线负控与受影响回归通过，Codex 独立验收；不自动授权真实调用 |
| 2 / 第四次真实 MVP（尚未授权） | 隔离 Demo 的实现→独立测试→Codex Native Review→Human Gate | 同一 Round、固定 pair、原生会话、Job containment | 先通过第1项；重新确认模型/费用/次数/数据，用户批准首尾和异常策略；不得从旧调用剩余额度继承 |
| 3 / 自然语言候选准备 | 输入一句话，经现有 Agent 产生 2–3 个短计划 JSON，再由 LAYA 选择 | AgentAdapter/Runtime、parsePlanFile、plan-choice、planWithCandidates | 在计划冻结和 stage digest 之前，严格校验；生成调用另计预算，stage-check 不推理 |
| 4 / 角色与工具最小过滤 | 角色标签过滤已存在的模型/Skill/MCP 候选，再交 LAYA 选择并原生加载 | ModelRegistry/Assignment/准入、skill-choice/mcp-choice、TaskIntent/brief | 不新建目录；实际加载、调用和拒绝分别取证，目录/声明不冒充工具成功 |
| 5 / 使用反馈补齐 | 角色默认/prefer、额度与免费接力、模型掉线/部分写入恢复、多模型真实验收 | 现有 SelectionSpec、continuation、Lease/Attempt、费用池和工作区 | 按真实失败小片补齐；固定模型不静默替换，未知费用/停止安全先拒绝 |
| 6 / 正式桌面体验 | 确认正式 UI 需求，然后将已验证后端能力接入既定桌面路线 | 当前后端对外契约 | 前端需求须与用户单独确认；本机进度页不计正式 UI 进度，不擅自改成 Web 产品 |

## 第 1 项具体改动面（未实施）

| 改造 | 当前位置 | 最小方案 | 对底座的影响 |
|---|---|---|---|
| 每步强制输入/60秒与来源 | src/cli/workflow-checkpoint.ts:103、191、214；src/cli/round-cli.ts:2686、2734、2846 | 保留手动逐步模式；显式策略接入首尾确认+异常中断。系统 timeout/EOF/error 使用系统来源和类型化原因，不捏造用户 choice | 不放宽 Worker deadline、权限、停止或 Verification |
| 产物/范围/测试 | src/orchestration/plan-file.ts:66、169、284；src/orchestration/workbench.ts:1436、1445 | 少量结构化 expectedArtifacts、allowedScope、测试要求，经任务创建/brief/同 Attempt 证据接线；在 completeTask 状态迁移前统一检查 | 复用 applyVerification；声明不是沙箱，检查失败不放行 |
| 循环与终审 | src/cli/round-cli.ts:2358、2559、2846、4047；src/orchestration/unified-review.ts:566 | 同 Task/Attempt 真实结果通过后才能推进；不再用 LAYA complete 作代码质量裁判；保留最终 Native Review 的真实 verdict | 不新增调度边，不删 Review，不写假成功 |

行号对应本次只读源码映射，后续实现前重新定位。不能通过仅检查文件存在、只读 write 事件或只认进程 exit=0 代替完整验收；shell 也可能写文件。范围检查是交付核验，不能自称替代文件系统沙箱。测试证据必须关联本次真实命令、cwd、退出码和结束原因，模型自述不是证据。

无测试要求的实现任务与必须独立测试的任务应分别表达，避免把所有任务强制变为相同质量门。实现 Worker 允许必要自测；测试 Worker 必须独立读取实际成果、运行并补充必要测试，不能只复述前一任务。禁止运行后搬文件伪装按路径交付。

## 非当前阻塞的后续需求

完整需求澄清/阶段批准链、跨角色/同目标协作、免费优先、共享额度、掉线接力、Skill/MCP 实际加载、长材料引用、用户纠偏和恢复全部保留。不同功能的代表性历史样本见唯一基线；不能把 fixture、单次双模型演示或三次 PARTIAL MVP 升级为整个后端完成。

26 项既有 B5.1-WF 失败保持打开；有限豁免仅针对固定 pair/顺序/无接力的最小 MVP。新片触及其状态/停止路径时必须重新评估，不无条件扩大豁免，也不为追求全绿顺手修全部历史债务。

## 研究与验证投入

[20 项研究索引](ENGINEERING_RESEARCH_REFERENCES.md) 用于选择小机制；先复用项目实现，其次标准库和现有依赖。没有新增依赖、服务、基准集群或上下文平台计划。

下一实施任务的验证只覆盖检查点归属、确定性验收、同 Attempt、下游阻断和 Native Review 接线，并运行必要现有回归。文档任务不启动测试或模型；真实试跑只在新授权内验证已经离线证明的结论，失败即停，不反复试模型求通过。

## 完成度与维护

唯一基线保留原十项能力权重估算 68/100，未因研究和文档整理增分。它是历史规划信用，不是可用率、工时完成率或完整 MVP 成功概率；正式 UI 不在分母中，不能据此预测交付日期。

每次任务结束更新唯一基线及其 project-progress JSON → 更新受影响需求/路线/NEXT_TASK → 刷新 ignored 本机进度页 → 报告真实证据。历史讨论已保存至 [归档提交](https://github.com/yunxibaili/D-Native-Multi-Agent-Orchestrator/tree/3f2b8a8d95374f60adbf666364f7b2180cdd84dd/docs)，当前目录不继续堆叠旧规划。
