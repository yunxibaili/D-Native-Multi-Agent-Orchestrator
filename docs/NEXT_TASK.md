# 下一候选 — B4.7.1b Demo计划与验收路径对齐

更新日期：2026-10-15
唯一状态/证据见[PROJECT_BASELINE.md](PROJECT_BASELINE.md)。用户已授权继续；只读准备已完成。真实调用等待实际模型、费用/包含额度/超额扣费、会话次数和数据范围，不以“继续”猜付费或数据授权。

## 已准备的最小路线

优先复用现有runRoundCli、计划文件、Assignment/Session/Scheduler、同Attempt材料、原验证门及owned isolation。只新建隔离demo，不带入当前dirty源码。先两步实现→测试，产物由当前Codex独立复核/实跑；只有一个pair获授权也能先验功能A的真实顺序链，完整多模型兼容性仍unknown。两个pair明确后可验duo（三次真实任务执行含集成），PARALLEL_WRITE仍CLOSED。
每native执行建议有界90秒/无异常自动重试，所有失败或停止未知如实记录，不释放保护/开第二写者。次数计native会话，不等于内部模型请求或货币预算。自动真实review必须明确纳入调用/费用范围；未执行真实review或LAYA，只能报告受控seam/未验证，不能使用fake PASS补齐证据。默认没有opt-in或参数缺失，不启动任何真实Agent。

## 必须记录

实际RunRequest的Agent/model/cwd与同次Attempt/Session/输出/工具观察；真正可读取的native反馈模型（没有则unknown）；真实文件字节及独立测试；validated Job tree-stop、owned路径/句柄和清理失败的真实退出码。目录不证明可调用/免费，成本未知不补0。OpenCode Go是否启用超额余额只能由用户说明，不读现有凭据、不擅改配置。
本轮核对本机安装包标识1.18.35；官方相应tag源与CLI文档仅作接口依据，真实二进制行为仍须实跑。旧native e2e硬编码模型和隐式review/长时任务不直接运行。

## 任务纪律

每次开始只读读取project-progress/audit/观察日志一次，不写/删/上传，不强制采信；实际结论以源码与证据为准。若确需实现，OpenCode仍由opencode-agent implement/DeepSeek V4.1 Flash开发，Codex独立审查，最多首次+一次返工；没有缺口不为委派造代码。更新基线/受影响文档/ignored进度数据并上传独立快照，保留main/index/dirty树。正式前端尚未进入，先确认前端需求再做UI。

## 用户已指定的模型与当前单点

OpenCode目标仍为`opencode-go/deepseek-v4.1-flash`；用户已将DSH第二目标改为`GLM-5.3-FLASH`，替代Hy3。GLM的provider ID、内部model ID及免费资格尚未确认，不从显示名猜机器ID，不沿用Hy3截图的限免信息，不发送API Key。开发委派worker仍使用DeepSeek V4.1 Flash；本次只更新验收目标，不修改DSH桌面默认或用户配置。
本机Desktop公开包0.2.0-rc.2与项目使用的npm CLI0.1.5-rc.2不同；生产adapter当前拒绝指定model，必须先证明headless同源且任务绑定可靠。复用既有DSH adapter，研究profile/overlay及settings优先级；不能只加--model、只加patch、打开capability或猜Desktop默认。没有充分协议/反馈则明确unsupported/unknown，避免误调收费档。未经另行明确范围不改安装/用户profile/桌面默认/凭据，不启动真实推理；免费资格、截止与新增费用仍按用户声明与真实证据分开。

## 本轮离线验证与下一动作

用户明确本轮不调用模型，并指明WorkBuddy组GLM-5.3-Flash x0.06。离线9项断言通过：生产指定模型拒绝、已安装headless --model语法拒绝、已安装默认模型服务settings覆盖启动selection；DSH受控suite64/0。均不证明实际GLM机器ID/可调用/免费，未修改生产或用户配置。下一步仅获取非敏感Provider ID/Model ID并核实可靠绑定；没有协议依据不启用modelSelection，真实验收暂不授权。

## 最新调查建议：已有免费pair先验，DSH不作整轮前置

优先候选为opencode/space-bunny-free及opencode/mimo-v2.6-flash-free，项目已有历史池，官方2026-10-14仍列免费。只代表已知协议路径/公开目录/价格，今日实际可调用和账户额度unknown；尚无真实调用授权。DSH GLM-5.3-Flash x0.06保持用户指定待办，不必等其逐请求绑定才验证OpenCode两模型。
已有B2.1用户池、fixed/auto、Assignment及B5.1停止安全接力直接复用；不重写路由器。9Router动态目录/冷却与CLIProxyAPI配置可参考（均MIT，GitHub MCP实读成功），现阶段不安装代理网关、不复制协议指纹或凭据层。OpenRouter的随机free路由不替代LAYA明确模型选择。
下一实施片若获授权：先有界只读本机目录确认这两个完整ID，再在生成隔离demo上验真实duo；免费池耗尽就停止，fixed不得替换，实际native模型无证据保持unknown，辅助标题/review费用单列；不将公共价格或旧cost0视为全流程零费。具体来源及调查限制只见唯一基线。

## 本机目录核对已完成

2026-10-14直接复用生产collectModelCatalog，隔离cwd/owned launcher，原生models一次1170ms、43项；Space Bunny Free/MiMo V2.6 Flash Free完整ID均列出，同次validated Job空，owned清理完成、exit=0。无需再重复目录核对。真实推理仍0、callable未知，先保留用户不调用模型约束；下一真实小样本须明确授权后执行，不把继续目录核对解释为放宽费用/调用范围。

## 当前独立裁定与下一小片

B4.7.1 BLOCKED，首次+唯一返工结束。独立typecheck/68入口/60ownership/6-entry guard通过，Node-only耦合探针exit1确认：Node检查成功且Job空，fact未进入runRealDuo.commands，完整链的controls数会比台账多。未通过测试改动留本地，不进入上传快照；生产代码未变。
下一片只修改既有b47两测试文件：将同次Node fact返回并fold到真实commands，记录失败/异常或may-have-started时的事实，增加走相同路径的承重回归；本地sessionId不能命名成nativeSessions，原生ID未知就unknown。保留现有固定池、最多3native/90秒、owned配置/Job停止/清理失败退出，不重写执行器/审批/框架。新任务下发后由OpenCode实施、Codex独立审核。
真实样本已有明确授权：两free候选、只生成隔离demo、最多3原生执行会话/各90秒，不收费/独立LAYA或Review，未知就停止。授权不重问；入口通过前不启用，本次消耗0。真实验收/完整B4尚未通过，PARALLEL_WRITE继续CLOSED。

## 2026-10-15最新结论

B4.7.1a的Node台账/异常记录/身份命名及遗漏task-budget接线范围独立PASS，83/0+实际耦合probe通过；完整B4.7真实duo仍BLOCKED。实际Space Bunny正确按src/provider/**写src/provider/add.mjs并结束，原生model已独立确认、消息成本报告0，Codex5个函数案例通过；入口却验根add.mjs，第二模型和集成被阻止。不要把它误判为模型质量/可调用/Job问题。旧台账blocker已关闭，勿重复重做。
下一片仅对齐现有demo的scope/交付/验收路径：优先沿用内置provider/consumer目录，或复用B4.2共享builder定义一致的模块/测试计划；不另造DAG/manager或改生产。用受控实际文件回归验证每条路径一致，不为了新前端开发产品UI。整个entry代码仍本地未上传，裁定文档已上传。
原授权最多3个原生执行会话，实际用1剩2，不自动提供方重试/重置次数。完整新duo需3个，必须明确追加额度或选择2个会话内的不同目标；相同免费/隔离demo/90秒/无独立LAYA-Review的范围保留，不重新问已经批准部分。即使结构修复也先独立审查再启动，PARALLEL_WRITE继续CLOSED。
