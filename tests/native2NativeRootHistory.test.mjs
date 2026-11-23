import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { backendTestAvailability, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { writeSessionFile } from "./helpers/native2RuntimeEvents.mjs";

const { skip } = backendTestAvailability();
const portable = (path) => path.replaceAll("\\", "/");

/** Establish native root provenance through a real project scan. */
async function fixture(t) {
  let project, alias, originalRoot, replacementRoot, currentRoot, settingsFile, originalFile;
  const f = await startBackendSession(t, {
    prepare(directory) {
      project = join(directory.root, "project");
      originalRoot = join(directory.root, "original-root");
      replacementRoot = join(directory.root, "replacement-root");
      currentRoot = join(directory.root, "current-root");
      alias = join(directory.root, "configured-root");
      mkdirSync(join(project, ".pi"), { recursive: true });
      for (const root of [originalRoot, replacementRoot, currentRoot]) mkdirSync(root);
      symlinkSync(originalRoot, alias, process.platform === "win32" ? "junction" : "dir");
      settingsFile = join(project, ".pi", "settings.json");
      writeFileSync(settingsFile, JSON.stringify({ sessionDir: alias }));
      originalFile = writeSessionFile(originalRoot, project, "history-session");
      writeFileSync(join(directory.userData, "projects.json"), JSON.stringify([
        { id: "native-history", name: "Native history", path: project, environment: "windows" },
      ]));
    },
  });
  const list = await f.invoke("sessions:catalog-list", ["native-history"]);
  assert.equal(list.payload.ok, true, JSON.stringify(list.payload));
  const record = list.payload.result.find((row) => portable(row.filePath) === portable(join(alias, "history-session.jsonl")));
  assert.ok(record, "The configured alias must be scanned before its history is used");
  writeFileSync(settingsFile, JSON.stringify({ sessionDir: currentRoot }));
  return { ...f, project, alias, originalRoot, replacementRoot, currentRoot, settingsFile, originalFile, record };
}

test("native root history rejects a retargeted configured directory link", { skip }, async (t) => {
  const f = await fixture(t);
  const replacementFile = writeSessionFile(f.replacementRoot, f.project, "history-session");
  const original = readFileSync(f.originalFile, "utf8");
  const replacement = readFileSync(replacementFile, "utf8");
  unlinkSync(f.alias);
  symlinkSync(f.replacementRoot, f.alias, process.platform === "win32" ? "junction" : "dir");
  const result = await f.invoke("sessions:catalog-delete", [f.record.id, { permanent: true }]);
  assert.equal(result.payload.ok, false, JSON.stringify(result.payload));
  assert.equal(readFileSync(f.originalFile, "utf8"), original);
  assert.equal(readFileSync(replacementFile, "utf8"), replacement);
  assert.equal(f.trashCalls.length, 0);
});

test("legacy Windows root receipts require a trusted rescan after a junction becomes a directory", {
  skip: skip || (process.platform !== "win32" ? "Legacy Qt junction provenance is Windows specific" : false),
}, async (t) => {
  const f = await fixture(t);
  // Qt's old canonicalFilePath receipt retained the junction's name. Persist
  // that exact old format before replacing the junction with a real directory.
  const historyPath = join(f.fixture.userData, "session-root-history.json");
  const history = JSON.parse(readFileSync(historyPath, "utf8"));
  let changed = false;
  for (const entries of Object.values(history)) {
    for (const entry of entries) {
      if (portable(entry.root) !== portable(f.alias)) continue;
      entry.canonical = portable(f.alias).replace(/^([a-z]):/, (_, drive) => `${drive.toUpperCase()}:`);
      delete entry.canonicalVersion;
      changed = true;
    }
  }
  assert.ok(changed, "The legacy receipt must derive from the real scan");
  writeFileSync(historyPath, JSON.stringify(history));
  unlinkSync(f.alias);
  mkdirSync(f.alias);
  const replacementFile = writeSessionFile(f.alias, f.project, "history-session");
  const original = readFileSync(f.originalFile, "utf8");
  const replacement = readFileSync(replacementFile, "utf8");
  const refused = await f.invoke("sessions:catalog-delete", [f.record.id, { permanent: true }]);
  assert.equal(refused.payload.ok, false, JSON.stringify(refused.payload));
  assert.equal(readFileSync(f.originalFile, "utf8"), original);
  assert.equal(readFileSync(replacementFile, "utf8"), replacement);
  // Restoring the root in user settings and scanning it creates fresh authority.
  writeFileSync(f.settingsFile, JSON.stringify({ sessionDir: f.alias }));
  assert.equal((await f.invoke("sessions:catalog-list", ["native-history"])).payload.ok, true);
  writeFileSync(f.settingsFile, JSON.stringify({ sessionDir: f.currentRoot }));
  const recovered = await f.invoke("sessions:catalog-delete", [f.record.id, { permanent: true }]);
  assert.equal(recovered.payload.result, true, JSON.stringify(recovered.payload));
  assert.equal(existsSync(replacementFile), false);
  assert.equal(readFileSync(f.originalFile, "utf8"), original);
});
