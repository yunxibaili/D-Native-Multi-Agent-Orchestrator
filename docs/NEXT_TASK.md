# 唯一下一任务 — P1.1 候选草案CLI单文件离线负控（待明确批准）

基线§7.88：P1.0仅有限静态验收通过，OpenCode完成独立plan准备入口，实际Go模型已核实，唯一typecheck exit0，Codex未重跑。未运行功能测试、真实生成、stage-check或Round；不能写成P1整体PASS。当前准备的是下一验证片，不是额外实现/测试/模型授权。

## 建议唯一范围

仅由OpenCode修改现有tests/b42-plan-file.test.ts，复用现有check/fixture及新runPlanPrepare的Fake Runtime注入点；不新增测试文件/验证脚本/依赖，不修改生产源码、Runner、安全规则、其他测试或历史失败断言。该套件已在scripts/test-timed.mjs的canonical SUITES登记，不需扩白名单。若负控定位到生产缺陷，保留失败证据并回交Codex，不在测试任务中自行改源码或追加第三轮开发。

## 最小验收矩阵

- 合法2/3候选完整输出：恰1次fresh run、明确model、cwd显式/配置回退、真实请求timeout、无threadId；报告只为draft且后续动作none。
- 产出的planFile能再经既有parsePlanFile，使用外部扁平完成契约；无内部completion或模型额外授权字段。
- 缺失/非法model、objective、cwd、timeout和不支持/混合参数：0次Runtime派发、非零退出；检查plan目标文字为task不被旧分支截获的源码接线。
- 非零退出/signal/error/超时/取消/输出截断/停止不确认：非零退出，不交付有效草案。
- 非JSON/说明或围栏混杂/超64KiB/缺必要契约/非法路径或kind/候选数非2–3：拒绝、不修补、不回退、不追加会话。
- Fake调用链不触及LAYA、计划任务提交、草案测试执行、stage确认或真实模型；不能把prompt的无工具要求写成OS沙箱测试通过。

## 待批准的检查配额

只运行一次typecheck及一次受保护的该单文件；后者走既有白名单Runner和外层sealed Windows Job，TEST_TIMED_SUITES只选择tests/b42-plan-file.test.ts。禁止全量、Live、direct node回退、真实产品Agent/LAYA/Review/Round。OpenCode负责检查并提供真实输出/退出/Job证据，Codex静态审核其代码与日志，不重复运行相同检查。失败即保留证据，本任务不自动消耗第二次运行。

Owner默认零新增测试，因此写入及运行上述现有单文件均须明确批准。本轮P1.0的开发额度和两轮实现次数不自动扩大；后续开发模型/费用按有效声明及各自授权核对，不改全局Free路由，不绕过执行环境拒绝。

## 仍冻结的事项

真实计划生成调用另需当前模型/费用/次数/数据/时限授权；后续多候选LAYA选择会额外增加POST，不能沿用旧3次上限。P0-4.23继续等待上游或执行环境支持的处理，旧费用窗口/confirm无效，不重试被拒操作。无跨进程恢复、模型接力、并行写或正式UI开发。本片完成后再按证据确定下一步，不自动试真实模型。
