import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
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

/** Quote one literal POSIX shell word, including paths containing apostrophes. */
function shellQuote(value) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Write the host platform's executable shim using the test runner's Node binary. */
export function writeNodeShim(directory, name, scriptPath) {
	mkdirSync(directory, { recursive: true });
	const windows = process.platform === "win32";
	const shim = join(directory, windows ? `${name}.cmd` : name);
	writeFileSync(
		shim,
		windows
			? `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`
			: `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(scriptPath)} "$@"\n`,
	);
	if (!windows) chmodSync(shim, 0o755);
	return shim;
}

/** Delimited concatenation, matching how both implementations build PATH values. */
export function joinPathParts(parts) {
	return parts.filter(Boolean).join(process.platform === "win32" ? ";" : ":");
}
