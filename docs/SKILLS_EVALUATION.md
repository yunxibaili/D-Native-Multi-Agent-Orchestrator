> **[Historical — Skill 评估记录]** 未安装任何 skill；Agent Skill 语义后续走
> R2-0 契约（native skill 归 Native Agent，Workbench 不建 skill runtime）。
> 当前基线见 docs/PROJECT_BASELINE.md。

# SKILLS_EVALUATION — what to install, and what to refuse

Two sources were evaluated, both fetched and inspected locally (not from READMEs
alone). Nothing has been installed into the user or project config; the clones used
for inspection live in a temp fixture.

## Sources

| Repo | Stars | License | Version | Notes |
|---|---|---|---|---|
| `obra/superpowers` | **292.3k** | MIT | 6.4.2 | 15 skills; ships a **plugin** for OpenCode, not just skills |
| `addyosmani/agent-skills` | **99.6k** | MIT | 0.6.11 | 25 skills; per-harness adapters incl. OpenCode *and* Codex |

Stars are from the GitHub repo pages (the REST API returns 403 from this network).
Both licences are MIT, so both are usable here.

## Loadability was measured, not assumed

Validated all 40 candidate `SKILL.md` files against OpenCode **1.18.31**'s actual
documented loader contract: `name` + `description` required, `name` matching
`^[a-z0-9]+(-[a-z0-9]+)*$` and **required to equal the directory name**, description
1–1024 chars.

**Result: 0 failures.** Neither repo has a loader problem. The real discriminators
are workflow conflict and context cost.

Both repos also declare `"skills": "./skills/"` in `.codex-plugin/plugin.json`, so
the **same skill directory serves OpenCode and Codex**. One skill set, two agents —
no forked copies. Codex is `0.158.0-alpha.2.1`, well past the `v0.122+` that
`codex plugin marketplace add` needs.

## The constraint that decides placement

From `npm run doctor` on this machine:

```
[ok] opencode  can: newTask, resume, modelSelection, roleSelection, streamEvents, costReporting, extraArgs, cwd
              rejects: review, sandbox, steering, worktree, fork, stdinPrompt
[ok] codex     can: newTask, resume, review, modelSelection, roleSelection, sandbox, streamEvents, extraArgs, cwd
              rejects: costReporting, steering, worktree, fork, stdinPrompt
```

**OpenCode cannot do `review`; only Codex can.** The implement→review split is not a
preference, it is enforced by the capability matrix. So build-side skills go to
OpenCode and review-side skills go to Codex — installing a review skill into
OpenCode would teach it a role its adapter refuses.

## Recommended core set (5)

| Skill | Source | Stars | License | OpenCode | Codex | Verdict | Reason |
|---|---|---|---|---|---|---|---|
| `test-driven-development` | agent-skills | 99.6k | MIT | ✅ | ✅ | **KEEP** | 4.1k tok. RED-GREEN-REFACTOR with anti-rationalization. Its Chrome DevTools MCP section is browser-only and inapplicable here. |
| `api-and-interface-design` | agent-skills | 99.6k | MIT | ✅ | ✅ | **KEEP** | 3.7k tok. Contract-first, error semantics, boundary validation — exactly what `src/decision/` was designed against. |
| `code-review-and-quality` | agent-skills | 99.6k | MIT | — | ✅ | **KEEP** | 5.1k tok, the largest of the set. Five-axis review, severity labels, "would a staff engineer approve this?". Belongs to Codex, the only agent that can review. |
| `debugging-and-error-recovery` | agent-skills | 99.6k | MIT | ✅ | ✅ | **KEEP** | 2.6k tok. Five-step triage + stop-the-line + safe-fallback rules. Cheapest high-value skill in the set. |
| `doubt-driven-development` | agent-skills | 99.6k | MIT | ✅ | ✅ | **KEEP** | 4.1k tok. CLAIM → EXTRACT → DOUBT → RECONCILE. Genuinely adversarial; complements a reviewer that shares no context with the implementer. |

**~19.7k tokens** if all five are loaded at once. They load **on demand** via
OpenCode's `skill` tool, so the realistic cost per run is one or two skills, not
five — but that assumes the `description` fields do their job, and agent-skills'
descriptions (198–880 chars, explicit "Use when") are far better for auto-triggering
than superpowers' (79–234 chars, terse).

## Adapted, not installed verbatim

| Skill | Source | Verdict | What must change |
|---|---|---|---|
| `requesting-code-review` | superpowers (292.3k) | **ADAPT** | Its core instruction is *"Dispatch a code reviewer subagent"*, and its rationalization table **forbids** reviewing inline ("coordinating burns the context window you need"). Both are wrong here: the reviewer is a separate **Codex process**, and the **orchestrator** owns review dispatch, not the implementer. Keep the useful parts — base/head SHA capture, the Critical/Important/Minor taxonomy, "never proceed with unfixed Important issues", "hand the reviewer crafted context, never your session history" (743 tok, otherwise excellent). Drop the subagent dispatch and the anti-inline table. |
| `verification-before-completion` | superpowers | **KEEP (alternative)** | 899 tok, harness-agnostic, pure process. A cheaper substitute for `code-review-and-quality` if context is tight, but weaker. Do not install alongside it. |
| `subagent-driven-development` | superpowers | **SKIP** | 8.1k tok, the largest skill considered, and entirely built on dispatching a fresh subagent per task. Superseded by the orchestrator, which *is* the multi-agent dispatcher. |
| `systematic-debugging` | superpowers | **SKIP (redundant)** | 2.4k tok, 4-phase root cause, overlapping with `debugging-and-error-recovery`. Pick one. |
| `test-driven-development` (superpowers copy) | superpowers | **SKIP (redundant)** | 2.4k tok vs agent-skills' 4.1k. Same name, different depth. Having two skills with an identical `name` is also an OpenCode discovery hazard — names must be unique across locations. |

## Refused

| Skill | Verdict | Reason |
|---|---|---|
| `frontend-ui-engineering`, `performance-optimization`, `browser-testing-with-devtools` | **SKIP** | No frontend in this project. `browser-testing-with-devtools` and `performance-optimization` require a Chrome DevTools MCP server that is not part of this runtime. |
| `shipping-and-launch`, `ci-cd-and-automation` | **SKIP** | No deploy target and no CI in the repo. Would be aspirational process with nothing to gate. |
| `observability-and-instrumentation` | **SKIP (for now)** | Real value, but the project has a deliberate stderr-only logger with no telemetry sink to instrument. Premature. |
| whole-pack install of superpowers | **SKIP** | Its OpenCode install path adds `.opencode/plugins/superpowers.js`, which **executes plugin code** at session start to inject a bootstrap. This project prefers composable markdown over an injected methodology that can override an agent's judgement. Copy individual skills instead. |
| `/build` "autonomous single approved pass" | **SKIP** | Removes human checkpoints between tasks. Directly contradicts this project's fail-loud, explicit-decision posture. |

## Install shape (when approved)

```powershell
# OpenCode reads .opencode/skills/ and .claude/.agents/skills/; Codex reads skills/ via its plugin.
# Copy individual skill folders; do NOT run the installers (one adds a plugin, the other needs SSH).
```

Two installation traps found in the READMEs and worth recording:

1. **A per-skill `npx skills add` copies only `skills/<name>/`, not the repo-level
   `references/`.** Skills referencing shared checklists silently lose those paths
   (upstream tracks this as `#361`). Either whole-repo install, or copy the needed
   checklist in alongside the skill.
2. **Do not install two skills with the same `name`** from different sources.
   OpenCode requires unique names across all locations; `test-driven-development`
   exists in both repos.

OpenCode also supports per-agent gating, which is how the review/build split should
be enforced: `"permission": { "skill": { "code-review-*": "deny" } }` on the
implementer, so the review skill is not merely discouraged but invisible to it.
