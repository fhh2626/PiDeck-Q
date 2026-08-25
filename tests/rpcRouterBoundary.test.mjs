import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { NativeRpcRouter } from "../src/main/transport/NativeRpcRouter.ts";

test("RpcRouter contract is transport-neutral", () => {
	const content = readFileSync("src/main/transport/RpcRouter.ts", "utf8");
	assert.doesNotMatch(content, /electron|ipcMain|BrowserWindow|webContents/i);
});

test("NativeRpcRouter registers, forwards arguments, returns values and propagates errors", async () => {
	const router = new NativeRpcRouter();
	let received;
	router.handle("test:channel", async (...args) => {
		received = args;
		return `${args[0]}-${args[1]}-${args[2]}`;
	});
	assert.equal(await router.invoke("test:channel", ["foo", 42, { ok: true }]), "foo-42-[object Object]");
	assert.deepEqual(received, ["foo", 42, { ok: true }]);
	router.handle("test:error", async () => { throw new Error("test error message"); });
	await assert.rejects(() => router.invoke("test:error", []), { message: "test error message" });
});

test("NativeRendererServer is the only renderer transport entrypoint", () => {
	const source = readFileSync("src/native-node/transport/NativeRendererServer.ts", "utf8");
	assert.match(source, /POST.*__pideck\/rpc|__pideck\/rpc/);
	assert.match(source, /__pideck\/events/);
	assert.match(source, /127\.0\.0\.1/);
	assert.match(source, /32 \* 1024 \* 1024/);
});
