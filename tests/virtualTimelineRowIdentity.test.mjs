import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai";
import { buildTimelineRowModel } from "../src/renderer/src/components/session/timeline/timelineRowModel.ts";
import { buildMeasuredHeightAliases } from "../src/renderer/src/components/session/timeline/virtualTimelineGeometry.ts";
import { getUserBubblePresentationAtom, removeSessionPresentationState } from "../src/renderer/src/atoms/timeline-presentation.ts";

const user = (id, requestId) => ({ kind: "message", message: {
	id, agentId: "agent", role: "user", text: "An expanded long message", timestamp: 1,
	...(requestId ? { meta: { optimisticRequestId: requestId } } : {}),
} });

test("accepted user rows keep their presentation identity after request metadata disappears", () => {
	const sessionId = "user-row-takeover";
	const store = createStore();
	try {
		const optimistic = buildTimelineRowModel([user("request-1")]);
		store.set(getUserBubblePresentationAtom(sessionId, optimistic.rows[0].key), {
			messageExpanded: true, visionDetailOpen: true,
		});
		const accepted = buildTimelineRowModel([user("accepted-1", "request-1")], { previousModel: optimistic });
		assert.equal(accepted.rows[0].key, optimistic.rows[0].key);
		assert.equal(accepted.rowKeyByMessageId.has("request-1"), false);
		assert.equal(accepted.rowKeyByMessageId.get("accepted-1"), accepted.rows[0].key);
		const projected = buildTimelineRowModel([user("accepted-1")], { previousModel: accepted });
		assert.deepEqual(store.get(getUserBubblePresentationAtom(sessionId, projected.rows[0].key)), {
			messageExpanded: true, visionDetailOpen: true,
		});
		assert.equal(projected.rows[0].anchorId, "accepted-1", "saved anchors use the current message identity");
		assert.deepEqual([...projected.rowKeyByMessageId.keys()], ["accepted-1"]);
		const next = buildTimelineRowModel([user("accepted-1")], { previousModel: projected });
		assert.equal(next.rows[0].key, optimistic.rows[0].key);
		assert.equal(store.get(getUserBubblePresentationAtom(sessionId, next.rows[0].key)).messageExpanded, true);
	} finally {
		removeSessionPresentationState(sessionId);
	}
});

test("a still-present request row cannot donate its key to another current row", () => {
	const before = buildTimelineRowModel([user("request-1")]);
	for (const items of [[user("accepted-1", "request-1"), user("request-1")], [user("request-1"), user("accepted-1", "request-1")]]) {
		const after = buildTimelineRowModel(items, { previousModel: before });
		assert.equal(new Set(after.rows.map((row) => row.key)).size, 2);
		assert.equal(after.rowKeyByMessageId.get("request-1"), "message:request-1");
		assert.equal(after.rowKeyByMessageId.get("accepted-1"), "message:accepted-1");
	}
});

test("ambiguous request claims preserve separate row identities", () => {
	const before = buildTimelineRowModel([user("request-1")]);
	const after = buildTimelineRowModel([user("accepted-1", "request-1"), user("accepted-2", "request-1")], { previousModel: before });
	assert.deepEqual(after.rows.map((row) => row.key), ["message:accepted-1", "message:accepted-2"]);
	assert.equal(after.rowKeyByMessageId.has("request-1"), false);
});

test("measurement aliases never reuse a live row or lend one sample to ambiguous request claims", () => {
	for (const items of [
		[user("accepted-1", "request-1"), user("request-1")],
		[user("accepted-1", "request-1"), user("accepted-2", "request-1")],
	]) {
		assert.equal(buildMeasuredHeightAliases(buildTimelineRowModel(items).rows).size, 0);
	}
});
