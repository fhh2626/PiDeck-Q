import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** Build isolated persisted project settings, with observable production warnings. */
async function projectFixture(t, extraStubs = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), "pideck-project-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectsFile = join(root, "projects.json");
  await fs.writeFile(projectsFile, JSON.stringify([{ id: "p", name: "Project", path: join(root, "project"), lastOpenedAt: 1 }]));
  const warnings = [];
  const logger = { warn(domain, message, details) { warnings.push({ domain, message, details }); } };
  const { ProjectStore } = loadTsCommonJs("src/main/projects/ProjectStore.ts", {
    stubs: { "../logging/sharedLogger": { getAppLogger: () => logger }, ...extraStubs },
  });
  const deps = { projectsFile, chatPathFile: join(root, "chat-path.json"), defaultChatProjectPath: join(root, "chat") };
  return { root, deps, warnings, store: new ProjectStore(deps) };
}

test("unavailable chat path stays configured and can recover without replacing project identities", async t => {
  const { root, deps, warnings, store } = await projectFixture(t);
  const custom = join(root, "custom");
  await fs.writeFile(custom, "not a directory");
  await fs.writeFile(deps.chatPathFile, JSON.stringify({ path: custom }));
  await store.loadForStartup();
  assert.equal(store.get("p").id, "p");
  assert.equal(store.getChatProjectPath(), custom);
  assert.ok(warnings.some(warning => warning.details.cause.includes("not a directory")));
  await fs.rm(custom); await fs.mkdir(custom);
  await store.load();
  assert.equal(store.get("p").id, "p");
  assert.equal(store.get("builtin-chat").path, custom);
  assert.equal(JSON.parse(await fs.readFile(deps.chatPathFile, "utf8")).path, custom);
});

test("project catalog read errors still reject loading rather than expose an empty catalog", async t => {
  const { deps, store } = await projectFixture(t);
  await fs.rm(deps.projectsFile); await fs.mkdir(deps.projectsFile);
  await assert.rejects(store.loadForStartup());
  assert.equal(store.list().length, 0);
});

test("failed startup repair write preserves loaded projects and retries on the next load", async t => {
  let writable = false;
  const { writeProjectSnapshot, preserveCorruptProjectCatalog } = loadTsCommonJs("src/main/projects/projectCatalogPersistence.ts");
  const { deps, store, warnings } = await projectFixture(t, {
    "./projectCatalogPersistence": {
      preserveCorruptProjectCatalog,
      writeProjectSnapshot: async (...args) => {
        if (!writable) throw new Error("injected startup write failure");
        return writeProjectSnapshot(...args);
      },
    },
  });
  await store.loadForStartup();
  assert.equal(store.get("p").id, "p");
  assert.ok(warnings.some(warning => warning.details.cause.includes("injected startup write failure")));
  assert.equal(JSON.parse(await fs.readFile(deps.projectsFile, "utf8")).length, 1);
  writable = true;
  await store.load();
  const saved = JSON.parse(await fs.readFile(deps.projectsFile, "utf8"));
  assert.ok(saved.some(project => project.id === "builtin-chat"));
  assert.ok(saved.some(project => project.id === "p"));
});

test("setting an unavailable chat destination still rejects and leaves the previous path unchanged", async t => {
  const { root, store } = await projectFixture(t);
  await store.load();
  const previous = store.getChatProjectPath();
  const invalid = join(root, "invalid"); await fs.writeFile(invalid, "not a directory");
  await assert.rejects(store.setChatProjectPath(invalid), /not a directory/);
  assert.equal(store.getChatProjectPath(), previous);
  assert.equal(store.get("builtin-chat").path, previous);
});
