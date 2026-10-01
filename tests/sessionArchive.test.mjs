import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadSessionScanner as loadSharedSessionScanner } from "./helpers/loadSessionScanner.mjs";

function loadSessionScanner(homePath) {
	return loadSharedSessionScanner(homePath);
}

async function cleanupTempDir(dir) {
	// Windows 上杀软/索引会短暂锁住刚写过的临时目录；清理失败不应把已通过的断言打成红。
	for (let i = 0; i < 5; i++) {
		try {
			rmSync(dir, { recursive: true, force: true });
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 60));
		}
	}
}

function writeSession(filePath, entries) {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

const healthySession = [
	{ type: "session", id: "bbbb0001", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", cwd: "C:\\proj" },
	{ type: "message", id: "bbbb0002", parentId: "bbbb0001", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello archive" } },
	{ type: "message", id: "bbbb0003", parentId: "bbbb0002", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: "hi" } },
];

test("archive moves the session into .pideck-archive and list no longer returns it", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-archive-"));
	try {
		const sessionsRoot = join(home, ".pi", "agent", "sessions");
		const sessionPath = join(sessionsRoot, "archive-me.jsonl");
		writeSession(sessionPath, healthySession);

		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner(undefined, home);
		// 先让 activeScanRoots 有值（list 会写入），归档路径解析依赖扫描根
		await scanner.list();

		const archived = await scanner.archive(sessionPath);
		assert.ok(archived.includes(".pideck-archive"), `archived path must live in archive dir: ${archived}`);
		assert.ok(!existsSync(sessionPath), "original file must be moved away");
		assert.ok(existsSync(archived), "archived file must exist");

		// 归档后常规列表不再包含该会话
		const summaries = await scanner.list();
		assert.ok(!summaries.some((s) => s.filePath === sessionPath), "archived session must not appear in list");

		// 归档列表能看到它
		const archivedList = await scanner.listArchived();
		assert.ok(archivedList.some((s) => s.filePath === archived), "archived session must appear in listArchived");
	} finally {
		await cleanupTempDir(home);
	}
});

test("unarchive restores the session to its original path", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-unarchive-"));
	try {
		const sessionsRoot = join(home, ".pi", "agent", "sessions");
		const sessionPath = join(sessionsRoot, "restore-me.jsonl");
		writeSession(sessionPath, healthySession);

		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner(undefined, home);
		await scanner.list();

		const archived = await scanner.archive(sessionPath);
		const restored = await scanner.unarchive(archived);

		assert.equal(restored, sessionPath, "unarchive must return the original path");
		assert.ok(!existsSync(archived), "archived file must be gone after restore");
		assert.ok(existsSync(sessionPath), "original file must be back");

		const summaries = await scanner.list();
		assert.ok(summaries.some((s) => s.filePath === sessionPath), "restored session must appear in list again");
		const archivedList = await scanner.listArchived();
		assert.ok(!archivedList.some((s) => s.filePath === archived), "restored session must leave the archive list");
	} finally {
		await cleanupTempDir(home);
	}
});

test("archive moves the sibling sub-session directory along with the file", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-archive-sibling-"));
	try {
		const sessionsRoot = join(home, ".pi", "agent", "sessions");
		const sessionPath = join(sessionsRoot, "parent-session.jsonl");
		writeSession(sessionPath, healthySession);
		// 子会话目录 <stem>/ 与父文件相邻
		const childDir = join(sessionsRoot, "parent-session");
		const childPath = join(childDir, "sub", "child.jsonl");
		writeSession(childPath, [
			{ type: "session", id: "bbbb0004", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", cwd: "C:\\proj" },
			{ type: "message", id: "bbbb0005", parentId: "bbbb0004", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "child" } },
		]);

		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner(undefined, home);
		await scanner.list();

		const archived = await scanner.archive(sessionPath);
		const archivedChild = archived.replace(/\.jsonl$/, "");
		assert.ok(!existsSync(childDir), "sibling dir must be moved away");
		assert.ok(existsSync(join(archivedChild, "sub", "child.jsonl")), "child session must move with parent");

		// 恢复时子目录一并回来
		await scanner.unarchive(archived);
		assert.ok(existsSync(childDir), "sibling dir must be restored");
		assert.ok(existsSync(childPath), "child session must be restored");
	} finally {
		await cleanupTempDir(home);
	}
});

test("archive directory is excluded from regular scans", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-archive-scan-"));
	try {
		const sessionsRoot = join(home, ".pi", "agent", "sessions");
		const sessionPath = join(sessionsRoot, "hidden.jsonl");
		writeSession(sessionPath, healthySession);

		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner(undefined, home);
		await scanner.list();
		await scanner.archive(sessionPath);

		// 直接触发完整扫描：即使归档目录内还有 .jsonl，常规 list 也必须跳过
		const summaries = await scanner.list();
		assert.ok(!summaries.some((s) => s.filePath.includes(".pideck-archive")), "archive dir must be excluded from list");
	} finally {
		await cleanupTempDir(home);
	}
});
