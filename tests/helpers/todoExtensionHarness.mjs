import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

/** Exercise the real extension through commands, tools and lifecycle events. */
export function createTodoHarness({ branch = [], ownsTodo = true, locale = "en-US" } = {}) {
	const tools = new Map();
	const listeners = new Map();
	const commands = new Map();
	const handlers = new Map();
	const snapshots = [];
	const messages = [];
	const notifications = [];
	const widgets = [];
	let revision = 0;
	const state = { idle: true, pending: false, ownsTodo, answer: undefined };
	const ctx = {
		sessionManager: { getBranch: () => branch, getSessionId: () => "test-session" },
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending,
		ui: {
			setWidget: (_key, lines) => widgets.push(lines),
			notify: (text, type) => notifications.push({ text, type }),
			input: async () => state.answer,
		},
	};
	const module = loadTsCommonJs("resources/extensions/pi-deck-todo.ts", {
		globals: { process: { env: { PIDECK_UI_LANGUAGE: locale } } },
		stubs: {
			"@earendil-works/pi-ai": { StringEnum: (values) => ({ enum: values }) },
			typebox: { Type: {
				Object: (shape) => shape, Optional: (value) => value,
				String: () => ({}), Number: () => ({}),
			} },
		},
	});
	module.default({
		registerTool: (definition) => tools.set(definition.name, definition),
		registerCommand: (name, definition) => commands.set(name, definition),
		on(name, handler) {
			if (!handlers.has(name)) handlers.set(name, []);
			handlers.get(name).push(handler);
		},
		getAllTools: () => [{ name: "todo", sourceInfo: {
			path: state.ownsTodo ? "resources/extensions/pi-deck-todo.ts" : "third-party/todo.ts",
		} }],
		appendEntry: (type, data) => snapshots.push({ type, data }),
		sendMessage: (message, options) => messages.push({ message, options }),
		events: {
			on(channel, handler) {
				const group = listeners.get(channel) ?? new Set();
				group.add(handler);
				listeners.set(channel, group);
				return () => group.delete(handler);
			},
			emit(channel, data) { for (const handler of listeners.get(channel) ?? []) handler(data); },
		},
	});
	async function emit(name, event = {}) {
		let result;
		for (const handler of handlers.get(name) ?? []) {
			result = (await handler({ type: name, ...event }, ctx)) ?? result;
		}
		return result;
	}
	return {
		commands, state, ctx, snapshots, messages, notifications, widgets, emit,
		pause: (sessionId = "test-session") => { for (const handler of listeners.get("pi-deck-todo:pause") ?? []) handler(sessionId); },
		command: (name, args = "") => commands.get(name).handler(args, ctx),
		run: (params) => tools.get("todo").execute("todo-call", params, undefined, undefined, ctx),
		ask: () => emit("tool_call", { toolName: "ask_question", input: {} }),
		async boundary(outcome = "completed", extra = {}) {
			await emit("turn_end", { messageEntryId: `message-${++revision}`, message: { role: "assistant" } });
			return emit("agent_before_settle", {
				outcome, continue: false, entries: [], context: { pendingMessages: [] }, ...extra,
			});
		},
	};
}
