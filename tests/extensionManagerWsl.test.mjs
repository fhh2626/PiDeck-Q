import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function loadExtensionManager(fsOverrides = {}, atomicWrite) {
	const loaded = loadTsCommonJs("src/main/extensions/ExtensionManager.ts", {
		stubs: {
			"node:fs/promises": { ...fsPromises, ...fsOverrides },
			// 设置写入走原子写；需要观察/伪造写入时替换它（不再拦截 fs.promises.writeFile）。
			...(atomicWrite ? { "../utils/atomicWriteFile": { writeFileAtomic: atomicWrite } } : {}),
			// 删除走系统回收站统一入口；本测试不触达删除路径，提供 noop stub 即可。
			"../fs/trash": { trashPath: async () => {} },
			"../logging/sharedLogger": { getAppLogger: () => null },
		},
	});
	// WslPaths 含 parameter property，不能直接 ESM import（Node strip-only 不支持）；
	// 与 ExtensionManager 用同一套加载器，保证两边类实例同源。
	const wslPaths = loadTsCommonJs("src/main/wsl/WslPaths.ts");
	return { ...loaded, wslPaths };
}

test("reads an installed WSL npm extension version through its canonical host path", async () => {
	const fixtureDir = mkdtempSync(join(tmpdir(), "pideck-extension-version-"));
	const fixturePath = join(fixtureDir, "package.json");
	writeFileSync(fixturePath, JSON.stringify({ name: "fixture-extension", version: "1.2.3" }), "utf8");
	const requestedPaths = [];

	try {
		const { ExtensionManager, wslPaths } = loadExtensionManager({
			readFile: async (path, encoding) => {
				requestedPaths.push(String(path));
				return readFile(fixturePath, encoding);
			},
		});
		const manager = new ExtensionManager({}, () => ({}));
		manager.configureWsl(wslPaths.createWslEnvironment("Ubuntu-24.04", "root", "/root"));

		const version = await manager.readInstalledVersion(
			"/root/.pi/agent/extensions/npm/fixture-extension",
		);

		assert.equal(version, "1.2.3");
		assert.equal(requestedPaths.length, 1);
		assert.equal(
			requestedPaths[0].replace(/\\/g, "/"),
			"//wsl.localhost/Ubuntu-24.04/root/.pi/agent/extensions/npm/fixture-extension/package.json",
		);
	} finally {
		rmSync(fixtureDir, { recursive: true, force: true });
	}
});

test("reads and writes extension enablement in the active WSL HOME", async () => {
	let settingsContent = JSON.stringify({ disabledExtensions: [] });
	const reads = [];
	const writes = [];
	const { ExtensionManager, wslPaths } = loadExtensionManager({
		readFile: async (filePath) => {
			reads.push(String(filePath));
			return settingsContent;
		},
	}, async (filePath, content) => {
		writes.push(String(filePath));
		settingsContent = String(content);
	});
	const manager = new ExtensionManager({}, () => ({}));
	manager.configureWsl(wslPaths.createWslEnvironment("Ubuntu-24.04", "root", "/root"));

	await manager.setEnabled("pi-deck-todo.ts", false);
	const disabled = await manager.getDisabledExtensions();

	const expectedPath = "//wsl.localhost/Ubuntu-24.04/root/.pi/agent/settings.json";
	assert.equal(reads.every((filePath) => filePath.replace(/\\/g, "/") === expectedPath), true);
	assert.equal(writes[0].replace(/\\/g, "/"), expectedPath);
	assert.equal(disabled.has("pi-deck-todo.ts"), true);
});
