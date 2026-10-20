# 唯一下一任务 — P0-4.13 单次Reviewer结构化协议验证（待新调用授权）

当前事实见PROJECT_BASELINE.md §7.73。Owner已批准Round独立审核改用专用codex exec --output-schema；OpenCode已完成三文件实施，Codex独立静态PASS。类型检查/diff各一次exit0，未运行测试/真实产品调用；不能宣称安装版协议或真实Review通过。

## 已实现

- runUnifiedReview保持单次Runtime.review，Codex请求显式schema路径及read-only；adapter复用既有fresh exec profile/ManagedProcess，同模型、独立Session、deadline与清理不变。
- 无schema的旧exec review保留；非法/重复schema selector及review+threadId拒绝。普通Worker调用不变。
- verdict等模型判断仍须严格合法；reviewer/reviewedAt由主机绑定，无默认pass、无patch-is-correct转换。
- P0-4.11仍PARTIAL：两个真实Go Worker/批准测试完成；旧Review无合法verdict，不回填或追认。

## 唯一最小待授权验证

只新增1个Codex gpt-6.1-sol独立审核Session，90s真实process deadline，失败不重试。复用D:/workbench-demo/p0411-20261020T040805Z的已交付add.js/add.test.js与本轮保存的真实Review packet；不重新启动Worker/LAYA，不创建新Round、不改旧任务状态或Human Gate。

复用现有CLI review命令和--extra接口：额外分别传--output-schema与静态schema绝对路径（建议--extra=...形式），--sandbox read-only、指定model/timeout/live-agent/json，仍经sealed owned Job启动。实际请求正文来自已核对的历史packet，不把自然语言“patch正确”当作产品verdict。保存原始UTF-8输出、Session/模型与Job停止事实，核对必需JSON字段及负面结论；本次仅协议/独立审核验证，不冒充整轮E2E PASS。

执行前需Owner对新1会话范围与当前订阅包含额度/无额外credits/API余额/自动充值/fallback的费用声明作新确认；旧产品预算已耗尽，开发委派不继承产品预算。未获得新授权前不运行真实审核、CLI探针或模型。

保持单Session、无重试、无模型替换、无自动后续动作；无论成功失败都按既有owned marker/Job清理，确认ActiveProcessesFinal=0。不改生产源码/旧Demo配置/pool/digest/历史结果，不新增测试/临时脚本，不升级组件。下一真实完整Round仍需单独决定。

阶段归档由Codex使用独立索引精确提交3个源码资产+基线/NEXT_TASK，不包含project-progress/本机证据或凭据，不合并main；主HEAD/index和范围外dirty保持。