import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeChildEnvironment } from "../src/main/process/sanitizeChildEnvironment.ts";

test("sanitizeChildEnvironment removes native host bridge secrets and private renderer paths", () => {
	const source = {
		PATH: "test-path",
		PIDECK_HOST_TOKEN: "secret-token",
		PIDECK_HOST_PORT: "43123",
		PIDECK_NATIVE_HOST: "1",
		PIDECK_RENDERER_ROOT: "private-renderer-root",
		PIDECK_NATIVE_NODE_ENTRY: "private-entry",
		PIDECK_USER_DATA: "user-data",
	};
	const sanitized = sanitizeChildEnvironment(source);

	assert.deepEqual(sanitized, {
		PATH: "test-path",
		PIDECK_USER_DATA: "user-data",
	});
	assert.deepEqual(source, {
		PATH: "test-path",
		PIDECK_HOST_TOKEN: "secret-token",
		PIDECK_HOST_PORT: "43123",
		PIDECK_NATIVE_HOST: "1",
		PIDECK_RENDERER_ROOT: "private-renderer-root",
		PIDECK_NATIVE_NODE_ENTRY: "private-entry",
		PIDECK_USER_DATA: "user-data",
	});
});

test("sanitizeChildEnvironment preserves safe Node settings while removing Electron injection", () => {
	const sanitized = sanitizeChildEnvironment({
		NODE_OPTIONS: "--max-old-space-size=512 --require electron-vite/register",
		ELECTRON_RUN_AS_NODE: "1",
		CHROME_CRASHPAD_PIPE_NAME: "private",
		LANG: "en_US.UTF-8",
	});

	assert.deepEqual(sanitized, {
		NODE_OPTIONS: "--max-old-space-size=512",
		LANG: "en_US.UTF-8",
	});
});
