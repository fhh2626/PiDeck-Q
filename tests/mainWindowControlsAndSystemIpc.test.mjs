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

function loadSharedIpc() {
	const sandbox = { exports: {}, require };
	vm.runInNewContext(transpile("src/shared/ipc.ts"), sandbox, { filename: "ipc.ts" });
	return sandbox.exports;
}

const { ipcChannels } = loadSharedIpc();

function loadMainWindowControls() {
	const ipc = loadSharedIpc();
	const sandbox = {
		exports: {},
		require: (id) => {
			if (id.includes("shared/ipc")) return ipc;
			if (id.includes("devTools")) return { toggleMainWindowDevTools: () => {} };
			return require(id);
		},
	};
	vm.runInNewContext(transpile("src/main/window/MainWindowControls.ts"), sandbox, { filename: "MainWindowControls.ts" });
	return sandbox.exports;
}

const { createElectronMainWindowControls } = loadMainWindowControls();

test("MainWindowControls behavior when no window exists", () => {
	const controls = createElectronMainWindowControls(() => null);
	assert.equal(controls.isMaximized(), false);
	assert.equal(controls.toggleMaximize(), false);
	assert.equal(controls.toggleAlwaysOnTop(), false);
	assert.equal(controls.isMinimized(), false);
	assert.equal(controls.isVisible(), false);
	assert.equal(controls.isDestroyed(), true);
	assert.equal(controls.getWindowState().isMaximized, false);
	assert.equal(controls.getWindowState().isMinimized, false);
	assert.equal(controls.getWindowState().isFullScreen, false);
	assert.doesNotThrow(() => {
		controls.minimize();
		controls.maximize();
		controls.unmaximize();
		controls.close();
		controls.reload();
		controls.focus();
		controls.restore();
		controls.show();
		controls.setZoomFactor(1.2);
		controls.notifyTitleBarChange({});
		controls.toggleDevTools();
	});
});

test("MainWindowControls tracks maximization intent across events and state queries", () => {
	let maximized = false;
	const events = new Map();
	const fakeWin = {
		isDestroyed: () => false,
		isMaximized: () => maximized,
		isMinimized: () => false,
		isFullScreen: () => false,
		isAlwaysOnTop: () => false,
		maximize: () => {
			maximized = true;
		},
		unmaximize: () => {
			maximized = false;
		},
		setAlwaysOnTop: () => {},
		on: (event, handler) => events.set(event, handler),
		webContents: {
			send: () => {},
			setZoomFactor: () => {},
		},
	};

	const emittedStates = [];
	const controls = createElectronMainWindowControls(
		() => fakeWin,
		(channel, val) => {
			if (channel === ipcChannels.appWindowMaximizedChanged) {
				emittedStates.push(val);
			}
		},
	);

	// Toggle to maximize
	const res1 = controls.toggleMaximize();
	assert.equal(res1, true);
	assert.equal(controls.isMaximized(), true);
	assert.deepEqual(emittedStates, [true]);

	// Toggle to unmaximize
	const res2 = controls.toggleMaximize();
	assert.equal(res2, false);
	assert.equal(controls.isMaximized(), false);
	assert.deepEqual(emittedStates, [true, false]);
});

function createFakeWindow({ isMaximizedAlwaysFalse = false } = {}) {
	const calls = { maximize: 0, unmaximize: 0, setZoomFactor: [], setAlwaysOnTop: [], reload: 0 };
	const events = new Map();
	let maximized = false;
	const win = {
		isDestroyed: () => false,
		isMaximized: () => (isMaximizedAlwaysFalse ? false : maximized),
		isMinimized: () => false,
		isFullScreen: () => false,
		isVisible: () => true,
		isAlwaysOnTop: () => false,
		maximize: () => {
			calls.maximize += 1;
			maximized = true;
		},
		unmaximize: () => {
			calls.unmaximize += 1;
			maximized = false;
		},
		minimize: () => {},
		restore: () => {},
		show: () => {},
		focus: () => {},
		close: () => {},
		setAlwaysOnTop: (next) => {
			calls.setAlwaysOnTop.push(next);
		},
		on: (event, handler) => {
			events.set(event, handler);
		},
		webContents: {
			send: () => {},
			setZoomFactor: (v) => {
				calls.setZoomFactor.push(v);
			},
			reload: () => {
				calls.reload += 1;
			},
		},
	};
	return {
		win,
		calls,
		fireMaximize: () => events.get("maximize")?.(),
		fireUnmaximize: () => events.get("unmaximize")?.(),
	};
}

test("MainWindowControls survives Windows borderless maximize lag (isMaximized stays false)", () => {
	// Windows 无边框窗口场景：调用 maximize() 后 isMaximized() 短时间仍返回 false。
	// controls 必须用自己的 intent 状态机驱动，不能依赖 win.isMaximized() 立即更新。
	const { win, calls } = createFakeWindow({ isMaximizedAlwaysFalse: true });
	const emittedStates = [];
	const controls = createElectronMainWindowControls(
		() => win,
		(channel, val) => {
			if (channel === ipcChannels.appWindowMaximizedChanged) emittedStates.push(val);
		},
	);

	// 第一次 toggle：isMaximized 仍 false → 应 maximize
	const res1 = controls.toggleMaximize();
	assert.equal(res1, true);
	assert.equal(calls.maximize, 1);
	assert.equal(controls.isMaximized(), true, "intent state must report maximized even if win.isMaximized() lags");
	assert.deepEqual(emittedStates, [true]);

	// 第二次 toggle：intent 已是 maximized → 应 unmaximize
	const res2 = controls.toggleMaximize();
	assert.equal(res2, false);
	assert.equal(calls.unmaximize, 1);
	assert.deepEqual(emittedStates, [true, false]);
});

test("MainWindowControls native maximize/unmaximize events sync state", () => {
	const { win, calls, fireMaximize, fireUnmaximize } = createFakeWindow();
	const controls = createElectronMainWindowControls(() => win);

	assert.equal(controls.isMaximized(), false);
	fireMaximize();
	assert.equal(controls.isMaximized(), true, "maximize event must sync intent state");
	fireUnmaximize();
	assert.equal(controls.isMaximized(), false, "unmaximize event must sync intent state");
	assert.ok(calls); // 仅确保 win 被构造
});

test("MainWindowControls rebuilds independent state for a new window", () => {
	// 重建窗口（getMainWindow 返回新对象）后，新窗口不应继承旧窗口的 maximized 状态。
	let current = createFakeWindow();
	const controls = createElectronMainWindowControls(() => current.win);

	controls.maximize();
	assert.equal(controls.isMaximized(), true);

	// 替换为新窗口 B
	current = createFakeWindow();
	assert.equal(controls.isMaximized(), false, "new window must not inherit old window's maximized state");

	// 新窗口第一次 toggle 必须 maximize（不是 unmaximize）
	const res = controls.toggleMaximize();
	assert.equal(res, true);
	assert.equal(current.calls.maximize, 1);
});

test("MainWindowControls setZoomFactor delegates to webContents", () => {
	const { win, calls } = createFakeWindow();
	const controls = createElectronMainWindowControls(() => win);
	controls.setZoomFactor(1.25);
	assert.deepEqual(calls.setZoomFactor, [1.25]);
});

test("MainWindowControls toggleAlwaysOnTop toggles and returns next state", () => {
	let onTop = false;
	const args = [];
	const win = {
		isDestroyed: () => false,
		isMaximized: () => false,
		isAlwaysOnTop: () => onTop,
		setAlwaysOnTop: (next, level) => {
			onTop = next;
			args.push([next, level]);
		},
		on: () => {},
		webContents: { send: () => {}, setZoomFactor: () => {} },
	};
	const controls = createElectronMainWindowControls(() => win);
	assert.equal(controls.toggleAlwaysOnTop(), true);
	assert.deepEqual(args, [[true, "floating"]]);
});

test("MainWindowControls toggleDevTools delegates to the devTools module", () => {
	let devToolsWindow = null;
	const ipc = loadSharedIpc();
	const sandbox = {
		exports: {},
		require: (id) => {
			if (id.includes("shared/ipc")) return ipc;
			if (id.includes("devTools"))
				return {
					toggleMainWindowDevTools: (w) => {
						devToolsWindow = w;
					},
				};
			return require(id);
		},
	};
	vm.runInNewContext(
		transpile("src/main/window/MainWindowControls.ts"),
		sandbox,
		{ filename: "MainWindowControls.ts" },
	);
	const { createElectronMainWindowControls: createControls } = sandbox.exports;

	const { win } = createFakeWindow();
	const controls = createControls(() => win);
	controls.toggleDevTools();
	assert.equal(devToolsWindow, win);
});
