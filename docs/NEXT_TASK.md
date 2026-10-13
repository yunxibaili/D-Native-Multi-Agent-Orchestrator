# 下一任务 — B4.3a 确认绑定与材料可达性收口

更新日期：2026-10-13
执行对象：OpenCode 开发；Codex 独立审核。
状态：两个独立复现 P1 的修复任务，待用户下发；不自动授权实施。
唯一当前状态见 [PROJECT_BASELINE.md](PROJECT_BASELINE.md)，路线见 [BACKEND_DELIVERY_PLAN.md](BACKEND_DELIVERY_PLAN.md)。

## 目标

只修 B4.3 的两个 P1。复用现有 stage-material、plan-file、CLI、Workspace/brief、Assignment/Review，不建立审批、阶段或材料管理平台。
原 B4.2a 的等待/拒绝分类 P2 已独立关闭，不再重写。round-cli.ts 恢复与父快照的 token 核对通过，不为恢复事件重新审整仓。

## P1-1：确认必须覆盖实际执行的计划和范围

独立证据：材料 planRef=stage-flow，沿用该材料 digest，却提供 id=unapproved-plan 的计划；真实 CLI/编排链仍运行两次，exit=0，
改后的交付要求进入 RunRequest。保留 stage-flow ID 而改变计划交付要求，旧确认同样通过。
根因是摘要只含材料字段，planRef 未核对实际计划，objective/workflow/实际计划内容均未绑定。

最小修复：

- 本地解析并冻结本次有效阶段材料和执行计划，在外部调用/任务创建前核对确认所指的实际输入。
- 明确 planRef 的含义，核对选中计划或用户明确批准的有界候选集合；不能只比较文件名或 plan ID。
- 计划的职责、范围、交付、依赖/集成责任等关键内容变化，以及改变实际目标/工作流范围，旧确认不得继续覆盖。
- 复用标准哈希和现有 typed 计划。可以批准明确的候选集合再由 LAYA 选择，不增加模型审批或复杂签名系统。
- stage-check 显示用户将确认的阶段、有效计划/范围摘要和 digest；不能只显示一个与执行脱节的材料摘要。
- 保持新入口 opt-in；没有 --stage 的原流程不变。确认只是本地显式用户入口，不能宣称身份认证或文件系统安全沙箱。

验收：确认别的 planRef、同 ID 计划内容变更、实际目标/工作流范围变化均在写前拒绝，runtime=0，无部分任务/分配；
已确认的正确输入正常执行。只改 JSON 字段顺序等无语义格式，不应改变标准化后的确认对象。

## P1-2：关键材料必须完整可用，引用不能只是一段标签

独立证据：1028 字 requirement 的末尾为 CRITICAL_DO_NOT_CHANGE_DATABASE_SCHEMA，摘要截掉该约束。
owned Git repo 中 stage.json 未提交；声明 isolated 能力的受控适配器经真实 WorkspaceManager 获得隔离 worktree，
其中没有相对引用的 stage.json；prompt 无关键约束却仍被接受。
该 probe 证明路径与内容问题，不证明真实 Agent 已加载/遵守材料，不将 fixture 的源目录写入冒充隔离目录开发。

最小修复可择一：

- 将必要关键约束完整带入已有执行 brief/验收；较长材料通过实际可读、绑定正确批准内容的引用或最小快照交付。
- 当前不支持长材料或无法保证引用可达时，先明确限制并写前拒绝；不接受后静默截断。这比建设通用 ArtifactStore 更合适。

不要用扩大一个摘要字符上限掩盖所有长材料，也不要复制全部历史或凭据。
引用须绑定所属项目/实际工作区和批准内容；源材料在确认后被替换不能以同路径冒充正确版本。
不要只在报告加 ref 字段；要求必须进入实际执行及验收链。不能把基本正确交付全部推给 B4.4。

验收：关键约束放在摘要之外仍完整可获得，或在任何写执行前明确拒绝；实际 Git 隔离 cwd 下验证引用存在且内容正确，
不存在/被替换/旧同名文件不能默默通过。可短材料直接交付，不强制所有小任务新建文件。

## 验证与范围

typecheck、本片 b43-stage-material、b42-plan-file、b40a-cli-workflow，以及实际受影响的选择/结果定向回归和 isolation 守卫；git diff --check。
用真实 runRoundCli/既有编排链 + 受控 provider/runtime 验证，覆盖 stage-check 零外部调用、未确认拒绝、正确确认成功、上述两个 P1 和旧入口兼容。
不 full suite、不调用真实模型、不读凭据、不改本机 Agent/API 配置、不装依赖、不进入 B4.4 或正式前端。
PARALLEL_WRITE=CLOSED，不能去掉资源/工作区门来过测。

owned Git probe 的 worktree 可能在源临时目录之外：记录实际返回路径并纳入本次清理，不扫描/删除 foreign 目录。
本次 Codex probe 的精确残留和工具清理拒绝已记在基线；不要把它认作开发方资源或顺手按目录名批量删除。

更新唯一基线、受影响文档和 project-progress JSON，运行 node project-progress/refresh.mjs；页面仍全部 ignored。
报告真实调用链、前置拒绝/成功、测试退出码和所有 owned 残留，标 READY FOR CODEX INDEPENDENT REVIEW。
不自行封板、不 commit/push/stash/reset/clean；完成后停止。
