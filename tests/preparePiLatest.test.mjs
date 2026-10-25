import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTALL_ARGS, PI_PACKAGE, VIEW_ARGS, preparePiLatest } from "../scripts/prepare-pi-latest.mjs";

async function fixtureRoot(t) {
	const root = await mkdtemp(join(tmpdir(), "pideck-pi-prepare-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

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

test("prepare installs latest when no fixture is installed", async (t) => {
	const calls = [];
	const result = await preparePiLatest({
		cwd: await fixtureRoot(t),
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

test("prepare installs latest when the installed fixture is stale", async (t) => {
	const calls = [];
	let installed = "1.0.0";
	const result = await preparePiLatest({
		cwd: await fixtureRoot(t),
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

test("prepare skips install when the fixture is already latest", async (t) => {
	const calls = [];
	const result = await preparePiLatest({
		cwd: await fixtureRoot(t),
		readPrepared: async () => "3.1.4",
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

test("prepare fails when install leaves a mismatched version", async (t) => {
	const result = await preparePiLatest({
		cwd: await fixtureRoot(t),
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

/** A root-level SDK is a decoy: latest compatibility must be prepared in its own npm project. */
test("prepare ignores a root SDK and keeps root dependencies and manifests unchanged", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pideck-pi-isolation-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const rootPi = join(root, "node_modules", ...PI_PACKAGE.split("/"));
	await mkdir(rootPi, { recursive: true });
	await writeFile(join(rootPi, "package.json"), JSON.stringify({ version: "9.9.9" }));
	await writeFile(join(root, "package.json"), '{"private":true,"name":"root-sentinel"}\n');
	await writeFile(join(root, "package-lock.json"), '{"lockfileVersion":3,"sentinel":"unchanged"}\n');
	const fixture = join(root, ".cache", "pi-latest");
	let installs = 0;
	const result = await preparePiLatest({
		cwd: root,
		queryLatest: async () => "9.9.9",
		installLatest: async (context) => {
			installs++;
			assert.equal(context.cwd, fixture);
			const installed = join(fixture, "node_modules", ...PI_PACKAGE.split("/"));
			await mkdir(installed, { recursive: true });
			await writeFile(join(installed, "package.json"), JSON.stringify({ version: "9.9.9" }));
		},
		log: () => undefined,
	});
	assert.equal(installs, 1, "a root SDK must not satisfy the isolated fixture");
	assert.equal(result.installed, true);
	assert.equal(await readFile(join(root, "package.json"), "utf8"), '{"private":true,"name":"root-sentinel"}\n');
	assert.equal(await readFile(join(root, "package-lock.json"), "utf8"), '{"lockfileVersion":3,"sentinel":"unchanged"}\n');
	assert.equal(await readFile(join(rootPi, "package.json"), "utf8"), '{"version":"9.9.9"}');
});

test("concurrent prepares serialize installation of the same fixture", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pideck-pi-concurrent-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	let installed = null;
	let installs = 0;
	const deps = {
		cwd: root,
		queryLatest: async () => "9.9.9",
		readInstalled: async () => installed,
		installLatest: async () => {
			installs++;
			await new Promise(resolve => setTimeout(resolve, 40));
			installed = "9.9.9";
		},
		log: () => undefined,
	};
	const results = await Promise.all([preparePiLatest(deps), preparePiLatest(deps)]);
	assert.equal(installs, 1);
	assert.ok(results.every(result => result.installed));
});

test("default npm runner installs with a private fixture cwd and explicit prefix", async (t) => {
	const root = await fixtureRoot(t);
	const fixture = join(root, ".cache", "pi-latest");
	const calls = [];
	await preparePiLatest({ cwd: root, log: () => undefined, runNpm: async (args, command, cwd) => {
		calls.push({ args, command, cwd });
		assert.equal(cwd, fixture);
		if (args[0] === "view") return { stdout: "9.9.9\n", stderr: "" };
		assert.deepEqual(args.slice(0, 2), ["--prefix", fixture]);
		const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
		assert.equal(manifest.private, true);
		assert.equal(manifest.name, "pideck-pi-latest-fixture");
		const sdk = join(cwd, "node_modules", ...PI_PACKAGE.split("/"));
		await mkdir(sdk, { recursive: true });
		await writeFile(join(sdk, "package.json"), '{"version":"9.9.9"}');
		return { stdout: "", stderr: "" };
	} });
	assert.equal(calls.length, 2);
});

test("failed install releases its lock and cannot be accepted as a completed fixture", async (t) => {
	const root = await fixtureRoot(t);
	let installs = 0;
	const deps = { cwd: root, log: () => undefined, queryLatest: async () => "9.9.9", installLatest: async ({ packageDir }) => {
		installs++;
		await mkdir(packageDir, { recursive: true });
		await writeFile(join(packageDir, "package.json"), '{"version":"9.9.9"}');
		if (installs === 1) throw new Error("simulated npm failure after manifest write");
	} };
	await assert.rejects(preparePiLatest(deps), /simulated npm failure/);
	assert.equal((await preparePiLatest(deps)).installed, true);
	assert.equal(installs, 2, "a partial installation must be repaired, not mistaken for current");
	assert.equal((await preparePiLatest(deps)).installed, true);
	assert.equal(installs, 2, "a successfully prepared fixture should be reused");
});

test("failed registry query releases fixture ownership for a retry", async (t) => {
	const root = await fixtureRoot(t);
	await assert.rejects(preparePiLatest({ cwd: root, queryLatest: async () => { throw new Error("registry unavailable"); } }), /registry unavailable/);
	const result = await preparePiLatest({ cwd: root, queryLatest: async () => "9.9.9", readInstalled: async () => "9.9.9", installLatest: async () => undefined, log: () => undefined });
	assert.equal(result.installed, true);
});

test("prepare refuses an unowned cache manifest before invoking npm", async (t) => {
	const root = await fixtureRoot(t);
	const fixture = join(root, ".cache", "pi-latest");
	await mkdir(fixture, { recursive: true });
	await writeFile(join(fixture, "package.json"), '{"name":"unrelated-project","private":true}');
	let npmCalls = 0;
	await assert.rejects(preparePiLatest({ cwd: root, runNpm: async () => { npmCalls++; return { stdout: "9.9.9" }; } }), /unowned fixture/);
	assert.equal(npmCalls, 0);
});

test("install args do not save to package.json or the lockfile", () => {
	assert.deepEqual(VIEW_ARGS, ["view", PI_PACKAGE, "version"]);
	assert.ok(INSTALL_ARGS.includes("--no-save"));
	assert.ok(INSTALL_ARGS.includes("--package-lock=false"));
	assert.ok(INSTALL_ARGS.includes("--ignore-scripts"));
	assert.ok(INSTALL_ARGS.includes(`${PI_PACKAGE}@latest`));
	assert.ok(!INSTALL_ARGS.some((arg) => /^\d+\.\d+\.\d+/.test(arg)));
});
