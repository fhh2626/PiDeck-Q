import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ALLOWED_EDGE_FILES = new Set([
	"src/main/index.ts",
	"src/main/ipc/electronPreloadLifecycleIpc.ts",
	"src/main/preloadPath.ts",
	"src/main/singleInstance.ts",
	"src/main/devTools.ts",
	"src/main/linuxDisplayBackend.ts",
	"src/main/browser/browserPanelWebviewHost.ts",
	"src/main/memory/MemoryMonitor.ts",
	"src/main/transport/ElectronRpcRouter.ts",
	"src/main/window/AppTray.ts",
	"src/main/window/MainWindowControls.ts",
]);

function isAllowedEdge(filePath) {
	if (ALLOWED_EDGE_FILES.has(filePath)) return true;
	if (filePath.startsWith("src/main/platform/electron/")) return true;
	return false;
}

function getAllFiles(dir, files = []) {
	for (const entry of readdirSync(dir)) {
		const fullPath = join(dir, entry).replace(/\\/g, "/");
		const stat = statSync(fullPath);
		if (stat.isDirectory()) {
			getAllFiles(fullPath, files);
		} else if (fullPath.endsWith(".ts") || fullPath.endsWith(".tsx")) {
			files.push(fullPath);
		}
	}
	return files;
}

test("TEST platformBoundary: business modules must not import electron directly", () => {
	const offending = [];
	const electronPattern = /from\s+["']electron["']|require\(["']electron["']\)|import\(["']electron["']\)|Electron\./;

	const allFiles = getAllFiles("src/main");
	for (const file of allFiles) {
		if (isAllowedEdge(file)) continue;
		const content = readFileSync(file, "utf8");
		if (electronPattern.test(content)) {
			offending.push(file);
		}
	}

	assert.deepEqual(offending, [], `The following business files contain direct Electron imports/references:\n${offending.join("\n")}`);
});

test("TEST platformBoundary: PlatformServices contract does not reference Electron", () => {
	const content = readFileSync("src/main/platform/PlatformServices.ts", "utf8");
	assert.doesNotMatch(content, /from\s+["']electron["']/);
	assert.doesNotMatch(content, /require\(["']electron["']\)/);
	assert.doesNotMatch(content, /import\(["']electron["']\)/);
	assert.doesNotMatch(content, /BrowserWindow/);
	assert.doesNotMatch(content, /Electron\.OpenDialogOptions/);
	assert.doesNotMatch(content, /Electron\./);
});
