# 下一候选 — LAYA-HEALTH.1：无推理健康超时定位

更新日期：2026-10-15；当前事实仅见[唯一基线](PROJECT_BASELINE.md)。

## 已完成的最短使用链收敛

MVP-READINESS.1只读收敛完成；不是完整真实round已通过。最短路径是两个sequential步骤（实现→测试），固定一个已核验Agent×Model，显式计划/阶段确认，逐步用户accept，最后保留现有原生Review和HumanGate。无需新增调度器、平台或前端。`--workflow-choice`只固定计划，`--select fixed`只固定pair，`--checkpoint`只接管单步验收；三者均不能替代LAYA分类及派发决策。

独立真实CLI预检三例：有效计划/材料--stage-check exit0；缺--confirm exit2；改计划后旧digest exit2。每例child_process调用0、fetch调用0、Task文件/执行transcript0；仅本轮owned临时配置/目录，SessionStore创建的空目录随后一并回收，owned root已删除。未调用真实Agent/额度查询或读取用户配置/凭据内容。纯值Spawn Gate六状态核对：available和unavailable在其他合成准入事实成立时可过，unknown/not_fetched/not_connected拒绝、exhausted拒绝；不是实际额度/价格验证。

## 当前阻塞与下一片范围

本轮健康观察未通过：初次默认HTTP客户端GET超时；随后仅纠正观察路径，用无代理的直连http.client访问127.0.0.1:8077/health，2秒同样TimeoutError。没有POST、没有启动/停止服务，不能由此断言端口关闭、无进程或确定根因；当前健康状态未确认。既往服务已停止记录仍仅是当时事实，不冒充当前新观测。

下一候选LAYA-HEALTH.1先只读定位本机健康超时，再按明确owned边界判断最小恢复。复用现有venv/固定缓存/Job launcher；不换模型、温度或权重，不重装，不新增框架，不碰不属于本轮的listener/进程。此候选不授权推理或产品Agent调用；如需启动服务，应先给出具体启动/时限/清理范围，执行后以validated Job空和owned清理证明结束。健康就绪后，新的真实个人demo仍须明确worker/reviewer模型、费用、会话和本地POST上限。

本片新增本地LAYA推理/产品Agent会话均0，累计本地12、产品5/5不变；旧fail-stop未用调用不自动重用。B4.6b受控PASS及历史QUALITY.2的真实wait/BLOCKED保持。全流程费用/当前free资格、原生Review及模型内部辅助调用未认证；声明池不约束Review/原生内部调用，budget-units不是美元上限。PARALLEL_WRITE=CLOSED，正式前端未进入，工程估算68/100保持。

可复制的本地预检、三个示例文件与未来执行模板见[README最短流程](../README.md#最短个人使用流程mvp-readiness1)。真实执行模板不是调用授权；模型/Review/费用未知时停止，不靠改available或忽略Review跑通。
