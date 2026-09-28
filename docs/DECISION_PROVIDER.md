# DECISION_PROVIDER — Laya verified locally

Status: **verified working on this machine.** The Decision Layer is in
`src/decision/`. Phase 1 runtime is untouched: nothing here is wired into
`src/orchestrator/`.

## What Laya's role is here

Laya is a **classifier**, not an agent router and not a runtime dependency. It
answers typed questions about a piece of text — pick one of these, rate it 0..4,
is this true-ish — and returns a distribution. It never runs a task, never picks
OpenCode or Codex, and never launches anything.

```
DecisionRequest  ->  DecisionProvider  ->  laya-serve  ->  DecisionResponse
   questions           (swappable)         (local HTTP)     answers + metadata
   task/state
```

Three small types carry the whole interface (`src/decision/types.ts`):

| Type | Carries |
|---|---|
| `DecisionRequest` | the questions (each with its `criteria` / available choices), plus the `task` / `state` / `context` to read |
| `DecisionResponse` | the validated `answers` (`choice` / `score`+`level` / `noul`, each with a `probabilities` map and a `confidence`), the `provider` metadata, and the `raw` envelope |
| `DecisionProvider` | `name`, `probe()`, `decide()` — the seam |

`ProviderMetadata` carries only what every provider has: `name`, `model`,
`elapsedMs`, and an opaque `details` map. Laya's own vocabulary (`checkpoint`,
`reason`, `script`, `language`, `revisions`, token usage) is **not** in the
generic interface — it lives in `LayaMetadata` in `src/decision/laya.ts`, read
with `layaMetadata(response)`. No metadata framework is involved; it is one
function and one interface.

The one design rule: **the caller declares the answer space, and the provider
validates that the answer landed inside it.** A provider cannot invent an answer
the request did not offer, which is what makes the result safe to branch on.

`DecisionProvider` has no `fallback` field and no `tryDecide` on purpose.

### Not coupled to `src/core/`

`DecisionError` is the layer's own base class, not a subclass of
`OrchestratorError`. The Decision Layer sits in front of the agent runtime and
must stay readable, testable and reusable without it; sharing one field
(`code`) is not worth a dependency from decision/ into the kernel. The shape is
identical — `name`, `code`, optional `cause` — so the project-wide error
discipline still holds, and `isDecisionError(value)` narrows for callers.

### Files

| File | Role |
|---|---|
| `src/decision/types.ts` | the minimal interface: `DecisionQuestion`, `DecisionRequest`, `DecisionResponse`, `DecisionProvider` |
| `src/decision/errors.ts` | unavailable / timeout / transport / schema / input. Self-contained base class; no dependency on `src/core/` |
| `src/decision/laya.ts` | the Laya implementation. Validates the request, posts, validates the response |
| `src/decision/routing.ts` | the measured task-classification preset (work kind / complexity / review) on top of the generic layer |
| `src/decision/check.ts` | a standalone dev entry point. Not the orchestrator |

## Running it

```powershell
# 1. start the service yourself (the provider never starts it)
$env:HF_ENDPOINT = "https://hf-mirror.com"   # only needed if huggingface.co is blocked
laya-serve

# 2. check the provider, then classify one task
node src/decision/check.ts --probe
node src/decision/check.ts "refactor the event hub and update the tests"
node src/decision/check.ts --provider http://127.0.0.1:8077 "任意任务文本"
```

### Endpoint boundary: local-only

`createLayaDecisionProvider` enforces a **loopback-only** `baseUrl`
(`127.0.0.0/8`, `::1`, `localhost`). This is not a new restriction invented here
— it is the project's existing stated contract, now enforced:

- `package.json`: *"Local multi-agent orchestrator … No provider API calls."*
- the provider header: *"It talks to a local HTTP endpoint."*
- a decision request carries **the task text itself**, so a non-loopback
  `baseUrl` would POST task content to another machine.

A remote endpoint requires an explicit `allowRemote: true` (or
`--allow-remote` on the check script), so the opt-in is visible rather than
something a config slip can trip over. A malformed or non-http(s) `baseUrl` is
refused with a `DecisionInputError` at construction.

```powershell
npm run typecheck       # clean
npm test                # 90 unit + 242 contract + 397 decision, no agents needed
npm run test:decision   # the Decision Layer contract only, fully hermetic
node tests/live-decision-check.ts   # opt-in; needs laya-serve running
```

`tests/decision.test.ts` never touches the network, Python or CUDA: a stub
`node:http` server reproduces the real laya-serve responses, including the
200-with-no-answer cases.

## Why Laya does not select an agent

`--agent` is still the only way to choose an agent, and that is deliberate:

1. **The signal is not yet trustworthy enough to dispatch on.** Measured: the same
   refactor task is `review=yes` in English (noul 0.678) and `review=no` in Chinese
   (noul 0.004). Language alone flips the verdict.
2. **The shipped checkpoints warn their own confidence is uncalibrated.** So the
   provider keeps the full distribution on every answer instead of collapsing it
   into one number, for a caller to threshold deliberately.
3. **Auto-selecting an agent changes existing semantics.** `--agent` is explicit
   today; making it implicit would change what every existing invocation does.
4. The capability matrix already encodes the split: `opencode` `rejects: review`,
   only `codex` `can: review`.

The Decision Layer is the base for a Router/Policy later, not a Router/Policy.

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
   The questions are therefore **pinned in `src/decision/routing.ts`**, not left to a
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
| `noul` given a non-dict `criteria` | `422` ("as a dict with optional 'true'/'false' descriptions, **or omits it**") |
| `noul` given a dict keyed anything but `true`/`false` | `422` ("keyed only 'true'/'false' … or omitted is fine") |
| **`noul` given a proper `{"true":…, "false":…}` dict** | **accepted** |
| `score` given dict `criteria` | `422` |
| **`questions: {}`** | **`200` with `answers: {}`** |
| **choice with one option** | **`200`, always that option** |
| **choice `criteria` as a list** | **`200`, `choice: "a"`** |
| **score with one level** | **`200`, always `0.0`** |
| **empty `instructions`** | **`200`** |

The bottom block is the reason `src/decision/laya.ts` validates the payload instead
of trusting the status code. Each of those is a silent wrong answer that a
status-code check would convert into confident misrouting.

## What the provider guarantees

`src/decision/` is a separate layer, so the Python/CUDA dependency can never become
a dependency of the agent runtime, and so the provider stays replaceable.

**Before sending** (`DecisionInputError` — no request is sent):
- zero questions, or nothing to read (`task` / `state` / `context` all empty)
- a choice with no choices, or with **exactly one** choice
- a score with fewer than two levels
- an empty choice description or key, an empty score level
- malformed `criteria` (array where an object belongs, or vice versa)
- **`noul` `criteria` keyed anything but `true`/`false`, or with an empty or
  non-string description** — a valid `true`/`false` dict is accepted (see the
  `noul` criteria section); what is refused is anything the provider would
  silently drop or substitute
- empty `instructions`, an unknown question type, a non-string `task`/context value
- `state` that is not a plain object, or a state/context value that is not a string
- more than 100 choices in one question, or 512 options in total
- state over Laya's 50 000 chars, or a body over 2 097 152 bytes

`validateRequest` takes `unknown` and is the layer's runtime type guard: a
`null` request, a string request, a missing/null/string `questions`, a `null`
question, a non-string `state` value — all become a `DecisionInputError` with a
usable message. None of them produces a `TypeError`.

The one-option case is the important one: laya-serve returns that option with
HTTP 200, forever, for every input. Accepting it would report a confident,
constant "decision" carrying no information.

**After receiving** (`DecisionSchemaError` — despite a 2xx):
- missing/empty `answers`, a missing `model`, a non-object body
- a question that was asked but not answered
- **an answer whose own `type` is not the kind that was asked for**
- a `choice` outside the offered choices, or a `probabilities` map that does not
  match the offered space (a missing key **or an invented one**)
- **a `choice` that is not a maximum of the provider's own `probabilities`**
- a distribution that does not sum to 1
- **a `score` whose `legend` does not match the request's criteria index for index**
- **a `score` that is not the expectation of the distribution shipped with it**
- a `score` whose rounded index falls outside `0..criteria.length - 1`
- **an `answer_confidence` that is not `max(probabilities)`**
- any confidence/probability outside [0, 1], non-finite, or of the wrong type

### The three consistency rules, and where they come from

All three are read off the installed `laya` 0.3.21 source, not invented:

| Answer | Reported field | Actual definition (`laya/agent.py`) | Rule enforced |
|---|---|---|---|
| `choice` | `choice` | `keys[int(p.argmax())]` | must be an argmax of `probabilities` (ties ok) |
| `score` | `score` | `round(Σ(i * pᵢ), 4)` | must equal `Σ(i * probabilities[i])` |
| both | `answer_confidence` | `round(max(p), 4)` | must equal `max(probabilities)` |
| `noul` | `answer_confidence` | `round(max(p), 4)` over a 2-way split | must equal `max(noul, 1 - noul)` |

**`score` must not be checked with the argmax rule.** A score is an expectation, so
`round(score) != argmax(p)` is normal and correct: with
`{0: 0.1, 1: 0.6, 2: 0.1, 3: 0.1, 4: 0.1}` the argmax is index 1 (`small`) but the
expectation is 1.5, which rounds to index 2 (`moderate`). An argmax rule would
reject that legitimate answer; the expectation rule is what catches a real
contradiction.

The legend is also checked, and it must equal the request's criteria index for
index. Laya builds it as `{str(i): criteria[i]}`, so a reordered, renamed or
short legend means the provider is answering a different question — and the level
is then taken from the **request's** criteria, so a provider cannot redefine a
level by labelling it differently.

`noul` ships **no** `probabilities` (`laya/agent.py`), so none is required. But the
same guarantee is still available: its confidence is `max(noul, 1 - noul)`, which
is derived from the value it does report, so a noul is not left unchecked.

### Three separate tolerances, each derived

The service serialises every probability and every score with `round(x, 4)`
(`laya/agent.py`), so each reported value differs from the true one by at most
half a unit in the fourth decimal: `HALF = 5e-5`.

| Check | Compares | Tolerance | Growth |
|---|---|---|---|
| probability normalization | `Σ probabilities` to 1 | `HALF · k` | linear |
| answer confidence | `answer_confidence` to `max(probabilities)` | `2 · HALF` = 1e-4 | **constant** |
| score expectation | `score` to `Σ(i · probabilities[i])` | `HALF · (1 + k(k-1)/2)` | quadratic |

- **Sum** — `|Σ p_rep − 1| = |Σ (p_rep[i] − p_true[i])| ≤ k · HALF`. Linear, because
  all k rounding errors add.
- **Confidence** — the reported confidence is `round(max(p_true), 4)` and the
  reported maximum is `round(p_true[j], 4)` for whichever j attains it. Rounding is
  monotone, so these coincide and the residual bound is two rounding steps. **This
  must not grow with k**: only one term is involved, so a wider answer space buys no
  more slack. At k = 100 this is 1e-4, not 1.0.
- **Expectation** — the one check that legitimately needs a quadratic term, because
  it is a *weighted* sum, so error accumulates with the index:
  `≤ HALF (rounding of the score) + Σ(i) · HALF`.

All three are upper bounds on the real error, not fudge factors; a small epsilon is
added only for double-precision arithmetic in the comparison.

> An earlier version used `2 · HALF · k²` for all three. That is **wrong and
> dangerous**: at k = 100 it is 1.0, so a distribution summing to 0, or a confidence
> 0.98 away from its own maximum, passed. The regression tests reproduce exactly
> that — see "high-k" below.

### `noul` criteria

`noul` **may** carry `criteria`, keyed only by `true` and `false`:

```jsonc
{ "type": "noul", "instructions": "Does it hold?",
  "criteria": { "true": "the statement holds", "false": "the statement does not hold" } }
```

Verified in `laya/agent.py`: either key, both, an empty object, or omitted are all
valid; keys are matched case-insensitively and boolean literal keys are normalised to
their string form. A dict keyed anything else is rejected by the provider, because
the model reads only `criteria["true"]` and `criteria["false"]` — any other key would
be silently dropped and the caller's wording would never reach the model.

This layer is **stricter than the provider in one respect**: a description must be a
non-empty string. The provider silently substitutes its default wording for an empty
description, and JSON-marshals a structured value into the prompt. Both would leave
the caller believing they had chosen the wording when they had not, so they are
refused here with a message saying to omit the key instead.

`noul` still has **no answer space** and sends **no `probabilities`**; `criteria` is a
description, not options. Answer semantics are unchanged: no distribution is required,
and the confidence is still checked against `max(noul, 1 − noul)`.

**Transport** is split so the two operator problems stay separate:
`DecisionUnavailableError` (cannot reach the service), `DecisionTimeoutError`
(too slow), `DecisionTransportError` (non-2xx, carrying laya's own `detail`).

Every answer keeps its `probabilities` distribution, and every response keeps the
provider metadata plus the `raw` envelope, so a wrong classification can be
diagnosed without re-running the model.

`probe()` never throws. An unreachable service, a non-2xx, malformed JSON, and a
structurally invalid payload (no `status`, `loaded` that is not an array of
strings, a `cpu_fallbacks` entry without a numeric `count`) all come back as
`{ ok: false, detail }`. A `SyntaxError` escaping to the caller would turn an
"is the service ready?" question into a crash in whatever asked it.

`review_required` in the routing preset is derived from `noul > 0.5`, with the raw
value retained so a caller can pick its own threshold. Projection failures throw
`DecisionSchemaError`, not a bare `Error`.

### One measured gotcha, worth not re-discovering

A `noul` answer has **no `probabilities` map** — laya-serve sends only
`noul`, `confidence` and `answer_confidence`. `choice` and `score` answers do
carry one. Validating uniformly would reject every real response; the hermetic
suite pins this so it cannot regress.

## Verification

```
npm run typecheck            # clean
npm test                     # 90 unit + 242 contract + 397 decision, 0 failed
npm run test:decision        # the Decision Layer contract only
node tests/live-decision-check.ts   # opt-in, against a real laya-serve
```

`tests/decision.test.ts` is hermetic: a stub `node:http` server reproduces the real
laya-serve responses, including the 200-with-no-answer cases, so the contract is
tested without Python, CUDA, or a network.

The unit and contract counts are unchanged from before this layer existed, which
is the evidence that orchestrator behaviour did not move.

## Limitations

- Windows-only as measured; no Linux/macOS verification.
- Laya's own `serve` limits are mirrored client-side (`MAX_STATE_CHARS`,
  `MAX_QUESTIONS`, `MAX_CHOICE_OPTIONS`, `MAX_SCORE_LEVELS`) and will drift if
  upstream changes them; the server's 413 remains the backstop.
- `noul` answers carry no distribution, so `review_required` is the one decision
  without a probability map to threshold against.
- Not wired into the orchestrator. Selection stays explicit (`--agent`) until the
  routing signal is trusted enough to drive dispatch on its own.
