# 当前任务 — B4.7 真实 Agent 小样本验收

更新日期：2026-10-14
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

OpenCode DeepSeek V4.1 Flash采用已验证实例`opencode-go/deepseek-v4.1-flash`；第二目标为DSH截图WorkBuddy组的Hy3 x0.00限时免费，不替换成x0.05。请从模型设置提供该免费档的provider ID与model ID，不能由界面显示名猜机器ID，不发送API Key。
本机Desktop公开包0.2.0-rc.2与项目使用的npm CLI0.1.5-rc.2不同；生产adapter当前拒绝指定model，必须先证明headless同源且任务绑定可靠。复用既有DSH adapter，研究profile/overlay及settings优先级；不能只加--model、只加patch、打开capability或猜Desktop默认。没有充分协议/反馈则明确unsupported/unknown，避免误调收费档。未经另行明确范围不改安装/用户profile/桌面默认/凭据，不启动真实推理；免费资格、截止与新增费用仍按用户声明与真实证据分开。
