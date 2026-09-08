import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function transpile(filePath) {
	return ts.transpileModule(ts.sys.readFile(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function loadModule(filePath, customRequire) {
	const sandbox = {
		clearTimeout,
		setTimeout,
		process,
		exports: {},
		require: customRequire ?? require,
	};
	vm.runInNewContext(transpile(filePath), sandbox, { filename: filePath });
	return sandbox.exports;
}

const builtInExtensions = loadModule("src/main/extensions/builtInExtensions.ts");
const gitCommitMessagePrompt = loadModule("src/shared/gitCommitMessagePrompt.ts");
const externalEditorTypes = {
	createDefaultExternalEditorSettings: () => ({}),
};
const startupPreferences = loadModule("src/main/settings/startupPreferences.ts");

function loadSettingsStore() {
	return loadModule("src/main/settings/SettingsStore.ts", (id) => {
		if (id.includes("builtInExtensions")) return builtInExtensions;
		if (id.includes("gitCommitMessagePrompt")) return gitCommitMessagePrompt;
		if (id.includes("shared/types")) return externalEditorTypes;
		if (id.includes("startupPreferences")) return startupPreferences;
		if (id.includes("sharedLogger")) return { getAppLogger: () => null };
		return require(id);
	});
}

const { SettingsStore, readPiAgentShowThinking } = loadSettingsStore();
const { readSingleInstancePreference } = startupPreferences;

test("startupPreferences: missing file defaults to singleInstance=true", () => {
	const nonExistent = join(tmpdir(), "non-existent-settings.json");
	assert.equal(readSingleInstancePreference(nonExistent), true);
});

test("startupPreferences: explicit singleInstance=false is read", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pideck-startup-"));
	const settingsPath = join(tempDir, "settings.json");
	try {
		await writeFile(settingsPath, JSON.stringify({ singleInstance: false }), "utf8");
		assert.equal(readSingleInstancePreference(settingsPath), false);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("SettingsStore: hideThinkingBlock mapping and showThinking persistence safety", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pideck-settings-"));
	const desktopSettingsFile = join(tempDir, "settings.json");
	const piAgentSettingsFile = join(tempDir, "agent-settings.json");

	try {
		// Case 1: hideThinkingBlock: true -> showThinking: false
		await writeFile(piAgentSettingsFile, JSON.stringify({ hideThinkingBlock: true }), "utf8");
		assert.equal(readPiAgentShowThinking(piAgentSettingsFile), false);

		const store = new SettingsStore({
			desktopSettingsFile,
			piAgentSettingsFile,
			getSystemLocale: () => "en-US",
		});
		await store.load();
		assert.equal(store.get().showThinking, false);
		// Native PiDeck-Q is a ZIP-distributed portable app; Electron Builder's
		// PORTABLE_EXECUTABLE_DIR is intentionally not required.
		assert.equal(store.get().installationType, "portable");

		// Update another setting and save
		await store.update({ language: "zh-CN" });
		const savedContent = JSON.parse(await readFile(desktopSettingsFile, "utf8"));
		assert.equal(Object.prototype.hasOwnProperty.call(savedContent, "showThinking"), false);
		assert.equal(savedContent.language, "zh-CN");

		// Case 2: hideThinkingBlock: false -> showThinking: true
		await writeFile(piAgentSettingsFile, JSON.stringify({ hideThinkingBlock: false }), "utf8");
		assert.equal(readPiAgentShowThinking(piAgentSettingsFile), true);
		assert.equal(store.get().showThinking, true);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("SettingsStore: portable Native startup corrects a legacy installed value", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pideck-settings-portable-migration-"));
	const desktopSettingsFile = join(tempDir, "settings.json");
	try {
		await writeFile(desktopSettingsFile, JSON.stringify({ installationType: "installed" }), "utf8");
		const store = new SettingsStore({ desktopSettingsFile, getSystemLocale: () => "en-US" });
		await store.load();
		assert.equal(store.get().installationType, "portable");
		assert.equal(JSON.parse(await readFile(desktopSettingsFile, "utf8")).installationType, "portable");
		await store.update({ installationType: "installed" });
		assert.equal(store.get().installationType, "portable");
		assert.equal(JSON.parse(await readFile(desktopSettingsFile, "utf8")).installationType, "portable");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("SettingsStore: removes Electron sandbox legacy field without resetting other settings", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pideck-settings-native-migration-"));
	const desktopSettingsFile = join(tempDir, "settings.json");
	try {
		await writeFile(
			desktopSettingsFile,
			JSON.stringify({ electronChromiumSandbox: true, linkOpenMode: "internal", language: "en-US" }),
			"utf8",
		);
		const store = new SettingsStore({ desktopSettingsFile, getSystemLocale: () => "en-US" });
		await store.load();
		assert.equal(Object.prototype.hasOwnProperty.call(store.get(), "electronChromiumSandbox"), false);
		assert.equal(Object.prototype.hasOwnProperty.call(store.get(), "linkOpenMode"), false);
		assert.equal(store.get().language, "en-US");

		await store.update({ language: "zh-CN" });
		const saved = JSON.parse(await readFile(desktopSettingsFile, "utf8"));
		assert.equal(Object.prototype.hasOwnProperty.call(saved, "electronChromiumSandbox"), false);
		assert.equal(Object.prototype.hasOwnProperty.call(saved, "linkOpenMode"), false);
		assert.equal(saved.language, "zh-CN");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("SettingsStore: a lone legacy disableUpdateCheck is cleaned from disk on load", async () => {
	// 0.2.1 移除内置更新系统：旧 settings.json 里的 disableUpdateCheck 只读兼容——
	// 加载时剥离、不再写回。关键回归点：如果它单独存在（其他 legacy 字段都已被
	// 历次启动清掉），它自己必须能触发一次 save() 把磁盘上的残留字段清掉，
	// 否则该字段会永远留在文件里。
	const tempDir = await mkdtemp(join(tmpdir(), "pideck-settings-update-migration-"));
	const desktopSettingsFile = join(tempDir, "settings.json");
	try {
		await writeFile(desktopSettingsFile, JSON.stringify({ disableUpdateCheck: true }), "utf8");
		const store = new SettingsStore({ desktopSettingsFile, getSystemLocale: () => "en-US" });
		await store.load();

		// 内存态：disableUpdateCheck 不是 AppSettings 的成员，加载后应消失
		assert.equal(Object.prototype.hasOwnProperty.call(store.get(), "disableUpdateCheck"), false);

		// 磁盘态：load() 里的 fire-and-forget save() 把该字段从文件里清掉。
		// 因为 save() 是异步且不 await，测试端轮询等待（最多 200 ms）。
		let onDisk;
		for (let i = 0; i < 20; i++) {
			onDisk = JSON.parse(await readFile(desktopSettingsFile, "utf8"));
			if (!Object.prototype.hasOwnProperty.call(onDisk, "disableUpdateCheck")) break;
			await new Promise((r) => setTimeout(r, 10));
		}
		assert.equal(Object.prototype.hasOwnProperty.call(onDisk, "disableUpdateCheck"), false, JSON.stringify(onDisk));
		// 其他字段不能被这次清理误伤（这里只有一个字段，所以文件应当只剩安装形态）
		assert.equal(onDisk.installationType, "portable");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});
