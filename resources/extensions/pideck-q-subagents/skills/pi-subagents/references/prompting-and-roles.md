# Pi Subagents: Prompting And Roles

This file is a detailed reference loaded from `skills/pi-subagents/SKILL.md`.

## Capability ceilings

Parent extensions may register a session-scoped, out-of-band ceiling through `pi-subagents/capability-ceiling`. Child tools and eligible canonical agent names are intersected with every active registration and inherited snapshot; `denyExtensions` removes ambient/provider extension loading while retaining package protocol runtime. `{ action: "list" }` marks non-allowlisted agents as restricted, and launch rejects them before spawn. Do not add a model-visible ceiling field or rely on unrestricted role selection for enforcement. Restricted schedules are rejected until their ceiling can be persisted safely.

## When to Use

- **Complex work orchestration**: keep the parent on its ordinary strong default model. Delegate only when another child materially improves evidence, independent review, or isolated execution; omission failures are cheaper than unnecessary commissions. For hard orchestration or root-cause questions, use a top-reasoning model only as a bounded read-only critic escalation, never as an autonomous root. Complex means the task has multiple moving parts, unclear acceptance, cross-cutting code, meaningful user-visible impact, expensive or irreversible validation, broad review surface, or the user asks for orchestration. Lightweight one-off delegation can stay lightweight.
- **Advisory review**: use fresh-context `readonly` agents for adversarial code review; fork a `readonly` agent only for rare escalation where inherited decisions, drift, model routing, root cause, or hard tradeoffs matter
- **Implementation handoff**: have a `readonly` agent advise, then a `writable` agent implement only after an approved direction
- **Recon and planning**: use `readonly`, then write a plan when needed
- **Parallel exploration**: run multiple non-conflicting tasks concurrently
- **Regular skill specialists**: when discovery shows proactive skill subagent suggestions and the current work is broad enough, launch a small fresh-context fanout that asks one subagent per relevant regularly used skill to apply that skill's perspective to the task
- **Long-running work**: launch async/background runs and inspect them later. For mutation-capable work, bound the delivery slice and elapsed runtime, then request checkpoints after active tool work returns. Reserve hard tool-call caps for explicitly read-only children.
- **Subagent control**: watch needs-attention signals and soft-interrupt only when a delegated run is genuinely blocked
- **Agent authoring**: create, update, or override project agents. Treat saved chain records as legacy inspection or migration inputs, not as a current authoring target.

## Tool vs Slash Commands

Agents use the `subagent(...)` tool for execution, management, status, and control. Direct `{ agent, task }` execution is enough for one bounded child task; use `workflowScript` when the parent needs JavaScript control flow or data-dependent branching, keyed, parallel, sequential, retry, retained-resume, aggregate, or explicit staged-lane behavior (`runs.lanes`). Humans often use the slash-command layer instead:

- `/run` — launch a single agent
- `workflowScript` — the sole public surface for sequence, parallelism, branching, retries, and aggregation
- `/subagents` — interactive admin for inspecting agents and editing model, thinking, or system prompt
- `/subagents-stop [run-id]` — stop a current-session top-level async run; opens a selector when no id is given
- `/subagents-detach [run-id]` — detach an active foreground single-subagent run without terminating its child
- `/subagents-steer <run-id> [--child <child-id>] <message>` — steer a live async run (or one child of it) from non-TUI sessions and RPC hosts
- `/subagent-cost` — show parent plus child token usage and cost for the session
- `/subagents-fleet` — open the live fleet inspector with per-child controls; `Ctrl+Alt+F` opens it during an active foreground turn, `↑↓`/`jk` selects children, `PgUp`/`PgDn` scrolls transcript detail, `s` steers the selected live async child, and `D` stops its top-level async run after confirmation
- `/subagents-watchdog` — inspect or configure the opt-in adversarial change watchdog (model, on/off, recommend-model, check)
- `/subagents-doctor` — diagnose setup, discovery, async paths, and intercom bridge state
- `/subagents-models [agent]` — show the live runtime-loaded builtin model mapping
- `/subagents-profiles`, `/subagents-load-profile`, `/subagents-refresh-provider-models`, `/subagents-generate-profiles`, `/subagents-check-profile` — manage model profiles and provider catalogs
- `/prompt-workflow` — run a prompt template through native workflowScript execution

Prefer the tool when you are writing agent logic. Prefer the slash commands when
you are guiding a human through an interactive flow.

Packaged prompt shortcuts are also available for repeatable workflows. Treat them as reusable orchestration recipes, not just human slash commands. When the user asks for one of these shapes, or when the workflow clearly fits, apply the same pattern directly with `subagent(...)` and other tools:
- `/parallel-review` — fresh-context reviewers with distinct review angles, then synthesis
- `/review-loop` — parent-orchestrated implementation, fresh-reviewer, and fix cycles until clean or capped
- `/parallel-research` — combine `readonly` subagents for external evidence plus local code context
- `/gather-context-and-clarify` — investigate/research first, then ask the user clarifying questions with `interview`
- `/parallel-cleanup` — two fresh-context reviewers (deslop + verbosity passes) for an adversarial cleanup review of the current diff
- `/council` — bounded advisor council for material decisions, plan critique, cross-exam, and parent-written decision memos

## Applying Prompt Techniques Without Slash Commands

The prompt templates in `prompts/` encode workflows the parent agent can run on demand. If the user provides a URL, issue, PR, plan, local file, screenshot, or freeform target, treat that target as the primary scope: read or fetch it before launching children, then include it explicitly in every child task. For targets outside the parent cwd, include the exact repository, explicit `cwd`, authority boundary, and expected output path in each child task. Do not depend on the parent conversation history when the recipe calls for fresh context.

### Commission-risk and cold-start packets

Delegate only when the child materially improves evidence, independent review, or isolated execution; do not manufacture parallelism. Every child packet must be cold-start complete: state the goal, exact target/cwd/ref, authority and edit boundary, relevant context/evidence, success criteria, validation, output, and stop/escalation rules. For an orchestration audit by the critic tier, make the child read-only and request at most three omissions, each cited to a file, line, or decision; high thinking is an explicit escalation, not a default.

### Council Mode technique

Use Council Mode when the user asks to convene advisors, debate a material decision, cross-examine recommendations, or critique and improve a plan with several model perspectives. This includes requests such as “run a council on this architecture,” “have the configured advisors critique this plan,” or “get multiple advisors to debate the tradeoffs.” Read `../council-mode/SKILL.md` and follow its bounded parent-supervised protocol instead of launching ad hoc parallel advisor calls.

Council advisors are read-only. User or project `council-*` profiles choose allowed models and define any persistent stance in the profile body. A top-reasoning advisor remains bounded and read-only; it does not become the root. Package advisors such as Surf's `gpt-pro` can join the roster only when the `surf-cli` Pi extension is installed and its `surf-oracle` provider is registered; treat them as external runners, omit child `async` for attached results, and do not pass `outputSchema` to them. The council question and scope provide the decision frame; do not invent per-advisor role labels. The parent collects independent reports, optionally sends curated cross-exam packets, and writes the final memo. Do not treat the council as agent-to-agent chat, implementation authority, or a writer swarm.

### Parallel review technique

Use this when the user wants adversarial review of a diff, plan, issue, file, or implemented work. Launch fresh-context `readonly` agents with distinct angles generated from the actual target. Common angles are correctness/regressions, tests/validation, and simplicity/maintainability; adapt for TypeScript, UI, security, docs, or large structural changes. Reviewers should inspect files and diffs directly, return concise evidence-backed findings with file/line references, and avoid edits unless the user explicitly asks for a writer pass. Filter on evidence, not severity: report only concrete current issues caused or made reachable by the target diff, with source proof, a test or repro, or a contract contradiction. Label findings P0/P1/P2 and end with `Merge verdict: BLOCK`, `Merge verdict: OK`, or `Merge verdict: OK with notes`. Use `blockers only` only for final pre-merge re-checks after P1/P2 findings are already captured, or for explicit emergency hotfix lanes where non-blocking findings are intentionally deferred. For targeted follow-up, ask only whether the named finding was resolved, whether the fix introduced a new defect in the fix blast radius, and whether prior P1/P2 notes still stand. For bot or PR-comment triage, classify each comment as VALID, STALE, INVALID, or OUT-OF-POLICY against current HEAD, then assign P0/P1/P2 only to VALID comments. The parent synthesizes fixes worth doing now, optional improvements, and feedback to ignore/defer before applying anything.

### Proactive skill-specialist technique

Use this when `{ action: "list" }` reports proactive skill subagent suggestions and the user's task would benefit from perspectives the parent regularly uses. These suggestions are conservative: a skill is recommended only when it is available and referenced repeatedly by configured agents or saved chains. Treat the list as an opt-in hint for the current task, not a command to always fan out.

Default guardrails:
- Keep the fanout small: usually one or two skill-specialist children, never more than the listed recommendations or configured cap.
- Prefer `context: "fresh"` and include only the files, diff, plan, URL, or request details each child needs. Use forked context only when private/session history is essential and appropriate to share.
- Use read-only agents for analysis/review unless implementation was explicitly requested; do not create several writers in the same worktree.
- Skip proactive skill subagents for tiny questions, direct commands, highly private requests, or when the user asks not to delegate.
- Make cost and concurrency visible by using an ordinary `subagent(...)` call rather than hidden/background automation.

Example shape:

```typescript
subagent({
  workflowScript: `
    const results = await runs.all([
      { key: "deslop", agent: "readonly", task: "Apply the available 'deslop' skill to review the current diff for concrete cleanup findings only. Do not modify files.", skill: "deslop" },
      { key: "accessibility", agent: "readonly", task: "Apply the available 'accessibility' skill to review the UI changes for concrete issues only. Do not modify files.", skill: "accessibility" }
    ]);
    return results.map(result => result.output);
  `,
  context: "fresh"
})
```

### Review-loop technique

Use this when the user wants implementation or current diff review to continue until reviewers stop finding fixes worth doing now. Keep the loop in the parent session: one async `writable` agent implements or fixes, fresh-context `readonly` agents inspect the actual repo and diff, the parent synthesizes accepted fixes, and one async forked `writable` agent applies them. The parent can express the sequence up front as an async/background `workflowScript` when the workflow is known, or continue with explicit follow-up workflowScript runs after each async completion. For an initial workflow, pass `async: true` so the main chat is unblocked. Treat an async implementation handoff as an intermediate state, not final completion, unless the user explicitly asked for implementation-only work, review-only output, or to stop after implementation. Stop when reviewers find no P0 blockers or P1 fixes worth doing now, remaining P2 feedback is optional or deferred, an unapproved product/scope/architecture decision appears, or the max review-round cap is reached. Default to 3 review rounds unless the user sets a different cap. Do not loop for optional polish, and do not let children launch subagents or decide the loop outcome.

As a conservative orchestration policy, do not pass a hard `toolBudget` to a `writable` implementation or fix child, or other mutation-capable child. The default tool budget blocks read/search tools rather than mutation tools, but count limits still do not measure delivery safety. Use a narrow task plus an outer elapsed deadline with enough margin, then request a checkpoint after the current tool returns. The checkpoint should report changed files, build/test state, remaining work, and commit or PR state. An elapsed timeout is not a mutation-safe boundary and must not be used as the checkpoint trigger.

### Parallel research technique

Use this when the question needs both external evidence and local implications. Combine one `readonly` child for official docs, specs, ecosystem behavior, recent changes, benchmarks, and primary sources with another for repository files, patterns, constraints, tests, and likely integration points. Give each child a distinct angle: external evidence, local code context, and practical tradeoffs. Ask for source links or file ranges, confidence level, gaps, and decision implications. Do not ask these children to edit unless implementation was explicitly requested.



### Gather-context-and-clarify technique

Use this at the start of non-trivial work. Launch a `readonly` child for local context and another only when external docs, recent sources, ecosystem context, or primary evidence would materially improve understanding. Ask children for concise findings plus remaining clarification questions. Then synthesize what is known and use `interview` to ask the unresolved questions needed for shared understanding before planning or implementing.

### Parallel cleanup technique

Use this after implementation when the user wants cleanup review or when a final pass would reduce AI-slop. Launch two fresh-context `readonly` tasks with `output: false` and `progress: false`: one deslop pass and one verbosity pass. If the `deslop` or `verbosity-cleaner` skills are available, pass the relevant skill to that reviewer; otherwise inline the criteria. Both reviewers are review-only and should flag concrete issues with severity, file/line references, and smallest safe fixes. Phrase the constraint as “Do not modify project/source files; returning findings through the configured output artifact is allowed” when you use `output` or `outputMode: "file-only"`. The parent decides what to apply and asks before making changes unless cleanup was already authorized.

### Staged fix orchestration technique

Use this when a broad diff has known reviewer findings across several items and the user wants the parent to “orchestrate subagents like a boss.” Keep the active worktree safe with a three-stage `workflowScript`:

When staged seams are available, a low-tier writer should not receive the
end-to-end issue. Use `runs.lanes` inside `workflowScript` to keep stages narrow:
a recon/red test, helper-only change, one render seam, validation, minimality
challenge, or fresh review. Give the writer only its assigned implementation
stage; keep sequencing and synthesis with the parent.

1. A parallel read-only planning fanout, one `readonly` child per issue cluster. Each child inspects the real diff and returns exact files, line refs, proposed fixes, and focused validation. They must not edit.
2. One `writable` child. It receives the planning summaries as the awaited planning results (or their durable output paths) interpolated into its task, plus the parent’s accepted scope, stop rules, and verification contract. It is the only child allowed to edit the active worktree.
3. A parallel read-only validation fanout. Validators inspect the writer diff from fresh context with distinct angles, report pass/fail, remaining blockers, and missing verification.

Prefer `async: true`, `context: "fresh"` for reviewers/validators, `outputMode: "file-only"` for large summaries, and per-stage output names that will not collide. Use stable `runs` keys plus `phase` and `label` on each launch item to make async status readable, and hold each awaited result in an ordinary JavaScript variable when a later step needs that specific result — interpolate it (or the durable output path you declared for that child) into the later task text instead of passing a whole aggregate blob. Use this pattern instead of launching several writer workers into a dirty worktree. Include non-blocking suggestions in the writer prompt only when they are small, safe, and do not expand product scope; otherwise record them as deferred.

When one child returns a structured target list, use ordinary JavaScript to validate/filter it and map bounded entries into `runs.all`; do not use the removed chain fanout DSL.

Example shape:

```typescript
subagent({
  async: true,
  context: "fresh",
  workflowScript: `
    // Stage 1: parallel read-only planning fanout (stable keys, one per issue cluster)
    const plans = await runs.all([
      { key: "deploy-plan", agent: "readonly", phase: "Planning", label: "Deploy docs", task: "Plan fixes for deploy docs/workflow. Inspect the current diff. Do not modify project/source files; returning findings via the configured output artifact is allowed.", output: "plans/deploy.md", outputMode: "file-only" },
      { key: "scheduler-plan", agent: "readonly", phase: "Planning", label: "Scheduler contract", task: "Plan fixes for scheduler contract. Inspect the current diff. Do not modify project/source files; returning findings via the configured output artifact is allowed.", output: "plans/scheduler.md", outputMode: "file-only" },
      { key: "sandbox-plan", agent: "readonly", phase: "Planning", label: "Sandbox/security", task: "Plan fixes for sandbox/security. Inspect the current diff. Do not modify project/source files; returning findings via the configured output artifact is allowed.", output: "plans/sandbox.md", outputMode: "file-only" }
    ]);

    // Stage 2: single writer — the only child allowed to edit the active worktree.
    // Under outputMode "file-only" the awaited .output is the saved-output
    // reference, so pass those managed artifact references to the writer.
    const writer = await runs.run("apply-fixes", {
      agent: "writable",
      phase: "Implementation",
      label: "Apply accepted fixes",
      task: "Apply only the accepted fixes from these planning summaries. You are the sole writer for the active worktree. Run focused validation and report changed files, commands, failures, and remaining issues.\\n\\nDeploy plan: " + plans[0].output + "\\n\\nScheduler plan: " + plans[1].output + "\\n\\nSandbox plan: " + plans[2].output,
      output: "writer/fixes.md",
      outputMode: "file-only"
    });

    // Stage 3: parallel read-only validation fanout
    const validations = await runs.all([
      { key: "validate-deploy-scheduler", agent: "readonly", phase: "Validation", label: "Deploy/scheduler validation", task: "Validate the post-writer diff for deploy and scheduler fixes. Start from the writer result: " + writer.output + ". Do not modify project/source files; returning findings via the configured output artifact is allowed.", output: "validation/deploy-scheduler.md", outputMode: "file-only" },
      { key: "validate-sandbox", agent: "readonly", phase: "Validation", label: "Sandbox validation", task: "Validate the post-writer diff for sandbox/security fixes. Start from the writer result: " + writer.output + ". Do not modify project/source files; returning findings via the configured output artifact is allowed.", output: "validation/sandbox.md", outputMode: "file-only" }
    ]);

    return { writer: writer.output, validations: validations.map(v => v.output) };
  `
})
```

## Builtin Agents

Builtin agents load at the lowest priority. Project agents override user agents,
and user/project agents override builtins with the same name.

| Agent | Purpose | Recommended tier | Typical output / role |
|-------|---------|-------|------------------------|
| `readonly` | Investigation, adversarial review, research, advisory second opinions | strong tier at high thinking for serious reviews; inherits the parent otherwise | Cannot edit or write files; returns findings to the parent |
| `writable` | Default agent; implementation and general delegated work | capable worker tier | Single-writer implementation with decision escalation |

Both builtins use `tools: parent`: the launching session's active tools (and its direct MCP tools) are copied into the child at launch, with `readonly` excluding `edit` and `write`. They default to forked context; pass `context: "fresh"` for independent review or verification. Custom agents without an `extensions` field follow `subagents.defaultExtensions` when set.
Builtin agents inherit the current Pi default model unless a run, user setting, project setting, or `subagents.defaultModel` overrides `model`. The table records recommended tier routing, not shipped hard defaults; explicit run, user, or project settings still win. Keep the parent/orchestrator on the ordinary strong default model unless parent/user policy says otherwise. Override builtin defaults before copying full agent files when a small tweak is enough.

Set `subagents.defaultThinking` to apply a shared thinking level to builtin, package, user, and project agents whose frontmatter leaves `thinking` unset. Project settings win over user settings; matching `agentOverrides.<name>.thinking` and per-run overrides replace frontmatter, while an explicit frontmatter value remains in effect when no matching override is set. This setting affects child agents only and does not change the parent session's default thinking level.

```json
{
  "subagents": {
    "defaultThinking": "medium"
  }
}
```

For one run, use inline config:

```text
/run readonly[model=provider/review-model] "Review this diff"
```

For persistent tweaks, edit `subagents.agentOverrides` in user or project settings. User overrides apply everywhere. Project overrides apply only in that repo and win over user overrides. Use `/subagents-models` or `subagent({ action: "models" })` to inspect the live mapping after settings and overrides load.

Provider-scoped entries can layer on top of the default override for the active parent session provider. The provider is selected once from the parent model before child model fallback starts, so fallback attempts cannot switch configuration. Within each settings file, the provider entry wins per field; project settings still win over user settings.

```json
{
  "subagents": {
    "agentOverrides": {
      "writable": { "thinking": "medium" }
    },
    "agentOverridesByProvider": {
      "provider-a": {
        "writable": { "model": "provider-a/fast-model" }
      },
      "provider-b": {
        "writable": { "model": "provider-b/fast-model" }
      }
    }
  }
}
```

Model ids do not have to be exact. Separator variations (`fast.model-v1` vs `fast-model-v1`), case (`Strong-Review-Model`), and optional trailing date stamps all resolve to the same registry model. Exact `provider/id` wins; a qualified `provider/model` never switches providers. To constrain subagents to a budget or compliance profile, set `subagents.modelScope: { enforce: true, allow: ["approved-provider/*", "second-provider/approved-*"] }` in user or project settings. Out-of-scope models you pass explicitly error and abort; models inherited from frontmatter, `subagents.defaultModel`, agent frontmatter, or the parent session only warn.

For model fleets, use the profile commands instead of hand-editing repeated overrides: `/subagents-refresh-provider-models <provider>`, `/subagents-generate-profiles <provider>`, `/subagents-load-profile <name>`, and `/subagents-check-profile <name>`. Profiles live under `~/.pi/agent/profiles/pi-subagents/` and replace only `settings.subagents` when loaded.

## Prompting role subagents

Builtin role agents inherit the current Pi default model unless you override them. When launching them, write the task prompt as a compact contract, not a long procedural script. Define the destination and let the role choose the efficient path.

A strong subagent prompt usually includes:
- **Goal**: the concrete outcome the child should produce.
- **Target**: repository, explicit `cwd`, branch/ref/head, and source seam when the target is not the parent cwd.
- **Authority boundary**: whether the child may read, edit, commit, push, comment, close, merge, publish, or release. Omit or forbid actions that are not approved.
- **Context/evidence**: relevant plan paths, files, diffs, decisions, or user constraints already approved.
- **Success criteria**: what must be true before the child can finish.
- **Hard constraints**: true invariants only, such as no edits for review-only tasks, one writer thread, child must not run subagents unless it is explicitly authorized through `tools: subagent` or `allowNestedSubagents: true`, or escalation for unapproved decisions.
- **Validation**: targeted checks to run, or the next-best check when validation is impossible.
- **Output**: the expected summary shape, artifact path, or finding format. Use managed artifact paths for scratch reports; reserve repo-qualified absolute paths for durable handoffs that the user approved.
- **Stop rules**: when to ask via `intercom` or `contact_supervisor`, when to stop after enough evidence, and when not to keep searching.

Give each role useful discovery anchors. Name source roots, filenames, symbols, types, methods, and paths for investigation children. Give `writable` children context files, plans, task paths, and named source seams before asking them to search. Give `readonly` reviewers changed files, contracts, and any exhaustive-verification target. Tell advisory children whether current source behavior, product/policy documents, plans, or inherited decisions are the evidence that matters.

Avoid carrying over old prompt habits that over-specify every step. Use `must`, `always`, and `never` for real invariants; for judgment calls, give decision rules. For example, tell a reviewer to inspect the staged diff directly and report only evidence-backed findings, rather than prescribing every file or command. Tell a research child the retrieval budget: start with broad targeted searches, fetch only the strongest sources, search again only when a required fact is missing, then stop.

For implementation handoffs, name the approved scope and success criteria more clearly than the process. Good prompts say what to change, what not to change, where the evidence lives, how to validate, and when to escalate. They should not ask the child to create another subagent plan or continue the parent conversation.

Settings locations:
- User scope: `~/.pi/agent/settings.json`
- Project scope: `.pi/settings.json`

Direct settings example:

```json
{
  "subagents": {
    "agentOverrides": {
      "readonly": {
        "model": "provider/strong-review-model",
        "thinking": "high",
        "fallbackModels": ["backup-provider/strong-review-model"],
        "acceptanceRole": "read-only"
      }
    }
  }
}
```

Useful override fields: `description`, `model`, `fallbackModels`, `thinking`,
`systemPromptMode`, `inheritProjectContext`, `inheritGlobalContext`, `inheritSkills`, `defaultContext`,
`acceptanceRole`, `disabled`, `skills`, `tools`, `extensions`, and `systemPrompt`.
`description` replaces the discovered description for builtin and custom agents
in `list` output, which is useful for deployment-specific routing notes.
Use `acceptanceRole: false` to clear an override. Create a user or project
agent with the same name only when you want a substantially different agent.

### Recommended model tiering (optional)

Keep the parent/orchestrator on the ordinary strong default model because omission failures are cheaper than unnecessary commissions. Route routine `writable` work and recon to a fast, capable tier, and keep serious reviews on a strong tier at high thinking. Do not use a top-reasoning model as the routine fresh-review default. Use that tier only for bounded, read-only critic/root-cause audits after ordinary review, CI, bot, or source evidence is insufficient; critic-tier high thinking is escalation-only and never an autonomous root. Explicit parent/user model policy wins over these recommendations.

Examples are illustrative, not requirements. Map these tiers to concrete models in user/project settings or a profile. A non-OpenAI setup should choose comparable available models by capability.

Use `fallbackModels` when a tier has provider quota or availability risk. Prefer fresh context for cross-provider children when inherited provider-specific reasoning blocks would force thinking off.

If a provider rejects model IDs with thinking suffixes, use
`subagents.disableThinking: true` in user or project settings to clear bundled
builtin thinking defaults globally. A higher-precedence per-agent `thinking`
override can opt one builtin back in or replace custom-agent frontmatter thinking.

Set `subagents.defaultExtensions` to give agents without an `extensions` field a shared child extension allowlist. Omit it to preserve ambient extension discovery, set it to `[]` to disable ambient extensions by default, or use `agentOverrides.<name>.extensions` for one agent. A matching override replaces custom-agent frontmatter for that field.

Tool description modes live in `~/.pi/agent/extensions/subagent/config.json`, not `subagents` settings. The default uses split prompt metadata: a short tool description plus active `promptSnippet` and `promptGuidelines`. Set `toolDescriptionMode` to `full` or `compact` to force one description string, or `custom` to read `subagent-tool-description.md` from the project config dir or agent dir; invalid custom files fall back to full mode and the safety guidance is still appended.
