import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { stageExtensionDependencies } from "../scripts/stage-extension-dependencies.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pideck-extensions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    "undici/package.json": '{"main":"index.js"}',
    "undici/index.js": "module.exports = {};",
    "undici/lib/dispatcher/client.js": "module.exports = {};",
    "undici/lib/client.test.js": "throw new Error('must not ship');",
    "undici/lib/client.js.map": "debug metadata",
    "acorn/package.json": '{"main":"dist/acorn.js"}',
    "acorn/dist/acorn.js": "module.exports = {};",
    "acorn/dist/acorn.d.ts": "export {};",
  };
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, "node_modules", name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return { root, stage: join(root, "stage") };
}

test("extension staging ships only runnable external libraries without business Node", async (t) => {
  const { root, stage } = await fixture(t);
  const deps = join(stage, "resources", "extensions", "node_modules");
  await mkdir(join(deps, "undici"), { recursive: true });
  await writeFile(join(deps, "undici", "stale.js"), "old");
  const result = await stageExtensionDependencies({ projectRoot: root, stageRoot: stage });
  assert.deepEqual(result.counts, { extensionUndici: 3, extensionAcorn: 2 });
  assert.deepEqual((await readdir(deps)).sort(), ["acorn", "undici"]);
  assert.equal(await readFile(join(deps, "acorn", "dist", "acorn.js"), "utf8"), "module.exports = {};");
  for (const path of ["undici/stale.js", "undici/lib/client.test.js", "undici/lib/client.js.map", "acorn/dist/acorn.d.ts"]) {
    await assert.rejects(access(join(deps, path)), { code: "ENOENT" });
  }
  for (const path of ["app/node_modules", "app/native-node", "node"]) {
    await assert.rejects(access(join(stage, path)), { code: "ENOENT" });
  }
});

test("extension staging fails when a required runtime entry is absent", async (t) => {
  const { root, stage } = await fixture(t);
  await rm(join(root, "node_modules", "undici", "index.js"));
  await assert.rejects(stageExtensionDependencies({ projectRoot: root, stageRoot: stage }), /Missing undici runtime file/);
});
