import test from "node:test";
import assert from "node:assert/strict";
import { createTrashPath } from "../src/main/fs/trash.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import ts from "typescript";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function loadTranspiledModule(filePath, overrides = new Map()) {
	const source = ts.sys.readFile(filePath, "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = {
		clearTimeout,
		exports: {},
		process,
		require: (id) => overrides.has(id) ? overrides.get(id) : require(id),
		setTimeout,
	};
	vm.runInNewContext(outputText, sandbox, { filename: filePath });
	return sandbox.exports;
}

test("buildProtocolToastXml escapes XML characters and formats protocol URL", () => {
	const { buildProtocolToastXml } = loadTranspiledModule("src/main/platform/electron/ElectronNotifications.ts", new Map([
		["electron", { Notification: class {} }],
	]));
	const xml = buildProtocolToastXml('Title <&>"', 'Body <&>"', 'pideck://session/123?a=1&b="2"');
	assert.match(xml, /<text>Title &lt;&amp;&gt;&quot;<\/text>/);
	assert.match(xml, /<text>Body &lt;&amp;&gt;&quot;<\/text>/);
	assert.match(xml, /launch="pideck:\/\/session\/123\?a=1&amp;b=&quot;2&quot;"/);
	assert.match(xml, /activationType="protocol"/);

	const defaultXml = buildProtocolToastXml("Title", "Body");
	assert.match(defaultXml, /launch="pideck:\/\/"/);
});

test("SessionScanner throws error on delete when TrashPath is not available", async () => {
	const fsRetry = loadTranspiledModule("src/main/utils/fsRetry.ts");
	const hostInstruction = loadTranspiledModule("src/main/pi/hostInstruction.ts");
	const messageContent = loadTranspiledModule("src/main/pi/messageContent.ts", new Map([
		["./hostInstruction", hostInstruction],
	]));
	const codexMeta = loadTranspiledModule("src/shared/codexSessionMeta.ts");
	const sessionSummaryCache = loadTranspiledModule("src/main/sessions/sessionSummaryCache.ts", new Map([
		["../utils/fsRetry", fsRetry],
	]));
	const wslPaths = loadTranspiledModule("src/main/wsl/WslPaths.ts");
	const sharedLogger = loadTranspiledModule("src/main/logging/sharedLogger.ts");
	const sessionNameLine = loadTranspiledModule("src/main/sessions/sessionNameLine.ts");
	const piCompatibility = loadTranspiledModule("src/shared/piCompatibility.ts");
	const overrides = new Map([
		["../../shared/codexSessionMeta", codexMeta],
		["../pi/messageContent", messageContent],
		["./sessionSummaryCache", sessionSummaryCache],
		["../wsl/WslPaths", wslPaths],
		["../logging/sharedLogger", sharedLogger],
		["./sessionNameLine", sessionNameLine],
		["../../shared/piCompatibility", piCompatibility],
		["../../shared/i18n/mainProcessCopy", { mainProcessT: () => "test" }],
	]);
	const { SessionScanner } = loadTranspiledModule("src/main/sessions/SessionScanner.ts", overrides);

	const tempDir = await mkdtemp(join(tmpdir(), "pideck-test-session-"));
	const sessionFile = join(tempDir, "existing-session.jsonl");
	await writeFile(sessionFile, '{"role":"user","content":"hi"}\n', "utf8");

	try {
		const scanner = new SessionScanner(
			() => "test",
			tempDir,
			undefined, // no trashPath
			tempDir,
		);

		await assert.rejects(
			() => scanner.delete(sessionFile),
			/Trash service unavailable/,
		);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("PromptManager and SkillManager call openPath when provided", async () => {
	const { PromptManager } = loadTranspiledModule("src/main/prompts/PromptManager.ts");
	const { SkillManager } = loadTranspiledModule("src/main/skills/SkillManager.ts");

	const tempHome = await mkdtemp(join(tmpdir(), "pideck-test-home-"));
	try {
		let promptOpened = "";
		const promptManager = new PromptManager(
			tempHome,
			() => "test",
			() => ({}),
			async () => {},
			{
				openPath: async (p) => {
					promptOpened = p;
					return { ok: true };
				},
				trashPath: createTrashPath({ trashItem: async () => {} }),
			},
		);

		await promptManager.openFolder();
		assert.match(promptOpened, /prompts/);

		let skillOpened = "";
		const skillManager = new SkillManager(
			tempHome,
			() => "test",
			{
				openPath: async (p) => {
					skillOpened = p;
					return { ok: true };
				},
				trashPath: createTrashPath({ trashItem: async () => {} }),
			},
		);

		await skillManager.openFolder();
		assert.match(skillOpened, /skills/);
	} finally {
		await rm(tempHome, { recursive: true, force: true });
	}
});

test("SessionSummaryCache writes to injected userDataDir", async () => {
	const fsRetry = loadTranspiledModule("src/main/utils/fsRetry.ts");
	const { SessionSummaryCache } = loadTranspiledModule("src/main/sessions/sessionSummaryCache.ts", new Map([
		["../utils/fsRetry", fsRetry],
	]));

	const tempUserDir = await mkdtemp(join(tmpdir(), "pideck-test-cache-"));
	try {
		const cache = new SessionSummaryCache("test-cache.json", tempUserDir);
		cache.set("/some/file.jsonl", { mtimeMs: 1000, size: 200 }, { id: "test" });
		await cache.flush();
		const { existsSync } = await import("node:fs");
		assert.equal(existsSync(join(tempUserDir, "test-cache.json")), true);
	} finally {
		await rm(tempUserDir, { recursive: true, force: true });
	}
});

test("ElectronDialogs forwards parent window when valid and falls back without window", async () => {
	let dialogCalls = [];
	const mockElectron = {
		dialog: {
			showOpenDialog: async (winOrOpts, maybeOpts) => {
				dialogCalls.push({ winOrOpts, maybeOpts });
				return { canceled: false, filePaths: ["/selected/path"] };
			},
			showSaveDialog: async (winOrOpts, maybeOpts) => {
				dialogCalls.push({ winOrOpts, maybeOpts });
				return { canceled: false, filePath: "/saved/path" };
			},
		},
	};

	const { ElectronDialogs } = loadTranspiledModule("src/main/platform/electron/ElectronDialogs.ts", new Map([
		["electron", mockElectron],
	]));

	const fakeWin = { isDestroyed: () => false };
	const dialogsWithWin = new ElectronDialogs(() => fakeWin);

	// Case 1: parent === "main-window" and win is valid
	const res1 = await dialogsWithWin.showOpenDialog({ parent: "main-window", title: "Select" });
	assert.equal(res1.filePaths[0], "/selected/path");
	assert.equal(dialogCalls[0].winOrOpts, fakeWin);

	// Case 2: parent === "main-window" but win is null
	dialogCalls = [];
	const dialogsWithoutWin = new ElectronDialogs(() => null);
	const res2 = await dialogsWithoutWin.showOpenDialog({ parent: "main-window", title: "Select" });
	assert.equal(res2.filePaths[0], "/selected/path");
	assert.equal(dialogCalls[0].maybeOpts, undefined);

	// Case 3: parent === "main-window" but window is destroyed → must fall back, never throw（计划 36.1）
	dialogCalls = [];
	const destroyedWin = { isDestroyed: () => true };
	const dialogsWithDestroyed = new ElectronDialogs(() => destroyedWin);
	const res3 = await dialogsWithDestroyed.showOpenDialog({ parent: "main-window", title: "Select" });
	assert.equal(res3.filePaths[0], "/selected/path");
	assert.notEqual(dialogCalls[0].winOrOpts, destroyedWin);
	assert.equal(dialogCalls[0].maybeOpts, undefined);
});

test("ElectronDialogs forwards full DTO fields to Electron options", async () => {
	let openOptions;
	let saveOptions;
	const mockElectron = {
		dialog: {
			showOpenDialog: async (opts) => {
				openOptions = opts;
				return { canceled: false, filePaths: ["/picked"] };
			},
			showSaveDialog: async (opts) => {
				saveOptions = opts;
				return { canceled: false, filePath: "/saved/path" };
			},
		},
	};
	const { ElectronDialogs } = loadTranspiledModule("src/main/platform/electron/ElectronDialogs.ts", new Map([
		["electron", mockElectron],
	]));
	const adapter = new ElectronDialogs(() => null);

	const filters = [{ name: "Images", extensions: ["png", "jpg"] }];
	const properties = ["openFile", "multiSelections"];
	await adapter.showOpenDialog({
		title: "Pick images",
		defaultPath: "C:/Users/me/Pictures",
		filters,
		properties,
		parent: "none",
	});
	assert.equal(openOptions.title, "Pick images");
	assert.equal(openOptions.defaultPath, "C:/Users/me/Pictures");
	assert.equal(openOptions.filters, filters);
	assert.deepEqual(Array.from(openOptions.properties), properties);

	await adapter.showSaveDialog({
		title: "Save file",
		defaultPath: "C:/Users/me/Downloads/out.md",
		filters,
		parent: "none",
	});
	assert.equal(saveOptions.title, "Save file");
	assert.equal(saveOptions.defaultPath, "C:/Users/me/Downloads/out.md");
	assert.equal(saveOptions.filters, filters);
});

test("ElectronProxy applies session proxy before app proxy", async () => {
	const order = [];
	const mockElectron = {
		session: {
			defaultSession: {
				setProxy: async (cfg) => {
					order.push({ target: "session", cfg });
				},
			},
		},
		app: {
			setProxy: async (cfg) => {
				order.push({ target: "app", cfg });
			},
		},
	};

	const { ElectronProxy } = loadTranspiledModule("src/main/platform/electron/ElectronProxy.ts", new Map([
		["electron", mockElectron],
	]));

	const proxy = new ElectronProxy();
	await proxy.apply({ proxyRules: "http://127.0.0.1:8080" });

	assert.equal(order.length, 2);
	assert.equal(order[0].target, "session");
	assert.equal(order[0].cfg.proxyRules, "http://127.0.0.1:8080");
	assert.equal(order[1].target, "app");
	assert.equal(order[1].cfg.proxyRules, "http://127.0.0.1:8080");
});

test("ElectronShell maps openPath result strings and delegates other operations", async () => {
	const calls = [];
	const mockShell = {
		openExternal: async (url) => {
			calls.push({ op: "openExternal", url });
		},
		// Electron 约定：成功返回空字符串，失败返回错误字符串。
		openPath: async (p) => (p.includes("missing") ? "Path not found" : ""),
		showItemInFolder: (p) => {
			calls.push({ op: "showItemInFolder", path: p });
		},
		trashItem: async (p) => {
			calls.push({ op: "trashItem", path: p });
		},
	};
	const { ElectronShell } = loadTranspiledModule("src/main/platform/electron/ElectronShell.ts", new Map([
		["electron", { shell: mockShell }],
	]));
	const shell = new ElectronShell();

	const okResult = await shell.openPath("C:/existing/folder");
	// 跨 realm 对象不能用 deepEqual（原型不同）；逐字段断言。
	assert.equal(okResult.ok, true, "empty openPath string must map to ok:true");

	const failResult = await shell.openPath("C:/missing/folder");
	assert.equal(failResult.ok, false, "error string must map to ok:false");
	assert.equal(failResult.error, "Path not found");

	await shell.openExternal("https://example.com");
	shell.showItemInFolder("C:/existing/file.txt");
	await shell.trashItem("C:/obsolete.txt");
	assert.deepEqual(calls, [
		{ op: "openExternal", url: "https://example.com" },
		{ op: "showItemInFolder", path: "C:/existing/file.txt" },
		{ op: "trashItem", path: "C:/obsolete.txt" },
	]);
});

test("ElectronApplication forwards app metadata and swallows getPreferredSystemLanguages failures", () => {
	let menuSetTo = "unset";
	const fakeApp = {
		getName: () => "PiDeck",
		getVersion: () => "9.9.9",
		isPackaged: true,
		getLocale: () => "zh-CN",
		getPreferredSystemLanguages: () => {
			throw new Error("not available on this platform");
		},
	};
	const mockElectron = {
		app: fakeApp,
		Menu: {
			setApplicationMenu: (menu) => {
				menuSetTo = menu;
			},
		},
	};
	const { ElectronApplication } = loadTranspiledModule(
		"src/main/platform/electron/ElectronApplication.ts",
		new Map([["electron", mockElectron]]),
	);
	const application = new ElectronApplication();

	assert.equal(application.name, "PiDeck");
	assert.equal(application.version, "9.9.9");
	assert.equal(application.isPackaged, true);
	assert.equal(application.getLocale(), "zh-CN");
	// 平台不支持时必须回退为空数组而不是抛出（计划 3.2 节 adapter 契约）。
	const languages = application.getPreferredSystemLanguages();
	assert.ok(Array.isArray(languages), "must return an array on unsupported platforms");
	assert.equal(languages.length, 0);

	application.hideApplicationMenu();
	assert.equal(menuSetTo, null, "hideApplicationMenu must call Menu.setApplicationMenu(null)");
});

