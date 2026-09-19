import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

/** In-memory persistence and filesystem boundaries; each fixture has one Store class identity. */
export function createSecurityStoreFixture(options = {}) {
	const { createDefaultSecurityConfig } = loadTsCommonJs("src/shared/types/security.ts");
	let config = structuredClone(options.config ?? createDefaultSecurityConfig());
	const snapshots = [];
	const saved = [];
	const module = loadTsCommonJs("src/main/security/SecurityStore.ts", {
		stubs: {
			"node:fs/promises": {
				mkdir: async () => {},
				writeFile: async (_path, content) => {
					const snapshot = JSON.parse(content);
					snapshots.push(snapshot);
					await options.writeSnapshot?.(snapshot);
				},
			},
			"../utils/fsRetry": { renameWithRetry: async () => {} },
		},
	});
	const store = new module.SecurityStore({
		userDataDir: process.cwd(),
		settingsStore: {
			get: () => ({ securityConfig: structuredClone(config) }),
			update: async (patch) => {
				await options.saveSettings?.(patch);
				config = structuredClone(patch.securityConfig);
				saved.push(config);
			},
		},
	});
	return { store, module, snapshots, saved };
}

/** Explicit scheduling barrier, without timing assumptions. */
export function deferred() {
	let resolve;
	const promise = new Promise((done) => { resolve = done; });
	return { promise, resolve };
}
