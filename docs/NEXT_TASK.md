# 下一候选 — B4.7.2 一次完整真实 free duo

更新日期：2026-10-15
状态、证据及估算唯一见 [PROJECT_BASELINE.md](PROJECT_BASELINE.md)。本页只描述下一任务范围，不另行封板。

## 当前已关闭

B4.7.1a 的 Node 台账/身份/预算接线、B4.7.1b 的目标/范围/验收路径均独立通过。现有入口使用 `src/provider/add.mjs`、`src/consumer/add.test.mjs`（导入 `../provider/add.mjs`）、`src/integration/`。定向入口96/0、独立7个contained Node检查及旧路径负控通过，不重复写执行器、调度器或协作计划。

历史真实 Space Bunny 按正确 scope 交付，模块已独立通过5案例；完整 MiMo 任务及集成模型执行仍未验证。fixture、默认NOT_RUN或消费者测试通过不等于真实多模型成功。

## 唯一待追加范围

原批准最多3个产品原生执行会话，已实际使用1个、剩余2个。本次产品调用新增0。一次新的完整duo需要3个会话，须明确允许新增1个、累计上限改为4后才能实跑；不因“继续”重置计数、不自动重试。
已批准的其他范围保留：`opencode/space-bunny-free` + `opencode/mimo-v2.6-flash-free`，仅新建隔离demo、每个执行最多90秒，不使用收费模型或另启LAYA/Review，免费条件或停止事实未知就停。

## 执行与验收

复用已审核的 `tests/b47-free-duo.test.ts`、用户声明池、owned配置、生产Workbench→Assignment→Session→Scheduler→Runtime路径；开发仍由指定DeepSeek worker承担，Codex独立核验，修复最多首次+一次返工。不从头实现同等入口。
记录同次Attempt、本地session与native thread、实际反馈模型、真实文件字节与独立Node结果、validated Job空和owned清理；价格声明、native消息cost与账户实际费用分开。任何前置失败或交付失败阻断下游，不用fake PASS补真实模型证据。

只完成该一次样本并给PASS/BLOCKED，不扩大其他阶段。PARALLEL_WRITE=CLOSED；正式产品前端仍未确认。

## 结束维护

开始只读读取 `project-progress/audit/`；结果以独立证据为准。更新唯一基线、受影响文档和ignored进度页，审核通过后上传前向快照，保留主HEAD/index/已有dirty树。页面与audit永不进Git。
