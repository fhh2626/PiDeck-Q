import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function loadProjectsIpc() {
	const ipcChannels = loadSharedIpc();
	const wslPaths = loadWslPaths();
	const sandbox = {
		exports: {},
		require: (id) => {
			if (id === "../../shared/ipc" || id.endsWith("/shared/ipc")) return ipcChannels;
			if (id === "../wsl/WslPaths" || id.endsWith("/wsl/WslPaths")) return wslPaths;
			if (id === "../wsl/WslEnvironment" || id.endsWith("/wsl/WslEnvironment")) {
				return {
					resolveWslEnvironment: async (distro, user) => ({
						distro,
						user,
						linuxHome: user === "root" ? "/root" : `/home/${user}`,
						windowsHome: `\\\\wsl.localhost\\${distro}\\${user === "root" ? "root" : `home\\${user}`}`,
					}),
				};
			}
			if (id === "./projectResourceIpc") {
				return { registerProjectResourceIpc: () => {} };
			}
			return require(id);
		},
	};
	vm.runInNewContext(transpile("src/main/ipc/projectsIpc.ts"), sandbox, { filename: "projectsIpc.ts" });
	return sandbox.exports;
}

function loadSharedIpc() {
	const sandbox = { exports: {}, require };
	vm.runInNewContext(transpile("src/shared/ipc.ts"), sandbox, { filename: "ipc.ts" });
	return sandbox.exports;
}

function loadWslPaths() {
	const sandbox = { exports: {}, require };
	vm.runInNewContext(transpile("src/main/wsl/WslPaths.ts"), sandbox, { filename: "WslPaths.ts" });
	return sandbox.exports;
}

const { registerProjectsIpc } = loadProjectsIpc();
const { ipcChannels } = loadSharedIpc();

function createFakeRouter() {
	const handlers = new Map();
	return {
		handlers,
		handle: (channel, fn) => handlers.set(channel, fn),
		invoke: (channel, ...args) => {
			const fn = handlers.get(channel);
			if (!fn) throw new Error(`No handler for ${channel}`);
			return fn(...args);
		},
	};
}

test("Projects IPC: projectsAdd opens dialog with WSL home defaultPath and canonicalizes selection", async () => {
	const router = createFakeRouter();
	const dialogCalls = [];
	const dialogs = {
		showOpenDialog: async (opts) => {
			dialogCalls.push(opts);
			return {
				canceled: false,
				filePaths: ["//wsl.localhost/Ubuntu-24.04/root/ba_cli/"],
			};
		},
		showSaveDialog: async () => ({ canceled: true }),
	};

	let addedArgs = [];
	const projectStore = {
		list: () => [],
		add: async (...args) => {
			addedArgs = args;
			return { id: "p1", path: args[0], environment: args[2] };
		},
		getChatProjectPath: () => "C:/userData/chat-workspace",
		setChatProjectPath: async (p) => ({ id: "chat", path: p }),
	};

	const settingsStore = {
		get: () => ({
			wslEnabled: true,
			wslDistro: "Ubuntu-24.04",
			wslUser: "root",
		}),
	};

	registerProjectsIpc(router, {
		projectStore,
		settingsStore,
		gitService: {},
		worktreeService: {},
		agentManager: { hasAgentForProject: () => false },
		appLogger: { info: () => {}, error: () => {}, warn: () => {} },
		projectResourceManager: {},
		mainCopy: (k) => k,
		dialogs,
		sendToRenderer: () => {},
	});

	const project = await router.invoke(ipcChannels.projectsAdd);

	assert.equal(dialogCalls.length, 1);
	// 计划 43 节：dialog options 必须与旧 ProjectStore.chooseAndAdd 逐字一致。
	assert.equal(dialogCalls[0].title, "dialog.chooseProjectFolder");
	assert.equal(dialogCalls[0].defaultPath, "\\\\wsl.localhost\\Ubuntu-24.04\\root");
	assert.deepEqual(Array.from(dialogCalls[0].properties), ["openDirectory"]);
	// 旧实现未传 parent（无 BrowserWindow parent），迁移后不得擅自 parent 到主窗口。
	assert.equal(dialogCalls[0].parent, undefined);
	assert.equal(project.path, "\\\\wsl.localhost\\Ubuntu-24.04\\root\\ba_cli");
	assert.equal(addedArgs[2], "wsl");
});

test("Projects IPC: projectsAdd rejects a project from another WSL distro before adding it", async () => {
	const router = createFakeRouter();
	const dialogs = {
		showOpenDialog: async () => ({
			canceled: false,
			filePaths: ["\\\\wsl.localhost\\Debian\\root\\ba_cli"],
		}),
		showSaveDialog: async () => ({ canceled: true }),
	};

	let addCalled = false;
	const projectStore = {
		list: () => [],
		add: async () => {
			addCalled = true;
		},
	};

	const settingsStore = {
		get: () => ({
			wslEnabled: true,
			wslDistro: "Ubuntu-24.04",
			wslUser: "root",
		}),
	};

	registerProjectsIpc(router, {
		projectStore,
		settingsStore,
		gitService: {},
		worktreeService: {},
		agentManager: { hasAgentForProject: () => false },
		appLogger: { info: () => {}, error: () => {}, warn: () => {} },
		projectResourceManager: {},
		mainCopy: (k) => k,
		dialogs,
		sendToRenderer: () => {},
	});

	await assert.rejects(
		() => router.invoke(ipcChannels.projectsAdd),
		(err) => err.code === "WSL_DISTRO_MISMATCH",
	);
	assert.equal(addCalled, false);
});

test("Projects IPC: dialog cancel returns null and chat path operations notify renderer", async () => {
	const router = createFakeRouter();
	let dialogResult = { canceled: true, filePaths: [] };
	const chatDialogCalls = [];
	let addDialogOptions;
	const dialogs = {
		showOpenDialog: async (opts) => {
			if (addDialogOptions === undefined) {
				// 第一次调用来自 projectsAdd
				addDialogOptions = opts;
			} else {
				chatDialogCalls.push(opts);
			}
			return dialogResult;
		},
		showSaveDialog: async () => ({ canceled: true }),
	};

	let chatPathSaved = "";
	const projectStore = {
		list: () => [{ id: "builtin-chat", kind: "chat", path: "C:/chat" }],
		add: async () => ({ id: "p1" }),
		getChatProjectPath: () => "C:/chat",
		setChatProjectPath: async (p) => {
			chatPathSaved = p;
			return { id: "builtin-chat", path: p };
		},
	};

	const broadcastEvents = [];
	const sendToRenderer = (channel, ...args) => {
		broadcastEvents.push({ channel, args });
	};

	registerProjectsIpc(router, {
		projectStore,
		settingsStore: { get: () => ({ wslEnabled: false }) },
		gitService: {},
		worktreeService: {},
		agentManager: { hasAgentForProject: () => false },
		appLogger: { info: () => {}, error: () => {}, warn: () => {} },
		projectResourceManager: {},
		mainCopy: (k) => k,
		dialogs,
		sendToRenderer,
	});

	// cancel add
	const addRes = await router.invoke(ipcChannels.projectsAdd);
	assert.equal(addRes, null);

	// choose chat path cancel
	const chooseRes = await router.invoke(ipcChannels.projectsChooseChatPath);
	assert.equal(chooseRes, null);

	// choose chat path select
	dialogResult = { canceled: false, filePaths: ["C:/new-chat"] };
	const chooseSuccess = await router.invoke(ipcChannels.projectsChooseChatPath);
	assert.equal(chooseSuccess, "C:/new-chat");

	// 计划 43 节：chat path dialog options 必须逐字段锁定（title/defaultPath/properties/parent）。
	// projectsAdd 也调用过 dialogs，因此取最后一次（即 chat path）调用的 options。
	const chatOptions = chatDialogCalls[chatDialogCalls.length - 1];
	assert.ok(chatOptions, "chat path picker must open a dialog");
	assert.equal(chatOptions.title, "dialog.chooseChatHistoryFolder");
	assert.equal(chatOptions.defaultPath, "C:/chat", "must default to the current chat workspace directory");
	assert.deepEqual(Array.from(chatOptions.properties), ["openDirectory"]);
	assert.equal(chatOptions.parent, "none", "chat path dialog must not be parented to the main window");

	// set chat path
	const setRes = await router.invoke(ipcChannels.projectsSetChatPath, "C:/new-chat");
	assert.equal(setRes.path, "C:/new-chat");
	assert.equal(chatPathSaved, "C:/new-chat");
	assert.equal(broadcastEvents.length, 1);
	assert.equal(broadcastEvents[0].channel, ipcChannels.projectsChanged);
	// 广播 payload 必须是「过滤后的可见项目列表」，而不是空对象/undefined/原始全量列表。
	assert.ok(Array.isArray(broadcastEvents[0].args[0]), "projectsChanged payload must be a project list");
	assert.equal(broadcastEvents[0].args[0].length, 1);
	assert.equal(broadcastEvents[0].args[0][0].id, "builtin-chat");
});
