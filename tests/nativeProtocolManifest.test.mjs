import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	MAX_COMPOSER_TOTAL_IMAGE_BASE64_BYTES,
	MAX_NATIVE_EVENT_FRAME_BYTES,
	MAX_NATIVE_RPC_BODY_BYTES,
} from "../src/shared/desktop/nativeLimits.ts";

const manifest = JSON.parse(readFileSync("src/shared/desktop/nativeProtocol.json", "utf8"));
const paths = readFileSync("native/src/NativePaths.cpp", "utf8");
const controller = readFileSync("native/src/BackendProcessController.cpp", "utf8");

test("native protocol manifest matches the shared transport limits", () => {
	assert.equal(manifest.version, 1);
	assert.equal(manifest.limits.maxRpcBodyBytes, MAX_NATIVE_RPC_BODY_BYTES);
	assert.equal(manifest.limits.maxEventFrameBytes, MAX_NATIVE_EVENT_FRAME_BYTES);
	assert.equal(manifest.limits.maxComposerTotalImageBase64Bytes, MAX_COMPOSER_TOTAL_IMAGE_BASE64_BYTES);
	assert.ok(manifest.desktopEndpoints.includes("POST /__pideck/rpc"));
	assert.ok(manifest.desktopEndpoints.includes("GET /__pideck/events"));
});

test("the native host launches the C++ backend directly with no Node fallback", () => {
  assert.match(paths, /root\.filePath\("PiDeckBackend\.exe"\)/);
  assert.match(paths, /PIDECK_SIDECAR_EXECUTABLE/);
  assert.doesNotMatch(paths, /nodeExecutable|nativeNodeEntry|sidecarKind/);
  assert.match(controller, /m_paths\.sidecarExecutable/);
  assert.match(controller, /if \(program\.isEmpty\(\)\) \{/);
  assert.match(controller, /Backend launch rejected/);
});
