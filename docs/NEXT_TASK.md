# 下一候选 — B4.7.2a Demo内最小任务说明与受控回归

更新日期：2026-10-15
状态、证据、预算与估算唯一见 [PROJECT_BASELINE.md](PROJECT_BASELINE.md)。本页是建议范围，不授权下一次真实调用。

## 当前结果

B4.7.1a/1b 的台账、身份、预算及目标/范围/验收路径修复均独立通过。B4.7.2 的一次真实样本在第一个Space Bunny会话停止：空demo里无代码，模型转向read目录外aux配置，被OpenCode headless自动拒绝；exit0、最后tool-calls、目标文件缺失。Node实际拒绝该交付，整轮exit1；第二成员及集成未派发。两个Job验证空，确切失败证据目录按原策略保留。不是路径回退、模型不存在或Job停止失败。

## 最小建议范围（未实现）

在既有tests/b47-free-duo.test.ts建立新demo时，只准备cwd内README/TASK说明与provider/consumer/integration目录骨架。说明：空demo是预期起点、职责/路径/验收已明确，任务不依赖repo/API配置，也不需读取aux/store/兄弟目录。说明进入现有task brief；不复制当前仓库代码，不预写模型应交付的add或测试实现。
测试走同一个demo准备函数和真实候选/brief路径，验证该说明在Agent启动前完整存在、能被任务读取、目标文件仍缺失、原缺失交付仍会拒绝。复用已有builder/目录/owned helper/ledger，不再造执行器或第二系统。
仅由指定DeepSeek worker做bounded test-only修改，Codex独立审核，默认最多首次+一次返工。首选仍仅两个b47测试文件；未授权修改生产代码、全局设置、Agent安装或扩大权限。

## 权限与调用边界

不加--auto/--yolo/dangerously-skip-permissions，不自动批准external_directory或读取demo外配置。减少无必要探查只是建议，不能保证真实模型执行质量。CLI exit0仅是当前adapter的运行判定，产品交付仍必须由真实产物/独立验证认证；不能把permission拒绝后to_verify标记成功。
本次失败后已经停止，不自动重跑。累计授权上限4已用2、剩2；下一完整duo需要3个会话，如以后实跑仍需明确追加1个。免费pair/新建隔离demo/各90秒/不收费/不另启LAYA-Review的原范围保留。不因“继续”重置次数。

## 不扩阶段

PARALLEL_WRITE=CLOSED；B4.7/B整体NOT SEALED；正式工作台前端仍未确认。本片若下发只修准备材料，未经新的实跑确认不得调用产品模型。

## 结束维护

开始只读读取project-progress/audit；结论以独立证据为准。同步唯一基线、受影响路线文档和ignored进度页；独立审核后上传前向快照，不改主HEAD/index，不上传page/audit/native export或原生数据。
