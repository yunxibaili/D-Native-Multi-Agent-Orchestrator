# 唯一下一实施任务 — P0-1 确定性完成门禁

更新/Owner批准日期：2026-10-16。
产品要求状态：**Owner approved / Not yet implemented / Not yet tested**。
本轮只更新文档；本文件不授权自动开始实现、开发委派或第四次真实E2E。旧MVP-E2E.1d合并切片已被拆分路线取代。

## 唯一目标

适用的编码/文件交付任务，在既有NativeWorkbench.completeTask → applyVerification链路提交Complete之前，统一核验：
1. expectedArtifacts：相对于确认的实际Workspace根，精确文件存在；demo/add.js不能代根add.js，不自动搬移。
2. allowedScope：真实增删改在批准范围内，基于本Attempt开始前快照处理历史dirty/untracked；覆盖shell修改、Windows大小写、链接/Junction，越界/归属不明失败关闭。
3. trusted test：批准的具体测试命令真实执行、实际cwd正确、退出码0且未超时，证据关联同Task/Attempt/RunResult及产物版本。模型PASS文本、总Session exit0不是证据。

编码任务缺测试要求/执行/可信证据不得自动完成；其他类型必须另有明确验收契约，不能静默放宽编码三门。必要条件通过不表示全质量已证明，最终Native Review不删。

## 调查和复用入口

| 入口 | 本片只需处理 |
|---|---|
| src/orchestration/plan-file.ts:66/169/284；现有CandidateTask/commitPlan/TaskIntent/brief | 增加必要计划字段并沿现有任务创建链传播；parsePlanFile写前校验；同一normalizedPlanScope/digest绑定新增要求，防旧确认遗漏新字段 |
| src/orchestration/workspace.ts:96/432；现有dispatch/executeTask与ResourceClaim | 取实际WorkspaceHandle.cwd；采集本次执行前后文件事实，不仅Git HEAD/status，不扫无关本机目录，不自动清dirty |
| src/orchestration/workbench.ts:1436/1445；orchestration/orchestrator.ts:786；review-loop.ts:281 | 查清全部可达pass调用；在共享完成/验证边界拒绝缺证。异步检查后，提交前同步复核当前Task/Attempt/RunResult、工作区/授权与证据版本，不能只加CLI旁路判断 |
| src/adapters/opencode.ts:418/427；src/runtime/session.ts:525/641；AttemptStore | 复用原生结构化工具证据；准确匹配命令/参数/cwd/退出码/结束原因。缺失或截断保持未知；若事件不足说明最小可信执行入口，不能用mock文本补成可信 |
| src/cli/round-cli.ts:2358、完整工作流循环及4047 | 同Attempt证据接线、机器拒绝时下游不派发；保留最终runUnifiedReview。**不在本片启用新的默认自动推进策略** |

实施前复核[研究索引](ENGINEERING_RESEARCH_REFERENCES.md)中的SWE-bench、SWE-agent、Agentless与Windows/Node文件语义；资料是方法，不等于本机安全验证。
可增加最少纯值类型/helper，但不新增Artifact平台、Test Runner系统、Workflow/Planner/Registry或Verification Authority。

## 本片离线验收（实施时执行，本轮未运行）

| 场景 | 预期 |
|---|---|
| 根add.js及批准测试命令真实exit0 | 有效同Attempt证据经既有Verification通过 |
| 仅demo/add.js或缺文件 | 不完成，不自动搬移，无下游run |
| 新增/修改/删除越界，包含原dirty文件被再次改写 | 拒绝，保存实际差异，不清理或覆盖用户原成果 |
| 原dirty文件本Attempt未改 | 不错误归因，但不自动忽略它的新改动 |
| Windows大小写/相似前缀目录、链接/Junction逃逸、物理归属不明 | 正确比较或保守拒绝，不仅lowercase/startsWith放行 |
| 指定测试exit非0/超时/未运行；错误命令或cwd；模型声称PASS/总session0 | 均不得作为可信测试通过 |
| 测试后产物再次改变或证据版本失效 | 不用旧结果认证新产物 |
| 旧/错误Attempt，身份变化，停止确认false/缺失 | 完成前同步拒绝，不迁移或放行 |
| 经LAYA complete、现有人工accept或其他可达pass入口尝试绕过 | 都服从同一适用门禁，不新增成功权威 |
| 有效实现/测试任务 | 原状态/身份/资源安全保持；受影响Review接线无回归 |

前后文件事实不是“从未发生任何瞬时越界写”的证明；原生权限继续负责执行约束，无法可靠证明的场景报告限制/拒绝，不宣称全新沙箱。测试由实际受控进程运行、断言真实退出状态，fixture不冒充真实模型。
用现有测试seam/owned临时工作区，正向+承重负控，再typecheck及受影响定向回归/git diff --check；不要求full suite，不调用真实LAYA/产品Agent/Native Review。

## 分工、范围与停止

将来Owner下发实施后，OpenCode经既有opencode-agent implement、实际模型opencode-go/deepseek-v4.1-flash完成有界改动；Codex调查/独立审核/复跑，最多首次+一次定向返工。本轮不调用该开发Worker。
不得删除reuse-first、修改原生Agent安装或全局规则、放宽目录权限、改LAYA协议/权重、TaskStore状态权威、Job containment、并行写或最终Human Gate。

**完成P0-1后停止。** P0-2才处理模型/费用/工具的整轮绑定和默认自动流转；P0-3处理系统事件/pending等待；P0-4真实调用另行授权。不自动进入后续片。
三次MVP仍PARTIAL，26项历史失败仍open，有限豁免不扩大。保持dirty tree、HEAD/index；未来上传需遵守届时Git授权。每片完成更新唯一基线/NEXT_TASK及ignored进度页。
