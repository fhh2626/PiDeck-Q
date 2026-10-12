import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { findSessionTreeBlock, isPathInSessionTree } = loadTsCommonJs("src/main/sessions/sessionTreeGuard.ts");

const parent = { id: "p", filePath: "C:\\s\\same.jsonl", environment: "native" };
const child = { id: "c", filePath: "C:\\s\\same\\run\\child.jsonl", environment: "native" };
const neighbour = { id: "n", filePath: "C:\\s\\same-other.jsonl", environment: "native" };

test("busy child blocks parent", () => {
	const result = findSessionTreeBlock(parent, {
		listEntries: () => [parent, child],
		listAgents: () => [],
		isSessionBusy: (id) => id === "c",
	});
	assert.equal(JSON.stringify(result), JSON.stringify({ kind: "session-busy", sessionId: "c" }));
});

test("prefix sibling is not part of the tree", () => {
	// same-other.jsonl 与 same.jsonl 只共享前缀，绝不能算父子关系
	assert.equal(isPathInSessionTree(parent.filePath, neighbour.filePath, "native"), false);
	const result = findSessionTreeBlock(parent, {
		listEntries: () => [parent, neighbour],
		listAgents: () => [],
		isSessionBusy: (id) => id === "n",
	});
	assert.equal(result, null);
});

test("agent using a child file blocks", () => {
	const result = findSessionTreeBlock(parent, {
		listEntries: () => [parent],
		listAgents: () => [{ title: "T", sessionPath: "c:/s/same/x.jsonl", sessionEnvironment: "native" }],
		isSessionBusy: () => false,
	});
	assert.equal(JSON.stringify(result), JSON.stringify({ kind: "file-in-use", agentTitle: "T" }));
});

test("idle tree passes", () => {
	const result = findSessionTreeBlock(parent, {
		listEntries: () => [parent, child],
		listAgents: () => [],
		isSessionBusy: () => false,
	});
	assert.equal(result, null);
});

test("the root session itself blocks first", () => {
	const result = findSessionTreeBlock(parent, {
		listEntries: () => [parent, child],
		listAgents: () => [],
		isSessionBusy: () => true,
	});
	assert.equal(JSON.stringify(result), JSON.stringify({ kind: "session-busy", sessionId: "p" }));
});

test("WSL identity is matched by distro and user, not just environment", () => {
	const wslParent = {
		id: "wp",
		filePath: "/home/u/.pi/agent/sessions/same.jsonl",
		environment: "wsl",
		wslDistro: "Ubuntu",
		wslUser: "u",
	};
	const otherDistroChild = {
		id: "oc",
		filePath: "/home/u/.pi/agent/sessions/same/x.jsonl",
		environment: "wsl",
		wslDistro: "Debian",
		wslUser: "u",
	};
	const result = findSessionTreeBlock(wslParent, {
		listEntries: () => [wslParent, otherDistroChild],
		listAgents: () => [],
		isSessionBusy: (id) => id === "oc",
	});
	// 另一个发行版的同名路径不是同一棵树
	assert.equal(result, null);

	const sameDistroChild = { ...otherDistroChild, id: "sc", wslDistro: "Ubuntu" };
	const blocked = findSessionTreeBlock(wslParent, {
		listEntries: () => [wslParent, sameDistroChild],
		listAgents: () => [],
		isSessionBusy: (id) => id === "sc",
	});
	assert.equal(JSON.stringify(blocked), JSON.stringify({ kind: "session-busy", sessionId: "sc" }));
});

test("entries without a file path are ignored", () => {
	// 根会话没有 filePath 时无法判定子树，只能检查它自己的忙状态；
	// 不能因为无法比较路径就把无关的子会话判成冲突。
	const noFile = { id: "p", environment: "native" };
	assert.equal(findSessionTreeBlock(noFile, {
		listEntries: () => [noFile, child],
		listAgents: () => [],
		isSessionBusy: (id) => id === "c",
	}), null);
	// 但它自己忙时仍然要拦住
	assert.equal(JSON.stringify(findSessionTreeBlock(noFile, {
		listEntries: () => [noFile, child],
		listAgents: () => [],
		isSessionBusy: (id) => id === "p",
	})), JSON.stringify({ kind: "session-busy", sessionId: "p" }));
});
