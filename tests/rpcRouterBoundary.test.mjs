import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

test("RpcRouter.ts is transport-neutral and does not import or reference Electron concepts", () => {
	const content = readFileSync("src/main/transport/RpcRouter.ts", "utf8");
	assert.doesNotMatch(content, /from\s+["']electron["']/i, "RpcRouter must not import from electron");
	assert.doesNotMatch(content, /\bipcMain\b/, "RpcRouter must not reference ipcMain");
	assert.doesNotMatch(content, /\bBrowserWindow\b/, "RpcRouter must not reference BrowserWindow");
	assert.doesNotMatch(content, /\bIpcMainInvokeEvent\b/, "RpcRouter must not reference IpcMainInvokeEvent");
	assert.doesNotMatch(content, /\bwebContents\b/, "RpcRouter must not reference webContents");
});

test("ElectronRpcRouter behaves correctly at runtime: strips _event, forwards args, returns result, propagates error", async () => {
	const handlers = new Map();
	const fakeIpcMain = {
		handle(channel, callback) {
			handlers.set(channel, callback);
		},
	};

	const { ElectronRpcRouter } = await import("../src/main/transport/ElectronRpcRouter.ts");
	const router = new ElectronRpcRouter(fakeIpcMain);

	let receivedArgs = null;
	router.handle("test:channel", async (arg1, arg2, arg3) => {
		receivedArgs = [arg1, arg2, arg3];
		return `${arg1}-${arg2}-${arg3}`;
	});

	assert.ok(handlers.has("test:channel"), "Channel should be registered on ipcMain");

	const registered = handlers.get("test:channel");
	const fakeEvent = { sender: { id: 1 } };
	const result = await registered(fakeEvent, "foo", 42, { ok: true });

	assert.deepEqual(
		receivedArgs,
		["foo", 42, { ok: true }],
		"Business handler must receive arguments without Electron event",
	);
	assert.equal(result, "foo-42-[object Object]", "Result must be returned from router handler");

	// Verify error propagation
	router.handle("test:error", async () => {
		throw new Error("test error message");
	});
	const errorRegistered = handlers.get("test:error");
	await assert.rejects(
		() => errorRegistered(fakeEvent, "irrelevant"),
		{ message: "test error message" },
		"Errors in handler must propagate to caller",
	);
});

test("src/main/index.ts does not contain direct ipcMain.handle registrations", () => {
	const indexContent = readFileSync("src/main/index.ts", "utf8");
	assert.doesNotMatch(
		indexContent,
		/\bipcMain\.handle\b/,
		"src/main/index.ts should not directly call ipcMain.handle; use router.handle instead",
	);
});

test("src/main/ipc/*.ts modules do not import or use ipcMain (except electronPreloadLifecycleIpc.ts)", () => {
	const ipcDir = "src/main/ipc";
	const files = readdirSync(ipcDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

	for (const file of files) {
		if (file === "electronPreloadLifecycleIpc.ts") continue;
		const content = readFileSync(join(ipcDir, file), "utf8");
		assert.doesNotMatch(
			content,
			/import\s+[^;]*\bipcMain\b[^;]*from\s+["']electron["']/,
			`${file} must not import ipcMain from electron`,
		);
		assert.doesNotMatch(
			content,
			/\bipcMain\.handle\b/,
			`${file} must not call ipcMain.handle`,
		);
		assert.doesNotMatch(
			content,
			/\bipcMain\.on\b/,
			`${file} must not call ipcMain.on`,
		);
		assert.doesNotMatch(
			content,
			/\bElectron\.IpcMain\b/,
			`${file} must not reference Electron.IpcMain`,
		);
	}
});

test("router.handle callbacks across src/main/ipc/*.ts do not retain _event", () => {
	const ipcDir = "src/main/ipc";
	const files = readdirSync(ipcDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

	for (const file of files) {
		const content = readFileSync(join(ipcDir, file), "utf8");
		assert.doesNotMatch(
			content,
			/router\.handle\s*\(\s*[^,]+,\s*(?:async\s*)?\(\s*_event\b/,
			`${file} must not have router.handle callbacks retaining _event parameter`,
		);
		assert.doesNotMatch(
			content,
			/\bIpcMainInvokeEvent\b/,
			`${file} must not reference IpcMainInvokeEvent`,
		);
	}
});

test("systemIpc.ts does not register preloadReady/preloadError", () => {
	const content = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
	assert.doesNotMatch(
		content,
		/ipcChannels\.preloadReady/,
		"systemIpc.ts must not reference ipcChannels.preloadReady",
	);
	assert.doesNotMatch(
		content,
		/ipcChannels\.preloadError/,
		"systemIpc.ts must not reference ipcChannels.preloadError",
	);
});

test("electronPreloadLifecycleIpc.ts exists and registers preloadReady and preloadError", () => {
	const content = readFileSync("src/main/ipc/electronPreloadLifecycleIpc.ts", "utf8");
	assert.match(
		content,
		/ipcChannels\.preloadReady/,
		"electronPreloadLifecycleIpc.ts must register ipcChannels.preloadReady",
	);
	assert.match(
		content,
		/ipcChannels\.preloadError/,
		"electronPreloadLifecycleIpc.ts must register ipcChannels.preloadError",
	);
});
