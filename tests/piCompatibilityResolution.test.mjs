import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { loadPiCompatibilityModules } from "./helpers/piCompatibilityModules.mjs";

/** Disposable npm layout: resolution is exercised without installing packages or querying npm. */
async function writeModule(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function writeDependencies(modules, marker) {
  await writeModule(join(modules, "typebox/package.json"), JSON.stringify({
    name: "typebox", type: "module", exports: { "./value": "./value.mjs" },
  }));
  await writeModule(join(modules, "typebox/value.mjs"), `export const Value = { source: ${JSON.stringify(marker)} };`);
  const ai = join(modules, "@earendil-works/pi-ai");
  await writeModule(join(ai, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-ai", type: "module", exports: { ".": { import: "./dist/index.js" } },
  }));
  await writeModule(join(ai, "dist/index.js"), "export {};\n");
  await writeModule(join(ai, "dist/api/constrained-sampling.js"), `export function makeStrictJsonSchema() { return ${JSON.stringify(marker)}; }`);
}

for (const nested of [false, true]) {
  test(`Pi compatibility modules use ${nested ? "nested dependencies over hoisted decoys" : "hoisted dependencies"}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "pideck-pi-resolution-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const modules = join(directory, "node_modules");
    const pi = join(modules, "@earendil-works/pi-coding-agent");
    await writeModule(join(pi, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-coding-agent", type: "module", exports: { ".": { import: "./dist/index.js" } },
    }));
    await writeModule(join(pi, "dist/index.js"), "export {};\n");
    await writeModule(join(pi, "dist/core/extensions/loader.js"), "export function loadExtensions() { return 'fixture-loader'; }\n");
    await writeDependencies(modules, "hoisted");
    if (nested) await writeDependencies(join(pi, "node_modules"), "nested");
    const loaded = await loadPiCompatibilityModules(pathToFileURL(join(pi, "dist/index.js")).href);
    assert.equal(loaded.Value.source, nested ? "nested" : "hoisted");
    assert.equal(loaded.makeStrictJsonSchema(), nested ? "nested" : "hoisted");
    assert.equal(loaded.loadExtensions(), "fixture-loader");
  });
}
