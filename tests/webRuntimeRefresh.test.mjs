import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { sameUiMessages } = loadTsCommonJs("src/renderer/src/web/webMessageMergeHelpers.ts");
const { mergeAuthoritativeUiMessages } = loadTsCommonJs("src/renderer/src/web/webMessageMerge.ts");
const row = (id, role, text, timestamp) => ({ id, role, parts: [{ type: "text", text }],
	...(timestamp !== undefined ? { metadata: { chatRole: role, timestamp, entryId: id } } : {}) });
const ids = (messages) => Array.from(messages, (message) => message.id);

test("an unchanged busy cache can still differ from the visible chat after settlement", () => {
	const visible = [row("user", "user", "question", 1)];
	const cache = [...visible, row("answer", "assistant", "PC reply", 2)];
	const merged = mergeAuthoritativeUiMessages(cache, structuredClone(cache));
	assert.equal(merged, cache, "a stable cache is deliberately reused");
	assert.equal(sameUiMessages(visible, merged), false, "visible rows must still be refreshed");
});

test("cloned visible arrays do not repeatedly reapply the same idle snapshot", () => {
	const cache = [row("user", "user", "question", 1), row("answer", "assistant", "reply", 2)];
	assert.equal(sameUiMessages(structuredClone(cache), cache), true);
});

test("visible message equality observes metadata-only and text changes", () => {
	const original = [row("answer", "assistant", "reply", 2)];
	assert.equal(sameUiMessages(original, [row("answer", "assistant", "reply", 3)]), false);
	assert.equal(sameUiMessages(original, [row("answer", "assistant", "new reply", 2)]), false);
	assert.equal(sameUiMessages(original, []), false);
});

test("new local submissions do not cut across a missing cached PC reply", () => {
	const old = [row("user", "user", "question", 1), row("interim", "assistant", "interim", 2)];
	const cache = [...old, row("pc-answer", "assistant", "PC final reply", 3)];
	const live = [...old, row("new-user", "user", "new question"), row("new-answer", "assistant", "new answer")];
	const merged = mergeAuthoritativeUiMessages(cache, live);
	assert.deepEqual(ids(merged), ["user", "interim", "pc-answer", "new-user", "new-answer"]);
	assert.deepEqual(ids(mergeAuthoritativeUiMessages(merged, live)), ids(merged));
});

test("replayed local turns stay before a later known cached user turn", () => {
	const prefix = [row("first-user", "user", "first", 1), row("first-answer", "assistant", "first reply", 2)];
	const later = [row("later-user", "user", "later"), row("later-answer", "assistant", "later reply")];
	const replay = [...prefix, row("middle-user", "user", "middle"), row("middle-answer", "assistant", "middle reply"), later[0]];
	assert.deepEqual(ids(mergeAuthoritativeUiMessages([...prefix, ...later], replay)),
		["first-user", "first-answer", "middle-user", "middle-answer", "later-user", "later-answer"]);
});

test("timestamped older user turns still insert before newer cached history", () => {
	const current = [row("new-user", "user", "new", 3), row("new-answer", "assistant", "new reply", 4)];
	const older = [row("old-user", "user", "old", 1), row("old-answer", "assistant", "old reply", 2)];
	assert.deepEqual(ids(mergeAuthoritativeUiMessages(current, older)), ["old-user", "old-answer", "new-user", "new-answer"]);
});
