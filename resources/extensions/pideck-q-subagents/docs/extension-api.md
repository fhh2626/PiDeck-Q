# Extension and integration APIs

Public seams for other Pi extensions and host integrations: the in-process RPC, the structured delegation API, launch preflight, capability ceilings, the background-work provider contract, and the Herdr integration.

## Trusted workflow resources

Loaded trusted TypeScript extensions can import `registerWorkflowResource` from `pi-subagents/workflow-resources`. This subpath does not load the main extension and exposes no resolver or permit constructor. Its exported types are `RegisterWorkflowResourceInput`, `WorkflowResourceDefinition`, and `WorkflowResourceRegistration`:

```typescript
registerWorkflowResource({
  sessionId: string,
  definition: {
    name: string,
    version: number,
    resolve(args: Readonly<Record<string, unknown>>):
      | { script: string; hostCommands?: readonly { key: string; command: string }[] }
      | { error: string },
  },
}): { dispose(): void }
```

Names are case-sensitive, at most 128 characters, and match `[A-Za-z0-9][A-Za-z0-9._-]*`; use an extension prefix. Versions are positive safe integers. Registration throws for invalid input, protected builtins (`review`, `run-ci`), or duplicate names within the same session. Different sessions may register the same name. Dispose before replacement; there is no silent overwrite.

Register in `session_start` using **`ctx.sessionManager.getSessionId()`**, not the session file path or a tool argument. Dispose in `session_shutdown`. New/resumed/forked sessions and reloads need registration from the replacement runtime's `session_start`; do not retain old `pi`/`ctx` references. The extension owns cleanup, not an automatic registration lifecycle manager. Disposal is idempotent and cannot remove a newer replacement. Missing cleanup can cause a duplicate-registration failure on reload.

`resolve` must do synchronous, bounded validation and string construction, without I/O, SDK calls, timers or process work. Core deep-copies plain JSON args: at most 16 KiB encoded, nesting depth 8, 16 fields per object, 64 items per array, finite numbers, and nonempty strings of at most 16 KiB. The extension must additionally reject unsupported fields and validate resource-specific semantics. Throws, promises/thenables and malformed expansions fail before authority is issued; errors are bounded to 4096 characters.

Host grants bind **exact key/trimmed-command pairs**, not independent sets of keys and commands. At most 32 grants are accepted, with unique safe workflow keys and nonempty commands bounded to 16 KiB without NUL. Omitted grants give no host authority. Core snapshots the expansion and grants at resolution. Disposing stops future lookup, but already-admitted workflows retain captured grants, even after replacement. Use existing stop/deadline controls for cancellation; this does not promise survival of host shutdown. Existing child admission and capability ceilings still apply.

### Mixed child and finite host example

This extension owns two fixed commands; `scripts/finite-check.mjs` must be an existing trusted finite helper in the workflow cwd. It runs a readonly review first, then a check. No command or flags come from free-form public args.

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkflowResource } from "pi-subagents/workflow-resources";

export default function (pi: ExtensionAPI) {
  let registration: { dispose(): void } | undefined;
  pi.on("session_start", (_event, ctx) => {
    registration?.dispose();
    registration = registerWorkflowResource({
      sessionId: ctx.sessionManager.getSessionId(),
      definition: {
        name: "acme.review-check",
        version: 1,
        resolve(args) {
          if (Object.keys(args).some(k => k !== "task" && k !== "check"))
            return { error: "Only task and check are supported." };
          if (typeof args.task !== "string" || !args.task.trim() || args.task.length > 4000)
            return { error: "task must contain 1–4000 characters." };
          if (args.check !== "quick" && args.check !== "full")
            return { error: "check must be quick or full." };
          const command = args.check === "quick"
            ? "node ./scripts/finite-check.mjs --mode quick"
            : "node ./scripts/finite-check.mjs --mode full";
          const host = { kind: "command", command, timeoutMs: 120000 };
          return {
            hostCommands: [{ key: "check", command }],
            script: `
              const review = await runs.run("review", {
                agent: "readonly", task: ${JSON.stringify(args.task)}
              });
              if (!review.ok) throw new Error("Review child failed");
              const check = await runs.host("check", ${JSON.stringify(host)});
              return { review: review.output, check };
            `,
          };
        },
      },
    });
  });
  pi.on("session_shutdown", () => {
    registration?.dispose();
    registration = undefined;
  });
}
```

Invoke through the public `subagent` tool:

```json
{
  "workflow": "acme.review-check",
  "args": { "task": "Review the current change; return findings only.", "check": "quick" }
}
```

The parent evaluates child findings and ordinary command logs/status/terminal receipts; child success is not approval or proof of a clean review. The timeout above bounds the host command, not the whole workflow.

**Trust boundary:** this API composes already-loaded trusted code; it is neither authentication nor a sandbox. Session IDs scope lookup, not authorization between malicious extensions. Core owns opaque permits and provenance; caller-supplied issuer/trust/permit metadata cannot grant authority. Raw public scripts and script paths do not gain host authority, and registration is not an arbitrary-command entry point for public args.

The existing shell runner uses workflow cwd and inherited environment. Exact matching does not pin PATH resolution, executable bytes, repository helpers, or credentials. Those remain operator/extension trust responsibilities. `JSON.stringify` embeds data in JavaScript source; **it is not shell escaping**. Keep commands fixed as above, or validate strictly bounded numeric/hex tokens before binding known positions; never concatenate arbitrary task text or flags into shell commands. No new runner, cwd confinement, CI/merge policy, or SDK lifecycle framework is provided.

## In-process event-bus RPC

PiDeck-Q and other loaded host integrations can inspect and control existing runs through the process-local event bus. Listen for `subagents:rpc:v1:ready`, send requests on `subagents:rpc:v1:request`, and read replies from `subagents:rpc:v1:reply:<requestId>`.

```typescript
const requestId = crypto.randomUUID();
pi.events.on(`subagents:rpc:v1:reply:${requestId}`, (reply) => {
  // { version: 1, requestId, success: true, data } or
  // { version: 1, requestId, success: false, error: { code, message } }
});
pi.events.emit("subagents:rpc:v1:request", {
  version: 1,
  requestId,
  method: "status",
  params: { id: runId }
});
```

The supported methods are `ping`, `status`, `steer`, `interrupt`, `stop`, and `resume`.

- `status` resolves targeted run details or a bounded current-session fleet projection. Successful replies retain `text`, `details`, `fleet`, and `asyncSnapshot` when available. Targeted `view`, `lines`, and `index` remain supported.
- `steer` requires a run target and non-empty `message`. Optional modes are `steer`, `follow_up`, and `auto`. Receipts report `deliveryStatus: "delivered" | "queued"`. RPC steering disables automatic pause-and-revive recovery so it keeps the original target identity.
- `interrupt` uses the package-owned foreground or nested-run cancellation path.
- `stop` cancels a retained foreground workflow, optionally targeting one active child by `childId`. An ordinary foreground single child uses `interrupt` or its supervisor's `STOP` decision.
- `resume` requires a settled, resumable native child and a non-empty `message`. It validates ownership, stored session metadata, capability ceilings, and the exclusive session lease before starting a foreground continuation. Optional `output` can request a file-only result. A live supervisor handoff must continue through its existing request and VM.

`ping` advertises the exact supported methods and projection versions. `nonRecoveringSteer`, `resume`, `statusProjection`, and `fleetStatus` describe the contracts above. `launchResolvedExtensions` and `runtimeAcknowledgedExtensions` describe bounded extension diagnostics. `processTerminalProof` and the `asyncComplete` event name remain compatibility fields for recorded lifecycle data. Their presence does not enable independent background launches.

Structured delegation progress includes `runId` as soon as the foreground run allocates it. Foreground `details.results[]` rows include a stable numeric `index`. Use `(runId, index)` to correlate progress and terminal results.

### Fleet status DTO

When `ping.capabilities.fleetStatus` is `{ version: 1 }`, successful `status` replies include `data.fleet`: `{ version: 1, entries, totalActive, omitted }`.

Entries are bounded, current-session public display records with an opaque reconciliation `key`, resolved `agent`, optional `role`, `model`, `effort`, caller-facing `goal`, safe `startedAt`, and `{ input, output, total }` tokens. `totalActive` and `omitted` preserve overflow information beyond the bounded entry window.

The DTO intentionally never exposes run, async, or tool IDs. Clients must ignore unknown fields and fall back to status text when the capability is absent.

`data.asyncSnapshot` is a separate bounded projection included on successful status replies when available. Its `runs[].id` contains the tracked run id; unlike the fleet DTO, it is not an opaque display key. Fleet keys remain opaque and must not be interpreted as run or async identifiers.

### Scope

`pi.events` is in-process only. It does not reach separate Pi processes or child subagents; use the file lifecycle artifacts or `pi-intercom` for cross-process coordination.

## Runtime agent registration from independent extensions

An independently installed Pi extension can register an agent with the installed `pi-subagents` owner through the process-local `pi-subagents:runtime-agent-register:v1` event. Emit after extension setup, such as during `session_start`. Event delivery is synchronous, so the owner writes the result onto the request before `emit()` returns.

```typescript
const request: {
  version: 1;
  name: string;
  definition: {
    description: string;
    systemPrompt: string;
    tools?: readonly string[];
  };
  result?:
    | { ok: true; registration: { dispose(): void } }
    | { ok: false; error: Error };
} = {
  version: 1,
  name: "runtime-probe-agent",
  definition: {
    description: "Agent registered by an independent extension",
    systemPrompt: "Return the words runtime probe.",
    tools: [],
  },
};

pi.events.emit("pi-subagents:runtime-agent-register:v1", request);
if (!request.result) throw new Error("pi-subagents is not installed or not ready");
if (!request.result.ok) throw request.result.error;
const registration = request.result.registration;
// Call registration.dispose() during your extension cleanup.
```

If `pi-subagents` is a resolvable dependency of the consumer package, `pi-subagents/agents` exports `RUNTIME_AGENT_REGISTER_EVENT`, the request/result types, and `registerAgentViaEvents()` for the same contract. A separately installed Pi package is not automatically a Node dependency of another package. In that case, use the event contract directly instead of a runtime import. A type-only development dependency is optional.

The installed owner applies the existing runtime-agent validation, collision checks, limits, runtime source metadata, and cleanup. If more than one owner listens, the first handler that writes `request.result` wins. Unsupported versions, malformed requests, and registration failures return `{ ok: false, error }`. No result means no compatible owner handled the event.

This contract is process-local. It does not register agents in child sessions or other Pi processes, and it does not change package discovery or package resolution.

## Launch contract preflight

Use `pi-subagents/preflight` when an extension needs to inspect the resolved child launch contract before deciding whether to run anything:

```ts
import { resolveSubagentLaunchContract } from "pi-subagents/preflight";

const result = await resolveSubagentLaunchContract({
  agent: "readonly",
  task: "Review the current diff.",
  context: "fresh",
  cwd: ctx.cwd,
  sessionRoot: "/tmp/my-extension-preflight-session-root",
  availableModels: ctx.modelRegistry.getAvailable(),
});

if (!result.ok) {
  // missing_agent, ambiguous_agent, missing_skill, denied_required_tool,
  // invalid_artifact_dir, invalid_cwd, or unsupported_mode
  throw new Error(result.message);
}

console.log(result.contract.digest, result.contract.tools.effectiveAllowlist);
```

Preflight covers ordinary single-agent launch resolution:

- Selected agent identity and shadowed candidates.
- A parsed-definition digest, including system prompt and launch-affecting model, tool, skill, extension, output, and memory fields.
- Fresh/fork context, effective model and thinking, skill and tool resolution, direct MCP selections, runtime/configured extensions.
- Artifact/session paths, async lifecycle/status/result/event/process-terminal paths, package/lifecycle versions, capability-ceiling audit data, and stable digests.

`launchContractDigest` is the canonical digest of the caller task, effective system prompt, model candidates, effective tools/extensions/MCP (including inherited capability ceilings), output binding, and structured-output schema that foreground execution report in results/status/events and metadata.

Boundaries:

- Runtime acceptance prose and output-task annotations are intentionally excluded because side-effect-free preflight does not resolve those host/runtime augmentations; the launch and task digests make that boundary explicit.
- Raw prompts are not exposed in public contract output.
- It is side-effect-free for launch state: it does not create child sessions, temp prompt files, structured-output runtimes, tool-diagnostic files, or run artifacts.
- Some host-owned facts, such as exact fork snapshots, nested run ownership, and live model registries, can only be proven by the Pi host; those appear as `host_required` diagnostics instead of silently pretending to be exact.
- Preflight reads the extension config, so `defaultSubagentContext: "fresh"` or `"fork"` affects omitted context in the same way as execution. Explicit `context` still wins.

## Structured delegation API

Other Pi extensions can ask `pi-subagents` to run one configured foreground leaf agent through the structured delegation API. It uses the established `prompt-template:subagent:*` event family and the same executor as the `subagent` tool; it does not add another launcher.

```ts
import {
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  type SubagentDelegationRequest,
  type SubagentDelegationResponse,
} from "pi-subagents/delegation";

const request: SubagentDelegationRequest = {
  requestId: crypto.randomUUID(),
  ownerRunId: workflowRunId,
  nodeId: "review-accuracy",
  agent: "readonly",
  task: "Review the supplied evidence.",
  context: "fresh",
  cwd: ctx.cwd,
  thinking: "high",
  result: {
    kind: "structured",
    schema: {
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
      additionalProperties: false,
    },
  },
};

const unsubscribe = pi.events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload) => {
  const response = payload as SubagentDelegationResponse;
  if (response.requestId !== request.requestId) return;
  if (response.ownerRunId !== request.ownerRunId || response.nodeId !== request.nodeId) return;
  unsubscribe();
  // Inspect response.status, response.result, response.usage, model, and thinking.
});
pi.events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request);
```

Identity:

- `ownerRunId` plus `nodeId` is the active logical identity; `requestId` identifies one attempt.
- A second active attempt for the same logical node receives `duplicate_node` without disturbing the original.
- Started, update, response, and cancellation payloads carry the full tuple. Cancellation affects only an exact tuple, including cancel-before-start races.
- Each attempt emits at most one terminal response.

Results:

- Result mode is explicit. Text remains literal even when it looks like JSON. Structured mode returns the separately captured, schema-validated JSON value.
- Terminal usage reports input, output, cache-read, cache-write, cost, turns, tool calls, and duration alongside the effective model and thinking level when known.

Live update events are bounded progress snapshots, not patches, so consumers should replace the prior snapshot rather than merge it as a delta. Structured delegation coalesces heartbeats whose delegation-visible progress and recent output are unchanged; a duration-only heartbeat therefore does not produce another update. The terminal response remains authoritative for the complete result, error, and final usage details.

Bounds:

- Schemas are capped at 64 KiB; tasks and returned text/structured values are capped at 1 MiB, with smaller bounds on identity/configuration strings and a maximum `timeoutMs` of 2,147,483,647.
- Structured delegation accepts `toolBudget: { hard: 0, block: "*" }` to block the first tool call and run a zero-tool leaf; ordinary model-facing/configured budgets keep their existing minimum of one.
- The foreground bridge retains up to 8,192 exact pending-cancellation and settled-attempt identities per extension context. If either history fills, it fails closed with `unavailable_context` for later starts rather than evicting identity facts; lifecycle reset clears the bounded history.

Constraints:

- Delegation requires an active extension context. Emit requests from a supported event callback or queued application step, not by recursively invoking the `subagent` tool inside another tool's `tool_call` hook.
- The caller selects a configured agent, but agent discovery and effective tools remain package-owned. A request cannot grant arbitrary tools, and tool restrictions are not an operating-system sandbox.
- Delegation launches one native foreground leaf under the same child policy as the public tool.

Unversioned prompt-template payloads with `requestId`, `agent`, `task`, `context`, `model`, and `cwd` are rejected as legacy direct delegation. New integrations must use the structured owned-leaf request above. `pi-subagents/delegation` is the canonical contract for extension integrations.

## Capability ceilings

Parent extensions can enforce an out-of-band, session-scoped capability ceiling without adding a model-visible field to `subagent`:

```ts
import { registerSubagentCapabilityCeiling } from "pi-subagents/capability-ceiling";

const restriction = registerSubagentCapabilityCeiling({
  sessionId: ctx.sessionManager.getSessionId(),
  source: "plan-mode",
  ceiling: {
    allowedAgents: ["plan-recon", "plan-research", "plan-review"],
    allowedTools: ["read", "grep", "find", "ls"],
    denyExtensions: true,
  },
});
// restriction.update(...) replaces this provider's policy atomically.
// restriction.dispose() removes only this provider's registration.
```

Semantics:

- Active registrations intersect their `allowedTools` and `allowedAgents` sets and OR `denyExtensions`.
- An explicit empty list means no caller-facing tools or launchable agents for that field; an omitted list does not restrict names.
- `allowedAgents` entries are canonical agent names and are case-sensitive.
- Launching a non-allowlisted agent fails before spawn, and `{ action: "list" }` keeps restricted agents visible in a separate non-executable section instead of silently hiding them.
- The resolved snapshot is propagated monotonically to nested children and is retained for recovery.
- `structured_output` may remain as a package-owned internal protocol tool when an output schema requires it; it is not a caller capability.
- A denied lazy-skill `read` requirement fails before spawn rather than widening the ceiling.

`denyExtensions` suppresses ambient, configured, and MCP provider extensions while retaining the package runtime needed for child protocol enforcement. This is a same-process policy boundary, not a sandbox against malicious code already running in the parent process.

Public status exposes bounded capability audit counts and sources, never full extension paths.

## Background-work provider API

Other Pi extensions can make their current-session jobs visible to `bg_wait` through the process-local provider contract:

```ts
import { registerBackgroundWorkProvider } from "pi-subagents/background-work";

const dispose = registerBackgroundWorkProvider({
  name: "my-background-extension",
  wakeChannels: ["my-extension:job-finished"],
  listActiveWork: (context) => jobs
    .filter((job) => job.status === "running" && (!context || job.ownerSessionId === context.sessionId))
    .map((job) => ({ id: job.id, sessionId: job.ownerSessionId })),
  reconcile: ({ sessionId, nowMs }) => reconcileJobs(sessionId, nowMs),
});
```

Semantics:

- Each item needs a stable provider-local ID and the exact Pi session ID that owns it. `bg_wait` captures those identities rather than a count, so one job finishing while another starts still satisfies first-completion waits without losing the replacement.
- `listActiveWork` receives an optional `{ sessionId, nowMs }` context during snapshots. Providers can use `sessionId` to avoid scanning unrelated work; existing zero-argument `() => items` providers continue to work, and returned items are still validated and filtered to the exact requested session.
- It filters snapshots to the active session, fails closed if a provider disappears while its work is tracked, and surfaces malformed snapshots or provider errors with provider context.
- Wake channels only shorten polling; validated snapshots remain authoritative.
- Providers share a registry through `Symbol.for("pi-subagents.background-work.v1")`, allowing independently loaded extension modules to meet in one Pi process.
- Registration is reload-safe: a new provider with the same name replaces the old callback, and the old disposer cannot remove the replacement. Call the disposer during extension shutdown when possible.

Children do not gain provider tools or extensions automatically. Add `bg_wait` to the child agent's `tools` allowlist and load each provider through `extensions` or `subagentOnlyExtensions`. The parent's effective `waitTool` setting reaches every child through its typed runtime config; `PI_SUBAGENT_WAIT_TOOL_ENABLED` keeps precedence in the parent.

Foreground children use explicit extension settings. Direct MCP tools use the SDK session-local MCP provider with resolved server/tool selections. Load model or other tool providers explicitly through the agent settings. Capability ceilings remain authoritative.

## Herdr integration

When Pi runs inside [Herdr](https://herdr.dev), pi-subagents automatically reports tracked run counts through Herdr pane metadata.

- The bridge is enabled only when Herdr supplies `HERDR_ENV=1` and `HERDR_PANE_ID`; outside Herdr it registers no listeners or timers.
- It restores current-session active runs after `/reload` or `/resume`, refreshes metadata while work is active, and clears it on completion or shutdown.
- The bridge uses Herdr's existing `herdr:blocked` sibling event when a child needs attention, and emits `herdr:busy` while tracked work remains. Herdr versions that support the sibling event keep the pane's semantic state `working`; older versions ignore it safely and still display the metadata label while the Pi integration remains the lifecycle authority.
- The owning Pi session is the only publisher for its own pane metadata. When an active workflow has an explicit bounded `label`, the newest active label appears in the summary and compact `title-suffix`; overlapping completion restores the previous active label. Raw task and goal prompts never enter Herdr metadata. Without a label, one active run uses its agent name and two or more use the active-run count. Attention adds `⚠`, and the suffix is cleared when active work reaches zero.

To show the reported label in the expanded Agent sidebar, include `state_text` or `$summary` in its row layout:

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "workspace", "tab"],
  ["agent", "state_text"],
]
```

### Inspector panes

Herdr 0.7.5+ can open an on-demand inspector for an existing inspectable run:

```ts
subagent({ action: "inspector.open", id: "<run-id>", index: 0, focus: true })
subagent({ action: "inspector.status", id: "<run-id>", index: 0 })
subagent({ action: "inspector.close", id: "<run-id>", index: 0 })
```

The inspector is a raw dashboard pane, not the child session and not a literal attach. It reads lifecycle/status/output/mission artifacts and sends `steer` or `stop` through pi-subagents' existing control inbox. Closing it never stops the run.

Herdr remains optional. Ordinary launches stay headless, and missing/older Herdr versions affect only Herdr-specific inspector and project-pane actions. FleetView opens the selected inspectable child with `H`. Use `focus` only with `inspector.open`; Herdr 0.7.5 cannot focus an arbitrary existing raw pane id.

### Project panes

For substantial work in another codebase, Herdr 0.7.5+ can open a project-owned Pi pane rooted in that repository:

```ts
subagent({ action: "project.open", cwd: "/path/to/repo", message: "Own the auth refresh mission for this project." })
subagent({ action: "project.status", cwd: "/path/to/repo" })
subagent({ action: "project.close", cwd: "/path/to/repo" })
```

A project pane runs its own Pi session in the target directory, so subagents launched from that pane use that project's config, agents, skills, files, git state, and missions. The parent session keeps coordination authority, but it does not own or control the subagents inside the peer pane. Existing headless runs are not moved into the pane. Pane bindings live under `<projectRoot>/.pi/subagents/project-panes/herdr.json` and are only a local pointer to the Herdr pane.

Other Pi extensions should use the versioned public TypeScript surface instead of invoking the model-facing tool or importing inspector internals:

```ts
import {
  PROJECT_PANES_API_VERSION,
  openProjectPane,
  getProjectPaneStatus,
  focusProjectPane,
  closeProjectPane,
} from "pi-subagents/project-panes";

const opened = await openProjectPane({ cwd: "/path/to/repo", focus: false });
const status = await getProjectPaneStatus({ cwd: "/path/to/repo" });
const focused = await focusProjectPane({ cwd: "/path/to/repo" });
const closed = await closeProjectPane({ cwd: "/path/to/repo", requireIdle: true });
```

The API returns discriminated structured results with canonical project root, binding path, pane identity, bounded Herdr runtime fields, stable error codes, and `PROJECT_PANES_API_VERSION: 1`.

- Close fails closed unless the saved pane id is still verified for that project and Herdr explicitly reports `agent_status: "idle"`. `requireIdle` is retained for callers that already pass it, but it cannot weaken that rule.
- Focus uses the saved pane id, asks Herdr for its `tab_id` or `workspace_id`, and then calls the matching Herdr focus command.
- The API reports `trust: "human-verification-required"`. It never bypasses or claims to attest Pi's project-trust prompt.

## Host session lifetime and completion wakes

A host must keep the current parent session alive while a foreground workflow retains its VM, children, or completion delivery. Native completion notifications use `registerSubagentNotify` and `sendCompletion` to deliver through `pi.sendMessage(..., { triggerTurn })`. Non-blocking `bg_wait` subscriptions have a separate wake path.

A supervisor handoff is live work even while the parent is answering the question. The original JavaScript VM retains its sequential dependencies, child ownership, and deadline. Session changes and extension shutdown abort that continuation. A persisted receipt cannot replay it.

In a compatible pi-web host, `Symbol.for("@agegr/pi-web/session-liveness/v1")` receives a provider for current-session live work. It accounts for active nested descendants, foreground controls with an owner or active child, retained workflows, and pending completion delivery. Terminal history and wait subscriptions alone do not keep a session alive. Registration is replaced on session changes and released during shutdown or reload.

Use current run state and owned controls when deciding whether to reclaim a session. A quiet child or a workflow between dependent stages can still be live. File age or the absence of recent model output does not establish that the work has finished.

## Runtime files

The main runtime files in this repository:

| File | Purpose |
|------|---------|
| `src/extension/index.ts` | Extension registration, tool registration, message/render wiring. |
| `src/integrations/pi-web-session-liveness.ts` | Optional pi-web idle-eviction liveness bridge. |
| `src/agents/agents.ts` | Agent and chain discovery, frontmatter parsing. |
| `src/runs/foreground/subagent-executor.ts` | Main execution routing for single, parallel, chain, management, status, interrupt, and doctor actions. |
| `src/runs/foreground/execution.ts` | Core foreground `runSync` handling: drives one in-process child session per attempt. |
| `src/runs/shared/child-session.ts` | In-process child session factory (`createAgentSession` behind an injectable seam) and the shared model runtime; used by foreground children. |
| `src/runs/shared/child-launch.ts` | Builds the tool plan, typed child runtime config, and session launch for a native foreground child. |
| `src/runs/shared/child-tool-plan.ts` | Tool, MCP, and extension resolution for a child launch. |
| `src/runs/shared/child-runtime-config.ts` | `ChildRuntimeConfig`: everything the child-side hooks need. |
| `src/runs/shared/child-hooks.ts` | The inline hook extensions every child gets (prompt runtime, fast mode, fanout). |
| `src/runs/background/async-status.ts` | Status discovery and formatting for retained run records. |
| `src/workflows/scripted-workflow.ts` / `src/runs/foreground/subagent-executor.ts` | Scripted workflow orchestration and child launch routing. |
| `src/shared/settings.ts` | Chain behavior, instructions, and config helpers. |
| `src/runs/shared/worktree.ts` | Git worktree isolation. |
| `src/intercom/intercom-bridge.ts` | Runtime intercom bridge instructions and diagnostics. |
| `src/extension/schemas.ts` / `src/shared/types.ts` | Tool schemas, shared types, and event constants. |
| `test/unit/` / `test/integration/` | Unit and loader-based integration tests. |
