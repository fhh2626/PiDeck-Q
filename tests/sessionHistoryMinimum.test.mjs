import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** 会话历史保底（桌面 50 轮 / Web 100 显示单元）的回归测试。 */
function loadAtoms() {
	return loadTsCommonJs("src/renderer/src/atoms/session-atoms.ts");
}

/** 一轮 = user + assistant；i 从 1 起，便于断言下标。 */
function turn(i) {
	return [
		{ id: `u${i}`, role: "user", text: `q${i}`, timestamp: i * 10, meta: { entryId: `eu${i}` } },
		{ id: `a${i}`, role: "assistant", text: `a${i}`, timestamp: i * 10 + 1, meta: { entryId: `ea${i}` } },
	];
}

function turns(count, from = 1) {
	const messages = [];
	for (let i = from; i < from + count; i += 1) messages.push(...turn(i));
	return messages;
}

/** 跨 vm realm 的数组/对象不能用 deepEqual，统一比 JSON 或逐字段。 */
function ids(messages) {
	return JSON.stringify(messages.map((message) => message.id));
}

test("countUserTurns only counts user messages", () => {
	const atoms = loadAtoms();
	const messages = [
		{ id: "u1", role: "user", text: "q1", timestamp: 1 },
		{ id: "a1", role: "assistant", text: "a1", timestamp: 2 },
		{ id: "t1", role: "tool", text: "", timestamp: 3 },
		{ id: "u2", role: "user", text: "q2", timestamp: 4 },
	];
	assert.equal(atoms.countUserTurns(messages), 2);
	assert.equal(atoms.countUserTurns([]), 0);
});

test("keepTailTurns keeps the last N turns whole", () => {
	const atoms = loadAtoms();
	const messages = turns(3);
	const kept = atoms.keepTailTurns(messages, 2);
	assert.equal(kept.length, 4);
	assert.equal(ids(kept), ids([...turn(2), ...turn(3)]));
	assert.equal(kept[0].role, "user");
	assert.equal(kept[0].text, "q2");
});

test("keepTailTurns returns everything when fewer turns than requested", () => {
	const atoms = loadAtoms();
	const messages = turns(3);
	const kept = atoms.keepTailTurns(messages, 5);
	assert.equal(kept.length, 6);
	assert.equal(ids(kept), ids(messages));
});

test("keepTailTurns returns empty for non-positive turn counts", () => {
	const atoms = loadAtoms();
	assert.equal(atoms.keepTailTurns(turns(3), 0).length, 0);
	assert.equal(atoms.keepTailTurns(turns(3), -1).length, 0);
});

test("MIN_DISPLAY_TURNS is 50", () => {
	const atoms = loadAtoms();
	assert.equal(atoms.MIN_DISPLAY_TURNS, 50);
});
