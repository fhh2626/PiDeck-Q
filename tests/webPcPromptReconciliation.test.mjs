import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentMessageProjector } = loadTsCommonJs("src/main/pi/AgentMessageProjector.ts");
const { chatMessagesToUiMessages, mergeAuthoritativeUiMessages, prependOlderHistoryPage } = loadTsCommonJs("src/renderer/src/web/webApi.ts");
const projector = new AgentMessageProjector({ translate: (key) => key, isAskAborted: () => false });

/** Two projections of one Pi turn; only the tool identity is shared initially. */
function turn({ key = "one", text = "继续", time = 1000, liveEntry, historyEntry = `user-${key}` } = {}) {
	const runtime = chatMessagesToUiMessages([
		{ id: `pc-user-${key}`, agentId: "runtime", role: "user", text, timestamp: time,
			...(liveEntry ? { meta: { entryId: liveEntry } } : {}) },
		{ id: `pc-answer-${key}`, agentId: "runtime", role: "assistant", text: `Intermediate ${key}`, timestamp: time + 100 },
		{ id: `pc-tool-${key}`, agentId: "runtime", role: "tool", text: "read", timestamp: time + 200,
			meta: { toolName: "read", toolCallId: `call-${key}`, status: "running", args: { path: "file.txt" } } },
	]);
	const history = chatMessagesToUiMessages(projector.convert("session", [
		{ role: "user", content: [{ type: "text", text }], timestamp: time + 5 },
		{ role: "assistant", content: [{ type: "text", text: `Intermediate ${key}` }], timestamp: time + 105 },
		{ role: "toolResult", toolName: "read", toolCallId: `call-${key}`, content: [{ type: "text", text: "done" }], timestamp: time + 205 },
	], [historyEntry, `answer-${key}`, `tool-${key}`]));
	return { runtime, history };
}
const userRows = (messages) => messages.filter((m) => m.role === "user");
const ids = (messages) => Array.from(messages, (m) => m.id);

for (const reverse of [false, true]) {
	test(`PC/history turn with different timestamps reconciles using its tool identity (${reverse ? "history first" : "runtime first"})`, () => {
		const { runtime, history } = turn();
		const merged = mergeAuthoritativeUiMessages(reverse ? history : runtime, reverse ? runtime : history, { dropCoveredLocalSseLeftovers: true });
		assert.equal(userRows(merged).length, 1);
		assert.equal(merged.filter((m) => m.parts.some((p) => p.type === "text" && p.text === "Intermediate one")).length, 1);
		assert.equal(merged.filter((m) => m.parts.some((p) => p.toolCallId === "call-one")).length, 1);
		assert.equal(merged[0].role, "user");
		assert.equal(userRows(merged)[0].metadata.entryId, "user-one");
	});
}

test("overlapping older page does not split one PC turn into two user turns", () => {
	const { runtime, history } = turn();
	const merged = prependOlderHistoryPage(history, runtime);
	assert.equal(userRows(merged).length, 1);
	assert.equal(merged.length, 3);
	assert.equal(merged[0].metadata.entryId, "user-one");
});

test("history pairing survives repeated live snapshots and repeated history pages", () => {
	const { runtime, history } = turn();
	let merged = mergeAuthoritativeUiMessages(history, runtime);
	for (let i = 0; i < 4; i++) {
		merged = mergeAuthoritativeUiMessages(merged, runtime, { dropUnmatchedTrailingPlaceholders: true });
		merged = mergeAuthoritativeUiMessages(merged, history, { dropCoveredLocalSseLeftovers: true });
		merged = prependOlderHistoryPage(history, merged);
		assert.equal(userRows(merged).length, 1);
		assert.equal(merged.length, 3);
	}
});

test("later tool evidence heals an early user-only history/runtime duplication", () => {
	const { runtime, history } = turn();
	let cache = mergeAuthoritativeUiMessages(runtime.slice(0, 1), history.slice(0, 1), { dropCoveredLocalSseLeftovers: true });
	cache = mergeAuthoritativeUiMessages(cache, history);
	cache = mergeAuthoritativeUiMessages(cache, runtime, { dropUnmatchedTrailingPlaceholders: true });
	assert.equal(userRows(cache).length, 1);
	assert.equal(userRows(cache)[0].metadata.entryId, "user-one");
});

for (const historyFirst of [false, true]) {
	for (const toolSnapshotFirst of [false, true]) {
		test(`later tool evidence heals duplicated intermediate replies (history first: ${historyFirst}, tool snapshot first: ${toolSnapshotFirst})`, () => {
			const { runtime, history } = turn();
			const early = historyFirst ? [history.slice(0, 2), runtime.slice(0, 2)] : [runtime.slice(0, 2), history.slice(0, 2)];
			let cache = mergeAuthoritativeUiMessages(...early, { dropCoveredLocalSseLeftovers: true });
			assert.equal(userRows(cache).length, 2, "without identity evidence both turns must be kept");
			const snapshots = toolSnapshotFirst ? [runtime, history] : [history, runtime];
			for (const snapshot of snapshots) cache = mergeAuthoritativeUiMessages(cache, snapshot, { dropUnmatchedTrailingPlaceholders: true });
			// Aliases must also survive old useChat arrays and overlapping disk pages.
			for (let i = 0; i < 3; i++) {
				cache = mergeAuthoritativeUiMessages(cache, [...early[0], ...early[1]], { dropUnmatchedTrailingPlaceholders: true });
				cache = prependOlderHistoryPage(history, cache);
				assert.equal(userRows(cache).length, 1);
				assert.equal(cache.filter((m) => m.parts.some((p) => p.text === "Intermediate one")).length, 1);
				assert.equal(cache.length, 3);
				assert.equal(cache[0].metadata.entryId, "user-one");
				assert.equal(cache[1].metadata.entryId, "answer-one");
			}
		});
	}
}

test("a late running snapshot cannot undo a completed tool or lose its output", () => {
	const { runtime, history } = turn();
	const merged = mergeAuthoritativeUiMessages(history, runtime);
	const tools = merged.flatMap((m) => m.parts).filter((p) => p.toolCallId === "call-one");
	assert.equal(tools.length, 1);
	assert.equal(tools[0].state, "output-available");
	const persistedTool = history.flatMap((m) => m.parts).find((p) => p.toolCallId === "call-one");
	assert.deepEqual(tools[0].output, persistedTool.output);
});

test("two real identical prompts stay distinct even five milliseconds apart", () => {
	const first = turn({ key: "first" });
	const second = turn({ key: "second", time: 1005 });
	const merged = mergeAuthoritativeUiMessages([...first.runtime, ...second.runtime], [...first.history, ...second.history]);
	assert.equal(userRows(merged).length, 2);
	assert.deepEqual(Array.from(userRows(merged), (m) => m.metadata.entryId), ["user-first", "user-second"]);
});

test("different known entry identities never merge even when a tool id is reused", () => {
	const { runtime, history } = turn({ liveEntry: "different-entry" });
	assert.equal(userRows(mergeAuthoritativeUiMessages(runtime, history)).length, 2);
});

for (const streamingBehavior of ["steer", "followUp"]) {
	test(`queued ${streamingBehavior} user cannot claim the previous turn's tools`, () => {
		const { runtime, history } = turn();
		runtime[0].metadata = { ...runtime[0].metadata, streamingBehavior };
		assert.equal(userRows(mergeAuthoritativeUiMessages(runtime, history)).length, 2);
	});
}

test("text and nearby timestamps without stable reply evidence do not merge", () => {
	const { runtime, history } = turn();
	assert.equal(userRows(mergeAuthoritativeUiMessages(runtime.slice(0, 2), history.slice(0, 2))).length, 2);
});

test("unanswered PC prompt and failed submission are preserved", () => {
	const { runtime, history } = turn();
	assert.equal(userRows(mergeAuthoritativeUiMessages(runtime.slice(0, 1), history, { dropUnmatchedTrailingPlaceholders: true })).length, 2);
});

test("a shared tool in two source turns is ambiguous and cannot claim either prompt", () => {
	const { runtime, history } = turn();
	const duplicate = runtime.map((m) => ({ ...m, id: `second-${m.id}` }));
	assert.equal(userRows(mergeAuthoritativeUiMessages([...runtime, ...duplicate], history)).length, 3);
});

test("a history page starting mid-turn cannot claim a newer same-text user", () => {
	const { runtime, history } = turn();
	assert.deepEqual(ids(userRows(mergeAuthoritativeUiMessages(runtime, history.slice(1), { dropCoveredLocalSseLeftovers: true }))), ["pc-user-one"]);
});

test("same placeholder with different attachments cannot pair even with shared reply evidence", () => {
	const { runtime, history } = turn();
	runtime[0].parts.push({ type: "file", mediaType: "image/png", url: "data:image/png;base64,AAAA" });
	history[0].parts.push({ type: "file", mediaType: "image/png", url: "data:image/png;base64,BBBB" });
	assert.equal(userRows(mergeAuthoritativeUiMessages(runtime, history)).length, 2);
});

test("a known reply id also identifies a text-only PC turn without timestamp tolerance", () => {
	const { runtime, history } = turn();
	history[1].id = runtime[1].id;
	const merged = mergeAuthoritativeUiMessages(runtime.slice(0, 2), history.slice(0, 2));
	assert.equal(userRows(merged).length, 1);
	assert.equal(userRows(merged)[0].metadata.entryId, "user-one");
});

test("late stale useChat user copies cannot resurrect a proven duplicate", () => {
	const { runtime, history } = turn();
	const paired = mergeAuthoritativeUiMessages(runtime, history);
	const stale = [runtime[0], history[0], ...runtime.slice(1)];
	const merged = mergeAuthoritativeUiMessages(paired, stale);
	assert.equal(userRows(merged).length, 1);
	assert.equal(userRows(merged)[0].metadata.entryId, "user-one");
});

test("final static SSE tool output survives removal of its covered combined bubble", () => {
	const { runtime } = turn();
	const stream = { id: "sse", role: "assistant", parts: [
		{ type: "text", text: "Intermediate one" },
		{ type: "tool-read", toolCallId: "call-one", state: "output-available", input: {}, output: "Complete output" },
	] };
	let merged = mergeAuthoritativeUiMessages(runtime, [stream]);
	merged = mergeAuthoritativeUiMessages(merged, runtime, { dropUnmatchedTrailingPlaceholders: true });
	const tools = merged.flatMap((m) => m.parts).filter((p) => p.toolCallId === "call-one");
	assert.equal(tools.length, 1);
	assert.equal(tools[0].state, "output-available");
	assert.equal(tools[0].output, "Complete output");
});

test("idle snapshots retain SSE content not covered by the preceding history page", () => {
	const { runtime, history } = turn();
	const stream = { id: "sse", role: "assistant", parts: [
		{ type: "text", text: "Intermediate one" },
		{ type: "tool-read", toolCallId: "call-one", state: "output-available", input: {}, output: "done" },
		{ type: "reasoning", text: "Unpersisted reasoning" },
		{ type: "text", text: "Not persisted yet" },
		{ type: "tool-write", toolCallId: "next-call", state: "output-available", input: {}, output: "Final tool output" },
	] };
	let merged = mergeAuthoritativeUiMessages([runtime[0], stream], history, { dropCoveredLocalSseLeftovers: true });
	for (let i = 0; i < 3; i++) {
		merged = mergeAuthoritativeUiMessages(merged, history, { dropUnmatchedTrailingPlaceholders: true });
		const kept = merged.find((m) => m.id === "sse");
		assert.ok(kept, "partial idle snapshots must not discard the final SSE frame");
		assert.deepEqual(kept.parts, stream.parts);
	}
	// Once every segment and tool is persisted, removing the combined bubble is safe.
	const complete = [...history, ...chatMessagesToUiMessages([
		{ id: "final-answer", agentId: "runtime", role: "assistant", text: "Not persisted yet", thinking: "Unpersisted reasoning", timestamp: 1300 },
		{ id: "final-tool", agentId: "runtime", role: "tool", text: "write", timestamp: 1400,
			meta: { toolName: "write", toolCallId: "next-call", status: "success", args: {}, detailText: "Final tool output" } },
	])];
	merged = mergeAuthoritativeUiMessages(merged, complete, { dropUnmatchedTrailingPlaceholders: true });
	assert.equal(merged.some((m) => m.id === "sse"), false);
	assert.equal(merged.filter((m) => m.parts.some((p) => p.text === "Not persisted yet")).length, 1);
	assert.equal(merged.flatMap((m) => m.parts).filter((p) => p.toolCallId === "next-call").length, 1);
});

test("idle snapshots cannot replace a reasoning/tool bubble with its reasoning row alone", () => {
	const { runtime, history } = turn();
	const reasoning = chatMessagesToUiMessages([
		{ id: "thinking", agentId: "runtime", role: "assistant", text: "", thinking: "Thinking", timestamp: 1250 },
	]);
	const stream = { id: "sse", role: "assistant", parts: [
		{ type: "reasoning", text: "Thinking" },
		{ type: "tool-write", toolCallId: "next-call", state: "output-available", input: {}, output: "Not persisted yet" },
	] };
	const merged = mergeAuthoritativeUiMessages([runtime[0], stream], [...history, ...reasoning], { dropUnmatchedTrailingPlaceholders: true });
	assert.equal(merged.some((m) => m.id === "sse"), true);
	assert.equal(merged.some((m) => m.parts.some((p) => p.toolCallId === "next-call")), true);
});

test("idle snapshots keep a tool-only SSE frame absent from the snapshot", () => {
	const { runtime, history } = turn();
	const stream = { id: "sse", role: "assistant", parts: [
		{ type: "tool-write", toolCallId: "next-call", state: "output-available", input: {}, output: "Unpersisted tool output" },
	] };
	const merged = mergeAuthoritativeUiMessages([runtime[0], stream], history, { dropUnmatchedTrailingPlaceholders: true });
	assert.equal(merged.some((m) => m.id === "sse"), true);
});

test("bridge healing does not collapse actual repeated replies in the incoming tool loop", () => {
	const { runtime, history } = turn();
	let cache = mergeAuthoritativeUiMessages(runtime.slice(0, 2), history.slice(0, 2));
	cache = mergeAuthoritativeUiMessages(cache, history);
	const repeated = { ...runtime[1], id: "second-real-reply", timestamp: 1250 };
	cache = mergeAuthoritativeUiMessages(cache, [...runtime, repeated]);
	assert.equal(cache.some((m) => m.id === "pc-answer-one"), true);
	assert.equal(cache.some((m) => m.id === "second-real-reply"), true);
});

test("bridge healing preserves replies with conflicting known Pi entries", () => {
	const { runtime, history } = turn();
	runtime[1].metadata = { ...runtime[1].metadata, entryId: "different-answer-entry" };
	let cache = mergeAuthoritativeUiMessages(runtime.slice(0, 2), history.slice(0, 2));
	cache = mergeAuthoritativeUiMessages(cache, history);
	cache = mergeAuthoritativeUiMessages(cache, runtime);
	assert.equal(cache.some((m) => m.metadata?.entryId === "different-answer-entry"), true);
	assert.equal(cache.some((m) => m.metadata?.entryId === "answer-one"), true);
});

test("a metadata-free Web user still requires identical attachments for tool-based pairing", () => {
	const { runtime, history } = turn();
	runtime[0] = { id: runtime[0].id, role: "user", parts: [...runtime[0].parts,
		{ type: "file", mediaType: "image/png", url: "data:image/png;base64,AAAA" }] };
	history[0].parts.push({ type: "file", mediaType: "image/png", url: "data:image/png;base64,BBBB" });
	assert.equal(userRows(mergeAuthoritativeUiMessages(runtime, history)).length, 2);
});

test("reconciliation retains unpersisted SSE tools and text suffixes", () => {
	const { runtime, history } = turn();
	const stream = { id: "sse", role: "assistant", parts: [
		{ type: "text", text: "Intermediate one" },
		{ type: "dynamic-tool", toolCallId: "call-one", toolName: "read", state: "input-available", input: {} },
		{ type: "text", text: "Not persisted yet" },
		{ type: "dynamic-tool", toolCallId: "next-call", toolName: "write", state: "input-available", input: {} },
	] };
	const merged = mergeAuthoritativeUiMessages([runtime[0], stream], history, { dropCoveredLocalSseLeftovers: true });
	assert.equal(userRows(merged).length, 1);
	assert.equal(merged.some((m) => m.id === "sse" && m.parts.some((p) => p.text === "Not persisted yet")), true);
	assert.equal(merged.some((m) => m.parts.some((p) => p.toolCallId === "next-call")), true);
});
