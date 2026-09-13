import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { INSTALL_ARGS, PI_PACKAGE, VIEW_ARGS, preparePiLatest } from "../scripts/prepare-pi-latest.mjs";

test("package.json does not declare the Pi compatibility fixture", () => {
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	assert.equal(pkg.dependencies?.[PI_PACKAGE], undefined);
	assert.equal(pkg.devDependencies?.[PI_PACKAGE], undefined);
});

test("package-lock root does not declare the Pi compatibility fixture", () => {
	const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
	const root = lock.packages?.[""] ?? {};
	assert.equal(root.dependencies?.[PI_PACKAGE], undefined);
	assert.equal(root.devDependencies?.[PI_PACKAGE], undefined);
});

test("prepare installs latest when no fixture is installed", async () => {
	const calls = [];
	const result = await preparePiLatest({
		queryLatest: async () => "9.9.9",
		readInstalled: async () => {
			calls.push("read");
			return calls.filter((c) => c === "read").length === 1 ? null : "9.9.9";
		},
		installLatest: async () => {
			calls.push("install");
		},
		log: () => undefined,
	});
	assert.deepEqual(calls, ["read", "install", "read"]);
	assert.equal(result.installed, true);
	assert.equal(result.latestVersion, "9.9.9");
	assert.equal(result.installedVersion, "9.9.9");
});

test("prepare installs latest when the installed fixture is stale", async () => {
	const calls = [];
	let installed = "1.0.0";
	const result = await preparePiLatest({
		queryLatest: async () => "2.0.0",
		readInstalled: async () => installed,
		installLatest: async () => {
			calls.push("install");
			installed = "2.0.0";
		},
		log: () => undefined,
	});
	assert.deepEqual(calls, ["install"]);
	assert.equal(result.installed, true);
	assert.equal(result.installedVersion, "2.0.0");
});

test("prepare skips install when the fixture is already latest", async () => {
	const calls = [];
	const result = await preparePiLatest({
		queryLatest: async () => "3.1.4",
		readInstalled: async () => "3.1.4",
		installLatest: async () => {
			calls.push("install");
		},
		log: () => undefined,
	});
	assert.deepEqual(calls, []);
	assert.equal(result.installed, true);
	assert.equal(result.installedVersion, "3.1.4");
});

test("prepare fails when install leaves a mismatched version", async () => {
	const result = await preparePiLatest({
		queryLatest: async () => "4.0.0",
		readInstalled: async () => "3.0.0",
		installLatest: async () => undefined,
		log: () => undefined,
		error: () => undefined,
	});
	assert.equal(result.installed, false);
	assert.equal(result.latestVersion, "4.0.0");
	assert.equal(result.installedVersion, "3.0.0");
});

test("install args do not save to package.json or the lockfile", () => {
	assert.deepEqual(VIEW_ARGS, ["view", PI_PACKAGE, "version"]);
	assert.ok(INSTALL_ARGS.includes("--no-save"));
	assert.ok(INSTALL_ARGS.includes("--package-lock=false"));
	assert.ok(INSTALL_ARGS.includes("--ignore-scripts"));
	assert.ok(INSTALL_ARGS.includes(`${PI_PACKAGE}@latest`));
	assert.ok(!INSTALL_ARGS.some((arg) => /^\d+\.\d+\.\d+/.test(arg)));
});
