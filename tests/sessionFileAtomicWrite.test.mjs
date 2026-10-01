import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const session = [
	{ type: "session", id: "aaaa0001", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", cwd: "C:\\proj" },
	{ type: "message", id: "aaaa0002", parentId: "aaaa0001", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hi" } },
].map((entry) => JSON.stringify(entry)).join("\n") + "\n";

/** 用「写到一半就崩」的原子写替身加载扫描器：正式文件必须保持原样。 */
function loadScannerWithFailingWriter(home) {
	return loadTsCommonJs("src/main/sessions/SessionScanner.ts", {
		stubs: {
			electron: { app: { getPath: () => home }, shell: { trashItem: async () => {} } },
			"../logging/sharedLogger": { getAppLogger: () => null },
			// 模拟写到一半失败（磁盘满/进程被杀）：正式文件必须保持原样。
			"../utils/atomicWriteFile": { writeFileAtomic: async () => { throw new Error("simulated crash"); } },
		},
	});
}

test("session rename that fails mid-write leaves the original session file intact", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-session-atomic-"));
	try {
		const dir = join(home, ".pi", "agent", "sessions");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "s.jsonl");
		writeFileSync(file, session);

		const { SessionScanner } = loadScannerWithFailingWriter(home);
		const scanner = new SessionScanner(undefined, home);
		await assert.rejects(() => scanner.rename(file, "new name"), /simulated crash/);

		// 直接 writeFile 会先截断原文件：崩溃后只剩半个会话
		assert.equal(readFileSync(file, "utf8"), session);
		assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("session rename goes through the atomic writer on the success path", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-session-atomic-ok-"));
	try {
		const dir = join(home, ".pi", "agent", "sessions");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "s.jsonl");
		writeFileSync(file, session);

		const calls = [];
		const { SessionScanner } = loadTsCommonJs("src/main/sessions/SessionScanner.ts", {
			stubs: {
				electron: { app: { getPath: () => home }, shell: { trashItem: async () => {} } },
				"../logging/sharedLogger": { getAppLogger: () => null },
				"../utils/atomicWriteFile": {
					writeFileAtomic: async (path, content) => {
						calls.push(path);
						writeFileSync(path, content, "utf8");
					},
				},
			},
		});
		const scanner = new SessionScanner(undefined, home);
		await scanner.rename(file, "renamed");

		assert.deepEqual(calls, [file], "重命名必须走原子写而不是直接 writeFile");
		// 原子写替身直接落盘：内容仍是合法会话 + 新的 session_info
		const lines = readFileSync(file, "utf8").trim().split("\n");
		assert.equal(JSON.parse(lines.at(-1)).name, "renamed");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
