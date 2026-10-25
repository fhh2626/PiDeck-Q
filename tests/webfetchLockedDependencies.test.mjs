import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * WebFetch's dist bundle inlines its dependencies, so the bundle is only reproducible if the
 * installed tree is exactly what package-lock.json describes. A drifted install (for example
 * an unlocked `npm install --no-save`) silently bakes different dependency code into dist.
 */
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")).packages;
const webfetchManifest = JSON.parse(readFileSync(join(root, "resources/extensions/pideck-q-webfetch/package.json"), "utf8"));

/** Node-style lookup: nearest node_modules/<name> walking up from `fromDir`, bounded by the repo root. */
function findInstalled(name, fromDir) {
	for (let dir = fromDir; dir.startsWith(root); dir = dirname(dir)) {
		const candidate = join(dir, "node_modules", name);
		if (existsSync(join(candidate, "package.json"))) return candidate;
		if (dir === root) break;
	}
	return null;
}

function lockKey(packageDir) {
	return relative(root, packageDir).split("\\").join("/");
}

test("every dependency bundled into WebFetch is installed at exactly its locked version", () => {
	const drift = [];
	const seen = new Set();
	const directDependencies = Object.keys(webfetchManifest.dependencies ?? {});
	const queue = directDependencies.map((name) => ({ name, from: root, direct: true }));
	while (queue.length > 0) {
		const { name, from, direct } = queue.pop();
		const dir = findInstalled(name, from);
		if (dir === null) {
			// Only transitive optional/platform-specific packages may be absent; a missing direct
			// dependency would silently shrink what this test verifies.
			if (direct) drift.push(`direct dependency ${name} is not installed`);
			continue;
		}
		if (seen.has(dir)) continue;
		seen.add(dir);
		const installed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		const locked = lock[lockKey(dir)];
		if (locked === undefined) drift.push(`${lockKey(dir)}@${installed.version} is installed but absent from package-lock.json`);
		else if (locked.version !== installed.version) drift.push(`${lockKey(dir)} installed ${installed.version}, locked ${locked.version}`);
		for (const dependency of Object.keys(installed.dependencies ?? {})) queue.push({ name: dependency, from: dir, direct: false });
	}
	assert.ok(seen.size >= directDependencies.length, "expected to inspect at least every direct WebFetch dependency");
	assert.deepEqual(drift, [], `Installed dependencies drifted from package-lock.json; run \`npm ci\` before rebuilding WebFetch:\n${drift.join("\n")}`);
});
