# TeamRun Model Access Architecture

Status  = **SEALED · T3-M0 · architecture freeze · docs only · 2026-10-08**
Seal    = **T3-M0 = SEALED.** Basis: Codex T3-M0 Final Review = **PASS WITH P2**,
          `P0 = 0`, `P1 = 0`, final recommendation *"SEAL T3-M0"*. The six P2 items were
          documentation / future-implementation constraints, **not blockers**, and are
          **CLOSED** as documentation in §26 of this document.
          Owner-ratified stage state: `T1 = SEALED`, `T2 = SEALED`, `T3-a = SEALED`,
          `T3-M0 = SEALED`.
Scope   = Freeze the technical relationship between **Agent / Model / Model Access Route /
           Execution Candidate / Free-Quota**, and hand T3-b a stable input.
Rule    = **Documentation only. NO runtime code was modified.** `src/**` and `tests/**` are
           byte-unchanged. No Gateway, no reverse proxy, no scheduler change, no
           `WorkerIdentity` change.
NOT     = This document is an **architecture freeze**, NOT a runtime capability claim. There is
           still **no `ModelAccessRoute` runtime, no Candidate Registry, no `candidateId`, no
           Gateway, and no route provenance** anywhere in `src/`. Those remain future work
           (§26.3).
Precondition = Owner-ratified: `T1 = SEALED`, `T2 = SEALED`, `T3-a = SEALED`
               (Codex T3-a.5 Final Seal Review: **PASS WITH P2**, `P0 = 0`, `P1 = 0`;
               accepted P2 = root-only fan-out, default `maxConcurrent = 2`).
Canonical for = Model Access. Cross-referenced by
               `TEAMRUN_AGENT_MODEL_ARCHITECTURE_AUDIT.md` (Agent × Model),
               `TEAMRUN_T3_READ_FANOUT_ARCHITECTURE_AUDIT.md` (READ fan-out),
               `PROJECT_BASELINE.md` (doc index).

---

## 0. Why this document exists

T1 made `(agentId, modelId)` a real, sealed relationship. T2 made Laya choose that pair
explicitly and Assignment enforce it exactly. T3-a made N workers execute, attribute, and
report honestly.

What none of them could express is the third fact that decides whether a model is *reachable*:

```text
"OpenCode" + "space-bunny-free" is not a fact on its own.
It only means something once you know HOW OpenCode obtained it:
  which provider endpoint, whose credential, which account, which protocol,
  whether that path is free, and whether it is up right now.
```

Today that knowledge lives **entirely inside each agent's own configuration**, which this project
deliberately never reads (`credentialsHint` is a documentation string; the adapter never opens
it). The consequence is concrete and already visible in the repo:

- The only model-access knowledge we hold is a **label**: `ModelEntry.provider: string`
  (`src/quota/types.ts:121`), documented as "documentation only".
- Free eligibility is a **flat pair-keyed allowlist** (`ACTIVE_FREE_MODEL_POOL`,
  `src/orchestration/model-pool.ts:76`), so "free" is currently a property of a *pair*, which is
  already one step too coarse — see §13.
- There are **two divergent free-model lists** in the tree
  (`ACTIVE_FREE_MODEL_POOL` vs `freeModelSeed()` at `src/quota/index.ts:443`, the latter keyed on
  a **display name** rather than `agentId`). That divergence is a *symptom* of free-ness being
  modelled as a name instead of as a property of a usable access path.
- `opencode providers list` was observed returning **three credentials** — OpenCode Go (api),
  DeepSeek (api), Ollama Cloud (api) (`docs/PHASE4_QUOTA_AUDIT.md:18`). So three routes to models
  already exist *inside OpenCode* — and our system cannot tell which one a run used, cannot gate
  on it, and cannot report it.

So: **access-path differences already exist operationally inside external / native Agent
configuration**, but **the orchestrator does not represent them as first-class
`ModelAccessRoute` objects**. Nothing in `src/` today is a Model Access Runtime.

Precise current statement of what exists in this repository:

```text
ModelAccessRoute runtime      = DOES NOT EXIST
Candidate Registry            = DOES NOT EXIST
candidateId                   = DOES NOT EXIST
Gateway                       = DOES NOT EXIST
route provenance in evidence  = DOES NOT EXIST
```

What exists instead is three *facts about the gap*, not capabilities:

1. a `(agentId, modelId)` composite-keyed `ModelRegistry` — an observability/fact store;
2. a pair-keyed free-pool allowlist — a policy predicate;
3. `credentialsHint` — a documentation string naming where the agent keeps its own login.

Therefore **T3-M0 is an architecture freeze, not a runtime capability claim.**

---

## 1. Terminology (frozen)

### 1.1 Agent / Harness

```text
Agent = an execution harness / native coding-agent family.
```

The official Agent families are unchanged and remain **four**:

```text
opencode        -> OpenCode
codex           -> Codex
workbuddy-cn    -> WorkBuddy CN
workbuddy-intl  -> WorkBuddy Intl
```

(`src/quota/index.ts:42` `ACTIVE_AGENT_IDS`.)

- **CN and Intl stay independent identities.** They are one implementation but two provider
  identities, each resolving only its own install; discovery never crosses between them
  (`src/adapters/workbuddy.ts:36-48`, `:144-189`). There is deliberately no bare `workbuddy` id.
- `cline` also exists in the adapter registry (`src/adapters/index.ts:53`) but is **not** in
  `ACTIVE_AGENT_IDS`. It is an adapter, not an official Agent family. Where relevant below it is
  called out explicitly rather than silently folded in.
- **An Agent is not a Model.** See §15 for why this stays two first-class dimensions forever.

### 1.2 Model

```text
Model = an inference / reasoning capability identity.
```

A `modelId` in this system is an **opaque string** (`RunRequest.model?: string`,
`src/core/types.ts:195`). It is never interpreted by the orchestrator.

**A Model alone never implies reachability.** It is illegal to assume that

```text
Agents × Models
```

is a valid Cartesian product. Nothing in the codebase validates that a given agent may use a
given model beyond (a) pair registration in `ModelRegistry`, (b) `taskTypes` capability, and
(c) the optional free pool. There is **no** per-agent model-capability matrix anywhere in
`src/`. That absence is the gap this document fills conceptually — see §5.

### 1.3 ModelAccessRoute (NEW)

```text
ModelAccessRoute
= the path by which one Agent actually obtains one Model in one candidate execution.
```

> Definition: **an Agent, in one candidate execution, reaching a Model through some concrete
> access path.**

Route kinds (naming adjusted to repo id style — lowercase, kebab):

| `routeKind` | Meaning | Exists today? |
|---|---|---|
| `agent-native` | The agent's own CLI resolves the model using its own login/config. We pass `--model <id>` and nothing else. | **YES — the only kind in production** |
| `gateway` | A model-access gateway fronts OpenAI-compatible / Responses-compatible endpoints under one credential. | **NO** (deferred, §29) |
| `provider-api` | A direct provider API reached by us. | **NO** — and currently prohibited (`src/core/types.ts:14`) |
| `local-ollama` | A local model server (Ollama / llama.cpp / LM Studio) behind an OpenAI-compatible endpoint. | **NO** as an Agent route (the one `ollama` in `src/` is Hindsight memory's own LLM, `src/memory/cli.ts:94`) |

**What a route is:** a `configuration / provenance` dimension.

**What a route is NOT:** not a control-plane authority. A route decides nothing, admits nothing,
and ranks nothing. It is a *fact about a candidate*, exactly like `availability` is a fact about
a `ModelEntry` today. Adding routes must not create a new authority — that would break the
"each authority exactly 1" rule in `PROJECT_BASELINE.md` §12.

A route carries at least these facts, all of which may differ for the **same model**:

```text
availability · quota · free eligibility · account · credential source
protocol · latency · failure domain
```

### 1.4 ExecutionCandidate

```text
ExecutionCandidate = (agentId, modelId, routeId)
```

A triple that *together* describes something genuinely executable. This is the unit the rest of
the architecture reasons about. See §2 for why route is explicit, §5 for generation, §21 for how
Laya should name one.

---

## 2. Why Route must be an explicit Candidate dimension

The same Model can be reachable by several paths with materially different properties:

```text
Model X via agent-native   (own account, own protocol, own quota window)
Model X via gateway        (one shared credential, gateway-side quota, maybe billable)
Model X via provider-api   (our key, our quota, our failure domain)
```

For one model, free-eligibility is therefore **not a model property**:

```text
Model.free = true                      <-- WRONG as a complete fact

Candidate (X, agent-native): freeEligible = true
Candidate (X, gateway):      freeEligible = false
```

Consequences that make route unavoidable rather than decorative:

| Property | Why `(agentId, modelId)` cannot answer it |
|---|---|
| **Free eligibility** | Two routes to one model can differ in price. `ACTIVE_FREE_MODEL_POOL` today encodes this at *pair* granularity, which is a proxy for route, not the thing itself. |
| **Quota** | Belongs to provider / account / agent-native service / route — **not** to a model. See §14. |
| **Credential source** | Deliberately unread by us (`credentialsHint`). Which account a run spends is a route fact we currently cannot answer at all. |
| **Protocol** | Chat-Completions vs Responses is a *route* property. Codex-only models and reasoning summaries require Responses (`opencode` issue #15847). |
| **Availability** | OpenCode's provider entry and a local Ollama endpoint have independent liveness. |
| **Failure domain** | A gateway outage and an agent-CLI outage are different incidents with different recoveries. |

> **The external confirmation.** LiteLLM's own docs had to add
> `enforce_fallback_model_access` **and** `enforce_fallback_budget`, because of exactly this
> hazard, stated in their words: *"the primary model is priced at zero … a request for it is
> admitted, falls back to the paid model, and bills in full with no cap applied."* A mature
> system discovered that **free-ness and route must be re-checked on every hop**, not assumed
> from the model. That is our §8 rule, arrived at independently.

---

## 3. Route is a Candidate dimension, NOT part of WorkerIdentity

**Frozen for T3-M0: `routeId` does NOT enter `WorkerIdentity`.**

`WorkerIdentity` stays exactly as T1 sealed it (`src/orchestration/worker-identity.ts:55-63`):

```text
WorkerIdentity = { taskId, agentId, modelId, sessionId }
```

(Note `modelId` is `string | null` — nullable is how the system records "no model selected";
that is deliberate and must not be "fixed" into a placeholder.)

Why route stays out:

1. **Different question.** `WorkerIdentity` answers *"which logical execution worker is this?"*
   — it is the identity the session registry, the attempt record, and the fan-out key on. Route
   answers *"how was the model obtained?"* — provenance and configuration. Conflating them makes
   the identity change when a route is re-pointed, which would silently fork sessions and
   attempts for what is logically the same worker.
2. **T1 sealed it.** `WorkerIdentity`'s four fields are already sealed, consumed by
   `workerKeyOf`, `SessionRegistry`'s identity guard, and `AttemptRecord`. Reopening it for a
   dimension that is not yet runtime-real would churn sealed contracts for no behaviour.
3. **Nothing to point at yet.** There is no route registry, no route id, and no runtime that
   selects a route (§12: every non-native route is `UNKNOWN` / `BLOCKED`). Adding an identity
   field that can only ever hold one value today is schema without semantics.
4. **SessionRegistry would fight it.** `workbench-sessions.ts:196-207` throws
   `session-identity-mismatch` when an existing session's `(agentId, modelId)` disagrees with the
   target. If route entered identity, a route change on the same pair would either be rejected
   as a mismatch or require re-pointing a live session — both worse than the current behaviour.

**Intended semantics:**

```text
WorkerIdentity  = logical execution worker identity   (T1, sealed)
ModelAccessRoute = execution access / configuration provenance   (T3-M0, new dimension)
```

**Future, explicitly out of scope for this round:** once a route runtime exists, the *selected*
`routeId` should be frozen into **dispatch evidence / Attempt provenance** (§19), so that a
completed execution can be attributed to the route it actually used. That is an implementation
design for a later slice. **This round changes no schema** — not `AttemptRecord`, not
`WorkerIdentity`, not `RunRequest`.

### 3.1 Two clarifications that must not be over-read

**(a) `routeId` not being in `WorkerIdentity` does NOT mean route is unobservable.** These are
different mechanisms:

```text
WorkerIdentity  = identity  (which logical worker)
Attempt / dispatch provenance = observability (how it was accessed)
```

Route is deliberately an **observability/provenance** fact (§18), so excluding it from identity
does not exclude it from evidence. The two placements are complementary, not conflicting.

**(b) Do not claim `SessionRegistry` already implements a route guard.** The real, current guard
is `workbench-sessions.ts:196-207`: it compares the fields that exist today — `agentId` and
`modelId` — and throws `session-identity-mismatch` on disagreement. It knows **nothing** about
routes, because no route concept exists in the runtime yet.

If a future route incompatibility requires a **new native conversation**, then the correct and
sufficient mechanism is a **new Session** — which naturally changes `sessionId` in
`WorkerIdentity`. That is the whole reason route needs no identity field: an incompatible route
produces a different session, and identity follows automatically. **This is a design
observation about future behaviour, not a claim that the guard exists today.**

---

## 4. Boundaries this dimension must not cross

```text
Laya        = semantic decision authority. Chooses which validated candidate suits the task/member.
Assignment  = admissibility / enforcement authority. Executes the selected candidate EXACTLY.
Candidate Generator = enumeration + compatibility filtering + factual availability projection.
Gateway     = OPTIONAL model-access infrastructure. Model access / protocol / credentials only.
```

Laya is **not** responsible for: `baseURL`, provider protocol, credentials, token refresh,
account login, model-discovery implementation, or gateway routing internals.

Assignment is **not** responsible for: discovering candidates, or preferring a cheaper/available
route over the selected one. It enforces.

`route failure != automatic silent route substitution` — frozen, see §8.

---

## 5. Candidate generation (future component, specified not built)

A future **Candidate Generator** produces *"legal Agent × Model × Route candidates"* from
registered configuration plus current factual availability.

Example shape (all three already plausible, none verified as a route today — see §12):

```text
OpenCode        / MiMo                / opencode-native
OpenCode        / Qwen3.8             / ollama-local
WorkBuddy Intl  / Hy3                 / workbuddy-intl-native
```

**Hard rule: only registered, validated combinations enter the candidate set.** Laya must never
be able to invent a pair such as `OpenCode / Hy3`, and must never be able to invent a route at
all. Laya selects *from* a validated set; it does not construct candidates.

**Non-authority boundary — it must not become a second Laya.** The Candidate Generator does
**only**:

```text
enumeration · compatibility filtering · current factual availability projection
```

It does **not** do:

```text
task semantic ranking · task decomposition · reassignment policy · retry policy
```

The repo already states this principle in the exact place it would be violated
(`src/decision/initial-assignment.ts:59-70`):

> "Deliberately a plain projection of facts the registry already owns. It carries no scoring, no
> preference and no ranking: which pair is BEST is Assignment's question, and duplicating that
> arithmetic here is how two authorities end up disagreeing."

The Candidate Generator is that projection, extended by one dimension. It must keep that
character.

---

## 6. Laya boundary

```text
Laya receives: a validated ExecutionCandidate set
Laya decides:   which candidate best suits this task / fan-out member
```

Everything else in §4 stays out of Laya. Mechanically this is already how T2 works: Laya answers a
`choice` question whose answer space **is** the offered candidate list
(`initialAssignmentQuestions`, `src/decision/initial-assignment.ts:90-108`), and an answer naming
something not offered is refused (`readInitialAssignmentIntent`, `:157-206`). Route rides in as
part of each offered key, not as something Laya assembles (§21).

---

## 7. Assignment: exact enforcement extends to the candidate

Assignment is the admissibility / enforcement authority. When candidates carry a route,
Assignment must **exact-enforce the selected candidate** rather than "find something close".

The existing guarantees are already correct and must be preserved verbatim:

- With an explicit pair, the candidate pool **is** the pair; everything downstream runs unchanged
  (`src/orchestration/assignment.ts:414-439`).
- Unregistered explicit pair ⇒ `no-model-available`, *"an explicit Laya pair is never silently
  substituted"*.
- `assignWorker` has **no fallback path** (`:384-392`): a wrong assignment costs more than an
  honest refusal.
- `requestModelSwitch()` refuses with `model-switch-not-supported` (`:624-639`) — model migration
  is P6-D1, not P6-B.

**Principle continues unchanged and now covers route:**

```text
no silent substitution — including route changes.
```

A selected candidate that is unavailable at admission is **refused**. It is never quietly
re-pointed at another route for the same model.

### 7.1 The Candidate Generator is NOT an authoritative admission step (frozen)

The full chain, in order, with the authority at each step:

```text
candidate enumeration
  ↓
compatibility filtering
  ↓
best-effort availability / quota projection      <- a SNAPSHOT, not an authority
  ↓
Laya selection                                  <- semantic choice
  ↓
Assignment authoritative recheck                <- AUTHORITATIVE admission
  ↓
execution / pre-dispatch authoritative recheck  <- AUTHORITATIVE where applicable
```

**Frozen, and the reason the chain is written this way:**

```text
candidate generated or visible  !=  guaranteed executable
availability / quota snapshot   !=  Assignment authority
```

Concretely: even when a candidate was *just* generated and reads

```text
available = true
quota appears usable
```

Assignment must still re-check against **current facts** at admission, and the execution /
pre-dispatch stage must re-check again where applicable. A snapshot can go stale between
generation and admission (the account can be exhausted, the agent binary can disappear, the
registry entry can change), and the generator is in no position to hold that guarantee — it is a
projection, not an authority (§5).

This mirrors what is already true today and must not be weakened: `assignWorker` refuses rather
than substituting, and its availability filter is fail-closed (`availability-unknown` is not
`available`). The route dimension adds a new way for a snapshot to be wrong; it does not add a
new way for it to be right.

---

## 8. Route failover rule (frozen)

```text
route failure  !=  automatic silent route substitution
```

In particular this is **forbidden**:

```text
free route  ↓ unavailable  →  paid route        (by a gateway or an adapter, silently)
```

If a route change would alter **cost**, **free eligibility**, **quota**, **provider/account**, or
**Agent**, it must **re-enter the formal decision / admission flow** — i.e. it becomes a new
candidate selection by Laya and exact enforcement by Assignment. It is never an adapter's or a
gateway's private decision.

**Why this is stated as a hard rule and not a preference.** Both external references implement the
opposite default, and both had to bolt on guards:

- LiteLLM Proxy **can apply a configured fallback in the request path**, moving from one model
  group to a configured target — but only **once a fallback has been explicitly configured** in
  `router_settings`. The accurate claim is therefore *"the product has cross-provider / cross-model
  fallback **capability**"*, **not** *"fallback is on by default"*. Capability existing in a
  gateway product is precisely why this project must **explicitly forbid** any candidate- or
  cost-changing fallback that has not passed through an orchestrator decision: the dangerous
  behaviour is available and therefore must be disallowed by us, not assumed absent.
  It then needed `enforce_fallback_model_access` plus per-target budget re-checks, because a
  zero-cost primary falling through to a paid target "bills in full with no cap applied".
- `orchestrator-sh` routes via an LLM classifier and, when the router fails, falls back to
  `config.yml`'s `router.fallback_executor` — a **silent** executor substitution.

Our system already refuses this shape elsewhere (Assignment has no fallback; the DecisionProvider
interface has *no* `fallback` field and *"must throw rather than return a guess"*,
`src/decision/types.ts:234-241`). Route must not become the one place where a silent, unrecorded,
price-altering substitution is allowed.

---

## 8A. Gateway Retry Boundary (frozen)

Distinct from §8's *substitution* rule, which is about **changing the candidate**. This section
is about **retrying the same candidate**.

### 8A.1 Allowed: transparent transport retry

A future Gateway MAY perform a bounded retry internally, **provided every one of these is
unchanged**:

```text
same ExecutionCandidate
same agent
same model
same route
same provider / account binding
same pricing / free-eligibility policy
```

The eligible failures are **transport-level and transient only**, e.g.:

```text
connection reset
transport-level timeout retry
same-endpoint retry
```

Rationale: a transport blip on the *same* endpoint is the same execution attempt being
retried, not a different decision. Nothing about cost, eligibility, or identity changes, so
there is nothing for a human or a decision authority to approve.

**This is a future policy statement. It is NOT implemented anywhere in `src/` today.**

### 8A.2 Must return to the orchestrator

Any fallback that changes **any** of the following MUST NOT be executed transparently:

```text
model
provider
account
route
free eligibility
pricing / billing
candidate identity
```

It must re-enter the formal flow:

```text
decision  +  admission / enforcement
```

i.e. Laya selection (or an equivalent explicit decision) followed by Assignment's authoritative
re-check — never an in-gateway or in-adapter shortcut.

**Explicitly forbidden, in all cases:**

```text
free route  →  paid route        (silent fallback)
```

The §8 external evidence applies here directly: a gateway product *has* this capability, which is
precisely why the boundary must be stated by us rather than assumed from the gateway's defaults
(§16.1).

---

## 8B. Account / Credential Binding (frozen extension point)

### 8B.1 When the triple is sufficient

```text
ExecutionCandidate = (agentId, modelId, routeId)
```

is sufficient **only when** `routeId` **uniquely identifies** the relevant provider / account
binding. If it does, the account is already inside the route identity and nothing needs to change.

### 8B.2 When the triple is NOT sufficient

Suppose a future state where the *same* `(agent + model + route)` resolves through **two
accounts**, and the account changes any of:

```text
quota · billing · free eligibility · availability
```

Then a silent account swap is **forbidden**, and it must not be performed while still claiming
the execution configuration is unchanged. Silently drawing from a different account while
reporting the same candidate is exactly the class of dishonesty §8 and §8A forbid — it just
happens to be invisible because the model id happens to be shared.

### 8B.3 Two permitted future designs (neither locked in)

```text
Option A — express the account inside the route identity.
  A different account binding yields a different STABLE routeId.
  e.g. conceptually:  openai-account-a   vs   openai-account-b
  The candidate schema stays (agentId, modelId, routeId).

Option B — promote accountBindingId to its own candidate dimension.
  i.e. (agentId, modelId, routeId, accountBindingId)
  Wider schema, wider blast radius.
```

**Primary recommendation:** prefer **Option A** wherever a stable route binding can express the
account, because it avoids enlarging the candidate schema prematurely.

**This is deliberately not locked.** The choice depends on facts T3-M0 does not have (whether a
future gateway or native config even exposes selectable accounts). Recording both keeps the
decision open without pretending it has been made.

### 8B.4 Credential safety (frozen, constrains all future provenance work)

Future route provenance may record **only**:

```text
routeId
a provider binding id
an account alias / id suitable for diagnostics
free / quota attribution
```

It must **never** record, and no such value may appear in:

```text
raw API key · token · secret · refresh credential · password
```

into any of:

```text
Task · Attempt textual evidence · Laya prompt · Review packet · logs
```

This mirrors an existing, deliberate posture rather than introducing a new one: the adapters
already expose `credentialsHint` as *"Where the agent keeps its own login. Reference only; never
read."* (`src/core/types.ts:183-184`), and `AgentDescriptor.credentialsHint` exists precisely so
the orchestrator can name *where* a credential lives without ever holding it. §9 and §8B.4 extend
that posture to route provenance: a route is identified, a credential is not.

## 9. Gateway: definition and non-definition

```text
Gateway = OPTIONAL Model Access infrastructure.
```

A future Gateway may unify:

```text
OpenAI-compatible endpoints · Responses-compatible endpoints · provider APIs
Ollama / local models · other verified model sources
```

**A Gateway is NOT:**

```text
Gateway != Laya          (not a semantic decision brain)
Gateway != Orchestrator  (not the execution edge)
Gateway != Assignment    (not the admissibility authority)
Gateway != Agent         (not a harness)
```

It solves model access / protocol / credentials / routing infrastructure **only**. It is not
admitted as a runtime dependency of this project (§16): it is architecture evidence, and if one
is ever adopted it will be an external process this project *talks to*, exactly as Laya is
today (`src/decision/laya.ts`).

Note the direction of the dependency: today `baseUrl` in this repo means **Laya's own HTTP
endpoint**, loopback-enforced (`src/decision/laya.ts:63-83`, `DEFAULT_BASE_URL =
'http://127.0.0.1:8077'`). A model gateway would be a *different* base URL for a *different*
purpose, and must not reuse that name or that loopback security decision.

---

## 10. Native agent-bound routes are first-class (must be preserved)

This shape must remain legal and must not be "unified" away:

```text
WorkBuddy Intl + Hy3 + workbuddy-intl-native
```

If investigation shows Hy3 can currently be used safely and stably **only** through WorkBuddy
Intl, then `workbuddy-intl-native` is its **official route** — full stop.

**Do not force a reverse proxy for architectural uniformity.** Forcing WorkBuddy Intl's Hy3
through a gateway would add a credential the project does not hold, a failure domain it does not
control, and a translation layer between a harness and a model that measurably works today. The
measured evidence for this route is the strongest in the tree:

```text
modelSelection  --model balanced-model -> result.modelUsage = balanced-model   (MEASURED)
resume          -r <sessionId> reused session_id and recalled earlier content   (MEASURED)
roleSelection   --agents {...} --agent probeagent changed the reply             (MEASURED)
```

(`src/adapters/workbuddy.ts:59-68` — "MEASURED, NOT ASSUMED".)

Its counter-example is equally instructive: the **CN** build of the same binary cannot serve Hy3
because it is unauthenticated, so `workbuddy-cn / hy3` is explicitly **excluded** from the free
pool (`EXCLUDED_FROM_FREE_POOL`, `src/orchestration/model-pool.ts:113-118`). Same model id, same
implementation, different identity, different reachability — a route fact, not a model fact.

---

## 11. Gateway-capable and local routes

Plausible future shapes:

```text
OpenCode + Qwen3.8 + ollama-local          (local today is plausible, NOT verified — §12)
OpenCode + Model X + gateway               (future)
```

**Such a route becomes a Candidate only after the endpoint/API actually exists and has been
verified.** Never write "theoretically proxyable" as "currently supported".

External evidence that a general harness genuinely consumes local endpoints — OpenCode documents
these as first-class custom providers:

```text
ollama      -> http://localhost:11434/v1   (@ai-sdk/openai-compatible)
llama.cpp   -> http://127.0.0.1:8080/v1    (e.g. qwen3-coder:a3b, local Qwen)
lmstudio    -> http://127.0.0.1:1234/v1
Atomic Chat -> http://127.0.0.1:1337/v1
```

and states that **the provider ID becomes the model-id namespace** — the config key is the
provider prefix, each `models` key is a selectable model id. That is the shape we already carry
in our own model ids: `opencode/space-bunny-free` reads as *provider prefix* `opencode` + *model*
`space-bunny-free`.

### 11.1 A provider/model prefix is NOT route identity

The prefix is **evidence of a naming convention, not proof of an access route**. It must not be
read as one, because a single provider configuration can cover a *range* of different access
paths:

```text
provider config may override:
  base URL · account · endpoint · credential source · protocol
```

Therefore, from the model id alone:

```text
opencode/foo
```

does **NOT** prove any of:

```text
the exact endpoint        the exact account        the exact billing route
the exact credential      the exact protocol       the exact price
```

A `ModelAccessRoute` must come from **verified configuration / provenance** — never from parsing
the model-id string. Two candidates may share a prefix and differ in every route fact; one
candidate's prefix may not even resolve to a single route.

### 11.2 OpenCode's internal provider ambiguity is a known, unsolved instance

This is not hypothetical. OpenCode is observed to hold **multiple provider credentials / access
paths** at once (`opencode providers list` returned three: OpenCode Go (api), DeepSeek (api),
Ollama Cloud (api) — `docs/PHASE4_QUOTA_AUDIT.md:18`).

So for a future `OpenCode + Model X`:

```text
if the provider, endpoint and account behind that request
   cannot be uniquely determined,
then complete route provenance is NOT established,
and that candidate must not be reported as a verified route.
```

**Scope note, stated plainly:** T3-M0 solves the *architecture representation requirement* — it
defines that route must be a first-class, recorded dimension. It does **not** attempt, and does
not claim, automatic discovery of OpenCode's internal provider configuration. Resolving which
credential an agent actually used is a future provenance problem (§18), not something this
freeze delivers.

---

## 12. Current model-access inventory (recorded evidence, not assumed)

Status vocabulary, used strictly — **`VERIFIED` / `UNKNOWN` / `NOT TESTED` / `BLOCKED`**:

- `VERIFIED` — a real run on this machine produced the recorded result. **This is historical
  recorded evidence, not a live probe taken during this round.** T3-M0 re-read the repository and
  did **not** re-invoke any agent; `VERIFIED` therefore means *"verified when the cited evidence
  was recorded"*, with the source named in the row.
- `UNKNOWN` — no evidence either way; not guessed.
- `NOT TESTED` — a mechanism plausibly exists but was never exercised.
- `BLOCKED` — recorded as unusable, with the reason cited.

**Reading rule:** where a row says `VERIFIED`, read it as *historically verified against the
cited source at the cited time*, not as *"live and verified today"*. Re-verification is a runtime
activity this docs-only round did not and must not perform.

| # | Agent | Model | Current access route | Agent-exclusive? | Gateway-capable? | Free mechanism | Quota source | Availability source | Verification |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `opencode` | `opencode/space-bunny-free` | `opencode-native` (`--model`) | **YES** (id namespaced `opencode/`) | `UNKNOWN` | `-free` id + real run `costUsd: 0` | none (no quota endpoint; `QUOTA_STATUSES` = `unavailable`) | `ModelRegistry` availability probe | **VERIFIED** (`ACTIVE_FREE_MODEL_POOL`, `confirmed-free`) |
| 2 | `opencode` | `opencode/mimo-v2.6-flash-free` | `opencode-native` | **YES** | `UNKNOWN` | `-free` id + real run `costUsd: 0` | none | registry probe | **VERIFIED** (`confirmed-free`) |
| 3 | `opencode` | `opencode/mimo-v4-flash-free` | n/a | n/a | n/a | n/a | n/a | n/a | **BLOCKED** — "does not exist; real call exits 1 with UnknownError" |
| 4 | `opencode` | `opencode-go/*` | n/a | n/a | n/a | not in pool | n/a | n/a | **NOT TESTED** — "not enabled this phase" |
| 5 | `workbuddy-intl` | `hy3` | `workbuddy-intl-native` (`--model`) | **YES** (Intl build only) | `UNKNOWN` — no transport observed | real run `total_cost_usd: 0`, **ceiling unknown** | none (CodeBuddy CLI has no quota command) | install probe + `--model` measured | **VERIFIED** (`zero-at-call-time`) |
| 6 | `workbuddy-cn` | `hy3` | n/a | **NO** (same model, other identity) | n/a | n/a | n/a | build present but **unauthenticated** (401 vs `copilot.tencent.com`) | **BLOCKED** — "the model is not callable there" |
| 7 | `codex` | native Codex models | `codex-native` (`--model`, `-p/--profile`) | **YES** | `UNKNOWN` — `codex doctor` *reports* a provider, read-only, never forwarded | none tracked | none (no remaining/reset surface) | registry probe + `codex doctor` | **NOT TESTED** as a route; `codex` is `DEFAULT_REVIEWER` |
| 8 | `workbuddy-cn` | (any) | `workbuddy-cn-native` | **YES** | `UNKNOWN` | none | none | install probe; 401 unauthenticated | **BLOCKED** for execution — needs the user's own `/login` |
| 9 | `cline` | `cline-free/mimo-v2.6-flash` | `cline-native` (sidecar WS) | n/a — **not** an official Agent family | n/a | free tier, cost always 0 | none | sidecar probe | **VERIFIED** — and the **only** adapter that silently substitutes a default model (`DEFAULT_CLINE_MODEL`) |
| 10 | local `qwen38-27b-main` | — | — | — | — | — | — | — | **UNKNOWN** (external deployment status) / **NOT TESTED** (orchestrator route). See note 10a below. |
| 11 | local Qwen via `ollama-local` / `llama.cpp` on `opencode` | — | `local-ollama` (candidate) | **UNKNOWN** | **NOT TESTED** | n/a | n/a | n/a | **NOT TESTED** — OpenCode documents the config; this project has never run it |
| 12 | any model via `gateway` | — | `gateway` (candidate) | n/a | **NOT TESTED** | n/a | n/a | n/a | **NOT TESTED** — nothing exists |

#### Note 10a — `qwen38-27b-main`: two separate questions, two separate statuses

The earlier phrasing conflated an external deployment fact with an orchestrator capability fact.
They are distinct, and each gets its own status:

```text
External deployment status (outside this repository):
  UNKNOWN from repository evidence.
  The repository does not establish whether qwen38-27b-main is deployed anywhere.
  It must NOT be inferred from the Hindsight material.

Orchestrator execution route (inside this repository):
  NOT TESTED, and NOT registered as a verified ExecutionCandidate.
  No ModelRegistry entry, no free-pool entry, no adapter invocation.
```

**Why the earlier inference was wrong.** The Hindsight memory documents record `qwen38-27b-main`
in a table about the *memory subsystem's own* backing LLM. In that same material the phrases
`未触碰` ("not touched") and `保留主任务模型不动` ("leave the main task model alone") appear, and
the operative observation there is **`qwen2.5:7b` was actually used**. Reading a
"not touched / main task model unchanged" remark as **`未部署` ("not deployed")** is a category
error: "we did not touch it" is not "it was never installed", and neither is a statement about
any *agent* execution route.

**Net conclusion that survives the correction:** `qwen38-27b-main` has **no established agent
execution route in this project** and is **not** a verified candidate. That conclusion rests on
the orchestrator-side absence of any registration or invocation — **not** on any claim about
external deployment.

**Two inventory inconsistencies this freeze records rather than fixes** (both are runtime, so out
of scope now):

1. **Two divergent free lists.** `ACTIVE_FREE_MODEL_POOL` (3 entries, `agentId`-keyed, includes
   `workbuddy-intl/hy3`) vs `freeModelSeed()` (`src/quota/index.ts:443`, keyed on a **display
   name**, includes `cline-free/*`, omits `hy3`).
2. **`ModelEntry.provider` is a label, not a route.** Values in use are `'opencode'` / `'custom'`
   / `'workbuddy'`; `model-pool.ts:59` explicitly calls it *"Documentation only"*. It is currently
   the closest thing to a route and is not load-bearing.

**What does not exist anywhere in `src/`** (measured by exhaustive search, `src/core/types.ts:14`
being the governing prohibition *"No provider API shapes here. Adapters only ever spawn local
processes."*):

```text
model base URL / baseURL concept      (0 hits)
API key / token / secret field        (0 hits; the single `apiKey` is a probe string)
provider HTTP call, chat/completions  (0 hits)
/v1/responses, Anthropic messages     (0 hits)
Ollama HTTP for models                (0 hits; 1 hit is Hindsight memory's LLM)
per-agent supported-model matrix      (does not exist)
routing / fallback chain              (does not exist; no --fallback-model anywhere)
```

`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `*_BASE_URL` are **absent from the default inherited
environment**: `buildEnv` copies only `ENV_ALLOWLIST` from `process.env`
(`src/runtime/spawn.ts:90-101`, `:103-110`).

**Precise statement — no absolute claim.** The allowlist constrains the **default inherited**
environment. `buildEnv(extra)` then applies `if (extra) for (const [k, v] of
Object.entries(extra)) out[k] = v` (`src/runtime/spawn.ts:109`), so an **explicitly supplied**
`extra` entry may intentionally add further variables, including ones outside the allowlist.
It is therefore **not** correct to say these variables "can never enter child processes".

```text
default inherited environment = constrained by ENV_ALLOWLIST
explicit buildEnv(extra)      = may intentionally add further variables
=> secret handling must govern BOTH inherited and explicitly supplied entries
```

This is a statement of the current contract, not a runtime security remediation, and it changes
nothing about who may pass `extra` (that is a caller-authority question, out of scope here).

---

## 13. Free-model semantics (frozen)

The design must **stop** treating the free model pool as a plain `modelId[]`. It already is not
one — `ACTIVE_FREE_MODEL_POOL` is pair-keyed with an `evidence` grade per entry
(`confirmed-free` vs `zero-at-call-time`), which is the right instinct in the wrong frame.

**Frozen future semantics:**

```text
Free eligibility is a property of a usable execution candidate / access route,
not of a model id.
```

Because:

```text
same model + different route  ->  may differ in price
```

Consequently the unit of "free" becomes:

```text
freeEligible(candidate)  where candidate = (agentId, modelId, routeId)
```

The existing evidence grades (`confirmed-free` = `-free` id **and** a real run reporting
`costUsd: 0`; `zero-at-call-time` = a real call reporting `total_cost_usd: 0` with ceilings
unknown) are already the right vocabulary and should be carried forward per candidate. Note the
`workbuddy-intl/hy3` entry is graded `zero-at-call-time` with **"ceiling unknown"** — an honest
statement that must not be promoted to "confirmed free".

The pair-keyed pool is, today, a **proxy for route** — and it is already visibly straining
(§12 inconsistency 1).

---

## 14. Quota semantics (frozen)

```text
quota may belong to: provider · account · agent-native service · route
```

It does **not** belong to a model. Our own types already say so:

- `QuotaRecord.quotaSource` / `ModelEntry.quotaSource` are **labels** of a source
  (`ModelEntry.quotaSource`, `src/quota/types.ts:126`; the `QuotaRecord` analogue is
  `QuotaRecord.source`, a `QuotaSourceKind` at `src/quota/types.ts:83`).
- `QuotaStatus` includes `unavailable` with the comment: *"Source exists but exposes no quota
  endpoint (our four agents today)"* (`src/quota/types.ts:26`). The audited fact
  (`src/quota/collector.ts:215`) is that the CLI reports usage/login but **never**
  remaining/reset.
- `remaining` is nullable and **never defaulted to 0**; `resetAt` nullable; `costUsd` nullable
  because *"absence of a cost figure is information"*.

**Frozen future semantics:** Assignment should check the candidate's **effective**
quota/availability, i.e. the availability and quota of the route the candidate would use — not
`model.quota`. In practice, until a route runtime exists, every candidate's effective quota is
whatever the agent-native service reports, which today is `unavailable` for all four agents. That
is the honest current state and must not be rendered as "quota OK".

---

## 15. Harness-specific capability remains real

The existence of a Gateway does **not** make Agents interchangeable. The same Model under a
different Agent/Harness can differ in:

```text
tool behavior · prompt / system behavior · session / resume · structured output
permission model · review mode · skills · CLI semantics
```

Evidence **inside this repo** — the capability matrix is real and is per-adapter:

| Capability | OpenCode | Codex | WorkBuddy CN/Intl | Cline |
|---|---|---|---|---|
| `newTask` / `resume` | yes / yes | yes / yes | yes / yes (`-r`, verified) | — |
| `review` | **no** (no subcommand; review is a prompt) | **yes** (`codex exec review`, verified) | **no** (no subcommand) | — |
| `modelSelection` | yes (`--model`) | yes (`--model`) | yes (`--model`, verified) | yes (`config.model`) |
| `roleSelection` | yes (`--agent`) | yes (`-p/--profile`) | yes (`--agent/--agents`, verified) | — |
| `sandbox` | — | yes | **no** (no docker/podman/e2b on this machine) | — |
| permission model | own config | `--sandbox` | **mandatory** `--permission-mode bypassPermissions` in `-p` mode (measured: without it, no tool works) | auto-approve |

This is not incidental — it is load-bearing. `DEFAULT_REVIEWER` is `codex` precisely because
Codex has a native review entrypoint; OpenCode and WorkBuddy would have to fake review with a
prompt. And `review` **existing only where the adapter supports it** is already encoded as the
`TaskType` capability contract (`src/quota/types.ts:108-112`).

**Evidence from the external side.** LiteLLM, which routes five harnesses through one gateway,
still states that Codex "speaks the Responses API" and that for other providers "Codex-specific
features such as reasoning summaries may not survive" translation; and that Claude Code's prompts
"are written for Claude". A gateway unifies **transport**, not **harness semantics**.

**Conclusion:** Agent and Model remain **two first-class dimensions**, permanently. A gateway
adds a third (Route) — it never collapses the first two into one.

---

## 16. External architecture findings (evidence, not dependencies)

**No external project is adopted as a runtime dependency of this project.** These are reused as
architecture evidence only, per reuse-first: **REUSE CONCEPT → ADAPT → minimal project-native
design.**

### 16.1 LiteLLM-style gateway → harnesses share model infrastructure without collapsing identities

- Multiple coding harnesses (Claude Code, Codex, OpenCode, Deep Agents, Tool Loop) speak
  **different** model APIs — `/v1/messages`, `/v1/responses`, `/v1/chat/completions` — and share
  **one virtual key, the same model groups and the same fallbacks**. Provider keys live on the
  gateway and **never reach the machine**.
- The gateway **rewrites** the `model` field to a *model group*, so *"a runtime's own default
  model name never reaches the gateway"* — a model-group/alias layer, structurally the same idea
  as OpenCode's `models: { coder: { modelID: "upstream/coder-v2" } }` (§11).
- Every request is **tagged by harness** (`x-litellm-tags: harness, codex|opencode|...`), giving
  per-harness spend, request count and failure rate.
- **Verdict for us:** multiple harnesses can share model/provider infrastructure *without*
  collapsing harness identities ⇒ the correct shape is **Harness Plane separate from Model Access
  Plane**, not "everything becomes one Agent".
- **Also:** the gateway is a *separate surface with its own keys/budgets/logs* — not a brain and
  not an orchestrator (§9).

### 16.2 OpenCode provider architecture → a general harness consumes custom / OpenAI-compatible / local endpoints

- `baseURL` can be overridden for **any** provider, including catalog providers, to route through
  a proxy or compatible endpoint.
- A custom provider is `{ npm, name, options: { baseURL, apiKey, headers }, models }`, where
  **the provider id is the model-id namespace**.
- **Protocol is a provider property**: `@ai-sdk/openai-compatible` = `/v1/chat/completions`;
  `@ai-sdk/openai` = `/v1/responses`. Some models/features *require* Responses (Codex models,
  reasoning summaries, message phases).
- **Local endpoints are first-class documented providers** (ollama / llama.cpp / LM Studio /
  Atomic Chat), including local Qwen models.
- **Verdict for us:** the route dimension is not an invention — it already exists inside the
  harness. Our contribution is to *name* it, gate on it, and record it.

### 16.3 Multi-CLI orchestrators → real CLIs, isolated workspaces, per-harness state detection

- **Real CLIs, not simulated agents.** Nova AI: *"It coordinates **real CLIs**"*; ccmanager spans
  9 CLIs; orchestrator-sh runs `claude` / `codex` / `opencode`.
- **Per-worker isolation** via **git worktrees** (+ tmux), so parallel workers never collide on
  one tree. This independently corroborates T3-a's workspace separation and T3-b's capacity work.
- **Per-harness state detection** ("each assistant has its own state detection strategy")
  corroborates §15: harness identity is real operational state, not metadata.
- **Profiles as execution boundaries** (AOP: `edit` / `review` / `sealed` / `host`) corroborate
  our READ vs WRITE access-mode gate.
- **Provenance is expected**: AOP *"preserves the exact route for resume"* and records *"provider
  session identity when available"* — external corroboration for §19.
- **Cautionary contrast**: `orchestrator-sh` silently falls back to
  `router.fallback_executor` when the router fails. That is exactly the silent substitution §8
  forbids.

### 16.4 What we are explicitly NOT doing

```text
NOT adopting LiteLLM / Nova AI / AOP / ccmanager as dependencies
NOT copying a gateway implementation
NOT implementing a reverse proxy
NOT collapsing Agent and Model into one dimension
NOT letting each Agent independently own every provider concern   (that is the status quo)
```

The chosen direction: **Harness Plane separate from Model Access Plane**, with the Model Access
Plane initially *named and gated* rather than implemented.

---

## 17. Recommended architecture

```text
User
 ↓
Planner
 ↓
Laya                                     <- semantic decision authority
 ↓
Candidate Generator                      <- enumeration + compatibility + availability ONLY
 │   valid: Agent × Model × AccessRoute
 ↓
Laya Candidate Selection                 <- chooses from the validated set
 ↓
Assignment Exact Enforcement             <- admits or refuses; never substitutes
 ↓
SessionRegistry
 ↓
Scheduler
 ↓
Orchestrator
 ↓
Native Agent / Harness                   <- Harness Plane
 ↓
Model Access Route                       <- Model Access Plane (route)
 ↓
Model
 ↓
Attempt / Evidence                       <- execution identity + provenance
```

**The Candidate Generator is not a second semantic brain.** It sits *below* Laya and *above* the
registered facts; it has no task semantics. Laya remains the only semantic choice authority, and
Assignment remains the only admissibility authority. Inserting a generator must not add an arrow
that lets it choose.

---

## 18. Route observability (recommended, future implementation)

Once a route runtime exists, the **selected** route should enter execution provenance — e.g.
dispatch evidence and/or `AttemptRecord` metadata — so these become answerable:

```text
Which route did THIS worker actually use to reach THIS model?
Was this call free, and on which route?
Whose account / provider did the quota come from?
```

External corroboration: LiteLLM tags every request by harness so per-harness spend/failure is
queryable; AOP preserves the exact route for resume and records provider session identity. Route
provenance is the norm, not a luxury.

**Explicitly a future implementation. This round changes no `AttemptRecord`.**

---

## 19. Compatibility with T1 / T2 / T3-a

| Sealed work | Relationship to Model Access |
|---|---|
| **T1 — `WorkerIdentity { taskId, agentId, modelId, sessionId }`** | **Unchanged and not reopened** (§3). Route is a sibling dimension, not a member. `workerKeyOf`, `SessionRegistry`'s identity guard and `AttemptRecord` all keep their current contracts. |
| **T2 — Laya exact Agent × Model selection** | **The existing Agent × Model choice is the OLD SUBSET of `ExecutionCandidate`.** With a single route (`agent-native`) per agent today, `(agentId, modelId)` *is* the candidate. Extending route later **adds** a dimension; it does not deprecate `agentId`/`modelId` as core semantics. `AgentModelIntent` and `validateAgentModelIntent` remain the two-string validation; the atomicity rule (both halves or neither) is what a candidate object must preserve. |
| **T3-a — Worker fan-out / Session / Attempt / evidence attribution** | **Untouched.** Fan-out members carry `{agentId, modelId, scope}`; route is not in the member contract, not in `WorkerIdentity`, not in `FanoutMemberFacts`. T3-a.5's correlated attempt↔result bundle is orthogonal and stays exact. |

**Net:** the Model Access layer **adds a dimension**; it invalidates nothing that is sealed.

---

## 20. Laya decision shape: `candidateId` vs `(agentId, modelId, routeId)` tuple

**Question A** — Laya returns three flat strings; **Question B** — Laya returns a `candidateId`
that already binds the triple.

### What the code does today

Laya does **not** return structured agent/model fields at all. The pair is **encoded into the
`choice` key string** of a single `choice` answer:

```ts
export function initialCandidateKey(agentId: string, modelId: string): string {
  // A separator that cannot occur inside an agent or model id, so the key is
  // unambiguous rather than reconstructible by accident.
  return `${agentId}\0${modelId}`;         // \0 = NUL
}
export function decodeInitialCandidateKey(key: string): { agentId: string; modelId: string } | null
```

(`src/decision/initial-assignment.ts:59-70`.) The same pattern is used for T3 fan-out members
(`{agentId, modelId, scope}` carried as JSON in `answer.parameters.members`).

The validation is already the "validated candidate object" discipline:

- `readInitialAssignmentIntent` (`:133-197`) narrows the answer union, requires a `choice`,
  decodes the key, and **refuses any pair that was not offered** — *"a provider that invents one
  is refused here rather than reaching Assignment as a pair nobody offered."*

### Relationship to the T2 mechanism — similarity only, stated precisely

What T2 genuinely shares with the future `candidateId` design is **one discipline**:

```text
SIMILARITY:
  atomic offered-key selection — Laya may only answer with a key drawn from the
  set that was actually offered, and an unoffered key is refused rather than
  resolved. (readInitialAssignmentIntent refuses any pair not in `candidates`.)
```

What T2 is **NOT**, and must not be described as:

```text
NOT equivalent to:
  a full ExecutionCandidate registry
  a ModelAccessRoute runtime
  a route dimension in any sense
  a candidateId
```

Concretely, today's implementation still: **decodes** an Agent × Model pair from the key,
**validates offered membership** of that *pair*, and hands the pair to Assignment. There is no
candidate registry, no route in the key, and no route-aware lookup. Calling it "option B in
miniature" overstates it — the accurate statement is *"the same offered-key discipline, one
dimension narrower"*.

### Comparison

| Criterion | A: return `(agentId, modelId, routeId)` flat | B: return `candidateId` (validated candidate object) |
|---|---|---|
| **Schema stability** | Laya's answer type changes shape the moment route appears (2→3 strings), and again if provenance grows. Every consumer of `DecisionResponse` is touched. | Answer type is stable: still one opaque key. Route is added *inside* the candidate table, not into the answer. |
| **Laya prompt complexity** | Laya must be told to emit three coordinated strings; a partial triple is expressible and must be rejected. | Laya picks one offered key. The triple never appears in the answer space it must produce correctly. |
| **Exact enforcement** | Assignment must re-validate three fields and prove the triple was offered. | Assignment looks up the offered candidate by id — the same lookup `readInitialAssignmentIntent` already does. |
| **Observability** | Route is in the answer, but route *not chosen* is invisible. | The candidate table is the natural place to record availability, route, free-eligibility grade and quota for **every** candidate, not just the chosen one. |
| **Configuration churn** | Every new dimension forces a migration of answers, validators and tests. | New dimension = new column in the candidate table. Answer contract untouched. |
| **Sealed T2 compatibility** | Weakens T2's shape. | **Preserves it verbatim** — it is literally the same key mechanism with one more encoded field. |

### Recommendation (primary)

> **B — `candidateId` / validated candidate object.**

It matches the Owner's stated preference, and independently it is what the existing code already
does: an opaque, pre-validated key into an offered candidate set. Adding `routeId` to
`initialCandidateKey`'s NUL-separated encoding is the minimal change that preserves every
guarantee T2 sealed — atomic naming, "not offered ⇒ refused", decision-layer-must-not-resolve
(`src/orchestration/decision.ts:447-473`).

**B's one prerequisite** (and it is the same prerequisite T2 already has): the candidate table
must be **validated before Laya is asked**. Today the table is built from `ModelRegistry`. With
route, it becomes `RegisteredCandidate[]` — and a candidate whose route does not exist/verify is
**not offered at all**. Laya cannot name what it was never shown.

### CandidateId Stability Contract (frozen)

A `candidateId` is a **persistent semantic reference**, so its identity rules must be frozen now,
before any implementation exists. Five clauses:

**A — No positional identity.** A `candidateId` must **not** depend on the candidate table's
order or position.

```text
FORBIDDEN as persistent semantic identity:
  candidate-0
  candidate-1
  "the first offered option"
```

Positional ids are unstable by construction: insert, remove or reorder one candidate and every
later id silently changes meaning, which turns recorded evidence into a lie.

**B — 1:1 immutable within an offered decision context.** Within one offered decision context:

```text
candidateId  ->  exactly one immutable (agentId, modelId, routeId)
```

The mapping is fixed for the lifetime of that decision, and the same id must denote the same
triple for every consumer of that answer — Laya, Assignment, the scheduler and the evidence
writer.

**C — No later remapping.** The same `candidateId` must **never** subsequently be re-mapped to a
different triple. If a candidate's real configuration changes, that is a **new** candidate with a
**new** id, and any prior answer referencing the old id stays interpretable.

**D — Prefer a canonical deterministic encoding.** Future implementations should derive the id
from the candidate's own content, conceptually:

```text
canonicalCandidateKey(agentId, modelId, routeId)
```

which keeps T2's already-established pattern — an unambiguous, non-reconstructible-by-accident key
(`initialCandidateKey` uses a NUL separator for exactly this reason). **Not implemented in
T3-M0.**

**E — Laya must not see a semantically empty opaque id.** An offered option must carry
human/model-readable facts alongside the id:

```text
agent
model
route
capability
availability
free / quota evidence
```

`candidateId` is the **precise selection reference**, not the description. An id that carries no
readable meaning forces Laya to choose blind, and makes the reviewer's provenance unreadable.

**Do not implement any of this in T3-M0.** Frozen as a contract only.

---

## 21. Suggested direction for T3-b

T3-b should **not** become a hard rule of the form *"same Agent preference"* or *"multi-Agent
preference"*. Its input should be:

```text
valid ExecutionCandidates
+ task requirements
+ requested fan-out width
+ scheduler capacity
```

then:

```text
Laya      -> choose candidate(s)
Assignment-> enforce (exactly, never substitute)
Scheduler -> decide how many can actually dispatch NOW
next ticks-> drain the remaining accepted members
```

### 21.1 Sequencing: T3-b does NOT wait for a ModelAccessRoute runtime

This is the important compatibility statement, and it is what makes T3-b tractable now.

```text
T3-b does not wait for a full ModelAccessRoute runtime, a Candidate Registry,
a Gateway, or account/provider bindings to exist.
```

The reason is that **today's state is already a degenerate candidate**:

```text
current reality:
  candidate = (agentId, modelId, implicit-agent-native-route)

i.e. exactly one route exists per agent today, and it is agent-native.
```

So T3-b's **first phase may legitimately treat the existing `Agent × Model` pair as a
native-only degenerate candidate** and proceed with capacity/drain/observability work unchanged.

**Explicitly not asked of T3-b, and explicitly not to be done now:**

```text
do NOT start minting routeId values in the runtime
do NOT introduce a Candidate Registry
do NOT wire a Gateway
```

The degenerate-candidate framing is an **architecture-compatibility statement only**. It
describes how T3-b's scope relates to this freeze; it is not an instruction to materialise the
route dimension early, and it must not become a reason to write route code ahead of the design
that §8A / §8B / §20C still owe.

---

## 22. T3-b scope freeze

```text
T3-b — Candidate-Aware READ Scheduling & Capacity Drain
```

**Goals:**

```text
requested width vs actual maxConcurrent
accepted-but-not-yet-dispatched drain
candidate availability / quota changes over time
observability: requested · accepted · running · pending · settled workers
```

### 22.1 First scope, in priority order

T3-b's **first** slice is the scheduling/capacity problem, and only that:

```text
1. requested fan-out width  vs  maxConcurrent
2. accepted-but-not-dispatched  ->  drain on subsequent ticks
3. observability: requested / accepted / running / pending / settled
```

Everything below stays **independently deferred** and must not be pulled into the first slice:

```text
candidate route runtime
gateway / provider / account implementation
candidateId in the decision contract
route provenance in Attempt / dispatch evidence
```

This ordering is deliberate: the capacity/drain problem is real and valuable **today**, and it is
fully solvable under the degenerate-candidate framing of §21.1 without any Model Access runtime.

**Still closed:** WRITE concurrency (see §23).

---

## 23. Parallel WRITE boundary (CLOSED, restated)

```text
PARALLEL WRITE = CLOSED / deferred
BLOCKER: Windows process containment unresolved
```

Restated because three adjacent things in this document could otherwise look like ways around it:

```text
the Model Access layer
candidate-aware scheduling (T3-b)
a Gateway
```

**None of them has any authority to clear this gate.** Nothing in this document touches WRITE, the
spawn gate, or the access-mode rules, and T3-b's READ scope (§22) is bounded by this same
closure. A future Gateway would sit strictly *below* execution and therefore cannot affect the
containment question either way.

---

## 24. Appendix — files read for T3-M0

Runtime contracts inspected (read-only):

```text
src/core/types.ts            RunRequest / AgentDescriptor / AgentAdapter / credentialsHint
src/quota/types.ts           QuotaRecord, QuotaStatus, ModelEntry, TaskType, GATE_DENY_CODES
src/quota/registry.ts        modelKey() = agentId::modelId ; ModelRegistry ; ModelSeed
src/quota/index.ts           ACTIVE_AGENT_IDS ; DEFAULT_PROVIDERS ; freeModelSeed()
src/quota/collector.ts       QuotaProvider implementations ; credential COUNT only ; NO_QUOTA_NOTE
src/orchestration/model-pool.ts       ACTIVE_FREE_MODEL_POOL, EXCLUDED_FROM_FREE_POOL, isAllowedModel
src/orchestration/worker-identity.ts   WorkerIdentity, workerKeyOf
src/orchestration/assignment.ts       AgentModelIntent, validateAgentModelIntent, assignWorker,
                                      ASSIGNMENT_FAILURE_CODES, requestModelSwitch
src/orchestration/workbench-sessions.ts SessionRegistry, ExecutionTarget, session-identity-mismatch
src/orchestration/decision.ts         assertAtomicPair (layer boundary)
src/orchestration/execute.ts           RuntimeRunner, RunRequestMapping, buildRunRequest
src/orchestration/orchestrator.ts     the single runtime.run() edge
src/orchestrator/orchestrator.ts      model: req.model ?? cfg.model
src/orchestrator/config.ts            AgentConfig (no baseURL)
src/decision/types.ts                 DecisionProvider, DecisionResponse, answer union
src/decision/initial-assignment.ts    initialCandidateKey / decode / readInitialAssignmentIntent
src/decision/laya.ts                  loopback baseUrl, DEFAULT_BASE_URL
src/adapters/index.ts                 ADAPTER_FACTORIES, knownAgentIds, WORKBUDDY_FACTORIES
src/adapters/opencode.ts | codex.ts | workbuddy.ts | cline.ts   capabilities, argv, credentialsHint
src/runtime/spawn.ts                  env allowlist (no *_API_KEY / *_BASE_URL)
```

Repo documents inspected:

```text
docs/PROJECT_BASELINE.md                        canonical index + authority model + doc layering
docs/TEAMRUN_AGENT_MODEL_ARCHITECTURE_AUDIT.md  T1/T2 canonical; WorkerIdentity; seal formats
docs/TEAMRUN_T3_READ_FANOUT_ARCHITECTURE_AUDIT.md  T3-a canonical; member contract; seal format
docs/R2_COORDINATION_CONTRACT.md                coordination + Agent Admission
docs/DECISION_LOOP_EXECUTION_RESULT_CONTRACT.md receipt / attempt chain
docs/EXECUTION_ROUND_SEMANTICS.md               round / identity / quota
docs/PHASE6A_FREE_MODEL_POOL.md                 free-model pool evidence (historical snapshot)
docs/P6_ORCHESTRATION_PLAN.md                   roadmap; §10 Free Model Pool
docs/PHASE4_QUOTA_AUDIT.md                      quota surface audit; opencode providers list
docs/PHASE4M_HINDSIGHT_*.md                     the only ollama / qwen38 references (memory side)
docs/PHASE5B_MULTI_AGENT_ARCHITECTURE.md        legacy §18 Agent/Model (historical)
docs/CURRENT_STATE_AUDIT.md | WORKBENCH_ARCHITECTURE_AUDIT.md | DECISION_PROVIDER.md | (historical)
```

External references (architecture evidence only, not dependencies):

```text
LiteLLM  — harness/gateway (per-harness model API surfaces, model groups, virtual keys,
           per-harness request tags, fallback model-access + budget enforcement)
           docs.litellm.ai/docs/harness/gateway , /proxy/architecture , /proxy/reliability
OpenCode — providers (baseURL override, custom provider = provider-id namespace,
           openai-compatible vs responses, ollama/llama.cpp/lmstudio/Atomic Chat local routes)
           opencode.ai/docs/providers , /v2/docs/providers , anomalyco/opencode#15847
Orchestrators — Nova AI (real CLIs, worktree isolation), orchestrator-sh (LLM router +
           fallback_executor caution), AOP (profiles, exact-route resume, provider session
           identity), ccmanager (9 CLIs, per-harness state detection, worktrees)
```

---

## 25. Appendix — frozen summary

```text
Agent            = execution harness / native coding-agent family   (4 official families)
Model            = inference/reasoning capability identity          (opaque string; no reachability implied)
ModelAccessRoute = configuration/provenance dimension              (NOT a control-plane authority)
ExecutionCandidate = (agentId, modelId, routeId)                   (the executable unit)

WorkerIdentity   = { taskId, agentId, modelId, sessionId }          (T1 SEALED; route NOT added)

Laya             = semantic choice authority  (chooses from validated candidates)
Assignment       = admissibility/enforcement    (exact; never substitutes)
Candidate Gen    = enumeration + compatibility + availability ONLY (not a second Laya)
Gateway          = OPTIONAL model-access infrastructure
                   != Laya != Orchestrator != Assignment != Agent

free eligibility = property of a candidate/route, NOT of a model id
quota            = property of provider/account/agent-native/route, NOT of a model
Agent != Model   = harness capability differences are real and permanent

route failure != silent route substitution   (free -> paid especially forbidden)
route failover that changes cost/free/quota/provider/agent MUST re-enter decision+admission
transport retry on the SAME candidate MAY be transparent (§8A); identity-changing fallback may NOT

candidate visible/available != guaranteed executable        (snapshot != authority, §7.1)
Candidate Generator       != authoritative admission       (Assignment + pre-dispatch recheck)
candidateId               != table position; 1:1 immutable; never remapped; carries readable facts (§20)
provider/model prefix     != ModelAccessRoute identity     (§11.1)

account binding           = inside routeId when routeId identifies it uniquely (§8B);
                            otherwise future Option A (distinct stable routeId) preferred
                            over Option B (extra candidate dimension); not locked
credentials               = NEVER recorded in evidence/prompt/packet/logs; routeId + alias only

route provenance -> future: dispatch evidence / Attempt metadata   (NOT implemented)
T3-a             = SEALED (PASS WITH P2; P0=0, P1=0; P2 = root-only fan-out, maxConcurrent=2)
T3-M0            = SEALED (PASS WITH P2; P0=0, P1=0; 6 P2 doc clarifications CLOSED)
new authority    = 0
parallel WRITE   = CLOSED / deferred (Windows process containment)
```

---

## 26. Appendix — T3-M0 P2 documentation closure

**Seal.** `T3-M0 = SEALED`, on the basis of Codex T3-M0 Final Review = **PASS WITH P2**,
`P0 = 0`, `P1 = 0`, final recommendation *"SEAL T3-M0"*. The six P2 items were **documentation /
future-implementation constraints, not blockers**, and are **CLOSED** below.

| P2 | Was ambiguous / overstated | Now frozen as | Where |
|---|---|---|---|
| **P2-1** | "T2 already ships option B in miniature" implied a candidate registry exists | Similarity is **atomic offered-key selection only**; T2 still decodes an Agent × Model pair, validates offered *membership*, and has no registry / route / `candidateId`. Plus the full chain with **Assignment + pre-dispatch as the authoritative rechecks**, and `candidate visible != guaranteed executable`, `snapshot != authority`. | §7.1, §20 "Relationship to the T2 mechanism" |
| **P2-2** | `candidateId` had no identity rules | **CandidateId Stability Contract**: no positional ids; 1:1 immutable within an offered context; never remapped; prefer `canonicalCandidateKey`; offered option must carry readable facts (agent/model/route/capability/availability/free-quota evidence). | §20 |
| **P2-3** | Retry vs substitution were not separated | **Gateway Retry Boundary**: transparent transport retry allowed **only** when agent/model/route/account/pricing/candidate are all unchanged; anything changing model/provider/account/route/free-eligibility/pricing/identity **must** re-enter decision + admission; `free → paid` silent fallback forbidden. | §8A |
| **P2-4** | The triple was assumed sufficient for accounts | **Account / Credential Binding**: the triple suffices only when `routeId` uniquely identifies the provider/account binding; otherwise silent account swap is forbidden; future Option A (distinct stable `routeId`) preferred over Option B (extra dimension), **not locked**; credentials never recorded. | §8B |
| **P2-5** | "route dimension already exists in production" was misleading | Access-path differences exist **operationally inside external/native Agent config**, but the orchestrator has **no first-class route objects**; explicit list of what does **not** exist; provider/model prefix is **not** route identity; OpenCode's internal multi-credential ambiguity recorded; `qwen38-27b-main` split into external `UNKNOWN` vs orchestrator `NOT TESTED`, with the Hindsight mis-inference explicitly retracted. | §0, §11.1, §11.2, §12 note 10a |
| **P2-6** | "`*_API_KEY` can never reach a spawned agent" was absolute | Default **inherited** env is allowlist-constrained, but `buildEnv(extra)` may intentionally add more; secret handling must govern **both**. Stated as a contract fact, not a security remediation. | §12 |

Two further clarifications folded in at the same time:

- **§16.1 LiteLLM wording corrected.** It is now *"a configured fallback **capability** exists in
  the product"*, not *"fallback is on by default"*. The point stands and is in fact sharpened:
  because the dangerous capability exists, this project must forbid it explicitly rather than
  assume it absent.
- **§3.1 WorkerIdentity clarification.** `routeId` being outside `WorkerIdentity` does **not**
  make route unobservable (identity vs provenance are different mechanisms); and the document
  explicitly does **not** claim `SessionRegistry` implements a route guard — the real guard
  (`workbench-sessions.ts:196-207`) compares only `agentId` / `modelId`. A route incompatibility
  would produce a **new Session**, which changes `sessionId` naturally.

### 26.1 What is explicitly NOT claimed by this closure

Recorded so a later reader cannot mistake a frozen contract for a shipped feature:

```text
ModelAccessRoute runtime   = NOT implemented
Candidate Registry          = NOT implemented
candidateId                 = NOT implemented
Gateway                     = NOT implemented
route provenance in Attempt = NOT implemented
account / credential binding= NOT implemented
```

T3-M0 is an **architecture freeze**. Every runtime capability named above remains future work
(§18, §21.1, §22.1). `new authority = 0` is unchanged, and `parallel WRITE` remains **CLOSED**.

### 26.2 Scope of this closure round

```text
modified: docs/TEAMRUN_MODEL_ACCESS_ARCHITECTURE.md (canonical)
          + project-status data text
          + minimal cross-reference consistency edits in the three sibling docs
NOT modified: src/**  tests/**  runtime behaviour of any kind
NOT done: no commit, no push, no stash, no reset, no clean, no EOL renormalization
```
