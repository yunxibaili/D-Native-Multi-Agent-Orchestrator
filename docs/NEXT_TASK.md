# 下一任务候选 — B3.1 Skill/MCP 最小闭环

更新日期：2026-10-14
B4.5/B4.5a已由Codex独立PASS（Git根目录/committed base/单组隔离worktree顺序协作的受控最小范围）。
本轮到此停止，B3.1待用户单独下发。唯一当前状态见[PROJECT_BASELINE.md](PROJECT_BASELINE.md)。

## 已完成，不重做

停止未确认的运行期保留声明已接到审核/ok/退出码/最终Human Gate；no-review不豁免。
workspaceId匹配与规范化scope重叠均有真实CLI回归，非重叠组不误伤；两组独立内存负控确能使suite非零失败。
不重审完整T/W，不再新建Git合并引擎，Git更广工作区支持按使用反馈后置。

## 下一阶段准备方向

用户授权后，先调查仓内Skill intent/capabilities/RunRequest/Attempt与本机已安装Agent的原生Skill/MCP接口；
核对当前版本官方资料和成熟可复用实现，再形成一个最小有界切片。
目标是LAYA为任务选择必要Skill/工具，减少无关上下文；requested/admitted/实际observed分别记录，不能把目录当已加载/已调用。
优先一个已有Agent的原生入口；必要工具不支持就明确拒绝，不建通用MCP代理/新调度权威/第二registry。
具体可用协议、允许修改文件、是否需要真实模型费用授权，留到调查后决定；本文件不猜参数、不提前实现。

## 保持边界

OpenCode开发，Codex独立审核；worker模型opencode-go/deepseek-v4.1-flash。
PARALLEL_WRITE=CLOSED，B1/B4整体未封板。真实模型/费用/凭据与本机Agent配置变更仍需明确范围授权。
project-progress/全部ignored、不得入Git；正式工作台前端需求仍待单独确认。
