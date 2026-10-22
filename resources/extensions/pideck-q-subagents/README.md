<p>
  <img src="https://raw.githubusercontent.com/nicobailon/pi-subagents/main/banner.png" alt="pi-subagents" width="1100">
</p>

# pi-subagents

`pi-subagents` lets Pi delegate work to focused child agents. Use it for code review, investigation, implementation, parallel audits, saved workflows, background jobs, and anything else that benefits from a second or third set of model eyes.

<https://github.com/user-attachments/assets/702554ec-faaf-4635-80aa-fb5d6e292fd1>

## Install

```bash
pi install npm:pi-subagents
```

That is the only required step. Background children require pi installed as the npm package (`@earendil-works/pi-coding-agent`): the detached runner imports pi's packages from that package directory. A standalone single-file pi binary has no package directory and cannot run background children; foreground children (`async: false`) still work there.

## Try this first

You do not need to create agents, write config, or learn slash commands. After installing, ask Pi in plain language:

```text
Use a readonly subagent to review this diff.
```

```text
Ask a readonly subagent for a second opinion on my current plan. Challenge assumptions and tell me what I might be missing.
```

```text
Use a readonly subagent to understand this code based on our discussion, then ask me clarification questions.
```

```text
Run parallel reviewers: one for correctness, one for tests, and one for unnecessary complexity.
```

That is enough to start. Pi decides whether to call the `subagent` tool, which agent to use, and how to compose the work.

## How it works

Pi is the parent session. A subagent is a focused child Pi session with its own job.

When you ask for a subagent, Pi starts the child, gives it the task, and brings the result back. Foreground children run as sessions inside the parent Pi process and stream in the conversation. Background children run as sessions inside a detached runner process that keeps working and can be checked later.

### Supervisor decisions in foreground workflows

When a child needs a supervisor decision, a foreground workflow returns an explicit `needs_attention` handoff immediately so the parent can answer. The original in-memory JavaScript VM, child sessions, deadlines, and sequential dependencies remain live; this is not an empty task result or a new background runner.

1. Inspect the indicated provider's pending requests for the authoritative question and current request id: `subagent_supervisor({ action: "pending" })` for native supervisor questions, or `intercom({ action: "pending" })` for external intercom questions. A queued notification can be stale.
2. Reply to that id. The original workflow continues with the child's authoritative exit result; later stages do not consume a provisional detach receipt.
3. Use `subagent({ action: "status", id: "<workflow-id>" })` or `bg_wait({ id: "<workflow-id>" })` for the final output. New decisions interrupt waits even with `all: true` or `stopOnAttention: false`. Completion also sends a notification.

Do not resume/replay the workflow or start a replacement writer while its children are live. `interrupt` or `stop` can cancel the retained workflow, but child ownership is released only on confirmed child exit. Continuations are memory-only: changing the parent session or reloading the extension aborts them rather than replaying old code. At most 50 live/retained foreground workflows are held; terminal entries are evicted first.

External attention is tied to the owned intercom tool call and clears when that call settles; an old tool completion cannot clear a later ask. Mixed waits preserve async/provider completions and failure evidence alongside foreground output. A live retained VM keeps a compatible host session alive even between model children; terminal history does not pin the session.

Workflow cleanup waits at most one second for host/steer callbacks after abort. If a callback ignores cancellation, the failure explicitly warns that the operation may still be live; inspect it before retrying rather than assuming timeout means successful termination. Read-only agents report checks that would write files as verification limitations instead of repeatedly asking for permission to break their role.

Installing the extension does not start an automatic review in the background. It gives Pi a delegation tool. If you want every implementation reviewed, say so in your prompt or project instructions:

```text
When you finish implementing, run a readonly review subagent before summarizing.
```

## Builtin agents

The extension ships with two agents:

| Agent | Use it when you want... |
|-------|--------------------------|
| `readonly` | Investigation, review, and research. Cannot edit or write files; its prompt also forbids file-modifying shell commands. |
| `writable` | The default. Edits files and runs commands. Used whenever a launch does not name an agent. |

Both inherit the parent session's tools, model, and thinking level, and start with the parent conversation (`context: "fork"`). Ask for `context: "fresh"` when you want an independent review or verification. See [Agents](docs/agents.md).
## Common workflows

The package includes `/council` and `council-mode`, plus documented model-based
`council-*` profile examples that you add in your own agent directory.

| Want | Ask naturally |
|------|---------------|
| Get a second opinion | "Ask a readonly subagent to review this plan and challenge assumptions." |
| Solve a hard problem | "Use a readonly subagent to investigate this bug before we edit." |
| Review a diff | "Use a readonly subagent to review this diff." |
| Run parallel reviewers | "Run reviewers for correctness, tests, and cleanup." |
| Debate a material decision | "Use `/council` with model-based advisors to compare this decision." |
| Implement then review | "Implement this, then review it." |
| Review until clean | "Run a review loop on this change with a max of 3 rounds." |
| Execute a plan carefully | "Have a writable subagent implement this approved plan, then run readonly reviewers and apply the feedback." |
| Investigate before planning | "Use a readonly subagent to inspect the auth flow before planning." |
| Run in the background | "Run this in the background." |
| Use a saved workflow | "Run the review chain on this branch." |
| Browse agents | "Show me the available subagents." |
| See running work | "Show active async runs." or "Show the subagent fleet." |
| Check setup | "Check whether subagents are configured correctly." |

For implementation work, the recommended loop is `clarify → readonly scan → writable → fresh readonly reviewers → writable`. Packaged prompt shortcuts like `/parallel-review` and `/review-loop` make these patterns repeatable — see [Workflows](https://github.com/nicobailon/pi-subagents/blob/main/docs/workflows.md).

## Where running work shows up

Foreground runs stream progress in the conversation. Background runs keep working after control returns to you.

In the TUI, a persistent FleetView below the editor keeps active work visible. `/subagents-fleet` opens a live inspector where you can browse children, read transcripts, steer a running child, or stop a run. You can also just ask: "Show me the current async runs."

Details, keybindings, and the machine-readable run artifacts are in [Observability](https://github.com/nicobailon/pi-subagents/blob/main/docs/observability.md).

For bounded orchestration, `maxSubagentSpawnsPerRun` limits cumulative logical children in one run tree. It defaults to 64 and stays separate from active concurrency and the session-wide cumulative spawn budget. See [Configuration](https://github.com/nicobailon/pi-subagents/blob/main/docs/configuration.md#maxsubagentspawnsperrun).

## If something feels off

```text
/subagents-doctor
```

or ask: "Check whether subagents and intercom are set up correctly."

For installed-version help, use `/subagents-guide [topic]` or `subagent({ action: "guide", topic: "workflows" })`. The default topic is `overview`; available topics are `overview`, `workflows`, `agents`, `missions`, `observability`, `tool-reference`, `configuration`, `models`, `watchdog`, and `extension-api`.

## Documentation

The full reference lives in `docs/`:

| Doc | What's in it |
|-----|--------------|
| [Agents](https://github.com/nicobailon/pi-subagents/blob/main/docs/agents.md) | Custom agents, frontmatter reference, overriding builtins, tools, extensions, skills, per-agent memory. |
| [Models](https://github.com/nicobailon/pi-subagents/blob/main/docs/models.md) | Default models, per-role overrides, recommended tiering, fallbacks, thinking levels, model scope enforcement, profiles. |
| [Workflows](https://github.com/nicobailon/pi-subagents/blob/main/docs/workflows.md) | Orchestration patterns, prompt shortcuts, scripted workflows, worktree isolation, child-to-parent coordination, the recursion guard. |
| [Watchdog](https://github.com/nicobailon/pi-subagents/blob/main/docs/watchdog.md) | The opt-in adversarial change reviewer, scope monitoring, LSP checks, and child tool permissions. |
| [Tool reference](https://github.com/nicobailon/pi-subagents/blob/main/docs/tool-reference.md) | Every `subagent` parameter, management actions, status/control actions, acceptance gates, external CLI runners. |
| [Observability](https://github.com/nicobailon/pi-subagents/blob/main/docs/observability.md) | FleetView, the fleet inspector, lifecycle artifacts, events, logs, session sharing. |
| [Missions and schedules](https://github.com/nicobailon/pi-subagents/blob/main/docs/missions.md) | Durable mission records, delivery receipts, timed and recurring runs. |
| [Configuration](https://github.com/nicobailon/pi-subagents/blob/main/docs/configuration.md) | Every `config.json` key and environment variable. |
| [Extension API](https://github.com/nicobailon/pi-subagents/blob/main/docs/extension-api.md) | The RPC, delegation API, preflight, capability ceilings, [trusted workflow resources](docs/extension-api.md#trusted-workflow-resources), background-work providers, Herdr integration. |
