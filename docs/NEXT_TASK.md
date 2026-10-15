# 下一候选 — LAYA 本机就绪与普通 CLI 显式模型候选

更新日期：2026-10-15
事实/阶段/估算唯一见 [PROJECT_BASELINE.md](PROJECT_BASELINE.md)。B4.7.4只读核对已完成，不启动下一代码切片或推理。

## 已确认的两个问题

1. 默认LAYA地址8077的GET /health返回ECONNREFUSED。当前PATH无laya-serve，两个可用Python环境未发现laya分发包；不能据此推断全机未安装。现有provider、--probe与工作流/pair/Skill-MCP决策入口已存在，不再造一份。
2. 普通round的seedRegistry只取配置默认model、quota probe modelHint与历史thread。用户模型池只过滤，不创建新候选。独立纯值6断言证明：2模型声明在空配置/历史下候选0、单配置1、双历史2。B4.7.3代表样本使用显式测试驱动，不等于普通CLI已接通。

## 最小推进顺序

**LAYA环境**：先定位已有venv/启动方式及实际端口；上游默认8000与项目8077不同。复用现有GET健康检查，无任务文本/认证/推理。不能擅自安装依赖/权重、修改全局配置或启动未知服务。若需安装/启动，先形成明确的本机范围。

**B2.2代码候选**：仅在用户显式--model-pool时，将明确声明的精确Agent×Model作为候选来源接到现有registry；优先复用seedRegistry和原池解析/最终准入。默认不传池行为不变；不自动导入doctor目录、不硬编码free名单、不改费用/availability事实。未知quota仍拒绝，已有fixed、pair唯一性和最终同步启动门保持。先hermetic证明完整候选/分配/拒绝语义，再审是否需要真实验收；不用真实模型为开发探路。不新建manager/router/第二registry或放宽Spawn Gate。此项为有界建议，未实施或独立PASS。

## 范围与授权

B4.7.3两真实模型/三任务代表样本历史PASS保留；产品会话累计5/5、剩0，不自动重试或重置。新推理须另定模型、次数、费用及数据范围。真实Skill/MCP、动态账户额度、完整用户批准/监督与更广掉线恢复仍是后续差距；工程估算保持68/100。
不自动进入F0；正式前端需求仍待确认，页面仅本机只读展示。PARALLEL_WRITE=CLOSED。
OpenCode负责授权的bounded实现，Codex独立审核，默认首次+一次返工。每次先只读audit，结束维护唯一基线/受影响文档、刷新本机进度页并上传审核快照；page/audit/exports不入Git，主HEAD/index/dirty树保留。
