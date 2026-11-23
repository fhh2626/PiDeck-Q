import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const PAUSE_EVENT = "pi-deck-todo:pause";
const RELEASE_EVENT = "pi-deck-todo:plan-release";
const STATE_EVENT = "pi-deck-todo:plan-state";

/**
 * Load the real plan-mode extension with a recording event bus. Plan mode must tell the
 * todo task owner when it takes or hands back the turn, otherwise a paused goal is either
 * resumed inside a read-only plan turn or left suspended forever.
 */
function loadPlanMode({ select } = {}) {
	const commands = new Map();
	const handlers = new Map();
	const emits = [];
	const extension = loadTsCommonJs("resources/extensions/pi-deck-plan-mode.ts");
	extension.default({
		registerCommand: (name, definition) => commands.set(name, definition),
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		getActiveTools: () => ["read", "edit", "bash"],
		setActiveTools: () => {},
		appendEntry: () => {},
		sendMessage: () => {},
		events: { emit: (channel, data) => emits.push({ channel, data }) },
	});
	const ctx = {
		sessionManager: { getEntries: () => [], getSessionId: () => "session-1" },
		hasUI: true,
		ui: {
			setWidget: () => {},
			notify: () => {},
			select: select ?? (async (_title, options) => options[0]),
			editor: async () => undefined,
		},
	};
	const emit = async (name, event = {}) => {
		let result;
		for (const handler of handlers.get(name) ?? []) result = (await handler({ type: name, ...event }, ctx)) ?? result;
		return result;
	};
	return {
		commands, emits, ctx, emit,
		channels: () => emits.map((entry) => entry.channel),
		/** Ownership events are additive coordination; assert them separately from pause/release. */
		only: (channel) => emits.filter((entry) => entry.channel === channel),
		states: () => emits.filter((entry) => entry.channel === STATE_EVENT).map((entry) => entry.data.active),
	};
}

test("plan ownership is published so /todo-goal cannot start inside read-only mode", async () => {
	const { commands, emits, ctx } = loadPlanMode();
	await commands.get("plan").handler("on", ctx);
	assert.ok(emits.some((entry) => entry.channel === STATE_EVENT && entry.data.active === true),
		"entering plan mode must publish ownership");
	emits.length = 0;
	await commands.get("plan").handler("off", ctx);
	assert.ok(emits.some((entry) => entry.channel === STATE_EVENT && entry.data.active === false),
		"leaving plan mode must publish the release");
});

test("the composer marker and plan approval publish ownership transitions", async () => {
	const { emits, ctx, emit } = loadPlanMode({ select: async () => "开始执行|恢复写权限" });
	await emit("input", { text: "__PI_DECK_PLAN_MODE__Plan the change", source: "interactive" });
	assert.ok(emits.some((entry) => entry.channel === STATE_EVENT && entry.data.active === true));
	emits.length = 0;
	await emit("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "Plan:\n1. Inspect" }] }] });
	assert.ok(emits.some((entry) => entry.channel === STATE_EVENT && entry.data.active === false),
		"approval leaves plan mode and must publish that");
});

test("a new session publishes that plan mode is not restored", async () => {
	const { emits, ctx, emit } = loadPlanMode();
	await emit("session_start", {}, ctx);
	assert.ok(emits.some((entry) => entry.channel === STATE_EVENT && entry.data.active === false));
});

test("/plan on pauses the todo goal so it cannot resume inside read-only plan mode", async () => {
	const { commands, only, states, ctx } = loadPlanMode();
	await commands.get("plan").handler("on", ctx);
	assert.deepEqual(only(PAUSE_EVENT), [{ channel: PAUSE_EVENT, data: "session-1" }]);
	assert.deepEqual(states(), [true]);
});

test("/plan off releases the plan-owned pause without starting a turn", async () => {
	const { commands, only, states, ctx } = loadPlanMode();
	await commands.get("plan").handler("off", ctx);
	assert.deepEqual(only(RELEASE_EVENT), [{ channel: RELEASE_EVENT, data: "session-1" }]);
	assert.deepEqual(states(), [false]);
});

test("the composer plan-mode marker pauses the todo goal before the plan turn", async () => {
	const { only, states, emit } = loadPlanMode();
	const transformed = await emit("input", { text: "__PI_DECK_PLAN_MODE__Plan the change", source: "interactive" });
	assert.equal(transformed.text, "Plan the change");
	assert.deepEqual(only(PAUSE_EVENT), [{ channel: PAUSE_EVENT, data: "session-1" }]);
	assert.deepEqual(states(), [true]);
});

test("an ordinary message that leaves plan mode releases the plan-owned pause", async () => {
	const { only, states, emit } = loadPlanMode();
	await emit("input", { text: "__PI_DECK_PLAN_MODE__Plan the change", source: "interactive" });
	await emit("input", { text: "Now implement it", source: "interactive" });
	assert.deepEqual(only(RELEASE_EVENT), [{ channel: RELEASE_EVENT, data: "session-1" }]);
	assert.deepEqual(states(), [true, false]);
});

test("approving the plan releases the pause instead of suspending the goal forever", async () => {
	const { commands, only, states, ctx, emit } = loadPlanMode({ select: async () => "开始执行|恢复写权限，按步骤改代码并勾进度" });
	await commands.get("plan").handler("on", ctx);
	await emit("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "Plan:\n1. Inspect the parser" }] }] });
	const releases = only(RELEASE_EVENT);
	assert.equal(releases.length, 1, "approval must send exactly one authorization event");
	assert.equal(releases[0].data.sessionId, "session-1");
	assert.equal(releases[0].data.approved, true, "approval authorizes the queued execution turn");
	assert.deepEqual(states(), [true, false], "approval leaves plan mode and publishes that");
});
