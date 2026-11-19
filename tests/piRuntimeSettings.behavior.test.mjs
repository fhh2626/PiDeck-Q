import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { withHookHost } from "./helpers/l5_hookHost.mjs";
import { nodes } from "./helpers/imagePreviewHarness.mjs";

const primitive = (...names) => Object.fromEntries(names.map((name) => [name, name]));
const { atom } = createRequire(import.meta.url)("jotai");

test("runtime settings offer auto, stock Pi and Pi-Bolt with their corresponding path fields", async () => {
	await withHookHost(async (host) => {
		const { DevTab } = host.load("src/renderer/src/components/app/settings/DevTab.tsx", {
			stubs: {
				"../../../i18n": { t: (key) => key },
				"../../../desktopApi": { desktopApi: { app: {} } },
				"../../ui-shadcn/button": primitive("Button"),
				"../../ui-shadcn/input": primitive("Input"),
				"../../ui-shadcn/label": primitive("Label"),
				"../../ui-shadcn/select": primitive("Select", "SelectContent", "SelectItem", "SelectTrigger", "SelectValue"),
				"./SettingsStorageTab": primitive("SettingsSection"),
				"./SettingRows": primitive("DirtyMarker", "SettingRow", "SettingSwitchRow"),
				"./ExternalEditorsSection": primitive("ExternalEditorsSection"),
			},
		});
		const writes = [];
		const mounted = await host.mount(DevTab.type, {
			draft: {
				piRuntimePreference: "auto", piTypescriptPath: "/bin/pi", piBoltPath: "/bin/pi-bolt",
				wslUser: "", wslDistro: "", webServiceEnabled: false, webServicePort: 1234,
				rpcTimeout: 600000, maxEditorFileSizeMB: 5,
			},
			updateDraft: (patch) => writes.push(patch), isDirty: () => false,
			appInfo: { platform: "linux", version: "0.5.0" },
			customPiPath: "", resetKey: 0,
		});
		const runtimeSelect = nodes(mounted.result(), (node) => node.type === "Select" && node.props.value === "auto")[0];
		assert.deepEqual(nodes(runtimeSelect, (node) => node.type === "SelectItem").map((node) => node.props.value), ["auto", "typescript", "bolt"]);
		const runtimePaths = nodes(mounted.result(), (node) => node.type === "Input" && /^settings\.pi.*PathPlaceholder$/.test(node.props.placeholder ?? ""));
		assert.deepEqual(runtimePaths.map((node) => node.props.placeholder), ["settings.piTypescriptPathPlaceholder", "settings.piBoltPathPlaceholder"]);
		await host.act(async () => runtimeSelect.props.onValueChange("bolt"));
		assert.equal(writes.at(-1).piRuntimePreference, "bolt");
		await host.act(async () => runtimePaths[1].props.onChange({ target: { value: "/opt/pi-bolt" } }));
		assert.equal(writes.at(-1).piBoltPath, "/opt/pi-bolt");
		const beforeInvalidSelection = writes.length;
		await host.act(async () => runtimeSelect.props.onValueChange("unsupported-runtime"));
		assert.equal(writes.length, beforeInvalidSelection);
	});
});

/** Run environment detection through the real hook and record its persisted settings. */
async function checkRuntime(host, status, settings = {}) {
	const writes = [];
	const savedSettings = [];
	const { usePiUpdate } = host.load("src/renderer/src/hooks/usePiUpdate.ts", {
		stubs: {
			"../atoms": { settingsOpenAtom: atom(false) },
			"../i18n": { t: (key) => key },
		},
	});
	const mounted = await host.mount(usePiUpdate, {
		settings: { piRuntimePreference: "auto", piTypescriptPath: "", piBoltPath: "", ...settings },
		setSettings: (value) => savedSettings.push(value),
		showToast() {},
		api: {
			pi: { check: async () => status },
			settings: { update: async (patch) => { writes.push(patch); return { ...settings, ...patch }; } },
		},
	});
	await host.act(async () => mounted.result().refreshPiStatus());
	assert.equal(mounted.result().piChecking, false);
	assert.equal(mounted.result().piStatus, status);
	assert.equal(savedSettings.length, 1);
	return writes[0];
}

for (const [runtimeKind, field, command, version] of [
	["typescript", "piTypescriptPath", "/usr/bin/pi", "1.5.2"],
	["bolt", "piBoltPath", "/opt/pi-bolt", "1.4.0 (Pi-Bolt 1.0.2, linux-x64, JIT off)"],
]) {
	test(`environment detection persists the ${runtimeKind} runtime in its matching path field`, async () => {
		await withHookHost(async (host) => {
			const status = { installed: true, runtimeKind, command, version, searchedDirs: [] };
			const patch = await checkRuntime(host, status);
			assert.equal(patch[field], command);
			assert.deepEqual(Object.keys(patch).sort(), ["piInstall", field].sort());
			assert.equal(patch.piInstall.runtimeKind, runtimeKind);
			assert.equal(patch.piInstall.version, version);
		});
	});
}

test("environment detection preserves explicit runtime paths", async () => {
	await withHookHost(async (host) => {
		const patch = await checkRuntime(host, {
			installed: true, runtimeKind: "bolt", command: "/usr/bin/pi-bolt", version: "1.4.0 (Pi-Bolt 1.0.2)", searchedDirs: [],
		}, { piBoltPath: "/opt/custom/pi-bolt" });
		assert.deepEqual(Object.keys(patch), ["piInstall"]);
	});
});

test("WSL detection caches its status without writing a WSL command into a native runtime path", async () => {
	await withHookHost(async (host) => {
		const command = "wsl -d Ubuntu -- pi";
		const patch = await checkRuntime(host, {
			installed: true, runtimeKind: "typescript", command, version: "1.5.2", searchedDirs: [],
		});
		assert.deepEqual(Object.keys(patch), ["piInstall"]);
		assert.equal(patch.piInstall.command, command);
	});
});

test("failed environment detection clears the previous installation cache", async () => {
	await withHookHost(async (host) => {
		const patch = await checkRuntime(host, { installed: false, searchedDirs: [] }, {
			piInstall: { command: "/bin/pi", version: "1.5.2", runtimeKind: "typescript" },
		});
		assert.deepEqual(Object.keys(patch), ["piInstall"]);
		assert.equal(patch.piInstall, undefined);
	});
});
