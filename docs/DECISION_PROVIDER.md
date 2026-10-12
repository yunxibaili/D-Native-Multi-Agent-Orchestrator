# LAYA DecisionProvider 接口

更新日期：2026-10-12
状态：当前源码参考。旧版本的本机测量和历史调研已归档，不作为本轮运行验证。
当前阶段与授权只见唯一 [项目基线](PROJECT_BASELINE.md)；下述工作流扩展尚未实现。

## 1. 角色

LAYA 是结构化任务级决策模型。它不仅用于分类，当前已有 Agent × Model 选择、
任务级决策和 READ topology 等调用预设。未来需求增加 Skill/MCP 能力选择。
底层 provider 只回答问题，不启动 Agent、不选择 native thread、不直接执行工具。

DecisionRequest → DecisionProvider → 本地 laya-serve → 校验后的 DecisionResponse。

## 2. 接口与预设

| 源码 | 职责 |
|---|---|
| ../src/decision/types.ts | DecisionRequest/Response/Provider 和 typed questions |
| ../src/decision/laya.ts | 本地 HTTP、输入/输出校验、metadata |
| ../src/decision/routing.ts | 任务类型/复杂度等分类 |
| ../src/decision/initial-assignment.ts | 从给定 Agent × Model 候选中选择 |
| ../src/decision/execution-topology.ts | SOLO/PARALLEL_READ 预设 |
| ../src/decision/errors.ts | 输入、schema、timeout、transport、unavailable 错误 |

调用方声明答案空间，返回值必须属于该空间。不能编造模型/候选。
只有唯一候选时应由明确的既有规则处理，不能伪造一次有意义的 LAYA 选择。

## 3. 本地服务

默认地址 http://127.0.0.1:8077。provider 不自动启动 Python/CUDA 服务，
没有隐式云端 fallback。非 loopback 地址需要显式 allowRemote 授权。

手工启动已有安装：

    laya-serve

检查入口：

    node src/decision/check.ts --probe
    node src/decision/check.ts "summarize a repository"

这些命令不是本轮执行记录。服务、checkpoint 和版本应以本机实际安装为准，
不能把上游新版本的 MCP/SDK 能力直接视为本项目已接入。

## 4. 当前请求约束

支持 choice、score、noul，具体字段以 types.ts 和 laya.ts 的校验为准。
拒绝空问题、缺少内容、未知类型、无效 instructions/state/context 和退化答案空间。
choice 至少两个有效选项；score 至少两个有效 level；
noul criteria 使用 true/false 键和有效描述。

源码当前限制包括：state 50,000 chars、64 questions、单题 100 choice options、
32 score levels、总 options 512、body 2,097,152 bytes。
这些是当前客户端约束，不是对所有上游版本的永久保证。

响应即使 HTTP 2xx，也必须校验回答完整性、type、候选/level、概率和置信度结构。
choice/score/noul 的概率/置信度规则不同，不能统一套用一个阈值公式。
HTTP 200、模型自报 confidence 或 token 数不能证明任务完成、工具调用或预算安全。

## 5. 失败语义

输入失败不发请求；超时、不可达、非成功 HTTP 和 schema 错误明确返回对应错误。
provider 不偷偷选择默认答案。上层如有已定义的 SOLO 等兼容行为，
必须保持可观察且与具体契约一致，不能泛化为任何失败都可猜答案。

LAYA 置信度需在本任务域评估，不作为绕过硬约束的授权。
usage 和 metadata 只记录实际返回值，缺失不编造成零。

## 6. 相关验证

    node tests/decision.test.ts
    node tests/initial-assignment-decision.test.ts
    node tests/live-decision-check.ts

最后一项需显式选择，依赖真实 laya-serve；本轮未运行上述测试。
新增 Skill/MCP 选择的验收见 [后端需求 REQ-06](BACKEND_REQUIREMENTS.md)。

## 7. 新需求接线边界

LAYA 决策包含两个层次：选择合适工作流/分工；再为各独立任务选择具体 Agent × Model。
同目标组的成员职责与集成意图也应进入合法候选，不能成为另一个主管 Agent 的自主调度权。
候选内容由用户、明确模板或已授权 Agent 提供；新 B4.0 从有界候选计划选择，复用现有 typed choice，
不要求 LAYA 输出任意 JSON DAG，也不强制新增一次规划模型调用。
候选 DAG 先校验，再提交；用户 fixed 是硬约束，不能作为可被模型评分覆盖的偏好。
只有唯一候选时保持明确的无选择规则，不伪造 LAYA 已比较多个方案。

Skill/MCP 的任务级决策、可用性与实际调用核对仍是后续能力，不借现有 skills boolean 冒充目录。
请求的模型不等于服务端实际模型；DSH 未支持的逐请求选模型不能以提示词参数伪装实现。
LAYA 失败沿既有可观察失败语义处理，不猜计划、不生成免费资格、不解除 fixed。
