# PiDeck-Q Subagents

This bundled extension lets the parent Pi session delegate focused work to native Pi child sessions. It supports investigation, implementation, parallel review, scripted workflows, and supervised follow-up while PiDeck-Q keeps the live child state visible.

## Try it

Ask the parent in ordinary language.

```text
Use a readonly subagent to review this diff.
```

```text
Run parallel reviewers for correctness, tests, and unnecessary complexity.
```

```text
Have a writable subagent implement this plan, then run fresh readonly reviewers and apply the accepted fixes.
```

The parent chooses the agent and composes the workflow. A single task uses `{ agent, task }`. Sequential and parallel work use `workflowScript` with `runs.run(...)`, `runs.all(...)`, or `runs.lanes(...)`.

## Execution and supervision

Children run in the foreground inside the parent Pi process. Omit `async` or set it to `false`. The public tool and workflow child calls reject `async: true`.

Every 600 seconds, native run supervision asks the parent for a `CONTINUE` or `STOP` decision. `CONTINUE` keeps the existing child and any explicit deadline. An unanswered check continues the child under the existing supervision policy. `STOP` cancels the child through its owned runtime controls.

When a child needs a supervisor decision, the foreground workflow returns a `needs_attention` handoff so the parent can answer. The original JavaScript VM, child sessions, deadlines, and sequential dependencies remain live.

1. Read the current question and request id with `subagent_supervisor({ action: "pending" })`. A queued notification may be stale. If a child explicitly uses an installed intercom provider, inspect that provider's pending requests.
2. Reply to the current request id. The same workflow continues and waits for the child's final result before executing dependent stages.
3. Read `subagent({ action: "status", id: "<workflow-id>" })` or wait with `bg_wait({ id: "<workflow-id>" })`. Completion also sends a parent notification.

A handoff does not make the live workflow resumable. Do not replay it, call `resume` on it, or launch a replacement writer while its children are live. `interrupt` and `stop` can cancel retained foreground work. Ownership is released after child exit is confirmed. Changing the parent session or reloading the extension aborts the retained continuation. At most 50 live or retained foreground workflows are held, with terminal entries evicted first.

`bg_wait` tracks retained foreground workflows and detached foreground children. `all: true` waits for the initially tracked work, while new supervisor questions still return control to the parent. `nonBlocking: true` registers a wake subscription for one supported run identity. Normal subagent completion notifications remain available without a subscription.

## Builtin agents

| Agent | Purpose |
| --- | --- |
| `readonly` | Investigation, research, and review. It cannot edit files, and its prompt forbids file-modifying shell commands. |
| `writable` | Implementation and commands. This is the default when a launch omits the agent name. |

Both inherit the parent model and thinking level and default to forked conversation context. Use `context: "fresh"` for an independent review. Custom profiles can select tools, models, context, output paths, and explicit extensions. All executable profiles use native Pi sessions.

The subagents extension owns child environment policy, child tool gates, supervisor coordination, and workflow validation. The prompt optimizer only transforms the main prompt. See [Agents](docs/agents.md) and [Models](docs/models.md).

## Common workflows

| Goal | Prompt or command |
| --- | --- |
| Inspect a design | Ask a readonly child to challenge the current plan. |
| Implement and review | Use one writable child, then fresh readonly reviewers. |
| Review until clean | Use `/review-loop` with a bounded number of rounds. |
| Compare a material decision | Use `/council` with native model-based advisor profiles. |
| Review several areas | Use `/parallel-review` with distinct review angles. |
| Inspect available agents | `subagent({ action: "list" })` |
| Inspect active work | `subagent({ action: "status" })` or `/subagents-fleet` |
| Diagnose setup | `/subagents-doctor` |

Keep one writer per working directory unless independent worktrees are explicitly part of the workflow. Readonly children should report checks that require writes as validation limitations.

## Status, controls, and follow-up

Foreground runs stream progress into the conversation. FleetView and the fleet inspector expose child activity and controls. Use `status` for run details and `steer` for live guidance. A direct foreground child uses `interrupt` or a supervisor `STOP` decision for cancellation. Retained workflow roots and their active children also support `stop`.

After a child settles, `children.list` reports whether it is resumable. A supported native `resume` starts a foreground continuation from the retained session under the same model and tool contract. Stopped children remain non-resumable. A live supervisor handoff continues through its pending request and retained VM.

`maxSubagentSpawnsPerRun` defaults to 64 logical children in a run tree. This budget is separate from active concurrency and the optional cumulative session budget.

## Packaged guides

Use `/subagents-guide [topic]` or `subagent({ action: "guide", topic: "workflows" })` to read the installed version's guide. The default topic is `overview`.

| Guide | Contents |
| --- | --- |
| [Agents](docs/agents.md) | Custom profiles, frontmatter, tools, skills, extensions, and memory. |
| [Models](docs/models.md) | Model selection, fallbacks, thinking, and profiles. |
| [Workflows](docs/workflows.md) | Sequential and parallel composition, worktrees, and supervisor handoffs. |
| [Watchdog](docs/watchdog.md) | Optional change review, scope checks, and child tool permissions. |
| [Tool reference](docs/tool-reference.md) | Execution parameters, management, status, controls, and acceptance gates. |
| [Observability](docs/observability.md) | FleetView, progress, lifecycle artifacts, and logs. |
| [Missions](docs/missions.md) | Durable work records and delivery receipts. |
| [Configuration](docs/configuration.md) | Supported settings and environment variables. |
| [Extension API](docs/extension-api.md) | Control RPC, delegation, preflight, capability ceilings, and trusted workflow resources. |
