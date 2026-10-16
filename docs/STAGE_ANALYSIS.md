# 阶段分析 — 预授权、机器验收与异常人工介入

更新/Owner批准日期：2026-10-16。
**Owner approved / Not yet implemented / Not yet tested**。
本文按本次Owner要求重新建立，仅解释当前路线；不恢复旧历史日志、不另立阶段状态权威。事实只见[PROJECT_BASELINE](PROJECT_BASELINE.md)，实施顺序见[BACKEND_DELIVERY_PLAN](BACKEND_DELIVERY_PLAN.md)，唯一下一项见[NEXT_TASK](NEXT_TASK.md)。

## 为什么取消默认逐任务人工阻塞

Owner需要的是个人工作台：一轮开始时确认短计划、范围、模型/池、费用和工具；正常任务在可验证边界内自动流转，异常才求助，而非每步等待人工accept。
第三次MVP确认真实写入/测试能力，但60秒系统超时阻止后续，且被错误归为source=user。此前实验要求两次真实accept属于历史约束，未达成的事实仍是PARTIAL；不能追认自动完成或改历史source。

新默认不是“取消门禁”：用确定性产物、范围和测试门槛取代日常手工质量确认；用户始终能停止、拒绝或变更后续范围。边界改变必须重确认，不能静默扩大。
旧--checkpoint保留严格监督/调试；不再作为正常个人流程唯一方式。开始授权不是任何任务可无限执行的许可证，原Worker/Reviewer/LAYA时限、费用、权限和Job停止保护不变。

## 先后依赖

| 顺序 | 为何必须在前 | 完成边界 |
|---|---|---|
| P0-1：确定性门禁 | 没有独立机器完成证据就自动流转，会放大错路径/假测试 | 统一completeTask/applyVerification核验，失败阻断下游；不先开放新默认 |
| P0-2：整轮授权与自动流转 | 只有绑定计划、范围、模型、费用和工具，才能证明下一任务仍在授权内 | 正常Task1→Task2系统验证推进，不伪造accept；边界变化/授权过期停，不重复成功Worker |
| P0-3：异常等待/交付 | 安全暂停与人主动停止必须分开，不能让等待继续占执行进程 | 原因/来源明确、活动资源安全停止、待办结果保存、最终Review/Human Gate；恢复能力如实声明 |
| P0-4：真实E2E | 文档批准/fixture通过不证明真实模型闭环 | 新授权内实现→机器门→独立测试→机器门→原生Review→Human Gate；异常即停 |

代码质量三门是必要条件：精确expectedArtifacts、真实allowedScope、批准命令的可信测试exit0；不是全代码质量充分条件。独立Review仍必要，LAYA仍做合法任务决策，不以complete绕过门槛。

## 事件语义（目标，不强制新建字段/Task状态）

| 目标事件/投影 | 来源 | 意义与后续 |
|---|---|---|
| user_accept | user | Owner真实接受展示的成果；不是机器证据替代，不用于伪造中间自动流转 |
| user_stop | user | Owner真实停止，保留已完成成果与原因 |
| system_timeout | system | 等待到期，无用户choice；不谎称Owner拒绝/停止 |
| input_disconnected | system | EOF/非TTY/通道错误，无用户choice；保留具体原因 |
| verification_failed | system | 确定性门禁不通过，保存失败证据，停止相关下游 |
| pending_user | 系统结果投影 | 活动执行资源已安全停止后等待Owner决定；不等于Task成功或进程仍运行 |

自动通过应标已绑定预授权策略下的system verification；不创建自动user_accept。未来P0-3不再把默认60秒等待到期当作抹掉Round的理由；当前代码只是停止后续而非删除成果，缺陷是来源和交互语义，不能夸大为文件被销毁。
对仍无法证明Job停止的情况继续保留保护，不得声称pending_user已安全释放。

## 当前恢复缺口与最小方案

TaskStore(store.ts:11/119)、AttemptStore(attempt-store.ts头部)是内存状态；已有session/transcript/round-result持久记录不能还原权威任务状态。
P0-3先复用结果发布保存待人工事实、原因、任务/Attempt/授权引用、成果位置和恢复限制；输入断开也能给Owner可读结果，不假定终端永远在线。
取消计时器不等于次日恢复。若进程退出，应明确“原进程不可安全续跑”；未来确需恢复时才补可信Task/Attempt/授权恢复、工作区/预算/停止重验和重复派发保护，不立即造恢复引擎。

## 研究依据与本项目推导

- [LangGraph Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)：checkpoint/interrupt/resume及节点重跑副作用是官方机制；本项目借鉴“暂停不等于完成”，不引入LangGraph。
- [OpenAI Agents SDK HITL](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)：interruption、approve/reject和RunState保存/恢复是官方机制；项目推导为区分用户选择与系统暂停，**不因此宣称本项目已有RunState恢复**。
- [A2A 1.0.1生命周期](https://a2a-protocol.org/v1.0.1/topics/life-of-a-task/)区分input-required/auth-required与completed/failed等；只借鉴语义，不能把A2A状态复制为第二TaskStore。
- SWE-bench的目标/回归测试与SWE-agent的真实行动/观察轨迹支持可查测试证据；Agentless论文的定位/修复/验证分离支持小流程；它们并不直接规定本项目三门或保证效果。
- MAST研究多Agent失败；“P0-1先于自动推进”是结合本机错路径/缺证据的工程推导，不是论文已验证本项目。

完整原URL、版本/年份、核验状态、采用和不采用范围见[研究索引](ENGINEERING_RESEARCH_REFERENCES.md)。只参考机制，不安装或迁移框架。

## 不变的范围

Windows正式桌面产品路线保持；P1自然语言计划→P2模型/Skill/MCP配置→P3正式桌面UI顺序保持。UI具体需求另行确认，本机进度页不入Git。
保留全部原需求和26项B5.1-WF失败/有限准入；不新增Planner/Workflow/Registry/Verification权威，不开放并行写，最终automaticPostRoundAction=NONE。
本次仅文档审核与隔离分支追加提交，无源码修改、测试、开发Worker或真实推理；不自动实施P0-1或第四次E2E。
