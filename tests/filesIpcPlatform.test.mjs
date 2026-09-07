import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cp as realCp, rm as realRm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

function loadSharedIpc() {
	const sandbox = { exports: {}, require };
	vm.runInNewContext(transpile("src/shared/ipc.ts"), sandbox, { filename: "ipc.ts" });
	return sandbox.exports;
}

const { ipcChannels } = loadSharedIpc();

/**
 * 授权边界不是恒等函数：记录每次调用的目标路径与操作名，
 * 并返回一个与输入不同的规范化结果。这样能从行为上证明
 * 「先授权 → Shell 收到的是授权返回的 host path」，而不是碰巧相同的字符串。
 */
function createAuthorizationStub() {
	const calls = [];
	const canonicalize = (target) => target.replace(/\\/g, "/");
	const stub = {
		assertAuthorizedFilePath: (target, _roots, operation) => {
			calls.push({ target, operation });
			if (target.includes("outside")) {
				const error = new Error(`File path is not authorized for ${operation}.`);
				error.code = "FILE_PATH_NOT_AUTHORIZED";
				throw error;
			}
			return canonicalize(target);
		},
		isPathWithinAuthorizedRoots: () => true,
	};

	stub.calls = calls;
	stub.canonicalize = canonicalize;
	return stub;
}

function loadFilesIpc(authorization) {
	const ipc = loadSharedIpc();
	const sandbox = {
		exports: {},
		require: (id) => {
			if (id.includes("shared/ipc")) return ipc;
			if (id.includes("authorizedPaths")) return authorization;
			return require(id);
		},
	};
	vm.runInNewContext(transpile("src/main/ipc/filesIpc.ts"), sandbox, { filename: "filesIpc.ts" });
	return sandbox.exports;
}

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

function registerMoveRouter(root, fileOperations) {
	const authorization = createAuthorizationStub();
	const { registerFilesIpc } = loadFilesIpc(authorization);
	const router = createFakeRouter();
	registerFilesIpc(router, {
		fileSystemService: {},
		projectStore: { get: () => ({ path: root }) },
		settingsStore: { get: () => ({ wslEnabled: false }) },
		appLogger: { info: () => {}, error: () => {} },
		dialogs: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
		platformShell: { openPath: async () => ({ ok: true }), showItemInFolder: () => {} },
		getAuthorizedRoots: () => [root],
		fileOperations,
	});
	return router;
}

test("Files IPC: platformShell openPath rejection and success behavior", async () => {
	// 该用例只关注 openPath 结果语义，授权边界用透传 stub 即可。
	const { registerFilesIpc } = loadFilesIpc(createAuthorizationStub());
	const router = createFakeRouter();
	let openPathResult = { ok: true };
	let shownItem = "";

	const platformShell = {
		openPath: async () => openPathResult,
		showItemInFolder: (p) => {
			shownItem = p;
		},
	};

	let dialogPickResult = { canceled: true, filePaths: [] };
	const dialogOptions = [];
	const dialogs = {
		showOpenDialog: async (options) => {
			dialogOptions.push(options);
			return dialogPickResult;
		},
		showSaveDialog: async () => ({ canceled: true }),
	};

	registerFilesIpc(router, {
		fileSystemService: {},
		projectStore: { get: () => ({ path: "C:/project" }) },
		settingsStore: { get: () => ({ wslEnabled: false }) },
		appLogger: { info: () => {}, error: () => {} },
		dialogs,
		platformShell,
		getAuthorizedRoots: () => ["C:/project"],
	});

	// CASE 1: filesOpen resolve on ok
	openPathResult = { ok: true };
	await assert.doesNotReject(() => router.invoke(ipcChannels.filesOpen, "C:/project/file.txt"));

	// CASE 2: filesOpen throws error on { ok: false, error }
	openPathResult = { ok: false, error: "Access denied" };
	await assert.rejects(() => router.invoke(ipcChannels.filesOpen, "C:/project/file.txt"), /Access denied/);

	// CASE 3: showItemInFolder
	await router.invoke(ipcChannels.filesShowInFolder, "C:/project/file.txt");
	assert.equal(shownItem, "C:/project/file.txt");

	// CASE 4: dialogPickFiles canceled
	dialogPickResult = { canceled: true, filePaths: [] };
	const canceledFiles = await router.invoke(ipcChannels.dialogPickFiles);
	assert.equal(canceledFiles.length, 0);
	assert.deepEqual(Array.from(dialogOptions.at(-1).properties), ["openFile", "multiSelections"]);

	await router.invoke(ipcChannels.dialogPickFiles, { includeDirectories: true });
	assert.deepEqual(Array.from(dialogOptions.at(-1).properties), ["openDirectory"]);
});

test("Files IPC: shell only ever receives the authorized canonical host path", async () => {
	const authorization = createAuthorizationStub();
	const { registerFilesIpc } = loadFilesIpc(authorization);

	const router = createFakeRouter();
	const openedPaths = [];
	const shownItems = [];
	const platformShell = {
		openPath: async (p) => {
			openedPaths.push(p);
			return { ok: true };
		},
		showItemInFolder: (p) => {
			shownItems.push(p);
		},
	};

	registerFilesIpc(router, {
		fileSystemService: {},
		projectStore: { get: () => ({ path: "C:\\project" }) },
		// wslEnabled：WSL Linux 路径必须先转成 Windows host path 再进入授权。
		settingsStore: { get: () => ({ wslEnabled: true, wslDistro: "Ubuntu-24.04" }) },
		appLogger: { info: () => {}, error: () => {} },
		dialogs: {
			showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
			showSaveDialog: async () => ({ canceled: true }),
		},
		platformShell,
		getAuthorizedRoots: () => ["C:\\project"],
	});

	// filesShowInFolder：WSL /mnt/c 输入 → Windows 盘符路径授权 → 授权返回值交给 Shell
	await router.invoke(ipcChannels.filesShowInFolder, "/mnt/c/project/file.txt");

	const showAuth = authorization.calls.find((call) => call.operation === "show-in-folder");
	assert.ok(showAuth, "authorization must run before showItemInFolder");
	assert.equal(showAuth.target, "C:\\project\\file.txt", "WSL /mnt path must be converted to the Windows host path before authorization");
	// Shell 收到的是授权函数的返回值（正斜杠规范化形态），证明不是把原始渲染层输入直接透传。
	assert.deepEqual(shownItems, [showAuth.target.replace(/\\/g, "/")]);

	// filesOpen 同样走「转换 → 授权 → 授权结果进 Shell」链路
	await router.invoke(ipcChannels.filesOpen, "/mnt/c/project/file.txt");
	const openAuth = authorization.calls.find((call) => call.operation === "open");
	assert.ok(openAuth, "authorization must run before openPath");
	assert.equal(openAuth.target, "C:\\project\\file.txt");
	assert.deepEqual(openedPaths, ["C:/project/file.txt"]);
});

test("Files IPC: copy skips an existing destination instead of overwriting it", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-files-copy-"));
	try {
		const sourceDir = join(root, "source");
		const targetDir = join(root, "target");
		mkdirSync(sourceDir);
		mkdirSync(targetDir);
		const source = join(sourceDir, "same.txt");
		const destination = join(targetDir, basename(source));
		writeFileSync(source, "source-content");
		writeFileSync(destination, "existing-content");

		const authorization = createAuthorizationStub();
		const { registerFilesIpc } = loadFilesIpc(authorization);
		const router = createFakeRouter();
		registerFilesIpc(router, {
			fileSystemService: {},
			projectStore: { get: () => ({ path: root }) },
			settingsStore: { get: () => ({ wslEnabled: false }) },
			appLogger: { info: () => {}, error: () => {} },
			dialogs: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
			platformShell: { openPath: async () => ({ ok: true }), showItemInFolder: () => {} },
			getAuthorizedRoots: () => [root],
		});

		await router.invoke(ipcChannels.filesCopy, [source], targetDir);
		assert.equal(readFileSync(destination, "utf8"), "existing-content");
		assert.equal(readFileSync(source, "utf8"), "source-content");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Files IPC: move does not copy and delete after a non-EXDEV rename failure", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-files-move-"));
	try {
		const sourceParent = join(root, "source");
		const targetDir = join(root, "target");
		const source = join(sourceParent, "same-folder");
		const destination = join(targetDir, basename(source));
		mkdirSync(source, { recursive: true });
		mkdirSync(destination, { recursive: true });
		writeFileSync(join(source, "source-only.txt"), "source");
		writeFileSync(join(destination, "target-only.txt"), "target");

		const router = registerMoveRouter(root);
		await assert.rejects(() => router.invoke(ipcChannels.filesMove, [source], targetDir));
		assert.equal(existsSync(source), true, "source must remain after a non-EXDEV failure");
		assert.equal(existsSync(join(destination, "target-only.txt")), true);
		assert.equal(existsSync(join(destination, "source-only.txt")), false, "destination must not be merged or overwritten");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Files IPC: EXDEV move refuses an existing destination file", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-files-move-exdev-file-"));
	try {
		const sourceDir = join(root, "source");
		const targetDir = join(root, "target");
		const source = join(sourceDir, "same.txt");
		const destination = join(targetDir, basename(source));
		mkdirSync(sourceDir);
		mkdirSync(targetDir);
		writeFileSync(source, "source-content");
		writeFileSync(destination, "existing-content");

		const router = registerMoveRouter(root, {
			rename: async () => {
				throw Object.assign(new Error("cross-device rename"), { code: "EXDEV" });
			},
		});
		await assert.rejects(() => router.invoke(ipcChannels.filesMove, [source], targetDir), /exist/i);
		assert.equal(readFileSync(source, "utf8"), "source-content");
		assert.equal(readFileSync(destination, "utf8"), "existing-content");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Files IPC: EXDEV move refuses an existing destination directory", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-files-move-exdev-dir-"));
	try {
		const sourceDir = join(root, "source");
		const targetDir = join(root, "target");
		const source = join(sourceDir, "same-folder");
		const destination = join(targetDir, basename(source));
		mkdirSync(source, { recursive: true });
		mkdirSync(destination, { recursive: true });
		writeFileSync(join(source, "source-only.txt"), "source");
		writeFileSync(join(destination, "target-only.txt"), "target");

		const router = registerMoveRouter(root, {
			rename: async () => {
				throw Object.assign(new Error("cross-device rename"), { code: "EXDEV" });
			},
		});
		await assert.rejects(() => router.invoke(ipcChannels.filesMove, [source], targetDir), /exist/i);
		assert.equal(existsSync(source), true);
		assert.equal(existsSync(join(destination, "source-only.txt")), false);
		assert.equal(readFileSync(join(destination, "target-only.txt"), "utf8"), "target");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Files IPC: EXDEV move keeps the source when the destination appears during copy", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-files-move-exdev-race-"));
	try {
		const sourceDir = join(root, "source");
		const targetDir = join(root, "target");
		const source = join(sourceDir, "same.txt");
		const destination = join(targetDir, basename(source));
		mkdirSync(sourceDir);
		mkdirSync(targetDir);
		writeFileSync(source, "source-content");
		let removeCalled = false;
		const router = registerMoveRouter(root, {
			rename: async () => {
				throw Object.assign(new Error("cross-device rename"), { code: "EXDEV" });
			},
			copy: async (from, to, options) => {
				writeFileSync(to, "appeared-during-copy");
				return realCp(from, to, options);
			},
			remove: async (...args) => {
				removeCalled = true;
				return realRm(...args);
			},
		});
		await assert.rejects(() => router.invoke(ipcChannels.filesMove, [source], targetDir), /exist/i);
		assert.equal(removeCalled, false, "source removal must wait for a successful copy");
		assert.equal(readFileSync(source, "utf8"), "source-content");
		assert.equal(readFileSync(destination, "utf8"), "appeared-during-copy");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Files IPC: internal copy and base64 reads reject renderer-supplied external paths", async () => {
	const authorization = createAuthorizationStub();
	const { registerFilesIpc } = loadFilesIpc(authorization);
	const router = createFakeRouter();
	let copied = false;
	registerFilesIpc(router, {
		fileSystemService: {},
		projectStore: { get: () => ({ path: "C:/project" }) },
		settingsStore: { get: () => ({ wslEnabled: false }) },
		appLogger: { info: () => {}, error: () => {} },
		dialogs: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
		platformShell: { openPath: async () => ({ ok: true }), showItemInFolder: () => {} },
		getAuthorizedRoots: () => ["C:/project"],
		fileOperations: { copy: async () => { copied = true; } },
	});
	await assert.rejects(
		() => router.invoke(ipcChannels.filesCopy, ["C:/outside/id_rsa"], "C:/project"),
		/File path is not authorized for copy-source/,
	);
	await assert.rejects(
		() => router.invoke(ipcChannels.filesReadBase64, "C:/outside/passport.png", 10 * 1024 * 1024),
		/File path is not authorized for read-base64/,
	);
	assert.equal(copied, false, "internal copy must not invoke filesystem operations for external paths");
});

test("Files IPC: external copy uses only the trusted capability paths", async () => {
	const authorization = createAuthorizationStub();
	const { registerFilesIpc } = loadFilesIpc(authorization);
	const router = createFakeRouter();
	let copiedFrom = "";
	registerFilesIpc(router, {
		fileSystemService: {},
		projectStore: { get: () => ({ path: "C:/project" }) },
		settingsStore: { get: () => ({ wslEnabled: false }) },
		appLogger: { info: () => {}, error: () => {} },
		dialogs: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
		platformShell: { openPath: async () => ({ ok: true }), showItemInFolder: () => {} },
		getAuthorizedRoots: () => ["C:/project"],
		externalFileCapabilities: {
			consumeCopy: (capabilityId) => capabilityId === "trusted-capability" ? ["C:/Users/user/.ssh/id_rsa"] : null,
			consumeRead: () => { throw new Error("not used"); },
		},
		fileOperations: {
			copy: async (source) => { copiedFrom = source; },
		},
	});
	await router.invoke(ipcChannels.filesCopyExternal, "trusted-capability", "C:/project");
	assert.equal(copiedFrom, "C:/Users/user/.ssh/id_rsa");
});

test("Files IPC: unauthorized paths are rejected before any shell side effect", async () => {
	const authorization = createAuthorizationStub();
	const { registerFilesIpc } = loadFilesIpc(authorization);

	const router = createFakeRouter();
	let openCalled = false;
	let showCalled = false;
	const platformShell = {
		openPath: async () => {
			openCalled = true;
			return { ok: true };
		},
		showItemInFolder: () => {
			showCalled = true;
		},
	};

	registerFilesIpc(router, {
		fileSystemService: {},
		projectStore: { get: () => ({ path: "C:/project" }) },
		settingsStore: { get: () => ({ wslEnabled: false }) },
		appLogger: { info: () => {}, error: () => {} },
		dialogs: {
			showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
			showSaveDialog: async () => ({ canceled: true }),
		},
		platformShell,
		getAuthorizedRoots: () => ["C:/project"],
	});

	await assert.rejects(
		() => router.invoke(ipcChannels.filesOpen, "C:/outside/file.txt"),
		/File path is not authorized for open/,
	);
	assert.equal(openCalled, false, "filesOpen must not touch the OS shell for unauthorized paths");

	await assert.rejects(
		() => router.invoke(ipcChannels.filesShowInFolder, "C:/outside/file.txt"),
		/File path is not authorized for show-in-folder/,
	);
	assert.equal(showCalled, false, "filesShowInFolder must not touch the OS shell for unauthorized paths");
});
