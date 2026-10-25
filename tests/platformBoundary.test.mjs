import test from "node:test";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

function getAllFiles(dir, files = []) {
	for (const entry of readdirSync(dir)) {
		const fullPath = join(dir, entry).replaceAll("\\", "/");
		if (statSync(fullPath).isDirectory()) getAllFiles(fullPath, files);
		else if (/\.(ts|tsx)$/.test(fullPath)) files.push(fullPath);
	}
	return files;
}

test("business modules must not import Electron directly", () => {
	// 文本断言是对的工具：这是静态分层规则（禁止 import Electron），没有可执行行为可测。
	const allowed = new Set(["src/main/ipc/electronPreloadLifecycleIpc.ts"]);
	const offending = getAllFiles("src/main")
		.filter((file) => !allowed.has(file))
		.filter((file) => /from\s+["']electron["']|require\(["']electron["']\)|\bElectron\./.test(readFileSync(file, "utf8")));
	assert.deepEqual(offending, []);
});

test("native-node adapters do not import Electron or renderer internals", () => {
	// 文本断言是对的工具：这是静态分层规则（禁止 import Electron），没有可执行行为可测。
	const offending = getAllFiles("src/native-node")
		.filter((file) => /from\s+["']electron["']|ipcMain|ipcRenderer|BrowserWindow/.test(readFileSync(file, "utf8")));
	assert.deepEqual(offending, []);
});

test("PlatformServices contract is host-neutral", () => {
	// 文本断言是对的工具：这是静态分层规则（禁止 import Electron），没有可执行行为可测。
	const content = readFileSync("src/main/platform/PlatformServices.ts", "utf8");
	assert.doesNotMatch(content, /from\s+["']electron["']|BrowserWindow|Electron\./i);
});
