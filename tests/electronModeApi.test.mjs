import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("native renderer selects the native runtime without changing LAN Web/preview fallback", () => {
	const source = readFileSync("src/renderer/src/desktopApi.ts", "utf8");
	assert.match(source, /isNativeRuntime/);
	assert.match(source, /initializeNativeDesktop/);
	assert.match(source, /isLanWeb/);
	assert.match(source, /createBrowserApi/);
	assert.match(source, /createPreviewApi/);
});

test("native bootstrap completes before React mounts", () => {
	const main = readFileSync("src/renderer/src/main.tsx", "utf8");
	assert.match(main, /await initializeDesktopRuntime\(\)/);
	assert.match(main, /ReactDOM\.createRoot/);
	assert.ok(main.indexOf("await initializeDesktopRuntime()") < main.indexOf("ReactDOM.createRoot"));
});

test("packaged native renderer is served by the private loopback server", () => {
	const server = readFileSync("src/native-node/transport/NativeRendererServer.ts", "utf8");
	assert.match(server, /listen\(0, "127\.0\.0\.1"/);
	assert.match(server, /__pideck\/rpc/);
	assert.match(server, /__pideck\/events/);
});
