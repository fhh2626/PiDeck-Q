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
const controller = readFileSync("native/src/NodeProcessController.cpp", "utf8");

test("native protocol manifest matches the shared transport limits", () => {
	assert.equal(manifest.version, 1);
	assert.deepEqual(manifest.sidecarKinds, ["node", "cpp"]);
	assert.equal(manifest.defaultSidecarKind, "cpp");
	assert.equal(manifest.limits.maxRpcBodyBytes, MAX_NATIVE_RPC_BODY_BYTES);
	assert.equal(manifest.limits.maxEventFrameBytes, MAX_NATIVE_EVENT_FRAME_BYTES);
	assert.equal(manifest.limits.maxComposerTotalImageBase64Bytes, MAX_COMPOSER_TOTAL_IMAGE_BASE64_BYTES);
	assert.ok(manifest.desktopEndpoints.includes("POST /__pideck/rpc"));
	assert.ok(manifest.desktopEndpoints.includes("GET /__pideck/events"));
});

test("the packaged default sidecar is the C++ backend and an unknown kind is refused", () => {
	assert.match(paths, /PIDECK_SIDECAR_KIND/);
	// The default comes from the kind this build staged (compile-time define), so a
	// double-clicked release never needs an environment opt-in.
	assert.match(paths, /PIDECK_DEFAULT_SIDECAR_KIND/);
	assert.match(paths, /sidecarKind = QStringLiteral\("cpp"\)/);
	// The Node sidecar stays a documented, selectable compatibility build.
	assert.match(paths, /sidecarKind == QStringLiteral\("node"\)/);
	assert.match(paths, /sidecarKind == QStringLiteral\("cpp"\)/);
	assert.doesNotMatch(paths, /paths\.sidecarKind = QStringLiteral\("node"\)/);
	// A value that is neither kind is reported and leaves no executable or argument list
	// behind, so there is nothing the controller could launch by accident.
	assert.match(paths, /paths\.sidecarKindError = /);
	assert.match(paths, /paths\.sidecarExecutable\.clear\(\)/);
	assert.match(paths, /paths\.sidecarArguments\.clear\(\)/);
	assert.match(controller, /m_paths\.sidecarExecutable/);
	assert.match(controller, /if \(program\.isEmpty\(\)\) \{/);
	assert.match(controller, /Sidecar launch rejected/);
	assert.match(controller, /return false;/);
	assert.doesNotMatch(paths, /exists\(paths\.nativeNodeEntry\)/);
});
