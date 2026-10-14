# 下一任务候选 — B2.1 用户模型池与费用策略最小闭环

更新日期：2026-10-14
B3.1/B3.2的Skill/MCP候选、advisory请求与有来源事件观察已独立PASS（受控有界范围）；B3整体未封板。
本轮停止，B2.1待用户单独下发。唯一当前状态见[PROJECT_BASELINE.md](PROJECT_BASELINE.md)。

## 已完成，不重做

原生Skill/MCP声明目录、任务级选择或none、同一brief/dispatch入口与来源报告；名称碰撞拒绝、跨Agent关联及首任务接线已验证。
MCP没有被自动连接或授权；提示选择不会裁剪原生工具定义，不以受控frame认证真实服务调用。

## 下次先调查，再确定最小切片

用户授权后先核对ModelRegistry、SelectionSpec/explicitPair、Assignment、quota、Spawn Gate与RunResult/Attempt费用事实。
目标是让用户限定允许的Agent×Model池与免费优先/已授权付费策略，LAYA只能从有效池中选择，fixed仍精确接受或拒绝。
优先复用现有成本/额度字段与拒绝入口；未知费用不是免费，单次cost=0不是长期免费，固定付费pair不等于支出授权。
通过官方当前资料与GitHub MCP核对可取得的事实，再定允许修改文件；不提前猜免费模型名单/共享额度，不建排行榜、模型网关或新预算平台。
先做hermetic闭环和真实拒绝证据；真实模型、额度查询、费用或本机配置写入如有必要先明确范围。

## 保持边界

OpenCode开发、Codex独立审核；worker固定opencode-go/deepseek-v4.1-flash。
PARALLEL_WRITE=CLOSED，B1/B4/B3整体未封板，B5与正式前端未启动。
project-progress全部ignored、不入Git；正式工作台前端需求另行确认。
