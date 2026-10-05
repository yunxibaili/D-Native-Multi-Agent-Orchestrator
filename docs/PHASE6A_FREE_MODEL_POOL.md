> **[Historical — 2026-09-30 快照]** 模型可用性以本机 `opencode models` 实时输出
> 为准（本文件为当时实测）。当前基线见 docs/PROJECT_BASELINE.md。

# Phase 6A-0 — 本地免费模型候选核实（Free Model Pool）

```text
Status   = VERIFIED · local evidence only · 2026-09-30
Scope    = 资格确认，不是能力 benchmark；未改 Runtime / Scheduler / Laya
Evidence = 本机已安装 CLI 实测（版本号 + 真实调用 + result frame），无网络资料猜测
```

## 1. 候选池总表

| Candidate | Agent | 实际 modelId | 免费状态 | 额度证据 | Runtime 可调用 | 当前结论 |
|---|---|---|---|---|---|---|
| Space Bunny | OpenCode 1.18.31 | `opencode/space-bunny-free` | **confirmed free**（id 含 `-free`；实测 `costUsd: 0`） | 真实调用 `MODEL_OK` exit 0（8s）；C-Forge child run usage `costUsd: 0` | YES — adapter `-m` 直传，session/transcript 正常 | **ACTIVE** |
| MiMo 2.6 Flash | OpenCode 1.18.31 | `opencode/mimo-v2.6-flash-free` | **confirmed free**（同上） | 真实调用 exit 0（12s）；同上 costUsd 0 | YES | **ACTIVE** |
| Hy3 | **WorkBuddy Intl**（CN 构建未认证，见 §3） | `hy3` | **$0 confirmed at call time**（result frame `total_cost_usd: 0`）；是否限时/有额度上限 **unknown**（本机无 quota 查询面） | codebuddy 2.137.1 `--model` 帮助明确列出 `hy3`；真实调用 exit 0，result frame `"model":"hy3"`，session_id 返回 | YES — workbuddy adapter `--model <id>` 直传（`modelSelection: true`，已验证） | **ACTIVE**（仅 Intl） |
| Codex Reviewer | Codex 0.158.0-alpha.2.1 | n/a（review 入口，不由 Laya 竞争执行池） | 不属于执行候选；走既有 Codex 账号 | reviewer smoke：静态文本 → 输出 `PASS`，exit 0（4s），transcript 落盘 | YES — 现有 `review` mode 复用 Runtime，无新 framework | **DEFAULT REVIEWER** |

冻结规则：

```text
执行 active pool = { opencode/space-bunny-free, opencode/mimo-v2.6-flash-free, workbuddy-intl hy3 }
default reviewer = codex（执行完成后 review/verification，不参与执行模型竞争）
未在本表 ACTIVE 的组合，Laya 不得分配
```

## 2. 明确排除 / 勘误

- **`mimo-v4-flash-free` 不存在**。当前本机 `opencode models` 只有 `mimo-v2.6-flash-free`；`-m opencode/mimo-v4-flash-free` 实测 exit 1 `UnknownError`。历史记录中的 v4 引用一律作废，不得进入候选池。
- `opencode-go/*`（含 glm-5.3 等）不在免费池内，本轮不启用。

## 3. WorkBuddy CN vs Intl（本地实测）

| 构建 | 二进制 | 认证 | Hy3 |
|---|---|---|---|
| workbuddy-cn | `D:\workbuddy\...\codebuddy` | **未认证**（实测：`Authentication required`，adapter 注释记录 401 vs copilot.tencent.com） | 不可调用 |
| workbuddy-intl | `D:\workbuddy ai\WorkBuddyAI\...\codebuddy` 2.137.1 | 已认证 | **可调用，`--model hy3`** |

## 4. 免费状态口径（防"没查到价格=免费"）

| 状态 | 本轮判定 |
|---|---|
| `confirmed free` | Space Bunny、MiMo 2.6（`-free` 模型 id + 本机真实 run `costUsd: 0`） |
| `$0 at call time` | Hy3（result frame `total_cost_usd: 0`）；额度上限/限时性 unknown |
| `free quota` / `temporary free` | 本轮未发现任何本机 quota 查询面可判定，不使用该标签 |
| `unavailable` | `mimo-v4-flash-free`；workbuddy-cn |
| `unknown` | 三个执行候选的 rate limit / 每日额度数值（本机无查询面，留待运行期观察） |

## 5. Runtime 接线事实（5C-4+ 已有能力，本轮未改）

- `RunRequest.model` → OpenCode adapter `--model <id>`（`-m`），WorkBuddy adapter `--model <id>`；orchestration `buildRunRequest` 直传 `Task.modelId`，不做默认替换。
- Codex review：`mode: 'review'` → 既有 review 入口；reviewer 由 `applyVerification` 语义承接，`to_verify → succeeded` 只认 verdict。
- Laya 下一阶段只做"从 active pool 选谁"的路由决策；禁止按任务类型写死模型偏好（路由依据 = 任务状态/能力/历史结果/可用性）。

## 6. 最小 smoke 记录（2026-09-30）

| 候选 | 调用 | 结果 |
|---|---|---|
| Space Bunny | `opencode run -m opencode/space-bunny-free "Reply …AGENT=…"` | exit 0，8s，回复正确 |
| MiMo 2.6 Flash | 同上（`mimo-v2.6-flash-free`） | exit 0，12s，回复正确 |
| Hy3 | `codebuddy -p … --model hy3 --output-format stream-json` | exit 0，16s，`model:"hy3"`，`total_cost_usd: 0`，session_id 返回 |
| Codex Reviewer | `orchestrator review codex "静态 review 测试…"` | exit 0，4s，输出 `PASS`，transcript 落盘 |
| workbuddy-cn（对照） | `codebuddy -p … --model hy3` | `Authentication required` → 排除 |
