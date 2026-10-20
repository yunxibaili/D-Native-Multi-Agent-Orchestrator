# 唯一下一任务 — P0-4.11 单次串行真实闭环（BLOCKED；待Owner批准新Demo就近配置并重新授权）

P0-4.10只读核对独立审核PASS，见PROJECT_BASELINE.md §7.65。无需新增生产功能或继续全面预检；下一步只申请一次新的真实执行。本文不是已获授权，旧P0-4.6范围已耗尽、费用声明已过期。模型池、digest、Demo和运行进程当前保持不动。

## 2026-10-20本轮预检结果（BLOCKED；未执行）

Owner已在2026-10-20 11:26:24 +08:00提供30分钟费用声明。按本文准备全新Demo后，在任何stage-check/LAYA/Worker/Reviewer之前发现：专用`OPENCODE_CONFIG`（主/small/whitelist均为`opencode/deepseek-v4.1-flash-free`）被祖先`D:\workbench-demo\opencode.json`覆盖为`opencode/space-bunny-free`；可覆盖它的`OPENCODE_CONFIG_CONTENT`不在`src/runtime/spawn.ts:158–187`的`ENV_ALLOWLIST`，contained Worker收不到。修改祖先/全局配置或生产allowlist均超出本轮授权，故按“有效合并冲突即停止”未执行。仅2次本地`opencode debug config`取证，无stage-check、LAYA、POST、Worker/Reviewer、测试或Round；Demo已删除、无owned进程。详见基线§7.67及ignored project-progress/p0411-preflight-blocked-20261020/facts.json。该窗口未消耗于真实调用，已过期且不得补用。

## 独立审核后的唯一最小建议（§7.68；尚未授权/验证）

不优先修改生产ENV_ALLOWLIST或已有父/全局配置。建议Owner只批准在下一次本轮自有新Demo根目录新增`opencode.json`，可同时作为专用OPENCODE_CONFIG文件：顶层model/small_model均为`opencode/deepseek-v4.1-flash-free`，enabled_providers仅opencode、whitelist仅deepseek-v4.1-flash-free，并预置官方$schema；不加入权限放宽、插件、MCP或凭据。

文件位于新Demo根、workspace之外，保留目标workspace为空；不改`D:\workbench-demo\opencode.json`、任何旧Demo或全局配置。v1.19.3官方ConfigPaths.files的祖先先加载、就近后加载及顺序merge提供依据，但此新方案本机尚未验证，不能写成READY。该新文件是相对旧“父目录不改”范围的一项明确、仅限本轮自有目录的待批准例外。

Owner可将此最小配置调整与下方一次Round范围一并新批准，并提供当前30分钟费用声明，避免再开独立开发轮次。获批后先核对配置加载副作用及既有contained观察入口；只允许一次最多30s、沿用既有owned containment的无推理有效配置核验，输出仅脱敏模型/白名单/来源，不能读取或保存凭据。实际模型/辅助模型/白名单不一致即停止，不进入stage-check，不追加诊断或转为修改源码。成功且费用窗口有效时才按既定流程继续唯一Round。未取得该新授权前不创建Demo、不刷新pool、不启动任何CLI/模型/服务。

## 待Owner一次性批准的范围

- 一次全新Round；Worker按Owner最新选择固定opencode/deepseek-v4.1-flash-free，最多两个原生会话；Reviewer固定codex/gpt-6.1-sol，最多一个独立Native Review；不替换模型或provider。
- LAYA现有本地缓存与owned containment服务，启动最多90s；每次POST最多90s，累计POST最多3，必须--laya-post-max 3。
- Worker每会话及Reviewer真实进程deadline各90s；每条机器批准测试使用现有120s默认上限。并发1，编排器重试0，无handoff/补救Round/自动跨阶段；允许OpenCode既有同会话内部重试，但包含在90s和相同模型/费用边界内。
- 新增收费0：Worker当前免费可用，Reviewer现有订阅包含额度足额，不消耗额外credits/API按量余额、自动充值或收费fallback；辅助调用同受此边界。需Owner当前账户声明的原文及发送时间，声明窗口从实际确认时开始30分钟、不滚动，不把历史声明重打时间戳。
- 只发送新隔离Demo任务、产物和必要证据；接受现有原生权限及协作式目录边界，cwd/allowedScope/Job不是OS读取/网络沙箱。不放宽权限、不自动审批，不读取/打印凭据；允许原生必要状态写入及已有登录配置加载。
- 首尾确认、机器验证后中间自动流转，异常即停；最终Human Gate由Owner决定，automaticPostRoundAction=none，绝不代填accept。
- 允许必要的新隔离Demo配置及本轮证据文件，完整CLI stdout/stderr按原始字节留存；使用既有contained执行与观察入口，不新增生产运行器、临时验证脚本或修改全局配置。无生产源码、仓库测试、安装、commit/push/merge改动。

Owner明确批准上述新范围并提供当前费用事实后才执行；否则仅报告尚缺项并停止，不能把本文件或转述当成当前账户事实。执行/归档由既定OpenCode执行、Codex审核/推送分工完成。

## 获批后的唯一流程

1. 只核对可能变化的源码哈希、原生版本/资格/模型与有效路由/权限、现有contained启动入口，不重复B1–B5或POST预算审计。收费/身份/权限不满足则停止，不能用推理探测资格。
2. 在D:/workbench-demo下新建本轮明确拥有的目录，workspace为空、control/evidence分离；获Owner新批准后仅在该新Demo根增加上述就近opencode.json。复用现有两步CJS计划与P0-1完成契约。实现任务只改根add.js并允许自测，测试任务只改根add.test.js且独立执行；不预置目标产物，不动p04-20261019T035918Z及其历史证据。新配置必须绑定正确Reviewer model和timeoutMs=90000；产品Worker的CLI --model、agents.opencode.model、pool及专用原生配置顶层model/small_model、opencode provider白名单必须统一为opencode/deepseek-v4.1-flash-free（白名单项deepseek-v4.1-flash-free）。不得继承祖先space-bunny-free覆盖、Go路由或付费fallback，发现有效合并冲突即停止，不修改任何已有父/全局配置或旧Demo，不修改生产allowlist。
3. 依据Owner新声明记录pool来源/有效窗口；现有round CLI使用sequential/fixed、checkpoint机器自动策略、max-children=3/max-concurrent=1/retry-max=0/no-handoff，执行/Review/LAYA请求90000ms，LAYA POST硬限3。先一次无推理stage-check取新digest；材料变化须重新核对，不沿用旧digest。预检不能消耗真实推理。
4. 在新费用窗口内使用该digest和--live-agent启动唯一Round，真实链为LAYA→实现→机器批准测试/Verification→独立测试任务→机器批准测试/Verification→独立Codex Native Review→Human Gate。失败/超时/身份或费用异常立即停止，无新Round/补救Review。LAYA wait保留原决定，不改写complete。
5. CLI stdout/stderr与退出状态分别保留；不得经有损字符串解码把损坏JSON当主证据。结果路径以本轮report.roundResultPublished为准：ok必须true；复制后副本核对identity.complete、预期rootTaskId/roundId、startedAt/completedAt、Task/Attempt/approvedTest、review、gate及源/目标SHA256。目标为本轮evidence-<roundId>，不得覆盖旧文件。必须没有其他并发Round/发布者；不改ORCH_HOME，不借旧latest，不修补旧损坏日志。
6. RoundResult只覆盖任务/测试/Review/Gate；另列完整CLI预算/发送门、会话真实模型/退出/重试、服务日志与每个owned Job停止证据。无论成功/失败均按既有owned协同停止；逐项确认ActiveProcessesFinal=0及cleanupFailures，不能按裸PID/名称强杀或把单条测试停止事实当所有进程已清理。
7. 交付PASS/PARTIAL/BLOCKED、真实调用计数/身份/测试/合法Review verdict/最终Gate和清理证据。到达waiting_for_user不是Owner已接受；不得代替最终人工决定或宣布全部后端封板。完成后停止，交Codex独立审核；不自动下一阶段。
