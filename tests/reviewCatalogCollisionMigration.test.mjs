import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts");
const { buildSessionOriginKey } = loadTsCommonJs("src/shared/sessionIdentity.ts");

/** Complete persisted fixture; identities use the same production origin contract. */
function entry(id, filePath, overrides = {}) {
  const record = {
    id, projectId: "p", filePath, title: "Original title", source: "pi", environment: "native",
    status: "active", createdAt: 1, updatedAt: 1, ...overrides,
  };
  return { ...record, originKey: buildSessionOriginKey(record) };
}

/** Load real disk data with project-relative paths resolved to fixture-local absolute paths. */
async function fixture(t, makeEntries, resolver, stubs = {}) {
  const root = await mkdtemp(join(tmpdir(), "pideck-collision-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "catalog.json");
  const entries = makeEntries(root);
  await writeFile(file, JSON.stringify({ version: 1, sessions: entries }));
  const resolvePath = resolver ?? ((_projectId, path) => path.startsWith(".pi/") ? join(root, path) : path);
  const { SessionCatalog: Catalog } = Object.keys(stubs).length
    ? loadTsCommonJs("src/main/sessions/SessionCatalog.ts", { stubs })
    : { SessionCatalog };
  const openCatalog = () => new Catalog(file, {}, resolvePath);
  const catalog = openCatalog(); await catalog.load();
  return { root, file, entries, catalog, openCatalog };
}

test("relative/absolute collision keeps original UUID and explicit preferences while preserving missing metadata", async t => {
  const { file, catalog, openCatalog, entries } = await fixture(t, root => [
    // Scan timestamps need not identify the original desktop UUID: prefer the
    // original relative-path record even when the duplicate has an older date.
    entry("scan-copy", join(root, ".pi/session.jsonl"), {
      createdAt: 1, updatedAt: 20, title: "Scan title", model: { provider: "other", modelId: "other" },
      thinkingLevel: "high", piSessionId: "pi-id", scanMetadata: { preview: "latest", messageCount: 4 },
      isInternalSubagent: true, parentSessionPath: join(root, "parent.jsonl"),
    }),
    entry("original", ".pi/session.jsonl", {
      createdAt: 10, updatedAt: 10, model: { provider: "picked", modelId: "picked" },
      scanMetadata: { projectPath: root, preview: "stale" },
    }),
  ]);
  assert.equal(catalog.listEntries().length, 1);
  const record = catalog.get("original");
  assert.equal(record.title, "Original title");
  assert.equal(record.model.provider, "picked");
  assert.equal(record.thinkingLevel, "high");
  assert.equal(record.piSessionId, "pi-id");
  assert.equal(record.scanMetadata.preview, "latest");
  assert.ok(record.scanMetadata.projectPath.includes("pideck-collision-migration-"));
  assert.equal(record.isInternalSubagent, true);
  assert.ok(record.parentSessionPath.endsWith("parent.jsonl"));
  assert.equal(record.createdAt, 1);
  assert.equal(record.updatedAt, 20);
  assert.equal(JSON.parse(await readFile(file, "utf8")).sessions.length, 1);
  assert.deepEqual(JSON.parse(await readFile(`${file}.bak`, "utf8")).sessions, entries);
  const reloaded = openCatalog(); await reloaded.load();
  assert.equal(reloaded.listEntries().length, 1);
  assert.equal(reloaded.get("original").thinkingLevel, "high");
});

test("already absolute duplicates keep earliest UUID independent of array order", async t => {
  const { catalog } = await fixture(t, root => [
    entry("newer", join(root, "session.jsonl"), { createdAt: 20, updatedAt: 30, model: { provider: "new", modelId: "new" } }),
    entry("original", join(root, "session.jsonl"), { createdAt: 10, thinkingLevel: "low" }),
  ]);
  assert.equal(catalog.listEntries().length, 1);
  assert.equal(catalog.listEntries()[0].id, "original");
  assert.equal(catalog.get("original").model.provider, "new");
  assert.equal(catalog.get("original").thinkingLevel, "low");
});

test("equal creation times preserve first UUID and latest explicit false worker marker", async t => {
  const { catalog } = await fixture(t, root => [
    entry("first", join(root, "session.jsonl"), { updatedAt: 10, isInternalSubagent: true }),
    entry("second", join(root, "session.jsonl"), { updatedAt: 20, isInternalSubagent: false }),
  ]);
  assert.equal(catalog.listEntries().length, 1);
  assert.equal(catalog.listEntries()[0].id, "first");
  assert.equal(catalog.get("first").isInternalSubagent, false);
});

test("collision migration does not merge distinct sources, environments or imported identities", async t => {
  const { catalog } = await fixture(t, root => [
    entry("pi", join(root, "session.jsonl")),
    entry("codex-a", join(root, "session.jsonl"), { source: "codex", importedSourceId: "a" }),
    entry("codex-b", join(root, "session.jsonl"), { source: "codex", importedSourceId: "b" }),
    entry("wsl-a", "/home/u/session.jsonl", { environment: "wsl", wslDistro: "A", wslUser: "u" }),
    entry("wsl-b", "/home/u/session.jsonl", { environment: "wsl", wslDistro: "B", wslUser: "u" }),
    entry("wsl-other-user", "/home/u/session.jsonl", { environment: "wsl", wslDistro: "A", wslUser: "other" }),
    entry("native-posix", "/home/u/session.jsonl"),
  ]);
  assert.equal(catalog.listEntries().length, 7);
});

test("unresolved relative paths for different missing projects are not treated as a shared file", async t => {
  const { catalog } = await fixture(t, () => [
    entry("a", ".pi/session.jsonl", { projectId: "missing-a" }),
    entry("b", ".pi/session.jsonl", { projectId: "missing-b" }),
  ], (_projectId, path) => path);
  assert.equal(catalog.listEntries().length, 2);
});

test("children resolve to the retained parent UUID after collision migration and rescan", async t => {
  const { catalog, root } = await fixture(t, root => [
    entry("parent-original", ".pi/parent.jsonl"),
    entry("parent-copy", join(root, ".pi/parent.jsonl"), { createdAt: 2 }),
    entry("child", join(root, ".pi/child.jsonl"), { parentSessionPath: join(root, ".pi/parent.jsonl") }),
  ]);
  assert.equal(catalog.getRecord("child").parentSessionId, "parent-original");
  const records = await catalog.mergeScanned("p", [{
    filePath: join(root, ".pi/parent.jsonl"), projectPath: root, name: "Parent", preview: "", messageCount: 1, updatedAt: 30, source: "pi",
  }]);
  assert.equal(records.length, 2);
  assert.equal(records.find(record => record.id === "child").parentSessionId, "parent-original");
});

test("failed migration write preserves old disk data and retries with the same UUID", async t => {
  let writable = false;
  const warnings = [];
  const { file, entries, catalog, openCatalog } = await fixture(t, root => [
    entry("original", ".pi/session.jsonl"),
    entry("copy", join(root, ".pi/session.jsonl"), { createdAt: 2 }),
  ], undefined, {
    "node:fs/promises": {
      ...fs,
      open: async (...args) => {
        if (!writable && args[1] === "w") throw new Error("injected migration write failure");
        return fs.open(...args);
      },
    },
    "../logging/sharedLogger": { getAppLogger: () => ({ warn(domain, message, details) { warnings.push({ domain, message, details }); } }) },
  });
  assert.equal(catalog.listEntries().length, 1);
  assert.equal(catalog.listEntries()[0].id, "original");
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).sessions, entries);
  assert.ok(warnings.some(warning => warning.details.cause.includes("injected migration write failure")));
  writable = true;
  const reloaded = openCatalog(); await reloaded.load();
  assert.equal(reloaded.listEntries().length, 1);
  assert.equal(reloaded.listEntries()[0].id, "original");
  assert.equal(JSON.parse(await readFile(file, "utf8")).sessions[0].id, "original");
});
