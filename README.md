# LAYA 本机多 Coding Agent 个人工作台

Windows 本机个人项目：用户输入需求，LAYA 在授权候选中选择计划、具体 Agent × Model 与必要工具；已有编排器组织任务、独立会话、交接、执行、验证、原生独立 Review 和最终 Human Gate。支持跨角色分工与同目标2–3模型分工共建的方向，正式产品保持 **Windows 桌面工作台路线**。

**当前尚未完成完整真实 MVP。** 第三次真实 Round 已写代码并测试2/0，但路径偏移且未获人工验收；第二 Worker 和 Native Review 未运行。下一步只做P0-1确定性完成门禁，再按依赖补预授权自动推进和异常等待，不是再建工作流引擎。

## 只看这几个入口

| 文件 | 职责 |
|---|---|
| [PROJECT_BASELINE](docs/PROJECT_BASELINE.md) | 唯一当前事实、阶段状态、证据和进度快照 |
| [PRODUCT_DIRECTION](docs/PRODUCT_DIRECTION.md) | 产品定位、保留的全部方向与 Owner 当前取舍 |
| [BACKEND_REQUIREMENTS](docs/BACKEND_REQUIREMENTS.md) | 完整原始后端需求，不因 MVP 暂缓删除 |
| [BACKEND_DELIVERY_PLAN](docs/BACKEND_DELIVERY_PLAN.md) | 最小交付顺序与现有代码接点 |
| [STAGE_ANALYSIS](docs/STAGE_ANALYSIS.md) | 为什么先机器门禁、再自动流转/异常人工介入及恢复限制 |
| [NEXT_TASK](docs/NEXT_TASK.md) | 唯一下一项：P0-1确定性完成门禁，等待下发实施 |
| [ENGINEERING_RESEARCH_REFERENCES](docs/ENGINEERING_RESEARCH_REFERENCES.md) | 原20项保留，新增Agentless/A2A/OpenAI Agents SDK；出处与核验状态 |

执行与安全契约继续保留：[架构](docs/ARCHITECTURE_CONTRACTS.md)、[LAYA接口](docs/DECISION_PROVIDER.md)、[Round语义](docs/EXECUTION_ROUND_SEMANTICS.md)、[执行证据](docs/DECISION_LOOP_EXECUTION_RESULT_CONTRACT.md)、[协作](docs/R2_COORDINATION_CONTRACT.md)。

旧历史规划/草案/调查提示已从当前目录移除（STAGE_ANALYSIS按本次要求新建为当前策略分析，非恢复历史日志），含未提交内容的完整版本保存在 [Git归档提交](https://github.com/yunxibaili/D-Native-Multi-Agent-Orchestrator/tree/3f2b8a8d95374f60adbf666364f7b2180cdd84dd/docs)。归档不是当前能力声明。审核分支只同步文档，不代表当前全部 dirty 源码已提交。

## 最短个人流程：先做无推理预检

需要现有 Node >=22.6 与已安装依赖。本节只演示当前可用的计划/阶段预检，不会启动产品模型；不是完整真实执行命令。

在项目外新建空 Demo，已有文件时另建子目录，不覆盖用户成果。以下以 D:/workbench-demo-new 为例：

plans.json：
```json
{"kind":"sequential","plans":[{"id":"personal-demo","label":"implement then independently test","steps":[{"role":"implementation","taskType":"implementation","fileScope":"add.js","deliverable":"Create add.js directly in cwd root; export add(a,b). Necessary self-check allowed; do not add a demo subdirectory."},{"role":"test","taskType":"test","fileScope":"add.test.js","deliverable":"Independently read cwd-root add.js, create/run add.test.js, check 2+3=5, and preserve actual command and exit code."}]}]}
```

stage.json：
```json
{"stageId":"personal-demo-1","scope":"Only cwd-root add.js and add.test.js in this new demo","requirement":"Create and independently test an add function in the exact cwd root.","acceptance":"Exact paths exist and actual test succeeds; preserve evidence. Do not move files after execution.","planRef":"personal-demo"}
```

orchestrator.json（仅预检）：
```json
{"agents":{},"storeDir":"D:/workbench-demo-new/.orchestrator-state"}
```

从本仓库根目录运行：
```powershell
$demo = 'D:\workbench-demo-new'
$objective = 'Create and independently test an add function in the exact cwd root.'
node .\src\cli\index.ts round $objective --config "$demo\orchestrator.json" --cwd $demo --workflow sequential --workflow-plan plans.json --workflow-choice personal-demo --stage stage.json --stage-check --json
```

应得到 stage-check、有效计划和绑定 digest。计划/目标/材料变化需重新预检；SessionStore 可能创建空目录，但不因此创建任务或发推理。此例 fileScope/deliverable 是当前声明，**尚无结构化 expectedArtifacts/allowedScope/真实测试强验收**；不能以预检成功当产物保障。

## 真实执行仍需哪些条件

新契约状态：**Owner approved / Not yet implemented / Not yet tested**。未来产品默认整轮预授权、正常任务经机器门自动流转、异常交人工；不是自动填写accept。旧--checkpoint保留严格监督/调试。P0-1门禁→P0-2完整授权绑定/自动推进→P0-3异常等待/最终Human Gate通过后，才单独确认P0-4真实调用的模型、认证/费用、次数、时间和数据范围。当前无真实推理授权，不自动继承历史剩余额度。

真实路径仍是同一 CLI → LAYA → TaskStore/Assignment/Session/Scheduler → Native Runtime → Attempt/Verification → Codex Native Review → Human Gate；不能手工运行几个 Agent 再拼报告。固定 pair 不替代 LAYA，不从 free 名称推断资格，Review 也计会话和费用。

已实现 --laya-post-max 3 是 Round 的请求尝试硬限，第4次发送前拒绝，失败不返还；不是金额或 Worker/Reviewer 会话上限。当前 --checkpoint 仍每步等待、默认60秒；新的默认监督与来源修复尚未实现，详见 NEXT_TASK。最终 automaticPostRoundAction=NONE，不自动 merge/下一轮。

源码仍无统一expectedArtifacts/allowedScope/可信测试强门禁，默认流转尚未实现；系统timeout/input断开不能当Owner决定。未来pending_user要求先停止活动进程，但当前内存TaskStore/AttemptStore不支持安全跨进程恢复，不因取消60秒计时器承诺隔天续跑。三次历史MVP仍PARTIAL，26项既有失败及有限准入保留。

## 其他本地入口与维护

```powershell
node src/cli/index.ts doctor
node src/cli/index.ts doctor --models opencode
node src/decision/check.ts --probe
```

doctor 默认不列模型，显式 models 查询也不证明可调用或免费；health probe 仅GET，服务未启动可返回连接失败。LAYA 使用既有环境/缓存和 owned Job 启停，不因本文常驻或重新下载；参见 [LAYA接口](docs/DECISION_PROVIDER.md)。

本机 project-progress/index.html 与 audit/ 都不进入 Git。每次任务推进后由唯一基线刷新：
```powershell
node project-progress/refresh.mjs
```
需本机只读预览时可显式加 --serve；页面不控制 Runtime，正式桌面 UI 尚待用户确认需求。audit/ 是只读旁路观察，不替代源码证据和独立裁定。

PARALLEL_WRITE=CLOSED；停止未确认不释放保护；真实Agent测试 opt-in；不读取/上传凭据。OpenCode主要开发、Codex独立审核。此次只整理文档，不修改源码、不运行模型、不合并main。
