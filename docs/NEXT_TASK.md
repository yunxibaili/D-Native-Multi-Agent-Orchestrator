# 下一任务候选 — B3.2 原生 MCP 最小闭环

更新日期：2026-10-14
B3.1任务级原生Skill有界切片已由Codex独立PASS；B3整体未封板。本轮停止，B3.2待用户单独下发。
唯一状态见[PROJECT_BASELINE.md](PROJECT_BASELINE.md)。

## 已完成，不重做

显式用户声明Skill候选，经现有DecisionProvider逐任务选择或none，经原生advisory brief请求，报告区分requested/admitted/latest-run观察。
首任务及协作集成者接线、跨Agent来源、ownership守卫已收口；不重建执行器/调度器。

## 下次最小准备方向

用户授权后，先核对一个已安装Agent的当前版本原生MCP目录/调用/权限接口，以及仓内已有工具事件和任务意图。
用GitHub MCP与官方同版本资料确认可复用能力；有证据才确定代码范围，不凭空发明CLI参数。
目标是任务级具体工具选择及有来源的调用观察；没有原生强制限制不能声称权限隔离，目录/连接/授权/调用分别记录。
不新建通用MCP网关、SDK代理、第二registry或调度authority，不读取/搬运凭据或擅改本机Agent配置。
真实模型、第三方服务、费用与配置写入如有需要须先明确范围；hermetic开发可先做，不以fixture认证真实调用。

## 保持边界

OpenCode开发、Codex独立审核；worker固定opencode-go/deepseek-v4.1-flash。
PARALLEL_WRITE=CLOSED；B1/B4/B3整体未封板，B2/B5与正式前端本轮未启动。
project-progress全部ignored，不入Git；正式工作台前端需求另行确认。
