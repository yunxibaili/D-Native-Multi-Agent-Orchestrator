# 唯一下一任务 — P0-4.14 Reviewer启动与首轮响应只读定位（待Owner决定）

当前事实见PROJECT_BASELINE.md §7.74。P0-4.13真实验证BLOCKED：唯一gpt-6.1-sol Session在90s截止，输出0，无verdict；没有重试。原生turn_context已证明实际模型与read-only。全部owned Job final0、cleanupFailures=[]，旧Round和Demo未改变。

## 唯一最小方向

先只读分析现有原生trace/诊断/时间线和受支持的进程级配置，区分启动目录刷新、MCP握手、模型首轮等待及指令读取。事实：turn_started约15.5s，首次Skill读取约79.4s，90s截止；有目录刷新timeout/MCP transport错误，但不能据此认定唯一根因。

需要Gemini/官方资料辅助核对当前Codex0.163.0-alpha.10.2的exec初始化及MCP/目录刷新行为、是否存在官方支持的单次进程级隔离方法。保持认证、规则和原有安全边界，不读凭据、不修改全局配置，不自动忽略AGENTS/Skill或提高deadline。先形成有根据的最小方案，不新增框架/源码补丁或新调用。

## 明确保留

- P0-4.12专用exec --output-schema静态PASS，已真实进入Session；最终schema输出仍未验。不能因一次超时认定schema无效，也不能认定适配已真实PASS。
- P0-4.11仍PARTIAL，不回填旧Review/Human Gate；未来完整Round需单独授权。
- 本次预算Reviewer1/1已用，Worker/LAYA/Round均0；费用窗口内剩余时间不等于新会话授权。
- 单次review CLI必须重复使用分隔形式：--extra --output-schema --extra <schema绝对路径>。现有generic parser的重复--extra=value会覆盖前值，导致前置拒绝；这是验证命令的既有接口限制，不影响Round内部extraArgs数组。当前不改parser。

不运行新CLI探针/模型/服务/测试，不升级组件，不新增或修改测试/验证脚本。保持HEAD/index/范围外dirty与所有旧证据；如后续确需开发，仍由OpenCode实施、Codex审核，并核对新的开发模型/费用授权。

证据目录project-progress/p0413-review-protocol-20261020仅本机保留。阶段仅精确归档基线/NEXT_TASK；不得上传project-progress或合并main。