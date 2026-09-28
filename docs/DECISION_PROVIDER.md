# DECISION_PROVIDER — Laya verified locally

Status: **verified working on this machine.** Implemented in `src/decision/`.
Phase 1 runtime is untouched: nothing here is wired into `src/orchestrator/`.

## What was verified

| Fact | Measured value |
|---|---|
| Package | `laya==0.3.21` (Python), installed in `C:\Users\Admin\laya-venv` |
| Torch | `2.11.0+cu128` (CUDA build; the default PyPI wheel is `+cpu` and cannot use the GPU) |
| GPU | RTX 5070, 12 GB, compute capability `(12, 0)` — `torch.cuda.is_available()` → `True` |
| Checkpoints | `english`, `multilingual`, `typed-decisions` from `convaiinnovations/laya`, revision `55cf4c4e` |
| Checkpoint load (3, from warm cache) | **6.1 s** |
| First download from scratch | **~37 min** via `hf-mirror.com` (see network note) |
| Routing only (no checkpoint) | **0.08–0.24 ms** |
| First predict (CUDA warm-up) | **358 ms** |
| Steady-state predict | **16.7–28.1 ms** (SDK) / **18–92 ms** (HTTP) |
| End-to-end via the TS provider | **24–44 ms** |
| `output_tokens` | always `0` — it is a classifier, it does not generate |

### Network note (this machine)

`huggingface.co` is **blocked** here (`ConnectTimeout`, WinError 10060); `hf-mirror.com`,
`pypi.org` and `github.com` are all reachable. Laya must be run with:

```powershell
$env:HF_ENDPOINT = "https://hf-mirror.com"
```

Without it, `laya.Router(...)` fails with `LocalEntryNotFoundError` rather than
falling back to anything. `HF_HUB_OFFLINE=1` works once the checkpoints are cached.

## The API

`laya-serve` exposes exactly two routes (`/openapi.json` confirms): `/health` and
`POST /v1/systemone`. The body is `{"state": {...}, "questions": {...}}` and the
response is the Jev-compatible envelope:

```json
{ "model": "laya-rl-agent",
  "answers": { "<id>": { "type": "choice|score|noul", "choice|score|noul": ..., "probabilities": {...}, "confidence": ..., "answer_confidence": ..., "action": { "act_probability": ... } } },
  "usage": { "input_tokens": 219, "output_tokens": 0 },
  "routing": { "model": "multilingual", "reason": "non-Latin script (han, 55% of letters)...", "detection": { ... } } }
```

Routing is **offline and free**: non-Latin script → `multilingual`, otherwise
`english`, decided by script detection, not by a model. Limits enforced server-side:
64 questions, 100 choice options, 512 total options, 32 score levels, 50 000 state
chars, 2 MB body, 16 concurrent, 8192 token budget.

## Classification quality

Same tasks, via the real provider:

| Task | work_kind | conf | complexity | review | checkpoint |
|---|---|---|---|---|---|
| en: refactor + update tests | `implementation` | 0.667 | moderate (1.73) | **yes** (0.678) | english |
| en: test fails with EINVAL | `debugging` | 0.555 | small (1.38) | no (0.077) | english |
| en: review a diff | `review` | 0.923 | moderate (1.63) | no (0.379) | english |
| zh: 重构并更新测试 | `implementation` | 0.998 | moderate (1.63) | **no** (0.004) | multilingual |
| zh: 测试失败 EINVAL | `debugging` | 0.880 | moderate (1.65) | no (0.486) | multilingual |

Routing between implementation / debugging / review is correct in all five cases and
fast enough to sit in front of every run.

### Two caveats that constrain how it may be used

1. **The criteria set is the decision space.** The identical English bug report
   scored against a 2-option choice (`implementation`/`review`) came back `review`
   at 0.628; against the 4-option set below it came back `debugging` at 0.555.
   The questions are therefore **pinned in `src/decision/laya.ts`**, not left to a
   caller to vary per request.
2. **Language changes the verdict.** The same refactor task is `review=yes` in
   English (noul 0.678) and `review=no` in Chinese (noul 0.004). The
   `multilingual` checkpoint is both more confident and more decisive. Treat
   `review_required` as a *hint with a distribution*, not a gate, unless the
   caller also inspects `review_noul`.

Also note the shipped checkpoints warn at load:
`invalid temperatures ... Treat confidence from the affected entries as uncalibrated`.
The provider therefore keeps the full `probabilities` distribution on every decision
so a caller can apply its own threshold instead of trusting one number.

## Failure semantics — why 200 is not enough

`laya-serve` was probed with 18 malformed/degenerate inputs. Observed:

| Input | Result |
|---|---|
| missing `state` | `400 'state' is required` |
| invalid JSON | `400 request body must be valid JSON` |
| not an object | `400 request body must be an object with a 'questions' field` |
| state > 50 000 chars | `413 state too large` |
| > 64 questions / > 100 options | `413` |
| body > 2 MB | `413 request body too large` |
| unknown or missing question `type` | `422 use one of ['choice','noul','score']` |
| `noul` given `criteria` | `422` |
| `score` given dict `criteria` | `422` |
| **`questions: {}`** | **`200` with `answers: {}`** |
| **choice with one option** | **`200`, always that option** |
| **choice `criteria` as a list** | **`200`, `choice: "a"`** |
| **score with one level** | **`200`, always `0.0`** |
| **empty `instructions`** | **`200`** |

The bottom block is the reason `src/decision/laya.ts` validates the payload instead
of trusting the status code. Each of those is a silent wrong answer that a
status-code check would convert into confident misrouting.

## What the provider does

`src/decision/` — a separate layer, so the Python/CUDA dependency can never become
a dependency of the agent runtime, and so the provider is replaceable.

- `types.ts` — **closed** vocabularies (`WORK_KINDS`, `COMPLEXITY_LEVELS`) and a
  `DecisionProvider` interface with no `fallback` member and no `tryDecide`. A
  provider that cannot decide cannot hand the work to someone else.
- `errors.ts` — `DecisionUnavailableError`, `DecisionTimeoutError`,
  `DecisionTransportError`, `DecisionSchemaError`, `DecisionInputError`, all
  extending `OrchestratorError` so the existing `code` discipline holds.
- `laya.ts` — `createLayaDecisionProvider()`. Pins the question set, validates the
  envelope before reading any field, maps the complexity score through the
  provider's own `legend`, and reports `probabilities` and provenance
  (checkpoint, reason, elapsed ms) on every decision.

Failure is always explicit: no default agent, no default complexity, no dropped
review step. `review_required` is derived from `noul > 0.5`, with the raw value kept.

## Verification

```
npm run typecheck            # clean
npm test                     # 90 unit + 242 contract + 56 decision, 0 failed
node tests/live-decision-check.ts   # against a real laya-serve; needs the Python side
```

`tests/decision.test.ts` is hermetic: a stub `node:http` server reproduces the real
laya-serve responses, including the 200-with-no-answer cases, so the contract is
tested without Python, CUDA, or a network.

## Limitations

- Windows-only as measured; no Linux/macOS verification.
- Laya's own `serve` limits are mirrored client-side (`MAX_STATE_CHARS` etc.) and
  will silently drift if upstream changes them; the server's 413 remains the backstop.
- Not wired into the orchestrator. Selection stays explicit (`--agent`) until the
  routing signal is trusted enough to drive dispatch on its own.
