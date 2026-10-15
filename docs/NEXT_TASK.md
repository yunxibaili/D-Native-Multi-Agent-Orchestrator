# 下一候选 — LAYA-ACTION.1 最小动作与目标桥接（需实施授权）

更新日期：2026-10-15。唯一事实与证据见 [PROJECT_BASELINE.md](PROJECT_BASELINE.md)。

## 当前独立结论

LAYA-ROUND.1只读审核BLOCKED：当前orchestrationDecisionRequest给next_action的候选只有动作名；官方/本机0.3.21 choice decoder不生成任意taskId兄弟字段。输入action_parameters说明不构成输出机制，extractAction因此只能得到{action:'complete'}，validateDecision强制taskId后malformed-decision拒绝。真实TaskStore+生产provider/decision loop的受控协议反例保持to_verify/dispatch=0；带fixture人工提供taskId的正控可验证，定位为目标桥接缺口。不是新真实模型推理，不取消action元数据修复与四预设4/4真实PASS。现有b40a fixture补parameters，所以全绿不能证明原生整链可完成。
本轮现跑decision429/0、state-loop169/0、b40a-cli-workflow93/0均exit0；源码/测试未改、未启动worker/服务或新推理。只读外部依据为GitHub MCP官方v0.3.21固定tag6ab71fb4的agent.py/serve.py/router.py；本机probe/预算/日志保存在ignored project-progress，audit只读。

## 建议最小范围（尚未开始）

继续OpenCode有界开发、Codex独立审核。先追踪decision-loop所有调用者/测试，复用已有有限choice与initial-assignment精确候选映射模式，解决workflow必需的complete+明确任务目标：把当前合法、已知的动作/目标组成候选，让LAYA选择其中之一，再精确还原预先定义的payload交给原有validateDecision/applyVerification。任务/状态/范围变化仍重新验证；未知/伪造/越界key拒绝，无合法目标时不伪造一个。不能调用者默认首个任务、不能把continue或exit0当complete，不能根据状态自动验收；须保留真实acceptance_material及未知/缺证据边界。
优先局限decision-loop与相关hermetic测试，必要的CLI接线再明确；不重建provider/scheduler/DAG/manager、不改Python包/权重、不换生成模型。先收口最小workflow，其余需要自由文本/未支持参数的动态动作明确标记边界，不能声称全部修复；保持既有验证、fixed、pool、停止/租约与并行写门。首轮+最多一次返工。
验收：原生0.3.21协议形状经真实provider/loop也能传递所选目标；两个不同to_verify任务必须由所选候选区分，不能默认任务；非法候选/非to_verify/缺材料不应假完成；原始对象元数据与未知任务参数校验不退化。typecheck及decision/state-loop/b40a等直接相关套件，必要负控，不跑full suite或真实模型。

## 后续真实整链预算与前提

在参数桥接修复通过前不申请产品实跑。带前提估算：两份均为两步的候选计划、每任务至少2个可用pair、无Skill/MCP/重试/接力/动态改计划时，理想本地POST8（1分类+1计划+2pair+4cycle）；源码cycle上限9时对应总上界13。duo（两份duo计划、恰好2个可用pair）理想9/上界15，产品执行3；顺序产品执行2。默认原生Review在可审核且支持时至多另1，否则可能withheld/未启动；--no-review必须报告not_requested、不当产品Review PASS。quota普通路径最多4条辅助CLI尝试（OpenCode stats/providers list/--version，Codex doctor --json），不等于4个推理会话；原生内部辅助次数/费用未知。上述不是新增授权或全流程硬预算保证。
用户声明池的新pair保持unknown、quota未知/unavailable仍应由原有gate拒绝，不伪造probe或认证免费；后续实际模型/费用/会话/数据需单独明确。产品原生授权累计5/5，本地4次也已用完，不自动追加。

## 维护边界

工程估算68/100（界面70/30取整）不增加；PARALLEL_WRITE=CLOSED，温度校准P2保留，正式前端未进入。准备/审核不因不实施而启动worker。每任务先只读audit，完成更新基线/受影响文档/本机页面并精确审核上传；project-progress/cache/audit不入Git，主HEAD/index与其他dirty内容保持。
