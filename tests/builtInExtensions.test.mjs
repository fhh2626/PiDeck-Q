import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createRequire } from "node:module";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function loadBuiltInExtensionsModule() {
	const source = readFileSync("src/main/extensions/builtInExtensions.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = { exports: {}, require, console };
	vm.runInNewContext(outputText, sandbox, { filename: "builtInExtensions.ts" });
	return sandbox.exports;
}

function sameArgs(actual, expected) {
	// vm 沙箱数组与主 realm deepStrictEqual 可能因原型不同失败
	assert.equal(JSON.stringify([...actual]), JSON.stringify(expected));
}

test("appendBuiltInExtensionArgs adds repeated --extension flags", () => {
	const { appendBuiltInExtensionArgs } = loadBuiltInExtensionsModule();
	const next = appendBuiltInExtensionArgs(["--mode", "rpc"], [
		"C:\\app\\resources\\extensions\\pi-deck-todo.ts",
		"C:\\app\\resources\\extensions\\pi-deck-plan-mode.ts",
	]);
	sameArgs(next, [
		"--mode",
		"rpc",
		"--extension",
		"C:\\app\\resources\\extensions\\pi-deck-todo.ts",
		"--extension",
		"C:\\app\\resources\\extensions\\pi-deck-plan-mode.ts",
	]);
});

test("appendBuiltInExtensionArgs skips when noExtensions is true", () => {
	const { appendBuiltInExtensionArgs } = loadBuiltInExtensionsModule();
	const next = appendBuiltInExtensionArgs(["--mode", "rpc", "--no-extensions"], [
		"/tmp/pi-deck-todo.ts",
	], { noExtensions: true });
	sameArgs(next, ["--mode", "rpc", "--no-extensions"]);
});

test("listActiveBuiltInExtensionPaths respects removedBuiltIn and missing files", () => {
	const { listActiveBuiltInExtensionPaths, BUILT_IN_EXTENSIONS } = loadBuiltInExtensionsModule();
	const root = mkdtempSync(join(tmpdir(), "pideck-builtin-ext-"));
	const extDir = join(root, "resources", "extensions");
	mkdirSync(extDir, { recursive: true });
	// 只写入 ask + todo，故意不写 plan/nul，验证缺失跳过
	writeFileSync(join(extDir, "pideck-q-ask-question.ts"), "// ask\n", "utf8");
	writeFileSync(join(extDir, "pi-deck-todo.ts"), "// todo\n", "utf8");

	try {
		const paths = listActiveBuiltInExtensionPaths(
			{ appPath: root, resourcesPath: root, isDev: true },
			["pi-deck-todo.ts"],
		);
		assert.equal(paths.length, 1);
		assert.ok(String(paths[0]).endsWith("pideck-q-ask-question.ts"));
		// 内置扩展清单随版本增长：ask/context-controller/nul-redirect/plan-mode/security-gate/todo/vision/websearch/better-compaction
		assert.equal(BUILT_IN_EXTENSIONS.length, 9);
		assert.ok(BUILT_IN_EXTENSIONS.includes("pideck-q-context-controller.ts"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("pideck-q-websearch is packaged as a default-disabled built-in", () => {
	const { BUILT_IN_EXTENSIONS, DEFAULT_DISABLED_BUILT_IN_EXTENSIONS } = loadBuiltInExtensionsModule();
	assert.ok(BUILT_IN_EXTENSIONS.includes("pideck-q-websearch.ts"));
	assert.ok(DEFAULT_DISABLED_BUILT_IN_EXTENSIONS.includes("pideck-q-websearch.ts"));
	assert.match(
		readFileSync("resources/extensions/pideck-q-websearch.ts", "utf8"),
		/pideck-q-websearch\/extension-runtime\.ts/,
	);
	assert.ok(
		readFileSync("resources/extensions/pideck-q-websearch/extension-runtime.ts", "utf8").includes(
			"name: \"web_search\"",
		),
	);
});

test("pideck-q-better-compaction is packaged as a built-in and disabled by default", () => {
	const { BUILT_IN_EXTENSIONS, DEFAULT_DISABLED_BUILT_IN_EXTENSIONS } = loadBuiltInExtensionsModule();
	assert.ok(BUILT_IN_EXTENSIONS.includes("pideck-q-better-compaction.ts"));
	assert.ok(DEFAULT_DISABLED_BUILT_IN_EXTENSIONS.includes("pideck-q-better-compaction.ts"));
	assert.match(
		readFileSync("src/main/settings/SettingsStore.ts", "utf8"),
		/removedBuiltInExtensions:\s*\[\.\.\.DEFAULT_DISABLED_BUILT_IN_EXTENSIONS\]/,
	);
	assert.ok(readFileSync("resources/extensions/pideck-q-better-compaction.ts", "utf8").includes("extension-runtime.ts"));
	assert.match(
		readFileSync("resources/extensions/pideck-q-better-compaction/types.ts", "utf8"),
		/EXTENSION_ID = "PiDeck-Q-Better-Compaction"/,
	);
});

test("default-disabled built-in migration is one-time and preserves a later restore", () => {
	const {
		BUILT_IN_EXTENSION_DEFAULTS_VERSION,
		migrateBuiltInExtensionDefaults,
	} = loadBuiltInExtensionsModule();
	const migrated = migrateBuiltInExtensionDefaults(["pi-deck-todo.ts"], undefined);
	assert.equal(migrated.migrated, true);
	assert.equal(migrated.removedBuiltInExtensions.includes("pideck-q-better-compaction.ts"), true);
	assert.equal(migrated.removedBuiltInExtensions.includes("pideck-q-websearch.ts"), true);

	const upgraded = migrateBuiltInExtensionDefaults([], 1);
	assert.equal(upgraded.migrated, true);
	assert.equal(upgraded.removedBuiltInExtensions.includes("pideck-q-websearch.ts"), true);
	assert.equal(upgraded.removedBuiltInExtensions.includes("pideck-q-better-compaction.ts"), false);

	const restored = migrateBuiltInExtensionDefaults([], BUILT_IN_EXTENSION_DEFAULTS_VERSION);
	assert.equal(restored.migrated, false);
	assert.equal(JSON.stringify(restored.removedBuiltInExtensions), "[]");
});

test("renamed built-ins preserve legacy disabled choices", () => {
	const {
		BUILT_IN_EXTENSION_DEFAULTS_VERSION,
		LEGACY_BUILT_IN_EXTENSION_NAMES,
		migrateBuiltInExtensionDefaults,
	} =
		loadBuiltInExtensionsModule();
	const migrated = migrateBuiltInExtensionDefaults(
		[
			"pi-deck-ask-question.ts",
			"pi-deck-context-controller.ts",
			"pi-deck-websearch.ts",
			"pi-better-compaction.ts",
		],
		BUILT_IN_EXTENSION_DEFAULTS_VERSION,
	);
	assert.equal(migrated.migrated, true);
	assert.deepEqual(
		[...migrated.removedBuiltInExtensions].sort(),
		[
			"pideck-q-ask-question.ts",
			"pideck-q-better-compaction.ts",
			"pideck-q-context-controller.ts",
			"pideck-q-websearch.ts",
		],
	);
	assert.deepEqual(
		[...LEGACY_BUILT_IN_EXTENSION_NAMES].sort(),
		[
			"pi-better-compaction.ts",
			"pi-deck-ask-question.ts",
			"pi-deck-context-controller.ts",
			"pi-deck-websearch.ts",
		],
	);
});

test("built-in extension removal has a registered IPC handler", () => {
	const storeIpc = readFileSync("src/main/ipc/storeIpc.ts", "utf8");
	const extensionsTab = readFileSync("src/renderer/src/config/ExtensionsTab.tsx", "utf8");
	assert.match(storeIpc, /ipcChannels\.extensionsRemoveBuiltIn[\s\S]*extensionManager\.removeBuiltIn\(source\)/);
	assert.match(storeIpc, /ipcChannels\.extensionsRestoreBuiltIn[\s\S]*extensionManager\.restoreBuiltIn\(source\)/);
	assert.match(extensionsTab, /extension\.enabled === false/);
	assert.match(extensionsTab, /config\.enableExtension/);
	assert.match(
		extensionsTab,
		/"pideck-q-ask-question\.ts": "PiDeck-Q-Ask-Question"/,
	);
});

test("AgentManager no longer deploys built-ins via ensurePiDeckExtension", () => {
	const startupTasks = readFileSync("src/main/backend/backendStartupTasks.ts", "utf8");
	const storeIpc = readFileSync("src/main/ipc/storeIpc.ts", "utf8");
	const processSource = readFileSync("src/main/pi/PiProcess.ts", "utf8");
	assert.doesNotMatch(startupTasks, /async function ensurePiDeckExtension/);
	assert.doesNotMatch(storeIpc, /ensurePiDeckExtension/);
	assert.match(startupTasks, /migrateLegacyBuiltInExtensions/);
	assert.match(startupTasks, /\.\.\.LEGACY_BUILT_IN_EXTENSION_NAMES/);
	assert.match(processSource, /appendBuiltInExtensionArgs/);
	assert.match(processSource, /--extension/);
});

test("main uses the already-eager built-in extension catalog without a fake dynamic import", () => {
	const startupTasks = readFileSync("src/main/backend/backendStartupTasks.ts", "utf8");
	assert.match(
		startupTasks,
		/import \{[\s\S]*?BUILT_IN_EXTENSIONS,[\s\S]*?\} from "\.\.\/extensions\/builtInExtensions"/,
	);
	assert.doesNotMatch(startupTasks, /await import\("\.\/extensions\/builtInExtensions"\)/);
});
