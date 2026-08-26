import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { NativeNotifications } = loadTsCommonJs("src/native-node/platform/NativeNotifications.ts");

test("NativeNotifications releases callbacks when a toast is dismissed", async () => {
	const listeners = new Map();
	const host = {
		on(name, listener) {
			listeners.set(name, listener);
			return () => listeners.delete(name);
		},
		request: async () => undefined,
	};
	let clicked = 0;
	const notifications = new NativeNotifications(host);
	notifications.show({ title: "title", body: "body", onClick: () => { clicked += 1; } });
	listeners.get("notification.dismissed")?.({ id: "notification-1" });
	listeners.get("notification.clicked")?.({ id: "notification-1" });
	assert.equal(clicked, 0);
});
