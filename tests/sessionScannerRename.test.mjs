import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadSessionScanner as loadSharedSessionScanner } from "./helpers/loadSessionScanner.mjs";

function loadSessionScanner(homePath) {
	return loadSharedSessionScanner(homePath);
}

function writeSession(filePath, entries) {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function readLines(filePath) {
	return readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
}

/** 与 pi buildSessionInfo 相同的首行校验：首条可解析记录必须是 type:"session"。 */
function firstParseableEntry(lines) {
	for (const line of lines) {
		try {
			return JSON.parse(line);
		} catch {
			// 跳过不可解析行
		}
	}
	return null;
}

/** 与 pi getSessionName 一致：倒序取最后一条 session_info 的 name。 */
function piSessionName(lines) {
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const entry = JSON.parse(lines[i]);
			if (entry.type === "session_info") return entry.name?.trim() || undefined;
		} catch {
			// 跳过不可解析行
		}
	}
	return undefined;
}

const healthySession = [
	{ type: "session", id: "aaaa0001", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", cwd: "C:\\proj" },
	{ type: "message", id: "aaaa0002", parentId: "aaaa0001", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
	{ type: "message", id: "aaaa0003", parentId: "aaaa0002", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: "hi" } },
];

test("rename appends a pi-native session_info entry and keeps the header first (#114)", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-rename-native-"));
	try {
		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		const file = join(home, "session-a.jsonl");
		writeSession(file, healthySession);

		await scanner.rename(file, "新会话名");

		const lines = readLines(file);
		// 首行仍是 type:"session" 头，pi 可以正常加载（#114 的核心回归点）
		assert.equal(firstParseableEntry(lines)?.type, "session");
		assert.equal(lines.length, healthySession.length + 1);

		const appended = JSON.parse(lines[lines.length - 1]);
		assert.equal(appended.type, "session_info");
		assert.equal(appended.name, "新会话名");
		assert.match(appended.id, /^[0-9a-f]{8}$/);
		// parentId 指向追加前最后一条带 id 的记录，保持会话树链条完整
		assert.equal(appended.parentId, "aaaa0003");
		assert.equal(typeof appended.timestamp, "string");
		// pi 语义：倒序读取到的名字就是新名字
		assert.equal(piSessionName(lines), "新会话名");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("rename heals legacy PiDeck sessionName head lines that broke pi loading (#114)", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-rename-heal-"));
	try {
		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		const file = join(home, "session-b.jsonl");
		// 旧版 PiDeck 的破坏产物：头部前置无 type 的 sessionName 私有行
		writeSession(file, [
			{ sessionName: "Old PiDeck name", ts: 1700000000000 },
			...healthySession,
		]);
		assert.notEqual(firstParseableEntry(readLines(file))?.type, "session");

		await scanner.rename(file, "Healed");

		const lines = readLines(file);
		// 私有行被剔除，首条记录恢复为 type:"session"，pi 重新可见
		assert.equal(firstParseableEntry(lines)?.type, "session");
		assert.ok(!lines.some((line) => line.includes("sessionName")));
		assert.equal(piSessionName(lines), "Healed");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("repeated rename keeps the file flat and the latest name authoritative", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-rename-twice-"));
	try {
		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		const file = join(home, "session-c.jsonl");
		writeSession(file, healthySession);

		await scanner.rename(file, "first");
		await scanner.rename(file, "second");

		const lines = readLines(file);
		const infoCount = lines.filter((line) => line.includes('"session_info"')).length;
		assert.equal(infoCount, 2);
		assert.equal(piSessionName(lines), "second");
		// PiDeck 摘要同样以最后一条 session_info 为准
		const summary = await scanner["readSummary"](file);
		assert.equal(summary?.name, "second");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("rename sanitizes newlines in the name like pi appendSessionInfo", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-rename-sanitize-"));
	try {
		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		const file = join(home, "session-d.jsonl");
		writeSession(file, healthySession);

		await scanner.rename(file, "line1\nline2\r\nline3");

		const lines = readLines(file);
		assert.equal(lines.length, healthySession.length + 1);
		assert.equal(piSessionName(lines), "line1 line2 line3");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("copy produces a pi-loadable session with the copy name as session_info (#114)", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-copy-native-"));
	try {
		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		const file = join(home, "session-e.jsonl");
		writeSession(file, [
			healthySession[0],
			{ type: "session_info", id: "bbbb0001", parentId: "aaaa0001", timestamp: "2026-01-01T00:00:00.500Z", name: "Origin" },
			healthySession[1],
			healthySession[2],
		]);

		const summary = await scanner.copy(file);

		const lines = readLines(summary.filePath);
		assert.equal(firstParseableEntry(lines)?.type, "session");
		assert.equal(piSessionName(lines), "Origin copy");
		assert.equal(summary.name, "Origin copy");
		// 追加记录的 id 不与文件内既有 id 冲突
		const appended = JSON.parse(lines[lines.length - 1]);
		assert.notEqual(appended.id, "bbbb0001");
		assert.equal(appended.parentId, "aaaa0003");
		assert.equal(appended.copiedFrom, file);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
