import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Shared fixtures for the pi-install / model-list / WSL parity suites.
 *
 * `createFakeProcessHost` lets the production TypeScript modules run in this test
 * process while seeing the *same* environment the C++ backend was spawned with. The
 * pi locator's `searchDirs` is part of the `pi:check` result, so a different PATH or
 * APPDATA on either side would make the comparison meaningless.
 */
export function createFakeProcessHost() {
	const env = {};
	const proxy = new Proxy(process, {
		get(target, prop, receiver) {
			if (prop === "env") return env;
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return {
		env,
		process: proxy,
		/** Replace the whole visible environment (never merges stale keys). */
		set(next) {
			for (const key of Object.keys(env)) delete env[key];
			Object.assign(env, next);
		},
	};
}

/** Write an npm-style `name.cmd` batch shim that forwards to a node script. */
export function writeNodeShim(directory, name, scriptPath) {
	mkdirSync(directory, { recursive: true });
	const shim = join(directory, `${name}.cmd`);
	writeFileSync(shim, `@echo off\r\nnode "${scriptPath}" %*\r\n`);
	return shim;
}

/** Delimited concatenation, matching how both implementations build PATH values. */
export function joinPathParts(parts) {
	return parts.filter(Boolean).join(process.platform === "win32" ? ";" : ":");
}
