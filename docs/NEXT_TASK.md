# 当前任务 — LAYA-QUALITY.2：离线准备完成，待真实调用授权

更新日期：2026-10-15；当前事实只见[PROJECT_BASELINE.md](PROJECT_BASELINE.md)。

LAYA-QUALITY.2离线准备已通过，真实推理NOT RUN：只冻结两个最小案例，正确材料任一明确目标可完成、明显矛盾材料应拒绝；不指定必须选择第二目标，不改问题含义或强制complete。复用既有TaskStore/生产请求构造/provider/decision loop/Verification和owned contained服务清理，不新增生产实现或评测框架。

## 调查与最小验证

本轮先按research-before-work读取当前实现与audit；GitHub MCP成功读取官方固定v0.3.21 staged-adoption，核对shadow记录、审定标签、歧义/unknown及有限放行边界；网页GitHub抓取404未当作MCP失败。参考LangChain官方动态工具过滤方法，不引入框架、换权重、拟合阈值或调温度。上游方法只指导验证，不证明本机模型会作正确选择。

固定请求SHA256分别ee850d7e2b66f6e9447e478128f7f6779240d3ce9887480706d2e002a8439e83与69daf004d9ec39212083c94bb3857b58b4af8028b4a9ef03a25c6b716996fa3c，重复构造一致。实际固定tokenizer/build_sequence离线核对：English465/324、multilingual412/290 tokens，4项均无state截断、候选marker齐全且可区分，低于当前保守512线。未运行forward pass、未启动服务或产品Agent。入口在未授权时真实非零退出，位于服务/控制目录创建之前，状态与证据文件未改。

## 已冻结的两个案例

1. 正确材料：两任务各自要求add(2,3)=5、subtract(8,3)=5，输出分别明确得到5；均to_verify、ready为空。候选wait/abort及两个分别绑定的complete，无continue。选择任一合法目标后，只能由既有Verification完成该目标，另一任务不变；安全弃权如实记录为未观察到正向完成。
2. 矛盾材料：要求add(2,3)=5，输出明确返回6；材料非空，因此complete仍是待模型判断的候选，不能靠资格过滤隐藏错误材料。wait/abort应保持任务不变；错误complete记录判断失败，shadow边界不将其变成成功，停止而不改答案。

## 真实执行范围（当前未启动）

拟申请新增最多2次本地LAYA POST，每次90秒，只用现有离线缓存/合成内存材料；首例未完成或任何错误立即停止、不重试，次例仅在首例实际完成后运行。首例wait/abort是安全但正向完成未观察，不能写PASS；次例错误complete必须BLOCKED且由shadow边界阻止错误状态变更。结束必须验证owned Job空/清理。当前仅已提出具体授权选项，尚未收到新增调用答复，inferenceAllowed=false；旧11次本地额度与产品5/5不重置，产品/云模型/新增付费均不允许。

不自动重跑旧三例，不另建评测/调度框架。只需复用已准备入口，在收到明确答复后一次性启用；未授权时继续保持禁用，不让“继续任务”重置旧硬上限。

## 当前边界

本轮src/tests/native/scripts零改动，无需重跑typecheck/fullsuite。历史ACTION.3仍BLOCKED；QUALITY.1代码PASS保持。估算68/100不变、PARALLEL_WRITE=CLOSED、正式前端未进入。个人Skill/本机页面/audit/捕获证据不入Git；更新基线和页面后只上传文档，不合入main或改变共享index。
