import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import ts from "typescript";
import { getPiFixtureDir, getPiFixturePackageDir, piFixtureFileUrl, PI_PACKAGE } from "../scripts/pi-compatibility-fixture.mjs";

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "pideck-pi-consumer-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

async function moduleFile(path, text) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, text);
}

test("real builder file resolution uses the fixture instead of a root SDK decoy", async (t) => {
	const root = await fixture(t);
	const relative = "dist/core/system-prompt.js";
	await moduleFile(join(root, "node_modules", ...PI_PACKAGE.split("/"), relative), "export const source = 'root-decoy';");
	const dir = getPiFixturePackageDir(root);
	await moduleFile(join(dir, "package.json"), '{"type":"module"}');
	await moduleFile(join(dir, relative), "export const source = 'latest-fixture';");
	const loaded = await import(piFixtureFileUrl(relative, root));
	assert.equal(loaded.source, "latest-fixture");
});

test("a missing isolated fixture never falls back to an installed root SDK", async (t) => {
	const root = await fixture(t);
	await moduleFile(join(root, "node_modules", ...PI_PACKAGE.split("/"), "dist/index.js"), "export {};");
	assert.throws(() => piFixtureFileUrl("dist/index.js", root), /run npm run prepare:pi-latest/);
});

test("fixture location is independent of the caller working directory", async (t) => {
	const root = await fixture(t);
	const helper = new URL("../scripts/pi-compatibility-fixture.mjs", import.meta.url).href;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", `const { getPiFixtureDir } = await import(${JSON.stringify(helper)}); console.log(getPiFixtureDir());`], {
		cwd: root, encoding: "utf8", timeout: 10000,
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), getPiFixtureDir());
});

test("extension typecheck resolves Pi types from the isolated fixture over root types", async (t) => {
	const root = await fixture(t);
	const rootPackage = join(root, "node_modules", ...PI_PACKAGE.split("/"));
	const fixturePackage = getPiFixturePackageDir(root);
	for (const dir of [rootPackage, fixturePackage]) {
		await moduleFile(join(dir, "package.json"), JSON.stringify({ name: PI_PACKAGE, types: "index.d.ts" }));
		await moduleFile(join(dir, "index.d.ts"), "export interface ExtensionAPI {}\n");
	}
	const configFile = fileURLToPath(new URL("../tsconfig.change-pi-prompt.json", import.meta.url));
	const config = ts.readConfigFile(configFile, ts.sys.readFile);
	assert.equal(config.error, undefined);
	// Parsing with the project root as the config directory applies real `paths` semantics:
	// relative targets resolve against the tsconfig location, with no baseUrl involved.
	const { options, errors } = ts.parseJsonConfigFileContent({ compilerOptions: config.config.compilerOptions }, ts.sys, root);
	// The synthetic config has no input files; that is the only diagnostic we expect (TS18002/TS18003).
	assert.deepEqual(errors.filter((error) => error.code !== 18002 && error.code !== 18003), []);
	assert.equal(options.baseUrl, undefined, "baseUrl would make bare module names resolve against the repository root");
	const result = ts.resolveModuleName(PI_PACKAGE, join(root, "resources/extension.ts"), options, ts.sys);
	assert.equal(result.resolvedModule?.resolvedFileName.replaceAll("\\", "/"), join(fixturePackage, "index.d.ts").replaceAll("\\", "/"));
});
