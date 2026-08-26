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

test("sanitizeChildEnvironment removes NODE_OPTIONS without corrupting quoted arguments", () => {
	const sanitized = sanitizeChildEnvironment({
		NODE_OPTIONS: '--require "C:\\Program Files\\private hook.js" --max-old-space-size=512',
		ELECTRON_RUN_AS_NODE: "1",
		CHROME_CRASHPAD_PIPE_NAME: "private",
		LANG: "en_US.UTF-8",
	});

	assert.deepEqual(sanitized, {
		LANG: "en_US.UTF-8",
	});
});
