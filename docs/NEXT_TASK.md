# 唯一下一任务 — P0-4.15 Reviewer可选连接进程级缩减验证（待新授权）

依据PROJECT_BASELINE.md §7.75，P0-4.14只读核对完成；P0-4.13真实验收仍BLOCKED，旧Round仍PARTIAL。当前没有新模型调用授权。

## 已过滤的资料

不采用未在核对官方schema中定义的enable_mcp/check_for_updates；check_for_update_on_startup是软件更新检查，不是目录刷新开关。不能把turn_started当作初始化结束边界，不能把63.89秒全归因于schema或Skill；实际Skill工具仅201ms。high推理强度是已记录变量，不是根因。没有本机证据证明Defender/Job句柄争用。

## 唯一最小待授权方案

仅下一次Reviewer进程，用已有extraArgs→Codex -c传递官方支持的进程覆盖，关闭不需要的Apps及已知MCP连接：

- features.apps=false
- mcp_servers.node_repl.enabled=false
- mcp_servers.github.enabled=false

均为候选、未设置/执行；官方资料不证明安装版及managed/plugin来源下全覆盖。保留gpt-6.1-sol、高推理强度、原始审核材料/schema、read-only、90s真实deadline、AGENTS/Skill、安全验证和owned Job；不替换目录缓存、不改模型或同时调整时限。

复用既有review CLI和schema资产，不改生产源码、不新建配置/Workflow层、不需开发Worker。若新授权，仅1Reviewer原生会话、0重试、0Worker/LAYA/Round、0新增收费；费用确认与授权必须有效。按真实事件比较连接诊断及阶段时间，失败立即停止，不为通过追加推理或修改prompt。

CLI多个raw参数必须采用重复分隔形式--extra <value>，避免现有重复--extra=value覆盖问题。需要传给原生CLI的参数为-c <key=value>，经既有extraArgs数组转发；不要修改全局config.toml或忽略规则。

无论结果如何，保存原始UTF-8输出、模型/Session、deadline和Job停止证据，确认ActiveProcessesFinal=0；不覆盖旧结果或追认E2E PASS。当前只形成方案，等待Owner决定。

资料：官方配置参考https://learn.chatgpt.com/docs/config-file/config-reference；固定schema与本机核对见project-progress/p0414-research-assessment-20261020/assessment.json（不入Git）。