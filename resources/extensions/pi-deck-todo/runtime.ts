import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { todoTaskCopy } from "./copy.ts";
import { TODO_TASK_PAUSE_EVENT } from "./coordination.ts";
import {
	createTodoTask, decideGoalBoundary, recentTodoTask, recordTodoMutation,
	TASK_CONTEXT, TASK_CONTINUE, TASK_START, todoContinuation, todoTaskInstructions,
	type Todo, type TodoAction, type TodoTask, type TodoTaskMode,
} from "./task.ts";

interface TodoTaskHost {
	ownsTodo(): boolean;
	getTodos(): readonly Todo[];
	resetTodos(ctx: ExtensionContext): void;
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
	let turnRevision = 0;
	let lastTurnEntry: string | undefined;
	let lastBoundaryRevision = -1;

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
			if (current && pausedSessionId === sessionId) task = { ...current, paused: true };
		});
	}
	subscribePause();
	pi.on("session_start", subscribePause);
	/** Recheck tool ownership at every control boundary, including late overrides. */
	function activeTask(): TodoTask | undefined {
		if (!host.ownsTodo()) reset();
		return task;
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
			host.resetTodos(ctx);
			task = createTodoTask(`${instanceId}:${ticket}`, mode, goal);
			lastBoundaryRevision = -1;
			if (mode === "todo-goal") ctx.ui.notify(copy.goalNotice, "info");
			// A custom trigger marks Pi active synchronously, before any async start
			// work. sendUserMessage has an uncancellable input/auth preflight gap.
			// The neutral goal remains persisted and visible through desktop projection.
			sessionId = ctx.sessionManager.getSessionId();
			pi.sendMessage({
				customType: TASK_START, content: goal, display: true, details: { taskId: task.id },
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

	pi.registerCommand("todo", {
		description: copy.todoDescription,
		handler: (args, ctx) => start("todo", args, ctx),
	});
	pi.registerCommand("todo-goal", {
		description: copy.goalDescription,
		handler: (args, ctx) => start("todo-goal", args, ctx),
	});

	pi.on("before_agent_start", (event) => {
		const current = activeTask();
		if (!current) return;
		// Native retries/continuations stay inside the original run. A different run
		// (including one started by another command) must not inherit this task mode.
		if (event.messageType && !(event.messageType === "custom" && event.message.customType === TASK_START
			&& typeof event.message.details === "object" && event.message.details !== null
			&& Reflect.get(event.message.details, "taskId") === current.id)) {
			reset();
			return;
		}
		return { message: {
			customType: TASK_CONTEXT, content: todoTaskInstructions(current), display: false,
			details: { taskId: current.id },
		} };
	});

	pi.on("context", (event) => {
		const current = activeTask();
		return { messages: event.messages.filter((message) => {
			if (message.role !== "custom" || ![TASK_CONTEXT, TASK_CONTINUE].includes(message.customType)) return true;
			return current !== undefined && typeof message.details === "object" && message.details !== null
				&& Reflect.get(message.details, "taskId") === current.id;
		}) };
	});

	pi.on("tool_call", (event) => {
		if (event.toolName === "ask_question" && activeTask()?.locked) {
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
		// Do not compete with other extensions or count pending work as a stalled round.
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
			entries: [{
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
	});

	return {
		reset,
		/** IDs stay monotonic within a goal even after an authorized checklist clear. */
		nextIdAfterClear(nextId: number): number {
			return activeTask()?.mode === "todo-goal" ? nextId : 1;
		},
		/** Tool execution, not a speculative tool_call, commits successful mutations. */
		onMutation(action: TodoAction): void {
			const current = activeTask();
			if (current) task = recordTodoMutation(current, action);
		},
	};
}
