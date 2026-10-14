# 下一任务候选 — B4.7 真实 Agent 代表验收

更新日期：2026-10-14
唯一状态与证据见[PROJECT_BASELINE.md](PROJECT_BASELINE.md)。B5.1已知session_failure的安全pair接力受控子集独立PASS WITH P2，整体B5不封板；本轮停止，B4.7真实推理尚未授权。

## 先明确使用范围，再委派小样本

开始先只读读取project-progress/audit/三份观察日志一次，不修改/删除/上传，不把它当状态权威。核对当前源码、基线与已注册adapter的逐请求model/session/工作区能力。优先复用现有CLI、计划文件、stage、池、brief、Assignment、含停止确认的执行与Review链，不新造执行器。
用户先明确两个支持的Agent×Model、是否已含账户额度/允许新增费用、调用次数或金额上限、可发送的数据/仓库与工具范围；没有授权不能用名字/目录/历史零费用推断免费，不调用真实模型测试。可先做只读本机接口核对，未知事实单列。
授权后只做一个小型功能A或B代表流程，记录实际产物、请求与真实反馈身份、Session/Attempt、输入/输出token与已知费用、停止/owned清理、验收与受阻事实。真实provider自动fallback未知时不认证实际模型。hermetic结果不能替代真实运行，DSH无逐请求model不得冒充多模型支持。

## 保留边界

B5.1恢复任务成功只to_verify，全workflow仍待验证/下游；更广服务错误分类、跨进程恢复、副作用去重不一次补平台。fixed/池/最终启动/资源/stage门保持，PARALLEL_WRITE=CLOSED。OpenCode开发、Codex独立审核，worker仍DeepSeek V4.1 Flash，最多实现+一次返工。每片刷新唯一基线/ignored进度数据并上传已审核独立快照，保留main/shared index/dirty树。正式工作台前端未确认，进入前端前先和用户梳理需求。
