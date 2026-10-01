import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadSessionScanner } from "./helpers/loadSessionScanner.mjs";

/**
 * H4：本地会话删除的行为契约。
 *
 * 原来这层只有 sessionDeleteIdempotency.test.mjs 里的源码正则
 * （/if \(!existsSync\(filePath\)\) return;/、/await this\.trashPath\(filePath/），
 * 只能证明那两行还在，证不了「已消失的路径不报错」与「真的只调一次回收站」。
 * 这里用一个记账用的 stub trashPath 驱动真实 delete()。
 *
 * 对应取代的源码断言：
 * - sessionDeleteIdempotency 的 `if (!existsSync(filePath)) return;` 与
 *   `await this.trashPath(filePath` 正则；
 * - 该文件里固化 Bug 的 `"rm", "-f", wslPath` 断言由
 *   sessionDeleteWslSoft.test.mjs 覆盖（A4 的软删除行为测试）。
 */
function createScanner(home, trashCalls) {
	// trashPath 是 SessionScanner 构造函数的第三个参数（translate, homeDir, trashPath）
	const { SessionScanner } = loadSessionScanner(home);
	return new SessionScanner(undefined, home, async (target, options) => {
		trashCalls.push({ target, source: options?.source });
	});
}

function writeSessionFile(filePath) {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(
		filePath,
		`${JSON.stringify({ type: "session", id: "dddd0001", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/x" })}\n`,
		"utf8",
	);
}

test("deleting a local session hands the file to the trash exactly once", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-delete-once-"));
	const trashCalls = [];
	try {
		const sessionPath = join(home, ".pi", "agent", "sessions", "trash-me.jsonl");
		writeSessionFile(sessionPath);

		const scanner = createScanner(home, trashCalls);
		await scanner.delete(sessionPath);

		assert.equal(trashCalls.length, 1, "本地删除必须只调用一次回收站");
		assert.equal(trashCalls[0].target, sessionPath, "回收站必须收到目标文件本身");
		assert.equal(trashCalls[0].source, "sessions:delete", "来源标记用于追责与日志");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("deleting an already missing local session is a no-op and never errors", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-delete-idempotent-"));
	const trashCalls = [];
	try {
		const sessionPath = join(home, ".pi", "agent", "sessions", "never-existed.jsonl");
		const scanner = createScanner(home, trashCalls);

		// catalog 可能保留一个已被 pi/系统回收站移走的历史路径：删除必须幂等，
		// 不能因为文件不存在就抛错（用户点删除会看到假失败）。
		await assert.doesNotReject(() => scanner.delete(sessionPath));
		assert.equal(trashCalls.length, 0, "文件不存在时不应触碰回收站");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("deleting a parent session also trashes the sibling child directory", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-delete-sibling-"));
	const trashCalls = [];
	try {
		const sessionsRoot = join(home, ".pi", "agent", "sessions");
		const parentPath = join(sessionsRoot, "parent.jsonl");
		writeSessionFile(parentPath);
		// 子会话目录约定与父文件相邻：<stem>/ ，删除父会话必须一并移走，避免孤儿目录
		const childDir = join(sessionsRoot, "parent");
		mkdirSync(childDir, { recursive: true });
		writeFileSync(join(childDir, "run.jsonl"), "{}\n", "utf8");

		const scanner = createScanner(home, trashCalls);
		await scanner.delete(parentPath);

		const trashed = trashCalls.map((call) => call.target);
		assert.ok(trashed.includes(parentPath), "父文件必须进回收站");
		assert.ok(trashed.includes(childDir), "同级子会话目录必须一并进回收站");
		assert.equal(trashCalls.length, 2, "只应有两个目标：父文件与子目录");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("local deletion refuses to hard-delete when no trash service is configured", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-delete-notrash-"));
	try {
		const sessionPath = join(home, ".pi", "agent", "sessions", "keep-me.jsonl");
		writeSessionFile(sessionPath);

		// 第三个参数缺省 = 没有回收站：必须抛错而不是静默硬删（防数据不可恢复丢失）
		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner(undefined, home);

		await assert.rejects(() => scanner.delete(sessionPath), /Trash service unavailable/);
		assert.equal(existsSync(sessionPath), true, "拒绝删除后文件必须原地保留");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
