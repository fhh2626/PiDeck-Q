import assert from "node:assert/strict";
import test from "node:test";
import {
	getRunExecutionAtom,
	getToolGroupAtom,
	getToolCardExpandedAtom,
	getThinkingPresentationAtom,
	getCompactionExpandedAtom,
	getUserBubblePresentationAtom,
	getEditPresentationAtom,
	removeSessionPresentationState,
} from "../src/renderer/src/atoms/timeline-presentation.ts";

test("presentation atom families: same key yields stable atom, different keys isolate", () => {
	const a1 = getToolGroupAtom("sess-1", "run:1", "group-1");
	const a2 = getToolGroupAtom("sess-1", "run:1", "group-1");
	assert.equal(a1, a2, "相同入参必须返回同一个 atom 实例");

	const b = getToolGroupAtom("sess-2", "run:1", "group-1");
	assert.notEqual(a1, b, "不同 session 必须隔离");

	const c = getToolGroupAtom("sess-1", "run:2", "group-1");
	assert.notEqual(a1, c, "不同 rowKey 必须隔离");
});

test("all entity presentation atom getters return distinct families", () => {
	const runExec = getRunExecutionAtom("s1", "r1");
	const toolCard = getToolCardExpandedAtom("s1", "r1", "m1");
	const thinking = getThinkingPresentationAtom("s1", "r1", "th1");
	const compaction = getCompactionExpandedAtom("s1", "r1", "c1");
	const userBubble = getUserBubblePresentationAtom("s1", "r1");
	const edit = getEditPresentationAtom("s1", "r1");

	assert.ok(runExec && toolCard && thinking && compaction && userBubble && edit);
	assert.notEqual(runExec, toolCard);
});
