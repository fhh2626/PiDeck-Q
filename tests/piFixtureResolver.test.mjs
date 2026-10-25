import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { getPiFixturePackageDir } from "../scripts/pi-compatibility-fixture.mjs";
import { createPiFixtureResolveHook } from "./helpers/piFixtureResolveHook.mjs";

async function put(path, text) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, text);
}

/** Temp project with a decoy `typebox` at the root and the real one only inside the Pi fixture. */
async function project(t) {
	const root = await mkdtemp(join(tmpdir(), "pideck-pi-resolver-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await put(join(root, "node_modules/typebox/package.json"), JSON.stringify({ name: "typebox", type: "module", main: "index.mjs" }));
	await put(join(root, "node_modules/typebox/index.mjs"), "export const source = 'root-decoy';");
	const fixturePi = getPiFixturePackageDir(root);
	await put(join(fixturePi, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module" }));
	const fixtureModules = join(root, ".cache", "pi-latest", "node_modules");
	await put(join(fixtureModules, "typebox/package.json"), JSON.stringify({ name: "typebox", type: "module", main: "index.mjs" }));
	await put(join(fixtureModules, "typebox/index.mjs"), "export const source = 'fixture';");
	await put(join(root, "resources/extensions/sample/consumer.mjs"), "export { source } from 'typebox';");
	await put(join(root, "tests/outside.mjs"), "export { source } from 'typebox';");
	return root;
}

const helperUrl = new URL("./helpers/piFixtureResolver.mjs", import.meta.url).href;
const hookUrl = new URL("./helpers/piFixtureResolveHook.mjs", import.meta.url).href;
const loaderUrl = new URL("./helpers/subagentGraphLoader.mjs", import.meta.url).href;

function runChild(script) {
	return spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 20000 });
}

test("extension sources resolve Pi-hosted packages from the fixture, not a root decoy", async (t) => {
	const root = await project(t);
	const child = runChild(`
		const { registerHooks } = await import("node:module");
		const { createPiFixtureResolveHook } = await import(${JSON.stringify(hookUrl)});
		registerHooks({ resolve: createPiFixtureResolveHook(${JSON.stringify(root)}) });
		const mod = await import(${JSON.stringify(pathToFileURL(join(root, "resources/extensions/sample/consumer.mjs")).href)});
		console.log(mod.source);
	`);
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "fixture");
});

test("code outside resources/extensions keeps normal resolution", async (t) => {
	const root = await project(t);
	const child = runChild(`
		const { registerHooks } = await import("node:module");
		const { createPiFixtureResolveHook } = await import(${JSON.stringify(hookUrl)});
		registerHooks({ resolve: createPiFixtureResolveHook(${JSON.stringify(root)}) });
		const mod = await import(${JSON.stringify(pathToFileURL(join(root, "tests/outside.mjs")).href)});
		console.log(mod.source);
	`);
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "root-decoy");
});

test("the hook only redirects Pi-hosted specifiers requested by extension sources", async (t) => {
	const root = await project(t);
	const hook = createPiFixtureResolveHook(root);
	const seen = [];
	const next = (specifier, context) => { seen.push({ specifier, parentURL: context.parentURL }); return { url: "file:///next" }; };
	const extensionParent = "file:///repo/resources/extensions/sample/a.ts";
	const fixtureParent = pathToFileURL(join(getPiFixturePackageDir(root), "package.json")).href;
	for (const specifier of ["typebox", "yaml", "@earendil-works/pi-ai", "@earendil-works/pi-ai/sub", "typebox/value"]) {
		hook(specifier, { parentURL: extensionParent }, next);
	}
	assert.ok(seen.every((call) => call.parentURL === fixtureParent), "Pi-hosted specifiers resolve from the fixture");
	seen.length = 0;
	hook("typeboxx", { parentURL: extensionParent }, next); // prefix lookalike
	hook("node:fs", { parentURL: extensionParent }, next);
	hook("./local.ts", { parentURL: extensionParent }, next);
	hook("typebox", { parentURL: "file:///repo/tests/a.mjs" }, next);
	assert.ok(seen.every((call) => call.parentURL !== fixtureParent), "everything else keeps its own parent");
});

test("the fixture resolver and the subagent graph stub loader refuse to share a process", () => {
	// The resolver claims on import; the graph loader claims when installed.
	const orders = {
		"resolver then loader": `await import(${JSON.stringify(helperUrl)}); (await import(${JSON.stringify(loaderUrl)})).installSubagentGraphLoader();`,
		"loader then resolver": `(await import(${JSON.stringify(loaderUrl)})).installSubagentGraphLoader(); await import(${JSON.stringify(helperUrl)});`,
	};
	for (const [order, script] of Object.entries(orders)) {
		const result = runChild(script);
		assert.notEqual(result.status, 0, `${order}: mixing both hooks must fail instead of silently picking a winner`);
		assert.match(result.stderr, /mutually exclusive/, order);
	}
});
