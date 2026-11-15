import { resolve } from "node:path";
import { loadTsCommonJs } from "./loadTsCommonJs.mjs";
import { createFakeProcessHost } from "./native2FakeProcess.mjs";

/**
 * In-process stand-in for the Node sidecar's IPC surface.
 *
 * The goldens for the pi-install / model-list / WSL parity suites are the *production*
 * handlers from `src/main/ipc/systemIpc.ts`, loaded in a VM with a fake `process` that
 * sees exactly the environment the C++ backend was spawned with. `getWslExe` is the one
 * module stub: the real one resolves `%SystemRoot%\System32\wsl.exe`, and no verification
 * may run a real distro. Everything else (PiLocator, modelListCache, mainProcessCopy,
 * execFile calls) is the real production code.
 */
const { mainProcessT } = loadTsCommonJs(resolve("src/shared/i18n/mainProcessCopy.ts"));

export function mainProcessCopy(key, params = {}) {
	return mainProcessT("en-US", key, params);
}

export function createDesktopRpcOracle({
	home,
	settings,
	env,
	modelsConfig = { parsed: { providers: {} } },
	wslCommand = "wsl-fixture",
}) {
	const host = createFakeProcessHost();
	host.set(env);
	const stubs = { "../wsl/wslExe": { getWslExe: () => ({ command: wslCommand, shell: true }) } };
	const { registerSystemIpc } = loadTsCommonJs(resolve("src/main/ipc/systemIpc.ts"), {
		globals: { process: host.process },
		stubs,
	});
	const { PiLocator } = loadTsCommonJs(resolve("src/main/pi/PiLocator.ts"), {
		globals: { process: host.process },
		stubs,
	});

	const handlers = new Map();
	const sent = [];
	const settingsObject = { ...settings };
	let config = modelsConfig;
	registerSystemIpc(
		{ handle: (channel, handler) => handlers.set(channel, handler) },
		{
			piLocator: new PiLocator(mainProcessCopy, home),
			settingsStore: {
				get: () => settingsObject,
				update: async (patch) => {
					Object.assign(settingsObject, patch);
					return settingsObject;
				},
			},
			configManager: {
				getModelsConfig: async () => {
					if (typeof config === "function") config = config();
					return config;
				},
			},
			agentManager: {},
			skillManager: {},
			appLogger: { info() {}, warn() {}, error() {} },
			rpcLogger: {},
			sessionRuntimeCoordinator: {},
			modelSpecsStore: {},
			mainWindowControls: {},
			platformApplication: { hideApplicationMenu() {}, version: "0.4.3" },
			platformPaths: { home },
			platformShell: {},
			platformTheme: { setSource() {} },
			sendToRenderer: (channel) => sent.push(channel),
			mainCopy: mainProcessCopy,
			openExternalUrl: async () => undefined,
			restartApplication() {},
			stopAgentFromMonitor: async () => ({ ok: true }),
		},
	);

	return {
		invoke: (channel, args = []) => handlers.get(channel)(...args),
		sent,
		settings: settingsObject,
		channels: () => [...handlers.keys()],
	};
}
