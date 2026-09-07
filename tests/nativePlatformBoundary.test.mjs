import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function filesUnder(dir, result = []) {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry).replaceAll("\\", "/");
		if (statSync(path).isDirectory()) filesUnder(path, result);
		else if (/\.(ts|tsx)$/.test(path)) result.push(path);
	}
	return result;
}

test("native platform boundary keeps backend/business code free of Electron", () => {
	const files = [
		...filesUnder("src/main/backend"),
		...filesUnder("src/main/ipc"),
		...filesUnder("src/main/platform"),
		...filesUnder("src/native-node"),
	];
	const allowed = (file) => file === "src/main/ipc/electronPreloadLifecycleIpc.ts" || file.startsWith("src/main/platform/electron/");
	const offending = files.filter((file) => {
		if (allowed(file)) return false;
		const source = readFileSync(file, "utf8");
		return /from\s+["']electron["']|require\(["']electron["']\)|\bBrowserWindow\b/.test(source);
	});
	assert.deepEqual(offending, []);
});

test("native sidecar uses the existing backend contracts rather than Electron entrypoints", () => {
	const source = readFileSync("src/native-node/index.ts", "utf8");
	assert.match(source, /createBackend/);
	assert.match(source, /createNativePlatformServices/);
	assert.match(source, /NativeRpcRouter/);
	assert.doesNotMatch(source, /main\/index/);
	assert.doesNotMatch(source, /ipcMain|ipcRenderer|BrowserWindow/);
});

test("native renderer broadcast callback keeps its host receiver for delayed scans", () => {
	const source = readFileSync("src/native-node/host/NativeBackendHost.ts", "utf8");
	assert.match(source, /sendToRenderer\s*=\s*\(channel: string, \.\.\.args: unknown\[\]\)/);
});
