import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { copyFile as realCopyFile, rm as realRm } from "node:fs/promises";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
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
			if (id.includes("copyWithoutOverwrite")) return loadTsCommonJs("src/main/fs/copyWithoutOverwrite.ts");
			if (id.includes("copyToFreeName")) return loadTsCommonJs("src/main/fs/copyToFreeName.ts");
			if (id.includes("renameWithoutOverwrite")) return loadTsCommonJs("src/main/fs/renameWithoutOverwrite.ts");
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

test("Files IPC: copy into an occupied name writes a numbered copy", async () => {
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

		const copied = await router.invoke(ipcChannels.filesCopy, [source], targetDir);
		// 资源管理器语义：不静默跳过、不与已有目录合并，改用带编号的新名字
		const numbered = join(targetDir, "same (1).txt");
		assert.equal(readFileSync(destination, "utf8"), "existing-content");
		assert.equal(existsSync(numbered), true, "numbered copy must be written");
		assert.equal(readFileSync(numbered, "utf8"), "source-content");
		assert.equal(readFileSync(source, "utf8"), "source-content");
		assert.deepEqual(JSON.parse(JSON.stringify(copied)), [numbered]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Files IPC: copy refuses to copy a directory into itself", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-files-copy-self-"));
	try {
		const outer = join(root, "outer");
		const inner = join(outer, "inner");
		mkdirSync(inner, { recursive: true });
		writeFileSync(join(outer, "file.txt"), "content");

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

		// 目录复制进自身子目录会无限递归（readdir 会读到刚创建的副本）
		await assert.rejects(() => router.invoke(ipcChannels.filesCopy, [outer], inner));
		await assert.rejects(() => router.invoke(ipcChannels.filesCopy, [outer], outer));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// 移动一律走独占复制（不再区分同盘 rename / 跨设备 copy），因此只有这一条
// 「目标已存在的文件」用例；原「same-device …」与「… (exclusive copy path)」
// 两条在 A3 之后内容完全相同，已合并（H5）。
test("Files IPC: move refuses an existing destination file (exclusive copy path)", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-files-move-clobber-"));
	try {
		const sourceDir = join(root, "source");
		const targetDir = join(root, "target");
		const source = join(sourceDir, "same.txt");
		const destination = join(targetDir, "same.txt");
		mkdirSync(sourceDir);
		mkdirSync(targetDir);
		writeFileSync(source, "source-content");
		writeFileSync(destination, "existing-content");
		const router = registerMoveRouter(root);
		await assert.rejects(() => router.invoke(ipcChannels.filesMove, [source], targetDir), /exist/i);
		assert.equal(readFileSync(source, "utf8"), "source-content", "失败的移动不得动到源文件");
		assert.equal(readFileSync(destination, "utf8"), "existing-content", "已有目标不得被覆盖");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Files IPC: move refuses to merge an existing destination directory", async () => {
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
		assert.equal(existsSync(source), true, "source must remain when the destination exists");
		assert.equal(existsSync(join(destination, "target-only.txt")), true);
		assert.equal(existsSync(join(destination, "source-only.txt")), false, "destination must not be merged or overwritten");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Files IPC: dialog:pick-images handles cancel, selection, and >16 limits", async () => {
	const authorization = createAuthorizationStub();
	const { registerFilesIpc } = loadFilesIpc(authorization);
	const router = createFakeRouter();

	let dialogResult = { canceled: true, filePaths: [] };
	const fakeDialogs = {
		showOpenDialog: async (options) => {
			assert.equal(options.parent, "none");
			assert.deepEqual(JSON.parse(JSON.stringify(options.properties)), ["openFile", "multiSelections"]);
			assert.deepEqual(JSON.parse(JSON.stringify(options.filters)), [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }]);
			return dialogResult;
		},
	};

	let issuedPaths = null;
	const fakeCapabilities = {
		consumeCopy: () => [],
		consumeRead: () => "",
		issuePicker: (paths) => {
			issuedPaths = paths;
			return "test-picker-cap-id";
		},
	};

	registerFilesIpc(router, {
		fileSystemService: {},
		projectStore: { get: () => ({ path: "C:/project" }) },
		settingsStore: {},
		appLogger: { info: () => {}, error: () => {} },
		dialogs: fakeDialogs,
		platformShell: {},
		getAuthorizedRoots: () => ["C:/project"],
		externalFileCapabilities: fakeCapabilities,
	});

	// 1. 取消
	const cancelled = await router.invoke(ipcChannels.dialogPickImages);
	assert.deepEqual(JSON.parse(JSON.stringify(cancelled)), { kind: "cancelled" });

	// 2. 正常选图
	dialogResult = { canceled: false, filePaths: ["C:/a.png", "C:/b.jpg", "C:/a.png"] }; // 含重复
	const selected = await router.invoke(ipcChannels.dialogPickImages);
	assert.equal(selected.kind, "selected");
	assert.equal(selected.capabilityId, "test-picker-cap-id");
	assert.deepEqual(JSON.parse(JSON.stringify(selected.paths)), ["C:/a.png", "C:/b.jpg"]); // 已经保序去重
	assert.deepEqual(JSON.parse(JSON.stringify(issuedPaths)), ["C:/a.png", "C:/b.jpg"]);

	// 3. 选图超过 16 张
	const seventeenPaths = Array.from({ length: 17 }, (_, i) => `C:/img-${i}.png`);
	dialogResult = { canceled: false, filePaths: seventeenPaths };
	const tooMany = await router.invoke(ipcChannels.dialogPickImages);
	assert.deepEqual(JSON.parse(JSON.stringify(tooMany)), { kind: "error", code: "TOO_MANY_FILES" });
});

test("Files IPC: move keeps the source when the destination appears at the copy primitive", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-files-move-race-"));
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
			copyFile: async (from, to, mode) => {
				writeFileSync(to, "appeared-during-copy");
				return realCopyFile(from, to, mode);
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
	registerFilesIpc(router, {
		fileSystemService: {},
		projectStore: { get: () => ({ path: "C:/project" }) },
		settingsStore: { get: () => ({ wslEnabled: false }) },
		appLogger: { info: () => {}, error: () => {} },
		dialogs: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
		platformShell: { openPath: async () => ({ ok: true }), showItemInFolder: () => {} },
		getAuthorizedRoots: () => ["C:/project"],
	});
	await assert.rejects(
		() => router.invoke(ipcChannels.filesCopy, ["C:/outside/id_rsa"], "C:/project"),
		/File path is not authorized for copy-source/,
	);
	await assert.rejects(
		() => router.invoke(ipcChannels.filesReadBase64, "C:/outside/passport.png", 10 * 1024 * 1024),
		/File path is not authorized for read-base64/,
	);
});

test("Files IPC: external copy uses only the trusted capability paths", async () => {
	const authorization = createAuthorizationStub();
	const { registerFilesIpc } = loadFilesIpc(authorization);
	const router = createFakeRouter();
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
	});
	// 授权后的能力路径会真正进入复制流程；测试只关心授权来源，用不存在的路径验证已不再被授权层拦下。
	await assert.rejects(
		() => router.invoke(ipcChannels.filesCopyExternal, "trusted-capability", "C:/project"),
		(error) => !String(error?.message ?? error).includes("not authorized"),
	);
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
