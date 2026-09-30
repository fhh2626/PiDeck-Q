import assert from "node:assert/strict";
import test from "node:test";
import {
	alignEntryIdsForDisplayMessages,
	assertResendRootEntry,
	buildActiveBranchEntryIds,
	collectDescendantEntryIds,
	findLastUserMessageLine,
	takeActiveEntryId,
} from "../src/main/pi/sessionEntryIds.ts";

function extractText(content) {
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c && c.type === "text")
		.map((c) => c.text ?? "")
		.join("");
}

test("takeActiveEntryId always advances even when caller skips render", () => {
	const ids = ["u1", "a_empty", "t1", "u2"];
	let idx = 0;
	const a = takeActiveEntryId(ids, idx);
	assert.equal(a.entryId, "u1");
	idx = a.nextIndex;
	const b = takeActiveEntryId(ids, idx);
	assert.equal(b.entryId, "a_empty");
	idx = b.nextIndex;
	const c = takeActiveEntryId(ids, idx);
	assert.equal(c.entryId, "t1");
	idx = c.nextIndex;
	const d = takeActiveEntryId(ids, idx);
	assert.equal(d.entryId, "u2");
});

/**
 * 回归：工具回合里 assistant 只有 toolCall、无可见文本时，
 * 旧逻辑不推进 entryIndex，会导致后续用户消息拿到更早的 entryId。
 * 重发若用错 entryId 作根，会沿 parentId 删掉大半段历史。
 */
test("empty assistant tool-call must not shift later user entryIds", () => {
	const activeEntryIds = ["u1", "a1", "u2", "a2_empty", "t1", "a2", "u3", "a3"];
	const rawMessages = [
		{ role: "user", content: [{ type: "text", text: "first" }] },
		{ role: "assistant", content: [{ type: "text", text: "answer1" }] },
		{ role: "user", content: [{ type: "text", text: "second" }] },
		// 无文本，仅 toolCall —— UI 跳过，但 entry 槽位必须消费
		{ role: "assistant", content: [{ type: "toolCall", name: "bash", id: "t1" }] },
		{ role: "toolResult", content: [{ type: "text", text: "ok" }] },
		{ role: "assistant", content: [{ type: "text", text: "answer2" }] },
		{ role: "user", content: [{ type: "text", text: "third-resend-me" }] },
		{ role: "assistant", content: [{ type: "text", text: "partial" }] },
	];

	const aligned = alignEntryIdsForDisplayMessages(rawMessages, activeEntryIds, extractText);
	const u3 = aligned.find((m) => m.role === "user" && !m.skipped && m.entryId === "u3");
	assert.ok(u3, "last user message must keep entryId=u3");

	// 被跳过的 empty assistant 仍应对齐到 a2_empty
	const skippedAssistant = aligned.find((m) => m.entryId === "a2_empty");
	assert.ok(skippedAssistant?.skipped);

	// 模拟旧 bug：跳过 empty assistant 时不 ++，u3 会错绑到 a2
	let badIndex = 0;
	const bad = [];
	for (const typed of rawMessages) {
		if (typed.role !== "user" && typed.role !== "assistant" && typed.role !== "toolResult") continue;
		const entryId = activeEntryIds[badIndex];
		const text = extractText(typed.content);
		if ((typed.role === "user" || typed.role === "assistant") && !text.trim()) {
			// 旧 bug：return [] 且不 ++
			continue;
		}
		badIndex++;
		bad.push({ role: typed.role, entryId });
	}
	const badU3 = bad.find((m) => m.role === "user" && m.entryId !== "u1" && m.entryId !== "u2");
	// 旧逻辑下「第三条 user」会拿到 a2 而非 u3
	assert.equal(bad[bad.length - 2]?.entryId, "a2", "documents the old mis-alignment");
	assert.notEqual(badU3?.entryId, "u3");
});

test("collectDescendantEntryIds only removes root and its descendants", () => {
	const lines = [
		JSON.stringify({ type: "session", id: "s1" }),
		JSON.stringify({ type: "model_change", id: "m1", parentId: null }),
		JSON.stringify({
			type: "message",
			id: "u1",
			parentId: "m1",
			message: { role: "user", content: [{ type: "text", text: "first" }] },
		}),
		JSON.stringify({
			type: "message",
			id: "a1",
			parentId: "u1",
			message: { role: "assistant", content: [{ type: "text", text: "a" }] },
		}),
		JSON.stringify({
			type: "message",
			id: "u2",
			parentId: "a1",
			message: { role: "user", content: [{ type: "text", text: "resend-me" }] },
		}),
		JSON.stringify({
			type: "message",
			id: "a2",
			parentId: "u2",
			message: { role: "assistant", content: [{ type: "text", text: "partial" }] },
		}),
	];

	const removed = collectDescendantEntryIds(lines, "u2");
	assert.deepEqual([...removed].sort(), ["a2", "u2"]);
	assert.ok(!removed.has("u1"));
	assert.ok(!removed.has("a1"));
	assert.ok(!removed.has("m1"));
});

test("wrong early root would wipe history — assertResendRootEntry blocks non-user roots", () => {
	const assistantEntry = {
		type: "message",
		id: "a1",
		message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
	};
	assert.throws(
		() => assertResendRootEntry(assistantEntry, "resend-me", extractText),
		/must be a user message/,
	);

	const wrongUser = {
		type: "message",
		id: "u1",
		message: { role: "user", content: [{ type: "text", text: "first" }] },
	};
	assert.throws(
		() => assertResendRootEntry(wrongUser, "resend-me", extractText),
		/text mismatch/,
	);
});

/**
 * 回归：pi 压缩后 get_messages 只返回「摘要 + 保留段」以后的消息，
 * 而 get_entries 的活动分支仍包含压缩前的归档消息。若按整条分支从头配对，
 * 可见消息会被绑到归档条目的 entryId 上（删除/重发落到错误轮次或报 SESSION_ENTRY_ROLE_INVALID）。
 * 对齐规则：只取最近一次 compaction 的 firstKeptEntryId 及其之后的 message。
 */
test("buildActiveBranchEntryIds keeps the whole branch when the session never compacted", () => {
	const ids = buildActiveBranchEntryIds([
		{ id: "session", parentId: null, type: "session" },
		{ id: "message-1", parentId: "session", type: "message" },
		{ id: "model", parentId: "message-1", type: "model_change" },
		{ id: "message-2", parentId: "model", type: "message" },
		{ id: "discarded", parentId: "message-1", type: "message" },
	], "message-2");

	assert.deepEqual(Array.from(ids), ["message-1", "message-2"]);
});

test("buildActiveBranchEntryIds starts at the latest compaction's firstKeptEntryId", () => {
	const ids = buildActiveBranchEntryIds([
		{ id: "u1", parentId: null, type: "message" },
		{ id: "a1", parentId: "u1", type: "message" },
		{ id: "mc", parentId: "a1", type: "model_change" },
		{ id: "u2", parentId: "mc", type: "message" },
		{ id: "a2", parentId: "u2", type: "message" },
		{ id: "c1", parentId: "a2", type: "compaction", firstKeptEntryId: "u2" },
		{ id: "t2", parentId: "c1", type: "message" },
		{ id: "u3", parentId: "t2", type: "message" },
		{ id: "a3", parentId: "u3", type: "message" },
	], "a3");

	// t2 是 toolResult 消息：必须保留，否则其后的 entryId 会整体错位
	assert.deepEqual(Array.from(ids), ["u2", "a2", "t2", "u3", "a3"]);
});

test("buildActiveBranchEntryIds uses only the compaction closest to the leaf", () => {
	const ids = buildActiveBranchEntryIds([
		{ id: "u1", parentId: null, type: "message" },
		{ id: "a1", parentId: "u1", type: "message" },
		{ id: "c1", parentId: "a1", type: "compaction", firstKeptEntryId: "u1" },
		{ id: "u2", parentId: "c1", type: "message" },
		{ id: "a2", parentId: "u2", type: "message" },
		{ id: "c2", parentId: "a2", type: "compaction", firstKeptEntryId: "u2" },
		{ id: "u3", parentId: "c2", type: "message" },
		{ id: "a3", parentId: "u3", type: "message" },
	], "a3");

	assert.deepEqual(Array.from(ids), ["u2", "a2", "u3", "a3"]);
});

test("buildActiveBranchEntryIds treats a self-referencing anchor as an empty kept range", () => {
	// pi appendCompaction 用自身 id 表示「不保留压缩点之前的条目」
	const ids = buildActiveBranchEntryIds([
		{ id: "u1", parentId: null, type: "message" },
		{ id: "a1", parentId: "u1", type: "message" },
		{ id: "c1", parentId: "a1", type: "compaction", firstKeptEntryId: "c1" },
		{ id: "u2", parentId: "c1", type: "message" },
		{ id: "a2", parentId: "u2", type: "message" },
	], "a2");

	assert.deepEqual(Array.from(ids), ["u2", "a2"]);
});

test("buildActiveBranchEntryIds returns no ids when the anchor is missing", () => {
	const ids = buildActiveBranchEntryIds([
		{ id: "u1", parentId: null, type: "message" },
		{ id: "a1", parentId: "u1", type: "message" },
		{ id: "c1", parentId: "a1", type: "compaction" },
		{ id: "u2", parentId: "c1", type: "message" },
	], "u2");

	// 宁可退化成无 entryId（走文件/序列定位），也不能退回全量分支把 id 绑错
	assert.deepEqual(Array.from(ids), []);
});

test("buildActiveBranchEntryIds returns no ids when the anchor is off the active branch", () => {
	const ids = buildActiveBranchEntryIds([
		{ id: "u1", parentId: null, type: "message" },
		{ id: "a1", parentId: "u1", type: "message" },
		{ id: "c1", parentId: "a1", type: "compaction", firstKeptEntryId: "missing" },
		{ id: "u2", parentId: "c1", type: "message" },
	], "u2");

	assert.deepEqual(Array.from(ids), []);
});

test("buildActiveBranchEntryIds ignores compactions that are not on the active branch", () => {
	const ids = buildActiveBranchEntryIds([
		{ id: "session", parentId: null, type: "session" },
		{ id: "message-1", parentId: "session", type: "message" },
		{ id: "message-2", parentId: "message-1", type: "message" },
		{ id: "c9", parentId: "other", type: "compaction", firstKeptEntryId: "message-1" },
	], "message-2");

	assert.deepEqual(Array.from(ids), ["message-1", "message-2"]);
});

test("buildActiveBranchEntryIds returns no ids when the leaf is unknown", () => {
	const ids = buildActiveBranchEntryIds([
		{ id: "u1", parentId: null, type: "message" },
	], "missing");

	assert.deepEqual(Array.from(ids), []);
});

test("buildActiveBranchEntryIds terminates on a parent cycle", () => {
	const ids = buildActiveBranchEntryIds([
		{ id: "u1", parentId: "a1", type: "message" },
		{ id: "a1", parentId: "u1", type: "message" },
	], "u1");

	assert.equal(ids.length, 2);
	assert.deepEqual([...ids].sort(), ["a1", "u1"]);
});

test("findLastUserMessageLine prefers the latest duplicate text", () => {
	const lines = [
		JSON.stringify({
			type: "message",
			id: "u1",
			message: { role: "user", content: [{ type: "text", text: "same" }] },
		}),
		JSON.stringify({
			type: "message",
			id: "a1",
			message: { role: "assistant", content: [{ type: "text", text: "x" }] },
		}),
		JSON.stringify({
			type: "message",
			id: "u2",
			message: { role: "user", content: [{ type: "text", text: "same" }] },
		}),
	];
	const found = findLastUserMessageLine(lines, "same", extractText);
	assert.equal(found?.entry.id, "u2");
	assert.equal(found?.lineIndex, 2);
});
