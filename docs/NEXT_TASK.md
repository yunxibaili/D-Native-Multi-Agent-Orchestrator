# 唯一下一任务 — P0-4.23 原定真实Round精确重试（待Owner答复）

本轮执行范围及费用/边界已获Owner批准，当前阻塞来自执行环境自动审批，非缺少原执行授权或模型额度。唯一基线§7.86：新Demo D:/workbench-demo/p0423-20261021T040337Z，Go主/辅助/provider有效配置确认；一次stage-check exit0，digest=b178f6d967315bc5195019de0f933d817f199d3f82dbef9a8fff673efbe53afb，两个预检Job final0。workspace空，没有目标产物。

既有owned LAYA启动→Round CLI→owned协同停止的合并命令被CreateProcess前拒绝，仅blocked by policy，无具体理由。LAYA启动/health/POST、Worker/Reviewer/Round/批准测试均0，没有执行过真实Round，不记为模型或产品运行失败。未换入口或实际重试。

已向Owner请求对同一受控命令精确重试一次，范围保持：仅一个新Round；opencode-go/deepseek-v4.1-flash Worker≤2会话，codex/gpt-6.1-sol Reviewer≤1会话，LAYA POST≤3；各原生执行/LAYA请求/启动90s，批准测试每条120s；并发1/编排器重试0/无接力/换模型/付费fallback，同会话OpenCode既有有限重试允许；原生权限不放宽、不自动批准，自动后续none。回复未到前不重试。

Owner两项费用事实及边界确认固定窗口2026-10-21 12:03:37至12:33:37（北京时间，首次接收时钟观测，不是精确平台发送时间）。若获精确重试批准且窗口内、材料哈希未漂移，沿用已有费用事实/digest，不重复询问或试推理；再次拒绝即停，需执行环境给出具体政策理由。窗口过期不刷新旧声明，先补新费用事实并重新绑定stage digest。不得拆分/编码/换入口规避拒绝，不修改生产源码、Agent安装或安全规则。

执行原来的两任务add.js→独立add.test.js，经过现有统一完成门禁/机器自动流转/runUnifiedReview/Human Gate；不得手工造产物、补救Round或将旧Reviewer-only pass当整轮新证据。旧Round/Human Gate保持，Owner未作accept。本轮新Demo保留为未执行材料，owned预检进程全部停止。

既有LAYA固定离线缓存/loopback/owned Job、模型身份、预算/退出/正式RoundResult按字节留存及同roundId哈希核对方案不变。当前不得启动产品模型/服务，直到精确重试获批；不追加开发或前端工作，不复测历史债务。

精确阶段归档只基线/NEXT到独立codex分支，仓库外隔离索引、核对远端SHA/manifest并清理自有临时资源；主HEAD/index/范围外dirty保留，不合并main/强推、不上传本机project-progress/audit/凭据。
