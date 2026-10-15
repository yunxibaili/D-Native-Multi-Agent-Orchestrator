# 下一候选 — LAYA-ACTION.3 修复后真实本地动作验收

更新日期：2026-10-15；状态只见 [PROJECT_BASELINE.md](PROJECT_BASELINE.md)。

## 已独立完成

LAYA-CONTEXT.1代码独立PASS，整体PASS WITH P2：bounded workflow状态/材料只去掉重复元数据，同任务objective/criteria/output及缺失/截断标记完整保留；原生响应后、任何动作应用前检查checkpoint与token信息，缺失/非正/非有限/未知checkpoint或达到保守512线拒绝，不重试。无material旧11动作与非LAYA通用seam保持。离线实际tokenizer验证双目标原样本由丢383 tokens变为全量可见：English300状态tokens、完整序列494；multilingual完整序列442。中英文/Unicode/长材料共8回放，长材料确认超限；不是模型forward或真实选择验收。
独立typecheck及decision429/0、state-loop236/0、CLI93/0、workbench419/0、协作96/0、计划61/0、阶段材料47/0均实际exit0；负控移除守卫变211/25、exit1，五个continue探针验证动作前拒绝。两轮指定模型委派，首轮权限拒绝未实现，最后一轮正常完成；无额外重派。

## 下一候选（准备，不自动推理）

下一候选LAYA-ACTION.3：使用修复后的生产provider/loop，准备最多3次新的本地合成动作/目标验收（双目标、缺交付、ready各一次），每次90秒，失败即停、不重试；目前未获新增推理授权。继续只用固定离线缓存，不调用产品Agent/云模型、不发送仓库代码、不新增付费。已有本地8次与产品5/5均保持；wait/abort/continue如实记，不改答案或自动追试。
只使用新内存合成任务与同任务材料，沿实际createLayaDecisionProvider/runDecisionCycle；complete若被选中必须只触及对应Task与原Verification，缺材料不得提供complete。continue只到受控拒绝回执，实际Runtime/Agent不准启动。原生输入饱和/未知则立即停止，不能调长模型或替换答案。

## 支持范围与P2

守卫在响应后生效，仍消耗一次决策调用，不是发请求前精确计数。实际固定english配置512/192，multilingual为1024/256；代码统一以512保守拒绝，多语言可能在本可容纳时被拒。源码注释和worker报告误把两者容量都写512，独立审核保留P2并在文档纠正，不把它提升为事实；后续限定维护纠正文案，当前不扩大预算。仅已固定配置假设内的有界保护，不认证任意服务配置/模型判断质量或完整round。
旧B45负控定位P2/温度校准P2仍保留。复杂自由参数动作和完整真实round未收口；不封整个B/W，不开放PARALLEL_WRITE，不进入正式前端。工程估算68/100（界面70/30取整）保持，代码测试数不增加进度。

只读audit，结束更新唯一基线与本机页后精确审核上传；页面/cache/audit/本机证据不入Git，main/共享index和其他dirty保留。没有新增功能需求时无需再启动worker。
