# Observability

Where running subagents show up, how to inspect them, and the files and events they leave behind.

## Foreground runs

Foreground runs stream progress in the conversation while they run. Runs have no implicit wall-clock deadline. Explicit `timeoutMs` or `maxRuntimeMs`, agent defaults, and the applicable global [`timeoutMs`](configuration.md#timeoutms) setting remain available.

Native Pi children with an active parent supervisor send a runtime progress snapshot after 600 seconds. The parent decides `CONTINUE` or `STOP`. Reporting does not call a model or pause the current tool, and only one decision request can be pending. Continuing starts the next 600-second interval. Missing or expired replies leave the work running. Set `control.enabled` to `false` to disable these reports.

A foreground child is a Pi session inside the parent Pi process. Runtime timeout, tool timeout, interrupt, and supervisor `STOP` use the owned child cancellation path. A retained workflow also supports workflow-level `stop`. Detach keeps the child session running inside the parent, with status, wait, and completion delivery still attached to its original identity.


Live progress shows compact detail for single, chain, and parallel modes: a bounded one-line task, current tool, recent output, token counts, aggregate cost, duration, activity freshness, current-tool duration, and chain graph metadata when available. Workflow `label` metadata wins over raw task text in compact multi-child cards.

Press Pi's configured expand key (`Ctrl+O` by default) to expand the full streaming view with complete output per step. Running-card hints also advertise `Ctrl+Alt+F` for the Fleet inspector.

Sequential chains show a flow line like `done readonly → running writable`. Chains with parallel steps show per-step cards instead. Chain status uses `label` and `phase` metadata when present, while falling back to agent names for older chains.

## Retained foreground work

A supervisor question returns a `needs_attention` handoff while the original workflow VM and its children remain live. Inspect the current pending request, answer it, and continue observing that same run.

```ts
subagent_supervisor({ action: "pending" })
subagent({ action: "status", id: "<workflow-id>" })
bg_wait({ id: "<workflow-id>" })
```

A reply lets the retained workflow continue with the authoritative child result. Dependent stages wait for that result. Do not resume or replay the workflow during the handoff. Changing the parent session or reloading the extension aborts the retained continuation.

`bg_wait({ all: true })` tracks work active when the call starts. New supervisor decisions return control even when `stopOnAttention` is `false`. A non-blocking wait subscription can wake the parent for a supported retained run identity, while ordinary completion notifications remain enabled.

Use `status` with `view: "transcript"` to inspect child output. Add `index` for a specific child when the run has several children.

### Reducing status display noise

Chat records tool-call history; FleetView and the retained-run widget show live run/child updates. Separate `subagent({ action: "status", id: "..." })` calls leave separate historical entries even when their `Status target: run …` labels match. A matching run ID identifies the queried run, not the tool call, and is not evidence of duplicate execution. Live Fleet/widget refreshes do not merge those entries.

For compact chat results with FleetView as the only live editor surface, merge these top-level keys into `~/.pi/agent/extensions/subagent/config.json` (not Pi's `settings.json` or a `subagents` object), then restart Pi:

```json
{
  "inlineToolDisplay": "summary",
  "fleetView": true,
  "asyncWidget": false
}
```

- `inlineToolDisplay: "summary"` keeps one static result row per call, alongside its call heading. A completed status query is not proof that the queried child has finished.
- `fleetView: true` retains live progress. Open `/subagents-fleet` or press `Ctrl+Alt+F` for details instead of repeatedly requesting status just to watch progress. Pi's expand key does not expand summary results; keep `"rich"` if you want expandable inline output.
- `asyncWidget: false` hides only the additional under-editor retained-run widget, leaving FleetView available. This configuration reduces visible surfaces; it does not guarantee ordering relative to other extensions.

Thanks to [DraconDev](https://github.com/DraconDev) for reporting the display noise and suggesting summary mode in [#1931](https://github.com/nicobailon/pi-subagents/issues/1931).

## FleetView

In the TUI, a persistent FleetView below the editor keeps active work visible as a compact summary. Set `fleetViewPlacement` to `"aboveEditor"` to move it above the editor.

```text
2 active agents · 1 pane · ↓ 3.1k window · 4.2k spent · ↓/← to inspect
```

After you expand it:

```text
↑↓/jk select · enter inspect · esc back

> main
    readonly · running      1m 12s · ↓ 2.0k window · 2.8k spent
    writable · running        38s · ↓ 1.1k window · 1.4k spent
```

When the focused editor is empty, press `↓` or `←` to expand the summary into `main` plus active children with agent name, state, elapsed time, and token usage. When providers report usage, `window` is the latest assistant turn's input plus cache-read tokens, while `spent` keeps the cumulative input-plus-output total. Old run artifacts without window data keep the existing token-total label. The compact line counts active current-session work and Herdr project panes. Then use `↑`/`↓` or `j`/`k` to select a child and `Enter` to open the Fleet lobby; press `Enter` or `H` there to open its child-specific Herdr inspector. Printable navigation keys are never intercepted before activation.

FleetView and the under-editor retained-run widget are both enabled by default; set `asyncWidget: false` to keep only FleetView. Successful completion notifications stay quiet so inactive Pi tabs are not marked unread, while failed or paused completions still notify the originating session. Parallel runs show every active child independently. Chains with parallel groups keep their grouped shape in progress and results, so failed or paused agents stay visible next to completed ones. When a child is explicitly allowed to fan out with `tools: subagent` or `allowNestedSubagents: true`, its nested runs appear under that parent child in the main status tree instead of being hidden inside the child session.

## The fleet inspector

`/subagents-fleet` opens the live fleet inspector with current-session foreground work, retained children, structured Markdown/tool transcripts, and completed output/session paths.

Default keys:

- `↑`/`↓` or `j`/`k` — select a child
- `Shift+K`/`Shift+J` — scroll one line
- `PgUp`/`PgDn` — scroll one page
- `x`/`Ctrl+O` — toggle tool details
- `r` — refresh
- `Esc` — close
- `Enter` — open the selected inspectable child in its child-specific Herdr inspector
- `s` — compose an acknowledged message to a selected live child; Tab cycles `steer`, `follow_up`, and `auto`
- `D` — stop a selected retained workflow when its status exposes that control
- `H` — open the selected inspectable child in a Herdr inspector pane (Herdr 0.7.5+)

Set `fleetKeybindings` in the extension config to replace inspector-level keys when a terminal intercepts keys such as `PgUp`, `PgDn`, `Home`, or `End`. Prompt modes keep fixed keys such as `Esc`, `Enter`, `Tab`, and stop-confirmation `Y`/`N`.

`Ctrl+Alt+F` opens the same inspector even while a foreground turn is active and slash input is queued.

Enter and `H` use the existing Herdr pane path. In a child-specific Herdr inspector, type ordinary guidance and press Enter to send it through the acknowledged steer channel; `steer <message>`, `status`, and `stop` remain available as explicit controls.

Without a TUI, `/subagents-fleet` retains the textual `subagent({ action: "status", view: "fleet" })` fallback, and mutations use explicit commands: run `/subagents-stop` and pick from the selector, or use `/subagents-stop <run-id>` / `subagent({ action: "stop", id: "..." })` when you already know the id.

Use `/subagents-detach [run-id]` only for an active foreground single-subagent run you want to leave running without terminating; the eventual result remains available through status/wait.

Set `foregroundDetachShortcut` in `~/.pi/agent/extensions/subagent/config.json` to bind the same action to a shortcut. The running foreground card shows the configured shortcut beside its live-detail hint:

```json
{
  "foregroundDetachShortcut": "ctrl+b"
}
```

Pi binds `Ctrl+B` to editor cursor-left by default. The extension shortcut takes precedence, but Pi reports the conflict at startup. To reserve the key without that warning, override the editor action in `~/.pi/agent/keybindings.json`:

```json
{
  "tui.editor.cursorLeft": "left"
}
```

If something feels misconfigured, run `/subagents-doctor` or ask: "Check whether subagents and intercom are set up correctly."

## Host inspection protocol (RPC)

RPC hosts receive tracked run status through the bounded `subagent-async` widget
(`PI_SUBAGENT_ASYNC_JSON:` payload). For on-demand detail — a child's delegated
task, transcript window, or final output — hosts can invoke the extension
command:

```text
/subagents-inspect-rpc <requestId> <asyncId> [childId] [--lines N]
```

Extension commands execute inline over Pi RPC without a model turn. The reply
arrives as a single emit-then-retract update on the dedicated `subagent-inspect`
widget key: the first (and only) line is `PI_SUBAGENT_INSPECT_JSON:<JSON>` with a
versioned `pi-subagents.inspect-reply` payload correlated by `requestId`. Hosts
must not render this widget; they should buffer the payload by `requestId` and
drop unmatched replies.

Inspection properties:

- Read-only and on demand: nothing is persisted, broadcast, or added to
  notification details; every request re-reads canonical run artifacts after
  the same reconciliation the status action performs.
- Session-scoped: runs owned by another session fail with `foreign_session`;
  unknown ids fail with `not_found`; cleaned-up artifacts fail with `stale`.
- Bounded: per-field string caps, a message-count cap (`--lines`, max 200), and
  a hard 64 KB serialized budget with explicit `truncated` markers.
- No filesystem paths appear in the reply.
- `task` is the child session's first user message and is only populated when
  it is genuinely attributable (fresh-context child whose session file fits the
  read window); forked children omit it.
- `childId` is exactly the node id the host received in the status snapshot
  (step `workflowKey`/`runId`/`step:<index>`, or a nested run id).

In TUI mode the command only points at the interactive `/subagents` inspector.

## Lifecycle records and status

Foreground progress and final results expose bounded run and child metadata, including identity, state, timing, model, usage, output references, and nested children when fanout is enabled. Workflow details include the stable child keys and a terminal receipt. Inspect the returned artifact paths instead of guessing a file location.

Status readers also accept existing persisted lifecycle records. Some compatibility fields and widget names retain `async` in their names, including `asyncDir`, `asyncSnapshot`, and `subagent-async`. These names do not enable independent background execution or workflow replay.

`bg_wait` returns bounded completion metadata for the work it observed. Native completion delivery keeps the originating parent-session identity. A result or output archive records evidence, while live child ownership and the retained workflow VM determine whether a run can still proceed.

RPC hosts can subscribe to `subagent:child-status` for low-latency stop hints. The payload includes `type: "subagent.child-status"`, `version: 1`, `runId`, `childId`, `status`, and `ts`, with optional bounded child metadata. Hints can be duplicated. Current status remains authoritative. Child cancellation uses the existing workflow `stop` request with `childId`.

`launchResolvedExtensions` reports parent-resolved extension intent using opaque identifiers. It does not establish that the child acknowledged loading them.

### Runtime extension acknowledgement

Cooperating child extensions can acknowledge child-runtime registration by emitting `subagent:acknowledge-extension` on the child session's `pi.events` bus with payload `{ id: string }`. The parent process captures the child session acknowledgement in memory.

Acknowledgement ids are self-declared opaque strings. They must be non-empty, at most 128 characters, contain only `A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, `@`, `+`, or `-`, and must not contain `/`, `\`, or `..`.

The reported `runtimeAcknowledgedExtensions` projection is `{ version: 1, source: "child-runtime", ids, omitted }`. It deduplicates ids, keeps at most 32 ids, and counts additional valid unique ids in `omitted`. It is best-effort observability only: absence means no cooperating extension acknowledged, and presence means only that the extension registered in the child runtime, not that its tools, health checks, or features succeeded. Late acknowledgements after terminal serialization are ignored.

### Lifecycle events

`events.jsonl` records lifecycle transitions such as `subagent.run.started`, `subagent.step.started`, `subagent.step.completed`/`failed`/`paused`/`stopped`, control attention events, nested interrupt failures, and `subagent.run.completed`/`stopped`. Run boundary events include the lifecycle artifact version.

### Process-terminal proof

Historical lifecycle records may include `process-terminal.json`, and RPC retains the `processTerminalProof` capability for readers of those records. An absent or unknown proof does not establish process termination. Foreground execution instead releases its owned child only after child-session settlement. A terminal-looking message or a successful stop request is insufficient by itself.

### Child session events

Foreground execution subscribes directly to the child session event stream. The `events.jsonl` artifact mirrors those events with `message_update` dropped, and the transcript records them with `message_update` projected the same way pi's JSON mode prints it. `agent_end.willRetry` defers completion until the child settles, and `agent_settled` is the terminal watermark; a child whose run does not settle shortly after its terminal event is aborted and finished without it.

### Completion notification diagnostics

For an instrumented parent session, enable Node's opt-in debug sink **before starting Pi**:

```sh
NODE_DEBUG=pi-subagents-notify pi 2>notification-debug.log
```

This writes bounded JSON records prefixed `PI-SUBAGENTS-NOTIFY <pid>:` to stderr, not run artifacts or chat. The capture also contains other stderr output; review it before sharing. Records contain only `reason`, sanitized `id`/`runId` (up to 128 characters each), and `source`; task/output text, paths, credentials, and exception bodies are not included.

- `disposed`, `missing_session`, `foreground_session_mismatch`, `not_owned`: delivery rejected by an existing guard.
- `emit_foreground_session_mismatch`, `emit_not_owned`: ownership/session recheck rejected emission.
- `intercom_delivered`, `deduped_ttl`: already acknowledged; no new message needed.
- `deduped_pending`: shares an in-flight delivery promise.
- `batch_deferred`: held for batching, **not lost**; look for a later emission or disposal record for the same run.
- `send_accepted`, `send_failed`: `sendMessage` returned or threw, respectively. Acceptance is not proof the model read the message; failures remain retryable.
- `dispose_pending`: notifier shutdown left held results unacknowledged for later delivery.

Without `NODE_DEBUG`, tracing only checks the debug-enabled flag: no identity sanitization/serialization, diagnostic buffering, or log I/O. Existing delivery guards, TTL, timers and batching are unchanged. Traces cover notifier decisions only, not discovery gaps; absence of a trace does not diagnose the original missing-notification symptom.

## Workflow and debug artifacts

Each scripted workflow stores runtime artifacts under a workflow artifact directory. The on-disk directory is still named `chain-runs` for compatibility. With the default `artifactDir: "session"` or with `"temp"`, it is user-scoped temp storage. With `artifactDir: "project"`, the root is `<cwd>/.pi/subagents/chain-runs/`:

```text
<tmpdir>/pi-subagents-<scope>/chain-runs/{runId}/
```

A run directory may contain files such as `context.md`, `plan.md`, `progress.md`, and `parallel-{stepIndex}/.../output.md`. User-scoped temp workflow artifact directories older than 24 hours are cleaned up on extension startup; project-local and explicit persistent roots are not age-scanned.

Debug artifacts live under `{sessionDir}/subagent-artifacts/`, `.pi/subagents/artifacts/` for project-scoped runs, or a user-scoped temp artifact directory. Single-run relative `output` files are saved under `{artifactsDir}/outputs/{runId}/` unless `singleRunOutputBaseDir` is configured. For lane, review, council, and gate reports, prefer these managed artifacts or the aggregate workflow result instead of repo-root `reports/` files. Copy only final durable evidence to session memory, a mission artifact, a PR/comment, or an approved docs path. Per task you may see:

- `{runId}_{agent}_input.md`
- `{runId}_{agent}_output.md`
- `{runId}_{agent}.jsonl`
- `{runId}_{agent}_meta.json`

Metadata records timing, usage, exit code, final model, attempted models, fallback attempt outcomes, and the resolved acceptance ledger with its parsed child report.

For npm package projects, project-scoped artifacts need a `.npmignore` rule (or `.gitignore` when no `.npmignore` exists) or a `files` allowlist that does not include `.pi/subagents/`. pi-subagents warns at launch when these package settings can include the artifacts. Use `artifactDir: "session"` or `"temp"` to keep them outside the package worktree.

## Sessions

Session files are stored under a per-run session directory. With `context: "fork"`, each child starts from a branched session file produced from the parent's current leaf and opens it in-process. That is a real session fork, not an injected summary. An omitted launch `context` that resolves through `defaultContext: fork` uses the same branch when the parent session file and current leaf exist, and otherwise starts fresh.

## Recovery briefs

Recovery briefs cover native foreground single launches, foreground `action: "resume"` continuations, and workflow children.

When one of those children ends abnormally — a runtime/model error, an unexpected termination, or a timeout — after doing real work, the failed receipt carries one short recovery brief so the parent can decide whether to continue or correct that same child.

The brief is produced by a single bounded, tool-free inference that uses the child's own effective provider/model and thinking level. There is no model switching and no fallback to the parent model: if the child's model cannot be resolved unambiguously, the deterministic evidence brief is used instead. The inference summarizes the whole run (early, middle, and late progress, validation results, failures, and blockers) from phase-bucketed evidence, and reports the interruption point from the most recent tool activity. Thinking blocks are never included, dropped evidence is marked, and the inference cannot call tools or touch the child session. The parent-language sentence in the prompt is advisory only; there is no locale detection. No claim is made about live-model summary quality.

Runtime identity comes from the settled child session and its recorded request metadata, including the effective thinking level after defaults and capability clamping. Model lookup is exact-only; another date/version or provider is never substituted. Continued runs include stored task requests and earlier results alongside the new execution events, under separate evidence budgets.

Guards worth knowing:

- A clean success, an explicit stop or interrupt, a detach receipt, parent cancellation, and a prelaunch failure produce no brief.
- A run governed by a `usageBudget` skips the inference and uses the deterministic evidence brief instead, so no unauthorized spend happens.
- A model/auth failure, timeout, empty response, an errored/aborted/truncated terminal response (even with partial text), or an inference that exceeds the whole-lifecycle deadline also degrades to that deterministic brief; the child's original error, output, acceptance state, and file-only output semantics are never rewritten.
- Parent cancellation or an explicit child interrupt during the inference aborts the agent and suppresses the late brief. Any usage the provider already reported is still preserved; the original child failure remains unchanged.
- The inference's measured token/cost usage is added to the child's usage and the parent aggregate exactly once. It does not add turns or tool calls.
- The brief is separate from `finalOutput` and is also written to the child's metadata artifact.

The block ends with the authoritative run id, session file, transcript path, and output artifact. Continuation advice is only printed when the normal resume resolution would accept the run; otherwise the block states that the child cannot be resumed in its original session. Resuming continues the same child session under a new run id. Workflow aggregate output includes a failed child's brief even when the script returns only that child's output; the brief is never counted as task success or as `finalOutput`.

## Completion notifications

Completion notifications belong only to the originating session. The result watcher emits `subagent:async-complete`, and the extension consumes that event to record completion state.

Successful sibling completions are held briefly and delivered as a quiet grouped completion when they finish within a short window (see `completionBatch` in [configuration.md](configuration.md)), avoiding unread markers on inactive tabs. Failed and paused completions remain visible and fire immediately.

## Events

Compatibility event names:

- `subagent:async-started`
- `subagent:async-complete`

These event names remain available for lifecycle compatibility. Host code should use the advertised projection versions and current run identity, without inferring a detached launcher from an event name.

Intercom delivery events:

- `subagent:control-intercom`
- `subagent:result-intercom`

`src/extension/index.ts` registers the notification handler that consumes `subagent:async-complete`. Control/attention events are surfaced as visible parent notices and recorded with tracked run evidence. Native supervisor requests are delivered only to the exact parent session that spawned the child.

`pi.events` is in-process only. It does not reach separate Pi processes or child subagents; use the file lifecycle artifacts or `pi-intercom` for cross-process coordination.
