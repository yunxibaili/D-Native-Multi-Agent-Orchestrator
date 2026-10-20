# 唯一下一任务 — P0-4.11 真实闭环（准备已通过；新费用/执行范围待Owner确认）

当前事实见PROJECT_BASELINE.md §7.71。Owner已恢复Codex直接委派OpenCode开发/执行、Codex独立审核；暂不再提供手动转交提示词。本轮辅助入口opencode-go/deepseek-v4.1-flash已实证，进程局部覆盖，不修改全局环境或产品池。产品原固定模型仍为opencode/deepseek-v4.1-flash-free；本轮Go辅助调用不构成产品换模型/真实Round授权。

## 已完成与保留现场

- 新Demo：D:/workbench-demo/p0411-20261020T040805Z。就近opencode.json保持workspace为空；原有配置核验pass=true/882ms，主/small/白名单均DeepSeek Free；原有stage-check ok=true，digest=1848249bf5edc831a72a8cb5832ffb72553eeeeb307e0747167a378c0bcbfbab。
- workspace无目标文件，Task/Thread/Transcript状态目录无文件。未找到已保存的Round执行结果，不能从“干了一半”推断产品Worker或POST已完成。
- 先前LAYA已启动但中断未清理。本轮核对其launcher精确指向此Demo，已通过原stop marker安全停止：validated Job ActiveProcessesFinal=0，8077关闭，无强杀。保留Demo/证据，不重建或删除半途现场。
- 旧费用记录窗口2026-10-20 12:08:05–12:38:05 +08:00已过期；原pool/digest只是历史材料，未重新确认前不得执行或刷新时间戳。

## 唯一待决定项

Owner确认下一次产品Worker仍用Free，还是也改用Go；并对所选pair提供当前费用事实及新的单次执行授权。仅恢复开发委派不等于授予新产品预算。产品若切Go，配置/主小模型/provider白名单/pool/CLI与确认材料必须一致更新，不能静默fallback。Owner确认前，不启动新LAYA、stage-check、产品Worker/Review/Round，不制造源码修复任务。

## 获批后直接推进，不再全面调查

复用既有现成CLI、TaskStore/Attempt、P0-1机器验收、原生Review和owned Job。只核对变化和材料一致性，不重做B1–B5/历史测试，不改生产源码/全局/父目录/安装。不把新的真实运行授权推定为无限重跑。

原候选边界待Owner重新批准：一次串行Round；Worker最多2个原生会话、Codex gpt-6.1-sol独立Review最多1个；LAYA累计POST最多3并--laya-post-max 3，启动/每请求90s，Worker/Reviewer进程各90s，机器批准测试每条120s；并发1、任务重试0、无接力/换模型/补救Round；原生内部重试包含在deadline内。费用只允许所选模型免费或订阅包含额度，0新增收费，无额外credits/API按量/自动充值/收费fallback，辅助调用同边界；声明30分钟不滚动。

只发隔离Demo任务与必要证据，不放宽权限、不自动审批，协作式目录边界不冒充OS读取/网络沙箱。批准后更新真实声明和相应材料、一次stage-check取新digest，再执行唯一LAYA→实现→机器测试/Verification→独立测试→机器测试/Verification→Native Review→Human Gate。保留真实wait，失败即停；最终Owner决定，automaticPostRoundAction=none。

完整CLI stdout/stderr原始字节、退出状态/预算/会话身份/重试及每个Job停止事实单列；复制UTF-8 RoundResult后核对身份/时间/结构和SHA256，不借旧latest、不修改ORCH_HOME、不回填旧结果。无论成功/失败均按已有owned协同停止，确认final0及cleanupFailures，禁止按PID/名称强杀。

OpenCode实现方不commit/push/merge/reset/clean/stash。Codex独立核对源码/已有日志，不重复Worker测试，维护唯一基线/进度并按阶段授权精确归档。没有必要实现时直接报告，不为保持忙碌新增测试、脚本或架构。
