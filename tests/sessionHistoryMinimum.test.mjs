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

// ── D1：全量推送不得丢掉磁盘读到的历史 ──

const WINDOW_TURNS = 50;

/** 模拟磁盘首页：最近 50 轮（turn 1..50），前面还有 150 轮（nextBefore=300）。 */
function seedDiskFirstPage(store, atoms, sessionId) {
	store.set(atoms.cacheSessionMessagesAtom, {
		sessionId,
		messages: turns(WINDOW_TURNS),
		source: "disk",
		expectedRevision: 0,
		page: { total: 400, nextBefore: 300 },
	});
}

function emitFullSnapshot(store, atoms, sessionId, payload) {
	store.set(atoms.applySessionRuntimeEventAtom, {
		kind: "event",
		sessionId,
		agentId: "agent-1",
		runtimeGeneration: 1,
		sourceChannel: "agents:message",
		payload: { agentId: "agent-1", ...payload },
	});
}

/** 显示条数 = 历史前缀 + 运行时窗口。 */
function shownCount(entry) {
	return (entry.history?.messages.length ?? 0) + entry.messages.length;
}

const SUMMARY_CARD = {
	id: "c1",
	role: "system",
	text: "",
	timestamp: 1000,
	meta: { type: "compaction" },
};

test("D1: compaction window keeps the disk history instead of replacing it", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const sessionId = "s1";
	seedDiskFirstPage(store, atoms, sessionId);

	emitFullSnapshot(store, atoms, sessionId, {
		messages: [SUMMARY_CARD, ...turn(50)],
		totalLength: 2,
	});

	const entry = store.get(atoms.sessionMessagesCacheAtom)[sessionId];
	assert.equal(entry.source, "runtime");
	assert.ok(shownCount(entry) >= 100, `shown count ${shownCount(entry)} should be >= 100`);
	const historyTexts = entry.history.messages.map((message) => message.text);
	assert.equal(historyTexts.includes("q50") || historyTexts.includes("a50"), false,
		"history must not duplicate messages that live in the runtime window");
	assert.equal(entry.history.messages.some((message) =>
		message.meta?.type === "compaction" || message.meta?.type === "branchSummary"), false,
		"history must not carry a second summary card");
	assert.equal(entry.history.nextBefore, 300);
});

test("D1: an empty window does not clear the already displayed messages", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const sessionId = "s1";
	seedDiskFirstPage(store, atoms, sessionId);

	emitFullSnapshot(store, atoms, sessionId, { messages: [], totalLength: 0 });

	const entry = store.get(atoms.sessionMessagesCacheAtom)[sessionId];
	assert.equal(shownCount(entry), 100);
});

test("D1: an explicit preserveHistory=false still drops the old content", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const sessionId = "s1";
	seedDiskFirstPage(store, atoms, sessionId);

	emitFullSnapshot(store, atoms, sessionId, {
		messages: [SUMMARY_CARD, ...turn(50)],
		totalLength: 2,
		preserveHistory: false,
	});

	const entry = store.get(atoms.sessionMessagesCacheAtom)[sessionId];
	assert.equal(entry.history, undefined);
});

test("D1: mark the demoted prefix exhausted when disk already reached the file start", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const sessionId = "s1";
	store.set(atoms.cacheSessionMessagesAtom, {
		sessionId,
		messages: turns(WINDOW_TURNS),
		source: "disk",
		expectedRevision: 0,
		page: { total: 100, nextBefore: null },
	});

	emitFullSnapshot(store, atoms, sessionId, {
		messages: [SUMMARY_CARD, ...turn(50)],
		totalLength: 2,
	});

	const entry = store.get(atoms.sessionMessagesCacheAtom)[sessionId];
	assert.equal(entry.history.exhausted, true);
});

test("D1: runtime window without entryIds still dedupes against the disk prefix", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const sessionId = "s1";
	seedDiskFirstPage(store, atoms, sessionId);

	const windowWithoutEntryIds = turn(50).map((message) => ({
		...message,
		id: `rt-${message.id}`,
		meta: {},
	}));
	emitFullSnapshot(store, atoms, sessionId, {
		messages: [SUMMARY_CARD, ...windowWithoutEntryIds],
		totalLength: 2,
	});

	const entry = store.get(atoms.sessionMessagesCacheAtom)[sessionId];
	assert.equal(
		entry.history.messages.some((message) => message.text === "q50"),
		false,
		"fingerprint overlap must remove the duplicated last turn from the prefix",
	);
});

// ── D2：回底释放必须给出 50 轮的底线 ──

/** 构造一个 runtime 条目：窗口段 + 历史前缀。 */
function seedRuntimeWithHistory(store, atoms, sessionId, input) {
	store.set(atoms.cacheSessionMessagesAtom, {
		sessionId,
		messages: input.window,
		source: "runtime",
		windowStart: 0,
		history: {
			messages: input.history,
			nextBefore: 123,
			...(input.compactionRetainedKeys
				? { compactionRetainedKeys: input.compactionRetainedKeys }
				: {}),
			...(input.sticky ? { sticky: true } : {}),
		},
	});
}

test("D2: bottom release keeps enough history to reach the 50-turn floor", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const sessionId = "s1";
	seedRuntimeWithHistory(store, atoms, sessionId, {
		window: turns(WINDOW_TURNS - 47, 78), // 3 轮
		history: turns(80), // 80 轮
	});

	assert.equal(store.set(atoms.releaseSessionHistoryAtom, sessionId), true);
	const entry = store.get(atoms.sessionMessagesCacheAtom)[sessionId];
	assert.equal(atoms.countUserTurns(entry.history.messages), 47);
	assert.equal(entry.history.nextBefore, null);
});

test("D2: bottom release is a no-op when the history is below the floor", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const sessionId = "s1";
	seedRuntimeWithHistory(store, atoms, sessionId, {
		window: turns(WINDOW_TURNS - 47, 78),
		history: turns(40),
	});
	const before = store.get(atoms.sessionMessagesCacheAtom)[sessionId];

	assert.equal(store.set(atoms.releaseSessionHistoryAtom, sessionId), false);
	assert.equal(store.get(atoms.sessionMessagesCacheAtom)[sessionId], before);
});

test("D2: bottom release still frees history when the window alone exceeds the floor", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const sessionId = "s1";
	seedRuntimeWithHistory(store, atoms, sessionId, {
		window: turns(60),
		history: turns(10),
	});

	assert.equal(store.set(atoms.releaseSessionHistoryAtom, sessionId), true);
	const entry = store.get(atoms.sessionMessagesCacheAtom)[sessionId];
	assert.equal(entry.history, undefined);
});

test("D2: bottom release keeps the compaction-retained turns in addition to the floor", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const sessionId = "s1";
	const history = turns(10);
	const retained = history.slice(-4).map((message) => `e:${message.meta.entryId}`);
	seedRuntimeWithHistory(store, atoms, sessionId, {
		window: turns(60),
		history,
		compactionRetainedKeys: retained,
	});

	assert.equal(store.set(atoms.releaseSessionHistoryAtom, sessionId), true);
	const entry = store.get(atoms.sessionMessagesCacheAtom)[sessionId];
	assert.equal(entry.history.messages.length, 4);
	assert.equal(ids(entry.history.messages), ids(history.slice(-4)));
});

test("D2: bottom release defers while the prefix is still sticky", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const sessionId = "s1";
	seedRuntimeWithHistory(store, atoms, sessionId, {
		window: turns(1),
		history: turns(80),
		sticky: true,
	});

	assert.equal(store.set(atoms.releaseSessionHistoryAtom, sessionId), false);
});

test("D2: clearSessionHistoryAtom keeps its unconditional-invalidation semantics", () => {
	// 两个 atom 职责不同（用户 2026-12 确认拆分）：
	// - clearSessionHistoryAtom：旧前缀已失效，无条件作废（mutation refresh 失败兜底）；
	// - releaseSessionHistoryAtom：回底省内存，保底 MIN_DISPLAY_TURNS 轮。
	const atoms = loadAtoms();
	const store = createStore();
	const sessionId = "s1";
	seedRuntimeWithHistory(store, atoms, sessionId, {
		window: turns(3, 78),
		history: turns(80),
	});

	assert.equal(store.set(atoms.clearSessionHistoryAtom, sessionId), true);
	const entry = store.get(atoms.sessionMessagesCacheAtom)[sessionId];
	assert.equal(entry.history, undefined, "clear must drop everything regardless of the floor");
	assert.equal(entry.messages.length, 6, "runtime window stays untouched");
});
