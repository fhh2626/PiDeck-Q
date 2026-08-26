import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { isNativeNotificationsSupported } = loadTsCommonJs("src/native-node/platform/NativeNotifications.ts", {
	stubs: {
		"../../main/platform/PlatformServices": {},
		"../host/HostBridge": {},
	},
});

test("native notifications report support only for the implemented Windows host", () => {
	assert.equal(isNativeNotificationsSupported("win32"), true);
	assert.equal(isNativeNotificationsSupported("linux"), false);
	assert.equal(isNativeNotificationsSupported("darwin"), false);
});
