import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { NativeNotifications } = loadTsCommonJs("src/native-node/platform/NativeNotifications.ts");

function createHost(result) {
	const listeners = new Map();
	return {
		on(name, listener) {
			listeners.set(name, listener);
			return () => listeners.delete(name);
		},
		request: async () => result,
		emit(name, payload) {
			listeners.get(name)?.(payload);
		},
	};
}

test("NativeNotifications releases callbacks for a non-interactive tray fallback", async () => {
	const host = createHost({ backend: "tray", interactive: false });
	let clicked = 0;
	const notifications = new NativeNotifications(host);
	notifications.show({ title: "title", body: "body", onClick: () => { clicked += 1; } });
	await Promise.resolve();
	host.emit("notification.clicked", { id: "notification-1" });
	assert.equal(clicked, 0);
});

test("NativeNotifications keeps an interactive toast callback until it is clicked", async () => {
	const host = createHost({ backend: "toast", interactive: true });
	let clicked = 0;
	const notifications = new NativeNotifications(host);
	notifications.show({ title: "title", body: "body", onClick: () => { clicked += 1; } });
	await Promise.resolve();
	host.emit("notification.clicked", { id: "notification-1" });
	host.emit("notification.clicked", { id: "notification-1" });
	assert.equal(clicked, 1);
});

test("NativeNotifications releases a toast callback when Qt falls back to tray", async () => {
	const host = createHost({ backend: "toast", interactive: true });
	let clicked = 0;
	let failed = 0;
	const notifications = new NativeNotifications(host);
	notifications.show({
		title: "title",
		body: "body",
		onClick: () => { clicked += 1; },
		onFailed: () => { failed += 1; },
	});
	await Promise.resolve();
	host.emit("notification.fallback", { id: "notification-1" });
	host.emit("notification.clicked", { id: "notification-1" });
	assert.equal(clicked, 0);
	assert.equal(failed, 0);
});

test("NativeNotifications releases callbacks when a legacy host returns no result", async () => {
	const host = createHost(undefined);
	let clicked = 0;
	const notifications = new NativeNotifications(host);
	notifications.show({ title: "title", body: "body", onClick: () => { clicked += 1; } });
	await Promise.resolve();
	host.emit("notification.clicked", { id: "notification-1" });
	assert.equal(clicked, 0);
});
