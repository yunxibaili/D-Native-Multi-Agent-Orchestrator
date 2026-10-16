# 下一项 — 待授权的 Checkpoint 来源最小修复

更新日期：2026-10-16。唯一当前基准：PROJECT_BASELINE.md §5.32。

## 当前裁定：MVP-E2E.1c — FIX_REQUIRED

第三次真实 Round 为 PARTIAL：LAYA POST2/3、固定Space Bunny Worker1/2，NEW→write→test真实发生；workspace/demo/add.js和demo/add.test.js已写出，测试2/0，但计划声明根目录add.js。Owner只确认ready，accept0、本人stop0；首个checkpoint60秒超时，第二Worker及Native Review均未启动。Job ActiveProcessesFinal=0、cleanupFailures=0。第三次证据只读保留在D:/workbench-demo/third-20261016T024431Z/evidence/。

路径偏移发生在Worker write入参，非cwd被解析错。完整原生任务正文仍有file scope:add.js，没有要求demo/；当前adapter离线传参复核无路径重写，不冒充历史OS argv全量捕获。fileScope是声明不是文件系统沙箱。Demo可用现有stage/plans写明精确cwd根路径、实现自测允许范围及独立测试职责，无需新生产路径框架。实现Worker做自测或写测试本身不是缺陷；测试Worker必须独立检查/执行/必要时补测，不能复述前者结果。现有handoff保留真实write路径，本轮仅离线核对，不能声称第二真实Worker已接收。

## 唯一最小处理方案（未授权实施）

现有reader超时/EOF/错误后，CLI统一record(stop)且source恒user，并在workflow/review/handoff摘要写用户停止。这是已定位的证据归属缺陷；安全停止、未验证保护和不派下游正确。仅修改现有checkpoint reader/CLI的类型化原因、记录与摘要，区分system timeout/input-unavailable（无用户choice）、真实user_stop、user_accept；不改Verification、Human Gate、TaskStore、LAYA、Recon或原生权限。默认60秒是项目策略，deps.timeoutMs未接CLI；没有必要为了修来源新增等待平台或改变Worker90秒deadline。

复用现有短时fake输入与真实CLI受控执行，覆盖timeout/EOF/stream error、真实格式stop/accept、非法输入及accept拒绝，核验无伪造人工决定/无下游额外派发/无假完成，并保持现有同Attempt重查和停止保护。Demo只作文字澄清，不搬旧文件冒充正确交付。Owner可直接在已验证TTY窗口查看提示/输入，不需AI代传或代填accept。

本轮实跑：checkpoint49/0、CLI182/0，内存10ms timeout/当前argv构造/真实RunResult handoff路径核对；无生产/测试修改、无真实模型调用、无开发委派。26 pre-existing B5.1-WF failures remain open；有限豁免边界不变，不重开历史审计。

仅调整Demo不能修复来源错误，当前不具备申请下一次真实E2E的准入条件。等待Owner对上述唯一有限修复授权；不自动发起第四次Round。后续真实模型/费用/次数均需新授权，不继承剩余额度。PARALLEL_WRITE=CLOSED、automaticPostRoundAction=NONE、工程估算68/100保持。未commit/push/merge，完成核对后停止。
