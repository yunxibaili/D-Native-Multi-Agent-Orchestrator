# 唯一下一任务 — P0-4.3 原生配置与权限来源静态核对（只读）

P0-4.2无推理预检材料PASS，见PROJECT_BASELINE.md §7.52；当前池已过期，真实执行仍关闭。不要重复问已确认过的资格，也不要现在刷新池或重跑stage-check。先把原生配置核清，临近实跑再统一生成新声明/digest。

## 范围

读取AGENTS、研究Skill、最新基线/NEXT、audit相关只读记录、新Demo control、workspace及必要的父级项目配置来源。跟踪src/adapters/opencode.ts createTransport、实际RunRequest构造、src/runtime/spawn.ts buildEnv和当前安装包可读的配置解析实现。

不读取auth.json、账户令牌、Key/密码；原生配置仅提取所需非敏感字段，不输出完整全局配置或环境变量。对环境只记录必要变量名是否设置，配置路径可在确认非敏感后报告。不能执行debug config、版本/模型目录探针、原生Agent或任何模型调用来代替静态证据。

## 仅回答一张表

对下列字段列出：产品传入值、原生可核实来源/优先级、实际已知值或unknown、费用/权限影响：
1. 主模型--model及provider；
2. small_model、原生辅助调用与fallback来源；
3. --agent/build/default agent：没有role时谁决定；
4. OPENCODE_CONFIG、父目录opencode.json和全局配置是否可能参与；
5. read/write/edit/bash及external_directory等有效权限，是否存在未答复ask导致headless挂起；
6. cwd、allowedScope与原生权限各自能约束什么。

仅围绕本次两个Worker和一个Reviewer，不扩展全部模型、Skill/MCP或历史阶段。

本机包装层目前已知：--model来自req.model，只有req.role存在才传--agent；spawn允许继承OPENCODE_CONFIG；adapter无OS sandbox能力。不可据此臆测small_model已固定或文件读取已隔离。

无法从当前版本可读源码或已有官方依据确认的，标记unknown，最多列3个具体问题交Gemini。禁止逆向提取凭据、扫描进程内存、盲试配置或用最新仓库行为冒充安装版行为。

## 交付与停止

返回READY/BLOCKED（仅针对原生配置核对）、来源路径/行号、唯一最小配置建议及仍需Owner接受的真实执行边界。无必要就不制造实现任务；严格数据隔离无法由现有能力保证时明确说明，不新建沙箱/网关/权限框架。

不修改任何文件，不启动服务，不跑CLI/stage-check/测试/typecheck，不刷新池，不做Git写操作。完成后停止，交Codex审核。代码/文档提交推送由Codex负责。
