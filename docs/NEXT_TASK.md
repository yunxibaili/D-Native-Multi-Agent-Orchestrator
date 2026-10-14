# 下一任务候选 — B4.6 检查点监督与用户纠偏

更新日期：2026-10-14
唯一事实见[PROJECT_BASELINE.md](PROJECT_BASELINE.md)。B2.1/B2.1a用户声明池与最终启动准入已独立PASS（受控最小范围）；本轮停止，B4.6待用户下发。

## 先调查现有入口，再做最小闭环

核对HumanGate、RoundResult/交付视图、DispatchReceipt、DecisionApplication、阶段材料绑定、TaskStore、现有CLI用户输入和停止/继续路径。
目标是让个人用户看清检查点、阻塞和已完成成果，提供一条明确纠偏输入后由同一既有调度链继续；复用已有状态和权威，不做企业审批平台、常驻监督Agent或第二事件/状态机。
先说明哪些用户操作本就可用，哪一个真实缺口值得接线。只选一个有界切片，不预先实施长期checkpoint系统或正式前端。
若涉及续跑或改选，保持fixed锁、实际pair/费用声明、阶段确认digest、失败/stop-unconfirmed的资源保留；不能因用户“继续”绕过门禁或盲重放写任务。
需外部方法依据时采用GitHub MCP/官方资料；纯本地确定性修复无需重复调查第三方方案。测试先hermetic，经真实CLI/Workbench及现有执行路径验证，产品真实Agent/费用另行明确授权。

## 不重做

不重做用户模型池解析、候选/Assignment/reassign、prepare后最终准入、原生Skill/MCP声明与观察、顺序/Git协作和阶段绑定。B2.1a原阻塞已关闭；B2 overall仍未封板。

## 边界

OpenCode开发、Codex独立审核；worker固定DeepSeek V4.1 Flash。PARALLEL_WRITE=CLOSED，B5/正式产品前端未启动。真实资格/硬费用预算/动态共享额度/自动掉线接力没有被本轮交付。
审核后更新唯一基线和本机进度页（全ignored），按已有授权上传独立审核分支，main/index/dirty tree保持。
