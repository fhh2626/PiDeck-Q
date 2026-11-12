import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { todoTaskCopy } from "./copy.ts";
import { PI_DECK_PLAN_MODE_MARKER, TODO_TASK_PAUSE_EVENT, TODO_TASK_PLAN_RELEASE_EVENT, TODO_TASK_PLAN_STATE_EVENT } from "./coordination.ts";
import {
	createTodoTask, decideGoalBoundary, recentTodoTask, recordTodoMutation, resumePausedGoal, suspendForPlan,
	TASK_CONTEXT, TASK_CONTINUE, TASK_RESUME, TASK_START, todoContinuation, todoTaskInstructions,
	type Todo, type TodoAction, type TodoDoneItem, type TodoTask, type TodoTaskMode,
} from "./task.ts";

interface TodoTaskHost {
	ownsTodo(): boolean;
	getTodos(): readonly Todo[];
	resetTodos(ctx: ExtensionContext): void;
}

/** Custom task messages carry their owning task id; anything else must not inherit the mode. */
function hasTaskId(message: { details?: unknown }, taskId: string): boolean {
	const details = message.details;
	return typeof details === "object" && details !== null && Reflect.get(details, "taskId") === taskId;
}

/**
 * Own one ephemeral task per extension instance. Pi owns all model scheduling;
 * returning boundary drafts avoids timers, queued RPC prompts and abort races.
 */
export function registerTodoTasks(pi: ExtensionAPI, host: TodoTaskHost) {
	const copy = todoTaskCopy();
	const instanceId = Math.random().toString(36).slice(2);
	let generation = 0;
	let starting = false;
	let task: TodoTask | undefined;
	let sessionId: string | undefined;
	let unsubscribePause: (() => void) | undefined;
	let unsubscribePlanRelease: (() => void) | undefined;
	let unsubscribePlanState: (() => void) | undefined;
	/** Last plan ownership published by the plan extension; commands consult it before starting. */
	let planState: { sessionId: string; active: boolean } | undefined;
	let turnRevision = 0;
	let lastTurnEntry: string | undefined;
	let lastBoundaryRevision = -1;
	let resumeSeq = 0;

	/** Invalidate pending clarification and all late callbacks at lifecycle boundaries. */
	function reset(): void {
		generation += 1;
		starting = false;
		task = undefined;
		sessionId = undefined;
		lastBoundaryRevision = -1;
	}

	/** Attach once per runtime; old Pi versions may not expose an event bus. */
	function subscribePause(): void {
		unsubscribePause ??= pi.events?.on(TODO_TASK_PAUSE_EVENT, (pausedSessionId) => {
			const current = activeTask();
			if (!current || current.mode !== "todo-goal" || pausedSessionId !== sessionId) return;
			// Plan mode owns the turn. suspendForPlan keeps the reported blocker (if any) and the
			// error-fuse/unsupported state, so the goal stays resumable by exactly the rule it had.
			task = suspendForPlan(current);
		});
		unsubscribePlanRelease ??= pi.events?.on(TODO_TASK_PLAN_RELEASE_EVENT, (release) => {
			const current = activeTask();
			const approved = typeof release === "object" && release !== null && Reflect.get(release, "approved") === true;
			const releasedSessionId: unknown = typeof release === "string" ? release
				: typeof release === "object" && release !== null ? Reflect.get(release, "sessionId") : undefined;
			if (!current || releasedSessionId !== sessionId || !current.planPaused) return;
			// Approval authorizes the queued execution turn; merely closing/leaving keeps it paused.
			task = approved && current.resumeOnUserInput ? resumePausedGoal(current) : { ...current, planPaused: false };
		});
		unsubscribePlanState ??= pi.events?.on(TODO_TASK_PLAN_STATE_EVENT, (state) => {
			if (typeof state !== "object" || state === null) return;
			const stateSessionId: unknown = Reflect.get(state, "sessionId");
			const active: unknown = Reflect.get(state, "active");
			if (typeof stateSessionId !== "string" || typeof active !== "boolean") return;
			planState = { sessionId: stateSessionId, active };
		});
	}
	subscribePause();
	pi.on("session_start", () => {
		subscribePause();
		// A new session never restores plan mode; drop stale ownership from the previous one.
		planState = undefined;
	});
	/** Recheck tool ownership at every control boundary, including late overrides. */
	function activeTask(): TodoTask | undefined {
		if (!host.ownsTodo()) reset();
		return task;
	}

	/** Plan mode owns the turn, so nothing may start or resume a goal run inside it. */
	function planOwnsTurn(ctx: ExtensionContext): boolean {
		return planState?.active === true && planState.sessionId === ctx.sessionManager.getSessionId();
	}

	/** Ordinary todo may explore read-only, but must not overwrite a plan-owned goal. */
	function canStartWithPlan(mode: TodoTaskMode, ctx: ExtensionContext): boolean {
		if (!planOwnsTurn(ctx)) return true;
		if (mode === "todo-goal") {
			ctx.ui.notify(copy.planActiveGoalRejected, "warning");
			return false;
		}
		if (activeTask()?.mode === "todo-goal") {
			ctx.ui.notify(copy.planActiveTaskRejected, "warning");
			return false;
		}
		return true;
	}

	/** Commands may bypass input hooks, so initialize the checklist explicitly here. */
	async function start(mode: TodoTaskMode, args: string, ctx: ExtensionContext): Promise<void> {
		if (!host.ownsTodo()) {
			reset();
			ctx.ui.notify(copy.unavailable, "warning");
			return;
		}
		if (starting || !ctx.isIdle()) {
			ctx.ui.notify(copy.busy, "warning");
			return;
		}
		if (!canStartWithPlan(mode, ctx)) return;
		const ticket = ++generation;
		starting = true;
		try {
			let goal = args.trim() || recentTodoTask(ctx.sessionManager.getBranch());
			if (!goal) goal = (await ctx.ui.input(copy.clarify))?.trim() ?? "";
			// A session switch or a new instruction while clarification was open wins.
			if (!goal || ticket !== generation || !ctx.isIdle()) return;
			if (!host.ownsTodo()) {
				reset();
				ctx.ui.notify(copy.unavailable, "warning");
				return;
			}
			// Clarification can await user input while plan ownership changes.
			if (!canStartWithPlan(mode, ctx)) return;
			host.resetTodos(ctx);
			task = createTodoTask(`${instanceId}:${ticket}`, mode, goal);
			lastBoundaryRevision = -1;
			if (mode === "todo-goal") ctx.ui.notify(copy.goalNotice, "info");
			// A custom trigger marks Pi active synchronously, before any async start
			// work. sendUserMessage has an uncancellable input/auth preflight gap.
			// The neutral goal remains persisted and visible through desktop projection.
			sessionId = ctx.sessionManager.getSessionId();
			// pi.sendMessage returns void: Pi reports async send failures as extension
			// errors, so only a synchronous throw is catchable here. A failed async send
			// leaves no run behind, and the next user run resets this task normally.
			pi.sendMessage({
				customType: TASK_START, content: goal, display: true,
				details: { taskId: task.id, messageId: `${task.id}:start` },
			}, { triggerTurn: true });
		} catch {
			if (ticket === generation) {
				reset();
				ctx.ui.notify(copy.startFailed, "error");
			}
		} finally {
			if (ticket === generation) starting = false;
		}
	}

	// Register at load time so prompt transformers and tool allowlists see both tools.
	pi.registerTool({
		name: "todo_goal_context",
		label: "Todo goal context",
		description: "Read the current todo-goal's original goal and checklist when you need to refresh them.",
		promptSnippet: "Retrieve the current todo goal and checklist when needed.",
		parameters: Type.Object({}),
		async execute() {
			const current = activeTask();
			if (!current || current.mode !== "todo-goal") throw new Error("No active todo-goal in this session.");
			const items = host.getTodos();
			const completed = current.clearedCompleted.length > 0
				? `Completed before the checklist was cleared (do not repeat):\n${current.clearedCompleted.map((item) => `#${item.id} ${item.text}`).join("\n")}`
				: undefined;
			return { content: [{ type: "text" as const, text: [
				`Original goal:\n${current.goal}`,
				items.length ? `Checklist:\n${items.map((item) => `${item.done ? "[x]" : "[ ]"} #${item.id} ${item.text}`).join("\n")}`
					: current.created ? "Checklist was cleared; rebuild only the remaining work from the original goal. An empty checklist is not complete."
						: "Checklist is empty; create it before working. It is not complete.",
				...(completed ? [completed] : []),
				current.blocked
					? `Goal is blocked: ${current.blocked.reason}${current.blocked.needs ? ` (needs: ${current.blocked.needs})` : ""}`
					: current.planPaused ? "Goal is suspended while plan mode owns the turn."
						: current.paused ? "Goal is paused." : "Goal is active.",
			].join("\n\n") }], details: {} };
		},
	});
	pi.registerTool({
		name: "todo_goal_blocked",
		label: "Report blocked todo goal",
		description: "Pause the current todo-goal only when you cannot safely continue without user input. Unfinished or difficult work and progress updates are not blockers.",
		promptSnippet: "Pause a todo goal only when continuing safely requires user input.",
		promptGuidelines: ["Call todo_goal_blocked only when user input is necessary; unfinished or difficult work is not a blocker."],
		executionMode: "sequential",
		parameters: Type.Object({
			reason: Type.String({ description: "Why the goal cannot continue" }),
			needs: Type.Optional(Type.String({ description: "What the user needs to provide or decide" })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const current = activeTask();
			if (!current || current.mode !== "todo-goal" || current.paused) throw new Error("No active todo-goal in this session.");
			const reason = typeof params.reason === "string" ? params.reason.trim() : "";
			const needs = typeof params.needs === "string" ? params.needs.trim() : "";
			if (!reason || reason.length > 2000 || needs.length > 2000) throw new Error("Provide a non-empty blocker reason and keep each field within 2000 characters.");
			task = { ...current, paused: true, blocked: { reason, needs }, resumeOnUserInput: true };
			ctx.ui.notify(`${copy.blocked} ${reason}${needs ? `\n${needs}` : ""}`, "warning");
			return { content: [{ type: "text" as const, text: "The goal is paused. Explain the blocker and what the user needs to provide. The user can resume with /todo-resume and optional guidance." }], details: {} };
		},
	});

	pi.registerCommand("todo-resume", {
		description: copy.resumeDescription,
		handler: async (args, ctx) => {
			const current = activeTask();
			// Any paused goal can be resumed explicitly: a reported blocker, the error fuse,
			// or an unsupported boundary. Plan mode keeps ownership until it releases.
			if (!current?.paused || current.mode !== "todo-goal") {
				ctx.ui.notify(copy.resumeUnavailable, "warning");
				return;
			}
			if (current.planPaused || planOwnsTurn(ctx)) {
				ctx.ui.notify(copy.planPaused, "warning");
				return;
			}
			if (!ctx.isIdle()) { ctx.ui.notify(copy.busy, "warning"); return; }
			// Keep the blocker until before_agent_start confirms this run actually started.
			// pi.sendMessage is fire-and-forget, so an async send failure must leave the goal
			// blocked (retryable) instead of silently unblocking a run that never began.
			try {
				pi.sendMessage({
					customType: TASK_RESUME, content: args.trim() || copy.resumePrompt, display: true,
					details: { taskId: current.id, messageId: `${current.id}:resume:${++resumeSeq}` },
				}, { triggerTurn: true });
			} catch {
				ctx.ui.notify(copy.startFailed, "error");
			}
		},
	});

	pi.registerCommand("todo", {
		description: copy.todoDescription,
		handler: (args, ctx) => start("todo", args, ctx),
	});
	pi.registerCommand("todo-goal", {
		description: copy.goalDescription,
		handler: (args, ctx) => start("todo-goal", args, ctx),
	});

	pi.on("before_agent_start", (event, ctx) => {
		const current = activeTask();
		if (!current) return;
		// Plan mode owns the turn: suspend the goal instead of injecting its rules into a
		// read-only plan turn. Ownership is checked from the published state as well, so a late
		// pause event cannot let goal rules leak into the plan turn in reverse load order.
		if (current.mode === "todo-goal" && (current.planPaused || planOwnsTurn(ctx))) {
			if (!current.planPaused) task = suspendForPlan(current);
			return;
		}
		const matches = (customType: string) => event.messageType === "custom"
			&& event.message.customType === customType && hasTaskId(event.message, current.id);
		// A natural reply to a paused-but-resumable goal is user guidance, not a new task:
		// keep the goal and checklist. Error-fused goals still need an explicit resume.
		const userResume = event.messageType === "user" && current.resumeOnUserInput;
		if (userResume || matches(TASK_RESUME)) {
			task = resumePausedGoal(current);
			lastBoundaryRevision = -1;
		} else if (event.messageType && !matches(TASK_START)) {
			// Native retries/continuations stay inside the original run. A different run
			// (including one started by another command) must not inherit this task mode.
			// A paused goal kept its checklist through the input phase, so clear it here.
			if (host.getTodos().length > 0) host.resetTodos(ctx);
			reset();
			return;
		}
		const active = task ?? current;
		return { message: {
			customType: TASK_CONTEXT, content: todoTaskInstructions(active, host.getTodos()), display: false,
			details: { taskId: active.id },
		} };
	});

	pi.on("context", (event) => {
		const current = activeTask();
		return { messages: event.messages.filter((message) => {
			if (message.role !== "custom" || ![TASK_CONTEXT, TASK_CONTINUE].includes(message.customType)) return true;
			// A paused goal must not leak execution rules into a plan or blocker-reporting turn.
			if (current?.paused) return false;
			return current !== undefined && typeof message.details === "object" && message.details !== null
				&& Reflect.get(message.details, "taskId") === current.id;
		}) };
	});

	pi.on("tool_call", (event) => {
		const current = activeTask();
		// Plan mode owns inspection/clarification, but must not mutate the suspended checklist.
		if (current?.planPaused) {
			if ((event.toolName === "todo" && event.input.action !== "list") || event.toolName === "todo_goal_blocked") {
				return { block: true, reason: "The goal checklist is suspended during plan mode; inspect it without changing it." };
			}
			return;
		}
		// After reporting a blocker, allow only context inspection until the user resumes.
		if (current?.blocked && event.toolName !== "todo_goal_context") {
			return { block: true, reason: "The todo goal is paused; report the blocker and wait for the user to resume it." };
		}
		if (event.toolName === "ask_question" && current?.locked) {
			return { block: true, reason: copy.questionBlocked };
		}
	});

	pi.on("turn_end", (event) => {
		if (event.messageEntryId && event.messageEntryId === lastTurnEntry) return;
		lastTurnEntry = event.messageEntryId;
		turnRevision += 1;
	});

	pi.on("agent_end", (event) => {
		// Never continue here: Pi may still retry, compact or drain queued work.
		const last = [...event.messages].reverse().find((message) => message.role === "assistant");
		if (last?.stopReason === "aborted") reset();
	});

	pi.on("agent_before_settle", (event, ctx) => {
		const current = activeTask();
		if (!current) return;
		if (event.outcome === "aborted" || ctx.signal?.aborted) {
			reset();
			return;
		}
		if (current.mode === "todo") {
			task = undefined;
			return;
		}
		if (current.paused || lastBoundaryRevision === turnRevision) return;
		// Incomplete legacy boundary payloads are not evidence that resuming is safe.
		if ((event.outcome !== "completed" && event.outcome !== "error")
			|| !Array.isArray(event.context?.pendingMessages) || typeof ctx.hasPendingMessages !== "function") {
			task = { ...current, paused: true };
			ctx.ui.notify(copy.unsupported, "warning");
			return;
		}
		// Pending work takes priority and must not count as a failed round.
		if (event.continue || ctx.hasPendingMessages() || event.context.pendingMessages.length) return;
		lastBoundaryRevision = turnRevision;
		const decision = decideGoalBoundary(current, host.getTodos(), event.outcome);
		task = decision.task;
		if (decision.action === "complete") {
			task = undefined;
			return;
		}
		if (decision.action === "pause") {
			ctx.ui.notify(copy.paused, "warning");
			return;
		}
		return {
			entries: [...(Array.isArray(event.entries) ? event.entries : []), {
				type: "custom_message" as const, customType: TASK_CONTINUE,
				content: todoContinuation(current, host.getTodos()), display: false, details: { taskId: current.id },
			}],
			continue: true,
		};
	});

	pi.on("agent_settled", (event) => {
		if (event.aborted || task?.mode === "todo") reset();
	});
	pi.on("session_before_switch", reset);
	pi.on("session_before_tree", reset);
	pi.on("session_before_fork", reset);
	pi.on("session_shutdown", () => {
		reset();
		unsubscribePause?.();
		unsubscribePause = undefined;
		unsubscribePlanRelease?.();
		unsubscribePlanRelease = undefined;
		unsubscribePlanState?.();
		unsubscribePlanState = undefined;
		planState = undefined;
	});

	return {
		reset,
		/**
		 * Any paused goal keeps its checklist through the input phase regardless of handler order;
		 * before_agent_start then decides between resume and a new task. A composer plan marker is
		 * also retained because the plan handler may pause the goal after this handler runs.
		 */
		keepsChecklistForUserInput(text = ""): boolean {
			const current = activeTask();
			return Boolean(current && (current.paused || text.startsWith(PI_DECK_PLAN_MODE_MARKER)));
		},
		/** IDs stay monotonic within a goal even after an authorized checklist clear. */
		nextIdAfterClear(nextId: number): number {
			return activeTask()?.mode === "todo-goal" ? nextId : 1;
		},
		/** Tool execution, not a speculative tool_call, commits successful mutations. */
		onMutation(action: TodoAction, completed: readonly TodoDoneItem[] = []): void {
			const current = activeTask();
			if (current) task = recordTodoMutation(current, action, completed);
		},
	};
}
