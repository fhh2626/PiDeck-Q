import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
const { chatMessagesToUiMessages } = loadTsCommonJs("src/renderer/src/web/webApi.ts");
const { mergeAuthoritativeUiMessages } = loadTsCommonJs("src/renderer/src/web/webMessageMerge.ts");
const { resolveWebToolPartStatus, resolveWebToolGroupStatus } = loadTsCommonJs("src/renderer/src/web/webToolGroups.ts");
const { getToolStatus } = loadTsCommonJs("src/renderer/src/components/session/TimelineFormat.ts");
const { resolveToolGroupStatus } = loadTsCommonJs("src/renderer/src/components/session/timeline/toolGroupPage.ts");

/** A stale historical call and a real execution share the Pi toolCallId, not timestamps. */
function row(status, id = "history") {
	return { id, agentId: "agent", role: "tool", text: "subagent", timestamp: id === "history" ? 1 : 300_000,
		meta: { status, toolName: "subagent", toolCallId: "call", args: '{"task":"inspect"}',
			...(status === "unknown" ? { sourceEntryId: "assistant-entry" } : {}),
			...(status === "done" ? { result: "actual result" } : {}),
			...(status === "error" ? { isError: true, result: "actual failure" } : {}) } };
}

test("idle Web snapshots settle a cached running call without inventing a result", () => {
	const current = chatMessagesToUiMessages([row("running", "runtime")]);
	const incoming = chatMessagesToUiMessages([row("unknown")]);
	const merged = mergeAuthoritativeUiMessages(current, incoming);
	assert.equal(merged.length, 1);
	assert.equal(resolveWebToolPartStatus(merged[0].parts[0]), "unknown");
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
