# 唯一下一实施任务 — P0-1 已定位缺口有界续修

更新：2026-10-16。当前P0-1独立裁定BLOCKED，部分实现保留；本轮首次实现+一次返工均已使用，不能自行发起第三轮。下一实施须Owner新任务授权。P0-2/3和第四次真实E2E仍未授权。

## 只处理以下明确缺陷

1. src/orchestration/orchestrator.ts applyVerification：按implementation/test适用性强制完整契约；缺字段/证据拒绝。覆盖直接调用、completeTask、review-loop、人工accept；research/review保留明确兼容路径。内置/动态任务也不能用契约缺省绕过。
2. completion-evidence.ts：allowedScope比较本Attempt完整before→afterTest增删改，不排除测试脚本写入；旧dirty未变不归因，新改动必须归因。
3. workspace-manifest.ts：大文件变化必须改变最终证据版本（完整hash或明确保守拒绝），校验实际根和路径链的link/Junction，不能stat跟随后直接safe=true；保留Windows边界。
4. 当前Attempt/Session/RunResult/lease/Workspace与测试产物版本绑定，最终提交同步核对；已有runFingerprint不能只生成不消费，不用旧proof认新执行。
5. 新增批准测试进程的may-start/stop确认必须参与同一资源claim保护；测试停止未知时不能使用前一个Agent的确认释放写保护。沿用ManagedProcess，不新增进程/状态权威。
6. tests/b42-plan-file.test.ts UTF-8编码/279行字符串/DEBUGSEQ残留修复；迁移直接受影响计划与stage夹具（B43当前missing-field），保留有意义断言，不删除新门禁或把编码任务改成research求绿。

## 离线验收

- 复跑project-progress/p01-review-20261016T070858Z/codex-final-probes.json四类反例：缺契约编码拒绝、测试越界拒绝、大文件变更使证据失效、Junction根保守拒绝/可靠归属。
- 新增同Task错误Attempt/Session/RunResult与测试后文件变化、测试停止未确认保持claim的承重回归；精确路径成功/错误目录拒绝/dirty增量/测试真实exit0与非0/超时、非编码兼容。
- npm run typecheck；p01-completion-gate、b42-plan-file、b43-stage-material、CLI/workbench/contract相关回归，git diff --check。禁止full suite/真实LAYA/产品Agent/Native Review。
- Handoff本轮前后388/26、失败签名与主要错误标准化完全一致；26 pre-existing B5.1-WF failures remain open，仍不要求全面修复。

## 分工与停止

先按research-before-work复核当前源码及已读官方Node/Win32资料。OpenCode负责新授权下有界实现，指定opencode-go/deepseek-v4.1-flash；Codex独立审核/复跑。不能用wrapper exit0或57/0直接宣称通过。
本轮证据见docs/PROJECT_BASELINE.md §7.3及ignored project-progress/p01-review-20261016T070858Z/；audit旁路目录只读。未修改/重装原生Agent、未改账户付款，未运行真实产品Round。
保留当前草稿、历史dirty与before快照；不得reset/clean/stash/commit/push/merge。P0-1通过后停止，P0-2仅可评估开始条件，不自动实施。
