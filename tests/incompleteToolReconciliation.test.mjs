import assert from "node:assert/strict";
import test from "node:test";
import { readUIMessageStream } from "ai";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { mergeHistoryWithPreservedMessages, stabilizeReloadedMessageIds } = loadTsCommonJs("src/main/pi/historyMessages.ts");
const { chatMessagesToUiMessages } = loadTsCommonJs("src/renderer/src/web/webApi.ts");
const { mergeAuthoritativeUiMessages } = loadTsCommonJs("src/renderer/src/web/webMessageMerge.ts");
const { resolveWebToolPartStatus, resolveWebToolGroupStatus } = loadTsCommonJs("src/renderer/src/web/webToolGroups.ts");
const { getToolStatus } = loadTsCommonJs("src/renderer/src/components/session/TimelineFormat.ts");
const { resolveToolGroupStatus } = loadTsCommonJs("src/renderer/src/components/session/timeline/toolGroupPage.ts");
const { WebEventStreamRouter, SSE_DONE } = loadTsCommonJs("src/main/web/WebEventStream.ts");

/** A stale historical call and a real execution share the Pi toolCallId, not timestamps. */
function row(status, id = "history") {
	return { id, agentId: "agent", role: "tool", text: "subagent", timestamp: id === "history" ? 1 : 300_000,
		meta: { status, toolName: "subagent", toolCallId: "call", args: '{"task":"inspect"}',
			...(status === "unknown" ? { sourceEntryId: "assistant-entry" } : {}),
			...(status === "done" ? { result: "actual result" } : {}),
			...(status === "error" ? { isError: true, result: "actual failure" } : {}) } };
}

for (const status of ["running", "done", "error"]) {
	test(`desktop reload preserves observed ${status} instead of duplicating/downgrading a missing-result call`, () => {
		const historical = row("unknown");
		const actual = row(status, "runtime");
		const active = { activeToolCallIds: new Map([["call", "subagent"]]) };
		const merged = mergeHistoryWithPreservedMessages([historical], [actual], 50, active);
		const stable = stabilizeReloadedMessageIds([actual], merged, active);
		assert.equal(stable.length, 1);
		assert.equal(stable[0].id, "runtime");
		assert.equal(stable[0].meta.status, status);
		assert.equal(stable[0].meta.sourceEntryId, "assistant-entry");
		assert.equal(historical.meta.status, "unknown", "never mutate the historical snapshot");
		assert.equal(stabilizeReloadedMessageIds([actual], [historical], active)[0].meta.status, status,
			"ordinary reloads without a preserve timestamp still retain observed outcomes");
		const edited = { preserveObservedOutcomes: false };
		assert.equal(stabilizeReloadedMessageIds([actual], [historical], edited)[0].meta.status, "unknown",
			"explicit result deletion must retain the file's authoritative missing-result state");
		const replaced = mergeHistoryWithPreservedMessages([historical], [actual], 50, edited);
		assert.equal(stabilizeReloadedMessageIds([actual], replaced, edited)[0].meta.status, "unknown",
			"session replacement may preserve new messages without resurrecting old tool outcomes");
	});

	test(`a late Web unknown snapshot cannot replace observed ${status}`, () => {
		const current = chatMessagesToUiMessages([row(status, "runtime")]);
		const incomplete = chatMessagesToUiMessages([row("unknown")]);
		const merged = mergeAuthoritativeUiMessages(current, incomplete, { preserveRunningToolCalls: true });
		assert.equal(merged.length, 1);
		assert.equal(resolveWebToolPartStatus(merged[0].parts[0]), status);
	});
}

test("desktop reload must not resurrect a stale running card after the runtime is gone", () => {
	const actual = row("running", "runtime");
	const merged = mergeHistoryWithPreservedMessages([row("unknown")], [actual], 50);
	const stable = stabilizeReloadedMessageIds([actual], merged);
	assert.equal(stable.length, 1);
	assert.equal(stable[0].id, actual.id);
	assert.equal(stable[0].meta.status, "unknown");
});

test("idle Web snapshots settle a cached running call without inventing a result", () => {
	const current = chatMessagesToUiMessages([row("running", "runtime")]);
	const incoming = chatMessagesToUiMessages([row("unknown")]);
	const merged = mergeAuthoritativeUiMessages(current, incoming);
	assert.equal(merged.length, 1);
	assert.equal(resolveWebToolPartStatus(merged[0].parts[0]), "unknown");
});

test("real SDK reconnect clears the missing-result marker when the tool is actually active", async () => {
	let emit;
	const router = new WebEventStreamRouter(() => "session");
	router.bindPiSource((handler) => { emit = handler; return () => {}; });
	emit("agent", { type: "tool_execution_start", toolName: "subagent", toolCallId: "call", args: { task: "inspect" } }, 1);
	const frames = [];
	const close = router.add("session", (wire) => {
		if (wire !== SSE_DONE) frames.push(JSON.parse(wire.slice(6)));
		return true;
	}, () => {});
	const initial = chatMessagesToUiMessages([row("unknown")])[0];
	const errors = [];
	let final = initial;
	try {
		const stream = new ReadableStream({ start(controller) {
			for (const frame of frames) controller.enqueue(frame);
			controller.close();
		} });
		for await (const message of readUIMessageStream({ message: initial, stream, onError: (error) => errors.push(error) })) final = message;
		assert.deepEqual(errors, []);
		assert.equal(final.parts.length, 1);
		assert.equal(resolveWebToolPartStatus(final.parts[0]), "running");
	} finally { close(); router.unbindPiSource(); }
});

test("desktop and Web status aggregates keep unknown neutral without hiding real activity or errors", () => {
	assert.equal(getToolStatus(row("unknown")), "unknown");
	assert.equal(getToolStatus({ ...row("done"), meta: {} }), "done", "legacy records retain the existing fallback");
	assert.equal(resolveToolGroupStatus(["done", "unknown"]), "unknown");
	assert.equal(resolveToolGroupStatus(["unknown", "error"]), "error");
	assert.equal(resolveToolGroupStatus(["unknown", "running"]), "running");
	assert.equal(resolveToolGroupStatus(["unknown", "running"], true), "stopped");
	const part = (state, missing = false) => ({ type: "dynamic-tool", toolName: "subagent", toolCallId: "call", state, toolMetadata: { resultMissing: missing } });
	assert.equal(resolveWebToolGroupStatus([part("output-available"), part("input-available", true)]), "unknown");
	assert.equal(resolveWebToolGroupStatus([part("output-error"), part("input-available", true)]), "error");
	assert.equal(resolveWebToolGroupStatus([part("input-available"), part("input-available", true)]), "running");
});
