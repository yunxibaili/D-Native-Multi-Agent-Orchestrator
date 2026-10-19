# 唯一下一任务 — P0-4.9 批准测试事实最小投影（待Owner转交OpenCode）

P0-4.8只读映射独立审核PASS，见PROJECT_BASELINE.md §7.63；P0-4.7静态PASS保持，P0-4.6真实E2E仍PARTIAL。本文是下一片实施范围，尚未启动开发，不恢复真实产品调用授权。Owner转交此任务后由OpenCode实施、Codex独立审核；不自动运行模型或新Round。

## 唯一目标与允许文件

把现有CompletionEvidence中的批准测试事实以不可修改的副本送入ReviewPacket和RoundResult/交付文本；不改完成门禁，不新增证据/状态权威。

仅允许src/orchestration/completion-evidence.ts、orchestrator.ts、unified-review.ts、round-result.ts、src/cli/round-cli.ts；index.ts仅在确有新类型导出需要时修改。不新增依赖、包装层或通用深冻结工具。Codex在独立审核后维护基线、NEXT及进度页，Worker不改它们。

## 实施要求

1. Orchestrator作为私有Map所有者提供只读出口。复用attemptBindingRefusal及现有AttemptStore/acceptedRuns/runProvenanceOf的同store、同record、同attempt核对；仅fingerprint相同不能认定Attempt绑定。再核对CompletionEvidence与当前task/proof的taskId、lease、session、agent/model、runFingerprint及contractDigest；缺失/失配返回null，不猜测、不从调用者填写的ID建立信任。
2. 视图显式复制事实并冻结对象及复制的argv，不返回内部test/Map/proof引用。至少保留命令/argv/cwd、code/signal/timedOut/treeStopConfirmed/mayHaveStarted/outputDigest/note，以及Task/Attempt/Session/lease/pair/runFingerprint/contractDigest/validatedAt。保留现有时间和摘要语义：validatedAt不是测试结束时刻；摘要不是原始字节日志；没有结构化timeoutMs就不补造。正确绑定的失败测试可以展示其失败事实，不把code0变成任务PASS。
3. 不调用整个completionRefusal、不重读文件系统来认证报告、不重新运行批准测试。后续合法任务会改变共享工作区，不能因此抹去第一步已采集的历史测试事实。采集时事实不代表当前文件新鲜度，原applyVerification仍独立执行原门禁。
4. CLI对当前实际执行取得同一视图，送入ReviewPacket与最终RoundResult机器JSON及人类交付文本。只归属视图命名的当前Attempt；未启动任务/失配证据为null，不复制给其他历史Attempt。沿用现有current execution/receipt语义，不能从累计latest记录借证据。
5. 两个渲染出口区分批准测试事实与Worker观察shell命令，后者明确NOT test verdicts。新字段可选，undefined/null继续UNREPORTED，不从Worker PASS或Job耗时推断。用既有有界文本能力控制Review文本，不发送原始stdout/stderr；最终JSON保留必要事实。不得新建判断层或自动PASS标签。
6. 不改采集器执行、completion-gate/applyVerification、AttemptRecord、原生adapter、调度、Review判断/Human Gate；不改父任务呈现、观察端UTF-8、模型/费用/权限。P0-4.6旧结果不得回填，仍PARTIAL。

## 轻量验收与停止

先读取相关源码及§7.63；纯本机内部接线，已有来源足够，不重复联网检索。提交实际diff和两条静态负控走查：缺CompletionEvidence时即使Worker报告PASS仍UNREPORTED；身份失配不关联Attempt，失败/超时/停止未确认保留失败事实且不生成成功标签。

按Owner转交范围仅运行一次npm run typecheck和git diff --check；保留命令、输出及真实退出码，Codex不重复运行。不得新增/修改/运行测试文件，不写临时验证脚本，不启动产品Agent/LAYA/Native Review/Round。若发现需改变证据采集或验证契约，停止并报告，不自行扩张。首次实现加至多一次有明确证据的返工；连续两次检查失败立即停止。

保持主HEAD/index及范围外dirty，不commit/push/merge/reset/clean/stash，不读凭据、不改Demo/全局/安装。完成后READY FOR CODEX REVIEW或BLOCKED即停止；归档由Codex负责。
