import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { isNativeNotificationsSupported } = loadTsCommonJs("src/native-node/platform/NativeNotifications.ts", {
	stubs: {
		"../../main/platform/PlatformServices": {},
		"../host/HostBridge": {},
	},
});

test("native notifications report support only when the Windows toast capability is available", () => {
	const previous = process.env.PIDECK_NATIVE_NOTIFICATIONS;
	try {
		delete process.env.PIDECK_NATIVE_NOTIFICATIONS;
		assert.equal(isNativeNotificationsSupported("win32"), true);
		process.env.PIDECK_NATIVE_NOTIFICATIONS = "0";
		assert.equal(isNativeNotificationsSupported("win32"), false);
		assert.equal(isNativeNotificationsSupported("linux"), false);
		assert.equal(isNativeNotificationsSupported("darwin"), false);
	} finally {
		if (previous === undefined) delete process.env.PIDECK_NATIVE_NOTIFICATIONS;
		else process.env.PIDECK_NATIVE_NOTIFICATIONS = previous;
	}
});
